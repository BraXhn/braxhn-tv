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

Senast genomgången: 2026-11-28 (version 1.5.0 och det som står under *Ej utgiven* i CHANGELOG).

## Pågår

*(inget just nu)*

## Näst på tur

### 1. Appen för iPhone, iPad och Apple TV mäter uppkopplingen utanför hemmet och skickar `bw`

- **Gjort:** iOS/tvOS-appen (2026-11-28, gren `team/apple-bw-2026-11-28`, se *Klart*). Kvar: Android och Expo, och
  provet med `tc` nedan.
- **Vad:** Android-, iOS/tvOS- och Expo-appen mäter inte uppkopplingen och skickar inte `bw` till `/playback` (sökt
  i `apps/`: inget `bw` i frågan och inget anrop till `/api/speedtest`; Windows-appen skickar `buf=1` och behöver det
  inte). Servern använder `bw` för att välja startsteget (`fitQ` via `remoteQuality`) och för att koda om en remux
- **Gjort för Android och Expo** (gren `team/app-bw-2026-11-28`): `BwCore.kt`/`Bandwidth.kt` och `src/bwcore.ts`,
  testade på JVM och i `test/expo-bw.test.js` (också mot en lokal server strypt till 2, 5 och 20 Mbit/s), kontraktet
  har `bw` och `GET /api/speedtest` för `android`. Kvar: iOS/tvOS (`ios` i kontraktet), och att prova på riktig
  enhet via reläet hur lång tid mätningen tar där.
- **Vad:** iOS/tvOS-appen mäter inte uppkopplingen och skickar inte `bw` till `/playback` (Windows-appen skickar
  `buf=1` och behöver det inte). Servern använder `bw` för att välja startsteget (`fitQ` via `remoteQuality`) och för att koda om en remux
  eller direktuppspelning som inte ryms i nätet (`o.force = 'transcode'` i `server/routes/playback.js`). Utan `bw`
  börjar en omkodning på taket (1080p ≈ 8 Mbit/s i `QUALITIES`), och en fil upp till ungefär 10 Mbit/s remuxas – utan
  lägre steg att växla till på ett svagt mobilnät. Mät som webben (`sample()` i
  `web/js/player/caps.js`: 4 MB från `/api/speedtest`, högst 1 s, takten efter första tredjedelen) – bara utanför
  hemmet, och spara mätningen några minuter.
- **Varför:** på mobilnät och via reläet är det här skillnaden mellan att filmen börjar direkt och att den hackar de
  första minuterna eller aldrig kommer igång. Webbspelaren skickar redan `bw` (`web/js/player/nativeplan.js`).
- **Filer:** `apps/apple/Shared/AppModel.swift` (`capabilities`), `Start.swift`, `StartCore.swift`,
  `test/contracts/apps.json`. Samma regler som `BwCore.kt` (samma bw i förvärmningen och uppspelningen, ingen
  förvärmning utan färsk mätning).
- **Klart när:** kontraktet har `bw` i `/playback` för `ios` (Android och Expo klart), och en fil på 8 Mbit/s som annars remuxas startar som omkodning mot en server begränsad
  till 5 Mbit/s (`tc` lokalt). Kontrollera först hur lång tid mätningen tar via reläet – den får inte göra starten långsammare
  (kan göras samtidigt med förvärmningen).

### 2. Skärmtiden räknar inte musik och inte färdiga inspelningar i apparna (riktigt fel)

- **Vad:** dialogen för skärmtid lovar *Gäller även ljud (musik, ljudböcker och poddar)* (`screenDialog` i
  `web/js/screentime.js`), men lyssnad musik räknas aldrig: `heartbeat` anropas bara för böcker och poddar
  (`server/routes/books.js`), live- och inspelningssegment (`server/routes/livetv.js`), titlarnas strömmar
  (`countStream` i `server/http/context.js`, bara `/direct` och HLS för titlar) och `/api/screentime/ping`. Låtarnas
  `/api/music/tracks/:tid/stream` och `/play` nekar bara när tiden redan är slut (`screenBlock`), och varken
  `web/js/audio.js`, Expo- eller Android-appen rapporterar musik. Samma sak för färdiga inspelningar i iOS- och
  Android-appen: `/api/dvr/recordings/:rid/stream` räknar inget på servern, och bara webben skickar `screentime/ping`
  (`screenPing` i `web/js/player/live.js`) – apparna (`Live.swift`, `Live.kt`) gör det inte. Dessutom skickar
  webbens musikvideor nyckeln `mv:<id>`, som `/api/screentime/ping` inte godtar (`/^[a-z]:\d{1,12}$/` i
  `server/routes/social.js`) – alla musikvideor räknas som samma ström `x:0`, så tiden mellan två videor räknas.
- **Varför:** ett barn med skärmtid för ljud kan lyssna på musik hela dagen, och ett barn med skärmtid kan se färdiga
  inspelningar i appen utan att tiden går. Föräldern tror att gränsen gäller. En hel låt hämtas på några sekunder, så
  `countStream` (räknar medan data skickas) räcker inte för musik.
- **Filer:** `server/routes/music.js`, `server/routes/social.js` (`/api/screentime/ping`: ta emot `audio` och fler
  nyckeltyper), `server/routes/livetv.js` (`/stream` för inspelningar, som `/direct` med `countStream` och takt),
  `web/js/audio.js`, `web/js/player/musicvideo.js`, `apps/expo/src/music.ts`,
  `apps/automotive/.../MusicService.kt`, `test/screentime-*.test.js`.
- **Klart när:** ett test visar att tio minuters musik i webben ger ungefär tio minuter skärmtid för en profil med
  `audio: true` och noll utan, att en färdig inspelning som hämtas med `/stream` räknas utan `ping`, och att två
  musikvideor efter varandra räknas som två strömmar. Kontrollera först om apparnas musik ska rapportera positionen
  (som böckerna) eller om servern kan räkna låtarna själv.

### 3. Fortsätt titta på iPhone: mät startpositionen med Apples spelare

- **Vad:** lägg till ett fall med startposition (`start=` och `EXT-X-START`) i `test/media/AVPlayerCheck.swift` och
  `test/media/apple-check.mjs`, som redan körs på macOS i `conformance.yml`. I dag provar de inte startposition.
- **Varför:** rättningen för iPhone och iPad (1.2.1) och Apple TV (*Ej utgiven*) är inte provad med Apples spelare.
  Att filmen fortsätter där man slutade är grundläggande på telefon och surfplatta.
- **Filer:** `test/media/AVPlayerCheck.swift`, `test/media/apple-check.mjs`, `.github/workflows/conformance.yml`,
  `server/stream.js` (bara om mätningen visar fel).
- **Klart när:** körningen på macOS visar att uppspelningen börjar inom två sekunder från begärd position utan att
  segment 0 hämtas först.

### 4. Ljudböcker och poddar för nedladdning i Android- och iOS/tvOS-appen, med skärmtid utan nät

- **Vad:** bara filmer och avsnitt kan laddas ner i Android- och iOS-appen (`Offline.kt`, `Offline.swift`; inget i
  `Listen.swift` eller `MusicService.kt`). Expo-appen har nedladdade böcker. När det byggs: räkna skärmtid utan nät för
  ljud (`audio = true` i posterna till `POST /api/screentime/offline`). Kontrollera först efter att grenarna
  `team/android-ljud-2026-11-28` och `team/apple-skarmtid-2026-11-28` är ihopslagna: i dag räknar Android bara video
  (`OfflineSync.playedOffline` anropas bara från `PlayerScreen.kt`) och iOS skickar `audio` som false.
- **Varför:** ljudböcker i bilen och på resor är en av de vanligaste användningarna utan nät; Audiobookshelf och Plexamp
  har det. Med en profil där ljud räknas som skärmtid får tiden inte försvinna.
- **Filer:** `apps/automotive/.../Offline.kt`, `MusicService.kt`, `OfflineSync.kt`, `apps/apple/Shared/Offline.swift`,
  `Listen.swift`, `OfflineCore.swift`, `test/contracts/apps.json`.
- **Klart när:** en bok och ett poddavsnitt går att ladda ner och spela utan nät i båda apparna, enhetstesterna
  (`OfflineCoreTest.kt`, `test/apple-offline.test.js`) har en post med `audio: true` från en nedladdad bok, och bygget i
  GitHub Actions går igenom.

### 5. iOS-appen hoppar inte över intro, sammanfattning och eftertexter av sig själv (`autoSkip`)

- **Vad:** webben, Expo-appen (`apps/expo/src/skipcore.ts`) och Android-appen (`SkipCore.kt`) följer kontots val
  `autoSkip` i `/playback` och trycker på knappen själva efter en kort nedräkning. iOS/tvOS-appen visar bara knappen
  (`skipTitle` i `apps/apple/Shared/Player.swift`, rad ~556) och avkodar inte `autoSkip` (bara `autoNext` i
  `Models.swift`).
- **Varför:** barnserier med samma intro i varje avsnitt är vardag; på iPaden och Apple TV:n måste någon trycka varje
  gång, fast valet är påslaget i kontot. Plex och Netflix hoppar själva.
- **Filer:** `apps/apple/Shared/Player.swift`, `Models.swift`, en `SkipCore.swift` med samma regler som
  `web/js/player/autoskip.js`, `test/apple-next.test.js` eller ett nytt test, `test/contracts/apps.json` (`autoSkip`
  för `ios`).
- **Klart när:** kontraktet har `autoSkip` för `ios`, ett test visar samma plan som webben för intro, sammanfattning och
  eftertexter (även att en del som redan hoppats över inte hoppas igen efter spolning bakåt), och bygget i GitHub
  Actions går igenom.

### 6. Expo-appen: ljudboken och poddavsnittet försvinner ur minispelaren efter omstart och ur webben (riktigt fel)

