const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { log } = require("./middleware");
const configRepair = require("./config-repair");

// Determine the config path: environment variable takes precedence
let configPath = process.env.MCP_CONFIG_PATH || path.join(__dirname, "..", "config.json");
let config = {};

let lastSig = null;   // "mtimeMs:size" of the file as last loaded
let lastResult = null;

function fileSignature() {
  try {
    const st = fs.statSync(configPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function loadConfig() {
  // Hot path (auth, path checks): skip the read + validate when the file is unchanged.
  const sig = fileSignature();
  if (sig && sig === lastSig && lastResult) return lastResult;

  // Recovers from a corrupt or truncated config by falling back to the most
  // recent good backup before giving up and generating fresh credentials.
  const result = configRepair.loadConfigSafe(configPath);

  if (result.corruptBackup) {
    log("error", "config.json was unreadable — a copy was preserved", { copy: result.corruptBackup });
  }
  if (result.recovered) {
    log("warn", "Restored config from the last good backup");
  }
  if (result.repaired.length > 0) {
    log("warn", "Repaired invalid config fields", { fields: result.repaired });
  }

  // Mutate existing object in place so references in other modules remain valid
  for (const key in config) {
    delete config[key];
  }
  Object.assign(config, result.config);

  // Only cache a clean load of a real file; anything repaired/generated is
  // persisted by the caller, which changes the signature and reloads once.
  const clean = result.source === "file" && result.repaired.length === 0 && !result.recovered;
  lastSig = clean ? sig : null;
  lastResult = clean ? result : null;

  return result;
}

const loadResult = loadConfig();

// Persist anything that was generated or repaired during load.
if (loadResult.source !== "file" || loadResult.repaired.length > 0) {
  try {
    configRepair.writeConfigAtomic(configPath, config);
    log("info", "Saved updated config with generated keys");
  } catch (e) {
    log("error", "Failed to save updated config", { error: e.message });
  }
}

// Ensure logs directory exists in the same folder as the config
const logsDir = path.join(path.dirname(configPath), "logs");
try {
  fs.mkdirSync(logsDir, { recursive: true });
} catch (e) {
  log("error", "Failed to create logs directory", { error: e.message });
}

const auditLogPath = path.join(logsDir, "audit.log");

/**
 * Log a tool execution event to the append-only audit log.
 */
function rotateIfBig(filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath);
    if (st.size > maxBytes) fs.renameSync(filePath, filePath + ".1");
  } catch {}
}

function logAudit(toolName, params, success, errorOrResult) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    tool: toolName,
    params,
    success,
    result: success ? "SUCCESS" : "FAILED",
    details: success ? (errorOrResult ? "Data returned" : "No data") : String(errorOrResult)
  };
  try {
    rotateIfBig(auditLogPath, 5 * 1024 * 1024);
    fs.appendFileSync(auditLogPath, JSON.stringify(entry) + "\n");
  } catch (e) {
    log("error", "Failed to write to audit log", { error: e.message });
  }
}

/**
 * Check an API key against config using constant-time comparison.
 * Returns true if key matches config.api_key
 */
function checkApiKey(key) {
  return Boolean(resolveApiKey(key));
}

function resolveApiKey(key) {
  loadConfig();
  if (!key) return null;
  const cleanKey = String(key).trim();

  // Check Master API Key
  if (config.api_key && config.api_key !== "none") {
    const cleanConfigKey = String(config.api_key).trim();
    if (cleanKey.length === cleanConfigKey.length) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(cleanKey), Buffer.from(cleanConfigKey))) {
          return { type: "owner", keyId: "owner", label: "owner", scopes: ["*"], tokenId: cleanKey };
        }
      } catch {}
    }
  }

  // Check Scope-Only User Keys
  if (Array.isArray(config.user_keys)) {
    for (const uk of config.user_keys) {
      const ukKey = String(uk.api_key || uk.key || "").trim();
      if (ukKey && cleanKey.length === ukKey.length) {
        try {
          if (crypto.timingSafeEqual(Buffer.from(cleanKey), Buffer.from(ukKey))) {
            return {
              type: "key",
              keyId: uk.id || uk.label,
              label: uk.label || uk.id,
              scopes: Array.isArray(uk.scopes) ? uk.scopes.slice() : [],
              tokenId: cleanKey,
            };
          }
        } catch {}
      }
    }
  }

  return null;
}

/**
 * Check if a given file path is allowed based on the config
 */
