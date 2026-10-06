# pc-control-headless — end-to-end security audit

Date: 2026-09-30. Auditor: automated adversarial review + live exploitation tests.
Scope: all new files in `pc-control-headless/` AND every reused shared file
reachable from its entry points (`lib/*`, `tools/{filesystem,memory,utility,network,git}`,
`relay-server/scopes.js`). Constraint: zero modifications to shared/GUI files —
shared-code findings are reported upstream with exact fixes, mitigated in-build
where possible.

Method: line-by-line review of new code; targeted review of reused auth,
sandbox, exec, and network paths; live black-box battery against a real boot
(Windows 10/11 host + WSL Ubuntu 22.04, Node 22): auth matrix, path traversal,
8-vector shell-injection battery, approval matrix, session handling, plus a
benign proof-of-concept for each HIGH.

## Verified controls (all live-tested PASS)

| Control | Evidence |
|---|---|
| Bearer required everywhere | `/health` no-key → 401, wrong key → 401, `/status` no-auth → 401, `/mcp` no-auth → 401 |
| MCP session gate | non-`initialize` first POST → 400; GET without session → 405 |
| Sessions TTL + cap | 30 min TTL, cap 5 with oldest-eviction (code + boot log) |
| Path sandbox | `allowed_paths` lock: `/etc/hosts` outside → denied; `..` escape → denied; inside → allowed |
| Approval default-deny | 7/7 injection vectors refused in `always` mode (`;`, `$()`, backticks, `\|`, `&&`, `sudo`, `curl`) |
| Read-only shell works | `echo`/`ls` execute on Linux; `sh` absent on Windows fails closed (`SPAWN_ERROR`, no crash) |
| Windows-only gating | `tools/list` = 46 (45 portable + `shell_exec`); `run_command`, `take_screenshot`, … absent (`-32602`) |
| Input validation | empty/9000-char command → `-32602` zod rejection; timeout clamped 1s–300s |
| Config secrecy | 0600 enforced + verified (POSIX warning path coded); key printed once on `--setup`, fingerprint after |
| Host bind | default `127.0.0.1`; `--host` explicit; container binds 0.0.0.0 only behind localhost-publish compose |
| Prod error responses | `NODE_ENV=production` in service, compose, Dockerfile, installer (no stacks/messages leak) |
| Supply chain | `npm ci` from lockfile, `--ignore-scripts`, cache clean; non-root image user; read-only-ish systemd unit |

## Findings

### H-1 HIGH — git flag injection → RCE (shared `tools/git.js`, proven)
`git_clone {url:"--help"}` executed `git clone --help` (live PoC, output
matched). Any `url`/`remote`/`branch`/`file` starting with `-` becomes a git
flag; `--upload-pack=<cmd>` / `-c protocol.ext.allow=always` = remote code
execution as the service user. `execFileSync` avoids shell but NOT flag
injection. Same exposure exists in the desktop build.
Upstream fix (1 line per call site): reject args starting with `-`, or insert
`--` before user values (`git(["clone", "--", url])` etc.).
In-build mitigation: withhold the `git` scope from untrusted clients
(scoped `user_keys`); README + `--list-tools` document it. Not patchable
here without touching shared code.

### H-2 HIGH — SSRF via http_get/http_post (shared `tools/network.js`)
Arbitrary caller-controlled URLs, no blocklist: cloud metadata
(`169.254.169.254`), link-local, internal hosts. Compounds with vendored
advisories below (axios/fetch redirect + fast-uri host-confusion +
ip-address misclassification families). By design the tool fetches URLs, so
this is a trust-boundary decision, not a crash bug.
Upstream fix: deny metadata/link-local/loopback ranges + redirect hop cap.
In-build mitigation: withhold `network` scope or egress-firewall the host
(documented in README). `http_get` has 10MB cap; note M-1.

### M-1 MEDIUM — http_post has no maxContentLength (shared `tools/network.js`)
`http_get` caps at 10MB; `http_post` does not — a huge response buffers to
memory (DoS). Upstream one-line fix. Cannot trigger cross-host damage beyond
the service process; rate limits bound frequency.

### M-2 MEDIUM — stdio stdout log pollution (shared `lib/middleware.js`)
`log()` writes to stdout, the same stream as JSON-RPC. Strict parsers choke;
lenient ones skip non-JSON lines (verified working with both test harnesses
and assumed OK for Claude Desktop/Cursor, same as desktop stdio).
Upstream fix: log to stderr when transport is stdio.

