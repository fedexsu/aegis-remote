'use strict';

// HatchHosting — tiny JSON-file billing store for the Telegram sales bot.
// Zero-dependency. Holds ONLY the bot/billing state (plans, invoices, processed
// TX, and the customer<->Telegram map). The actual hosting accounts live in
// HestiaCP; this file just remembers who bought what and when it expires.
//
// Persist to a directory that survives restarts. On the VPS this defaults to
// /var/lib/hatchhosting; set HOSTDB_DIR to override.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.HOSTDB_DIR || '/var/lib/hatchhosting';
const DB_FILE = path.join(DATA_DIR, 'hostdb.json');

let db = { invoices: [], processedTx: [], customers: [] };
function load() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = { invoices: [], processedTx: [], customers: [] }; }
  for (const k of ['invoices', 'processedTx', 'customers']) if (!Array.isArray(db[k])) db[k] = [];
}
function save() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('[hostdb] save failed:', e.message); }
}
load();

const genId = () => crypto.randomUUID();

// ---- plans (term-based; all plans provision the same hosting package) ----
// Override any field with env HH_PLANS as JSON, e.g.
//   HH_PLANS='{"monthly":{"label":"Monthly","usdt":6,"days":30}}'
// Prices are in USDT (~= USD). Adjust freely — the bot reads these live.
const DEFAULT_PLANS = {
  monthly:   { key: 'monthly',   label: 'Monthly',              usdt: 6,  days: 30 },
  quarterly: { key: 'quarterly', label: 'Quarterly (3 months)', usdt: 16, days: 90 },
  biannual:  { key: 'biannual',  label: 'Biannual (6 months)',  usdt: 30, days: 180 },
  annual:    { key: 'annual',    label: 'Annual (12 months)',   usdt: 55, days: 365 },
};
let PLANS = DEFAULT_PLANS;
try {
  if (process.env.HH_PLANS) {
    const over = JSON.parse(process.env.HH_PLANS);
    PLANS = {};
    for (const [k, v] of Object.entries(over)) PLANS[k] = { key: k, label: v.label || k, usdt: +v.usdt, days: +v.days };
    if (!Object.keys(PLANS).length) PLANS = DEFAULT_PLANS;
  }
} catch (e) { console.error('[hostdb] bad HH_PLANS, using defaults:', e.message); PLANS = DEFAULT_PLANS; }
const plans = () => PLANS;

// ---- invoices (unique-amount matching, one address serves everyone) ----
function createInvoice(tgUserId, tgChat, planKey) {
  const p = PLANS[planKey]; if (!p) return null;
  const baseMicro = Math.round(p.usdt * 1000000);
  const used = new Set(db.invoices.filter((i) => i.status === 'pending' && i.expiresAt > Date.now()).map((i) => i.amountMicro));
  let amountMicro, tries = 0;
  do { amountMicro = baseMicro + 1 + Math.floor(Math.random() * 9999); tries++; } while (used.has(amountMicro) && tries < 5000);
  const now = Date.now();
  const inv = { id: genId(), tgUserId, tgChat, plan: planKey, amountMicro, status: 'pending', txid: null, createdAt: now, expiresAt: now + 60 * 60 * 1000 };
  db.invoices.push(inv); save();
  return inv;
}
const getInvoice = (id) => db.invoices.find((i) => i.id === id);
function expireInvoices() {
  let ch = false;
  for (const i of db.invoices) if (i.status === 'pending' && i.expiresAt <= Date.now()) { i.status = 'expired'; ch = true; }
  if (ch) save();
}
const matchPendingInvoiceByAmount = (amountMicro) => db.invoices.find((i) => i.status === 'pending' && i.expiresAt > Date.now() && i.amountMicro === amountMicro);
const isTxProcessed = (txid) => db.processedTx.includes(txid);
function markTxProcessed(txid) {
  if (!db.processedTx.includes(txid)) { db.processedTx.push(txid); if (db.processedTx.length > 5000) db.processedTx = db.processedTx.slice(-3000); save(); }
}

// ---- customers (Telegram id <-> Hestia username) ----
const customerByTg = (tgUserId) => db.customers.find((c) => c.tgUserId === tgUserId) || null;
const customerByUser = (username) => db.customers.find((c) => c.username === username) || null;
function upsertCustomer(c) {
  let ex = db.customers.find((x) => x.tgUserId === c.tgUserId);
  if (ex) { Object.assign(ex, c); } else { ex = { ...c }; db.customers.push(ex); }
  save();
  return ex;
}
function markInvoicePaid(inv, username) {
  const i = db.invoices.find((x) => x.id === inv.id);
  if (i) { i.status = 'paid'; i.username = username; i.paidAt = Date.now(); i.txid = inv.txid || i.txid; save(); }
}
function setSuspended(username, val) {
  const c = db.customers.find((x) => x.username === username);
  if (c) { c.suspended = !!val; save(); }
}
// Customers whose term has lapsed but are not yet suspended (for the expiry sweep).
const lapsedActive = () => db.customers.filter((c) => !c.suspended && c.subExpires && c.subExpires <= Date.now());

module.exports = {
  DATA_DIR, plans,
  createInvoice, getInvoice, expireInvoices, matchPendingInvoiceByAmount, isTxProcessed, markTxProcessed,
  customerByTg, customerByUser, upsertCustomer, markInvoicePaid, setSuspended, lapsedActive,
};
