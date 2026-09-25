// SecureCapture.cs -> sdcap.exe
// Captures the SECURE / lock (Winlogon) desktop that Electron's desktopCapturer
// cannot see, so the technician can view and type the password on the remote
// lock screen. Same rationale as the injector's desktop switching: only a SYSTEM
// process (the elevated/service install) can OpenDesktop("Winlogon") and
// SetThreadDesktop onto it; a per-user build simply fails here and exits, and the
// console keeps showing its "Device is locked" placeholder (no regression).
//
// Protocol: writes JPEG frames to stdout as [4-byte big-endian length][jpeg...].
// Exits when stdin closes (the agent stops it on unlock). All diagnostics go to
// %TEMP%\hc-sdcap.log (C:\Windows\Temp\hc-sdcap.log when running as SYSTEM).
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class SecureCapture {
  // ---- desktop / window-station switching (mirrors the injector) ----
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenWindowStation(string name, bool fInherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessWindowStation(IntPtr hWinSta);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
  static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, byte[] pvInfo, int nLength, out int lenNeeded);

  // ---- screen GDI capture ----
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);

  const int UOI_NAME = 2;
  const int SM_CXSCREEN = 0, SM_CYSCREEN = 1; // primary display, matches the dims the agent reports on lock
  const int SRCCOPY = 0x00CC0020, CAPTUREBLT = 0x40000000;
  // Enough to SetThreadDesktop onto the desktop and read from it.
  const uint DESKTOP_RIGHTS = 0x0001 | 0x0080 | 0x0100; // READOBJECTS | WRITEOBJECTS | SWITCHDESKTOP
  const uint WINSTA_ALL = 0x37F;

  static string logPath;
  static void Log(string s) {
    try {
      if (logPath == null) logPath = Path.Combine(Path.GetTempPath(), "hc-sdcap.log");
      if (File.Exists(logPath) && new FileInfo(logPath).Length > 131072) File.Delete(logPath);
      File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\r\n");
    } catch { }
  }
  static string ObjName(IntPtr h) {
    try {
      if (h == IntPtr.Zero) return "";
      int need; GetUserObjectInformation(h, UOI_NAME, null, 0, out need);
      if (need <= 0) return "";
      byte[] buf = new byte[need]; GetUserObjectInformation(h, UOI_NAME, buf, need, out need);
      return System.Text.Encoding.Unicode.GetString(buf).TrimEnd('\0');
    } catch { return ""; }
  }

  // Switch this process to the interactive window station if we started in a
  // service (Session 0) window station, so the desktop handles resolve.
  static void EnsureInteractiveWinSta() {
    try {
      IntPtr cur = GetProcessWindowStation();
      if (string.Compare(ObjName(cur), "WinSta0", StringComparison.OrdinalIgnoreCase) == 0) return;
      IntPtr ws = OpenWindowStation("WinSta0", false, WINSTA_ALL);
      if (ws == IntPtr.Zero) { Log("OpenWindowStation(WinSta0) err=" + Marshal.GetLastWin32Error() + " (not SYSTEM?)"); return; }
      if (!SetProcessWindowStation(ws)) Log("SetProcessWindowStation err=" + Marshal.GetLastWin32Error());
      else Log("switched to WinSta0");
    } catch (Exception e) { Log("winsta ex: " + e.Message); }
  }

  static IntPtr curDesk = IntPtr.Zero;
  static string curDeskName = "";
  static bool warnedNoDesk = false;
  // Attach to whatever desktop currently owns input (Winlogon while locked, or a
  // UAC secure desktop). Returns true if we are attached to some input desktop.
  static bool FollowInputDesktop() {
    IntPtr h = OpenInputDesktop(0, false, DESKTOP_RIGHTS);
    if (h == IntPtr.Zero) h = OpenDesktop("Winlogon", 0, false, DESKTOP_RIGHTS); // lock screen by name
    if (h == IntPtr.Zero) {
      if (curDesk != IntPtr.Zero) return true; // keep the one we already have
      if (!warnedNoDesk) { warnedNoDesk = true; Log("no input desktop (OpenInputDesktop/Winlogon failed err=" + Marshal.GetLastWin32Error() + ") — not SYSTEM? staying idle"); }
      return false;
    }
    warnedNoDesk = false;
    string name = ObjName(h);
    if (curDesk != IntPtr.Zero && name == curDeskName) { CloseDesktop(h); return true; } // unchanged
    if (SetThreadDesktop(h)) {
      if (curDesk != IntPtr.Zero) CloseDesktop(curDesk);
      curDesk = h; curDeskName = name;
      Log("attached to input desktop '" + name + "'");
      return true;
    }
    int err = Marshal.GetLastWin32Error();
    CloseDesktop(h);
    Log("SetThreadDesktop('" + name + "') err=" + err);
    return curDesk != IntPtr.Zero;
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

  // One BitBlt of the primary display on the current (input) desktop -> JPEG.
  static byte[] GrabFrame() {
    int w = GetSystemMetrics(SM_CXSCREEN), h = GetSystemMetrics(SM_CYSCREEN);
    if (w <= 0 || h <= 0) return null;
    IntPtr src = GetDC(IntPtr.Zero);
    if (src == IntPtr.Zero) return null;
    IntPtr mem = CreateCompatibleDC(src);
    IntPtr bm = CreateCompatibleBitmap(src, w, h);
    IntPtr old = SelectObject(mem, bm);
    byte[] jpg = null;
    try {
      if (BitBlt(mem, 0, 0, w, h, src, 0, 0, SRCCOPY | CAPTUREBLT)) {
        using (Bitmap bmp = Image.FromHbitmap(bm)) jpg = EncodeJpeg(bmp, 55L);
      }
    } catch (Exception e) { Log("grab ex: " + e.Message); }
    finally {
      SelectObject(mem, old); DeleteObject(bm); DeleteDC(mem); ReleaseDC(IntPtr.Zero, src);
    }
    return jpg;
  }

  static volatile bool running = true;

  static int Main(string[] args) {
    try {
      SetProcessDPIAware();
      // Exit cleanly when the agent closes our stdin.
      var t = new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } running = false; });
      t.IsBackground = true; t.Start();

      EnsureInteractiveWinSta();
      Log("sdcap start");

      // ~8 fps is plenty to type a password and keeps bandwidth/CPU low.
      int fps = 8;
      for (int i = 1; i < args.Length; i++) if (args[i - 1] == "--fps") int.TryParse(args[i], out fps);
      if (fps < 2) fps = 2; if (fps > 20) fps = 20;
      int period = 1000 / fps;

      Stream stdout = Console.OpenStandardOutput();
      long frames = 0;
      while (running) {
        int t0 = Environment.TickCount;
        if (FollowInputDesktop()) {
          byte[] jpg = GrabFrame();
          if (jpg != null && jpg.Length > 0) {
            byte[] hdr = new byte[4];
            hdr[0] = (byte)(jpg.Length >> 24); hdr[1] = (byte)(jpg.Length >> 16);
            hdr[2] = (byte)(jpg.Length >> 8);  hdr[3] = (byte)(jpg.Length);
            try { stdout.Write(hdr, 0, 4); stdout.Write(jpg, 0, jpg.Length); stdout.Flush(); }
            catch { running = false; break; } // pipe closed -> agent gone
            if (++frames <= 3 || frames % 80 == 0) Log("frame " + frames + " (" + jpg.Length + " bytes, desk='" + curDeskName + "')");
          }
        }
        int dt = Environment.TickCount - t0;
        if (dt < period) Thread.Sleep(period - dt);
      }
    } catch (Exception e) { Log("fatal: " + e.Message); return 1; }
    Log("sdcap exit");
    return 0;
  }
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
}
