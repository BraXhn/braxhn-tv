# Ändringar

## Ej utgiven
- Ny logotyp (räls mot en linuxserver, X som andreaskors) i webben, som appikon i iOS, Android och Google TV, och som appikon och topphylla på Apple TV
- Installerbar app på telefonen: manifest med ikoner, service worker (startar även utan kontakt med servern), "Installera som app" i menyn, meny längst ner på telefon, anpassad spelare och kompakt litet fönster
- Rättat: många filmer startade inte när de omkodades (spelaren gav upp efter 10 s och bytte kvalitetssteg, vilket startade om omkodningen). Spelaren väntar nu upp till 60 s, och flera kvalitetssteg används bara utanför hemmet
- Bättre matchning mot TMDB: titlar på två språk, ett ord för mycket, "01" i stället för "del 1", utgåvetillägg (Director's Cut, Extended) och kvalitetsord (1080p, BluRay, x264) – och hellre ingen träff än fel film. Titlar som tidigare inte hittades försöker igen
- Dubbletter (samma film i flera kvaliteter eller med olika filnamn) slås ihop till en film; servern väljer fil efter önskad kvalitet
- Filmbiblioteket visar filmer i samma samling som ett samlingskort (kan stängas av med "Alla filmer")
- Ny spelare: egen kontrollrad med tidslinje, titel och tid, ⏮ ⟲10 ▶ ⟳30 ⏭ ⏹, inställningar (kvalitet, ljud, undertexter), volym och helskärm – visas vid paus eller när musen rör sig. Inga dubbla tidslinjer längre
- Litet fönster: filmen fortsätter i en rad längst ner medan man bläddrar (← Tillbaka, Escape eller Bakåt); klicka på bilden för att gå tillbaka till helskärm, ⏹ stoppar
- Rättat: skanningar och "Hämta om all metadata" fick vänta i timmar bakom tunga analyser (miniatyrer, nyckelbilder, intro, förhandsbilder). Analyserna körs nu i en egen bakgrundskö, och adminsidan visar båda köerna
- Kopierade Blu-ray-skivor (`BDMV/STREAM/*.m2ts`) blir en film med skivans namn – varningstexter, loggor och andra klipp på skivan skannas inte längre in som egna titlar (de som redan finns tas bort vid nästa skanning)
- Rättat: containern startade inte (avslutades direkt utan begriplig logg) när omkodningsmappen var en monterad volym – nu töms bara innehållet
- Unraid-mallen har fått *Port i containern*, så att servern kan köras med egen IP-adress (Custom: br0) på t.ex. port 80
- Anpassningsbar kvalitet (ABR): vid omkodning med automatisk kvalitet kan spelaren växla ner till 720p/480p när nätet blir sämre
- Flera versioner av samma film (t.ex. 4K och 1080p) visas som en film; servern väljer bästa versionen per enhet och webben har en versionsväljare
- Rollista och personsidor från TMDB, och sökning på personer; apparna visar rollistan i detaljvyn
- Trailers: lokala trailerfiler spelas från titelsidan (och skannas inte längre in som egna filmer), TMDB-trailern öppnas på YouTube
- Årssammanfattning ("Ditt år") per person
- Live-TV: pausa och spola tillbaka (timeshift, standard 2 timmar) med disktak och Live-knapp
- Inspelningar: reklamavbrott hittas i bakgrunden och kan hoppas över med en knapp eller automatiskt
- Sovtimer i webben, iOS/tvOS och Android/bil
- Jämn ljudnivå i musik (ReplayGain/R128, annars mätning i bakgrunden)
- Låttexter från .lrc eller taggar, synkade i webben
- Smarta spellistor i webben, iOS och bilen
- Inställbara hopp för ljudböcker och poddar; hoppa över tystnad i poddar på Android
- Skärmtid för profiler med "Tiden är slut för idag"-skärm
- Följ serier: "Nytt för dig" i webben och apparna, och personliga notiser om nya avsnitt via ntfy eller webhook
- Automatisk offline-synk av nästa osedda avsnitt i iOS- och Android-appen
- Diskövervakning med notiser och tidigare städning av omkodningsmappen
- Import av tittarhistorik från Plex och Jellyfin/Emby
- Prometheus-mätvärden på /metrics
- DLNA/UPnP för smart-TV utan app (avstängt som standard)

## 0.5.1
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
- Serier med samma namn men olika år ("Doctor Who (1963)" och "(2005)") hålls isär; serier som redan slagits ihop delas upp vid nästa skanning
- Två enheter på samma konto kan titta på samma titel samtidigt utan att stoppa varandras omkodning
- Webben: låtar, kapitel, träffar i TV-guiden och mappväljaren går att välja med tangentbord och fjärrkontroll; Bakåt stänger spelaren; TV-guiden går att bläddra ett dygn bakåt
- iOS: nedladdningar som blir klara i bakgrunden sparas direkt, inte först när appen öppnas

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
