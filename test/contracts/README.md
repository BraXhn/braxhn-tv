# Kontrakt mot apparna

`apps.json` är det iOS/tvOS-appen och Android-appen läser ur `/api`, skrivet för hand ur appkoden.
`test/api-contract.test.js` kontrollerar varje svar mot det. Varför och versionsregler: [docs/api.md](../../docs/api.md).

## Format

```jsonc
{
  "api": 1,                         // ska vara lika med api i GET /api/status
  "typer": {                        // delade typer: <Namn>.<app>
    "MediaItem.ios": {
      "källa": "apps/apple/Shared/Models.swift:56",
      "required": { "id": "integer", "poster": "boolean" },  // måste finnas och inte vara null
      "optional": { "year": "integer", "children": ["@MediaItem.ios"] }  // får saknas/vara null, men rätt typ om värde
    }
  },
  "endpoints": {
    "GET /api/items/:id/playback": {  // metod + sökväg som i server/routes
      "ios": {                        // en post per app som anropar endpointen (ios = iOS och tvOS)
        "källa": "apps/apple/Shared/Player.swift:158",
        "query": [{ "c": "mp4", "nhls": "1" }],  // det appen skickar; en lista = flera varianter som alla provas
        "body": { "position": 4.5 },  // JSON-kropp; "$namn" m.fl. ersätts av testet (VARS)
        "svar": "@Playback.ios"       // typ, [typ] för en lista, null = svaret läses inte (bara 2xx),
      }                               // { "media": "^video/" } = ström/bild, Content-Type kontrolleras
    }
  }
}
```

Typer: `string`, `integer` (heltal, Swift `Int`, Kotlin `Int`/`Long`), `number` (`Double`), `boolean`,
`any`, `string:path` (relativ adress som börjar med `/api/`), `string:path?` (dessutom med `?`-del),
`@Typ` (hänvisning), `[T]` (lista) och `{ required, optional }` (objekt).

**Obligatoriskt** är ett fält som är icke-optional i Swift (`let x: T`) eller saknar standardvärde i Kotlin
(`val x: T`). Saknas det, eller är det `null`, misslyckas avkodningen av hela svaret. Kotlin-appen avkodar med
`ignoreUnknownKeys`, `explicitNulls = false` och `coerceInputValues`, så `null` för ett fält med
standardvärde blir standardvärdet. Det fältet är alltså valfritt. Fel typ ger fel i båda apparna, även för
valfria fält.

Undantag: Swifts `Podcast` (Listen.swift:35) avkodar `image`, `unplayed`, `description` och `episodes` med
`try?`. Fel typ ger där ingen krasch utan tyst saknad data. Kontraktet kontrollerar ändå `image` och (i
detaljvyn, `PodcastDetail.ios`) `episodes`, eftersom vyerna behöver dem.

## Var posterna kommer ifrån

Varje typ och endpoint har `källa` med fil och rad i appen. Översikt:

| Område | iOS/tvOS (`apps/apple/Shared/`) | Android (`apps/automotive/app/src/main/java/net/braxhn/tv/`) |
|---|---|---|
| Inloggning, status, bildtoken, utloggning | `AppModel.swift:106-149`, typer i `Models.swift:3-19, 195` | `Api.kt:218-249`, typer i `Api.kt:37-39, 108` |
| Inloggning med kod (TV) | `AppModel.swift:220-245`, typer i `Models.swift:200-210` | `Api.kt:285-310`, typer i `Api.kt:325-327` |
| Startsida, bibliotek, sök, titelsida | `Views.swift:282, 283, 343, 368`, `DetailView.swift:68`, typer i `Models.swift:21-156` | `MainActivity.kt:229, 264, 283, 376`, typer i `Api.kt:40-96` |
| Uppspelning, undertexter, strömmar | `Player.swift:127-164, 290-293, 359`, förmågor `AppModel.swift:154-172`, typer i `Models.swift:158-187` | `PlayerScreen.kt:73-108`, förmågor `Api.kt:259-273`, typer i `Api.kt:97-104` |
| Framsteg och sedd | `AppModel.swift:175`, `DetailView.swift:134` | `Api.kt:275-280` |
| Bilder (`?t=` bildtoken) | `AppModel.swift:50-61` | `Api.kt:178-183` |
| Offline och offline-synk | `Offline.swift:5-29, 140-148, 233` | `Offline.kt:20-25, 74-90, 165` |
| Lyssningsinställningar | `Listening.swift:6-55` | `Api.kt:25, 145-154` |
| Musik | `Music.swift:7-60, 129-149, 203, 223, 316-378` | `MusicService.kt:41-61, 138, 248-251, 272, 309-364, 459, 484-497` |
| Ljudböcker | `Listen.swift:7-33, 154-155, 209, 257, 360-362, 505, 566` | `MusicService.kt:49-52, 228, 284, 291-299, 331, 457` |
| Poddar | `Listen.swift:35-74, 165-167, 260, 360-362, 472, 506, 589` | `MusicService.kt:53-57, 231, 286-287, 333-337, 434, 458` |
| Live-TV och inspelningar (bara Android) | – | `Live.kt:54-60, 78, 95, 119, 132, 159-160`, `MainActivity.kt:93` |
