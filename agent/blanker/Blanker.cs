// Aegis Remote — local privacy blanker.
//
// Puts a fullscreen opaque-black, click-through, always-on-top window over every
// monitor and flags each with WDA_EXCLUDEFROMCAPTURE (0x11): the window shows on
// the PHYSICAL screen (the person at the machine sees black) but is excluded from
// screen capture, so the technician's live view still shows the real desktop.
//
// Why a separate process instead of an Electron window: SetWindowDisplayAffinity
// only succeeds when called by the process that OWNS the window. An Electron
// BrowserWindow is owned by the Electron process, and setting affinity on it from
// our injector (a different process) is denied by Windows — so the black window
// leaked into the capture and blanked BOTH screens. Here the C# process owns the
// windows, so the affinity call succeeds.
//
// Click-through (WS_EX_TRANSPARENT) + non-activating (WS_EX_NOACTIVATE) so the
// technician's injected mouse/keyboard still reach the desktop underneath.
//
// Lifetime: runs until its parent (the agent) kills the process or closes stdin.
// Compiled by build-blanker.js with the .NET Framework csc.exe shipped in Windows.
using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;

class Blanker {
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);
  [DllImport("user32.dll", SetLastError = true)] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int index, int val);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  // Hide the local cursor while blanked (the hardware cursor renders above every
  // window, so a black window alone can't cover it).
  [DllImport("user32.dll")] static extern IntPtr CreateCursor(IntPtr hInst, int xHot, int yHot, int w, int h, byte[] andPlane, byte[] xorPlane);
  [DllImport("user32.dll")] static extern bool SetSystemCursor(IntPtr hcur, uint id);
  [DllImport("user32.dll")] static extern IntPtr CopyIcon(IntPtr h);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint uParam, IntPtr vParam, uint winIni);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto)] static extern IntPtr GetModuleHandle(string n);

  const int GWL_EXSTYLE = -20;
  const int WS_EX_LAYERED = 0x00080000, WS_EX_TRANSPARENT = 0x00000020, WS_EX_TOOLWINDOW = 0x00000080, WS_EX_NOACTIVATE = 0x08000000;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOMOVE = 0x2, SWP_NOSIZE = 0x1, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;
  const uint WDA_EXCLUDEFROMCAPTURE = 0x11;
  const uint LWA_ALPHA = 0x2;
  const uint SPI_SETCURSORS = 0x0057;
  // Every standard system cursor id (OCR_*), so no shape leaks the pointer.
  static readonly uint[] OCR_IDS = { 32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651 };

  static List<Form> forms = new List<Form>();
  static bool cursorsHidden = false;

  // Replace every system cursor with a fully transparent one.
  static void HideCursors() {
    try {
      int w = 32, h = 32, bytes = w * h / 8;
      byte[] and = new byte[bytes]; for (int i = 0; i < bytes; i++) and[i] = 0xFF; // AND=1, XOR=0 -> transparent
      byte[] xor = new byte[bytes];
      IntPtr blank = CreateCursor(GetModuleHandle(null), 0, 0, w, h, and, xor);
      if (blank == IntPtr.Zero) return;
      foreach (uint id in OCR_IDS) { IntPtr c = CopyIcon(blank); if (c != IntPtr.Zero) SetSystemCursor(c, id); } // SetSystemCursor destroys the handle it's given
      cursorsHidden = true;
    } catch { }
  }
  static void RestoreCursors() {
    if (!cursorsHidden) return;
    try { SystemParametersInfo(SPI_SETCURSORS, 0, IntPtr.Zero, 0); } catch { } // reload the real cursors
    cursorsHidden = false;
  }

  // A black window that never steals focus and is invisible to screen capture.
  class BlackForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get {
        CreateParams cp = base.CreateParams;
        cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
        return cp;
      }
    }
  }

  static void Apply(IntPtr h) {
    try {
      int ex = GetWindowLong(h, GWL_EXSTYLE);
      SetWindowLong(h, GWL_EXSTYLE, ex | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
      SetLayeredWindowAttributes(h, 0, 255, LWA_ALPHA);      // fully opaque black
      SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE);   // physical screen: yes; capture: no
      SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    } catch { }
  }

  [STAThread]
  static void Main(string[] args) {
    // Safety mode: the agent runs `blanker.exe --restore` on startup so a prior
    // hard-kill (that skipped our cleanup) can never leave cursors hidden.
    if (args.Length > 0 && args[0] == "--restore") {
      try { SystemParametersInfo(SPI_SETCURSORS, 0, IntPtr.Zero, 0); } catch { }
      return;
    }
    try { SetProcessDPIAware(); } catch { }

    // Optional cover image: first non-flag arg is a file to show fullscreen
    // instead of plain black (loaded via a copy so the file isn't left locked).
    Image cover = null;
    if (args.Length > 0 && args[0] != "--restore") {
      try { if (File.Exists(args[0])) cover = Image.FromStream(new MemoryStream(File.ReadAllBytes(args[0]))); } catch { cover = null; }
    }

    foreach (Screen sc in Screen.AllScreens) {
      BlackForm f = new BlackForm();
      f.FormBorderStyle = FormBorderStyle.None;
      f.StartPosition = FormStartPosition.Manual;
      Rectangle b = sc.Bounds; b.Inflate(2, 2);   // slight overscan so no seams between monitors
      f.Bounds = b;
      f.BackColor = Color.Black;
      if (cover != null) { f.BackgroundImage = cover; f.BackgroundImageLayout = ImageLayout.Zoom; } // fit, black bars, no distortion
      f.ShowInTaskbar = false;
      f.TopMost = true;
      f.ControlBox = false;
      f.MinimizeBox = false; f.MaximizeBox = false;
      f.HandleCreated += delegate (object s, EventArgs e) { Apply(((Form)s).Handle); };
      forms.Add(f);
    }
    foreach (Form f in forms) f.Show();
    foreach (Form f in forms) Apply(f.Handle);
    HideCursors();

    // Re-assert topmost aggressively so nothing (taskbar, Start, a toast
    // notification, a fullscreen app) can sit above the black screen.
    System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
    t.Interval = 150;
    t.Tick += delegate (object s, EventArgs e) {
      foreach (Form f in forms) { try { SetWindowPos(f.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); } catch { } }
    };
    t.Start();

    // Always restore the cursors, however we exit.
    Application.ApplicationExit += delegate (object s, EventArgs e) { RestoreCursors(); };

    // Exit cleanly when the parent closes our stdin (or the agent is killed —
    // our stdin then hits EOF, so the cursors are restored even in that case).
    Thread th = new Thread(delegate () {
      try { while (Console.ReadLine() != null) { } } catch { }
      try { Application.Exit(); } catch { }
    });
    th.IsBackground = true; th.Start();

    Application.Run();
    RestoreCursors();
  }
}
