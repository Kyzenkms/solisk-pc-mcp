"use strict";

/**
 * server.js — lean StreamableHTTP server for the headless CLI build.
 *
 * Reuses the shared, audited libs (registry, security, middleware, metrics,
 * oauth) without modifying them. Differences from the desktop HTTP path:
 *   - Binds HOST explicitly (default 127.0.0.1 — never 0.0.0.0 by default).
 *   - Registers the headless shell_exec tool on every session.
 *   - No CORS reflection: headless API clients are non-browser (Claude,
 *     ChatGPT, Cursor server-to-server). Browser origins get no ACAO header.
 */

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { registerAllTools, getToolList } = require("../lib/registry");
const { apiKeyMiddleware, config, loadConfig } = require("../lib/security");
const { attachOAuthRoutes } = require("../lib/oauth");
const {
  log,
  requestIdMiddleware,
  requestLogger,
  rateLimit,
  securityHeaders,
  errorHandler,
  notFoundHandler,
  setupGracefulShutdown,
} = require("../lib/middleware");
const { getHealth, getMetrics, setSessionCount, incrementSessionCreated } = require("../lib/metrics");
const { registerCliExtra, registerMacTools, PLATFORM_EXTRA_NAMES } = require("./tools");

const SESSION_TTL = 30 * 60 * 1000;
const MAX_SESSIONS = 5;

