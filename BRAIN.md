# BRAIN.md – semantiskt minne för BraXhn TV

Läses i början av varje session, före CLAUDE.md:s detaljer. Två delar: **Wisdom** (generella frön, gistens schema)
och **Topologi** (kartan över just den här koden). Uppdateras när kartan ändras – i samma commit som ändringen.

## Wisdom

Schema: ett frö är under 12 ord utan förbehåll (komprimerat), gäller i andra domäner (generativt), att ignorera
det ger ett namngivet fel (falsifierbart) och det kan vecklas ut till ett helt resonemang (dekomprimerbart).
Skrivs efter ett misslyckande under press, ett tydligt lyckat resultat eller en återkommande insikt.

> En etikett får aldrig lova mer än bitarna bär.
- **Mönster:** H.264 i 8 bitar märktes PQ/BT.2020 → iPhone vägrade avkoda (0.9.1).
- **Används när:** metadata, färgtaggar, MIME-typer, CODECS, versionsnummer, API-fält.

> Egenskaper som passerar en gräns ska anges, inte ärvas.
- **Mönster:** NVDEC-bilder tappade färginfo → zscale stannade (0.9.3).
- **Används när:** ffmpeg-filter efter hwaccel, data mellan processer, kontext över async-gränser.

> Allt webbläsaren behåller måste bära version.
- **Mönster:** ny HTML + cachad gammal stilmall → trasig layout (0.8.2).
- **Används när:** statiska filer, service worker, bilder, API-svar med cache.

> Klassa fel efter orsak, inte efter ord i felet.
- **Mönster:** "Generic error in an external library" från zscale stängde av NVENC (0.9.3).
- **Används när:** automatiska reservvägar, återförsök, larm.

> Det som CI inte kör är där produktionen går sönder.
- **Mönster:** alla regressioner i oktober låg i Safari/GPU/HDR – inget av det fanns i CI.
- **Används när:** prioritering av tester, bedömning av hur säker en ändring är.

> Segment som sätts ihop måste mötas utan överlapp.
- **Mönster:** B-bilder gav DTS bakåt mellan TS-segment → Chrome "formatet stöds inte".
- **Används när:** HLS/DASH, loggrotation, tidsserier, paginering.

## Topologi

### Ankare (hög centralitet – ändra med störst försiktighet)
| Ankare | Roll | Importeras av |
|---|---|---|
| `server/db.js` | SQLite (node:sqlite), migrationer på `user_version` + `addCol`, `get/all/run/tx`, inställningar, säkerhetskopia före uppgradering | 49 moduler |
| `server/util.js` | `send()` (gzip, ETag), `fail`, `readJson`, IP/proxy (`clientIp`, `isLocalReq`, `isPrivate`), `streamFile` | 27 |
| `server/http/router.js` | **Säkerhetsmodellen**: `route()` + `pub/user/admin/media/img/audio`, `scope` för mediatoken, betrott nät, CSRF, CORS för `/api/stream/` | 10 |
| `server/stream.js` | Uppspelningsbeslut (`decide`), HLS-sessioner, ffmpeg (remux/omkodning/HW), nyckelbilder, undertexter | 12 |
| `server/scanner.js` | Skanning + bakgrundsanalys, TMDB-matchning, raderingsskydd | 10 |
| `web/js/core.js` | `$`, `esc()`, `api()`, `toast`, `store`, `views`, inloggningsläge – importerar inget | 35 |
| `web/js/router.js` | `boot()`/`route()` med navigeringsgeneration, skalet | 14 |