- **Vad:** `restoreQueue` i `apps/expo/src/music.ts` läser bara `tracks` ur `/api/me/queue` och struntar i `spoken`,
  som servern nu skickar med profilens position (`spokenOf` i `server/musicqueue.js`). Värre: när en bok eller ett
  avsnitt startar i appen tar `leaveMusic` bort kön (`DELETE /api/me/queue`) utan att spara `spoken` (webben gör
  `PUT` med `spoken`, `spokenQueue` i `web/js/audio.js`). Efter en bok i telefonen visar alltså varken appen efter
  omstart eller webben boken i minispelaren.
- **Varför:** ljudböcker lyssnas i omgångar – i bilen, vid läggdags, på en annan enhet. Webben har det redan (*Boken
  står kvar pausad … på en annan enhet*, `docs/funktioner.md`), och Audiobookshelf gör likadant.
- **Filer:** `apps/expo/src/music.ts` (`restoreQueue`, `playBook`, poddens start, `leaveMusic`), `test/expo-*.test.js`
  (ny fil eller `expo-offline.test.js` med låtsasmodulerna i `test/helpers/expo-loader.mjs`).
- **Klart när:** ett test visar att en bok som spelats i appen ger `PUT /api/me/queue` med `spoken`, och att
  `restoreQueue` med `spoken` i svaret visar boken pausad på positionen utan att ladda ljud (som `restoreSpoken` i
  webben); en nedladdad bok spelas från telefonen även då.

### 7. Stängd spelare vid direktuppspelning stoppar samma titel på profilens andra enheter (riktigt fel)

- **Vad:** `closePlayer` i `web/js/player/video.js` skickar `POST /api/stream/:id/stop` med `pid` bara när
  strömlänken har ett. Vid direktuppspelning är länken `/api/stream/:id/direct` utan `pid` (`server/routes/playback.js`
  rad ~233), och stoppet utan `pid` stoppar alla profilens sessioner av titeln (`stopUserSessions`), markerar
  `clientStop` och `screen.stopped`. Samma sak i `pagehide`, som då inte skickar något alls (kräver `pid`).
- **Varför:** två barn på samma profil som ser samma film på varsin enhet, eller en film som spelas på TV:n medan
  telefonen stänger sin – den andra strömmen bryts. Kontrollera först hur ofta en direktuppspelning har en omkodad
  syskonsession (förvärmning, Chromecast) som träffas.
- **Filer:** `server/routes/playback.js` (ge `/direct` ett `pid` som de andra lägena), `web/js/player/video.js`
  (`closePlayer`, `pagehide`), `test/` (stoppets test för `pid`).
- **Klart när:** ett test visar att stängd direktuppspelning i en webbläsare inte stoppar profilens HLS-session av samma
  titel på en annan enhet, och att stoppet skickas med `keepalive` även från `closePlayer` när sidan lämnas.

### 8. Kortet *Nästa avsnitt* i apparna visar vad som kommer (`nextEpisode`)

- **Vad:** `/api/items/:id` har nu `nextEpisode` (`{ id, title, season, episode, image }`, `server/routes/library.js`)
  och webbens kort visar bild, S1 · A2 och namnet (`nextCard` i `web/js/player/video.js`). Android-appens kort visar
  bara rubriken och seriens namn (`endCard` i `PlayerScreen.kt`), iOS bara rubriken (`Player.swift`, kortet ~rad 966)
  och Expo-appen bara rubriken (`Player.tsx`, `endCard`).
- **Varför:** man ser direkt om nästa avsnitt är det man vill se, eller om det är dags att stänga – som Plex och
  Netflix. Mest nytta på TV:n där kortet syns stort.
- **Filer:** `apps/automotive/.../Api.kt` (`ItemDetail`), `PlayerScreen.kt`, `apps/apple/Shared/Models.swift`,
  `Player.swift`, `apps/expo/src/screens/Player.tsx`, `test/contracts/apps.json` (`nextEpisode` som valfritt fält).
- **Klart när:** kontraktet har `nextEpisode` för `android` och `ios`, korten visar namn, nummer och bild när fältet
  finns och bara rubriken som i dag när det saknas (äldre server, nedladdad titel), och bygget i GitHub Actions går
  igenom.

### 9. Skärmtiden kan räknas lågt av en egen klient (kontrollera först)

- **Vad:** två sätt att få `heartbeat` (`server/screentime.js`) att räkna nästan inget, båda lästa i koden men inte
  uppmätta med en riktig klient: (1) en klient som rapporterar att positionen står still strax efter varje HLS-segment
  (inom `PAUSE_SLACK` 5 s, före nästa) får pausregeln att börja om klockan (`b.t = at`) varje gång; (2) en klient som
  hämtar mer än `CAP` (45 s) segment åt gången och sedan väntar får glappet att räknas som paus. Webbspelaren gör inget
  av det. `/direct` har redan takt (`server/pace.js`), HLS inte.
- **Varför:** skärmtiden är det som skiljer BraXhn TV från Plex och Jellyfin för en barnfamilj; den ska inte gå att
  komma runt med en enkel nedladdare. Risken är liten (kräver en egen klient), därför längre ner.
- **Filer:** `server/screentime.js` (`heartbeat`), `server/http/context.js` (`countStream`), `server/pace.js`,
  `server/stream.js`, `test/screentime-*.test.js`.
- **Klart när:** ett test som hämtar segment i förväg och skickar "står still" efter varje segment får minst så mycket
  skärmtid som innehållet det hämtat (räknat per segmentets längd för HLS, som takten för `/direct`), och
  webbspelarens vanliga paus räknas fortfarande inte (`test/web-chrome-playback.test.js` eller skärmtidens test).

### 10. Uppspelningstestet i Chrome blir ostadigt under last (kontrollera först)

- **Vad:** `test/web-chrome-playback.test.js` (samma mätning som uppspelningsvakten, `installProbes()` i
  `test/helpers/chrome.js`) har enligt dagens agenter fallit ibland när flera ffmpeg-jobb körs samtidigt på maskinen.
  Kontrollera först: kör testet tio gånger med och utan en annan omkodning i bakgrunden och notera vilket fall som
  faller och varför (tidsgräns eller verkligt fel). Rätta sedan väntan i testet (vänta på händelser, inte fasta tider)
  eller felet i spelaren om det är ett riktigt fel.
- **Varför:** testet skyddar uppspelningen i webben före varje utgåva. Ett test som faller utan orsak gör att riktiga
  fel ses som brus.
- **Filer:** `test/web-chrome-playback.test.js`, `test/helpers/chrome.js`, `test/vakt.mjs` (samma prober).
- **Klart när:** tio körningar i rad under last går igenom, eller felet som syns under last är rättat i spelaren.

## Idéer

Kortare rader, inte rangordnade. Flytta upp en punkt när den blir aktuell.

**Från genomgången 2026-11-28 (backlogg, sett i koden men inte gjort)**
- Live-TV: `/api/live/programs/:pid` listar kommande sändningar av samma titel (`airings`) och regeln från alla
  kanaler, även kanaler som barnprofilen inte får se (`server/routes/livetv.js`). Bara titel, kanalnamn och tid – filtrera
  med `channelAllowed` som guiden.
- Feedback-knappen ligger enligt dagens agenter bakom minispelaren på telefon (kontrollera först: `#fbbox` flyttas
  upp med `hasbar`/`hasmini` i `web/style.css`, men inte provat med flikraden, radiobaren och musikfältet samtidigt i 390 px).

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
- Expo-appen: jämn ljudnivå (ReplayGain, fälten `gain`/`albumGain` finns i spåren), övertoning, sovtimer, låttexter,
  bokmärken, favoriter och spellistor går inte att ändra i appen än (`apps/expo/src/music.ts`, `screens/Music.tsx`).
- Expo-appen saknas i `test/contracts/apps.json`: testet känner bara `ios` och `android` (`APPS`, typnamnens slut,
  `TOK` per app i `test/api-contract.test.js`), så en tredje app kräver ändringar i testet.
- Album för offline skapar en medietoken per spår vid varje anrop (`/api/music/albums/:aid/offline` i
  `server/routes/music.js`); ett album över 300 spår tappar de första spårens token. En token per album vore lättare.
- Takten på `/direct` för profiler med skärmtid är inte provad med riktiga appar (AVPlayer, ExoPlayer, Chromecast,
  AirPlay) och inte genom startcachen (`server/pace.js`).

**Från arbetspasset 2026-11-27 (sett men inte gjort)**
- Fortsätt titta mitt i en fil med lång GOP: omkodningen börjar på en jämn sekund och ffmpeg avkodar från nyckelbilden
  före (upp till en hel GOP, ~0,1 s per sekund HEVC 1080p). Att lägga B på nyckelbilden före `hs` när nyckelbilderna är
  kända sparar det – kontrollera först med en riktig film (testfilerna har 2 s GOP).
- Expo-appen frågar `/hls/ready` var 4:e sekund medan strömmen spelar och använder svaret i 8 s. En fråga som skickas
  strax före en spolning kan i sällsynta fall komma fram till servern efter spelarens begäran av målets segment (olika
  anslutningar) och då säga "kodas" – då väntar appen på 6 s-segmentet i stället för att starta om
  (`apps/expo/src/seekcore.ts` `readyFor`). Inte mätt på riktig telefon.
- Expo-appens webbläge spolar utan omstart: Chromes HLS-spelare hämtar segment 0 och 1 i varje ny ström innan den går
  till målet (bryr sig inte om `EXT-X-START` eller `#t=`), och servern startar då om ffmpeg vid 0. Med hls.js i
  webbläget gick det att göra som webbspelaren (`apps/expo/src/screens/Player.tsx`).

