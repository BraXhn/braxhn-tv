// Ljudanalys i ren JS (ingen databas, inga beroenden): FFT, tempo, energi, dynamik, klangfärg, frekvensband,
// andel tal och ungefärlig tonart ur mono-PCM med låg samplingsfrekvens. Används av sonic-worker.js (i en egen tråd,
// så att servern inte stannar under analysen) och direkt av testerna.
//
// Vektorn (DIMS nedan) är spårets "ljudavtryck": varje dimension ligger ungefär i 0–1, så att den kan jämföras
// direkt (stationerna) eller standardiseras mot biblioteket (likhet, sonic.js).

export const SR = 11025;
/** Analysens version: höjs när egenskaperna eller vektorn ändras – alla spår analyseras då om i bakgrunden. */
export const VERSION = 1;
export const DIMS = ['tempo', 'pulse', 'energy', 'dynamics', 'brightness', 'zcr', 'speech', 'density',
  'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10', 'b11', 'b12'];
export const DIM = Object.fromEntries(DIMS.map((d, i) => [d, i]));
export const BANDS = 12;
const BAND_LO = 50; // Hz – under det finns knappt något i 11 kHz-avkodningen som skiljer låtar åt

// ---------------- FFT ----------------
const fftCache = new Map();
/**
 * Radix-2-FFT (Cooley–Tukey, iterativ) på plats. re/im har längden n = 2^k. Tabeller för vridfaktorer och
 * bitomvändning räknas en gång per storlek.
 */
export function fft(re, im) {
  const n = re.length;
  if (n & (n - 1) || n < 2) throw new Error('FFT-längden måste vara en tvåpotens');
  let T = fftCache.get(n);
  if (!T) {
    const rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
    T = { rev, cos, sin };
    fftCache.set(n, T);
  }
  const { rev, cos, sin } = T;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const a = i + k, b = a + half, wr = cos[w], wi = sin[w];
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

const hannCache = new Map();
function hann(n) {
  let w = hannCache.get(n);
  if (!w) { w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); hannCache.set(n, w); }
  return w;
}
const clamp01 = (v) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
const quantile = (arr, q) => { if (!arr.length) return 0; const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };

// ---------------- tempo ----------------
/** Värde i envelopen på en icke-heltalig position (linjär interpolation). */
const at = (e, x) => { const i = Math.floor(x), f = x - i; return i + 1 < e.length ? e[i] * (1 - f) + e[i + 1] * f : 0; };
/** Autokorrelation av onset-envelopen vid fördröjningen lag (bildrutor, får vara decimaltal). */
function acAt(e, lag) {
  let s = 0;
  const n = e.length - Math.ceil(lag) - 1;
  for (let i = 0; i < n; i++) s += e[i] * at(e, i + lag);
  return n > 0 ? s / n : 0;
}
/**
 * Tempo ur en onset-envelope (fr = bildrutor per sekund): autokorrelation för 60–200 BPM viktad med en
 * log-normal förväntan kring 120 BPM (minskar oktavfel som 60/120), förfinad i tiondels BPM.
 * Returnerar { bpm, pulse } där pulse (0–1) är hur tydligt takten syns (toppens höjd mot nollfördröjningen).
 */
export function tempoOf(raw, fr) {
  // Utjämnad envelope (gauss, σ = 1 ram): enstaka toppar som hamnar på var sin sida om en ramgräns ger annars
  // bara heltaliga fördröjningar, och tempot låser sig på några BPM fel
  const env = new Float64Array(raw.length), G = [0.054, 0.242, 0.399, 0.242, 0.054];
  for (let i = 0; i < raw.length; i++) { let s = 0; for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < raw.length) s += raw[j] * G[k + 2]; } env[i] = s; }
  const ac0 = acAt(env, 0);
  if (!(ac0 > 0)) return { bpm: null, pulse: 0 };
  // Kam: medel av autokorrelationen vid 1–4 perioder (fler perioder = finare upplösning och färre slumptoppar)
  const comb = (bpm) => { const L = 60 * fr / bpm; let s = 0; for (let k = 1; k <= 4; k++) s += acAt(env, k * L); return s / 4; };
  const score = (bpm) => comb(bpm) * Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
  let best = 0, bestBpm = 0;
  for (let bpm = 60; bpm <= 200; bpm += 0.5) { const s = score(bpm); if (s > best) { best = s; bestBpm = bpm; } }
  if (!(best > 0)) return { bpm: null, pulse: 0 };
  for (let bpm = bestBpm - 0.5, b0 = bestBpm; bpm <= b0 + 0.5; bpm += 0.05) { const s = score(bpm); if (s > best) { best = s; bestBpm = bpm; } }
  // Medelvärdet av envelopen² jämförs med kammens värde: 1 = varje topp återkommer exakt i takt, 0 = ingen takt
  let m = 0; for (const v of env) m += v; m /= env.length;
  const base = m * m;
  return { bpm: Math.round(bestBpm * 10) / 10, pulse: clamp01((comb(bestBpm) - base) / Math.max(1e-12, ac0 - base)) };
}

