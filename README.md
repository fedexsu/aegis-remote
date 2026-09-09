# HatchConnect — Open-Source Remote Support Tool

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-blue)](https://github.com/fedexsu/aegis-remote)

> **Created by [Cheyenne Smith](https://github.com/fedexsu)** &nbsp;·&nbsp; ftechworld5@gmail.com

---

HatchConnect is a **self-hosted, unattended remote desktop and support tool** for Windows. It lets you remotely view and control machines you own or manage, with no third-party servers — you run everything.

It works through NAT and firewalls with no port-forwarding required. Both the agent (on the remote PC) and the console (your browser) connect outward to a relay server over WebSocket.

---

## Features

- **Live screen streaming** — JPEG over WebSocket with adaptive quality, WebRTC for low-latency P2P when available
- **Full keyboard & mouse control** — native Win32 `SendInput` via a tiny C# helper; no npm native modules
- **Unattended access** — agent auto-starts at login, auto-reconnects; runs as a Windows service (SYSTEM) for lock-screen access
- **File transfer** — chunked upload/download, drag-and-drop onto the live screen
- **Remote terminal** — PowerShell shell in the browser
- **Deploy software** — push an installer (.exe or .msi) and run it silently on the remote
- **Clipboard sync** — text and images in both directions
- **System monitor** — CPU, RAM, disk, process list, kill processes
- **Hardware inventory** — full spec sheet via WMI
- **Privacy screen** — blanks the remote monitor (local person sees black; capture still works)
- **Multi-monitor** — switch between screens mid-session
- **Wake-on-LAN** — wake sleeping peers on the same network
- **Auto-update** — relay serves a JS bundle; agents update themselves without reinstall
- **Uninstall protection** — operator can lock a device so it can't be removed without their approval
- **Consent banner** — red "session active" overlay on the remote, always visible

## Architecture

```
server/
  relay.js            WebSocket relay + HTTP API + static console host
  db.js               JSON-file database (accounts, devices, sessions)
  bot.js              Telegram bot (device alerts, subscription management)
  payments.js         USDT TRC-20 payment verification
  public/
    app.html          Technician console UI
    app.js            Console logic (WebRTC, op channel, device list)

agent/
  main.js             Electron main process (capture, IPC, self-update)
  preload.js          Context-isolated IPC bridge
  capture.js          Screen capture, WebRTC, JPEG streaming, input relay
  index.html          Agent window (config UI + capture canvas)
  injector/
    Injector.cs       Win32 SendInput + secure-desktop helper (compiled at runtime)
  blanker/
    Blanker.cs        Privacy-screen helper (WDA_EXCLUDEFROMCAPTURE)
  runas/
    RunAsUser.cs      Launch apps as the logged-in user from SYSTEM context

landing/              Marketing landing pages
installer.nsi         Per-user NSIS installer (no UAC)
installer-service.nsi Elevated NSIS installer (installs as Windows service)
scripts/
  build-agent-bundle.js  Bundles agent JS for relay-served auto-update
```

## Self-hosting

### Prerequisites

- Node.js 18+
- Windows (agent only — relay runs anywhere Node runs)
- .NET Framework 4.x (ships with Windows — used to compile the C# helpers at runtime)

### Run locally (development)

```bash
git clone https://github.com/fedexsu/aegis-remote
cd aegis-remote
npm install

# Start the relay
set ADMIN_EMAIL=you@example.com
set ADMIN_PASS=yourpassword
npm run server
# → http://localhost:8443

# Start the agent (on the machine to control)
npm run agent
```

Open `http://localhost:8443` in your browser, log in, and you'll see the agent listed.

### Deploy the relay (production)

The relay is a single Node process. Any platform works (Railway, a VPS, etc.).

Required environment variables:

| Variable | Description |
|---|---|
| `ADMIN_EMAIL` | Console login email |
| `ADMIN_PASS` | Console login password |
| `TG_BOT_TOKEN` | Telegram bot token (optional — for alerts) |
| `USDT_ADDRESS` | Your USDT TRC-20 wallet (optional — for payments) |
| `TRONGRID_API_KEY` | TronGrid API key (optional — for payment verification) |

Put it behind a reverse proxy (Caddy, nginx) for TLS, then connect agents with `wss://your-domain.com`.

### Build the Windows agent installer

```bash
npm run build-injector    # compile injector.exe from source (once)
npm run build-agent       # package Electron app → release/Aegis/
# edit agent/config.default.json with your relay URL + key, then:
makensis installer.nsi    # → release/support.exe  (per-user, no UAC)
makensis installer-service.nsi  # → release/support-service.exe  (service/SYSTEM)
```

The installer bakes in your relay URL and key so the end user runs one file and is immediately online with no setup.

### Agent auto-update

When you push new agent code, run:

```bash
node scripts/build-agent-bundle.js
```

This writes `server/agent-bundle.json`. All online agents fetch it and hot-swap their JS without reinstalling.

## How the relay works

The relay is the only public-facing component. It never sees the screen or input — those go peer-to-peer over WebRTC when possible, and over the relay WebSocket as JPEG frames only as a fallback.

- Agents register with a `key` baked into their installer
- The console authenticates with an email/password
- Ops (terminal, files, clipboard, etc.) are routed by `reqId` through a small in-memory map and forwarded to the right agent WebSocket

## Contributing

Pull requests welcome. Open an issue first for large changes.

To build and test locally, you only need Node and the standard Windows toolchain (already present on any Windows machine with .NET Framework). No native npm modules, no node-gyp.

## License

[MIT](LICENSE) — Copyright (c) 2026 **Cheyenne Smith**
