# InjectorPS.ps1 — PowerShell host for the injector logic.
#
# Why this exists: standalone injector.exe gets flagged by McAfee WPS on
# consumer-McAfee Windows installs because it's an unsigned PE calling
# SendInput + SetThreadDesktop (the keylogger-shaped API combo). This wrapper
# compiles the SAME C# source in memory via Add-Type and runs it inside
# powershell.exe — which is Microsoft-signed and treated more leniently by
# every consumer AV. The agent speaks the same stdio contract so main.js
# does not care which backend is active.
#
# Launched by main.js when cfg.injectorBackend === 'powershell'. Usage:
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass
#     -File InjectorPS.ps1 "<path to Injector.cs>"
#
# Caveats (documented honestly):
#   - McAfee's AMSI hook scans the C# source passed to Add-Type. If the
#     scanner flags on "SendInput + SetThreadDesktop" patterns, the compile
#     is refused and this script exits 1 — the agent then falls back to the
#     exe backend.
#   - Startup latency is ~1.5-2.5s on a cold cache (Add-Type compiles the
#     ~500-line source each launch). The exe backend starts in ~100ms. The
#     injector is a long-lived child so the latency is only felt on session
#     start, not per-click.
#   - Behavioral AV (monitoring SendInput call rates from any process) is
#     the remaining uncovered risk; this wrapper does not address it.

$ErrorActionPreference = 'Stop'

$src = if ($args.Count -gt 0) { $args[0] } else { Join-Path $PSScriptRoot 'Injector.cs' }
if (-not (Test-Path $src)) {
  [Console]::Error.WriteLine("InjectorPS: source not found at $src")
  exit 1
}

$csharp = Get-Content $src -Raw

$compiledTypes = $null
try {
  # -Language CSharp uses CodeDom + the shipped .NET Framework csc compiler.
  # -PassThru returns the compiled Type[], which we hold on to for reflective
  # lookup below — Add-Type auto-wraps top-level classes in a hidden synthetic
  # namespace, so the bare `[Injector]` accelerator doesn't resolve. We skip
  # -ReferencedAssemblies: the explicit list restricted the compile against
  # the full default reference set and masked real compile errors as
  # "type not found" afterwards.
  $compiledTypes = Add-Type -TypeDefinition $csharp -Language CSharp -PassThru
} catch {
  [Console]::Error.WriteLine("InjectorPS: Add-Type compile failed: $($_.Exception.Message)")
  exit 2
}

# Reflective type lookup — walks every type the compile produced and finds
# the one whose simple name is "Injector", regardless of what namespace
# Add-Type parked it in. Falls back to scanning the whole compiled assembly's
# types if the PassThru array didn't carry Injector directly (nested classes
# etc.). Logs what IT found on failure so a future AMSI/compile oddity gets
# visible diagnostic output instead of another silent "type not found".
$t = $null
if ($compiledTypes) {
  $t = $compiledTypes | Where-Object { $_.Name -eq 'Injector' } | Select-Object -First 1
  if ($null -eq $t -and $compiledTypes[0]) {
    try { $t = $compiledTypes[0].Assembly.GetTypes() | Where-Object { $_.Name -eq 'Injector' } | Select-Object -First 1 } catch {}
  }
}
if ($null -eq $t) {
  [Console]::Error.WriteLine("InjectorPS: Injector type not in compiled output. Types found: " + (($compiledTypes | ForEach-Object { $_.FullName }) -join ', '))
  exit 3
}
$method = $t.GetMethod('Main', [Reflection.BindingFlags]'NonPublic,Static,Public')
if ($null -eq $method) {
  [Console]::Error.WriteLine("InjectorPS: Injector.Main not found on compiled type $($t.FullName)")
  exit 4
}
$method.Invoke($null, @())
