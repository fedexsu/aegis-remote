// RunAsUser — launch a program on the interactive desktop AS THE LOGGED-IN USER,
// even when the caller is SYSTEM (our service-launched agent). This is why browsers
// finally show up: Chromium can't render as SYSTEM, so a SYSTEM-launched browser
// starts (appears in the taskbar) but its window never comes up. Grabbing the real
// user's token (WTSQueryUserToken) and CreateProcessAsUser onto winsta0\default runs
// it as the user, on the visible desktop, exactly like the user launched it.
//
//   RunAsUser.exe <exePath> [args...]
//
// Exit 0 = launched. Non-zero = reason on stderr (e.g. nobody logged in).
// Compiled on the target by the agent with the .NET Framework csc.exe.
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;

class RunAsUser {
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool DuplicateTokenEx(IntPtr existing, uint access, ref SECURITY_ATTRIBUTES sa, int impLevel, int tokenType, out IntPtr newToken);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
  [DllImport("userenv.dll", SetLastError = true)] static extern bool DestroyEnvironmentBlock(IntPtr env);

  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  const uint MAXIMUM_ALLOWED = 0x02000000;
  const int SecurityImpersonation = 2, TokenPrimary = 1;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x0400, CREATE_NEW_PROCESS_GROUP = 0x00000200;
  const uint INVALID_SESSION = 0xFFFFFFFF;
  const int STARTF_USESHOWWINDOW = 0x00000001; const short SW_SHOWNORMAL = 1;

  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOf(' ') < 0 && a.IndexOf('"') < 0) return a;
    return "\"" + a.Replace("\"", "\\\"") + "\"";
  }

  static int Main(string[] args) {
    if (args.Length == 0) { Console.Error.WriteLine("usage: RunAsUser <exe> [args...]"); return 2; }
    IntPtr userTok = IntPtr.Zero, dup = IntPtr.Zero, env = IntPtr.Zero;
    try {
      uint sid = WTSGetActiveConsoleSessionId();
      if (sid == INVALID_SESSION) { Console.Error.WriteLine("No active desktop session."); return 3; }
      if (!WTSQueryUserToken(sid, out userTok)) { Console.Error.WriteLine("No one is signed in on this PC (nothing to show a window on)."); return 4; }
      SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
      if (!DuplicateTokenEx(userTok, MAXIMUM_ALLOWED, ref sa, SecurityImpersonation, TokenPrimary, out dup)) { Console.Error.WriteLine("token duplicate failed " + Marshal.GetLastWin32Error()); return 5; }
      CreateEnvironmentBlock(out env, dup, false);
      STARTUPINFO si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      si.lpDesktop = "winsta0\\default";           // the visible interactive desktop
      si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_SHOWNORMAL;
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < args.Length; i++) { if (i > 0) sb.Append(' '); sb.Append(Quote(args[i])); }
      string app = args[0];
      string dir = null; try { dir = Path.GetDirectoryName(app); if (dir == "") dir = null; } catch { }
      PROCESS_INFORMATION pi;
      bool ok = CreateProcessAsUser(dup, app, sb.ToString(), IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP, env, dir, ref si, out pi);
      if (!ok) { Console.Error.WriteLine("Could not start it as the user (" + Marshal.GetLastWin32Error() + ")."); return 6; }
      CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
      return 0;
    } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    finally { if (env != IntPtr.Zero) DestroyEnvironmentBlock(env); if (dup != IntPtr.Zero) CloseHandle(dup); if (userTok != IntPtr.Zero) CloseHandle(userTok); }
  }
}
