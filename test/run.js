"use strict";

// Run the existing suites with disposable state, never the owner's config,
// remembered devices, OAuth tokens or metrics. Keep tests in separate processes.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const suites = [
  "test/unit/permissions.test.js",
  "test/unit/shell_approval.test.js",
  "test/unit/security.test.js",
  "test/unit/network_offline.test.js",
  "test/e2e.test.js",
  "test/stdio.test.js",
  "test/first-win.test.js",
  "test/package.test.js",
  "relay-server/test/oauth.test.js",
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solisk-tests-"));
let failed = 0;
try {
  for (const [index, suite] of suites.entries()) {
    const state = path.join(dir, String(index));
    fs.mkdirSync(state);
    console.log(`\n=== ${suite} ===`);
    const result = spawnSync(process.execPath, [path.join(root, suite)], {
      cwd: root,
      env: { ...process.env, MCP_CONFIG_PATH: path.join(state, "config.json") },
      stdio: "inherit",
      timeout: 120000,
    });
    if (result.error || result.status !== 0) {
      failed++;
      console.error(`${suite} failed: ${result.error?.message || result.signal || result.status}`);
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exitCode = failed ? 1 : 0;
