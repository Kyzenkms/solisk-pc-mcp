# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [1.0.0] — 2026-09-05

### Added
- Desktop app with onboarding wizard (hosted relay or local-only modes).
- 96 MCP tools: filesystem, shell/PowerShell, UI automation, screen + OCR,
  process management, network diagnostics, git, system info, memory, clipboard.
- Cloud relay (`mcp.solisk.org`) with room isolation, scrypt-hashed keys,
  scoped per-user keys, and admin API.
- OAuth 2.1 + PKCE (S256) flow for ChatGPT / Claude.ai connectors.
- Approval modes: `Ask` (confirm each tool call) and `Turbo` (auto-approve).
- Cloudflare quick-tunnel fallback when the hosted relay is unreachable.
- Persistent main-process log (`main.log`) for diagnostics.
- Self-hosting: 4 access modes (own domain + Caddy HTTPS, free quick tunnel,
  Cloudflare named tunnel, sslip.io) via `self-hosted-setup/vps/install.sh`.
- Local relay mode on Windows via `self-hosted-setup/local/start.ps1`.
- Static website: landing, docs, security, privacy, terms.

### Fixed
- Desktop startup race: `dom-ready` handlers registered before `loadFile`.
- Relay reconnection: bounded retries with exponential backoff, manual retry
  button, and internet-offline detection.
- Secure MCP URL regeneration: old room revoked before new identity is saved;
  failed revocation restores the previous running configuration.
- VPS relay outage handling: explicit `relayError` state surfaced in the UI.

### Security
- TLS certificate verification enforced for relay WebSocket and admin API.
- Content-Security-Policy added to the Electron renderer.
- Relay room deletion requires the global admin token or the matching owner key.
- OAuth: open-redirect fix, dynamic client caps, auth-code IP binding.
- CORS allowlist, rate limiting, AES-256 token encryption at rest on relay.

## [1.0.0-beta] — 2026-08-18

- Initial public beta.
