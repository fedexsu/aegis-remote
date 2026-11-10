// Support Agent — Windows SERVICE (runs as LocalSystem).
//
// A service runs in session 0 and can't draw/inject on the user's desktop, so this
// service's job is to LAUNCH the agent (support.exe) INTO the active interactive
// session, running as SYSTEM. That gives the agent full elevation (silent admin
// deploys, real Ctrl+Alt+Del, Safe-Mode reboot, UAC handling) while still being on
// the user's desktop for capture + input.
//
// Technique: duplicate this service's own SYSTEM token, retarget it to the active
// console session, and CreateProcessAsUser — the classic "PsExec -s -i".
//
// Compiled with the .NET Framework csc.exe (see build-service.js). Runs as:
//   AegisService.exe            -> service control dispatcher (started by SCM)
//   AegisService.exe /install   -> register + start the service (needs admin)
//   AegisService.exe /uninstall -> stop + remove the service (needs admin)
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;

public class AegisService : ServiceBase {
  // Legacy default service name — used when the installer doesn't pass /svc:.
  // Dual-install mode (installer-service.nsi) overrides this per copy via
  // "AegisService.exe /install /svc:<Name>-AgentSvc" so each install registers
  // its own uniquely-named service and can be stopped/started independently.
  const string DEFAULT_SVC_NAME = "SupportAgentSvc";

  // ---- Win32 ----
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool DuplicateTokenEx(IntPtr existing, uint access, ref SECURITY_ATTRIBUTES sa, int impLevel, int tokenType, out IntPtr newToken);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SetTokenInformation(IntPtr token, int cls, ref uint val, int len);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
  [DllImport("userenv.dll", SetLastError = true)] static extern bool DestroyEnvironmentBlock(IntPtr env);

  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  const uint TOKEN_DUPLICATE = 0x0002, TOKEN_QUERY = 0x0008, TOKEN_ASSIGN_PRIMARY = 0x0001, TOKEN_ADJUST_DEFAULT = 0x0080, TOKEN_ADJUST_SESSIONID = 0x0100;
  const uint MAXIMUM_ALLOWED = 0x02000000;
  const int SecurityIdentification = 2, TokenPrimary = 1;
  const int TokenSessionId = 12;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x0400, CREATE_NO_WINDOW = 0x08000000;
  const uint INVALID_SESSION = 0xFFFFFFFF;

  static volatile bool running = false;
  Thread worker;

  // Instance service name — resolved at process start from argv so Main() and
  // the ServiceBase can both see it. The service control manager calls Main()
  // with no args when it starts us; in that path we fall back to the default.
  static string SVC_NAME = DEFAULT_SVC_NAME;
  public AegisService() { ServiceName = SVC_NAME; CanShutdown = true; }
  protected override void OnStart(string[] args) { running = true; worker = new Thread(Loop) { IsBackground = true }; worker.Start(); }
  protected override void OnStop() {
    running = false;
    // Previously OnStop returned immediately with running=false, but the
    // worker thread could still be inside Loop() mid-LaunchInSession — the
    // SCM thought we'd stopped while CreateProcessAsUser ran on, producing
    // a zombie agent after an uninstall or restart. Join bounds the wait.
    try { if (worker != null) worker.Join(5000); } catch {}
  }
  protected override void OnShutdown() { running = false; }

