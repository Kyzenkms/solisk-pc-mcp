'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let ST = { running:false, tunnelUrl:null, relayUrl:null, relayError:null, toolCount:0, sessionCount:0, serverPort:3000 };
let _apiKeyRaw = '';
let serverActionPending = false;
let onboardingStep = 0;
let onboardingConnection = 'hosted';
let onboardingDeviceId = '';

// ── Tool categories ───────────────────────────────────────────────────────────
const CATS = [
  { id:'fs',    name:'File System',   icon:'<path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>',
    tools:['read_file','write_file','append_file','delete_file','list_dir','move_file','copy_file','file_exists','get_file_info','search_files','read_json','write_json','get_folder_size','patch_file','grep_files','edit_file','str_replace','replace_file_content','grep'] },
  { id:'shell', name:'Shell',         icon:'<path d="M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3zM4 19h16v2H4z"/>',
    tools:['run_command','run_command_background','get_env','set_env'] },
  { id:'sys',   name:'System',        icon:'<path d="M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z"/>',
    tools:['get_system_info','list_processes','kill_process','take_screenshot','get_clipboard','set_clipboard','open_url','open_file','read_screen_text'] },
  { id:'net',   name:'Network',       icon:'<path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/>',
    tools:['http_get','http_post','web_search','ping_host','get_public_ip','get_local_ip','list_network_connections','dns_lookup','list_wifi_networks','get_wifi_password'] },
  { id:'web',   name:'Web Server',    icon:'<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>',
    tools:['serve_directory','stop_server','expose_port','download_file','check_port'] },
  { id:'input', name:'Input Control', icon:'<path d="M20 10H4c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-8c0-1.1-.9-2-2-2zm-9 3h-2v2H7v-2H5v-2h2V9h2v2h2v2zm4.5 3c-.83 0-1.5-.67-1.5-1.5S14.67 13 15.5 13s1.5.67 1.5 1.5S16.33 16 15.5 16zm3-3c-.83 0-1.5-.67-1.5-1.5S17.67 11 18.5 11s1.5.67 1.5 1.5S19.33 13 18.5 13z"/>',
    tools:['mouse_click','mouse_move','mouse_double_click','keyboard_type','key_press','list_windows','focus_window','get_active_window','close_window','get_mouse_position'] },
  { id:'notif', name:'Notifications', icon:'<path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>',
    tools:['show_notification','show_dialog','speak_text','play_sound','set_volume','get_volume'] },
  { id:'mem',   name:'Memory',        icon:'<path d="M12 3C6.48 3 2 6.69 2 11.22c0 2.73 1.54 5.15 3.93 6.65L5 21l3.67-2.12c1.04.29 2.15.44 3.33.44 5.52 0 10-3.69 10-8.22C22 6.69 17.52 3 12 3zm1 11h-2v-2h2v2zm0-4h-2V6h2v4z"/>',
    tools:['memory_set','memory_get','memory_list','memory_delete','memory_clear','memory_append'] },
  { id:'git',   name:'Git',           icon:'<path d="M20.7 7.7l-1.4-1.4-4.3 4.3-1.4-1.4L15 7.8 13.6 6.4l-7 7 1.4 1.4L12 10.8l1.4 1.4L12 13.6l1.4 1.4 4.3-4.3 1.4 1.4L21 10.7l-1.4-1.4.1-1.6z"/>',
    tools:['git_status','git_clone','git_add','git_commit','git_push','git_pull','git_log','git_diff','git_branch','git_init'] },
  { id:'adv',   name:'Advanced',      icon:'<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>',
    tools:['list_installed_apps','get_battery_status','get_disk_usage','get_startup_programs','run_as_admin','schedule_task','take_screenshot_region','get_screen_resolution','empty_recycle_bin','lock_screen','shutdown'] },
  { id:'util',  name:'Utility',       icon:'<path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>',
    tools:['encode_base64','decode_base64','generate_uuid','hash_text','format_json','timestamp_now'] },
];
const TOOL_TOTAL = CATS.reduce((total, category) => total + category.tools.length, 0);
ST.toolCount = TOOL_TOTAL;

// ── Tool state ────────────────────────────────────────────────────────────────
let toolState = {};
(function() {
  try { toolState = JSON.parse(localStorage.getItem('toolState') || '{}'); } catch { toolState = {}; }
  CATS.forEach(c => c.tools.forEach(t => { if (toolState[t] === undefined) toolState[t] = true; }));
})();
function saveTools() { localStorage.setItem('toolState', JSON.stringify(toolState)); }

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const clip = async t => {
  try { await navigator.clipboard.writeText(t); return true; }
  catch { toast('Clipboard access failed', 'e'); return false; }
};

function applyTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = normalized;
  localStorage.setItem('theme', normalized);
  const toggle = $('themeToggle');
  if (toggle) {
    const next = normalized === 'dark' ? 'light' : 'dark';
    toggle.setAttribute('aria-label', `Switch to ${next} mode`);
    toggle.title = `Switch to ${next} mode`;
  }
}

applyTheme(localStorage.getItem('theme') || 'dark');

function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, value => value.toString(16).padStart(2, '0')).join('');
}

function normalizedDeviceName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39);
}

function onboardingRoomName() {
  const baseName = normalizedDeviceName($('onboardingName')?.value);
  return baseName && onboardingDeviceId ? `${baseName}-${onboardingDeviceId}` : baseName;
}

