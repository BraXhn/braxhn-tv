# Backlogg

Teamets arbetslista. Här står vad som pågår, vad som står näst på tur och vad som väntar på ägaren.

**Så hålls den aktuell**

- Läs filen i början av varje arbetspass och uppdatera den i slutet, i samma gren som arbetet.
- Det du börjar på flyttas till *Pågår* med gren och datum. Det som är klart flyttas till *Klart* med version eller
  commit, och raden i *Näst på tur* tas bort.
- *Näst på tur* har högst tio punkter i rangordning. Kommer en ny in åker den sista ner till *Idéer*.
- Ordningen följer nyttan för en familj som använder servern varje dag: först snabb och stabil uppspelning, sedan
  det som saknas mest. Jämför ärligt med Plex, Jellyfin, Emby, Infuse, Spotify/Plexamp och Audiobookshelf.
- Skriv bara det som är kontrollerat i koden eller uppmätt. Är något en gissning, skriv "kontrollera först".
- Det som kräver ägarens konton, hårdvara eller beslut står under *Bara Anton kan göra*.

Underlag: [jamforelse.md](jamforelse.md), [funktioner.md](funktioner.md), [testat.md](testat.md),
[CHANGELOG.md](../CHANGELOG.md) och avsnittet *Testat och otestat* i [README.md](../README.md).

Senast genomgången: 2026-11-24 (efter version 1.2.2).

## Pågår

*(inget just nu)*

## Näst på tur

### 1. Uppspelningsvakt i riktig Chrome inför varje utgåva

- **Vad:** utöka `test/web-chrome-playback.test.js` så att det mäter tid från klick till första bildruta, tappade
  bildrutor, spolning och *Fortsätt titta* på några riktiga filtyper (öppen GOP, HEVC, MKV med DTS), och kör det som
  ett eget steg inför varje utgåva. Siffrorna skrivs i `docs/testat.md`.
- **Varför:** frysningarna i Chrome nådde användarna och rättades först i 1.2.1. Det som familjen märker mest är om
  filmen startar direkt och inte hackar. Plex och Infuse är bra just här.
- **Filer:** `test/web-chrome-playback.test.js`, `test/media/*`, `.github/workflows/test.yml`, `docs/testat.md`.
- **Klart när:** testet faller om starttiden eller antalet tappade bildrutor blir sämre än de uppmätta värdena, och
  körs i GitHub Actions för varje utgåva.

### 2. Fortsätt titta på iPhone: mät startpositionen med Apples spelare

- **Vad:** lägg till ett fall med startposition (`start=` och `EXT-X-START`) i `test/media/AVPlayerCheck.swift` och
  `test/media/apple-check.mjs`, som redan körs på macOS i `conformance.yml`. I dag provar de inte startposition.
- **Varför:** rättningen i 1.2.1 för iPhone och iPad är inte provad på en riktig enhet. Att filmen fortsätter där
  man slutade är grundläggande på telefon och surfplatta.
- **Filer:** `test/media/AVPlayerCheck.swift`, `test/media/apple-check.mjs`, `.github/workflows/conformance.yml`,
  `server/stream.js` (bara om mätningen visar fel).
- **Klart när:** körningen på macOS visar att uppspelningen börjar inom två sekunder från begärd position utan att
  segment 0 hämtas först, och Anton har bekräftat på en riktig iPhone (se *Bara Anton kan göra*).

### 3. Hårdvaruomkodning: provet i Administration ska ge ett svar man kan lita på

- **Vad:** `POST /api/setup/hw-test` finns och används i installationsguiden. Gör resultatet synligt även under
  Administration, med uppmätt hastighet (bildrutor per sekund) för H.264 och HEVC och med ffmpegs felrad när det inte
  går. Lägg resultatet i diagnostikpaketet.
- **Varför:** NVENC, VAAPI och QSV är inte verifierade på riktig hårdvara – bara kommandoraderna. Ett prov som
  användaren själv kör är det enda sättet att veta att omkodningen går på grafikkortet och inte på processorn, där
  4K hackar.
