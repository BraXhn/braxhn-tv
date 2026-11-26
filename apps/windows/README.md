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
  server*, den inbyggda spelarens val, *Starta med Windows, Sök efter uppdatering, Om BraXhn TV*. Samma meny finns
  på titelraden (högerklick eller **Alt + mellanslag**). I textfält ger högerklick klipp ut/kopiera/klistra in.
  Webbläsarens egen meny och utvecklarverktygen (Granska) är avstängda; för felsökning slås verktygen på med
  `"DevTools": true` i `installningar.json` eller miljövariabeln `BRAXHN_DEVTOOLS=1`.
- **Byt server, Lägg till server, Starta med Windows, Sök efter uppdatering** finns i appens meny. Ta bort en server i *Byt server* (klicka *Ta bort* två gånger).
- **Helskärm:** **F11**, eller dubbelklicka på videon / helskärmsknappen i spelaren. **Esc** går ur helskärm.
- **Medietangenter och Windows medieruta** (spela/paus på tangentbordet, rutan vid volymen): appen slår på Edge-motorns
  stöd för det, så det som spelas visas där som i Edge.
- Datorn går inte i viloläge och skärmsläckaren startar inte medan **video** spelas. Spelas bara **ljud** hålls
  datorn vaken men skärmen får släckas.
- **Ladda ner** (filmer, export) frågar var filen ska sparas; *Hämtade filer* föreslås.
- Länkar till andra webbplatser (TMDB, IMDb …) öppnas i din vanliga webbläsare.
- **Uppdateringar:** vid start, högst en gång per dygn, frågar appen GitHub om det finns en nyare utgåva med
  Windows-installationsfil. Finns det får du frågan *Hämta och installera*, *Inte nu* eller *Hoppa över den här
  versionen*. Inget laddas ner utan att du klickar.
- **Sök efter uppdatering …** (appens meny och *Om BraXhn TV*) frågar GitHub direkt och visar din version och den
  senaste. Finns en nyare: *Hämta och installera*. Annars *Du har den senaste versionen (1.4.2).* Går det inte att nå
  GitHub säger appen det och erbjuder *Försök igen*. Bara stabila utgåvor (taggar `v1.2.3`) erbjuds, aldrig
  förhandsutgåvor som `libmpv-…` eller betor.
- **Hämta och installera:** appen laddar ner `BraXhnTV-Setup-<version>.exe` från utgåvan (med förlopp och *Avbryt*),
  kontrollerar att storleken stämmer med GitHubs uppgift, att det är ett Windows-program och – när utgåvan har
  `BraXhnTV-Setup-<version>.exe.sha256` – kontrollsumman. Sedan körs installationen utan frågor (bara ett
  förloppsfönster), appen stängs och startar igen av sig själv när installationen är klar. Spelas en film frågar
  appen först (*Filmen stoppas och appen startas om – fortsätta?*) och positionen sparas, så att du fortsätter där du
  var. Vad installationen gjorde står i `%LOCALAPPDATA%\BraXhnTV\installation.txt`.
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

**Spelarraden** (i stil med Plex spelare, i appens färger): inga massiva balkar, utan en mjuk tonad gradient längst
upp och längst ner, så att bilden syns hela tiden.

- **Överst:** tillbakapil, titeln (serien eller filmen, och under den *S1 · E3 · avsnittets namn*) och till höger
  inställningar (kugghjulet: hastighet, undertextstorlek och -tid, sovtimer, *Spela den här filmen i webbspelaren*).
  En påslagen sovtimer syns som minuter kvar bredvid kugghjulet.
- **Nederst:** tidslinjen över hela bredden – tunn i vila, tjockare med musen över, en tydlig punkt för positionen och
  det buffrade ljusare. Vid muspekaren visas tiden (och kapitlet), och en förhandsbild när servern har gjort
  förhandsbilder för filmen. Förfluten tid till vänster; till höger tid kvar (*−29:36*) eller när filmen slutar
  (*slutar 22:41*, med hastigheten inräknad) – klicka för att växla, valet sparas. Under linjen: −10 s, spela/paus,
  +30 s och *Nästa avsnitt* i mitten; ljud och undertexter (en gemensam panel med ljudspåren, undertexterna,
  storlek och tid), volym (reglaget fälls ut när musen är över högtalaren) och helskärm till höger.
