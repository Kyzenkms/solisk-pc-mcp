# Self-Hosted Setup

This folder contains everything needed to run the relay **on your own infrastructure** — either a VPS in the cloud or the same Windows machine.

---

## Path A — VPS relay (permanent public URL)

The relay runs inside Docker on a Linux VPS. Caddy handles HTTPS automatically.

**Supported VPS operating systems**

The installer is one Bash script and detects the operating system automatically. It supports current:

- Debian and Ubuntu, including compatible derivatives such as Linux Mint.
- Fedora, RHEL, CentOS Stream, Rocky Linux, AlmaLinux, and Amazon Linux.
- Alpine Linux.
- Arch Linux and Manjaro.
- openSUSE and SUSE-family distributions.

Docker Compose v2 and a running Docker daemon are required. The installer uses the native package manager for each family, then falls back to Docker's official installer when needed. Other Linux distributions may work with Docker already installed, but are not tested. Windows, macOS, BSD, and non-Linux VPS images are not supported by `vps/install.sh`; use the local setup path or install Docker manually.

Minimal Alpine images do not include Bash. Install the script prerequisites first:

```sh
apk add --no-cache bash curl
```

**Requirements**
- A supported Linux VPS with root SSH access.
- A domain `A` record pointing to the VPS IP (e.g. `mcp.example.com → 203.0.113.10`).
- Ports 80 and 443 reachable from the internet.

**Steps**

1. SSH into the VPS:
   ```sh
   ssh root@YOUR_VPS_IP
   ```

2. Download and run the install script:
   ```sh
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kyzenkms/solisk-mcp/master/self-hosted-setup/vps/install.sh)"
   ```
   
   Or copy `vps/install.sh` to the VPS and run it:
   ```sh
   bash install.sh
   ```

   The repo is private: curl-pipe install works only with access (or set `REPO_BRANCH` for forks). From a git clone it uses local sources automatically.

3. The script prompts for a **domain type**:
   - **Option 1 — I own a domain**: Caddy provisions free HTTPS via Let's Encrypt. You need an `A` record pointing at the VPS.
   - **Option 2 — sslip.io (no domain)**: The script detects the VPS IP and generates a `YOUR-IP.sslip.io` address automatically. No HTTPS, HTTP only. Useful for testing.

4. Then it asks for:
   - **Domain** (only for option 1, e.g. `mcp.example.com`)
   - **Email** (only for option 1, for Let's Encrypt)
   - **Device name** (e.g. `home-pc`)
   - **Runtime**: `1` Docker (isolated containers, Caddy beside the relay) or `2` PM2 + Node (plain processes + log files, native Caddy for HTTPS — the same shape this project's own relays run).

5. Docker is installed (Docker runtime) or Node 22 + PM2 (PM2 runtime), the stack is written, and the relay starts.

The script does not need an existing Caddy installation. For a real domain it starts Caddy as a Docker service, writes its site configuration, and persists certificates in a Docker volume. Existing host services already using ports 80 or 443 can prevent startup.

6. When done it prints:
   ```text
   Domain:        https://mcp.example.com
   Device name:   home-pc
   API key:       <64-hex-characters>
   MCP URL:       https://mcp.example.com/mcp/home-pc
   ```

7. On the Windows PC, open the desktop app **Settings** tab and enter:
   - `relay_url` = `https://mcp.example.com`
   - `name` = `home-pc`
   - `api_key` = `<the 64-hex value>`

8. Restart the app. The relay status shows `LIVE` when connected.

**Verify**

```powershell
Invoke-RestMethod https://mcp.example.com/health
```

---

## Operating it like a grown-up

The installer gets you running. These three keep you running.

**Backups — rooms and OAuth grants live in one volume.** If the VPS dies without a copy, every AI client must re-authorize. Snapshot `relay-data` nightly (Docker):

```sh
docker run --rm -v pc-control-mcp_relay-data:/data:ro -v /root/backups:/backup alpine \
  tar -czf /backup/relay-data-$(date +%F).tar.gz -C /data .
```

PM2 runtime: the same data sits in `/opt/pc-control-mcp/data` — tar that directory instead.

```sh
docker run --rm -v pc-control-mcp_relay-data:/data:ro -v /root/backups:/backup alpine \
  tar -czf /backup/relay-data-$(date +%F).tar.gz -C /data .
```

Keep 7 days (`find /root/backups -name 'relay-data-*' -mtime +7 -delete`) and copy one off the box. Restore is the reverse tar into a fresh volume before first start.

**Firewall — 80/443 in, everything else shut.** The installer adds UFW rules when UFW exists and asks before enabling it (SSH stays allowed). No UFW on your image? Then your provider firewall (security group) must allow only 80/443 (+ SSH from your IP).

**Updates — pin and rebuild monthly.** The compose files float `node:22-alpine` and `caddy:2-alpine`. Once a month (Docker):

```sh
cd /opt/pc-control-mcp
docker compose pull && docker compose up -d --build
docker image prune -f
```

PM2 runtime: `cd /opt/pc-control-mcp && npm update --omit=dev --prefix relay && pm2 restart pc-control-relay`. Then re-copy fresh `server.js/keys.js/scopes.js/state-store.js` from a release before restarting if the relay code changed.

```sh
cd /opt/pc-control-mcp
docker compose pull && docker compose up -d --build
docker image prune -f
```

Watch the relay logs after: `docker compose logs --tail 20 relay`. If `/ready` stops returning 200, the stack won't route to it (health-gated `depends_on`).

---

## Path B — Local relay (same Windows machine)

The relay runs directly on the same Windows PC as the MCP server. No VPS, no domain, no Docker necessary.

**Requirements**
- Node.js 18+ installed.
- The MCP project dependencies installed (`npm install` in the project root).
- The relay dependencies installed (`cd relay-server && npm install`).

**Steps**

1. Open **PowerShell as administrator** and allow script execution:
   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   ```

2. Run the start script:
   ```powershell
   .\local\start.ps1
   ```

3. The script:
   - Generates a random device name and API key.
   - Starts the relay server on `127.0.0.1:3100`.
   - Starts the MCP server on `127.0.0.1:3000`.
   - Writes `%APPDATA%\pc-control-mcp-desktop\config.json` automatically.

4. The local MCP URL is:
   ```text
   http://127.0.0.1:3100/mcp/<YOUR_DEVICE>
   ```

5. Clients on the **same machine** can connect with the API key.

6. Press **Enter** to stop both servers cleanly.

**Optional parameters**

```powershell
.\local\start.ps1 -DeviceName "my-device" -ApiKey "my-key"
```

---

## Pros and cons

| Aspect | VPS relay (own domain) | VPS relay (sslip.io) | Local relay |
|---|---|---|---|---|
| Public URL | ✅ `https://your.domain/mcp/device` | ✅ `http://IP.sslip.io/mcp/device` | ❌ localhost only |
| Remote AI clients | ✅ ChatGPT, Claude.ai anywhere | ✅ ChatGPT, Claude.ai (HTTP) | ❌ same PC only |
| HTTPS | ✅ Automatic (Caddy + Let's Encrypt) | ❌ HTTP only | ❌ HTTP only |
| Domain needed | ✅ Yes, A record required | ❌ No, IP auto-detected | ❌ No |
| Setup time | 5–10 minutes | 3 minutes | 30 seconds |
| Cost | ~$5/month VPS + domain | ~$5/month VPS | Free |
| Docker required | ✅ | ✅ | ❌ |
| Port forwarding | ❌ (outbound WebSocket) | ❌ | ❌ |
