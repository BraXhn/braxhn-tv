# BraXhn TV för iPhone, iPad och Apple TV

En och samma SwiftUI-app för iOS/iPadOS 16+ och tvOS 16+.

**Funktioner**
- inloggning mot din server
- hem med *Fortsätt titta*
- bibliotek och sök
- serier med säsonger
- val av ljudspår och undertext
- knappen *Hoppa över intro* och *Nästa avsnitt* (på Apple TV visas den i spelarens egna kontroller)
- nästa avsnitt efter kontots val *Spela nästa avsnitt automatiskt* (`autoNext` i `/playback`, som webben och de
  andra apparna): när avsnittet är slut visas kortet *Nästa avsnitt om … s* med *Spela nu* och *Avbryt* (på Apple TV
  med fokus på *Spela nu*, och fjärrkontrollens Menu är *Avbryt*). 0 s startar nästa direkt. Är valet av visas kortet
  *Nästa avsnitt* utan nedräkning, med *Spela nu* och *Stäng* (Menu = *Stäng*); spelaren stängs bara när det inte finns
  något nästa avsnitt. En äldre server utan `autoNext` ger 8 s som förut, men en nedladdad titel (ingen `/playback`,
  valet okänt) får kortet utan nedräkning – en barnprofil med valet av får aldrig nästa avsnitt av sig självt. Nästa avsnitt förbereds på servern (`/playback?warm=1`,
  samma fråga som uppspelningen) när eftertexterna börjar och under nedräkningen. Reglerna: `Shared/NextCore.swift`
- skärmtiden kvar i spelaren, som webben, Android- och Expo-appen: för en profil med skärmtid och en gräns i dag visar
  iPhone och iPad *12 min kvar idag* i spelarens överkant (*⏱ 12 min kvar* på en smal skärm), Apple TV när filmen är
  pausad, och de sista fem minuterna syns *Skärmtiden tar slut om 4 min* hela tiden. VoiceOver läser upp varningen när
  den syns och när minuten ändras. Tiden följer `screenTime.left` i svaret på framstegen (var tionde sekund medan filmen
  spelar; en äldre server ger `remaining`) och appens egen räkning utan nät; en paus räknas inte, så tiden står still.
  Reglerna: `Shared/ScreenLeftCore.swift`
- tittarstatus som synkas med webben
- AirPlay och bild-i-bild (iPhone/iPad)
- HDR-filer spelas i HDR på enheter som klarar det, annars tonmappar servern
- live-TV: kanaler med logga och *Nu/Sen*, TV-guide, boka inspelning från ett program, inspelningar (spela, ta bort, avboka)
- byt profil (Inställningar → Byt profil) med PIN
- Min lista: knapp på titelsidan, hylla på startsidan och egen sida
- startsidans hyllor i din ordning från *Anpassa startsidan* i webben (egna samlingar, Kommer snart, Eftersom du såg …, Topprankat, Dagens genre, Fortsätt lyssna med mera – de hyllor servern har)
- bio-läge: trailers före filmen med *Hoppa över* och *Hoppa över alla* (slås på under Mitt konto i webben)
- nattläge och tydligare dialog (spelarens meny, på Apple TV *Ljudläge* i menyraden, eller Inställningar)
- svenska och engelska efter enhetens språk (andra språk får engelska; serverns egna felmeddelanden är svenska)
- barnprofiler: poddarna döljs (servern har inga poddar för barn), och Föräldraöversiktens *Stoppa* eller slut på
  skärmtiden stoppar spelaren med förklaringen *En vuxen stoppade uppspelningen* (pausar ljudböcker likadant)
- långsam start vid omkodning med grafikkort (~10 s till första bilden): spelaren säger att servern förbereder strömmen
  och försöker själv igen med samma ström – ingen ny omkodning startas
- tydliga felmeddelanden: ingen anslutning, fel adress, certifikatfel, för många försök (429), full disk/databasfel
  (507/503 med serverns förklaring) och en server som inte svarar via BraXhn Relay
- nedladdning visas bara för konton som får ladda ner
- nedladdningar (iPhone/iPad) gäller en server och profil, som i Android- och Expo-appen: varje profil har sin mapp
  (`Downloads/<server>-<profil>/`) och lista, så en barnprofil ser inte vad en vuxen laddat ner, och efter profilbyte
  eller utloggning visas bara den nya profilens. Vilken profil som är inloggad sparas per inloggning, så rätt lista
  visas även när servern inte svarar. En nedladdning som blir klar när en annan profil är inloggad hamnar hos den som
  startade den. *Logga ut* frågar först om något laddats ner från servern och tar då bort allt därifrån (alla
  profiler); loggas appen ut för att servern inte godtar inloggningen längre ligger nedladdningarna kvar och syns igen
  när profilen loggar in. När servern svarar tas allt bort om profilen inte får ladda ner längre, och nedladdade
  titlar som profilen inte får se (403) eller som inte finns kvar (404), högst var sjätte timme
