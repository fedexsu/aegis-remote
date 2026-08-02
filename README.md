# 🛡️ Aegis Remote

A ScreenConnect-style **unattended remote-support tool** with **full remote
control**. Three parts:

- **Relay server** (Node) — both the agent and the console connect *outward* to
  it over WebSocket, so it works through NAT/firewalls with no port-forwarding.
- **Agent** (Electron) — runs on the machine you want to reach. Captures the
  screen and streams it; injects real mouse/keyboard input.
- **Console** (web page) — lists your online devices, shows the live screen, and
  gives you full control + chat.

Input injection uses a tiny **C# helper** (`injector.exe`) that calls Win32
`SendInput`, compiled with the `csc.exe` already on every Windows — so there is
**no npm native module / node-gyp** to fight with.

> **Consent & scope.** This is an *overt* remote-support tool: the agent shows a
> visible window and a red "Someone is controlling this screen" banner during a
> session. Use it only on machines you own or where the person has agreed. It has
> no hidden/stealth mode by design.

---

## Quick start (all on one machine, for testing)

```bash
npm install
npm run build-injector      # compiles agent/injector/injector.exe (once)
```

Open **three** things:

1. **Relay** (pick your own key):
   ```bash
   set AEGIS_KEY=my-secret-key && npm run server
   ```
   (PowerShell: `$env:AEGIS_KEY='my-secret-key'; npm run server`)

2. **Agent** (on the machine to be controlled):
   ```bash
   npm run agent
   ```
   Enter the relay URL (`ws://<relay-host>:8443`), the access key, a device
   name, and click **Connect**. It then auto-reconnects and lives in the tray.

3. **Console**: open `http://<relay-host>:8443/` in any browser (including Aegis!).
   Enter the same access key, **Connect**, click your device, and you're in.

## Using it across the internet

The relay is the only piece that needs to be reachable. Run it on a VPS/host and
point agents + console at it. **Use TLS** — put the relay behind a reverse proxy
(Caddy/nginx) terminating HTTPS, and connect with `wss://` + `https://`. Replace
the single shared key with per-agent keys for real deployments.

## The installer (recommended distribution)

`release/AegisRemoteSetup.exe` is a one-click installer (built with Inno Setup):
the customer runs it and it **installs, auto-starts hidden to the tray, runs on
every login, and auto-connects** to the relay baked into the build — no setup by
them. **Uninstalling** (Add/Remove Programs) stops the agent and removes
everything, i.e. **revokes remote access**. It's a **per-user install (no admin
/ UAC)**.

Build it:
```bash
npm run build-injector          # once
npm run build-agent             # refresh release/AegisRemoteAgent/
# edit agent/config.default.json to point at YOUR relay + key, rebuild agent, then:
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss   # -> release/AegisRemoteSetup.exe
```

The relay URL + access key are baked in via `agent/config.default.json` (bundled
into the app; the user's saved settings still override it).

> **⚠️ Code signing.** The installer is **unsigned**, so Windows SmartScreen
> shows “Windows protected your PC” (bypass: *More info → Run anyway*), and
> machines with **Smart App Control** on may block it outright. For real
> distribution you need a **code-signing certificate** (OV ~$100–300/yr; EV for
> instant trust). Sign `AegisRemoteAgent.exe` and `AegisRemoteSetup.exe`.

## Manual install (portable, no installer)

Build a standalone agent that needs no Node/Electron on the target:

```bash
npm run build-injector   # once
npm run build-agent      # -> release/AegisRemoteAgent/AegisRemoteAgent.exe
```

On the target machine:
1. Copy the whole **`AegisRemoteAgent`** folder over (or the zip) and run `AegisRemoteAgent.exe`.
2. Enter the relay URL + access key + a device name, click **Go online**.
3. Tick **“Start automatically when I sign in to Windows.”**

From then on the agent launches hidden to the tray at every login, reconnects to
the relay on its own (with backoff), and is reachable from the console anytime —
true unattended access. A single-instance lock prevents duplicates.

> **Why login-start, not a Windows service?** Screen capture and input injection
> must run in the interactive desktop session — a session-0 service can’t see or
> control the user’s screen. Auto-starting at login is the correct model for a
> remote-control agent.

## What works today (MVP)

| Feature | Status |
| --- | --- |
| Unattended agent (auto-connect, tray, **auto-start at login**) | ✅ |
| Resilient reconnect with backoff · single-instance lock | ✅ |
| Standalone packaged agent .exe (injector bundled) | ✅ |
| Live screen streaming (JPEG over relay) | ✅ |
| Full mouse control (move/click/drag/right/scroll) | ✅ |
| Full keyboard control (text, shortcuts, modifiers) | ✅ |
| Multiple devices listed in console | ✅ |
| Text chat both directions | ✅ |
| Consent banner on the controlled machine | ✅ |

## Not yet built (natural next steps)

- File transfer, clipboard sync
- Multi-monitor selection (currently the primary screen)
- WebRTC media path (lower latency / bandwidth than JPEG-over-WS)
- Per-agent auth, session audit log, recording
- macOS / Linux agents (injector is Windows-only today)

## Layout

```
server/
  relay.js               relay + static console host
  public/console.*       technician console (web UI)
agent/
  main.js                Electron main: screen source, injector, tray
  preload.js             secure bridge
  index.html capture.js  agent UI + capture/stream/input engine
  injector/Injector.cs   Win32 SendInput helper (compiled to injector.exe)
  injector/build-injector.js
test-console.js          headless test: verifies frames stream
test-input.js            headless test: verifies remote cursor control
```
