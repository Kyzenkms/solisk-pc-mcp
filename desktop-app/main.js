const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, clipboard, session } = require("electron");
const path   = require("path");
const fs     = require("fs");

// ── Single Instance Lock ──────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.moveTop(); }
});

// Fix invisible frameless window on Windows with GPU issues
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");
const { spawn, execSync } = require("child_process");

// ── Paths ─────────────────────────────────────────────────────────────────────
const isDev      = !app.isPackaged || process.argv.includes("--dev");
const SERVER_DIR = isDev
  ? path.join(__dirname, "..")
  : path.join(process.resourcesPath, "server");
const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");

// Config durability helpers live with the server so both share one implementation.
const configRepair = require(path.join(SERVER_DIR, "lib", "config-repair.js"));

// The app was previously packaged under a different name, which gave it a
// different userData directory. Adopt that config once so an upgrade does not
// look like a factory reset (new API key, lost relay settings, lost mode).
const LEGACY_USER_DATA_DIRS = ["pc-control-mcp-desktop"];

function migrateLegacyConfig() {
  if (fs.existsSync(CONFIG_FILE)) return;

  const parent = path.dirname(app.getPath("userData"));
  for (const dirName of LEGACY_USER_DATA_DIRS) {
    const legacy = path.join(parent, dirName, "config.json");
    if (legacy === CONFIG_FILE || !fs.existsSync(legacy)) continue;

    try {
      const parsed = JSON.parse(fs.readFileSync(legacy, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      configRepair.writeConfigAtomic(CONFIG_FILE, parsed);
      addLog(`Imported existing settings from ${dirName}`, "info");
      return;
    } catch {
      // Unreadable legacy config: fall through and start fresh.
    }
  }
}


// ── State ─────────────────────────────────────────────────────────────────────
let win          = null;
let tray         = null;
let serverProc   = null;
let tunnelProc   = null;
let tunnelGeneration = 0;
let relayWs      = null;
let serverPort   = 3000;
let tunnelUrl    = null;
let relayUrl     = null;
let relayError   = null;
let relayGeneration = 0;
let relayRetryCount = 0;
const MAX_RELAY_RETRIES = 10;
let isInternetOffline = false;
let isRunning    = false;
let toolCount    = 0;
let sessionCount = 0;
let activeSessions = new Set();
let logLines     = [];
let runtimeReady = false;

const dns = require("dns");
function checkInternetAvailability() {
  return new Promise((resolve) => {
    dns.lookup("1.1.1.1", (err) => {
      if (err) {
        dns.lookup("mcp.solisk.org", (err2) => {
          resolve(!err2);
        });
      } else {
        resolve(true);
      }
    });
  });
}

function loadConfig() {
  try {
    // Adopt a previous install's config before deciding we have none.
    migrateLegacyConfig();

    const rootConfig = path.join(__dirname, "..", "config.json");
    let rootCfg = {};
    if (fs.existsSync(rootConfig)) {
      try { rootCfg = JSON.parse(fs.readFileSync(rootConfig, "utf8")); } catch {}
    }
    if (fs.existsSync(CONFIG_FILE)) {
      // Recovers from a corrupt or truncated file by falling back to the most
      // recent good backup, so a bad write cannot cost the user their API key.
      const result = configRepair.loadConfigSafe(CONFIG_FILE);

      if (result.corruptBackup) {
        addLog(`Config was unreadable — a copy was saved to ${result.corruptBackup}`, "error");
      }
      if (result.recovered) {
        addLog("Config restored from the last good backup", "warn");
      }
      if (result.repaired.length > 0) {
        addLog(`Repaired config fields: ${result.repaired.join(", ")}`, "warn");
        if (result.repaired.includes("api_key")) {
          addLog("A new API key was generated — update your AI clients", "error");
        }
      }
      // Persist repairs so the fixed config survives a restart.
      if (result.recovered || result.repaired.length > 0) {
        try { configRepair.writeConfigAtomic(CONFIG_FILE, result.config); } catch {}
      }

      // The userData config is authoritative at runtime. The packaged/root
      // config is only the initial seed; mixing its API key back in causes the
      // relay to authenticate with a different key than the child MCP server.
      return { ...rootCfg, ...result.config };
    }
    if (Object.keys(rootCfg).length > 0) {
      saveConfig(rootCfg);
      return rootCfg;
    }
    return {};
  } catch (e) {
    addLog(`Config could not be loaded: ${e.message}`, "error");
    return {};
  }
}
function saveConfig(c) {
  // Atomic write with a rolling backup, so an interrupted save cannot leave a
  // truncated config behind.
  configRepair.writeConfigAtomic(CONFIG_FILE, c);
}

function addLog(msg, type = "info", meta = null) {
  let category = (meta && meta.category) ? meta.category : null;
  if (!category) {
    const text = String(msg);
    if (meta && meta.tool) category = "TOOL";
    else if (text.includes("Tool") || text.includes("tool") || text.includes("run_command") || text.includes("read_file") || text.includes("write_file") || text.includes("execute")) category = "TOOL";
    else if (text.includes("Internet") || text.includes("internet") || text.includes("offline") || text.includes("DNS") || text.includes("Network")) category = "NET";
    else if (text.includes("Relay") || text.includes("relay") || text.includes("WebSocket") || text.includes("Connected") || text.includes("disconnected") || text.includes("tunnel") || text.includes("session")) category = "CONN";
    else if (text.includes("Key") || text.includes("key") || text.includes("Auth") || text.includes("auth") || text.includes("Permission") || text.includes("Rate limit")) category = "SECURITY";
    else if (type === "error") category = "ERROR";
    else category = "SYSTEM";
  }

  const entry = {
    id: "log_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    time: new Date().toLocaleTimeString(),
    msg: String(msg),
    type,
    category,
    ...(meta || {})
  };
  logLines.unshift(entry);
  if (logLines.length > 500) logLines.pop();
  try {
    fs.appendFileSync(
      path.join(app.getPath("userData"), "main.log"),
      JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {}
  if (win && !win.isDestroyed()) {
    try { win.webContents.send("log", entry); } catch {}
  }
}

function getStatus() {
  return { running: isRunning && runtimeReady, starting: isRunning && !runtimeReady, tunnelUrl, relayUrl, relayError, toolCount, sessionCount, serverPort, relayRetryCount, maxRelayRetries: MAX_RELAY_RETRIES, isInternetOffline };
}

function sendStatus() {
  const payload = getStatus();
  if (win && !win.isDestroyed()) {
    try { win.webContents.send("status", payload); } catch {}
  }
  if (tray) {
    tray.setToolTip(isRunning
      ? `PC Control MCP — ${tunnelUrl || relayUrl ? "LIVE" : "Starting..."}`
      : "PC Control MCP — Stopped");
  }
}

// ── Server ────────────────────────────────────────────────────────────────────
function startServer(cfg) {
  if (serverProc) { addLog("Start ignored: MCP server is already running", "warn"); return; }
  serverPort = cfg.port || 3000;
  runtimeReady = false;
  let serverScript = path.join(process.resourcesPath, "server", "index.js");
  if (!fs.existsSync(serverScript)) {
    serverScript = path.join(__dirname, "index.js");
  }
  if (!fs.existsSync(serverScript)) {
    serverScript = path.join(__dirname, "..", "index.js");
  }
  // NOTE: never resolve to process.resourcesPath/app.asar/index.js — the child
  // node process cannot read inside the asar archive (MODULE_NOT_FOUND). Always
  // prefer the unpacked server copy under resources/server.
  if (!fs.existsSync(serverScript)) {
    addLog(`Server script not found: ${serverScript}`, "error"); return;
  }
  const binary = (function() {
    try { require("child_process").execSync("node -v"); return "node"; } catch {}
    return isDev ? "node" : process.execPath;
  })();
  const spawnEnv = {
    ...process.env,
    MCP_PORT: String(serverPort),
    MCP_CONFIG_PATH: CONFIG_FILE,
    ...(binary === "node" ? {} : { ELECTRON_RUN_AS_NODE: "1" })
  };

  const proc = spawn(binary, [serverScript, "--mode=http"], {
    env: spawnEnv,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  serverProc = proc;
  addLog(`Runtime process launched (PID ${serverProc.pid || "pending"})`, "info", { method: "SPAWN", path: serverScript });
  serverProc.on("message", (msg) => {
    if (msg.type === "shell_approval_req") {
      if (win && !win.isDestroyed()) {
        win.webContents.send("shell-approval-req", msg);
      } else {
        serverProc.send({ type: "shell_approval_res", id: msg.id, approved: false });
      }
    }
  });
  const onData = (d) => {
    const t = d.toString().trim(); if (!t) return;
    const m = t.match(/(\d+) tools/); if (m) { toolCount = parseInt(m[1]); sendStatus(); }
    
    const newSess = t.match(/New MCP session: (sess_[^\s]+)/);
    if (newSess) {
      activeSessions.add(newSess[1]);
      sessionCount = activeSessions.size;
      sendStatus();
    }

    const closedSess = t.match(/Session (?:closed|expired): (sess_[^\s]+)/);
    if (closedSess) {
      activeSessions.delete(closedSess[1]);
      sessionCount = activeSessions.size;
      sendStatus();
    }

    // The server emits structured JSON log lines; parse them so the Logs page
    // can render real detail (level, tool, duration, HTTP status) instead of a
    // raw JSON blob.
    let type = "info", msg = t, meta = null;
    try {
      const j = JSON.parse(t);
      if (j && typeof j === "object" && j.message && j.timestamp) {
        type = j.level || "info";
        msg = j.message;
        meta = {
          tool: j.tool,
          success: j.success,
          duration_ms: j.duration_ms,
          method: j.method,
          path: j.path,
          status: j.status,
          error: j.error,
        };
      }
    } catch {}

    addLog(msg, type, meta);
  };
  serverProc.stdout.on("data", onData);
  serverProc.stderr.on("data", onData);
  proc.on("close", () => {
    if (serverProc !== proc) return;
    const previousSessions = activeSessions.size;
    serverProc = null;
    isRunning = false;
    runtimeReady = false;
    tunnelUrl = null;
    relayUrl = null;
    sessionCount = 0;
    activeSessions.clear();
    addLog(`MCP server stopped${previousSessions ? `; closed ${previousSessions} active session${previousSessions === 1 ? "" : "s"}` : ""}`, "warn");
    sendStatus();
  });
  proc.on("error", (e) => {
    if (serverProc !== proc) return;
    isRunning = false;
    runtimeReady = false;
    addLog(`Server error: ${e.message}`, "error");
    sendStatus();
  });
  addLog(`Starting MCP server on port ${serverPort}...`,"info");
  isRunning = true; sendStatus();
}

function waitForRuntime(cfg, timeoutMs = 15000) {
  const http = require("http");
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const probe = () => {
      if (!serverProc || Date.now() >= deadline) return resolve(false);
      const req = http.get({
        hostname: "127.0.0.1",
        port: cfg.port || serverPort || 3000,
        path: "/health",
        headers: { Authorization: `Bearer ${cfg.api_key || ""}` },
      }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          runtimeReady = true;
          addLog("MCP runtime health check passed", "success");
          sendStatus();
          return resolve(true);
        }
        setTimeout(probe, 250);
      });
      req.setTimeout(1000, () => req.destroy());
      req.on("error", () => setTimeout(probe, 250));
    };
    probe();
  });
}

function stopServer() {
  addLog("Stopping runtime, tunnel, and relay...", "info");
  if (serverProc) { try { serverProc.kill(); } catch {} serverProc = null; }
  stopTunnel();
  stopRelay();
  isRunning = false; tunnelUrl = null; relayUrl = null; sessionCount = 0;
  runtimeReady = false;
  activeSessions.clear();
  sendStatus(); addLog("Server stopped","warn");
}

function startTunnel(cfg) {
  if (tunnelProc) { addLog("Tunnel start ignored: process already active", "warn"); return; }
  const generation = ++tunnelGeneration;
  addLog("Starting Cloudflare tunnel...", "info");
  const doStart = () => {
    if (!isRunning || generation !== tunnelGeneration) return;
    const proc = spawn("C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", ["tunnel", "--url", `http://localhost:${serverPort}`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    tunnelProc = proc;
    addLog(`Cloudflare process launched (PID ${tunnelProc.pid || "pending"})`, "info");
      const onData = (data) => {
        if (generation !== tunnelGeneration || tunnelProc !== proc) return;
        const t = data.toString();
      const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && m[0] !== tunnelUrl) {
        tunnelUrl = m[0];
        addLog(`Tunnel LIVE: ${tunnelUrl}/mcp`, "success");
        sendStatus();
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (e) => {
      if (generation === tunnelGeneration && tunnelProc === proc) addLog(`Tunnel error: ${e.message}`, "error");
    });
    proc.on("close", () => {
      if (generation !== tunnelGeneration || tunnelProc !== proc) return;
      tunnelProc = null;
      if (isRunning) {
        addLog("Tunnel dropped — reconnecting in 5s...", "warn");
        tunnelUrl = null;
        sendStatus();
        setTimeout(() => { if (isRunning) doStart(); }, 5000);
      }
    });
  };
  setTimeout(doStart, 2000);
}

function stopTunnel() {
  tunnelGeneration++;
  if (tunnelProc) { try { tunnelProc.kill(); } catch {} tunnelProc = null; }
}

// ── VPS Relay ─────────────────────────────────────────────────────────────────
function startRelay(cfg) {
  if (relayWs) { addLog("Relay connection already active", "warn"); return; }
  if (cfg.relay_enabled === false) { addLog("Relay disabled — local-only mode", "info"); return; }
  const name = cfg.name;
  if (!name) { addLog("No name set — relay skipped", "warn"); return; }

  const WebSocket = (() => {
    try { return require("ws"); } catch {}
    try { return require(path.join(process.resourcesPath || __dirname, "server", "node_modules", "ws")); } catch {}
    try { return require(path.join(__dirname, "..", "node_modules", "ws")); } catch {}
    return null;
  })();
  if (!WebSocket) { addLog("ws module not found — relay skipped", "warn"); return; }

  const domain = cfg.relay_domain || "mcp.solisk.org";
  const RELAY_WS = `wss://${domain}?code=${encodeURIComponent(name)}`;
  const generation = ++relayGeneration;
  relayError = null;
  addLog("Connecting to secure VPS relay...", "info");

  const scheduleRelayReconnect = () => {
    if (generation !== relayGeneration || !isRunning) return;
    if (relayRetryCount >= MAX_RELAY_RETRIES) {
      relayError = `Max reconnection attempts reached (${MAX_RELAY_RETRIES}/${MAX_RELAY_RETRIES}). Automatic retries paused. Click 'Retry Connection' to reconnect.`;
      addLog(relayError, "warn", { category: "NET", maxRetries: true });
      sendStatus();
      return;
    }
    relayRetryCount++;
    const backoffMs = Math.min(2000 * Math.pow(1.4, relayRetryCount - 1), 30000);
    addLog(`Reconnecting to VPS relay in ${Math.round(backoffMs / 1000)}s (attempt ${relayRetryCount}/${MAX_RELAY_RETRIES})...`, "info", { category: "CONN", attempt: relayRetryCount });
    setTimeout(connect, backoffMs);
  };

  const connect = async () => {
    if (!isRunning || generation !== relayGeneration) return;

    // Check internet connectivity first
    const online = await checkInternetAvailability();
    if (!online) {
      if (!isInternetOffline) {
        isInternetOffline = true;
        addLog("Internet connection offline — relay reconnection paused", "error", { category: "NET", offline: true });
      }
      relayError = "Internet connection offline";
      sendStatus();
      scheduleRelayReconnect();
      return;
    }

    if (isInternetOffline) {
      isInternetOffline = false;
      addLog("Internet connection restored", "success", { category: "NET", online: true });
    }

    addLog(`Connecting to VPS relay at wss://${domain}?code=${encodeURIComponent(name)} (attempt ${relayRetryCount + 1}/${MAX_RELAY_RETRIES})...`, "info", { category: "CONN" });
    const ws = new WebSocket(RELAY_WS);
    relayWs = ws;

    ws.on("open", () => {
      if (generation !== relayGeneration || relayWs !== ws) {
        try { ws.close(); } catch {}
        return;
      }
      relayUrl = `https://${domain}/mcp/${name}`;
      relayError = null;
      relayRetryCount = 0; // reset counter on successful connection!
      isInternetOffline = false;
      addLog(`VPS Relay LIVE: ${relayUrl}`, "success", { category: "CONN" });
      addLog(`Relay socket authenticated for workspace "${name}"`, "success", { category: "CONN" });
      sendStatus();

      // Keep-alive ping interval every 15s to keep WebSocket connection active
      const pingInterval = setInterval(() => {
        if (ws.readyState === 1) {
          try { ws.ping(); } catch {}
        } else {
          clearInterval(pingInterval);
        }
      }, 15000);

      ws.pingTimer = pingInterval;

      // Register room & active API key on VPS Relay once manifests are ready
      const http = require("http");
      const port = cfg.port || serverPort || 3000;
      const fetchJson = (path) => new Promise(resolve => {
        http.get({
          hostname: "localhost", port, path,
          headers: { "Authorization": `Bearer ${cfg.api_key}` }
        }, (res) => {
          let body = "";
          res.on("data", c => body += c);
          res.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
        }).on("error", () => resolve(null));
      });

      Promise.all([
        fetchJson("/.well-known/ai-plugin.json"),
        fetchJson("/openapi.json")
      ]).then(([manifest, openapi]) => {
        if (generation === relayGeneration && relayWs === ws && ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({
              type: "init",
              code: name,
              apiKey: cfg.api_key,
              userKeys: Array.isArray(cfg.user_keys) ? cfg.user_keys : [],
              manifest: manifest || undefined,
              openapi: openapi || undefined
            }));
            addLog("Room initialized on VPS Relay.", "success", { category: "CONN" });
          } catch (e) {
            addLog(`Relay init error: ${e.message}`, "warn", { category: "CONN" });
          }
        }
      });
    });

    ws.on("message", async (data) => {
      if (generation !== relayGeneration || relayWs !== ws) return;
      try {
        const msg = JSON.parse(data);
        if (msg.type !== "request") return;
        const { requestId, sessionId, payload } = msg;
        const rpcMethod = payload?.body?.method;
        const toolName = rpcMethod === "tools/call" ? payload?.body?.params?.name : null;
        addLog(
          toolName ? `Remote tool request: ${toolName}` : `Relay request: ${rpcMethod || payload?.method || "POST"} ${payload?.path || "/mcp"}`,
          "info",
          { tool: toolName, method: rpcMethod || payload?.method || "POST", path: payload?.path || "/mcp", category: toolName ? "TOOL" : "CONN" }
        );

        // Only count real MCP session IDs (sess_*). Ignore auto-init / synthetic sessions.
        const sid = sessionId || payload?.headers?.["mcp-session-id"];
        if (sid && sid.startsWith("sess_") && !activeSessions.has(sid)) {
          activeSessions.add(sid);
          sessionCount = activeSessions.size;
          sendStatus();
          // Auto-expire session from active set after 10 min
          setTimeout(() => {
            if (activeSessions.delete(sid)) {
              sessionCount = activeSessions.size;
              sendStatus();
            }
          }, 10 * 60 * 1000);
        }
        const http = require("http");
        const port = cfg.port || serverPort || 3000;
        const rawPath = payload.path || "/mcp";
        const deviceMatch = rawPath.match(/^(\/mcp\/[^/]+)/);
        const prefix = deviceMatch ? deviceMatch[1] : "";
        const stripped = rawPath.replace(/^\/mcp\/[^/]+/, "");
        let localPath = stripped || "/mcp";

        if (payload.query && typeof payload.query === "object" && Object.keys(payload.query).length > 0) {
          const qs = new URLSearchParams(payload.query).toString();
          if (qs && !localPath.includes("?")) localPath += "?" + qs;
        } else if (payload.url && payload.url.includes("?")) {
          const qs = payload.url.slice(payload.url.indexOf("?"));
          if (!localPath.includes("?")) localPath += qs;
        }

        let bodyData = null;
        if (payload && typeof payload === "object" && payload.method !== "GET" && payload.method !== "HEAD") {
          let rawBody = payload.body !== undefined ? payload.body : payload;
          if (typeof rawBody === "object" && rawBody !== null) {
            const reqCT = (payload.headers?.["content-type"] || payload.headers?.["Content-Type"] || "").toLowerCase();
            if (reqCT.includes("x-www-form-urlencoded")) {
              bodyData = new URLSearchParams(rawBody).toString();
            } else {
              bodyData = JSON.stringify(rawBody);
            }
          } else if (typeof rawBody === "string") {
            bodyData = rawBody;
          }
        }

        const activeKey = (() => {
          try {
            if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).api_key;
          } catch {}
          try {
            const rootCfg = path.join(__dirname, "..", "config.json");
            if (fs.existsSync(rootCfg)) return JSON.parse(fs.readFileSync(rootCfg, "utf8")).api_key;
          } catch {}
          return cfg.api_key || "";
        })();

        const options = {
          hostname: "127.0.0.1", port,
          path: localPath,
          method: payload.method || "GET",
          headers: {
            "Content-Type": payload.headers?.["content-type"] || "application/json",
            "Accept": "application/json, text/event-stream",
            "X-Forwarded-Host": domain,
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Prefix": prefix,
            "Authorization": `Bearer ${activeKey || cfg.api_key}`,
            ...(bodyData !== null ? { "Content-Length": Buffer.byteLength(bodyData) } : {}),
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            ...(payload.headers && payload.headers["mcp-session-id"] ? { "mcp-session-id": payload.headers["mcp-session-id"] } : {}),
          },
        };
        const localReq = http.request(options, (localRes) => {
          const newSid = localRes.headers["mcp-session-id"] || sessionId;
          const contentType = localRes.headers["content-type"] || "";
          let body = "";
          localRes.on("data", c => {
            body += c;
            if (Buffer.byteLength(body) > 50 * 1024 * 1024) localReq.destroy(new Error("Local relay response exceeded 50 MB"));
          });
          localRes.on("end", () => {
            if (generation !== relayGeneration || relayWs !== ws || ws.readyState !== 1) return;
            try {
              let parsed;
              if (contentType.includes("text/event-stream")) {
                parsed = body;
              } else if (contentType.includes("text/html")) {
                parsed = body;
              } else if (body && body.trim() !== "") {
                try {
                  parsed = JSON.parse(body);
                } catch {
                  parsed = body;
                }
              } else {
                parsed = { ok: true };
              }
              ws.send(JSON.stringify({
                type: "response",
                requestId,
                sessionId: newSid,
                statusCode: localRes.statusCode,
                status: localRes.statusCode,
                headers: localRes.headers,
                payload: parsed
              }));
              addLog(
                `${toolName ? `Tool ${toolName}` : "Relay request"} completed with HTTP ${localRes.statusCode}`,
                localRes.statusCode >= 400 ? "error" : "success",
                { tool: toolName, method: rpcMethod || payload?.method, status: localRes.statusCode, category: toolName ? "TOOL" : "CONN" }
              );
            } catch (e) {
              if (generation !== relayGeneration || relayWs !== ws || ws.readyState !== 1) return;
              ws.send(JSON.stringify({
                type: "response",
                requestId,
                sessionId,
                status: 500,
                payload: { error: "Parse error", raw: body.slice(0, 300) } 
              }));
            }
          });
        });
        localReq.on("error", (e) => {
          addLog(`Local relay forwarding failed: ${e.message}`, "error", { tool: toolName, method: rpcMethod || payload?.method, category: "ERROR" });
          if (generation !== relayGeneration || relayWs !== ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: "response",
            requestId,
            sessionId,
            statusCode: 502,
            status: 502,
            payload: { error: e.message },
          }));
        });
        localReq.setTimeout(55_000, () => localReq.destroy(new Error("Local relay request timed out")));
        if (bodyData !== null) {
          localReq.write(bodyData);
        }
        localReq.end();
      } catch (err) {
        addLog(`Relay message error: ${err.message}`, "error", { category: "ERROR" });
      }
    });

    ws.on("close", () => {
      if (ws.pingTimer) clearInterval(ws.pingTimer);
      if (generation !== relayGeneration || relayWs !== ws) return;
      relayWs = null;
      relayUrl = null;
      relayError = "Hosted relay disconnected";
      activeSessions.clear();
      sessionCount = 0;
      sendStatus();
      addLog("VPS relay disconnected — scheduling reconnect", "warn", { category: "CONN" });
      scheduleRelayReconnect();
    });

    ws.on("error", (err) => {
      if (ws.pingTimer) clearInterval(ws.pingTimer);
      if (generation !== relayGeneration || relayWs !== ws) return;
      relayWs = null;
      relayUrl = null;
      relayError = err?.code === "ETIMEDOUT"
        ? "Hosted relay timed out"
        : `Hosted relay unavailable${err?.message ? `: ${err.message}` : ""}`;
      activeSessions.clear();
      sessionCount = 0;
      addLog(`VPS Relay Connection Error: ${err ? err.message : "Connection failed"}`, "error", { category: "NET" });
      sendStatus();
      scheduleRelayReconnect();
    });
  };

  setTimeout(connect, 1000);
}

