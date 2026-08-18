version: "1.0.0-beta"
date: "2026-08-18"

## 1.0.0-beta — Initial public beta release

### Features
- Desktop GUI with first-run onboarding wizard
- Three connection modes: local-only, hosted relay, or self-hosted relay
- 40+ MCP tools: files, system, keyboard, mouse, screen, audio, camera, processes
- Credentials (API key, OAuth client ID/secret, device name) generated locally on
  first run — no account, no sign-up, no telemetry
- Scoped API keys with tickable permission categories
- Master key + multiple scoped keys with create/revoke
- Approval mode: auto-approve or confirm each tool call
- Allowed paths whitelist (blank = full access)
- Append-only audit log of every tool execution
- System tray with autostart option
- Self-hosting via `self-hosted-setup/` (Docker + Caddy) or bare `relay-server/`

### Security
- PKCE (S256) enforced on the OAuth flow
- Relay rejects agent connections that supply no device code
- PowerShell execution sandbox with denied-path defaults
- Per-room isolation on the relay; scoped key checks before tool dispatch

### Known limitations
- Installer is unsigned (SmartScreen warning on first run)
- Windows only — no macOS or Linux desktop builds yet
- Device-name collision not yet detected on the relay
- Relay traffic is TLS-terminated at the relay, not end-to-end encrypted
- Terminal UI (`app.js`) is not feature-parity with the GUI

### Upcoming
- [ ] Signed installer
- [ ] macOS and Linux desktop builds
- [ ] End-to-end encryption for relay traffic
- [ ] Device-name uniqueness check
