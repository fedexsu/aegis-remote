'use strict';
// HatchHosting backend. Serves the panel and exposes a small API that talks to
// HestiaCP over localhost using an access key. Two modes:
//   - LIVE  (HESTIA_URL + HESTIA_KEY set)  -> real data, login required
//   - DEMO  (not set, e.g. on Railway)     -> sample data, open, for showing the UI
//
// Env: PORT, HESTIA_URL (https://127.0.0.1:8083), HESTIA_KEY ("ID:SECRET"),
//      HESTIA_USER (default "user"), HATCHHOSTING_PASSWORD (login password, live mode)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const HESTIA_URL = process.env.HESTIA_URL || '';
const HESTIA_KEY = process.env.HESTIA_KEY || '';
const HESTIA_USER = process.env.HESTIA_USER || 'user';
const PASSWORD = process.env.HATCHHOSTING_PASSWORD || '';
const LIVE = !!(HESTIA_URL && HESTIA_KEY);

const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const sessions = new Set();

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

// ---- demo data (no Hestia) ----------------------------------------------
const DEMO_ACCOUNT = { name: 'ski', email: 'you@example.com', package: 'Business', diskUsedMB: 12400, diskQuotaMB: 51200, bwUsedMB: 84000, bwQuotaMB: 512000, webDomains: 3, webLimit: null, webSsl: 2, mailAccounts: 8, mailLimit: 100, databases: 5, backups: 14, demo: true };
const DEMO_SITES = [
  { domain: 'mysite.com', ip: '', ssl: true, backend: 'php-8.2', diskMB: 4100, suspended: false },
  { domain: 'shop.mysite.com', ip: '', ssl: true, backend: 'php-8.1', diskMB: 6800, suspended: false },
  { domain: 'blog.example.net', ip: '', ssl: false, backend: 'php-8.2', diskMB: 1500, suspended: false },
];

// ---- http ---------------------------------------------------------------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const getCookie = (req) => { const m = (req.headers.cookie || '').match(/hh_sess=([^;]+)/); return m ? m[1] : null; };
const authed = (req) => !LIVE || (() => { const c = getCookie(req); return !!(c && sessions.has(c)); })();
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  try {
    if (url === '/api/session') return json(res, 200, { live: LIVE, authed: authed(req) });

    if (url === '/login' && req.method === 'POST') {
      if (!LIVE) return json(res, 200, { ok: true });
      const b = await readBody(req);
      if (PASSWORD && b.password === PASSWORD) {
        const t = crypto.randomBytes(24).toString('base64url'); sessions.add(t);
        res.writeHead(200, { 'Set-Cookie': `hh_sess=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      return json(res, 401, { error: 'Wrong password' });
    }
    if (url === '/logout') { const c = getCookie(req); if (c) sessions.delete(c); res.writeHead(200, { 'Set-Cookie': 'hh_sess=; Path=/; Max-Age=0' }); return res.end('{}'); }

    if (url.startsWith('/api/')) {
      if (!authed(req)) return json(res, 401, { error: 'login required' });
      if (!LIVE) {
        if (url === '/api/account') return json(res, 200, DEMO_ACCOUNT);
        if (url === '/api/websites') return json(res, 200, DEMO_SITES);
        return json(res, 404, { error: 'not found' });
      }
      if (url === '/api/account') {
        const d = await hestiaJson('v-list-user', [HESTIA_USER]);
        return json(res, 200, accountFrom(d[HESTIA_USER] || {}));
      }
      if (url === '/api/websites') {
        const d = await hestiaJson('v-list-web-domains', [HESTIA_USER]);
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
server.listen(PORT, () => console.log('HatchHosting panel on :' + PORT + ' (' + (LIVE ? 'LIVE' : 'DEMO') + ' mode)'));
