# API:t mot apparna

iOS/tvOS-appen (`apps/apple`) och Android-appen (`apps/automotive`) använder samma `/api` som webben, med
apptoken i `Authorization: Bearer …` (inloggning med `"app": true`) och kortlivade medie- och bildtoken i
`?t=` för strömmar och bilder. Webben levereras med servern, men **installerade appar uppdateras inte när servern
uppdateras**. En app från i våras ska fungera mot nästa års server.

## Version

`GET /api/status` har fältet `api` (heltal, nu `1`). Det höjs bara om något som installerade appar läser måste
ändras på ett sätt som inte går att lösa med ett tillägg. Det har inte hänt än, och det ska undvikas.

**Inom samma version får fält och endpoints bara läggas till:**

- Ett fält som någon app läser får inte tas bort, byta namn eller byta typ. Det gäller även `null` där appen
  kräver ett värde och heltal som blir decimaltal (Swift `Int` och Kotlin `Int`/`Long` avkodar inte `1.5`), och
  `true`/`false` som blir `0`/`1`.
- Relativa adresser (`url`) börjar med `/api/`. Appen lägger själv till serveradressen, och för musikspår även
  `&a=…`, så de adresserna måste redan ha en `?`-del.
- Behövs en annan form: lägg till ett nytt fält bredvid det gamla (som `seasons` bredvid `items` i `/api/home`, eller `upcoming` för hyllan *Kommer snart*)
  och behåll det gamla så länge appar som läser det kan vara installerade.
- Appar ignorerar okända fält (Swift `Decodable`, Kotlin `ignoreUnknownKeys`), så tillägg är alltid säkra.
- Nya frågeparametrar ska vara valfria. Utan dem ska svaret vara som förut.

Om en ny version ändå behövs: lägg den bakom en parameter (t.ex. `?api=2`) eller en ny sökväg och fortsätt svara
som version 1 utan den. Låt apparna läsa `api` från `/api/status` innan de använder det nya.

## Bio-läge: `preroll` i `/api/items/:id/playback`

Med `cinema=1` (och utan `start`, eller `start` under 1 s) får svaret för en **film** fältet `preroll` när
användaren slagit på bio-läget under *Mitt konto* (`GET`/`PUT /api/me/cinema`, `{ trailers: 0–3, preroll: bool }`).
Utan `cinema=1`, för avsnitt, vid fortsättning eller när bio-läget är av saknas fältet helt – svaret är som förut.

```json
"preroll": [
  { "kind": "trailer", "itemId": 12, "trailerId": 3, "title": "Andra", "url": "/api/trailers/3/stream?t=…", "mime": "video/mp4", "duration": 132.5 },
  { "kind": "preroll", "itemId": null, "title": "Förfilm", "url": "/api/cinema/preroll/0/stream?t=…", "mime": "video/mp4", "duration": 12 }
]
```

- Spela posterna i ordning före `url`, med möjlighet att hoppa över en eller alla. `itemId` (bara trailers) är filmen
  trailern hör till – visa gärna "finns i biblioteket" med en länk till `/api/items/:itemId`.
- `url` är filen som den är (ingen omkodning): spelaren måste klara formatet, annars hoppar den till nästa post.
- Med Bearer-token eller `cast=1` har varje `url` en egen mediatoken som bara gäller den trailern eller förfilmen.
- `duration` (sekunder, decimaltal) kan vara `null` om filen inte gick att läsa – läs den som `Double?`.
- När `preroll` finns förstartar servern inte filmen. Hämta gärna `/playback` igen (utan `cinema=1`) när kön är slut,
  annars startar omkodningen först när spelaren börjar hämta filmen.

## Uppspelningsval per konto: `/api/me/playback-prefs`

`GET`/`PUT /api/me/playback-prefs` (PUT ändrar bara fälten som skickas):

