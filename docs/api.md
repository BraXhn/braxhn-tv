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

## Språk per profil: `/api/me/lang`

`/api/status` har `user.lang` (nytt fält): `"sv"`, `"en"` eller `null` (inget val än – svenska). `PUT /api/me/lang`
med `{ "lang": "sv" | "en" }` sparar valet (400 för andra värden). Webben väljer `index.html` efter det (svensk eller
engelsk variant, se `server/http/static.js`); serverns felmeddelanden i API:t är alltid svenska. Apparna läser inte fältet.

## Enkel inloggning: `/api/sso/*` och `/api/me/sso`

Bara webben använder dem; apparna loggar in som förut (LDAP-användare med `POST /api/login`, se nedan).

- `GET /api/sso/providers` (utan inloggning): `{ providers: [{ id, name, kind: "oidc" }], ldap: [namn], localLogin: "all" | "admin" }`.
- `GET /api/sso/oidc/:id/start?remember=0|1[&link=1]` → 302 till leverantören (sätter kakan `bxsso`, Path=/api/sso/). Kommer
  förfrågan till en annan värd än den vitlistade adressen skickas webbläsaren först dit. `link=1` kopplar det inloggade
  webbkontot (huvudkontot) i stället för att logga in.
- `GET /api/sso/oidc/:id/callback` (leverantören skickar hit) → 302 till `/#/login/done` (kakan för webben satt),
  `/#/login/link/<biljett>` (bekräfta koppling), `/#/account` (kopplat) eller `/#/login/sso/<kod>` med koden `state`,
  `denied`, `token`, `provider`, `groups`, `email`, `noaccount`, `linked`, `remote`, `2fa`, `disabled` eller `blocked`.
- `GET /api/sso/link/:biljett` → `{ provider, account, canCreate, need2fa, expires }`; `POST` med `{ password, code? }`
  kopplar och loggar in (kaka, eller `token` om inloggningen kom från en app), `{ create: true }` skapar ett nytt konto
  med ledigt namn (bara när leverantören får skapa konton). Biljetten gäller 10 minuter, en gång, högst 5 fel lösenord.
- `POST /api/login` provar LDAP-leverantörerna när det lokala lösenordet inte stämmer (eller kontot inte finns). Nya svar:
  `409 { needLink: true, ticket, account, provider }` (LDAP-användaren heter som ett lokalt konto som inte är kopplat),
  `403` när lösenordsinloggning bara gäller administratörer eller kontot saknar rätt grupp, `503` när LDAP-servern inte svarar.
- `GET /api/me/sso` → `{ providers: [{ id, name, kind, linked, managed, lastLogin }], profile }`; `DELETE /api/me/sso/:pid`
  tar bort kopplingen (400 för konton som leverantören skapat).
- Administration (betrott nät): `GET /api/sso`, `PUT /api/sso/settings` (`{ localLogin }`), `POST /api/sso/providers`,
  `PUT|DELETE /api/sso/providers/:id`, `POST /api/sso/providers/:id/test` (`{ username?, password? }` för LDAP),
  `GET /api/sso/providers/:id/links`, `DELETE /api/sso/providers/:id/links/:uid`. Svaren har `hasSecret` men aldrig
  `clientSecret`/`bindPassword`; ett tomt hemlighetsfält i `PUT` behåller den sparade, `clearSecret: true` tar bort den.

## Uppspelningsval per konto: `/api/me/playback-prefs`

`GET`/`PUT /api/me/playback-prefs` (PUT ändrar bara fälten som skickas):

```json
{ "audioLangs": ["sv", "en", "orig"], "subMode": "foreign", "subLangs": ["sv"], "sdh": "avoid",
  "skipIntro": true, "skipRecap": false, "skipCredits": false, "autoNext": true, "nextCountdown": 8,
  "qualityHome": "auto", "qualityRemote": "720", "autoSync": true, "audioDesc": false, "saved": true, "remoteCap": "1080" }
```

