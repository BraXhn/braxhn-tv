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
  till servern, hoppar över intro och går vidare till nästa avsnitt.
- Musik, ljudböcker och poddar med minispelare, helskärmsspelare, kö som delas med webben och låsskärmens reglage.

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

## Snabb start

- Appen skickar startpositionen till servern, så att strömmen förbereds på rätt ställe (korta segment där).
- När fingret landar på en Spela-knapp ber appen servern starta strömmen direkt (`warm=1`), innan du släpper.

## Begränsningar

- Expo Go spelar video med telefonens egen spelare. MKV, DTS och liknande kan den inte spela direkt, så servern
  packar om eller kodar om dem – precis som för webbappen. För att spela allt direkt krävs en egen spelare, och en
  sådan går inte att ladda i Expo Go.
- Live-TV och nedladdning finns inte i den här appen än. Musik, ljudböcker och poddar finns (se ovan), men utan
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
  (helskärmsspelaren).
- Paket utöver mallen: `expo-audio` (ljudspelaren, låsskärmen och bakgrundsljudet). Lägg till paket med
  `npx expo install`, så att versionen passar Expo SDK.
- I webbläget (`npx expo start --web` eller exporten) måste appen och servern ha samma adress, eftersom servern inte
  tillåter anrop från andra webbplatser till `/api/`. Lägg exporten bakom en enkel proxy som skickar `/api/` vidare
  till servern. Telefonen i Expo Go påverkas inte.
