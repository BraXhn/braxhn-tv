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

/** Gissad bandbredd (kbit/s) när uppkopplingen utanför hemmet inte har kunnat mätas – samma som UNKNOWN_KBPS i
 *  server/stream.js (abrOrder): mastern listar då steget som ryms i gissningen först, och hls.js börjar på det. */
export const UNKNOWN_KBPS = 6000;
/** hls.js startgissning (bit/s, abrEwmaDefaultEstimate) ur uppmätt bandbredd i kbit/s (0 = okänd): 80 % av mätningen,
 *  som marginal mot mobilnätets svängningar – servern räknar likadant när den väljer steget som listas först. */
export const startEstimate = (kbps) => (kbps > 0 ? kbps * 0.8 : UNKNOWN_KBPS) * 1000;

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
/**
 * Spolning i en remux med öppen GOP (pb.gop 'ra' eller 'tc'): vad måste spelaren göra INNAN webbläsaren får spola
 * till t? Spolar Chrome inom bufferten börjar avkodningen om på nyckelbilden före t – och har den nyckelbilden kvar
 * bilderna som hänvisar till GOP:en innan (de tas bara bort i segment som hämtats med ra=) avbryter avkodaren med
 * PIPELINE_ERROR_DECODE. Felet kommer innan spolningens seeking-händelse hinner göra något, därför avgörs det här.
 * buffered = [[start, slut], …], clean = [[från, till], …] där nyckelbilderna redan är rensade (segment hämtade med
 * ra=), idr = andra nyckelbilden i filen (före den börjar avkodningen på filens första nyckelbild, som är IDR).
 * → 'seek' (spola som vanligt: utanför bufferten hämtar spelaren segmentet med ra=, eller punkten är ren),
 *   'flush' (töm bufferten från segmentet och spola sedan – segmentet hämtas om med ra=),
 *   'transcode' (gop 'tc': ra räcker inte, bilden måste kodas om från t).
 */
export function openGopSeek(buffered, t, { gop, clean = [], idr = 0 } = {}) {
  if (!buffered.some(([a, b]) => t >= a && t < b)) return 'seek';
  if (t < idr - 0.1) return 'seek';
  if (gop === 'tc') return 'transcode';
  return clean.some(([a, b]) => t >= a && t <= b) ? 'seek' : 'flush';
}
/** Där segmentet n är rensat när det hämtas med ra=at och börjar på start (sekunder): dropLeading i server/tslead.js
 *  rensar GOP:arna till at + 0,5 s in i segmentet. Marginalen i början täcker att nyckelbilden kan ligga en bit efter
 *  segmentets tid i spellistan (då hör en punkt alldeles i början till förra segmentets sista GOP). */
export const cleanRange = (start, at) => [start + 0.25, start + at + 0.4];
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
/** Kvalitetsstegen: [höjd, Mbit/s] (som QUALITIES i server/stream.js) */
export const QUALITY_STEPS = Object.freeze([['1080', 8], ['720', 4], ['480', 1.5], ['360', 0.8]]);
/** Etiketten för ett steg med decimaltecknet efter språket (decimalkomma på svenska, punkt på engelska) */
export const qualityLabel = (q, mbps, locale = 'sv-SE') => `${q}p (${Number(mbps).toLocaleString(locale || 'sv-SE')} Mbit/s)`;
/**
 * Stegen som är värda att erbjuda för en källa (bredd × höjd), som [höjd, etikett]: inget över källans upplösning –
 * 1080p för en fil i 180p ger samma bild som Original. Bredbild räknas efter bredden (1920×800 är en 1080p-fil,
 * 1280×536 en 720p-fil), och några procent marginal tar med filer som är beskurna en aning (1916×1076). Okänd storlek:
 * alla steg. locale = språket för decimaltecknet (core.js locale).
 */
export function qualitySteps(width, height, locale) {
  const cls = Math.max(Number(height) || 0, Math.round((Number(width) || 0) * 9 / 16));
  return (cls ? QUALITY_STEPS.filter(([q]) => +q <= cls * 1.04) : QUALITY_STEPS).map(([q, mb]) => [q, qualityLabel(q, mb, locale)]);
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

// ---------- spolning i en omkodning ----------
/**
 * Spolning utanför bufferten i en omkodad ström: ska spelaren starta om strömmen vid t i stället för att låta hls.js
 * hämta segmentet? Spellistan har 6 s-segment, och servern måste koda hela segmentet med målet innan något kan visas
 * (1,5–3,6 s i uppspelningsvakten). En ny ström med start vid t får korta segment just där (1 s med processorn, 2 s
 * med grafikkortet – samma som Fortsätt titta, hs i strömmens adress), så bilden kommer på ungefär en sekund.
 * Spellistan ändras aldrig under hls.js: det är en ny ström med en egen spellista.
 * buffered = [[start, slut], …], frags = spellistans segment [{ start, duration }], ready = [från, till] segment som
 * servern redan har klara i den pågående körningen (X-Seg-Ready) eller null. Nej när t är buffrat, när segmentet
 * redan är kort (början av filen, efter en fortsättning), när servern har det klart eller kodar det just nu, och nära
 * slutet (där ger servern inga korta segment).
 */
export function seekRestart(buffered, t, { frags = [], ready = null } = {}) {
  if (!Number.isFinite(t) || !frags.length) return false;
  if (buffered.some(([a, b]) => t >= a - 0.1 && t < b)) return false;
  const n = frags.findIndex(f => t >= f.start - 0.001 && t < f.start + f.duration);
  if (n < 0) return false;
  const last = frags.at(-1);
  if (t > last.start + last.duration - 4) return false;
  if (frags[n].duration <= 2.01) return false;
  if (ready && n >= ready[0] && n <= ready[1] + 1) return false;
  return true;
}
/** X-Seg-Ready från servern ("12-20") → [12, 20], annars null */
export function readyRange(h) { const m = /^(\d+)-(\d+)$/.exec(String(h || '').trim()); return m ? [+m[1], +m[2]] : null; }
/** Spellistans segment [{ start, duration }] ur texten i en medialista (index.m3u8) – för spelare som inte ger
 *  segmenten själva (Safaris egna HLS, nativeseek.js). Tom lista om texten inte är en spellista. */
export function parseFrags(text) {
  const out = []; let at = 0;
  for (const line of String(text || '').split('\n')) {
    const m = /^#EXTINF:([\d.]+)/.exec(line.trim());
    if (m) { const duration = +m[1]; out.push({ start: at, duration }); at += duration; }
  }
  return out;
}
/** Segmenten servern har klara (/hls/ready, [från, till]) om svaret är högst max ms gammalt, annars null.
 *  known = { segs, at } där at är när frågan skickades. */
export const freshReady = (known, now, max = 8000) => known && now - known.at <= max && Array.isArray(known.segs) ? known.segs : null;
