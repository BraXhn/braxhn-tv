# BraXhn TV för Android: bilen (Polestar 4) och Google TV

En Kotlin-app (Jetpack Compose och Media3/ExoPlayer) för bilar med **Android Automotive OS med Google inbyggt**, som Polestar 2/3/4 och Volvo. Samma app fungerar på **Google TV / Android TV** (Chromecast med Google TV, Nvidia Shield, TV-apparater från Sony/Philips/TCL m.fl.) och på vanliga Android-telefoner och surfplattor.

**På Google TV:** installera APK:n (t.ex. med *Downloader*-appen eller `adb install`). Appen syns med en banner på startsidan och styrs med fjärrkontrollen – det som har fokus får en vit ram.

> **Android Auto ≠ Android Automotive.** Android Auto (telefonen speglad till bilskärmen) tillåter inte video alls. Polestar 4 kör Android Automotive OS, där parkerade videoappar är tillåtna.

**Android Auto (telefonen i bilen):** med appen installerad på telefonen syns BraXhn TV bland mediaapparna i Android Auto, med flikarna *Musik*, *Ljudböcker* och *Poddar* (bara ljud – video är inte tillåtet i Android Auto). En app som inte kommer från Google Play visas bara om du slår på *Okända källor*: öppna Android Auto-inställningarna på telefonen, tryck tio gånger på *Version* för att låsa upp utvecklarinställningarna och välj ⋮ → *Utvecklarinställningar* → *Okända källor*. Logga in i appen på telefonen först.

**Google TV – Fortsätt titta:** appen lägger det du håller på med i systemets rad *Fortsätt titta* (Watch Next) när startsidan öppnas. Google TV visar raden bara för appar som Google har godkänt, så för en sideloadad app syns den troligen inte (äldre Android TV-startsidor brukar visa den). Inget annat påverkas om den inte syns.

**Funktioner**
- stor sidomeny anpassad för bilskärmar
- hem med *Fortsätt titta*
- bibliotek och sök
- serier med säsonger
- val av ljud och undertext
- *Hoppa över intro* och *Nästa avsnitt*
- automatiskt nästa avsnitt
- tittarstatus
- **live-TV och inspelningar** (HDHomeRun/IPTV)
- **TV-guide i rutnät** (D-pad: upp/ned mellan kanaler, vänster/höger mellan program – vid kanten bläddrar guiden en timme), filter för favoriter och kanalgrupper, programrutan med *Titta live*, *Från början*, *Spela (catch-up)*, *Spela in* och *Lägg till i favoriter* (per profil)
- **kanalbyte** i live-spelaren med upp/ned (när spelarens knappar är dolda), CH+/CH− och **sifferknapparna** (kanalnumret väljs 1,5 s efter sista siffran)
- **IPTV-filmer och serier** (Xtream) som hyllor under Live-TV, med Fortsätt titta
- **inspelningar** i flikarna *Kommande*, *Pågår* (titta medan den spelas in) och *Inspelat* med **Hoppa över reklam**
- **egna betyg** (tryck på en stjärna, igen för en halv, en gång till för att ta bort), **extramaterial** och **temamusik** (enligt *Mitt konto* i webben, låg volym, tonas ut) på titelsidan
- **repliksökning**: fliken *Repliker* i sökningen spelar från strax före repliken
- **familjefiltret** och **syntolkning** visas i spelaren; markerade scener hoppas över. *Synka automatiskt* i undertextmenyn för undertextfiler
- byte av ljudspår och undertexter under uppspelning, kapitel
- musik, **ljudböcker och poddar i bilens mediaspelare** (får användas under körning)
- offline-nedladdning
- **byt profil** i hushållet (PIN eller huvudkontots lösenord när servern kräver det)
- **Min lista** på titelsidan och som hylla på startsidan
- startsidans hyllor i den ordning du valt i webben (*Anpassa startsidan*), även *Fortsätt lyssna* (spelas i ljudspelaren), *Kommer snart*, *Eftersom du såg …*, egna samlingar m.fl.
- **bild-i-bild** på telefon och surfplatta (knappen i spelaren eller hemknappen) och **uppspelningshastighet** 0,75–2×
- **bio-läge**: trailers och förfilm före filmen med *Hoppa över* när det är påslaget under *Mitt konto → Bio-läge* i webben
- **nattläge och tydligare dialog** (Inställningar eller ljudmenyn i spelaren; servern filtrerar ljudet)
- Android Auto (ljud) och Google TV:s *Fortsätt titta*, se ovan
- **på Google TV: bitström till förstärkaren** (Dolby Digital, Dolby Digital Plus/Atmos, DTS/DTS-HD, Dolby TrueHD spelas orört när förstärkaren tar emot formatet), **HDR10/HDR10+/HLG/Dolby Vision** direkt när TV:n klarar det och **automatisk bildfrekvensväxling** (*Inställningar → Bild och ljud på TV:n*: Av / Bara bildfrekvens / Bildfrekvens och upplösning)
- i bilens mediaspelare och Android Auto: flikarna Musik, Ljudböcker och Poddar, **Stationer** (låtradio och stationer från serverns ljudanalys), *Radio: artist* överst på varje artistsida, sökning i musik, ljudböcker och poddar och **röststyrning** ("Hey Google, spela … på BraXhn TV" spelar bästa träffen: låten med sitt album, ett album, en ljudbok eller poddens senaste avsnitt)

