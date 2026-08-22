/**
 * relay-client.js — Production Relay Client
 *
 * Connects the local pc-control-mcp-pro server to the cloud relay
 * server via WebSocket. Handles:
 *   - StreamableHTTP request forwarding (JSON-RPC + SSE)
 *   - Session ID passthrough
 *   - Auto-reconnect with exponential backoff
 *   - Heartbeat keepalive
 */

"use strict";

const http = require("http");
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const { log } = require("./middleware");

function startRelayClient(config) {
  if (!config.relay_url || !config.name) {
    log("warn", "Relay URL or name not configured — skipping relay client", { category: "CONN" });
    return;
  }

  let WebSocket;
  try {
    WebSocket = require("ws");
  } catch {
    log("error", "ws module not installed — relay client disabled", { category: "ERROR" });
    return;
  }

  const code = config.name;
  const wsUrl = config.relay_url.replace(/^http/, "ws") + `?code=${encodeURIComponent(code)}`;
  const localPort = config.port || 3000;

  const MAX_RECONNECT_ATTEMPTS = 10;
  let client = null;
  let reconnectDelay = 1000;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let isOffline = false;

  function checkInternetConnection() {
    return new Promise((resolve) => {
      dns.lookup("1.1.1.1", (err) => {
        if (err) {
          dns.lookup("google.com", (err2) => {
            resolve(!err2);
          });
        } else {
          resolve(true);
        }
      });
    });
  }

  function cleanupClient() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (client) {
      client.removeAllListeners();
      try { client.terminate(); } catch {}
      client = null;
    }
  }

  async function connect() {
    cleanupClient();

    // Check internet connection first
    const online = await checkInternetConnection();
    if (!online) {
      if (!isOffline) {
        isOffline = true;
        log("error", "Internet connection unavailable — relay reconnect paused", { category: "NET", offline: true });
      }
      scheduleReconnect();
      return;
    }

    if (isOffline) {
      isOffline = false;
      log("info", "Internet connection restored", { category: "NET", online: true });
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log("warn", `Reached maximum reconnection attempts (${MAX_RECONNECT_ATTEMPTS}/${MAX_RECONNECT_ATTEMPTS}) — retries paused`, { category: "NET", maxRetries: true });
      return;
    }

    reconnectAttempts++;
    log("info", `Connecting to relay (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}): ${wsUrl}`, { category: "CONN", attempt: reconnectAttempts });

    try {
      client = new WebSocket(wsUrl, {
        handshakeTimeout: 10_000,
      });
    } catch (err) {
      log("error", `Failed to init WebSocket: ${err.message}`, { category: "CONN" });
      scheduleReconnect();
      return;
    }

    client.on("open", () => {
      log("info", "Connected to relay server", { category: "CONN" });
      reconnectDelay = 1000; // reset backoff
      reconnectAttempts = 0; // reset retry counter
      isOffline = false;

      // Register room & active API key with relay
      try {
        const { loadConfig, config: secConfig } = require("./security");
        loadConfig();
        const activeKey = secConfig.api_key || config.api_key || "";
        const uKeys = secConfig.user_keys || config.user_keys || [];
        client.send(JSON.stringify({
          type: "init",
          code,
          apiKey: activeKey,
          userKeys: uKeys,
        }));
      } catch {}

      // Real-time watcher: sync updated API key whenever config.json is saved
      const configFilePath = process.env.MCP_CONFIG_PATH || path.join(__dirname, "..", "config.json");
      if (fs.existsSync(configFilePath)) {
        let syncDebounce = null;
        const triggerSync = () => {
          clearTimeout(syncDebounce);
          syncDebounce = setTimeout(() => {
            try {
              const { loadConfig, config: secConfig } = require("./security");
              loadConfig();
              const newKey = (secConfig.api_key || "").trim();
              const uKeys = secConfig.user_keys || config.user_keys || [];
              if (client && client.readyState === 1) {
                client.send(JSON.stringify({
                  type: "init",
                  code,
                  apiKey: newKey,
                  userKeys: uKeys,
                }));
                log("info", "Synchronized updated API keys to VPS relay");
              }
            } catch {}
          }, 150);
        };

        try { fs.watch(configFilePath, triggerSync); } catch {}
        try {
          fs.unwatchFile(configFilePath);
          fs.watchFile(configFilePath, { interval: 500 }, triggerSync);
        } catch {}
      }

      // Heartbeat: send ping every 25s
      heartbeatTimer = setInterval(() => {
        if (client.readyState === 1) {
          client.ping();
        }
      }, 25_000);

      // Print the public URL
      const relayHttpUrl = config.relay_url.replace(/^ws/, "http").replace(/\?code=.*/, "");
      console.log(`\n${"─".repeat(54)}`);
      console.log(`  \x1b[1m\x1b[32m✔ RELAY CONNECTED\x1b[0m`);
      console.log(`  \x1b[1m\x1b[36m  ${relayHttpUrl}/mcp/${code}\x1b[0m`);
      console.log(`  \x1b[2m  ↑ paste into ChatGPT / Claude.ai\x1b[0m`);
      console.log(`${"─".repeat(54)}\n`);
    });

    client.on("message", (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.type !== "request") return;

        const { requestId, sessionId, payload } = msg;
        const { method, path, headers, body, toolName } = payload;

        // ── Forward to local Express server ───────────────────────────────────
        // Normalize path: /mcp/:code -> /mcp
        let localPath = path || "/mcp";
        localPath = localPath.replace(/^\/mcp\/[^/]+(.*)?$/, (_, rest) => "/mcp" + (rest || ""));

        // For /tool/:name, strip the code from the path
        if (localPath.startsWith("/tool/") && localPath.split("/").length > 3) {
          // /tool/<device-name>/run_command -> /tool/run_command
          const parts = localPath.split("/");
          parts.splice(2, 1); // remove the code segment
          localPath = parts.join("/");
        }

        // Determine the content-type from the original request
        const origContentType = (headers && (headers["content-type"] || headers["Content-Type"])) || "application/json";
        const origAccept      = (headers && (headers["accept"] || headers["Accept"])) || "application/json, text/event-stream, text/html";

        // Serialize body based on content-type
        let bodyToSend;
        if (method !== "GET" && method !== "HEAD" && body !== undefined) {
          if (origContentType.includes("application/x-www-form-urlencoded") && typeof body === "object" && body !== null) {
            // Re-encode form data as URL-encoded string
            bodyToSend = Object.entries(body)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
              .join("&");
          } else {
            bodyToSend = typeof body === "string" ? body : JSON.stringify(body);
          }
        }

        let apiKey = config.api_key || "";
        try {
          const { loadConfig, config: secConfig } = require("./security");
          loadConfig();
          apiKey = secConfig.api_key || apiKey;
        } catch {}

        const options = {
          hostname: "localhost",
          port: localPort,
          path: localPath,
          method: method || "POST",
          headers: {
            "Content-Type": origContentType,
            "Accept": origAccept,
            ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            ...(headers && headers["mcp-session-id"] ? { "mcp-session-id": headers["mcp-session-id"] } : {}),
            ...(bodyToSend !== undefined ? { "Content-Length": Buffer.byteLength(bodyToSend).toString() } : {}),
          },
        };

        const localReq = http.request(options, (localRes) => {
          const newSessionId = localRes.headers["mcp-session-id"] || sessionId;
          const contentType = localRes.headers["content-type"] || "";
          const statusCode  = localRes.statusCode || 200;

          // ── Redirect response (3xx) — forward Location header ────────────
          if (statusCode >= 300 && statusCode < 400) {
            const location = localRes.headers["location"] || "";
            client.send(JSON.stringify({
              type: "response",
              requestId,
              sessionId: newSessionId,
              statusCode,
              contentType,
              redirectLocation: location,
              payload: { redirect: location },
            }));
            localRes.resume();
            return;
          }

          // ── Streaming SSE response or Normal response ─────────────────────
          if (contentType.includes("text/event-stream")) {
            // First, return the HTTP response headers immediately so the HTTP request completes
            client.send(JSON.stringify({
              type: "response",
              requestId,
              sessionId: newSessionId,
              statusCode,
              contentType,
              payload: "",
            }));

            // Stream chunks as they arrive from local Express MCP server
            localRes.on("data", (chunk) => {
              try {
                const str = chunk.toString();
                client.send(JSON.stringify({
                  type: "sseChunk",
                  sessionId: newSessionId,
                  payload: str,
                }));
              } catch {}
            });

            localRes.on("end", () => {
              try {
                client.send(JSON.stringify({
                  type: "sseClose",
                  sessionId: newSessionId,
                }));
              } catch {}
            });
            return;
          }

          let bodyData = "";
          localRes.on("data", (chunk) => {
            bodyData += chunk;
          });

          localRes.on("end", () => {
            try {
              let parsed;
              let finalContentType = contentType;

              if (contentType.includes("text/html")) {
                parsed = bodyData;
              } else if (contentType.includes("application/json") || bodyData.trim().startsWith("{") || bodyData.trim().startsWith("[")) {
                try {
                  parsed = JSON.parse(bodyData);
                } catch {
                  parsed = bodyData;
                }
              } else {
                parsed = bodyData || { ok: true };
              }

              client.send(JSON.stringify({
                type: "response",
                requestId,
                sessionId: newSessionId,
                statusCode,
                contentType: finalContentType,
                payload: parsed,
              }));
            } catch (e) {
              client.send(JSON.stringify({
                type: "response",
                requestId,
                sessionId: newSessionId,
                statusCode: 500,
                contentType: "application/json",
                payload: { error: "Parse error", raw: bodyData.slice(0, 300) },
              }));
            }
          });
        });

        localReq.on("error", (e) => {
          log("error", `Relay local request error: ${e.message}`);
          client.send(JSON.stringify({
            type: "response",
            requestId,
            sessionId,
            payload: { error: e.message },
          }));
        });

        localReq.setTimeout(55_000, () => {
          localReq.destroy();
          client.send(JSON.stringify({
            type: "response",
            requestId,
            sessionId,
            payload: { error: "Local request timeout" },
          }));
        });

        // Write body for POST/PUT using the pre-serialized bodyToSend
        if (bodyToSend !== undefined) {
          localReq.write(bodyToSend);
        }
        localReq.end();

      } catch (err) {
        log("error", `Relay message error: ${err.message}`);
      }
    });

    client.on("close", () => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      log("warn", "Relay disconnected — scheduling reconnect...", { category: "CONN" });
      scheduleReconnect();
    });

    client.on("error", (err) => {
      log("error", `Relay WebSocket error: ${err.message}`, { category: "NET" });
      // close handler will reconnect
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log("warn", `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}/${MAX_RECONNECT_ATTEMPTS}) reached. Automatic retries paused. Use manualReconnect() to try again.`, { category: "NET", maxRetries: true });
      return;
    }
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000); // exponential backoff, max 30s
    log("info", `Scheduling reconnect attempt in ${Math.round(reconnectDelay / 1000)}s...`, { category: "CONN" });
    reconnectTimer = setTimeout(connect, reconnectDelay);
  }

  function manualReconnect() {
    log("info", "Manual reconnection triggered by user", { category: "CONN" });
    reconnectAttempts = 0;
    reconnectDelay = 1000;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connect();
  }

  connect();
  return { connect, manualReconnect, resetRetries: () => { reconnectAttempts = 0; } };
}

module.exports = { startRelayClient };
