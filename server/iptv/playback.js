// Uppspelning av catch-up (redan sända program) och VOD (filmer/avsnitt från Xtream) som HLS: ffmpeg läser
// leverantörens adress (med rubrikerna från listan) och skriver en EVENT-spellista som växer. Bilden kopieras när den
// redan är H.264 (webbläsare och appar klarar den), annars kodas den om med samma kodare som live-TV (liveEncoder i
// stream.js, med GPU när HWACCEL är satt). Ljudet blir alltid AAC stereo.
// Spolning utanför det som hunnit skrivas = ny session från den tidpunkten (catch-up-adressen byggs om med ny start,
// VOD med -ss). Varje session tar en anslutning hos källan (samma räkning som live-TV och inspelningar) och stängs när
// ingen hämtat något på en minut. Sessionerna är knutna till profilen som startade dem.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { TRANSCODE, liveEncoder } from '../stream.js';
import { getSetting } from '../db.js';
import { fail, send, streamFile } from '../util.js';
import { ffHeaders, assertStream, redact, iptvFetch } from './net.js';

export const PLAY_SCOPE = 9e9; // mediatoken för en session: 9e9 + sessionens nummer (BRAIN.md: scope-intervall)
const DIR = path.join(TRANSCODE, 'iptv');
const SEG_RE = /^seg-\d{5,9}\.ts$/;
const IDLE_MS = 60000, PER_USER = 2;
const sessions = new Map(); // sid → session
let nextSid = 1;
const live = () => import('../livetv.js');
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}

// -readrate (ffmpeg 5.0+) håller läsningen till ett par gånger realtid, så att en lång film inte laddas ner till disken
// på en gång. Mäts vid start (äldre ffmpeg utan flaggan läser i full fart).
let readrate = null;
const hasReadrate = () => {
  if (readrate == null) { try { readrate = /readrate/.test(spawnSync('ffmpeg', ['-hide_banner', '-h', 'long'], { encoding: 'utf8', timeout: 8000 }).stdout || ''); } catch { readrate = false; } }
  return readrate;
};
const httpIn = (u) => /^https?:/i.test(u) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '20000000'] : [];

/** Codec och längd (ffprobe med samma rubriker) */
function probe(url, headers) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('ffprobe', ['-v', 'error', '-protocol_whitelist', 'http,https,tcp,tls,crypto,hls,httpproxy', ...ffHeaders(headers), ...(/^https?:/i.test(url) ? ['-rw_timeout', '10000000'] : []),
        '-analyzeduration', '4000000', '-probesize', '4000000', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', url], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return resolve({}); }
    let out = '';
    p.stdout.on('data', d => { if (out.length < 200000) out += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 12000);
    p.on('error', () => { clearTimeout(t); resolve({}); });
    p.on('close', () => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out);
        const v = j.streams?.find(s => s.codec_type === 'video'), a = j.streams?.find(s => s.codec_type === 'audio');
        resolve({ v: v?.codec_name || null, a: a?.codec_name || null, duration: parseFloat(j.format?.duration) || null });
      } catch { resolve({}); }
    });
  });
}

/** Startar en session. o: { user, kind: 'catchup'|'movie'|'episode', ref, url, headers, pol, tunerId, title, duration, offset, seek } */
export async function start(o) {
  for (const [id, s] of [...sessions]) if (s.uid === o.user.id && s.kind === o.kind && s.ref === o.ref) stop(id);
  const mine = [...sessions.values()].filter(s => s.uid === o.user.id).sort((a, b) => a.last - b.last);
  while (mine.length >= PER_USER) stop(mine.shift().sid);
  await assertStream(o.url, o.pol);
  const L = await live();
  const sid = nextSid++, key = `iptv-${sid}`;
  if (!L.acquireTuner(o.tunerId, key) && !(L.stealIdle?.(o.tunerId) && L.acquireTuner(o.tunerId, key)))
    throw Object.assign(new Error('Alla anslutningar till källan används just nu (live-TV, inspelningar eller annan uppspelning)'), { status: 409 });
  const s = { sid, uid: o.user.id, kind: o.kind, ref: o.ref, tunerId: o.tunerId, key, dir: path.join(DIR, String(sid)), proc: null, error: null, done: false,
    last: Date.now(), offset: o.offset || 0, duration: o.duration || null, title: o.title || '' };
  sessions.set(sid, s);
  try {
    fs.mkdirSync(s.dir, { recursive: true });
    const info = await probe(o.url, o.headers);
    if (!sessions.has(sid)) throw new Error('Avbruten');
    if (!s.duration && info.duration) s.duration = Math.round(info.duration);
    const copyV = getSetting('live_transcode', 'auto') !== 'always' && /^(h264|avc)/i.test(info.v || '');
    const enc = liveEncoder({ deinterlace: true, maxHeight: +getSetting('live_max_height', '1080') || null });
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...L.SAFE_LIVE, '-fflags', '+genpts+discardcorrupt', ...httpIn(o.url), ...ffHeaders(o.headers),
      ...(hasReadrate() ? ['-readrate', '2'] : []), ...(o.seek > 0 ? ['-ss', String(o.seek)] : []), ...(copyV ? [] : enc.pre), '-i', o.url,
      '-map', '0:v:0?', '-map', '0:a:0?', ...(copyV ? ['-c:v', 'copy'] : [...enc.vf, ...enc.enc, '-g', '48', '-keyint_min', '48', '-sc_threshold', '0']),
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments+temp_file', '-hls_segment_filename', path.join(s.dir, 'seg-%05d.ts'), path.join(s.dir, 'index.m3u8')];
    const proc = s.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err = (err + d).slice(-800); });
    proc.on('error', (e) => { s.error = 'ffmpeg kunde inte startas: ' + e.message; });
    proc.on('close', (code) => {
      s.proc = null; s.done = true;
      L.releaseTuner(s.tunerId, s.key);
      if (code && sessions.get(sid) === s) s.error ||= redact(err.trim().split('\n').pop() || 'Strömmen avbröts');
    });
  } catch (e) { stop(sid); throw e; }
  return s;
}
export function stop(sid) {
  const s = sessions.get(+sid); if (!s) return;
  sessions.delete(s.sid);
  try { s.proc?.kill('SIGKILL'); } catch {}
  live().then(L => L.releaseTuner(s.tunerId, s.key)).catch(() => {});
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
}
export const session = (sid, uid) => { const s = sessions.get(+sid); return s && s.uid === uid ? s : null; };
export const active = () => [...sessions.values()].map(s => ({ sid: s.sid, uid: s.uid, kind: s.kind, title: s.title, since: s.sid }));
export function stopFor(uid) { for (const s of [...sessions.values()]) if (s.uid === uid) stop(s.sid); }