function stopRelay() {
  relayGeneration++;
  relayRetryCount = 0;
  if (relayWs) { try { relayWs.close(); } catch {} relayWs = null; }
  relayUrl = null;
  relayError = null;
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 790,
    minWidth: 900,
    minHeight: 620,
    title: "PC Control MCP",
    backgroundColor: "#071112",
    frame: false,
    titleBarStyle: "hidden",
    roundedCorners: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const logPath = path.join(app.getPath("userData"), "console.log");
    fs.appendFileSync(logPath, `[RENDERER] ${message} (at ${path.basename(sourceId)}:${line})\n`);
  });

  win.webContents.once("dom-ready", async () => {
    const cfg = loadConfig();
    if (cfg.ready && cfg.autostart !== false) {
      startServer(cfg);
      if (await waitForRuntime(cfg)) {
        if (cfg.relay_enabled !== false) startTunnel(cfg);
        startRelay(cfg);
      } else {
        addLog("MCP runtime did not become ready within 15 seconds", "error");
        stopServer();
      }
    } else {
      sendStatus();
    }
    win.webContents.send("config", cfg);
  });

  // Register startup listeners before loading. Packaged renderer loads quickly
  // enough to emit dom-ready before a listener added after loadFile().
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  win.on("close", (e) => {
    stopServer();
    app.exit(0);
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, "assets", "icon.png");
  let img;
  try {
    img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    if (img.isEmpty()) throw new Error("empty");
  } catch { img = nativeImage.createEmpty(); }

  tray = new Tray(img);
  tray.setToolTip("PC Control MCP");
  tray.on("click", () => { win.show(); win.focus(); win.moveTop(); });

  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: "PC Control MCP", enabled: false },
    { type: "separator" },
    { label: isRunning ? "⚡ Running" : "⭘ Stopped", enabled: false },
    { label: tunnelUrl ? `🔗 ${tunnelUrl.replace("https://","").slice(0,30)}/mcp` : "No tunnel", enabled: false },
    { label: relayUrl  ? `🌐 VPS: ...${relayUrl.slice(-20)}` : "VPS relay offline", enabled: false },
    { type: "separator" },
    { label: "Copy Tunnel URL", enabled: !!tunnelUrl, click: () => { if (tunnelUrl) clipboard.writeText(`${tunnelUrl}/mcp`); } },
    { label: "Copy VPS URL",    enabled: !!relayUrl,  click: () => { if (relayUrl)  clipboard.writeText(relayUrl); } },
    { label: "Open Dashboard", click: () => { win.show(); win.focus(); win.moveTop(); } },
    { type: "separator" },
    { label: isRunning ? "Stop Server" : "Start Server", click: async () => {
        const cfg = loadConfig();
        if (isRunning) stopServer();
        else if (cfg.ready) {
          startServer(cfg);
          if (await waitForRuntime(cfg)) {
            if (cfg.relay_enabled !== false) startTunnel(cfg);
            startRelay(cfg);
          } else {
            addLog("MCP runtime did not become ready within 15 seconds", "error");
            stopServer();
          }
        }
        setTimeout(rebuild, 1000);
    }},
    { type: "separator" },
    { label: "Quit", click: () => { stopServer(); app.exit(0); } },
  ]));
  rebuild();
  setInterval(rebuild, 5000);
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle("get-status",  () => getStatus());
ipcMain.handle("get-config",  () => loadConfig());
ipcMain.handle("get-logs",    () => logLines);
ipcMain.handle("clear-logs",  () => { logLines = []; return true; });
// Main-process clipboard: navigator.clipboard in the renderer fails silently
// without focus/permissions — this always works.
ipcMain.handle("write-clipboard", (_, text) => {
  clipboard.writeText(String(text ?? ""));
  return true;
});

