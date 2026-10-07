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
const { config, loadConfig } = require("./security");

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

function isToolEnabled(name) {
  loadConfig();
  return !Array.isArray(config.disabled_tools) || !config.disabled_tools.includes(name);
}

function assertToolAllowed(name, principal) {
  if (!isToolEnabled(name)) throw new Error(`Tool disabled by owner: ${name}`);
  const scopes = principal && Array.isArray(principal.scopes) ? principal.scopes : null;
  if (!scopes || scopes.includes("*")) return;
  const { hasScope, toolScopeOf } = require("./scopes");
  if (!hasScope(scopes, name)) {
    throw new Error(`Tool not allowed for this API key: ${name} (missing scope ${toolScopeOf(name) || "explicit mapping"})`);
  }
}

/**
 * Convert a simple JSON Schema property definition to a Zod schema.
 */
function jsonPropToZod(prop, required = false) {
  let zodType;
  switch (prop.type) {
    case "string":
      zodType = z.string();
      if (prop.minLength !== undefined) zodType = zodType.min(prop.minLength);
      if (prop.maxLength !== undefined) zodType = zodType.max(prop.maxLength);
      if (prop.pattern) zodType = zodType.regex(new RegExp(prop.pattern));
      break;
    case "number":
    case "integer":
      zodType = prop.type === "integer" ? z.number().int() : z.number();
      if (prop.minimum !== undefined) zodType = zodType.min(prop.minimum);
      if (prop.maximum !== undefined) zodType = zodType.max(prop.maximum);
      break;
    case "boolean":          zodType = z.boolean(); break;
    case "object":           zodType = prop.properties ? jsonSchemaToZod(prop) : z.record(z.string(), z.unknown()); break;
    case "array":
      zodType = z.array(prop.items ? jsonPropToZod(prop.items, true) : z.unknown());
      if (prop.minItems !== undefined) zodType = zodType.min(prop.minItems);
      if (prop.maxItems !== undefined) zodType = zodType.max(prop.maxItems);
      break;
    default:                 zodType = z.unknown();
  }
  if (Array.isArray(prop.enum)) zodType = zodType.refine(v => prop.enum.includes(v), { message: `Expected one of: ${prop.enum.join(", ")}` });
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
  return schema.additionalProperties === false ? z.object(zodShape).strict() : z.object(zodShape);
}

/**
 * Register all tools with an MCP Server instance.
 */
function registerAllTools(server, principal = null) {
  const enabledTools = ALL_TOOLS.filter(tool => isToolEnabled(tool.name));
  for (const tool of enabledTools) {
    const zodSchema = jsonSchemaToZod(tool.inputSchema);
    server.tool(tool.name, tool.description, zodSchema.shape, async (args) => {
      const { logAudit } = require("./security");
      const start = Date.now();
      try {
        assertToolAllowed(tool.name, principal);
        const result = await tool.handler(zodSchema.parse(args));
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
          isError: !success,
          ...(result && typeof result === "object" && !Array.isArray(result) ? { structuredContent: result } : {}),
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
  log("info", `Registered ${enabledTools.length} tools across 12 categories`);
}

/**
 * Get a list of tool metadata for OpenAPI / plugin manifests.
 * Returns a simplified array without circular refs.
 */
function getToolList() {
  return ALL_TOOLS.filter(t => isToolEnabled(t.name)).map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

async function dispatchTool(name, args, principal) {
  const tool = TOOL_MAP[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  assertToolAllowed(name, principal);
  return await tool.handler(jsonSchemaToZod(tool.inputSchema).parse(args ?? {}));
}

module.exports = { registerAllTools, dispatchTool, ALL_TOOLS, TOOL_MAP, getToolList, isToolEnabled, assertToolAllowed, jsonSchemaToZod };
