# Ändringar

## Ej utgiven
- **Kanaler för uppdateringar:** `:latest` uppdateras nu bara när en version ges ut (stabil), `:beta` för förhandsversioner och `:edge` vid varje ändring. Utgåvor ges ut med en knapp i GitHub Actions och får en release med ändringsloggen, så att servern kan visa "ny version finns"
- **Testsamling för mediahanteringen** (`test/conformance.test.js`, `test/media/`): syntetiska källor i de vanligaste formaten (HDR10, HLG, Dolby Vision-märkt HEVC, H.264 High 10, VP9, MPEG-4, flätad MPEG-2, anamorf bild, VFR, 50 bilder/s, DTS/TrueHD/E-AC-3/FLAC/Opus, flera ljudspår, SRT/ASS/PGS) spelas med klientprofiler för Chrome, Safari, iOS-/tvOS-appen, Android och utanför hemmet, och varje HLS-ström kontrolleras med ffprobe. En snabb delmängd ingår i `npm test`; hela matrisen körs i det nya arbetsflödet `conformance.yml` på Linux (samma ffmpeg som Docker-imagen) och på macOS med AVPlayer och WebKit. Se `docs/testsamling.md`
- Rättat: DTS-, TrueHD- och FLAC-surround i H.264-filmer blev E-AC-3 i TS-segment för Safaris egen HLS-spelare (iPhone), som inte startar då – ljudet blir nu AAC där, som för Dolby Digital
- Rättat: efter spolning i en omkodad film med orört ljud (AAC/AC-3) innehöll första segmentet upp till flera sekunder ljud från före spolpunkten, som överlappade föregående segment
- Rättat: efter spolning i en remuxad film där ljudet konverteras (t.ex. AC-3/DTS → AAC) saknades ljudet de första ~0,25 s av segmentet
- Rättat: första segmentet vid omkodning kunde överlappa nästa (AAC-ljudets inledande ram gav negativ tid och TS-muxern sköt fram segmentet) – vid 50 bilder/s en hel bild, som Chrome kan avbryta på
- Rättat: BANDWIDTH i mastern för omkodning med kvalitetsgräns räknade bara med bildens tak; segmenten låg upp till 20 % över. Nu samma värde som i ABR-mastern (tak + marginal + ljud)
- Rättat: flätade filmer (t.ex. MPEG-2 från DVB/DVD, 1080i) omkodades utan avflätning och fick kam i bilden. Gäller filer som skannats efter uppdateringen
- Rättat: efter spolning i remuxade och omkodade filmer blev segmenten fel i Docker-imagen (Debians ffmpeg 5.1): ett segment per nyckelbild i stället för var 6:e sekund, så spellistan inte stämde och uppspelningen kunde hacka eller hoppa. ffmpeg 5.1 och 6.x tolkar delningstiderna olika; servern testar nu vid start vilket som gäller
- iOS-appen anger att den spelar med Apples egen HLS-spelare (`nhls=1`), så att Dolby Digital inte skickas i TS-segment till iPhone/iPad (samma fel som i Safari). tvOS-appen skickar fortfarande Dolby Digital orört

## 0.9.3
- Rättat: HDR-filmer som omkodades till SDR kom aldrig igång ("Startar omkodning…"). Efter avkodning på grafikkortet saknar bilderna ofta färginformation och tonmappningen stannade med "no path between colorspaces". Källans färgegenskaper sätts nu uttryckligen. Felet räknades dessutom som ett hårdvarufel, så NVENC stängdes av till nästa omstart – det gör det inte längre

## 0.9.2
- Rättat: på iPhone kunde flikmenyn längst ner (och ljudspelaren) hamna mitt på skärmen när man skrollade, t.ex. efter att tangentbordet varit uppe. De följer nu den synliga ytans nederkant, och flikmenyn göms medan tangentbordet visas

## 0.9.1
- Rättat: HDR-filmer som omkodades (t.ex. utanför hemmet eller med vald kvalitet) gav "avkodningsfel" på iPhone. Omkodningen blir H.264 i 8 bitar, men bilden märktes fortfarande som HDR (PQ/BT.2020) när skärmen klarar HDR – en kombination som iPhone inte spelar. HDR tonmappas nu alltid till SDR vid omkodning och märks som BT.709 (remux utan omkodning behåller HDR som förut)

