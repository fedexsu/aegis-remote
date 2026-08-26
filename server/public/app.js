'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let ws = null, admin = null, attachedId = null;
let frameW = 0, frameH = 0;
let devicesCache = [];
let deviceCards = new Map(); // id -> {el, sig} for in-place card reconciliation
let statsCache = { downloads: 0, installs: 0, conversion: 0, byKey: [] };
let filter = 'all';
let search = '';
const pressed = new Set();

// ---------------------------------------------------------------------------
// API + UI helpers
// ---------------------------------------------------------------------------
async function api(path, method, body) {
  const r = await fetch(path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = '<span class="tdot"></span><span></span>';
  el.querySelector('span:last-child').textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 2800);
}

// Promise-based modal. type: 'prompt' | 'confirm' | 'password'
function modal({ title, message, fields = [], confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const fieldHtml = fields.map((f, i) =>
      `<label class="field"><span>${f.label}</span>
        <input data-i="${i}" type="${f.type || 'text'}" placeholder="${f.placeholder || ''}" value="${f.value || ''}"/></label>`).join('');
    back.innerHTML = `<div class="modal">
      <h3></h3>${message ? '<p></p>' : ''}${fieldHtml}
      <div class="modal-actions">
        <button class="btn ghost" data-act="cancel">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${confirmText}</button>
      </div></div>`;
    back.querySelector('h3').textContent = title;
    if (message) back.querySelector('p').textContent = message;
    document.body.appendChild(back);
    const inputs = $$('input', back);
    if (inputs[0]) inputs[0].focus();
    const done = (val) => { back.remove(); resolve(val); };
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
    back.querySelector('[data-act="cancel"]').onclick = () => done(null);
    back.querySelector('[data-act="ok"]').onclick = () => {
      if (!fields.length) return done(true);
      done(inputs.map((i) => i.value));
    };
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') back.querySelector('[data-act="ok"]').click();
      if (e.key === 'Escape') done(null);
    });
  });
}

function relTime(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return 'a minute ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.floor(h / 24);
  if (d < 30) return d + (d === 1 ? ' day ago' : ' days ago');
  return new Date(ts).toLocaleDateString();
}
function fmtDate(ts) { return ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-err').textContent = '';
  const btn = $('#au-submit');
  btn.disabled = true;
  try {
    const data = await api('/api/login', 'POST', {
      email: $('#au-email').value.trim(),
      password: $('#au-pass').value,
    });
    showApp(data.admin);
  } catch (err) {
    $('#auth-err').textContent = err.message;
    btn.disabled = false;
  }
});

async function changePassword() {
  const vals = await modal({
    title: 'Change password',
    fields: [
      { label: 'Current password', type: 'password' },
      { label: 'New password (6+ characters)', type: 'password' },
    ],
    confirmText: 'Update password',
  });
  if (!vals) return;
  try {
    await api('/api/password', 'POST', { currentPassword: vals[0], newPassword: vals[1] });
    if (admin) admin.mustChangePassword = false;
    toast('Password changed', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
$('#change-pw').addEventListener('click', changePassword);

$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', 'POST'); } catch {}
  if (ws) try { ws.close(); } catch {}
  location.reload();
});

// ---------------------------------------------------------------------------
// App shell + navigation
// ---------------------------------------------------------------------------
function showApp(a) {
  admin = a;
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  const owner = a.role === 'owner';
  $('#side-name').textContent = a.name || a.email;
  $('#side-role').textContent = a.role || 'admin';
  $('#side-avatar').textContent = (a.name || a.email || 'A').charAt(0).toUpperCase();
  $('#set-user').textContent = a.email;
  $('#set-role').textContent = a.role || 'admin';
  $$('.owner-only').forEach((el) => (el.hidden = !owner));
  deviceCards.clear(); $('#devices').innerHTML = ''; // fresh card set for this account
  if (owner) loadAccounts();
  loadKeys();
  loadStats();
  loadAlerts();
  checkInstaller();
  loadBlankImage();
  connectWS();
  if (a.mustChangePassword) setTimeout(() => { toast('Please set your own password', ''); changePassword(); }, 500);
}
function showAuth() { $('#auth-view').hidden = false; $('#app-view').hidden = true; }

function goto(view) {
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  $$('.page').forEach((p) => (p.hidden = p.dataset.page !== view));
}
$$('.nav-item').forEach((n) => n.addEventListener('click', () => goto(n.dataset.view)));
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) goto(g.dataset.goto); });

(async function init() {
  try { const { admin: a } = await api('/api/me'); showApp(a); }
  catch { showAuth(); }
})();

