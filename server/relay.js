'use strict';

// Aegis Remote — multi-tenant relay + API + console host.
//  * Admins sign up / log in (session cookie).
//  * Agents enroll with a per-admin KEY -> the device is tied to that admin.
//  * A console (dashboard) authenticates as an admin and only sees/controls
//    that admin's devices.
//  * /dl/<key> serves the installer named AegisSetup-<key>.exe so the installer
//    can self-configure to that admin (no per-download rebuild).
//
//   node server/relay.js
// Env: PORT, DATA_DIR (persist path), INSTALLER_PATH (installer to serve at /dl).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const db = require('./db');

const PORT = process.env.PORT || 8443;
const PUBLIC = path.join(__dirname, 'public');
const INSTALLER_PATH = process.env.INSTALLER_PATH || path.join(__dirname, '..', 'release', 'AegisSetup.exe');

// Agent self-update bundle (built by scripts/build-agent-bundle.js). Agents poll
// /api/agent-update and hot-swap their JS to this version — no reinstall.
let AGENT_BUNDLE = { version: 0, files: {} };
try { AGENT_BUNDLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-bundle.json'), 'utf8')); }
catch { /* no bundle shipped */ }

// ---------------------------------------------------------------------------
// Live connection state (online status); durable data lives in db.js.
// ---------------------------------------------------------------------------
const agents = new Map();   // deviceId -> { ws, name, adminId, consoleId, streaming }
const consoles = new Map(); // consoleId -> { ws, adminId, agentId }
const opRoutes = new Map(); // reqId -> { consoleId, agentId } — routes op replies back
const guests = new Map();   // agentId -> Set(ws) — browser guest viewers (view-only JPEG)
const guestTokens = new Map(); // token -> { adminId, agentId, exp } — share links
let seq = 1;

function send(ws, obj) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
// Total viewers = attached console (if any) + guests. Start the agent's capture
// when the first viewer arrives, stop it when the last leaves, and always tell
// the agent the guest count (so it emits JPEG frames for guests alongside WebRTC).
function updateViewers(agentId) {
  const a = agents.get(agentId); if (!a) return;
  const g = (guests.get(agentId) || new Set()).size;
  const want = (a.consoleId ? 1 : 0) + g;
  if (want > 0 && !a.streaming) { a.streaming = true; send(a.ws, { type: 'start', iceServers: iceServers() }); }
  else if (want === 0 && a.streaming) { a.streaming = false; send(a.ws, { type: 'stop' }); }
  send(a.ws, { type: 'viewers', guests: g });
}
function dropGuests(agentId, reason) {
  const gs = guests.get(agentId); if (!gs) return;
  for (const g of gs) { try { send(g, { type: 'sessionEnded', reason: reason || 'ended' }); g.close(); } catch {} }
  guests.delete(agentId);
}

// ICE servers for WebRTC, sent to both the agent and console so they match and
// can be changed centrally. STUN attempts direct P2P; TURN relays the media when
// both sides are behind strict NATs. Set your own for production:
//   TURN_URL=turn:your.turn:3478[,turns:your.turn:5349?transport=tcp]
//   TURN_USER=...  TURN_CRED=...
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    list.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER || '', credential: process.env.TURN_CRED || '' });
  } else {
    // Free public fallback (rate-limited — fine for testing; set TURN_* for prod).
    list.push({ urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turns:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' });
  }
  return list;
}

function deviceListFor(adminId) {
  const keyLabels = {};
  for (const k of db.keysForAdmin(adminId)) keyLabels[k.key] = k.label;
  return db.devicesForAdmin(adminId).map((d) => {
    const live = agents.get(d.id);
    const online = !!(live && live.adminId === adminId);
    const res = online && live.screen ? `${live.screen.w}×${live.screen.h}` : (d.meta && d.meta.screen) || null;
    return {
      id: d.id,
      name: d.name,
      online,
      busy: online ? !!live.consoleId : false,
      uninstalled: !online && !!d.uninstalledAt, // reported gone by its uninstaller
      uninstalledAt: d.uninstalledAt || null,
      asleep: !online && !d.uninstalledAt && !!d.asleep, // suspended, not dead
      sleepMac: (d.meta && d.meta.mac) || null,          // for wake-on-LAN
      lastSeen: d.lastSeen,
      firstSeen: d.firstSeen,
      via: keyLabels[d.keyUsed] || null,   // which enrollment link added it
      res,                                  // screen resolution
      meta: d.meta || {},                   // { os, host, user, version, cpu, ... }
      presence: online && live.presence ? live.presence : null, // active/idle/locked
    };
  });
}
function pushDevices(adminId) {
  for (const c of consoles.values()) if (c.adminId === adminId && !c.agentId) send(c.ws, { type: 'agents', list: deviceListFor(adminId) });
}

// ---------------------------------------------------------------------------
// Telegram alerts
// ---------------------------------------------------------------------------
const offlineTimers = new Map();  // deviceId -> timeout (debounce offline)
const offlineFlagged = new Set(); // deviceIds currently considered offline
const OFFLINE_DEBOUNCE = 60000;   // 60s before a drop counts as "offline"

function tgSend(token, chatId, text) {
  return new Promise((resolve) => {
    const https = require('https');
    const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
    const req = https.request({ hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch {} resolve({ ok: res.statusCode === 200 && j.ok, desc: j.description || ('HTTP ' + res.statusCode) }); }); });
    req.on('error', (e) => resolve({ ok: false, desc: e.message }));
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}
function fmtAlert(tpl, device) {
  const m = (device && device.meta) || {};
  return (tpl || '').replace(/{device}/g, (device && device.name) || 'device')
    .replace(/{os}/g, m.os || '—').replace(/{user}/g, m.user || '—')
    .replace(/{host}/g, m.host || '—').replace(/{time}/g, new Date().toLocaleString());
}
function sendAlert(adminId, type, device) {
  const a = db.getAlerts(adminId);
  if (!a.botToken || !a.chatId) return;
  const rule = a.rules[type];
  if (!rule || !rule.on) return;
  tgSend(a.botToken, a.chatId, fmtAlert(rule.template, device));
}
const dbDevice = (adminId, id) => db.devicesForAdmin(adminId).find((d) => d.id === id);
// Push live download/install funnel metrics to an admin's open dashboards.
function pushStats(adminId) {
  const stats = db.statsForAdmin(adminId);
  for (const c of consoles.values()) if (c.adminId === adminId) send(c.ws, { type: 'stats', stats });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function json(res, code, obj, headers) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...(headers || {}) });
  res.end(JSON.stringify(obj));
}
function adminFromReq(req) {
  const s = db.getSession(parseCookies(req).aegis_session);
  return s ? db.findAdminById(s.adminId) : null;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function handleApi(req, res, urlPath) {
  const m = req.method;
  try {
    if (urlPath === '/api/signup' && m === 'POST') {
      // Public sign-up only bootstraps the very first (owner) account. After
      // that it's closed — the owner generates accounts for paying customers.
      if (db.hasAdmins()) return json(res, 403, { error: 'sign-ups are closed' });
      const b = await readBody(req);
      const { admin, key } = db.createAdmin(b.email, b.password, b.name);
      const token = db.createSession(admin.id);
      return json(res, 200, { admin: db.publicAdmin(admin), key: key.key },
        { 'Set-Cookie': sessionCookie(token) });
    }
    if (urlPath === '/api/login' && m === 'POST') {
      const b = await readBody(req);
      const admin = db.findAdminByEmail(b.email);
      if (!admin || !db.verifyPassword(b.password || '', admin.salt, admin.hash)) {
        return json(res, 401, { error: 'invalid email or password' });
      }
      const token = db.createSession(admin.id);
      return json(res, 200, { admin: db.publicAdmin(admin) }, { 'Set-Cookie': sessionCookie(token) });
    }
    if (urlPath === '/api/logout' && m === 'POST') {
      db.deleteSession(parseCookies(req).aegis_session);
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'aegis_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax' });
    }

    // Public: agents poll this to self-update their JS. `have` is the agent's
    // current codeVersion; if it's already current we return a tiny response.
    if (urlPath === '/api/agent-update' && m === 'GET') {
      const have = parseInt((req.url.split('?')[1] || '').match(/have=(\d+)/)?.[1] || '0', 10);
      if (have >= AGENT_BUNDLE.version) return json(res, 200, { version: AGENT_BUNDLE.version, upToDate: true });
      return json(res, 200, { version: AGENT_BUNDLE.version, files: AGENT_BUNDLE.files });
    }

    // Public: the uninstaller reports here (device id + enrollment key) right
    // before it removes the agent, so the device shows "Uninstalled" instead of
    // just going offline. No session — authenticated by the enrollment key.
    if (urlPath === '/api/uninstall' && m === 'POST') {
      const b = await readBody(req);
      const adminId = db.markUninstalled(b.id, b.key);
      if (adminId) {
        const dev = dbDevice(adminId, b.id);
        const live = agents.get(b.id);
        if (live) { try { live.ws.close(); } catch {} agents.delete(b.id); }
        if (offlineTimers.has(b.id)) { clearTimeout(offlineTimers.get(b.id)); offlineTimers.delete(b.id); }
        pushDevices(adminId); pushStats(adminId);
        sendAlert(adminId, 'uninstall', dev);
      }
      return json(res, adminId ? 200 : 404, adminId ? { ok: true } : { error: 'unknown device' });
    }

    // everything below requires auth
    const admin = adminFromReq(req);
    if (!admin) return json(res, 401, { error: 'not signed in' });

    if (urlPath === '/api/me' && m === 'GET') return json(res, 200, { admin: db.publicAdmin(admin) });

    // Upload the installer to the persistent data dir (raw binary body).
    // Owner-only: the installer is a single shared file served to every admin's
    // enrollment links, so customers must not be able to replace it.
    if (urlPath === '/api/installer' && m === 'POST') {
      if ((admin.role || 'admin') !== 'owner') return json(res, 403, { error: 'owner only' });
      const dest = path.join(db.DATA_DIR, 'support.exe');
      try { fs.mkdirSync(db.DATA_DIR, { recursive: true }); } catch {}
      const tmp = dest + '.upload';
      const out = fs.createWriteStream(tmp);
      req.pipe(out);
      out.on('finish', () => {
        try { fs.renameSync(tmp, dest); } catch (e) { return json(res, 500, { error: e.message }); }
        json(res, 200, { ok: true, size: fs.statSync(dest).size });
      });
      out.on('error', (e) => json(res, 500, { error: e.message }));
      return;
    }
    // Report whether the installer has been uploaded (for the dashboard).
    if (urlPath === '/api/installer' && m === 'GET') {
      return json(res, 200, { ready: fs.existsSync(installerFile()) });
    }

    // Global blank-screen cover image. Owner uploads ONE image (raw binary body,
    // like the installer); every admin's console fetches it and shows it on the
    // blanked remote instead of plain black. (Per-account custom images can layer
    // on top of this later as a paid feature.)
    if (urlPath === '/api/blank-image' && m === 'POST') {
      if ((admin.role || 'admin') !== 'owner') return json(res, 403, { error: 'owner only' });
      try { fs.mkdirSync(db.DATA_DIR, { recursive: true }); } catch {}
      const dest = path.join(db.DATA_DIR, 'blank-image.bin');
      const tmp = dest + '.upload';
      const out = fs.createWriteStream(tmp);
      req.pipe(out);
      out.on('finish', () => {
        try {
          fs.renameSync(tmp, dest);
          fs.writeFileSync(path.join(db.DATA_DIR, 'blank-image.type'), (req.headers['content-type'] || 'image/png').split(';')[0]);
        } catch (e) { return json(res, 500, { error: e.message }); }
        json(res, 200, { ok: true, size: fs.statSync(dest).size });
      });
      out.on('error', (e) => json(res, 500, { error: e.message }));
      return;
    }
    if (urlPath === '/api/blank-image' && m === 'GET') {
      const f = path.join(db.DATA_DIR, 'blank-image.bin');
      if (!fs.existsSync(f)) return json(res, 404, { error: 'none' });
      let type = 'image/png';
      try { type = fs.readFileSync(path.join(db.DATA_DIR, 'blank-image.type'), 'utf8').trim() || type; } catch {}
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return fs.createReadStream(f).pipe(res);
    }
    // Lightweight metadata (type + version) so the console can decide whether the
    // remote already has this cover cached, without downloading the whole file.
    if (urlPath === '/api/blank-image/meta' && m === 'GET') {
      const f = path.join(db.DATA_DIR, 'blank-image.bin');
      if (!fs.existsSync(f)) return json(res, 200, { ready: false });
      let type = 'image/png';
      try { type = fs.readFileSync(path.join(db.DATA_DIR, 'blank-image.type'), 'utf8').trim() || type; } catch {}
      const st = fs.statSync(f);
      const kind = /^video\//.test(type) ? 'video' : (type === 'image/gif' ? 'gif' : 'image');
      return json(res, 200, { ready: true, type, kind, version: Math.round(st.mtimeMs), size: st.size });
    }
    if (urlPath === '/api/blank-image' && m === 'DELETE') {
      if ((admin.role || 'admin') !== 'owner') return json(res, 403, { error: 'owner only' });
      try { fs.unlinkSync(path.join(db.DATA_DIR, 'blank-image.bin')); } catch {}
      try { fs.unlinkSync(path.join(db.DATA_DIR, 'blank-image.type')); } catch {}
      return json(res, 200, { ok: true });
    }

    // Create a share link so someone can watch a live session in a browser with
    // no install/login. Bound to one device the admin owns; expires in 30 min.
    if (urlPath === '/api/guest-link' && m === 'POST') {
      const b = await readBody(req);
      const a = agents.get(b.agentId);
      if (!a || a.adminId !== admin.id) return json(res, 404, { error: 'device not found or offline' });
      const now = Date.now();
      for (const [t, v] of guestTokens) if (v.exp < now) guestTokens.delete(t); // prune expired
      const token = require('crypto').randomBytes(18).toString('base64url');
      const ttlMin = 30;
      guestTokens.set(token, { adminId: admin.id, agentId: b.agentId, exp: now + ttlMin * 60000 });
      const proto = req.headers['x-forwarded-proto'] || 'http';
      return json(res, 200, { url: `${proto}://${req.headers['host']}/guest/${token}`, expiresInMin: ttlMin });
    }

    // Change own password.
    if (urlPath === '/api/password' && m === 'POST') {
      const b = await readBody(req);
      if (!db.verifyPassword(b.currentPassword || '', admin.salt, admin.hash)) {
        return json(res, 400, { error: 'current password is incorrect' });
      }
      if (!b.newPassword || b.newPassword.length < 6) return json(res, 400, { error: 'new password must be 6+ characters' });
      db.updatePassword(admin.id, b.newPassword);
      return json(res, 200, { ok: true });
    }

    // Owner-only: list / generate customer accounts.
    const isOwner = (admin.role || 'admin') === 'owner';
    if (urlPath === '/api/accounts' && m === 'GET') {
      if (!isOwner) return json(res, 403, { error: 'owner only' });
      return json(res, 200, { accounts: db.listAdmins().filter((a) => a.role !== 'owner') });
    }
    if (urlPath === '/api/accounts' && m === 'POST') {
      if (!isOwner) return json(res, 403, { error: 'owner only' });
      const b = await readBody(req);
      const crypto = require('crypto');
      const username = (b.username && b.username.trim().toLowerCase()) || ('client-' + crypto.randomBytes(3).toString('hex'));
      const password = crypto.randomBytes(6).toString('base64url'); // ~8 chars
      const { admin: created } = db.createAdmin(username, password, b.name || username, 'admin');
      return json(res, 200, { username: created.email, password });
    }
    if (urlPath === '/api/stats' && m === 'GET') return json(res, 200, { stats: db.statsForAdmin(admin.id) });
    if (urlPath === '/api/devices' && m === 'GET') return json(res, 200, { devices: deviceListFor(admin.id) });
    // Remove (forget) a device. If it's currently online, kick the live agent
    // too so it disappears immediately (it re-enrolls only if still installed).
    if (urlPath === '/api/devices/remove' && m === 'POST') {
      const b = await readBody(req);
      const live = agents.get(b.id);
      if (live && live.adminId === admin.id) { try { live.ws.close(); } catch {} agents.delete(b.id); }
      const ok = db.removeDevice(admin.id, b.id);
      pushDevices(admin.id);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'device not found' });
    }
    // Rename a device.
    if (urlPath === '/api/devices/rename' && m === 'POST') {
      const b = await readBody(req);
      const nm = (b.name || '').trim();
      if (!nm) return json(res, 400, { error: 'name required' });
      const live = agents.get(b.id);
      if (live && live.adminId === admin.id) live.name = nm;
      const ok = db.renameDevice(admin.id, b.id, nm);
      pushDevices(admin.id);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'device not found' });
    }
    if (urlPath === '/api/keys' && m === 'GET') {
      const base = publicBase(req);
      const keys = db.keysForAdmin(admin.id).map((k) => ({
        key: k.key, label: k.label, meta: k.meta || {}, revoked: k.revoked, createdAt: k.createdAt,
        downloadUrl: `${base}/dl/${k.key}`,
      }));
      return json(res, 200, { keys });
    }
    if (urlPath === '/api/keys' && m === 'POST') {
      const b = await readBody(req);
      const meta = (b.meta && typeof b.meta === 'object') ? b.meta : {};
      const k = db.createKey(admin.id, b.label, meta);
      return json(res, 200, { key: k.key, downloadUrl: `${publicBase(req)}/dl/${k.key}` });
    }
    if (urlPath === '/api/keys/revoke' && m === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { ok: db.revokeKey(admin.id, b.key) });
    }
    if (urlPath === '/api/keys/unrevoke' && m === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { ok: db.unrevokeKey(admin.id, b.key) });
    }
    if (urlPath === '/api/alerts' && m === 'GET') return json(res, 200, { alerts: db.getAlerts(admin.id) });
    if (urlPath === '/api/alerts' && m === 'POST') {
      const b = await readBody(req);
      db.setAlerts(admin.id, { botToken: b.botToken, chatId: b.chatId, rules: b.rules });
      return json(res, 200, { ok: true });
    }
    if (urlPath === '/api/alerts/test' && m === 'POST') {
      const b = await readBody(req);
      const token = (b.botToken || '').trim(), chatId = (b.chatId || '').trim();
      if (!token || !chatId) return json(res, 400, { error: 'Enter both a bot token and a chat ID first.' });
      const r = await tgSend(token, chatId, '🛡️ Aegis Remote test alert — your Telegram alerts are working.');
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.desc || 'Telegram rejected the message' });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}
function sessionCookie(token) {
  return `aegis_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}
function publicBase(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

// The admin can upload the installer to the persistent data dir; prefer that.
function installerFile() {
  const support = path.join(db.DATA_DIR, 'support.exe');
  if (fs.existsSync(support)) return support;
  const legacy = path.join(db.DATA_DIR, 'AegisSetup.exe'); // installs uploaded before the rename
  if (fs.existsSync(legacy)) return legacy;
  return INSTALLER_PATH;
}

// Serve the installer with the key in its filename (installer self-configures).
function handleDownload(req, res, urlPath) {
  const key = decodeURIComponent(urlPath.slice('/dl/'.length)).trim();
  const valid = db.findValidKey(key);
  if (!valid) { res.writeHead(404); return res.end('invalid or revoked link'); }
  const file = installerFile();
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(503); return res.end('installer not uploaded yet'); }
    // Count the download and push the updated funnel to the admin's dashboards.
    // Skip range/partial requests so a resumed/segmented download isn't double-counted.
    if (!req.headers.range) {
      const k = db.incKeyDownload(key);
      if (k) pushStats(k.adminId);
    }
    // Embed the enrollment key as a trailer at the END of the .exe so the
    // installer can read it from its own file even if the download gets renamed
    // (browsers add "(1)", users Save-As, etc.). Trailing bytes after the Inno
    // overlay are ignored by the loader/extractor but readable by the installer.
    const trailer = Buffer.from(`##AEGIS-KEY##[${key}]##AEGIS-END##`, 'ascii');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size + trailer.length,
      'Content-Disposition': `attachment; filename="support-${key}.exe"`,
    });
    const rs = fs.createReadStream(file);
    rs.on('error', () => { try { res.destroy(); } catch {} });
    rs.on('end', () => res.end(trailer));
    rs.pipe(res, { end: false });
  });
}

