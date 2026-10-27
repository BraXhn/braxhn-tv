// Handskrivna EXIF-block för testerna (test/photos.test.js): ett TIFF-block med IFD0, Exif-IFD och GPS-IFD, och
// funktioner som stoppar in det i JPEG (APP1), PNG (eXIf), WebP (EXIF-chunk) eller en minimal HEIF-behållare.
const TYPES = { byte: 1, ascii: 2, short: 3, long: 4, rational: 5, undefined: 7, srational: 10 };

/**
 * tags: { ifd0: [[tagg, typ, värde]], exif: [...], gps: [...] }; värde = sträng (ascii), tal eller lista.
 * Rationella tal anges som [täljare, nämnare] (eller en lista av sådana).
 */
export function tiff({ ifd0 = [], exif = [], gps = [] } = {}, le = true) {
  const parts = [];
  const w16 = (v) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return b; };
  const w32 = (v) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(v >>> 0) : b.writeUInt32BE(v >>> 0); return b; };
  const s32 = (v) => { const b = Buffer.alloc(4); le ? b.writeInt32LE(v) : b.writeInt32BE(v); return b; };
  const enc = (type, v) => {
    const t = TYPES[type];
    if (t === 2) { const s = Buffer.from(String(v) + '\0', 'latin1'); return { t, count: s.length, data: s }; }
    const list = t === 5 || t === 10 ? (Array.isArray(v[0]) ? v : [v]) : Array.isArray(v) ? v : [v];
    const data = Buffer.concat(list.map(x => t === 1 || t === 7 ? Buffer.from([x]) : t === 3 ? w16(x) : t === 4 ? w32(x)
      : t === 5 ? Buffer.concat([w32(x[0]), w32(x[1])]) : Buffer.concat([s32(x[0]), s32(x[1])])));
    return { t, count: list.length, data };
  };
  // Layout: huvud (8) | IFD0 | Exif-IFD | GPS-IFD | data
  const ifdSize = (n) => 2 + n * 12 + 4;
  const e0 = [...ifd0], ee = [...exif], eg = [...gps];
  if (ee.length) e0.push([0x8769, 'long', 0]);
  if (eg.length) e0.push([0x8825, 'long', 0]);
  const off0 = 8, offE = off0 + ifdSize(e0.length), offG = offE + (ee.length ? ifdSize(ee.length) : 0);
  let dataAt = offG + (eg.length ? ifdSize(eg.length) : 0);
  const blobs = [];
  const build = (entries) => {
    entries.sort((a, b) => a[0] - b[0]);
    const out = [w16(entries.length)];
    for (const [tag, type, v0] of entries) {
      const v = tag === 0x8769 ? offE : tag === 0x8825 ? offG : v0;
      const { t, count, data } = enc(type, v);
      const ent = Buffer.alloc(12);
      ent.set(w16(tag), 0); ent.set(w16(t), 2); ent.set(w32(count), 4);
      if (data.length <= 4) ent.set(data, 8);
      else { ent.set(w32(dataAt), 8); blobs.push(data); dataAt += data.length + (data.length & 1); if (data.length & 1) blobs.push(Buffer.alloc(1)); }
      out.push(ent);
    }
    out.push(w32(0));
    return Buffer.concat(out);
  };
  parts.push(Buffer.from(le ? 'II' : 'MM', 'latin1'), w16(42), w32(off0), build(e0));
  if (ee.length) parts.push(build(ee));
  if (eg.length) parts.push(build(eg));
  return Buffer.concat([...parts, ...blobs]);
}

/** Vanliga taggar från en telefon */
export function phoneExif({ date = '2021:06:15 14:05:30', orientation = 1, lat = null, lon = null, make = 'Apple', model = 'iPhone 12',
  lens = 'iPhone 12 back camera 4.2mm f/1.6', fnumber = [16, 10], exposure = [1, 120], iso = 64, focal = [42, 10], le = true } = {}) {
  const ifd0 = [[0x010F, 'ascii', make], [0x0110, 'ascii', model], [0x0112, 'short', orientation], [0x0132, 'ascii', '2022:01:01 00:00:00']];
  const exif = [[0x9003, 'ascii', date], [0x829A, 'rational', exposure], [0x829D, 'rational', fnumber], [0x8827, 'short', iso],
    [0x920A, 'rational', focal], [0xA434, 'ascii', lens], [0x9011, 'ascii', '+02:00']];
  const dms = (v) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60 * 1000); return [[d, 1], [m, 1], [s, 1000]]; };
  const gps = lat == null ? [] : [[1, 'ascii', lat < 0 ? 'S' : 'N'], [2, 'rational', dms(lat)], [3, 'ascii', lon < 0 ? 'W' : 'E'], [4, 'rational', dms(lon)],
    [5, 'byte', 0], [6, 'rational', [125, 10]]];
  return tiff({ ifd0, exif, gps }, le);
}

