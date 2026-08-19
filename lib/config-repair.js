"use strict";

/**
 * Config durability and repair.
 *
 * The desktop app stores the authoritative config in the per-user data
 * directory. That file holds the generated API key and OAuth credentials, so
 * losing or corrupting it means every connected AI client stops working until
 * the user re-pairs them.
 *
 * This module provides:
 *   - atomic writes, so an interrupted save cannot truncate the live file
 *   - rolling backups taken before each successful write
 *   - recovery from a corrupt file by falling back to the newest good backup
 *   - schema validation and repair of individual bad fields
 *
 * Nothing here talks to Electron, so it can be unit-tested with plain Node.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_BACKUPS = 5;
const BACKUP_DIR_NAME = "config-backups";

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * Field definitions used to validate and repair a config object.
 * `repair` returns a safe replacement when a value is missing or the wrong type.
 *
 * `optional: true` means the field is only corrected when present and malformed;
 * it is never invented. That matters for fields whose "absent" state is
 * meaningful — `relay_enabled` is treated as enabled unless it is exactly
 * `false`, so defaulting it here would silently disable the relay.
 */
const SCHEMA = {
  name:                { type: "string",  repair: () => "pc-" + crypto.randomBytes(4).toString("hex") },
  api_key:             { type: "string",  repair: () => crypto.randomBytes(24).toString("hex"), secret: true },
  oauth_client_id:     { type: "string",  repair: () => "client_" + crypto.randomBytes(8).toString("hex") },
  oauth_client_secret: { type: "string",  repair: () => "secret_" + crypto.randomBytes(16).toString("hex"), secret: true },
  port:                { type: "number",  repair: () => 3000, validate: (v) => Number.isInteger(v) && v > 0 && v < 65536 },
  autostart:           { type: "boolean", repair: () => true },
  // Must match the modes implemented in lib/permissions.js.
  permission_mode:     { type: "string",  repair: () => "always", validate: (v) => ["always", "intermediate", "turbo"].includes(v) },
  allowed_paths:       { type: "array",   repair: () => [] },
  denied_paths:        { type: "array",   repair: () => ["C:\\Windows\\System32", "C:\\Windows\\SysWOW64"] },
  ready:               { type: "boolean", repair: () => false },
  relay_enabled:       { type: "boolean", repair: () => true,  optional: true },
  relay_domain:        { type: "string",  repair: () => "",    optional: true },
  device_id:           { type: "string",  repair: () => crypto.randomBytes(4).toString("hex"), optional: true },
  rate_limit:          { type: "object",  repair: () => ({ windowMs: 60_000, max: 200 }), optional: true },
};

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * Check a config object against the schema without modifying it.
 * Returns { valid, problems } where each problem names the offending field.
 */
function validateConfig(config) {
  const problems = [];

  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, problems: ["config is not an object"] };
  }

  for (const [field, rule] of Object.entries(SCHEMA)) {
    const value = config[field];

    if (value === undefined) {
      // Optional fields carry meaning by their absence, so a missing one is fine.
      if (!rule.optional) problems.push(`${field} is missing`);
      continue;
    }
    if (typeOf(value) !== rule.type) {
      problems.push(`${field} should be ${rule.type} but is ${typeOf(value)}`);
      continue;
    }
    if (rule.type === "string" && rule.secret && value.trim() === "") {
      problems.push(`${field} is empty`);
      continue;
    }
    if (rule.validate && !rule.validate(value)) {
      problems.push(`${field} has an invalid value`);
    }
  }

  return { valid: problems.length === 0, problems };
}

/**
 * Return a copy of `config` with missing or invalid fields replaced by safe
 * defaults. Unknown fields are preserved so forward-compatible keys survive.
 * Returns { config, repaired } where `repaired` lists the changed fields.
 */
function repairConfig(config) {
  const source = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const result = { ...source };
  const repaired = [];

  for (const [field, rule] of Object.entries(SCHEMA)) {
    const value = result[field];

    // Never invent an optional field: its absence is a meaningful state.
    if (value === undefined && rule.optional) continue;

    const wrongType = value !== undefined && typeOf(value) !== rule.type;
    const emptySecret = rule.secret && typeof value === "string" && value.trim() === "";
    const failsRule = value !== undefined && !wrongType && rule.validate && !rule.validate(value);

    if (value === undefined || wrongType || emptySecret || failsRule) {
      result[field] = rule.repair();
      repaired.push(field);
    }
  }

  return { config: result, repaired };
}

// ── Backups ───────────────────────────────────────────────────────────────────

function backupDir(configPath) {
  return path.join(path.dirname(configPath), BACKUP_DIR_NAME);
}

