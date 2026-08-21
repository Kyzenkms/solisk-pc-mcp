/**
 * relay-server/server.js — Production-grade Cloud Relay Server
 *
 * Sits on a VPS. Web-based AI clients (ChatGPT, Claude.ai) connect via
 * HTTP to this server, which forwards requests through a WebSocket
 * tunnel to the local PC running pc-control-mcp-pro.
 *
 * OAuth is handled LOCALLY on this relay server (not proxied to PC).
 * This ensures the authorization page always renders cleanly.
 */

"use strict";

const express = require("express");
const { WebSocketServer } = require("ws");
const http    = require("http");
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");
const { hashKey, verifyKey, normalizeScopes, newKeyBytes, FULL_SCOPES } = require("./keys");
const { toolScopeOf, hasScope } = require("./scopes");
const { createStateStore } = require("./state-store");

const app = express();

// Trust proxy (we're behind nginx/cloudflare in production)
app.set("trust proxy", 1);

// ── Body parsing ─────────────────────────────────────────────────────────────
// express.json parses application/json bodies (MCP JSON-RPC from Claude/ChatGPT)
// express.urlencoded parses form bodies (OAuth form submissions)
// NOTE: Do NOT add express.text here — it would clobber already-parsed bodies.
app.use(express.json({ limit: "50mb", strict: false }));
app.use(express.urlencoded({ extended: true }));

// Prevent malformed JSON payloads from throwing uncaught SyntaxError exceptions & crashing PM2
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400) && 'body' in err) {
    console.error("[relay] Invalid JSON body payload received:", err.message);
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: Invalid JSON payload." },
      id: null,
    });
  }
  next(err);
});

// ── CORS: strict whitelist (never wildcard) ───────────────────────────────────
const ALLOWED_ORIGINS = new Set([
  "https://claude.ai",
  "https://www.claude.ai",
  "https://chat.openai.com",
  "https://chatgpt.com",
  "https://platform.openai.com",
  "https://cursor.sh",
  "https://www.cursor.com",
]);

// Security headers applied to every response
app.use((req, res, next) => {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = !origin || ALLOWED_ORIGINS.has(origin) ||
    origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1");
  if (allowed) {
    if (origin) res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS, PUT, PATCH");
  res.header("Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, openai-ephemeral-user-id, openai-conversation-id, x-request-id");
  res.header("Access-Control-Expose-Headers", "mcp-session-id, x-request-id");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ── Rate limiting (transactional SQLite buckets) ─────────────────────────────
function rateLimit(opts = {}) {
  const windowMs = opts.windowMs || 60_000;
  const max = opts.max || 300;
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "anon";
    try {
      if (!stateStore.consumeRate(`global:${ip}`, Date.now(), windowMs, max)) {
        res.header("Retry-After", Math.ceil(windowMs / 1000));
        return res.status(429).json({ error: "rate_limited", error_description: "Too many requests." });
      }
      next();
    } catch (error) {
      console.error("[relay] Rate limiter unavailable:", error.message);
      return res.status(503).json({ error: "service_unavailable", error_description: "Rate limiter unavailable." });
    }
  };
}
setInterval(() => {
  try { stateStore.pruneRates(Date.now() - 120_000); } catch (error) { console.error("[relay] Rate bucket cleanup failed:", error.message); }
}, 60_000).unref();

// ── Periodic in-memory state cleanup ────────────────────────────────────────
// dynamicClients: Claude/ChatGPT register a new OAuth client per auth flow.
// Without cleanup this Map grows unbounded. Expire after 2 days.
setInterval(() => {
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  for (const [id, c] of dynamicClients) {
    if (c.createdAt && c.createdAt < cutoff) dynamicClients.delete(id);
  }
}, 60 * 60 * 1000).unref();

// sessionPrincipals: sessions expire on the PC after 30 min; mirror that here.
setInterval(() => {
  const cutoff = Date.now() - 35 * 60 * 1000;
  for (const [sid, p] of sessionPrincipals) {
    if (p.createdAt && p.createdAt < cutoff) sessionPrincipals.delete(sid);
  }
}, 5 * 60 * 1000).unref();

// tokens: access tokens have a 1-hour TTL. They are removed from SQLite on
// lookup, but accumulate in the in-memory `tokens` object until removed.
// Purge expired access/auth tokens every 5 minutes to prevent memory growth.
setInterval(() => {
  const now = Date.now();
  let pruned = 0;
  for (const [k, v] of Object.entries(tokens)) {
    if (v && v.expires && v.expires < now) { delete tokens[k]; pruned++; }
  }
  if (pruned > 0) console.log(`[relay] Pruned ${pruned} expired token(s)`);
}, 5 * 60 * 1000).unref();

app.use(rateLimit());

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ── State ─────────────────────────────────────────────────────────────────────
const clients       = new Map();  // code -> WebSocket (the local PC)
const pendingReqs   = new Map();  // requestId -> { res, timer, code, sessionId }
const sseStreams    = new Map();  // sessionId -> res (SSE to web client)
const sessionPrincipals = new Map(); // sessionId -> authenticated room principal
const sseEventBuf  = new Map();  // sessionId -> [{ event, data, ts }, ...] (buffer for ChatGPT timing race)
const codeSession   = new Map();  // code -> sessionId  (cached session per PC for stateless ChatGPT calls)
const sessionInit   = new Map();  // code -> Promise<sessionId|null> (deduplicates concurrent auto-init)

const DATA_DIR = process.env.DATA_DIR || __dirname;
const stateStore = createStateStore(DATA_DIR);
const isProduction = process.env.NODE_ENV === "production";
if (isProduction && (!process.env.RELAY_ADMIN_TOKEN || process.env.RELAY_ADMIN_TOKEN.length < 32)) {
  throw new Error("RELAY_ADMIN_TOKEN must be set to at least 32 characters in production");
}
if (isProduction && !process.env.PUBLIC_URL) {
  console.warn("[relay] PUBLIC_URL is unset; endpoint URLs depend on reverse-proxy headers");
}
// Legacy file locations: DATA_DIR takes priority, __dirname is the fallback for
// installations that previously used the server directory as the data directory.
const ROOMS_FILE          = path.join(DATA_DIR, "rooms.json");
const TOKENS_FILE         = path.join(DATA_DIR, "oauth_tokens.json");
const LEGACY_ROOMS_FILE   = path.join(__dirname, "rooms.json");
const LEGACY_TOKENS_FILE  = path.join(__dirname, "oauth_tokens.json");

/**
 * Load named state from SQLite.  If not yet migrated, look for a JSON file
 * first in DATA_DIR (the configured data directory, which may differ from
 * __dirname) and then in __dirname (the legacy location used by early
 * installations). This ensures that test harnesses that write rooms.json into
 * a temp DATA_DIR have their data picked up correctly.
 */
function loadState(name, primaryFile, legacyFile) {
  const stored = stateStore.read(name, null);
  if (stored) return stored;

  // Try the primary (DATA_DIR) location first, then the legacy __dirname location.
  for (const file of [primaryFile, legacyFile]) {
    if (!file) continue;
    const migrated = stateStore.migrateJson(name, file);
    if (migrated) {
      stateStore.write({ [name]: migrated });
      return migrated;
    }
  }
  return {};
}

let rooms = loadState("rooms",  ROOMS_FILE,  LEGACY_ROOMS_FILE);
let tokens = loadState("tokens", TOKENS_FILE, LEGACY_TOKENS_FILE);

// ── Migration: legacy rooms stored a single PLAINTEXT `apiKey`. Convert to a
//    per-room key list where every key is stored as a scrypt hash. Nothing is
//    persisted in plaintext server-side anymore. ───────────────────────────────
(function migrateRooms() {
  let changed = false;
  for (const [code, room] of Object.entries(rooms)) {
    if (!room) continue;
    const keys = Array.isArray(room.keys) ? room.keys : [];
    let dirty = false;
    if (room.apiKey && typeof room.apiKey === "string" && room.apiKey !== "" && !keys.some(k => k.label === "owner")) {
      const { salt, hash } = hashKey(room.apiKey);
      keys.push({ id: "owner", label: "owner", scopes: FULL_SCOPES.slice(), salt, hash, createdAt: Date.now() });
      dirty = true;
    }
    if (dirty) {
      room.keys = keys;
      delete room.apiKey;
      changed = true;
    }
  }
  if (changed) {
    try { stateStore.write({ rooms }); } catch (error) { console.error("[relay] Could not persist migrated rooms:", error.message); }
  }
})();

function saveState() {
  try { stateStore.write({ rooms, tokens }); }
  catch (error) { console.error("[relay] Could not persist relay state:", error.message); }
}

const REQUEST_TIMEOUT = 60_000; // 60s for tool execution

// ── Helpers ───────────────────────────────────────────────────────────────────
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("hex"); }

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function baseUrl(req) {
  // An explicit PUBLIC_URL always wins. Set it in production so the issuer and
  // endpoint URLs stay correct no matter how the reverse proxy is configured.
  if (process.env.PUBLIC_URL) return String(process.env.PUBLIC_URL).replace(/\/+$/, "");

  const host = req.headers["x-forwarded-host"] || req.headers["host"] || `localhost:${req.socket.localPort || 3000}`;

  // OAuth clients (Claude, ChatGPT) reject discovery documents that advertise
  // plaintext endpoints, so only report http for genuinely local addresses.
  // A misconfigured proxy that omits X-Forwarded-Proto must not downgrade us.
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);

  let proto;
  if (forwardedProto) {
    proto = forwardedProto;
  } else if (req.secure) {
    proto = "https";
  } else {
    proto = isLocal ? "http" : "https";
  }

  return `${proto}://${host}`;
}

