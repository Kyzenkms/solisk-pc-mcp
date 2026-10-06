"use strict";

/**
 * web-bridge.js — the desktop renderer running in a browser.
 *
 * Serves desktop-app/renderer unchanged plus an injected shim that
 * implements window.mcp over HTTP (Bearer). Same screens, same flows;
 * only the transport differs (IPC vs fetch). Owner-only routes use
 * ownerGate; the shim never receives secrets it didn't already hold.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const crypto = require("crypto");

function ownerGate(req, res, next) {
  const p = req.principal;
  if (p && (p.type === "owner" || (Array.isArray(p.scopes) && p.scopes.includes("*")))) return next();
  return res.status(403).json({ ok: false, error: "owner key required" });
}

function rendererDir() {
  const here = __dirname;
  const candidates = [
    path.join(here, "..", "desktop-app", "renderer"),
    path.join(here, "desktop-app", "renderer"),
    path.join(here, "..", "..", "desktop-app", "renderer"),
  ];
  for (const d of candidates) {
    try { if (fs.existsSync(path.join(d, "index.html"))) return d; } catch {}
  }
  return null;
}

function shimSource() {
  return fs.readFileSync(path.join(__dirname, "..", "pc-control-headless", "web", "bridge.js"), "utf8");
}

function mountWebBridge(app, deps) {
  const { apiKeyMiddleware, loadConfig, saveConfig, getStatusData } = deps;
  const { bus, EVENTS } = require("./events");

  const sendShim = (req, res) => {
    try {
      if (loadConfig().dashboard_enabled === false) return res.status(404).json({ ok: false, error: "dashboard disabled" });
      res.type("application/javascript").send(shimSource());
    }
    catch { res.status(404).end(); }
  };
  app.get("/api/bridge.js", sendShim);
  app.get("/app/bridge.js", sendShim);

  const dashGate = (req, res, next) => {
    try {
      if (loadConfig().dashboard_enabled === false) return res.status(404).json({ ok: false, error: "dashboard disabled" });
    } catch {}
    next();
  };

  const rdir = rendererDir();
  if (!rdir) return { ok: false, error: "renderer not found" };

  const inject = (req, res, next) => {
    try {
      let html = fs.readFileSync(path.join(rdir, "index.html"), "utf8");
      if (!html.includes('<script src="app.js">')) {
        return res.status(500).json({ ok: false, error: "renderer changed shape — bridge needs update" });
      }
      html = html.replace(
        '<script src="app.js">',
        '<script src="/app/bridge.js"></script><script src="app.js"></script>'
      );
      if (html.includes("<head>")) {
        html = html.replace("<head>", '<head><base href="/app/">');
      }
      res.type("text/html").send(html);
    } catch { next(); }
  };
  app.get("/app", dashGate, inject);
  app.get("/app/", dashGate, inject);
  app.get("/app/index.html", dashGate, inject);
  app.use("/app", dashGate, express.static(rdir, {
    dotfiles: "deny", index: false, maxAge: "1h",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".js") || filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
    },
  }));

  app.get("/api/status", apiKeyMiddleware, async (req, res) => {
    try { res.json(await getStatusData()); }
    catch (err) { res.status(500).json({ ok: false, error: String((err && err.message) || err) }); }
  });

  app.get("/api/health", apiKeyMiddleware, async (req, res) => {
    try {
      const { getMetrics } = require("./metrics");
      const m = getMetrics();
      let liveSessions = null;
      try { liveSessions = (await getStatusData()).sessionCount; } catch {}
      if (typeof liveSessions === "number") {
        try { require("./metrics").setSessionCount(liveSessions); } catch {}
      }
      let relay = { connected: false, url: null, error: null, retries: 0 };
      try {
        const rs = require("./relay-client").getRelayState();
        relay = {
          connected: rs.state === "connected",
          url: rs.state === "connected" && rs.room && rs.domain ? `https://${rs.domain}/mcp/${rs.room}` : null,
          error: rs.state === "paused" ? "retries paused — hit Retry" : rs.state === "offline" ? "no internet" : null,
          retries: rs.attempt || 0,
        };
      } catch {}
      let tunnel = { url: null, active: false };
      try {
        const ts = svc().getState();
        tunnel = { url: ts.url || null, active: ts.kind !== "off" };
      } catch {}
      const tools = Object.entries((m.tools && m.tools.by_name) || {})
        .map(([name, v]) => ({ name, ok: v.success || 0, err: v.failure || 0, total: v.calls || 0 }))
        .sort((a, b) => b.total - a.total).slice(0, 12);
      res.json({
        startedAt: Date.now() - (m.uptime_seconds || 0) * 1000,
        uptimeMs: (m.uptime_seconds || 0) * 1000,
        serverUptimeMs: (m.uptime_seconds || 0) * 1000,
        running: true, ready: true, internet: relay.state !== "offline",
        relay, tunnel,
        toolCount: m.tools ? Object.keys(m.tools.by_name || {}).length : 0,
        sessionCount: typeof liveSessions === "number" ? liveSessions : ((m.sessions && m.sessions.active) || 0),
        totalReq: (m.requests && m.requests.total) || 0,
        totalErr: ((m.requests && m.requests.by_status && m.requests.by_status["5xx"]) || 0) + (m.tools ? m.tools.failure_count : 0),
        buckets: [], tools, errors: [],
        weekly: m.weekly || null,
      });
    } catch { res.status(500).json({ ok: false }); }
  });

  app.get("/api/config", apiKeyMiddleware, ownerGate, (req, res) => {
    const cfg = loadConfig();
    const { api_key, previous_api_key, oauth_client_secret, tunnel_token, ...safe } = cfg;
    res.json({ ok: true, config: safe, has_key: !!api_key });
  });

  app.post("/api/config", apiKeyMiddleware, ownerGate, express.json({ limit: "256kb" }), (req, res) => {
    const prev = loadConfig();
    const incoming = (req.body && req.body.config) || req.body || {};
    const next = { ...prev, ...incoming };
    delete next.api_key; delete next.previous_api_key;
    delete next.oauth_client_secret; delete next.tunnel_token;
    const { validateConfig, writeConfigAtomic } = require("./config-repair");
    const { valid, problems } = validateConfig(next);
    if (!valid) return res.status(400).json({ ok: false, error: problems.join("; ") });
    const configPath = process.env.MCP_CONFIG_PATH;
    writeConfigAtomic(configPath, next);
    bus.emitState(EVENTS.CONFIG_CHANGED, { path: configPath });
    if (typeof saveConfig === "function") { try { saveConfig(next); } catch {} }
    res.json({ ok: true });
  });

  app.get("/api/logs", apiKeyMiddleware, (req, res) => {
    const lines = Math.min(Math.max(parseInt(req.query.lines, 10) || 200, 1), 500);
    try {
      const { auditLogPath } = require("./security");
      const st = fs.statSync(auditLogPath);
      const tailBytes = Math.min(st.size, 512 * 1024);
      const fd = fs.openSync(auditLogPath, "r");
      const buf = Buffer.alloc(tailBytes || 1);
      if (tailBytes) fs.readSync(fd, buf, 0, tailBytes, st.size - tailBytes);
      fs.closeSync(fd);
      const out = buf.toString("utf8").split("\n").filter((l) => l.trim()).slice(-lines).map((l, i) => {
        let e = null;
        try { e = JSON.parse(l); } catch {}
        return {
          id: "web_" + i + "_" + (e && e.timestamp ? String(e.timestamp).slice(-8) : i),
          time: e && e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : "",
          msg: e ? (e.message || l).slice(0, 500) : l.slice(0, 500),
          type: e && e.level === "error" ? "error" : e && e.level === "warn" ? "warn" : "info",
          category: (e && e.category) || "SYSTEM",
        };
      });
      return res.json({ ok: true, logs: out });
    } catch { return res.json({ ok: true, logs: [] }); }
  });

  app.post("/api/logs-clear", apiKeyMiddleware, ownerGate, (req, res) => {
    try {
      const { auditLogPath } = require("./security");
      fs.writeFileSync(auditLogPath, "");
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false }); }
  });

  app.get("/api/keys", apiKeyMiddleware, ownerGate, (req, res) => {
    const cfg = loadConfig();
    const keys = Array.isArray(cfg.user_keys) ? cfg.user_keys : [];
    res.json({ ok: true, keys: keys.map(({ api_key, key, ...item }) => item), online: "unknown" });
  });

  app.post("/api/keys", apiKeyMiddleware, ownerGate, express.json({ limit: "64kb" }), (req, res) => {
    const cfg = loadConfig();
    const label = ((req.body && req.body.label) || "").trim() || ("key-" + crypto.randomBytes(3).toString("hex"));
    const scopes = (req.body && req.body.scopes) || [];
    const good = scopes.filter((s) => s === "mcp:tools" || s === "mcp:resources");
    const userKeys = Array.isArray(cfg.user_keys) ? cfg.user_keys : [];
    if (userKeys.length >= 5) return res.status(400).json({ ok: false, error: "Maximum of 5 keys. Revoke one first." });
    const entry = { id: "user-" + crypto.randomBytes(4).toString("hex"), label, scopes: good, api_key: crypto.randomBytes(24).toString("hex"), createdAt: Date.now() };
    userKeys.push(entry);
    persistKeys(userKeys);
    bus.emitState(EVENTS.KEYS_CHANGED, { action: "add" });
    res.json({ ok: true, key: entry });
  });

  app.delete("/api/keys/:id", apiKeyMiddleware, ownerGate, (req, res) => {
    const cfg = loadConfig();
    const userKeys = Array.isArray(cfg.user_keys) ? cfg.user_keys : [];
    const filtered = userKeys.filter((k) => k.id !== req.params.id && k.label !== req.params.id);
    if (filtered.length === userKeys.length) return res.status(404).json({ ok: false, error: "not found" });
    persistKeys(filtered);
    bus.emitState(EVENTS.KEYS_CHANGED, { action: "revoke" });
    res.json({ ok: true });
  });

  function persistKeys(userKeys) {
    const cfg = loadConfig();
    const next = { ...cfg, user_keys: userKeys };
    const { writeConfigAtomic } = require("./config-repair");
    writeConfigAtomic(process.env.MCP_CONFIG_PATH, next);
    if (typeof saveConfig === "function") { try { saveConfig(next); } catch {} }
    bus.emitState(EVENTS.CONFIG_CHANGED, { path: process.env.MCP_CONFIG_PATH });
  }

  app.post("/api/regen-url", apiKeyMiddleware, ownerGate, async (req, res) => {
    const cfg = loadConfig();
    const baseName = String(cfg.name || "pc").replace(/-[a-f0-9]{8}$/, "").replace(/-+$/, "").slice(0, 39) || "pc";
    const deviceId = crypto.randomBytes(4).toString("hex");
    const next = { ...cfg, name: `${baseName}-${deviceId}`, device_id: deviceId };
    if (cfg.relay_enabled !== false && cfg.name) {
      try {
        const domain = (cfg.relay_domain || "mcp.solisk.org").replace(/^https?:\/\//, "");
        const r = await fetch(`https://${domain}/admin/rooms/${encodeURIComponent(cfg.name)}`, {
          method: "DELETE",
          headers: { authorization: "Bearer " + cfg.api_key, "X-Room-Code": cfg.name },
          signal: AbortSignal.timeout(10000),
        });
        if (r.status !== 200 && r.status !== 404) {
          return res.status(502).json({ ok: false, error: `Previous URL could not be revoked (HTTP ${r.status}).` });
        }
      } catch {
        return res.status(502).json({ ok: false, error: "Relay unreachable — previous URL not revoked." });
      }
    }
    const { writeConfigAtomic } = require("./config-repair");
    writeConfigAtomic(process.env.MCP_CONFIG_PATH, next);
    if (typeof saveConfig === "function") { try { saveConfig(next); } catch {} }
    const domain = next.relay_domain || "mcp.solisk.org";
    res.json({ ok: true, name: next.name, url: `https://${domain}/mcp/${next.name}` });
  });

  app.post("/api/relay-retry", apiKeyMiddleware, ownerGate, (req, res) => {
    try {
      const ok = require("./relay-client").retryRelay();
      res.json({ ok, relay: require("./relay-client").getRelayState() });
    } catch { res.json({ ok: false }); }
  });

  // Relay on/off. Persists relay_enabled; in processes that own the relay
  // connection (headless server) it stops/starts the client live. The desktop
  // Electron shell owns its own relay socket — it handles this via IPC instead.
  app.post("/api/relay-set", apiKeyMiddleware, ownerGate, express.json({ limit: "16kb" }), (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    const cfg = loadConfig();
    const next = { ...cfg, relay_enabled: enabled };
    require("./config-repair").writeConfigAtomic(process.env.MCP_CONFIG_PATH, next);
    if (typeof saveConfig === "function") { try { saveConfig(next); } catch {} }
    try {
      const rc = require("./relay-client");
      if (enabled) {
        if (rc.hasRelay()) rc.retryRelay();
        else if (typeof deps.relayStart === "function") deps.relayStart(next);
      } else {
        rc.stopRelay();
      }
    } catch {}
    res.json({ ok: true, enabled });
  });

  const svc = () => require("./tunnel-service");

  app.get("/api/tunnel", apiKeyMiddleware, (req, res) => {
    const cfg = loadConfig();
    const ts = svc().tailscaleStatus();
    const st = svc().getState();
    if (st.kind === "tailscale" && st.url) ts.url = st.url;
    res.json({
      ok: true, mode: cfg.tunnel_mode || "quick", hostname: cfg.tunnel_hostname || "",
      hasToken: !!(cfg.tunnel_token && cfg.tunnel_token.length > 20),
      state: st, cfInstalled: svc().cloudflaredInstalled(), loginDone: svc().loginDone(),
      tailscale: ts, dashboard: cfg.dashboard_enabled !== false,
    });
  });

  app.post("/api/tunnel-mode", apiKeyMiddleware, ownerGate, express.json({ limit: "16kb" }), (req, res) => {
    const mode = req.body && req.body.mode;
    if (!["off", "quick", "custom"].includes(mode)) return res.status(400).json({ ok: false });
    const cfg = loadConfig();
    if (mode === "custom" && (!cfg.tunnel_token || !cfg.tunnel_hostname)) {
      return res.status(400).json({ ok: false, error: "custom needs token + hostname — run the wizard first" });
    }
    const next = { ...cfg, tunnel_mode: mode };
    require("./config-repair").writeConfigAtomic(process.env.MCP_CONFIG_PATH, next);
    if (typeof saveConfig === "function") { try { saveConfig(next); } catch {} }
    res.json({ ok: true, restart: true });
  });

  app.post("/api/tunnel-install", apiKeyMiddleware, ownerGate, (req, res) => {
    res.json(svc().installCloudflared());
  });

  app.post("/api/tunnel-login", apiKeyMiddleware, ownerGate, (req, res) => {
    const bin = svc().resolveCloudflared();
    if (!bin) return res.status(400).json({ ok: false, error: "cloudflared not found" });
    const { spawn } = require("child_process");
    const proc = spawn(bin, ["login"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let sent = false;
    const done = (url) => {
      if (sent) return;
      sent = true;
      res.json({ ok: true, url: url || null });
    };
    const timer = setTimeout(() => { try { proc.kill(); } catch {} done(null); }, 60000);
    const onData = (d) => {
      out += String(d);
      const m = out.match(/https:\/\/[^\s"']+/);
      if (m && /cloudflare\.com|localhost|127\.0\.0\.1/.test(m[0])) { clearTimeout(timer); done(m[0]); }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("close", () => { clearTimeout(timer); done(null); });
  });

  app.post("/api/tunnel-create", apiKeyMiddleware, ownerGate, express.json({ limit: "16kb" }), (req, res) => {
    const bin = svc().resolveCloudflared();
    if (!bin) return res.status(400).json({ ok: false, error: "cloudflared not found" });
    const clean = String((req.body && req.body.name) || "pc-control").toLowerCase();
    const r = svc().createNamedTunnel(bin, clean);
    if (!r.ok) return res.status(400).json({ ok: false, error: "tunnel create failed" });
    const cfg = loadConfig();
    const next = { ...cfg, tunnel_name: r.name || clean };
    require("./config-repair").writeConfigAtomic(process.env.MCP_CONFIG_PATH, next);
    if (typeof saveConfig === "function") { try { saveConfig(next); } catch {} }
    res.json({ ok: true, name: r.name || clean, reused: !!r.reused });
  });

  app.post("/api/tunnel-route", apiKeyMiddleware, ownerGate, express.json({ limit: "16kb" }), (req, res) => {
    const cfg = loadConfig();
    const bin = svc().resolveCloudflared();
    if (!bin) return res.status(400).json({ ok: false, error: "cloudflared not found" });
    const hostname = String((req.body && req.body.hostname) || "").toLowerCase();
    if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(hostname) || hostname.includes("..")) {
      return res.status(400).json({ ok: false, error: "bare hostname only" });
    }
    const name = cfg.tunnel_name || "pc-control";
    const routed = svc().routeDns(bin, name, hostname);
    if (!routed.ok) return res.status(502).json({ ok: false, error: "DNS route failed" });
    const tok = svc().fetchToken(bin, name);
    if (!tok.ok) return res.status(502).json({ ok: false, error: "token fetch failed" });
    const next = { ...cfg, tunnel_hostname: hostname, tunnel_token: tok.token };
    require("./config-repair").writeConfigAtomic(process.env.MCP_CONFIG_PATH, next);
    if (typeof saveConfig === "function") { try { saveConfig(next); } catch {} }
    res.json({ ok: true, hostname });
  });

  app.post("/api/tunnel-forget", apiKeyMiddleware, ownerGate, (req, res) => {
    const cfg = loadConfig();
    const next = { ...cfg, tunnel_token: "", tunnel_hostname: "", tunnel_mode: "quick" };
    require("./config-repair").writeConfigAtomic(process.env.MCP_CONFIG_PATH, next);
    if (typeof saveConfig === "function") { try { saveConfig(next); } catch {} }
    res.json({ ok: true });
  });

  app.post("/api/tailscale-serve", apiKeyMiddleware, ownerGate, express.json({ limit: "16kb" }), (req, res) => {
    const port = Number((req.body && req.body.port) || 3000) || 3000;
    const r = svc().tailscaleServe(port, false);
    res.json(r);
  });

  app.post("/api/tailscale-off", apiKeyMiddleware, ownerGate, (req, res) => {
    svc().tailscaleOff();
    res.json({ ok: true });
  });

  app.post("/api/dash-set", apiKeyMiddleware, ownerGate, express.json({ limit: "16kb" }), (req, res) => {
    const cfg = loadConfig();
    const next = { ...cfg, dashboard_enabled: !!(req.body && req.body.enabled) };
    require("./config-repair").writeConfigAtomic(process.env.MCP_CONFIG_PATH, next);
    if (typeof saveConfig === "function") { try { saveConfig(next); } catch {} }
    res.json({ ok: true });
  });

  app.post("/api/server-start", apiKeyMiddleware, ownerGate, (req, res) => {
    res.json({ ok: true, already: true });
  });
  app.post("/api/server-stop", apiKeyMiddleware, ownerGate, (req, res) => {
    res.status(403).json({ ok: false, error: "stopping the runtime from a browser is disabled — do it on the machine" });
  });

  // ── Remembered devices ──────────────────────────────────────────────
  const devices = require("./devices");

  function deviceCookie(res, req, token) {
    const parts = [`${devices.COOKIE_NAME}=${token}`, "Path=/", `Max-Age=${Math.floor(devices.TTL_MS / 1000)}`, "HttpOnly", "SameSite=Lax"];
    const proto = String((req.headers && req.headers["x-forwarded-proto"]) || "").split(",")[0].trim();
    if (req.secure || proto === "https") parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  // Owner-only: mint a device token for THIS browser (sets the cookie).
  app.post("/api/device-remember", apiKeyMiddleware, ownerGate, express.json({ limit: "16kb" }), (req, res) => {
    if (!req.principal || req.principal.type !== "owner" || String(req.principal.keyId || "").startsWith("device:")) {
      return res.status(403).json({ ok: false, error: "owner key required — a remembered device cannot remember itself" });
    }
    const label = String((req.body && req.body.label) || req.headers["user-agent"] || "browser").slice(0, 80);
    const { token, id } = devices.issueDevice(label);
    deviceCookie(res, req, token);
    res.json({ ok: true, id });
  });

  app.get("/api/devices", apiKeyMiddleware, ownerGate, (req, res) => {
    res.json({ ok: true, devices: devices.listDevices() });
  });

  app.delete("/api/devices/:id", apiKeyMiddleware, ownerGate, (req, res) => {
    if (!devices.revokeDevice(req.params.id)) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true });
  });

  // Forget this browser: revoke the cookie's own device + clear the cookie.
  app.post("/api/device-forget", apiKeyMiddleware, (req, res) => {
    const cookies = devices.parseCookies(req);
    const hit = devices.verifyDevice(cookies[devices.COOKIE_NAME]);
    if (hit) devices.revokeDevice(hit.id);
    res.setHeader("Set-Cookie", `${devices.COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    res.json({ ok: true });
  });

  return { ok: true };
}

module.exports = { mountWebBridge, rendererDir };
