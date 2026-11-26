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
- **Appens meny:** högerklicka i fönstret (där webbappen inte har en egen meny) – *Ladda om, Byt server, Lägg till
  server*, den inbyggda spelarens val, *Starta med Windows, Sök efter uppdateringar, Om BraXhn TV*. Samma meny finns
  på titelraden (högerklick eller **Alt + mellanslag**). I textfält ger högerklick klipp ut/kopiera/klistra in.
  Webbläsarens egen meny och utvecklarverktygen (Granska) är avstängda; för felsökning slås verktygen på med
  `"DevTools": true` i `installningar.json` eller miljövariabeln `BRAXHN_DEVTOOLS=1`.
- **Byt server, Lägg till server, Starta med Windows, Sök efter uppdateringar** finns i appens meny. Ta bort en server i *Byt server* (klicka *Ta bort* två gånger).
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

**Reglage:** appens egen kontrollrad längst ner, i webbspelarens stil: tidslinje (klicka eller dra; tiden visas vid
muspekaren, det buffrade syns ljusare), titel och tid till vänster; −10 s, spela/paus, +10 s, *Nästa avsnitt* och stopp
i mitten; sovtimer (15–90 min eller *när avsnittet är slut*), inställningar (ljudspår, undertexter, undertextstorlek,
undertextens tid och hastighet), volym och helskärm till höger. Överst: *← Tillbaka*, titeln och *Nästa avsnitt*.
Raderna tonas bort efter 3 sekunder utan musrörelse och kommer tillbaka när musen rör sig; i helskärm göms även
muspekaren. mpv:s egna reglage (OSC) och tangenter är avstängda, så att inget dubbleras.

**Musen på bilden:** klick = spela/paus, dubbelklick = helskärm, hjulet = volym, högerklick = meny (ljudspår,
undertexter, ljud till förstärkaren, uppdateringsfrekvens, *Använd den inbyggda spelaren*, *Om den inbyggda spelaren*,
*Spela den här filmen i webbspelaren*, *Tillbaka*). Musen fångas av ett osynligt lager över bilden, eftersom mpv:s
fönster körs i en egen tråd.

**Tangenter:** mellanslag eller **K** = paus, **←/→** eller **J/L** = 10 s, **↑/↓** = volym, **F** eller **F11** =
helskärm, **Esc** = ur helskärm (och sedan tillbaka), **Q** = tillbaka, **M** = ljud av, **N** = nästa avsnitt,
**S** = undertext av/på, **A** = byt ljudspår, **I** = mpv:s statistik, och medietangenterna. Bild-i-bild finns inte än.

**Inställningar** i appens meny (högerklick i fönstret eller på titelraden):
- *Använd den inbyggda spelaren* – på som standard. Stäng av den om något krånglar; då spelar webbspelaren allt.
- *Ljud orört till förstärkaren (AC3, DTS, TrueHD)* – bitström till förstärkaren (exklusivt läge i Windows). Av som
  standard.
- *Byt skärmens uppdateringsfrekvens efter filmen* – t.ex. 23,976 Hz för film och 50 Hz för svensk tv. Windows går
  tillbaka när du stänger spelaren. Av som standard.
- Hårdvaruavkodning (`hwdec=auto-safe`) är alltid på.

### Hämta mpv med ett klick

Följer mpv inte med installationen hämtar appen den själv – men bara när du klickar:

- Första gången en film hade kunnat spelas i den inbyggda spelaren frågar appen **Hämta den inbyggda spelaren (mpv,
  ca 30 MB)?** med knapparna *Hämta* och *Inte nu* (filmen spelas i webbspelaren under tiden). Frågan kommer bara
  den gången.
- Sedan finns **Hämta den inbyggda spelaren (mpv) …** – eller **Uppdatera den inbyggda spelaren …** när den redan finns
  – i appens meny (högerklick) och i *Om den inbyggda spelaren …*. Inget hämtas automatiskt.

