// Aegis Remote — input injector.
// A tiny persistent console app: reads newline-delimited commands on stdin and
// injects OS-level mouse/keyboard input via Win32 SendInput. Compiled with the
// .NET Framework csc.exe that ships with Windows (see build-injector.js), so it
// needs no npm native module / node-gyp.
//
// Commands (space-separated, one per line):
//   M <nx> <ny>     move mouse to normalized position (0..1) on the primary screen
//   MV <nx> <ny>    move across the whole virtual (multi-monitor) desktop
//   D <L|R|M>       mouse button down
//   U <L|R|M>       mouse button up
//   W <delta>       mouse wheel (positive = up)
//   K <vk> <1|0>    key by Windows virtual-key code, down(1)/up(0)
//   T <codepoint>   type a Unicode character (down+up)
//   B <1|0>         lock(1)/unlock(0) the LOCAL physical mouse+keyboard
//   AFF <hwnd> <n>  SetWindowDisplayAffinity (legacy; blank now uses blanker.exe)
//
// Lock (B): implemented with low-level WH_MOUSE_LL/WH_KEYBOARD_LL hooks that
// swallow physical input while it's engaged. Our OWN injected events are tagged
// with dwExtraInfo == MAGIC so the hooks let them through — the technician keeps
// full control while the person at the machine can't interfere. This works at
// normal (non-elevated) integrity, unlike BlockInput which Windows denies to a
// standard-user process. (It can't intercept input aimed at a higher-integrity
// foreground window, e.g. a UAC prompt — an inherent user-mode limit.)
using System;
using System.Runtime.InteropServices;
using System.Globalization;
using System.Threading;

class Injector {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

  // Marks input WE injected so the lock hooks pass it through ('AEGI').
  static readonly IntPtr MAGIC = (IntPtr)0x41454749;

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")]
  static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
  // Second lock mechanism (belt-and-suspenders): BlockInput blocks physical input
  // but NOT input injected by the calling thread. Some AV/EDR blocks the global
  // low-level hooks (anti-keylogger), so this covers the case where those fail.
  // Called only from the stdin thread — the same thread that runs SendInput — so
  // the technician's injected input keeps flowing while the local user is frozen.
  [DllImport("user32.dll")]
  static extern bool BlockInput(bool fBlockIt);
  // Ctrl+Alt+Del (Secure Attention Sequence). Only works if this process may
  // generate it — i.e. running as SYSTEM (service) or with the
  // SoftwareSASGeneration policy allowing apps. From a normal user agent it's a
  // no-op; best-effort so the button exists for elevated/service deployments.
  [DllImport("sas.dll", SetLastError = true)]
  static extern void SendSAS(bool asUser);

