# BraXhn TV – egen mediaserver för Unraid

BraXhn TV är en självhostad mediaserver för **filmer, serier, musik, ljudböcker, poddar och live-TV**, skriven från grunden. Den kräver inga konton, ingen molntjänst och ingen prenumeration. Allt körs på din egen server.

## Innehåll

```
server/   Node.js-server (inga npm-beroenden): API, skanner, strömning, intro-detektering
web/      Webbgränssnitt (fungerar i alla webbläsare, installerbart som webbapp)
apps/apple/       App för iPhone, iPad och Apple TV (SwiftUI)  → se apps/apple/README.md
apps/automotive/  Android-app för bilen (Android Automotive, t.ex. Polestar 4) och Google TV/Android TV (Kotlin) → se apps/automotive/README.md
braxhn-tv.xml     Unraid-mall          Dockerfile / docker-compose.yml / install.sh
```

## Funktioner

| Område | Vad som ingår |
|---|---|
| Bibliotek | Filmer, serier, **musik** och **ljudböcker**, mappväljare. Nya filer upptäcks direkt med **filbevakning** (med periodisk skanning som reserv). Igenkänning via filnamn (`S01E02`, `Film (2020)`). |
| Metadata | Affischer, beskrivningar, betyg och avsnittsnamn via TMDB (gratis nyckel, valfritt). Utan nyckel skapas miniatyrbilder ur videon. **Fel titel?** – sök och välj rätt i TMDB, matchningen låses. **Anime** med absolut numrering (`Serie - 1071`) mappas till säsonger. **Kapitel** läses från filerna. |
| Användare | Flera konton med egen tittarhistorik, *Fortsätt titta*, *Nästa avsnitt* och sedd/osedd. |
| **Profiler** | *Vem tittar?* – profiler i hushållet med egen historik och Min lista, valfri **PIN** och **åldersgräns** för barn (svensk åldersgräns från TMDB, med USA/Tyskland som reserv). |
| **Upptäck** | **Min lista**, **samlingar** (t.ex. alla Bond-filmer), **rekommendationer** utifrån det du sett och *Liknande titlar*. |
| **Direktuppspelning** | Filer som enheten klarar skickas orörda (med spolning). |
| **Remux** | H.264-, **HEVC**-, **HDR10**- och **Dolby Vision**-filer i MKV eller med fel ljudformat strömmas med **originalbilden kopierad**. Bara ljudet konverteras vid behov, så processorbelastningen blir nästan noll. Segmenten delas exakt på filens nyckelbilder, som indexeras vid skanningen. HEVC strömmas som fMP4-HLS till Apple-enheter. **Surroundljud** (AC-3/E-AC-3) skickas vidare orört när enheten klarar det. |
| Omkodning | Behövs bara för t.ex. HEVC till enheter utan HEVC-stöd, lägre kvalitet eller inbränning. Kan köras med processor eller GPU (Intel/AMD VAAPI, Quick Sync, NVIDIA NVENC). |
| **HDR → SDR** | HDR10, HLG och Dolby Vision (bas-lagret) tonmappas automatiskt när skärmen saknar HDR. Det görs med processor (zscale/tonemap) eller Intel/AMD-GPU (tonemap_vaapi). |
| **Undertexter** | Inbäddade och externa `.srt/.vtt/.ass`. Teckenkodningen för gamla svenska srt-filer identifieras automatiskt. Bildundertexter (Blu-ray PGS och DVD) **bränns in**. Undertexter kan sökas och laddas ner från **OpenSubtitles**, med exakt matchning via filhash. Tidsjustering ±. **Hämtas automatiskt** vid skanning för valda språk (bara exakta filhash-träffar som standard). **Två undertexter samtidigt** i webben, t.ex. för språkinlärning. |
| **Hoppa över intro** | Introt hittas automatiskt genom ljudfingeravtryck: avsnitten i en säsong jämförs och den gemensamma ljudsekvensen blir introt. Även **eftertexter** och **"tidigare i serien"** hittas och ger knapparna *Nästa avsnitt* och *Hoppa över sammanfattning*. Tiderna kan justeras manuellt. |
| **Förhandsbilder vid spolning** | Miniatyrer visas ovanför tidslinjen när du drar i den (skapas vid skanningen). |
| **Casting** | Chromecast från Chrome, och AirPlay till Apple TV från Safari och iPhone/iPad-appen. |
| **Utanför hemmet** | Kvaliteten begränsas automatiskt för tittare utanför hemnätet. Inbyggd HTTPS eller omvänd proxy, och appar med token-inloggning. Se nedan. |
| **Musik** | Album, artister, spellistor, favoriter och sökning. Omslag från `cover.jpg` eller inbäddad bild. Ljudspelare som fortsätter medan du bläddrar, med mediaknappar i telefon och bil. |
| **Titta tillsammans** | Synkad uppspelning med chatt, även mellan olika hem. Dela en länk – play, paus och spolning följer med för alla. |
| **Offline** | Ladda ner filmer och avsnitt i iPhone/iPad- och Android-appen och titta utan nät. Servern gör en mobilanpassad MP4 (H.264/AAC) i vald kvalitet. |
| **Statistik** | *Spelas nu* med möjlighet att stoppa en ström, tittartimmar, populäraste titlar och direkt/remux/omkodning-fördelning. |
| **Säkerhetskopior** | Databasen kopieras automatiskt kl. 03.00 varje natt (14 sparas) och kan laddas ner från statistiksidan. |
| **Ljudböcker** | En bok per mapp (`Författare/Bok/`) eller per `.m4b`. Kapitel, position som sparas, hastighet 0,75–2×, ±15/30 s, bokmärken. Även i bilen och i iPhone/Apple TV-appen. |
| **Poddar** | Prenumerera med RSS-adress. De senaste avsnitten laddas ner automatiskt, position sparas per person. Även i bilen. |
| **Live-TV och inspelning** | **HDHomeRun** (antenn/kabel) eller **IPTV** (M3U). TV-guide från XMLTV eller HDHomeRuns egen guide. Titta live i webben och apparna, spela in enstaka program eller **hela serier** (bara nya avsnitt), MP4 efteråt som spelas överallt. |
| **Streamingtjänster** | *Var kan jag se den?* – visar om en titel finns på t.ex. **Prime Video, TV4 Play**, Netflix, SVT Play eller Viaplay och öppnar den i tjänstens app. Bläddra i det som finns på era tjänster. (Innehållet spelas i tjänstens egen app – det är kopieringsskyddat och kan inte läggas in i biblioteket.) |
| **Sonarr/Radarr** | Webhook gör att nya avsnitt dyker upp direkt efter nedladdning. **Önskningar**: alla i hushållet kan önska filmer/serier, som skickas till Radarr/Sonarr när de godkänts. Visar om titeln redan finns på en av era tjänster. |
| **Trakt** | Varje person kan koppla sitt Trakt-konto: sett-status synkas åt båda hållen och "tittar nu" visas. |
| **Notiser** | Larm till mobilen via ntfy, Pushover, Gotify, Discord, Telegram eller webhook: attacker, spärrade konton, certifikat, säkerhetskopior, inspelningar, önskningar och nya versioner. |
| **Uppdateringar** | Servern talar om när en ny version finns och vad som är nytt. |
| **Extern säkerhetskopia** | Krypterad kopia (AES-256-GCM) varje natt till en annan disk/NAS eller S3-lagring (Backblaze B2, Wasabi, R2, MinIO, AWS). Återställning med ett klick. |
| Appar | iPhone, iPad, Apple TV, **Google TV/Android TV** och Android Automotive (Polestar 4) – med musik, ljudböcker och poddar i bilen och byte av ljud/undertext samt kapitel i spelaren. |

