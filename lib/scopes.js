/**
 * scopes.js — tool → required API-key scope mapping (local app copy).
 * KEEP IN SYNC with relay-server/scopes.js (relay copy). Change in both places.
 *
 * Scopes:
 *   mcp:tools      — full control (execute commands, write files, input, system changes)
 *   mcp:resources  — read-only (read files, list processes, network get, system info)
 *
 * A key granted "mcp:tools" can call every tool. A key granted only
 * "mcp:resources" can call only the tools listed in READ_ONLY_TOOLS.
 * Unknown/new tools default to mcp:tools (fail closed).
 */

"use strict";

const READ_ONLY_TOOLS = new Set([
  // filesystem — read
  "read_file", "list_dir", "file_exists", "get_file_info", "search_files",
  "read_json", "get_folder_size", "grep_files", "grep",
  // git — read
  "git_status", "git_log", "git_diff", "git_branch",
  // input — read
  "get_mouse_position", "list_windows", "get_active_window",
  // memory — read
  "memory_get", "memory_list",
  // network — read
  "http_get", "web_search",
  // network_advanced — read
  "ping_host", "get_public_ip", "get_local_ip", "list_network_connections",
  "dns_lookup", "list_wifi_networks",
  // notification — read
  "get_volume",
  // server — read
  "check_port",
  // shell — no reads (get_env exposes secrets, requires mcp:tools)
  // system — read
  "get_system_info", "list_processes", "get_clipboard", "take_screenshot",
  "read_screen_text",
  // system_advanced — read
  "list_installed_apps", "get_battery_status", "get_disk_usage",
  "get_startup_programs", "take_screenshot_region", "get_screen_resolution",
  // utility
  "encode_base64", "decode_base64", "generate_uuid", "hash_text",
  "format_json", "timestamp_now",
]);

const REQUIRED_SCOPE_CACHE = {};

/**
 * Return the scope required to run a tool.
 * mcp:resources for read-only tools, mcp:tools for everything else (fail closed).
 */
function toolScopeOf(toolName) {
  if (REQUIRED_SCOPE_CACHE[toolName] === undefined) {
    REQUIRED_SCOPE_CACHE[toolName] = READ_ONLY_TOOLS.has(toolName) ? "mcp:resources" : "mcp:tools";
  }
  return REQUIRED_SCOPE_CACHE[toolName];
}

/**
 * Check whether a set of granted scopes permits the required scope.
 * mcp:tools implies mcp:resources.
 */
function hasScope(grantedScopes, requiredScope) {
  const granted = Array.isArray(grantedScopes) ? grantedScopes : [];
  if (granted.includes("mcp:tools")) return true;
  return granted.includes(requiredScope);
}

module.exports = { toolScopeOf, hasScope, READ_ONLY_TOOLS };