function onboardingEndpoint() {
  const name = onboardingRoomName() || 'your-pc-a3f8b2c1';
  return onboardingConnection === 'hosted'
    ? `https://mcp.solisk.org/mcp/${name}`
    : `http://localhost:3000/mcp`;
}

function refreshOnboarding() {
  document.querySelectorAll('[data-onboarding-panel]').forEach((panel, index) => panel.classList.toggle('on', index === onboardingStep));
  document.querySelectorAll('[data-onboarding-progress]').forEach((step, index) => {
    step.classList.toggle('on', index === onboardingStep);
    step.classList.toggle('done', index < onboardingStep);
  });
  $('onboardingBack').disabled = onboardingStep === 0;
  $('onboardingNext').textContent = onboardingStep === 3 ? 'Finish setup' : 'Continue';
  $('onboardingError').textContent = '';
  const url = onboardingEndpoint();
  $('onboardingUrl').textContent = url;
  $('onboardingReviewConnection').textContent = onboardingConnection === 'hosted' ? 'Hosted beta relay' : 'Local only';
  $('onboardingReviewName').textContent = onboardingRoomName() || 'Not set';
  $('onboardingReviewUrl').textContent = url;
  $('onboardingReviewMode').textContent = $('onboardingMode')?.selectedOptions[0]?.textContent || 'Always ask';
  const pathCount = ($('onboardingPaths')?.value || '').split('\n').map(value => value.trim()).filter(Boolean).length;
  $('onboardingReviewPaths').textContent = pathCount ? `${pathCount} allowed ${pathCount === 1 ? 'path' : 'paths'}` : 'Full access';
  if (onboardingStep === 1) setTimeout(() => $('onboardingName')?.focus(), 0);
}

function showOnboarding(config) {
  onboardingStep = 0;
  onboardingConnection = config.relay_enabled === false ? 'local' : 'hosted';
  onboardingDeviceId = /^[a-f0-9]{8}$/.test(config.device_id || '') ? config.device_id : randomHex(4);
  $('onboardingName').value = normalizedDeviceName(config.name || '');
  $('onboardingMode').value = config.permission_mode || 'always';
  $('onboardingPaths').value = (config.allowed_paths || []).join('\n');
  document.querySelectorAll('[data-connection]').forEach(button => button.classList.toggle('selected', button.dataset.connection === onboardingConnection));
  $('onboarding').classList.add('show');
  refreshOnboarding();
}

async function finishOnboarding() {
  const baseName = normalizedDeviceName($('onboardingName').value);
  if (!baseName) {
    onboardingStep = 1;
    refreshOnboarding();
    $('onboardingError').textContent = 'Enter a device name.';
    return;
  }
  const button = $('onboardingNext');
  button.disabled = true;
  button.textContent = 'Finishing…';
  try {
    const old = await window.mcp.getConfig() || {};
    const apiKey = old.api_key || randomHex(32);
    const oauthClientId = old.oauth_client_id || `client_${randomHex(8)}`;
    const oauthClientSecret = old.oauth_client_secret || `secret_${randomHex(16)}`;
    const name = `${baseName}-${onboardingDeviceId}`;
    const config = {
      ...old,
      name,
      device_id: onboardingDeviceId,
      api_key: apiKey,
      oauth_client_id: oauthClientId,
      oauth_client_secret: oauthClientSecret,
      port: 3000,
      autostart: true,
      ready: true,
      relay_enabled: onboardingConnection === 'hosted',
      relay_domain: onboardingConnection === 'hosted' ? 'mcp.solisk.org' : '',
      permission_mode: $('onboardingMode').value || 'always',
      allowed_paths: $('onboardingPaths').value.split('\n').map(value => value.trim()).filter(Boolean),
    };
    await window.mcp.saveConfig(config);
    _apiKeyRaw = apiKey;
    $('onboarding').classList.remove('show');
    await loadSettings();
    await window.mcp.startServer();
    toast('Setup complete. MCP server starting.', 's');
  } catch (error) {
    $('onboardingError').textContent = error?.message || 'Setup failed. Try again.';
    button.disabled = false;
    button.textContent = 'Finish setup';
  }
}

document.querySelectorAll('[data-connection]').forEach(button => button.addEventListener('click', () => {
  onboardingConnection = button.dataset.connection;
  document.querySelectorAll('[data-connection]').forEach(choice => choice.classList.toggle('selected', choice === button));
  refreshOnboarding();
}));
$('onboardingName')?.addEventListener('input', refreshOnboarding);
$('onboardingMode')?.addEventListener('change', refreshOnboarding);
$('onboardingPaths')?.addEventListener('input', refreshOnboarding);
$('onboardingBack')?.addEventListener('click', () => { if (onboardingStep > 0) { onboardingStep--; refreshOnboarding(); } });
$('onboardingNext')?.addEventListener('click', () => {
  if (onboardingStep === 1 && !normalizedDeviceName($('onboardingName').value)) {
    $('onboardingError').textContent = 'Enter a device name.';
    $('onboardingName').focus();
    return;
  }
  if (onboardingStep < 3) { onboardingStep++; refreshOnboarding(); return; }
  finishOnboarding();
});

function toast(msg, type = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'show' + (type ? ' '+type : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = '', 2800);
}

window.copyEl = function(id) {
  const el = $(id);
  if (!el) return;
  clip('value' in el ? el.value : el.textContent.trim());
  toast('Copied!', 's');
};

