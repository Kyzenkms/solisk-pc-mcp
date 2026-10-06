"use strict";
/* Web dashboard: same Overview data as the desktop GUI, read-only plus tailnet. */
const $ = (id) => document.getElementById(id);
const store = window.sessionStorage;

const baseEl = $("base"), keyEl = $("key");
baseEl.value = store.getItem("pcc.base") || window.location.origin;
if (store.getItem("pcc.key")) keyEl.value = store.getItem("pcc.key");

let timer = null;

function fail(msg) {
  const e = $("err");
  e.textContent = msg;
  e.hidden = false;
  $("liveDot").className = "dot bad";
}

function clearFail() {
  $("err").hidden = true;
  $("liveDot").className = "dot on";
}

async function api(path, method) {
  const base = baseEl.value.replace(/\/+$/, "");
  let r;
  try {
    r = await fetch(base + path, {
      method: method || "GET",
      headers: { authorization: "Bearer " + keyEl.value },
    });
  } catch {
    const e = new Error("Server unreachable at " + base + " — is it running there?");
    e.code = "DOWN";
    throw e;
  }
  if (r.status === 401 || r.status === 403) {
    const e = new Error("Key refused — paste the owner API key and press Connect.");
    e.code = "KEY";
    throw e;
  }
  if (!r.ok) throw new Error("HTTP " + r.status + " on " + path);
  return r.json();
}

function fmtUptime(s) {
  if (typeof s !== "number") return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 48) return Math.floor(h / 24) + "d " + (h % 24) + "h";
  return h + "h " + m + "m";
}

function setBadge(id, live, text) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("live", !!live);
}

let allTools = [];

function renderTools(filter) {
  const box = $("tools");
  const q = (filter || "").toLowerCase();
  const list = allTools.filter((t) => t.name.toLowerCase().includes(q));
  $("toolCount").textContent = list.length + " / " + allTools.length;
  if (!list.length) { box.innerHTML = '<p class="empty">No tools match.</p>'; return; }
  box.innerHTML = "";
  for (const t of list) {
    const d = document.createElement("div");
    d.className = "tool";
    const b = document.createElement("b");
    b.textContent = t.name;
    const s = document.createElement("span");
    s.textContent = t.scope || "";
    d.append(b, s);
    box.append(d);
  }
}

function copyText(text, done) {
  const t = document.createElement("textarea");
  t.value = text;
  document.body.appendChild(t);
  t.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(t);
  if (done) done();
}

async function refresh() {
  if (!$("dash") || !$("heroH") || !$("uTs")) {
    throw new Error("Dashboard files mismatched (stale cache) — hard-refresh: Ctrl+Shift+R.");
  }  const [status, metrics, tailscale, tunnel] = await Promise.all([
    api("/status").catch(() => null),
    api("/metrics").catch(() => null),
    api("/tailscale").catch(() => null),
    api("/tunnel").catch(() => null),
  ]);
  if (!status) {
    const err = await api("/status").catch((e) => e);
    throw err instanceof Error ? err : new Error("Server unreachable — is it running on " + baseEl.value + "?");
  }
  clearFail();
  $("dash").hidden = false;
  $("hint").hidden = true;

  const port = status.port || 3000;
  $("heroH").textContent = "Your MCP server is live";
  $("heroSub").textContent = `Listening on port ${port} · ${status.tools ?? "?"} capabilities available · ${status.sessions ?? 0} active sessions`;
  $("heroPort").textContent = port;
  $("heroTools").textContent = status.tools ?? "—";
  $("heroSess").textContent = status.sessions ?? 0;

  $("mUp").textContent = fmtUptime(status.uptime_seconds);
  $("mAppr").textContent = status.approval || "?";

  const relay = status.relay && status.relay.state === "connected"
    ? `${status.relay.room} @ ${status.relay.domain}` : (status.relay ? status.relay.state : "—");
  $("mRelay").textContent = relay;
  const tunUrl = (tunnel && tunnel.url) || "";
  $("mTun").textContent = !tunnel || tunnel.kind === "off" ? "off" : tunUrl ? "live" : tunnel.kind;

  const base = baseEl.value.replace(/\/+$/, "");
  const mcpLocal = `http://localhost:${port}/mcp`;
  if (status.relay && status.relay.state === "connected" && status.relay.room && status.relay.domain) {
    $("uRelay").textContent = `https://${status.relay.domain}/mcp/${status.relay.room}`;
    setBadge("sRelay", true, "Live");
  } else {
    $("uRelay").textContent = mcpLocal;
    setBadge("sRelay", !!(status.relay && status.relay.state !== "idle"), (status.relay && status.relay.state) || "Local");
  }

  if (tunUrl) { $("uTun").textContent = tunUrl + "/mcp"; setBadge("sTun", true, "Live"); }
  else { $("uTun").textContent = !tunnel || tunnel.kind === "off" ? "Off — nothing exposed." : "Starting…"; setBadge("sTun", false, (!tunnel || tunnel.kind === "off") ? "Off" : "Waiting"); }

  const tsUrl = (tailscale && tailscale.url) || (tailscale && tailscale.loggedIn && `https://${tailscale.dns}`) || "";
  if (tsUrl && tailscale.url) { $("uTs").textContent = tsUrl + "/dashboard"; setBadge("sTs", true, "Serving"); }
  else if (tsUrl) { $("uTs").textContent = tsUrl; setBadge("sTs", false, "Idle"); }
  else { $("uTs").textContent = "Not serving — hit Serve."; setBadge("sTs", false, "Off"); }

  $("uSelf").textContent = base + "/dashboard";

  try {
    const tools = await api("/tools");
    if (Array.isArray(tools.tools)) {
      allTools = tools.tools.slice().sort((a, b) => a.name.localeCompare(b.name));
      renderTools($("toolFilter").value);
    }
  } catch { /* count only */ }

  try {
    const logs = await api("/logs?lines=60");
    if (logs && Array.isArray(logs.lines)) $("logs").textContent = logs.lines.join("\n") || "(empty)";
  } catch { /* leave placeholder */ }
}

document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => {
  const el = $(b.dataset.copy);
  if (!el) return;
  copyText(el.textContent, () => {
    const old = b.textContent;
    b.textContent = "Copied";
    setTimeout(() => { b.textContent = old; }, 1200);
  });
}));

$("tsServe").addEventListener("click", async () => {
  try {
    const r = await api("/tailscale/serve", "POST");
    if (r && !r.ok) fail("Serve failed: " + (r.error || "unknown"));
    else refresh().catch(() => {});
  } catch (e) { fail(e.message); }
});

$("tsOff").addEventListener("click", async () => {
  try { await api("/tailscale/off", "POST"); refresh().catch(() => {}); }
  catch (e) { fail(e.message); }
});

$("keyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  store.setItem("pcc.base", baseEl.value.replace(/\/+$/, ""));
  store.setItem("pcc.key", keyEl.value);
  if (timer) clearInterval(timer);
  refresh().then(() => { timer = setInterval(() => refresh().catch(() => {}), 5000); }).catch(fail);
});

$("forget").addEventListener("click", () => {
  store.removeItem("pcc.key");
  keyEl.value = "";
  if (timer) clearInterval(timer);
  timer = null;
});

$("toolFilter").addEventListener("input", (e) => renderTools(e.target.value));

if (store.getItem("pcc.key")) {
  refresh().then(() => { timer = setInterval(() => refresh().catch(() => {}), 5000); }).catch(() => {});
}
