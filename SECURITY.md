# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅ |

## Authentication

- **API keys**: Bearer token in the `Authorization` header (or `x-api-key`).
  Keys are scrypt-hashed with unique salts on the relay; plaintext keys are
  never stored server-side.
- **OAuth 2.1 + PKCE (S256)**: MCP clients (ChatGPT, Claude.ai) authorize via
  dynamic client registration and exact redirect-URI matching. Plain `code`
  exchange is rejected.
- **Scoped keys**: each key carries a scope list. Empty scopes = full access;
  `pc:admin` = full access; otherwise category-scoped (`pc:file:read`,
  `pc:shell`, …).
- **Local-only mode**: no relay, no internet required. API binds to
  `localhost:3000`.

## Transport

- **Hosted / self-hosted relay**: TLS terminates at the relay (HTTPS + WSS).
  TLS certificate verification is enforced in the desktop client.
- **Local**: plain HTTP on `localhost` loopback only, never exposed.
- **No end-to-end encryption** between AI client and your PC yet (roadmap:
  payload encryption inside the relay tunnel).

## Attack-surface hardening

- Path sandboxing: `System32` / `SysWOW64` denied by default; optional
  allowed-paths whitelist.
- Command blocklist for shell tools.
- Rate limiting per IP on the relay.
- CORS origin allowlist (Claude, ChatGPT, Cursor, localhost).
- Append-only audit log of every tool execution.

## Data storage

- Config: `%APPDATA%\pc-control-mcp-desktop\config.json`
- OAuth tokens: `%APPDATA%\pc-control-mcp-desktop\oauth_tokens.json`
- **Never commit** `config.json`, `oauth_tokens.json`, or `rooms.json` to git.
  They are in `.gitignore`.

## Reporting a vulnerability

Open a
[private security advisory](https://github.com/kyzenkms/pc-control-mcp/security/advisories/new)
or email **kyzenkms@duck.com**.

Do **not** file a public issue for security-critical bugs.

Disclosures will be acknowledged within 72 hours. Fixes are prioritized by
severity.

## Responsible use

- Only grant PC Control access to AI clients you trust.
- Use scoped API keys with the minimum scope needed.
- Keep approval mode (`Ask`) enabled for state-changing operations.
- Configure allowed paths to restrict file access to designated directories.
