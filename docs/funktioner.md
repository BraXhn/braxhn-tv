# Funktioner i detalj

Det här är hela listan över vad BraXhn TV kan, grupperad efter område. En kortare översikt finns i
[README](../README.md#funktioner). Hur man ställer in de större delarna (live-TV, musikappar, casting, DLNA,
snabbstart) står i [guide.md](guide.md).

## Bibliotek och metadata

### Bibliotek

Filmer, serier, musik, ljudböcker och foton, mappväljare. Flera mappar per bibliotek (t.ex. filmer på två diskar): lägg till, ta bort och byt namn under *Administration → Bibliotek → Ändra…*. Nya filer upptäcks direkt med filbevakning (med periodisk skanning som reserv). Igenkänning via filnamn (`S01E02`, `Film (2020)`). Går en mapp inte att läsa (avmonterad disk) tas ingenting bort – varken där eller i bibliotekets andra mappar.

### Lokal metadata (NFO och bilder)

För dig som flyttar från Kodi, Jellyfin, Emby eller Plex med tinyMediaManager: `movie.nfo`/`<film>.nfo`, `tvshow.nfo` och `<avsnitt>.nfo` läses (titel, originaltitel, sorteringstitel, år, beskrivning, betyg, åldersgräns, genrer, studio, premiärdatum, säsong/avsnitt och TMDB/IMDb/TVDB-id). Ett id i NFO:n ger exakt matchning mot TMDB, och NFO:ns värden går före TMDB:s. Bilder bredvid filerna – `poster.jpg`, `folder.jpg`, `<film>-poster.jpg`, `fanart.jpg`, `backdrop.jpg`, `<film>-fanart.jpg`, `season01-poster.jpg`, `<avsnitt>-thumb.jpg` – används före TMDB:s och byts när filen ändras (vid nästa skanning – filbevakningen reagerar bara på videofiler). *Använd NFO* kan stängas av per bibliotek.

### Foton

Bibliotekstypen *Foton* för JPEG, PNG, WebP, GIF, HEIC/HEIF\* och videoklipp från telefonen (MOV/MP4). Tidslinje per år, månad och dag som rullar lika snabbt med 50 000 bilder som med 50 (bara det som syns ritas), årslist och månadsetikett vid snabb rullning. Album = mapparna, Favoriter per profil och Den här dagen – foton från dagens datum tidigare år, även som hylla på startsidan. Helskärm med svep och piltangenter, zoom (hjul, nyp, dubbelklick), information ur EXIF (datum och tid, kamera, objektiv, bländare, slutartid, ISO, brännvidd och GPS-position som text – inga kartor och inga molntjänster), ladda ner originalet (om kontot får ladda ner) och bildspel med övertoning och valfri musik ur musikbiblioteket. Videoklippen spelas i den vanliga spelaren. Miniatyrer och platshållarfärger görs i bakgrunden; bildens orientering följer EXIF. Barnprofiler ser fotobibliotek bara om du väljer *Barnprofiler får se fotona* på biblioteket. \*HEIC kräver ffmpeg 7.1, som imagen har – även iPhonens rutnät av bildrutor sätts ihop till hela bilden. Kör du servern med en äldre ffmpeg hoppas HEIC över med en varning i skanningen (välj *Mest kompatibel* under iPhonens *Inställningar → Kamera → Format*, eller exportera som JPEG).

### Hemvideor

Filmbibliotek som *Hemvideor / andra videor*: ingen TMDB, titeln är filnamnet, datumet kommer från filen (inspelningstid i filen, annars filens tid), mapparna blir navigering (`2023 › Midsommar`) och klippen sorteras på datum. Ett klipp som flyttas till en annan mapp behåller var man var.

### Metadata

Affischer, beskrivningar, betyg och avsnittsnamn via TMDB (gratis nyckel, valfritt). Utan nyckel skapas miniatyrbilder ur videon. Fel titel? – sök och välj rätt i TMDB, matchningen låses. Redigera (som Plex, administratören): titel, sorteringstitel, originaltitel, år, premiärdatum, tagline, beskrivning, genrer (med förslag), studio, åldersgräns och betyg – för avsnitt titel, beskrivning, säsong och avsnittsnummer – med lås per fält: ett ändrat fält låses och skrivs aldrig över av *Uppdatera metadata*, NFO-filer eller omskanning. Bildval: alla TMDB:s affischer, bakgrunder, logotyper, säsongsaffischer och stillbilder (svenska, engelska och utan text) i ett rutnät, eller ladda upp en egen (JPEG/PNG/WebP, högst 15 MB) – vald bild låses, *Återställ till automatisk* tar bort låset. Logotypen visas i stället för titeln på titelsidan. Anime med absolut numrering (`Serie - 1071`) mappas till säsonger. Kapitel läses från filerna.

### Matchning av svenska titlar, barnfilm och tecknat

