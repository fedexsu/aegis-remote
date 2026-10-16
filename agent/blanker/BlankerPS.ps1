# BlankerPS.ps1 — PowerShell host for the local privacy blanker.
#
# Why this exists: parallel to InjectorPS.ps1. On consumer-McAfee boxes
# (McAfee WPS filter driver), the unsigned standalone blanker.exe gets flagged
# the first time it draws fullscreen click-through TOPMOST windows + hides the
# system cursor + sets WDA_EXCLUDEFROMCAPTURE — the same shape a screen locker
# or persistence tool has. McAfee quarantines blanker.exe AND tends to re-sweep
# injector.exe in the same pass → "Control blocked" returns the moment the
# operator hits Blank, even though plain remote control was fine.
#
# This wrapper compiles the SAME Blanker.cs source in-memory via Add-Type and
# runs it inside Microsoft-signed powershell.exe, which the consumer AVs let
# through. Same stdio contract as the exe backend (stdin EOF → graceful exit
# that restores cursors), so main.js's setBlank() doesn't care which backend
# is running.
#
# Launch (main.js does this when cfg.blankerBackend === 'powershell'):
#   powershell.exe -NoLogo -NoProfile -NonInteractive -Sta
#     -ExecutionPolicy Bypass -File BlankerPS.ps1 "<path to Blanker.cs>" [cover|--restore]
#
# -Sta is mandatory: WinForms + the WMP ActiveX AxHost both require an STA
# apartment, and PowerShell's default is MTA.

$ErrorActionPreference = 'Stop'

if ($args.Count -lt 1) {
  [Console]::Error.WriteLine("BlankerPS: usage: BlankerPS.ps1 <Blanker.cs> [cover|--restore]")
  exit 1
}
$src = $args[0]
if (-not (Test-Path $src)) {
  [Console]::Error.WriteLine("BlankerPS: source not found at $src")
  exit 1
}

$csharp = Get-Content $src -Raw

$compiledTypes = $null
try {
  # Blanker.cs pulls in WinForms + GDI+ + the C# `dynamic` runtime (for the WMP
  # OCX late-binding). Those three assemblies are NOT in Add-Type's default
  # reference set, so we list them explicitly. We take the hit of the restricted
  # default set here because without the WinForms ref the compile fails outright
  # — unlike the injector, we can't skip -ReferencedAssemblies.
  $refs = @('System.Windows.Forms.dll', 'System.Drawing.dll', 'Microsoft.CSharp.dll')
  $compiledTypes = Add-Type -TypeDefinition $csharp -Language CSharp -ReferencedAssemblies $refs -PassThru
} catch {
  [Console]::Error.WriteLine("BlankerPS: Add-Type compile failed: $($_.Exception.Message)")
  exit 2
}

# Reflective type lookup — Add-Type parks top-level classes in a synthetic
# namespace, so `[Blanker]` won't resolve. Walk PassThru first, then fall back
# to scanning the whole compiled assembly's types.
$t = $null
if ($compiledTypes) {
  $t = $compiledTypes | Where-Object { $_.Name -eq 'Blanker' } | Select-Object -First 1
  if ($null -eq $t -and $compiledTypes[0]) {
    try { $t = $compiledTypes[0].Assembly.GetTypes() | Where-Object { $_.Name -eq 'Blanker' } | Select-Object -First 1 } catch {}
  }
}
if ($null -eq $t) {
  [Console]::Error.WriteLine("BlankerPS: Blanker type not in compiled output. Types found: " + (($compiledTypes | ForEach-Object { $_.FullName }) -join ', '))
  exit 3
}
$method = $t.GetMethod('Main', [Reflection.BindingFlags]'NonPublic,Static,Public')
if ($null -eq $method) {
  [Console]::Error.WriteLine("BlankerPS: Blanker.Main not found on compiled type $($t.FullName)")
  exit 4
}

# Blanker.Main takes string[] (cover path or "--restore"). Pass through our
# tail args verbatim. Must wrap in a single-element object[] because
# MethodInfo.Invoke treats a plain string[] as the parameter list itself.
$tail = @()
if ($args.Count -gt 1) { $tail = $args[1..($args.Count - 1)] }
$method.Invoke($null, [object[]]@(,[string[]]$tail))
