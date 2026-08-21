# Solisk PC Control MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version: 1.0.0](https://img.shields.io/badge/version-1.0.0-emerald.svg)](https://github.com/Kyzenkms/solisk-mcp/releases)

Production-grade Model Context Protocol (MCP) server providing AI assistants with full, secure control over a Windows host machine. Exposes 96 system automation tools across filesystem, process execution, UI automation, system telemetry, network diagnostics, and git workflows.

Works out of the box with **Claude Desktop**, **Cursor**, **Cline**, **ChatGPT Connectors**, and **Claude.ai** browser integrations via local StreamableHTTP or encrypted cloud WebSocket tunneling.

---

## Architecture Overview

```
[ AI Assistant ]
 (Claude.ai / ChatGPT / Cursor)
       │
       ▼  OAuth 2.1 / PKCE Bearer HTTPS
┌───────────────────────────────────────────────────────────┐
│ Cloud Relay Server (mcp.solisk.org)                       │
│  - Authoritative OAuth 2.1 Authorization Gate             │
│  - SQLite WAL State Store (Rooms, Tokens, Rate Limits)     │
│  - Scrypt Hash Credential Verification                    │
└─────────────────────────────┬─────────────────────────────┘
                              │
                              ▼  Encrypted WebSocket Tunnel
┌───────────────────────────────────────────────────────────┐
│ Local Host Engine (PC Control MCP Server)                 │
│  - StreamableHTTP Engine (Port 3000)                      │
│  - Path Sandboxing & Permission Gate (Turbo/Ask modes)     │
│  - 96 Windows Automation Tool Handlers                    │
└───────────────────────────────────────────────────────────┘
```

---

## Quickstart

### Prerequisites
- **OS:** Windows 10 or Windows 11 (64-bit)
- **Node.js:** `>= 22.5.0` (bundled inside Desktop Installer)

### 1. Download & Install
Download the latest Windows installer from [Releases](https://github.com/Kyzenkms/solisk-mcp/releases):
```
PC Control MCP Setup 1.0.0.exe
```

### 2. Configuration & Approval Modes
On first launch, configure your connection settings:

- **Local Only:** Connect local AI clients directly via `http://localhost:3000/mcp`.
- **Cloud Relay:** Connect remote web AI assistants via `https://mcp.solisk.org/mcp/<your-device-code>`.
- **Permission Modes:**
  - `Ask`: Prompts for authorization before executing state-modifying or shell operations.
  - `Turbo`: Executes trusted tool invocations automatically with low latency.

Credentials (`api_key`, `oauth_client_id`, `oauth_client_secret`) are generated locally on your machine and stored at:
```
%APPDATA%\pc-control-mcp-desktop\config.json
```

---

## Client Integration

### Local Clients (Claude Desktop / Cursor / Cline)

Add the MCP server configuration to your client's config file (e.g., `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pc-control": {
      "type": "url",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_LOCAL_API_KEY"
      }
    }
  }
}
```

### Web Connectors (ChatGPT / Claude.ai)

1. Register `https://mcp.solisk.org/mcp/<your-device-code>` as an MCP Connector.
2. Complete the OAuth 2.1 authorization consent flow.
3. Authenticate with your room API key.

---

## Tool Capabilities (96 Registered Tools)

| Category | Tools | Description |
| :--- | :--- | :--- |
| **Filesystem** | `read_file`, `write_file`, `append_file`, `delete_file`, `list_dir`, `search_files`, `move_file`, `copy_file`, `file_exists`, `get_file_info` | Atomic file operations, binary reads, recursively filtered search, and metadata inspection. |
| **Shell & Execution** | `run_command`, `run_powershell`, `execute_script`, `open_program` | Asynchronous PowerShell and Command Prompt execution with stdout/stderr capture and configurable execution directory. |
| **UI Automation** | `mouse_click`, `double_click`, `right_click`, `mouse_move`, `drag_and_drop`, `type_text`, `press_hotkey`, `scroll` | Low-level synthetic keyboard input, mouse coordinates, drag-drop pipelines, and hotkey combinations. |
| **Screen & OCR** | `take_screenshot`, `qa_screenshot`, `ocr_screen` | Full-screen and region screenshot capture with optical character recognition for automated UI verification. |
| **Process Management** | `list_processes`, `get_process_info`, `kill_process` | Inspect system tasks, CPU/RAM resource usage, and terminate processes. |
| **Network Diagnostics** | `nslookup`, `ping_host`, `http_request`, `get_network_interfaces` | DNS queries, host reachability checks, HTTP request dispatch, and interface telemetry. |
| **Git Operations** | `git_status`, `git_log`, `git_diff`, `git_commit`, `git_checkout` | Native repository state inspection, commit creation, and branch management. |
| **System Info & Memory** | `get_system_info`, `get_clipboard`, `set_clipboard`, `read_memory`, `write_memory` | Complete hardware/OS telemetry, clipboard manipulation, and session state persistence. |

---

## Security Model

1. **Zero-Trust Relay Gate:** The cloud relay enforces authentication before any payload is forwarded across the WebSocket tunnel. Lacking valid credentials returns `HTTP 401 Unauthorized`.
2. **PKCE S256 OAuth Enforcement:** OAuth authorization exchanges strictly require SHA256 Code Challenges (`RFC 7636`) and exact redirect URI matching against an approved domain whitelist.
3. **RFC 8707 Resource Binding:** Access tokens and refresh tokens are cryptographically bound to canonical resource URIs, preventing cross-tenant token reuse.
4. **Scrypt Key Hashing:** API keys are hashed using `scrypt` with unique salts before storage. Plaintext keys are never stored on disk or server databases.
5. **Path Sandboxing:** File operations are restricted to user-configured allowed paths. System directories (`System32`, `SysWOW64`) are denied by default.

---

## Headless Execution (CLI / Server)

To run the MCP server in headless mode without the Electron GUI:

```bash
git clone https://github.com/Kyzenkms/solisk-mcp.git
cd pc-control-mcp
npm install

# Run HTTP StreamableHTTP server on port 3000
npm run http

# Run stdio server for CLI integrations
npm run stdio
```

---

## Self-Hosting the Cloud Relay

You can run your own cloud relay on a VPS to avoid third-party servers:

```bash
# Docker + Caddy Automated Installation
ssh root@YOUR_VPS
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kyzenkms/solisk-mcp/main/self-hosted-setup/vps/install.sh)"
```

Or execute manually using Node.js:

```bash
cd relay-server
npm install
PORT=3000 DATA_DIR=./data PUBLIC_URL=https://your-domain.com node server.js
```

See [self-hosted-setup/README.md](self-hosted-setup/README.md) and [relay-server/README.md](relay-server/README.md) for full deployment instructions.

---

## Verification & Testing

Run the automated test suites:

```bash
# Run local relay OAuth regression suite (32 assertions)
node relay-server/test/oauth.test.js

# Run live end-to-end MCP client integration test
node test-live.js
```

---

## License

[MIT](LICENSE) — Solisk PC Control MCP.