  // ---- secure-desktop switching (control the LOCK SCREEN) ----
  // When Windows locks (or shows UAC/Ctrl-Alt-Del), the INPUT desktop switches to
  // the protected "Winlogon" desktop. SendInput only lands on the desktop the
  // calling thread is attached to, so to move the mouse / type the password on the
  // lock screen we must SetThreadDesktop() to the current input desktop first.
  // OpenInputDesktop of Winlogon is only granted to a SYSTEM process — so this
  // works on the elevated/service build and safely no-ops on the per-user build.
  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetThreadDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
  static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, byte[] pvInfo, int nLength, out int lpnLengthNeeded);
  const int UOI_NAME = 2;
  const uint DESKTOP_GENERIC = 0x01FF; // all DESKTOP_* access rights

  static IntPtr curDesk = IntPtr.Zero;
  static string curDeskName = "";
  static long lastDeskCheck = 0;
  static string DesktopName(IntPtr h) {
    try {
      int need;
      GetUserObjectInformation(h, UOI_NAME, null, 0, out need);
      if (need <= 0) return "";
      byte[] buf = new byte[need];
      if (!GetUserObjectInformation(h, UOI_NAME, buf, need, out need)) return "";
      return System.Text.Encoding.Unicode.GetString(buf).TrimEnd('\0');
    } catch { return ""; }
  }
  // Attach this (SendInput-calling) thread to whatever desktop currently owns input.
  // Only actually switches when the desktop name changes (lock <-> unlock), so it is
  // cheap to call often. Silent no-op when we lack rights (per-user build).
  static void EnsureInputDesktop() {
    try {
      IntPtr h = OpenInputDesktop(0, false, DESKTOP_GENERIC);
      if (h == IntPtr.Zero) return;                 // no access (per-user) -> keep current
      string name = DesktopName(h);
      if (curDesk != IntPtr.Zero && name == curDeskName) { CloseDesktop(h); return; }
      if (SetThreadDesktop(h)) {
        IntPtr old = curDesk;
        curDesk = h; curDeskName = name;
        if (old != IntPtr.Zero) CloseDesktop(old);
      } else {
        CloseDesktop(h);                            // couldn't switch -> stay put
      }
    } catch { }
  }

  // ---- low-level input hooks (used to lock the local physical input) ----
  const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14, HC_ACTION = 0;
  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll")]
  static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
  static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")]
  static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

  static volatile bool blocking = false;
  static HookProc mouseProc, kbProc; // keep delegates alive (GC)

  static IntPtr MouseHookProc(int code, IntPtr w, IntPtr l) {
    if (code == HC_ACTION && blocking) {
      MSLLHOOKSTRUCT s = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(MSLLHOOKSTRUCT));
      if (s.dwExtraInfo != MAGIC) return (IntPtr)1; // physical event -> swallow
    }
    return CallNextHookEx(IntPtr.Zero, code, w, l);
  }
  static IntPtr KbHookProc(int code, IntPtr w, IntPtr l) {
    if (code == HC_ACTION && blocking) {
      KBDLLHOOKSTRUCT s = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(KBDLLHOOKSTRUCT));
      if (s.dwExtraInfo != MAGIC) return (IntPtr)1;
    }
    return CallNextHookEx(IntPtr.Zero, code, w, l);
  }
  static void HookThread() {
    mouseProc = MouseHookProc; kbProc = KbHookProc;
    IntPtr hMod = GetModuleHandle(null);
    SetWindowsHookEx(WH_MOUSE_LL, mouseProc, hMod, 0);
    SetWindowsHookEx(WH_KEYBOARD_LL, kbProc, hMod, 0);
    MSG msg; // pump messages so the LL hooks fire on this thread
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
  }

  static void SendMouse(uint flags, int dx, int dy, uint data) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = INPUT_MOUSE;
    inp[0].u.mi.dx = dx; inp[0].u.mi.dy = dy; inp[0].u.mi.mouseData = data; inp[0].u.mi.dwFlags = flags;
    inp[0].u.mi.dwExtraInfo = MAGIC;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
  static void SendKey(ushort vk, ushort scan, uint flags) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = INPUT_KEYBOARD;
    inp[0].u.ki.wVk = vk; inp[0].u.ki.wScan = scan; inp[0].u.ki.dwFlags = flags;
    inp[0].u.ki.dwExtraInfo = MAGIC;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
  static void MoveNorm(double nx, double ny) {
    if (nx < 0) nx = 0; if (nx > 1) nx = 1;
    if (ny < 0) ny = 0; if (ny > 1) ny = 1;
    int ax = (int)Math.Round(nx * 65535.0);
    int ay = (int)Math.Round(ny * 65535.0);
    SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ax, ay, 0);
  }
  // Move across the whole virtual desktop (multi-monitor); coords normalized
  // 0..1 over the union of all displays.
  static void MoveNormVirtual(double nx, double ny) {
    if (nx < 0) nx = 0; if (nx > 1) nx = 1;
    if (ny < 0) ny = 0; if (ny > 1) ny = 1;
    int ax = (int)Math.Round(nx * 65535.0);
    int ay = (int)Math.Round(ny * 65535.0);
    SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0);
  }

  static void Main() {
    var ci = CultureInfo.InvariantCulture;
    Thread hookThread = new Thread(HookThread);
    hookThread.IsBackground = true;
    hookThread.Start();
    string line;
    while ((line = Console.ReadLine()) != null) {
      try {
        // Follow the input desktop (lock screen <-> normal), throttled to ~200ms so
        // frequent mouse moves stay cheap. No-op on the per-user build.
        int now = Environment.TickCount;
        if (now - (int)lastDeskCheck >= 200) { lastDeskCheck = now; EnsureInputDesktop(); }
        string[] p = line.Split(' ');
        switch (p[0]) {
          case "M": MoveNorm(double.Parse(p[1], ci), double.Parse(p[2], ci)); break;
          case "MV": MoveNormVirtual(double.Parse(p[1], ci), double.Parse(p[2], ci)); break;
          case "D":
          case "U": {
            bool down = p[0] == "D";
            string b = p[1];
            uint f = b == "R" ? (down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP)
                   : b == "M" ? (down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP)
                              : (down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP);
            SendMouse(f, 0, 0, 0);
            break;
          }
          case "W": SendMouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)int.Parse(p[1], ci))); break;
          case "B": {                                    // lock/unlock local input
            blocking = (p[1] == "1");                     // low-level-hook path
            try { BlockInput(blocking); } catch { }       // + BlockInput path (works if hooks are AV-blocked)
            break;
          }
          case "AFF": SetWindowDisplayAffinity((IntPtr)long.Parse(p[1], ci), uint.Parse(p[2], ci)); break;
          case "SAS": try { SendSAS(true); } catch { } break;   // Ctrl+Alt+Del (best-effort)
          case "K": SendKey((ushort)int.Parse(p[1], ci), 0, p[2] == "1" ? 0 : KEYEVENTF_KEYUP); break;
          case "T": {
            ushort u = (ushort)int.Parse(p[1], ci);
            SendKey(0, u, KEYEVENTF_UNICODE);
            SendKey(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
            break;
          }
        }
      } catch { /* ignore malformed line */ }
    }
  }
}
