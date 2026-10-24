// Bildundertexter från Blu-ray (PGS) visas i webbspelaren som bilder ovanpå videon i stället för att brännas in.
// Då behöver strömmen varken omkodas eller startas om när undertexten väljs.
// Spåret läses med ffmpeg (-c copy -f sup) och tolkas medan det läses: varje visning blir en PNG i en
// gemensam bildfil och en rad i en tidslista. Spelaren hämtar listan (och nya rader medan läsningen pågår).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CACHE } from './db.js';
import { send, fail } from './util.js';
import { SubReader } from './subreader.js';

const DIR = path.join(CACHE, 'pgs');

// ---------------- PNG ----------------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(...bufs) { let c = -1; for (const b of bufs) for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'latin1'), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(t, data));
  return Buffer.concat([len, t, data, crc]);
}
export function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------- PGS ----------------
/** RLE-avkodning av ett PGS-objekt till palettindex (w*h). Trasiga data ger det som hunnit avkodas. */
export function rle(data, w, h) {
  const out = new Uint8Array(w * h);
  let i = 0, x = 0, y = 0;
  const put = (n, c) => { for (let k = 0; k < n && x < w; k++) out[y * w + x++] = c; };
  while (i < data.length && y < h) {
    const b = data[i++];
    if (b) { put(1, b); continue; }
    if (i >= data.length) break;
    const f = data[i++];
    if (f === 0) { x = 0; y++; continue; }
    const long = f & 0x40, color = f & 0x80;
    let n = f & 0x3f;
    if (long) { if (i >= data.length) break; n = (n << 8) | data[i++]; }
    let c = 0;
    if (color) { if (i >= data.length) break; c = data[i++]; }
    put(n, c);
  }
  return out;
}
function palette(seg, hd) {
  const p = new Uint8Array(256 * 4);
  for (let o = 2; o + 5 <= seg.length; o += 5) {
    const id = seg[o], Y = seg[o + 1] - 16, Cr = seg[o + 2] - 128, Cb = seg[o + 3] - 128, A = seg[o + 4];
    const [r, g, b] = hd ? [1.164 * Y + 1.793 * Cr, 1.164 * Y - 0.213 * Cb - 0.533 * Cr, 1.164 * Y + 2.112 * Cb]
      : [1.164 * Y + 1.596 * Cr, 1.164 * Y - 0.392 * Cb - 0.813 * Cr, 1.164 * Y + 2.017 * Cb];
    p.set([r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v)))), id * 4);
    p[id * 4 + 3] = A;
  }
  return p;
}

// Skydd mot fientliga filer: några få byte kan annars beskriva enorma bilder som refereras om och om igen
// (en 16 kB fil låste servern i närmare en minut). Blu-ray tillåter högst två objekt per visning.
const MAX_OBJS = 2;
const MAX_PIXELS = 2e9;      // bildpunkter som får ritas per spår (en hel film brukar ligga under 0,5 miljarder)
const MAX_OBJ_BYTES = 16 << 20; // ett objekts RLE-data (längdfältet är 24 bitar)