/** Lägger EXIF som APP1 direkt efter SOI i en JPEG-fil */
export function jpegWithExif(jpg, t) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const seg = Buffer.alloc(4); seg[0] = 0xFF; seg[1] = 0xE1; seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpg.subarray(0, 2), seg, payload, jpg.subarray(2)]);
}
/** Lägger eXIf-chunken efter IHDR i en PNG-fil (CRC räknas inte – läsaren kontrollerar den inte) */
export function pngWithExif(png, t) {
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  const head = Buffer.alloc(8); head.writeUInt32BE(t.length, 0); head.write('eXIf', 4, 'latin1');
  return Buffer.concat([png.subarray(0, ihdrEnd), head, t, Buffer.alloc(4), png.subarray(ihdrEnd)]);
}
/** Lägger en EXIF-chunk sist i en WebP-fil (och rättar RIFF-storleken) */
export function webpWithExif(webp, t) {
  const head = Buffer.alloc(8); head.write('EXIF', 0, 'latin1'); head.writeUInt32LE(t.length, 4);
  const out = Buffer.concat([webp, head, t, t.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

// ---- minimal HEIF (bara lådorna som läsaren tittar på – ingen riktig bild) ----
const box = (type, ...body) => { const b = Buffer.concat(body); const h = Buffer.alloc(8); h.writeUInt32BE(b.length + 8); h.write(type, 4, 'latin1'); return Buffer.concat([h, b]); };
const full = (v, flags = 0) => { const b = Buffer.alloc(4); b[0] = v; b.writeUIntBE(flags, 1, 3); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
/** HEIF med ett bildobjekt (1, 'hvc1') och ett EXIF-objekt (2) som ligger i mdat efter metadatan */
export function heifWithExif(t, { width = 4032, height = 3024, irot = null, padding = 0 } = {}) {
  const exifItem = Buffer.concat([u32(6), Buffer.from('Exif\0\0', 'latin1'), t]);
  const ftyp = box('ftyp', Buffer.from('heic', 'latin1'), u32(0), Buffer.from('mif1heic', 'latin1'));
  const infe = (id, type) => box('infe', full(2), u16(id), u16(0), Buffer.from(type, 'latin1'), Buffer.from('\0', 'latin1'));
  const iinf = box('iinf', full(0), u16(2), infe(1, 'hvc1'), infe(2, 'Exif'));
  const ipco = box('ipco', box('ispe', full(0), u32(512), u32(512)), box('ispe', full(0), u32(width), u32(height)),
    ...(irot != null ? [box('irot', Buffer.from([irot]))] : []));
  const iprp = box('iprp', ipco);
  const ilocFor = (exifOffset) => box('iloc', full(1), Buffer.from([0x44, 0x00]), u16(2),
    u16(1), u16(0), u16(0), u16(1), u32(0), u32(0),
    u16(2), u16(0), u16(0), u16(1), u32(exifOffset), u32(exifItem.length));
  const metaFor = (off) => box('meta', full(0), box('hdlr', full(0), u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(13)), box('pitm', full(0), u16(1)), iinf, ilocFor(off), iprp);
  const pre = ftyp.length + metaFor(0).length;
  const mdat = box('mdat', Buffer.alloc(padding), exifItem);
  return Buffer.concat([ftyp, metaFor(pre + 8 + padding), mdat]);
}

/**
 * Fientlig HEIC: iloc med offset_size/length_size 0 (inga byte per utsträckning) och 10 000 poster med 65 535
 * utsträckningar var – 60 kB som utan gräns gav 655 miljoner varv i läsaren (servern stod still i 40 s).
 */
export function heifIlocBomb(items = 10000) {
  const ftyp = box('ftyp', Buffer.from('heic', 'latin1'), u32(0), Buffer.from('mif1heic', 'latin1'));
  const iinf = box('iinf', full(0), u16(1), box('infe', full(2), u16(1), u16(0), Buffer.from('Exif\0', 'latin1')));
  const entries = Buffer.concat(Array.from({ length: items }, () => Buffer.concat([u16(2), u16(0), u16(65535)])));
  const iloc = box('iloc', full(0), Buffer.from([0x00, 0x00]), u16(items), entries);
  return Buffer.concat([ftyp, box('meta', full(0), iinf, iloc)]);
}
