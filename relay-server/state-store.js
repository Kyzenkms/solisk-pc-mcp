"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

function createStateStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "relay.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS relay_state (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)");

  const get = db.prepare("SELECT value FROM relay_state WHERE name = ?");
  const getRate = db.prepare("SELECT window_start, count FROM rate_limits WHERE bucket = ?");
  const setRate = db.prepare("INSERT INTO rate_limits(bucket, window_start, count) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = excluded.count");
  const upsert = db.prepare("INSERT INTO relay_state(name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");

  function read(name, fallback) {
    const row = get.get(name);
    if (!row) return fallback;
    try {
      const value = JSON.parse(row.value);
      return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
    } catch (error) {
      console.error(`[relay] Could not decode database state ${name}:`, error.message);
      return fallback;
    }
  }

  function write(values) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      for (const [name, value] of Object.entries(values)) {
        upsert.run(name, JSON.stringify(value), now);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function consumeRate(bucket, now, windowMs, max) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = getRate.get(bucket);
      const active = row && row.window_start > now - windowMs;
      const count = active ? row.count : 0;
      if (count >= max) {
        db.exec("COMMIT");
        return false;
      }
      setRate.run(bucket, active ? row.window_start : now, count + 1);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function pruneRates(cutoff) {
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").run(cutoff);
  }

  function migrateJson(name, file) {
    if (get.get(name) || !fs.existsSync(file)) return null;
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch (error) {
      console.error(`[relay] Could not migrate ${path.basename(file)}:`, error.message);
    }
    return null;
  }

  function close() {
    db.close();
  }

  return { dbPath, read, write, consumeRate, pruneRates, migrateJson, close };
}

module.exports = { createStateStore };
