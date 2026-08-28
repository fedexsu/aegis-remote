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
// Hestia action commands return an empty body on success, or a numeric exit code on error.
const HESTIA_ERR = { 1: 'Wrong arguments', 2: 'That value is not valid', 3: 'It does not exist', 4: 'It already exists', 5: 'Account is suspended', 6: 'This feature is disabled', 7: 'Password is not valid', 8: 'Not allowed', 12: 'You have reached your plan limit', 13: 'Try again later' };
async function hestiaDo(cmd, args) {
  const raw = String(await hestia(cmd, args || [])).trim();
  if (raw === '' || raw === '0') return { ok: true };
  const code = parseInt(raw, 10);
  return { ok: false, error: HESTIA_ERR[code] || ('Server error (' + raw.slice(0, 80) + ')') };
}
const numOrNull = (v) => (v === 'unlimited' || v === '' || v == null) ? null : (parseInt(v, 10) || 0);
const okName = (s) => /^[a-z0-9._-]{1,32}$/i.test(s);
const okDomain = (s) => /^[a-z0-9.-]{1,253}\.[a-z]{2,}$/i.test(s);

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
      if (url === '/api/databases') {
        const d = await hestiaJson('v-list-databases', [u]);
        const arr = Object.entries(d).map(([name, x]) => ({
          name, dbuser: x.DBUSER || '', type: x.TYPE || 'mysql', charset: x.CHARSET || '',
          sizeMB: parseInt(x.U_DISK, 10) || 0,
        }));
        return json(res, 200, arr);
      }
      if (url === '/api/mail') {
        const domains = await hestiaJson('v-list-mail-domains', [u]);
        const out = [];
        for (const domain of Object.keys(domains)) {
          let accts = {};
          try { accts = await hestiaJson('v-list-mail-accounts', [u, domain]); } catch { accts = {}; }
          for (const [acc, x] of Object.entries(accts)) {
            out.push({ address: acc + '@' + domain, domain, account: acc, usedMB: parseInt(x.U_DISK, 10) || 0, quotaMB: numOrNull(x.QUOTA) });
          }
        }
        return json(res, 200, out);
      }
      if (url === '/api/backups') {
        let d = {};
        try { d = await hestiaJson('v-list-user-backups', [u]); } catch { d = {}; }
        const arr = Object.entries(d).map(([name, x]) => ({ name, type: x.TYPE || '', sizeMB: parseInt(x.SIZE, 10) || 0, date: ((x.DATE || '') + ' ' + (x.TIME || '')).trim() }));
        return json(res, 200, arr);
      }

      // ---- actions (POST) ----
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (url === '/api/website/add') {
          const domain = String(b.domain || '').trim().toLowerCase();
          if (!okDomain(domain)) return json(res, 400, { error: 'Enter a valid domain like mysite.com' });
          return json(res, 200, await hestiaDo('v-add-web-domain', [u, domain]));
        }
        if (url === '/api/website/delete') {
          const domain = String(b.domain || '').trim().toLowerCase();
          if (!okDomain(domain)) return json(res, 400, { error: 'Invalid domain' });
          return json(res, 200, await hestiaDo('v-delete-web-domain', [u, domain]));
        }
        if (url === '/api/website/ssl') {
          const domain = String(b.domain || '').trim().toLowerCase();
          if (!okDomain(domain)) return json(res, 400, { error: 'Invalid domain' });
          return json(res, 200, await hestiaDo('v-add-letsencrypt-domain', [u, domain]));
        }
        if (url === '/api/database/add') {
          const name = String(b.name || '').trim();
          const dbuser = String(b.dbuser || '').trim();
          const pass = String(b.password || '');
          if (!okName(name) || !okName(dbuser)) return json(res, 400, { error: 'Name and user must be letters, numbers, _ or -' });
          if (pass.length < 6) return json(res, 400, { error: 'Database password must be at least 6 characters' });
          return json(res, 200, await hestiaDo('v-add-database', [u, name, dbuser, pass]));
        }
        if (url === '/api/database/delete') {
          const name = String(b.name || '').trim();
          if (!name) return json(res, 400, { error: 'Missing database' });
          return json(res, 200, await hestiaDo('v-delete-database', [u, name]));
        }
        if (url === '/api/mail/add') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const account = String(b.account || '').trim().toLowerCase();
          const pass = String(b.password || '');
          if (!okDomain(domain)) return json(res, 400, { error: 'Enter a valid domain' });
          if (!okName(account)) return json(res, 400, { error: 'Invalid mailbox name' });
          if (pass.length < 6) return json(res, 400, { error: 'Mailbox password must be at least 6 characters' });
          const md = await hestiaDo('v-add-mail-domain', [u, domain]); // ok if it already exists
          if (!md.ok && !/already/i.test(md.error)) { /* code 4 -> already exists; ignore */ }
          return json(res, 200, await hestiaDo('v-add-mail-account', [u, domain, account, pass]));
        }
        if (url === '/api/mail/delete') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const account = String(b.account || '').trim().toLowerCase();
          if (!okDomain(domain) || !okName(account)) return json(res, 400, { error: 'Invalid mailbox' });
          return json(res, 200, await hestiaDo('v-delete-mail-account', [u, domain, account]));
        }
        if (url === '/api/backup/create') {
          return json(res, 200, await hestiaDo('v-backup-user', [u]));
        }
      }
      return json(res, 404, { error: 'not found' });
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch (e) { json(res, 500, { error: e.message }); }
});
server.listen(PORT, () => console.log('HatchHosting panel on :' + PORT + (LIVE ? ' (connected to server)' : ' — NOT connected: set HESTIA_URL and HESTIA_KEY')));
