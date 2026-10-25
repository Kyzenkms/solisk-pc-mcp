"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { summarizeCsv, runDemo } = require("../examples/first-win");
const fs = require("node:fs");
const path = require("node:path");

test("first-win demo produces a deterministic expense report", () => {
  const report = summarizeCsv([
    "item,category,amount_cents",
    "A,Software,1200",
    "B,Travel,300",
  ].join("\n"));
  assert.match(report, /\| Software \| \$12\.00 \|/);
  assert.match(report, /\| Travel \| \$3\.00 \|/);
  assert.match(report, /\*\*Total: \$15\.00\*\*/);
});

test("launch film is the checked-in interactive Brand Film (3) asset", () => {
  const film = fs.readFileSync(path.join(__dirname, "..", "assets", "launch", "solisk-brand-film.html"), "utf8");
  assert.match(film, /<title>PC Control MCP - Brand Film<\/title>/);
  assert.match(film, /id="pp"/);
  assert.match(film, /id="sk"/);
  assert.match(film, /Highlights/);
  assert.match(film, /chat|tool/i);
  assert.ok(film.length > 35000, "Brand Film (3) should not be replaced by the shorter variant");
});

test("first-win demo completes the local MCP workflow", { timeout: 20000 }, async () => {
  const output = [];
  const report = await runDemo({ write: (line) => output.push(line) });
  assert.match(report, /Expense summary/);
  assert.ok(output.some((line) => line.includes("Connected; read_file and write_file discovered")));
  assert.ok(output.some((line) => line.includes("outside the allowed folder: denied")));
  assert.equal(output.at(-1), "Demo files and temporary credentials removed.");
});
