#!/usr/bin/env node
/**
 * PC Control MCP - Setup & Tunnel Manager
 * Gives each user a permanent URL via Serveo.net (no domain needed)
 * Usage:
 *   node tunnel.js setup     → pick your permanent name
 *   node tunnel.js start     → start tunnel with saved name
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn, execSync } = require("child_process");

const CONFIG_FILE = path.join(__dirname, "config.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

async function setup() {
  const config = loadConfig();

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║     PC Control MCP — One-Time Setup          ║");
  console.log("╚══════════════════════════════════════════════╝\n");
  console.log("Pick a unique name for your permanent MCP URL.");
  console.log("This will be YOUR URL forever — it never changes.\n");
  console.log("Examples: john-pc, alice-home, myagent2024\n");

  let name = await ask("Enter your chosen name (letters, numbers, hyphens only): ");
  name = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");

  if (!name) { console.log("❌ Invalid name."); process.exit(1); }

  config.tunnel_name = name;
  config.tunnel_url = `https://${name}.serveo.net`;
  config.mcp_url = `https://${name}.serveo.net/mcp`;
  saveConfig(config);

  console.log(`\n✅ Name saved: "${name}"`);
  console.log(`\n🔗 Your permanent MCP URL:`);
  console.log(`   ${config.mcp_url}`);
  console.log(`\n📌 Add this URL to Claude.ai / ChatGPT — it will NEVER change.`);
  console.log(`\nRun "npm run tunnel" to start your tunnel anytime.\n`);
}

async function startTunnel() {
  const config = loadConfig();

  if (!config.tunnel_name) {
    console.log("❌ No name configured. Run: node tunnel.js setup");
    process.exit(1);
  }

  const name = config.tunnel_name;
  const url = config.mcp_url;

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║     PC Control MCP — Starting Tunnel         ║`);
  console.log(`╠══════════════════════════════════════════════╣`);
  console.log(`║  Your permanent MCP URL:                     ║`);
  console.log(`║  ${url.padEnd(44)}║`);
  console.log(`╠══════════════════════════════════════════════╣`);
  console.log(`║  Add this to Claude.ai / ChatGPT once.       ║`);
  console.log(`║  This URL never changes! ✅                  ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log(`Connecting tunnel... (keep this window open)\n`);

  // Use SSH to create Serveo tunnel (SSH is built into Windows 10/11)
  // -R name:80:localhost:PORT forwards the subdomain to local port
  const port = config.port || 3000;

  const ssh = spawn("ssh", [
    "-o", "StrictHostKeyChecking=no",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
    "-R", `${name}:80:localhost:${port}`,
    "serveo.net"
  ], { stdio: "inherit" });

  ssh.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error("❌ SSH not found. Try running from Windows Terminal or PowerShell 7.");
      console.error("   Or use: npm run tunnel:cf (Cloudflare fallback)");
    } else {
      console.error("❌ SSH error:", err.message);
    }
    process.exit(1);
  });

  ssh.on("close", (code) => {
    console.log(`\nTunnel closed (code ${code}). Restarting in 5 seconds...`);
    setTimeout(() => startTunnel(), 5000);
  });
}

// ── Entry ──────────────────────────────────────────────────────────────────
const command = process.argv[2];
if (command === "setup") {
  setup().catch(console.error);
} else if (command === "start" || !command) {
  startTunnel().catch(console.error);
} else {
  console.log("Usage:");
  console.log("  node tunnel.js setup   → pick your permanent name (do this once)");
  console.log("  node tunnel.js start   → start the tunnel");
}
