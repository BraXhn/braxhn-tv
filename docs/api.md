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
- Behövs en annan form: lägg till ett nytt fält bredvid det gamla (som `seasons` bredvid `items` i `/api/home`)
  och behåll det gamla så länge appar som läser det kan vara installerade.
- Appar ignorerar okända fält (Swift `Decodable`, Kotlin `ignoreUnknownKeys`), så tillägg är alltid säkra.
- Nya frågeparametrar ska vara valfria. Utan dem ska svaret vara som förut.

Om en ny version ändå behövs: lägg den bakom en parameter (t.ex. `?api=2`) eller en ny sökväg och fortsätt svara
som version 1 utan den. Låt apparna läsa `api` från `/api/status` innan de använder det nya.

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
