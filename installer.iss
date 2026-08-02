; Aegis Remote Agent — Inno Setup installer script.
; Produces AegisRemoteSetup.exe: the customer runs it, it installs the agent,
; starts it immediately (hidden, to tray) and on every login, and registers a
; proper uninstaller in Add/Remove Programs. Uninstalling stops the agent and
; removes everything — i.e. revokes remote access.

#define AppName "Aegis"
#define AppVersion "0.1.0"
#define AppExe "Aegis.exe"

[Setup]
AppId={{9E2B7C41-5A3D-4E88-9F1A-AE61C0D2F3B7}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Aegis
; Per-user install: no admin/UAC prompt — "just download and install".
DefaultDirName={autopf}\Aegis
DefaultGroupName=Aegis
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableWelcomePage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
OutputDir=release
OutputBaseFilename=AegisSetup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=build\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}

[Files]
Source: "release\Aegis\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Registry]
; Auto-start (hidden) at every login for the current user (HKA = HKCU here).
Root: HKA; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "Aegis"; \
  ValueData: """{app}\{#AppExe}"" --startup"; Flags: uninsdeletevalue

[Code]
const
  RELAY_URL = 'wss://aegis-relay-production.up.railway.app';

procedure KillAgent;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Aegis.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM injector.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// The enrollment key travels in this setup's own filename: AegisSetup-<KEY>.exe
// (served by the relay at /dl/<KEY>). Extract it so the agent enrolls under the
// right admin, with no per-download rebuild.
function GetEnrollKey: String;
var
  fn: String;
begin
  Result := '';
  fn := ExtractFileName(ExpandConstant('{srcexe}'));
  if Pos('AegisSetup-', fn) = 1 then
  begin
    Result := Copy(fn, Length('AegisSetup-') + 1, Length(fn));
    if (Length(Result) >= 4) and (Lowercase(Copy(Result, Length(Result) - 3, 4)) = '.exe') then
      Result := Copy(Result, 1, Length(Result) - 4);
  end;
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

// On uninstall, stop the agent (and its injector child) before removing files.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    KillAgent;
    Sleep(1500);
  end;
end;
