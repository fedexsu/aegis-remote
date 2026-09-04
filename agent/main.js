'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session, Tray, Menu, nativeImage, screen, powerMonitor, clipboard, powerSaveBlocker } = require('electron');

// CRITICAL for a headless (hidden-window) capture agent: Windows occlusion
// detection marks the hidden window "occluded" and stops compositing its video,
// which freezes the desktop-capture <video> element (stale/stagnant screen even
// though timers run). Disabling it keeps the capture live. Also force GPU
// compositing so frames keep flowing when unseen.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

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
let injectorOk = false;
// Recompile injector.exe from source using the .NET Framework csc.exe that ships
// with Windows. Self-heals when antivirus quarantines the tiny unsigned binary
// (a common false positive for anything that synthesizes input).
function compileInjector() {
  const dir = path.join(__dirname, 'injector');
  const src = path.join(dir, 'Injector.cs');
  const out = path.join(dir, 'injector.exe');
  const cscs = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  const csc = cscs.find((p) => fs.existsSync(p));
  if (!csc || !fs.existsSync(src)) return false;
  try {
    require('child_process').execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/out:' + out, src], { stdio: 'ignore', windowsHide: true });
    return fs.existsSync(out);
  } catch { return false; }
}
function startInjector() {
  const exe = path.join(__dirname, 'injector', 'injector.exe');
  if (!fs.existsSync(exe)) {
    // Missing (e.g. quarantined by AV) — try to rebuild it from source.
    if (!compileInjector() || !fs.existsSync(exe)) { injectorOk = false; setTimeout(startInjector, 60000); return; }
  }
  try {
    injector = spawn(exe, [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    injectorOk = true;
    injector.on('exit', () => { injector = null; injectorOk = false; setTimeout(startInjector, 2000); });
    injector.on('error', () => { injector = null; injectorOk = false; setTimeout(startInjector, 3000); });
  } catch { injector = null; injectorOk = false; setTimeout(startInjector, 3000); }
}
function inject(cmd) {
  if (injector && injector.stdin.writable) {
    injector.stdin.write(cmd + '\n');
  }
}
ipcMain.handle('injector:status', () => injectorOk);

// ---------------------------------------------------------------------------
// Run-as-user helper — launch apps as the LOGGED-IN USER (see openAsUser). Needed
// because the service build runs this agent as SYSTEM, and a SYSTEM-launched
// browser starts but never shows its window. Same runtime-compile trick as the
// injector so an AV quarantine self-heals.
// ---------------------------------------------------------------------------
function compileRunAs() {
  const dir = path.join(__dirname, 'runas');
  const src = path.join(dir, 'RunAsUser.cs');
  const out = path.join(dir, 'RunAsUser.exe');
  const csc = ['C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'].find((p) => fs.existsSync(p));
  if (!csc || !fs.existsSync(src)) return false;
  try { require('child_process').execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/out:' + out, src], { stdio: 'ignore', windowsHide: true }); return fs.existsSync(out); } catch { return false; }
}
function ensureRunAs() { const exe = path.join(__dirname, 'runas', 'RunAsUser.exe'); if (fs.existsSync(exe)) return exe; return (compileRunAs() && fs.existsSync(exe)) ? exe : ''; }

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
      // CRITICAL: the window is hidden (headless agent). Without this, Chromium
      // throttles the hidden window's timers/media to ~1fps and stalls it — which
      // froze the screen stream AND delayed op replies (terminal/files/system/
      // clipboard all came back empty). Keep it running at full rate.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  try { win.webContents.setBackgroundThrottling(false); } catch {}
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

// A stable, unique-PER-MACHINE device id. It MUST stay the same across reinstalls,
// rebrands, and per-user vs SYSTEM-service launches — otherwise the same PC enrolls
// twice and shows up as two rows (one online, one offline) on the dashboard.
//
// So we key off the Windows MachineGuid (a hardware/OS install id under
// HKLM\SOFTWARE\Microsoft\Cryptography), which every process on the box reads the
// same. We hash it (with a fixed salt) so we don't leak the raw MachineGuid, and
// cache it to a file. Only if the registry read fails do we fall back to a random
// UUID persisted per install (old behaviour).
function machineGuid() {
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { windowsHide: true, timeout: 4000 }
    ).toString();
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{10,})/);
    if (m) return m[1].trim().toLowerCase();
  } catch { /* not Windows, or reg unavailable */ }
  return '';
}
function getDeviceId() {
  const p = path.join(app.getPath('userData'), 'device-id');
  // STABLE id: once assigned it NEVER changes, so the console, the relay and the
  // uninstaller always agree on the same id. This prevents duplicate device rows and
  // broken uninstall protection caused by id drift (e.g. an early build that used a
  // random UUID, or a one-off failure to read the MachineGuid). Only compute on the
  // very first run, then persist and reuse forever.
  try {
    const existing = fs.readFileSync(p, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run — no id file yet */ }
  // First run: prefer a deterministic id from the MachineGuid (salted hash so the raw
  // guid never leaves the machine); fall back to a random id only if it can't be read.
  const guid = machineGuid();
  const id = guid
    ? 'm-' + crypto.createHash('sha256').update('aegis:' + guid).digest('hex').slice(0, 24)
    : crypto.randomUUID();
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
    keepAwake,
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

// User presence: idle seconds (mouse+keyboard) + active/idle/locked, all from
// Electron's native powerMonitor — no webcam, no spawned process.
ipcMain.handle('presence:get', () => {
  let idle = 0, state = 'unknown';
  try { idle = powerMonitor.getSystemIdleTime(); } catch {}
  // 300s threshold: shows "idle" only after 5 min of no input; flips back to
  // "active" the instant input resumes (idle time resets to ~0).
  try { state = powerMonitor.getSystemIdleState(300); } catch {}
  return { idle, state };
});

// ---------------------------------------------------------------------------
// Op channel: remote terminal (and, later, sysinfo/processes/files). The
// renderer (capture.js) relays ops from the console over the WS; results go
// back the same way. child_process lives here in the main process.
// ---------------------------------------------------------------------------
const shells = new Map(); // reqId -> powershell child process
function opReply(m) { if (win && !win.isDestroyed()) try { win.webContents.send('op:msg', m); } catch {} }

const putStreams = new Map(); // reqId -> fs write stream (uploads)
const getStreams = new Map(); // reqId -> fs read stream (downloads)

ipcMain.on('op', (_e, msg) => {
  const { op, reqId, payload = {} } = msg || {};
  try {
    if (op === 'term-open') termOpen(reqId);
    else if (op === 'term-input') { const s = shells.get(reqId); if (s) s.stdin.write(payload.data || ''); }
    else if (op === 'term-close') termClose(reqId);
    else if (op === 'fs-list') fsList(reqId, payload.path);
    else if (op === 'fs-get') fsGet(reqId, payload.path);
    else if (op === 'fs-put-begin') fsPutBegin(reqId, payload.path);
    else if (op === 'fs-put-chunk') { const w = putStreams.get(reqId); if (w) w.write(Buffer.from(payload.b64 || '', 'base64')); }
    else if (op === 'fs-put-end') fsPutEnd(reqId);
    else if (op === 'fs-del') fsDel(reqId, payload.path);
    else if (op === 'fs-mkdir') fsMkdir(reqId, payload.path);
    else if (op === 'sys-mon-start') sysMonStart(reqId);
    else if (op === 'sys-mon-stop') sysMonStop(reqId);
    else if (op === 'proc-list') procList(reqId);
    else if (op === 'proc-kill') procKill(reqId, payload.pid);
    else if (op === 'blank') {
      let coverPath = null;
      if (payload.on) {
        if (payload.coverPath && fs.existsSync(payload.coverPath)) {
          coverPath = payload.coverPath;
          if (payload.coverVersion) { try { fs.writeFileSync(coverPath + '.ver', String(payload.coverVersion)); } catch {} } // mark cached version
        } else { coverPath = blankImageFromPayload(payload); } // legacy small-image base64
      }
      setBlank(!!payload.on, coverPath);
      opReply({ type: 'opResult', reqId, ok: true, data: { blank: !!payload.on } });
    }
    else if (op === 'cover-check') { // does the remote already have this cover version cached?
      let has = false;
      try { has = fs.existsSync(payload.path) && fs.readFileSync(payload.path + '.ver', 'utf8') === String(payload.version); } catch {}
      opReply({ type: 'opResult', reqId, ok: true, data: { has } });
    }
    else if (op === 'lockinput') { inject('B ' + (payload.on ? '1' : '0')); opReply({ type: 'opResult', reqId, ok: true, data: { locked: !!payload.on } }); }
    else if (op === 'cad') { inject('SAS'); opReply({ type: 'opResult', reqId, ok: true }); }   // Ctrl+Alt+Del (needs elevated/service to actually fire)
    else if (op === 'clip-get') {
      try {
        const im = clipboard.readImage();
        if (im && !im.isEmpty()) opReply({ type: 'opResult', reqId, ok: true, data: { kind: 'image', image: im.toDataURL() } });
        else opReply({ type: 'opResult', reqId, ok: true, data: { kind: 'text', text: clipboard.readText() } });
      } catch (e) { opReply({ type: 'opResult', reqId, ok: false, error: e.message }); }
    }
    else if (op === 'clip-set') {
      try {
        if (payload.image) clipboard.writeImage(nativeImage.createFromDataURL(payload.image));
        else clipboard.writeText(payload.text || '');
        opReply({ type: 'opResult', reqId, ok: true });
      } catch (e) { opReply({ type: 'opResult', reqId, ok: false, error: e.message }); }
    }
    else if (op === 'paths') opReply({ type: 'opResult', reqId, ok: true, data: { desktop: safePath('desktop'), downloads: safePath('downloads'), documents: safePath('documents'), temp: safePath('temp') } });
    else if (op === 'fs-search') fsSearch(reqId, payload.root, payload.query);
    else if (op === 'deploy-run') deployRun(reqId, payload || {});
    else if (op === 'launch') openAsUser(reqId, payload || {});
    else if (op === 'hw-info') hwInfo(reqId);
    else if (op === 'keepawake') setKeepAwake(reqId, !!payload.on);
    else if (op === 'power') powerAction(reqId, payload.action);
    else if (op === 'op-cancel') { termClose(reqId); fsCancel(reqId); sysMonClear(reqId); }
  } catch (e) { opReply({ type: 'opEnd', reqId, ok: false, error: e.message }); }
});

// ---- system monitor (streamed samples) ----
const monitors = new Map(); // reqId -> interval
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const t in c.times) total += c.times[t]; idle += c.times.idle; }
  return { idle, total };
}
let lastCpu = cpuTimes();
function cpuPercent() {
  const cur = cpuTimes();
  const idle = cur.idle - lastCpu.idle, total = cur.total - lastCpu.total;
  lastCpu = cur;
  return total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100))) : 0;
}
function safePath(name) { try { return app.getPath(name); } catch { return ''; } }
// Software deployment: run an uploaded installer (.exe/.msi) on the remote,
// optionally silent + elevated. MSI goes through msiexec; elevated runs use
// Start-Process -Verb RunAs (a UAC prompt appears on the remote unless the agent
// is already elevated). Output is captured for non-elevated runs. Temp file is
// removed after it finishes.
function splitArgs(s) { return (String(s || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((a) => a.replace(/^"|"$/g, '')); }
function deployRun(reqId, payload) {
  const file = String(payload.path || '');
  if (!file || !fs.existsSync(file)) return opReply({ type: 'opResult', reqId, ok: false, error: 'installer not found on remote' });
  const isMsi = payload.msi || /\.msi$/i.test(file);
  const extra = splitArgs(payload.args);
  const cleanup = () => { setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 3000); };
  try {
    if (payload.elevated) {
      // Elevated: UAC on the remote. Capture only the exit code.
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const argList = isMsi ? ['/i', file, '/qn', ...extra] : extra;
      const alPs = argList.length ? ' -ArgumentList ' + argList.map(q).join(',') : '';
      const target = isMsi ? 'msiexec' : file;
      const ps = "$p=Start-Process -FilePath " + q(target) + alPs + " -Verb RunAs -Wait -PassThru; $p.ExitCode";
      const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', ps], { windowsHide: true });
      let out = '';
      proc.stdout.on('data', (d) => (out += d)); proc.stderr.on('data', (d) => (out += d));
      proc.on('close', () => { cleanup(); const code = parseInt((out.trim().match(/-?\d+/) || [])[0] || '0', 10); opReply({ type: 'opResult', reqId, ok: true, data: { exitCode: code, output: 'Ran elevated (UAC). Exit code ' + code + '.' } }); });
      proc.on('error', (e) => { cleanup(); opReply({ type: 'opResult', reqId, ok: false, error: e.message }); });
      return;
    }
    const cmd = isMsi ? 'msiexec.exe' : file;
    const cmdArgs = isMsi ? ['/i', file, '/qn', ...extra] : extra;
    const proc = spawn(cmd, cmdArgs, { windowsHide: true });
    let out = '';
    const to = setTimeout(() => { try { proc.kill(); } catch {} }, 15 * 60 * 1000);
    proc.stdout.on('data', (d) => { out += d; if (out.length > 20000) out = out.slice(-20000); });
    proc.stderr.on('data', (d) => { out += d; if (out.length > 20000) out = out.slice(-20000); });
    proc.on('close', (code) => { clearTimeout(to); cleanup(); opReply({ type: 'opResult', reqId, ok: true, data: { exitCode: code, output: out.trim() || ('Finished with exit code ' + code + '.') } }); });
    proc.on('error', (e) => { clearTimeout(to); cleanup(); opReply({ type: 'opResult', reqId, ok: false, error: e.message }); });
  } catch (e) { cleanup(); opReply({ type: 'opResult', reqId, ok: false, error: e.message }); }
}
// Open an app or URL ON THE REMOTE as the LOGGED-IN USER — even though the agent
// runs as SYSTEM (service build). Browsers (Chrome/Edge/Firefox) and lots of user
// software refuse to run under the SYSTEM account, so launching them directly from
// the agent silently fails. Trick: hand the target to explorer.exe — the user's
// already-running shell launches it under the USER token (medium integrity), so it
// opens normally on their desktop. Works for a program path OR a URL (opens their
// default browser). Falls back gracefully if no interactive shell is present.
// Resolve a well-known app keyword to its real .exe via the "App Paths" registry
// key (how Windows itself finds chrome.exe/msedge.exe/etc.). Returns '' if the app
// isn't installed. Checked HKLM then HKCU (per-user installs live under HKCU).
const APP_EXE = { chrome: 'chrome.exe', edge: 'msedge.exe', msedge: 'msedge.exe', firefox: 'firefox.exe' };
function resolveApp(name) {
  const exe = APP_EXE[String(name || '').toLowerCase()];
  if (!exe) return '';
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad = process.env['LOCALAPPDATA'] || (process.env['USERPROFILE'] ? process.env['USERPROFILE'] + '\\AppData\\Local' : '');
  const CANDS = {
    'chrome.exe': [pf + '\\Google\\Chrome\\Application\\chrome.exe', pf86 + '\\Google\\Chrome\\Application\\chrome.exe', lad + '\\Google\\Chrome\\Application\\chrome.exe'],
    'msedge.exe': [pf86 + '\\Microsoft\\Edge\\Application\\msedge.exe', pf + '\\Microsoft\\Edge\\Application\\msedge.exe'],
    'firefox.exe': [pf + '\\Mozilla Firefox\\firefox.exe', pf86 + '\\Mozilla Firefox\\firefox.exe'],
  };
  // 1) standard install locations (fast, no shell)
  for (const c of (CANDS[exe] || [])) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  // 2) fallback: the "App Paths" registry (covers non-standard install dirs). Use
  // execFileSync with an ARGS ARRAY — a command string breaks on the space in
  // "App Paths" when it goes through cmd.
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      const out = require('child_process').execFileSync('reg', ['query', hive + '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exe, '/ve'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const m = out.match(/REG_SZ\s+(.+?)\s*$/m);
      if (m && m[1]) { const p = m[1].trim().replace(/^"|"$/g, ''); if (fs.existsSync(p)) return p; }
    } catch {}
  }
  return '';
}
// Open an app or URL ON THE REMOTE as the LOGGED-IN USER — even though the agent
// runs as SYSTEM (service build). Browsers (Chrome/Edge/Firefox) and lots of user
// software refuse to run under SYSTEM, so launching them directly from the agent
// silently fails. Trick: hand the target to explorer.exe — the user's already-
// running shell launches it under the USER token (medium integrity), so it opens
// normally on their desktop. `app` = a quick-launch keyword; `target` = a raw
// path or URL. Falls back gracefully if no interactive shell is present.
function openAsUser(reqId, payload) {
  const appKey = String((payload && payload.app) || '').trim().toLowerCase();
  const WIN = process.env['WINDIR'] || 'C:\\Windows';
  let appPath = '', extraArgs = [], label = '';
  if (appKey === 'files' || appKey === 'explorer') { appPath = WIN + '\\explorer.exe'; label = 'File Explorer'; }
  else if (appKey) {
    const p = resolveApp(appKey);
    if (!p) return opReply({ type: 'opResult', reqId, ok: false, error: (appKey.charAt(0).toUpperCase() + appKey.slice(1)) + " isn't installed on this PC." });
    appPath = p; label = p.split('\\').pop();
  } else {
    const t = String((payload && payload.target) || '').trim().replace(/[\r\n]/g, '');
    if (!t || t.length > 2048) return opReply({ type: 'opResult', reqId, ok: false, error: 'Enter an app path or a URL to open.' });
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) { appPath = WIN + '\\System32\\rundll32.exe'; extraArgs = ['url.dll,FileProtocolHandler', t]; label = t; } // URL -> default browser, as the user
    else { appPath = t; label = t; }
  }
  const mon = (payload && payload.monitor) || null; // { cx, cy } of the monitor the technician is viewing
  launchOnDesktop(reqId, appPath, extraArgs, label, mon);
}
// Launch a program on the visible desktop AS THE LOGGED-IN USER. We ALWAYS try the
// RunAsUser.exe helper first (real user token + winsta0\default) — that's what makes
// browsers render when the agent is SYSTEM. If the helper can't do it (e.g. this is
// the per-user build, so it lacks the privilege to grab another token), we fall back
// to a plain direct launch, which is correct in that case. This "always try, then
// fall back" avoids depending on detecting whether we're SYSTEM.
function launchOnDesktop(reqId, appPath, extraArgs, label, monitor) {
  extraArgs = extraArgs || [];
  const done = (ok, info) => opReply(ok ? { type: 'opResult', reqId, ok: true, data: { opened: label, info: info || '' } } : { type: 'opResult', reqId, ok: false, error: info });
  const direct = () => {
    try {
      const p = spawn(appPath, extraArgs, { windowsHide: true, detached: true });
      let failed = false;
      p.on('error', (e) => { failed = true; done(false, e.message); });
      try { p.unref(); } catch {}
      setTimeout(() => { if (!failed) done(true, 'launched directly (agent is the user)'); }, 350);
    } catch (e) { done(false, e.message); }
  };
  const exe = ensureRunAs();
  if (!exe) return direct(); // helper couldn't be compiled (no .NET?) — best effort
  // Prefix "--at cx cy" so the helper moves the app's window onto the monitor the
  // technician is viewing (multi-monitor). Skipped when we don't know the monitor.
  const at = (monitor && Number.isFinite(monitor.cx) && Number.isFinite(monitor.cy)) ? ['--at', String(Math.round(monitor.cx)), String(Math.round(monitor.cy))] : [];
  let p, out = '';
  try { p = spawn(exe, at.concat([appPath], extraArgs), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return direct(); }
  p.stdout.on('data', (d) => { out += d.toString(); });
  p.on('error', () => direct());
  p.on('close', (code) => { if (code === 0) done(true, 'as user · ' + out.trim()); else direct(); }); // helper couldn't (per-user build / no user) -> direct
}
// Recursive filename search under a root, capped + time-limited so a huge drive
// can't hang. Streams back the first 300 matches.
function fsSearch(reqId, root, query) {
  const q = String(query || '').replace(/["`$;|<>()*?]/g, '').trim();
  if (!q) return opReply({ type: 'opResult', reqId, ok: false, error: 'empty query' });
  let base = String(root || '').trim();
  if (!base) base = (process.env.SystemDrive || 'C:') + '\\';
  const psBase = base.replace(/'/g, "''"), psQ = q.replace(/'/g, "''");
  const ps = "Get-ChildItem -LiteralPath '" + psBase + "' -Recurse -File -Filter '*" + psQ + "*' -Force -ErrorAction SilentlyContinue"
    + " | Select-Object -First 300 | ForEach-Object{[pscustomobject]@{name=$_.Name;full=$_.FullName;size=$_.Length;mtime=[int64]($_.LastWriteTimeUtc-[datetime]'1970-01-01').TotalMilliseconds}} | ConvertTo-Json -Compress";
  const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', ps], { windowsHide: true });
  let out = '';
  const to = setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', () => {});
  proc.on('close', () => { clearTimeout(to); try { let arr = JSON.parse(out || '[]'); if (!Array.isArray(arr)) arr = arr ? [arr] : []; opReply({ type: 'opResult', reqId, ok: true, data: { entries: arr, root: base } }); } catch (e) { opReply({ type: 'opResult', reqId, ok: false, error: 'parse: ' + e.message }); } });
  proc.on('error', (e) => { clearTimeout(to); opReply({ type: 'opResult', reqId, ok: false, error: e.message }); });
}
// Detailed hardware/OS inventory via CIM/WMI (serial, model, full specs). One
// PowerShell process returns a JSON blob the console renders as a spec sheet.
function hwInfo(reqId) {
  const ps = "$ErrorActionPreference='SilentlyContinue';"
    + "$cs=Get-CimInstance Win32_ComputerSystem;$b=Get-CimInstance Win32_BIOS;$o=Get-CimInstance Win32_OperatingSystem;"
    + "$bb=Get-CimInstance Win32_BaseBoard;$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1;"
    + "$gpu=@(Get-CimInstance Win32_VideoController|ForEach-Object{$_.Name});"
    + "$ram=@(Get-CimInstance Win32_PhysicalMemory|ForEach-Object{[pscustomobject]@{capGB=[math]::Round($_.Capacity/1GB,0);speed=$_.Speed;mfr=($_.Manufacturer);part=([string]$_.PartNumber).Trim()}});"
    + "$disks=@(Get-CimInstance Win32_DiskDrive|ForEach-Object{[pscustomobject]@{model=$_.Model;sizeGB=[math]::Round($_.Size/1GB,0);iface=$_.InterfaceType;serial=([string]$_.SerialNumber).Trim()}});"
    + "$net=@(Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter=true'|Where-Object{$_.MACAddress}|ForEach-Object{[pscustomobject]@{name=$_.Name;mac=$_.MACAddress}});"
    + "[pscustomobject]@{manufacturer=$cs.Manufacturer;model=$cs.Model;systemType=$cs.SystemType;serial=$b.SerialNumber;"
    + "bios=[pscustomobject]@{vendor=$b.Manufacturer;version=[string]$b.SMBIOSBIOSVersion;date=('{0:yyyy-MM-dd}' -f $b.ReleaseDate)};"
    + "board=[pscustomobject]@{mfr=$bb.Manufacturer;product=$bb.Product;serial=$bb.SerialNumber};"
    + "cpu=[pscustomobject]@{name=$cpu.Name;cores=$cpu.NumberOfCores;threads=$cpu.NumberOfLogicalProcessors;mhz=$cpu.MaxClockSpeed};"
    + "ramTotalGB=[math]::Round($cs.TotalPhysicalMemory/1GB,1);ramSlots=$ram;gpu=$gpu;disks=$disks;net=$net;"
    + "os=[pscustomobject]@{caption=$o.Caption;version=$o.Version;build=$o.BuildNumber;arch=$o.OSArchitecture;installed=('{0:yyyy-MM-dd}' -f $o.InstallDate);lastBoot=('{0:yyyy-MM-dd HH:mm}' -f $o.LastBootUpTime)};"
    + "hostname=$env:COMPUTERNAME;user=$env:USERNAME}|ConvertTo-Json -Depth 5 -Compress";
  const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', ps], { windowsHide: true });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', () => {});
  proc.on('close', () => { try { opReply({ type: 'opResult', reqId, ok: true, data: { hw: JSON.parse(out || '{}') } }); } catch (e) { opReply({ type: 'opResult', reqId, ok: false, error: 'parse: ' + e.message }); } });
  proc.on('error', (e) => opReply({ type: 'opResult', reqId, ok: false, error: e.message }));
}
function diskInfo() {
  const out = [];
  for (const d of listDrives()) {
    try { const s = fs.statfsSync(d); const total = s.blocks * s.bsize; const free = s.bfree * s.bsize; out.push({ name: d, total, used: total - free }); } catch {}
  }
  return out;
}
function sysMonStart(reqId) {
  const send = () => opReply({ type: 'opStream', reqId, sample: {
    cpu: cpuPercent(), memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(),
    uptime: os.uptime(), cores: os.cpus().length, disks: diskInfo(),
  } });
  send();
  monitors.set(reqId, setInterval(send, 2000));
}
function sysMonClear(reqId) { const iv = monitors.get(reqId); if (iv) { clearInterval(iv); monitors.delete(reqId); } }
function sysMonStop(reqId) { sysMonClear(reqId); opReply({ type: 'opEnd', reqId, ok: true }); }

// ---- task manager ----
function procList(reqId) {
  const ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
    "Get-Process | Select-Object Id,ProcessName,@{n='ws';e={$_.WorkingSet64}},@{n='cpu';e={[math]::Round($_.CPU,1)}} | Sort-Object ws -Descending | ConvertTo-Json -Compress"], { windowsHide: true });
  let out = '';
  ps.stdout.on('data', (d) => (out += d));
  ps.stderr.on('data', () => {});
  ps.on('close', () => { try { let arr = JSON.parse(out || '[]'); if (!Array.isArray(arr)) arr = [arr]; opReply({ type: 'opResult', reqId, ok: true, data: { procs: arr } }); } catch (e) { opReply({ type: 'opResult', reqId, ok: false, error: 'parse: ' + e.message }); } });
  ps.on('error', (e) => opReply({ type: 'opResult', reqId, ok: false, error: e.message }));
}
// ---- blank remote monitor (privacy screen) ----
// A dedicated C# helper (blanker.exe) owns fullscreen black windows and flags
// them WDA_EXCLUDEFROMCAPTURE: the local person sees black, our screen capture
// still records the real desktop. It MUST be a separate process — display
// affinity only sticks when set by the window's OWNING process, so doing it from
// Electron (or via the injector on an Electron window) was denied by Windows and
// leaked black into the capture. The helper is click-through + non-activating so
// the technician's injected input still reaches the desktop underneath.
function compileBlanker() {
  const dir = path.join(__dirname, 'blanker');
  const src = path.join(dir, 'Blanker.cs');
  const out = path.join(dir, 'blanker.exe');
  const cscs = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  const csc = cscs.find((p) => fs.existsSync(p));
  if (!csc || !fs.existsSync(src)) return false;
  try {
    require('child_process').execFileSync(csc, ['/nologo', '/optimize+', '/target:winexe',
      '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:Microsoft.CSharp.dll', '/out:' + out, src],
      { stdio: 'ignore', windowsHide: true });
    return fs.existsSync(out);
  } catch { return false; }
}
let blankProc = null;
let blankImgPath = null;
function setBlank(on, imagePath) {
  if (on) {
    if (blankProc) return;
    const exe = path.join(__dirname, 'blanker', 'blanker.exe');
    if (!fs.existsSync(exe) && !compileBlanker()) return; // self-heal if AV removed it
    try {
      blankImgPath = imagePath || null;
      const args = imagePath ? [imagePath] : []; // optional cover image, else plain black
      blankProc = spawn(exe, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      blankProc.on('exit', () => { blankProc = null; });
      blankProc.on('error', () => { blankProc = null; });
    } catch { blankProc = null; }
  } else if (blankProc) {
    // Stop GRACEFULLY: closing stdin makes it exit cleanly and restore the
    // hidden cursors. Hard-kill only as a fallback if it doesn't quit in time.
    const p = blankProc; blankProc = null;
    try { p.stdin.end(); } catch {}
    const t = setTimeout(() => { try { p.kill(); } catch {} }, 2000);
    p.on('exit', () => clearTimeout(t));
    blankImgPath = null; // keep the cover file cached on the remote so it isn't re-uploaded next time
  }
}
const destroyBlank = () => setBlank(false);
// On startup, defensively reload the system cursors in case a previous run was
// hard-killed while the privacy blank had them hidden.
function restoreCursorsSafety() {
  const exe = path.join(__dirname, 'blanker', 'blanker.exe');
  if (!fs.existsSync(exe) && !compileBlanker()) return;
  try { spawn(exe, ['--restore'], { stdio: 'ignore', windowsHide: true, detached: true }).unref(); } catch {}
}
// Decode an optional blank cover image (data URL / base64) to a temp file the
// blanker can load. Returns the path, or null for plain black.
function blankImageFromPayload(payload) {
  if (!payload || !payload.on || !payload.image) return null;
  try {
    const b64 = String(payload.image).replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || buf.length > 12 * 1024 * 1024) return null; // sanity cap
    const p = path.join(app.getPath('temp'), 'aegis-blank-cover.img');
    fs.writeFileSync(p, buf);
    return p;
  } catch { return null; }
}

