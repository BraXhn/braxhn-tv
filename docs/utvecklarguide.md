# Utvecklarguide

BraXhn TV är en självhostad mediaserver (filmer, serier, musik, ljudböcker, poddar, live-TV) för Unraid/Docker, med
appar för iOS/tvOS (`apps/apple`) och Android – bil och Google TV (`apps/automotive`). Projektet är på svenska:
kommentarer, texter i gränssnittet och commit-meddelanden skrivs på svenska.

Läs [arkitektur.md](arkitektur.md) före större ändringar. Där finns kodens karta (ankare, broar, invarianter, öppna
frågor) och lärdomar från tidigare buggar. Ändras kartan uppdateras den i samma commit.

## Kontroll före varje commit

```bash
npm run verify && npm test
```

Testerna kräver `ffmpeg`/`ffprobe` (de startar riktiga mediafiler). Allt ska vara grönt innan push. Hela sviten tar
runt 30 minuter; kör en enskild fil medan du arbetar (`node --test test/x.test.js`).

## Grundregler

- **Inga npm-beroenden.** Servern använder bara Nodes inbyggda moduler (Node 22+, imagen kör Node 24 LTS) (`node:sqlite`, `http`, `crypto` …) plus ffmpeg. Lös det med standardbiblioteket.
- **Tredjepartsfiler** för webben ligger i `web/vendor/` med SHA-256 i `web/vendor/checksums.json`. Byts en fil uppdateras checksumman och `VENDOR.md` i samma commit. Inget laddas från CDN (CSP tillåter det inte).
- **Apparna går inte att bygga lokalt.** De kompileras av GitHub Actions vid push (`apple.yml`, `android-automotive.yml`). Skriv försiktig kod mot iOS/tvOS 16, Media3 1.4.1 och Compose BOM 2024.09 och titta på CI-körningen efter push – kompileringsfel visas som annoteringar.
- **Avsluta processer via PID.** `pkill -f <mönster>` träffar även det egna skalet.

## Arkitektur i korthet

- HTTP-delen: `server/app.js` är en tunn ingång som kopplar skannerns krokar, laddar routefilerna och startar periodisk skanning. `server/http/router.js` är säkerhetsmodellen: `route()`, route-alternativen `pub`/`user`/`admin`/`media`/`img`/`audio`/`calendar`/`subsonic` som styr inloggning, `scope` som begränsar kortlivade mediatoken till en titel, betrott nät och `handle()` (CSRF, CORS för `/api/stream/`). `server/http/static.js` serverar `web/` med CSP, `server/http/context.js` har delade hjälpare (`listItems`, `allowedFor`, `mediaItem`, `screenBlock` …).
- Routes ligger i `server/routes/` per område (`auth`, `admin`, `setup`, `library`, `collections`, `search`, `music`, `subsonic`, `playback`, `social`, `books`, `integrations`, `livetv`, `calendar`) och registreras med `route()` från routern. Första matchande route vinner, i den ordning `app.js` importerar filerna: lägg mönster som kan överlappa i samma fil och i rätt ordning. Routefiler importerar bara från `http/` och serverns moduler, aldrig från varandra. Admin-routes kräver betrott nät.
- Databasen (`server/db.js`): migrationer körs stegvis på `PRAGMA user_version`; nya kolumner via `addCol`, nya index där. `tx(fn)` för skrivningar i loopar. Frågor går via `get/all/run` (statement-cache).
- Skannrarna (`scanner.js`, `music.js`, `audiobooks.js`) tar aldrig bort innehåll när biblioteksmappen saknas, är tom eller när mer än hälften skulle försvinna – det skyddet ska finnas kvar.
- Webben är ett eget SPA utan ramverk och utan byggsteg: inbyggda ES-moduler. `web/app.js` är bara startmodulen (importerar allt och startar). `web/js/core.js` (importerar inget) har `$`/`$$`, `esc()`, `api()`, `toast`, `store`, `fmt*`, `views`, inloggningsläget (`me`, `libs`) och navigeringsgenerationen med `later()`/`onLeave()`; `js/router.js` har `boot()`/`route()` och skalet (meny, sök, installation). Vyer ligger i `js/views/*.js` och registreras i `views`; spelaren i `js/player/` (video, kontroller, undertexter/PGS, live, Chromecast, watch party, mini-spelare/Bakåt i `overlay.js`); ljudspelaren i `js/audio.js`; kort och ikoner i `js/ui/`. `route()` håller koll på navigeringsgeneration så att långsamma svar inte skriver över nästa sida. All servertext som hamnar i HTML går genom `esc()`.
  - Importerade `let` kan inte tilldelas i andra moduler – ändra via funktioner i ägarmodulen (t.ex. `setLogin`, `setMe`, `setLibs`). Kod som körs när en modul laddas får bara använda `core.js` (annars blir det cirkulära importer).
  - Startens moduler är det `app.js` importerar statiskt (hela kedjan) – bara startsidan; servern förladdar dem och `test/web-perf.test.js` håller mängden liten. Ny vy: märk modulen `// @lazy` och lägg vyerna i `LAZY` i `js/router.js` (laddas vid behov, i förväg vid pekare/fokus på en länk dit) – ingen startmodul får importera den statiskt. Startmoduler når spelaren och ljudspelaren bara via fasaderna i `js/lazy.js` (`startPlay`, `curPlayer`, `closeAllPlayers`, `stopAudio` …) och annat som laddas vid behov med `need('ui/x.js')`, aldrig med en statisk import. Nya moduler läggs in i `MODULES` i `web/sw.js` (ett test kontrollerar listan).
  - Gemensamma gränssnittsbitar finns i `js/ui/` – använd dem i stället för egna varianter: dialoger (`dialog.js`, aldrig `confirm()`/`prompt()`/`alert()`), tomt/fel/laddning (`states.js`), `toast`/`toastErr` med ev. Ångra (`core.js`), ikonknappar med namn (`buttons.js`), flikar (`tabs.js`), meny/popover/snabbmeny (`menu.js`), kort med ⋮-meny (`cards.js`, `cardmenu.js`). API, exempel och riktlinjer (fokus, TV, telefon): [ui-komponenter.md](ui-komponenter.md).