// ── Config repair / restore ───────────────────────────────────────────────────
ipcMain.handle("config-diagnose", () => {
  const cfg = loadConfig();
  const { valid, problems } = configRepair.validateConfig(cfg);
  return {
    valid,
    problems,
    configPath: CONFIG_FILE,
    backups: configRepair.listBackups(CONFIG_FILE).map((b) => ({
      name: b.name,
      path: b.path,
      savedAt: new Date(b.mtime).toISOString(),
    })),
  };
});

ipcMain.handle("config-repair", () => {
  const before = loadConfig();
  const { config, repaired } = configRepair.repairConfig(before);

  if (repaired.length === 0) {
    return { ok: true, repaired: [], message: "Config is already valid — nothing to repair." };
  }

  const wasRunning = isRunning;
  if (wasRunning) stopServer();

  try {
    configRepair.writeConfigAtomic(CONFIG_FILE, config);
  } catch (e) {
    addLog(`Config repair failed: ${e.message}`, "error");
    if (wasRunning) startServer(before);
    return { ok: false, error: `Config could not be saved: ${e.message}` };
  }

  addLog(`Repaired config fields: ${repaired.join(", ")}`, "warn");
  if (win && !win.isDestroyed()) win.webContents.send("config", config);

  if (wasRunning) {
    startServer(config);
    if (config.relay_enabled !== false) startTunnel(config);
    startRelay(config);
  }

  return {
    ok: true,
    repaired,
    keyChanged: repaired.includes("api_key"),
    message: repaired.includes("api_key")
      ? `Repaired: ${repaired.join(", ")}. A new API key was generated — update your AI clients.`
      : `Repaired: ${repaired.join(", ")}.`,
  };
});

