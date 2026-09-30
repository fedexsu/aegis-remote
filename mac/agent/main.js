'use strict';

// HatchConnect for macOS — Phase 1 agent skeleton.
//
// What this DOES:
//   • Reads config (~/Library/Application Support/HatchConnect/config.json).
//   • Computes a stable device id from IOPlatformUUID (same salted-sha256
//     scheme + "m-" prefix as the Windows agent, so relay dedup logic Just Works).
//   • Opens a WebSocket to the relay, registers as an agent with meta.platform=mac.
//   • Sends presence heartbeats.
//   • Reconnects on drop with exponential backoff.
//   • Shows a small onboarding window asking to grant Screen Recording +
//     Accessibility permissions (permission checks are Phase 2 — for now the
//     window just links to the right System Settings pane).
//
// What this DOES NOT do yet (later phases):
//   • Screen capture (Phase 2 — needs ScreenCaptureKit via a Swift helper).
//   • Input injection (Phase 3 — needs CGEventPost via a Swift helper).
//   • File / clipboard / terminal ops (Phase 4).
//
// Any console op that arrives before its phase is implemented is acknowledged
// with { ok: false, error: "not implemented on macOS yet" } so the technician
// sees a clear message instead of a hang.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const SUPPORT_DIR = path.join(HOME, 'Library', 'Application Support', 'HatchConnect');
try { fs.mkdirSync(SUPPORT_DIR, { recursive: true }); } catch {}

const CONFIG_PATH = path.join(SUPPORT_DIR, 'config.json');
const DEVICE_ID_PATH = path.join(SUPPORT_DIR, 'device-id');
const CODE_VERSION = 1; // bumps on every JS-bundle self-update; see relay's /api/agent-update

// ---------------------------------------------------------------------------
// Config: relay URL + enrollment key. Written by installer.command; if we ever
// launch without one (dev-mode / mis-install) we fall back to a safe default
// that just idles offline instead of crashing.
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { relay: 'wss://aegis-relay-production.up.railway.app', key: '', enabled: false };
  }
}
const CFG = loadConfig();

// ---------------------------------------------------------------------------
// Device id: salted sha256 of IOPlatformUUID (hardware id), same scheme as the
// Windows agent — MachineGuid there, IOPlatformUUID here — so a device row in
// the relay DB is identified consistently across the platforms it was designed
// for. Persisted on first launch so a botched read (e.g. ioreg missing) doesn't
// re-mint an id and clone the device on the console.
// ---------------------------------------------------------------------------
function readIOPlatformUUID() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-d2', '-c', 'IOPlatformExpertDevice']).toString('utf8');
    const m = out.match(/IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{20,})"/);
    return m ? m[1] : '';
  } catch { return ''; }
}
function getDeviceId() {
  try {
    const existing = fs.readFileSync(DEVICE_ID_PATH, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const uuid = readIOPlatformUUID();
  const id = uuid
    ? 'm-' + crypto.createHash('sha256').update('aegis:' + uuid).digest('hex').slice(0, 24)
    : crypto.randomUUID();
  try { fs.writeFileSync(DEVICE_ID_PATH, id); } catch {}
  return id;
}
const DEVICE_ID = getDeviceId();

// ---------------------------------------------------------------------------
// Meta the register message carries — the console renders these under the
// device card and uses meta.platform to hide Windows-only buttons.
// ---------------------------------------------------------------------------
function meta() {
  let macVer = '';
  try { macVer = execFileSync('/usr/bin/sw_vers', ['-productVersion']).toString().trim(); } catch {}
  let cpu = '';
  try { cpu = execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']).toString().trim(); } catch {}
  return {
    platform: 'mac',
    os: 'macOS ' + macVer,
    macVer,
    host: os.hostname(),
    user: os.userInfo().username,
    cpu,
    arch: process.arch,
    tier: 'user',   // "user" = LaunchAgent; "system" would be a future LaunchDaemon build
    version: CODE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// WebSocket to the relay. Uses Electron's built-in WebSocket (from the renderer
// in the Windows agent) — but on Phase 1 we don't even need a renderer, so we
// use the `ws` module in the main process. When Phase 2 adds capture we'll move
// this to a renderer (capture.js style) so we can use Chromium's WebRTC stack.
// ---------------------------------------------------------------------------
let WS = null;
let backoff = 2000;
const MAX_BACKOFF = 30000;
let heartbeatTimer = null;

function connect() {
  if (!CFG.enabled) return;
  const url = CFG.relay;
  try {
    // Node ws is not bundled with Electron main, but Electron ships Chromium's
    // network stack — we load `ws` from the resources dir if it was bundled at
    // build time, otherwise fall through to a `require('electron').net`-based
    // fallback (Phase 1.5).
    const WebSocket = require('ws');
    WS = new WebSocket(url);
  } catch (e) {
    console.error('[relay] cannot open WebSocket:', e.message);
    return scheduleReconnect();
  }
  WS.on('open', () => {
    backoff = 2000;
    // Try to fetch screen size early so the console can pre-size its canvas.
    let scr = { w: 1440, h: 900 };
    try {
      const { screen } = require('electron');
      const p = screen.getPrimaryDisplay();
      scr = { w: Math.round(p.size.width * p.scaleFactor), h: Math.round(p.size.height * p.scaleFactor) };
    } catch {}
    WS.send(JSON.stringify({
      type: 'register',
      role: 'agent',
      id: DEVICE_ID,
      name: os.hostname(),
      key: CFG.key,
      screen: scr,
      meta: meta(),
    }));
    startHeartbeat();
  });
  WS.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    handleServerMessage(msg);
  });
  WS.on('close', () => {
    stopHeartbeat();
    scheduleReconnect();
  });
  WS.on('error', () => { /* onclose handles reconnect */ });
}
function scheduleReconnect() {
  if (WS) { try { WS.close(); } catch {} WS = null; }
  const t = backoff;
  backoff = Math.min(backoff * 2, MAX_BACKOFF);
  setTimeout(connect, t);
}
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (WS && WS.readyState === 1) {
      try { WS.send(JSON.stringify({ type: 'presence', idle: 0, state: 'active' })); } catch {}
    }
  }, 25000);
}
function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

