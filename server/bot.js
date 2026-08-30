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
const CHANNEL_USER = (process.env.CHANNEL_USERNAME || 'hatchconnect').replace(/^@/, '');
const CHANNEL = '@' + CHANNEL_USER;
const CHANNEL_URL = 'https://t.me/' + CHANNEL_USER;
const SUPPORT_WA = process.env.SUPPORT_WA || 'https://wa.me/message/DNZEI62CNT67P1';
const SUPPORT_TG = (process.env.SUPPORT_TG || '').replace(/^@/, ''); // Telegram support handle (set later)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Force-join: a user must be a member of our channel to use the bot. (The bot must
// be an ADMIN of the channel for this check to work; if it can't verify, it fails
// OPEN so a misconfig never blocks sales.)
async function isMember(userId) {
  try {
    const r = await api('getChatMember', { chat_id: CHANNEL, user_id: userId });
    if (!r || !r.ok) return true; // can't check (bot not admin / channel unset) -> allow
    const st = r.result && r.result.status;
    return ['creator', 'administrator', 'member', 'restricted'].includes(st);
  } catch { return true; }
}
function joinPrompt(chat) {
  send(chat,
    '📣 <b>One quick step</b>\nJoin our channel to use the bot. 👇\n\nTap <b>Join channel</b>, then tap <b>I have joined</b>.',
    { inline_keyboard: [
      [{ text: '📣 Join channel', url: CHANNEL_URL }],
      [{ text: '✅ I have joined', callback_data: 'joined' }],
    ] });
}

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
const HH_BOT_USERNAME = (process.env.HH_BOT_USERNAME || 'hatchhostingbot').replace(/^@/, '');
const HH_BOT_URL = 'https://t.me/' + HH_BOT_USERNAME;
function mainMenuKeyboard() {
  return { keyboard: [
    [{ text: '🚀 Get Started' }],
    [{ text: '🖥️ Web Hosting (cPanel)' }],
    [{ text: 'ℹ️ About' }, { text: '📊 My Account' }],
    [{ text: '📣 Channel' }, { text: '❓ Help' }],
    [{ text: '💬 Support' }],
  ], resize_keyboard: true, is_persistent: true, input_field_placeholder: '👇 Tap to begin' };
}
function showSupport(chat) {
  const rows = [[{ text: '💬 WhatsApp support', url: SUPPORT_WA }]];
  if (SUPPORT_TG) rows.push([{ text: '✈️ Telegram support', url: 'https://t.me/' + SUPPORT_TG }]);
  send(chat, '💬 <b>Support</b>\nNeed a hand — setup, billing, or a question? Tap below to reach a human. 👇', { inline_keyboard: rows });
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
    const from = (u.message && u.message.from) || (u.callback_query && u.callback_query.from);
    const gateChat = (u.message && u.message.chat && u.message.chat.id) || (u.callback_query && u.callback_query.message && u.callback_query.message.chat.id);
    const isJoinedCb = u.callback_query && u.callback_query.data === 'joined';
    // Force-join gate (everything except the "I have joined" recheck).
    if (from && gateChat && !isJoinedCb) {
      if (!(await isMember(from.id))) return joinPrompt(gateChat);
    }
    if (isJoinedCb) {
      api('answerCallbackQuery', { callback_query_id: u.callback_query.id });
      if (await isMember(from.id)) return showStart(gateChat);
      return joinPrompt(gateChat);
    }
    if (u.message && u.message.text) {
      const t = u.message.text.trim();
      const chat = u.message.chat.id;
      if (/^\/(start|menu)\b/.test(t) || /^⬅️|back$/i.test(t)) return showStart(chat);
      if (/channel/i.test(t)) return send(chat, '📣 <b>HatchConnect channel</b>\nUpdates, tips, and news. 👇', { inline_keyboard: [[{ text: '📣 Open channel', url: CHANNEL_URL }]] });
      if (/web hosting|hosting|cpanel/i.test(t)) return send(chat, '🌱 <b>Need web hosting too?</b>\nPut your website online with <b>HatchHosting</b> — one-click WordPress, free SSL, email at your domain and an easy control panel. 🚀', { inline_keyboard: [[{ text: '🌱 Open HatchHosting', url: HH_BOT_URL }]] });
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
      if (/^\/support\b/i.test(t) || /support|contact/i.test(t)) return showSupport(chat);
      if (/^\/help\b/i.test(t) || /help/i.test(t)) return send(chat, '❓ <b>How it works</b>\n\n1️⃣ Tap <b>Get Started</b> and choose a plan.\n2️⃣ Send the exact USDT (TRC-20) amount shown.\n3️⃣ Your login arrives here automatically in about a minute. 🎉\n\n📊 <b>My Account</b> shows your plan. 💬 <b>Support</b> reaches a human. 🔄 /start reopens the menu.', mainMenuKeyboard());
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

// DM the buyer once a payment is confirmed. New account -> fresh username + password
// + sign-in instructions. Renewal -> extended, same login.
function notifyPaid(inv, creds) {
  const p = creds.plan;
  const until = new Date(creds.subExpires).toISOString().slice(0, 10);
  if (process.env.OWNER_TG_CHAT) {
    send(process.env.OWNER_TG_CHAT, `💰 <b>${creds.isNew ? 'New sale' : 'Renewal'}</b>\nPlan: ${esc(p.label)} (${p.usdt} USDT)\nAccount: <code>${esc(creds.username)}</code>`);
  }
  if (creds.isNew) {
    send(inv.tgChat,
      `🎉 <b>Payment confirmed! Here is your HatchConnect account.</b> 🚀\n\n` +
      `🔗 <b>Dashboard:</b> ${APP_URL}\n👤 <b>Username:</b> <code>${esc(creds.username)}</code>\n🔑 <b>Password:</b> <code>${esc(creds.password)}</code>\n\n` +
      `📦 <b>Plan:</b> ${esc(p.label)} · active until ${until} ✅\n\n` +
      `👉 <b>How to sign in</b>\n1️⃣ Open <b>${APP_URL}</b> in your browser\n2️⃣ Enter the username and password above\n3️⃣ Change your password in Settings 🔒\n4️⃣ Open <b>Enrollment</b>, copy your install link, and get the app: ${APP_URL}/app 💻`);
  } else {
    send(inv.tgChat,
      `🔄 <b>Renewal confirmed!</b> Your subscription is extended. 🎉\n\n` +
      `📦 <b>Plan:</b> ${esc(p.label)} · now active until <b>${until}</b> ✅\n\n` +
      `Sign in with your existing username and password at ${APP_URL}. Same account, more time. 🙌`);
  }
}

// Renewal reminders: DM customers daily during the last 3 days before expiry, and a
// single notice once access is blocked. Throttled via each account's `remindedOn`.
function remindSweep() {
  try {
    const dayKey = new Date().toISOString().slice(0, 10);
    for (const s of db.subscriberReminders()) {
      const d = s.daysLeft;
      const P = db.plans()[s.plan];
      const tag = P ? (' (' + esc(P.label) + ')') : '';
      if (d < 0) {
        if (s.remindedOn === 'expired') continue;
        send(s.tgChat, `⛔ <b>Subscription expired</b>\nYour HatchConnect access${tag} is now paused. Renew to switch it back on — tap <b>Get Started</b>. Your login stays the same. 🔓`, mainMenuKeyboard());
        db.setReminded(s.id, 'expired');
      } else if (d <= 3) {
        if (s.remindedOn === dayKey) continue;
        const when = d <= 0 ? '<b>today</b>' : ('in <b>' + d + ' day' + (d === 1 ? '' : 's') + '</b>');
        send(s.tgChat, `⏳ <b>Renewal reminder</b>\nYour HatchConnect subscription${tag} expires ${when}.\n\nRenew now to keep your access — tap <b>Get Started</b>. 🚀`, mainMenuKeyboard());
        db.setReminded(s.id, dayKey);
      }
    }
  } catch (e) { console.error('[bot] remind sweep error:', e.message); }
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
  setTimeout(remindSweep, 20000); setInterval(remindSweep, 6 * 60 * 60 * 1000); // renewal reminders
  console.log('[bot] Telegram bot started (long-polling); watching USDT payments every 45s');
}

module.exports = { start };
