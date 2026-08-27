'use strict';

// HatchConnect Telegram bot (zero-dependency, long-polling).
//
// Flow: /start -> plan buttons -> pick a plan -> the bot creates a unique-amount
// USDT invoice and shows the pay instructions -> the payment watcher (payments.js)
// confirms on-chain and calls onPaid -> the bot DMs the buyer their credentials.
//
// Config (env):
//   TG_BOT_TOKEN   bot token from @BotFather                 [required to start]
//   USDT_ADDRESS   your Tron address that receives USDT       [required to start]
//   PUBLIC_URL     dashboard base URL (defaults to the Railway relay URL)

const https = require('https');
const db = require('./db');
const payments = require('./payments');

const TOKEN = process.env.TG_BOT_TOKEN;
const APP_URL = process.env.PUBLIC_URL || 'https://aegis-relay-production.up.railway.app';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function api(method, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify(params || {});
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${TOKEN}/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 60000,
    }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    req.end(body);
  });
}
const send = (chat, text, markup) => api('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup });

function planKeyboard() {
  const P = db.plans();
  return { inline_keyboard: Object.values(P).map((p) => [{ text: `${p.label} — ${p.usdt} USDT`, callback_data: 'plan:' + p.key }]) };
}
function showStart(chat) {
  send(chat,
    '<b>HatchConnect</b>\nSecure remote support and access for your PCs.\n\nChoose a plan below. You pay in <b>USDT (TRC-20)</b> and your account is created automatically the moment the payment confirms.',
    planKeyboard());
}
function showInvoice(chat, inv) {
  const addr = process.env.USDT_ADDRESS;
  const p = db.plans()[inv.plan];
  const amt = (inv.amountMicro / 1e6).toFixed(6);
  const text =
    `<b>${esc(p.label)}</b>\n\nSend <b>exactly</b> this amount of <b>USDT (TRC-20 / Tron)</b>:\n\n` +
    `Amount: <code>${amt}</code> USDT\nAddress: <code>${esc(addr)}</code>\n\n` +
    `Send the EXACT amount (the last digits identify your order). Your account is created and sent here automatically once it confirms, usually within a few minutes. This invoice expires in 60 minutes.\n\n` +
    `Network: <b>Tron (TRC-20)</b> only. Do not send from another network.`;
  send(chat, text, { inline_keyboard: [
    [{ text: 'I have paid — check now', callback_data: 'check:' + inv.id }],
    [{ text: 'Back to plans', callback_data: 'start' }],
  ] });
}

async function handleUpdate(u, onCheck) {
  try {
    if (u.message && u.message.text) {
      const t = u.message.text.trim();
      const chat = u.message.chat.id;
      if (/^\/start\b/.test(t)) return showStart(chat);
      if (/^\/plans\b/.test(t)) return showStart(chat);
      if (/^\/help\b/.test(t)) return send(chat, 'Use /start to choose a plan and pay with USDT (TRC-20). Your login is sent here automatically once payment confirms.');
      return send(chat, 'Send /start to choose a plan.');
    }
    if (u.callback_query) {
      const cq = u.callback_query;
      const chat = cq.message && cq.message.chat.id;
      const data = cq.data || '';
      api('answerCallbackQuery', { callback_query_id: cq.id });
      if (data === 'start') return showStart(chat);
      if (data.startsWith('plan:')) {
        const inv = db.createInvoice(cq.from.id, chat, data.slice(5));
        if (!inv) return send(chat, 'That plan is not available. Send /start to try again.');
        if (!process.env.USDT_ADDRESS) return send(chat, 'Payments are not configured yet. Please try again shortly.');
        return showInvoice(chat, inv);
      }
      if (data.startsWith('check:')) {
        const inv = db.getInvoice(data.slice(6));
        if (inv && inv.status === 'paid') return; // already handled -> credentials already sent
        send(chat, 'Checking the blockchain… if you have sent the exact amount, your login will arrive here within a minute.');
        if (onCheck) onCheck(); // trigger an immediate payment poll
        return;
      }
    }
  } catch (e) { console.error('[bot] update error:', e.message); }
}

// DM the buyer their credentials once a payment is confirmed.
function notifyPaid(inv, creds) {
  const p = creds.plan;
  const until = new Date(Date.now() + p.days * 86400000).toISOString().slice(0, 10);
  send(inv.tgChat,
    `✅ <b>Payment confirmed.</b> Your HatchConnect account is ready.\n\n` +
    `Sign in: ${APP_URL}\nUsername: <code>${esc(creds.username)}</code>\nPassword: <code>${esc(creds.password)}</code>\n\n` +
    `Plan: <b>${esc(p.label)}</b> (active until ${until})\n\n` +
    `Next steps:\n1. Sign in and change your password.\n2. Go to Enrollment and copy your install link.\n3. Get the desktop app: ${APP_URL}/app`);
}

let running = false;
let offset = 0;
async function poll(onCheck) {
  const res = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
  if (res && res.ok && Array.isArray(res.result)) {
    for (const u of res.result) { offset = u.update_id + 1; await handleUpdate(u, onCheck); }
  }
  if (running) setTimeout(() => poll(onCheck), res ? 50 : 3000);
}

// Start the bot + the payment watcher. No-op (with a log) if not configured.
function start() {
  if (!TOKEN) { console.log('[bot] TG_BOT_TOKEN not set - Telegram bot disabled'); return; }
  if (!process.env.USDT_ADDRESS) console.log('[bot] USDT_ADDRESS not set - payments will be unavailable until configured');
  running = true;
  const runCheck = () => payments.checkPayments(notifyPaid).catch((e) => console.error('[pay] check error:', e.message));
  poll(runCheck);
  setInterval(runCheck, 45000); // watch the chain every 45s
  console.log('[bot] Telegram bot started (long-polling); watching USDT payments every 45s');
}

module.exports = { start };