## Installation på Unraid

GitHub bygger Docker-imagen automatiskt (`ghcr.io/braxhn/braxhn-tv:latest`) vid varje ändring, så Unraid behöver bara hämta den.

1. Öppna Unraids terminal (ikonen `>_` uppe till höger) och kör:
   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-braxhn-tv.xml https://raw.githubusercontent.com/BraXhn/braxhn-tv/main/braxhn-tv.xml
   ```
2. Gå till **Docker → Add Container** och välj mallen **braxhn-tv**.
3. Peka **Media** på din mediamapp och klicka **Apply**.
4. Öppna `http://SERVERNS-IP:8420`, skapa administratörskontot och lägg till bibliotek under **Administration**.

**Uppdatera:** klicka *Check for updates* i Docker-fliken, sedan *apply update*.

**Bygga själv i stället:** klona repot på servern och kör `bash install.sh`. Det bygger `braxhn-tv:local` lokalt och installerar mallen.

**Appar:** GitHub bygger apparna under fliken **Actions**:
- *Android Automotive-app*: ladda ner APK/AAB under *Artifacts*.
- *Apple-app*: kontrollerar att koden kompilerar.

**Uppgradera från 0.1:** Kör `install.sh` igen och starta om containern. Alla filer analyseras om automatiskt en gång för HDR-information, nyckelbilder och intro. Det kan ta en stund för stora bibliotek.