```json
{ "audioLangs": ["sv", "en", "orig"], "subMode": "foreign", "subLangs": ["sv"], "sdh": "avoid",
  "skipIntro": true, "skipRecap": false, "skipCredits": false, "autoNext": true, "nextCountdown": 8,
  "qualityHome": "auto", "qualityRemote": "720", "autoSync": true, "saved": true, "remoteCap": "1080" }
```

- Språk är ISO 639-1 (`sv`, `en`); trebokstavskoder (`swe`) tas emot och skrivs om. `orig` i `audioLangs` = filens
  standardspår (originalspråket i de flesta filer). Kommentarsspår och ljudbeskrivning väljs aldrig automatiskt.
- `subMode`: `off` (inga), `forced` (bara tvingade), `foreign` (hela undertexter när ljudet inte är på något av mina
  språk – `subLangs` och `audioLangs` – annars tvingade), `always`. `sdh`: `avoid` eller `prefer`.
- `qualityHome`/`qualityRemote`: `auto`, `orig`, `1080`, `720`, `480`, `360`. Gäller när klienten inte skickar `q`;
  utanför hemmet aldrig över administratörens tak (`remoteCap`). `saved` = valen har sparats någon gång.

`/api/items/:id/playback` använder valen när klienten inte själv valt (inga ändrade fält, bara tillägg):
utan `audio=` spelas det föredragna ljudspåret, utan `q` (eller `q=auto`) gäller standardkvaliteten. Nya fält:
`defaultAudio` (spårets `index` eller `null`), `defaultSub` (ett `id` i `subtitles` eller `null` – visa den från
början om appen inte har ett eget val), `autoSkip` (`{ intro, recap, credits }`, bool: hoppa över automatiskt efter
en kort nedräkning; `credits` = gå till nästa avsnitt när eftertexterna börjar) och `autoNext`
(`{ enabled: bool, countdown: heltal sekunder }`). `/api/items/:id` har också `defaultAudio`/`defaultSub`, där
`defaultSub` kan vara en PGS-bildundertext (webbspelaren ritar dem själv).

Android-appen (från 0.6.0) skickar `cinema=1` bara när `GET /api/me/cinema` visar att bio-läget är på (`trailers > 0`,
eller `preroll` och `prerollAvailable`), lägger posterna först i spelarens kö och hoppar till filmen vid *Hoppa över* eller
om en trailer inte går att spela. Den skickar också `night=1`/`dialog=1` när nattläge eller tydligare dialog är påslaget.

## Google TV: ljudspår i appen och skärmens HDR-typer (`atrack=1`, `hdrt=`)

Två nya, valfria parametrar till `/api/items/:id/playback` (utan dem är beslutet som förut):

- `atrack=1`: klienten väljer ljudspår själv i en direktuppspelad fil. Ett annat spår än filens standardspår (`audio=`
  eller kontots föredragna språk) ger då `mode: "direct"` i stället för remux, så länge spårets kodek finns i `a=`.
  Klienten väljer spåret `audioSelected` i spelaren. Android-appen skickar det och listar i `a=` också `dts`/`truehd`
  när förstärkaren tar emot bitström eller enheten själv avkodar formatet.
- `hdrt=hdr10,hlg,dovi,hdr10plus`: HDR-typer som skärmen visar (gäller bara med `hdr=1`). En källa vars typ saknas
  tonmappas; Dolby Vision räcker med `hdr10` (baslagret) utom profil 5, som fortfarande kräver `dv=1`.

## Synkade undertexter: `/api/items/:id/subs/:sid/sync`

Externa och nedladdade undertextfiler kan synkas mot ljudet (`server/subsync.js`). Servern lägger själv på sparad
justering när undertexten hämtas (`/api/stream/:id/subs/:sid.vtt`, även HLS-spellistornas undertexter), så apparna
behöver inte göra något. Svaret cachas upp till 10 min (`Cache-Control: private, max-age=600`).

- Nya fält i `subtitles` i `/api/items/:id/playback`: `source` (`embedded`, `external`, `downloaded`), `syncable` (bool)
  och `sync` (`{ offset, ratio }`, bara när en justering är sparad – redan inräknad i `url`). Nytt fält `subAutoSync`
  (bool, kontots val `autoSync` i `/api/me/playback-prefs`, standard `true`).
