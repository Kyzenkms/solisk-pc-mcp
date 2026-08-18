const { z } = require("zod");
const { log } = require("./middleware");
const { recordToolCall } = require("./metrics");

const filesystemTools     = require("../tools/filesystem");
const shellTools          = require("../tools/shell");
const systemTools         = require("../tools/system");
const networkTools        = require("../tools/network");
const utilityTools        = require("../tools/utility");
const serverTools         = require("../tools/server");
const inputTools          = require("../tools/input");
const notificationTools   = require("../tools/notification");
const memoryTools         = require("../tools/memory");
const gitTools            = require("../tools/git");
const networkAdvanced     = require("../tools/network_advanced");
const systemAdvanced      = require("../tools/system_advanced");

// All tools in one flat array
const ALL_TOOLS = [
  ...filesystemTools,
  ...shellTools,
  ...systemTools,
  ...networkTools,
  ...utilityTools,
  ...serverTools,
  ...inputTools,
  ...notificationTools,
  ...memoryTools,
  ...gitTools,
  ...networkAdvanced,
  ...systemAdvanced,
];

// Build a lookup map for fast dispatch
const TOOL_MAP = {};
for (const tool of ALL_TOOLS) {
  TOOL_MAP[tool.name] = tool;
}

/**
 * Convert a simple JSON Schema property definition to a Zod schema.
 */
function jsonPropToZod(prop, required = false) {
  let zodType;
  switch (prop.type) {
    case "string":           zodType = z.string(); break;
    case "number":
    case "integer":          zodType = z.number(); break;
    case "boolean":          zodType = z.boolean(); break;
    case "object":           zodType = z.record(z.unknown()); break;
    case "array":            zodType = z.array(z.unknown()); break;
    default:                 zodType = z.unknown();
  }
  if (prop.description) zodType = zodType.describe(prop.description);
  if (!required) {
    zodType = prop.default !== undefined
      ? zodType.optional().default(prop.default)
      : zodType.optional();
  }
  return zodType;
}

function jsonSchemaToZod(schema) {
  const properties    = schema.properties || {};
  const requiredFields = schema.required || [];
  const zodShape = {};
  for (const [key, prop] of Object.entries(properties)) {
    zodShape[key] = jsonPropToZod(prop, requiredFields.includes(key));
  }
  return z.object(zodShape);
}

/**
 * Register all tools with an MCP Server instance.
 */
function registerAllTools(server) {
  for (const tool of ALL_TOOLS) {
    const zodSchema = jsonSchemaToZod(tool.inputSchema);
    server.tool(tool.name, tool.description, zodSchema.shape, async (args) => {
      const { logAudit } = require("./security");
      const start = Date.now();
      try {
        const result = await tool.handler(args);
        const success = result.success !== false;
        const duration = Date.now() - start;

        logAudit(tool.name, args, success, success ? result : (result.error || "Failed"));
        recordToolCall(tool.name, success);

        log("info", `Tool executed: ${tool.name}`, {
          tool: tool.name,
          success,
          duration_ms: duration,
        });

        return {
          content: [{
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        const duration = Date.now() - start;
        logAudit(tool.name, args, false, err.message);
        recordToolCall(tool.name, false);

        log("error", `Tool error: ${tool.name}`, {
          tool: tool.name,
          error: err.message,
          duration_ms: duration,
        });

        return {
          content: [{ type: "text", text: `ERROR: ${err.message}` }],
          isError: true,
        };
      }
    });
  }
  log("info", `Registered ${ALL_TOOLS.length} tools across 12 categories`);
}

/**
 * Get a list of tool metadata for OpenAPI / plugin manifests.
 * Returns a simplified array without circular refs.
 */
function getToolList() {
  return ALL_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

async function dispatchTool(name, args) {
  const tool = TOOL_MAP[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return await tool.handler(args);
}

module.exports = { registerAllTools, dispatchTool, ALL_TOOLS, TOOL_MAP, getToolList };