## Titta utanför hemmet

Det finns tre sätt, och de kan kombineras.

### 1. VPN med NetBird (enklast för mobil, surfplatta och dator)

Du kör redan NetBird i OPNsense, så det kan användas direkt:

1. I NetBird-dashboarden, gå till **Networks** (eller *Network Routes*) och lägg till ditt hemnät, t.ex. `192.168.1.0/24`. Välj OPNsense-peeren som *routing peer*.
2. Installera NetBird-appen på iPhone/iPad/dator och logga in.
3. Använd samma adress som hemma: `http://192.168.1.x:8420`.

Ingenting exponeras mot internet. Om NetBird-routen maskerar trafiken (standard) ser den ut att komma från ditt LAN. Utan maskering ser BraXhn TV adresser som 100.64.x.x som "utanför hemmet", och kvaliteten begränsas automatiskt.
*Begränsning:* VPN fungerar inte för bilen, inte för Chromecast och inte för en Apple TV hos någon annan. Där behövs alternativ 2 eller 3.

### 2. Egen domän med HTTPS via Nginx Proxy Manager (rekommenderas för bilen och Chromecast)

1. **Domän:** använd en egen domän eller en gratis DuckDNS-adress (t.ex. `braxhn.duckdns.org`). DuckDNS finns som Unraid-app och håller IP-adressen uppdaterad.
2. **Nginx Proxy Manager:** installera från Unraid Apps. Proxyns portar mappas t.ex. till 1880 (http) och 18443 (https), eftersom Unraid själv använder 80/443.
3. **OPNsense:** gå till **Firewall → NAT → Port Forward** och skapa två regler: WAN TCP 443 → Unraid-IP:18443 och WAN TCP 80 → Unraid-IP:1880. Port 80 behövs för Let's Encrypt.
4. **Proxy Host i NPM:**
   - Domän `tv.dindomän.se`, mål `http://UNRAID-IP:8420`.
   - Under SSL: *Request a new certificate*, *Force SSL* och *HTTP/2*.
   - Under Advanced:
     ```nginx
     proxy_buffering off;
     proxy_request_buffering off;
     proxy_read_timeout 3600s;
     client_max_body_size 0;
     ```
5. **BraXhn TV:** under **Administration → Inställningar → Utanför hemmet**, ange *Publik adress* `https://tv.dindomän.se` och välj maxkvalitet efter din uppladdningshastighet:

   | Uppladdning per samtidig tittare | Välj |
   |---|---|
   | minst 10 Mbit/s | 1080p |
   | minst 5 Mbit/s | 720p |

BraXhn TV litar på `X-Forwarded-For` bara när anslutningen kommer från det lokala nätet, alltså från proxyn. Inloggningsspärren mot gissade lösenord fungerar därför även bakom proxyn.

### 3. Inbyggd HTTPS med Let's Encrypt (utan proxy)

BraXhn TV kan själv hämta och förnya ett gratis certifikat från Let's Encrypt:

1. Skaffa ett domännamn som pekar på din publika IP, t.ex. `tv.dindomän.se` (eller gratis via DuckDNS).
2. I OPNsense: vidarebefordra **WAN 80 → Unraid-IP:8420** (för valideringen) och **WAN 443 → Unraid-IP:8443**.
3. Gå till **Administration → HTTPS med Let's Encrypt**, ange domänen och klicka *Hämta certifikat*. Prova gärna med *Testmiljö* först.

