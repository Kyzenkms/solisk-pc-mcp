# pc-control-headless

Headless CLI build of PC Control MCP for servers and VPS deploys.
No Electron, no GUI, no desktop app. Same protocol, same auth, same audit log.

The desktop/GUI build is untouched — this folder only **reuses** its
audited libs (`lib/`) and portable tools (`tools/`) read-only.

## Quickstart (VPS, systemd)

```bash
git clone <repo> && cd <repo>
sudo bash pc-control-headless/deploy/install.sh
# prints the owner api_key ONCE — store it now
```

MCP endpoint: `http://127.0.0.1:3000/mcp` (localhost-only).
Expose publicly via SSH tunnel or a TLS reverse proxy (Caddy/nginx),
never by binding 0.0.0.0 directly.

## Quickstart (Docker)

```bash
docker compose -f pc-control-headless/docker-compose.yml up -d --build
docker exec pc-control-headless node bin/pc-control.js --setup  # prints key once
```

## Local use

```bash
cd pc-control-headless && npm install --omit=dev --ignore-scripts
node bin/pc-control.js --setup                       # generate key
node bin/pc-control.js --mode=http --host 127.0.0.1  # serve
node bin/pc-control.js --mode=stdio                  # Claude Desktop / Cursor / Cline
node bin/pc-control.js --list-tools                  # active vs disabled matrix
node bin/pc-control.js --status                      # probe server (exit 0 = up)
node bin/pc-control.js --mode=http --tailscale       # tailnet HTTPS via tailscale serve
```

Claude Desktop / Cursor stdio entry:

```json
{ "mcpServers": { "pc-control": {
  "command": "node",
  "args": ["/opt/pc-control-headless/pc-control-headless/bin/pc-control.js", "--mode=stdio"],
  "env": { "MCP_CONFIG_PATH": "/etc/pc-control/config.json" }
} } }
```

## Tool matrix (Linux)

Active (46): all of `filesystem` (20), `memory` (6), `utility` (6),
`network` (3: http_get, http_post, web_search), `git` (10),
plus `shell_exec` (POSIX shell, this build only).

Disabled with reason `windows-only` (52): `shell` (PowerShell),
`system`, `system_advanced`, `input`, `notification`,
`network_advanced`, `server` (cloudflared tunnel). They stay registered
in the desktop build. `--list-tools` prints the full matrix at runtime.

## Approval model

No interactive approval exists on a headless server, so:

- `approval_mode=always` (default) / `intermediate`: read-only shell
  commands run; **everything mutating is refused** with a clear error.
- `approval_mode=turbo`: mutating commands run. Set only if you accept
  that any authenticated client has full shell on the box.

Filesystem writes additionally respect `allowed_paths` / `denied_paths`.

## Hardening for untrusted clients (read AUDIT.md first)

- Issue **scoped keys** (`user_keys` with explicit `scopes`), never the
  owner key. Withhold the `git` scope if callers are untrusted (flag
  injection, see AUDIT.md H-1). Withhold `network` scope or egress-filter
  the host if SSRF matters (see AUDIT.md H-2, incl. 169.254.169.254).
- Set `allowed_paths` to the working tree; keep `denied_paths` for keys,
  tokens, and the config dir.
- Keep `NODE_ENV=production` (all deploy paths set it) so error responses
  never carry stacks.
- Terminate TLS at a reverse proxy; never publish the node port directly.

## Runtime console

`GET /dashboard` (Bearer) serves a read-only console: status, tool
inventory with scopes (`GET /tools`), session count, audit-log tail
(`GET /logs?lines=N`, capped 200, 1MB read cap, lines truncated to 500).
Key entry is a password field kept in tab session storage, never in URLs.
The desktop runtime serves the identical bundle, so the GUI is remotely
viewable without changing the app: `tailscale serve http://127.0.0.1:3000`.

## Files

| File | Purpose |
|---|---|
| `bin/pc-control.js` | CLI entry (args, config bootstrap, perms) |
| `server.js` | StreamableHTTP server, explicit host bind |
| `stdio.js` | stdio transport for local clients |
| `tools.js` | Windows-only disable list + extra registration |
| `tools/shell_linux.js` | `shell_exec` POSIX tool (default-deny policy) |
| `web/` | runtime console bundle (`/dashboard`: status, tools, logs) |
| `deploy/install.sh` | Ubuntu/Debian VPS installer |
| `deploy/pc-control.service` | hardened systemd unit |
| `Dockerfile` / `docker-compose.yml` | container deploy |
| `config.example.json` | config template |
| `AUDIT.md` | end-to-end security audit report |
