// Testsamlingen: syntetiska källfiler som liknar riktiga filmer (codec, bitdjup, HDR-märkning, ljud, undertexter,
// udda upplösningar och bildfrekvenser). Filerna skapas med ffmpeg (lavfi) och cachas efter innehållshash, så att
// en ny körning bara skapar det som ändrats. Se docs/testsamling.md.
//
//   node test/media/sources.mjs [mapp] [--full] [--only=id,id]   – skapa och länka in i <mapp>/Filmer
//
// Begränsningar (ffmpeg kan inte skapa allt):
// - Dolby Vision: ffmpeg skriver inga RPU:er. "dv81"/"dv5" är HDR10-HEVC där en Dolby Vision-
//   konfigurationspost (dvvC/dvcC) lagts in för hand i MP4-filen – servern och ffprobe ser Dolby Vision,
//   men bildströmmen saknar RPU (en riktig DV-spelare visar HDR10-baslagret, profil 5 får fel färger).
// - TrueHD och DTS kräver ffmpegs experimentella kodare (-strict -2); saknas de hoppas källan över.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const GEN_VERSION = 3; // höj när genereringen ändras på ett sätt som inte syns i argumenten
export const CACHE_DIR = process.env.TESTSAMLING_CACHE || path.join(os.tmpdir(), 'braxhn-tv-testsamling');

// ---------- undertexter ----------
// Samma tre repliker i alla textformat; testerna letar efter dem nära de här tiderna
export const CUES = [{ s: 1, e: 4, text: 'Hej och välkommen' }, { s: 12, e: 15, text: 'Mitt i filmen' }, { s: 22, e: 25, text: 'Snart slut' }];
const srtTime = (t) => `00:00:${String(Math.floor(t)).padStart(2, '0')},${String(Math.round(t % 1 * 1000)).padStart(3, '0')}`;
const srt = () => CUES.map((c, i) => `${i + 1}\n${srtTime(c.s)} --> ${srtTime(c.e)}\n${c.text}\n`).join('\n');
const assTime = (t) => `0:00:${String(Math.floor(t)).padStart(2, '0')}.${String(Math.round(t % 1 * 100)).padStart(2, '0')}`;
const ass = () => `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n\n[V4+ Styles]\n` +
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
  'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,30,1\n\n[Events]\n' +
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
  CUES.map(c => `Dialogue: 0,${assTime(c.s)},${assTime(c.e)},Default,,0,0,0,,{\\i1}${c.text}{\\i0}`).join('\n') + '\n';

// PGS (Blu-ray-bildundertexter): samma byggsätt som i test/fast-start.test.js – ett rött block per replik
export const PGS_CUES = [{ s: 1, e: 3 }, { s: 12, e: 14 }];
function pgsSeg(type, pts, body) {
  const h = Buffer.alloc(13);
  h.write('PG', 0, 'latin1'); h.writeUInt32BE(Math.round(pts * 90000), 2); h[10] = type; h.writeUInt16BE(body.length, 11);
  return Buffer.concat([h, body]);
}
export function pgsSup(cues = PGS_CUES) {
  const pcs = (pts, objs, state, comp) => {
    const b = Buffer.alloc(11 + objs * 8);
    b.writeUInt16BE(1280, 0); b.writeUInt16BE(720, 2); b[4] = 0x10; b.writeUInt16BE(comp, 5); b[7] = state; b[8] = 0; b[9] = 0; b[10] = objs;
    if (objs) { b.writeUInt16BE(0, 11); b[13] = 0; b[14] = 0; b.writeUInt16BE(100, 15); b.writeUInt16BE(600, 17); }
    return pgsSeg(0x16, pts, b);
  };
  const wds = (pts) => { const b = Buffer.alloc(10); b[0] = 1; b[1] = 0; b.writeUInt16BE(100, 2); b.writeUInt16BE(600, 4); b.writeUInt16BE(8, 6); b.writeUInt16BE(2, 8); return pgsSeg(0x17, pts, b); };
  const rle = Buffer.from([0x00, 0x88, 0x01, 0x00, 0x00, 0x00, 0x84, 0x01, 0x00, 0x04, 0x00, 0x00]);
  const out = [];
  cues.forEach((c, i) => {
    const ods = Buffer.alloc(11); ods.writeUInt16BE(0, 0); ods[2] = 0; ods[3] = 0xc0; ods.writeUIntBE(rle.length + 4, 4, 3); ods.writeUInt16BE(8, 7); ods.writeUInt16BE(2, 9);
    out.push(pcs(c.s, 1, 0x80, i * 2), wds(c.s), pgsSeg(0x14, c.s, Buffer.from([0, 0, 1, 63, 240, 102, 255])), pgsSeg(0x15, c.s, Buffer.concat([ods, rle])), pgsSeg(0x80, c.s, Buffer.alloc(0)),
      pcs(c.e, 0, 0, i * 2 + 1), wds(c.e), pgsSeg(0x80, c.e, Buffer.alloc(0)));
  });
  return Buffer.concat(out);
}

