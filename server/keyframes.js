// Snabb indexering av nyckelbilder utan att läsa hela filen.
// MKV: indexet (Cues) i slutet av filen. MP4: tabellerna i moov (stss/stts/ctts/elst).
// Resultatet kontrolleras mot några korta stickprov med ffprobe; stämmer det inte används den långsamma vägen.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

async function reader(file) {
  const fh = await fs.promises.open(file, 'r');
  const size = (await fh.stat()).size;
  const read = async (pos, len) => {
    len = Math.max(0, Math.min(len, size - pos));
    const b = Buffer.alloc(len);
    let got = 0;
    while (got < len) { const { bytesRead } = await fh.read(b, got, len - got, pos + got); if (!bytesRead) break; got += bytesRead; }
    return b.subarray(0, got);
  };
  return { fh, size, read };
}

// ---------------- Matroska ----------------
const ID = { SEGMENT: 0x18538067, SEEKHEAD: 0x114D9B74, SEEK: 0x4DBB, SEEKID: 0x53AB, SEEKPOS: 0x53AC, INFO: 0x1549A966, SCALE: 0x2AD7B1,
  TRACKS: 0x1654AE6B, TRACK: 0xAE, TNUM: 0xD7, TTYPE: 0x83, CUES: 0x1C53BB6B, CUEPOINT: 0xBB, CUETIME: 0xB3, CUEPOS: 0xB7, CUETRACK: 0xF7, CLUSTER: 0x1F43B675 };

/** Läser ett EBML-huvud (id + storlek) på position i buffert. null = trasigt. size -1 = okänd storlek */
export function ebmlHeader(b, i) {
  if (i >= b.length) return null;
  const f = b[i]; let l = 1;
  while (l <= 4 && !(f & (0x80 >> (l - 1)))) l++;
  if (l > 4 || i + l > b.length) return null;
  let id = 0; for (let k = 0; k < l; k++) id = id * 256 + b[i + k];
  const s0 = i + l; if (s0 >= b.length) return null;
  const g = b[s0]; let n = 1;
  while (n <= 8 && !(g & (0x80 >> (n - 1)))) n++;
  if (n > 8 || s0 + n > b.length) return null;
  let size = g & (0xff >> n), all = size === (0xff >> n);
  for (let k = 1; k < n; k++) { size = size * 256 + b[s0 + k]; if (b[s0 + k] !== 0xff) all = false; }
  return { id, size: all ? -1 : size, data: s0 + n };
}
const uint = (b) => { let v = 0; for (const x of b) v = v * 256 + x; return v; };
function* children(b, start = 0, end = b.length) {
  let i = start;
  while (i < end) {
    const h = ebmlHeader(b, i);
    if (!h || h.size < 0 || h.data + h.size > end) return;
    yield { id: h.id, body: b.subarray(h.data, h.data + h.size) };
    i = h.data + h.size;
  }
}

/** Nyckelbilder (s) för första videospåret ur ett Cues-element */
export function parseCues(cues, track, scale) {
  const out = [];
  for (const cp of children(cues)) {
    if (cp.id !== ID.CUEPOINT) continue;
    let t = null, hit = false;
    for (const e of children(cp.body)) {
      if (e.id === ID.CUETIME) t = uint(e.body);
      else if (e.id === ID.CUEPOS) for (const x of children(e.body)) if (x.id === ID.CUETRACK && uint(x.body) === track) hit = true;
    }
    if (hit && t != null) out.push(t * scale / 1e9);
  }
  return out;
}

