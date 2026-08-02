'use strict';

const $ = (s, r = document) => r.querySelector(s);
let ws = null, admin = null, attachedId = null, mode = 'login';
let frameW = 0, frameH = 0;
const pressed = new Set();

// ---------------------------------------------------------------------------
// API
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

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function setMode(m) {
  mode = m;
  $('#tab-login').classList.toggle('active', m === 'login');
  $('#tab-signup').classList.toggle('active', m === 'signup');
  $('#au-name').hidden = m !== 'signup';
  $('#au-submit').textContent = m === 'signup' ? 'Create account' : 'Log in';
  $('#auth-err').textContent = '';
}
$('#tab-login').addEventListener('click', () => setMode('login'));
$('#tab-signup').addEventListener('click', () => setMode('signup'));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-err').textContent = '';
  const email = $('#au-email').value.trim();
  const password = $('#au-pass').value;
  const name = $('#au-name').value.trim();
  try {
    const data = mode === 'signup'
      ? await api('/api/signup', 'POST', { email, password, name })
      : await api('/api/login', 'POST', { email, password });
    showApp(data.admin);
  } catch (err) {
    $('#auth-err').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', 'POST'); } catch {}
  if (ws) try { ws.close(); } catch {}
  location.reload();
});

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------
function showApp(a) {
  admin = a;
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#admin-name').textContent = a.name || a.email;
  loadKeys();
  checkInstaller();
  connectWS();
}
function showAuth() { $('#auth-view').hidden = false; $('#app-view').hidden = true; }

(async function init() {
  try {
    const { admin: a } = await api('/api/me');
    showApp(a);
  } catch {
    showAuth();
  }
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
      case 'agents': renderDevices(msg.list); break;
      case 'attached': onAttached(msg); break;
      case 'frame': drawFrame(msg); break;
      case 'monitors': renderMonitors(msg); break;
      case 'agentGone': backToDashboard(); break;
      case 'error': alert(msg.text); break;
      case 'denied': showAuth(); break;
    }
  };
  ws.onclose = () => { /* dashboard stays; could show a reconnect hint */ };
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
function renderDevices(list) {
  const box = $('#devices');
  $('#dev-count').textContent = list.length ? `${list.filter((d) => d.online).length}/${list.length} online` : '';
  $('#dev-empty').style.display = list.length ? 'none' : 'block';
  box.innerHTML = '';
  for (const d of list) {
    const el = document.createElement('div');
    el.className = 'device' + (d.online ? ' online' : '');
    el.innerHTML = `<span class="dot"></span>
      <div class="info"><div class="name"></div>
        <div class="sub">${d.online ? (d.busy ? 'in session' : 'online') : 'offline'}</div></div>`;
    el.querySelector('.name').textContent = d.name;
    if (d.online && !d.busy) {
      const b = document.createElement('button');
      b.className = 'btn small primary'; b.textContent = 'Connect';
      b.addEventListener('click', () => attach(d.id));
      el.appendChild(b);
    }
    box.appendChild(el);
  }
}
function attach(id) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'attach', agentId: id })); }

// ---------------------------------------------------------------------------
// Enrollment keys / links
// ---------------------------------------------------------------------------
async function loadKeys() {
  try {
    const { keys } = await api('/api/keys');
    const box = $('#keys');
    box.innerHTML = '';
    for (const k of keys) {
      const row = document.createElement('div');
      row.className = 'keyrow' + (k.revoked ? ' revoked' : '');
      row.innerHTML = `<span class="label"></span>
        <span class="url"></span>
        <button class="btn small copy">Copy</button>
        ${k.revoked ? '<span class="pill">revoked</span>' : '<button class="btn small danger rev">Revoke</button>'}`;
      row.querySelector('.label').textContent = k.label;
      row.querySelector('.url').textContent = k.downloadUrl;
      row.querySelector('.copy').addEventListener('click', () => {
        navigator.clipboard.writeText(k.downloadUrl).then(() => { row.querySelector('.copy').textContent = 'Copied'; });
      });
      const rev = row.querySelector('.rev');
      if (rev) rev.addEventListener('click', async () => { await api('/api/keys/revoke', 'POST', { key: k.key }); loadKeys(); });
      box.appendChild(row);
    }
  } catch (e) { /* not signed in */ }
}
$('#new-key').addEventListener('click', async () => {
  const label = prompt('Name this link (e.g. a client or team):', 'New link');
  if (label === null) return;
  await api('/api/keys', 'POST', { label: label || 'Link' });
  loadKeys();
});

// Installer upload (raw binary body).
async function checkInstaller() {
  try {
    const { ready } = await api('/api/installer');
    $('#installer-status').textContent = ready
      ? '' : '⚠ Upload the installer once so your links can be downloaded.';
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
    checkInstaller();
  } catch (err) {
    $('#upload-status').textContent = '✗ ' + err.message;
  }
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

// Monitor selector
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

setMode('login');
