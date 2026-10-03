// OffKeepSystemAwake.exe — one-shot toolbox companion to KeepSystemAwake.exe.
//
// Signals the running KeepSystemAwake instance to clean-exit, which restores
// the device's power settings (hardware power button, Start-menu Sleep/Shutdown
// visibility, idle timeouts) to the originals it saved before engaging.
//
// Deliberately a SEPARATE exe so an operator can one-click it from the Toolbox
// without typing arguments. Internally it just opens the shared named stop
// event and sets it. If no instance is running, it silently returns 0 — nothing
// to turn off is a no-op success.
//
// Compile with csc.exe (same pattern as the other helpers in this repo):
//   csc.exe /nologo /optimize+ /target:exe /out:offkeepsystemawake.exe OffKeepSystemAwake.cs
using System;
using System.Threading;

public class OffKeepSystemAwake {
  // Must stay in sync with KeepSystemAwake.cs's StopEventName.
  const string StopEventName = "Global\\HatchConnect.KeepAwake.Stop";

  public static int Main() {
    try {
      var ev = EventWaitHandle.OpenExisting(StopEventName);
      ev.Set();
      Console.WriteLine("KeepSystemAwake stopped — device power settings restored.");
    } catch (WaitHandleCannotBeOpenedException) {
      Console.WriteLine("KeepSystemAwake was not running — nothing to turn off.");
    } catch (Exception e) {
      Console.Error.WriteLine("OffKeepSystemAwake err: " + e.Message);
      return 1;
    }
    return 0;
  }
}
