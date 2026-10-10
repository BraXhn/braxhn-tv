// Automatisk detektering av intro och eftertexter.
// Varje avsnitts ljud omvandlas till ett fingeravtryck (Haitsma–Kalker-liknande: 32 bitar per 46 ms
// som beskriver hur energin i 33 frekvensband ändras). Avsnitt i samma säsong jämförs parvis och
// den längsta gemensamma ljudsekvensen i början = intro, i slutet = eftertexter.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { all, run, tx, CACHE, getSetting } from './db.js';

const SR = 5512, FRAME = 2048, HOP = 256;
const FPS = SR / HOP;                       // fingeravtryck per sekund (~21,5)
const INTRO_WIN = 600, END_WIN = 420;       // sekunder som analyseras i början/slutet
const MIN_LEN = 12, MAX_INTRO = 200;        // sekunder
const BER_MAX = 0.30, SMOOTH = 16;          // bitfelsandel och utjämningsfönster (bildrutor)

// ---------- FFT (radix-2, in-place) ----------
const N = FRAME, LOG = Math.log2(N);
const rev = new Uint32Array(N);
for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < LOG; b++) r |= ((i >> b) & 1) << (LOG - 1 - b); rev[i] = r; }
const cosT = new Float64Array(N / 2), sinT = new Float64Array(N / 2);
for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(-2 * Math.PI * i / N); sinT[i] = Math.sin(-2 * Math.PI * i / N); }
const win = new Float64Array(N);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
function fft(re, im) {
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * cosT[k] - im[b] * sinT[k], ti = re[b] * sinT[k] + im[b] * cosT[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}
// 34 logaritmiskt fördelade bandgränser mellan 300 och 2000 Hz
const edges = Array.from({ length: 34 }, (_, i) => Math.round(300 * Math.pow(2000 / 300, i / 33) / (SR / N)));

// Fingeravtrycket beräknas i bitar (FP_CHUNK bildrutor åt gången) så att den asynkrona varianten
// kan släppa fram andra förfrågningar mellan bitarna – ett avsnitt tar flera sekunder CPU-tid.
const FP_CHUNK = 64;
function fpState(pcm) {
  const frames = Math.max(0, Math.floor((pcm.length - N) / HOP) + 1);
  return { pcm, frames, hashes: new Uint32Array(frames), silent: new Uint8Array(frames),
    re: new Float64Array(N), im: new Float64Array(N), E: new Float64Array(33), P: new Float64Array(33) };
}
function fpRange(st, f0, f1) {
  const { pcm, hashes, silent, re, im, E, P } = st;
  for (let f = f0; f < f1; f++) {
    const o = f * HOP;
    let energy = 0;
    for (let i = 0; i < N; i++) { const x = pcm[o + i] / 32768; energy += x * x; re[i] = x * win[i]; im[i] = 0; }
    fft(re, im);
    for (let m = 0; m < 33; m++) {
      let s = 0;
      for (let k = edges[m]; k < edges[m + 1]; k++) s += re[k] * re[k] + im[k] * im[k];
      E[m] = s;
    }
    let h = 0;
    if (f > 0) for (let m = 0; m < 32; m++) if ((E[m] - E[m + 1]) - (P[m] - P[m + 1]) > 0) h |= (1 << m);
    hashes[f] = h >>> 0;
    silent[f] = energy / N < 1e-6 ? 1 : 0; // ca −60 dBFS
    P.set(E);
  }
}
export function fingerprint(pcm) {
  const st = fpState(pcm);
  fpRange(st, 0, st.frames);
  return { hashes: st.hashes, silent: st.silent };
}
/** Samma som fingerprint() men blockerar aldrig händelseloopen mer än några millisekunder åt gången */
export async function fingerprintAsync(pcm) {
  const st = fpState(pcm);
  for (let f = 0; f < st.frames; f += FP_CHUNK) {
    fpRange(st, f, Math.min(st.frames, f + FP_CHUNK));
    await new Promise(setImmediate);
  }
  return { hashes: st.hashes, silent: st.silent };
}

const PCM_TIMEOUT = 10 * 60e3;
function readPcm(file, start, dur) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-ss', String(Math.max(0, start)), '-t', String(dur),
      '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let err = '', timedOut = false, settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, PCM_TIMEOUT);
    p.on('error', (e) => done(reject, new Error('Kunde inte starta ffmpeg: ' + e.message)));
    p.stdout.on('data', c => chunks.push(c));
    p.stderr.on('data', c => { err = (err + c).slice(-4000); });
    p.on('close', code => {
      if (timedOut) return done(reject, new Error('ffmpeg tog för lång tid (över 10 min)'));
      if (code !== 0) return done(reject, new Error(err.trim() || 'ffmpeg ' + code));
      const b = Buffer.concat(chunks);
      done(resolve, new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2)));
    });
  });
}

