'use strict';

const $ = (s) => document.querySelector(s);
let ws = null;
let attachedId = null;
let frameW = 0, frameH = 0;
const pressed = new Set(); // e.code currently held via the "key" path

const canvas = $('#screen');
const ctx = canvas.getContext('2d');
const img = new Image();

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
function relayUrl() {
  const custom = $('#relay').value.trim();
  if (custom) {
    if (/^wss?:\/\//i.test(custom)) return custom;
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + custom;
  }
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

function setStatus(on, text) {
  const s = $('#status');
  s.className = 'status ' + (on ? 'on' : 'off');
  s.textContent = text;
}

$('#connect').addEventListener('click', connect);
$('#key').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

// Remember relay + key, and auto-connect on page load so opening the console
// "just works" — no need to type anything or click Connect.
(function autoConnect() {
  const savedRelay = localStorage.getItem('aegis-relay');
  const savedKey = localStorage.getItem('aegis-key');
  if (savedRelay) $('#relay').value = savedRelay;
  if (savedKey) $('#key').value = savedKey;
  if ($('#key').value) setTimeout(connect, 150);
})();

function connect() {
  if (ws) { try { ws.close(); } catch {} }
  const key = $('#key').value;
  setStatus(false, 'connecting…');
  ws = new WebSocket(relayUrl());

  ws.onopen = () => ws.send(JSON.stringify({ type: 'register', role: 'console', key }));
  ws.onclose = () => { setStatus(false, 'offline'); attachedId = null; showPlaceholder(); };
  ws.onerror = () => {
    setStatus(false, 'error');
    $('#empty').innerHTML = '⚠️ <b>Can’t reach the relay</b> at <code>' + relayUrl() + '</code>.<br>Is the relay server running?';
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'registered':
        setStatus(true, 'connected');
        localStorage.setItem('aegis-relay', $('#relay').value.trim());
        localStorage.setItem('aegis-key', $('#key').value);
        $('#empty').textContent = 'Connected. Waiting for devices…';
        break;
      case 'denied':
        setStatus(false, 'denied: ' + msg.reason);
        $('#empty').innerHTML = '⚠️ <b>Access denied</b> — the key is wrong.<br>Fix the key and click Connect.';
        break;
      case 'agents': renderAgents(msg.list); break;
      case 'attached': onAttached(msg); break;
      case 'frame': drawFrame(msg); break;
      case 'monitors': renderMonitors(msg); break;
      case 'chat': addChat(msg.text, 'them'); break;
      case 'agentGone': addChat('Device disconnected.', 'sys'); showPlaceholder(); attachedId = null; break;
      case 'error': addChat('⚠ ' + msg.text, 'sys'); break;
    }
  };
}

// ---------------------------------------------------------------------------
// Agent list
// ---------------------------------------------------------------------------
function renderAgents(list) {
  $('#agent-count').textContent = list.length;
  $('#empty').style.display = list.length ? 'none' : 'block';
  const box = $('#agents');
  box.innerHTML = '';
  for (const a of list) {
    const el = document.createElement('div');
    el.className = 'agent' + (a.id === attachedId ? ' active' : '') + (a.busy ? ' busy' : '');
    el.innerHTML = `<span class="dot"></span><div class="info">
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="sub">${a.busy ? 'in session' : 'online'}</div></div>`;
    el.addEventListener('click', () => attach(a.id));
    box.appendChild(el);
  }
}

function attach(agentId) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: 'attach', agentId }));
}

function onAttached(msg) {
  attachedId = msg.agentId;
  $('#session-name').textContent = msg.name;
  $('#session-bar').hidden = false;
  $('#placeholder').style.display = 'none';
  canvas.hidden = false;
  if (msg.screen) { frameW = msg.screen.w; frameH = msg.screen.h; fit(); }
  addChat('Session started with ' + msg.name, 'sys');
  canvas.focus();
}

function showPlaceholder() {
  $('#session-bar').hidden = true;
  canvas.hidden = true;
  $('#monitor-select').hidden = true;
  $('#placeholder').style.display = 'block';
}