Certifikatet sparas i `/mnt/user/appdata/braxhn-tv/tls/`, HTTPS startar på port **8443** utan omstart, och det förnyas automatiskt 30 dagar före utgång.

Du kan också lägga ett eget certifikat som `cert.pem` och `key.pem` i samma mapp, t.ex. från OPNsense-pluginen **os-acme-client**. Förnyade filer läses in var sjätte timme.

> **Undvik Cloudflare Tunnel för video.** Cloudflares villkor begränsar videoströmning genom deras nät.

## Säkerhet

BraXhn TV är byggt för att kunna nås från internet. Detta finns inbyggt:

| Skydd | Hur det fungerar |
|---|---|
| **Tvåstegsverifiering (TOTP)** | Fungerar med Google/Microsoft Authenticator, 1Password, Bitwarden m.fl. Du får 10 engångs-reservkoder, och en kod kan inte användas två gånger. Aktiveras under **Mitt konto**. |
| **Passkeys** | Logga in med Face ID, Touch ID, Windows Hello eller säkerhetsnyckel (WebAuthn). Kan inte nätfiskas och räknas som tvåstegsverifiering. Läggs till under **Mitt konto** (kräver HTTPS och domännamn). |
| **Kräv 2FA utanför hemmet** | Inställning i **Administration → Säkerhet**. Konton utan 2FA kan då bara logga in på hemnätet eller via VPN. |
| **Starka lösenord** | Minst 10 tecken med tre olika teckentyper, eller minst 14 tecken. Vanliga lösenord och lösenord som innehåller användarnamnet nekas. Lösenorden hashas med scrypt. |
| **Skydd mot gissning** | Max 10 felaktiga försök per IP-adress (IPv6 räknas per /64) och 10 minuter. Lösenordskontrollen körs utanför händelseloopen, max 4 samtidigt, så att en attack inte fryser strömmar. Efter 5 fel spärras kontot för inloggning utifrån i 5 min, sedan växer spärren upp till 24 h. Spärren gäller inte från hemnätet, så ingen kan låsa ute dig. Svarstiden avslöjar inte om ett konto finns. |
| **Sessioner** | Token sparas bara som SHA-256-hash i databasen. Under **Mitt konto** ser du inloggade enheter och kan logga ut dem. Lösenordsbyte loggar ut alla andra enheter. |
| **Strömlänkar** | Kontots token skickas aldrig i en URL. Strömmar, Chromecast och AirPlay får en egen token som gäller 24 h och **bara den titeln**. Bilder i apparna får en egen bild-token. En länk som läcker i en proxylogg ger alltså ingen åtkomst till kontot. |
| **Administration** | Bara från hemnätet (RFC1918 och egna betrodda nät) som standard. Det går att öppna, men inte rekommenderat. Det första adminkontot kan bara skapas från hemnätet. NetBird-trafik som routas via OPNsense ser ut att komma från LAN och fungerar direkt. VPN-nätet 100.64.0.0/10 kan räknas som hemma om du slår på det i inställningarna. |
| **Fjärråtkomst per användare** | T.ex. barnens konton kan begränsas till hemnätet. |
| **Webbläsarskydd** | Content-Security-Policy (inga externa skript utom Googles Cast-SDK), CSRF-kontroll (Origin), `SameSite`/`HttpOnly`/`Secure`-cookies, HSTS över HTTPS, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` och Permissions-Policy. |
| **Överbelastning** | Tidsgränser mot långsamma anslutningar (slowloris). Tak för samtidiga omkodningar: 4 totalt och 2 per användare, kan ändras. Remux har tak på 4 per användare och 16 totalt. Undertexter extraheras en gång och cachas. |
| **Mediafiler** | ffmpeg får bara läsa lokala filer (`-protocol_whitelist file,pipe`), och undertextformat bestäms från filändelsen. |
| **Tvåstegsbyte** | Att aktivera eller byta 2FA kräver lösenordet, så en stulen session räcker inte för att ta över kontot. |
| **Docker** | Servern körs som PUID/PGID (inte root), med `no-new-privileges` och mediamappen skrivskyddad. |
| **Kodens integritet** | Tredjepartsfiler (hls.js, qrcode-generator) ligger i repot med checksummor som kontrolleras i CI och vid bygget – inget hämtas från CDN. Imagen innehåller `integrity.json` med SHA-256 för alla programfiler; säkerhetskontrollen larmar om något ändrats i containern. GitHub Actions är låsta på commit-SHA (uppdateras av Dependabot), och varje image byggs med SBOM och provenance och signeras med Sigstore. |
| **Säkerhetslogg och säkerhetskontroll** | Inloggningar, misslyckade försök och adminändringar loggas med IP-adress. **Administration** visar en checklista över vad som bör åtgärdas. |

**Viktigt om omvänd proxy och klientens IP-adress**
- BraXhn TV avgör "hemma eller utifrån" från klientens IP. Bakom Nginx Proxy Manager läses `X-Forwarded-For` **från höger**, så en angripare kan inte förfalska en lokal adress genom att skicka headern själv.
- Proxyn **måste** skicka `X-Forwarded-For`. NPM gör det som standard.
- Annars ser alla anslutningar ut att komma från proxyns lokala adress och räknas som hemma. Det gäller också NAT-lösningar som maskerar källadressen, t.ex. en VPS-tunnel med MASQUERADE eller Cloudflare Tunnel.
- **Kontrollera** under *Administration → Säkerhetskontroll*: raden *Din adress enligt servern* ska visa din riktiga publika adress när du ansluter utifrån, t.ex. via mobilnätet.
- Om du vet proxyns adress, sätt `TRUSTED_PROXIES` (t.ex. `172.17.0.5/32`) så att bara den får ange klientadress.

**Rekommenderad konfiguration när servern nås från internet:**
1. Använd HTTPS, via Nginx Proxy Manager eller inbyggt Let's Encrypt (se ovan). Kör aldrig okrypterat över internet.
2. Aktivera 2FA eller passkeys på alla administratörskonton, och slå på *Kräv tvåstegsverifiering utanför hemmet*.
3. Låt *Administration från internet* vara avstängd. Administrera hemifrån eller via NetBird.
4. Geoblockera i OPNsense (GeoIP-alias på WAN-regeln) så att t.ex. bara Sverige och EU släpps in.
5. Valfritt: CrowdSec eller fail2ban kan läsa containerloggen. Misslyckade inloggningar loggas som `[auth] login_fail ip=… user=…`.
6. Håll containern uppdaterad, och säkerhetskopiera `/mnt/user/appdata/braxhn-tv`.

> **Uppgradering till 0.5:** Inga åtgärder krävs. Lägg till sökvägen `/recordings` i Unraid-mallen om du vill spela in live-TV. Passkeys kräver nu Face ID/fingeravtryck/PIN på enheten.

> **Uppgradering till 0.4:** Inga åtgärder krävs. Databasen uppgraderas automatiskt. Uppdatera apparna för musik, offline och "tidigare i serien".

> **Uppgradering till 0.3:** Alla loggas ut en gång eftersom token nu lagras hashade. Apparna måste också uppdateras till den nya versionen. Logga in igen i webben och i apparna. Befintliga lösenord fungerar, men svaga lösenord ger en uppmaning att byta.

## Verifiera imagen

```
cosign verify ghcr.io/braxhn/braxhn-tv:latest \
  --certificate-identity-regexp 'https://github.com/BraXhn/braxhn-tv/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Live-TV och inspelning

