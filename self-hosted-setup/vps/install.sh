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

install_node() {
  if command -v node >/dev/null 2>&1; then
    local major=0
    major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
    if [ "$major" -ge 18 ] 2>/dev/null; then
      echo "Node $(node -v) already installed."
      return
    fi
    echo "Node too old — installing Node 22..."
  fi
  if [ ! -r /etc/os-release ]; then
    echo "ERROR: Cannot identify Linux distribution (/etc/os-release missing)." >&2; exit 1
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  local family="${ID_LIKE:-$ID}"
  set +e
  case " $family $ID " in
    *" debian "*|*" ubuntu "*|*" linuxmint "*)
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y -qq nodejs >/dev/null
      ;;
    *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*|*" amzn "*)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
      (dnf install -y nodejs 2>/dev/null || yum install -y nodejs) >/dev/null
      ;;
    *" arch "*|*" manjaro "*)
      pacman -Sy --noconfirm nodejs npm
      ;;
    *" alpine "*)
      apk add nodejs npm
      ;;
    *" suse "*|*" opensuse "*)
      zypper --non-interactive install nodejs22 npm22
      ;;
  esac
  set -e
  if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
    echo "ERROR: Node 18+ installation failed. Install Node 22 manually and rerun." >&2; exit 1
  fi
  echo "Node $(node -v) installed."
}

install_caddy_native() {
  # Native Caddy (HTTPS) for the PM2 runtime on real domains.
  if command -v caddy >/dev/null 2>&1; then
    echo "Caddy already installed."
    return
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  local family="${ID_LIKE:-$ID}"
  if echo " $family $ID " | grep -Eq " debian | ubuntu | linuxmint "; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
  else
    local arch
    case "$(uname -m)" in
      x86_64|amd64) arch="amd64" ;;
      aarch64|arm64) arch="arm64" ;;
      armv7l|armv7) arch="armv7" ;;
      *) echo "ERROR: Unsupported architecture for Caddy binary: $(uname -m)" >&2; exit 1 ;;
    esac
    local ver="2.10.0"
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${ver}/caddy_${ver}_linux_${arch}.tar.gz" -o /tmp/caddy.tgz
    tar -xzf /tmp/caddy.tgz -C /tmp caddy
    install -m 0755 /tmp/caddy /usr/local/bin/caddy
    rm -f /tmp/caddy /tmp/caddy.tgz
    id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
  fi
  command -v caddy >/dev/null 2>&1 || { echo "ERROR: Caddy installation failed." >&2; exit 1; }
  echo "Caddy installed."
}

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

echo ""
echo "Runtime: (1) Docker — isolated containers, auto HTTPS  (2) PM2 + Node — plain processes, same as this project's own relays"
read -r -p "Pick runtime [1/2]: " RUNTIME
RUNTIME="${RUNTIME:-1}"
if [ "$RUNTIME" != "1" ] && [ "$RUNTIME" != "2" ]; then
  echo "ERROR: Pick 1 (Docker) or 2 (PM2)." >&2; exit 1
fi

if [ "$RUNTIME" = "1" ]; then
  install_docker
else
  install_node
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

if [ "$RUNTIME" = "1" ]; then
# ── Docker compose files ────────────────────────────────────────────────────
if [ "$DOMAIN_TYPE" = "2" ]; then
  # sslip.io: expose relay on port 80 directly, no Caddy
  cat > "$INSTALL_DIR/docker-compose.yml" <<COMPOSEEOF
services:
  relay:
    build: ./relay
    restart: unless-stopped
    init: true
    read_only: true
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m
    ports:
      - "80:3000"
    environment:
      PORT: "3000"
      DATA_DIR: /app/data
      PUBLIC_URL: "http://\${RELAY_DOMAIN}"
      RELAY_ADMIN_TOKEN: "\${RELAY_ADMIN_TOKEN}"
    volumes:
      - relay-data:/app/data
    mem_limit: 512m
    cpus: 1.0
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3000/ready', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

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
    init: true
    read_only: true
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m
    environment:
      PORT: "3000"
      DATA_DIR: /app/data
      PUBLIC_URL: "https://\${RELAY_DOMAIN}"
      RELAY_ADMIN_TOKEN: "\${RELAY_ADMIN_TOKEN}"
    volumes:
      - relay-data:/app/data
    networks:
      - relay
    mem_limit: 512m
    cpus: 1.0
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3000/ready', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    init: true
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
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
      relay:
        condition: service_healthy

networks:
  relay:
    internal: true

volumes:
  relay-data:
  caddy-data:
  caddy-config:
COMPOSEEOF
fi
fi # end RUNTIME=docker compose files

cat > "$INSTALL_DIR/relay/Dockerfile" <<DOCKERFILE
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js keys.js scopes.js state-store.js ./

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
# Branch is overridable for forks: REPO_BRANCH=main bash install.sh
REPO_BRANCH="${REPO_BRANCH:-master}"
REPO_RAW="https://raw.githubusercontent.com/Kyzenkms/solisk-mcp/${REPO_BRANCH}/relay-server"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELAY_SRCS=""
for candidate in "$SCRIPT_DIR/relay" "$SCRIPT_DIR/../../relay-server"; do
  if [ -f "$candidate/server.js" ] && [ -f "$candidate/keys.js" ] && [ -f "$candidate/scopes.js" ] && [ -f "$candidate/state-store.js" ]; then
    RELAY_SRCS="$candidate"
    break
  fi
