# BraXhn TV för Android: bilen (Polestar 4) och Google TV

En Kotlin-app (Jetpack Compose och Media3/ExoPlayer) för bilar med **Android Automotive OS med Google inbyggt**, som Polestar 2/3/4 och Volvo. Samma app fungerar på **Google TV / Android TV** (Chromecast med Google TV, Nvidia Shield, TV-apparater från Sony/Philips/TCL m.fl.) och på vanliga Android-telefoner och surfplattor.

**På Google TV:** installera APK:n (t.ex. med *Downloader*-appen eller `adb install`). Appen syns med en banner på startsidan och styrs med fjärrkontrollen – det som har fokus får en vit ram.

> **Android Auto ≠ Android Automotive.** Android Auto (telefonen speglad till bilskärmen) tillåter inte video alls. Polestar 4 kör Android Automotive OS, där parkerade videoappar är tillåtna.

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
- byte av ljudspår och undertexter under uppspelning, kapitel
- musik, **ljudböcker och poddar i bilens mediaspelare** (får användas under körning)
- offline-nedladdning

Appen frågar enheten vilka format den avkodar själv, och servern väljer sedan direkt, remux eller omkodning.

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

Koden är skriven och granskad men har **inte kompilerats** där den skapades, eftersom miljön saknade Android SDK. Kör GitHub-workflowet eller bygg i Android Studio för att verifiera.
