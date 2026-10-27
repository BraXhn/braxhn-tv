// Bildinformation utan beroenden: format, storlek och EXIF (datum/tid, kamera, objektiv, bländare, slutartid, ISO,
// brännvidd, orientering och GPS) ur JPEG, PNG, GIF, WebP och HEIC/HEIF. Läser bara början av filen (och för HEIC
// den del där EXIF-blocket ligger). Allt indata räknas som fientligt: varje läsning kontrolleras mot buffertens
// längd, antalet poster per katalog är begränsat och en katalog läses aldrig två gånger (ingen oändlig slinga).
import fs from 'node:fs';

export const HEAD = 256 << 10;   // så mycket av filen läses först
const MAX_EXIF = 512 << 10;      // största EXIF-block som läses (HEIC)
const MAX_ENTRIES = 512;         // poster per IFD

// ---------- EXIF (TIFF-struktur) ----------
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
/**
 * Tolkar ett TIFF-block (EXIF utan "Exif\0\0"-prefixet). Ger { date, offset, make, model, lens, orientation, fnumber,
 * exposure, iso, focal, focal35, lat, lon, alt, width, height } – fält som saknas eller är ogiltiga utelämnas.
 */
export function parseTiff(b) {
  if (!b || b.length < 8) return {};
  const bo = b.toString('latin1', 0, 2);
  if (bo !== 'II' && bo !== 'MM') return {};
  const le = bo === 'II';
  const u16 = (o) => o + 2 <= b.length ? (le ? b.readUInt16LE(o) : b.readUInt16BE(o)) : null;
  const u32 = (o) => o + 4 <= b.length ? (le ? b.readUInt32LE(o) : b.readUInt32BE(o)) : null;
  const s32 = (o) => o + 4 <= b.length ? (le ? b.readInt32LE(o) : b.readInt32BE(o)) : null;
  if (u16(2) !== 42) return {};
  const seen = new Set();
  /** En katalog som Map(tagg → värde) */
  function ifd(off) {
    const out = new Map();
    if (off == null || off < 8 || off + 2 > b.length || seen.has(off)) return out;
    seen.add(off);
    const n = Math.min(u16(off), MAX_ENTRIES);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4), size = TYPE_SIZE[type];
      if (!size || !count || count > 1 << 16) continue;
      const bytes = size * count;
      const at = bytes <= 4 ? e + 8 : u32(e + 8);
      if (at == null || at + bytes > b.length) continue;
      const val = (k) => {
        const o = at + k * size;
        switch (type) {
          case 1: case 7: return b[o];
          case 3: return u16(o);
          case 4: return u32(o);
          case 9: return s32(o);
          case 5: { const d = u32(o + 4); return d ? u32(o) / d : null; }
          case 10: { const d = s32(o + 4); return d ? s32(o) / d : null; }
        }
        return null;
      };
      if (type === 2) out.set(tag, b.toString('latin1', at, at + bytes).replace(/\0[\s\S]*$/, '').trim());
      else if (type === 7 && count > 4) out.set(tag, b.subarray(at, at + bytes));
      else out.set(tag, count === 1 ? val(0) : Array.from({ length: Math.min(count, 16) }, (_, k) => val(k)));
    }
    return out;
  }
  const t0 = ifd(u32(4));
  const ex = ifd(t0.get(0x8769));
  const gps = ifd(t0.get(0x8825));
  const r = {};
  const text = (v, max = 80) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || undefined : undefined;
  const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) && Number.isFinite(v[0]) ? v[0] : undefined;
  const date = exifDate(ex.get(0x9003)) ?? exifDate(ex.get(0x9004)) ?? exifDate(t0.get(0x0132));
  if (date != null) r.date = date;
  const offs = text(ex.get(0x9011) || ex.get(0x9010), 10);
  if (offs && /^[+-]\d\d:\d\d$/.test(offs)) r.offset = offs;
  r.make = text(t0.get(0x010F), 60);
  r.model = text(t0.get(0x0110), 80);
  r.lens = text(ex.get(0xA434), 100);
  const o = num(t0.get(0x0112));
  if (o >= 1 && o <= 8) r.orientation = o;
  const f = num(ex.get(0x829D)); if (f > 0 && f < 1000) r.fnumber = Math.round(f * 10) / 10;
  const et = num(ex.get(0x829A)); if (et > 0 && et < 100000) r.exposure = et;
  const iso = num(ex.get(0x8827)); if (iso > 0 && iso < 10000000) r.iso = Math.round(iso);
  const fl = num(ex.get(0x920A)); if (fl > 0 && fl < 100000) r.focal = Math.round(fl * 10) / 10;
  const f35 = num(ex.get(0xA405)); if (f35 > 0 && f35 < 100000) r.focal35 = Math.round(f35);
  const w = num(ex.get(0xA002)), h = num(ex.get(0xA003));
  if (w > 0 && h > 0) { r.width = w; r.height = h; }
  const coord = (v, ref) => {
    if (!Array.isArray(v) || v.length < 3 || v.some(x => typeof x !== 'number' || !Number.isFinite(x))) return undefined;
    const d = v[0] + v[1] / 60 + v[2] / 3600;
    return /^[SW]/i.test(String(ref || '')) ? -d : d;
  };
  const lat = coord(gps.get(2), gps.get(1)), lon = coord(gps.get(4), gps.get(3));
  // 0,0 skriver vissa kameror när de saknar position – räknas som ingen position
  if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
    r.lat = Math.round(lat * 1e6) / 1e6; r.lon = Math.round(lon * 1e6) / 1e6;
    const alt = num(gps.get(6));
    if (alt != null && Math.abs(alt) < 100000) r.alt = Math.round((gps.get(5) === 1 ? -alt : alt) * 10) / 10;
  }
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
  return r;
}
/** "YYYY:MM:DD HH:MM:SS" → väggklockan som UTC-sekunder (tidszonen saknas i EXIF), null om ogiltig */
export function exifDate(v) {
  const m = /^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?/.exec(String(v || '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(x => +(x || 0));
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(t).getUTCDate() === d ? Math.floor(t / 1000) : null;
}
/** EXIF-blocket med eller utan "Exif\0\0" först */
const tiffOf = (b) => b.length >= 6 && b.toString('latin1', 0, 4) === 'Exif' ? b.subarray(6) : b;

// ---------- behållarna ----------
function jpeg(b) {
  const r = { format: 'jpeg' };
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { i += 2; continue; }
    if (m === 0xD9 || m === 0xDA) break;
    const len = b.readUInt16BE(i + 2);
    if (len < 2) break;
    if (m === 0xE1 && !r.tiff && i + 10 <= b.length && b.toString('latin1', i + 4, i + 10) === 'Exif\0\0') r.tiff = b.subarray(i + 10, Math.min(b.length, i + 2 + len));
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC && i + 9 <= b.length) {
      r.height = b.readUInt16BE(i + 5); r.width = b.readUInt16BE(i + 7);
      break;
    }
    i += 2 + len;
  }
  return r;
}
function png(b) {
  const r = { format: 'png' };
  if (b.length >= 24) { r.width = b.readUInt32BE(16); r.height = b.readUInt32BE(20); }
  for (let i = 8; i + 12 <= b.length;) {
    const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8);
    if (type === 'eXIf') { r.tiff = b.subarray(i + 8, Math.min(b.length, i + 8 + len)); break; }
    if (type === 'IEND' || len > b.length) break;
    i += 12 + len;
  }
  return r;
}
function gif(b) { return { format: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) }; }
function webp(b) {
  const r = { format: 'webp' };
  for (let i = 12; i + 8 <= b.length;) {
    const type = b.toString('latin1', i, i + 4), len = b.readUInt32LE(i + 4), d = i + 8;
    if (type === 'VP8X' && d + 10 <= b.length) { r.width = 1 + b.readUIntLE(d + 4, 3); r.height = 1 + b.readUIntLE(d + 7, 3); }
    else if (type === 'VP8 ' && !r.width && d + 10 <= b.length) { r.width = b.readUInt16LE(d + 6) & 0x3fff; r.height = b.readUInt16LE(d + 8) & 0x3fff; }
    else if (type === 'VP8L' && !r.width && d + 5 <= b.length && b[d] === 0x2f) {
      const b1 = b[d + 1], b2 = b[d + 2], b3 = b[d + 3], b4 = b[d + 4];
      r.width = 1 + (((b2 & 0x3F) << 8) | b1); r.height = 1 + (((b4 & 0x0F) << 10) | (b3 << 2) | ((b2 & 0xC0) >> 6));
    } else if (type === 'EXIF') r.tiff = tiffOf(b.subarray(d, Math.min(b.length, d + len)));
    i = d + len + (len & 1);
  }
  return r;
}
/** ISOBMFF-lådor i [start, end): { type, start (innehållet), end } */
function boxes(b, start, end) {
  const out = [];
  for (let i = start; i + 8 <= end && out.length < 4096;) {
    let size = b.readUInt32BE(i), hdr = 8;
    const type = b.toString('latin1', i + 4, i + 8);
    if (size === 1) { if (i + 16 > end) break; const big = Number(b.readBigUInt64BE(i + 8)); size = big; hdr = 16; }
    else if (size === 0) size = end - i;
    if (size < hdr || i + size > end) { out.push({ type, start: i + hdr, end, cut: true }); break; }
    out.push({ type, start: i + hdr, end: i + size });
    i += size;
  }
  return out;
}
/** HEIC/HEIF: storleken (ispe), rotationen (irot) och var EXIF-objektet ligger (iinf + iloc i meta) */
function heif(b) {
  const r = { format: 'heic' };
  const meta = boxes(b, 0, b.length).find(x => x.type === 'meta');
  if (!meta) return r;
  const kids = boxes(b, meta.start + 4, meta.end); // meta är en "full box" (version + flaggor)
  const child = (t) => kids.find(x => x.type === t);
  // Storlek: den största ispe (rutnätet för hela bilden – rutorna är mindre)
  const iprp = child('iprp');
  if (iprp) {
    const ipco = boxes(b, iprp.start, iprp.end).find(x => x.type === 'ipco');
    if (ipco) for (const p of boxes(b, ipco.start, ipco.end)) {
      if (p.type === 'ispe' && p.start + 12 <= b.length) {
        const w = b.readUInt32BE(p.start + 4), h = b.readUInt32BE(p.start + 8);
        if (!r.width || w * h > r.width * r.height) { r.width = w; r.height = h; }
      } else if (p.type === 'irot' && r.irot == null && p.start < b.length) r.irot = b[p.start] & 3;
    }
  }
  // EXIF: objektet av typen 'Exif' i iinf, platsen i iloc
  const iinf = child('iinf'), iloc = child('iloc');
  if (!iinf || !iloc) return r;
  let exifId = null;
  {
    const v = b[iinf.start];
    const first = iinf.start + 4 + (v === 0 ? 2 : 4);
    for (const e of boxes(b, first, iinf.end)) {
      if (e.type !== 'infe' || e.start + 12 > b.length) continue;
      const ver = b[e.start];
      if (ver < 2) continue;
      const id = ver === 2 ? b.readUInt16BE(e.start + 4) : b.readUInt32BE(e.start + 4);
      const tp = b.toString('latin1', e.start + (ver === 2 ? 8 : 10), e.start + (ver === 2 ? 12 : 14));
      if (tp === 'Exif') { exifId = id; break; }
    }
  }
  if (exifId == null) return r;
  let p = iloc.start;
  const ver = b[p]; p += 4;
  if (p + 2 > iloc.end) return r;
  const offSize = b[p] >> 4, lenSize = b[p] & 15, baseSize = b[p + 1] >> 4, idxSize = ver >= 1 ? b[p + 1] & 15 : 0;
  p += 2;
  const rd = (n) => { if (p + n > iloc.end) throw new RangeError('iloc'); let v = 0; for (let k = 0; k < n; k++) v = v * 256 + b[p + k]; p += n; return v; };
  try {
    const count = rd(ver < 2 ? 2 : 4);
    // Storlekarna kan vara 0 byte (rd läser då inget): utan ett tak över alla utsträckningar gav 60 kB
    // 655 miljoner varv och servern stod still. En riktig bild har ett fåtal utsträckningar per objekt.
    let budget = 100000;
    for (let k = 0; k < count && k < 10000; k++) {
      const id = rd(ver < 2 ? 2 : 4);
      const method = ver >= 1 ? rd(2) & 15 : 0;
      rd(2); // data_reference_index
      const base = rd(baseSize), n = rd(2);
      if ((budget -= n + 1) < 0) break;
      let first = null;
      for (let j = 0; j < n; j++) { if (idxSize) rd(idxSize); const o = base + rd(offSize), l = rd(lenSize); if (!first) first = [o, l]; }
      if (id === exifId) { if (method === 0 && first) r.exifAt = { offset: first[0], length: first[1] }; break; }
    }
  } catch {}
  return r;
}
/** EXIF-objektet i HEIF börjar med fyra byte: avståndet till TIFF-huvudet */
export function heifExif(item) {
  if (!item || item.length < 4) return null;
  const skip = item.readUInt32BE(0);
  return 4 + skip <= item.length ? tiffOf(item.subarray(4 + skip)) : null;
}