done
if [ -n "$RELAY_SRCS" ]; then
  echo "Using local relay sources from $RELAY_SRCS"
  cp "$RELAY_SRCS/server.js" "$RELAY_SRCS/keys.js" "$RELAY_SRCS/scopes.js" "$RELAY_SRCS/state-store.js" "$INSTALL_DIR/relay/"
else
  # Script is running via curl pipe. Fetch exact tracked relay sources instead
  # of using a stale embedded copy that could miss security fixes.
  echo "Fetching relay sources from ${REPO_RAW} ..."
  for f in server.js keys.js scopes.js state-store.js; do
    if ! curl -fsSL "$REPO_RAW/$f" -o "$INSTALL_DIR/relay/$f"; then
      echo "ERROR: Could not download $f from $REPO_RAW" >&2
      echo "The repo is private or the branch is wrong — set REPO_BRANCH or run from a git clone." >&2
      exit 1
    fi
  done
  echo "$REPO_RAW" > "$INSTALL_DIR/relay/.source"
fi

# Also drop a package.json next to the sources so the PM2 runtime can
# npm-install without Docker. (The Docker build generates its own.)
if [ ! -f "$INSTALL_DIR/relay/package.json" ]; then
  cat > "$INSTALL_DIR/relay/package.json" <<PKGJSON
{
  "name": "mcp-cloud-relay",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "express": "^4.19.2", "ws": "^8.17.0" }
}
PKGJSON
fi

if [ "$RUNTIME" = "2" ]; then
# ── PM2 runtime files ───────────────────────────────────────────────────────
# sslip (no TLS): relay binds 80 directly. Real domain: relay on 3000
# behind a native Caddy reverse proxy.
if [ "$DOMAIN_TYPE" = "2" ]; then
  PM2_PORT="80"
else
  PM2_PORT="3000"
fi
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/logs"
cat > "$INSTALL_DIR/ecosystem.config.cjs" <<ECOSYSTEM
module.exports = {
  apps: [{
    name: "pc-control-relay",
    script: "./relay/server.js",
    cwd: "$INSTALL_DIR",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_memory_restart: "512M",
    out_file: "$INSTALL_DIR/logs/relay-out.log",
    error_file: "$INSTALL_DIR/logs/relay-err.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    env: {
      NODE_ENV: "production",
      PORT: "$PM2_PORT",
      DATA_DIR: "$INSTALL_DIR/data",
      PUBLIC_URL: "$([ "$DOMAIN_TYPE" = "2" ] && echo "http://$DOMAIN" || echo "https://$DOMAIN")",
      RELAY_ADMIN_TOKEN: "$ADMIN_TOKEN"
    }
  }]
};
ECOSYSTEM
chmod 600 "$INSTALL_DIR/ecosystem.config.cjs"
fi # end RUNTIME=pm2 files

if [ "$DOMAIN_TYPE" = "2" ]; then
  PROTO="http"
else
  PROTO="https"
fi

# ── Firewall (UFW): web ports only, never lock out SSH ──────────────────────
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  if ufw status 2>/dev/null | grep -qi "inactive"; then
    echo ""
    echo "UFW is installed but inactive. Enable it now? (SSH stays allowed) [y/N]"
    read -r UFW_ANS
    if [ "$UFW_ANS" = "y" ] || [ "$UFW_ANS" = "Y" ]; then
      ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
      ufw --force enable
    else
      echo "Skipping UFW enable — ports 80/443 rules were added for when you enable it."
    fi
  fi
fi

# ── Start relay ────────────────────────────────────────────────────────────────
if [ "$RUNTIME" = "1" ]; then
  cd "$INSTALL_DIR"
  docker compose up -d --build
else
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "Installing PM2..."
    npm install -g pm2
  fi
  cd "$INSTALL_DIR/relay"
  npm install --omit=dev
  cd "$INSTALL_DIR"
  if [ "$DOMAIN_TYPE" != "2" ]; then
    install_caddy_native
    cat > /etc/caddy/Caddyfile <<CADDYEOF
{
  email $ACME_EMAIL
}

$DOMAIN {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
CADDYEOF
    if [ -d /run/systemd/system ]; then
      if ! systemctl is-active --quiet caddy 2>/dev/null; then
        systemctl enable --now caddy 2>/dev/null || caddy start --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
      else
        systemctl reload caddy 2>/dev/null || true
      fi
    else
      pkill -f "caddy run" 2>/dev/null || true
      caddy start --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
    fi
  fi
  pm2 delete pc-control-relay 2>/dev/null || true
  pm2 start "$INSTALL_DIR/ecosystem.config.cjs"
  pm2 save
  STARTUP_CMD=$(pm2 startup systemd -u root --hp /root 2>/dev/null | grep -E '^sudo ' | tail -1 || true)
  if [ -n "$STARTUP_CMD" ]; then
    eval "$STARTUP_CMD" >/dev/null 2>&1 || true
  fi
fi
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  Relay deployed and running.                                   ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "  Domain:        ${PROTO}://$DOMAIN"
echo "  Runtime:       $([ "$RUNTIME" = "1" ] && echo "Docker" || echo "PM2 + Node")"
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
