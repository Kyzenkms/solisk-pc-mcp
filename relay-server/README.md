# PC Control MCP — Relay Server

WebSocket relay that bridges MCP clients to PC Control desktop agents. Routes
tool calls from AI clients (Claude, ChatGPT, etc.) to the correct desktop via
named rooms.

## Architecture

```
AI Client ──TLS──> Relay Server ──WSS──> PC Control Desktop
                                ↑
                      Cloudflare Tunnel (hosted)
                      or direct WS   (local/self-hosted)
```

## Quick start

```bash
npm install
cp .env.example .env   # edit API keys and secrets
node server.js
```

## Endpoints

| Path | Method | Purpose |
| ---- | ------ | ------- |
| `/health` | GET | Health check (no auth) |
| `/auth` | GET | Authenticate and get WebSocket token |
| `/ws` | WS | WebSocket relay for tool calls |
| `/oauth/github` | GET | GitHub OAuth login |
| `/oauth/callback` | GET | GitHub OAuth callback |
| `/api/keys` | GET/POST | List / create API keys |
| `/api/keys/:key` | DELETE | Revoke API key |

## Configuration

| Variable | Description |
| -------- | ----------- |
| `PORT` | Server port (default `3001`) |
| `API_KEYS` | JSON object of key → name mappings |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `SESSION_SECRET` | Express session secret |
| `TUNNEL_TOKEN` | Cloudflare tunnel token (hosted only) |

## Scopes

Each API key has a scope bitmap. Tools are checked against it before execution.
See `scopes.js` for the full mapping.

## Deployment

Run `deploy.sh` on your VPS, or see [`../deploy/`](../deploy/) for the example
Nginx reverse-proxy config. Full self-hosting walkthrough: [SELF_HOSTING.md](../SELF_HOSTING.md)
