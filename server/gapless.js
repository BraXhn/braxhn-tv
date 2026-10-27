// Glapplös uppspelning och smarta övertoningar i webbens musikspelare (web/js/audioengine.js):
//   – trim: kodarens fördröjning och utfyllnad ur filhuvudet (MP3 LAME/Xing-taggen, MP4/M4A iTunSMPB eller edts/elst,
//     FLAC STREAMINFO, Ogg granulepos) – i ren JS, bara några kB läses. Webbläsaren jämför det avkodade antalet sampel
//     med `samples` och skär bort det som blir över (vissa webbläsare tar bort fördröjningen själva, andra inte).
//   – tystnad i början och slutet (ffmpeg silencedetect på lägsta prioritet, högst 30 s i var ände) – styr övertoningen.
// Resultatet cachas som JSON i tracks.gl (NULL = inte analyserat; skanningen nollställer det när filen ändras).
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { all, run } from './db.js';

export const GL_VERSION = 1;
const SILENCE_DB = -50, SILENCE_MIN = 0.1, EDGE = 30;

// ---------------- filhuvuden ----------------
async function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fd.read(b, 0, len, pos);
  return b.subarray(0, bytesRead);
}
const syncsafe = (b, o) => (b[o] & 0x7f) << 21 | (b[o + 1] & 0x7f) << 14 | (b[o + 2] & 0x7f) << 7 | (b[o + 3] & 0x7f);
/** Hoppar över ID3v2-taggar (kan vara flera i rad) och returnerar positionen efter dem. */
async function skipId3(fd) {
  let pos = 0;
  for (let i = 0; i < 4; i++) {
    const h = await readAt(fd, pos, 10);
    if (h.length < 10 || h.toString('latin1', 0, 3) !== 'ID3') break;
    pos += 10 + syncsafe(h, 6) + (h[5] & 0x10 ? 10 : 0);
  }
  return pos;
}

const MP3_SR = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]]; // index = versionsbitarna
/**
 * MP3: första ramen efter ID3v2 med Xing/Info-taggen. LAME (och ffmpeg: "Lavf"/"Lavc") skriver fördröjning och utfyllnad
 * i 12+12 bitar. Avkodaren lägger till 529 sampel (samma regel som ffmpeg och LAME:s egen dokumentation).
 */
export function parseMp3Frame(b) {
  for (let i = 0; i + 4 < b.length && i < 65536; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, brIdx = b[i + 2] >> 4, srIdx = (b[i + 2] >> 2) & 3;
    if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue; // bara Layer III
    const mpeg1 = ver === 3, mono = (b[i + 3] >> 6) === 3;
    const sr = MP3_SR[ver][srIdx], spf = mpeg1 ? 1152 : 576;
    const x = i + 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
    const tag = b.toString('latin1', x, x + 4);
    if (tag !== 'Xing' && tag !== 'Info') return { sr, samples: null, skip: null, pad: null };
    const flags = b.readUInt32BE(x + 4);
    let o = x + 8, frames = null;
    if (flags & 1) { frames = b.readUInt32BE(o); o += 4; }
    if (flags & 2) o += 4;
    if (flags & 4) o += 100;
    if (flags & 8) o += 4;
    const enc = b.toString('latin1', o, o + 4);
    if (!frames || o + 24 > b.length || !['LAME', 'Lavf', 'Lavc'].includes(enc)) return { sr, samples: frames ? frames * spf : null, skip: null, pad: null };
    const v = b.readUIntBE(o + 21, 3), delay = v >> 12, padding = v & 0xfff;
    const total = frames * spf, skip = delay + 529;
    const end = padding >= 529 ? total - (padding - 529) : total;
    return { sr, samples: Math.max(0, end - skip), skip, pad: total - end };
  }
  return null;
}

