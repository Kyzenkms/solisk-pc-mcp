#!/usr/bin/env node
"use strict";

/**
 * pc-control — headless CLI for PC Control MCP (VPS / server deploys).
 *
 *   pc-control --mode=http [--host 127.0.0.1] [--port 3000] [--config PATH]
 *   pc-control --mode=stdio
 *   pc-control --list-tools        list active tools and exit
 *   pc-control --setup             generate config + key and exit
 *   pc-control --help
 *
 * Env: MCP_CONFIG_PATH, PC_CONTROL_HOST, PC_CONTROL_PORT, PC_CONTROL_APPROVAL
 *      (approval: always | intermediate | turbo; default always)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function defaultConfigPath() {
  if (process.env.MCP_CONFIG_PATH) return process.env.MCP_CONFIG_PATH;
  return path.join(os.homedir(), ".config", "pc-control-headless", "config.json");
}

// lib/security.js and lib/oauth.js capture MCP_CONFIG_PATH at require time.
(function claimConfigPathEarly() {
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--config" && raw[i + 1] && !raw[i + 1].startsWith("--")) {
      process.env.MCP_CONFIG_PATH = raw[i + 1];
      return;
    }
    if (raw[i].startsWith("--config=")) {
      process.env.MCP_CONFIG_PATH = raw[i].slice("--config=".length);
      return;
    }
  }
  // --config > env > GUI config (if CLI has none) > default. No forked identity.
  if (!process.env.MCP_CONFIG_PATH) {
    try {
      process.env.MCP_CONFIG_PATH = require("../../lib/config-service").resolveConfigPath(null);
    } catch {
      process.env.MCP_CONFIG_PATH = defaultConfigPath();
    }
  }
})();

const VERSION = require("../package.json").version;
const { WINDOWS_ONLY, SHELL_EXTRA } = require("../tools");

// ── Terminal polish (zero deps; raw when piped) ────────────────────────────
const TTY = !!process.stderr.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code) => (s) => TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s);
const green = paint(32), red = paint(31), yellow = paint(33), cyan = paint(36), dim = paint(2);
const bold = (s) => TTY ? `\x1b[1m${s}\x1b[0m` : String(s);
const tick = (st) => st === "ok" ? green("●") : st === "warn" ? yellow("▲") : red("✖");

function parseArgs(argv) {
  const out = { mode: "http", host: null, port: null, config: null, approval: null, sub: null, subArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // val() consumes the next argv entry at most ONCE — call it once per flag.
    const take = (name) => {
      const eq = a.indexOf("=");
      if (eq !== -1 && a.startsWith(name + "=")) return a.slice(eq + 1);
      if (a === name && argv[i + 1] && !argv[i + 1].startsWith("--")) { i++; return argv[i]; }
      return null;
    };
    let v;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.ver = true;
    else if (a === "--setup") out.setup = true;
    else if (a === "--list-tools") out.listTools = true;
    else if (a.startsWith("--mode")) { v = take("--mode"); if (v) out.mode = v; }
    else if (a.startsWith("--host")) { v = take("--host"); if (v) out.host = v; }
    else if (a.startsWith("--port")) { v = take("--port"); if (v) out.port = Number(v); }
    else if (a.startsWith("--config")) { v = take("--config"); if (v) out.config = v; }
    else if (a.startsWith("--approval-mode")) { v = take("--approval-mode"); if (v) out.approval = v; }
    else if (a === "--status") out.status = true;
    else if (a === "--tailscale") out.tailscale = "serve";
    else if (a === "--tailscale-funnel") out.tailscale = "funnel";
    else if (a === "--json") out.json = true;
    else if (a === "--lint") out.lint = true;
    else if (a === "--fix") out.fix = true;
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--no-relay") out.noRelay = true;
    else if (a === "--follow" || a === "-f") out.follow = true;
    else if (a.startsWith("--lines")) { v = take("--lines"); if (v) out.lines = Number(v); }
    else if (a.startsWith("--installer")) { v = take("--installer"); if (v) out.installer = v; }
    else if (a.startsWith("--scopes")) { v = take("--scopes"); if (v) out.scopes = v; }
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (!a.startsWith("--") && !out.sub) { out.sub = a; }
    else if (!a.startsWith("--") && out.sub) { out.subArgs.push(a); }
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return out;
}

function printHelp() {
  console.error(`pc-control-headless v${VERSION}
Usage:
  pc-control --mode=http [--host 127.0.0.1] [--port 3000] [--config PATH] [--approval-mode always|intermediate|turbo] [--tailscale|--tailscale-funnel] [--no-relay]
  pc-control --mode=stdio [--config PATH]
  pc-control --status [--host 127.0.0.1] [--port 3000] [--config PATH]
  pc-control dashboard [--port 3000] [--no-open] [--config PATH]
  pc-control doctor [--lint] [--json] [--fix] [--config PATH]
  pc-control config get <key> | set <key> <value> | validate [--config PATH]
  pc-control rotate-key [--config PATH]
  pc-control logs [--lines 50] [--follow] [--config PATH]
  pc-control backup [--config PATH]
  pc-control gui [status] [--port 3000] [--config PATH]
  pc-control gui setup [--installer PATH] [--config PATH]
  pc-control setup [--config PATH]                 # step-by-step onboarding wizard
  pc-control keys list | add <label> [--scopes s] | revoke <id|label|prefix>
  pc-control relay [status] | retry [--port 3000]
  pc-control tunnel [status] | off | quick | custom | login | create [name] | route <host> | forget
  pc-control tailscale [status] | serve | funnel | off
  pc-control --list-tools | --setup | --help | --version
Notes:
  - Windows-only tools are disabled off-Windows (Linux/macOS get 46 tools
    + shell_exec). On Windows the CLI serves the full native set, like the GUI.
  - Default bind is 127.0.0.1. Put a TLS reverse proxy (Caddy/nginx) in front for public use.
  - approval always/intermediate: mutating shell commands are refused. turbo: allowed.
  - --tailscale exposes the server on your tailnet via "tailscale serve" (needs tailscale installed + logged in).
  - --tailscale-funnel publishes to the public internet. Only use it deliberately.
  - dashboard/doctor/config/logs attach to the running server (GUI or CLI — one runtime per machine).
  - config values parse as JSON (arrays/numbers work); secrets are refused — use rotate-key.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (args.ver) { console.error(VERSION); return; }
  if (!["http", "stdio"].includes(args.mode)) { console.error(`--mode must be http or stdio (got ${args.mode})`); process.exit(2); }

  // 1. Config path was already claimed before requires (see top of file).
  //    Re-assert here so --config flows into the rest of main().
  if (args.config) process.env.MCP_CONFIG_PATH = args.config;
  const configPath = process.env.MCP_CONFIG_PATH;
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });

  // 2. Now libs are safe to load.
  const { config, loadConfig } = require("../../lib/security");
  const configRepair = require("../../lib/config-repair");
  loadConfig();

  // 3. Merge headless requirements WITHOUT touching user choices:
  //    - force-disable Windows-only tools, but ONLY off-Windows. On win32
  //      the CLI is the same machine as the GUI — same tools, no shim.
  //      (Deletes entries forced by older CLI versions; a hand-disabled
  //      Win tool on win32 re-enables — disable it in the GUI instead.)
  //    - default approval mode (only when unset)
  let changed = false;
  const disabled = new Set(Array.isArray(config.disabled_tools) ? config.disabled_tools : []);
  if (!SHELL_EXTRA) for (const t of WINDOWS_ONLY) disabled.delete(t);
  else for (const t of WINDOWS_ONLY) disabled.add(t);
  const disabledArr = [...disabled];
  if (JSON.stringify(disabledArr) !== JSON.stringify(config.disabled_tools || [])) {
    config.disabled_tools = disabledArr;
    changed = true;
  }
  const approval = args.approval || process.env.PC_CONTROL_APPROVAL;
  if (approval && ["always", "intermediate", "turbo"].includes(approval) && config.permission_mode !== approval) {
    config.permission_mode = approval;
    changed = true;
  }
  if (changed) configRepair.writeConfigAtomic(configPath, config);

  // 4. Lock down file permissions (config holds the owner API key).
  //    chmod can silently fail (Windows ACLs); verify on POSIX and warn.
  try {
    fs.chmodSync(path.dirname(configPath), 0o700);
    fs.chmodSync(configPath, 0o600);
  } catch {}
  try {
    if (process.platform !== "win32") {
      const st = fs.statSync(configPath);
      if ((st.mode & 0o077) !== 0) {
        console.error("WARNING: config is readable beyond the owner " +
          "(chmod 600 did not apply). Fix manually: chmod 600 " + configPath);
      }
    }
  } catch {}

  loadConfig(); // re-read merged state
  const keyFp = crypto.createHash("sha256").update(String(config.api_key || "")).digest("hex").slice(0, 12);

  if (args.setup) {
    console.error(bold(`pc-control setup  ${dim("v" + VERSION)}`));
    console.error(`  config   ${cyan(configPath)} ${dim("(mode 600)")}`);
    console.error(`  key      ${dim("sha256:")}${keyFp}`);
    console.error(`  owner    ${bold(yellow(config.api_key))}`);
    console.error(dim("  Store the key now — it is never printed again."));
    return;
  }

  if (args.listTools) {
    const { getToolList } = require("../../lib/registry");
    const active = getToolList().map((t) => t.name);
    const extra = SHELL_EXTRA ? ["shell_exec"] : [];
    console.error(`active (${active.length + extra.length}):`);
    for (const n of [...active, ...extra].sort()) console.error(`  ${n}`);
    console.error(`disabled windows-only (${SHELL_EXTRA ? WINDOWS_ONLY.length : 0}):`);
    for (const n of (SHELL_EXTRA ? [...WINDOWS_ONLY].sort() : [])) console.error(`  ${n}`);
    return;
  }

  if (args.sub) {
    // Operator commands attach to the running server (GUI or CLI — one
    // runtime per machine) instead of starting a second one.
    const target = resolveTarget(args, config);
    await reconcileAttachKey(config, target);
    if (args.sub === "dashboard") return await cmdDashboard(args, config, target);
    if (args.sub === "doctor") return await cmdDoctor(args, config, target, configPath);
    if (args.sub === "config") return cmdConfig(args, config, configPath);
    if (args.sub === "rotate-key") return cmdRotateKey(config, configPath);
    if (args.sub === "logs") return cmdLogs(args, configPath);
    if (args.sub === "backup") return cmdBackup(configPath);
    if (args.sub === "gui") return await cmdGui(args, config, target);
    if (args.sub === "setup") return await cmdSetupWizard(config, configPath);
    if (args.sub === "keys") return cmdKeys(args, config, configPath);
    if (args.sub === "relay") return cmdRelay(args, config, target);
    if (args.sub === "tunnel") return await cmdTunnel(args, config, configPath);
    if (args.sub === "tailscale") return cmdTailscale(args, config, target);
    console.error(`Unknown command: ${args.sub} (try --help)`);
    process.exit(2);
  }

  if (args.status) {
    // Probe a running server with the configured key. Exit 0 = up.
    const host = args.host || process.env.PC_CONTROL_HOST || "127.0.0.1";
    const port = args.port || (process.env.PC_CONTROL_PORT ? Number(process.env.PC_CONTROL_PORT) : null)
      || config.port || 3000;
    try {
      const r = await fetch(`http://${host}:${port}/status`, {
        headers: { authorization: "Bearer " + config.api_key },
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 401 || r.status === 403) {
        console.error(yellow("▲") + " " + keyMismatchHint());
        process.exit(1);
      }
      if (!r.ok) { console.error(red(`● down: HTTP ${r.status}`)); process.exit(1); }
      const s = await r.json();
      console.error(`${green("●")} ${bold("up")}  ${cyan(s.mode || "?")} ${dim("v" + (s.version || "?"))}  ` +
        `${bold(s.tools ?? "?")} tools  ${bold(s.sessions ?? "?")} sessions  uptime ${s.uptime_seconds ?? "?"}s`);
      return;
    } catch (err) {
      console.error(red(`● down: ${err.message}`));
      process.exit(1);
    }
  }

  console.error(`pc-control-headless v${VERSION} — key sha256:${keyFp} — approval:${config.permission_mode || "always"}`);

  if (args.mode === "stdio") {
    const { startHeadlessStdio } = require("../stdio");
    await startHeadlessStdio({ version: VERSION });
    return;
  }

  const host = args.host || process.env.PC_CONTROL_HOST || "127.0.0.1";
  const port = args.port || (process.env.PC_CONTROL_PORT ? Number(process.env.PC_CONTROL_PORT) : null) || null;

  // A 401 means ALIVE with a different key — never boot over it.
  const wantPort = port || config.port || 3000;
  const existing = await probeStatus(host, wantPort, config.api_key);
  if (existing && existing.s) {
    const s = existing.s;
    console.error(`${green("●")} ${bold("already running")}  ${cyan(s.mode || "?")} ${dim("v" + (s.version || "?"))} — ` +
      `${bold(s.tools ?? "?")} tools, ${bold(s.sessions ?? "?")} sessions, uptime ${s.uptime_seconds ?? "?"}s`);
    console.error(`  console  ${cyan(`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${wantPort}/app`)}`);
    return;
  }
  if (existing && existing.auth === false) {
    // Same box, other face's key: attach with it instead of walling the user.
    let guiKey = null;
    try {
      const gp = guiConfigPath();
      guiKey = gp && fs.existsSync(gp) ? JSON.parse(fs.readFileSync(gp, "utf8")).api_key : null;
    } catch {}
    if (guiKey && String(guiKey) !== String(config.api_key)) {
      const retry = await probeStatus(host, wantPort, String(guiKey));
      if (retry && retry.s) {
        const s = retry.s;
        console.error(`${green("●")} ${bold("already running")}  ${cyan(s.mode || "?")} ${dim("v" + (s.version || "?"))} — ` +
          `${bold(s.tools ?? "?")} tools, ${bold(s.sessions ?? "?")} sessions, uptime ${s.uptime_seconds ?? "?"}s`);
        console.error(`  console  ${cyan(`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${wantPort}/app`)}`);
        console.error(dim(`  attached with the GUI face's key — not starting a second server.`));
        return;
      }
    }
    console.error(yellow("▲") + " " + keyMismatchHint());
    console.error(dim(`  refusing to start a second server on ${wantPort} — fix the key, don't duplicate the runtime.`));
    process.exit(1);
  }

  const { startHeadlessHttp } = require("../server");
  const serving = startHeadlessHttp({ port, host, version: VERSION, noRelay: args.noRelay });
  if (args.tailscale) await setupTailscale(args.tailscale, port || config.port || 3000);
  await serving;
}

// Expose the local server on the tailnet (serve) or public internet (funnel).
// Never crashes the server: tailscale missing/not-logged-in is a warning.
async function setupTailscale(mode, port) {
  const { spawnSync } = require("child_process");
  const run = (args) => spawnSync("tailscale", args, { encoding: "utf8", timeout: 20000 });
  const ver = run(["version"]);
  if (ver.error || ver.status !== 0) {
    console.error("tailscale: CLI not found or not running — server stays localhost-only. Install tailscale and run `tailscale up`.");
    return;
  }
  if (mode === "funnel") {
    console.error("WARNING: --tailscale-funnel publishes this MCP server to the public internet. Bearer key is the only boundary.");
  }
  const target = `http://127.0.0.1:${port}`;
  const cmd = mode === "funnel" ? ["funnel", "--bg", target] : ["serve", "--bg", target];
  const r = run(cmd);
  if (r.status !== 0) {
    console.error(`tailscale: \`${cmd.join(" ")}\` failed: ${(r.stderr || r.error?.message || "").trim().slice(0, 200)}`);
    return;
  }
  try {
    const st = run(["status", "--json"]);
    const dns = JSON.parse(st.stdout || "{}").Self?.DNSName || "";
    if (dns) console.error(`tailscale: serving ${mode === "funnel" ? "public" : "tailnet"} at https://${dns.replace(/\.$/, "")}`);
    else console.error(`tailscale: ${mode} active (run \`tailscale serve status\` for the URL).`);
  } catch {
    console.error(`tailscale: ${mode} active (run \`tailscale serve status\` for the URL).`);
  }
  console.error(`tailscale: stop with \`tailscale ${mode} off\` (server keeps running locally).`);
}

// ── Operator commands (attach to the one running runtime) ───────────────────

function resolveTarget(args, config) {
  return {
    host: args.host || process.env.PC_CONTROL_HOST || "127.0.0.1",
    port: args.port || (process.env.PC_CONTROL_PORT ? Number(process.env.PC_CONTROL_PORT) : null)
      || config.port || 3000,
  };
}

// { s } authed, { auth:false } on 401/403 (alive, wrong key), null when down.
async function probeStatus(host, port, key) {
  try {
    const r = await fetch(`http://${host}:${port}/status`, {
      headers: { authorization: "Bearer " + key },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401 || r.status === 403) return { auth: false };
    if (!r.ok) return null;
    const s = await r.json();
    return (s && s.status === "running") ? { s } : null;
  } catch {
    return null;
  }
}

function guiConfigPath() {
  const base = process.env.APPDATA
    || (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Roaming") : null);
  return base ? path.join(base, "pc-control-mcp-desktop", "config.json") : null;
}

function keyMismatchHint() {
  const g = guiConfigPath();
  return `already running here, but this config's key is refused (HTTP 401) — same box, two configs.\n` +
    (g && fs.existsSync(g)
      ? `  point at the GUI config: --config "${g}"`
      : `  use the config of the running server, or rotate + restart it.`);
}

// Same-box key fallback: when this config's key is refused but the GUI
// face's key opens the running server, use it for this run and say so.
// This is what makes a fresh `pc-control doctor` work without flags.
let _attachNoteShown = false;
async function reconcileAttachKey(config, target) {
  if (!config || !config.api_key) return;
  const first = await probeStatus(target.host, target.port, config.api_key);
  if (first && first.s) return; // key works ({auth:false} means refused — fall through to the GUI key)
  const gp = guiConfigPath();
  let guiKey = null;
  try { guiKey = gp && fs.existsSync(gp) ? JSON.parse(fs.readFileSync(gp, "utf8")).api_key : null; } catch {}
  if (!guiKey || String(guiKey) === String(config.api_key)) return;
  const second = await probeStatus(target.host, target.port, String(guiKey));
  if (second && second.s) {
    config.api_key = String(guiKey);
    if (!_attachNoteShown) {
      _attachNoteShown = true;
      try { console.error(dim(`note: this config's key was refused — using the GUI face's key for this run (${keyFp(config.api_key)}).`)); } catch {}
    }
  }
}

async function cmdDashboard(args, config, target) {
  const found = await probeStatus(target.host, target.port, config.api_key);
  if (!found) {
    console.error(red(`● down: nothing answers on ${target.host}:${target.port} — is it running?`));
    process.exit(1);
  }
  if (!found.s) {
    console.error(yellow("▲") + " " + keyMismatchHint());
    process.exit(1);
  }
  const s = found.s;
  const url = `http://${target.host}:${target.port}/app`;
  console.error(`${green("●")} ${bold("up")}  ${cyan(s.mode || "?")} ${dim("v" + (s.version || "?"))}`);
  console.error(`  console  ${cyan(url)}  ${dim(`(${s.tools ?? "?"} tools, ${s.sessions ?? "?"} sessions)`)}`);
  if (!args.noOpen) openBrowser(url);
}

function openBrowser(url) {
  // Best-effort only: a failed open must never fail the command.
  try {
    const { execFile } = require("child_process");
    const cmd = process.platform === "win32" ? "cmd"
      : process.platform === "darwin" ? "open" : "xdg-open";
    const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    execFile(cmd, argv, { stdio: "ignore", windowsHide: true });
  } catch {}
}

async function cmdDoctor(args, config, target, configPath) {
  const checks = [];
  const ok = (name, detail) => checks.push({ name, status: "ok", detail });
  const warn = (name, detail) => checks.push({ name, status: "warn", detail });
  const fail = (name, detail) => checks.push({ name, status: "fail", detail });

  // 1. node runtime
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok("node", process.versions.node);
  else fail("node", `${process.versions.node} — need >= 22`);

  // 2. config exists + parses
  let raw = null;
  try { raw = fs.readFileSync(configPath, "utf8"); JSON.parse(raw); ok("config", configPath); }
  catch { fail("config", `unreadable: ${configPath}`); }

  // 3. owner key present
  if (config.api_key && String(config.api_key).trim()) ok("api_key", "sha256:" +
    crypto.createHash("sha256").update(String(config.api_key)).digest("hex").slice(0, 12));
  else fail("api_key", "empty — run --setup to generate");

  // 4. port sane
  const port = config.port || 3000;
  if (Number.isInteger(port) && port > 0 && port < 65536) ok("port", String(port));
  else fail("port", `invalid: ${port}`);

  // 5. approval mode known
  if (["always", "intermediate", "turbo"].includes(config.permission_mode || "always"))
    ok("approval", config.permission_mode || "always");
  else fail("approval", `unknown: ${config.permission_mode}`);

  // 6. tool registry loads
  try {
    const { getToolList } = require("../../lib/registry");
    const n = getToolList().length + (SHELL_EXTRA ? 1 : 0); // + shell_exec off-Windows
    if (n > 0) ok("tools", `${n} active`);
    else fail("tools", "registry empty");
  } catch (err) { fail("tools", `registry failed: ${err.message}`); }

  // 7. config permissions (POSIX)
  if (process.platform === "win32") ok("perms", "n/a on windows");
  else {
    try {
      const st = fs.statSync(configPath);
      if ((st.mode & 0o077) === 0) ok("perms", "600");
      else { warn("perms", "readable beyond owner"); checks._fixPerms = true; }
    } catch { warn("perms", "cannot stat"); }
  }

  // 8. disk space
  try {
    const sfs = fs.statfsSync(path.dirname(configPath));
    const freeGB = (Number(sfs.bfree) * Number(sfs.bsize)) / 1e9;
    if (freeGB > 1) ok("disk", `${freeGB.toFixed(1)} GB free`);
    else warn("disk", `${freeGB.toFixed(2)} GB free — tight`);
  } catch { warn("disk", "cannot measure"); }

  // 9. tailscale present (info only — localhost is a valid setup)
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync("tailscale", ["version"], { encoding: "utf8", timeout: 10000 });
    if (!r.error && r.status === 0) ok("tailscale", (r.stdout || "").trim().split("\n")[0]);
    else warn("tailscale", "not installed — localhost only");
  } catch { warn("tailscale", "not installed — localhost only"); }

  // 10. runtime answers (warn, not fail — stopped server is not broken config)
  const found = await probeStatus(target.host, target.port, config.api_key);
  if (found && found.s) ok("runtime", `${found.s.mode || "?"} up ${found.s.uptime_seconds ?? "?"}s`);
  else if (found) fail("runtime", "answers but refuses this key (401) — point --config at the running server's config");
  else warn("runtime", `nothing on ${target.host}:${target.port}`);

  // 11. hosted relay membership (config only — dialing happens at boot)
  if (config.relay_enabled === false) ok("relay", "off by config — direct-only");
  else if (!config.name) warn("relay", "no `name` — direct-only until one is set");
  else ok("relay", `room ${config.name} @ ${config.relay_domain || "mcp.solisk.org"}`);

  if (args.fix) {
    // Only what is safe and unambiguous: file perms + empty owner key.
    try {
      if (process.platform !== "win32" && fs.existsSync(configPath)) fs.chmodSync(configPath, 0o600);
    } catch {}
    if (!config.api_key || !String(config.api_key).trim()) {
      config.api_key = crypto.randomBytes(24).toString("hex");
      require("../../lib/config-repair").writeConfigAtomic(configPath, config);
      console.error("fix: generated a new owner api_key — store it from `config get`? No: re-run --setup to see it.");
    }
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  if (args.json) {
    console.log(JSON.stringify({ fails, warns, checks }, null, 2)); // stdout: pipeable
  } else {
    console.error(bold("pc-control doctor"));
    const width = Math.max(...checks.map((c) => c.name.length));
    for (const c of checks)
      console.error(`  ${tick(c.status)} ${c.name.padEnd(width)}  ${c.status === "ok" ? dim(c.detail) : c.status === "warn" ? yellow(c.detail) : red(c.detail)}`);
    const summary = fails > 0 ? red(`${fails} failing`) : green("0 failing");
    console.error(`  ${dim("—")} ${summary}${dim(",")} ${warns > 0 ? yellow(`${warns} warnings`) : dim("0 warnings")}`);
  }
  if (args.lint && fails > 0) process.exit(2);
}

// Writable from the CLI. Secrets stay out — use rotate-key / keys.
const CONFIG_WRITABLE = new Set(["port", "permission_mode", "allowed_paths", "denied_paths",
  "rate_limit", "disabled_tools", "autostart", "relay_enabled", "relay_domain", "name",
  "dashboard_enabled", "tunnel_mode", "tunnel_hostname", "tunnel_name"]);
const CONFIG_SECRET = new Set(["api_key", "previous_api_key", "user_keys", "oauth_client_secret", "oauth_client_id", "tunnel_token"]);

function cmdConfig(args, config, configPath) {
  const [op, key, ...rest] = args.subArgs;
  const configRepair = require("../../lib/config-repair");
  if (op === "validate" || (!op && !key)) {
    const { valid, problems } = configRepair.validateConfig(config);
    if (valid) { console.error("valid"); return; }
    for (const p of problems) console.error(`invalid: ${p}`);
    process.exit(2);
  }
  if (op === "get") {
    if (!key) { console.error(`unknown key: (missing)`); process.exit(2); }
    if (CONFIG_SECRET.has(key)) { console.error(`${key} is a secret — it is never printed. Use rotate-key.`); process.exit(2); }
    let v = config[key];
    let srcNote = "";
    if (v === undefined) {
      // Same-box fallback: the GUI face owns keys this config never set.
      try {
        const gp = guiConfigPath();
        const g = gp && fs.existsSync(gp) ? JSON.parse(fs.readFileSync(gp, "utf8")) : null;
        if (g && g[key] !== undefined && !CONFIG_SECRET.has(key)) { v = g[key]; srcNote = "  (from GUI config)"; }
      } catch {}
    }
    if (v === undefined) { console.error(`unknown key: ${key}`); process.exit(2); }
    console.error((typeof v === "object" ? JSON.stringify(v) : String(v)) + (srcNote ? dim(srcNote) : ""));
    return;
  }
  if (op === "set") {
    if (!key) { console.error("usage: config set <key> <value>"); process.exit(2); }
    if (CONFIG_SECRET.has(key)) { console.error(`${key} is managed — use rotate-key, not config set.`); process.exit(2); }
    if (!CONFIG_WRITABLE.has(key)) { console.error(`refusing to set ${key} (not a CLI-managed key)`); process.exit(2); }
    let value;
    try { value = JSON.parse(rest.join(" ")); }
    catch { value = rest.join(" "); } // bare strings stay strings
    if (key === "relay_domain" && !isBareHostname(value)) {
      console.error("rejected: relay_domain must be a bare hostname (no https://, path, or port)");
      process.exit(2);
    }
    const before = config[key];
    config[key] = value;
    const { valid, problems } = configRepair.validateConfig(config);
    if (!valid) {
      config[key] = before; // revert — never persist a broken config
      console.error(`rejected: ${problems.join("; ")}`);
      process.exit(2);
    }
    configRepair.writeConfigAtomic(configPath, config);
    console.error(`${green("●")} ${bold("ok")}  ${key} = ${cyan(typeof value === "object" ? JSON.stringify(value) : value)}`);
    console.error(dim("  note: a running server picks this up on restart (live reload lands in v2)."));
    return;
  }
  console.error("usage: config get <key> | set <key> <value> | validate");
  process.exit(2);
}

function cmdRotateKey(config, configPath) {
  const old = String(config.api_key || "");
  const next = crypto.randomBytes(24).toString("hex"); // matches schema repair length
  config.previous_api_key = old; // zero-downtime: relay handshake still accepts the old key
  config.api_key = next;
  require("../../lib/config-repair").writeConfigAtomic(configPath, config);
  const fp = crypto.createHash("sha256").update(next).digest("hex").slice(0, 12);
  console.error(bold("key rotated") + `  ${dim("sha256:")}${fp}`);
  console.error(`  new key  ${bold(yellow(next))}`);
  console.error(red("  Store it now — it is never printed again.") + dim(" Restart the server and re-pair relay clients."));
}

function cmdLogs(args, configPath) {
  const lines = Math.min(Math.max(Number(args.lines) || 50, 1), 200);
  let auditLogPath = null;
  // Same-box first: the running server (usually the GUI face) owns the live log.
  try {
    const gp = guiConfigPath();
    const guiLog = gp ? path.join(path.dirname(gp), "logs", "audit.log") : null;
    if (guiLog && fs.existsSync(guiLog)) auditLogPath = guiLog;
  } catch {}
  if (!auditLogPath) {
    try { auditLogPath = require("../../lib/security").auditLogPath; }
    catch { console.error("cannot resolve audit log path"); process.exit(1); }
  }
  const tail = (n) => {
    try {
      const st = fs.statSync(auditLogPath);
      const tailBytes = Math.min(st.size, 1024 * 1024);
      const fd = fs.openSync(auditLogPath, "r");
      const buf = Buffer.alloc(tailBytes || 1);
      if (tailBytes) fs.readSync(fd, buf, 0, tailBytes, st.size - tailBytes);
      fs.closeSync(fd);
      return buf.toString("utf8").split("\n").map((l) => l.slice(0, 500)).filter((l) => l.trim()).slice(-n);
    } catch { return []; }
  };
  if (!args.follow) {
    for (const l of tail(lines)) console.error(l);
    return;
  }
  for (const l of tail(lines)) console.error(l);
  let size = 0;
  try { size = fs.statSync(auditLogPath).size; } catch {}
  const timer = setInterval(() => {
    try {
      const st = fs.statSync(auditLogPath);
      if (st.size < size) size = 0; // rotated — re-read from head
      if (st.size > size) {
        const fd = fs.openSync(auditLogPath, "r");
        const buf = Buffer.alloc(Math.min(st.size - size, 1024 * 1024));
        fs.readSync(fd, buf, 0, buf.length, size);
        fs.closeSync(fd);
        size = st.size;
        for (const l of buf.toString("utf8").split("\n").map((x) => x.slice(0, 500)).filter((x) => x.trim()))
          console.error(l);
      }
    } catch {}
  }, 2000);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// ── GUI install / detect (Windows-only) ─────────────────────────────────────

// Returns { installed, displayName, dir, exe, version }.
function detectGuiInstall() {
  const found = { installed: false, displayName: null, dir: null, exe: null, version: null };
  if (process.platform !== "win32") return found;
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s", "/f", "PC Control"],
      { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    const name = out.match(/DisplayName\s+REG_SZ\s+(.+)/);
    const un = out.match(/UninstallString\s+REG_SZ\s+"([^"]+)"/);
    if (name) found.displayName = name[1].trim();
    if (un) found.dir = path.dirname(un[1]);
  } catch {}
  const dirs = found.dir ? [found.dir] : [];
  const local = process.env.LOCALAPPDATA;
  if (local) dirs.push(path.join(local, "Programs", "PC Control MCP"));
  for (const d of dirs) {
    const exe = path.join(d, "PC Control MCP.exe");
    try {
      if (fs.statSync(exe).isFile()) {
        found.installed = true;
        found.dir = found.dir || d;
        found.exe = exe;
        break;
      }
    } catch {}
  }
  if (found.installed) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(found.dir, "resources", "app", "package.json"), "utf8"));
      if (pkg.version) found.version = pkg.version;
    } catch {}
    if (!found.version && found.displayName) {
      const m = found.displayName.match(/(\d+\.\d+\.\d+[^ ]*)/);
      if (m) found.version = m[1];
    }
  }
  return found;
}

async function cmdGui(args, config, target) {
  const op = args.subArgs[0] || "status";
  if (process.platform !== "win32") {
    console.error("GUI setup is Windows-only — this box is " + process.platform + ".");
    console.error("Grab the Windows installer from https://solisk.org/ and run it on the PC.");
    process.exit(2);
  }
  if (op === "status") {
    const g = detectGuiInstall();
    if (!g.installed) {
      console.error(`${yellow("▲")} GUI ${bold("not installed")} on this machine.`);
      console.error(`  install  ${cyan("pc-control gui setup --installer <path-to-setup-exe>")}`);
    } else {
      console.error(`${green("●")} GUI ${bold("installed")}  ${cyan(g.displayName || "PC Control MCP")} ${dim("v" + (g.version || "?"))}`);
      console.error(`  path     ${cyan(g.dir)}`);
    }
    // Key-fingerprint comparison: the #1 attach failure is two configs.
    try {
      const gp = guiConfigPath();
      if (gp && fs.existsSync(gp)) {
        const gRaw = JSON.parse(fs.readFileSync(gp, "utf8"));
        if (gRaw.api_key) {
          const same = String(gRaw.api_key) === String(config.api_key || "");
          console.error(`  keys     CLI ${dim(keyFp(config.api_key || ""))} vs GUI ${dim(keyFp(gRaw.api_key))} ` +
            (same ? green("match — attach works") : yellow("DIFFER — use --config to attach")));
        }
      }
    } catch {}
    const found = await probeStatus(target.host, target.port, config.api_key);
    if (found && found.s) console.error(`  runtime  ${green("●")} ${bold("up")}  ${cyan(found.s.mode || "?")} — CLI attaches to it, nothing new started.`);
    else if (found) console.error(`  runtime  ${yellow("▲")} ${bold("up but key refused (401)")} — see keys line above.`);
    else console.error(`  runtime  ${dim("stopped — start it from the GUI or `pc-control --mode=http`")}`);
    return;
  }
  if (op === "setup") {
    const g = detectGuiInstall();
    if (g.installed) {
      console.error(`${green("●")} GUI already installed  ${cyan(g.displayName || "")} ${dim("v" + (g.version || "?"))}`);
      console.error(`  path     ${cyan(g.dir)}`);
      console.error(dim("  Nothing to do — `pc-control gui status` shows the runtime."));
      return;
    }
    const installer = args.installer || process.env.PC_CONTROL_GUI_INSTALLER;
    if (!installer || !fs.existsSync(installer)) {
      console.error(red("✖") + " no installer found. Pass it explicitly:");
      console.error(`  ${cyan("pc-control gui setup --installer \"C:\\path\\to\\PC Control MCP Setup 1.0.0.exe\"")}`);
      process.exit(2);
    }
    console.error(`installing GUI from ${cyan(installer)} ${dim("(silent, one launch)")}…`);
    try {
      const { execFileSync } = require("child_process");
      execFileSync(installer, ["/S"], { timeout: 5 * 60 * 1000, stdio: "ignore", windowsHide: true });
    } catch (err) {
      console.error(red("✖") + ` installer failed: ${err.message}`);
      process.exit(1);
    }
    const after = detectGuiInstall();
    if (after.installed) {
      console.error(`${green("●")} GUI ${bold("installed")}  ${cyan(after.displayName || "PC Control MCP")} ${dim("v" + (after.version || "?"))}`);
      console.error(`  path     ${cyan(after.dir)}`);
    } else {
      console.error(red("✖") + " installer finished but no GUI detected — run the setup exe manually once.");
      process.exit(1);
    }
    return;
  }
  console.error("usage: pc-control gui [status] | gui setup [--installer PATH]");
  process.exit(2);
}

// ── Onboarding wizard + key management ──────────────────────────────────────

// Shared with `config set relay_domain`: no scheme, path, port, whitespace.
function isBareHostname(v) {
  return typeof v === "string" && /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(v) && !v.includes("..");
}

async function cmdSetupWizard(config, configPath) {
  if (!process.stdin.isTTY) {
    console.error("setup needs a terminal — use flags instead: `config set <key> <value>` + `rotate-key`.");
    process.exit(2);
  }
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q, def) => new Promise((res) =>
    rl.question(`  ${q} ${dim(`[${def}]`)} `, (a) => res(a.trim() || def)));
  const askYN = async (q, def) => {
    const a = (await ask(q + " (y/n)", def ? "y" : "n")).toLowerCase();
    return a === "y" || a === "yes";
  };

  console.error(bold("pc-control setup") + dim(" — step by step, Enter accepts the default"));
  const fresh = !fs.existsSync(configPath);

  // GUI seeds defaults; its key is adopted when this config has none.
  let guiCfg = null;
  const gp = guiConfigPath();
  if (detectGuiInstall().installed && gp) {
    try { guiCfg = JSON.parse(fs.readFileSync(gp, "utf8")); } catch {}
    if (guiCfg) {
      console.error(`${green("●")} GUI detected — its settings seed the defaults below.`);
      if (!config.api_key && guiCfg.api_key) {
        config.api_key = String(guiCfg.api_key);
        console.error(`  adopted the GUI owner key ${dim(keyFp(config.api_key) + " — both faces attach to one runtime.")}`);
      } else if (config.api_key && guiCfg.api_key && String(config.api_key) !== String(guiCfg.api_key)) {
        console.error(`  ${yellow("▲")} keys differ (CLI ${dim(keyFp(config.api_key))} vs GUI ${dim(keyFp(guiCfg.api_key))}) — step 5 can reunite them.`);
      }
    }
  }
  const gv = (k, fb) => config[k] !== undefined ? config[k] : (guiCfg && guiCfg[k] !== undefined ? guiCfg[k] : fb);

  config.name = await ask("1/5  room name (relay code, lowercase)", gv("name", "pc-" + crypto.randomBytes(4).toString("hex")));

  let port;
  for (;;) {
    const raw = await ask("2/5  local port", String(gv("port", 3000)));
    port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port < 65536) break;
    console.error("  " + red("✖") + " need an integer 1–65535");
  }
  config.port = port;

  let mode;
  for (;;) {
    mode = (await ask("3/5  approval: always | intermediate | turbo", gv("permission_mode", "always"))).toLowerCase();
    if (["always", "intermediate", "turbo"].includes(mode)) break;
    console.error("  " + red("✖") + " pick one of the three");
  }
  config.permission_mode = mode;
  if (mode === "turbo") console.error("  " + yellow("▲") + " turbo lets any authenticated client shell this box");

  config.relay_enabled = await askYN("4/5  join the hosted relay (dial out)?", gv("relay_enabled", true) !== false);
  if (config.relay_enabled) {
    for (;;) {
      const d = await ask("     relay domain", gv("relay_domain", "mcp.solisk.org"));
      if (isBareHostname(d)) { config.relay_domain = d; break; }
      console.error("  " + red("✖") + " bare hostname only — no https://, path, or port");
    }
  }

  const wantKey = fresh || !config.api_key || await askYN("5/5  generate a NEW owner key?", false);
  if (wantKey) {
    if (config.api_key) config.previous_api_key = String(config.api_key); // handover, like rotate-key
    config.api_key = crypto.randomBytes(24).toString("hex");
    if (guiCfg) console.error("  " + yellow("▲") + " new key differs from the GUI key — restart the GUI to re-pair, or reunite via `gui status`.");
  }

  require("../../lib/config-repair").writeConfigAtomic(configPath, config);
  rl.close();

  const live = await probeStatus("127.0.0.1", config.port, config.api_key);
  if (live && live.s) console.error(yellow("▲") + dim(" a runtime is live on this port — restart it to apply these settings."));
  else if (live) console.error(yellow("▲") + dim(" a runtime is live here under a different key — it keeps its old settings until restarted."));

  const fp = crypto.createHash("sha256").update(String(config.api_key)).digest("hex").slice(0, 12);
  console.error(`\n${green("●")} ${bold("ready")}  ${cyan(configPath)}`);
  console.error(`  room     ${cyan(config.name)} ${config.relay_enabled ? dim("@ " + (config.relay_domain || "mcp.solisk.org")) : dim("(direct-only)")}`);
  console.error(`  port     ${cyan(String(config.port))}   approval ${cyan(config.permission_mode)}`);
  if (wantKey) {
    console.error(`  key      ${bold(yellow(String(config.api_key)))} ${dim("sha256:" + fp)}`);
    console.error(red("  Store it now — it is never printed again."));
  }
  console.error(dim(`  next: pc-control --mode=http   ·   pc-control dashboard   ·   pc-control doctor`));
}

const KEY_SCOPES = ["mcp:tools", "mcp:resources"];

function keyFp(k) {
  return "sha256:" + crypto.createHash("sha256").update(String(k)).digest("hex").slice(0, 12);
}

function cmdKeys(args, config, configPath) {
  const configRepair = require("../../lib/config-repair");
  const save = () => configRepair.writeConfigAtomic(configPath, config);
  const keys = () => { if (!Array.isArray(config.user_keys)) config.user_keys = []; return config.user_keys; };
  const [op, ...rest] = args.subArgs;

  if (op === "list" || !op) {
    const ks = keys();
    if (!ks.length) { console.error(dim("no client keys — `keys add <label>` creates one (read-only by default).")); return; }
    console.error(bold("client keys") + dim(` (${ks.length})`));
    const w = Math.max(...ks.map((k) => String(k.label || k.id || "?").length));
    for (const k of ks) {
      const raw = String(k.api_key || k.key || "");
      console.error(`  ${green("●")} ${(String(k.label || k.id || "?")).padEnd(w)}  ${dim((Array.isArray(k.scopes) ? k.scopes : []).join(",") || "no-scopes")}  ${dim(raw ? keyFp(raw) : "empty")}`);
    }
    console.error(dim("  full keys are never printed — `revoke` + re-`add` to replace one."));
    return;
  }

  if (op === "add") {
    const label = rest.find((a) => !a.startsWith("--"));
    if (!label) { console.error("usage: keys add <label> [--scopes mcp:resources,mcp:tools]"); process.exit(2); }
    if (keys().some((k) => k.label === label || k.id === label)) {
      console.error(red("✖") + ` a key named "${label}" already exists — revoke it first or pick another label.`);
      process.exit(2);
    }
    let scopes = ["mcp:resources"]; // fail closed: read-only unless asked
    const scRaw = args.scopes || (() => {
      const f = rest.find((a) => a.startsWith("--scopes"));
      if (!f) return null;
      return f.includes("=") ? f.slice(f.indexOf("=") + 1) : rest[rest.indexOf(f) + 1] || "";
    })();
    if (scRaw) {
      scopes = scRaw.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = scopes.filter((s) => !KEY_SCOPES.includes(s));
      if (!scopes.length || bad.length) {
        console.error(red("✖") + ` scopes must be from: ${KEY_SCOPES.join(", ")}`);
        process.exit(2);
      }
    }
    const secret = crypto.randomBytes(24).toString("hex");
    const entry = { id: "key_" + crypto.randomBytes(3).toString("hex"), label, api_key: secret, scopes };
    keys().push(entry);
    save();
    console.error(`${green("●")} ${bold("key added")}  ${cyan(label)} ${dim(`(${entry.id}, ${scopes.join(",")})`)}`);
    console.error(`  key      ${bold(yellow(secret))}`);
    console.error(red("  Store it now — it is never printed again."));
    return;
  }

  if (op === "revoke") {
    const sel = rest[0];
    if (!sel) { console.error("usage: keys revoke <id|label|key-prefix>"); process.exit(2); }
    const ks = keys();
    const idx = ks.findIndex((k) =>
      k.id === sel || k.label === sel ||
      (sel.length >= 8 && String(k.api_key || k.key || "").startsWith(sel)));
    if (idx === -1) { console.error(red("✖") + ` no key matches "${sel}".`); process.exit(2); }
    const [gone] = ks.splice(idx, 1);
    save();
    console.error(`${green("●")} ${bold("revoked")}  ${cyan(gone.label || gone.id)} — connected clients using it drop on next call.`);
    return;
  }

  console.error("usage: keys list | add <label> [--scopes s] | revoke <id|label|prefix>");
  process.exit(2);
}

// ── Relay status + retry ────────────────────────────────────────────────────
async function cmdRelay(args, config, target) {
  const op = args.subArgs[0] || "status";
  const show = (st) => {
    const dot = st.state === "connected" ? green("●") : st.state === "paused" ? red("✖") : yellow("▲");
    console.error(`  ${dot} relay ${bold(st.state)}` +
      (st.room ? `  room ${cyan(st.room)}` : "") +
      (st.domain ? dim(` @ ${st.domain}`) : "") +
      (st.attempt ? dim(` attempt ${st.attempt}`) : ""));
  };
  if (op === "retry") {
    // Same process: direct. Another process (GUI or server): via its endpoint.
    try {
      if (require("../../lib/relay-client").retryRelay()) {
        console.error(`${green("●")} relay retry triggered (this process).`);
        return;
      }
    } catch {}
    try {
      const r = await fetch(`http://${target.host}:${target.port}/relay/retry`, {
        method: "POST",
        headers: { authorization: "Bearer " + config.api_key },
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 401 || r.status === 403) { console.error(yellow("▲") + " " + keyMismatchHint()); process.exit(1); }
      if (!r.ok) { console.error(red(`● retry refused: HTTP ${r.status}`)); process.exit(1); }
      const st = await r.json().catch(() => ({}));
      if (st && st.ok && st.via === "shell") {
        console.error(`${green("●")} relay retry sent to the running app — watch its status go live.`);
        return;
      }
      show(st.relay || st);
      return;
    } catch (err) {
      console.error(red(`● no live runtime to retry (${err.message}) — start one first.`));
      process.exit(1);
    }
  }
  if (op === "status") {
    try {
      const st = require("../../lib/relay-client").getRelayState();
      if (st.state !== "idle") { show(st); return; }
    } catch {}
    const found = await probeStatus(target.host, target.port, config.api_key).catch(() => null);
    if (found && found.s && found.s.relay) { show(found.s.relay); return; }
    if (found && found.s && found.s.relayUrl) {
      // Desktop runtime shape: URL derived from the live config.
      const m = String(found.s.relayUrl).match(/^https?:\/\/([^/]+)\/mcp\/(.+)$/);
      show({ state: "connected", room: m ? m[2] : config.name, domain: m ? m[1] : undefined });
      return;
    }
    if (found && !found.s) { console.error(yellow("▲") + " " + keyMismatchHint()); process.exit(1); }
    if (config.relay_enabled === false) console.error(dim("relay off by config — direct-only."));
    else if (!config.name) console.error(dim("relay not configured — no `name` yet (`setup` step 1)."));
    else console.error(dim(`relay intended: room ${config.name} — no live runtime answering on ${target.host}:${target.port}.`));
    return;
  }
  console.error("usage: pc-control relay [status] | retry");
  process.exit(2);
}

// ── Tunnel + tailscale (same service the GUI uses) ──────────────────────────
async function cmdTunnel(args, config, configPath) {
  const svc = require("../../lib/tunnel-service");
  const configRepair = require("../../lib/config-repair");
  const save = () => configRepair.writeConfigAtomic(configPath, config);
  const [op, ...rest] = args.subArgs;

  if (!op || op === "status") {
    const st = svc.getState();
    console.error(bold("tunnel") + dim(`  mode ${cyan(config.tunnel_mode || "quick")}`));
    console.error(`  cloudflared  ${svc.cloudflaredInstalled() ? green("installed") : yellow("missing")}   login  ${svc.loginDone() ? green("done") : dim("no")}`);
    if (st.kind === "off") console.error(`  state        ${dim("off")}`);
    else console.error(`  state        ${st.kind}${st.url ? "  " + cyan(st.url) : dim("  (starting…)")}`);
    if (config.tunnel_hostname) console.error(`  hostname     ${cyan(config.tunnel_hostname)}   token  ${config.tunnel_token ? dim("stored") : yellow("missing")}`);
    console.error(dim("  mode changes apply on restart (`config set tunnel_mode off|quick|custom`)."));
    // Same-box live state: the running server (usually the GUI face) may
    // differ from this file — show both so they can't silently disagree.
    try {
      const live = await (async () => {
        const { host, port } = resolveTarget({}, config);
        const r = await fetch(`http://${host}:${port}/api/tunnel`, {
          headers: { authorization: "Bearer " + config.api_key },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return null;
        return await r.json().catch(() => null);
      })();
      if (live && (live.mode !== (config.tunnel_mode || "quick") || (live.hostname || "") !== (config.tunnel_hostname || ""))) {
        console.error(`  ${yellow("▲")} live server: mode ${cyan(live.mode || "?")}` +
          (live.hostname ? `  hostname ${cyan(live.hostname)}` : "") +
          (live.state && live.state.url ? `  url ${cyan(live.state.url)}` : "") +
          dim("  (GUI face — `config set` edits this file)"));
      } else if (live) {
        console.error(`  ${green("●")} live server agrees${live.state && live.state.url ? dim(` — ${live.state.url}`) : ""}`);
      }
    } catch {}
    return;
  }
  if (["off", "quick", "custom"].includes(op)) {
    if (op === "custom" && (!config.tunnel_token || !config.tunnel_hostname)) {
      console.error(red("✖") + " custom needs token + hostname — run `tunnel login`, `create`, `route` first.");
      process.exit(2);
    }
    config.tunnel_mode = op;
    save();
    console.error(`${green("●")} tunnel mode ${bold(op)} — applies on restart.`);
    return;
  }
  if (op === "login") {
    const bin = svc.resolveCloudflared();
    if (!bin) { console.error(red("✖") + " cloudflared not found."); process.exit(1); }
    console.error("opening Cloudflare login in your browser — pick the domain, then return here.");
    try {
      const { spawnSync } = require("child_process");
      spawnSync(bin, ["login"], { stdio: "inherit", timeout: 10 * 60 * 1000 });
    } catch (err) {
      console.error(red("✖") + ` login failed: ${err.message}`);
      process.exit(1);
    }
    console.error(svc.loginDone() ? `${green("●")} login complete.` : yellow("▲") + " no certificate yet — run `tunnel login` again after the browser step.");
    return;
  }
  if (op === "create") {
    const bin = svc.resolveCloudflared();
    if (!bin) { console.error(red("✖") + " cloudflared not found."); process.exit(1); }
    const name = (rest[0] || "pc-control").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "pc-control";
    const r = svc.createNamedTunnel(bin, name);
    if (!r.ok) { console.error(red("✖") + " tunnel create failed."); process.exit(1); }
    config.tunnel_name = r.name || name;
    save();
    console.error(`${green("●")} tunnel "${cyan(r.name || name)}" ready${r.reused ? dim(" (reused)") : ""}. Next: \`tunnel route <hostname>\`.`);
    return;
  }
  if (op === "route") {
    const host = rest[0] || "";
    const bin = svc.resolveCloudflared();
    if (!bin) { console.error(red("✖") + " cloudflared not found."); process.exit(1); }
    if (!isBareHostname(host)) { console.error(red("✖") + " bare hostname only."); process.exit(2); }
    const name = config.tunnel_name || "pc-control";
    const routed = svc.routeDns(bin, name, host);
    if (!routed.ok) { console.error(red("✖") + " DNS route failed."); process.exit(1); }
    const tok = svc.fetchToken(bin, name);
    if (!tok.ok) { console.error(red("✖") + " token fetch failed."); process.exit(1); }
    config.tunnel_hostname = host;
    config.tunnel_token = tok.token;
    save();
    console.error(`${green("●")} https://${cyan(host)} routed, token stored (never shown). Set \`tunnel custom\` to use it.`);
    return;
  }
  if (op === "forget") {
    config.tunnel_token = "";
    config.tunnel_hostname = "";
    if (config.tunnel_mode === "custom") config.tunnel_mode = "quick";
    save();
    console.error(`${green("●")} custom tunnel forgotten — back to quick.`);
    return;
  }
  console.error("usage: tunnel [status] | off | quick | custom | login | create [name] | route <host> | forget");
  process.exit(2);
}

function cmdTailscale(args, config, target) {
  const svc = require("../../lib/tunnel-service");
  const [op] = args.subArgs;
  if (!op || op === "status") {
    if (!svc.tailscaleBin()) { console.error(dim("tailscale not installed — localhost only.")); return; }
    const st = svc.tailscaleStatus();
    console.error(st.loggedIn
      ? `${green("●")} tailnet  ${cyan("https://" + st.dns)}`
      : `${yellow("▲")} installed, not logged in — run \`tailscale up\`.`);
    return;
  }
  if (op === "serve" || op === "funnel") {
    if (op === "funnel" && !args.yes) {
      console.error(red("✖") + " funnel publishes to the public internet — re-run with --yes to confirm.");
      process.exit(2);
    }
    const r = svc.tailscaleServe(target.port, op === "funnel");
    if (!r.ok) { console.error(red("✖") + ` ${r.error}`); process.exit(1); }
    console.error(`${green("●")} tailscale ${op} live${r.url ? `  ${cyan(r.url)}` : ""} ${dim("(dashboard + MCP)")}`);
    console.error(dim(`  stop: \`tailscale off\` (server keeps running locally).`));
    return;
  }
  if (op === "off") {
    svc.tailscaleOff();
    console.error(`${green("●")} tailscale exposure off.`);
    return;
  }
  console.error("usage: tailscale [status] | serve | funnel | off");
  process.exit(2);
}

function cmdBackup(configPath) {
  if (!fs.existsSync(configPath)) { console.error(`no config at ${configPath} — run --setup first`); process.exit(1); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(path.dirname(configPath), `config-backup-${stamp}.json`);
  fs.copyFileSync(configPath, dest);
  if (process.platform !== "win32") { try { fs.chmodSync(dest, 0o600); } catch {} }
  console.error(`${green("●")} ${bold("backup")}  ${cyan(dest)}`);
}

main().catch((err) => {
  console.error(`fatal: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
