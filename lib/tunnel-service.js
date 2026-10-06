"use strict";

/**
 * tunnel-service.js — one inbound-exposure engine for every interface.
 * cloudflared (quick + named) and tailscale. State on the event bus.
 * The named-tunnel token is stored secret in config, never logged/printed.
 */

const { spawn, spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bus, EVENTS } = require("./events");

const QUICK_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

let state = { kind: "off", url: null, pid: null }; // kind: off|quick|custom|tailscale
let child = null;
let generation = 0;
let tmpCfgDir = null;

function cleanTmpCfg() {
  if (tmpCfgDir) {
    const d = tmpCfgDir;
    tmpCfgDir = null;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

function emit() {
  bus.emitState(EVENTS.TUNNEL_STATE, state);
}

function getState() {
  return { ...state };
}

function defaultCloudflaredPath() {
  if (process.platform === "win32") {
    return "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
  }
  return "cloudflared";
}

function resolveCloudflared(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  const def = defaultCloudflaredPath();
  if (fs.existsSync(def)) return def;
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(which, ["cloudflared"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch {}
  return null;
}

function cloudflaredInstalled(customPath) {
  return !!resolveCloudflared(customPath);
}

function installCloudflared() {
  if (process.platform !== "win32") {
    return { ok: false, hint: "install cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" };
  }
  try {
    execFileSync("winget", ["install", "--id", "Cloudflare.cloudflared", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"],
      { timeout: 5 * 60 * 1000, stdio: "ignore", windowsHide: true });
    return { ok: !!resolveCloudflared(null) };
  } catch (err) {
    return { ok: false, hint: "winget install failed: " + (err.message || err) };
  }
}

function certDir() {
  return path.join(os.homedir(), ".cloudflared");
}

function loginDone() {
  try { return fs.statSync(path.join(certDir(), "cert.pem")).isFile(); }
  catch { return false; }
}

// ── Named tunnel setup ──────────────────────────────────────────────────────

function cfRun(bin, args, timeoutMs = 30000) {
  const out = execFileSync(bin, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return (out || "").trim();
}

function createNamedTunnel(bin, name) {
  const clean = String(name || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(clean)) return { ok: false, error: "tunnel name: lowercase letters, digits, dashes" };
  try {
    return { ok: true, name: clean, output: cfRun(bin, ["tunnel", "create", clean]) };
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || "").toString();
    if (/already exists|duplicate/i.test(msg)) return { ok: true, reused: true, output: msg.slice(0, 300) };
    return { ok: false, error: msg.slice(0, 500) };
  }
}

function routeDns(bin, tunnel, hostname) {
  try {
    return { ok: true, output: cfRun(bin, ["tunnel", "route", "dns", tunnel, hostname]) };
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || "").toString().slice(0, 500);
    return { ok: false, error: msg };
  }
}

function fetchToken(bin, tunnel) {
  try {
    const token = cfRun(bin, ["tunnel", "token", tunnel]);
    if (!token || token.length < 20) return { ok: false, error: "empty token returned" };
    return { ok: true, token };
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || "").toString().slice(0, 500);
    return { ok: false, error: msg };
  }
}

// ── Running ─────────────────────────────────────────────────────────────────

/** Spawn a child, watch for a quick URL. */
function runChild(bin, args, kind, urlFromStdout, onUrl) {
  stopChild();
  const gen = ++generation;
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: false });
  child = proc;
  state = { kind, url: null, pid: proc.pid || null };
  emit();
  const onData = (data) => {
    if (gen !== generation || child !== proc) return;
    const m = String(data).match(QUICK_RE);
    if (urlFromStdout && m && m[0] !== state.url) {
      state = { ...state, url: m[0] };
      emit();
      if (typeof onUrl === "function") { try { onUrl(m[0]); } catch {} }
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("error", () => {
    if (gen !== generation || child !== proc) return;
    state = { kind, url: state.url, pid: null, error: "spawn failed — is cloudflared installed?" };
    emit();
  });
  proc.on("close", () => {
    if (gen !== generation || child !== proc) return;
    child = null;
    state = { kind, url: null, pid: null };
    emit();
  });
  return proc;
}

function runQuick(port, customPath) {
  const bin = resolveCloudflared(customPath);
  if (!bin) return { ok: false, error: "cloudflared not found" };
  runChild(bin, ["tunnel", "--url", `http://localhost:${port}`], "quick", true);
  return { ok: true };
}

function runCustom(token, hostname, port, customPath) {
  const bin = resolveCloudflared(customPath);
  if (!bin) return { ok: false, error: "cloudflared not found" };
  if (!token || token.length < 20) return { ok: false, error: "no tunnel token stored — run the custom-domain wizard first" };
  if (!hostname || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(hostname) || hostname.includes("..")) return { ok: false, error: "valid hostname required" };
  port = Number(port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: "valid port required" };
  let cfgPath;
  stopChild();
  try {
    tmpCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "pccf-"));
    cfgPath = path.join(tmpCfgDir, "cloudflared.yml");
    fs.writeFileSync(cfgPath,
      `ingress:\n  - hostname: ${hostname}\n    service: http://localhost:${port}\n  - service: http_status:404\n`,
      { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: "cannot write tunnel config: " + String((err && err.message) || err).slice(0, 200) };
  }
  // cloudflared's documented --token flag. Same-user process-list visibility
  // accepted; never logged, never printed, stored secret in config.
  const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--config", cfgPath, "run", "--token", token], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const gen = ++generation;
  child = proc;
  state = { kind: "custom", url: null, pid: proc.pid || null };
  emit();
  proc.on("error", () => {
    if (gen !== generation || child !== proc) return;
    state = { kind: "custom", url: null, pid: null, error: "spawn failed" };
    emit();
  });
  proc.on("close", () => {
    if (gen !== generation || child !== proc) return;
    child = null;
    state = { kind: "custom", url: null, pid: null };
    emit();
  });
  return { ok: true };
}

function setCustomUrl(url) {
  // Called by the owner (GUI/CLI) after route-DNS verifies the hostname.
  if (state.kind !== "custom") return;
  state = { ...state, url };
  emit();
}

function stopChild() {
  generation++;
  if (child) { try { child.kill(); } catch {} child = null; }
  cleanTmpCfg();
  if (state.kind !== "off") { state = { kind: "off", url: null, pid: null }; emit(); }
}

// ── Tailscale ───────────────────────────────────────────────────────────────

function tailscaleBin() {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["tailscale"],
      { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first || null;
  } catch { return null; }
}

function tailscaleStatus() {
  try {
    const out = execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    const j = JSON.parse(out || "{}");
    const dns = (j.Self && j.Self.DNSName) || "";
    return { ok: true, loggedIn: !!dns, dns: String(dns).replace(/\.$/, "") };
  } catch {
    return { ok: false, loggedIn: false, dns: "" };
  }
}

function tailscaleServe(port, funnel) {
  const r = spawnSyncBin("tailscale", [funnel ? "funnel" : "serve", "--bg", `http://127.0.0.1:${port}`]);
  if (!r.ok) return r;
  const st = tailscaleStatus();
  if (st.dns) { state = { kind: "tailscale", url: `https://${st.dns}`, pid: null, funnel: !!funnel }; emit(); }
  return { ok: true, url: st.dns ? `https://${st.dns}` : "" };
}

function tailscaleOff() {
  spawnSyncBin("tailscale", ["serve", "off"]);
  spawnSyncBin("tailscale", ["funnel", "off"]);
  if (state.kind === "tailscale") { state = { kind: "off", url: null, pid: null }; emit(); }
  return { ok: true };
}

function spawnSyncBin(bin, args) {
  const { spawnSync } = require("child_process");
  try {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 20000, windowsHide: true });
    if (r.error || r.status !== 0) {
      return { ok: false, error: ((r.stderr || (r.error && r.error.message) || "") + "").trim().slice(0, 300) || "command failed" };
    }
    return { ok: true, output: (r.stdout || "").trim() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
  }
}

module.exports = {
  getState,
  resolveCloudflared,
  cloudflaredInstalled,
  installCloudflared,
  loginDone,
  certDir,
  createNamedTunnel,
  routeDns,
  fetchToken,
  runQuick,
  runCustom,
  setCustomUrl,
  stopChild,
  tailscaleBin,
  tailscaleStatus,
  tailscaleServe,
  tailscaleOff,
};