// ---------------------------------------------------------------------------
// Handle messages from the relay. In Phase 1 we only care about denied /
// registered / plain ops (we ack ops as "not implemented" so the tech sees a
// clear message). Phase 2+ hook the real work in.
// ---------------------------------------------------------------------------
function handleServerMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'denied':
      console.warn('[relay] enrolment denied:', msg.reason || '(no reason)');
      // Relay closes the socket for us; reconnect with backoff on 'close'.
      break;
    case 'registered':
      console.log('[relay] registered as', msg.id);
      break;
    case 'op': {
      // Phase 1: acknowledge every op with a clear "not implemented" so the
      // console shows a real error, never a hang.
      const reqId = msg.reqId;
      try {
        WS.send(JSON.stringify({
          type: 'opResult',
          reqId,
          ok: false,
          error: 'This action is not supported on macOS yet.',
        }));
      } catch {}
      break;
    }
    default:
      // start/stop/monitor/input/etc. — silently ignored in Phase 1.
      break;
  }
}

// ---------------------------------------------------------------------------
// Onboarding window (Phase 1: static — deep-links to the two System Settings
// panes, no live permission checking yet. Phase 2 replaces this with a live
// checkbox UI that reacts as permissions get granted.)
// ---------------------------------------------------------------------------
let onboardingWin = null;
function openOnboarding() {
  if (onboardingWin && !onboardingWin.isDestroyed()) return onboardingWin.focus();
  onboardingWin = new BrowserWindow({
    width: 480, height: 380, resizable: false, maximizable: false, minimizable: false,
    title: 'HatchConnect', backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  onboardingWin.setMenuBarVisibility(false);
  onboardingWin.loadFile(path.join(__dirname, 'onboarding.html'));
}
ipcMain.handle('open-settings', (_e, kind) => {
  const url = kind === 'screen'
    ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
  shell.openExternal(url);
});
ipcMain.handle('quit', () => { app.isQuitting = true; app.quit(); });

// ---------------------------------------------------------------------------
// App lifecycle — single-instance, dock icon on when onboarding is open, off
// otherwise (so a background agent doesn't crowd the dock).
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('window-all-closed', (e) => { /* keep the agent alive in the background */ });

app.whenReady().then(() => {
  // Only show the onboarding window when NOT started by launchd (i.e., the user
  // opened the app manually from ~/Applications). --startup means launchd fired
  // us on login; stay quiet in the background.
  const startedByLaunchd = process.argv.includes('--startup');
  if (!startedByLaunchd) {
    if (app.dock) app.dock.show();
    openOnboarding();
  } else {
    if (app.dock) app.dock.hide();
  }
  connect();
});
