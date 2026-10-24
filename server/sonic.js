// Ljudanalys och låtradio (som Plexamps Sonic Analysis, men lokalt och utan konto):
//   – bakgrundsanalys: ffmpeg avkodar upp till 120 s från mitten av spåret till mono-PCM i 11 025 Hz, egenskaperna
//     räknas i en egen tråd (sonic-worker.js → sonic-dsp.js) och sparas som en vektor i track_sonic (db.js)
//   – likhet: vektorerna standardiseras mot biblioteket och viktas; avståndet får en liten bonus för samma
//     artist/album/genre/era. Alla vektorer ligger i minnet som Float32Array – en sökning över 100 000 spår tar
//     några millisekunder (rak genomgång med tidigt avbrott, inget index behövs)
//   – låtradio (oändlig kö med gradvis drift och artistblandning), ljudresa (från en låt till en annan),
//     stämningsstationer (regioner i vektorrymden), liknande låtar och liknande artister.
// Analysen körs med lägsta CPU- och diskprioritet, en åt gången som standard, och pausar medan video omkodas.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { get, all, run, getSetting, setSetting } from './db.js';
import { TRACK_SQL, shapeTrack } from './music.js';
import { libFilter } from './perms.js';
import * as jobs from './jobs.js';
import { analyze, toVector, energyPct, SR, VERSION, DIMS, DIM } from './sonic-dsp.js';

export { VERSION, DIMS };
const D = DIMS.length;

// ---------------- inställningar ----------------
const envOff = () => process.env.MUSIC_SONIC === '0';
export const seconds = () => Math.max(20, Math.min(120, parseInt(process.env.MUSIC_SONIC_SECONDS || '120') || 120));
export const enabled = () => !envOff() && getSetting('sonic_enabled', '1') === '1';
export const concurrency = () => Math.max(1, Math.min(4, parseInt(getSetting('sonic_concurrency', '1')) || 1));
/** Administratörens inställningar. Kastar Error med svensk text vid ogiltiga värden. */
export function configure(b = {}) {
  if (b.enabled != null) setSetting('sonic_enabled', b.enabled ? '1' : '0');
  if (b.concurrency != null) {
    const c = parseInt(b.concurrency);
    if (!(c >= 1 && c <= 4)) throw new Error('Samtidiga analyser måste vara 1–4');
    setSetting('sonic_concurrency', String(c));
  }
  if (b.reanalyze) { run('DELETE FROM track_sonic'); invalidate(); }
  if (enabled()) kick(500);
  return status();
}

// ---------------- avkodning ----------------
let ionice = null;
const hasIonice = () => {
  if (ionice == null) ionice = String(process.env.PATH || '').split(path.delimiter).some(d => { try { return fs.statSync(path.join(d, 'ionice')).isFile(); } catch { return false; } });
  return ionice;
};
/** Lägsta CPU-prioritet (nice 19) och, om ionice finns, diskprioritet "idle" – strömning går alltid före. */
function lowPriority(pid) {
  if (!pid) return;
  try { os.setPriority(pid, 19); } catch {}
  if (hasIonice()) { try { spawn('ionice', ['-c', '3', '-p', String(pid)], { stdio: 'ignore' }).on('error', () => {}); } catch {} }
}
/** Var utdraget börjar: mitten av låten minus halva längden (början för korta spår). */
export const excerptStart = (duration, secs = seconds()) => duration > secs ? Math.max(0, duration / 2 - secs / 2) : 0;
/** Avkodar ett utdrag till mono Float32-PCM i 11 025 Hz med ffmpeg (ingen fil skrivs). */
export function decodePcm(file, { start = 0, secs = seconds(), timeoutMs = 5 * 60e3 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
      ...(start > 0 ? ['-ss', start.toFixed(2)] : []), '-i', file, '-t', String(secs), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SR),
      '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    lowPriority(p.pid);
    const max = Math.ceil(secs * SR) * 4, chunks = [];
    let size = 0, err = '';
    p.stdout.on('data', (d) => { if (size < max) { chunks.push(d); size += d.length; } });
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', () => {
      clearTimeout(timer);
      const n = Math.floor(Math.min(size, max) / 4);
      if (!n) return reject(new Error(err.trim().split('\n').pop() || 'Ingen ljuddata'));
      const ab = new ArrayBuffer(n * 4);
      new Uint8Array(ab).set(Buffer.concat(chunks, size).subarray(0, n * 4));
      resolve(new Float32Array(ab));
    });
  });
}