const fpFile = (it, part) => path.join(CACHE, 'fingerprints', `${it.id}-${it.mtime}-${part}.bin`);
async function fpFor(it, part) {
  const f = fpFile(it, part);
  try {
    const b = fs.readFileSync(f);
    const n = b.readUInt32LE(0);
    return { hashes: new Uint32Array(b.buffer.slice(b.byteOffset + 4, b.byteOffset + 4 + n * 4)), silent: new Uint8Array(b.buffer.slice(b.byteOffset + 4 + n * 4, b.byteOffset + 4 + n * 5)), offset: b.readDoubleLE(4 + n * 5) };
  } catch {}
  const dur = it.duration || 0;
  // i = början, e = slutet, f = hela avsnittet (för att hitta "tidigare i serien")
  const len = part === 'i' ? Math.min(INTRO_WIN, dur * 0.45) : part === 'f' ? dur : Math.min(END_WIN, dur * 0.35);
  const offset = part === 'e' ? Math.max(0, dur - len) : 0;
  const fp = await fingerprintAsync(await readPcm(it.path, offset, len));
  const n = fp.hashes.length, out = Buffer.alloc(4 + n * 5 + 8);
  out.writeUInt32LE(n, 0);
  Buffer.from(fp.hashes.buffer).copy(out, 4);
  Buffer.from(fp.silent.buffer).copy(out, 4 + n * 4);
  out.writeDoubleLE(offset, 4 + n * 5);
  for (const old of fs.readdirSync(path.dirname(f))) if (old.startsWith(`${it.id}-`) && old.endsWith(`-${part}.bin`)) fs.rmSync(path.join(path.dirname(f), old), { force: true });
  fs.writeFileSync(f, out);
  return { ...fp, offset };
}

function popcount(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }

// Längsta sekvens där A[i] ≈ B[i+d]
function bestRun(A, B, d) {
  const lo = Math.max(0, -d), hi = Math.min(A.hashes.length, B.hashes.length - d);
  if (hi - lo < MIN_LEN * FPS) return null;
  const e = new Float32Array(hi - lo);
  for (let i = lo; i < hi; i++) e[i - lo] = (A.silent[i] || B.silent[i + d]) ? 16 : popcount(A.hashes[i] ^ B.hashes[i + d]);
  let best = null, runStart = -1, sum = 0;
  for (let k = 0; k < e.length; k++) {
    sum += e[k]; if (k >= SMOOTH) sum -= e[k - SMOOTH];
    const ok = k >= SMOOTH - 1 && sum / Math.min(k + 1, SMOOTH) / 32 < BER_MAX;
    if (ok && runStart < 0) runStart = k - SMOOTH + 1;
    if ((!ok || k === e.length - 1) && runStart >= 0) {
      const end = ok ? k : k - 1;
      if (!best || end - runStart > best.end - best.start) best = { start: runStart, end };
      runStart = -1;
    }
  }
  if (!best) return null;
  const a0 = lo + best.start, a1 = lo + best.end;
  return { a0, a1, b0: a0 + d, b1: a1 + d, len: (a1 - a0) / FPS };
}