- `GET` ger läget: `{ syncable, offset, ratio, auto: { offset, ratio, score } | null, job: null | { state, progress,
  error, result, previous } }`. Tiderna blir `t · ratio + offset` (sekunder). `state`: `queued`, `running`, `done`,
  `unsure` (ingen säker förskjutning – inget ändrat) eller `error`. `result`: `{ offset, ratio, fps: { from, to } | null,
  score, confident }`; `previous` = värdena före synken (för Ångra).
- `POST` (`{ audio?: ljudspårets index, force?: bool }`) startar en synk (en åt gången på servern). Ett sparat
  automatiskt resultat för samma fil och ljudspår används direkt (`result.cached`) om inte `force` anges.
- `PUT` (`{ offset, ratio? }`) sparar en manuell justering (offset ±600 s, ratio 0,9–1,1, annars 1).
- Bara undertextfiler kan synkas: inbäddade spår ger **400**. Gäller alla konton som får se titeln.

## Repliksökning: `/api/search/lines`

`GET /api/search/lines?q=<replik>&limit=<1–60, standard 30>` (inloggad, även apptoken) söker i titlarnas
textundertexter (`server/sublines.js`). Orden måste stå i följd; sista ordet får vara början av ett ord; versaler och
skiljetecken spelar ingen roll, å/ä/ö är egna bokstäver. Bara titlar som profilen får se (bibliotek och åldersgräns).
Svar: `{ q, lines: [...], status: { enabled, indexing, fts?, titles?, lines? } }` (antalen bara för administratören).
Varje replik: `id` (filmen eller avsnittet – spela med `/api/items/:id/playback?start=`), `version` (bara när repliken
kommer från en annan filmversion), `kind`, `title` (filmen/serien), `year`, för avsnitt `episodeTitle`, `season`,
`episode`, `show`; `t`/`end` (sekunder, med undertextsynken inräknad), `line`, `marks` (`[[start, slut]]`, teckenindex
i `line`), `before`/`after` (repliken före/efter eller `null`), `lang`, `label` och `thumb` (`{ url, col, row, cols,
rows, w, h }` = rutan i ett ark från `/api/items/:id/trickplay/:n`, eller `null`). Apparna använder den inte än.

## Kö på Chromecast: `queue=1`

`/api/items/:id/playback?cast=1&queue=1` ger samma svar som vanligt (med en egen mediatoken för titeln) men räknas
inte som en uppspelning: ingen förstart av omkodningen, ingen rad under Aktivitet och ingen Trakt-start. Webben köar
nästa avsnitt så på Chromecasten; apparna kan använda det på samma sätt.

## Snabbstart: väck disken i förväg (`POST /api/items/:id/wake`)

Valfritt för apparna. `POST /api/items/:id/wake` (inloggad, samma behörighet som titeln – annars 404) läser några
kilobyte av filen i bakgrunden så att en sovande arraydisk börjar snurra upp innan användaren trycker Spela. Serie =
profilens nästa avsnitt. Svar `{ ok: true, woke }` (`woke: false` = nyss väckt, högst en gång per minut och titel,
eller snabbstarten avstängd). `/api/items/:id` (titelsidan) och `/api/items/:id/playback` väcker redan disken på
servern, så apparna behöver inte anropa den – den är till för fokus på en Spela-knapp i en lista.

Startcachen (`server/prestart.js`) är osynlig för klienterna: `/api/stream/:id/direct` svarar med samma byte och
samma rubriker (`Content-Length`, `Content-Range`, `Accept-Ranges`) oavsett om de kommer ur cachen eller filen, och
HLS-adresserna är oförändrade. Administration (betrott nät): `GET/PUT /api/ops/prestart` (`on`, `maxGb`),
`POST /api/ops/prestart/clear` och `POST /api/ops/prestart/fill`.

