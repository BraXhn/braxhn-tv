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

## Om Apples signering

| Konto | Kostnad | Giltighet |
|---|---|---|
| Gratis Apple-ID | 0 kr | Appen fungerar i **7 dagar**, sedan installerar du om från Xcode. Max 3 egna appar per enhet. |
| Apple Developer Program | 99 USD/år | Appen gäller i ett år. Du kan dela den via **TestFlight** med familj och vänner, upp till 100 interna testare. |

## Kontrollera att koden bygger

Workflowet `.github/workflows/apple.yml` kompilerar båda målen på GitHubs macOS-maskiner vid varje push, utan signering. Koden är skriven och granskad, men **har inte kompilerats** i miljön där den skapades eftersom Xcode saknades där. Kör workflowet, eller bygg i Xcode, och rätta eventuella kompileringsfel.
