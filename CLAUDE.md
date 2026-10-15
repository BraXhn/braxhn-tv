# BraXhn TV

Självhostad mediaserver (filmer, serier, musik, ljudböcker, poddar, live-TV) för Unraid/Docker, med appar för iOS/tvOS (`apps/apple`) och Android – bil och Google TV (`apps/automotive`). Ägaren skriver svenska: svara på svenska, och skriv kommentarer, UI-texter och commit-meddelanden på svenska.

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

- `server/app.js` innehåller alla routes. `handle()` längst ner är säkerhetsmodellen: route-alternativen `pub`/`user`/`admin`/`media`/`img` styr inloggning, och `scope` begränsar kortlivade mediatoken till en titel. Nya routes ska använda samma mönster, och admin-routes kräver betrott nät.
- Databasen (`server/db.js`): migrationer körs stegvis på `PRAGMA user_version`; nya kolumner via `addCol`, nya index där. `tx(fn)` för skrivningar i loopar. Frågor går via `get/all/run` (statement-cache).
- Skannrarna (`scanner.js`, `music.js`, `audiobooks.js`) tar aldrig bort innehåll när biblioteksmappen saknas, är tom eller när mer än hälften skulle försvinna – behåll det skyddet.
- Webben är ett eget SPA utan ramverk (`web/app.js`). Vyer registreras i `views`; `route()` håller koll på navigeringsgeneration så att långsamma svar inte skriver över nästa sida; timers registreras med `later()`/`onLeave()`. Allt servertext som hamnar i HTML går genom `esc()`.
- Användartexter, felmeddelanden och README är på svenska och riktar sig till en hemanvändare på Unraid.

## Leverans

Push till `main` bygger och signerar Docker-imagen `ghcr.io/braxhn/braxhn-tv` (amd64 + arm64) och bygger apparna. Nya funktioner: uppdatera `README.md` (funktionstabell, miljövariabler, "Testat och otestat") och `CHANGELOG.md`; höj versionen i `package.json` vid en ny utgåva.