// ---------------------------------------------------------------------------
// WebSocket (console)
// ---------------------------------------------------------------------------
let consoleReconnectT = null;
function connectWS() {
  if (consoleReconnectT) { clearTimeout(consoleReconnectT); consoleReconnectT = null; }
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'register', role: 'console' }));
    if (attachedId) backToDashboard(); // any live session was lost on the drop — reset the UI
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) { if (!$('#screen-wrap').classList.contains('rtc')) drawBinaryFrame(ev.data); return; } // JPEG frame (ignored while WebRTC video is up)
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'agents': devicesCache = msg.list; renderDevices(); break;
      case 'stats': applyStats(msg.stats); break;
      case 'attached': onAttached(msg); break;
      case 'frame': drawFrame(msg); break;
      case 'monitors': renderMonitors(msg); break;
      case 'rtc-offer': onRtcOffer(msg); break;
      case 'rtc-ice': if (rtcPc && msg.candidate) { rtcDiag.remoteCand.add(candType(msg.candidate)); rtcLog('remote candidate', candType(msg.candidate)); rtcPc.addIceCandidate(msg.candidate).catch((e) => rtcLog('addIceCandidate error', e.message)); } break;
      case 'control': $('#ctl-warn').hidden = msg.available !== false ? true : false; if (msg.available === false) toast('Control is blocked on this device (antivirus removed the input helper)', 'err'); break;
      case 'agentGone': toast('Device disconnected', 'err'); backToDashboard(); break;
      case 'error': toast(msg.text, 'err'); break;
      case 'info': toast(msg.text, 'ok'); break;
      case 'opStream': if (msg.reqId === termReqId) onOpStream(msg); else fsDispatch('stream', msg); break;
      case 'opEnd': if (msg.reqId === termReqId) onOpEnd(msg); else fsDispatch('end', msg); break;
      case 'opResult': fsDispatch('result', msg); break;
      case 'denied': showAuth(); break;
    }
  };
  // Auto-reconnect (e.g. after a relay redeploy) so Join and everything else keep
  // working without a page refresh.
  ws.onclose = () => { if (admin && !consoleReconnectT) consoleReconnectT = setTimeout(connectWS, 2000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
const DEV_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
// Inline SVG icon set (replaces emoji for a professional, theme-aware look).
const PW_ICONS = {
  lock: '<svg viewBox="0 0 24 24" class="ic"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>',
  logoff: '<svg viewBox="0 0 24 24" class="ic"><path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/></svg>',
  sleep: '<svg viewBox="0 0 24 24" class="ic"><path d="M21 12.8A8 8 0 1111 3a6.5 6.5 0 0010 9.8z"/></svg>',
  restart: '<svg viewBox="0 0 24 24" class="ic"><path d="M21 12a9 9 0 11-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  shutdown: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 3v9"/><path d="M7 6a8 8 0 1010 0"/></svg>',
};
const KA_ICON = '<svg viewBox="0 0 24 24" class="ic"><path d="M4 8h13v5a4 4 0 01-4 4H8a4 4 0 01-4-4z"/><path d="M17 9h2a2 2 0 010 4h-2"/><path d="M7 3v2M11 3v2M15 3v2"/></svg>';
const ALERT_ICONS = {
  install: '<svg viewBox="0 0 24 24" class="ic" style="color:var(--green)"><path d="M20 6L9 17l-5-5"/></svg>',
  online: '<svg viewBox="0 0 24 24" class="ic" style="color:var(--green)"><path d="M5 12.5a10 10 0 0114 0"/><path d="M8.5 15.5a5 5 0 017 0"/><path d="M12 19h.01"/></svg>',
  offline: '<svg viewBox="0 0 24 24" class="ic" style="color:var(--red)"><path d="M12 3v9"/><path d="M7 6a8 8 0 1010 0"/><path d="M3 3l18 18"/></svg>',
  uninstall: '<svg viewBox="0 0 24 24" class="ic" style="color:var(--txt3)"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
};

function fmtIdle(s) {
  if (s == null) return '';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h';
}
function presenceInfo(d) {
  if (!d.online || !d.presence) return null;
  const p = d.presence;
  if (p.state === 'locked') return { cls: 'locked', text: 'Locked' };
  if (p.state === 'idle') return { cls: 'idle', text: 'Idle ' + fmtIdle(p.idle) };
  if (p.state === 'active') return { cls: 'active', text: 'In use' };
  return null;
}
function statusOf(d) {
  if (d.online) return d.busy ? 'busy' : 'online';
  if (d.uninstalled) return 'uninstalled';
  if (d.asleep) return 'sleep';
  return 'offline';
}
function closeCardMenus(except) { $$('.card-menu').forEach((m) => { if (m !== except) m.hidden = true; }); }
document.addEventListener('click', () => closeCardMenus(null));
function statusLabel(s) {
  return s === 'busy' ? 'In session' : s === 'online' ? 'Online'
    : s === 'uninstalled' ? 'Uninstalled' : s === 'sleep' ? 'Sleeping' : 'Offline';
}

function renderDevices() {
  const list = devicesCache;
  const online = list.filter((d) => d.online).length;
  const busy = list.filter((d) => d.busy).length;
  const uninstalled = list.filter((d) => statusOf(d) === 'uninstalled').length;
  const sleeping = list.filter((d) => statusOf(d) === 'sleep').length;
  $('#st-total').textContent = list.length;
  $('#st-online').textContent = online;
  $('#st-busy').textContent = busy;
  $('#st-sleep').textContent = sleeping;
  $('#st-offline').textContent = list.length - online - uninstalled - sleeping;
  $('#st-uninstalled').textContent = uninstalled;

  const q = search.toLowerCase();
  const shown = list.filter((d) => {
    const st = statusOf(d);
    if (filter === 'online' && !d.online) return false;
    if (filter === 'sleep' && st !== 'sleep') return false;
    if (filter === 'offline' && st !== 'offline') return false;
    if (filter === 'uninstalled' && st !== 'uninstalled') return false;
    if (q) {
      const hay = (d.name + ' ' + (d.meta?.host || '') + ' ' + (d.meta?.os || '') + ' ' + (d.meta?.user || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const box = $('#devices');
  $('#dev-empty').hidden = list.length !== 0;
  box.hidden = list.length === 0;

  // Reconcile in place: update existing cards, create/remove only as needed, so
  // the list never flashes/rebuilds on a presence or stats push.
  const seen = new Set();
  for (const d of shown) {
    seen.add(d.id);
    const st = statusOf(d);
    const sig = st + '|' + (d.online ? 1 : 0) + '|' + (d.busy ? 1 : 0); // structure-affecting state
    let entry = deviceCards.get(d.id);
    if (!entry || entry.sig !== sig) {
      const el = createDeviceCard(d, st);
      el.classList.add('enter');
      if (entry) entry.el.replaceWith(el); else box.appendChild(el);
      deviceCards.set(d.id, { el, sig });
    } else {
      updateDeviceCard(entry.el, d, st);
    }
  }
  for (const [id, entry] of deviceCards) if (!seen.has(id)) { entry.el.remove(); deviceCards.delete(id); }
  // keep DOM order matching `shown` (moving nodes doesn't restart animations)
  for (const d of shown) { const e = deviceCards.get(d.id); if (e) box.appendChild(e.el); }
}
// ScreenConnect-style compact row. OS icon · status dot · name/user@host ·
// presence · last seen · Join + kebab. All actions live in the right-click menu.
const WIN_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5.4l7.2-1v7.1H3zM11 4.3L21 3v9.1H11zM3 12.5h7.2v7.1l-7.2-1zM11 12.5h10V21l-10-1.4z"/></svg>';
const APPLE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 3c.1 1.1-.3 2.1-1 2.9-.7.8-1.7 1.4-2.7 1.3-.1-1 .4-2.1 1-2.8.7-.8 1.9-1.4 2.7-1.4zM19 17c-.5 1.2-.8 1.7-1.5 2.7-1 1.4-2.3 3.1-4 3.1-1.5 0-1.9-1-3.9-1s-2.5 1-3.9 1c-1.7 0-3-1.6-3.9-2.9-2.6-3.7-2.9-8.1-1.3-10.4 1.1-1.7 2.9-2.7 4.6-2.7 1.7 0 2.8 1 4.2 1 1.4 0 2.2-1 4.2-1 1.5 0 3.1.8 4.2 2.2-3.7 2-3.1 7.3.2 8.7z"/></svg>';
const KEBAB_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';
const CM = {
  join: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9z"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>',
  files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h6l2 2h10v10H3z"/></svg>',
  sys: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5 7 4-14 2.5 7h5"/></svg>',
  deploy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 21h16"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
};
function osIcon(m) {
  const os = (m.os || '').toLowerCase();
  if (os.includes('mac') || os.includes('darwin')) return APPLE_ICON;
  return WIN_ICON; // all current agents are Windows
}
function updateDeviceCard(el, d, st) {
  const m = d.meta || {};
  const nameEl = el.querySelector('.dr-name');
  nameEl.textContent = d.name; nameEl.title = d.id;
  el.querySelector('.dr-status').className = 'dr-status st-' + st;
  el.querySelector('.dr-status').title = statusLabel(st);
  el.querySelector('.dr-sub').textContent = [(m.user || ''), (m.host || '')].filter(Boolean).join(' · ') + (m.os ? '  ·  ' + m.os : '');
  const pres = presenceInfo(d);
  const pe = el.querySelector('.dr-presence');
  pe.className = 'dr-presence' + (pres ? ' presence ' + pres.cls : '');
  pe.textContent = pres ? pres.text : '';
  el.querySelector('.dr-seen').textContent = d.online ? statusLabel(st) : (st === 'uninstalled' ? relTime(d.uninstalledAt) : relTime(d.lastSeen));
}
function createDeviceCard(d, st) {
  const m = d.meta || {};
  const el = document.createElement('div');
  el.className = 'device-row' + (d.online ? ' online' : '') + (d.busy ? ' busy' : '') + (st === 'uninstalled' ? ' uninstalled' : '') + (st === 'sleep' ? ' asleep' : '');
  el.dataset.id = d.id;
  el.innerHTML = `
      <span class="dr-os">${osIcon(m)}</span>
      <span class="dr-status st-${st}"><span class="status-dot"></span></span>
      <div class="dr-main"><span class="dr-name"></span><span class="dr-sub"></span></div>
      <span class="dr-presence"></span>
      <span class="dr-seen"></span>
      <div class="dr-actions">
        ${d.online && !d.busy ? '<button class="btn primary xs dr-join">Join</button>' : (d.busy ? '<span class="dr-busy">In use</span>' : '')}
        <button class="btn ghost icon-btn dr-more" title="Actions">${KEBAB_ICON}</button>
      </div>`;
  updateDeviceCard(el, d, st);
  const join = el.querySelector('.dr-join');
  if (join) join.addEventListener('click', (e) => { e.stopPropagation(); attach(d.id); });
  el.querySelector('.dr-more').addEventListener('click', (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); showDeviceMenu(d, r.right - 4, r.bottom + 4); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); showDeviceMenu(d, e.clientX, e.clientY); });
  el.addEventListener('dblclick', () => { if (d.online && !d.busy) attach(d.id); });
  return el;
}
// Right-click / kebab context menu — the ScreenConnect-style action list.
let ctxMenuEl = null;
function closeDeviceMenu() { if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; } }
document.addEventListener('click', closeDeviceMenu);
window.addEventListener('resize', closeDeviceMenu);
async function powerAction(d, action) {
  const label = POWER_LABEL[action] || action;
  if (POWER_CONFIRM[action]) { const ok = await modal({ title: label + '?', message: POWER_CONFIRM[action], confirmText: label, danger: action !== 'sleep' }); if (!ok) return; }
  deviceOp(d.id, 'power', { action }, { onResult: (m) => toast(m.ok ? label + ' sent' : (m.error || 'failed'), m.ok ? 'ok' : 'err') });
}
function showDeviceMenu(d, x, y) {
  closeDeviceMenu();
  const items = [];
  if (d.online && !d.busy) items.push({ label: 'Join', icon: CM.join, act: () => attach(d.id), primary: true });
  if (d.online) {
    items.push({ label: 'Terminal', icon: CM.term, act: () => openTerminal(d) });
    items.push({ label: 'File transfer', icon: CM.files, act: () => openFiles(d) });
    items.push({ label: 'System monitor', icon: CM.sys, act: () => openSystem(d) });
    items.push({ label: 'Deploy software', icon: CM.deploy, act: () => { openSystem(d); setTimeout(() => sysTab('deploy'), 0); } });
    items.push({ sep: true });
    items.push({ label: 'Lock local input', act: () => deviceOp(d.id, 'lockinput', { on: true }, { onResult: (m) => toast(m.ok ? 'Local input locked' : (m.error || 'failed'), m.ok ? 'ok' : 'err') }) });
    items.push({ label: 'Sign out user', act: () => powerAction(d, 'logoff') });
    items.push({ label: 'Sleep', act: () => powerAction(d, 'sleep') });
    items.push({ label: 'Restart', act: () => powerAction(d, 'restart') });
    items.push({ label: 'Reboot to Safe Mode', act: () => powerAction(d, 'safemode') });
    items.push({ label: 'Reboot to Normal Mode', act: () => powerAction(d, 'normalmode') });
    items.push({ label: 'Shut down', act: () => powerAction(d, 'shutdown'), danger: true });
    items.push({ sep: true });
  }
  items.push({ label: 'Rename', icon: CM.edit, act: () => renameDevice(d) });
  items.push({ label: 'Remove', icon: CM.del, act: () => removeDevice(d), danger: true });
  const menu = document.createElement('div'); menu.className = 'ctx-menu';
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.primary ? ' primary' : '');
    b.innerHTML = (it.icon || '<span style="width:16px"></span>') + '<span>' + it.label + '</span>';
    b.addEventListener('click', () => { closeDeviceMenu(); it.act(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  ctxMenuEl = menu;
}
function attach(id) {
  // Auto-fullscreen the session (called within the click gesture, so it's allowed).
  try { if (!document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch {}
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'attach', agentId: id }));
}
function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  } catch {}
}

async function renameDevice(d) {
  const vals = await modal({ title: 'Rename device', fields: [{ label: 'Name', value: d.name }], confirmText: 'Save' });
  if (!vals || !vals[0].trim()) return;
  try { await api('/api/devices/rename', 'POST', { id: d.id, name: vals[0].trim() }); toast('Renamed', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}
async function removeDevice(d) {
  const ok = await modal({
    title: 'Remove device?',
    message: d.online
      ? `"${d.name}" is currently online. Removing it disconnects it now — but if the agent is still installed on that PC it will re-appear on next reconnect. To remove permanently, uninstall Aegis from that machine.`
      : `Forget "${d.name}"? This removes it from your list.`,
    confirmText: 'Remove', danger: true,
  });
  if (!ok) return;
  try { await api('/api/devices/remove', 'POST', { id: d.id }); toast('Device removed', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}

$('#dev-search').addEventListener('input', (e) => { search = e.target.value; renderDevices(); });
$('#refresh-dev').addEventListener('click', () => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'list' })); toast('Refreshed'); });
$$('#dev-filter .seg-btn').forEach((b) => b.addEventListener('click', () => {
  $$('#dev-filter .seg-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); filter = b.dataset.f; renderDevices();
}));

// ---------------------------------------------------------------------------
// Enrollment keys / links
// ---------------------------------------------------------------------------
const LINK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/></svg>';

async function loadKeys() {
  try {
    const { keys } = await api('/api/keys');
    const box = $('#keys');
    box.innerHTML = '';
    for (const k of keys) {
      const row = document.createElement('div');
      row.className = 'linkrow' + (k.revoked ? ' revoked' : '');
      row.dataset.key = k.key;
      row.innerHTML = `
        <div class="link-ic">${LINK_SVG}</div>
        <div class="link-body">
          <div class="link-label"></div>
          <div class="link-url"></div>
          <div class="link-stats">
            <span class="chip dl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0l-4 4m4-4l4 4"/><path d="M4 20h16"/></svg><b class="c-dl">0</b> downloads</span>
            <span class="chip in"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg><b class="c-in">0</b> installs</span>
          </div>
        </div>
        <div class="link-actions"></div>`;
      row.querySelector('.link-label').textContent = k.label;
      row.querySelector('.link-url').textContent = k.downloadUrl;
      const acts = row.querySelector('.link-actions');
      if (k.revoked) {
        acts.innerHTML = '<span class="tag revoked">Revoked</span>';
        const un = document.createElement('button');
        un.className = 'btn ghost small'; un.textContent = 'Re-activate';
        un.title = 'Turn this link back on (reconnects machines enrolled with it, after they restart)';
        un.addEventListener('click', async () => { await api('/api/keys/unrevoke', 'POST', { key: k.key }); toast('Link re-activated', 'ok'); loadKeys(); });
        acts.appendChild(un);
      } else {
        const copy = document.createElement('button');
        copy.className = 'btn ghost small'; copy.textContent = 'Copy link';
        copy.addEventListener('click', () => navigator.clipboard.writeText(k.downloadUrl).then(() => { copy.textContent = 'Copied ✓'; toast('Link copied', 'ok'); setTimeout(() => (copy.textContent = 'Copy link'), 1500); }));
        const rev = document.createElement('button');
        rev.className = 'btn danger small'; rev.textContent = 'Revoke';
        rev.addEventListener('click', async () => {
          const ok = await modal({ title: 'Revoke link?', message: `⚠ This disconnects EVERY device already installed with "${k.label}" — they'll drop offline immediately and can't reconnect until you re-activate the link. Only revoke if you want to cut those machines off.`, confirmText: 'Revoke', danger: true });
          if (!ok) return;
          await api('/api/keys/revoke', 'POST', { key: k.key }); toast('Link revoked', 'ok'); loadKeys();
        });
        acts.append(copy, rev);
      }
      box.appendChild(row);
    }
    applyStats(statsCache); // fill per-link chips with the latest counts
  } catch { /* not signed in */ }
}

// ---- live download/install metrics ----
async function loadStats() {
  try { const { stats } = await api('/api/stats'); applyStats(stats); } catch {}
}
function setNum(el, val) {
  if (!el) return;
  const prev = el.textContent;
  el.textContent = val;
  if (String(prev) !== String(val)) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}
function applyStats(s) {
  if (!s) return;
  statsCache = s;
  setNum($('#mt-downloads'), s.downloads || 0);
  setNum($('#mt-installs'), s.installs || 0);
  setNum($('#mt-active'), s.active != null ? s.active : (s.installs || 0));
  setNum($('#mt-conversion'), s.conversion || 0);
  setNum($('#mt-uninstalls'), s.uninstalls || 0);
  setNum($('#mt-unrate'), s.uninstallRate || 0);
  const map = {};
  for (const k of (s.byKey || [])) map[k.key] = k;
  $$('.linkrow').forEach((row) => {
    const k = map[row.dataset.key];
    if (!k) return;
    setNum(row.querySelector('.c-dl'), k.downloads || 0);
    setNum(row.querySelector('.c-in'), k.installs || 0);
  });
}
// Build Installer dialog (ScreenConnect-style): label the machines, pick a type,
// then copy the link or download the installer.
function openBuild() {
  ['#b-company', '#b-site', '#b-dept', '#b-devtype'].forEach((s) => ($(s).value = ''));
  $('#build-result').hidden = true;
  $('#build-create').disabled = false;
  $('#build-modal').hidden = false;
}
function closeBuild() { $('#build-modal').hidden = true; }
$('#new-key').addEventListener('click', openBuild);
$('#build-cancel').addEventListener('click', () => { closeBuild(); loadKeys(); });
$('#build-modal').addEventListener('click', (e) => { if (e.target.id === 'build-modal') { closeBuild(); loadKeys(); } });
$('#build-create').addEventListener('click', async () => {
  const meta = {
    company: $('#b-company').value.trim(),
    site: $('#b-site').value.trim(),
    department: $('#b-dept').value.trim(),
    deviceType: $('#b-devtype').value.trim(),
  };
  const label = meta.company || meta.deviceType || 'Installer';
  try {
    $('#build-create').disabled = true;
    const r = await api('/api/keys', 'POST', { label, meta });
    const url = r.downloadUrl;
    $('#build-link').value = url;
    $('#build-download').href = url;
    $('#build-result').hidden = false;
    toast('Installer built', 'ok');
  } catch (e) { $('#build-create').disabled = false; toast(e.message || 'failed', 'err'); }
});
$('#build-copy').addEventListener('click', () => {
  const url = $('#build-link').value;
  navigator.clipboard.writeText(url).then(() => toast('Link copied', 'ok')).catch(() => toast('Copy failed', 'err'));
});

async function checkInstaller() {
  try {
    const { ready } = await api('/api/installer');
    // Only the owner uploads the installer, so only they see the "upload it" nudge.
    $('#installer-banner').hidden = ready || !(admin && admin.role === 'owner');
  } catch {}
}
$('#installer-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('#upload-status').textContent = 'Uploading…';
  try {
    const r = await fetch('/api/installer', { method: 'POST', body: file });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'upload failed');
    $('#upload-status').textContent = `✓ Installer uploaded (${Math.round(d.size / 1048576)} MB)`;
    toast('Installer uploaded', 'ok');
    checkInstaller();
  } catch (err) {
    $('#upload-status').textContent = '';
    toast(err.message, 'err');
  }
});

// ---------------------------------------------------------------------------
// Telegram alerts
// ---------------------------------------------------------------------------
const ALERT_META = [
  { key: 'install', name: 'New install', badge: ALERT_ICONS.install, desc: 'a machine enrolls' },
  { key: 'online', name: 'Back online', badge: ALERT_ICONS.online, desc: 'a device recovers from offline' },
  { key: 'offline', name: 'Went offline', badge: ALERT_ICONS.offline, desc: 'a device drops for over a minute' },
  { key: 'uninstall', name: 'Uninstalled', badge: ALERT_ICONS.uninstall, desc: 'the agent is removed' },
];
async function loadAlerts() {
  try {
    const { alerts } = await api('/api/alerts');
    $('#al-token').value = alerts.botToken || '';
    $('#al-chat').value = alerts.chatId || '';
    const box = $('#alerts-rules'); box.innerHTML = '';
    for (const meta of ALERT_META) {
      const r = alerts.rules[meta.key] || { on: false, template: '' };
      const el = document.createElement('div');
      el.className = 'alert-rule'; el.dataset.key = meta.key;
      el.innerHTML = `<div class="ar-top">
          <span class="ar-name"><span>${meta.badge}</span> ${meta.name} <span class="ar-badge">when ${meta.desc}</span></span>
          <label class="switch"><input type="checkbox" class="ar-on" ${r.on ? 'checked' : ''}/><span class="track"></span></label>
        </div>
        <textarea class="ar-tpl" ${r.on ? '' : 'disabled'}></textarea>`;
      el.querySelector('.ar-tpl').value = r.template || '';
      const on = el.querySelector('.ar-on'), tpl = el.querySelector('.ar-tpl');
      on.addEventListener('change', () => { tpl.disabled = !on.checked; });
      box.appendChild(el);
    }
  } catch { /* not signed in */ }
}
function collectAlerts() {
  const rules = {};
  $$('#alerts-rules .alert-rule').forEach((el) => {
    rules[el.dataset.key] = { on: el.querySelector('.ar-on').checked, template: el.querySelector('.ar-tpl').value };
  });
  return { botToken: $('#al-token').value.trim(), chatId: $('#al-chat').value.trim(), rules };
}
$('#alerts-save').addEventListener('click', async () => {
  try { await api('/api/alerts', 'POST', collectAlerts()); toast('Alerts saved', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
});
$('#alerts-test').addEventListener('click', async () => {
  const c = collectAlerts();
  try { await api('/api/alerts/test', 'POST', { botToken: c.botToken, chatId: c.chatId }); toast('Test sent — check Telegram', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
});

// ---------------------------------------------------------------------------
// Accounts (owner)
// ---------------------------------------------------------------------------
async function loadAccounts() {
  try {
    const { accounts } = await api('/api/accounts');
    const box = $('#accounts');
    box.innerHTML = '';
    $('#acct-empty').hidden = accounts.length !== 0;
    for (const a of accounts) {
      const row = document.createElement('div');
      row.className = 'acctrow';
      row.innerHTML = `<div class="acct-av"></div><div><div class="acct-name"></div><div class="acct-sub"></div></div>`;
      row.querySelector('.acct-av').textContent = (a.username || '?').charAt(0).toUpperCase();
      row.querySelector('.acct-name').textContent = a.username;
      row.querySelector('.acct-sub').textContent = (a.name && a.name !== a.username ? a.name + ' · ' : '') + 'created ' + fmtDate(a.createdAt);
      box.appendChild(row);
    }
  } catch { /* not owner */ }
}
$('#gen-account').addEventListener('click', async () => {
  const vals = await modal({ title: 'Generate customer account', fields: [{ label: 'Customer name / label (optional)', placeholder: 'Acme Corp' }], confirmText: 'Generate' });
  if (!vals) return;
  try {
    const d = await api('/api/accounts', 'POST', { name: vals[0] || '' });
    const out = $('#account-out');
    out.hidden = false;
    out.innerHTML = `<h4>✓ Account created — give these to the customer</h4>
      <div class="cred-grid">
        <span class="ck">Username</span><span class="cv" id="cu"></span><button class="btn ghost small" data-c="cu">Copy</button>
        <span class="ck">Password</span><span class="cv" id="cp"></span><button class="btn ghost small" data-c="cp">Copy</button>
      </div>
      <div class="cred-note">They'll be prompted to change the password on first login.</div>`;
    $('#cu', out).textContent = d.username;
    $('#cp', out).textContent = d.password;
    $$('[data-c]', out).forEach((b) => b.addEventListener('click', () => { navigator.clipboard.writeText($('#' + b.dataset.c, out).textContent); toast('Copied', 'ok'); }));
    loadAccounts();
  } catch (e) { toast(e.message, 'err'); }
});

// ---------------------------------------------------------------------------
// Remote terminal (op channel)
// ---------------------------------------------------------------------------
let termReqId = null, termAgentId = null;
const newReqId = () => (crypto && crypto.randomUUID ? crypto.randomUUID() : 'r' + Date.now() + Math.round(Math.random() * 1e6));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function openTerminal(d) {
  termReqId = newReqId();
  termAgentId = d.id;
  $('#term-name').textContent = d.name;
  $('#term-host').textContent = (d.meta && d.meta.os) ? d.meta.os : '';
  $('#term-out').textContent = '';
  $('#term-view').hidden = false;
  sendOp('term-open', {});
  setTimeout(() => $('#term-input').focus(), 50);
}
function closeTerminal() {
  if (termReqId) sendOp('term-close', {});
  termReqId = null; termAgentId = null;
  $('#term-view').hidden = true;
}
function sendOp(op, payload) {
  if (ws && ws.readyState === ws.OPEN && termReqId) {
    ws.send(JSON.stringify({ type: 'op', agentId: termAgentId, op, reqId: termReqId, payload: payload || {} }));
  }
}
function termAppend(text) {
  const out = $('#term-out');
  const atBottom = out.parentElement.scrollTop + out.parentElement.clientHeight >= out.parentElement.scrollHeight - 40;
  out.textContent += stripAnsi(text);
  if (atBottom) out.parentElement.scrollTop = out.parentElement.scrollHeight;
}
function onOpStream(msg) { if (msg.reqId === termReqId) termAppend(msg.chunk || ''); }
function onOpEnd(msg) {
  if (msg.reqId !== termReqId) return;
  termAppend(msg.ok === false ? `\n[error: ${msg.error || 'session ended'}]\n` : '\n[session closed]\n');
  termReqId = null;
}
$('#term-back').addEventListener('click', closeTerminal);
$('#term-clear').addEventListener('click', () => { $('#term-out').textContent = ''; });
$('#term-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const line = e.target.value;
  e.target.value = '';
  if (!termReqId) { termAppend('\n[session closed — reopen the terminal]\n'); return; }
  sendOp('term-input', { data: line + '\r\n' });
});

// ---------------------------------------------------------------------------
// File browser + transfer (op channel)
// ---------------------------------------------------------------------------
let filesAgentId = null, filesPath = '';
const fsOps = new Map(); // reqId -> { onResult, onStream, onEnd }

function fsDispatch(kind, msg) {
  const h = fsOps.get(msg.reqId);
  if (!h) return;
  if (kind === 'stream') { h.onStream && h.onStream(msg); return; }
  fsOps.delete(msg.reqId);
  if (kind === 'result') h.onResult && h.onResult(msg);
  else h.onEnd && h.onEnd(msg);
}
function opRaw(op, reqId, payload) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'op', agentId: filesAgentId, op, reqId, payload: payload || {} }));
}
function fsRequest(op, payload, handlers) {
  const reqId = newReqId();
  if (handlers) fsOps.set(reqId, handlers);
  opRaw(op, reqId, payload);
  return reqId;
}
// Send an op to a specific device (used by the card's Power popout), routed back
// through the shared op registry (fsDispatch handles opResult).
function deviceOp(agentId, op, payload, handlers) {
  const reqId = newReqId();
  if (handlers) fsOps.set(reqId, handlers);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'op', agentId, op, reqId, payload: payload || {} }));
  return reqId;
}
const joinPath = (base, name) => (!base ? name : (base.endsWith('\\') ? base + name : base + '\\' + name));
function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
}