- Språk är ISO 639-1 (`sv`, `en`); trebokstavskoder (`swe`) tas emot och skrivs om. `orig` i `audioLangs` = filens
  standardspår (originalspråket i de flesta filer). Kommentarsspår väljs aldrig automatiskt; ljudbeskrivning
  (syntolkning: disposition `visual_impaired`, "Syntolkning", "AD") bara med `audioDesc: true` – då på samma språk
  som annars skulle spelas, annars på första språket i `audioLangs` som har en.
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
rows, w, h }` = rutan i ett ark från `/api/items/:id/trickplay/:n`, eller `null`). Android-appen läser `id`, `t`, `line`, `marks`, `before`/`after`, titelfälten och `status` (`indexing` som valfri typ – ett objekt för administratören).

## Familjefilter: `filter` i `/api/items/:id/playback`

Nytt, valfritt fält (bara när profilens familjefilter är på, `server/familyfilter.js`):
`filter: { mode: 'mute'|'skip', item, ready, server, mute: [[start, slut], …], skip: [{ id, start, end, label }, …] }`.
`mute` = sekunder att tysta (hela repliker med en svordom, med marginal och undertextsynken inräknad), `skip` = scener att
hoppa över (bara läget `skip`), `item` = filen som markeringar gäller (versionen som spelas), `ready` = undertexterna är
indexerade (annars tom lista tills repliksökningens jobb läst dem), `server` = strömmen är redan tystad av servern.

- **Utan klientstöd (apparna, Chromecast):** servern tystar själv – ett ljudspår kodas om (AAC) med ett volymfilter, bilden
  kopieras (`mode` blir `remux`/`transcode` i stället för `direct`, `reasons` innehåller *familjefiltret tystar
  svordomar*, HLS-adressen har `ff=1`). Inga nya fält behöver läsas.
- **Klienter som tystar själva** skickar `ffc=1` (webbspelaren): beslutet är då som utan filter (direktuppspelning
  behålls) och `server` är `false`; klienten tystar i `mute` och hoppar över `skip`. Gäller bara profiler som valt filtret
  själva: för **barnprofiler** (läget bestäms av huvudkontot/administratören) tystar servern alltid (`server: true`, även
  med `ffc=1`), HLS-sessionen tystas även om `ff=1` tas bort ur adressen, och för titlar med svordomar nekas
  `/api/stream/:id/direct`, `/download`, `/offline-file` och `/api/items/:id/offline` (**403**).
- **Undertextsynken** (`POST`/`PUT /api/items/:id/subs/:sid/sync`) flyttar även intervallen och ändras därför bara av vuxna
  profiler (barnprofiler **403**; `GET` går bra).
- **Undertexterna** (`subtitles[].url`, `/api/stream/:id/subs/:sid`) maskeras av servern efter profilen (`***` i
  stället för ordet, tiderna orörda); adressen får `ff=1` så att cachen skiljer profilerna åt. Repliksökningen
  (`/api/search/lines`) maskerar `line`/`before`/`after` på samma sätt.

Övriga routes (inloggad):
- `GET`/`PUT /api/me/family-filter` – `{ mode, setting ('' = standard), kid, canChange, kidsDefault }`; `PUT { mode }`
  (`''`, `off`, `mute`, `skip`) nekas för barnprofiler (**403**). Huvudkontot ändrar en profil med
  `PUT /api/profiles/:pid { familyFilter }`; `GET /api/profiles` har `familyFilter` och `familyMode`.
- `GET /api/items/:id/skips` → `{ skips: [{ id, start, end, label, scope, by, mine, canDelete }], canAdd, canShareAll, mode }`,
  `POST /api/items/:id/skips { start, end, label?, scope: 'me'|'household'|'all' }` (minst 0,5 s, högst 30 min; barnprofiler
  **403**, `all` bara administratören), `DELETE /api/skips/:sid` (den som skapade, huvudkontot för hushållets, administratören).
- Administratören (betrott nät): `GET`/`PUT /api/admin/family-filter` (`{ builtin, custom: { sv, en, off }, kidsDefault }`;
  `PUT { kidsDefault?, sv?, en?, off? }`) och `POST /api/admin/family-filter/test { text, lang? }` → `{ masked, hit }`.

## Hälsokontroll och rättad språkmärkning: `/api/admin/health*`

Bara för administratören på betrott nät (webbens `#/health`, `server/health.js`). `GET /api/admin/health` →
`{ issues, overrides, kinds, status, settings, arr }`; varje fynd har `id`, `item`, `kind` (`broken`, `truncated`,
`length`, `decode`, `sync`, `audiolang`, `sublang`, `bitrate`, `quality`, `duplicate`, `missing`), `key`, `severity`
(`error`/`warn`/`info`), `detail` (`msg` + typens fält, för språk `track`/`current`/`suggest`), `ignored`, `action`
(`search`/`blocklist`) och `actions`. `POST /run` (`{ full }`), `PUT /settings` (`{ enabled, samples, maxMbps }`),
`POST /issues/:id/ignore` (`{ ignored }`), `POST /issues/:id/replace` (`{ blocklist }` – Radarr/Sonarr söker en ny
version, ev. efter att den hämtade releasen markerats som misslyckad; 409 utan Radarr/Sonarr, 404 när titeln inte finns
där, 429 vid upprepning inom 5 min) och `PUT /lang` (`{ item, track, lang }`, `track` = `a<index>` ljud, `e<index>`
inbäddad undertext, `<källa>:<filnamn>` undertextfil; `lang` = tre bokstäver, tomt = ta bort). **För apparna:** en
rättad märkning syns som vanligt `lang` i `/api/items/:id/playback` (`audio`, `subtitles`) och `/api/items/:id` – inga
nya fält; filen ändras aldrig och rättelsen gäller bara så länge filen är oförändrad (mtime/storlek).
## Diskrådgivaren: `/api/admin/shrink*`

