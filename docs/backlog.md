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

### 1. Fortsätt titta på iPhone: mät startpositionen med Apples spelare

- **Vad:** lägg till ett fall med startposition (`start=` och `EXT-X-START`) i `test/media/AVPlayerCheck.swift` och
  `test/media/apple-check.mjs`, som redan körs på macOS i `conformance.yml`. I dag provar de inte startposition.
- **Varför:** rättningen i 1.2.1 för iPhone och iPad är inte provad på en riktig enhet. Att filmen fortsätter där
  man slutade är grundläggande på telefon och surfplatta.
- **Filer:** `test/media/AVPlayerCheck.swift`, `test/media/apple-check.mjs`, `.github/workflows/conformance.yml`,
  `server/stream.js` (bara om mätningen visar fel).
- **Klart när:** körningen på macOS visar att uppspelningen börjar inom två sekunder från begärd position utan att
  segment 0 hämtas först, och Anton har bekräftat på en riktig iPhone (se *Bara Anton kan göra*).

### 2. Hårdvaruomkodning: provet i Administration ska ge ett svar man kan lita på

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

### 3. Expo-appen: musik med låst skärm på riktig telefon, och nästa låt på låsskärmen

- **Vad:** musiken, ljudböckerna och poddarna finns i Expo-appen (se *Klart*), men bakgrundsljud och låsskärmen är
  bara provade i webbläget. Prova i Expo Go och i ett eget bygge (`npx expo prebuild`) på iPhone och Android: spelar
  musiken vidare med låst skärm i mer än tre minuter, fungerar hörlurarnas knappar, och visas omslaget? Lägg sedan
  till nästa/föregående låt på låsskärmen – `expo-audio` ger de knapparna bara för `AudioPlaylist`, så kön behöver
  matas in där (adresserna hämtas per låt med `/api/music/tracks/:tid/play`).
- **Varför:** Spotify/Plexamp används mest med låst skärm och i hörlurar; utan nästa låt på låsskärmen och i
  hörlurarna är appen sämre än dem just där det räknas.
- **Filer:** `apps/expo/src/music.ts`, `apps/expo/app.json`, `apps/expo/README.md`.
- **Klart när:** en timmes musik spelar med låst skärm på båda telefonerna, och nästa/föregående på låsskärmen och i
  hörlurarna byter låt.

### 4. Expo-appen: nedladdning för offline

- **Vad:** ladda ner film, avsnitt och ljudböcker till telefonen (`/api/items/:id/offline`, kräver rätten att ladda
  ner) och spela dem utan nät. Framsteg skickas när nätet är tillbaka (fältet `at` i `POST /api/items/:id/progress`).
- **Varför:** bilresor och flyg med barn. Plex, Infuse och Audiobookshelf har det.
- **Filer:** `apps/expo/src/*`, `apps/expo/README.md`.
- **Klart när:** en nedladdad film spelas i flygplansläge och positionen syns på servern efteråt.

### 5. Skärmtid i Safari och apparna: paus och tiden kvar

- **Vad:** mät i Safari (direktuppspelning och Safaris egen HLS) att paus inte räknas, på samma sätt som i Chrome
  (skript: spela, pausa 60 s och 10 min, läs `/api/screentime`). Visa tiden kvar och varningen i spelaren i iOS-,
  Android- och Expo-apparna (fältet `screenTime` finns i svaret på framstegsrapporten).
- **Varför:** webben visar nu tiden kvar och paus räknas inte där; i apparna stoppas barnet fortfarande utan förvarning.
- **Filer:** `apps/*` (spelarna), `server/screentime.js` bara om mätningen visar fel.
- **Klart när:** tio minuters paus ger högst en halv minut i Safari, och varningen syns i apparna.

### 6. Hemma via den publika adressen i iOS/tvOS-appen

- **Vad:** samma som Expo-appen (`apps/expo/src/localpick.ts`, `goHomeIfHere` i `api.ts`) och Android-appen
  (`apps/automotive/…/LocalPick.kt`, `Hemma.kt`) gör, docs/api.md *Hemma via den publika adressen*: hämta `/api/local` från den sparade adressen, prova `addrs` med `/api/local/ping?n=` (800 ms,
  ingen inloggning), använd hemadressen när `id` och `proof` stämmer, och gå tillbaka till den sparade vid nätverksfel.
- **Varför:** servern, Expo- och Android-appen är klara (se *Klart*), men Apple TV-appen står oftast hemma och är just den
  som sparats med reläets adress.
