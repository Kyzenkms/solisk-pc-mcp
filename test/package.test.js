"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test("packed npm artifact includes and serves the dashboard without private state", { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solisk-package-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const packArgs = ["pack", "--ignore-scripts", "--json"];
  const packOptions = {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    // Keep paths out of cmd.exe's command string, including paths with spaces.
    env: { ...process.env, npm_config_pack_destination: dir },
  };
  const output = process.platform === "win32"
    ? execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm pack --ignore-scripts --json"], packOptions)
    : execFileSync("npm", packArgs, packOptions);
  const [artifact] = JSON.parse(output);
  const files = artifact.files.map((file) => file.path);
  assert.ok(files.includes("desktop-app/renderer/index.html"), "npm must ship the renderer used by /app");
  assert.ok(files.includes("pc-control-headless/web/bridge.js"));
  assert.equal(files.some((file) => /(^|\/)(config|oauth_tokens|devices|rooms)\.json$/.test(file)), false);
  execFileSync("tar", ["-xzf", path.join(dir, artifact.filename), "-C", dir]);

  const pkgRoot = path.join(dir, "package");
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
  const port = await freePort();
  const key = "package-test-" + "k".repeat(40);
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ api_key: key, port, relay_enabled: false, tunnel_mode: "off" }));
  // Reuse installed dependencies, but load every application file from the tarball.
  // This checks packaging, not dependency installation on a fresh machine.
  child = spawn(process.execPath, [path.join(pkgRoot, pkg.bin.solisk), "--mode=http", "--no-relay", "--config", config], {
    cwd: dir,
    env: { ...process.env, NODE_PATH: path.join(root, "node_modules"), MCP_CONFIG_PATH: config },
    stdio: "ignore",
  });
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    try {
      await fetch(base + "/", { signal: AbortSignal.timeout(1000) });
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(ready, "packed HTTP server must start");
  const response = await fetch(base + "/app");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /src="\/app\/bridge\.js"/);
  for (const asset of ["app.js", "ui.css", "bridge.js", "vendor/chart.umd.js", "assets/icon.png"]) {
    assert.equal((await fetch(base + "/app/" + asset)).status, 200, asset);
  }
  assert.equal((await fetch(base + "/api/status")).status, 401);
  const status = await fetch(base + "/api/status", { headers: { authorization: `Bearer ${key}` } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).running, true);
});