// Multi-monitor selector (shown only when the remote has more than one screen).
function renderMonitors(msg) {
  const sel = $('#monitor-select');
  const list = msg.list || [];
  if (list.length <= 1) { sel.hidden = true; return; }
  sel.hidden = false;
  sel.innerHTML = '';
  for (const m of list) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label + (m.primary ? ' (primary)' : '');
    if (m.id === msg.selected) o.selected = true;
    sel.appendChild(o);
  }
}
$('#monitor-select').addEventListener('change', () => {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'monitor', id: $('#monitor-select').value }));
  }
});

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------
img.onload = () => {
  // Resize the canvas backing store to the actual frame size, then fit it into
  // the container. Compare against the canvas's own dimensions (not frameW) so
  // this always runs on the first frame.
  if (canvas.width !== img.width || canvas.height !== img.height) {
    canvas.width = img.width; canvas.height = img.height;
    frameW = img.width; frameH = img.height;
    fit();
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
};
function drawFrame(msg) {
  img.src = 'data:image/jpeg;base64,' + msg.data;
}

// Fit the canvas element inside its container preserving aspect ratio.
function fit() {
  if (!frameW || !frameH) return;
  const wrap = $('#screen-wrap');
  const scale = Math.min(wrap.clientWidth / frameW, wrap.clientHeight / frameH);
  canvas.style.width = Math.floor(frameW * scale) + 'px';
  canvas.style.height = Math.floor(frameH * scale) + 'px';
}
$('#fit').addEventListener('click', fit);
window.addEventListener('resize', fit);

// ---------------------------------------------------------------------------
// Input capture -> relay
// ---------------------------------------------------------------------------
function controlOn() { return $('#control').checked && attachedId; }
function sendInput(ev) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: 'input', event: ev }));
}
function normXY(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}
const BTN = { 0: 'L', 1: 'M', 2: 'R' };

let lastMove = 0;
canvas.addEventListener('mousemove', (e) => {
  if (!controlOn()) return;
  const now = performance.now();
  if (now - lastMove < 16) return; // ~60/s cap
  lastMove = now;
  const { x, y } = normXY(e);
  sendInput({ kind: 'move', x, y });
});
canvas.addEventListener('mousedown', (e) => {
  if (!controlOn()) return;
  e.preventDefault(); canvas.focus();
  const { x, y } = normXY(e);
  sendInput({ kind: 'down', button: BTN[e.button] || 'L', x, y });
});
canvas.addEventListener('mouseup', (e) => {
  if (!controlOn()) return;
  const { x, y } = normXY(e);
  sendInput({ kind: 'up', button: BTN[e.button] || 'L', x, y });
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  if (!controlOn()) return;
  e.preventDefault();
  sendInput({ kind: 'wheel', dy: e.deltaY < 0 ? 120 : -120 });
}, { passive: false });

// Keyboard — only when the canvas has focus.
canvas.addEventListener('keydown', (e) => {
  if (!controlOn()) return;
  e.preventDefault();
  const printable = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
  if (printable) {
    sendInput({ kind: 'text', ch: e.key });
  } else {
    pressed.add(e.code);
    sendInput({ kind: 'key', code: e.code, down: true });
  }
});
canvas.addEventListener('keyup', (e) => {
  if (!controlOn()) return;
  e.preventDefault();
  if (pressed.has(e.code)) {
    pressed.delete(e.code);
    sendInput({ kind: 'key', code: e.code, down: false });
  }
});
// Release everything if focus leaves, so keys don't get stuck down.
canvas.addEventListener('blur', () => {
  for (const code of pressed) sendInput({ kind: 'key', code, down: false });
  pressed.clear();
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
$('#chat-toggle').addEventListener('click', () => { $('#chat').hidden = !$('#chat').hidden; });
$('#chat-send').addEventListener('click', sendChat);
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const t = $('#chat-input').value.trim();
  if (!t || !ws) return;
  ws.send(JSON.stringify({ type: 'chat', text: t }));
  addChat(t, 'me');
  $('#chat-input').value = '';
}
function addChat(text, who) {
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  el.textContent = text;
  $('#chat-log').appendChild(el);
  $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
  if (who === 'them' && $('#chat').hidden) $('#chat').hidden = false;
}

$('#detach').addEventListener('click', () => {
  if (ws) ws.send(JSON.stringify({ type: 'detach' }));
  attachedId = null; showPlaceholder();
});

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
