"use strict";

const assert = require("assert");
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
  const webSearch = networkTools.find((t) => t.name === "web_search");
  const getPublicIp = advancedNetworkTools.find((t) => t.name === "get_public_ip");
  const dnsLookup = advancedNetworkTools.find((t) => t.name === "dns_lookup");
  const downloadFile = serverTools.find((t) => t.name === "download_file");

  await itAsync("http_get returns user-friendly error on non-existent domain", async () => {
    const res = await httpGet.handler({ url: "https://this-domain-does-not-exist-solisk-xyz-12345.com", timeout_ms: 3000 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, "NO_INTERNET");
    assert.match(res.error, /No internet connection or host unreachable/i);
  });

  await itAsync("http_post returns user-friendly error on non-existent domain", async () => {
    const res = await httpPost.handler({ url: "https://this-domain-does-not-exist-solisk-xyz-12345.com", body: {}, timeout_ms: 3000 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, "NO_INTERNET");
    assert.match(res.error, /No internet connection or host unreachable/i);
  });

  await itAsync("dns_lookup returns user-friendly message for non-existent domain", async () => {
    const res = await dnsLookup.handler({ domain: "this-domain-does-not-exist-solisk-xyz-12345.com" });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, "DNS_LOOKUP_FAILED");
    assert.match(res.error, /DNS lookup failed/i);
  });

  await itAsync("download_file returns friendly error on unreachable host", async () => {
    const res = await downloadFile.handler({
      url: "https://this-domain-does-not-exist-solisk-xyz-12345.com/file.bin",
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
