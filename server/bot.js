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
const SITE_URL = process.env.SITE_URL || APP_URL; // marketing/site link shown in the bot
const CHANNEL_USER = (process.env.CHANNEL_USERNAME || 'hatchconnect').replace(/^@/, '');
const CHANNEL = '@' + CHANNEL_USER;
const CHANNEL_URL = 'https://t.me/' + CHANNEL_USER;
const SUPPORT_TG = (process.env.SUPPORT_TG || 'hatchadmin').replace(/^@/, ''); // Telegram support handle
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A readable identifier for owner alerts: @username plus name plus id (whatever exists).
function tgHandle(username, name, id) {
  const parts = [];
  if (username) parts.push('@' + String(username).replace(/^@/, ''));
  if (name) parts.push(esc(name));
  if (id) parts.push('id ' + id);
  return parts.join(' · ') || 'unknown';
}
const fromHandle = (from) => from ? tgHandle(from.username, [from.first_name, from.last_name].filter(Boolean).join(' '), from.id) : 'unknown';

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
  // The trial button IS the one-tap phone check: when a phone is required it carries
  // request_contact, so tapping "Free 3-Day Trial" fires Telegram's own share-number
  // confirm and starts the trial — no second button, no "share my number" wording.
  const trialBtn = REQUIRE_TRIAL_PHONE ? { text: '🎁 Free 3-Day Trial', request_contact: true } : { text: '🎁 Free 3-Day Trial' };
  return { keyboard: [
    [{ text: '🚀 Get Started' }],
    [trialBtn],
    [{ text: '🖥️ Web Hosting (cPanel)' }],
    [{ text: '✨ Features' }, { text: 'ℹ️ About' }],
    [{ text: '📊 My Account' }, { text: '📣 Channel' }],
    [{ text: '❓ Help' }, { text: '💬 Support' }],
  ], resize_keyboard: true, is_persistent: true, input_field_placeholder: '👇 Tap to begin' };
}
function showSupport(chat) {
  send(chat, '💬 <b>Support</b>\nNeed a hand — setup, billing, or a question? Message us on Telegram. 👇', { inline_keyboard: [[{ text: '✈️ Message support', url: 'https://t.me/' + SUPPORT_TG }]] });
}
function showFeatures(chat) {
  send(chat,
    '✨ <b>Everything HatchConnect can do</b>\n\n' +
    '🔓 <b>Unattended access</b> — reach your PCs anytime; no one needed at the other end.\n' +
    '🎧 <b>On-demand support</b> — help someone by having them run one link.\n' +
    '🖱️ <b>Full remote control</b> — their mouse & keyboard, across multiple monitors.\n' +
    '👁️ <b>View-only mode</b> — watch the screen without taking control.\n' +
    '🖥️ <b>Multi-monitor</b> — switch between the remote’s screens.\n' +
    '🚀 <b>Open apps / links</b> — launch a browser or app on the screen you’re viewing.\n' +
    '📁 <b>File transfer</b> — send and receive files both ways.\n' +
    '📋 <b>Clipboard sync</b> — copy/paste text & images between you and the remote.\n' +
    '🎥 <b>Screenshot & recording</b> — grab a still or record the whole session.\n' +
    '💻 <b>Backstage command line</b> — run commands in the background, unseen by the user.\n' +
    '📦 <b>Software deploy</b> — push and silently run an installer on the remote.\n' +
    '🧮 <b>Task manager</b> — see running programs and end any of them.\n' +
    '⬛ <b>Blank their screen</b> — black out the remote monitor while you work privately.\n' +
    '🔒 <b>Block remote input</b> — freeze the local mouse & keyboard during a session.\n' +
    '⌨️ <b>Ctrl+Alt+Del</b> — send it even at the login/secure screen (service build).\n' +
    '🔁 <b>Power controls</b> — reboot, shut down, lock, sleep, or reboot into Safe Mode.\n' +
    '📡 <b>Wake-on-LAN</b> — wake a sleeping PC on the same network.\n' +
    '🧾 <b>System info</b> — full hardware & OS spec sheet of the machine.\n' +
    '🛡️ <b>Uninstall protection</b> — the agent can’t be removed without your OK.\n' +
    '🔔 <b>Telegram alerts</b> — pings when a device installs, uninstalls, or goes on/offline.\n' +
    '🤫 <b>Silent install</b> — deploys with no windows or prompts.\n' +
    '🏷️ <b>White-label</b> — name the installed software your own brand.\n' +
    '🔐 <b>Secure</b> — AES-256 encrypted end-to-end; works through any firewall.\n\n' +
    '👉 Tap <b>Get Started</b> to choose a plan.',
    mainMenuKeyboard());
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
    '🖥️ <b>HatchConnect</b> — a <b>Privately-Owned RMM</b>\nSecurely control any Windows PC from anywhere, in seconds. ⚡️\n\n' +
    '🔓 Unattended access • 🎧 On-demand support • 🖱️ Full remote control • 📁 File transfer • 📋 Clipboard sync • 🎥 Screen record • 💻 Backstage command line • 🛡️ Uninstall protection <b>and more…</b>\n\n' +
    '🔐 AES-256 encrypted, works through any firewall.\n🌐 <a href="' + SITE_URL + '">' + SITE_URL.replace(/^https?:\/\//, '') + '</a>\n\n' +
    '🎁 <b>New here?</b> Try everything free for 3 days — tap <b>🎁 Free 3-Day Trial</b>.\n' +
    '👉 Or tap <b>Get Started</b> to see plans, or <b>About</b> to learn more.',
    mainMenuKeyboard());
}
function showAbout(chat) {
  send(chat,
    'ℹ️ <b>About HatchConnect</b>\n' +
    'HatchConnect is a <b>Privately-Owned RMM</b> (Remote Monitoring &amp; Management) for secure remote support and unattended access to your Windows PCs. 🖥️\n\n' +
    '<b>What you can do</b>\n' +
    '🔓 <b>Unattended access</b> — reach your machines anytime, no one needed on the other end\n' +
    '🎧 <b>On-demand support</b> — help someone in one click\n' +
    '🖱️ <b>Full remote control</b> — mouse, keyboard, multi-monitor\n' +
    '📁 <b>File transfer</b> — send &amp; receive files both ways\n' +
    '📋 <b>Clipboard sync</b> — copy/paste between you and the remote\n' +
    '🎥 <b>Screen capture</b> — screenshot or record sessions\n' +
    '💻 <b>Backstage</b> — background command line without disturbing the user\n' +
    '🛡️ <b>Uninstall protection</b> — devices can’t be removed without your OK\n' +
    '🔔 <b>Telegram alerts</b> — online / offline / install / uninstall <b>and more…</b>\n\n' +
    '🔐 AES-256 encrypted end-to-end • one-click silent install • works through any firewall.\n' +
    '💳 Pay in <b>USDT (TRC-20)</b> — your login is created and sent here automatically. 🚀\n' +
    '🌐 <a href="' + SITE_URL + '">' + SITE_URL.replace(/^https?:\/\//, '') + '</a>\n\n' +
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
    // Shared contact -> the free-trial phone verification step.
    if (u.message && u.message.contact) {
      const chat = u.message.chat.id;
      const c = u.message.contact;
      // Must be THEIR OWN number: Telegram sets contact.user_id only when a user shares
      // their own contact via the request_contact button (a forwarded contact has none / a different id).
      if (!c.user_id || String(c.user_id) !== String(from.id)) {
        return send(chat, '⚠️ Please use the <b>🎁 Free 3-Day Trial</b> button to share <b>your own</b> number — not a forwarded contact.', mainMenuKeyboard());
      }
      return finishTrial(chat, from, c.phone_number);
    }
    if (u.message && u.message.text) {
      const t = u.message.text.trim();
      const chat = u.message.chat.id;
      if (/^\/(start|menu)\b/.test(t) || /^⬅️|back$/i.test(t)) return showStart(chat);
      if (/channel/i.test(t)) return send(chat, '📣 <b>HatchConnect channel</b>\nUpdates, tips, and news. 👇', { inline_keyboard: [[{ text: '📣 Open channel', url: CHANNEL_URL }]] });
      if (/web hosting|hosting|cpanel/i.test(t)) return send(chat, '🌱 <b>Need web hosting too?</b>\nPut your website online with <b>HatchHosting</b> — one-click WordPress, free SSL, email at your domain and an easy control panel. 🚀', { inline_keyboard: [[{ text: '🌱 Open HatchHosting', url: HH_BOT_URL }]] });
      if (/^\/(plans|buy)\b/i.test(t) || /get started|^plans$|^buy$/i.test(t)) return showPlans(chat);
      if (/^\/features\b/i.test(t) || /features/i.test(t)) return showFeatures(chat);
      if (/^\/about\b/i.test(t) || /about/i.test(t)) return showAbout(chat);
      if (/^\/status\b/i.test(t) || /account|status/i.test(t)) {
        const a = db.accountByTg(u.message.from.id);
        if (!a) return send(chat, '🤷 No subscription yet. Tap <b>Get Started</b> to pick a plan. 👇', mainMenuKeyboard());
        const until = a.subExpires ? new Date(a.subExpires).toISOString().slice(0, 10) : 'n/a';
        const P = db.plans()[a.plan];
        const isTrial = a.plan === 'trial';
        const label = isTrial ? 'Free trial (' + db.trialDays() + ' days)' : (P ? P.label : a.plan || 'n/a');
        const expired = a.subExpires && a.subExpires <= Date.now();
        const cta = isTrial
          ? `\n\n${expired ? '🎁 Your trial has ended.' : '🎁 On a free trial.'} Tap <b>Get Started</b> to choose a plan and keep everything — your login and devices stay the same. 🚀`
          : `\n\n🔄 To ${expired ? 'reactivate' : 'renew or extend'}, tap <b>Get Started</b> and pick a plan. Time is added on top of what you have.`;
        return send(chat, `📊 <b>Your ${isTrial ? 'trial' : 'subscription'}</b>\n\n📦 Plan: <b>${esc(label)}</b>\n${expired ? '⛔ <b>Expired</b>' : '⏳ Active until'}: <b>${until}</b>\n👤 Username: <code>${esc(a.username)}</code>\n🔗 Sign in: ${APP_URL}${cta}`, mainMenuKeyboard());
      }
      if (/^\/trial\b/i.test(t) || /free.*trial|3.?day.*trial|^🎁|\btrial\b/i.test(t)) return startTrial(chat, u.message.from);
      if (/^\/support\b/i.test(t) || /support|contact/i.test(t)) return showSupport(chat);
      if (/^\/help\b/i.test(t) || /help/i.test(t)) return send(chat, '❓ <b>How it works</b>\n\n1️⃣ Tap <b>Get Started</b> and choose a plan.\n2️⃣ Send the exact USDT (TRC-20) amount shown.\n3️⃣ Your login arrives here automatically in about a minute. 🎉\n\n📊 <b>My Account</b> shows your plan. 💬 <b>Support</b> reaches a human. 🔄 /start reopens the menu.', mainMenuKeyboard());
      const planKey = planFromText(t);
      if (planKey) {
        if (!process.env.USDT_ADDRESS) return send(chat, 'Payments are not configured yet. Please try again shortly.');
        const inv = db.createInvoice(u.message.from.id, chat, planKey, u.message.from.username, [u.message.from.first_name, u.message.from.last_name].filter(Boolean).join(' '));
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

// The full setup guide sent to every new account (paid or trial). `endLine` closes it.
function setupGuide(endLine) {
  const support = `💬 <b>Need help?</b> Message us on Telegram: https://t.me/${SUPPORT_TG}`;
  return `📘 <b>Your complete HatchConnect guide</b>\n\n` +
    `<b>1) Sign in</b>\n• Open ${APP_URL} and log in with the username & password above.\n• Go to <b>Settings → Change password</b> to set your own. 🔒\n\n` +
    `<b>2) Add a computer (Enrollment)</b>\n• Open the <b>Enrollment</b> page and copy your install link.\n• On the PC you want to access, open ${APP_URL}/app to download the installer — or send the install link to whoever is at that PC.\n• Run it once. The machine appears under <b>Devices</b> within a few seconds. Repeat for every PC. 💻\n\n` +
    `<b>3) Control a device</b>\n• Click a device in <b>Devices</b> to open its live screen.\n• Toggle <b>Control</b> to use its mouse & keyboard (off = view-only).\n• Choose monitor, quality and zoom from the top bar.\n\n` +
    `<b>4) Tools while connected</b>\n• 📁 <b>File transfer</b> — move files both ways.\n• 📋 <b>Clipboard</b> — share text & images with the remote.\n• 🖥️ <b>Essentials</b> — Ctrl+Alt+Del, blank screen, lock.\n• 🎥 <b>Capture</b> — screenshot or record the session.\n• ⌨️ <b>Backstage</b> — background command line without disturbing the user.\n\n` +
    `<b>5) Stay informed</b>\n• <b>Alerts</b> — get a Telegram message when a device comes online, goes offline, installs or uninstalls.\n• <b>Uninstall protection</b> — stop a device being removed without your OK.\n\n` +
    `<b>6) Manage</b>\n• Rename or remove devices from the <b>Devices</b> list.\n• Your plan & renewal live under <b>Settings</b>.\n\n` +
    support + `\n\n` + (endLine || 'Tap <b>Get Started</b> anytime to renew. 🚀');
}
// DM the buyer once a payment is confirmed. New account -> fresh username + password
// + sign-in instructions. Renewal -> extended, same login.
function notifyPaid(inv, creds) {
  const p = creds.plan;
  const until = new Date(creds.subExpires).toISOString().slice(0, 10);
  if (process.env.OWNER_TG_CHAT) {
    send(process.env.OWNER_TG_CHAT, `💰 <b>${creds.wasTrial ? 'Trial upgrade' : (creds.isNew ? 'New sale' : 'Renewal')}</b>\n👤 User: ${tgHandle(inv.tgUsername, inv.tgName, inv.tgUserId)}\nPlan: ${esc(p.label)} (${p.usdt} USDT)\nAccount: <code>${esc(creds.username)}</code>`);
  }
  if (creds.isNew) {
    const creds1 =
      `🎉 <b>Payment confirmed! Here is your HatchConnect account.</b> 🚀\n\n` +
      `🔗 <b>Dashboard:</b> ${APP_URL}\n👤 <b>Username:</b> <code>${esc(creds.username)}</code>\n🔑 <b>Password:</b> <code>${esc(creds.password)}</code>\n\n` +
      `📦 <b>Plan:</b> ${esc(p.label)} · active until ${until} ✅\n\n` +
      `A full step-by-step guide is coming in the next message 👇`;
    const guide = setupGuide('Tap <b>Get Started</b> anytime to renew. 🚀');
    send(inv.tgChat, creds1).then(() => send(inv.tgChat, guide, mainMenuKeyboard()));
  } else if (creds.wasTrial) {
    send(inv.tgChat,
      `🎉 <b>You are upgraded to ${esc(p.label)}!</b> Your free trial is now a full paid plan. 🚀\n\n` +
      `📦 <b>Active until:</b> <b>${until}</b> ✅\n\n` +
      `Nothing else to do — sign in with the <b>same username and password</b> at ${APP_URL}. Your devices and settings are exactly as you left them. 🙌`);
  } else {
    send(inv.tgChat,
      `🔄 <b>Renewal confirmed!</b> Your subscription is extended. 🎉\n\n` +
      `📦 <b>Plan:</b> ${esc(p.label)} · now active until <b>${until}</b> ✅\n\n` +
      `Sign in with your existing username and password at ${APP_URL}. Same account, more time. 🙌`);
  }
}

// Free 3-day trial: one full-featured account per Telegram user (and per phone number),
// ever. No payment. Phone verification is required by default (set TRIAL_REQUIRE_PHONE=false
// to skip it). Sharing the number is Telegram-verified, so it can't be faked, and one
// number = one trial forever — a fresh Telegram account alone can't farm trials.
const REQUIRE_TRIAL_PHONE = process.env.TRIAL_REQUIRE_PHONE === 'true'; // default OFF — we use device-side guards instead of phone sharing
function alreadyHasAccountMsg(chat, r) {
  if (r.phoneUsed) return send(chat, '📱 This phone number has already used a free trial.\n\nEach number gets one trial. Tap <b>Get Started</b> to choose a plan and get going. 🚀', mainMenuKeyboard());
  if (r.trialUsed && !r.username) return send(chat, '🎁 You have already used your free trial.\n\nTo keep using HatchConnect, tap <b>Get Started</b> and choose a plan — your login stays the same. 🚀', mainMenuKeyboard());
  const u2 = r.subExpires ? new Date(r.subExpires).toISOString().slice(0, 10) : '';
  return send(chat, `✅ You already have a HatchConnect account (<code>${esc(r.username)}</code>)${u2 ? ` · active until <b>${u2}</b>` : ''}.\n\nThe free trial is one per customer. Tap <b>Get Started</b> to add a paid plan — time is added on top, same login. 🚀`, mainMenuKeyboard());
}
// Typed /trial (or "free trial"): the menu button does the real work in one tap, so
// here we just check eligibility and point them at it (no phone = provision directly).
function startTrial(chat, from) {
  if (db.hasUsedTrial(from.id)) {
    const acct = db.accountByTg(from.id);
    return alreadyHasAccountMsg(chat, acct ? { username: acct.username, subExpires: acct.subExpires } : { trialUsed: true });
  }
  if (!REQUIRE_TRIAL_PHONE) return finishTrial(chat, from, '');
  return send(chat,
    `🎁 <b>Free ${db.trialDays()}-day trial</b> — full access, no payment.\n\nTap <b>🎁 Free 3-Day Trial</b> below to begin. It verifies your number in one tap (one-time, no calls or texts) and your trial starts instantly. 👇`,
    mainMenuKeyboard());
}
// Step 2: they shared their contact. Provision the trial and DM the login + guide.
function finishTrial(chat, from, phone) {
  const r = db.provisionTrial(from.id, chat, phone);
  if (r.already) return alreadyHasAccountMsg(chat, r);
  const days = db.trialDays();
  const until = new Date(r.subExpires).toISOString().slice(0, 10);
  if (process.env.OWNER_TG_CHAT) send(process.env.OWNER_TG_CHAT, `🎁 <b>New free trial</b>\n👤 User: ${fromHandle(from)}\nAccount: <code>${esc(r.username)}</code> · ends ${until}`);
  const creds1 =
    `🎁 <b>Your ${days}-day free trial is ready!</b> Full access, no payment. 🚀\n\n` +
    `🔗 <b>Dashboard:</b> ${APP_URL}\n👤 <b>Username:</b> <code>${esc(r.username)}</code>\n🔑 <b>Password:</b> <code>${esc(r.password)}</code>\n\n` +
    `⏳ <b>Trial ends:</b> ${until} — every feature is unlocked until then.\n\n` +
    `A quick start guide is coming in the next message 👇`;
  const guide = setupGuide(`💚 Enjoying it? Tap <b>Get Started</b> before <b>${until}</b> to pick a plan and keep everything — your devices and login stay exactly as they are.`);
  send(chat, creds1).then(() => send(chat, guide, mainMenuKeyboard()));
}

// Renewal reminders: DM every 2h during the last 3 days BEFORE expiry, then once a
// day AFTER it expires (until they renew). Throttled by each account's remindedAt.
const REMIND_WINDOW = 3 * 86400000, REMIND_BEFORE = 2 * 60 * 60 * 1000, REMIND_AFTER = 24 * 60 * 60 * 1000;
function remindSweep() {
  try {
    const now = Date.now();
    for (const s of db.subscriberReminders()) {
      const expired = now >= s.subExpires;
      const interval = expired ? REMIND_AFTER : REMIND_BEFORE;
      if (!expired && (s.subExpires - now) > REMIND_WINDOW) continue; // >3 days out: nothing yet
      if (s.remindedAt && (now - s.remindedAt) < interval) continue;
      const P = db.plans()[s.plan];
      const isTrial = s.plan === 'trial';
      const tag = isTrial ? ' (free trial)' : (P ? (' (' + esc(P.label) + ')') : '');
      if (expired) {
        send(s.tgChat, isTrial
          ? `⛔ <b>Your free trial has ended</b>\nYour HatchConnect access is paused. Tap <b>Get Started</b> to pick a plan and carry on — your login and devices stay exactly as they are. 🔓`
          : `⛔ <b>Subscription expired</b>\nYour HatchConnect access${tag} is paused. Renew to regain access — tap <b>Get Started</b>. Your login stays the same. 🔓`, mainMenuKeyboard());
      } else {
        const d = s.daysLeft;
        const when = d <= 0 ? '<b>today</b>' : ('in <b>' + d + ' day' + (d === 1 ? '' : 's') + '</b>');
        send(s.tgChat, isTrial
          ? `⏳ <b>Your free trial ends ${when}</b>\nTap <b>Get Started</b> to choose a plan and keep everything — your devices and login stay the same. 🚀`
          : `⏳ <b>Renewal reminder</b>\nYour HatchConnect subscription${tag} expires ${when}.\n\nRenew now to keep your access — tap <b>Get Started</b>. 🚀`, mainMenuKeyboard());
      }
      db.setReminded(s.id, now);
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
  setTimeout(remindSweep, 20000); setInterval(remindSweep, 30 * 60 * 1000); // renewal reminders (checks every 30m; sends every 2h pre-expiry, daily after)
  console.log('[bot] Telegram bot started (long-polling); watching USDT payments every 45s');
}

module.exports = { start };