- nedladdningar från äldre versioner (en gemensam lista) flyttas till profilen som var inloggad när appen uppdaterades;
  gick det inte att veta får huvudkontot dem (som Android-appen)
- positioner som inte kommer fram (inget nät, serverfel) sparas per server och profil och skickas med `at` när nätet
  kommer tillbaka, när appen kommer till förgrunden och efter nästa lyckade rapport – filmer, avsnitt, ljudböcker och
  poddar. Servern behåller då ett senare framsteg från en annan enhet (för poddar bara när servern tar emot `at`).
  Reglerna: `Shared/OfflineCore.swift`
- skärmtid utan nät (iPhone/iPad): appen sparar profilens senaste skärmtid från servern (`GET /api/screentime` när
  profilen blir känd, `screenTime` i svaret på framstegen) och räknar själv tiden när en nedladdad film spelas och
  framsteget inte kommer fram. Är dagens tid slut eller klockslaget passerat startar filmen inte, eller stoppas med
  samma besked som servern ger. En ny dag gäller den dagliga gränsen och klockslagen utan extra tid. Samma regler som
  Android- och Expo-appen (`ScreenClock` i `Shared/OfflineCore.swift`, sparas i `OfflineScreen` i `Offline.swift`).
  Tiden sparas också som en post per uppspelning (`{ id, at, seconds, audio }`, per server och profil; posten växer
  medan filmen spelar och en ny börjar efter en paus på mer än två minuter eller efter en timme) och lämnas in med
  `POST /api/screentime/offline` när nätet kommer tillbaka, på samma ställen som positionerna. Det som svaret listar
  i `done` tas bort ur kön, och svarets `screenTime` gäller sedan. Servern räknar varje sekund en gång, så en post som
  skickas två gånger räknas inte dubbelt (`ScreenLog` i `Shared/OfflineCore.swift`, `PendingScreenTime` i
  `Offline.swift`)
- feedback och felrapporter (Inställningar → *Skicka feedback* och *Mina ärenden*), som knappen *Feedback* i webben:
  typ, *Gäller* (förvalt efter skärmen du var på), meddelande och teknisk information med *Visa vad som skickas med*.
  *Mina ärenden* visar status och teamets svar, och där svarar du när teamet ber om mer information. Går en film inte
  att spela finns *Rapportera felet* i spelaren. På Apple TV skrivs texten med tvOS tangentbord (eller iPhone och
  diktering). En administratör läser ärendet innan det skickas vidare
- bildtoken (bilder laddas via adress med `?t=`) sparas i nyckelringen per server och profil och förnyas bara när
  mindre än ett dygn är kvar eller servern svarar 401 på en bild (affischer, titelsidans bakgrund, omslag, ljudböcker,
  poddar och kanallogor) – en ny token vid varje start skulle knuffa ut andra apparnas (servern sparar högst 50 per
  användare)
- snabb spolning i en omkodad film: spolar du utanför det som är laddat startar appen om strömmen vid målet, med korta
  segment där (`/playback` med `start` och `prev`, servern stoppar den gamla omkodningen), som webben och de andra
  apparna. Ljudspår, undertext, hastighet och paus behålls. På Apple TV samlas klicken åt höger/vänster: omstarten
  väntar 0,6 s på nästa klick; på iPhone/iPad väntar den 0,3 s (reglaget som drar ger ett hopp var 0,25 s). AVPlayer
  visar inte serverns `X-Seg-Ready`, så appen frågar `GET /api/stream/:id/hls/ready` var 4:e sekund medan filmen
  spelar (som Expo-appen) och använder svaret om det är högst 8 s gammalt och frågades före spolningen. Utan svar
  (äldre server, inget nät) gissar den ur bufferten vad servern redan kodat. Apple TV skickar inte `nhls=1` (då blir Dolby Digital i TS AAC), så appen lägger själv till `xs` i
  strömmens adress och spelaren börjar vid målet (`EXT-X-START`). Reglerna: `Shared/SeekCore.swift`
