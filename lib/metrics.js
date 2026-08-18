/**
 * metrics.js — In-memory metrics collection and health endpoint
 *
 * Tracks:
 *   - Request counts per route + status
 *   - Tool invocation counts + success/failure
 *   - Active sessions
 *   - Uptime
 *   - Memory usage
 */

const os = require("os");

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

function recordRequest(method, path, status) {
  metrics.requests.total++;
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
  if (success) metrics.tools.success_count++;
  else metrics.tools.failure_count++;

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
  startTime,
};
