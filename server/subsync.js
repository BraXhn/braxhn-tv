// Automatisk synkning av undertexter: undertextens repliker jämförs med talet i ljudspåret.
// 1) Talaktivitet: ffmpeg avkodar ljudspåret till 8 kHz mono med bandpass för röster (lägsta prioritet). Energin per
//    10 ms jämförs med en tröskel ur filens egen ljudnivå (global och lokal bakgrund) → en binär tidslinje, 1 = tal.
//    Tidslinjen cachas per fil och ljudspår (cache/subsync/<id>-<mtime>-<spår>.bin, en byte per 10 ms).
// 2) Undertextens repliker (start–slut) läggs på tidslinjen för varje vanlig bildfrekvenskvot (25↔23,976, 25↔24,
//    24↔23,976 och ingen) och förskjutningar ±3 min prövas, först grovt (100 ms) och sedan fint (10 ms). Poängen är
//    hur mycket replik-tid som hamnar på tal, räknad med prefixsummor: varje förskjutning kostar en subtraktion per replik.
//    En annan kvot än 1 väljs bara när den är tydligt bättre; en topp som inte sticker ut ur bruset räknas som osäker.
// 3) Resultatet sparas per titel och undertextfil (tabellen sub_sync) och läggs på av servern när undertexten skickas
//    (stream.js serveSubtitle, /api/stream/:id/subs/:sid): t' = t · ratio + offset. Webben, apparna och Chromecast
//    får alltså samma tider. Manuell finjustering sparas på samma rad (PUT .../sync).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CACHE, get, run, now } from './db.js';
import { lowPriority, writeAtomic } from './util.js';
import * as jobs from './jobs.js';

export const FRAME = 0.01; // sekunder per ram i tidslinjerna
const RATE = 8000, SPF = RATE * FRAME;
const NTSC = 24000 / 1001; // "23,976"
// [undertextens bildfrekvens, filmens]: undertext gjord för en 25-bilders utgåva (PAL, 4 % snabbare) på en film i
// 23,976 har för korta tider – de multipliceras med 25 / 23,976
export const FPS_PAIRS = [[25, NTSC], [NTSC, 25], [25, 24], [24, 25], [24, NTSC], [NTSC, 24]];
const MAX_SHIFT = 180;
const MAX_CUE = 12; // längre repliker (skyltar, sångtexter som ligger kvar) säger lite om var talet är

// ---------------- undertextens repliker ----------------
const tsec = (x) => x.split(':').reduce((a, v) => a * 60 + parseFloat(v), 0);
// Repliker som inte är tal: [MUSIK], (skratt), ♪ sångtext ♪
const notSpeech = (t) => (/^[♪♫#*]/.test(t) && /[♪♫#*]$/.test(t)) || !/\p{L}/u.test(t.replace(/\[[^\]]*\]|\([^)]*\)/g, ''));
/** Repliker ur WebVTT: [{ s, e }] i sekunder, sorterade, utan icke-tal och orimligt långa */
export function parseCues(vtt) {
  const out = [];
  const re = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})[^\n]*\n([^]*?)(?:\n\s*\n|$)/g;
  for (let m; (m = re.exec(String(vtt || '').replace(/\r/g, ''))); ) {
    const s = tsec(m[1].replace(',', '.')), e = tsec(m[2].replace(',', '.'));
    const text = m[3].replace(/<[^>]+>|\{[^}]*\}/g, '').trim();
    if (!(e > s) || e - s > MAX_CUE || notSpeech(text)) continue;
    out.push({ s, e });
  }
  return out.sort((a, b) => a.s - b.s);
}

// ---------------- talaktivitet ----------------
/** Medelenergi per 10 ms ur ljudspåret (stream = global strömindex, annars första ljudspåret) */
export function decodeEnergy(file, { stream = null, duration = 0, onProgress } = {}) {
  return new Promise((ok, no) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', file,
      '-map', stream != null ? `0:${stream}` : '0:a:0', '-vn', '-sn', '-dn', '-ac', '1',
      '-af', `aresample=${RATE},highpass=f=250,lowpass=f=3000`, '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'];
    const p = lowPriority(spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    let err = '', carry = null, acc = 0, n = 0, last = 0;
    const en = [];
    p.stderr.on('data', d => { if (err.length < 2000) err += d; });
    p.stdout.on('data', (b) => {
      if (carry) { b = Buffer.concat([carry, b]); carry = null; }
      const end = b.length & ~1;
      for (let i = 0; i < end; i += 2) {
        const s = b.readInt16LE(i);
        acc += s * s;
        if (++n === SPF) { en.push(acc / SPF); acc = 0; n = 0; }
      }
      if (end < b.length) carry = b.subarray(end);
      if (onProgress && duration > 0 && en.length - last >= 3000) { last = en.length; onProgress(Math.min(1, en.length * FRAME / duration)); }
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), 45 * 60e3);
    p.on('error', (e) => { clearTimeout(timer); no(new Error('Kunde inte starta ffmpeg: ' + e.message)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && en.length < 100) return no(new Error('Kunde inte läsa ljudet' + (err ? ': ' + err.trim().split('\n').pop() : '')));
      ok(Float64Array.from(en));
    });
  });
}

