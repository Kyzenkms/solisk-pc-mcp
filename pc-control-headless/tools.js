"use strict";

/**
 * tools.js — platform gating for the headless build.
 * WINDOWS_ONLY: tool names needing Win32 APIs. registerCliExtra adds the
 * POSIX shell_exec shim with the registry's auth + audit wrappers.
 */

const { shellExecTool } = require("./tools/shell_linux");
const { assertToolAllowed, jsonSchemaToZod } = require("../lib/registry");
const { logAudit } = require("../lib/security");
const { recordToolCall } = require("../lib/metrics");
const { log } = require("../lib/middleware");

// On Windows the native run_command family covers shell — extra stays off.
const SHELL_EXTRA = process.platform !== "win32";

// Exact tool names per module (must match tools/*.js name fields).
const WINDOWS_ONLY = [
  // tools/shell.js — PowerShell execution
  "run_command", "run_command_background", "get_env", "set_env",
  // tools/system.js — Win32 APIs, screenshot_helper.exe, ocr_helper.exe
  "get_system_info", "list_processes", "kill_process", "take_screenshot",
  "get_clipboard", "set_clipboard", "open_url", "open_file", "read_screen_text",
  // tools/system_advanced.js — rundll32, shutdown.exe, schtasks, RunAs
  "list_installed_apps", "get_battery_status", "get_disk_usage",
  "get_startup_programs", "run_as_admin", "schedule_task",
  "take_screenshot_region", "get_screen_resolution", "empty_recycle_bin",
  "lock_screen", "shutdown",
  // tools/input.js — mouse/keyboard injection via PowerShell
  "mouse_click", "mouse_double_click", "mouse_move", "get_mouse_position",
  "keyboard_type", "key_press", "list_windows", "focus_window",
  "get_active_window", "close_window",
  // tools/notification.js — toast/dialog/audio via PowerShell
  "show_notification", "show_dialog", "speak_text", "play_sound",
  "set_volume", "get_volume",
  // tools/network_advanced.js — PowerShell networking cmdlets
  "ping_host", "get_public_ip", "get_local_ip", "list_network_connections",
  "dns_lookup", "list_wifi_networks", "get_wifi_password",
  // tools/server.js — cloudflared tunnel + PowerShell helpers
  "serve_directory", "stop_server", "expose_port", "download_file", "check_port",
];

function registerCliExtra(server, principal = null) {
  if (!SHELL_EXTRA) {
    log("info", "Skipped headless shell extra on win32 — native run_command covers shell");
    return;
  }
  const zodSchema = jsonSchemaToZod(shellExecTool.inputSchema);
  server.tool(shellExecTool.name, shellExecTool.description, zodSchema.shape, async (args) => {
    const start = Date.now();
    try {
      assertToolAllowed(shellExecTool.name, principal);
      const result = await shellExecTool.handler(zodSchema.parse(args));
      const success = result.success !== false;
      logAudit(shellExecTool.name, args, success, success ? result : (result.error || "Failed"));
      recordToolCall(shellExecTool.name, success);
      log("info", `Tool executed: ${shellExecTool.name}`, { tool: shellExecTool.name, success, duration_ms: Date.now() - start });
      return {
        isError: !success,
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      logAudit(shellExecTool.name, args, false, err.message);
      recordToolCall(shellExecTool.name, false);
      log("error", `Tool error: ${shellExecTool.name}`, { tool: shellExecTool.name, error: err.message, duration_ms: Date.now() - start });
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  });
  log("info", "Registered headless extra: shell_exec");
}

module.exports = { WINDOWS_ONLY, SHELL_EXTRA, registerCliExtra };