- *Rapportera felet* även i live-TV-spelaren
- snabbare start: titelns uppgifter och `/playback` hämtas samtidigt (inte efter varandra), och bio-läget (`cinema=1`
  vid start från början) avgör servern – appen frågar inte `/api/me/cinema` först. På Apple TV förbereder servern
  strömmen när fokus stått 0,7 s på *Spela*, *Fortsätt*, *Börja om*, nästa avsnitt eller ett avsnitt
  (`/playback?warm=1`), på iPhone/iPad när titelsidan öppnas – med exakt samma fråga som uppspelningen, så att den
  tar över strömmen. En ström som aldrig används (spelaren stängdes, titeln gick inte att hämta) stoppas med `pid`.
  Ljudspåret på titelsidan är profilens förval (`defaultAudio`) och skickas inte till servern – den väljer profilens
  språk; ett eget val skickas. Samma regler som Android-appen. Reglerna: `Shared/StartCore.swift`, anropen:
  `Shared/Start.swift`
- uppkopplingen utanför hemmet: när servern ser anslutningen som *utanför hemmet* och appen inte går via
  hemadressen mäter appen i bakgrunden hur snabbt servern kan skicka hit (4 MB från `/api/speedtest`, högst 1 s,
  takten efter första tredjedelen – som webben) när appen öppnas, kommer tillbaka och när nätet byts. Under
  uppspelningen ersätts provet av AVPlayers egen mätning (`accessLog`, `observedBitrate`). Takten skickas som `bw`
  till `/playback`, så att servern listar ett startsteg som ryms först (AVPlayer börjar på första varianten) och
  förbereder just det. En mätning gäller i 10 minuter och bara på samma nät; utan färsk mätning skickas inget och
  starten väntar aldrig på provet (då gäller serverns gissning). Förvärmningen och uppspelningen skickar samma `bw`
  (förvärmningens värde i 20 s, även inget). Hemma mäts ingenting. Reglerna: `Shared/BwCore.swift`, anropen:
  `Shared/Bandwidth.swift`

## Bygga och installera (kräver en Mac)

1. Installera **Xcode** (gratis i App Store) och **XcodeGen**:
   ```bash
   brew install xcodegen
   ```
2. Generera projektet:
   ```bash
   cd apps/apple
   xcodegen generate
   open BraXhnTV.xcodeproj
   ```
3. I Xcode, gå till target **BraXhnTV-iOS** (eller **BraXhnTV-tvOS**) → *Signing & Capabilities* och välj ditt **Team**. Det fungerar med ett gratis Apple-ID.
4. Anslut iPhone/iPad med kabel, eller välj din Apple TV under *Window → Devices and Simulators* (para ihop den via *Inställningar → Fjärrappar och enheter* på Apple TV). Tryck **▶ Run**.
5. Starta appen och ange serveradressen, t.ex. `192.168.1.10:8420` eller `https://tv.dindomän.se`.
   Utan `http://`/`https://` provar appen själv: en IP-adress eller ett namn i hemnätet (`tower`, `nas.local`) med
   `http://` och port 8420 först, ett domännamn (t.ex. BraXhn Relay, `tv.dindomän.se`) med `https://` först.
   Via BraXhn Relay fungerar inloggning, strömning, bilder och AirPlay som hemma, men servern ser anslutningen som
   *utanför hemmet* (syns under Inställningar) och kvaliteten kan vara begränsad.

### Hemma men sparad med den publika adressen

Är appen sparad med reläets adress eller en domän och står hemma, frågar den servern efter dess adress på hemnätet och
provar den i bakgrunden (högst 0,8 s) när servern öppnas, när appen kommer tillbaka till förgrunden och när nätet byts.
Svarar den rätt går anrop, filmer, musik och bilder direkt dit – hemmets kvalitet och ingen omväg via reläet – och
*Inställningar* visar *Hemma: direkt via http://192.168.1.10:8420*. Utanför hemmet, eller när hemadressen slutar svara,
används den sparade adressen igen (filmen som spelas fortsätter där den var). Den sparade adressen ändras aldrig.
Nedladdningar på iPhone/iPad hämtas alltid via den sparade adressen, eftersom de fortsätter i bakgrunden, kanske på ett
annat nät. Servern måste känna sin hemadress (se *Hemma men via den publika adressen* i huvud-README).

Första gången frågar iPhone/iPad om appen får hitta enheter i det lokala nätverket. Svarar du nej används alltid den
sparade adressen (ändras under *Inställningar → Integritet och säkerhet → Lokalt nätverk*).