async function mkvKeyframes(r) {
  const head = await r.read(0, 64 << 10);
  const ebml = ebmlHeader(head, 0);
  if (!ebml || ebml.id !== 0x1A45DFA3) return null;
  const seg = ebmlHeader(head, ebml.data + ebml.size);
  if (!seg || seg.id !== ID.SEGMENT) return null;
  const segStart = seg.data;
  let scale = 1e6, track = null, cuesPos = null, pos = segStart;
  // Toppnivån fram till första klustret (SeekHead, Info, Tracks) – sedan direkt till Cues
  for (let k = 0; k < 64 && pos < r.size; k++) {
    const hb = await r.read(pos, 16), h = ebmlHeader(hb, 0);
    if (!h || h.size < 0) return null;
    const body = pos + h.data, end = body + h.size;
    if (h.id === ID.CLUSTER) { if (cuesPos == null) return null; break; }
    if ([ID.SEEKHEAD, ID.INFO, ID.TRACKS, ID.CUES].includes(h.id) && h.size < (16 << 20)) {
      const b = await r.read(body, h.size);
      if (h.id === ID.SEEKHEAD) for (const s of children(b)) {
        if (s.id !== ID.SEEK) continue;
        let sid = null, sp = null;
        for (const x of children(s.body)) { if (x.id === ID.SEEKID) sid = uint(x.body); else if (x.id === ID.SEEKPOS) sp = uint(x.body); }
        if (sid === ID.CUES && sp != null) cuesPos = segStart + sp;
      } else if (h.id === ID.INFO) { for (const x of children(b)) if (x.id === ID.SCALE) scale = uint(x.body) || 1e6; }
      else if (h.id === ID.TRACKS) for (const t of children(b)) {
        if (t.id !== ID.TRACK || track != null) continue;
        let num = null, type = null;
        for (const x of children(t.body)) { if (x.id === ID.TNUM) num = uint(x.body); else if (x.id === ID.TTYPE) type = uint(x.body); }
        if (type === 1) track = num;
      } else if (h.id === ID.CUES) cuesPos = pos;
    }
    pos = end;
  }
  if (track == null || cuesPos == null) return null;
  const hb = await r.read(cuesPos, 16), h = ebmlHeader(hb, 0);
  if (!h || h.id !== ID.CUES || h.size < 0 || h.size > (256 << 20)) return null;
  return parseCues(await r.read(cuesPos + h.data, h.size), track, scale);
}

// ---------------- MP4 ----------------
function* boxes(b, start = 0, end = b.length) {
  let i = start;
  while (i + 8 <= end) {
    let size = b.readUInt32BE(i), hdr = 8;
    const type = b.toString('latin1', i + 4, i + 8);
    if (size === 1) { if (i + 16 > end) return; size = Number(b.readBigUInt64BE(i + 8)); hdr = 16; }
    else if (size === 0) size = end - i;
    if (size < hdr || i + size > end) return;
    yield { type, body: b.subarray(i + hdr, i + size) };
    i += size;
  }
}
const find = (b, ...path) => { let cur = b; for (const t of path) { cur = [...boxes(cur)].find(x => x.type === t)?.body; if (!cur) return null; } return cur; };

/** Nyckelbilder (s, presentationstid) ur en moov-box */
export function parseMoov(moov) {
  for (const trak of boxes(moov)) {
    if (trak.type !== 'trak') continue;
    const hdlr = find(trak.body, 'mdia', 'hdlr');
    if (!hdlr || hdlr.toString('latin1', 8, 12) !== 'vide') continue;
    const mdhd = find(trak.body, 'mdia', 'mdhd'), stbl = find(trak.body, 'mdia', 'minf', 'stbl');
    if (!mdhd || !stbl) return null;
    const ts = mdhd[0] === 1 ? mdhd.readUInt32BE(20) : mdhd.readUInt32BE(12);
    const stts = find(stbl, 'stts'), ctts = find(stbl, 'ctts'), stss = find(stbl, 'stss');
    if (!ts || !stts) return null;
    // Edit list: första mediatiden som visas
    // Edit list: tomma redigeringar först skjuter fram bilden, första mediatiden som visas dras av
    let shift = 0, empty = 0;
    const elst = find(trak.body, 'edts', 'elst'), mvhd = find(moov, 'mvhd');
    const mts = mvhd ? (mvhd[0] === 1 ? mvhd.readUInt32BE(20) : mvhd.readUInt32BE(12)) : 0;
    if (elst) {
      const v1 = elst[0] === 1, n = elst.readUInt32BE(4);
      for (let k = 0, o = 8; k < n; k++, o += v1 ? 20 : 12) {
        const dur = v1 ? Number(elst.readBigUInt64BE(o)) : elst.readUInt32BE(o);
        const mt = v1 ? Number(elst.readBigInt64BE(o + 8)) : elst.readInt32BE(o + 4);
        if (mt >= 0) { shift = mt; break; }
        if (mts) empty += dur / mts;
      }
    }
    const count = (b) => b.readUInt32BE(4);
    let total = 0; for (let k = 0; k < count(stts); k++) total += stts.readUInt32BE(8 + k * 8);
    if (!total || total > 5e7) return null;
    const sync = stss ? new Set(Array.from({ length: count(stss) }, (_, k) => stss.readUInt32BE(8 + k * 4) - 1)) : null;
    const ctt = ctts ? { v1: ctts[0] === 1, n: count(ctts) } : null;
    const out = [];
    let sample = 0, dts = 0, ci = 0, cleft = ctt?.n ? ctts.readUInt32BE(8) : 0;
    for (let k = 0; k < count(stts); k++) {
      const n = stts.readUInt32BE(8 + k * 8), delta = stts.readUInt32BE(12 + k * 8);
      for (let j = 0; j < n; j++, sample++, dts += delta) {
        let off = 0;
        if (ctt && ci < ctt.n) {
          // Med tecken även i version 0 (som ffmpeg) – vissa kodare skriver negativa förskjutningar där
          off = ctts.readInt32BE(12 + ci * 8);
          if (--cleft === 0 && ++ci < ctt.n) cleft = ctts.readUInt32BE(8 + ci * 8);
        }
        if (!sync || sync.has(sample)) out.push((dts + off - shift) / ts + empty);
      }
    }
    return out;
  }
  return null;
}