/**
 * List existing backups, newest first.
 */
function listBackups(configPath) {
  const dir = backupDir(configPath);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("config-") && f.endsWith(".json"))
    .map((f) => {
      const full = path.join(dir, f);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* race with deletion */ }
      return { name: f, path: full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Copy the current config aside, then prune old backups.
 * Only backs up content that parses, so corruption is never archived.
 */
function backupConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;

  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
    JSON.parse(raw);
  } catch {
    return null;
  }

  const dir = backupDir(configPath);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `config-${stamp}.json`);

  // Skip if the newest backup is already identical.
  const existing = listBackups(configPath);
  if (existing.length > 0) {
    try {
      if (fs.readFileSync(existing[0].path, "utf8") === raw) return existing[0].path;
    } catch { /* fall through and write a fresh backup */ }
  }

  fs.writeFileSync(target, raw);

  for (const stale of listBackups(configPath).slice(MAX_BACKUPS)) {
    try { fs.unlinkSync(stale.path); } catch { /* best effort */ }
  }

  return target;
}

// ── Atomic write ──────────────────────────────────────────────────────────────

/**
 * Write config to disk without risking a truncated file.
 *
 * The payload is serialised first (so a circular object throws before the live
 * file is touched), written to a temp file in the same directory, flushed to
 * disk, then renamed over the target. Rename is atomic on NTFS, so a crash
 * leaves either the old file or the new one, never a partial write.
 */
function writeConfigAtomic(configPath, config) {
  const serialised = JSON.stringify(config, null, 2);

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  backupConfig(configPath);

  const temp = `${configPath}.${process.pid}.tmp`;
  const handle = fs.openSync(temp, "w");
  try {
    fs.writeFileSync(handle, serialised);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  fs.renameSync(temp, configPath);
  return configPath;
}

// ── Load with recovery ────────────────────────────────────────────────────────

/**
 * Read the config, recovering from corruption where possible.
 *
 * Resolution order:
 *   1. the config file, if it parses
 *   2. the newest backup that parses, if the file is corrupt
 *   3. a freshly generated config
 *
 * Returns { config, source, recovered, repaired, problems, corruptBackup }.
 * `source` is one of "file", "backup", or "generated". Callers should surface
 * `recovered` or `repaired` to the user, since a new API key means connected
 * clients must be updated.
 */
function loadConfigSafe(configPath) {
  const result = {
    config: null,
    source: null,
    recovered: false,
    repaired: [],
    problems: [],
    corruptBackup: null,
  };

  // 1. Try the live file.
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const check = validateConfig(parsed);
        const fixed = repairConfig(parsed);
        result.config = fixed.config;
        result.source = "file";
        result.repaired = fixed.repaired;
        result.problems = check.problems;
        return result;
      }
      result.problems.push("config is not an object");
    } catch (e) {
      result.problems.push(`config could not be parsed: ${e.message}`);
    }

    // Preserve the damaged file so the user can inspect or salvage it.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const quarantine = path.join(path.dirname(configPath), `config.corrupt-${stamp}.json`);
      fs.copyFileSync(configPath, quarantine);
      result.corruptBackup = quarantine;
    } catch { /* best effort */ }
  }

  // 2. Fall back to the newest usable backup.
  for (const backup of listBackups(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(backup.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

      const fixed = repairConfig(parsed);
      result.config = fixed.config;
      result.source = "backup";
      result.recovered = true;
      result.repaired = fixed.repaired;
      return result;
    } catch { /* try the next backup */ }
  }

  // 3. Nothing usable: generate a fresh config.
  const fresh = repairConfig({});
  result.config = fresh.config;
  result.source = "generated";
  result.repaired = fresh.repaired;
  return result;
}

/**
 * Restore the config from a specific backup, or the newest one when no path is
 * given. The current file is backed up first, so a restore is itself undoable.
 */
function restoreConfig(configPath, backupPath) {
  const backups = listBackups(configPath);
  const chosen = backupPath || (backups[0] && backups[0].path);

  if (!chosen) return { ok: false, error: "No config backups are available." };
  if (!fs.existsSync(chosen)) return { ok: false, error: "That backup no longer exists." };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(chosen, "utf8"));
  } catch (e) {
    return { ok: false, error: `That backup is unreadable: ${e.message}` };
  }

  const { config, repaired } = repairConfig(parsed);
  writeConfigAtomic(configPath, config);

  return { ok: true, config, repaired, restoredFrom: chosen };
}

module.exports = {
  SCHEMA,
  MAX_BACKUPS,
  validateConfig,
  repairConfig,
  listBackups,
  backupConfig,
  writeConfigAtomic,
  loadConfigSafe,
  restoreConfig,
};