// ---------- Dolby Vision-konfigurationspost i MP4 ----------
// Lägger en dvcC/dvvC-låda sist i HEVC-provposten (moov/trak/mdia/minf/stbl/stsd/hvc1) och räknar om
// storlekarna uppåt. moov ligger sist i filen (ingen faststart), så inga mdat-offset behöver flyttas.
export function injectDovi(file, { profile, level = 4, compat, fourcc = null }) {
  const buf = fs.readFileSync(file);
  const box = (b, off) => ({ size: b.readUInt32BE(off), type: b.toString('latin1', off + 4, off + 8), off });
  const children = (b, start, end) => { const out = []; for (let o = start; o + 8 <= end;) { const x = box(b, o); if (x.size < 8) break; out.push(x); o += x.size; } return out; };
  const top = children(buf, 0, buf.length);
  const moov = top.find(x => x.type === 'moov'), mdat = top.find(x => x.type === 'mdat');
  if (!moov || !mdat || moov.off < mdat.off) throw new Error('injectDovi: moov måste ligga efter mdat');
  const chain = [moov];
  let trak = null, entry = null;
  for (const t of children(buf, moov.off + 8, moov.off + moov.size).filter(x => x.type === 'trak')) {
    const find = (parent, type) => children(buf, parent.off + 8, parent.off + parent.size).find(x => x.type === type);
    const mdia = find(t, 'mdia'), minf = mdia && find(mdia, 'minf'), stbl = minf && find(minf, 'stbl'), stsd = stbl && find(stbl, 'stsd');
    if (!stsd) continue;
    const e = box(buf, stsd.off + 16);
    if (!['hvc1', 'hev1', 'dvh1'].includes(e.type)) continue;
    trak = t; entry = e; chain.push(t, mdia, minf, stbl, stsd, e); break;
  }
  if (!trak) throw new Error('injectDovi: inget HEVC-spår');
  const rec = Buffer.alloc(24);
  rec[0] = 1; rec[1] = 0; rec.writeUInt16BE((profile << 9) | (level << 3) | (1 << 2) | (0 << 1) | 1, 2); rec[4] = (compat & 0xf) << 4;
  const add = Buffer.alloc(8); add.writeUInt32BE(32, 0); add.write(profile > 7 ? 'dvvC' : 'dvcC', 4, 'latin1');
  const at = entry.off + entry.size;
  const out = Buffer.concat([buf.subarray(0, at), add, rec, buf.subarray(at)]);
  for (const b of chain) out.writeUInt32BE(b.size + 32, b.off);
  if (fourcc) out.write(fourcc, entry.off + 4, 'latin1');
  fs.writeFileSync(file, out);
}

// ---------- källorna ----------
const DUR = 30;
const V = (s, r, extra = '') => ['-f', 'lavfi', '-i', `testsrc2=s=${s}:r=${r}:d=${DUR}${extra}`];
const A = (f = 440) => ['-f', 'lavfi', '-i', `sine=f=${f}:r=48000:d=${DUR},volume=0.5`];
const x264 = (extra = []) => ['-c:v', 'libx264', '-preset', 'superfast', '-bf', '3', ...extra];
const x265 = (params, extra = []) => ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', `log-level=error:${params}`, ...extra];
const HDR10 = 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:hdr10=1:hdr10-opt=1:repeat-headers=1:' +
  'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400';
const HDR10_TAGS = ['-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc'];

/**
 * id: kort namn (används i testnamn och artefakter), ext: filändelse
 * fast: med i den snabba delmängden (npm test), needs: kodare som måste finnas
 * args(files): ffmpeg-argument efter -y (in- och utfiler); files.srt/.ass/.sup finns att använda som indata
 * post(file): efterbearbetning (t.ex. Dolby Vision-post), extras: filer bredvid filmen (externa undertexter)
 * expect: vad testerna förväntar sig av källan (scannerns tolkning och undertexter)
 */
