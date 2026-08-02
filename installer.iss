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

[Run]
; Launch immediately after install so no reboot is needed.
Filename: "{app}\{#AppExe}"; Parameters: "--startup"; Flags: nowait runhidden

[Code]
procedure KillAgent;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Aegis.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM injector.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
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
