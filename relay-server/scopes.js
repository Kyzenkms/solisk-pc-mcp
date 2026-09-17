/**
 * relay-server/scopes.js — Tool → scope mapping and scope checks.
 *
 * The relay route /tool/:name and MCP tools/call is used by AI clients. For
 * per-user API keys the relay enforces scopes BEFORE forwarding a tool call
 * to the local PC. The mapping below associates every tool we ever forward
 * with the minimal scope required to invoke it.
 */

"use strict";

const TOOL_SCOPE = {
  // File access
  read_file: "pc:file:read", read_file_lines: "pc:file:read", read_binary_file: "pc:file:read",
  hash_file: "pc:file:read", read_json: "pc:file:read", file_exists: "pc:file:read", get_file_info: "pc:file:read",
  get_folder_size: "pc:file:read", search_files: "pc:file:read", grep_files: "pc:file:read", grep: "pc:file:read",
  list_files: "pc:file:list", list_directory: "pc:file:list", list_dir: "pc:file:list",
  write_file: "pc:file:write", append_file: "pc:file:write", create_file: "pc:file:write",
  delete_file: "pc:file:write", move_file: "pc:file:write", copy_file: "pc:file:write", write_json: "pc:file:write",
  patch_file: "pc:file:write", edit_file: "pc:file:write", str_replace: "pc:file:write",
  replace_file_content: "pc:file:write", download_file: "pc:file:write",

  // Process and host control
  run_command: "pc:process:run", run_command_background: "pc:process:run", run_process: "pc:process:run",
  open_program: "pc:process:run", open_url: "pc:process:run", open_file: "pc:process:run",
  set_env: "pc:process:run", serve_directory: "pc:process:run", expose_port: "pc:process:run",
  run_as_admin: "pc:process:run", schedule_task: "pc:process:run", shutdown: "pc:process:run",
  lock_screen: "pc:process:run", empty_recycle_bin: "pc:file:write",
  get_env: "pc:process:list", get_system_info: "pc:process:list", list_processes: "pc:process:list",
  get_process_info: "pc:process:list", list_installed_apps: "pc:process:list", get_battery_status: "pc:process:list",
  get_disk_usage: "pc:process:list", get_startup_programs: "pc:process:list", check_port: "pc:process:list",
  list_windows: "pc:process:list", get_active_window: "pc:process:list",
  kill_process: "pc:process:kill", stop_server: "pc:process:kill", close_window: "pc:process:kill",

  // UI, keyboard, and screen
  mouse_click: "pc:ui:click", mouse_double_click: "pc:ui:click", double_click: "pc:ui:click",
  right_click: "pc:ui:click", drag_and_drop: "pc:ui:click", focus_window: "pc:ui:click",
  mouse_move: "pc:mouse:move", get_mouse_position: "pc:mouse:move",
  type_text: "pc:ui:type", type_key: "pc:ui:type", keyboard_type: "pc:keyboard:type",
  keyboard_hotkey: "pc:keyboard:hotkey", press_hotkey: "pc:keyboard:hotkey", key_press: "pc:keyboard:hotkey",
  scroll: "pc:ui:scroll", mouse_scroll: "pc:ui:scroll",
  screenshot: "pc:ui:screenshot", take_screenshot: "pc:ui:screenshot",
  take_screenshot_region: "pc:ui:screenshot", read_screen_text: "pc:ui:screenshot",
  get_screen_resolution: "pc:ui:screenshot", ocr_screen: "pc:ui:screenshot",
  qa_screenshot: "pc:qa:screenshot", verify_screen: "pc:qa:screenshot",

  // Network
  nslookup: "pc:network:nslookup", search_internet: "pc:network:nslookup", http_get: "pc:network:nslookup",
  http_post: "pc:network:nslookup", web_search: "pc:network:nslookup", ping_host: "pc:network:nslookup",
  get_public_ip: "pc:network:nslookup", get_local_ip: "pc:network:nslookup",
  list_network_connections: "pc:network:nslookup", dns_lookup: "pc:network:nslookup",
  list_wifi_networks: "pc:network:nslookup", get_wifi_password: "pc:network:nslookup",
  get_clipboard: "pc:clipboard:read", set_clipboard: "pc:clipboard:write",
  show_notification: "pc:notification:show", show_dialog: "pc:notification:show",
  speak_text: "pc:audio:control", play_sound: "pc:audio:control", set_volume: "pc:audio:control", get_volume: "pc:audio:control",
  memory_get: "pc:memory:read", memory_list: "pc:memory:read",
  memory_set: "pc:memory:write", memory_delete: "pc:memory:write", memory_clear: "pc:memory:write", memory_append: "pc:memory:write",
  git_status: "pc:git:read", git_log: "pc:git:read", git_diff: "pc:git:read", git_branch: "pc:git:read",
  git_clone: "pc:git:write", git_add: "pc:git:write", git_commit: "pc:git:write", git_push: "pc:git:write",
  git_pull: "pc:git:write", git_init: "pc:git:write",
};

const UNRESTRICTED_TOOLS = new Set([
  "encode_base64", "decode_base64", "generate_uuid", "hash_text", "format_json", "timestamp_now",
]);

function toolScopeOf(name) {
  return TOOL_SCOPE[name];
}

// Returns true if the given scope list includes the scope required by `name`.
//
// Three scope languages coexist:
//   * "pc:*" scopes  → fine-grained per-user/group restrictions (new).
//   * "mcp:tools" / "mcp:resources" → legacy OAuth scopes issued by this
//     relay's discovery flow. These historically granted full access; we
//     keep treating them as grant-all so the existing MCP/OAuth path is
//     never broken by the new enforcement layer.
//   * "*"            → explicit grant-all.
function hasScope(scopes, name) {
  const arr = Array.isArray(scopes) ? scopes : [];
  if (arr.includes("*") || arr.includes("mcp:tools") || arr.includes("mcp:resources")) return true;
  const required = toolScopeOf(name);
  if (!required) return UNRESTRICTED_TOOLS.has(name);
  return arr.includes(required);
}

module.exports = { TOOL_SCOPE, toolScopeOf, hasScope };
