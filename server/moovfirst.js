// M4A/M4B/MP4-ljud med indexet (moov) först, utan att röra ljudet eller originalfilen.
// Många rippare och ffmpeg skriver moov sist, efter ljudet (mdat). Spelaren kan inte avkoda något förrän moov kommit,
// så webbläsaren hämtar först hela filen fram till slutet (Chrome: 18 s för en låt på 1 Mbit/s) eller hoppar dit med
// Range. Här läses moov in och filen skickas i ordningen [huvudet före ljudet] [moov] [ljudet …] – samplens adresser
// i stco/co64 flyttas lika mycket som ljudet flyttats. Omslagsbilder i taggarna (covr, ofta 100–500 kB som annars
// måste hämtas före ljudet) tas bort ur den skickade filen; omslaget har egen adress (/api/music/cover).
// Ingenting skrivs till disk: den omskrivna moov hålls i minnet (högst CACHE_BYTES totalt, de senast använda), resten
// läses ur originalfilen. Range fungerar som vanligt mot den nya ordningen. Filer som redan har moov först och inget
// omslag, fragmenterade filer (moof) och allt som inte går att tolka skickas som förut (plan = null).
import fs from 'node:fs';
import { Readable, pipeline } from 'node:stream';
import { send } from './util.js';

export const EXTS = new Set(['.m4a', '.m4b', '.mp4']);
const MAX_MOOV = 24 << 20;      // större moov (långa ljudböcker) skrivs inte om – skickas som förut
const CACHE_BYTES = 48 << 20;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'ilst', 'meta', 'edts', 'dinf']);
const cache = new Map(); // nyckel (sökväg, storlek, ändringstid) → Promise<plan | null>
let cached = 0;

async function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fd.read(b, 0, len, pos);
  return b.subarray(0, bytesRead);
}
/** Lådorna på filens översta nivå: [{ type, start, size }] – null om filen inte ser ut som MP4 */
export async function topLevel(fd, size) {
  const out = [];
  let o = 0;
  while (o < size) {
    const h = await readAt(fd, o, 16);
    if (h.length < 8) return null;
    let n = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (n === 1) { if (h.length < 16) return null; n = Number(h.readBigUInt64BE(8)); }
    else if (n === 0) n = size - o;
    if (n < 8 || o + n > size || !/^[\x20-\x7e]{4}$/.test(type)) return null;
    out.push({ type, start: o, size: n });
    o += n;
  }
  return out.length && out[0].type === 'ftyp' ? out : null;
}
/** meta är en "full box" (4 byte version/flaggor före barnen) i MP4, men inte i äldre QuickTime-filer */
const metaSkip = (b, o) => (b.toString('latin1', o + 12, o + 16) === 'hdlr' ? 0 : 4);
/**
 * Bygger om en låda utan omslagsbilder (covr i ilst). Returnerar en ny Buffer, eller samma om inget togs bort.
 * Kastar vid trasiga storlekar (då skickas filen som den är).
 */
