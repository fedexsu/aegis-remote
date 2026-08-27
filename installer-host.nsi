; HatchConnect HOST (technician client) installer - silent, per-user, no admin.
; Installs the desktop client and registers the hatchconnect:// URL scheme so the
; website's Join button launches it. Double-click installs with no window.

Unicode true
Name "HatchConnect"
OutFile "release\HatchConnect-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\HatchConnect"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
SetCompressor /SOLID lzma

Section "Install"
  nsExec::Exec 'taskkill /F /IM HatchConnect.exe'
  Sleep 700

  SetOutPath "$INSTDIR"
  File /r "release\Host\*"

  ; Register the hatchconnect:// protocol for the current user (no admin needed).
  WriteRegStr HKCU "Software\Classes\hatchconnect" "" "URL:HatchConnect Protocol"
  WriteRegStr HKCU "Software\Classes\hatchconnect" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\hatchconnect\DefaultIcon" "" "$INSTDIR\HatchConnect.exe,0"
  WriteRegStr HKCU "Software\Classes\hatchconnect\shell\open\command" "" '"$INSTDIR\HatchConnect.exe" "%1"'

  ; Start menu + Add/Remove Programs
  CreateShortCut "$SMPROGRAMS\HatchConnect.lnk" "$INSTDIR\HatchConnect.exe"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HatchConnect" "DisplayName"     "HatchConnect"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HatchConnect" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HatchConnect" "DisplayIcon"     "$INSTDIR\HatchConnect.exe"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HatchConnect" "Publisher"       "HatchConnect"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HatchConnect" "DisplayVersion"  "0.1.0"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HatchConnect" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HatchConnect" "NoRepair" 1
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM HatchConnect.exe'
  Sleep 500
  DeleteRegKey HKCU "Software\Classes\hatchconnect"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HatchConnect"
  Delete "$SMPROGRAMS\HatchConnect.lnk"
  RMDir /r "$INSTDIR"
SectionEnd