// ---------------------------------------------------------------------------
// HTTP server (API + download + static console/dashboard)
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.startsWith('/api/')) return handleApi(req, res, urlPath);
  if (urlPath.startsWith('/dl/')) return handleDownload(req, res, urlPath);
  // Guest viewer page — join a live session in a browser with no install/login.
  // The token is in the URL and validated when the guest opens its WebSocket.
  if (urlPath.startsWith('/guest/')) {
    return fs.readFile(path.join(PUBLIC, 'guest.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data);
    });
  }

  let rel = urlPath === '/' ? '/app.html' : urlPath;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket: agents (key auth) + consoles (session auth)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

// WebSocket keepalive. Without this, a silently-dropped TCP connection (Wi-Fi
// blip, NAT rebind, proxy idle-timeout, or a throttled hidden agent window) is
// never detected and the device flaps offline/online. Pinging every 25s also
// keeps traffic flowing so intermediaries don't idle-close the socket — and the
// browser answers pings at the network layer even when the renderer's JS is
// throttled, so the connection survives agent-side throttling too.
const HEARTBEAT_MS = 25000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; } // missed the last cycle → dead
    ws.isAlive = false;
    try { ws.ping(); } catch {}
    // Also send an app-level heartbeat to agents. Browsers don't surface WS pings
    // to JS, so this gives the agent a message it CAN see — letting it detect a
    // silently-dead socket (e.g. after a VPN/Wi-Fi change) and reconnect fast.
    if (ws.meta && ws.meta.role === 'agent') { try { ws.send(JSON.stringify({ type: 'hb' })); } catch {} }
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.meta = { role: null, id: null, adminId: null };
  // The browser sends the session cookie on the WS handshake (same origin),
  // so a logged-in dashboard authenticates its console connection automatically.
  ws.session = db.getSession(parseCookies(req).aegis_session);

  ws.on('message', (raw, isBinary) => {
    // Binary = a JPEG screen frame from an agent. Forward straight to its
    // attached console, dropping it if that console's socket is backed up.
    if (isBinary) {
      const { role, id } = ws.meta || {};
      if (role !== 'agent') return;
      const a = agents.get(id);
      if (!a) return;
      // Attached console (ignored by it while WebRTC is up — see app.js).
      if (a.consoleId) {
        const c = consoles.get(a.consoleId);
        // Keep at most ~1 frame queued so a slow viewer stays near-real-time.
        if (c && c.ws.readyState === c.ws.OPEN && c.ws.bufferedAmount <= 48 * 1024) { try { c.ws.send(raw, { binary: true }); } catch {} }
      }
      // Guest viewers (browser, view-only) get the JPEG stream.
      const gs = guests.get(id);
      if (gs) for (const g of gs) { if (g.readyState === g.OPEN && g.bufferedAmount <= 96 * 1024) { try { g.send(raw, { binary: true }); } catch {} } }
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      if (msg.role === 'agent') {
        const k = db.findValidKey(msg.key);
        if (!k) { send(ws, { type: 'denied', reason: 'invalid key' }); return ws.close(); }
        const id = msg.id || 'dev-' + seq++;
        const name = msg.name || id;
        const meta = (msg.meta && typeof msg.meta === 'object') ? msg.meta : {};
        if (msg.screen) meta.screen = `${msg.screen.w}×${msg.screen.h}`;
        // Inherit the enrollment key's labels (Company / Site / Department / Type).
        if (k.meta) for (const fld of ['company', 'site', 'department', 'deviceType']) { if (k.meta[fld]) meta[fld] = k.meta[fld]; }
        const known = !!dbDevice(k.adminId, id);
        db.upsertDevice(id, k.adminId, name, k.key, meta);
        ws.meta = { role: 'agent', id, adminId: k.adminId };
        agents.set(id, { ws, name, adminId: k.adminId, consoleId: null, screen: msg.screen || null });
        send(ws, { type: 'registered', id });
        pushDevices(k.adminId);
        pushStats(k.adminId);   // an enrollment = an install; refresh the funnel
        // Telegram alerts: new install, or a genuine offline→online recovery.
        if (offlineTimers.has(id)) { clearTimeout(offlineTimers.get(id)); offlineTimers.delete(id); }
        const dev = dbDevice(k.adminId, id);
        if (!known) sendAlert(k.adminId, 'install', dev);
        else if (offlineFlagged.has(id)) sendAlert(k.adminId, 'online', dev);
        offlineFlagged.delete(id);
      } else if (msg.role === 'console') {
        const s = ws.session || db.getSession(msg.token);
        if (!s) { send(ws, { type: 'denied', reason: 'not signed in' }); return ws.close(); }
        const id = 'console-' + seq++;
        ws.meta = { role: 'console', id, adminId: s.adminId };
        consoles.set(id, { ws, adminId: s.adminId, agentId: null });
        send(ws, { type: 'registered', id });
        send(ws, { type: 'agents', list: deviceListFor(s.adminId) });
      } else if (msg.role === 'guest') {
        // Browser guest viewer — no account. Auth is the share token in the URL.
        const t = guestTokens.get(msg.token);
        if (!t || t.exp < Date.now()) { send(ws, { type: 'denied', reason: 'This guest link has expired.' }); return ws.close(); }
        const a = agents.get(t.agentId);
        if (!a || a.adminId !== t.adminId) { send(ws, { type: 'denied', reason: 'That device is offline right now.' }); return ws.close(); }
        ws.meta = { role: 'guest', id: 'guest-' + seq++, adminId: t.adminId, agentId: t.agentId };
        if (!guests.has(t.agentId)) guests.set(t.agentId, new Set());
        guests.get(t.agentId).add(ws);
        send(ws, { type: 'guestReady', name: a.name, screen: a.screen });
        updateViewers(t.agentId); // starts capture / raises guest count so JPEG flows
      }
      return;
    }

    const { role, id, adminId } = ws.meta;
    if (!role) return;

    if (role === 'console') {
      const c = consoles.get(id);
      if (!c) return;
      if (msg.type === 'list') { send(ws, { type: 'agents', list: deviceListFor(adminId) }); return; }
      if (msg.type === 'attach') {
        const a = agents.get(msg.agentId);
        if (!a || a.adminId !== adminId) { send(ws, { type: 'error', text: 'device offline' }); return; }
        if (a.consoleId && a.consoleId !== id) { send(ws, { type: 'error', text: 'device busy' }); return; }
        c.agentId = msg.agentId; a.consoleId = id;
        send(ws, { type: 'attached', agentId: msg.agentId, name: a.name, screen: a.screen, iceServers: iceServers() });
        updateViewers(msg.agentId); // sends 'start' to the agent (if not already streaming) + guest count
        pushDevices(adminId);
        return;
      }
      if (msg.type === 'detach') { detachConsole(id); send(ws, { type: 'agents', list: deviceListFor(adminId) }); return; }
      // Generic op channel (terminal, sysinfo, processes, files…) addressed to a
      // device by id — no screen attach required. Replies route back by reqId.
      if (msg.type === 'op') {
        const a = agents.get(msg.agentId);
        if (!a || a.adminId !== adminId) { send(ws, { type: 'opEnd', reqId: msg.reqId, ok: false, error: 'device offline' }); return; }
        opRoutes.set(msg.reqId, { consoleId: id, agentId: msg.agentId });
        send(a.ws, { type: 'op', op: msg.op, reqId: msg.reqId, payload: msg.payload || {} });
        return;
      }
      if (c.agentId && (msg.type === 'input' || msg.type === 'chat' || msg.type === 'monitor' || msg.type === 'rtc-answer' || msg.type === 'rtc-ice')) {
        const a = agents.get(c.agentId);
        if (a && a.adminId === adminId) send(a.ws, msg);
      }
      return;
    }

    if (role === 'agent') {
      const a = agents.get(id);
      if (!a) return;
      // The agent warns us it's about to sleep, so the imminent disconnect is
      // read as "sleeping" rather than a hard offline.
      if (msg.type === 'suspend') { a.suspendHint = Date.now(); return; }
      if (msg.type === 'presence') { a.presence = { state: msg.state, idle: msg.idle, at: Date.now() }; pushDevices(adminId); return; }
      // Op replies from the agent → route back to the console that asked.
      if (msg.type === 'opStream' || msg.type === 'opResult' || msg.type === 'opEnd') {
        const route = opRoutes.get(msg.reqId);
        if (route) { const c = consoles.get(route.consoleId); if (c) send(c.ws, msg); }
        if (msg.type !== 'opStream') opRoutes.delete(msg.reqId);
        return;
      }
      if (msg.type === 'screen') { a.screen = { w: msg.w, h: msg.h }; }
      db.touchDevice(id);
      if (!a.consoleId) return;
      const c = consoles.get(a.consoleId);
      if (!c) return;
      if (msg.type === 'frame') {
        // Drop frames if the console's socket is backed up, so a slow viewer
        // never builds a multi-second (or multi-minute) backlog. Always deliver
        // the freshest frame instead of a growing queue of stale ones.
        if (c.ws.bufferedAmount > 512 * 1024) return;
        send(c.ws, msg);
        return;
      }
      if (msg.type === 'chat' || msg.type === 'screen' || msg.type === 'monitors' || msg.type === 'control' || msg.type === 'rtc-offer' || msg.type === 'rtc-ice') send(c.ws, msg);
      return;
    }
  });

  ws.on('close', () => {
    const { role, id, adminId } = ws.meta || {};
    if (role === 'agent') {
      const a = agents.get(id);
      // Reconnect race: if the agent already re-registered on a NEW socket (e.g.
      // after a VPN/Wi-Fi change), the entry now points at that live socket — this
      // stale close must NOT tear it down or the device flaps offline while it's up.
      if (a && a.ws !== ws) return;
      if (a && a.consoleId) { const c = consoles.get(a.consoleId); if (c) { c.agentId = null; send(c.ws, { type: 'agentGone' }); } }
      dropGuests(id, 'The device went offline.'); // end any guest sessions on this device
      // If a suspend was signalled just before this drop, it's sleeping, not dead.
      const sleeping = a && a.suspendHint && (Date.now() - a.suspendHint) < 90000;
      if (sleeping) db.setAsleep(id, true);
      agents.delete(id);
      if (adminId) pushDevices(adminId);
      // Telegram "offline" alert, debounced so brief reconnects don't spam.
      // (A sleeping machine is reported as sleeping, not a hard offline.)
      if (adminId && !sleeping) {
        if (offlineTimers.has(id)) clearTimeout(offlineTimers.get(id));
        offlineTimers.set(id, setTimeout(() => {
          offlineTimers.delete(id); offlineFlagged.add(id);
          const dev = dbDevice(adminId, id);
          if (dev && !dev.uninstalledAt && !agents.get(id)) sendAlert(adminId, 'offline', dev);
        }, OFFLINE_DEBOUNCE));
      }
    } else if (role === 'console') {
      detachConsole(id);
      // Cancel this console's open ops so the agent tears down any live shells.
      for (const [reqId, route] of opRoutes) {
        if (route.consoleId !== id) continue;
        const a = agents.get(route.agentId);
        if (a) send(a.ws, { type: 'op', op: 'op-cancel', reqId, payload: {} });
        opRoutes.delete(reqId);
      }
      consoles.delete(id);
    } else if (role === 'guest') {
      const agentId = ws.meta && ws.meta.agentId;
      const gs = agentId && guests.get(agentId);
      if (gs) { gs.delete(ws); if (!gs.size) guests.delete(agentId); updateViewers(agentId); } // stops capture if that was the last viewer
    }
  });
});

function detachConsole(consoleId) {
  const c = consoles.get(consoleId);
  if (!c) return;
  if (c.agentId) {
    const a = agents.get(c.agentId);
    const agentId = c.agentId;
    if (a) { a.consoleId = null; }
    c.agentId = null;
    updateViewers(agentId); // stops capture only if no guests are still watching
  }
  if (c.adminId) pushDevices(c.adminId);
}

server.listen(PORT, () => {
  console.log(`Aegis Remote (multi-tenant) on http://localhost:${PORT}`);
  console.log(`Data dir: ${db.DATA_DIR}`);
});