/** Tolkar en PGS-ström bit för bit. onCue({ s, items: [{ x, y, w, h, png }] }), onClear(pts) */
export class PgsParser {
  constructor({ onCue, onClear }) {
    this.buf = Buffer.alloc(0); this.onCue = onCue; this.onClear = onClear;
    this.palettes = new Map(); this.raw = new Map(); this.objects = new Map(); this.pcs = null; this.w = 0; this.h = 0; this.upto = 0;
    this.gen = 0; this.pixels = 0; this.rendered = new Map(); // oförändrat objekt + palett + beskärning ritas bara en gång
  }
  push(data) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    let i = 0;
    while (this.buf.length - i >= 13) {
      if (this.buf[i] !== 0x50 || this.buf[i + 1] !== 0x47) { i++; continue; } // "PG" – synka om efter skräp
      const size = this.buf.readUInt16BE(i + 11);
      if (this.buf.length - i < 13 + size) break;
      this.segment(this.buf[i + 10], this.buf.readUInt32BE(i + 2) / 90000, this.buf.subarray(i + 13, i + 13 + size));
      i += 13 + size;
    }
    this.buf = Buffer.from(this.buf.subarray(i));
  }
  segment(type, pts, s) {
    this.upto = Math.max(this.upto, pts);
    if (type === 0x16 && s.length >= 11) { // presentation (PCS)
      const pcs = { pts, w: s.readUInt16BE(0), h: s.readUInt16BE(2), state: s[7], pal: s[9], objs: [] };
      if (pcs.state & 0x80) { this.objects.clear(); this.raw.clear(); this.palettes.clear(); this.rendered.clear(); } // ny epok
      for (let o = 11, k = 0; k < Math.min(s[10], MAX_OBJS) && o + 8 <= s.length; k++) {
        // objekt-id (2), fönster (1), beskärning (1), x (2), y (2) [, beskärning x, y, b, h]
        const ob = { id: s.readUInt16BE(o), x: s.readUInt16BE(o + 4), y: s.readUInt16BE(o + 6), crop: null };
        if (s[o + 3] & 0x40 && o + 16 <= s.length) ob.crop = { x: s.readUInt16BE(o + 8), y: s.readUInt16BE(o + 10), w: s.readUInt16BE(o + 12), h: s.readUInt16BE(o + 14) };
        o += ob.crop ? 16 : 8;
        pcs.objs.push(ob);
      }
      this.pcs = pcs; this.w = pcs.w; this.h = pcs.h;
    } else if (type === 0x14 && s.length >= 2) { s.gen = ++this.gen; this.palettes.set(s[0], s); } // palett (PDS) – omvandlas när den används
    else if (type === 0x15 && s.length >= 4) { // objekt (ODS), kan vara uppdelat på flera segment
      const id = s.readUInt16BE(0), first = s[3] & 0x80;
      if (first) {
        if (s.length < 11) return;
        this.raw.set(id, { w: s.readUInt16BE(7), h: s.readUInt16BE(9), parts: [s.subarray(11)], size: s.length - 11 });
      } else {
        const r = this.raw.get(id);
        if (r) { r.parts.push(s.subarray(4)); r.size += s.length - 4; if (r.size > MAX_OBJ_BYTES) this.raw.delete(id); }
      }
      if (s[3] & 0x40) { const r = this.raw.get(id); if (r) { this.objects.set(id, { w: r.w, h: r.h, data: Buffer.concat(r.parts), gen: ++this.gen }); this.raw.delete(id); } }
    } else if (type === 0x80 && this.pcs) { // slut på visningen
      const pcs = this.pcs; this.pcs = null;
      this.onClear(pcs.pts);
      const pds = this.palettes.get(pcs.pal);
      if (!pcs.objs.length || !pds) return;
      const pal = palette(pds, pcs.h >= 720);
      const items = [];
      for (const ob of pcs.objs) {
        const o = this.objects.get(ob.id);
        if (!o || !o.w || !o.h || o.w * o.h > 4096 * 2304) continue;
        const c = ob.crop ? { x: Math.min(ob.crop.x, o.w - 1), y: Math.min(ob.crop.y, o.h - 1), w: ob.crop.w, h: ob.crop.h } : { x: 0, y: 0, w: o.w, h: o.h };
        c.w = Math.max(1, Math.min(c.w, o.w - c.x)); c.h = Math.max(1, Math.min(c.h, o.h - c.y));
        const rkey = `${ob.id}:${o.gen}:${pds.gen}:${c.x},${c.y},${c.w},${c.h}`;
        if (this.rendered.has(rkey)) { const png = this.rendered.get(rkey); if (png) items.push({ x: ob.x, y: ob.y, w: c.w, h: c.h, png }); continue; }
        // Avkodningen kostar hela objektets yta, även när bara en liten del visas
        if ((this.pixels += o.w * o.h + c.w * c.h) > MAX_PIXELS) throw new Error('orimligt stora bilder – filen är trasig eller skadlig');
        const idx = rle(o.data, o.w, o.h);
        const rgba = Buffer.alloc(c.w * c.h * 4);
        let any = false;
        for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
          const p = idx[(y + c.y) * o.w + x + c.x] * 4, q = (y * c.w + x) * 4;
          rgba[q] = pal[p]; rgba[q + 1] = pal[p + 1]; rgba[q + 2] = pal[p + 2]; rgba[q + 3] = pal[p + 3];
          if (pal[p + 3]) any = true;
        }
        const out = any ? png(c.w, c.h, rgba) : null;
        this.rendered.set(rkey, out);
        if (this.rendered.size > 16) this.rendered.delete(this.rendered.keys().next().value);
        if (out) items.push({ x: ob.x, y: ob.y, w: c.w, h: c.h, png: out });
      }
      if (items.length) this.onCue({ s: pcs.pts, items });
    }
  }
}

