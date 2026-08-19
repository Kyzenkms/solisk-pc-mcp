/**
 * oauth.js — Full MCP OAuth 2.1 Authorization Server
 *
 * Implements the full spec required by Claude.ai, ChatGPT, and any
 * MCP-compliant client:
 *   - RFC 8414: Authorization Server Metadata discovery
 *   - RFC 9728: Protected Resource Metadata
 *   - RFC 7591: Dynamic Client Registration
 *   - OAuth 2.1 Authorization Code + PKCE (S256 mandatory)
 *   - Token endpoint (access_token + refresh_token)
 *   - Token revocation (RFC 7009)
 *   - Consent/authorization HTML page
 */

const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");

const clients       = new Map(); // client_id → { client_secret, redirect_uris, ... }
const authCodes     = new Map(); // code → { client_id, redirect_uri, scope, pkce_challenge, pkce_method, expires_at }
const accessTokens  = new Map(); // token → { client_id, scope, expires_at, subject }
const refreshTokens = new Map(); // token → { client_id, scope, access_token }

// Persistent storage for OAuth tokens
const TOKENS_FILE = path.join(path.dirname(process.env.MCP_CONFIG_PATH || path.join(__dirname, "..", "config.json")), "oauth_tokens.json");

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
      for (const [k, v] of Object.entries(data.accessTokens || {})) accessTokens.set(k, v);
      for (const [k, v] of Object.entries(data.refreshTokens || {})) refreshTokens.set(k, v);
    }
  } catch (e) {
    console.error("[oauth] Failed to load persistent tokens:", e.message);
  }
}

function saveTokens() {
  try {
    const data = {
      accessTokens: Object.fromEntries(accessTokens),
      refreshTokens: Object.fromEntries(refreshTokens),
    };
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("[oauth] Failed to save tokens:", e.message);
  }
}

loadTokens();

// ── Helpers ─────────────────────────────────────────────────────────────────
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function pkceVerify(verifier, challenge, method) {
  if (method === "S256") {
    const hash = crypto.createHash("sha256").update(verifier).digest("base64url");
    return hash === challenge;
  }
  // plain (not recommended but allowed)
  return verifier === challenge;
}

function baseUrl(req) {
  // Prefer X-Forwarded-* headers when we're behind a reverse proxy / relay.
  const host  = req.headers["x-forwarded-host"]  || req.headers["host"] || `localhost:${req.socket.localPort || 3000}`;
  let prefix  = req.headers["x-forwarded-prefix"] || req.headers["x-mcp-prefix"] || "";

  // OAuth clients reject discovery documents that advertise plaintext endpoints,
  // so only report http for genuinely local addresses. A reverse proxy that
  // omits X-Forwarded-Proto must not silently downgrade the advertised URLs.
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto = forwardedProto || (req.secure ? "https" : (isLocal ? "http" : "https"));

  if (!prefix && req.originalUrl) {
    const match = req.originalUrl.match(/^(\/mcp\/[^/]+)/);
    if (match) prefix = match[1];
  }

  let base = `${proto}://${host}`;
  if (prefix) {
    base += prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  }
  return base;
}

function cleanExpired() {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of authCodes) if (v.expires_at < now) authCodes.delete(k);
  for (const [k, v] of accessTokens) {
    if (v.expires_at < now) {
      accessTokens.delete(k);
      changed = true;
    }
  }
  if (changed) saveTokens();
}
setInterval(cleanExpired, 60 * 1000);

// ── Public API for security middleware ──────────────────────────────────────

/**
 * Validate a Bearer token. Returns the token record or null.
 * Used by apiKeyMiddleware to accept OAuth tokens alongside API keys.
 */
function validateOAuthToken(token) {
  const rec = accessTokens.get(token);
  if (!rec) return null;
  if (rec.expires_at < Date.now()) {
    accessTokens.delete(token);
    saveTokens();
    return null;
  }
  return rec;
}

// ── Router factory ───────────────────────────────────────────────────────────

/**
 * Attach all OAuth 2.1 routes to an Express app.
 * @param {import("express").Application} app
 * @param {object} config  — the loaded config (api_key, oauth_client_id, etc.)
 */
