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
Var NAME2        ; optional second software name (dual-install mode)
Var INSTANCE     ; which copy we're installing (1 or 2); baked into config.default.json
Var INSTDIR_1    ; absolute install dir for copy #1
Var INSTDIR_2    ; absolute install dir for copy #2
Var SVCNAME_1    ; windows service name for copy #1 (default SupportAgentSvc)
Var SVCNAME_2    ; windows service name for copy #2
Var ARPKEY_1     ; HKLM Uninstall subkey for copy #1 (default Support)
Var ARPKEY_2     ; HKLM Uninstall subkey for copy #2
Var FWRULE_1     ; firewall rule display name for copy #1
Var FWRULE_2     ; firewall rule display name for copy #2
Var METATMP      ; temp file for /api/key-meta response

; ---------- one-copy install block ----------------------------------
; Writes files, config, firewall rule, ARP entry, and starts the service for
; ONE install location. Called once for single-install, twice for dual-install.
; Inputs are read from the paired Var set (INSTDIR_$INSTANCE / NAME / SVCNAME /
; ARPKEY / FWRULE) so a single macro body serves both runs.
!macro INSTALL_ONE _idx _instdir _name _svc _arp _fw
  ; stop any prior service + agents at this location
  nsExec::Exec 'sc stop "${_svc}"'
  nsExec::Exec 'sc delete "${_svc}"'
  Sleep 400

  CreateDirectory "${_instdir}"
  SetOutPath "${_instdir}"
  File /r "release\Aegis\*"

  ; Config file: same key + same device-id derivation, differing only by
  ; "instance" so the relay can tell copy #1 from copy #2 when both connect.
  FileOpen $2 "${_instdir}\resources\app\agent\config.default.json" w
  FileWrite $2 '{$\r$\n  "relay": "wss://aegis-relay-production.up.railway.app",$\r$\n  "key": "$KEY",$\r$\n  "enabled": true,$\r$\n  "instance": ${_idx},$\r$\n  "appName": "${_name}"$\r$\n}$\r$\n'
  FileClose $2

  ; Firewall allow rules — unique display name per copy so uninstall of one
  ; cleanly removes only ITS rules.
  nsExec::Exec 'netsh advfirewall firewall add rule name="${_fw}" dir=in  action=allow program="${_instdir}\support.exe" enable=yes profile=any'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${_fw}" dir=out action=allow program="${_instdir}\support.exe" enable=yes profile=any'

  ; ARP entry under a unique subkey so each copy appears separately in
  ; Add/Remove Programs. Both uninstallers call back into this same NSIS binary
  ; (uninstall.exe), which keys off its own location to know which to clean up.
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${_arp}" "DisplayName"     "${_name}"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${_arp}" "UninstallString" '"${_instdir}\uninstall.exe"'
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${_arp}" "DisplayIcon"     "${_instdir}\support.exe"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${_arp}" "Publisher"       "${_name}"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${_arp}" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${_arp}" "NoRepair" 1
  ; Side markers kept in the registry so the dashboard / support ops can see
  ; which service belongs to which copy without opening the install folder.
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${_arp}" "InstanceIdx"     "${_idx}"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${_arp}" "ServiceName"     "${_svc}"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${_arp}" "FirewallRule"    "${_fw}"
  ; AND a self-contained tag file inside the install folder itself. The
  ; uninstaller.exe lives in ${_instdir} and reads this file to learn its own
  ; identity (ARP subkey name, service name, firewall rule name) — no cross-
  ; copy registry probes, no ambiguity when two copies exist side by side.
  FileOpen $3 "${_instdir}\.hc-uninstall-tag" w
  FileWrite $3 'ARP=${_arp}$\r$\n'
  FileWrite $3 'SVC=${_svc}$\r$\n'
  FileWrite $3 'FW=${_fw}$\r$\n'
  FileWrite $3 'IDX=${_idx}$\r$\n'
  FileClose $3
  WriteUninstaller "${_instdir}\uninstall.exe"

  ; install + start the per-copy service (launches the agent into the active
  ; session as SYSTEM). AegisService.exe reads the service name from its own
  ; argv so each copy gets a unique registered service — see /install flag.
  nsExec::Exec '"${_instdir}\AegisService.exe" /install /svc:${_svc}'
  nsExec::Exec 'sc failure "${_svc}" reset=86400 actions=restart/5000/restart/10000/restart/30000'
!macroend