// ---------------- trådar för själva analysen ----------------
// En tråd per samtidig analys; stängs när den varit sysslolös en halv minut. Går tråden inte att starta räknas
// det i huvudtråden (långsammare för servern, men fungerar).
const pool = [];
let reqSeq = 0;
function makeWorker() {
  const w = new Worker(new URL('./sonic-worker.js', import.meta.url));
  const slot = { w, pending: new Map(), idle: null };
  w.on('message', (m) => { const p = slot.pending.get(m.id); if (!p) return; slot.pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m); if (!slot.pending.size) w.unref(); idleLater(slot); });
  const fail = (e) => { for (const p of slot.pending.values()) p.reject(e instanceof Error ? e : new Error('Analystråden avslutades')); slot.pending.clear(); const i = pool.indexOf(slot); if (i >= 0) pool.splice(i, 1); };
  w.on('error', fail);
  w.on('exit', fail);
  w.unref();
  pool.push(slot);
  return slot;
}
function idleLater(slot) {
  clearTimeout(slot.idle);
  slot.idle = setTimeout(() => { if (!slot.pending.size) slot.w.terminate().catch(() => {}); }, 30e3);
  slot.idle.unref?.();
}
function analyzeInWorker(pcm) {
  let slot = pool.find(s => !s.pending.size);
  if (!slot && pool.length < concurrency()) { try { slot = makeWorker(); } catch { slot = null; } }
  slot = slot || pool.slice().sort((a, b) => a.pending.size - b.pending.size)[0];
  if (!slot) { const t0 = performance.now(); return Promise.resolve({ features: analyze(pcm, SR), ms: Math.round(performance.now() - t0) }); }
  clearTimeout(slot.idle);
  slot.w.ref(); // håller processen vid liv medan en analys pågår (sysslolös tråd hindrar inte avslut)
  const id = ++reqSeq;
  return new Promise((resolve, reject) => {
    slot.pending.set(id, { resolve, reject });
    slot.w.postMessage({ id, pcm: pcm.buffer }, [pcm.buffer]);
  });
}

/** Analyserar ett spår och sparar resultatet. Returnerar { ok, ms, decodeMs, analyzeMs, features }. */
export async function analyzeTrack(t) {
  const t0 = performance.now();
  let features = null, decodeMs = 0, analyzeMs = 0, error = null;
  try {
    const pcm = await decodePcm(t.path, { start: excerptStart(t.duration || 0) });
    decodeMs = Math.round(performance.now() - t0);
    const r = await analyzeInWorker(pcm);
    features = r.features; analyzeMs = r.ms;
    if (!features) error = 'För kort eller tyst';
  } catch (e) { error = e.message; }
  const ms = Math.round(performance.now() - t0);
  if (features) {
    const v = toVector(features);
    run(`INSERT INTO track_sonic(track_id,ver,mtime,analyzed,ok,ms,bpm,energy,speech,key,vec) VALUES(?,?,?,?,1,?,?,?,?,?,?)
      ON CONFLICT(track_id) DO UPDATE SET ver=excluded.ver, mtime=excluded.mtime, analyzed=excluded.analyzed, ok=1, ms=excluded.ms,
      bpm=excluded.bpm, energy=excluded.energy, speech=excluded.speech, key=excluded.key, vec=excluded.vec`,
      t.id, VERSION, t.mtime ?? null, Math.floor(Date.now() / 1000), ms, features.bpm, energyPct(v), features.speech, features.key,
      new Uint8Array(v.buffer));
  } else {
    run(`INSERT INTO track_sonic(track_id,ver,mtime,analyzed,ok,ms) VALUES(?,?,?,?,0,?)
      ON CONFLICT(track_id) DO UPDATE SET ver=excluded.ver, mtime=excluded.mtime, analyzed=excluded.analyzed, ok=0, ms=excluded.ms,
      bpm=NULL, energy=NULL, speech=NULL, key=NULL, vec=NULL`, t.id, VERSION, t.mtime ?? null, Math.floor(Date.now() / 1000), ms);
  }
  dirty = true;
  return { ok: !!features, ms, decodeMs, analyzeMs, features, error };
}

