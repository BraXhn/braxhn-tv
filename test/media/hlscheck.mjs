// Kontroller av HLS från servern: spellistor, segment (ffprobe) och bildströmmens första NAL-enhet.
// Används av test/conformance.test.js och av macOS-jobbet (test/media/apple-check.mjs).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

// ---------- spellistor ----------
const attrs = (s) => {
  const o = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
};
export function parseMaster(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('mastern börjar inte med #EXTM3U');
  const variants = [], media = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(lines[i].slice(18));
      const res = a.RESOLUTION ? a.RESOLUTION.split('x').map(Number) : null;
      variants.push({ bw: +a.BANDWIDTH, res, videoRange: a['VIDEO-RANGE'] || null, attrs: a, uri: lines[i + 1] });
    } else if (lines[i].startsWith('#EXT-X-MEDIA:')) media.push(attrs(lines[i].slice(13)));
  }
  return { variants, media, independent: lines.includes('#EXT-X-INDEPENDENT-SEGMENTS') };
}
export function parseMedia(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('spellistan börjar inte med #EXTM3U');
  const out = { version: null, target: null, segments: [], map: null, endlist: false, type: null };
  let t = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-VERSION:')) out.version = +l.slice(15);
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) out.target = +l.slice(22);
    else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) out.type = l.slice(21);
    else if (l.startsWith('#EXT-X-MAP:')) out.map = attrs(l.slice(11)).URI;
    else if (l === '#EXT-X-ENDLIST') out.endlist = true;
    else if (l.startsWith('#EXTINF:')) {
      const dur = parseFloat(l.slice(8));
      out.segments.push({ dur, start: t, uri: lines[i + 1] });
      t += dur;
    }
  }
  out.total = t;
  return out;
}

// ---------- ffprobe ----------
export async function probe(file) {
  const { stdout } = await pexec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format',
    '-show_entries', 'packet=stream_index,codec_type,pts_time,dts_time,duration_time,flags,size', file], { maxBuffer: 64 << 20 });
  const j = JSON.parse(stdout);
  const pk = (type) => (j.packets || []).filter(p => p.codec_type === type).map(p => ({
    pts: p.pts_time != null ? +p.pts_time : null, dts: p.dts_time != null ? +p.dts_time : null,
    dur: p.duration_time != null ? +p.duration_time : null, key: String(p.flags || '').startsWith('K'), size: +p.size || 0
  }));
  const s = j.streams || [];
  return { streams: s, format: j.format || {}, video: s.find(x => x.codec_type === 'video') || null,
    audio: s.filter(x => x.codec_type === 'audio'), vp: pk('video'), ap: pk('audio'), raw: j };
}

/** NAL-typer i bildströmmens första åtkomstenhet (i avkodningsordning) */
export async function firstAccessUnit(file, codec) {
  const fmt = codec === 'hevc' ? 'hevc' : 'h264';
  const { stdout } = await pexec('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-f', fmt, 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 << 20 });
  const nals = [];
  for (let i = 0; i + 3 < stdout.length; i++) {
    if (stdout[i] === 0 && stdout[i + 1] === 0 && stdout[i + 2] === 1) {
      const b = stdout[i + 3];
      const type = fmt === 'hevc' ? (b >> 1) & 0x3f : b & 0x1f;
      // SEI med återhämtningspunkt (H.264, payloadType 6): öppen GOP utan IDR
      let recovery = false;
      if (fmt === 'h264' && type === 6) recovery = stdout[i + 4] === 6;
      nals.push({ type, recovery });
      i += 3;
    }
  }
  const vcl = nals.find(n => fmt === 'hevc' ? n.type < 32 : n.type >= 1 && n.type <= 5);
  return { nals, vcl: vcl?.type ?? null,
    idr: fmt === 'hevc' ? [19, 20].includes(vcl?.type) : vcl?.type === 5,
    irap: fmt === 'hevc' ? vcl?.type >= 16 && vcl?.type <= 23 : vcl?.type === 5,
    recovery: nals.some(n => n.recovery) };
}

// ---------- WebVTT ----------
export function parseVtt(text) {
  if (!/^﻿?WEBVTT/.test(text)) throw new Error('saknar WEBVTT-huvud');
  const t = (x) => x.split(':').reduce((a, v) => a * 60 + parseFloat(v), 0);
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const m = /((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})[^\n]*\n([\s\S]*)/.exec(block);
    if (m) cues.push({ s: t(m[1]), e: t(m[2]), text: m[3].trim() });
  }
  return cues;
}

// ---------- H.264-nivåer ----------
// Största antal makroblock per sekund och per bild för varje nivå (H.264 tabell A-1)
const LEVELS = [[30, 40500, 1620], [31, 108000, 3600], [32, 216000, 5120], [40, 245760, 8192], [41, 245760, 8192], [42, 522240, 8704],
  [50, 589824, 22080], [51, 983040, 36864], [52, 2073600, 36864]];
/** Lägsta rimliga nivå för upplösning och bildfrekvens (+ ett steg marginal i testerna) */
export function minLevel(w, h, fps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  return (LEVELS.find(([, mbps, fs]) => mbs <= fs && mbs * fps <= mbps) || [52])[0];
}