function procKill(reqId, pid) {
  const exe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill';
  const ps = spawn(exe, ['/PID', String(pid), '/F', '/T'], { windowsHide: true });
  ps.on('close', (code) => opReply({ type: 'opResult', reqId, ok: code === 0, error: code === 0 ? undefined : 'could not kill (exit ' + code + ')' }));
  ps.on('error', (e) => opReply({ type: 'opResult', reqId, ok: false, error: e.message }));
}

// ---- keep-awake (prevent the machine from sleeping so it stays reachable) ----
let saveBlockerId = null;
let keepAwake = false;
function applyKeepAwake(on) {
  keepAwake = !!on;
  try {
    if (keepAwake) { if (saveBlockerId == null || !powerSaveBlocker.isStarted(saveBlockerId)) saveBlockerId = powerSaveBlocker.start('prevent-app-suspension'); }
    else if (saveBlockerId != null && powerSaveBlocker.isStarted(saveBlockerId)) { powerSaveBlocker.stop(saveBlockerId); saveBlockerId = null; }
  } catch {}
}
function setKeepAwake(reqId, on) {
  applyKeepAwake(on);
  try { const cfg = loadConfig(); cfg.keepAwake = keepAwake; saveConfig(cfg); } catch {}
  opReply({ type: 'opResult', reqId, ok: true, data: { keepAwake } });
}