function openFiles(d) {
  filesAgentId = d.id;
  $('#files-name').textContent = d.name;
  $('#files-view').hidden = false;
  loadDir('');
}
function closeFiles() { $('#files-view').hidden = true; filesAgentId = null; }
function loadDir(p) {
  fsRequest('fs-list', { path: p }, { onResult: (m) => {
    if (!m.ok) { toast(m.error || 'cannot open', 'err'); return; }
    filesPath = m.data.path;
    renderCrumbs(m.data.path);
    renderFiles(m.data);
    $('#files-up').disabled = false;
    $('#files-up').dataset.parent = m.data.parent || '';
  } });
}
function renderCrumbs(p) {
  const box = $('#files-crumbs');
  box.innerHTML = '';
  const root = document.createElement('span'); root.className = 'crumb'; root.textContent = 'Drives';
  root.addEventListener('click', () => loadDir(''));
  box.appendChild(root);
  if (!p) return;
  const parts = p.split('\\').filter(Boolean); // ["C:", "Users", "USER"]
  let acc = '';
  parts.forEach((seg, i) => {
    const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = '›'; box.appendChild(sep);
    acc = i === 0 ? seg + '\\' : acc + (acc.endsWith('\\') ? '' : '\\') + seg;
    const c = document.createElement('span'); c.className = 'crumb'; c.textContent = seg;
    const target = acc;
    c.addEventListener('click', () => loadDir(target));
    box.appendChild(c);
  });
}
const DIR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h6l2 2h10v10H3z"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/></svg>';
function renderFiles(data) {
  const body = $('#files-body'); body.innerHTML = '';
  $('#files-empty').hidden = data.entries.length !== 0;
  for (const e of data.entries) {
    const tr = document.createElement('tr'); tr.className = 'frow';
    tr.innerHTML = `<td><span class="fname ${e.isDir ? 'dir' : 'file'}">${e.isDir ? DIR_ICON : FILE_ICON}<span class="fn"></span></span></td>
      <td class="col-size">${e.isDir ? '' : fmtSize(e.size)}</td>
      <td class="col-mod">${e.mtime ? new Date(e.mtime).toLocaleString() : ''}</td>
      <td class="col-act"><span class="fact"></span></td>`;
    tr.querySelector('.fn').textContent = e.name;
    const full = joinPath(data.path, e.name);
    if (e.isDir) tr.querySelector('.fname').addEventListener('click', () => loadDir(e.name.endsWith(':\\') ? e.name : full));
    const act = tr.querySelector('.fact');
    if (!e.isDir) {
      const dl = document.createElement('button'); dl.title = 'Download';
      dl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 21h16"/></svg>';
      dl.addEventListener('click', () => downloadFile(full, e.name, e.size));
      act.appendChild(dl);
    }
    const del = document.createElement('button'); del.className = 'del'; del.title = 'Delete';
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
    del.addEventListener('click', () => deleteEntry(full, e.name));
    act.appendChild(del);
    body.appendChild(tr);
  }
}
function showFp(text, frac) { $('#files-progress').hidden = false; $('#fp-text').textContent = text; $('#fp-fill').style.width = Math.round((frac || 0) * 100) + '%'; }
function hideFp() { $('#files-progress').hidden = true; $('#fp-fill').style.width = '0'; }