export function compare(A, B) {
  // Rösta på tidsförskjutning via exakta träffar på 16-bitarshalvor
  const idx = [new Map(), new Map()];
  for (let j = 0; j < B.hashes.length; j++) {
    if (B.silent[j]) continue;
    const h = B.hashes[j];
    for (const [t, v] of [[0, h & 0xffff], [1, h >>> 16]]) {
      let l = idx[t].get(v); if (!l) idx[t].set(v, l = []);
      if (l.length < 64) l.push(j);
    }
  }
  const votes = new Map();
  for (let i = 0; i < A.hashes.length; i++) {
    if (A.silent[i]) continue;
    const h = A.hashes[i];
    for (const [t, v] of [[0, h & 0xffff], [1, h >>> 16]]) {
      const l = idx[t].get(v); if (!l || l.length >= 64) continue;
      for (const j of l) { const d = j - i; votes.set(d, (votes.get(d) || 0) + 1); }
    }
  }
  const cands = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  let best = null;
  for (const [d, n] of cands) {
    if (n < 8) break;
    const r = bestRun(A, B, d);
    if (r && r.len >= MIN_LEN && (!best || r.len > best.len)) best = r;
  }
  return best;
}

const toSec = (fp, frame) => fp.offset + frame / FPS;

async function season(eps, status) {
  const res = new Map(eps.map(e => [e.id, { intro: null, credits: null }]));
  const fps = new Map();
  const load = async (e, part) => {
    const k = e.id + part;
    if (!fps.has(k)) { try { fps.set(k, await fpFor(e, part)); } catch (er) { console.warn('[intro]', e.path, er.message); fps.set(k, null); } }
    return fps.get(k);
  };
  const tryPair = async (a, b) => {
    for (const part of ['i', 'e']) {
      const A = await load(a, part), B = await load(b, part);
      if (!A || !B) continue;
      const r = compare(A, B);
      await new Promise(setImmediate); // släpp fram andra förfrågningar mellan jämförelserna
      if (!r) continue;
      for (const [e, fp, f0, f1] of [[a, A, r.a0, r.a1], [b, B, r.b0, r.b1]]) {
        const s = toSec(fp, f0), t = toSec(fp, f1), cur = res.get(e.id);
        if (part === 'i') {
          if (r.len <= MAX_INTRO && s < (e.duration || 0) * 0.4 && (!cur.intro || r.len > cur.intro.len)) cur.intro = { s, t, len: r.len };
        } else if (s > (e.duration || 0) * 0.6 && (!cur.credits || s < cur.credits.s)) cur.credits = { s, len: r.len };
      }
    }
  };
  for (let k = 0; k < eps.length - 1; k++) { if (status) status.done++; await tryPair(eps[k], eps[k + 1]); }
  // Avsnitt utan träff: försök med avsnittet två steg bort
  for (let k = 0; k < eps.length; k++) {
    const r = res.get(eps[k].id);
    if ((!r.intro || !r.credits) && eps[k + 2]) await tryPair(eps[k], eps[k + 2]);
  }
  tx(() => {
    for (const e of eps) {
      const r = res.get(e.id);
      const is = r.intro ? Math.max(0, r.intro.s < 3 ? 0 : r.intro.s) : null;
      run('UPDATE items SET intro_start=?, intro_end=?, credits_start=?, markers_done=1 WHERE id=?',
        is, r.intro ? r.intro.t : null, r.credits ? r.credits.s : null, e.id);
    }
  });
  // "Tidigare i serien": klipp i början av avsnitt N som finns någonstans i avsnitt N-1
  if (getSetting('detect_recap', '1') === '1') {
    for (let k = 1; k < eps.length; k++) {
      try {
        const A = await load(eps[k], 'i'), P = await load(eps[k - 1], 'f');
        if (!A || !P) continue;
        const r = res.get(eps[k].id);
        const rc = findRecap(A, P, r.intro ? [r.intro.s, r.intro.t] : null);
        await new Promise(setImmediate);
        run('UPDATE items SET recap_start=?, recap_end=? WHERE id=?', rc ? rc[0] : null, rc ? rc[1] : null, eps[k].id);
      } catch (er) { console.warn('[recap]', eps[k].path, er.message); }
    }
  }
}

