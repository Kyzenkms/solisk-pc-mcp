/**
 * deploy/monitor/monitor.js — private Solisk dashboard (Tailscale-only).
 *
 * Zero dependencies. Serves a small auto-refreshing page on the box's
 * Tailscale IP with: usage (relay rooms), downloads (npm + GitHub),
 * health (relay, site, endpoint) and host stats. Writes one daily
 * snapshot line so trends survive restarts.
 *
 * Run: pm2 start monitor.js --name solisk-monitor
 */

"use strict";

const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const HOST = process.env.HOST || "100.87.118.68";
const PORT = Number(process.env.PORT || 8770);
const DATA_DIR = path.join(__dirname, "data");
const SNAP_FILE = path.join(DATA_DIR, "snapshots.json");
const DB = process.env.RELAY_DB || "/opt/mcp-relay/data/relay.sqlite";
const RELAY_HEALTH = process.env.RELAY_HEALTH || "http://127.0.0.1:3000/health";
const NPM_PKG = "solisk";
const GH_REPO = "Kyzenkms/solisk-pc-mcp";

fs.mkdirSync(DATA_DIR, { recursive: true });

const cache = {};
function cached(key, ttlMs, fn) {
  const c = cache[key];
  if (c && Date.now() - c.t < ttlMs) return Promise.resolve(c.v);
  return Promise.resolve()
    .then(fn)
    .then((v) => {
      cache[key] = { t: Date.now(), v };
      return v;
    })
    .catch((e) => (c ? c.v : { error: String((e && e.message) || e) }));
}

