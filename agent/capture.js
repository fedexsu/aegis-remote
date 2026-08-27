'use strict';

const $ = (s) => document.querySelector(s);
let ws = null;
let connected = false;
let streaming = false;   // a console is attached and wants frames
let guestCount = 0;      // browser-based guest viewers (JPEG); >0 keeps JPEG flowing alongside WebRTC
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
const FPS = 24;       // JPEG-fallback frame rate (raised from 15 for smoother motion)
const MAX_W = 1920;   // capture ceiling; adaptive logic scales down from here
const JPEG_Q = 0.82;  // max quality; adaptive logic lowers it on slow links
// Quality selector (console L/M/H). Caps WebRTC bitrate/resolution + JPEG scale.
let qualityLevel = 'H';
let qMaxScale = 1;
const Q_PROFILES = { L: { br: 2000000, scale: 0.6, fps: 24 }, M: { br: 6000000, scale: 0.8, fps: 30 }, H: { br: 14000000, scale: 1, fps: 30 } };
function applyQuality() {
  const q = Q_PROFILES[qualityLevel] || Q_PROFILES.H;
  qMaxScale = q.scale;
  if (dynScale > qMaxScale) dynScale = qMaxScale;
  if (typeof pc !== 'undefined' && pc) for (const s of pc.getSenders()) {
    if (!s.track || s.track.kind !== 'video') continue;
    try {
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = q.br;
      p.encodings[0].scaleResolutionDownBy = 1 / q.scale;
      p.encodings[0].maxFramerate = q.fps;
      // Keep the picture SHARP (this is a support tool - reading text matters): under
      // uplink pressure, drop framerate before resolution rather than blurring.
      p.degradationPreference = 'maintain-resolution';
      s.setParameters(p);
    } catch {}
  }
}
// Adaptive streaming: on a fast link we send full-res high-quality frames; when
// the uplink can't keep up (frames get dropped by backpressure) we shrink the
// resolution/quality so the picture stays responsive instead of lagging.
let baseW = 0, baseH = 0;
let dynScale = 1, dynQ = JPEG_Q;
let fpSent = 0, fpSkip = 0, adaptTimer = null;

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
  ws.onmessage = (ev) => { lastRx = Date.now(); onMessage(JSON.parse(ev.data)); };
}

// Reconnect resilience for network changes (VPN toggles, Wi-Fi switch). The OS
// TCP stack can take minutes to notice a dead socket, during which the relay has
// already dropped us and the device shows offline. So: reconnect instantly when
// the browser reports the network is back, and run a watchdog that reconnects if
// we've heard nothing from the relay (incl. its 25s heartbeat) for a while.
let lastRx = Date.now();
function forceReconnect() {
  if (!enabled) return;
  backoff = 2000; // a network change isn't a server failure — retry promptly
  if (ws && ws.readyState <= 1) { try { ws.close(); } catch {} } // onclose → scheduleReconnect
  else if (!reconnectTimer) connect();
}
window.addEventListener('online', () => { lastRx = Date.now(); forceReconnect(); });
setInterval(() => {
  if (enabled && ws && ws.readyState === ws.OPEN && Date.now() - lastRx > 40000) forceReconnect();
}, 10000);

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
    // Key not accepted yet (stale installer, briefly-revoked/re-issued link, relay
    // just redeployed). DON'T give up — keep retrying so the machine auto-enrolls
    // the moment the key becomes valid, with no reboot/reinstall needed.
    case 'denied': setStatus(false, 'waiting to enroll (' + msg.reason + ')'); backoff = 30000; break;
    case 'start': rtcIceServers = msg.iceServers || null; startStreaming(); break;
    case 'stop': stopStreaming(); break;
    case 'viewers': guestCount = msg.guests | 0; if (guestCount > 0 && !streaming) startStreaming(); break; // guest viewers need JPEG frames flowing
    case 'quality': qualityLevel = ({ L: 'L', M: 'M', H: 'H' }[msg.level] || 'H'); applyQuality(); break;
    case 'monitor': switchMonitor(msg.id); break;
    case 'input': handleInput(msg.event); break;
    case 'chat': log('💬 ' + msg.text); break;
    case 'wake': if (window.agent.sendWol) window.agent.sendWol(msg.mac); break; // wake a sleeping peer on our LAN
    case 'op': if (window.agent.op) window.agent.op(msg); break; // terminal / sysinfo / etc.
    case 'rtc-answer': if (pc) pc.setRemoteDescription(msg.sdp).catch(() => {}); break;
    case 'rtc-ice': if (pc && msg.candidate) pc.addIceCandidate(msg.candidate).catch(() => {}); break;
  }
}