/** Går igenom MP4-boxar i [start, end) och returnerar { typ, start, size, body } för var och en. */
async function boxes(fd, start, end) {
  const out = [];
  for (let pos = start; pos + 8 <= end && out.length < 512;) {
    const h = await readAt(fd, pos, 16);
    if (h.length < 8) break;
    let size = h.readUInt32BE(0), hdr = 8;
    const type = h.toString('latin1', 4, 8);
    if (size === 1) { if (h.length < 16) break; size = Number(h.readBigUInt64BE(8)); hdr = 16; }
    else if (size === 0) size = end - pos;
    if (size < hdr || pos + size > end) break;
    out.push({ type, start: pos + hdr, end: pos + size });
    pos += size;
  }
  return out;
}
const child = (list, type) => list.find(b => b.type === type);
/** MP4/M4A med AAC: iTunSMPB (iTunes) i första hand, annars redigeringslistan (edts/elst) som ffmpeg och Apple skriver. */
async function parseMp4(fd, size) {
  const moov = child(await boxes(fd, 0, size), 'moov');
  if (!moov || moov.end - moov.start > 64 << 20) return null;
  const mbuf = await readAt(fd, moov.start, moov.end - moov.start);
  // Resten läses ur bufferten (moov är litet)
  const inner = (s, e) => {
    const out = [];
    for (let p = s; p + 8 <= e && out.length < 512;) {
      let sz = mbuf.readUInt32BE(p), hdr = 8;
      const type = mbuf.toString('latin1', p + 4, p + 8);
      if (sz === 1) { sz = Number(mbuf.readBigUInt64BE(p + 8)); hdr = 16; } else if (sz === 0) sz = e - p;
      if (sz < hdr || p + sz > e) break;
      out.push({ type, start: p + hdr, end: p + sz }); p += sz;
    }
    return out;
  };
  const top = inner(0, mbuf.length);
  const mvhd = child(top, 'mvhd');
  const movieScale = mvhd ? mbuf.readUInt32BE(mvhd.start + (mbuf[mvhd.start] === 1 ? 20 : 12)) : 0;
  let smpb = null;
  const udta = child(top, 'udta'), meta = udta && child(inner(udta.start, udta.end), 'meta');
  const ilst = meta && child(inner(meta.start + 4, meta.end), 'ilst');
  for (const it of ilst ? inner(ilst.start, ilst.end) : []) {
    if (it.type !== '----') continue;
    const parts = inner(it.start, it.end);
    const name = child(parts, 'name'), data = child(parts, 'data');
    if (name && data && mbuf.toString('latin1', name.start + 4, name.end) === 'iTunSMPB') {
      const f = mbuf.toString('latin1', data.start + 8, data.end).trim().split(/\s+/).map(h => parseInt(h, 16));
      if (f.length >= 4 && f.slice(1, 4).every(Number.isFinite)) smpb = { delay: f[1], pad: f[2], samples: f[3] };
    }
  }
  for (const trak of top.filter(b => b.type === 'trak')) {
    const tk = inner(trak.start, trak.end), mdia = child(tk, 'mdia');
    if (!mdia) continue;
    const md = inner(mdia.start, mdia.end), hdlr = child(md, 'hdlr'), mdhd = child(md, 'mdhd');
    if (!hdlr || !mdhd || mbuf.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'soun') continue;
    const v1 = mbuf[mdhd.start] === 1;
    const scale = mbuf.readUInt32BE(mdhd.start + (v1 ? 20 : 12));
    let raw = v1 ? Number(mbuf.readBigUInt64BE(mdhd.start + 24)) : mbuf.readUInt32BE(mdhd.start + 16);
    // Kodek: bara AAC har fördröjning (ALAC m.fl. är exakta)
    const minf = child(md, 'minf'), stbl = minf && child(inner(minf.start, minf.end), 'stbl'), stsd = stbl && child(inner(stbl.start, stbl.end), 'stsd');
    const codec = stsd ? mbuf.toString('latin1', stsd.start + 12, stsd.start + 16) : '';
    // Avkodade sampel = antal ramar × ramens längd (första stts-posten). Sista ramens längd i stts är ofta kortad,
    // men avkodaren ger alltid en hel ram – utfyllnaden räknas därför mot hela ramar.
    const st = stbl ? inner(stbl.start, stbl.end) : [], stts = child(st, 'stts'), stsz = child(st, 'stsz');
    if (stts && stsz && mbuf.readUInt32BE(stts.start + 4) > 0) {
      const frames = mbuf.readUInt32BE(stsz.start + 8), delta = mbuf.readUInt32BE(stts.start + 12);
      if (frames > 0 && delta > 0) raw = frames * delta;
    }
    if (codec !== 'mp4a') return { sr: scale, samples: raw, skip: 0, pad: 0 };
    if (smpb && smpb.samples > 0) return { sr: scale, samples: smpb.samples, skip: smpb.delay, pad: Math.max(0, raw - smpb.delay - smpb.samples) };
    const edts = child(tk, 'edts'), elst = edts && child(inner(edts.start, edts.end), 'elst');
    if (elst && movieScale) {
      const ev1 = mbuf[elst.start] === 1, n = mbuf.readUInt32BE(elst.start + 4);
      let p = elst.start + 8;
      for (let i = 0; i < n && i < 16; i++) {
        const dur = ev1 ? Number(mbuf.readBigUInt64BE(p)) : mbuf.readUInt32BE(p);
        const mt = ev1 ? Number(mbuf.readBigInt64BE(p + 8)) : mbuf.readInt32BE(p + 4);
        p += ev1 ? 20 : 12;
        if (mt < 0) continue; // tom redigering (fördröjd start)
        const samples = Math.round(dur * scale / movieScale);
        if (!samples) break; // segment_duration 0 = "resten" (vissa kodare)
        return { sr: scale, samples, skip: mt, pad: Math.max(0, raw - mt - samples) };
      }
    }
    return { sr: scale, samples: null, skip: null, pad: null };
  }
  return null;
}

