// Uppspelningsval per användare (users.playback_prefs, JSON), som i Plex: föredragna ljudspråk i prioritetsordning,
// undertextläge och -språk, SDH, automatisk överhoppning av intro/sammanfattning/eftertexter, nästa avsnitt och
// standardkvalitet hemma och utanför hemmet. Valen sparas på servern så att alla webbläsare och apparna får samma.
// pickAudio/pickSub är rena funktioner (testas i test/playprefs.test.js) och används av /api/items/:id och
// /api/items/:id/playback när klienten inte själv har valt spår.
import { get, run } from './db.js';

export const SUB_MODES = ['off', 'forced', 'foreign', 'always'];
export const QUALITY_PREFS = ['auto', 'orig', '1080', '720', '480', '360'];
export const ORIG = 'orig'; // "originalspråk" i ljudlistan = filens standardspår
const DEFAULTS = Object.freeze({
  audioLangs: [], subMode: 'forced', subLangs: [], sdh: 'avoid',
  skipIntro: false, skipRecap: false, skipCredits: false,
  autoNext: true, nextCountdown: 8, qualityHome: 'auto', qualityRemote: 'auto',
  autoSync: true, // synka nedladdade undertexter mot ljudet automatiskt (subsync.js)
  audioDesc: false // syntolkning: välj ljudspåret med ljudbeskrivning (visual_impaired/AD) när filmen har ett
});

// ISO 639-2 (B och T) → 639-1. Filernas språktaggar är oftast tre bokstäver (swe, eng), användarens val två (sv, en).
const L3 = {
  swe: 'sv', eng: 'en', nor: 'no', nob: 'no', nno: 'no', nb: 'no', nn: 'no', dan: 'da', fin: 'fi', ice: 'is', isl: 'is',
  ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', dut: 'nl', nld: 'nl', pol: 'pl', por: 'pt', rus: 'ru',
  jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', cmn: 'zh', yue: 'zh', ara: 'ar', tur: 'tr', gre: 'el', ell: 'el', heb: 'he',
  hin: 'hi', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro', ron: 'ro', ukr: 'uk', tha: 'th', per: 'fa', fas: 'fa', est: 'et',
  lav: 'lv', lit: 'lt', srp: 'sr', hrv: 'hr', bos: 'bs', slo: 'sk', slk: 'sk', slv: 'sl', bul: 'bg', vie: 'vi', ind: 'id',
  may: 'ms', msa: 'ms', tgl: 'tl', fil: 'tl', cat: 'ca', baq: 'eu', eus: 'eu', glg: 'gl', wel: 'cy', cym: 'cy', gle: 'ga',
  alb: 'sq', sqi: 'sq', mac: 'mk', mkd: 'mk', arm: 'hy', hye: 'hy', geo: 'ka', kat: 'ka', tam: 'ta', tel: 'te', ben: 'bn',
  urd: 'ur', kur: 'ku', sme: 'se', fao: 'fo', lat: 'la'
};
/** Normaliserat språk (två bokstäver när det går) – null för okänt ('und', tomt) */
export function langKey(code) {
  const c = String(code || '').trim().toLowerCase().split(/[-_.]/)[0];
  if (!c || c === 'und' || c === 'zxx' || c === 'mis' || c === 'mul') return null;
  return L3[c] || c;
}

const cleanLangs = (a, allowOrig) => {
  const out = [];
  for (const x of Array.isArray(a) ? a : String(a || '').split(',')) {
    const s = String(x || '').trim().toLowerCase();
    const k = allowOrig && s === ORIG ? ORIG : /^[a-z]{2,3}$/.test(s) ? langKey(s) : null;
    if (k && !out.includes(k)) out.push(k);
    if (out.length >= 6) break;
  }
  return out;
};
const bool = (v, d) => v == null ? d : v === true || v === 1 || v === '1' || v === 'true';