export async function servePlaylist(res, s, token = null) {
  s.last = Date.now();
  const f = path.join(s.dir, 'index.m3u8');
  for (let i = 0; i < 125 && !fs.existsSync(f); i++) { if (s.error || s.done) break; await new Promise(r => setTimeout(r, 200)); }
  if (!fs.existsSync(f)) return fail(res, 502, 'Programmet kunde inte startas' + (s.error ? ': ' + s.error : ''));
  const q = token ? `?t=${encodeURIComponent(token)}` : '';
  const text = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l && !l.startsWith('#') && SEG_RE.test(l.trim()) ? l.trim() + q : l).join('\n');
  send(res, 200, text, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
}
export function serveSegment(req, res, s, name) {
  if (!SEG_RE.test(name)) return fail(res, 404, 'Finns inte');
  s.last = Date.now();
  const f = path.join(s.dir, name);
  fs.stat(f, (err, st) => {
    if (err) return fail(res, 404, 'Finns inte');
    streamFile(req, res, f, st.size, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'private, max-age=3600' }, { ranges: false });
  });
}
/** Hur mycket som hunnit skrivas (sekunder från sessionens början) – webbspelaren väljer lokal spolning eller ny session */
export function produced(s) {
  try { return fs.readFileSync(path.join(s.dir, 'index.m3u8'), 'utf8').split('\n').reduce((a, l) => a + (l.startsWith('#EXTINF:') ? parseFloat(l.slice(8)) || 0 : 0), 0); } catch { return 0; }
}

/** VOD direkt (MP4 med H.264/AAC): leverantörens fil skickas vidare med Range, så att webbläsaren kan spola fritt.
 *  Tar en anslutning hos källan medan den skickas. */
export async function proxyFile(req, res, { url, headers, pol, tunerId, key }) {
  await assertStream(url, pol);
  const L = await live();
  if (!L.acquireTuner(tunerId, key) && !(L.stealIdle?.(tunerId) && L.acquireTuner(tunerId, key))) return fail(res, 409, 'Alla anslutningar till källan används just nu');
  let released = false;
  const release = () => { if (!released) { released = true; L.releaseTuner(tunerId, key); } };
  try {
    const h = { ...headers, 'Accept-Encoding': 'identity' };
    if (req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range)) h.Range = req.headers.range;
    const { r } = await iptvFetch(url, { pol, headers: h, timeout: 30000 });
    if (r.status >= 400) { r.body.resume(); release(); return fail(res, 502, `Källan svarade ${r.status}`); }
    const out = { 'Content-Type': /^(video|audio)\//.test(r.headers.get('content-type') || '') ? r.headers.get('content-type') : 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    for (const k of ['content-length', 'content-range']) if (r.headers.get(k)) out[k] = r.headers.get(k);
    res.writeHead(r.status === 206 ? 206 : 200, out);
    if (req.method === 'HEAD') { r.body.destroy(); release(); return res.end(); }
    res.on('close', () => { r.body.destroy(); release(); });
    r.body.on('error', () => { release(); res.destroy(); });
    r.body.on('end', release);
    r.body.pipe(res);
  } catch (e) { release(); if (!res.headersSent) fail(res, 502, redact(e.message)); else res.destroy(); }
}

setInterval(() => { for (const s of [...sessions.values()]) if (Date.now() - s.last > IDLE_MS) stop(s.sid); }, 15000).unref();
export function shutdown() { for (const s of [...sessions.values()]) stop(s.sid); }