Appen frågar enheten vilka format den avkodar själv, och servern väljer sedan direkt, remux eller omkodning. Spelaren väntar upp till 60 s på servern, så en omkodning med grafikkort som tar några sekunder att komma igång startas inte om.

**Barnprofiler:** poddar visas inte (servern stänger dem för barn), och när en vuxen trycker *Stoppa* i Föräldraöversikten stannar filmen inom ungefär tio sekunder med beskedet *En vuxen stoppade uppspelningen*. Samma sak när skärmtiden tar slut, med serverns förklaring.

## Serveradress, https och BraXhn Relay

- **Hemma:** IP-adressen eller datornamnet, t.ex. `192.168.1.10` – appen lägger till `http://` och port 8420.
- **Utanför hemmet (bilen, mobilnätet):** en https-adress – från BraXhn Relay, Let's Encrypt eller din egen omvända proxy. Skriver du bara ett domännamn, t.ex. `tv.example.com`, använder appen `https://`. Inloggning, strömning, bilder och nedladdning går genom samma adress.
- **Eget (självsignerat) certifikat:** appen godkänner bara certifikat som enheten litar på. Installera ditt certifikat (eller din egen CA) under *Inställningar → Säkerhet → Kryptering och användaruppgifter* på telefonen, så fungerar det. Certifikatkontrollen går inte att stänga av. Nedladdning för offline går via Androids nedladdningshanterare, som kanske inte litar på ett eget certifikat – använd då http hemma.
- **Hemma men sparad med den publika adressen** (reläet eller en domän): appen frågar servern efter dess adress på hemnätet och provar den i bakgrunden (högst 0,8 s) när servern öppnas, när appen kommer tillbaka till förgrunden och när nätet byts. Svarar den rätt går anrop, strömmar och bilder direkt dit – hemmets kvalitet och ingen omväg via reläet – och *Inställningar* visar *Hemma: direkt via 192.168.1.10:8420*. Utanför hemmet, eller när hemadressen slutar svara, används den sparade adressen igen. Den sparade adressen ändras aldrig. Nedladdningar, Google TV:s *Fortsätt titta* och bilens mediaspelare får alltid den sparade adressen, eftersom systemet hämtar dem även när appen inte kör. Servern måste känna sin hemadress (se *Hemma men via den publika adressen* i huvud-README).
- **Säkerhet:** inloggningen skickas bara till den sparade adressen eller till en hemadress som bevisat att den är just den här servern (provet besvaras bara på hemnätet). http provas bara mot adresser i hemnätet, provet skickas utan inloggning, och byts nätet slutar appen använda hemadressen innan nästa förfrågan. Klartext är tillåten i `network_security_config.xml` för alla adresser, eftersom Android inte kan begränsa det till IP-intervall – se kommentaren där.
- Felmeddelanden säger vad som är fel: servern hittades inte, kunde inte ansluta, certifikatet godkänns inte eller att reläet inte når hemservern.

