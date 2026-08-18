const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { log } = require("./middleware");

// Determine the config path: environment variable takes precedence
let configPath = process.env.MCP_CONFIG_PATH || path.join(__dirname, "..", "config.json");
let config = {};

function loadConfig() {
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      // Mutate existing object in place so references in other modules remain valid
      for (const key in config) {
        delete config[key];
      }
      Object.assign(config, parsed);
    } catch (e) {
      log("error", "Failed to parse config.json", { error: e.message });
    }
  }
}

loadConfig();

// Enforce an API key (security audit item): auto-generate if missing or insecure
let configUpdated = false;
if (!config.api_key || config.api_key === "none") {
  config.api_key = crypto.randomBytes(24).toString("hex");
  configUpdated = true;
  log("warn", "api_key was missing or disabled — generated a new secure key. Update your MCP client configuration.");
}
if (config.name === undefined) {
  config.name = "pc-" + crypto.randomBytes(4).toString("hex");
  configUpdated = true;
}
if (config.oauth_client_id === undefined) {
  config.oauth_client_id = "client_" + crypto.randomBytes(8).toString("hex");
  configUpdated = true;
}
if (config.oauth_client_secret === undefined) {
  config.oauth_client_secret = "secret_" + crypto.randomBytes(16).toString("hex");
  configUpdated = true;
}

// Default rate limiting config
if (config.rate_limit === undefined) {
  config.rate_limit = { windowMs: 60_000, max: 200 };
  configUpdated = true;
}

if (configUpdated) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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
  loadConfig();
  if (!key) return false;
  const cleanKey = String(key).trim();

  // Check Master API Key
  if (config.api_key && config.api_key !== "none") {
    const cleanConfigKey = String(config.api_key).trim();
    if (cleanKey.length === cleanConfigKey.length) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(cleanKey), Buffer.from(cleanConfigKey))) {
          return true;
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
            return true;
          }
        } catch {}
      }
    }
  }

  return false;
}

/**
 * Check if a given file path is allowed based on the config
 */
function checkPath(filePath) {
  loadConfig();
  const resolved = path.resolve(filePath);

  // Check denied paths first
  if (config.denied_paths && Array.isArray(config.denied_paths)) {
    for (const denied of config.denied_paths) {
      if (resolved.toLowerCase().startsWith(path.resolve(denied).toLowerCase())) {
        return { allowed: false, reason: `Path is in denied list: ${denied}` };
      }
    }
  }

  // Check allowed paths
  if (config.allowed_paths && Array.isArray(config.allowed_paths) && config.allowed_paths.length > 0) {
    const allowed = config.allowed_paths.some((ap) =>
      resolved.toLowerCase().startsWith(path.resolve(ap).toLowerCase())
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
  if (token && checkApiKey(token)) return next();

  // 2. Accept real OAuth access token
  const { validateOAuthToken } = require("./oauth");
  if (token && validateOAuthToken(token)) return next();

  log("warn", "Auth failed for request", {
    path: req.originalUrl || req.path,
    method: req.method,
    headers: req.headers,
    hasAuthHeader: !!authHeader,
    authHeaderPrefix: authHeader.slice(0, 15),
    tokenLength: token.length,
    configApiKeyLength: config.api_key ? config.api_key.length : 0,
    checkApiKeyResult: token ? checkApiKey(token) : false,
  });

  // 3. Reject — include WWW-Authenticate so MCP clients discover OAuth
  const host   = req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";
  const proto  = req.headers["x-forwarded-proto"] || req.protocol || "https";
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

module.exports = { checkApiKey, checkPath, apiKeyMiddleware, logAudit, config, auditLogPath, loadConfig };
