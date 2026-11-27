# BraXhn TV jämfört med andra

Så här står BraXhn TV sig i version 1.5.0 (november 2026), sett från en svensk barnfamilj som kör Unraid, har ett stort
bibliotek med mycket svenska barnprogram och tittar på TV:n, iPaden, telefonen och i webbläsaren – ibland utanför
hemmet. Jämförelsen bygger på koden, [CHANGELOG.md](../CHANGELOG.md) och avsnittet *Testat och otestat* i
[README.md](../README.md), inte på marknadsföring. De andra: Plex Media Server med Plex Pass, Jellyfin 10.10, Emby
med Premiere, Infuse på Apple TV, Plexamp och Spotify för musik och Audiobookshelf för ljudböcker och poddar.

Det viktigaste först: **servern och webben är långt komna, apparna är byggda men nästan inte provade på riktiga
enheter.** Det mesta som saknas jämfört med Plex och Jellyfin handlar om appar – var de finns, hur de installeras och
hur mycket de har provats.

## Där BraXhn TV redan är bäst

| Område | BraXhn TV | De andra |
|---|---|---|
| Barn och familj | Barnprofiler med svensk åldersgräns och PIN, **skärmtid** som servern upprätthåller (minuter, klockslag per veckodag, extra tid) och som Expo- och Android-appen följer även utan nät, **familjefilter** (svordomar tystas och textas om), **Föräldraöversikt** var som helst ifrån (vad barnen tittar på just nu, *Stoppa*, ge eller dra av tid) | Plex: Plex Home och åldersgräns, ingen skärmtid. Jellyfin och Emby: åtkomstschema och åldersgräns, ingen översikt, inget filter |
| Svenska titlar | Matchning provad mot svenska DVD-rippar, julkalendrar, dubbad barnfilm och tecknat, och serier som matchats fel rättar sig själva | Bra på engelska namn, sämre på svenska titlar utan år |
| Titta tillsammans | Titta tillsammans, **Kvällsvalet** (hushållet röstar fram filmen), *Spela på…* mellan egna enheter | Plex: Watch Together i vissa appar. Jellyfin: SyncPlay. Emby: inget inbyggt |
| Start och spolning | Omkodade filmer visar första bilden på 0,7–1,0 s och spolning långt fram på 0,9–1,1 s (Chrome, 1080p, 4 kärnor – uppmätt, se CHANGELOG 1.5.0). Strömmen förvärms när pekaren eller fokus hamnar på Spela, och **Snabbstart** lägger början av troliga titlar på cache-poolen medan arraydisken sover. Uppspelningsvakten i riktig Chrome stoppar en utgåva som hackar | Inget motsvarande till sovande Unraid-diskar hos de andra. Deras starttider är inte uppmätta här |
| Unika funktioner | Repliksökning, språkinlärning med två undertexter, *Ögonblick* (klipp att dela inom hushållet), *Det här har hänt* ur egna filer, hälsokontroll av biblioteket, diskrådgivaren (koda om till HEVC/AV1 säkert) | Finns inte |
| Webben | Fungerar offline, styrs med fjärrkontroll i TV-webbläsare, WCAG 2.2 AA, svenska och engelska, feedback direkt i appen som administratören granskar först | Plex Web och Jellyfin Web kräver nät och mus |
| Gratis och eget | Allt utan konto, moln eller prenumeration – hårdvaruomkodning, DVR, nedladdning, fjärråtkomst via eget relä | Plex Pass krävs för hårdvaruomkodning, nedladdning och (sedan 2025) uppspelning utanför hemmet. Emby Premiere för de flesta appar. Jellyfin är gratis |
| Live-TV | HDHomeRun och IPTV (M3U, Xtream), TV-guide, catch-up, timeshift, inspelningar med regler och reklamhopp | I nivå med Plex DVR och Jellyfin; Channels DVR har bättre appar |

## Där vi är i nivå

- **Fjärråtkomst utan portöppning.** BraXhn Relay gör som Plex fjärråtkomst: servern ansluter ut till ett relä, och
  webben, apparna, bilen och Chromecast når den där. Skillnaden: Plex driver reläet åt dig (med låg bithastighet),
  här kör du det själv på en VPS, och all video går två gånger genom den. Jellyfin och Emby har inget relä alls.
  Hemma använder apparna serverns adress på hemnätet direkt, som Plex.
