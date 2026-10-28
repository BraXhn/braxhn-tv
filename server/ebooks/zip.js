// Minimal ZIP-läsare för e-böcker (EPUB, CBZ) – bara Nodes fs och zlib (inflateRaw), inga beroenden.
//
// Arkiven kommer från användarens bibliotek men behandlas som fientliga:
//   - Inget packas upp till disk. Posternas namn används bara som nycklar i arkivet: absoluta sökvägar, enhetsbokstäver,
//     NUL och ".." som pekar ut ur arkivet godtas aldrig (posten hoppas över och räknas i rejected).
//   - Zip-bomber: varje post har ett tak (max), uppackningen avbryts när utdatan når den angivna storleken
//     (maxOutputLength – även om storleken i katalogen ljuger), och en post med orimlig packningsgrad (> RATIO gånger
//     över 2 MB) läses inte alls. Centralkatalogen och antalet poster har egna tak.
//   - Allt läses med positionerade läsningar från filen – arkivet läses aldrig in i minnet i sin helhet.
//   - CRC-32 kontrolleras (zlib.crc32, Node 22.2+) så att en skadad post inte visas som en trasig sida.
// Stöder metod 0 (lagrad) och 8 (deflate) samt ZIP64. Krypterade poster går inte att läsa.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const inflateRaw = promisify(zlib.inflateRaw);
export const LIMITS = Object.freeze({
  entries: 20000,        // poster i ett arkiv
  cd: 16 << 20,          // centralkatalogens storlek (byte)
  entry: 64 << 20,       // största post som läses (en serietidningssida i full upplösning ryms)
  ratio: 100             // högsta packningsgrad för poster över 2 MB
});
const RATIO_FROM = 2 << 20;

export class ZipError extends Error {
  constructor(msg) { super(msg); this.zip = true; }
}
const utf8 = new TextDecoder('utf-8', { fatal: true });
function decodeName(buf, utfFlag) {
  if (utfFlag) return buf.toString('utf8');
  // Många program skriver UTF-8 utan flaggan; annars CP437/latin1 (ungefär)
  try { return utf8.decode(buf); } catch { return buf.toString('latin1'); }
}
/**
 * Postens namn i arkivet ('/' mellan delarna) eller null om det inte får användas: absolut, enhetsbokstav,
 * styrtecken eller ".." som går ovanför arkivets rot. "./" och dubbla snedstreck tas bort.
 */
export function safeName(raw) {
  const s = String(raw).replace(/\\/g, '/');
  if (!s || s.length > 1024 || /[\u0000-\u001f]/.test(s) || s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  const out = [];
  for (const p of s.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') return null; // även "a/../b": en giltig EPUB behöver det aldrig i postnamn
    out.push(p);
  }
  return out.length ? out.join('/') + (s.endsWith('/') ? '/' : '') : null;
}

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  if (got < len) throw new ZipError('arkivet är avkortat');
  return buf;
}
const u64 = (b, o) => { const v = b.readBigUInt64LE(o); if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('för stort värde i ZIP64'); return Number(v); };

/**
 * Öppnar ett arkiv. Returnerar { entries: Map<namn, post>, rejected, size, read(namn, max), close() }.
 * Mappar (namn som slutar med '/') listas inte. Kastar ZipError om filen inte är ett läsbart ZIP-arkiv.
 */