**Från genomgången 2026-11-27 (backlogg, sett i koden men inte gjort)**
- Expo-appen hämtar hela serien (`/api/items/<serie>` med alla avsnitt) för att hitta nästa avsnitt, vid varje start
  (och för nedladdade avsnitt när nästa inte är nedladdat; `apps/expo/src/screens/Player.tsx`). Svaret från
  `/api/items/:id` har redan `nextId` (`server/routes/library.js`) – ett anrop mindre och mindre data på mobilnät.
- Webbspelarens kort i slutet säger bara *Nästa avsnitt om N s* (`onEnded` i `web/js/player/video.js`), utan
  avsnittets namn, nummer eller bild. Plex och Netflix visar vad som kommer, så att man kan välja att stanna.
- Expo-appen: nästa och föregående låt på låsskärmen och i hörlurarna saknas – låsskärmen har bara spola ±10 s för musik
  (`setActiveForLockScreen` i `apps/expo/src/music.ts`). `expo-audio` ger knapparna bara för `AudioPlaylist`
  (kontrollera först i paketets version), så kön behöver matas in där. Förut punkt 2 i *Näst på tur*; provet med låst
  skärm på riktig telefon står under *Bara Anton kan göra*.
- Medietoken räknas per användare och de äldsta utöver 300 tas bort (`MEDIA_MAX` i `server/auth.js`); varje låt i Expo-
  och Android-appen tar en ny (`/api/music/tracks/:tid/play`). En profil som lyssnar på många låtar samma dygn kan
  knuffa ut en films token på en annan enhet, och strömmen svarar då 401 – kontrollera först hur många låtar som
  behövs i praktiken och om spelarna hämtar en ny adress av sig själva.
- Ljudböcker och poddar kan inte laddas ner i Android- eller iOS/tvOS-appen (bara filmer och avsnitt:
  `Offline.kt`, `Offline.swift`; inget i `Listen.swift`), bara i Expo-appen. Audiobookshelf och Plexamp har det.
- Låttexter finns i webben men inte i någon av apparna (inget om låttext i `apps/`); Plexamp visar synkade texter.

**Från arbetspasset 2026-11-24 (sett men inte gjort)**
- Rena tidsmätningar av start, spolning och kvalitetsbyte på en obelastad maskin (skriptet från passet mätte under last).
- Serverns etiketter för spår och avsnitt utan titel (*Avsnitt N*) är svenska även på engelska.
- Cast-skriptet ger fyra konsolfel per sidladdning över vanlig http (CSP tillåter bara https).

**Uppspelning och stabilitet**
- Anpassningsbar kvalitet i Safari, AVPlayer, ExoPlayer och Chromecast är inte provad på riktigt – ta med i
  uppspelningsvakten där det går.
- Kvarlämnade mappar `*.gone-*` i omkodningsmappen efter avstängning (töms vid nästa start) – städa innan processen
  avslutas.

**Säkerhet och integritet**
- Skärmtiden kan fortfarande kringgås av den som hämtar hela originalfilen snabbt och tittar ur egen kopia. Överväg
  att begränsa hastigheten på `/direct` för profiler med skärmtid.
- Reläets admin: spärren mot felaktiga token hindrar inte nya försök (rätt token släpps igenom även när spärren
  slagit till). Token är minst 16 tecken, så risken är liten.
- Enkel inloggning (OIDC) saknar knapp i apparna.

**Det som saknas jämfört med andra**
- Egna appar för Samsung- och LG-TV, Roku och Fire TV (Plex, Jellyfin och Emby har dem). I dag: webbläsaren och DLNA.
- Automatiska undertexter med tal till text. Går inte utan en modell – strider mot "inga beroenden".
- Röststyrning (Alexa, Google Assistant). Webhooks och API-nycklar finns för Home Assistant.
- Ansiktsigenkänning i foton (Plex har det). Låg nytta här.
- Skicka e-bok till läsplatta med e-post (Audiobookshelf har det). Inget sådant hittat i `server/` eller `web/js/`
  (sökt på kindle, send-to och e-post för e-böcker).
- Expo-appen: live-TV och TV-guide.
- Expo-appen: `NSLocalNetworkUsageDescription` i `app.json` är bara på svenska; iOS visar den när appen ber om hemnätet.
  Ett eget bygge kan få en engelsk variant med `locales` i `app.json` (gäller inte Expo Go).
- Expo-appen: Nedladdat sparar serie/säsong (`sub`) och felmeddelanden som text när posten skapas (`offlinecore.ts`
  `videoEntry`, `offline.ts` `friendly`) – byts språket står de kvar på det gamla. Spara delarna och skriv texten vid
  visning.

- Stopp av en uppspelning (`/stop`) avslutar aktiviteten och markerar skärmtidens ström per profil och titel
  (`act.clientStop`, `screen.stopped` i `server/routes/playback.js`), inte per enhet: stänger en enhet sin film medan
  en annan med samma profil ser samma titel räknas den andras nästa livstecken inte i skärmtiden, och aktiviteten
  avslutas om inga framsteg kommer under väntetiden. Kontrollera först om det märks; nyckla i så fall per `pid`.

## Klart

Nyast först, grupperat efter utgåva. Detaljerna står i [CHANGELOG.md](../CHANGELOG.md).

### Ej utgiven

- 2026-11-28: Stängd direktuppspelning stoppade samma titel på profilens andra enheter (punkt 7 i
  `team/backlogg3-2026-11-28`), gren `team/direct-pid-2026-11-28`. `/playback` ger `/direct` ett eget `pid`
  (`…/direct?pid=` eller `?t=…&pid=`), så webbens `closePlayer` (nu med `keepalive`) och `pagehide` stoppar bara den
  egna uppspelningen; Windows-appens `finish` (`native.js`) skickar också `pid`. Vid överlämning till Chromecast
  skickar `closePlayer` `replaced=1` (uppspelningen fortsätter där; förut ett vanligt stopp för HLS och inget för
  direkt). Stopp utan `pid` (apparna) hoppar
  över en HLS-session som en annan adress hämtat segment från de senaste 60 s (`stopUserSessions`, `s.ip` i
  `serveSegment`); admin, förälder och skärmtid stoppar allt som förut. `test/direct-pid.test.js` (föll i 4 av 5 fall
  före): direkt + HLS med samma profil, appstopp från annan och samma adress, Chrome (`pid`, `keepalive`, `pagehide`).
  Kvar: `act.clientStop`/`screen.stopped` gäller profil + titel, inte enhet (se Idéer).

- 2026-11-28: Expo-appen minns ljudboken och poddavsnittet i kön (backloggens punkt 6 i `team/backlogg3-2026-11-28`),
  gren `team/expo-spoken-2026-11-28`. `apps/expo/src/music.ts`: en bok eller ett avsnitt som startar ger
  `PUT /api/me/queue` med `spoken` (`spokenQueue`, efter en musikkö som är på väg) i stället för `DELETE`;
  `restoreQueue` med `spoken` visar titeln pausad (`restoreSpoken`, positionen under 30 s före slutet ger 0 som
  webben) utan `/play`, ljudfil eller `/progress` förrän Spela; hopp flyttar bara platsen; ✕ tar bort kön.
  `test/expo-spoken.test.js` (9 fall, `music.ts` med låtsad `expo-audio`): 7 faller på `main`, alla går igenom nu.
  Webbläget med Playwright mot en egen server (390×844, Chrome): bok vid 154 s → omladdning visar den pausad på 154 s,
  inga ström-, `/play`- eller `/progress`-anrop på 20 s, 15 s bakåt ger 139 s, Spela fortsätter därifrån; webbappens
  minispelare visar boken. **Inte provat:** riktig telefon (Expo Go), låsskärmen, nedladdad bok utanför Node-testet.
- 2026-11-28: iOS/tvOS-appen mäter uppkopplingen utanför hemmet och skickar `bw` (punkt 1, Android och Expo kvar),
  gren `team/apple-bw-2026-11-28`. `BwCore.swift` (bara Foundation, statiskt test `test/apple-bw.test.js`): utanför
  hemmet = `remote` i `/api/status` och inte via hemadressen; provet som webbens `sample()` (4 MB, högst 1 s, takten
  efter första tredjedelen) i bakgrunden när appen öppnas, kommer tillbaka och när nätet byts, aldrig medan starten
  väntar; AVPlayers `observedBitrate` ersätter provet; en mätning gäller 10 minuter och bara på samma nät och server.
  Förvärmningen och uppspelningen skickar samma `bw` (förvärmningens värde i 20 s, även inget – appen förvärmer
  också utan mätning, till skillnad från webben). Kontraktet har `bw` i `/playback` och `warm=1` för `ios` och `GET /api/speedtest`. Inte byggt här
  (Swift kompileras i GitHub Actions), inte provat på enhet, via reläet eller med `tc`.
- 2026-11-28: Android- och Expo-appen mäter uppkopplingen utanför hemmet och skickar `bw` (punkt 1, iOS kvar), gren
  `team/app-bw-2026-11-28`.
- 2026-11-28: Android-appen följer *Spela nästa avsnitt automatiskt* (punkt 1, iOS kvar), gren
  `team/android-nasta-2026-11-28`. `SkipCore.kt` (JVM-test `SkipCoreTest.kt`, samma fall som `test/expo-skip.test.js`):
  knapparna och nedräkningen för sammanfattning, intro och eftertexter (`autoSkip`), `next` som webbens `nextPlan` och
  `atEnd` (på = kortet med nedräkning, 0 s = direkt; av = kortet utan nedräkning; inget nästa = stäng; i bilen inget
  kort, av = stäng). Nästa avsnitt förvärms när
  eftertexterna börjar och under kortet (`Start.warm`, samma fråga som uppspelningen). `autoSkip`/`autoNext` i
  kontraktet. Inte byggt lokalt (ingen Android SDK) och inte provat på riktig enhet.
