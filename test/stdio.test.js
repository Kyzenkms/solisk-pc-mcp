"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const registryPackage = require("../server.json").packages.find((item) => item.identifier === pkg.name);

test("CLI stdio initializes, lists tools and reads a fixture without protocol errors", { timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solisk-stdio-"));
  const fixture = path.join(dir, "hello.txt");
  const config = path.join(dir, "config.json");
  fs.writeFileSync(fixture, "hello from the stdio fixture");
  fs.writeFileSync(config, JSON.stringify({
    api_key: "stdio-test-" + "k".repeat(40),
    allowed_paths: [dir],
    denied_paths: [],
    permission_mode: "always",
  }));

  const errors = [];
  let diagnostics = "";
  const client = new Client({ name: "solisk-stdio-test", version: "1" });
  client.onerror = (error) => errors.push(error.message);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, pkg.bin.solisk),
      ...registryPackage.packageArguments.flatMap(({ name, value }) => [name, value]),
      "--config", config],
    cwd: dir,
    env: { LOG_LEVEL: "info" },
    stderr: "pipe",
  });
  transport.stderr.on("data", (chunk) => { diagnostics += chunk; });
  t.after(async () => {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  await client.connect(transport);
  assert.equal(client.getServerVersion().version, pkg.version);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "read_file"));
  const result = await client.callTool({ name: "read_file", arguments: { path: fixture } });
  assert.notEqual(result.isError, true);
  assert.match(JSON.stringify(result.content), /hello from the stdio fixture/);
  if (process.platform === "win32") {
    const denied = await client.callTool({ name: "run_command", arguments: { command: "Get-Date" } });
    assert.equal(denied.isError, true, "always mode must not run PowerShell without desktop approval");
    assert.match(JSON.stringify(denied.content), /SANDBOX_DENIED/);
  }
  assert.equal(errors.length, 0, "stdout must contain only MCP JSON-RPC messages");
  assert.match(diagnostics, /running on stdio/, "diagnostics must remain available on stderr");
});

test("registry and desktop release metadata match the CLI package", () => {
  const manifest = require("../server.json");
  const desktop = require("../desktop-app/package.json");
  const lock = require("../desktop-app/package-lock.json");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.name, pkg.mcpName);
  const entry = manifest.packages.find((item) => item.identifier === pkg.name);
  assert.ok(entry, "registry must reference this npm package");
  assert.equal(entry.version, pkg.version);
  assert.equal(entry.transport.type, "stdio");
  assert.deepEqual(entry.packageArguments, [{ type: "named", name: "--mode", value: "stdio" }]);
  assert.ok(manifest.description.length <= 100);
  assert.equal(desktop.version, pkg.version);
  assert.equal(lock.version, desktop.version);
  assert.equal(lock.packages[""].version, desktop.version);
});