Bara för administratören på betrott nät (webbens `#/shrink`, `server/shrink.js`); apparna använder det inte.
`GET /api/admin/shrink?lib=&sort=size|gain|rate|seen&limit=&codec=&notSeenDays=` → `{ report, settings, encoders, metric,
jobs, trash, state, waitReason, arr }`. `report` har `totals` (`bytes`, `count`, `saving`, `never`, `stale`, `wanted`),
grupper `libraries`, `shows`, `resolutions`, `codecs` (`key`, `label`, `bytes`, `count`, `minutes`, `mbPerMin`, `saving`,
`lastSeen`), `versions` (`main`, `files`, `reclaim`, `extra`), `titles` (per fil: `size`, `mbPerMin`, `res`, `vcodec`,
`lastSeen`, `never`, `wanted`, `estimate` = `{ saving, after, videoKbps, afterKbps }` eller `{ skip }`, `job`) och
`calibration`. `PUT /settings` (`{ codec: hevc|av1, allowCpu, window: 'HH:MM-HH:MM'|'', onlyIdle, paused, quality:
high|balanced|small, minVmaf, minSsim, minPsnr, samples, trashDays, notSeenDays }`, 400 vid fel värde).
`POST /queue` (`{ items: [id], codec?, force? }` eller `{ rule: { library, codecs, minMbPerMin, notSeenDays, minGainPct },
preview? }`) → `{ queued, skipped: [{ id, reason }] }` (409 när ingen kodare får användas; preview → `{ matches, saving,
titles }`). `POST /calibrate` (`{ item, codec? }`) → `{ encoder, measured, model, factor }`. `POST /run`.
`POST /jobs/:id/cancel`, `POST /jobs/:id/restore` (originalet tillbaka ur papperskorgen, 404 om det inte finns kvar) och
`DELETE /jobs/:id/trash` (töm nu). Jobbens `status`: `queued`, `running`, `done`, `rejected` (kvaliteten räckte inte –
originalet behållet), `failed`, `cancelled`, `restored`. **För apparna:** efter ett byte har titeln samma id; `vcodec`,
storlek och spår i `/api/items/:id` och `/playback` beskriver den nya filen (vanligen HEVC) – inga nya fält.