ipcMain.handle("config-restore", (_, backupPath) => {
  const wasRunning = isRunning;
  if (wasRunning) stopServer();

  const result = configRepair.restoreConfig(CONFIG_FILE, backupPath || null);
  if (!result.ok) {
    addLog(`Config restore failed: ${result.error}`, "error");
    if (wasRunning) startServer(loadConfig());
    return result;
  }

  addLog(`Config restored from ${path.basename(result.restoredFrom)}`, "warn");
  if (win && !win.isDestroyed()) win.webContents.send("config", result.config);

  if (wasRunning) {
    startServer(result.config);
    if (result.config.relay_enabled !== false) startTunnel(result.config);
    startRelay(result.config);
  }

  return { ...result, message: "Config restored. Verify your API key still matches your AI clients." };
});

ipcMain.handle("config-backup", () => {
  const target = configRepair.backupConfig(CONFIG_FILE);
  if (!target) return { ok: false, error: "There is no valid config to back up yet." };
  addLog("Config backup created", "info");
  return { ok: true, path: target };
});

ipcMain.handle("config-open-folder", () => {
  shell.showItemInFolder(CONFIG_FILE);
  return { ok: true };
});

ipcMain.handle("start-server",async () => {
  const cfg = loadConfig();
  if (!cfg.ready) return false;
  startServer(cfg);
  const ready = await waitForRuntime(cfg);
  if (!ready) {
    addLog("MCP runtime did not become ready within 15 seconds", "error");
    stopServer();
    return false;
  }
  if (cfg.relay_enabled !== false) startTunnel(cfg);
  startRelay(cfg);
  return true;
});
ipcMain.handle("stop-server", async () => { stopServer(); return true; });
ipcMain.handle("regenerate-mcp-url", async () => {
  const crypto = require("crypto");
  const current = loadConfig();
  const wasRunning = isRunning;
  const oldDeviceId = String(current.device_id || "");
  const suffixPattern = /^[a-f0-9]{8}$/.test(oldDeviceId) ? new RegExp(`-${oldDeviceId}$`) : /-[a-f0-9]{8}$/;
  const baseName = String(current.name || "pc").replace(suffixPattern, "").replace(/-+$/, "").slice(0, 39) || "pc";
  const deviceId = crypto.randomBytes(4).toString("hex");
  const next = { ...current, name: `${baseName}-${deviceId}`, device_id: deviceId };

  stopServer();

  if (current.relay_enabled !== false && current.name) {
    const oldRoomPath = `/admin/rooms/${encodeURIComponent(current.name)}`;
    const removed = await relayAdminRequest("DELETE", oldRoomPath);
    if (removed.status && removed.status !== 200 && removed.status !== 404) {
      addLog(`MCP URL regeneration cancelled: old relay room returned HTTP ${removed.status}`, "error");
      if (wasRunning) {
        startServer(current);
        if (current.relay_enabled !== false) startTunnel(current);
        startRelay(current);
      }
      return { ok: false, error: `Previous MCP URL could not be revoked (HTTP ${removed.status}).` };
    }
    if (!removed.status) {
      addLog("MCP URL regeneration cancelled: relay could not be reached", "error");
      if (wasRunning) {
        startServer(current);
        if (current.relay_enabled !== false) startTunnel(current);
        startRelay(current);
      }
      return { ok: false, error: "Previous MCP URL could not be revoked because the relay was unreachable." };
    }
  }
  saveConfig(next);
  const domain = next.relay_domain || "mcp.solisk.org";
  relayUrl = next.relay_enabled === false ? null : `https://${domain}/mcp/${next.name}`;
  sendStatus();
  addLog(`MCP URL regenerated as workspace "${next.name}"; previous sessions revoked`, "warn");
  if (win && !win.isDestroyed()) win.webContents.send("config", next);

  if (wasRunning) {
    await new Promise(resolve => setTimeout(resolve, 750));
    startServer(next);
    if (next.relay_enabled !== false) startTunnel(next);
    startRelay(next);
  }

  return { ok: true, name: next.name, url: `https://${domain}/mcp/${next.name}`, status: getStatus() };
});
ipcMain.handle("save-config", (_, c) => {
  const newConfig = { ...loadConfig(), ...c };
  saveConfig(newConfig);
  addLog("Config saved", "info");

  // Sync updated API key to VPS relay immediately
  if (relayWs && relayWs.readyState === 1) {
    try {
      relayWs.send(JSON.stringify({
        type: "init",
        code: newConfig.name || "pc",
        apiKey: newConfig.api_key || "",
        userKeys: Array.isArray(newConfig.user_keys) ? newConfig.user_keys : [],
      }));
      addLog("Synchronized API key with VPS relay", "success");
    } catch (e) {
      addLog(`Relay sync error: ${e.message}`, "warn");
    }
  }

  // Notify renderer window with new config
  if (win && !win.isDestroyed()) {
    win.webContents.send("config", newConfig);
  }
  return true;
});
ipcMain.handle("open-url",    (_, u) => shell.openExternal(u));
ipcMain.handle("minimize",    () => win.minimize());
ipcMain.handle("maximize",    () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.handle("close-win",   () => { stopServer(); app.exit(0); });
ipcMain.handle("quit-app",    () => { stopServer(); app.exit(0); });
ipcMain.handle("shell-approval-res", (_, payload) => { if (serverProc) serverProc.send({ type: "shell_approval_res", ...payload }); return true; });
ipcMain.handle("retry-relay", async () => {
  addLog("Manual relay reconnection requested by user", "info", { category: "CONN" });
  relayRetryCount = 0;
  relayError = null;
  isInternetOffline = false;
  const cfg = loadConfig();
  stopRelay();
  startRelay(cfg);
  return { ok: true, status: getStatus() };
});

// ── Relay Admin API: per-user key management ──────────────────────────────────
const https = require("https");
const http  = require("http");

function relayAdminRequest(method, apiPath, body) {
  return new Promise((resolve) => {
    const cfg = loadConfig();
  const domain = cfg.relay_domain || "mcp.solisk.org";
    const token  = cfg.api_key || "";
    const isHttps = domain.startsWith("http://") ? false : true;
    const cleanDomain = domain.replace(/^https?:\/\//, "");
    const payload = body ? JSON.stringify(body) : null;
    const mod = isHttps ? https : http;
    const req = mod.request({
      hostname: cleanDomain,
      path: apiPath,
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "X-Room-Code": cfg.name || "",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on("error", () => resolve({ status: 0, body: null, raw: "" }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, body: null, raw: "" }); });
    if (payload) req.write(payload);
    req.end();
  });
}

ipcMain.handle("relay-list-keys", async () => {
  const cfg = loadConfig();
  const keys = Array.isArray(cfg.user_keys) ? cfg.user_keys : [];
  return { ok: true, keys: keys.map(({ api_key, key, ...item }) => item), online: relayWs && relayWs.readyState === 1 ? "online" : "offline" };
});

ipcMain.handle("relay-create-key", async (_, payload) => {
  const cfg = loadConfig();
  const crypto = require("crypto");
  const label = (payload && payload.label && payload.label.trim()) || "key-" + crypto.randomBytes(3).toString("hex");
  const scopes = (payload && payload.scopes) || [];
  const plaintext = crypto.randomBytes(24).toString("hex");
  const keyId = "user-" + crypto.randomBytes(4).toString("hex");

  const userKeys = Array.isArray(cfg.user_keys) ? cfg.user_keys : [];
  if (userKeys.length >= 5) {
    return { ok: false, error: "Maximum of 5 scope-only keys allowed. Revoke one first." };
  }

  const newKeyObj = {
    id: keyId,
    label,
    scopes,
    api_key: plaintext,
    createdAt: Date.now(),
  };

  userKeys.push(newKeyObj);
  const next = { ...cfg, user_keys: userKeys };
  saveConfig(next);
  if (relayWs && relayWs.readyState === 1) {
    relayWs.send(JSON.stringify({ type: "init", code: cfg.name, apiKey: cfg.api_key, userKeys }));
  }
  addLog(`Created scope-only API key "${label}"`, "success");

  return { ok: true, key: newKeyObj };
});

ipcMain.handle("relay-revoke-key", async (_, keyId) => {
  const cfg = loadConfig();
  const userKeys = Array.isArray(cfg.user_keys) ? cfg.user_keys : [];
  const filtered = userKeys.filter(k => k.id !== keyId && k.label !== keyId);
  const next = { ...cfg, user_keys: filtered };
  saveConfig(next);
  if (relayWs && relayWs.readyState === 1) {
    relayWs.send(JSON.stringify({ type: "init", code: cfg.name, apiKey: cfg.api_key, userKeys: filtered }));
  }
  addLog(`Revoked API key "${keyId}"`, "info");
  return { ok: true };
});

ipcMain.handle("relay-set-mode", async (_, mode) => {
  const cfg = loadConfig();
  const next = { ...cfg, permission_mode: String(mode || "always") };
  saveConfig(next);
  addLog(`Permission mode set to "${next.permission_mode}"`, "success");
  if (win && !win.isDestroyed()) win.webContents.send("config", next);
  return { ok: true, permission_mode: next.permission_mode };
});


// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  console.log("App ready");

  // Content-Security-Policy for the renderer
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; connect-src 'self' https: wss:; font-src 'self' https://fonts.gstatic.com"
        ],
      },
    });
  });

  createWindow();
  createTray();
  // NOTE: startServer/Tunnel/Relay is called inside dom-ready (createWindow),
  // so we do NOT call them again here to avoid double-spawn.
});

app.on("window-all-closed", () => {});
app.on("before-quit", () => stopServer());
