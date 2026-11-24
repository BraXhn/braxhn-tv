// Musikspelarens Web Audio-motor: glapplös uppspelning och övertoning. Spåren hämtas och avkodas i förväg till buffertar
// (AudioBufferSourceNode) och nästa spår schemaläggs på exakt sampel – trim av kodarfördröjning/utfyllnad enligt servern
// (server/gapless.js, audiomix.trimFor). Ljudelementet (<audio>) spelar när motorn inte kan: första spåret om bufferten
// inte hunnit bli klar, långa spår (minnet), ljudböcker/poddar och webbläsare utan Web Audio (Safari på iPhone/iPad).
// Kedjan: element → elGain → (tal: kompressor → lyft) ┐
//         buffert → fade → norm ┴→ master (volym) → begränsare (mot klippning) → kompensation → högtalarna
// audio.js äger kön och gränssnittet; motorn frågar efter nästa spår (hooks.upcoming) och meddelar byten (hooks.advance).
import { fadeCurve, gainFor, planTransition, trimFor } from './audiomix.js';
import { t } from './core.js';

const MAX_SECONDS = 20 * 60;   // längre spår spelas av elementet (en avkodad minut stereo ≈ 21 MB)
const MAX_BYTES = 250 << 20;
const PREFETCH = 75;   // sekunder kvar av spåret när nästa hämtas och avkodas
const SCHEDULE = 4;    // sekunder före övergången när nästa schemaläggs
export const GRACE = 1500; // ms som en ny låt får vänta på sin buffert innan elementet tar den
// Snabbstart: låten börjar spela på början av filen medan resten hämtas. Början är QUICK_SECONDS av låten (efter
// filens storlek och längd; okänd storlek: QUICK_BYTES / 2). Medan resten kommer avkodas det som hunnit fram på nytt
// (början växer, grow) och motorn byter till den längre bufferten på samma sampel (upgrade) – samma avkodare ger samma
// sampel i början av båda. Till sist byts den mot hela låten. Så räcker det att hämtningen går fortare än låten spelas
// (MIN_RATE); går den långsammare spelar elementet, som strömmar själv.
const QUICK_BYTES = 1 << 20, QUICK_SECONDS = 5;
const QUICK_MIN = 3;       // sekunder som början minst ska räcka till
const QUICK_TAIL = 0.5;    // slutet av en avklippt fil kan vara ofullständigt avkodat – används inte
const MIN_RATE = 1.3;      // så många sekunder ljud ska minst komma per sekund för att början ska användas
const LONG = 10 * 60;      // längre låtar avkodas inte om flera gånger på långsamt nät (kräver LONG_RATE)
const LONG_RATE = 3;
const LOW = 8;             // sekunder avkodat framför spelhuvudet när början ska växa (om hela låten inte snart är klar)
const HEAD_TRIES = 4;      // försök att avkoda en början (dubbelt så mycket varje gång – stort omslag först i filen)

export const E = {
  ctx: null, master: null, elGain: null, el: null, failed: false, caps: 'mp3',
  cur: null,     // spelande buffert: { t, i, dec, src, fade, norm, t0, end }
  next: null,    // schemalagd nästa buffert (startar vid next.at)
  old: [],       // buffertar som tonas ut
  elT: null,     // låten elementet spelar (musik), annars null
  handover: false, paused: false, muted: false, volume: 1,
  prefs: { gapless: true, crossfade: 0, normMode: 'track' },
  cache: new Map(), hooks: {}, timer: null, decSpeed: 100
};
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// DynamicsCompressorNode lägger på egen "makeup gain" (spec: (1/kurvan vid 0 dBFS)^0,6) – den tas bort igen så att
// begränsaren bara verkar nära 0 dBFS och allt under tröskeln går igenom oförändrat
const LIM_T = -1, LIM_R = 20;
const makeupComp = () => (10 ** ((LIM_T * (1 - 1 / LIM_R)) / 20)) ** 0.6;

