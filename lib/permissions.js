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

const READ_ONLY_CMDS = /^\s*(get|select|test|compare|measure|where|sort|out|write|read|find|convertto|join|split|group|import|export|resolve|trace)\b/i;
const READ_ONLY_PLAIN = /^\s*(dir|ls|echo|pwd|cd|type|whoami|hostname|systeminfo|ver|ipconfig|netstat|tasklist|taskkill\s*\/fi|findstr|where|help|cls|clear-host|clear-screen|get-help|history|ps|get-command)\b/i;
const READ_ONLY_ASSIGN = /^\s*\$\w+\s*=\s*(Get-\w+|Read-\w+|Test-\w+|get|read|test)\b/i;

const DANGEROUS_CMDS = /(remove-item|\brm\b|\bdel\b|\brd\b|\brmdir\b|remove-)/i;
const DANGEROUS_PROC = /(stop-process|stop-service|stop-computer|restart-computer|shutdown|\bkill\b|\btaskkill\b(?!\s*\/fi)|pskill)/i;
// clear-host and clear-screen are display-only (safe); all other clear-* are mutating
const DANGEROUS_MUT = /(set-|add-|new-|move-|copy-|rename-|clear-(?!host\b|screen\b)|format-|install-|uninstall-|mount-|dismount-|edit-)/i;
const DANGEROUS_EVAL = /(invoke-expression|\biex\b|invoke-webrequest|\biwr\b|\bwget\b|\bcurl\b|\biwr\b)/i;
const DANGEROUS_REG = /(reg\s+(add|delete|import|export|save|restore)|sc\s+(create|delete|stop|start|config)|schtasks\s+\/(create|delete|change|run)|net\s+(user|localgroup|share|accounts))/i;
const DANGEROUS_REDIRECT = /(>\s*[^|]*\.(exe|bat|cmd|ps1|vbs|js)\b|\|\s*(remove|del|rm|set-content|invoke-expression|out-null)\b)/i;

/**
 * Heuristic: is this PowerShell command read-only (safe to auto-approve)?
 * Unknown / ambiguous commands are considered NOT safe.
 */
function isReadOnlyCommand(command) {
  const c = String(command || "").trim();
  if (!c) return false;
  if (DANGEROUS_CMDS.test(c) || DANGEROUS_PROC.test(c) || DANGEROUS_MUT.test(c) ||
      DANGEROUS_EVAL.test(c) || DANGEROUS_REG.test(c) || DANGEROUS_REDIRECT.test(c)) {
    return false;
  }
  if (READ_ONLY_CMDS.test(c) || READ_ONLY_PLAIN.test(c) || READ_ONLY_ASSIGN.test(c) || /^clear-host\b/i.test(c)) {
    return true;
  }
  return false;
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