- **Filer:** `apps/apple/Shared/AppModel.swift` (`server`). Apple byggs bara med Xcode – kontrollera först att klartext-http
  till en privat adress är tillåten (ATS `NSAllowsLocalNetworking`).
- **Klart när:** en Apple TV hemma med reläets adress spelar med `remote: false` i `/api/status`, och tillbaka via reläet
  när hemadressen inte svarar.

## Idéer

Kortare rader, inte rangordnade. Flytta upp en punkt när den blir aktuell.

**Från arbetspasset 2026-11-25 (sett men inte gjort)**
- Skärmtid: hls.js hämtar segment i upp till 60 s framåt även när filmen är pausad, och varje segment är ett
  livstecken – kort efter start eller spolning, och med en långsam omkodning, kan några sekunder av pausen räknas
  (inte uppmätt med omkodning; remux hemma fyllde bufferten på 6 s och räknade 0 s).
- Sovtimern i videospelaren tonar ner med `video.volume`; med Nattläge/Tydligare dialog (Web Audio, `player/comfort.js`)
  är nedtoningen inte provad, och apparna (iOS, Android, Expo) har ingen sovtimer för video.
- Engelska i servern, det som är kvar: fel med variabler som saknar nyckel i `web/i18n/en.js` (t.ex. bibliotekets
  mappfel i `server/routes/library.js`, Sonarr/Radarr i `server/routes/health.js`), administratörens tekniska fel
  (ffmpeg, nätet, IPTV) och diskens namn i disklarmet (`server/diskmon.js`, *Konfiguration*). Fältet `weekday` i
  skärmtidens status är kvar på svenska (ingen klient läser det).
- Katalogen har en nyckel per svensk text: *Samlingar* betyder både filmsamlingar (startsidans hylla) och
  samlingsalbum (musiken) men översätts alltid *Compilations* – hyllan heter fel på engelska i webben och i
  `/api/me/home-layout`. Kräver en egen nyckel för hyllan (`web/js/views/home.js`, `server/homeshelves.js`).
- Notislarmens språk följer huvudadministratören; en inställning för larmens språk saknas (`server/notify.js` `adminLang`).
- Öppen GOP: skicka `mse=1` bara när webbläsaren avkodar i mjukvara (`mediaCapabilities.decodingInfo().powerEfficient`
  i `web/js/player/video.js`), så att Chrome med grafikkortsavkodning slipper omkodningen.
- Öppen GOP: åtta prov per fil missar ungefär var tionde fil med många felande nyckelbilder; ett ffmpeg-anrop med
  flera `-ss` skulle halvera provets kostnad (`server/opengop.js`). Chromecast (också MSE) är inte provad med öppen GOP.
- Musik: Subsonic-appar kunde dela kön med webben via `savePlayQueue`/`getPlayQueue` (`server/subsonic.js`,
  `server/musicqueue.js`).
- Musik: en bok eller podd återställs inte i minispelaren efter omladdning (`playSpoken` i `web/js/audio.js`).
- Musik: spolning i elementet efter att nästa buffert startat tappas tyst (`web/js/audio.js`).
- Musikfältets knappar är 34 px på telefon, under 44 px som rekommenderas för fingrar (`.mic` i `web/style.css`).
- Expo-appen: en ljudbok eller ett poddavsnitt visas inte i minispelaren efter omstart (bara musikkön återställs);
  boksidan har *Fortsätt från …* (`restoreQueue` i `apps/expo/src/music.ts`).
- Expo-appen: jämn ljudnivå (ReplayGain, fälten `gain`/`albumGain` finns i spåren), övertoning, sovtimer, låttexter,
  bokmärken, favoriter och spellistor går inte att ändra i appen än (`apps/expo/src/music.ts`, `screens/Music.tsx`).
- Expo-appen saknas i `test/contracts/apps.json`: testet känner bara `ios` och `android` (`APPS`, typnamnens slut,
  `TOK` per app i `test/api-contract.test.js`), så en tredje app kräver ändringar i testet.
- iOS- och Android-apparna sparar bildtoken bara i minnet och tar en ny vid varje start (`restore()` i
  `apps/apple/Shared/AppModel.swift`, `refreshImageToken` i `apps/automotive/.../Api.kt`) – samma knuff mot taket på
  50 som Expo-appen hade. Spara den som Expo-appen gör nu.
- Album för offline skapar en medietoken per spår vid varje anrop (`/api/music/albums/:aid/offline` i
  `server/routes/music.js`); ett album över 300 spår tappar de första spårens token. En token per album vore lättare.
- Takten på `/direct` för profiler med skärmtid är inte provad med riktiga appar (AVPlayer, ExoPlayer, Chromecast,
  AirPlay) och inte genom startcachen (`server/pace.js`).