Section "Install"
  StrCpy $0 "$EXEFILE"
  StrCpy $0 $0 -4
  ; Strip trailing " (1)" suffixes the browser adds on re-download / dup — a
  ; customer that downloads the installer a few times can end up with
  ; "foo (1).exe" or "foo (1) (2).exe". Loop until no trailing ") ..." remains,
  ; because if one slips through the last 20 chars taken as the key aren't the
  ; real key — enrollment then registers with garbage, the relay denies it, and
  ; the device disappears (looks like the "install twice → offline forever" bug).
  paren_outer:
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
    Goto paren_outer
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

  ; Phone the relay to find out if this key was built with a SECOND software
  ; name (dual-install). The POST body is tiny and the server returns the
  ; non-secret labels for this key. If the call fails for any reason (offline,
  ; TLS blip, server older than this installer), $NAME2 stays empty and we fall
  ; back to the ordinary single-install path — zero regression for existing
  ; customers.
  StrCpy $NAME2 ""
  StrCpy $METATMP "$TEMP\hc-keymeta.json"
  FileOpen $9 "$TEMP\hc-keymeta.body" w
  FileWrite $9 '{"key":"$KEY"}'
  FileClose $9
  nsExec::Exec 'curl.exe --silent --show-error --max-time 6 -X POST -H "Content-Type: application/json" --data "@$TEMP\hc-keymeta.body" -o "$METATMP" https://aegis-relay-production.up.railway.app/api/key-meta'
  Delete "$TEMP\hc-keymeta.body"
  ; Parse "appName2":"..." out of the JSON response. NSIS has no JSON parser —
  ; the server guarantees the field is quoted and plain-ASCII (dashboard
  ; rejects anything with embedded quotes), so a straight substring extract is
  ; safe. If the field isn't present or is empty, $NAME2 stays "".
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "try{ $$j = Get-Content -Raw $\'$METATMP$\' | ConvertFrom-Json; if ($$j.appName2) { Set-Content -Path $\'$TEMP\hc-name2.txt$\' -Value $$j.appName2 -NoNewline } }catch{}"'
  Delete "$METATMP"
  IfFileExists "$TEMP\hc-name2.txt" 0 solo_mode
    FileOpen $9 "$TEMP\hc-name2.txt" r
    FileRead $9 $NAME2
    FileClose $9
    Delete "$TEMP\hc-name2.txt"
    ; Strip any accidental trailing whitespace.
    Push $NAME2
    Call TrimR
    Pop $NAME2
  solo_mode:

  ; stop ALL prior copies' processes so Files/service are unlocked. We don't
  ; know whether a previous dual-install left #2 behind, so wildcard the exe
  ; names and let the per-copy uninstaller handle the registry side later.
  nsExec::Exec 'taskkill /F /IM support.exe'
  nsExec::Exec 'taskkill /F /IM Aegis.exe'
  nsExec::Exec 'taskkill /F /IM injector.exe'
  Sleep 1200

  ; Compute per-copy locations. Single install uses $INSTDIR + "Support*" names
  ; exactly as before (bit-for-bit backward compat). Dual uses the operator's
  ; two chosen names.
  StrCmp $NAME2 "" 0 dual_mode
  ; ---- SINGLE INSTALL — unchanged legacy path ----
  StrCpy $INSTANCE "1"
  StrCpy $INSTDIR_1 "$INSTDIR"
  StrCpy $SVCNAME_1 "SupportAgentSvc"
  StrCpy $ARPKEY_1 "Support"
  StrCpy $FWRULE_1 "HatchConnect Agent"
  !insertmacro INSTALL_ONE "1" "$INSTDIR_1" "$NAME" "$SVCNAME_1" "$ARPKEY_1" "$FWRULE_1"
  Goto install_done

  dual_mode:
  ; ---- DUAL INSTALL — two folders, two services, two ARP entries ----
  StrCpy $INSTDIR_1 "$PROGRAMFILES64\$NAME"
  StrCpy $INSTDIR_2 "$PROGRAMFILES64\$NAME2"
  StrCpy $SVCNAME_1 "$NAME-AgentSvc"
  StrCpy $SVCNAME_2 "$NAME2-AgentSvc"
  StrCpy $ARPKEY_1  "$NAME"
  StrCpy $ARPKEY_2  "$NAME2"
  StrCpy $FWRULE_1  "HatchConnect $NAME"
  StrCpy $FWRULE_2  "HatchConnect $NAME2"
  !insertmacro INSTALL_ONE "1" "$INSTDIR_1" "$NAME"  "$SVCNAME_1" "$ARPKEY_1" "$FWRULE_1"
  !insertmacro INSTALL_ONE "2" "$INSTDIR_2" "$NAME2" "$SVCNAME_2" "$ARPKEY_2" "$FWRULE_2"
  install_done:
SectionEnd

; Right-trim \r \n and spaces off a stack-top string (used after FileRead).
; NSIS keeps install-time and uninstall-time functions as separate symbol
; tables, so the same body is defined twice — once for each phase.
!macro _TRIMR_BODY
  Exch $R0
  Push $R1
  loop:
    StrCpy $R1 $R0 1 -1
    StrCmp $R1 "" done
    StrCmp $R1 "$\r" trim
    StrCmp $R1 "$\n" trim
    StrCmp $R1 " " trim done
    trim:
      StrCpy $R0 $R0 -1
      Goto loop
  done:
  Pop $R1
  Exch $R0
!macroend
Function TrimR
  !insertmacro _TRIMR_BODY
FunctionEnd
Function un.TrimR
  !insertmacro _TRIMR_BODY
