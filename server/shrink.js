// Diskrådgivaren: var tar platsen vägen, vad ses aldrig, vilka versioner är överflödiga och hur mycket ger en omkodning
// till HEVC/AV1 – och, om administratören startar det, omkodningen själv i bakgrunden med kvalitetskontroll.
//
// Analysen (report) läser bara databasen: storlek per bibliotek, serie, upplösning och codec, MB per minut, när någon i
// hushållet senast såg titeln (progress + plays), intresse (Min lista, följda serier, påbörjad), versioner av samma film
// och uppskattad vinst per titel. Uppskattningen = videons bithastighet (filens minus en gissning för ljudspåren) ×
// codecfaktorn (RATIO) × kalibreringen, aldrig under ett golv per upplösning (FLOOR). Kalibreringen (calibrate) kodar
// ett kort prov med den kodare som skulle användas och jämför med modellen – faktorn sparas per codec.
//
// Omkodningen (av som standard: inget händer förrän administratören köar en titel eller en regel):
//   kodare   grafikkortets (stream.js vEnc.hw, provkört vid start) – processorns (x265/SVT-AV1) bara om allowCpu
//   när      en fil åt gången, lägsta prioritet (nice/ionice), bara inom tidsfönstret och när ingen tittar eller
//            kodas om (annars SIGSTOP på ffmpeg tills det är fritt igen), pausbar
//   vad      alla ljud-, undertext- och bilagespår kopieras orörda i samma ordning (dataspår utelämnas), kapitel och
//            metadata följer med; bilden kodas om med samma bitdjup och färgtaggar. HDR, Dolby Vision och flätad bild
//            hoppas över (metadata som inte kan bevaras säkert)
//   kontroll ffprobe av resultatet (spår, längd, codec) och stickprov mot originalet: VMAF om ffmpeg har libvmaf,
//            annars SSIM och PSNR. Under tröskeln → originalet behålls och titeln markeras (status rejected)
//   byte     skrivs bredvid originalet (dold .tmp-fil, samma filsystem), originalet flyttas till papperskorgen
//            (<biblioteksmapp>/.braxhn-papperskorg eller SHRINK_TRASH_DIR, filändelsen .original så att ingen skanner
//            läser den), den nya filen byter namn till originalets plats. Raden i items uppdateras i samma synkrona
//            steg (sökväg, storlek, mtime, spår) – skannern känner igen filen och id, framsteg, betyg och metadata består
//   papperskorg rensas efter trashDays dagar (inte direkt), kan återställas eller tömmas per titel
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { all, get, run, tx, now, getSetting, setSetting } from './db.js';
import { ffcaps, ffReady } from './ffcaps.js';
import { vEnc, hwStatus, SAFE_IN, activeTranscodes } from './stream.js';
import { probe as scanProbe, status as scanStatus } from './scanner.js';
import { listActive } from './activity.js';
import { lowPriority } from './util.js';
import { librariesWithRoots, rootOf } from './libpaths.js';
import * as jobs from './jobs.js';

export const CODECS = ['hevc', 'av1'];
const CPU_ENC = { hevc: 'libx265', av1: 'libsvtav1' };
const VAAPI_DEV = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
const TRASH_NAME = '.braxhn-papperskorg';
const GB = 1e9;

// ---------------- inställningar ----------------
const DEFAULTS = { codec: 'hevc', allowCpu: false, window: process.env.SHRINK_WINDOW ?? '01:00-07:00', onlyIdle: true, paused: false,
  quality: 'balanced', minVmaf: 90, minSsim: 0.97, minPsnr: 35, samples: 3, trashDays: +(process.env.SHRINK_TRASH_DAYS || 14), notSeenDays: 365 };
const WIN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
export function settings() {
  let s = {}; try { s = JSON.parse(getSetting('shrink', '{}')) || {}; } catch {}
  return { ...DEFAULTS, ...s };
}
/** Validerar och sparar (bara kända fält). Kastar Error med ett svenskt meddelande vid fel värde. */
export function saveSettings(b) {
  const s = settings(), out = { ...s };
  const num = (k, lo, hi, label) => { if (b[k] === undefined) return; const n = +b[k]; if (!(n >= lo && n <= hi)) throw new Error(`${label}: ${lo}–${hi}`); out[k] = n; };
  if (b.codec !== undefined) { if (!CODECS.includes(b.codec)) throw new Error('Codec: hevc eller av1'); out.codec = b.codec; }
  if (b.window !== undefined) { const w = String(b.window || '').trim(); if (w && !WIN.test(w)) throw new Error('Tidsfönster: HH:MM-HH:MM eller tomt (alltid)'); out.window = w; }
  if (b.quality !== undefined) { if (!['high', 'balanced', 'small'].includes(b.quality)) throw new Error('Kvalitet: high, balanced eller small'); out.quality = b.quality; }
  for (const k of ['allowCpu', 'onlyIdle', 'paused']) if (b[k] !== undefined) out[k] = !!b[k];
  num('minVmaf', 50, 100, 'Lägsta VMAF'); num('minSsim', 0.5, 1, 'Lägsta SSIM'); num('minPsnr', 20, 100, 'Lägsta PSNR (dB)');
  num('samples', 1, 10, 'Stickprov'); num('trashDays', 1, 365, 'Dagar i papperskorgen'); num('notSeenDays', 30, 3650, 'Inte sedd på (dagar)');
  out.samples = Math.round(out.samples); out.trashDays = Math.round(out.trashDays); out.notSeenDays = Math.round(out.notSeenDays);
  setSetting('shrink', JSON.stringify(out));
  kick(500);
  return out;
}
/** Är klockan (lokal tid) inom fönstret "HH:MM-HH:MM"? Tomt = alltid. Fönster över midnatt fungerar (23:00-06:00). */
export function inWindow(win, d = new Date()) {
  const m = WIN.exec(String(win || ''));
  if (!m) return true;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4], t = d.getHours() * 60 + d.getMinutes();
  return a === b ? true : a < b ? t >= a && t < b : t >= a || t < b;
}

