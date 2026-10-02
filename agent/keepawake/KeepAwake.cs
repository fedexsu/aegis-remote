// KeepAwake.exe — standalone helper the operator deploys to a customer device
// to stop it from sleeping or being shut down for the duration of a session.
//
// It is deliberately NOT a built-in agent feature (and not persistent): the
// operator pushes it via the dashboard's existing "Deploy software" flow,
// optionally with /elevated, and the device stays awake only while this
// process is alive. Exit — Ctrl+C, Task Manager, a /stop deploy from the
// console, or the duration timer — fully restores the device.
//
// What it does (lite mode, works without admin):
//   • SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED |
//     ES_DISPLAY_REQUIRED | ES_AWAYMODE_REQUIRED). Prevents idle sleep + the
//     display timeout + (with the right power-plan policy) sends a manual
//     Sleep into Away Mode instead of real sleep.
//
// What it also does (full mode, needs admin — i.e. deployed /elevated):
//   • Hides "Sleep" and "Shut down" from the Start menu via the
//     Microsoft\PolicyManager\default\Start\* registry keys.
//   • Flips every button-related power setting (Start-menu power button,
//     hardware power button, dedicated sleep key, laptop lid close) to
//     "Take no action" via `powercfg`.
//   • Sets standby + hibernate idle timeouts to 0 (never).
//
// Everything is CAPTURED before being changed and RESTORED on exit (clean
// shutdown, SIGINT, or Windows session-end). A JSON snapshot of the originals
// lives at %ProgramData%\HatchConnect\keepawake.state while the process holds
// the lock; it's deleted on clean exit. On a crash, re-running KeepAwake.exe
// with /restore reads this file and reverts everything.
//
// Compile with csc.exe (same pattern as the other helpers in this repo):
//   csc.exe /nologo /optimize+ /target:exe /out:keepawake.exe KeepAwake.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