- 2026-11-28: iOS/tvOS-appen följer *Spela nästa avsnitt automatiskt* (iOS-delen av punkt 1), gren
  `team/apple-nasta-2026-11-28`. Fel: `ended()` i `Player.swift` startade alltid nästa avsnitt och läste inte
  `autoNext`. Nu `NextCore.swift` (bara Foundation): `plan` = webbens `nextPlan` (0–60 s, decimaler kapas, 8 s utan
  `autoNext`; `countdown` som heltal, decimaltal eller text), `end` som Android-appens `SkipCore.atEnd`: inget nästa
  avsnitt → spelaren stängs, på och 0 s → direkt, på → kortet *Nästa avsnitt om N s* med *Spela nu*/*Avbryt*, av eller
  okänt (nedladdad titel utan `/playback`) → kortet *Nästa avsnitt* utan nedräkning med *Spela nu*/*Stäng*
  (`NextCard`; Apple TV: fokus på *Spela nu*, `onExitCommand` = Avbryt/Stäng, spelarvyn tas bort medan kortet syns). Förvärmning med `Start.warm(…, start: 0)` när
  eftertexterna börjar och varje sekund i nedräkningen (samma fråga som `load(…, cinema: true)`). Knapparna för
  sammanfattning och eftertexter fanns redan. `test/apple-next.test.js` (6 fall; fallet för `ended()` faller på main),
  `autoNext` i `Playback.ios` i kontraktet. **Inte provat:** kompilering (bara i `apple.yml`) och riktig enhet.
- 2026-11-28: iOS/tvOS-appen visar skärmtiden kvar och varningen (iOS-delen av punkt 4), samma gren.
  `ScreenLeftCore.swift` (bara Foundation) = webbens `playerLeft` och Android-appens `ScreenLeftCore.kt`: `left` ur
  framstegssvaret (`remaining` från en äldre server), utan nät `ScreenClock.gate`; *12 min kvar idag* (*⏱ 12 min kvar*
  på en smal skärm) i iPhone/iPads överkant, på Apple TV när filmen är pausad; *Skärmtiden tar slut om N min* de sista
  fem minuterna; VoiceOver-uppläsning (`UIAccessibility.post(.announcement)`) när varningen syns och när minuten ändras.
  `reportProgress` ger spelaren `screenTime` (`onScreen`, även på Apple TV), `ScreenStatus` tar emot `allowed` och
  `left`. `test/apple-screenleft.test.js` (6 fall, webbens `playerLeft` jämförd var 7:e sekund upp till ett dygn),
  `left` i `ScreenStatus.ios` i kontraktet. **Inte provat:** kompilering, riktig enhet, VoiceOver och mätningen i Safari.
- 2026-11-28: Webbspelaren: kortet i slutet visar vilket avsnitt som kommer (förut punkt 6), gren
  `team/webb-mini-2026-11-28`. `/api/items/:id` har `nextEpisode` (`{ id, title, season, episode, image }`; bilden är
  stillbilden, annars seriens bakgrund eller affisch) och `nextCard` i `video.js` ritar bild, *S1 · A2* och namnet.
  *Spela nu* får fokus (pilarna går till *Avbryt*, Enter startar), kortet går kant i kant med 12 px marginal under
  500 px. `test/web-next-card.test.js` i Chrome (1280×800 och 390×844): 3 fall, alla föll före ändringen. Kortet kommer
  fortfarande först när avsnittet är slut, inte redan vid eftertexterna.
- 2026-11-28: Ljudbok eller poddavsnitt finns kvar i minispelaren efter omladdning (förut punkt 5), samma gren.
  `PUT /api/me/queue` med `spoken: { kind, id }` (kolumnen `music_queue.spoken`), `GET` svarar med profilens position
  ur framstegen. Webben visar boken pausad (`restoreSpoken`, `M.resume` + `M.spoken`): ingen fil laddas och inget
  framsteg skickas (skärmtid, lyssnad tid) förrän Spela; hopp flyttar bara platsen. `test/web-spoken-queue.test.js`:
  API (rätt position per profil, inte för en annan, inga poddar för barn, felaktiga värden) och Chrome (omladdning,
  inga anrop före Spela, fortsätter där, ✕ tar bort); de tre fallen föll före ändringen. Expo-appen tar fortfarande bort
  kön när en bok startar och visar inte boken efter omstart.
- 2026-11-28: Skärmtiden räknar inte tiden mellan två uppspelningar (förut i Idéer), gren
  `team/skarmtid-glapp-2026-11-28`. Bekräftat i Chrome (webbspelaren, `/direct` och remux): 10 s film, stäng, 20 s,
  10 s av en annan film gav 41 s för 20,8 s bild, samma film igen likaså; efter rättningen 21 och 20 s. Pausen var
  inget fel: 3 s paus gav 40 s för 40,4 s bild och 70 s paus 30 s för 30,4 s, före och efter. `heartbeat` räknar nu per
  ström (`CAP` 45 s gäller bara mellan livstecken från samma ström), `POST /api/stream/:id/stop` gör nästa start av
  samma titel till en ny uppspelning (efter 15 s utan data), och en stillastående rapport efter en lång paus blir
  startpunkt (förut tappades upp till 10 s när data skickats en stund in i pausen). Tre nya fall i
  `test/screentime-follows.test.js`, bland dem fusk med stopp under hämtning och stillastående rapporter.
- 2026-11-28: iOS-appen lämnar in skärmtiden från tid utan nät (punkt 6, Android och Expo kvar), gren
  `team/apple-skarmtid-2026-11-28`. En post per uppspelning `{ id, at, seconds, audio }` per server och profil
  (`ScreenLog` i `OfflineCore.swift`): posten växer medan filmen spelar, en ny börjar efter mer än 120 s uppehåll eller
  en timme, och id:t (`<uppspelning>-<at>`) återanvänds aldrig. `PendingScreenTime` i `Offline.swift` skickar kön
  (högst 200 per anrop) när `PendingPositions.flush` körs (nätet tillbaka, förgrunden, profilen känd, efter ett lyckat
  framsteg) och före utloggning, tar bort det som `done` listar om posten inte vuxit under tiden och sparar svarets
  `screenTime`. Statiska fall i `apple-offline.test.js`, iOS i kontraktet för `POST /api/screentime/offline`. Samma
  regler speglade i JavaScript mot serverns `addOffline`: 30 min spelat med en paus och en inlämning mitt i gav 1800 s
  på servern, samma poster igen 0 s. Inte provat: kompilering (bara i `apple.yml`) och riktig iPhone i flygplansläge.
- 2026-11-28: Expo-appen lämnar in skärmtid från tid utan nät (Expo-delen av punkt 5), gren
  `team/expo-skarmtid-2026-11-28`. Fel: `freshScreen` ersatte summan per dag (`off`) med serverns status, så tiden
  försvann när nätet kom tillbaka, och *Ta bort allt* tömde den. Nu: poster `{ id, at, seconds, audio }` per
  uppspelning (växer inom 3 s från förra slutet, ny post efter paus och efter en timme, högst 45 s per livstecken,
  äldre än 60 dagar sparas inte), `POST /api/screentime/offline` i `syncPending()` efter positionerna (högst 200 åt
  gången, `device` = slumpat id per profil i `list.json`), `done` tas bort utom en post som vuxit (`sent`), svarets
  `screenTime` gäller. Gamla `off` → en post vid midnatt den dagen. `test/expo-offline.test.js` 18 → 23 fall
  (sommartid, vintertid, midnatt, svar medan posten växer, 200-gränsen, flytten); de nya fallen faller på main (6 av 23).
  **Inte provat:** riktig telefon i flygplansläge; webbläget har inget filsystem och ingen nedladdning.
- 2026-11-28: Expo-appen: sammanfattning, eftertexter och nedräkning till nästa avsnitt (förut punkt 4), samma gren.
  `src/skipcore.ts` (`skipPlan`, `nextPlan`, `SKIP_DELAY`) är webbens `autoskip.js` i TypeScript, och
  `test/expo-skip.test.js` jämför dem fall för fall. `Player.tsx`: knapp per del, nedräkning 3 s med *Avbryt* som väntar
  vid paus, kortet *Nästa avsnitt om … s* / *Nästa avsnitt* med *Spela nu*, `warmPlay(next.id, next.start)` när
  eftertexterna börjar, under kortets nedräkning och vid `onPressIn` (inte för ett nedladdat nästa avsnitt). Webbläget i
  Chrome (Playwright, 390×844, två avsnitt på 40 s): sammanfattningen hoppades över efter nedräkningen, introt bara med
  knappen, `warm=1` för avsnitt 2 när eftertexterna började och samma frågesträng i uppspelningen 9,6 s senare,
  kortet räknade 5 → 3 → avsnitt 2; med automatisk överhoppning av eftertexter väntade nedräkningen under 2,5 s paus;
  avsnitt 2 utan nästa stängde spelaren. **Inte provat:** telefonens egen spelare (helskärm, bild-i-bild).
- 2026-11-28: Spolning i Safari på iPhone och iPad startar om vid målet (förut punkt 1), gren
  `team/webb-safari-2026-11-28`. `web/js/player/nativeseek.js` (`watchNativeSeeks`): `seeking`, `v.buffered`,
  medialistans segment och `/hls/ready` (var 4:e s medan filmen spelar) → `seekRestart` → `load(t)` med `holdTime` och
  `/playback?start=&prev=` (`nhls=1` → `xs`, `EXT-X-START`). Prov: låtsad video med regler (i bufferten, servern har
  målet, för gammalt svar, före första bilden, början och slutet) och mot servern (ny ström med `xs=57`,
  `EXT-X-START`, 1 s-segment vid 57 s, den gamla stoppad) i `test/fast-resume.test.js`; i Chrome med Safaris
  användaragent (`test/web-chrome-playback.test.js`, faller utan ändringen) gav spolning till 150 s bild efter 0,51–0,75 s.
  **Inte provat:** riktig Safari (WebKit saknas här, Playwrights WebKit är inte installerat), iPhone, iPad – Antons
  prov står under *Bara Anton kan göra*.
  Samma gren: utan uppmätt bandbredd listar mastern steget som ryms i 6 Mbit/s först (förut taket), samma som hls.js
  startgissning – webbens startsteg och det förstartade är nu desamma även utan `bw` (`stream-smooth.test.js`).
  Apparna utan `bw` får också det steget först.

