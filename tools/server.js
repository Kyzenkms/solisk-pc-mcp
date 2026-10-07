const { execPowershellAsync } = require("../lib/powershell");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const runningServers = {};

const serverTools = [
  {
    name: "serve_directory",
    description: "Start a local HTTP web server that serves files from a directory. Returns the local URL.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to serve (absolute path)" },
        port: { type: "number", description: "Port to listen on (default: 8080)", default: 8080 },
      },
      required: ["directory"],
    },
    handler: async ({ directory, port = 8080 }) => {
      try {
        const resolved = path.resolve(directory);
        if (!fs.existsSync(resolved)) {
          return { success: false, error: `Directory not found: ${resolved}`, code: "DIR_NOT_FOUND" };
        }

        if (runningServers[port]) {
          try { runningServers[port].close(); } catch {}
        }

        const server = http.createServer((req, res) => {
          let filePath = path.join(resolved, req.url === "/" ? "index.html" : req.url);
          if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            filePath = path.join(filePath, "index.html");
          }
          if (!fs.existsSync(filePath)) {
            res.writeHead(404); res.end("404 Not Found"); return;
          }
          const ext = path.extname(filePath).toLowerCase();
          const mimeMap = {
            ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
            ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
            ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
            ".txt": "text/plain", ".pdf": "application/pdf",
          };
          res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream" });
          fs.createReadStream(filePath).pipe(res);
        });

        server.listen(port);
        runningServers[port] = server;

        return {
          success: true,
          data: {
            url: `http://localhost:${port}`,
            directory: resolved,
            port,
            message: "Server running. Use expose_port to get a public URL."
          }
        };
      } catch (err) {
        return { success: false, error: err.message, code: "SERVE_DIR_FAILED" };
      }
    },
  },
  {
    name: "stop_server",
    description: "Stop a local web server running on a specific port.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Port number of the server to stop" },
      },
      required: ["port"],
    },
    handler: async ({ port }) => {
      if (!runningServers[port]) {
        return { success: false, error: `No server running on port ${port}`, code: "SERVER_NOT_RUNNING" };
      }
      try {
        runningServers[port].close();
        delete runningServers[port];
        return { success: true, data: { port, message: `Server on port ${port} stopped` } };
      } catch (err) {
        return { success: false, error: err.message, code: "STOP_SERVER_FAILED" };
      }
    },
  },
  {
    name: "expose_port",
    description: "Expose a local port to the internet using Cloudflare Tunnel. Returns a public HTTPS URL. (Requires confirmation).",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Local port to expose (e.g. 8080)" },
        confirm: { type: "boolean", description: "Must set to true to proceed with exposing network port", default: false }
      },
      required: ["port"],
    },
    handler: async ({ port, confirm }) => {
      if (!confirm) {
        return {
          success: false,
          error: "Exposing a port to the internet opens up a pathway to your local machine. You must pass 'confirm: true' to perform this action.",
          code: "CONFIRMATION_REQUIRED"
        };
      }
      const cfPath = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
      if (!fs.existsSync(cfPath)) {
        return { success: false, error: "cloudflared not found. Install it with: winget install Cloudflare.cloudflared", code: "CLOUDFLARED_NOT_INSTALLED" };
      }

      return new Promise((resolve) => {
        const proc = spawn(cfPath, ["tunnel", "--url", `http://localhost:${port}`], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        let url = null;
        const timeout = setTimeout(() => {
          if (!url) {
            proc.kill();
            resolve({ success: false, error: "Timeout waiting for tunnel URL", code: "TUNNEL_TIMEOUT" });
          }
        }, 30000);

        const checkOutput = (data) => {
          const text = data.toString();
          const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (match && !url) {
            url = match[0];
            clearTimeout(timeout);
            proc.unref(); // keep running in background
            resolve({
              success: true,
              data: {
                public_url: url,
                mcp_url: `${url}/mcp`,
                local_port: port,
                message: "Tunnel is live! Keep this process running."
              }
            });
          }
        };

        proc.stdout.on("data", checkOutput);
        proc.stderr.on("data", checkOutput);
        proc.on("error", (err) => resolve({ success: false, error: err.message, code: "SPAWN_FAILED" }));
      });
    },
  },
  {
    name: "download_file",
    description: "Download a file from a URL and save it to disk.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to download from" },
        save_path: { type: "string", description: "Local path to save the file" },
        timeout_ms: { type: "number", description: "Download timeout in milliseconds (default: 30000)", default: 30000 },
      },
      required: ["url", "save_path"],
    },
    handler: async ({ url, save_path, timeout_ms = 30000 }) => {
      try {
        const resolved = path.resolve(save_path);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        const res = await execPowershellAsync(`Invoke-WebRequest -Uri '${url}' -OutFile '${resolved.replace(/'/g, "''")}' -UseBasicParsing`, { timeout_ms });
        if (res.status === 0) {
          const stat = fs.statSync(resolved);
          return { success: true, data: { saved_to: resolved, size_bytes: stat.size } };
        }
        const errDetail = res.stderr || res.error || "Download failed";
        if (/remote name could not be resolved|unable to connect|timed? out|nameresolutionfailure|network/i.test(errDetail)) {
          return {
            success: false,
            error: "No internet connection or download host unreachable. Please verify your connection and try again.",
            technical_details: errDetail,
            code: "NO_INTERNET",
          };
        }
        return { success: false, error: errDetail, code: "DOWNLOAD_FAILED" };
      } catch (err) {
        const msg = err.message || "";
        if (/getaddrinfo|network|internet|offline|disconnected|unreachable|timed? out/i.test(msg)) {
          return {
            success: false,
            error: "No internet connection or download host unreachable. Please verify your connection and try again.",
            technical_details: msg,
            code: "NO_INTERNET",
          };
        }
        return { success: false, error: msg, code: "DOWNLOAD_ERROR" };
      }
    },
  },
  {
    name: "check_port",
    description: "Check if a specific port is open and something is listening on it.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Port number to check" },
        host: { type: "string", description: "Host to check (default: localhost)", default: "localhost" },
      },
      required: ["port"],
    },
    handler: async ({ port, host = "localhost" }) => {
      return new Promise((resolve) => {
        const net = require("net");
        const socket = new net.Socket();
        socket.setTimeout(2000);
        socket.on("connect", () => {
          socket.destroy();
          resolve({ success: true, data: { port, host, open: true } });
        });
        socket.on("timeout", () => {
          socket.destroy();
          resolve({ success: true, data: { port, host, open: false } });
        });
        socket.on("error", () => {
          resolve({ success: true, data: { port, host, open: false } });
        });
        socket.connect(port, host);
      });
    },
  },
];

module.exports = serverTools;