## 0.9.0
- Strömning utanför hemmet: webbspelaren mäter uppkopplingen (i förväg och vid start, högst 1,5 s) och servern väljer kvalitet efter vad som ryms – aldrig över inställd maxkvalitet. "Spara data" i telefonen ger högst 480p
- Anpassningsbar kvalitet har fått ett 360p-steg, och steget som ryms i uppkopplingen listas först (iPhone börjar på första varianten i stället för att fastna på ett för tungt steg). Spelaren hämtar aldrig högre upplösning än skärmen visar
- Omkodning med kvalitetsgräns kodar kvalitetsstyrt med tak (x264 CRF, NVENC VBR) i stället för fast bithastighet: lugna scener tar mindre bandbredd med samma bild
- Utanför hemmet blir ljudet AAC stereo 128 kbit/s vid omkodning (surround/Dolby tog 0,4–0,6 Mbit/s av uppkopplingen)
- **Bilder i rätt storlek:** affischer, bakgrunder, avsnittsminiatyrer, samlings- och personbilder samt omslag till musik, ljudböcker och poddar kan hämtas nedskalade med `?w=` (`/api/image/…`, `/api/collection-image/…`, `/api/people/:id/image`, `/api/music/cover/…`, `/api/audiobooks/cover/…`, `/api/podcasts/:id/image`). Bredden avrundas uppåt till 160, 240, 320, 480, 720 eller 1280 px; andra värden ignoreras och ger originalet, som också skickas när det redan är smalare (ingen förstoring) eller om skalningen misslyckas. Varje storlek görs en gång med ffmpeg (högst två åt gången) och sparas i `cache/img`; byts bilden görs nya storlekar och de gamla tas bort. Behörighet och åldersgränser är oförändrade
- Webben ber om bilder efter hur stora de visas (kortstorleken, skärmens pixeltäthet upp till 2×): på en telefon blir en affisch t.ex. 320 px (18 kB i stället för 39 kB med testbilden), på datorn 160 px. Bakgrunden överst på titelsidor hämtas i skärmens bredd. Omslag i listor (38–52 px) hämtas i 160 px

## 0.8.2
- Rättat: efter en uppdatering kunde webbläsaren visa den nya sidan med den gamla stilmallen (cachad i en timme), så att layouten blev helt trasig. Stilmall och startmodul har nu versionsnummer i adressen, och appens filer kontrolleras mot servern vid varje besök (ETag – oförändrade filer laddas inte om)

## 0.8.1
- Förhandsbilderna för spolning skapas mycket snabbare: med filmens nyckelbilder kända hoppar ffmpeg direkt till en bild var 10:e sekund i stället för att läsa hela filen och avkoda varje nyckelbild (för en stor 4K-film från många minuter till under en minut). Två filmer bearbetas samtidigt

## 0.8.0
- **Nytt utseende i Plex-stil** i webben: mörkare neutral bakgrund och tätare text, smal **sidomeny** med ikoner (Hem, ett val per bibliotek, Live-TV/Poddar och *Mer*; ☰ visar namnen och valet sparas), menyrad med rubrik, sidflikar (Hem, Min lista, Önskningar, Statistik), sök, aktivitet och ett **reglage för kortstorlek** (sparas i webbläsaren). På telefon ligger biblioteken som knappar under sökfältet och flikmenyn finns kvar längst ner
- Startsidan består av **hyllor** som skrollar i sidled med ‹ › (bläddrar en sida, inaktiva vid ändarna) och fäster vid korten; piltangenter/D-pad flyttar mellan korten och raderna
- Nya **affischkort**: titel, år/avsnittstitel/antal säsonger och "S3 · A23" under bilden, tunn framstegslinje, märke med antal osedda avsnitt eller ✓, och vid hovring/fokus ▶ (spelar direkt – serier nästa avsnitt), ✎ (redigera, administratörer) och ⋮
- **Nyligen tillagda** i seriebibliotek visar ett kort per serie och säsong med nyaste avsnittet och antal nya; kortet öppnar rätt säsong (`#/item/:id/:säsong`). API: `GET /api/home` har fått `rows[].seasons` för seriebibliotek, serier har `seasons` (antal säsonger) och avsnitt `showPoster`/`showThumb` – befintliga fält är oförändrade