function downloadFile(full, name, size) {
  const parts = []; let received = 0;
  showFp('Downloading ' + name + '…', 0);
  fsRequest('fs-get', { path: full }, {
    onStream: (m) => {
      if (m.b64) {
        const bin = atob(m.b64); const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        parts.push(arr); received += arr.length;
        showFp('Downloading ' + name + '…', size ? received / size : 0);
      }
    },
    onEnd: (m) => {
      hideFp();
      if (!m.ok) { toast(m.error || 'download failed', 'err'); return; }
      const blob = new Blob(parts);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('Downloaded ' + name, 'ok');
    },
  });
}
async function uploadFile(file) { return uploadFileTo(file, joinPath(filesPath, file.name), { onDone: () => loadDir(filesPath) }); }
// Chunked upload of a File to an explicit remote path. Used by the Files overlay
// and by drag-and-drop onto the live screen (targets the remote Desktop).
async function uploadFileTo(file, dest, opts) {
  opts = opts || {};
  const reqId = newReqId();
  fsOps.set(reqId, { onEnd: (m) => { hideFp(); if (m.ok) { if (!opts.silent) toast('Sent ' + file.name, 'ok'); if (opts.onDone) opts.onDone(); } else toast(m.error || 'transfer failed', 'err'); } });
  opRaw('fs-put-begin', reqId, { path: dest });
  const buf = new Uint8Array(await file.arrayBuffer());
  const CH = 192 * 1024;
  showFp('Sending ' + file.name + '…', 0);
  for (let off = 0; off < buf.length; off += CH) {
    const slice = buf.subarray(off, off + CH);
    opRaw('fs-put-chunk', reqId, { b64: bytesToB64(slice) });
    showFp('Sending ' + file.name + '…', buf.length ? off / buf.length : 1);
    while (ws && ws.bufferedAmount > 4e6) await new Promise((r) => setTimeout(r, 20));
  }
  opRaw('fs-put-end', reqId, {});
  showFp('Finishing ' + file.name + '…', 1);
}
function bytesToB64(bytes) {
  let bin = ''; const S = 0x8000;
  for (let i = 0; i < bytes.length; i += S) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + S));
  return btoa(bin);
}
async function deleteEntry(full, name) {
  const ok = await modal({ title: 'Delete?', message: `Permanently delete "${name}" from the remote PC?`, confirmText: 'Delete', danger: true });
  if (!ok) return;
  fsRequest('fs-del', { path: full }, { onResult: (m) => { if (m.ok) { toast('Deleted', 'ok'); loadDir(filesPath); } else toast(m.error || 'delete failed', 'err'); } });
}
$('#files-back').addEventListener('click', closeFiles);
$('#files-refresh').addEventListener('click', () => loadDir(filesPath));
$('#files-up').addEventListener('click', (e) => loadDir(e.currentTarget.dataset.parent || ''));
$('#files-mkdir').addEventListener('click', async () => {
  const vals = await modal({ title: 'New folder', fields: [{ label: 'Folder name' }], confirmText: 'Create' });
  if (!vals || !vals[0].trim()) return;
  fsRequest('fs-mkdir', { path: joinPath(filesPath, vals[0].trim()) }, { onResult: (m) => { if (m.ok) { toast('Folder created', 'ok'); loadDir(filesPath); } else toast(m.error || 'failed', 'err'); } });
});
$('#files-upload').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) uploadFile(f); e.target.value = ''; });
// Recursive filename search under the current folder.
$('#files-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const q = e.target.value.trim(); if (q) runFileSearch(q); else loadDir(filesPath); }
  if (e.key === 'Escape') { e.target.value = ''; loadDir(filesPath); }
});
function runFileSearch(q) {
  showFp('Searching for "' + q + '"…', 0);
  fsRequest('fs-search', { root: filesPath, query: q }, { onResult: (m) => {
    hideFp();
    if (!m.ok) { toast(m.error || 'search failed', 'err'); return; }
    renderSearchResults(m.data.entries || [], q);
  } });
}
function renderSearchResults(entries, q) {
  const body = $('#files-body'); body.innerHTML = '';
  $('#files-empty').hidden = entries.length !== 0;
  if (!entries.length) { toast('No matches for "' + q + '"'); return; }
  toast(entries.length + (entries.length === 300 ? '+' : '') + ' match' + (entries.length === 1 ? '' : 'es'), 'ok');
  for (const e of entries) {
    const tr = document.createElement('tr'); tr.className = 'frow';
    tr.innerHTML = `<td><span class="fname file">${FILE_ICON}<span class="fn"></span></span><div class="fpath-cell"></div></td>
      <td class="col-size">${fmtSize(e.size)}</td>
      <td class="col-mod">${e.mtime ? new Date(e.mtime).toLocaleString() : ''}</td>
      <td class="col-act"><span class="fact"></span></td>`;
    tr.querySelector('.fn').textContent = e.name;
    tr.querySelector('.fpath-cell').textContent = e.full;
    const act = tr.querySelector('.fact');
    const openBtn = document.createElement('button'); openBtn.title = 'Open containing folder';
    openBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h6l2 2h10v10H3z"/></svg>';
    openBtn.addEventListener('click', () => { const dir = e.full.substring(0, e.full.lastIndexOf('\\')); $('#files-search').value = ''; loadDir(dir); });
    act.appendChild(openBtn);
    const dl = document.createElement('button'); dl.title = 'Download';
    dl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 21h16"/></svg>';
    dl.addEventListener('click', () => downloadFile(e.full, e.name, e.size));
    act.appendChild(dl);
    body.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// System overlay: monitor / processes / clipboard (op channel)
// ---------------------------------------------------------------------------
let sysAgentId = null, monReqId = null, procAutoTimer = null, procData = [], sysDeviceMeta = {};
const cpuHist = [], memHist = [];

function openSystem(d) {
  sysAgentId = d.id;
  sysDeviceMeta = d.meta || {};
  hwCache = null; // inventory is per-device
  $('#sys-name').textContent = d.name;
  $('#sys-view').hidden = false;
  cpuHist.length = 0; memHist.length = 0;
  sysTab('monitor');
  startMonitor();
}
function closeSystem() {
  stopMonitor();
  if (procAutoTimer) { clearInterval(procAutoTimer); procAutoTimer = null; }
  $('#proc-auto').checked = false;
  $('#sys-view').hidden = true;
  sysAgentId = null;
}
function sysOp(op, payload, handlers) {
  const reqId = newReqId();
  if (handlers) fsOps.set(reqId, handlers);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'op', agentId: sysAgentId, op, reqId, payload: payload || {} }));
  return reqId;
}
function sysTab(name) {
  $$('.sys-tabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.sys-tab').forEach((p) => (p.hidden = p.dataset.tabpage !== name));
  if (name === 'processes') refreshProcs();
  if (name === 'clipboard') getClip();
  if (name === 'inventory') loadHwInfo();
}
$$('.sys-tabs .seg-btn').forEach((b) => b.addEventListener('click', () => sysTab(b.dataset.tab)));
$('#sys-back').addEventListener('click', closeSystem);