/** Giltiga val (okända/felaktiga fält får standardvärdet) */
export function normalize(p = {}) {
  p = p && typeof p === 'object' ? p : {};
  const n = parseInt(p.nextCountdown);
  return {
    audioLangs: cleanLangs(p.audioLangs, true),
    subMode: SUB_MODES.includes(p.subMode) ? p.subMode : DEFAULTS.subMode,
    subLangs: cleanLangs(p.subLangs, false),
    sdh: p.sdh === 'prefer' ? 'prefer' : 'avoid',
    skipIntro: bool(p.skipIntro, DEFAULTS.skipIntro), skipRecap: bool(p.skipRecap, DEFAULTS.skipRecap),
    skipCredits: bool(p.skipCredits, DEFAULTS.skipCredits),
    autoNext: bool(p.autoNext, DEFAULTS.autoNext),
    nextCountdown: Number.isFinite(n) ? Math.max(0, Math.min(60, n)) : DEFAULTS.nextCountdown,
    qualityHome: QUALITY_PREFS.includes(String(p.qualityHome)) ? String(p.qualityHome) : DEFAULTS.qualityHome,
    qualityRemote: QUALITY_PREFS.includes(String(p.qualityRemote)) ? String(p.qualityRemote) : DEFAULTS.qualityRemote,
    autoSync: bool(p.autoSync, DEFAULTS.autoSync),
    audioDesc: bool(p.audioDesc, DEFAULTS.audioDesc)
  };
}

function readRaw(uid) {
  try { return JSON.parse(get('SELECT playback_prefs FROM users WHERE id=?', uid)?.playback_prefs || 'null'); } catch { return null; }
}
/** Användarens val; saved = valen har sparats någon gång (webben flyttar då inte över gamla webbläsarval) */
export function getPrefs(uid) {
  const raw = readRaw(uid);
  return { ...normalize(raw || {}), saved: !!raw };
}
/** Ändra valen – bara fälten som skickas ändras */
export function setPrefs(uid, b = {}) {
  const cur = normalize(readRaw(uid) || {});
  const patch = {};
  for (const k of Object.keys(DEFAULTS)) if (b && b[k] !== undefined) patch[k] = b[k];
  const next = normalize({ ...cur, ...patch });
  run('UPDATE users SET playback_prefs=? WHERE id=?', JSON.stringify(next), uid);
  return getPrefs(uid);
}

// ---------------- spårval ----------------
// Kommentarsspår väljs aldrig automatiskt, ljudbeskrivning (syntolkning) bara när profilen valt det (audioDesc):
// ffprobes disposition (comment, visual_impaired) eller spårets titel.
const SPECIAL_AUDIO = /comment|kommentar|description|beskrivning|syntolk/i;
export const isSpecialAudio = (a) => !!(a?.comment || a?.vi || SPECIAL_AUDIO.test(a?.title || '') || /\bAD\b/.test(a?.title || ''));
const COMMENT_AUDIO = /comment|kommentar/i;
/** Ljudbeskrivning/syntolkning (inte kommentarsspår) */
export const isAudioDesc = (a) => !!a && !a.comment && !COMMENT_AUDIO.test(a.title || '') &&
  !!(a.vi || /description|beskrivning|syntolk/i.test(a.title || '') || /\bAD\b/.test(a.title || ''));
const COMMENT_SUB = /comment|kommentar/i;
export const isSdh = (s) => {
  const t = `${s?.label || ''} ${s?.title || ''}`;
  return !!(s?.hi || /\bsdh\b|hearing|hörsel/i.test(t) || /\b(CC|HI)\b/.test(t));
};

/**
 * Ljudspåret som ska spelas: första språket i listan som filen har (originalspråk = filens standardspår), annars
 * filens standardspår. Med audioDesc går ett syntolkat spår på samma språk före. audios = ljudströmmar ({ index, lang, title, default, comment?, vi? }).
 */
export function pickAudio(audios, prefs) {
  if (!audios?.length) return null;
  // Syntolkning: på det språk som annars skulle spelas, annars på första språket i listan som har en
  if (prefs?.audioDesc) {
    const ad = audios.filter(isAudioDesc);
    if (ad.length) {
      const main = pickAudio(audios, { ...prefs, audioDesc: false });
      const same = ad.find(a => langKey(a.lang) === langKey(main?.lang)) || (!langKey(main?.lang) ? ad[0] : null);
      if (same) return same;
      for (const l of prefs.audioLangs || []) { const m = ad.find(a => langKey(a.lang) === l); if (m) return m; }
    }
  }
  const pool = audios.filter(a => !isSpecialAudio(a));
  const base = pool.length ? pool : audios;
  const fallback = base.find(a => a.default) || base[0];
  for (const l of prefs?.audioLangs || []) {
    if (l === ORIG) return fallback;
    const m = base.filter(a => langKey(a.lang) === l);
    if (m.length) return m.find(a => a.default) || m[0];
  }
  return fallback;
}

