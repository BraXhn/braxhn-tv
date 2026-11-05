# Integritet och personuppgifter

*English below.*

**Kortversion:** BraXhn TV är ingen molntjänst. Allt sparas på din egen server, projektet får aldrig några uppgifter
från den och apparna spårar ingenting. Den som kör servern ansvarar för uppgifterna om dem som bjuds in, och
BraXhn TV har verktygen som behövs för att följa dataskyddsförordningen (GDPR).

## Vem ansvarar för vad

- **Projektet och utvecklaren** (BraXhn) samlar inte in några personuppgifter. Det finns ingen telemetri, inga
  kraschrapporter, inga konton hos oss och ingen reklam. Servern och apparna skickar aldrig något till projektet.
  Den enda kontakten är kontrollen av nya versioner, som hämtar en fil från GitHub (går att stänga av) och inte
  skickar något om dig. Donerar du via PayPal gäller PayPals villkor. Vi får bara det PayPal visar för en
  mottagare.
- **Den som kör servern** är personuppgiftsansvarig för uppgifterna om användarna. Delar du servern bara med din
  familj omfattas det normalt av GDPR:s undantag för privat bruk (artikel 2.2 c). Bjuder du in vänner eller
  andra utanför hushållet, eller kör servern i en förening eller ett företag, gäller förordningen fullt ut.
  BraXhn TV hjälper dig på följande sätt:
  - Användarna ser själva vad som sparas, hur länge och vilka tjänster som är på, under **Mitt konto → Integritet**.
  - Du anger en kontaktuppgift för frågor under **Administration → Integritet (GDPR)**.
  - Användarna kan ladda ner sina uppgifter och radera sitt konto själva.
  - Uppgifter gallras automatiskt.
