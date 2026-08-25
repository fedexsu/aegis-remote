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

let db = { admins: [], keys: [], devices: [], sessions: [] };

function load() {
  let existed = false;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    existed = true;
  } catch {
    db = { admins: [], keys: [], devices: [], sessions: [] };
  }
  for (const k of ['admins', 'keys', 'devices', 'sessions']) if (!Array.isArray(db[k])) db[k] = [];
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
}

// ---- sessions ----
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

// ---- enrollment keys ----
function createKey(adminId, label) {
  const key = { key: genKey(), adminId, label: label || 'Key', createdAt: Date.now(), revoked: false, downloads: 0 };
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
  if (key && d.keyUsed !== key && !db.keys.some((k) => k.key === key && k.adminId === d.adminId)) return null;
  d.uninstalledAt = Date.now();
  save();
  return d.adminId;
}
const devicesForAdmin = (adminId) => db.devices.filter((d) => d.adminId === adminId);
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

module.exports = {
  DATA_DIR,
  createAdmin, findAdminByEmail, findAdminById, publicAdmin, verifyPassword,
  hasAdmins, listAdmins, updatePassword,
  createSession, getSession, deleteSession,
  createKey, keysForAdmin, findValidKey, revokeKey, incKeyDownload, statsForAdmin,
  getAlerts, setAlerts,
  upsertDevice, devicesForAdmin, touchDevice, removeDevice, renameDevice, markUninstalled, setAsleep,
};
