# PC Control MCP — Desktop App

Electron-based GUI for PC Control MCP.

## Install

Download from [Releases](https://github.com/Kyzenkms/solisk-pc-mcp/releases).
Run `PC Control MCP Setup 1.0.0-beta.exe`.

## First run

The onboarding wizard guides you through:

1.  **Mode**: hosted beta (Cloudflare relay) or local-only
2.  **Device name**: used in your MCP URL
3.  **Approval**: auto-approve or confirm each call
4.  **Allowed paths**: restrict file access (blank = full filesystem)
5.  **API key**: generated automatically

Existing users skip onboarding.

## Development

```bash
npm install
npm run dev            # hot-reload Electron
npm run build          # production build + signed installer
npm run build:unsigned-beta  # unsigned installer for testing
```

## Configuration

Stored in `%APPDATA%/pc-control-mcp-desktop/config.json`:

- `ready`: `true` after onboarding completes
- `relayUrl`: your MCP endpoint
- `apiKey`: master API key
- `deviceName`: your PC name
- `approveMode`: `"auto"` or `"confirm"`
- `allowedPaths`: array of allowed directories
- `scopedKeys`: array of scoped API keys

## Files

| File | Purpose |
| ---- | ------- |
| `main.js` | Electron main process, tray, autostart |
| `preload.js` | Context bridge for IPC |
| `renderer/index.html` | Onboarding, dashboard, settings UI |
| `renderer/app.js` | UI logic, key management, scopes |
| `assets/` | Icons and branding |

## Installer build

```bash
npm run build:unsigned-beta
```

Produces:

- `dist/win-unpacked/PC Control MCP.exe` (portable)
- `dist/PC Control MCP Setup 1.0.0-beta.exe` (NSIS installer)

The installer is **unsigned** — Windows SmartScreen may warn. Click "More info
→ Run anyway" to proceed.