// --- hardware / OS inventory ---
let hwCache = null;
const HW_E = (s) => (s == null || s === '') ? '—' : String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const HW_LINES = (arr) => (arr && arr.length) ? arr.map(HW_E).join('<br>') : '—';
function loadHwInfo(force) {
  if (hwCache && !force) return renderHwInfo(hwCache);
  $('#hw-body').innerHTML = '<div class="hint" style="padding:22px">Gathering hardware details…</div>';
  sysOp('hw-info', {}, { onResult: (m) => {
    if (m.ok && m.data && m.data.hw) { hwCache = m.data.hw; renderHwInfo(hwCache); }
    else $('#hw-body').innerHTML = '<div class="hint" style="padding:22px">Could not read inventory' + (m.error ? ' (' + HW_E(m.error) + ')' : '') + '.</div>';
  } });
}
function renderHwInfo(hw) {
  const rows = (arr) => arr.map(([k, v]) => `<div class="hw-row"><div class="hw-k">${k}</div><div class="hw-v">${v}</div></div>`).join('');
  const sec = (t, inner) => `<div class="hw-sec"><div class="hw-sec-t">${t}</div>${inner}</div>`;
  const cpu = hw.cpu || {}, os = hw.os || {}, bios = hw.bios || {}, board = hw.board || {};
  const ram = (hw.ramSlots || []).map((r) => `${r.capGB}GB${r.speed ? ' @ ' + r.speed + 'MHz' : ''}${r.part ? ' (' + r.part + ')' : ''}`);
  const disks = (hw.disks || []).map((d) => `${d.model || '?'} — ${d.sizeGB}GB${d.iface ? ' [' + d.iface + ']' : ''}${d.serial ? ' · SN ' + d.serial : ''}`);
  const net = (hw.net || []).map((n) => `${n.name || '?'} — ${n.mac || ''}`);
  $('#hw-body').innerHTML =
      sec('System', rows([
        ['Manufacturer', HW_E(hw.manufacturer)], ['Model', HW_E(hw.model)], ['Type', HW_E(hw.systemType)],
        ['Serial number', HW_E(hw.serial)], ['Motherboard', HW_E([board.mfr, board.product].filter(Boolean).join(' '))],
        ['BIOS', HW_E([bios.vendor, bios.version, bios.date].filter(Boolean).join(' · '))],
      ]))
    + sec('Processor', rows([
        ['CPU', HW_E(cpu.name)], ['Cores / threads', HW_E((cpu.cores || '?') + ' / ' + (cpu.threads || '?'))], ['Max clock', cpu.mhz ? HW_E(cpu.mhz + ' MHz') : '—'],
      ]))
    + sec('Memory', rows([['Total', hw.ramTotalGB ? HW_E(hw.ramTotalGB + ' GB') : '—'], ['Modules', HW_LINES(ram)]]))
    + sec('Graphics', rows([['GPU', HW_LINES(hw.gpu || [])]]))
    + sec('Storage', rows([['Drives', HW_LINES(disks)]]))
    + sec('Network', rows([['Adapters', HW_LINES(net)]]))
    + sec('Operating system', rows([
        ['OS', HW_E(os.caption)], ['Version', HW_E([os.version, os.build ? '(build ' + os.build + ')' : ''].filter(Boolean).join(' '))],
        ['Architecture', HW_E(os.arch)], ['Installed', HW_E(os.installed)], ['Last boot', HW_E(os.lastBoot)],
        ['Hostname', HW_E(hw.hostname)], ['Signed-in user', HW_E(hw.user)],
      ]));
}
$('#hw-refresh').addEventListener('click', () => loadHwInfo(true));

// --- software deployment ---
let depFile = null;
$('#dep-file').addEventListener('change', (e) => {
  depFile = (e.target.files && e.target.files[0]) || null;
  $('#dep-fname').textContent = depFile ? (depFile.name + ' · ' + fmtSize(depFile.size)) : 'No file chosen (.exe or .msi)';
});
$('#dep-run').addEventListener('click', () => {
  if (!depFile) { toast('Choose an installer first', 'err'); return; }
  if (depFile.size > 500 * 1024 * 1024) { toast('Installer too large (500MB max)', 'err'); return; }
  const args = $('#dep-args').value.trim();
  const elevated = $('#dep-elevated').checked;
  const msi = /\.msi$/i.test(depFile.name);
  const out = $('#dep-out');
  out.textContent = 'Uploading ' + depFile.name + '…';
  sysOp('paths', {}, { onResult: (m) => {
    if (!m.ok || !m.data.temp) { out.textContent = 'Could not resolve the remote temp folder.'; return; }
    const dest = joinPath(m.data.temp, depFile.name);
    filesAgentId = sysAgentId; // route file ops to this device
    uploadFileTo(depFile, dest, { silent: true, onDone: () => {
      out.textContent = 'Running ' + depFile.name + (elevated ? ' (elevated — check the remote screen for a UAC prompt)…' : '…');
      sysOp('deploy-run', { path: dest, args, msi, elevated }, { onResult: (r) => {
        if (!r.ok) { out.textContent = 'Failed: ' + (r.error || 'error'); toast('Deploy failed', 'err'); return; }
        const success = r.data.exitCode === 0;
        out.textContent = (success ? '✓ Success — ' : '') + 'exit code ' + r.data.exitCode + '\n\n' + (r.data.output || '');
        toast(success ? 'Deployed successfully' : 'Finished (exit ' + r.data.exitCode + ')', success ? 'ok' : 'err');
      } });
    } });
  } });
});

// --- monitor ---
function startMonitor() {
  monReqId = sysOp('sys-mon-start', {}, { onStream: (m) => { if (m.sample) renderSample(m.sample); } });
}
function stopMonitor() {
  if (monReqId) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'op', agentId: sysAgentId, op: 'sys-mon-stop', reqId: monReqId, payload: {} })); fsOps.delete(monReqId); monReqId = null; }
}
function spark(id, hist) {
  const pts = hist.map((v, i) => `${(i / Math.max(1, hist.length - 1) * 200).toFixed(1)},${(48 - v / 100 * 46 - 1).toFixed(1)}`).join(' ');
  $(id).setAttribute('points', pts);
}
function renderSample(s) {
  const memPct = s.memTotal ? Math.round(s.memUsed / s.memTotal * 100) : 0;
  cpuHist.push(s.cpu); if (cpuHist.length > 40) cpuHist.shift();
  memHist.push(memPct); if (memHist.length > 40) memHist.shift();
  $('#mon-cpu').textContent = s.cpu + '%';
  $('#mon-mem').textContent = memPct + '%';
  $('#mon-mem-sub').textContent = `${fmtSize(s.memUsed)} / ${fmtSize(s.memTotal)}`;
  spark('#cpu-line', cpuHist); spark('#mem-line', memHist);
  const dh = Math.floor(s.uptime / 3600), dm = Math.floor((s.uptime % 3600) / 60);
  $('#mon-uptime').textContent = `Uptime ${dh}h ${dm}m · ${s.cores} CPU cores`;
  const box = $('#mon-disks'); box.innerHTML = '';
  for (const d of (s.disks || [])) {
    const pct = d.total ? Math.round(d.used / d.total * 100) : 0;
    const el = document.createElement('div'); el.className = 'disk';
    el.innerHTML = `<div class="disk-top"><span>${d.name}</span><span>${fmtSize(d.used)} / ${fmtSize(d.total)} (${pct}%)</span></div><div class="disk-bar"><i class="${pct > 90 ? 'hot' : ''}" style="width:${pct}%"></i></div>`;
    box.appendChild(el);
  }
}

// --- processes ---
function refreshProcs() {
  sysOp('proc-list', {}, { onResult: (m) => {
    if (!m.ok) { toast(m.error || 'could not list processes', 'err'); return; }
    procData = m.data.procs || []; renderProcs();
  } });
}
function renderProcs() {
  const q = ($('#proc-search').value || '').toLowerCase();
  const rows = procData.filter((p) => !q || (p.ProcessName || '').toLowerCase().includes(q)).slice(0, 300);
  const body = $('#proc-body'); body.innerHTML = '';
  for (const p of rows) {
    const tr = document.createElement('tr'); tr.className = 'frow';
    tr.innerHTML = `<td><span class="fname file"><span class="fn"></span></span></td>
      <td class="col-size">${p.Id}</td><td class="col-size">${fmtSize(p.ws)}</td>
      <td class="col-size">${p.cpu != null ? p.cpu : ''}</td>
      <td class="col-act"><span class="fact"><button class="del" title="Kill process"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></span></td>`;
    tr.querySelector('.fn').textContent = p.ProcessName;
    tr.querySelector('.del').addEventListener('click', () => killProc(p));
    body.appendChild(tr);
  }
}
async function killProc(p) {
  const ok = await modal({ title: 'Kill process?', message: `End "${p.ProcessName}" (PID ${p.Id}) and its child processes on the remote PC?`, confirmText: 'Kill', danger: true });
  if (!ok) return;
  sysOp('proc-kill', { pid: p.Id }, { onResult: (m) => { if (m.ok) { toast('Killed ' + p.ProcessName, 'ok'); setTimeout(refreshProcs, 500); } else toast(m.error || 'could not kill', 'err'); } });
}
$('#proc-refresh').addEventListener('click', refreshProcs);
$('#proc-search').addEventListener('input', renderProcs);
$('#proc-auto').addEventListener('change', (e) => {
  if (procAutoTimer) { clearInterval(procAutoTimer); procAutoTimer = null; }
  if (e.target.checked) procAutoTimer = setInterval(refreshProcs, 3000);
});

