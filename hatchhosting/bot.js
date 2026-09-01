'use strict';

// HatchHosting Telegram bot (zero-dependency, long-polling).
//
// Flow: /start -> plan buttons -> pick a plan -> the bot creates a unique-amount
// USDT invoice and shows pay instructions -> the payment watcher (payments.js)
// confirms on-chain, provisions a HestiaCP hosting account, and calls onPaid ->
// the bot DMs the buyer their control-panel login.
//
// Runs INSIDE the HatchHosting APP process (on the VPS) so it can reach Hestia to
// create accounts. server.js calls start({ provision }).
//
// Config (env):
//   HH_BOT_TOKEN | TG_BOT_TOKEN   bot token from @BotFather          [required]
//   HH_USDT_ADDRESS               Tron address that receives USDT     [required]
//   HH_CHANNEL_USERNAME           channel users must join (bot = admin there)
//   PANEL_URL | PUBLIC_URL        panel sign-in URL
//   HH_OWNER_TG_CHAT              your chat id, for sale alerts

const https = require('https');
const hostdb = require('./hostdb');
const payments = require('./payments');

const TOKEN = process.env.HH_BOT_TOKEN || process.env.TG_BOT_TOKEN;
const APP_URL = process.env.PANEL_URL || process.env.PUBLIC_URL || 'https://hatchhosting.up.railway.app';
const SITE_URL = process.env.HH_SITE_URL || process.env.SITE_URL || APP_URL; // site link shown in the bot
const CHANNEL_USER = (process.env.HH_CHANNEL_USERNAME || '').replace(/^@/, '');
const CHANNEL = CHANNEL_USER ? '@' + CHANNEL_USER : '';
const CHANNEL_URL = CHANNEL_USER ? 'https://t.me/' + CHANNEL_USER : '';
const SUPPORT_TG = (process.env.HH_SUPPORT_TG || process.env.SUPPORT_TG || 'hatchadmin').replace(/^@/, ''); // Telegram support handle
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function api(method, params) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(params || {}), 'utf8');
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${TOKEN}/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }, timeout: 60000,
    }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    req.end(body);
  });
}
const send = (chat, text, markup) => api('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup });

// Force-join gate. The bot must be an ADMIN of the channel for this to work; if it
// can't verify (bot not admin / channel unset) it fails OPEN so a misconfig never
// blocks sales.
async function isMember(userId) {
  if (!CHANNEL) return true;
  try {
    const r = await api('getChatMember', { chat_id: CHANNEL, user_id: userId });
    if (!r || !r.ok) return true;
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

// Reply keyboards (buttons live in the keyboard area; tapping one sends its text).
const PLAN_EMOJI = { monthly: '🗓️', quarterly: '📆', biannual: '📅', annual: '⭐' };
const PLAN_TAG = { biannual: '  🔥', annual: '  💎 best value' };
function mainMenuKeyboard() {
  const rows = [
    [{ text: '🚀 Get Started' }],
    [{ text: 'ℹ️ About' }, { text: '📊 My Account' }],
  ];
  rows.push(CHANNEL_URL ? [{ text: '📣 Channel' }, { text: '❓ Help' }] : [{ text: '❓ Help' }]);
  rows.push([{ text: '💬 Support' }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true, input_field_placeholder: '👇 Tap to begin' };
}
function showSupport(chat) {
  send(chat, '💬 <b>Support</b>\nWe’re happy to help — setup, your domain, billing, or any question. Message us on Telegram. 👇', { inline_keyboard: [[{ text: '✈️ Message support', url: 'https://t.me/' + SUPPORT_TG }]] });
}
function plansKeyboard() {
  const P = hostdb.plans();
  const rows = Object.values(P).map((p) => [{ text: `${PLAN_EMOJI[p.key] || '💳'} ${p.label} - ${p.usdt} USDT${PLAN_TAG[p.key] || ''}` }]);
  rows.push([{ text: '⬅️ Back' }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true, input_field_placeholder: '💳 Tap a plan' };
}
function planFromText(t) {
  const s = String(t).trim().toLowerCase();
  for (const p of Object.values(hostdb.plans())) {
    const first = p.label.split(' ')[0].toLowerCase();
    if (s === p.key || s.includes(first)) return p.key;
  }
  return null;
}
function showStart(chat) {
  send(chat,
    '🌱 <b>HatchHosting</b>\nGet your website online — the simple way. ⚡️\n\n' +
    '🖥️ One-click WordPress • 🔒 Free auto SSL • ✉️ Email at your domain • 🗄️ Databases • 📁 File manager + code editor • 🔗 Extra page links • 💾 Daily backups • 📊 Analytics <b>and more…</b>\n\n' +
    '🌐 <a href="' + SITE_URL + '">' + SITE_URL.replace(/^https?:\/\//, '') + '</a>\n\n' +
    '👉 Tap <b>Get Started</b> to see plans, or <b>About</b> to learn more.',
    mainMenuKeyboard());
}
function showAbout(chat) {
  send(chat,
    'ℹ️ <b>About HatchHosting</b>\n' +
    'Fast, friendly web hosting with an easy control panel — built for people who just want their site online. 🌍\n\n' +
    '<b>Everything included</b>\n' +
    '🖥️ <b>One-click WordPress</b>\n' +
    '🔒 <b>Free HTTPS/SSL</b> — issued automatically once your domain points here\n' +
    '✉️ <b>Email</b> at your own domain (+ Webmail)\n' +
    '🗄️ <b>Databases</b> & phpMyAdmin\n' +
    '📁 <b>File manager</b> with a built-in code editor\n' +
    '🔗 <b>Extra pages</b> on the same domain (yoursite.com/p/…)\n' +
    '🤖 <b>Bot protection</b> & clean URLs\n' +
    '💾 <b>Automatic daily backups</b>\n' +
    '📊 <b>Visitor analytics</b> <b>and more…</b>\n\n' +
    '💳 Pay in <b>USDT (TRC-20)</b> — your hosting account + login are created and sent here automatically. 🚀\n' +
    '🌐 <a href="' + SITE_URL + '">' + SITE_URL.replace(/^https?:\/\//, '') + '</a>\n\n' +
    '👉 Tap <b>Get Started</b> to choose a plan.',
    mainMenuKeyboard());
}
function showPlans(chat) {
  send(chat,
    '💳 <b>Choose your plan</b>\nEvery plan includes the full control panel, WordPress, SSL, email and backups. Longer terms cost less per month. Pay in <b>USDT (TRC-20)</b> and your login arrives here automatically. 🚀',
    plansKeyboard());
}
function showInvoice(chat, inv) {
  const addr = process.env.HH_USDT_ADDRESS || process.env.USDT_ADDRESS;
  const p = hostdb.plans()[inv.plan];
  const amt = (inv.amountMicro / 1e6).toFixed(6);
  const text =
    `🧾 <b>${esc(p.label)} hosting</b>\n\n` +
    `💸 Send <b>exactly</b>:\n<code>${amt}</code> <b>USDT</b>\n\n` +
    `📥 To this address (Tron / TRC-20):\n<code>${esc(addr)}</code>\n\n` +
    `⚠️ Send the EXACT amount. The last digits are your order tag.\n` +
    `🌐 Network: <b>Tron (TRC-20)</b> only. Nothing else.\n` +
    `⏳ Expires in 60 minutes.\n\n` +
    `Your hosting login arrives here automatically the moment it confirms. 🚀`;
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
      // Owner-only dry run: simulate a confirmed purchase (no charge). Provisions a
      // real hosting account and DMs the login + guide — the exact post-payment path.
      // Usage: /testbuy [plan]
      if (/^\/testbuy\b/i.test(t)) {
        if (!process.env.HH_OWNER_TG_CHAT || String(u.message.from.id) !== String(process.env.HH_OWNER_TG_CHAT)) return send(chat, '⛔ Not authorized. (Owner-only test command.)');
        if (!provisionFn) return send(chat, 'test: provisioning not wired (bot not fully started, or HESTIA not connected).');
        const planKey = planFromText(t.replace(/^\/testbuy\s*/i, '')) || Object.keys(hostdb.plans())[0];
        const inv = hostdb.createInvoice(u.message.from.id, chat, planKey);
        if (!inv) return send(chat, 'test: unknown plan.');
        inv.txid = 'TEST-' + Date.now();
        send(chat, '🧪 <b>TEST</b> — simulating a paid <b>' + esc(hostdb.plans()[planKey].label) + '</b> purchase (no charge). Creating the hosting account now — you’ll get exactly what a real buyer gets 👇');
        let creds;
        try { creds = await provisionFn(inv); } catch (e) { return send(chat, '❌ Provisioning failed: ' + esc(e.message || e)); }
        notifyPaid(inv, creds);
        return;
      }
      if (/^\/(start|menu)\b/.test(t) || /^⬅️|^back$/i.test(t)) return showStart(chat);
      if (CHANNEL_URL && /channel/i.test(t)) return send(chat, '📣 <b>HatchHosting channel</b>\nUpdates, tips and news. 👇', { inline_keyboard: [[{ text: '📣 Open channel', url: CHANNEL_URL }]] });
      if (/^\/(plans|buy)\b/i.test(t) || /get started|^plans$|^buy$/i.test(t)) return showPlans(chat);
      if (/^\/about\b/i.test(t) || /about/i.test(t)) return showAbout(chat);
      if (/^\/panel\b/i.test(t) || /open panel|control panel/i.test(t)) return send(chat, `🖥️ <b>Your control panel</b>\n${APP_URL}\n\nSign in with the username and password the bot sent you.`, mainMenuKeyboard());
      if (/^\/(account|status)\b/i.test(t) || /account|status/i.test(t)) {
        const c = hostdb.customerByTg(u.message.from.id);
        if (!c) return send(chat, '🤷 No hosting yet. Tap <b>Get Started</b> to pick a plan. 👇', mainMenuKeyboard());
        const until = c.subExpires ? new Date(c.subExpires).toISOString().slice(0, 10) : 'n/a';
        const P = hostdb.plans()[c.plan];
        const expired = c.subExpires && c.subExpires <= Date.now();
        return send(chat, `📊 <b>Your hosting</b>\n\n📦 Plan: <b>${esc(P ? P.label : c.plan || 'n/a')}</b>\n${expired ? '⛔ <b>Expired</b>' : '⏳ Active until'}: <b>${until}</b>\n👤 Username: <code>${esc(c.username)}</code>\n🔗 Sign in: ${APP_URL}\n\n🔄 To ${expired ? 'reactivate' : 'renew or extend'}, tap <b>Get Started</b> and pick a plan. Time is added on top of what you have.`, mainMenuKeyboard());
      }
      if (/^\/support\b/i.test(t) || /support|contact/i.test(t)) return showSupport(chat);
      if (/^\/help\b/i.test(t) || /help/i.test(t)) return send(chat, '❓ <b>How it works</b>\n\n1️⃣ Tap <b>Get Started</b> and choose a plan.\n2️⃣ Send the exact USDT (TRC-20) amount shown.\n3️⃣ Your hosting account + login arrive here automatically in about a minute. 🎉\n\n📊 <b>My Account</b> shows your plan. 💬 <b>Support</b> reaches a human. 🔄 /start reopens the menu.', mainMenuKeyboard());
      const planKey = planFromText(t);
      if (planKey) {
        if (!(process.env.HH_USDT_ADDRESS || process.env.USDT_ADDRESS)) return send(chat, 'Payments are not configured yet. Please try again shortly.');
        const inv = hostdb.createInvoice(u.message.from.id, chat, planKey);
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
        const inv = hostdb.getInvoice(data.slice(6));
        if (inv && inv.status === 'paid') return; // already handled
        send(chat, 'Checking the blockchain… if you have sent the exact amount, your login will arrive here within a minute.');
        if (onCheck) onCheck();
        return;
      }
    }
  } catch (e) { console.error('[bot] update error:', e.message); }
}

// DM the buyer once a payment is confirmed and the account is provisioned.
function notifyPaid(inv, creds) {
  const p = creds.plan;
  const until = new Date(creds.subExpires).toISOString().slice(0, 10);
  if (process.env.HH_OWNER_TG_CHAT) {
    send(process.env.HH_OWNER_TG_CHAT, `💰 <b>${creds.isNew ? 'New hosting sale' : 'Renewal'}</b>\nPlan: ${esc(p.label)} (${p.usdt} USDT)\nAccount: <code>${esc(creds.username)}</code>`);
  }
  if (creds.isNew) {
    const creds1 =
      `🎉 <b>Payment confirmed! Your hosting is ready.</b> 🚀\n\n` +
      `🔗 <b>Control panel:</b> ${APP_URL}\n👤 <b>Username:</b> <code>${esc(creds.username)}</code>\n🔑 <b>Password:</b> <code>${esc(creds.password)}</code>\n\n` +
      `📦 <b>Plan:</b> ${esc(p.label)} · active until ${until} ✅\n\n` +
      `A full step-by-step guide is coming in the next message 👇`;
    const support = `💬 <b>Need help?</b> Message us on Telegram: https://t.me/${SUPPORT_TG}`;
    const guide =
      `📗 <b>Your complete HatchHosting guide</b>\n\n` +
      `<b>1) Sign in</b>\n• Open ${APP_URL} and log in with the username & password above.\n• Change your password in <b>Settings</b>. 🔒\n\n` +
      `<b>2) Add your website</b>\n• Go to <b>Websites → New website</b> and enter your domain (e.g. mysite.com).\n\n` +
      `<b>3) Point your domain here</b>\n• On the website's <b>Manage ▾ → DNS</b>, the panel shows the exact records (A record for @ and www → your server IP). Add them at wherever you bought your domain.\n• DNS can take a little while to take effect. 🌍\n\n` +
      `<b>4) Turn on free SSL (HTTPS)</b>\n• Once the domain points here, use <b>Manage ▾ → Turn on SSL</b> for the padlock. 🔒\n\n` +
      `<b>5) Build your site</b>\n• 🖱️ <b>One-click WordPress</b> — Manage ▾ → Install WordPress.\n• 📁 <b>File manager</b> — upload or edit your files directly; drag in a zip and extract it.\n• 🔗 <b>Links</b> — host extra pages on the same domain (mysite.com/p/...).\n\n` +
      `<b>6) Email, databases & backups</b>\n• ✉️ <b>Email</b> — create mailboxes at your own domain (Webmail included).\n• 🗄️ <b>Databases</b> — create MySQL DBs + phpMyAdmin.\n• 💾 <b>Backups</b> — make and download backups anytime.\n\n` +
      `<b>7) Analytics</b>\n• See visitors, top pages and countries under <b>Analytics</b>. 📊\n\n` +
      support + `\n\nTap <b>Get Started</b> anytime to renew. 🚀`;
    send(inv.tgChat, creds1).then(() => send(inv.tgChat, guide, mainMenuKeyboard()));
  } else {
    send(inv.tgChat,
      `🔄 <b>Renewal confirmed!</b> Your hosting is extended. 🎉\n\n` +
      `📦 <b>Plan:</b> ${esc(p.label)} · now active until <b>${until}</b> ✅\n\n` +
      `Sign in with your existing username and password at ${APP_URL}. Same account, more time. 🙌`);
  }
}

// Renewal reminders: DM every 2h during the last 3 days BEFORE expiry, then once a
// day AFTER it expires (until they renew). Throttled by each account's remindedAt.
const REMIND_WINDOW = 3 * 86400000, REMIND_BEFORE = 2 * 60 * 60 * 1000, REMIND_AFTER = 24 * 60 * 60 * 1000;
function remindSweep() {
  try {
    const now = Date.now();
    for (const s of hostdb.customerReminders()) {
      const expired = now >= s.subExpires;
      const interval = expired ? REMIND_AFTER : REMIND_BEFORE;
      if (!expired && (s.subExpires - now) > REMIND_WINDOW) continue; // >3 days out: nothing yet
      if (s.remindedAt && (now - s.remindedAt) < interval) continue;
      const P = hostdb.plans()[s.plan];
      const tag = P ? (' (' + esc(P.label) + ')') : '';
      if (expired) {
        send(s.tgChat, `⛔ <b>Subscription expired</b>\nYour HatchHosting plan${tag} has lapsed, so your website is <b>paused</b> and won’t load until you renew. Your panel login still works.\n\nTap <b>Get Started</b> to renew and regain access — bring your site back online. 🌱`, mainMenuKeyboard());
      } else {
        const d = s.daysLeft;
        const when = d <= 0 ? '<b>today</b>' : ('in <b>' + d + ' day' + (d === 1 ? '' : 's') + '</b>');
        send(s.tgChat, `⏳ <b>Renewal reminder</b>\nYour HatchHosting plan${tag} expires ${when}. Renew to keep your website online — tap <b>Get Started</b>. 🚀`, mainMenuKeyboard());
      }
      hostdb.setReminded(s.username, now);
    }
  } catch (e) { console.error('[bot] remind sweep error:', e.message); }
}

let running = false;
let offset = 0;
let provisionFn = null; // stored from start(), used by the owner-only /testbuy command
async function poll(onCheck) {
  const res = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
  if (res && res.ok && Array.isArray(res.result)) {
    for (const u of res.result) { offset = u.update_id + 1; await handleUpdate(u, onCheck); }
  }
  if (running) setTimeout(() => poll(onCheck), res ? 50 : 3000);
}

// start({ provision }) where provision(inv) -> Promise<creds>. No-op (with a log)
// if the bot token isn't configured.
function start(opts) {
  if (!TOKEN) { console.log('[bot] HH_BOT_TOKEN not set - Telegram bot disabled'); return; }
  const provision = opts && opts.provision;
  if (!provision) { console.log('[bot] no provision() supplied - bot disabled'); return; }
  provisionFn = provision; // expose to /testbuy
  if (!(process.env.HH_USDT_ADDRESS || process.env.USDT_ADDRESS)) console.log('[bot] HH_USDT_ADDRESS not set - payments unavailable until configured');
  running = true;
  const runCheck = () => payments.checkPayments(provision, notifyPaid).catch((e) => console.error('[pay] check error:', e.message));
  poll(runCheck);
  setInterval(runCheck, 45000); // watch the chain every 45s
  setTimeout(remindSweep, 25000); setInterval(remindSweep, 30 * 60 * 1000); // renewal reminders (checks every 30m; sends every 2h pre-expiry, daily after)
  console.log('[bot] HatchHosting Telegram bot started (long-polling); watching USDT payments every 45s' + (CHANNEL ? '; channel gate ' + CHANNEL : ''));
}

module.exports = { start };