## Rättigheter per användare

Administratören kan begränsa ett konto eller en profil (`server/perms.js`). Inga fält har ändrats – apparna märker det
bara som att titlar saknas och att vissa anrop nekas:

- **Bibliotek:** `/api/libraries` och alla listor visar bara tillåtna bibliotek. En titel, låt, bok, bild eller ström i ett
  otillåtet bibliotek ger **403** eller **404**, precis som en titel över barnprofilens åldersgräns.
  Fotobibliotek (typen `photo`, `/api/photos/*`) är bara för webben: de listas inte i `/api/libraries` för apptoken
  (apparna känner inte till typen), och `/api/home` har fältet `photoMemories` som alltid är tomt för appar.
- **Nedladdning:** utan rätten ger `/api/stream/:id/download`, `/api/stream/:id/offline-file` och `/api/items/:id/offline`
  **403** (`Ditt konto får inte ladda ner`), och `/api/offline/sync` svarar `items: []` och lägger allt i `have` i `remove`.
  `/api/status` har `user.canDownload` (nytt fält, `Bool`).
- **Kvalitetstak utanför hemmet:** `/playback` sänker `quality` även när klienten valt kvalitet själv, och en ström över
  taket (`direct`, remux eller `q=` över taket) ger **403** utanför hemmet.
- **Samtidiga strömmar:** `/playback` (inte `info=1` eller `queue=1`) ger **403** när hushållet redan spelar så många
  andra titlar. `POST /api/stream/:id/stop` frigör platsen direkt.
- **Inbjudan:** `GET /api/invite/:token` (giltig: `{ valid, expires, homeOnly }`, annars 404) och
  `POST /api/invite/:token` med `{ name, password, app: true }` ger `{ token, user }` som `/api/login`.
## Musikmetadata: artist, album och låttexter

Bara tillägg – apparna kan läsa dem när de vill (alla kan saknas eller vara `null`):

- `GET /api/music/artists/:arid`: `image` och `backdrop` (Bool – hämta `GET /api/music/artists/:arid/image` resp.
  `/backdrop`, `?w=` och bildtoken som för omslag), `info` (`null` eller `{ bio, bioLang, bioUrl, type, begin, end, ended,
  beginArea, area, country, genres: [String], links: [{ label, url }], mbid, … }`), `related: [{ id, name, albums,
  cover_album, image, relation, source }]` och `albums[].type` (`album`, `ep`, `single`, `live`, `compilation`,
  `soundtrack`, `remix`, `other`) med `albums[].typeGuessed` (Bool).
- `GET /api/music/albums/:aid`: `type`, `typeGuessed` och `info` (`null` eller `{ description, descLang, descUrl, released, mbid, type }`).
- `GET /api/music/:lib/artists`: `image` (Bool) per artist.
- `GET /api/music/tracks/:tid/lyrics`: `source` kan nu vara `lrclib` (hämtad från nätet), och `instrumental: true` när låten saknar text.

## Bibliotekets filter: `/api/libraries/:id/items`, `/facets`, `/shuffle`

Utan nya parametrar svarar `/api/libraries/:id/items` exakt som förut (`sort` = `title`/`added`/`year`/`rating`/`date`,
`filter` = `unwatched`/`watched`, `limit`/`offset`, `collections=1`). Allt nedan är valfritt (server/libfilter.js):

- Filter (AND mellan nycklar, listor är "någon av"): `genre=A,B` (+ `genreAll=1` = alla), `yearMin`/`yearMax`,
  `ratingMin` (0–10), `durMin`/`durMax` (minuter; serier: avsnittens snittlängd), `res=sd,720,1080,4k`,
  `hdr=hdr,hdr10,dovi,hlg,sdr`, `audio=stereo,surround,atmos`, `alang=sv,en` och `slang=…` (två eller tre bokstäver),
  `filter=inprogress`, `addedDays`, `ageMax`, `coll=yes|no` (filmer), `status=ongoing|ended` och
  `seasonsMin`/`seasonsMax` (serier). Fil-egenskaperna gäller filmens fil eller en version, för serier något avsnitt.