// ---------------- kodare ----------------
/** Kodaren som en ny omkodning använder: { kind: nvenc|vaapi|qsv|none, name } eller null (med reason) */
export function encoderFor(codec, s = settings()) {
  const hw = hwStatus.active !== 'none' && vEnc.hw[codec] && !vEnc.failed.has(vEnc.hw[codec]) ? vEnc.hw[codec] : null;
  if (hw) return { kind: hwStatus.active, name: hw };
  if (!s.allowCpu) return null;
  const cpu = vEnc.cpu[codec] || (ffcaps.encoders.has(CPU_ENC[codec]) ? CPU_ENC[codec] : null);
  return cpu ? { kind: 'none', name: cpu } : null;
}
export function encoderInfo(s = settings()) {
  const o = {};
  for (const c of CODECS) {
    const e = encoderFor(c, s);
    o[c] = { use: e?.name || null, hw: hwStatus.active !== 'none' ? vEnc.hw[c] || null : null,
      cpu: vEnc.cpu[c] || (ffcaps.encoders.has(CPU_ENC[c]) ? CPU_ENC[c] : null) };
  }
  return o;
}
export const metricName = () => ffcaps.filters.has('libvmaf') ? 'vmaf' : 'ssim';

const Q_OFF = { high: -2, balanced: 0, small: 3 };
/** Kodarens argument för utdataström idx (kvalitetsstyrd, för arkivering – inte strömningens bithastighetstak) */
export function encoderArgs(enc, codec, idx, { tenBit = false, quality = 'balanced' } = {}) {
  const o = Q_OFF[quality] ?? 0, k = enc.kind, x = String(idx);
  const fmt = (sw) => ['-filter:' + x, sw];
  if (k === 'nvenc') return [...fmt(tenBit ? 'format=p010le' : 'format=yuv420p'), '-c:' + x, enc.name, '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr',
    '-cq', String((codec === 'av1' ? 32 : 25) + o), '-b:v', '0', '-spatial-aq', '1'];
  if (k === 'vaapi') return [...fmt(tenBit ? 'format=p010,hwupload' : 'format=nv12,hwupload'), '-c:' + x, enc.name, '-rc_mode', 'CQP',
    '-qp', String(codec === 'av1' ? 120 + o * 4 : 24 + o)];
  if (k === 'qsv') return [...fmt(tenBit ? 'format=p010le' : 'format=nv12'), '-c:' + x, enc.name, '-preset', 'slow', '-global_quality', String((codec === 'av1' ? 30 : 24) + o)];
  const pix = fmt(tenBit ? 'format=yuv420p10le' : 'format=yuv420p');
  if (enc.name === 'libx265') return [...pix, '-c:' + x, 'libx265', '-preset', process.env.SHRINK_X265_PRESET || 'medium', '-crf', String(22 + o), '-x265-params', 'log-level=error'];
  return [...pix, '-c:' + x, enc.name, '-preset', process.env.SHRINK_SVTAV1_PRESET || '6', '-crf', String(30 + o)];
}
const preArgs = (enc) => enc.kind === 'vaapi' ? ['-vaapi_device', VAAPI_DEV] : [];

// ---------------- uppskattning ----------------
// Andel av videons bithastighet efter omkodning för samma upplevda kvalitet (försiktiga tumregler; kalibreras)
export const RATIO = {
  hevc: { h264: 0.55, mpeg2video: 0.35, vc1: 0.45, wmv3: 0.45, mpeg4: 0.5, msmpeg4v3: 0.5, mpeg1video: 0.35, vp8: 0.6, _: 0.55 },
  av1: { h264: 0.45, hevc: 0.8, vp9: 0.85, mpeg2video: 0.3, vc1: 0.38, wmv3: 0.38, mpeg4: 0.42, msmpeg4v3: 0.42, mpeg1video: 0.3, vp8: 0.5, _: 0.45 }
};
// Ingen vinst att hämta: redan samma eller en lika effektiv codec
const ALREADY = { hevc: new Set(['hevc', 'av1', 'vp9']), av1: new Set(['av1']) };
// Rimligt golv för videon efter omkodning (kbit/s) – under det blir det sällan bra, oavsett källa
const FLOOR = { hevc: { 2160: 9000, 1080: 2500, 720: 1400, 0: 700 }, av1: { 2160: 7000, 1080: 2000, 720: 1100, 0: 550 } };
export const resBucket = (w, h) => { const x = Math.max(+h || 0, Math.round((+w || 0) * 9 / 16)); return x >= 1600 ? 2160 : x >= 900 ? 1080 : x >= 600 ? 720 : 0; };
export const resLabel = (b) => b ? `${b}p` : 'SD';
/** Gissad bithastighet för ett ljudspår (kbit/s) – filens totala bithastighet minus ljudet ≈ videon */
export function audioKbps(s) {
  const ch = s.channels || 2, c = String(s.codec || '');
  if (c === 'truehd') return 3500;
  if (c === 'dts') return /MA|HD/i.test(s.profile || '') ? 3500 : 1509;
  if (c === 'flac' || c.startsWith('pcm_')) return ch * 600;
  if (c === 'eac3') return ch > 2 ? 768 : 224;
  if (c === 'ac3') return ch > 2 ? 640 : 192;
  if (c === 'aac') return 64 * ch;
  if (c === 'opus' || c === 'vorbis') return 48 * ch;
  if (c === 'mp3' || c === 'mp2') return 192;
  return 256;
}
let calibCache = null;
export function calibration() {
  if (calibCache) return calibCache;
  try { calibCache = JSON.parse(getSetting('shrink_calib', '{}')) || {}; } catch { calibCache = {}; }
  return calibCache;
}
/**
 * Uppskattad vinst för en titel (rad ur items, streams som JSON). → { codec, videoKbps, afterKbps, saving, after } eller
 * { codec, skip: 'orsak' }. calib = { hevc: { factor }, av1: { factor } }.
 */
export function estimate(it, codec = 'hevc', calib = calibration()) {
  const dur = +it.duration || 0, size = +it.size || 0;
  if (!dur || !size) return { codec, skip: 'okänd längd eller storlek' };
  if (!it.vcodec) return { codec, skip: 'ingen bild' };
  if (ALREADY[codec].has(it.vcodec)) return { codec, skip: it.vcodec === codec ? `redan ${codec.toUpperCase()}` : `redan ${String(it.vcodec).toUpperCase()}` };
  let streams = []; try { streams = typeof it.streams === 'string' ? JSON.parse(it.streams || '[]') : it.streams || []; } catch {}
  const total = size * 8 / dur / 1000;
  const audio = streams.filter(s => s.type === 'audio').reduce((a, s) => a + audioKbps(s), 0);
  const video = Math.max(total * 0.3, total - audio);
  const factor = Math.max(0.2, Math.min(3, +calib?.[codec]?.factor || 1));
  const floor = FLOOR[codec][resBucket(it.width, it.height)];
  const after = Math.min(video, Math.max(floor, video * (RATIO[codec][it.vcodec] ?? RATIO[codec]._) * factor));
  if (after >= video * 0.85) return { codec, skip: 'redan låg bithastighet', videoKbps: Math.round(video) };
  const saving = Math.round((video - after) * 1000 / 8 * dur);
  return { codec, videoKbps: Math.round(video), afterKbps: Math.round(after), saving, after: Math.max(0, size - saving) };
}
/** Varför en titel inte kan kodas om automatiskt (null = går) */
export function blocker(it) {
  let streams = []; try { streams = JSON.parse(it.streams || '[]'); } catch {}
  const v = streams.find(s => s.type === 'video');
  if (!v) return 'ingen bild';
  if (it.hdr === 'dovi' || v.dovi) return 'Dolby Vision bevaras inte';
  if (it.hdr) return 'HDR – metadatan bevaras inte säkert';
  if (v.field) return 'flätad bild';
  if (v.rotation) return 'roterad bild';
  return null;
}

