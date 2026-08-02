'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session, Tray, Menu, nativeImage, screen } = require('electron');
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
});

app.on('before-quit', () => { app.isQuitting = true; if (injector) try { injector.kill(); } catch {} });
app.on('window-all-closed', (e) => { /* keep running in tray */ });
