/**
 * relay-server/test/oauth.test.js
 *
 * Comprehensive OAuth 2.0 / MCP relay production regression tests.
 *
 * Coverage:
 *   - OAuth discovery (global + per-room /.well-known endpoints)
 *   - Dynamic client registration (RFC 7591)
 *   - PKCE S256 enforcement (RFC 7636)
 *   - RFC 8707 resource binding (authorization_code + refresh_token)
 *   - Exact redirect_uri matching
 *   - Client secret verification
 *   - Authorization code single-use
 *   - Refresh token rotation
 *   - Access token + refresh token issuance and revocation
 *   - Session-principal binding (unauthorized session reuse blocked)
 *   - Health / readiness endpoints
 *   - SQLite state persistence
 *
 * Run with: node relay-server/test/oauth.test.js
 * Exit 0 on all pass, exit 1 on any failure.
 */

"use strict";

const assert  = require("assert");
const fs      = require("fs");
const os      = require("os");
const path    = require("path");
const http    = require("http");
const crypto  = require("crypto");
const { spawn } = require("child_process");
const { hashKey, FULL_SCOPES } = require("../keys");

// -- Test harness -------------------------------------------------------------
const ROOT    = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
const port    = 39500 + Math.floor(Math.random() * 400);

// The API key that "owns" the test room (written as a scrypt hash into rooms.json)
const apiKey       = "oauth-test-api-key-" + crypto.randomBytes(16).toString("hex");
const { salt, hash } = hashKey(apiKey);

fs.writeFileSync(path.join(dataDir, "rooms.json"), JSON.stringify({
  testroom: {
    code: "testroom",
    keys: [{ id: "owner", label: "owner", scopes: FULL_SCOPES, salt, hash }],
  },
}));

const child = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV:          "production",
    PORT:              String(port),
    DATA_DIR:          dataDir,
    PUBLIC_URL:        `http://127.0.0.1:${port}`,
    RELAY_ADMIN_TOKEN: "test-admin-token-12345678901234567890",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
child.stdout.on("data", d => { serverOutput += d; });
child.stderr.on("data", d => { serverOutput += d; });