window.copyKey = function() {
  if (_apiKeyRaw) { clip(_apiKeyRaw); toast('API key copied!', 's'); }
};

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-button').forEach(btn => {
  const activate = () => {
    document.querySelectorAll('.nav-button').forEach(b => b.classList.remove('on'));
    document.querySelectorAll('.nav-button').forEach(b => b.removeAttribute('aria-current'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
    btn.classList.add('on');
    btn.setAttribute('aria-current', 'page');
    const pg = btn.dataset.page;
    const page = $('pg-' + pg);
    page?.classList.add('on');
    page?.scrollTo({ top: 0, behavior: 'instant' });
    page?.querySelector('h1')?.focus({ preventScroll: true });
    if (pg === 'connect')  renderConnect();
    if (pg === 'tools')    renderTools();
    if (pg === 'logs')     renderLogs();
    if (pg === 'keys')     loadSettings();
    if (pg === 'settings') loadSettings();
  };
  btn.addEventListener('click', activate);
  btn.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
  });
});

// ── Window controls ───────────────────────────────────────────────────────────
$('btnMin')  ?.addEventListener('click', () => window.mcp?.minimize());
$('btnMax')  ?.addEventListener('click', () => window.mcp?.maximize());
$('btnClose')?.addEventListener('click', () => window.mcp?.close());
$('themeToggle')?.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

// ── Apply status ──────────────────────────────────────────────────────────────
function applyStatus(s) {
  if (!s) return;
  ST = { ...ST, ...s };
  const on = ST.running;

  // Titlebar
  $('tbDot')?.classList.toggle('on', on);
  $('tbLive')?.classList.toggle('on', on);
  const tbTxt = $('tbTxt');
  if (tbTxt) tbTxt.textContent = on ? 'Server running' : 'Server stopped';

  // Sidebar pill
  $('srvOrb')?.classList.toggle('on', on);
  $('srvBtn')?.classList.toggle('on', on);
  const srvName = $('srvName'), srvHint = $('srvHint'), srvAct = $('srvAct');
  if (srvName) srvName.textContent = on ? 'Server running' : 'Server stopped';
  if (srvHint) srvHint.textContent = on ? 'Click to stop'  : 'Ready to start';
  if (srvAct)  srvAct.textContent  = on ? '−' : '+';

  // Hero
  const hero = $('heroCard');
  hero?.classList.toggle('on', on);
  const heroH = $('heroH'), heroSub = $('heroSub');
  if (heroH)   heroH.textContent   = on ? 'Your MCP server is live' : 'Your MCP server is stopped';
  if (heroSub) heroSub.textContent = on
    ? `Listening on port ${ST.serverPort} · ${ST.toolCount || TOOL_TOTAL} capabilities available · ${ST.sessionCount || 0} active sessions`
    : 'Click the power button or the sidebar pill to start the MCP server';

  $('heroPort')?.replaceChildren(document.createTextNode(String(ST.serverPort || 3000)));
  $('heroTools')?.replaceChildren(document.createTextNode(String(ST.toolCount || TOOL_TOTAL)));
  $('heroSessions')?.replaceChildren(document.createTextNode(String(ST.sessionCount || 0)));

  // Dashboard toggle btn
  const btnTog = $('btnToggle');
  if (btnTog) btnTog.textContent = on ? 'Stop server' : 'Start server';

  // Stats
  const sTool = $('sTool'), sSess = $('sSess'), sPortStat = $('sPortStat'), sSessSub = $('sSessSub');
  if (sTool)     sTool.textContent     = ST.toolCount     || TOOL_TOTAL;
  if (sSess)     sSess.textContent     = ST.sessionCount  || 0;
  if (sPortStat) sPortStat.textContent = ST.serverPort    || 3000;
  if (sSessSub) {
    const cnt = ST.sessionCount || 0;
    sSessSub.textContent = cnt === 0 ? 'No AI clients connected' : (cnt === 1 ? '1 active session connected' : `${cnt} active sessions connected`);
  }

  // Endpoints
  const epRelay  = $('epRelay');
  const epTunnel = $('epTunnel');
  const epLocal  = $('epLocal');
  const btnRetry = $('btnRetryRelay');

  if (epRelay) {
    if (ST.relayUrl)  {
      epRelay.textContent = ST.relayUrl;
      epRelay.classList.add('live');
      $('relayState')?.replaceChildren(document.createTextNode('Live'));
      if (btnRetry) btnRetry.style.display = 'none';
    }
    else if (ST.relayError && ST.tunnelUrl) {
      epRelay.textContent = 'Hosted relay unavailable — secure tunnel ready';
      epRelay.classList.remove('live');
      $('relayState')?.replaceChildren(document.createTextNode('Fallback'));
      if (btnRetry) btnRetry.style.display = 'inline-block';
    }
    else if (ST.relayError) {
      epRelay.textContent = ST.relayError;
      epRelay.classList.remove('live');
      $('relayState')?.replaceChildren(document.createTextNode('Unavailable'));
      if (btnRetry) btnRetry.style.display = 'inline-block';
    }
    else {
      epRelay.textContent = on ? 'Connecting to relay…' : 'Server not running';
      epRelay.classList.remove('live');
      $('relayState')?.replaceChildren(document.createTextNode(on ? 'Connecting' : 'Offline'));
      if (btnRetry) btnRetry.style.display = on ? 'inline-block' : 'none';
    }
  }
  if (epTunnel) {
    if (ST.tunnelUrl) { epTunnel.textContent = ST.tunnelUrl + '/mcp'; epTunnel.classList.add('live'); $('tunnelState')?.replaceChildren(document.createTextNode('Live')); }
    else              { epTunnel.textContent = on ? 'Waiting for tunnel…' : 'Not connected'; epTunnel.classList.remove('live'); $('tunnelState')?.replaceChildren(document.createTextNode(on ? 'Waiting' : 'Offline')); }
  }
  if (epLocal) epLocal.textContent = `http://localhost:${ST.serverPort || 3000}/mcp`;

  // Refresh connect page content if it's visible
  if (document.querySelector('#pg-connect.on')) renderConnect();
}

