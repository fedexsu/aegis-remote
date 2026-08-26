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
  delegate bool EnumWndProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWndProc cb, IntPtr lp);

  // Hosts the Windows Media Player ActiveX control by CLSID, late-bound (no
  // interop DLL needed). Used to play a looping video cover.
  [System.ComponentModel.DesignerCategory("")]
  class WmpHost : AxHost { public WmpHost() : base("6BF52A52-394A-11d3-B153-00C04F79FAA6") { } }

  // Make the video's child windows follow the same rules as the black form:
  // excluded from capture, and click-through so injected input still reaches the
  // desktop underneath.
  static void ApplyChildren(IntPtr parent) {
    try {
      EnumChildWindows(parent, delegate (IntPtr h, IntPtr lp) {
        try {
          SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE);
          SetWindowLong(h, GWL_EXSTYLE, GetWindowLong(h, GWL_EXSTYLE) | WS_EX_TRANSPARENT);
        } catch { }
        return true;
      }, IntPtr.Zero);
    } catch { }
  }
  static void SetupVideo(Form f, string pathVideo) {
    try {
      WmpHost host = new WmpHost();
      host.Dock = DockStyle.Fill;
      f.Controls.Add(host);            // realizes the OCX
      dynamic ocx = host.GetOcx();
      ocx.uiMode = "none";
      ocx.stretchToFit = true;
      ocx.enableContextMenu = false;
      ocx.settings.autoStart = true;
      ocx.settings.setMode("loop", true);   // seamless-ish loop, no controls
      try { ocx.settings.volume = 0; } catch { }
      ocx.URL = pathVideo;
    } catch { f.BackColor = Color.Black; }
  }
  static void SetupGif(Form f, Image gif) {
    f.BackColor = Color.Black;
    bool anim = false; try { anim = ImageAnimator.CanAnimate(gif); } catch { }
    f.Paint += delegate (object s, PaintEventArgs e) {
      try {
        if (anim) ImageAnimator.UpdateFrames(gif);
        Rectangle cr = f.ClientRectangle;
        double k = Math.Min((double)cr.Width / gif.Width, (double)cr.Height / gif.Height);
        int w = (int)(gif.Width * k), h = (int)(gif.Height * k);
        e.Graphics.DrawImage(gif, (cr.Width - w) / 2, (cr.Height - h) / 2, w, h);
      } catch { }
    };
    if (anim) ImageAnimator.Animate(gif, delegate (object s, EventArgs e) { try { f.Invalidate(); } catch { } });
  }

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

    // Optional cover: first non-flag arg is a file shown fullscreen instead of
    // plain black. Image → all monitors (static). GIF → primary (seamless loop).
    // Video → primary (Windows Media Player, looping). Others stay black.
    string coverPath = (args.Length > 0 && args[0] != "--restore" && File.Exists(args[0])) ? args[0] : null;
    string ext = coverPath != null ? Path.GetExtension(coverPath).ToLowerInvariant() : "";
    bool isVideo = ext == ".mp4" || ext == ".webm" || ext == ".mov" || ext == ".avi" || ext == ".mkv" || ext == ".wmv" || ext == ".m4v";
    bool isGif = ext == ".gif";
    Image imgCover = null;
    if (coverPath != null && !isVideo) { try { imgCover = Image.FromStream(new MemoryStream(File.ReadAllBytes(coverPath))); } catch { imgCover = null; } }
    Form videoForm = null;

    foreach (Screen sc in Screen.AllScreens) {
      BlackForm f = new BlackForm();
      f.FormBorderStyle = FormBorderStyle.None;
      f.StartPosition = FormStartPosition.Manual;
      Rectangle b = sc.Bounds; b.Inflate(2, 2);   // slight overscan so no seams between monitors
      f.Bounds = b;
      f.BackColor = Color.Black;
      if (sc.Primary && isVideo) videoForm = f;                                  // set up after Show()
      else if (sc.Primary && isGif && imgCover != null) SetupGif(f, imgCover);    // animated loop
      else if (imgCover != null && !isVideo) { f.BackgroundImage = imgCover; f.BackgroundImageLayout = ImageLayout.Zoom; } // static image, all monitors
      f.ShowInTaskbar = false;
      f.TopMost = true;
      f.ControlBox = false;
      f.MinimizeBox = false; f.MaximizeBox = false;
      f.HandleCreated += delegate (object s, EventArgs e) { Apply(((Form)s).Handle); };
      forms.Add(f);
    }
    foreach (Form f in forms) f.Show();
    foreach (Form f in forms) Apply(f.Handle);
    if (videoForm != null) { SetupVideo(videoForm, coverPath); ApplyChildren(videoForm.Handle); }
    HideCursors();

    // Re-assert topmost aggressively so nothing (taskbar, Start, a toast
    // notification, a fullscreen app) can sit above the black screen.
    System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
    t.Interval = 150;
    Form vf = videoForm;
    t.Tick += delegate (object s, EventArgs e) {
      foreach (Form f in forms) { try { SetWindowPos(f.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); } catch { } }
      if (vf != null) { try { ApplyChildren(vf.Handle); } catch { } } // WMP can create its render window late
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
