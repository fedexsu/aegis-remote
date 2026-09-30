# HatchConnect for macOS

Un-signed, per-user, no-password install for now. Signing (Apple Developer, $99/yr) is a future upgrade.

## The customer install flow

```
1. Customer downloads support-<key>.command from your dashboard
2. Right-click → Open → Open  (Gatekeeper's one-time prompt)
3. Terminal opens for ~15 seconds — script installs, no admin password
4. Onboarding window appears asking to grant 2 permissions
5. Customer clicks each Grant button, Touch-ID / password once per toggle
6. Device shows online on your console
```

## What ships in each phase

| Phase | Feature | Status |
|---|---|---|
| 1 | Skeleton — agent appears on console (register + heartbeat) | **Ready to build** |
| 2 | Screen viewing via `ScreenCaptureKit` (JPEG frames) | Design only |
| 3 | Input control via `CGEventPost` (mouse/keys) | Design only |
| 4 | File transfer + clipboard | Design only |
| 5 | Persistence (LaunchAgent + boot survival) | Ready in Phase 1 |
| 6 | Login-screen capture (needs LaunchDaemon → admin path) | Later, paid tier |
| 7 | Auto-update (JS-only bundle swap, preserves TCC grants) | Later |

## Non-goals (be honest with customers)

- **No login-screen access** on the free (per-user) tier. LaunchAgent runs only in the user's session. Add LaunchDaemon Tier B later for enterprise.
- **No silent Screen Recording grant.** macOS TCC forbids it — same for TeamViewer / AnyDesk / Zoom on Ventura+. Customer taps Touch ID (or types password) once per permission. **No workaround exists.**
- **No blank screen (privacy overlay).** Not planned for MVP — different macOS UX pattern; may add later.
- **No Ctrl+Alt+Del equivalent.** Not applicable on macOS.

## Reuses from the current Windows stack

- **Relay** (`server/relay.js`) — WebSocket protocol is platform-agnostic. One tiny addition: `/dl/<key>?platform=mac` redirects to Backblaze for the `.command` script. See `mac/PROTOCOL.md` for message details.
- **Console** (`server/public/app.js`) — shows a macOS icon when `meta.platform === 'mac'`; hides Windows-only buttons (blank, injector status, CAD).
- **Enrollment / keys / offline debounce / dedup** — unchanged. The Mac agent uses the same `m-<hashed-uuid>` device id format.

## What's new in this directory

```
mac/
├── README.md               ← this file
├── PROTOCOL.md             ← WebSocket message spec + Mac-specific ops
├── installer.command       ← template served by relay's /launch endpoint
├── build-mac.sh            ← run this on a Mac to build the .app + tarball
├── agent/
│   ├── main.js             ← minimal Electron main (Phase 1: register + heartbeat only)
│   ├── preload.js          ← IPC bridge (shared with future renderer)
│   ├── config.default.json ← default config (relay URL + empty key)
│   ├── Info.plist          ← .app bundle metadata
│   └── icon.icns           ← app icon (to be added — build-mac.sh generates from png)
└── LaunchAgent.plist       ← ~/Library/LaunchAgents/app.hatchconnect.support.plist template
```

## Building — must run on a Mac

Windows can't produce macOS `.app` bundles. Everything here is source ready for a Mac:

```bash
# On a Mac (macOS 12.3+, Xcode Command Line Tools installed):
git clone https://github.com/fedexsu/aegis-remote.git
cd aegis-remote/mac
./build-mac.sh
# Produces:
#   build/HatchConnect.app.tgz       ← upload to Backblaze
#   build/installer.command          ← generic bootstrap (upload as launcher.command)
```

## Deployment mirrors the Windows path

- **Backblaze bucket `supportttt`** gains two new objects:
  - `HatchConnect.app.tgz` — the un-signed app tarball
  - `launcher.command` — generic bootstrap script (reads its own filename for the key)
- **Env var on Railway** (relay): `B2_MAC_APP_OBJECT=HatchConnect.app.tgz`, `B2_COMMAND_OBJECT=launcher.command`
- Console's Build Installer modal gains a **macOS** radio option → same UX as `?platform=service`.

## The one un-signed gotcha

macOS's TCC (permissions) database identifies **un-signed apps by binary hash**. So if we ever ship an update that changes the underlying Electron binary, TCC treats it as a new app and re-prompts the customer for Screen Recording + Accessibility.

**Design mitigation**: auto-updates swap only `Contents/Resources/app/*.js` — never `Contents/MacOS/HatchConnect`. Same JS-only hot-swap the Windows agent already uses (`agent/main.js:checkForUpdate`). Zero re-prompts across updates as long as we hold to that discipline.
