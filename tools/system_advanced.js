const { execPowershellAsync } = require("../lib/powershell");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const systemAdvancedTools = [
  {
    name: "list_installed_apps",
    description: "List all installed applications on the PC.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional: filter by app name containing this text" },
      },
    },
    handler: async ({ filter = "" }) => {
      const res = await execPowershellAsync(
        `Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName} | Select-Object DisplayName,DisplayVersion,Publisher | Sort-Object DisplayName | ConvertTo-Json -Depth 2`
      );
      if (res.status === 0 && res.stdout) {
        try {
          let apps = JSON.parse(res.stdout);
          if (!Array.isArray(apps)) apps = [apps];
          if (filter) {
            apps = apps.filter((a) => a.DisplayName?.toLowerCase().includes(filter.toLowerCase()));
          }
          const list = apps.map((a) => ({ name: a.DisplayName, version: a.DisplayVersion, publisher: a.Publisher }));
          return { success: true, data: { count: list.length, apps: list } };
        } catch (e) {
          return { success: true, data: { count: 0, apps: [] } };
        }
      }
      return { success: false, error: res.stderr || res.error || "Failed to list apps", code: "LIST_APPS_FAILED" };
    },
  },
  {
    name: "get_battery_status",
    description: "Get the battery status of the laptop (charge %, charging state, estimated time remaining).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const res = await execPowershellAsync(
        `Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object EstimatedChargeRemaining,BatteryStatus,EstimatedRunTime | ConvertTo-Json`
      );
      if (res.status !== 0 || !res.stdout || res.stdout === "null") {
        return { success: true, data: { has_battery: false } };
      }
      try {
        const data = JSON.parse(res.stdout);
        const statusMap = { 1: "Discharging", 2: "AC Power", 3: "Fully Charged", 4: "Low", 5: "Critical", 6: "Charging" };
        return {
          success: true,
          data: {
            has_battery: true,
            charge_percent: data.EstimatedChargeRemaining,
            status: statusMap[data.BatteryStatus] || `Status ${data.BatteryStatus}`,
            estimated_runtime_minutes: data.EstimatedRunTime === 71582788 ? null : data.EstimatedRunTime,
          }
        };
      } catch (e) {
        return { success: true, data: { has_battery: false } };
      }
    },
  },
  {
    name: "get_disk_usage",
    description: "Get disk space usage for all drives on the PC.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const res = await execPowershellAsync(
        `Get-PSDrive -PSProvider FileSystem | Select-Object Name,Root,@{N='Used_GB';E={[math]::Round($_.Used/1GB,2)}},@{N='Free_GB';E={[math]::Round($_.Free/1GB,2)}},@{N='Total_GB';E={[math]::Round(($_.Used+$_.Free)/1GB,2)}} | ConvertTo-Json -Depth 2`
      );
      if (res.status === 0 && res.stdout) {
        try {
          let drives = JSON.parse(res.stdout);
          if (!Array.isArray(drives)) drives = [drives];
          return { success: true, data: { drives } };
        } catch (e) {
          return { success: false, error: "Failed to parse disk usage output", code: "PARSE_ERROR" };
        }
      }
      return { success: false, error: res.stderr || res.error || "Failed to get disk usage", code: "DISK_USAGE_FAILED" };
    },
  },
  {
    name: "get_startup_programs",
    description: "List programs that run automatically on Windows startup.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const res = await execPowershellAsync(
        `Get-CimInstance -ClassName Win32_StartupCommand -ErrorAction SilentlyContinue | Select-Object Name,Command,Location | ConvertTo-Json -Depth 2`
      );
      if (res.status === 0 && res.stdout) {
        try {
          let items = JSON.parse(res.stdout);
          if (!Array.isArray(items)) items = [items];
          return { success: true, data: { count: items.length, startup_programs: items } };
        } catch (e) {
          return { success: true, data: { count: 0, startup_programs: [] } };
        }
      }
      return { success: false, error: res.stderr || res.error || "Failed to list startup programs", code: "STARTUP_LIST_FAILED" };
    },
  },
  {
    name: "run_as_admin",
    description: "Run a PowerShell command with administrator privileges (UAC prompt will appear). (Requires confirmation).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "PowerShell command to run as administrator" },
        confirm: { type: "boolean", description: "Must set to true to execute", default: false }
      },
      required: ["command"],
    },
    handler: async ({ command, confirm }) => {
      if (!confirm) {
        return {
          success: false,
          error: "Running commands with administrator privileges is potentially destructive. You must pass 'confirm: true' to perform this action.",
          code: "CONFIRMATION_REQUIRED"
        };
      }
      const escaped = command.replace(/'/g, "''");
      const res = await execPowershellAsync(`Start-Process powershell -ArgumentList '-NoProfile -Command ${escaped}' -Verb RunAs -Wait`);
      if (res.status === 0) {
        return { success: true, data: { ran_as_admin: true, command } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to run as admin", code: "RUN_AS_ADMIN_FAILED" };
    },
  },
  {
    name: "schedule_task",
    description: "Create a Windows scheduled task to run a command at a specific time.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name" },
        command: { type: "string", description: "Command to run" },
        time: { type: "string", description: "Time to run (e.g. '14:30' for 2:30 PM)" },
        once: { type: "boolean", description: "Run once (true) or daily (false)", default: true },
      },
      required: ["name", "command", "time"],
    },
    handler: async ({ name, command, time, once = true }) => {
      const trigger = once ? `New-ScheduledTaskTrigger -Once -At '${time.replace(/'/g, "''")}'` : `New-ScheduledTaskTrigger -Daily -At '${time.replace(/'/g, "''")}'`;
      const base64 = Buffer.from(command, "utf16le").toString("base64");
      const action = `New-ScheduledTaskAction -Execute 'powershell' -Argument '-NoProfile -EncodedCommand ${base64}'`;
      const res = await execPowershellAsync(`Register-ScheduledTask -TaskName '${name.replace(/'/g, "''")}' -Trigger (${trigger}) -Action (${action}) -Force`);
      if (res.status === 0) {
        return { success: true, data: { task_name: name, scheduled_at: time, recurring: !once } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to schedule task", code: "SCHEDULE_TASK_FAILED" };
    },
  },
  {
    name: "take_screenshot_region",
    description: "Take a screenshot of a specific region of the screen (instead of the whole screen).",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Left edge of region (pixels)" },
        y: { type: "number", description: "Top edge of region (pixels)" },
        width: { type: "number", description: "Width of region (pixels)" },
        height: { type: "number", description: "Height of region (pixels)" },
        save_path: { type: "string", description: "Optional path to save PNG (returns base64 if omitted)" },
      },
      required: ["x", "y", "width", "height"],
    },
    handler: async ({ x, y, width, height, save_path }) => {
      const tmpFile = save_path || path.join(os.tmpdir(), `region_${Date.now()}.png`);
      const psScript = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, [System.Drawing.Size]::new(${width}, ${height}))
