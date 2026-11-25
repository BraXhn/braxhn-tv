; Installationsfil för BraXhn TV (Windows). Byggs av .github/workflows/windows.yml:
;   iscc /DAppVersion=1.4.0 /DAppVersionNum=1.4.0 /DSourceDir=<mapp med BraXhnTV.exe> /O<utmapp> BraXhnTV.iss
; Installeras för den inloggade användaren (ingen administratörsfråga), i %LOCALAPPDATA%\Programs\BraXhn TV.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef AppVersionNum
  #define AppVersionNum "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\ut\app"
#endif
#ifndef MpvDir
  #define MpvDir "..\ut\mpv"
#endif
#define HasMpv FileExists(AddBackslash(MpvDir) + "libmpv-2.dll")
#define HasSwedish FileExists(AddBackslash(CompilerPath) + "Languages\Swedish.isl")
#define HasWebView2Setup FileExists(AddBackslash(SourcePath) + "MicrosoftEdgeWebview2Setup.exe")

[Setup]
AppId={{8E4C2B71-5D3A-4F6E-9B1C-2A7D0E5F3C94}
AppName=BraXhn TV
AppVersion={#AppVersion}
AppVerName=BraXhn TV {#AppVersion}
AppPublisher=BraXhn
AppPublisherURL=https://github.com/BraXhn/braxhn-tv
AppSupportURL=https://github.com/BraXhn/braxhn-tv/issues
AppUpdatesURL=https://github.com/BraXhn/braxhn-tv/releases
AppCopyright=BraXhn
VersionInfoVersion={#AppVersionNum}
VersionInfoCompany=BraXhn
VersionInfoProductName=BraXhn TV
VersionInfoDescription=BraXhn TV Setup
DefaultDirName={autopf}\BraXhn TV
DefaultGroupName=BraXhn TV
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputBaseFilename=BraXhnTV-Setup-{#AppVersion}
SetupIconFile=..\BraXhnTV\app.ico
UninstallDisplayIcon={app}\BraXhnTV.exe
UninstallDisplayName=BraXhn TV
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
#if HasSwedish
Name: "swedish"; MessagesFile: "compiler:Languages\Swedish.isl"
#endif

[CustomMessages]
english.DesktopIcon=Create a desktop shortcut
english.Launch=Start BraXhn TV
english.WebView2=Installing Microsoft Edge WebView2 …
english.RemoveData=Also remove your sign-ins and settings for BraXhn TV on this computer?
#if HasSwedish
swedish.DesktopIcon=Skapa en genväg på skrivbordet
swedish.Launch=Starta BraXhn TV
swedish.WebView2=Installerar Microsoft Edge WebView2 …
swedish.RemoveData=Ta också bort dina inloggningar och inställningar för BraXhn TV på den här datorn?
#endif

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\BraXhnTV.exe"; DestDir: "{app}"; Flags: ignoreversion
#if HasWebView2Setup
; Microsofts lilla installerare för WebView2 – körs bara om WebView2 saknas
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedsWebView2
#endif

#if HasMpv
; Den inbyggda spelaren: libmpv (LGPL) som egen fil, så att den kan bytas ut, och licenstexterna
Source: "{#MpvDir}\libmpv-2.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MpvDir}\*.txt"; DestDir: "{app}\mpv-licens"; Flags: ignoreversion
#endif

[Icons]
Name: "{autoprograms}\BraXhn TV"; Filename: "{app}\BraXhnTV.exe"
Name: "{autodesktop}\BraXhn TV"; Filename: "{app}\BraXhnTV.exe"; Tasks: desktopicon

[Registry]
; "Starta med Windows" sätts i appen; avinstallationen tar bort det
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "BraXhnTV"; Flags: uninsdeletevalue

[Run]
#if HasWebView2Setup
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "{cm:WebView2}"; Flags: waituntilterminated; Check: NeedsWebView2
#endif
Filename: "{app}\BraXhnTV.exe"; Description: "{cm:Launch}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2Id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasVersion(Root: Integer; Key: String): Boolean;
var
  V: String;
begin
  Result := RegQueryStringValue(Root, Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0');
end;

{ WebView2 finns i Windows 11 och i de flesta Windows 10. Saknas den installeras den med Microsofts installerare. }
function NeedsWebView2(): Boolean;
begin
  Result := not (HasVersion(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WebView2Id)
    or HasVersion(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2Id)
    or HasVersion(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2Id));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent then
    if MsgBox(CustomMessage('RemoveData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{localappdata}\BraXhnTV'), True, True, True);
end;