async function mp4Keyframes(r) {
  let pos = 0;
  for (let k = 0; k < 64 && pos + 8 <= r.size; k++) {
    const h = await r.read(pos, 16);
    let size = h.readUInt32BE(0), hdr = 8;
    const type = h.toString('latin1', 4, 8);
    if (size === 1) { size = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (size === 0) size = r.size - pos;
    if (size < hdr) return null;
    if (type === 'moof') return null; // fragmenterad MP4 saknar samlade tabeller
    if (type === 'moov') return size > (256 << 20) ? null : parseMoov(await r.read(pos + hdr, size - hdr));
    pos += size;
  }
  return null;
}

// ---------------- kontroll ----------------
async function sample(file, at, len) {
  const { stdout } = await pexec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0', '-read_intervals', `${at.toFixed(1)}%+${len}`,
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file], { maxBuffer: 16 << 20, timeout: 60000 });
  return stdout.split('\n').map(l => l.split(',')).filter(([t, f]) => f && f[0] === 'K').map(([t]) => parseFloat(t)).filter(x => !isNaN(x));
}
/** complete: varje nyckelbild i stickproven finns i listan (krävs för fMP4-remux, där varje GOP blir ett segment) */
async function check(file, kf, duration) {
  const has = (t) => { let lo = 0, hi = kf.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (kf[m] < t - 0.002) lo = m + 1; else hi = m; } return Math.abs(kf[lo] - t) <= 0.002; };
  let any = false, complete = true;
  for (const at of [0, duration * 0.37, duration * 0.71]) {
    const s = await sample(file, at, 12);
    // Stickprovets första nyckelbild kan ligga före intervallet (sökningen landar på närmaste föregående)
    for (const t of s) { if (has(t)) any = true; else complete = false; }
    // Omvänt: en tid i listan mellan stickprovets nyckelbilder som inte är en nyckelbild betyder att indexet
    // pekar fel – då skulle segmentgränserna (även för H.264, som annars klarar ett urval) inte stämma
    if (s.length >= 2) {
      const lo = Math.min(...s), hi = Math.max(...s);
      for (const t of kf) if (t > lo + 0.002 && t < hi - 0.002 && !s.some(x => Math.abs(x - t) <= 0.002)) return { ok: false, complete: false };
    }
  }
  return { ok: any, complete };
}

/** { kf, complete } eller null (ingen snabb väg – läs hela filen med ffprobe) */
export async function fastKeyframes(file, duration) {
  let r;
  try {
    r = await reader(file);
    const sig = await r.read(0, 12);
    let kf = null;
    if (sig.readUInt32BE(0) === 0x1A45DFA3) kf = await mkvKeyframes(r);
    else if (sig.toString('latin1', 4, 8) === 'ftyp') kf = await mp4Keyframes(r);
    if (!kf) return null;
    kf = [...new Set(kf.map(t => Math.round(t * 1e6) / 1e6))].filter(t => t >= 0).sort((a, b) => a - b);
    if (kf.length < 2) return null;
    // Rimlighet: täcker hela filen och inga orimliga luckor
    if (duration && kf[kf.length - 1] < duration - 120) return null;
    for (let k = 1; k < kf.length; k++) if (kf[k] - kf[k - 1] > 60) return null;
    const c = await check(file, kf, duration || kf[kf.length - 1]);
    if (!c.ok) return null;
    return { kf, complete: c.complete };
  } catch { return null; }
  finally { await r?.fh.close().catch(() => {}); }
}