- Eget betyg: `myRatingMin` (stjärnor 1–5 i halva steg) och `rated=yes|no` (profilen har betygsatt titeln eller inte).
- Sortering: `sort` = `title`, `year`, `rating`, `myrating` (eget betyg, titlar utan betyg sist), `added`, `lastwatched`, `duration`, `random` (+ `seed` = heltal för
  stabil ordning mellan sidor), `order=asc|desc`. Utan `order` är ordningen densamma som förut.
- Okända nycklar och ogiltiga värden ignoreras. Nya fält: `query` (filtret normaliserat som adressdel) och `total`
  (när filter eller sidindelning används; med `collections=1` räknas kort).
- `GET /api/libraries/:id/facets`: värdena som finns i biblioteket för profilen (genrer med antal, år, åldersgränser,
  upplösning, HDR, ljud, språk, samlingar/status/säsonger).
- `GET /api/libraries/:id/shuffle?<filter>`: `{ item, play }` – en slumpad titel; för serier är `play` ett avsnitt.
- Smarta samlingar: `POST/PUT /api/custom-collections` med `smart: { library, query }`; samlingen får fälten `smart`,
  `library` och `query`. `GET /api/custom-collections/:cid/shuffle` som ovan.

## Redigerad metadata: `tagline`, `logo`, `originalTitle`

`/api/items/:id` har tre nya valfria fält (bara när de finns): `tagline` (sträng), `logo: true` (bilden finns som
`/api/image/:id/logo`, PNG med genomskinlighet, skalas inte med `?w=`) och `originalTitle` (sträng). Fält som
administratören låst under *Redigera* har samma typ som förut (`genres` är en lista, `year`/`age` heltal, `rating` tal).
Redigeringen sker via admin-endpoints (`GET/PUT /api/items/:id/metadata`, `GET/POST/PUT/DELETE /api/items/:id/images/:type`)
som apparna inte behöver.
## Egna betyg, extramaterial och temamusik

Tillägg (apparna behöver inte läsa dem):

- **Egna betyg** per profil, i stjärnor 1–5 med halva steg (`server/ratings.js`, lagras som halva stjärnor 2–10).
  `PUT /api/items/:id/rating`, `PUT /api/music/albums/:id/rating` och `PUT/GET /api/music/tracks/:id/rating` med
  `{ rating }` (0/null tar bort) → `{ rating }`. Titlar i alla listor och `/api/items/:id` har `userRating` när profilen
  satt ett betyg; musikens album, albumets/artistens/spellistans/smarta listans låtar likaså. Filmversioner betygsätts
  på huvudraden. Barnprofiler betygsätter bara det de får se (annars 404). Titelbetyg skickas till Trakt
  (`/sync/ratings`, Trakts 1–10 = halva stjärnor) när kontot är kopplat, och synken skickar alla. Smarta spellistor har
  fälten `rating` (*Mitt betyg*) och `albumrating` och sorteringen `rating`. Subsonic: `setRating` (heltal 0–5) och
  `userRating` på låtar och album.
- **Extramaterial**: `/api/items/:id` har `extras: [{ id, type, group, name, size }]` (film och serie, i hyllans
  ordning). `type` = `trailer`, `featurette`, `behindthescenes`, `deleted`, `interview`, `scene`, `short`, `other`.
  Spelas som trailers: `GET /api/trailers/:id/stream` (Range; `?mp4=1` gör om filen till fragmenterad MP4 för
  webbläsare som inte klarar formatet, högst två samtidigt) och `GET /api/trailers/:id/play` → `{ url, mime }` med en
  token som bara gäller den filen. Åldersgränsen är huvudtitelns. `trailers` innehåller som förut bara trailers.
- **Temamusik**: `/api/items/:id` (film och serie) har `theme: { play }` när `theme.mp3`/`theme.m4a` finns i titelns
  mapp; `play` = profilens val (`GET/PUT /api/me/theme-music` → `{ shows, movies }`, standard på för serier, av för
  filmer). Filen: `GET /api/items/:id/theme`.

