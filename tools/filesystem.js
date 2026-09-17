const fs = require("fs");
const path = require("path");
const { checkPath } = require("../lib/security");

const DEFAULT_READ_LIMIT = 2 * 1024 * 1024;
const MAX_FILE_WRITE = 10 * 1024 * 1024;

function validatePath(filePath) {
  if (!filePath) return;
  const check = checkPath(filePath);
  if (!check.allowed) {
    throw new Error(`Access denied: ${check.reason}`);
  }
}

const filesystemTools = [
  {
    name: "hash_file",
    description: "Stream a file to compute its checksum without loading it into memory. Use SHA-256 to verify downloads or detect changes; MD5 is for legacy compatibility only.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, description: "File path within allowed filesystem roots" },
        algorithm: { type: "string", enum: ["sha256", "sha512", "md5"], default: "sha256" },
        timeout_ms: { type: "integer", minimum: 100, maximum: 50000, default: 30000 },
      }, required: ["path"],
    },
    handler: async ({ path: filePath, algorithm = "sha256", timeout_ms = 30000 }) => {
      let stream, timer;
      try {
        const resolved = path.resolve(filePath);
        validatePath(resolved);
        const hash = require("crypto").createHash(algorithm);
        stream = fs.createReadStream(resolved);
        timer = setTimeout(() => stream.destroy(new Error("Hash operation timed out")), timeout_ms);
        let bytes = 0;
        for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
        return { success: true, data: { path: resolved, algorithm, digest: hash.digest("hex"), bytes_hashed: bytes } };
      } catch (err) {
        return { success: false, code: "HASH_FILE_FAILED", error: err.message };
      } finally { clearTimeout(timer); stream?.destroy(); }
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file from the filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
        encoding: { type: "string", description: "File encoding (default: utf8)", default: "utf8" },
        max_bytes: { type: "integer", minimum: 1, maximum: 20971520, description: "Maximum bytes to return (default 2 MiB)", default: DEFAULT_READ_LIMIT },
        offset_bytes: { type: "integer", minimum: 0, default: 0, description: "Zero-based byte offset; use next_offset_bytes to continue a truncated read. Byte boundaries may split multibyte text." },
      },
      required: ["path"],
    },
    handler: async ({ path: filePath, encoding = "utf8", max_bytes = DEFAULT_READ_LIMIT, offset_bytes = 0 }) => {
      try {
        const resolved = path.resolve(filePath);
        validatePath(resolved);
        const limit = Math.max(1, Math.min(Number(max_bytes) || DEFAULT_READ_LIMIT, 20 * 1024 * 1024));
        const handle = await fs.promises.open(resolved, "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error("Path must be a regular file");
          const buffer = Buffer.alloc(Math.min(limit, Math.max(0, stat.size - offset_bytes)));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset_bytes);
          const truncated = offset_bytes + bytesRead < stat.size;
          return { success: true, truncated, data: {
            content: buffer.subarray(0, bytesRead).toString(encoding), size: stat.size,
            returned_bytes: bytesRead, offset_bytes,
            next_offset_bytes: truncated ? offset_bytes + bytesRead : null, path: resolved,
          } };
        } finally { await handle.close(); }
      } catch (err) {
        return { success: false, error: err.message, code: "READ_FILE_FAILED" };
      }
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to write to" },
        content: { type: "string", description: "Content to write" },
        encoding: { type: "string", description: "File encoding (default: utf8)", default: "utf8" },
      },
      required: ["path", "content"],
    },
    handler: async ({ path: filePath, content, encoding = "utf8" }) => {
      try {
        const resolved = path.resolve(filePath);
        validatePath(resolved);
        if (Buffer.byteLength(content, encoding) > MAX_FILE_WRITE) throw new Error("Content exceeds 10 MiB limit");
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, encoding);
        return {
          success: true,
          data: { path: resolved, bytesWritten: Buffer.byteLength(content, encoding) }
        };
      } catch (err) {
        return { success: false, error: err.message, code: "WRITE_FILE_FAILED" };
      }
    },
  },
  {
    name: "append_file",
    description: "Append content to the end of an existing file (or create it if it doesn't exist).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "Content to append" },
      },
      required: ["path", "content"],
    },
    handler: async ({ path: filePath, content }) => {
      try {
        const resolved = path.resolve(filePath);
        validatePath(resolved);
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_WRITE) throw new Error("Content exceeds 10 MiB limit");
        fs.appendFileSync(resolved, content, "utf8");
        return { success: true, data: { path: resolved } };
      } catch (err) {
        return { success: false, error: err.message, code: "APPEND_FILE_FAILED" };
      }
    },
  },
  {
    name: "delete_file",
    description: "Delete a file or an empty/non-empty directory. (Requires confirmation).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory to delete" },
        recursive: { type: "boolean", description: "If true, delete directory and all its contents", default: false },
        confirm: { type: "boolean", description: "Must set to true to execute", default: false }
      },
      required: ["path"],
    },
    handler: async ({ path: filePath, recursive = false, confirm }) => {
      if (!confirm) {
        return {
          success: false,
          error: "Deleting files or directories is a destructive action. You must pass 'confirm: true' to perform this action.",
          code: "CONFIRMATION_REQUIRED"
        };
      }
      try {
        const resolved = path.resolve(filePath);
        validatePath(resolved);
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          fs.rmSync(resolved, { recursive });
        } else {
          fs.unlinkSync(resolved);
        }
        return { success: true, data: { deleted: resolved } };
      } catch (err) {
        return { success: false, error: err.message, code: "DELETE_FILE_FAILED" };
      }
    },
  },
  {
    name: "list_dir",
    description: "List all files and subdirectories in a directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the directory" },
        show_hidden: { type: "boolean", description: "Include hidden files (starting with .)", default: false },
        offset: { type: "integer", minimum: 0, default: 0, description: "Zero-based offset in name-sorted entries" },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
        entry_type: { type: "string", enum: ["all", "file", "directory"], default: "all" },
      },
      required: ["path"],
    },
    handler: async ({ path: dirPath, show_hidden = false, offset = 0, limit = 200, entry_type = "all" }) => {
      try {
        const resolved = path.resolve(dirPath);
        validatePath(resolved);
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const filtered = entries
          .filter((e) => show_hidden || !e.name.startsWith("."))
          .filter(e => entry_type === "all" || (entry_type === "directory" ? e.isDirectory() : e.isFile()))
          .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        const items = filtered.slice(offset, offset + limit)
          .map((e) => {
            const fullPath = path.join(resolved, e.name);
            let size, mtime;
            try {
              const stat = fs.statSync(fullPath);
              size = stat.size;
              mtime = stat.mtime.toISOString();
            } catch (err) {
              mtime = new Date(0).toISOString();
            }
            return {
              name: e.name,
              type: e.isDirectory() ? "directory" : "file",
              size: e.isFile() ? size : undefined,
              modified: mtime,
            };
          });
        return { success: true, data: { path: resolved, count: items.length, total: filtered.length, offset, next_offset: offset + items.length < filtered.length ? offset + items.length : null, items } };
      } catch (err) {
        return { success: false, error: err.message, code: "LIST_DIR_FAILED" };
      }
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file or directory.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path" },
        destination: { type: "string", description: "Destination path" },
      },
      required: ["source", "destination"],
    },
    handler: async ({ source, destination }) => {
      try {
        const src = path.resolve(source);
        const dst = path.resolve(destination);
        validatePath(src);
        validatePath(dst);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        return { success: true, data: { from: src, to: dst } };
      } catch (err) {
        return { success: false, error: err.message, code: "MOVE_FILE_FAILED" };
      }
    },
  },
  {
    name: "copy_file",
    description: "Copy a file to another location.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source file path" },
        destination: { type: "string", description: "Destination file path" },
      },
      required: ["source", "destination"],
    },
    handler: async ({ source, destination }) => {
      try {
        const src = path.resolve(source);
        const dst = path.resolve(destination);
        validatePath(src);
        validatePath(dst);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        return { success: true, data: { from: src, to: dst } };
      } catch (err) {
        return { success: false, error: err.message, code: "COPY_FILE_FAILED" };
      }
    },
  },
  {
    name: "file_exists",
    description: "Check whether a file or directory exists at the given path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to check" },
      },
      required: ["path"],
    },
    handler: async ({ path: filePath }) => {
      try {
        const resolved = path.resolve(filePath);
        validatePath(resolved);
        const exists = fs.existsSync(resolved);
        let type = null;
        if (exists) {
          try {
            const stat = fs.statSync(resolved);
            type = stat.isDirectory() ? "directory" : "file";
          } catch (e) {}
        }
        return {
          success: true,
          data: { exists, type, path: resolved }
        };
      } catch (err) {
        return { success: false, error: err.message, code: "FILE_EXISTS_FAILED" };
      }
    },
  },
  {
    name: "get_file_info",
    description: "Get detailed metadata about a file or directory (size, dates, permissions).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory" },
      },
      required: ["path"],
    },
    handler: async ({ path: filePath }) => {
      try {
        const resolved = path.resolve(filePath);
        validatePath(resolved);
        const stat = fs.statSync(resolved);
        return {
          success: true,
          data: {
            path: resolved,
            type: stat.isDirectory() ? "directory" : "file",
            size: stat.size,
            created: stat.birthtime.toISOString(),
            modified: stat.mtime.toISOString(),
            accessed: stat.atime.toISOString(),
            mode: stat.mode.toString(8),
          }
        };
      } catch (err) {
        return { success: false, error: err.message, code: "FILE_INFO_FAILED" };
      }
    },
  },
  {
    name: "search_files",
    description: "Search for files by name pattern or text content within a directory.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to search in" },
        pattern: { type: "string", description: "Filename pattern or text to search for" },
        search_content: { type: "boolean", description: "If true, search inside file contents (default: false)", default: false },
        max_results: { type: "number", description: "Maximum results to return (default: 50)", default: 50 },
        timeout_ms: { type: "number", description: "Search timeout in milliseconds (default: 15000)", default: 15000 },
      },
      required: ["directory", "pattern"],
    },
    handler: async ({ directory, pattern, search_content = false, max_results = 50, timeout_ms = 15000 }) => {
      try {
        const resolved = path.resolve(directory);
        validatePath(resolved);
        let results = [];
        const startTime = Date.now();

        const walk = (dir) => {
          if (results.length >= max_results || (Date.now() - startTime > timeout_ms)) return;
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (results.length >= max_results) break;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(fullPath);
            } else {
              if (!search_content) {
                if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
                  results.push(fullPath);
                }
              } else {
                try {
                  const lines = fs.readFileSync(fullPath, "utf8").split("\n");
                  lines.forEach((line, idx) => {
                    if (results.length >= max_results) return;
                    if (line.toLowerCase().includes(pattern.toLowerCase())) {
                      results.push({
                        file: fullPath,
                        line_number: idx + 1,
                        line_content: line.trim()
                      });
                    }
                  });
                } catch { /* skip binary/restricted files */ }
              }
            }
          }
        };

        walk(resolved);
        return {
          success: true,
          data: { pattern, directory: resolved, count: results.length, results }
        };
      } catch (err) {
        return { success: false, error: err.message, code: "SEARCH_FILES_FAILED" };
      }
    },
  },
  {
    name: "read_json",
    description: "Read and parse a JSON file, returning the parsed object.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the JSON file" },
      },
      required: ["path"],
    },
    handler: async ({ path: filePath }) => {
      try {
        const resolved = path.resolve(filePath);
        validatePath(resolved);
        const raw = fs.readFileSync(resolved, "utf8");
        const data = JSON.parse(raw);
        return { success: true, data: { path: resolved, data } };
      } catch (err) {
        return { success: false, error: err.message, code: "READ_JSON_FAILED" };
      }
    },
  },
  {
    name: "write_json",
    description: "Write a JSON object to a file (pretty-printed).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to write the JSON file" },
        data: { type: "object", description: "JSON data to write" },
        indent: { type: "number", description: "Indentation spaces (default: 2)", default: 2 },
      },
      required: ["path", "data"],
    },
    handler: async ({ path: filePath, data, indent = 2 }) => {
      try {
        const resolved = path.resolve(filePath);
        validatePath(resolved);
        const serialized = JSON.stringify(data, null, indent);
        if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_WRITE) throw new Error("Content exceeds 10 MiB limit");
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, serialized, "utf8");
        return { success: true, data: { path: resolved } };
      } catch (err) {
        return { success: false, error: err.message, code: "WRITE_JSON_FAILED" };
      }
    },
  },
  {
    name: "get_folder_size",
    description: "Get folder size and subfolder breakdown with configurable depth limit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path" },
        max_depth: { type: "number", description: "Max recursion depth (default: 1)", default: 1 },
      },
      required: ["path"],
    },
    handler: async ({ path: dirPath, max_depth = 1 }) => {
      try {
        const resolved = path.resolve(dirPath);
        validatePath(resolved);
        if (!fs.existsSync(resolved)) {
          return { success: false, error: `Directory not found: ${resolved}`, code: "NOT_FOUND" };
        }
        
        const calculateDir = (dir, currentDepth) => {
          let totalBytes = 0;
          let fileCount = 0;
          let items = [];
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              try {
                if (entry.isDirectory()) {
                  if (currentDepth < max_depth) {
                    const sub = calculateDir(fullPath, currentDepth + 1);
                    totalBytes += sub.total_bytes;
                    fileCount += sub.file_count;
                    if (currentDepth === 0) {
                      items.push({ name: entry.name, path: fullPath, type: "directory", size_bytes: sub.total_bytes, size_mb: (sub.total_bytes / (1024 * 1024)).toFixed(2) });
                    }
                  }
                } else if (entry.isFile()) {
                  const stat = fs.statSync(fullPath);
                  totalBytes += stat.size;
                  fileCount += 1;
                  if (currentDepth === 0) {
                    items.push({ name: entry.name, path: fullPath, type: "file", size_bytes: stat.size, size_mb: (stat.size / (1024 * 1024)).toFixed(2) });
                  }
                }
              } catch {}
            }
          } catch {}
          return { total_bytes: totalBytes, file_count: fileCount, items };
        };

        const res = calculateDir(resolved, 0);
        return {
          success: true,
          data: {
            path: resolved,
            total_bytes: res.total_bytes,
            total_mb: (res.total_bytes / (1024 * 1024)).toFixed(2),
            total_gb: (res.total_bytes / (1024 * 1024 * 1024)).toFixed(2),
            file_count: res.file_count,
            items: res.items.sort((a, b) => b.size_bytes - a.size_bytes)
          }
        };
      } catch (err) {
        return { success: false, error: err.message, code: "GET_FOLDER_SIZE_FAILED" };
      }
    },
  },
  {
    name: "patch_file",
    description: "Replace exact target text with replacement text inside a file. Errors if target string is not found or matches multiple times unless allow_multiple is true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to file" },
        target_content: { type: "string", description: "Exact string to replace" },
        replacement_content: { type: "string", description: "Replacement content" },
        allow_multiple: { type: "boolean", description: "Allow replacing multiple occurrences (default: false)", default: false }
      },
      required: ["path", "target_content", "replacement_content"],
    },
    handler: async ({ path: filePath, target_content, replacement_content, allow_multiple = false }) => {
      try {
        const resolved = path.resolve(filePath);
        validatePath(resolved);
        if (!fs.existsSync(resolved)) {
          return { success: false, error: `File not found: ${resolved}`, code: "NOT_FOUND" };
        }
        const content = fs.readFileSync(resolved, "utf8");
        const count = content.split(target_content).length - 1;
        if (count === 0) {
          return { success: false, error: "target_content not found in file.", code: "TARGET_NOT_FOUND" };
        }
        if (count > 1 && !allow_multiple) {
          return { success: false, error: `target_content found ${count} times. Set allow_multiple: true to replace all instances.`, code: "MULTIPLE_MATCHES" };
        }
        const updated = allow_multiple
          ? content.split(target_content).join(replacement_content)
          : content.replace(target_content, replacement_content);
        fs.writeFileSync(resolved, updated, "utf8");
        return { success: true, data: { path: resolved, replacements: allow_multiple ? count : 1 } };
      } catch (err) {
        return { success: false, error: err.message, code: "PATCH_FILE_FAILED" };
      }
    },
  },
  {
    name: "grep_files",
    description: "Line-aware content search returning matching file paths, line numbers, and matching line text snippets.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory path to search" },
        pattern: { type: "string", description: "Text or regex pattern to search for" },
        max_matches: { type: "number", description: "Maximum matching lines to return (default: 100)", default: 100 },
        is_regex: { type: "boolean", description: "Treat pattern as regex (default: false)", default: false },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 15000)", default: 15000 },
      },
      required: ["directory", "pattern"],
    },
    handler: async ({ directory, pattern, max_matches = 100, is_regex = false, timeout_ms = 15000 }) => {
      try {
        const resolved = path.resolve(directory);
        validatePath(resolved);
        let matches = [];
        const startTime = Date.now();
        const regex = is_regex ? new RegExp(pattern, "i") : null;

        const walk = (dir) => {
          if (matches.length >= max_matches || (Date.now() - startTime > timeout_ms)) return;
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (matches.length >= max_matches) break;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!["node_modules", ".git", "dist", "build", ".venv"].includes(entry.name)) {
                walk(fullPath);
              }
            } else {
              try {
                const lines = fs.readFileSync(fullPath, "utf8").split("\n");
                lines.forEach((line, idx) => {
                  if (matches.length >= max_matches) return;
                  const isMatch = is_regex ? regex.test(line) : line.toLowerCase().includes(pattern.toLowerCase());
                  if (isMatch) {
                    matches.push({
                      file: fullPath,
                      line_number: idx + 1,
                      line_content: line.trim()
                    });
                  }
                });
              } catch {}
            }
          }
        };

        walk(resolved);
        return { success: true, data: { directory: resolved, pattern, count: matches.length, matches } };
      } catch (err) {
        return { success: false, error: err.message, code: "GREP_FILES_FAILED" };
      }
    },
  },
  {
    name: "edit_file",
    description: "Edit/patch a file by replacing target_content string with replacement_content. Alias for patch_file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to file" },
        target_content: { type: "string", description: "Exact target text to replace" },
        replacement_content: { type: "string", description: "Replacement text" },
        allow_multiple: { type: "boolean", description: "Allow replacing multiple occurrences", default: false }
      },
      required: ["path", "target_content", "replacement_content"],
    },
    handler: async (args) => {
      const patchHandler = filesystemTools.find(t => t.name === "patch_file")?.handler;
      return patchHandler ? patchHandler(args) : { success: false, error: "Handler not found" };
    }
  },
  {
    name: "str_replace",
    description: "Replace string or block in a file. Alias for patch_file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to file" },
        target_content: { type: "string", description: "Target text to replace" },
        replacement_content: { type: "string", description: "Replacement text" },
        allow_multiple: { type: "boolean", description: "Allow replacing multiple occurrences", default: false }
      },
      required: ["path", "target_content", "replacement_content"],
    },
    handler: async (args) => {
      const patchHandler = filesystemTools.find(t => t.name === "patch_file")?.handler;
      return patchHandler ? patchHandler(args) : { success: false, error: "Handler not found" };
    }
  },
  {
    name: "replace_file_content",
    description: "Replace exact text inside a file. Alias for patch_file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to file" },
        target_content: { type: "string", description: "Target string" },
        replacement_content: { type: "string", description: "Replacement string" },
        allow_multiple: { type: "boolean", description: "Allow replacing multiple occurrences", default: false }
      },
      required: ["path", "target_content", "replacement_content"],
    },
    handler: async (args) => {
      const patchHandler = filesystemTools.find(t => t.name === "patch_file")?.handler;
      return patchHandler ? patchHandler(args) : { success: false, error: "Handler not found" };
    }
  },
  {
    name: "grep",
    description: "Search text pattern inside directory files with line numbers and snippets. Alias for grep_files.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to search" },
        pattern: { type: "string", description: "Search pattern" },
        max_matches: { type: "number", description: "Max matches", default: 100 },
        is_regex: { type: "boolean", description: "Treat as regex", default: false }
      },
      required: ["directory", "pattern"],
    },
    handler: async (args) => {
      const grepHandler = filesystemTools.find(t => t.name === "grep_files")?.handler;
      return grepHandler ? grepHandler(args) : { success: false, error: "Handler not found" };
    }
  }
];

module.exports = filesystemTools;