- **Paus:** en stor paus-ikon i mitten som tonar bort (och spela-ikonen när filmen fortsätter). Raderna ligger kvar
  så länge filmen är pausad.
- **Hoppa över intro / sammanfattning:** en knapp nere till höger medan introt (eller "tidigare i serien") pågår,
  även när raderna är borta. Har kontot valt att hoppa över automatiskt görs det en gång per avsnitt.
- **Nästa avsnitt:** när eftertexterna börjar (eller de sista 30 sekunderna om servern inte hittat eftertexterna) visas
  ett kort med nästa avsnitts namn, *Spela nu* och *Avbryt*. Med kontots *spela nästa avsnitt automatiskt* räknar
  kortet ner (kontots nedräkning, 8 s som standard) från eftertexternas början och startar nästa avsnitt; utan
  eftertexter startar det när avsnittet tar slut, som förut. Utan automatiken räknar kortet inte ner. *Avbryt* låter
  eftertexterna gå klart och går sedan tillbaka till sidan. Sovtimern *när avsnittet är slut* stoppar nedräkningen.
- Raderna tonas bort efter 3 sekunder utan aktivitet (inte under paus eller när en meny är öppen) och muspekaren göms,
  i helskärm och i fönster. **Bara musrörelser inom spelaren räknas:** pekaren ska vara över appens fönster (inte ett
  annat fönster som ligger över bilden) och flyttas mer än några bildpunkter (skalat med skärmen). Rörelser någon
  annanstans på skärmen visar ingenting, och i 1.4.2 gjorde de det.
- Allt skalas efter skärmens DPI och, i helskärm på en stor skärm, minst som på en 1080p-tv (en 4K-tv med 100 % får
  dubbelt så stora reglage), så att det går att läsa från soffan.

Intro, eftertexter, förhandsbilder, kontots val och nästa avsnitts namn hämtar appen från servern när filmen startar
(`/api/items/<id>`, `/api/me/playback-prefs`, `/api/items/<id>/trickplay`) med webbvyns inloggning – bara från
servern som är öppen. Går det inte visas raden ändå, utan knappen och kortet. mpv:s egna reglage (OSC) och tangenter
är avstängda, så att inget dubbleras.

**Musen på bilden:** klick = spela/paus, dubbelklick = helskärm, hjulet = volym, högerklick = meny (ljudspår,
undertexter, ljud till förstärkaren, uppdateringsfrekvens, *Använd den inbyggda spelaren*, *Om den inbyggda spelaren*,
*Spela den här filmen i webbspelaren*, *Tillbaka*). Klick på gradienten utanför knapparna gör samma sak. Musen fångas
av ett osynligt lager över bilden, eftersom mpv:s fönster körs i en egen tråd; raderna är egna genomskinliga fönster
över det.

**Tangenter:** mellanslag eller **K** = paus, **←/→** eller **J/L** = 10 s, **↑/↓** = volym, **F** eller **F11** =
helskärm, **Enter** = *Hoppa över intro* eller *Spela nu* när de visas (annars paus), **Esc** = bort med kortet med
nästa avsnitt, sedan ur helskärm och sedan tillbaka, **Q** = tillbaka, **M** = ljud av, **N** = nästa avsnitt,
**C** = panelen med ljud och undertexter, **S** = undertext av/på, **A** = byt ljudspår, **I** = mpv:s statistik,
**menytangenten** eller **Skift+F10** = menyn, och medietangenterna. Menyerna styrs med pilarna och Enter. En tangent
visar raderna. Bild-i-bild finns inte än.

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
### mpv i installationsfilen

`libmpv-2.dll` följer med installationsfilen när `apps/windows/libmpv.json` pekar på en färdig byggnad (se *Bygga om
libmpv* nedan). Annars byggs installationsfilen utan den, och webbspelaren spelar allt som förut. *Om den inbyggda
spelaren …* i fönstermenyn visar om mpv finns.

