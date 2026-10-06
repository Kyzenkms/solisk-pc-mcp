"use strict";

/**
 * shell_linux.js — POSIX shell tool for the headless CLI build.
 *
 * Lives ONLY in pc-control-headless/. The GUI/desktop build is untouched and
 * keeps using PowerShell-based shell tools. This module is never loaded there.
 *
 * Safety model (default-deny):
 *  - An allowlist of read-only commands runs in `ask`/`intermediate` modes.
 *  - EVERYTHING else requires approval_mode=turbo (explicit operator opt-in).
 *    There is no interactive approval channel on a headless server, so "ask"
 *    means "refuse with a clear error", never "run anyway".
 *  - Execution is `sh -c` via spawn (no node shell:true, no string concat
 *    into other commands), with timeout, output cap, and cwd confined to
 *    allowed_paths via the shared checkPath() sandbox.
 */

const { spawn } = require("child_process");
const { checkPath, config, loadConfig } = require("../../lib/security");

// Conservative read-only allowlist (single simple command, no chaining).
// Anything not matching runs ONLY in turbo mode.
const READ_ONLY = /^\s*(ls|dir|pwd|echo|cat|head|tail|wc|grep|find|whoami|hostname|uname|date|df|du|ps|env|printenv|id|uptime|stat|file|which|cut|sort|uniq|tr)\b/i;

// Shell metacharacters that allow chaining a second command. In non-turbo
// modes a command containing any of these is never auto-approved.
const CHAIN = /[;&|`$()]|\|\||&&|\n/;

function isReadOnlyCommand(command) {
  const c = String(command || "");
  if (!c.trim() || CHAIN.test(c)) return false;
  return READ_ONLY.test(c);
}

function approvalMode() {
  try { loadConfig(); } catch {}
  return String((config && config.permission_mode) || "always").toLowerCase().trim();
}

function runSh(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const CAP = 2 * 1024 * 1024;
    child.stdout.on("data", (d) => { if (stdout.length < CAP) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < CAP) stderr += d; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn failed: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: true,
        timedOut,
        exitCode: timedOut ? null : code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

const shellExecTool = {
  name: "shell_exec",
  description:
    "Execute a POSIX shell command on the headless host. Read-only commands " +
    "run freely; anything else requires approval_mode=turbo. Output capped at 2MB.",
  inputSchema: {
    type: "object",
    properties: {
      command:    { type: "string",  description: "Shell command to run", minLength: 1, maxLength: 8000 },
      working_dir:{ type: "string",  description: "Working directory (must be inside allowed_paths)" },
      timeout_ms: { type: "number",  description: "Kill after N ms (default 30000, max 300000)", minimum: 1000, maximum: 300000 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async handler(args) {
    const command = String(args.command || "");
    if (!command.trim()) throw new Error("command is required");
    const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 30000, 1000), 300000);

    let cwd = process.cwd();
    if (args.working_dir) {
      const check = checkPath(String(args.working_dir));
      if (!check.allowed) throw new Error(`Access denied: ${check.reason}`);
      cwd = String(args.working_dir);
    }

    const mode = approvalMode();
    if (mode !== "turbo" && !isReadOnlyCommand(command)) {
      throw new Error(
        "Refused: command is not read-only and approval_mode is not turbo. " +
        "Headless servers cannot prompt for approval — rerun with approval_mode=turbo to allow mutating commands."
      );
    }

    const r = await runSh(command, cwd, timeoutMs);
    if (!r.ok) throw new Error(r.error);
    if (r.timedOut) throw new Error(`Execution timed out after ${timeoutMs}ms (SIGKILL).`);
    return {
      success: r.exitCode === 0,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  },
};

module.exports = { shellExecTool, isReadOnlyCommand };