window.retryRelayConn = async function() {
  toast('Retrying relay connection…');
  try {
    const res = await window.mcp?.retryRelay();
    if (res && res.status) applyStatus(res.status);
    toast('Reconnection initiated ✓', 's');
  } catch (e) {
    toast('Retry failed: ' + (e?.message || e), 'e');
  }
};

// ── Server toggle ─────────────────────────────────────────────────────────────
async function toggleServer() {
  if (serverActionPending || !window.mcp) return;
  serverActionPending = true;
  setServerControlsBusy(true);
  try {
    if (ST.running) { toast('Stopping server…'); await window.mcp.stopServer(); }
    else            { toast('Starting server…'); await window.mcp.startServer(); }
  } catch (error) {
    toast(error?.message || 'Unable to change server state', 'e');
  } finally {
    serverActionPending = false;
    setServerControlsBusy(false);
  }
}
function setServerControlsBusy(busy) {
  [$('pwrBtn'), $('btnToggle'), $('srvBtn')].forEach(el => {
    if (!el) return;
    el.toggleAttribute('disabled', busy);
    el.setAttribute('aria-busy', String(busy));
  });
  if ($('btnToggle')) $('btnToggle').textContent = busy ? (ST.running ? 'Stopping…' : 'Starting…') : (ST.running ? 'Stop server' : 'Start server');
}
$('pwrBtn')   ?.addEventListener('click', toggleServer);
$('btnToggle')?.addEventListener('click', toggleServer);
$('srvBtn')   ?.addEventListener('click', toggleServer);
$('srvBtn')?.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleServer(); }
});

// ── Endpoint copy ─────────────────────────────────────────────────────────────
$('btnCpRelay')  ?.addEventListener('click', () => {
  const url = ST.relayUrl || (ST.tunnelUrl ? ST.tunnelUrl + '/mcp' : null);
  if (!url) { toast(ST.relayError || 'Relay not connected yet', 'e'); return; }
  clip(url); toast(ST.relayUrl ? 'MCP URL copied!' : 'Hosted relay unavailable. Secure tunnel URL copied.', 's');
});
$('btnCpTunnel') ?.addEventListener('click', () => {
  if (!ST.tunnelUrl) { toast('Tunnel not connected yet', 'e'); return; }
  clip(ST.tunnelUrl + '/mcp'); toast('Tunnel URL copied!', 's');
});
$('btnCpLocal')  ?.addEventListener('click', () => {
  clip(`http://localhost:${ST.serverPort || 3000}/mcp`);
  toast('Local URL copied!', 's');
});

// ── Connect page ──────────────────────────────────────────────────────────────
window.toggleCC = function(id) {
  const card = $(id);
  if (!card) return;
  const wasOpen = card.classList.contains('open');
  document.querySelectorAll('.ccard').forEach(c => c.classList.remove('open'));
  if (!wasOpen) card.classList.add('open');
};

const connectFilters = document.querySelectorAll('.connect-index button');
const connectKinds = { 'cc-claude':'web', 'cc-chatgpt':'web', 'cc-desktop':'desktop', 'cc-cursor':'editor', 'cc-openclaw':'desktop' };
const filterNames = ['all', 'web', 'desktop', 'editor'];
connectFilters.forEach((button, index) => {
  button.dataset.connectFilter = filterNames[index] || 'all';
  if (index === 0) button.textContent = 'All clients';
  button.addEventListener('click', () => {
    const filter = button.dataset.connectFilter;
    document.querySelectorAll('[data-connect-filter]').forEach(item => item.classList.toggle('active', item === button));
    document.querySelectorAll('.connect-card').forEach(card => {
      card.hidden = filter !== 'all' && card.dataset.connectKind !== filter;
    });
  });
});
Object.entries(connectKinds).forEach(([id, kind]) => {
  const card = $(id);
  if (card) card.dataset.connectKind = kind;
});