function getCode(req) {
  if (req.params && req.params.code) return req.params.code;
  if (req.query && req.query.code)   return req.query.code;
  if (req.body && req.body.code)     return req.body.code;

  // Check path /mcp/:code or /mcp/:code/...
  const pathMatch = (req.path || "").match(/^\/mcp\/([^\/?#]+)/);
  if (pathMatch && pathMatch[1]) return pathMatch[1];

  // Check header
  const headerCode = req.headers["x-mcp-code"] || req.headers["x-client-code"];
  if (headerCode) return String(headerCode);

  // Check Bearer token in tokens map (OAuth) or per-user room keys
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (tokens[t] && tokens[t].code) return tokens[t].code;
    const owner = findKeyOwner(t);
    if (owner) return owner.code;
  }

  // Check subdomain (only if not an IP/sslip.io domain)
  const host  = req.headers["host"] || "";
  if (!host.includes("sslip.io") && !host.includes("nip.io")) {
    const parts = host.split(".");
    if (parts.length >= 3 && parts[0] !== "www" && parts[0] !== "relay") {
      return parts[0];
    }
  }

  // Fallback: If active online PC client exists or registered rooms exist, default to it
  if (clients.size > 0) {
    return Array.from(clients.keys())[0];
  }
  const roomKeys = Object.keys(rooms);
  if (roomKeys.length > 0) {
    return roomKeys[0];
  }

  return "default-pc";
}

// ── WebSocket upgrade ─────────────────────────────────────────────────────────
server.on("upgrade", (request, socket, head) => {
  const url  = new URL(request.url, "http://localhost");
  const code = url.searchParams.get("code");
  if (!code) { socket.destroy(); return; }

  wss.handleUpgrade(request, socket, head, (ws) => {
    console.log(`[relay] PC client attempting: ${code}`);

    ws.on("ping", () => {
      try { ws.pong(); } catch {}
    });

    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) {
        try { ws.ping(); } catch {}
      } else {
        clearInterval(pingInterval);
      }
    }, 15000);

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        // ── Init message from PC ──────────────────────────────────────────
        if (data.type === "init") {
          const targetCode = data.code || code;
          if (!targetCode) {
            try { ws.close(4000, "missing device code"); } catch {}
            return;
          }
          const cleanKey = (data.apiKey || "").trim();
          const isCurrentlyConnected = clients.has(targetCode) && clients.get(targetCode).readyState === 1;

          // Room owner verification & takeover protection:
          const existingRoom = rooms[targetCode];
          const existingKeys = existingRoom && Array.isArray(existingRoom.keys) ? existingRoom.keys : [];
          const hasOwnerKey = existingKeys.some(k => k.label === "owner" && k.salt && k.hash);

          if (hasOwnerKey) {
            const ownerMatch = cleanKey && existingKeys.some(k => k.label === "owner" && k.salt && k.hash && verifyKey(cleanKey, k.salt, k.hash));
            if (!ownerMatch) {
              console.log(`[relay] REJECTED init/takeover of '${targetCode}' (invalid owner API key)`);
              try {
                ws.send(JSON.stringify({
                  type: "error",
                  code: "ROOM_CONFLICT",
                  message: `Invalid API key for room '${targetCode}'. Unauthorized takeover attempt blocked.`,
                }));
              } catch {}
              try { ws.close(); } catch {}
              return;
            }
          }


          // Takeover / update allowed (same-key reconnect, or room disconnected).
          if (clients.has(targetCode)) {
            const oldWs = clients.get(targetCode);
            if (oldWs !== ws) {
              try { oldWs.removeAllListeners("close"); oldWs.close(); } catch {}
            }
          }

          clients.set(targetCode, ws);
          // Store the PC's plaintext API key on its WS so _doForward can inject
          // it as the Authorization header when forwarding relay requests.
          ws._pcApiKey = cleanKey || ws._pcApiKey || "";
          const prev = rooms[targetCode] && typeof rooms[targetCode] === "object" ? rooms[targetCode] : {};
          const keys = Array.isArray(prev.keys) ? prev.keys.slice() : [];
          // Upsert the owner key (hashed, never stored in plaintext).
          if (cleanKey) {
            const { salt, hash } = hashKey(cleanKey);
            const idx = keys.findIndex(k => k.label === "owner");
            if (idx >= 0) {
              keys[idx] = { ...keys[idx], salt, hash, updatedAt: Date.now() };
            } else {
              keys.push({ id: "owner", label: "owner", scopes: FULL_SCOPES.slice(), salt, hash, createdAt: Date.now() });
            }
          }
          rooms[targetCode] = { ...prev, code: targetCode, keys, updatedAt: Date.now() };
          saveState();
          console.log(`[relay] Room initialized: ${targetCode} (owner key: ${cleanKey ? 'registered' : 'none'})`);
          return;
        }

        // ── Response from local PC ────────────────────────────────────────
        if (data.type === "response" && data.requestId) {
          const pending = pendingReqs.get(data.requestId);
          if (pending) {
            clearTimeout(pending.timer);

            // ── Promise-based pending (used by auto-init) ─────────────────
            if (pending._promise) {
              pendingReqs.delete(data.requestId);
              // Cache the session ID if initialize succeeded
              if (data.sessionId && pending.code) {
                codeSession.set(pending.code, data.sessionId);
                if (pending.principal) {
                  sessionPrincipals.set(data.sessionId, { code: pending.principal.code, tokenId: pending.principal.tokenId, createdAt: Date.now() });
                }
              }
              return pending.resolve(data);
            }

            // If initialize response returned a new session ID, cache it for this code
            if (data.sessionId) {
              pending.res.setHeader("mcp-session-id", data.sessionId);
              // Cache for reuse with future stateless ChatGPT calls on this code
              codeSession.set(pending.code, data.sessionId);
            }

             // Older PC clients sent `status`; current clients send both.
             // Preserve the upstream status so auth and tool failures are not
             // misreported as successful HTTP 200 responses.
             const statusCode = data.statusCode || data.status || 200;
            let payload = data.payload;

            // Handle string payload formatted as SSE event (event: message\ndata: {...})
            if (typeof payload === "string" && payload.includes("data: ")) {
              try {
                const dataLine = payload.split("\n").find(line => line.startsWith("data: "));
                if (dataLine) {
                  payload = JSON.parse(dataLine.slice(6).trim());
                }
              } catch {}
            }

            // If PC returned "Server not initialized", our cached session expired — clear and retry
            if (payload && payload.error && payload.error.message && payload.error.message.includes("not initialized")) {
              console.log(`[relay] Session invalidated for ${pending.code}, clearing cache`);
              codeSession.delete(pending.code);
            }

            // MCP POST requests MUST always return application/json
            pending.res.setHeader("Content-Type", "application/json; charset=utf-8");
            if (typeof payload === "string") {
              try {
                const parsed = JSON.parse(payload);
                pending.res.status(statusCode).json(parsed);
              } catch {
                pending.res.status(statusCode).send(payload);
              }
            } else {
              pending.res.status(statusCode).json(payload || { ok: true });
            }
            pendingReqs.delete(data.requestId);

            // ALSO push the result over the open SSE stream for that session.
            // SSE-first MCP clients (ChatGPT OpenAI SDK, OpenClaw) do NOT read
            // the POST response body for tool calls — they wait for the result
            // to arrive on the SSE event stream. Without this, those clients
            // see a successful tools/list but hang (timeout) on tools/call.
            //
            // ChatGPT fix: ChatGPT's connector does NOT always echo the
            // mcp-session-id back in the tool-call POST response. When
            // data.sessionId is null, fall back to:
            //   1. The sessionId we stored when the request came in (pending.sessionId)
            //   2. Any active SSE stream registered for the same PC code
            const resolvedSessionId = data.sessionId || pending.sessionId;
            let sseRes = resolvedSessionId ? sseStreams.get(resolvedSessionId) : null;

            // Fallback: if no stream found by session, find any stream for this code
            if (!sseRes || sseRes.writableEnded) {
              for (const [sid, stream] of sseStreams) {
                if (!stream.writableEnded && stream._code === pending.code) {
                  sseRes = stream;
                  break;
                }
              }
            }

            const effectiveSessionId = resolvedSessionId || (sseRes ? sseRes._sessionId : null);
            const payloadPreview = JSON.stringify(payload).slice(0, 200);
            console.log(`[relay] SSE push for ${effectiveSessionId}: stream=${!!sseRes} ended=${sseRes ? sseRes.writableEnded : '-'} streams=${sseStreams.size} payload=${payloadPreview}`);
            if (sseRes && !sseRes.writableEnded) {
              sseRes.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
            } else {
              // Buffer the event — use sessionId if available, else fall back to code
              // so it can be flushed when any SSE stream opens for this PC
              const bufKey = effectiveSessionId || `code:${pending.code}`;
              if (!sseEventBuf.has(bufKey)) sseEventBuf.set(bufKey, []);
              sseEventBuf.get(bufKey).push({ event: "message", data: JSON.stringify(payload), ts: Date.now() });
              console.log(`[relay] SSE event buffered under key=${bufKey} (will flush on stream open)`);
              setTimeout(() => sseEventBuf.delete(bufKey), 90_000);
            }
          }
        }

        // ── SSE event / chunk from local PC ───────────────────────────────
        else if (data.type === "sseChunk" && data.sessionId) {
          const sseRes = sseStreams.get(data.sessionId);
          if (sseRes && !sseRes.writableEnded) {
            sseRes.write(data.payload);
          }
        }
        else if (data.type === "sseEvent" && data.sessionId) {
          const sseRes = sseStreams.get(data.sessionId);
          if (sseRes && !sseRes.writableEnded) {
            sseRes.write(`event: message\ndata: ${JSON.stringify(data.payload)}\n\n`);
          }
        }

        // ── SSE close notification ────────────────────────────────────────
        else if (data.type === "sseClose" && data.sessionId) {
          const sseRes = sseStreams.get(data.sessionId);
          if (sseRes && !sseRes.writableEnded) sseRes.end();
          sseStreams.delete(data.sessionId);
        }

      } catch (err) {
        console.error("[relay] WS message parse error:", err.message);
      }
    });

    ws.on("close", () => {
      clearInterval(pingInterval);
      if (clients.get(code) === ws) {
        clients.delete(code);
        console.log(`[relay] PC client disconnected: ${code}`);
      }
      for (const [reqId, pending] of pendingReqs) {
        if (pending.code === code) {
          clearTimeout(pending.timer);
          try { pending.res.status(502).json({ error: "PC client disconnected" }); } catch {}
          pendingReqs.delete(reqId);
        }
      }
    });

    ws.on("error", (err) => {
      console.error(`[relay] WS error for ${code}:`, err.message);
    });
  });
});

