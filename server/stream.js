import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream';
import { send, fail, MIME, streamFile, writeAtomic } from './util.js';
import { CACHE, SUBS_DIR, getSetting } from './db.js';
import { fastKeyframes } from './keyframes.js';
import { SubReader, vttParser } from './subreader.js';

const pexec = promisify(execFile);
const SEG = 6; // målängd per HLS-segment i sekunder
// Omkodning börjar med korta segment (0, 2, 4 s) så att bilden kommer igång snabbare, sedan SEG s
const HEAD = [0, 2, 4];
// ffmpeg får bara läsa lokala filer (skydd mot skadliga mediefiler som försöker öppna nätverksadresser)
export const SAFE_IN = ['-protocol_whitelist', 'file,pipe'];
const m3uAttr = (v) => String(v ?? '').replace(/["\r\n,]/g, ' ').slice(0, 80);
export const TRANSCODE = process.env.TRANSCODE_DIR || path.join(os.tmpdir(), 'braxhn-tv-transcode');
// Rensa gamla sessioner från förra körningen – bara innehållet: mappen är ofta en monterad volym
// (/transcode i Docker) som användaren inte får ta bort, och ett fel här får aldrig stoppa starten
fs.mkdirSync(TRANSCODE, { recursive: true });
try {
  for (const f of fs.readdirSync(TRANSCODE)) {
    try { fs.rmSync(path.join(TRANSCODE, f), { recursive: true, force: true }); } catch (e) { console.warn('[hls] kunde inte rensa', f, e.message); }
  }
} catch (e) { console.warn('[hls] kunde inte läsa omkodningsmappen', TRANSCODE, e.message); }
const HW_WANTED = (process.env.HWACCEL || 'none').toLowerCase(); // none | vaapi | nvenc | qsv
// Hårdvaruomkodning som inte fungerar (t.ex. nvenc utan NVIDIA-drivrutin i containern: "Cannot load libcuda.so.1")
// får aldrig stoppa uppspelningen – då används processorn i stället och adminsidan visar varför.
let HW = HW_WANTED;
export const hwStatus = { wanted: HW_WANTED, active: HW_WANTED, error: null };
const HW_FAIL = /libcuda|nvenc|cuda|vaapi|va-api|qsv|libmfx|mfx|hwupload|hwaccel|Failed to (initiali[sz]e|open|create)|No (VA display|device|NVENC)|device (type|creation)|Error while opening encoder|Generic error in an external library/i;
/** Begriplig åtgärd för de vanligaste felen (ffmpegs egna meddelanden är svåra att tolka) */
export function hwHint(err) {
  if (/libcuda|libnvidia-encode|Cannot load|cuInit|CUDA_ERROR_NO_DEVICE|no CUDA-capable/i.test(err))
    return 'containern når inte NVIDIA-drivrutinen. Installera pluginen Nvidia-Driver, lägg till --runtime=nvidia under Extra Parameters och sätt NVIDIA_VISIBLE_DEVICES=all och NVIDIA_DRIVER_CAPABILITIES=all (eller använd mallen braxhn-tv-nvidia.xml).';
  if (/API version|minimum required Nvidia driver|Driver does not support/i.test(err))
    return 'NVIDIA-drivrutinen är för gammal för ffmpeg i containern – uppdatera drivrutinen i pluginen Nvidia-Driver.';
  if (/OpenEncodeSessionEx|out of memory|incompatible client key/i.test(err))
    return 'grafikkortet tillåter inte fler samtidiga kodningar (vanligt på GeForce) eller används av något annat, t.ex. en annan mediaserver.';
  if (/vaapi|VA-API|renderD|\/dev\/dri|No VA display/i.test(err))
    return 'enheten /dev/dri saknas i containern – lägg till den under GPU-enhet (Intel/AMD).';
  return null;
}
export function disableHw(reason) {
  if (HW === 'none') return;
  console.warn(`[hårdvara] ${HW} fungerar inte – använder processorn i stället. ${String(reason || '').split('\n').filter(Boolean).slice(-2).join(' ')}`);
  const tip = hwHint(String(reason || ''));
  if (tip) console.warn(`[hårdvara] Åtgärd: ${tip}`);
  hwStatus.hint = tip;
  hwStatus.error = String(reason || '').trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
  HW = 'none'; hwStatus.active = 'none';
}
// Snabbtest vid start: koda två bildrutor med den valda hårdvaran
if (HW !== 'none') {
  const enc = { vaapi: ['-vaapi_device', process.env.VAAPI_DEVICE || '/dev/dri/renderD128', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:d=0.2', '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi'],
    nvenc: ['-f', 'lavfi', '-i', 'color=c=black:s=256x144:d=0.2', '-c:v', 'h264_nvenc'], qsv: ['-f', 'lavfi', '-i', 'color=c=black:s=256x144:d=0.2', '-vf', 'format=nv12', '-c:v', 'h264_qsv'] }[HW];
  if (!enc) disableHw(`okänt värde HWACCEL=${HW}`);
  else execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...enc, '-frames:v', '2', '-f', 'null', '-'], { timeout: 20000 }, (e, _o, stderr) => {
    if (e) disableHw(stderr || e.message); else console.log(`[hårdvara] ${HW} fungerar`);
  });
}
const VAAPI_DEV = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
// Avkodning på grafikkortet när omkodningen ändå görs där (4K-HEVC är tungt att avkoda med processorn).
// Utan -hwaccel_output_format hämtas bilderna tillbaka automatiskt, så alla mjukvarufilter fungerar som förut,
// och format som kortet inte klarar avkodas med processorn. HW_DECODE=0 stänger av.
const hwDecode = () => process.env.HW_DECODE === '0' ? []
  : HW === 'nvenc' ? ['-hwaccel', 'cuda'] : HW === 'vaapi' ? ['-hwaccel', 'vaapi', '-hwaccel_device', VAAPI_DEV] : [];
const TONEMAP = process.env.TONEMAP || 'hable'; // hable | mobius | reinhard | bt2390

const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const BITMAP_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
const CONTAINER = { '.mp4': 'mp4', '.m4v': 'mp4', '.mov': 'mp4', '.webm': 'webm', '.mkv': 'mkv' };

export const QUALITIES = {
  orig: { h: null, br: null }, '2160': { h: 2160, br: 25000 }, '1080': { h: 1080, br: 8000 },
  '720': { h: 720, br: 4000 }, '480': { h: 480, br: 1500 }, '360': { h: 360, br: 800 }
};

export const streamsOf = (it) => { try { return JSON.parse(it.streams || '[]'); } catch { return []; } };
const videoOf = (it) => streamsOf(it).find(s => s.type === 'video');
const is10bit = (v) => /10|12/.test(v?.pix || '');

// ---------------- undertexter ----------------
// Mapplistningar cachas per mapp och läses om bara när mappens ändringstid ändras (ny/borttagen fil)
const dirCache = new Map();
function listDir(dir) {
  const mtime = fs.statSync(dir).mtimeMs; // kastar om mappen saknas
  const c = dirCache.get(dir);
  if (c && c.mtime === mtime) return c.files;
  const files = fs.readdirSync(dir);
  dirCache.delete(dir);
  dirCache.set(dir, { mtime, files });
  if (dirCache.size > 2000) dirCache.delete(dirCache.keys().next().value);
  return files;
}
export function subtitlesOf(it) {
  const out = [];
  for (const s of streamsOf(it)) {
    if (s.type !== 'subtitle') continue;
    const bitmap = BITMAP_SUBS.has(s.codec);
    if (!bitmap && !TEXT_SUBS.has(s.codec)) continue;
    out.push({
      // PGS (Blu-ray) visas som bilder i webbspelaren; övriga bildformat bränns in
      id: 'e' + s.index, lang: s.lang, forced: s.forced, hi: !!s.hi, bitmap, pgs: s.codec === 'hdmv_pgs_subtitle', source: 'embedded',
      label: [s.title, s.lang].filter(Boolean).join(' · ') + (bitmap ? ' (bild)' : '') || `Spår ${s.index}`
    });
  }
  const dir = path.dirname(it.path), base = path.basename(it.path, path.extname(it.path));
  try {
    listDir(dir).filter(f => f.startsWith(base) && /\.(srt|vtt|ass|ssa)$/i.test(f)).sort().forEach((f, i) => {
      const tag = f.slice(base.length).replace(/\.(srt|vtt|ass|ssa)$/i, '').replace(/^[._-]+/, '');
      out.push({ id: 'x' + i, file: path.join(dir, f), lang: tag.split(/[._-]/)[0] || null, label: (tag || 'Extern') + ' (fil)', forced: /forced/i.test(tag), bitmap: false, source: 'external' });
    });
  } catch {}
  try {
    const d = path.join(SUBS_DIR, String(it.id));
    listDir(d).filter(f => /\.(srt|vtt|ass)$/i.test(f)).sort().forEach((f, i) => {
      const lang = f.split('.')[0];
      out.push({ id: 'd' + i, file: path.join(d, f), lang, label: `${lang} (nedladdad)`, forced: false, bitmap: false, source: 'downloaded' });
    });
  } catch {}
  return out;
}

// Undertexter extraheras en gång per fil och cachas (inbäddade spår kräver att hela filen läses)
let subActive = 0; const subWait = [];
async function subSlot(fn) {
  if (subActive >= 2) await new Promise(r => subWait.push(r));
  subActive++;
  try { return await fn(); } finally { subActive--; subWait.shift()?.(); }
}
const subRunning = new Map();
const subKey = (it, sub) => `${it.id}-${it.mtime}-${sub.id}${sub.file ? '-' + (fs.statSync(sub.file).mtimeMs | 0) : ''}`;
const subCacheFile = (it, sub) => path.join(CACHE, 'subs', subKey(it, sub) + '.vtt');
function extractVtt(it, sub) {
  const key = subKey(it, sub);
  const file = subCacheFile(it, sub);
  if (fs.existsSync(file)) return fs.promises.readFile(file, 'utf8');
  if (subRunning.has(key)) return subRunning.get(key);
  const pr = subSlot(() => new Promise((ok, no) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_IN];
    if (sub.file) {
      const fmt = { '.srt': 'srt', '.ass': 'ass', '.ssa': 'ass', '.vtt': 'webvtt' }[path.extname(sub.file).toLowerCase()];
      args.push('-sub_charenc', guessCharenc(sub.file), ...(fmt ? ['-f', fmt] : []), '-i', sub.file, '-map', '0:s:0');
    } else args.push('-i', it.path, '-map', '0:' + sub.id.slice(1));
    args.push('-f', 'webvtt', 'pipe:1');
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = []; let size = 0;
    p.stdout.on('data', c => { size += c.length; if (size > 20 << 20) p.kill('SIGKILL'); else chunks.push(c); });
    const timer = setTimeout(() => p.kill('SIGKILL'), 10 * 60e3);
    p.on('error', (e) => { clearTimeout(timer); no(new Error('Kunde inte starta ffmpeg: ' + e.message)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !chunks.length) return no(new Error('Kunde inte läsa undertexten'));
      const vtt = Buffer.concat(chunks).toString('utf8');
      // Avbruten eller misslyckad körning: skicka det som finns men cacha inte en avkortad fil
      if (code === 0) try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeAtomic(file, vtt); } catch {}
      ok(vtt);
    });
  })).finally(() => subRunning.delete(key));
  subRunning.set(key, pr);
  return pr;
}
// Inbäddad textundertext som läses där tittaren är (webbspelaren frågar igen tills allt är läst – se subreader.js)
const liveSubs = new Map();
const vttTime = (t) => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`; };
const cuesToVtt = (cues) => 'WEBVTT\n\n' + cues.map(c => `${vttTime(c.s)} --> ${vttTime(c.e)}${c.settings ? ' ' + c.settings : ''}\n${c.text}`).join('\n\n') + '\n';
function liveVtt(it, sub, t) {
  const key = subKey(it, sub);
  let j = liveSubs.get(key);
  if (!j) {
    j = { cues: [], done: false, error: null };
    const forget = (ms) => setTimeout(() => { if (liveSubs.get(key) === j) liveSubs.delete(key); }, ms).unref();
    j.reader = new SubReader({
      file: it.path, stream: +sub.id.slice(1), format: 'webvtt', duration: it.duration || 0,
      parser: () => vttParser((c) => {
        // Sorterat på starttid; två läsningar som överlappar ger samma cue två gånger
        let lo = 0, hi = j.cues.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (j.cues[m].s < c.s) lo = m + 1; else hi = m; }
        for (let k = lo; k < j.cues.length && j.cues[k].s === c.s; k++) if (j.cues[k].text === c.text) return;
        j.cues.splice(lo, 0, c);
      }),
      onComplete: () => {
        j.done = true;
        try { fs.mkdirSync(path.join(CACHE, 'subs'), { recursive: true }); writeAtomic(subCacheFile(it, sub), cuesToVtt(j.cues)); } catch {}
        forget(120e3);
      },
      onError: (msg) => { j.done = true; j.error = msg || 'Kunde inte läsa undertexten'; console.warn('[undertext]', it.path, j.error); forget(30 * 60e3); }
    });
    liveSubs.set(key, j);
  }
  j.reader.want(t);
  return j;
}
function shiftVtt(vtt, offset) {
  if (!offset) return vtt;
  const fmt = (t) => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`; };
  const parse = (x) => x.split(':').reduce((a, v) => a * 60 + parseFloat(v), 0);
  return vtt.replace(/((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})/g, (_, a, b) => `${fmt(parse(a) + offset)} --> ${fmt(parse(b) + offset)}`);
}

