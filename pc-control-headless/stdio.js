"use strict";

/**
 * stdio.js — stdio transport for the headless CLI build.
 * Used by local MCP clients (Claude Desktop, Cursor, Cline) that spawn the
 * server as a child process. Reuses shared registry + headless extras.
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { registerAllTools } = require("../lib/registry");
const { loadConfig } = require("../lib/security");
const { log, setupGracefulShutdown } = require("../lib/middleware");
const { registerCliExtra, registerMacTools } = require("./tools");

async function startHeadlessStdio({ version }) {
  loadConfig();
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));

  const server = new McpServer({ name: "pc-control-headless", version });
  registerAllTools(server);
  registerCliExtra(server);
  registerMacTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "pc-control-headless running on stdio");
  setupGracefulShutdown({ close: (cb) => { server.close().then(cb).catch(cb); } }, "headless-stdio");
}

module.exports = { startHeadlessStdio };
