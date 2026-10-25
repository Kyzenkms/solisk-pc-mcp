# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅ |

## Authentication

- **API keys**: Bearer token in the `Authorization` header (or `x-api-key`).
  Registered API keys are scrypt-hashed with unique salts on the relay.
  The local runtime stores its own credentials in config files; see Data storage.
- **Relay OAuth + PKCE (S256)**: remote MCP clients authorize via dynamic client
  registration, redirect-URI checks and resource-bound tokens. The relay rejects
  authorization requests without S256. The local OAuth implementation is separate;
  relay regression results are not a security certification of every transport.
- **Scoped keys**: the shared tool-scope checker denies mapped tools for an empty
  or invalid scope list. Utility tools explicitly marked unrestricted remain
  available to valid keys. `*` and legacy `mcp:tools` grant full tool access;
  narrower scopes include `pc:file:read` and `pc:process:run`. Do not use
  `pc:admin` or `pc:shell` as aliases for these scopes.
- **Stdio**: trusts the local process launching the server; it does not perform
  bearer-key authentication. Only configure it in clients you trust.
- **Local-only mode**: no relay, no internet required. API binds to
  `localhost:3000`.

## Transport

- **Hosted / self-hosted relay**: TLS terminates at the relay (HTTPS + WSS).
  TLS certificate verification is enforced in the desktop client.
- **Local**: HTTP binds to loopback by default. Changing the bind address or
  enabling a relay, tunnel or Tailscale exposure changes that boundary.
- **No end-to-end encryption** between AI client and your PC. TLS terminates at
  the relay, so the relay operator can see forwarded requests and results.
  Self-hosting moves this trust to your relay host; it does not add end-to-end encryption.

## Attack-surface hardening

- File-tool path checks: denied paths and an optional allowed-paths list.
  These are not an OS sandbox around shell commands or desktop automation.
- PowerShell approval: the desktop IPC channel requests approval when required
  by the selected mode. Without that channel, commands requiring approval are
  refused, including background commands. `intermediate` can run recognized
  read-only commands; `turbo` explicitly bypasses this approval check.
- Approval is tool-specific, not a confirmation dialog before every tool call.
  POSIX shell and native desktop tools have different implementations. Granting
  shell or input access can allow actions outside file-tool path boundaries.
- Rate limiting per IP on the relay.
- CORS origin allowlist (Claude, ChatGPT, Cursor, localhost).
- Local tool audit records include arguments and rotate with size. They can
  contain sensitive text and are not tamper-proof; an owner can clear the log.

## Data storage

- Desktop config: `%APPDATA%\pc-control-mcp-desktop\config.json`.
- The CLI normally uses `~/.config/pc-control-headless/config.json`, but can
  attach using the desktop config. `--config` / `MCP_CONFIG_PATH` selects a
  different location. Local OAuth tokens and logs are stored beside the config.
- Local API keys and OAuth tokens are stored as plaintext JSON, not encrypted
  credentials. Protect these files and their backups with OS-level permissions.
  Audit arguments can include file contents, commands or secrets supplied to tools;
  review and redact logs before sharing them.
- **Never commit** `config.json`, `oauth_tokens.json`, or `rooms.json` to git.
  They are in `.gitignore`.

## Reporting a vulnerability

Open a
[private security advisory](https://github.com/Kyzenkms/solisk-pc-mcp/security/advisories/new)
or email **kyzenkms@duck.com**.

Do **not** file a public issue for security-critical bugs.

Disclosures will be acknowledged within 72 hours. Fixes are prioritized by
severity.

## Responsible use

- Only grant PC Control access to AI clients you trust.
- Use scoped API keys with the minimum scope needed.
- Keep approval mode (`Ask`) enabled for state-changing operations.
- Configure allowed paths to restrict file access to designated directories.
