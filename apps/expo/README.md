# BraXhn TV för Expo Go

En app för iPhone och Android som körs i [Expo Go](https://expo.dev/go), utan Mac, Xcode eller utvecklarkonto.
Den ser ut som webbappen på en telefon och använder samma server och API som de andra apparna.

Den här appen är till för att prova på en riktig telefon. iPhone-appen i `apps/apple` och Android-appen i
`apps/automotive` är de fullständiga apparna.

## Kör den på telefonen

Du behöver en dator med [Node.js](https://nodejs.org) 20 eller senare, och appen **Expo Go** på telefonen (App Store
eller Google Play).

```
cd apps/expo
npm install
npx expo start
```

Skanna QR-koden som visas: med kameran på iPhone, med Expo Go på Android. Telefonen och datorn ska vara på samma
nät. Går det inte (gästnät, brandvägg) kan du starta med `npx expo start --tunnel`.

I appen väljer du **Lägg till server** och anger serverns adress, till exempel `192.168.1.10` (blir
`http://192.168.1.10:8420`) eller `tv.example.com` (blir `https://`), och loggar in med ditt vanliga konto.

## Språk

Appen finns på svenska och engelska. Den följer telefonens språk: svenska om telefonen är på svenska, annars engelska
(samma regel som Android-appen). Under **Konto → Språk** kan du välja *Telefonens språk*, *Svenska* eller *English*;
valet sparas i telefonen och appen ritas om direkt (du hamnar på *Konto* igen).

- Appen skickar `Accept-Language` (`sv` eller `en`) med varje anrop, så serverns felmeddelanden och hyllnamn kommer på
  samma språk. Har profilen ett eget språk i webben (*Mitt konto → Språk*) gäller det för serverns texter.
- Datum och tal följer språket: på engelska telefonens egen engelska variant (`en-US` ger t.ex. 1,200), annars `en-GB`;
  på svenska `sv-SE` (1,2 GB).
- De fasta smarta listornas namn (*Mest spelat senaste 30 dagarna* …) skickar servern på svenska; appen översätter dem
  efter listans id, som webben.
- Kvar på svenska: sidans namn i den tekniska informationen i en felrapport (till utvecklarna), och text som sparats i
  Nedladdat innan språket byttes (serie/säsong under titeln och ett gammalt felmeddelande).
- Telefonens språk läses med `Intl` (inget extra paket). Det är **inte provat i Expo Go** på en telefon på engelska,
  bara i webbläget med webbläsaren på engelska.

## Servrar

- Har du **en** sparad server öppnas den direkt när appen startar.
- Har du **flera** frågar appen vilken du vill öppna. Samma server med två olika konton räknas som två.
- Under **Konto** finns *Lägg till server* och, när du har flera, *Byt server*. I listan tar du bort en server med
  papperskorgen.
- *Logga ut* tar bort inloggningen men behåller servern i listan. Nästa gång frågar appen bara efter lösenordet.
- **Hemma via den publika adressen:** har du sparat reläets eller domänens adress provar appen serverns adress på
  hemnätet (`/api/local`, högst 0,8 s) när servern öppnas och när appen kommer tillbaka till förgrunden. Svarar den rätt
  går allt direkt dit, med hemmets kvalitet – under **Konto** står då *Hemma: direkt via …*. Svarar den inte längre går
  appen tillbaka till den sparade adressen. Den sparade adressen ändras aldrig.

## Profiler

- Har kontot flera profiler visar appen **Vem tittar?** direkt efter inloggningen, med en ruta per profil (initial och
  profilens färg, som i webbappen). *Fortsätt som …* behåller den profil man loggade in med.
- En profil med PIN frågar efter den. Från en barnprofil till en profil med högre åldersgräns utan PIN frågar appen
  efter huvudkontots lösenord, som webben.
- Under **Konto** finns *Byt profil* när kontot har flera profiler. Rutan uppe till höger har profilens färg.
- Barnprofilens begränsningar (åldersgräns, bibliotek, skärmtid) sköter servern: appen använder bara profilens egen
  inloggning. Servern tar bort den gamla inloggningen vid profilbyte, så appen sparar en inloggning per server – den
  valda profilens – i den säkra lagringen. Nästa start öppnar samma profil.
- Profiler skapas och ändras i webbgränssnittet.

## Bilder

Bilder hämtas med en egen bildtoken som gäller en vecka. Appen sparar den i den säkra lagringen per server och profil
och tar en ny först när det är mindre än ett dygn kvar, eller när servern svarar att den inte gäller (till exempel om
den knuffats ut: servern sparar högst 50 per användare). Då ritas bilderna om med den nya.

Expo Go kör bara den senaste Expo-versionen. Säger Expo Go att projektet är för gammalt: `npx expo install expo@latest`
och sedan `npx expo install --fix`.

## Vad som finns

- Flera servrar och inloggning, även med tvåstegsverifiering. Inloggningarna sparas i telefonens säkra lagring.
- Profilbyte (*Vem tittar?*) med PIN, och barnprofiler som bara ser det de får se.
- Startsidan med *Fortsätt titta*, *Min lista* och nyligen tillagt per bibliotek.
- Bibliotek (filmer och serier) sorterade efter titel, senast tillagt eller år, och sökning.
- Titelsidan: Spela, Fortsätt, Börja om, Markera som sedd, Min lista, säsonger och avsnitt.
- Spelaren: telefonens egen spelare med helskärm och bild-i-bild. Den fortsätter där du slutade, skickar framsteg
  till servern och har knappar för att hoppa över sammanfattning och intro och för nästa avsnitt när eftertexterna
  börjar. Har kontot valt att hoppa över automatiskt (*Mitt konto → Uppspelning* i webben) visas först en nedräkning
  på tre sekunder med *Avbryt* (den väntar medan filmen är pausad). När avsnittet är slut visas *Nästa avsnitt om … s*
  med *Spela nu* och *Avbryt*, efter kontots val för nästa avsnitt (av: kortet utan nedräkning; 0 s: direkt). När
  eftertexterna börjar och under nedräkningen förbereder servern redan nästa avsnitt (`warm=1` med samma fråga som
  starten), så att det startar fortare. Samma regler som webbspelaren. Spolar du långt i en film som servern kodar om
  startar appen om strömmen där du spolade till, så att bilden kommer på ungefär en sekund (se *Spolning* nedan).
- Musik, ljudböcker och poddar med minispelare, helskärmsspelare, kö som delas med webben och låsskärmens reglage.
- Nedladdning av filmer, avsnitt och ljudböcker som spelas utan nät (se *Nedladdat* nedan).
- Feedback och felrapporter (se *Feedback* nedan).
- Svenska och engelska efter telefonens språk, eller valt under *Konto* (se *Språk* ovan).

## Spolning i en omkodad film

Spolar du utanför det som redan är laddat i en film som servern kodar om, ber appen servern starta om strömmen där du
spolade till (`/playback` med `start=` och `prev=<förra strömmens pid>`), som webbspelaren. Servern ger då korta stycken
just där (1 s med processorn) och stoppar den gamla omkodningen direkt, i stället för att först koda ett helt
sexsekundersstycke. Ljudspåret är detsamma, en pausad film förblir pausad, och spåren som valts i telefonens spelare
väljs igen. Ingen omstart när målet redan är laddat, när servern redan har kodat dit (gissat ur var omkodningen började
och hur långt spelaren laddat – appen ser inte serverns svar), nära slutet, när stycket redan är kort och innan första
bilden visats. Remux och direktuppspelning spolar som förut.

Telefonens spelare märker spolningen som ett hopp i positionen (mätt var 0,25 s, `src/seekcore.ts`). Appen skickar
`nhls=1` även på Android, så att spellistan säger var uppspelningen börjar (`EXT-X-START`) och spelaren inte först
hämtar början av filmen – det gör också att *Fortsätt titta* börjar direkt på rätt ställe. **I webbläget görs ingen
omstart:** Chromes egen HLS-spelare hämtar alltid de två första styckena i en ny ström innan den går till målet, och
då blev spolningen långsammare (uppmätt 2,4–2,8 s → 2,9–3,7 s till bild).

Uppmätt mot servern som telefonens spelare gör (börjar där spellistan säger, 1080p H.264 10 bitar, 4 kärnor):
segmentet med målet kom efter 2,1–2,4 s förut och 0,67–0,80 s med omstarten (12 spolningar var); avkodningen i
telefonen kommer till. **Inte provat på en riktig iPhone eller Android-telefon.**

## Feedback

Under *Konto* finns *Skicka feedback* och *Mina ärenden* – samma som knappen *Feedback* i webben och samma anrop
(`/api/support`). Formuläret har typen (*Förslag eller synpunkt* / *Något fungerar inte*), *Gäller* (förvalt efter
skärmen du var på innan du öppnade Konto: titelsidan → Film och serier, spelaren → Uppspelning, musik → Musik,
ljudböcker och poddar → Ljudböcker och poddar), meddelandet och krysset för teknisk information. *Visa vad som skickas
med* frågar servern (`POST /api/support/context`) och visar exakt det som sparas. Appen skickar sitt namn (`Expo`),
versionen ur `app.json`, plattformen (t.ex. `android 14`), sidan, skärmstorleken, språket, titeln som senast spelades och
det senaste uppspelningsfelet (en halvtimme) – inga token, adresser eller namn. Servern lägger till sin version och den
senaste uppspelningen ur tittarhistoriken.

En vanlig användares ärende får beskedet *Ärendet är mottaget och väntar på granskning.* – en administratör läser det
innan det går till utvecklarna. *Mina ärenden* visar status och svar, och när teamet ber om mer information finns en ruta
för svaret (som också granskas). Visar spelaren att en titel inte gick att spela finns *Rapportera felet*, som öppnar
formuläret med *Något fungerar inte* och *Uppspelning* förvalt (inte när skärmtiden tog slut eller en vuxen stoppade).
Servrar före 1.3.0 har inte feedback; appen säger det i stället för ett 404-fel.

## Musik, ljudböcker och poddar

Fliken **Musik** har en rad med bibliotek överst: varje musikbibliotek, varje ljudboksbibliotek och *Poddar* (bara om
profilen har poddar – barnprofiler får inga av servern). Tryck på ett musik- eller ljudboksbibliotek på startsidan så
hamnar du också här.

- **Musik:** *Översikt* (spelat nyligen, smarta listor, nytt i biblioteket, favoriter), *Album* (sortera efter artist,
  titel, senast tillagda eller år), *Artister* och *Spellistor* (egna och smarta). Sökrutan söker bland artister,
  album och låtar. Albumsidan och artistsidan har *Spela*, *Blanda* och *Låtradio*. Varje låt har en meny (⋮) med
  *Spela härnäst*, *Lägg sist i kön*, *Gå till albumet* och *Gå till artisten*.
- **Minispelaren** ligger ovanför flikraden och längst ner på album-, artist-, spellist-, bok- och poddsidorna. Tryck
  på den för **helskärmsspelaren**: stort omslag, tidslinje att dra i, föregående/nästa, blanda resten av kön,
  upprepa, och kön (tryck för att hoppa dit, ✕ för att ta bort). Pilen ner minimerar, ✕ stänger spelaren.
- **Kön delas med webben.** Den sparas på servern för profilen – vid låtbyte, paus, spolning, var 20:e sekund och när
  appen går i bakgrunden. När appen startar visas den pausad där du var, och samma kö syns i webbappen (och tvärtom).
  En kö som bara visas skrivs inte, så den enhet du senast spelade på vinner. Stänger du spelaren med ✕ tas kön bort.
  Byter du profil eller loggar ut sparas kön på den gamla profilen och spelaren stängs.
- **Nästa låt laddas i förväg** (en andra spelare, när under 30 sekunder återstår), så att bytet går fort. Det är inte
  helt glapplöst som i webben: det kan bli ett kort uppehåll mellan låtarna.
- **Ljudformat:** appen säger till servern vad telefonen spelar (iPhone: MP3, AAC, FLAC; Android: dessutom Opus och
  Vorbis). Annat kodar servern om, och då spolar appen genom att be om en ny ström från rätt ställe.
- **Ljudböcker:** *Fortsätt lyssna* och alla böcker. Boksidan har *Fortsätt från …*, *Börja om* och kapitlen. Platsen
  sparas på servern var 15:e sekund, vid paus och när appen går i bakgrunden, så boken fortsätter där du slutade –
  även i webben och de andra apparna. Helskärmsspelaren har 15 s bakåt, 30 s framåt, hastighet (0,8–2×) och kapitel.
- **Poddar:** poddarna och de senaste avsnitten; tryck på ett avsnitt för att spela det där du slutade. Poddar läggs
  till i webbgränssnittet.
- **Skärmtid:** säger servern stopp (skärmtiden är slut eller en vuxen stoppade) pausar spelaren och visar varför.
- Startar du en film eller ett avsnitt pausas musiken.

### Låsskärm, hörlurar och bakgrund

Appen ber om att få spela i bakgrunden och med ljudet avstängt (`setAudioModeAsync` med `shouldPlayInBackground`,
`playsInSilentMode` och `interruptionMode: 'doNotMix'`) och visar titel, artist, album och omslag på låsskärmen
(`setActiveForLockScreen`). På låsskärmen och i hörlurarna fungerar spela/pausa och spola (±10 s för musik, −15/+30 s
för böcker och poddar). **Nästa och föregående låt på låsskärmen finns inte än:** `expo-audio` visar de knapparna bara
för sin spellista (`AudioPlaylist`), och appen använder två vanliga spelare.

Det här är **inte provat på en riktig telefon**, bara i webbläget (Chrome, där låsskärmen motsvaras av webbläsarens
mediakontroller). Det här vet vi från Expos dokumentation för SDK 58:

- `expo-audio` finns i Expo Go, så musiken spelar där.
- Bakgrundsljud kräver inställningar i själva appen: `UIBackgroundModes: audio` på iPhone och en förgrundstjänst
  (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`) på Android. Dem lägger insticksmodulen `expo-audio` i `app.json` till, men
  bara i ett **eget bygge** (`npx expo prebuild` / EAS Build). I Expo Go gäller Expo Gos egna inställningar, så om
  musiken fortsätter med låst skärm där är inte kontrollerat. Utan låsskärmskontrollerna stoppar Android ljudet efter
  ungefär tre minuter i bakgrunden.
- Insticksmodulen är inställd utan mikrofon (`microphonePermission: false`, `recordAudioAndroid: false`).

## Nedladdat (utan nät)

Ladda ner filmer, avsnitt och ljudböcker till telefonen och titta eller lyssna utan nät – på resan eller i flygplanet.
Kräver att kontot och profilen får ladda ner (rätten ställs in i webbgränssnittet). Utan den visas ingen knapp.

- **Ladda ner** finns på titelsidan för filmer och avsnitt, som *Ladda ner säsong N* för en hel säsong, och som en liten
  knapp på varje avsnitt (i senast valda kvalitet). Boksidan har *Ladda ner boken*.
- **Kvalitet:** 480p (minst, räcker på telefonen), 720p, 1080p eller full upplösning, med ungefärlig storlek och hur mycket
  plats som finns kvar. Servern gör en mobilanpassad MP4 (H.264/AAC) – *Servern förbereder filen 40 %* syns medan den
  arbetar, sedan *Laddar ner 300 MB av 1,2 GB*. En ljudbok laddas ner i ett ljudformat telefonen spelar.
- **Pausa, Fortsätt, Avbryt och Försök igen** på titelsidan och i Nedladdat. Försvinner nätet väntar nedladdningen och
  fortsätter av sig själv.
- **Hemma går det fortare:** när appen har bekräftat serverns hemadress (se *Servrar*) hämtas filen därifrån. Lämnar
  du hemmet mitt i fortsätter den från den sparade adressen.
- **Nedladdat** (under **Konto → Visa Nedladdat**) fungerar helt utan nät: filmer, serier (per serie och säsong) och
  ljudböcker med omslag, var du är, storlek, *Ta bort* och *Ta bort allt*, och hur mycket plats det tar och hur mycket
  som är ledigt. Startar appen utan kontakt med servern öppnas Nedladdat direkt, med *Försök igen*.
- **Spelaren** spelar den nedladdade filen även när du har nät (sparar data). Undertexter som fanns som text på servern
  laddas ner med filmen och visas ovanpå bilden; knappen uppe till höger byter spår eller stänger av. Undertexterna syns
  inte i telefonens egen helskärm eller i bild-i-bild (expo-video kan inte lägga till egna undertextfiler). Utan nät går
  spelaren vidare till nästa *nedladdade* avsnitt.
- **Var du är:** med nät skickas positionen till servern som vanligt. Utan nät sparas den i telefonen och skickas med
  tidpunkten (`at`) när servern svarar igen – en senare position från en annan enhet vinner. Nedladdat visar hur många
  som väntar.
- **Per server och profil:** varje profil har sina egna nedladdningar. Byter du profil syns den profilens. **Logga ut**
  frågar först och tar sedan bort allt som laddats ner från servern; att ta bort servern ur listan gör samma sak.

### Barnprofiler, skärmtid och familjefiltret

Servern bestämmer, som för allt annat. Det här gäller:

- **Vad som får laddas ner** kontrolleras av servern när du trycker: rätten att ladda ner, åldersgränsen, biblioteken
  och familjefiltret (en titel med tystade svordomar laddas inte ner när filtret är påtvingat – den kan bara strömmas).
  Appen visar serverns förklaring.
- **När servern svarar igen** kontrollerar appen de nedladdade titlarna (högst var sjätte timme): en titel som profilen
  inte längre får se tas bort, och får kontot inte ladda ner längre tas allt bort. Nedladdat säger vad som togs bort.
- **Skärmtid med nät:** som vanlig uppspelning – servern räknar tiden och kan säga stopp, även för en nedladdad fil.
- **Skärmtid utan nät:** appen använder den senaste statusen från servern (tid kvar i dag och klockslagen) och räknar
  själv tiden som spelas utan nät. När tiden är slut eller klockslaget passerat pausar spelaren med en förklaring, och
  filmen startar inte. Tiden sparas som en post per uppspelning (när den började, hur länge, film eller ljudbok) och
  lämnas in när nätet kommer tillbaka (`POST /api/screentime/offline`, tillsammans med positionerna). Servern räknar
  den på dagen den spelades och bara en gång, så den syns i föräldraöversikten och minskar tiden kvar på andra enheter.
  Det servern tagit emot tas bort ur telefonen; tills dess räknas det av från tiden kvar. *Ta bort allt* i Nedladdat tar
  inte bort tid som inte lämnats in.

Det här **kan inte** upprätthållas utan nät:

- Tiden som spelats utan nät räknas på servern först när nätet är tillbaka. Tills dess vet andra enheter inte om den.
- En ny dag utan nät gäller samma dagliga gräns och klockslag som senast, utan extra tid – veckodagarnas egna regler och
  ändringar som en vuxen gjort efteråt känner appen inte till förrän den har nät igen.
- En vuxen kan inte stoppa uppspelningen på distans, och en åldersgräns som sänkts gäller nedladdade titlar först när
  servern svarar.
- Telefonens klocka går att ställa om.
- Startar appen utan nät visas nedladdningarna för den profil som senast var inloggad – byta profil kräver servern.

### Bakgrund: Expo Go mot eget bygge

Nedladdningen använder `expo-file-system` (`DownloadTask`). Det här står i Expos dokumentation för SDK 58 – **inget av det
är provat på en riktig telefon**:

- **iPhone:** nedladdningen körs i en bakgrundssession (`sessionType: 'background'`, standard), så filen ska laddas
  vidare när appen ligger i bakgrunden. I ett eget bygge är det appens egen session; om det fungerar likadant inuti Expo
  Go är inte kontrollerat. Stängs appen helt (eller av systemet) kommer appen inte
  åt den pågående nedladdningen igen; den börjar om, om den inte pausats (då sparas iPhones läge och den fortsätter).
- **Android:** filen hämtas av appen själv (OkHttp) och fortsätter så länge appen lever. Android kan stoppa appen en
  stund efter att den hamnat i bakgrunden – det finns ingen förgrundstjänst för nedladdningar, varken i Expo Go eller i ett
  eget bygge med den här koden. Nästa gång appen öppnas fortsätter filen där den slutade (Range från filens längd, med en
  ny länk från servern).
- Länken till filen gäller ett dygn. Har en pausad nedladdning legat längre börjar den om med en ny länk.

## Snabb start

- Appen skickar startpositionen till servern, så att strömmen förbereds på rätt ställe (korta segment där).
- När fingret landar på en Spela-knapp ber appen servern starta strömmen direkt (`warm=1`), innan du släpper.
- Spelaren frågar `/playback` samtidigt som titelns uppgifter (`/api/items/:id`) i stället för efter, som webben.
  Frågan är samma som förvärmningen (utan ljudspår – servern väljer profilens förval), så den tar över den förvärmda
  strömmen. Valde servern ett annat ljudspår än titelns förval frågar appen igen med ljudspåret, och servern stoppar
  den första strömmen. En ström som aldrig används (spelaren stängd, titeln gick inte att hämta) stoppas. Reglerna:
  `src/startcore.ts` (testas i `test/expo-start.test.js`). Uppmätt i webbläget med 80 ms fördröjning per anrop: svaret
  på `/playback` kommer cirka 90 ms tidigare (en rundresa).

## Begränsningar

- Expo Go spelar video med telefonens egen spelare. MKV, DTS och liknande kan den inte spela direkt, så servern
  packar om eller kodar om dem – precis som för webbappen. För att spela allt direkt krävs en egen spelare, och en
  sådan går inte att ladda i Expo Go.
- Live-TV finns inte i den här appen än. Nedladdning finns (se *Nedladdat*), men utan automatisk synk av följda serier
  (`/api/offline/sync`, som Android-appen har) och utan musikalbum. Musik, ljudböcker och poddar finns (se ovan), men utan
  nästa/föregående på låsskärmen, utan helt glapplösa låtbyten och utan jämn ljudnivå (ReplayGain), övertoning,
  sovtimer, låttexter, bokmärken och redigering av spellistor – det finns i webben.
- Undertexter och val av ljudspår sköts av telefonens spelare, för de spår som strömmen innehåller.

## Utveckling

- `npm run typecheck` kontrollerar typerna.
- `npx expo export --platform web` bygger appen för webben, vilket går igenom all kod. Samma två steg körs i GitHub
  Actions (`.github/workflows/expo.yml`).
- Koden: `App.tsx` (vilken server, inloggat eller inte, profilväljaren, sidorna), `src/api.ts` (sparade servrar, serveranrop, fel, adresser), `src/theme.ts`
  (webbappens färger och mått), `src/components/ui.tsx` (knappar, kort, hyllor) och `src/screens/` (`Profiles.tsx` är
  *Vem tittar?*). Ljudet: `src/music.ts` (spelarna, kön mot `/api/me/queue`, böckernas och poddarnas position –
  utanför React), `src/components/audio.tsx` (omslag, låtrader, minispelaren), `src/screens/Music.tsx` (fliken Musik,
  album, artist, spellista), `src/screens/Books.tsx` (ljudböcker och poddar) och `src/screens/NowPlaying.tsx`
  (helskärmsspelaren). Nedladdat: `src/offlinecore.ts` (logiken utan filsystem: poster, kö, väntande positioner,
  undertexter, skärmtid utan nät – bara `i18n.ts` importeras), `src/offline.ts` (filerna, `DownloadTask`, serveranropen),
  `src/components/download.tsx` (knapparna) och `src/screens/Downloads.tsx` (Nedladdat). Feedback: `src/feedback.ts`
  (texter, var man är, senaste uppspelningen, anropen) och `src/screens/Feedback.tsx` (formuläret och Mina ärenden).
  Spolning i en omkodning: `src/seekcore.ts` (reglerna, testas i repots `test/expo-seek.test.js`) och `src/screens/Player.tsx`.
  Sammanfattning, intro, eftertexter och kortet för nästa avsnitt: `src/skipcore.ts` (reglerna, samma som webbens
  `web/js/player/autoskip.js`; testas i repots `test/expo-skip.test.js`, som jämför med webben) och `src/screens/Player.tsx`.
- **Texter:** skriv all text som syns på svenska i `t('…')` från `src/i18n.ts` (variabler `t('Säsong {n}', { n })`,
  plural `tn(n, '1 avsnitt', '{n} avsnitt')`) och lägg den engelska raden i `src/i18n-en.ts`. Finns texten redan i
  webbens `web/i18n/en.js` ska den engelska vara exakt densamma. Text som ska följa språket får inte ligga i en konstant
  på modulnivå – gör en funktion (som `KIND()` i `src/feedback.ts`). `test/expo-i18n.test.js` (`node --test
  test/expo-i18n.test.js` i repots rot) letar svensk text utanför `t()` i alla `.ts`/`.tsx` (strängar och JSX-text, med
  uttryckliga undantag i testet), kräver en engelsk rad för varje `t()` och ingen oanvänd, samma `{platshållare}`, samma
  engelska som webben för delade texter, och provar språkvalet, plural och tal i Node.
- Testerna för nedladdningen ligger i repots `test/expo-offline.test.js` och körs med Node (22.18 eller senare läser
  TypeScript): `node --test test/expo-offline.test.js` i repots rot. `offlinecore.ts` testas direkt, `offline.ts` med ett
  låtsat filsystem och en låtsad server (`test/helpers/expo-loader.mjs`, `expo-fakes.mjs`) – telefonens riktiga filsystem
  och nedladdning provas inte där.
- Paket utöver mallen: `expo-audio` (ljudspelaren, låsskärmen och bakgrundsljudet) och `expo-file-system` (filerna i
  Nedladdat och nedladdningen med paus, fortsätt och förlopp – ingår i Expo Go). Lägg till paket med
  `npx expo install`, så att versionen passar Expo SDK.
- I webbläget (`npx expo start --web` eller exporten) måste appen och servern ha samma adress, eftersom servern inte
  tillåter anrop från andra webbplatser till `/api/`. Lägg exporten bakom en enkel proxy som skickar `/api/` vidare
  till servern. Telefonen i Expo Go påverkas inte.