// ---------------- bakgrundsjobbet ----------------
let busyCheck = () => false;
/** app.js kopplar in strömningens belastning: medan den säger "upptagen" väntar analysen. */
export function setBusyCheck(fn) { busyCheck = fn; }
const S = { running: false, paused: false, done: 0, failed: 0, lastMs: null, avgMs: null, avgDecodeMs: null, avgAnalyzeMs: null, current: [], error: null, started: null };
const PENDING = `FROM tracks t LEFT JOIN track_sonic s ON s.track_id=t.id WHERE s.track_id IS NULL OR s.ver<>? OR s.mtime IS NOT t.mtime`;
const sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
const ema = (old, v) => old == null ? v : Math.round(old * 0.9 + v * 0.1);
let again = false, timer = null;
async function work() {
  if (S.running) { again = true; return; }
  if (!enabled()) return;
  S.running = true; S.started = Date.now(); S.done = 0; S.failed = 0; S.error = null;
  const job = jobs.track('analysis', 'Ljudanalys av musik', { detail: 'tempo, energi och klang' });
  try {
    for (;;) {
      again = false;
      while (busyCheck() && enabled()) { S.paused = true; job.update(S.done, null, 'pausad – strömning pågår'); await sleep(15e3); }
      S.paused = false;
      if (!enabled()) break;
      const c = concurrency();
      // Spridd ordning (inte bara nyast först): stationer och radio blir användbara tidigt i hela biblioteket
      const rows = all(`SELECT t.id, t.path, t.duration, t.mtime, t.title ${PENDING} ORDER BY (t.id * 2654435761) % 1000003, t.id LIMIT ?`, VERSION, c * 4);
      if (!rows.length) { if (again) continue; break; }
      const left = get(`SELECT COUNT(*) AS n ${PENDING}`, VERSION).n;
      job.update(S.done, S.done + left, '');
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(c, rows.length) }, async () => {
        while (i < rows.length && enabled()) {
          const t = rows[i++];
          S.current.push(t.title);
          try {
            const r = await analyzeTrack(t);
            S.lastMs = r.ms; S.avgMs = ema(S.avgMs, r.ms); S.avgDecodeMs = ema(S.avgDecodeMs, r.decodeMs); S.avgAnalyzeMs = ema(S.avgAnalyzeMs, r.analyzeMs);
            if (r.ok) S.done++; else S.failed++;
          } finally { S.current.splice(S.current.indexOf(t.title), 1); }
          job.update(S.done + S.failed, null, `${S.avgMs ?? '–'} ms per spår`);
          if (busyCheck()) break;
        }
      }));
    }
    if (S.done) console.log(`[ljudanalys] ${S.done} spår analyserade (i snitt ${S.avgMs} ms per spår: avkodning ${S.avgDecodeMs} ms, analys ${S.avgAnalyzeMs} ms)${S.failed ? `, ${S.failed} gick inte att läsa` : ''}`);
  } catch (e) { S.error = e.message; console.warn('[ljudanalys]', e.message); }
  finally { S.running = false; S.paused = false; job.end(); }
}
/** Startar bakgrundsjobbet om en stund (efter skanning och vid start – fortsätter där det slutade). */
export function kick(ms = 5000) {
  if (!enabled()) return;
  if (S.running) { again = true; return; }
  if (timer) return;
  timer = setTimeout(() => { timer = null; work(); }, ms);
  timer.unref?.();
}
/** För tester: kör jobbet tills inget återstår. */
export async function runAll() { clearTimeout(timer); timer = null; await work(); while (S.running) await sleep(20); }

/** Förlopp för administrationen (x av y spår analyserade). */
export function status() {
  const c = get(`SELECT (SELECT COUNT(*) FROM tracks) AS total,
    (SELECT COUNT(*) FROM track_sonic s JOIN tracks t ON t.id=s.track_id WHERE s.ver=? AND s.ok=1 AND s.mtime IS t.mtime) AS analyzed,
    (SELECT COUNT(*) FROM track_sonic s JOIN tracks t ON t.id=s.track_id WHERE s.ver=? AND s.ok=0 AND s.mtime IS t.mtime) AS failed,
    (SELECT AVG(ms) FROM track_sonic WHERE ver=? AND ok=1) AS avg_ms`, VERSION, VERSION, VERSION);
  return { enabled: enabled(), envDisabled: envOff(), concurrency: concurrency(), seconds: seconds(), version: VERSION,
    total: c.total, analyzed: c.analyzed, failed: c.failed, pending: Math.max(0, c.total - c.analyzed - c.failed),
    running: S.running, paused: S.paused, current: [...S.current], avgMs: c.avg_ms == null ? null : Math.round(c.avg_ms),
    session: { done: S.done, failed: S.failed, lastMs: S.lastMs, avgMs: S.avgMs, avgDecodeMs: S.avgDecodeMs, avgAnalyzeMs: S.avgAnalyzeMs },
    lowPriority: { nice: true, ionice: hasIonice() }, error: S.error };
}

// ---------------- vektorerna i minnet ----------------
// Vikter per dimension efter standardisering: tempo, energi och klang betyder mest; de tolv banden tillsammans
// ungefär som två egenskaper.
const WEIGHT = new Float32Array(D).fill(0.45);
Object.entries({ tempo: 1.2, pulse: 0.6, energy: 1.3, dynamics: 0.7, brightness: 1.1, zcr: 0.5, speech: 1.0, density: 0.8 }).forEach(([k, w]) => { WEIGHT[DIM[k]] = w; });
const WNORM = Math.sqrt(WEIGHT.reduce((s, w) => s + w * w, 0));
// Metadata ger en liten rabatt på avståndet (multiplikativ, högst 25 %): ett närmare spår av en annan artist vinner ändå
const BONUS = { artist: 0.10, album: 0.05, genre: 0.07, year: 0.03 };