- Texter i gränssnittet, felmeddelanden och README är på svenska och skrivna för en hemanvändare på Unraid.

## Leverans

Push till `main` bygger och signerar Docker-imagen `ghcr.io/braxhn/braxhn-tv` (amd64 + arm64) och bygger apparna.
Nya funktioner: uppdatera `README.md` och `README.en.md` (funktionsöversikt och miljövariabler – ett test kontrollerar
att båda listar samma variabler), [funktioner.md](funktioner.md), [testat.md](testat.md) och `CHANGELOG.md`;
höj versionen i `package.json` vid en ny utgåva.

## Ge ut en ny version

1. Höj `"version"` i `package.json` (t.ex. `1.0.0`).
2. Döp om `## Ej utgiven` överst i `CHANGELOG.md` till `## 1.0.0 – ÅÅÅÅ-MM-DD` och lägg en ny, tom `## Ej utgiven` ovanför. Pusha.
3. *Actions → Bygg och publicera Docker-image → Run workflow* och välj `latest` (eller `beta`). Bygget kör hela testsviten, röktestar imagen (start, användare 99:100, avstängning med `docker stop`), publicerar `:latest` och `:1.0.0`, signerar imagen och skapar en GitHub-release med avsnittet ur ändringsloggen – den texten visar servrarna under *Ny version finns*. Bygget stoppas om versionen redan är utgiven eller om ändringsloggen saknar avsnittet för versionen.

## Skicka in mallen till Community Applications (en gång)

Mallarna `braxhn-tv.xml` och `braxhn-tv-nvidia.xml` i repots rot följer Community Applications format (engelsk beskrivning med en svensk rad, kategorierna *MediaServer:Video* och *MediaServer:Music*, ikonen `unraid/braxhn-tv.png`, taggarna latest/beta/edge) och kontrolleras av `test/distribution.test.js`.

1. **Supporttråd:** skapa en tråd i forumet *Docker Containers* på [forums.unraid.net](https://forums.unraid.net) (t.ex. *[Support] BraXhn TV*) med en kort beskrivning, länk till repot och hur man rapporterar fel. Ändra sedan `<Support>` i båda mallarna till trådens adress (i dag: GitHub Issues).
2. **Mallrepo:** Community Applications läser mallarna direkt ur ett publikt GitHub-repo – det här, eller (vanligast) ett eget litet mallrepo som bara innehåller de två XML-filerna. Byter du repo: ändra `<TemplateURL>` i mallarna till det nya repots adress.
3. **Ansökan:** följ instruktionerna i Community Applications egen tråd på forumet om hur man skickar in mallar, och ange mallrepot och supporttråden. Imagen måste vara publik – kontrollera på GitHub under *Packages → braxhn-tv → Package settings* att paketet är *Public*.
4. Efter godkännandet syns appen i fliken **Apps**. Ändringar i mallarna som pushas till `main` hämtas av Community Applications av sig själva.
