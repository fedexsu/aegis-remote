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

Section "Install"
  StrCpy $0 "$EXEFILE"
  StrCpy $0 $0 -4
  StrCpy $KEY $0 "" 16     ; support-service-<key>.exe -> <key>

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

  ; Add/Remove Programs + uninstaller (machine-wide → HKLM)
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "DisplayName"     "Support (Service)"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "DisplayIcon"     "$INSTDIR\support.exe"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "Publisher"       "Support"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support" "NoRepair" 1
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; install + start the service (it launches the agent into the active session as SYSTEM)
  nsExec::Exec '"$INSTDIR\AegisService.exe" /install'
SectionEnd

Section "Uninstall"
  nsExec::Exec '"$INSTDIR\AegisService.exe" /uninstall'
  Sleep 800
  nsExec::Exec 'taskkill /F /IM support.exe'
  nsExec::Exec 'taskkill /F /IM injector.exe'
  Sleep 600
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Support"
  RMDir /r "$INSTDIR"
SectionEnd