let IDX = null, dirty = true, built = 0;
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h | 0; };
const normTitle = (s) => String(s || '').toLowerCase().replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Bygger (eller återanvänder) indexet. Räknas om när nya analyser finns, högst var 20:e sekund. */
export function index(force = false) {
  if (IDX && !force && (!dirty || Date.now() - built < 20e3)) return IDX;
  const rows = all(`SELECT s.track_id, s.vec, t.library_id, t.artist_id, t.album_id, t.title, al.artist_id AS album_artist, al.genre, al.year
    FROM track_sonic s JOIN tracks t ON t.id=s.track_id LEFT JOIN albums al ON al.id=t.album_id
    WHERE s.ok=1 AND s.ver=? AND s.vec IS NOT NULL AND s.mtime IS t.mtime`, VERSION);
  const n = rows.length;
  const I = { n, ids: new Int32Array(n), raw: new Float32Array(n * D), z: new Float32Array(n * D), lib: new Int32Array(n), artist: new Int32Array(n),
    albumArtist: new Int32Array(n), album: new Int32Array(n), genre: new Int32Array(n), year: new Int16Array(n), tkey: new Int32Array(n), pos: new Map(),
    mean: new Float32Array(D), std: new Float32Array(D) };
  const genres = new Map();
  rows.forEach((r, i) => {
    const b = r.vec, v = new Float32Array(b.buffer, b.byteOffset, Math.min(D, b.byteLength >> 2));
    I.raw.set(v.length === D ? v : Float32Array.from({ length: D }, (_, k) => v[k] ?? 0), i * D);
    I.ids[i] = r.track_id; I.pos.set(r.track_id, i);
    I.lib[i] = r.library_id; I.artist[i] = r.artist_id || 0; I.albumArtist[i] = r.album_artist || 0; I.album[i] = r.album_id || 0;
    const g = r.genre ? String(r.genre).toLowerCase().trim() : '';
    if (g && !genres.has(g)) genres.set(g, genres.size + 1);
    I.genre[i] = g ? genres.get(g) : 0; I.year[i] = r.year || 0;
    I.tkey[i] = hashStr(`${r.artist_id || 0}:${normTitle(r.title)}`);
  });
  for (let k = 0; k < D; k++) {
    let s = 0, q = 0;
    for (let i = 0; i < n; i++) { const x = I.raw[i * D + k]; s += x; q += x * x; }
    const m = n ? s / n : 0;
    I.mean[k] = m;
    // Undre gräns för spridningen: i ett litet bibliotek blåses annars små skillnader upp
    I.std[k] = Math.max(0.05, Math.sqrt(Math.max(0, n ? q / n - m * m : 0)));
  }
  for (let i = 0; i < n; i++) for (let k = 0; k < D; k++) I.z[i * D + k] = (I.raw[i * D + k] - I.mean[k]) / I.std[k] * WEIGHT[k];
  IDX = I; dirty = false; built = Date.now();
  return I;
}
/** Nollställer indexet (tester, efter att spår tagits bort). */
export function invalidate() { dirty = true; IDX = null; }
/** Standardiserad och viktad vektor för en rå vektor (DIMS-ordning). */
export function zOf(raw, I = index()) { const z = new Float32Array(D); for (let k = 0; k < D; k++) z[k] = (raw[k] - I.mean[k]) / I.std[k] * WEIGHT[k]; return z; }
const zAt = (I, i) => I.z.subarray(i * D, i * D + D);
/** Avstånd mellan två standardiserade vektorer (normaliserat: ~0 = samma, ~1,4 = två slumpvisa spår). */
export function dist(a, b) { let s = 0; for (let k = 0; k < D; k++) { const d = a[k] - b[k]; s += d * d; } return Math.sqrt(s) / WNORM; }

/**
 * k närmaste spår till q (standardiserad vektor). Rak genomgång med tidigt avbrott när delsumman redan är sämre
 * än den k:te bästa. ref = indexplats för metadatabonus (samma artist/album/genre/år), skip(i) = hoppa över.
 * Returnerar [{ i, d }] sorterat på avstånd.
 */
export function nearest(q, { k = 20, lib = null, ref = -1, skip = null, I = index() } = {}) {
  const best = [];
  let worst = Infinity;
  const W2 = WNORM * WNORM, z = I.z, maxBonus = ref >= 0 ? 1 - (BONUS.artist + BONUS.album + BONUS.genre + BONUS.year) : 1;
  for (let i = 0; i < I.n; i++) {
    if (lib != null && I.lib[i] !== lib) continue;
    // Tidigt avbrott: även med största möjliga bonus kan spåret inte slå det k:te bästa
    const lim = worst === Infinity ? Infinity : (worst / maxBonus) ** 2 * W2;
    let s = 0;
    const o = i * D;
    for (let j = 0; j < D && s <= lim; j++) { const d = z[o + j] - q[j]; s += d * d; }
    if (s > lim) continue;
    if (skip && skip(i)) continue;
    let d = Math.sqrt(s) / WNORM;
    if (ref >= 0) {
      let b = 0;
      if (I.artist[i] && (I.artist[i] === I.artist[ref] || I.albumArtist[i] === I.albumArtist[ref])) b += BONUS.artist;
      if (I.album[i] && I.album[i] === I.album[ref]) b += BONUS.album;
      if (I.genre[i] && I.genre[i] === I.genre[ref]) b += BONUS.genre;
      if (I.year[i] && I.year[ref] && Math.abs(I.year[i] - I.year[ref]) <= 3) b += BONUS.year;
      d *= 1 - b;
    }
    if (best.length < k) { best.push({ i, d }); if (best.length === k) { best.sort((a, b) => a.d - b.d); worst = best[k - 1].d; } }
    else if (d < worst) {
      let p = k - 1; while (p > 0 && best[p - 1].d > d) { best[p] = best[p - 1]; p--; }
      best[p] = { i, d }; worst = best[k - 1].d;
    }
  }
  return best.length < k ? best.sort((a, b) => a.d - b.d) : best;
}

