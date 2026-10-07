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

// ── One-line tool descriptions (info dot tooltips) ──────────────────────────
const TOOL_DESC = {
  read_file: 'Read any text file into the conversation.',
  write_file: 'Create or overwrite a file with new content.',
  append_file: 'Add content to the end of a file.',
  delete_file: 'Permanently delete a file.',
  list_dir: 'List files and folders in a directory.',
  move_file: 'Move or rename a file or folder.',
  copy_file: 'Duplicate a file or folder.',
  file_exists: 'Check whether a path exists.',
  get_file_info: 'Show file size, dates, and attributes.',
  search_files: 'Find files by name pattern.',
  read_json: 'Read and parse a JSON file.',
  write_json: 'Write data out as a JSON file.',
  get_folder_size: 'Measure total size of a folder.',
  patch_file: 'Apply a small targeted edit to a file.',
  grep_files: 'Search text inside files across folders.',
  edit_file: 'Edit a file with find-and-replace rules.',
  str_replace: 'Replace one exact text block in a file.',
  replace_file_content: 'Rewrite matched content inside a file.',
  grep: 'Fast text search across file contents.',
  hash_file: 'Compute a file checksum (SHA-256).',
  run_command: 'Run a shell command and return output.',
  run_command_background: 'Start a long command without waiting.',
  get_env: 'Read an environment variable value.',
  set_env: 'Set an environment variable value.',
  get_system_info: 'Show OS, CPU, memory, and disk summary.',
  list_processes: 'List currently running programs.',
  kill_process: 'Force-stop a running program.',
  take_screenshot: 'Capture the current screen as an image.',
  get_clipboard: 'Read text currently on the clipboard.',
  set_clipboard: 'Copy text to the clipboard.',
  open_url: 'Open a web link in the default browser.',
  open_file: 'Open a file with its default app.',
  read_screen_text: 'Extract readable text from the screen.',
  http_get: 'Fetch content from a web URL.',
  http_post: 'Send data to a web URL.',
  web_search: 'Search the web and return results.',
  ping_host: 'Check if a host answers on the network.',
  get_public_ip: 'Show this PC public internet address.',
  get_local_ip: 'Show this PC local network address.',
  list_network_connections: 'Show active network connections.',
  dns_lookup: 'Resolve a domain name to IP addresses.',
  list_wifi_networks: 'Show nearby Wi-Fi networks.',
  get_wifi_password: 'Reveal a saved Wi-Fi password.',
  serve_directory: 'Host a folder as a local website.',
  stop_server: 'Stop a locally hosted folder or port.',
  expose_port: 'Make a local port reachable.',
  download_file: 'Download a file from a URL.',
  check_port: 'Test whether a local port is open.',
  mouse_click: 'Click at a screen position.',
  mouse_move: 'Move the pointer to a screen position.',
  mouse_double_click: 'Double-click at a screen position.',
  keyboard_type: 'Type text as keystrokes.',
  key_press: 'Press a single key or shortcut.',
  list_windows: 'List open application windows.',
  focus_window: 'Bring a window to the front.',
  get_active_window: 'Show which window is currently focused.',
  close_window: 'Close an application window.',
  get_mouse_position: 'Report current pointer coordinates.',
  show_notification: 'Pop a Windows toast notification.',
  show_dialog: 'Show a message dialog on screen.',
  speak_text: 'Read text aloud with text-to-speech.',
  play_sound: 'Play an audio file.',
  set_volume: 'Change system audio volume.',
  get_volume: 'Read current system audio volume.',
  memory_set: 'Save a fact for AI to remember.',
  memory_get: 'Recall a saved fact by key.',
  memory_list: 'List everything AI currently remembers.',
  memory_delete: 'Forget one saved fact.',
  memory_clear: 'Erase all saved AI memory.',
  memory_append: 'Add to an existing saved memory.',
  git_status: 'Show changed and untracked Git files.',
  git_clone: 'Download a Git repository locally.',
  git_add: 'Stage files for the next commit.',
  git_commit: 'Save staged changes with a message.',
  git_push: 'Upload commits to the remote repo.',
  git_pull: 'Download and merge remote changes.',
  git_log: 'Show recent commit history.',
  git_diff: 'Show unstaged file changes.',
  git_branch: 'List or switch Git branches.',
  git_init: 'Start a new Git repository.',
  list_installed_apps: 'List programs installed on this PC.',
  get_battery_status: 'Show battery level and charging state.',
  get_disk_usage: 'Show free and used space per drive.',
  get_startup_programs: 'List apps that launch at startup.',
  run_as_admin: 'Relaunch a command with admin rights.',
  schedule_task: 'Create a Windows scheduled task.',
  take_screenshot_region: 'Capture only part of the screen.',
  get_screen_resolution: 'Show display size and scaling.',
  empty_recycle_bin: 'Permanently empty the Recycle Bin.',
  lock_screen: 'Lock Windows immediately.',
  shutdown: 'Shut down or restart this PC.',
  encode_base64: 'Encode text to Base64.',
  decode_base64: 'Decode Base64 back to text.',
  generate_uuid: 'Create a random unique identifier.',
  hash_text: 'Checksum any text (SHA-256).',
  format_json: 'Pretty-print compact JSON.',
  timestamp_now: 'Return the current date and time.',
};

// ── Tool state ────────────────────────────────────────────────────────────────
let toolState = {};
let toolSaveQueue = Promise.resolve();
(function() {
  try { toolState = JSON.parse(localStorage.getItem('toolState') || '{}'); } catch { toolState = {}; }
  CATS.forEach(c => c.tools.forEach(t => { if (toolState[t] === undefined) toolState[t] = true; }));
})();
async function saveTools() {
  localStorage.setItem('toolState', JSON.stringify(toolState));
  const disabled_tools = CATS.flatMap(c => c.tools).filter(t => toolState[t] === false);
  toolSaveQueue = toolSaveQueue.then(async () => {
    const old = await window.mcp?.getConfig() || {};
    await window.mcp?.saveConfig({ ...old, disabled_tools });
  });
  return toolSaveQueue;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const clip = async t => {
  const text = String(t ?? '');
  if (!text) { toast('Nothing to copy', 'e'); return false; }
  // 1) Main-process clipboard — always works, no permissions needed.
  try { if (await window.mcp?.writeClipboard(text)) return true; } catch {}
  // 2) Browser API fallback.
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // 3) Legacy fallback.
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) return true;
  } catch {}
  toast('Clipboard access failed', 'e');
  return false;
};