## Inspelning (DVR): regler, konflikter och titta medan den spelas in

- `GET /api/dvr` (som förut, bara tillägg): `scheduled[]` har `plan` (`ok`|`late`|`cut`|`missed`), `planText`, `watchable`
  (pågår – kan spelas), `priority`, `pad_before`/`pad_after` (s, `null` = serverns), `format`, `transcode`, `is_new`;
  `done[]` har `keep_forever`; `rules[]` har `priority`, `days` (bitmask sön=1 … lör=64), `time_from`/`time_to`
  (minuter efter midnatt), `skip_library`, `enabled`, `recorded`; nya `conflicts` (antal), `disk` (`free`, `total`,
  `used`, `upcoming` = uppskattat för kommande vecka, `bytesPerHour`) och `defaults`.
- `GET /api/dvr/conflicts` → `{ conflicts: [{ recording, outcome, text, from, to, with: [...], alternatives: [{ programId,
  channelId, channel, start, stop }] }] }` – en simulering av tunrarna (`server/dvrplan.js`).
- `POST /api/dvr/rules` och `PUT /api/dvr/rules/:id` (skaparen eller admin) med `{ title, channelId, newOnly, skipLibrary,
  keep, priority, padBefore, padAfter, days: [0–6], timeFrom: "HH:MM", timeTo, format: mp4|mkv|ts, transcode:
  auto|always|never, enabled }`; `POST /api/dvr/rules/preview` med samma fält → `{ airings: [{ programId, channel, start,
  stop, subtitle, season, episode, isNew, record, reason }] }` utan att boka. `POST /api/dvr/program` med `series: true`
  tar samma fält (och `anyChannel`).
- `PUT /api/dvr/recordings/:rid` `{ priority, padBefore, padAfter, format, transcode, keepForever }` (marginaler och format
  bara innan inspelningen börjat) och `POST /api/dvr/recordings/:rid/swap` `{ programId }` – flytta en bokning till en
  annan sändning av samma program. `POST /api/dvr/program` och `/manual` svarar även med `plan`.
- `POST /api/dvr/recordings/:rid/play`: en pågående inspelning ger `{ url: …/live.m3u8, live: true }` – HLS (EVENT) av den
  växande filen, segmenten `…/seg-NNNNN.ts` med samma token. En klar inspelning ger som förut `…/stream` (MP4, MKV eller TS).
## Offline i webbappen

Bara tillägg – apparna påverkas inte.

- `GET /api/items/:id/offline?q=src` (och `POST` med `{ q: 'src' }`): källfilen som den är, utan omkodning (`status: 'ready'`,
  `original: true`, `size`). Webbappen väljer det bara när uppspelningsbeslutet (`/playback?info=1`) säger `direct`.
  `/api/stream/:id/offline-file?q=src` serverar filen med Range och rätt `Content-Type`. Apparna skickar aldrig `src`.
- `subs=1` i `GET /api/items/:id/offline`: när filen är klar finns `subs: [{ id, lang, label, forced, url }]` – textundertexter
  (inga bild- eller kommentarsspår) som WebVTT med samma kortlivade token som filen.
- `GET /api/music/albums/:id/offline?a=<format>`: `{ id, title, artist, year, cover, duration, tracks: [{ id, title, track, disc,
  duration, artist, codec, gain, peak, url }] }` – en mediatoken per spår (scope −spårets id).
- `GET /api/audiobooks/book/:id/offline?a=<format>`: som `/play` (`files[].url` med en token för boken, `chapters`, `position`, `speed`).
- Båda kräver rätten att ladda ner (**403** annars) och användarens bibliotek (**404**).
- `at` (Unix-sekunder) i `POST /api/items/:id/progress` och `POST /api/audiobooks/book/:id/progress`: när positionen sparades
  offline. Finns ett framsteg som är nyare än `at` ändras inget och svaret har `stale: true`; annars sparas positionen med
  `updated = at`. Anrop med `at` räknas inte som "spelas nu" eller skärmtid.
