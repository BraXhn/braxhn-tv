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
// Snabbstart: låten börjar spela på början av filen (QUICK_BYTES) medan resten hämtas och avkodas. När hela låten är
// avkodad byter motorn till den på samma sampel (upgrade) – samma avkodare ger samma sampel i början av båda.
// Början är QUICK_SECONDS av låten (efter filens storlek och längd; okänd storlek: QUICK_BYTES). Den används bara när
// resten väntas hinna fram innan början tagit slut (hämtningens takt hittills) – annars väntar spelaren som förut.
const QUICK_BYTES = 1 << 20, QUICK_SECONDS = 10;
const QUICK_MIN = 3;       // sekunder som början minst ska räcka till
const QUICK_TAIL = 0.5;    // slutet av en avklippt fil kan vara ofullständigt avkodat – används inte

export const E = {
  ctx: null, master: null, elGain: null, el: null, failed: false, caps: 'mp3',
  cur: null,     // spelande buffert: { t, i, dec, src, fade, norm, t0, end }
  next: null,    // schemalagd nästa buffert (startar vid next.at)
  old: [],       // buffertar som tonas ut
  elT: null,     // låten elementet spelar (musik), annars null
  handover: false, paused: false, muted: false, volume: 1,
  prefs: { gapless: true, crossfade: 0, normMode: 'track' },
  cache: new Map(), hooks: {}, timer: null
};
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// DynamicsCompressorNode lägger på egen "makeup gain" (spec: (1/kurvan vid 0 dBFS)^0,6) – den tas bort igen så att
// begränsaren bara verkar nära 0 dBFS och allt under tröskeln går igenom oförändrat
const LIM_T = -1, LIM_R = 20;
const makeupComp = () => (10 ** ((LIM_T * (1 - 1 / LIM_R)) / 20)) ** 0.6;