1. **HDHomeRun:** Administration → *Live-TV och inspelning* → ange enhetens IP-adress (eller *Sök efter HDHomeRun*, vilket kräver att containern kör med host-nätverk). Guiden hämtas automatiskt från HDHomeRun.
2. **IPTV:** ange adressen till M3U-listan och gärna en XMLTV-guide (från leverantören). Kanaler kopplas till guiden via `tvg-id` eller kanalnamn – justera med *Guide-id* om något inte matchar.
3. Lägg till sökvägen **/recordings** i Unraid-mallen (t.ex. `/mnt/user/media/Inspelningar`). Inspelningar sparas som MP4, och mappen kan även läggas till som ett vanligt bibliotek.

Antenn-TV (MPEG-2, flätad bild) kodas om till H.264 när du tittar live; IPTV i H.264 kopieras utan omkodning. Antalet samtidiga kanaler begränsas av antalet tuners.

## Sonarr, Radarr och önskningar

- **Direkt skanning:** kopiera webhook-adressen under Administration → *Sonarr, Radarr och Trakt* och lägg in den i Sonarr/Radarr under *Settings → Connect → Webhook*. Ser Sonarr filerna under en annan sökväg (t.ex. `/tv`) anger du `/tv=/media/Serier`.
- **Önskningar:** fyll i adress och API-nyckel till Radarr/Sonarr och välj kvalitetsprofil och rotmapp. Önskningar från andra än administratörer godkänns först (eller automatiskt om du slår på det).

