'use strict';

const $ = (s) => document.querySelector(s);
let ws = null;
let connected = false;
let streaming = false;   // a console is attached and wants frames
let stream = null;
let captureTimer = null;

// Multi-monitor
let MONITORS = [];
let VIRTUAL = null;          // { left, top, width, height } virtual-desktop extents
let selectedSourceId = null; // capture source currently streamed
let selectedBounds = null;   // bounds of the selected monitor (for input mapping)

const video = $('#cap-video');
const canvas = $('#cap-canvas');
const ctx = canvas.getContext('2d');

const CFG = {};
const FPS = 12;
const MAX_W = 1600; // downscale wide screens for bandwidth
const JPEG_Q = 0.55;

let enabled = true;       // master "should be online" flag (persisted)
let DEVICE_ID = null;     // stable unique-per-install id
let reconnectTimer = null;
let backoff = 2000;       // grows on repeated failures, capped
const BACKOFF_MAX = 15000;

// ---------------------------------------------------------------------------
// Boot: load config into the form
// ---------------------------------------------------------------------------
(async function init() {
  const cfg = await window.agent.getConfig();
  Object.assign(CFG, cfg);
  DEVICE_ID = await window.agent.getDeviceId();
  // `enabled` is the new persisted master flag; fall back to legacy autoConnect.
  enabled = cfg.enabled !== undefined ? cfg.enabled : (cfg.autoConnect !== false);
  $('#name').value = cfg.name;
  $('#relay').value = cfg.relay;
  $('#key').value = cfg.key;
  reflectAutostart();
  if (enabled) goOnline();
  else setStatus(false, 'offline');

  // Tell the relay we're about to sleep (so it shows "Sleeping", not offline),
  // and reconnect promptly when we wake.
  if (window.agent.onSuspend) window.agent.onSuspend(() => {
    try { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'suspend' })); } catch {}
  });
  if (window.agent.onResume) window.agent.onResume(() => {
    backoff = 2000;
    if (enabled && (!ws || ws.readyState > 1)) { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } connect(); }
  });
  // Stream op results (terminal output, etc.) from the main process to the relay.
  if (window.agent.onOpMessage) window.agent.onOpMessage((m) => {
    try { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); } catch {}
  });
})();

// The main button toggles the master online/offline state.
$('#connect').addEventListener('click', () => (enabled ? goOffline() : goOnline()));

function log(t) {
  const el = document.createElement('div');
  el.textContent = t;
  $('#log').prepend(el);
}
function setStatus(on, text) {
  $('#pill').className = 'pill ' + (on ? 'on' : 'off');
  $('#pill').textContent = text;
  $('#connect').textContent = enabled ? 'Go offline' : 'Go online';
  $('#connect').classList.toggle('on', enabled);
}

// ---------------------------------------------------------------------------
// Master online/offline (persisted) + resilient reconnect
// ---------------------------------------------------------------------------
async function persist() {
  Object.assign(CFG, {
    name: $('#name').value.trim() || 'device',
    relay: $('#relay').value.trim(),
    key: $('#key').value,
    enabled,
  });
  await window.agent.saveConfig(CFG);
}

async function goOnline() {
  enabled = true;
  await persist();
  connect();
}
async function goOffline() {
  enabled = false;
  await persist();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} }
  stopStreaming();
  connected = false;
  setStatus(false, 'offline');
}
function scheduleReconnect() {
  if (!enabled || reconnectTimer) return;
  setStatus(false, `reconnecting in ${Math.round(backoff / 1000)}s…`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoff);
  backoff = Math.min(BACKOFF_MAX, Math.round(backoff * 1.5));
}

async function connect() {
  if (!enabled) return;
  await persist();
  setStatus(false, 'connecting…');
  try { ws = new WebSocket(CFG.relay); }
  catch { scheduleReconnect(); return; }

  ws.onopen = async () => {
    // Report screen size WITHOUT opening a capture stream — capture only starts
    // when a technician actually attaches (see startStreaming). Idle = no cost.
    let scr = { w: 1280, h: 720 };
    try { scr = await window.agent.getScreenSize(); } catch {}
    let meta = {};
    try { meta = await window.agent.getMeta(); } catch {}
    ws.send(JSON.stringify({
      type: 'register', role: 'agent',
      id: DEVICE_ID, name: CFG.name, key: CFG.key,
      screen: scr, meta,
    }));
    sendPresence(true);
    startPresenceHeartbeat();
  };
  ws.onclose = () => {
    connected = false; stopStreaming(); stopPresenceHeartbeat();
    if (enabled) scheduleReconnect(); else setStatus(false, 'offline');
  };
  ws.onerror = () => { /* onclose handles reconnect */ };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
}