// ---------------- jobb och cache ----------------
// Ett jobb per fil och spår. Färdiga jobb sparas som <nyckel>.json (tidslista) + <nyckel>.bin (bilderna).
const jobs = new Map();
const keyOf = (it, sid) => `${it.id}-${it.mtime}-${sid}`;

// De senast använda färdiga spåren hålls i minnet (varje bild skulle annars läsa om hela tidslistan)
const loaded = new Map();
function load(key) {
  const m = loaded.get(key);
  if (m) { loaded.delete(key); loaded.set(key, m); return m; }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, key + '.json'), 'utf8'));
    if (fs.statSync(path.join(DIR, key + '.bin')).size >= (j.bytes || 0)) {
      const r = { ...j, done: true, bin: path.join(DIR, key + '.bin') };
      loaded.set(key, r);
      if (loaded.size > 8) loaded.delete(loaded.keys().next().value);
      return r;
    }
  } catch {}
  return null;
}

export function job(it, sub) {
  const key = keyOf(it, sub.id);
  const running = jobs.get(key);
  if (running) { running.last = Date.now(); return running; }
  const cached = load(key);
  if (cached) return cached;
  fs.mkdirSync(DIR, { recursive: true });
  // Gamla cachefiler för samma titel och spår (filen har ändrats) tas bort
  // (även halvfärdiga rester efter en omstart mitt i ett jobb)
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (f.startsWith(`${it.id}-`) && /^(.+)\.(json|bin|bin\.part|json\.tmp)$/.exec(f)?.[1].endsWith(`-${sub.id}`)) fs.rmSync(path.join(DIR, f), { force: true });
    }
  } catch {}
  const bin = path.join(DIR, key + '.bin.part');
  const j = { key, w: 0, h: 0, cues: [], images: [], bytes: 0, upto: 0, done: false, error: null, bin, last: Date.now(), reader: null };
  let fd;
  try { fd = fs.openSync(bin, 'w'); } catch { j.done = true; j.error = 'Kunde inte skriva undertextcachen'; return j; }
  jobs.set(key, j);
  // Övergivet jobb (spelaren stängd mitt i läsningen): läsaren stoppar ffmpeg efter två minuter utan frågor,
  // men då körs aldrig finish – utan den här städningen låg filhandtag, .part-fil och bilder kvar för alltid
  j.abort = () => {
    if (j.done) return;
    j.done = true; j.error = 'Avbruten';
    j.reader?.close();
    try { fs.closeSync(fd); } catch {}
    fs.rmSync(bin, { force: true });
    j.cues = []; j.images = [];
    if (jobs.get(key) === j) jobs.delete(key);
  };
  const finish = (ok, err) => {
    if (j.done) return;
    j.done = true; j.error = err || null;
    try { fs.closeSync(fd); } catch {}
    if (ok) {
      try {
        fs.renameSync(bin, path.join(DIR, key + '.bin'));
        j.bin = path.join(DIR, key + '.bin');
        fs.writeFileSync(path.join(DIR, key + '.json.tmp'), JSON.stringify({ w: j.w, h: j.h, cues: j.cues, images: j.images, bytes: j.bytes, upto: j.upto }));
        fs.renameSync(path.join(DIR, key + '.json.tmp'), path.join(DIR, key + '.json'));
      } catch (e) { console.warn('[pgs] kunde inte spara', e.message); }
    }
    // Kvar i minnet en stund så att spelaren hinner läsa slutet; sedan från cachen. Ett misslyckat spår
    // (trasigt eller över gränserna) försöks inte igen förrän efter 30 min – det kostar en hel genomläsning.
    if (!ok) { console.warn('[pgs]', it.path, err); fs.rmSync(bin, { force: true }); j.cues = []; j.images = []; }
    setTimeout(() => { if (jobs.get(key) === j) jobs.delete(key); }, ok ? 120000 : 30 * 60e3).unref();
  };
  // Visningarna hålls sorterade på starttid: läsningen börjar där tittaren är och fyller i resten efteråt
  const insert = (cue) => {
    let lo = 0, hi = j.cues.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (j.cues[m].s < cue.s) lo = m + 1; else hi = m; }
    if (j.cues[lo]?.s === cue.s) return j.cues[lo]; // redan läst (två läsningar överlappar)
    j.cues.splice(lo, 0, cue);
    return cue;
  };
  j.reader = new SubReader({
    file: it.path, stream: +sub.id.slice(1), format: 'sup', duration: it.duration || 0, title: it.title,
    parser: () => {
      let open = null; // den här körningens visning som ännu inte tagits bort
      const p = new PgsParser({
        onClear: (pts) => { if (open && open.e == null && pts >= open.s) open.e = pts; open = null; },
        onCue: (c) => {
          if (open && open.e == null) open.e = c.s;
          const s = Math.round(c.s * 1000) / 1000;
          const found = j.cues.find(x => x.s === s);
          if (found) { open = found; return; }
          const items = c.items.map(x => {
            fs.writeSync(fd, x.png);
            j.images.push([j.bytes, x.png.length]); j.bytes += x.png.length;
            return [x.x, x.y, x.w, x.h, j.images.length - 1];
          });
          open = insert({ s, e: null, i: items });
        }
      });
      return {
        push(c) { p.push(c); j.w = p.w || j.w; j.h = p.h || j.h; j.upto = Math.max(j.upto, p.upto); },
        end() { if (open && open.e == null) open.e = open.s + 5; open = null; }
      };
    },
    onComplete: () => finish(true),
    onError: (msg) => finish(false, 'Kunde inte läsa undertexten' + (msg ? ` (${msg.split('\n')[0].slice(0, 120)})` : ''))
  });
  return j;
}