export const SOURCES = [
  { id: 'h264-mp4', ext: '.mp4', fast: true,
    args: () => [...V('1920x1080', '24000/1001'), ...A(), '-map', '0', '-map', '1', ...x264(['-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-pix_fmt', 'yuv420p']),
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart'],
    expect: { vcodec: 'h264', hdr: null, fps: 23.976 } },
  { id: 'h264-mkv-opengop', ext: '.mkv', fast: true, openGop: true,
    args: (f) => ['-copyts', ...V('1280x720', '25'), ...A(), '-i', f.srt, '-i', f.ass, '-i', f.sup,
      '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-map', '4',
      ...x264(['-x264-params', 'open-gop=1:keyint=50:min-keyint=25:b-pyramid=normal', '-pix_fmt', 'yuv420p']),
      '-c:a', 'ac3', '-b:a', '448k', '-ac', '6', '-c:s:0', 'srt', '-c:s:1', 'ass', '-c:s:2', 'copy',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:s:0', 'language=swe', '-metadata:s:s:1', 'language=eng', '-metadata:s:s:2', 'language=fin'],
    extras: { '.sv.srt': srt },
    expect: { vcodec: 'h264', hdr: null, textSubs: 3, pgs: 1, fps: 25 } },
  { id: 'h264-hi10', ext: '.mkv', fast: true,
    args: () => [...V('1280x720', '24000/1001'), ...A(), '-map', '0', '-map', '1', ...x264(['-g', '48', '-pix_fmt', 'yuv420p10le']), '-c:a', 'aac', '-ac', '2'],
    expect: { vcodec: 'h264', hdr: null, alwaysTranscode: true } },
  { id: 'hevc-8', ext: '.mkv', fast: true,
    args: () => [...V('1280x720', '30000/1001'), ...A(), '-map', '0', '-map', '1', ...x265('keyint=60:min-keyint=60'), '-pix_fmt', 'yuv420p',
      '-c:a', 'eac3', '-b:a', '384k', '-ac', '6'],
    expect: { vcodec: 'hevc', hdr: null, fps: 29.97 } },
  { id: 'hevc-10-sdr', ext: '.mkv',
    args: () => [...V('1280x720', '24'), ...A(), '-map', '0', '-map', '1', ...x265('keyint=48:min-keyint=48:no-open-gop=1:colorprim=bt709:transfer=bt709:colormatrix=bt709'),
      '-pix_fmt', 'yuv420p10le', '-c:a', 'flac', '-ac', '6'],
    expect: { vcodec: 'hevc', hdr: null } },
  { id: 'hevc-hdr10', ext: '.mkv', fast: true,
    args: () => [...V('1920x1080', '24000/1001'), ...A(), '-map', '0', '-map', '1', ...x265(`keyint=48:min-keyint=48:${HDR10}`), '-pix_fmt', 'yuv420p10le', ...HDR10_TAGS,
      '-c:a', 'eac3', '-b:a', '640k', '-ac', '6'],
    expect: { vcodec: 'hevc', hdr: 'hdr10', transfer: 'smpte2084' } },
  { id: 'hevc-hlg', ext: '.mp4',
    args: () => [...V('1280x720', '25'), ...A(), '-map', '0', '-map', '1',
      ...x265('keyint=50:min-keyint=50:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc'), '-pix_fmt', 'yuv420p10le',
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1', '-c:a', 'aac', '-ac', '2'],
    expect: { vcodec: 'hevc', hdr: 'hlg', transfer: 'arib-std-b67' } },
  { id: 'dv81', ext: '.mp4',
    args: () => [...V('1280x720', '24000/1001'), ...A(), '-map', '0', '-map', '1', ...x265(`keyint=48:min-keyint=48:${HDR10}`), '-pix_fmt', 'yuv420p10le', ...HDR10_TAGS,
      '-tag:v', 'hvc1', '-c:a', 'aac', '-ac', '2'],
    post: (file) => injectDovi(file, { profile: 8, compat: 1 }),
    expect: { vcodec: 'hevc', hdr: 'dovi', transfer: 'smpte2084', dvProfile: 8 } },
  { id: 'dv5', ext: '.mp4',
    args: () => [...V('1280x720', '24000/1001'), ...A(), '-map', '0', '-map', '1', ...x265(`keyint=48:min-keyint=48:${HDR10}`), '-pix_fmt', 'yuv420p10le', ...HDR10_TAGS,
      '-tag:v', 'hvc1', '-c:a', 'aac', '-ac', '2'],
    post: (file) => injectDovi(file, { profile: 5, compat: 0, fourcc: 'dvh1' }),
    expect: { vcodec: 'hevc', hdr: 'dovi', dvProfile: 5 } },
  // HDR10 där bildströmmen saknar färginformation (VUI ändrad till "ospecificerad") – som en dåligt märkt rip.
  // Servern kan inte veta att det är HDR; omkodningen ska ändå bli en giltig 8-bitars BT.709/okänd ström.
  { id: 'hevc-novui', ext: '.mkv', fast: true,
    args: () => [...V('1280x720', '24'), ...A(), '-map', '0', '-map', '1', ...x265(`keyint=48:min-keyint=48:${HDR10}`), '-pix_fmt', 'yuv420p10le',
      '-bsf:v', 'hevc_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2', '-c:a', 'aac', '-ac', '2'],
    expect: { vcodec: 'hevc', hdr: null } },
  { id: 'vp9-webm', ext: '.webm', fast: true,
    args: () => [...V('1280x720', '30'), ...A(), '-map', '0', '-map', '1', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '2M',
      '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k', '-ac', '2'],
    expect: { vcodec: 'vp9', hdr: null } },
  { id: 'mpeg4-avi', ext: '.avi',
    args: () => [...V('640x480', '25'), ...A(), '-map', '0', '-map', '1', '-c:v', 'mpeg4', '-vtag', 'XVID', '-bf', '2', '-q:v', '4', '-g', '50',
      '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '2'],
    expect: { vcodec: 'mpeg4', hdr: null } },
  { id: 'mpeg2-ts', ext: '.ts', interlaced: true,
    args: () => [...V('720x576', '50'), ...A(), '-map', '0', '-map', '1', '-vf', 'interlace=scan=tff,setsar=16/15', '-c:v', 'mpeg2video', '-flags', '+ilme+ildct', '-top', '1',
      '-b:v', '6M', '-maxrate', '9M', '-bufsize', '2M', '-bf', '2', '-g', '12', '-c:a', 'mp2', '-b:a', '192k', '-ac', '2'],
    expect: { vcodec: 'mpeg2video', hdr: null } },
  { id: 'anamorphic', ext: '.mkv',
    args: () => [...V('720x576', '25'), ...A(), '-map', '0', '-map', '1', '-vf', 'setsar=64/45', ...x264(['-g', '50', '-pix_fmt', 'yuv420p']), '-c:a', 'aac', '-ac', '2'],
    expect: { vcodec: 'h264', hdr: null, sar: '64:45' } },
  { id: 'scope-dts', ext: '.mkv', fast: true, needs: ['dca'],
    args: () => [...V('1920x800', '24000/1001'), ...A(), '-map', '0', '-map', '1', ...x264(['-g', '48', '-pix_fmt', 'yuv420p']),
      '-c:a', 'dca', '-strict', '-2', '-ac', '6'],
    expect: { vcodec: 'h264', hdr: null } },
  { id: 'truehd', ext: '.mkv', needs: ['truehd'],
    args: () => [...V('1280x720', '24'), ...A(), '-map', '0', '-map', '1', ...x264(['-g', '48', '-pix_fmt', 'yuv420p']), '-c:a', 'truehd', '-strict', '-2', '-ac', '6'],
    expect: { vcodec: 'h264', hdr: null } },
  { id: 'multi-audio', ext: '.mkv', fast: true,
    args: () => [...V('640x360', '24'), ...A(440), ...A(220), ...A(660), ...A(880),
      '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-map', '4', ...x264(['-g', '48', '-pix_fmt', 'yuv420p']),
      '-c:a:0', 'aac', '-ac:a:0', '2', '-c:a:1', 'ac3', '-ac:a:1', '6', '-c:a:2', 'libopus', '-ac:a:2', '2', '-c:a:3', 'flac', '-ac:a:3', '2',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=swe', '-metadata:s:a:2', 'language=fin', '-metadata:s:a:3', 'language=ger',
      '-disposition:a:0', 'default', '-disposition:a:1', '0', '-disposition:a:2', '0', '-disposition:a:3', '0'],
    expect: { vcodec: 'h264', hdr: null, audioTracks: ['aac', 'ac3', 'opus', 'flac'] } },
  // Variabel bildfrekvens: 10 bilder/s de första 10 sekunderna, sedan 30
  { id: 'vfr', ext: '.mp4',
    args: () => [...V('1280x720', '30'), ...A(), '-map', '0', '-map', '1', '-vf', "select='if(lt(t,10),not(mod(n,3)),1)'", '-fps_mode', 'vfr',
      ...x264(['-g', '30', '-pix_fmt', 'yuv420p']), '-c:a', 'aac', '-ac', '2'],
    expect: { vcodec: 'h264', hdr: null, vfr: true } },
  { id: 'fps50', ext: '.mp4',
    args: () => [...V('1280x720', '50'), ...A(), '-map', '0', '-map', '1', ...x264(['-g', '100', '-pix_fmt', 'yuv420p']), '-c:a', 'aac', '-ac', '2'],
    expect: { vcodec: 'h264', hdr: null, fps: 50 } },
  { id: 'h264-2997-ac3', ext: '.mkv',
    args: () => [...V('1280x720', '30000/1001'), ...A(), '-map', '0', '-map', '1', ...x264(['-g', '60', '-pix_fmt', 'yuv420p']), '-c:a', 'ac3', '-b:a', '192k', '-ac', '2'],
    expect: { vcodec: 'h264', hdr: null, fps: 29.97 } }
];

// ---------- skapa och cacha ----------
let ffv = null;
const ffmpegVersion = () => ffv ??= execFileSync('ffmpeg', ['-hide_banner', '-version']).toString().split('\n')[0];
let encs = null;
export function hasEncoder(name) {
  encs ??= execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString();
  return new RegExp(`^\\s*[VAS][.A-Z]{5}\\s+${name}\\s`, 'm').test(encs);
}
const FILES = { srt: ['srt', srt], ass: ['ass', ass], sup: ['sup', () => pgsSup()] };
function inputFiles(dir) {
  const out = {};
  for (const [k, [ext, fn]] of Object.entries(FILES)) {
    const f = path.join(dir, `indata.${ext}`);
    const data = fn();
    if (!fs.existsSync(f) || !fs.readFileSync(f).equals(Buffer.from(data))) fs.writeFileSync(f, data);
    out[k] = f;
  }
  return out;
}
/** Nyckel för cachen: argumenten, efterbearbetningen, extrafilernas innehåll och ffmpeg-versionen */
function keyOf(src, files) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ v: GEN_VERSION, ff: ffmpegVersion(), args: src.args(files), post: String(src.post || ''), ext: src.ext }));
  for (const f of Object.values(files)) h.update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 16);
}