// ── Helper: raw WS send to PC and wait for response (used for auto-init) ──────
function sendToPCAndWait(code, wsPayload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = clients.get(code);
    if (!ws || ws.readyState !== 1) return reject(new Error("PC offline"));
    const requestId = crypto.randomBytes(8).toString("hex");
    const timer = setTimeout(() => {
      pendingReqs.delete(requestId);
      reject(new Error("timeout"));
    }, timeoutMs);
    // Store a special pending entry that resolves the promise instead of writing to res
    pendingReqs.set(requestId, { _promise: true, resolve, reject, timer, code, sessionId: null });
    ws.send(JSON.stringify({ type: "request", requestId, sessionId: null, payload: wsPayload }));
  });
}

// ── Helper: get or create a cached session for a PC code (for stateless ChatGPT) ─
async function getOrCreateSession(code, localPort, apiKey) {
  // Return cached session if still valid
  const cached = codeSession.get(code);
  if (cached) return cached;

  // Tool discovery and the first tool call commonly arrive together. Without
  // single-flight protection both requests observe an empty cache and each
  // creates a local MCP transport session.
  const inFlight = sessionInit.get(code);
  if (inFlight) return inFlight;

  const initialization = (async () => {
    console.log(`[relay] Auto-initializing session for code=${code}`);
    const initBody = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "relay-auto", version: "1.0" },
      },
    };
    const initHeaders = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      ...(apiKey ? { "authorization": `Bearer ${apiKey}` } : {}),
    };
    try {
      const data = await sendToPCAndWait(code, {
        method: "POST",
        path: `/mcp`,
        headers: initHeaders,
        body: initBody,
      }, 15000);
      const sessionId = data.sessionId;
      if (!sessionId) throw new Error("No session ID in initialize response");
      codeSession.set(code, sessionId);
      // Local sessions expire after 30 minutes. Drop the relay cache first so
      // the next request cannot be routed to an already-expired transport.
      setTimeout(() => { if (codeSession.get(code) === sessionId) codeSession.delete(code); }, 29 * 60 * 1000);
      console.log(`[relay] Auto-init session created: ${sessionId} for ${code}`);
      return sessionId;
    } catch (err) {
      console.error(`[relay] Auto-init failed for ${code}:`, err.message);
      return null;
    } finally {
      sessionInit.delete(code);
    }
  })();

  sessionInit.set(code, initialization);
  return initialization;
}

// ── Helper: forward request to local PC via WebSocket ─────────────────────────
function forwardToPC(code, req, res, extraPayload = {}) {
  const ws = clients.get(code);
  if (!ws || ws.readyState !== 1) {
    if (req.body && req.body.jsonrpc === "2.0") {
      return res.status(200).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: `PC client "${code}" is not connected. Please open the PC Control MCP app on your computer.`,
        },
        id: req.body.id !== undefined ? req.body.id : null,
      });
    }
    return res.status(503).json({
      error: "pc_offline",
      error_description: `PC client "${code}" is not online. Start the PC Control MCP app on your computer.`,
    });
  }

  // Extract session ID from all possible locations ChatGPT might use
  const incomingSessionId =
    req.headers["mcp-session-id"] ||
    req.query["mcp-session-id"] ||
    req.query["sessionId"] ||
    req.query["session_id"] ||
    (req.body && req.body["mcp-session-id"]) ||
    null;

  const mcpMethod = req.body && req.body.method;
  console.log(`[relay] → ${req.method} ${req.path} session=${incomingSessionId} body_method=${mcpMethod || '-'}`);

  // ── ChatGPT stateless fix ────────────────────────────────────────────────────
  // ChatGPT sends tools/call (and other methods) with NO mcp-session-id.
  // The PC rejects these with "Server not initialized". We auto-initialize
  // a session for this PC code and inject the session ID into the forwarded request.
  const needsSession = !incomingSessionId && mcpMethod && mcpMethod !== "initialize";
  if (needsSession) {
    let apiKey = "";
    try { const { config: sc } = require("./lib/security"); apiKey = sc.api_key || ""; } catch {}
    // Get or create a cached session, then retry the forward with it
    getOrCreateSession(code, null, apiKey).then((sessionId) => {
      if (!sessionId) {
        // Could not get session — fall through with no session (will get "not initialized" error)
        return _doForward(code, req, res, null, extraPayload);
      }
      console.log(`[relay] Injecting session ${sessionId} for stateless ${mcpMethod}`);
      return _doForward(code, req, res, sessionId, extraPayload);
    }).catch(() => _doForward(code, req, res, null, extraPayload));
    return;
  }

  if (incomingSessionId) {
    const bound = sessionPrincipals.get(incomingSessionId);
    if (bound && (!req.principal || bound.code !== req.principal.code || bound.tokenId !== req.principal.tokenId)) {
      return res.status(401).json({ error: "invalid_session", error_description: "MCP session is bound to a different authenticated principal." });
    }
    if (req.principal && !bound) sessionPrincipals.set(incomingSessionId, { code: req.principal.code, tokenId: credToken(req), createdAt: Date.now() });
  }
  _doForward(code, req, res, incomingSessionId, extraPayload);
}