### Broar (där tillståndet bor – båda sidor måste vara kartlagda före ändring)
1. **Webb ↔ server** (`web/js/*` ↔ `server/routes/*`): JSON över `/api`. Cookie (`__Host-kt`/`kt`), sameOrigin-krav på icke-GET. Webben och servern levereras i samma image → kan ändras tillsammans.
2. **Appar ↔ server** (`apps/apple`, `apps/automotive` ↔ `/api/*`): Bearer-token (`kind=app`). iOS-appen skickar `nhls=1` (AVPlayer = Safaris HLS-spelare), tvOS inte (ej verifierat på enhet). Apparna använder bl.a. `/api/home`, `/api/items/:id/playback`, `/api/stream/*`, `/api/music/*`, `/api/audiobooks/*`, `/api/podcasts/*`, `/api/live/*`, `/api/offline/sync`. **Installerade appar uppdateras inte med servern** → fält får bara läggas till, aldrig ändras/tas bort. Ingen API-version och inga kontraktstester ännu.
3. **Server ↔ ffmpeg/ffprobe** (`stream.js`, `scanner.js`, `pgs.js`, `subreader.js`, `trickplay.js`, `imgsize.js`, `keyframes.js`): argumentlistor via `spawn/execFile` (aldrig skal). Användarvärden når argument bara via vitlistade parametrar (`readParams`). Utdata valideras inte av ffmpeg själv – se Wisdom.
4. **HLS-spellista ↔ segment** (`servePlaylist/segmentsOf` ↔ `startFfmpeg`): playlistens EXTINF måste exakt motsvara ffmpegs delning. Omkodning: rutnät 0,2,4,6,12… med tvingade nyckelbilder + segment-muxer. Remux TS: förindexerade nyckelbilder (delmängd ok). Remux fMP4 (HEVC): **komplett** nyckelbildslista krävs (en GOP per segment).
5. **Session ↔ ffmpeg-process** (`sessions`-map i `stream.js`): nyckel = användare+titel+läge+kvalitet+ljud+pid. Strypning (SIGSTOP), trimning bakåt (`trimBehind`), städning efter 60 s/15 min. `highestFile` måste räkna från `trimmed`.
6. **Skanner ↔ databas**: rader matchas på sökväg; `adoptRenamed` flyttar framsteg vid omdöpning; raderingsskydd (saknad mapp, tom mapp, >50 % borta).
7. **Webbläsarens cache ↔ server**: `/app.js?v=`, `/style.css?v=` (versionen ur package.json), `no-cache`+ETag för appens filer, service worker `CACHE` + `MODULES`-lista (test kontrollerar).
8. **CI ↔ Unraid**: push → `:edge`; Actions-knapp → `:latest`/`:beta` + release. Röktest av imagen före publicering.

### Invarianter (bryts de blir det fel – testa dem)
- All servertext i HTML går genom `esc()`.
- Admin-routes kräver betrott nät; mediatoken gäller bara sin titel (`scope`).
- Barnprofilers åldersgräns (`allowedFor`) kontrolleras på varje route som rör en titel – även bilder och kortåtgärder.
- Omkodad video: H.264, yuv420p, inga B-bilder, BT.709-märkt; HDR-källa tonmappas alltid vid omkodning.
- Native HLS (Safari/iOS-appen) får aldrig AC-3/E-AC-3 i TS – inte heller surround som konverteras.
- Omkodat ljud börjar aldrig före bilden (`transcodeAudio`); utan det överlappar första segmentet nästa.
- Skannrar tar aldrig bort innehåll när biblioteket ser borttappat ut.
- Inga npm-beroenden; tredjepartsfiler bara i `web/vendor` med checksumma.
- `/api`-fält som apparna läser ändras aldrig bakåtinkompatibelt.

### Öppna frågor och kända luckor
- **API-kontrakt mot apparna** saknas (versionering + test). Nya fält i 0.9 (`bw`, `save`, `ab`, `sbw`, `imageSubs`, `seasons`) är tillägg – men apparna skickar inte `bw` och får därför ingen bandbreddsanpassning.
- **Testsamling** (`test/conformance.test.js`, `test/media/`, `docs/testsamling.md`): 20 syntetiska källor × 8 klientprofiler, kontrollerar HLS objektivt (EXTINF, DTS, IDR, färgmärkning, ljud). Snabb del i `npm test`, hela med `CONFORMANCE=full`; macOS-jobb spelar med AVPlayer och WebKit i CI. **Kan inte:** riktig iPhone-hårdvara, HDR-skärm, riktig Dolby Vision (RPU), GPU.
- **fMP4-remux av HEVC med öppen GOP**: ffmpegs HLS-muxer ger nyckelbilden fel tid (två bilder samma PTS). TODO-test. Möjlig väg: dela en vanlig fragmenterad MP4 själv.
- **TS-remux från början** förskjuts med B-bildernas fördröjning (0,08–0,2 s); efter spolning inte. Varning i sviten.
- **Dolby Vision profil 5** vid omkodning ger fel färger (ingen IPT→RGB-väg i zscale).
- **Synkron diskåtkomst** i `subtitlesOf`/`listDir` på förfrågningsvägen kan frysa servern när en arraydisk vaknar.
- **iPhone-flikmenyn** (0.9.2) är rättad på trolig orsak, inte bekräftad.
- **Produktmål:** andra ska kunna installera → i18n (allt är svenska), installationsguide, Community Apps, licens.
