/**
 * middleware.js — Production-grade Express middleware
 *
 * Includes:
 *   - Structured request logging (JSON to stderr, like a real APM)
 *   - Rate limiting (in-memory, per-IP, sliding window)
 *   - Security headers (Helmet-like, but zero-dep)
 *   - Request ID generation
 *   - Global error handler
 *   - 404 handler
 *   - Graceful shutdown utilities
 */

const crypto = require("crypto");

// ── Request ID ──────────────────────────────────────────────────────────────

function requestIdMiddleware(req, res, next) {
  const id = req.headers["x-request-id"] || crypto.randomUUID();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
}

// ── Structured Logging ───────────────────────────────────────────────────────

const logLevels = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = process.env.LOG_LEVEL || "info";

function log(level, message, meta = {}) {
  if (logLevels[level] > logLevels[currentLevel]) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + "\n");
}

function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, originalUrl } = req;
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  res.on("finish", () => {
    const duration = Date.now() - start;
    const { statusCode } = res;
    log("info", `${method} ${originalUrl} ${statusCode}`, {
      method,
      path: originalUrl,
      status: statusCode,
      duration_ms: duration,
      ip,
      request_id: req.id,
    });
  });

  next();
}

// ── Rate Limiting (in-memory sliding window) ─────────────────────────────────

const rateBuckets = new Map(); // key -> [{ timestamp, count }]

/**
 * Rate limiter using a sliding window algorithm.
 * @param {object} opts
 * @param {number} opts.windowMs  — time window in ms (default 60_000)
 * @param {number} opts.max       — max requests per window (default 120)
 * @param {function} opts.keyFn   — function(req) -> string (default: IP)
 */
function rateLimit(opts = {}) {
  const windowMs = opts.windowMs || 60_000;
  const max = opts.max || 120;
  const keyFn = opts.keyFn || ((req) => req.ip || req.socket.remoteAddress || "anon");

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();

    if (!rateBuckets.has(key)) rateBuckets.set(key, []);
    const bucket = rateBuckets.get(key);

    // Remove entries outside the window
    while (bucket.length > 0 && bucket[0].timestamp < now - windowMs) {
      bucket.shift();
    }

    // Check limit
    const currentCount = bucket.reduce((sum, e) => sum + e.count, 0);
    if (currentCount >= max) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({
        error: "rate_limited",
        error_description: `Too many requests. Max ${max} per ${windowMs / 1000}s.`,
        retry_after: Math.ceil(windowMs / 1000),
      });
    }

    // Record this request
    const lastEntry = bucket[bucket.length - 1];
    if (lastEntry && lastEntry.timestamp > now - 1000) {
      lastEntry.count++;
    } else {
      bucket.push({ timestamp: now, count: 1 });
    }

    // Set rate limit headers
    const remaining = max - (currentCount + 1);
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, remaining));
    res.setHeader("X-RateLimit-Reset", Math.ceil((now + windowMs) / 1000));

    next();
  };
}

// Clean up expired buckets periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    while (bucket.length > 0 && bucket[0].timestamp < now - 120_000) bucket.shift();
    if (bucket.length === 0) rateBuckets.delete(key);
  }
}, 60_000).unref();

// ── Security Headers ─────────────────────────────────────────────────────────

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Powered-By", "PC-Control-MCP-Pro");
  // Don't set CSP on /mcp because SSE/streaming needs inline
  if (!req.path.startsWith("/mcp")) {
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;");
  }
  next();
}

// ── Global Error Handler ────────────────────────────────────────────────────

function errorHandler(err, req, res, _next) {
  log("error", "Unhandled error", {
    error: err.message,
    stack: err.stack,
    request_id: req.id,
    path: req.originalUrl,
    method: req.method,
  });

  // Don't leak stack traces in production
  const isDev = process.env.NODE_ENV !== "production";
  const response = {
    error: "internal_server_error",
    error_description: isDev ? err.message : "An unexpected error occurred.",
    request_id: req.id,
  };

  if (isDev) response.stack = err.stack;

  res.status(err.status || 500).json(response);
}

// ── 404 Handler ───────────────────────────────────────────────────────────────

function notFoundHandler(req, res) {
  res.status(404).json({
    error: "not_found",
    error_description: `Route not found: ${req.method} ${req.originalUrl}`,
    request_id: req.id,
  });
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

function setupGracefulShutdown(server, label = "server") {
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `Received ${signal}, shutting down ${label} gracefully...`);

    server.close(() => {
      log("info", `${label} closed successfully`);
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => {
      log("error", `${label} forced shutdown after timeout`);
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // NOTE: SIGHUP intentionally NOT handled — when run as a background
  // daemon or via `start /b`, SIGHUP would otherwise kill the server.

  process.on("uncaughtException", (err) => {
    log("error", "Uncaught exception", { error: err.message, stack: err.stack });
  });

  process.on("unhandledRejection", (reason) => {
    log("error", "Unhandled rejection", { reason: String(reason) });
  });
}

module.exports = {
  requestIdMiddleware,
  requestLogger,
  rateLimit,
  securityHeaders,
  errorHandler,
  notFoundHandler,
  setupGracefulShutdown,
  log,
};
