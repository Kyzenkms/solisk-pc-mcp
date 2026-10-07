"use strict";

const assert = require("assert");
const { isReadOnlyCommand, shouldRequestApproval } = require("../../lib/permissions");

let passed = 0, failed = 0;
function it(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`); }
}

// [command, expectedAutoApproved]
const CASES = [
  // Genuinely read-only
  ["Get-Date", true],
  ["dir", true],
  ["whoami", true],
  ["$x = Get-Date", true],
  ["Get-Date; Get-Process", true],
  ["Get-ChildItem C:\\ | Select-Object Name", true],
  ["Get-Process | Where-Object { $_.CPU -gt 1 } | Sort-Object CPU | Format-Table", true],
  ["Write-Output hello", true],
  // Chained / piped mutation must NOT be auto-approved (regression: only the first word used to be checked)
  ["Get-Date; Start-Process calc", false],
  ["Get-Item x; calc.exe", false],
  ["Get-Date & calc", false],
  ["Get-Date && calc", false],
  ["Get-Date\nStart-Process calc", false],
  ["ls; rm -r x", false],
  ["Get-ChildItem | Out-File C:\\x.txt", false],
  ["Get-Content a | Export-Csv b", false],
  ["Get-Process | Stop-Process", false],
  ["Get-Process | Where-Object { Start-Process x }", false],
  ["Get-Item x | ForEach-Object { del $_ }", false],
  // Code smuggling / redirection
  ["Get-Date $(calc)", false],
  ["Get-Date `n calc", false],
  ["Get-Date > a.txt", false],
  ["Write-Output (iex 1)", false],
  ["cmd /c del x", false],
  // Destructive verbs that share a safe-looking prefix
  ["Format-Volume -DriveLetter D", false],
  ["Write-EventLog -LogName x", false],
  // Degenerate input
  ["", false],
  [null, false],
  ["   ", false],
];

console.log("\n--- Unit Tests: Approval Modes ---");
for (const [cmd, expected] of CASES) {
  it(`${expected ? "auto-approves" : "asks for"}: ${JSON.stringify(cmd)}`, () => {
    assert.strictEqual(isReadOnlyCommand(cmd), expected);
  });
}

it("turbo never asks", () => assert.strictEqual(shouldRequestApproval("Remove-Item x", "turbo"), false));
it("always asks even for read-only", () => assert.strictEqual(shouldRequestApproval("Get-Date", "always"), true));
it("unknown/empty mode fails closed (asks)", () => {
  assert.strictEqual(shouldRequestApproval("Get-Date", ""), true);
  assert.strictEqual(shouldRequestApproval("Get-Date", "bogus"), true);
});
it("intermediate: asks for chained mutation, skips read-only", () => {
  assert.strictEqual(shouldRequestApproval("Get-Date; Start-Process calc", "intermediate"), true);
  assert.strictEqual(shouldRequestApproval("Get-Date", "intermediate"), false);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
