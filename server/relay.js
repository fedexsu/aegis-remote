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
const agents = new Map();   // deviceId -> { ws, name, adminId, consoleId }
const consoles = new Map(); // consoleId -> { ws, adminId, agentId }
const opRoutes = new Map(); // reqId -> { consoleId, agentId } — routes op replies back
let seq = 1;

function send(ws, obj) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }

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
    if (urlPath === '/api/installer' && m === 'POST') {
      const dest = path.join(db.DATA_DIR, 'AegisSetup.exe');
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
        key: k.key, label: k.label, revoked: k.revoked, createdAt: k.createdAt,
        downloadUrl: `${base}/dl/${k.key}`,
      }));
      return json(res, 200, { keys });
    }
    if (urlPath === '/api/keys' && m === 'POST') {
      const b = await readBody(req);
      const k = db.createKey(admin.id, b.label);
      return json(res, 200, { key: k.key });
    }
    if (urlPath === '/api/keys/revoke' && m === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { ok: db.revokeKey(admin.id, b.key) });
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
  const uploaded = path.join(db.DATA_DIR, 'AegisSetup.exe');
  return fs.existsSync(uploaded) ? uploaded : INSTALLER_PATH;
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
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="AegisSetup-${key}.exe"`,
    });
    fs.createReadStream(file).pipe(res);
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

wss.on('connection', (ws, req) => {
  ws.meta = { role: null, id: null, adminId: null };
  // The browser sends the session cookie on the WS handshake (same origin),
  // so a logged-in dashboard authenticates its console connection automatically.
  ws.session = db.getSession(parseCookies(req).aegis_session);

  ws.on('message', (raw) => {
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
        send(ws, { type: 'attached', agentId: msg.agentId, name: a.name, screen: a.screen });
        send(a.ws, { type: 'start' });
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
      if (c.agentId && (msg.type === 'input' || msg.type === 'chat' || msg.type === 'monitor')) {
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
      if (msg.type === 'frame' || msg.type === 'chat' || msg.type === 'screen' || msg.type === 'monitors') send(c.ws, msg);
      return;
    }
  });

  ws.on('close', () => {
    const { role, id, adminId } = ws.meta || {};
    if (role === 'agent') {
      const a = agents.get(id);
      if (a && a.consoleId) { const c = consoles.get(a.consoleId); if (c) { c.agentId = null; send(c.ws, { type: 'agentGone' }); } }
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
    }
  });
});

function detachConsole(consoleId) {
  const c = consoles.get(consoleId);
  if (!c) return;
  if (c.agentId) {
    const a = agents.get(c.agentId);
    if (a) { a.consoleId = null; send(a.ws, { type: 'stop' }); }
    c.agentId = null;
  }
  if (c.adminId) pushDevices(c.adminId);
}

server.listen(PORT, () => {
  console.log(`Aegis Remote (multi-tenant) on http://localhost:${PORT}`);
  console.log(`Data dir: ${db.DATA_DIR}`);
});