## Omkodning till HEVC/AV1: `tc=` och `vcodec`

Bara tillägg – en klient utan `tc` får H.264 i MPEG-TS vid omkodning precis som förut.

- `GET /api/items/:id/playback?…&tc=hevc,av1`: codecs som klienten kan avkoda i **HLS med fMP4** vid omkodning.
  Servern väljer AV1 före HEVC, grafikkortets kodare före processorns (x265/SVT-AV1 bara när administratören valt det),
  och faller tillbaka till H.264 när ingen kodare finns. Direktuppspelning och remux påverkas inte.
- Nytt fält `vcodec` (String) i svaret: videons codec i strömmen – vid omkodning `h264`, `hevc` eller `av1`, annars källans.
- HEVC/AV1-strömmen är fMP4 (`#EXT-X-MAP:URI="init.mp4…"`, segment `seg-N.m4s`), HEVC med `hvc1`, 8 bitar (Main), BT.709,
  inga B-bilder, samma segmentrutnät och tidsstämplar som H.264. Taket för en kvalitetsnivå är lägre (HEVC 60 %, AV1 50 %
  av H.264:s), även i ABR-masterns `BANDWIDTH`.
- Slutar kodaren fungera byter servern sessionen till H.264 (fortfarande fMP4). Har spelaren redan hämtat initsegmentet
  passar de nya segmenten inte: hämta `/playback` igen med `tc=` tomt (webbspelaren gör det vid ett avkodningsfel).
- Administratören väljer i `PUT /api/settings` med `transcodeVcodec`: `auto` (grafikkortet, standard), `cpu` (även processorn)
  eller `h264` (alltid H.264). `GET /api/settings` har `transcodeVcodec` och `transcode` (ffmpeg-version, kodare, tonmappning).

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

## Musikvideor och låttexter

Bara tillägg (server/musicvideos.js, server/lyricstags.js, server/listening.js):

- `GET /api/music/albums/:aid` och `GET /api/music/artists/:arid`: `videos: [{ id, title, kind, duration, width, height, thumb, artistId,
  trackId, artist }]` (tom lista om inga). `kind` = `video`, `live`, `lyrics`, `concert`, `interview`, `behindthescenes` eller `other`;
  `trackId` är `null` för videor som bara hör till artisten.
- Spåren i musiklistorna har `video` (videons id) när låten har en musikvideo – fältet saknas annars.
- `GET /api/music/videos/:vid`: videon som ovan plus `track: { id, title, albumId } | null` och `more` (artistens övriga videor, högst 30).
- `GET|HEAD /api/music/videos/:vid/stream`: filen med Range; `?mp4=1` = fragmenterad MP4 (H.264/AAC) för klienter som inte klarar
  formatet. Mediatoken med scope `6e9 + id`. Skärmtid gäller (403 `screen_time`).
- `GET /api/music/videos/:vid/play`: `{ url, mp4, mime }` – färdiga adresser med kortlivad token för appar och Chromecast (webben använder kakan).
- `GET /api/music/videos/:vid/thumb?w=`: stillbild (JPEG), bildtoken som för omslag.
- `GET /api/music/tracks/:tid/lyrics`: `source` kan även vara `sylt` (synkad text ur ID3). Rader kan ha `words: [{ t, text }]` (ordtider från
  utökad LRC eller SYLT per ord – orden sätts ihop utan extra mellanrum). Synkad text går före osynkad; har filen bara osynkad text
  och LRCLIB har synkad används LRCLIB:s.