export async function serveSubtitle(req, res, it, sid, query) {
  const sub = subtitlesOf(it).find(s => s.id === sid);
  if (!sub || sub.bitmap) return fail(res, 404, 'Undertext saknas');
  const offset = Math.max(-600, Math.min(600, parseFloat(query.get('offset') || '0') || 0));
  let vtt;
  // Webbspelaren (live=1): ett inbäddat spår som inte lästs än läses där tittaren är (pos) och skickas i
  // omgångar – annars syns inget förrän hela filen lästs, vilket tar minuter för en stor film
  if (query.get('live') === '1' && !sub.file && !fs.existsSync(subCacheFile(it, sub))) {
    const pos = Math.max(0, +query.get('pos') || 0);
    const j = liveVtt(it, sub, pos);
    // Vänta en kort stund tills läsningen nått tittaren (oftast under en sekund) så att första svaret har text
    for (let k = 0; k < 25 && !j.done && !j.reader.covers(pos + 15) && !req.destroyed; k++) await new Promise(r => setTimeout(r, 100));
    if (j.error && !j.cues.length) return fail(res, 500, 'Kunde inte läsa undertexten');
    return send(res, 200, shiftVtt(cuesToVtt(j.cues), offset), { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store', 'X-Undertext-Klar': j.done ? '1' : '0' });
  }
  try { vtt = shiftVtt(await extractVtt(it, sub), offset); } catch (e) { return fail(res, 500, e.message); }
  // Apple kräver tidsmappning mot MPEG-TS för undertexter i HLS
  if (query.get('hls') === '1') vtt = vtt.replace(/^WEBVTT[^\n]*\n/, 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n');
  send(res, 200, vtt, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=600', 'X-Undertext-Klar': '1' });
}
// Äldre svenska .srt-filer är ofta Windows-1252 – kolla om innehållet är giltig UTF-8
function guessCharenc(file) {
  try {
    // Läs bara början av filen (räcker för att avgöra teckenkodningen)
    const b = Buffer.alloc(65536), fd = fs.openSync(file, 'r');
    let n; try { n = fs.readSync(fd, b, 0, b.length, 0); } finally { fs.closeSync(fd); }
    let sub = b.subarray(0, n);
    // Klipp inte mitt i ett flerbytestecken
    if (n === b.length) { let k = n; while (k > n - 4 && (sub[k - 1] & 0xc0) === 0x80) k--; if (k > 0 && sub[k - 1] >= 0xc0) k--; sub = sub.subarray(0, k); }
    new TextDecoder('utf-8', { fatal: true }).decode(sub);
    return 'UTF-8';
  } catch { return 'CP1252'; }
}

// ---------------- direktuppspelning ----------------
export function serveDirect(req, res, it) {
  let st; try { st = fs.statSync(it.path); } catch { return fail(res, 404, 'Filen hittades inte'); }
  const type = MIME[path.extname(it.path).toLowerCase()] || 'application/octet-stream';
  streamFile(req, res, it.path, st.size, { 'Content-Type': type, 'Cache-Control': 'no-store' });
}

export function serveDownload(req, res, it) {
  let st; try { st = fs.statSync(it.path); } catch { return fail(res, 404, 'Filen hittades inte'); }
  streamFile(req, res, it.path, st.size, { 'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(it.path))}` }, { ranges: false });
}

// ---------------- nyckelbilder (för remux) ----------------
// Liten LRU-cache i minnet (nyckelbildslistor kan vara stora); resten läses från disk vid behov
const kfMem = new Map();
const KF_MAX = 64;
function kfRemember(id, mtime, kf) {
  kfMem.delete(id);
  kfMem.set(id, { mtime, kf });
  if (kfMem.size > KF_MAX) kfMem.delete(kfMem.keys().next().value);
}
const kfFile = (it) => path.join(CACHE, 'keyframes', `${it.id}-${it.mtime}.json`);
export function keyframesReady(it) {
  const m = kfMem.get(it.id);
  if (m && m.mtime === it.mtime) { kfMem.delete(it.id); kfMem.set(it.id, m); return m.kf; }
  try {
    const kf = JSON.parse(fs.readFileSync(kfFile(it), 'utf8'));
    kfRemember(it.id, it.mtime, kf);
    return kf;
  } catch { return null; }
}
/** Finns nyckelbilderna redan indexerade? (utan att läsa in dem) */
export const keyframesCached = (it) => kfMem.get(it.id)?.mtime === it.mtime || fs.existsSync(kfFile(it));
export const kfCacheSize = () => kfMem.size;
const kfRunning = new Map();
const kfQueued = new Map(); // id → väntande plats i kön (bakgrundsanalys)
let kfActive = 0; const kfWait = [];
export function computeKeyframes(it, { priority = false } = {}) {
  if (!['h264', 'hevc'].includes(it.vcodec)) return Promise.resolve(null); // remux: H.264 (TS) och HEVC (fMP4)
  if (keyframesReady(it)) return Promise.resolve(keyframesReady(it));
  if (kfRunning.has(it.id)) {
    // Bakgrundsanalysen har redan köat filen – den som tryckt på Spela ska inte vänta på kön
    const r = kfQueued.get(it.id);
    if (priority && r) {
      const i = kfWait.indexOf(r); if (i >= 0) kfWait.splice(i, 1);
      kfQueued.delete(it.id);
      if (kfActive < 3) r(); else kfWait.unshift(r);
    }
    return kfRunning.get(it.id);
  }
  const p = (async () => {
    // Bakgrundsanalysen använder högst två samtidigt; den som just tryckt på Spela får en egen plats direkt
    if (priority ? kfActive >= 3 : kfActive >= 2) await new Promise(r => { if (priority) kfWait.unshift(r); else { kfWait.push(r); kfQueued.set(it.id, r); } });
    kfQueued.delete(it.id);
    kfActive++;
    try {
      // Snabba vägen: filens eget index (MKV Cues / MP4 moov) – sekunder i stället för att läsa hela filen.
      // fMP4-remux (HEVC) delar på varje nyckelbild och kräver en komplett lista; TS (H.264) klarar ett urval.
      const fast = await fastKeyframes(it.path, it.duration);
      let kf = fast && (fast.complete || it.vcodec === 'h264') ? fast.kf : null;
      if (!kf) {
        const t0 = Date.now();
        const { stdout } = await pexec('ffprobe', ['-v', 'error', ...SAFE_IN, '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags',
          '-of', 'csv=p=0', it.path], { maxBuffer: 256 << 20, timeout: 30 * 60000 });
        kf = [];
        for (const line of stdout.split('\n')) {
          const [t, flags] = line.split(',');
          if (flags && flags[0] === 'K') { const x = parseFloat(t); if (!isNaN(x)) kf.push(x); }
        }
        kf.sort((a, b) => a - b);
        // Diagnos: när någon väntar (Spela) syns det varför starten tog tid
        if (priority) console.log(`[nyckelbilder] ${path.basename(it.path)}: ${fast ? 'filens index var ofullständigt' : 'filens index gick inte att använda'} – hela filen lästes på ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
      for (const f of fs.readdirSync(path.join(CACHE, 'keyframes'))) if (f.startsWith(it.id + '-')) fs.rmSync(path.join(CACHE, 'keyframes', f), { force: true });
      writeAtomic(kfFile(it), JSON.stringify(kf)); // en halv fil skulle räknas som indexerad men aldrig gå att läsa
      kfRemember(it.id, it.mtime, kf);
      return kf;
    } catch (e) { console.warn('[keyframes]', it.path, e.message); return null; }
    finally { kfRunning.delete(it.id); kfActive--; kfWait.shift()?.(); }
  })();
  kfRunning.set(it.id, p);
  return p;
}
// Segmentgränser: första nyckelbild ≥ föregående gräns + SEG
// ts (H.264): egna gränser ≈ SEG s via segment-muxern. fmp4 (HEVC): ett segment per GOP – ffmpegs
// HLS-muxer med mycket kort hls_time delar på varje nyckelbild, vilket blir deterministiskt vid omstart.
function remuxBounds(it, fmt = 'ts') {
  const kf = keyframesReady(it);
  if (!kf || kf.length < 2) return null;
  if (fmt === 'fmp4') return [0, ...kf.filter(t => t > 0.05 && t < it.duration - 0.5)];
  const b = [0];
  let last = 0;
  for (const t of kf) if (t >= last + SEG - 0.001 && t < it.duration - 0.5) { b.push(t); last = t; }
  return b;
}

// ---------------- uppspelningsbeslut ----------------
// Klienten anger vad den klarar; servern väljer direkt / remux / omkodning.
export function parseCaps(q, ua = '') {
  const list = (k, def) => new Set((q.get(k) || def).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  return {
    containers: list('c', 'mp4,webm'), vcodecs: list('v', 'h264,vp8,vp9'), acodecs: list('a', 'aac,mp3,opus,vorbis,flac'),
    hdr: q.get('hdr') === '1', dv: q.get('dv') === '1', q: QUALITIES[q.get('q')] ? q.get('q') : 'orig',
    audio: /^\d{1,3}$/.test(q.get('audio') || '') ? String(parseInt(q.get('audio'))) : '', sub: String(q.get('sub') || '').slice(0, 10),
    hlsSubs: q.get('hlssubs') === '1', force: q.get('force') || '',
    // Spelaren använder webbläsarens egen HLS (Safari på iPhone/iPad/Mac) i stället för hls.js
    nativeHls: q.get('nhls') === '1'
  };
}

export function decide(it, o) {
  const s = streamsOf(it), v = s.find(x => x.type === 'video');
  const audios = s.filter(x => x.type === 'audio');
  const defAudio = audios.find(a => a.default) || audios[0];
  const aSel = o.audio ? audios.find(a => String(a.index) === o.audio) || defAudio : defAudio;
  const sub = o.sub ? subtitlesOf(it).find(x => x.id === o.sub) : null;
  const burn = sub?.bitmap ? sub.id : '';
  const Q = QUALITIES[o.q];
  const srcKbps = it.size && it.duration ? it.size * 8 / it.duration / 1000 : 0;
  // Sänk även om bithastigheten är för hög för vald kvalitet (t.ex. 4K-remux utanför hemmet)
  const scale = !!(Q.h && ((v?.height && v.height > Q.h) || (Q.br && srcKbps > Q.br * 1.3)));
  const tonemap = !!(it.hdr && !o.hdr);
  const ext = CONTAINER[path.extname(it.path).toLowerCase()];
  const reasons = [];
  if (burn) reasons.push('bildundertext bränns in');
  if (scale) reasons.push(`sänkt kvalitet till ${o.q}p`);
  if (tonemap) reasons.push(`${it.hdr.toUpperCase()} tonmappas till SDR`);
  // Dolby Vision profil 5 saknar HDR10-baslager – kräver en enhet med Dolby Vision
  const dv5 = v?.dovi && v?.dvProfile === 5;
  const vOk = v && o.vcodecs.has(v.codec) && !(v.codec === 'h264' && is10bit(v)) && !(dv5 && !o.dv);
  const aOk = !aSel || o.acodecs.has(aSel.codec);
  const audioDefault = !aSel || aSel === defAudio;
  let mode, fmt = 'ts', tag = '';
  let am = audioPlan(aSel, o);
  if (!burn && !scale && !tonemap && vOk && aOk && audioDefault && ext && o.containers.has(ext) && o.force !== 'hls' && o.force !== 'transcode') mode = 'direct';
  else if (!burn && !scale && !tonemap && o.force !== 'transcode' && v?.codec === 'h264' && !is10bit(v) && (o.assumeKf || remuxBounds(it, 'ts'))) mode = 'remux';
  else if (!burn && !scale && !tonemap && o.force !== 'transcode' && v?.codec === 'hevc' && vOk && (o.assumeKf || remuxBounds(it, 'fmp4'))) {
    mode = 'remux'; fmt = 'fmp4'; tag = dv5 ? 'dvh1' : 'hvc1';
  } else mode = 'transcode';
  // Safaris egen HLS-spelare (iPhone) klarar inte Dolby Digital i MPEG-TS-segment – filmen startar aldrig.
  // I fMP4 (HEVC-remux) fungerar det; i TS blir ljudet AAC.
  if (o.nativeHls && mode !== 'direct' && fmt === 'ts' && am === 'copy' && aSel && ['ac3', 'eac3'].includes(aSel.codec)) am = 'aac';
  if (mode === 'remux') reasons.push((fmt === 'fmp4' ? `${it.hdr ? it.hdr.toUpperCase() + '-' : ''}HEVC kopieras utan omkodning` : 'bilden kopieras utan omkodning') +
    (am === 'aac' ? ', ljudet konverteras till AAC' : am === 'eac3' ? ', surroundljud konverteras till Dolby Digital Plus 5.1' : ''));
  if (mode !== 'direct' && am === 'copy' && aSel && ['ac3', 'eac3'].includes(aSel.codec)) reasons.push(`${aSel.codec === 'eac3' ? 'Dolby Digital Plus/Atmos' : 'Dolby Digital'} skickas orört`);
  if (mode === 'transcode' && !reasons.length) {
    if (!vOk) reasons.push(`videoformatet ${v?.codec || '?'} stöds inte av enheten`);
    else if (['h264', 'hevc'].includes(v?.codec) && !keyframesReady(it)) reasons.push('nyckelbilder ej indexerade än');
    else reasons.push('formatet stöds inte direkt');
  }
  if ((mode === 'remux' || mode === 'transcode') && !o.assumeKf) computeKeyframes(it).catch(() => {});
  return { mode, reasons, audio: aSel ? String(aSel.index) : '', audioMode: am, burn, tonemap, q: o.q, fmt, tag, hdr: mode === 'remux' ? it.hdr : null };
}
function copyAudio(a, o) { return ['aac', 'mp3', 'ac3', 'eac3'].includes(a.codec) && o.acodecs.has(a.codec) && (a.codec !== 'aac' || (a.channels || 2) <= 6); }
// Ljud: skicka orört om enheten klarar det; annars surround → Dolby Digital Plus 5.1 (om enheten klarar E-AC-3), annars AAC stereo
function audioPlan(a, o) {
  if (!a) return 'aac';
  if (copyAudio(a, o)) return 'copy';
  if ((a.channels || 2) > 2 && o.acodecs.has('eac3')) return 'eac3';
  return 'aac';
}

// Parametrar som identifierar en HLS-session (och följer med i alla segment-URL:er)
export function hlsParams(d, o, token) {
  // pid: en egen omkodningssession per uppspelning – två enheter på samma konto som tittar på samma titel
  // ska inte stoppa varandras ffmpeg
  const p = new URLSearchParams({ mode: d.mode, q: d.q, audio: d.audio, am: d.audioMode, burn: d.burn, tm: d.tonemap ? '1' : '0', fmt: d.fmt, tag: d.tag || '',
    pid: crypto.randomBytes(4).toString('hex') });
  if (d.hdr) p.set('vr', d.hdr === 'hlg' ? 'HLG' : 'PQ');
  // Anpassningsbar kvalitet: mastern listar även lägre steg (bara vid omkodning med automatisk kvalitet)
  if (d.abr && d.mode === 'transcode') p.set('abr', '1');
  if (o.hlsSubs) p.set('hlssubs', '1');
  if (token) p.set('t', token);
  return p;
}
function readParams(q) {
  return {
    mode: q.get('mode') === 'remux' ? 'remux' : 'transcode', q: QUALITIES[q.get('q')] ? q.get('q') : 'orig',
    audio: /^\d{1,3}$/.test(q.get('audio') || '') ? String(parseInt(q.get('audio'))) : '',
    audioMode: ['copy', 'eac3', 'aac'].includes(q.get('am')) ? q.get('am') : 'aac',
    fmt: q.get('fmt') === 'fmp4' ? 'fmp4' : 'ts', tag: ['hvc1', 'dvh1'].includes(q.get('tag')) ? q.get('tag') : '',
    burn: /^e\d+$/.test(q.get('burn') || '') ? q.get('burn') : '', tonemap: q.get('tm') === '1', hlsSubs: q.get('hlssubs') === '1',
    vr: ['PQ', 'HLG'].includes(q.get('vr')) ? q.get('vr') : '',
    pid: /^[0-9a-f]{8}$/.test(q.get('pid') || '') ? q.get('pid') : '', abr: q.get('abr') === '1'
  };
}
const normParams = (d) => { if (d.mode !== 'remux') { d.fmt = 'ts'; d.tag = ''; } return d; };
const withT = (p, q) => { const t = q.get('t'); if (t) p.set('t', t); return p; };

// ---------------- anpassningsbar kvalitet (ABR) ----------------
// Lägre steg som spelaren får växla ner till. Varje steg är en egen omkodningssession (q ingår i nyckeln)
// och omkodas först när spelaren faktiskt hämtar dess segment. Segmentgränserna (fasta SEG s) och
// tidsstämplarna (output_ts_offset) är identiska mellan stegen, så bytena blir sömlösa.
const ABR_STEPS = ['1080', '720', '480'];
const audioKbps = (d) => d.audioMode === 'eac3' ? 640 : d.audioMode === 'copy' ? 640 : 192;
/** Varianter för mastern: [{ q, h, w, bw }] – vald kvalitet först, sedan lägre steg (≤ källans höjd och ≤ vald kvalitet) */
export function abrVariants(it, d) {
  const v = videoOf(it);
  const srcH = v?.height || 0;
  const size = (q) => {
    const Q = QUALITIES[q];
    const h = Q.h && (!srcH || srcH > Q.h) ? Q.h : srcH || Q.h || 720;
    const w = v?.width && v?.height ? Math.round(v.width * h / v.height / 2) * 2 : Math.round(h * 16 / 9 / 2) * 2;
    const vk = Q.br || (h >= 2000 ? 40000 : h >= 1000 ? 12000 : 6000);
    // BANDWIDTH är toppvärdet: maxrate + marginal för buffert och muxning + ljud
    return { q, h, w, bw: Math.round((vk * 1.1 + audioKbps(d)) * 1000) };
  };
  const top = size(d.q);
  const out = [top];
  if (!(d.abr && d.mode === 'transcode')) return out;
  for (const q of ABR_STEPS) if (QUALITIES[q].h < top.h && (!srcH || QUALITIES[q].h <= srcH)) out.push(size(q));
  return out;
}

export function serveMaster(res, it, query) {
  const d = normParams(readParams(query));
  if (d.abr && d.mode === 'transcode') return serveAbrMaster(res, it, query, d);
  const v = videoOf(it);
  const Q = QUALITIES[d.q];
  const h = Q.h && v?.height > Q.h ? Q.h : v?.height || 720;
  const w = v?.width && v?.height ? Math.round(v.width * h / v.height / 2) * 2 : Math.round(h * 16 / 9);
  const bw = (Q.br || (d.mode === 'remux' ? Math.max(4000, Math.round((it.size * 8 / (it.duration || 1)) / 1000)) : h >= 2000 ? 40000 : h >= 1000 ? 12000 : 6000)) * 1000;
  const params = new URLSearchParams(query); params.delete('hlssubs');
  const subs = subsMedia(it, query, d);
  let m = '#EXTM3U\n#EXT-X-VERSION:4\n' + subs.m;
  // VIDEO-RANGE talar om för Apple-enheter att strömmen är HDR (krävs för att HDR-läget ska slås på)
  const vr = d.mode === 'remux' && d.vr ? `,VIDEO-RANGE=${d.vr}` : '';
  m += `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h}${vr}${subs.attr}\nindex.m3u8?${params}\n`;
  send(res, 200, m, { 'Content-Type': 'application/vnd.apple.mpegurl' });
}

function subsMedia(it, query, d) {
  let m = '', attr = '';
  if (!d.hlsSubs) return { m, attr };
  const subs = subtitlesOf(it).filter(s => !s.bitmap);
  for (const s of subs) {
    const sp = withT(new URLSearchParams(), query);
    m += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${m3uAttr(s.label || s.id)}",LANGUAGE="${m3uAttr(s.lang || 'und')}",AUTOSELECT=${s.forced ? 'YES' : 'NO'},DEFAULT=NO,FORCED=${s.forced ? 'YES' : 'NO'},URI="subs-${s.id}.m3u8?${sp}"\n`;
  }
  if (subs.length) attr = ',SUBTITLES="subs"';
  return { m, attr };
}
// Flera varianter: vald kvalitet först (Apple-enheter startar på första varianten), sedan fallande
function serveAbrMaster(res, it, query, d) {
  const subs = subsMedia(it, query, d);
  let m = '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-INDEPENDENT-SEGMENTS\n' + subs.m;
  for (const x of abrVariants(it, d)) {
    const params = new URLSearchParams(query); params.delete('hlssubs'); params.set('q', x.q);
    m += `#EXT-X-STREAM-INF:BANDWIDTH=${x.bw},RESOLUTION=${x.w}x${x.h}${subs.attr}\nindex.m3u8?${params}\n`;
  }
  send(res, 200, m, { 'Content-Type': 'application/vnd.apple.mpegurl' });
}

export function serveSubPlaylist(res, it, sid, query) {
  const sp = withT(new URLSearchParams({ hls: '1' }), query);
  const d = Math.ceil(it.duration || 1);
  send(res, 200, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${d}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${(it.duration || 1).toFixed(3)},\n../subs/${sid}.vtt?${sp}\n#EXT-X-ENDLIST\n`,
    { 'Content-Type': 'application/vnd.apple.mpegurl' });
}

function segmentsOf(it, d) {
  if (d.mode === 'remux') {
    const b = remuxBounds(it, d.fmt);
    if (b) return b.map((t, i) => ({ start: t, dur: (b[i + 1] ?? it.duration) - t }));
  }
  const starts = HEAD.filter(t => t === 0 || t < it.duration - 0.5);
  for (let t = SEG; t < it.duration - 0.5; t += SEG) starts.push(t);
  return starts.map((t, i) => ({ start: t, dur: (starts[i + 1] ?? it.duration) - t }));
}

export function servePlaylist(res, it, query) {
  if (!it.duration) return fail(res, 422, 'Okänd längd – kan inte strömma');
  const d = normParams(readParams(query));
  if (d.mode === 'remux' && !remuxBounds(it, d.fmt)) { d.mode = 'transcode'; normParams(d); }
  const segs = segmentsOf(it, d);
  const qs = new URLSearchParams(query); qs.set('mode', d.mode); qs.set('fmt', d.fmt); qs.delete('hlssubs');
  const target = Math.ceil(Math.max(...segs.map(s => s.dur)));
  const fm = d.fmt === 'fmp4';
  let m = `#EXTM3U\n#EXT-X-VERSION:${fm ? 7 : 3}\n#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n`;
  if (fm) m += `#EXT-X-MAP:URI="init.mp4?${qs}"\n`;
  segs.forEach((s, i) => { m += `#EXTINF:${s.dur.toFixed(6)},\nseg-${i}.${fm ? 'm4s' : 'ts'}?${qs}\n`; });
  m += '#EXT-X-ENDLIST\n';
  send(res, 200, m, { 'Content-Type': 'application/vnd.apple.mpegurl' });
}

// ---------------- ffmpeg-argument ----------------
const TM_CPU = () => `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=${TONEMAP}:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;

// Tvingade nyckelbilder exakt på segmentgränserna (relativt ffmpegs start). Från början: 0, 2, 4, 6, 12 …
// – annars var SEG s. Mitt i de korta startsegmenten startar ffmpeg alltid om från början (se startFfmpeg).
const forcedKeys = (fromStart) => fromStart
  ? `expr:if(lt(n_forced,${HEAD.length}),gte(t,${HEAD[1] - HEAD[0]}*n_forced),gte(t,${SEG}*(n_forced-${HEAD.length - 1})))`
  : `expr:gte(t,n_forced*${SEG})`;

function videoArgs(it, d, fromStart) {
  const Q = QUALITIES[d.q] || QUALITIES.orig;
  const v = videoOf(it);
  const h = Q.h && v?.height && v.height > Q.h ? Q.h : null;
  // Inga B-bilder: med B-bilder börjar varje segments DTS före föregående segments sista DTS (ffmpegs TS-muxer
  // skjuter bara fram det första segmentet), och Chrome avbryter då uppspelningen ("formatet stöds inte").
  // Utan B-bilder är DTS = PTS och segmenten passar exakt ihop, oavsett kodare.
  const gop = ['-force_key_frames', forcedKeys(fromStart), '-bf', '0'];
  const rate = (hwFlag) => Q.br ? ['-b:v', Q.br + 'k', '-maxrate', Q.br + 'k', '-bufsize', Q.br * 2 + 'k'] : hwFlag;
  // Filterkedja i mjukvara (inbränning, skalning, tonmappning) innan ev. hårdvaruuppladdning
  const sw = [];
  // 4K med processorn: snabbare skalning (skillnaden syns inte vid nedskalning) och snabbare x264-läge nedan
  const big = HW === 'none' && (v?.height || 0) > 1100;
  if (h) sw.push(big ? `scale=-2:${h}:flags=bilinear` : `scale=-2:${h}`);
  const useVaapiTm = d.tonemap && HW === 'vaapi';
  if (d.tonemap && !useVaapiTm) sw.push(TM_CPU());
  const chain = (extra) => [...sw, ...extra].join(',') || 'null';
  let enc, post;
  if (HW === 'vaapi') {
    post = useVaapiTm ? ['format=p010', 'hwupload', 'tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709'] : ['format=nv12', 'hwupload'];
    enc = ['-c:v', 'h264_vaapi', ...rate(['-qp', '22'])];
  } else if (HW === 'nvenc') {
    post = ['format=yuv420p'];
    enc = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-forced-idr', '1', ...rate(['-cq', '22'])];
  } else if (HW === 'qsv') {
    post = ['format=nv12'];
    enc = ['-c:v', 'h264_qsv', '-forced_idr', '1', ...rate(['-global_quality', '22'])];
  } else {
    post = ['format=yuv420p'];
    enc = ['-c:v', 'libx264', '-preset', process.env.X264_PRESET || (big ? 'superfast' : 'veryfast'), ...rate(['-crf', '21']), '-profile:v', 'high', '-sc_threshold', '0'];
  }
  const vf = chain(post);
  const pre = HW === 'vaapi' ? ['-vaapi_device', VAAPI_DEV] : [];
  if (d.burn) {
    // Bildundertext läggs över videon innan övriga filter
    return { pre, filter: ['-filter_complex', `[0:v:0][0:${d.burn.slice(1)}]overlay=eof_action=pass:repeatlast=0,${vf}[vout]`], map: ['-map', '[vout]'], enc: [...enc, ...gop] };
  }
  return { pre, filter: ['-vf', vf], map: ['-map', '0:v:0'], enc: [...enc, ...gop] };
}

function audioArgs(d) {
  const map = d.audio !== '' ? ['-map', `0:${parseInt(d.audio)}`] : ['-map', '0:a:0?'];
  if (d.audioMode === 'copy') return [...map, '-c:a', 'copy'];
  if (d.audioMode === 'eac3') return [...map, '-c:a', 'eac3', '-b:a', '640k', '-ac', '6'];
  return [...map, '-c:a', 'aac', '-b:a', '192k', '-ac', '2'];
}

// ---------------- HLS-sessioner ----------------
const sessions = new Map();
const segExt = (s) => s.d.fmt === 'fmp4' ? 'm4s' : 'ts';
const segFile = (s, n) => path.join(s.dir, `seg_${String(n).padStart(5, '0')}.${segExt(s)}`);
const initFile = (s) => { try { const f = fs.readdirSync(s.dir).find(x => /^init_\d+\.mp4$/.test(x)); return f ? path.join(s.dir, f) : null; } catch { return null; } };

function startFfmpeg(s, it, n) {
  stopProc(s);
  const d = s.d;
  const segs = segmentsOf(it, d);
  // Nyckelbildsmönstret för de korta startsegmenten gäller bara när omkodningen börjar från början
  if (d.mode === 'transcode' && n > 0 && n < HEAD.length) n = 0;
  const t = segs[n].start;
  let args;
  if (d.mode === 'remux' && d.fmt === 'fmp4') {
    // HEVC/HDR/Dolby Vision i fMP4: HLS-muxern med mycket kort hls_time delar på varje nyckelbild
    const next = segs[n + 1]?.start ?? it.duration;
    const ss = n > 0 ? t + Math.min(0.25, (next - t) / 2) : 0;
    args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_IN, ...(n > 0 ? ['-ss', ss.toFixed(6)] : []), '-i', it.path,
      '-map', '0:v:0', ...audioArgs(d), '-c:v', 'copy', '-tag:v', d.tag || 'hvc1', '-sn', '-dn', '-strict', 'unofficial',
      '-output_ts_offset', ss.toFixed(6),
      '-f', 'hls', '-hls_time', '0.1', '-hls_list_size', '0', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', `init_${n}.mp4`,
      '-start_number', String(n), '-hls_flags', 'temp_file+independent_segments',
      // frag_discont: tfdt blir absolut tid även när ffmpeg startas mitt i filen (spolning)
      '-hls_segment_options', 'movflags=+frag_discont',
      '-hls_segment_filename', path.join(s.dir, 'seg_%05d.m4s'), path.join(s.dir, `ff_${n}.m3u8`)];
  } else if (d.mode === 'remux') {
    // Kopiera videoströmmen; dela exakt på förindexerade nyckelbilder
    // Sökning med kopierad video landar på nyckelbilden vars DTS ≤ ss. DTS ligger före PTS (B-bilder),
    // så sök en bit in i segmentet – men före nästa nyckelbild – för att landa exakt på rätt nyckelbild.
    const next = segs[n + 1]?.start ?? it.duration;
    const ss = n > 0 ? t + Math.min(0.25, (next - t) / 2) : 0;
    const times = segs.slice(n + 1).map(x => Math.max(0.001, x.start - ss - 0.005).toFixed(3));
    args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_IN, ...(n > 0 ? ['-ss', ss.toFixed(6)] : []), '-i', it.path,
      '-map', '0:v:0', ...audioArgs(d), '-c:v', 'copy', '-sn', '-dn',
      '-output_ts_offset', ss.toFixed(6), '-muxdelay', '0', '-muxpreload', '0',
      '-f', 'segment', '-segment_format', 'mpegts', ...(times.length ? ['-segment_times', times.join(',')] : ['-segment_time', '999999']),
      '-segment_start_number', String(n), '-reset_timestamps', '0', path.join(s.dir, 'seg_%05d.ts')];
  } else {
    // Omkodning: segment-muxern delar exakt på de tvingade nyckelbilderna (extra nyckelbilder från kodaren,
    // t.ex. vid scenbyten i hårdvarukodare, ger inga extra segment – listan förblir deterministisk)
    const va = videoArgs(it, d, n === 0);
    const times = segs.slice(n + 1).map(x => Math.max(0.001, x.start - t - 0.005).toFixed(3));
    args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...va.pre, ...hwDecode(), ...SAFE_IN, ...(n > 0 ? ['-ss', String(t)] : []), '-i', it.path,
      ...va.filter, ...va.map, ...audioArgs(d), ...va.enc, '-sn', '-dn',
      // avoid_negative_ts: B-bilder ger negativ DTS i början; utan detta förskjuts hela körningen ~0,08 s
      // och segmenten från en omstart (spolning) skulle inte passa ihop med de första. (Segment 0 börjar ändå
      // ~0,08 s sent – TS-muxern inuti skjuter fram det – ett överlapp som spelarna hanterar.)
      '-output_ts_offset', String(t), '-muxdelay', '0', '-muxpreload', '0', '-avoid_negative_ts', 'disabled',
      '-f', 'segment', '-segment_format', 'mpegts', ...(times.length ? ['-segment_times', times.join(',')] : ['-segment_time', '999999']),
      '-segment_start_number', String(n), '-reset_timestamps', '0', path.join(s.dir, 'seg_%05d.ts')];
  }
  if (d.fmt === 'ts') {
    // gamla filer framåt kan komma från en annan körning – skapa om dem för entydig klarsignal
    for (const f of fs.readdirSync(s.dir)) { const m = /^seg_(\d+)\.ts$/.exec(f); if (m && +m[1] >= n) fs.rmSync(path.join(s.dir, f), { force: true }); }
  }
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.on('error', (e) => {
    // ffmpeg saknas eller kunde inte startas – väntande förfrågningar ser !s.proc och svarar med fel
    console.warn(`[hls:${d.mode}] kunde inte starta ffmpeg:`, e.message);
    if (s.proc === p) { s.proc = null; s.done = false; }
  });
  p.stderr?.on('data', c => { err = (err + c).slice(-3000); });
  p.on('exit', (code, sig) => {
    if (s.proc === p) {
      if (code !== 0 && d.fmt === 'ts') { const hi = highestFile(s); if (hi >= 0) fs.rmSync(segFile(s, hi), { force: true }); }
      s.proc = null; s.done = code === 0;
    }
    if (code && !sig) console.warn(`[hls:${d.mode}] ffmpeg avslutades`, code, err.trim());
    // Hårdvaran fungerar inte: nästa start (spelaren väntar och servern försöker igen) använder processorn
    if (code && !sig && d.mode === 'transcode' && HW !== 'none' && HW_FAIL.test(err)) disableHw(err);
  });
  s.proc = p; s.paused = false; s.start = n; s.done = false; s.total = segs.length;
  if ((s.trimmed ?? -1) >= n) s.trimmed = n - 1; // spolat bakåt: segmenten därifrån skapas på nytt
}

// ffmpeg som ligger långt före uppspelningen pausas (SIGSTOP), annars kopieras en hel 4K-remux
// till disk på några minuter. Den återupptas när spelaren närmar sig eller ber om något som saknas.
const AHEAD = 40;
function resume(s) { if (s.paused && s.proc) s.proc.kill('SIGCONT'); s.paused = false; }
// Segment långt bakom uppspelningen tas bort – annars hamnar en hel film i omkodningsmappen
// (ofta /tmp = RAM i Unraid). Spolar man tillbaka skapas de igen.
const BEHIND = 30;
function trimBehind(s, n) {
  const upto = n - BEHIND;
  if (upto <= (s.trimmed ?? -1)) return;
  for (let k = Math.max(0, (s.trimmed ?? -1) + 1); k <= upto; k++) fs.rmSync(segFile(s, k), { force: true });
  s.trimmed = upto;
}
function throttle(s, n) {
  trimBehind(s, n);
  if (!s.proc) return;
  const ahead = highestFile(s) - n;
  if (!s.paused && ahead > AHEAD) { s.proc.kill('SIGSTOP'); s.paused = true; }
  else if (s.paused && ahead < AHEAD / 2) resume(s);
}
function stopProc(s) {
  s.paused = false;
  if (!s.proc) return;
  s.proc.kill('SIGKILL'); s.proc = null;
  // segment-muxern skriver direkt till slutligt filnamn – radera det senaste (ev. halvfärdiga) segmentet
  if (s.d.fmt === 'ts') { const hi = highestFile(s); if (hi >= 0) fs.rmSync(segFile(s, hi), { force: true }); }
}
// Högsta sammanhängande segmentet från s.start. Senaste kända värdet sparas så att varje anrop
// bara behöver kontrollera några få filer i stället för alla segment sedan start.
function highestFile(s) {
  // Segment bakom uppspelningen kan redan vara borttagna (trimBehind) – räkna från det första som finns kvar
  const from = Math.max(s.start, (s.trimmed ?? -1) + 1);
  let k = from;
  if (s.hi != null && s.hi >= from && fs.existsSync(segFile(s, s.hi))) k = s.hi;
  while (k >= 0 && fs.existsSync(segFile(s, k))) k++;
  s.hi = k - 1 >= from ? k - 1 : null;
  return k > from ? k - 1 : Math.max(from - 1, s.start - 1);
}
// Ett segment är klart när filen finns och (remux) ffmpeg gått vidare till nästa fil eller slutat.
// Halvfärdiga filer raderas alltid när en remux-process stoppas eller kraschar.
function complete(s, n) {
  if (!fs.existsSync(segFile(s, n))) return false;
  // HLS-muxern (fMP4) skriver till temporärt namn och byter namn när segmentet är klart; segment-muxern (TS) skriver direkt
  return s.d.fmt === 'fmp4' || !s.proc || n < s.start || fs.existsSync(segFile(s, n + 1));
}

// Gränser för samtidiga omkodningar (skydd mot överbelastning)
export function limits() {
  return { global: +getSetting('max_transcodes', process.env.MAX_TRANSCODES || 4), user: +getSetting('max_transcodes_user', process.env.MAX_TRANSCODES_USER || 2) };
}
function ensureCapacity(s, userId) {
  if (s.d.mode !== 'transcode') {
    // Remux kostar lite CPU men läser disk – begränsa ändå (4 per användare, 16 totalt)
    const rem = [...sessions.values()].filter(x => x !== s && x.proc && x.d.mode === 'remux');
    const mineR = rem.filter(x => x.key.startsWith(userId + '-')).sort((a, b) => a.last - b.last);
    while (mineR.length >= 4) stopProc(mineR.shift());
    return [...sessions.values()].filter(x => x !== s && x.proc && x.d.mode === 'remux').length < 16;
  }
  const lim = limits();
  // ABR: spelaren har bytt kvalitetssteg i samma uppspelning (samma pid) – det gamla steget behövs inte längre.
  // Steg som någon fortfarande väntar på lämnas kvar (annars kan två steg turas om att stoppa varandra).
  for (const x of sessions.values()) {
    if (x !== s && x.proc && x.d.mode === 'transcode' && s.d.pid && x.d.pid === s.d.pid && x.user === s.user && x.item === s.item && !x.waiting) stopProc(x);
  }
  const active = [...sessions.values()].filter(x => x !== s && x.proc && x.d.mode === 'transcode');
  // Användarens äldsta omkodningar stoppas först (t.ex. vid byte av kvalitet eller enhet)
  const mine = active.filter(x => x.key.startsWith(userId + '-')).sort((a, b) => a.last - b.last);
  while (mine.length >= lim.user) stopProc(mine.shift());
  return [...sessions.values()].filter(x => x !== s && x.proc && x.d.mode === 'transcode').length < lim.global;
}

function sessionFor(it, query, userId) {
  const d = normParams(readParams(query));
  if (d.mode === 'remux' && !remuxBounds(it, d.fmt)) { d.mode = 'transcode'; normParams(d); }
  const key = `${userId}-${it.id}-${d.mode}-${d.fmt}-${d.tag}-${d.q}-${d.audio}-${d.audioMode}-${d.burn}-${d.tonemap ? 1 : 0}${d.pid ? '-' + d.pid : ''}`;
  let s = sessions.get(key);
  if (!s) {
    s = { key, d, dir: path.join(TRANSCODE, key), proc: null, start: -1, done: false, total: 0, last: Date.now(), user: userId, item: it.id, waiting: 0,
      created: Date.now(), title: it.title, slowLogged: false, firstLogged: false };
    fs.mkdirSync(s.dir, { recursive: true });
    sessions.set(key, s);
  }
  s.last = Date.now();
  return s;
}

/** Startar ffmpeg direkt när uppspelningen begärs, så att första segmentet är på väg medan spelaren
 *  hämtar spellistorna (sparar några rundresor innan bilden kommer). */
export function prewarm(it, query, userId, start = 0) {
  try {
    const s = sessionFor(it, query, userId);
    if (s.proc || !it.duration) return;
    const segs = segmentsOf(it, s.d);
    let n = 0;
    while (n + 1 < segs.length && segs[n + 1].start <= start) n++;
    if (ensureCapacity(s, userId)) startFfmpeg(s, it, n);
  } catch (e) { console.warn('[hls] förstart:', e.message); }
}

// fMP4-initsegment (moov). Identiskt för alla körningar i samma session.
export async function serveInit(req, res, it, query, userId) {
  const s = sessionFor(it, query, userId);
  if (s.d.fmt !== 'fmp4') return fail(res, 404, 'Inget initsegment');
  const t0 = Date.now();
  // Initfilen är färdigskriven när första mediasegmentet finns
  const ready = () => { const f = initFile(s); return f && fs.statSync(f).size > 0 && fs.readdirSync(s.dir).some(x => /^seg_\d+\.m4s$/.test(x)); };
  let starts = 0;
  resume(s);
  while (!ready()) {
    if (!s.proc) {
      // ffmpeg som dör direkt (trasig fil) ska inte startas om var 100:e ms
      if (++starts > 3) return fail(res, 500, 'ffmpeg misslyckades – se serverloggen');
      if (!ensureCapacity(s, userId)) return fail(res, 503, 'För många samtidiga strömmar');
      startFfmpeg(s, it, 0);
    }
    if (Date.now() - t0 > 30000 || req.destroyed) return fail(res, 504, 'Initsegmentet blev inte klart');
    s.last = Date.now();
    await new Promise(r => setTimeout(r, 100));
  }
  sendSegment(req, res, initFile(s), 'video/mp4');
}

export async function serveSegment(req, res, it, n, query, userId) {
  const s = sessionFor(it, query, userId);
  const d = s.d;
  const total = segmentsOf(it, d).length;
  s.total = total;
  if (!(Number.isInteger(n) && n >= 0 && n < total)) return fail(res, 404, 'Segment finns inte');
  if (!complete(s, n)) {
    s.waiting++;
    const w0 = Date.now();
    try { const r = await awaitSegment(req, res, it, s, n, userId); if (r !== true) return; }
    finally { s.waiting--; }
    // Diagnos: spelaren fick vänta på ett segment mitt i uppspelningen = servern hinner inte med
    const waited = (Date.now() - w0) / 1000;
    if (s.firstLogged && waited > 4 && !s.slowLogged) {
      s.slowLogged = true;
      console.warn(`[hls] ${s.title}: väntade ${waited.toFixed(1)} s på segment ${n} (${d.mode}) – ${d.mode === 'transcode' ? `omkodningen (${HW === 'none' ? 'processor' : HW}) är långsammare än uppspelningen` : 'disken eller nätverket hinner inte med'}`);
    }
  }
  if (!s.firstLogged) {
    s.firstLogged = true;
    console.log(`[hls] ${s.title}: första segmentet klart ${((Date.now() - s.created) / 1000).toFixed(1)} s efter start (${d.mode}${d.mode === 'transcode' ? ', ' + (HW === 'none' ? 'processor' : HW) : ''})`);
  }
  throttle(s, n);
  sendSegment(req, res, segFile(s, n), d.fmt === 'fmp4' ? 'video/iso.segment' : 'video/mp2t');
}
/** Väntar tills segment n är klart (startar ffmpeg vid behov). Allt annat än true = ett felsvar har skickats. */
async function awaitSegment(req, res, it, s, n, userId) {
  {
    resume(s);
    const hi = s.proc ? highestFile(s) : -1;
    const covered = s.proc && n >= s.start && n <= Math.max(hi, s.start) + 4;
    let starts = 0;
    if (!covered) {
      if (!ensureCapacity(s, userId)) return fail(res, 503, 'Servern har för många samtidiga omkodningar just nu – försök igen strax eller välj Original');
      startFfmpeg(s, it, n); starts++;
    }
    const t0 = Date.now();
    while (!complete(s, n)) {
      if (Date.now() - t0 > 90000 || req.destroyed) return fail(res, 504, 'Omkodningen hann inte med');
      // Långsam omkodning (4K-tonmappning): städningen får inte döda ffmpeg medan någon väntar
      s.last = Date.now();
      if (!s.proc && !complete(s, n)) {
        if (++starts > 3) return fail(res, 500, 'ffmpeg misslyckades – se serverloggen');
        if (!ensureCapacity(s, userId)) return fail(res, 503, 'Servern har för många samtidiga omkodningar just nu');
        startFfmpeg(s, it, n);
      }
      await new Promise(r => setTimeout(r, 120));
    }
  }
  return true;
}
function sendSegment(req, res, file, type) {
  let st; try { st = fs.statSync(file); } catch { return fail(res, 404, 'Segmentet försvann – försök igen'); }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD' || !st.size) return res.end();
  pipeline(fs.createReadStream(file), res, () => {});
}

// Städa: döda inaktiva ffmpeg efter 60 s, radera cache efter 15 min
setInterval(() => {
  for (const [k, s] of sessions) {
    const idle = Date.now() - s.last;
    if (idle > 60000 && s.proc) stopProc(s);
    if (idle > 900000) { fs.rmSync(s.dir, { recursive: true, force: true }); sessions.delete(k); }
  }
}, 15000).unref();

export function stopUserSessions(itemId, userId) {
  for (const [, s] of sessions) if (s.key.startsWith(`${userId}-${itemId}-`)) stopProc(s);
}
export const activeTranscodes = () => [...sessions.values()].filter(s => s.proc).map(s => s.d.mode);
// Diskövervakning: antal HLS-sessioner och rensning av inaktiva när omkodningsdisken är nästan full
export const sessionCount = () => sessions.size;
export function purgeIdle(idleMs) {
  let n = 0;
  for (const [k, s] of sessions) {
    if (Date.now() - s.last <= idleMs) continue;
    stopProc(s); fs.rmSync(s.dir, { recursive: true, force: true }); sessions.delete(k); n++;
  }
  return n;
}
export const hwMode = HW;

/** Kodare för live-TV och efterbearbetning av inspelningar (avflätning + valfri skalning, hårdvara om möjligt) */
export function liveEncoder({ deinterlace = true, maxHeight = null, bitrate = null } = {}) {
  const sw = [];
  if (deinterlace) sw.push('yadif=mode=0:deint=interlaced');
  if (maxHeight) sw.push(`scale=-2:'min(${maxHeight},ih)'`);
  const rate = (fallback) => bitrate ? ['-b:v', bitrate + 'k', '-maxrate', bitrate + 'k', '-bufsize', bitrate * 2 + 'k'] : fallback;
  let post, enc;
  if (HW === 'vaapi') { post = ['format=nv12', 'hwupload']; enc = ['-c:v', 'h264_vaapi', ...rate(['-qp', '23'])]; }
  else if (HW === 'nvenc') { post = ['format=yuv420p']; enc = ['-c:v', 'h264_nvenc', '-preset', 'p4', ...rate(['-cq', '23'])]; }
  else if (HW === 'qsv') { post = ['format=nv12']; enc = ['-c:v', 'h264_qsv', ...rate(['-global_quality', '23'])]; }
  else { post = ['format=yuv420p']; enc = ['-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast', ...rate(['-crf', '22']), '-profile:v', 'high']; }
  return { pre: HW === 'vaapi' ? ['-vaapi_device', VAAPI_DEV] : [], vf: ['-vf', [...sw, ...post].join(',')], enc };
}

// För tester
export const _segs = { trimBehind, highestFile };