async function startHeadlessHttp({ port, host, version, noRelay }) {
  loadConfig();
  const app = express();
  const PORT = port || config.port || 3000;
  const HOST = host || "127.0.0.1";

  const sessions = new Map();
  const SESSION_IDLE = 10 * 60 * 1000; // idle sessions (dead retries) fall out sooner
  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE;
    for (const [id, s] of sessions) {
      if ((s.lastSeen || 0) < cutoff) {
        try { s.transport.close(); } catch {}
        sessions.delete(id);
      }
    }
  }, 60 * 1000);

  app.use(requestIdMiddleware);
  app.use(securityHeaders);
  app.use(requestLogger);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use(rateLimit({
    windowMs: (config.rate_limit || {}).windowMs || 60_000,
    max: ((config.rate_limit || {}).max || 200) + 100,
  }));

  attachOAuthRoutes(app, config);

  app.get("/", (req, res) => {
    res.json({ name: "pc-control-headless", version, status: "running", mcp_endpoint: "/mcp", auth_required: true });
  });

  app.get("/health", apiKeyMiddleware, (req, res) => {
    setSessionCount(sessions.size);
    res.json({ ...getHealth(), mode: "headless" });
  });

  app.get("/status", apiKeyMiddleware, (req, res) => {
    setSessionCount(sessions.size);
    let relay = { state: "idle" };
    try { relay = require("../lib/relay-client").getRelayState(); } catch {}
    res.json({
      status: "running",
      version,
      mode: "headless",
      tools: getToolList().length + PLATFORM_EXTRA_NAMES.length, // + shell_exec / macOS tools
      sessions: sessions.size,
      uptime_seconds: Math.floor(process.uptime()),
      port: PORT,
      approval: config.permission_mode || "always",
      relay,
    });
  });

  // Relay retry + tailnet exposure: owner-only. A scoped client key must
  // never retry infrastructure or expose the tailnet.
  const ownerGate = (req, res, next) => {
    const p = req.principal;
    if (p && (p.type === "owner" || (Array.isArray(p.scopes) && p.scopes.includes("*")))) return next();
    return res.status(403).json({ ok: false, error: "owner key required" });
  };
  app.post("/relay/retry", apiKeyMiddleware, ownerGate, (req, res) => {
    let ok = false;
    try { ok = require("../lib/relay-client").retryRelay(); } catch {}
    let relay = { state: "idle" };
    try { relay = require("../lib/relay-client").getRelayState(); } catch {}
    res.json({ retried: ok, relay });
  });

  // Full desktop GUI in the browser: same renderer, HTTP shim, no Electron.
  try {
    const { mountWebBridge } = require("../lib/web-bridge");
    mountWebBridge(app, {
      apiKeyMiddleware,
      loadConfig: () => { loadConfig(); return config; },
      relayStart: (next) => dialRelay(PORT, next && next.relay_enabled === false),
      getStatusData: async () => {
        let relay = { state: "idle" };
        try { relay = require("../lib/relay-client").getRelayState(); } catch {}
        setSessionCount(sessions.size);
        const relayUrl = relay.state === "connected" && relay.room && relay.domain
          ? `https://${relay.domain}/mcp/${relay.room}` : null;
        return {
          running: true, starting: false,
          tunnelUrl: null, relayUrl, relayError: null,
          toolCount: getToolList().length + PLATFORM_EXTRA_NAMES.length,
          sessionCount: sessions.size, serverPort: PORT,
          relayOn: config.relay_enabled !== false,
          relayRetryCount: 0, maxRelayRetries: 10, isInternetOffline: false,
          tunnelSvc: (() => { try { return require("../lib/tunnel-service").getState(); } catch { return null; } })(),
          relayState: relay,
        };
      },
    });
  } catch (err) {
    log("warn", "Web bridge (/app) not mounted: " + (err.message || err));
  }

  // Tailnet exposure for the console. Serve/stop only — funnel (public)
  // stays a deliberate local action (CLI --yes / GUI confirm).
  const tailsvc = () => require("../lib/tunnel-service");
  const tailsState = () => {
    try {
      const st = tailsvc().tailscaleStatus();
      const svc = tailsvc().getState();
      if (svc.kind === "tailscale" && svc.url) st.url = svc.url;
      return st;
    } catch { return { ok: false, loggedIn: false }; }
  };
  app.get("/tailscale", apiKeyMiddleware, (req, res) => res.json(tailsState()));
  app.get("/tunnel", apiKeyMiddleware, (req, res) => {
    try { return res.json(tailsvc().getState()); }
    catch { return res.json({ kind: "off" }); }
  });
  app.post("/tailscale/serve", apiKeyMiddleware, ownerGate, (req, res) => {
    const r = tailsvc().tailscaleServe(PORT, false);
    res.json({ ...r, state: tailsState() });
  });
  app.post("/tailscale/off", apiKeyMiddleware, ownerGate, (req, res) => {
    tailsvc().tailscaleOff();
    res.json({ ok: true, state: tailsState() });
  });

  app.get("/metrics", apiKeyMiddleware, (req, res) => {
    setSessionCount(sessions.size);
    res.json(getMetrics());
  });

  // ── Runtime console (static bundle in web/) ────────────────────────────────
  // Live toggle: the gate reads the shared config object, which the file
  // watcher refreshes in place — flipping the switch stops serving now.
  const dashGate = (req, res, next) => {
    if (config.dashboard_enabled === false) return res.status(404).json({ error: "dashboard disabled" });
    next();
  };
  if (config.dashboard_enabled === false) {
    log("info", "Dashboard disabled by config");
  } else {
  // Page shell is public (it holds no data); every data route stays Bearer-gated.
  // Gating the HTML too made a fresh browser unusable (no way to enter the key).
  app.use("/dashboard", dashGate, express.static(path.join(__dirname, "web"), {
    dotfiles: "deny",
    index: "index.html",
    maxAge: "1h",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
    },
  }));

  // Tool inventory for the console (name + required scope).
  app.get("/tools", dashGate, apiKeyMiddleware, (req, res) => {
    let scopeOf = () => "mcp:tools";
    try { scopeOf = require("../lib/scopes").toolScopeOf; } catch {}
    const tools = getToolList().map((t) => ({ name: t.name, scope: scopeOf(t.name) || "mcp:tools" }));
    for (const n of PLATFORM_EXTRA_NAMES) tools.push({ name: n, scope: scopeOf(n) || "mcp:tools" });
    tools.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ count: tools.length, tools });
  });

  // Audit-log tail for the console. Read-only, capped.
  app.get("/logs", dashGate, apiKeyMiddleware, (req, res) => {
    const lines = Math.min(Math.max(parseInt(req.query.lines, 10) || 60, 1), 200);
    try {
      const { auditLogPath } = require("../lib/security");
      const st = fs.statSync(auditLogPath);
      const tailBytes = Math.min(st.size, 1024 * 1024);
      const fd = fs.openSync(auditLogPath, "r");
      const buf = Buffer.alloc(tailBytes);
      fs.readSync(fd, buf, 0, tailBytes, st.size - tailBytes);
      fs.closeSync(fd);
      const out = buf.toString("utf8").split("\n")
        .map((l) => l.slice(0, 500))
        .filter((l) => l.trim())
        .slice(-lines);
      return res.json({ lines: out });
    } catch (err) {
      return res.json({ lines: [] });
    }
  });
  }

  const mcpRateLimit = rateLimit({
    windowMs: (config.rate_limit || {}).windowMs || 60_000,
    max: ((config.rate_limit || {}).max || 200) * 2,
  });

  app.all("/mcp", mcpRateLimit, apiKeyMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method === "GET" && !sessionId) {
      return res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Bad request: POST required for new session" },
      });
    }
    if (req.method !== "POST" || !req.body || req.body.method !== "initialize") {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Server not initialized: send initialize before other MCP requests" },
        id: req.body && req.body.id !== undefined ? req.body.id : null,
      });
    }

    const server = new McpServer({ name: "pc-control-headless", version });
    registerAllTools(server, req.principal);
    registerCliExtra(server, req.principal);
    registerMacTools(server, req.principal);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `sess_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, created: Date.now(), lastSeen: Date.now() });
        incrementSessionCreated();
        log("info", `New MCP session: ${id} (total: ${sessions.size})`);
        if (sessions.size > MAX_SESSIONS) {
          const oldest = [...sessions.entries()].sort((a, b) => a[1].created - b[1].created)[0];
          if (oldest) {
            try { oldest[1].transport.close(); } catch {}
            sessions.delete(oldest[0]);
          }
        }
        setTimeout(() => {
          if (sessions.has(id)) {
            try { sessions.get(id).transport.close(); } catch {}
            sessions.delete(id);
          }
        }, SESSION_TTL);
      },
    });

    transport.onclose = () => {
      for (const [id, s] of sessions.entries()) {
        if (s.transport === transport) { sessions.delete(id); break; }
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return new Promise((resolve) => {
    const httpServer = app.listen(PORT, HOST, () => {
      const count = getToolList().length + PLATFORM_EXTRA_NAMES.length;
      log("info", `pc-control-headless on ${HOST}:${PORT} — ${count} tools`);
      console.error(`pc-control-headless v${version} — http://${HOST}:${PORT}/mcp (${count} tools)`);
      try {
        const { bus, EVENTS } = require("../lib/events");
        bus.emitState(EVENTS.RUNTIME_UP, { host: HOST, port: PORT, tools: count });
        try {
          require("../lib/config-service").watch(process.env.MCP_CONFIG_PATH, () => {
            log("info", "Config changed externally — new connections use updated values (restart for full apply)");
          });
        } catch {}
      } catch {}
      dialRelay(PORT, noRelay);
      setupGracefulShutdown(httpServer, "headless-http");
      resolve(httpServer);
    });
  });
}

module.exports = { startHeadlessHttp };

// Outbound only. Never throws — a dead relay must not kill the server.
function dialRelay(PORT, noRelay) {
  if (noRelay || config.relay_enabled === false) {
    console.error("relay: off — direct-only (tailscale/proxy is your inbound)");
    return;
  }
  if (!config.name) {
    console.error("relay: no `name` set — direct-only (set one to join the hosted relay)");
    return;
  }
  try {
    const domain = config.relay_domain || "mcp.solisk.org";
    const { startRelayClient } = require("../lib/relay-client");
    startRelayClient({ ...config, relay_url: `https://${domain}`, port: PORT });
    console.error(`relay: dialing wss://${domain} (room ${config.name})`);
  } catch (err) {
    console.error(`relay: disabled (${err && err.message ? err.message : err})`);
  }
}
