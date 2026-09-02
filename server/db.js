'use strict';

// Aegis Remote — tiny JSON-file datastore for the multi-tenant platform.
// Pure JS (no native deps). Persist to a directory that survives restarts:
// locally it's ./data; on Railway attach a Volume and set DATA_DIR to its mount
// path (e.g. /data) so admins/keys/devices aren't lost on redeploy.
//
// Scale note: fine for thousands of records. Swap for Postgres (`pg`, pure JS)
// when you outgrow a single file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Sessions expire server-side (the cookie Max-Age is only a client-side hint).
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---- credential-vault encryption at rest -----------------------------------
// Stored passwords are AES-256-GCM encrypted so a leaked db.json / volume
// snapshot doesn't expose them in cleartext. The key comes from VAULT_SECRET
// (set it in prod); otherwise a random key persisted OUTSIDE db.json (vault.key)
// so at least the ciphertext and key aren't in the same file.
function deriveVaultKey() {
  const secret = process.env.VAULT_SECRET;
  if (secret) return crypto.createHash('sha256').update(String(secret)).digest();
  const kf = path.join(DATA_DIR, 'vault.key');
  try { const k = fs.readFileSync(kf); if (k.length === 32) return k; } catch {}
  const k = crypto.randomBytes(32);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(kf, k, { mode: 0o600 }); } catch {}
  return k;
}
const VAULT_KEY = deriveVaultKey();
function encSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain == null ? '' : plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decSecret(stored) {
  if (typeof stored !== 'string') return '';
  if (!stored.startsWith('v1:')) return stored; // legacy plaintext (pre-encryption)
  try {
    const raw = Buffer.from(stored.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}

let db = { admins: [], keys: [], devices: [], sessions: [], invoices: [], processedTx: [] };

function load() {
  let existed = false;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    existed = true;
  } catch {
    db = { admins: [], keys: [], devices: [], sessions: [] };
  }
  for (const k of ['admins', 'keys', 'devices', 'sessions', 'invoices', 'processedTx']) if (!Array.isArray(db[k])) db[k] = [];
  // Migration: ensure there is an owner (the earliest-created admin) even for
  // accounts created before the role field existed.
  if (db.admins.length && !db.admins.some((a) => a.role === 'owner')) {
    const first = db.admins.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
    if (first) { first.role = 'owner'; save(); }
  }
  // Persistence diagnostic: state plainly, on every boot, whether we loaded
  // existing data off the (hopefully persistent) volume or started empty. If a
  // redeploy ever prints "FRESH empty DB", the volume/DATA_DIR is not persisting.
  const activeKeys = db.keys.filter((k) => !k.revoked).length;
  if (existed) {
    console.log(`[db] loaded existing DB from ${DB_FILE} — ${db.admins.length} admin(s), ${activeKeys} active key(s), ${db.devices.length} device(s)`);
  } else {
    console.log(`[db] no DB found at ${DB_FILE} — created FRESH empty DB (prior data was NOT persisted)`);
  }
}
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('db save failed:', e.message);
  }
}
load();

