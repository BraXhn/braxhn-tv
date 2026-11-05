# BraXhn Relay

Reläet för fjärråtkomst utan portöppning. Bygg imagen på reläservern: kopiera mappen `relay/` dit och kör `docker compose build && docker compose up -d` (docker-compose.yml bygger från Dockerfile i den här mappen).

**Som Plex fjärråtkomst, men med ditt eget relä:** BraXhn TV nås utanför hemmet utan portöppning i routern, utan VPN och utan omvänd proxy hemma. Hemservern ansluter själv **ut** till reläet och håller en krypterad tunnel öppen; appar, webbläsare, Chromecast och musik- och läsappar ansluter till reläets adress (t.ex. `https://tv.example.com`) och trafiken går genom tunneln hem.

```
telefon / bil / Chromecast ──https──▶  BraXhn Relay (VPS)  ◀──utgående tunnel──  BraXhn TV hemma (Unraid)
```

**Reläet måste köras på en plats som nås från internet** – en liten VPS (1 kärna och 512 MB räcker), en server hos en vän eller en dator med publik IP. Det kan inte köras på samma Unraid som BraXhn TV om du inte ändå öppnar portar dit (då behövs inget relä). Reläet är en egen Docker-image som du bygger själv från den här mappen (`docker compose build`), utan ffmpeg och utan npm-beroenden. Ingen färdig image publiceras – den byggs på reläservern.

### Uppsättning med Caddy (rekommenderas)

Caddy hämtar och förnyar certifikatet från Let's Encrypt automatiskt. På servern som nås från internet:

1. **Domän:** peka ett namn, t.ex. `tv.example.com`, på serverns publika IP (A-post, eller AAAA för IPv6). En gratis DuckDNS-adress fungerar också. Öppna port **80** och **443** i serverns brandvägg.
2. **Filer:** kopiera mappen `relay/` till reläservern och skapa en fil `.env` bredvid dem:
   ```
   RELAY_DOMAIN=tv.example.com
   RELAY_ADMIN_TOKEN=<lång slumpad text, t.ex. från: openssl rand -hex 24>
   ```
   (`RELAY_ADMIN_TOKEN` är valfri – utan den finns ingen adminsida, och parningskoden visas bara i loggen.)
3. **Bygg och starta:** `docker compose build` och `docker compose up -d`, och sedan `docker compose logs relay`. Där står en rad som
   `Start: parningskod ABCD-EFGH-JKLM-NPQR (gäller 15 minuter, en gång)`.
4. **Para hemma:** i BraXhn TV, **Administration → Fjärråtkomst via relä** (från hemnätet): ange reläets adress `https://tv.example.com` och koden, och klicka *Para*. Status visar *Ansluten* inom några sekunder.
5. **Använd adressen:** logga in på `https://tv.example.com` i webbläsaren, eller ange den som serveradress i apparna. Sätt gärna samma adress som *Publik adress* under *Administration → Inställningar → Utanför hemmet* (inbjudningar, Chromecast och länkar använder den).

Ny kod: `docker restart braxhn-relay` eller `docker kill -s HUP braxhn-relay` (koden loggas), eller **Skapa parningskod** på reläets adminsida `https://tv.example.com/_relay/admin` (med `RELAY_ADMIN_TOKEN`). Där syns också vilka servrar som är parade, om de är anslutna, varifrån och hur mycket trafik som gått, och där tar du bort en server. **Koppla bort** i BraXhn TV stänger tunneln och ber reläet glömma servern.

### Utan Caddy (egen omvänd proxy eller egna certifikat)

- **Egen omvänd proxy** (Nginx, Nginx Proxy Manager, Traefik, HAProxy) på reläservern: skicka allt för domänen till reläets port 8080 med **HTTP/1.1 och uppgradering påslagen** (tunneln är en HTTP-uppgradering, `Upgrade: braxhn-relay/1`, som WebSocket), `Host` oförändrad och `X-Forwarded-For`/`X-Forwarded-Proto`, och **utan buffring och tidsgräns** (video, SSE och tunneln är långlivade). Nginx:
  ```nginx
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_max_body_size 0;
  }
  ```
  I Nginx Proxy Manager: *Websockets Support* på och raderna utom `location` under *Advanced*. HTTP/2 mot klienterna är bra, men proxyn måste prata HTTP/1.1 med reläet. Reläet litar på `X-Forwarded-*` bara från privata adresser (proxy på samma maskin eller i samma Docker-nät) – ange annars proxyns adress i `RELAY_TRUSTED_PROXIES`.
- **Egna certifikat utan proxy:** sätt `RELAY_TLS_CERT` och `RELAY_TLS_KEY` (sökvägar i containern, t.ex. från certbot), `RELAY_PORT=443` och publicera porten (`-p 443:443`); filerna läses in igen var sjätte timme och vid `SIGHUP`. Reläet har ingen egen Let's Encrypt-klient – använd Caddy om du vill att det sköts automatiskt.
- **Bara för test** fungerar `http://` (t.ex. reläet på en annan dator i hemmet). Administrationen varnar då: utan HTTPS kan inloggningar och video avlyssnas.

