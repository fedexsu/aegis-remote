'use strict';
// Headless test: acts as a technician console, attaches to the first agent,
// and verifies screen frames arrive. Exits after receiving a few frames.
const WebSocket = require('ws');

const URL = process.env.RELAY || 'ws://localhost:8443';
const KEY = process.env.AEGIS_KEY || 'change-me-aegis';
const ws = new WebSocket(URL);
let frames = 0;
let attached = false;

const done = (code, msg) => { console.log(msg); try { ws.close(); } catch {} process.exit(code); };
setTimeout(() => done(frames > 0 ? 0 : 2, `\nTIMEOUT — frames received: ${frames}`), 12000);

ws.on('open', () => {
  console.log('connected to relay, registering as console…');
  ws.send(JSON.stringify({ type: 'register', role: 'console', key: KEY }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'registered') { console.log('registered:', msg.id); }
  else if (msg.type === 'agents') {
    console.log('agents online:', JSON.stringify(msg.list));
    if (!attached && msg.list.length) {
      attached = true;
      console.log('attaching to:', msg.list[0].id);
      ws.send(JSON.stringify({ type: 'attach', agentId: msg.list[0].id }));
    } else if (!msg.list.length) {
      console.log('(no agents yet — waiting…)');
    }
  }
  else if (msg.type === 'attached') { console.log('ATTACHED. screen =', JSON.stringify(msg.screen)); }
  else if (msg.type === 'frame') {
    frames++;
    if (frames === 1) console.log(`FIRST FRAME: ${msg.w}x${msg.h}, ${Math.round(msg.data.length/1024)} KB (base64)`);
    if (frames >= 5) done(0, `\n✅ SUCCESS — received ${frames} frames. Screen streaming works end-to-end.`);
  }
  else if (msg.type === 'denied') { done(3, 'DENIED: ' + msg.reason); }
  else if (msg.type === 'error') { console.log('error:', msg.text); }
});
ws.on('error', (e) => done(4, 'WS error: ' + e.message));