function strip(b, o, n) {
  const type = b.toString('latin1', o + 4, o + 8);
  if (!CONTAINERS.has(type)) return b.subarray(o, o + n);
  const head = 8 + (type === 'meta' ? metaSkip(b, o) : 0);
  const parts = [];
  let p = o + head, changed = false;
  while (p < o + n) {
    const m = b.readUInt32BE(p);
    if (m < 8 || p + m > o + n) throw new Error('trasig låda');
    const ct = b.toString('latin1', p + 4, p + 8);
    if (type === 'ilst' && ct === 'covr') changed = true;
    else { const c = strip(b, p, m); if (c.length !== m) changed = true; parts.push(c); }
    p += m;
  }
  if (!changed) return b.subarray(o, o + n);
  const body = Buffer.concat(parts), h = Buffer.from(b.subarray(o, o + head));
  h.writeUInt32BE(head + body.length, 0);
  return Buffer.concat([h, body]);
}
/** Alla stco/co64 i moov (via trak/mdia/minf/stbl) */
function chunkTables(b, o, n, out = []) {
  const type = b.toString('latin1', o + 4, o + 8);
  if (type === 'stco' || type === 'co64') { out.push({ type, at: o }); return out; }
  if (!['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) return out;
  for (let p = o + 8; p < o + n;) { const m = b.readUInt32BE(p); if (m < 8) throw new Error('trasig låda'); chunkTables(b, p, m, out); p += m; }
  return out;
}

/**
 * Planen för filen: { size, parts: [{ buf } | { start, end }] } i den ordning byten ska skickas (end inräknat),
 * eller null när filen ska skickas som den är.
 */
export async function analyze(file, size) {
  const fd = await fs.promises.open(file, 'r');
  try {
    const top = await topLevel(fd, size);
    if (!top || top.some(x => x.type === 'moof')) return null;
    const mi = top.findIndex(x => x.type === 'moov');
    const firstMdat = top.findIndex(x => x.type === 'mdat');
    if (mi < 0 || firstMdat < 0 || top.filter(x => x.type === 'moov').length > 1) return null;
    const moov = top[mi];
    if (moov.size > MAX_MOOV) return null;
    const old = await readAt(fd, moov.start, moov.size);
    if (old.length !== moov.size || old.readUInt32BE(0) !== moov.size) return null;
    if (old.includes('iloc', 0, 'latin1')) return null; // adresser i meta-lådor som inte flyttas här
    const nm = Buffer.from(strip(old, 0, moov.size)); // kopia: adresserna skrivs om i den
    if (mi < firstMdat && nm.length === moov.size) return null; // moov först redan och inget omslag – som förut
    // Ny ordning: lådorna före första mdat, moov, resten (utan moov)
    const rest = top.filter(x => x !== moov), k = rest.findIndex(x => x.type === 'mdat');
    const order = [...rest.slice(0, k), moov, ...rest.slice(k)];
    let pos = 0;
    const where = new Map();
    for (const x of order) { where.set(x, pos); pos += x === moov ? nm.length : x.size; }
    // Varje adress till ljudet: samma plats i sin låda, lådans nya plats
    const move = (off) => {
      const x = rest.find(y => off >= y.start && off < y.start + y.size);
      if (!x) throw new Error('adress utanför filen');
      return off - x.start + where.get(x);
    };
    for (const { type, at } of chunkTables(nm, 0, nm.length)) {
      const cnt = nm.readUInt32BE(at + 12);
      if (at + 16 + cnt * (type === 'stco' ? 4 : 8) > nm.length) return null;
      for (let i = 0; i < cnt; i++) {
        if (type === 'stco') {
          const v = move(nm.readUInt32BE(at + 16 + i * 4));
          if (v > 0xffffffff) return null;
          nm.writeUInt32BE(v, at + 16 + i * 4);
        } else nm.writeBigUInt64BE(BigInt(move(Number(nm.readBigUInt64BE(at + 16 + i * 8)))), at + 16 + i * 8);
      }
    }
    const parts = [];
    for (const x of order) {
      if (x === moov) parts.push({ buf: nm });
      else if (parts.length && parts.at(-1).end === x.start - 1) parts.at(-1).end = x.start + x.size - 1;
      else parts.push({ start: x.start, end: x.start + x.size - 1 });
    }
    return { size: pos, parts, moov: nm.length };
  } catch { return null; } finally { await fd.close().catch(() => {}); }
}

/** Planen för filen (cachad i minnet efter sökväg, storlek och ändringstid) */
export function planFor(file, st) {
  const key = `${file}\0${st.size}\0${st.mtimeMs}`;
  let p = cache.get(key);
  if (p) { cache.delete(key); cache.set(key, p); return p; } // senast använd sist
  p = analyze(file, st.size).catch(() => null);
  cache.set(key, p);
  p.then(plan => {
    const bytes = 200 + (plan?.moov || 0);
    if (cache.get(key) !== p) return;
    p.bytes = bytes; cached += bytes;
    for (const [k, v] of cache) { if (cached <= CACHE_BYTES || k === key) break; cache.delete(k); cached -= v.bytes || 0; }
  });
  return p;
}
/** Bara för testerna */
export const _cacheInfo = () => ({ entries: cache.size, bytes: cached });

/** Byten start…end (inräknat) av den omskrivna filen, bit för bit */
async function* bytesOf(file, plan, start, end) {
  let o = 0;
  for (const p of plan.parts) {
    const len = p.buf ? p.buf.length : p.end - p.start + 1;
    const a = Math.max(start, o), z = Math.min(end, o + len - 1);
    if (a <= z) {
      if (p.buf) yield p.buf.subarray(a - o, z - o + 1);
      else yield* fs.createReadStream(file, { start: p.start + (a - o), end: p.start + (z - o), highWaterMark: 256 << 10 });
    }
    o += len;
    if (o > end) break;
  }
}
/** Som util.streamFile, men för den omskrivna filen (Range mot den nya ordningen) */
// through (valfri): takten för ljudböcker utanför hemmet (pace.js), som i util.streamFile
export function servePlan(req, res, file, plan, headers = {}, { through = null } = {}) {
  const size = plan.size;
  let start = 0, end = size - 1, code = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') start = Math.max(0, size - +m[2]);
    else { start = +m[1]; if (m[2] !== '') end = Math.min(+m[2], size - 1); }
    if (start > end || start >= size) return send(res, 416, '', { 'Content-Range': `bytes */${size}` });
    code = 206;
  }
  const h = { ...headers, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'X-Moov-First': '1' };
  if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, h);
  if (req.method === 'HEAD') return res.end();
  const src = Readable.from(bytesOf(file, plan, start, end), { objectMode: false });
  if (through) pipeline(src, through({ start, end }), res, () => {});
  else pipeline(src, res, () => {});
}
