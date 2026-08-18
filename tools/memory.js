const fs = require("fs");
const path = require("path");
const os = require("os");

const MEMORY_FILE = path.join(os.homedir(), ".pc-control-mcp-memory.json");

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveMemory(data) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), "utf8");
}

const memoryTools = [
  {
    name: "memory_set",
    description:
      "Store a key-value pair in persistent memory. The AI can use this to remember things across conversations — goals, preferences, context, notes, etc. Data persists between sessions.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Memory key (e.g. 'user_name', 'current_project', 'todo_list')" },
        value: { type: "string", description: "Value to store (can be a JSON string for complex data)" },
      },
      required: ["key", "value"],
    },
    handler: async ({ key, value }) => {
      const mem = loadMemory();
      mem[key] = { value, updated_at: new Date().toISOString() };
      saveMemory(mem);
      return { success: true, data: { key, value, updated_at: mem[key].updated_at } };
    },
  },
  {
    name: "memory_get",
    description: "Retrieve a value from persistent memory by key.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Memory key to retrieve" },
      },
      required: ["key"],
    },
    handler: async ({ key }) => {
      const mem = loadMemory();
      const entry = mem[key];
      if (!entry) return { success: true, data: { found: false, key, value: null } };
      return { success: true, data: { found: true, key, value: entry.value, updated_at: entry.updated_at } };
    },
  },
  {
    name: "memory_list",
    description: "List all keys currently stored in persistent memory.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const mem = loadMemory();
      const keys = Object.entries(mem).map(([key, entry]) => ({
        key,
        value_preview: String(entry.value).slice(0, 100),
        updated_at: entry.updated_at,
      }));
      return { success: true, data: { count: keys.length, keys } };
    },
  },
  {
    name: "memory_delete",
    description: "Delete a specific key from persistent memory.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to delete" },
      },
      required: ["key"],
    },
    handler: async ({ key }) => {
      const mem = loadMemory();
      const existed = key in mem;
      delete mem[key];
      saveMemory(mem);
      return { success: true, data: { key, existed } };
    },
  },
  {
    name: "memory_clear",
    description: "Clear ALL persistent memory. Use with caution. (Requires confirmation).",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "Must set to true to clear all memory", default: false }
      }
    },
    handler: async ({ confirm }) => {
      if (!confirm) {
        return {
          success: false,
          error: "Clearing all persistent memory is a destructive action. You must pass 'confirm: true' to perform this action.",
          code: "CONFIRMATION_REQUIRED"
        };
      }
      const mem = loadMemory();
      const count = Object.keys(mem).length;
      saveMemory({});
      return { success: true, data: { cleared_keys: count } };
    },
  },
  {
    name: "memory_append",
    description: "Append text to an existing memory value (useful for growing logs, todo lists, notes).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Memory key to append to" },
        text: { type: "string", description: "Text to append" },
        separator: { type: "string", description: "Separator between old and new (default: newline)", default: "\n" },
      },
      required: ["key", "text"],
    },
    handler: async ({ key, text, separator = "\n" }) => {
      const mem = loadMemory();
      const existing = mem[key]?.value || "";
      const newValue = existing ? `${existing}${separator}${text}` : text;
      mem[key] = { value: newValue, updated_at: new Date().toISOString() };
      saveMemory(mem);
      return { success: true, data: { key, value: newValue } };
    },
  },
];

module.exports = memoryTools;