### M-3 MEDIUM — errorHandler leaks in non-production (shared, mitigated)
`errorHandler` returns `err.message` + `stack` unless `NODE_ENV=production`.
All headless deploy paths (service, compose, Dockerfile, installer) now force
`NODE_ENV=production`. Local `--mode` dev runs remain verbose by operator choice.

### L-1 LOW — memory file world-readable (shared `tools/memory.js`)
`~/.pc-control-mcp-memory.json` created 0644 — readable by other local users.
Mitigated by dedicated service user (`pcctl`, `ProtectHome`); upstream fix is
`mode: 0o600` on write.

### L-2 LOW — failure logs include request headers (shared `lib/security.js`)
Auth-failure log records headers (auth prefix truncated to 15 chars) + key
lengths. No full secret logged. Accept.

### L-3 LOW — non-constant-time OAuth key compare (shared `lib/oauth.js`)
`submittedKey !== config.api_key` on the authorize POST. LAN/local threat only.
Upstream: `timingSafeEqual`.

### L-4 LOW — uncaughtException only logs (shared `lib/middleware.js`)
Process continues after an uncaught exception, possibly in a corrupt state.
systemd `Restart=on-failure` does NOT catch this (exit code stays 0 path).
Upstream: exit(1) after logging and let the supervisor restart.

### I-1 INFO — X-Powered-By fingerprinting (shared)
`X-Powered-By: PC-Control-MCP-Pro` advertises the stack. Cosmetic.

### D-1..D-3 INFO — vendored dependency advisories (`npm audit`, root tree)
Not fixable here (would change shared runtime). Upstream `npm audit fix`:
- axios HIGH ×7 (prototype-pollution gadgets, ReDoS ×2, HTTP/2 proxy/DNS bypass, H2 DoS) — directly reachable via H-2 URLs.
- fast-uri HIGH ×9 (host confusion / SSRF families) — reachable via H-2 redirects.
- ip-address HIGH ×3 (octal/CIDR/NAT64 misclassification → SSRF bypass).
- qs moderate (DoS), hono moderate ×7, @hono/node-server moderate (Windows `%5C` traversal) — transitive via MCP SDK server deps, low reachability from tool inputs.

## Bugs found in new code during this audit (all fixed, re-verified)

| # | Bug | Fix |
|---|---|---|
| 1 | Wrong relative requires (`../../lib` from 1-deep files) | corrected per file depth; `--help`/`--setup`/`--list-tools` green |
| 2 | `MCP_CONFIG_PATH` set after lib require → wrong config loaded (near-miss: could have written headless settings into the desktop config) | pre-parse `--config` before any require; verified isolated fp `81c78113689c` vs repo key |
| 3 | Arg parser double-consumed space-form values (`--port 3449` ignored) | single-take parser; port/host/mode/approval verified live |
| 4 | `/metrics` + `setSessionCount` missing vs desktop parity | added |
| 5 | `NODE_ENV` unset in deploy paths | forced production in all four |
| 6 | No lockfile/`--ignore-scripts` in image | `npm ci` + flags + cache clean |

Repo config untouched throughout (verified: no `disabled_tools` key; `git status`
shows only pre-existing session modifications plus the new folder).

## Residual risk (accepted, documented)

- Turbo mode = full shell for any authenticated client. By design; key secrecy
  is the entire boundary. Never share the owner key; scope everything.
- H-1/H-2 inherited from shared code until upstream patches land; mitigations
  above reduce them to trusted-client-only exposure.
- No WAF/IDS in the box; rely on reverse proxy + host firewall for public use.

## Re-run checklist (after any change)

1. `node --check` all `pc-control-headless/**/*.js`
2. `--help` / `--setup` (temp config) / `--list-tools` (= 46 active)
3. HTTP: 401 matrix, initialize → tools/list = 46, shell refuse + allow
4. WSL stdio: injection battery 7/7 refused, echo/ls succeed
5. Dashboard: `/dashboard`+`/tools`+`/logs` 401 unauth / 200 authed, logs cap
6. `status` exits 0 up / 1 down; `--tailscale` warns cleanly without binary
7. Operator commands on temp config: `dashboard` exit 1 down; `doctor`
   10/10 run; `config` secret-refuse + invalid-revert; `rotate-key`;
   `backup`; `logs` cap; attach (`already running`, no second server)

## Addendum 2026-10-01 — operator commands, CLI polish, GUI console card

- `dashboard`: probes `/status` with owner key; prints console URL and
  opens the browser unless `--no-open`. Down → exit 1. Verified down-path.
