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
const INSTALLER_PATH = process.env.INSTALLER_PATH || path.join(__dirname, '..', 'release', 'support.exe');
// Elevated (SYSTEM-service) installer variant, served when a build link asks for ?type=service.
const SERVICE_INSTALLER_PATH = process.env.SERVICE_INSTALLER_PATH || path.join(__dirname, '..', 'release', 'support-service.exe');
// Technician desktop client (host) installer, served at /app for the Join flow.
const HOST_INSTALLER_PATH = process.env.HOST_INSTALLER_PATH || path.join(__dirname, '..', 'release', 'HatchConnect-Setup.exe');

// Convert an uploaded video into a looping animated GIF (played natively on every
// remote, unlike WMP video). Plain straight conversion - the hard-cut loop is left
// as-is (boomerang/crossfade loop-smoothing were tried and looked worse). Capped to
// 20s of source, 960px wide, 12fps, 128-colour palette. Needs ffmpeg on PATH.
function videoToGif(input, output, cb) {
  const { execFile } = require('child_process');
  const vf = "fps=12,scale='min(960,iw)':-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5";
  execFile('ffmpeg', ['-y', '-t', '20', '-i', input, '-vf', vf, '-loop', '0', output],
    { timeout: 180000, maxBuffer: 1 << 26 }, (e) => cb(e));
}

// Recent agent enrollment attempts (owner-only diagnostic at /api/enroll-log): shows
// exactly why an agent was accepted or denied, so "installed but not showing" is never
// a mystery.
const enrollLog = [];
function logEnroll(o) { enrollLog.push({ t: Date.now(), ...o }); if (enrollLog.length > 60) enrollLog.shift(); }

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
const appTokens = new Map();   // token -> { adminId, exp } — desktop-app SSO handoff
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
      protected: !!d.protected,             // uninstall protection on?
      uninstallAuthorized: !!d.uninstallAuthorized, // operator released it for removal
    };
  });
}
function pushDevicesNow(adminId) {
  for (const c of consoles.values()) if (c.adminId === adminId && !c.agentId) send(c.ws, { type: 'agents', list: deviceListFor(adminId) });
}
// Coalesce bursts: presence heartbeats from many agents (and reconnect storms)
// would otherwise push the whole device list to every console many times a second,
// which makes the dashboard list flicker. Fire immediately if idle, then collapse
// any further pushes in the next window into a single trailing push per admin.
const _pushDevWindow = 600;
const _pushDevLast = new Map();   // adminId -> last push timestamp
const _pushDevTimer = new Map();  // adminId -> pending trailing timeout
function pushDevices(adminId) {
  const now = Date.now();
  const last = _pushDevLast.get(adminId) || 0;
  if (now - last >= _pushDevWindow) {
    _pushDevLast.set(adminId, now);
    pushDevicesNow(adminId);
  } else if (!_pushDevTimer.has(adminId)) {
    const wait = _pushDevWindow - (now - last);
    _pushDevTimer.set(adminId, setTimeout(() => {
      _pushDevTimer.delete(adminId);
      _pushDevLast.set(adminId, Date.now());
      pushDevicesNow(adminId);
    }, wait));
  }
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
    let b = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { finish(JSON.parse(b || '{}')); } catch { finish({}); } });
    // destroy() on oversize (and network aborts) fire 'close'/'error', not 'end' —
    // resolve there too so the awaiting handler never hangs.
    req.on('close', () => finish({}));
    req.on('error', () => finish({}));
  });
}