// ---- power controls ----
function powerAction(reqId, action) {
  // Reboot into (or out of) Safe Mode. bcdedit needs admin → elevate via RunAs
  // (UAC prompt on the remote unless the agent is already elevated), then reboot.
  if (action === 'safemode' || action === 'normalmode') {
    const bcd = action === 'safemode' ? 'bcdedit /set {current} safeboot minimal' : 'bcdedit /deletevalue {current} safeboot';
    opReply({ type: 'opResult', reqId, ok: true, data: { action } });
    setTimeout(() => { try { spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', "Start-Process cmd -Verb RunAs -ArgumentList '/c " + bcd + " & shutdown /r /t 3 /f'"], { windowsHide: true, detached: true }); } catch {} }, 600);
    return;
  }
  const sys = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : '';
  const shutdown = path.join(sys, 'shutdown.exe');
  const rundll = path.join(sys, 'rundll32.exe');
  const map = {
    lock: [rundll, ['user32.dll,LockWorkStation']],
    logoff: [shutdown, ['/l']],
    sleep: [rundll, ['powrprof.dll,SetSuspendState', '0,1,0']],
    restart: [shutdown, ['/r', '/t', '0', '/f']],
    shutdown: [shutdown, ['/s', '/t', '0', '/f']],
  };
  const cmd = map[action];
  if (!cmd) return opReply({ type: 'opResult', reqId, ok: false, error: 'unknown action' });
  // Reply first so the dashboard hears it before the machine drops.
  opReply({ type: 'opResult', reqId, ok: true, data: { action } });
  setTimeout(() => { try { spawn(cmd[0], cmd[1], { windowsHide: true, detached: true }); } catch {} }, 600);
}

// ---- file browser / transfer ----
function listDrives() {
  const out = [];
  for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { fs.accessSync(d); out.push(d); } catch {} }
  return out;
}
function fsList(reqId, p) {
  try {
    if (!p) {
      const drives = listDrives();
      return opReply({ type: 'opResult', reqId, ok: true, data: { path: '', parent: '', entries: drives.map((d) => ({ name: d, isDir: true, size: 0, mtime: 0 })) } });
    }
    const abs = path.resolve(p);
    const entries = fs.readdirSync(abs).map((n) => {
      try { const st = fs.statSync(path.join(abs, n)); return { name: n, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; }
      catch { return { name: n, isDir: false, size: 0, mtime: 0, err: true }; }
    });
    entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    const parent = path.dirname(abs);
    opReply({ type: 'opResult', reqId, ok: true, data: { path: abs, parent: parent !== abs ? parent : '', entries } });
  } catch (e) { opReply({ type: 'opResult', reqId, ok: false, error: e.message }); }
}
function fsGet(reqId, p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return opReply({ type: 'opEnd', reqId, ok: false, error: 'is a directory' });
    opReply({ type: 'opStream', reqId, meta: { name: path.basename(p), size: st.size } });
    const rs = fs.createReadStream(p, { highWaterMark: 256 * 1024 });
    getStreams.set(reqId, rs);
    rs.on('data', (c) => opReply({ type: 'opStream', reqId, b64: c.toString('base64') }));
    rs.on('end', () => { getStreams.delete(reqId); opReply({ type: 'opEnd', reqId, ok: true }); });
    rs.on('error', (e) => { getStreams.delete(reqId); opReply({ type: 'opEnd', reqId, ok: false, error: e.message }); });
  } catch (e) { opReply({ type: 'opEnd', reqId, ok: false, error: e.message }); }
}
function fsPutBegin(reqId, p) {
  try { const w = fs.createWriteStream(p); putStreams.set(reqId, w); w.on('error', (e) => { putStreams.delete(reqId); opReply({ type: 'opEnd', reqId, ok: false, error: e.message }); }); }
  catch (e) { opReply({ type: 'opEnd', reqId, ok: false, error: e.message }); }
}
function fsPutEnd(reqId) {
  const w = putStreams.get(reqId);
  if (!w) return opReply({ type: 'opEnd', reqId, ok: false, error: 'no upload in progress' });
  w.end(() => { putStreams.delete(reqId); opReply({ type: 'opEnd', reqId, ok: true }); });
}
function fsDel(reqId, p) {
  try { fs.rmSync(p, { recursive: true, force: true }); opReply({ type: 'opResult', reqId, ok: true }); }
  catch (e) { opReply({ type: 'opResult', reqId, ok: false, error: e.message }); }
}
function fsMkdir(reqId, p) {
  try { fs.mkdirSync(p, { recursive: true }); opReply({ type: 'opResult', reqId, ok: true }); }
  catch (e) { opReply({ type: 'opResult', reqId, ok: false, error: e.message }); }
}
function fsCancel(reqId) {
  const w = putStreams.get(reqId); if (w) { try { w.destroy(); } catch {} putStreams.delete(reqId); }
  const r = getStreams.get(reqId); if (r) { try { r.destroy(); } catch {} getStreams.delete(reqId); }
}

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
    let injectorChanged = false, blankerChanged = false, runasChanged = false;
    for (const [name, content] of entries) {
      const dest = path.join(__dirname, name);
      try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch {}
      const tmp = dest + '.new';
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, dest); // atomic swap
      if (name === 'injector/Injector.cs') injectorChanged = true;
      if (name === 'blanker/Blanker.cs') blankerChanged = true;
      if (name === 'runas/RunAsUser.cs') runasChanged = true;
    }
    // The run-as-user helper is a compiled binary too — drop the stale .exe so it
    // recompiles from the new source on next use.
    if (runasChanged) { try { fs.unlinkSync(path.join(__dirname, 'runas', 'RunAsUser.exe')); } catch {} }
    // The injector is a compiled binary, not JS — if its source changed, kill the
    // running one (to unlock the .exe) and recompile so the update actually ships.
    if (injectorChanged) {
      if (injector) { try { injector.kill(); } catch {} injector = null; }
      try { fs.unlinkSync(path.join(__dirname, 'injector', 'injector.exe')); } catch {}
      compileInjector();
    }
    // Same for the blanker helper.
    if (blankerChanged) {
      if (blankProc) { try { blankProc.kill(); } catch {} blankProc = null; }
      try { fs.unlinkSync(path.join(__dirname, 'blanker', 'blanker.exe')); } catch {}
      compileBlanker();
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
  restoreCursorsSafety();
  createWindow();
  createTray();
  try { if (loadConfig().keepAwake) applyKeepAwake(true); } catch {}

  // Forward OS power transitions to the renderer so it can tell the relay it's
  // about to sleep (→ shows "Sleeping", not a hard "Offline") and reconnect
  // immediately on resume.
  powerMonitor.on('suspend', () => { if (win) try { win.webContents.send('power:suspend'); } catch {} });
  powerMonitor.on('resume', () => { if (win) try { win.webContents.send('power:resume'); } catch {} });

  // Self-update: check shortly after start, on every resume, every 5 min, and
  // whenever the agent reconnects to the relay (see ipc 'update:check' below) - so
  // a freshly deployed update reaches online agents within seconds, not 30 min.
  setTimeout(checkForUpdate, 15000);
  setInterval(checkForUpdate, 5 * 60 * 1000);
  powerMonitor.on('resume', () => setTimeout(checkForUpdate, 8000));
});
// The renderer calls this right after it (re)registers with the relay.
ipcMain.handle('update:check', () => { checkForUpdate(); return true; });

app.on('before-quit', () => { app.isQuitting = true; destroyBlank(); if (injector) try { injector.kill(); } catch {} });
app.on('window-all-closed', (e) => { /* keep running in tray */ });