/**
 * Letar korta fönster (2 s) i början av avsnittet som matchar var som helst i föregående avsnitt.
 * Fönster som överlappar introt räknas bort (introt finns ju i alla avsnitt).
 */
export function findRecap(A, P, intro, maxStart = 420) {
  const W = Math.round(2 * FPS), STEP = Math.round(W / 2);
  const idx = new Map();
  for (let j = 0; j < P.hashes.length; j++) {
    if (P.silent[j]) continue;
    const v = P.hashes[j] >>> 16;
    let l = idx.get(v); if (!l) idx.set(v, l = []);
    if (l.length < 32) l.push(j);
  }
  const limit = Math.min(A.hashes.length - W, Math.round(maxStart * FPS));
  const hits = [];
  for (let i = 0; i < limit; i += STEP) {
    const t0 = toSec(A, i), t1 = toSec(A, i + W);
    if (intro && t1 > intro[0] - 1 && t0 < intro[1] + 1) continue;
    const votes = new Map();
    for (let k = i; k < i + W; k++) {
      if (A.silent[k]) continue;
      const l = idx.get(A.hashes[k] >>> 16); if (!l || l.length >= 32) continue;
      for (const j of l) { const d = j - k; votes.set(d, (votes.get(d) || 0) + 1); }
    }
    let best = null, bn = 0;
    for (const [d, n] of votes) if (n > bn) { bn = n; best = d; }
    if (best === null || bn < 3) continue;
    let err = 0, cnt = 0;
    for (let k = i; k < i + W; k++) {
      const j = k + best; if (j < 0 || j >= P.hashes.length) continue;
      err += (A.silent[k] || P.silent[j]) ? 16 : popcount(A.hashes[k] ^ P.hashes[j]); cnt++;
    }
    if (cnt > W * 0.8 && err / cnt / 32 < 0.25) hits.push([t0, t1]);
  }
  if (!hits.length) return null;
  // Slå ihop träffar med högst 8 s mellanrum; ta den första sammanhängande gruppen
  const groups = [];
  for (const h of hits) {
    const g = groups[groups.length - 1];
    if (g && h[0] - g[1] <= 8) g[1] = Math.max(g[1], h[1]); else groups.push([h[0], h[1]]);
  }
  const g = groups.find(x => x[1] - x[0] >= 12);
  if (!g) return null;
  return [g[0] < 4 ? 0 : g[0], g[1]];
}

export async function detectMarkers(lib, status) {
  const groups = all(`SELECT parent_id, season, SUM(markers_done=0) AS todo, COUNT(*) AS n FROM items
    WHERE library_id=? AND kind='episode' AND duration > 120 GROUP BY parent_id, season HAVING todo > 0`, lib.id);
  if (status) { status.done = 0; status.total = groups.reduce((s, g) => s + Math.max(0, g.n - 1), 0); }
  for (const g of groups) {
    const eps = all(`SELECT id, path, mtime, duration FROM items WHERE parent_id=? AND season=? AND duration > 120 ORDER BY episode`, g.parent_id, g.season);
    if (eps.length < 2) { run('UPDATE items SET markers_done=1 WHERE parent_id=? AND season=?', g.parent_id, g.season); continue; }
    try { await season(eps, status); } catch (e) { console.warn('[intro] säsong misslyckades', e.message); }
  }
}