function attachOAuthRoutes(app, config) {

  // Handler helpers for multi-path routing
  const protectedResourceHandler = (req, res) => {
    const base = baseUrl(req);
    res.json({
      resource:                 base,
      authorization_servers:   [base],
      scopes_supported:         ["mcp:tools", "mcp:resources"],
      bearer_methods_supported: ["header"],
    });
  };

  const authServerMetadataHandler = (req, res) => {
    const base = baseUrl(req);
    res.json({
      issuer:                            base,
      authorization_endpoint:            `${base}/oauth/authorize`,
      token_endpoint:                    `${base}/oauth/token`,
      revocation_endpoint:               `${base}/oauth/revoke`,
      registration_endpoint:             `${base}/oauth/register`,
      jwks_uri:                          `${base}/.well-known/jwks.json`,
      scopes_supported:                  ["mcp:tools", "mcp:resources"],
      response_types_supported:          ["code"],
      grant_types_supported:             ["authorization_code", "refresh_token"],
      code_challenge_methods_supported:  ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
      require_pkce:                      true,
    });
  };

  const registerHandler = (req, res) => {
    const body = req.body || {};
    const clientId     = "dyn_" + randomToken(12);
    const clientSecret = randomToken(32);

    const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];

    clients.set(clientId, {
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uris,
      client_name:   body.client_name || "MCP Client",
      grant_types:   body.grant_types || ["authorization_code"],
      response_types: body.response_types || ["code"],
    });

    console.error("[oauth/register] Created dynamic client:", clientId);

    res.status(201).json({
      client_id:                  clientId,
      client_secret:              clientSecret,
      redirect_uris,
      grant_types:                ["authorization_code", "refresh_token"],
      response_types:             ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
  };

  // ── 1. Protected Resource Metadata (RFC 9728) ───────────────────────────
  app.get(/(?:\/mcp\/[^/]+)?\/\.well-known\/oauth-protected-resource(?:\/.*)?$/, protectedResourceHandler);

  // ── 2. Authorization Server Metadata (RFC 8414 & OpenID) ─────────────────
  app.get(/(?:\/mcp\/[^/]+)?\/\.well-known\/oauth-authorization-server(?:\/.*)?$/, authServerMetadataHandler);
  app.get(/(?:\/mcp\/[^/]+)?\/\.well-known\/openid-configuration(?:\/.*)?$/, authServerMetadataHandler);

  // Stub JWKS
  app.get(/(?:\/mcp\/[^/]+)?\/\.well-known\/jwks\.json(?:\/.*)?$/, (_req, res) => res.json({ keys: [] }));

  // ── 3. Dynamic Client Registration (RFC 7591) ───────────────────────────
  app.post(/(?:\/mcp\/[^/]+)?\/oauth\/register$/, registerHandler);

  // ── 4. Authorization endpoint — shows consent page ──────────────────────
  const authorizeGetHandler = (req, res) => {
    const q = req.query || {};
    const b = req.body  || {};

    const response_type        = q.response_type || b.response_type || "code";
    const client_id            = q.client_id     || b.client_id     || config.oauth_client_id;
    let   redirect_uri         = q.redirect_uri  || b.redirect_uri;
    const state                = q.state         || b.state || "";
    const scope                = q.scope         || b.scope || "mcp:tools mcp:resources";
    const code_challenge       = q.code_challenge || b.code_challenge || "";
    const code_challenge_method = q.code_challenge_method || b.code_challenge_method || "S256";

    // Basic validation
    if (response_type !== "code") {
      return res.status(400).send("Only response_type=code is supported.");
    }

    // SECURITY FIX: PKCE is mandatory. Reject requests that don't present a
    // S256 code_challenge so authorization codes can't be exchanged without proof.
    if (!code_challenge) {
      return res.status(400).send("PKCE (code_challenge, method=S256) is required.");
    }
    if (code_challenge_method !== "S256") {
      return res.status(400).send("Only code_challenge_method=S256 is supported.");
    }

    // Look up client — accept pre-configured or dynamically registered
    let clientRecord = clients.get(client_id);
    if (!clientRecord) {
      if (client_id === config.oauth_client_id) {
        clientRecord = {
          client_id,
          client_name: "Configured Client",
          redirect_uris: ["https://claude.ai/api/auth/callback/connector"],
        };
      } else {
        clientRecord = {
          client_id: client_id || "mcp_client",
          client_name: "MCP Client",
          redirect_uris: ["https://claude.ai/api/auth/callback/connector"],
        };
      }
    }

    if (!redirect_uri) {
      if (clientRecord && clientRecord.redirect_uris && clientRecord.redirect_uris.length > 0) {
        redirect_uri = clientRecord.redirect_uris[0];
      } else {
        redirect_uri = "https://claude.ai/api/auth/callback/connector";
      }
    }

    // SECURITY FIX: Do NOT auto-issue an authorization code on GET. The consent
    // page must be followed by a POST that verifies the caller's API key.
    // We only render the consent page here; the code is created on POST /allow.
    // Set explicit Content-Type so the proxy forwards it as an HTML string
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(consentPage({
      clientName: clientRecord ? clientRecord.client_name : "Unknown Client",
      scopes: scope.split(" "),
      formFields: {
        client_id,
        redirect_uri,
        state,
        scope,
        code_challenge,
        code_challenge_method
      }
    }));
  };
  app.get(/(?:\/mcp\/[^/]+)?\/oauth\/authorize$/, authorizeGetHandler);

  // POST from the consent page — user approved or denied
  const authorizePostHandler = (req, res) => {
    const {
      action, client_id, redirect_uri, state, scope,
      code_challenge, code_challenge_method,
    } = req.body;

    if (action === "deny") {
      const targetUrl = new URL(redirect_uri);
      targetUrl.searchParams.set("error", "access_denied");
      if (state) targetUrl.searchParams.set("state", state);
      
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${targetUrl.toString()}"></head><body>Redirecting...</body></html>`);
    }

    if (action !== "allow") {
      return res.status(400).send("Invalid action.");
    }

    // SECURITY FIX: enforce PKCE (S256) on the POST consent submission too
    if (!code_challenge || code_challenge_method !== "S256") {
      return res.status(400).send("PKCE (code_challenge, method=S256) is required.");
    }

    // Verify API Key
    const submittedKey = req.body.api_key;
    if (submittedKey !== config.api_key) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(401).send(`<!DOCTYPE html><html><head><style>body{font-family:sans-serif;background:#0b0b0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;} .card{background:#1a1a24;padding:30px;border-radius:12px;text-align:center;border:1px solid #ff4444;} a{color:#8b5cf6;text-decoration:none;}</style></head><body><div class="card"><h2>Access Denied</h2><p>Invalid API Key provided.</p><br/><a href="javascript:history.back()">Go Back and Try Again</a></div></body></html>`);
    }

    // Generate a short-lived authorization code
    const code = randomToken(24);
    authCodes.set(code, {
      client_id,
      redirect_uri,
      scope:              scope || "mcp:tools mcp:resources",
      pkce_challenge:     code_challenge,
      pkce_method:        code_challenge_method || "S256",
      expires_at:         Date.now() + 5 * 60 * 1000, // 5 minutes
    });

    try {
      const target = new URL(redirect_uri);
      target.searchParams.set("code", code);
      if (state) target.searchParams.set("state", state);
      res.redirect(target.toString());
    } catch {
      res.status(400).send("Invalid redirect_uri.");
    }
  };
  app.post(/(?:\/mcp\/[^/]+)?\/oauth\/authorize$/, authorizePostHandler);

  // ── 5. Token endpoint ────────────────────────────────────────────────────
  const tokenHandler = (req, res) => {
    const body = req.body || {};
    console.error("[oauth/token] Received request body:", JSON.stringify(body), "headers:", JSON.stringify(req.headers));

    // Support both Basic Auth and body params for client auth
    let clientId     = body.client_id;
    let clientSecret = body.client_secret;

    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
      const [cid, csec] = decoded.split(":", 2);
      clientId     = clientId     || cid;
      clientSecret = clientSecret || csec;
    }

    // ── Grant: authorization_code ─────────────────────────────────────────
    if (body.grant_type === "authorization_code") {
      const { code, redirect_uri, code_verifier } = body;
      const record = authCodes.get(code);
      if (!record) {
        console.error("[oauth/token] Error: code not found or expired", code);
        return res.status(400).json({ error: "invalid_grant", error_description: "Authorization code not found or expired." });
      }
      if (record.expires_at < Date.now()) {
        authCodes.delete(code);
        console.error("[oauth/token] Error: code expired", code);
        return res.status(400).json({ error: "invalid_grant", error_description: "Authorization code expired." });
      }
      if (record.redirect_uri !== redirect_uri) {
        console.error("[oauth/token] Error: redirect_uri mismatch. Expected:", record.redirect_uri, "Got:", redirect_uri);
        return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch." });
      }

      // Validate client
      if (record.client_id !== clientId) {
        return res.status(400).json({ error: "invalid_client" });
      }

      // Validate PKCE
      if (record.pkce_challenge) {
        if (!code_verifier) {
          return res.status(400).json({ error: "invalid_request", error_description: "code_verifier required." });
        }
        if (!pkceVerify(code_verifier, record.pkce_challenge, record.pkce_method)) {
          return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed." });
        }
      }

      authCodes.delete(code); // single-use

      const access_token  = randomToken(32);
      const refresh_token = randomToken(32);
      const expires_in    = 3600; // 1 hour

      accessTokens.set(access_token, {
        client_id:  record.client_id,
        scope:      record.scope,
        expires_at: Date.now() + expires_in * 1000,
        subject:    "user",
      });
      refreshTokens.set(refresh_token, {
        client_id:    record.client_id,
        scope:        record.scope,
        access_token, // track for rotation
      });
      saveTokens();

      const responsePayload = {
        access_token,
        token_type:    "bearer",
        expires_in,
        refresh_token,
        scope:         record.scope,
      };
      console.error("[oauth/token] Success response:", JSON.stringify(responsePayload));
      return res.json(responsePayload);
    }

    // SECURITY FIX: client_credentials grant removed. It allowed anyone to mint
    // a long-lived (1-year) access token via open dynamic registration with no
    // user authorization. Do not re-enable. Use authorization_code + PKCE only.

    // ── Grant: refresh_token ───────────────────────────────────────────────
    if (body.grant_type === "refresh_token") {
      const { refresh_token } = body;
      const record = refreshTokens.get(refresh_token);
      if (!record) {
        return res.status(400).json({ error: "invalid_grant", error_description: "Invalid refresh token." });
      }

      // Revoke old access token, issue new ones (rotation)
      accessTokens.delete(record.access_token);
      refreshTokens.delete(refresh_token);

      const new_access  = randomToken(32);
      const new_refresh = randomToken(32);
      const expires_in  = 3600;

      accessTokens.set(new_access, {
        client_id:  record.client_id,
        scope:      record.scope,
        expires_at: Date.now() + expires_in * 1000,
        subject:    "user",
      });
      refreshTokens.set(new_refresh, {
        client_id:    record.client_id,
        scope:        record.scope,
        access_token: new_access,
      });
      saveTokens();

      return res.json({
        access_token:  new_access,
        token_type:    "bearer",
        expires_in,
        refresh_token: new_refresh,
        scope:         record.scope,
      });
    }

    return res.status(400).json({ error: "unsupported_grant_type" });
  };
  app.post(/(?:\/mcp\/[^/]+)?\/oauth\/token$/, tokenHandler);

  // ── 6. Token Revocation (RFC 7009) ───────────────────────────────────────
  const revokeHandler = (req, res) => {
    const token = req.body?.token || "";
    accessTokens.delete(token);
    refreshTokens.delete(token);
    saveTokens();
    res.status(200).send(""); // always 200 per RFC 7009
  };
  app.post(/(?:\/mcp\/[^/]+)?\/oauth\/revoke$/, revokeHandler);
}

