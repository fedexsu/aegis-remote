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
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = { admins: [], keys: [], devices: [], sessions: [] };
  }
  for (const k of ['admins', 'keys', 'devices', 'sessions']) if (!Array.isArray(db[k])) db[k] = [];
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
function createAdmin(email, password, name) {
  email = (email || '').toLowerCase().trim();
  if (!email || !password) throw new Error('email and password required');
  if (db.admins.find((a) => a.email === email)) throw new Error('email already registered');
  const { salt, hash } = hashPassword(password);
  const admin = { id: genId(), email, name: name || email, salt, hash, createdAt: Date.now() };
  db.admins.push(admin);
  const key = createKey(admin.id, 'Default'); // every admin gets one enrollment key
  save();
  return { admin, key };
}
const findAdminByEmail = (email) => db.admins.find((a) => a.email === (email || '').toLowerCase().trim());
const findAdminById = (id) => db.admins.find((a) => a.id === id);
const publicAdmin = (a) => a && ({ id: a.id, email: a.email, name: a.name });

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
  const key = { key: genKey(), adminId, label: label || 'Key', createdAt: Date.now(), revoked: false };
  db.keys.push(key);
  save();
  return key;
}
const keysForAdmin = (adminId) => db.keys.filter((k) => k.adminId === adminId);
const findValidKey = (keyStr) => db.keys.find((k) => k.key === keyStr && !k.revoked);
function revokeKey(adminId, keyStr) {
  const k = db.keys.find((x) => x.key === keyStr && x.adminId === adminId);
  if (k) { k.revoked = true; save(); }
  return !!k;
}

// ---- devices ----
function upsertDevice(id, adminId, name, keyUsed) {
  let d = db.devices.find((x) => x.id === id);
  if (!d) {
    d = { id, adminId, name, keyUsed, firstSeen: Date.now(), lastSeen: Date.now() };
    db.devices.push(d);
  } else {
    d.adminId = adminId; d.name = name; d.keyUsed = keyUsed; d.lastSeen = Date.now();
  }
  save();
  return d;
}
const devicesForAdmin = (adminId) => db.devices.filter((d) => d.adminId === adminId);
function touchDevice(id) {
  const d = db.devices.find((x) => x.id === id);
  if (d) { d.lastSeen = Date.now(); }
}

module.exports = {
  DATA_DIR,
  createAdmin, findAdminByEmail, findAdminById, publicAdmin, verifyPassword,
  createSession, getSession, deleteSession,
  createKey, keysForAdmin, findValidKey, revokeKey,
  upsertDevice, devicesForAdmin, touchDevice,
};
