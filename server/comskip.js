// Reklamavbrott i inspelningar. När en inspelning är klar analyseras MP4-filen med ffmpeg (blackdetect + silencedetect)
// i en lågprioriterad bakgrundsprocess med tidsgräns. Reklamfilmer avgränsas av korta svarta och tysta ögonblick:
// flera sådana brytpunkter tätt efter varandra (minst två "filmer" mellan dem) bildar ett troligt reklamavbrott.
// Segmenten sparas per inspelning och exponeras i inspelnings-API:t (/api/dvr) så att webben och apparna kan hoppa över dem.
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { db, get, all, run, now, getSetting } from './db.js';

// status: pending → running → done | failed. segments: JSON [{ start, end }] i sekunder.
db.exec(`CREATE TABLE IF NOT EXISTS rec_commercials(recording_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
  segments TEXT, error TEXT, updated INTEGER)`);

export const DEFAULTS = {
  pairGap: 0.5,   // svart bild och tystnad räknas som samma brytpunkt om de ligger så här nära (s)
  mergeGap: 1,    // brytpunkter närmare än så slås ihop
  maxSpot: 120,   // längsta tid mellan två brytpunkter inom ett avbrott (en reklamfilm)
  minSpot: 5,     // kortare "filmer" än så räknas inte (t.ex. flimmer)
  minSpots: 2,    // minst så många filmer i ett avbrott
  minBreak: 60,   // rimlig längd på ett reklamavbrott: 1–10 minuter
  maxBreak: 600
};

/** Läser ffmpegs logg: svarta partier, tysta partier och längden */
export function parseDetect(text) {
  const blacks = [], silences = [];
  let silStart = null, duration = null;
  for (const l of String(text).split(/\r?\n/)) {
    let m = /black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/.exec(l);
    if (m) { blacks.push({ start: Math.max(0, +m[1]), end: +m[2] }); continue; }
    m = /silence_start:\s*(-?[\d.]+)/.exec(l);
    if (m) { silStart = Math.max(0, +m[1]); continue; }
    m = /silence_end:\s*(-?[\d.]+)/.exec(l);
    if (m) { silences.push({ start: silStart ?? 0, end: +m[1] }); silStart = null; continue; }
    m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(l);
    if (m && duration == null) duration = +m[1] * 3600 + +m[2] * 60 + +m[3];
  }
  return { blacks, silences, duration };
}

/** Hittar troliga reklamavbrott. Brytpunkt = svart parti som sammanfaller med tystnad. Brytpunkter med högst maxSpot
 *  sekunder emellan kedjas ihop; en kedja med minst minSpots filmer och en total längd på minBreak–maxBreak är ett avbrott.
 *  Segmentet går från första brytpunktens början till sista brytpunktens slut. */
export function findCommercials(blacks, silences, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const points = blacks
    .filter(b => silences.some(s => s.start <= b.end + o.pairGap && s.end >= b.start - o.pairGap))
    .map(b => ({ ...b }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const p of points) {
    const last = merged[merged.length - 1];
    if (last && p.start - last.end < o.mergeGap) last.end = Math.max(last.end, p.end);
    else merged.push(p);
  }
  const out = [];
  let chain = [];
  const flush = () => {
    if (chain.length >= 2) {
      let spots = 0;
      for (let i = 1; i < chain.length; i++) if (chain[i].start - chain[i - 1].end >= o.minSpot) spots++;
      const start = chain[0].start, end = chain[chain.length - 1].end;
      if (spots >= o.minSpots && end - start >= o.minBreak && end - start <= o.maxBreak)
        out.push({ start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 });
    }
    chain = [];
  };
  for (const p of merged) {
    if (chain.length && p.start - chain[chain.length - 1].end > o.maxSpot) flush();
    chain.push(p);
  }
  flush();
  return out;
}

/** Analyserar en fil (lågprioriterat, med tidsgräns). onSpawn får processen så att den kan avbrytas. */
export function analyzeFile(file, { timeoutMs = 3600e3, onSpawn = null, opts = {} } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-nostdin', '-loglevel', 'info', '-threads', '2', '-protocol_whitelist', 'file', '-i', file,
      '-map', '0:v:0', '-map', '0:a:0', '-vf', 'blackdetect=d=0.1:pix_th=0.10', '-af', 'silencedetect=noise=-45dB:d=0.15', '-f', 'null', '-'];
    let p;
    try { p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { return reject(e); }
    try { os.setPriority(p.pid, 19); } catch {} // lägsta CPU-prioritet: uppspelning och omkodning går före
    onSpawn?.(p);
    // Bara de rader som behövs sparas (loggen kan bli lång för en lång inspelning)
    let buf = '', keep = '', tailErr = '', timedOut = false;
    p.stderr.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (/black_start|silence_(start|end)|Duration:/.test(l)) keep += l + '\n';
        else tailErr = (tailErr + l + '\n').slice(-400);
      }
    });
    const timer = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    timer.unref?.();
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code, sig) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Analysen tog för lång tid'));
      if (code !== 0) return reject(new Error(sig ? 'Avbruten' : (tailErr.trim().split('\n').pop() || `ffmpeg avslutades (${code})`)));
      const r = parseDetect(keep + buf);
      resolve({ ...r, segments: findCommercials(r.blacks, r.silences, opts) });
    });
  });
}