- **BraXhn Relay** (fjärråtkomst) körs av den som installerar reläet. Se [Reläet](#reläet).

## Vad servern sparar

Allt ligger i databasen i `/config` på servern:

| Uppgift | Varför | Hur länge |
|---|---|---|
| Konto: namn, lösenord (som hash), e-post om den angetts, inställningar, profiler | Inloggning och dina val | Tills kontot tas bort |
| Tittande och lyssnande: position, sett/inte sett, betyg, listor, favoriter | Fortsätta där du var | Tills kontot tas bort |
| Tittarhistorik: vad, när, enhet, kvalitet, IP-adress | Min historik, statistik, föräldraöversikt | 365 dagar (inställbart, 0 = för alltid). **IP-adressen tas bort efter 90 dagar** |
| Inloggade enheter: enhetstyp, IP-adress, senast aktiv | Visa och logga ut enheter | Tills du loggar ut eller inloggningen går ut |
| Säkerhetsloggen: inloggningar, misslyckade försök, ändringar, IP-adress | Upptäcka intrång | 180 dagar (inställbart 30–3650) och högst 5000 rader |
| Kopplingar du själv gör (Trakt, Last.fm, ListenBrainz, musikappar, OPDS, kalender) | Funktionen du slagit på | Tills du kopplar bort eller kontot tas bort |
| Säkerhetskopior av databasen | Återställning | De senaste 14 (inställbart) |

Webbläsaren sparar bara inloggningskakan och lokala val som språk, volym och tillgänglighet. Det finns inga kakor
eller skript från tredje part för spårning eller reklam.

## Externa tjänster

Servern kontaktar externa tjänster bara för funktioner som är påslagna, och då bara med det som behövs, till
exempel titel och år för att hitta en affisch, aldrig vem som tittar. Hela listan finns i
[README](README.md#integritet). Användarna ser vilka som är på under *Integritet* i webben.

**Bilder från TMDB** går via servern (`/api/tmdbimg`), så hushållets webbläsare kontaktar aldrig TMDB.
Content-Security-Policy spärrar det dessutom. Ett undantag finns: i Chrome laddar webbläsaren Googles
Cast-bibliotek när spelaren öppnas, för knappen Casta.

## Dina rättigheter (för den som använder en server)

Du har rätt till tillgång, rättelse, radering, dataportabilitet och att invända. Det mesta gör du själv:

- **Ladda ner mina uppgifter** under *Mitt konto → Integritet*. Du får en JSON-fil med allt servern sparat om
  kontot och dess profiler, utan lösenord, PIN-koder och nycklar.
- **Radera mitt konto** på samma ställe, gäller vanliga konton. Profiler tas bort av huvudkontot, och
  administratörer av en annan administratör.
- **Min historik**, där du ser och tar bort rader.
- **Mitt konto**, där du ändrar dina uppgifter.

När ett konto tas bort, av användaren själv eller av en administratör, försvinner också dess tittarhistorik.
Namnet, IP-adressen och kopplingen till kontot tas bort ur säkerhetsloggen och ur rader som finns kvar av andra
skäl, som önskemål och inbjudningar. Gamla säkerhetskopior innehåller uppgifterna tills de roteras bort.

Frågor om dina uppgifter ställer du till den som kör servern. Kontaktuppgiften finns under *Integritet*. Har
du klagomål kan du vända dig till Integritetsskyddsmyndigheten (IMY) eller dataskyddsmyndigheten i ditt land.

## Apparna (iPhone, iPad, Apple TV, Android, Google TV och bilen)

- Apparna pratar **bara med din egen server**, den adress du anger. De innehåller ingen analys, reklam,
  kraschrapportering eller spårning från tredje part.
- På enheten sparas serveradressen, inloggningen och inställningarna. Inloggningen sparas i iOS Nyckelring och
  i appens privata lagring på Android. Där ligger också nedladdningar för offline.
- Apple: appen har ett integritetsmanifest (`apps/apple/Shared/PrivacyInfo.xcprivacy`) som anger att den inte
  spårar och inte samlar in några uppgifter.
- Utvecklaren får inga uppgifter från apparna. Det som skickas till servern stannar hos den som kör servern.

## Reläet

BraXhn Relay vidarebefordrar krypterad trafik mellan klienter utanför hemmet och hemservern.

- **Vad reläet ser:** reläet sparar namn och id för parade servrar och en hemlig nyckel per server. Klientens
  IP-adress skickas vidare till hemservern, så att inloggningsskyddet fungerar.
- **Vad reläet inte loggar:** det loggar varken vad som tittas på eller vilka sidor som besöks. Loggen innehåller
  bara när hemservrar ansluter och kopplas från, med serverns IP-adress, samt misslyckade parningsförsök.
- **Loggrotation:** Docker-loggen roteras (`relay/docker-compose.yml`).
- **Ansvar:** den som kör ett relä åt andra är personuppgiftsbiträde för den trafiken.

## Barn

Barnprofiler skapas av huvudkontot och har ingen egen inloggning med e-post. Barnprofiler kan inte sudda ut sin
historik, eftersom föräldern ser den i föräldraöversikten. De visar aldrig länken *Stöd projektet*.

## Säkerhetsincidenter

Säkerhetsbrister i BraXhn TV rapporteras enligt [SECURITY.md](SECURITY.md). Den som kör en server och drabbas av
en personuppgiftsincident som omfattas av GDPR ansvarar själv för att anmäla den till IMY inom 72 timmar, när
det krävs.

---

# Privacy and personal data

**Summary:** BraXhn TV is not a cloud service. Everything is stored on your own server, the project never receives
any data from it and the apps don't track anything. Whoever runs the server is responsible for the data about the
people they invite, and BraXhn TV has the tools needed to comply with the GDPR.

- **The project and its developer** collect no personal data:
  - no telemetry, crash reports, accounts or ads;
  - the only contact is the update check, which downloads a file from GitHub (it can be turned off) and sends
    nothing about you;
  - donations via PayPal are covered by PayPal's terms.
- **The person running the server** is the data controller:
  - Sharing only with your family is normally covered by the GDPR's household exemption (Article 2(2)(c)).
  - Inviting friends or others outside the household, or running the server for an association or a company,
    brings the regulation fully into scope.
  - Users can see what is stored, for how long and which external services are on under **My account → Privacy**.
  - Admins set a contact under **Administration → Privacy (GDPR)**.
- **What is stored, and for how long:** see the table above.
  - Watch history: 365 days, configurable. IP addresses in the history are removed after 90 days.
  - Security log: 180 days, configurable from 30 to 3650 days, and at most 5000 rows.
  - Signed-in devices: until you sign out or the sign-in expires.
  - Backups: the latest 14, configurable.
- **Your rights:** under *My account → Privacy* you can do the following yourself:
  - **Download my data** as a JSON file without passwords, PINs or keys.
  - **Delete my account**, for regular accounts. Profiles are removed by the main account, and administrators by
    another administrator.

  Deleting an account also removes its watch history and its name, IP address and link in the security log and
  in rows kept for other reasons. Old backups keep the data until they are rotated out.
- **TMDB images** are fetched by the server (`/api/tmdbimg`), so browsers never contact TMDB.
  - The exception is Google's Cast library, which Chrome loads when the player opens.
  - The full list of external services is in the [README](README.en.md#privacy).
- **The apps:**
  - They only talk to your own server and contain no third-party analytics, ads, crash reporting or tracking.
  - The sign-in is stored in the iOS Keychain or in the app's private storage on Android.
  - The Apple apps include a privacy manifest declaring no tracking and no data collection.
  - The developer receives no data from the apps.
- **The relay:**
  - It forwards encrypted traffic and passes the client's IP address on to the home server.
  - It logs neither what is watched nor which pages are visited. The log only has home servers connecting and
    disconnecting, with the server's IP address, and failed pairing attempts.
  - Its Docker log is rotated.
  - Whoever runs a relay for others is a data processor for that traffic.
- **Security incidents:** report vulnerabilities as described in [SECURITY.md](SECURITY.md). A server owner
  affected by a personal data breach covered by the GDPR is responsible for notifying their supervisory
  authority within 72 hours, where required.
