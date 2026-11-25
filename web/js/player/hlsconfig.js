// hls.js-inställningarna för filmer och avsnitt (webbspelaren). Importerar inget – testas i Node
// (test/stream-smooth.test.js) och i Chromium mot den riktiga hls.js.
//
// Varför de här värdena (orsaker till hack som mätts, se docs/arkitektur.md):
// - backBufferLength 30: utan gräns behåller hls.js allt som spelats i webbläsarens SourceBuffer. En 4K-remux fyller
//   kvoten (≈ 150 MB i Chrome) efter några minuter → QuotaExceededError → bufferten töms och filmen hackar.
// - maxBufferLength 60: en minut framåt (servern håller omkodningen 72–90 s före, se AHEAD_TRANSCODE i stream.js).
//   maxBufferSize (60 MB) begränsar ändå tunga strömmar.
// - maxBufferHole 0,5 / nudge: TS-remux kan börja 0,08–0,2 s efter 0 (B-bilder) och segment från en omstart kan
//   mötas med små glapp – med standardvärdet 0,1 s fastnade spelaren i glappet tills stall.js puttade den efter 3 s.
// - Bandbredden mäts från första byte (ABR nedan): segment som omkodas levereras när de blivit klara, och väntan
//   på servern är inte nätet. Annars trodde hls.js att nätet var långsamt och bytte ner – vilket startar om
//   omkodningen på det nya steget och ger ännu längre väntan.
export const HLS_VOD = Object.freeze({
  // CSP:n tillåter inga workers från blob: – hls.js försökte ändå varje gång (fel i konsolen) och föll sedan tillbaka
  enableWorker: false,
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  backBufferLength: 30,
  maxBufferHole: 0.5,
  nudgeMaxRetry: 6,
  nudgeOffset: 0.2,
  capLevelToPlayerSize: true,
  // Omkodning av HEVC/4K kan ta mer än hls.js standard (10 s) innan första byten kommer. Ger spelaren upp för tidigt
  // försöker den igen eller byter steg – då startar servern om omkodningen och filmen kommer aldrig igång.
  // Servern väntar själv upp till 90 s på ett segment.
  slowPolicy: Object.freeze({ maxTimeToFirstByteMs: 60000, maxLoadTimeMs: 180000, timeoutRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
    errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 } })
});

/** Konfigurationen till new Hls(): start = startposition (s), est = bandbreddsgissning (bit/s), Abr = abrClass(Hls) */
export function hlsConfig({ start = 0, est = 6e6, Abr = null, xhrSetup = null } = {}) {
  const { slowPolicy, ...rest } = HLS_VOD;
  const c = { ...rest, startPosition: start, abrEwmaDefaultEstimate: est, fragLoadPolicy: { default: slowPolicy } };
  if (Abr) c.abrController = Abr;
  if (xhrSetup) c.xhrSetup = xhrSetup;
  return c;
}

/** Ska nödbytet nedåt (hls.js "loading too slowly") hoppas över? Ja medan inget byte kommit: servern förbereder
 *  segmentet (omkodning, uppvaknande disk) – att byta steg då startar bara om arbetet. */
export const holdEmergency = (stats) => !!stats && !stats.aborted && !(stats.loading?.first > 0);

/** Tiden som bandbredden ska räknas från: första byte i stället för begäran (väntan på servern är inte nätet) */
export function fromFirstByte(stats) {
  const l = stats?.loading;
  if (!l || !(l.first > l.start)) return null;
  return l.first;
}

/** Väntetid (ms) innan första byte räknas högst så här mycket i hls.js svarstidsuppskattning */
export const TTFB_CAP = 400;

/**
 * Egen ABR-kontroll ovanpå hls.js standard. Ändrar bara mätningen, inte hur steg väljs:
 * - bandbreddsprov räknas från första byte (fromFirstByte), svarstiden kapas vid TTFB_CAP
 * - inget nödbyte nedåt medan servern ännu inte svarat (holdEmergency)
 * Saknas något i hls.js (annan version) används standardkontrollen oförändrad.
 */
export function abrClass(Hls) {
  const Base = Hls?.DefaultConfig?.abrController;
  if (typeof Base !== 'function') return null;
  return class BraxhnAbr extends Base {
    constructor(hls) {
      super(hls);
      const orig = this._abandonRulesCheck;
      if (typeof orig === 'function') {
        this._abandonRulesCheck = (...a) => {
          const f = this.partCurrent || this.fragCurrent;
          if (holdEmergency(f?.stats)) return;
          return orig.apply(this, a);
        };
      }
    }
    initEstimator(...a) {
      const e = super.initEstimator(...a);
      if (e && typeof e.sampleTTFB === 'function') { const s = e.sampleTTFB.bind(e); e.sampleTTFB = (ms) => s(Math.min(ms, TTFB_CAP)); }
      return e;
    }
    onFragBuffered(ev, data) {
      const st = data?.part && data.part.stats?.loaded ? data.part.stats : data?.frag?.stats;
      const first = fromFirstByte(st);
      if (first == null) return super.onFragBuffered(ev, data);
      const start = st.loading.start;
      st.loading.start = first; // hls.js räknar parsing.end − loading.start: utan serverns väntan
      try { return super.onFragBuffered(ev, data); } finally { st.loading.start = start; }
    }
  };
}

