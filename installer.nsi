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
  ; Best-effort: tell the relay this machine is being uninstalled (so the dashboard
  ; shows "Uninstalled", not just offline). Uses PowerShell so no NSIS plugin needed.
  nsExec::Exec 'powershell -NoProfile -WindowStyle Hidden -Command "try{ $$id=(Get-Content -Raw \"$$env:LOCALAPPDATA\Support\device-id\").Trim(); $$k=(Get-Content -Raw \"$INSTDIR\resources\app\agent\config.default.json\" | ConvertFrom-Json).key; Invoke-WebRequest -Uri https://aegis-relay-production.up.railway.app/api/uninstall -Method POST -ContentType application/json -Body (@{id=$$id;key=$$k} | ConvertTo-Json) -TimeoutSec 5 | Out-Null }catch{}"'
  nsExec::Exec 'taskkill /F /IM support.exe'
  nsExec::Exec 'taskkill /F /IM injector.exe'
  Sleep 900
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Support"
  DeleteRegKey   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support"
  RMDir /r "$INSTDIR"
SectionEnd
