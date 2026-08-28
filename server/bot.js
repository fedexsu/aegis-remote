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

// Reply keyboards (buttons live in the keyboard area; tapping one sends its text).
const PLAN_EMOJI = { monthly: '🗓️', quarterly: '📆', biannual: '📅', annual: '⭐' };
const PLAN_TAG = { biannual: '  🔥', annual: '  💎 best value' };
function mainMenuKeyboard() {
  return { keyboard: [
    [{ text: '🚀 Get Started' }],
    [{ text: 'ℹ️ About' }, { text: '📊 My Account' }],
    [{ text: '❓ Help' }],
  ], resize_keyboard: true, is_persistent: true, input_field_placeholder: '👇 Tap to begin' };
}
function plansKeyboard() {
  const P = db.plans();
  const rows = Object.values(P).map((p) => [{ text: `${PLAN_EMOJI[p.key] || '💳'} ${p.label} - ${p.usdt} USDT${PLAN_TAG[p.key] || ''}` }]);
  rows.push([{ text: '⬅️ Back' }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true, input_field_placeholder: '💳 Tap a plan' };
}
function planFromText(t) {
  const s = String(t).trim().toLowerCase();
  for (const p of Object.values(db.plans())) {
    const first = p.label.split(' ')[0].toLowerCase(); // monthly / quarterly / biannual / annual
    if (s === p.key || s.includes(first)) return p.key; // robust to emoji + amount suffix
  }
  return null;
}
// /start: a welcome + menu, NOT the payment list.
function showStart(chat) {
  send(chat,
    '🖥️ <b>HatchConnect</b>\nControl any Windows PC from anywhere, in seconds. ⚡\n\n' +
    '🔓 Unattended access  •  🎧 On-demand support  •  📁 File transfer  •  💻 Backstage  •  🛡️ Uninstall protection\n\n' +
    '👉 Tap <b>Get Started</b> to see plans, or <b>About</b> to learn more.',
    mainMenuKeyboard());
}
function showAbout(chat) {
  send(chat,
    'ℹ️ <b>About HatchConnect</b>\n\n' +
    'Secure remote support and unattended access for your PCs. 🖥️\n\n' +
    '✅ Control any Windows machine through any firewall\n🔐 AES-256 encrypted, end to end\n💻 One-click silent install\n📁 File transfer, recording, background command line, and more\n\n' +
    '💳 You pay in <b>USDT (TRC-20)</b> and your login is created and sent here automatically. 🚀\n\n' +
    '👉 Tap <b>Get Started</b> to choose a plan.',
    mainMenuKeyboard());
}
function showPlans(chat) {
  send(chat,
    '💳 <b>Choose your plan</b>\nEvery plan is full-featured. Longer terms cost less per month. Pay in <b>USDT (TRC-20)</b> and your login arrives here automatically. 🚀',
    plansKeyboard());
}
function showInvoice(chat, inv) {
  const addr = process.env.USDT_ADDRESS;
  const p = db.plans()[inv.plan];
  const amt = (inv.amountMicro / 1e6).toFixed(6);
  const text =
    `🧾 <b>${esc(p.label)}</b>\n\n` +
    `💸 Send <b>exactly</b>:\n<code>${amt}</code> <b>USDT</b>\n\n` +
    `📥 To this address (Tron / TRC-20):\n<code>${esc(addr)}</code>\n\n` +
    `⚠️ Send the EXACT amount. The last digits are your order tag.\n` +
    `🌐 Network: <b>Tron (TRC-20)</b> only. Nothing else.\n` +
    `⏳ Expires in 60 minutes.\n\n` +
    `Your login arrives here automatically the moment it confirms. 🚀`;
  send(chat, text, { inline_keyboard: [
    [{ text: '✅ I have paid - check now', callback_data: 'check:' + inv.id }],
    [{ text: '⬅️ Back to plans', callback_data: 'plans' }],
  ] });
}

async function handleUpdate(u, onCheck) {
  try {
    if (u.message && u.message.text) {
      const t = u.message.text.trim();
      const chat = u.message.chat.id;
      if (/^\/(start|menu)\b/.test(t) || /^⬅️|back$/i.test(t)) return showStart(chat);
      if (/^\/(plans|buy)\b/i.test(t) || /get started|^plans$|^buy$/i.test(t)) return showPlans(chat);
      if (/^\/about\b/i.test(t) || /about/i.test(t)) return showAbout(chat);
      if (/^\/status\b/i.test(t) || /account|status/i.test(t)) {
        const a = db.accountByTg(u.message.from.id);
        if (!a) return send(chat, '🤷 No subscription yet. Tap <b>Get Started</b> to pick a plan. 👇', mainMenuKeyboard());
        const until = a.subExpires ? new Date(a.subExpires).toISOString().slice(0, 10) : 'n/a';
        const P = db.plans()[a.plan];
        const expired = a.subExpires && a.subExpires <= Date.now();
        return send(chat, `📊 <b>Your subscription</b>\n\n📦 Plan: <b>${esc(P ? P.label : a.plan || 'n/a')}</b>\n${expired ? '⛔ <b>Expired</b>' : '⏳ Active until'}: <b>${until}</b>\n👤 Username: <code>${esc(a.username)}</code>\n🔗 Sign in: ${APP_URL}\n\n🔄 To ${expired ? 'reactivate' : 'renew or extend'}, tap <b>Get Started</b> and pick a plan. Time is added on top of what you have.`, mainMenuKeyboard());
      }
      if (/^\/help\b/i.test(t) || /help/i.test(t)) return send(chat, '❓ <b>How it works</b>\n\n1️⃣ Tap <b>Get Started</b> and choose a plan.\n2️⃣ Send the exact USDT (TRC-20) amount shown.\n3️⃣ Your login arrives here automatically in about a minute. 🎉\n\n📊 <b>My Account</b> shows your plan. 🔄 /start reopens the menu.', mainMenuKeyboard());
      const planKey = planFromText(t);
      if (planKey) {
        if (!process.env.USDT_ADDRESS) return send(chat, 'Payments are not configured yet. Please try again shortly.');
        const inv = db.createInvoice(u.message.from.id, chat, planKey);
        if (!inv) return send(chat, 'That plan is not available. Send /start to try again.');
        return showInvoice(chat, inv);
      }
      return showStart(chat);
    }
    if (u.callback_query) {
      const cq = u.callback_query;
      const chat = cq.message && cq.message.chat.id;
      const data = cq.data || '';
      api('answerCallbackQuery', { callback_query_id: cq.id });
      if (data === 'start') return showStart(chat);
      if (data === 'plans') return showPlans(chat);
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

// DM the buyer once a payment is confirmed (new account or renewal), including a
// one-tap magic-login link so they don't have to type the generated password.
function notifyPaid(inv, creds) {
  const p = creds.plan;
  const until = new Date(creds.subExpires).toISOString().slice(0, 10);
  const loginUrl = `${APP_URL}/?login=${db.createMagicToken(creds.adminId)}`;
  if (process.env.OWNER_TG_CHAT) {
    send(process.env.OWNER_TG_CHAT, `💰 <b>${creds.isNew ? 'New sale' : 'Renewal'}</b>\nPlan: ${esc(p.label)} (${p.usdt} USDT)\nAccount: <code>${esc(creds.username)}</code>`);
  }
  if (creds.isNew) {
    send(inv.tgChat,
      `🎉 <b>Payment confirmed! Your HatchConnect account is live.</b> 🚀\n\n` +
      `🔐 <b>Tap here to open your dashboard</b> (one tap, no password to type):\n${loginUrl}\n\n` +
      `Prefer to sign in manually? ${APP_URL}\n👤 Username: <code>${esc(creds.username)}</code>\n🔑 Password: <code>${esc(creds.password)}</code>\n\n` +
      `📦 Plan: <b>${esc(p.label)}</b> · active until ${until} ✅\n\n` +
      `👉 <b>Next steps</b>\n1️⃣ Tap the link above 🔓\n2️⃣ Open Enrollment and copy your install link 🔗\n3️⃣ Grab the desktop app: ${APP_URL}/app 💻`,
      { inline_keyboard: [[{ text: '🔓 Open my dashboard', url: loginUrl }]] });
  } else {
    send(inv.tgChat,
      `🔄 <b>Renewal confirmed!</b> Your subscription is extended. 🎉\n\n` +
      `📦 Plan: <b>${esc(p.label)}</b> · now active until <b>${until}</b> ✅\n\n` +
      `Your username and password are unchanged.`,
      { inline_keyboard: [[{ text: '🔓 Open my dashboard', url: loginUrl }]] });
  }
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
