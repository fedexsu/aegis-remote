// PrivateDesktop.cs -> pdesk.exe
//
// "Backstage GUI": creates a second desktop inside the ACTIVE USER's session
// (not Session 0's service WinSta0 — that's the whole trick), spawns a shell
// there, BitBlts it at N fps and streams JPEG frames to stdout, and reads input
// commands on stdin that it injects into that desktop. The end user is on the
// "Default" desktop and sees absolutely nothing — the private desktop isn't
// switched in via SwitchDesktop.
//
// Protocol
//   stdout : repeating [4-byte BE length][jpeg bytes]  (same framing as sdcap)
//   stderr : human-readable status / error lines, agent surfaces to the console
//   stdin  : one command per line
//              M <x> <y>                    mouse move
//              C <btn> <down>               mouse button; btn ∈ {L,R,M}, down ∈ {0,1}
//              S <dx> <dy>                  mouse wheel
//              K <vk> <down>                virtual-key
//              T <char-codepoint>           synthesise a unicode text char
//              L <cmdline>                  launch another process on this desktop
//              Q                            quit
//
// Session-crossing strategy
// -------------------------
// SYSTEM-service agents run in Session 0; the active user is in Session 1+.
// CreateDesktop lands in the CALLER's window station, so if we just call it we
// get a desktop in the service winsta that no shell will ever draw on and
// BitBlt will return a black canvas. Fix:
//   1. WTSGetActiveConsoleSessionId  → the user's session id
//   2. WTSQueryUserToken            → their primary token
//   3. ImpersonateLoggedOnUser      → thread now runs as the user
//   4. OpenWindowStation("WinSta0") → resolves to the user session's winsta
//   5. SetProcessWindowStation      → our process now lives there
//   6. CreateDesktop / SpawnShell   → in the user's winsta, correctly
// Per-user agents (already running IN the user's session) skip impersonation —
// their winsta is already right.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class PrivateDesktop {
  // ---- window-station / desktop plumbing ----
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateDesktop(string lpszDesktop, IntPtr lpszDevice, IntPtr pDevmode, uint dwFlags, uint dwDesiredAccess, IntPtr lpsa);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenWindowStation(string name, bool fInherit, uint access);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern bool SetProcessWindowStation(IntPtr hWinSta);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
  static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, byte[] pvInfo, int nLength, out int lenNeeded);
  // Window enumeration + PrintWindow — the only way to capture a desktop that
  // isn't the input desktop. GetDC(IntPtr.Zero) + BitBlt would return the
  // PHYSICAL screen (the user's visible desktop), not our hidden one.
  delegate bool EnumDesktopProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumDesktopProc lpfn, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT lpRect);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint uCmd);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  const uint PW_RENDERFULLCONTENT = 0x00000002;
  // ---- WTS session plumbing ----
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQueryUserToken(uint sessionId, out IntPtr phToken);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr hExistingToken, uint dwDesiredAccess, IntPtr lpTokenAttributes, int ImpersonationLevel, int TokenType, out IntPtr phNewToken);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool ImpersonateLoggedOnUser(IntPtr hToken);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool RevertToSelf();
  [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);
  [DllImport("userenv.dll", SetLastError = true)] static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  // ---- GDI capture ----
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
  // ---- CreateProcess / CreateProcessAsUser ----
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string lpApp, string lpCmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr env, string curDir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUser(IntPtr hToken, string lpApp, string lpCmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr env, string curDir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  // ---- SendInput ----
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public short wVk, wScan; public int dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public int type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, [MarshalAs(UnmanagedType.LPArray)] INPUT[] inp, int cb);
  [DllImport("user32.dll")] static extern void SetProcessDPIAware();

  const uint DESKTOP_RIGHTS = 0x1FF;
  const uint WINSTA_ALL = 0x37F;
  const int SRCCOPY = 0x00CC0020, CAPTUREBLT = 0x40000000;
  const int SM_CXSCREEN = 0, SM_CYSCREEN = 1;
  const int INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const int MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const int MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const int MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const int MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_ABSOLUTE = 0x8000;
  const int KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
  const int MAX_TOKEN_ALL = 0xF01FF; // TOKEN_ALL_ACCESS
  const int SecurityImpersonation = 2, TokenPrimary = 1;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400, CREATE_NEW_CONSOLE = 0x00000010;

  static string logPath;
  static void Status(string s) {
    try {
      if (logPath == null) logPath = Path.Combine(Path.GetTempPath(), "hc-pdesk.log");
      if (File.Exists(logPath) && new FileInfo(logPath).Length > 131072) File.Delete(logPath);
      File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\r\n");
    } catch { }
    try { Console.Error.WriteLine(s); Console.Error.Flush(); } catch { } // surface to the agent too
  }
  static string ObjName(IntPtr h) {
    try {
      if (h == IntPtr.Zero) return "";
      int need; GetUserObjectInformation(h, 2, null, 0, out need);
      if (need <= 0) return "";
      byte[] buf = new byte[need]; GetUserObjectInformation(h, 2, buf, need, out need);
      return System.Text.Encoding.Unicode.GetString(buf).TrimEnd('\0');
    } catch { return ""; }
  }

  // Grab the active user's primary token (duplicated so we own it). Returns
  // IntPtr.Zero if we're already in the user's session (no need to cross).
  static IntPtr userToken = IntPtr.Zero;
  static bool PrepareUserSession() {
    try {
      uint sid = WTSGetActiveConsoleSessionId();
      if (sid == 0xFFFFFFFF) { Status("no active console session"); return false; }
      // If our own winsta is already the user's WinSta0 (per-user agent), skip
      // the impersonation dance — we're already in the right place.
      string cur = ObjName(GetProcessWindowStation());
      if (string.Equals(cur, "WinSta0", StringComparison.OrdinalIgnoreCase) && !RunningInService()) {
        Status("already in user winsta (per-user agent) — no impersonation needed");
        return true;
      }
      IntPtr tok;
      if (!WTSQueryUserToken(sid, out tok)) {
        int err = Marshal.GetLastWin32Error();
        Status("WTSQueryUserToken(session=" + sid + ") failed err=" + err + " (SYSTEM privileges needed; per-user agent cannot cross sessions)");
        return false;
      }
      IntPtr dup;
      if (!DuplicateTokenEx(tok, (uint)MAX_TOKEN_ALL, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out dup)) {
        int err = Marshal.GetLastWin32Error();
        Status("DuplicateTokenEx failed err=" + err);
        CloseHandle(tok);
        return false;
      }
      CloseHandle(tok);
      userToken = dup;
      // Impersonate so the subsequent OpenWindowStation / SetThreadDesktop
      // calls resolve inside the user's session, not the service station.
      if (!ImpersonateLoggedOnUser(userToken)) {
        Status("ImpersonateLoggedOnUser failed err=" + Marshal.GetLastWin32Error());
        CloseHandle(userToken); userToken = IntPtr.Zero;
        return false;
      }
      IntPtr ws = OpenWindowStation("WinSta0", false, WINSTA_ALL);
      if (ws == IntPtr.Zero) {
        Status("OpenWindowStation(WinSta0) after impersonate failed err=" + Marshal.GetLastWin32Error());
        RevertToSelf();
        return false;
      }
      if (!SetProcessWindowStation(ws)) Status("SetProcessWindowStation warn err=" + Marshal.GetLastWin32Error());
      Status("switched to user session=" + sid + " winsta=" + ObjName(GetProcessWindowStation()));
      return true;
    } catch (Exception e) { Status("PrepareUserSession ex: " + e.Message); return false; }
  }
  static bool RunningInService() {
    // Simple heuristic: when the agent is a Windows service running as SYSTEM
    // in Session 0, Environment.UserInteractive is false. For per-user agents
    // we skip the WTS dance.
    try { return !Environment.UserInteractive; } catch { return false; }
  }

  static IntPtr pdeskHandle = IntPtr.Zero;
  static string _desktopName = "hc-pdesk";

  static bool EnsureDesktop(string name) {
    try {
      IntPtr h = OpenDesktop(name, 0, false, DESKTOP_RIGHTS);
      if (h == IntPtr.Zero) h = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, DESKTOP_RIGHTS, IntPtr.Zero);
      if (h == IntPtr.Zero) { Status("CreateDesktop(" + name + ") err=" + Marshal.GetLastWin32Error()); return false; }
      pdeskHandle = h;
      if (!SetThreadDesktop(h)) { Status("SetThreadDesktop err=" + Marshal.GetLastWin32Error()); return false; }
      Status("desktop ready: " + name);
      return true;
    } catch (Exception e) { Status("desk ex " + e.Message); return false; }
  }

  // Launch something onto the private desktop. From a service we CreateProcessAsUser
  // (user token) so the child runs in the user session. From a per-user agent, plain
  // CreateProcess works.
  static void SpawnShell(string name, string shell) {
    try {
      STARTUPINFO si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(si);
      si.lpDesktop = "WinSta0\\" + name;
      PROCESS_INFORMATION pi;
      bool ok;
      if (userToken != IntPtr.Zero) {
        IntPtr env = IntPtr.Zero;
        try { CreateEnvironmentBlock(out env, userToken, false); } catch { env = IntPtr.Zero; }
        ok = CreateProcessAsUser(userToken, null, shell, IntPtr.Zero, IntPtr.Zero, false, CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT, env, null, ref si, out pi);
        if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
      } else {
        ok = CreateProcess(null, shell, IntPtr.Zero, IntPtr.Zero, false, CREATE_NEW_CONSOLE, IntPtr.Zero, null, ref si, out pi);
      }
      if (!ok) Status("spawn(" + shell + ") failed err=" + Marshal.GetLastWin32Error());
      else { Status("spawned pid=" + pi.dwProcessId + " on " + si.lpDesktop); CloseHandle(pi.hProcess); CloseHandle(pi.hThread); }
    } catch (Exception e) { Status("spawn ex " + e.Message); }
  }

  static ImageCodecInfo _jpg;
  static EncoderParameters _ep;
  static byte[] EncodeJpeg(Bitmap bmp, long quality) {
    if (_jpg == null) {
      foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == ImageFormat.Jpeg.Guid) _jpg = c;
      _ep = new EncoderParameters(1);
      _ep.Param[0] = new EncoderParameter(Encoder.Quality, quality);
    }
    using (var ms = new MemoryStream()) { bmp.Save(ms, _jpg, _ep); return ms.ToArray(); }
  }
  // Private-desktop composite: enumerates every top-level window on hc-pdesk
  // and PrintWindow()s each one into a shared offscreen bitmap. Can't use
  // BitBlt(GetDC(0)) here — that captures the PHYSICAL screen, which Windows
  // is showing the user's VISIBLE desktop on, not our hidden one. PrintWindow
  // works regardless of visibility: it asks the target window to render into
  // the DC we hand it. Composite them in Z-order (bottom to top) so overlaps
  // paint correctly.
  const uint GW_HWNDPREV = 3;
  static byte[] GrabFrame() {
    // 1. Enumerate top-level windows on this desktop. We're attached to it via
    //    SetThreadDesktop; EnumDesktopWindows uses the thread's desktop when
    //    passed IntPtr.Zero.
    var hwnds = new List<IntPtr>();
    try {
      EnumDesktopWindows(IntPtr.Zero, (hwnd, _l) => {
        // Can't use IsWindowVisible — it returns false for windows on
        // non-input desktops even when WS_VISIBLE is set. Just gate on size.
        RECT r;
        if (!GetWindowRect(hwnd, out r)) return true;
        int w = r.right - r.left, h = r.bottom - r.top;
        if (w < 10 || h < 10) return true;
        hwnds.Add(hwnd);
        return true;
      }, IntPtr.Zero);
    } catch (Exception e) { Status("EnumDesktopWindows ex " + e.Message); return null; }
    if (hwnds.Count == 0) {
      // Totally empty desktop — paint a dark background with a hint so the
      // operator sees SOMETHING and can tell pdesk is alive. Use the primary
      // display's dimensions as the canvas.
      int cw = GetSystemMetrics(SM_CXSCREEN), ch = GetSystemMetrics(SM_CYSCREEN);
      if (cw <= 0) cw = 1920; if (ch <= 0) ch = 1080;
      try {
        using (var bmp = new Bitmap(cw, ch))
        using (var g = Graphics.FromImage(bmp)) {
          g.Clear(Color.FromArgb(20, 20, 24));
          using (var fnt = new Font("Segoe UI", 24))
          using (var br = new SolidBrush(Color.FromArgb(140, 140, 150))) {
            g.DrawString("Private desktop is empty — click \"Launch\" below", fnt, br, 60, 60);
          }
          return EncodeJpeg(bmp, 70L);
        }
      } catch { return null; }
    }
    // 2. Compute the bounding box so we only encode as big an area as needed.
    //    A fresh desktop with just a cmd window produces a small frame; adding
    //    a browser later grows the canvas. Clamp to 4K to avoid runaway.
    int minX = int.MaxValue, minY = int.MaxValue, maxX = int.MinValue, maxY = int.MinValue;
    var rects = new List<RECT>(hwnds.Count);
    foreach (var h in hwnds) {
      RECT r; if (!GetWindowRect(h, out r)) continue;
      rects.Add(r);
      if (r.left < minX) minX = r.left; if (r.top < minY) minY = r.top;
      if (r.right > maxX) maxX = r.right; if (r.bottom > maxY) maxY = r.bottom;
    }
    if (rects.Count == 0) return null;
    if (minX < 0) minX = 0; if (minY < 0) minY = 0;
    int totW = Math.Min(3840, maxX - minX), totH = Math.Min(2160, maxY - minY);
    if (totW <= 0 || totH <= 0) return null;
    byte[] jpg = null;
    try {
      using (var composite = new Bitmap(totW, totH))
      using (var g = Graphics.FromImage(composite)) {
        g.Clear(Color.FromArgb(20, 20, 24));
        // 3. Paint each window via PrintWindow onto a per-window bitmap, then
        //    draw it offset into the composite. PW_RENDERFULLCONTENT (0x2) is
        //    needed for layered/UWP windows to render properly.
        for (int i = 0; i < hwnds.Count; i++) {
          var hwnd = hwnds[i]; var r = rects[i];
          int w = r.right - r.left, h = r.bottom - r.top;
          if (w <= 0 || h <= 0) continue;
          using (var winBmp = new Bitmap(w, h))
          using (var winG = Graphics.FromImage(winBmp)) {
            IntPtr hdc = winG.GetHdc();
            try { PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT); }
            finally { winG.ReleaseHdc(hdc); }
            g.DrawImage(winBmp, r.left - minX, r.top - minY);
          }
        }
        jpg = EncodeJpeg(composite, 55L);
      }
    } catch (Exception e) { Status("composite ex " + e.Message); }
    return jpg;
  }

  // Input injector thread — stays attached to the private desktop so SendInput
  // reaches it (SendInput only hits the calling thread's desktop).
  static readonly Queue<string> inputQ = new Queue<string>();
  static readonly ManualResetEvent inputEvt = new ManualResetEvent(false);
  static volatile bool running = true;

  static void InputThread(string name) {
    // Needs the SAME impersonation that main thread used, otherwise OpenDesktop
    // in this thread would look in the service winsta and come back empty.
    if (userToken != IntPtr.Zero) {
      if (!ImpersonateLoggedOnUser(userToken)) { Status("InputThread impersonate err=" + Marshal.GetLastWin32Error()); return; }
    }
    IntPtr h = OpenDesktop(name, 0, false, DESKTOP_RIGHTS);
    if (h == IntPtr.Zero || !SetThreadDesktop(h)) { Status("InputThread attach failed err=" + Marshal.GetLastWin32Error()); return; }
    int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
    while (running) {
      inputEvt.WaitOne();
      string line;
      lock (inputQ) {
        if (inputQ.Count == 0) { inputEvt.Reset(); continue; }
        line = inputQ.Dequeue();
      }
      try {
        if (string.IsNullOrEmpty(line)) continue;
        string[] parts = line.Split(' ');
        INPUT[] inp = new INPUT[1];
        if (parts[0] == "M" && parts.Length == 3) {
          int x = int.Parse(parts[1]), y = int.Parse(parts[2]);
          inp[0].type = INPUT_MOUSE;
          inp[0].mi.dx = (int)((long)x * 65535 / Math.Max(sw - 1, 1));
          inp[0].mi.dy = (int)((long)y * 65535 / Math.Max(sh - 1, 1));
          inp[0].mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
          SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        } else if (parts[0] == "C" && parts.Length == 3) {
          int down = int.Parse(parts[2]); int f = 0;
          switch (parts[1]) {
            case "L": f = down == 1 ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; break;
            case "R": f = down == 1 ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; break;
            case "M": f = down == 1 ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; break;
          }
          inp[0].type = INPUT_MOUSE; inp[0].mi.dwFlags = f;
          SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        } else if (parts[0] == "S" && parts.Length == 3) {
          int dy = int.Parse(parts[2]);
          inp[0].type = INPUT_MOUSE; inp[0].mi.dwFlags = MOUSEEVENTF_WHEEL; inp[0].mi.mouseData = dy;
          SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        } else if (parts[0] == "K" && parts.Length == 3) {
          short vk = short.Parse(parts[1]); int down = int.Parse(parts[2]);
          inp[0].type = INPUT_KEYBOARD; inp[0].ki.wVk = vk; inp[0].ki.dwFlags = down == 1 ? 0 : KEYEVENTF_KEYUP;
          SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        } else if (parts[0] == "L") {
          int space = line.IndexOf(' ');
          if (space > 0 && space < line.Length - 1) {
            string cmd = line.Substring(space + 1);
            SpawnShell(_desktopName, cmd);
          }
          continue;
        } else if (parts[0] == "T" && parts.Length == 2) {
          short cp = short.Parse(parts[1]);
          INPUT[] two = new INPUT[2];
          two[0].type = INPUT_KEYBOARD; two[0].ki.wScan = cp; two[0].ki.dwFlags = KEYEVENTF_UNICODE;
          two[1].type = INPUT_KEYBOARD; two[1].ki.wScan = cp; two[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
          SendInput(2, two, Marshal.SizeOf(typeof(INPUT)));
        }
      } catch (Exception e) { Status("input ex " + e.Message); }
    }
  }

  static int Main(string[] args) {
    try {
      SetProcessDPIAware();
      string name = "hc-pdesk";
      string shell = "C:\\Windows\\System32\\cmd.exe";
      int fps = 8;
      for (int i = 0; i < args.Length - 1; i++) {
        if (args[i] == "--name") name = args[i + 1];
        else if (args[i] == "--shell") shell = args[i + 1];
        else if (args[i] == "--fps" && int.TryParse(args[i + 1], out fps)) {}
      }
      if (fps < 2) fps = 2; if (fps > 20) fps = 20;
      int period = 1000 / fps;
      _desktopName = name;

      if (!PrepareUserSession()) { Status("ABORT: could not cross into user session (per-user agent install needed, or SYSTEM privileges)"); return 3; }
      if (!EnsureDesktop(name)) { Status("ABORT: desktop creation failed"); return 2; }
      SpawnShell(name, shell);
      Status("ok — capturing at " + fps + " fps");

      var it = new Thread(() => InputThread(name)); it.IsBackground = true; it.Start();
      var sr = new Thread(() => {
        try {
          string line;
          while ((line = Console.In.ReadLine()) != null) {
            if (line == "Q") { running = false; break; }
            lock (inputQ) inputQ.Enqueue(line);
            inputEvt.Set();
          }
        } catch { }
        running = false; inputEvt.Set();
      });
      sr.IsBackground = true; sr.Start();

      Stream stdout = Console.OpenStandardOutput();
      long frames = 0;
      while (running) {
        int t0 = Environment.TickCount;
        byte[] jpg = GrabFrame();
        if (jpg != null && jpg.Length > 0) {
          byte[] hdr = new byte[4];
          hdr[0] = (byte)(jpg.Length >> 24); hdr[1] = (byte)(jpg.Length >> 16);
          hdr[2] = (byte)(jpg.Length >> 8); hdr[3] = (byte)(jpg.Length);
          try { stdout.Write(hdr, 0, 4); stdout.Write(jpg, 0, jpg.Length); stdout.Flush(); }
          catch { break; }
          if (frames == 0) Status("first frame sent, " + jpg.Length + " bytes");
          frames++;
        } else if (frames == 0 && (Environment.TickCount % 2000) < 50) {
          Status("GrabFrame returned null — BitBlt refused (desktop may be empty or not focusable yet)");
        }
        int dt = Environment.TickCount - t0;
        if (dt < period) Thread.Sleep(period - dt);
      }
    } catch (Exception e) { Status("fatal " + e.Message); return 1; }
    try { if (userToken != IntPtr.Zero) { RevertToSelf(); CloseHandle(userToken); } } catch { }
    return 0;
  }
}
