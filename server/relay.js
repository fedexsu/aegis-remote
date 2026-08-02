'use strict';

// Aegis Remote — relay/signaling server.
// Both agents and the technician console connect OUTWARD to this server over
// WebSocket, so it works through NAT/firewalls with no port-forwarding (the
// ScreenConnect relay model). The server is a router: it forwards screen frames
// agent->console and input/chat console->agent based on attachment.
//
//   node server/relay.js
//
// Auth: a single shared access key (env AEGIS_KEY, default below). Agents and
// consoles must present it. This is an MVP — for production use per-agent keys
// + TLS (wss) behind a reverse proxy.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8443;
const ACCESS_KEY = process.env.AEGIS_KEY || 'change-me-aegis';
const PUBLIC = path.join(__dirname, 'public');

// ---- Static file server for the console UI ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/console.html';
  const file = path.join(PUBLIC, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- State ----
const agents = new Map();   // agentId -> { ws, name, consoleId, screen }
const consoles = new Map(); // consoleId -> { ws, agentId }
let seq = 1;

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function agentList() {
  return [...agents.entries()].map(([id, a]) => ({ id, name: a.name, busy: !!a.consoleId }));
}
function broadcastAgentList() {
  for (const c of consoles.values()) if (!c.agentId) send(c.ws, { type: 'agents', list: agentList() });
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.meta = { role: null, id: null };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ---- Registration / auth ----
    if (msg.type === 'register') {
      if (msg.key !== ACCESS_KEY) { send(ws, { type: 'denied', reason: 'bad key' }); return ws.close(); }

      if (msg.role === 'agent') {
        const id = msg.id || 'agent-' + seq++;
        ws.meta = { role: 'agent', id };
        agents.set(id, { ws, name: msg.name || id, consoleId: null, screen: msg.screen || null });
        send(ws, { type: 'registered', id });
        broadcastAgentList();
      } else if (msg.role === 'console') {
        const id = 'console-' + seq++;
        ws.meta = { role: 'console', id };
        consoles.set(id, { ws, agentId: null });
        send(ws, { type: 'registered', id });
        send(ws, { type: 'agents', list: agentList() });
      }
      return;
    }

    const { role, id } = ws.meta;
    if (!role) return;

    // ---- Console -> server ----
    if (role === 'console') {
      const c = consoles.get(id);
      if (!c) return;
      if (msg.type === 'list') { send(ws, { type: 'agents', list: agentList() }); return; }
      if (msg.type === 'attach') {
        const a = agents.get(msg.agentId);
        if (!a) { send(ws, { type: 'error', text: 'agent offline' }); return; }
        if (a.consoleId && a.consoleId !== id) { send(ws, { type: 'error', text: 'agent busy' }); return; }
        c.agentId = msg.agentId; a.consoleId = id;
        send(ws, { type: 'attached', agentId: msg.agentId, name: a.name, screen: a.screen });
        send(a.ws, { type: 'start' });
        broadcastAgentList();
        return;
      }
      if (msg.type === 'detach') {
        detachConsole(id);
        send(ws, { type: 'agents', list: agentList() });
        return;
      }
      // Forward input / chat / monitor-switch to the attached agent
      if (c.agentId && (msg.type === 'input' || msg.type === 'chat' || msg.type === 'monitor')) {
        const a = agents.get(c.agentId);
        if (a) send(a.ws, msg);
      }
      return;
    }

    // ---- Agent -> server ----
    if (role === 'agent') {
      const a = agents.get(id);
      if (!a) return;
      if (msg.type === 'screen') { a.screen = { w: msg.w, h: msg.h }; return; }
      if (!a.consoleId) return;
      const c = consoles.get(a.consoleId);
      if (!c) return;
      // Forward frames / chat / monitor-list to the attached console
      if (msg.type === 'frame' || msg.type === 'chat' || msg.type === 'screen' || msg.type === 'monitors') send(c.ws, msg);
      return;
    }
  });

  ws.on('close', () => {
    const { role, id } = ws.meta || {};
    if (role === 'agent') {
      const a = agents.get(id);
      if (a && a.consoleId) {
        const c = consoles.get(a.consoleId);
        if (c) { c.agentId = null; send(c.ws, { type: 'agentGone' }); }
      }
      agents.delete(id);
      broadcastAgentList();
    } else if (role === 'console') {
      detachConsole(id);
      consoles.delete(id);
    }
  });
});

function detachConsole(consoleId) {
  const c = consoles.get(consoleId);
  if (!c) return;
  if (c.agentId) {
    const a = agents.get(c.agentId);
    if (a) { a.consoleId = null; send(a.ws, { type: 'stop' }); }
    c.agentId = null;
  }
  broadcastAgentList();
}

server.listen(PORT, () => {
  console.log(`Aegis Remote relay listening on http://localhost:${PORT}`);
  console.log(`Console UI:  http://localhost:${PORT}/`);
  console.log(`Access key:  ${ACCESS_KEY}  (set env AEGIS_KEY to change)`);
});