/** Skapar källorna (eller tar dem ur cachen). Returnerar [{ ...källa, file }] – källor som inte går att skapa får skip. */
export async function generate({ ids = null, full = false, concurrency = Math.max(2, os.cpus().length >> 1), log = () => {} } = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const files = inputFiles(CACHE_DIR);
  const list = SOURCES.filter(s => ids ? ids.includes(s.id) : (full || s.fast));
  const out = list.map(s => ({ ...s }));
  let next = 0;
  async function worker() {
    while (next < out.length) {
      const s = out[next++];
      const missing = (s.needs || []).filter(e => !hasEncoder(e));
      if (missing.length) { s.skip = `kodaren ${missing.join(', ')} saknas i ffmpeg`; continue; }
      const file = path.join(CACHE_DIR, `${s.id}-${keyOf(s, files)}${s.ext}`);
      if (!fs.existsSync(file)) {
        const tmp = file.replace(s.ext, '.tmp' + s.ext);
        const t0 = Date.now();
        try {
          await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...s.args(files), '-t', String(DUR), tmp], { maxBuffer: 16 << 20 });
          if (s.post) s.post(tmp);
          fs.renameSync(tmp, file);
          log(`skapade ${s.id} på ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          s.skip = `kunde inte skapas: ${String(e.stderr || e.message).trim().split('\n').slice(-2).join(' ')}`;
          continue;
        }
      }
      s.file = file;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, out.length) }, worker));
  return out;
}

/** Lägger källorna i <lib> med bibliotekets filnamn ("Titel (år).ext") – hårda länkar om det går, annars kopior */
export function linkLibrary(sources, lib) {
  fs.mkdirSync(lib, { recursive: true });
  sources.filter(s => s.file).forEach((s, i) => {
    // Neutrala titlar: scannern stryker ord som "HEVC", "HDR" och "DTS" ur filnamnet
    s.title = `Prov ${String(i + 1).padStart(2, '0')}`;
    const base = path.join(lib, `${s.title} (${2001 + i})`);
    s.libFile = base + s.ext;
    fs.rmSync(s.libFile, { force: true });
    try { fs.linkSync(s.file, s.libFile); } catch { fs.copyFileSync(s.file, s.libFile); }
    for (const [suffix, fn] of Object.entries(s.extras || {})) fs.writeFileSync(base + suffix, fn());
  });
  return sources;
}

// Kommandorad: skapa samlingen och länka in den i en mapp (används av macOS-jobbet)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv.slice(2).find(a => !a.startsWith('--')) || path.join(CACHE_DIR, 'bibliotek');
  const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
  const srcs = await generate({ ids: only, full: process.argv.includes('--full'), log: console.log });
  linkLibrary(srcs, path.join(dir, 'Filmer'));
  for (const s of srcs) console.log(s.skip ? `hoppar över ${s.id}: ${s.skip}` : `${s.id}: ${s.libFile}`);
}
