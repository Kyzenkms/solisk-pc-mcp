"use strict";
// build-msi.js — MSI ships rarely; NSIS is the daily path. This temporarily
// flips win.target to ["msi"], runs the standard pack -> stamp -> wrap
// chain, then restores package.json no matter what.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const pkgPath = path.join(__dirname, "package.json");
const original = fs.readFileSync(pkgPath, "utf8");
try {
  const pkg = JSON.parse(original);
  pkg.build.win.target = ["msi"];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  execSync(
    "electron-builder --win --x64 -c.win.signAndEditExecutable=false && node stamp-icon.js && electron-builder --win --x64 --prepackaged dist/win-unpacked",
    { stdio: "inherit", cwd: __dirname, shell: true }
  );
} finally {
  fs.writeFileSync(pkgPath, original);
}
console.log("msi build done; package.json restored");