- **Filer:** `server/routes/setup.js`, `server/stream.js` (`testEncode`), `server/diagnostics.js`,
  `web/js/views/setup.js`, administrationsvyn, `web/i18n/en.js`.
- **Klart när:** en administratör ser "grafikkortet används, N bildrutor/s" eller en begriplig förklaring, och Anton
  har kört provet med NVENC (se *Bara Anton kan göra*).

### 4. Expo-appen: musik, ljudböcker och poddar

- **Vad:** flikar för musik, ljudböcker och poddar med bakgrundsuppspelning, sparad position och låsskärmens knappar.
- **Varför:** Spotify/Plexamp och Audiobookshelf används mest på telefonen, med låst skärm och i hörlurar. Appen
  har i dag bara film och serier.
- **Filer:** `apps/expo/src/screens/*` (nya skärmar), `apps/expo/src/api.ts`, `apps/expo/package.json`.
- **Klart när:** en ljudbok fortsätter där man slutade efter att appen stängts, och musiken spelar med låst skärm.

### 5. Expo-appen: nedladdning för offline

- **Vad:** ladda ner film, avsnitt och ljudböcker till telefonen (`/api/items/:id/offline`, kräver rätten att ladda
  ner) och spela dem utan nät. Framsteg skickas när nätet är tillbaka (fältet `at` i `POST /api/items/:id/progress`).
- **Varför:** bilresor och flyg med barn. Plex, Infuse och Audiobookshelf har det.
- **Filer:** `apps/expo/src/*`, `apps/expo/README.md`.
- **Klart när:** en nedladdad film spelas i flygplansläge och positionen syns på servern efteråt.

### 6. Android-appen på engelska

- **Vad:** flytta texterna till `res/values/strings.xml` med svenska i `values-sv` (appen har i dag ingen
  `strings.xml` och ett hundratal texter direkt i Kotlin-koden) och översätt dem.
- **Varför:** webben och iOS-appen finns på engelska. Android-appen är den enda delen som en engelskspråkig
  användare inte kan använda.
- **Filer:** `apps/automotive/app/src/main/java/**`, `apps/automotive/app/src/main/res/values*/strings.xml`,
  `apps/automotive/README.md`, `README.md`, `README.en.md`.
- **Klart när:** appen följer telefonens språk, inga svenska texter syns på en engelsk telefon, och bygget i GitHub
  Actions går igenom.

### 7. Sömntimer i videospelaren

- **Vad:** samma val som i ljudspelaren (15, 30, 60 minuter eller "efter det här avsnittet") i videospelarens meny.
- **Varför:** den som somnar till en serie vaknar annars tre avsnitt senare, och *Fortsätt titta* pekar fel. Finns
  för ljud men inte för video (kontrollerat i `web/js/player/`).
- **Filer:** `web/js/player/controls.js`, `web/js/player/video.js`, `web/i18n/en.js`, `web/sw.js` om en ny modul
  behövs.
- **Klart när:** uppspelningen stannar vid vald tid, positionen sparas där, och valet finns på engelska.

### 8. Skärmtid: mät räkningen vid paus och visa tiden som är kvar

- **Vad:** servern räknar nu tiden även från själva strömmen. Mät i riktig Chrome och Safari att paus inte räknas
  (direktuppspelning av en stor fil och HLS), och visa "X minuter kvar" i spelaren i webben och apparna när det är
  mindre än tio minuter kvar.
- **Varför:** skärmtiden är det föräldrar litar mest på. Räknas paus som tittande tappar barnen förtroendet för den,
  och ett stopp utan förvarning mitt i ett avsnitt ger bråk.
- **Filer:** `server/http/context.js` (`countStream`), `server/screentime.js`, `web/js/player/overlay.js`,
  `test/security-review4.test.js`, `test/web-family.test.js`.
