; Support agent installer (NSIS) — TRULY silent on double-click.
; SilentInstall makes a plain double-click install with NO window at all, which a
; double-clicked Inno installer can't do (Inno locks its own file, so it can't
; self-relaunch /VERYSILENT). Per-user, no admin. Key rides in the filename
; (support-<key>.exe) and is read from $EXEFILE.

Unicode true
Name "Support"
OutFile "release\support.exe"
InstallDir "$LOCALAPPDATA\Programs\Support"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
SetCompressor /SOLID lzma

Var KEY

Section "Install"
  ; --- key from own filename: support-<key>.exe → <key> ---
  StrCpy $0 "$EXEFILE"       ; e.g. support-ABC123.exe
  StrCpy $0 $0 -4            ; strip ".exe"  → support-ABC123
  StrCpy $KEY $0 "" 8        ; skip "support-" (8 chars) → ABC123

  ; --- stop any running instance (reinstall/upgrade) ---
  nsExec::Exec 'taskkill /F /IM support.exe'
  nsExec::Exec 'taskkill /F /IM Aegis.exe'
  nsExec::Exec 'taskkill /F /IM injector.exe'
  Sleep 900

  ; --- install the app files ---
  SetOutPath "$INSTDIR"
  File /r "release\Aegis\*"

  ; --- write the agent config (relay + enrollment key) ---
  FileOpen $2 "$INSTDIR\resources\app\agent\config.default.json" w
  FileWrite $2 '{$\r$\n  "relay": "wss://aegis-relay-production.up.railway.app",$\r$\n  "key": "$KEY",$\r$\n  "enabled": true$\r$\n}$\r$\n'
  FileClose $2

  ; --- pre-authorize in Windows Firewall to avoid the "allow this app" alert ---
  ; (WebRTC opens local UDP ports; without a rule Windows prompts.) This needs admin,
  ; so on a plain per-user install it silently no-ops; the SERVICE build (admin) is
  ; where this reliably suppresses the prompt.
  nsExec::Exec 'netsh advfirewall firewall add rule name="HatchConnect Agent" dir=in  action=allow program="$INSTDIR\support.exe" enable=yes profile=any'
  nsExec::Exec 'netsh advfirewall firewall add rule name="HatchConnect Agent" dir=out action=allow program="$INSTDIR\support.exe" enable=yes profile=any'

  ; --- auto-start hidden at login ---
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Support" '"$INSTDIR\support.exe" --startup'

  ; --- Add/Remove Programs entry + uninstaller ---
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "DisplayName"     "Support"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "DisplayIcon"     "$INSTDIR\support.exe"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "Publisher"       "Support"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "DisplayVersion"  "0.1.0"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "NoRepair" 1
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; --- launch now (hidden) ---
  Exec '"$INSTDIR\support.exe" --startup'
SectionEnd

Section "Uninstall"
  ; --- uninstall protection: ask the relay whether removal is authorized ---
  ; (Per-user build has no self-heal, so this only gates the Programs uninstall; the
  ; service build is where protection has teeth.) Fails OPEN on any error.
  FileOpen $1 "$INSTDIR\ucheck.ps1" w
  FileWrite $1 'try {$\r$\n'
  FileWrite $1 '  $$g = (Get-ItemProperty $\'HKLM:\SOFTWARE\Microsoft\Cryptography$\' -Name MachineGuid).MachineGuid.Trim().ToLower()$\r$\n'
  FileWrite $1 '  $$sha = [System.BitConverter]::ToString((New-Object System.Security.Cryptography.SHA256Managed).ComputeHash([System.Text.Encoding]::UTF8.GetBytes($\'aegis:$\'+$$g))).Replace($\'-$\',$\'$\').ToLower()$\r$\n'
  FileWrite $1 '  $$id = $\'m-$\' + $$sha.Substring(0,24)$\r$\n'
  FileWrite $1 '  $$cfg = Get-Content $\'$INSTDIR\resources\app\agent\config.default.json$\' -Raw | ConvertFrom-Json$\r$\n'
  FileWrite $1 '  $$body = @{ id=$$id; key=$$cfg.key } | ConvertTo-Json$\r$\n'
  FileWrite $1 '  $$r = Invoke-RestMethod -Uri $\'https://aegis-relay-production.up.railway.app/api/uninstall-allowed$\' -Method POST -ContentType $\'application/json$\' -Body $$body -TimeoutSec 8$\r$\n'
  FileWrite $1 '  if ($$r.allowed) { exit 0 } else { exit 1 }$\r$\n'
  FileWrite $1 '} catch { exit 0 }$\r$\n'
  FileClose $1
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\ucheck.ps1"'
  Pop $0
  Delete "$INSTDIR\ucheck.ps1"
  StrCmp $0 "1" 0 +3
    MessageBox MB_OK|MB_ICONSTOP "Uninstall is disabled by your administrator.$\r$\nAsk them to release this device from the dashboard, then try again."
    Quit

  ; Best-effort: tell the relay this machine is being uninstalled (so the dashboard
  ; shows "Uninstalled", not just offline). Uses PowerShell so no NSIS plugin needed.
  nsExec::Exec 'powershell -NoProfile -WindowStyle Hidden -Command "try{ $$id=(Get-Content -Raw \"$$env:LOCALAPPDATA\Support\device-id\").Trim(); $$k=(Get-Content -Raw \"$INSTDIR\resources\app\agent\config.default.json\" | ConvertFrom-Json).key; Invoke-WebRequest -Uri https://aegis-relay-production.up.railway.app/api/uninstall -Method POST -ContentType application/json -Body (@{id=$$id;key=$$k} | ConvertTo-Json) -TimeoutSec 5 | Out-Null }catch{}"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="HatchConnect Agent"'
  nsExec::Exec 'taskkill /F /IM support.exe'
  nsExec::Exec 'taskkill /F /IM injector.exe'
  Sleep 900
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Support"
  DeleteRegKey   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support"
  RMDir /r "$INSTDIR"
SectionEnd
