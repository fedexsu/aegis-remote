'use strict';

// HatchHosting — self-managed USDT (TRC-20) payment watcher.
// Polls TronGrid for incoming USDT transfers to our receiving address and matches
// each by its EXACT amount to a pending invoice (invoices carry a unique micro-USDT
// tag, so one address serves everyone). On a match it calls provision(inv) — which
// creates/renews the HestiaCP hosting account — then onPaid(inv, creds) so the bot
// can DM the buyer their login.
//
// Config (env):
//   HH_USDT_ADDRESS    your Tron (T...) address that receives USDT   [required]
//   TRONGRID_API_KEY   optional TronGrid api key for higher rate limits
//   USDT_CONTRACT      override token contract (defaults to Tether USDT on Tron)

const https = require('https');
const hostdb = require('./hostdb');

const USDT_CONTRACT = process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // Tether USDT (TRC-20)
const RECV = () => process.env.HH_USDT_ADDRESS || process.env.USDT_ADDRESS || '';

function tronGet(pathUrl) {
  return new Promise((resolve, reject) => {
    const headers = { 'Accept': 'application/json' };
    if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
    const req = https.request({ hostname: 'api.trongrid.io', path: pathUrl, method: 'GET', headers, timeout: 15000 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('trongrid timeout')));
    req.end();
  });
}

// One polling pass. provision(inv) -> Promise<creds>; onPaid(inv, creds).
async function checkPayments(provision, onPaid) {
  const addr = RECV();
  if (!addr) return 0;
  hostdb.expireInvoices();
  let json;
  try { json = await tronGet(`/v1/accounts/${addr}/transactions/trc20?only_to=true&limit=50&contract_address=${USDT_CONTRACT}`); }
  catch (e) { console.error('[pay] trongrid error:', e.message); return 0; }
  if (!json || !Array.isArray(json.data)) return 0;
  let paid = 0;
  for (const t of json.data) {
    try {
      if (t.to !== addr) continue;
      if (t.token_info && t.token_info.address && t.token_info.address !== USDT_CONTRACT) continue;
      const txid = t.transaction_id;
      if (!txid || hostdb.isTxProcessed(txid)) continue;
      const amountMicro = parseInt(t.value, 10);
      if (!Number.isFinite(amountMicro) || amountMicro <= 0) continue;
      const inv = hostdb.matchPendingInvoiceByAmount(amountMicro);
      if (!inv) continue; // wrong amount / no pending invoice / expired
      hostdb.markTxProcessed(txid);
      inv.txid = txid;
      let creds;
      try { creds = await provision(inv); }
      catch (e) { console.error('[pay] provision failed for invoice %s: %s', inv.id, e.message); continue; }
      paid++;
      console.log('[pay] invoice %s paid (%s USDT) -> account %s', inv.id, (amountMicro / 1e6).toFixed(6), creds && creds.username);
      try { onPaid && onPaid(inv, creds); } catch (e) { console.error('[pay] onPaid handler error:', e.message); }
    } catch (e) { console.error('[pay] tx handling error:', e.message); }
  }
  return paid;
}

module.exports = { checkPayments, USDT_CONTRACT };
