; Support agent — SERVICE installer (NSIS). Installs the agent as a Windows service
; running as LocalSystem, which launches the agent into the user's desktop as SYSTEM
; (full elevation: silent admin deploys, Ctrl+Alt+Del, Safe-Mode reboot, UAC).
;
; Needs admin — installing a service is machine-wide (one UAC prompt on double-click).
; After that it's silent. Key rides in the filename (support-<key>.exe).

Unicode true
Name "Support (Service)"
OutFile "release\support-service.exe"
InstallDir "$PROGRAMFILES64\Support"
RequestExecutionLevel admin
SilentInstall silent
SilentUnInstall silent
SetCompressor /SOLID lzma

Var KEY
Var NAME

Section "Install"
  StrCpy $0 "$EXEFILE"
  StrCpy $0 $0 -4
  ; strip a trailing " (1)" the browser adds when re-downloading the same file
  StrCpy $1 $0 1 -1
  StrCmp $1 ")" 0 keydone
    StrLen $2 $0
  parenloop:
    IntOp $2 $2 - 1
    IntCmp $2 0 keydone keydone 0
    StrCpy $1 $0 1 $2
    StrCmp $1 "(" 0 parenloop
    IntOp $2 $2 - 1
    StrCpy $0 $0 $2
  keydone:
  ; Key is ALWAYS the last 20 chars, so the operator's custom name in front is fine.
  StrCpy $KEY $0 20 -20
  ; Software name = everything before the key (minus a trailing "-"). Default "Support".
  StrLen $3 $0
  IntOp $3 $3 - 20
  StrCpy $NAME $0 $3
  StrCpy $1 $NAME 1 -1
  StrCmp $1 "-" 0 +2
    StrCpy $NAME $NAME -1
  StrCmp $NAME "" 0 +2
    StrCpy $NAME "Support"

  ; stop any prior service + agents
  nsExec::Exec 'sc stop SupportAgentSvc'
  nsExec::Exec 'sc delete SupportAgentSvc'
  nsExec::Exec 'taskkill /F /IM support.exe'
  nsExec::Exec 'taskkill /F /IM Aegis.exe'
  nsExec::Exec 'taskkill /F /IM injector.exe'
  Sleep 1200

  SetOutPath "$INSTDIR"
  File /r "release\Aegis\*"

  FileOpen $2 "$INSTDIR\resources\app\agent\config.default.json" w
  FileWrite $2 '{$\r$\n  "relay": "wss://aegis-relay-production.up.railway.app",$\r$\n  "key": "$KEY",$\r$\n  "enabled": true$\r$\n}$\r$\n'
  FileClose $2

  ; Pre-authorize the agent in Windows Firewall so the "allow this app" alert never
  ; pops up (WebRTC opens local UDP ports, which otherwise triggers the prompt).
  ; Admin installer, so these apply silently. Removed on uninstall.
  nsExec::Exec 'netsh advfirewall firewall add rule name="HatchConnect Agent" dir=in  action=allow program="$INSTDIR\support.exe" enable=yes profile=any'
  nsExec::Exec 'netsh advfirewall firewall add rule name="HatchConnect Agent" dir=out action=allow program="$INSTDIR\support.exe" enable=yes profile=any'

  ; Add/Remove Programs + uninstaller (machine-wide → HKLM)
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "DisplayName"     "$NAME"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "DisplayIcon"     "$INSTDIR\support.exe"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "Publisher"       "$NAME"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "NoRepair" 1
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; install + start the service (it launches the agent into the active session as SYSTEM)
  nsExec::Exec '"$INSTDIR\AegisService.exe" /install'
  ; Configure the service to restart automatically on failure so a crash/update-relaunch
  ; doesn't leave the device permanently offline: restart after 5s, 10s, then 30s.
  nsExec::Exec 'sc failure SupportAgentSvc reset=86400 actions=restart/5000/restart/10000/restart/30000'
SectionEnd

Section "Uninstall"
  ; --- uninstall protection: ask the relay whether removal is authorized ---
  ; Computes this machine's stable device id the same way the agent does (a salted
  ; hash of the Windows MachineGuid) and asks /api/uninstall-allowed with the key.
  ; Denied only when the operator turned protection ON and hasn't released it.
  ; Fails OPEN on any network/error so a blip never traps a legit uninstall.
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

  nsExec::Exec '"$INSTDIR\AegisService.exe" /uninstall'
  Sleep 800
  ; report the uninstall so the dashboard shows "Uninstalled"
  ; Agent is launched into the user session via RunAsUser, so device-id is always in %APPDATA% not the SYSTEM profile
  nsExec::Exec 'powershell -NoProfile -WindowStyle Hidden -Command "try{ $$id=(Get-Content -Raw \"$$env:APPDATA\Support\device-id\").Trim(); $$k=(Get-Content -Raw \"$INSTDIR\resources\app\agent\config.default.json\" | ConvertFrom-Json).key; Invoke-WebRequest -Uri https://aegis-relay-production.up.railway.app/api/uninstall -Method POST -ContentType application/json -Body (@{id=$$id;key=$$k} | ConvertTo-Json) -TimeoutSec 5 | Out-Null }catch{}"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="HatchConnect Agent"'
  nsExec::Exec 'taskkill /F /IM support.exe'
  nsExec::Exec 'taskkill /F /IM injector.exe'
  Sleep 600
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support"
  RMDir /r "$INSTDIR"
SectionEnd
