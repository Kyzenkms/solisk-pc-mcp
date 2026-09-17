version: "1.0.0"
date: "2026-09-05"

## 1.0.0 — First stable release

### Features
- Desktop app with first-run onboarding wizard
- Connection modes: hosted relay (`mcp.solisk.org`), local-only, or self-hosted
  relay (4 access modes, including Cloudflare tunnels with no open ports)
- 96 MCP tools: files, shell/PowerShell, keyboard, mouse, screen + OCR,
  audio, camera, processes, network, git, system info, memory, clipboard
- Credentials generated locally on first run — no account, no sign-up, no
  telemetry
- Scoped per-user API keys with create/revoke via the relay admin API
- Approval modes: `Ask` (confirm each tool call) or `Turbo` (auto-approve)
- Allowed-paths whitelist (blank = full filesystem access)
- Append-only audit log of every tool execution
- Cloudflare quick-tunnel fallback when the hosted relay is unreachable
- System tray with autostart option
- Persistent diagnostic log: `%APPDATA%\pc-control-mcp-desktop\main.log`

### Security
- OAuth 2.1 with mandatory PKCE (S256) for ChatGPT / Claude.ai connectors
- TLS certificate verification enforced for all relay connections
- Content-Security-Policy on the Electron renderer
- PowerShell execution sandbox with denied-path defaults
- Per-room isolation on the relay; scoped key checks before tool dispatch
- Secure MCP URL regeneration: old room revoked before new identity is saved
- Relay room deletion restricted to global admin token or matching owner key

### Fixed since beta
- Desktop startup race: runtime now starts reliably on packaged builds
- Bounded relay reconnection with exponential backoff + manual retry button
- Internet-offline detection pauses reconnection instead of burning retries
- Explicit relay error state surfaced in the UI

### Known limitations
- Installer is unsigned (SmartScreen warning on first run)
- Windows only — no macOS or Linux desktop builds yet
- Relay traffic is TLS-terminated at the relay, not end-to-end encrypted
- Terminal UI (`app.js`) is not feature-parity with the GUI

### Upcoming
- [ ] Signed installer (EV certificate)
- [ ] End-to-end encryption for relay traffic
- [ ] macOS and Linux desktop builds
- [ ] Device-name uniqueness check on the relay