// ---------------- slump med frö (stabil ordning i stationerna, så att bilens kö stämmer med listan) ----------------
export function rng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Väljer bland kandidaterna (sorterade på avstånd) med större chans för de närmaste. */
function pick(cands, rnd, top = 6) {
  const c = cands.slice(0, top), d0 = c[0].d, tau = 0.15 * d0 + 0.03;
  const w = c.map(x => Math.exp(-(x.d - d0) / tau));
  let r = rnd() * w.reduce((s, x) => s + x, 0);
  for (let j = 0; j < c.length; j++) { r -= w[j]; if (r <= 0) return c[j]; }
  return c[c.length - 1];
}
const mean = (I, list) => { const m = new Float32Array(D); for (const i of list) for (let k = 0; k < D; k++) m[k] += I.z[i * D + k] / list.length; return m; };
const mix = (a, b, wb) => { const m = new Float32Array(D); for (let k = 0; k < D; k++) m[k] = a[k] * (1 - wb) + b[k] * wb; return m; };

// ---------------- spårlistor i API:ts format ----------------
function shapeIds(ids, uid) {
  if (!ids.length) return [];
  const rows = new Map();
  // Bara spår i bibliotek som användaren får se (rättigheter per användare) – gäller alla stationer, radio och resor
  const lf = libFilter(uid, 't.library_id');
  for (let o = 0; o < ids.length; o += 500) {
    const part = ids.slice(o, o + 500);
    for (const r of all(`${TRACK_SQL.replace('SELECT ', 'SELECT s.bpm AS s_bpm, s.energy AS s_energy, s.key AS s_key, ')} LEFT JOIN track_sonic s ON s.track_id=t.id AND s.ok=1
      WHERE t.id IN (${part.map(() => '?').join(',')})${lf.sql}`, ...part, ...lf.params)) rows.set(r.id, r);
  }
  const favs = new Set(all('SELECT track_id FROM favorites WHERE user_id=?', uid).map(r => r.track_id));
  // Fälten är desamma som i resten av musik-API:t; bpm/energy/key är tillägg (null om spåret inte analyserats)
  return ids.map(id => rows.get(id)).filter(Boolean).map(r => ({ ...shapeTrack(r, favs), bpm: r.s_bpm ?? null, energy: r.s_energy ?? null, key: r.s_key ?? null }));
}
/** Ljudprofil för ett spår (visas i webben), null om det inte analyserats. */
export function profile(tid) {
  const r = get('SELECT bpm, energy, speech, key, ms, analyzed, vec FROM track_sonic WHERE track_id=? AND ok=1 AND ver=?', tid, VERSION);
  if (!r) return null;
  const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength >> 2);
  const pct = (k) => Math.round((v[DIM[k]] ?? 0) * 100);
  return { bpm: r.bpm, energy: r.energy, speech: Math.round((r.speech ?? 0) * 100), key: r.key, pulse: pct('pulse'), brightness: pct('brightness'),
    dynamics: pct('dynamics'), analyzed: r.analyzed, ms: r.ms };
}

// ---------------- liknande låtar och artister ----------------
/** Liknande låtar (ljud + lätt metadatabonus), högst två per artist och inga dubbletter av samma låt. */
export function similarTracks(tid, uid, { limit = 30 } = {}) {
  const I = index(), i = I.pos.get(tid);
  if (i == null) return null;
  const perArtist = new Map(), seen = new Set([I.tkey[i]]), out = [];
  for (const c of nearest(zAt(I, i), { k: limit * 4, lib: I.lib[i], ref: i, skip: (j) => j === i })) {
    if (seen.has(I.tkey[c.i])) continue;
    const a = I.artist[c.i], n = perArtist.get(a) || 0;
    if (n >= 2) continue;
    perArtist.set(a, n + 1); seen.add(I.tkey[c.i]); out.push(I.ids[c.i]);
    if (out.length >= limit) break;
  }
  return shapeIds(out, uid);
}
/** Artisternas tyngdpunkter i vektorrymden (per bibliotek), cachas med indexet. */
function artistCentroids(I, lib) {
  I.centroids ??= new Map();
  if (I.centroids.has(lib)) return I.centroids.get(lib);
  const acc = new Map();
  for (let i = 0; i < I.n; i++) {
    if (I.lib[i] !== lib) continue;
    for (const a of new Set([I.artist[i], I.albumArtist[i]])) {
      if (!a) continue;
      let e = acc.get(a); if (!e) acc.set(a, e = { sum: new Float32Array(D), n: 0 });
      for (let k = 0; k < D; k++) e.sum[k] += I.z[i * D + k];
      e.n++;
    }
  }
  const m = new Map([...acc].map(([a, e]) => [a, { v: e.sum.map(x => x / e.n), n: e.n }]));
  I.centroids.set(lib, m);
  return m;
}
/** Artister som låter som artisten (avstånd mellan tyngdpunkterna). Samma fält som artistlistan + score (0–100). */
export function similarArtists(arid, { limit = 12 } = {}) {
  const a = get('SELECT id, library_id FROM artists WHERE id=?', arid);
  if (!a) return null;
  const I = index(), C = artistCentroids(I, a.library_id), me = C.get(arid);
  if (!me) return [];
  const ranked = [...C].filter(([id]) => id !== arid).map(([id, e]) => ({ id, d: dist(me.v, e.v) * (e.n < 3 ? 1.1 : 1) })).sort((x, y) => x.d - y.d).slice(0, limit);
  if (!ranked.length) return [];
  const rows = new Map(all(`SELECT ar.id, ar.name, (SELECT COUNT(*) FROM albums x WHERE x.artist_id=ar.id) AS albums,
    (SELECT x.id FROM albums x WHERE x.artist_id=ar.id AND x.cover=1 ORDER BY x.year DESC LIMIT 1) AS cover_album
    FROM artists ar WHERE ar.id IN (${ranked.map(() => '?').join(',')})`, ...ranked.map(r => r.id)).map(r => [r.id, r]));
  return ranked.filter(r => rows.has(r.id)).map(r => ({ ...rows.get(r.id), score: Math.max(0, Math.round(100 - r.d * 60)) }));
}