// ---- helpers ----
const genId = () => crypto.randomUUID();
const genKey = () => crypto.randomBytes(15).toString('base64url');   // ~20 chars, filename-safe
const genToken = () => crypto.randomBytes(24).toString('base64url');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  try {
    const h = crypto.scryptSync(pw, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

// ---- admins ----
// The very first admin created is the OWNER (can generate other accounts).
// Others are 'admin' and are flagged to change their generated password.
function createAdmin(username, password, name, role) {
  username = (username || '').toLowerCase().trim();
  if (!username || !password) throw new Error('username and password required');
  if (db.admins.find((a) => a.email === username)) throw new Error('username already exists');
  const isFirst = db.admins.length === 0;
  const { salt, hash } = hashPassword(password);
  const admin = {
    id: genId(), email: username, name: name || username, salt, hash,
    role: isFirst ? 'owner' : (role || 'admin'),
    mustChangePassword: !isFirst,
    createdAt: Date.now(),
  };
  db.admins.push(admin);
  const key = createKey(admin.id, 'Default'); // every admin gets one enrollment key
  save();
  return { admin, key };
}
// ---- Telegram alerts (per admin) ----
const DEFAULT_ALERT_RULES = {
  install:   { on: true,  template: '✅ New install: {device} enrolled\n{os} · {user}@{host}\n{time}' },
  online:    { on: false, template: '🟢 {device} is back ONLINE\n{user}@{host} · {time}' },
  offline:   { on: true,  template: '🔴 {device} went OFFLINE\n{user}@{host} · {time}' },
  uninstall: { on: true,  template: '🗑️ {device} was UNINSTALLED\n{time}' },
};
function getAlerts(adminId) {
  const a = findAdminById(adminId);
  const al = (a && a.alerts) || {};
  const rules = {};
  for (const k of Object.keys(DEFAULT_ALERT_RULES)) rules[k] = { ...DEFAULT_ALERT_RULES[k], ...(al.rules ? al.rules[k] : null) };
  return { botToken: al.botToken || '', chatId: al.chatId || '', rules };
}
function setAlerts(adminId, alerts) {
  const a = findAdminById(adminId);
  if (!a) return false;
  a.alerts = {
    botToken: (alerts.botToken || '').trim(),
    chatId: (alerts.chatId || '').trim(),
    rules: alerts.rules || {},
  };
  save();
  return true;
}
const findAdminByEmail = (email) => db.admins.find((a) => a.email === (email || '').toLowerCase().trim());
const findAdminById = (id) => db.admins.find((a) => a.id === id);
const publicAdmin = (a) => a && ({ id: a.id, email: a.email, name: a.name, role: a.role || 'admin', mustChangePassword: !!a.mustChangePassword });
const hasAdmins = () => db.admins.length > 0;
const listAdmins = () => db.admins.map((a) => ({ id: a.id, username: a.email, name: a.name, role: a.role || 'admin', createdAt: a.createdAt }));
function updatePassword(adminId, newPassword) {
  const a = findAdminById(adminId);
  if (!a) throw new Error('not found');
  const { salt, hash } = hashPassword(newPassword);
  a.salt = salt; a.hash = hash; a.mustChangePassword = false;
  save();
  // (Paid phase: also call deleteSessionsForAdmin(adminId) so old tokens die here.)
}

// ---- sessions ----
// NOTE: sessions currently never expire and survive a password change — kept this
// way intentionally for the single-operator phase (no re-login friction). Tighten
// this (wire up SESSION_TTL below + deleteSessionsForAdmin on password change) once
// the product goes paid/multi-tenant. See getSession/updatePassword.
function createSession(adminId) {
  const token = genToken();
  db.sessions.push({ token, adminId, createdAt: Date.now() });
  save();
  return token;
}
const getSession = (token) => (token ? db.sessions.find((s) => s.token === token) : null);
function deleteSession(token) {
  db.sessions = db.sessions.filter((s) => s.token !== token);
  save();
}
// Ready for the paid phase: invalidate every session for an admin (call on password
// change once we want stolen tokens to die on a password reset). Dormant for now.
function deleteSessionsForAdmin(adminId) {
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.adminId !== adminId);
  if (db.sessions.length !== before) save();
}

// ---- enrollment keys ----
function createKey(adminId, label, meta) {
  const key = { key: genKey(), adminId, label: label || 'Key', meta: meta || {}, createdAt: Date.now(), revoked: false, downloads: 0 };
  db.keys.push(key);
  save();
  return key;
}
// Count a download of the installer for a given enrollment key.
function incKeyDownload(keyStr) {
  const k = db.keys.find((x) => x.key === keyStr);
  if (!k) return null;
  k.downloads = (k.downloads || 0) + 1;
  save();
  return k;
}
// Aggregate live funnel metrics for an admin: how many installers were
// downloaded vs. how many machines actually enrolled (installed), overall and
// per enrollment link.
function statsForAdmin(adminId) {
  const keys = db.keys.filter((k) => k.adminId === adminId);
  const devices = db.devices.filter((d) => d.adminId === adminId);
  let downloads = 0;
  const byKey = keys.map((k) => {
    const dl = k.downloads || 0;
    const installs = devices.filter((d) => d.keyUsed === k.key).length;
    downloads += dl;
    return { key: k.key, label: k.label, revoked: !!k.revoked, downloads: dl, installs };
  });
  const installs = devices.length;
  const uninstalls = devices.filter((d) => d.uninstalledAt).length;
  const active = installs - uninstalls;
  const conversion = downloads ? Math.round((installs / downloads) * 100) : 0;
  const uninstallRate = installs ? Math.round((uninstalls / installs) * 100) : 0;
  return { downloads, installs, active, uninstalls, conversion, uninstallRate, byKey };
}
const keysForAdmin = (adminId) => db.keys.filter((k) => k.adminId === adminId);
const findValidKey = (keyStr) => db.keys.find((k) => k.key === keyStr && !k.revoked);
function revokeKey(adminId, keyStr) {
  const k = db.keys.find((x) => x.key === keyStr && x.adminId === adminId);
  if (k) { k.revoked = true; save(); }
  return !!k;
}
function unrevokeKey(adminId, keyStr) {
  const k = db.keys.find((x) => x.key === keyStr && x.adminId === adminId);
  if (k) { k.revoked = false; save(); }
  return !!k;
}
// Permanently remove an enrollment link. It stops working (findValidKey no longer
// finds it, so agents can't (re)enroll through it) and disappears from the list.
function deleteKey(adminId, keyStr) {
  const before = db.keys.length;
  db.keys = db.keys.filter((k) => !(k.key === keyStr && k.adminId === adminId));
  const removed = db.keys.length < before;
  if (removed) save();
  return removed;
}

// ---- devices ----
function upsertDevice(id, adminId, name, keyUsed, meta) {
  let d = db.devices.find((x) => x.id === id);
  if (!d) {
    d = { id, adminId, name, keyUsed, meta: meta || {}, firstSeen: Date.now(), lastSeen: Date.now() };
    db.devices.push(d);
  } else {
    d.adminId = adminId; d.name = name; d.keyUsed = keyUsed; d.lastSeen = Date.now();
    if (meta && Object.keys(meta).length) d.meta = { ...(d.meta || {}), ...meta };
    if (d.uninstalledAt) delete d.uninstalledAt; // it's back — no longer uninstalled
    if (d.asleep) delete d.asleep;               // it's back — awake again
  }
  save();
  return d;
}
// Mark a device as asleep (S3 sleep) vs a hard offline. Set when the agent
// signalled an impending suspend right before its connection dropped.
function setAsleep(id, val) {
  const d = db.devices.find((x) => x.id === id);
  if (!d) return;
  if (val) d.asleep = true; else delete d.asleep;
  save();
}
// Mark a device as uninstalled (reported by the uninstaller before it removes
// itself). Verified by the enrollment key so a stranger can't flag someone's
// device. Returns the owning adminId on success, else null.
function markUninstalled(id, key) {
  const d = db.devices.find((x) => x.id === id);
  if (!d) return null;
  // Must present a valid enrollment key for THIS device's owner, else anyone who
  // knows a device id could flag it uninstalled (kick the agent, spoof alerts).
  // A missing key is a failure, not a bypass.
  if (!key || (d.keyUsed !== key && !db.keys.some((k) => k.key === key && k.adminId === d.adminId))) return null;
  d.uninstalledAt = Date.now();
  save();
  return d.adminId;
}
// Which admin, if any, already owns this device id (across all tenants). Used to
// block cross-tenant device takeover on register.
const ownerOfDevice = (id) => { const d = db.devices.find((x) => x.id === id); return d ? d.adminId : null; };
const devicesForAdmin = (adminId) => db.devices.filter((d) => d.adminId === adminId);

// ---- uninstall protection (per device) ----
// When `protected` is on, the remote uninstaller refuses to run until the operator
// authorizes removal from the dashboard (sets `uninstallAuthorized`). Only meaningful
// for the SYSTEM-service build (the service self-heals a killed agent); a local admin
// can still force-remove it. Legitimate ONLY on machines authorized to be managed.
function setDeviceProtection(adminId, id, on) {
  const d = db.devices.find((x) => x.id === id && x.adminId === adminId);
  if (!d) return false;
  d.protected = !!on;
  delete d.uninstallAuthorized; // (re)setting protection always starts from a LOCKED state
  save();
  return true;
}
function allowUninstall(adminId, id) {
  const d = db.devices.find((x) => x.id === id && x.adminId === adminId);
  if (!d) return false;
  d.uninstallAuthorized = true;
  save();
  return true;
}
// Called by the remote uninstaller (key-authenticated) to ask if it may proceed.
// Unknown or unprotected device -> allowed. Protected -> fail CLOSED: only a valid
// key for this device AND an operator "Allow uninstall" release lets it through.
function uninstallAllowed(id, key) {
  const d = db.devices.find((x) => x.id === id);
  if (!d) return true;           // nothing to protect
  if (!d.protected) return true; // protection off
  const keyOk = !!key && (d.keyUsed === key || db.keys.some((k) => k.key === key && k.adminId === d.adminId));
  return keyOk && !!d.uninstallAuthorized;
}
function touchDevice(id) {
  const d = db.devices.find((x) => x.id === id);
  if (d) { d.lastSeen = Date.now(); }
}
// Forget a device record (per-admin). The agent, if still installed & running,
// will re-enroll on its next reconnect — this is for pruning stale/offline rows.
function removeDevice(adminId, id) {
  const before = db.devices.length;
  db.devices = db.devices.filter((d) => !(d.id === id && d.adminId === adminId));
  const removed = db.devices.length < before;
  if (removed) save();
  return removed;
}
// Optionally let an admin rename a device from the dashboard.
function renameDevice(adminId, id, name) {
  const d = db.devices.find((x) => x.id === id && x.adminId === adminId);
  if (d) { d.name = name; save(); }
  return !!d;
}

// ---- credential vault (per admin) ----
// Returns credentials with passwords DECRYPTED, for the authenticated owner to use
// (send-to-screen). Encryption here is at-rest protection for db.json, not from
// the admin who owns them.
function getCredentials(adminId) {
  const a = findAdminById(adminId);
  return ((a && a.credentials) || []).map((c) => ({ id: c.id, label: c.label, username: c.username, password: decSecret(c.password) }));
}
function addCredential(adminId, cred) {
  const a = findAdminById(adminId); if (!a) return null;
  a.credentials = a.credentials || [];
  const c = { id: genId(), label: (cred.label || 'Credential').slice(0, 60), username: (cred.username || '').slice(0, 256), password: encSecret((cred.password || '').slice(0, 256)) };
  a.credentials.push(c); save();
  return { id: c.id, label: c.label, username: c.username, password: cred.password || '' };
}
function removeCredential(adminId, id) {
  const a = findAdminById(adminId); if (!a || !a.credentials) return false;
  const n = a.credentials.length; a.credentials = a.credentials.filter((c) => c.id !== id); save();
  return a.credentials.length < n;
}

// ---- billing: plans, USDT invoices, provisioning (Telegram bot) ----------------
// Prices in USDT (1 USDT ~= 1 USD). All plans are full-featured at launch; the term
// just sets the subscription length. Enforcement of expiry is a later step.
const PLANS = {
  monthly:   { key: 'monthly',   label: 'Monthly',            usdt: 499,  days: 30 },
  quarterly: { key: 'quarterly', label: 'Quarterly (3 months)', usdt: 1499, days: 90 },
  biannual:  { key: 'biannual',  label: 'Biannual (6 months)',  usdt: 2999, days: 180 },
  annual:    { key: 'annual',    label: 'Annual (12 months)',   usdt: 5999, days: 365 },
};
const plans = () => PLANS;

// Create a pending invoice with a UNIQUE amount (base price + a tiny per-invoice tag
// in the last micro-USDT digits) so one receiving address can serve everyone: the
// watcher matches an incoming transfer to exactly one invoice by amount.
function createInvoice(tgUserId, tgChat, planKey) {
  const p = PLANS[planKey]; if (!p) return null;
  if (!Array.isArray(db.invoices)) db.invoices = [];
  const baseMicro = p.usdt * 1000000;
  const used = new Set(db.invoices.filter((i) => i.status === 'pending' && i.expiresAt > Date.now()).map((i) => i.amountMicro));
  let amountMicro, tries = 0;
  do { amountMicro = baseMicro + 1 + Math.floor(Math.random() * 9999); tries++; } while (used.has(amountMicro) && tries < 5000);
  const now = Date.now();
  const inv = { id: genId(), tgUserId, tgChat, plan: planKey, amountMicro, status: 'pending', txid: null, adminId: null, createdAt: now, expiresAt: now + 60 * 60 * 1000 };
  db.invoices.push(inv); save();
  return inv;
}
function getInvoice(id) { return (db.invoices || []).find((i) => i.id === id); }
// Look up a provisioned account by the Telegram user who bought it (for /status).
function accountByTg(tgUserId) {
  const a = db.admins.find((x) => x.tgUserId === tgUserId);
  return a ? { username: a.email, plan: a.plan || null, subExpires: a.subExpires || null } : null;
}
function expireInvoices() {
  let ch = false;
  for (const i of db.invoices || []) if (i.status === 'pending' && i.expiresAt <= Date.now()) { i.status = 'expired'; ch = true; }
  if (ch) save();
}
function matchPendingInvoiceByAmount(amountMicro) {
  return (db.invoices || []).find((i) => i.status === 'pending' && i.expiresAt > Date.now() && i.amountMicro === amountMicro);
}
const isTxProcessed = (txid) => (db.processedTx || []).includes(txid);
function markTxProcessed(txid) {
  if (!Array.isArray(db.processedTx)) db.processedTx = [];
  if (!db.processedTx.includes(txid)) { db.processedTx.push(txid); if (db.processedTx.length > 5000) db.processedTx = db.processedTx.slice(-3000); save(); }
}
// On a confirmed payment: if the buyer (by Telegram id) already has an account it's
// a RENEWAL - extend the subscription and keep their existing login. Otherwise create
// a new customer account + enrollment key. Returns what the bot needs to DM them.
function provisionFromInvoice(inv) {
  const p = PLANS[inv.plan] || PLANS.monthly;
  const addMs = p.days * 86400000;
  let admin = db.admins.find((a) => a.tgUserId === inv.tgUserId && (a.role || 'admin') !== 'owner');
  let username, password, isNew = false, wasTrial = false;
  if (admin) {
    // RENEWAL / trial upgrade: add the term onto whichever is later - now or current expiry.
    wasTrial = !!admin.trial; // trial -> paid conversion (same account), for the DM wording
    const base = Math.max(Date.now(), admin.subExpires || 0);
    admin.subExpires = base + addMs;
    admin.plan = inv.plan;
    username = admin.email; password = null; // login unchanged
  } else {
    let tries = 0;
    do { username = 'hc-' + crypto.randomBytes(3).toString('hex'); tries++; } while (findAdminByEmail(username) && tries < 50);
    password = crypto.randomBytes(6).toString('base64url'); // ~8 chars
    const created = createAdmin(username, password, username, 'admin');
    admin = created.admin;
    admin.tgUserId = inv.tgUserId;
    admin.plan = inv.plan;
    admin.subStart = Date.now();
    admin.subExpires = Date.now() + addMs;
    isNew = true;
  }
  admin.remindedAt = 0; // renewal clears the reminder throttle so future reminders fire
  admin.trial = false;  // buying converts a trial into a paid account
  inv.status = 'paid'; inv.adminId = admin.id; inv.paidAt = Date.now();
  save();
  const key = keysForAdmin(admin.id)[0];
  return { username, password, isNew, wasTrial, key: key ? key.key : null, plan: p, subExpires: admin.subExpires, adminId: admin.id };
}

// ---- free trial: one full-featured 3-day account per Telegram user, ever ----------
const TRIAL_DAYS = 3;
const trialDays = () => TRIAL_DAYS;
// One trial per user forever: refuse if they already have any account (trial or paid),
// or if their id is in the durable trialsUsed ledger (survives account deletion).
function hasUsedTrial(tgUserId) {
  if (Array.isArray(db.trialsUsed) && db.trialsUsed.includes(tgUserId)) return true;
  return !!db.admins.find((a) => a.tgUserId === tgUserId && (a.role || 'admin') !== 'owner');
}
const normPhone = (p) => String(p || '').replace(/[^0-9]/g, '');
// One trial per PHONE NUMBER too — a fresh Telegram account needs a fresh number.
function phoneUsedTrial(phone) {
  const ph = normPhone(phone);
  return !!ph && Array.isArray(db.trialPhones) && db.trialPhones.includes(ph);
}
// ---- trial anti-abuse (device-side, no phone needed) ----
// Cap how many machines a trial account can enroll; paid/owner accounts are unlimited.
const TRIAL_MAX_DEVICES = parseInt(process.env.TRIAL_MAX_DEVICES || '3', 10);
const trialMaxDevices = () => TRIAL_MAX_DEVICES;
const isTrialAdmin = (admin) => !!(admin && admin.trial);
const activeDeviceCount = (adminId) => db.devices.filter((d) => d.adminId === adminId && !d.uninstalledAt).length;

function provisionTrial(tgUserId, tgChat, phone) {
  const ph = normPhone(phone);
  const existing = db.admins.find((a) => a.tgUserId === tgUserId && (a.role || 'admin') !== 'owner');
  if (existing) return { already: true, username: existing.email, plan: existing.plan, subExpires: existing.subExpires, expired: isExpired(existing) };
  if (Array.isArray(db.trialsUsed) && db.trialsUsed.includes(tgUserId)) return { already: true, trialUsed: true };
  if (ph && Array.isArray(db.trialPhones) && db.trialPhones.includes(ph)) return { already: true, phoneUsed: true };
  let username, password, tries = 0;
  do { username = 'hc-' + crypto.randomBytes(3).toString('hex'); tries++; } while (findAdminByEmail(username) && tries < 50);
  password = crypto.randomBytes(6).toString('base64url'); // ~8 chars
  const created = createAdmin(username, password, username, 'admin');
  const admin = created.admin;
  admin.tgUserId = tgUserId;
  admin.tgChat = tgChat;
  admin.tgPhone = ph || '';
  admin.plan = 'trial';
  admin.trial = true;
  admin.subStart = Date.now();
  admin.subExpires = Date.now() + TRIAL_DAYS * 86400000;
  admin.remindedAt = 0;
  if (!Array.isArray(db.trialsUsed)) db.trialsUsed = [];
  db.trialsUsed.push(tgUserId);
  if (ph) { if (!Array.isArray(db.trialPhones)) db.trialPhones = []; db.trialPhones.push(ph); }
  save();
  const key = keysForAdmin(admin.id)[0];
  return { username, password, isNew: true, trial: true, subExpires: admin.subExpires, adminId: admin.id, key: key ? key.key : null };
}

// Subscription enforcement + display.
// Access is blocked a GRACE period AFTER the term ends (renewal reminders go out in
// the last 3 days; the account keeps working until grace runs out).
const SUB_GRACE_MS = 24 * 60 * 60 * 1000; // 1 day (paid plans only)
// Trials get NO grace — they end exactly at the 3-day mark; paid plans keep the 1-day grace.
function isExpired(admin) {
  if (!admin || (admin.role || 'admin') === 'owner' || !admin.subExpires) return false;
  const grace = admin.trial ? 0 : SUB_GRACE_MS;
  return (admin.subExpires + grace) <= Date.now();
}

// Customers (non-owner, bought via the bot) for the reminder sweep. `remindedAt`
// (ms of the last DM) throttles: every 2h before expiry, once a day after. Cleared
// on renewal so the next cycle reminds again.
function subscriberReminders() {
  const now = Date.now();
  return db.admins
    .filter((a) => (a.role || 'admin') !== 'owner' && a.tgUserId && a.subExpires)
    .map((a) => ({ id: a.id, tgChat: a.tgChat || a.tgUserId, plan: a.plan, subExpires: a.subExpires, remindedAt: a.remindedAt || 0, daysLeft: Math.ceil((a.subExpires - now) / 86400000) }));
}
function setReminded(id, ts) { const a = findAdminById(id); if (a) { a.remindedAt = ts; save(); } }
function subscriptionOf(adminId) {
  const a = findAdminById(adminId); if (!a) return null;
  const owner = (a.role || 'admin') === 'owner';
  return {
    owner, plan: a.plan || null, subStart: a.subStart || null, subExpires: a.subExpires || null,
    active: owner || !a.subExpires || a.subExpires > Date.now(),
    daysLeft: a.subExpires ? Math.max(0, Math.ceil((a.subExpires - Date.now()) / 86400000)) : null,
    planLabel: a.plan && PLANS[a.plan] ? PLANS[a.plan].label : null,
  };
}

// One-time magic-login tokens (bot -> dashboard auto sign-in). In-memory, 10 min.
const _magic = new Map();
function createMagicToken(adminId) { const t = genToken(); _magic.set(t, { adminId, exp: Date.now() + 600000 }); return t; }
function consumeMagicToken(t) { const e = _magic.get(t); _magic.delete(t); if (!e || e.exp < Date.now()) return null; return e.adminId; }

module.exports = {
  DATA_DIR,
  createAdmin, findAdminByEmail, findAdminById, publicAdmin, verifyPassword,
  hasAdmins, listAdmins, updatePassword,
  createSession, getSession, deleteSession, deleteSessionsForAdmin,
  createKey, keysForAdmin, findValidKey, revokeKey, unrevokeKey, deleteKey, incKeyDownload, statsForAdmin,
  getAlerts, setAlerts,
  upsertDevice, devicesForAdmin, touchDevice, removeDevice, renameDevice, markUninstalled, setAsleep, ownerOfDevice,
  setDeviceProtection, allowUninstall, uninstallAllowed,
  getCredentials, addCredential, removeCredential,
  plans, createInvoice, getInvoice, accountByTg, expireInvoices, matchPendingInvoiceByAmount, isTxProcessed, markTxProcessed, provisionFromInvoice,
  trialDays, hasUsedTrial, phoneUsedTrial, provisionTrial,
  isTrialAdmin, trialMaxDevices, activeDeviceCount,
  isExpired, subscriptionOf, createMagicToken, consumeMagicToken,
  subscriberReminders, setReminded,
};
