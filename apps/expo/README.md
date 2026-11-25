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

## Snabb start

- Appen skickar startpositionen till servern, så att strömmen förbereds på rätt ställe (korta segment där).
- När fingret landar på en Spela-knapp ber appen servern starta strömmen direkt (`warm=1`), innan du släpper.

## Begränsningar

- Expo Go spelar video med telefonens egen spelare. MKV, DTS och liknande kan den inte spela direkt, så servern
  packar om eller kodar om dem – precis som för webbappen. För att spela allt direkt krävs en egen spelare, och en
  sådan går inte att ladda i Expo Go.
- Musik, ljudböcker, poddar, live-TV och nedladdning finns inte i den här appen än.
- Undertexter och val av ljudspår sköts av telefonens spelare, för de spår som strömmen innehåller.

## Utveckling

- `npm run typecheck` kontrollerar typerna.
- `npx expo export --platform web` bygger appen för webben, vilket går igenom all kod. Samma två steg körs i GitHub
  Actions (`.github/workflows/expo.yml`).
- Koden: `App.tsx` (vilken server, inloggat eller inte, profilväljaren, sidorna), `src/api.ts` (sparade servrar, serveranrop, fel, adresser), `src/theme.ts`
  (webbappens färger och mått), `src/components/ui.tsx` (knappar, kort, hyllor) och `src/screens/` (`Profiles.tsx` är
  *Vem tittar?*).
- I webbläget (`npx expo start --web` eller exporten) måste appen och servern ha samma adress, eftersom servern inte
  tillåter anrop från andra webbplatser till `/api/`. Lägg exporten bakom en enkel proxy som skickar `/api/` vidare
  till servern. Telefonen i Expo Go påverkas inte.
