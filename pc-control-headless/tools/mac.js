"use strict";

/**
 * mac.js — macOS implementations of the Win32 input/screenshot tools.
 *
 * Registered only on darwin (see tools.js). Same tool names, schemas and
 * return shapes as the Windows originals so MCP clients need no changes.
 *
 * Needs (one-time, System Settings → Privacy & Security):
 *   - Accessibility: mouse/keyboard injection (CGEventPost) + System Events
 *   - Screen Recording: `screencapture`
 * Without them the OS silently drops events / returns a desktop-wallpaper-only
 * screenshot — the macOS equivalent of a permission error.
 *
 * Coordinates are screen POINTS (Retina pixels = points × backingScaleFactor).
 */

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkPath } = require("../../lib/security");

function runJXA(script, timeout_ms = 10000) {
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script], { timeout: timeout_ms }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || "").trim(), error: err ? (String(stderr || "").trim() || err.message) : "" });
    });
  });
}

const CG = `
ObjC.import('CoreGraphics');
function postEvent(type, x, y, button) {
  var ev = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), button);
  $.CGEventPost(0, ev);
}
function leftClick(x, y) {
  postEvent(1, x, y, 0); postEvent(2, x, y, 0);
}
function rightClick(x, y) {
  postEvent(3, x, y, 1); postEvent(4, x, y, 1);
}
`;