**Från arbetspasset 2026-11-24 (sett men inte gjort)**
- Omkodningens start tar 0,7–0,9 s och är den långsammaste vägen (`transcodeStarts`, `encArgs` i `server/stream.js`).
- Rena tidsmätningar av start, spolning och kvalitetsbyte på en obelastad maskin (skriptet från passet mätte under last).
- Feedback: Feedback-knapp i apparna (iOS, Android, Expo); knappens plats under riktig uppspelning och på TV är inte provad.
- Serverns etiketter för spår och avsnitt utan titel (*Avsnitt N*) är svenska även på engelska.
- Cast-skriptet ger fyra konsolfel per sidladdning över vanlig http (CSP tillåter bara https).

**Uppspelning och stabilitet**
- `docs/jamforelse.md` är inaktuell: den säger att fjärråtkomst utan portöppning saknas (BraXhn Relay finns) och att
  apparna är pausade. Skriv om den efter läget i 1.2.2.
- Anpassningsbar kvalitet i Safari, AVPlayer, ExoPlayer och Chromecast är inte provad på riktigt – ta med i
  uppspelningsvakten där det går.
- Kvarlämnade mappar `*.gone-*` i omkodningsmappen efter avstängning (töms vid nästa start) – städa innan processen
  avslutas.
- Docker-imagen för arm64 byggs i GitHub Actions men är inte provad på en arm-maskin.

**Säkerhet och integritet**
- Skärmtiden kan fortfarande kringgås av den som hämtar hela originalfilen snabbt och tittar ur egen kopia. Överväg
  att begränsa hastigheten på `/direct` för profiler med skärmtid.
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

- 2026-11-26: Hemma via den publika adressen i Android-appen (telefon, Google TV, bil; punkt 6 för Android), gren
  `team/android-hemma-2026-11-26`. Samma regler som Expo-appen: `/api/local` från den sparade adressen, alla hemadresser
  provas samtidigt (800 ms, utan inloggning, utan omdirigeringar), används bara när `id` och `proof` stämmer exakt.
  Provet görs när servern öppnas, i förgrunden (högst var 30:e s) och när nätet byts; hemadressen slutar gälla när
  enhetens nät inte är det där den bekräftades. Nätverksfel → den sparade adressen och nytt försök (API, Media3 via en
  egen DataSource, Coil). http provas bara mot adresser i hemnätet. Inställningar visar *Hemma: direkt via …*.
  `app/src/test/…/LocalPickTest.kt` (10 fall, körda på JVM här; körs inte i workflowet). Inte provat: kompilering av hela
  appen (ingen Android SDK – `LocalPick.kt` och `Hemma.kt` kompilerade mot Media3 1.4.1, Coil 2.7.0 och Android 14:s
  klasser), riktig telefon, Google TV och bil, riktigt hemnät med relä.