// ---------------- låtradio ----------------
/** Spårens indexplatser för en radiostart: ett spår, ett album eller en artist. Returnerar { list, lib, name }. */
function seedsFor(I, { trackId, albumId, artistId }) {
  if (trackId) {
    const t = get('SELECT t.id, t.title, t.library_id FROM tracks t WHERE t.id=?', trackId);
    if (!t) return null;
    return { list: I.pos.has(t.id) ? [I.pos.get(t.id)] : [], lib: t.library_id, name: t.title, first: t.id };
  }
  if (albumId) {
    const a = get('SELECT id, title, library_id FROM albums WHERE id=?', albumId);
    if (!a) return null;
    const list = []; for (let i = 0; i < I.n; i++) if (I.album[i] === a.id) list.push(i);
    return { list, lib: a.library_id, name: a.title };
  }
  if (artistId) {
    const a = get('SELECT id, name, library_id FROM artists WHERE id=?', artistId);
    if (!a) return null;
    const list = []; for (let i = 0; i < I.n; i++) if (I.artist[i] === a.id || I.albumArtist[i] === a.id) list.push(i);
    return { list, lib: a.library_id, name: a.name };
  }
  return null;
}
/**
 * Nästa låtar i en låtradio. Kön är oändlig: klienten skickar det som redan spelats (history, senaste sist) och
 * det som redan ligger i kön (exclude) och får count nya. Reglerna:
 *   – inga dubbletter (samma spår eller samma låt på ett annat album)
 *   – ingen artist två gånger inom fyra låtar, inget album två gånger inom åtta (lättas bara om inget annat finns)
 *   – gradvis drift: målet flyttas mot det senast spelade men dras tillbaka mot starten, så radion vandrar utan att tappa stilen
 * Utan analyserade spår blir det en enkel radio på metadata (samma artist och genre), sonic = false.
 */