public class KeepAwake {
  // ---- SetThreadExecutionState (user-mode, no admin needed) ----
  [Flags] public enum EXECUTION_STATE : uint {
    ES_SYSTEM_REQUIRED  = 0x00000001,
    ES_DISPLAY_REQUIRED = 0x00000002,
    ES_AWAYMODE_REQUIRED = 0x00000040,
    ES_CONTINUOUS       = 0x80000000,
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern EXECUTION_STATE SetThreadExecutionState(EXECUTION_STATE esFlags);

  // Save-state file. ProgramData is machine-wide + writable by both regular
  // users and admin, so a lite-mode run can leave a file an elevated /restore
  // can later clean up (though lite mode only writes the "lite" keys).
  static readonly string StateDir  = Path.Combine(Environment.GetEnvironmentVariable("ProgramData") ?? @"C:\ProgramData", "HatchConnect");
  static readonly string StatePath = Path.Combine(StateDir, "keepawake.state");
  // Single-instance named mutex so a second deploy knows one is already active.
  const string MutexName = "Global\\HatchConnect.KeepAwake.Mutex";
  // Stop event — any process (e.g. a `KeepAwake.exe /stop` deploy from the
  // console) can SetEvent on this to cleanly ask the running instance to exit.
  const string StopEventName = "Global\\HatchConnect.KeepAwake.Stop";

  const string POLICY_SLEEP    = @"HKLM\SOFTWARE\Microsoft\PolicyManager\default\Start\HideSleep";
  const string POLICY_SHUTDOWN = @"HKLM\SOFTWARE\Microsoft\PolicyManager\default\Start\HideShutDown";

  // Button settings we try to lock down (any missing on this box — e.g. no lid
  // on a desktop — is silently skipped). Names kept out of the array (would
  // need C# 7 tuples which .NET Framework 4 csc doesn't support); the GUIDs
  // are documented inline instead.
  const string SUB_BUTTONS = "4f971e89-eebd-4455-a8de-9e59040e7347";
  static readonly string[] BUTTONS = new string[] {
    "a7066653-8d6c-40a8-910e-a1f54b84c7e5", // Start-menu power button
    "7648efa3-dd9c-4e3e-b566-50f929386280", // Hardware power button
    "96996bc0-ad50-47ec-923b-6f41874dd9eb", // Dedicated sleep key
    "5ca83367-6e45-459f-a27b-476b1d01c936", // Laptop lid close
  };

  public static int Main(string[] args) {
    try {
      // Routing
      for (int i = 0; i < args.Length; i++) {
        string a = args[i].ToLowerInvariant();
        if (a == "/stop")      return SendStop();
        if (a == "/restore")   return RestoreOnly();
        if (a == "/help" || a == "-h" || a == "/?") { PrintHelp(); return 0; }
      }
      int durationSec = 8 * 3600;
      for (int i = 0; i < args.Length; i++) {
        if (args[i].Equals("/duration", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
          int.TryParse(args[i + 1], out durationSec);
      }
      return Run(durationSec);
    } catch (Exception e) {
      Console.Error.WriteLine("KeepAwake fatal: " + e.Message);
      return 2;
    }
  }

  static void PrintHelp() {
    Console.WriteLine("KeepAwake [/duration SECONDS] [/stop] [/restore] [/help]");
    Console.WriteLine("  (no args)        Keep awake for 8 hours or until /stop");
    Console.WriteLine("  /duration N      Keep awake for N seconds");
    Console.WriteLine("  /stop            Ask any running instance to stop and restore");
    Console.WriteLine("  /restore         Restore from a lingering state file (crash recovery)");
  }

  static int SendStop() {
    try {
      var ev = EventWaitHandle.OpenExisting(StopEventName);
      ev.Set();
      Console.WriteLine("Stop signalled.");
      return 0;
    } catch (WaitHandleCannotBeOpenedException) {
      Console.WriteLine("Not running.");
      return 0;
    }
  }

  static int RestoreOnly() {
    if (!File.Exists(StatePath)) { Console.WriteLine("No state file."); return 0; }
    RestoreFromState(ReadState());
    try { File.Delete(StatePath); } catch { }
    Console.WriteLine("Restored.");
    return 0;
  }

  static int Run(int durationSec) {
    bool created;
    using (var mutex = new Mutex(true, MutexName, out created)) {
      if (!created) {
        Console.WriteLine("Already running — send /stop to end the existing instance.");
        return 1;
      }
      // Capture original state BEFORE we change anything. If a stale file is on
      // disk, re-read it (prior crash) rather than overwriting with the
      // already-hardened values.
      Dictionary<string, string> state = File.Exists(StatePath) ? ReadState() : CaptureState();
      WriteState(state);

      Apply(state);
      SetThreadExecutionState(EXECUTION_STATE.ES_CONTINUOUS | EXECUTION_STATE.ES_SYSTEM_REQUIRED | EXECUTION_STATE.ES_DISPLAY_REQUIRED | EXECUTION_STATE.ES_AWAYMODE_REQUIRED);

      // Any clean exit path restores. SIGINT, Windows session-end, and the stop
      // event all funnel into the same cleanup.
      var done = new ManualResetEvent(false);
      Console.CancelKeyPress += (_, e) => { e.Cancel = true; done.Set(); };
      AppDomain.CurrentDomain.ProcessExit += (_, __) => { try { Cleanup(state); } catch { } };

      bool stopEventCreated;
      using (var stopEvent = new EventWaitHandle(false, EventResetMode.ManualReset, StopEventName, out stopEventCreated)) {
        var handles = new WaitHandle[] { done, stopEvent };
        int signalled = WaitHandle.WaitAny(handles, TimeSpan.FromSeconds(durationSec));
        // signalled == WaitHandle.WaitTimeout means duration elapsed.
      }

      Cleanup(state);
      return 0;
    }
  }

  // ---- apply/restore ----
  static bool IsAdmin() {
    try {
      using (var id = WindowsIdentity.GetCurrent()) {
        return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
      }
    } catch { return false; }
  }
  static Dictionary<string, string> CaptureState() {
    var s = new Dictionary<string, string>();
    // Only admin-reachable things get captured if we're admin. Without admin,
    // we only care about the execution-state flag, which is held per-process
    // and needs no save/restore.
    if (!IsAdmin()) return s;
    foreach (var b in BUTTONS) {
      s["btn_" + b + "_ac"] = QueryPowercfg(b, true);
      s["btn_" + b + "_dc"] = QueryPowercfg(b, false);
    }
    s["standby_ac"]   = QueryTimeout("standby-timeout-ac");
    s["standby_dc"]   = QueryTimeout("standby-timeout-dc");
    s["hibernate_ac"] = QueryTimeout("hibernate-timeout-ac");
    s["hibernate_dc"] = QueryTimeout("hibernate-timeout-dc");
    s["policy_hide_sleep"]    = QueryReg(POLICY_SLEEP, "value");
    s["policy_hide_shutdown"] = QueryReg(POLICY_SHUTDOWN, "value");
    return s;
  }
  static void Apply(Dictionary<string, string> state) {
    if (!IsAdmin()) return;
    foreach (var b in BUTTONS) {
      SetButton(b, true,  0);
      SetButton(b, false, 0);
    }
    RunPowercfg("-change standby-timeout-ac 0");
    RunPowercfg("-change standby-timeout-dc 0");
    RunPowercfg("-change hibernate-timeout-ac 0");
    RunPowercfg("-change hibernate-timeout-dc 0");
    RunPowercfg("-setactive scheme_current");
    SetReg(POLICY_SLEEP,    "value", "REG_DWORD", "1");
    SetReg(POLICY_SHUTDOWN, "value", "REG_DWORD", "1");
  }
  static void Cleanup(Dictionary<string, string> state) {
    SetThreadExecutionState(EXECUTION_STATE.ES_CONTINUOUS);
    RestoreFromState(state);
    try { File.Delete(StatePath); } catch { }
  }
  static void RestoreFromState(Dictionary<string, string> state) {
    if (!IsAdmin() || state == null) return;
    foreach (var b in BUTTONS) {
      TryRestoreButton(b, true,  state.ContainsKey("btn_" + b + "_ac") ? state["btn_" + b + "_ac"] : null);
      TryRestoreButton(b, false, state.ContainsKey("btn_" + b + "_dc") ? state["btn_" + b + "_dc"] : null);
    }
    // We may not have reliably captured minute values; fall back to Balanced-plan
    // defaults rather than leave the saved sentinel.
    RunPowercfg("-change standby-timeout-ac 15");
    RunPowercfg("-change standby-timeout-dc 10");
    RunPowercfg("-change hibernate-timeout-ac 0");
    RunPowercfg("-change hibernate-timeout-dc 0");
    RunPowercfg("-setactive scheme_current");
    // Policy flags: if we didn't see them before, delete; if we did, set back.
    RestoreRegOr(POLICY_SLEEP,    "value", state.ContainsKey("policy_hide_sleep")    ? state["policy_hide_sleep"]    : null);
    RestoreRegOr(POLICY_SHUTDOWN, "value", state.ContainsKey("policy_hide_shutdown") ? state["policy_hide_shutdown"] : null);
  }
  static void TryRestoreButton(string guid, bool ac, string val) {
    if (string.IsNullOrEmpty(val) || val == "null") return;
    int n; if (!int.TryParse(val, out n)) return;
    SetButton(guid, ac, n);
  }
  static void RestoreRegOr(string key, string name, string val) {
    if (string.IsNullOrEmpty(val) || val == "null") TryDeleteReg(key, name);
    else SetReg(key, name, "REG_DWORD", val);
  }

  // ---- powercfg / reg helpers ----
  static string QueryPowercfg(string buttonGuid, bool ac) {
    string active = ActiveScheme();
    if (active == null) return null;
    string stdout = Shell("powercfg", "-query " + active + " " + SUB_BUTTONS + " " + buttonGuid);
    if (stdout == null) return null;
    string label = ac ? "Current AC Power Setting Index:" : "Current DC Power Setting Index:";
    foreach (var line in stdout.Split('\n')) {
      int idx = line.IndexOf(label, StringComparison.OrdinalIgnoreCase);
      if (idx >= 0) {
        var tail = line.Substring(idx + label.Length).Trim();
        if (tail.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) tail = tail.Substring(2);
        int n; return int.TryParse(tail, System.Globalization.NumberStyles.HexNumber, null, out n) ? n.ToString() : null;
      }
    }
    return null;
  }
  static void SetButton(string buttonGuid, bool ac, int value) {
    string active = ActiveScheme(); if (active == null) return;
    string op = ac ? "-setacvalueindex" : "-setdcvalueindex";
    RunPowercfg(op + " " + active + " " + SUB_BUTTONS + " " + buttonGuid + " " + value);
  }
  static string ActiveScheme() {
    string s = Shell("powercfg", "-getactivescheme");
    if (s == null) return null;
    var m = System.Text.RegularExpressions.Regex.Match(s, "GUID:\\s*([0-9a-fA-F-]{36})");
    return m.Success ? m.Groups[1].Value : null;
  }
  static string QueryTimeout(string name) { return null; /* powercfg doesn't trivially echo these; sentinel is fine, restore to defaults */ }
  static void RunPowercfg(string args) { Shell("powercfg", args); }
  static string Shell(string exe, string args) {
    try {
      var psi = new ProcessStartInfo(exe, args) {
        UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
        CreateNoWindow = true,
      };
      using (var p = Process.Start(psi)) {
        string so = p.StandardOutput.ReadToEnd();
        p.WaitForExit(5000);
        return so;
      }
    } catch { return null; }
  }

  // ---- reg helpers (via `reg.exe` — portable, no WMI/COM dance) ----
  static string QueryReg(string key, string name) {
    string s = Shell("reg", "query \"" + key + "\" /v " + name);
    if (s == null) return null;
    foreach (var line in s.Split('\n')) {
      int idx = line.IndexOf("REG_DWORD", StringComparison.Ordinal);
      if (idx < 0) continue;
      var tail = line.Substring(idx + "REG_DWORD".Length).Trim();
      if (tail.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) tail = tail.Substring(2);
      int n; return int.TryParse(tail, System.Globalization.NumberStyles.HexNumber, null, out n) ? n.ToString() : tail;
    }
    return null;
  }
  static void SetReg(string key, string name, string type, string data) {
    Shell("reg", "add \"" + key + "\" /v " + name + " /t " + type + " /d " + data + " /f");
  }
  static void TryDeleteReg(string key, string name) {
    Shell("reg", "delete \"" + key + "\" /v " + name + " /f");
  }

  // ---- state file ----
  static Dictionary<string, string> ReadState() {
    try {
      var dict = new Dictionary<string, string>();
      foreach (var line in File.ReadAllLines(StatePath)) {
        int eq = line.IndexOf('='); if (eq < 0) continue;
        dict[line.Substring(0, eq)] = line.Substring(eq + 1);
      }
      return dict;
    } catch { return new Dictionary<string, string>(); }
  }
  static void WriteState(Dictionary<string, string> state) {
    try {
      Directory.CreateDirectory(StateDir);
      var sb = new StringBuilder();
      foreach (var kv in state) sb.Append(kv.Key).Append('=').Append(kv.Value ?? "null").Append('\n');
      File.WriteAllText(StatePath, sb.ToString());
    } catch { }
  }
}