async function parseFlac(fd, pos) {
  const b = await readAt(fd, pos, 42);
  if (b.length < 42 || b.toString('latin1', 0, 4) !== 'fLaC' || (b[4] & 0x7f) !== 0) return null;
  const s = 8; // STREAMINFO-blockets data
  const sr = (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4);
  const total = (b[s + 13] & 0x0f) * 2 ** 32 + b.readUInt32BE(s + 14);
  return { sr, samples: total || null, skip: 0, pad: 0 };
}

async function parseOgg(fd, size) {
  const head = await readAt(fd, 0, 4096);
  if (head.toString('latin1', 0, 4) !== 'OggS') return null;
  const segs = head[26], body = 27 + segs;
  const id = head.toString('latin1', body, body + 8);
  let sr, preskip = 0;
  if (id === 'OpusHead') { sr = 48000; preskip = head.readUInt16LE(body + 10); }
  else if (head.toString('latin1', body + 1, body + 7) === 'vorbis') sr = head.readUInt32LE(body + 12);
  else return null;
  const n = Math.min(size, 65536), tail = await readAt(fd, size - n, n);
  const at = tail.lastIndexOf('OggS');
  if (at < 0 || at + 14 > tail.length) return { sr, samples: null, skip: null, pad: null };
  const gp = Number(tail.readBigInt64LE(at + 6));
  return { sr, samples: gp > preskip ? gp - preskip : null, skip: preskip, pad: 0 };
}

/** Trim-värden för en ljudfil: { sr, samples, skip, pad } (sampel i filens takt) eller null om formatet inte känns igen. */
export async function readTrim(file) {
  let fd;
  try {
    fd = await fs.promises.open(file, 'r');
    const size = (await fd.stat()).size;
    const magic = await readAt(fd, 0, 12);
    if (magic.toString('latin1', 4, 8) === 'ftyp') return await parseMp4(fd, size);
    if (magic.toString('latin1', 0, 4) === 'OggS') return await parseOgg(fd, size);
    const pos = await skipId3(fd);
    const flac = await parseFlac(fd, pos);
    if (flac) return flac;
    return parseMp3Frame(await readAt(fd, pos, 16384));
  } catch { return null; }
  finally { await fd?.close().catch(() => {}); }
}

