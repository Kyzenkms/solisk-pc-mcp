#!/bin/bash
# ============================================================
#  PC Control MCP — Persistent Room VPS Relay
#  Run this on your VPS to deploy the Persistent Relay
#  Deploys the CURRENT relay-server/ directory (secure version).
# ============================================================

set -e

RELAY_DIR="/opt/pc-control-relay"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$RELAY_DIR"
cd "$RELAY_DIR"

echo "==> Stopping old relay process..."
pm2 stop relay 2>/dev/null || pkill -f "server.js" 2>/dev/null || true

echo "==> Copying secure relay files..."
cp "$SRC_DIR/server.js" "$RELAY_DIR/server.js"
cp "$SRC_DIR/keys.js"   "$RELAY_DIR/keys.js"
cp "$SRC_DIR/scopes.js" "$RELAY_DIR/scopes.js"

echo "==> Installing dependencies..."
npm install express ws 2>/dev/null || true

echo "==> Starting relay with PM2..."
if ! command -v pm2 &> /dev/null; then
    echo "PM2 not found. Installing..."
    npm install -g pm2
fi

pm2 start server.js --name relay --watch --ignore-watch "rooms.json oauth_tokens.json"
pm2 save

echo "==> Deploy complete!"
echo "    Set RELAY_ADMIN_TOKEN in your environment before first use."
echo "    Create rooms & per-user keys via:"
echo "      curl -X POST $HOST/admin/rooms -H 'Authorization: Bearer \$RELAY_ADMIN_TOKEN' -d '{\"code\":\"myroom\"}'"
echo "      curl -X POST $HOST/admin/keys  -H 'Authorization: Bearer \$RELAY_ADMIN_TOKEN' -d '{\"code\":\"myroom\",\"label\":\"alice\",\"scopes\":\"pc:file:read\"}'"