function applyTheme(theme, persist = false) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = normalized;
  if (persist) localStorage.setItem('theme', normalized);
  const toggle = $('themeToggle');
  if (toggle) {
    const next = normalized === 'dark' ? 'light' : 'dark';
    toggle.setAttribute('aria-label', `Switch to ${next} mode`);
    toggle.title = `Switch to ${next} mode`;
  }
}

// Theme: an explicit user choice wins and persists; otherwise follow the OS
// light/dark setting and react live when the OS switches.
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
function resolveTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return themeMedia.matches ? 'dark' : 'light';
}
applyTheme(resolveTheme());
if (themeMedia.addEventListener) {
  themeMedia.addEventListener('change', () => {
    if (!localStorage.getItem('theme')) applyTheme(resolveTheme());
  });
}

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

window.copyEl = async function(id) {
  const el = $(id);
  if (!el) return;
  const ok = await clip('value' in el ? el.value : el.textContent.trim());
  if (ok) toast('Copied!', 's');
};

window.copyKey = async function() {
  if (!_apiKeyRaw) { toast('No API key loaded yet', 'e'); return; }
  const ok = await clip(_apiKeyRaw);
  if (ok) toast('API key copied!', 's');
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
    if (pg === 'setup')    renderSetup();
    if (pg === 'tools')    renderTools();
    if (pg === 'logs')     renderLogs();
    if (pg === 'health')   refreshHealth();
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
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
});

// ── Apply status ──────────────────────────────────────────────────────────────
function applyStatus(s) {
  if (!s) return;
  ST = { ...ST, ...s };
  const on = ST.running;

  // Titlebar
  $('tbDot')?.classList.toggle('on', on && !ST.isInternetOffline);
  $('tbDot')?.classList.toggle('warn', on && !!ST.isInternetOffline);
  $('tbLive')?.classList.toggle('on', on && !ST.isInternetOffline);
  $('tbLive')?.classList.toggle('warn', on && !!ST.isInternetOffline);
  const tbTxt = $('tbTxt');
  if (tbTxt) {
    if (!on) tbTxt.textContent = 'Server stopped';
    else if (ST.isInternetOffline) tbTxt.textContent = 'Server running · No internet connection';
    else tbTxt.textContent = 'Server running';
  }

  // Sidebar pill
  $('srvOrb')?.classList.toggle('on', on && !ST.isInternetOffline);
  $('srvOrb')?.classList.toggle('warn', on && !!ST.isInternetOffline);
  $('srvBtn')?.classList.toggle('on', on);
  const srvName = $('srvName'), srvHint = $('srvHint'), srvAct = $('srvAct');
  if (srvName) srvName.textContent = on ? (ST.isInternetOffline ? 'Local only (Offline)' : 'Server running') : 'Server stopped';
  if (srvHint) srvHint.textContent = on ? (ST.isInternetOffline ? 'No internet connection' : 'Click to stop')  : 'Ready to start';
  if (srvAct)  srvAct.textContent  = on ? '−' : '+';

  // Hero
  const hero = $('heroCard');
  hero?.classList.toggle('on', on);
  const heroH = $('heroH'), heroSub = $('heroSub');
  if (heroH)   heroH.textContent   = on ? (ST.isInternetOffline ? 'Server running locally (Offline)' : 'Your MCP server is live') : 'Your MCP server is stopped';
  if (heroSub) heroSub.textContent = on
    ? (ST.isInternetOffline
        ? `Listening on port ${ST.serverPort} · Local tools available · Internet disconnected`
        : `Listening on port ${ST.serverPort} · ${ST.toolCount || TOOL_TOTAL} capabilities available · ${ST.sessionCount || 0} active sessions`)
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
  const relayStateEl = $('relayState');

  if (epRelay) {
    if (ST.isInternetOffline) {
      epRelay.textContent = 'No internet connection — connect to Wi-Fi or Ethernet to enable cloud relay';
      epRelay.classList.remove('live');
      if (relayStateEl) {
        relayStateEl.textContent = 'No Internet';
        relayStateEl.className = 'endpoint-state warn';
      }
      if (btnRetry) {
        btnRetry.style.display = 'inline-block';
        btnRetry.textContent = 'Check Connection';
      }
    }
    else if (ST.relayUrl)  {
      epRelay.textContent = ST.relayUrl;
      epRelay.classList.add('live');
      if (relayStateEl) {
        relayStateEl.textContent = 'Live';
        relayStateEl.className = 'endpoint-state live';
      }
      if (btnRetry) {
        btnRetry.style.display = 'none';
        btnRetry.textContent = 'Retry';
      }
    }
    else if (ST.relayError && ST.tunnelUrl) {
      epRelay.textContent = 'Hosted relay unavailable — Cloudflare tunnel ready';
      epRelay.classList.remove('live');
      if (relayStateEl) {
        relayStateEl.textContent = 'Fallback';
        relayStateEl.className = 'endpoint-state warn';
      }
      if (btnRetry) {
        btnRetry.style.display = 'inline-block';
        btnRetry.textContent = 'Retry Connection';
      }
    }
    else if (ST.relayError) {
      epRelay.textContent = ST.relayError;
      epRelay.classList.remove('live');
      if (relayStateEl) {
        relayStateEl.textContent = 'Unavailable';
        relayStateEl.className = 'endpoint-state warn';
      }
      if (btnRetry) {
        btnRetry.style.display = 'inline-block';
        btnRetry.textContent = 'Retry Connection';
      }
    }
    else {
      epRelay.textContent = on ? 'Connecting to relay…' : 'Server not running';
      epRelay.classList.remove('live');
      if (relayStateEl) {
        relayStateEl.textContent = on ? 'Connecting' : 'Offline';
        relayStateEl.className = 'endpoint-state';
      }
      if (btnRetry) {
        btnRetry.style.display = on ? 'inline-block' : 'none';
        btnRetry.textContent = 'Retry Connection';
      }
    }
  }
  if (epTunnel) {
    if (ST.tunnelUrl) { epTunnel.textContent = ST.tunnelUrl + '/mcp'; epTunnel.classList.add('live'); $('tunnelState')?.replaceChildren(document.createTextNode('Live')); }
    else              { epTunnel.textContent = on ? 'Waiting for tunnel…' : 'Not connected'; epTunnel.classList.remove('live'); $('tunnelState')?.replaceChildren(document.createTextNode(on ? 'Waiting' : 'Offline')); }
  }
  if (epLocal) epLocal.textContent = `http://localhost:${ST.serverPort || 3000}/mcp`;
  const epDash = $('epDash');
  if (epDash) epDash.textContent = `http://localhost:${ST.serverPort || 3000}/app`;

  // Refresh connect page content if it's visible
  if (document.querySelector('#pg-connect.on')) renderConnect();
  // Refresh setup page content if it's visible
  if (document.querySelector('#pg-setup.on')) renderSetup();
}

