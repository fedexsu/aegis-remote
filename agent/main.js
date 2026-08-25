'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session, Tray, Menu, nativeImage, screen, powerMonitor } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'agent-config.json');
const DEFAULT_CONFIG = {
  relay: 'ws://localhost:8443',
  key: 'change-me-aegis',
  name: os.hostname(),
  enabled: true, // master "stay online" flag (replaces legacy autoConnect)
};

// Launched by the OS auto-start entry? Then start hidden (to tray).
const STARTED_HIDDEN = process.argv.includes('--startup');

// This build's agent code version (used for self-update). Bump agent/version.json
// + rebuild the bundle to roll an update to every installed agent.
let CODE_VERSION = 0;
try { CODE_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).codeVersion || 0; } catch {}

// Deployment defaults baked into the build/installer (relay URL + key), so a
// freshly installed agent auto-connects with zero setup by the end user.
function bundledDefaults() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')); }
  catch { return {}; }
}
function loadConfig() {
  const bundled = bundledDefaults();
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')); } catch { /* none yet */ }
  if (app.isPackaged) {
    // Installed build: the relay + key come from the baked deployment config and
    // are NOT overridable by saved state — so rotating the key (and reinstalling)
    // actually takes effect. Only user-facing prefs persist.
    return {
      ...DEFAULT_CONFIG, ...bundled,
      name: user.name || bundled.name || DEFAULT_CONFIG.name,
      enabled: user.enabled !== undefined ? user.enabled : (bundled.enabled !== false),
    };
  }
  // Dev build (`electron .`): saved config can override everything, for local testing.
  return { ...DEFAULT_CONFIG, ...bundled, ...user };
}
function saveConfig(cfg) {
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(merged, null, 2));
  return merged;
}

// ---------------------------------------------------------------------------
// Input injector (persistent child process)
// ---------------------------------------------------------------------------
let injector = null;
function startInjector() {
  const exe = path.join(__dirname, 'injector', 'injector.exe');
  if (!fs.existsSync(exe)) {
    console.error('injector.exe missing — run: npm run build-injector');
    return;
  }
  injector = spawn(exe, [], { stdio: ['pipe', 'ignore', 'ignore'] });
  injector.on('exit', () => { injector = null; setTimeout(startInjector, 1000); });
}
function inject(cmd) {
  if (injector && injector.stdin.writable) {
    injector.stdin.write(cmd + '\n');
  }
}

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------
let win = null;
let tray = null;

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 600,
    resizable: false,
    title: 'Aegis Remote — Agent',
    backgroundColor: '#0f1115',
    // The installed (packaged) agent is fully headless — the window exists only
    // to run the capture engine and is never shown. The config UI appears only
    // in dev (`electron .`) for our own testing.
    show: !app.isPackaged && !STARTED_HIDDEN,
    skipTaskbar: app.isPackaged,
    icon: path.join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', (e) => {
    // Minimize to tray instead of quitting (unattended agent keeps running).
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  // Real (small) icon so there's a discreet, honest tray presence.
  let icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'build', 'icon.ico'));
  icon = icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Aegis Remote');

  // Installed build: tray shows only a Quit option (no config UI). Dev build:
  // also allow opening the config window for testing.
  const template = [];
  if (!app.isPackaged) template.push({ label: 'Show', click: () => win.show() }, { type: 'separator' });
  template.push({ label: 'Quit Aegis Remote', click: () => { app.isQuitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(template));

  tray.on('click', () => { if (!app.isPackaged) win.show(); });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('cfg:get', () => loadConfig());
ipcMain.handle('cfg:save', (_e, cfg) => saveConfig(cfg));

// A stable, unique-per-install device id (so two machines with the same
// Windows hostname don't collide on the relay). Generated once, then persisted.
function getDeviceId() {
  const p = path.join(app.getPath('userData'), 'device-id');
  try {
    const id = fs.readFileSync(p, 'utf8').trim();
    if (id) return id;
  } catch { /* not created yet */ }
  const id = crypto.randomUUID();
  try { fs.writeFileSync(p, id); } catch { /* ignore */ }
  return id;
}
ipcMain.handle('device:id', () => getDeviceId());

// Host metadata reported on register, so the dashboard can show full PC info.
ipcMain.handle('meta:get', () => {
  let user = '';
  try { user = os.userInfo().username; } catch {}
  const cpu = (os.cpus()[0] || {}).model || '';
  return {
    os: `${osName()} ${os.release()}`,
    host: os.hostname(),
    user,
    arch: os.arch(),
    cpu: cpu.trim(),
    mem: Math.round(os.totalmem() / 1073741824) + ' GB',
    version: app.getVersion(),
    build: CODE_VERSION,
    mac: primaryMac(),
    subnet: primarySubnet(),
  };
});
// The MAC + /24 subnet of the primary LAN adapter — used so a peer agent on the
// same network can wake this machine with a Wake-on-LAN magic packet.
function primaryIface() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal && i.mac && i.mac !== '00:00:00:00:00:00') return i;
    }
  }
  return null;
}
function primaryMac() { const i = primaryIface(); return i ? i.mac.toUpperCase() : ''; }
function primarySubnet() {
  const i = primaryIface();
  if (!i) return '';
  const p = i.address.split('.'); p[3] = '0';
  return p.join('.'); // e.g. 192.168.1.0 — a coarse same-network grouping
}

