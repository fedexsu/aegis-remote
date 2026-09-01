// RunAsUser — launch a program on the interactive desktop AS THE LOGGED-IN USER,
// even when the caller is SYSTEM (our service-launched agent). Chromium can't render
// as SYSTEM, so a SYSTEM-launched browser starts (taskbar) but its window never
// shows. Grabbing the real user's token (WTSQueryUserToken) + CreateProcessAsUser
// onto winsta0\default runs it as the user, on the visible desktop.
//
//   RunAsUser.exe [--at <cx> <cy>] <exePath> [args...]
//
// With --at, after launching we find the app's new window and move it onto the
// monitor that contains the point (cx,cy) — used to open apps on whichever screen
// the technician is currently viewing (multi-monitor). Without it, the app opens
// wherever it likes. Exit 0 = launched; non-zero = reason on stderr.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
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
  // --- window placement ---
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hi, bool repaint);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFO mi);

  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; public POINT(int a, int b) { x = a; y = b; } }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  const uint MAXIMUM_ALLOWED = 0x02000000;
  const int SecurityImpersonation = 2, TokenPrimary = 1;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x0400, CREATE_NEW_PROCESS_GROUP = 0x00000200;
  const uint INVALID_SESSION = 0xFFFFFFFF;
  const int STARTF_USESHOWWINDOW = 0x00000001; const short SW_SHOWNORMAL = 1;
  const int SW_RESTORE = 9;
  const uint MONITOR_DEFAULTTONEAREST = 2;
  const uint GW_OWNER = 4;

  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOf(' ') < 0 && a.IndexOf('"') < 0) return a;
    return "\"" + a.Replace("\"", "\\\"") + "\"";
  }

  // Collect current top-level windows belonging to a process with the given exe
  // base-name (no extension), that are visible + titled + un-owned (real windows).
  static HashSet<IntPtr> WindowsFor(string procBase) {
    var set = new HashSet<IntPtr>();
    EnumWindows((h, l) => {
      try {
        if (!IsWindowVisible(h) || GetWindow(h, GW_OWNER) != IntPtr.Zero || GetWindowTextLength(h) == 0) return true;
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (pid == 0) return true;
        string n = null; try { n = Process.GetProcessById((int)pid).ProcessName; } catch { }
        if (n != null && string.Equals(n, procBase, StringComparison.OrdinalIgnoreCase)) set.Add(h);
      } catch { }
      return true;
    }, IntPtr.Zero);
    return set;
  }

  // After launch, wait for the app's NEW window and move it onto the monitor that
  // contains (cx,cy). Best-effort: if we don't find it in time, we just leave it.
  static void PlaceOnMonitor(string procBase, HashSet<IntPtr> before, int cx, int cy) {
    IntPtr target = IntPtr.Zero;
    for (int i = 0; i < 40 && target == IntPtr.Zero; i++) {          // up to ~8s
      System.Threading.Thread.Sleep(200);
      foreach (var h in WindowsFor(procBase)) { if (!before.Contains(h)) { target = h; break; } }
    }
    if (target == IntPtr.Zero) return;
    try {
      MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      IntPtr mon = MonitorFromPoint(new POINT(cx, cy), MONITOR_DEFAULTTONEAREST);
      if (mon == IntPtr.Zero || !GetMonitorInfo(mon, ref mi)) return;
      ShowWindow(target, SW_RESTORE);                                // un-minimize if needed
      RECT wr; if (!GetWindowRect(target, out wr)) return;
      int w = wr.Right - wr.Left, h2 = wr.Bottom - wr.Top;
      int wa = mi.rcWork.Right - mi.rcWork.Left, ha = mi.rcWork.Bottom - mi.rcWork.Top;
      if (w > wa) w = wa; if (h2 > ha) h2 = ha;                      // don't exceed the target screen
      int nx = mi.rcWork.Left + (wa - w) / 2, ny = mi.rcWork.Top + (ha - h2) / 2;
      MoveWindow(target, nx, ny, w, h2, true);
      SetForegroundWindow(target);
    } catch { }
  }

  static int Main(string[] args) {
    try { SetProcessDPIAware(); } catch { }
    int cx = 0, cy = 0; bool place = false; int a0 = 0;
    if (args.Length >= 3 && args[0] == "--at" && int.TryParse(args[1], out cx) && int.TryParse(args[2], out cy)) { place = true; a0 = 3; }
    if (args.Length <= a0) { Console.Error.WriteLine("usage: RunAsUser [--at cx cy] <exe> [args...]"); return 2; }
    string[] pa = new string[args.Length - a0];
    Array.Copy(args, a0, pa, 0, pa.Length);

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
      si.lpDesktop = "winsta0\\default";
      si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_SHOWNORMAL;
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < pa.Length; i++) { if (i > 0) sb.Append(' '); sb.Append(Quote(pa[i])); }
      string app = pa[0];
      string procBase = ""; try { procBase = Path.GetFileNameWithoutExtension(app); } catch { }
      HashSet<IntPtr> before = place ? WindowsFor(procBase) : null;   // snapshot BEFORE launch
      string dir = null; try { dir = Path.GetDirectoryName(app); if (dir == "") dir = null; } catch { }
      PROCESS_INFORMATION pi;
      bool ok = CreateProcessAsUser(dup, app, sb.ToString(), IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP, env, dir, ref si, out pi);
      if (!ok) { Console.Error.WriteLine("Could not start it as the user (" + Marshal.GetLastWin32Error() + ")."); return 6; }
      Console.Out.WriteLine("sid=" + sid + " pid=" + pi.dwProcessId);
      CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
      if (place && procBase.Length > 0) PlaceOnMonitor(procBase, before, cx, cy);
      return 0;
    } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    finally { if (env != IntPtr.Zero) DestroyEnvironmentBlock(env); if (dup != IntPtr.Zero) CloseHandle(dup); if (userTok != IntPtr.Zero) CloseHandle(userTok); }
  }
}
