/**
 * relay-server/keys.js — Key hashing + scope helpers for the relay.
 *
 * API keys are NEVER stored or transmitted in plaintext. Each key is stored
 * as a scrypt hash (salt + derived key), which is enough to verify a
 * presented key without ever persisting the key itself.
 */

"use strict";

const crypto = require("crypto");

// A brand new API key. The plaintext is only ever shown to the human/admin
// at creation time; the server stores only its hash.
function newKeyBytes(byteLength) {
  return crypto.randomBytes(byteLength || 24).toString("base64url");
}

// scrypt hash a key. Returns { salt, hash } as hex strings.
function hashKey(key, N) {
  const salt = crypto.randomBytes(16);
  const keyBuf = Buffer.from(String(key || ""), "utf8");
  const cost = N || 16384;
  const derived = crypto.scryptSync(keyBuf, salt, 64, { N: cost, r: 8, p: 1 });
  return {
    salt: salt.toString("hex"),
    hash: derived.toString("hex"),
    cost,
  };
}

// Constant-time verification of a presented key against a stored hash.
function verifyKey(key, saltHex, hashHex) {
  try {
    if (!key || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, "hex");
    const stored = Buffer.from(hashHex, "hex");
    const derived = crypto.scryptSync(Buffer.from(String(key), "utf8"), salt, stored.length, {
      N: 16384,
      r: 8,
      p: 1,
    });
    return derived.length === stored.length && crypto.timingSafeEqual(derived, stored);
  } catch {
    return false;
  }
}

// All available scopes for the tool set.
const FULL_SCOPES = [
  "pc:file:read",
  "pc:file:write",
  "pc:file:list",
  "pc:process:run",
  "pc:process:list",
  "pc:process:kill",
  "pc:ui:click",
  "pc:ui:type",
  "pc:ui:screenshot",
  "pc:ui:scroll",
  "pc:qa:screenshot",
  "pc:keyboard:type",
  "pc:keyboard:hotkey",
  "pc:mouse:click",
  "pc:mouse:move",
  "pc:network:nslookup",
  "pc:clipboard:read",
  "pc:clipboard:write",
  "pc:notification:show",
  "pc:audio:control",
  "pc:memory:read",
  "pc:memory:write",
  "pc:git:read",
  "pc:git:write",
];

// Normalize arbitrary scope input (array or comma string) into a clean array.
function normalizeScopes(input) {
  const arr = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [];
  const seen = new Set();
  return arr
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0)
    .filter((s) => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });
}

module.exports = {
  newKeyBytes,
  hashKey,
  verifyKey,
  FULL_SCOPES,
  normalizeScopes,
};
