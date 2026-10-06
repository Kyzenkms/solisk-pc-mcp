"use strict";
/* devices.js — remembered browsers for the web console.
   A device token (random 32 bytes, sha256 stored, 0600 file) is set as an
   httpOnly cookie after the owner explicitly ticks "remember". The cookie
   authenticates as owner on /api only. Cap 10 devices, 30-day expiry,
   revocable. Never logged, never returned after issue. */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_DEVICES = 10;
const TTL_MS = 30 * 24 * 3600 * 1000;

function devicesPath() {
  const cfgPath = process.env.MCP_CONFIG_PATH || path.join(__dirname, "..", "config.json");
  return path.join(path.dirname(cfgPath), "devices.json");
}

function loadAll() {
  try {
    const raw = fs.readFileSync(devicesPath(), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveAll(list) {
  try {
    fs.writeFileSync(devicesPath(), JSON.stringify(list), { mode: 0o600 });
    try { fs.chmodSync(devicesPath(), 0o600); } catch {}
  } catch {}
}

function prune(list) {
  const now = Date.now();
  return list.filter((d) => d && d.hash && now - (d.created || 0) < TTL_MS);
}

function listDevices() {
  const list = prune(loadAll());
  return list.map(({ hash, ...pub }) => pub);
}

function issueDevice(label) {
  let list = prune(loadAll());
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const entry = {
    id: "dev-" + crypto.randomBytes(4).toString("hex"),
    hash,
    label: String(label || "browser").slice(0, 80),
    created: Date.now(),
    lastSeen: Date.now(),
  };
  list.push(entry);
  while (list.length > MAX_DEVICES) list.shift();
  saveAll(list);
  return { token, id: entry.id };
}

function verifyDevice(token) {
  if (!token || typeof token !== "string") return null;
  const hash = crypto.createHash("sha256").update(token.trim()).digest("hex");
  const list = loadAll();
  let hit = null;
  for (const d of list) {
    if (!d || !d.hash || d.hash.length !== hash.length) continue;
    try {
      if (crypto.timingSafeEqual(Buffer.from(d.hash), Buffer.from(hash))) { hit = d; break; }
    } catch {}
  }
  if (!hit) return null;
  if (Date.now() - (hit.created || 0) > TTL_MS) {
    saveAll(prune(list));
    return null;
  }
  hit.lastSeen = Date.now();
  saveAll(list);
  return { id: hit.id, label: hit.label };
}

function revokeDevice(id) {
  const list = loadAll();
  const kept = list.filter((d) => d && d.id !== id);
  if (kept.length === list.length) return false;
  saveAll(kept);
  return true;
}

function parseCookies(req) {
  const out = {};
  const hdr = req.headers && req.headers.cookie;
  if (!hdr) return out;
  for (const part of String(hdr).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

module.exports = {
  COOKIE_NAME: "pc_device",
  TTL_MS,
  listDevices,
  issueDevice,
  verifyDevice,
  revokeDevice,
  parseCookies,
};
