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
  "qualityHome": "auto", "qualityRemote": "720", "saved": true, "remoteCap": "1080" }
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

## Kö på Chromecast: `queue=1`

`/api/items/:id/playback?cast=1&queue=1` ger samma svar som vanligt (med en egen mediatoken för titeln) men räknas
inte som en uppspelning: ingen förstart av omkodningen, ingen rad under Aktivitet och ingen Trakt-start. Webben köar
nästa avsnitt så på Chromecasten; apparna kan använda det på samma sätt.

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