/** Binär tidslinje (1 = tal) ur energin per ram */
export function voiced(en) {
  const n = en.length, out = new Uint8Array(n);
  if (!n) return out;
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) db[i] = 10 * Math.log10(en[i] + 1); // 16 bitar: digital tystnad = 0 dB
  const sorted = Float32Array.from(db).sort();
  const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
  const floor = pct(sorted, 0.1), top = pct(sorted, 0.95);
  const thr = floor + Math.max(6, (top - floor) * 0.4);
  // Lokal bakgrund (musik, brus): 20:e percentilen per sekund, lägsta inom ±5 s – tal ska ligga klart över den
  const B = 100, nb = Math.ceil(n / B), bl = new Float32Array(nb);
  for (let k = 0; k < nb; k++) bl[k] = pct(db.slice(k * B, Math.min(n, (k + 1) * B)).sort(), 0.2);
  const local = new Float32Array(nb);
  for (let k = 0; k < nb; k++) { let m = Infinity; for (let j = Math.max(0, k - 5); j <= Math.min(nb - 1, k + 5); j++) m = Math.min(m, bl[j]); local[k] = m; }
  for (let i = 0; i < n; i++) out[i] = db[i] > Math.max(thr, local[(i / B) | 0] + 8) ? 1 : 0;
  // Stavelsepauser (under 0,3 s) fylls i, korta knäppar (under 0,08 s) tas bort
  fillRuns(out, 0, 30, 1);
  fillRuns(out, 1, 8, 0);
  return out;
}
function fillRuns(a, val, max, to) {
  for (let i = 0; i < a.length; ) {
    if (a[i] !== val) { i++; continue; }
    let j = i; while (j < a.length && a[j] === val) j++;
    if (j - i < max && i > 0 && j < a.length) a.fill(to, i, j);
    i = j;
  }
}

// ---------------- justeringen ----------------
/** Bästa förskjutning (och ev. bildfrekvenskvot) för repliker mot taltidslinjen.
 *  Ger { offset, ratio, fps, score, chance, z, confident }: t_film = t_undertext · ratio + offset. */
export function align(speech, cues, { maxShift = MAX_SHIFT } = {}) {
  const N = speech.length;
  const P = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) P[i + 1] = P[i] + speech[i];
  const chance = N ? P[N] / N : 0;
  const K = Math.round(maxShift / FRAME);
  const cand = [[1, null], ...FPS_PAIRS.map(f => [f[0] / f[1], f])];
  const results = cand.map(([r, fps]) => {
    const A = Int32Array.from(cues, c => Math.round(c.s * r / FRAME)), Bv = Int32Array.from(cues, c => Math.round(c.e * r / FRAME));
    let L = 0; for (let j = 0; j < A.length; j++) L += Bv[j] - A[j];
    const score = (k) => {
      let s = 0;
      for (let j = 0; j < A.length; j++) {
        const a = A[j] + k, b = Bv[j] + k;
        if (b <= 0 || a >= N) continue;
        s += P[b > N ? N : b] - P[a < 0 ? 0 : a];
      }
      return s;
    };
    let bk = 0, bs = -1, sum = 0, sum2 = 0, cnt = 0;
    for (let k = -K; k <= K; k += 10) {
      const s = score(k); sum += s; sum2 += s * s; cnt++;
      if (s > bs) { bs = s; bk = k; }
    }
    const mean = sum / cnt, sd = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
    // Fint: var 10 ms runt den grova toppen – mitten av en platå (repliken kortare än talet) väljs
    const fine = [];
    for (let k = bk - 15; k <= bk + 15; k++) fine.push([k, score(k)]);
    const top = Math.max(...fine.map(x => x[1]));
    const at = fine.filter(x => x[1] === top).map(x => x[0]);
    const k = Math.round(at.reduce((a, b) => a + b, 0) / at.length);
    return { ratio: r, fps, k, score: L ? top / L : 0, z: sd > 0 ? (top - mean) / sd : 0 };
  });
  const base = results[0];
  // Kvoter som ligger nära varandra (25/24 och 25/23,976 skiljer 0,1 %) går knappt att skilja åt i ett kort klipp:
  // då vinner den vanligaste (först i FPS_PAIRS)
  let best = null;
  for (const x of results.slice(1)) if (!best || x.score > best.score + 0.005) best = x;
  // Kvoten måste vara tydligt bättre än ingen kvot, annars är det brus
  if (!(best.score > base.score + 0.03 && best.score > base.score * 1.05)) best = base;
  const offset = Math.round(best.k * FRAME * 1000) / 1000;
  return {
    offset, ratio: best.ratio, fps: best.fps ? { from: +best.fps[0].toFixed(3), to: +best.fps[1].toFixed(3) } : null,
    score: +best.score.toFixed(3), chance: +chance.toFixed(3), z: +best.z.toFixed(1),
    confident: cues.length >= 5 && best.z >= 4 && best.score - chance >= 0.1
  };
}