- **Klart när:** tio minuters paus ger högst en halv minuts räknad tid i båda webbläsarna, och varningen syns.

### 9. Engelska i notiser, serverns felmeddelanden och offlinesidan

- **Vad:** notiser, felmeddelanden från servern och offlinesidan finns bara på svenska. Låt dem följa profilens
  språk (`users.lang`).
- **Varför:** en engelskspråkig användare får i dag svenska fel mitt i ett engelskt gränssnitt.
- **Filer:** `server/notify.js`, `server/util.js` (`fail`), `server/http/router.js`, `web/i18n/en.js`,
  `web/offline.html`.
- **Klart när:** de vanligaste felen (inloggning, skärmtid, åldersgräns, nedladdning) och notiserna visas på
  profilens språk, med test.

## Idéer

Kortare rader, inte rangordnade. Flytta upp en punkt när den blir aktuell.

**Från arbetspasset 2026-11-25 (sett men inte gjort)**
- Öppen GOP: skicka `mse=1` bara när webbläsaren avkodar i mjukvara (`mediaCapabilities.decodingInfo().powerEfficient`
  i `web/js/player/video.js`), så att Chrome med grafikkortsavkodning slipper omkodningen.
- Öppen GOP: efter ett byte till omkodning gäller `forceTc` resten av spelarsessionen, så ett senare val av *Original*
  kodas också om (`web/js/player/video.js`).
- Öppen GOP: åtta prov per fil missar ungefär var tionde fil med många felande nyckelbilder; ett ffmpeg-anrop med
  flera `-ss` skulle halvera provets kostnad (`server/opengop.js`). Chromecast (också MSE) är inte provad med öppen GOP.
- Kvalitetsetiketterna går inte via `t()` (*1,5 Mbit/s* med decimalkomma även på engelska; `QUALITY_STEPS` i
  `web/js/player/hlsconfig.js`).
- Musik: Subsonic-appar kunde dela kön med webben via `savePlayQueue`/`getPlayQueue` (`server/subsonic.js`,
  `server/musicqueue.js`).
- Musik: en bok eller podd återställs inte i minispelaren efter omladdning (`playSpoken` i `web/js/audio.js`).
- Musik: `M.offset` och `M.transcoded` nollställs inte när motorn tar över efter ett omkodat element som spolats
  (`HOOKS.advance` i `web/js/audio.js`) – tiden och Föregående blir fel för nästa låt.
- Musik: spolning i elementet efter att nästa buffert startat tappas tyst (`web/js/audio.js`).
- Musikfältets knappar är 34 px på telefon, under 44 px som rekommenderas för fingrar (`.mic` i `web/style.css`).
- Expo-appen använder inte den sparade musikkön (`/api/me/queue`) – hör till musiken i punkt 4 (förslag på
  uppläggning i gren `team/expo-2026-11-25`, rapporten).
- iOS- och Android-apparna sparar bildtoken bara i minnet och tar en ny vid varje start (`restore()` i
  `apps/apple/Shared/AppModel.swift`, `refreshImageToken` i `apps/automotive/.../Api.kt`) – samma knuff mot taket på
  50 som Expo-appen hade. Spara den som Expo-appen gör nu.
- Medietoken skapas vid varje uppspelningsanrop utan tak per användare (`server/routes/playback.js`, `routes/books.js`).
- Datum i UTC: audit-texten för inbjudan och diagnostikfilens namn (`server/routes/admin.js`, `server/diagnostics.js`),
  och fotots dag i Minnen (`dayOf` i `server/photos.js`, om det inte är avsiktligt).
- `/api/libraries` skickar alla kolumner (`l.*`) till andra än administratörer; en vitlista vore säkrare
  (`server/routes/library.js`).
- Takten på `/direct` för profiler med skärmtid är inte provad med riktiga appar (AVPlayer, ExoPlayer, Chromecast,
  AirPlay) och inte genom startcachen (`server/pace.js`).
