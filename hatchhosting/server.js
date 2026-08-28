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
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

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
      rejectUnauthorized: false, timeout: 200000,
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
const SERVER_IP = process.env.SERVER_IP || '';
const HOSTNAME = process.env.SERVER_HOSTNAME || require('os').hostname();
const LIVE = !!(HESTIA_URL && HESTIA_KEY);

const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const sessions = new Map(); // token -> hestia username
const attempts = new Map(); // ip -> { n, ts }  (basic login throttle)
let clock = 0; // monotonic-ish seconds (Date.now avoided per runtime constraints)
setInterval(() => { clock++; }, 1000).unref?.();
const nowSec = () => clock;
const bumpAttempt = (ip) => { const a = attempts.get(ip); if (a && (nowSec() - a.ts) < 600) { a.n++; a.ts = nowSec(); } else { attempts.set(ip, { n: 1, ts: nowSec() }); } };

// ---- Hestia API ----------------------------------------------------------
function hestia(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = new URLSearchParams();
    p.append('hash', HESTIA_KEY);
    p.append('cmd', cmd);
    (args || []).forEach((a, i) => p.append('arg' + (i + 1), String(a)));
    const body = p.toString();
    const u = new URL(HESTIA_URL);
    const req = https.request({
      hostname: u.hostname, port: u.port || 8083, path: '/api/', method: 'POST',
      rejectUnauthorized: false, timeout: (opts && opts.timeout) || 25000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(body);
  });
}
async function hestiaJson(cmd, args) {
  const raw = await hestia(cmd, [...(args || []), 'json']);
  try { return JSON.parse(raw); } catch { throw new Error('hestia: ' + String(raw).slice(0, 160)); }
}
// Hestia action commands return an empty body on success, or a numeric exit code on error.
const HESTIA_ERR = { 1: 'Wrong arguments', 2: 'That value is not valid', 3: 'It does not exist', 4: 'It already exists', 5: 'Account is suspended', 6: 'This feature is disabled', 7: 'Password is not valid', 8: 'Not allowed', 12: 'You have reached your plan limit', 13: 'Try again later' };
async function hestiaDo(cmd, args, timeout) {
  const raw = String(await hestia(cmd, args || [], timeout ? { timeout } : undefined)).trim();
  if (raw === '' || raw === '0') return { ok: true };
  const code = parseInt(raw, 10);
  return { ok: false, error: HESTIA_ERR[code] || ('Server error (' + raw.slice(0, 80) + ')') };
}
const numOrNull = (v) => (v === 'unlimited' || v === '' || v == null) ? null : (parseInt(v, 10) || 0);
const okName = (s) => /^[a-z0-9._-]{1,32}$/i.test(s);
const okDomain = (s) => /^[a-z0-9.-]{1,253}\.[a-z]{2,}$/i.test(s);

// ---- filesystem (VPS): scoped to the logged-in user's own site directories ----
function siteBase(u, domain) {
  if (!okName(u) || !okDomain(domain)) throw new Error('Invalid site');
  return '/home/' + u + '/web/' + domain + '/public_html';
}
async function ensureSite(u, domain) {
  const base = siteBase(u, domain);
  try { const st = await fsp.stat('/home/' + u + '/web/' + domain); if (!st.isDirectory()) throw 0; }
  catch { throw new Error('That website is not on your account'); }
  return base;
}
function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.sep + (rel || '')); // force relative
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('Invalid path');
  return p;
}
const salt = () => crypto.randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
function wpConfig(dbName, dbUser, dbPass) {
  const K = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
  const keys = K.map((k) => "define('" + k + "', '" + salt() + "');").join('\n');
  return "<?php\n"
    + "define('DB_NAME', '" + dbName + "');\n"
    + "define('DB_USER', '" + dbUser + "');\n"
    + "define('DB_PASSWORD', '" + dbPass + "');\n"
    + "define('DB_HOST', 'localhost');\n"
    + "define('DB_CHARSET', 'utf8mb4');\n"
    + "define('DB_COLLATE', '');\n"
    + keys + "\n"
    + "$table_prefix = 'wp_';\n"
    + "define('WP_AUTO_UPDATE_CORE', 'minor');\n"
    + "if ( ! defined('ABSPATH') ) { define('ABSPATH', __DIR__ . '/'); }\n"
    + "require_once ABSPATH . 'wp-settings.php';\n";
}