function get(url, { insecure = false, json = true } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { rejectUnauthorized: !insecure, timeout: 9000, headers: { "user-agent": "solisk-monitor" } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => {
          try {
            resolve(json ? JSON.parse(b) : { status: res.statusCode, body: b });
          } catch {
            resolve({ status: res.statusCode, body: b });
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function rooms() {
  const out = execSync(
    `sqlite3 ${DB} 'SELECT value FROM relay_state WHERE name=char(114,111,111,109,115)'`,
    { encoding: "utf8", timeout: 8000 }
  ).trim();
  const map = out ? JSON.parse(out) : {};
  const now = Date.now();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const list = Object.values(map).map((r) => ({
    code: r.code || "?",
    keys: Array.isArray(r.keys) ? r.keys.length : 0,
    updatedAt: r.updatedAt || 0,
  }));
  return {
    total: list.length,
    active24h: list.filter((r) => now - r.updatedAt < 86400e3).length,
    activeToday: list.filter((r) => r.updatedAt >= midnight.getTime()).length,
    last: list.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
  };
}

function host() {
  const df = execSync("df -k / | tail -1", { encoding: "utf8" }).trim().split(/\s+/);
  return {
    load1: Number(os.loadavg()[0].toFixed(2)),
    memUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    diskUsedPct: Math.round((Number(df[2]) / Number(df[1])) * 100),
    uptimeH: Math.round(os.uptime() / 3600),
  };
}

function saveSnapshot(snap) {
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(SNAP_FILE, "utf8"));
  } catch {}
  const today = new Date().toISOString().slice(0, 10);
  all[today] = snap;
  const keys = Object.keys(all).sort().slice(-30);
  const trimmed = {};
  for (const k of keys) trimmed[k] = all[k];
  fs.writeFileSync(SNAP_FILE, JSON.stringify(trimmed, null, 1));
  return trimmed;
}

async function collect() {
  const [npmDay, npmWeek, ghReleases, ghRepo, relay, site, endpoint] = await Promise.all([
    cached("npmDay", 30 * 60e3, () => get(`https://api.npmjs.org/downloads/point/last-day/${NPM_PKG}`)),
    cached("npmWeek", 30 * 60e3, () => get(`https://api.npmjs.org/downloads/point/last-week/${NPM_PKG}`)),
    cached("ghRel", 30 * 60e3, () => get(`https://api.github.com/repos/${GH_REPO}/releases`)),
    cached("ghRepo", 30 * 60e3, () => get(`https://api.github.com/repos/${GH_REPO}`)),
    cached("relay", 30e3, () => get(RELAY_HEALTH)),
    cached("site", 60e3, () => get("https://solisk.org/", { json: false })),
    cached("endpoint", 60e3, () => get("https://mcp.solisk.org/health")),
  ]);

  let ghDownloads = 0;
  let ghAssets = [];
  if (Array.isArray(ghReleases)) {
    for (const rel of ghReleases)
      for (const a of rel.assets || []) {
        ghDownloads += a.download_count || 0;
        ghAssets.push({ name: a.name, count: a.download_count || 0 });
      }
  }

  const roomsData = await cached("rooms", 60e3, () => rooms());
  const snap = {
    dau: roomsData.activeToday ?? 0,
    roomsTotal: roomsData.total ?? 0,
    npmDay: npmDay.downloads ?? 0,
    ghDownloads,
  };
  const snapshots = saveSnapshot(snap);

  return {
    at: new Date().toISOString(),
    usage: roomsData,
    npm: { day: npmDay, week: npmWeek },
    gh: { downloads: ghDownloads, assets: ghAssets, stars: ghRepo.stargazers_count },
    health: {
      relay: { ok: relay.status === "ok", uptime: relay.uptime },
      site: { ok: site.status === 200, code: site.status },
      endpoint: { ok: endpoint.status === "ok", uptime: endpoint.uptime },
    },
    host: await cached("host", 30e3, () => host()),
    snapshots,
  };
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Solisk monitor</title>
<style>
  :root{color-scheme:dark}
  body{background:#070c0d;color:#eaf7f5;font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:0;padding:24px}
  h1{font-size:18px;letter-spacing:8px;font-weight:800;margin:0 0 2px}
  .sub{color:#66e3d3;font-size:11px;letter-spacing:4px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;max-width:1100px}
  .card{background:#0d1618;border:1px solid #1f373a;border-radius:12px;padding:14px 16px}
  .card h2{font-size:11px;letter-spacing:2px;color:#9fc4bf;margin:0 0 8px;font-weight:600}
  .big{font-size:30px;font-weight:800}
  .muted{color:#5d827e;font-size:12px}
  .ok{color:#9ede8a}.bad{color:#e35d6a}
  table{border-collapse:collapse;width:100%;font-size:12px}
  td,th{text-align:left;padding:3px 6px;border-bottom:1px solid #16282b}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
</style></head><body>
<h1>SOLISK</h1><div class="sub">PRIVATE MONITOR · TAILSCALE ONLY</div>
<div class="grid" id="grid">loading…</div>
<script>
function dot(ok){return '<span class="dot" style="background:'+(ok?'#9ede8a':'#e35d6a')+'"></span>'}
function hours(h){return h>=48?(Math.round(h/24)+'d'):h+'h'}
async function tick(){
  const d = await (await fetch('/api/data')).json();
  const upt = d.health.relay.uptime||0;
  document.getElementById('grid').innerHTML = \`
  <div class="card"><h2>DAU — ROOMS ACTIVE TODAY</h2><div class="big">\${d.usage.activeToday}</div>
    <div class="muted">24h: \${d.usage.active24h} · total rooms: \${d.usage.total}</div></div>
  <div class="card"><h2>DOWNLOADS</h2><div class="big">\${d.npm.day.downloads ?? '—'}</div>
    <div class="muted">npm today · week \${d.npm.week.downloads ?? '—'} · GitHub assets \${d.gh.downloads}</div></div>
  <div class="card"><h2>HEALTH</h2>
    <div>\${dot(d.health.relay.ok)}relay (up \${hours(Math.round(upt/3600))})</div>
    <div>\${dot(d.health.site.ok)}solisk.org (HTTP \${d.health.site.code})</div>
    <div>\${dot(d.health.endpoint.ok)}mcp.solisk.org</div></div>
  <div class="card"><h2>HOST</h2><div class="big">\${d.host.load1}</div>
    <div class="muted">load · ram \${d.host.memUsedPct}% · disk \${d.host.diskUsedPct}% · up \${hours(d.host.uptimeH)}</div></div>
  <div class="card" style="grid-column:1/-1"><h2>DAILY SNAPSHOTS</h2>
    <table><tr><th>date</th><th>DAU</th><th>rooms</th><th>npm</th><th>gh dl</th></tr>
    \${Object.entries(d.snapshots).slice(-14).map(([k,v])=>\`<tr><td>\${k}</td><td>\${v.dau}</td><td>\${v.roomsTotal}</td><td>\${v.npmDay}</td><td>\${v.ghDownloads}</td></tr>\`).join('')}
    </table></div>
  <div class="card" style="grid-column:1/-1"><h2>LAST ACTIVE ROOMS</h2>
    <table><tr><th>room</th><th>keys</th><th>last activity</th></tr>
    \${d.usage.last.map(r=>\`<tr><td>\${r.code}</td><td>\${r.keys}</td><td>\${new Date(r.updatedAt).toLocaleString()}</td></tr>\`).join('')}
    </table>
    <div class="muted" style="margin-top:8px">refreshed \${d.at}</div></div>\`;
}
tick(); setInterval(tick, 60000);
</script></body></html>`;

http
  .createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api/data")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(await collect()));
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
      }
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  })
  .listen(PORT, HOST, () => console.log(`solisk monitor on http://${HOST}:${PORT}`));
