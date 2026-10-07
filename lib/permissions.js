/**
 * lib/permissions.js — Command approval modes for PowerShell execution.
 *
 * Modes (stored in config.json as `permission_mode`):
 *   - "turbo"        → never ask, run everything immediately.
 *   - "always"       → ask for EVERY command (previous default).
 *   - "intermediate" → auto-approve clearly read-only commands, ask for the rest.
 *
 * Used by tools/shell.js when the server runs inside the desktop app
 * (process.send available = human-in-the-loop approval channel exists).
 */

"use strict";

// Defense in depth: even if a command passes the allowlist below, these never auto-approve.
const DANGEROUS_CMDS = /(remove-item|\brm\b|\bdel\b|\brd\b|\brmdir\b|remove-)/i;
const DANGEROUS_PROC = /(stop-process|stop-service|stop-computer|restart-computer|shutdown|\bkill\b|\btaskkill\b|pskill)/i;
// clear-host and clear-screen are display-only (safe); all other clear-* are mutating
const DANGEROUS_MUT = /(set-|add-|new-|move-|copy-|rename-|clear-(?!host\b|screen\b)|format-(?!table\b|list\b|wide\b|custom\b)|install-|uninstall-|mount-|dismount-|edit-)/i;
const DANGEROUS_EVAL = /(invoke-expression|\biex\b|invoke-webrequest|\biwr\b|\bwget\b|\bcurl\b)/i;
const DANGEROUS_REG = /(reg\s+(add|delete|import|export|save|restore)|sc\s+(create|delete|stop|start|config)|schtasks\s+\/(create|delete|change|run)|net\s+(user|localgroup|share|accounts))/i;

// Cmdlet verbs that never change system state. Anything else needs approval.
// (Out-*/Export-*/Invoke-*/Start-*/Set-* etc. are deliberately absent.)
const SAFE_VERBS = new Set([
  "get", "select", "where", "sort", "measure", "test", "compare", "group", "join",
  "split", "resolve", "convertto", "convertfrom",
]);
// Exact cmdlets that only render output (their verbs also cover destructive ones, e.g. Format-Volume).
const SAFE_OUT = new Set([
  "out-string", "out-host", "write-output", "write-host",
  "format-table", "format-list", "format-wide", "format-custom",
]);
// Native/alias commands that only read.
const SAFE_PLAIN = new Set([
  "dir", "ls", "echo", "pwd", "type", "whoami", "hostname", "systeminfo", "ver",
  "ipconfig", "netstat", "tasklist", "findstr", "where", "help", "cls", "history", "ps",
  "clear-host", "clear-screen",
]);
// Constructs that can hide or chain arbitrary code inside a "read-only" statement.
const SMUGGLE = /(\$\(|`|\bcmd(\.exe)?\b|\bpowershell(\.exe)?\b|\bpwsh(\.exe)?\b|>|<)/i;

/**
 * Is this single statement / pipeline stage a known read-only command?
 */
function isSafeSegment(segment) {
  let s = segment.trim();
  if (!s) return true;
  // `$x = Get-Thing` — judge the right-hand side.
  s = s.replace(/^\$\w+\s*=\s*/, "");
  const first = (s.match(/^[^\s]+/) || [""])[0].toLowerCase();
  if (!first) return false;
  if (SAFE_PLAIN.has(first) || SAFE_OUT.has(first)) return true;
  const m = first.match(/^([a-z]+)-[a-z]/);
  return !!(m && SAFE_VERBS.has(m[1]));
}

/**
 * Is this PowerShell command read-only (safe to auto-approve)?
 * Allowlist-based: EVERY statement and pipeline stage must be a known
 * read-only command, and no code-smuggling construct may appear.
 * Unknown / ambiguous commands are considered NOT safe.
 */
function isReadOnlyCommand(command) {
  const c = String(command || "").trim();
  if (!c) return false;
  if (SMUGGLE.test(c)) return false;
  if (DANGEROUS_CMDS.test(c) || DANGEROUS_PROC.test(c) || DANGEROUS_MUT.test(c) ||
      DANGEROUS_EVAL.test(c) || DANGEROUS_REG.test(c)) {
    return false;
  }
  // Every cmdlet-looking token anywhere (inside script blocks / arguments too)
  // must use a safe verb, so `Where-Object { Start-Process x }` still asks.
  for (const t of c.toLowerCase().match(/\b[a-z]+-[a-z]+\b/g) || []) {
    const verb = t.split("-")[0];
    if (!SAFE_VERBS.has(verb) && !SAFE_OUT.has(t) && !SAFE_PLAIN.has(t)) return false;
  }
  return c.split(/\r?\n|;|&&|\|\||\||&/).every(isSafeSegment);
}

/**
 * Should this command require human approval under the given mode?
 */
function shouldRequestApproval(command, mode) {
  const m = String(mode || "").toLowerCase().trim();
  if (m === "turbo") return false;
  if (m === "intermediate") {
    const c = String(command || "").trim();
    if (!c) return false;
    return !isReadOnlyCommand(c);
  }
  return true; // "always" (default) → ask for everything
}

module.exports = { isReadOnlyCommand, shouldRequestApproval };