Du kan också lägga en egen `libmpv-2.dll` i `%LOCALAPPDATA%\BraXhnTV\mpv\` (skriv adressen i Utforskarens
adressfält; skapa mappen `mpv` om den saknas – *Om den inbyggda spelaren …* har en knapp som öppnar mappen) och starta
om appen. Appen tar i första hand filen i sin egen mapp (den som följde med installationen) och annars din.

### Licensen

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
- BraXhn TV är MIT. `libmpv-2.dll` laddas som en egen fil när appen kör (dynamisk länkning) och kan bytas ut av
  användaren – det är det LGPL kräver av ett program som använder ett LGPL-bibliotek.
- **Vi bygger libmpv själva som LGPL** (flödet *libmpv*, `apps/windows/libmpv/bygg.sh`): mpv med `-Dgpl=false`, FFmpeg
  utan `--enable-gpl` och `--enable-nonfree`, och bara bibliotek med LGPL-förenliga licenser:

  | Del | Licens | Varför |
  |---|---|---|
  | mpv | LGPL 2.1+ | spelaren (bara libmpv, inte mpv.exe) |
  | FFmpeg | LGPL 2.1+ | avkodning, D3D11VA/DXVA2 (grafikkortet), https (Schannel) |
  | libplacebo | LGPL 2.1+ | bildbehandlingen (`vo=gpu-next`), HDR och Dolby Vision |
  | GNU FriBidi | LGPL 2.1+ | höger-till-vänster-text i undertexter |
  | libass | ISC | ASS/SSA-undertexter (typsnitt via DirectWrite) |
  | FreeType, HarfBuzz | FTL, MIT | typsnitt för undertexterna |
  | dav1d | BSD 2 | AV1 |
  | Little CMS | MIT | färghantering (ICC-profiler) |
  | Lua 5.2 | MIT | mpv:s reglage (OSC) |
  | shaderc, SPIRV-Tools, SPIRV-Cross, glslang, SPIRV-Headers | Apache 2.0, BSD 3, MIT | Direct3D 11-utritningen |
  | zlib | zlib | komprimerade MKV-spår |

  Inget av x264, x265, libpostproc, GPL-filter, fdk-aac, DVD/Blu-ray eller rubberband är med. Eftersom delar under
  Apache 2.0 är inbyggda sprids filen som helhet under **LGPL 3** (mpv och FFmpeg tillåter "2.1 eller senare").
- **Flödet faller om något GPL kommit med:** FFmpegs `configure` måste säga `License: LGPL version 2.1 or later`
  (`CONFIG_GPL 0`, `CONFIG_NONFREE 0`, inget GPL-bibliotek påslaget), mpv måste ha `gpl=false` (`HAVE_GPL 0`), och i den
  färdiga `libmpv-2.dll` ska varje FFmpeg-del säga `license: LGPL version 2.1 or later` och mpv:s byggrad innehålla
  `-Dgpl=false`. Filen får inte behöva några andra DLL-filer än Windows egna.
- **Källkoden** ligger i samma utgåva som filen (`libmpv-<version>-<datum>-kallkod.tar`: varje källa som oförändrat
  arkiv plus byggskripten), och `KALLOR.txt` i zip-filen listar exakta versioner med sha256/commit. Utgåvan tas inte
  bort, så källkoden finns kvar så länge filen sprids (LGPL 3 / GPL 3 avsnitt 6).
- Installationsfilen visar licenssidan (`installer/licens.txt`: MIT för appen, LGPL för spelaren) och lägger
  `libmpv-2.dll` i appens mapp och licenstexterna (LGPL 2.1, LGPL 3, GPL 3), `mpv-licens.txt`, `KALLOR.txt` och varje
  biblioteks licens (`licenser\`) i mappen `mpv-licens`.
- GPL-byggnaderna (shinchiro/mpv-winbuild-cmake på SourceForge) får inte läggas i installationsfilen – att ladda ner dem
  för egen del är fritt.

### Bygga om libmpv (ny mpv-version)

1. På GitHub: *Actions* → **libmpv** → *Run workflow*. Lämna *mpv-version* tom för versionen i
   `apps/windows/libmpv/kallor.txt`. För en annan version: skriv versionen (t.ex. `0.43.0`) och taggens commit
   (`git ls-remote https://github.com/mpv-player/mpv 'refs/tags/v0.43.0^{}'`) – eller, bättre, ändra raden i
   `kallor.txt` så att den versionen gäller framöver.
2. Första gången tar det en till två timmar (beroendena cachas till nästa gång). Flödet skapar förhandsutgåvan
   `libmpv-<version>-<datum>` med zip-filen, källkodsarkivet och `…-SHA256SUMS.txt`. Den blir aldrig *Latest*, så
   serverns och appens uppdateringskoll ser den inte.
