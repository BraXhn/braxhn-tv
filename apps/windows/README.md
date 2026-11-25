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

## Den inbyggda spelaren (mpv)

Som Jellyfin Media Player och Plex HTPC kan appen spela filmer och avsnitt i **mpv** i stället för webbläsarens
spelare. mpv spelar originalfilen som den är – 4K HDR, Dolby Vision, DTS, TrueHD, bildundertexter – utan att servern
behöver koda om något.

**Så fungerar det:** du trycker *Spela* i webbappen som vanligt. I Windows-appen frågar webbappen först servern om
filen kan skickas orörd. Kan den det spelar mpv den i samma fönster; webbappen ligger kvar bakom och sköter *Fortsätt
titta*, historik och skärmtid (positionen skickas var tionde sekund, vid paus och när du stänger). När filmen är slut
eller du stänger kommer du tillbaka till samma sida. Nästa avsnitt startar direkt om ditt konto har *spela nästa
avsnitt automatiskt* på.

**Webbspelaren används i stället** när servern måste ändra något i filen: familjefiltret är på för profilen
(tystade svordomar, överhoppade scener), utanför hemmet när uppkopplingen inte räcker för originalfilen, när du valt
en lägre kvalitet, när filformatet inte kan skickas direkt, vid trailers före filmen (bio-läget) och i *Titta
tillsammans*. Åldersgränser och skärmtid sköter servern som vanligt – skärmtiden stoppar också mpv. Går något fel
i mpv (filen saknas, kan inte spela) tar webbspelaren över där filmen var.

**Reglage:** mpv:s egna (för musen till nederkanten): spela/paus, tidslinje, ljudspår, undertexter (även
bildundertexter), volym. Överst: *← Tillbaka* och *Nästa avsnitt*. Tangenter: mellanslag = paus, ←/→ = spola,
9/0 = volym, # = byt ljudspår, j = byt undertext, **f**, **F11** eller dubbelklick = helskärm, **Esc** = ur helskärm
(och sedan tillbaka), **q** = tillbaka, **N** = nästa avsnitt.

**Inställningar** i fönstermenyn (högerklick på titelraden):
- *Använd den inbyggda spelaren* – på som standard. Stäng av den om något krånglar; då spelar webbspelaren allt.
- *Ljud orört till förstärkaren (AC3, DTS, TrueHD)* – bitström till förstärkaren (exklusivt läge i Windows). Av som
  standard.
- *Byt skärmens uppdateringsfrekvens efter filmen* – t.ex. 23,976 Hz för film och 50 Hz för svensk tv. Windows går
  tillbaka när du stänger spelaren. Av som standard.
- Hårdvaruavkodning (`hwdec=auto-safe`) är alltid på.

### mpv följer inte med än – så lägger du till den

mpv (libmpv) är fri programvara men under LGPL/GPL, och den måste komma från någon annans byggnad för Windows. Därför
ligger den **inte** i installationsfilen än (se *Licensen* nedan). Utan den spelar webbspelaren allt, precis som
förut. Vill du använda mpv redan nu, för egen del:

