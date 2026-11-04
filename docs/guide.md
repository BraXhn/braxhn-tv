# Guider

Inställningar och detaljer för de större delarna av BraXhn TV. Installation, fjärråtkomst, felsökning och
miljövariabler står i [README](../README.md); hela funktionslistan i [funktioner.md](funktioner.md).

## Live-TV och inspelning

1. **HDHomeRun:** Administration → *Live-TV och inspelning* → ange enhetens IP-adress (eller *Sök efter HDHomeRun*, vilket kräver att containern kör med host-nätverk). Guiden hämtas automatiskt från HDHomeRun.
2. **IPTV:** se [IPTV](#iptv) nedan.
3. Lägg till sökvägen **/recordings** i Unraid-mallen (t.ex. `/mnt/user/media/Inspelningar`). Inspelningar sparas som MP4, och mappen kan även läggas till som ett vanligt bibliotek.

**Serieinspelningar:** *Spela in serien* i TV-guiden (eller *Ny serieinspelning* under Inspelningar) öppnar regeln: kanal, veckodagar, tidsfönster (t.ex. bara sändningar som börjar 18–23), *Bara nya avsnitt*, *Hoppa över avsnitt som redan finns i biblioteket*, *Behåll senaste* (äldre tas bort – inte de du markerat *Behåll alltid*), prioritet, marginaler och format. Rutan visar direkt vilka sändningar som skulle spelas in och varför de andra hoppas över.

**Konflikter:** fliken *Konflikter* visar i förväg vilka bokningar som börjar sent, avbryts eller inte spelas in alls när tunrarna inte räcker, vad de krockar med och andra sändningar av samma avsnitt att flytta till. En inspelning med högre prioritet avbryter en med lägre (det inspelade sparas).

**Inspelningsmappen i biblioteket:** inspelningar sparas som `Serie/Season 01/Serie - S01E02 - Titel.mp4` (utan avsnittsnummer: `Serie/Serie - 2026-10-27 2000.mp4`) med en NFO bredvid. Lägg till mappen som en extra mapp i seriebiblioteket så hamnar inspelningarna under rätt serie. Under inspelningen är filen dold (punkt först) så att skanningen inte tar med en halvfärdig fil. Format och omkodning väljs i Live-TV-panelen eller per regel.

Antenn-TV (MPEG-2, flätad bild) kodas om till H.264 när du tittar live; IPTV i H.264 kopieras utan omkodning. Antalet samtidiga kanaler begränsas av antalet tuners.

**Timeshift:** live-TV sparas 2 timmar bakåt från att någon börjar titta på kanalen (*Timeshift (min)* och *Timeshift max (GB)* i Live-TV-panelen). Minst 2 GB lämnas alltid ledigt. Strömmen stängs när ingen hämtat den på 45 sekunder.

### IPTV

*Administration → Live-TV → IPTV* (eller **Hantera** i TV-guiden) har fem flikar:

- **Källor:** *+ M3U-lista* (adress eller fil under `/config`) eller *+ Xtream Codes-konto* (server, användarnamn och lösenord från leverantören – inloggningen prövas innan något sparas, lösenordet visas aldrig igen). Flera källor går bra samtidigt. Per källa: samtidiga anslutningar (Xtream: kontots gräns), hur ofta listan uppdateras (standard var 24:e timme), egen User-Agent/Referer om leverantören kräver det, och om strömmar och guider i listan får ligga på hemnätet. Xtream-källor hämtar även **filmer och serier** (en gång per dygn) – de syns under *Live-TV → Filmer & serier*.
- **TV-guider:** guider som gäller alla källor. En kanal tar programmen från den första guide som har dem: källans egen guide, Xtream-serverns guide, listans `url-tvg` och sist de gemensamma. Kopplingen sker på `tvg-id`, annars på kanalnamnet. Tidsförskjutning per guide (timmar) om guiden har fel tidszon; `tvg-shift` i listan gäller per kanal.
- **Kanaler:** byt namn, nummer (styr ordningen), grupp, logotyp och guide-id, dölj eller sätt åldersgräns. Ändringarna finns kvar när listan uppdateras; *Återställ allt* tar tillbaka listans värden.
- **Grupper:** dölj hela grupper (syns då inte heller i apparna), ordning och åldersgräns. Grupper och kategorier med vuxeninnehåll i namnet (*Adult*, *XXX*, *18+* …) och kanaler märkta `censored`/`parent-code` får 18 år automatiskt.
- **Inställningar:** hur ofta guiden uppdateras och *Snabbt kanalbyte* (nästa kanal startas i förväg när källan har en ledig anslutning).

**TV-guiden** (*Live-TV → TV-guide*) är ett rutnät: kanalerna står still till vänster, tiden överst och en röd linje för nu. Välj grupp eller *★ Favoriter* (håll inne/högerklicka på en kanal), dag (bakåt så långt som catch-up räcker) och sök. På TV och med tangentbord: ←/→ föregående/nästa program, ↑/↓ samma tid i kanalen ovanför/under, Page Up/Down en skärm, Home = nu, Enter = programmet, ← från första programmet = kanalen (Enter tittar). Programmet: *Titta*, *Från början* och *Spela* (catch-up), *Påminn mig* (toast i webben och personlig notis via ntfy/webhook under *Mitt konto*), *Spela in* och *Spela in serien*.

**Catch-up** kräver att leverantören har arkiv: `catchup`/`catchup-source`/`catchup-days` (eller `tvg-rec`/`timeshift`) i listan, eller `tv_archive` hos Xtream. Lägena *default*, *append*, *shift*, *flussonic* och *xc* med Kodis platshållare (`{utc}`, `{duration:60}`, `{Y}-{m}-{d}` …). Spolning längre fram än det som hunnit hämtas startar om från den tidpunkten. Program sparas i guiden så långt bakåt som arkivet räcker.

**I spelaren:** ▲/▼ eller Page Up/Down (och Channel Up/Down på fjärrkontroller) byter kanal i guidens ordning, siffror väljer kanalnummer, ☆ gör kanalen till favorit. Står bilden still laddas strömmen om automatiskt. Går en kanal inte att starta provas samma kanal (`tvg-id`, annars namnet) i nästa källa, och en anslutning som ingen hämtat från på 8 sekunder lämnas över till den nya kanalen – leverantörer med en enda anslutning fungerar därför vid kanalbyte. H.264 kopieras utan omkodning; annat kodas om (med GPU när `HWACCEL` är satt).

**Säkerhet:** adresserna du själv skriver in (lista, guide, Xtream-server) får ligga var som helst, även på samma maskin (Threadfin, xTeVe, TVHeadend). Adresser *i* listan (strömmar, guider, catch-up, omdirigeringar) får bara gå till internet, hemnätet (kan stängas av per källa) eller samma värd – aldrig `localhost`, länklokala adresser eller molnens metadatatjänst. Alla hämtningar har tidsgräns och storleksgräns (även uppackad gzip), och listor och guider tolkas med egna läsare som klarar trasiga och fientliga filer.

**Reklam:** efter varje inspelning letas reklamavbrott upp i bakgrunden, en inspelning i taget och med lägsta prioritet. Det fungerar bara på kanaler som har svart bild och tystnad mellan reklamfilmerna. Analysen kan stängas av i panelen eller med `DVR_COMSKIP=0`.

## Musikappar (Subsonic)

BraXhn TV har ett **Subsonic-API** (version 1.16.1 med OpenSubsonic-tillägg, som Navidrome), så att färdiga musikappar fungerar: Symfonium, Amperfy, play:Sub (med CarPlay), Feishin, Supersonic, substreamer och Music Assistant (för Sonos m.fl.). Funktionen är på som standard och kan stängas av under Administration → Säkerhet.

1. Gå till **Mitt konto → Musikappar** och tryck *Skapa lösenord för musikappar*. Ange ditt vanliga lösenord (för en profil: huvudkontots). Lösenordet visas **en gång** – skriv in det i appen direkt.
2. Lägg till servern i appen som en **Subsonic**-server (i Symfonium: *Lägg till mediaserver → Subsonic*; i Amperfy: *Server URL* och inloggning; i Music Assistant: tillägget *Subsonic/Open Subsonic*):
   - **Adress:** `https://<din server>` – hemma t.ex. `http://192.168.1.10:8420`. Appar som vill ha hela adressen till API:t anger `https://<din server>/rest`.
   - **Användarnamn:** ditt namn i BraXhn TV (eller profilens namn).
   - **Lösenord:** lösenordet för musikappar – **inte** ditt vanliga lösenord, det fungerar inte här.
   - Välj gärna *legacy/klartext-inloggning av* (standard): appen skickar då bara en md5-kontroll med salt. Använd HTTPS utanför hemmet.
3. Behöver du lösenordet igen skapar du ett nytt (det gamla slutar då fungera i alla appar) eller trycker *Återkalla*.

**Säkerhet**
- Lösenordet för musikappar gäller **bara** `/rest` och bara musiken: inga filmer, serier, ljudböcker, poddar, live-TV eller administration. Vanliga inloggningar (kakor, appens token, länkar för uppspelning) fungerar inte på `/rest`.
- Det sparas krypterat (AES-256-GCM) med en nyckel i `/config/subsonic.key`, som inte ingår i databasens säkerhetskopior. Flyttar du servern utan den filen fungerar bara appar som skickar lösenordet i klartext – skapa då nya lösenord.
- Upprepade fel lösenord spärrar IP-adressen för musikappar en stund (10 fel på 10 minuter), och användarnamnet spärras för försök utifrån (inte hemifrån, så att ingen kan låsa ute hushållets appar). Spärren påverkar inte webbinloggningen. Felen syns i revisionsloggen och i serverloggen (`[auth] subsonic_login_fail …` för CrowdSec/fail2ban).
- **Utanför hemmet** gäller samma regler som för apparna: konton som bara får användas hemma nekas, och kräver administratören tvåstegsverifiering utanför hemmet måste kontot ha det. Eftersom musikappen inte kan fråga efter en kod skapas lösenordet bara **hemifrån** – eller utifrån med kod från autentiseringsappen.
- Lösenordet återkallas när du byter lösenord, när administratören sätter nytt lösenord eller loggar ut dig överallt, och när kontot tas bort.
- **Barnprofiler** får använda musikappar (musik har ingen åldersgräns i BraXhn TV) men scrobblar aldrig. Profiler med **skärmtid för ljud** nekas, eftersom musikappar inte rapporterar lyssnandet så att skärmtiden kan räknas.

**Vad som stöds:** bläddra (artister, album, mappar, genrer), listor (slumpvis, nyast, mest och senast spelat, favoriter, A–Ö, år, genre), sök (även tom sökning för att synka hela biblioteket), spellistor (skapa, ändra, ta bort; de smarta listorna visas som skrivskyddade), favoriter på låtar, album och artister, strömning direkt eller omkodad till MP3 med `maxBitRate`/`format` (samma tak för omkodning som webben), nedladdning för offline, omslag i valfri storlek, låttexter (även synkade, OpenSubsonic) och scrobbling: när appen meddelar att en låt är lyssnad räknas den i *Spelat* och de smarta listorna och skickas till ListenBrainz/Last.fm om du kopplat dem. Id:n har prefix (`ar-`, `al-`, `tr-`, `pl-`, `sp-`). **Stöds inte:** poddar, internetradio, delning, jukebox, betyg och videor via Subsonic.

## Casting

- **Chromecast:** knappen *📺 Casta* visas i spelaren och i ljudspelaren i Chrome. Googles regler kräver att sidan öppnas via **HTTPS**, alltså alternativ 2 eller 3 under *Titta utanför hemmet* i README. Chromecasten hämtar strömmen själv med en tidsbegränsad länk som gäller 24 timmar och bara för just den titeln (varje köat avsnitt får en egen). Medan du castar visas en panel längst ner med spolning, paus, ±10 s, volym, ljud- och undertextspår och stopp; framsteget sparas var 10:e sekund och vid paus och stopp, så *Fortsätt titta* och *sedd* stämmer. Nästa avsnitt köas på Chromecasten och startar av sig självt. Musik castas med resten av kön, ljudböcker från den sparade positionen (nästa del köas). Trailers i bio-läget spelas inte på Chromecast.
- **AirPlay:** finns i Safari på Mac/iPhone och i iPhone/iPad-appen. Det fungerar hemma utan HTTPS.

## Spela på en annan enhet

Varje inloggad webbläsare med BraXhn TV öppen syns som en enhet för de andra i hushållet – t.ex. TV:ns webbläsare eller datorn i vardagsrummet. Fungerar utan HTTPS och utan Chromecast (som finns kvar).

1. Öppna BraXhn TV på TV:n/datorn. Byt gärna namn på den: *Spela på… → Den här enheten: … → Byt namn* (t.ex. "Vardagsrums-TV").
2. På telefonen: öppna en film eller ett avsnitt och tryck **Spela på…** (eller samma knapp i spelaren för att skicka det som spelas just nu, med samma position och spår).
3. En fjärrkontroll visas längst ner: paus, spola, ±10 s, nästa avsnitt, stopp, ljud- och undertextspår och volym. **Flytta hit** stoppar på TV:n och fortsätter på telefonen där den var.

Bra att veta:
- Webbläsare spelar inte upp med ljud förrän någon har tryckt på sidan. Visas **Tryck för att starta** på TV:n – tryck en gång (även med fjärrkontrollens OK-knapp). Därefter går det att starta från telefonen så länge sidan är öppen.
- Mottagaren visar *Styrs från …* så att den som sitter vid TV:n ser vad som händer.
- **Vem ser vilka enheter:** samma profil ser alltid sina egna. Vuxna profiler i hushållet ser varandras enheter (en förälder kan styra TV:n där barnprofilen är inloggad), men en PIN-skyddad profils enheter syns bara för profilen själv och huvudkontot. Barnprofiler styr bara sina egna enheter. Andra konton – även administratörer – ser inga. En titel startas bara om både den som styr och profilen på mottagaren får se den (åldersgränsen).
- *Dölj den här enheten för andra* i samma meny om en webbläsare inte ska kunna styras. Musik som spelas på mottagaren kan pausas, spolas och hoppas över, men startas inte på distans än. Apparna kan inte ta emot ännu.

## DLNA (smart-TV utan app)

Slå på under **Administration → DLNA** (eller `DLNA=1`). TV:n hittar servern via multicast (239.255.255.250:1900), så containern behöver nätverkstypen **host** (eller macvlan/br0 med egen IP) – med bridge-nätverk syns servern inte. Om en annan DLNA-server redan använder port 1900: sätt `DLNA_SSDP=0` och ange adressen manuellt i spelaren.

Alla enheter på hemnätet kan se och spela upp det som DLNA visar **utan inloggning**, så ställ in en åldersgräns om barnen har egna enheter, och välj vid behov **vilka bibliotek** som visas. DLNA svarar bara på hemnätet och aldrig via en omvänd proxy. Ljudböcker och poddar visas inte, och det finns ingen sökning.

## Import, diskövervakning och Prometheus

- **Import från Plex/Jellyfin:** *Administration → Importera tittarhistorik*. Plex på två sätt: **Plex-servern** (adress och ägarens `X-Plex-Token` – hemanvändarna hämtas via plex.tv, profiler med PIN kräver PIN:en för påbörjade titlar, delade vänner ger bara sedda titlar) eller **Plex databasfil** (`com.plexapp.plugins.library.db`, mest exakt och fungerar utan att Plex körs): montera Plex appdata-mapp i Docker-mallen, gärna skrivskyddat (t.ex. `/mnt/user/appdata/plex` → `/plex`), och ange mappen eller filen – den kopieras och läses skrivskyddat. Jellyfin/Emby: API-nyckel och användare. Ange vid behov sökvägsmappning (t.ex. `/data/movies` → `/media/Filmer`). Förhandsvisningen visar varje profil med antal sedda/påbörjade och vad som matchar; välj per profil *Koppla till* en profil här, *Skapa ny profil*, *Skapa barnprofil* eller *Hoppa över*. Kopplingen sparas till nästa gång. Redan sedda titlar markeras aldrig som osedda, och det du sett eller påbörjat här efter tiden i Plex skrivs inte över. Kryssa i *Synka löpande från Plex* för att hämta nya ändringar automatiskt (token sparas på servern bara medan synken är på).
- **Diskövervakning:** gränserna (standard 10 % och 10 GB) ställs in på adminsidan. Notistypen *Lågt diskutrymme* behöver kryssas i om du redan har sparat dina notisval.
- **Prometheus:** skapa en token på adminsidan (visas en gång) eller sätt `METRICS_TOKEN`, och skrapa `/metrics` med `Authorization: Bearer <token>`. Utan token är `/metrics` avstängt.

## Snabbstart när diskarna sover

En arraydisk som har gått ner i viloläge tar 5–15 s att snurra upp, och så länge står filmen och laddar. Med *snabbstart* ligger början av de titlar som troligen spelas härnäst på cache-poolen (SSD/NVMe) – filmen startar direkt och läsningen går över till arraydisken när den hunnit vakna, utan avbrott.

1. Skapa en mapp på cache-poolen, t.ex. `/mnt/cache/appdata/braxhn-tv/prestart` (en mapp under `appdata` på cache-poolen fungerar bra – använd `/mnt/cache/…` och inte `/mnt/user/…`, så att filerna säkert ligger på SSD:n).
2. **Docker → braxhn-tv → Edit**, slå på *Avancerad vy* och fyll i **Snabbstart (startcache)** med mappen. Saknas fältet (äldre mall): *Add another Path* med *Container Path* `/prestart`, *Host Path* mappen och *Access Mode* Read/Write. Klicka **Apply**.
3. Under *Administration*, i panelen *Snabbstart när diskarna sover*, syns mappen, hur mycket som används och träffgraden. Ställ in största storlek (standard 20 GB). *Fyll nu* kopierar direkt (och väcker diskarna); annars fylls cachen av sig själv.

Så fungerar det:
- **Vad som kopieras:** de första 90 sekunderna (`PRESTART_SECONDS`, räknat på filens bithastighet) av *Fortsätt titta* (även platsen där du slutade), nästa och nästnästa avsnitt i serier som hushållet tittat på den senaste månaden och nyligen tillagda titlar – i den ordningen, så länge de ryms. Dessutom filens index när det ligger sist (MP4 med `moov` sist, slutet av MKV med Cues). En titel tar som mest en sjättedel av cachen.
- **När:** bara när disken ändå är vaken. Servern läser diskarnas I/O-räknare i `/sys/block` (och frågar `hdparm -C` om verktyget och enheten finns) när den kan se vilken disk biblioteket ligger på. Genom Unraids användarresurser (`/mnt/user`) syns inte disken – då räknas disken som vaken i 10 minuter (`PRESTART_AWAKE_MIN`) efter att servern själv läst i samma mapp eller serie: skanning av nya filer, uppspelning och väckning. Kopieringen går med högst 40 MB/s (`PRESTART_MBPS`) och en titel i taget. Lämnar alltid minst 1 GB ledigt på cache-poolen.
- **Vid uppspelning:** direktuppspelning (spelaren hämtar med Range) får de cachade bitarna direkt medan originalfilen öppnas parallellt; ffmpeg (remux och omkodning från början) får en sammansatt ström av cachen och originalfilen. Spolning till en plats som inte är cachad läser från disken som vanligt.
- **Väckning i förväg:** när du öppnar en titelsida (serie: nästa avsnitt) eller pekaren hamnar på ett korts Spela läser servern några kilobyte av filen i bakgrunden, så att disken redan snurrar när du trycker Spela. Det gäller även utan mapp. Stäng av allt med *Snabbstart på* om du inte vill att diskarna väcks.
- **Ändrade filer:** cachen gäller bara så länge filens storlek och ändringstid stämmer. Ändras filen kastas kopian – även mitt i en uppspelning, som då avbryts och startas om från originalfilen.
- **Tips:** Unraids tillägg *Dynamix Cache Directories* håller mapplistningarna i minnet, så att inte heller listningen av undertexter i filmens mapp väcker disken.

## Uppgradera från äldre versioner

Gäller bara den som uppgraderar från en mycket gammal version. Nyare versioner uppgraderar databasen själva.

- **Från 0.1:** Kör `install.sh` igen och starta om containern. Alla filer analyseras om automatiskt en gång för HDR-information, nyckelbilder och intro. Det kan ta en stund för stora bibliotek.
- **Till 0.3:** Alla loggas ut en gång eftersom token nu lagras hashade. Apparna måste också uppdateras till den nya versionen. Logga in igen i webben och i apparna. Befintliga lösenord fungerar, men svaga lösenord ger en uppmaning att byta.
- **Till 0.4:** Inga åtgärder krävs. Databasen uppgraderas automatiskt. Uppdatera apparna för musik, offline och "tidigare i serien".
- **Till 0.5:** Inga åtgärder krävs. Lägg till sökvägen `/recordings` i Unraid-mallen om du vill spela in live-TV. Passkeys kräver nu Face ID/fingeravtryck/PIN på enheten.
