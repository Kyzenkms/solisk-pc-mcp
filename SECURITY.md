# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.0-beta | ✅ |

## Authentication

- **API keys**: Bearer token in `Authorization` header or `x-api-key` header.
- **OAuth**: GitHub OAuth flow for relay server management.
- **Scoped keys**: Each key carries a permission bitmap. Empty scopes = full access.
- **Local-only mode**: No relay, no internet required. API runs on
  `localhost:3000`.

## Encryption

- **Relay** uses Cloudflare Tunnel (TLS) between client and VPS.
- **Local** traffic is plain HTTP on `localhost` (loopback, not exposed).
- **No end-to-end encryption** between AI client and relay server yet (roadmap).

## Data storage

- Config: `%APPDATA%/pc-control-mcp-desktop/config.json`
- OAuth tokens: `%APPDATA%/pc-control-mcp-desktop/oauth_tokens.json`
- **Never commit** `config.json`, `oauth_tokens.json`, or `rooms.json` to git.
- These files are in `.gitignore`.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/Kyzenkms/solisk-mcp/security/advisories/new)
or email **kyzenkms@duck.com**.

Do **not** file a public issue for security-critical bugs.

Disclosures will be acknowledged within 72 hours. Fixes are prioritized based on
severity.

## Responsible use

- Only grant PC Control access to AI clients you trust.
- Scoped API keys limit blast radius — use the minimum scope needed.
- Approval mode adds a confirmation prompt before every tool execution.
- Allowed paths prevent file access outside designated directories.
