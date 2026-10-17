// Bildundertexter från Blu-ray (PGS) visas i webbspelaren som bilder ovanpå videon i stället för att brännas in.
// Då behöver strömmen varken omkodas eller startas om när undertexten väljs.
// Spåret läses med ffmpeg (-c copy -f sup) och tolkas medan det läses: varje visning blir en PNG i en
// gemensam bildfil och en rad i en tidslista. Spelaren hämtar listan (och nya rader medan läsningen pågår).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { CACHE } from './db.js';
import { send, fail } from './util.js';

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

/** Tolkar en PGS-ström bit för bit. onCue({ s, items: [{ x, y, w, h, png }] }), onClear(pts) */
export class PgsParser {
  constructor({ onCue, onClear }) {
    this.buf = Buffer.alloc(0); this.onCue = onCue; this.onClear = onClear;
    this.palettes = new Map(); this.raw = new Map(); this.objects = new Map(); this.pcs = null; this.w = 0; this.h = 0; this.upto = 0;
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
      if (pcs.state & 0x80) { this.objects.clear(); this.raw.clear(); this.palettes.clear(); } // ny epok
      for (let o = 11, k = 0; k < s[10] && o + 8 <= s.length; k++) {
        // objekt-id (2), fönster (1), beskärning (1), x (2), y (2) [, beskärning x, y, b, h]
        const ob = { id: s.readUInt16BE(o), x: s.readUInt16BE(o + 4), y: s.readUInt16BE(o + 6), crop: null };
        if (s[o + 3] & 0x40 && o + 16 <= s.length) ob.crop = { x: s.readUInt16BE(o + 8), y: s.readUInt16BE(o + 10), w: s.readUInt16BE(o + 12), h: s.readUInt16BE(o + 14) };
        o += ob.crop ? 16 : 8;
        pcs.objs.push(ob);
      }
      this.pcs = pcs; this.w = pcs.w; this.h = pcs.h;
    } else if (type === 0x14 && s.length >= 2) this.palettes.set(s[0], s); // palett (PDS) – omvandlas när den används
    else if (type === 0x15 && s.length >= 4) { // objekt (ODS), kan vara uppdelat på flera segment
      const id = s.readUInt16BE(0), first = s[3] & 0x80;
      if (first) {
        if (s.length < 11) return;
        this.raw.set(id, { w: s.readUInt16BE(7), h: s.readUInt16BE(9), parts: [s.subarray(11)] });
      } else this.raw.get(id)?.parts.push(s.subarray(4));
      if (s[3] & 0x40) { const r = this.raw.get(id); if (r) { this.objects.set(id, { w: r.w, h: r.h, data: Buffer.concat(r.parts) }); this.raw.delete(id); } }
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
        const idx = rle(o.data, o.w, o.h);
        const c = ob.crop ? { x: Math.min(ob.crop.x, o.w - 1), y: Math.min(ob.crop.y, o.h - 1), w: ob.crop.w, h: ob.crop.h } : { x: 0, y: 0, w: o.w, h: o.h };
        c.w = Math.max(1, Math.min(c.w, o.w - c.x)); c.h = Math.max(1, Math.min(c.h, o.h - c.y));
        const rgba = Buffer.alloc(c.w * c.h * 4);
        let any = false;
        for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
          const p = idx[(y + c.y) * o.w + x + c.x] * 4, q = (y * c.w + x) * 4;
          rgba[q] = pal[p]; rgba[q + 1] = pal[p + 1]; rgba[q + 2] = pal[p + 2]; rgba[q + 3] = pal[p + 3];
          if (pal[p + 3]) any = true;
        }
        if (any) items.push({ x: ob.x, y: ob.y, w: c.w, h: c.h, png: png(c.w, c.h, rgba) });
      }
      if (items.length) this.onCue({ s: pcs.pts, items });
    }
  }
}

// ---------------- jobb och cache ----------------
// Ett jobb per fil och spår. Färdiga jobb sparas som <nyckel>.json (tidslista) + <nyckel>.bin (bilderna).
const jobs = new Map();
let active = 0; const waiting = [];
const keyOf = (it, sid) => `${it.id}-${it.mtime}-${sid}`;

function load(key) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, key + '.json'), 'utf8'));
    if (fs.statSync(path.join(DIR, key + '.bin')).size >= (j.bytes || 0)) return { ...j, done: true, bin: path.join(DIR, key + '.bin') };
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
  try { for (const f of fs.readdirSync(DIR)) if (f.startsWith(`${it.id}-`) && f.endsWith(`-${sub.id}.json`) || f.startsWith(`${it.id}-`) && f.endsWith(`-${sub.id}.bin`)) fs.rmSync(path.join(DIR, f), { force: true }); } catch {}
  const bin = path.join(DIR, key + '.bin.part');
  const j = { key, w: 0, h: 0, cues: [], images: [], bytes: 0, upto: 0, done: false, error: null, bin, last: Date.now() };
  jobs.set(key, j);
  const fd = fs.openSync(bin, 'w');
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
    // Kvar i minnet en stund så att spelaren hinner läsa slutet; sedan från cachen (eller nytt försök)
    setTimeout(() => { if (jobs.get(key) === j) jobs.delete(key); if (!ok) fs.rmSync(bin, { force: true }); }, 120000).unref();
  };
  const parser = new PgsParser({
    onClear: (pts) => { const last = j.cues[j.cues.length - 1]; if (last && last.e == null && pts >= last.s) last.e = pts; },
    onCue: (c) => {
      const last = j.cues[j.cues.length - 1];
      if (last && last.e == null) last.e = c.s;
      const items = c.items.map(x => {
        fs.writeSync(fd, x.png);
        j.images.push([j.bytes, x.png.length]); j.bytes += x.png.length;
        return [x.x, x.y, x.w, x.h, j.images.length - 1];
      });
      j.cues.push({ s: Math.round(c.s * 1000) / 1000, e: null, i: items });
    }
  });
  const run = () => {
    active++;
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', it.path,
      '-map', '0:' + sub.id.slice(1), '-c', 'copy', '-f', 'sup', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', c => { err = (err + c).slice(-1000); });
    p.stdout.on('data', (c) => {
      try { parser.push(c); j.w = parser.w || j.w; j.h = parser.h || j.h; j.upto = parser.upto; }
      catch (e) { console.warn('[pgs] tolkning:', e.message); p.kill('SIGKILL'); }
      // Ingen tittar längre – avbryt (jobbet startas om nästa gång)
      if (Date.now() - j.last > 10 * 60e3) p.kill('SIGKILL');
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), 60 * 60e3);
    const done = (ok, e) => { clearTimeout(timer); active--; waiting.shift()?.(); finish(ok, e); };
    p.on('error', (e) => done(false, e.message));
    p.on('close', (code) => {
      const last = j.cues[j.cues.length - 1];
      if (last && last.e == null) last.e = last.s + 5;
      if (code !== 0) console.warn('[pgs]', it.path, err.trim());
      done(code === 0, code === 0 ? null : 'Kunde inte läsa undertexten');
    });
  };
  if (active >= 2) waiting.push(run); else run();
  return j;
}

/** Tidslistan (allt som tolkats hittills). Spelaren frågar igen så länge done är false. */
export function serveIndex(res, it, sub) {
  const j = job(it, sub);
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