## Säkerhetskopior och återställning

- Lokala kopior görs varje natt i `/config/backups`. Extern, krypterad kopia ställs in under *Statistik → Extern säkerhetskopia*. **Spara lösenfrasen på ett säkert ställe** – utan den går kopian inte att läsa.
- Återställ från webben (*Återställ* vid en kopia, starta sedan om containern) eller från terminalen: `docker exec -it braxhn-tv node server/restore.js /backup/braxhn-tv-….bxtv` och starta om.

## Casting

- **Chromecast:** knappen *📺 Casta* visas i spelaren i Chrome. Googles regler kräver att sidan öppnas via **HTTPS**, alltså alternativ 2 eller 3 ovan. Chromecasten hämtar strömmen själv med en tidsbegränsad länk som gäller 12 timmar och bara för mediafiler.
- **AirPlay:** finns i Safari på Mac/iPhone och i iPhone/iPad-appen. Det fungerar hemma utan HTTPS.

## Namnge filer

```
/media/Filmer/Inception (2010)/Inception (2010).mkv
/media/Filmer/Arrival.2016.1080p.BluRay.x264.mkv
/media/Filmer/Arrival.2016.1080p.BluRay.x264.sv.srt     ← extern undertext
/media/Serier/Bron (2011)/Season 1/Bron - S01E01.mkv
```

## Hårdvaruomkodning

| GPU | Inställning |
|---|---|
| Intel iGPU | `HWACCEL=vaapi` eller `qsv`, plus enheten `/dev/dri`. Tonmappning görs då på GPU:n med VAAPI. |
| AMD | `HWACCEL=vaapi` och `/dev/dri`. |
| NVIDIA | Pluginen *Nvidia-Driver*, `HWACCEL=nvenc`, `--runtime=nvidia` och `NVIDIA_VISIBLE_DEVICES=all`. Tonmappningen görs med processor. |

Utan GPU klarar en modern processor omkodning av 1080p i realtid. Tonmappning av 4K HDR med processor är tungt, så använd en GPU om du har mycket HDR-material.

## Miljövariabler

| Variabel | Standard | Beskrivning |
|---|---|---|
| `PORT` / `HTTPS_PORT` | 8420 / 8443 | Webbportar |
| `MEDIA_ROOT` | /media | Bibliotek måste ligga här |
| `HWACCEL` | none | none, vaapi, qsv eller nvenc |
| `TONEMAP` | hable | hable, mobius eller reinhard |
| `PUBLIC_URL` | – | Publik adress, t.ex. https://tv.dindomän.se |
| `REMOTE_QUALITY` | 1080 | Maxkvalitet utanför hemmet |
| `TRUST_PROXY` | auto | 1 = lita alltid på X-Forwarded-For, 0 = aldrig |
| `HSTS` | 1 | 0 = skicka inte HSTS-header via HTTPS |
| `TMDB_API_KEY` / `OPENSUBTITLES_API_KEY` | – | Valfria nycklar (kan även sättas i webbgränssnittet) |
| `SCAN_INTERVAL` | 60 | Minuter mellan skanningar |
| `TRUSTED_NETWORKS` | – | Extra betrodda nät (CIDR, minst /16) utöver hemnätet |
| `TRUSTED_PROXIES` | privata adresser | Vilka proxyadresser som får ange klientens IP via X-Forwarded-For |
| `TRUST_VPN_RANGE` | 0 | 1 = räkna 100.64.0.0/10 (NetBird/Tailscale/CGNAT) som hemma |
| `ADMIN_ANYWHERE` | 0 | 1 = tillåt administration från internet (avråds) |
| `MAX_TRANSCODES` / `MAX_TRANSCODES_USER` | 4 / 2 | Tak för samtidiga omkodningar |
| `ACME_DOMAIN` / `ACME_EMAIL` | – | Domän och e-post för Let's Encrypt (kan även sättas i webbgränssnittet) |
| `WATCH_FILES` | 1 | 0 = stäng av filbevakning |
| `TRICKPLAY` | 1 | 0 = skapa inga förhandsbilder för spolning |
| `DVR_DIR` | /recordings | Var inspelningar sparas |
| `PODCAST_DIR` | /config/podcasts | Var nedladdade poddavsnitt sparas |
| `NOTIFY_KIND` / `NOTIFY_URL` / `NOTIFY_TOKEN` / `NOTIFY_USER` | – | Notiser (kan även sättas i webbgränssnittet) |
| `UPDATE_CHECK` | 1 | 0 = leta inte efter nya versioner |
| `RADARR_URL` / `RADARR_API_KEY` / `SONARR_URL` / `SONARR_API_KEY` | – | Sonarr/Radarr (kan även sättas i webbgränssnittet) |
| `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` | – | Din Trakt-app |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `BACKUP_PASSPHRASE` | – | Extern säkerhetskopia |
| `WATCH_REGION` | SE | Land för *var kan jag se den?* |
| `PUID` / `PGID` | 99 / 100 | Ägare till filerna i /config |

