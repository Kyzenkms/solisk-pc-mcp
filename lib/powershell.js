const { spawnSync, spawn } = require("child_process");

// Decode PowerShell's CLIXML-escaped control characters (_x000D__x000A_ etc.)
function decodePsEscapes(s) {
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Strip PowerShell CLIXML noise from stderr, keeping only genuine error text.
 * CLIXML is an XML blob from PowerShell like:
 *   #< CLIXML ... <Objs>...<Obj S="progress">...</Obj><Obj S="Error">MSG</Obj>...</Objs>
 * We extract text from every <Obj> whose stream is an error/serialized record and
 * ignore progress / informational records so successful commands don't "fail" on noise.
 */
function cleanCLIXML(s) {
  if (!s || !s.includes("CLIXML")) return s;

  const errors = [];
  // Real PS errors/records are <S S="Error">text</S> (or Warning/Verbose) elements.
  const sRe = /<S\s+S="([^"]+)"[^>]*>([\s\S]*?)<\/S>/g;
  let m;
  while ((m = sRe.exec(s)) !== null) {
    const stream = m[1].toLowerCase();
    const body = m[2].replace(/<[^>]+>/g, "").trim();
    if (!body || /progress|preparing modules|module loaded/i.test(body)) continue;
    if (stream === "error" || stream === "warning" || stream === "fatalerror") {
      errors.push(body);
    }
  }

  // Also catch whole <Obj S="..."> records that carry serialized payload text.
  if (!errors.length) {
    const objRe = /<Obj[^>]*\bS="([^"]*)"[^>]*>([\s\S]*?)<\/Obj>/g;
    while ((m = objRe.exec(s)) !== null) {
      const stream = m[1].toLowerCase();
      const body = m[2].replace(/<[^>]+>/g, "").trim();
      if (!body || /progress|preparing modules|module loaded/i.test(body)) continue;
      if (stream === "error" || stream === "" || stream.includes("serialized") || stream === "objs") {
        errors.push(body);
      }
    }
  }

  // Fallback: if the regexes matched nothing structurally, strip tags crudely
  // but drop progress/module-loading noise lines.
  if (!errors.length) {
    const stripped = s
      .replace(/#< CLIXML|<\/?[A-Za-z][^>]*>/g, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/preparing modules|progress|module loaded/i.test(l))
      .join("\n");
    return stripped;
  }
  return errors.join("\n");
}

/**
 * Execute a PowerShell script safely by encoding it in UTF-16LE + Base64
 * and passing it via -EncodedCommand. This bypasses cmd.exe parsing entirely.
 *
 * NOTE: This is the synchronous (blocking) variant. For commands that may run
 * longer than ~1-2s prefer execPowershellAsync so the Node event loop (and the
 * relay / HTTP / WebSocket server) keeps responding.
 *
 * @param {string} script The PowerShell script text to execute.
 * @param {object} options child_process options (cwd, timeout, etc.)
 * @returns {object} { stdout, stderr, status, error }
 */
function execPowershell(script, options = {}) {
  const sanitizedScript = `$ProgressPreference = 'SilentlyContinue';\n${script}`;
  const buffer = Buffer.from(sanitizedScript, "utf16le");
  const base64 = buffer.toString("base64");

  const timeout = options.timeout_ms || options.timeout || 15000;
  const cwd = options.cwd || process.cwd();

  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", base64], {
    cwd,
    timeout,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024, // 20MB
    ...options
  });

  // Handle timeout or orphaned process tree cleanup
  if (res.error && res.error.code === "ETIMEDOUT") {
    try {
      if (res.pid) {
        spawnSync("taskkill", ["/F", "/PID", String(res.pid), "/T"], { stdio: "ignore" });
      }
    } catch {}
  }

  return {
    stdout: res.stdout ? res.stdout.trim() : "",
    stderr: cleanCLIXML(decodePsEscapes(res.stderr ? res.stderr.trim() : "")),
    status: res.status !== null ? res.status : (res.error ? 1 : 0),
    error: res.error ? (res.error.code === "ETIMEDOUT" ? "Execution timed out. Child process tree killed." : res.error.message) : null
  };
}

/**
 * Asynchronous (non-blocking) PowerShell execution using child_process.spawn.
 * Because execPowershell uses spawnSync, long-running commands freeze the Node
 * event loop (blocking the relay / HTTP / WebSocket), which makes clients see
 * generic timeouts/errors. Use this for commands that may run >1-2s.
 *
 * @param {string} script
 * @param {object} options { cwd, timeout_ms }
 * @returns {Promise<{stdout,stderr,status,code,error}>}
 */
function execPowershellAsync(script, options = {}) {
  const sanitizedScript = `$ProgressPreference = 'SilentlyContinue';\n${script}`;
  const base64 = Buffer.from(sanitizedScript, "utf16le").toString("base64");
  const timeout = options.timeout_ms || options.timeout || 30000;
  const cwd = options.cwd || process.cwd();

  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", base64], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        spawnSync("taskkill", ["/F", "/PID", String(child.pid), "/T"], { stdio: "ignore" });
      } catch {}
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: cleanCLIXML(decodePsEscapes(stderr.trim())),
        status: 1,
        code: "SPAWN_ERROR",
        error: err.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: cleanCLIXML(decodePsEscapes(stderr.trim())),
        status: timedOut ? 1 : code,
        code: timedOut ? "ETIMEDOUT" : (code === 0 ? 0 : "FAILED"),
        error: timedOut ? "Execution timed out. Child process tree killed." : null,
      });
    });
  });
}

/**
 * Spawn a background PowerShell script using -EncodedCommand.
 */
function spawnPowershellBackground(script, options = {}) {
  const buffer = Buffer.from(script, "utf16le");
  const base64 = buffer.toString("base64");
  const cwd = options.cwd || process.cwd();

  const child = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", base64], {
    cwd,
    detached: true,
    stdio: "ignore",
    ...options
  });
  child.unref();
  return child;
}

module.exports = { execPowershell, execPowershellAsync, spawnPowershellBackground, cleanCLIXML };