## Glapplöst, övertoning och jämn ljudnivå

Bara tillägg (server/gapless.js, server/listening.js) – apparna kan använda dem när de vill:

- Spåren i musiklistorna (album, spellistor, smarta listor, låtradio …) har `albumPeak` (linjärt toppvärde för albumläget, `null`
  om okänt) och `gapless`: `null` tills låten analyserats, annars `{ sampleRate, samples, skip, pad, silenceStart, silenceEnd }`.
  `samples` = exakt antal sampel i filens takt; `skip`/`pad` = sampel som avkodaren lämnar före/efter ljudet (MP3: LAME-taggens
  fördröjning + 529, AAC: iTunSMPB eller edts/elst). Enskilda fält kan vara `null`. `silenceStart`/`silenceEnd` = sekunder tystnad
  (under −50 dBFS) i början/slutet, högst 30. `albumGain` räknas fram ur spårens nivå när albumtaggen saknas.
- `GET/PUT /api/me/listening`: `normMode` (`track`, `album`, `off` – `off` är samma sak som `normalize: false`), `gapless` (Bool) och
  `crossfade` (sekunder, `choices.crossfade`). `normalize` finns kvar för apparna.
- `gl=1` på `/api/music/tracks/:tid/stream`: måste låten kodas om och klienten klarar FLAC (`a=…flac`, ingen `br`) blir det FLAC
  (exakt längd, ingen kodarfördröjning) i stället för MP3/AAC.

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

## Kvällsvalet: `/api/tonight*`

Hushållet röstar fram kvällens film eller serie (`server/tonight.js`, `server/routes/tonight.js`; webben
`#/tonight`). Alla routes kräver vanlig inloggning (kaka eller apptoken, aldrig medie-/bildtoken). Inget används av
apparna än – en app kan vara deltagare med samma anrop. Allt ligger i minnet: ett kvällsval stängs efter 4 timmar,
efter 30 minuter utan ansluten deltagare och 30 minuter efter matchen.

- `GET /api/tonight` → `{ sessions: [{ id, host, phase, members, joined }], libraries: [{ id, name, type }], genres: [..] }`
  – öppna kvällsval i profilens hushåll och vad filtren kan väljas bland (det profilen får se).
- `POST /api/tonight` `{ filters }` → `{ id, code }`. Filter: `kinds` (`movie`/`show`), `libs` (id), `genres`,
  `maxMinutes` (30–600; serier: avsnittens medellängd), `minRating` (TMDB 0–10), `unseen` (standard `true`),
  `rule` (`all` | `majority`), `size` (10/20/30). Okända värden ignoreras. Högst två öppna per värd (det äldsta stängs).
- `POST /api/tonight/join` `{ code }` → `{ id }` – sex siffror (mellanslag tillåtna), alla konton. 404 vid fel kod,
  429 efter tio fel på tio minuter per profil. `POST /api/tonight/:id/join` – utan kod, bara inom hushållet.
- `GET /api/tonight/:id` → läget + `deck` (titlarna i samma form som listorna, uppslagna med deltagarens egen
  åldersgräns). `GET /api/tonight/:id/events` (SSE): `state` (läget, vid varje ändring), `deck` (förslagen ändrades –
  hämta `GET` igen), `closed`, `left`. Bara deltagare (annars 404).
- Läget: `{ id, code, phase: lobby|voting|matched, isHost, host, filters, need, maxAge, members: [{ name, kid, self,
  host, voted, online }], total, done, more, votes: { <id>: true|false } (bara de egna), fits (lobbyn), match: { id,
  likes, of, picked, by, play: { id, position } } | null, top: [{ id, likes }] | null, party, expires }`. `match.play`
  är det deltagaren ska spela (serie: påbörjat eller första osedda avsnittet).
