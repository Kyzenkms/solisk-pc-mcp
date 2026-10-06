#!/usr/bin/env node
/**
 * PC Control MCP PRO — Unified Entry Point (Production Grade)
 *
 * Supports:
 *   - stdio:     Claude Desktop, Cursor, Cline, Windsurf (local)
 *   - http:      ChatGPT connectors, Claude.ai integrations, REST API
 *   - both:      stdio + http simultaneously
 *
 * HTTP mode uses the MCP StreamableHTTP transport (the protocol
 * ChatGPT and Claude.ai use for remote MCP connections).
 *
 * CLI usage:
 *   node index.js --mode=stdio   (default)
 *   node index.js --mode=http
 *   node index.js --mode=both
 *   node index.js --mode=http --port=8080
 *
 * Exports: { startHttp, startStdio } — for app.js / Electron / pkg EXE
 */

"use strict";

const crypto = require("crypto");

// Single version source: package.json. The headless server already reports
// this value — one fleet, one version everywhere.
const RUNTIME_VERSION = require("./package.json").version;

// ── stdio mode ─────────────────────────────────────────────────────────────────

async function startStdio() {
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.exit(0);
  });
  const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
  const { registerAllTools } = require("./lib/registry");

  const server = new McpServer({
    name: "pc-control-pro",
    version: RUNTIME_VERSION,
  });

  registerAllTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("info", "PC Control MCP PRO running on stdio");
  setupGracefulShutdown({ close: (cb) => { server.close().then(cb).catch(cb); } }, "stdio-mcp");
}

// ── HTTP mode ───────────────────────────────────────────────────────────────

