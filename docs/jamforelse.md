# BraXhn TV jämfört med Plex, Jellyfin och Emby

Så här ser jag på jämförelsen, utifrån vår situation: en svensk familj med barn som kör Unraid, har ett stort bibliotek (mycket svenska
barnprogram) och tittar på TV:n, iPhone och i webbläsaren – ibland utanför hemmet. Den bygger på README och koden
(november 2026), inte på marknadsföring. Plex = Plex Media Server med Plex Pass, Jellyfin 10.10, Emby med Premiere,
plus Infuse och Channels DVR där de är bäst i sin nisch.

## Där BraXhn TV redan är bäst

| Område | BraXhn TV | Övriga |
|---|---|---|
| Barn och familj | Barnprofiler med svensk åldersgräns, PIN, **skärmtid** som servern upprätthåller (minuter, klockslag per veckodag, extra tid), **familjefilter** (svordomar tystas och textas om, scener hoppas över), **Föräldraöversikt** (nytt, se nedan) | Plex: Plex Home med åldersgräns, ingen skärmtid. Jellyfin/Emby: åtkomstschema och åldersgräns, ingen översikt, inget filter |
| Svenska titlar | Matchning testad mot en korpus med svenska DVD-rippar, julkalendrar, barnfilm och tecknat; svensk åldersgräns från TMDB | Bra på engelska namn, sämre på svenska titlar utan år |
| Titta tillsammans | Watch party, **Kvällsvalet** (hushållet sveper fram filmen), *Spela på…* mellan egna enheter | Plex: Watch Together i vissa appar. Jellyfin: SyncPlay. Emby: inget inbyggt |
| Unika funktioner | Repliksökning, språkinlärning, Ögonblick (klipp att dela), "Det här har hänt" ur egna filer, hälsokontroll av biblioteket, diskrådgivaren | Finns inte |
| Webben | Fungerar offline, styrs med fjärrkontroll i TV-webbläsare, WCAG 2.2 AA, svenska och engelska | Plex Web och Jellyfin Web kräver nät och mus |
| Gratis | Allt utan konto, moln eller prenumeration – även hårdvaruomkodning, DVR, nedladdning, webhooks | Plex Pass och Emby Premiere kostar |
| Live-TV | DVR med regler och reklamhopp, IPTV med Xtream/M3U, timeshift | I nivå med Channels DVR för IPTV; Channels har bättre appar |

## Det som saknas eller är sämre

Prioriterat efter nytta för familjen. *Verifierat i koden* = sökt efter och inte hittat.

1. **Egna appar för TV:n.** Apple TV- och Android/Google TV-apparna finns men är pausade; på Samsung/LG, Roku, Fire TV
   och spelkonsoler finns bara webbläsaren och DLNA. Plex, Jellyfin och Emby har appar nästan överallt, och Infuse ger
   bäst bild på Apple TV (Dolby Vision, TrueHD/Atmos rakt igenom). Störst lucka – men inget som går att lösa på webben.
2. **Fjärråtkomst utan inställningar.** Plex fungerar utanför hemmet utan portöppning (relä). BraXhn TV kräver VPN,
   omvänd proxy eller egen domän (README beskriver alla tre). Ett relä kräver en molntjänst och strider mot "inget moln".
3. **Insyn för föräldrar** – *byggt nu.* Tidigare såg föräldern barnens tittande bara i administratörens statistik, och
   bara hemma. Ingen av de andra har en föräldravy.
4. **Automatiska undertexter (tal till text).** Varken Plex, Jellyfin eller Emby har det inbyggt (Jellyfin via tillägg).
   Skulle hjälpa svenska barnprogram utan textfil, men kräver en taligenkänningsmodell – inte möjligt utan beroenden.
   *Verifierat i koden:* saknas.
5. **Ansikts- och objektigenkänning i foton** (Plex har det). *Verifierat i koden:* saknas. Låg nytta här.
6. **Röststyrning** (Alexa/Google Assistant i Plex). *Verifierat i koden:* saknas; webhooks och Home Assistant går.
7. **Tilläggssystem** (Jellyfin). Medvetet bortvalt – inga beroenden, allt i en image.
8. **Sömntimer för video.** Finns för ljud (☾ i ljudspelaren), inte i videospelaren. Skärmtiden täcker barnens behov.

Små skillnader som inte är luckor: Plex Discover/universell bevakningslista motsvaras av *Strömmande* och Trakt; Plexamp
motsvaras av låtradio, glapplöst och Subsonic-apparna; Tautulli motsvaras av *Tittarstatistik*.

## Varför Föräldraöversikten byggdes nu

Lucka 1 och 2 går inte att lösa på webben och servern utan apparna eller ett moln. Bland det som går gav en föräldravy mest:
barnen tittar på TV:n och iPaden medan föräldern är på jobbet eller i köket, skärmtiden fanns redan men gick bara att
ställa in under *Mitt konto*, och det enda sättet att se vad barnen tittat på var administratörens tittarstatistik – som
dessutom bara nås hemifrån. Nu ser huvudkontot på telefonen var som helst: vad barnen tittar på just nu (och kan stoppa
det), hur länge de tittat i dag och per dag, mest sett, kvällstittande efter kl. 21 och tittande utanför hemmet, och kan
ge eller dra av skärmtid med ett tryck. Ingen av Plex, Jellyfin eller Emby har något motsvarande. Se
*Föräldraöversikt* i [funktioner.md](funktioner.md).