- 2026-11-28: iOS/tvOS-appen startar fortare (förut punkt 3, sista delen efter Android och Expo), gren
  `team/apple-start-2026-11-28`. `/playback` går samtidigt som `/api/items/:id` (`StartCore.together` i
  `StartCore.swift`, bara Foundation); en ström som aldrig används (titeln gick inte att hämta, spelaren stängdes eller
  byttes) stoppas med `pid`. `cinema=1` vid start från början i stället för att först läsa `/api/me/cinema`
  (`cinemaEnabled` och `CinemaPrefs` borttagna). Förvärmning (`warm=1`, exakt uppspelningens fråga, `Start.query`) när
  fokus stått 0,7 s på Spela, Fortsätt, Börja om, nästa avsnitt eller ett avsnitt (`warmOnFocus` i `Start.swift`), och
  på iPhone/iPad en gång när titelsidan öppnas. Ljudspåret på titelsidan: profilens `defaultAudio` (förut filens
  förvalda spår), och förvalet skickas inte – servern väljer, samma regel som Android (`titleAudio`/`playAudio`).
  Kontrakt: `warm=1` och `stop?pid=` för ios, `defaultAudio` i `MediaItem.ios`. Test: `test/apple-start.test.js`
  (7 fall, statiskt; 4 föll före ändringen). Mätt mot en lokal server med appens frågor (engelska förvalt i filen,
  profilen vill ha svenska): förvärmd ström togs över 4/4 (tvOS/iOS, från början och vid 20 s), `audioSelected` =
  svenska utan `audio` i frågan, eget val `audio=1` gav engelska. Inte provat: kompilering (bara i `apple.yml`),
  riktig Apple TV/iPhone och tiden till första bilden.
- 2026-11-28: Skärmtiden kvar och varningen i Android- och Expo-appens spelare (punkt 5, iOS kvar), gren
  `team/skarmtid-kvar-2026-11-28`. Reglerna som webbens `playerLeft`: `ScreenLeftCore.kt` (JVM-test
  `ScreenLeftCoreTest.kt`, 6 fall, körda i ett eget Gradle-projekt) och `src/screenleft.ts`
  (`test/expo-screenleft.test.js`, samma svar som webben för varje sjunde sekund upp till tre timmar). Bilen visar bara
  tiden kvar, ingen varningsrad eller uppläsning. Android har `left` i kontraktet (`ScreenTimeState.android`).
  Expo i webbläget (Chrome via Playwright, 390×844 och 1280×800, svenska och engelska): varningen syns medan filmen
  spelar, tiden kvar när den är pausad, och en paus på 60 s gav 0 s skärmtid på servern.
  **Inte provat:** Android-bygget (bara GitHub Actions), riktig telefon, Google TV och bil.
- 2026-11-28: Korta titlar blir inte sedda för tidigt, gren `team/sett-kort-2026-11-28`. `isWatched` i
  `server/resume.js` (eftertexterna har börjat, annars högst 8 % kvar) ersätter `< 120 s kvar` i `/progress`, IPTV,
  Expo (`offlinecore.ts`) och Android (`OfflineCore.kt` `Watched`). `test/watched.test.js` (3/5/22/120 min, även mot
  servern) och `OfflineCoreTest.kt` föll före ändringen.
- 2026-11-28: Utanför hemmet förstartas omkodningen redan vid `/playback` (förut punkt 5), gren
  `team/abr-forstart-2026-11-28`. Med automatisk kvalitet startar `/playback` ffmpeg för steget som mastern listar
  först (`abrStartQuery` i `stream.js`, samma ordning som `serveAbrMaster`). Uppmätt i `test/fast-resume.test.js`
  (720p 10 bitar → 480p, processorn, 120 ms per rundresa, fyra körningar på en delad maskin): `/playback` → första
  segmentet på median 385–600 ms mot 715–960 ms utan förstart (350–400 ms snabbare varje gång). hls.js väljer samma startsteg som mastern listar först när webben skickat `bw` (testat i
  Chromium mot den inbäddade hls.js för 1,5–30 Mbit/s). Väljer spelaren ett annat steg stoppas det förstartade i samma
  ögonblick som det stegets ffmpeg startar (aldrig två samtidigt vid mätning var 10:e ms). Genom reläet: `relay.test.js`. **Inte provat:** riktig
  mobilanslutning, Safari/AVPlayer/ExoPlayer på enhet. Utan `bw` listades taket först (rättat samma dag, se ovan).
- 2026-11-28: Nästa avsnitt förvärms medan eftertexterna går (förut punkt 1), gren `team/nasta-avsnitt-2026-11-28`.
  Webbspelaren anropar `warmPlay(nextId, 0)` när eftertexterna börjar (`markers`), när kortet i `onEnded` visas och
  under dess nedräkning, och vid pekare/fokus på `#pnext` och *Spela nu* (`warmNext`). `warm()` i `stream.js`
  undantar profilens egen omkodning som är inne på sina sista 120 s (`endsSoon`), förvärmer omkodning bara när det
  finns plats under `limits()` och behåller samma förvärmda ström när samma val frågas igen. Chrome, median av tre
  (klick → första bild): remux 175–285 → 94–144 ms, omkodning 624–1122 → 298–360 ms
  (`test/web-next-episode.test.js`); reglerna i `test/fast-resume.test.js`.
- 2026-11-28: iOS/tvOS-appen frågar servern vad som är kodat (förut punkt 4) och räknar skärmtid utan nät, gren
  `team/apple-ready-2026-11-28`. Spolning: `GET /api/stream/:id/hls/ready` var 4:e sekund medan en omkodning spelar
  (`askReady` i `Player.swift`), svaret gäller 8 s och bara om det frågades före spolningen (`readyFor`/`readyFrom` i
  `SeekCore.swift`, samma regler som Expo); gissningen ur bufferten är kvar som reserv. Omstarten väntar 0,6 s på nästa
  steg bara på Apple TV, 0,3 s på iPhone/iPad (reglaget ger ett hopp per mätning). Skärmtid: fel – nedladdningar
  spelades utan gräns utan nät (inget räknades, `reportProgress` läste bara `stop`). Nu: senaste statusen per server
  och profil (`GET /api/screentime` när profilen blir känd, `screenTime` i framstegssvaret), tiden räknas när
  framsteget inte kommer fram och spelaren stoppar med serverns besked, även före start (`ScreenClock` i
  `OfflineCore.swift` som Androids, `OfflineScreen` i `Offline.swift`). Statiska fall i `apple-seek.test.js` och
  `apple-offline.test.js`, iOS i kontraktet för `/hls/ready` och `/api/screentime`. Inte provat: kompilering (bara i
  `apple.yml`), riktig iPhone i flygplansläge och spolning med Apple TV:s fjärrkontroll.
- 2026-11-28: Android- och Expo-appen startar fortare (punkt 6, iOS kvar), gren `team/app-start-2026-11-28`.
  `/playback` går samtidigt som `/api/items/:id` (Android `StartCore.together`, Expo `startcore.ts`
  `startPlayback`); en ström som aldrig används stoppas med `pid`. Android skickar `cinema=1` vid start från början i
  stället för att först läsa `/api/me/cinema`, och förvärmer (`warm=1`, exakt samma fråga) när fokus stått 0,7 s på en
  Spela-knapp eller ett avsnitt (`warmOnFocus`). Expo tar det tidiga svaret när `audioSelected` = titelns
  `defaultAudio`, annars ny fråga med `prev`. Kontraktet: `GET /api/items/:id/playback?warm=1` för Android,
  `/api/me/cinema` borttagen för Android. Test: `StartCoreTest.kt` (JVM, 7 fall), `test/expo-start.test.js`; mätt mot
  lokal server med fördröjning (Android 205–225 → ~75 ms till svaret, förvärmd ström togs över 8/8) och Expo-webbygget
  i Chrome (`/playback` skickad före titelns svar; svaret 220–230 → 134–145 ms). Inte provat på riktig enhet;
  Android-bygget bara i CI.
- 2026-11-27: Webbspelaren stoppar omkodningen när fliken eller TV-webbläsaren stängs (förut punkt 2), gren
  `team/flik-stopp-2026-11-27`. `pagehide` utan `persisted` skickar `/api/stream/:id/stop?pid=&gone=1` med
  `sendBeacon` (reserv: `fetch` med `keepalive`); inte vid bfcache, utan `pid` eller via AirPlay. `gone=1` gör att en
  sen segmentbegäran från den stängda sidan får 409 i stället för att starta en ny ffmpeg (`noteDropped` i
  `stream.js`). Service workern låter POST/PUT/DELETE gå direkt till nätet (`addRoutes`): utan det försvann stoppet
  vid omladdning i 3 av 4 körningar. `test/web-leave-stop.test.js` (Chrome: stängd flik, omladdning, bfcache),
  fall i `stream-smooth.test.js` och `relay.test.js`. Kvar: webbläsare utan statiska vägval (Safari, Firefox, äldre
  TV-webbläsare) kan fortfarande tappa stoppet vid omladdning – då städar servern efter 60 s som förut.
