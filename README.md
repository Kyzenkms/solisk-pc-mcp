<div align="center">

<img src="desktop-app/assets/icon.png" width="96" alt="Solisk PC Control icon">

# Solisk PC Control MCP

**Give trusted AI clients secure control of your Windows PC.**

[![Version 1.0.0](https://img.shields.io/badge/version-1.0.0-emerald.svg)](https://github.com/Kyzenkms/solisk-pc-mcp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D4.svg)](#os-support)
[![MCP](https://img.shields.io/badge/MCP-streamable_http-teal.svg)](https://modelcontextprotocol.io)
[![OAuth 2.1 + PKCE](https://img.shields.io/badge/auth-OAuth_2.1_%2B_PKCE-lime.svg)](#security-model)

*Desktop control room · Headless CLI · Cloud relay · Custom domains · Tailnet*

[Download MSI](#-install) · [60-second connect](#-connect-an-ai-in-60-seconds) · [Self-host](#-self-host-the-relay) · [Security](#-security-model)

</div>

---

## What this is

One product, three faces, one runtime per machine:

| Face | What | For |
|---|---|---|
| **Control room** (Electron GUI) | Setup, endpoints, health, keys, tunnels — no terminal needed | Daily driving on Windows |
| **CLI** (`solisk` / `pc-control`) | Same core over HTTP + stdio, onboarding wizard, `doctor`, tunnels, devices | VPS, homelab, automation |
| **Web dashboard** (`/app`) | The full GUI in a browser — local or over your tailnet, key-locked, remember-this-device | Phones, tablets, second machines |

An AI connects with your **MCP URL** (`https://mcp.solisk.org/mcp/<room>` or your own domain), approves once on the consent page, and calls tools. You watch every session, toggle every path, revoke anything.

---

## 🚀 Install

**Windows** — grab **`PC Control MCP 1.0.0.msi`** from [Releases](https://github.com/Kyzenkms/solisk-pc-mcp/releases) and run it. (Classic `Setup .exe` attached to the same release. Unsigned build — SmartScreen asks once: *More info → Run anyway*.)

Headless install from the CLI afterwards also works:

```powershell
solisk gui setup --installer "C:\path\to\PC Control MCP 1.0.0.msi"
```

**From source** (contributors):

```powershell
git clone https://github.com/Kyzenkms/solisk-pc-mcp.git
cd solisk-pc-mcp\desktop-app
npm install
npm run build:unsigned-beta   # NSIS installer
node build-msi.js             # MSI (release day only — slow)
```

---

## ⚡ Connect an AI in 60 seconds

1. Open the app → **Setup** → copy your **MCP URL**.
2. In Claude.ai / ChatGPT, add an MCP connector with that URL.
3. Approve on the consent page with your room API key. Done — reconnects later need no re-auth.

> First connect ever fails? Remove the connector and re-add it — Claude caches failed discovery. The relay logs every OAuth step, so a screenshot of any error is enough to diagnose.

---

## 🖥️ OS support

| OS | GUI | CLI (`solisk`) | MCP URL clients | Tools |
|---|---|---|---|---|
| **Windows 10/11 x64** | ✅ full control room | ✅ | ✅ local + relay + tunnel | **97** native |
| **Linux** | ❌ (CLI + web dashboard) | ✅ server, stdio, tunnels, Tailscale | ✅ | 45 portable + `shell_exec` shim |
| **macOS** | ❌ (CLI + web dashboard) | ✅ server, stdio | ✅ | 45 portable + `shell_exec` shim |

Windows-only tools (mouse/keyboard hooks, screenshots, native dialogs) stay off elsewhere; everything portable stays on. The relay, tunnels, OAuth, keys, remembered devices, and update checks behave identically on all three.

---

## ✨ Highlights

- **Four paths in, four switches** — hosted relay, Cloudflare tunnel (quick or your domain), tailnet, web dashboard. Each toggles live from Setup; the dashboard toggle kills `/app` + `/dashboard` entirely (404), not just Tailnet.
- **Sessions counted honestly** — one live AI reads `1`. Idle ghosts expire, counts refresh live everywhere (GUI, CLI, API).
- **Remembered devices** — tick *Remember this device* on the console key gate; the browser skips the key for 30 days. Revoke anytime: `solisk devices list` / `solisk devices revoke <id>`.
- **No-internet mode** — the app says so plainly, keeps everything local working, and redials on its own. Errors are sentences, not stack traces.
- **Update popups** — new release? The app tells you, with notes and a download button. Skip-a-version supported.
- **CLI/GUI never fight** — one runtime per machine. The CLI attaches to a running GUI (borrowing its key transparently) and refuses to boot a second server over it.

---

## 🛠️ CLI reference

`solisk` is the short name (`pc-control` still works everywhere).

```
solisk dashboard [--no-open]      open the web console for the running server
solisk doctor [--fix]             11 health checks: ports, keys, relay, tunnel, versions
solisk config get|set|validate    ports, modes, domains (secrets refused — see rotate-key)
solisk rotate-key                 new owner key, zero-downtime relay rotation
solisk logs [--lines N]           live server log, whichever face owns it
solisk backup                     config snapshot for restores
solisk gui status|setup           detect install, install from .exe or .msi
solisk setup                      step-by-step onboarding wizard
solisk keys list|add|revoke       scoped client keys (fail-closed defaults)
solisk devices list|revoke        remembered browsers (the key-gate cookie)
solisk relay status|retry         room state, redial (reaches the GUI socket too)
solisk tunnel off|quick|custom    + login, create, route, forget, status
solisk tailscale status|serve|off funnel is a deliberate, confirmed act
```

Every attach command works with zero flags next to a running GUI — no `--config` archaeology.

---

## 🧭 Architecture

```
AI client (Claude.ai / ChatGPT / Cursor / VS Code)
   |  MCP URL + OAuth 2.1 (PKCE S256, RFC 8707 resource binding)
   v
Cloud relay  ── rooms, tokens, rate limits (scrypt-hashed keys)
   |  one outbound WebSocket per PC (room takeover protected)
   v
Your machine ── StreamableHTTP :3000 ── 97 tools, 5 sessions max
   |  + Cloudflare tunnel (quick or your domain)
   +-- tailnet serve (private dashboard) / web dashboard (/app)
```

Single source of truth per layer: one config file, one event bus, one session store. Thin faces (Electron, CLI, web shim) never own state.

---

## 🔒 Security model

1. **Bearer-only.** Every data route needs an owner key, scoped key, OAuth token, or remembered-device cookie. Page shells are public; data never is.
2. **Zero-trust relay.** The relay authenticates before forwarding a single byte. Wrong key → `401`, takeover attempts logged and blocked.
3. **PKCE + exact redirect matching + resource-bound tokens.** No cross-room token reuse, ever.
4. **Hashed at rest.** API keys are scrypt-hashed with unique salts. Device cookies store hashes, not tokens. Secrets never hit logs.
5. **Fail closed.** Unknown session? `400`, re-initialize. Offline? Local keeps working, remote redials itself. Rate limits (300/min relay, 400/min local) + 5-session cap + idle expiry.
6. **Destructive is deliberate.** Funnel, turbo mode, and URL regen all confirm first and say what happens.

Full policy: [SECURITY.md](SECURITY.md). Found something? Open a [security advisory](https://github.com/Kyzenkms/solisk-pc-mcp/security/advisories/new), not an issue.

---

## 🏠 Self-host the relay

Don't want our relay in the loop? Run yours — **Docker or PM2**, one command:

```bash
ssh root@YOUR_VPS
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kyzenkms/solisk-pc-mcp/main/self-hosted-setup/vps/install.sh)"
```

It asks domain type (yours / sslip.io testing) then runtime (Docker / PM2), and prints the room + key to paste into the app. Details, backups, firewall, and updates: [self-hosted-setup/README.md](self-hosted-setup/README.md).

---

## 🧪 Verify it

```bash
cd relay-server && node --test test/oauth.test.js   # OAuth regression suite
node test-live.js                                    # end-to-end against a running server
solisk doctor                                        # this machine, 11 checks, 0 failing is the goal
```

---

## ❓ FAQ

**SmartScreen warns on install.**
Unsigned build — *More info → Run anyway*. Signing (EV cert) is the fix; it's budgeted, not done.

**One AI shows N sessions.**
Stale IDs from reconnects — they expire after 10 idle minutes. Live count is exact at connect time.

**CLI says key refused next to a running GUI.**
It borrows the GUI key automatically and tells you. `solisk gui status` shows both fingerprints.

**Claude's first connect fails, retry works.**
Claude caches failed discovery. Remove + re-add the connector once; consent then appears directly.

**After restart it shows 0 sessions.**
Correct — sessions live in memory. The moment Claude re-initializes, the count appears. Grants and keys persist; nobody re-authenticates.

---

## License

[MIT](LICENSE) — Solisk PC Control MCP.