// ---------------- tonart (Krumhansl–Schmuckler) ----------------
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
export const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function corr(a, b) {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
/** Tonart ur ett medelvärdes-chroma (12 tonklasser från C). null om ingen tonart sticker ut. */
export function keyOf(chroma) {
  let best = -2, key = null;
  for (let r = 0; r < 12; r++) {
    const rot = (p) => chroma.map((_, i) => p[(i - r + 12) % 12]);
    const cM = corr(chroma, rot(MAJOR)), cm = corr(chroma, rot(MINOR));
    if (cM > best) { best = cM; key = NOTES[r]; }
    if (cm > best) { best = cm; key = NOTES[r] + 'm'; }
  }
  return best >= 0.5 ? { key, confidence: Math.round(best * 100) / 100 } : { key: null, confidence: Math.round(Math.max(0, best) * 100) / 100 };
}

// ---------------- hela analysen ----------------
/**
 * Analyserar mono-PCM (Float32Array, -1..1). Returnerar egenskaperna eller null om ljudet är för kort/tyst.
 * Ramar på 1024 sampel (93 ms) med steg 256 (23 ms) för spektrum, energi och onset; 4096 sampel för tonarten.
 */
export function analyze(x, sr = SR) {
  const N = 1024, H = 256, half = N / 2;
  if (!x || x.length < N * 8) return null;
  const frames = Math.floor((x.length - N) / H) + 1;
  const win = hann(N), re = new Float64Array(N), im = new Float64Array(N);
  let prev = new Float64Array(half + 1), cur = new Float64Array(half + 1);
  const rms = new Float64Array(frames), zcr = new Float64Array(frames), flux = new Float64Array(frames), cent = new Float64Array(frames);
  const binHz = sr / N;
  // Banden: logaritmiskt från 50 Hz till Nyquist
  const edges = Array.from({ length: BANDS + 1 }, (_, i) => BAND_LO * ((sr / 2) / BAND_LO) ** (i / BANDS));
  const bandOf = new Int8Array(half + 1).fill(-1);
  for (let k = 1; k <= half; k++) { const f = k * binHz; for (let b = 0; b < BANDS; b++) if (f >= edges[b] && f < edges[b + 1] + 1e-9) { bandOf[k] = b; break; } }
  const bands = new Float64Array(BANDS);
  const fluxHi = Math.min(half, Math.floor(5000 / binHz)), fluxLo = Math.max(1, Math.floor(30 / binHz));
  for (let f = 0; f < frames; f++) {
    const o = f * H;
    let e = 0, z = 0;
    for (let i = 0; i < N; i++) { const v = x[o + i]; e += v * v; re[i] = v * win[i]; im[i] = 0; if (i && (v >= 0) !== (x[o + i - 1] >= 0)) z++; }
    rms[f] = Math.sqrt(e / N); zcr[f] = z / N;
    fft(re, im);
    let sm = 0, sfm = 0, fl = 0;
    for (let k = 0; k <= half; k++) {
      const p = re[k] * re[k] + im[k] * im[k], m = Math.sqrt(p);
      cur[k] = Math.log1p(100 * m);
      if (k >= fluxLo && k <= fluxHi) { const d = cur[k] - prev[k]; if (d > 0) fl += d; }
      if (k) { sm += m; sfm += m * k * binHz; }
      if (bandOf[k] >= 0) bands[bandOf[k]] += p;
    }
    flux[f] = f ? fl : 0;
    cent[f] = sm > 0 ? sfm / sm : 0;
    const t = prev; prev = cur; cur = t;
  }
  const fr = sr / H;
  // Energi i dBFS (hela utdraget) och dynamik (skillnad mellan starka och svaga partier, tysta ramar räknas inte)
  let es = 0; for (let f = 0; f < frames; f++) es += rms[f] * rms[f];
  const meanRms = Math.sqrt(es / frames);
  if (meanRms < 1e-4) return null; // tystnad
  const energyDb = 20 * Math.log10(meanRms);
  const db = []; for (let f = 0; f < frames; f++) { const d = 20 * Math.log10(rms[f] + 1e-9); if (d > -70) db.push(d); }
  const dynamics = quantile(db, 0.95) - quantile(db, 0.10);
  // Klangfärg: spektral tyngdpunkt viktad med energin (tysta ramar påverkar inte)
  let cw = 0, cs = 0; for (let f = 0; f < frames; f++) { cw += rms[f]; cs += rms[f] * cent[f]; }
  const centroid = cw > 0 ? cs / cw : 0;
  let zs = 0, zq = 0; for (let f = 0; f < frames; f++) { zs += zcr[f]; zq += zcr[f] * zcr[f]; }
  const zMean = zs / frames, zStd = Math.sqrt(Math.max(0, zq / frames - zMean * zMean));
  // Onset-envelope: spektralflödet minus glidande medel (0,5 s), bara positiva delar
  const env = new Float64Array(frames), W = Math.round(fr / 4), pre = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) pre[f + 1] = pre[f] + flux[f];
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, f - W), b = Math.min(frames, f + W + 1);
    env[f] = Math.max(0, flux[f] - (pre[b] - pre[a]) / (b - a));
  }
  const { bpm, pulse } = tempoOf(env, fr);
  // Onset-täthet: toppar i envelopen över medel + 1 standardavvikelse, minst 70 ms isär
  let em = 0, eq = 0; for (let f = 0; f < frames; f++) { em += env[f]; eq += env[f] * env[f]; }
  em /= frames;
  // Tröskeln har också en absolut del (2,5 × det genomsnittliga flödet), så att jämnt brus inte räknas som anslag
  let fm = 0; for (let f = 0; f < frames; f++) fm += flux[f]; fm /= frames;
  const thr = Math.max(em + Math.sqrt(Math.max(0, eq / frames - em * em)), 2.5 * fm);
  let onsets = 0, last = -1e9;
  for (let f = 1; f < frames - 1; f++) if (env[f] > thr && env[f] >= env[f - 1] && env[f] >= env[f + 1] && f - last >= 3) { onsets++; last = f; }
  const density = onsets / (frames / fr);
  // Tal: många svaga ramar (pauser mellan ord), växlande noll-genomgångar (tonande/tonlösa ljud) och ingen tydlig takt
  const sec = Math.max(1, Math.round(fr));
  let low = 0;
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, f - (sec >> 1)), b = Math.min(frames, a + sec);
    let s = 0; for (let i = a; i < b; i++) s += rms[i];
    if (rms[f] < 0.5 * s / (b - a)) low++;
  }
  const lowRatio = low / frames, zCv = zMean > 0 ? zStd / zMean : 0;
  // Takt (pulse) talar emot tal: ett klickspår har också pauser, men i exakt takt
  const speech = clamp01((0.6 * clamp01((lowRatio - 0.05) / 0.2) + 0.4 * clamp01((zCv - 0.4) / 0.6)) * clamp01((0.6 - pulse) / 0.4));
  // Spektral fördelning: andel av energin per band
  let bt = 0; for (const v of bands) bt += v;
  const bandFrac = Array.from(bands, v => bt > 0 ? v / bt : 0);
  // Tonart: chroma ur 4096-punkters FFT (2,7 Hz upplösning) på var fjärde ram, 100–2000 Hz
  const K = 4096, KH = 2048, kwin = hann(K), kre = new Float64Array(K), kim = new Float64Array(K), chroma = new Array(12).fill(0);
  const pc = new Int8Array(K / 2).fill(-1);
  for (let k = 1; k < K / 2; k++) { const f = k * sr / K; if (f >= 100 && f <= 2000) pc[k] = ((Math.round(12 * Math.log2(f / 440)) + 69) % 12 + 12) % 12; }
  for (let o = 0; o + K <= x.length; o += KH * 2) {
    for (let i = 0; i < K; i++) { kre[i] = x[o + i] * kwin[i]; kim[i] = 0; }
    fft(kre, kim);
    for (let k = 1; k < K / 2; k++) if (pc[k] >= 0) chroma[pc[k]] += Math.sqrt(kre[k] * kre[k] + kim[k] * kim[k]);
  }
  const key = keyOf(chroma);
  const r2 = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    bpm, pulse: r2(pulse, 3), energyDb: r2(energyDb), dynamics: r2(dynamics), centroid: Math.round(centroid), zcr: r2(zMean, 4),
    speech: r2(speech, 3), density: r2(density), bands: bandFrac.map(v => r2(v, 4)), key: key.key, keyConfidence: key.confidence,
    seconds: r2(x.length / sr, 1)
  };
}

/** Egenskaperna som vektor (Float32Array, DIMS-ordning), varje dimension ungefär 0–1. */
export function toVector(f) {
  const v = new Float32Array(DIMS.length);
  const lg = Math.log2;
  v[0] = f.bpm ? clamp01((lg(f.bpm) - lg(60)) / (lg(200) - lg(60))) : 0.5;
  v[1] = clamp01(f.pulse);
  v[2] = clamp01((f.energyDb + 50) / 45);
  v[3] = clamp01(f.dynamics / 30);
  v[4] = f.centroid > 0 ? clamp01((lg(f.centroid) - lg(150)) / (lg(3000) - lg(150))) : 0;
  v[5] = clamp01(f.zcr * 5);
  v[6] = clamp01(f.speech);
  v[7] = clamp01(f.density / 8);
  for (let i = 0; i < BANDS; i++) v[8 + i] = Math.sqrt(clamp01(f.bands[i] || 0));
  return v;
}
/** Energi 0–100 (för visning och smarta spellistor) ur vektorn. */
export const energyPct = (v) => Math.round(v[DIM.energy] * 100);