async function renderConnect() {
  const cfg = (await window.mcp?.getConfig()) || {};
  const domain = (cfg.relay_domain || '').trim().replace(/^https?:\/\//, '');
  const name   = (cfg.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'my-pc';
  const host   = domain ? `https://${domain}` : 'https://mcp.solisk.org';
  const mcpUrl = `${host}/mcp/${name}`;
  const key    = (cfg.api_key || '').trim();

  const relayBase = host;
  const tokenUrl  = `${relayBase}/oauth/token`;
  const authUrl   = `${relayBase}/oauth/authorize`;
  const specUrl   = `${relayBase}/openapi.json`;

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('claudeTokenUrl', tokenUrl);
  set('claudeMcpUrl',   mcpUrl);
  set('chatgptSpecUrl', specUrl);
  set('chatgptAuthUrl', authUrl);
  set('chatgptTokenUrl', tokenUrl);

  const tok = key ? `Bearer ${key}` : 'Bearer <API-KEY>';
  const mcpJson = url => `{\n  "mcpServers": {\n    "pc-control": {\n      "url": "${url}",\n      "headers": {\n        "Authorization": "${tok}"\n      }\n    }\n  }\n}`;
  const cursorJson = url => `{\n  "mcpServers": {\n    "pc-control": {\n      "type": "http",\n      "url": "${url}",\n      "headers": {\n        "Authorization": "${tok}"\n      }\n    }\n  }\n}`;
  set('desktopCfg', mcpJson(mcpUrl));
  set('cursorCfg',  cursorJson(mcpUrl));

  set('openclawCfg', `{\n  "mcp": {\n    "servers": {\n      "pc-control": {\n        "url": "${mcpUrl}",\n        "transport": "streamable-http",\n        "headers": {\n          "Authorization": "${tok}"\n        }\n      }\n    }\n  }\n}`);

  const oc = $('btnOpenClaude');
  if (oc) oc.onclick = () => window.mcp?.openUrl('https://claude.ai');
  const og = $('btnOpenChatGPT');
  if (og) og.onclick = () => window.mcp?.openUrl('https://platform.openai.com');
}

// ── Tools ─────────────────────────────────────────────────────────────────────
let toolQ = '';

function updateToolBadge() {
  const n = Object.values(toolState).filter(Boolean).length;
  const chip = $('toolChip');
  if (chip) chip.textContent = n + ' enabled';
  const badge = $('toolBadge');
  if (badge) badge.textContent = String(n);
}

function renderTools() {
  const container = $('toolList');
  if (!container) return;
  const q = toolQ.toLowerCase();
  container.innerHTML = CATS.map(cat => {
    const filtered = cat.tools.filter(t => !q || t.includes(q));
    if (!filtered.length) return '';
    const enabled = filtered.filter(t => toolState[t]).length;
    return `<div class="tcat ${cat.id === 'fs' ? 'open' : ''}" id="tc-${cat.id}">
      <div class="tcat-hd" onclick="toggleCat('${cat.id}')">
        <svg class="tcat-ico" viewBox="0 0 24 24">${cat.icon}</svg>
        <span class="tcat-nm">${cat.name}</span>
        <span class="tcat-cnt">${enabled}/${filtered.length}</span>
        <div class="tcat-btns" onclick="event.stopPropagation()" aria-label="${cat.name} selection">
          <button class="cat-action" onclick="setCat('${cat.id}',true)" title="Enable every ${cat.name} capability"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg><span>Enable</span></button>
          <button class="cat-action muted" onclick="setCat('${cat.id}',false)" title="Disable every ${cat.name} capability"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8m0-8-8 8"/></svg><span>Disable</span></button>
        </div>
        <svg class="tcat-chev" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
      </div>
      <div class="tcat-bd">
        <div class="tool-grid">
          ${filtered.map(t => `
            <div class="ttag ${toolState[t] ? '' : 'off'}" onclick="toggleTool('${t}','${cat.id}')">
              <div class="mpill"><div class="mpill-t"><div class="mpill-h"></div></div></div>
              <span class="tnm">${t}</span>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
  }).join('');
  updateToolBadge();
}

window.toggleCat  = function(id) { $('tc-'+id)?.classList.toggle('open'); };
window.toggleTool = function(t, catId) {
  toolState[t] = !toolState[t];
  saveTools(); renderTools();
  $('tc-'+catId)?.classList.add('open');
};
window.setCat     = function(catId, enabled) {
  const cat = CATS.find(c => c.id === catId);
  if (!cat) return;
  cat.tools.filter(t => !toolQ || t.includes(toolQ)).forEach(t => toolState[t] = enabled);
  saveTools(); renderTools();
  $('tc-'+catId)?.classList.add('open');
};

$('toolSearch')  ?.addEventListener('input', e => { toolQ = e.target.value.trim(); renderTools(); });
$('btnAllOn')    ?.addEventListener('click', () => { CATS.forEach(c=>c.tools.forEach(t=>toolState[t]=true));  saveTools(); renderTools(); toast('All tools enabled','s'); });
$('btnAllOff')   ?.addEventListener('click', () => { CATS.forEach(c=>c.tools.forEach(t=>toolState[t]=false)); saveTools(); renderTools(); toast('All tools disabled'); });
$('btnSaveTools')?.addEventListener('click', () => { saveTools(); toast('Preferences saved','s'); });

// ── Logs ──────────────────────────────────────────────────────────────────────
let currentLogFilter = 'ALL';
let allLogsCache = [];

window.filterLogs = function(cat) {
  currentLogFilter = cat;
  document.querySelectorAll('.cat-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === cat);
  });
  renderLogs();
};

function renderLogs() {
  window.mcp?.getLogs().then(logs => {
    allLogsCache = logs || [];
    const filtered = currentLogFilter === 'ALL'
      ? allLogsCache
      : allLogsCache.filter(l => (l.category || '').toUpperCase() === currentLogFilter);

    const c = $('logContainer');
    const d = $('dashboardLogs');
    if (!filtered.length) {
      if (c) c.innerHTML = '<div class="log-empty">No activity found for category "' + currentLogFilter + '".</div>';
      if (d) d.innerHTML = '<div class="log-empty">No activity yet. Start the server to see runtime events.</div>';
      return;
    }
    if (d) d.innerHTML = logs.slice(0, 5).map(buildLogRow).join('');
  });
}
function buildLogRow(l) {
  const chips = [];
  if (l.tool)       chips.push(`<span class="log-chip tool">${esc(l.tool)}</span>`);
  if (l.duration_ms != null) chips.push(`<span class="log-chip">${Math.round(l.duration_ms)}ms</span>`);
  if (l.status)     chips.push(`<span class="log-chip ${l.status < 400 ? 'ok' : 'err'}">${esc(l.method || '')} ${l.status}</span>`);
  if (l.success === false) chips.push(`<span class="log-chip err">failed</span>`);
  const chipHtml = chips.length ? `<span class="log-chips">${chips.join('')}</span>` : '';
  return `<div class="log-row">
    <span class="log-ts">${l.time}</span>
    <span class="log-lv ${l.type||'info'}">${(l.type||'INFO').toUpperCase()}</span>
    <span class="log-msg ${l.type==='error'?'err':''}">${esc(l.msg)}${l.error ? ' — <span class="log-err">'+esc(String(l.error))+'</span>' : ''}</span>
    ${chipHtml}
  </div>`;
}
function appendLog(l) {
  const c = $('logContainer');
  const row = buildLogRow(l);
  [c, $('dashboardLogs')].forEach(target => {
    if (!target) return;
    target.querySelector('.log-empty')?.remove();
    const d = document.createElement('div');
    d.innerHTML = row;
    target.prepend(d.firstElementChild);
  });
}
$('btnClearLogs')?.addEventListener('click', () => {
  const c = $('logContainer');
  if (c) c.innerHTML = '<div class="log-empty">Log cleared.</div>';
  const d = $('dashboardLogs');
  if (d) d.innerHTML = '<div class="log-empty">Activity cleared.</div>';
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $('modal-newkey')?.classList.remove('show');
    $('modal-regenerate-url')?.classList.remove('show');
    if ($('modal-shell')?.classList.contains('show')) $('btnDeny')?.click();
  }
  if (event.ctrlKey && event.key >= '1' && event.key <= '5') {
    event.preventDefault();
    document.querySelectorAll('.nav-button')[Number(event.key) - 1]?.click();
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────
let _keyVisible = false;

function updateKeyDisplay() {
  const kd = $('keyDisplay');
  const tb = $('btnToggleKey');
  if (!kd) return;
  if (!_apiKeyRaw) {
    kd.textContent = '••••••••••••••••';
    kd.title = 'No API key set';
    return;
  }
  if (_keyVisible) {
    kd.textContent = _apiKeyRaw;
    kd.title = 'Click to copy full API key';
    if (tb) tb.textContent = 'Hide';
  } else {
    kd.textContent = _apiKeyRaw.slice(0, 8) + '••••••••' + _apiKeyRaw.slice(-4);
    kd.title = 'Click to copy full API key';
    if (tb) tb.textContent = 'Show';
  }
}

window.updateUrlPreview = function() {
  const name = ($('sName')?.value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g,'-') || 'your-pc';
  const domain = ($('sRelayDomain')?.value || '').trim() || 'mcp.solisk.org';
  const el = $('urlPreviewVal');
  if (el) el.textContent = `https://${domain}/mcp/${name}`;
};

window.copyUrlPreview = function() {
  const el = $('urlPreviewVal');
  if (el) {
    clip(el.textContent.trim());
    toast('MCP URL copied!', 's');
  }
};

async function loadSettings() {
  const cfg = await window.mcp?.getConfig();
  if (!cfg) return;
  const set = (id,v) => { const el=$(id); if (el) el.value=v; };
  set('sPort',        cfg.port         || 3000);
  set('sName',        cfg.name         || '');
  set('sRelayDomain', cfg.relay_domain || '');
  set('sOauthId',     cfg.oauth_client_id     || '');
  set('sOauthSecret', cfg.oauth_client_secret || '');
  set('sPaths',       (cfg.allowed_paths || []).join('\n'));
  const workspaceName = $('workspaceName');
  if (workspaceName) workspaceName.textContent = cfg.name || 'MCP endpoint';
  const mode = cfg.permission_mode || 'always';
  set('sPermMode',    mode);
  set('sPermModeDash', mode);
  permModeChanged();
  const as = $('sAutostart');
  if (as) as.checked = cfg.autostart !== false;
  _apiKeyRaw = cfg.api_key || '';
  updateKeyDisplay();
  updateUrlPreview();
  loadKeys();
}

const PERM_HINTS = {
  always:       'Always ask before running AI commands (recommended)',
  intermediate: 'Auto-approve read-only commands (Get-*, dir, ipconfig…), ask for everything else',
  turbo:        'Run every AI command immediately with NO approval prompts — use only on machines you fully trust',
};

window.permModeChanged = function() {
  const m = $('sPermMode')?.value || $('sPermModeDash')?.value || 'always';
  const h = $('permModeHint');
  if (h) h.textContent = PERM_HINTS[m] || PERM_HINTS.always;
  const dEl = $('sPermModeDash');
  if (dEl && dEl.value !== m) dEl.value = m;
  const sEl = $('sPermMode');
  if (sEl && sEl.value !== m) sEl.value = m;
  const dSub = $('sPermModeDashSub');
  if (dSub) dSub.textContent = PERM_HINTS[m] || PERM_HINTS.always;
};

window.dashPermModeChanged = async function() {
  const m = $('sPermModeDash')?.value || 'always';
  const sEl = $('sPermMode');
  if (sEl) sEl.value = m;
  permModeChanged();

  // Auto-save setting when changed directly from Dashboard
  const old = await window.mcp?.getConfig() || {};
  const newCfg = { ...old, permission_mode: m };
  await window.mcp?.saveConfig(newCfg);
  toast(`Approval Mode changed to ${m.toUpperCase()} ✓`, 's');
};

let _userKeys = [];
const KEY_SCOPES = [
  ['pc:file:read', 'Read files'],
  ['pc:file:list', 'List files'],
  ['pc:file:write', 'Write and delete files'],
  ['pc:process:list', 'List processes'],
  ['pc:process:run', 'Run commands and apps'],
  ['pc:process:kill', 'Stop processes'],
  ['pc:ui:screenshot', 'View screen'],
  ['pc:ui:click', 'Mouse clicks'],
  ['pc:mouse:move', 'Move mouse'],
  ['pc:ui:scroll', 'Scroll'],
  ['pc:ui:type', 'Type text'],
  ['pc:keyboard:type', 'Keyboard typing'],
  ['pc:keyboard:hotkey', 'Keyboard shortcuts'],
  ['pc:qa:screenshot', 'Screen verification'],
  ['pc:network:nslookup', 'Network lookup'],
];

function renderKeyScopePicker() {
  const grid = $('newKeyScopeGrid');
  if (!grid) return;
  grid.innerHTML = KEY_SCOPES.map(([scope, label]) => `<label class="scope-option"><input type="checkbox" value="${scope}"><span><b>${label}</b><small>${scope}</small></span></label>`).join('');
  grid.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
    const checked = grid.querySelectorAll('input:checked').length;
    $('newKeyAllScopes').checked = checked === 0;
  }));
}