  static string InstallDir() { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); }

  // Agent process name — derived from the actual exe sitting in the install
  // folder so a future rename doesn't leave the service respawning a binary
  // that no longer exists. Falls back to the historical "support" if the
  // folder is somehow empty (service survives the rename window).
  static string AgentProcessName() {
    try {
      foreach (string candidate in new string[] { "support.exe" }) {
        if (File.Exists(Path.Combine(InstallDir(), candidate)))
          return Path.GetFileNameWithoutExtension(candidate);
      }
    } catch {}
    return "support";
  }

  // Crash-loop detector. Previously a bad bundle that crashed on startup
  // triggered 15 respawns/min (4s unconditional sleep) — AV flagged the
  // pattern + Railway stdout filled with [enroll] denied lines. If we see
  // 5 exits in under 2 min, back off to 60s for a cycle.
  static System.Collections.Generic.Queue<long> _exitTimestamps = new System.Collections.Generic.Queue<long>();
  static int _backoffUntilTick = 0;

  // Keep the agent alive in whichever session the user is on. Two guards
  // now: (1) crash-loop backoff, (2) liveness heartbeat — if the agent's
  // mtime on %TEMP%\aegis-heartbeat is stale beyond 120s we kill the hung
  // process so the next tick respawns a clean one.
  static void Loop() {
    while (running) {
      try {
        if (Environment.TickCount < _backoffUntilTick) { Thread.Sleep(4000); continue; }
        uint sid = WTSGetActiveConsoleSessionId();
        if (sid != INVALID_SESSION && sid != 0) {
          if (!AgentInSession(sid)) {
            // Respawn. Record the exit timestamp for crash-loop detection.
            long now = DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
            _exitTimestamps.Enqueue(now);
            while (_exitTimestamps.Count > 10) _exitTimestamps.Dequeue();
            int recent = 0; foreach (long t in _exitTimestamps) if (now - t < 120000) recent++;
            if (recent >= 5) {
              _backoffUntilTick = Environment.TickCount + 60000;
              try { EventLog.WriteEntry("AegisService", "Crash-loop detected (" + recent + " exits in 2min) — backing off 60s", EventLogEntryType.Warning); } catch {}
            } else {
              LaunchInSession(sid);
            }
          } else {
            // Liveness check: agent process exists but may be frozen. The
            // agent writes %TEMP%\aegis-heartbeat (actually the active user's
            // TEMP, since the agent runs in that session) every ~5s. If it's
            // stale, the agent's main loop is stuck — kill and respawn.
            CheckHeartbeat(sid);
          }
        }
      } catch { }
      Thread.Sleep(4000);
    }
  }

  static void CheckHeartbeat(uint sid) {
    try {
      // Service runs as SYSTEM so %TEMP% is C:\Windows\Temp. The agent runs
      // in the user's session so its os.tmpdir() is the user's. Probe both.
      string[] candidates = new string[] {
        Path.Combine(Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows", "Temp", "aegis-heartbeat"),
      };
      foreach (Process p in Process.GetProcessesByName(AgentProcessName())) {
        try {
          if ((uint)p.SessionId != sid) continue;
          // Best-effort: the user's TEMP is harder to find from SYSTEM; the
          // SystemRoot\Temp path works when the agent runs AS SYSTEM (which
          // this service launches it to be). Agent writes to os.tmpdir()
          // which under SYSTEM resolves to SystemRoot\Temp.
          long newest = 0;
          foreach (string hb in candidates) {
            try { if (File.Exists(hb)) { long m = File.GetLastWriteTimeUtc(hb).Ticks; if (m > newest) newest = m; } } catch {}
          }
          if (newest == 0) return; // no heartbeat yet — agent too new or just starting
          TimeSpan age = DateTime.UtcNow - new DateTime(newest);
          if (age.TotalSeconds > 120) {
            try { EventLog.WriteEntry("AegisService", "Agent heartbeat stale " + (int)age.TotalSeconds + "s — force-killing pid=" + p.Id, EventLogEntryType.Warning); } catch {}
            try { p.Kill(); } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  static bool AgentInSession(uint sid) {
    foreach (Process p in Process.GetProcessesByName(AgentProcessName())) {
      try { if ((uint)p.SessionId == sid) return true; } catch { }
    }
    return false;
  }

  static void LaunchInSession(uint sessionId) {
    // Clear any heartbeat file left over from the previous agent run.
    // Without this, a stale file (age > 120s) from the last session causes
    // CheckHeartbeat to kill the freshly-started agent before it has a chance
    // to write its first heartbeat, looping the device offline immediately
    // after every reinstall or update-restart.
    try { File.Delete(Path.Combine(Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows", "Temp", "aegis-heartbeat")); } catch {}
    IntPtr hTok = IntPtr.Zero, hDup = IntPtr.Zero, env = IntPtr.Zero;
    try {
      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID, out hTok)) return;
      SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
      if (!DuplicateTokenEx(hTok, MAXIMUM_ALLOWED, ref sa, SecurityIdentification, TokenPrimary, out hDup)) return;
      uint sess = sessionId;
      SetTokenInformation(hDup, TokenSessionId, ref sess, sizeof(uint)); // retarget SYSTEM token to the active session
      STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.lpDesktop = "winsta0\\default";
      CreateEnvironmentBlock(out env, hDup, false);
      string exe = Path.Combine(InstallDir(), "support.exe");
      string cmd = "\"" + exe + "\" --startup --no-sandbox"; // --no-sandbox: Chromium can't sandbox when run as SYSTEM
      PROCESS_INFORMATION pi;
      if (CreateProcessAsUser(hDup, null, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env, InstallDir(), ref si, out pi)) {
        CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
      } else {
        int err = Marshal.GetLastWin32Error();
        try { EventLog.WriteEntry("AegisService", "CreateProcessAsUser failed err=" + err + " session=" + sessionId, EventLogEntryType.Error); } catch {}
      }
    } catch (Exception ex) {
      // Silently swallowing every exception here meant zero diagnostics when
      // launch failed (wrong token access, Winstation lockdown, session-0
      // isolation). Write to the Application EventLog so operators can see why.
      try { EventLog.WriteEntry("AegisService", "LaunchInSession: " + ex.ToString(), EventLogEntryType.Error); } catch {}
    }
    finally { if (env != IntPtr.Zero) DestroyEnvironmentBlock(env); if (hDup != IntPtr.Zero) CloseHandle(hDup); if (hTok != IntPtr.Zero) CloseHandle(hTok); }
  }

  static void Sc(string a) { try { Process p = Process.Start(new ProcessStartInfo("sc.exe", a) { UseShellExecute = false, CreateNoWindow = true }); p.WaitForExit(); } catch { } }

  static void Main(string[] args) {
    // Honor /svc:<name> on EITHER /install, /uninstall, or a bare service start.
    // Dual-install mode calls: AegisService.exe /install /svc:<Name>-AgentSvc
    // The service control manager, when it later starts this exe via sc.exe's
    // auto-start, invokes it with argv = [] — SVC_NAME stays at the default,
    // but ServiceBase.Run reads the actual service name from the SCM dispatch
    // anyway, so this doesn't matter for the running-service path. The /svc:
    // flag matters for the install/uninstall path where we talk to sc.exe.
    foreach (string a in args) {
      if (a == null) continue;
      string la = a.ToLowerInvariant();
      if (la.StartsWith("/svc:")) {
        string n = a.Substring(5).Trim();
        if (n.Length > 0) SVC_NAME = n;
      }
    }
    if (args.Length > 0 && args[0].ToLowerInvariant() == "/install") {
      string exe = Assembly.GetExecutingAssembly().Location;
      Sc("create " + SVC_NAME + " binPath= \"" + exe + "\" start= auto DisplayName= \"" + SVC_NAME + "\"");
      Sc("description " + SVC_NAME + " \"Keeps the Support remote agent running.\"");
      Sc("failure " + SVC_NAME + " reset= 0 actions= restart/5000/restart/5000/restart/5000");
      Sc("start " + SVC_NAME);
      return;
    }
    if (args.Length > 0 && args[0].ToLowerInvariant() == "/uninstall") {
      Sc("stop " + SVC_NAME);
      Sc("delete " + SVC_NAME);
      return;
    }
    ServiceBase.Run(new AegisService());
  }
}