// ---------------- tystnad i kanterna ----------------
/** Tolkar silencedetect: tystnad från början (s) och tystnad mot slutet av ett fönster på `win` sekunder. */
export function parseSilence(text, win) {
  const ev = [];
  for (const m of String(text).matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) ev.push([m[1], parseFloat(m[2])]);
  let head = 0, tail = 0;
  if (ev[0]?.[0] === 'start' && ev[0][1] <= 0.02) head = ev[1]?.[0] === 'end' ? ev[1][1] : win;
  const last = ev[ev.length - 1];
  if (last?.[0] === 'start') tail = Math.max(0, win - last[1]);
  else if (last?.[0] === 'end' && last[1] >= win - 0.05) { const st = ev[ev.length - 2]; if (st?.[0] === 'start') tail = Math.max(0, win - st[1]); }
  return { head: Math.round(head * 100) / 100, tail: Math.round(tail * 100) / 100 };
}
function silenceRun(file, input, win, timeoutMs = 60e3) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-nostdin', '-protocol_whitelist', 'file,pipe', ...input, '-i', file, '-map', '0:a:0', '-vn',
      '-af', `silencedetect=n=${SILENCE_DB}dB:d=${SILENCE_MIN}`, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(p.pid, 19); } catch {}
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 1 << 20) err = err.slice(-65536); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(parseSilence(err, win)) : reject(new Error('ffmpeg kunde inte läsa filen')); });
  });
}
/** Tystnad i början och slutet (sekunder). Korta spår läses helt, annars 30 s i var ände. */
export async function measureEdges(file, duration) {
  const d = Number(duration) || 0;
  if (d > 0 && d <= EDGE * 2) { const r = await silenceRun(file, [], d); return { head: Math.min(r.head, d), tail: r.head >= d ? 0 : r.tail }; }
  const h = await silenceRun(file, ['-t', String(EDGE)], EDGE);
  const t = await silenceRun(file, ['-sseof', String(-EDGE)], EDGE);
  return { head: h.head, tail: t.tail };
}

/** Hela analysen för ett spår – JSON-värdet i tracks.gl. */
export async function analyzeTrack(t) {
  const trim = await readTrim(t.path);
  let edges = null;
  try { edges = await measureEdges(t.path, t.duration); } catch {}
  return { v: GL_VERSION, sr: trim?.sr ?? null, n: trim?.samples ?? null, skip: trim?.skip ?? null, pad: trim?.pad ?? null,
    head: edges?.head ?? null, tail: edges?.tail ?? null };
}

/** API-formen (spårlistornas `gapless`): null om inte analyserat. */
export function shapeGapless(json) {
  if (!json) return null;
  try {
    const g = JSON.parse(json);
    return { sampleRate: g.sr ?? null, samples: g.n ?? null, skip: g.skip ?? null, pad: g.pad ?? null, silenceStart: g.head ?? null, silenceEnd: g.tail ?? null };
  } catch { return null; }
}

// ---------------- bakgrundsjobbet ----------------
let busyCheck = () => false;
/** app.js kopplar in strömningens belastning: medan den säger "upptagen" väntar analysen. */
export function setBusyCheck(fn) { busyCheck = fn; }
const enabled = () => process.env.MUSIC_GAPLESS !== '0';
const sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
let running = null, timer = null, again = false;
async function work() {
  let n = 0;
  for (;;) {
    again = false;
    while (busyCheck()) await sleep(15e3);
    const rows = all(`SELECT id, path, duration FROM tracks WHERE gl IS NULL OR json_extract(gl, '$.v') IS NOT ? ORDER BY added DESC LIMIT 50`, GL_VERSION);
    if (!rows.length) { if (again) continue; break; }
    for (const r of rows) {
      let g;
      try { g = await analyzeTrack(r); } catch { g = { v: GL_VERSION }; }
      run('UPDATE tracks SET gl=? WHERE id=? AND path=?', JSON.stringify(g), r.id, r.path);
      n++;
      if (busyCheck()) break;
    }
  }
  if (n) console.log(`[music] glapplöst: ${n} spår analyserade (fördröjning och tystnad i kanterna)`);
}
/** Startar bakgrundsjobbet om en stund (efter skanning och vid start). */
export function kick(ms = 5000) {
  if (!enabled()) return;
  if (running) { again = true; return; }
  if (timer) return;
  timer = setTimeout(() => { timer = null; runAll(); }, ms);
  timer.unref?.();
}
/** Kör jobbet tills inget återstår (tester och kick). */
export function runAll() {
  clearTimeout(timer); timer = null;
  if (!running) running = work().catch(e => console.warn('[music] glapplöst:', e.message)).finally(() => { running = null; });
  return running;
}