- Webbtester som delar konto kan få en synlig minispelare från förra testets musikkö; en gemensam hjälpare som tömmer
  kön vore säkrare.

**Från arbetspasset 2026-11-24 (sett men inte gjort)**
- Omkodningens start tar 0,7–0,9 s och är den långsammaste vägen (`transcodeStarts`, `encArgs` i `server/stream.js`).
- Rena tidsmätningar av start, spolning och kvalitetsbyte på en obelastad maskin (skriptet från passet mätte under last).
- Feedback: notis till administratören när ett ärende väntar; öppna ett avslutat ärende igen; gallra gamla ärenden;
  Feedback-knapp i apparna (iOS, Android, Expo); knappens plats under riktig uppspelning och på TV är inte provad.
- Serverns etiketter för spår och avsnitt utan titel (*Avsnitt N*) är svenska även på engelska.
- Cast-skriptet ger fyra konsolfel per sidladdning över vanlig http (CSP tillåter bara https).
- M4A med `moov` sist kan inte snabbstartas (1,6 s på 20 Mbit/s); servern kan skicka `moov` först.
- FLAC 96 kHz på långsamt nät hackar: webben begär aldrig omkodning av musik (`br=` används inte).
- `test/familyfilter.test.js` (webbspelarens tystning) och samplingsfrekvenstestet i `test/web-audio-robust.test.js`
  har fallit någon gång under hög belastning. Gör tidsgränserna tåligare.

**Uppspelning och stabilitet**
- `docs/jamforelse.md` är inaktuell: den säger att fjärråtkomst utan portöppning saknas (BraXhn Relay finns) och att
  apparna är pausade. Skriv om den efter läget i 1.2.2.
- Anpassningsbar kvalitet i Safari, AVPlayer, ExoPlayer och Chromecast är inte provad på riktigt – ta med i
  uppspelningsvakten där det går.
- Kvarlämnade mappar `*.gone-*` i omkodningsmappen efter avstängning (töms vid nästa start) – städa innan processen
  avslutas.
- `test/familyfilter.test.js` (webbspelarens tystning) faller ibland när maskinen är hårt belastad – gör
  tidsgränserna tåligare.
- Docker-imagen för arm64 byggs i GitHub Actions men är inte provad på en arm-maskin.

**Säkerhet och integritet**
- `GET /api/libraries` lämnar bibliotekens sökvägar på servern (`path`, `paths`) till alla inloggade, även
  barnprofiler. Ta bort dem för andra än administratörer – kontrollera först att apparna inte läser fälten.
- Skärmtiden kan fortfarande kringgås av den som hämtar hela originalfilen snabbt och tittar ur egen kopia. Överväg
  att begränsa hastigheten på `/direct` för profiler med skärmtid.
- `POST /api/media-token` skapar en ny rad i `sessions` vid varje anrop utan tak per användare.
- Reläets admin: spärren mot felaktiga token hindrar inte nya försök (rätt token släpps igenom även när spärren
  slagit till). Token är minst 16 tecken, så risken är liten.
- Enkel inloggning (OIDC) saknar knapp i apparna.

**Det som saknas jämfört med andra**
- Egna appar för Samsung- och LG-TV, Roku och Fire TV (Plex, Jellyfin och Emby har dem). I dag: webbläsaren och DLNA.
- Automatiska undertexter med tal till text. Går inte utan en modell – strider mot "inga beroenden".
- CarPlay (kräver tillstånd från Apple, se *Bara Anton kan göra*).
- Röststyrning (Alexa, Google Assistant). Webhooks och API-nycklar finns för Home Assistant.
- Ansiktsigenkänning i foton (Plex har det). Låg nytta här.
- Skicka e-bok till läsplatta med e-post (Audiobookshelf har det) – kontrollera först om det redan finns.
- Expo-appen: live-TV och TV-guide.