/** Formatet ur filens första byte */
export function sniff(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpeg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.toString('latin1', 4, 8) === 'ftyp') {
    const brands = b.toString('latin1', 8, Math.min(b.length, 8 + Math.max(8, Math.min(64, b.readUInt32BE(0) - 8))));
    if (/heic|heix|heim|heis|hevc|hevx|mif1|msf1/.test(brands) && !/avif/.test(brands.slice(0, 4))) return 'heic';
  }
  return null;
}

/**
 * Tolkar bildens början. readAt(offset, length) läser en annan del av filen (för HEIC:s EXIF-objekt) – utelämnas den
 * ignoreras EXIF som ligger utanför b.
 * @returns {{ format: string|null, width?: number, height?: number, orientation: number, exif: object }}
 */
export function parseImage(b, readAt = null) {
  const format = sniff(b);
  let c = {};
  try {
    c = format === 'jpeg' ? jpeg(b) : format === 'png' ? png(b) : format === 'gif' ? gif(b) : format === 'webp' ? webp(b) : format === 'heic' ? heif(b) : {};
  } catch { c = { format }; }
  let tiff = c.tiff || null;
  if (format === 'heic' && c.exifAt && c.exifAt.length > 0 && c.exifAt.length <= MAX_EXIF) {
    const { offset, length } = c.exifAt;
    const item = offset + length <= b.length ? b.subarray(offset, offset + length) : readAt ? readAt(offset, length) : null;
    tiff = heifExif(item);
  }
  let exif = {};
  try { exif = parseTiff(tiff); } catch { exif = {}; }
  // HEIF: rotationen står i behållaren (irot) och ffmpeg tillämpar den själv – EXIF-orienteringen gäller inte
  const orientation = format === 'heic' ? 1 : exif.orientation || 1;
  let width = c.width || exif.width, height = c.height || exif.height;
  if (format === 'heic' && (c.irot === 1 || c.irot === 3)) [width, height] = [height, width];
  // Orientering 5–8 vrider bilden en kvarts varv: visningens bredd är filens höjd
  if (orientation >= 5 && width && height) [width, height] = [height, width];
  return { format, width: width || null, height: height || null, orientation, exif };
}