// Send a Wake-on-LAN magic packet to a MAC on the local network (used when this
// online agent is asked to wake a sleeping peer on the same subnet).
ipcMain.handle('wol:send', (_e, mac) => {
  try {
    const dgram = require('dgram');
    const clean = String(mac).replace(/[^0-9a-fA-F]/g, '');
    if (clean.length !== 12) return { ok: false, error: 'bad mac' };
    const macBuf = Buffer.from(clean, 'hex');
    const magic = Buffer.concat([Buffer.alloc(6, 0xff), Buffer.alloc(16 * 6)]);
    for (let i = 0; i < 16; i++) macBuf.copy(magic, 6 + i * 6);
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => { try { sock.close(); } catch {} });
    sock.bind(() => {
      sock.setBroadcast(true);
      // Ports 9 and 7 are the conventional WOL targets.
      sock.send(magic, 0, magic.length, 9, '255.255.255.255', () => {
        sock.send(magic, 0, magic.length, 7, '255.255.255.255', () => { try { sock.close(); } catch {} });
      });
    });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
function osName() {
  switch (process.platform) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    default: return process.platform;
  }
}

ipcMain.handle('screen:source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const primary = sources[0];
  return primary ? primary.id : null;
});

// Primary display size in physical pixels — lets the agent report screen dims
// on register WITHOUT opening a capture stream (so idle costs nothing).
ipcMain.handle('screen:size', () => {
  const d = screen.getPrimaryDisplay();
  return { w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor) };
});

// Enumerate monitors (one capture source per display) + the virtual-desktop
// extents, so the console can switch monitors and input maps correctly.
ipcMain.handle('screen:list', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const monitors = sources.map((s, i) => {
    const d = displays.find((dd) => String(dd.id) === String(s.display_id)) || displays[i] || screen.getPrimaryDisplay();
    return {
      id: s.id,
      label: (d.id === primaryId ? 'Primary' : 'Screen ' + (i + 1)),
      bounds: d.bounds,
      primary: d.id === primaryId,
    };
  });
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const d of displays) {
    left = Math.min(left, d.bounds.x); top = Math.min(top, d.bounds.y);
    right = Math.max(right, d.bounds.x + d.bounds.width); bottom = Math.max(bottom, d.bounds.y + d.bounds.height);
  }
  return { monitors, virtual: { left, top, width: right - left, height: bottom - top } };
});

ipcMain.on('inject', (_e, cmd) => inject(cmd));

// ---------------------------------------------------------------------------
// Op channel: remote terminal (and, later, sysinfo/processes/files). The
// renderer (capture.js) relays ops from the console over the WS; results go
// back the same way. child_process lives here in the main process.
// ---------------------------------------------------------------------------
const shells = new Map(); // reqId -> powershell child process
function opReply(m) { if (win && !win.isDestroyed()) try { win.webContents.send('op:msg', m); } catch {} }

ipcMain.on('op', (_e, msg) => {
  const { op, reqId, payload = {} } = msg || {};
  try {
    if (op === 'term-open') termOpen(reqId);
    else if (op === 'term-input') { const s = shells.get(reqId); if (s) s.stdin.write(payload.data || ''); }
    else if (op === 'term-close' || op === 'op-cancel') termClose(reqId);
  } catch (e) { opReply({ type: 'opEnd', reqId, ok: false, error: e.message }); }
});