/**
 * Undertexten som ska visas från början (eller null), efter undertextläget:
 *  off     – inga
 *  forced  – bara tvingade (delar av filmen på ett annat språk), helst på ljudets språk
 *  foreign – hela undertexter när ljudet är på ett annat språk än mina språk, annars tvingade
 *  always  – alltid hela undertexter på mina undertextspråk (annars tvingade)
 * subs = undertexter ({ id, lang, forced, hi, bitmap, pgs, label }); audio = valt ljudspår.
 * opts.pgs: PGS-bildundertexter går att visa utan inbränning (webbspelaren). Andra bildformat väljs aldrig
 * automatiskt – de kräver inbränning och därmed omkodning.
 */
export function pickSub(subs, audio, prefs, { pgs = false } = {}) {
  const p = prefs || DEFAULTS;
  if (!subs?.length || p.subMode === 'off') return null;
  const cand = subs.filter(s => (!s.bitmap || (pgs && s.pgs)) && !s.comment && !COMMENT_SUB.test(s.label || ''));
  if (!cand.length) return null;
  const myLangs = [...new Set([...(p.subLangs || []), ...(p.audioLangs || []).filter(l => l !== ORIG)])];
  const subLangs = p.subLangs?.length ? p.subLangs : myLangs;
  const aLang = langKey(audio?.lang);
  // Inom samma språk: SDH efter valet, sedan text före bild, sedan filens ordning
  const score = (s) => (isSdh(s) === (p.sdh === 'prefer') ? 0 : 2) + (s.bitmap ? 1 : 0);
  const best = (list) => list.map((s, i) => [s, score(s) * 1000 + i]).sort((a, b) => a[1] - b[1])[0]?.[0] || null;
  const forced = () => {
    const f = cand.filter(s => s.forced);
    if (!f.length) return null;
    if (aLang) { const m = f.filter(s => langKey(s.lang) === aLang); if (m.length) return best(m); }
    for (const l of subLangs) { const m = f.filter(s => langKey(s.lang) === l); if (m.length) return best(m); }
    // Tvingade undertexter på ett annat språk hör till ett annat ljudspår (t.ex. engelska tvingade till originalljudet
    // när den svenska dubbningen spelas) – bara om varken ljudets språk eller mina språk är kända tas vilken som helst
    return best(f.filter(s => !langKey(s.lang))) || (!aLang && !subLangs.length ? best(f) : null);
  };
  const full = () => {
    for (const l of subLangs) { const m = cand.filter(s => !s.forced && langKey(s.lang) === l); if (m.length) return best(m); }
    return null;
  };
  if (p.subMode === 'forced') return forced();
  if (p.subMode === 'foreign') {
    const foreign = !!aLang && myLangs.length > 0 && !myLangs.includes(aLang);
    return (foreign && full()) || forced();
  }
  return full() || forced(); // always
}

// ---------------- kvalitet ----------------
const RANK = { orig: 99, '2160': 6, '1080': 5, '720': 4, '480': 3, '360': 2 };
/** Den lägsta av två kvaliteter ('auto' = ingen egen gräns) */
export function minQuality(a, b) {
  if (!RANK[a]) return b; if (!RANK[b]) return a;
  return RANK[a] <= RANK[b] ? a : b;
}
/**
 * Kvaliteten när klienten valt "Auto": hemma användarens hemmaval (auto = original), utanför hemmet användarens
 * val inom administratörens tak (remote_quality). Returnerar { q, cap }: q = kvalitet hemma (null = original),
 * cap = taket utanför hemmet (som remoteQuality sedan anpassar efter bandbredden).
 */
export function autoQuality(prefs, remote, adminCap) {
  if (remote) return { q: null, cap: minQuality(adminCap, prefs?.qualityRemote) };
  const h = prefs?.qualityHome;
  return { q: RANK[h] ? h : null, cap: null };
}
