"use strict";

/**
 * config-service.js — one settings file per machine.
 * Precedence: --config/env > GUI config (if CLI has none) > CLI default.
 * Existing CLI configs are never overridden. Writes are atomic, validated,
 * and emit CONFIG_CHANGED. Watch() re-emits external edits.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { bus, EVENTS } = require("./events");

function cliDefaultPath() {
  return path.join(os.homedir(), ".config", "pc-control-headless", "config.json");
}

function guiConfigPath() {
  const base = process.env.APPDATA
    || (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Roaming") : null);
  return base ? path.join(base, "pc-control-mcp-desktop", "config.json") : null;
}

/** Resolve which file this process owns. */
function resolveConfigPath(explicit) {
  if (explicit) return explicit;
  const def = cliDefaultPath();
  try {
    if (!fs.existsSync(def)) {
      const gp = guiConfigPath();
      if (gp && fs.existsSync(gp)) return gp; // adopt, don't fork
    }
  } catch {}
  return def;
}

function load(p) {
  const { loadConfig, config } = require("./security");
  loadConfig(); // security reads MCP_CONFIG_PATH — caller sets it to resolved path
  return config;
}

function save(configPath, config) {
  const configRepair = require("./config-repair");
  const { valid, problems } = configRepair.validateConfig(config);
  if (!valid) return { ok: false, problems };
  configRepair.writeConfigAtomic(configPath, config);
  bus.emitState(EVENTS.CONFIG_CHANGED, { path: configPath });
  return { ok: true };
}

let watchedPath = null;

/** Watch the resolved file; external edits arrive as events. */
function watch(configPath, onChange) {
  unwatch();
  watchedPath = configPath;
  const handler = () => {
    try {
      const { loadConfig } = require("./security");
      loadConfig();
    } catch {}
    bus.emitState(EVENTS.CONFIG_CHANGED, { path: configPath, external: true });
    if (typeof onChange === "function") { try { onChange(); } catch {} }
  };
  try { fs.watch(configPath, handler); } catch {}
  try { fs.watchFile(configPath, { interval: 2000 }, handler); } catch {}
  return () => unwatch();
}

function unwatch() {
  if (watchedPath) { try { fs.unwatchFile(watchedPath); } catch {} watchedPath = null; }
}

module.exports = {
  resolveConfigPath,
  cliDefaultPath,
  guiConfigPath,
  load,
  save,
  watch,
  unwatch,
};
