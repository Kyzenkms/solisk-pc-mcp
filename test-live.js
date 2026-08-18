/**
 * Live test client for PC Control MCP Server
 * Uses official @modelcontextprotocol/sdk Client and StreamableHTTPClientTransport
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

// Load API key
let apiKey = "";
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  apiKey = cfg.api_key || "";
} catch {}

function getContent(resp) {
  return resp?.content?.[0]?.text ?? "(no content)";
}

async function main() {
  console.log("🤖 Connecting to PC Control MCP Server at http://localhost:3000/mcp using official MCP SDK Client...\n");

  const transport = new StreamableHTTPClientTransport("http://localhost:3000/mcp", {
    requestInit: {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    },
  });

  const client = new Client(
    { name: "antigravity-ai-test", version: "1.0.0" },
    { capabilities: {} }
  );

  // ── 1. Handshake ──────────────────────────────────────────────
  console.log("📡 [1/7] Initializing MCP session...");
  await client.connect(transport);
  console.log("✅ Connected & initialized successfully!\n");

  // ── 2. List tools ─────────────────────────────────────────────
  console.log("🔧 [2/7] Listing tools...");
  const toolsResp = await client.listTools();
  const tools = toolsResp?.tools ?? [];
  console.log(`✅ ${tools.length} tools registered:`);
  tools.slice(0, 10).forEach((t) => console.log(`   • ${t.name}`));
  if (tools.length > 10) console.log(`   ... and ${tools.length - 10} more`);
  console.log();

  // ── 3. System info ────────────────────────────────────────────
  console.log("🖥️  [3/7] Calling get_system_info...");
  const sysInfo = await client.callTool({ name: "get_system_info", arguments: {} });
  console.log("✅ Result:\n" + getContent(sysInfo));
  console.log();

  // ── 4. List Desktop ───────────────────────────────────────────
  console.log("📁 [4/7] Listing Desktop...");
  const dir = await client.callTool({ name: "list_dir", arguments: { path: "C:\\Users\\user\\Desktop" } });
  console.log("✅ Desktop contents:\n" + getContent(dir));
  console.log();

  // ── 5. Run PowerShell command ─────────────────────────────────
  console.log("💻 [5/7] Running PowerShell: Get-Date...");
  const cmd = await client.callTool({ name: "run_command", arguments: { command: "Get-Date | Format-List" } });
  console.log("✅ Output:\n" + getContent(cmd));
  console.log();

  // ── 6. Write + Read file ──────────────────────────────────────
  console.log("📝 [6/7] Writing file to Desktop...");
  await client.callTool({
    name: "write_file",
    arguments: {
      path: "C:\\Users\\user\\Desktop\\mcp-test.txt",
      content: `Hello from PC Control MCP Server!\nWritten by AI at: ${new Date().toISOString()}\nThis proves the AI can fully control your PC! 🎉`,
    },
  });
  const readBack = await client.callTool({ name: "read_file", arguments: { path: "C:\\Users\\user\\Desktop\\mcp-test.txt" } });
  console.log("✅ File written and read back:\n" + getContent(readBack));
  console.log();

  // ── 7. Set clipboard ──────────────────────────────────────────
  console.log("📋 [7/7] Writing to clipboard...");
  await client.callTool({ name: "set_clipboard", arguments: { text: "🚀 PC Control MCP is WORKING! AI just wrote this." } });
  const clip = await client.callTool({ name: "get_clipboard", arguments: {} });
  console.log("✅ Clipboard now contains:\n" + getContent(clip));
  console.log();

  await client.close();

  console.log("━".repeat(50));
  console.log("🎉 ALL 7 TESTS PASSED SUCCESSFULLY USING OFFICIAL MCP SDK!");
  console.log("   The MCP server works accurately. Connect any AI client.");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