function consentPage({ clientName, scopes, formFields }) {
  const scopeRows = scopes.map(s => {
    const labels = {
      "mcp:tools":     "Execute terminal commands, control mouse/keyboard, and read/write files.",
      "mcp:resources": "Inspect active system processes, retrieve environment variables, and read resources.",
    };
    const titles = {
      "mcp:tools":     "System Control & Files",
      "mcp:resources": "Read System Metadata",
    };
    const icons = {
      "mcp:tools": `<svg class="scope-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M22 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2M4 6h16v12H4M18 9l-4 3 4 3m-8-2h5v2h-5z"/></svg>`,
      "mcp:resources": `<svg class="scope-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M13 9V3.5L18.5 9M6 2c-1.11 0-2 .89-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6z"/></svg>`,
    };
    return `
      <div class="scope-item">
        <div class="scope-icon-wrap">${icons[s] || ""}</div>
        <div class="scope-text">
          <div class="scope-title">${titles[s] || s}</div>
          <div class="scope-desc">${labels[s] || ""}</div>
        </div>
      </div>`;
  }).join("");

  const hiddenInputs = Object.entries(formFields || {}).map(([k, v]) =>
    `<input type="hidden" name="${escHtml(k)}" value="${escHtml(v)}">`
  ).join("\n    ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Connection</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Outfit', sans-serif;
    background: #0B0B0F;
    background-image: 
      radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.1) 0px, transparent 50%),
      radial-gradient(at 100% 100%, rgba(168, 85, 247, 0.08) 0px, transparent 50%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #F3F4F6;
    padding: 24px;
  }
  .card {
    background: rgba(18, 18, 26, 0.6);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 24px;
    padding: 38px;
    max-width: 460px;
    width: 100%;
    box-shadow: 0 30px 100px rgba(0, 0, 0, 0.6);
    animation: fadeIn 0.4s ease-out;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 24px;
  }
  .logo-icon {
    width: 48px; height: 48px;
    background: linear-gradient(135deg, #6366F1, #8B5CF6);
    border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.35);
  }
  .logo-icon svg { width: 22px; height: 22px; color: #fff; }
  .logo-name { font-size: 19px; font-weight: 700; color: #fff; letter-spacing: -0.02em; }
  .logo-sub  { font-size: 12px; color: #9CA3AF; font-weight: 400; margin-top: 1px; }
  h1 { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 6px; letter-spacing: -0.02em; }
  .client-pill {
    display: inline-flex;
    align-items: center;
    background: rgba(99, 102, 241, 0.12);
    border: 1px solid rgba(99, 102, 241, 0.25);
    color: #C7D2FE;
    padding: 4px 12px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 24px;
  }
  p.desc { font-size: 14px; color: #9CA3AF; margin-bottom: 24px; line-height: 1.6; }
  .scope-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-bottom: 28px;
  }
  .scope-item {
    display: flex;
    gap: 16px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 16px;
    padding: 16px;
    transition: background 0.2s;
  }
  .scope-item:hover {
    background: rgba(255, 255, 255, 0.04);
  }
  .scope-icon-wrap {
    width: 38px; height: 38px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    color: #A78BFA;
  }
  .scope-icon { width: 20px; height: 20px; }
  .scope-text { display: flex; flex-direction: column; gap: 4px; }
  .scope-title { font-size: 14px; font-weight: 600; color: #fff; }
  .scope-desc { font-size: 12px; color: #9CA3AF; line-height: 1.5; }
  
  .warning-box {
    background: rgba(245, 158, 11, 0.05);
    border: 1px solid rgba(245, 158, 11, 0.15);
    border-radius: 14px;
    padding: 14px 18px;
    font-size: 12px;
    color: #FCD34D;
    margin-bottom: 28px;
    line-height: 1.5;
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .warning-icon { width: 18px; height: 18px; color: #FBBF24; flex-shrink: 0; margin-top: 1px; }

  .btns { display: flex; gap: 14px; }
  button {
    flex: 1;
    padding: 14px;
    border: none;
    border-radius: 14px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: 'Outfit', sans-serif;
  }
  button:active { transform: scale(0.98); }
  .btn-allow {
    background: linear-gradient(135deg, #6366F1, #8B5CF6);
    color: #fff;
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.2);
  }
  .btn-allow:hover {
    opacity: 0.95;
    box-shadow: 0 4px 24px rgba(99, 102, 241, 0.3);
  }
  .btn-deny {
    background: rgba(255, 255, 255, 0.06);
    color: #D1D5DB;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .btn-deny:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
  }
  .footer { 
    margin-top: 24px; 
    text-align: center; 
    font-size: 11px; 
    color: #4B5563; 
    letter-spacing: 0.02em;
  }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
    </div>
    <div>
      <div class="logo-name">PC Control MCP</div>
      <div class="logo-sub">Access Authorization</div>
    </div>
  </div>

  <h1>Authorize Connection</h1>
  <div class="client-pill">${escHtml(clientName)}</div>
  <p class="desc">A secure remote model is requesting permission to control your local computer using the following scopes:</p>

  <div class="scope-container">
    ${scopeRows}
  </div>

  <div class="warning-box">
    <svg class="warning-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
    <div>Only grant access if you triggered this request. This action allows the client to perform operations on your local machine.</div>
  </div>

  <form method="POST" action="/oauth/authorize">
    ${hiddenInputs}
    <div style="margin-bottom: 24px; text-align: left;">
      <label style="display:block; font-size:13px; color:#9CA3AF; margin-bottom:8px; font-weight:500;">Enter your PC Control API Key:</label>
      <input type="password" name="api_key" required placeholder="Paste your API key here..." style="width:100%; box-sizing:border-box; padding:12px 16px; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.15); border-radius:10px; color:#fff; font-family:inherit; font-size:14px; outline:none; transition:border 0.2s;" onfocus="this.style.border='1px solid #8B5CF6'" onblur="this.style.border='1px solid rgba(255,255,255,0.15)'">
    </div>
    <div class="btns">
      <button type="submit" name="action" value="deny"  class="btn-deny">Deny</button>
      <button type="submit" name="action" value="allow" class="btn-allow">Allow</button>
    </div>
  </form>

  <div class="footer">Local authorization server · Safe local loopback</div>
</div>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = { attachOAuthRoutes, validateOAuthToken };