async function loadKeys() {
  const listEl = $('keyList'), cntEl = $('keyCount'), emptyEl = $('keyListEmpty');
  if (!listEl) return;
  const r = await window.mcp?.relayListKeys();
  if (!r || !r.ok) {
    listEl.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'key-empty';
    div.textContent = (r && r.error) || 'Cannot fetch key list.';
    listEl.appendChild(div);
    if (cntEl) cntEl.textContent = '';
    return;
  }
  _userKeys = (r.keys || []).filter(k => k.label !== 'owner');
  if (cntEl) cntEl.textContent = `(${_userKeys.length}/5)`;
  if ($('keyNavBadge')) $('keyNavBadge').textContent = String(_userKeys.length);
  if (emptyEl) emptyEl.style.display = _userKeys.length ? 'none' : 'block';
  listEl.innerHTML = '';
  _userKeys.forEach(k => listEl.appendChild(keyItemEl(k)));
}

function keyItemEl(k) {
  const row = document.createElement('div');
  row.className = 'key-item';
  const info = document.createElement('div');
  info.className = 'key-item-info';
  const label = document.createElement('div');
  label.className = 'key-item-label';
  label.textContent = k.label || k.id;
  const id = document.createElement('div');
  id.className = 'key-item-id';
  id.textContent = k.id;
  const sc = document.createElement('div');
  sc.className = 'key-item-scopes';
  (k.scopes || []).forEach(s => {
    const chip = document.createElement('span');
    chip.className = 'scope-chip';
    chip.textContent = s;
    sc.appendChild(chip);
  });
  info.appendChild(label); info.appendChild(id); info.appendChild(sc);

  const act = document.createElement('div');
  act.className = 'key-item-actions';
  const del = document.createElement('button');
  del.className = 'btn btn-sm btn-gh';
  del.textContent = 'Revoke';
  del.title = 'Revoke this key';
  del.addEventListener('click', async () => {
    if (!confirm(`Revoke key "${k.label || k.id}"? AI clients using it will lose access immediately.`)) return;
    const rr = await window.mcp?.relayRevokeKey(k.id);
    if (rr && rr.ok) { toast('Key revoked', 's'); loadKeys(); }
    else toast((rr && rr.error) || 'Revoke failed', 'e');
  });
  act.appendChild(del);
  row.appendChild(info); row.appendChild(act);
  return row;
}

