"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("PowerShell tools fail closed when approval is required but no desktop is attached", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solisk-approval-"));
  const previous = process.env.MCP_CONFIG_PATH;
  process.env.MCP_CONFIG_PATH = path.join(dir, "config.json");
  t.after(() => {
    if (previous === undefined) delete process.env.MCP_CONFIG_PATH;
    else process.env.MCP_CONFIG_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const security = require("../../lib/security");
  t.mock.method(security, "loadConfig", () => {});
  const powershell = require("../../lib/powershell");
  const foreground = t.mock.method(powershell, "execPowershellAsync", async () => ({ status: 0, stdout: "fixture", stderr: "" }));
  const background = t.mock.method(powershell, "spawnPowershellBackground", () => ({ pid: 123 }));
  const tools = require("../../tools/shell");
  assert.equal(typeof process.send, "undefined", "fixture must run without a desktop IPC channel");

  for (const [name, executor] of [["run_command", foreground], ["run_command_background", background]]) {
    const tool = tools.find((item) => item.name === name);
    for (const mode of ["always", "intermediate", "unknown"]) {
      security.config.permission_mode = mode;
      const before = executor.mock.callCount();
      const result = await tool.handler({ command: "Set-Content fixture.txt example", cwd: dir });
      assert.equal(result.success, false, `${name}: ${mode} must refuse without approval`);
      assert.equal(result.code, "SANDBOX_DENIED");
      assert.equal(executor.mock.callCount(), before, "denied commands must not reach the executor");
    }
    security.config.permission_mode = "intermediate";
    assert.equal((await tool.handler({ command: "Get-Date", cwd: dir })).success, true);
    security.config.permission_mode = "turbo";
    assert.equal((await tool.handler({ command: "Set-Content fixture.txt example", cwd: dir })).success, true);
    assert.equal(executor.mock.callCount(), 2, "only the two permitted calls reach the mocked executor");
  }
});
