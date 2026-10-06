"use strict";

/**
 * events.js — shared event bus. System facts only (runtime, relay, config,
 * keys, tools); UI state stays in the frontend. No Electron imports.
 */

const { EventEmitter } = require("events");

const EVENTS = Object.freeze({
  RUNTIME_UP: "runtime:up",
  RUNTIME_DOWN: "runtime:down",
  RELAY_STATE: "relay:state",
  CONFIG_CHANGED: "config:changed",
  KEYS_CHANGED: "keys:changed",
  TOOL_EXECUTED: "tool:executed",
  TUNNEL_STATE: "tunnel:state",
});

class Bus extends EventEmitter {
  emitState(name, payload) {
    this.emit(name, { ...(payload || {}), at: new Date().toISOString() });
    return true;
  }
}

// Singleton: one bus per process. Separate processes bridge over IPC/HTTP.
const bus = new Bus();
bus.setMaxListeners(50);

module.exports = { bus, EVENTS };
