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

Senast genomgången: 2026-11-27 (version 1.5.0 och det som står under *Ej utgiven* i CHANGELOG).

## Pågår

*(inget just nu)*

## Näst på tur

### 1. Nästa avsnitt startar direkt: förvärm det medan eftertexterna går

- **Vad:** när webbspelaren visar *Hoppa över eftertexterna* med nedräkning (`startSkipCountdown`) eller kortet
  *Nästa avsnitt om …* (`onEnded`), anropa `warmPlay(nextId, 0)` som Spela-knapparna redan gör, så att disken vaknar
  och första segmentet är klart när nästa avsnitt startar. I dag går `goNext` → `play()` hela vägen från början.
- **Varför:** barnen tittar mest på serier i följd, och bytet mellan avsnitt är den start som sker oftast. Plex och
  Infuse byter avsnitt nästan utan väntan.
- **Filer:** `web/js/player/video.js` (`markers`, `startSkipCountdown`, `onEnded`, `warmPlay`), `server/stream.js`
  (`warm`). Kontrollera först: `warm()` vägrar förvärma en omkodning medan någon tittar på en omkodad ström (segment
  de senaste 30 s) – och det gör ju den egna strömmen just då. Regeln behöver undanta samma profils ström som snart
  slutar, utan att två omkodningar slåss om processorn.
- **Klart när:** i riktig Chrome (som `test/web-chrome-playback.test.js`) är tiden från *Spela nu*/nedräkningens slut
  till första bild i nästa avsnitt mätt före och efter, för remux och omkodning, och vakten är grön.

### 2. Stoppa omkodningen när fliken eller TV-webbläsaren stängs

- **Vad:** skicka `/api/stream/:id/stop?pid=` med `navigator.sendBeacon` vid `pagehide` i webbspelaren. I dag skickas
  bara framsteget där (`pagehide` → `sendProgress(true)` i `video.js`); stoppet görs bara av `closePlayer`.
- **Varför:** stängs fliken mitt i en omkodning fortsätter ffmpeg tills den ligger 15 segment före (`AHEAD_TRANSCODE`)
  eller varit utan förfrågningar i 60 s (`server/stream.js`), och under tiden räknas den som "någon tittar" – så nästa
  start på en annan enhet får dela processorn och förvärms inte (`warm`).
- **Filer:** `web/js/player/video.js`, `server/routes/playback.js` (`/api/stream/:id/stop`; `sameOrigin` i
  `server/http/router.js` släpper igenom en beacon från samma sida – kontrollera först).
- **Klart när:** ett test stänger sidan under en omkodning och visar att ffmpeg-processen är borta inom 2 s.

### 3. iOS/tvOS-appen: nedladdningar per server och profil, och positioner utan nät

- **Vad:** appens nedladdningar har en gemensam lista och mapp för alla servrar och profiler (`DownloadRecord` utan
  server och profil, `Downloads/index.json` i `apps/apple/Shared/Offline.swift`), och `logout()` i `AppModel.swift`
  rör dem inte. Positionen skickas bara direkt (`reportProgress` med `try?`), så det som spelas utan nät försvinner.
  Gör som Android-appen i 1.5.0 och Expo-appen: lista och mapp per server och profil, flytt av gamla nedladdningar
  till profilen som är inloggad, fråga vid *Logga ut*, borttagning när kontot inte får ladda ner eller titeln inte
  får ses längre, och en kö med `at` för positioner (filmer och böcker; poddar när servern tar emot `at`).
- **Varför:** en barnprofil på familjens iPad ser och kan spela en vuxens nedladdade filmer utan nät – åldersgränsen
  gäller inte där. Två servrar med samma titel-id blandas också ihop.
- **Filer:** `apps/apple/Shared/Offline.swift`, `apps/apple/Shared/AppModel.swift`, `apps/apple/Shared/Player.swift`,
  `apps/apple/Shared/Listen.swift`; reglerna kan följa `DownloadCore.kt` och `OfflineCore.kt` i Android-appen.
- **Klart när:** reglerna är testade (statiskt som `test/apple-seek.test.js`, eller i ett Swift-test i `apple.yml`),
  bygget går igenom, och provet på riktig iPad står under *Bara Anton kan göra*.

### 4. Spolning i Safari på iPhone och iPad: starta om vid målet som webben gör

- **Vad:** Safaris egen HLS (`nativeHls` i `web/js/player/caps.js`) spolar fortfarande inom den gamla spellistan och
  väntar på ett helt 6 s-segment. `seekRestarts` i `web/js/player/video.js` körs bara med hls.js. Gör som iOS-appen:
  ny `/playback` med `start=` och `prev=` när spolningen landar utanför det som är kodat (`EXT-X-START` finns redan,
  `startTag` i `server/stream.js`).
