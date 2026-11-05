# BraXhn TV för iPhone, iPad och Apple TV

En och samma SwiftUI-app för iOS/iPadOS 16+ och tvOS 16+.

**Funktioner**
- inloggning mot din server
- hem med *Fortsätt titta*
- bibliotek och sök
- serier med säsonger
- val av ljudspår och undertext
- knappen *Hoppa över intro* och *Nästa avsnitt* (på Apple TV visas den i spelarens egna kontroller)
- automatiskt nästa avsnitt
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