// ---------------------------------------------------------------------------
// Auto-start with Windows (login item)
// ---------------------------------------------------------------------------
async function reflectAutostart() {
  const on = await window.agent.getAutostart();
  const box = $('#autostart');
  if (box) box.checked = on;
}
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'autostart') {
    window.agent.setAutostart(e.target.checked);
  }
});

// Report user presence (idle/active/locked). Poll often and push immediately on
// a state change (so "active" appears the moment someone starts using the PC),
// plus a 30s heartbeat so the idle-duration display stays fresh.
let presenceTimer = null;
let lastPresenceState = null;
let lastPresenceSent = 0;
async function sendPresence(force) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  let p;
  try { p = await window.agent.getPresence(); } catch { return; }
  const now = Date.now();
  const changed = p.state !== lastPresenceState;
  if (changed || force || (now - lastPresenceSent) >= 30000) {
    lastPresenceState = p.state; lastPresenceSent = now;
    try { ws.send(JSON.stringify({ type: 'presence', idle: p.idle, state: p.state })); } catch {}
  }
}
function startPresenceHeartbeat() { if (!presenceTimer) presenceTimer = setInterval(() => sendPresence(false), 5000); }
function stopPresenceHeartbeat() { if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; } lastPresenceState = null; lastPresenceSent = 0; }

function onMessage(msg) {
  switch (msg.type) {
    case 'registered': connected = true; backoff = 2000; setStatus(true, 'online — waiting'); break;
    case 'denied': setStatus(false, 'denied: ' + msg.reason); enabled = false; break;
    case 'start': startStreaming(); break;
    case 'stop': stopStreaming(); break;
    case 'monitor': switchMonitor(msg.id); break;
    case 'input': handleInput(msg.event); break;
    case 'chat': log('💬 ' + msg.text); break;
    case 'wake': if (window.agent.sendWol) window.agent.sendWol(msg.mac); break; // wake a sleeping peer on our LAN
    case 'op': if (window.agent.op) window.agent.op(msg); break; // terminal / sysinfo / etc.
  }
}

// ---------------------------------------------------------------------------
// Screen capture
// ---------------------------------------------------------------------------
function stopCapture() {
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  video.srcObject = null;
}

async function startCapture(sourceId) {
  if (stream) stopCapture();
  if (!sourceId) sourceId = await window.agent.getScreenSource();
  selectedSourceId = sourceId;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 3840,
        maxHeight: 2160,
        maxFrameRate: 30,
      },
    },
  });
  video.srcObject = stream;
  await video.play();
  // Wait for dimensions.
  await new Promise((res) => {
    if (video.videoWidth) return res();
    video.onloadedmetadata = () => res();
  });
  const scale = Math.min(1, MAX_W / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
}

async function startStreaming() {
  if (streaming) return;
  streaming = true;
  $('#banner').classList.add('show');
  window.agent.sessionState(true);
  try {
    // Load the monitor layout so multi-monitor input maps correctly.
    const info = await window.agent.getMonitors();
    MONITORS = info.monitors || []; VIRTUAL = info.virtual || null;
    if (!selectedSourceId || !MONITORS.find((m) => m.id === selectedSourceId)) {
      const primary = MONITORS.find((m) => m.primary) || MONITORS[0];
      selectedSourceId = primary ? primary.id : null;
    }
    selectedBounds = (MONITORS.find((m) => m.id === selectedSourceId) || {}).bounds || null;
    await startCapture(selectedSourceId); // open capture only now that someone is viewing
  } catch (e) {
    log('capture error: ' + e.message);
    streaming = false; $('#banner').classList.remove('show'); window.agent.sessionState(false);
    return;
  }
  if (ws) {
    ws.send(JSON.stringify({ type: 'screen', w: canvas.width, h: canvas.height }));
    ws.send(JSON.stringify({
      type: 'monitors',
      list: MONITORS.map((m) => ({ id: m.id, label: m.label, primary: m.primary })),
      selected: selectedSourceId,
    }));
    // Tell the console whether input control is actually available (the injector
    // can be blocked/removed by antivirus), so it's not a silent failure.
    try { const ok = await window.agent.getInjectorStatus(); ws.send(JSON.stringify({ type: 'control', available: !!ok })); } catch {}
  }
  captureTimer = setInterval(sendFrame, 1000 / FPS);
}

