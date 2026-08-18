#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
#  PC Control MCP — VPS Relay Installer
#  Run this ON your VPS to install the relay with Docker + Caddy + automatic
#  HTTPS. You need a domain A-record already pointing at this VPS.
#
#  Usage:
#    ssh root@YOUR_VPS
#    bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kyzenkms/solisk-mcp/master/self-hosted-setup/vps/install.sh)"
#
#  Output:
#    - A <device-name> and <api-key> you paste into the Windows desktop app.
# ──────────────────────────────────────────────────────────────────────────────

# ── Prerequisites ─────────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root." >&2
  exit 1
fi

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "Docker and Compose already installed."
    return
  fi

  if [ ! -r /etc/os-release ]; then
    echo "ERROR: Cannot identify Linux distribution (/etc/os-release missing)." >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  local family="${ID_LIKE:-$ID}"
  local installed=0
  echo "Detected OS: ${PRETTY_NAME:-$ID}"
  echo "Installing Docker and Docker Compose..."

  # Native repositories vary across provider images. Let a failed native attempt
  # reach the official Docker fallback instead of terminating under `set -e`.
  set +e
  case " $family $ID " in
    *" alpine "*)
      apk update
      apk add docker docker-cli-compose curl ca-certificates
      rc-update add docker default 2>/dev/null || true
      service docker start 2>/dev/null || true
      installed=1
      ;;
    *" arch "*|*" manjaro "*)
      pacman -Sy --noconfirm docker docker-compose curl ca-certificates
      systemctl enable --now docker 2>/dev/null || true
      installed=1
      ;;
    *" suse "*|*" opensuse "*)
      zypper --non-interactive refresh
      zypper --non-interactive install docker docker-compose curl ca-certificates
      systemctl enable --now docker 2>/dev/null || true
      installed=1
      ;;
    *" fedora "*)
      dnf install -y dnf-plugins-core curl ca-certificates
      dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo || true
      dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      systemctl enable --now docker 2>/dev/null || true
      installed=1
      ;;
    *" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*)
      if command -v dnf >/dev/null 2>&1; then
        dnf install -y dnf-plugins-core curl ca-certificates
        dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo || true
        dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      else
        yum install -y yum-utils curl ca-certificates
        yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo || true
        yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      fi
      systemctl enable --now docker 2>/dev/null || true
      installed=1
      ;;
    *" amzn "*)
      dnf install -y docker curl ca-certificates
      systemctl enable --now docker 2>/dev/null || true
      installed=1
      ;;
    *" debian "*|*" ubuntu "*|*" linuxmint "*)
      local docker_repo_id="debian"
      if [ "$ID" = "ubuntu" ] || echo " ${ID_LIKE:-} " | grep -q " ubuntu "; then
        docker_repo_id="ubuntu"
      fi
      apt-get update -qq
      apt-get install -y -qq ca-certificates curl >/dev/null
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/${docker_repo_id}/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${docker_repo_id} ${UBUNTU_CODENAME:-${VERSION_CODENAME:-stable}} stable" > /etc/apt/sources.list.d/docker.list
      apt-get update -qq
      apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
      systemctl enable --now docker 2>/dev/null || true
      installed=1
      ;;
  esac
  set -e

  if [ "$installed" -ne 1 ] || ! command -v docker >/dev/null 2>&1; then
    echo "Native Docker package setup unavailable; trying Docker's official installer..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
  fi

  if command -v docker >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
    local compose_arch
    case "$(uname -m)" in
      x86_64|amd64) compose_arch="x86_64" ;;
      aarch64|arm64) compose_arch="aarch64" ;;
      armv7l|armv7) compose_arch="armv7" ;;
      *) compose_arch="" ;;
    esac
    if [ -n "$compose_arch" ]; then
      echo "Installing Docker Compose v2 CLI plugin..."
      mkdir -p /usr/local/lib/docker/cli-plugins
      curl -fsSL "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-${compose_arch}" -o /usr/local/lib/docker/cli-plugins/docker-compose
      chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    fi
  fi

  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: Docker Compose v2 installation failed. Install Docker Engine with Compose v2 and rerun." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "ERROR: Docker is installed but its daemon is not running." >&2
    exit 1
  fi
  echo "Docker and Compose installed."
}

install_docker

# ── User input ────────────────────────────────────────────────────────────────
echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║  PC Control MCP — VPS Relay Setup             ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

read -r -p "Domain type: (1) I own a domain with HTTPS  (2) Use sslip.io (IP-based, no HTTPS): " DOMAIN_TYPE
DOMAIN_TYPE="${DOMAIN_TYPE:-1}"

