// Takt för originalfilen (/api/stream/:id/direct) till profiler med skärmtid.
// Utan takt kan hela filen hämtas på några sekunder och ses ur en egen kopia, utan att skärmtiden går. Med takt
// kostar en kopia minst en fjärdedel av filmens längd i skärmtid (strömmen räknas medan den skickas, se countStream).
// En spelare märker inget: starten (hinken) kommer direkt, och därefter skickas fyra gånger filens bithastighet.
// Hinken delas av alla förfrågningar för samma profil och fil, så många parallella Range-anrop ger ingen genväg.
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

/** En Transform som släpper igenom datan i titelns takt (hinken delas per profil och fil) */
export function pacer(uid, it) {
  const key = `${uid}:${it.id}`;
  const { rate, burst } = paceFor(it);
  let b = buckets.get(key);
  if (!b) { prune(); b = { tokens: burst, t: Date.now(), rate, burst, refs: 0 }; buckets.set(key, b); }
  b.rate = rate; b.burst = burst; b.refs++;
  let timer = null, released = false;
  const release = () => { if (!released) { released = true; b.refs--; } };
  return new Transform({
    transform(chunk, _enc, cb) {
      fill(b);
      b.tokens -= chunk.length; // skulden delas: nästa bit (i samma eller en parallell förfrågan) väntar längre
      if (b.tokens >= 0) return cb(null, chunk);
      timer = setTimeout(() => { timer = null; cb(null, chunk); }, Math.ceil(-b.tokens / b.rate * 1000));
    },
    flush(cb) { release(); cb(); },
    destroy(err, cb) { clearTimeout(timer); release(); cb(err); }
  });
}
export const bucketCount = () => buckets.size;
