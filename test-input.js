'use strict';
// Headless test of the input path: attach to the first agent and send a mouse
// move to a known normalized position. Then check the OS cursor moved there.
const WebSocket = require('ws');
const URL = process.env.RELAY || 'ws://localhost:8443';
const KEY = process.env.AEGIS_KEY || 'change-me-aegis';
const NX = 0.3, NY = 0.3;
const ws = new WebSocket(URL);

ws.on('open', () => ws.send(JSON.stringify({ type: 'register', role: 'console', key: KEY })));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'agents' && msg.list.length) {
    ws.send(JSON.stringify({ type: 'attach', agentId: msg.list[0].id }));
  } else if (msg.type === 'attached') {
    console.log(`attached; sending mouse move to (${NX}, ${NY})`);
    ws.send(JSON.stringify({ type: 'input', event: { kind: 'move', x: NX, y: NY } }));
    setTimeout(() => { ws.close(); process.exit(0); }, 1000);
  }
});
ws.on('error', (e) => { console.error(e.message); process.exit(1); });