// ---------- kö (en analys i taget, väntar när servern har annat att göra) ----------
export const enabled = () => getSetting('dvr_comskip', process.env.DVR_COMSKIP ?? '1') !== '0';
export const autoSkipDefault = () => getSetting('dvr_comskip_autoskip', '0') === '1';
const queue = [];
let running = null, retryTimer = null, busy = () => false, stopped = false;
/** dvr.js anger när servern är upptagen (omkodning av inspelningar, många strömmar) – då väntar analysen */
export function setBusyCheck(fn) { busy = fn; }

export function enqueue(id) {
  if (!enabled()) return false;
  run(`INSERT INTO rec_commercials(recording_id, status, updated) VALUES(?, 'pending', ?)
    ON CONFLICT(recording_id) DO UPDATE SET status='pending', error=NULL, updated=excluded.updated`, id, now());
  if (!queue.includes(id) && running?.id !== id) queue.push(id);
  pump();
  return true;
}
function pump() {
  if (running || !queue.length || stopped) return;
  let isBusy = false;
  try { isBusy = busy(); } catch {}
  if (!enabled()) { queue.length = 0; return; } // avstängd: raderna står kvar som 'pending' tills den slås på igen
  if (isBusy) {
    if (!retryTimer) { retryTimer = setTimeout(() => { retryTimer = null; pump(); }, 30000); retryTimer.unref(); }
    return;
  }
  const id = queue.shift();
  const r = get('SELECT file, status, start, stop FROM recordings WHERE id=?', id);
  if (!r || r.status !== 'done' || !r.file?.endsWith('.mp4') || !fs.existsSync(r.file)) {
    run('DELETE FROM rec_commercials WHERE recording_id=?', id);
    return pump();
  }
  run("UPDATE rec_commercials SET status='running', updated=? WHERE recording_id=?", now(), id);
  const job = running = { id, proc: null };
  // Tidsgräns: minst 20 minuter, annars inspelningens längd (högst 3 timmar)
  const timeoutMs = Math.min(3 * 3600, Math.max(1200, (r.stop - r.start) || 0)) * 1000;
  analyzeFile(r.file, { timeoutMs, onSpawn: (p) => { job.proc = p; } })
    .then((res) => {
      if (stopped) return;
      run("UPDATE rec_commercials SET status='done', segments=?, error=NULL, updated=? WHERE recording_id=?", JSON.stringify(res.segments), now(), id);
      console.log(`[dvr] reklamanalys klar för inspelning ${id}: ${res.segments.length} avbrott`);
    })
    .catch((e) => {
      if (stopped) return; // görs om vid nästa start
      run("UPDATE rec_commercials SET status='failed', error=?, updated=? WHERE recording_id=?", String(e.message).slice(0, 300), now(), id);
    })
    .finally(() => { if (running === job) running = null; pump(); });
}
/** Inspelningen togs bort: avbryt och glöm analysen */
export function forget(id) {
  const i = queue.indexOf(id); if (i >= 0) queue.splice(i, 1);
  if (running?.id === id) try { running.proc?.kill('SIGKILL'); } catch {}
  run('DELETE FROM rec_commercials WHERE recording_id=?', id);
}
/** Vid start (och när analysen slås på): avbrutna och väntande analyser läggs i kön igen, liksom klara inspelningar
 *  som aldrig analyserats */
export function resume() {
  stopped = false;
  if (!enabled()) return;
  for (const r of all("SELECT recording_id AS id FROM rec_commercials WHERE status IN ('pending','running') ORDER BY recording_id")) enqueue(r.id);
  for (const r of all("SELECT id FROM recordings WHERE status='done' AND file LIKE '%.mp4' AND id NOT IN (SELECT recording_id FROM rec_commercials) ORDER BY id DESC LIMIT 200")) enqueue(r.id);
}
export function stop() {
  stopped = true;
  if (running) try { running.proc?.kill('SIGKILL'); } catch {}
}
/** För API:t: segment och status per inspelning */
export function infoFor(ids) {
  const m = new Map();
  if (!ids.length) return m;
  for (const r of all(`SELECT recording_id, status, segments FROM rec_commercials WHERE recording_id IN (${ids.map(() => '?').join(',')})`, ...ids)) {
    let seg = [];
    try { seg = JSON.parse(r.segments || '[]'); } catch {}
    m.set(r.recording_id, { status: r.status, segments: Array.isArray(seg) ? seg : [] });
  }
  return m;
}