export function radio({ trackId = null, albumId = null, artistId = null, history = [], exclude = [], count = 25, uid, seed = Date.now() } = {}) {
  const I = index(), s = seedsFor(I, { trackId, albumId, artistId });
  if (!s) return null;
  count = Math.max(1, Math.min(100, count | 0));
  const rnd = rng(seed);
  if (!s.list.length) return { name: s.name, sonic: false, trackList: shapeIds(metaRadio(s, { trackId, albumId, artistId, history, exclude, count, rnd }), uid) };
  const used = new Set([...exclude, ...history].map(Number).filter(Number.isInteger));
  const hist = history.map(id => I.pos.get(+id)).filter(i => i != null);
  const seedVec = mean(I, s.list);
  const out = [];
  const recentA = hist.slice(-3).map(i => I.artist[i]), recentAl = hist.slice(-7).map(i => I.album[i]);
  const usedKeys = new Set(hist.map(i => I.tkey[i]));
  for (const id of used) { const i = I.pos.get(id); if (i != null) usedKeys.add(I.tkey[i]); }
  const take = (i) => { out.push(I.ids[i]); used.add(I.ids[i]); usedKeys.add(I.tkey[i]); recentA.push(I.artist[i]); recentAl.push(I.album[i]); hist.push(i); };
  // Första gången: själva startlåten först (eller den av albumets/artistens låtar som ligger närmast mitten)
  if (!hist.length) {
    const first = s.first != null ? I.pos.get(s.first) : nearest(seedVec, { k: 1, I, skip: (i) => !s.list.includes(i) || used.has(I.ids[i]) })[0]?.i;
    if (first != null && !used.has(I.ids[first])) take(first);
  }
  let target = hist.length ? mix(seedVec, mean(I, hist.slice(-3)), 0.65) : seedVec;
  for (let n = out.length; n < count; n++) {
    const ref = hist.length ? hist[hist.length - 1] : s.list[0];
    let strict = true, cands;
    for (;;) {
      const lastA = new Set(recentA.slice(-3)), lastAl = new Set(recentAl.slice(-7));
      cands = nearest(target, { k: 24, lib: s.lib, ref, I, skip: (i) => used.has(I.ids[i]) || usedKeys.has(I.tkey[i]) || (strict && (lastA.has(I.artist[i]) || lastAl.has(I.album[i]))) });
      if (cands.length || !strict) break;
      strict = false; // litet bibliotek: hellre samma artist igen än tyst
    }
    if (!cands.length) break;
    const c = pick(cands, rnd);
    take(c.i);
    // Drift mot den nya låten, med ett ankare i starten
    target = mix(mix(target, zAt(I, c.i), 0.3), seedVec, 0.12);
  }
  return { name: s.name, sonic: true, trackList: shapeIds(out, uid) };
}
/** Reserv utan analys: artistens/albumets låtar och samma genre, blandat, utan dubbletter. */
function metaRadio(s, { trackId, albumId, artistId, history, exclude, count, rnd }) {
  const used = new Set([...history, ...exclude].map(Number));
  const ref = trackId ? get('SELECT t.artist_id, al.genre FROM tracks t LEFT JOIN albums al ON al.id=t.album_id WHERE t.id=?', trackId)
    : albumId ? get('SELECT artist_id, genre FROM albums WHERE id=?', albumId) : { artist_id: artistId, genre: get('SELECT genre FROM albums WHERE artist_id=? AND genre IS NOT NULL LIMIT 1', artistId)?.genre };
  const rows = all(`SELECT t.id, t.artist_id FROM tracks t LEFT JOIN albums al ON al.id=t.album_id WHERE t.library_id=?
    AND (t.artist_id=? OR al.artist_id=? OR (al.genre IS NOT NULL AND al.genre=? COLLATE NOCASE)) LIMIT 5000`, s.lib, ref?.artist_id ?? -1, ref?.artist_id ?? -1, ref?.genre ?? '');
  const pool = rows.filter(r => !used.has(r.id));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const out = [];
  if (trackId && !used.has(trackId) && !history.length) out.push(trackId);
  const lastA = [];
  for (let pass = 0; pass < 2 && out.length < count; pass++) {
    for (const r of pool) {
      if (out.length >= count) break;
      if (out.includes(r.id) || (pass === 0 && lastA.slice(-3).includes(r.artist_id))) continue;
      out.push(r.id); lastA.push(r.artist_id);
    }
  }
  return out;
}

// ---------------- ljudresa ----------------
/**
 * Spellista som glider från en låt till en annan: målpunkter längs linjen mellan låtarna, och för varje punkt det
 * spår som ligger närmast både punkten och föregående låt. Start och mål är alltid första och sista låt.
 */
export function journey(fromId, toId, uid, { count = 20 } = {}) {
  const I = index(), a = I.pos.get(fromId), b = I.pos.get(toId);
  if (a == null || b == null) return null;
  count = Math.max(3, Math.min(60, count | 0));
  const lib = I.lib[a];
  const out = [a], used = new Set([a, b]), keys = new Set([I.tkey[a], I.tkey[b]]);
  const za = zAt(I, a), zb = zAt(I, b);
  for (let s = 1; s < count - 1; s++) {
    const target = mix(za, zb, s / (count - 1)), prev = out[out.length - 1];
    const lastA = I.artist[prev];
    let cands = nearest(target, { k: 16, lib, I, skip: (i) => used.has(i) || keys.has(I.tkey[i]) || I.artist[i] === lastA });
    if (!cands.length) cands = nearest(target, { k: 16, lib, I, skip: (i) => used.has(i) });
    if (!cands.length) break;
    const zp = zAt(I, prev);
    const best = cands.map(c => ({ i: c.i, score: c.d + 0.5 * dist(zp, zAt(I, c.i)) })).sort((x, y) => x.score - y.score)[0];
    out.push(best.i); used.add(best.i); keys.add(I.tkey[best.i]);
  }
  out.push(b);
  return { trackList: shapeIds(out.map(i => I.ids[i]), uid) };
}