// Simple in-memory login throttle (per email+IP): scrypt is slow but there is no
// lockout otherwise. Allows a short burst, then backs off. Cleared on success.
const loginFails = new Map(); // key -> { n, until }
function loginKey(req, email) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  return ip + '|' + (email || '').toLowerCase();
}
function loginBlocked(k) { const e = loginFails.get(k); return e && e.until > Date.now() ? Math.ceil((e.until - Date.now()) / 1000) : 0; }
function loginFail(k) {
  const e = loginFails.get(k) || { n: 0, until: 0 };
  e.n++;
  if (e.n >= 5) e.until = Date.now() + Math.min(15 * 60000, 1000 * 2 ** (e.n - 5)); // exp backoff, cap 15m
  loginFails.set(k, e);
}
function loginOk(k) { loginFails.delete(k); }
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
      const lk = loginKey(req, b.email);
      const wait = loginBlocked(lk);
      if (wait) return json(res, 429, { error: `too many attempts — try again in ${wait}s` });
      const admin = db.findAdminByEmail(b.email);
      if (!admin || !db.verifyPassword(b.password || '', admin.salt, admin.hash)) {
        loginFail(lk);
        return json(res, 401, { error: 'invalid email or password' });
      }
      loginOk(lk);
      if (db.isExpired(admin)) return json(res, 403, { error: 'Your subscription has ended. Renew on our Telegram bot to sign in again.', expired: true, botUrl: 'https://t.me/' + (process.env.BOT_USERNAME || 'hatchconnect') });
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

    // Public: the remote uninstaller asks here whether it's allowed to remove the
    // agent. Denied when the operator turned on uninstall protection and hasn't
    // released this device. Key-authenticated (device id + enrollment key).
    if (urlPath === '/api/uninstall-allowed' && m === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { allowed: db.uninstallAllowed(b.id, b.key) });
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

    // Public: exchange a one-time app-token (minted by an already-signed-in browser)
    // for a real session. Lets the desktop host client sign in automatically instead
    // of prompting the technician to log in again.
    if (urlPath === '/api/app-login' && m === 'POST') {
      const b = await readBody(req);
      const t = b.token && appTokens.get(b.token);
      appTokens.delete(b.token); // single use
      if (!t || t.exp < Date.now()) return json(res, 401, { error: 'expired handoff token' });
      const adm = db.findAdminById(t.adminId);
      if (!adm) return json(res, 401, { error: 'account not found' });
      const token = db.createSession(adm.id);
      return json(res, 200, { admin: db.publicAdmin(adm) }, { 'Set-Cookie': sessionCookie(token) });
    }

    // Public: one-time magic-login token from the Telegram bot -> a real session, so
    // buyers are signed in with one tap (no typing the generated password).
    if (urlPath === '/api/magic-login' && m === 'POST') {
      const b = await readBody(req);
      const adminId = db.consumeMagicToken(b.token);
      const adm = adminId && db.findAdminById(adminId);
      if (!adm) return json(res, 401, { error: 'expired login link' });
      if (db.isExpired(adm)) return json(res, 403, { error: 'subscription expired', expired: true });
      const token = db.createSession(adm.id);
      return json(res, 200, { admin: db.publicAdmin(adm) }, { 'Set-Cookie': sessionCookie(token) });
    }

    // everything below requires auth
    const admin = adminFromReq(req);
    if (!admin) return json(res, 401, { error: 'not signed in' });

    if (urlPath === '/api/me' && m === 'GET') return json(res, 200, { admin: db.publicAdmin(admin) });

    // Subscription status for the dashboard Account section (+ renew link to the bot).
    if (urlPath === '/api/subscription' && m === 'GET') {
      const sub = db.subscriptionOf(admin.id) || {};
      sub.botUrl = 'https://t.me/' + (process.env.BOT_USERNAME || 'hatchconnect');
      return json(res, 200, { subscription: sub });
    }

    // Mint a short-lived, single-use handoff token so the desktop app can adopt this
    // browser's login (see /api/app-login). Bound to this admin, expires in 2 minutes.
    if (urlPath === '/api/app-token' && m === 'POST') {
      const now = Date.now();
      for (const [k, v] of appTokens) if (v.exp < now) appTokens.delete(k); // prune
      const token = require('crypto').randomBytes(24).toString('base64url');
      appTokens.set(token, { adminId: admin.id, exp: now + 120000 });
      return json(res, 200, { token });
    }

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
      const typeFile = path.join(db.DATA_DIR, 'blank-image.type');
      const tmp = dest + '.upload';
      const ct = (req.headers['content-type'] || 'image/png').split(';')[0].toLowerCase();
      const out = fs.createWriteStream(tmp);
      req.pipe(out);
      const finalize = (typeStr) => {
        try { fs.writeFileSync(typeFile, typeStr); return json(res, 200, { ok: true, size: fs.statSync(dest).size, type: typeStr }); }
        catch (e) { return json(res, 500, { error: e.message }); }
      };
      out.on('finish', () => {
        // Video covers only play where the remote has Windows Media Player + the codec.
        // Auto-convert to an animated GIF (drawn natively on every machine). If ffmpeg
        // isn't available or fails, keep the raw video as a fallback.
        if (/^video\//.test(ct)) {
          const gif = dest + '.gif';
          videoToGif(tmp, gif, (err) => {
            if (!err && fs.existsSync(gif) && fs.statSync(gif).size > 0) {
              try { fs.renameSync(gif, dest); fs.unlinkSync(tmp); } catch {}
              return finalize('image/gif');
            }
            console.error('[blank] video->gif conversion failed, keeping raw video:', err && err.message);
            try { fs.unlinkSync(gif); } catch {}
            try { fs.renameSync(tmp, dest); } catch (e) { return json(res, 500, { error: e.message }); }
            return finalize(ct);
          });
          return;
        }
        try { fs.renameSync(tmp, dest); } catch (e) { return json(res, 500, { error: e.message }); }
        finalize(ct);
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

    // Credential vault (per admin) — used by "Manage Credentials" to type saved
    // logins into a focused field on the remote.
    if (urlPath === '/api/credentials' && m === 'GET') return json(res, 200, { credentials: db.getCredentials(admin.id) });
    if (urlPath === '/api/credentials' && m === 'POST') {
      const b = await readBody(req);
      if (!b.label && !b.username) return json(res, 400, { error: 'label or username required' });
      return json(res, 200, { credential: db.addCredential(admin.id, b) });
    }
    if (urlPath === '/api/credentials' && m === 'DELETE') {
      const b = await readBody(req);
      return json(res, 200, { ok: db.removeCredential(admin.id, b.id) });
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
    // Toggle uninstall protection on a device (service build only; see uninstallAllowed).
    if (urlPath === '/api/devices/protection' && m === 'POST') {
      const b = await readBody(req);
      const ok = db.setDeviceProtection(admin.id, b.id, !!b.on);
      pushDevices(admin.id);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'device not found' });
    }
    // Release a protected device so its remote uninstaller is allowed to run.
    if (urlPath === '/api/devices/allow-uninstall' && m === 'POST') {
      const b = await readBody(req);
      const ok = db.allowUninstall(admin.id, b.id);
      pushDevices(admin.id);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'device not found' });
    }
    if (urlPath === '/api/keys' && m === 'GET') {
      const base = publicBase(req);
      const keys = db.keysForAdmin(admin.id).map((k) => {
        const svc = k.meta && k.meta.method === 'service';
        return {
          key: k.key, label: k.label, meta: k.meta || {}, revoked: k.revoked, createdAt: k.createdAt,
          method: svc ? 'service' : 'user',
          downloadUrl: `${base}/dl/${k.key}${svc ? '?type=service' : ''}`,
        };
      });
      return json(res, 200, { keys });
    }
    if (urlPath === '/api/keys' && m === 'POST') {
      const b = await readBody(req);
      const meta = (b.meta && typeof b.meta === 'object') ? b.meta : {};
      if (b.method === 'service') meta.method = 'service';
      const k = db.createKey(admin.id, b.label, meta);
      const svc = meta.method === 'service';
      return json(res, 200, { key: k.key, method: svc ? 'service' : 'user', downloadUrl: `${publicBase(req)}/dl/${k.key}${svc ? '?type=service' : ''}` });
    }
    if (urlPath === '/api/keys/revoke' && m === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { ok: db.revokeKey(admin.id, b.key) });
    }
    if (urlPath === '/api/keys/unrevoke' && m === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { ok: db.unrevokeKey(admin.id, b.key) });
    }
    // Owner diagnostic: recent enrollment attempts (why an agent showed up or didn't).
    if (urlPath === '/api/enroll-log' && m === 'GET') {
      if ((admin.role || 'admin') !== 'owner') return json(res, 403, { error: 'owner only' });
      return json(res, 200, { log: enrollLog.slice().reverse() });
    }
    if (urlPath === '/api/keys/delete' && m === 'POST') {
      const b = await readBody(req);
      const ok = db.deleteKey(admin.id, b.key);
      // Disconnect any live agents enrolled with this now-deleted link.
      if (ok) for (const [id, a] of agents) if (a.adminId === admin.id) { const dev = dbDevice(admin.id, id); if (dev && dev.keyUsed === b.key) { try { a.ws.close(); } catch {} } }
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'link not found' });
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
  // Secure in production (behind Railway's HTTPS proxy) so the token never rides a
  // plaintext connection; omitted in local dev so http://localhost still works.
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `aegis_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}
function publicBase(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

// Serve the current installer that ships with the relay by default, so the enroll
// The freshly-built installer is baked into every deploy, so the BUNDLED file is the
// source of truth — always the latest build. A previously-uploaded copy on the
// persistent volume is only used as a fallback if the bundled file is missing (it
// no longer shadows a newer deploy, which had been serving stale "previous" software).
function installerFile(type) {
  if (type === 'service') {
    if (fs.existsSync(SERVICE_INSTALLER_PATH)) return SERVICE_INSTALLER_PATH; // bundled, latest
    return path.join(db.DATA_DIR, 'support-service.exe');                     // legacy upload fallback
  }
  if (fs.existsSync(INSTALLER_PATH)) return INSTALLER_PATH; // bundled release/support.exe, latest
  return path.join(db.DATA_DIR, 'support.exe');            // legacy upload fallback
}

// Serve the installer with the key in its filename (installer self-configures).
// ?type=service serves the elevated SYSTEM-service build; otherwise the per-user build.
function handleDownload(req, res, urlPath) {
  const key = decodeURIComponent(urlPath.slice('/dl/'.length)).trim();
  const valid = db.findValidKey(key);
  if (!valid) { res.writeHead(404); return res.end('invalid or revoked link'); }
  const type = /[?&]type=service(&|$)/.test(req.url || '') ? 'service' : 'user';
  const namePrefix = type === 'service' ? 'support-service-' : 'support-';
  const file = installerFile(type);
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(503); return res.end('installer not uploaded yet'); }
    // Count the download and push the updated funnel to the admin's dashboards.
    // Skip range/partial requests so a resumed/segmented download isn't double-counted.
    if (!req.headers.range) {
      const k = db.incKeyDownload(key);
      if (k) pushStats(k.adminId);
    }
    // The enrollment key rides in the FILENAME (support-<key>.exe); the installer
    // reads it from its own filename. We must NOT append a trailer — this Inno
    // build locates its data relative to the end of the file, so extra bytes make
    // the installer refuse to run (verified). Serve the exe exactly as-is.
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${namePrefix}${key}.exe"`,
    });
    const rs = fs.createReadStream(file);
    rs.on('error', () => { try { res.destroy(); } catch {} });
    rs.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// HTTP server (API + download + static console/dashboard)
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.startsWith('/api/')) return handleApi(req, res, urlPath);
  if (urlPath.startsWith('/dl/')) return handleDownload(req, res, urlPath);
  // Technician desktop client download (for the Join-in-app flow).
  if (urlPath === '/app') {
    return fs.stat(HOST_INSTALLER_PATH, (err, st) => {
      if (err) { res.writeHead(503); return res.end('host client not available yet'); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="HatchConnect-Setup.exe"' });
      const rs = fs.createReadStream(HOST_INSTALLER_PATH);
      rs.on('error', () => { try { res.destroy(); } catch {} });
      rs.pipe(res);
    });
  }
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

    // One malformed message must never throw out of this handler: this is a single
    // shared process, so an uncaught error here would disconnect every tenant.
    try {
    if (msg.type === 'register') {
      if (msg.role === 'agent') {
        const k = db.findValidKey(msg.key);
        if (!k) {
          // Surface enrollment failures instead of failing silently. Distinguish an
          // empty key (stale installer that couldn't read its key) from a revoked one.
          const attempted = (msg.key || '').slice(0, 8);
          const revoked = msg.key && db.keysForAdmin && db.listAdmins && db.listAdmins().some((a) => (db.keysForAdmin(a.id) || []).some((kk) => kk.key === msg.key && kk.revoked));
          const reason = !msg.key ? 'no key (installer could not read its enrollment key — rebuild/re-upload it)' : (revoked ? 'revoked link' : 'unknown key');
          console.log('[ENROLL DENIED] device=%s name=%s key=%s… reason=%s', msg.id || '?', msg.name || '?', attempted, reason);
          logEnroll({ device: msg.id || null, name: msg.name || null, key: attempted, result: 'denied', reason });
          send(ws, { type: 'denied', reason }); return ws.close();
        }
        const id = msg.id || 'dev-' + seq++;
        // Cross-tenant takeover guard: device ids are derived from the (world-readable)
        // MachineGuid, so a malicious tenant could register with a VICTIM's device id
        // under their own valid key and re-parent that device. Refuse an id already
        // owned by a DIFFERENT admin.
        const priorOwner = db.ownerOfDevice(id);
        if (priorOwner && priorOwner !== k.adminId) {
          // The platform OWNER can reclaim any device (they run everything); a normal
          // customer cannot steal another customer's device.
          const claiming = db.findAdminById(k.adminId);
          const ownerClaim = claiming && (claiming.role || 'admin') === 'owner';
          if (!ownerClaim) {
            console.log('[ENROLL DENIED] device=%s owned by admin=%s (attempted by admin=%s)', id, priorOwner, k.adminId);
            logEnroll({ device: id, name: msg.name || null, key: (k.key || '').slice(0, 8), result: 'denied', reason: 'device already enrolled to another account' });
            send(ws, { type: 'denied', reason: 'this device is already enrolled to another account' });
            return ws.close();
          }
          console.log('[ENROLL] owner reclaiming device=%s from admin=%s', id, priorOwner);
        }
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
        logEnroll({ device: id, name, key: (k.key || '').slice(0, 8), host: meta.host || null, result: 'ok', admin: k.adminId });
        // Self-heal legacy duplicates: older builds keyed the device id off the app's
        // userData folder, so a rebrand/reinstall could enroll the SAME machine twice
        // (one online, one offline). New builds use a stable per-machine id ("m-…").
        // On such a registration, drop a stale legacy row ONLY when it's very likely
        // the same physical machine: same enrollment key AND same host AND same user,
        // legacy (non "m-") id, and currently offline. (Host alone is unsafe — imaged
        // fleets and default DESKTOP-XXXX names collide.)
        if (id.startsWith('m-') && meta.host) {
          for (const other of db.devicesForAdmin(k.adminId)) {
            if (other.id === id || other.id.startsWith('m-')) continue;
            const om = other.meta || {};
            const sameMachine = om.host && om.host === meta.host && (om.user || '') === (meta.user || '') && other.keyUsed === k.key;
            if (sameMachine && !agents.has(other.id)) {
              db.removeDevice(k.adminId, other.id);
              if (offlineTimers.has(other.id)) { clearTimeout(offlineTimers.get(other.id)); offlineTimers.delete(other.id); }
              offlineFlagged.delete(other.id);
              console.log('[DEDUP] removed legacy duplicate %s for host=%s user=%s (now %s)', other.id, meta.host, om.user || '', id);
            }
          }
        }
        pushDevices(k.adminId);
        pushStats(k.adminId);   // an enrollment = an install; refresh the funnel
        // Telegram alerts: new install, or a genuine offline→online recovery.
        if (offlineTimers.has(id)) { clearTimeout(offlineTimers.get(id)); offlineTimers.delete(id); }
        const dev = dbDevice(k.adminId, id);
        if (!known) sendAlert(k.adminId, 'install', dev);
        else if (offlineFlagged.has(id)) sendAlert(k.adminId, 'online', dev);
        offlineFlagged.delete(id);
      } else if (msg.role === 'console') {
        // Cross-site WebSocket hijack guard (defense-in-depth beyond SameSite): a
        // cookie-authenticated console must originate from our own page, not a
        // third-party site opening a socket with the admin's cookie riding along.
        const origin = req.headers.origin;
        if (origin) {
          let oh = ''; try { oh = new URL(origin).host; } catch {}
          if (oh && oh !== req.headers.host) { send(ws, { type: 'denied', reason: 'bad origin' }); return ws.close(); }
        }
        const s = ws.session || db.getSession(msg.token);
        if (!s) { send(ws, { type: 'denied', reason: 'not signed in' }); return ws.close(); }
        if (db.isExpired(db.findAdminById(s.adminId))) { send(ws, { type: 'denied', reason: 'subscription expired' }); return ws.close(); }
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
      if (c.agentId && (msg.type === 'input' || msg.type === 'chat' || msg.type === 'monitor' || msg.type === 'rtc-answer' || msg.type === 'rtc-ice' || msg.type === 'quality')) {
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
    } catch (e) { console.error('[ws] message handler error:', e && e.message); }
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
      // Drop any op routes targeting this now-dead agent so they don't linger until
      // the console happens to close (and tell the console its op ended).
      for (const [reqId, route] of opRoutes) {
        if (route.agentId !== id) continue;
        const c = consoles.get(route.consoleId);
        if (c) send(c.ws, { type: 'opEnd', reqId });
        opRoutes.delete(reqId);
      }
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

// Last-resort guards: a bug in one request/connection must not crash the process
// and disconnect every tenant. Log and keep serving.
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack || e));

server.listen(PORT, () => {
  console.log(`Aegis Remote (multi-tenant) on http://localhost:${PORT}`);
  console.log(`Data dir: ${db.DATA_DIR}`);
  // Telegram sales bot + USDT payment watcher (self-starts only if TG_BOT_TOKEN is set).
  try { require('./bot').start(); } catch (e) { console.error('[bot] failed to start:', e && e.message); }
});
