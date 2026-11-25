// Takt för originalfilen (/api/stream/:id/direct) till profiler med skärmtid.
// Utan takt kan hela filen hämtas på några sekunder och ses ur en egen kopia, utan att skärmtiden går. Med takt
// kostar en kopia minst en fjärdedel av filmens längd i skärmtid (strömmen räknas medan den skickas, se countStream).
// En spelare märker inget: starten (hinken) kommer direkt, och därefter skickas fyra gånger filens bithastighet.
// Hinken delas av alla förfrågningar för samma profil och fil, så många parallella Range-anrop ger ingen genväg.
// Längst ner: samma takt för talat ljud i webbläsaren utanför hemmet (audioPaceFor, headerOf – routes/books.js).
import fs from 'node:fs';
import { Transform } from 'node:stream';

export const PACE_FACTOR = 4;           // gånger filens bithastighet
const MIN_RATE = 1 * 1048576;           // byte/s: låga bithastigheter får ändå snabb start och snabba hopp
const FALLBACK_RATE = 10 * 1048576;     // byte/s när längden är okänd (motsvarar 4 × 20 Mbit/s)
const BURST_SECONDS = 120;              // hinken rymmer två minuters video …
const MIN_BURST = 32 * 1048576;         // … men minst 32 MB (filens huvud och index, första bufferten)

/** { rate (byte/s), burst (byte) } för titeln */
export function paceFor(it) {
  const bitrate = it?.size > 0 && it?.duration > 0 ? it.size / it.duration : 0;
  if (!bitrate) return { rate: FALLBACK_RATE, burst: MIN_BURST };
  return { rate: Math.max(MIN_RATE, PACE_FACTOR * bitrate), burst: Math.max(MIN_BURST, BURST_SECONDS * bitrate) };
}

const buckets = new Map(); // `${uid}:${itemId}` → { tokens, t, rate, burst, refs }
function fill(b) {
  const now = Date.now();
  b.tokens = Math.min(b.burst, b.tokens + (now - b.t) * b.rate / 1000);
  b.t = now;
}
function prune() {
  if (buckets.size < 500) return;
  for (const [k, b] of buckets) { if (b.refs) continue; fill(b); if (b.tokens >= b.burst) buckets.delete(k); }
}

/**
 * En Transform som släpper igenom datan i titelns takt (hinken delas per profil och fil).
 * opts (ljudböcker och poddar, se audioPaceFor): { rate, burst } i stället för titelns och en egen hink för förfrågan
 * (varje start och hopp börjar snabbt), free = [från, till) i filen som går fritt (filens huvud: MP4:s moov, MP3:s ID3
 * med omslag) och start = byten som förfrågan börjar på.
 */
export function pacer(uid, it, opts = {}) {
  const own = !!opts.rate;
  const { rate, burst } = own ? opts : paceFor(it);
  const free = opts.free || null;
  let pos = opts.start || 0;
  let b = own ? null : buckets.get(`${uid}:${it.id}`);
  if (!b) { b = { tokens: burst, t: Date.now(), rate, burst, refs: 0 }; if (!own) { prune(); buckets.set(`${uid}:${it.id}`, b); } }
  b.rate = rate; b.burst = burst; b.refs++;
  let timer = null, released = false;
  const release = () => { if (!released) { released = true; b.refs--; } };
  return new Transform({
    transform(chunk, _enc, cb) {
      fill(b);
      const from = pos; pos += chunk.length;
      const freeBytes = free ? Math.max(0, Math.min(pos, free[1]) - Math.max(from, free[0])) : 0;
      b.tokens -= chunk.length - freeBytes; // skulden delas: nästa bit (i samma eller en parallell förfrågan) väntar längre
      if (b.tokens >= 0) return cb(null, chunk);
      timer = setTimeout(() => { timer = null; cb(null, chunk); }, Math.ceil(-b.tokens / b.rate * 1000));
    },
    flush(cb) { release(); cb(); },
    destroy(err, cb) { clearTimeout(timer); release(); cb(err); }
  });
}
export const bucketCount = () => buckets.size;