Filnamnen rensas från språk- och releasetaggar (*svenskt tal*, *Dubbad*, *SWEDiSH*, *NORDiC*, *Sv*, *Multi*, `[1080p]`, `(Disney)`, *Disney Klassiker 32 –*, MakeMKV:s `title_t00`) och id i namnet används direkt (`{tmdb-8587}`, `[imdbid-tt…]`, `[tvdbid-…]`). TMDB söks på svenska med och utan år, på engelska och med TMDB:s alternativa titlar (*Shrek 3*, *Kimi no Na wa*, *Monsterbolaget*), med omskrivningar för *och/and/&*, romerska siffror och undertitlar. Samma titel i flera versioner (*Lejonkungen* 1994/2019, *Djungelboken*, *Aladdin*) avgörs av årtalet, annars av att barnbibliotek och tecknat (bibliotekets eller mappens namn, *- tecknad*) föredrar animerat och av filmens längd. Serier: alla vanliga numreringar (`S01E05`, `1x05`, `[1x01]`, *Säsong 2 Avsnitt 5*, *S2 A5*, `E05`, *Avsnitt 3*, *Del 4 av 20*, *Lucka 5*, `06 - Titel` i säsongsmappen), dubbelavsnitt, *Specials*/*Extra*/*Säsong 0*, datumavsnitt (nyheter och talkshower matchas på sändningsdatum), säsongspaket och kategorimappar (`Barn/Bluey/…`, `TV-serier/Bron/…`); serier med samma namn skiljs med årtal, land (*The Office (US)*) och antal säsonger/avsnitt. Svenska hemmabibliotek: mappnamnet vägs alltid in när filnamnet säger lite (`Barnfilmer/Hitta Nemo (2003)/hn-sv.avi`, `Barn/Dexters labratorium/Säsong 1/03a - DextersRival.avi`), felstavade mappar och ord hittas genom att söka på delar av titeln (*labratorium* ≈ *Laboratorium*), release-märkning i mappnamn rensas (`Band Of Brothers 2001 1080p BluRay DTS x264 D-Z0N3` → *Band of Brothers* 2001, `Roast On the Coast Sverige S01E01 SWEDiSH … -DUMMESCHWEDEN` → *Roast on the Coast Sverige*), release-grupper först i namnet (*Noscene-*, *pripps-*), *o* = *och*, saknade och felkodade å/ä/ö (`BrÃ¶derna`, `Br�derna`), obalanserade parenteser och svtplay-dl-namn (`babblarna.s01e05.titel-id-svtplay.mp4`). Segment i tecknade serier (`03a`/`03b`) får rätt del av TMDB:s avsnittsnamn och flyttas till rätt avsnitt när namnet stämmer bättre. `Serie 103` blir S01E03 – eller absolut avsnitt 103 när serien numreras så (Pokémon). Fler sidor av TMDB:s sökning när titeln har vanliga ord (*Clark*, *Alla utom vi*), svensk språktagg ger förtur åt svenska originalserier, säsonger och antal avsnitt kontrolleras mot TMDB för de bästa kandidaterna (12 säsonger/279 avsnitt ger *The Big Bang Theory*, inte en koreansk dokumentär), episode groups används när TMDB:s standardnumrering saknar säsongen (*SpongeBob* S14), och filmens år kan vara det svenska premiäråret (*Coco (2018)*). Är två träffar lika bra blir titeln hellre omatchad med förslag än fel. Samma serie i flera mappar (*Clarkson's Farm* och *Clarksons gård*) blir en serie med Min lista, betyg, framsteg och följningar – samma avsnitt i båda blir versioner. En serie som en äldre version matchat fel prövas en gång till och byts bara mot en klart bättre träff. Administration → Omatchade titlar listar det som inte hittades med filnamn, tolkad titel och förslag, *Matcha* och *Försök matcha omatchade igen*; Osäkra matchningar listar träffar med låg poäng eller en nära konkurrent med *Godkänn*, förslagen och *Fel titel?* – godkända och handvalda titlar låses och rörs aldrig av omskanning.

### Bilder i rätt storlek

Affischer, bakgrunder, miniatyrer, omslag och personbilder skalas ned på servern till den storlek som visas (`?w=`, några fasta bredder från 160 till 1280 px) och sparas i `cache/img`. På telefon över mobilnätet hämtas t.ex. en affisch på 320 px i stället för hela TMDB-bilden. Bilder förstoras aldrig, och en ny bild ersätter de gamla storlekarna.

### Flera versioner

Samma film i flera versioner (t.ex. 4K och 1080p) visas som en film. Servern väljer den version enheten kan spela utan omkodning, och på webben kan du välja själv. Framsteg och sedd gäller filmen oavsett version.

### Rollista och personsidor

Skådespelare, regi och skapare från TMDB. Klicka på en person för bild, biografi och allt med personen i biblioteket. Sökningen hittar även personer.

### Trailers och extramaterial

Lokala trailers (`Film (2020)-trailer.mkv` eller mappen `trailers/`) spelas från titelsidan och räknas inte som egna filmer. Extramaterial som i Plex – mapparna `Featurettes/`, `Behind The Scenes/`, `Deleted Scenes/`, `Interviews/`, `Scenes/`, `Shorts/`, `Extras/`, `Other/` i filmens eller seriens mapp och suffixen `-featurette`, `-behindthescenes`, `-deleted`, `-interview`, `-scene`, `-short`, `-other` – visas i hyllan *Extramaterial* grupperad per typ, med filmens åldersgräns. Klarar webbläsaren inte filen gör servern om den. TMDB-trailern öppnas på YouTube.

### Egna betyg

Stjärnor 1–5 med halva steg per profil för filmer, serier, avsnitt, album och låtar – på titelsidan (även tangenterna 1–5), i kortmenyn ⋮, på albumsidan och i låtarnas ⋮. Sortera och filtrera biblioteket på *Mitt betyg* (även i smarta samlingar), *Mitt betyg* och *Mitt albumbetyg* i smarta spellistor, skickas till Trakt och syns i musikappar (Subsonic `setRating`). Barnprofiler betygsätter sina egna.

### Temamusik

`theme.mp3` eller `theme.m4a` i seriens eller filmens mapp spelas svagt och tonas in när titelsidan öppnas (som Plex/Jellyfin) – aldrig om något annat spelar och bara efter att du rört sidan. Val per profil under Mitt konto (standard: på för serier, av för filmer).

### Hälsokontroll av biblioteket

*Administration → Hälsokontroll* (`#/health`) visar filer som är trasiga (ffprobe kan inte läsa dem), avkortade (avbruten nedladdning – sista paketen slutar före behållarens längd), har avkodningsfel (stickprov på fem punkter, 2 s var), ljud ur synk (grov kontroll av startpts), felmärkt språk (ljudspår utan språk eller med titeln "Svenska" märkt engelska; undertexter vars text är ett annat språk än märkningen), SD när resten är 1080p, dubbletter, saknade avsnitt mitt i en säsong (och sända avsnitt enligt kalendern) och så hög bithastighet att de flesta klienter behöver omkodning. Åtgärder: *Ny version…* ber Radarr/Sonarr söka (och kan spärra den nuvarande releasen), *Rätta språk…* sparar rätt språk som uppspelningen, förvalen och filtren använder i alla appar – filen skrivs aldrig om –, och *Ignorera*. Jobbet går med lägsta prioritet, pausar medan något spelas eller kodas om, syns i aktivitetspanelen och kontrollerar bara nya och ändrade filer.

### Diskrådgivaren – frigör plats säkert

*Administration → Diskrådgivaren* (`#/shrink`) visar var platsen tar vägen per bibliotek, serie, upplösning och codec, MB per minut, vad ingen i hushållet sett (aldrig eller på länge – Min lista, följda serier och påbörjade titlar märks), filmer i flera versioner och uppskattad vinst per titel med HEVC eller AV1 (ur bithastighet, upplösning och codec; *Provkoda* kalibrerar uppskattningen mot en kort riktig kodning). Omkodning i bakgrunden är av tills du startar den per titel eller med en regel (bibliotek, codec, MB/min, inte sedd på X dagar, minsta vinst): grafikkortets kodare om den finns, processorn bara om du tillåter det; lägsta prioritet, bara inom ett tidsfönster (standard 01–07) och när ingen tittar, pausbar. Alla ljud- och undertextspår, kapitel och metadata följer med. Före bytet kontrolleras resultatet med ffprobe (spår, längd, codec) och mot originalet på stickprov – VMAF om ffmpeg har libvmaf, annars SSIM och PSNR; under gränsen behålls originalet och titeln markeras. Bytet är atomärt (skrivs bredvid, byter namn), originalet hamnar i papperskorgen `.braxhn-papperskorg` i biblioteksmappen i 14 dagar (kan återställas) och titeln behåller id, framsteg, betyg och metadata. HDR, Dolby Vision och flätad bild hoppas över. Se [Sonarr, Radarr och önskningar](../README.md#sonarr-radarr-och-önskningar) om hur du undviker att de "uppgraderar" tillbaka.

### Diskövervakning

Ledigt utrymme för /config, omkodning, inspelningar, poddar och bibliotek. Notis när det börjar ta slut, och omkodningsmappen städas tidigare när den är nästan full.

## Uppspelning

### Direktuppspelning

Filer som enheten klarar skickas orörda (med spolning).

### Remux

H.264-, HEVC-, HDR10- och Dolby Vision-filer i MKV eller med fel ljudformat strömmas med originalbilden kopierad. Bara ljudet konverteras vid behov, så processorbelastningen blir nästan noll. Segmenten delas exakt på filens nyckelbilder, som indexeras vid skanningen. HEVC strömmas som fMP4-HLS till Apple-enheter. Surroundljud (AC-3/E-AC-3) skickas vidare orört när enheten klarar det.

### Omkodning

Behövs bara för t.ex. HEVC till enheter utan HEVC-stöd, lägre kvalitet eller inbränning. Kan köras med processor eller GPU (Intel/AMD VAAPI, Quick Sync, NVIDIA NVENC). HEVC och AV1 i stället för H.264 när webbläsaren kan avkoda det och grafikkortet kan koda det (hevc/av1_nvenc, hevc/av1_vaapi, hevc/av1_qsv) – samma bild med 40–50 % lägre bithastighet, mest märkbart utanför hemmet. Med processorn (x265/SVT-AV1) bara om du väljer det under *Administration → Omkodning*, eftersom det är tungt. Går kodningen inte blir det H.264 automatiskt.

### HDR → SDR

HDR10, HLG och Dolby Vision (bas-lagret) tonmappas automatiskt när skärmen saknar HDR. På grafikkortet när det går – NVIDIA med libplacebo (Vulkan) eller OpenCL efter nedskalningen, Intel/AMD med libplacebo eller tonemap_vaapi – annars med processorn (zscale). Servern provar vid start vilka vägar som fungerar. Dolby Vision profil 5 (utan HDR10-baslager) får rätt färger med libplacebo på ett grafikkort; utan det kan färgerna avvika.

### Undertexter

Inbäddade och externa `.srt/.vtt/.ass`. Teckenkodningen för gamla svenska srt-filer identifieras automatiskt. Bildundertexter (Blu-ray PGS och DVD) bränns in. Undertexter kan sökas och laddas ner från OpenSubtitles, med exakt matchning via filhash. Tidsjustering ± (0,1 och 0,5 s). Automatisk synk mot ljudet: servern jämför replikerna med talet i filmens ljudspår och flyttar undertexten – även när den är gjord för en annan bildfrekvens (25 ↔ 23,976/24). *Synka automatiskt* under ⚙ i spelaren visar förlopp och resultat ("flyttad +1,8 s") med Ångra; en manuell finjustering kan sparas för alla. Justeringen gäller undertextfilen, så även apparna och Chromecast får rätt tider. Nedladdade undertexter synkas automatiskt (kan stängas av under Mitt konto → Uppspelning). Hämtas automatiskt vid skanning för valda språk (bara exakta filhash-träffar som standard). Två undertexter samtidigt i webben, t.ex. för språkinlärning. Utseende i webbspelaren: storlek (S–XL), vit eller gul text, kantlinje eller halvgenomskinlig ruta och placering – texten lyfts över kontrollerna när de syns. Gäller även bildundertexter (PGS). Sparas per konto (⚙ i spelaren eller Mitt konto).

### Nattläge och tydligare dialog

*Nattläge* jämnar ut ljudet (explosioner dämpas, viskningar lyfts) och *Tydligare dialog* förstärker rösterna; surround mixas då ned till stereo med förstärkt centerkanal. I Chrome, Edge och Firefox görs det direkt i webbläsaren; i Safari, på Chromecast och för appar (`night=1`/`dialog=1`) gör servern det – ljudet omkodas men bilden kopieras.

### Spelaren

Uppspelningshastighet 0,75–2×, kapitellista med förhandsbild per kapitel, *Hoppa över intro/sammanfattning*, tydlig fokusmarkering och pilar mellan knapparna med tangentbord eller fjärrkontroll.

### Hoppa över intro

Introt hittas automatiskt genom ljudfingeravtryck: avsnitten i en säsong jämförs och den gemensamma ljudsekvensen blir introt. Även eftertexter och "tidigare i serien" hittas och ger knapparna *Nästa avsnitt* och *Hoppa över sammanfattning*. Tiderna kan justeras manuellt.

### Förhandsbilder vid spolning

Miniatyrer visas ovanför tidslinjen när du drar i den (skapas vid skanningen).

### Uppspelningsval per konto

Som i Plex, under *Mitt konto → Uppspelning* och sparat på servern (alla webbläsare, Chromecast och apparna): föredragna ljudspråk i ordning (t.ex. svenska, engelska, originalspråk – kommentarsspår och syntolkning väljs aldrig automatiskt), undertexter *Av* / *Bara tvingade* / *När ljudet är på ett annat språk än mina språk* / *Alltid* med föredragna språk och SDH föredras eller undviks, hoppa automatiskt över intro, sammanfattning och eftertexter (med en kort nedräkning och *Avbryt*), nästa avsnitt automatiskt med vald nedräkning och standardkvalitet hemma och utanför hemmet (inom administratörens tak). Apparna får ljudspråket och kvaliteten direkt från servern.

### Bio-läge

Som på bio: 1–3 trailers före filmen – för filmer i biblioteket som du inte har sett, helst i liknande genre och efter vad du brukar titta på, och alltid inom profilens åldersgräns. Administratören kan lägga till en egen förfilm (en fil eller en mapp att slumpa från) som spelas sist. *Hoppa över* och *Hoppa över alla*, och en länk till trailerns film. Väljs per person under Mitt konto; gäller i webben när en film startas från början. Bara lokala trailers (inga YouTube-trailers).

### Anpassningsbar kvalitet

När servern omkodar med automatisk kvalitet kan spelaren själv växla ner (1080p/720p/480p) när nätet blir sämre, t.ex. i bilen eller på mobilnät.

### Spelare

Egen kontrollrad som visas vid paus eller när musen rör sig, och litet fönster längst ner så att filmen fortsätter medan du bläddrar. Tangenter: mellanslag, ←/→, f, m, s (hoppa över intro).

### Jämn strömning och Statistik i spelaren

Bakgrundsjobben (skanning, analys, förhandsbilder, startcache, repliksökning, hälsokontroll, ljudanalys, diskrådgivaren) väntar eller går långsamt medan någon tittar, så att servern alltid hinner skicka nästa segment. *Statistik* under ⚙ i webbspelaren visar läge och skäl, upplösning/codec in och ut, bithastighet, buffert framåt, tappade bildrutor, nätverkshastighet, serverns omkodningshastighet (× realtid) och om den hinner med. Hackar uppspelningen loggas orsaken (omkodningen, disken, nätet, upptagen server eller enheten) och syns i *Spelas nu*.

### Utanför hemmet

Kvaliteten begränsas automatiskt för tittare utanför hemnätet. Inbyggd HTTPS eller omvänd proxy, och appar med token-inloggning. Se *Titta utanför hemmet* i [README](../README.md).

### Snabbstart när diskarna sover

Unraid-specifikt: början av det som troligen spelas härnäst – *Fortsätt titta* (även platsen där du slutade), nästa avsnitt i serier som hushållet tittar på och nyligen tillagt – kopieras till cache-poolen/SSD:n, tillsammans med filens index (MP4 med index sist, slutet av MKV). Filmen startar då direkt i stället för efter 5–15 s medan arraydisken snurrar upp, och fortsätter sömlöst från originalfilen. Gäller direktuppspelning och remux/omkodning från början. Kopieringen görs bara när disken ändå är vaken (diskens I/O-räknare, eller när servern nyss läst i samma mapp: skanning, uppspelning), med låg hastighet och inom storleksgränsen. När en titelsida öppnas eller pekaren hamnar på ett korts Spela väcks disken i förväg. Läge, använt, träffgrad och *Fyll nu* under *Administration*. Se [Snabbstart när diskarna sover](#snabbstart-när-diskarna-sover).

### Offline

Ladda ner filmer och avsnitt i iPhone/iPad- och Android-appen och titta utan nät. Servern gör en mobilanpassad MP4 (H.264/AAC) i vald kvalitet.

### Offline i webbläsaren

*Spara offline* på titelsidan, i kortmenyn ⋮, för en hel säsong, på albumsidan och på ljudbokssidan. Välj Original (filen som den är, när webbläsaren kan spela den) eller 1080p/720p/480p (servern kodar om). Sparas i webbläsaren (installerad app eller flik) med kö, paus, återupptagning där den avbröts och borttagning; *Nedladdat* (användarmenyn) visar använt utrymme och kvot. Appen startar och spelar det sparade även utan kontakt med servern (service workern), med undertexter, kapitel och hastighet för ljudböcker och nästa avsnitt. Var du var sparas offline och skickas till servern när den svarar igen – ett senare framsteg från en annan enhet skrivs inte över. Kräver HTTPS (eller localhost) och rätten att ladda ner; barnprofilens åldersgräns gäller. Utloggning döljer det sparade tills profilen loggar in igen.

### Automatisk offline-synk

iPhone/iPad- och Android-appen håller de nästa osedda avsnitten nedladdade (valfritt bara på Wi-Fi) och tar bort sedda.

## Hemma i appen: startsida, sökning och upptäckt

### Startsida för hela familjen

Utvalt överst på bred skärm: stor bakgrundsbild, beskrivning, *Spela* och *Mer info* för fem osedda titlar som byter långsamt (står still vid fokus, muspekare, paus och *minska rörelse*; styrs med tangentbord och fjärrkontroll). Tematiska hyllor: *Eftersom du såg …* (de två senast sedda), *Topprankat i biblioteket* (osedda först), *Glömda guldkorn* (högt betyg, tillagda för länge sedan, aldrig sedda), *Kort film ikväll* (under 95 minuter), *Den här dagen* (premiär det datumet, eller sedd för exakt 1, 5 eller 10 år sedan), *Dagens genre* och *Fortsätt lyssna* (ljudböcker och poddar). Allt följer profilens åldersgräns. Anpassa startsidan (längst ner och under Mitt konto): visa/dölj och ordna hyllorna med dra och släpp eller ↑/↓, och välj Utvalt alltid/på bred skärm/aldrig – sparas för kontot och följer med mellan enheter.

### Upptäck

Min lista, samlingar (t.ex. alla Bond-filmer), rekommendationer utifrån det du sett och *Liknande titlar*.

### Egna samlingar

Samla filmer och serier själv (som Collections i Plex/Jellyfin): namn, beskrivning och sortering (egen ordning, titel, år eller senast tillagda). Lägg till med ⋮ → *Lägg till i samling…* eller *+ Samling* på titelsidan, ordna med dra och släpp eller ↑/↓ (fungerar med tangentbord och fjärrkontroll). Delade samlingar (alla profiler) skapas av administratören hemma; alla kan göra privata. Barnprofiler ser bara titlar inom sin åldersgräns. Valfritt: *Visa på startsidan* som egen hylla. Omslaget är första titelns affisch.

### Filter, sortering och smarta samlingar

Bläddra i film- och seriebibliotek med kombinerbara filter: genre (flera, *någon* eller *alla*), decennium/årsintervall, lägsta betyg, längd (kort/normal/lång eller eget intervall – för serier avsnittens längd), upplösning (SD/720p/1080p/4K), HDR (HDR10, Dolby Vision, HLG, SDR), ljud (stereo, surround, Dolby Atmos/DTS:X), ljud- och undertextspråk (inbäddade spår och undertextfiler bredvid filmen), osedda/påbörjade/sedda, tillagd senaste N dagar, åldersgräns och samling/ingen samling; för serier även pågående/avslutade och antal säsonger. Filmversioner och avsnitt räknas (en film med en 4K-version träffas av 4K). Panelen visar bara värden som finns i biblioteket, med antal, och fungerar med tangentbord och fjärrkontroll (ark nerifrån på telefon). Aktiva filter visas som chips som tas bort med ett klick. Sortering på titel, år, betyg, tillagd, senast sedd, längd eller blandat – stigande eller fallande. Filtret sparas per bibliotek i webbläsaren och står i adressen (`#/lib/1?genre=Drama&sort=year`), så länken går att dela. Blanda spelar en slumpad titel ur det som visas (serie → ett slumpat avsnitt, osedda först om filtret gäller osedda). Spara som smart samling: filtret blir en samling vars innehåll räknas fram varje gång (nya titlar kommer med av sig själva) – kan delas och visas på startsidan som andra egna samlingar.

### Webbgränssnitt i Plex-stil

Mörk, kompakt layout: sidomeny med ikoner (Hem och ett val per bibliotek, ☰ fäller ut namnen), menyrad med sidor, sök och reglage för kortstorlek, startsidan som vågräta hyllor med ‹ › (även piltangenter/fjärrkontroll – se *Fjärrkontroll och TV-webbläsare*). Korten har ▶ som spelar direkt, ✎ för administratörer och märke för osedda avsnitt; *Nyligen tillagda* i seriebibliotek visar ett kort per säsong. På telefon finns flikmenyn längst ner kvar.

### Snabbåtgärder på korten

⋮ på varje affisch (även högerklick, långtryck och Menu-tangenten på fjärrkontrollen): spela/fortsätt, markera som sedd, Min lista, ta bort från Fortsätt titta, följ serien, titta tillsammans och ladda ner – utan att öppna titelsidan. Administratörer får även metadataverktygen. Det mesta går att ångra direkt.

### Sökning i hela biblioteket

En sökruta för filmer, serier, avsnitt, personer, artister, album, låtar, ljudböcker, poddar, TV-kanaler och program, grupperade som hyllor med de bästa träffarna först. Resultaten kommer medan du skriver. Å, ä och ö behöver inte skrivas (”anglagard” hittar *Änglagård*), accenter och bindestreck spelar ingen roll (”amelie”, ”spiderman”), ett stavfel gör inget (”matirx”), och året kan läggas till (”matrix 1999”). Även originaltitel, författare och uppläsare är sökbara. Pil ner från sökrutan går till träffarna, och de senaste sökningarna sparas i webbläsaren (med Rensa). Barnprofiler ser bara det som är tillåtet för dem.

### Repliksökning

Sök på en replik – *"I'll be back"*, *"jag är din far"* – under fliken Repliker i sökningen och hoppa direkt till scenen (två sekunder före repliken). Träffen visas med titel, avsnitt, tidpunkt, repliken med markerad träff, repliken före och efter och en bild ur filmen från spolningsbilderna. Alla textundertexter indexeras i bakgrunden efter skanningen: externa `.srt/.ass/.vtt`, nedladdade och upp till tre inbäddade textspår per fil (svenska och engelska först; tvingade spår och bildundertexter hoppas över). Bara nya och ändrade undertexter läses (inbäddade spår med lägsta prioritet, pausar medan video omkodas – syns i aktivitetspanelen), borttagna försvinner ur sökningen. En sparad undertextsynk gäller direkt. Sökningen följer bibliotek och åldersgräns (barnprofiler). Tecken som å, ä och ö är egna bokstäver; versaler spelar ingen roll.

### Följ serier

*Nytt för dig* när nya avsnitt kommer, och personlig notis via ntfy eller webhook. Serier följs automatiskt när du lägger dem i Min lista eller ser klart ett avsnitt.

### Kommande avsnitt och saknade avsnitt

*Kommande* i menyn: avsnitt per dag (Idag, I morgon, veckodagar) för pågående serier i biblioteket, med serieaffisch, avsnittsnamn, kanal och tid när den är känd, och markering *I biblioteket*, *Saknas* eller *Följer*. Veckovy på bred skärm och filter för bara serierna du följer. Hyllan *Kommer snart* på startsidan visar de närmaste sju dagarna. Seriesidan visar sända avsnitt som saknas (*Saknas: S02E04–E06*) och, om Sonarr är kopplat, knappen *Sök i Sonarr*. Prenumerera i telefonens kalender (iCal) med en egen länk under *Mitt konto* som bara ger tillgång till kalendern och kan återkallas. Datumen hämtas från TMDB en gång per dygn (kräver TMDB-nyckel), tider och kanaler även från Sonarr. Barnprofiler ser bara serier inom åldersgränsen.

### Ditt år

Årssammanfattning per person: timmar, mest sett, favoritgenre, musik och ljudböcker.

### Min historik

Varje profil ser vad den har tittat på med datum, kan söka, ladda ner som CSV och ta bort enskilda rader (barnprofiler kan inte radera – föräldern ser historiken i statistiken).

### Statistik

*Spelas nu* med möjlighet att stoppa en ström, tittartimmar, populäraste titlar och direkt/remux/omkodning-fördelning. Tittarstatistik (som Tautulli): all historik med start, slut, sedd tid, enhet, IP, hemma/utifrån, direkt/remux/omkodning, kvalitet och bithastighet; filter på profil, bibliotek, typ, läge, plats, period och sökning; per titel och per profil; topplistor (mest sett, mest aktiva profiler, plattformar); grafer per dag, veckodag och timme, samtidiga strömmar och uppskattad bandbredd; export till CSV. Historiken sparas ett år (inställbart).

### Kortkommandon

Tryck ? för en lista. `/` söker, i spelaren `j`/`l` eller pilarna ±10 s, `k`/mellanslag paus, ↑ ↓ volym, `0`–`9` hoppar i filmen, `f` helskärm, `m` ljud av.

## Familjen och hushållet

### Profiler

*Vem tittar?* – profiler i hushållet med egen historik och Min lista, valfri PIN och åldersgräns för barn (svensk åldersgräns från TMDB, med USA/Tyskland som reserv).

### Skärmtid

Minuter per dag och tillåtna klockslag (per veckodag) för profiler, med extra tid för idag. Gäller i alla appar eftersom servern bestämmer.

### Föräldraöversikt

För huvudkontot, även på telefonen utanför hemmet (*Föräldraöversikt* i menyn och under *Mitt konto → Profiler*): en flik per barnprofil med Just nu – vad barnet tittar på, på vilken enhet och hur långt in, med *Stoppa uppspelningen* (barnets spelare stängs och titeln kan inte startas om på två minuter) – och dagens skärmtid med mätare, *+15 min*, *+30 min*, *−15 min* och genvägar till skärmtiden och familjefiltret. För 7 eller 30 dagar: tid för film/serier och ljudböcker, snitt per dag, antal titlar, kvällstittande efter kl. 21 och tittande utanför hemmet, ett diagram per dag, Mest sett (en serie räknas som en titel, med antal avsnitt) och Senast tittat per dag med klockslag, hur mycket som sågs och enhet. Uppdateras var 30:e sekund. Bara barnprofiler (profiler med åldersgräns) i det egna hushållet visas – aldrig vuxna profiler eller andra konton. Bygger på tittarhistoriken (sparas lika länge som den); musik räknas inte. Fungerar med fjärrkontroll i TV-läge.

### Familjefilter (som VidAngel/ClearPlay men helt lokalt)

Ljudet tystas där undertexten innehåller en svordom och undertexten visar `*` i stället för ordet. Tiderna kommer från repliksökningens index och undertextsynken, så de stämmer med bilden; hela repliken tystas med en kort marginal. Svenska och engelska ordlistor med böjningar och sammansättningar (`skit*`, `*jävel`, `son of a bitch`), egna ord och avstängda ord under Administration → Familjefilter (med en provruta). Läge per profil under Mitt konto (*Av*, *Tysta svordomar*, *Tysta + hoppa över markerade scener*); barnprofilernas läge väljer huvudkontot under *Profiler i hushållet*, och standard för barnprofiler väljer administratören. Vuxna markerar scener att hoppa över under ⚙ i spelaren – för sig själva, för hushållet eller (administratören) för alla. Webbspelaren tystar själv på exakt tid (filen spelas fortfarande direkt) och visar en liten indikator; för apparna, Chromecast och AirPlay tystar servern ljudet i strömmen (ljudet kodas om till AAC, bilden kopieras), och Chromecast hoppar över markerade scener. För barnprofiler tystar servern alltid – även i webbspelaren – och originalfilen kan inte hämtas, laddas ner eller sparas offline för titlar med svordomar; barnprofiler kan inte heller ändra undertextsynken (den flyttar tystnaden). Även repliksökningen visar `*`.

### Kvällsvalet

Hushållet väljer film eller serie tillsammans: en profil startar *Kvällsvalet* i menyn och väljer filter (filmer/serier, bibliotek, genrer, längd, lägsta betyg, bara sådant ingen av er sett, antal förslag), de andra går med på telefonen med en sexsiffrig kod eller QR-kod – profiler i hushållet ser det direkt. Alla sveper ja/nej (finger, knappar eller ← →, *Ångra*) på samma förslag i samma ordning. Förslagen väljs ur er smak (det ni sett, egna betyg, filmserier ni börjat på, hushållets historik) med variation och tar hänsyn till alla – inget som någon ogillar starkt hamnar först. När alla (eller majoriteten, valbart) gillat samma titel visas matchen för alla direkt: *Spela här*, *Spela på TV:n …* (Spela på…) eller *Titta tillsammans*. Barnprofiler kan vara med: bara det som är tillåtet för alla deltagare visas (den lägsta åldersgränsen), och ingen ser vad de andra sett eller röstat.

### Titta tillsammans

Synkad uppspelning med chatt, även mellan olika hem. Dela en länk – play, paus och spolning följer med för alla.

### "Det här har hänt" – sammanfattning innan du fortsätter en serie (som Netflix *Tidigare i …*, men ihopklippt ur dina egna filer)

Knappen *⟲ Det här har hänt* på seriesidan, och i spelaren erbjuds sammanfattningen när du startar första avsnittet i en ny säsong efter mer än två veckors uppehåll (med *Hoppa över*). Servern väljer 6–12 scener på 5–12 s ur förra säsongen (eller de senaste avsnitten mitt i en säsong): repliker ur repliksökningens index med namn och nyckelord ur avsnittens handling, säsongens sista avsnitt väger tyngst. Intro, *tidigare i serien* och eftertexter undviks, liksom svart bild och tystnad (ffmpeg kontrollerar varje scen). Inga spoilers: bara avsnitt profilen redan sett. Klippen sätts ihop till HLS med titelskylten *Tidigare i &lt;serie&gt;* och korta övertoningar – bilden kopieras utan omkodning när det går, annars snabb omkodning (lägsta prioritet, ett jobb i taget). Sammanfattningen sparas per serie/säsong och sett-läge och delas av profiler som sett samma avsnitt. Åldersgräns och bibliotek gäller, och med familjefiltret på väljs scener utan svordomar (och ljudet tystas).

### Ögonblick – klipp att dela inom hushållet

Tryck på *✂ Ögonblick* i webbspelaren och välj *Senaste 30 s* eller egen start och eget slut (högst 3 minuter som standard) och ge klippet en titel. Servern gör klippet i bakgrunden: bilden kopieras utan omkodning när det finns en nyckelbild vid starten, annars kodas den snabbt om till H.264/AAC (högst 720p, lägsta prioritet, ett jobb i taget). Valfritt bränns den valda textundertexten in och en liten vattenstämpel med titeln läggs på. Klippen syns i hushållets flöde *Ögonblick* (Mer → Ögonblick) med miniatyrer, reaktioner och kommentarer, och kan spelas eller öppnas med *Spela filmen härifrån*. Dela utanför hemmet med en länk som slutar gälla (1 timme–30 dagar) och kan återkallas – den som får länken ser bara klippet, med förhandsvisning (Open Graph) i chattappar. Åldersgräns och biblioteksbehörighet gäller både den som skapar och den som ser, barnprofiler kan inte dela utanför hemmet och familjefiltret gäller i klippen (svordomar tystas för profiler med filtret på). Tak för längd och lagring (`MOMENTS_MAX_SECONDS`, `MOMENTS_MAX_MB`).

### Språkinlärning (som Language Reactor, men inbyggt och lokalt)

Slå på *Språkinlärning* under ⚙ i webbspelaren. Välj språket du lär dig som *Undertexter* och ditt eget som *Andra undertext*: repliken visas med översättningen under – översättningen är den andra undertextens replik vid samma tid, ingen extern tjänst. Spelaren kan pausa efter varje replik, upprepa repliken (`r`), upprepa den långsamt med samma tonhöjd (`x`) och hoppa till föregående/nästa replik (`a`/`d`) – med knappar ovanför kontrollerna och på telefonen. Klicka eller tryck på ett ord (eller `w`, ←/→ och Enter) så sparas det i profilens Ordlista (Mer → Ordlista) med meningen, översättningen, tidpunkten och titeln. Ordlistan kan sökas, ändras, spela från repliken och exporteras till Anki som TSV/CSV, eller som ZIP med ett ljudklipp (MP3) av varje replik (kräver rätten att ladda ner). Fungerar med textundertexter (externa, nedladdade och inbäddade), inte bildundertexter.

## Musik, ljudböcker, poddar och böcker

### Musik

Album, artister, spellistor, favoriter och sökning. Omslag från `cover.jpg` eller inbäddad bild. Ljudspelare som fortsätter medan du bläddrar, med mediaknappar i telefon och bil.

### Lyssning

Sovtimer (15–60 min eller vid kapitlets/avsnittets slut, med nedtoning), jämn ljudnivå i musik per spår eller album (ReplayGain/R128-taggar, annars mätning i bakgrunden; toppvärdet och en begränsare hindrar klippning), glapplös uppspelning och smart övertoning (2–12 s, aldrig inom ett album som går ihop, kortare eller ingen när låten slutar i tystnad) i webbens musikspelare – kodarens fördröjning i MP3/AAC tas bort, synkade låttexter från `.lrc` (även utökad LRC med ordtider), ID3 SYLT/USLT, FLAC/Vorbis LYRICS-taggar eller LRCLIB – i webben med markerad rad som rullar med låten, klick på en rad spolar dit och karaokeläge i helskärm där orden fylls i takt (även med glapplös uppspelning), musikvideor i musikbiblioteket (artist- och albumsidan, *Spela videon* i låtens ⋮-meny), smarta spellistor (mest spelat, bortglömda favoriter, nyligen tillagt, aldrig spelat – och egna regler som i Navidrome: titel, artist, album, albumartist, genre, år, längd, antal spelningar, senast spelad, tillagd, favorit, bibliotek, filformat och bithastighet, med alla/någon-grupper, sortering eller slump och gräns i låtar eller minuter; privata eller delade med alla på servern, syns i apparna bland de andra smarta listorna) och inställbara hopp för ljudböcker och poddar. *Hoppa över tystnad* i poddar finns i Android-appen.

### Ljudanalys och låtradio

Som Plexamps *Sonic Analysis*, men utan Plex Pass och helt lokalt: servern lyssnar i bakgrunden på upp till 120 s från mitten av varje låt (ffmpeg, lägsta prioritet, pausar medan video omkodas) och räknar fram tempo (BPM), energi, dynamik, klang, frekvensband, andel tal och ungefärlig tonart. Det ger Starta låtradio från en låt, ett album, en artist eller ljudspelaren (oändlig kö som blandar artister, aldrig upprepar sig och glider sakta i stil), Ljudresa från en låt till en annan, stationerna *Lugnt*, *Energi*, *Fokus* och *Fest* samt *Låtradio från din lyssning* (syns också i appen och bilen bland de smarta listorna), Liknande låtar i låtens ⋮-meny och Liknande artister efter hur de låter. Tempo och energi går att använda i egna smarta spellistor. Förlopp och inställningar under Administration → Ljudanalys.

### Musikmetadata och låttexter från nätet

Artistsidan som i Plexamp/Apple Music: stor artistbild, biografi från Wikipedia (svenska först, annars engelska) som fälls ut, född/bildad, ursprung, genrer, Populärt, album uppdelade i Album, EP, Singlar, Livealbum och Samlingar, *Liknande artister* (ljudanalysen) och *Relaterade artister* (medlemmar och samarbeten från MusicBrainz, liknande från Last.fm om nyckeln finns), och länkar (webbplats, Spotify, Instagram, Discogs …). Albumen får beskrivning och typ. Hämtas i bakgrunden efter musikskanningen från MusicBrainz (artisten matchas på namn *och* albumtitlar, högst ett anrop per sekund), Wikidata/Wikipedia, Wikimedia Commons och – med en egen nyckel – Fanart.tv (bättre bilder och bakgrunder). `artist.jpg` i artistens mapp går före. Fel artist? för administratören (sök, välj, lås, ta bort). Synkade låttexter från LRCLIB när en låt saknar egen `.lrc` eller texttagg – i webbens låttextpanel och i musikappar (Subsonic `getLyrics`/`getLyricsBySongId`), cachade i databasen; valfritt i förväg i bakgrunden. Musikappar får biografi, bilder och liknande artister via `getArtistInfo2`/`getAlbumInfo2`. Inställningar under *Administration → Musikmetadata och låttexter*.

### Scrobbling av musik

Varje person kan koppla ListenBrainz (med sin användartoken) och Last.fm under Mitt konto. Det du lyssnar på i webben, iPhone/Apple TV-appen och Android-appen visas som *spelas nu* och räknas när du lyssnat på halva låten eller 4 minuter (låtar under 30 s räknas inte). Lyssningar som inte gick att skicka (inget nät, tjänsten nere) sparas och skickas senare. Barnprofiler kan inte koppla. Se *Scrobbling* i [README](../README.md).

### Musikappar (Subsonic)

Lyssna på musiken i färdiga musikappar: Symfonium (Android, Android Auto), Amperfy och play:Sub (iPhone med CarPlay), Feishin och Supersonic (dator) eller Sonos via Music Assistant. Servern talar Subsonic/OpenSubsonic-API:t under `/rest`. Var och en skapar ett eget *lösenord för musikappar* under Mitt konto – det ger bara tillgång till musiken. Favoriter, spellistor (även de smarta), låttexter och scrobbling är desamma som i webben. Se *Musikappar (Subsonic)* i [guide.md](guide.md).

### Ljudböcker

En bok per mapp (`Författare/Bok/`) eller per `.m4b`. Kapitel, position som sparas, hastighet 0,75–2×, ±15/30 s, bokmärken. Även i bilen och i iPhone/Apple TV-appen. Metadata från nätet (som Audiobookshelf): beskrivning, omslag (om boken saknar eget), år, förlag, ISBN, genrer, serie och uppläsare från Google Books (svenska titlar söks först på svenska) med Open Library som reserv, och kapitel från Audnexus när filen saknar kapitel och boken har ett ASIN (taggen `asin` eller angivet för hand) – bara om längden stämmer (±2 %). Hämtas i bakgrunden efter skanningen. *Fel bok?* väljer rätt träff och låser den (sökning i Audible per region, Audnexus, Google Books och Open Library – med uppläsare, serie och nummer), *Redigera* ändrar fälten för hand. Biblioteket kan grupperas per serie eller författare. Lyssna i poddapp (som Audiobookshelf): ett privat RSS-flöde per bok eller serie med egen nyckel per profil, kapitel (Podcasting 2.0) och återkallning – fungerar i Pocket Casts, Overcast, AntennaPod m.fl. (inte för barnprofiler, profiler med skärmtid eller konton som inte får ladda ner). Kapitelredigerare för administratörer: byt namn, flytta, lägg till och ta bort kapitel, hämta dem från Audnexus via ASIN – sparas utan att filen skrivs om; *Skriv in i filen* (M4B, på begäran) och Slå ihop till M4B för böcker i många MP3-filer, med originalen i papperskorgen och *Ångra*. Lyssningsstatistik per bok och profil (hushållet för administratören), *Markera som utläst/oläst*, hastighet per bok och jämn ljudnivå för tal i webbspelaren.

### Poddar

Sök på poddens namn (Apples poddkatalog, ingen nyckel) och prenumerera med ett klick – eller klistra in RSS-adressen. De senaste avsnitten laddas ner automatiskt, position sparas per person. Även i bilen.

### E-böcker och serietidningar

Bibliotekstypen *E-böcker* för EPUB, PDF och CBZ (CBR bara när filen egentligen är ett ZIP-arkiv – riktiga RAR-arkiv hoppas över med en varning, packa om dem till CBZ). Metadata ur filerna: titel, författare, serie och nummer (calibre-taggar och EPUB 3 i OPF, `ComicInfo.xml` för serietidningar, annars mappen och filnamnet som `Serie 012.cbz`), beskrivning, förlag, språk, ISBN, genrer, åldersgräns och manga-läsriktning ur ComicInfo, och omslag. Biblioteket visas som alla böcker eller per serie, med *Fortsätt läsa* på startsidan och i biblioteket, och böckerna hittas i sökningen. Läsaren i webben: EPUB med sidbrytning (en eller två spalter), typsnitt, textstorlek, radavstånd, marginaler och tema (ljust, sepia, mörkt), innehållsförteckning, bokmärken och markeringar i fyra färger med anteckningar; serietidningar sida för sida, som dubbelsida, manga höger→vänster och webtoon (rulla nedåt), med förladdning och zoom. Tangentbord (←/→, Mellanslag, Home/End, t, b, +/−, f), svep och tryck i kanterna på telefonen, och TV-fjärrens pilar. Läspositionen sparas per profil. PDF öppnas i webbläsarens egen läsare. Säkert: bokens innehåll visas i en sandlåda utan skript, utan externa resurser och med omskrivna länkar; arkiven läses med en egen ZIP-läsare med skydd mot zip-bomber och sökvägar ut ur arkivet. Barnprofiler ser biblioteket bara om du väljer *Barnprofiler får se biblioteket*, och då bara böcker inom åldersgränsen. Läsappar (OPDS): KOReader, Panels, Chunky, Moon+ Reader m.fl. når katalogen på `/api/opds` med användarnamnet och ett eget lösenord för läsappar (*Mitt konto → Läsappar*), med serier, sök, nedladdning (om kontot får ladda ner) och sidströmning för serietidningar (OPDS-PSE).

## Live-TV och inspelning

### Live-TV och inspelning

HDHomeRun (antenn/kabel) eller IPTV (M3U). TV-guide från XMLTV eller HDHomeRuns egen guide. Titta live i webben och apparna, spela in enstaka program eller hela serier med regler: bara nya avsnitt (guidens flaggor, avsnittsnummer, redan inspelat eller redan i biblioteket), kanal, veckodagar och tidsfönster, behåll senaste N, egna marginaler och prioritet. Konflikter visas i förväg när tunrarna inte räcker, med förslag på andra sändningar – serieinspelningar flyttar sig själva till en repris som får en tuner, och högre prioritet tar tunern från lägre. Titta medan den spelas in. Efteråt MP4 (spelas överallt), MKV (alla ljudspår och undertexter) eller orörd TS, med metadata och NFO så att inspelningen hamnar under rätt serie i biblioteket. Diskutrymme och uppskattat behov syns i inspelningsvyn.

HDHomeRun (antenn/kabel) eller IPTV (M3U). TV-guide från XMLTV eller HDHomeRuns egen guide. Titta live i webben och apparna, spela in enstaka program eller hela serier (bara nya avsnitt), MP4 efteråt som spelas överallt.

### IPTV

Flera M3U-listor och Xtream Codes-konton samtidigt (även filmer och serier från leverantören, med hyllor, handling och *Fortsätt titta*). Flera XMLTV-guider (även .gz) i prioritetsordning, schemalagd uppdatering. TV-guide i rutnät som TiviMate: tusentals kanaler, grupper, favoriter per profil, piltangenter/fjärrkontroll och touch. Catch-up (Kodi-lägena default/append/shift/flussonic/xc) – se redan sända program och starta pågående från början – plus paus/spola tillbaka live. Påminn mig och spela in från guiden. Kanalhantering: byta namn, nummer, grupp och logotyp, dölja grupper, åldersgräns för barnprofiler. Reservström från en annan källa, automatisk återanslutning, kanalbyte med Page Up/Down och siffror, förstart av nästa kanal. Rubriker från listan (`#EXTVLCOPT`, `|User-Agent=`) och skydd mot interna adresser i listorna.

### Timeshift i live-TV

Pausa och spola tillbaka upp till 2 timmar (inställbart, med disktak). Knappen *Live* tar dig tillbaka till direktsändningen.

### Hoppa över reklam

Reklamavbrott i inspelningar hittas i bakgrunden (svart bild + tystnad) och hoppas över med en knapp eller automatiskt; kapitelmenyn hoppar mellan delarna.

### Streamingtjänster

*Var kan jag se den?* – visar om en titel finns på t.ex. Prime Video, TV4 Play, Netflix, SVT Play eller Viaplay och öppnar den i tjänstens app. Bläddra i det som finns på era tjänster. (Innehållet spelas i tjänstens egen app – det är kopieringsskyddat och kan inte läggas in i biblioteket.)

## Casting, TV och andra enheter

### Casting

Chromecast från Chrome, och AirPlay till Apple TV från Safari och iPhone/iPad-appen. Medan du castar styr du från en panel längst ner (spola, paus, ±10 s, volym, ljud- och undertextspår, stopp), framsteget och *sedd* sparas som vanligt, nästa avsnitt köas automatiskt och musik, ljudböcker och poddar kan castas från ljudspelaren.

Chromecast från Chrome, och AirPlay till Apple TV från Safari och iPhone/iPad-appen.

### Spela på…

Fjärrstyr en annan inloggad webbläsare i hemmet (TV-webbläsaren, datorn): välj *Spela på…* på titelsidan eller i spelaren och styr paus, spolning, ±10 s, ljud- och undertextspår, volym, nästa avsnitt och stopp från telefonen. *Flytta hit* tar över på den egna enheten från samma position. Se [Spela på en annan enhet](guide.md#spela-på-en-annan-enhet).

### Fjärrkontroll och TV-webbläsare

Hela webbappen styrs med bara pilar, OK och Bakåt – som på Google TV, Fire TV, LG, Samsung eller en TV-låda med webbläsare (ingen Tab behövs). Pilarna väljer det närmaste i pilens riktning: hyllorna rullar i sidled, ner och upp igen kommer tillbaka till samma kort, menyraden och sidomenyn nås från innehållet och fokus hamnar aldrig utanför skärmen. Varje sida börjar på första hyllans första kort (titelsidan: *Spela*), och Bakåt till en lista ger fokus på kortet du kom ifrån. Bakåt (Escape, Backspace och TV-plattformarnas Bakåt-knapp) stänger dialog eller meny, gör spelaren till litet fönster och går sedan till förra sidan. I spelaren flyttar pilarna mellan knapparna när kontrollerna syns och spolar/ändrar volymen när de är dolda; mediaknapparna (spela/paus, spola, nästa/föregående) styr film och musik. Tydlig fokusmarkering som syns på tre meters avstånd. TV-läget känns igen på webbläsaren – annars `?tv=1` i adressen (sparas, `?tv=0` tar bort).

### Logga in med kod

Slipp lösenord med fjärrkontrollen: TV:n (webbläsaren, Apple TV- eller Google TV-appen) visar en sexsiffrig kod och en QR-kod, som du godkänner från telefonen under Godkänn inloggning på TV i menyn. TV:n loggas in på den profil du använder (barnprofil → barnens åldersgräns). Kan stängas av i Administration → Säkerhet.

### Snabb webbapp

Medan en affisch, bakgrund eller miniatyr laddas visas bildens medelfärg (som Jellyfins BlurHash) i stället för en grå ruta – färgen räknas fram på servern när bilden sparas och i bakgrunden för befintliga bibliotek (en bild i taget). De första korten på sidan hämtas först och med hög prioritet, resten när de närmar sig skärmen. Första besöket visar startsidan på ungefär halva tiden (0,6 s i stället för 1,3 s med 100 ms fördröjning till servern): bara startsidans egna delar laddas först, och spelaren, musiken, ljudböckerna, sökningen och övriga sidor hämtas när startsidan visats – eller så fort muspekaren eller fokus når ett kort – så att Spela inte väntar. En direktlänk hämtar sidans alla delar på en gång. Stora svar (bibliotek med tusentals titlar) komprimeras med brotli utan att servern stannar upp under tiden.

### App på telefonen

Webben kan installeras som app på iPhone och Android: egen ikon, helskärm, meny längst ner och kompakt spelare. Se *Installera som app på telefonen* i [README](../README.md).

## Konton, delning och säkerhet

### Användare

Flera konton med egen tittarhistorik, *Fortsätt titta*, *Nästa avsnitt* och sedd/osedd.

### Delning och rättigheter (som Plex)

Under Administration → Användare → Rättigheter väljer du per konto och profil vilka bibliotek som syns (standard: alla, även nya), om kontot får ladda ner (originalfilen, offline i apparna och nedladdning i musikappar), högsta kvalitet utanför hemmet (sänker serverns inställning, gäller även vald kvalitet) och hur många strömmar hushållet får spela samtidigt. Ett bibliotek man inte har tillgång till är osynligt överallt: listor, startsidans hyllor, sök, kalendern, samlingar, personer, Min lista, *Fortsätt titta*, rekommendationer, titelsidor, bilder, strömmar, musik (även musikappar), ljudböcker och *Ditt år*. Profiler ärver kontots rättigheter och kan begränsas ytterligare. Inbjudningslänk: skapa en länk (engångs, giltig 1–30 dagar) med förvalda rättigheter – mottagaren väljer själv namn och lösenord. DLNA har ett eget val av bibliotek.

### Enkel inloggning (OIDC och LDAP)

Inbyggt, utan plugin: knappen *Logga in med …* för OpenID Connect (Authentik, Authelia, Keycloak, Google, Microsoft Entra …) med Authorization Code + PKCE, och LDAP (lldap, OpenLDAP, Active Directory, FreeIPA) direkt i det vanliga inloggningsformuläret – med ldaps:// eller StartTLS och certifikatkontroll (egen CA går att klistra in). Grupper → roll (administratör, vanlig, barn med åldersgräns) och bibliotek per grupp; kraven gäller vid varje inloggning. Automatiska konton (valbart – kräver grupper eller tillåtna e-postadresser/domäner, så att *Logga in med Google* inte släpper in vem som helst). Ett befintligt konto med samma namn eller e-post tas aldrig över: användaren bekräftar med det kontots lösenord (och tvåstegskod), eller kopplar under *Mitt konto*. Inställningar under *Administration → Säkerhet → Enkel inloggning* (hemnätet), med *Testa* och lista över kopplade konton. Valet *Bara administratörer loggar in med lösenord* gör den enkla inloggningen obligatorisk för övriga – administratörernas lösenord fungerar alltid (reservinloggning). Lokala konton fungerar som förut.

### Fjärråtkomst via BraXhn Relay

Nå servern utanför hemmet utan portöppning, VPN eller omvänd proxy – som Plex fjärråtkomst, men med ett eget relä på en VPS (reläet levereras separat, inte via GitHub, och byggs lokalt med Caddy för HTTPS). Hemservern ansluter ut till reläet och håller en tunnel öppen (HTTP/2 med en ström per förfrågan: video med Range, HLS, SSE, uppladdningar och många samtidiga förfrågningar utan att något buffras i minnet), ansluter igen av sig själv och visar status, senaste fel och trafik under *Administration → Fjärråtkomst via relä*. Parning med en engångskod från reläets logg eller adminsida (nyckelutbyte – varken koden eller hemligheten skickas över nätet). Allt som kommer via reläet räknas som utanför hemmet: administration nekas, tvåstegsverifiering och fjärråtkomst per konto gäller. Se *Fjärråtkomst via BraXhn Relay*.

### Språk: svenska och engelska

Webbappen finns på svenska och engelska – menyer, knappar, dialoger, toasts, felmeddelanden från servern, upplästa etiketter och datum/tid/tal (webbläsarens engelska variant, t.ex. `en-US` med 12-timmarsklocka, annars `en-GB`). Språket väljs efter webbläsaren vid första besöket (nordiska språk → svenska, engelska och alla andra språk → engelska) och går att byta på inloggningssidan och i *Mitt konto → Språk* (sparas för profilen och följer med till alla webbläsare). Titlar och beskrivningar från TMDB styrs som förut av *Språk för metadata* under Administration. Apparna, notiser, serverloggen och offlinesidan är fortfarande på svenska. Engelsk dokumentation: [README.en.md](../README.en.md).

### Tillgänglighet (WCAG 2.2 AA)

Hela webbappen fungerar med bara tangentbord eller fjärrkontroll – även spelaren, kortmenyerna (Shift+F10/Menu), TV-guidens rutnät, fotona, filterpanelen och *Nedladdat* – och alla kortkommandon visas med <kbd>?</kbd>. *Hoppa till innehållet*, rubrik och fliktitel per sida, tydlig fokusmarkering, etiketter på alla fält och reglage (tid, volym, stjärnor) och sparsamma upplästa besked för skärmläsare (toast, laddning, spelarens läge). Mitt konto → Tillgänglighet: textstorlek upp till 200 %, minska rörelse och hög kontrast (följer också systemets val och Windows högkontrast). Undertexter som du själv styr enligt FCC: storlek, typsnitt, färg, kantlinje, bakgrund och placering. Syntolkning: välj automatiskt ljudspåret med ljudbeskrivning när filmen har ett (*Mitt konto → Uppspelning*).

## Drift och integrationer

### Installationsguide

Efter första kontot leder guiden (`#/setup`) genom sju steg med stegindikator, *Tillbaka*/*Nästa*/*Hoppa över* och sparat läge: språk och tidszon (varning om containerns `TZ` skiljer sig från din enhet), TMDB-nyckel med knappen *Testa* och en förklaring av vad man får utan, förslag på bibliotek – servern tittar i mapparna under `MEDIA_ROOT` och gissar typ från namnet (Filmer/Movies, Serier/TV, Musik/Music, Ljudböcker/Audiobooks) och innehållet (videofiler med `S01E02` → serier, `.m4b` → ljudböcker) och visar skanningen live, hårdvaruomkodning (vad containern ser av `/dev/dri` och NVIDIA, hur `HWACCEL` ställs in i Unraid-mallen och en kort testkodning som visar bilder/s), åtkomst utanför hemmet (VPN eller egen adress, krav på tvåstegsverifiering, länkar till säkerhetskontrollen och Let's Encrypt) och hushållet (konton, barnprofiler, inloggning med kod på TV och var apparna finns). Sist en sammanfattning med vad som återstår. Startsidan visar *Slutför installationen* för administratören tills guiden är klar. Fungerar på telefon och med tangentbord/fjärrkontroll (↑/↓ mellan kontrollerna, ←/→ mellan stegen). Kräver administratör på hemnätet; kan hoppas över helt och köras igen under Administration.

### Uppdateringar

Administratören ser *Ny version finns* med vad som är nytt (GitHub-releasen, högst en fråga per dygn, inget telemetri – avstängbart). Säkerhetskopia av databasen före varje uppgradering och ett nedgraderingsskydd som hellre vägrar starta än förstör data. Installeras via Unraids Community Applications (mall för NVIDIA också), kör som `nobody:users` (PUID/PGID/UMASK) och stänger av rent när Unraid stoppar containern.

### Säkerhetskopior

Databasen kopieras automatiskt kl. 03.00 varje natt (14 sparas) och kan laddas ner från statistiksidan.

### Extern säkerhetskopia

Krypterad kopia (AES-256-GCM) varje natt till en annan disk/NAS eller S3-lagring (Backblaze B2, Wasabi, R2, MinIO, AWS). Återställning med ett klick.

### Diagnostikpaket

*Administration → Hälsokontroll → Skapa diagnostikpaket*: ett `.tar.gz` att bifoga i en buggrapport med version, miljö, hårdvaruacceleration, logg, databasens och bibliotekens storlek – token, lösenord, e-post och IP-adresser maskerade, filnamn bara om du väljer det. Innehållet visas före nedladdningen (se *Diagnostikpaket för supporten*).

### Serverlogg och diagnostik

*Administration → Serverlogg* visar serverns händelser med filter, även fel som uppstått i webbappen hos användarna. Loggen sparas också i `/config/logs` (sju dagar). *Ladda ner diagnostik* ger versioner, maskin, hårdvarukodning och loggen i en fil att bifoga vid felsökning – nycklar och lösenord maskeras.

### Aktivitet

Administratörer ser i menyraden när servern arbetar (skanning, analys, omkodning, inspelning, nedladdning) och kan öppna en lista med förloppet.

### Notiser

Larm till mobilen via ntfy, Pushover, Gotify, Discord, Telegram eller webhook: attacker, spärrade konton, certifikat, säkerhetskopior, inspelningar, önskningar och nya versioner.

### Webhooks

Som Plex Pass-webhooks, gratis: `media.play`, `media.pause`, `media.resume`, `media.stop`, `media.scrobble` (sett ≥ 90 %), `library.new`, `library.scan.done`, `request.new`, `recording.done` och `server.update` som JSON i Plex-stil (profil, enhet, titel, år, serie/säsong/avsnitt, TMDB-id, position, längd, omkodning och kvalitet) eller som Discord-/ntfy-meddelande. Signerade med HMAC-SHA256 (`X-BraXhn-Signature: sha256=…`), kö med omförsök och leveranslogg. Administratören lägger in serverns webhooks (och kan uttryckligen tillåta en adress i hemnätet för Home Assistant), varje vuxen profil kan ha egna för sina egna uppspelningar.

### Sonarr/Radarr

Webhook gör att nya avsnitt dyker upp direkt efter nedladdning. Önskningar: alla i hushållet kan önska filmer/serier, som skickas till Radarr/Sonarr när de godkänts. Visar om titeln redan finns på en av era tjänster.

### Trakt

Varje person kan koppla sitt Trakt-konto: sett-status synkas åt båda hållen, egna betyg skickas och "tittar nu" visas.

### Import och synk från Plex/Jellyfin

Sedda och påbörjade titlar förs över från Plex eller Jellyfin/Emby – alla Plex-profiler: ägaren, hemanvändare (växling via plex.tv, PIN vid behov) och delade vänner, eller direkt ur Plex databasfil (alla konton, offline). Varje Plex-profil kopplas till en profil här (förslag på samma namn) eller skapas som ny profil under huvudkontot – begränsade Plex-profiler blir barnprofiler med åldersgräns. Matchning på filsökväg, TMDB/IMDb/TVDB-id, mappnamn (samma tolkning som skanningen) och titel/år; avsnitt på filens säsong och avsnitt. Nyare historik här skrivs aldrig över utan *Skriv över*, tiden när du såg titeln i Plex behålls. Valfri löpande synk (envägs, av som standard) var N:e timme med bara det som ändrats.

### Prometheus

Mätvärden på `/metrics` (strömmar, omkodningar, skanning, disk, tuners) för Grafana, skyddade med token.

### DLNA

Smart-TV utan app hittar biblioteket på hemnätet. Avstängt som standard, se [guide.md](guide.md).

## Appar

### Översikt

iPhone, iPad, Apple TV, Google TV/Android TV och Android Automotive (Polestar 4) – med musik, ljudböcker och poddar i bilen och byte av ljud/undertext samt kapitel i spelaren. iPhone/iPad/Apple TV-appen har dessutom live-TV (kanaler med logga och Nu/Sen, TV-guide, boka inspelning, inspelningar), profilbyte med PIN, Min lista, startsidans hyllor i din ordning (egna samlingar, Kommer snart, Eftersom du såg …, Topprankat, Dagens genre, Fortsätt lyssna …), bio-läge med Hoppa över och nattläge/tydligare dialog.

### Android-appen (telefon, bil, Google TV)

I bilen (Android Auto och Android Automotive): Musik, Ljudböcker och Poddar som flikar, musikens Stationer och låtradio från ljudanalysen, *Radio: artist* på artistsidan, sökning i musik, ljudböcker och poddar och röststyrning ("spela … på BraXhn TV"), sovtimer – bara ljud, ingen video krävs. Android Auto kräver *Okända källor* för en app som inte kommer från Play. Byt profil (med PIN, eller huvudkontots lösenord från en barnprofil), Min lista på titelsidan och som hylla, startsidans hyllor i den ordning du valt under *Anpassa startsidan* (Fortsätt lyssna, Kommer snart, Eftersom du såg …, Rekommenderat, egna samlingar, Kort film ikväll, Topprankat, Den här dagen, Dagens genre, Glömda guldkorn). I spelaren: bild-i-bild på telefon (knappen eller hemknappen), hastighet 0,75–2×, bio-läge (trailers/förfilm med *Hoppa över* när det är påslaget under Mitt konto) och nattläge/tydligare dialog. På Google TV läggs *Fortsätt titta* i systemets rad *Fortsätt titta* (Watch Next). Bild och ljud på Google TV (som Kodi/Infuse): bitström till förstärkaren/soundbaren – Dolby Digital, Dolby Digital Plus med Atmos, DTS/DTS-HD och Dolby TrueHD spelas orört direkt ur filen när förstärkaren tar emot formatet (även ett annat ljudspår än standard, valt i spelaren utan omstart); HDR10, HDR10+, HLG och Dolby Vision direkt när TV:n klarar typen (annars tonmappar servern); automatisk bildfrekvensväxling (*Av* / *Bara bildfrekvens* / *Bildfrekvens och upplösning* under Inställningar), tillbaka till det vanliga läget när du slutar titta. Nytt i appen (främst Google TV): TV-guide i rutnät med D-pad (bläddrar en timme vid kanten, upp till en vecka bakåt), catch-up och *Från början*, favoritkanaler per profil, kanalbyte med upp/ned, CH+/CH− och sifferknapparna, IPTV-filmer och serier (Xtream) som hyllor; inspelningar i flikarna *Kommande* / *Pågår* (titta medan den spelas in) / *Inspelat* med Hoppa över reklam; egna betyg (stjärnor, halva steg), extramaterial och temamusik (låg volym, tonas ut) på titelsidan; repliksökning i sökningen; *Synka automatiskt* i undertextmenyn; familjefiltret och syntolkning visas i spelaren och markerade scener hoppas över.