// macOS virtual key codes for named keys.
const KEYCODES = {
  return: 36, enter: 36, tab: 48, space: 49, backspace: 51, delete: 51, del: 51,
  forwarddelete: 117, escape: 53, esc: 53, home: 115, end: 119,
  pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

const MODIFIERS = {
  ctrl: "control down", control: "control down",
  alt: "option down", option: "option down",
  shift: "shift down",
  cmd: "command down", command: "command down", win: "command down", meta: "command down",
};

const macTools = [
  {
    name: "take_screenshot",
    description: "Take a screenshot of the current screen and return it as a base64-encoded PNG, or save it to a file. (macOS: needs Screen Recording permission.)",
    inputSchema: {
      type: "object",
      properties: {
        save_path: { type: "string", description: "Optional: path to save the PNG file. If omitted, returns base64 data." },
      },
    },
    handler: async ({ save_path }) => {
      const tmpFile = save_path || path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
      if (save_path) checkPath(save_path);
      const r = await new Promise((resolve) => {
        execFile("screencapture", ["-x", "-t", "png", tmpFile], { timeout: 25000 }, (err, _o, stderr) =>
          resolve({ ok: !err, error: err ? (String(stderr || "").trim() || err.message) : "" }));
      });
      if (!r.ok || !fs.existsSync(tmpFile)) {
        return { success: false, error: r.error || "Screenshot failed. Grant Screen Recording permission to your terminal in System Settings > Privacy & Security.", code: "SCREENSHOT_FAILED" };
      }
      if (save_path) return { success: true, data: { saved_to: tmpFile, format: "png" } };
      try {
        const imageData = fs.readFileSync(tmpFile);
        try { fs.unlinkSync(tmpFile); } catch {}
        return { success: true, data: { format: "png", base64: imageData.toString("base64"), size_bytes: imageData.length } };
      } catch (err) {
        return { success: false, error: err.message, code: "FILE_READ_FAILED" };
      }
    },
  },
  {
    name: "take_screenshot_region",
    description: "Take a screenshot of a specific region of the screen (instead of the whole screen). (macOS: needs Screen Recording permission.)",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Left edge of region (points)" },
        y: { type: "number", description: "Top edge of region (points)" },
        width: { type: "number", description: "Width of region (points)" },
        height: { type: "number", description: "Height of region (points)" },
        save_path: { type: "string", description: "Optional path to save PNG (returns base64 if omitted)" },
      },
      required: ["x", "y", "width", "height"],
    },
    handler: async ({ x, y, width, height, save_path }) => {
      const tmpFile = save_path || path.join(os.tmpdir(), `region_${Date.now()}.png`);
      if (save_path) checkPath(save_path);
      const r = await new Promise((resolve) => {
        execFile("screencapture", ["-x", "-R", `${x},${y},${width},${height}`, tmpFile], { timeout: 25000 }, (err, _o, stderr) =>
          resolve({ ok: !err, error: err ? (String(stderr || "").trim() || err.message) : "" }));
      });
      if (!r.ok || !fs.existsSync(tmpFile)) {
        return { success: false, error: r.error || "Region capture failed. Grant Screen Recording permission to your terminal.", code: "REGION_CAPTURE_FAILED" };
      }
      if (save_path) return { success: true, data: { saved_to: tmpFile } };
      try {
        const imageData = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        return { success: true, data: { format: "png", base64: imageData.toString("base64"), region: { x, y, width, height } } };
      } catch (err) {
        return { success: false, error: err.message, code: "FILE_READ_FAILED" };
      }
    },
  },
  {
    name: "get_screen_resolution",
    description: "Get the current screen resolution and monitor information (macOS: points plus Retina pixel size).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const r = await runJXA(`
ObjC.import('AppKit');
var screens = $.NSScreen.screens;
var out = [];
for (var i = 0; i < screens.count; i++) {
  var s = screens.objectAtIndex(i);
  var f = s.frame;
  var scale = s.backingScaleFactor;
  out.push({
    width: Math.round(f.size.width),
    height: Math.round(f.size.height),
    pixel_width: Math.round(f.size.width * scale),
    pixel_height: Math.round(f.size.height * scale),
    scale: scale,
    primary: i === 0
  });
}
JSON.stringify({ screen_count: out.length, screens: out });
      `);
      if (!r.ok || !r.stdout) {
        return { success: false, error: r.error || "Failed to get resolution", code: "RESOLUTION_FAILED" };
      }
      try {
        return { success: true, data: JSON.parse(r.stdout) };
      } catch (e) {
        return { success: false, error: "Failed to parse screen resolution JSON", code: "PARSE_ERROR" };
      }
    },
  },
  {
    name: "mouse_click",
    description: "Click the mouse at specific screen coordinates (x, y). Use take_screenshot first to see what's on screen. (macOS: needs Accessibility permission.)",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate (points from left)" },
        y: { type: "number", description: "Y coordinate (points from top)" },
        button: { type: "string", description: "Button: left, right (default: left)", default: "left" },
      },
      required: ["x", "y"],
    },
    handler: async ({ x, y, button = "left" }) => {
      const r = await runJXA(`${CG}\n${button === "right" ? "rightClick" : "leftClick"}(${Number(x)}, ${Number(y)});\n'ok';`);
      if (r.ok) return { success: true, data: { action: `${button} click`, x, y } };
      return { success: false, error: r.error || "Mouse click failed. Grant Accessibility permission to your terminal.", code: "MOUSE_CLICK_FAILED" };
    },
  },
  {
    name: "mouse_double_click",
    description: "Double-click the mouse at specific screen coordinates. (macOS: needs Accessibility permission.)",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate (points)" },
        y: { type: "number", description: "Y coordinate (points)" },
      },
      required: ["x", "y"],
    },
    handler: async ({ x, y }) => {
      const r = await runJXA(`${CG}\nleftClick(${Number(x)}, ${Number(y)});\ndelay(0.06);\nleftClick(${Number(x)}, ${Number(y)});\n'ok';`);
      if (r.ok) return { success: true, data: { action: "double click", x, y } };
      return { success: false, error: r.error || "Mouse double click failed. Grant Accessibility permission to your terminal.", code: "MOUSE_DOUBLE_CLICK_FAILED" };
    },
  },
  {
    name: "mouse_move",
    description: "Move the mouse cursor to specific screen coordinates without clicking. (macOS: needs Accessibility permission.)",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate (points)" },
        y: { type: "number", description: "Y coordinate (points)" },
      },
      required: ["x", "y"],
    },
    handler: async ({ x, y }) => {
      const r = await runJXA(`${CG}\npostEvent(5, ${Number(x)}, ${Number(y)}, 0);\n'ok';`);
      if (r.ok) return { success: true, data: { action: "move", x, y } };
      return { success: false, error: r.error || "Mouse move failed. Grant Accessibility permission to your terminal.", code: "MOUSE_MOVE_FAILED" };
    },
  },
  {
    name: "get_mouse_position",
    description: "Get the current mouse cursor position on screen.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const r = await runJXA(`
ObjC.import('AppKit');
var loc = $.NSEvent.mouseLocation;
var h = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
JSON.stringify({ x: Math.round(loc.x), y: Math.round(h - loc.y) });
      `);
      if (!r.ok || !r.stdout) {
        return { success: false, error: r.error || "Failed to get mouse position", code: "GET_MOUSE_POS_FAILED" };
      }
      try {
        return { success: true, data: JSON.parse(r.stdout) };
      } catch (e) {
        return { success: false, error: "Failed to parse mouse position JSON", code: "PARSE_ERROR" };
      }
    },
  },
  {
    name: "keyboard_type",
    description: "Type text as if using the keyboard. The text will be typed into whichever window is currently focused. (macOS: needs Accessibility permission.)",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
      },
      required: ["text"],
    },
    handler: async ({ text }) => {
      const r = await runJXA(`var se = Application('System Events');\nse.keystroke(${JSON.stringify(String(text))});\n'ok';`);
      if (r.ok) return { success: true, data: { typed_chars: String(text).length } };
      return { success: false, error: r.error || "Typing failed. Grant Accessibility permission to your terminal.", code: "KEYBOARD_TYPE_FAILED" };
    },
  },
  {
    name: "key_press",
    description: "Press a key or key combination, e.g. 'enter', 'tab', 'escape', 'up', 'cmd+c', 'ctrl+shift+t', 'cmd+space'. (macOS: needs Accessibility permission.)",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key or combo to press (e.g. 'enter', 'ctrl+c', 'cmd+shift+t', 'f5')" },
      },
      required: ["key"],
    },
    handler: async ({ key }) => {
      const parts = String(key).toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
      const base = parts.pop();
      const using = parts.map((p) => MODIFIERS[p]).filter(Boolean).map((m) => JSON.stringify(m));
      const usingOpt = using.length ? `, { using: [${using.join(", ")}] }` : "";
      let body;
      if (KEYCODES[base] !== undefined) {
        body = `se.keyCode(${KEYCODES[base]}${usingOpt});`;
      } else if ([...base].length === 1) {
        body = `se.keystroke(${JSON.stringify(base)}${usingOpt});`;
      } else {
        return { success: false, error: `Unsupported key: ${base} (use a single character, or one of: ${Object.keys(KEYCODES).join(", ")})`, code: "KEY_PRESS_FAILED" };
      }
      const r = await runJXA(`var se = Application('System Events');\n${body}\n'ok';`);
      if (r.ok) return { success: true, data: { key_pressed: key } };
      return { success: false, error: r.error || "Failed to press key. Grant Accessibility permission to your terminal.", code: "KEY_PRESS_FAILED" };
    },
  },
];

module.exports = { macTools };