let lastTunRefresh = 0;
const _applyStatus = applyStatus;
applyStatus = function(s) {
  _applyStatus(s);
  const now = Date.now();
  if (now - lastTunRefresh > 10000) { lastTunRefresh = now; refreshTunnel(); }
};

window.retryRelayConn = async function() {
  toast('Checking connection…');
  try {
    const res = await window.mcp?.retryRelay();
    if (res && res.status) applyStatus(res.status);
    if (res && res.ok === false && res.error) {
      toast(res.error, 'e');
    } else {
      toast('Reconnection initiated ✓', 's');
    }
  } catch (e) {
    toast('Retry failed: ' + (e?.message || e), 'e');
  }
};

// ── Server toggle ─────────────────────────────────────────────────────────────
async function toggleServer() {
  if (serverActionPending || !window.mcp) return;
  if (document.body.classList.contains("is-bridge")) {
    toast("The server runs on the host — start/stop it there, not from the browser.", "e");
    return;
  }
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
    if (el.id === 'srvBtn') el.setAttribute('aria-disabled', String(busy));
    el.setAttribute('aria-busy', String(busy));
  });
  if ($('btnToggle')) $('btnToggle').textContent = busy ? (ST.running ? 'Stopping…' : 'Starting…') : (ST.running ? 'Stop server' : 'Start server');
}
$('pwrBtn')   ?.addEventListener('click', toggleServer);
$('btnToggle')?.addEventListener('click', toggleServer);
$('srvBtn')   ?.addEventListener('click', () => { if ($('srvBtn')?.getAttribute('aria-disabled') === 'true') return; toggleServer(); });
$('srvBtn')?.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if ($('srvBtn')?.getAttribute('aria-disabled') === 'true') return; toggleServer(); }
});

// ── Endpoint copy ─────────────────────────────────────────────────────────────
$('btnCpRelay')  ?.addEventListener('click', async () => {
  const url = ST.relayUrl || (ST.tunnelUrl ? ST.tunnelUrl + '/mcp' : null);
  if (!url) { toast(ST.relayError || 'Relay not connected yet', 'e'); return; }
  const ok = await clip(url);
  if (ok) toast(ST.relayUrl ? 'MCP URL copied!' : 'Hosted relay unavailable. Cloudflare tunnel URL copied.', 's');
});
$('btnCpTunnel') ?.addEventListener('click', async () => {
  if (!ST.tunnelUrl) { toast('Tunnel not connected yet', 'e'); return; }
  const ok = await clip(ST.tunnelUrl + '/mcp');
  if (ok) toast('Tunnel URL copied!', 's');
});
$('btnCpLocal')  ?.addEventListener('click', async () => {
  const ok = await clip(`http://localhost:${ST.serverPort || 3000}/mcp`);
  if (ok) toast('Local URL copied!', 's');
});
$('btnCpDash')   ?.addEventListener('click', async () => {
  const ok = await clip(`http://localhost:${ST.serverPort || 3000}/app`);
  if (ok) toast('Dashboard URL copied!', 's');
});
$('btnOpenDash')  ?.addEventListener('click', async () => {
  if (!ST.running) { toast('Start the server first', 'e'); return; }
  if (!dashOn) { toast('Dashboard is off — flip its switch first', 'e'); return; }
  try { await window.mcp?.openUrl(`http://localhost:${ST.serverPort || 3000}/app`); }
  catch { toast('Could not open dashboard', 'e'); }
});

// ── Delegated bindings (CSP `script-src 'self'` blocks inline handlers) ───────
document.addEventListener('click', e => {
  const cp = e.target.closest('[data-copy]');
  if (cp) { copyEl(cp.dataset.copy); return; }
  if (e.target.closest('[data-stop]')) return;                      // swallow: open-link buttons
  if (e.target.closest('.ccard-bd')) return;                        // swallow: text selection inside cards
  if (e.target.closest('[data-copy-url]')) { copyUrlPreview(); return; }
  const tg = e.target.closest('[data-toggle]');
  if (tg) { toggleCC(tg.dataset.toggle); return; }
  const fl = e.target.closest('.cat-filter-btn[data-filter]');
  if (fl) { filterLogs(fl.dataset.filter); return; }
});
$('btnRetryRelay')       ?.addEventListener('click', retryRelayConn);
$('btnManualRetryRelay') ?.addEventListener('click', retryRelayConn);
$('btnCopyKey')          ?.addEventListener('click', copyKey);
document.addEventListener('change', e => {
  if (e.target.id === 'sPermModeDash') dashPermModeChanged();
  else if (e.target.id === 'sPermMode') permModeChanged();
});
document.addEventListener('input', e => {
  if (e.target.id === 'sRelayDomain' || e.target.id === 'sName') updateUrlPreview();
});
document.addEventListener('click', e => {
  const setCatBtn = e.target.closest('[data-setcat]');
  if (setCatBtn) { setCat(setCatBtn.dataset.setcat, setCatBtn.dataset.enable === '1'); return; }
  const tool = e.target.closest('[data-tool]');
  if (tool && e.target.closest('[data-tinfo]')) return; // info dot: tooltip only, never toggles
  if (tool) { toggleTool(tool.dataset.tool, tool.dataset.cat); return; }
  const catHd = e.target.closest('.tcat-hd[data-cat]');
  if (catHd && !e.target.closest('[data-stop]')) { toggleCat(catHd.dataset.cat); return; }
});
// Dashboard "View full activity" shortcut (was a CSP-blocked inline script)
document.querySelectorAll('[data-page-link]').forEach(el => el.addEventListener('click', () =>
  document.querySelector('[data-page="' + el.dataset.pageLink + '"]')?.click()
));

