// Musikspelarens Web Audio-motor: glapplös uppspelning och övertoning. Spåren hämtas och avkodas i förväg till buffertar
// (AudioBufferSourceNode) och nästa spår schemaläggs på exakt sampel – trim av kodarfördröjning/utfyllnad enligt servern
// (server/gapless.js, audiomix.trimFor). Ljudelementet (<audio>) spelar när motorn inte kan: första spåret om bufferten
// inte hunnit bli klar, långa spår (minnet), ljudböcker/poddar och webbläsare utan Web Audio (Safari på iPhone/iPad).
// Kedjan: element → elGain ┐
//         buffert → fade → norm ┴→ master (volym) → begränsare (mot klippning) → kompensation → högtalarna
// audio.js äger kön och gränssnittet; motorn frågar efter nästa spår (hooks.upcoming) och meddelar byten (hooks.advance).
import { fadeCurve, gainFor, planTransition, trimFor } from './audiomix.js';
import { t } from './core.js';

const MAX_SECONDS = 20 * 60;   // längre spår spelas av elementet (en avkodad minut stereo ≈ 21 MB)
const MAX_BYTES = 250 << 20;
const PREFETCH = 75;   // sekunder kvar av spåret när nästa hämtas och avkodas
const SCHEDULE = 4;    // sekunder före övergången när nästa schemaläggs
export const GRACE = 1500; // ms som en ny låt får vänta på sin buffert innan elementet tar den

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
    Object.assign(E, { ctx, master, elGain, limiter: lim });
    window.__bxAudioTap?.(ctx, comp); // testerna (test/web-gapless.test.js) lyssnar på utgången här
    E.timer = setInterval(tick, 250);
  } catch { E.failed = true; }
  return !!E.ctx;
}
export const ready = () => !!E.ctx;
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
  const ent = { p: null, dec: null, err: null };
  ent.p = (async () => {
    const res = await fetch(streamUrl(tm), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (+res.headers.get('content-length') > MAX_BYTES) throw new Error(t('för stor'));
    const data = await res.arrayBuffer();
    const buf = await new Promise((ok, no) => { const r = E.ctx.decodeAudioData(data, ok, no); r?.catch?.(no); });
    // Omkodat (FLAC från servern) är redan exakt; annars jämförs längden med serverns sampelantal
    const tr = res.headers.get('x-transcoded') === '1' ? { front: 0, back: 0 } : trimFor(buf.length, buf.sampleRate, tm.gapless);
    const n = Math.max(1, buf.length - tr.front - tr.back);
    return { buf, front: tr.front / buf.sampleRate, len: n / buf.sampleRate, trim: tr };
  })();
  ent.p.then(d => { ent.dec = d; }, e => { ent.err = e; ent.failedAt = Date.now(); });
  E.cache.set(key, ent);
  while (E.cache.size > 2) E.cache.delete(E.cache.keys().next().value);
  return ent.p;
}
const decoded = (t) => E.cache.get(t.id)?.dec || null;

// ---------- buffertar ----------
function voice(t, i, dec) {
  const ctx = E.ctx, src = ctx.createBufferSource(), fade = ctx.createGain(), norm = ctx.createGain();
  src.buffer = dec.buf; norm.gain.value = gainFor(t, E.prefs.normMode);
  src.connect(fade); fade.connect(norm); norm.connect(E.master);
  const v = { t, i, dec, src, fade, norm, t0: 0, at: 0, end: dec.len };
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
    len: E.cur?.dec.len ?? null, trim: E.cur?.dec.trim ?? null, handover: E.handover, handovers: E.handovers || 0, now: E.ctx?.currentTime ?? null, elT: E.elT?.id ?? null };
}