- 2026-11-27: iOS/tvOS-appen: nedladdningar per server och profil, och positioner utan nät, gren
  `team/apple-offline-2026-11-27`. Lista och mapp per profil (`Downloads/<server>-<profil>/`), profilen sparad per
  inloggning (fingeravtryck) så att rätt lista syns utan nät, flytt av de gamla nedladdningarna (Android-appens regler,
  huvudkontot när det inte går att veta), nedladdning som blir klar hamnar hos profilen som startade den, *Logga ut*
  frågar och tar bort serverns nedladdningar, borttagning när profilen inte får ladda ner eller se titeln (403/404,
  var sjätte timme) och en kö med `at` för filmer, avsnitt, ljudböcker och poddar. Reglerna i `OfflineCore.swift`
  (bara Foundation); `test/apple-offline.test.js` (9 fall, statiskt). `OfflineCore.swift` kompilerad och provad med
  Swift 6.0.3 på Linux (48 kontroller, bl.a. Android-testets fall för flytten), `Offline.swift` typkontrollerad där
  med påhittade SwiftUI/Network-typer. **Inte provat:** bygget i `apple.yml` och en riktig iPad.
- 2026-11-27: Tidslinjen står på målet när webbspelaren startar om strömmen, gren `team/webb-spola-2026-11-27`.
  `holdTime()` i `web/js/player/video.js` låter videons `currentTime` ge målet från `load()` tills den nya strömmen har
  data där (eller spelar), så tidslinjen, tiden, skärmläsaren, Casta, fjärrstyrningen, minispelaren och ett nytt byte
  utgår från målet; spolningsbilden vid målet visas över den svarta videon och "Förbereder…" först efter 1,5 s.
  Gäller alla `load()` i en ström som redan spelat (spolning i omkodning, kvalitet, ljud, nattläge, H.264-reserv,
  byte till omkodning vid öppen GOP); `guardSeeks` läser samma mål. `test/web-chrome-playback.test.js` läser
  tidslinjen var 50:e ms vid spolningen och vid ett kvalitetsbyte med fördröjd server (2,5 s): förut 0 s i 200–250 ms,
  nu aldrig under målet, väntetexten efter ~1,55 s. **Inte provat:** Safari/AirPlay (egen HLS, `v.src`), riktig
  Chromecast, och första starten (Fortsätt titta) som visar "Förbereder…" som förut.
- 2026-11-27: Android-appen – sparad bildtoken och nedladdningar per profil, gren `team/android-tok-2026-11-27`.
  Bildtoken sparas per server och profil i de privata inställningarna (`ImageTokenBook` i `ImageTokenCore.kt`, JSON
  `{ tokens: { userId: { token, until } }, last }` under `img <server>`), förnyas när mindre än ett dygn är kvar eller
  efter 401 på en bild (`Api.imageFailed` från Coils `Home.images`, högst en gång i minuten) och tas bort vid
  utloggning; start, inloggning och profilbyte tar inte längre en ny. `TokenResponse` har `ttl` (kontraktet också).
  Förlopp och fel för nedladdningar nycklas per profil (`DownloadKey`/`DownloadProgress` i `DownloadCore.kt`), och
  följer med när nedladdningar från 0.7.0 flyttas till en profil. JVM-test: `ImageTokenCoreTest.kt` (9) och
  `DownloadCoreTest.kt` (11, varav 2 nya) gröna lokalt. **Inte provat:** `Api.kt`, `Offline.kt` och `Hemma.kt` är
  inte kompilerade här (ingen Android SDK) och appen inte körd på telefon, TV eller bil.
- 2026-11-27: Småfel, gren `team/smafel-2026-11-27`. Poddavsnittens framsteg tar emot `at` med samma regel som filmer,
  ljudböcker och e-böcker (gemensam `syncAt` i `server/util.js`); testat i `test/books-podcasts.test.js` och
  `test/offline-web.test.js`. Lokalt datum i inspelningens metadata och exporters filnamn var redan rättat 2026-11-25
  (`util.localDate`, `test/security-review5.test.js`); raden låg kvar. Skärmtidens och aktivitetens egna kopior av
  datumfunktionen använder nu `util.localDate`.
- 2026-11-27: Expo-appen frågar servern vad som är kodat vid spolning (commit `8d49b54`). `/api/stream/:id/hls/ready`
  (samma svar som `X-Seg-Ready`, startar aldrig någon omkodning) var 4:e sekund medan strömmen spelar; svaret används
  i 8 s (`readyFor` i `apps/expo/src/seekcore.ts`), annars gissar appen som förut. `prev` och `replaced=1` står i
  `docs/api.md`. **Inte provat:** riktig telefon.
- 2026-11-27: Snabb spolning i en omkodning i iOS/tvOS-appen, gren `team/apple-spola-2026-11-27`. Reglerna i
  `Shared/SeekCore.swift` (bara Foundation, samma gränser som Expo/Android): ett hopp i positionen utanför bufferten
  startar om strömmen vid målet med `/playback?start=&prev=` efter 0,6 s utan nytt steg (`seekRestart` i
  `Player.swift`), med samma ljudspår, undertext, hastighet och paus; en inaktuell ström stoppas med `replaced=1`.
  Apple TV skickar inte `nhls` (Dolby Digital i TS skulle bli AAC), så appen lägger själv till `xs` i strömmens adress
  (`SeekCore.withStart`) och spellistorna får `EXT-X-START` – provat mot servern i `test/fast-resume.test.js` (nytt
  fall, 12 gröna). Även *Rapportera felet* i live-spelaren och `imageFailed` från titelsidans bakgrund, musik,
  ljudböcker, poddar, kanallogor och *Kommer snart*. `test/apple-seek.test.js` (2 statiska fall) jämför gränserna med
  Expo/Android; kontraktet har en variant med `start` och `prev` för iOS. **Inte provat:** appen är inte kompilerad
  här (ingen Xcode, ingen Swift) och inte körd på iPhone, iPad eller Apple TV.

### 1.5.0

- 2026-11-27: Expo-appen på engelska, gren `team/expo-engelska-2026-11-27`. `src/i18n.ts` (`t`, `tn`, `fmtNum`,
  språkval efter telefonen via `Intl` – svenska → sv, annars en – och *Konto → Språk*, sparat i telefonen) och
  `src/i18n-en.ts` med 380 texter, varav 156 med exakt webbens engelska. `Accept-Language` till servern, datum och tal
  efter språket, plural med `Intl.PluralRules`, smarta listornas namn efter id. `test/expo-i18n.test.js` (7 fall: ingen
  svensk text utanför `t()` – 286 fynd på main –, katalogen mot koden och webben, språkval/plural/tal i Node);
  `test/expo-offline.test.js` kör nu på svenska uttryckligen. Webbläget mot en egen server med Playwright (390×844,
  Chrome på engelska): start, film, serie, musik, album, helskärmsspelare, Konto, Nedladdat (bara webbens besked – med
  en tillfällig byggvariant, eftersom Nedladdat inte nås i webbläget), Feedback och Mina ärenden utan svensk text, byte
  till svenska och tillbaka. **Inte provat:** Expo Go på en riktig telefon på engelska (att `Intl` ger telefonens språk
  i Hermes på iPhone och Android), Nedladdat med riktiga nedladdningar på engelska.
- 2026-11-27: Feedback och Mina ärenden i iOS/tvOS-appen och sparad bildtoken, gren `team/apple-feedback-2026-11-27`.
  Samma formulär och *Mina ärenden* som Expo och Android, under *Inställningar* och som *Rapportera felet* i spelaren;
  på Apple TV med tvOS tangentbord (`Shared/Feedback.swift` med reglerna i `FeedbackCore`, `Shared/FeedbackViews.swift`;
  sidan för *Gäller* sätts med `.feedbackPage(…)` i `Views.swift` och `Player.swift`). Bildtoken sparas i nyckelringen
  per server och profil (`ImageTokenBook` i `AppModel.swift`, `{ tokens: { userId: { token, until } }, last }`), förnyas
  när mindre än ett dygn är kvar eller efter 401 på ett affischkort (`imageFailed`), och tas bort vid utloggning; start,
  inloggning och profilbyte tar inte längre en ny. Kontraktet har iOS-appens fem nya anrop och `ttl` i
  `TokenResponse.ios` (148 fall gröna); `test/apple-i18n.test.js` (3 fall) kontrollerar de engelska texterna.
  **Inte provat:** appen är inte kompilerad här (ingen Xcode) och inte körd på iPhone, iPad eller Apple TV.
- 2026-11-27: Feedback och Mina ärenden i Expo- och Android-appen, gren `team/app-feedback-2026-11-27`. Samma dialog
  som webben (typ, *Gäller* förvalt efter skärmen man var på, meddelande, teknisk information med *Visa vad som skickas
  med* från `POST /api/support/context`) och *Mina ärenden* med status, svar och svar på teamets fråga. Expo: under
  *Konto* och *Rapportera felet* i spelaren när uppspelningen inte kunde startas (`src/feedback.ts`,
  `src/screens/Feedback.tsx`). Android: under *Inställningar*, med fjärrkontroll på TV; i bilen bara *Mina ärenden* att
  läsa; *Rapportera felet* i spelaren utom i bilen (`Feedback.kt`, `FeedbackCore.kt` med `FeedbackCoreTest.kt`, 6 fall
  på JVM). Servern: `buildContext` tar emot `context.client` (appens namn, version och plattform) och sparar det som
  `app` – fel form tas bort, versionen får inte vara en IP-adress (`test/support.test.js`, fall 12). Kontraktet har
  Android-appens fem nya anrop. Expo i webbläget mot en egen server med Playwright (390×844). **Inte provat:** på riktig
  telefon, Google TV eller bil; Android-appen är inte kompilerad här (ingen Android SDK).