**Säkerhet:** inloggningen, bildtoken och strömlänkar går bara till den sparade adressen eller till en hemadress som
bevisat att den är just den här servern (provet besvaras bara på hemnätet). http provas bara mot adresser i hemnätet,
provet skickas utan inloggning och följer inga omdirigeringar, och byts nätet slutar appen använda hemadressen innan
nästa förfrågan. Koden: `Shared/LocalPick.swift` (valet, bara Foundation) och `Shared/Hemma.swift` (när och vart).

### Raden "Stöd projektet" (bara egna byggen)

Apples regler (App Store Review Guidelines 3.2.1(vi)) tillåter bara donationer till godkända ideella organisationer.
Raden *Stöd projektet* under Inställningar finns därför bara när appen byggs med Swift-flaggan `DONATION_LINK`, som är
**av** som standard. Slå på den i ditt eget bygge genom att lägga till under `settings: base:` i `project.yml`:

```yaml
    SWIFT_ACTIVE_COMPILATION_CONDITIONS: "$(inherited) DONATION_LINK"
```

(eller `xcodebuild … SWIFT_ACTIVE_COMPILATION_CONDITIONS='$(inherited) DONATION_LINK'`). Länken kommer från serverns
`donateUrl` i `/api/status` och visas bara om den är `https://` till paypal.com eller paypal.me – aldrig för
barnprofiler, aldrig på Apple TV och aldrig som en ruta. Sätt inte flaggan i ett bygge som skickas till App Store eller TestFlight.

## Om Apples signering

| Konto | Kostnad | Giltighet |
|---|---|---|
| Gratis Apple-ID | 0 kr | Appen fungerar i **7 dagar**, sedan installerar du om från Xcode. Max 3 egna appar per enhet. |
| Apple Developer Program | 99 USD/år | Appen gäller i ett år. Du kan dela den via **TestFlight** med familj och vänner, upp till 100 interna testare. |

## Top Shelf på Apple TV

Top Shelf (raden högst upp när appen är markerad på hemskärmen) visar bara den fasta bilden i
`App Icon & Top Shelf Image`, inte *Fortsätt titta*. Ett dynamiskt Top Shelf kräver ett eget tillägg
(TV Top Shelf Extension) som själv hämtar listan från servern. Tillägget kör i en egen process och kommer inte åt
appens inloggning utan en **App Group** eller delad nyckelring – och det kräver att du lägger till den förmågan
under *Signing & Capabilities* för både appen och tillägget, med ett eget app-id för tillägget. Med ett gratis
Apple-ID räcker inte alltid de app-id som får skapas per vecka, och misslyckas signeringen av tillägget går inte
appen att installera alls. Därför är det inte byggt – hellre en app som alltid går att installera.

## Kontrollera att koden bygger

Workflowet `.github/workflows/apple.yml` kompilerar båda målen på GitHubs macOS-maskiner vid varje push, utan signering. Koden är skriven och granskad, men **har inte kompilerats** i miljön där den skapades eftersom Xcode saknades där. Kör workflowet, eller bygg i Xcode, och rätta eventuella kompileringsfel.

Det finns inga XCTest-mål. Valet av hemadress (`LocalPick`), Feedbacks regler (`FeedbackCore` i `Feedback.swift`),
de sparade bildtoken (`ImageTokenBook` sist i `AppModel.swift`), spolningen (`SeekCore`) och nedladdningarna per profil
med kön för positioner och skärmtiden utan nät (`OfflineCore.swift`) är rena typer utan nät och
vyer, så att ett testmål kan läggas till för dem utan att något annat behöver ändras. `test/apple-i18n.test.js` (Node,
utan Xcode) kontrollerar att varje svensk text i koden har en engelsk rad i `en.lproj/Localizable.strings` och att
Feedbacks områden är serverns; `test/apple-seek.test.js` att spolningens gränser och frågan till `/hls/ready` är
desamma som i Expo- och Android-appen; `test/apple-offline.test.js` att nedladdningarnas, köns och skärmtidens regler
är Android-appens och att appen använder dem (profilens lista, utloggningen, kön med `at`, skärmtiden i
nedladdningsspelaren, serverns besked och kön som lämnar in tiden utan nät); `test/apple-next.test.js` att nästa
avsnitt följer kontots val med webbens regler och förvärms med samma fråga; `test/apple-screenleft.test.js` att tiden
kvar och varningen räknas och skrivs som i webben och Android-appen; `test/apple-bw.test.js` att uppkopplingen mäts
som i webben, bara utanför hemmet, och att förvärmningen och uppspelningen skickar samma `bw`. Nästa avsnitt (`NextCore.swift`) och tiden kvar
(`ScreenLeftCore.swift`) och uppkopplingen (`BwCore.swift`) är också rena typer.