// Switch which monitor is streamed (and controlled).
async function switchMonitor(sourceId) {
  const m = MONITORS.find((x) => x.id === sourceId);
  if (!m || !streaming) return;
  selectedBounds = m.bounds;
  try { await startCapture(sourceId); } catch (e) { log('switch error: ' + e.message); return; }
  if (ws) ws.send(JSON.stringify({ type: 'screen', w: canvas.width, h: canvas.height }));
}
function stopStreaming() {
  streaming = false;
  $('#banner').classList.remove('show');
  window.agent.sessionState(false);
  if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  stopCapture(); // release the screen capture so idle costs nothing
}

function sendFrame() {
  if (!streaming || !ws || ws.readyState !== ws.OPEN || !video.videoWidth) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_Q);
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  ws.send(JSON.stringify({ type: 'frame', data: b64, w: canvas.width, h: canvas.height }));
}

// ---------------------------------------------------------------------------
// Input -> injector commands
// ---------------------------------------------------------------------------
const VK = {
  Escape: 0x1B, Backspace: 0x08, Tab: 0x09, Enter: 0x0D, NumpadEnter: 0x0D, Space: 0x20,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Delete: 0x2E, Insert: 0x2D, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11,
  AltLeft: 0x12, AltRight: 0x12, MetaLeft: 0x5B, MetaRight: 0x5C, CapsLock: 0x14,
  ContextMenu: 0x5D, PrintScreen: 0x2C,
  Minus: 0xBD, Equal: 0xBB, BracketLeft: 0xDB, BracketRight: 0xDD, Backslash: 0xDC,
  Semicolon: 0xBA, Quote: 0xDE, Comma: 0xBC, Period: 0xBE, Slash: 0xBF, Backquote: 0xC0,
};
function codeToVk(code) {
  if (VK[code] !== undefined) return VK[code];
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return 0x30 + Number(code.slice(5));
  if (/^Numpad[0-9]$/.test(code)) return 0x60 + Number(code.slice(6));
  if (/^F([1-9]|1[0-2])$/.test(code)) return 0x70 + (Number(code.slice(1)) - 1);
  return null;
}

// Map a coordinate normalized within the selected monitor's frame to one
// normalized over the whole virtual desktop, so the cursor lands on the right
// screen. Falls back to primary-screen mapping if layout is unknown.
function moveCmd(nx, ny) {
  const b = selectedBounds;
  // Primary monitor (origin 0,0) — direct per-monitor mapping is exact and
  // DPI-safe. Also the fallback when the layout is unknown.
  if (!b || (b.x === 0 && b.y === 0) || !VIRTUAL || !VIRTUAL.width) {
    return `M ${nx.toFixed(5)} ${ny.toFixed(5)}`;
  }
  // Secondary monitor — map within it across the whole virtual desktop.
  const absX = b.x + nx * b.width;
  const absY = b.y + ny * b.height;
  const vx = (absX - VIRTUAL.left) / VIRTUAL.width;
  const vy = (absY - VIRTUAL.top) / VIRTUAL.height;
  return `MV ${vx.toFixed(5)} ${vy.toFixed(5)}`;
}

function handleInput(e) {
  switch (e.kind) {
    case 'move': window.agent.inject(moveCmd(e.x, e.y)); break;
    case 'down': window.agent.inject(moveCmd(e.x, e.y)); window.agent.inject(`D ${e.button}`); break;
    case 'up': window.agent.inject(moveCmd(e.x, e.y)); window.agent.inject(`U ${e.button}`); break;
    case 'wheel': window.agent.inject(`W ${e.dy}`); break;
    case 'key': {
      const vk = codeToVk(e.code);
      if (vk != null) window.agent.inject(`K ${vk} ${e.down ? 1 : 0}`);
      break;
    }
    case 'text':
      for (const ch of e.ch) window.agent.inject(`T ${ch.codePointAt(0)}`);
      break;
  }
}
