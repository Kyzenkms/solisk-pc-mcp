"use strict";
/* bridge.js — implements window.mcp over HTTP so the desktop renderer runs
   in a browser unchanged. Served only with /app. Key from sessionStorage. */
(function () {
  if (window.mcp) return;

  const store = window.sessionStorage;
  const KEY = "pcc.key";

  const key = () => store.getItem(KEY) || "";
  let statusTimer = null, logTimer = null;
  let wantRemember = false;

  function teardown() {
    if (statusTimer) clearInterval(statusTimer);
    if (logTimer) clearInterval(logTimer);
    statusTimer = logTimer = null;
    try { delete window.mcp; } catch { window.mcp = undefined; }
  }

  function gate(message) {
    teardown();
    store.removeItem(KEY);
    let overlay = document.getElementById("pcc-gate");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "pcc-gate";
      overlay.style.cssText = "position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(0,0,0,.7);backdrop-filter:blur(6px)";
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = '<div style="background:#272727;border:1px solid #4a4a4a;border-radius:14px;padding:28px;max-width:380px;width:calc(100vw - 40px);font-family:system-ui"><h2 style="color:#fff;font-size:17px;margin:0 0 8px">Connect to this PC</h2><p style="color:#c9c9c9;font-size:13px;margin:0 0 16px">' + (message || "Paste the owner API key. It stays in this tab only.") + '</p><input id="pcc-key" type="password" placeholder="Owner API key" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #4a4a4a;background:#2b2b2b;color:#fff;font-size:14px"/><label style="display:flex;gap:8px;align-items:center;color:#c9c9c9;font-size:12px;margin-top:10px;cursor:pointer"><input id="pcc-remember" type="checkbox" style="accent-color:#4fd1b5"/>Remember this device (30 days)</label><button id="pcc-go" style="width:100%;margin-top:12px;padding:10px;border-radius:8px;border:0;background:#4fd1b5;color:#03211b;font-weight:700;font-size:14px;cursor:pointer">Connect</button></div>';
    const go = () => {
      const v = overlay.querySelector("#pcc-key").value.trim();
      if (!v) return;
      wantRemember = overlay.querySelector("#pcc-remember").checked;
      store.setItem(KEY, v);
      overlay.remove();
      boot();
    };
    overlay.querySelector("#pcc-go").addEventListener("click", go);
    overlay.querySelector("#pcc-key").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  }

  async function cookieLogin() {
    try {
      const r = await fetch("/api/status", { credentials: "same-origin" });
      return r.ok;
    } catch { return false; }
  }

  function ensureKey() {
    if (store.getItem(KEY)) return true;
    return false; // cookie check happens async in boot()
  }

  async function call(path, opts) {
    const r = await fetch(path, {
      ...(opts || {}),
      headers: { "Content-Type": "application/json", authorization: "Bearer " + key(), ...((opts && opts.headers) || {}) },
    });
    if (r.status === 401 || r.status === 403) {
      gate("That key was refused. Paste the owner API key and press Connect.");
      throw new Error("unauthorized");
    }
    let body = null;
    try { body = await r.json(); } catch {}
    if (!r.ok) throw new Error((body && body.error) || ("HTTP " + r.status));
    return body;
  }

  const get = (p) => call("/api" + p);
  const post = (p, body) => call("/api" + p, { method: "POST", body: JSON.stringify(body || {}) });
  const del = (p) => call("/api" + p, { method: "DELETE" });

  const statusFns = [], logFns = [];
  let lastLogIds = new Set();

  async function pollStatus() {
    try {
      const s = await get("/status");
      statusFns.forEach((f) => { try { f(s); } catch {} });
    } catch {}
  }

  async function pollLogs() {
    try {
      const r = await get("/logs?lines=60");
      const logs = (r && r.logs) || [];
      const fresh = logs.filter((l) => !lastLogIds.has(l.id));
      lastLogIds = new Set(logs.map((l) => l.id));
      fresh.forEach((l) => logFns.forEach((f) => { try { f(l); } catch {} }));
    } catch {}
  }

  const mcp = {
    getStatus: () => get("/status"),
    getHealth: () => get("/health"),
    getConfig: async () => { const r = await get("/config"); return r.config || {}; },
    getLogs: async () => {
      const r = await get("/logs?lines=200");
      const logs = (r && r.logs) || [];
      lastLogIds = new Set(logs.map((l) => l.id));
      return logs;
    },
    clearLogs: () => post("/logs-clear"),
    startServer: () => post("/server-start"),
    stopServer: () => post("/server-stop"),
    retryRelay: async () => { const r = await post("/relay-retry"); return { status: null, ...(r || {}) }; },
    relaySet: (e) => post("/relay-set", { enabled: !!e }),
    regenerateMcpUrl: () => post("/regen-url"),
    saveConfig: (c) => post("/config", { config: c }),
    writeClipboard: async (t) => { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } },
    openUrl: async (u) => { try { window.open(u, "_blank", "noopener"); } catch {} },
    minimize: async () => {},
    maximize: async () => {},
    close: async () => {},
    quit: async () => {},
    onStatus: (fn) => { statusFns.push(fn); },
    onLog: (fn) => { logFns.push(fn); },
    onConfig: () => {},
    onShellApprovalReq: () => {},
    sendShellApprovalRes: async () => false,
    relayListKeys: () => get("/keys"),
    relayCreateKey: (p) => post("/keys", p || {}),
    relayRevokeKey: (k) => del("/keys/" + encodeURIComponent(k)),
    relaySetMode: (m) => post("/config", { config: { permission_mode: m } }),
    configDiagnose: async () => ({ ok: true, problems: [] }),
    configRepair: () => post("/config", { config: {} }),
    configRestore: async () => ({ ok: false, error: "use the CLI backup file" }),
    configBackup: () => get("/config").then(() => ({ ok: true })),
    configOpenFolder: async () => {},
    tunnelState: () => get("/tunnel"),
    tunnelSetMode: (m) => post("/tunnel-mode", { mode: m }),
    tunnelInstall: () => post("/tunnel-install"),
    tunnelLogin: () => post("/tunnel-login"),
    tunnelCreate: (n) => post("/tunnel-create", { name: n }),
    tunnelRoute: (h) => post("/tunnel-route", { hostname: h }),
    tunnelForget: () => post("/tunnel-forget"),
    tailscaleServe: (f) => post("/tailscale-serve", { funnel: !!f }),
    tailscaleOff: () => post("/tailscale-off"),
    dashSet: (e) => post("/dash-set", { enabled: !!e }),
    deviceRemember: () => post("/device-remember", { label: navigator.userAgent || "browser" }),
    deviceList: () => get("/devices").then((r) => (r && r.devices) || []),
    deviceRevoke: (id) => del("/devices/" + encodeURIComponent(id)),
    deviceForget: () => post("/device-forget", {}),
  };

  function boot() {
    if (!ensureKey()) {
      // No tab key — a remembered-device cookie may still get us in.
      cookieLogin().then((ok) => {
        if (ok) start();
        else gate(null);
      });
      return;
    }
    start();
  }

  function start() {
    document.body.classList.add("is-bridge");
    window.mcp = mcp;
    // Fresh owner-key connect + "remember" ticked → mint the device cookie once.
    if (wantRemember && store.getItem(KEY)) {
      wantRemember = false;
      post("/device-remember", { label: navigator.userAgent || "browser" }).catch(() => {});
    }
    pollStatus();
    pollLogs();
    statusTimer = setInterval(pollStatus, 5000);
    logTimer = setInterval(pollLogs, 5000);
    get("/status").then((s) => statusFns.forEach((f) => { try { f(s); } catch {} })).catch(() => {});
  }

  boot();
})();