- 2026-11-27: Spolning i en omkodning i Expo- och Android-appen, gren `team/app-spola-2026-11-27`. Samma regler som
  webben (`seekcore.ts`, `SeekCore.kt`): spolning utanför bufferten startar om strömmen vid målet med `start=` och
  `prev=`. Expo märker spolningen som ett hopp i positionen (var 0,25 s), gissar vad servern har kodat och skickar
  `nhls=1` även på Android (`EXT-X-START`); inte i webbläget (Chromes HLS hämtar början först – uppmätt 2,4–2,8 s →
  2,9–3,7 s, långsammare). Android: `SeekingPlayer` (ForwardingPlayer runt ExoPlayer) fångar tidslinjen, snabbspolning
  och fjärrkontrollen före ExoPlayer, `X-Seg-Ready` läses med en `TransferListener`, fjärrkontrollens steg samlas
  (0,6 s). Uppmätt mot servern som en spelare som följer `EXT-X-START` (1080p H.264 10 bitar, 4 kärnor): segmentet med
  målet 2,1–2,4 s → 0,67–0,80 s. `test/expo-seek.test.js`, `SeekCoreTest.kt` (körd med Gradle på JVM här), kontraktet
  har `prev` och `/stop?pid=&replaced=1`. **Inte provat:** riktig telefon, Google TV, bil; Android-appen är inte
  kompilerad här (ingen Android SDK).
- 2026-11-27: Spolning i en omkodning och tidig `/playback`, gren `team/spola-2026-11-27`. Spolning utanför bufferten
  laddar om strömmen från målet med korta segment där (`seekRestart`/`seekRestarts`, `prev=` → `dropPlayback`,
  `X-Seg-Ready`); `play()` skickar `/playback` samtidigt som titelns uppgifter hämtas (`earlyPlayback`/`earlyFits`).
  Uppmätt i Chrome, 1080p H.264 10 bitar, 4 kärnor (last 2–6, mest mätningens egen ffmpeg): spolning 2,7–4,6 s → 0,86–1,06 s
  till bild; vakten (640×360) 1,0–2,1 s → 0,26–0,56 s. `/playback` skickas 12–64 ms innan titelns uppgifter är klara
  (förut 20–40 ms efter). `test/fast-resume.test.js`, `test/stream-smooth.test.js`, `test/web-chrome-playback.test.js`.
  **Inte provat:** grafikkort (2 s-segment vid målet), Safari, apparna.
- 2026-11-27: Omkodningens start, gren `team/tcstart-2026-11-27`. Med processorn är första segmentet där uppspelningen
  börjar 1 s (`h1=1` i adressen, `transcodeStarts` i `server/stream.js`); väntan på segment vaknar när nästa fil skapas
  (`dirChange`); en stoppad session startar inte om ffmpeg för en begäran som väntade (förut kodade den vidare i upp
  till en minut och tog processorn från nästa start). Uppmätt 1080p, 4 kärnor, ingen annan last: servern 0,67–1,3 s →
  0,45–0,7 s till första segment, Chrome 1,0–2,0 s → 0,7–1,0 s till första bild (H.264 10 bitar och HEVC → H.264, från
  början och mitt i). Bilden efter 4 s är bit för bit densamma. Grafikkortet behåller 2 s (inte provat med riktigt
  grafikkort). Prövat och inte behållet (siffror i `docs/arkitektur.md`): servering medan segmentet skrivs (hls.js
  lägger bara in hela segment, och lokalt tar överföringen 5–20 ms), `ultrafast`/`zerolatency` för början, mindre
  `-probesize`.
- 2026-11-26: Undertexter i offline-filen, gren `team/offline-undertext-2026-11-26`. Fel: `server/offline.js` kodade
  med `-sn`, så nedladdade filmer saknade undertexter i filen – apparna ritade egna ovanpå, som inte syns i telefonens
  helskärm, bild-i-bild eller AirPlay/Chromecast. Nu läggs textundertexterna (inbäddade, externa `.sv.srt` och
  nedladdade) in som `mov_text` med språk, namn, kontots förval och familjefiltrets maskning; grundfilen kodas en gång
  och varianterna muxas utan omkodning. Bildundertexter följer inte med. `test/offline-subs.test.js` (6 fall med
  ffprobe). **Inte provat:** att iPhone/Android/AirPlay/Chromecast faktiskt visar spåren från en nedladdad fil.
- 2026-11-26: Android-appen: nedladdningar per server och profil, borttagning vid utloggning och vid 403/404, och
  ljudböckers och poddars positioner i kön utan nät, gren `team/android-profil-2026-11-26`. Fel: `Offline.kt` hade en
  gemensam lista och mapp (`DownloadRecord` utan profil), så en barnprofil såg en vuxens nedladdningar, och allt låg kvar
  efter utloggning; `MusicService.saveSpoken` släppte positionen när anropet inte kom fram (`runCatching`).
  `PlayerScreen.report` startade ett nytt framstegsanrop var tionde sekund även när förra (15 s tidsgräns) pågick.
  Nu: `offline/<server>-<profil>/` och `list.<server>-<profil>` (reglerna i `DownloadCore.kt`), flytten av nedladdningar
  från 0.7.0 till profilen som var inloggad (eller huvudkontot), fråga vid *Logga ut*, `Downloads.online` efter
  `Session.refresh` (allt bort när `canDownload` är falskt, 403/404 var sjätte timme), kön med `kind` (film, bok, podd)
  och ett anrop åt gången i spelaren och ljudspelaren. `DownloadCoreTest.kt` (9 fall) och två nya i
  `OfflineCoreTest.kt`. Inte provat: kompilering av `Api.kt`, `MainActivity.kt`, `MusicService.kt` och
  `PlayerScreen.kt` (`Offline.kt`, `OfflineSync.kt` och `Net.kt` kompilerade mot Android 14:s klasser), uppdatering
  från 0.7.0 på riktig enhet.
- 2026-11-26: Android-appen: positioner och skärmtid utan nät (samma regler som Expo-appen), gren
  `team/android-offline-2026-11-26`. Fel: `PlayerScreen.report` gjorde inget när `/api/items/:id` inte svarade (nedladdad
  titel utan nät), och `Api.reportProgress` släppte positionen vid nätfel; skärmtiden kollades bara i serverns svar.
  Nu: kö per server och profil (`OfflineSync.kt`), skickas i ordning med `at` när nätet kommer tillbaka
  (`registerDefaultNetworkCallback`), i `onResume`, efter `Session.refresh` och efter ett lyckat framsteg; senaste
  skärmtidsstatusen (`GET /api/screentime`, `screenTime` i framstegssvaret) och tiden utan nät räknas i appen och
  stoppar med serverns besked. Nedladdat börjar där man slutade. `OfflineCoreTest.kt` (16 fall på JVM) körs nu i
  `android-automotive.yml` (`testReleaseUnitTest`). Ljudböcker och poddar kan inte laddas ner i Android-appen, så de
  berörs inte. Inte provat: kompilering av hela appen (`OfflineSync.kt` kompilerad mot Android 14:s klasser, inte
  `PlayerScreen.kt`), riktig enhet i flygplansläge.
- 2026-11-26: Hemma via den publika adressen i iOS/tvOS-appen (förut punkt 5), gren `team/apple-hemma-2026-11-26`.
  Samma regler som Expo- och Android-appen: `/api/local` från den sparade adressen, alla hemadresser provas samtidigt
  (800 ms, utan inloggning, kakor och omdirigeringar), används bara när `id` och `proof` stämmer exakt. Provet görs när
  servern öppnas, när appen blir aktiv (scenePhase, högst var 30:e s) och när nätet byts (NWPathMonitor); hemadressen
  slutar gälla innan nästa förfrågan när nätet ändrats. Nätverksfel → den sparade adressen och nytt försök (API; filmen
  byter adress där den var). http provas bara mot adresser i hemnätet; nedladdningar går via den sparade adressen.
  Inställningar visar *Hemma: direkt via …*. ATS: `NSAllowsArbitraryLoads` fanns redan; `NSAllowsLocalNetworking` lades
  med flit inte till (den stänger av `NSAllowsArbitraryLoads`). **Inte provat:** kompilering (ingen Xcode här – bygg med
  `apple.yml`), riktig iPhone/Apple TV, frågan om lokalt nätverk, *Klart när* (Apple TV hemma med reläets adress spelar
  med `remote: false`).

### 1.4.4

- 2026-11-26: Hårdvaruomkodning – provet i Administration (förut punkt 2), gren `team/hwprov-2026-11-26`.
  *Administration → Hårdvaruomkodning → Prova omkodningen* (`server/hwprobe.js`, `web/js/views/admin-hwprobe.js`,
  `/api/admin/hwprobe`): genererad testbild, H.264/HEVC/HEVC 10 bitar i 1080p och 4K med `HWACCEL` och med processorn,
  *grafikkortet används / processorn används / fungerar inte*, bildrutor/s och gånger realtid, förklaring per felkod och
  ffmpegs felrad. Lägsta prioritet, vägrar vid två eller fler omkodningar. Senaste resultatet sparas och ligger i
  diagnostikpaketet. `test/hwprobe.test.js` (felrader från NVENC, VAAPI och QSV, rutten, riktigt prov med processorn).
  Inte provat: riktig NVENC, VAAPI eller QSV – felraderna utan hårdvara är fångade här, övriga är kända rader ur ffmpeg
  och felrapporter, och hastighetsmätningen med grafikkort är inte körd (se *Bara Anton kan göra*).
- 2026-11-26: Expo-appen: nedladdning för offline (förut punkt 4), gren `team/expo-offline-2026-11-26`. Film, avsnitt,
  hel säsong och ljudbok med kvalitet (480p–full upplösning, uppskattad storlek), förlopp, paus, fortsätt, avbryt och
  försök igen; hemadressen används när den är bekräftad. *Nedladdat* (Konto) fungerar utan nät och öppnas direkt när
  servern inte svarar vid start. Spelaren spelar den lokala filen med nedladdade textundertexter ritade ovanpå
  (inte i telefonens helskärm). Positioner utan nät skickas med `at`; skärmtiden följer senaste status och räknar tiden
  utan nät i telefonen. Per server och profil, tas bort vid utloggning (frågar först); titlar som profilen inte får se
  längre tas bort när servern svarar. Nytt paket `expo-file-system`. `test/expo-offline.test.js` (18 fall, logiken och
  `offline.ts` med låtsat filsystem och server). **Inte provat:** riktig telefon, flygplansläge, bakgrundsnedladdning i
  Expo Go och eget bygge – *Klart när* (film i flygplansläge, positionen syns på servern efteråt) väntar på Anton.