### Säkerhet

- **Allt som kommer via reläet räknas som utanför hemmet**, även om tunneln kommer från samma dator och vad klienten än skickar för `X-Forwarded-For`: administration nekas (*Administration är bara tillåten från hemnätverket*), rättning av metadata kräver tvåstegsverifiering, konton utan *fjärråtkomst* nekas, kravet på tvåstegsverifiering utanför hemmet gäller, kvalitetsgränsen utanför hemmet gäller och DLNA och installationen av första kontot nås inte. Parning och bortkoppling görs bara från hemnätet.
- **Inloggningsspärren** gäller per klient: reläet skickar klientens IP i tunnelns egna rubriker (som klienten aldrig når), och hemservern använder den för spärrar och säkerhetsloggen – aldrig för beslut om betrott nät. Klientens egna `X-Forwarded-*` tas bort.
- **Parningen:** koden är 16 tecken (80 bitar), gäller 15 minuter, en gång och högst tre felaktiga försök. Koden skickas aldrig: server och relä gör ett X25519-nyckelutbyte som bekräftas med HMAC nycklad med koden, och den gemensamma hemligheten (HKDF-SHA256) sparas i reläets datafil (läsbar bara för reläet) och i serverns inställningar. Hemligheten skickas aldrig heller.
- **Tunneln:** engångsutmaning från reläet och HMAC-SHA256-bevis åt båda hållen innan den öppnas – fel bevis, återanvänd utmaning eller okänd server nekas (och för många fel ger 429). Hemservern ansluter inte till ett relä som inte kan bevisa hemligheten. Hjärtslag var 15:e sekund; hemservern ansluter igen med växande paus (1 s … 60 s).
- **Ingen öppen proxy:** reläet skickar bara vidare till parade servrar som är anslutna just nu (per domännamn, eller till den enda parade servern), aldrig till en adress klienten anger; `CONNECT`, absoluta adresser och WebSocket-uppgraderingar går inte vidare. Gränser: rubriker 16 kB och 20 s, uppladdning `RELAY_MAX_BODY_MB`, `RELAY_RATE` förfrågningar per minut och `RELAY_MAX_PER_IP` samtidiga per klient-IP, och svar med rubriker inom `RELAY_RESPONSE_TIMEOUT` – men ingen gräns för hur länge en ström (film, SSE) pågår.
- Reläet loggar aldrig token, kakor eller lösenord – bara anslutningar, parningar och nekade försök (med IP).
- Reläet ser trafiken okrypterad innan den går in i tunneln (som varje omvänd proxy) – kör det på en server du litar på.

### Bandbredd

All video går **två gånger** genom reläservern (in från hemmet, ut till tittaren), så både din uppladdning hemma och VPS:ens trafikkvot räknas. En film i 1080p är 3–8 Mbit/s – två timmar ≈ 3–7 GB per tittare. Välj maxkvalitet utanför hemmet efter den långsammaste länken (*Administration → Inställningar → Utanför hemmet*), och kontrollera VPS:ens trafikgräns. Tunneln lägger till fördröjningen hem–relä, men flödeskontrollen är anpassad för långa avstånd (4 MB per ström).

### Reläets miljövariabler

| Variabel | Standard | Beskrivning |
|---|---|---|
| `RELAY_PORT` / `RELAY_BIND` | 8080 / alla | Port och adress reläet lyssnar på |
| `RELAY_PUBLIC_URL` | adressen parningen kom in på | Reläets publika adress, t.ex. `https://tv.example.com` (visas i BraXhn TV) |
| `RELAY_ADMIN_TOKEN` | – | Lösenord till adminsidan `/_relay/admin` (minst 16 tecken). Utan den: ingen adminsida, koden bara i loggen |
| `RELAY_DATA_DIR` | /data | Parade servrar och deras hemligheter (`relay.json`, 0600) |
| `RELAY_TLS_CERT` / `RELAY_TLS_KEY` | – | Egna certifikat (PEM) – då serverar reläet HTTPS själv |
| `RELAY_TRUSTED_PROXIES` | privata adresser | Proxyadresser (CIDR) som får ange klientens IP med `X-Forwarded-For`; `none` när reläet nås direkt |
| `RELAY_MAX_BODY_MB` | 512 | Största uppladdning genom reläet |
| `RELAY_RATE` / `RELAY_MAX_PER_IP` | 3000 / 64 | Förfrågningar per minut och samtidiga förfrågningar per klient-IP |
| `RELAY_RESPONSE_TIMEOUT` | 120 | Sekunder hemservern har på sig att börja svara |
| `RELAY_CODE_TTL_MIN` | 15 | Minuter en parningskod gäller |
| `RELAY_DEBUG` | – | 1 = logga fel mot hemservern per förfrågan (felsökning; adresser utan token) |


## Testerna

Testerna ligger i `test/relay.test.js` och körs med resten av sviten (`npm test`).
