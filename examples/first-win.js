"use strict";

// Scripted MCP walkthrough, not an autonomous AI session. Only synthetic files
// in a disposable directory are used. No relay, account or model API is needed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

function summarizeCsv(csv) {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  assert.equal(header, "item,category,amount_cents", "Use the simple demo CSV format");
  assert.ok(rows.length > 0, "At least one expense is required");
  const totals = new Map();
  let total = 0;
  for (const row of rows) {
    const parts = row.split(",");
    assert.equal(parts.length, 3, "Demo CSV does not support quoted commas");
    const [item, category, amount] = parts;
    assert.match(item, /^[\w -]+$/);
    assert.match(category, /^[\w -]+$/);
    assert.match(amount, /^\d+$/);
    const cents = Number(amount);
    assert.ok(Number.isSafeInteger(cents) && Number.isSafeInteger(total + cents), "Invalid cents total");
    totals.set(category, (totals.get(category) || 0) + cents);
    total += cents;
  }
  return [
    "# Expense summary", "", "Synthetic demo data; not real expenses.", "",
    "| Category | Total (USD) |", "| --- | ---: |",
    ...[...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, cents]) =>
      `| ${category} | $${(cents / 100).toFixed(2)} |`),
    "", `**Total: $${(total / 100).toFixed(2)}**`, "",
  ].join("\n");
}

async function runDemo({ write = console.log } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solisk-demo-"));
  const sandbox = path.join(dir, "sandbox");
  const outside = path.join(dir, "outside.txt");
  const config = path.join(dir, "config.json");
  const client = new Client({ name: "solisk-first-win", version: "1" });
  const protocolErrors = [];
  client.onerror = (error) => protocolErrors.push(error);

  try {
    fs.mkdirSync(sandbox);
    fs.copyFileSync(path.join(__dirname, "fixtures", "expenses.csv"), path.join(sandbox, "expenses.csv"));
    fs.writeFileSync(outside, "OUTSIDE-DEMO-SENTINEL");
    fs.writeFileSync(config, JSON.stringify({
      api_key: "demo-" + require("node:crypto").randomBytes(24).toString("hex"),
      allowed_paths: [sandbox], denied_paths: [], permission_mode: "always",
      relay_enabled: false, tunnel_mode: "off",
    }));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, "..", "pc-control-headless", "bin", "pc-control.js"), "--mode=stdio", "--config", config],
      cwd: sandbox,
      env: { LOG_LEVEL: "error" },
      stderr: "pipe",
    });
    // Drain diagnostics without printing credentials, temporary paths or payloads.
    transport.stderr.resume();
    write("Solisk: CSV -> report, using real MCP file-tool calls");
    write("Scripted SDK demo. Synthetic files. No AI model or relay.");
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ["read_file", "write_file"]) assert.ok(tools.some((tool) => tool.name === name));
    write("1. Connected; read_file and write_file discovered.");

    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name} must succeed`);
      const value = JSON.parse(result.content.find((item) => item.type === "text").text);
      assert.equal(value.success, true);
      return value.data;
    };
    const input = await call("read_file", { path: path.join(sandbox, "expenses.csv") });
    write("2. read_file: loaded sandbox/expenses.csv.");
    const report = summarizeCsv(input.content);
    write("3. Local JavaScript grouped the synthetic expenses (not model reasoning).");
    const reportPath = path.join(sandbox, "summary.md");
    await call("write_file", { path: reportPath, content: report });
    const saved = await call("read_file", { path: reportPath });
    assert.equal(saved.content, report);
    write("4. write_file + read_file: saved and verified sandbox/summary.md.");

    const denied = await client.callTool({ name: "read_file", arguments: { path: outside } });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /Access denied/);
    assert.doesNotMatch(JSON.stringify(denied.content), /OUTSIDE-DEMO-SENTINEL/);
    write("5. read_file outside the allowed folder: denied.");
    assert.equal(protocolErrors.length, 0, "No MCP protocol errors expected");
    write("\n" + report);
    return report;
  } finally {
    try { await client.close(); }
    finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      write("Demo files and temporary credentials removed.");
    }
  }
}

if (require.main === module) {
  runDemo().catch((error) => {
    console.error("Demo failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { summarizeCsv, runDemo };
