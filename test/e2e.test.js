/**
 * End-to-end regression test for the local MCP server.
 * Spawns an isolated instance (temp config, random port) so it never touches
 * the user's real config or a running instance.  Run: node test/e2e.test.js
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}

async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error("server did not start");
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-e2e-"));
  const sandbox = path.join(dir, "sandbox");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(sandbox); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "top-secret");
  fs.writeFileSync(path.join(sandbox, "hello.txt"), "hello");
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ api_key: "e2e-" + "k".repeat(40), allowed_paths: [sandbox], denied_paths: [] }));
  const key = JSON.parse(fs.readFileSync(cfgPath, "utf8")).api_key;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js"), "--mode=http", `--port=${port}`], {
    env: { ...process.env, MCP_CONFIG_PATH: cfgPath }, stdio: "ignore",
  });
  let client;
  try {
    await waitFor(base + "/health");
    console.log("Auth");
    let r = await fetch(base + "/mcp", { method: "POST" });
    check("no token -> 401", r.status === 401);
    r = await fetch(base + "/mcp", { method: "POST", headers: { Authorization: "Bearer wrong" } });
    check("bad token -> 401", r.status === 401);
    r = await fetch(base + "/health");
    check("health requires auth", r.status === 401);

    console.log("MCP session");
    client = new Client({ name: "e2e", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }));
    const tools = (await client.listTools()).tools;
    check("lists tools", tools.length > 50, `got ${tools.length}`);
    const call = async (name, args) => {
      const out = await client.callTool({ name, arguments: args });
      const text = (out.content || []).map((c) => c.text || "").join("");
      try { return JSON.parse(text); } catch { return { raw: text, isError: out.isError }; }
    };

    console.log("Sandbox");
    let res = await call("read_file", { path: path.join(sandbox, "hello.txt") });
    check("read inside sandbox", JSON.stringify(res).includes("hello"));
    res = await call("read_file", { path: path.join(outside, "secret.txt") });
    check("read outside sandbox denied", !JSON.stringify(res).includes("top-secret"));
    res = await call("read_file", { path: path.join(sandbox, "..", "outside", "secret.txt") });
    check("../ traversal denied", !JSON.stringify(res).includes("top-secret"));
    res = await call("write_file", { path: path.join(outside, "pwn.txt"), content: "x" });
    check("write outside denied", !fs.existsSync(path.join(outside, "pwn.txt")));
    res = await call("write_file", { path: path.join(sandbox, "new.txt"), content: "ok" });
    check("write inside works", fs.existsSync(path.join(sandbox, "new.txt")));
    res = await call("delete_file", { path: path.join(sandbox, "new.txt") });
    check("delete requires confirm", fs.existsSync(path.join(sandbox, "new.txt")));
    res = await call("read_file", { path: path.join(sandbox, "missing.txt") });
    check("missing file reports error", /ENOENT|no such|not found/i.test(JSON.stringify(res)));
  } catch (e) {
    failed++; console.log("  FAIL harness:", e.message);
  } finally {
    try { await client?.close(); } catch {}
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
