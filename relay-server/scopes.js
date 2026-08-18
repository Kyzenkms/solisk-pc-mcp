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
  // ── file ────────────────────────────────────────────────────────────
  read_file:      "pc:file:read",
  read_file_lines: "pc:file:read",
  write_file:     "pc:file:write",
  edit_file:      "pc:file:write",
  list_files:     "pc:file:list",
  list_directory: "pc:file:list",
  create_file:    "pc:file:write",
  delete_file:    "pc:file:write",
  get_file_info:  "pc:file:read",
  move_file:      "pc:file:write",
  copy_file:      "pc:file:write",
  read_binary_file: "pc:file:read",
  // ── process ─────────────────────────────────────────────────────────
  run_command:    "pc:process:run",
  run_process:    "pc:process:run",
  open_program:   "pc:process:run",
  list_processes: "pc:process:list",
  get_process_info: "pc:process:list",
  kill_process:   "pc:process:kill",
  // ── UI automation (mouse/keyboard) ──────────────────────────────────
  mouse_click:        "pc:ui:click",
  double_click:       "pc:ui:click",
  right_click:        "pc:ui:click",
  drag_and_drop:      "pc:ui:click",
  mouse_move:         "pc:mouse:move",
  type_text:          "pc:ui:type",
  type_key:           "pc:ui:type",
  keyboard_type:      "pc:keyboard:type",
  keyboard_hotkey:    "pc:keyboard:hotkey",
  press_hotkey:       "pc:keyboard:hotkey",
  scroll:             "pc:ui:scroll",
  mouse_scroll:       "pc:ui:scroll",
  screenshot:         "pc:ui:screenshot",
  take_screenshot:    "pc:ui:screenshot",
  // ── QA/screen ───────────────────────────────────────────────────────
  qa_screenshot:      "pc:qa:screenshot",
  verify_screen:      "pc:qa:screenshot",
  ocr_screen:         "pc:ui:screenshot",
  // ── network ─────────────────────────────────────────────────────────
  nslookup:           "pc:network:nslookup",
  search_internet:    "pc:network:nslookup",
};

// May return undefined (tool unknown → default allow so new tools are not
// silently blocked, but enforcement can still be tightened per room).
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
  if (!required) return true;
  return arr.includes(required);
}

module.exports = { TOOL_SCOPE, toolScopeOf, hasScope };