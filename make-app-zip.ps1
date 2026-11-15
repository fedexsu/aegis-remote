# Creates release\app.zip from release\Aegis\ — upload this to B2 as app.zip
# Run: .\make-app-zip.ps1

$src = Join-Path $PSScriptRoot "release\Aegis"
$out = Join-Path $PSScriptRoot "release\app.zip"

if (Test-Path $out) { Remove-Item $out -Force }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($src, $out,
    [System.IO.Compression.CompressionLevel]::Optimal, $false)

$mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "Created $out ($mb MB)"
