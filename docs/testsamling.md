# Testsamlingen (mediakonformitet)

Testsamlingen kör alla uppspelningsvägar (direkt, remux till TS och fMP4, omkodning, anpassningsbar kvalitet)
mot syntetiska källfiler som liknar riktiga filmer, och kontrollerar HLS-strömmen som servern faktiskt skickar
med objektiva mätningar (ffprobe). Den finns för att fel i mediehanteringen – tonmappning, färgmärkning,
B-bilder och överlappande segment, Dolby-ljud i TS, undertexter – ska hittas innan de når en iPhone eller Chrome.

## Köra lokalt

Kräver `ffmpeg` och `ffprobe` (samma som övriga tester).

```bash
npm test                                         # snabb delmängd ingår (9 källor, 21 fall)
node --test test/conformance.test.js             # bara testsamlingen
CONFORMANCE=full node --test test/conformance.test.js        # hela matrisen
CONFORMANCE_ONLY=hevc-hdr10,scope-dts node --test test/conformance.test.js   # vissa källor (med CONFORMANCE=full alla fall)
CONFORMANCE_OUT=/tmp/samling node --test test/conformance.test.js            # spara spellistor, ffprobe-JSON och serverlogg
```

- Källorna skapas med ffmpeg (lavfi) och cachas efter innehållshash i `$TMPDIR/braxhn-tv-testsamling`
  (ändra med `TESTSAMLING_CACHE`). Första körningen tar ungefär en minut extra för den snabba delmängden och
  1,5 minut för alla källor (4 kärnor); sedan återanvänds filerna.
- `CONFORMANCE_JOBS` styr hur många källor som testas samtidigt (standard: hälften av kärnorna, 2–4).
- Vid fel sparas allt för det fallet (segment, spellistor, ffprobe-JSON, `playback.json`) och en
  `sammanfattning.json` i `CONFORMANCE_OUT` eller i en temporär mapp som skrivs ut i slutet.
- `node test/media/sources.mjs <mapp> --full` skapar bara samlingen och lägger den i `<mapp>/Filmer` – bra
  för att prova i en egen server.

Ungefärlig tid på 4 kärnor (filerna redan skapade): snabb delmängd ~65 s (21 fall), hela matrisen ~12 min (~330 fall, varav hälften ger samma ström som ett tidigare fall).

## Källorna (`test/media/sources.mjs`)

| id | Innehåll |
|---|---|
| `h264-mp4` | H.264 8 bit 1080p 23,976 i MP4, B-bilder, AAC (snabb) |
| `h264-mkv-opengop` | H.264 720p25 i MKV med öppen GOP, AC-3 5.1, SRT + ASS + PGS inbäddade, extern `.sv.srt` (snabb) |
| `h264-hi10` | H.264 High 10 (måste omkodas) (snabb) |
| `hevc-8` | HEVC 8 bit 29,97, E-AC-3 5.1 (snabb) |
| `hevc-10-sdr` | HEVC 10 bit BT.709, FLAC 5.1 |
| `hevc-hdr10` | HEVC 10 bit 1080p HDR10 (PQ/BT.2020, masteringdata, MaxCLL), E-AC-3 5.1 (snabb) |
| `hevc-hlg` | HEVC 10 bit HLG i MP4 |
| `dv81`, `dv5` | "Dolby Vision" profil 8.1 (hvc1) och 5 (dvh1), se begränsningar |
| `hevc-novui` | HDR10 där bildströmmens färginformation ändrats till "ospecificerad" (dåligt märkt rip) (snabb) |
| `vp9-webm` | VP9 + Opus i WebM (snabb) |
| `mpeg4-avi` | MPEG-4 Part 2 (XviD) med B-bilder + MP3 i AVI |
| `mpeg2-ts` | MPEG-2 576i flätad (TFF), SAR 16:15, MP2 i MPEG-TS |
| `anamorphic` | H.264 720×576 med SAR 64:45 (anamorf PAL) |
| `scope-dts` | H.264 1920×800, DTS 5.1 (snabb) |
| `truehd` | H.264 + TrueHD 5.1 (hoppas över om ffmpeg saknar kodaren) |
| `multi-audio` | Fyra ljudspår: AAC (standard), AC-3 5.1, Opus, FLAC (snabb) |
| `vfr` | Variabel bildfrekvens (10 → 30 bilder/s) |
| `fps50`, `h264-2997-ac3` | 50 bilder/s, 29,97 bilder/s med AC-3 stereo |

