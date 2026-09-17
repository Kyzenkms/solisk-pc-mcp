const { execPowershell, execPowershellAsync, spawnPowershellBackground } = require("../lib/powershell");
const os = require("os");

const SENSITIVE_ENV = /(key|token|secret|password|passwd|credential|cookie|session|auth)/i;
function maskEnvValue(name, value) {
  if (!SENSITIVE_ENV.test(name)) return value;
  const text = String(value);
  return text ? `${text.slice(0, 2)}***${text.slice(-2)}` : "";
}

const shellTools = [
  {
    name: "run_command",
    description:
      "Run a PowerShell command on the Windows PC and return stdout, stderr, and exit code. Use this to run scripts, install packages, query the system, manipulate files via CLI, etc.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The PowerShell command to execute" },
        cwd: { type: "string", description: "Working directory for the command (default: user home)", default: "" },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds before killing the process (default: 30000)",
          default: 30000,
        },
      },
      required: ["command"],
    },
    handler: async ({ command, cwd, timeout_ms = 30000 }) => {
      const workingDir = cwd || os.homedir();
      const { config, loadConfig } = require("../lib/security");
      loadConfig();
      const { shouldRequestApproval } = require("../lib/permissions");

      // Human-in-the-loop approval, controlled by permission_mode:
      //   turbo → never ask · intermediate → auto-approve read-only · always → ask everything
      const mode = config.permission_mode || (config.sandbox_mode === "host" ? "turbo" : "always");
      if (shouldRequestApproval(command, mode) && process.send) {
        const id = Math.random().toString(36).substring(7);
        const approved = await new Promise((resolve) => {
          const onMessage = (msg) => {
            if (msg.type === "shell_approval_res" && msg.id === id) {
              process.removeListener("message", onMessage);
              resolve(msg.approved);
            }
          };
          process.on("message", onMessage);
          process.send({ type: "shell_approval_req", id, command, cwd: workingDir });
          
          // Timeout after 60 seconds
          setTimeout(() => {
            process.removeListener("message", onMessage);
            resolve(false);
          }, 60000);
        });

        if (!approved) {
          return {
            success: false,
            error: "Command execution denied by Human-in-the-Loop sandbox policy.",
            code: "SANDBOX_DENIED"
          };
        }
      }

      // In intermediate mode (auto-approved without human prompt), enforce ConstrainedLanguage mode
      // to prevent reflection/COM/dynamic code execution bypasses.
      const finalCommand = (mode === "intermediate" && !shouldRequestApproval(command, mode))
        ? `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage';\n${command}`
        : command;

      const res = await execPowershellAsync(finalCommand, { cwd: workingDir, timeout_ms });

      // A non-zero exit code (or a real spawn error) marks the command failed.
      // Non-empty stderr alone is NOT a failure: PowerShell emits CLIXML progress
      // noise that was already stripped, and many commands write harmless stderr.
      if (res.status === 0 && !res.error) {
        return {
          success: true,
          data: {
            stdout: res.stdout,
            stderr: res.stderr,
            exit_code: 0,
            cwd: workingDir
          }
        };
      } else {
        return {
          success: false,
          error: res.stderr || res.error || `Command exited with status ${res.status}`,
          code: "COMMAND_EXECUTION_FAILED",
          data: {
            stdout: res.stdout,
            stderr: res.stderr,
            exit_code: res.status,
            cwd: workingDir
          }
        };
      }
    },
  },
  {
    name: "run_command_background",
    description:
      "Start a long-running command in the background without waiting for it to finish. Returns immediately. Useful for starting servers, watches, etc.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The PowerShell command to run in background" },
        cwd: { type: "string", description: "Working directory", default: "" },
      },
      required: ["command"],
    },
    handler: async ({ command, cwd }) => {
      const workingDir = cwd || os.homedir();
      const { config, loadConfig } = require("../lib/security");
      loadConfig();
      const { shouldRequestApproval } = require("../lib/permissions");

      // Human-in-the-loop approval, controlled by permission_mode
      const mode = config.permission_mode || (config.sandbox_mode === "host" ? "turbo" : "always");
      if (shouldRequestApproval(command, mode) && process.send) {
        const id = Math.random().toString(36).substring(7);
        const approved = await new Promise((resolve) => {
          const onMessage = (msg) => {
            if (msg.type === "shell_approval_res" && msg.id === id) {
              process.removeListener("message", onMessage);
              resolve(msg.approved);
            }
          };
          process.on("message", onMessage);
          process.send({ type: "shell_approval_req", id, command, cwd: workingDir, background: true });
          
          setTimeout(() => {
            process.removeListener("message", onMessage);
            resolve(false);
          }, 60000);
        });

        if (!approved) {
          return {
            success: false,
            error: "Background command execution denied by Human-in-the-Loop sandbox policy.",
            code: "SANDBOX_DENIED"
          };
        }
      }

      const finalCommand = (mode === "intermediate" && !shouldRequestApproval(command, mode))
        ? `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage';\n${command}`
        : command;

      try {
        const child = spawnPowershellBackground(finalCommand, { cwd: workingDir });
        return {
          success: true,
          data: {
            pid: child.pid,
            command,
            cwd: workingDir
          }
        };
      } catch (err) {
        return {
          success: false,
          error: err.message,
          code: "SPAWN_BACKGROUND_FAILED"
        };
      }
    },
  },
  {
    name: "get_env",
    description: "Read one or all environment variables from the current process.",
    inputSchema: {
      type: "object",
      properties: {
        variable: {
          type: "string",
          description: "Specific variable name to read. Leave empty to get all variables.",
          default: "",
        },
      },
    },
    handler: async ({ variable = "" }) => {
      if (variable) {
        const val = process.env[variable];
        if (val !== undefined) {
          return {
            success: true,
            data: { variable, value: maskEnvValue(variable, val), redacted: SENSITIVE_ENV.test(variable) }
          };
        } else {
          return {
            success: false,
            error: `Environment variable '${variable}' not found`,
            code: "ENV_VAR_NOT_FOUND"
          };
        }
      }
      return {
        success: true,
      data: { variables: Object.fromEntries(Object.entries(process.env).map(([name, value]) => [name, maskEnvValue(name, value)])), redacted: true }
      };
    },
  },
  {
    name: "set_env",
    description: "Set an environment variable for the current session.",
    inputSchema: {
      type: "object",
      properties: {
        variable: { type: "string", description: "Environment variable name" },
        value: { type: "string", description: "Value to set" },
      },
      required: ["variable", "value"],
    },
    handler: async ({ variable, value }) => {
      process.env[variable] = value;
      return {
        success: true,
        data: { variable, value }
      };
    },
  },
];

module.exports = shellTools;