// ---------------- lagring ----------------
// Raden gäller en undertextfil (extern bredvid filmen eller nedladdad) – inbäddade spår synkas inte.
const keyOf = (sub) => sub?.file ? `${sub.source}:${path.basename(sub.file)}` : null;
const mtimeOf = (f) => { try { return Math.floor(fs.statSync(f).mtimeMs); } catch { return 0; } };
export const syncable = (sub) => !!sub?.file && !sub.bitmap;
function row(it, sub) {
  const k = keyOf(sub); if (!k) return null;
  const r = get('SELECT * FROM sub_sync WHERE item_id=? AND sub=?', it.id, k);
  // Filen har bytts ut (samma namn, nytt innehåll): den gamla justeringen gäller inte längre
  return r && r.sub_mtime === mtimeOf(sub.file) ? r : null;
}
/** Tidsjustering att lägga på när undertexten skickas – null när ingen finns */
export function adjustment(it, sub) {
  const r = row(it, sub);
  return r && (r.shift || r.ratio !== 1) ? { offset: r.shift, ratio: r.ratio } : null;
}
const clampOffset = (x) => Math.max(-600, Math.min(600, Math.round((+x || 0) * 1000) / 1000));
const clampRatio = (x) => { const r = +x; return Number.isFinite(r) && r >= 0.9 && r <= 1.1 ? r : 1; };
/** Spara förskjutning och kvot (manuellt eller efter automatisk synk) */
export function save(it, sub, { offset, ratio }, auto = null) {
  const k = keyOf(sub); if (!k) return;
  const o = clampOffset(offset), r = clampRatio(ratio);
  run(`INSERT INTO sub_sync(item_id, sub, sub_mtime, shift, ratio, updated) VALUES(?,?,?,?,?,?)
    ON CONFLICT(item_id, sub) DO UPDATE SET sub_mtime=excluded.sub_mtime, shift=excluded.shift, ratio=excluded.ratio, updated=excluded.updated`,
  it.id, k, mtimeOf(sub.file), o, r, now());
  if (auto) run('UPDATE sub_sync SET auto_shift=?, auto_ratio=?, auto_score=?, auto_audio=?, auto_mtime=? WHERE item_id=? AND sub=?',
    auto.offset, auto.ratio, auto.score, auto.audio == null ? '' : String(auto.audio), it.mtime | 0, it.id, k);
}
/** Undertexten är borttagen */
export function forget(it, sub) {
  const k = keyOf(sub); if (k) run('DELETE FROM sub_sync WHERE item_id=? AND sub=?', it.id, k);
}

// ---------------- jobb ----------------
const running = new Map(); // `${id}:${nyckel}` → { state, progress, result, error, previous }
let queue = Promise.resolve(); // en synk åt gången – avkodningen läser hela ljudspåret
const jobKey = (it, sub) => `${it.id}:${keyOf(sub)}`;
const cur = (r) => ({ offset: r?.shift ?? 0, ratio: r?.ratio ?? 1 });
const pub = (j) => j && { state: j.state, progress: +j.progress.toFixed(3), error: j.error || null, result: j.result, previous: j.previous };

