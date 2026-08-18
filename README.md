# PC Control MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Beta](https://img.shields.io/badge/status-beta-orange)]()

Turn your PC into an AI-controllable machine via MCP (Model Context Protocol). Grant
Claude, ChatGPT, or any MCP client read/write/execute access to your computer —
files, processes, screen, audio, camera, keyboard, and mouse.

> **Read this first.** This app can run shell commands, modify files, and capture
> your screen, microphone, and camera. Anyone holding your API key can do the same
> remotely. Start with **Confirm each call** approval mode and a restricted
> **allowed paths** list. See [SECURITY.md](SECURITY.md).

---

## Requirements

| | |
| --- | --- |
| **OS** | Windows 10 or 11 (64-bit) |
| **Disk** | ~250 MB |
| **Node.js** | Not required — bundled in the installer |
| **Account** | None. No sign-up, no telemetry. |

macOS and Linux builds are not available yet.

---

## Install (5 minutes)

### Step 1 — Download

Get `PC Control MCP Setup 1.0.0-beta.exe` from
[**Releases**](https://github.com/Kyzenkms/solisk-mcp/releases/latest).

### Step 2 — Run the installer

The build is **unsigned**, so Windows shows a SmartScreen warning. To continue:

> **More info** → **Run anyway**

Prefer to verify before trusting it? Build from source instead — see
[Development](#development).

### Step 3 — Pick how AI reaches your PC

The app opens a setup wizard on first launch. Choose one connection mode:

| Mode | Your MCP URL | Best for |
| ---- | ------------ | -------- |
| **Local only** | `http://localhost:3000/mcp` | Claude Desktop, Cursor, Cline — anything on this same PC. Nothing leaves your machine. |
| **Hosted relay** | `https://mcp.solisk.org/mcp/<your-name>` | ChatGPT and Claude.ai in the browser, which need a public HTTPS URL. Traffic passes through our relay. |
| **Self-hosted relay** | `https://your-domain/mcp/<your-name>` | Public URL, your own server. See [Self-hosting](#self-hosting). |

Pick **Local only** if you are unsure — you can switch in Settings later.

### Step 4 — Finish the wizard

1. **Device name** — becomes part of your URL (e.g. `john-pc`).
2. **Approval mode** — `Confirm each call` (recommended) or `Auto-approve`.
3. **Allowed paths** — one folder per line. **Leave blank to allow your whole
   filesystem.** Start narrow, e.g.:
   ```
   C:\Users\you\Projects
   C:\Users\you\Documents
   ```

Your API key, OAuth client ID, and client secret are **generated locally** on this
step. Nothing is uploaded. They are stored in:

```
%APPDATA%\PC Control MCP\config.json
```

### Step 5 — Copy your key and URL

Open **Settings → API & Keys**, then **Copy MCP URL** and **Copy API key**.

---

## Connect your AI client

### Claude Desktop / Cursor / Cline

Edit `claude_desktop_config.json`
(`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pc-control": {
      "type": "url",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

Restart Claude Desktop. A hammer icon appears when the tools load.

### ChatGPT / Claude.ai (browser)

These require a public HTTPS URL, so use **Hosted relay** or **Self-hosted**.
Add the MCP URL as a connector and set the `Authorization: Bearer YOUR_API_KEY`
header.

### Verify it works

Ask your AI client: *"List the files in my Documents folder."* In `Confirm each
call` mode an approval dialog appears — approve it. If the listing comes back,
you are connected.

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| SmartScreen blocks install | **More info** → **Run anyway**. The beta is unsigned. |
| Client shows no tools | Confirm the server is running (tray icon green), then fully restart the client. |
| `401 Unauthorized` | API key mismatch. Re-copy from **Settings → API & Keys**; check the `Bearer ` prefix. |
| Hosted relay offline | The app falls back to a Cloudflare tunnel URL — use **Copy MCP URL** again. |
| `Access denied` on a file | Path is outside **allowed paths**. Add its folder in Settings. |
| Port 3000 in use | Change the port in **Settings**, then update your client URL. |
| Nothing works, want a clean slate | Quit the app, delete `%APPDATA%\PC Control MCP\config.json`, relaunch to redo the wizard. **This regenerates your API key** — update your clients. |

Logs: `%APPDATA%\PC Control MCP\main.log` and the **Activity** tab.

---

## Features

| Category     | Tools                              |
| ------------ | ---------------------------------- |
| **Files**    | read, write, search, list, glob    |
| **System**   | execute commands, get system info  |
| **Keyboard** | type, hotkey, write clipboard      |
| **Mouse**    | move, click, drag, scroll, position|
| **Screen**   | screenshot (full/region)           |
| **Audio**    | record microphone                  |
| **Camera**   | capture photo/video                |
| **Processes**| list, kill                         |
| **AI**       | ask AI client inline               |

Each API key can be **scoped** to specific tool categories, so a key may be
granted read-only file access without shell or camera rights.

---

## Self-hosting

Run your own relay so no traffic touches our infrastructure. You need a VPS and
a domain A-record pointing at it.

**VPS (Docker + Caddy, automatic HTTPS):**

```bash
ssh root@YOUR_VPS
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kyzenkms/solisk-mcp/master/self-hosted-setup/vps/install.sh)"
```

**Bare Node.js instead of Docker:**

```bash
git clone https://github.com/Kyzenkms/solisk-mcp.git
cd pc-control-mcp/relay-server
npm install
node server.js
```

Put Nginx in front using [`deploy/relay.example.nginx`](deploy/relay.example.nginx)
(replace `YOUR_DOMAIN`). Then in the desktop app, set **Settings → Relay domain**
to your domain.

Details: [`self-hosted-setup/README.md`](self-hosted-setup/README.md) ·
[`relay-server/README.md`](relay-server/README.md)

---

## Running the server without the GUI

The MCP server is plain Node.js and runs headless:

```bash
git clone https://github.com/Kyzenkms/solisk-mcp.git
cd pc-control-mcp
npm install
cp config.example.json config.json   # optional; keys self-generate if absent
npm run http                         # or: npm run stdio
```

Missing credentials are generated on first start and written back to
`config.json` ([`lib/security.js`](lib/security.js)).

---

## Documentation

| Resource | Description |
| -------- | ----------- |
| [Desktop app](desktop-app/README.md) | GUI setup, install, tray, config |
| [Relay server](relay-server/README.md) | Relay architecture and endpoints |
| [Self-hosting](self-hosted-setup/README.md) | Run your own relay (VPS or local) |
| [API scopes](relay-server/scopes.js) | Tool-to-scope enforcement mapping |
| [SECURITY](SECURITY.md) | Auth model, hardening, disclosure |
| [CONTRIBUTING](CONTRIBUTING.md) | Dev setup and PR guidelines |
| [RELEASE_NOTES](RELEASE_NOTES.md) | Changelog |

---

## Development

```bash
git clone https://github.com/Kyzenkms/solisk-mcp.git
cd pc-control-mcp
npm install

cd desktop-app
npm install
npm run dev                  # run the GUI from source
npm run build:unsigned-beta  # build an unsigned installer
```

Installers land in `desktop-app/dist/`. CI builds the same artifact on any `v*`
tag — see [`.github/workflows/build.yml`](.github/workflows/build.yml).

---

## License

MIT — see [LICENSE](LICENSE).

---

## Security

Report vulnerabilities privately per [SECURITY.md](SECURITY.md). Please do not
open public issues for exploitable bugs.