/** Skapar ljudsammanhanget (i ett klick – annars får det inte starta). false om Web Audio inte går att använda. */
export function init(el, hooks, caps) {
  E.hooks = hooks; E.el = el; if (caps) E.caps = caps;
  if (E.ctx || E.failed) return !!E.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  // iOS-Safari pausar Web Audio när skärmen låses – där spelar elementet som förut
  if (!AC || isIOS()) { E.failed = true; return false; }
  try {
    const ctx = new AC({ latencyHint: 'playback' });
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
/** Hämtar och avkodar låten (cachas: högst två väntande buffertar). Löser till { buf, front, len } (sekunder). */
export function prepare(tm) {
  const key = tm.id;
  const have = E.cache.get(key);
  // Ett misslyckat försök (nät, 503 vid för många omkodningar) provas igen först efter 30 s
  if (have && !(have.err && Date.now() - have.failedAt > 30e3)) { E.cache.delete(key); E.cache.set(key, have); return have.p; }
  const ent = { p: null, q: null, dec: null, err: null };
  let quickDone;
  ent.q = new Promise(r => { quickDone = r; });
  const decode = (data) => new Promise((ok, no) => { const r = E.ctx.decodeAudioData(data, ok, no); r?.catch?.(no); });
  ent.p = (async () => {
    const res = await fetch(streamUrl(tm), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = +res.headers.get('content-length') || 0;
    if (total > MAX_BYTES) throw new Error(t('för stor'));
    // Läs strömmen bit för bit: när början kommit avkodas den för sig (snabbstart) medan resten fortsätter komma
    let data;
    const rd = res.body?.getReader?.();
    if (!rd) data = await res.arrayBuffer();
    else {
      const parts = []; let got = 0, tried = false;
      const t0 = performance.now();
      const quickAt = total && tm.duration > 0 ? Math.max(200e3, Math.min(2 * QUICK_BYTES, total / tm.duration * QUICK_SECONDS)) : QUICK_BYTES;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        parts.push(value); got += value.length;
        if (got > MAX_BYTES) { rd.cancel().catch(() => {}); throw new Error(t('för stor')); }
        if (!tried && got >= quickAt && (!total || total > got * 1.5) && tm.duration > 0) {
          tried = true;
          const took = (performance.now() - t0) / 1000;
          const head = new Uint8Array(got); let o = 0; for (const c of parts) { head.set(c, o); o += c.length; }
          decode(head.buffer).then(buf => {
            const avail = buf.duration - QUICK_TAIL;
            // Resten i samma takt som hittills (med marginal för avkodningen) ska vara framme innan början tar slut
            const eta = took * (tm.duration / buf.duration - 1) * 1.3 + 0.3;
            quickDone(avail >= QUICK_MIN && eta < avail - 2 ? { buf, front: 0, len: Math.max(tm.duration, buf.duration), avail, partial: true } : null);
          }, () => quickDone(null));
        }
      }
      const all = new Uint8Array(got); let o = 0; for (const c of parts) { all.set(c, o); o += c.length; }
      data = all.buffer;
    }
    const buf = await decode(data);
    // Omkodat (FLAC från servern) är redan exakt; annars jämförs längden med serverns sampelantal
    const tr = res.headers.get('x-transcoded') === '1' ? { front: 0, back: 0 } : trimFor(buf.length, buf.sampleRate, tm.gapless);
    const n = Math.max(1, buf.length - tr.front - tr.back);
    return { buf, front: tr.front / buf.sampleRate, len: n / buf.sampleRate, trim: tr };
  })();
  // Hela låten klar (eller misslyckad) utan snabbstart: ingen början att vänta på
  ent.p.then(() => quickDone(null), () => quickDone(null));
  ent.p.then(d => { ent.dec = d; }, e => { ent.err = e; ent.failedAt = Date.now(); });
  E.cache.set(key, ent);
  while (E.cache.size > 2) E.cache.delete(E.cache.keys().next().value);
  return ent.p;
}
const decoded = (t) => E.cache.get(t.id)?.dec || null;
/** Början av låten för snabbstart: löser till en ofullständig buffert ({ partial: true, avail }) eller null */
export const quick = (tm) => E.cache.get(tm.id)?.q || Promise.resolve(null);

// ---------- buffertar ----------
function voice(t, i, dec) {
  const ctx = E.ctx, src = ctx.createBufferSource(), fade = ctx.createGain(), norm = ctx.createGain();
  src.buffer = dec.buf; norm.gain.value = gainFor(t, E.prefs.normMode);
  src.connect(fade); fade.connect(norm); norm.connect(E.master);
  const v = { t, i, dec, src, fade, norm, t0: 0, at: 0, end: dec.len, partial: !!dec.partial };
  src.onended = () => { if (E.cur !== v && E.next !== v) { try { norm.disconnect(); } catch {} E.old = E.old.filter(x => x !== v); } };
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
  if (dec.partial) E.cache.get(t.id)?.p.then(full => upgrade(t, full), () => {});
}
/**
 * Hela låten är avkodad medan dess början spelar: byt till den på samma sampel. Början och hela låten är avkodade av
 * samma avkodare och har samma sampel i början, så den nya bufferten startas vid exakt det sampel den gamla har nått
 * (en hel sampelperiod från starten) med 5 ms korsning – summan av två lika signaler är oförändrad.
 */
function upgrade(tm, full) {
  const c = E.cur;
  if (!c?.partial || c.t.id !== tm.id || !E.ctx) return;
  const ctx = E.ctx, sr = full.buf.sampleRate, X = 0.005;
  // Positionen i bufferten räknas från den gamla buffertens början (c.t0 = när sampel front spelades)
  const k = Math.ceil((Math.max(ctx.currentTime + 0.06, c.at + 0.01) - c.t0 + c.dec.front) * sr);
  const off = k / sr, T = c.t0 - c.dec.front + off;
  if (off >= c.dec.front + c.dec.avail - X - 0.02 || off >= full.front + full.len - 0.05) return; // för sent – tick() löser det
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
  } else if (E.cur) E.old.push(E.cur);
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
      // Början tar snart slut och hela låten är inte avkodad än (långsamt nät): elementet tar över från positionen
      if (!c.under && c.t0 + c.dec.avail - now < 1) { c.under = true; E.hooks.underrun?.(c.t, c.i, Math.max(0, now - c.t0)); }
      return;
    }
    const rem = c.t0 + c.dec.len - now;
    if (!E.next && !c.ended && rem <= 0.01) {
      c.ended = true;
      E.hooks.ended?.();
      return;
    }
    if (E.next || c.ended || !up || !wants(up.t) || rem > PREFETCH) return;
    prepare(up.t).catch(() => {});
    const dec = decoded(up.t); if (!dec) return;
    const pl = planTransition(c.t, up.t, c.dec.len, dec.len, E.prefs);
    const at = c.t0 + pl.curEnd - pl.overlap;
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
  const dec = decoded(up.t); if (!dec) return;
  const pl = planTransition(t, up.t, d, dec.len, E.prefs);
  const left = (pl.curEnd - pl.overlap - ct) / rate;
  if (left <= 0.6) schedule(up, dec, pl, now + Math.max(0.02, left), null);
}

/** Bara för testerna: läget i motorn. */
export function debugState() {
  return { on: !!E.cur, cur: E.cur?.t.id ?? null, next: E.next?.t.id ?? null, at: E.next?.at ?? null, t0: E.cur?.t0 ?? null,
    len: E.cur?.dec.len ?? null, trim: E.cur?.dec.trim ?? null, handover: E.handover, handovers: E.handovers || 0, partial: !!E.cur?.partial, upgrades: E.upgrades || 0, now: E.ctx?.currentTime ?? null, elT: E.elT?.id ?? null };
}