// ---------------- analys ----------------
const ITEMS = `SELECT i.id, i.kind, i.library_id, i.parent_id, i.version_of, i.title, i.year, i.season, i.episode, i.path, i.size, i.duration,
    i.vcodec, i.width, i.height, i.hdr, i.streams, i.added, s.title AS show_title, l.name AS library
  FROM items i JOIN libraries l ON l.id=i.library_id LEFT JOIN items s ON s.id=i.parent_id
  WHERE i.kind IN ('movie','episode') AND i.path IS NOT NULL AND l.type IN ('movie','show')`;
const SORTS = { size: (r) => r.size, gain: (r) => r.estimate.saving || 0, rate: (r) => r.mbPerMin, seen: (r) => -(r.lastSeen || 0) };

/** Hela rapporten. o = { lib, sort, limit, codec, notSeenDays, at } */
export function report(o = {}) {
  const s = settings(), at = o.at || now(), codec = CODECS.includes(o.codec) ? o.codec : s.codec;
  const notSeen = Math.max(1, +o.notSeenDays || s.notSeenDays), cut = at - notSeen * 86400;
  const calib = calibration();
  const seen = new Map();
  const bump = (id, t) => { if (t && (seen.get(id) || 0) < t) seen.set(id, t); };
  for (const r of all('SELECT item_id, MAX(updated) AS t FROM progress WHERE position > 0 OR watched=1 GROUP BY item_id')) bump(r.item_id, r.t);
  for (const r of all('SELECT item_id, MAX(ts) AS t FROM plays GROUP BY item_id')) bump(r.item_id, r.t);
  const listed = new Set(all('SELECT DISTINCT item_id FROM watchlist').map(r => r.item_id));
  const started = new Set(all('SELECT DISTINCT item_id FROM progress WHERE position > 0 AND watched=0').map(r => r.item_id));
  let followed = new Set(); try { followed = new Set(all('SELECT DISTINCT show_id FROM follows WHERE active=1').map(r => r.show_id)); } catch {}
  const jobOf = new Map(all(`SELECT j.* FROM shrink_jobs j JOIN (SELECT item_id, MAX(id) AS id FROM shrink_jobs WHERE item_id IS NOT NULL GROUP BY item_id) m ON m.id=j.id`).map(j => [j.item_id, j]));
  const rows = all(ITEMS);
  const by = { library: new Map(), show: new Map(), res: new Map(), codec: new Map() };
  const add = (m, key, label, r, extra = {}) => {
    let g = m.get(key); if (!g) m.set(key, g = { key, label, bytes: 0, count: 0, minutes: 0, saving: 0, ...extra });
    g.bytes += r.size; g.count++; g.minutes += r.minutes; g.saving += r.estimate.saving || 0;
    if (r.lastSeen && (!g.lastSeen || g.lastSeen < r.lastSeen)) g.lastSeen = r.lastSeen;
    return g;
  };
  const totals = { bytes: 0, count: 0, saving: 0, never: { bytes: 0, count: 0 }, stale: { bytes: 0, count: 0, days: notSeen }, wanted: { bytes: 0, count: 0 } };
  const list = [];
  for (const it of rows) {
    const main = it.version_of || it.id;
    const lastSeen = Math.max(seen.get(it.id) || 0, seen.get(main) || 0) || null;
    const wanted = [];
    if (listed.has(main) || (it.parent_id && listed.has(it.parent_id))) wanted.push('Min lista');
    if (it.parent_id && followed.has(it.parent_id)) wanted.push('följd serie');
    if (started.has(main)) wanted.push('påbörjad');
    const size = +it.size || 0, minutes = (+it.duration || 0) / 60;
    const res = resBucket(it.width, it.height);
    const block = blocker(it);
    const est = block ? { codec, skip: block } : estimate(it, codec, calib);
    const j = jobOf.get(it.id);
    const r = { id: it.id, main, kind: it.kind, title: it.title, year: it.year, show: it.show_title, showId: it.parent_id, season: it.season, episode: it.episode,
      library: it.library, libraryId: it.library_id, file: path.basename(it.path), size, minutes: Math.round(minutes), mbPerMin: minutes ? Math.round(size / 1e6 / minutes * 10) / 10 : 0,
      res: resLabel(res), vcodec: it.vcodec, hdr: it.hdr, lastSeen, never: !lastSeen, wanted, estimate: est,
      job: j ? { id: j.id, status: j.status, metric: j.metric, score: j.score, error: j.error, saved: j.status === 'done' ? (j.src_size || 0) - (j.out_size || 0) : null } : null };
    list.push(r);
    totals.bytes += size; totals.count++; totals.saving += est.saving || 0;
    if (!lastSeen) { totals.never.bytes += size; totals.never.count++; }
    else if (lastSeen < cut) { totals.stale.bytes += size; totals.stale.count++; }
    if (wanted.length) { totals.wanted.bytes += size; totals.wanted.count++; }
    add(by.library, it.library_id, it.library, r);
    if (it.kind === 'episode' && it.parent_id) add(by.show, it.parent_id, it.show_title || '?', r, { id: it.parent_id, wanted: followed.has(it.parent_id) || listed.has(it.parent_id) });
    add(by.res, resLabel(res), resLabel(res), r);
    add(by.codec, it.vcodec || '?', String(it.vcodec || '?').toUpperCase(), r);
  }
  // Versioner: samma film i flera filer. Den största upplösningen behålls; mindre versioner är förslag att ta bort.
  const groups = new Map();
  for (const r of list) if (r.kind === 'movie') { if (!groups.has(r.main)) groups.set(r.main, []); groups.get(r.main).push(r); }
  const versions = [];
  for (const [main, g] of groups) {
    if (g.length < 2) continue;
    const best = Math.max(...g.map(x => parseInt(x.res) || 0));
    const extra = g.filter(x => (parseInt(x.res) || 0) < best);
    versions.push({ main, title: g[0].title, year: g[0].year, files: g.map(x => ({ id: x.id, file: x.file, res: x.res, vcodec: x.vcodec, size: x.size })),
      reclaim: extra.reduce((a, x) => a + x.size, 0), extra: extra.map(x => x.id) });
  }
  versions.sort((a, b) => b.reclaim - a.reclaim);
  const sorted = (m) => [...m.values()].sort((a, b) => b.bytes - a.bytes).map(g => ({ ...g, minutes: Math.round(g.minutes), mbPerMin: g.minutes ? Math.round(g.bytes / 1e6 / g.minutes * 10) / 10 : 0 }));
  const lib = o.lib ? +o.lib : null;
  const pick = list.filter(r => !lib || r.libraryId === lib);
  const key = SORTS[o.sort] || SORTS.size;
  pick.sort((a, b) => key(b) - key(a) || b.size - a.size);
  const limit = Math.max(1, Math.min(2000, +o.limit || 300));
  return { at, codec, notSeenDays: notSeen, totals, libraries: sorted(by.library), shows: sorted(by.show).slice(0, 100), resolutions: sorted(by.res), codecs: sorted(by.codec),
    versions: versions.slice(0, 200), titles: pick.slice(0, limit), more: Math.max(0, pick.length - limit), calibration: calib };
}