function _doForward(code, req, res, sessionId, extraPayload = {}) {
  const ws = clients.get(code);
  const requestId = crypto.randomBytes(8).toString("hex");
  const toolTimeout = req.body?.params?.arguments?.timeout_ms || req.body?.timeout_ms;
  const timeoutMs = (typeof toolTimeout === "number" && toolTimeout > 0) ? (toolTimeout + 10000) : REQUEST_TIMEOUT;

  const timer = setTimeout(() => {
    if (pendingReqs.has(requestId)) {
      pendingReqs.delete(requestId);
      try {
        if (req.body && req.body.jsonrpc === "2.0") {
          res.status(200).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Request timed out waiting for local PC." },
            id: req.body.id !== undefined ? req.body.id : null,
          });
        } else {
          res.status(504).json({ error: "timeout", error_description: "PC client did not respond in time." });
        }
      } catch {}
    }
  }, timeoutMs);

  pendingReqs.set(requestId, { res, timer, code, sessionId, principal: req.principal });

  // The relay has already authenticated the external client (Claude/ChatGPT).
  // When forwarding to the local PC we replace the external OAuth/user token
  // with the PC's own Master API key — the only credential the local MCP server
  // knows and trusts. This is safe because the relay is the auth boundary.
  const pcRoom = rooms[code];
  const pcApiKey = ws._pcApiKey || (pcRoom && pcRoom._plainApiKey) || "";

  const forwardedHeaders = {
    ...req.headers,
    "accept": "application/json, text/event-stream",
    "content-type": req.headers["content-type"] || "application/json",
    // Inject session ID if we have one
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    // Replace external token with PC's own master key so local server accepts it
    ...(pcApiKey ? { "authorization": `Bearer ${pcApiKey}` } : {}),
  };

  ws.send(JSON.stringify({
    type: "request",
    requestId,
    sessionId: sessionId || null,
    payload: {
      method:  req.method,
      path:    req.path,
      headers: forwardedHeaders,
      body:    req.body,
      ...extraPayload,
    },
  }));
}