## 0.7.0
- "Håll mig inloggad i 30 dagar" vid inloggning (även med passkey). Valt: inloggningen gäller i 30 dagar räknat från senaste besöket (kakan förnyas). Ej valt: webbläsaren glömmer inloggningen när den stängs, och den går ut efter 12 timmar utan aktivitet. Valet sparas till nästa gång och följer med vid profilbyte
- Pågående jobb (skanning, analys, omkodning, inspelning, nedladdning, undertexter, nyckelbilder) finns för administratören via `/api/jobs`
- **Snabbåtgärder på korten**: ⋮ på varje affisch (hovring, högerklick, långtryck på telefonen, Menu-tangenten/Shift+F10 på tangentbord och fjärrkontroll) öppnar en meny med spela/fortsätt, sedd/osedd (även hela säsongen), Min lista, *Ta bort från Fortsätt titta*, följ serien, titta tillsammans, ladda ner och – för administratörer – uppdatera metadata, fel titel, redigera och analysera intro igen. Kortet ändras direkt och det mesta går att ångra i meddelandet. På telefon visas menyn som ett ark nerifrån
- Nytt i API:t: `GET /api/items/:id/state` (Min lista, följer, nästa avsnitt) och `POST /api/items/:id/continue` (tar bort en titel ur Fortsätt titta utan att markera den som sedd, med ångra). Barnprofiler kan inte nå titlar över åldersgränsen – inte heller längre via `POST /api/items/:id/watched`
- **Aktivitet** i menyraden för administratörer: en ring runt ikonen medan servern skannar, analyserar, kodar om eller spelar in, och en panel med förloppet (bygger på `GET /api/jobs`)
- Webbgränssnittet har fått gemensamma komponenter (`web/js/ui/`, se `docs/ui-komponenter.md`): alla `confirm()`/`prompt()` är ersatta med riktiga dialoger som fungerar med fjärrkontroll, i installerad app och med skärmläsare (PIN och lösenord i dolda fält, Avbryt i fokus vid borttagning, Escape stänger, fokus tillbaka); skelett i sidans form medan den laddas; enhetliga tomma lägen och fel med *Försök igen*; meddelanden med Ångra som läses upp; alla ikonknappar har namn; flikar med piltangenter; minst 44 px stora mål på pekskärm

## 0.6.1
- Rättat: undertexter som slogs på mitt i en film syntes inte (eller först efter flera minuter). Ett inbäddat spår lästes från filmens början och skickades först när hela filen var läst – för en stor film tar det minuter. Nu läses spåret där tittaren är (text och Blu-ray/PGS), visas inom någon sekund och fylls sedan i medan man tittar; efter spolning läses det nya stället direkt. Färdiga spår sparas som förut