/** Skapar ljudsammanhanget (i ett klick – annars får det inte starta). false om Web Audio inte går att använda. */
/** Ljudsammanhangets takt för en låt: låtens egen (44,1 eller 48 kHz; 88,2/96/176,4/192 → halva/fjärdedelen), annars enhetens */
export const contextRate = (fileRate) => { for (const r of [44100, 48000]) for (const m of [1, 2, 4]) if (fileRate === r * m) return r; return 0; };
export function init(el, hooks, caps, fileRate) {
  E.hooks = hooks; E.el = el; if (caps) E.caps = caps;
  if (E.ctx || E.failed) return !!E.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  // iOS-Safari pausar Web Audio när skärmen låses – där spelar elementet som förut
  if (!AC || isIOS()) { E.failed = true; return false; }
  try {
    // Sammanhanget får låtens samplingsfrekvens: då räknas spåren inte om var för sig vid avkodningen (omräkningen ger
    // ett litet fel i varje skarv – en CD-rip på en enhet som går i 48 kHz). Webbläsaren räknar om den färdiga, obrutna
    // utsignalen till enheten i stället. Takten gäller tills sidan laddas om; låtar i annan takt räknas om som förut.
    const rate = contextRate(fileRate);
    let ctx = null;
    if (rate) { try { ctx = new AC({ latencyHint: 'playback', sampleRate: rate }); } catch {} }
    ctx ||= new AC({ latencyHint: 'playback' });
    const master = ctx.createGain(), lim = ctx.createDynamicsCompressor(), comp = ctx.createGain();
    lim.threshold.value = LIM_T; lim.knee.value = 0; lim.ratio.value = LIM_R; lim.attack.value = 0.003; lim.release.value = 0.25;
    comp.gain.value = makeupComp();
    master.connect(lim); lim.connect(comp); comp.connect(ctx.destination);
    const src = ctx.createMediaElementSource(el), elGain = ctx.createGain();
    src.connect(elGain); elGain.connect(master);
    // Jämn ljudnivå för tal (ljudböcker och poddar): en mjuk kompressor jämnar ut viskningar och höga partier och lyftet
    // tar igen nivån. Begränsaren efter master hindrar att något klipps. Kopplas bara in med setVoice(true).
    const vc = ctx.createDynamicsCompressor(), vlift = ctx.createGain();
    vc.threshold.value = -32; vc.knee.value = 12; vc.ratio.value = 4; vc.attack.value = 0.01; vc.release.value = 0.4;
    vlift.gain.value = 10 ** (6 / 20); // +6 dB
    vc.connect(vlift); vlift.connect(master);
    Object.assign(E, { ctx, master, elGain, limiter: lim, voiceIn: vc, voice: false });
    window.__bxAudioTap?.(ctx, comp); // testerna (test/web-gapless.test.js) lyssnar på utgången här
    E.timer = setInterval(tick, 250);
    // Nätet är tillbaka: misslyckade hämtningar provas igen direkt (annars först efter 30 s)
    window.addEventListener('online', forgetErrors);
  } catch { E.failed = true; }
  return !!E.ctx;
}
export const ready = () => !!E.ctx;
/** Talets kompressor in (true) eller ur kedjan efter elementet */
export function setVoice(on) {
  on = !!on;
  if (!E.ctx || E.voice === on) return;
  try { E.elGain.disconnect(); E.elGain.connect(on ? E.voiceIn : E.master); E.voice = on; } catch {}
}
/** Spelar motorn (en buffert) just nu? Annars är det elementet. */
export const on = () => !!E.cur;
const enabled = () => E.prefs.gapless || E.prefs.crossfade > 0;
/** Kan låten spelas som buffert? */
export const wants = (t) => !!E.ctx && enabled() && !!t?.id && !(t.duration > MAX_SECONDS);

export function setPrefs(p) {
  const was = { ...E.prefs };
  Object.assign(E.prefs, p);
  if (E.prefs.crossfade !== was.crossfade || E.prefs.gapless !== was.gapless) cancelNext(); // planeras om i nästa tick
  applyGains();
}
// ---------- volym och jämn ljudnivå ----------
export function setVolume(v, muted) {
  E.volume = v; E.muted = !!muted;
  if (E.master) E.master.gain.value = E.muted ? 0 : v;
}
export function applyGains() {
  if (!E.ctx) return;
  const m = E.prefs.normMode;
  for (const x of [E.cur, E.next, ...E.old]) if (x) x.norm.gain.value = gainFor(x.t, m);
  // Medan elementet tonas ut har förstärkningen en kurva – value får inte sättas då (kastar NotSupportedError)
  if (!E.elFading) E.elGain.gain.value = E.elT ? gainFor(E.elT, m) : 1;
}

