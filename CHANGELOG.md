# Ändringar

## Ej utgiven
- Stabilitet: servern kraschar inte längre när ett live-segment, en inspelning eller ett poddavsnitt raderas under uppspelning, och avbrutna spolningar lämnar inga öppna filer
- Omkodning/remux pausas när den ligger långt före spelaren – en 4K-film fyller inte längre disken på några minuter
- Säkerhet: profilernas sessioner loggas ut tillsammans med kontot, passkey-data kan inte längre stoppa servern, barnprofiler kan inte byta till en profil med högre åldersgräns utan lösenord, och att lägga till en passkey kräver tvåstegskod när 2FA är på
- En trasig säkerhetskopia byts aldrig in vid återställning
- Ljudböcker tas inte bort när en mapp tillfälligt inte går att läsa; filer där ffprobe misslyckades läses om vid nästa skanning
- Poddar: manuellt nedladdade avsnitt raderas inte efter 15 minuter, och datum med CEST/BST tolkas rätt
- Webben: titelsidan räknas inte som uppspelning, musikbaren stoppar ljudet helt, menyn kommer tillbaka efter Bakåt
- iOS/tvOS: poddlistan visas igen
- Android: nedladdningar kan spelas utan nät från Inställningar, spelade låtar räknas, och byte av ljudspår eller undertext lämnar ingen omkodning kvar på servern
- Musik- och ljudboksbibliotek visas inte längre som tomma rutnät i apparna

## 0.5.0
- Notiser till mobilen (ntfy, Pushover, Gotify, Discord, Telegram, webhook) vid attacker, spärrade konton, certifikat- och backupproblem
- Servern talar om när en ny version finns
- Manuell matchning ("fel film?"), anime med absolut avsnittsnumrering
- Undertexter laddas ner automatiskt vid skanning, på flera språk
- Kapitel och val av ljudspår/undertexter i apparna
- Krypterade säkerhetskopior till annan mapp eller S3-kompatibel lagring (Backblaze B2, Wasabi, MinIO, AWS)
- Sonarr/Radarr: direkt skanning via webhook och önskemål av filmer och serier från appen
- Trakt: synk av sett-status och scrobbling
- Ljudböcker (kapitel, position) och poddar (RSS)
- Live-TV och inspelning (HDHomeRun och M3U/XMLTV)
- App för Google TV/Android TV

## 0.4.0
- Let's Encrypt inbyggt, passkeys
- Musik, profiler med åldersgräns, titta tillsammans, offline-nedladdning
- HEVC/HDR/Dolby Vision-remux, förhandsbilder vid spolning, hoppa över sammanfattning
- Statistik, säkerhetskopior, filbevakning

## 0.3.0
- Säkerhet för internet: 2FA, spärrar, hashade token, säkerhetslogg
