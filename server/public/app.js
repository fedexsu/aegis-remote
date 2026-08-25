'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let ws = null, admin = null, attachedId = null;
let frameW = 0, frameH = 0;
let devicesCache = [];
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
  if (owner) loadAccounts();
  loadKeys();
  loadStats();
  checkInstaller();
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
function connectWS() {
  if (ws) try { ws.close(); } catch {}
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'register', role: 'console' }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'agents': devicesCache = msg.list; renderDevices(); break;
      case 'stats': applyStats(msg.stats); break;
      case 'attached': onAttached(msg); break;
      case 'frame': drawFrame(msg); break;
      case 'monitors': renderMonitors(msg); break;
      case 'agentGone': toast('Device disconnected', 'err'); backToDashboard(); break;
      case 'error': toast(msg.text, 'err'); break;
      case 'info': toast(msg.text, 'ok'); break;
      case 'opStream': onOpStream(msg); break;
      case 'opEnd': onOpEnd(msg); break;
      case 'denied': showAuth(); break;
    }
  };
  ws.onclose = () => {};
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
const DEV_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';

function statusOf(d) {
  if (d.online) return d.busy ? 'busy' : 'online';
  if (d.uninstalled) return 'uninstalled';
  if (d.asleep) return 'sleep';
  return 'offline';
}
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
  box.innerHTML = '';

  for (const d of shown) {
    const st = statusOf(d);
    const m = d.meta || {};
    const el = document.createElement('div');
    el.className = 'device' + (d.online ? ' online' : '') + (st === 'uninstalled' ? ' uninstalled' : '') + (st === 'sleep' ? ' asleep' : '');
    el.innerHTML = `
      <div class="dev-top">
        <div class="dev-badge">${DEV_SVG}</div>
        <div class="dev-id">
          <div class="dev-name" title=""></div>
          <span class="dev-status st-${st}"><span class="status-dot"></span>${statusLabel(st)}</span>
        </div>
      </div>
      <div class="dev-meta">
        <div class="dm"><div class="dm-k">System</div><div class="dm-v" data-f="os">—</div></div>
        <div class="dm"><div class="dm-k">Host</div><div class="dm-v" data-f="host">—</div></div>
        <div class="dm"><div class="dm-k">User</div><div class="dm-v" data-f="user">—</div></div>
        <div class="dm"><div class="dm-k">Screen</div><div class="dm-v" data-f="res">—</div></div>
        <div class="dm"><div class="dm-k">Enrolled via</div><div class="dm-v" data-f="via">—</div></div>
        <div class="dm"><div class="dm-k">Last seen</div><div class="dm-v" data-f="seen">—</div></div>
      </div>
      <div class="dev-actions">
        <button class="btn primary connect" ${d.online && !d.busy ? '' : 'disabled style="opacity:.5;cursor:not-allowed"'}>${d.busy ? 'In use' : (st === 'sleep' ? 'Asleep' : 'Connect')}</button>
        ${d.online ? `<button class="btn ghost icon-btn term" title="Terminal"><svg viewBox="0 0 24 24" class="ic"><path d="M4 5h16v14H4z"/><path d="M8 9.5l2.5 2.5L8 14.5M13 15h3.5"/></svg></button>` : ''}
        <button class="btn ghost icon-btn rename" title="Rename">
          <svg viewBox="0 0 24 24" class="ic"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>
        </button>
        <button class="btn danger icon-btn del" title="Remove">
          <svg viewBox="0 0 24 24" class="ic"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>
      </div>`;
    el.querySelector('.dev-name').textContent = d.name;
    el.querySelector('.dev-name').title = d.id;
    el.querySelector('[data-f="os"]').textContent = m.os || 'Unknown';
    el.querySelector('[data-f="host"]').textContent = m.host || '—';
    el.querySelector('[data-f="user"]').textContent = m.user || '—';
    el.querySelector('[data-f="res"]').textContent = d.res || m.screen || '—';
    el.querySelector('[data-f="via"]').textContent = d.via || '—';
    el.querySelector('[data-f="seen"]').textContent = d.online ? 'now' : (st === 'uninstalled' ? relTime(d.uninstalledAt) : relTime(d.lastSeen));

    const conn = el.querySelector('.connect');
    if (conn && d.online && !d.busy) conn.addEventListener('click', () => attach(d.id));
    const termBtn = el.querySelector('.term');
    if (termBtn) termBtn.addEventListener('click', () => openTerminal(d));
    el.querySelector('.rename').addEventListener('click', () => renameDevice(d));
    el.querySelector('.del').addEventListener('click', () => removeDevice(d));
    box.appendChild(el);
  }
}
function attach(id) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'attach', agentId: id })); }

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
      } else {
        const copy = document.createElement('button');
        copy.className = 'btn ghost small'; copy.textContent = 'Copy link';
        copy.addEventListener('click', () => navigator.clipboard.writeText(k.downloadUrl).then(() => { copy.textContent = 'Copied ✓'; toast('Link copied', 'ok'); setTimeout(() => (copy.textContent = 'Copy link'), 1500); }));
        const rev = document.createElement('button');
        rev.className = 'btn danger small'; rev.textContent = 'Revoke';
        rev.addEventListener('click', async () => {
          const ok = await modal({ title: 'Revoke link?', message: `"${k.label}" will stop working for new installs.`, confirmText: 'Revoke', danger: true });
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
$('#new-key').addEventListener('click', async () => {
  const vals = await modal({ title: 'New enrollment link', fields: [{ label: 'Name this link (e.g. a client or team)', value: 'New link' }], confirmText: 'Create' });
  if (!vals) return;
  await api('/api/keys', 'POST', { label: vals[0] || 'Link' });
  toast('Link created', 'ok'); loadKeys();
});

async function checkInstaller() {
  try {
    const { ready } = await api('/api/installer');
    $('#installer-banner').hidden = ready;
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
// Control session
// ---------------------------------------------------------------------------
const canvas = $('#screen');
const ctx = canvas.getContext('2d');
const img = new Image();

function onAttached(msg) {
  attachedId = msg.agentId;
  $('#session-name').textContent = msg.name;
  $('#control-view').hidden = false;
  if (msg.screen) { frameW = msg.screen.w; frameH = msg.screen.h; }
  canvas.focus();
}
function backToDashboard() {
  attachedId = null;
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
function drawFrame(msg) { img.src = 'data:image/jpeg;base64,' + msg.data; }
function fit() {
  if (!frameW || !frameH) return;
  const wrap = $('#screen-wrap');
  const scale = Math.min(wrap.clientWidth / frameW, wrap.clientHeight / frameH);
  canvas.style.width = Math.floor(frameW * scale) + 'px';
  canvas.style.height = Math.floor(frameH * scale) + 'px';
}
$('#fit').addEventListener('click', fit);
window.addEventListener('resize', fit);

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