// Jobb som inte är klara och inte frågats på 30 min städas bort (nästa fråga börjar om från cachen eller på nytt)
const STALE_MS = 30 * 60e3;
export function sweep(now = Date.now()) {
  for (const j of [...jobs.values()]) if (!j.done && now - j.last > STALE_MS) j.abort();
}
setInterval(sweep, 60e3).unref();
// För tester
export const _jobs = jobs;

/** Tidslistan (allt som tolkats hittills). Spelaren frågar igen så länge done är false. */
export async function serveIndex(res, it, sub, t = 0) {
  const j = job(it, sub);
  j.reader?.want(t); // läs där tittaren är först
  for (let k = 0; k < 25 && j.reader && !j.done && !j.reader.covers(t + 15); k++) await new Promise(r => setTimeout(r, 100));
  send(res, 200, { w: j.w, h: j.h, done: j.done, error: j.error, upto: j.upto, cues: j.cues },
    { 'Cache-Control': j.done ? 'private, max-age=3600' : 'no-store' });
}
export function serveImage(req, res, it, sub, n) {
  const j = job(it, sub);
  const im = j.images[n];
  if (!Number.isInteger(n) || !im) return fail(res, 404, 'Bilden finns inte');
  let fd;
  try {
    fd = fs.openSync(j.bin, 'r');
    const b = Buffer.alloc(im[1]);
    fs.readSync(fd, b, 0, im[1], im[0]);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': b.length, 'Cache-Control': 'private, max-age=86400' });
    res.end(req.method === 'HEAD' ? undefined : b);
  } catch { fail(res, 404, 'Bilden finns inte'); }
  finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}