// ── Connect page ──────────────────────────────────────────────────────────────
window.toggleCC = function(id) {
  const card = $(id);
  if (!card) return;
  const wasOpen = card.classList.contains('open');
  document.querySelectorAll('.connect-card').forEach(c => c.classList.remove('open'));
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

// Single floating tooltip for info dots. It lives on <body> so category
// cards with overflow:hidden can never clip it.
const toolTip = document.createElement('div');
toolTip.className = 'tinfo-tip';
toolTip.setAttribute('role', 'tooltip');
document.body.appendChild(toolTip);
let toolTipFor = null;
document.addEventListener('mouseover', e => {
  const dot = e.target.closest ? e.target.closest('[data-tinfo]') : null;
  if (!dot) { toolTip.classList.remove('show'); toolTipFor = null; return; }
  if (toolTipFor === dot && toolTip.classList.contains('show')) return;
  toolTipFor = dot;
  toolTip.textContent = dot.getAttribute('data-tip') || '';
  toolTip.classList.add('show');
  const r = dot.getBoundingClientRect();
  const tw = toolTip.offsetWidth || 200, th = toolTip.offsetHeight || 40;
  const x = Math.min(Math.max(8, r.right - tw), window.innerWidth - tw - 8);
  let y = r.bottom + 8;
  if (y + th > window.innerHeight - 8) y = Math.max(8, r.top - th - 8);
  toolTip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
});

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
      <div class="tcat-hd" data-cat="${cat.id}">
        <svg class="tcat-ico" viewBox="0 0 24 24">${cat.icon}</svg>
        <span class="tcat-nm">${cat.name}</span>
        <span class="tcat-cnt">${enabled}/${filtered.length}</span>
        <div class="tcat-btns" data-stop aria-label="${cat.name} selection">
          <button class="cat-action" data-setcat="${cat.id}" data-enable="1" title="Enable every ${cat.name} capability"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg><span>Enable</span></button>
          <button class="cat-action muted" data-setcat="${cat.id}" data-enable="0" title="Disable every ${cat.name} capability"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8m0-8-8 8"/></svg><span>Disable</span></button>
        </div>
        <svg class="tcat-chev" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
      </div>
      <div class="tcat-bd">
        <div class="tool-grid">
          ${filtered.map(t => `
            <div class="ttag ${toolState[t] ? '' : 'off'}" data-tool="${t}" data-cat="${cat.id}">
              <div class="mpill"><div class="mpill-t"><div class="mpill-h"></div></div></div>
              <span class="tnm">${t}</span>
              <span class="tinfo" data-tinfo data-tip="${esc(TOOL_DESC[t] || 'AI capability.')}">i</span>
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
$('btnSaveTools')?.addEventListener('click', async () => { await saveTools(); toast('Preferences saved. Restart server to update advertised tools.','s'); });

// ── Logs ──────────────────────────────────────────────────────────────────────
let currentLogFilter = 'TOOL';
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
    const cnt = $('logCount');
    if (cnt) cnt.textContent = filtered.length ? `${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}` : '';
    if (!filtered.length) {
      if (c) c.innerHTML = `<div class="log-empty">${currentLogFilter === 'TOOL' ? 'No tool calls yet — actions appear here as AI clients use tools.' : 'No activity found for category "' + currentLogFilter + '".'}</div>`;
      if (d) d.innerHTML = '<div class="log-empty">No activity yet. Start the server to see runtime events.</div>';
      return;
    }
    if (c) c.innerHTML = filtered.slice(0, 120).map(buildLogRow).join('');
    // Dashboard feed prefers recent tool actions, falls back to latest events.
    const actionFeed = allLogsCache.filter(l => (l.category || '').toUpperCase() === 'TOOL');
    if (d) d.innerHTML = (actionFeed.length ? actionFeed : allLogsCache).slice(0, 5).map(buildLogRow).join('');
  });
}
function buildLogRow(l) {
  // Tool-action rows: compact, readable "what AI did just now" cards.
  if (l.tool) {
    const ok = l.success !== false && (l.status ? l.status < 400 : true);
    const chips = [];
    if (l.duration_ms != null) chips.push(`<span class="log-chip">${Math.round(l.duration_ms)}ms</span>`);
    if (l.status) chips.push(`<span class="log-chip ${l.status < 400 ? 'ok' : 'err'}">${esc(l.method || 'POST')} ${l.status}</span>`);
    const chipHtml = chips.length ? `<span class="log-chips">${chips.join('')}</span>` : '';
    return `<div class="log-row">
      <span class="log-ts">${l.time}</span>
      <span class="act-dot ${ok ? 'ok' : 'err'}">${ok ? '✓' : '✕'}</span>
      <span class="log-msg"><span class="act-tool">${esc(l.tool)}</span> ${esc(l.msg)}${l.error ? ' — <span class="log-err">' + esc(String(l.error)) + '</span>' : ''}</span>
      ${chipHtml}
    </div>`;
  }
  const chips = [];
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
$('btnClearLogs')?.addEventListener('click', async () => {
  await window.mcp?.clearLogs();
  allLogsCache = [];
  const c = $('logContainer');
  if (c) c.innerHTML = '<div class="log-empty">Log cleared.</div>';
  const d = $('dashboardLogs');
  if (d) d.innerHTML = '<div class="log-empty">Activity cleared.</div>';
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $('modal-newkey')?.classList.remove('show');
    $('modal-regenerate-url')?.classList.remove('show');
    if ($('modal-tunnel')?.classList.contains('show')) wizClose();
    if ($('modal-shell')?.classList.contains('show')) $('btnDeny')?.click();
  }
  if (event.ctrlKey && event.key >= '1' && event.key <= '8') {
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
    kd.classList.remove('full');
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
  kd.classList.toggle('full', _keyVisible);
}

window.updateUrlPreview = function() {
  const name = ($('sName')?.value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g,'-') || 'your-pc';
  const domain = ($('sRelayDomain')?.value || '').trim() || 'mcp.solisk.org';
  const el = $('urlPreviewVal');
  if (el) el.textContent = `https://${domain}/mcp/${name}`;
};

window.copyUrlPreview = async function() {
  const el = $('urlPreviewVal');
  if (!el) return;
  const ok = await clip(el.textContent.trim());
  if (ok) toast('MCP URL copied!', 's');
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
  const sd = $('sDash');
  if (sd) sd.checked = cfg.dashboard_enabled !== false;
  _apiKeyRaw = cfg.api_key || '';
  if (Array.isArray(cfg.disabled_tools)) {
    CATS.forEach(c => c.tools.forEach(t => { toolState[t] = !cfg.disabled_tools.includes(t); }));
    localStorage.setItem('toolState', JSON.stringify(toolState));
    updateToolBadge();
  }
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
  if (m === "turbo" && !confirm("Turbo runs every AI command with NO approval prompts. Enable?")) {
    const sEl = $('sPermModeDash');
    if (sEl) sEl.value = "always";
    permModeChanged();
    return;
  }
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
  ['pc:clipboard:read', 'Read clipboard'],
  ['pc:clipboard:write', 'Write clipboard'],
  ['pc:notification:show', 'Show notifications and dialogs'],
  ['pc:audio:control', 'Control audio'],
  ['pc:memory:read', 'Read AI memory'],
  ['pc:memory:write', 'Change AI memory'],
  ['pc:git:read', 'Read Git repositories'],
  ['pc:git:write', 'Change Git repositories'],
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
  const copied = await clip(_apiKeyRaw);
  if (copied) toast('New API key generated and copied!', 's');

  // Auto-save the new key immediately so it syncs with VPS relay & server
  const old = await window.mcp?.getConfig() || {};
  await window.mcp?.saveConfig({
    ...old,
    api_key: _apiKeyRaw,
  });

  renderConnect();
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

// ── Tunnel + tailnet (Connect page, Overview switches) ──────────────────────
let lastTunMode = "quick";
let tunRefreshing = false;
let dashOn = true;
let lastTun = null;

function renderSetup() {
  const set = (stateId, urlId, state, url, live) => {
    const s = $(stateId), u = $(urlId);
    if (s) { s.textContent = state; s.classList.toggle("live", !!live); }
    if (u) { u.textContent = url; u.classList.toggle("live", !!live); }
  };
  const syncSwitch = (id, on) => {
    const sw = $(id);
    if (sw && document.activeElement !== sw) sw.checked = !!on;
  };
  const relayOn = ST.relayOn !== false;
  syncSwitch("suRelaySwitch", relayOn && ST.running);
  const isOffline = !!ST.isInternetOffline;
  const relayLive = relayOn && !!(ST.relayUrl || (ST.running && !ST.relayError && !isOffline));
  const relayStateText = !ST.running ? "Offline" : isOffline ? "No Internet" : !relayOn ? "Off" : ST.relayUrl ? "Live" : ST.relayError ? "Unavailable" : "Connecting";
  const relayUrlText = isOffline
    ? "No internet connection detected — Wi-Fi or Ethernet required"
    : !relayOn
      ? "Relay off — switch on to reconnect"
      : ST.relayUrl || (!ST.running ? "—" : "Waiting for relay…");
  set("suRelayState", "suRelayUrl", relayStateText, relayUrlText, relayLive);
  const rSub = $("suRelaySub");
  if (rSub) rSub.textContent = isOffline ? "Offline · reconnect network to use cloud relay" : (!relayOn ? "Direct-only until re-enabled" : "Managed host · always-on room");
  const t = lastTun;
  const tunUrl = (t && t.state && t.state.url) || (ST.tunnelUrl ? ST.tunnelUrl + "/mcp" : "");
  const tunActive = t && t.mode !== "off";
  syncSwitch("suTunSwitch", tunActive);
  set("suTunState", "suTunUrl",
    !t ? "Unknown" : t.mode === "off" ? "Off" : tunUrl ? "Live" : "Starting",
    tunUrl || (t && t.mode === "custom" && t.hostname ? `https://${t.hostname} (starting…)` : "—"), !!tunUrl);
  const tSub = $("suTunSub");
  if (tSub) tSub.textContent = !t || t.mode === "off" ? "Direct pipe · switch on to expose" : t.mode === "custom" ? `Custom domain · ${t.hostname || "wizard pending"}` : "Quick tunnel · address rotates on restart";
  const tsUrl = (t && t.tailscale && (t.tailscale.url || (t.tailscale.loggedIn && `https://${t.tailscale.dns}`))) || "";
  syncSwitch("suTsSwitch", !!tsUrl);
  set("suTsState", "suTsUrl", !t ? "Unknown" : tsUrl ? "Live" : "Off", tsUrl || "—", !!tsUrl);
  const dashUrl = `http://localhost:${ST.serverPort || 3000}/app`;
  const dashLive = ST.running && dashOn;
  syncSwitch("suDashSwitch", dashLive);
  set("suDashState", "suDashUrl", !ST.running ? "Offline" : dashOn ? "Local" : "Off", ST.running ? dashUrl : "—", dashLive);
  const dSub = $("suDashSub");
  if (dSub) dSub.textContent = dashOn ? "Browser view · key-locked" : "Fully off · /app and /dashboard return 404";
}

async function refreshTunnel() {
  if (tunRefreshing) return;
  tunRefreshing = true;
  try {
    let t = null;
    try { t = await window.mcp?.tunnelState(); } catch { return; }
    if (!t) return;
    lastTun = t;
    lastTunMode = t.mode && t.mode !== "off" ? t.mode : lastTunMode;
    dashOn = t.dashboard !== false;
  const line = $('tunModeLine');
  if (line) {
    if (t.mode === "off") line.textContent = "Off — nothing exposed.";
    else if (t.mode === "custom") line.textContent = (t.hostname ? `https://${t.hostname}` : "Custom") + (t.hasToken ? "" : " — token missing, run the wizard.");
    else line.textContent = t.state && t.state.url ? "Quick tunnel" : "Quick tunnel";
  }
  ["tunModeOff", "tunModeQuick", "tunModeCustom"].forEach((id, i) => {
    const b = $(id);
    if (b) b.classList.toggle("on", ["off", "quick", "custom"][i] === t.mode);
  });
  const sw = $('tunSwitch');
  if (sw) { sw.disabled = false; if (document.activeElement !== sw) sw.checked = t.mode !== "off"; }
  const ts = $('tsState'), tl = $('tsStatusLine'), tsub = $('tsSub');
  const tsLive = t.tailscale && t.tailscale.ok && t.tailscale.loggedIn;
  if (ts) ts.textContent = !t.tailscale || !t.tailscale.ok ? "Missing" : tsLive ? "Live" : "Paused";
  if (tl) tl.textContent = tsLive && t.tailscale.url ? t.tailscale.url : tsLive ? `https://${t.tailscale.dns}` : (!t.tailscale || !t.tailscale.ok ? "Tailscale not installed." : "Not serving — hit Serve.");
  if (tsub) tsub.textContent = !t.tailscale || !t.tailscale.ok ? "Tailnet inbound" : tsLive ? "Serving tailnet" : "Installed, idle";
  const ds = $('dashSwitch');
  if (ds && document.activeElement !== ds) ds.checked = dashOn;
  const dbs = $('dashState');
  if (dbs) { dbs.textContent = dashOn ? "Local" : "Off"; dbs.classList.toggle("live", dashOn); }
  const epd = $('epDash');
  if (epd) epd.classList.toggle("live", dashOn && ST.running);
  if (document.querySelector('#pg-setup.on')) renderSetup();
  } finally { tunRefreshing = false; }
}

async function setTunMode(mode) {
  try {
    const r = await window.mcp?.tunnelSetMode(mode);
    if (r && r.ok) { toast(mode === "off" ? "Tunnel off" : `Tunnel ${mode} — ${r.applied ? "applied live" : "applies on start"}`, 's'); }
    else toast((r && r.error) || "Tunnel switch failed", 'e');
  } catch { toast("Tunnel switch failed", 'e'); }
  refreshTunnel();
}

$('tunModeOff')?.addEventListener('click', () => setTunMode('off'));
$('tunModeQuick')?.addEventListener('click', () => setTunMode('quick'));
$('tunModeCustom')?.addEventListener('click', () => setTunMode('custom'));
$('tunSwitch')?.addEventListener('change', e => setTunMode(e.target.checked ? lastTunMode : 'off'));
$('tsServe')?.addEventListener('click', async () => { await window.mcp?.tailscaleServe(false); toast('Tailnet serve requested', 's'); refreshTunnel(); });
$('tsFunnel')?.addEventListener('click', async () => {
  if (!confirm("Funnel publishes this PC to the public internet. Continue?")) return;
  await window.mcp?.tailscaleServe(true); toast('Funnel requested', 's'); refreshTunnel();
});
$('tsOff')?.addEventListener('click', async () => { await window.mcp?.tailscaleOff(); refreshTunnel(); });
$('dashSwitch')?.addEventListener('change', async e => {
  await window.mcp?.dashSet(e.target.checked);
  toast(e.target.checked ? "Dashboard on" : "Dashboard off", 's');
});
$('sDash')?.addEventListener('change', async e => {
  await window.mcp?.dashSet(e.target.checked);
  toast("Saved", 's');
  refreshTunnel();
});

// ── Setup-tab toggles + actions (mirror the Overview controls) ──────────────
$('suRelaySwitch')?.addEventListener('change', async e => {
  const on = e.target.checked;
  try {
    await window.mcp?.relaySet(on);
    toast(on ? "Relay on — dialing" : "Relay off — direct-only", 's');
  } catch { toast("Relay toggle failed", 'e'); e.target.checked = !on; }
  if (document.querySelector('#pg-setup.on')) renderSetup();
});
$('suTunSwitch')?.addEventListener('change', e => setTunMode(e.target.checked ? lastTunMode : 'off'));
$('suTsSwitch')?.addEventListener('change', async e => {
  if (e.target.checked) { await window.mcp?.tailscaleServe(false); toast('Tailnet serve requested', 's'); }
  else { await window.mcp?.tailscaleOff(); toast('Tailnet serve stopped', 's'); }
  refreshTunnel();
});
$('suDashSwitch')?.addEventListener('change', async e => {
  await window.mcp?.dashSet(e.target.checked);
  toast(e.target.checked ? "Dashboard on" : "Dashboard off — /app and /dashboard return 404", 's');
  refreshTunnel();
});
$('btnSuRetry')?.addEventListener('click', retryRelayConn);
$('btnSuWizard')?.addEventListener('click', () => wizOpen());
$('btnSuFunnel')?.addEventListener('click', async () => {
  if (!confirm("Funnel publishes this PC to the public internet. Continue?")) return;
  await window.mcp?.tailscaleServe(true); toast('Funnel requested', 's'); refreshTunnel();
});
$('btnChoiceQuick')?.addEventListener('click', () => setTunMode('quick'));
$('btnChoiceCustom')?.addEventListener('click', () => wizOpen());
$('btnSuOpenDash')?.addEventListener('click', async () => {
  if (!ST.running) { toast('Start the server first', 'e'); return; }
  if (!dashOn) { toast('Dashboard is off — flip its switch first', 'e'); return; }
  try { await window.mcp?.openUrl(`http://localhost:${ST.serverPort || 3000}/app`); }
  catch { toast('Could not open dashboard', 'e'); }
});

// ── Custom-domain wizard ────────────────────────────────────────────────────
let wizStep = 0, wizTimer = null;

function wizShow(html) { const b = $('tunWizBody'); if (b) b.innerHTML = html; }
function wizOpen() {
  wizStep = 0;
  $('modal-tunnel')?.classList.add('show');
  wizRender();
  setTimeout(() => $('btnTunWizNext')?.focus(), 50);
}
function wizClose() {
  $('modal-tunnel')?.classList.remove('show');
  if (wizTimer) { clearInterval(wizTimer); wizTimer = null; }
}

async function wizRender() {
  const next = $('btnTunWizNext');
  if (next) { next.disabled = false; next.textContent = "Next"; }
  if (wizStep === 0) {
    let t = null;
    try { t = await window.mcp?.tunnelState(); } catch {}
    if (!t) { wizShow("Could not reach the backend."); if (next) next.style.display = "none"; return; }
    if (next) next.style.display = "";
    if (!t.cfInstalled) {
      wizShow(`<div class="step"><span class="step-n">1</span><span class="step-t">Install the Cloudflare connector (one click, winget).</span></div><div class="ccard-foot"><button class="button primary" id="wizInstall">Install cloudflared</button></div>`);
      $('wizInstall')?.addEventListener('click', async () => {
        toast('Installing — this takes a minute…');
        const r = await window.mcp?.tunnelInstall();
        if (r && r.ok) { wizStep = 1; wizRender(); } else toast((r && (r.hint || r.error)) || "Install failed", 'e');
      });
      if (next) next.style.display = "none";
    } else if (!t.loginDone) { wizStep = 1; wizRender(); }
    else if (!t.hasToken) { wizStep = 3; wizRender(); }
    else { wizStep = 4; wizRender(); }
  } else if (wizStep === 1) {
    if (next) next.style.display = "";
    wizShow(`<div class="step"><span class="step-n">2</span><span class="step-t">Log in — a Cloudflare page opens. Pick your domain, click through, come back here.</span></div><div class="ccard-foot"><button class="button primary" id="wizLogin">Open Cloudflare login</button></div><div class="step"><span class="step-t" id="wizLoginWait">Waiting…</span></div>`);
    $('wizLogin')?.addEventListener('click', async () => {
      await window.mcp?.tunnelLogin();
      let n = 0;
      if (wizTimer) clearInterval(wizTimer);
      wizTimer = setInterval(async () => {
        n++;
        let t = null;
        try { t = await window.mcp?.tunnelState(); } catch {}
        if (t && t.loginDone) { clearInterval(wizTimer); wizTimer = null; wizStep = 2; wizRender(); }
        else if (n > 120) { clearInterval(wizTimer); wizTimer = null; const w = $('wizLoginWait'); if (w) w.textContent = "Still waiting — finish the browser step, then press Next."; }
      }, 3000);
    });
  } else if (wizStep === 2) {
    wizShow(`<div class="step"><span class="step-n">3</span><span class="step-t">Logged in. Create the tunnel (reuses it if it exists).</span></div>`);
    if (next) { next.disabled = true; next.textContent = "Creating…"; }
    const r = await window.mcp?.tunnelCreate("pc-control");
    if (r && r.ok) { wizStep = 3; wizRender(); }
    else { wizShow(`Setup stopped: ${esc((r && r.error) || "create failed")}. Press Next to retry.`); }
  } else if (wizStep === 3) {
    wizShow(`<div class="step"><span class="step-n">4</span><span class="step-t">Which address should reach this PC?</span></div><div class="sr"><input class="inp" id="wizHost" placeholder="mcp.yourdomain.com"></div>`);
  } else {
    wizShow(`<div class="step"><span class="step-n">✓</span><span class="step-t">Custom domain live. Flip Tunnel mode to Custom domain to use it.</span></div><div class="ccard-foot"><button class="button primary" id="wizUse">Use custom domain now</button><button class="button" id="wizForget">Forget token</button></div>`);
    if (next) next.style.display = "none";
    $('wizUse')?.addEventListener('click', async () => { await window.mcp?.tunnelSetMode("custom"); wizClose(); refreshTunnel(); toast("Custom tunnel active", 's'); });
    $('wizForget')?.addEventListener('click', async () => { await window.mcp?.tunnelForget(); wizClose(); refreshTunnel(); });
  }
}

$('btnTunWizard')?.addEventListener('click', wizOpen);
$('btnTunWizCancel')?.addEventListener('click', wizClose);
$('btnTunWizNext')?.addEventListener('click', async () => {
  if (wizStep === 1) { toast("Use the login button above first", 'e'); return; }
  if (wizStep === 2) { wizRender(); return; }
  if (wizStep === 3) {
    const host = ($('wizHost')?.value || "").trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host) || host.includes("..")) { toast("Bare hostname only", 'e'); return; }
    const next = $('btnTunWizNext');
    if (next) { next.disabled = true; next.textContent = "Routing…"; }
    const r = await window.mcp?.tunnelRoute(host);
    if (next) { next.disabled = false; next.textContent = "Next"; }
    if (r && r.ok) { wizStep = 4; wizRender(); }
    else toast((r && r.error) || "Route failed", 'e');
    return;
  }
  wizStep++;
  wizRender();
});

// ── Collapsible cards (persisted) ───────────────────────────────────────────
function colId(el) {
  if (el.id) return el.id;
  const head = el.querySelector(".settings-card-head h2, .endpoint-name");
  const slug = head ? head.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32) : "card";
  const page = el.closest(".page");
  return ((page && page.id) || "pg") + ":" + slug;
}
function applyCollapse() {
  let hidden = [];
  try { hidden = JSON.parse(localStorage.getItem("pc-collapsed") || "[]"); } catch {}
  document.querySelectorAll(".settings-card, .endpoint").forEach(el => {
    el.classList.toggle("collapsed", hidden.includes(colId(el)));
    const head = el.querySelector(":scope > .settings-card-head, :scope > .endpoint-top");
    if (head && !head.title) head.title = "Click to collapse / expand";
  });
  document.querySelectorAll("[data-toggle]").forEach(el => {
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    if (!el.hasAttribute("role")) el.setAttribute("role", "button");
  });
}
function saveCollapse() {
  const hidden = Array.from(document.querySelectorAll(".settings-card.collapsed, .endpoint.collapsed"), colId);
  try { localStorage.setItem("pc-collapsed", JSON.stringify(hidden)); } catch {}
}
document.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && !e.target.closest("button, input, select, textarea, a")) {
    const t = e.target.closest("[data-toggle]");
    if (t && typeof toggleCC === "function") { e.preventDefault(); toggleCC(t.dataset.toggle); }
  }
});
document.addEventListener("click", e => {
  if (e.target.closest("button, input, select, textarea, a, label.tog")) return;
  const head = e.target.closest(".settings-card-head, .endpoint-top");
  if (!head) return;
  const card = head.closest(".settings-card, .endpoint");
  if (!card) return;
  card.classList.toggle("collapsed");
  saveCollapse();
});
applyCollapse();

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
    setTimeout(() => $('btnAllow')?.focus(), 50);
    const respond = ok => { modal.classList.remove('show'); window.mcp.sendShellApprovalRes({ id:msg.id, approved:ok }); };
    $('btnDeny').onclick  = () => respond(false);
    $('btnAllow').onclick = () => respond(true);
  });
}

