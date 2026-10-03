# KeepSystemAwake.exe — operator helper tool

Standalone utility that prevents a customer device from sleeping, shutting down, or being turned off by the hardware power button. Designed for an operator to **deploy on demand** through the dashboard's existing **Deploy Software** flow, not as a built-in agent feature.

Why standalone (and not another agent button): zero persistent system changes. When the exe exits — on `/stop`, Task Manager, duration timer, or Windows session end — everything is restored. If it ever crashes, re-running with `/restore` cleans up.

## What it does

| Mode | Needs admin? | Effect |
|---|---|---|
| **Lite** (always) | No | `SetThreadExecutionState` with `ES_CONTINUOUS \| ES_SYSTEM_REQUIRED \| ES_DISPLAY_REQUIRED \| ES_AWAYMODE_REQUIRED` → blocks idle sleep + display timeout. Manual Sleep → Away Mode (keeps running) IF the "allow away mode" power policy is enabled. |
| **Full** (if admin) | Yes | Lite + hides Sleep / Shut down from Start menu (`HideSleep`, `HideShutDown` policy keys) + sets Start-menu power button, hardware power button, dedicated sleep key, and lid-close to "Take no action" + sets standby/hibernate idle timeouts to 0. |

Verified end-to-end on this box (lite mode): `powercfg /requests` showed KeepSystemAwake in `DISPLAY`, `SYSTEM`, and `AWAYMODE` simultaneously — the three Windows power-request types that together block idle sleep and route a manual Sleep button into Away Mode.

## Usage

```
KeepSystemAwake.exe                      # start — hold the lock for 8 hours
KeepSystemAwake.exe /duration 7200       # custom duration (seconds)
KeepSystemAwake.exe /stop                # ask a running instance to exit cleanly
KeepSystemAwake.exe /restore             # crash recovery — restore from a lingering state file
KeepSystemAwake.exe /help
```

Single-instance via a named mutex. Second launch exits with "Already running — send /stop".

## Deployment flow (what the operator does)

1. **Download** `KeepSystemAwake.exe` from the dashboard: `https://console.hatchconnect.app/tools/keepsystemawake.exe`.
2. **Add to Deploy Software library** (same place every custom .exe lives).
3. **Push to a device** when a session is in progress and you need to make sure it doesn't drop:
   - For the lite case (any install, no admin): deploy un-elevated. SetThreadExecutionState alone covers idle sleep + display timeout.
   - For the full case (elevated-install agents only — agent runs as SYSTEM so the deploy inherits admin): tick **Run elevated** in the deploy dialog. Full lockdown kicks in.
4. **End it** when the session wraps:
   - Deploy `KeepSystemAwake.exe /stop`, OR
   - Kill from Task Manager (`ProcessExit` handler still restores), OR
   - Just wait for the duration to expire.

## State file + crash recovery

While running, a snapshot of the pre-hardening state (button actions, timeout values, policy flags) lives at `%ProgramData%\HatchConnect\keepawake.state`. Clean exit deletes it. A crash leaves it; next operator can run `KeepSystemAwake.exe /restore` to revert the device without starting a new session.

## Building

```
node agent/keepawake/build-keepsystemawake.js
```

Uses the in-box .NET Framework 4 `csc.exe`. Zero external dependencies. Output: `agent/keepawake/keepsystemawake.exe` (~14 KB).

## Why not a built-in agent toggle instead

Was considered and prototyped — rejected because:
- A built-in toggle has to survive agent crash / auto-update / reinstall, which means persistent on-disk state the agent has to clean up in multiple places (uninstaller, startup reconciler, etc).
- An operator-deployed helper is intentional, visible, and self-contained; the state the hardening applies to the device lives for exactly the lifetime of a single OS process.
- Low-privilege agents can still deploy it with `/elevated` on devices where the agent itself is the elevated service.

The in-agent **Keep Awake** toggle (right-click menu + session Essentials panel) stays as-is — it covers the common idle-sleep case for all installs. KeepSystemAwake.exe is the next step up when the operator needs manual-sleep / shutdown / power-button protection too.
