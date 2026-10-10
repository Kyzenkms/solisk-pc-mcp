"use strict";
// stamp-icon.js — electron-builder 25 silently skips its exe-icon step here
// (broken winCodeSign tool cache), so we stamp the icon ourselves with rcedit
// between the --dir pack and the --prepackaged installer build.
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const exe = path.join(__dirname, "dist", "win-unpacked", "PC Control MCP.exe");
const icon = path.join(__dirname, "assets", "icon.ico");

// Locate the rcedit binary shipped with the npm package (blocking call,
// so the stamp is guaranteed done before the installer wraps the exe).
const pkgDir = (() => {
  let dir = path.dirname(require.resolve("rcedit"));
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dir;
})();
function findBin(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).isDirectory()) {
        const hit = findBin(p);
        if (hit) return hit;
      } else if (/rcedit-x64\.exe$/i.test(f)) return p;
    } catch {}
  }
  return null;
}
const bin = findBin(pkgDir);
if (!bin) { console.error("rcedit binary not found under", pkgDir); process.exit(1); }

// The packer (and realtime antivirus) can hold the exe briefly after writing
// it — retry into the lock for up to ~2 minutes.
let done = false;
for (let attempt = 1; attempt <= 24 && !done; attempt++) {
  try {
    execFileSync(bin, [exe, "--set-icon", icon], { stdio: "pipe", timeout: 90000 });
    done = true;
  } catch (err) {
    console.log(`icon stamp attempt ${attempt} busy, retrying…`);
    if (attempt === 24) { console.error("icon stamp failed"); process.exit(1); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
}
console.log("icon stamped:", exe);
