; AudioClamp Windows installer (Inno Setup 6)
;
; Build:  python build_exe.py --installer
;   or:   ISCC.exe installer\AudioClamp.iss /DAppVersion=2.5.0 /DSourceDir=dist\onedir\AudioClamp
;
; Packages the one-folder PyInstaller build. Unlike the portable single-file exe it does not unpack
; itself to a temp folder on every launch, so it starts faster and trips antivirus scanners less.
;
; Installs per user to %LOCALAPPDATA%\Programs\AudioClamp by default, the same folder the old
; Install-AudioClamp.ps1 used, so it upgrades those installs in place. Users can choose an
; all-users install from the first page instead.

#ifndef AppVersion
  #define AppVersion "2.6.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\onedir\AudioClamp"
#endif

#define AppName "AudioClamp"
#define AppExe "AudioClamp.exe"
#define AppPublisher "ItsSpero"
#define AppUrl "https://github.com/ItsSpero/AudioClamp"
#define RunKey "Software\Microsoft\Windows\CurrentVersion\Run"

[Setup]
; Keep AppId fixed forever: Windows uses it to recognise upgrades and the uninstall entry
AppId={{5FAADC3E-3567-47FB-9E1F-0FEE40FA3666}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
LicenseFile=..\LICENSE
SetupIconFile=..\assets\icon_active.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
OutputDir=..\dist\installer
OutputBaseFilename={#AppName}-Setup-{#AppVersion}
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup"; Description: "Start AudioClamp with &Windows (runs minimized in the tray)"; GroupDescription: "Startup:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Clear runtime files from the previous version so stale libraries never mix with new ones
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Comment: "Real-time peak limiter for gaming and hearing protection"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
; Same value the in-app "Launch on Startup" toggle writes, so both stay in agreement
Root: HKCU; Subkey: "{#RunKey}"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExe}"" --minimized"; Tasks: startup
; Legacy entry from the app's former name
Root: HKCU; Subkey: "{#RunKey}"; ValueName: "SoundLockPro"; Flags: deletevalue dontcreatekey

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
const
  ConfigRelPath = '\AudioClamp\config.json';

procedure CloseRunningAudioClamp();
var
  ResultCode: Integer;
begin
  { AudioClamp hides to the tray on close, so stop every copy (installed or portable) to free
    the single-instance mutex and let the new version start cleanly afterwards. }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM {#AppExe}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(600);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  CloseRunningAudioClamp();
  Result := '';
end;

{ Mirror the startup choice into the app's own settings so its "Launch on Startup" checkbox
  shows the truth. config.json is written by Python's json module, which keeps it pure ASCII. }
procedure SyncStartupSetting();
var
  ConfigPath: String;
  Json: AnsiString;
  Text: String;
begin
  ConfigPath := ExpandConstant('{localappdata}') + ConfigRelPath;
  if FileExists(ConfigPath) then
  begin
    if not LoadStringFromFile(ConfigPath, Json) then
      Exit;
    Text := String(Json);
    if StringChangeEx(Text, '"start_with_windows": false', '"start_with_windows": true', True) > 0 then
      SaveStringToFile(ConfigPath, AnsiString(Text), False);
  end
  else
  begin
    ForceDirectories(ExtractFileDir(ConfigPath));
    SaveStringToFile(ConfigPath, '{' + #13#10 + '    "start_with_windows": true' + #13#10 + '}' + #13#10, False);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('startup') then
    SyncStartupSetting();
end;

function InitializeUninstall(): Boolean;
begin
  CloseRunningAudioClamp();
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  { The startup entry may have been created by the app itself rather than by setup, so always
    remove it; otherwise Windows would keep trying to launch a deleted file. Settings in
    %LOCALAPPDATA%\AudioClamp are kept so a reinstall remembers them. }
  if CurUninstallStep = usPostUninstall then
    RegDeleteValue(HKEY_CURRENT_USER, '{#RunKey}', '{#AppName}');
end;