// ── IPC hooks ─────────────────────────────────────────────────────────────────
window.mcp?.onStatus(applyStatus);
window.mcp?.onLog(appendLog);

// ── Health tab ────────────────────────────────────────────────────────────────
let healthChart = null;

function fmtBytes(n) {
  if (!n || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i > 0 && v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
function fmtUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function themeVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function renderHealthCards(h) {
  const wrap = $('healthCards');
  if (!wrap) return;
  const cards = [
    { label: 'Runtime', value: h.ready ? 'Ready' : (h.running ? 'Starting' : 'Stopped'), ok: !!h.ready,
      sub: h.ready ? `${fmtUptime(h.serverUptimeMs)} uptime` : 'Not serving requests' },
    { label: 'Relay', value: h.relay.connected ? 'Connected' : 'Offline', ok: !!h.relay.connected,
      sub: h.relay.connected ? 'Hosted relay live' : (h.relay.error || 'Reconnecting…') },
    { label: 'Tunnel', value: h.tunnel.active ? 'Active' : 'Idle', ok: !!h.tunnel.active,
      sub: h.tunnel.url ? 'Fallback address live' : 'Not in use' },
    { label: 'Sessions', value: String(h.sessionCount), ok: h.sessionCount > 0,
      sub: h.sessionCount ? `${h.sessionCount} AI client connected` : 'None connected' },
    { label: 'Requests', value: String(h.totalReq), ok: h.totalReq > 0,
      sub: h.totalErr ? `${h.totalErr} failed` : 'No failures' },
    { label: 'Internet', value: h.internet ? 'Online' : 'Offline', ok: !!h.internet,
      sub: h.internet ? 'DNS reachable' : 'No connectivity' },
  ];
  wrap.innerHTML = cards.map(c => `
    <div class="hcard ${c.ok ? 'ok' : 'warn'}">
      <span class="hcard-dot"></span>
      <div>
        <div class="hcard-value">${esc(c.value)}</div>
        <div class="hcard-label">${esc(c.label)}</div>
        <div class="hcard-sub">${esc(c.sub)}</div>
      </div>
    </div>`).join('');
}

function renderHealthProcess(h) {
  const wrap = $('healthProc');
  if (!wrap) return;
  const app = h.appProc, srv = h.serverMetrics;
  const rows = [
    ['MCP runtime', srv ? fmtBytes(srv.memBytes) : '—', srv ? `${srv.cpuPct}%` : '—'],
    ['App UI process', app ? fmtBytes(app.memBytes) : '—', app ? `${app.cpuPct}%` : '—'],
    ['Sessions', String(h.sessionCount), ''],
    ['Tools advertised', String(h.toolCount), ''],
  ];
  wrap.innerHTML = `<div class="hproc-row head"><span>Component</span><span>Memory</span><span>CPU</span></div>` +
    rows.map(([a, b, c]) => `<div class="hproc-row"><span>${esc(a)}</span><span class="mono">${esc(b)}</span><span class="mono">${esc(c)}</span></div>`).join('');
}

function renderHealthTools(h) {
  const wrap = $('healthTools');
  if (!wrap) return;
  const total = h.tools.reduce((s, t) => s + t.total, 0);
  const cnt = $('healthToolCount');
  // Requests include MCP protocol chatter (session init, capability lists);
  // tool calls are actual executions. Show both so the numbers explain each other.
  if (cnt) cnt.textContent = `${total} tool call${total === 1 ? '' : 's'} · ${h.totalReq} request${h.totalReq === 1 ? '' : 's'}`;
  if (!h.tools.length) { wrap.innerHTML = '<div class="health-empty">No tool calls yet.</div>'; return; }
  const max = Math.max(...h.tools.map(t => t.total), 1);
  wrap.innerHTML = h.tools.map(t => {
    const okPct = t.total ? (t.ok / t.total) * 100 : 0;
    const w = (t.total / max) * 100;
    return `<div class="htool">
      <div class="htool-top">
        <span class="htool-name">${esc(t.name)}</span>
        <span class="htool-count">${t.total}${t.err ? ` · <b class="bad">${t.err} failed</b>` : ''}</span>
      </div>
      <div class="htool-track" style="width:${w}%"><div class="htool-ok" style="width:${okPct}%"></div></div>
    </div>`;
  }).join('');
}

function renderHealthErrors(h) {
  const wrap = $('healthErrors');
  if (!wrap) return;
  const cnt = $('healthErrCount');
  if (cnt) cnt.textContent = h.totalErr ? `${h.totalErr} total` : '';
  if (!h.errors.length) { wrap.innerHTML = '<div class="health-empty">No errors recorded. Good.</div>'; return; }
  wrap.innerHTML = h.errors.map(e => `
    <div class="herr">
      <span class="herr-time">${esc(e.time)}</span>
      <span class="herr-msg">${e.tool ? `<b>${esc(e.tool)}</b> ` : ''}${esc(e.msg)}</span>
    </div>`).join('');
}

function renderHealthChart(h) {
  const canvas = $('healthChart');
  const empty = $('healthChartEmpty');
  if (!canvas || typeof Chart === 'undefined') return;
  const buckets = h.buckets || [];
  const hasTraffic = buckets.some(b => b.req || b.err);
  if (empty) empty.style.display = hasTraffic ? 'none' : 'flex';

  const labels = buckets.map(b => new Date(b.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const req = buckets.map(b => b.req);
  const err = buckets.map(b => b.err);
  const teal = themeVar('--teal', '#9bc8bf');
  const red = themeVar('--red', '#d39a9e');
  const grid = themeVar('--line', '#292f33');
  const ink = themeVar('--muted', '#b0b8b7');

  if (healthChart) {
    const c = healthChart;
    c.data.labels = labels;
    c.data.datasets[0].data = req;
    c.data.datasets[1].data = err;
    c.data.datasets[0].borderColor = teal;
    c.data.datasets[1].borderColor = red;
    c.options.scales.x.ticks.color = ink;
    c.options.scales.y.ticks.color = ink;
    c.options.scales.x.grid.color = grid;
    c.options.scales.y.grid.color = grid;
    c.update('none');
    return;
  }

  healthChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Requests', data: req, borderColor: teal, backgroundColor: teal + '26', borderWidth: 2, tension: .35, fill: true, pointRadius: 0 },
        { label: 'Errors', data: err, borderColor: red, backgroundColor: red + '26', borderWidth: 2, tension: .35, fill: true, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: ink, maxTicksLimit: 7, font: { size: 10 } }, grid: { color: grid, drawTicks: false } },
        y: { beginAtZero: true, ticks: { color: ink, precision: 0, font: { size: 10 } }, grid: { color: grid, drawTicks: false } },
      },
    },
  });
}

