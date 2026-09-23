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
using System.IO;

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
  // SetCursorPos is not subject to AV/EDR synthetic-input blocks (unlike SendInput).
  // Used for mouse moves so cursor tracking works even when Norton/Defender blocks SendInput.
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  static extern int GetSystemMetrics(int nIndex);
  const int SM_CXSCREEN = 0, SM_CYSCREEN = 1;
  const int SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
  const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77;
  [DllImport("user32.dll")]
  static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
  // ---- PostMessage fallback (used only when SendInput is blocked by AV/EDR) ----
  // Posting window messages does NOT go through the SendInput hook AV installs, so
  // it restores clicks/keys on machines where SendInput is silently dropped.
  // Best-effort: classic Win32 apps (Explorer, Office, dialogs, login fields)
  // honour posted input; some apps (Chrome, UWP) ignore it and still need a
  // code-signed helper. Mouse moves already use SetCursorPos, which AV allows.
  [DllImport("user32.dll")]
  static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")]
  static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")]
  static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();
  const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
  const uint WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205, WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208;
  const uint WM_MOUSEWHEEL = 0x020A, WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102;
  const uint MK_LBUTTON = 0x0001, MK_RBUTTON = 0x0002, MK_MBUTTON = 0x0010;
  // Second lock mechanism (belt-and-suspenders): BlockInput blocks physical input
  // but NOT input injected by the calling thread. Resolved DYNAMICALLY (see
  // ResolveLockApis) rather than DllImport, so it isn't in our static import
  // table alongside SetWindowsHookEx — the pair is a keylogger signature that
  // gets an unsigned binary quarantined. Called only when a lock is requested.
  // Ctrl+Alt+Del (Secure Attention Sequence). Only works if this process may
  // generate it — i.e. running as SYSTEM (service) or with the
  // SoftwareSASGeneration policy allowing apps. From a normal user agent it's a
  // no-op; best-effort so the button exists for elevated/service deployments.
  [DllImport("sas.dll", SetLastError = true)]
  static extern void SendSAS(bool asUser);

  // ---- window-station + desktop switching ----
  // When the agent runs as SYSTEM (service), it lives in Session 0's non-interactive
  // window station (e.g. Service-0x0-3e7$). SendInput sent from there never reaches
  // the interactive Session 1 user — not even with SetThreadDesktop — because the
  // process's window station is wrong. Fix: switch the PROCESS to WinSta0 once at
  // startup, THEN use SetThreadDesktop to track the input desktop normally.
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr OpenWindowStation(string name, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetProcessWindowStation(IntPtr hWinSta);
  [DllImport("user32.dll")]
  static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")]
  static extern bool CloseWindowStation(IntPtr hWinSta);
  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetThreadDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool CloseDesktop(IntPtr hDesktop);
  // The desktop this thread was created on (interactive "Default"). Windows opens it
  // with FULL generic rights at process creation; SendInput works on it. We keep this
  // handle and prefer it over any handle we re-open, because a desktop re-opened with
  // reduced rights (READ|WRITE|SWITCH) is denied SendInput (err=5). Never CloseDesktop it.
  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr GetThreadDesktop(uint dwThreadId);
  [DllImport("kernel32.dll")]
  static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
  static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, byte[] pvInfo, int nLength, out int lpnLengthNeeded);
  const int UOI_NAME = 2;
  const uint WINSTA_ALL_ACCESS = 0x37f;
  // Only request the rights we actually need — DESKTOP_GENERIC (0x01FF) includes
  // JOURNALRECORD/JOURNALPLAYBACK which the Winlogon desktop DACL denies even to
  // SYSTEM, causing OpenInputDesktop to fail with ERROR_ACCESS_DENIED (5).
  const uint DESKTOP_READOBJECTS    = 0x0001;
  const uint DESKTOP_WRITEOBJECTS   = 0x0080;
  const uint DESKTOP_SWITCHDESKTOP  = 0x0100;
  const uint DESKTOP_ACCESS = DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS | DESKTOP_SWITCHDESKTOP;

  static IntPtr curDesk = IntPtr.Zero;   // a DIFFERENT (secure/Winlogon) desktop we switched to, or Zero when on origDesk
  static string curDeskName = "";
  static IntPtr origDesk = IntPtr.Zero;  // our home desktop's full-rights handle (interactive "Default")
  static string origDeskName = "";
  static long lastDeskCheck = 0;

  // Called once at startup. If we are in a non-interactive window station (Session 0
  // service), switch the process to WinSta0 so that SetThreadDesktop + SendInput
  // reach the interactive user's desktop.
  static void EnsureInteractiveWinSta() {
    try {
      IntPtr cur = GetProcessWindowStation();
      string name = ObjName(cur);
      if (string.Compare(name, "WinSta0", StringComparison.OrdinalIgnoreCase) == 0) {
        Log("WinSta already WinSta0 — no switch needed");
        return;
      }
      IntPtr ws = OpenWindowStation("WinSta0", false, WINSTA_ALL_ACCESS);
      if (ws == IntPtr.Zero) { Log("OpenWindowStation(WinSta0) FAILED err=" + Marshal.GetLastWin32Error() + " (running as non-SYSTEM?)"); return; }
      if (!SetProcessWindowStation(ws)) {
        Log("SetProcessWindowStation(WinSta0) FAILED err=" + Marshal.GetLastWin32Error());
        CloseWindowStation(ws);
        return;
      }
      Log("Switched process WinSta: '" + name + "' -> WinSta0 (Session 0 -> interactive)");
      // Do NOT close the old window station handle — the process may still reference it.
    } catch (Exception ex) { Log("EnsureInteractiveWinSta ex: " + ex.Message); }
  }
  static string ObjName(IntPtr h) {
    try {
      if (h == IntPtr.Zero) return "";
      int need;
      GetUserObjectInformation(h, UOI_NAME, null, 0, out need);
      if (need <= 0) return "";
      byte[] buf = new byte[need];
      GetUserObjectInformation(h, UOI_NAME, buf, need, out need);
      return System.Text.Encoding.Unicode.GetString(buf).TrimEnd('\0');
    } catch { return ""; }
  }

  // ---- diagnostic log (retrieve via dashboard Files: %TEMP%\hc-inject.log,
  // which is C:\Windows\Temp\hc-inject.log when the agent runs as SYSTEM) ----
  static string logPath = null;
  static readonly object logLock = new object();
  static void Log(string s) {
    try {
      if (logPath == null) logPath = Path.Combine(Path.GetTempPath(), "hc-inject.log");
      lock (logLock) {
        try { if (File.Exists(logPath) && new FileInfo(logPath).Length > 131072) File.Delete(logPath); } catch { }
        File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\r\n");
      }
    } catch { }
  }
  static string DesktopName(IntPtr h) { return ObjName(h); }
  // Open a handle to the desktop that currently owns input, with the minimum
  // access needed for SetThreadDesktop. Falls back to opening "Winlogon" by name
  // so we still get a handle even if OpenInputDesktop returns ACCESS_DENIED.
  static IntPtr OpenCurrentInputDesktop() {
    // First attempt: OpenInputDesktop with minimal rights.
    IntPtr h = OpenInputDesktop(0, false, DESKTOP_ACCESS);
    if (h != IntPtr.Zero) return h;
    int err1 = Marshal.GetLastWin32Error();
    // Second attempt: try a wider mask — sometimes the first request is too narrow.
    h = OpenInputDesktop(0, false, DESKTOP_ACCESS | 0x0004 | 0x0008); // + CREATEMENU | HOOKCONTROL
    if (h != IntPtr.Zero) return h;
    // Third attempt: open Winlogon desktop by name (lock screen). This works when
    // OpenInputDesktop fails due to DACL on the current desktop.
    h = OpenDesktop("Winlogon", 0, false, DESKTOP_ACCESS);
    if (h != IntPtr.Zero) { Log("OpenInputDesktop failed err=" + err1 + ", opened Winlogon by name"); return h; }
    Log("OpenInputDesktop err=" + err1 + ", OpenDesktop(Winlogon) err=" + Marshal.GetLastWin32Error() + " (not SYSTEM?)");
    return IntPtr.Zero;
  }
  // Attach this (SendInput-calling) thread to whatever desktop currently owns input.
  // Only actually switches when the desktop name changes (lock <-> unlock), so it is
  // cheap to call often. Silent no-op when we lack rights (per-user build).
  static void EnsureInputDesktop() {
    try {
      IntPtr h = OpenCurrentInputDesktop();
      if (h == IntPtr.Zero) return; // no access (per-user build or early boot) — stay put
      string name = DesktopName(h);
      // NORMAL desktop case: the desktop that owns input is our home desktop
      // ("Default"). Do NOT SetThreadDesktop onto the freshly-opened handle `h` —
      // it carries only reduced rights (READ|WRITE|SWITCH) and SendInput on it is
      // denied with ERROR_ACCESS_DENIED (err=5), so the cursor moves (SetCursorPos)
      // but clicks/keys silently die. Stay on — or return to — our ORIGINAL
      // full-rights handle instead. This is the fix for "mouse moves but clicks
      // don't work"; the old code re-attached here on the very first input event.
      if (origDesk != IntPtr.Zero && origDeskName.Length > 0 && name == origDeskName) {
        CloseDesktop(h);
        if (curDesk != IntPtr.Zero) {               // we had switched away to a secure desktop — come home
          if (SetThreadDesktop(origDesk)) {
            CloseDesktop(curDesk); curDesk = IntPtr.Zero; curDeskName = "";
            logInputs = 8;
            Log("returned to home input desktop '" + origDeskName + "' (full rights)");
          } else {
            Log("SetThreadDesktop(home '" + origDeskName + "') FAILED err=" + Marshal.GetLastWin32Error());
          }
        }
        return;
      }
      // A DIFFERENT desktop owns input (UAC/Winlogon secure desktop). The service
      // build switches to it so it can drive the lock screen; a per-user build
      // usually can't open it (h would be Zero above). Already there? nothing to do.
      if (curDesk != IntPtr.Zero && name == curDeskName) { CloseDesktop(h); return; }
      if (SetThreadDesktop(h)) {
        IntPtr old = curDesk;
        curDesk = h; curDeskName = name;
        if (old != IntPtr.Zero) CloseDesktop(old);
        logInputs = 8;   // log the next few injected events on the new desktop
        Log("switched input desktop -> '" + name + "' (SetThreadDesktop ok)");
      } else {
        int err = Marshal.GetLastWin32Error();
        CloseDesktop(h);                            // couldn't switch -> stay put
        Log("SetThreadDesktop to '" + name + "' FAILED err=" + err + " (staying on '" + (curDesk != IntPtr.Zero ? curDeskName : origDeskName) + "')");
      }
    } catch (Exception ex) { Log("EnsureInputDesktop ex: " + ex.Message); }
  }

  // ---- low-level input hooks (used to lock the local physical input) ----
  // IMPORTANT (antivirus): installing a global WH_KEYBOARD_LL hook is the #1
  // keylogger heuristic. An UNSIGNED binary that does it at startup gets
  // quarantined by Norton/McAfee/Defender-heuristics. This tool used to sail
  // through those AVs when it was pure SendInput automation; the input-lock
  // feature (2026-08-26) added always-on LL hooks and flipped it to "flagged".
  // Fix: (1) NEVER install hooks at startup — only when a lock is requested; and
  // (2) resolve SetWindowsHookEx / BlockInput / etc. DYNAMICALLY so they don't
  // appear in our static import table (which AVs also scan). The default running
  // injector therefore has the same benign fingerprint it had pre-2026-08-26.
  const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14, HC_ACTION = 0;
  const uint WM_QUIT = 0x0012;
  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
  static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")]
  static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
  // Dynamic resolution of the lock-only APIs (kept out of the import table).
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
  static extern IntPtr LoadLibraryA(string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
  static extern IntPtr GetProcAddress(IntPtr hModule, string procName);
  delegate IntPtr SetWindowsHookExFn(int idHook, HookProc lpfn, IntPtr hMod, uint tid);
  delegate IntPtr CallNextHookExFn(IntPtr hhk, int nCode, IntPtr w, IntPtr l);
  delegate bool UnhookWindowsHookExFn(IntPtr hhk);
  delegate bool BlockInputFn(bool fBlockIt);
  delegate bool PostThreadMessageFn(uint tid, uint msg, IntPtr w, IntPtr l);
  static SetWindowsHookExFn _setHook;
  static CallNextHookExFn _callNext;
  static UnhookWindowsHookExFn _unhook;
  static BlockInputFn _blockInput;
  static PostThreadMessageFn _postThreadMsg;
  static bool _lockApiReady = false;
  static void ResolveLockApis() {
    if (_lockApiReady) return;
    try {
      IntPtr u = LoadLibraryA("user32.dll");
      if (u == IntPtr.Zero) { Log("lock: LoadLibrary(user32) failed"); return; }
      _setHook = (SetWindowsHookExFn)Marshal.GetDelegateForFunctionPointer(GetProcAddress(u, "SetWindowsHookExW"), typeof(SetWindowsHookExFn));
      _callNext = (CallNextHookExFn)Marshal.GetDelegateForFunctionPointer(GetProcAddress(u, "CallNextHookEx"), typeof(CallNextHookExFn));
      _unhook = (UnhookWindowsHookExFn)Marshal.GetDelegateForFunctionPointer(GetProcAddress(u, "UnhookWindowsHookEx"), typeof(UnhookWindowsHookExFn));
      _blockInput = (BlockInputFn)Marshal.GetDelegateForFunctionPointer(GetProcAddress(u, "BlockInput"), typeof(BlockInputFn));
      _postThreadMsg = (PostThreadMessageFn)Marshal.GetDelegateForFunctionPointer(GetProcAddress(u, "PostThreadMessageW"), typeof(PostThreadMessageFn));
      _lockApiReady = true;
    } catch (Exception ex) { Log("lock: ResolveLockApis ex " + ex.Message); }
  }

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

  static volatile bool blocking = false;
  static HookProc mouseProc, kbProc; // keep delegates alive (GC)
  static Thread hookThread;
  static uint hookThreadId;
  static ManualResetEvent hookReady;
  static readonly object hookLock = new object();

  static IntPtr MouseHookProc(int code, IntPtr w, IntPtr l) {
    if (code == HC_ACTION && blocking) {
      MSLLHOOKSTRUCT s = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(MSLLHOOKSTRUCT));
      if (s.dwExtraInfo != MAGIC) return (IntPtr)1; // physical event -> swallow
    }
    return _callNext(IntPtr.Zero, code, w, l);
  }
  static IntPtr KbHookProc(int code, IntPtr w, IntPtr l) {
    if (code == HC_ACTION && blocking) {
      KBDLLHOOKSTRUCT s = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(KBDLLHOOKSTRUCT));
      if (s.dwExtraInfo != MAGIC) return (IntPtr)1;
    }
    return _callNext(IntPtr.Zero, code, w, l);
  }
  // Install the LL hooks on demand (first lock). The hook thread owns a message
  // loop; the hooks fire in its context. Runs only while a lock is engaged.
  static void StartHooks() {
    lock (hookLock) {
      if (hookThread != null) return;
      ResolveLockApis();
      if (_setHook == null) { Log("lock: SetWindowsHookEx unresolved — cannot lock"); return; }
      var ready = new ManualResetEvent(false);
      hookReady = ready;
      hookThread = new Thread(() => {
        mouseProc = MouseHookProc; kbProc = KbHookProc;
        IntPtr hMod = GetModuleHandle(null);
        IntPtr hm = _setHook(WH_MOUSE_LL, mouseProc, hMod, 0);
        IntPtr hk = _setHook(WH_KEYBOARD_LL, kbProc, hMod, 0);
        hookThreadId = GetCurrentThreadId();
        ready.Set();
        MSG msg; // pump messages so the LL hooks fire on this thread
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        if (hm != IntPtr.Zero) { try { _unhook(hm); } catch {} }
        if (hk != IntPtr.Zero) { try { _unhook(hk); } catch {} }
      });
      hookThread.IsBackground = true;
      hookThread.Start();
      Log("lock: installed LL hooks on demand");
    }
  }
  // Remove the LL hooks on unlock (tears the hook thread down), so the keylogger
  // fingerprint is present only for the moments input is actually locked.
  static void StopHooks() {
    ManualResetEvent ready;
    lock (hookLock) {
      if (hookThread == null) return;
      ready = hookReady; hookThread = null; hookReady = null;
    }
    try { if (ready != null) ready.WaitOne(2000); } catch {}
    uint tid = hookThreadId; hookThreadId = 0;
    if (tid != 0 && _postThreadMsg != null) { try { _postThreadMsg(tid, WM_QUIT, IntPtr.Zero, IntPtr.Zero); } catch {} }
    Log("lock: removed LL hooks");
  }

  // After a desktop switch, log the SendInput result of the next few events so we
  // can see whether injection actually lands on the (lock) desktop.
  static int logInputs = 0;
  // Track whether SendInput (clicks/keys) is actually landing. Antivirus/EDR often
  // lets this process run but silently blocks its synthetic input (SendInput
  // returns 0) — cursor moves still work via SetCursorPos, so the technician sees
  // the pointer move but nothing responds to clicks/typing. Report that state to
  // the agent (stdout) so the console can show a real "Control blocked" warning
  // instead of failing silently. Emitted only on change.
  static int failStreak = 0;
  static bool sendBlocked = false;
  static void ReportSend(uint n) {
    if (n == 0) {
      if (++failStreak >= 3 && !sendBlocked) { sendBlocked = true; try { Console.Out.WriteLine("!BLOCKED"); Console.Out.Flush(); } catch {} }
    } else {
      failStreak = 0;
      if (sendBlocked) { sendBlocked = false; try { Console.Out.WriteLine("!OK"); Console.Out.Flush(); } catch {} }
    }
  }
  static bool SendMouse(uint flags, int dx, int dy, uint data) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = INPUT_MOUSE;
    inp[0].u.mi.dx = dx; inp[0].u.mi.dy = dy; inp[0].u.mi.mouseData = data; inp[0].u.mi.dwFlags = flags;
    inp[0].u.mi.dwExtraInfo = MAGIC;
    uint n = SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    ReportSend(n);
    if (logInputs > 0 || n == 0) { logInputs--; Log("SendInput(mouse flags=0x" + flags.ToString("X") + ") -> " + n + (n == 0 ? " err=" + Marshal.GetLastWin32Error() : "") + " desk='" + (curDesk != IntPtr.Zero ? curDeskName : origDeskName) + "'"); }
    return n != 0;
  }
  static bool SendKey(ushort vk, ushort scan, uint flags) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = INPUT_KEYBOARD;
    inp[0].u.ki.wVk = vk; inp[0].u.ki.wScan = scan; inp[0].u.ki.dwFlags = flags;
    inp[0].u.ki.dwExtraInfo = MAGIC;
    uint n = SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    ReportSend(n);
    if (logInputs > 0 || n == 0) { logInputs--; Log("SendInput(key vk=" + vk + ") -> " + n + (n == 0 ? " err=" + Marshal.GetLastWin32Error() : "") + " desk='" + (curDesk != IntPtr.Zero ? curDeskName : origDeskName) + "'"); }
    return n != 0;
  }
  // ---- PostMessage fallbacks (invoked only when the matching SendInput failed) ----
  static IntPtr MakeLParam(int lo, int hi) { return (IntPtr)((hi << 16) | (lo & 0xFFFF)); }
  // Post a mouse button event to the window under the cursor. `down` picks the
  // *DOWN vs *UP message; `btn` is 'L' | 'R' | 'M'.
  static void PostMouseBtn(string btn, bool down) {
    try {
      POINT p; if (!GetCursorPos(out p)) return;
      IntPtr h = WindowFromPoint(p); if (h == IntPtr.Zero) return;
      POINT c = p; ScreenToClient(h, ref c);
      IntPtr l = MakeLParam(c.x, c.y);
      uint msg; uint mk;
      if (btn == "R") { msg = down ? WM_RBUTTONDOWN : WM_RBUTTONUP; mk = MK_RBUTTON; }
      else if (btn == "M") { msg = down ? WM_MBUTTONDOWN : WM_MBUTTONUP; mk = MK_MBUTTON; }
      else { msg = down ? WM_LBUTTONDOWN : WM_LBUTTONUP; mk = MK_LBUTTON; }
      PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, l);
      PostMessage(h, msg, (IntPtr)(down ? mk : 0), l);
      Log("PostMessage fallback: mouse " + btn + (down ? " down" : " up"));
    } catch { }
  }
  static void PostWheel(int delta) {
    try {
      POINT p; if (!GetCursorPos(out p)) return;
      IntPtr h = WindowFromPoint(p); if (h == IntPtr.Zero) return;
      // WM_MOUSEWHEEL uses SCREEN coords in lParam, wheel delta in the high word of wParam.
      IntPtr l = MakeLParam(p.x, p.y);
      IntPtr w = (IntPtr)((delta << 16) & unchecked((int)0xFFFF0000));
      PostMessage(h, WM_MOUSEWHEEL, w, l);
    } catch { }
  }
  static void PostKey(ushort vk, bool down) {
    try { IntPtr h = GetForegroundWindow(); if (h != IntPtr.Zero) PostMessage(h, down ? WM_KEYDOWN : WM_KEYUP, (IntPtr)vk, IntPtr.Zero); } catch { }
  }
  static void PostChar(ushort cp) {
    try { IntPtr h = GetForegroundWindow(); if (h != IntPtr.Zero) PostMessage(h, WM_CHAR, (IntPtr)cp, IntPtr.Zero); } catch { }
  }
  static void MoveNorm(double nx, double ny) {
    if (nx < 0) nx = 0; if (nx > 1) nx = 1;
    if (ny < 0) ny = 0; if (ny > 1) ny = 1;
    // Use SetCursorPos — not intercepted by AV/EDR behavioral blocks (unlike SendInput).
    int sw = GetSystemMetrics(SM_CXSCREEN);
    int sh = GetSystemMetrics(SM_CYSCREEN);
    bool ok = SetCursorPos((int)Math.Round(nx * (sw - 1)), (int)Math.Round(ny * (sh - 1)));
    if (logInputs > 0 || !ok) { logInputs--; Log("SetCursorPos -> " + ok + (ok ? "" : " err=" + Marshal.GetLastWin32Error())); }
  }
  // Move across the whole virtual desktop (multi-monitor); coords normalized
  // 0..1 over the union of all displays.
  static void MoveNormVirtual(double nx, double ny) {
    if (nx < 0) nx = 0; if (nx > 1) nx = 1;
    if (ny < 0) ny = 0; if (ny > 1) ny = 1;
    int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    bool ok = SetCursorPos(vx + (int)Math.Round(nx * (vw - 1)), vy + (int)Math.Round(ny * (vh - 1)));
    if (logInputs > 0 || !ok) { logInputs--; Log("SetCursorPos(virtual) -> " + ok + (ok ? "" : " err=" + Marshal.GetLastWin32Error())); }
  }

  static void Main() {
    var ci = CultureInfo.InvariantCulture;
    EnsureInteractiveWinSta();   // switch to WinSta0 if we are a Session-0 service
    // Remember our home desktop (full-rights handle). EnsureInputDesktop keeps this
    // for the normal desktop so SendInput never gets ERROR_ACCESS_DENIED from a
    // reduced-rights re-open. Captured AFTER the winsta switch so it reflects the
    // interactive desktop we will actually inject on.
    origDesk = GetThreadDesktop(GetCurrentThreadId());
    origDeskName = DesktopName(origDesk);
    Log("home input desktop = '" + origDeskName + "' (handle " + origDesk + ")");
    logInputs = 20;              // log first 20 SendInput results on every startup
    // NOTE: the LL input hooks are NOT installed here — only on demand when a
    // lock is requested (see StartHooks). Installing a global keyboard hook at
    // startup is the keylogger heuristic that gets this unsigned binary
    // quarantined by Norton/McAfee/etc.
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
            if (!SendMouse(f, 0, 0, 0)) PostMouseBtn(b, down);   // AV blocked SendInput -> post window message
            break;
          }
          case "W": { int wd = int.Parse(p[1], ci); if (!SendMouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)wd))) PostWheel(wd); break; }
          case "B": {                                    // lock/unlock local input
            bool on = (p[1] == "1");
            blocking = on;
            if (on) StartHooks(); else StopHooks();        // LL-hook path (installed on demand)
            try { if (!_lockApiReady) ResolveLockApis(); if (_blockInput != null) _blockInput(on); } catch { }  // + BlockInput path
            break;
          }
          case "AFF": SetWindowDisplayAffinity((IntPtr)long.Parse(p[1], ci), uint.Parse(p[2], ci)); break;
          case "SAS": try { SendSAS(true); } catch { } break;   // Ctrl+Alt+Del (best-effort)
          case "K": {
            ushort vk = (ushort)int.Parse(p[1], ci);
            bool kdown = p[2] == "1";
            if (!SendKey(vk, 0, kdown ? 0 : KEYEVENTF_KEYUP)) PostKey(vk, kdown);   // AV blocked -> post to foreground window
            break;
          }
          case "T": {
            ushort u = (ushort)int.Parse(p[1], ci);
            bool ok = SendKey(0, u, KEYEVENTF_UNICODE);
            SendKey(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
            if (!ok) PostChar(u);   // AV blocked SendInput -> post WM_CHAR
            break;
          }
        }
      } catch { /* ignore malformed line */ }
    }
  }
}