- Värden: `PUT /api/tonight/:id/filters` (bara i lobbyn), `POST …/start` (409 om inget passar alla), `POST …/more`
  (tio förslag till), `POST …/pick` `{ item }` (välj bland förslagen), `DELETE /api/tonight/:id` (avsluta för alla).
- Alla: `POST …/vote` `{ item, like: true|false|null }` (`null` = ångra), `POST …/party` → `{ id }` (Titta
  tillsammans med matchen; samma rum för alla), `DELETE …/me` (lämna; värdskapet går till den som varit med längst).

Regler: varje förslag är tillåtet för **varje** deltagare (`allowedFor` – åldersgräns och bibliotek); den som går med
under röstningen tar bort det som inte är tillåtet för den (eller som den sett, med `unseen`) ur listan för alla.
Ingen ser vem som sett eller röstat vad – bara hur många förslag var och en svept och, när ingen match blev av, antalet
gillningar per titel. Match när antalet gillningar når `need` (alla, eller hälften + 1).
## Språkinlärningens ordlista: `/api/vocab*`

Ord som profilen sparat i webbspelarens språkinlärningsläge (`server/vocab.js`, `server/routes/vocab.js`; webben
`web/js/player/learn.js` och `#/vocab`). Vanlig inloggning (kaka eller apptoken). Orden är profilens egna – andra
profiler får 404. Används inte av apparna än.

- `GET /api/vocab[?item=<id>&q=<text>]` → `{ words: [{ id, word, sentence, translation, lang, source, itemId, start, end,
  position, created, clip }], max }` – nyast först. Ord ur titlar som profilen inte längre får se (åldersgräns,
  bibliotek) döljs; en borttagen titel ger `itemId: null` (källan finns kvar). `clip` = ljudklipp går att ta fram.
- `POST /api/vocab` `{ itemId, word, sentence, translation, start, end, position, lang, audio }` → `{ id, dup }` –
  `itemId` måste vara en film eller ett avsnitt som profilen får se (annars 404). `start`/`end` = replikens tider i
  sekunder (filens tidslinje), `audio` = ljudspårets strömindex för ljudklippet. Samma ord ur samma replik i samma titel
  sparas inte igen (`dup: true`). Högst 5000 ord per profil (409).
- `PUT /api/vocab/:id` `{ word?, translation? }`, `DELETE /api/vocab/:id`.
- `GET /api/vocab/:id/clip` → `audio/mpeg`: repliken med 0,25 s marginal (högst 15 s), mono. Kräver nedladdningsrätt
  (403), inte för barnprofiler med påtvingat familjefilter när titeln har svordomar (403), högst två samtidigt (429).
- `GET /api/vocab/export?format=tsv|csv|zip[&q=]` → nedladdning för Anki. TSV/CSV har Ankis filhuvud (`#separator`,
  `#html:false`, `#columns:Ord…`) och fälten Ord, Mening, Översättning, Källa. `zip` (kräver nedladdningsrätt) innehåller
  `ordlista.txt` (TSV med fältet Ljud: `[sound:braxhn-<id>.mp3]`) och ljudklippen (högst 100).

## E-böcker och serietidningar: `/api/ebooks/*` och OPDS `/api/opds/*`

Bara webben (apparna får inte bibliotekstypen `ebook` i `/api/libraries`, och `reading` i `/api/home` samt `ebooks` i `/api/search/all` är tomma för apptoken). Allt kontrolleras mot profilens behörighet: biblioteket, barnprofiler bara när `libraries.kids` = 1 och då bara böcker utan högre `age` – annars 404.