async function startHttp(port) {
  const express  = require("express");
  const cors     = require("cors");
  const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { registerAllTools, ALL_TOOLS, getToolList } = require("./lib/registry");
  const { apiKeyMiddleware, config, loadConfig } = require("./lib/security");
  const { attachOAuthRoutes } = require("./lib/oauth");
  const {
    log,
    requestIdMiddleware,
    requestLogger,
    rateLimit,
    securityHeaders,
    errorHandler,
    notFoundHandler,
    setupGracefulShutdown: setupShutdown,
  } = require("./lib/middleware");
  const {
    getHealth,
    getMetrics,
    setSessionCount,
    incrementSessionCreated,
  } = require("./lib/metrics");

  const app  = express();
  const PORT = port || config.port || process.env.MCP_PORT || 3000;

  loadConfig();

  // ── Session store ──────────────────────────────────────────────────────────
  const sessions = new Map();
  const SESSION_TTL = 30 * 60 * 1000; // 30 minutes
  const SESSION_IDLE = 10 * 60 * 1000; // idle sessions (dead retries) fall out sooner
  const MAX_SESSIONS = 5; // max concurrent sessions — evict oldest on overflow
  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE;
    for (const [id, s] of sessions) {
      if ((s.lastSeen || 0) < cutoff) {
        try { s.transport.close(); } catch {}
        sessions.delete(id);
        log("info", `Session idle-expired: ${id}`);
      }
    }
  }, 60 * 1000);

  // ── CORS: allow only trusted AI platform origins ──────────────────────────
  // Reflecting any Origin (origin: true) from a public tunnel allows any
  // website to make credentialed cross-origin requests to the MCP server.
  // We whitelist known AI clients + localhost; everything else gets no CORS.
  const ALLOWED_ORIGINS = new Set([
    "https://claude.ai",
    "https://www.claude.ai",
    "https://chat.openai.com",
    "https://chatgpt.com",
    "https://platform.openai.com",
    "https://cursor.sh",
    "https://www.cursor.com",
  ]);

  const corsOptions = {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      try {
        const u = new URL(origin);
        if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
          return cb(null, true);
        }
      } catch {}
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      // Unknown web origin — deny CORS (the request itself still works if
      // the client sends valid auth; this just prevents browser auto-credentialing)
      cb(null, false);
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "mcp-session-id",
      "openai-ephemeral-user-id",
      "openai-conversation-id",
      "x-request-id",
    ],
    exposedHeaders: ["mcp-session-id", "x-request-id"],
    credentials: true,
    maxAge: 86400,
  };
  app.use(cors(corsOptions));

  // Handle OPTIONS preflight for ALL routes
  app.options(/.*/, cors(corsOptions));

  // JSON-RPC/tool arguments should remain bounded; screenshots use binary IPC paths.
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  // ── Production middleware ────────────────────────────────────────────────────
  app.use(requestIdMiddleware);
  app.use(securityHeaders);
  app.use(requestLogger);

  // ── Global rate limit — applied to ALL routes ───────────────────────────────
  // Protects every endpoint (including unauthenticated ones) from brute-force
  // and scanning probes arriving via the Cloudflare tunnel or relay.
  const globalRateLimit = rateLimit({
    windowMs: (config.rate_limit || {}).windowMs || 60_000,
    max: ((config.rate_limit || {}).max || 200) + 100, // slightly above MCP limit
  });
  app.use(globalRateLimit);

  // ── Helper: is the request coming from localhost? ───────────────────────────
  // Requests that arrive through the Cloudflare tunnel or VPS relay will
  // have already had their IP rewritten; we use X-Forwarded-For to detect
  // that the original client is NOT localhost so we can require auth.
  function isLocalRequest(req) {
    const ip = req.ip || req.socket?.remoteAddress || "";
    const forwarded = req.headers["x-forwarded-for"] || "";
    // If there is an x-forwarded-for header we know it passed through a proxy
    // (tunnel/relay) — so it is NOT a direct local request.
    if (forwarded) return false;
    return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.");
  }

  // ── Root info endpoint ─────────────────────────────────────────────────────────
  // Returns minimal public info to unauthenticated callers;
  // full detail (tool count, sessions) requires a valid Bearer token.
  app.get("/", (req, res) => {
    const base = `${req.protocol}://${req.get("host")}`;
    const authed = isLocalRequest(req);
    // Also accept valid Bearer token for full info
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const { checkApiKey } = require("./lib/security");
    const { validateOAuthToken } = require("./lib/oauth");
    const hasValidToken = token && (checkApiKey(token) || validateOAuthToken(token));

    if (authed || hasValidToken) {
      return res.json({
        name: "PC Control MCP PRO",
        version: RUNTIME_VERSION,
        status: "running",
        mcp_endpoint: "/mcp",
        chatgpt_plugin: "/.well-known/ai-plugin.json",
        openapi_spec: "/openapi.json",
        health: "/health",
        metrics: "/metrics",
        oauth_discovery: `${base}/.well-known/oauth-authorization-server`,
        protected_resource: `${base}/.well-known/oauth-protected-resource`,
        tools: ALL_TOOLS.length,
        auth_required: true,
        sessions: sessions.size,
      });
    }
    // Unauthenticated — minimal public info only
    return res.json({
      name: "PC Control MCP PRO",
      auth_required: true,
      oauth_discovery: `${base}/.well-known/oauth-authorization-server`,
      protected_resource: `${base}/.well-known/oauth-protected-resource`,
    });
  });

  // ── Health check — SECURITY FIX: always requires auth ─────────────────────
  // Requests arriving via the Cloudflare tunnel or VPS relay present a loopback
  // source IP (req.ip === 127.0.0.1) because a local proxy forwards them, so
  // loopback-based checks are NOT a safe way to decide whether auth is needed.
  app.get("/health", apiKeyMiddleware, (req, res) => {
    setSessionCount(sessions.size);
    res.json(getHealth());
  });

  // ── Metrics — always requires auth ──────────────────────────────────────────
  app.get("/metrics", apiKeyMiddleware, (req, res) => {
    setSessionCount(sessions.size);
    res.json(getMetrics());
  });

  // ── ChatGPT Plugin Manifest — gated behind auth ──────────────────────────────
  // Gated so scanners cannot enumerate OAuth URLs without credentials.
  // ChatGPT fetches this after the user has configured OAuth.
  app.get("/.well-known/ai-plugin.json", apiKeyMiddleware, (req, res) => {
    const base = `${req.protocol}://${req.get("host")}`;
    res.json({
      schema_version: "v1",
      name_for_model: "pc_control",
      name_for_human: "PC Control PRO",
      description_for_model:
        "Control system tasks like mouse, keyboard, shell, files, screenshots, and screen reading on the host PC. " +
        "Use this to automate tasks, manage files, run scripts, and interact with the desktop.",
      auth: {
        type: "oauth",
        client_url: `${base}/oauth/authorize`,
        scope: "mcp:tools mcp:resources",
        authorization_url: `${base}/oauth/token`,
        authorization_content_type: "application/x-www-form-urlencoded",
        verification_tokens: { openai: "" },
      },
      api: {
        type: "openapi",
        url: `${base}/openapi.json`,
      },
      logo_url: `${base}/logo.png`,
      contact_email: "support@pc-control-mcp.dev",
      legal_info_url: `${base}/legal`,
    });
  });

  // ── OpenAPI 3.1 spec — gated behind auth ───────────────────────────────────────
  // The full tool schema reveals the server's capabilities to anyone who
  // fetches it. Require auth so only authorised clients can see it.
  app.get("/openapi.json", apiKeyMiddleware, (req, res) => {
    const base  = `${req.protocol}://${req.get("host")}`;
    const paths = {};
    const toolList = getToolList();

    for (const tool of toolList) {
      paths[`/tool/${tool.name}`] = {
        post: {
          summary: tool.description,
          operationId: tool.name,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: tool.inputSchema,
              },
            },
          },
          responses: {
            "200": {
              description: "Tool executed successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      data: { type: "object" },
                      error: { type: "string" },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Authentication required",
              content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
            },
            "429": {
              description: "Rate limited",
              content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
            },
          },
          security: [{ ApiKeyAuth: [] }, { OAuth2: ["mcp:tools"] }],
        },
      };
    }

    // Also add the MCP endpoint
    paths["/mcp"] = {
      post: {
        summary: "MCP StreamableHTTP endpoint (JSON-RPC 2.0 over HTTP)",
        operationId: "mcp",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", description: "JSON-RPC 2.0 request" },
            },
          },
        },
        responses: {
          "200": { description: "JSON-RPC response or SSE stream" },
          "401": { description: "Authentication required" },
        },
        security: [{ ApiKeyAuth: [] }, { OAuth2: ["mcp:tools"] }],
      },
      get: {
        summary: "MCP session poll (for SSE notifications)",
        operationId: "mcp_poll",
        responses: { "200": { description: "SSE stream or empty" } },
        security: [{ ApiKeyAuth: [] }, { OAuth2: ["mcp:tools"] }],
      },
    };

    res.json({
      openapi: "3.1.0",
      info: {
        title: "PC Control PRO API",
        description: "Control your PC remotely via MCP, REST, or ChatGPT plugins.",
        version: RUNTIME_VERSION,
      },
      servers: [{ url: base }],
      paths,
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: "http",
            scheme: "bearer",
            description: "Static API key (Bearer token). Get from config.json or setup wizard.",
          },
          OAuth2: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: `${base}/oauth/authorize`,
                tokenUrl: `${base}/oauth/token`,
                refreshUrl: `${base}/oauth/token`,
                scopes: {
                  "mcp:tools": "Execute PC control tools",
                  "mcp:resources": "Access system resources",
                },
              },
            },
          },
        },
      },
      security: [{ ApiKeyAuth: [] }, { OAuth2: ["mcp:tools", "mcp:resources"] }],
    });
  });

  // ── Real OAuth 2.1 server (RFC 8414, 9728, 7591, PKCE) ──────────────────────
  attachOAuthRoutes(app, config);

  // ── Runtime console (additive, read-only, Bearer-gated) ─────────────────────
  try {
    const fs = require("fs");
    const path = require("path");
    if (config.dashboard_enabled === false) {
      log("info", "Dashboard disabled by config");
    } else {
      const candidates = [
        path.join(__dirname, "pc-control-headless", "web"), // dev layout
        path.join(process.resourcesPath || __dirname, "server", "pc-control-headless", "web"), // packaged
      ];
      const dashDir = candidates.find((d) => { try { return fs.existsSync(path.join(d, "index.html")); } catch { return false; } });
      if (!dashDir) {
        log("warn", "Console bundle missing — /dashboard, /tools, /logs unmounted");
      } else {
      // Page shell is public (no data in it); data routes stay Bearer-gated.
      const dashGate = (req, res, next) => {
        if (config.dashboard_enabled === false) return res.status(404).json({ error: "dashboard disabled" });
        next();
      };
      app.use("/dashboard", dashGate, express.static(dashDir, {
        dotfiles: "deny", index: "index.html", maxAge: "1h",
        setHeaders: (res, filePath) => {
          if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
        },
      }));
      app.get("/tools", dashGate, apiKeyMiddleware, (req, res) => {
        let scopeOf = () => "mcp:tools";
        try { scopeOf = require("./lib/scopes").toolScopeOf; } catch {}
        const tools = getToolList().map((t) => ({ name: t.name, scope: scopeOf(t.name) || "mcp:tools" }));
        tools.sort((a, b) => a.name.localeCompare(b.name));
        res.json({ count: tools.length, tools });
      });
      app.get("/logs", dashGate, apiKeyMiddleware, (req, res) => {
        const lines = Math.min(Math.max(parseInt(req.query.lines, 10) || 60, 1), 200);
        try {
          const { auditLogPath } = require("./lib/security");
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
        } catch {
          return res.json({ lines: [] });
        }
      });
      }
    }
  } catch {}

  // ── Rate-limited tool dispatcher (REST API for ChatGPT plugins) ─────────────
  const toolRateLimit = rateLimit({
    windowMs: (config.rate_limit || {}).windowMs || 60_000,
    max: (config.rate_limit || {}).max || 200,
  });

  app.post("/tool/:name", toolRateLimit, apiKeyMiddleware, async (req, res) => {
    const { dispatchTool } = require("./lib/registry");
    const toolName = req.params.name;
    try {
       const result = await dispatchTool(toolName, req.body || {}, req.principal);
      res.json(result);
    } catch (e) {
      const status = e.message.startsWith("Unknown tool") ? 404 : 500;
      res.status(status).json({ success: false, error: e.message });
    }
  });

  // ── Status endpoint — requires auth ─────────────────────────────────────────
  app.get("/status", apiKeyMiddleware, (req, res) => {
    res.json({
      status: "running",
      version: RUNTIME_VERSION,
      mode: "desktop",
      tools: ALL_TOOLS.length,
      sessions: sessions.size,
      uptime_seconds: Math.floor(process.uptime()),
      port: config.port || 3000,
      approval: config.permission_mode || "always",
    });
  });

  // Tailnet exposure for the console. Serve/stop only, owner-only.
  const tailsvc = () => require("./lib/tunnel-service");
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
  const ownerGate = (req, res, next) => {
    const p = req.principal;
    if (p && (p.type === "owner" || (Array.isArray(p.scopes) && p.scopes.includes("*")))) return next();
    return res.status(403).json({ ok: false, error: "owner key required" });
  };
  app.post("/tailscale/serve", apiKeyMiddleware, ownerGate, (req, res) => {
    const r = tailsvc().tailscaleServe(config.port || 3000, false);
    res.json({ ...r, state: tailsState() });
  });
  app.post("/tailscale/off", apiKeyMiddleware, ownerGate, (req, res) => {
    tailsvc().tailscaleOff();
    res.json({ ok: true, state: tailsState() });
  });

  // Full desktop GUI in the browser: same renderer, HTTP shim, no Electron.
  try {
    const { mountWebBridge } = require("./lib/web-bridge");
    const domain = (config.relay_domain || "mcp.solisk.org").replace(/^https?:\/\//, "");
    mountWebBridge(app, {
      apiKeyMiddleware,
      loadConfig: () => { loadConfig(); return config; },
      saveConfig: (next) => { require("./lib/config-repair").writeConfigAtomic(process.env.MCP_CONFIG_PATH, next); },
      getStatusData: async () => ({
        running: true, starting: false,
        tunnelUrl: null,
        relayUrl: config.relay_enabled === false || !config.name ? null : `https://${domain}/mcp/${config.name}`,
        relayError: null,
        toolCount: ALL_TOOLS.length, sessionCount: sessions.size, serverPort: PORT,
        relayOn: config.relay_enabled !== false,
        relayRetryCount: 0, maxRelayRetries: 10, isInternetOffline: false,
        tunnelSvc: (() => { try { return require("./lib/tunnel-service").getState(); } catch { return null; } })(),
      }),
    });
  } catch (err) {
    log("info", "Web bridge (/app) not mounted: " + (err.message || err));
  }

  // ── MCP Streamable HTTP endpoint (the main entry for ChatGPT/Claude.ai) ──────
  const mcpRateLimit = rateLimit({
    windowMs: (config.rate_limit || {}).windowMs || 60_000,
    max: ((config.rate_limit || {}).max || 200) * 2, // MCP is chattier
  });

  app.all("/mcp", mcpRateLimit, apiKeyMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    // Existing session — route to it
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — only on POST (initialize request)
    if (req.method === "GET" && !sessionId) {
      // ChatGPT / Claude may send a GET to check if the endpoint exists
      return res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Bad request: POST required for new session" },
      });
    }

    // A transport session may only be created by initialize. Previously every
    // POST with a missing/stale session ID fell through here, so ordinary
    // stateless tool calls each inflated the active-session count.
    if (req.method !== "POST" || !req.body || req.body.method !== "initialize") {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Server not initialized: send initialize before other MCP requests" },
        id: req.body && req.body.id !== undefined ? req.body.id : null,
      });
    }

    // Create new session
    const server = new McpServer({
      name: "pc-control-pro",
      version: RUNTIME_VERSION,
    });

    registerAllTools(server, req.principal);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `sess_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, created: Date.now(), lastSeen: Date.now() });
        incrementSessionCreated();
        log("info", `New MCP session: ${id} (total: ${sessions.size})`);

        // Evict oldest session if over cap
        if (sessions.size > MAX_SESSIONS) {
          const oldest = [...sessions.entries()].sort((a, b) => a[1].created - b[1].created)[0];
          if (oldest) {
            const [oldId, oldS] = oldest;
            try { oldS.transport.close(); } catch {}
            sessions.delete(oldId);
            log("info", `Session evicted (cap): ${oldId}`);
          }
        }

        // Auto-expire after TTL
        setTimeout(() => {
          if (sessions.has(id)) {
            const s = sessions.get(id);
            try { s.transport.close(); } catch {}
            sessions.delete(id);
            log("info", `Session expired: ${id}`);
          }
        }, SESSION_TTL);
      },
    });

    transport.onclose = () => {
      for (const [id, s] of sessions.entries()) {
        if (s.transport === transport) {
          sessions.delete(id);
          log("info", `Session closed: ${id}`);
          break;
        }
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // ── Legacy SSE endpoint (backwards compat for old clients) ─────────────────
  app.get("/sse", apiKeyMiddleware, async (req, res) => {
    // For old SSE-based clients, redirect them to /mcp
    res.redirect(308, "/mcp");
  });

  // ── Error handlers (must be last) ───────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  // ── Start server ─────────────────────────────────────────────────────────────
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, () => {
      log("info", `PC Control MCP PRO on port ${PORT} — ${ALL_TOOLS.length} tools`, {
        port: PORT,
        tools: ALL_TOOLS.length,
        auth: true,
      });

      console.error(`\n${"═".repeat(58)}`);
      console.error(`  PC Control MCP  v${require("./package.json").version}`);
      console.error(`  ${ALL_TOOLS.length} tools loaded`);
      console.error(`  ${"═".repeat(54)}`);
      console.error(`  MCP endpoint:  http://localhost:${PORT}/mcp`);
      console.error(`  ChatGPT:       http://localhost:${PORT}/.well-known/ai-plugin.json`);
      console.error(`  OAuth:         http://localhost:${PORT}/.well-known/oauth-authorization-server`);
      console.error(`  Health:        http://localhost:${PORT}/health`);
      console.error(`  ${"═".repeat(54)}\n`);

      startMetricsReporter();
      try {
        require("./lib/config-service").watch(process.env.MCP_CONFIG_PATH, () => {
          log("info", "Config changed externally — toggles apply immediately");
        });
      } catch {}
      resolve({ app, port: PORT, sessions, server });
    });

    server.once("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        err.message = `Port ${PORT} is already in use. Stop the other instance or choose a different port (--port=N or config.port).`;
      } else if (err && err.code === "EACCES") {
        err.message = `Permission denied binding port ${PORT}.`;
      }
      reject(err);
    });

    setupShutdown(server, "http-server");
  });
}