// ---------------- stämningsstationer ----------------
// Regioner i den råa vektorrymden (varje dimension 0–1): mittpunkt per dimension, vikt och tak för andelen tal.
export const STATIONS = [
  { id: 'sonic-calm', name: 'Lugnt', icon: '🌙', text: 'Låg energi, mjuk klang', center: { energy: 0.3, density: 0.1, brightness: 0.3, pulse: 0.35, tempo: 0.3 }, maxSpeech: 0.5 },
  { id: 'sonic-energy', name: 'Energi', icon: '⚡', text: 'Hög energi och mycket som händer', center: { energy: 0.92, density: 0.7, brightness: 0.7, tempo: 0.65 }, maxSpeech: 0.5 },
  { id: 'sonic-focus', name: 'Fokus', icon: '🎧', text: 'Nästan inget tal, jämn energi', center: { speech: 0, dynamics: 0.15, energy: 0.55, density: 0.35 }, weights: { speech: 2, dynamics: 1.5 }, maxSpeech: 0.25 },
  { id: 'sonic-party', name: 'Fest', icon: '🎉', text: 'Högt tempo, tydlig takt', center: { tempo: 0.6, pulse: 0.9, energy: 0.85, density: 0.65 }, weights: { pulse: 1.5, tempo: 1.5 }, maxSpeech: 0.4 }
];
export const RADIO_ID = 'sonic-radio';
export const isSonicId = (id) => typeof id === 'string' && (id === RADIO_ID || STATIONS.some(s => s.id === id));
/** Lägsta antal analyserade spår i biblioteket innan stationerna visas. */
export const MIN_TRACKS = 20;
function libCount(I, lib) { let n = 0; for (let i = 0; i < I.n; i++) if (I.lib[i] === lib) n++; return n; }
/** Spår i en station: närmast regionens mitt, i en ordning som blandas om varje timme, utan samma artist tätt. */
export function stationIds(st, lib, { limit = 100, seed = 0, I = index() } = {}) {
  const dims = Object.entries(st.center).map(([k, c]) => [DIM[k], c, st.weights?.[k] ?? 1]);
  const pool = [];
  for (let i = 0; i < I.n; i++) {
    if (I.lib[i] !== lib || I.raw[i * D + DIM.speech] > st.maxSpeech) continue;
    let s = 0; for (const [k, c, w] of dims) { const d = I.raw[i * D + k] - c; s += w * d * d; }
    pool.push({ i, d: Math.sqrt(s) });
  }
  pool.sort((a, b) => a.d - b.d);
  const cand = pool.slice(0, Math.max(limit * 3, 60)), rnd = rng(seed), out = [], keys = new Set(), lastA = [];
  // Viktad slumpordning: närmare mitten = större chans att komma tidigt
  const order = cand.map(c => ({ c, r: Math.pow(rnd(), 1 / Math.exp(-c.d * 4)) })).sort((x, y) => y.r - x.r).map(x => x.c);
  for (let pass = 0; pass < 2 && out.length < limit; pass++) {
    for (const { i } of order) {
      if (out.length >= limit) break;
      if (keys.has(I.tkey[i]) || (pass === 0 && lastA.slice(-3).includes(I.artist[i]))) continue;
      out.push(I.ids[i]); keys.add(I.tkey[i]); lastA.push(I.artist[i]);
    }
  }
  return out;
}
const hourSeed = (uid, id) => hashStr(`${uid}:${id}:${Math.floor(Date.now() / 3600e3)}`);
/** Spåren i en station eller i "Låtradio från din lyssning" (null om id inte är en station). */
export function stationTracks(id, libId, uid, { limit = 100 } = {}) {
  if (!isSonicId(id)) return null;
  const I = index();
  if (libCount(I, libId) < MIN_TRACKS) return [];
  if (id === RADIO_ID) {
    // Från de senast spelade (analyserade) låtarna i biblioteket – byts när man lyssnar på annat
    const last = all(`SELECT p.track_id, MAX(p.ts) AS ts FROM track_plays p JOIN tracks t ON t.id=p.track_id WHERE p.user_id=? AND t.library_id=?
      GROUP BY p.track_id ORDER BY ts DESC LIMIT 40`, uid, libId).map(r => r.track_id).filter(t => I.pos.has(t)).slice(0, 5);
    if (!last.length) return [];
    const r = radio({ trackId: last[0], history: last.slice(1).reverse(), count: Math.min(limit, 60), uid, seed: hourSeed(uid, id) });
    return r?.trackList || [];
  }
  return shapeIds(stationIds(STATIONS.find(s => s.id === id), libId, { limit, seed: hourSeed(uid, id), I }), uid);
}
export const stationName = (id) => id === RADIO_ID ? 'Låtradio från din lyssning' : STATIONS.find(s => s.id === id)?.name || null;
/** Stationerna för musikhemmet (bara när biblioteket har tillräckligt många analyserade spår). */
export function stations(libId, uid) {
  const I = index();
  if (libCount(I, libId) < MIN_TRACKS) return [];
  return [RADIO_ID, ...STATIONS.map(s => s.id)].map(id => ({ id, name: stationName(id), tracks: stationTracks(id, libId, uid) }))
    .filter(s => s.tracks.length).map(s => ({ ...s, station: true, icon: id2icon(s.id), text: STATIONS.find(x => x.id === s.id)?.text || 'Liknande det du spelat senast' }));
}
const id2icon = (id) => STATIONS.find(s => s.id === id)?.icon || '📻';
/** Antal analyserade spår i ett bibliotek (för musikhemmet). */
export function libraryStats(libId) {
  const r = get(`SELECT (SELECT COUNT(*) FROM tracks WHERE library_id=?) AS total, (SELECT COUNT(*) FROM track_sonic s JOIN tracks t ON t.id=s.track_id
    WHERE t.library_id=? AND s.ok=1 AND s.ver=? AND s.mtime IS t.mtime) AS analyzed`, libId, libId, VERSION);
  return { total: r.total, analyzed: r.analyzed, ready: r.analyzed >= MIN_TRACKS };
}
