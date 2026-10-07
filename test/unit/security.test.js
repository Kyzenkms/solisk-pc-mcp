"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { checkPath, resolveApiKey } = require("../../lib/security");
const configRepair = require("../../lib/config-repair");
const devices = require("../../lib/devices");
const { hasScope, toolScopeOf } = require("../../lib/scopes");
const { bus, EVENTS } = require("../../lib/events");
const metrics = require("../../lib/metrics");

let passed = 0;
let failed = 0;

function it(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}:`, err.message);
  }
}

async function run() {
  console.log("\n--- Unit Tests: Security & Scopes ---");

  // 1. Scopes (enforced via lib/scopes.js: hasScope(scopes, toolName))
  it("scopes: wildcard and legacy mcp scopes grant all", () => {
    assert.strictEqual(hasScope(["*"], "write_file"), true);
    assert.strictEqual(hasScope(["mcp:tools"], "run_command"), true);
  });

  it("scopes: fine-grained pc:* scope allows only mapped tools", () => {
    assert.strictEqual(hasScope(["pc:file:read"], "read_file"), true);
    assert.strictEqual(hasScope(["pc:file:read"], "write_file"), false);
    assert.strictEqual(hasScope(["pc:file:read"], "run_command"), false);
  });

  it("scopes: category wildcard grants all actions in category", () => {
    assert.strictEqual(hasScope(["pc:file:*"], "read_file"), true);
    assert.strictEqual(hasScope(["pc:file:*"], "write_file"), true);
    assert.strictEqual(hasScope(["pc:file:*"], "delete_file"), true);
    assert.strictEqual(hasScope(["pc:file:*"], "run_command"), false);
  });

  it("scopes: empty/invalid scope list denies mapped tools", () => {
    assert.strictEqual(hasScope([], "read_file"), false);
    assert.strictEqual(hasScope(null, "read_file"), false);
  });

  it("scopes: unmapped tool is denied unless explicitly unrestricted", () => {
    assert.strictEqual(hasScope(["pc:file:read"], "totally_unknown_tool"), false);
    assert.strictEqual(hasScope(["pc:file:read"], "generate_uuid"), true);
  });

  it("scopes: toolScopeOf maps known tools", () => {
    assert.strictEqual(toolScopeOf("read_file"), "pc:file:read");
    assert.strictEqual(toolScopeOf("write_file"), "pc:file:write");
    assert.strictEqual(toolScopeOf("run_command"), "pc:process:run");
  });
  // 2. Devices
  it("devices: parseCookies decodes valid and handles malformed encoding safely", () => {
    const req1 = { headers: { cookie: "pc_device=test-token; other=abc%20123" } };
    const c1 = devices.parseCookies(req1);
    assert.strictEqual(c1.pc_device, "test-token");
    assert.strictEqual(c1.other, "abc 123");

    // Malformed URI percent encoding shouldn't throw URIError
    const req2 = { headers: { cookie: "bad=abc%invalid%99" } };
    const c2 = devices.parseCookies(req2);
    assert.strictEqual(typeof c2.bad, "string");
  });

  it("devices: issue, verify, and revoke device token", () => {
    const { token, id } = devices.issueDevice("test-device");
    assert(token && token.length === 64);
    assert(id && id.startsWith("dev-"));

    const verified = devices.verifyDevice(token);
    assert.strictEqual(verified.id, id);
    assert.strictEqual(verified.label, "test-device");

    const revoked = devices.revokeDevice(id);
    assert.strictEqual(revoked, true);

    const recheck = devices.verifyDevice(token);
    assert.strictEqual(recheck, null);
  });

  // 3. Config Repair
  it("configRepair: validateConfig catches invalid ports and types", () => {
    const bad = { port: -1, permission_mode: "invalid_mode" };
    const res = configRepair.validateConfig(bad);
    assert.strictEqual(res.valid, false);
    assert(res.problems.length > 0);
  });

  it("configRepair: atomic write and backup", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-test-"));
    const tmpCfg = path.join(tmpDir, "config.json");
    try {
      const sample = { name: "test-pc", port: 3000, api_key: "abc123key" };
      configRepair.writeConfigAtomic(tmpCfg, sample);
      assert.strictEqual(fs.existsSync(tmpCfg), true);

      const loaded = JSON.parse(fs.readFileSync(tmpCfg, "utf8"));
      assert.strictEqual(loaded.name, "test-pc");
      assert.strictEqual(loaded.api_key, "abc123key");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 4. Events
  it("events: bus emits and receives state", () => {
    let received = null;
    const unsub = (data) => { received = data; };
    bus.once(EVENTS.RUNTIME_UP, unsub);
    bus.emitState(EVENTS.RUNTIME_UP, { port: 3000 });
    assert(received !== null);
    assert.strictEqual(received.port, 3000);
    assert(typeof received.at === "string");
  });

  // 5. Metrics
  it("metrics: weekly bucket tracks tool calls and flushes", () => {
    metrics.recordToolCall("read_file", true);
    metrics.recordToolCall("write_file", false);
    const weekly = metrics.getWeekly();
    assert(weekly.this_week);
    assert(weekly.weeks[weekly.this_week].tool_calls >= 2);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
