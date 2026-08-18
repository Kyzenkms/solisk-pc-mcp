const { execPowershellAsync } = require("../lib/powershell");

// Mouse click via user32.dll P/Invoke
const MOUSE_TYPE = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MouseControl {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int c, int e);
  public const uint LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, RIGHT_DOWN = 0x0008, RIGHT_UP = 0x0010, MOVE = 0x0001;
  public static void LeftClick(int x, int y)  { SetCursorPos(x,y); mouse_event(LEFT_DOWN,x,y,0,0); mouse_event(LEFT_UP,x,y,0,0); }
  public static void RightClick(int x, int y) { SetCursorPos(x,y); mouse_event(RIGHT_DOWN,x,y,0,0); mouse_event(RIGHT_UP,x,y,0,0); }
  public static void DoubleClick(int x, int y) { LeftClick(x,y); System.Threading.Thread.Sleep(50); LeftClick(x,y); }
}
'@`.trim();

const WIN32_TYPE = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinControl {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int m);
}
'@`.trim();

const inputTools = [
  // ── Mouse ──
  {
    name: "mouse_click",
    description: "Click the mouse at specific screen coordinates (x, y). Use take_screenshot first to see what's on screen.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate (pixels from left)" },
        y: { type: "number", description: "Y coordinate (pixels from top)" },
        button: { type: "string", description: "Button: left, right (default: left)", default: "left" },
      },
      required: ["x", "y"],
    },
    handler: async ({ x, y, button = "left" }) => {
      const clickFn = button === "right" ? "RightClick" : "LeftClick";
      const res = await execPowershellAsync(`${MOUSE_TYPE}; [MouseControl]::${clickFn}(${x}, ${y})`);
      if (res.status === 0) {
        return { success: true, data: { action: `${button} click`, x, y } };
      }
      return { success: false, error: res.stderr || res.error || "Mouse click failed", code: "MOUSE_CLICK_FAILED" };
    },
  },
  {
    name: "mouse_double_click",
    description: "Double-click the mouse at specific screen coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate" },
        y: { type: "number", description: "Y coordinate" },
      },
      required: ["x", "y"],
    },
    handler: async ({ x, y }) => {
      const res = await execPowershellAsync(`${MOUSE_TYPE}; [MouseControl]::DoubleClick(${x}, ${y})`);
      if (res.status === 0) {
        return { success: true, data: { action: "double click", x, y } };
      }
      return { success: false, error: res.stderr || res.error || "Mouse double click failed", code: "MOUSE_DOUBLE_CLICK_FAILED" };
    },
  },
  {
    name: "mouse_move",
    description: "Move the mouse cursor to specific screen coordinates without clicking.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate" },
        y: { type: "number", description: "Y coordinate" },
      },
      required: ["x", "y"],
    },
    handler: async ({ x, y }) => {
      const res = await execPowershellAsync(`${MOUSE_TYPE}; [MouseControl]::SetCursorPos(${x}, ${y})`);
      if (res.status === 0) {
        return { success: true, data: { action: "move", x, y } };
      }
      return { success: false, error: res.stderr || res.error || "Mouse move failed", code: "MOUSE_MOVE_FAILED" };
    },
  },
  {
    name: "get_mouse_position",
    description: "Get the current mouse cursor position on screen.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const res = await execPowershellAsync(`Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.Cursor]::Position; Write-Output "$($p.X),$($p.Y)"`);
      if (res.status === 0 && res.stdout) {
        const [x, y] = res.stdout.split(",").map(Number);
        return { success: true, data: { x, y } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to get mouse position", code: "GET_MOUSE_POS_FAILED" };
    },
  },

  // ── Keyboard ──
  {
    name: "keyboard_type",
    description: "Type text as if using the keyboard. The text will be typed into whichever window is currently focused.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
      },
      required: ["text"],
    },
    handler: async ({ text }) => {
      const escaped = text
        .replace(/\+/g, "{+}")
        .replace(/\^/g, "{^}")
        .replace(/%/g, "{%}")
        .replace(/~/g, "{~}")
        .replace(/\(/g, "{(}")
        .replace(/\)/g, "{)}")
        .replace(/\[/g, "{[}")
        .replace(/\]/g, "{]}")
        .replace(/\{/g, "{{")
        .replace(/\}/g, "}}");
      const res = await execPowershellAsync(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')`);;
      if (res.status === 0) {
        return { success: true, data: { typed: text } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to type text", code: "KEYBOARD_TYPE_FAILED" };
    },
  },
  {
    name: "key_press",
    description: "Press a keyboard key or key combination. Examples: 'Enter', 'Escape', 'ctrl+c', 'ctrl+alt+t', 'F5', 'alt+F4'.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Key or combo: 'Enter', 'Escape', 'Tab', 'F1'-'F12', 'ctrl+c', 'ctrl+shift+i', 'alt+F4', 'win+d', etc.",
        },
      },
      required: ["key"],
    },
    handler: async ({ key }) => {
      let sendKey = key.toLowerCase()
        .replace("ctrl+", "^").replace("alt+", "%").replace("shift+", "+").replace("win+", "^%")
        .replace("enter", "{ENTER}").replace("escape", "{ESC}").replace("esc", "{ESC}")
        .replace("tab", "{TAB}").replace("space", " ").replace("backspace", "{BS}")
        .replace("delete", "{DEL}").replace("del", "{DEL}")
        .replace("home", "{HOME}").replace("end", "{END}")
        .replace("pageup", "{PGUP}").replace("pagedown", "{PGDN}")
        .replace("up", "{UP}").replace("down", "{DOWN}").replace("left", "{LEFT}").replace("right", "{RIGHT}")
        .replace(/f(\d+)/g, (_, n) => `{F${n}}`);

      const res = await execPowershellAsync(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKey.replace(/'/g, "''")}')`);;
      if (res.status === 0) {
        return { success: true, data: { key_pressed: key } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to press key", code: "KEY_PRESS_FAILED" };
    },
  },

  // ── Window Management ──
  {
    name: "list_windows",
    description: "List all open windows with their titles, process names, and PIDs. Can filter by title or PID.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional: filter by window title containing this text" },
        pid: { type: "number", description: "Optional: filter by process ID (PID)" }
      },
    },
    handler: async ({ filter = "", pid }) => {
      const res = await execPowershellAsync(
        `Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object Name,Id,MainWindowTitle | ConvertTo-Json -Depth 2`
      );
      if (res.status === 0 && res.stdout) {
        try {
          let windows = JSON.parse(res.stdout);
          if (!Array.isArray(windows)) windows = [windows];
          if (filter) {
            windows = windows.filter((w) => w.MainWindowTitle?.toLowerCase().includes(filter.toLowerCase()));
          }
          if (pid) {
            windows = windows.filter((w) => w.Id === pid);
          }
          const list = windows.map((w) => ({ title: w.MainWindowTitle, process: w.Name, pid: w.Id }));
          return { success: true, data: { count: list.length, windows: list } };
        } catch (e) {
          return { success: true, data: { count: 0, windows: [] } };
        }
      }
      return { success: false, error: res.stderr || res.error || "Failed to list windows", code: "LIST_WINDOWS_FAILED" };
    },
  },
  {
    name: "focus_window",
    description: "Bring a window to the front and focus it by its title or PID.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Partial window title to match" },
        pid: { type: "number", description: "Or PID of the process to focus" }
      }
    },
    handler: async ({ title, pid }) => {
      if (!title && !pid) {
        return { success: false, error: "Must provide either 'title' or 'pid' to focus a window", code: "INVALID_PARAMETERS" };
      }

      let script = WIN32_TYPE + "\n";
      if (pid) {
        script += `$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -First 1`;
      } else {
        script += `$proc = Get-Process | Where-Object {$_.MainWindowTitle -like '*${title.replace(/'/g, "''")}*'} | Select-Object -First 1`;
      }
      script += `
        if ($proc) { 
          [WinControl]::ShowWindow($proc.MainWindowHandle, 9)
          [WinControl]::SetForegroundWindow($proc.MainWindowHandle)
          Write-Output "OK" 
        } else { 
          Write-Output "NOT_FOUND" 
        }
      `;

      const res = await execPowershellAsync(script);
      if (res.status === 0 && res.stdout.includes("OK")) {
        return { success: true, data: { focused: pid || title } };
      }
      return { success: false, error: `Window not found or failed to focus: ${pid || title}`, code: "WINDOW_NOT_FOUND" };
    },
  },
  {
    name: "get_active_window",
    description: "Get the title and process of the currently active (focused) window.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      // Find the window that is currently in the foreground using P/Invoke
      const script = WIN32_TYPE + `
        $hwnd = [WinControl]::GetForegroundWindow()
        if ($hwnd -ne [IntPtr]::Zero) {
          $proc = Get-Process | Where-Object {$_.MainWindowHandle -eq $hwnd} | Select-Object -First 1
          if ($proc) {
            Write-Output "$($proc.Name)|$($proc.MainWindowTitle)|$($proc.Id)"
          } else {
            # Check if we can get text directly
            $sb = New-Object System.Text.StringBuilder 256
            [void][WinControl]::GetWindowText($hwnd, $sb, $sb.Capacity)
            Write-Output "unknown|$($sb.ToString())|0"
          }
        } else {
          Write-Output "None|None|0"
        }
      `;
      const res = await execPowershellAsync(script);
      if (res.status === 0 && res.stdout) {
        const parts = res.stdout.split("|");
        if (parts.length >= 3) {
          return {
            success: true,
            data: {
              process: parts[0]?.trim(),
              title: parts[1]?.trim(),
              pid: parseInt(parts[2]?.trim()) || 0
            }
          };
        }
      }
      return { success: false, error: res.stderr || res.error || "Failed to get active window", code: "GET_ACTIVE_WINDOW_FAILED" };
    },
  },
  {
    name: "close_window",
    description: "Close a window by its title or PID. (Requires confirmation).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Partial window title to match" },
        pid: { type: "number", description: "Or PID of the process to close" },
        confirm: { type: "boolean", description: "Must set to true to proceed with closing", default: false }
      }
    },
    handler: async ({ title, pid, confirm }) => {
      if (!confirm) {
        return { 
          success: false, 
          error: "This is a potentially destructive action. You must pass 'confirm: true' to perform this action.", 
          code: "CONFIRMATION_REQUIRED" 
        };
      }
      if (!title && !pid) {
        return { success: false, error: "Must provide either 'title' or 'pid' to close a window", code: "INVALID_PARAMETERS" };
      }

      let script = "";
      if (pid) {
        script = `Stop-Process -Id ${pid} -Force -ErrorAction Stop`;
      } else {
        script = `Get-Process | Where-Object {$_.MainWindowTitle -like '*${title.replace(/'/g, "''")}*'} | Stop-Process -Force -ErrorAction Stop`;
      }

      const res = await execPowershellAsync(script);
      if (res.status === 0) {
        return { success: true, data: { closed: pid || title } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to close window", code: "CLOSE_WINDOW_FAILED" };
    },
  },
];

module.exports = inputTools;