// ---------- fMP4 (init + mediasegment) ----------
// Tidsstämplar direkt ur moof/tfdt/trun (och initsegmentets elst), så som Apples spelare läser dem.
// ffprobe/libavformat räknar fragmentets tider från sidx (tidigaste presentationstid) och ger då fel
// PTS/DTS för öppen GOP och B-bilder när ett fragment läses för sig.
function* boxes(b, start = 0, end = b.length) {
  for (let o = start; o + 8 <= end;) {
    let size = b.readUInt32BE(o), hdr = 8;
    const type = b.toString('latin1', o + 4, o + 8);
    if (size === 1) { size = Number(b.readBigUInt64BE(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) return;
    yield { type, start: o + hdr, end: o + size };
    o += size;
  }
}
const childrenOf = (b, box, type) => [...boxes(b, box.start, box.end)].filter(x => x.type === type);
const child = (b, box, type) => childrenOf(b, box, type)[0] || null;
/** { [spår-id]: { handler: 'vide'|'soun', timescale, samples: [{ dts, pts, dur, key, size }] } } – tider i sekunder */
export function parseFmp4(init, seg) {
  const tracks = {};
  const moov = [...boxes(init)].find(x => x.type === 'moov');
  if (!moov) throw new Error('initsegmentet saknar moov');
  for (const trak of childrenOf(init, moov, 'trak')) {
    const tkhd = child(init, trak, 'tkhd'), mdia = child(init, trak, 'mdia');
    const id = init.readUInt32BE(tkhd.start + (init[tkhd.start] === 1 ? 20 : 12));
    const mdhd = child(init, mdia, 'mdhd'), hdlr = child(init, mdia, 'hdlr');
    const timescale = init.readUInt32BE(mdhd.start + (init[mdhd.start] === 1 ? 20 : 12));
    // Redigeringslista: media_time förskjuter presentationen (bildomkastningens fördröjning)
    let shift = 0;
    const edts = child(init, trak, 'edts'), elst = edts && child(init, edts, 'elst');
    if (elst && init.readUInt32BE(elst.start + 4) > 0) {
      const mt = init[elst.start] === 1 ? Number(init.readBigInt64BE(elst.start + 16)) : init.readInt32BE(elst.start + 12);
      if (mt > 0) shift = mt;
    }
    tracks[id] = { handler: init.toString('latin1', hdlr.start + 8, hdlr.start + 12), timescale, shift, trex: null, samples: [] };
  }
  const mvex = child(init, moov, 'mvex');
  for (const trex of mvex ? childrenOf(init, mvex, 'trex') : []) {
    const id = init.readUInt32BE(trex.start + 4);
    if (tracks[id]) tracks[id].trex = { dur: init.readUInt32BE(trex.start + 12), size: init.readUInt32BE(trex.start + 16), flags: init.readUInt32BE(trex.start + 20) };
  }
  for (const moof of [...boxes(seg)].filter(x => x.type === 'moof')) {
    for (const traf of childrenOf(seg, moof, 'traf')) {
      const tfhd = child(seg, traf, 'tfhd');
      const tf = seg.readUInt32BE(tfhd.start) & 0xffffff;
      const t = tracks[seg.readUInt32BE(tfhd.start + 4)];
      if (!t) continue;
      let o = tfhd.start + 8;
      const next = () => { const x = seg.readUInt32BE(o); o += 4; return x; };
      if (tf & 0x01) o += 8;
      if (tf & 0x02) o += 4;
      const defDur = tf & 0x08 ? next() : t.trex?.dur || 0;
      const defSize = tf & 0x10 ? next() : t.trex?.size || 0;
      const defFlags = tf & 0x20 ? next() : t.trex?.flags || 0;
      const tfdt = child(seg, traf, 'tfdt');
      let dts = tfdt ? (seg[tfdt.start] === 1 ? Number(seg.readBigUInt64BE(tfdt.start + 4)) : seg.readUInt32BE(tfdt.start + 4)) : 0;
      for (const trun of childrenOf(seg, traf, 'trun')) {
        const v = seg[trun.start], f = seg.readUInt32BE(trun.start) & 0xffffff, n = seg.readUInt32BE(trun.start + 4);
        o = trun.start + 8;
        if (f & 0x01) o += 4;
        const first = f & 0x04 ? next() : null;
        for (let i = 0; i < n; i++) {
          const dur = f & 0x100 ? next() : defDur;
          const size = f & 0x200 ? next() : defSize;
          let flags = f & 0x400 ? next() : defFlags;
          if (i === 0 && first != null) flags = first;
          let cts = 0;
          if (f & 0x800) { cts = v === 1 ? seg.readInt32BE(o) : seg.readUInt32BE(o); o += 4; }
          t.samples.push({ dts: (dts - t.shift) / t.timescale, pts: (dts + cts - t.shift) / t.timescale, dur: dur / t.timescale, key: !(flags & 0x10000), size });
          dts += dur;
        }
      }
    }
  }
  return tracks;
}
