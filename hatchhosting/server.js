'use strict';
// HatchHosting backend. Two roles, chosen by env:
//   - APP   (default, runs on the VPS): serves the branded panel and talks to
//     HestiaCP over localhost with an admin access key. Each customer is a Hestia
//     user and logs in with their own Hestia username + password (validated via
//     v-check-user-password); the panel shows only their own account and sites.
//   - PROXY (PROXY_TARGET set, runs on Railway): transparently reverse-proxies
//     every request to the VPS app, so a pretty public HTTPS URL fronts the panel
//     while HestiaCP stays locked to localhost on the VPS.
//
// Env: PORT
//   APP mode:   HESTIA_URL (https://127.0.0.1:8083), HESTIA_KEY ("ID:SECRET")
//   PROXY mode: PROXY_TARGET (e.g. http://147.93.180.138:3000)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const PROXY_TARGET = process.env.PROXY_TARGET || '';

// ---- PROXY mode (Railway) -----------------------------------------------
// Forwards everything (headers, body, cookies, status) to the VPS app.
if (PROXY_TARGET) {
  const t = new URL(PROXY_TARGET);
  const mod = t.protocol === 'https:' ? https : http;
  http.createServer((req, res) => {
    const opts = {
      hostname: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80),
      path: req.url, method: req.method,
      headers: Object.assign({}, req.headers, { host: t.host }),
      rejectUnauthorized: false, timeout: 25000,
    };
    const up = mod.request(opts, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
    up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('HatchHosting server is unreachable right now. (' + e.message + ')'); });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    req.pipe(up);
  }).listen(PORT, () => console.log('HatchHosting PROXY on :' + PORT + ' -> ' + PROXY_TARGET));
  return; // Node wraps CommonJS modules in a function, so top-level return is valid.
}

// ---- APP mode (VPS) ------------------------------------------------------
const HESTIA_URL = process.env.HESTIA_URL || '';
const HESTIA_KEY = process.env.HESTIA_KEY || '';
const LIVE = !!(HESTIA_URL && HESTIA_KEY);

const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const sessions = new Map(); // token -> hestia username
const attempts = new Map(); // ip -> { n, ts }  (basic login throttle)
let clock = 0; // monotonic-ish seconds (Date.now avoided per runtime constraints)
setInterval(() => { clock++; }, 1000).unref?.();
const nowSec = () => clock;
const bumpAttempt = (ip) => { const a = attempts.get(ip); if (a && (nowSec() - a.ts) < 600) { a.n++; a.ts = nowSec(); } else { attempts.set(ip, { n: 1, ts: nowSec() }); } };

// ---- Hestia API ----------------------------------------------------------
function hestia(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = new URLSearchParams();
    p.append('hash', HESTIA_KEY);
    p.append('cmd', cmd);
    (args || []).forEach((a, i) => p.append('arg' + (i + 1), String(a)));
    const body = p.toString();
    const u = new URL(HESTIA_URL);
    const req = https.request({
      hostname: u.hostname, port: u.port || 8083, path: '/api/', method: 'POST',
      rejectUnauthorized: false, timeout: 20000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('hestia timeout')); });
    req.end(body);
  });
}
async function hestiaJson(cmd, args) {
  const raw = await hestia(cmd, [...(args || []), 'json']);
  try { return JSON.parse(raw); } catch { throw new Error('hestia: ' + String(raw).slice(0, 160)); }
}
const numOrNull = (v) => (v === 'unlimited' || v === '' || v == null) ? null : (parseInt(v, 10) || 0);

function accountFrom(u) {
  return {
    name: u.NAME || '', email: u.CONTACT || '', package: u.PACKAGE || '', ns: u.NS || '',
    diskUsedMB: parseInt(u.U_DISK, 10) || 0, diskQuotaMB: numOrNull(u.DISK_QUOTA),
    bwUsedMB: parseInt(u.U_BANDWIDTH, 10) || 0, bwQuotaMB: numOrNull(u.BANDWIDTH),
    webDomains: parseInt(u.U_WEB_DOMAINS, 10) || 0, webLimit: numOrNull(u.WEB_DOMAINS), webSsl: parseInt(u.U_WEB_SSL, 10) || 0,
    mailAccounts: parseInt(u.U_MAIL_ACCOUNTS, 10) || 0, mailLimit: numOrNull(u.MAIL_ACCOUNTS),
    databases: parseInt(u.U_DATABASES, 10) || 0, backups: parseInt(u.U_BACKUPS, 10) || 0,
  };
}

// ---- http ---------------------------------------------------------------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const getCookie = (req) => { const m = (req.headers.cookie || '').match(/hh_sess=([^;]+)/); return m ? m[1] : null; };
const sessionUser = (req) => { const c = getCookie(req); return c ? (sessions.get(c) || null) : null; };
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  try {
    if (url === '/api/session') { const u = sessionUser(req); return json(res, 200, { authed: !!u, user: u }); }

    if (url === '/login' && req.method === 'POST') {
      if (!LIVE) return json(res, 503, { error: 'Server not connected yet' });
      const ip = clientIp(req);
      const a = attempts.get(ip);
      if (a && a.n >= 8 && (nowSec() - a.ts) < 600) return json(res, 429, { error: 'Too many attempts, wait a few minutes' });
      const b = await readBody(req);
      const user = String(b.username || '').trim().toLowerCase();
      const pass = String(b.password || '');
      if (!user || !pass) return json(res, 400, { error: 'Enter your username and password' });
      if (!/^[a-z0-9._-]{1,32}$/.test(user)) { bumpAttempt(ip); return json(res, 401, { error: 'Wrong username or password' }); }
      let ok = false;
      try { const raw = await hestia('v-check-user-password', [user, pass, ip || '']); ok = String(raw).trim() === ''; } catch { ok = false; }
      if (!ok) { bumpAttempt(ip); return json(res, 401, { error: 'Wrong username or password' }); }
      attempts.delete(ip);
      const t = crypto.randomBytes(24).toString('base64url'); sessions.set(t, user);
      res.writeHead(200, { 'Set-Cookie': `hh_sess=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, user }));
    }
    if (url === '/logout') { const c = getCookie(req); if (c) sessions.delete(c); res.writeHead(200, { 'Set-Cookie': 'hh_sess=; Path=/; Max-Age=0' }); return res.end('{}'); }

    if (url.startsWith('/api/')) {
      if (!LIVE) return json(res, 503, { error: 'HatchHosting is not connected to a server yet (set HESTIA_URL and HESTIA_KEY)' });
      const u = sessionUser(req);
      if (!u) return json(res, 401, { error: 'login required' });
      if (url === '/api/account') {
        const d = await hestiaJson('v-list-user', [u]);
        return json(res, 200, accountFrom(d[u] || {}));
      }
      if (url === '/api/websites') {
        const d = await hestiaJson('v-list-web-domains', [u]);
        const arr = Object.entries(d).map(([domain, w]) => ({
          domain, ip: w.IP || '', docRoot: w.DOCUMENT_ROOT || '',
          ssl: w.SSL === 'yes', letsencrypt: w.LETSENCRYPT === 'yes',
          backend: w.BACKEND || '', diskMB: parseInt(w.U_DISK, 10) || 0, suspended: w.SUSPENDED === 'yes',
        }));
        return json(res, 200, arr);
      }
      return json(res, 404, { error: 'not found' });
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch (e) { json(res, 500, { error: e.message }); }
});
server.listen(PORT, () => console.log('HatchHosting panel on :' + PORT + (LIVE ? ' (connected to server)' : ' — NOT connected: set HESTIA_URL and HESTIA_KEY')));