// ---------- segment som avkodningen börjar på (öppen GOP) ----------
// Filer med öppen GOP har efter varje nyckelbild några bilder som behöver GOP:en före. Börjar avkodningen på en
// nyckelbild utan att bilderna före har avkodats (start, fortsättning, spolning, återhämtning efter ett fel) avbryter
// Chromes mjukvaruavkodare hela uppspelningen på de bilderna. Spelaren ber därför om segmentet som avkodningen
// börjar i med ra=<sekunder in i segmentet>, och servern tar bort bilderna fram till dit (server/tslead.js) – de
// ligger före positionen och visas ändå inte. Segment som spelas vidare in i från det buffrade hämtas som vanligt.
/**
 * Börjar avkodningen i segmentet som startar på fragStart? buffered = [[start, slut], …], pos = där spelaren står
 * (eller ska börja), hole = största glapp spelaren går över. Ja när inget är buffrat alldeles före segmentet, eller
 * när spelaren redan står i det (spolning dit, eller bufferten tog slut precis där).
 * Ger sekunder in i segmentet där uppspelningen börjar, eller null = segmentet fortsätter på det buffrade.
 */
export function randomAccess(buffered, fragStart, pos, hole = 0.5) {
  const joined = buffered.some(([a, b]) => a < fragStart - 0.1 && b > fragStart - hole);
  if (joined && !(pos >= fragStart - 0.1)) return null;
  return Math.max(0, (Number(pos) || 0) - fragStart);
}
/** Segmentets nummer ur adressen till ett TS-segment (seg-12.ts?…), annars null */
export function segNo(url) { const m = /\/seg-(\d+)\.ts(?:\?|$)/.exec(String(url || '')); return m ? +m[1] : null; }
/** Adressen med ra=<sekunder in i segmentet> */
export const randomAccessUrl = (url, at = 0) => url + (url.includes('?') ? '&' : '?') + 'ra=' + (Math.round(at * 100) / 100);

/**
 * Återhämtning efter ett avkodningsfel: ska spelaren försöka igen på positionen pos (sekunder)?
 * prev = { at, pos, n } från förra försöket (eller null), now = klockan i ms. Högst max försök på samma ställe inom
 * 15 s – ett fel som kommer tillbaka direkt går inte att spela sig förbi. Ger nästa läge, eller null = ge upp.
 */
export function recoverPlan(prev, pos, now, max = 2) {
  const same = prev && Math.abs(pos - prev.pos) < 2 && now - prev.at < 15000;
  const n = same ? prev.n + 1 : 1;
  return n > max ? null : { at: now, pos, n };
}

// ---------- kvalitetsmenyn (⚙ i spelaren) ----------
export const QUALITY_STEPS = Object.freeze([['1080', '1080p (8 Mbit/s)'], ['720', '720p (4 Mbit/s)'], ['480', '480p (1,5 Mbit/s)'], ['360', '360p (0,8 Mbit/s)']]);
/**
 * Stegen som är värda att erbjuda för en källa (bredd × höjd): inget över källans upplösning – 1080p för en fil i
 * 180p ger samma bild som Original. Bredbild räknas efter bredden (1920×800 är en 1080p-fil, 1280×536 en 720p-fil),
 * och några procent marginal tar med filer som är beskurna en aning (1916×1076). Okänd storlek: alla steg.
 */
export function qualitySteps(width, height) {
  const cls = Math.max(Number(height) || 0, Math.round((Number(width) || 0) * 9 / 16));
  return cls ? QUALITY_STEPS.filter(([q]) => +q <= cls * 1.04) : [...QUALITY_STEPS];
}

// ---------- uppkopplingens takt (hastighetsprovet i caps.js) ----------
/** Takt (kbit/s) ur tidsmärken [ms, byte hittills] – räknar på det som kom efter den första tredjedelen */
export function rateOf(marks) {
  if (marks.length < 2) return 0;
  const last = marks[marks.length - 1], total = last[1];
  const from = marks.find(m => m[1] >= total / 3) || marks[0];
  // För lite kvar att räkna på (allt kom i en eller två bitar): hela provet från första byte
  const a = last[0] - from[0] >= 20 && last[1] > from[1] ? from : marks[0];
  const ms = Math.max(1, last[0] - a[0]), bytes = Math.max(0, last[1] - a[1]);
  return bytes ? Math.round(bytes * 8 / ms) : 0; // byte/ms × 8 = kbit/s
}