// ---------------- ffmpeg-hjälp ----------------
const ffprobeJson = (file) => new Promise((ok, bad) => execFile('ffprobe', ['-v', 'error', ...SAFE_IN, '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file],
  { maxBuffer: 32 << 20, timeout: 120000 }, (e, out) => { if (e) return bad(new Error('ffprobe: ' + String(e.message).split('\n')[0])); try { ok(JSON.parse(out)); } catch (x) { bad(x); } }));
const isPic = (s) => s.codec_type === 'video' && (s.disposition?.attached_pic || ['mjpeg', 'png', 'bmp'].includes(s.codec_name));
const mainVideo = (j) => (j.streams || []).find(s => s.codec_type === 'video' && !isPic(s));
const tenBitOf = (v) => /1[02]le|1[02]be|p010|p012/.test(String(v?.pix_fmt || ''));
// ffmpeg lägger filens starttid till -ss: bildens första ruta ligger (bildens start − filens start) efter -ss 0
const startOf = (v, j) => (parseFloat(v?.start_time) || 0) - (parseFloat(j?.format?.start_time) || 0);

function ffmpeg(args, { onProgress, onSpawn, low = true } = {}) {
  return new Promise((ok, bad) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (low) lowPriority(p);
    onSpawn?.(p);
    let err = '', buf = '';
    p.stderr.on('data', d => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    p.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = /^out_time_us=(\d+)/.exec(l); if (m && onProgress) onProgress(+m[1] / 1e6); }
    });
    p.on('error', bad);
    p.on('close', (code, sig) => code === 0 ? ok(err) : bad(Object.assign(new Error(sig ? `avbruten (${sig})` : lastLines(err) || `ffmpeg slutade med ${code}`), { signal: sig })));
  });
}
const lastLines = (s) => String(s || '').trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);

/** Kvalitet på ett stickprov: { vmaf } eller { ssim, psnr } */
async function sampleScore(ref, dist, t, secs, { refStart, distStart, w, h, metric }) {
  const lav = metric === 'vmaf'
    ? `[1:v:0]scale=${w}:${h}:flags=bicubic,format=yuv420p,setpts=PTS-STARTPTS[d];[0:v:0]format=yuv420p,setpts=PTS-STARTPTS[r];[d][r]libvmaf=n_threads=4`
    : `[1:v:0]scale=${w}:${h}:flags=bicubic,format=yuv420p,setpts=PTS-STARTPTS,split[d1][d2];[0:v:0]format=yuv420p,setpts=PTS-STARTPTS,split[r1][r2];[d1][r1]ssim;[d2][r2]psnr`;
  // Varje fil söks till t + sin egen starttid (B-bilder ger olika starttider – annars jämförs bilder som är en ruta isär)
  const out = await ffmpeg(['-nostats', '-loglevel', 'info', ...SAFE_IN, '-ss', Math.max(0, t + refStart - 0.001).toFixed(3), '-t', String(secs), '-i', ref,
    ...SAFE_IN, '-ss', Math.max(0, t + distStart - 0.001).toFixed(3), '-t', String(secs), '-i', dist, '-filter_complex', lav, '-an', '-sn', '-f', 'null', '-']);
  if (metric === 'vmaf') { const m = /VMAF score[:=\s]+([\d.]+)/i.exec(out); if (!m) throw new Error('VMAF gav inget värde'); return { vmaf: +m[1] }; }
  const ss = /SSIM .*All:([\d.]+)/.exec(out), ps = /PSNR .*average:([\d.]+|inf)/.exec(out);
  if (!ss || !ps) throw new Error('SSIM/PSNR gav inget värde');
  return { ssim: +ss[1], psnr: ps[1] === 'inf' ? 100 : +ps[1] };
}
/**
 * Jämför kandidaten med originalet på stickprov jämnt fördelade över filmen. → { ok, metric, score, threshold, samples }
 * score = sämsta stickprovet (VMAF, eller SSIM med PSNR som andra villkor). opts: { samples, seconds, minVmaf, minSsim, minPsnr, metric }
 */