/** Läget för en undertext: sparad justering, senaste automatiska resultat och ev. pågående jobb */
export function status(it, sub) {
  const r = row(it, sub);
  return {
    syncable: syncable(sub), ...cur(r),
    auto: r && r.auto_shift != null ? { offset: r.auto_shift, ratio: r.auto_ratio, score: r.auto_score } : null,
    job: pub(running.get(jobKey(it, sub))) || null
  };
}

/** Starta automatisk synk. getVtt() ger undertexten som WebVTT. Ett sparat resultat för samma fil och ljudspår
 *  används direkt (force = räkna om). */
export function start(it, sub, { audio = null, force = false, getVtt }) {
  const k = jobKey(it, sub);
  const old = running.get(k);
  if (old && (old.state === 'queued' || old.state === 'running')) return status(it, sub);
  const r = row(it, sub);
  const j = { state: 'queued', progress: 0, result: null, error: null, previous: cur(r) };
  running.set(k, j);
  const audioKey = audio == null ? '' : String(audio);
  if (!force && r && r.auto_shift != null && r.auto_mtime === (it.mtime | 0) && r.auto_audio === audioKey) {
    save(it, sub, { offset: r.auto_shift, ratio: r.auto_ratio });
    Object.assign(j, { state: 'done', progress: 1, result: { offset: r.auto_shift, ratio: r.auto_ratio, fps: fpsOf(r.auto_ratio), score: r.auto_score, confident: true, cached: true } });
    expire(k, j);
    return status(it, sub);
  }
  queue = queue.then(() => runJob(k, j, it, sub, audio, getVtt)).catch(() => {});
  return status(it, sub);
}
const fpsOf = (ratio) => { const f = FPS_PAIRS.find(p => Math.abs(p[0] / p[1] - ratio) < 1e-6); return f ? { from: +f[0].toFixed(3), to: +f[1].toFixed(3) } : null; };
const expire = (k, j) => setTimeout(() => { if (running.get(k) === j) running.delete(k); }, 15 * 60e3).unref();

const speechDir = () => path.join(CACHE, 'subsync');
async function speechOf(it, audio, onProgress) {
  const dir = speechDir(), name = `${it.id}-${it.mtime | 0}-${audio == null ? 'a' : audio}.bin`, file = path.join(dir, name);
  try { return new Uint8Array(await fs.promises.readFile(file)); } catch {}
  const sp = voiced(await decodeEnergy(it.path, { stream: audio, duration: it.duration || 0, onProgress }));
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Äldre tidslinjer för samma titel (filen har ändrats) tas bort
    for (const f of fs.readdirSync(dir)) if (f.startsWith(it.id + '-') && !f.startsWith(`${it.id}-${it.mtime | 0}-`)) fs.rmSync(path.join(dir, f), { force: true });
    writeAtomic(file, Buffer.from(sp.buffer, sp.byteOffset, sp.length));
  } catch {}
  return sp;
}

async function runJob(k, j, it, sub, audio, getVtt) {
  if (running.get(k) !== j) return;
  const h = jobs.track('subtitle', `Synkar undertext: ${it.title || ''}`.trim(), { total: 100 });
  j.state = 'running';
  try {
    const cues = parseCues(await getVtt());
    if (cues.length < 5) throw new Error('Undertexten har för få repliker för att kunna synkas');
    const speech = await speechOf(it, audio, (f) => { j.progress = f * 0.95; h.update(Math.round(f * 95)); });
    if (speech.length < 1000) throw new Error('Ljudspåret är för kort för att kunna synkas');
    const t0 = Date.now();
    const res = align(speech, cues);
    j.progress = 1;
    j.result = res;
    if (res.confident) {
      save(it, sub, res, { ...res, audio });
      j.state = 'done';
      console.log(`[undertext] synkad ${it.title}: ${res.offset >= 0 ? '+' : ''}${res.offset} s${res.fps ? ` (${res.fps.from} → ${res.fps.to} bilder/s)` : ''}, träff ${res.score} mot slump ${res.chance}, z ${res.z}, ${Date.now() - t0} ms`);
    } else {
      j.state = 'unsure';
      console.log(`[undertext] ingen säker synk för ${it.title}: bästa ${res.offset} s, träff ${res.score} mot slump ${res.chance}, z ${res.z}`);
    }
  } catch (e) {
    j.state = 'error'; j.error = e.message || 'Synkningen misslyckades';
    console.warn('[undertext] synk', it.path, j.error);
  } finally { h.end(); expire(k, j); }
}