Dessutom körs serverns tonmappningskedja på HDR10-källan med färgegenskaperna nollställda, som efter
avkodning på grafikkortet (felet i 0.9.3).

**Begränsningar:** ffmpeg kan inte skriva Dolby Vision-RPU:er. `dv81`/`dv5` är HDR10-HEVC där en Dolby
Vision-konfigurationspost (`dvvC`/`dvcC`) lagts in i MP4-filen för hand – servern och ffprobe ser Dolby
Vision, men en riktig DV-spelare visar bara baslagret (för profil 5 med fel färger). TrueHD och DTS skapas
med ffmpegs experimentella kodare. Riktig GPU-avkodning (NVDEC/VAAPI) kan inte köras i CI.

## Klientprofiler och lägen

Profilerna är samma förmågor som respektive klient skickar till `/api/items/:id/playback`:
Chrome (hls.js), Safari/iPhone med och utan HDR (`nhls=1`), iOS-appen, tvOS-appen (utan `nhls`),
Android (ExoPlayer), utanför hemmet med 480p och utanför hemmet med automatisk kvalitet (ABR med `sbw`).
Profilerna `tc-hevc`, `tc-av1`, `tc-safari` och `tc-remote` skickar `tc=` (omkodning till HEVC/AV1 i fMP4); servern
startas med `TRANSCODE_VCODEC=cpu` så att x265/SVT-AV1 får användas. Finns ingen fungerande kodare (SVT-AV1 i ffmpeg
5.1/6.1 struntar i tvingade nyckelbilder och väljs bort vid start) blir det H.264 med en varning.
Hela matrisen kör alla profiler × automatiskt läge, `force=hls` (remux), tvingad omkodning 1080/720/360,
ljudspårsval och inbränd PGS. Fall som ger exakt samma ström som ett tidigare fall kontrolleras bara mot
den nya klientens förmågor.

## Vad som kontrolleras

För varje fall: uppspelningsbeslut → master → variantlista → initsegment (fMP4) → segment 0, 1, 2 och, i en ny
uppspelning med `start=` mitt i filmen, segmentet där, nästa och föregående (en omstart av ffmpeg).

- **Beslut:** förväntat läge där det är entydigt; okänt videoformat och HDR utan HDR-skärm omkodas; HDR som
  omkodas märks som tonmappat i `reasons`; direktuppspelning bara av format klienten angett (och Range fungerar).
- **Master:** BANDWIDTH och RESOLUTION rimliga och lika med den faktiska bilden; `VIDEO-RANGE` PQ/HLG bara vid
  HDR-remux; ABR-steg i fallande ordning och steget som ryms i `sbw` först.
- **Variantlista:** komplett VOD-lista, summan av EXTINF = filmens längd, inget EXTINF över TARGETDURATION.
- **Segment:** första bilden i segmentet ligger på spellistans tid (±0,1 s, även efter spolning), längden
  stämmer med EXTINF, segmentet börjar med en nyckelbild (IDR/IRAP, eller I-bild med återhämtningspunkt för
  öppen GOP vid remux), DTS ökar strikt, inga negativa eller omslagna tidsstämplar.
- **Följande segment:** nästa segments DTS/PTS börjar efter föregående (inget överlapp – Chrome avbryter då),
  ingen lucka över 2,5 bilder; ljudet överlappar högst en ljudram (två efter en omstart) och har inga luckor.
- **Omkodad bild:** codec enligt beslutet (`vcodec`: H.264, eller HEVC/AV1 i fMP4 bara när klienten bett om det),
  yuv420p 8 bit, H.264 med profil högst High och rimlig nivå för upplösning och bildfrekvens, HEVC i profilen Main,
  aldrig PQ/HLG/BT.2020-märkt, tonmappad HDR märkt BT.709, inga B-bilder, flätad källa avflätad, bildformat
  (SAR/DAR) bevarat, bithastighet under BANDWIDTH vid kvalitetsgräns.