## IPTV: `/api/iptv/*`

Tillägg (apparna behöver inte läsa dem; `/api/live/*` är oförändrat). Barnprofiler ser bara kanaler med en åldersgräns
inom profilens (kanalens, annars gruppens; okänd = `allow_unrated`) – det gäller nu även `/api/live/channels`,
`/api/live/guide`, `/api/live/search`, `/api/live/programs/:pid` och strömmarna `/api/live/:cid/*` (förut nekades
barnprofiler helt utan `allow_unrated`). `/api/status` → `user.iptvVod` (filmer/serier finns och får ses).

- `GET /api/iptv/channels` → `{ channels: [{ id, number, name, logo, group, hd, tuner, favorite, pinned, epgId, catchup
  (dagar, 0 = inget arkiv), radio, now, next }], groups: [{ name, count }], favorites, prestart, vod }`. `favorite` är
  per profil, `pinned` administratörens gamla favoritmarkering.
- `GET /api/iptv/epg?ids=1,2&from=&to=` (högst 300 kanaler och 26 timmar, bakåt högst 31 dagar) → `{ programs: { <kanal>:
  [{ id, start, stop, title, subtitle, category, season, episode, isNew, catchup?, reminder? }] } }`.
- `GET /api/iptv/programs/:pid` → program med `channel`, `live`, `catchup`, `reminder`, `recording`, `rule`, `airings`.
  `GET /api/iptv/search?q=` som `/api/live/search` men per profil.
- `PUT /api/iptv/favorites/:cid` `{ on }`. `POST /api/iptv/channels/:cid/prestart` (snabbt kanalbyte, bara när källan har
  en ledig anslutning). `POST|DELETE /api/iptv/programs/:pid/reminder`, `GET /api/iptv/reminders[?due=1]`.
- **Catch-up:** `POST /api/iptv/programs/:pid/catchup?offset=<s>` → `{ sid, url, token, offset, duration, start, stop }`.
  `url` = `/api/iptv/play/:sid/index.m3u8` (HLS EVENT, `?t=` mediatoken för appar/Chromecast, scope `9e9 + sid`),
  segmenten `seg-N.ts`. `GET /api/iptv/play/:sid/status`, `POST /api/iptv/play/:sid/stop`. Sessionen är profilens egen
  och stängs efter en minut utan hämtning. Spola längre än det som skrivits = nytt anrop med `offset`.
- **Filmer och serier (Xtream):** `GET /api/iptv/vod?kind=movie|series[&shelves=1|&category=|&q=|&sort=added|name|rating|year
  &offset&limit]`, `GET /api/iptv/vod/:id` (detaljer, `episodes` för serier, `progress`), bilder `GET /api/iptv/vod/:id/cover.jpg`,
  `/backdrop.jpg`, `/api/iptv/episodes/:eid/image.jpg` (bildtoken går), `POST /api/iptv/vod/:id/play[?ss=&hls=1]` och
  `POST /api/iptv/episodes/:eid/play` → `{ direct, url, hls?, token, duration, title, position }`. `direct: true` = MP4
  med Range på `/api/iptv/vod/:id/file` (scope `8e9 + id`; avsnitt `/api/iptv/episodes/:eid/file`, `8.5e9 + eid`),
  annars en HLS-session som catch-up. `POST /api/iptv/progress` `{ kind: movie|episode, id, position, duration }`.
