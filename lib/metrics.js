/** metrics.js — request/tool/session counters + weekly persistence. */

const fs = require("fs");
const os = require("os");
const path = require("path");

const startTime = Date.now();

const metrics = {
  requests: {
    total: 0,
    by_method: {},
    by_status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
    by_path: {},
  },
  tools: {
    total_calls: 0,
    by_name: {},
    success_count: 0,
    failure_count: 0,
  },
  sessions: {
    active: 0,
    total_created: 0,
  },
};

// Weekly persistence: totals survive restarts. Last 8 weeks kept.
let weekly = {};
let weeklyLoaded = false;
let lastFlush = 0;

function weekKey(d) {
  d = new Date(d);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const y = d.getFullYear();
  const w = 1 + Math.round(((d - new Date(y, 0, 4)) / 86400000 - 3 + ((new Date(y, 0, 4).getDay() + 6) % 7)) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

function metricsFile() {
  try {
    const cfgPath = process.env.MCP_CONFIG_PATH || path.join(__dirname, "..", "config.json");
    return path.join(path.dirname(cfgPath), "logs", "metrics-weekly.json");
  } catch { return null; }
}

function loadWeekly() {
  if (weeklyLoaded) return;
  weeklyLoaded = true;
  try {
    const f = metricsFile();
    if (f && fs.existsSync(f)) weekly = JSON.parse(fs.readFileSync(f, "utf8")) || {};
  } catch { weekly = {}; }
}

function weekBucket() {
  loadWeekly();
  const k = weekKey(new Date());
  if (!weekly[k]) weekly[k] = { requests: 0, tool_calls: 0, tool_success: 0, tool_failure: 0, sessions_created: 0 };
  return weekly[k];
}

function flushWeekly() {
  const now = Date.now();
  if (now - lastFlush < 30000) return;
  lastFlush = now;
  try {
    const f = metricsFile();
    if (!f) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const keys = Object.keys(weekly).sort().slice(-8);
    const trimmed = {};
    for (const k of keys) trimmed[k] = weekly[k];
    weekly = trimmed;
    fs.writeFileSync(f, JSON.stringify(weekly));
  } catch {}
}

function flushWeeklyNow() {
  lastFlush = 0;
  loadWeekly();
  flushWeekly();
}

function getWeekly() {
  loadWeekly();
  return { this_week: weekKey(new Date()), weeks: weekly };
}

function recordRequest(method, path, status) {
  metrics.requests.total++;
  try { weekBucket().requests++; flushWeekly(); } catch {}
  const methodKey = method.toUpperCase();
  metrics.requests.by_method[methodKey] = (metrics.requests.by_method[methodKey] || 0) + 1;

  const band = status < 300 ? "2xx" : status < 400 ? "3xx" : status < 500 ? "4xx" : "5xx";
  metrics.requests.by_status[band]++;

  // Normalize path (strip IDs)
  const cleanPath = path
    .replace(/\/[a-f0-9_-]{12,}/g, "/:id")
    .replace(/\?.*$/, "");
  metrics.requests.by_path[cleanPath] = (metrics.requests.by_path[cleanPath] || 0) + 1;
}

function recordToolCall(name, success) {
  metrics.tools.total_calls++;
  try {
    const w = weekBucket();
    w.tool_calls++;
    if (success) { metrics.tools.success_count++; w.tool_success++; }
    else { metrics.tools.failure_count++; w.tool_failure++; }
    flushWeekly();
  } catch {
    if (success) metrics.tools.success_count++;
    else metrics.tools.failure_count++;
  }

  if (!metrics.tools.by_name[name]) {
    metrics.tools.by_name[name] = { calls: 0, success: 0, failure: 0 };
  }
  metrics.tools.by_name[name].calls++;
  metrics.tools.by_name[name][success ? "success" : "failure"]++;
}

function setSessionCount(n) {
  metrics.sessions.active = n;
}

function incrementSessionCreated() {
  metrics.sessions.total_created++;
  try { weekBucket().sessions_created++; flushWeekly(); } catch {}
}

function getHealth() {
  const mem = process.memoryUsage();
  const uptime = Date.now() - startTime;

  return {
    status: "ok",
    uptime_seconds: Math.floor(uptime / 1000),
    uptime_human: formatDuration(uptime),
    timestamp: new Date().toISOString(),
    server: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      node_version: process.version,
      pid: process.pid,
    },
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      external_mb: Math.round(mem.external / 1024 / 1024),
    },
    sessions: metrics.sessions,
    requests: {
      total: metrics.requests.total,
      by_status: metrics.requests.by_status,
      by_method: metrics.requests.by_method,
    },
  };
}

function getMetrics() {
  return {
    ...metrics,
    weekly: getWeekly(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    system: {
      cpu_count: os.cpus().length,
      total_ram_gb: (os.totalmem() / 1024 ** 3).toFixed(2),
      free_ram_gb: (os.freemem() / 1024 ** 3).toFixed(2),
      load_avg: os.loadavg(),
    },
  };
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

module.exports = {
  recordRequest,
  recordToolCall,
  setSessionCount,
  incrementSessionCreated,
  getHealth,
  getMetrics,
  getWeekly,
  flushWeeklyNow,
  startTime,
};
