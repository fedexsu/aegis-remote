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
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

public class OffKeepSystemAwake {
  // Must stay in sync with KeepSystemAwake.cs's StopEventName.
  const string StopEventName = "Global\\HatchConnect.KeepAwake.Stop";
  // Policy keys KSA sets in Full (admin) mode. Mirror of the constants in
  // KeepSystemAwake.cs; if you add one there, add it here too.
  static readonly string[] POLICY_KEYS = new string[] {
    @"HKLM\SOFTWARE\Microsoft\PolicyManager\default\Start\HideSleep",
    @"HKLM\SOFTWARE\Microsoft\PolicyManager\default\Start\HideShutDown",
    @"HKLM\SOFTWARE\Microsoft\PolicyManager\default\Start\HideLock",
    @"HKLM\SOFTWARE\Microsoft\PolicyManager\default\Start\HideSignOut",
  };
  const string DISABLE_LOCK_SUB = @"Software\Microsoft\Windows\CurrentVersion\Policies\System";
  static readonly string[] BUTTONS = new string[] {
    "a7066653-8d6c-40a8-910e-a1f54b84c7e5", // Start-menu power button
    "7648efa3-dd9c-4e3e-b566-50f929386280", // Hardware power button
    "96996bc0-ad50-47ec-923b-6f41874dd9eb", // Dedicated sleep key
    "5ca83367-6e45-459f-a27b-476b1d01c936", // Laptop lid close
  };
  const string SUB_BUTTONS = "4f971e89-eebd-4455-a8de-9e59040e7347";

  // One-shot companion that stops KeepSystemAwake and reverts whatever it
  // changed. Always returns 0 — a "nothing was running" run is a no-op success.
  // Flow:
  //   1) Signal the Global\ stop event. KSA's main thread wakes up and runs
  //      its OWN Cleanup, which is the most accurate restore because it has
  //      the captured original values.
  //   2) Wait up to 8 seconds for KSA to exit naturally.
  //   3) If still alive, hard-kill every "keepsystemawake" process by name.
  //   4) Regardless of path 1-3, run a FORCED restore of all the keys/powercfg
  //      settings KSA ever writes. Belt-and-braces: if the kill in step 3 cut
  //      KSA off mid-cleanup, this still leaves Start-menu Sleep/Shut down/Lock
  //      visible, Win+L working, and the power buttons back to a sane default.
  //      Based on known defaults rather than the state file (which may be gone
  //      or corrupted), so a few niche settings get Windows defaults instead of
  //      the exact prior values — acceptable price for a reliable "undo".
  public static int Main() {
    try { EventWaitHandle.OpenExisting(StopEventName).Set(); } catch { /* no event — fine */ }
    // Give KSA up to ~8 seconds to notice the event and exit cleanly.
    for (int i = 0; i < 16; i++) {
      try { if (Process.GetProcessesByName("keepsystemawake").Length == 0) break; } catch { }
      try { Thread.Sleep(500); } catch { }
    }
    // Still running? Hard-kill. Possible if signal was ACL-blocked, or if KSA
    // got stuck somewhere other than its WaitAny.
    try {
      foreach (var p in Process.GetProcessesByName("keepsystemawake")) {
        try { if (!p.HasExited) p.Kill(); } catch { }
      }
    } catch { }
    // Forced restore. Each step is independent + swallows errors so a single
    // failure doesn't abort the rest.
    foreach (var k in POLICY_KEYS) Run("reg", "delete \"" + k + "\" /v value /f");
    foreach (var sid in EnumUserHives()) {
      Run("reg", "delete \"HKU\\" + sid + "\\" + DISABLE_LOCK_SUB + "\" /v DisableLockWorkstation /f");
    }
    // Buttons back to "Sleep" (power-plan default). Can't recover the EXACT
    // prior value without the state file, so default is the safer pick.
    foreach (var guid in BUTTONS) {
      Run("powercfg", "-setacvalueindex scheme_current " + SUB_BUTTONS + " " + guid + " 1");
      Run("powercfg", "-setdcvalueindex scheme_current " + SUB_BUTTONS + " " + guid + " 1");
    }
    // Idle timeouts back to Balanced defaults (15/10 min standby, 0 hibernate).
    Run("powercfg", "-change standby-timeout-ac 15");
    Run("powercfg", "-change standby-timeout-dc 10");
    Run("powercfg", "-change hibernate-timeout-ac 0");
    Run("powercfg", "-change hibernate-timeout-dc 0");
    Run("powercfg", "-setactive scheme_current");
    // State file is no longer meaningful once we've forced defaults.
    try { File.Delete(@"C:\ProgramData\HatchConnect\keepawake.state"); } catch { }
    return 0;
  }

  // Enumerate loaded user hives under HKEY_USERS. Keep real user SIDs + .DEFAULT
  // for new logins. Service-account hives (_Classes suffix, S-1-5-18/19/20) are
  // excluded — DisableLockWorkstation on those would be meaningless.
  static IEnumerable<string> EnumUserHives() {
    List<string> hives = new List<string>();
    hives.Add(".DEFAULT");
    try {
      using (var hku = Microsoft.Win32.Registry.Users) {
        foreach (var name in hku.GetSubKeyNames()) {
          if (name.StartsWith("S-1-5-21-") && !name.EndsWith("_Classes")) hives.Add(name);
        }
      }
    } catch { }
    return hives;
  }

  // Fire-and-forget external command. We never surface output or exit code to
  // the Toolbox — the Toolbox only reports OUR exit code, which is always 0.
  static void Run(string file, string args) {
    try {
      var psi = new ProcessStartInfo(file, args);
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      psi.RedirectStandardOutput = true;
      psi.RedirectStandardError = true;
      using (var p = Process.Start(psi)) {
        p.StandardOutput.ReadToEnd();
        p.StandardError.ReadToEnd();
        p.WaitForExit(5000);
      }
    } catch { }
  }
}