- **Administration** (admin, betrott nät): `GET /api/iptv/admin`, `POST /api/iptv/sources` (`type: m3u|xtream`, `url` |
  `server`+`username`+`password`, `epgUrl`, `epgUrls`, `userAgent`, `referer`, `connections`, `refreshHours`,
  `allowLan`, `vod`), `PUT /api/iptv/sources/:id`, `POST /api/iptv/sources/:id/refresh[?vod=0]` (borttagning:
  `DELETE /api/live/tuners/:id`), `GET /api/iptv/admin/channels`, `PUT /api/iptv/admin/channels/:cid` (`name`,
  `number`, `group`, `logo`, `hidden`, `age`, `epgId`, `sort`; tomt/`null` = listans värde), `PUT
  /api/iptv/admin/channels/order`, `PUT /api/iptv/admin/groups` (`kind`, `name`, `hidden`, `age`, `sort` eller `order`),
  `POST|PUT|DELETE /api/iptv/guides[/:id]`, `PUT /api/iptv/settings`. Xtream-lösenordet lämnas aldrig ut; adresser
  visas maskerade.

## Kontraktstestet

`test/contracts/apps.json` beskriver för varje endpoint vad varje app skickar och vilka fält den avkodar, med
typ och om fältet är obligatoriskt. `test/api-contract.test.js` startar en server med filmer, en serie, musik,
en ljudbok, en podd och live-TV, anropar varje endpoint som apparna gör och kontrollerar svaret. Ett fel visar
endpoint, fältets sökväg, förväntad och faktisk typ och vilken app som går sönder, t.ex.:

```
GET /api/dvr – Android-appen (bil och Google TV) går sönder (apps/automotive/…/Live.kt:119)
  • svar.scheduled[1].start: förväntat integer (heltal), fick number (1792853684.939)
```

Formatet beskrivs i [test/contracts/README.md](../test/contracts/README.md).

### När en app börjar läsa något nytt

Ändra kontraktet i samma commit som appkoden:

1. Nytt fält i en `Decodable`-struct eller `@Serializable data class`: lägg till det under typens `required`
   (icke-optional i Swift, eller utan standardvärde i Kotlin) eller `optional` (`T?` i Swift, eller med
   standardvärde/`= null` i Kotlin). Uppdatera `källa` om raden flyttats.
2. Nytt anrop: lägg till endpointen under `endpoints` med `källa` (fil:rad), ev. `query`/`body` som appen
   skickar och `svar` (en typ, `null` om svaret inte läses, eller `{ "media": "^audio/" }` för strömmar och
   bilder). Lägg sedan till hur anropet provas i `CASES` i testet. Testet misslyckas om de två listorna inte
   stämmer överens.
3. Kör `npm test`. Om testet varnar att en typ aldrig förekom i något svar behöver testbiblioteket fler data
   (`before()` i testet).

Ett obligatoriskt fält i en ny appversion är bara säkert om alla servrar som kan köra appen redan skickar det.
Välj valfritt (med standardvärde) om du är osäker. Det gäller också för fält som läggs till i servern samtidigt.

### Valfria tillägg som iOS/tvOS-appen läser

- Startsidans nyare hyllor i `/api/home` (`watchlist`, `recommended`, `customCollections`, `upcoming`, `because`,
  `topRated`, `hiddenGems`, `shortTonight`, `onThisDay`, `genreOfDay`, `listening` och `homeLayout`) avkodas med
  `try?` var för sig (`HomeResponse` i `Models.swift`): saknas ett fält, eller har det oväntad form, blir det bara en
  hylla mindre. De står som inbäddade objekt under `optional` i kontraktet. Appen visar hyllorna i ordningen i
  `homeLayout.order` (id:n som i `server/homeshelves.js`) och hoppar över `homeLayout.hidden`.
- `POST /api/profiles/switch` svarar `401` med `needPin`/`needPassword` vid fel PIN – appen loggar inte ut på det
  svaret (alla andra `401` med apptoken loggar ut).
- Bio-läge: appen läser `GET /api/me/cinema` innan en film startas från början och skickar `cinema=1` bara när
  `trailers > 0` eller `preroll` är på (och `prerollAvailable` inte är `false`). Svarar servern inte (äldre server)
  är bio-läget av. Endpointen saknas i kontraktet tills den finns i servern som testet startar; lägg då till den
  (`Home.swift:76`, `AppModel.swift:275-278`).