// ---- bot protection (.htaccess, apache backend) ----
const BOT_BAD = 'scrapy|curl|wget|python-requests|python-urllib|libwww-perl|libwww|go-http-client|java/|httrack|masscan|nmap|nikto|sqlmap|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|bytespider|gptbot|chatgpt|ccbot|claudebot|anthropic|amazonbot|dataforseo|blexbot|megaindex|serpstatbot|zoominfobot|dnyzbot|barkrowler|headlesschrome|phantomjs|selenium|python';
const BOT_SEARCH = 'googlebot|bingbot|yandex|baiduspider|duckduckbot|slurp|sogou|exabot|facebookexternalhit|ia_archiver|applebot';
const BOT_MARK_A = '# >>> HatchHosting bot protection';
const BOT_MARK_Z = '# <<< HatchHosting bot protection';
function botBlock(mode) {
  const pat = mode === 'all' ? (BOT_BAD + '|' + BOT_SEARCH) : BOT_BAD;
  const lines = [
    BOT_MARK_A + ' (' + mode + ') — managed by HatchHosting, do not edit',
    '<IfModule mod_rewrite.c>',
    'RewriteEngine On',
    'RewriteCond %{HTTP_USER_AGENT} "(' + pat + ')" [NC]',
    'RewriteRule .* - [F,L]',
    'RewriteCond %{HTTP_USER_AGENT} ^$',
    'RewriteRule .* - [F,L]',
  ];
  if (mode === 'all') { lines.push('RewriteCond %{HTTP_USER_AGENT} !(Mozilla|Opera) [NC]', 'RewriteRule .* - [F,L]'); }
  lines.push('</IfModule>', BOT_MARK_Z, '');
  return lines.join('\n');
}
function stripBotBlock(txt) {
  const re = new RegExp(BOT_MARK_A + '[\\s\\S]*?' + BOT_MARK_Z + '\\n?', 'g');
  return String(txt || '').replace(re, '');
}
const apacheStack = () => fs.existsSync('/etc/apache2') || fs.existsSync('/etc/httpd');

// ---- analytics (parse nginx access logs) --------------------------------
const DATA_DIR = process.env.DATA_DIR || '/var/tmp/hatchhosting';
const GEO_URL = process.env.GEO_URL || 'https://cdn.jsdelivr.net/npm/@ip-location-db/geo-whois-asn-country/geo-whois-asn-country-ipv4-num.csv';
const BOT_RE = /(bot|crawl|spider|slurp|scrape|curl|wget|python|java|go-http|libwww|headless|phantom|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|chatgpt|ccbot|claudebot|anthropic|amazonbot|facebookexternalhit|monitor|uptime|pingdom|dataforseo|bingpreview|yandex|baidu|sogou)/i;