function termOpen(reqId) {
  if (shells.has(reqId)) return;
  const shell = spawn('powershell.exe', ['-NoLogo', '-NoProfile'], { windowsHide: true });
  shells.set(reqId, shell);
  shell.stdout.on('data', (d) => opReply({ type: 'opStream', reqId, chunk: d.toString('utf8') }));
  shell.stderr.on('data', (d) => opReply({ type: 'opStream', reqId, chunk: d.toString('utf8') }));
  shell.on('close', (code) => { shells.delete(reqId); opReply({ type: 'opEnd', reqId, ok: true, code }); });
  shell.on('error', (e) => { shells.delete(reqId); opReply({ type: 'opEnd', reqId, ok: false, error: e.message }); });
}
function termClose(reqId) {
  const s = shells.get(reqId);
  if (s) { try { s.stdin.end(); } catch {} try { s.kill(); } catch {} shells.delete(reqId); }
}
app.on('before-quit', () => { for (const s of shells.values()) { try { s.kill(); } catch {} } });

// ---------------------------------------------------------------------------
// Self-update: fetch the latest agent JS bundle from the (baked, trusted) relay
// over HTTPS, hot-swap the JS files, and relaunch. No reinstall, no re-upload.
// Only the agent's own JS is updated — config (relay/key) and the compiled
// injector are left untouched.
// ---------------------------------------------------------------------------
let updating = false;
function relayHttpBase() {
  const cfg = loadConfig();
  return (cfg.relay || '').replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
}
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const r = lib.get(url, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; if (b.length > 20e6) r.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
  });
}
async function checkForUpdate() {
  if (updating) return;
  const base = relayHttpBase();
  if (!base) return;
  try {
    const data = await httpGetJson(`${base}/api/agent-update?have=${CODE_VERSION}`);
    if (!data || data.upToDate || !data.files || !(data.version > CODE_VERSION)) return;
    // Sanity: every file must be non-empty before we overwrite anything.
    const entries = Object.entries(data.files);
    if (!entries.length || entries.some(([, c]) => typeof c !== 'string' || !c.length)) return;
    updating = true;
    for (const [name, content] of entries) {
      const dest = path.join(__dirname, name);
      const tmp = dest + '.new';
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, dest); // atomic swap
    }
    // Relaunch into the new code (hidden, like autostart).
    app.relaunch({ args: ['--startup'] });
    app.exit(0);
  } catch { /* offline or relay down — try again on the next tick */ }
}

// ---- Auto-start with Windows (login item, runs in the interactive session) ----
function autostartArgs() {
  // When packaged, execPath IS our agent exe. In dev it's electron.exe, so we
  // must also pass the app directory as an argument.
  return app.isPackaged ? ['--startup'] : [path.resolve(__dirname, '..'), '--startup'];
}
ipcMain.handle('autostart:get', () => app.getLoginItemSettings({ args: autostartArgs() }).openAtLogin);
ipcMain.handle('autostart:set', (_e, on) => {
  app.setLoginItemSettings({
    openAtLogin: !!on,
    path: process.execPath,
    args: autostartArgs(),
  });
  return app.getLoginItemSettings({ args: autostartArgs() }).openAtLogin;
});

// Reflect session state in the tray/title (consent / overtness).
ipcMain.on('session:state', (_e, active) => {
  if (tray) tray.setToolTip(active ? 'Aegis Remote — CONTROLLED NOW' : 'Aegis Remote Agent (idle)');
  if (win && !win.isDestroyed()) win.setTitle(active ? '🔴 Aegis Remote — session active' : 'Aegis Remote — Agent');
});

// ---------------------------------------------------------------------------
// Single-instance: a second launch (e.g. login auto-start racing a manual run)
// just focuses the existing window instead of starting a duplicate agent.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (!win.isVisible()) win.show(); win.focus(); }
  });
}

app.whenReady().then(() => {
  // Allow getUserMedia desktop capture without a picker.
  session.defaultSession.setDisplayMediaRequestHandler((request, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      cb({ video: sources[0], audio: 'loopback' });
    });
  }, { useSystemPicker: false });

  startInjector();
  createWindow();
  createTray();

  // Forward OS power transitions to the renderer so it can tell the relay it's
  // about to sleep (→ shows "Sleeping", not a hard "Offline") and reconnect
  // immediately on resume.
  powerMonitor.on('suspend', () => { if (win) try { win.webContents.send('power:suspend'); } catch {} });
  powerMonitor.on('resume', () => { if (win) try { win.webContents.send('power:resume'); } catch {} });

  // Self-update: check shortly after start, on every resume, and every 30 min.
  setTimeout(checkForUpdate, 15000);
  setInterval(checkForUpdate, 30 * 60 * 1000);
  powerMonitor.on('resume', () => setTimeout(checkForUpdate, 8000));
});

app.on('before-quit', () => { app.isQuitting = true; if (injector) try { injector.kill(); } catch {} });
app.on('window-all-closed', (e) => { /* keep running in tray */ });