/** Läser bildinformationen ur en fil (början + ev. HEIC:s EXIF-objekt). Kastar vid läsfel. */
export async function readImageInfo(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const st = await fh.stat();
    const head = Buffer.alloc(Math.min(HEAD, st.size));
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const b = head.subarray(0, bytesRead);
    const first = parseImage(b);
    if (first.format !== 'heic' || first.exif.date != null) return first;
    // HEIC: EXIF-objektet ligger ofta efter bilddatan – läs det och tolka om
    const c = heif(b);
    if (!c.exifAt || c.exifAt.length > MAX_EXIF || c.exifAt.offset + c.exifAt.length > st.size) return first;
    const item = Buffer.alloc(c.exifAt.length);
    await fh.read(item, 0, item.length, c.exifAt.offset);
    return parseImage(b, () => item);
  } finally { await fh.close(); }
}

/** ISO 6709 ("+59.3293+018.0686+012.000/", videoklippens plats) → { lat, lon, alt }, null om ogiltig eller 0,0 */
export function iso6709(s) {
  const m = /^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(String(s || '').trim());
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon, alt: m[3] != null ? +m[3] : null };
}
/** Kan ffmpeg-versionen (utdata från ffmpeg -version) avkoda HEIF-bilder (rutnät av HEVC-rutor)? Det kom i 7.1.
 *  Utvecklingsbyggen ("N-…") räknas som nya. */
export function heicFromVersion(text) {
  const m = /ffmpeg version (?:n)?(\d+)\.(\d+)/.exec(String(text || ''));
  if (m) return +m[1] > 7 || (+m[1] === 7 && +m[2] >= 1);
  return /ffmpeg version N-\d+/.test(String(text || ''));
}