// ---------- ljudböcker och poddar i webbläsaren utanför hemmet ----------
// Ett ljudelement hämtar så mycket det får: en lång M4B eller en stor MP3 laddas i full fart i många sekunder. Utanför
// hemmet delar ljudet hemmets uppladdning (och reläets tunnel, där allt går i en enda anslutning) med allt annat, och
// då väntade sidor, omslag och knappar på ljudet – en boksida kunde ta 2–8 s att visa (ärende #2). Talat ljud behöver
// bara sin egen hastighet gånger uppspelningstakten (högst 3×): efter en snabb start skickas åtta gånger filens
// bithastighet. Varje förfrågan får en egen start, så att start och hopp går fort. Filens huvud (MP4:s index, som för
// en 12-timmarsbok är ~8 MB, och ID3 med omslag) går alltid fritt – spelaren kan inte börja utan det.
export const AUDIO_FACTOR = 8;                  // gånger filens bithastighet (3× uppspelning med god marginal)
const AUDIO_MIN_RATE = 48 * 1024;               // byte/s (≈ 0,4 Mbit/s): låga bithastigheter startar och spolar ändå fort
const AUDIO_FALLBACK_RATE = 256 * 1024;         // byte/s när längden är okänd
const AUDIO_BURST_SECONDS = 60;                 // varje förfrågan (start, hopp) börjar med en minut ljud …
const AUDIO_MIN_BURST = 2 * 1048576;            // … men minst 2 MB: Chrome läser vidare i samma förfrågan vid korta hopp

/** { rate (byte/s), burst (byte) } för en ljudfil ({ size, duration }) */
export function audioPaceFor(f) {
  const bitrate = f?.size > 0 && f?.duration > 0 ? f.size / f.duration : 0;
  if (!bitrate) return { rate: AUDIO_FALLBACK_RATE, burst: AUDIO_MIN_BURST };
  return { rate: Math.max(AUDIO_MIN_RATE, AUDIO_FACTOR * bitrate), burst: Math.max(AUDIO_MIN_BURST, AUDIO_BURST_SECONDS * bitrate) };
}

/** Filens huvud som [från, till) eller null: MP4/M4A/M4B:s moov (först eller sist i filen), MP3:s ID3v2-tagg */
export async function headerRange(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(16);
    const read = async (pos, n) => (await fh.read(buf, 0, n, pos)).bytesRead;
    if (await read(0, 10) < 10) return null;
    if (buf.toString('latin1', 0, 3) === 'ID3') {
      const len = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
      return [0, Math.min(size, 10 + len + (buf[5] & 0x10 ? 10 : 0))];
    }
    // MP4: gå igenom lådorna på översta nivån (bara deras huvuden läses)
    if (buf.toString('latin1', 4, 8) !== 'ftyp') return null;
    for (let pos = 0, n = 0; pos + 8 <= size && n < 64; n++) {
      if (await read(pos, 16) < 8) return null;
      let len = buf.readUInt32BE(0);
      if (len === 1) len = Number(buf.readBigUInt64BE(8));
      else if (len === 0) len = size - pos;
      if (len < 8) return null;
      if (buf.toString('latin1', 4, 8) === 'moov') return [pos, Math.min(size, pos + len)];
      pos += len;
    }
    return null;
  } catch { return null; }
  finally { await fh?.close().catch(() => {}); }
}
const heads = new Map(); // `${sökväg}|${storlek}|${ändrad}` → [från, till) | null
/** headerRange med minne (en ljudbok spolas och byter fil ofta) */
export async function headerOf(file, size = 0, mtime = 0) {
  const k = `${file}|${size}|${mtime}`;
  if (heads.has(k)) return heads.get(k);
  const r = await headerRange(file);
  if (heads.size >= 500) heads.delete(heads.keys().next().value);
  heads.set(k, r);
  return r;
}