**Småfel**
- Inspelningens datum i filens metadata (`server/dvr.js`) och datumet i filnamnen för exporter (Min historik,
  ordlistan, Mina uppgifter) räknas i UTC – mellan midnatt och kl. 01–02 blir det gårdagens datum.

## Klart

- 2026-11-25 (gren `team/expo-2026-11-25`): Expo-appen – *Vem tittar?* efter inloggningen och *Byt profil* under
  Konto, med PIN och huvudkontots lösenord som i webben; barnprofiler ser bara det de får se. Bildtoken sparas per
  server och profil och förnyas bara när den snart går ut eller servern svarar 401.
- 2026-11-25 (gren `team/android-2026-11-25`): Android-appen på engelska och svenska efter telefonens språk – texterna i
  `res/values/strings.xml` (engelska, standard) och `res/values-sv/strings.xml`, ordval som webben;
  `test/android-i18n.test.js` hindrar svensk text i Kotlin-koden. Bygget i GitHub Actions är inte kört än.
- 2026-11-25 (i `:edge`): Femte granskningen av servern – sökvägar bara för administratörer, takt på originalfilen för
  profiler med skärmtid, tak för bildtoken, reläets spärr först, lokalt datum i inspelningar och exporter.
- 2026-11-25: Musikkön och platsen sparas per profil på servern och finns kvar efter omladdning; Föregående och
  spolning vid låtbyte rättade; musikfältet med ikoner som ryms på telefon.
- 2026-11-25: Öppen GOP känns igen på servern (remux från början, omkodning vid Fortsätt titta och spolning);
  kvalitetsmenyn efter källans upplösning; spårens namn efter språket i spelaren, Chromecast och fjärrstyrningen.
- 2026-11-24 (efter 1.2.2, i `:edge`): Feedback och felrapporter i appen med granskning under Administration → Support.
- 2026-11-24: Öppen GOP i webben – Fortsätt titta och spolning fastnar inte längre på avkodningsfel.
- 2026-11-24: Fjärde granskningen av servern (skärmtid räknas från strömmen, skanningens status, sortering).
- 2026-11-24: Webben på TV och telefon (fjärrkontroll i spelarens inställningar, större reglage, undertexternas namn).
- 2026-11-24: Musikspelaren (minnesläcka vid glapplöst, avbrutna hämtningar, nätavbrott, växande början).

## Bara Anton kan göra

- Ge teamet serverns adress utifrån och en API-nyckel med behörigheten *Support* (utan *Bara från hemnätet*), så att godkända ärenden kan hämtas.
- Läs den nya formuleringen i `PRIVACY.md` om feedback och felrapporter.

- **Supporttråd på Unraid-forumet:** skapa tråden och skicka länken, så att `<Support>` i `braxhn-tv.xml` och
  `braxhn-tv-nvidia.xml` kan peka dit (i dag pekar den på GitHub-ärenden).
- **Skicka in mallen till Community Applications.**
- **Gör paketet publikt** (containerimagen på GitHub).
- **Slå på Private vulnerability reporting** i repots inställningar på GitHub.
- **Prova Expo-appen i Expo Go** på en riktig iPhone och Android-telefon (`apps/expo/README.md`).
- **Prova återupptagning på iPhone** (Safari, version 1.2.2): börja på en film, stäng, öppna igen – fortsätter den på
  rätt ställe direkt?
- **Prova hack i Chrome på version 1.2.2** med de filer som frös förut.
- **Kör hårdvaruprovet med NVENC** på Unraid-servern och skicka resultatet (se punkt 3).
- Det som i övrigt kräver riktig hårdvara eller konton står i *Testat och otestat* i README: Chromecast och AirPlay,
  Google TV-appen på en TV, Android Auto, Let's Encrypt med en publik domän, BraXhn Relay på en riktig VPS, riktiga
  IPTV-leverantörer och passkeys på telefon.
- **CarPlay:** ansök om tillståndet hos Apple om det ska byggas.