- **Remux:** samma codec och HDR-märkning som källan, HEVC i fMP4 med `hvc1`/`dvh1`.
- **Ljud:** codec i klientens lista, aldrig AC-3/E-AC-3 i TS för Apples HLS-spelare, AAC stereo utanför
  hemmet, valt ljudspår används, rimlig samplingsfrekvens och kanalantal.
- **Undertexter:** varje textundertext (SRT, ASS, extern) ger WebVTT med replikerna på rätt tid, även i
  liveläget (`live=1`); PGS-indexet har replikerna och bild 0 är en PNG.

**Varningar** (skrivs ut men stoppar inte): små ljudöverlapp efter omstart (AAC-kodarens inledande ram) och
remux-tidsstämplar som är förskjutna högst bildomkastningens fördröjning (B-bilder). TS-remux från början
förskjuts så att första DTS blir 0 (0,04–0,2 s beroende på B-bilder och bildfrekvens), medan en omstart efter
spolning inte förskjuts – segment från två körningar kan därför skilja sig så mycket.

fMP4-segmentens tidsstämplar läses direkt ur `moof`/`tfdt`/`trun` (och `elst` i initsegmentet), så som
Apples spelare läser dem – ffprobe räknar fel för ett ensamt fragment (den utgår från `sidx`).

## Kända brister (visas som TODO)

- **fMP4-remux av HEVC med öppen GOP** (CRA-bilder med RASL, x265:s standard): ffmpegs HLS-muxer skriver fel
  kompositionstid för nyckelbilden först i varje fragment utom det första – den får samma PTS som en annan
  bild (0,04–0,12 s för tidigt). En vanlig fragmenterad MP4 från samma ffmpeg (`-movflags
  frag_keyframe+empty_moov+default_base_moof`) har rätt tider, så en möjlig rättning är att låta ffmpeg skriva
  en sådan ström och dela den i segment i servern. Testet `kända brister` under respektive källa visar fallen.

## macOS-jobbet

`.github/workflows/conformance.yml` har två jobb: (macOS-jobbet körs bara på begäran: Actions → Testsamling → Run workflow).

1. **Linux** – hela matrisen i `node:24-bookworm-slim` med Debians ffmpeg, samma som Docker-imagen.
2. **macOS** – `test/media/apple-check.mjs` startar servern, skapar HLS för de viktigaste fallen (HDR10-, HLG-
   och DV-remux, HEVC med E-AC-3, omkodning, tonmappning, TS med AAC respektive AC-3, DTS, ABR, PGS-inbränning)
   och kontrollerar dem med Apples egna verktyg:
   - `mediastreamvalidator`/`hlsreport` om HTTP Live Streaming Tools finns på maskinen (de kräver Apple-ID
     och finns normalt inte på GitHubs maskiner). Resultatet sparas som underlag; `APPLE_VALIDATOR_STRICT=1`
     gör det till krav.
   - **AVFoundation** (`test/media/AVPlayerCheck.swift`): AVPlayer laddar mastern, väntar på `readyToPlay`,
     spelar 4 s, avkodar bilder via `AVPlayerItemVideoOutput`, spolar till mitten och spelar vidare. Fel i
     `AVPlayerItem.error`/`errorLog` ger fel. Det är samma HLS-spelare och avkodare som i iPhone och Apple TV.
     Fallet "AC-3 orört i TS (tvOS-appen)" är underlag och stoppar inte jobbet.
   - **WebKit** (Playwright): webbspelaren startas på riktigt (inloggning, `play()`), för en HEVC-film (remux
     om WebKit anger HEVC) och en H.264 High 10-film (omkodning); `currentTime` ska gå framåt före och efter
     spolning utan MediaError.

Det macOS-jobbet **inte** kan visa: iPhone-hårdvarans avkodare och HDR-skärm (macOS-maskinen saknar HDR-skärm,
så HDR-remux spelas men visas som SDR), riktig Dolby Vision, AirPlay/Chromecast och Safari på iOS.