export async function qualityCheck(ref, dist, opts = {}) {
  const s = { ...settings(), ...opts };
  const [a, b] = await Promise.all([ffprobeJson(ref), ffprobeJson(dist)]);
  const va = mainVideo(a), vb = mainVideo(b);
  if (!va || !vb) throw new Error('bilden saknas');
  const dur = Math.min(parseFloat(a.format?.duration) || 0, parseFloat(b.format?.duration) || 0);
  const metric = opts.metric || metricName();
  const n = Math.max(1, Math.min(10, +s.samples || 3)), secs = Math.max(1, Math.min(opts.seconds || 4, dur / 2 || 1));
  const samples = [];
  for (let k = 0; k < n; k++) {
    const t = Math.max(0, Math.min(dur - secs - 0.1, dur * (k + 1) / (n + 1) - secs / 2));
    samples.push({ t: Math.round(t * 10) / 10, ...await sampleScore(ref, dist, t, secs, { refStart: startOf(va, a), distStart: startOf(vb, b), w: va.width, h: va.height, metric }) });
  }
  if (metric === 'vmaf') {
    const score = Math.min(...samples.map(x => x.vmaf));
    return { ok: score >= s.minVmaf, metric, score: Math.round(score * 100) / 100, threshold: s.minVmaf, samples };
  }
  const ssim = Math.min(...samples.map(x => x.ssim)), psnr = Math.min(...samples.map(x => x.psnr));
  return { ok: ssim >= s.minSsim && psnr >= s.minPsnr, metric: 'ssim', score: Math.round(ssim * 10000) / 10000, psnr: Math.round(psnr * 100) / 100,
    threshold: s.minSsim, minPsnr: s.minPsnr, samples };
}