if [ "$DOMAIN_TYPE" = "2" ]; then
  VPS_IP=$(curl -s http://checkip.amazonaws.com || curl -s https://api.ipify.org || echo "")
  if [ -z "$VPS_IP" ]; then
    echo "ERROR: Could not detect public IP." >&2; exit 1
  fi
  DOMAIN=$(echo "$VPS_IP" | tr '.' '-')
  DOMAIN="$DOMAIN.sslip.io"
  echo "Using: $DOMAIN"
  ACME_EMAIL=""
else
  read -r -p "Your domain (e.g. mcp.example.com): " DOMAIN
  DOMAIN=$(echo "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed 's|^https\?://||;s|/.*$||')
  if ! echo "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'; then
    echo "ERROR: Invalid domain: $DOMAIN" >&2; exit 1
  fi
  read -r -p "Email for Let's Encrypt certificates: " ACME_EMAIL
  if [ -z "$ACME_EMAIL" ]; then
    echo "ERROR: Email is required." >&2; exit 1
  fi
fi

read -r -p "Device name for this relay (e.g. home-pc): " DEVICE_NAME
DEVICE_NAME=$(echo "$DEVICE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/^-\+//; s/-\+$//')
if [ -z "$DEVICE_NAME" ]; then
  echo "ERROR: Invalid device name." >&2; exit 1
fi

ADMIN_TOKEN=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
API_KEY=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')

# ── Write deployment files ────────────────────────────────────────────────────
INSTALL_DIR="/opt/pc-control-mcp"
mkdir -p "$INSTALL_DIR/relay"

cat > "$INSTALL_DIR/.env" <<EOF
RELAY_DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
RELAY_ADMIN_TOKEN=$ADMIN_TOKEN
EOF
chmod 600 "$INSTALL_DIR/.env"

if [ "$DOMAIN_TYPE" = "2" ]; then
  # sslip.io: expose relay on port 80 directly, no Caddy
  cat > "$INSTALL_DIR/docker-compose.yml" <<COMPOSEEOF
services:
  relay:
    build: ./relay
    restart: unless-stopped
    ports:
      - "80:3000"
    environment:
      PORT: "3000"
      RELAY_ADMIN_TOKEN: "\${RELAY_ADMIN_TOKEN}"
    volumes:
      - relay-data:/app/data

volumes:
  relay-data:
COMPOSEEOF
else
  # Real domain: Caddy handles HTTPS
  cat > "$INSTALL_DIR/Caddyfile" <<CADDYEOF
{
  email $ACME_EMAIL
}

$DOMAIN {
  encode zstd gzip
  reverse_proxy relay:3000
}
CADDYEOF

  cat > "$INSTALL_DIR/docker-compose.yml" <<COMPOSEEOF
services:
  relay:
    build: ./relay
    restart: unless-stopped
    environment:
      PORT: "3000"
      RELAY_ADMIN_TOKEN: "\${RELAY_ADMIN_TOKEN}"
    volumes:
      - relay-data:/app/data
    networks:
      - relay

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    environment:
      RELAY_DOMAIN: "\${RELAY_DOMAIN}"
      ACME_EMAIL: "\${ACME_EMAIL}"
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    networks:
      - relay
    depends_on:
      - relay

networks:
  relay:

volumes:
  relay-data:
  caddy-data:
  caddy-config:
COMPOSEEOF
fi

cat > "$INSTALL_DIR/relay/Dockerfile" <<DOCKERFILE
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js keys.js scopes.js ./

RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
DOCKERFILE

cat > "$INSTALL_DIR/relay/.dockerignore" <<DOCKERIGNORE
node_modules
rooms.json
oauth_tokens.json
*.log
.env
DOCKERIGNORE

cat > "$INSTALL_DIR/relay/package.json" <<PKGJSON
{
  "name": "mcp-cloud-relay",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "express": "^4.19.2", "ws": "^8.17.0" }
}
PKGJSON

# ── Copy relay source files ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/relay/server.js" ]; then
  cp "$SCRIPT_DIR/relay/"*.js "$INSTALL_DIR/relay/"
else
  # Script is running via curl pipe — write server.js inline
  cat > "$INSTALL_DIR/relay/server.js" <<'RELAYSRV'
"use strict";
const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "50mb", strict: false }));
app.use(express.urlencoded({ extended: true }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400) && 'body' in err) return res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  next(err);
});
const ALLOWED_ORIGINS = new Set(["https://claude.ai","https://www.claude.ai","https://chat.openai.com","https://chatgpt.com","https://platform.openai.com","https://cursor.sh","https://www.cursor.com"]);
app.use((req, res, next) => {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
  const origin = req.headers.origin;
  const allowed = !origin || ALLOWED_ORIGINS.has(origin) || origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1");
  if (allowed) { if (origin) res.header("Access-Control-Allow-Origin", origin); res.header("Vary","Origin"); }
  res.header("Access-Control-Allow-Methods","GET, POST, DELETE, OPTIONS, PUT, PATCH");
  res.header("Access-Control-Allow-Headers","Content-Type, Authorization, mcp-session-id, openai-ephemeral-user-id, openai-conversation-id, x-request-id");
  res.header("Access-Control-Expose-Headers","mcp-session-id, x-request-id");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
const rateBuckets = new Map();
function rateLimit(opts = {}) {
  const windowMs = opts.windowMs || 60000;
  const max = opts.max || 300;
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "anon";
    const now = Date.now();
    if (!rateBuckets.has(ip)) rateBuckets.set(ip, []);
    const b = rateBuckets.get(ip);
    while (b.length && b[0].t < now - windowMs) b.shift();
    const count = b.reduce((s, e) => s + e.c, 0);
    if (count >= max) { res.header("Retry-After", Math.ceil(windowMs / 1000)); return res.status(429).json({ error: "rate_limited" }); }
    const last = b[b.length - 1];
    if (last && last.t > now - 1000) last.c++; else b.push({ t: now, c: 1 });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [key, b] of rateBuckets) { while (b.length && b[0].t < now - 120000) b.shift(); if (!b.length) rateBuckets.delete(key); } }, 60000).unref();