// ── CLI entry ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  // Parse mode
  let mode = "stdio";
  const modeArg = args.find(a => a.startsWith("--mode"));
  if (modeArg) {
    mode = modeArg.startsWith("--mode=") ? modeArg.split("=")[1] : (args[args.indexOf(modeArg) + 1] || "stdio");
  }

  // Parse port
  let port = undefined;
  const portArg = args.find(a => a.startsWith("--port"));
  if (portArg) {
    port = portArg.startsWith("--port=") ? parseInt(portArg.split("=")[1]) : parseInt(args[args.indexOf(portArg) + 1]);
  }

  (async () => {
    if (mode === "stdio" || mode === "both") await startStdio();
    if (mode === "http"  || mode === "both") await startHttp(port);
  })().catch(err => {
    log("error", "FATAL", { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

// ── Parent metrics reporter ──────────────────────────────────────────────────────
// When spawned by the desktop app over an IPC channel, report this process's
// real memory and CPU usage so the Health tab can show runtime load. No-op in
// stdio / CLI usage where process.send does not exist.
function startMetricsReporter() {
  if (typeof process.send !== "function") return;
  let lastCpu = process.cpuUsage();
  let lastAt = Date.now();
  const timer = setInterval(() => {
    if (typeof process.send !== "function") { clearInterval(timer); return; }
    const now = Date.now();
    const delta = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const elapsedMs = Math.max(1, now - lastAt);
    lastAt = now;
    const cpuPct = ((delta.user + delta.system) / 1000) / elapsedMs * 100;
    try {
      process.send({
        type: "metrics",
        memBytes: process.memoryUsage().rss,
        cpuPct: Math.round(cpuPct * 10) / 10,
      });
    } catch { clearInterval(timer); }
  }, 3000);
  if (timer.unref) timer.unref();
}

module.exports = { startHttp, startStdio };