// ---------------- kalibrering ----------------
/** Provkodar ~20 s mitt i titeln och jämför med modellen. Sparar faktorn per codec. → { codec, encoder, measured, model, factor } */
export async function calibrate(itemId, codec = settings().codec) {
  const it = get('SELECT * FROM items WHERE id=?', +itemId);
  if (!it?.path) throw new Error('Titeln finns inte');
  const enc = encoderFor(codec);
  if (!enc) throw new Error(noEncoderMsg(codec));
  const j = await ffprobeJson(it.path), v = mainVideo(j);
  if (!v) throw new Error('Titeln har ingen bild');
  const dur = parseFloat(j.format?.duration) || it.duration || 0;
  const secs = Math.max(2, Math.min(20, dur / 3)), t = Math.max(0, dur * 0.4 - secs / 2);
  const dir = fs.mkdtempSync(path.join(path.dirname(it.path), '.braxhn-prov-'));
  try {
    const ref = path.join(dir, 'ref.mkv'), out = path.join(dir, 'out.mkv');
    const vi = j.streams.indexOf(v);
    await ffmpeg(['-loglevel', 'error', ...SAFE_IN, '-ss', t.toFixed(2), '-t', secs.toFixed(2), '-i', it.path, '-map', `0:${vi}`, '-c', 'copy', '-f', 'matroska', '-y', ref]);
    await ffmpeg(['-loglevel', 'error', ...preArgs(enc), ...SAFE_IN, '-i', ref, '-map', '0:0', ...encoderArgs(enc, codec, 0, { tenBit: tenBitOf(v), quality: settings().quality }), '-f', 'matroska', '-y', out]);
    const measured = fs.statSync(out).size / Math.max(1, fs.statSync(ref).size);
    const model = RATIO[codec][it.vcodec] ?? RATIO[codec]._;
    const prev = calibration()[codec];
    // Medelvärde över proven (högst 10 räknas) – ett enskilt prov på en lätt scen ska inte styra allt
    const n = Math.min(9, prev?.n || 0), f1 = Math.max(0.2, Math.min(3, measured / model));
    const factor = prev?.factor ? (prev.factor * n + f1) / (n + 1) : f1;
    const c = { ...calibration(), [codec]: { factor: Math.round(factor * 1000) / 1000, n: n + 1, at: now(), encoder: enc.name, last: { item: it.id, measured: Math.round(measured * 1000) / 1000, model } } };
    setSetting('shrink_calib', JSON.stringify(c)); calibCache = c;
    return { codec, encoder: enc.name, measured: c[codec].last.measured, model, factor: c[codec].factor, seconds: Math.round(secs) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
export const noEncoderMsg = (codec) => `Ingen ${codec.toUpperCase()}-kodare på grafikkortet. Tillåt processorn (x265/SVT-AV1) i inställningarna om du vill koda med den – det tar lång tid.`;

// ---------------- kö ----------------
const ACTIVE = "status IN ('queued','running')";
/** Köa titlar. → { queued: [id], skipped: [{ id, reason }] } */
export function enqueue(ids, { codec = settings().codec, user = null, force = false } = {}) {
  if (!encoderFor(codec)) throw Object.assign(new Error(noEncoderMsg(codec)), { code: 409 });
  const queued = [], skipped = [];
  tx(() => {
    for (const id of [...new Set(ids.map(Number))].slice(0, 5000)) {
      const it = get(`SELECT i.* FROM items i JOIN libraries l ON l.id=i.library_id WHERE i.id=? AND i.kind IN ('movie','episode') AND i.path IS NOT NULL AND l.type IN ('movie','show')`, id);
      if (!it) { skipped.push({ id, reason: 'finns inte' }); continue; }
      if (get(`SELECT 1 FROM shrink_jobs WHERE item_id=? AND ${ACTIVE}`, id)) { skipped.push({ id, reason: 'redan i kön' }); continue; }
      const b = blocker(it); if (b) { skipped.push({ id, reason: b }); continue; }
      if (ALREADY[codec].has(it.vcodec)) { skipped.push({ id, reason: `redan ${String(it.vcodec).toUpperCase()}` }); continue; }
      if (!force) {
        const last = get('SELECT status FROM shrink_jobs WHERE item_id=? ORDER BY id DESC LIMIT 1', id)?.status;
        if (last === 'rejected') { skipped.push({ id, reason: 'kvaliteten räckte inte förra gången' }); continue; }
      }
      run(`INSERT INTO shrink_jobs(item_id, title, codec, status, created, src_path, src_size, created_by) VALUES(?,?,?,?,?,?,?,?)`,
        id, labelOf(it), codec, 'queued', now(), it.path, it.size, user);
      queued.push(id);
    }
  });
  if (queued.length) kick(1000);
  return { queued, skipped };
}
const labelOf = (it) => it.kind === 'episode'
  ? `${get('SELECT title FROM items WHERE id=?', it.parent_id)?.title || ''} S${String(it.season).padStart(2, '0')}E${String(it.episode).padStart(2, '0')}`.trim()
  : `${it.title}${it.year ? ` (${it.year})` : ''}`;
/** Regel: { library, codecs: ['h264',…], minMbPerMin, notSeenDays, minGainPct } → titlarna som matchar (för förhandsvisning och kö) */
export function matchRule(rule = {}, at = now()) {
  const r = report({ limit: 2000, sort: 'gain', lib: rule.library || null, at });
  const codecs = Array.isArray(rule.codecs) && rule.codecs.length ? new Set(rule.codecs.map(String)) : null;
  const cut = rule.notSeenDays ? at - rule.notSeenDays * 86400 : null;
  return r.titles.filter(t => t.estimate.saving > 0 && (!codecs || codecs.has(t.vcodec)) && (!rule.minMbPerMin || t.mbPerMin >= +rule.minMbPerMin)
    && (!cut || !t.lastSeen || t.lastSeen < cut) && (!rule.minGainPct || t.estimate.saving >= t.size * rule.minGainPct / 100)
    && !(t.job && ['queued', 'running', 'rejected', 'done'].includes(t.job.status)));
}

export function jobList(limit = 200) {
  return all('SELECT * FROM shrink_jobs ORDER BY CASE status WHEN \'running\' THEN 0 WHEN \'queued\' THEN 1 ELSE 2 END, id DESC LIMIT ?', limit).map(j => {
    let scores = null; try { scores = JSON.parse(j.scores || 'null'); } catch {}
    return { id: j.id, item: j.item_id, title: j.title, codec: j.codec, encoder: j.encoder, status: j.status, created: j.created, started: j.started, finished: j.finished,
      file: j.src_path ? path.basename(j.src_path) : null, srcSize: j.src_size, outSize: j.out_size, metric: j.metric, score: j.score, scores, error: j.error,
      trash: !!(j.trash_path && fs.existsSync(j.trash_path)), trashUntil: j.trash_until,
      progress: S.job?.id === j.id ? S.progress : null, waiting: S.job?.id === j.id ? S.waiting : null };
  });
}
export function trashInfo() {
  const r = all("SELECT trash_path FROM shrink_jobs WHERE trash_path IS NOT NULL AND status IN ('done')");
  let bytes = 0, count = 0;
  for (const x of r) { try { bytes += fs.statSync(x.trash_path).size; count++; } catch {} }
  return { bytes, count };
}

// ---------------- körning ----------------
const S = { job: null, proc: null, stopped: false, waiting: null, progress: null, cancel: null, timer: null, ticking: false };
export const state = () => ({ running: S.job ? { id: S.job.id, title: S.job.title, progress: S.progress, waiting: S.waiting } : null, waiting: S.waiting });
const sleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.());
/** Varför jobbet ska vänta just nu (null = kör) */
export function waitReason(s = settings(), d = new Date()) {
  if (s.paused) return 'pausad';
  if (!inWindow(s.window, d)) return `utanför tidsfönstret ${s.window}`;
  if (s.onlyIdle && (activeTranscodes().length > 0 || listActive().length > 0)) return 'någon tittar';
  return null;
}
function hold(reason) {
  S.waiting = reason;
  if (S.proc && !S.stopped && reason) { try { S.proc.kill('SIGSTOP'); S.stopped = true; } catch {} }
  else if (S.proc && S.stopped && !reason) { try { S.proc.kill('SIGCONT'); S.stopped = false; } catch {} }
}
/** Vänta tills det är fritt (fönster, ingen tittar, inte pausad). cancel avbryter. */
async function waitFree(jobId) {
  for (;;) {
    if (S.cancel === jobId) throw Object.assign(new Error('avbruten'), { cancelled: true });
    const r = waitReason(); hold(r);
    if (!r) return;
    await sleep(process.env.SHRINK_POLL_MS ? +process.env.SHRINK_POLL_MS : 15000);
  }
}
const setJob = (id, f) => { const k = Object.keys(f); run(`UPDATE shrink_jobs SET ${k.map(x => x + '=?').join(', ')} WHERE id=?`, ...k.map(x => f[x]), id); };

export function trashDirFor(file) {
  if (process.env.SHRINK_TRASH_DIR) return process.env.SHRINK_TRASH_DIR;
  const roots = librariesWithRoots().flatMap(l => l.roots);
  return path.join(rootOf(roots, file) || path.dirname(file), TRASH_NAME);
}
/** Flytta till papperskorgen: hård länk (originalet ligger kvar tills den nya filen tagit dess plats), annars rename,
 *  annars kopia (SHRINK_TRASH_DIR på ett annat filsystem). → 'link' | 'rename' | 'copy' */
function toTrash(file, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.linkSync(file, dest); return 'link'; } catch {}
  try { fs.renameSync(file, dest); return 'rename'; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  fs.copyFileSync(file, dest); return 'copy';
}

async function runJob(j) {
  const s = settings();
  const it = get('SELECT * FROM items WHERE id=?', j.item_id);
  if (!it?.path || !fs.existsSync(it.path)) throw new Error('filen finns inte längre');
  if (it.path !== j.src_path || it.size !== j.src_size) setJob(j.id, { src_path: it.path, src_size: it.size });
  const b = blocker(it); if (b) throw new Error(b);
  const enc = encoderFor(j.codec, s); if (!enc) throw new Error(noEncoderMsg(j.codec));
  const src = await ffprobeJson(it.path);
  const v = mainVideo(src); if (!v) throw new Error('ingen bild');
  const ext = path.extname(it.path).toLowerCase();
  const subs = src.streams.filter(x => x.codec_type === 'subtitle');
  // MP4 behålls när undertexterna går att kopiera dit (mov_text); allt annat blir MKV (klarar alla spår)
  const mp4 = ['.mp4', '.m4v', '.mov'].includes(ext) && subs.every(x => x.codec_name === 'mov_text');
  const outExt = mp4 ? ext : '.mkv';
  const final = mp4 || ext === '.mkv' ? it.path : it.path.slice(0, -ext.length) + '.mkv';
  if (final !== it.path && fs.existsSync(final)) throw new Error(`${path.basename(final)} finns redan`);
  const keep = src.streams.filter(x => x.codec_type !== 'data' && !(mp4 && x.codec_type === 'attachment') && !(!mp4 && isPic(x) && x.codec_type === 'video' && ext !== '.mkv'));
  const outIdx = keep.indexOf(v);
  // Utrymme: kandidaten skrivs bredvid originalet – kräver minst 80 % av originalets storlek + 2 GB ledigt
  try { const st = fs.statfsSync(path.dirname(it.path)); if (st.bavail * st.bsize < it.size * 0.8 + 2 * GB) throw new Error('för lite ledigt utrymme bredvid filen'); } catch (e) { if (/ledigt/.test(e.message)) throw e; }
  const tmp = path.join(path.dirname(it.path), `.${path.basename(it.path)}.krymp-${j.id}.tmp`);
  setJob(j.id, { encoder: enc.name, tmp_path: tmp });
  const dur = parseFloat(src.format?.duration) || it.duration || 0;
  const args = ['-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...preArgs(enc), ...SAFE_IN, '-i', it.path,
    ...keep.flatMap(x => ['-map', `0:${x.index}`]), '-c', 'copy', ...encoderArgs(enc, j.codec, outIdx, { tenBit: tenBitOf(v), quality: s.quality }),
    ...['color_primaries', 'color_trc', 'colorspace'].filter(k => v[k === 'colorspace' ? 'color_space' : k] && v[k === 'colorspace' ? 'color_space' : k] !== 'unknown')
      .flatMap(k => [`-${k}:${outIdx}`, v[k === 'colorspace' ? 'color_space' : k]]),
    ...(mp4 && j.codec === 'hevc' ? [`-tag:${outIdx}`, 'hvc1'] : []),
    '-map_metadata', '0', '-map_chapters', '0', '-fps_mode', 'passthrough', '-max_muxing_queue_size', '4096',
    ...(mp4 ? ['-movflags', '+faststart', '-f', 'mp4'] : ['-f', 'matroska']), '-y', tmp];
  const h = jobs.track('shrink', `Omkodning till ${j.codec.toUpperCase()}: ${j.title}`, { total: 100 });
  S.progress = 0;
  try {
    await waitFree(j.id);
    await ffmpeg(args, {
      onSpawn: (p) => { S.proc = p; S.stopped = false; },
      onProgress: (t) => { S.progress = dur ? Math.min(0.99, t / dur) : null; h.update(Math.round((S.progress || 0) * 100), 100, S.waiting || ''); }
    });
    S.proc = null;
    if (S.cancel === j.id) throw Object.assign(new Error('avbruten'), { cancelled: true });
    h.update(99, 100, 'Kontrollerar');
    // 1) Spår, längd och codec
    const out = await ffprobeJson(tmp);
    const cnt = (jj, t) => jj.streams.filter(x => x.codec_type === t).length;
    for (const t of ['audio', 'subtitle']) if (cnt(out, t) !== keep.filter(x => x.codec_type === t).length) throw new Error(`fel antal ${t === 'audio' ? 'ljudspår' : 'undertextspår'} i resultatet`);
    if ((out.chapters || []).length !== (src.chapters || []).length) throw new Error('kapitlen följde inte med');
    const ov = mainVideo(out); if (ov?.codec_name !== j.codec) throw new Error('resultatet har fel codec');
    const od = parseFloat(out.format?.duration) || 0;
    if (Math.abs(od - dur) > Math.max(1.5, dur * 0.005)) throw new Error(`fel längd (${od.toFixed(1)} s i stället för ${dur.toFixed(1)} s)`);
    // 2) Bildkvalitet mot originalet
    await waitFree(j.id);
    const q = await qualityCheck(it.path, tmp, { samples: s.samples });
    const outSize = fs.statSync(tmp).size;
    setJob(j.id, { metric: q.metric, score: q.score, scores: JSON.stringify(q), out_size: outSize });
    if (!q.ok) return { status: 'rejected', error: `kvaliteten räckte inte (${q.metric.toUpperCase()} ${q.score} < ${q.threshold}${q.psnr != null ? `, PSNR ${q.psnr} dB` : ''}) – originalet behålls` };
    if (outSize >= it.size * 0.97) return { status: 'rejected', error: 'resultatet blev inte mindre – originalet behålls' };
    // 3) Byte: vänta medan skannern arbetar (den får inte se ett halvt byte)
    while (scanStatus.running) { if (S.cancel === j.id) throw Object.assign(new Error('avbruten'), { cancelled: true }); await sleep(2000); }
    const info = await scanProbe(tmp);
    if (info.failed) throw new Error('resultatet gick inte att läsa');
    return swap(j, it, tmp, final, info, s);
  } finally { h.end(); S.proc = null; S.progress = null; }
}

/** Synkront: inget annat i servern kan köras mellan stegen (skannern, uppspelning som läser raden) */
function swap(j, it, tmp, final, info, s) {
  const cur = get('SELECT path, size, mtime FROM items WHERE id=?', it.id);
  if (!cur || cur.path !== it.path || cur.size !== it.size || cur.mtime !== it.mtime) throw new Error('filen ändrades under omkodningen');
  const trash = path.join(trashDirFor(it.path), `${j.id}-${path.basename(it.path)}.original`);
  const how = toTrash(it.path, trash);
  try { fs.renameSync(tmp, final); }
  catch (e) {
    // Tillbaka som det var
    if (how === 'rename') { try { fs.renameSync(trash, it.path); } catch {} } else { try { fs.rmSync(trash, { force: true }); } catch {} }
    throw e;
  }
  if (final !== it.path && how !== 'rename') { try { fs.rmSync(it.path, { force: true }); } catch {} }
  const st = fs.statSync(final);
  tx(() => {
    run(`UPDATE items SET path=?, size=?, mtime=?, duration=?, container=?, vcodec=?, acodec=?, width=?, height=?, streams=? WHERE id=?`,
      final, st.size, Math.floor(st.mtimeMs / 1000), info.duration, info.container, info.vcodec, info.acodec, info.width, info.height, info.streams, it.id);
    remapOverrides(it, info, `${Math.floor(st.mtimeMs / 1000)}:${st.size}`);
    setJob(j.id, { status: 'done', finished: now(), dst_path: final, out_size: st.size, trash_path: trash, trash_until: now() + s.trashDays * 86400, tmp_path: null, error: null });
  });
  console.log(`[krymp] ${j.title}: ${(it.size / GB).toFixed(2)} → ${(st.size / GB).toFixed(2)} GB, originalet i ${trash}`);
  return { status: 'done' };
}
/** Rättad språkmärkning (health.js) gäller spår per index och filversion – flytta till de nya indexen och den nya versionen */
function remapOverrides(it, info, sig) {
  let rows; try { rows = all('SELECT * FROM lang_overrides WHERE item_id=?', it.id); } catch { return; }
  if (!rows.length) return;
  const ord = (streams, t) => streams.filter(x => x.type === t).map(x => x.index);
  let a = [], b = []; try { a = JSON.parse(it.streams || '[]'); b = JSON.parse(info.streams || '[]'); } catch {}
  for (const r of rows) {
    const m = /^([ae])(\d+)$/.exec(r.track);
    let track = r.track;
    if (m) {
      const t = m[1] === 'a' ? 'audio' : 'subtitle', k = ord(a, t).indexOf(+m[2]), ni = ord(b, t)[k];
      if (k < 0 || ni == null) { run('DELETE FROM lang_overrides WHERE item_id=? AND track=?', it.id, r.track); continue; }
      track = m[1] + ni;
    }
    run('UPDATE OR REPLACE lang_overrides SET track=?, sig=? WHERE item_id=? AND track=?', track, sig, it.id, r.track);
  }
}

async function loop() {
  if (S.ticking) return;
  S.ticking = true;
  try {
    purgeTrash();
    for (;;) {
      const j = get("SELECT * FROM shrink_jobs WHERE status='queued' ORDER BY id LIMIT 1");
      if (!j) break;
      if (!j.item_id) { setJob(j.id, { status: 'failed', error: 'titeln finns inte längre', finished: now() }); continue; }
      const r = waitReason(); S.waiting = r;
      if (r) { kick(60000); break; }
      S.job = j; S.cancel = null;
      setJob(j.id, { status: 'running', started: now(), error: null });
      let res;
      try { res = await runJob(j); }
      catch (e) { res = e.cancelled ? { status: 'cancelled', error: null } : { status: 'failed', error: String(e.message || e).slice(0, 500) }; if (!e.cancelled) console.warn('[krymp]', j.title, e.message); }
      const tmp = get('SELECT tmp_path FROM shrink_jobs WHERE id=?', j.id)?.tmp_path;
      if (res.status !== 'done' && tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} }
      if (res.status !== 'done') setJob(j.id, { status: res.status, error: res.error, finished: now(), tmp_path: null });
      S.job = null; S.waiting = null; S.cancel = null;
    }
  } finally { S.ticking = false; }
}
/** Starta kön om ms (flera anrop i rad blir ett, det tidigaste gäller) */
export function kick(ms = 1000) {
  const at = Date.now() + ms;
  if (S.timer && S.at <= at) return;
  clearTimeout(S.timer); S.at = at;
  S.timer = setTimeout(() => { S.timer = null; loop().catch(e => console.warn('[krymp]', e.message)); }, ms);
  S.timer.unref?.();
}
/** Under ett pågående jobb: kontrollera fönster/tittande regelbundet (pausa/återuppta ffmpeg) */
setInterval(() => { if (S.job) hold(waitReason()); }, process.env.SHRINK_POLL_MS ? +process.env.SHRINK_POLL_MS : 15000).unref();

export function cancel(id) {
  const j = get('SELECT * FROM shrink_jobs WHERE id=?', +id);
  if (!j) return null;
  if (j.status === 'queued') { setJob(j.id, { status: 'cancelled', finished: now() }); return 'cancelled'; }
  if (j.status === 'running' && S.job?.id === j.id) {
    S.cancel = j.id;
    if (S.proc) { try { if (S.stopped) S.proc.kill('SIGCONT'); S.proc.kill('SIGTERM'); } catch {} }
    return 'cancelling';
  }
  return false;
}

/** Ta tillbaka originalet ur papperskorgen. Den omkodade filen tas bort. */
export async function restore(id) {
  const j = get('SELECT * FROM shrink_jobs WHERE id=?', +id);
  if (!j || j.status !== 'done' || !j.trash_path || !fs.existsSync(j.trash_path)) throw Object.assign(new Error('Originalet finns inte i papperskorgen'), { code: 404 });
  while (scanStatus.running) await sleep(1000);
  const info = await scanProbe(j.trash_path);
  if (info.failed) throw new Error('originalet går inte att läsa');
  const it = j.item_id ? get('SELECT * FROM items WHERE id=?', j.item_id) : null;
  const back = j.src_path;
  if (fs.existsSync(back) && back !== j.dst_path) throw new Error(`${path.basename(back)} finns redan`);
  // rename ersätter den omkodade filen atomiskt när sökvägen är densamma
  try { fs.renameSync(j.trash_path, back); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(j.trash_path, back + '.tmp-restore'); fs.renameSync(back + '.tmp-restore', back); fs.rmSync(j.trash_path, { force: true }); }
  if (j.dst_path && j.dst_path !== back) { try { fs.rmSync(j.dst_path, { force: true }); } catch {} }
  const st = fs.statSync(back);
  tx(() => {
    if (it && (it.path === j.dst_path || it.path === back)) {
      run(`UPDATE items SET path=?, size=?, mtime=?, duration=?, container=?, vcodec=?, acodec=?, width=?, height=?, streams=? WHERE id=?`,
        back, st.size, Math.floor(st.mtimeMs / 1000), info.duration, info.container, info.vcodec, info.acodec, info.width, info.height, info.streams, it.id);
      remapOverrides(it, info, `${Math.floor(st.mtimeMs / 1000)}:${st.size}`);
    }
    setJob(j.id, { status: 'restored', trash_path: null, trash_until: null });
  });
  return true;
}
/** Töm papperskorgen: allt som passerat sitt datum, eller ett jobb direkt (id). Tar bara bort filer som ligger i en papperskorg. */
export function purgeTrash(id = null, at = now()) {
  const rows = id != null ? all('SELECT * FROM shrink_jobs WHERE id=? AND trash_path IS NOT NULL', +id)
    : all('SELECT * FROM shrink_jobs WHERE trash_path IS NOT NULL AND trash_until IS NOT NULL AND trash_until <= ?', at);
  let n = 0;
  for (const j of rows) {
    const p = j.trash_path;
    const inTrash = p.endsWith('.original') && (path.basename(path.dirname(p)) === TRASH_NAME || (process.env.SHRINK_TRASH_DIR && path.dirname(p) === path.resolve(process.env.SHRINK_TRASH_DIR)));
    if (!inTrash) { console.warn('[krymp] tar inte bort (ligger inte i papperskorgen):', p); continue; }
    try { fs.rmSync(p, { force: true }); n++; } catch (e) { console.warn('[krymp] papperskorgen:', e.message); continue; }
    setJob(j.id, { trash_path: null, trash_until: null });
  }
  return n;
}

// Efter omstart: ett jobb som kördes börjar om (den halva filen tas bort); papperskorgen rensas varje timme
for (const j of all("SELECT id, tmp_path FROM shrink_jobs WHERE status='running'")) {
  if (j.tmp_path) { try { fs.rmSync(j.tmp_path, { force: true }); } catch {} }
  setJob(j.id, { status: 'queued', tmp_path: null, started: null });
}
setInterval(() => kick(0), 3600e3).unref();
ffReady.then(() => { if (get("SELECT 1 FROM shrink_jobs WHERE status='queued' LIMIT 1")) kick(+(process.env.SHRINK_START_DELAY ?? 60000)); });