function downloadText(url, redirects) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 60000, headers: { 'User-Agent': 'HatchHosting' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (redirects || 0) < 5) { r.resume(); return resolve(downloadText(new URL(r.headers.location, url).toString(), (redirects || 0) + 1)); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let b = ''; r.setEncoding('utf8'); r.on('data', (c) => (b += c)); r.on('end', () => resolve(b));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
function ipToInt(ip) { const p = ip.split('.'); if (p.length !== 4) return null; let n = 0; for (let i = 0; i < 4; i++) { const o = +p[i]; if (!(o >= 0 && o <= 255)) return null; n = (n * 256) + o; } return n; }
let geo = null, geoLoading = null;
function parseGeo(csv) {
  const lines = csv.split('\n');
  const starts = new Uint32Array(lines.length), ends = new Uint32Array(lines.length), idx = new Uint16Array(lines.length);
  const codes = [], codeMap = new Map(); let n = 0;
  for (const line of lines) {
    if (!line) continue;
    const c1 = line.indexOf(','), c2 = line.indexOf(',', c1 + 1); if (c1 < 0 || c2 < 0) continue;
    const s = +line.slice(0, c1), e = +line.slice(c1 + 1, c2), cc = line.slice(c2 + 1).trim();
    if (!Number.isFinite(s) || !Number.isFinite(e) || !cc) continue;
    let ci = codeMap.get(cc); if (ci === undefined) { ci = codes.length; codeMap.set(cc, ci); codes.push(cc); }
    starts[n] = s; ends[n] = e; idx[n] = ci; n++;
  }
  return { starts: starts.subarray(0, n), ends: ends.subarray(0, n), idx: idx.subarray(0, n), codes, n, ok: true };
}
async function ensureGeo() {
  if (geo) return geo;
  if (geoLoading) return geoLoading;
  geoLoading = (async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const file = path.join(DATA_DIR, 'ip-country-v4.csv');
      let csv; try { csv = await fsp.readFile(file, 'utf8'); } catch { csv = await downloadText(GEO_URL); await fsp.writeFile(file, csv).catch(() => {}); }
      geo = parseGeo(csv);
    } catch (e) { geo = { n: 0, ok: false, err: e.message, codes: [] }; }
    return geo;
  })();
  return geoLoading;
}
function geoLookup(g, ip) {
  if (!g || !g.ok || !g.n) return null;
  const v = ipToInt(ip); if (v === null) return null;
  let lo = 0, hi = g.n - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (g.starts[mid] <= v) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  if (ans >= 0 && g.ends[ans] >= v) return g.codes[g.idx[ans]];
  return null;
}
const LOG_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) ([^ "]*)[^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"/;
async function readLog(file) {
  const gz = file.endsWith('.gz');
  const st = await fsp.stat(file);
  const CAP = 30 * 1024 * 1024;
  let buf;
  if (!gz && st.size > CAP) { const fd = await fsp.open(file, 'r'); try { const b = Buffer.alloc(CAP); await fd.read(b, 0, CAP, st.size - CAP); buf = b; } finally { await fd.close(); } }
  else { buf = await fsp.readFile(file); }
  if (gz) { try { buf = zlib.gunzipSync(buf); } catch { return ''; } }
  return buf.toString('utf8');
}
async function logFiles(domain) {
  const dir = '/var/log/nginx/domains';
  const all = await fsp.readdir(dir).catch(() => []);
  const base = domain + '.log';
  return all.filter((f) => f === base || f.startsWith(base + '.')).sort().slice(0, 12).map((f) => path.join(dir, f));
}
async function analytics(domain) {
  const files = await logFiles(domain);
  const g = await ensureGeo();
  let totalReq = 0, humanReq = 0, botReq = 0;
  const humanIps = new Set(), botIps = new Set();
  const pages = new Map(), refs = new Map(), countries = new Map(), days = new Map(), status = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const f of files) {
    let data; try { data = await readLog(f); } catch { continue; }
    for (const line of data.split('\n')) {
      const m = LOG_RE.exec(line); if (!m) continue;
      const ip = m[1], time = m[2], pathReq = m[4].split('?')[0], stcode = +m[5], ref = m[6], ua = m[7];
      totalReq++;
      const sc = Math.floor(stcode / 100) + 'xx'; if (status[sc] !== undefined) status[sc]++;
      const isBot = !ua || ua === '-' || BOT_RE.test(ua);
      if (isBot) { botReq++; botIps.add(ip); continue; }
      humanReq++; humanIps.add(ip);
      inc(pages, pathReq || '/');
      if (ref && ref !== '-' && ref.indexOf(domain) < 0) { try { inc(refs, new URL(ref).hostname); } catch {} }
      const cc = geoLookup(g, ip); if (cc) inc(countries, cc);
      inc(days, (time.split(':')[0] || '').split(' ')[0]);
    }
  }
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, count]) => ({ name, count }));
  return {
    hasLogs: files.length > 0,
    geoReady: !!(g && g.ok && g.n),
    totalRequests: totalReq, pageViews: humanReq, visitors: humanIps.size,
    botRequests: botReq, botVisitors: botIps.size,
    pages: top(pages, 15), referrers: top(refs, 10), countries: top(countries, 12),
    status, daily: [...days.entries()].slice(-14).map(([day, count]) => ({ day, count })),
  };
}

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
  const parsed = new URL(req.url || '/', 'http://x');
  const url = parsed.pathname;
  const qp = parsed.searchParams;
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
      if (url === '/api/server') {
        let ip = SERVER_IP;
        if (!ip) { try { const ips = await hestiaJson('v-list-sys-ips', []); ip = Object.keys(ips)[0] || ''; } catch { ip = ''; } }
        return json(res, 200, { ip, hostname: HOSTNAME });
      }
      if (url === '/api/analytics' && req.method === 'GET') {
        const domain = String(qp.get('domain') || '').trim().toLowerCase();
        await ensureSite(u, domain);
        return json(res, 200, await analytics(domain));
      }
      if (url === '/api/website/botshield' && req.method === 'GET') {
        const domain = String(qp.get('domain') || '').trim().toLowerCase();
        const base = await ensureSite(u, domain);
        let mode = 'off';
        try { const h = await fsp.readFile(path.join(base, '.htaccess'), 'utf8'); const m = h.match(/HatchHosting bot protection \((\w+)\)/); if (m) mode = m[1]; } catch {}
        return json(res, 200, { mode, enabled: mode !== 'off', supported: apacheStack() });
      }

      // ---- file manager (scoped to the user's own site folders) ----
      if (url === '/api/files') {
        const domain = String(qp.get('domain') || '').trim().toLowerCase();
        const base = await ensureSite(u, domain);
        const dir = safeJoin(base, qp.get('path') || '');
        let names = [];
        try { names = await fsp.readdir(dir); } catch { return json(res, 200, { path: qp.get('path') || '', items: [] }); }
        const items = [];
        for (const n of names) {
          try { const st = await fsp.stat(path.join(dir, n)); items.push({ name: n, dir: st.isDirectory(), sizeKB: Math.round(st.size / 1024), mtime: st.mtimeMs }); }
          catch { /* skip */ }
        }
        items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
        return json(res, 200, { path: qp.get('path') || '', items });
      }
      if (url === '/api/files/download' && req.method === 'GET') {
        const domain = String(qp.get('domain') || '').trim().toLowerCase();
        const base = await ensureSite(u, domain);
        const file = safeJoin(base, (qp.get('path') || '') + '/' + (qp.get('name') || ''));
        const st = await fsp.stat(file).catch(() => null);
        if (!st || st.isDirectory()) return json(res, 404, { error: 'File not found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + path.basename(file).replace(/"/g, '') + '"', 'Content-Length': st.size });
        return fs.createReadStream(file).pipe(res);
      }
      if (url === '/api/files/read' && req.method === 'GET') {
        const domain = String(qp.get('domain') || '').trim().toLowerCase();
        const base = await ensureSite(u, domain);
        const file = safeJoin(base, (qp.get('path') || '') + '/' + (qp.get('name') || ''));
        const st = await fsp.stat(file).catch(() => null);
        if (!st || st.isDirectory()) return json(res, 404, { error: 'File not found' });
        if (st.size > 3 * 1024 * 1024) return json(res, 200, { error: 'This file is too large to edit here (over 3 MB). Use SFTP for large files.' });
        const buf = await fsp.readFile(file);
        if (buf.includes(0)) return json(res, 200, { error: 'This looks like a binary file (image, archive, etc.) and cannot be edited as text.' });
        return json(res, 200, { content: buf.toString('utf8'), name: path.basename(file) });
      }
      if (url === '/api/files/upload' && req.method === 'POST') {
        const domain = String(qp.get('domain') || '').trim().toLowerCase();
        const base = await ensureSite(u, domain);
        const name = path.basename(String(qp.get('name') || '')); // strip any path
        if (!name || name === '.' || name === '..') return json(res, 400, { error: 'Invalid file name' });
        const dest = safeJoin(base, (qp.get('path') || '') + '/' + name);
        await new Promise((resolve, reject) => { const ws = fs.createWriteStream(dest); req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject); });
        try { await execFileP('chown', [u + ':' + u, dest]); } catch {}
        return json(res, 200, { ok: true });
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
          const hint = ' Make sure ' + domain + ' points to this server (check the DNS button) and give DNS time to update, then try again.';
          let r;
          try { r = await hestiaDo('v-add-letsencrypt-domain', [u, domain], 160000); }
          catch (e) { return json(res, 200, { ok: false, error: 'The certificate request is taking too long.' + hint }); }
          if (!r.ok) r.error = 'Could not issue the certificate.' + hint;
          return json(res, 200, r);
        }
        if (url === '/api/website/botshield') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          const mode = ['off', 'bad', 'all'].includes(b.mode) ? b.mode : 'off';
          if (!apacheStack()) return json(res, 200, { ok: false, error: 'This server serves sites with Nginx only, where bot rules are applied differently. Not enabling it here to avoid a false sense of protection — contact support to switch on the Nginx version.' });
          const file = path.join(base, '.htaccess');
          let cur = ''; try { cur = await fsp.readFile(file, 'utf8'); } catch {}
          const next = (mode === 'off' ? '' : botBlock(mode)) + stripBotBlock(cur);
          if (next.trim() === '') { try { await fsp.unlink(file); } catch {} }
          else { await fsp.writeFile(file, next); try { await execFileP('chown', [u + ':' + u, file]); } catch {} }
          return json(res, 200, { ok: true, mode, enabled: mode !== 'off' });
        }
        if (url === '/api/website/wordpress') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          // don't clobber an existing install
          if (fs.existsSync(path.join(base, 'wp-config.php'))) return json(res, 200, { ok: false, error: 'WordPress is already installed on this site' });
          const rnd = crypto.randomBytes(3).toString('hex');
          const dbSuf = 'wp' + rnd, userSuf = 'wpu' + rnd, dbpass = crypto.randomBytes(12).toString('base64url');
          const dbr = await hestiaDo('v-add-database', [u, dbSuf, userSuf, dbpass]);
          if (!dbr.ok) return json(res, 200, { ok: false, error: 'Could not create database: ' + dbr.error });
          const DB_NAME = u + '_' + dbSuf, DB_USER = u + '_' + userSuf;
          const tmp = '/tmp/wp-' + rnd;
          try {
            await execFileP('mkdir', ['-p', tmp]);
            await execFileP('curl', ['-fsSL', '-o', tmp + '/wp.tar.gz', 'https://wordpress.org/latest.tar.gz'], { timeout: 180000 });
            await execFileP('tar', ['xzf', tmp + '/wp.tar.gz', '-C', tmp]);
            await execFileP('cp', ['-a', tmp + '/wordpress/.', base + '/']);
            await fsp.writeFile(path.join(base, 'wp-config.php'), wpConfig(DB_NAME, DB_USER, dbpass));
            await execFileP('chown', ['-R', u + ':' + u, base]);
          } catch (e) {
            return json(res, 200, { ok: false, error: 'Install failed: ' + (e.message || e) });
          } finally { try { await execFileP('rm', ['-rf', tmp]); } catch {} }
          return json(res, 200, { ok: true, adminUrl: 'http://' + domain + '/wp-admin/' });
        }
        if (url === '/api/files/save') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          const name = path.basename(String(b.name || ''));
          if (!name || name === '.' || name === '..') return json(res, 400, { error: 'Invalid file name' });
          const content = typeof b.content === 'string' ? b.content : '';
          if (content.length > 3 * 1024 * 1024) return json(res, 400, { error: 'File is too large to save here (over 3 MB)' });
          const file = safeJoin(base, (b.path || '') + '/' + name);
          const st = await fsp.stat(file).catch(() => null);
          if (st && st.isDirectory()) return json(res, 400, { error: 'That is a folder' });
          await fsp.writeFile(file, content, 'utf8');
          try { await execFileP('chown', [u + ':' + u, file]); } catch {}
          return json(res, 200, { ok: true });
        }
        if (url === '/api/files/mkdir') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          const name = path.basename(String(b.name || ''));
          if (!name || name === '.' || name === '..' || /[\/]/.test(String(b.name || ''))) return json(res, 400, { error: 'Invalid folder name' });
          const dir = safeJoin(base, (b.path || '') + '/' + name);
          try { await fsp.mkdir(dir); await execFileP('chown', [u + ':' + u, dir]); } catch (e) { return json(res, 200, { ok: false, error: e.code === 'EEXIST' ? 'That folder already exists' : 'Could not create folder' }); }
          return json(res, 200, { ok: true });
        }
        if (url === '/api/files/delete') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          const target = safeJoin(base, (b.path || '') + '/' + path.basename(String(b.name || '')));
          if (target === base) return json(res, 400, { error: 'Cannot delete the site root' });
          try { await fsp.rm(target, { recursive: true, force: true }); } catch { return json(res, 200, { ok: false, error: 'Could not delete' }); }
          return json(res, 200, { ok: true });
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