**Stöd projektet:** längst ner i Inställningar finns raden *Stöd projektet* när servern anger en donationslänk (PayPal). Den öppnar länken i webbläsaren – inget annat, inga påminnelser, och den visas aldrig för barnprofiler. Saknar enheten webbläsare (bilen, vissa TV-apparater) visas adressen.

**Språk:** appen följer enhetens språk – svenska på en svensk telefon, TV eller bil, annars engelska. Texterna ligger i `app/src/main/res/values/strings.xml` (engelska, standard) och `app/src/main/res/values-sv/strings.xml` (svenska), med samma ordval som webben (`web/i18n/en.js`). Ny text läggs i båda filerna och hämtas med `tr(R.string.…)` i Compose eller `str(R.string.…)` utanför (se `Strings.kt`); `test/android-i18n.test.js` stoppar svensk text i Kotlin-koden och kontrollerar att filerna stämmer överens. Texter från servern (felmeddelanden, namn på egna samlingar, inspelningarnas krockbesked) visas som servern skickar dem, alltså på svenska än så länge. Appen skickar enhetens språk i `Accept-Language`.

**Körning:** appen saknar avsiktligt markeringen *distraction optimized*. Bilen lägger därför en spärr över appen när den börjar rulla, och appen pausar uppspelningen direkt (krav från Google).

## Bygga

Utan dator: lägg projektet på GitHub, så bygger `.github/workflows/android-automotive.yml` både APK och AAB. Ladda ner dem under *Actions → senaste körningen → Artifacts*.

Lokalt med Android Studio: öppna mappen `apps/automotive` och kör *Build → Build APK*.

Om du vill ha en egen signeringsnyckel, vilket behövs för Google Play:
1. Skapa en nyckel:
   ```bash
   keytool -genkey -v -keystore release.jks -alias braxhn -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Base64-koda filen och lägg den som repo-hemligheten `BRAXHN_KEYSTORE_B64`.
3. Lägg också till hemligheterna `BRAXHN_KEYSTORE_PASSWORD`, `BRAXHN_KEY_ALIAS` och `BRAXHN_KEY_PASSWORD`.

## Installera i bilen

**A. Utvecklarläge och adb (gratis, om bilen tillåter det)**
1. Öppna *Inställningar → System → Om* i bilen och tryck sju gånger på versionsnumret för att låsa upp utvecklaralternativ.
2. Slå på *USB-felsökning*, eller *trådlös felsökning* om det finns.
3. Anslut från en dator: `adb install braxhn-tv.apk`.

Tillverkare kan stänga av utvecklarläget, och stora uppdateringar (OTA) kan återställa det. Det här är inte verifierat på just din Polestar 4.

**B. Google Play intern testning (pålitligast, 25 USD en gång)**
1. Skapa ett utvecklarkonto i Google Play Console.
2. Skapa appen och lägg till formfaktorn **Android Automotive OS** under *Advanced settings → Form factors*.
3. Ladda upp AAB-filen till spåret **Internal testing** och lägg till ditt Google-konto som testare.
4. Öppna testlänken och installera appen från Play Butik i bilen, med samma Google-konto som är inloggat i bilen.

Intern testning kräver ingen granskning av bilanpassningen. Läs Googles regler för bilappar innan du publicerar till fler.

**Tips:** bilen når servern via mobilnätet, så den behöver en **publik HTTPS-adress**. Se *Titta utanför hemmet* i huvud-README. Kvaliteten begränsas automatiskt när bilen inte är på hemnätet.

## Status

Koden är skriven och granskad men har **inte kompilerats** där den skapades, eftersom miljön saknade Android SDK. Kör GitHub-workflowet eller bygg i Android Studio för att verifiera. Enhetstester på JVM (`app/src/test`, valet av hemadress): `gradle testReleaseUnitTest` – körs inte av workflowet än. Serverns svar på appens anrop kontrolleras av kontraktstestet (`test/api-contract.test.js`).

**Inte provat på riktig enhet (appversion 0.7.0):** att 60 s räcker mot NVENC på en riktig server, Stoppa från Föräldraöversikten och skärmtidens stopp, fokus och Bakåt med en riktig Google TV-fjärrkontroll, https via BraXhn Relay från bilen och ett självsignerat certifikat som installerats på telefonen.
