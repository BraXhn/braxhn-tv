# BraXhn TV för Windows

En app för Windows 10 och 11 som visar din BraXhn TV-server i ett eget fönster. Den använder Microsofts
**WebView2** (samma motor som Edge), så den ser ut och fungerar som webbappen – men med egen ikon i Start-menyn och
aktivitetsfältet, egen inloggning per server och några saker som en webbläsarflik inte klarar.

Edge-motorn avkodar video i datorns grafikkort och kan spela **HEVC/H.265** direkt när datorn har stöd för det
(de flesta datorer från 2016 och senare, ibland efter att *HEVC Video Extensions* installerats från Microsoft Store).
Webbappen frågar själv vad den kan spela, så servern behöver då inte koda om sådana filer.

## Installera

Appen byggs av GitHub Actions. Du behöver inga utvecklarverktyg.

1. **Från en utgåva** (när den finns): öppna [Releases](https://github.com/BraXhn/braxhn-tv/releases), ta
   `BraXhnTV-Setup-<version>.exe` under *Assets*.
2. **Eller bygg själv med ett klick:** på GitHub, *Actions* → **Windows-app** → *Run workflow* → *Run workflow*.
   Efter ungefär fem minuter: öppna körningen och ladda ner **BraXhnTV-Setup-<version>** under *Artifacts*. Det är
   en zip-fil – packa upp den (högerklick → *Extrahera alla*).
3. Kör `BraXhnTV-Setup-<version>.exe`.

### "Windows skyddade datorn" (SmartScreen)

Installationsfilen är inte kodsignerad (det kräver ett köpt certifikat), så Windows varnar första gången:
klicka **Mer info** → **Kör ändå**. Edge eller Chrome kan också säga att filen "inte laddas ner så ofta" – välj
**Behåll** (i Edge under *…* → *Behåll*).

Installationen frågar inte efter administratörslösenord. Appen hamnar i `%LOCALAPPDATA%\Programs\BraXhn TV` och i
Start-menyn. Saknas WebView2 (ovanligt; den finns i Windows 11 och i uppdaterade Windows 10) installerar
installationsfilen den från Microsoft.

## Använda

- **Första gången** frågar appen efter serverns adress. `tv.braxhn.net` står redan ifyllt. Ett domännamn blir
  `https://`, en IP-adress eller ett namn i hemnätet blir `http://…:8420` (samma regler som de andra apparna). Sedan
  loggar du in som vanligt i webbappen; inloggningen sparas till nästa gång.
- **En server:** den öppnas direkt. **Flera:** appen frågar vilken vid start.
- **Byt server, Lägg till server, Starta med Windows, Sök efter uppdateringar** finns i fönstermenyn: högerklicka
  på titelraden (eller tryck **Alt + mellanslag**). Ta bort en server i *Byt server* (klicka *Ta bort* två gånger).
- **Helskärm:** **F11**, eller dubbelklicka på videon / helskärmsknappen i spelaren. **Esc** går ur helskärm.
- **Medietangenter och Windows medieruta** (spela/paus på tangentbordet, rutan vid volymen): appen slår på Edge-motorns
  stöd för det, så det som spelas visas där som i Edge.
- Datorn går inte i viloläge och skärmsläckaren startar inte medan **video** spelas. Spelas bara **ljud** hålls
  datorn vaken men skärmen får släckas.
- **Ladda ner** (filmer, export) frågar var filen ska sparas; *Hämtade filer* föreslås.
- Länkar till andra webbplatser (TMDB, IMDb …) öppnas i din vanliga webbläsare.
- **Uppdateringar:** vid start, högst en gång per dygn, frågar appen GitHub om det finns en nyare utgåva med
  Windows-installationsfil. Finns det får du frågan *Ladda ner och installera*, *Inte nu* eller *Hoppa över den här
  versionen*. Inget laddas ner utan att du klickar.
- Texterna i appen är på svenska om Windows är på svenska, annars engelska. Webbappens språk väljs i webbappen.

## Var sparas vad?

`%LOCALAPPDATA%\BraXhnTV\`

- `installningar.json` – serverlistan, fönstrets storlek och läge, när uppdateringar senast kontrollerades.
- `Servrar\<id>\` – WebView2:s data för varje server (inloggning, kakor, cache). Servrar delar aldrig kakor.
- `App\` – data för appens egna sidor (Välj server, Lägg till server).

*Starta med Windows* är en rad i `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` (av som standard).

## Avinstallera

*Inställningar* → *Appar* → *Installerade appar* → **BraXhn TV** → *Avinstallera*. Avinstallationen frågar om
inloggningar och inställningar också ska tas bort (`%LOCALAPPDATA%\BraXhnTV`).

## Vad som inte är provat

Appen är kompilerad (även som färdig exe för win-x64) och logiken för adresser, versioner och GitHub-svaret är
testad, men **ingenting är provat på en riktig Windows-dator**. Särskilt:

- att WebView2 i en enda exe hittar sin `WebView2Loader.dll` (packas in i exe-filen),
- medietangenterna och Windows medieruta (Edge-flaggan `HardwareMediaKeyHandling`),
- fönstermenyn, mörk titelrad, helskärm och att fönstrets läge sparas,
- Inno Setup-installationen och WebView2-installeraren, uppdateringsrutan och avinstallationen.

Hittar du fel: *Ladda ner diagnostik* i webbappen fungerar som vanligt, och *Om BraXhn TV* i fönstermenyn visar
appens och WebView2:s version.

## För utvecklare

- `BraXhnTV/` – appen (C#, .NET 8, WinForms + WebView2). `Sidor/start.html` är Välj server / Lägg till server /
  felsidan; den pratar med appen via `chrome.webview.postMessage`. `Inject.cs` körs i serverns sidor och berättar om
  video eller ljud spelas (viloläget) och fångar F11/Esc.
- `BraXhnTV.Tests/` – tester som går att köra på alla system: `dotnet test apps/windows/BraXhnTV.Tests`.
- `installer/BraXhnTV.iss` – Inno Setup.
- Bygget: `.github/workflows/windows.yml`. Lokalt (även på Linux/Mac, bara för att kontrollera koden):
  `dotnet publish apps/windows/BraXhnTV -c Release -r win-x64 --self-contained -p:PublishSingleFile=true`.
- Appen säger vem den är i user agent: `… Edg/… BraXhnTV-Windows/<version>`. Servern visar den som *Windows-app*.

---

## English

**BraXhn TV for Windows** shows your BraXhn TV server in its own window using Microsoft WebView2 (the Edge engine):
the same look and features as the web app, with hardware video decoding and HEVC when the PC supports it.

- **Install:** download `BraXhnTV-Setup-<version>.exe` from the release, or run the **Windows-app** workflow under
  *Actions* and download it from *Artifacts* (unzip first). The installer isn't code-signed, so Windows SmartScreen
  warns the first time: **More info** → **Run anyway**. No admin rights needed; WebView2 is installed if missing.
- **Use:** add a server (`tv.braxhn.net` is suggested) and sign in. One server opens directly; with several the
  app asks at start. *Change server*, *Add server*, *Start with Windows* and *Check for updates* are in the window
  menu (right-click the title bar or press **Alt+Space**). **F11** or double-clicking the video for full screen.
  Media keys and the Windows media overlay are enabled through the Edge engine. The PC doesn't sleep while video plays.
- **Updates:** at most once a day the app checks GitHub releases and asks before downloading anything.
- **Data:** `%LOCALAPPDATA%\BraXhnTV` (one WebView2 profile per server). Uninstall from *Settings → Apps*.
- **Not yet tested on real Windows** – it compiles and its logic tests pass, but everything that needs Windows is untried.