## Testat och otestat

Allt i tabellen nedan kördes mot riktiga testfiler, och uppspelning och introknappar testades i en webbläsare:

| Funktion | Resultat i testet |
|---|---|
| Remux | Segmentgränserna stämde med filens nyckelbilder, även efter spolning, och inga bildrutor dubblades eller tappades. |
| HDR10 → SDR | Utdata blev BT.709. |
| Introdetektering | Träffade inom 0,5 s på syntetiska avsnitt. |
| Eftertexter | Hittades. |
| Undertexter | Fungerade, liksom token-inloggning för appar, cast-token, CORS, HTTPS och kvalitetsgränsen utanför hemmet. |
| HEVC-remux (fMP4) | Tidsstämplar och init-segment stämde, även efter spolning. |
| Musik | Skanning av taggar och omslag, strömning direkt och omkodad. |
| Profiler och åldersgränser | Barnprofiler såg bara tillåtna titlar. |
| Titta tillsammans | Två webbläsare höll synk vid play, paus och spolning. |
| Offline, förhandsbilder, säkerhetskopior, filbevakning | Fungerade. |
| Passkeys | Registrering och inloggning med en mjukvaru-autentiserare, inklusive avvisning av fel domän, fel nyckel och kopierad nyckel. |
| Let's Encrypt | CSR och nyckeltumavtryck verifierade (openssl, RFC 7638). |
| Live-TV | Simulerad IPTV-källa: M3U + XMLTV kopplades, MPEG-2 flätad bild kodades om till H.264 som HLS, tunergränsen fungerade, serieinspelning hoppade över repriser, inspelning blev MP4. |
| Ljudböcker och poddar | Kapitel från m4b och flera mp3-filer, position över filgränser i webben, RSS-tolkning, nedladdning och spärr mot lokala adresser. |
| Sonarr/Radarr, Trakt, notiser | Mot simulerade tjänster: webhook och sökvägsmappning, önskan till Radarr, tvåvägssynk med Trakt, ntfy. |
| Säkerhetskopior | Kryptering fram och tillbaka, fel lösenfras nekas, S3-signering mot AWS testvektor, återställning via omstart. |

**Inte testat här:**
- inbränning av bildundertexter (ingen testfil fanns)
- GPU-omkodning och VAAPI-tonmappning
- OpenSubtitles (API:t var inte nåbart härifrån)
- Chromecast och AirPlay
- certifikat från Let's Encrypt på riktigt (kräver en publik domän)
- en riktig HDHomeRun, riktig IPTV, riktiga Sonarr/Radarr, Trakt och S3-lagring (simulerade här)
- Google TV-appen på en riktig TV och ljudböcker i bilen
- passkeys i en riktig webbläsare/telefon
- offline-nedladdning och musik i en riktig bil
- CarPlay (kräver ett särskilt tillstånd från Apple och är därför inte byggt)
- Docker-bygget
- apparna, som byggs via GitHub Actions (se respektive README)

Licens: MIT.
