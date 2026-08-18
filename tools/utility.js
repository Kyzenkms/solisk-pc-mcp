const utilityTools = [
  {
    name: "encode_base64",
    description: "Encode a string to Base64.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to encode" },
        encoding: { type: "string", description: "Source encoding (default: utf8)", default: "utf8" },
      },
      required: ["text"],
    },
    handler: async ({ text, encoding = "utf8" }) => {
      try {
        const encoded = Buffer.from(text, encoding).toString("base64");
        return {
          success: true,
          data: { encoded, original_length: text.length, encoded_length: encoded.length }
        };
      } catch (e) {
        return { success: false, error: e.message, code: "ENCODE_FAILED" };
      }
    },
  },
  {
    name: "decode_base64",
    description: "Decode a Base64 string back to plain text.",
    inputSchema: {
      type: "object",
      properties: {
        encoded: { type: "string", description: "The Base64 encoded string" },
        output_encoding: { type: "string", description: "Output encoding (default: utf8)", default: "utf8" },
      },
      required: ["encoded"],
    },
    handler: async ({ encoded, output_encoding = "utf8" }) => {
      try {
        const decoded = Buffer.from(encoded, "base64").toString(output_encoding);
        return {
          success: true,
          data: { decoded, length: decoded.length }
        };
      } catch (e) {
        return { success: false, error: e.message, code: "DECODE_FAILED" };
      }
    },
  },
  {
    name: "generate_uuid",
    description: "Generate one or more random UUIDs (v4).",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of UUIDs to generate (default: 1)", default: 1 },
      },
    },
    handler: async ({ count = 1 }) => {
      const uuids = Array.from({ length: Math.min(count, 100) }, () =>
        "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        })
      );
      return {
        success: true,
        data: { uuids, count: uuids.length }
      };
    },
  },
  {
    name: "hash_text",
    description: "Compute a hash of a string (md5, sha1, sha256, sha512).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to hash" },
        algorithm: {
          type: "string",
          description: "Hash algorithm: md5, sha1, sha256, sha512 (default: sha256)",
          default: "sha256",
        },
      },
      required: ["text"],
    },
    handler: async ({ text, algorithm = "sha256" }) => {
      try {
        const crypto = require("crypto");
        const hash = crypto.createHash(algorithm).update(text, "utf8").digest("hex");
        return {
          success: true,
          data: { algorithm, hash, input_length: text.length }
        };
      } catch (e) {
        return { success: false, error: e.message, code: "HASH_FAILED" };
      }
    },
  },
  {
    name: "format_json",
    description: "Parse and pretty-print a JSON string.",
    inputSchema: {
      type: "object",
      properties: {
        json_string: { type: "string", description: "JSON string to format" },
        indent: { type: "number", description: "Indentation spaces (default: 2)", default: 2 },
      },
      required: ["json_string"],
    },
    handler: async ({ json_string, indent = 2 }) => {
      try {
        const parsed = JSON.parse(json_string);
        return {
          success: true,
          data: { formatted: JSON.stringify(parsed, null, indent) }
        };
      } catch (e) {
        return { success: false, error: e.message, code: "INVALID_JSON" };
      }
    },
  },
  {
    name: "timestamp_now",
    description: "Get the current date and time in multiple formats.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const now = new Date();
      return {
        success: true,
        data: {
          iso: now.toISOString(),
          unix: Math.floor(now.getTime() / 1000),
          unix_ms: now.getTime(),
          utc: now.toUTCString(),
          local: now.toLocaleString(),
          date: now.toLocaleDateString(),
          time: now.toLocaleTimeString(),
        }
      };
    },
  },
];

module.exports = utilityTools;