// --- clipboard ---
function getClip() {
  sysOp('clip-get', {}, { onResult: (m) => {
    if (!m.ok) { toast(m.error || 'could not read clipboard', 'err'); return; }
    if (m.data.kind === 'image' && m.data.image) {
      $('#clip-img').src = m.data.image; $('#clip-img-wrap').hidden = false; $('#clip-text').value = '';
    } else {
      $('#clip-img-wrap').hidden = true; $('#clip-text').value = m.data.text || '';
    }
  } });
}
$('#clip-get').addEventListener('click', getClip);
// Paste an image (Ctrl+V) into the clipboard pane → push it to the remote clipboard.
$('#clip-text').addEventListener('paste', (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const f = it.getAsFile(); if (!f) continue;
      const rd = new FileReader();
      rd.onload = () => sysOp('clip-set', { image: rd.result }, { onResult: (m) => { if (m.ok) toast('Image sent to remote clipboard', 'ok'); else toast(m.error || 'failed', 'err'); } });
      rd.readAsDataURL(f); e.preventDefault(); return;
    }
  }
});
$('#clip-set').addEventListener('click', () => {
  sysOp('clip-set', { text: $('#clip-text').value }, { onResult: (m) => { if (m.ok) toast('Remote clipboard set', 'ok'); else toast(m.error || 'failed', 'err'); } });
});

// Power labels/confirmations — used by the card's Power popout (see renderDevices).
const POWER_LABEL = { lock: 'Lock', logoff: 'Sign out', sleep: 'Sleep', restart: 'Restart', shutdown: 'Shut down', safemode: 'Reboot to Safe Mode', normalmode: 'Reboot to Normal Mode' };
const POWER_CONFIRM = {
  restart: 'Restart the remote PC now? It will reconnect automatically at login.',
  shutdown: 'Shut down the remote PC now? You will NOT be able to power it back on remotely.',
  sleep: 'Put the remote PC to sleep now? It will disconnect.',
  safemode: 'Reboot into Safe Mode? Needs admin on the remote (a UAC prompt may appear). The PC restarts into Safe Mode; use "Reboot to Normal Mode" to return.',
  normalmode: 'Reboot back to Normal Mode? Needs admin on the remote (a UAC prompt may appear).',
};

// ---------------------------------------------------------------------------
// Control session
// ---------------------------------------------------------------------------
const canvas = $('#screen');
const ctx = canvas.getContext('2d');
const img = new Image();

let blankOn = false;
function updateBlankBtn() {
  const b = $('#blank-btn');
  b.classList.toggle('on', blankOn); // toggle tile — fixed label, switch shows state
  // Drive the synthetic cursor: while blanked the remote cursor is hidden, so
  // show our own pointer in the view (and hide the browser cursor over the canvas).
  $('#screen-wrap').classList.toggle('blank', blankOn);
  if (blankOn) positionSynthCursor();
}
// Track the technician's pointer over the screen so the synthetic cursor sits
// exactly where they're aiming (its tip is at ~2,2 in the SVG, hence the -2).
let lastPointer = { x: 0, y: 0 };
function positionSynthCursor() {
  const r = $('#screen-wrap').getBoundingClientRect();
  $('#synth-cursor').style.transform = `translate(${lastPointer.x - r.left - 2}px, ${lastPointer.y - r.top - 2}px)`;
}
$('#screen-wrap').addEventListener('mousemove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
  if (blankOn) positionSynthCursor();
});
$('#blank-btn').addEventListener('click', async () => {
  if (!attachedId) return;
  blankOn = !blankOn;
  updateBlankBtn();
  const done = (m) => { if (!m.ok) { blankOn = false; updateBlankBtn(); toast(m.error || 'blank failed', 'err'); } else toast(blankOn ? 'Remote screen blanked' : 'Remote screen restored', 'ok'); };
  if (!blankOn) return deviceOp(attachedId, 'blank', { on: false }, { onResult: done });
  // Turning ON — with a cover if the owner set one, else plain black.
  if (!blankCover.ready) return deviceOp(attachedId, 'blank', { on: true }, { onResult: done });
  try {
    if (!remoteTemp) { fetchRemotePaths(); throw new Error('preparing'); }
    const coverPath = joinPath(remoteTemp, 'aegis-blank-cover' + blankCover.ext);
    filesAgentId = attachedId;
    const cached = await opCoverCheck(coverPath, blankCover.version);
    if (!cached) {
      toast('Sending ' + blankCover.kind + ' cover to the remote…', 'ok');
      const blob = await (await fetch('/api/blank-image', { cache: 'no-store' })).blob();
      const file = new File([blob], 'cover' + blankCover.ext, { type: blankCover.mime });
      await new Promise((res, rej) => { uploadFileTo(file, coverPath, { silent: true, onDone: res }); setTimeout(() => rej(new Error('timeout')), 5 * 60 * 1000); });
    }
    deviceOp(attachedId, 'blank', { on: true, coverPath, coverVersion: blankCover.version }, { onResult: done });
  } catch (e) {
    // Fall back to black if the cover couldn't be prepared.
    deviceOp(attachedId, 'blank', { on: true }, { onResult: done });
    if (e.message !== 'preparing') toast('Cover unavailable — blanked black', 'err');
  }
});
function opCoverCheck(coverPath, version) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== ws.OPEN) return resolve(false);
    const reqId = newReqId();
    fsOps.set(reqId, { onResult: (m) => resolve(!!(m.ok && m.data && m.data.has)) });
    ws.send(JSON.stringify({ type: 'op', agentId: attachedId, op: 'cover-check', reqId, payload: { path: coverPath, version } }));
    setTimeout(() => resolve(false), 8000);
  });
}
// Global blank cover (owner-uploaded image / GIF / video). Console learns its
// type+version via meta; the agent pulls/caches the actual file per session.
let blankCover = { ready: false };
function coverExt(mime, kind) {
  const map = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv' };
  return map[mime] || (kind === 'video' ? '.mp4' : kind === 'gif' ? '.gif' : '.png');
}
async function loadBlankImage() {
  try {
    const d = await (await fetch('/api/blank-image/meta', { cache: 'no-store' })).json();
    blankCover = d.ready ? { ready: true, kind: d.kind, version: d.version, mime: d.type, ext: coverExt(d.type, d.kind) } : { ready: false };
  } catch { blankCover = { ready: false }; }
  renderBlankImageStatus();
}
function renderBlankImageStatus() {
  const row = $('#blank-image-row'); if (!row) return;
  row.hidden = !(admin && admin.role === 'owner');
  const img = $('#blank-image-preview'), vid = $('#blank-image-preview-vid'), st = $('#blank-image-status'), rm = $('#blank-image-remove');
  img.style.display = 'none'; if (vid) { try { vid.pause(); } catch {} vid.style.display = 'none'; }
  if (blankCover.ready) {
    if (blankCover.kind === 'video' && vid) { vid.src = '/api/blank-image?' + blankCover.version; vid.style.display = ''; st.textContent = 'Looping video shown on every blanked screen.'; }
    else { img.src = '/api/blank-image?' + blankCover.version; img.style.display = ''; st.textContent = (blankCover.kind === 'gif' ? 'Looping GIF' : 'Image') + ' shown on every blanked screen.'; }
    rm.hidden = false;
  } else { st.textContent = 'No blank cover — screens go plain black. Upload an image, GIF, or video to brand the blank.'; rm.hidden = true; }
}
$('#blank-image-file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  const isVideo = /^video\//.test(f.type);
  const cap = isVideo ? 250 * 1024 * 1024 : 12 * 1024 * 1024; // allow a high-bitrate 1080p clip
  if (f.size > cap) { toast((isVideo ? 'Video' : 'Image') + ' too large (max ' + (cap / 1048576) + ' MB)', 'err'); return; }
  try {
    toast('Uploading cover…', 'ok');
    const r = await fetch('/api/blank-image', { method: 'POST', body: f, headers: { 'Content-Type': f.type || 'application/octet-stream' } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'upload failed');
    toast('Blank cover uploaded', 'ok');
    await loadBlankImage();
  } catch (err) { toast(err.message, 'err'); }
});
$('#blank-image-remove').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/blank-image', { method: 'DELETE' });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'failed'); }
    toast('Blank cover removed — screens go black', 'ok');
    await loadBlankImage();
  } catch (err) { toast(err.message, 'err'); }
});

let lockOn = false;
function updateLockBtn() { $('#lock-btn').classList.toggle('on', lockOn); }
// Set a button/tile's text label without clobbering its icon/switch.
function setLbl(btn, text) { const l = btn.querySelector('.lbl, .sc-tile-l'); if (l) l.textContent = text; else btn.textContent = text; }
$('#lock-btn').addEventListener('click', () => {
  if (!attachedId) return;
  lockOn = !lockOn;
  updateLockBtn();
  deviceOp(attachedId, 'lockinput', { on: lockOn }, { onResult: (m) => { if (!m.ok) { lockOn = false; updateLockBtn(); toast(m.error || 'failed', 'err'); } else toast(lockOn ? 'Local input locked' : 'Local input unlocked', 'ok'); } });
});