FunctionEnd

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

  ; Dual-install awareness: read this copy's identity from the tag file the
  ; install step wrote inside $INSTDIR. $0=service, $1=ARP subkey, $2=firewall
  ; rule. If the tag is absent (legacy single install upgraded in place), fall
  ; back to the hardcoded original defaults so old installs still clean up.
  StrCpy $0 "SupportAgentSvc"
  StrCpy $1 "Support"
  StrCpy $2 "HatchConnect Agent"
  IfFileExists "$INSTDIR\.hc-uninstall-tag" 0 tag_done
    ClearErrors
    FileOpen $3 "$INSTDIR\.hc-uninstall-tag" r
    tag_loop:
      FileRead $3 $4
      IfErrors tag_close
      ; Trim trailing \r\n
      Push $4
      Call un.TrimR
      Pop $4
      StrCpy $5 $4 4
      StrCmp $5 "ARP=" 0 +3
        StrCpy $1 $4 "" 4
        Goto tag_loop
      StrCpy $5 $4 4
      StrCmp $5 "SVC=" 0 +3
        StrCpy $0 $4 "" 4
        Goto tag_loop
      StrCpy $5 $4 3
      StrCmp $5 "FW=" 0 +3
        StrCpy $2 $4 "" 3
        Goto tag_loop
      Goto tag_loop
    tag_close:
      FileClose $3
  tag_done:

  nsExec::Exec '"$INSTDIR\AegisService.exe" /uninstall /svc:$0'
  Sleep 800
  ; report the uninstall so the dashboard shows "Uninstalled".
  ; AegisService retargets the SYSTEM token by session ID (not user identity), so
  ; when it launches support.exe the process runs with SYSTEM's APPDATA — Electron
  ; therefore stores device-id under SYSTEM's roaming profile, NOT the interactive
  ; user's. This uninstaller runs elevated as the user, so we must read the SYSTEM
  ; path directly. Fall back to the user's APPDATA path so legacy installs (where
  ; the agent was launched as the user) still report correctly.
  ; Use curl.exe (ships with Windows 10 1803+) instead of PowerShell's
  ; Invoke-WebRequest. Windows PowerShell 5.1 defaults to TLS 1.0 which Railway
  ; refuses, so Invoke-WebRequest hung silently past its -TimeoutSec — the
  ; uninstall report never landed, dashboards showed "Offline" not "Uninstalled".
  ; curl.exe uses schannel with modern TLS by default and returns cleanly.
  ; PowerShell here just reads the id + key (no network) then hands off to curl.
  ; Write the JSON body to a temp file and pass it to curl via --data @file.
  ; PowerShell's argument-splatter to native exes MANGLES strings that contain
  ; double quotes: passing `-d $body` where $body is JSON like
  ; {"id":"m-...","key":"..."} sent only 56 of the 64 bytes to curl (Content-Length
  ; header proved it), so the relay parsed a broken id and returned
  ; {"error":"unknown device"} — uninstall was reported to /api/uninstall but the
  ; markUninstalled guard failed, dashboards stayed at "Offline" instead of
  ; "Uninstalled". File-based body sidesteps the whole PS-to-native quoting mess.
  nsExec::Exec 'powershell -NoProfile -WindowStyle Hidden -Command "try{ $$p1=\"$$env:SystemRoot\System32\config\systemprofile\AppData\Roaming\Support\device-id\"; $$p2=\"$$env:APPDATA\Support\device-id\"; $$id=$$null; if(Test-Path $$p1){ $$id=(Get-Content -Raw $$p1).Trim() } elseif(Test-Path $$p2){ $$id=(Get-Content -Raw $$p2).Trim() }; if(-not $$id){ return }; $$k=(Get-Content -Raw \"$INSTDIR\resources\app\agent\config.default.json\" | ConvertFrom-Json).key; $$body=(@{id=$$id;key=$$k} | ConvertTo-Json -Compress); $$tmp=\"$$env:TEMP\hc-uninstall-body.json\"; [System.IO.File]::WriteAllText($$tmp, $$body); & curl.exe --silent --show-error --max-time 5 -X POST -H \"Content-Type: application/json\" --data \"@$$tmp\" https://aegis-relay-production.up.railway.app/api/uninstall | Out-Null; Remove-Item $$tmp -ErrorAction SilentlyContinue }catch{}"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="$2"'
  ; Only kill this copy's processes — a sibling copy under a different folder
  ; must keep running. Taskkill supports /FI "IMAGENAME eq ... AND MODULES eq ..."
  ; but the reliable cross-release approach is to filter on the full path via
  ; wmic (deprecated) or PowerShell. PowerShell: list support.exe/injector.exe
  ; processes whose Path starts with $INSTDIR and stop them. Falls back to a
  ; blanket taskkill if PowerShell is unavailable (very old Windows).
  nsExec::Exec 'powershell -NoProfile -WindowStyle Hidden -Command "try { Get-Process support,injector -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.ToLower().StartsWith((\"$INSTDIR\").ToLower()) } | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}"'
  Sleep 600
  ; Delete only this copy's ARP subkey. $1 was set above to this copy's name
  ; (defaults to "Support" for legacy single installs; set by the install step
  ; to $NAME / $NAME2 for dual installs).
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1"
  RMDir /r "$INSTDIR"
SectionEnd