function checkPath(filePath) {
  loadConfig();
  const canonicalize = (input) => {
    const resolved = path.resolve(input);
    let existing = resolved;
    const tail = [];
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(existing) : fs.realpathSync(existing);
      return path.resolve(real, ...tail);
    } catch {
      return resolved;
    }
  };
  const isWithin = (candidate, root) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
  };
  const resolved = canonicalize(filePath);

  // Check denied paths first
  if (config.denied_paths && Array.isArray(config.denied_paths)) {
    for (const denied of config.denied_paths) {
      if (isWithin(resolved.toLowerCase(), canonicalize(denied).toLowerCase())) {
        return { allowed: false, reason: `Path is in denied list: ${denied}` };
      }
    }
  }

  // Check allowed paths
  if (config.allowed_paths && Array.isArray(config.allowed_paths) && config.allowed_paths.length > 0) {
    const allowed = config.allowed_paths.some((ap) =>
      isWithin(resolved.toLowerCase(), canonicalize(ap).toLowerCase())
    );
    if (!allowed) {
      return { allowed: false, reason: `Path not in allowed_paths list` };
    }
  }

  return { allowed: true };
}

/**
 * Middleware for Express: validates Bearer token.
 * Accepts BOTH static api_key AND real OAuth access tokens (from oauth.js).
 * On failure returns 401 with WWW-Authenticate pointing at the OAuth discovery
 * endpoint so MCP clients (Claude, etc.) can auto-discover and authenticate.
 */
function apiKeyMiddleware(req, res, next) {
  loadConfig();

  // SECURITY FIX: Never bypass auth based on source IP/hostname. Requests can
  // arrive via Cloudflare tunnel or the VPS relay where the socket is a loopback
  // connection from a local proxy, so req.ip / req.hostname are NOT trustworthy.
  // Only OAuth discovery + consent endpoints are exempt (they are unauthenticated
  // by design per RFC 8414/9728). Everything else (tools, /mcp, health, status,
  // metrics, openapi) requires a valid Bearer token.
  const pathLower = (req.path || req.originalUrl || "").toLowerCase();
  if (
    pathLower.includes("/.well-known/oauth-") ||
    pathLower.includes("/.well-known/openid-configuration") ||
    pathLower.includes("/oauth/authorize") ||
    pathLower.includes("/oauth/register") ||
    pathLower.includes("/oauth/token") ||
    pathLower.includes("/oauth/revoke") ||
    pathLower.includes("/.well-known/jwks.json")
  ) {
    return next();
  }

  if (!config.api_key || config.api_key === "none") {
    return res.status(503).json({
      error: "server_misconfigured",
      error_description: "Server API key is not configured. Please restart the server to generate a secure key.",
    });
  }

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();

  // 1. Accept static API key
  const apiPrincipal = token ? resolveApiKey(token) : null;
  if (apiPrincipal) {
    req.principal = apiPrincipal;
    return next();
  }

  // 2. Accept real OAuth access token
  const { validateOAuthToken } = require("./oauth");
  if (token && validateOAuthToken(token)) {
    req.principal = { type: "oauth", keyId: "oauth", label: "oauth", scopes: ["*"], tokenId: token };
    return next();
  }

  // 3. Accept remembered-device cookie (web console "remember this device").
  // Owner-equivalent: the cookie is only ever issued after owner-key auth.
  try {
    const dev = require("./devices");
    const cookies = dev.parseCookies(req);
    const hit = dev.verifyDevice(cookies[dev.COOKIE_NAME]);
    if (hit) {
      req.principal = { type: "owner", keyId: "device:" + hit.id, label: hit.label || "remembered device", scopes: ["*"], tokenId: "device:" + hit.id };
      return next();
    }
  } catch {}

  log("warn", "Auth failed for request", {
    path: req.originalUrl || req.path,
    method: req.method,
    hasAuthHeader: !!authHeader,
  });

  // 4. Reject — include WWW-Authenticate so MCP clients discover OAuth
  const host   = req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";
  // Only advertise http for genuinely local hosts: OAuth clients reject
  // plaintext metadata URLs, and a proxy may omit X-Forwarded-Proto.
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto  = forwardedProto || (req.secure ? "https" : (isLocal ? "http" : "https"));
  let prefix   = req.headers["x-forwarded-prefix"] || req.headers["x-mcp-prefix"] || "";
  if (!prefix && req.originalUrl) {
    const match = req.originalUrl.match(/^(\/mcp\/[^/]+)/);
    if (match) prefix = match[1];
  }
  let base = `${proto}://${host}`;
  if (prefix) base += prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;

  res.set(
    "WWW-Authenticate",
    `Bearer realm="pc-control-mcp", resource_metadata="${base}/.well-known/oauth-protected-resource"`
  );
  return res.status(401).json({
    error:             "unauthorized",
    error_description: "Bearer token required. Use OAuth 2.1 or supply your API key.",
    oauth_discovery:   `${base}/.well-known/oauth-authorization-server`,
  });
}

module.exports = { checkApiKey, resolveApiKey, checkPath, apiKeyMiddleware, logAudit, config, auditLogPath, loadConfig };