// Guest share link — let someone watch this session in a browser (view-only).
$('#share-btn').addEventListener('click', async () => {
  if (!attachedId) return;
  try {
    const r = await fetch('/api/guest-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: attachedId }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'failed');
    const vals = await modal({
      title: 'Guest view link',
      message: 'Anyone with this link can WATCH this session in a browser — view-only, no control, no login. It expires in ' + d.expiresInMin + ' minutes.',
      fields: [{ label: 'Share link', value: d.url }], confirmText: 'Copy link',
    });
    if (vals) { try { await navigator.clipboard.writeText(d.url); toast('Guest link copied', 'ok'); } catch { toast('Copy failed — select and copy manually', 'err'); } }
  } catch (e) { toast(e.message, 'err'); }
});

// Drag-and-drop files onto the live screen → send them to the remote Desktop.
let remoteDesktop = null, remoteTemp = null;
function fetchRemotePaths() {
  if (!attachedId || !ws || ws.readyState !== ws.OPEN) return;
  const reqId = newReqId();
  fsOps.set(reqId, { onResult: (m) => { if (m.ok && m.data) { remoteDesktop = m.data.desktop || null; remoteTemp = m.data.temp || null; } } });
  ws.send(JSON.stringify({ type: 'op', agentId: attachedId, op: 'paths', reqId, payload: {} }));
}
async function handleScreenDrop(files) {
  if (!attachedId) return;
  if (!remoteDesktop) { fetchRemotePaths(); toast('Preparing transfer — drop again in a second', 'err'); return; }
  filesAgentId = attachedId; // route fs ops to the machine we're viewing
  for (const f of files) {
    if (f.size > 500 * 1024 * 1024) { toast(f.name + ' is too large (500MB max)', 'err'); continue; }
    await uploadFileTo(f, joinPath(remoteDesktop, f.name));
  }
}
(function bindScreenDrop() {
  const sw = $('#screen-wrap'); if (!sw) return;
  const hint = () => $('#drop-hint');
  sw.addEventListener('dragover', (e) => { if (!attachedId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; hint().hidden = false; });
  sw.addEventListener('dragleave', (e) => { if (e.relatedTarget && sw.contains(e.relatedTarget)) return; hint().hidden = true; });
  sw.addEventListener('drop', (e) => { e.preventDefault(); hint().hidden = true; const files = [...((e.dataTransfer && e.dataTransfer.files) || [])]; if (files.length) handleScreenDrop(files); });
})();

// Session recording — capture the live canvas (works for both WebRTC-painted and
// JPEG frames) to a .webm saved on the technician's computer. No server load.
let mediaRec = null, recChunks = [], recTimer = null, recStart = 0;
function recMime() {
  for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t; } catch {}
  }
  return '';
}
function startRecording() {
  if (mediaRec) return;
  if (!window.MediaRecorder || !canvas.captureStream) { toast('Recording isn’t supported in this browser', 'err'); return; }
  let stream; try { stream = canvas.captureStream(15); } catch { toast('Could not capture the screen', 'err'); return; }
  const mime = recMime();
  try { mediaRec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4000000 } : undefined); }
  catch { toast('Recorder failed to start', 'err'); return; }
  recChunks = [];
  mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRec.onstop = saveRecording;
  mediaRec.start(1000);
  recStart = Date.now();
  const btn = $('#rec-btn'); btn.classList.add('recording'); setLbl(btn, 'Stop 00:00');
  recTimer = setInterval(() => { const s = Math.floor((Date.now() - recStart) / 1000); setLbl(btn, 'Stop ' + String((s / 60) | 0).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')); }, 500);
  toast('Recording started', 'ok');
}
function stopRecording() {
  if (!mediaRec) return;
  try { mediaRec.stop(); } catch {}
  mediaRec = null;
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  const btn = $('#rec-btn'); btn.classList.remove('recording'); setLbl(btn, 'Record video');
}
function saveRecording() {
  if (!recChunks.length) return;
  const blob = new Blob(recChunks, { type: 'video/webm' }); recChunks = [];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = 'aegis-' + (($('#session-name').textContent || 'session').replace(/[^\w.-]+/g, '_')) + '-' + stamp + '.webm';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Recording saved: ' + name, 'ok');
}
$('#rec-btn').addEventListener('click', () => { if (mediaRec) stopRecording(); else startRecording(); });

function onAttached(msg) {
  attachedId = msg.agentId;
  loadBlankImage(); // make sure we have the owner's current blank image for this session
  remoteDesktop = null; remoteTemp = null; fetchRemotePaths(); // for drag-drop + blank cover
  $('#control').checked = false; // start in view-only; technician flips Control on to take over
  rtcIceServers = msg.iceServers || null;
  $('#session-name').textContent = msg.name;
  $('#ctl-warn').hidden = true;
  blankOn = false; updateBlankBtn();
  lockOn = false; updateLockBtn();
  setRtcMode('connecting');
  $('#control-view').hidden = false;
  if (msg.screen) { frameW = msg.screen.w; frameH = msg.screen.h; }
  canvas.focus();
}
function backToDashboard() {
  attachedId = null;
  zoom = 0; annotOn = false; annotCanvas.hidden = true; $('#annot-btn').classList.remove('on'); // reset view tools
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch {} // leave fullscreen when the session ends
  if (mediaRec) stopRecording(); // auto-save any in-progress recording
  blankOn = false; updateBlankBtn();
  lockOn = false; updateLockBtn();
  closeConsoleRtc();
  $('#control-view').hidden = true;
  $('#monitor-select').hidden = true;
}
$('#back-dash').addEventListener('click', () => { if (ws) ws.send(JSON.stringify({ type: 'detach' })); backToDashboard(); });
$('#detach').addEventListener('click', () => { if (ws) ws.send(JSON.stringify({ type: 'detach' })); backToDashboard(); });

img.onload = () => {
  if (canvas.width !== img.width || canvas.height !== img.height) {
    canvas.width = img.width; canvas.height = img.height; frameW = img.width; frameH = img.height; fit();
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
};
function drawFrame(msg) { img.src = 'data:image/jpeg;base64,' + msg.data; } // legacy (pre-binary agents)
let decoding = false;
function drawBinaryFrame(buf) {
  if (!$('#screen-wrap').classList.contains('rtc') && !$('#rtc-mode').classList.contains('sd')) setRtcMode('sd'); // JPEG path active
  if (decoding) return; // never queue decodes — always render the freshest frame
  decoding = true;
  const blob = new Blob([buf], { type: 'image/jpeg' });
  createImageBitmap(blob).then((bmp) => {
    decoding = false;
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width; canvas.height = bmp.height; frameW = bmp.width; frameH = bmp.height; fit();
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
  }).catch(() => { decoding = false; });
}
function fit() {
  if (!frameW || !frameH) return;
  if (zoom) return applyZoom(); // manual zoom overrides fit
  const wrap = $('#screen-wrap');
  const scale = Math.min(wrap.clientWidth / frameW, wrap.clientHeight / frameH);
  const w = Math.floor(frameW * scale) + 'px', h = Math.floor(frameH * scale) + 'px';
  canvas.style.width = w; canvas.style.height = h;
  syncAnnotSize();
}
// ---- Quality / Ctrl+Alt+Del / Screenshot / Zoom / Annotate ----
$$('.q-btn').forEach((b) => b.addEventListener('click', () => {
  $$('.q-btn').forEach((x) => x.classList.toggle('active', x === b));
  if (ws && ws.readyState === ws.OPEN && attachedId) ws.send(JSON.stringify({ type: 'quality', level: b.dataset.q }));
  toast('Quality: ' + ({ L: 'Low', M: 'Medium', H: 'High' }[b.dataset.q]), 'ok');
}));
$('#cad-btn').addEventListener('click', () => {
  if (!attachedId) return;
  deviceOp(attachedId, 'cad', {}, { onResult: (m) => toast(m.ok ? 'Ctrl+Alt+Del sent' : (m.error || 'failed'), m.ok ? 'ok' : 'err') });
});
$('#shot-btn').addEventListener('click', () => {
  try {
    const tmp = document.createElement('canvas'); tmp.width = canvas.width; tmp.height = canvas.height;
    const tc = tmp.getContext('2d'); tc.drawImage(canvas, 0, 0);
    if (annotOn && annotCanvas.width) tc.drawImage(annotCanvas, 0, 0); // include annotations
    const a = document.createElement('a');
    a.href = tmp.toDataURL('image/png');
    a.download = 'aegis-' + (($('#session-name').textContent || 'screen').replace(/[^\w.-]+/g, '_')) + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Screenshot saved', 'ok');
  } catch { toast('Screenshot failed', 'err'); }
});
// Zoom (client-side). zoom=0 → fit.
let zoom = 0;
function applyZoom() {
  if (!frameW) return;
  if (!zoom) { $('#zoom-lbl').textContent = 'Fit'; fit(); return; }
  const w = Math.round(frameW * zoom), h = Math.round(frameH * zoom);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  $('#zoom-lbl').textContent = Math.round(zoom * 100) + '%';
  syncAnnotSize();
}
function curScale() { return zoom || Math.min($('#screen-wrap').clientWidth / (frameW || 1), $('#screen-wrap').clientHeight / (frameH || 1)); }
$('#zoom-in').addEventListener('click', () => { zoom = Math.min(4, curScale() * 1.25); applyZoom(); });
$('#zoom-out').addEventListener('click', () => { zoom = Math.max(0.25, curScale() / 1.25); applyZoom(); });
$('#zoom-lbl').addEventListener('click', () => { zoom = 0; applyZoom(); });
// Annotate — draw on the current view (local; great for screenshots/recording).
const annotCanvas = $('#annot-canvas');
let annotOn = false, annotDrawing = false, annotCtx = null;
function syncAnnotSize() {
  if (annotCanvas.width !== canvas.width) { annotCanvas.width = canvas.width; annotCanvas.height = canvas.height; }
  annotCanvas.style.width = canvas.style.width; annotCanvas.style.height = canvas.style.height;
  if (annotOn) { annotCtx = annotCanvas.getContext('2d'); annotCtx.strokeStyle = '#ff3b3b'; annotCtx.lineWidth = 3; annotCtx.lineCap = 'round'; annotCtx.lineJoin = 'round'; }
}
$('#annot-btn').addEventListener('click', () => {
  annotOn = !annotOn;
  $('#annot-btn').classList.toggle('on', annotOn);
  annotCanvas.hidden = !annotOn;
  if (annotOn) { syncAnnotSize(); toast('Annotate on — draw on the screen (double-click to clear)', 'ok'); }
});
function annotPos(e) { const r = annotCanvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * annotCanvas.width, y: (e.clientY - r.top) / r.height * annotCanvas.height }; }
annotCanvas.addEventListener('mousedown', (e) => { if (!annotOn) return; annotDrawing = true; const p = annotPos(e); annotCtx.beginPath(); annotCtx.moveTo(p.x, p.y); });
annotCanvas.addEventListener('mousemove', (e) => { if (!annotDrawing) return; const p = annotPos(e); annotCtx.lineTo(p.x, p.y); annotCtx.stroke(); });
window.addEventListener('mouseup', () => { annotDrawing = false; });
annotCanvas.addEventListener('dblclick', () => { if (annotCtx) annotCtx.clearRect(0, 0, annotCanvas.width, annotCanvas.height); });

// ---------------------------------------------------------------------------
// WebRTC receiver — sharp, sub-second video. The canvas stays on top as a
// transparent input layer, so all control code is unchanged.
// ---------------------------------------------------------------------------
let rtcPc = null;
let rtcIceServers = null; // provided by the relay on 'attached' (STUN + TURN)
function setRtcMode(mode) {
  const el = $('#rtc-mode');
  el.classList.remove('hd', 'sd');
  if (mode === 'hd') { el.classList.add('hd'); el.textContent = 'HD · WebRTC'; }
  else if (mode === 'sd') { el.classList.add('sd'); el.textContent = 'SD · compatibility'; }
  else el.textContent = 'Connecting…';
}
const RTC_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
// Paint the decode-only WebRTC <video> onto the visible canvas. We drive this
// from requestVideoFrameCallback (freshest frame, no tearing) and fall back to
// rAF. This sidesteps the compositor freeze where the <video> plays but never
// repaints on screen. Idempotent + safe to call before metadata is known.
let rtcRVFC = null, rtcRAF = null, rtcDrawing = false;
function rtcPaint() {
  const v = $('#rtc-video');
  if (!rtcPc || !v.srcObject) { rtcDrawing = false; return; }
  const vw = v.videoWidth, vh = v.videoHeight;
  if (vw && vh) {
    if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh; frameW = vw; frameH = vh; fit(); }
    try { ctx.drawImage(v, 0, 0, canvas.width, canvas.height); } catch {}
  }
  if ('requestVideoFrameCallback' in v) rtcRVFC = v.requestVideoFrameCallback(rtcPaint);
  else rtcRAF = requestAnimationFrame(rtcPaint);
}
function stopRtcPaint() {
  const v = $('#rtc-video');
  if (rtcRVFC && v.cancelVideoFrameCallback) { try { v.cancelVideoFrameCallback(rtcRVFC); } catch {} }
  if (rtcRAF) cancelAnimationFrame(rtcRAF);
  rtcRVFC = rtcRAF = null; rtcDrawing = false;
}
function showRtcVideo() {
  const v = $('#rtc-video');
  if (!v.srcObject) return;
  $('#screen-wrap').classList.add('rtc'); // state flag (keeps JPEG path from flipping badge to SD)
  setRtcMode('hd');
  v.play().catch(() => {});
  if (!rtcDrawing) { rtcDrawing = true; rtcPaint(); } // start the paint loop once
}
// Diagnostics: surface why WebRTC does/doesn't upgrade to HD. Hover the badge to
// see the live state; full detail also goes to the browser console as [RTC] logs.
const rtcDiag = { offer: false, cand: new Set(), remoteCand: new Set(), ice: '-', conn: '-', frames: 0, fps: 0, pair: '-' };
let rtcStatsTimer = null, rtcLastFrames = 0;
function rtcLog(...a) { try { console.log('[RTC]', ...a); } catch {} rtcRenderDiag(); }
function candType(c) { const m = /(?:^|\s)typ\s+(\w+)/.exec(c && c.candidate || ''); return m ? m[1] : '?'; }
function rtcRenderDiag() {
  const el = $('#rtc-mode'); if (!el) return;
  el.title = `offer:${rtcDiag.offer ? '✓' : '✗'}  ice:${rtcDiag.ice}  conn:${rtcDiag.conn}\n`
    + `local cand: ${[...rtcDiag.cand].join(',') || 'none'}\n`
    + `remote cand: ${[...rtcDiag.remoteCand].join(',') || 'none'}\n`
    + `video: ${rtcDiag.frames} frames decoded, ~${rtcDiag.fps} fps  pair:${rtcDiag.pair}\n`
    + `vid: ${rtcDiag.vid || '-'}`;
}
function startRtcStats() {
  if (rtcStatsTimer) clearInterval(rtcStatsTimer);
  rtcLastFrames = 0;
  rtcStatsTimer = setInterval(async () => {
    if (!rtcPc) return;
    try {
      const stats = await rtcPc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          const f = r.framesDecoded || 0;
          rtcDiag.fps = Math.max(0, f - rtcLastFrames) / 2; rtcLastFrames = f; rtcDiag.frames = f;
        }
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
          rtcDiag.pair = (r.availableIncomingBitrate ? Math.round(r.availableIncomingBitrate / 1000) + 'kbps' : 'ok');
        }
      });
      const v = $('#rtc-video'); const cs = getComputedStyle(v);
      const vid = `paused:${v.paused} ct:${v.currentTime.toFixed(1)} rs:${v.readyState} ${v.videoWidth}x${v.videoHeight} shown:${v.offsetWidth}x${v.offsetHeight} disp:${cs.display} rtc:${$('#screen-wrap').classList.contains('rtc')}`;
      rtcDiag.vid = vid;
      rtcLog('stats frames=' + rtcDiag.frames + ' fps=' + rtcDiag.fps + ' | ' + vid);
    } catch {}
  }, 2000);
}
async function onRtcOffer(msg) {
  closeConsoleRtc();
  rtcDiag.offer = true; rtcDiag.cand = new Set(); rtcDiag.remoteCand = new Set(); rtcDiag.ice = 'new'; rtcDiag.conn = 'new';
  rtcLog('offer received; iceServers =', JSON.stringify(rtcIceServers || RTC_ICE));
  try {
    rtcPc = new RTCPeerConnection({ iceServers: rtcIceServers || RTC_ICE });
    rtcPc.onicecandidate = (e) => {
      if (e.candidate) { rtcDiag.cand.add(candType(e.candidate)); rtcLog('local candidate', candType(e.candidate), e.candidate.candidate); }
      else rtcLog('local ICE gathering complete');
      if (e.candidate && ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'rtc-ice', candidate: e.candidate }));
    };
    rtcPc.oniceconnectionstatechange = () => { if (rtcPc) { rtcDiag.ice = rtcPc.iceConnectionState; rtcLog('iceConnectionState', rtcPc.iceConnectionState); } };
    rtcPc.ontrack = (e) => {
      const v = $('#rtc-video');
      v.srcObject = e.streams[0];
      v.onloadedmetadata = () => { showRtcVideo(); };   // update dims once known
      v.onresize = () => { showRtcVideo(); };            // re-fit if the remote resolution changes
      v.play().catch(() => {});
      showRtcVideo();                                    // don't wait for metadata — reveal the video now
    };
    rtcPc.onconnectionstatechange = () => {
      if (!rtcPc) return;
      rtcDiag.conn = rtcPc.connectionState; rtcLog('connectionState', rtcPc.connectionState);
      // Re-reveal on every (re)connect — a connected→disconnected→connected flap
      // must never leave the badge on HD while the video stays hidden.
      if (rtcPc.connectionState === 'connected') showRtcVideo();
      else if (['failed', 'closed'].includes(rtcPc.connectionState)) { $('#screen-wrap').classList.remove('rtc'); setRtcMode('sd'); }
    };
    await rtcPc.setRemoteDescription(msg.sdp);
    const answer = await rtcPc.createAnswer();
    await rtcPc.setLocalDescription(answer);
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'rtc-answer', sdp: rtcPc.localDescription }));
    startRtcStats();
  } catch (e) { closeConsoleRtc(); }
}
function closeConsoleRtc() {
  stopRtcPaint();
  if (rtcStatsTimer) { clearInterval(rtcStatsTimer); rtcStatsTimer = null; }
  if (rtcPc) { try { rtcPc.close(); } catch {} rtcPc = null; }
  const v = $('#rtc-video'); try { v.srcObject = null; } catch {}
  $('#screen-wrap').classList.remove('rtc');
}
$('#fit').addEventListener('click', fit);
$('#fs-btn').addEventListener('click', toggleFullscreen);
window.addEventListener('resize', fit);