| Anrop | Svar |
|---|---|
| `GET /api/ebooks/lib/:lib?sort=title\|author\|series\|added\|recent&series=` | `{ library, series: [{ name, count, read, cover }], continue, books }` – böckerna som kort: `id, library, format (epub\|pdf\|cbz), title, author, series, seriesNo, year, cover, pages, rtl, added, percent, finished, updated` |
| `GET /api/ebooks/:id` | kortets fält + `description, publisher, language, isbn, volume, genres, manga, age, locator, spine [{ href, chars, linear }], toc [{ title, href, frag, level }], marks, sameSeries, canDownload` |
| `GET /api/ebooks/:id/cover?w=` | JPEG (alternativet `img`) |
| `GET /api/ebooks/:id/res?p=` | en post i EPUB:en: XHTML som `text/plain`, CSS, typsnitt och bilder (typ ur byten); alltid `Content-Security-Policy: … sandbox`. 400 för sökvägar ut ur arkivet, 404 för poster som saknas, 422 för zip-bomber/trasiga poster, 415 för andra typer |
| `GET /api/ebooks/:id/page/:n` | serietidningens sida `n` (0 = första) som bild |
| `GET /api/ebooks/:id/pdf` | PDF:en `inline` (webbläsarens läsare) |
| `GET /api/ebooks/:id/file` | originalfilen som nedladdning – kräver rätten att ladda ner (403) |
| `POST /api/ebooks/:id/progress` | `{ locator, percent, finished?, at? }` – `locator` är klientens position (JSON-objekt ≤ 2000 tecken: EPUB `{ ch, p }`, serietidning `{ page }`), `at` = när den sparades (ett äldre läge skriver inte över ett nyare, svaret har då `stale: true`). ≥ 99,5 % = utläst |
| `DELETE /api/ebooks/:id/progress` | börja om / oläst |
| `POST /api/ebooks/:id/marks` | `{ kind: bookmark\|highlight, locator, text, note, color (yellow\|green\|blue\|pink) }` – markeringens `locator` = `{ ch, start, end }` (textposition i kapitlet) |
| `PUT\|DELETE /api/ebooks/marks/:mid` | ändra `note`/`color`, ta bort (bara egna) |
| `GET\|POST\|DELETE /api/me/opds` | lösenordet för läsappar: läget, skapa (`{ password, code? }` – kontots lösenord, utifrån även tvåstegskod; `secret` visas bara i svaret) och återkalla |

**OPDS** (OPDS 1.2/Atom) under `/api/opds`: `/` (navigering), `/continue`, `/recent`, `/search?q=`, `/opensearch.xml`, `/lib/:lib?page=` (50 per sida, `next`/`previous`), `/lib/:lib/series`, `/lib/:lib/series/:name`, `/book/:id/cover`, `/book/:id/file` (kräver nedladdningsrätt) och `/book/:id/page/:n` (OPDS-PSE, `pse:count` i flödet). Inloggning bara med HTTP Basic: profilens namn och lösenordet för läsappar – kaka, Bearer och `?t=` gäller inte där, och lösenordet gäller ingen annanstans (routealternativet `opds`). Utan inloggning 401 med `WWW-Authenticate: Basic`; för många fel ger 429.

## Ljudböckernas verktyg: RSS-flöden, kapitel, statistik och sammanslagning

Bara tillägg – apparna läser inget av det (de nya fälten i `GET /api/audiobooks/book/:id` är valfria).

- `GET /api/audiobooks/book/:id` har nu även `listened` (lyssnad tid för profilen, sekunder), `feedsAllowed` och för
  administratörer `tools: { canEmbed, canMerge, state: { kind, running, ok, error } | null, trash: { kind, files, bytes, until } | null }`.
  `chapterSource` kan vara `fil`, `audnexus` eller `redigerad`. `/api/me/listening` har `speechLevel` (jämn ljudnivå för tal i webben).
- **Lyssningsstatistik:** `GET /api/audiobooks/stats` → `{ total, finished, days: [{ day, seconds }] (30 dagar), books: [{ …bok, seconds,
  lastDay }] }`, för administratörer även `profiles: [{ id, name, seconds, books, finished }]`. Tiden räknas ur framstegen
  (`POST …/progress`): steget framåt delat med hastigheten, bara rimliga steg (högst 3,2× den tid som gått + 1 s, inom 15 min).
  Anrop med `at` (offline) räknas inte. *Markera som oläst* = `POST …/progress { position: 0 }`.
