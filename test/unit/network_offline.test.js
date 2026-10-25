"use strict";

const assert = require("assert");
const axios = require("axios");
const networkTools = require("../../tools/network");
const advancedNetworkTools = require("../../tools/network_advanced");
const serverTools = require("../../tools/server");

let passed = 0, failed = 0;
async function itAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

async function run() {
  console.log("\n--- Unit Tests: User-Friendly Network & Offline Errors ---");

  const httpGet = networkTools.find((t) => t.name === "http_get");
  const httpPost = networkTools.find((t) => t.name === "http_post");
  const dnsLookup = advancedNetworkTools.find((t) => t.name === "dns_lookup");
  const downloadFile = serverTools.find((t) => t.name === "download_file");

  // Inject errors at the HTTP boundary: real DNS/proxies can turn a missing
  // host into a timeout or HTTP response, which isn't a deterministic unit test.
  for (const [method, tool] of [["get", httpGet], ["post", httpPost]]) {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ECONNREFUSED", "ETIMEDOUT", "ECONNABORTED"]) {
      await itAsync(`http_${method} returns a friendly error for ${code}`, async () => {
        const original = axios[method];
        axios[method] = async () => { throw Object.assign(new Error("request failed"), { code }); };
        try {
          const res = await tool.handler({ url: "https://solisk-test.invalid", body: {}, timeout_ms: 3000 });
          assert.strictEqual(res.success, false);
          assert.strictEqual(res.code, "NO_INTERNET");
          assert.match(res.error, /No internet connection or host unreachable/i);
        } finally {
          axios[method] = original;
        }
      });
    }
    await itAsync(`http_${method} preserves errors unrelated to connectivity`, async () => {
      const original = axios[method];
      axios[method] = async () => { throw Object.assign(new Error("invalid URL"), { code: "ERR_INVALID_URL" }); };
      try {
        const res = await tool.handler({ url: "not-a-url" });
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.code, `HTTP_${method.toUpperCase()}_FAILED`);
      } finally {
        axios[method] = original;
      }
    });
  }

  await itAsync("dns_lookup returns user-friendly message for non-existent domain", async () => {
    const res = await dnsLookup.handler({ domain: "solisk-test.invalid" });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, "DNS_LOOKUP_FAILED");
    assert.match(res.error, /DNS lookup failed/i);
  });

  await itAsync("download_file returns friendly error on unreachable host", async () => {
    const res = await downloadFile.handler({
      url: "https://solisk-test.invalid/file.bin",
      save_path: "tmp/test_download_nonexistent.bin",
      timeout_ms: 4000,
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, "NO_INTERNET");
    assert.match(res.error, /No internet connection or download host unreachable/i);
  });

  console.log(`\nNetwork Offline Test Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