async function refreshHealth() {
  if (!window.mcp || !window.mcp.getHealth) return;
  let h = null;
  try { h = await window.mcp.getHealth(); } catch { return; }
  if (!h) return;

  const pill = $('healthPill');
  if (pill) {
    const healthy = h.ready && h.relay.connected;
    pill.classList.toggle('on', healthy);
    pill.classList.toggle('warn', !healthy && !!h.running);
    pill.classList.toggle('off', !h.running);
    pill.innerHTML = `<i></i>${healthy ? 'Healthy' : (h.running ? 'Degraded' : 'Stopped')}`;
  }

  renderHealthCards(h);
  renderHealthProcess(h);
  renderHealthTools(h);
  renderHealthErrors(h);
  // Chart.js measures the canvas, so only draw it once the page is visible.
  if ($('pg-health')?.classList.contains('on')) renderHealthChart(h);
}

$('btnHealthRefresh')?.addEventListener('click', refreshHealth);
document.querySelector('[data-page="health"]')?.addEventListener('click', () => {
  if (healthChart) { healthChart.destroy(); healthChart = null; }
});
setInterval(() => { if (!document.hidden) refreshHealth(); }, 3000);

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  document.querySelectorAll('.page h1').forEach(heading => heading.tabIndex = -1);
  const s = window.mcp ? await window.mcp.getStatus() : null;
  applyStatus(s || { running:false, tunnelUrl:null, relayUrl:null, toolCount:TOOL_TOTAL, sessionCount:0, serverPort:3000 });
  updateToolBadge();
  refreshTunnel();
  renderLogs();
  refreshHealth();
  const config = await window.mcp?.getConfig() || {};
  await loadSettings();
  if (!config.ready) showOnboarding(config);
})();