- **RSS-flöden (privata, per profil):** `GET /api/audiobooks/feeds[?book=|?lib=&series=]` → `{ allowed, reason, feeds: [{ id, kind
  ('book'|'series'), book, library, title, created, lastUsed }] }`. `POST /api/audiobooks/feeds { book } | { library, series }` →
  `{ id, path, url }` – adressen med nyckeln visas **bara här** (servern sparar SHA-256). `DELETE /api/audiobooks/feeds/:id` återkallar.
  Nekas (403) för barnprofiler, profiler med skärmtid och konton utan rätt att ladda ner – även vid varje hämtning.
- **Flödet** (routealternativet `feed` i `http/router.js`: ingen kaka, Bearer eller `?t=` gäller, och nyckeln gäller inget annat):
  `GET|HEAD /api/feeds/<nyckel>/feed.xml` (RSS 2.0, `itunes:` och Podcasting 2.0 `podcast:`; en bok i en fil = ett avsnitt,
  i flera filer = ett avsnitt per fil; en serie = böckerna i nummerordning), `GET|HEAD /api/feeds/<nyckel>/audio/<fil-id>.<ändelse>`
  (filen som den är, med Range), `GET /api/feeds/<nyckel>/chapters/<fil-id>.json` (`application/json+chapters`, version 1.2.0,
  tider relativt filen) och `GET /api/feeds/<nyckel>/cover/<bok-id>.jpg`. Länkarna i flödet är absoluta: inställningen
  `public_url` (`PUBLIC_URL`), annars förfrågans värd.
- **Kapitelredigeraren (administratör):** `PUT /api/audiobooks/book/:id/chapters { chapters: [{ start, title }] }` (högst 500,
  starttider inom boken och minst 1 s isär; sluttid = nästa start) eller `{ reset: true }` → boken. Filen skrivs inte om.
  `GET /api/audiobooks/book/:id/chapters/audnexus[?asin=]` → `{ asin, chapters, total, duration, lengthOk }` (sparas inte).
- **Filåtgärder (administratör, en i taget, i bakgrunden → 202, 409 när en annan pågår):** `POST /api/audiobooks/book/:id/chapters/embed`
  (en M4B/M4A-fil: kapitlen in med `ffmpeg -c copy`, atomärt byte, originalet i papperskorgen), `POST /api/audiobooks/book/:id/merge`
  (flera filer i bokens mapp → `<Titel>.m4b` med kapitel, metadata och omslag; AAC kopieras, annat kodas om till AAC 64–128 kbit/s)
  och `POST /api/audiobooks/book/:id/restore` (originalen tillbaka). Läget syns i `tools.state`.
- **Metadatasökning:** `GET /api/audiobooks/book/:id/match` ger även träffar med `source: 'audible'` (Audibles katalog i regionen
  `book_meta_region`, `PUT /api/settings { bookMetaRegion }`: us, uk, de, fr, ca, au, it, es, in, jp), och `POST …/match` tar
  `source: 'audible'` (detaljerna hämtas från Audnexus).

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

### Android-appens anrop utanför kontraktet

Android-appen anropar också `POST /api/iptv/vod/:id/play`, `POST /api/iptv/episodes/:eid/play` (`?ss=` vid Fortsätt),
`POST /api/iptv/programs/:pid/catchup?offset=`, `POST /api/iptv/play/:sid/stop` och `POST /api/iptv/progress`. De kräver en
Xtream-källa eller ett catch-up-arkiv som testservern saknar och finns därför inte i kontraktet; appen läser bara `url`,
`direct`, `sid`, `offset`, `duration` och `position` (alla utom `url` valfria). Ändra inte de fälten.

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