$('btnToggleKey')?.addEventListener('click', () => {
  _keyVisible = !_keyVisible;
  updateKeyDisplay();
});

$('btnGenApiKey')?.addEventListener('click', async () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  _apiKeyRaw = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  _keyVisible = true; // Reveal upon generation so user can see it
  updateKeyDisplay();
  clip(_apiKeyRaw);

  // Auto-save the new key immediately so it syncs with VPS relay & server
  const old = await window.mcp?.getConfig() || {};
  await window.mcp?.saveConfig({
    ...old,
    api_key: _apiKeyRaw,
  });

  renderConnect();
  toast('New API key generated & copied to clipboard! (Auto-saved)', 's');
});

$('btnGenOauth')?.addEventListener('click', () => {
  const r = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const set = (id,v) => { const el=$(id); if (el) el.value=v; };
  set('sOauthId',     'client_' + r().slice(0,8));
  set('sOauthSecret', 'secret_' + r().slice(0,16));
  toast('New credentials generated — click Save to apply!');
});

$('btnRegenerateUrl')?.addEventListener('click', () => {
  $('modal-regenerate-url')?.classList.add('show');
  $('btnRegenerateCancel')?.focus();
});

$('btnRegenerateCancel')?.addEventListener('click', () => {
  $('modal-regenerate-url')?.classList.remove('show');
});