export async function openZip(file, limits = LIMITS) {
  const L = { ...LIMITS, ...limits };
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipError('inget ZIP-arkiv');
    // Slutet på centralkatalogen (EOCD) ligger inom de sista 64 kB + 22 byte (kommentaren är högst 65535 byte)
    const tailLen = Math.min(size, 65557);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new ZipError('inget ZIP-arkiv');
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    const eocdPos = size - tailLen + e;
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      // ZIP64: lokaliseraren ligger 20 byte före EOCD och pekar på ZIP64-posten
      const lp = eocdPos - 20;
      if (lp < 0) throw new ZipError('ZIP64-katalogen saknas');
      const loc = await readAt(fh, lp, 20);
      if (loc.readUInt32LE(0) !== 0x07064b50) throw new ZipError('ZIP64-katalogen saknas');
      const z64 = u64(loc, 8);
      if (z64 + 56 > lp) throw new ZipError('ogiltig ZIP64-katalog');
      const r = await readAt(fh, z64, 56);
      if (r.readUInt32LE(0) !== 0x06064b50) throw new ZipError('ogiltig ZIP64-katalog');
      count = u64(r, 32); cdSize = u64(r, 40); cdOff = u64(r, 48);
    }
    if (count > L.entries) throw new ZipError(`för många poster (${count})`);
    if (cdSize > L.cd) throw new ZipError('centralkatalogen är för stor');
    if (cdOff + cdSize > eocdPos) throw new ZipError('ogiltig centralkatalog');
    const cd = await readAt(fh, cdOff, cdSize);
    const entries = new Map();
    let rejected = 0;
    for (let p = 0, n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError('trasig centralkatalog');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), kl = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const end = p + 46 + nl + xl + kl;
      if (end > cd.length) throw new ZipError('trasig centralkatalog');
      const name = decodeName(cd.subarray(p + 46, p + 46 + nl), flags & 0x800);
      // ZIP64: de fält som är 0xFFFFFFFF står i extrafältet 0x0001 i ordningen usize, csize, offset
      for (let x = p + 46 + nl, xe = x + xl; x + 4 <= xe;) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (x + 4 + len > xe) break;
        if (id === 1) {
          let q = x + 4;
          const take = () => { if (q + 8 > x + 4 + len) throw new ZipError('trasigt ZIP64-fält'); const v = u64(cd, q); q += 8; return v; };
          if (usize === 0xffffffff) usize = take();
          if (csize === 0xffffffff) csize = take();
          if (offset === 0xffffffff) offset = take();
        }
        x += 4 + len;
      }
      p = end;
      const safe = safeName(name);
      if (!safe) { rejected++; continue; }
      if (safe.endsWith('/')) continue;
      if (offset + 30 + csize > cdOff || csize > size) { rejected++; continue; } // posten ligger utanför datadelen
      if (!entries.has(safe)) entries.set(safe, { name: safe, method, flags, crc, csize, usize, offset });
    }
    return {
      entries, rejected, size,
      /** Läser posten (Buffer). max = högsta tillåtna storlek uppackad. Kastar ZipError. */
      async read(name, max = L.entry) {
        const en = entries.get(name);
        if (!en) throw new ZipError('posten finns inte');
        if (en.flags & 1) throw new ZipError('posten är krypterad');
        if (en.usize > max) throw new ZipError('posten är för stor');
        if (en.usize > RATIO_FROM && en.usize / Math.max(1, en.csize) > L.ratio) throw new ZipError('misstänkt zip-bomb (orimlig packningsgrad)');
        const lh = await readAt(fh, en.offset, 30);
        if (lh.readUInt32LE(0) !== 0x04034b50) throw new ZipError('trasig post');
        const start = en.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        if (start + en.csize > size) throw new ZipError('posten är avkortad');
        const raw = en.csize ? await readAt(fh, start, en.csize) : Buffer.alloc(0);
        let out;
        if (en.method === 0) {
          if (en.csize !== en.usize) throw new ZipError('trasig post');
          out = raw;
        } else if (en.method === 8) {
          // Uppackningen stannar vid den angivna storleken – ljuger katalogen blir det ett fel, aldrig mer minne
          try { out = await inflateRaw(raw, { maxOutputLength: Math.max(1, en.usize) }); }
          catch (e) { throw new ZipError(e.code === 'ERR_BUFFER_TOO_LARGE' ? 'misstänkt zip-bomb (mer data än angivet)' : 'posten går inte att packa upp'); }
          if (out.length !== en.usize) throw new ZipError('trasig post (fel storlek)');
        } else throw new ZipError(`packningsmetoden ${en.method} stöds inte`);
        if (zlib.crc32 && (zlib.crc32(out) >>> 0) !== en.crc) throw new ZipError('trasig post (fel kontrollsumma)');
        return out;
      },
      close: () => fh.close().catch(() => {})
    };
  } catch (e) { await fh.close().catch(() => {}); throw e; }
}

/** Kör fn(zip) och stänger arkivet efteråt */
export async function withZip(file, fn, limits) {
  const z = await openZip(file, limits);
  try { return await fn(z); } finally { await z.close(); }
}