## 0.6.0
- Omstrukturering utan ändrad funktion: serverns routes är uppdelade per område (`server/routes/`) med säkerhetsmodellen samlad i `server/http/router.js`, och webbklienten är uppdelad i ES-moduler (`web/js/`)
- Drift: segment långt bakom uppspelningen tas bort (en hel film hamnar inte längre i /transcode, som ofta ligger i RAM); säkerhetskopia av databasen före varje uppgradering (`backups/före-uppgradering-*.db`) och varning om en äldre version startas mot en nyare databas; containern startar snabbare (ägarbyte bara på filer som behöver det); ordnad avstängning (omkodningar stoppas, databasen stängs); tidsstämplar i loggen; hälsokontrollen frågar databasen; tidszon (`TZ`, standard Europe/Stockholm) för skärmtid, inspelningar och nattliga säkerhetskopior
- CI: imagen röktestas (startas, hälsokontroll, integritetskontroll, ffmpeg) innan den publiceras, bygget cachas och varje version får även en `sha-`-tagg att gå tillbaka till
- Snabbare: gzip och ETag för webbappen, JSON och bilder (biblioteket med 4 000 filmer: 1,4 MB → 95 kB), "Nästa avsnitt" på startsidan, långa bibliotek ritar bara synliga kort
- Spelaren stängs vid utloggning, utgången inloggning och profilbyte (en barnprofil kunde annars titta vidare på en film som spelades i litet fönster); efter ny inloggning kommer man tillbaka till sidan man var på; uppspelningsfel försöks igen högst några gånger och visar sedan ett begripligt fel
- Ingen kontakt med servern visar "Servern svarar inte" med en Försök igen-knapp; tydlig fokusmarkering för tangentbord och fjärrkontroll; stöd för "minska rörelse"; inga sidor går att skrolla i sidled på telefonen; tomma vyer för musik och ljudböcker utan bibliotek; "Spela in serien" har två tydliga knappar i stället för en fråga där Avbryt betydde något
- Filnamn: å/ä/ö från macOS (SMB) går att söka på och slås ihop rätt, "Film cd1/cd2" blir delar i stället för versioner, dubbelavsnitt "S01E01E02" och "The 100 - 101" i en säsongsmapp tolkas rätt; inspelningar får rätt datum i filnamnet efter midnatt
- Rättat: omkodade filmer kunde stoppa i Chrome med "formatet stöds inte" (särskilt med NVENC). Segmenten överlappade i avkodningstid på grund av B-bilder; omkodningen görs nu utan B-bilder så att segmenten passar exakt ihop
- Snabbare start när filmen ändå måste omkodas (t.ex. vald kvalitet 1080p för en 4K-film): servern väntar inte längre upp till 10 s på nyckelbilder som inte behövs. En film som bakgrundsanalysen redan köat flyttas först i kön när någon trycker Spela
- Omkodning av 4K med processorn använder snabbare inställningar (x264 superfast, enklare skalning)
- Fungerar inte hårdvaruomkodningen visar loggen och Administration → Säkerhet nu en konkret åtgärd (t.ex. saknad --runtime=nvidia, för gammal drivrutin, för många samtidiga kodningar)
- Rättat: appikonerna (hemskärmen på telefonen, iPhone/Apple TV/Android-apparna) var tomma/svarta – de är omritade. Ta bort webbappen från hemskärmen och lägg till den igen för att få den nya ikonen
- Avsnitt utan nummer i filnamnet matchas mot TMDB på titel (över alla säsonger, även specialavsnitt) i stället för att få fel avsnitts namn; titlar som skrivits över återställs vid nästa skanning. Serier som inte hittades försöker igen när avsnitt tillkommer och en gång i veckan
- Snabbare start: stickproven som kontrollerar filens index körs samtidigt, och spelaren väntar högst 10 s på nyckelbilder. Loggen visar för varje uppspelning vad som valdes, hur lång tid beslutet tog, när första segmentet var klart och om servern inte hinner med
- Granskning av dataskydd: en omdöpt eller uppgraderad fil (t.ex. 720p → 1080p via Sonarr/Radarr) behåller nu framsteg, sett-markering och Min lista; omdöpta musikfiler behåller spellistor, favoriter och historik; onumrerade avsnitt behåller sitt nummer; säkerhetskopior och cachefiler skrivs atomiskt (en avbruten kopia kan inte längre tränga undan en hel); återställning godtar bara en BraXhn-databas
- Granskning av säkerhet: skadliga mediefiler kan inte längre låsa servern via undertext- eller nyckelbildstolken; barnprofiler kan inte hämta bilder från titlar över åldersgränsen; ogiltiga adresser ger 400/404 i stället för internt fel
- Snabbare start: nyckelbilderna läses ur filens eget index (MKV/MP4) på någon sekund i stället för att hela filen läses, så att filmer kan skickas utan omkodning direkt första gången. ffmpeg startas redan när man trycker Spela, och omkodning börjar med korta segment (2 s)
- Blu-ray-undertexter (PGS) visas som bilder i webbspelaren i stället för att brännas in – strömmen startar inte om och behöver inte omkodas när undertexten väljs
- Vid NVIDIA/Intel/AMD-omkodning avkodas videon också på grafikkortet (`HW_DECODE=0` stänger av)
- Unraid: ny mall `braxhn-tv-nvidia.xml` med `--runtime=nvidia` och NVIDIA-variablerna färdiga; den vanliga mallen har fält för NVIDIA och `/dev/dri`
- Rättat: alla omkodningar misslyckades när HWACCEL=nvenc var satt utan NVIDIA-drivrutin i containern (`Cannot load libcuda.so.1`). Servern provar nu hårdvaruomkodaren vid start och går automatiskt över till processorn om den inte fungerar; säkerhetskontrollen visar varför
- Serier med lösare filnamn känns igen: "Byggare Bob 026 - Titel", "Kaspar2", "Lille Luj Disc3", "Turesdvd2", "Sunes.Jul.Volym.2-8". Avsnitt utan nummer i en seriemapp numreras i namnordning
- Filmer som inte analyserats än startar utan omkodning: nyckelbilderna tas fram direkt när man trycker på Spela (före bakgrundsanalysen, högst 25 s väntan), och bakgrundsanalysen indexerar nyckelbilder före miniatyrer m.m.
- Rättat: filmer som omkodades startade inte på iPhone/iPad (Safaris egen HLS-spelare klarar inte Dolby Digital i TS-segment – ljudet blir nu AAC där). Spelaren visar "Startar omkodning…" och ett begripligt fel om uppspelningen misslyckas
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
