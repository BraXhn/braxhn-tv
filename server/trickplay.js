// Förhandsbilder vid spolning: en bild var 10:e sekund, 10×10 bilder per sprite-ark.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { all, run, CACHE, getSetting } from './db.js';
import { keyframesReady } from './stream.js';

const pexec = promisify(execFile);
export const INTERVAL = 10, COLS = 10, ROWS = 10, WIDTH = 240;
const dirOf = (it) => path.join(CACHE, 'trickplay', `${it.id}-${it.mtime}`);

function sizeOf(it) {
  let v; try { v = JSON.parse(it.streams || '[]').find(s => s.type === 'video'); } catch {}
  const h = v?.width && v?.height ? Math.max(2, Math.round(WIDTH * v.height / v.width / 2) * 2) : 136;
  return { w: WIDTH, h };
}

export function info(it) {
  try { return JSON.parse(fs.readFileSync(path.join(dirOf(it), 'info.json'), 'utf8')); } catch { return null; }
}
export function sprite(it, n) {
  const f = path.join(dirOf(it), `sprite_${String(+n).padStart(3, '0')}.jpg`);
  return fs.existsSync(f) ? f : null;
}

// Snabba vägen: med filens nyckelbilder kända (indexeras före förhandsbilderna) hoppar ffmpeg direkt till en
// nyckelbild per intervall och avkodar bara den. Annars läses hela filen och varje nyckelbild avkodas –
// för en 4K-film på 60 GB tar det många minuter, med hoppen några sekunder.
function seekList(it, kf) {
  const pts = [];
  let i = 0;
  for (let t = 0; t < (it.duration || 0); t += INTERVAL) {
    while (i < kf.length && kf[i] < t - 0.001) i++;
    if (i >= kf.length) break;
    pts.push(kf[i]);
  }
  const file = `'${it.path.replace(/'/g, "'\\''")}'`;
  return { count: pts.length, text: 'ffconcat version 1.0\n' + pts.map(p => `file ${file}\ninpoint ${p.toFixed(6)}\noutpoint ${(p + 0.001).toFixed(6)}\n`).join('') };
}

export async function generate(it) {
  const { w, h } = sizeOf(it);
  const dir = dirOf(it);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^sprite_\d+\.jpg$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  const kf = keyframesReady(it);
  let count = Math.ceil((it.duration || 0) / INTERVAL);
  const list = kf?.length > 1 ? seekList(it, kf) : null;
  if (list?.count) {
    const lf = path.join(dir, 'list.ffconcat');
    fs.writeFileSync(lf, list.text);
    try {
      // setpts: varje hopp börjar om på samma tid – numrera bilderna i stället
      await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '0', '-skip_frame', 'nokey', '-i', lf,
        '-an', '-sn', '-dn', '-map', '0:v:0', '-vf', `setpts=N/TB,scale=${w}:${h}:flags=fast_bilinear,tile=${COLS}x${ROWS}`,
        '-fps_mode', 'passthrough', '-q:v', '6', path.join(dir, 'sprite_%03d.jpg')], { timeout: 30 * 60e3 });
      count = list.count;
    } finally { fs.rmSync(lf, { force: true }); }
  } else {
    // Endast nyckelbilder avkodas, fps-filtret väljer en bild per intervall
    await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-skip_frame', 'nokey', '-i', it.path,
      '-an', '-sn', '-dn', '-map', '0:v:0', '-vf', `fps=1/${INTERVAL},scale=${w}:${h}:flags=fast_bilinear,tile=${COLS}x${ROWS}`,
      '-fps_mode', 'vfr', '-q:v', '6', path.join(dir, 'sprite_%03d.jpg')], { timeout: 60 * 60e3 });
  }
  const sheets = fs.readdirSync(dir).filter(f => /^sprite_\d+\.jpg$/.test(f)).length;
  if (!sheets) throw new Error('inga bilder skapades');
  fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify({ interval: INTERVAL, w, h, cols: COLS, rows: ROWS, count, sheets, first: 1 }));
  // Ta bort gamla versioner (om filen ändrats)
  for (const d of fs.readdirSync(path.dirname(dir))) if (d.startsWith(`${it.id}-`) && d !== path.basename(dir)) fs.rmSync(path.join(path.dirname(dir), d), { recursive: true, force: true });
  run('UPDATE items SET trickplay=1 WHERE id=?', it.id);
}

export async function generateLibrary(lib, status) {
  if (getSetting('trickplay', process.env.TRICKPLAY || '1') !== '1') return;
  const todo = all(`SELECT id, path, mtime, duration, streams FROM items WHERE library_id=? AND kind IN ('movie','episode') AND trickplay=0 AND vcodec IS NOT NULL AND duration > 60`, lib.id);
  if (status) { status.phase = 'Skapar förhandsbilder för spolning'; status.done = 0; status.total = todo.length; }
  // Två filmer åt gången (de ligger ofta på olika diskar i Unraid-arrayen)
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const it = todo[next++];
      try { await generate(it); } catch (e) { console.warn('[trickplay]', it.path, e.message); run('UPDATE items SET trickplay=2 WHERE id=?', it.id); }
      if (status) status.done++;
    }
  };
  await Promise.all([worker(), worker()]);
}
