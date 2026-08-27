'use strict';

// Self-managed USDT (TRC-20) payment watcher.
//
// Polls TronGrid for incoming USDT transfers to our single receiving address and
// matches each by its EXACT amount to a pending invoice (invoices carry a unique
// micro-USDT tag, so one address serves everyone). On a match it provisions the
// account and calls onPaid(invoice, credentials) so the bot can DM the buyer.
//
// Config (env):
//   USDT_ADDRESS       your Tron (T...) address that receives USDT   [required]
//   TRONGRID_API_KEY   optional TronGrid api key for higher rate limits
//   USDT_CONTRACT      override token contract (defaults to Tether USDT on Tron)

const https = require('https');
const db = require('./db');

const USDT_CONTRACT = process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // Tether USDT (TRC-20)

function tronGet(pathUrl) {
  return new Promise((resolve, reject) => {
    const headers = { 'Accept': 'application/json' };
    if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
    const req = https.request({ hostname: 'api.trongrid.io', path: pathUrl, method: 'GET', headers, timeout: 15000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('trongrid timeout')));
    req.end();
  });
}

// One polling pass. Returns the number of invoices newly paid.
async function checkPayments(onPaid) {
  const addr = process.env.USDT_ADDRESS;
  if (!addr) return 0;
  db.expireInvoices();
  let json;
  try {
    json = await tronGet(`/v1/accounts/${addr}/transactions/trc20?only_to=true&limit=50&contract_address=${USDT_CONTRACT}`);
  } catch (e) { console.error('[pay] trongrid error:', e.message); return 0; }
  if (!json || !Array.isArray(json.data)) return 0;
  let paid = 0;
  for (const t of json.data) {
    try {
      if (t.to !== addr) continue;
      if (t.token_info && t.token_info.address && t.token_info.address !== USDT_CONTRACT) continue;
      const txid = t.transaction_id;
      if (!txid || db.isTxProcessed(txid)) continue;
      const amountMicro = parseInt(t.value, 10); // USDT has 6 decimals -> micro-USDT
      if (!Number.isFinite(amountMicro) || amountMicro <= 0) continue;
      const inv = db.matchPendingInvoiceByAmount(amountMicro);
      if (!inv) continue; // wrong amount / no pending invoice / expired - ignore
      db.markTxProcessed(txid);
      inv.txid = txid;
      const creds = db.provisionFromInvoice(inv);
      paid++;
      console.log('[pay] invoice %s paid (%s USDT) -> account %s', inv.id, (amountMicro / 1e6).toFixed(6), creds.username);
      try { onPaid && onPaid(inv, creds); } catch (e) { console.error('[pay] onPaid handler error:', e.message); }
    } catch (e) { console.error('[pay] tx handling error:', e.message); }
  }
  return paid;
}

module.exports = { checkPayments, USDT_CONTRACT };
