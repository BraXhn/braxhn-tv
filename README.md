# BraXhn TV – egen mediaserver för Unraid

BraXhn TV är en självhostad mediaserver för **filmer och serier**, skriven från grunden. Den kräver inga konton, ingen molntjänst och ingen prenumeration. Allt körs på din egen server.

## Innehåll

```
server/   Node.js-server (inga npm-beroenden): API, skanner, strömning, intro-detektering
web/      Webbgränssnitt (fungerar i alla webbläsare, installerbart som webbapp)
apps/apple/       App för iPhone, iPad och Apple TV (SwiftUI)  → se apps/apple/README.md
apps/automotive/  App för Android Automotive, t.ex. Polestar 4 (Kotlin) → se apps/automotive/README.md
braxhn-tv.xml     Unraid-mall          Dockerfile / docker-compose.yml / install.sh
```

## Funktioner

| Område | Vad som ingår |
|---|---|
| Bibliotek | Filmer och serier, mappväljare, automatisk skanning. Igenkänning via filnamn (`S01E02`, `Film (2020)`). |
| Metadata | Affischer, beskrivningar, betyg och avsnittsnamn via TMDB (gratis nyckel, valfritt). Utan nyckel skapas miniatyrbilder ur videon. |
| Användare | Flera konton med egen tittarhistorik, *Fortsätt titta*, *Nästa avsnitt* och sedd/osedd. |
| **Direktuppspelning** | Filer som enheten klarar skickas orörda (med spolning). |
| **Remux** | H.264-filer i MKV eller med fel ljudformat strömmas med **originalbilden kopierad**. Bara ljudet konverteras vid behov, så processorbelastningen blir nästan noll. Segmenten delas exakt på filens nyckelbilder, som indexeras vid skanningen. |
| Omkodning | Behövs bara för t.ex. HEVC till enheter utan HEVC-stöd, lägre kvalitet eller inbränning. Kan köras med processor eller GPU (Intel/AMD VAAPI, Quick Sync, NVIDIA NVENC). |
| **HDR → SDR** | HDR10, HLG och Dolby Vision (bas-lagret) tonmappas automatiskt när skärmen saknar HDR. Det görs med processor (zscale/tonemap) eller Intel/AMD-GPU (tonemap_vaapi). |
| **Undertexter** | Inbäddade och externa `.srt/.vtt/.ass`. Teckenkodningen för gamla svenska srt-filer identifieras automatiskt. Bildundertexter (Blu-ray PGS och DVD) **bränns in**. Undertexter kan sökas och laddas ner från **OpenSubtitles**, med exakt matchning via filhash. Tidsjustering ±. |
| **Hoppa över intro** | Introt hittas automatiskt genom ljudfingeravtryck: avsnitten i en säsong jämförs och den gemensamma ljudsekvensen blir introt. Även **eftertexter** hittas och ger knappen *Nästa avsnitt*. Tiderna kan justeras manuellt. |
| **Casting** | Chromecast från Chrome, och AirPlay till Apple TV från Safari och iPhone/iPad-appen. |
| **Utanför hemmet** | Kvaliteten begränsas automatiskt för tittare utanför hemnätet. Inbyggd HTTPS eller omvänd proxy, och appar med token-inloggning. Se nedan. |
| Appar | iPhone, iPad, Apple TV och Android Automotive (Polestar 4). |

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

### 3. Inbyggd HTTPS (utan proxy)

Lägg ett certifikat som `cert.pem` och `key.pem` i `/mnt/user/appdata/braxhn-tv/tls/`. BraXhn TV startar då HTTPS på port **8443**, och förnyade certifikat läses in automatiskt var sjätte timme.

Certifikatet kan t.ex. utfärdas med OPNsense-pluginen **os-acme-client** (Let's Encrypt) och exporteras automatiskt till Unraid-delningen. Vidarebefordra sedan WAN 443 → Unraid-IP:8443 i OPNsense.

> **Undvik Cloudflare Tunnel för video.** Cloudflares villkor begränsar videoströmning genom deras nät.

## Säkerhet

BraXhn TV är byggt för att kunna nås från internet. Detta finns inbyggt:

| Skydd | Hur det fungerar |
|---|---|
| **Tvåstegsverifiering (TOTP)** | Fungerar med Google/Microsoft Authenticator, 1Password, Bitwarden m.fl. Du får 10 engångs-reservkoder, och en kod kan inte användas två gånger. Aktiveras under **Mitt konto**. |
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
| **Säkerhetslogg och säkerhetskontroll** | Inloggningar, misslyckade försök och adminändringar loggas med IP-adress. **Administration** visar en checklista över vad som bör åtgärdas. |

**Viktigt om omvänd proxy och klientens IP-adress**
- BraXhn TV avgör "hemma eller utifrån" från klientens IP. Bakom Nginx Proxy Manager läses `X-Forwarded-For` **från höger**, så en angripare kan inte förfalska en lokal adress genom att skicka headern själv.
- Proxyn **måste** skicka `X-Forwarded-For`. NPM gör det som standard.
- Annars ser alla anslutningar ut att komma från proxyns lokala adress och räknas som hemma. Det gäller också NAT-lösningar som maskerar källadressen, t.ex. en VPS-tunnel med MASQUERADE eller Cloudflare Tunnel.
- **Kontrollera** under *Administration → Säkerhetskontroll*: raden *Din adress enligt servern* ska visa din riktiga publika adress när du ansluter utifrån, t.ex. via mobilnätet.
- Om du vet proxyns adress, sätt `TRUSTED_PROXIES` (t.ex. `172.17.0.5/32`) så att bara den får ange klientadress.

**Rekommenderad konfiguration när servern nås från internet:**
1. Använd HTTPS, via Nginx Proxy Manager eller inbyggt (se ovan). Kör aldrig okrypterat över internet.
2. Aktivera 2FA på alla administratörskonton, och slå på *Kräv tvåstegsverifiering utanför hemmet*.
3. Låt *Administration från internet* vara avstängd. Administrera hemifrån eller via NetBird.
4. Geoblockera i OPNsense (GeoIP-alias på WAN-regeln) så att t.ex. bara Sverige och EU släpps in.
5. Valfritt: CrowdSec eller fail2ban kan läsa containerloggen. Misslyckade inloggningar loggas som `[auth] login_fail ip=… user=…`.
6. Håll containern uppdaterad, och säkerhetskopiera `/mnt/user/appdata/braxhn-tv`.

> **Uppgradering till 0.3:** Alla loggas ut en gång eftersom token nu lagras hashade. Apparna måste också uppdateras till den nya versionen. Logga in igen i webben och i apparna. Befintliga lösenord fungerar, men svaga lösenord ger en uppmaning att byta.

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

**Inte testat här:**
- inbränning av bildundertexter (ingen testfil fanns)
- GPU-omkodning och VAAPI-tonmappning
- OpenSubtitles (API:t var inte nåbart härifrån)
- Chromecast och AirPlay
- Docker-bygget
- apparna, som byggs via GitHub Actions (se respektive README)

Licens: MIT.