- **Varför:** iPhone och iPad i webbläsaren är vanliga i familjen; spolning i en omkodad film tar där 3–4,5 s mot
  ungefär 1 s i Chrome sedan 1.5.0.
- **Filer:** `web/js/player/video.js`, `web/js/player/hlsconfig.js` (`seekRestart`), `test/fast-resume.test.js`.
- **Klart när:** testet visar en ny ström med `xs` vid målet för `nhls=1`, och Anton har provat på en riktig iPhone
  (se *Bara Anton kan göra*).

### 5. Fortsätt titta på iPhone: mät startpositionen med Apples spelare

- **Vad:** lägg till ett fall med startposition (`start=` och `EXT-X-START`) i `test/media/AVPlayerCheck.swift` och
  `test/media/apple-check.mjs`, som redan körs på macOS i `conformance.yml`. I dag provar de inte startposition.
- **Varför:** rättningen för iPhone och iPad (1.2.1) och Apple TV (*Ej utgiven*) är inte provad med Apples spelare.
  Att filmen fortsätter där man slutade är grundläggande på telefon och surfplatta.
- **Filer:** `test/media/AVPlayerCheck.swift`, `test/media/apple-check.mjs`, `.github/workflows/conformance.yml`,
  `server/stream.js` (bara om mätningen visar fel).
- **Klart när:** körningen på macOS visar att uppspelningen börjar inom två sekunder från begärd position utan att
  segment 0 hämtas först.

### 6. iOS/tvOS-appen: fråga servern vad som är kodat i stället för att gissa

- **Vad:** appen gissar fortfarande ur bufferten (`readyGuess` i `apps/apple/Shared/SeekCore.swift`) och väntar 0,6 s
  på nästa steg vid varje spolning, även med reglaget på iPhone. Fråga `/api/stream/:id/hls/ready` medan strömmen
  spelar, som Expo-appen gör (`readyFor` i `apps/expo/src/seekcore.ts`), och vänta bara på fler steg för
  fjärrkontrollen.
- **Varför:** onödiga omstarter och väntan vid spolning på iPhone, iPad och Apple TV.
- **Filer:** `apps/apple/Shared/SeekCore.swift`, `apps/apple/Shared/Player.swift`, `test/apple-seek.test.js`,
  `test/contracts/apps.json` (anropet för iOS).
- **Klart när:** kontraktstestet har anropet för iOS, `apple-seek.test.js` jämför reglerna med Expo, och bygget i
  `apple.yml` går igenom.

### 7. Utanför hemmet: förstarta omkodningen redan vid /playback

- **Vad:** med automatisk kvalitet utanför hemmet (`d.abr` i `server/routes/playback.js`) startas ingen ffmpeg förrän
  spelaren valt steg och bett om ett segment – `st.prewarm` hoppas över när `d.abr` är sant. Förstarta steget som
  mastern listar först (det spelaren oftast börjar med).
- **Varför:** utanför hemmet är varje rundresa dyr (relä, mobilnät); start av en omkodad film är den långsammaste
  starten i dag. Kontrollera först hur mycket det ger med `test/fast-resume.test.js` och en strypt anslutning.
- **Filer:** `server/routes/playback.js`, `server/stream.js` (`prewarm`), `web/js/player/hlsconfig.js` (startsteget).
- **Klart när:** tid till första segment utanför hemmet är mätt före och efter, och steget som förstartades används
  (inte en andra ffmpeg för ett annat steg).

### 8. Apparna startar fortare: förvärmning och /playback samtidigt med titeln

- **Vad:** två saker som webben redan gör. (1) Android-appen och iOS/tvOS-appen anropar inte `/playback?warm=1` när
  fokus landar på Spela (inget `warm` i `apps/automotive` eller `apps/apple`; webben och Expo gör det med `warmPlay`).
  (2) Alla tre apparna väntar på titelns uppgifter (`/api/items/:id`, i Android också `/api/me/cinema`) innan de
  skickar `/playback` – två eller tre rundresor i följd (`Player.tsx`, `PlayerScreen.kt` vid `Api.get<Playback>`,
  `Player.swift` före `model.get("/api/items/\(itemId)/playback", …)`). Webben skickar dem samtidigt sedan 1.5.0
  (`earlyPlayback`). Kontrollera först: apparna väljer förvald undertext ur titelns spårlista före `/playback`, och
  det valet behöver då göras på servern eller efteråt.
