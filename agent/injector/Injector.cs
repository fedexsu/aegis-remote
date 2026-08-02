// Aegis Remote — input injector.
// A tiny persistent console app: reads newline-delimited commands on stdin and
// injects OS-level mouse/keyboard input via Win32 SendInput. Compiled with the
// .NET Framework csc.exe that ships with Windows (see build-injector.js), so it
// needs no npm native module / node-gyp.
//
// Commands (space-separated, one per line):
//   M <nx> <ny>     move mouse to normalized position (0..1) on the primary screen
//   D <L|R|M>       mouse button down
//   U <L|R|M>       mouse button up
//   W <delta>       mouse wheel (positive = up)
//   K <vk> <1|0>    key by Windows virtual-key code, down(1)/up(0)
//   T <codepoint>   type a Unicode character (down+up)
using System;
using System.Runtime.InteropServices;
using System.Globalization;

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
  const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  static void SendMouse(uint flags, int dx, int dy, uint data) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = INPUT_MOUSE;
    inp[0].u.mi.dx = dx; inp[0].u.mi.dy = dy; inp[0].u.mi.mouseData = data; inp[0].u.mi.dwFlags = flags;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
  static void SendKey(ushort vk, ushort scan, uint flags) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = INPUT_KEYBOARD;
    inp[0].u.ki.wVk = vk; inp[0].u.ki.wScan = scan; inp[0].u.ki.dwFlags = flags;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
  static void MoveNorm(double nx, double ny) {
    if (nx < 0) nx = 0; if (nx > 1) nx = 1;
    if (ny < 0) ny = 0; if (ny > 1) ny = 1;
    int ax = (int)Math.Round(nx * 65535.0);
    int ay = (int)Math.Round(ny * 65535.0);
    SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ax, ay, 0);
  }

  static void Main() {
    var ci = CultureInfo.InvariantCulture;
    string line;
    while ((line = Console.ReadLine()) != null) {
      try {
        string[] p = line.Split(' ');
        switch (p[0]) {
          case "M": MoveNorm(double.Parse(p[1], ci), double.Parse(p[2], ci)); break;
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