3. Öppna körningens sammanfattning och kopiera raderna till `apps/windows/libmpv.json` (`tagg`, `fil`, `sha256`).
   Checka in. Nästa installationsfil (flödet *Windows-app*) hämtar filen därifrån och kontrollerar SHA-256.
4. Ta inte bort äldre libmpv-utgåvor så länge någon installationsfil som använder dem finns kvar – källkoden ligger där.

Andra beroenden byts på samma sätt: ändra version, adress och sha256 (eller commit) i `kallor.txt` och kör flödet.
Bygget går också att köra lokalt på Ubuntu 24.04 med samma paket som i flödet: `apps/windows/libmpv/bygg.sh <mapp>`.

## Var sparas vad?

`%LOCALAPPDATA%\BraXhnTV\`

- `installningar.json` – serverlistan, fönstrets storlek och läge, när uppdateringar senast kontrollerades.
- `Servrar\<id>\` – WebView2:s data för varje server (inloggning, kakor, cache). Servrar delar aldrig kakor.
- `App\` – data för appens egna sidor (Välj server, Lägg till server).
- `mpv\` – `libmpv-2.dll` som appen hämtat (eller du lagt där), `kalla.json` (vilket arkiv och när), `licens\`,
  och `input.conf` (den inbyggda spelarens tangenter för appen).
- `logg.txt` – vad den inbyggda spelaren och serverkontrollen gjorde (högst 256 kB).
- `mpv\` – `libmpv-2.dll` om du lagt den där själv, och `input.conf` (den inbyggda spelarens tangenter för appen).

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
- **Hämta och installera i Windows:** dialogrutorna, förloppet, den tysta installationen (`/SILENT … /STARTAPP`), att
  appen stängs och startar igen efteråt, och att filmens position sparas innan. Valet av fil i utgåvan, versionerna,
  kontrollen av storlek, SHA-256 och PE-huvud och installationsfilens argument är testade (`UppdateringTest`).
- **Den inbyggda spelarens rad i Windows:** utseendet (gradienterna, ikonerna, storleken på en tv), att raderna som
  genomskinliga fönster (`UpdateLayeredWindow`) ritas rätt över mpv-bilden och tonas, att muslagret och raderna tar
  emot klick, hjul och högerklick utan att stjäla tangenterna, att muspekaren göms, förhandsbilderna, kortet med nästa
  avsnitt och de mörka menyerna. Regeln för när musen visar raderna, tider, sluttid, intro-/eftertextfönstren,
  nedräkningen, förhandsbildernas rutor och tolkningen av serverns svar är testade (`SpelarradTest`); spåren,
  längden, volymen och spolningen är provade mot riktig libmpv på Linux.
- **Den inbyggda spelaren i Windows:** att mpv ritar i appens fönster (`wid`), raden överst ovanpå bilden, helskärm,
  bitström till förstärkaren, byte av skärmens frekvens och mpv:s medieruta. Spelardelen (laddning av libmpv,
  spårval, start mitt i filmen, tangenterna, slut, fel och stängning) är provad mot en riktig libmpv 0.37 på Linux,
  och webbens överlämning och serverns beslut är testade i Node – men inte tillsammans i Windows.
- **Hämtningen av mpv i Windows:** dialogrutorna, förloppet, omdirigeringen från GitHub/SourceForge till filen, att
  den hämtade DLL:en laddas utan omstart och bytet vid nästa start. Valet i SourceForge-listan, kontrollen av
  arkiven, uppackningen (även av ett riktigt arkiv från SourceForge), PE-kontrollen och loggen är testade på Linux.
- **Vår egen libmpv-2.dll** (flödet *libmpv*): bygget och LGPL-kontrollerna är körda lokalt på Ubuntu 24.04 med samma
  skript (mpv 0.42.0, FFmpeg 9.0.2; filen blir ungefär 50 MB, zip-filen 21 MB), men filen är inte provad i Windows,
  och flödet är inte kört på GitHub. Windows medieruta från mpv (`media-controls`, SMTC) är inte med: den kräver
  C++/WinRT-huvuden som Ubuntus MinGW saknar – appens egen medieruta via WebView2 påverkas inte.

Hittar du fel: *Ladda ner diagnostik* i webbappen fungerar som vanligt, och *Om BraXhn TV* i fönstermenyn visar
appens och WebView2:s version.

## För utvecklare

- `BraXhnTV/` – appen (C#, .NET 8, WinForms + WebView2). `Sidor/start.html` är Välj server / Lägg till server /
  felsidan; den pratar med appen via `chrome.webview.postMessage`. `Inject.cs` körs i serverns sidor och berättar om
  video eller ljud spelas (viloläget) och fångar F11/Esc.
- `BraXhnTV/MpvSetup.cs` – hämtningen av mpv (dialogerna); `Logik/MpvSource.cs` – källorna (`libmpv.json`, SourceForge),
  kontrollen och uppackningen; `Logik/ServerInfo.cs` – serverns version; `Logik/Logg.cs` – loggfilen.
- `BraXhnTV/Updater.cs` – uppdateringarna (dialogerna); `Logik/Versions.cs` – versioner och GitHub-svaret,
  `Logik/Uppdatering.cs` – kontrollen av installationsfilen och dess argument (testas i `UppdateringTest`).
- `BraXhnTV/Spelare/Reglage.cs` – spelarraden (`PlayerChrome`: raden överst och nederst, hörnet med *Hoppa över* och
  nästa avsnitt, paus-ikonen) och muslagret över bilden; `Spelare/Lager.cs` – genomskinliga fönster
  (`UpdateLayeredWindow`, GDI+ i en DIB). `Logik/Spelarrad.cs` – när musen visar raderna, skalan, tid kvar och sluttid,
  titeln, intro/eftertexter, nedräkningen, förhandsbilderna och serverns svar (testas i `SpelarradTest`);
  `Logik/PlayerUi.cs` – tidsformat, tidslinjen och tangentkartan (testas i `PlayerUiTest`).
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
  *Check for updates …* (app menu and *About*) shows your version and the latest one; *Download and install* downloads
  the installer, checks its size, that it is a Windows program and its SHA-256 (when the release has a `.sha256` file),
  installs it silently and restarts the app. A playing video is stopped (after asking) and its position saved.
  Only stable releases (`v1.2.3` tags) are offered.
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
- **Player controls** (Plex-like, in the app's colours): soft gradients at the top and bottom instead of solid bars.
  Top: back arrow, title (show, *S1 · E3 · episode name*), settings (speed, subtitle size/timing, sleep timer, web
  player). Bottom: full-width timeline (thin at rest, thicker on hover, position dot, buffered part lighter, hover time
  with chapter and a trickplay thumbnail when the server has them), elapsed time left and time left or "ends 10:41 PM"
  right (click to switch), −10 s/play/+30 s/next in the middle, audio & subtitles panel, volume with a slide-out
  slider and full screen on the right. A large pause icon fades out on pause and the bars stay while paused. *Skip
  intro*/*Skip recap* bottom right; at the credits (or the last 30 s) a next-episode card with *Play now*/*Cancel* that
  counts down when the account has autoplay on. Bars and cursor fade after 3 s; only pointer movement inside the
  player (over the app, more than a few pixels) shows them. Scales with DPI and with a large full-screen display. Click
  = pause, double-click = full screen, wheel = volume, right-click = menu; keys space/K, ←/→, J/L, ↑/↓, F/F11,
  Enter (skip/play now), Esc, Q, M, N, C (audio & subtitles), S, A, I, menu key/Shift+F10 and media keys.
- **Right-click** shows the app menu instead of the browser menu (text fields keep cut/copy/paste); DevTools are off
  unless `"DevTools": true` in `installningar.json` or `BRAXHN_DEVTOOLS=1`.
  and Watch together use the web player. Settings in the window menu: *Use the built-in player* (on), *Send audio
  untouched to the receiver*, *Match the display refresh rate*. libmpv is **built by us as LGPL** (workflow
  *libmpv*: mpv `-Dgpl=false`, FFmpeg without `--enable-gpl`/`--enable-nonfree`, only LGPL-compatible libraries; the
  workflow fails if anything GPL slips in) and published with its full source in a `libmpv-<version>-<date>`
  pre-release. `apps/windows/libmpv.json` names the release and SHA-256 the installer uses; rebuild with *Actions →
  libmpv → Run workflow* and copy the values from the run summary.
- **Not yet tested on real Windows** – it compiles and its logic tests pass, but everything that needs Windows is untried.