// ── Authorization gate ───────────────────────────────────────────────────────
// The relay is the AUTHORITATIVE enforcement point for everything exposed to
// the internet. A request only reaches the local PC if it presents a valid
// credential: either a per-user room key (stored as a scrypt hash) or a valid
// (non-expired) OAuth access token issued by this relay's /oauth/token endpoint.
//
// Every request is resolved to a *principal*: the resolved room code plus the
// scopes granted to that key/token. Scope enforcement happens downstream.
function findKeyOwner(token) {
  if (!token) return null;
  const norm = s => String(s || "").trim().replace(/^["']|["']$/g, "");
  const t = norm(token);
  if (!t) return null;
  for (const [code, room] of Object.entries(rooms)) {
    if (!room || !Array.isArray(room.keys)) continue;
    for (const k of room.keys) {
      if (!k || typeof k !== "object" || !k.salt || !k.hash) continue;
      if (verifyKey(t, k.salt, k.hash)) {
        return { code, keyId: k.id || k.label, label: k.label, scopes: Array.isArray(k.scopes) ? k.scopes : FULL_SCOPES.slice() };
      }
    }
  }
  return null;
}

function resolvePrincipal(req) {
  const token = credToken(req);
  const code = getCode(req);
  if (code) {
    // OAuth access token bound to this room?
    const rec = token ? tokens[token] : null;
    if (rec && rec.type === "access") {
      if (rec.expires && rec.expires < Date.now()) return null;
      if (rec.code && rec.code !== code) return null;
      return { code, type: "oauth", label: "oauth", scopes: Array.isArray(rec.scopes) && rec.scopes.length ? rec.scopes.slice() : tokenScopesOf(rec), tokenId: token };
    }
    // Per-user key belonging to this room?
    const room = rooms[code];
    if (room && Array.isArray(room.keys)) {
      const norm = s => String(s || "").trim().replace(/^["']|["']$/g, "");
      const t = norm(token);
      for (const k of room.keys) {
        if (!k || typeof k !== "object" || !k.salt || !k.hash) continue;
        if (verifyKey(t, k.salt, k.hash)) {
          return { code, type: "key", keyId: k.id || k.label, label: k.label, scopes: Array.isArray(k.scopes) ? k.scopes : FULL_SCOPES.slice(), tokenId: t };
        }
      }
    }
    return null; // room known but this credential is not authorized for it
  }
  // No code in URL → derive room from the credential itself
  if (token) {
    const owner = findKeyOwner(token);
    if (owner) return { ...owner, type: "key", tokenId: token };
    const rec = tokens[token];
    if (rec && rec.type === "access" && rec.code && (!rec.expires || rec.expires >= Date.now())) {
      return { code: rec.code, type: "oauth", label: "oauth", scopes: Array.isArray(rec.scopes) && rec.scopes.length ? rec.scopes.slice() : tokenScopesOf(rec), tokenId: token };
    }
  }
  return null;
}

function tokenScopesOf(rec) {
  if (rec && typeof rec.scope === "string") return normalizeScopes(rec.scope.split(/\s+/));
  return FULL_SCOPES.slice();
}

function canonicalResource(req, code) {
  const base = baseUrl(req).replace(/\/+$/, "");
  return `${base}/mcp/${encodeURIComponent(code)}`;
}

function validResource(req, code, value) {
  return typeof value === "string" && value === canonicalResource(req, code);
}

function exactRegisteredRedirect(clientId, uri) {
  const client = dynamicClients.get(clientId);
  return Boolean(client && Array.isArray(client.redirect_uris) && client.redirect_uris.includes(uri));
}

function credToken(req) {
  const auth = req.headers["authorization"] || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth.trim();
}

function requireAuth(req, res, next) {
  // OAuth/discovery/consent endpoints and public health/root stay reachable.
  const p = (req.path || "").split("?")[0];
  const isOAuthConsentOrDiscovery =
    p === "/oauth/authorize" ||
    p === "/mcp/oauth/authorize" ||
    /^\/mcp\/[^/]+\/oauth\/authorize$/.test(p) ||
    p.includes("/oauth/token") || p.includes("/oauth/register") || p.includes("/oauth/revoke") ||
    p.includes("/.well-known/") || p === "/logo.png" || p === "/legal" || p === "/favicon.ico" ||
    p === "/openapi.json" || p.startsWith("/admin/") || p === "/health" || p === "/ready" || p === "/";
  if (isOAuthConsentOrDiscovery) {
    return next();
  }

  const principal = resolvePrincipal(req);
  if (!principal) {
    const base = baseUrl(req);
    const roomMatch = p.match(/^\/mcp\/([^/]+)/);
    const resourceMetadata = roomMatch
      ? `${base}/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(roomMatch[1])}`
      : `${base}/.well-known/oauth-protected-resource`;
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="pc-control-mcp", resource_metadata="${resourceMetadata}"`
    );
    return res.status(401).json({
      error: "unauthorized",
      error_description: "Bearer token required. Authenticate via OAuth or supply a valid per-user API key.",
      oauth_discovery: `${base}/.well-known/oauth-authorization-server`,
    });
  }
  req.principal = principal;
  next();
}
app.use(requireAuth);

// ── Health / status ───────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
  });
});

app.get("/ready", (req, res) => {
  try {
    stateStore.read("rooms", {});
    stateStore.read("tokens", {});
    res.json({ status: "ready", database: "ok" });
  } catch (error) {
    res.status(503).json({ status: "not_ready", database: "error", error: error.message });
  }
});

// ── Root ──────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    name: "PC Control MCP Relay Server",
    version: "2.0.0",
    status: "running",
    auth_required: true,
    mcp_endpoint: "/mcp/:code",
    health: "/health",
  });
});

// ── OpenAPI spec ──────────────────────────────────────────────────────────────
app.get("/openapi.json", (req, res) => {
  const code = getCode(req) || "your-pc-name";
  const base = baseUrl(req);
  res.json({
    openapi: "3.1.0",
    info: { title: "PC Control API", version: "2.0.0", description: "Control your PC remotely." },
    servers: [{ url: base }],
    paths: {
      [`/mcp/${code}`]: {
        post: {
          summary: "MCP StreamableHTTP endpoint",
          operationId: "mcp",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { description: "JSON-RPC response or SSE stream" } },
        },
      },
    },
  });
});

// ── OAuth discovery endpoints ─────────────────────────────────────────────────
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer:                            base,
    authorization_endpoint:            `${base}/oauth/authorize`,
    token_endpoint:                    `${base}/oauth/token`,
    revocation_endpoint:               `${base}/oauth/revoke`,
    registration_endpoint:             `${base}/oauth/register`,
    scopes_supported:                  ["mcp:tools", "mcp:resources"],
    response_types_supported:          ["code"],
    grant_types_supported:             ["authorization_code", "refresh_token"],
    code_challenge_methods_supported:  ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
    require_pkce:                      true,
  });
});

function protectedResourceMetadata(req, res) {
  const base = baseUrl(req);
  const code = req.params.code || null;
  const resource = code ? `${base}/mcp/${code}` : base;
  const authorizationServer = code ? `${base}/mcp/${code}` : base;
  res.json({
    resource,
    authorization_servers:    [authorizationServer],
    scopes_supported:         ["mcp:tools", "mcp:resources"],
    bearer_methods_supported: ["header"],
  });
}

// RFC 9728 canonical path for protected resources that have a path component.
app.get("/.well-known/oauth-protected-resource/mcp/:code", protectedResourceMetadata);
app.get("/mcp/:code/.well-known/oauth-protected-resource", protectedResourceMetadata);
app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);

app.get(/\/\.well-known\/openid-configuration(?:\/[^/]*)?$/, (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer:                            base,
    authorization_endpoint:            `${base}/oauth/authorize`,
    token_endpoint:                    `${base}/oauth/token`,
    scopes_supported:                  ["mcp:tools", "mcp:resources"],
  });
});

function authorizationServerMetadata(req, code) {
  const base = `${baseUrl(req)}/mcp/${code}`;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: ["mcp:tools", "mcp:resources"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
    require_pkce: true,
  };
}

app.get("/.well-known/oauth-authorization-server/mcp/:code", (req, res) => {
  res.json(authorizationServerMetadata(req, req.params.code));
});

app.get("/mcp/:code/.well-known/oauth-authorization-server", (req, res) => {
  res.json(authorizationServerMetadata(req, req.params.code));
});

// ── OAuth Dynamic Client Registration ────────────────────────────────────────
const dynamicClients = new Map();

const registerHandler = (req, res) => {
  const body       = req.body || {};
  const clientId   = "dyn_" + randomToken(12);
  const clientSecret = randomToken(32);
  const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  
  // Validate that all redirect_uris point to trusted AI client domains or loopback
  const trustedDomains = ["claude.ai", "chatgpt.com", "openai.com", "cursor.sh", "cursor.com"];
  for (const uriStr of redirect_uris) {
    try {
      const parsed = new URL(uriStr);
      const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      const isTrusted = trustedDomains.some(d => parsed.hostname === d || parsed.hostname.endsWith("." + d));
      if (parsed.hash || (isLoopback ? !["http:", "https:"].includes(parsed.protocol) : parsed.protocol !== "https:")) {
        return res.status(400).json({ error: "invalid_redirect_uri", error_description: "Redirect URI must use HTTPS, except loopback development URIs." });
      }
      if (!isLoopback && !isTrusted) {
        return res.status(400).json({ error: "invalid_redirect_uri", error_description: `Redirect URI domain '${parsed.hostname}' is not in the trusted domain whitelist.` });
      }
    } catch {
      return res.status(400).json({ error: "invalid_redirect_uri", error_description: "Malformed redirect_uri provided." });
    }
  }

  dynamicClients.set(clientId, {
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uris,
    client_name:   body.client_name || "MCP Client",
    grant_types:   body.grant_types || ["authorization_code"],
    createdAt:     Date.now(),
  });

  console.log("[oauth/register] Created dynamic client:", clientId);

  res.status(201).json({
    client_id:                  clientId,
    client_secret:              clientSecret,
    redirect_uris,
    grant_types:                ["authorization_code", "refresh_token"],
    response_types:             ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
};
app.post("/oauth/register",          registerHandler);
app.post("/mcp/:code/oauth/register", registerHandler);

// ── OAuth Authorization Page — SERVED LOCALLY (beautiful HTML) ───────────────
function buildAuthPage(code, query) {
  const clientName = query.client_name || "Claude / ChatGPT";
  const redirectUri = escHtml(query.redirect_uri || "");
  const state       = escHtml(query.state || "");
  const scope       = escHtml(query.scope || "mcp:tools mcp:resources");
  const resource    = escHtml(query.resource || "");
  const clientId    = escHtml(query.client_id || "");
  const codeChallenge       = escHtml(query.code_challenge || "");
  const codeChallengeMethod = escHtml(query.code_challenge_method || "S256");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Connection — PC Control MCP</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', sans-serif;
      background: radial-gradient(ellipse at 60% 10%, rgba(139, 92, 246, 0.15) 0%, transparent 60%),
                  radial-gradient(ellipse at 10% 80%, rgba(59, 130, 246, 0.1) 0%, transparent 60%),
                  #0b0b0f;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #e5e7eb;
    }
    .card {
      background: rgba(26, 26, 36, 0.9);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      padding: 40px;
      width: 100%;
      max-width: 440px;
      box-shadow: 0 25px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(139,92,246,0.1);
    }
    .logo { display: flex; align-items: center; gap: 14px; margin-bottom: 28px; }
    .logo-icon {
      width: 44px; height: 44px;
      background: linear-gradient(135deg, #8B5CF6, #3B82F6);
      border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
    }
    .logo-icon svg { width: 22px; height: 22px; color: #fff; }
    .logo-name  { font-size: 16px; font-weight: 700; color: #fff; }
    .logo-sub   { font-size: 12px; color: #6b7280; }
    h1 { font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 6px; }
    .client-pill {
      display: inline-block;
      background: rgba(139,92,246,0.15);
      border: 1px solid rgba(139,92,246,0.3);
      color: #a78bfa;
      font-size: 12px;
      font-weight: 600;
      padding: 3px 12px;
      border-radius: 20px;
      margin-bottom: 18px;
    }
    .desc { font-size: 13px; color: #9ca3af; line-height: 1.5; margin-bottom: 20px; }
    .scope-container { background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 4px; margin-bottom: 20px; }
    .scope-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 8px; }
    .scope-row:hover { background: rgba(255,255,255,0.03); }
    .scope-icon { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .scope-icon svg { width: 16px; height: 16px; }
    .scope-title { font-size: 13px; font-weight: 600; color: #e5e7eb; }
    .scope-desc  { font-size: 11px; color: #6b7280; margin-top: 1px; }
    .warning-box {
      background: rgba(245,158,11,0.08);
      border: 1px solid rgba(245,158,11,0.2);
      border-radius: 10px;
      padding: 12px 16px;
      display: flex;
      gap: 10px;
      align-items: flex-start;
      margin-bottom: 24px;
      font-size: 12px;
      color: #fbbf24;
      line-height: 1.5;
    }
    .warning-icon { flex-shrink: 0; width: 16px; height: 16px; margin-top: 1px; }
    label { display: block; font-size: 12px; font-weight: 500; color: #9ca3af; margin-bottom: 6px; }
    input[type="password"] {
      width: 100%; padding: 12px 16px;
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      color: #fff;
      font-family: inherit;
      font-size: 14px;
      outline: none;
      transition: border 0.2s;
      margin-bottom: 20px;
    }
    input[type="password"]:focus { border-color: #8B5CF6; box-shadow: 0 0 0 3px rgba(139,92,246,0.15); }
    input[type="password"]::placeholder { color: #4b5563; }
    .btns { display: flex; gap: 12px; }
    .btn-allow {
      flex: 1; padding: 13px;
      background: linear-gradient(135deg, #7C3AED, #4F46E5);
      color: #fff; border: none; border-radius: 10px;
      font-family: inherit; font-size: 14px; font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 4px 15px rgba(124,58,237,0.4);
    }
    .btn-allow:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(124,58,237,0.5); }
    .btn-deny {
      padding: 13px 20px;
      background: transparent;
      color: #6b7280; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      font-family: inherit; font-size: 14px; font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-deny:hover { background: rgba(255,255,255,0.05); color: #fff; }
    .footer { margin-top: 20px; text-align: center; font-size: 11px; color: #374151; }
    .pc-name { color: #8B5CF6; font-weight: 600; }
  </style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/>
      </svg>
    </div>
    <div>
      <div class="logo-name">PC Control MCP</div>
      <div class="logo-sub">Access Authorization</div>
    </div>
  </div>

  <h1>Authorize Connection</h1>
  <div class="client-pill">${escHtml(clientName)}</div>
  <p class="desc">An AI assistant is requesting permission to control your PC <span class="pc-name">${escHtml(code)}</span>. Enter your API key to authorize.</p>

  <div class="scope-container">
    <div class="scope-row">
      <div class="scope-icon" style="background:rgba(139,92,246,0.15)">
        <svg viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
      </div>
      <div>
        <div class="scope-title">System Control</div>
        <div class="scope-desc">Execute commands, control mouse &amp; keyboard</div>
      </div>
    </div>
    <div class="scope-row">
      <div class="scope-icon" style="background:rgba(59,130,246,0.15)">
        <svg viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2"><path d="M3 3h18M3 12h18M3 21h18"/></svg>
      </div>
      <div>
        <div class="scope-title">File &amp; Process Access</div>
        <div class="scope-desc">Read/write files, manage running processes</div>
      </div>
    </div>
  </div>

  <div class="warning-box">
    <svg class="warning-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
    </svg>
    <div>Only authorize if you initiated this connection. This grants the AI full control of your PC.</div>
  </div>

  <form method="POST">
    <input type="hidden" name="code" value="${escHtml(code)}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="hidden" name="resource" value="${resource}">
    <input type="hidden" name="code_challenge" value="${codeChallenge}">
    <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
    <input type="hidden" name="scope" value="${scope}">
    <label>PC Control API Key</label>
    <input type="password" name="api_key" required placeholder="Paste your API key here…">
    <div class="btns">
      <button type="submit" name="action" value="deny" class="btn-deny">Deny</button>
      <button type="submit" name="action" value="allow" class="btn-allow">Allow Access</button>
    </div>
  </form>

  <div class="footer">Relay authorization server · PC Control MCP</div>
</div>
</body>
</html>`;
}

// GET /oauth/authorize or /mcp/:code/oauth/authorize
const authorizeGetHandler = (req, res) => {
  const code = req.params.code || getCode(req) || "default-pc";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(buildAuthPage(code, req.query));
};
app.get("/oauth/authorize",           authorizeGetHandler);
app.get("/mcp/:code/oauth/authorize", authorizeGetHandler);

// Redirect URIs are accepted only when exactly registered for this client.
function isValidRedirectUri(clientId, uriStr) {
  return exactRegisteredRedirect(clientId, uriStr);
}

// POST /oauth/authorize — handle form submission
const authorizePostHandler = (req, res) => {
  const code = req.params.code || getCode(req) || "default-pc";
  const { action, api_key, redirect_uri, state, client_id, code_challenge, code_challenge_method, scope, resource } = req.body || {};
  const targetUri = redirect_uri || "https://claude.ai/api/auth/callback/connector";

  if (!client_id || !dynamicClients.has(client_id)) {
    return res.status(400).send("Unknown OAuth client.");
  }
  if (!exactRegisteredRedirect(client_id, targetUri)) {
    return res.status(400).send("Invalid or unapproved redirect_uri.");
  }
  if (!state || typeof state !== "string" || state.length < 16 || state.length > 512) {
    return res.status(400).send("A valid state parameter is required.");
  }
  if (!code_challenge || code_challenge_method !== "S256") {
    return res.status(400).send("S256 PKCE is required.");
  }
  if (!validResource(req, code, resource)) {
    return res.status(400).send("Invalid resource.");
  }

  if (action === "deny") {
    const target = new URL(targetUri);
    target.searchParams.set("error", "access_denied");
    if (state) target.searchParams.set("state", state);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${target.toString()}"></head><body>Redirecting...</body></html>`);
  }

  if (action !== "allow") {
    return res.status(400).send("Invalid action.");
  }

  let roomData = rooms[code];
  if (!roomData) {
    const { salt, hash } = hashKey(newKeyBytes());
    roomData = {
      code,
      label: code,
      keys: [{ id: "owner-" + code, label: "owner", scopes: FULL_SCOPES.slice(), salt, hash, createdAt: Date.now() }],
      updatedAt: Date.now(),
    };
    rooms[code] = roomData;
    saveState();
  }

  // Verify API Key strictly against target room keys (never searching all rooms)
  const submittedKey = String(api_key || "").trim();
  let isValid = false;
  let authorizedScopes = null;
  let authorizedKeyId = null;

  if (submittedKey && Array.isArray(roomData.keys)) {
    for (const k of roomData.keys) {
      if (!k || typeof k !== "object" || !k.salt || !k.hash) continue;
      if (verifyKey(submittedKey, k.salt, k.hash)) {
        isValid = true;
        authorizedScopes = Array.isArray(k.scopes) ? k.scopes : FULL_SCOPES.slice();
        authorizedKeyId = k.id || k.label;
        break;
      }
    }
  }

  if (!isValid) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(401).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Invalid API Key — PC Control MCP</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0b0f; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 20px; }
    .card { background: #1a1a24; padding: 32px; border-radius: 16px; text-align: center; border: 1px solid rgba(239, 68, 68, 0.4); max-width: 440px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
    h2 { color: #f87171; font-size: 20px; margin-bottom: 12px; }
    p { color: #9ca3af; font-size: 14px; line-height: 1.6; margin-bottom: 20px; }
    .btn { display: inline-block; padding: 12px 24px; background: #7c3aed; color: #fff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>❌ Invalid API Key</h2>
    <p>The API key you entered is not valid for this PC room.<br><br>Use a key issued for the room code <code>${escHtml(code)}</code>.</p>
    <a href="javascript:history.back()" class="btn">← Try Again</a>
  </div>
</body>
</html>`);
  }

  // Generate authorization code (bound to request IP)
  const authCode = randomToken(24);
  const grantedScopes = authorizedScopes || FULL_SCOPES.slice();

  tokens[authCode] = {
    code:                   code,
    client_id:              client_id || "mcp_client",
    redirect_uri:           targetUri,
    scope:                  grantedScopes.join(" "),
    scopes:                 grantedScopes,
    key_id:                 authorizedKeyId || null,
    resource:              canonicalResource(req, code),
    code_challenge:         code_challenge,
    code_challenge_method:  "S256",
    type:                   "auth_code",
    expires:                Date.now() + 5 * 60 * 1000,
  };
  saveState();

  try {
    const target = new URL(targetUri);
    target.searchParams.set("code", authCode);
    if (state) target.searchParams.set("state", state);
    return res.redirect(target.toString());
  } catch {
    return res.status(400).send("Invalid redirect_uri.");
  }
};
app.post("/oauth/authorize",           authorizePostHandler);
app.post("/mcp/:code/oauth/authorize", authorizePostHandler);

// ── OAuth Token endpoint ──────────────────────────────────────────────────────
const tokenHandler = (req, res) => {
  const body = req.body || {};
  console.log("[oauth/token] grant_type:", body.grant_type);

  if (body.grant_type === "authorization_code") {
    const record = tokens[body.code];
    if (!record || record.type !== "auth_code" || record.expires < Date.now()) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Authorization code not found or expired." });
    }
    if (!dynamicClients.has(body.client_id)) {
      return res.status(400).json({ error: "invalid_client", error_description: "Unknown OAuth client." });
    }
    const registeredClient = dynamicClients.get(body.client_id);
    if (registeredClient.client_secret && body.client_secret !== registeredClient.client_secret) {
      return res.status(401).json({ error: "invalid_client", error_description: "Invalid client credentials." });
    }

    if (record.client_id && record.client_id !== body.client_id) {
      return res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch." });
    }
    if (record.redirect_uri && record.redirect_uri !== body.redirect_uri) {
      return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch." });
    }
    const verifier = String(body.code_verifier || "");
    const actual = verifier ? crypto.createHash("sha256").update(verifier).digest("base64url") : "";
    if (!verifier || actual !== record.code_challenge) {
      return res.status(400).json({ error: "invalid_grant", error_description: "S256 PKCE verification failed." });
    }
    if (!validResource(req, record.code, body.resource) || body.resource !== record.resource) {
      return res.status(400).json({ error: "invalid_grant", error_description: "resource mismatch." });
    }

    delete tokens[body.code]; // single-use after all validation succeeds

    const access_token  = randomToken(32);
    const refresh_token = randomToken(32);

    const grantedScopes = Array.isArray(record.scopes) && record.scopes.length
      ? record.scopes
      : (record.scope || "").split(/\s+/).filter(Boolean);

    tokens[access_token]  = { code: record.code, type: "access", client_id: record.client_id, resource: record.resource, expires: Date.now() + 3600 * 1000, scopes: grantedScopes };
    tokens[refresh_token] = { code: record.code, type: "refresh", client_id: record.client_id, resource: record.resource, scopes: grantedScopes };
    saveState();

    return res.json({
      access_token,
      token_type:    "bearer",
      expires_in:    3600,
      refresh_token,
      scope:         record.scope || grantedScopes.join(" "),
    });
  }

  if (body.grant_type === "refresh_token") {
    const record = tokens[body.refresh_token];
    if (!record || record.type !== "refresh") {
      return res.status(400).json({ error: "invalid_grant" });
    }
    if (!dynamicClients.has(body.client_id)) {
      return res.status(400).json({ error: "invalid_client", error_description: "Unknown OAuth client." });
    }
    const registeredClient = dynamicClients.get(body.client_id);
    if (registeredClient.client_secret && body.client_secret !== registeredClient.client_secret) {
      return res.status(401).json({ error: "invalid_client", error_description: "Invalid client credentials." });
    }
    if (body.client_id && record.client_id && body.client_id !== record.client_id) {
      return res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch." });
    }
    if (!validResource(req, record.code, body.resource) || body.resource !== record.resource) {
      return res.status(400).json({ error: "invalid_grant", error_description: "resource mismatch." });
    }

    const access_token  = randomToken(32);
    const refresh_token = randomToken(32);

    const grantedScopes = Array.isArray(record.scopes) && record.scopes.length
      ? record.scopes
      : ["pc:file:read", "pc:file:write", "pc:file:list", "pc:process:run", "pc:process:list", "pc:process:kill"];

    tokens[access_token]         = { code: record.code, type: "access", client_id: record.client_id, resource: record.resource, expires: Date.now() + 3600 * 1000, scopes: grantedScopes };
    tokens[refresh_token]        = { code: record.code, type: "refresh", client_id: record.client_id, resource: record.resource, scopes: grantedScopes };
    delete tokens[body.refresh_token];
    saveState();

    return res.json({
      access_token,
      token_type:  "bearer",
      expires_in:  3600,
      refresh_token,
      scope:       grantedScopes.join(" "),
    });
  }

  return res.status(400).json({ error: "unsupported_grant_type" });
};
app.post("/oauth/token",           tokenHandler);
app.post("/mcp/:code/oauth/token", tokenHandler);

// ── OAuth Token Revocation ────────────────────────────────────────────────────
const revokeHandler = (req, res) => {
  const token = (req.body || {}).token;
  if (token && tokens[token]) {
    delete tokens[token];
    saveState();
  }
  res.status(200).json({});
};
app.post("/oauth/revoke",           revokeHandler);
app.post("/mcp/:code/oauth/revoke", revokeHandler);

// ── ChatGPT plugin manifest ───────────────────────────────────────────────────
app.get("/.well-known/ai-plugin.json", (req, res) => {
  const code = getCode(req) || "your-pc-name";
  const base = baseUrl(req);
  res.json({
    schema_version: "v1",
    name_for_model: "pc_control",
    name_for_human: "PC Control",
    description_for_model: "Control system tasks like mouse, keyboard, shell, files, and screen on the host PC.",
    auth: {
      type: "oauth",
      client_url: `${base}/oauth/authorize`,
      scope: "mcp:tools mcp:resources",
      authorization_url: `${base}/oauth/token`,
      authorization_content_type: "application/x-www-form-urlencoded",
      verification_tokens: { openai: "" },
    },
    api: { type: "openapi", url: `${base}/openapi.json` },
    logo_url: `${base}/logo.png`,
    contact_email: "support@pc-control-mcp.dev",
    legal_info_url: `${base}/legal`,
  });
});

// ── REST tool dispatch ────────────────────────────────────────────────────────
app.post("/tool/:name", (req, res) => {
  const name = req.params.name;
  const principal = req.principal;
  let code = principal ? principal.code : (getCode(req) || req.query.code);
  if (!code) {
    if (principal) code = principal.code;
    else return res.status(400).json({ error: "missing_code" });
  }
  // Enforce per-user key scopes: if the caller's key does not authorize this
  // tool, refuse before anything reaches the local PC. Applies to per-user
  // keys AND OAuth access tokens that inherit a restricted scope set.
  if (principal && principal.scopes && !hasScope(principal.scopes, name)) {
    return res.status(403).json({
      error: "forbidden",
      error_description: `Your API key does not have the required scope for tool: ${name}.`,
      required_scope: toolScopeOf(name),
    });
  }
  forwardToPC(code, req, res, { toolName: name });
});

// ── Admin API: per-user keys ───────────────────────────────────────────────────
// Protected by the RELAY_ADMIN_TOKEN environment variable (or default key).
// Lets the operator add/remove individual users, each with their own API key
// and an explicit scope allow-list. The plaintext key is returned ONCE at
// creation time; only its scrypt hash is stored.
function adminAuth(req, res, next) {
  const adminToken = process.env.RELAY_ADMIN_TOKEN;
  const auth = req.headers["authorization"] || "";
  const t = auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth.trim();
  const roomCodeHeader = req.headers["x-room-code"] || req.query.code || (req.body && req.body.code);

  // 1. If global RELAY_ADMIN_TOKEN is provided and matches, allow full admin
  if (adminToken && t && t === adminToken) {
    req.isAdmin = true;
    return next();
  }

  // 2. If token matches a valid key owner on the relay, allow room owner admin
  if (t) {
    const principal = findKeyOwner(t);
    if (principal) {
      req.roomCode = principal.code;
      req.roomKey = principal;
      return next();
    }
  }

  // 3. If room header matches existing room and token matches any key in room
  if (roomCodeHeader && rooms[roomCodeHeader] && t) {
    const room = rooms[roomCodeHeader];
    if (Array.isArray(room.keys)) {
      for (const k of room.keys) {
        if (k && k.salt && k.hash && verifyKey(t, k.salt, k.hash)) {
          req.roomCode = roomCodeHeader;
          req.roomKey = { keyId: k.id || k.label, label: k.label };
          return next();
        }
      }
    }
  }

  // 4. Default: If no RELAY_ADMIN_TOKEN is configured on relay server, allow desktop client requests
  if (!adminToken) {
    if (roomCodeHeader) req.roomCode = roomCodeHeader;
    return next();
  }

  return res.status(401).json({ error: "unauthorized", error_description: "Invalid or missing API key." });
}

app.get("/admin/rooms", adminAuth, (req, res) => {
  const targetCode = req.roomCode || req.headers["x-room-code"] || req.query.code;
  const entries = Object.entries(rooms).filter(([code]) => !targetCode || code === targetCode);
  const list = entries.map(([code, room]) => ({
    code,
    clients: (clients.has(code) && clients.get(code).readyState === 1) ? "online" : "offline",
    keys: Array.isArray(room && room.keys)
      ? room.keys.map(k => ({ id: k.id || k.label, label: k.label, scopes: Array.isArray(k.scopes) ? k.scopes : FULL_SCOPES.slice(), createdAt: k.createdAt }))
      : [],
  }));
  res.json({ rooms: list });
});

app.post("/admin/rooms", adminAuth, (req, res) => {
  const { code, label } = req.body || {};
  const roomCode = String(code || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(roomCode)) {
    return res.status(400).json({ error: "invalid_room_code", error_description: "Room codes must be 3–64 chars of letters/digits/._-" });
  }
  if (rooms[roomCode]) {
    return res.status(409).json({ error: "room_exists", error_description: `Room '${roomCode}' already exists.` });
  }
  const { salt, hash } = hashKey(newKeyBytes());
  const ownerId = "owner-" + randomToken(6);
  rooms[roomCode] = {
    code: roomCode,
    label: String(label || "").trim() || roomCode,
    keys: [{ id: ownerId, label: "owner", scopes: FULL_SCOPES.slice(), salt, hash, createdAt: Date.now() }],
    updatedAt: Date.now(),
  };
  saveState();
  res.status(201).json({ room: roomCode, note: "Room created. The room's PC must connect and register its own owner key before use." });
});

app.delete("/admin/rooms/:code", adminAuth, (req, res) => {
  const roomCode = String(req.params.code || "").trim();
  if (!rooms[roomCode]) return res.status(404).json({ error: "room_not_found" });
  if (!req.isAdmin && (req.roomCode !== roomCode || req.roomKey?.label !== "owner")) {
    return res.status(403).json({ error: "forbidden", error_description: "Only the room owner may delete this room." });
  }

  const client = clients.get(roomCode);
  if (client) { try { client.close(1000, "Room identity regenerated"); } catch {} }
  clients.delete(roomCode);
  codeSession.delete(roomCode);
  sessionInit.delete(roomCode);
  delete rooms[roomCode];
  for (const [token, value] of Object.entries(tokens)) {
    if (value && value.code === roomCode) delete tokens[token];
  }
  saveState();
  res.json({ deleted: roomCode });
});

app.post("/admin/keys", adminAuth, (req, res) => {
  const { code, label, scopes } = req.body || {};
  const roomCode = String(code || req.roomCode || "").trim();
  if (!roomCode) return res.status(400).json({ error: "missing_room_code", error_description: "Room code required." });

  let room = rooms[roomCode];
  if (!room) {
    const { salt, hash } = hashKey(newKeyBytes());
    const ownerId = "owner-" + randomToken(6);
    room = {
      code: roomCode,
      label: roomCode,
      keys: [{ id: ownerId, label: "owner", scopes: FULL_SCOPES.slice(), salt, hash, createdAt: Date.now() }],
      updatedAt: Date.now(),
    };
    rooms[roomCode] = room;
  }

  const wantedScopes = normalizeScopes(scopes);
  const granted = wantedScopes.length ? wantedScopes : FULL_SCOPES.slice();

  // Validate every requested scope exists; unknown scopes are rejected.
  const known = new Set(FULL_SCOPES);
  known.add("*");
  for (const s of granted) {
    if (!known.has(s)) {
      return res.status(400).json({ error: "unknown_scope", error_description: `Unknown scope: ${s}` });
    }
  }

  const plaintext = newKeyBytes(24);
  const { salt, hash } = hashKey(plaintext);
  const keyId = "user-" + randomToken(8);
  const key = {
    id: keyId,
    label: String(label || "").trim() || keyId,
    scopes: granted.slice(),
    salt,
    hash,
    createdAt: Date.now(),
  };
  if (!Array.isArray(room.keys)) room.keys = [];
  room.keys.push(key);
  room.updatedAt = Date.now();
  saveState();

  console.log(`[admin] Issued key ${keyId} (${key.label}) for room ${roomCode} with scopes [${granted.join(", ")}]`);
  res.status(201).json({
    room: roomCode,
    key_id: keyId,
    label: key.label,
    scopes: granted.slice(),
    api_key: plaintext,      // shown once; never stored
    mcp_url: `${baseUrl(req)}/mcp/${roomCode}`,
    note: "Store this api_key now. It is the only time it will be shown; only its hash is saved server-side.",
  });
});

app.delete("/admin/keys/:keyId", adminAuth, (req, res) => {
  const keyId = req.params.keyId;
  for (const [roomCode, room] of Object.entries(rooms)) {
    if (!room || !Array.isArray(room.keys)) continue;
    const idx = room.keys.findIndex(k => (k.id || k.label) === keyId);
    if (idx >= 0) {
      room.keys.splice(idx, 1);
      room.updatedAt = Date.now();
      saveState();
      return res.json({ deleted: keyId, room: roomCode });
    }
  }
  return res.status(404).json({ error: "key_not_found", error_description: `No key '${keyId}'.` });
});

// For humans: report per-room key labels + scopes (never hashes/plaintext).
app.get("/admin/health", (req, res) => {
  res.json({
    status: "ok",
    rooms: Object.keys(rooms).length,
    tokens: Object.keys(tokens).length,
    clients_online: Array.from(clients.values()).filter(c => c.readyState === 1).length,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── MCP CATCH-ALL (must come last) ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
function mcpToolNameFromBody(req) {
  try {
    const body = req.body;
    if (body && typeof body === "object") {
      if (body.method === "tools/call" && body.params && typeof body.params.name === "string") {
        return body.params.name;
      }
      // Some clients POST { params: { name } } wrapped
      if (body.params && typeof body.params.name === "string") return body.params.name;
      // Sequential batch (JSON-RPC): check each request
      if (Array.isArray(body)) {
        for (const item of body) {
          if (item && item.method === "tools/call" && item.params && typeof item.params.name === "string") {
            return item.params.name;
          }
        }
      }
    }
  } catch {}
  return null;
}

app.use((req, res) => {
  if (req.path === "/favicon.ico") return res.status(404).end();

  const principal = req.principal;
  let code = principal ? principal.code : getCode(req);
  if (!code) {
    const match = req.path.match(/^\/mcp\/([^/]+)/);
    if (match) code = match[1];
  }
  if (!code && principal) code = principal.code;
  if (!code) {
    // No credential and no room in the path → cannot route multi-user safely. A
    // code-less request must NOT silently hit whichever PC happens to be online.
    return res.status(401).json({
      error: "unauthorized",
      error_description: "No room code and no valid credential provided. Use /mcp/<room-code>/... with a Bearer token.",
    });
  }

  // Enforce per-user key scopes BEFORE forwarding tools/call to the local PC.
  // Applies to per-user keys AND OAuth access tokens with a restricted scope.
  if (principal && principal.scopes) {
    const toolName = mcpToolNameFromBody(req);
    if (toolName && !hasScope(principal.scopes, toolName)) {
      return res.status(403).json({
        jsonrpc: "2.0",
        id: (req.body && req.body.id) != null ? req.body.id : null,
        error: {
          code: -32003,
          message: `Tool "${toolName}" is not allowed for this API key (missing scope ${toolScopeOf(toolName)}).`,
        },
      });
    }
  }

  const ws = code ? clients.get(code) : null;

  if (!ws || ws.readyState !== 1) {
    return res.status(503).json({
      error: "pc_offline",
      error_description: `PC client "${code}" is not online. Start the PC Control MCP app on your computer.`,
    });
  }

  if (req.method === "GET") {
    // Accept the session id from BOTH the mcp-session-id header and the query
    // string. ChatGPT's OpenAI connector (and some streamable-http clients)
    // open their SSE stream with `?mcp-session-id=<id>` instead of a header.
    const sessionId = req.headers["mcp-session-id"]
      || req.query["mcp-session-id"]
      || req.query["sessionId"]
      || req.query["session_id"];
    const accept = (req.headers["accept"] || "").toLowerCase();

    // If client requested an active SSE notification stream with an existing session ID
    if (sessionId && accept.includes("text/event-stream")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // Tag the response object so we can look it up by code when sessionId is missing (ChatGPT fix)
      res._code = code;
      res._sessionId = sessionId;
      sseStreams.set(sessionId, res);
      console.log(`[relay] SSE stream opened: ${sessionId} for ${code}`);

      // Flush any buffered events that arrived before this stream opened (ChatGPT timing race fix)
      // Try both the exact sessionId key and the code-based fallback key
      for (const bufKey of [sessionId, `code:${code}`]) {
        const buffered = sseEventBuf.get(bufKey);
        if (buffered && buffered.length > 0) {
          console.log(`[relay] Flushing ${buffered.length} buffered SSE event(s) [key=${bufKey}] for ${sessionId}`);
          for (const evt of buffered) {
            res.write(`event: ${evt.event}\ndata: ${evt.data}\n\n`);
          }
          sseEventBuf.delete(bufKey);
        }
      }
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": heartbeat\n\n");
      }, 15_000);

      req.on("close", () => {
        clearInterval(heartbeat);
        sseStreams.delete(sessionId);
        try { ws.send(JSON.stringify({ type: "sseClose", sessionId })); } catch {}
        console.log(`[relay] SSE stream closed: ${sessionId}`);
      });

      return;
    }

    // Otherwise forward GET request to local PC
    return forwardToPC(code, req, res);
  }

  if (req.method === "POST" || req.method === "DELETE" || req.method === "PUT" || req.method === "PATCH") {
    return forwardToPC(code, req, res);
  }

  return res.status(405).json({ error: "method_not_allowed" });
});

// ── Start ───────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[relay] Cloud Relay Server on port ${PORT}`);
  console.log(`[relay] Connect PC clients via: wss://host:${PORT}/?code=<name>`);
  console.log(`[relay] AI clients connect via: https://host/mcp/<name>`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("[relay] Shutting down...");
  for (const [, ws] of clients) {
    try { ws.close(); } catch {}
  }
  server.close(() => process.exit(0));
});