$bmp.Save('${tmpFile.replace(/\\/g, "\\\\")}')
$g.Dispose(); $bmp.Dispose()
      `;

      const res = await execPowershellAsync(psScript);
      if (res.status !== 0) {
        return { success: false, error: res.stderr || res.error || "Failed to capture region", code: "REGION_CAPTURE_FAILED" };
      }

      if (save_path) return { success: true, data: { saved_to: tmpFile } };
      try {
        const imageData = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        return { success: true, data: { format: "png", base64: imageData.toString("base64"), region: { x, y, width, height } } };
      } catch (err) {
        return { success: false, error: err.message, code: "FILE_READ_FAILED" };
      }
    },
  },
  {
    name: "get_screen_resolution",
    description: "Get the current screen resolution and monitor information.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const res = await execPowershellAsync(
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | Select-Object DeviceName,@{N='Width';E={$_.Bounds.Width}},@{N='Height';E={$_.Bounds.Height}},Primary | ConvertTo-Json -Depth 2`
      );
      if (res.status === 0 && res.stdout) {
        try {
          let screens = JSON.parse(res.stdout);
          if (!Array.isArray(screens)) screens = [screens];
          return { success: true, data: { screen_count: screens.length, screens } };
        } catch (e) {
          return { success: false, error: "Failed to parse screen resolution JSON", code: "PARSE_ERROR" };
        }
      }
      return { success: false, error: res.stderr || res.error || "Failed to get resolution", code: "RESOLUTION_FAILED" };
    },
  },
  {
    name: "empty_recycle_bin",
    description: "Empty the Windows Recycle Bin. (Requires confirmation).",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "Must set to true to execute", default: false }
      }
    },
    handler: async ({ confirm }) => {
      if (!confirm) {
        return {
          success: false,
          error: "Emptying the recycle bin is a destructive action. You must pass 'confirm: true' to perform this action.",
          code: "CONFIRMATION_REQUIRED"
        };
      }
      const res = await execPowershellAsync(`Clear-RecycleBin -Force -ErrorAction SilentlyContinue`);
      if (res.status === 0) {
        return { success: true, data: { success: true } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to empty recycle bin", code: "RECYCLE_BIN_FAILED" };
    },
  },
  {
    name: "lock_screen",
    description: "Lock the Windows screen (requires user login to unlock).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      try {
        execSync("rundll32.exe user32.dll,LockWorkStation");
        return { success: true, data: { locked: true } };
      } catch (err) {
        return { success: false, error: err.message, code: "LOCK_FAILED" };
      }
    },
  },
  {
    name: "shutdown",
    description: "Shutdown, restart, or sleep the PC. (Requires confirmation).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action: shutdown, restart, sleep, hibernate" },
        delay_seconds: { type: "number", description: "Delay in seconds before action (default: 30)", default: 30 },
        cancel: { type: "boolean", description: "If true, cancel a pending shutdown", default: false },
        confirm: { type: "boolean", description: "Must set to true to execute power action", default: false }
      },
      required: ["action"],
    },
    handler: async ({ action, delay_seconds = 30, cancel = false, confirm }) => {
      if (cancel) {
        try {
          execSync("shutdown /a");
          return { success: true, data: { cancelled: true } };
        } catch (err) {
          return { success: false, error: err.message, code: "SHUTDOWN_CANCEL_FAILED" };
        }
      }

      if (!confirm) {
        return {
          success: false,
          error: `Performing a '${action}' is a destructive action. You must pass 'confirm: true' to perform this action.`,
          code: "CONFIRMATION_REQUIRED"
        };
      }

      switch (action) {
        case "shutdown":
          execSync(`shutdown /s /t ${delay_seconds}`);
          break;
        case "restart":
          execSync(`shutdown /r /t ${delay_seconds}`);
          break;
        case "sleep":
          await execPowershellAsync(`Add-Type -Assembly System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)`);
          break;
        case "hibernate":
          await execPowershellAsync(`Add-Type -Assembly System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Hibernate', $false, $false)`);
          break;
        default:
          return { success: false, error: `Unknown action: ${action}`, code: "INVALID_ACTION" };
      }
      return { success: true, data: { action, delay_seconds } };
    },
  },
];

module.exports = systemAdvancedTools;