- **Musik.** Glapplöst, övertoning, jämn ljudnivå, låttexter, låtradio från egen ljudanalys, scrobbling och ett
  Subsonic-API för Symfonium, Amperfy och andra. Det motsvarar Plexamp i webben. Spotify har förstås katalogen, vi
  bara det du äger.
- **Ljudböcker och poddar.** Kapitel, bokmärken, hastighet, sovtimer, poddar som hämtas av sig själva, ett privat
  flöde till poddappen och e-böcker och serier via OPDS – i nivå med Audiobookshelf på servern och i webben.
- **Bild och ljud på TV:n.** Google TV-appen skickar Dolby/DTS/TrueHD orört till förstärkaren, spelar HDR och Dolby
  Vision när TV:n klarar det och byter bildfrekvens, som Kodi och Infuse. Windows-appen spelar originalfiler i mpv.
  Inget av det är provat på en riktig TV eller dator än.

## Det som saknas eller är sämre

Rangordnat efter nyttan för familjen. *Kontrollerat i koden* = sökt efter och inte hittat.

1. **Appar i butikerna och på alla TV-apparater.** Appen för iPhone, iPad och Apple TV byggs med Xcode och finns inte i
   App Store; Android-appen (telefon, Google TV, bil) installeras som APK från GitHub Actions; Expo-appen körs i
   Expo Go. På Samsung och LG, Roku, Fire TV och spelkonsoler finns bara webbläsaren och DLNA. Plex, Jellyfin och Emby
   har appar nästan överallt. Störst lucka – och den löses inte i koden utan med konton och granskning hos Apple och
   Google.
2. **Apparna är inte provade på riktiga enheter.** Spolning, nedladdning, hemadressen, feedback och engelska är byggda
   och kontrollerade mot serverns svar, men inte körda på en riktig iPhone, Android-telefon, Apple TV, Google TV eller i
   en bil. Plex och Jellyfin har år av användare bakom sina appar.
3. **Nedladdning och offline i alla appar.** Expo-appen laddar ner filmer, avsnitt och ljudböcker; Android-appen och
   appen för iPhone och iPad bara filmer och avsnitt, och iPhone-appens nedladdningar gäller ännu inte per profil
   (*Kontrollerat i koden*, se backloggen). Poddar går inte att ladda ner i någon app. Audiobookshelf, Plexamp och
   Infuse har allt detta.
4. **Musik i apparna.** Expo-appen och bilen spelar musik, men låsskärmen saknar nästa/föregående låt i Expo-appen och
   låttexter saknas i alla appar (*Kontrollerat i koden*). Plexamp är klart bättre i telefonen; Symfonium och Amperfy
   via Subsonic-API:t är i dag det bästa sättet att lyssna i mobilen, även offline och i CarPlay (Amperfy).
5. **CarPlay.** Android Auto finns, CarPlay kräver ett tillstånd från Apple och är inte byggt.
6. **Bästa bild på Apple TV.** Infuse spelar nästan allt orört med Dolby Vision och TrueHD/Atmos. Apple TV-appen går
   via Apples spelare och servern, så en del filer remuxas eller kodas om. Infuse kan spela från BraXhn TV via DLNA (när
   det är påslaget), men utan profiler, skärmtid och framsteg.
7. **Automatiska undertexter (tal till text).** Varken Plex, Jellyfin eller Emby har det inbyggt (Jellyfin via
   tillägg). Kräver en taligenkänningsmodell – går inte utan beroenden. *Kontrollerat i koden:* saknas.
8. **Ansiktsigenkänning i foton** (Plex har det) och **röststyrning** med Alexa eller Google Assistant (Plex). Webhooks
   och API-nycklar finns för Home Assistant. *Kontrollerat i koden:* saknas. Låg nytta här.
9. **Tilläggssystem** (Jellyfin). Medvetet bortvalt – inga beroenden, allt i en image.

Det som stod här förut och nu finns: fjärråtkomst utan portöppning (BraXhn Relay), apparna (inte längre pausade),
sovtimer i videospelaren (1.4.0) och Föräldraöversikten.

Små skillnader som inte är luckor: Plex Discover och den universella bevakningslistan motsvaras av *Strömmande* och
Trakt; Tautulli motsvaras av *Tittarstatistik*; tittarhistoriken från Plex och Jellyfin kan importeras och synkas,
så att flytten inte börjar från noll.

Vad teamet gör åt luckorna står i [backlog.md](backlog.md).
