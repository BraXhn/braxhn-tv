// Titta medan inspelningen pågår: den växande TS-filen läses av ffmpeg (file-protokollets follow, som väntar på mer
// data i slutet av filen) och görs om till en HLS-spellista av typen EVENT – hela det inspelade går att spola i och
// listan växer tills inspelningen är klar (då skriver ffmpeg ENDLIST). H.264 kopieras, annat kodas om (MPEG-2 från
// antenn-TV). En session per inspelning delas av alla som tittar och stängs när ingen hämtat något på en minut.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TRANSCODE, liveEncoder } from './stream.js';
import { rewritePlaylist, SEG_RE } from './timeshift.js';
import { send, fail, streamFile } from './util.js';

const DIR = path.join(TRANSCODE, 'dvrlive');
const sessions = new Map(); // recordingId → { proc, dir, last, error, file }
const starting = new Map();
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}

function probe(file) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,field_order', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return resolve(''); }
    let out = ''; p.stdout.on('data', d => out += d);
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 10000);
    p.on('error', () => { clearTimeout(t); resolve(''); });
    p.on('close', () => { clearTimeout(t); resolve(out.trim()); });
  });
}

/** ffmpeg-argument för HLS av en växande fil (exporteras för test) */
export function growingArgs(file, dir, copy, idleSeconds = 30) {
  const enc = liveEncoder({ deinterlace: true, maxHeight: 1080 });
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file',
    // follow: läs vidare när filen växer; rw_timeout: sluta när inget nytt kommit på idleSeconds (inspelningen klar)
    '-follow', '1', '-seekable', '0', '-rw_timeout', String(idleSeconds * 1e6), ...(copy ? [] : enc.pre), '-fflags', '+genpts+discardcorrupt',
    '-i', 'file:' + file, '-map', '0:v:0?', '-map', '0:a:0?',
    ...(copy ? ['-c:v', 'copy'] : [...enc.vf, ...enc.enc, '-g', '48', '-keyint_min', '48', '-sc_threshold', '0']),
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments', '-hls_segment_filename', path.join(dir, 'seg-%05d.ts'), path.join(dir, 'index.m3u8')];
}

const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
async function start(id, file) {
  // Precis påbörjad: vänta på lite data så att videoformatet går att avgöra (annars kodas allt om i onödan)
  for (let i = 0; i < 20 && sizeOf(file) < 500e3; i++) await new Promise(r => setTimeout(r, 500));
  const v = await probe(file);
  const copy = /^h264,(progressive|unknown)?/.test(v) || v === 'h264';
  const s = { proc: null, dir: path.join(DIR, `${id}-${Date.now()}`), last: Date.now(), error: null, file };
  fs.mkdirSync(s.dir, { recursive: true });
  const p = spawn('ffmpeg', growingArgs(file, s.dir, copy), { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', d => { err = (err + d).slice(-600); });
  p.on('error', (e) => { s.error = 'ffmpeg kunde inte startas: ' + e.message; s.proc = null; });
  p.on('close', (code) => { if (s.proc === p) s.proc = null; if (code && !s.error) s.error = err.trim().split('\n').pop() || `ffmpeg avslutades (${code})`; });
  s.proc = p;
  sessions.set(id, s);
  return s;
}

export async function servePlaylist(res, id, file, token = null) {
  let s = sessions.get(id);
  // En session som hann ta slut med fel (eller för en annan fil) startas om
  if (s && ((s.error && !s.proc) || s.file !== file)) { stop(id); s = null; }
  if (!s) {
    if (!starting.has(id)) starting.set(id, start(id, file).finally(() => starting.delete(id)));
    try { s = await starting.get(id); } catch (e) { return fail(res, 500, e.message); }
  }
  s.last = Date.now();
  const f = path.join(s.dir, 'index.m3u8');
  // Första segmentet kan dröja (omkodning) – vänta högst 20 sekunder
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) { if (s.error || !s.proc) break; await new Promise(r => setTimeout(r, 200)); }
  if (!fs.existsSync(f)) { const e = s.error; stop(id); return fail(res, 502, 'Inspelningen kunde inte visas' + (e ? ': ' + e : '')); }
  send(res, 200, rewritePlaylist(fs.readFileSync(f, 'utf8'), { token }), { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
}
export function serveSegment(req, res, id, name) {
  const s = sessions.get(+id);
  if (!s || !SEG_RE.test(name)) return fail(res, 404, 'Finns inte');
  s.last = Date.now();
  const f = path.join(s.dir, name);
  fs.stat(f, (err, st) => {
    if (err) return fail(res, 404, 'Finns inte');
    streamFile(req, res, f, st.size, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' }, { ranges: false });
  });
}
export function stop(id) {
  const s = sessions.get(id); if (!s) return;
  sessions.delete(id);
  try { s.proc?.kill('SIGKILL'); } catch {}
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
}
/** Sessioner som ingen hämtat från på maxIdleMs stängs */
export function sweep(maxIdleMs = 60000) { for (const [id, s] of [...sessions]) if (Date.now() - s.last > maxIdleMs) stop(id); }
setInterval(sweep, 15000).unref();
export function shutdown() { for (const id of [...sessions.keys()]) stop(id); }
export const active = () => [...sessions.keys()];