1. Ladda ner `mpv-dev-x86_64-v3-<datum>-git-<hash>.7z` från
   [sourceforge.net/projects/mpv-player-windows/files/libmpv](https://sourceforge.net/projects/mpv-player-windows/files/libmpv/)
   (`x86_64` utan `-v3` för datorer äldre än ungefär 2015).
2. Öppna arkivet (7-Zip) och lägg `libmpv-2.dll` i `%LOCALAPPDATA%\BraXhnTV\mpv\` (skriv adressen i
   Utforskarens adressfält; skapa mappen `mpv` om den saknas). *Om den inbyggda spelaren …* i fönstermenyn har en
   knapp som öppnar mappen.
3. Starta om appen. *Om den inbyggda spelaren …* visar att mpv finns.

### Licensen (för den som ger ut appen)

- BraXhn TV är MIT. libmpv-2.dll laddas som en egen fil när appen kör (dynamisk länkning) och kan bytas ut av
  användaren – det är det LGPL kräver av ett program som använder ett LGPL-bibliotek.
- **GPL-byggnaderna får inte läggas i installationsfilen.** shinchiro/mpv-winbuild-cmake (SourceForge-länken ovan)
  bygger FFmpeg med `--enable-gpl` (x264, x265 m.fl.) och mpv utan `-Dgpl=false`, alltså GPL. Att ladda ner den själv
  för egen användning är fritt; att sprida den tillsammans med en MIT-app är det inte utan att hela appen följer GPL.
- **LGPL-byggnaden finns:** zhongfly/mpv-winbuild ger ut `mpv-dev-lgpl-x86_64-…7z` (mpv LGPL 2.1+ med FFmpeg LGPL 3
  inbyggt). Men byggaren skriver själv att han inte kan garantera att allt som inte är LGPL är avstängt, och
  utgåvorna sparas bara i 30 dagar – en fast adress med kontrollsumma slutar då fungera inom en månad.
- **Vad som krävs för att lägga den i installationsfilen:** (1) att ägaren godtar zhongflys LGPL-byggnad (eller
  bygger en egen med `-Dgpl=false` och FFmpeg utan `--enable-gpl`), (2) en kopia av arkivet på en plats som finns kvar,
  t.ex. en egen utgåva i det här repot, (3) att källkoden för exakt den byggnaden (mpv, FFmpeg och de inbyggda
  biblioteken i de versioner arkivet anger) hålls tillgänglig så länge filen sprids (LGPL 3 / GPL 3 avsnitt 6), och
  (4) repo-variablerna `LIBMPV_URL` (arkivets adress) och `LIBMPV_SHA256` (dess SHA-256) under *Settings → Secrets
  and variables → Actions → Variables*. Då lägger flödet `libmpv-2.dll`, licenstexterna (LGPL 2.1, LGPL 3, GPL 3) och
  `mpv-licens.txt` i installationen (mappen `mpv-licens`). Utan variablerna byggs installationsfilen utan mpv.

## Var sparas vad?

`%LOCALAPPDATA%\BraXhnTV\`

- `installningar.json` – serverlistan, fönstrets storlek och läge, när uppdateringar senast kontrollerades.
- `Servrar\<id>\` – WebView2:s data för varje server (inloggning, kakor, cache). Servrar delar aldrig kakor.
- `App\` – data för appens egna sidor (Välj server, Lägg till server).
- `mpv\` – `libmpv-2.dll` om du lagt den där, och `input.conf` (den inbyggda spelarens tangenter för appen).

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
- **Den inbyggda spelaren i Windows:** att mpv ritar i appens fönster (`wid`), raden överst ovanpå bilden, helskärm,
  bitström till förstärkaren, byte av skärmens frekvens och mpv:s medieruta. Spelardelen (laddning av libmpv,
  spårval, start mitt i filmen, tangenterna, slut, fel och stängning) är provad mot en riktig libmpv 0.37 på Linux,
  och webbens överlämning och serverns beslut är testade i Node – men inte tillsammans i Windows.

Hittar du fel: *Ladda ner diagnostik* i webbappen fungerar som vanligt, och *Om BraXhn TV* i fönstermenyn visar
appens och WebView2:s version.

## För utvecklare

- `BraXhnTV/` – appen (C#, .NET 8, WinForms + WebView2). `Sidor/start.html` är Välj server / Lägg till server /
  felsidan; den pratar med appen via `chrome.webview.postMessage`. `Inject.cs` körs i serverns sidor och berättar om
  video eller ljud spelas (viloläget) och fångar F11/Esc.
- `BraXhnTV/Spelare/` – den inbyggda spelaren: `Libmpv.cs` (C-API:t, laddas dynamiskt), `MpvPlayer.cs` (en
  uppspelning), `Display.cs` (skärmens frekvens). `MainForm.Spelare.cs` tar emot webbens `native-*`-meddelanden;
  webbens sida är `web/js/player/native.js` och `nativeplan.js`.
- `BraXhnTV.Tests/` – tester som går att köra på alla system: `dotnet test apps/windows/BraXhnTV.Tests`. Spelartesterna
  körs när libmpv finns (Linux: `apt install libmpv2`, annars `BRAXHN_LIBMPV=<sökväg>`) och hoppas annars över.
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
- **Built-in player (mpv):** like Jellyfin Media Player, movies and episodes the server can send untouched play in
  mpv inside the app window (4K HDR, DTS/TrueHD, image subtitles); the web app keeps handling Continue watching,
  screen time and next episode. Family filter, low bandwidth away from home, a lower chosen quality, cinema trailers
  and Watch together use the web player. Settings in the window menu: *Use the built-in player* (on), *Send audio
  untouched to the receiver*, *Match the display refresh rate*. libmpv is **not bundled yet** (licence: the common
  builds are GPL; the LGPL build has a 30-day retention and its builder gives no guarantee) – put `libmpv-2.dll` in
  `%LOCALAPPDATA%\BraXhnTV\mpv\` yourself, or set the `LIBMPV_URL`/`LIBMPV_SHA256` repository variables to bundle an
  LGPL build.
- **Not yet tested on real Windows** – it compiles and its logic tests pass, but everything that needs Windows is untried.