### 1.4.2

- 2026-11-26: Hemma via den publika adressen i Android-appen (telefon, Google TV, bil; punkt 6 för Android), gren
  `team/android-hemma-2026-11-26`. Samma regler som Expo-appen: `/api/local` från den sparade adressen, alla hemadresser
  provas samtidigt (800 ms, utan inloggning, utan omdirigeringar), används bara när `id` och `proof` stämmer exakt.
  Provet görs när servern öppnas, i förgrunden (högst var 30:e s) och när nätet byts; hemadressen slutar gälla när
  enhetens nät inte är det där den bekräftades. Nätverksfel → den sparade adressen och nytt försök (API, Media3 via en
  egen DataSource, Coil). http provas bara mot adresser i hemnätet. Inställningar visar *Hemma: direkt via …*.
  `app/src/test/…/LocalPickTest.kt` (10 fall, körda på JVM här; körs inte i workflowet). Inte provat: kompilering av hela
  appen (ingen Android SDK – `LocalPick.kt` och `Hemma.kt` kompilerade mot Media3 1.4.1, Coil 2.7.0 och Android 14:s
  klasser), riktig telefon, Google TV och bil, riktigt hemnät med relä.

### 1.4.1

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
- 2026-11-25: Uppspelningsvakt i riktig Chrome (`npm run vakt`, `test/vakt.mjs`) – sex filer × elva fall (start, Fortsätt
  titta, paus, spolning inom och utanför bufferten, kvalitet, ljud, undertext) med tid till bild, avkodningsfel och
  tappade bildrutor; körs före varje stabil utgåva och stoppar den vid fel. Siffrorna i `docs/testat.md`.

### 1.4.0

- 2026-11-25: Sovtimer i videospelaren (15/30/45/60 min eller *När avsnittet tar slut*, nedtoning, paus som sparar
  positionen, följer med till nästa avsnitt, fjärrkontroll) och skärmtiden i webbspelaren (*X min kvar idag*, varning de
  sista fem minuterna). Paus räknades som skärmtid: vid direktuppspelning upp till 20 s per paus (Chrome: 6 s
  uppspelning + 60 s paus = 20 s räknat, nu 7 s; `streamMeter`), och en paus under 45 s helt när filmen startade igen
  (rapport vid start, `heartbeat`). Pilarna i dialoger från spelaren fungerar (`router.js`). Inte gjort: Safari och
  apparna (se *Näst på tur* 10).
- 2026-11-25: Feedback – notis till administratören när något väntar (utan text och namn, högst en i timmen),
  *Öppna igen* för avslutade ärenden, gallring efter 180 dagar; API-nycklar går att ändra.
- 2026-11-25: Engelska i serverns texter – felmeddelanden, skärmtid,
  åldersgräns, nedladdning, startsidans hyllnamn, *Avsnitt N*, spårens och versionernas namn, notiserna och
  offlinesidan följer profilens språk (annars kakan/`Accept-Language`) med webbens katalog (`server/i18n.js`,
  `test/server-i18n.test.js`).
- 2026-11-25: Expo-appen – musik, ljudböcker och poddar: fliken *Musik* (översikt, album, artister, spellistor,
  sökning, ljudböcker, poddar), albumsida, minispelare och helskärmsspelare med `expo-audio`; kön delas med webben via
  `/api/me/queue` och visas pausad efter omstart; ljudböcker och avsnitt fortsätter där man slutade. Visat i
  webbläget (Chrome 390×844); bakgrundsljud och låsskärm inte provade på riktig telefon (se *Bara Anton kan göra*).
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

### Äldre än 1.4.0

- 1.3.0 (2026-11-24): backloggen, feedback och felrapporter med granskning under *Administration → Support*, öppen GOP
  i webben (Fortsätt titta och spolning fastnar inte), fjärde granskningen av servern, webben på TV och telefon och
  musikspelarens minne, hopp i kön och dåligt nät.
- 1.2.2 och tidigare: se [CHANGELOG.md](../CHANGELOG.md).

## Bara Anton kan göra

**Konton, GitHub och beslut**

- Ge teamet serverns adress utifrån och en API-nyckel med behörigheten *Support* (utan *Bara från hemnätet*), så att
  godkända ärenden kan hämtas.
- Läs den nya formuleringen i `PRIVACY.md` om feedback och felrapporter.
- **Supporttråd på Unraid-forumet:** skapa tråden och skicka länken, så att `<Support>` i `braxhn-tv.xml` och
  `braxhn-tv-nvidia.xml` kan peka dit (i dag pekar den på GitHub-ärenden).
- **Skicka in mallen till Community Applications.**
- **Gör paketet publikt** (containerimagen på GitHub).
- **Slå på Private vulnerability reporting** i repots inställningar på GitHub.
- **Ta bort grenarna `android-engelska` och `windows-prov`** på GitHub (Android-appen på engelska kom i 1.4.0 och
  Windows-appen i 1.4.1). Kontrollera först: 2026-11-27 hade `windows-prov` bara en commit vars ändring redan finns på
  `main` (`fec6612`, samma som iOS-feedbacken), men `android-engelska` hade en ny commit som inte finns på `main`
  (`c5170ae`, Android: bildtoken och nedladdningarnas förlopp per profil) – slå ihop eller flytta den först.
- **CarPlay:** ansök om tillståndet hos Apple om det ska byggas.

**Hårdvara hemma**

- **Kör hårdvaruprovet med NVENC** på Unraid-servern: *Administration → Hårdvaruomkodning → Prova omkodningen* när
  ingen tittar. Skicka en skärmbild, eller diagnostikpaketet (*Hälsokontroll*, `hardware.json` → `probe`). Står det
  *Fungerar inte* för H.264: följ förklaringen och prova igen. Blir 10-bitars HEVC eller 4K långsammare än 1 × vill
  vi veta det. Med grafikkortet är första segmentet fortfarande 2 s – siffrorna avgör om det också kan bli 1 s.
- **Docker-imagen för arm64** är byggd i GitHub Actions men inte provad på en arm-maskin (t.ex. en Raspberry Pi 4/5).

**Riktiga enheter**

- **Prova iOS-appens nedladdningar per profil** på iPad: installera den nya versionen över den gamla med en
  nedladdad film (filmen ska finnas kvar för samma profil), byt till en barnprofil (ska inte se den), titta en stund
  på en nedladdad film i flygplansläge, slå av flygplansläget (positionen ska synas i webben) och logga ut (frågan,
  sedan borta).
- **iPhone (Safari):** börja på en film, stäng, öppna igen – fortsätter den på rätt ställe direkt? Spola långt fram i
  en film som kodas om och säg ungefär hur länge det tar innan bilden kommer (sedan *Ej utgiven* startar webben om
  strömmen vid målet även i Safari – förut 3–4,5 s; fastnar bilden, hoppar den tillbaka eller syns *Förbereder…* länge
  vill vi veta det).
- **Appen för iPhone, iPad och Apple TV** (bygg med `apple.yml`): Fortsätt titta och spolning långt fram i en omkodad
  film (även med fjärrkontrollen), *Skicka feedback* och *Mina ärenden*, att bilderna kommer tillbaka efter en stund,
  och *Hemma: direkt via …* med reläets adress.
- **Expo-appen i Expo Go** på en riktig iPhone och Android-telefon (`apps/expo/README.md`), på svenska och med
  telefonen på engelska:
  - musik med låst skärm i mer än tre minuter, hörlurarnas knappar och omslaget på låsskärmen;
  - nedladdning: ladda ner en film (480p) och en ljudbok, slå på flygplansläget, starta om appen (den ska öppna
    *Nedladdat*), titta en stund, slå av flygplansläget och kontrollera att positionen syns i webben; lås också skärmen
    under en nedladdning i några minuter;
  - spolning långt fram i en omkodad film, och *Skicka feedback*.
- **Android-appen utan nät:** ladda ner en film, slå på flygplansläget, spela en stund från *Inställningar →
  Nedladdat för offline*, stäng och spela igen (ska fortsätta där du var), slå av flygplansläget och kontrollera att
  positionen syns i webben. Med en barnprofil med lite tid kvar: filmen ska stoppa med serverns besked utan nät.
- **Android-appens nedladdningar per profil:** installera den nya versionen över 0.7.0 med en nedladdad film
  (filmen ska finnas kvar för samma profil), byt till en barnprofil (ska inte se den), logga ut (frågan, sedan borta),
  och lyssna på en ljudbok i bilen genom en tunnel (positionen ska synas i webben efteråt).
- **Android-appen på Google TV:** spolning med fjärrkontrollen i en omkodad film (fem tryck i rad), *Skicka feedback*
  med fjärrkontrollen, och appen på engelska.
- **Snabbare hemma** med reläets adress: *Mitt konto → Öppna hemadressen* i webben, och apparna (Konto/Inställningar
  visar *Hemma: direkt via …*). Står det ingen hemadress: öppna servern en gång på dess IP-adress eller ange den under
  *Administration → Hemadressen*.
- **Hack i Chrome** med de filer som frös förut (version 1.2.2 eller senare).
- Det som i övrigt kräver riktig hårdvara eller konton står i *Testat och otestat* i README: Chromecast och AirPlay,
  Android Auto, Let's Encrypt med en publik domän, BraXhn Relay på en riktig VPS, riktiga IPTV-leverantörer, passkeys
  på telefon och Windows-appen på en riktig dator.
