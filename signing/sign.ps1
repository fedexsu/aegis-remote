# Signs one or more files with Azure Trusted Signing via signtool + the dlib.
# Requires: signing/metadata.json filled in, and the service-principal env vars
# AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET set.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)
$ErrorActionPreference = 'Stop'

$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$signtool = Join-Path $here 'tools\signtool\signtool.exe'
$dlib     = Join-Path $here 'tools\dlib\Azure.CodeSigning.Dlib.dll'
$meta     = Join-Path $here 'metadata.json'

if (-not (Test-Path $signtool)) { Write-Error "signtool missing - run: python signing/download-tools.py"; exit 1 }
if (-not (Test-Path $meta))     { Write-Error "signing/metadata.json not found (copy metadata.example.json and fill it in)"; exit 1 }

$m = Get-Content $meta -Raw
if ($m -match '<REGION>' -or $m -match '<YOUR') { Write-Error "Fill in signing/metadata.json first (endpoint / account / profile)."; exit 1 }
if (-not $env:AZURE_TENANT_ID -or -not $env:AZURE_CLIENT_ID -or -not $env:AZURE_CLIENT_SECRET) {
  Write-Error "Set AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET (service principal) before signing."; exit 1
}

foreach ($f in $Files) {
  if (-not (Test-Path $f)) { Write-Warning "skip (missing): $f"; continue }
  Write-Output "Signing $f ..."
  & $signtool sign /v /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 `
      /dlib $dlib /dmdf $meta $f
  if ($LASTEXITCODE -ne 0) { Write-Error "signtool failed on $f (exit $LASTEXITCODE)"; exit $LASTEXITCODE }
}
Write-Output "All files signed."