$('btnRegenerateConfirm')?.addEventListener('click', async () => {
  const button = $('btnRegenerateConfirm');
  button.disabled = true;
  button.textContent = 'Regenerating…';
  try {
    const result = await window.mcp?.regenerateMcpUrl();
    if (!result?.ok) throw new Error(result?.error || 'Regeneration failed');
    if (result.status) applyStatus(result.status);
    $('modal-regenerate-url').classList.remove('show');
    await loadSettings();
    await renderConnect();
    toast('New MCP URL created. Previous sessions were disconnected.', 's');
  } catch (error) {
    toast(error?.message || 'MCP URL could not be regenerated', 'e');
  } finally {
    button.disabled = false;
    button.textContent = 'Yes, regenerate';
  }
});

$('btnRefreshKeys')?.addEventListener('click', async () => {
  loadKeys();
});

$('btnNewUserKey')?.addEventListener('click', () => {
  if (_userKeys.length >= 5) { toast('Max 5 scope-only keys reached — revoke one first', 'e'); return; }
  $('newKeyPlain').style.display = 'none';
  $('newKeyMsg').style.display = 'none';
  $('newKeyLabel').value = '';
  renderKeyScopePicker();
  $('newKeyAllScopes').checked = true;
  $('modal-newkey').classList.add('show');
});

$('newKeyAllScopes')?.addEventListener('change', event => {
  if (!event.target.checked) return;
  $('newKeyScopeGrid')?.querySelectorAll('input').forEach(input => { input.checked = false; });
});

$('btnNewKeyCancel')?.addEventListener('click', () => $('modal-newkey').classList.remove('show'));

$('btnNewKeyCreate')?.addEventListener('click', async () => {
  const label  = $('newKeyLabel').value.trim();
  const scopes = Array.from($('newKeyScopeGrid').querySelectorAll('input:checked'), input => input.value);
  const btn = $('btnNewKeyCreate');
  btn.disabled = true; btn.textContent = 'Creating…';
  const r = await window.mcp?.relayCreateKey({ label, scopes });
  btn.disabled = false; btn.textContent = 'Create Key';
  if (r && r.ok && r.key && r.key.api_key) {
    $('newKeyPlainVal').textContent = r.key.api_key;
    $('newKeyPlain').style.display = 'flex';
    $('newKeyMsg').style.display = 'none';
    toast('Key created! Copy it now — shown only once.', 's');
    loadKeys();
  } else {
    $('newKeyMsg').textContent = (r && r.error) || 'Failed to create key.';
    $('newKeyMsg').style.display = 'block';
    $('newKeyPlain').style.display = 'none';
  }
});

$('btnSave')?.addEventListener('click', async () => {
  const saveButton = $('btnSave');
  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';
  const g  = id => { const el=$(id); return el ? el.value : ''; };
  const old = await window.mcp?.getConfig() || {};
  const newCfg = {
    ...old,
    api_key:             _apiKeyRaw || old.api_key || '',
    port:                parseInt(g('sPort')) || 3000,
    autostart:           $('sAutostart')?.checked ?? true,
    name:                old.name || g('sName').trim().toLowerCase().replace(/[^a-z0-9-]/g,'-'),
    relay_domain:        g('sRelayDomain').trim(),
    permission_mode:     $('sPermMode')?.value || 'always',
    oauth_client_id:     g('sOauthId').trim(),
    oauth_client_secret: g('sOauthSecret').trim(),
    allowed_paths:       g('sPaths').split('\n').map(s=>s.trim()).filter(Boolean),
  };
  try {
    await window.mcp?.saveConfig(newCfg);
    renderConnect();
    const m = $('saveOk');
    if (m) { m.textContent='Saved'; setTimeout(()=>m.textContent='',2200); }
    toast('Settings saved and synced to the relay', 's');
  } catch (error) {
    toast(error?.message || 'Settings could not be saved', 'e');
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Save settings';
  }
});

// ── Shell approval modal ──────────────────────────────────────────────────────
if (window.mcp) {
  window.mcp.onShellApprovalReq(msg => {
    const modal = $('modal-shell'), txt = $('modalCmd');
    if (!modal || !txt) { window.mcp.sendShellApprovalRes({ id:msg.id, approved:false }); return; }
    txt.textContent = msg.command;
    modal.classList.add('show');
    const respond = ok => { modal.classList.remove('show'); window.mcp.sendShellApprovalRes({ id:msg.id, approved:ok }); };
    $('btnDeny').onclick  = () => respond(false);
    $('btnAllow').onclick = () => respond(true);
  });
}

// ── IPC hooks ─────────────────────────────────────────────────────────────────
window.mcp?.onStatus(applyStatus);
window.mcp?.onLog(appendLog);

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  document.querySelectorAll('.page h1').forEach(heading => heading.tabIndex = -1);
  const s = window.mcp ? await window.mcp.getStatus() : null;
  applyStatus(s || { running:false, tunnelUrl:null, relayUrl:null, toolCount:TOOL_TOTAL, sessionCount:0, serverPort:3000 });
  updateToolBadge();
  renderLogs();
  const config = await window.mcp?.getConfig() || {};
  await loadSettings();
  if (!config.ready) showOnboarding(config);
})();
