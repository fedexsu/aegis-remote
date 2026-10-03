// OffKeepSystemAwake.exe — one-shot toolbox companion to KeepSystemAwake.exe.
//
// Signals the running KeepSystemAwake instance to clean-exit, which restores
// the device's power settings (hardware power button, Start-menu Sleep/Shutdown
// visibility, idle timeouts) to the originals it saved before engaging.
//
// Deliberately a SEPARATE exe so an operator can one-click it from the Toolbox
// without typing arguments. Internally it just opens the shared named stop
// event and sets it. If no instance is running, it silently returns 0 — nothing
// to turn off is a no-op success.
//
// Compile with csc.exe (same pattern as the other helpers in this repo):
//   csc.exe /nologo /optimize+ /target:exe /out:offkeepsystemawake.exe OffKeepSystemAwake.cs
using System;
using System.Diagnostics;
using System.Threading;

public class OffKeepSystemAwake {
  // Must stay in sync with KeepSystemAwake.cs's StopEventName.
  const string StopEventName = "Global\\HatchConnect.KeepAwake.Stop";

  // One-shot companion that stops KeepSystemAwake however it can. Returns 0
  // unconditionally so the Toolbox doesn't show a "failed" badge when the only
  // issue is "nothing was running" or a cross-elevation ACL quirk. In order of
  // preference:
  //   1) Open the Global\ stop event and signal it — KSA sees the event in its
  //      WaitHandle, exits cleanly, and reverts every setting it changed.
  //   2) If that throws (event doesn't exist, or we lack access because KSA
  //      created it elevated and we're not), hard-kill every "keepsystemawake"
  //      process by name. State in %ProgramData%\HatchConnect\keepawake.state
  //      is left behind; running KeepSystemAwake.exe /restore cleans it up.
  public static int Main() {
    bool signaled = false;
    try {
      var ev = EventWaitHandle.OpenExisting(StopEventName);
      ev.Set();
      signaled = true;
    } catch { /* event missing or access denied — fall through to kill */ }
    if (signaled) {
      // Give KSA a short beat to notice the event and run its cleanup path.
      try { Thread.Sleep(1200); } catch { }
    }
    try {
      foreach (var p in Process.GetProcessesByName("keepsystemawake")) {
        try { if (!p.HasExited) p.Kill(); } catch { }
      }
    } catch { }
    return 0;
  }
}