- 2026-11-25: Hemma via den publika adressen (förut punkt 1, ärende #2), gren `team/hemma-2026-11-25`. Servern ger
  inloggade sina hemadresser och ett prov som bara besvaras på hemnätet (`/api/local*`, `server/localaddr.js`); Expo-appen
  går direkt till hemadressen när den svarar rätt, webben har *Mitt konto → Snabbare hemma* (byte till hemadressen med
  engångskod). `isTrusted` är oförändrad – samma publika IP räknas med flit inte som hemma (CGNAT, gästnät, VPN).
  `test/local-home.test.js`. Inte provat: riktigt hemnät med relä, riktig telefon, https-sida → http-hemadress i Chrome
  med *Alltid säkra anslutningar*. Kvar: iOS/tvOS och Android (punkt 6).
- 2026-11-25: Öppen GOP – spolning inom bufferten utan avkodningsfel i Chrome. Orsaken: Chrome avkodar om från
  nyckelbilden före målet, och bilderna som hänvisar till GOP:en innan var bara borttagna i segment hämtade med `ra=`.
  Spelaren tömmer nu bufferten från segmentet innan webbläsaren spolar (`guardSeeks` i `video.js`), och filer som måste
  omkodas mitt i (`tc`) byter direkt. Vakten: 0 fel (förut fel vid varje spolning 8 s framåt), raden i `KANDA` borttagen.
  Inte provat: Chrome med grafikkortsavkodning, Firefox.
- 2026-11-25: Kön i reläets tunnel (`server/tunnelq.js`, ärende #2): små svar väntade 2–6 s bakom en film, ljudbok eller
  hastighetsprovet (4 MB per ström i en enda TCP-anslutning). Nu ~0,2 s kö; bara servern ändrad, reläet behöver inte
  byggas om. Mätt med strypt tunnel på loopback, inte på en riktig VPS.
- 2026-11-25: Sovtimer i videospelaren (15/30/45/60 min eller *När avsnittet tar slut*, nedtoning, paus som sparar
  positionen, följer med till nästa avsnitt, fjärrkontroll) och skärmtiden i webbspelaren (*X min kvar idag*, varning de
  sista fem minuterna). Paus räknades som skärmtid: vid direktuppspelning upp till 20 s per paus (Chrome: 6 s
  uppspelning + 60 s paus = 20 s räknat, nu 7 s; `streamMeter`), och en paus under 45 s helt när filmen startade igen
  (rapport vid start, `heartbeat`). Pilarna i dialoger från spelaren fungerar (`router.js`). Inte gjort: Safari och
  apparna (se *Näst på tur* 5).
- 2026-11-25: Uppspelningsvakt i riktig Chrome (`npm run vakt`, `test/vakt.mjs`) – sex filer × elva fall (start, Fortsätt
  titta, paus, spolning inom och utanför bufferten, kvalitet, ljud, undertext) med tid till bild, avkodningsfel och
  tappade bildrutor; körs före varje stabil utgåva och stoppar den vid fel. Siffrorna i `docs/testat.md`.
- 2026-11-25: Feedback – notis till administratören när något väntar (utan text och namn, högst en i timmen),
  *Öppna igen* för avslutade ärenden, gallring efter 180 dagar; API-nycklar går att ändra.
- 2026-11-25: Engelska i serverns texter – felmeddelanden, skärmtid,
  åldersgräns, nedladdning, startsidans hyllnamn, *Avsnitt N*, spårens och versionernas namn, notiserna och
  offlinesidan följer profilens språk (annars kakan/`Accept-Language`) med webbens katalog (`server/i18n.js`,
  `test/server-i18n.test.js`).
- 2026-11-25: Expo-appen – musik, ljudböcker och poddar: fliken *Musik* (översikt, album, artister, spellistor,
  sökning, ljudböcker, poddar), albumsida, minispelare och helskärmsspelare med `expo-audio`; kön delas med webben via
  `/api/me/queue` och visas pausad efter omstart; ljudböcker och avsnitt fortsätter där man slutade. Visat i
  webbläget (Chrome 390×844); bakgrundsljud och låsskärm inte provade på riktig telefon (punkt 4).
- 2026-11-25: Expo-appen – *Vem tittar?* efter inloggningen och *Byt profil* under
  Konto, med PIN och huvudkontots lösenord som i webben; barnprofiler ser bara det de får se. Bildtoken sparas per
  server och profil och förnyas bara när den snart går ut eller servern svarar 401.
- 2026-11-25: Småfel – tak för medietoken, vitlista för biblioteksvar (inga sökvägar till andra än administratörer),
  lokal dag i inbjudan och diagnostik, kvalitetsetiketter efter språket, Original går att välja igen efter ett byte
  till omkodning, musikens tid efter en omkodad låt som spolats, testerna tömmer musikkön.
- 2026-11-25: Android-appen på engelska och svenska efter telefonens språk – texterna i
  `res/values/strings.xml` (engelska, standard) och `res/values-sv/strings.xml`, ordval som webben;
  `test/android-i18n.test.js` hindrar svensk text i Kotlin-koden. Bygget i GitHub Actions går igenom; inte provad på riktig telefon, TV eller bil.
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
- **Prova Snabbare hemma** hemma med reläets adress: *Mitt konto → Öppna hemadressen* i webben, och Expo-appen (Konto
  visar *Hemma: direkt via …*). Står det ingen hemadress: öppna servern en gång på dess IP-adress eller ange den under
  *Administration → Hemadressen*.
- **Prova återupptagning på iPhone** (Safari, version 1.2.2): börja på en film, stäng, öppna igen – fortsätter den på
  rätt ställe direkt?
- **Prova hack i Chrome på version 1.2.2** med de filer som frös förut.
- **Kör hårdvaruprovet med NVENC** på Unraid-servern och skicka resultatet (se punkt 3).
- Det som i övrigt kräver riktig hårdvara eller konton står i *Testat och otestat* i README: Chromecast och AirPlay,
  Google TV-appen på en TV, Android Auto, Let's Encrypt med en publik domän, BraXhn Relay på en riktig VPS, riktiga
  IPTV-leverantörer och passkeys på telefon.
- **CarPlay:** ansök om tillståndet hos Apple om det ska byggas.
