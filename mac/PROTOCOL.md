# macOS agent — WebSocket protocol against the existing relay

The Mac agent speaks the **same wire protocol** as the Windows agent (see `server/relay.js`). It sets `meta.platform = 'mac'` on register so the console can toggle Mac-only UI.

## Register (agent → relay)

```json
{
  "type": "register",
  "role": "agent",
  "id":   "m-<24 hex chars>",
  "name": "Sarah's MacBook Air",
  "key":  "<enrollment key from installer filename>",
  "screen": { "w": 2560, "h": 1600 },
  "meta": {
    "platform":  "mac",
    "os":        "macOS 15.1",
    "host":      "Sarahs-MacBook-Air.local",
    "user":      "sarah",
    "cpu":       "Apple M3 Pro",
    "arch":      "arm64",
    "macVer":    "15.1",
    "tier":      "user"           // "user" (LaunchAgent) or "system" (LaunchDaemon, later)
  }
}
```

**Device id computation** (matches Windows salt convention):

```
id = "m-" + sha256("aegis:" + IOPlatformUUID).hex().slice(0, 24)
```

`IOPlatformUUID` is read once at first launch via `ioreg -d2 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ {print $4}'`, then cached in `~/Library/Application Support/HatchConnect/device-id`.

Same **`m-*` prefix** as Windows, so relay dedup + register logic in `server/relay.js` needs zero changes.

## Presence heartbeat (agent → relay, every 25 s)

```json
{ "type": "presence", "idle": 12, "state": "active" }   // "active" | "idle" | "locked"
```

- `active`: mouse/keyboard event in the last 60 s (`CGEventSourceSecondsSinceLastEventType`).
- `idle`: no input for 60 s.
- `locked`: screen is locked (`CGSSessionScreenIsLocked` via private API — falls back to checking loginwindow).

## Console → agent ops (subset — Phase 1 handles none of these yet)

Phase 1 acknowledges all ops with `{ok: false, error: "not implemented"}` so the console shows a clear message instead of hanging.

Full op list (parity with Windows where sensible):

| Op | Phase | Mac implementation |
|---|---|---|
| `input` (mouse/key) | 3 | `CGEventPost` via `HCInjector` |
| `blank` | — | Not planned; grey out on console when `platform === 'mac'` |
| `lockinput` | — | Not planned; grey out on console |
| `cad` (Ctrl-Alt-Del) | — | N/A on Mac |
| `fs-list` / `fs-get` / `fs-put` | 4 | Direct FS; may prompt for Full Disk Access on ~/Documents |
| `term-open` | 4 | `spawn('/bin/zsh', ['-l'])` |
| `proc-list` | 4 | `spawn('ps', ['axo', 'pid,pcpu,comm'])` |
| `launch` (open app/url) | 4 | `spawn('open', [target])` |
| `clip-get` / `clip-set` | 4 | `NSPasteboard.general` via Swift helper |
| `sys-mon-start` | 4 | `top` parse or `IOKit` if we want CPU/GPU/RAM |
| `wake` (WoL) | 4 | Reuse Windows-style UDP magic packet — Node built-in `dgram` |

## Relay → agent messages (Phase 1 already handled by shared JS)

- `denied` (reason) — same as Windows; agent shows "waiting to enroll" state, retries every 30 s.
- `registered` (id) — success confirmation.
- `start` / `stop` (streaming) — Phase 2 hooks these to `ScreenCaptureKit`.
- `input` (event) — Phase 3 hooks these to `CGEventPost`.
- `op` (with reqId + payload) — Phase 4 hooks each op.

## Frame format (Phase 2, no change from Windows)

- Binary WebSocket frames = JPEG bytes.
- Console's `drawBinaryFrame` renders them identically.
- Adaptive scale/quality logic (`agent/capture.js:adaptTune`) ports as-is because it works on Blob sizes, not platform APIs.

## Console-side flags for `platform === 'mac'`

Add to `server/public/app.js` in `renderDeviceCard`:

```js
// Hide Windows-only actions when the device is a Mac
if (d.meta?.platform === 'mac') {
  cardEl.querySelector('.act-blank')?.setAttribute('disabled', '');
  cardEl.querySelector('.act-lockinput')?.setAttribute('disabled', '');
  cardEl.querySelector('.act-cad')?.setAttribute('disabled', '');
  // Show the Mac icon instead of the Windows one
  cardEl.querySelector('.dev-os-ico')?.classList.add('is-mac');
}
```

Icon: existing `.dev-os-ico` gets an SVG variant added to `app.css` (Apple silhouette, not the Windows flag).