- **Varför:** på Google TV och Apple TV står fokus på Spela en stund innan man trycker OK, och via reläet eller
  mobilnät kostar varje rundresa märkbart (kontrollera först med en mätning).
- **Filer:** `apps/expo/src/screens/Player.tsx`, `apps/automotive/app/src/main/java/net/braxhn/tv/PlayerScreen.kt`,
  `apps/apple/Shared/Player.swift`, `apps/apple/Shared/DetailView.swift`, `test/contracts/apps.json`.
- **Klart när:** kontraktet har `warm=1` för båda apparna, Expo i webbläget skickar `/playback` innan titelns svar
  kommit (som `test/web-chrome-playback.test.js` visar för webben), och bygget i GitHub Actions går igenom.

### 9. Expo-appen: hoppa över sammanfattning och eftertexter, nedräkning till nästa avsnitt

- **Vad:** spelaren har bara *Hoppa över intro* (`apps/expo/src/screens/Player.tsx`) och byter till nästa avsnitt
  först när avsnittet tagit slut. Lägg till sammanfattning och eftertexter (`recap`, `credits` i svaret) och kortet med
  nedräkning efter kontots val (`autoNext` i svaret från `/playback`), som webben (`web/js/player/autoskip.js`).
  Android- och iOS/tvOS-appen har knapparna (`skip` i `PlayerScreen.kt` och `Player.swift`) men startar nästa avsnitt
  direkt när filmen tar slut, utan nedräkning och utan att följa `autoNext` – samma regel kan tas med där.
- **Varför:** serier i följd är det barnen tittar mest på; i dag går eftertexterna till slut i Expo-appen, och den
  som stängt av *Spela nästa avsnitt automatiskt* får ändå nästa avsnitt i Android- och iOS-appen.
- **Filer:** `apps/expo/src/screens/Player.tsx`, `apps/expo/src/i18n-en.ts`.
- **Klart när:** i webbläget (Playwright, 390×844) syns knapparna vid rätt tid och nästa avsnitt startar efter
  nedräkningen; `test/expo-i18n.test.js` är grön.

### 10. Skärmtiden i apparna: tiden kvar och varningen i spelaren

- **Vad:** visa *X min kvar idag* och varningen de sista fem minuterna i spelaren i Expo-, Android- och iOS/tvOS-appen.
  Fältet `screenTime` finns i svaret på framstegsrapporten och läses redan, men bara för att stoppa
  (`Player.tsx`, `PlayerScreen.kt`, `AppModel.swift`). Mät också i Safari att paus inte räknas (skript: spela, pausa
  60 s och 10 min, läs `/api/screentime`).
- **Varför:** webben visar tiden kvar sedan 1.4.0; i apparna stoppas barnet fortfarande utan förvarning.
- **Filer:** `apps/*` (spelarna), `server/screentime.js` bara om mätningen visar fel.
- **Klart när:** varningen syns i apparna (Expo i webbläget, de andra byggda i GitHub Actions), och tio minuters paus
  ger högst en halv minut i Safari.

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
- Album för offline skapar en medietoken per spår vid varje anrop (`/api/music/albums/:aid/offline` i
  `server/routes/music.js`); ett album över 300 spår tappar de första spårens token. En token per album vore lättare.
- Takten på `/direct` för profiler med skärmtid är inte provad med riktiga appar (AVPlayer, ExoPlayer, Chromecast,
  AirPlay) och inte genom startcachen (`server/pace.js`).

**Från arbetspasset 2026-11-27 (sett men inte gjort)**
- Fortsätt titta mitt i en fil med lång GOP: omkodningen börjar på en jämn sekund och ffmpeg avkodar från nyckelbilden
  före (upp till en hel GOP, ~0,1 s per sekund HEVC 1080p). Att lägga B på nyckelbilden före `hs` när nyckelbilderna är
  kända sparar det – kontrollera först med en riktig film (testfilerna har 2 s GOP).
- Spolning i en omkodning laddar om strömmen: under ~1 s visar tidslinjen 0:00 och "Förbereder…" (videoelementet kopplas
  om). Positionen kunde visas från målet medan den nya strömmen startar (`load()` i `web/js/player/video.js`).
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

## Klart

Nyast först, grupperat efter utgåva. Detaljerna står i [CHANGELOG.md](../CHANGELOG.md).

### Ej utgiven

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

- **iPhone (Safari):** börja på en film, stäng, öppna igen – fortsätter den på rätt ställe direkt? Spola långt fram i
  en film som kodas om och säg ungefär hur länge det tar innan bilden kommer.
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