// ---------------------------------------------------------------------------
// WebRTC video (low-latency). The agent offers, streaming its desktop track;
// the console answers. Signaling rides the same relay WebSocket. If it can't
// connect (strict NAT with no TURN), we simply keep sending JPEG frames.
// ---------------------------------------------------------------------------
let pc = null;
let rtcConnected = false;
let rtcIceServers = null; // provided by the relay on 'start' (STUN + TURN)
const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
async function startRtc() {
  closeRtc();
  if (!stream) return;
  try {
    pc = new RTCPeerConnection({ iceServers: rtcIceServers || ICE });
    for (const t of stream.getVideoTracks()) {
      try { t.contentHint = 'detail'; } catch {} // screen text: prioritise sharpness over motion smoothness
      pc.addTrack(t, stream);
    }
    pc.onicecandidate = (e) => { if (e.candidate && ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'rtc-ice', candidate: e.candidate })); };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') { rtcConnected = true; log('WebRTC connected'); }
      else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) rtcConnected = false;
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Crank the encoder for a sharp 1080p+ picture: full native resolution, a
    // high bitrate ceiling, and drop FPS (not resolution) if the link tightens.
    applyQuality();
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'rtc-offer', sdp: pc.localDescription }));
  } catch (e) { log('rtc error: ' + e.message); closeRtc(); }
}
function closeRtc() { rtcConnected = false; if (pc) { try { pc.close(); } catch {} pc = null; } }

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
  baseW = Math.round(video.videoWidth * scale);
  baseH = Math.round(video.videoHeight * scale);
  canvas.width = baseW;
  canvas.height = baseH;
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
  dynScale = 1; dynQ = JPEG_Q; fpSent = 0; fpSkip = 0;
  captureTimer = setInterval(sendFrame, 1000 / FPS);
  adaptTimer = setInterval(adaptTune, 2000);
  startRtc(); // WebRTC takes over from JPEG once/if it connects
}

// Switch which monitor is streamed (and controlled).
async function switchMonitor(sourceId) {
  const m = MONITORS.find((x) => x.id === sourceId);
  if (!m || !streaming) return;
  selectedBounds = m.bounds;
  try { await startCapture(sourceId); } catch (e) { log('switch error: ' + e.message); return; }
  if (ws) ws.send(JSON.stringify({ type: 'screen', w: canvas.width, h: canvas.height }));
  startRtc(); // the capture stream changed — renegotiate with the new track
}
function stopStreaming() {
  streaming = false;
  guestCount = 0;
  $('#banner').classList.remove('show');
  window.agent.sessionState(false);
  if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  if (adaptTimer) { clearInterval(adaptTimer); adaptTimer = null; }
  closeRtc();
  stopCapture(); // release the screen capture so idle costs nothing
  // Safety: never leave the machine blanked or input-locked if the session ends.
  try { window.agent.op({ op: 'blank', reqId: 'auto-unblank', payload: { on: false } }); } catch {}
  try { window.agent.inject('B 0'); } catch {}
}

let encoding = false;
// Keep at most ~1 frame in flight. Sending more just builds a backlog that shows
// up as latency, so we only send when the socket has essentially drained. On a
// slow link this lowers the frame rate but keeps the picture near-real-time.
const SEND_HIWATER = 24 * 1024;
function sendFrame() {
  if (!streaming || !ws || ws.readyState !== ws.OPEN || !video.videoWidth || encoding) return;
  if (rtcConnected && guestCount === 0) return; // WebRTC carries the primary; JPEG only needed for guest viewers
  if (ws.bufferedAmount > SEND_HIWATER) { fpSkip++; return; } // link behind → drop, keep it live
  const tw = Math.max(480, Math.round(baseW * dynScale));
  const th = Math.max(270, Math.round(baseH * dynScale));
  if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th; }
  ctx.drawImage(video, 0, 0, tw, th);
  encoding = true;
  canvas.toBlob((blob) => {
    encoding = false;
    if (!blob || !streaming || !ws || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > SEND_HIWATER) { fpSkip++; return; }
    blob.arrayBuffer().then((buf) => { try { ws.send(buf); fpSent++; } catch {} }).catch(() => {});
  }, 'image/jpeg', dynQ);
}
// Re-tune every 2s based on how many frames the link is dropping.
function adaptTune() {
  const total = fpSent + fpSkip;
  if (total >= 4) {
    const skipRatio = fpSkip / total;
    if (skipRatio > 0.35) {              // struggling → shrink to stay responsive
      if (dynScale > 0.4) dynScale = Math.max(0.4, dynScale - 0.15);
      else dynQ = Math.max(0.45, dynQ - 0.06);
    } else if (skipRatio < 0.1) {        // headroom → climb back toward full quality
      if (dynQ < JPEG_Q) dynQ = Math.min(JPEG_Q, dynQ + 0.06);
      else if (dynScale < qMaxScale) dynScale = Math.min(qMaxScale, dynScale + 0.12);
    }
  }
  if (dynScale > qMaxScale) dynScale = qMaxScale; // respect the quality selector ceiling
  fpSent = 0; fpSkip = 0;
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
