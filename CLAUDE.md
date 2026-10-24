# BraXhn TV

Självhostad mediaserver (filmer, serier, musik, ljudböcker, poddar, live-TV) för Unraid/Docker, med appar för iOS/tvOS (`apps/apple`) och Android – bil och Google TV (`apps/automotive`). Ägaren skriver svenska: svara på svenska, och skriv kommentarer, UI-texter och commit-meddelanden på svenska.

**Läs `BRAIN.md` först**: kodens topologi (ankare, broar, invarianter, öppna frågor) och lärdomar. Uppdatera den i samma commit när kartan ändras.

## Kontroll före varje commit

```bash
npm run verify && npm test
```

Testerna kräver `ffmpeg`/`ffprobe` (startas med riktiga mediafiler). Allt ska vara grönt innan push.

## Grundregler

- **Inga npm-beroenden.** Servern använder bara Nodes inbyggda moduler (Node 22+, imagen kör Node 24 LTS) (`node:sqlite`, `http`, `crypto` …) plus ffmpeg. Lös det med standardbiblioteket.
- **Tredjepartsfiler** för webben ligger i `web/vendor/` med SHA-256 i `web/vendor/checksums.json`; byts en fil ska checksumman och `VENDOR.md` uppdateras i samma commit. Inget laddas från CDN (CSP tillåter det inte).
- **Apparna kan inte byggas lokalt.** De kompileras av GitHub Actions vid push (`apple.yml`, `android-automotive.yml`). Skriv försiktig kod mot iOS/tvOS 16, Media3 1.4.1 och Compose BOM 2024.09, och kontrollera CI-körningen efter push; kompileringsfel visas som annoteringar.
- **Avsluta processer via PID.** `pkill -f <mönster>` träffar även det egna skalet.

## Arkitektur att känna till

- HTTP-delen: `server/app.js` är en tunn ingång som kopplar skannerns krokar, laddar routefilerna och startar periodisk skanning. `server/http/router.js` är säkerhetsmodellen: `route()`, route-alternativen `pub`/`user`/`admin`/`media`/`img`/`audio`/`calendar`/`subsonic` som styr inloggning, `scope` som begränsar kortlivade mediatoken till en titel, betrott nät och `handle()` (CSRF, CORS för `/api/stream/`). `server/http/static.js` serverar `web/` med CSP, `server/http/context.js` har delade hjälpare (`listItems`, `allowedFor`, `mediaItem`, `screenBlock` …).
- Routes ligger i `server/routes/` per område (`auth`, `admin`, `setup`, `library`, `collections`, `search`, `music`, `subsonic`, `playback`, `social`, `books`, `integrations`, `livetv`, `calendar`) och registreras med `route()` från routern. Första matchande route vinner, i den ordning `app.js` importerar filerna: lägg mönster som kan överlappa i samma fil och i rätt ordning. Routefiler importerar bara från `http/` och serverns moduler, aldrig från varandra. Admin-routes kräver betrott nät.
- Databasen (`server/db.js`): migrationer körs stegvis på `PRAGMA user_version`; nya kolumner via `addCol`, nya index där. `tx(fn)` för skrivningar i loopar. Frågor går via `get/all/run` (statement-cache).
- Skannrarna (`scanner.js`, `music.js`, `audiobooks.js`) tar aldrig bort innehåll när biblioteksmappen saknas, är tom eller när mer än hälften skulle försvinna – behåll det skyddet.
- Webben är ett eget SPA utan ramverk och utan byggsteg: inbyggda ES-moduler. `web/app.js` är bara startmodulen (importerar allt och startar). `web/js/core.js` (importerar inget) har `$`/`$$`, `esc()`, `api()`, `toast`, `store`, `fmt*`, `views`, inloggningsläget (`me`, `libs`) och navigeringsgenerationen med `later()`/`onLeave()`; `js/router.js` har `boot()`/`route()` och skalet (meny, sök, installation). Vyer ligger i `js/views/*.js` och registreras i `views`; spelaren i `js/player/` (video, kontroller, undertexter/PGS, live, Chromecast, watch party, mini-spelare/Bakåt i `overlay.js`); ljudspelaren i `js/audio.js`; kort och ikoner i `js/ui/`. `route()` håller koll på navigeringsgeneration så att långsamma svar inte skriver över nästa sida. Allt servertext som hamnar i HTML går genom `esc()`.
  - Importerade `let` kan inte tilldelas i andra moduler – ändra via funktioner i ägarmodulen (t.ex. `setLogin`, `setMe`, `setLibs`). Kod som körs när en modul laddas får bara använda `core.js` (cirkulära importer annars).
  - Ny modul: importera den i `app.js` (om den registrerar vyer; en sällan använd vy märks i stället `// @lazy` och läggs i `LAZY` i `js/router.js` – då laddas den vid behov och ingen startmodul får importera den) och lägg in den i `MODULES` i `web/sw.js` och höj `CACHE` (ett test kontrollerar listan).
  - Gemensamma gränssnittsbitar i `js/ui/` – använd dem i stället för egna varianter: dialoger (`dialog.js`, aldrig `confirm()`/`prompt()`/`alert()`), tomt/fel/laddning (`states.js`), `toast`/`toastErr` med ev. Ångra (`core.js`), ikonknappar med namn (`buttons.js`), flikar (`tabs.js`), meny/popover/snabbmeny (`menu.js`), kort med ⋮-meny (`cards.js`, `cardmenu.js`). API, exempel och riktlinjer (fokus, TV, telefon): `docs/ui-komponenter.md`.
- Användartexter, felmeddelanden och README är på svenska och riktar sig till en hemanvändare på Unraid.

## Leverans

Push till `main` bygger och signerar Docker-imagen `ghcr.io/braxhn/braxhn-tv` (amd64 + arm64) och bygger apparna. Nya funktioner: uppdatera `README.md` (funktionstabell, miljövariabler, "Testat och otestat") och `CHANGELOG.md`; höj versionen i `package.json` vid en ny utgåva.