- `doctor`: 10 checks (node≥22, config parses, key set, port sane,
  approval known, registry loads = 46, perms, disk, tailscale info,
  runtime warn-only). `--lint` exits 2 on fails; `--json` goes to stdout
  (pipeable); `--fix` only chmods + fills an empty key. Verified 0/1.
- `config get/set/validate`: whitelist of 10 safe keys; secrets
  (`api_key`, `previous_api_key`, `user_keys`, oauth) refused both ways;
  values JSON-parse (arrays work); set-then-validate with revert on
  failure — a bad write can never persist. Verified: port 3000→3421,
  `port 99999` rejected + config still `valid`.
- `rotate-key`: `crypto.randomBytes(24)` (schema length), old key moved to
  `previous_api_key` for zero-downtime relay handover, atomic write.
  Verified (new fingerprint `cd5eb1a8e1d7`).
- `logs`/`backup`: same 200-line/500-char caps as the endpoint; timestamped
  copy chmodded 600 on POSIX. Verified.
- Attach: `--mode=http` probes first — a live runtime (GUI or CLI) yields
  `already running` + console URL and exit 0 instead of EADDRINUSE crash.
  Verified LIVE against a temp-port server (46 tools, uptime 6s).
- Flags parse before AND after the subcommand (`dashboard --port 3499`
  works); `--config` still claimed pre-require anywhere in argv.
- Polish: TTY-gated ANSI (`●/▲/✖`, bold, cyan URLs), `NO_COLOR`/`dumb`/
  piped → raw. `logs` output stays raw always (greppable).
- Attack surface of new code: `openBrowser` (execFile, no shell, fixed
  binary per OS, best-effort); `config set` (whitelist + schema gate);
  `doctor --fix` (chmod + keygen only); `rotate-key` (local file only).
  No new network listeners, no new endpoints, no dependency added.
- GUI: ONE additive endpoint card (Web console: copy + open via existing
  `write-clipboard`/`open-url` IPC) + 3-line status render. No main.js,
  preload, or CSS change. `node --check` clean on both renderer files;
  desktop `/dashboard` mount (index.js:374) already serves the card's URL.
- `pc-control gui status/setup` (Windows-only, refuses elsewhere): detect
  via HKCU Uninstall registry + exe on disk + version from
  `resources/app/package.json`; `setup` short-circuits when installed,
  else silent-installs (`/S`) from `--installer`/`PC_CONTROL_GUI_INSTALLER`
  and re-verifies. Verified LIVE: detected `PC Control MCP 1.0.0-beta`
  at `%LOCALAPPDATA%/Programs/PC Control MCP`, runtime stopped, setup
  correctly no-op'd. No auto-download (v2, needs hash-pinned releases).
- Headless dials the hosted relay: `server.js` calls audited
  `lib/relay-client startRelayClient` after listen (unchanged code),
  `relay_url` built from `relay_domain`, room = `name`, forward port =
  live PORT. Skipped when `--no-relay`, `relay_enabled: false`, or no
  `name`. Wrapped so relay failure never kills the local server; stdio
  mode never dials (no port to forward). Verified: boot log shows
  `relay: off` branch, `doctor` reports 11th `relay` check, `--status` up.
  Live dial against prod relay NOT tested from temp config (would join a
  room) — first real dial happens on a real box.
- Platform parity: `SHELL_EXTRA` gate — WINDOWS_ONLY forced off ONLY
  off-Windows; on win32 the CLI serves the native set and skips the POSIX
  `shell_exec` shim (native `run_command` covers shell). All counts
  (`/status`, `/tools`, boot line, `--list-tools`, `doctor`) use the gate.
  Verified LIVE on win32:   `active (97)`, `disabled (0)`. Tradeoff noted in
  code: a hand-disabled Win tool in a win32 CLI config re-enables (use the
  GUI surface for that).
- `setup` wizard (TTY-only, refuses pipes): 5 steps — room name, port
  (validated), approval (validated, turbo warns), relay join + domain
  (bare-hostname gate), optional fresh owner key (old → `previous_api_key`).
  Re-runnable, current values as defaults. Non-TTY exits 2 with the
  flag-equivalent pointer.
- `keys list/add/revoke`: list shows label/scopes/fingerprint only; `add`
  defaults to `mcp:resources` (fail closed), dup labels refused, scopes
  validated against `mcp:tools|mcp:resources`; `revoke` by id/label/8+ key
  prefix. Secrets print once. Verified: add/list/revoke round-trip, bad
  scope exit 2, `config set relay_domain "https://evil.com/x"` rejected.
