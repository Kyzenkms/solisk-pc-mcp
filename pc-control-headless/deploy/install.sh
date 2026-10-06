#!/bin/bash
# VPS installer for pc-control-headless (Ubuntu/Debian).
# Usage: sudo bash install.sh [--dir /opt/pc-control-headless] [--user pcctl]
# Run from the REPO ROOT, or set REPO_DIR env to the checkout path.
set -euo pipefail

DIR="${1:-/opt/pc-control-headless}"
SERVICE_USER="pcctl"
REPO_DIR="${REPO_DIR:-$(pwd)}"

if [ "$(id -u)" -ne 0 ]; then echo "run as root (sudo)"; exit 1; fi
if [ ! -f "$REPO_DIR/pc-control-headless/bin/pc-control.js" ]; then
  echo "repo not found at $REPO_DIR (expected pc-control-headless/bin/pc-control.js)"; exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

id "$SERVICE_USER" >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$SERVICE_USER"

mkdir -p "$DIR" /etc/pc-control
cp -r "$REPO_DIR/lib" "$REPO_DIR/tools" "$DIR/"
mkdir -p "$DIR/relay-server" "$DIR/pc-control-headless"
cp "$REPO_DIR/relay-server/scopes.js" "$DIR/relay-server/"
cp -r "$REPO_DIR/pc-control-headless/bin" "$REPO_DIR/pc-control-headless/tools" \
    "$REPO_DIR/pc-control-headless/server.js" "$REPO_DIR/pc-control-headless/stdio.js" \
    "$REPO_DIR/pc-control-headless/tools.js" "$REPO_DIR/pc-control-headless/package.json" \
    "$REPO_DIR/pc-control-headless/README.md" "$DIR/pc-control-headless/"
cd "$DIR"
cp "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" ./ 2>/dev/null || cp "$REPO_DIR/package.json" ./
npm ci --omit=dev --no-audit --no-fund --ignore-scripts 2>/dev/null || npm install --omit=dev --no-audit --no-fund --ignore-scripts
chown -R "$SERVICE_USER:$SERVICE_USER" "$DIR" /etc/pc-control

# First run generates config + owner key (0600), prints key once.
sudo -u "$SERVICE_USER" MCP_CONFIG_PATH=/etc/pc-control/config.json NODE_ENV=production \
  node "$DIR/pc-control-headless/bin/pc-control.js" --setup

cp "$DIR/pc-control-headless/deploy/pc-control.service" /etc/systemd/system/pc-control.service
systemctl daemon-reload
systemctl enable --now pc-control
sleep 3
systemctl is-active pc-control
echo "MCP endpoint (via SSH tunnel or reverse proxy): http://127.0.0.1:3000/mcp"