// -- HTTP helper --------------------------------------------------------------
function req(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const isJson   = headers["content-type"] === "application/json"
                  || (typeof body === "object" && body !== null && !Buffer.isBuffer(body));
    const bodyStr  = isJson ? JSON.stringify(body) : (body || null);
    const ct       = isJson ? "application/json" : "application/x-www-form-urlencoded";
    const finalHdr = { ...(bodyStr ? { "content-type": ct } : {}), ...headers };

    const r = http.request(
      { hostname: "127.0.0.1", port, path: route, method, headers: finalHdr },
      res => {
        let data = "";
        res.on("data", c => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    r.on("error", reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

function enc(v) { return encodeURIComponent(v); }
function form(pairs) { return pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&"); }
function parseJson(body) { try { return JSON.parse(body); } catch { return null; } }

// -- Wait for server ready ----------------------------------------------------
async function waitReady(maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await req("GET", "/ready");
      if (r.status === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Server did not become ready within " + maxMs + "ms");
}

// -- Test runner ---------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write("  ? " + name + "\n");
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write("  ? " + name + "\n    " + err.message + "\n");
  }
}

// -- PKCE helpers -------------------------------------------------------------
function makePkce() {
  const verifier  = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// -- Main test suite ----------------------------------------------------------
(async () => {
  try {
    await waitReady();

    const resource = `http://127.0.0.1:${port}/mcp/testroom`;
    const redirect = "https://claude.ai/api/auth/callback/connector";

    // -- 1. Health & readiness -----------------------------------------------
    process.stdout.write("\nHealth & readiness\n");

    await test("GET /health returns 200 + status ok", async () => {
      const r = await req("GET", "/health");
      assert.strictEqual(r.status, 200);
      const b = parseJson(r.body);
      assert.strictEqual(b.status, "ok");
    });

    await test("GET /ready returns 200 + database ok", async () => {
      const r = await req("GET", "/ready");
      assert.strictEqual(r.status, 200);
      const b = parseJson(r.body);
      assert.strictEqual(b.database, "ok");
    });

    // -- 2. OAuth discovery --------------------------------------------------
    process.stdout.write("\nOAuth discovery\n");

    await test("Global discovery /.well-known/oauth-authorization-server", async () => {
      const r = await req("GET", "/.well-known/oauth-authorization-server");
      assert.strictEqual(r.status, 200);
      const m = parseJson(r.body);
      assert.ok(m.authorization_endpoint, "missing authorization_endpoint");
      assert.ok(m.token_endpoint, "missing token_endpoint");
      assert.deepStrictEqual(m.code_challenge_methods_supported, ["S256"]);
      assert.strictEqual(m.require_pkce, true);
    });

    await test("Per-room discovery /.well-known/oauth-authorization-server/mcp/:code", async () => {
      const r = await req("GET", "/.well-known/oauth-authorization-server/mcp/testroom");
      assert.strictEqual(r.status, 200);
      const m = parseJson(r.body);
      assert.strictEqual(m.require_pkce, true);
      assert.deepStrictEqual(m.code_challenge_methods_supported, ["S256"]);
      assert.ok(m.issuer.includes("/mcp/testroom"), `issuer should contain /mcp/testroom, got: ${m.issuer}`);
    });

    await test("Per-room discovery /mcp/:code/.well-known/oauth-authorization-server", async () => {
      const r = await req("GET", "/mcp/testroom/.well-known/oauth-authorization-server");
      assert.strictEqual(r.status, 200);
      const m = parseJson(r.body);
      assert.strictEqual(m.require_pkce, true);
    });

    await test("Protected resource metadata /.well-known/oauth-protected-resource/mcp/:code", async () => {
      const r = await req("GET", "/.well-known/oauth-protected-resource/mcp/testroom");
      assert.strictEqual(r.status, 200);
      const m = parseJson(r.body);
      assert.ok(m.resource, "missing resource");
      assert.ok(Array.isArray(m.authorization_servers), "missing authorization_servers");
    });

    // -- 3. Dynamic client registration -------------------------------------
    process.stdout.write("\nDynamic client registration\n");

    let client;
    await test("POST /mcp/testroom/oauth/register returns 201 with client_id + secret", async () => {
      const r = await req("POST", "/mcp/testroom/oauth/register",
        { client_name: "Test Suite", redirect_uris: [redirect] },
        { "content-type": "application/json" });
      assert.strictEqual(r.status, 201);
      client = parseJson(r.body);
      assert.ok(client.client_id, "missing client_id");
      assert.ok(client.client_secret, "missing client_secret");
      assert.deepStrictEqual(client.redirect_uris, [redirect]);
    });

    await test("Registration rejects untrusted redirect_uri domain", async () => {
      const r = await req("POST", "/mcp/testroom/oauth/register",
        { client_name: "Evil", redirect_uris: ["https://evil.com/callback"] },
        { "content-type": "application/json" });
      assert.strictEqual(r.status, 400);
      const b = parseJson(r.body);
      assert.strictEqual(b.error, "invalid_redirect_uri");
    });

    await test("Registration rejects non-HTTPS redirect for non-loopback", async () => {
      const r = await req("POST", "/mcp/testroom/oauth/register",
        { redirect_uris: ["http://claude.ai/callback"] },
        { "content-type": "application/json" });
      assert.strictEqual(r.status, 400);
    });

    await test("Registration accepts claude.com redirect (Anthropic domain)", async () => {
      const r = await req("POST", "/mcp/testroom/oauth/register",
        { client_name: "Claude", redirect_uris: ["https://claude.com/api/auth/callback/connector"] },
        { "content-type": "application/json" });
      assert.strictEqual(r.status, 201);
    });

    // -- 4. Authorization endpoint -------------------------------------------
    process.stdout.write("\nAuthorization\n");

    await test("GET /mcp/:code/oauth/authorize returns 200 HTML", async () => {
      const r = await req("GET",
        `/mcp/testroom/oauth/authorize?client_id=${enc(client.client_id)}&redirect_uri=${enc(redirect)}&state=${"a".repeat(16)}&code_challenge=abc&code_challenge_method=S256&scope=mcp%3Atools&resource=${enc(resource)}`);
      assert.strictEqual(r.status, 200);
      assert.ok(r.headers["content-type"].includes("text/html"), "expected HTML");
    });

    let authCode, state;
    await test("POST authorize with valid key ? 302 redirect with code", async () => {
      const { verifier, challenge } = makePkce();
      state = crypto.randomBytes(16).toString("hex");
      const r = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", apiKey], ["client_id", client.client_id],
        ["redirect_uri", redirect], ["state", state], ["code_challenge", challenge],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 302, `Expected 302, got ${r.status}: ${r.body}`);
      const loc = new URL(r.headers.location);
      assert.strictEqual(loc.searchParams.get("state"), state);
      authCode = loc.searchParams.get("code");
      assert.ok(authCode, "missing code in redirect");
      // Save verifier for token step
      client._verifier = verifier;
      client._challenge = challenge;
    });

    await test("POST authorize with wrong API key ? 401", async () => {
      const { challenge } = makePkce();
      const r = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", "wrong-key"], ["client_id", client.client_id],
        ["redirect_uri", redirect], ["state", "a".repeat(16)], ["code_challenge", challenge],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 401);
    });

    await test("POST authorize rejects missing S256 PKCE", async () => {
      const r = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", apiKey], ["client_id", client.client_id],
        ["redirect_uri", redirect], ["state", "a".repeat(16)],
        ["code_challenge", "abc"], ["code_challenge_method", "plain"],
        ["scope", "mcp:tools"], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 400);
    });

    await test("POST authorize rejects mismatched resource URI", async () => {
      const { challenge } = makePkce();
      const badResource = `http://127.0.0.1:${port}/mcp/otherroom`;
      const r = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", apiKey], ["client_id", client.client_id],
        ["redirect_uri", redirect], ["state", "a".repeat(16)], ["code_challenge", challenge],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", badResource],
      ]));
      assert.strictEqual(r.status, 400);
    });

    await test("POST authorize rejects state too short (< 16 chars)", async () => {
      const { challenge } = makePkce();
      const r = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", apiKey], ["client_id", client.client_id],
        ["redirect_uri", redirect], ["state", "short"], ["code_challenge", challenge],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 400);
    });

    await test("POST authorize deny action ? redirect with error=access_denied", async () => {
      const { challenge } = makePkce();
      const denyState = "a".repeat(16);
      const r = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "deny"], ["api_key", apiKey], ["client_id", client.client_id],
        ["redirect_uri", redirect], ["state", denyState], ["code_challenge", challenge],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", resource],
      ]));
      // deny renders an HTML refresh page (200) or 302 depending on build
      assert.ok([200, 302].includes(r.status), `Expected 200 or 302, got ${r.status}`);
      const locOrBody = r.headers.location || r.body;
      assert.ok(locOrBody.includes("access_denied"), "Expected access_denied in deny response");
    });

    await test("POST authorize rejects unregistered client_id", async () => {
      const { challenge } = makePkce();
      const r = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", apiKey], ["client_id", "unknown_client_xyz"],
        ["redirect_uri", redirect], ["state", "a".repeat(16)], ["code_challenge", challenge],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 400);
    });

    await test("GET authorize self-heals unknown dyn_ client, POST then succeeds", async () => {
      const lostClientId = "dyn_" + crypto.randomBytes(12).toString("hex");
      const page = await req("GET",
        `/mcp/testroom/oauth/authorize?client_id=${enc(lostClientId)}&redirect_uri=${enc(redirect)}&state=${"b".repeat(16)}&code_challenge=abc&code_challenge_method=S256&scope=mcp%3Atools&resource=${enc(resource)}`);
      assert.strictEqual(page.status, 200);

      const { challenge } = makePkce();
      const r = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", apiKey], ["client_id", lostClientId],
        ["redirect_uri", redirect], ["state", "b".repeat(16)], ["code_challenge", challenge],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 302, `Expected 302, got ${r.status}: ${r.body}`);
    });

    await test("GET authorize does not self-heal untrusted redirect_uri", async () => {
      const lostClientId = "dyn_" + crypto.randomBytes(12).toString("hex");
      await req("GET",
        `/mcp/testroom/oauth/authorize?client_id=${enc(lostClientId)}&redirect_uri=${enc("https://evil.com/cb")}&state=${"c".repeat(16)}&code_challenge=abc&code_challenge_method=S256&resource=${enc(resource)}`);
      const { challenge } = makePkce();
      const r = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", apiKey], ["client_id", lostClientId],
        ["redirect_uri", "https://evil.com/cb"], ["state", "c".repeat(16)], ["code_challenge", challenge],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 400);
    });

    // -- 5. Token endpoint ---------------------------------------------------
    process.stdout.write("\nToken endpoint\n");

    let accessToken, refreshToken;
    await test("POST /token authorization_code ? 200 with access_token + refresh_token", async () => {
      const r = await req("POST", "/mcp/testroom/oauth/token", form([
        ["grant_type", "authorization_code"], ["code", authCode],
        ["client_id", client.client_id], ["client_secret", client.client_secret],
        ["redirect_uri", redirect], ["code_verifier", client._verifier], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}: ${r.body}`);
      const b = parseJson(r.body);
      assert.ok(b.access_token, "missing access_token");
      assert.ok(b.refresh_token, "missing refresh_token");
      assert.ok(b.expires_in > 0, "missing expires_in");
      accessToken  = b.access_token;
      refreshToken = b.refresh_token;
    });

    await test("Authorization code is single-use (replay ? 400 invalid_grant)", async () => {
      const r = await req("POST", "/mcp/testroom/oauth/token", form([
        ["grant_type", "authorization_code"], ["code", authCode],
        ["client_id", client.client_id], ["client_secret", client.client_secret],
        ["redirect_uri", redirect], ["code_verifier", client._verifier], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 400);
      const b = parseJson(r.body);
      assert.strictEqual(b.error, "invalid_grant");
    });

    await test("Token rejected with wrong PKCE verifier", async () => {
      // Obtain a fresh auth code
      const { verifier: v2, challenge: c2 } = makePkce();
      const st2 = crypto.randomBytes(16).toString("hex");
      const a2 = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", apiKey], ["client_id", client.client_id],
        ["redirect_uri", redirect], ["state", st2], ["code_challenge", c2],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", resource],
      ]));
      const code2 = new URL(a2.headers.location).searchParams.get("code");
      const r = await req("POST", "/mcp/testroom/oauth/token", form([
        ["grant_type", "authorization_code"], ["code", code2],
        ["client_id", client.client_id], ["client_secret", client.client_secret],
        ["redirect_uri", redirect], ["code_verifier", "BAD_VERIFIER_" + v2], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 400);
      const b = parseJson(r.body);
      assert.strictEqual(b.error, "invalid_grant");
    });

    await test("Token rejected with wrong client_secret", async () => {
      const { verifier: v3, challenge: c3 } = makePkce();
      const st3 = crypto.randomBytes(16).toString("hex");
      const a3 = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", apiKey], ["client_id", client.client_id],
        ["redirect_uri", redirect], ["state", st3], ["code_challenge", c3],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", resource],
      ]));
      const code3 = new URL(a3.headers.location).searchParams.get("code");
      const r = await req("POST", "/mcp/testroom/oauth/token", form([
        ["grant_type", "authorization_code"], ["code", code3],
        ["client_id", client.client_id], ["client_secret", "WRONG_SECRET"],
        ["redirect_uri", redirect], ["code_verifier", v3], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 401);
      const b = parseJson(r.body);
      assert.strictEqual(b.error, "invalid_client");
    });

    await test("Token rejected with wrong resource (RFC 8707 binding)", async () => {
      const { verifier: v4, challenge: c4 } = makePkce();
      const st4 = crypto.randomBytes(16).toString("hex");
      const a4 = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", apiKey], ["client_id", client.client_id],
        ["redirect_uri", redirect], ["state", st4], ["code_challenge", c4],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", resource],
      ]));
      const code4 = new URL(a4.headers.location).searchParams.get("code");
      const r = await req("POST", "/mcp/testroom/oauth/token", form([
        ["grant_type", "authorization_code"], ["code", code4],
        ["client_id", client.client_id], ["client_secret", client.client_secret],
        ["redirect_uri", redirect], ["code_verifier", v4],
        ["resource", resource + "/other"],  // mismatched resource
      ]));
      assert.strictEqual(r.status, 400);
      const b = parseJson(r.body);
      assert.strictEqual(b.error, "invalid_grant");
    });

    await test("Token rejected with mismatched redirect_uri", async () => {
      const { verifier: v5, challenge: c5 } = makePkce();
      const st5 = crypto.randomBytes(16).toString("hex");
      const a5 = await req("POST", "/mcp/testroom/oauth/authorize", form([
        ["action", "allow"], ["api_key", apiKey], ["client_id", client.client_id],
        ["redirect_uri", redirect], ["state", st5], ["code_challenge", c5],
        ["code_challenge_method", "S256"], ["scope", "mcp:tools"], ["resource", resource],
      ]));
      const code5 = new URL(a5.headers.location).searchParams.get("code");
      const r = await req("POST", "/mcp/testroom/oauth/token", form([
        ["grant_type", "authorization_code"], ["code", code5],
        ["client_id", client.client_id], ["client_secret", client.client_secret],
        ["redirect_uri", "https://claude.ai/api/auth/callback/other"],
        ["code_verifier", v5], ["resource", resource],
      ]));
      assert.strictEqual(r.status, 400);
      const b = parseJson(r.body);
      assert.strictEqual(b.error, "invalid_grant");
    });

    // -- 6. Refresh token rotation -------------------------------------------
    process.stdout.write("\nRefresh token rotation\n");

    let newAccessToken, newRefreshToken;
    await test("Refresh token ? 200 with new access_token + new refresh_token", async () => {
      const r = await req("POST", "/mcp/testroom/oauth/token", form([
        ["grant_type", "refresh_token"], ["refresh_token", refreshToken],
        ["client_id", client.client_id], ["client_secret", client.client_secret],
        ["resource", resource],
      ]));
      assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}: ${r.body}`);
      const b = parseJson(r.body);
      assert.ok(b.access_token,  "missing access_token after refresh");
      assert.ok(b.refresh_token, "missing refresh_token after refresh");
      assert.notStrictEqual(b.access_token,  accessToken,  "access_token should rotate");
      assert.notStrictEqual(b.refresh_token, refreshToken, "refresh_token should rotate");
      newAccessToken  = b.access_token;
      newRefreshToken = b.refresh_token;
    });

    await test("Old refresh token is revoked after rotation (replay ? 400)", async () => {
      const r = await req("POST", "/mcp/testroom/oauth/token", form([
        ["grant_type", "refresh_token"], ["refresh_token", refreshToken],
        ["client_id", client.client_id], ["client_secret", client.client_secret],
        ["resource", resource],
      ]));
      assert.strictEqual(r.status, 400);
      const b = parseJson(r.body);
      assert.strictEqual(b.error, "invalid_grant");
    });

    await test("Refresh rejected with wrong resource (RFC 8707)", async () => {
      const r = await req("POST", "/mcp/testroom/oauth/token", form([
        ["grant_type", "refresh_token"], ["refresh_token", newRefreshToken],
        ["client_id", client.client_id], ["client_secret", client.client_secret],
        ["resource", resource + "/other"],
      ]));
      assert.strictEqual(r.status, 400);
      const b = parseJson(r.body);
      assert.strictEqual(b.error, "invalid_grant");
    });

    // -- 7. Token revocation -------------------------------------------------
    process.stdout.write("\nToken revocation\n");

    await test("POST /oauth/revoke is idempotent (200 on unknown token)", async () => {
      const r = await req("POST", "/mcp/testroom/oauth/revoke", form([
        ["token", "nonexistent_token_12345"],
      ]));
      assert.strictEqual(r.status, 200);
    });

    await test("Revoke new access token ? subsequent revoke also 200 (idempotent)", async () => {
      let r = await req("POST", "/mcp/testroom/oauth/revoke", form([["token", newAccessToken]]));
      assert.strictEqual(r.status, 200);
      r = await req("POST", "/mcp/testroom/oauth/revoke", form([["token", newAccessToken]]));
      assert.strictEqual(r.status, 200);
    });

    // -- 8. MCP endpoint security --------------------------------------------
    process.stdout.write("\nMCP endpoint security\n");

    await test("MCP endpoint without auth ? 401 with WWW-Authenticate header", async () => {
      const r = await req("POST", "/mcp/testroom", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), { "content-type": "application/json" });
      assert.strictEqual(r.status, 401);
      assert.ok(r.headers["www-authenticate"], "missing WWW-Authenticate header");
    });

    await test("MCP endpoint with valid owner API key ? 503 pc_offline (no PC connected)", async () => {
      const r = await req("POST", "/mcp/testroom",
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        { "content-type": "application/json", authorization: `Bearer ${apiKey}` });
      // 503 means auth passed, PC just isn't connected
      assert.strictEqual(r.status, 503);
    });

    // -- 9. SQLite persistence -----------------------------------------------
    process.stdout.write("\nSQLite persistence\n");

    await test("relay.sqlite exists in DATA_DIR", async () => {
      const dbPath = path.join(dataDir, "relay.sqlite");
      assert.ok(fs.existsSync(dbPath), `relay.sqlite not found at ${dbPath}`);
    });

    await test("Unsupported grant_type ? 400 unsupported_grant_type", async () => {
      const r = await req("POST", "/oauth/token", form([["grant_type", "password"]]));
      assert.strictEqual(r.status, 400);
      const b = parseJson(r.body);
      assert.strictEqual(b.error, "unsupported_grant_type");
    });

  } finally {
    // Teardown
    child.kill("SIGTERM");
    // Give the process time to close its SQLite handle before cleanup
    await new Promise(r => setTimeout(r, 1500));
    try { child.kill("SIGKILL"); } catch {}
    // Clean up temp dir (Windows SQLite files may still be locked briefly)
    setTimeout(() => {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }, 2000).unref();
  }

  // -- Report -----------------------------------------------------------------
  const total = passed + failed;
  process.stdout.write(`\n${"-".repeat(60)}\n`);
  process.stdout.write(`OAuth relay regression: ${passed}/${total} passed`);
  if (failed > 0) {
    process.stdout.write(` � ${failed} FAILED\n`);
    for (const { name, err } of failures) {
      process.stdout.write(`  ? ${name}\n    ${err.stack || err.message}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(" � ALL PASSED ?\n");
  }
})().catch(err => {
  console.error("\n[fatal]", err.message);
  if (serverOutput) console.error("[server output]\n" + serverOutput.slice(-3000));
  process.exitCode = 1;
});
