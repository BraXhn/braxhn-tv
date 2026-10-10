// Offline-nedladdning: skapar en mobilanpassad MP4 (H.264/AAC, faststart) som appar kan ladda ner och spela utan nät.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CACHE, getSetting } from './db.js';
import { streamsOf } from './stream.js';
import { send, fail } from './util.js';

const DIR = path.join(CACHE, 'offline');
fs.mkdirSync(DIR, { recursive: true });
const Q = { orig: { h: null, br: null }, '1080': { h: 1080, br: 6000 }, '720': { h: 720, br: 3000 }, '480': { h: 480, br: 1200 } };
const jobs = new Map(); // key -> { status, progress, proc, error }
let running = 0;
const queue = [];

const keyOf = (it, q) => `${it.id}-${it.mtime}-${q}`;
const fileOf = (key) => path.join(DIR, key + '.mp4');

/** Kan originalfilen laddas ner som den är? (MP4 med H.264 8-bit/HEVC + AAC) */
function originalOk(it) {
  const s = streamsOf(it), v = s.find(x => x.type === 'video'), a = s.find(x => x.type === 'audio');
  return /\.(mp4|m4v|mov)$/i.test(it.path) && v && ['h264', 'hevc'].includes(v.codec) && !/10/.test(v.pix || '') && (!a || a.codec === 'aac');
}

export function status(it, q = '720') {
  if (!Q[q]) q = '720';
  if (q === 'orig' && originalOk(it)) return { status: 'ready', original: true, size: fs.statSync(it.path).size };
  const key = keyOf(it, q), f = fileOf(key);
  if (fs.existsSync(f) && !jobs.get(key)) { fs.utimesSync(f, new Date(), new Date()); return { status: 'ready', size: fs.statSync(f).size }; }
  const j = jobs.get(key);
  if (j) return { status: j.status, progress: j.progress, error: j.error };
  return { status: 'none' };
}

export function start(it, q = '720') {
  if (!Q[q]) q = '720';
  const st = status(it, q);
  if (st.status !== 'none' && st.status !== 'error') return st;
  const key = keyOf(it, q);
  const job = { status: 'queued', progress: 0 };
  jobs.set(key, job);
  queue.push(() => run(it, q, key, job));
  pump();
  return { status: 'queued', progress: 0 };
}

function pump() {
  const max = Math.max(1, +getSetting('offline_parallel', '1'));
  while (running < max && queue.length) { running++; queue.shift()().finally(() => { running--; pump(); }); }
}

function run(it, q, key, job) {
  return new Promise((resolve) => {
    const v = streamsOf(it).find(x => x.type === 'video');
    const Qq = Q[q];
    const scale = Qq.h && v?.height > Qq.h;
    const copyV = !scale && v?.codec === 'h264' && !/10/.test(v.pix || '') && !it.hdr;
    const tm = it.hdr ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,' : '';
    const vf = `${scale ? `scale=-2:${Qq.h},` : ''}${tm}format=yuv420p`;
    const tmp = fileOf(key) + '.part';
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-protocol_whitelist', 'file,pipe', '-i', it.path,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      ...(copyV ? ['-c:v', 'copy'] : ['-vf', vf, '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast', ...(Qq.br ? ['-b:v', Qq.br + 'k', '-maxrate', Qq.br + 'k', '-bufsize', Qq.br * 2 + 'k'] : ['-crf', '21']), '-profile:v', 'high']),
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', tmp];
    job.status = 'running';
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.proc = p;
    let err = '';
    p.stdout.on('data', (d) => {
      const m = /out_time_ms=(\d+)/.exec(String(d));
      if (m && it.duration) job.progress = Math.min(99, Math.round(+m[1] / 1e6 / it.duration * 100));
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
    p.on('close', (code) => {
      job.proc = null;
      if (code === 0) { fs.renameSync(tmp, fileOf(key)); jobs.delete(key); cleanup(); }
      else { fs.rmSync(tmp, { force: true }); job.status = 'error'; job.error = err.trim().split('\n').pop() || 'ffmpeg misslyckades'; }
      resolve();
    });
  });
}

export function cancel(it, q) {
  const key = keyOf(it, q), j = jobs.get(key);
  if (j?.proc) j.proc.kill('SIGKILL');
  jobs.delete(key);
}

/** Servera filen med Range-stöd (nedladdning kan återupptas). */
export function serveFile(req, res, it, q) {
  const f = q === 'orig' && originalOk(it) ? it.path : fileOf(keyOf(it, Q[q] ? q : '720'));
  let st; try { st = fs.statSync(f); } catch { return fail(res, 404, 'Inte klar än'); }
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1, code = 200;
  if (m) { start = m[1] === '' ? Math.max(0, st.size - +m[2]) : +m[1]; if (m[1] !== '' && m[2] !== '') end = Math.min(+m[2], end); code = 206; }
  if (start > end) return send(res, 416, '', { 'Content-Range': `bytes */${st.size}` });
  const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    'Content-Disposition': `attachment; filename="braxhn-${it.id}.mp4"` };
  if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(code, h);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f, { start, end }).pipe(res);
}

// Håll cachen under gränsen (standard 50 GB) och rensa filer som inte använts på 14 dagar
export function cleanup() {
  const maxBytes = (+getSetting('offline_max_gb', '50')) * 1e9;
  let files = fs.readdirSync(DIR).filter(f => f.endsWith('.mp4')).map(f => { const st = fs.statSync(path.join(DIR, f)); return { f, size: st.size, t: st.mtimeMs }; });
  for (const x of files) if (Date.now() - x.t > 14 * 86400e3) fs.rmSync(path.join(DIR, x.f), { force: true });
  files = files.filter(x => Date.now() - x.t <= 14 * 86400e3).sort((a, b) => a.t - b.t);
  let total = files.reduce((s, x) => s + x.size, 0);
  while (total > maxBytes && files.length) { const x = files.shift(); fs.rmSync(path.join(DIR, x.f), { force: true }); total -= x.size; }
}
setInterval(cleanup, 6 * 3600e3).unref();
