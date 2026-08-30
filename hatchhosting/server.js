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
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// extra pages on the same domain (main.com/p/<slug>): slug = url-safe path segment
const okSlug = (s) => /^[a-z0-9-]{1,32}$/.test(s);
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
const randSlug = () => (crypto.randomBytes(6).toString('hex').replace(/[^a-z0-9]/g, '').slice(0, 6) || ('p' + nowSec()));

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

// ---- extra pages on the same domain (main.com/p/<slug>) ----
// Each "page" is a folder under public_html/p/<slug> with its own index.html.
// It shares the domain's SSL and DNS, so no extra setup is needed — the page is
// live the moment the folder exists.
function pageStarter(title, domain) {
  const t = escHtml(title || 'New page');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + t + '</title>',
    '<style>',
    '  :root{--ink:#0f1a26;--ink-2:#53627a;--bg:#f5f7fb;--card:#fff;--line:#e5eaf2;--accent:#2f6bff}',
    '  @media(prefers-color-scheme:dark){:root{--ink:#e7eef6;--ink-2:#9fb0c2;--bg:#0b1017;--card:#141d28;--line:#243244;--accent:#5a8cff}}',
    '  *{box-sizing:border-box}',
    '  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.6}',
    '  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;max-width:640px;width:100%;padding:44px 40px;box-shadow:0 20px 50px -30px rgba(0,0,0,.4)}',
    '  h1{font-size:30px;margin:0 0 12px;letter-spacing:-.02em}',
    '  p{color:var(--ink-2);font-size:16px;margin:0 0 14px}',
    '  .tag{display:inline-block;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);margin-bottom:14px}',
    '  a{color:var(--accent);text-decoration:none;font-weight:600}',
    '</style>',
    '</head>',
    '<body>',
    '  <main class="card">',
    '    <span class="tag">' + escHtml(domain) + '</span>',
    '    <h1>' + t + '</h1>',
    '    <p>This is your new page. Replace this text with your own content — edit it right from your hosting panel, or upload your own files into this folder.</p>',
    '    <p><a href="/">&larr; Back to ' + escHtml(domain) + '</a></p>',
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
async function listPages(u, domain) {
  const base = await ensureSite(u, domain);
  const dir = path.join(base, 'p');
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!okSlug(n)) continue;
    try {
      const st = await fsp.stat(path.join(dir, n));
      if (!st.isDirectory()) continue;
      let title = '';
      try { const h = await fsp.readFile(path.join(dir, n, 'index.html'), 'utf8'); const m = h.match(/<title>([^<]*)<\/title>/i); if (m) title = m[1].trim().slice(0, 100); } catch {}
      out.push({ slug: n, url: 'https://' + domain + '/p/' + n, link: domain + '/p/' + n, title, mtime: st.mtimeMs });
    } catch {}
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
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

// ---- clean URLs (.htaccess): /name serves name.html, /name.html -> /name ----
const CLEAN_A = '# >>> HatchHosting clean URLs';
const CLEAN_Z = '# <<< HatchHosting clean URLs';
function cleanUrlBlock() {
  return [
    CLEAN_A,
    '<IfModule mod_rewrite.c>',
    'RewriteEngine On',
    '# Hide the .html extension: redirect /page.html to /page',
    'RewriteCond %{THE_REQUEST} \\s/+(.+?)\\.html[\\s?] [NC]',
    'RewriteRule ^ /%1 [R=301,L]',
    '# Serve /page from page.html when that file exists',
    'RewriteCond %{REQUEST_FILENAME} !-d',
    'RewriteCond %{REQUEST_FILENAME}\\.html -f',
    'RewriteRule ^(.+?)/?$ $1.html [L]',
    '</IfModule>',
    CLEAN_Z, '',
  ].join('\n');
}
async function applyCleanUrls(base, on) {
  const file = path.join(base, '.htaccess');
  let cur = ''; try { cur = await fsp.readFile(file, 'utf8'); } catch {}
  const has = cur.includes(CLEAN_A);
  if (on && has) return; if (!on && !has) return; // already in desired state
  const stripped = cur.replace(new RegExp(CLEAN_A + '[\\s\\S]*?' + CLEAN_Z + '\\n?', 'g'), '');
  const next = on ? (cleanUrlBlock() + stripped) : stripped;
  if (next.trim() === '') { try { await fsp.unlink(file); } catch {} }
  else { await fsp.writeFile(file, next); }
  const owner = base.split('/')[2]; // /home/<user>/...
  if (owner) { try { await execFileP('chown', [owner + ':' + owner, file]); } catch {} }
}

// Force-HTTPS redirect via .htaccess (Apache), managed between markers.
const FH_A = '# >>> HatchHosting force https';
const FH_Z = '# <<< HatchHosting force https';
const fhBlock = () => [FH_A, '<IfModule mod_rewrite.c>', 'RewriteEngine On', 'RewriteCond %{HTTPS} off', 'RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]', '</IfModule>', FH_Z, ''].join('\n');
function stripFh(txt) { return String(txt || '').replace(new RegExp(FH_A + '[\\s\\S]*?' + FH_Z + '\\n?', 'g'), ''); }
async function setForceHttps(u, domain, on) {
  const base = await ensureSite(u, domain);
  const file = path.join(base, '.htaccess');
  let cur = ''; try { cur = await fsp.readFile(file, 'utf8'); } catch {}
  const next = (on ? fhBlock() : '') + stripFh(cur);
  if (next.trim() === '') { try { await fsp.unlink(file); } catch {} }
  else { await fsp.writeFile(file, next); try { await execFileP('chown', [u + ':' + u, file]); } catch {} }
}

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
const LOG_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S*)[^"]*" (\d{3}) (\S+) "([^"]*)" "([^"]*)"/;
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
async function logFiles(domain, u) {
  const dirs = ['/var/log/nginx/domains', '/var/log/apache2/domains', '/var/log/httpd/domains'];
  if (u) dirs.push('/home/' + u + '/web/' + domain + '/logs');
  for (const dir of dirs) {
    const all = await fsp.readdir(dir).catch(() => null);
    if (!all) continue;
    const base = domain + '.log';
    const files = all.filter((f) => (f === base || f.startsWith(base + '.')) && !f.includes('error')).sort().slice(0, 12).map((f) => path.join(dir, f));
    if (files.length) return { dir, files };
  }
  return { dir: null, files: [] };
}
async function analytics(domain, u) {
  const found = await logFiles(domain, u);
  const files = found.files;
  const g = await ensureGeo();
  let totalReq = 0, humanReq = 0, botReq = 0, totalLines = 0, parsed = 0, firstLine = '';
  const humanIps = new Set(), botIps = new Set();
  const pages = new Map(), refs = new Map(), countries = new Map(), days = new Map(), status = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const f of files) {
    let data; try { data = await readLog(f); } catch { continue; }
    for (const line of data.split('\n')) {
      if (!line) continue;
      totalLines++;
      if (!firstLine) firstLine = line.slice(0, 300);
      const m = LOG_RE.exec(line); if (!m) continue;
      parsed++;
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
    debug: { dir: found.dir, fileCount: files.length, totalLines, parsed, sample: parsed === 0 ? firstLine : '' },
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
const hostdb = require('./hostdb'); // billing/subscription store (shared by the route + bot)
const sessionUser = (req) => { const c = getCookie(req); return c ? (sessions.get(c) || null) : null; };
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url || '/', 'http://x');
  const url = parsed.pathname;
  const qp = parsed.searchParams;
  try {
    if (url === '/api/session') { const u = sessionUser(req); return json(res, 200, { authed: !!u, user: u }); }

    // Subscription status for the panel's renew banner. Login is never blocked for
    // hosting — when a term lapses we pause the sites, not the account, so this just
    // tells the panel to show a renew notice. `managed:false` = not a bot-sold account.
    if (url === '/api/subscription') {
      const u = sessionUser(req); if (!u) return json(res, 401, { error: 'not signed in' });
      const c = hostdb.customerByUser(u);
      const botUrl = 'https://t.me/' + (process.env.HH_BOT_USERNAME || 'hatchhostingbot');
      if (!c || !c.subExpires) return json(res, 200, { subscription: { managed: false, botUrl } });
      const daysLeft = Math.ceil((c.subExpires - Date.now()) / 86400000);
      return json(res, 200, { subscription: { managed: true, plan: c.plan, planLabel: (hostdb.plans()[c.plan] || {}).label || c.plan, suspended: !!c.suspended, subExpires: c.subExpires, daysLeft, expired: daysLeft < 0, botUrl } });
    }

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
          aliases: (w.ALIAS || '').split(',').map((a) => a.trim()).filter(Boolean),
        }));
        return json(res, 200, arr);
      }
      if (url === '/api/website/ftp' && req.method === 'GET') {
        const domain = String(qp.get('domain') || '').trim().toLowerCase();
        let d = {};
        try { d = await hestiaJson('v-list-web-domain-ftp', [u, domain]); } catch { d = {}; }
        return json(res, 200, Object.entries(d).map(([name, x]) => ({ name, path: (x && x.PATH) || '' })));
      }
      if (url === '/api/cron' && req.method === 'GET') {
        let d = {};
        try { d = await hestiaJson('v-list-cron-jobs', [u]); } catch { d = {}; }
        const arr = Object.entries(d).map(([id, x]) => ({ id, min: x.MIN, hour: x.HOUR, day: x.DAY, month: x.MONTH, wday: x.WDAY, cmd: x.CMD || x.COMMAND || '' }));
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
        const host = HOSTNAME || ip;
        const supportWa = process.env.SUPPORT_WA || process.env.HH_SUPPORT_WA || 'https://wa.me/message/DNZEI62CNT67P1';
        const supportTg = (process.env.SUPPORT_TG || process.env.HH_SUPPORT_TG || '').replace(/^@/, '');
        return json(res, 200, { ip, hostname: HOSTNAME, pmaUrl: 'https://' + host + '/phpmyadmin/', webmailUrl: 'https://' + host + '/webmail/', supportWa, supportTg });
      }
      if (url === '/api/php-versions') {
        let out = [];
        try { const t = await hestiaJson('v-list-web-templates-backend', []); out = Array.isArray(t) ? t : Object.keys(t); } catch { out = []; }
        return json(res, 200, { templates: out });
      }
      if (url === '/api/analytics' && req.method === 'GET') {
        const domain = String(qp.get('domain') || '').trim().toLowerCase();
        await ensureSite(u, domain);
        return json(res, 200, await analytics(domain, u));
      }
      if (url === '/api/website/pages' && req.method === 'GET') {
        const domain = String(qp.get('domain') || '').trim().toLowerCase();
        return json(res, 200, await listPages(u, domain));
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
          const r = await hestiaDo('v-add-web-domain', [u, domain]);
          if (r.ok) { try { await applyCleanUrls(siteBase(u, domain), true); } catch {} } // clean URLs on by default
          return json(res, 200, r);
        }
        if (url === '/api/website/pages/add') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          const title = String(b.title || '').trim().slice(0, 80);
          let slug = slugify(b.slug || title);
          if (!slug || !okSlug(slug)) slug = randSlug();
          const pagesDir = path.join(base, 'p');
          await fsp.mkdir(pagesDir, { recursive: true });
          // keep it unique so a new page never overwrites an existing one
          let final = slug, tries = 0;
          while (fs.existsSync(path.join(pagesDir, final))) { final = (slug + '-' + randSlug()).slice(0, 32); if (++tries > 6) { final = randSlug(); break; } }
          if (!okSlug(final)) final = randSlug();
          const pdir = path.join(pagesDir, final);
          try {
            await fsp.mkdir(pdir);
            await fsp.writeFile(path.join(pdir, 'index.html'), pageStarter(title, domain));
            await execFileP('chown', ['-R', u + ':' + u, pagesDir]);
          } catch (e) { return json(res, 200, { ok: false, error: 'Could not create the page: ' + (e.message || e) }); }
          return json(res, 200, { ok: true, slug: final, path: 'p/' + final, link: domain + '/p/' + final, url: 'https://' + domain + '/p/' + final });
        }
        if (url === '/api/website/pages/delete') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          const slug = String(b.slug || '').trim().toLowerCase();
          if (!okSlug(slug)) return json(res, 400, { error: 'Invalid page' });
          const pdir = safeJoin(base, 'p/' + slug);
          if (pdir === base || pdir === path.join(base, 'p')) return json(res, 400, { error: 'Invalid page' });
          try { await fsp.rm(pdir, { recursive: true, force: true }); } catch { return json(res, 200, { ok: false, error: 'Could not delete the page' }); }
          return json(res, 200, { ok: true });
        }
        if (url === '/api/website/cleanurls') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          try { await applyCleanUrls(base, b.on !== false); } catch (e) { return json(res, 200, { ok: false, error: 'Could not update clean URLs' }); }
          return json(res, 200, { ok: true, on: b.on !== false });
        }
        if (url === '/api/cleanurls-all') {
          let d = {}; try { d = await hestiaJson('v-list-web-domains', [u]); } catch {}
          for (const domain of Object.keys(d)) { try { await applyCleanUrls(siteBase(u, domain), true); } catch {} }
          return json(res, 200, { ok: true, count: Object.keys(d).length });
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
          if (!r.ok) { r.error = 'Could not issue the certificate.' + hint; return json(res, 200, r); }
          if (apacheStack()) { try { await setForceHttps(u, domain, true); } catch {} } // send http -> https
          return json(res, 200, r);
        }
        if (url === '/api/website/forcehttps') {
          const domain = String(b.domain || '').trim().toLowerCase();
          if (!okDomain(domain)) return json(res, 400, { error: 'Invalid domain' });
          if (!apacheStack()) return json(res, 200, { ok: false, error: 'This server is Nginx-only; the HTTPS redirect is set differently — contact support.' });
          try { await setForceHttps(u, domain, b.enabled !== false); } catch (e) { return json(res, 200, { ok: false, error: 'Could not update: ' + (e.message || e) }); }
          return json(res, 200, { ok: true, enabled: b.enabled !== false });
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
        if (url === '/api/website/php') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const tpl = String(b.template || '').trim();
          if (!okDomain(domain) || !/^[A-Za-z0-9._-]{1,64}$/.test(tpl)) return json(res, 400, { error: 'Invalid request' });
          return json(res, 200, await hestiaDo('v-change-web-domain-backend-tpl', [u, domain, tpl]));
        }
        if (url === '/api/website/ftp/add') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const ftpuser = String(b.ftpuser || '').trim();
          const pass = String(b.password || '');
          if (!okDomain(domain) || !okName(ftpuser)) return json(res, 400, { error: 'Name must be letters, numbers, _ or -' });
          if (pass.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
          return json(res, 200, await hestiaDo('v-add-web-domain-ftp', [u, domain, ftpuser, pass]));
        }
        if (url === '/api/website/ftp/delete') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const ftpuser = String(b.ftpuser || '').trim();
          if (!okDomain(domain) || !ftpuser) return json(res, 400, { error: 'Invalid FTP account' });
          return json(res, 200, await hestiaDo('v-delete-web-domain-ftp', [u, domain, ftpuser]));
        }
        if (url === '/api/website/alias/add') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const alias = String(b.alias || '').trim().toLowerCase();
          if (!okDomain(domain) || !okDomain(alias)) return json(res, 400, { error: 'Enter a valid alias domain' });
          return json(res, 200, await hestiaDo('v-add-web-domain-alias', [u, domain, alias]));
        }
        if (url === '/api/website/alias/delete') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const alias = String(b.alias || '').trim().toLowerCase();
          if (!okDomain(domain) || !okDomain(alias)) return json(res, 400, { error: 'Invalid alias' });
          return json(res, 200, await hestiaDo('v-delete-web-domain-alias', [u, domain, alias]));
        }
        if (url === '/api/cron/add') {
          const f = (v, re) => re.test(String(v || '').trim());
          const time = /^[\d*/,-]{1,20}$/;
          const min = String(b.min || '').trim(), hour = String(b.hour || '').trim(), day = String(b.day || '').trim(), month = String(b.month || '').trim(), wday = String(b.wday || '').trim(), cmd = String(b.cmd || '').trim();
          if (![min, hour, day, month, wday].every((x) => time.test(x))) return json(res, 400, { error: 'Schedule fields must be numbers, * , - or /' });
          if (!cmd || cmd.length > 500) return json(res, 400, { error: 'Enter a command to run' });
          return json(res, 200, await hestiaDo('v-add-cron-job', [u, min, hour, day, month, wday, cmd]));
        }
        if (url === '/api/cron/delete') {
          const id = String(b.id || '').trim();
          if (!/^\d+$/.test(id)) return json(res, 400, { error: 'Invalid job' });
          return json(res, 200, await hestiaDo('v-delete-cron-job', [u, id]));
        }
        if (url === '/api/mail/forward') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const account = String(b.account || '').trim().toLowerCase();
          const fwd = String(b.forward || '').trim().toLowerCase();
          if (!okDomain(domain) || !okName(account)) return json(res, 400, { error: 'Invalid mailbox' });
          if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(fwd)) return json(res, 400, { error: 'Enter a valid forwarding email address' });
          const cmd = b.remove ? 'v-delete-mail-account-forward' : 'v-add-mail-account-forward';
          return json(res, 200, await hestiaDo(cmd, [u, domain, account, fwd]));
        }
        if (url === '/api/mail/autoreply') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const account = String(b.account || '').trim().toLowerCase();
          if (!okDomain(domain) || !okName(account)) return json(res, 400, { error: 'Invalid mailbox' });
          if (b.on === false) return json(res, 200, await hestiaDo('v-delete-mail-account-autoreply', [u, domain, account]));
          const msg = String(b.message || '').trim();
          if (!msg || msg.length > 1000) return json(res, 400, { error: 'Enter an auto-reply message' });
          return json(res, 200, await hestiaDo('v-add-mail-account-autoreply', [u, domain, account, msg]));
        }
        if (url === '/api/mail/password') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const account = String(b.account || '').trim().toLowerCase();
          const pass = String(b.password || '');
          if (!okDomain(domain) || !okName(account)) return json(res, 400, { error: 'Invalid mailbox' });
          if (pass.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
          return json(res, 200, await hestiaDo('v-change-mail-account-password', [u, domain, account, pass]));
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
        if (url === '/api/files/newfile') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          const name = path.basename(String(b.name || ''));
          if (!name || name === '.' || name === '..' || /[\/]/.test(String(b.name || ''))) return json(res, 400, { error: 'Invalid file name' });
          const file = safeJoin(base, (b.path || '') + '/' + name);
          if (fs.existsSync(file)) return json(res, 200, { ok: false, error: 'A file with that name already exists' });
          await fsp.writeFile(file, '');
          try { await execFileP('chown', [u + ':' + u, file]); } catch {}
          return json(res, 200, { ok: true });
        }
        if (url === '/api/files/rename') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          const from = safeJoin(base, (b.path || '') + '/' + path.basename(String(b.name || '')));
          const newName = path.basename(String(b.newName || ''));
          if (!newName || newName === '.' || newName === '..' || /[\/]/.test(String(b.newName || ''))) return json(res, 400, { error: 'Invalid new name' });
          if (from === base) return json(res, 400, { error: 'Cannot rename the site root' });
          const to = safeJoin(base, (b.path || '') + '/' + newName);
          if (fs.existsSync(to)) return json(res, 200, { ok: false, error: 'Something with that name already exists' });
          try { await fsp.rename(from, to); } catch { return json(res, 200, { ok: false, error: 'Could not rename' }); }
          return json(res, 200, { ok: true });
        }
        if (url === '/api/files/extract') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          const name = path.basename(String(b.name || ''));
          if (!/\.zip$/i.test(name)) return json(res, 400, { error: 'Only .zip files can be extracted' });
          const zipPath = safeJoin(base, (b.path || '') + '/' + name);
          const dir = safeJoin(base, (b.path || ''));
          try { await execFileP('unzip', ['-o', zipPath, '-d', dir], { timeout: 120000 }); await execFileP('chown', ['-R', u + ':' + u, dir]); }
          catch (e) { return json(res, 200, { ok: false, error: /not found|ENOENT/.test(e.message) ? 'The unzip tool is not installed on the server' : 'Could not extract the zip' }); }
          return json(res, 200, { ok: true });
        }
        if (url === '/api/files/compress') {
          const domain = String(b.domain || '').trim().toLowerCase();
          const base = await ensureSite(u, domain);
          const name = path.basename(String(b.name || ''));
          if (!name || name === '.' || name === '..') return json(res, 400, { error: 'Invalid name' });
          const dir = safeJoin(base, (b.path || ''));
          const src = safeJoin(dir, name);
          if (!fs.existsSync(src)) return json(res, 200, { ok: false, error: 'That item no longer exists' });
          const outName = name.replace(/\.[^.]+$/, '') + '.zip';
          try { await execFileP('zip', ['-r', outName, name], { cwd: dir, timeout: 120000 }); await execFileP('chown', [u + ':' + u, path.join(dir, outName)]); }
          catch (e) { return json(res, 200, { ok: false, error: /not found|ENOENT/.test(e.message) ? 'The zip tool is not installed on the server' : 'Could not compress' }); }
          return json(res, 200, { ok: true, name: outName });
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

// ---- Telegram sales bot + USDT auto-provisioning (APP mode, needs Hestia) ----
// Runs only where a bot token is set AND Hestia is reachable (the VPS). On a
// confirmed USDT payment it creates a HestiaCP account and the bot DMs the login.
// Do NOT set HH_BOT_TOKEN on the Railway PROXY — the bot must run in one place.
const HH_BOT_TOKEN = process.env.HH_BOT_TOKEN || process.env.TG_BOT_TOKEN || '';
if (HH_BOT_TOKEN) {
  if (!LIVE) {
    console.log('[bot] token set but HESTIA_URL/HESTIA_KEY missing — the sales bot cannot create accounts, not starting');
  } else {
    const bot = require('./bot');
    const HESTIA_PACKAGE = process.env.HESTIA_PACKAGE || 'default';
    const ACCT_EMAIL_DOMAIN = process.env.HH_ACCT_EMAIL_DOMAIN || 'hatchhosting.app';
    const genPass = () => { let s = ''; while (s.length < 16) s += crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, ''); return 'H' + s.slice(0, 15); };
    async function userExists(uName) { try { const d = await hestiaJson('v-list-user', [uName]); return !!(d && d[uName]); } catch { return false; } }
    async function listDomains(uName) { try { const d = await hestiaJson('v-list-web-domains', [uName]); return d ? Object.keys(d) : []; } catch { return []; } }
    // We pause the customer's WEBSITES (not the whole account) so their pages stop
    // serving while their panel login keeps working — that's the point where they see
    // the renew notice. Renewal unsuspends every domain again.
    async function suspendSite(uName) { for (const dom of await listDomains(uName)) { try { await hestiaDo('v-suspend-web-domain', [uName, dom]); } catch (e) {} } }
    async function unsuspendSite(uName) { for (const dom of await listDomains(uName)) { try { await hestiaDo('v-unsuspend-web-domain', [uName, dom]); } catch (e) {} } }
    async function provisionHosting(inv) {
      const plan = hostdb.plans()[inv.plan] || Object.values(hostdb.plans())[0];
      const addMs = plan.days * 86400000;
      const existing = hostdb.customerByTg(inv.tgUserId);
      if (existing && existing.username) {
        // RENEWAL — extend the term and bring the sites back if they'd been paused.
        const subExpires = Math.max(Date.now(), existing.subExpires || 0) + addMs;
        if (existing.suspended) { await unsuspendSite(existing.username); }
        hostdb.upsertCustomer({ tgUserId: inv.tgUserId, username: existing.username, plan: inv.plan, subStart: existing.subStart || Date.now(), subExpires, suspended: false, remindedOn: '' });
        hostdb.markInvoicePaid(inv, existing.username);
        return { username: existing.username, password: null, isNew: false, plan, subExpires };
      }
      // NEW ACCOUNT — create a fresh Hestia user with a random login.
      let username, tries = 0;
      do { username = 'hh' + crypto.randomBytes(3).toString('hex'); tries++; } while (tries < 30 && (await userExists(username)));
      const password = genPass();
      const email = username + '@' + ACCT_EMAIL_DOMAIN;
      const r = await hestiaDo('v-add-user', [username, password, email, HESTIA_PACKAGE, 'HatchHosting'], 60000);
      if (!r.ok) throw new Error('v-add-user: ' + r.error);
      const subExpires = Date.now() + addMs;
      hostdb.upsertCustomer({ tgUserId: inv.tgUserId, username, plan: inv.plan, subStart: Date.now(), subExpires, suspended: false, remindedOn: '' });
      hostdb.markInvoicePaid(inv, username);
      return { username, password, isNew: true, plan, subExpires };
    }
    bot.start({ provision: provisionHosting });
    // Hourly expiry sweep: a day after a term lapses, pause the customer's SITES so
    // their pages stop loading (login stays open). Renewal lifts it automatically.
    const sweep = async () => { for (const c of hostdb.lapsedActive()) { try { await suspendSite(c.username); hostdb.setSuspended(c.username, true); console.log('[bot] paused sites for expired account', c.username); } catch (e) { console.error('[bot] suspend failed for', c.username, e.message); } } };
    setInterval(sweep, 60 * 60 * 1000).unref?.();
    setTimeout(sweep, 30000).unref?.();
  }
}
