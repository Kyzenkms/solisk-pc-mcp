#!/usr/bin/env node
/**
 * PC Control MCP PRO — Terminal App (Production Grade)
 *
 * Runs the MCP server in-process, then connects to:
 *   1. Cloudflare Tunnel (for public HTTPS URL)
 *   2. VPS Relay Server (for stable permanent URL)
 *
 * Usage:
 *   node app.js              — start with existing config
 *   node app.js --setup      — run first-time setup wizard
 *   node app.js --port=8080  — override port
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const crypto = require("crypto");

const CONFIG_DIR  = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
process.env.MCP_CONFIG_PATH = CONFIG_FILE;

const { log } = require("./lib/middleware");

function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE,"utf8")); } catch { return {}; } }
function saveConfig(c) { fs.mkdirSync(path.dirname(CONFIG_FILE),{recursive:true}); fs.writeFileSync(CONFIG_FILE,JSON.stringify(c,null,2)); }
function ask(q) {
  const rl = readline.createInterface({input:process.stdin,output:process.stdout});
  return new Promise(r => rl.question(`\x1b[36m❯\x1b[0m ${q} `, a => { rl.close(); r(a.trim()); }));
}

const C = { reset:"\x1b[0m", bold:"\x1b[1m", cyan:"\x1b[36m", green:"\x1b[32m",
            yellow:"\x1b[33m", red:"\x1b[31m", dim:"\x1b[2m", magenta:"\x1b[35m" };

function banner(lines, col=C.cyan) {
  const W=56, B="═".repeat(W);
  console.log(`\n${col}╔${B}╗${C.reset}`);
  for (const l of lines) {
    const raw=l.replace(/\x1b\[[0-9;]*m/g,""); const pad=W-raw.length;
    console.log(`${col}║${C.reset} ${l}${" ".repeat(Math.max(0,pad-1))}${col}║${C.reset}`);
  }
  console.log(`${col}╚${B}╝${C.reset}\n`);
}

// ── Setup Wizard ───────────────────────────────────────────────────────────────

async function setup() {
  console.clear();
  banner([
    `${C.bold}${C.magenta}PC Control MCP PRO${C.reset}`,
    `${C.dim}Give AI full control of your Windows PC${C.reset}`,
    ``,
    `${C.yellow}⚡ First-time setup — 30 seconds${C.reset}`,
  ], C.magenta);

  // ── Step 1: Name ──────────────────────────────────────────────────────────
  console.log(`${C.bold}STEP 1 / 3${C.reset}  Pick your name\n`);
  console.log(`This becomes part of your permanent URL.`);
  console.log(`${C.dim}e.g.  john-pc · alice-home · myagent${C.reset}\n`);

  let name="";
  while (!name) {
    const raw = await ask("Your name (letters, numbers, hyphens):");
    name = raw.toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/^-+|-+$/g,"");
    if (!name) console.log(`${C.red}✗ Invalid — try again\n${C.reset}`);
  }

  // ── Step 2: Security ──────────────────────────────────────────────────────
  console.log(`${C.bold}STEP 2 / 3${C.reset}  Security\n`);

  const apiKey = crypto.randomBytes(24).toString("hex");
  console.log(`${C.green}✔ Generated secure API key (authentication always required)${C.reset}\n`);

  // ── Step 3: Relay ─────────────────────────────────────────────────────────
  console.log(`${C.bold}STEP 3 / 3${C.reset}  Relay server\n`);

  const relayDomain = await ask("Relay server domain (Enter for default VPS):");
  const relayDomainFinal = relayDomain || "mcp.solisk.org";

  const cfg = loadConfig();
  cfg.name    = name;
  cfg.token   = crypto.randomUUID();
  cfg.api_key = apiKey;
  cfg.port    = cfg.port || 3000;
  cfg.relay_domain = relayDomainFinal;
  cfg.relay_url = `https://${relayDomainFinal}`;
  cfg.ready   = true;
  saveConfig(cfg);

  console.log(`\n${C.green}✔ Configuration saved!${C.reset}\n`);

  banner([
    `${C.bold}${C.green}Setup Complete!${C.reset}`,
    ``,
    `  ${C.dim}Your PC name:  ${C.bold}${name}${C.reset}`,
    `  ${C.dim}Port:          ${cfg.port}${C.reset}`,
    `  ${C.dim}Auth:          API Key ✓${C.reset}`,
    `  ${C.dim}Relay:         ${relayDomainFinal}${C.reset}`,
    ``,
    `  ${C.cyan}URLs will be shown when server starts.${C.reset}`,
    ``,
    `  ${C.dim}Add to:${C.reset}`,
    `  • ${C.bold}ChatGPT${C.reset}  → Settings → Connectors`,
    `  • ${C.bold}Claude.ai${C.reset} → Settings → Integrations`,
    `  • ${C.bold}Cursor${C.reset}    → Settings → MCP`,
  ], C.green);

  return cfg;
}

// ── Relay Connection ────────────────────────────────────────────────────────────

async function startRelayConnection(cfg) {
  const { startRelayClient } = require("./lib/relay-client");
  startRelayClient(cfg);
}

// ── Cloudflare Tunnel ───────────────────────────────────────────────────────────

async function startTunnel(cfg) {
  const cfPath = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
  const port   = cfg.port || 3000;

  if (!fs.existsSync(cfPath)) {
    console.log(`${C.yellow}⚠  cloudflared not found — tunnel skipped${C.reset}`);
    console.log(`   Run: winget install Cloudflare.cloudflared\n`);
    return;
  }

  console.log(`${C.dim}Starting Cloudflare tunnel...${C.reset}`);

  const tryTunnel = () => {
    const proc = spawn(cfPath, ["tunnel","--url",`http://localhost:${port}`], {
      stdio: ["ignore","pipe","pipe"]
    });

    let urlFound = false;
    const onData = (data) => {
      const t = data.toString();
      const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !urlFound) {
        urlFound = true;
        const url = m[0];
        console.log("\n" + "─".repeat(54));
        console.log(`${C.bold}${C.green}  ✔ CLOUDFLARE TUNNEL LIVE${C.reset}`);
        console.log(`${C.bold}${C.cyan}  ${url}/mcp${C.reset}`);
        console.log(`  ${C.dim}↑ paste into ChatGPT / Claude.ai${C.reset}`);
        console.log("─".repeat(54) + "\n");
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("close", () => {
      console.log(`${C.yellow}⟳ Tunnel dropped — reconnecting in 5s...${C.reset}`);
      setTimeout(tryTunnel, 5000);
    });
  };

  setTimeout(tryTunnel, 1500);
}

// ── Main ──────────────────────────────────────────────────────────────────────────

async function main() {
  let cfg = loadConfig();

  // Parse port override
  const portArg = process.argv.find(a => a.startsWith("--port"));
  if (portArg) {
    cfg.port = portArg.startsWith("--port=") ? parseInt(portArg.split("=")[1]) : parseInt(process.argv[process.argv.indexOf(portArg)+1]);
  }

  if (!cfg.ready || process.argv.includes("--setup")) {
    cfg = await setup();
  } else {
    console.clear();
    banner([
      `${C.bold}${C.magenta}PC Control MCP PRO${C.reset}  v2.0`,
      ``,
      `${C.dim}Name:   ${cfg.name}${C.reset}`,
      `${C.dim}Port:   ${cfg.port || 3000}${C.reset}`,
      `${C.dim}Auth:   API Key ✓${C.reset}`,
      ``,
      `${C.green}Starting server + tunnel + relay...${C.reset}`,
    ], C.magenta);
  }

  // Start MCP server in-process
  const { startHttp } = require("./index");
  await startHttp(cfg.port || 3000);
  console.log(`${C.green}✔ MCP server running — ${require("./lib/registry").ALL_TOOLS.length} tools loaded${C.reset}`);

  // Start tunnel + relay
  await startTunnel(cfg);
  await startRelayConnection(cfg);

  console.log(`${C.dim}Press Ctrl+C to stop.${C.reset}\n`);
  process.on("SIGINT", () => { console.log(`\n${C.yellow}Shutting down...${C.reset}`); process.exit(0); });
}

main().catch(e => { console.error(`\n${C.red}Fatal: ${e.message}${C.reset}`); process.exit(1); });