Appen hämtar i första hand **BraXhn TV:s egen LGPL-byggnad** (zip-arkivet i utgåvan som `apps/windows/libmpv.json`
pekar på, kontrollerat mot SHA-256 i samma fil). Saknas den filen i appen, eller går utgåvan inte att nå, hämtas
**mpv-projektets Windows-bygge** från SourceForge (`sourceforge.net/projects/mpv-player-windows`, mappen `libmpv`):
appen läser projektets lista (`…/rss?path=/libmpv`) och tar den nyaste `mpv-dev-x86_64-<datum>-git-<hash>.7z` –
varianten **x86_64**, inte `x86_64-v3`, som kräver en processor med AVX2 och inte fungerar på alla datorer. Det
arkivet kontrolleras mot storleken och MD5 i listan. I båda fallen packar appen upp `libmpv-2.dll`, kontrollerar att
den är för 64-bitars Windows, lägger den i `%LOCALAPPDATA%\BraXhnTV\mpv\` och provar att mpv startar och svarar med
sin version. Den används direkt, utan omstart. En uppdatering medan mpv redan är laddad används från nästa start.
Går något fel får du veta vad (på svenska eller engelska) och webbspelaren spelar som förut.

Följer `libmpv-2.dll` med installationen (bredvid `BraXhnTV.exe`) används den, och appen erbjuder ingen hämtning –
den uppdateras med appen.

**Det krävs av servern:** BraXhn TV **1.4.1 eller senare**. Webbappen kommer från servern, och det är den som lämnar
över filmen till den inbyggda spelaren – en äldre server frågar aldrig appen, och då spelar webbspelaren allt hur mpv
än är installerad. Appen läser serverns version (`/api/status`) och säger till en gång nere i fönstret, och *Om den
inbyggda spelaren …* visar det. Har servern bytt version sedan förra gången laddar appen om sidan en gång, så att
webbappen säkert är serverns nya och inte en äldre ur webbläsarens cache.

**Utanför hemmet** (via den publika adressen, även hemifrån) med kvalitet *Auto* spelar mpv originalfilen när
webbappens mätning av uppkopplingen rymmer filens bithastighet med 10 % marginal, eller när mätningen inte hann bli
klar – mpv buffrar själv. Webbspelarens marginaler och kvalitetstakets bithastighet (1080p ≈ 10 Mbit/s) gäller inte
mpv (`buf=1` i frågan till servern); upplösningstaket (serverns eller kontots, t.ex. 720p utanför hemmet) gäller.
Räcker uppkopplingen inte kodar servern om och webbspelaren spelar.

**Varför webbspelaren?** När en film inte spelas i mpv säger appen varför en gång nere i fönstret (t.ex. *Webbspelaren
används eftersom servern valde omkodning (sänkt kvalitet till 1080p) – utanför hemmet, uppmätt 8 Mbit/s*), och den
senaste orsaken står i *Om den inbyggda spelaren …*.

**Om den inbyggda spelaren …** i appens meny visar serverns version, mpv:s version och fil, varje plats som provades
(finns inte / fel sorts fil, t.ex. 32-bitars / kräver AVX2, t.ex. varianten `x86_64-v3` / gick inte att ladda och
Windows felmeddelande / laddad), om processorn saknar AVX2, och var loggen ligger. Saknar processorn AVX2 provar appen
en `libmpv-2.dll` i en egen process innan den laddas, så att en `-v3`-fil inte kan krascha appen. *Kopiera felsökningsinformation* lägger allt detta och slutet av loggen i
urklipp, så att det kan klistras in i *Feedback* i webbappen. Loggen är `%LOCALAPPDATA%\BraXhnTV\logg.txt` (högst
256 kB; strömlänkar och token skrivs aldrig dit).

### Licensen (för den som ger ut appen)

- Appen packar upp mpv-arkivet med [SharpCompress](https://github.com/adamhathcock/sharpcompress) (7z, MIT-licens,
  inbyggd i `BraXhnTV.exe`) och .NET:s egen `System.IO.Compression` (zip). SharpCompress licenstext:
  Copyright (c) 2014 Adam Hathcock, MIT – se länken.
- Att appen på användarens dator hämtar mpv när användaren ber om det är inte att *sprida* den med appen: filen kommer
  från den som byggt den, med dennes licens. Hämtade licenstexter (finns de i arkivet) läggs i
  `%LOCALAPPDATA%\BraXhnTV\mpv\licens\`.
- BraXhn TV är MIT. libmpv-2.dll laddas som en egen fil när appen kör (dynamisk länkning) och kan bytas ut av
  användaren – det är det LGPL kräver av ett program som använder ett LGPL-bibliotek.
- **GPL-byggnaderna får inte läggas i installationsfilen.** shinchiro/mpv-winbuild-cmake (reserven på SourceForge ovan)
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
- `mpv\` – `libmpv-2.dll` som appen hämtat (eller du lagt där), `kalla.json` (vilket arkiv och när), `licens\`,
  och `input.conf` (den inbyggda spelarens tangenter för appen).
- `logg.txt` – vad den inbyggda spelaren och serverkontrollen gjorde (högst 256 kB).

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
- **Den inbyggda spelarens kontrollrad i Windows:** utseendet, att muslagret (ett nästan genomskinligt fönster) tar
  emot klick, hjul och högerklick över mpv-bilden utan att stjäla tangenterna, att muspekaren göms i helskärm, och de
  mörka menyerna. Spåren, längden, volymen och spolningen är provade mot riktig libmpv på Linux.
- **Den inbyggda spelaren i Windows:** att mpv ritar i appens fönster (`wid`), raden överst ovanpå bilden, helskärm,
  bitström till förstärkaren, byte av skärmens frekvens och mpv:s medieruta. Spelardelen (laddning av libmpv,
  spårval, start mitt i filmen, tangenterna, slut, fel och stängning) är provad mot en riktig libmpv 0.37 på Linux,
  och webbens överlämning och serverns beslut är testade i Node – men inte tillsammans i Windows.
- **Hämtningen av mpv i Windows:** dialogrutorna, förloppet, omdirigeringen från GitHub/SourceForge till filen, att
  den hämtade DLL:en laddas utan omstart och bytet vid nästa start. Valet i SourceForge-listan, kontrollen av
  arkiven, uppackningen (även av ett riktigt arkiv från SourceForge), PE-kontrollen och loggen är testade på Linux.

Hittar du fel: *Ladda ner diagnostik* i webbappen fungerar som vanligt, och *Om BraXhn TV* i fönstermenyn visar
appens och WebView2:s version.

## För utvecklare

- `BraXhnTV/` – appen (C#, .NET 8, WinForms + WebView2). `Sidor/start.html` är Välj server / Lägg till server /
  felsidan; den pratar med appen via `chrome.webview.postMessage`. `Inject.cs` körs i serverns sidor och berättar om
  video eller ljud spelas (viloläget) och fångar F11/Esc.
- `BraXhnTV/MpvSetup.cs` – hämtningen av mpv (dialogerna); `Logik/MpvSource.cs` – källorna (`libmpv.json`, SourceForge),
  kontrollen och uppackningen; `Logik/ServerInfo.cs` – serverns version; `Logik/Logg.cs` – loggfilen.
- `BraXhnTV/Spelare/ControlBar.cs` – kontrollraden och muslagret över bilden; `Logik/PlayerUi.cs` – tidsformat,
  tidslinjen, tangentkartan och när raderna syns (testas i `PlayerUiTest`).
- `BraXhnTV/Spelare/` – den inbyggda spelaren: `Libmpv.cs` (C-API:t, laddas dynamiskt, rapporterar varje plats), `MpvPlayer.cs` (en
  uppspelning), `Display.cs` (skärmens frekvens). `MainForm.Spelare.cs` tar emot webbens `native-*`-meddelanden;
  webbens sida är `web/js/player/native.js` och `nativeplan.js`.
- `BraXhnTV.Tests/` – tester som går att köra på alla system: `dotnet test apps/windows/BraXhnTV.Tests` (på Linux/Mac med
  `-p:EnableWindowsTargeting=true`). `BRAXHN_MPV_7Z=<nedladdat mpv-dev-x86_64-….7z>` provar också ett riktigt arkiv. Spelartesterna
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
  and Watch together use the web player. Settings in the app menu (right-click in the window, or on the title bar): *Use the built-in player* (on), *Send audio
  untouched to the receiver*, *Match the display refresh rate*. **mpv is downloaded with one click** when it isn't
  bundled: the app asks once (*Download the built-in player (mpv, about 30 MB)?*) and offers *Download/Update the
  built-in player* in the window menu – never without a click. It fetches BraXhn TV's own LGPL build (the zip that
  `apps/windows/libmpv.json` points to, checked against its SHA-256), or as a fallback the newest
  `mpv-dev-x86_64-….7z` (not `-v3`, which needs AVX2) from the mpv project's SourceForge builds, checks and unpacks
  `libmpv-2.dll` to `%LOCALAPPDATA%\BraXhnTV\mpv\` and uses it without a restart. **Requires server 1.4.1 or later**
  (older servers' web app never hands videos to the app; the app says so). *About the built-in player* shows what was
  tried and why it failed (also a `-v3` file on a CPU without AVX2, probed in a separate process), and the app says once
  why the web player was used for a video; the log is `%LOCALAPPDATA%\BraXhnTV\logg.txt`. 7z unpacking uses SharpCompress (MIT).
- **Away from home** (public address) with Auto, mpv gets the original file when the measured connection fits it with a
  10% margin, or when it could not be measured (`buf=1`; the resolution cap still applies).
- **Player controls:** the app's own control bar (timeline with drag and hover time, −10 s/play/+10 s/next/stop,
  sleep timer, audio/subtitle/speed settings, volume, full screen), fading after 3 s; click = pause, double-click =
  full screen, wheel = volume, right-click = menu (incl. *Play this video in the web player*); keys space/K, ←/→, J/L,
  ↑/↓, F/F11, Esc, Q, M, N, S, A, I and media keys. mpv's own OSC is off.
- **Right-click** shows the app menu instead of the browser menu (text fields keep cut/copy/paste); DevTools are off
  unless `"DevTools": true` in `installningar.json` or `BRAXHN_DEVTOOLS=1`.
- **Not yet tested on real Windows** – it compiles and its logic tests pass, but everything that needs Windows is untried.