// Centered icon toolbar with HOVER dropdown panels (ScreenConnect-style).
let scCloseT = null;
function closeScPanels() { $$('.sc-panel').forEach((p) => (p.hidden = true)); $$('.sc-tab').forEach((t) => t.classList.remove('active')); }
function scOpen(name) {
  if (scCloseT) { clearTimeout(scCloseT); scCloseT = null; }
  $$('.sc-panel').forEach((p) => (p.hidden = p.dataset.panelfor !== name));
  $$('.sc-tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === name));
}
function scScheduleClose() { if (scCloseT) clearTimeout(scCloseT); scCloseT = setTimeout(closeScPanels, 220); }
$$('.sc-tab').forEach((tab) => {
  tab.addEventListener('mouseenter', () => scOpen(tab.dataset.panel));
  tab.addEventListener('mouseleave', scScheduleClose);
  tab.addEventListener('click', (e) => { e.stopPropagation(); scOpen(tab.dataset.panel); });
});
$$('.sc-panel').forEach((p) => {
  p.addEventListener('mouseenter', () => { if (scCloseT) { clearTimeout(scCloseT); scCloseT = null; } });
  p.addEventListener('mouseleave', scScheduleClose);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.sc-panels') && !e.target.closest('.sc-tabs')) closeScPanels(); });
$('#ft-open').addEventListener('click', () => { const d = devicesCache.find((x) => x.id === attachedId); if (d) openFiles(d); });
$('#reboot-normal').addEventListener('click', () => powerAction({ id: attachedId }, 'normalmode'));
$('#reboot-safe').addEventListener('click', () => powerAction({ id: attachedId }, 'safemode'));
$('#ka-tile').addEventListener('click', () => {
  const on = !$('#ka-tile').classList.contains('on');
  deviceOp(attachedId, 'keepawake', { on }, { onResult: (m) => { if (m.ok) { $('#ka-tile').classList.toggle('on', !!m.data.keepAwake); toast(m.data.keepAwake ? 'Wake lock on' : 'Wake lock off', 'ok'); } else toast(m.error || 'failed', 'err'); } });
});
document.addEventListener('fullscreenchange', () => setTimeout(fit, 60)); // re-fit after entering/leaving fullscreen

function renderMonitors(msg) {
  const sel = $('#monitor-select');
  const list = msg.list || [];
  if (list.length <= 1) { sel.hidden = true; return; }
  sel.hidden = false; sel.innerHTML = '';
  for (const m of list) {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.label + (m.primary ? ' (primary)' : '');
    if (m.id === msg.selected) o.selected = true;
    sel.appendChild(o);
  }
}
$('#monitor-select').addEventListener('change', () => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'monitor', id: $('#monitor-select').value }));
});

// Input capture
function controlOn() { return $('#control').checked && attachedId; }
function sendInput(ev) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'input', event: ev })); }
function normXY(e) {
  const r = canvas.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
const BTN = { 0: 'L', 1: 'M', 2: 'R' };
let lastMove = 0;
canvas.addEventListener('mousemove', (e) => {
  if (!controlOn()) return;
  const now = performance.now(); if (now - lastMove < 16) return; lastMove = now;
  const { x, y } = normXY(e); sendInput({ kind: 'move', x, y });
});
canvas.addEventListener('mousedown', (e) => { if (!controlOn()) return; e.preventDefault(); canvas.focus(); const { x, y } = normXY(e); sendInput({ kind: 'down', button: BTN[e.button] || 'L', x, y }); });
canvas.addEventListener('mouseup', (e) => { if (!controlOn()) return; const { x, y } = normXY(e); sendInput({ kind: 'up', button: BTN[e.button] || 'L', x, y }); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => { if (!controlOn()) return; e.preventDefault(); sendInput({ kind: 'wheel', dy: e.deltaY < 0 ? 120 : -120 }); }, { passive: false });
canvas.addEventListener('keydown', (e) => {
  if (!controlOn()) return; e.preventDefault();
  const printable = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
  if (printable) sendInput({ kind: 'text', ch: e.key });
  else { pressed.add(e.code); sendInput({ kind: 'key', code: e.code, down: true }); }
});
canvas.addEventListener('keyup', (e) => { if (!controlOn()) return; e.preventDefault(); if (pressed.has(e.code)) { pressed.delete(e.code); sendInput({ kind: 'key', code: e.code, down: false }); } });
canvas.addEventListener('blur', () => { for (const c of pressed) sendInput({ kind: 'key', code: c, down: false }); pressed.clear(); });
