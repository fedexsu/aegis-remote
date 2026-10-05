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
  protected override void OnStop() { running = false; }
  protected override void OnShutdown() { running = false; }

  static string InstallDir() { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); }

  // Keep the agent alive in whichever session the user is on.
  static void Loop() {
    while (running) {
      try {
        uint sid = WTSGetActiveConsoleSessionId();
        if (sid != INVALID_SESSION && sid != 0 && !AgentInSession(sid))
          LaunchInSession(sid);
      } catch { }
      Thread.Sleep(4000);
    }
  }

  static bool AgentInSession(uint sid) {
    foreach (Process p in Process.GetProcessesByName("support")) {
      try { if ((uint)p.SessionId == sid) return true; } catch { }
    }
    return false;
  }

  static void LaunchInSession(uint sessionId) {
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
      }
    } catch { }
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