// ---------- hämtning och avkodning ----------
const streamUrl = (t) => `/api/music/tracks/${t.id}/stream?a=${E.caps}&gl=1`;
const join = (parts, n) => { const all = new Uint8Array(n); let o = 0; for (const c of parts) { if (o >= n) break; all.set(o + c.length > n ? c.subarray(0, n - o) : c, o); o += c.length; } return all; };
/** Avkodar och mäter farten (sekunder ljud per sekund) – den avgör om det lönar sig att vänta på hela låten */
function decode(data) {
  const t0 = performance.now();
  return new Promise((ok, no) => { const r = E.ctx.decodeAudioData(data, ok, no); r?.catch?.(no); })
    .then(buf => { const s = (performance.now() - t0) / 1000; if (buf.duration > 2 && s > 0) E.decSpeed = Math.max(5, buf.duration / s); return buf; });
}
/**
 * Hämtar och avkodar låten (cachas: högst två väntande buffertar, hämtningar som inte längre behövs avbryts).
 * Löser till { buf, front, len } (sekunder).
 */
export function prepare(tm) {
  const key = tm.id;
  const have = E.cache.get(key);
  // Ett misslyckat försök (nät, 503 vid för många omkodningar) provas igen först efter 30 s
  if (have && !(have.err && Date.now() - have.failedAt > 30e3)) { E.cache.delete(key); E.cache.set(key, have); return have.p; }
  const ent = { tm, p: null, q: null, dec: null, head: null, err: null, slow: false, ac: window.AbortController ? new AbortController() : null,
    parts: [], got: 0, total: 0, at: 0, tries: 0, busy: false, done: false, t0: 0, got0: 0, ts: performance.now(), quickDone: null };
  ent.q = new Promise(r => { ent.quickDone = r; });
  ent.p = (async () => {
    const res = await fetch(streamUrl(tm), { credentials: 'same-origin', signal: ent.ac?.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = ent.total = +res.headers.get('content-length') || 0;
    if (total > MAX_BYTES) throw new Error(t('för stor'));
    // Läs strömmen bit för bit: när början kommit avkodas den för sig (snabbstart) medan resten fortsätter komma
    let data;
    const rd = res.body?.getReader?.();
    if (!rd) data = await res.arrayBuffer();
    else {
      ent.at = total && tm.duration > 0 ? Math.max(96e3, Math.min(QUICK_BYTES, total / tm.duration * QUICK_SECONDS)) : QUICK_BYTES / 2;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        if (!ent.t0) { ent.t0 = performance.now(); ent.got0 = value.length; } // takten räknas från första biten (inte svarstiden)
        ent.parts.push(value); ent.got += value.length;
        if (ent.got > MAX_BYTES) { rd.cancel().catch(() => {}); throw new Error(t('för stor')); }
        grow(ent);
      }
      ent.done = true;
      data = join(ent.parts, ent.got).buffer; ent.parts = [];
    }
    const buf = await decode(data);
    // Omkodat (FLAC från servern) är redan exakt; annars jämförs längden med serverns sampelantal
    const tr = res.headers.get('x-transcoded') === '1' ? { front: 0, back: 0 } : trimFor(buf.length, buf.sampleRate, tm.gapless);
    const n = Math.max(1, buf.length - tr.front - tr.back);
    return { buf, front: tr.front / buf.sampleRate, len: n / buf.sampleRate, trim: tr };
  })();
  // Hela låten klar (eller misslyckad): ingen början att vänta på, och den som spelar början byter till hela
  ent.p.then(d => { ent.dec = d; ent.head = null; ent.quickDone(null); arrived(ent, d); },
    e => { ent.err = e; ent.failedAt = Date.now(); ent.parts = []; ent.quickDone(null); });
  E.cache.set(key, ent);
  evict();
  return ent.p;
}
/** Hämtningens fart i byte per sekund: räknad från första biten (utan svarstiden), eller från början om allt kom på en gång */
function byteRate(ent, bytes = ent.got) {
  const now = performance.now();
  return Math.max((bytes - ent.got0) / Math.max(0.01, (now - ent.t0) / 1000), bytes / Math.max(0.01, (now - ent.ts) / 1000));
}
/** Hinner hämtningen med låten? (innan början är avkodad: efter farten hittills) – då lönar det sig att vänta lite till */
export function hopeful(tm) {
  const e = E.cache.get(tm.id);
  if (!e || e.err || e.slow || e.tries || !e.at || !e.total || !(tm.duration > 0) || !e.got) return false;
  return byteRate(e) / (e.total / tm.duration) >= MIN_RATE;
}
/** Väntas hela låten vara hämtad och avkodad inom `within` sekunder? (okänd storlek: nej) */
function fullSoon(ent, within) {
  if (ent.done) return true;
  if (!ent.total || !ent.got) return false;
  const rate = byteRate(ent);
  return (ent.total - ent.got) / rate + (ent.tm.duration || 0) / E.decSpeed * 1.5 + 0.5 < within;
}
/**
 * Avkodar det som hunnit hämtas av låten (en början som växer). Första gången när ent.at byte kommit; sedan när
 * dubbelt så mycket finns, eller – urgent, när spelhuvudet närmar sig slutet av det avkodade – redan vid 15 % mer.
 * Inget avkodas när hela låten ändå snart är klar.
 */
function grow(ent, urgent = false, left = Infinity) {
  const tm = ent.tm;
  if (ent.busy || ent.done || ent.dec || ent.err || !ent.at || !(tm.duration > 0) || ent.got < ent.at) return;
  if (ent.head) {
    if (ent.got < ent.head.bytes * (urgent ? 1.15 : 2)) return;
    if (fullSoon(ent, urgent ? left - 1 : 1.5)) return;
  } else if (ent.total && ent.total <= ent.got * 1.5) return; // nästan hela filen är framme – vänta på den
  ent.busy = true;
  const bytes = ent.got, took = Math.max(0.01, (performance.now() - ent.ts) / 1000);
  const again = () => { if (ent.head) return; if (++ent.tries >= HEAD_TRIES) { ent.at = 0; ent.quickDone(null); } else ent.at = bytes * 2; };
  decode(join(ent.parts, bytes).buffer).then(buf => {
    ent.busy = false;
    if (ent.dec || ent.err || E.cache.get(tm.id) !== ent) return; // hela låten hann före, eller låten behövs inte längre
    const avail = buf.duration - QUICK_TAIL;
    if (avail < QUICK_MIN) return again();
    const first = !ent.head;
    const head = ent.head = { buf, front: 0, len: Math.max(tm.duration, buf.duration), avail, partial: true, bytes };
    if (first) {
      // Takten: sekunder ljud som kommit per sekund (efter filens storlek när den är känd – ett omslag först i filen räknas då rätt)
      const r = ent.total ? byteRate(ent, bytes) / (ent.total / tm.duration) : buf.duration / took;
      ent.slow = r < (tm.duration > LONG ? LONG_RATE : MIN_RATE);
      ent.quickDone(ent.slow ? null : head);
    }
    arrived(ent, head);
    grow(ent);
  }, () => { ent.busy = false; again(); });
}
/** En längre början eller hela låten är avkodad: den som spelar en kortare början byter till den */
function arrived(ent, dec) {
  const c = E.cur;
  if (c?.partial && c.t.id === ent.tm.id && c.dec !== dec && E.cache.get(ent.tm.id) === ent) upgrade(ent.tm, dec);
}
/** Högst två låtar i cachen (utöver den som spelar och den schemalagda); den äldsta släpps */
function evict() {
  for (const k of [...E.cache.keys()]) {
    if (E.cache.size <= 2) break;
    if (E.cur?.t.id === k || E.next?.t.id === k) continue;
    drop(k);
  }
}
/** Släpper låten ur cachen och avbryter hämtningen om den pågår (låten hoppades över, eller elementet spelar den) */
export function drop(id) {
  const e = E.cache.get(id);
  if (!e) return;
  E.cache.delete(id);
  if (!e.dec && !e.err) { try { e.ac?.abort(); } catch {} }
}
/** Ny låt vald: hämtningar som pågår för andra låtar avbryts (annars hämtas varje överhoppad låt färdigt) */
export function only(id) {
  for (const [k, e] of [...E.cache]) if (k !== id && !e.dec) drop(k);
}
/** Misslyckade hämtningar glöms (nätet är tillbaka) så att nästa försök görs direkt */
export function forgetErrors() {
  for (const [k, e] of [...E.cache]) if (e.err) E.cache.delete(k);
}
const decoded = (t) => E.cache.get(t.id)?.dec || null;
/** Det bästa som finns avkodat av låten: hela, annars en början som räcker (och bara när hämtningen hinner med) */
function playable(t) {
  const e = E.cache.get(t.id);
  if (!e) return null;
  return e.dec || (e.head && !e.slow && !e.err ? e.head : null);
}
/** Början av låten för snabbstart: löser till en ofullständig buffert ({ partial: true, avail }) eller null */
export const quick = (tm) => E.cache.get(tm.id)?.q || Promise.resolve(null);
/**
 * Det första som går att spela av låten: en början eller hela låten. null = vänta inte (hämtningen går för långsamt
 * eller misslyckades) – då spelar elementet.
 */
export function first(tm) {
  const ent = E.cache.get(tm.id);
  if (!ent) return Promise.resolve(null);
  const full = ent.p.catch(() => null);
  return Promise.race([full, ent.q.then(h => h || (ent.slow ? null : full))]);
}

// ---------- buffertar ----------
function voice(t, i, dec) {
  const ctx = E.ctx, src = ctx.createBufferSource(), fade = ctx.createGain(), norm = ctx.createGain();
  src.buffer = dec.buf; norm.gain.value = gainFor(t, E.prefs.normMode);
  src.connect(fade); fade.connect(norm); norm.connect(E.master);
  const v = { t, i, dec, src, fade, norm, t0: 0, at: 0, end: dec.len, partial: !!dec.partial };
  // done: källan har spelat klart. Vid en glapplös övergång tar den slut innan tick() hunnit byta (promote) – då är
  // den fortfarande E.cur här och får inte läggas bland de gamla efteråt (den togs aldrig bort därifrån: en buffert per låt läckte)
  src.onended = () => { v.done = true; if (E.cur !== v && E.next !== v) { try { norm.disconnect(); } catch {} E.old = E.old.filter(x => x !== v); } };
  return v;
}
function startVoice(v, when, pos) {
  pos = Math.max(0, Math.min(pos, v.dec.len - 0.001));
  v.src.start(when, v.dec.front + pos, v.dec.len - pos);
  v.t0 = when - pos; v.at = when;
}
function kill(v) { if (!v) return; try { v.src.onended = null; v.src.stop(); } catch {} try { v.norm.disconnect(); } catch {} }

/** Startar låten som buffert från positionen pos (elementet stoppas av anroparen). */
export function play(t, i, dec, pos = 0) {
  stop();
  const v = voice(t, i, dec);
  startVoice(v, E.ctx.currentTime + 0.02, pos);
  E.cur = v; E.elT = null; applyGains();
  resume();
}
/**
 * En längre början eller hela låten är avkodad medan en början spelar: byt till den på samma sampel. Båda är avkodade
 * av samma avkodare och har samma sampel i början, så den nya bufferten startas vid exakt det sampel den gamla har nått
 * (en hel sampelperiod från starten) med 5 ms korsning – summan av två lika signaler är oförändrad.
 */
function upgrade(tm, full) {
  const c = E.cur;
  if (!c?.partial || c.t.id !== tm.id || !E.ctx) return;
  const ctx = E.ctx, sr = full.buf.sampleRate, X = 0.005;
  // Positionen i bufferten räknas från den gamla buffertens början (c.t0 = när sampel front spelades)
  const k = Math.ceil((Math.max(ctx.currentTime + 0.06, c.at + 0.01) - c.t0 + c.dec.front) * sr);
  const off = k / sr, T = c.t0 - c.dec.front + off;
  const have = full.partial ? full.avail : full.front + full.len;
  if (off >= c.dec.front + c.dec.avail - X - 0.02 || off >= have - 0.05) return; // för sent – tick() löser det
  const v = voice(c.t, c.i, full);
  v.src.start(T, off, Math.max(0.01, full.front + full.len - off));
  v.t0 = T - (off - full.front); v.at = T;
  v.fade.gain.setValueAtTime(0, ctx.currentTime); v.fade.gain.setValueAtTime(0, T); v.fade.gain.linearRampToValueAtTime(1, T + X);
  c.fade.gain.setValueAtTime(1, T); c.fade.gain.linearRampToValueAtTime(0, T + X);
  try { c.src.stop(T + X + 0.01); } catch {}
  E.old.push(c);
  E.cur = v; E.upgrades = (E.upgrades || 0) + 1;
  applyGains();
}
/** Stoppar allt som motorn spelar (elementet berörs inte). */
export function stop() {
  for (const v of [E.cur, E.next, ...E.old]) kill(v);
  E.cur = E.next = null; E.old = [];
  if (E.handover || E.elFading) { E.handover = E.elFading = false; E.elGain?.gain.cancelScheduledValues(0); }
}
export function pos() {
  const c = E.cur; if (!c) return 0;
  return Math.max(0, Math.min(c.dec.len, E.ctx.currentTime - c.t0));
}
export const dur = () => E.cur?.dec.len || 0;
export const paused = () => E.paused;
export function pause() {
  if (E.paused) return;
  E.paused = true;
  E.ctx?.suspend().catch(() => {});
  E.hooks.state?.(false);
}
/** Spela igen (efter paus eller när låten tagit slut). Promise som play() på ett element. */
export function resume() {
  if (E.cur && E.cur.ended) seek(0);
  E.paused = false;
  E.hooks.state?.(true);
  return E.ctx ? E.ctx.resume() : Promise.resolve();
}
export function seek(p) {
  const c = E.cur; if (!c) return;
  // Bara början är avkodad än: utanför den tar elementet över från positionen (audio.js)
  if (c.partial && p > c.dec.avail - 1) { E.hooks.underrun?.(c.t, c.i, p); return; }
  cancelNext();
  for (const v of E.old) kill(v);
  E.old = [];
  const v = voice(c.t, c.i, c.dec);
  kill(c);
  startVoice(v, E.ctx.currentTime, p);
  E.cur = v;
}
/** Tar bort en schemalagd nästa låt som inte börjat (kön ändrades, inställningarna ändrades eller spolning). */
function cancelNext() {
  const n = E.next;
  if (!n) return;
  if (E.ctx && E.ctx.currentTime >= n.at) return; // redan igång – byts i nästa tick
  kill(n); E.next = null;
  if (E.handover) { E.handover = false; E.elFading = false; E.elGain.gain.cancelScheduledValues(0); applyGains(); return; }
  const c = E.cur;
  if (c) { c.fade.gain.cancelScheduledValues(0); c.fade.gain.value = 1; try { c.src.stop(c.t0 + c.dec.len + 1); } catch {} }
}

// ---------- övergångar ----------
function schedule(up, dec, pl, at, from) {
  const n = voice(up.t, up.i, dec);
  startVoice(n, at, pl.nextStart);
  const x = pl.overlap;
  if (x > 0) {
    n.fade.gain.setValueAtTime(0, E.ctx.currentTime);
    n.fade.gain.setValueCurveAtTime(fadeCurve(false), at, x);
  }
  if (from) { // buffert → buffert
    if (x > 0) { from.fade.gain.setValueCurveAtTime(fadeCurve(true), at, x); from.src.stop(at + x); }
    else if (pl.curEnd < from.dec.len - 0.01) { from.fade.gain.setTargetAtTime(0, Math.max(E.ctx.currentTime, at - 0.04), 0.01); from.src.stop(at); }
  } else { // elementet → buffert
    E.handover = true; E.elFading = true; E.handovers = (E.handovers || 0) + 1;
    const g = E.elGain.gain, now = E.ctx.currentTime;
    g.cancelScheduledValues(0); g.setValueAtTime(g.value, now);
    const base = gainFor(E.elT, E.prefs.normMode);
    if (x > 0) g.setValueCurveAtTime(fadeCurve(true).map(v => v * base), at, x);
    else g.setTargetAtTime(0, Math.max(now, at - 0.01), 0.004);
  }
  n.overlap = x;
  E.next = n;
}
function promote() {
  const n = E.next; if (!n) return;
  if (E.handover) {
    E.handover = false;
    E.elT = null;
    // Vid övertoning tonas elementet ut färdigt innan det stoppas (om det inte fått en ny låt under tiden)
    const el = E.el, src = el.getAttribute('src');
    const end = () => {
      E.elFading = false; E.elGain.gain.cancelScheduledValues(0); applyGains();
      if (el.getAttribute('src') === src && !E.elT) E.hooks.stopElement?.();
    };
    if (n.overlap > 0) setTimeout(end, n.overlap * 1000 + 100); else end();
  } else if (E.cur) { if (E.cur.done) { try { E.cur.norm.disconnect(); } catch {} } else E.old.push(E.cur); }
  E.cur = n; E.next = null;
  applyGains();
  E.hooks.advance?.(n.t, n.i);
}
/** Elementet tog slut medan en övergång väntar – byt direkt. */
export function elementEnded() {
  if (!E.handover || !E.next) return false;
  promote();
  return true;
}

function tick() {
  if (!E.ctx || E.paused) return;
  const now = E.ctx.currentTime;
  if (E.next && now >= E.next.at) promote();
  const up = E.hooks.upcoming?.() || null;
  if (E.next && up?.t.id !== E.next.t.id) cancelNext();
  const c = E.cur;
  if (c) {
    E.hooks.time?.();
    if (c.partial) {
      // Början spelar: byt till något längre om det finns (kom det mellan schemaläggningen och bytet missades det),
      // låt början växa när spelhuvudet närmar sig slutet av det avkodade
      const ent = E.cache.get(c.t.id), nd = ent && (ent.dec || ent.head);
      if (nd && nd !== c.dec) upgrade(c.t, nd);
      const p = E.cur;
      if (p.partial) {
        const left = p.t0 + p.dec.avail - now;
        if (ent && left < LOW) grow(ent, true, left);
        // Det avkodade tar snart slut och mer har inte hunnit komma (nätet blev långsamt): elementet tar över från positionen
        if (!p.under && left < 1) { p.under = true; E.hooks.underrun?.(p.t, p.i, Math.max(0, now - p.t0)); }
        return;
      }
    }
    const rem = c.t0 + c.dec.len - now;
    if (!E.next && !c.ended && rem <= 0.01) {
      c.ended = true;
      E.hooks.ended?.();
      return;
    }
    if (E.next || c.ended || !up || !wants(up.t) || rem > PREFETCH) return;
    prepare(up.t).catch(() => {});
    // Hela nästa låt hinner inte alltid fram (långsamt nät): då börjar den på det som är avkodat och växer medan den spelar
    const ent = E.cache.get(up.t.id), lead = SCHEDULE + (E.prefs.crossfade || 0);
    if (ent && !ent.dec && rem < lead + LOW) grow(ent, true, rem - lead);
    const dec = decoded(up.t) || playable(up.t); if (!dec) return;
    const pl = planTransition(c.t, up.t, c.dec.len, dec.len, E.prefs);
    const at = c.t0 + pl.curEnd - pl.overlap;
    // En början används först i sista stund (hela låten kan hinna fram) och bara om den räcker en stund
    if (dec.partial && (at - now > SCHEDULE / 2 || dec.avail - pl.nextStart < QUICK_MIN)) return;
    if (at - now <= SCHEDULE) schedule(up, dec, pl, Math.max(at, now + 0.03), c);
    return;
  }
  // Elementet spelar en låt – nästa kan bli en buffert (glapplöst med elementets precision, ~några ms)
  const el = E.el, t = E.elT;
  if (!t || !el || el.paused || E.next || !up || !wants(up.t)) return;
  const d = el.duration, ct = el.currentTime, rate = el.playbackRate || 1;
  if (!(d > 0) || !isFinite(d)) return;
  if (d - ct > PREFETCH) return;
  prepare(up.t).catch(() => {});
  const ent = E.cache.get(up.t.id), lead = (d - ct) / rate - (E.prefs.crossfade || 0);
  if (ent && !ent.dec && lead < LOW) grow(ent, true, lead);
  const dec = decoded(up.t) || playable(up.t); if (!dec) return;
  const pl = planTransition(t, up.t, d, dec.len, E.prefs);
  if (dec.partial && dec.avail - pl.nextStart < QUICK_MIN) return;
  const left = (pl.curEnd - pl.overlap - ct) / rate;
  if (left <= 0.6) schedule(up, dec, pl, now + Math.max(0.02, left), null);
}

/** Bara för testerna: läget i motorn. */
export function debugState() {
  return { on: !!E.cur, cur: E.cur?.t.id ?? null, next: E.next?.t.id ?? null, at: E.next?.at ?? null, t0: E.cur?.t0 ?? null,
    len: E.cur?.dec.len ?? null, trim: E.cur?.dec.trim ?? null, handover: E.handover, handovers: E.handovers || 0, partial: !!E.cur?.partial, upgrades: E.upgrades || 0, old: E.old.length, cache: E.cache.size, rate: E.ctx?.sampleRate ?? null, now: E.ctx?.currentTime ?? null, elT: E.elT?.id ?? null };
}