- `isBareHostname` gate shared by wizard + `config set relay_domain` —
  closes the relay-retarget finding (scheme/path/port rejected).
- 401-means-alive: `probeStatus` returns `{s}` / `{auth:false}` / `null`;
  `--mode=http` refuses to boot over a 401 runtime (exit 1 + `--config`
  pointer), `--status`/`dashboard` report key-mismatch instead of "down",
  `doctor` fails the runtime check on 401, `gui status` prints CLI-vs-GUI
  key fingerprints. Verified LIVE both directions: cross-key 401 → no
  second server; same-key → attached exit 0 (97 tools).
- CORE (one product): `lib/events.js` bus (RUNTIME/RELAY/CONFIG/KEYS/TOOL
  events, no Electron imports); `lib/config-service.js` (precedence:
  --config > env > GUI-if-CLI-absent > default; atomic validated save;
  watcher re-emits external edits). CLI adopts GUI config on fresh use.
- `lib/relay-client` now tracks + emits state
  (idle/connecting/connected/retrying/offline/paused) and exports
  `getRelayState`/`retryRelay`. Headless `/status` carries `relay`;
  `POST /relay/retry` mirrors the GUI Retry button; `relay status|retry`
  works same-process or over HTTP. Verified LIVE (idle state + retry path).
- Version unified: `index.js` 5× hardcoded `"2.0.0"` → package `1.0.0`;
  desktop `/status` gains `mode:"desktop"`. One fleet, one version.
- Server watches its config file and logs external edits.
- NOT yet: Electron still runs its bespoke relay + own config load
  (works, untouched — migration staged with GUI work, not snuck in).
- Tunnel (one `lib/tunnel-service.js` engine): quick + named/custom +
  tailscale serve/funnel, state on the bus. Desktop installer now packs
  `pc-control-headless/web` (dashboard 404 fixed); `dashboard_enabled`
  gates both servers. GUI: Connect remote-access section, Overview
  tunnel/console switches, custom-domain wizard modal, tailscale
  controls (funnel behind confirm), collapsible cards (persisted).
  CLI: `tunnel` (status/off/quick/custom/login/create/route/forget) +
  `tailscale` (status/serve/funnel --yes/off). Token secret-gated,
  never printed/logged.
- Audit round 2 (27 findings) fixed: tunnel-name option injection,
  create/route name mismatch (tunnel_name persisted), CLI funnel --yes,
  mkdtemp 0600 yml + cleanup, openExternal whitelist + once-guard,
  login 10-min timeout, hostname `..`, port guard, mode whitelist,
  empty-optional-secret validate, wizard stuck-Next/escaping/retry,
  dash badge staleness, Esc + switch guards, stable collapse ids.
- Round 3: tunnel-service self-kill (stopChild deleted its own fresh
  config dir — reordered, verified alive 25s + public 401 probe);
  dashboard page shell public, data routes gated (fresh browsers work);
  main resolves lib from server dir (packaged fix); custom tunnel
  supervised (retry 5, VERIFIED/UNVERIFIED probe, stale-Live gone);
  `recordRequest` wired (was dead — weekly was empty);
  metrics persist weekly (8 weeks, 30s flush); dashboard toggle instant
  both servers (verified 404↔200, no restart); `config set` gains
  dashboard_enabled/tunnel_mode/hostname/name; console rebuilt GUI-twin
  with versioned assets + mismatch guard.
- `website/cli.html`: `#commands` section + nav entry documenting all 7.

## Addendum 2026-10-01 — console, status, tailscale, desktop mount

- `web/` console (3 files, no external assets): key in sessionStorage,
  Bearer header only, read-only (no tool invocation UI). Verified 200s.
- `GET /tools` (names+scopes) and `GET /logs` (tail, 200-line/1MB/500-char
  caps) behind existing `apiKeyMiddleware`. Verified 401/200 + cap.
- `--status` probe: exit 0 with summary / 1 with reason. Verified both.
- `--tailscale` / `--tailscale-funnel`: spawnSync with timeouts, never
  crashes server; missing binary = clean warning. Verified LIVE:
  `tailscale serve` published the test server at
  `https://desktop-t814l6q.tail9c3971.ts.net`, then `serve off` removed it.
- Desktop runtime (`index.js`) gained ONE additive block: `/dashboard`,
  `/tools`, `/logs` mounted only if the bundle exists, all Bearer-gated.
  No existing route, behavior, or GUI file touched. `node --check` clean;
  full boot not re-tested here (desktop app was live on :3000 at the time).
- `website/cli.html` edition page + sitemap entry; `html-validate` clean.