app.use(rateLimit());
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Map();
const pendingReqs = new Map();
const sseStreams = new Map();
const sseEventBuf = new Map();
const codeSession = new Map();
const sessionInit = new Map();
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");
const TOKENS_FILE = path.join(DATA_DIR, "oauth_tokens.json");
let rooms = {};
let tokens = {};
try { if (fs.existsSync(ROOMS_FILE)) rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8")); } catch {}
try { if (fs.existsSync(TOKENS_FILE)) tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")); } catch {}
function saveState() { try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)); } catch {} try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2)); } catch {} }
const REQUEST_TIMEOUT = 60000;
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("hex"); }
function escHtml(s) { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
function baseUrl(req) { const proto = req.headers["x-forwarded-proto"] || req.protocol || "https"; const host = req.headers["x-forwarded-host"] || req.headers["host"] || `localhost:${req.socket.localPort || 3000}`; return `${proto}://${host}`; }

function hashKey(key) { const salt = crypto.randomBytes(16).toString("hex"); return { salt, hash: crypto.scryptSync(key, salt, 64).toString("hex") }; }
function verifyKey(key, salt, hash) { return hash === crypto.scryptSync(key, salt, 64).toString("hex"); }
const FULL_SCOPES = ["pc:file:read","pc:file:write","pc:shell","pc:input","pc:system","pc:network","pc:admin","pc:notification","pc:clipboard","pc:process","pc:screenshot","pc:memory","pc:git","pc:server"];
function normalizeScopes(scopes) { if (!Array.isArray(scopes) || scopes.length === 0) return FULL_SCOPES.slice(); return scopes.filter(s => FULL_SCOPES.includes(s)); }
function hasScope(userScopes, toolName) { if (Array.isArray(userScopes) && userScopes.includes("pc:admin")) return true; if (!Array.isArray(userScopes) || userScopes.length === 0) return true; const toolParts = toolName.split("_"); const cat = toolParts.length > 1 ? toolParts[0] : toolName; const needed = `pc:${cat}`; return userScopes.some(s => s === needed || s === `pc:${toolName}`); }

app.get("/health", (req, res) => { res.json({ status: "ok", uptime: Math.floor(process.uptime()) }); });

function getCode(req) {
  if (req.params && req.params.code) return req.params.code;
  if (req.query && req.query.code) return req.query.code;
  if (req.body && req.body.code) return req.body.code;
  const pathMatch = (req.path || "").match(/^\/mcp\/([^\/?#]+)/);
  if (pathMatch && pathMatch[1]) return pathMatch[1];
  const headerCode = req.headers["x-mcp-code"] || req.headers["x-client-code"];
  if (headerCode) return String(headerCode);
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) { const t = auth.slice(7).trim(); if (tokens[t] && tokens[t].code) return tokens[t].code; const owner = findKeyOwner(t); if (owner) return owner.code; }
  if (clients.size > 0) return Array.from(clients.keys())[0];
  const roomKeys = Object.keys(rooms);
  if (roomKeys.length > 0) return roomKeys[0];
  return "default-pc";
}

function findKeyOwner(token) {
  if (!token) return null;
  for (const [code, room] of Object.entries(rooms)) {
    if (!room || !Array.isArray(room.keys)) continue;
    for (const k of room.keys) {
      if (k && k.salt && k.hash && verifyKey(token, k.salt, k.hash)) return { code, scopes: Array.isArray(k.scopes) ? k.scopes : FULL_SCOPES.slice() };
    }
  }
  return null;
}

function requireAuth(req, res, next) {
  const p = req.path;
  if (p === "/health" || p === "/" || p === "/openapi.json" || p.startsWith("/admin/") || p.startsWith("/oauth/") || req.method === "OPTIONS") return next();
  const auth = req.headers["authorization"] || "";
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "unauthorized" });
  const token = auth.slice(7).trim();
  const code = getCode(req);
  if (!code) return res.status(400).json({ error: "no_room" });
  const room = rooms[code];
  if (room && Array.isArray(room.keys)) {
    for (const k of room.keys) {
      if (k && k.salt && k.hash && verifyKey(token, k.salt, k.hash)) { req.principal = { scopes: k.scopes }; return next(); }
    }
  }
  if (!room) return res.status(404).json({ error: "room_not_found" });
  return res.status(403).json({ error: "forbidden" });
}

app.use("/mcp", requireAuth);
app.use("/api", requireAuth);
app.post("/mcp/:code", (req, res) => { const code = getCode(req); if (!code) return res.status(400).json({ error: "no_code" }); return forwardToPC(code, req, res); });
app.post("/mcp/:code/*", (req, res) => { const code = getCode(req); if (!code) return res.status(400).json({ error: "no_code" }); return forwardToPC(code, req, res); });

function forwardToPC(code, req, res, extra = {}) {
  const client = clients.get(code);
  if (!client || client.readyState !== 1) {
    return res.status(502).json({ error: "pc_offline", error_description: `PC '${code}' is not connected.` });
  }
  const sessionId = codeSession.get(code) || "";
  const requestId = randomToken(12);
  const headers = { ...req.headers, "x-forwarded-proto": req.headers["x-forwarded-proto"] || req.protocol || "https" };
  delete headers["host"];
  const body = req.body || {};
  const payload = { method: req.method, path: req.path, headers, body, ...extra };
  pendingReqs.set(requestId, { res, code, timer: setTimeout(() => { pendingReqs.delete(requestId); if (!res.headersSent) res.status(504).json({ error: "timeout" }); }, REQUEST_TIMEOUT) });
  try {
    client.send(JSON.stringify({ type: "request", requestId, sessionId, payload }));
  } catch (e) {
    pendingReqs.delete(requestId);
    if (!res.headersSent) res.status(502).json({ error: "forward_failed" });
  }
}

// WebSocket upgrade
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");
  const code = url.searchParams.get("code");
  if (!code) { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.on("ping", () => { try { ws.pong(); } catch {} });
    const pingInterval = setInterval(() => { if (ws.readyState === 1) { try { ws.ping(); } catch {} } else { clearInterval(pingInterval); } }, 15000);
    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === "init") {
          const targetCode = data.code || code || "default-pc";
          const cleanKey = (data.apiKey || "").trim();
          const existingRoom = rooms[targetCode];
          const existingKeys = existingRoom && Array.isArray(existingRoom.keys) ? existingRoom.keys : [];
          const hasOwnerKey = existingKeys.some(k => k.label === "owner" && k.salt && k.hash);
          if (hasOwnerKey) {
            const ownerMatch = cleanKey && existingKeys.some(k => k.label === "owner" && k.salt && k.hash && verifyKey(cleanKey, k.salt, k.hash));
            if (!ownerMatch) { console.log(`[relay] REJECTED init/takeover of '${targetCode}' (bad key)`); try { ws.send(JSON.stringify({ type: "error", code: "ROOM_CONFLICT", message: "Invalid API key for room. Unauthorized takeover attempt blocked." })); } catch {} return; }
          } else {
            if (!rooms[targetCode]) { rooms[targetCode] = { keys: [] }; }
            if (cleanKey) { const { salt, hash } = hashKey(cleanKey); rooms[targetCode].keys = rooms[targetCode].keys.filter(k => k.label !== "owner"); rooms[targetCode].keys.push({ id: "owner", label: "owner", scopes: FULL_SCOPES.slice(), salt, hash, createdAt: Date.now() }); saveState(); }
          }
          const existingClient = clients.get(targetCode);
          if (existingClient && existingClient !== ws && existingClient.readyState === 1) { try { existingClient.close(); } catch {} }
          clients.set(targetCode, ws);
          ws.roomCode = targetCode;
          if (data.userKeys && Array.isArray(data.userKeys)) { const room = rooms[targetCode]; if (room) { data.userKeys.forEach(uk => { if (uk && uk.api_key && !room.keys.some(k => k.id === uk.id)) { const { salt, hash } = hashKey(uk.api_key); room.keys.push({ id: uk.id, label: uk.label || uk.id, scopes: Array.isArray(uk.scopes) ? normalizeScopes(uk.scopes) : FULL_SCOPES.slice(), salt, hash, createdAt: Date.now() }); } }); saveState(); } }
          console.log(`[relay] PC '${targetCode}' connected.`);
          ws.send(JSON.stringify({ type: "connected", code: targetCode }));
          return;
        }
        if (data.type === "response" || data.type === "sseChunk" || data.type === "sseClose") {
          const pending = pendingReqs.get(data.requestId);
          if (data.type === "response" && pending) { clearTimeout(pending.timer); if (!pending.res.headersSent) { let parsed = data.payload; const ct = data.contentType || "application/json"; try { if (typeof parsed === "string") parsed = JSON.parse(parsed); } catch {} pending.res.json(parsed); } pendingReqs.delete(data.requestId); }
          if (data.type === "sseChunk" && pending) { const sessionId = data.sessionId; let sseRes = sseStreams.get(sessionId); if (sseRes) { try { sseRes.write(data.payload); } catch { sseStreams.delete(sessionId); } } else { if (!sseEventBuf.has(sessionId)) sseEventBuf.set(sessionId, []); sseEventBuf.get(sessionId).push(data.payload); } }
          if (data.type === "sseClose" && pending) { clearTimeout(pending.timer); const sessionId = data.sessionId; const sseRes = sseStreams.get(sessionId); if (sseRes) { try { sseRes.end(); } catch {} sseStreams.delete(sessionId); } else { pending.res.end(); } sseEventBuf.delete(sessionId); pendingReqs.delete(data.requestId); }
          return;
        }
      } catch (err) { console.error("[relay] WS message error:", err.message); }
    });
    ws.on("close", () => { clearInterval(pingInterval); if (ws.roomCode) { console.log(`[relay] PC '${ws.roomCode}' disconnected.`); const current = clients.get(ws.roomCode); if (current === ws) clients.delete(ws.roomCode); } });
    ws.on("error", () => {});
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[relay] Relay server on port ${PORT}`);
  console.log(`[relay] PC clients connect via: wss://host:${PORT}/?code=<name>`);
  console.log(`[relay] AI clients connect via: https://host/mcp/<name>`);
});
process.on("SIGINT", () => { for (const [, ws] of clients) { try { ws.close(); } catch {} } server.close(() => process.exit(0)); });
RELAYSRV

  # keys.js (minimal — functions duplicated above in server.js)
  cat > "$INSTALL_DIR/relay/keys.js" <<'KEYSJS'
module.exports = { hashKey: require('crypto'), verifyKey: () => false, normalizeScopes: () => [], newKeyBytes: () => [], FULL_SCOPES: [] };
KEYSJS

  cat > "$INSTALL_DIR/relay/scopes.js" <<'SCOPESJS'
module.exports = { toolScopeOf: () => "", hasScope: () => true };
SCOPESJS
fi

if [ "$DOMAIN_TYPE" = "2" ]; then
  PROTO="http"
else
  PROTO="https"
fi

# ── Start relay ────────────────────────────────────────────────────────────────
cd "$INSTALL_DIR"
docker compose up -d --build
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  Relay deployed and running.                                   ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "  Domain:        ${PROTO}://$DOMAIN"
echo "  Device name:   $DEVICE_NAME"
echo "  API key:       $API_KEY"
echo ""
echo "  MCP URL:        ${PROTO}://$DOMAIN/mcp/$DEVICE_NAME"
echo ""
echo "  On your Windows PC, set these in the desktop app (Settings tab):"
echo "    relay_url =  ${PROTO}://$DOMAIN"
echo "    name      =  $DEVICE_NAME"
echo "    api_key   =  $API_KEY"
echo ""
