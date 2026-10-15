// Inspelning (DVR): enstaka program och serieinspelningar från TV-guiden. Spelar in strömmen orörd (MPEG-TS)
// och gör sedan en MP4 (H.264/AAC) som kan spelas överallt. Inspelningarna sparas i /recordings.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, get, all, run, now, getSetting, CONFIG } from './db.js';
import { liveEncoder } from './stream.js';
import { acquireTuner, releaseTuner, SAFE_LIVE, httpOpts } from './livetv.js';
import { notify } from './notify.js';
import { send, fail } from './util.js';

db.exec(`CREATE TABLE IF NOT EXISTS dvr_rules(id INTEGER PRIMARY KEY, title TEXT NOT NULL, channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  new_only INTEGER NOT NULL DEFAULT 1, keep INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recordings(id INTEGER PRIMARY KEY, channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL, channel_name TEXT,
  program_id INTEGER, rule_id INTEGER REFERENCES dvr_rules(id) ON DELETE SET NULL, title TEXT NOT NULL, subtitle TEXT, description TEXT,
  season INTEGER, episode INTEGER, start INTEGER NOT NULL, stop INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
  file TEXT, size INTEGER, duration REAL, error TEXT, created_by INTEGER, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rec_start ON recordings(status, start);`);

export function dvrDir() {
  const d = getSetting('dvr_dir', process.env.DVR_DIR || (fs.existsSync('/recordings') ? '/recordings' : path.join(CONFIG, 'recordings')));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const pad = () => ({ before: Math.max(0, +getSetting('dvr_pad_before', '60')), after: Math.max(0, +getSetting('dvr_pad_after', '180')) });
const safeName = (s) => String(s || 'Inspelning').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100).trim() || 'Inspelning';

// Status: scheduled → recording → processing → done | failed. Avbokade ('cancelled') och borttagna ('deleted') rader sparas som
// "gravstenar" utan fil: de visas inte, men hindrar att serieinspelningar bokar om samma sändning eller spelar in ett borttaget avsnitt igen.
const WAIT_TUNER = 'Väntar på ledig tuner';

// ---------- schemaläggning ----------
export function scheduleProgram(programId, user, ruleId = null) {
  const p = get('SELECT p.*, c.name AS cname FROM programs p JOIN channels c ON c.id=p.channel_id WHERE p.id=?', programId);
  if (!p) throw new Error('Programmet finns inte');
  if (p.stop < now()) throw new Error('Programmet har redan sänts');
  const ex = get("SELECT id FROM recordings WHERE channel_id=? AND start=? AND status IN ('scheduled','recording','processing','done')", p.channel_id, p.start);
  if (ex) return ex.id;
  const tomb = get("SELECT id FROM recordings WHERE channel_id=? AND start=? AND status IN ('cancelled','deleted') ORDER BY id DESC", p.channel_id, p.start);
  if (tomb) {
    if (ruleId) return null; // avbokad eller borttagen – serieinspelningen ska inte boka om den
    const t = get('SELECT status FROM recordings WHERE id=?', tomb.id);
    if (t.status === 'cancelled') { // bokas igen av en användare: återanvänd raden
      run("UPDATE recordings SET status='scheduled', error=NULL, program_id=?, title=?, subtitle=?, description=?, season=?, episode=?, stop=? WHERE id=?",
        p.id, p.title, p.subtitle, p.description, p.season, p.episode, p.stop, tomb.id);
      if (p.start <= now() + 60) setImmediate(tick);
      return tomb.id;
    }
  }
  const id = Number(run(`INSERT INTO recordings(channel_id,channel_name,program_id,rule_id,title,subtitle,description,season,episode,start,stop,created_by,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, p.channel_id, p.cname, p.id, ruleId, p.title, p.subtitle, p.description, p.season, p.episode, p.start, p.stop, user?.id || null, now()).lastInsertRowid);
  if (p.start <= now() + 60) setImmediate(tick); // pågående program: börja spela in direkt
  return id;
}
export function scheduleManual({ channelId, start, stop, title }, user) {
  const c = get('SELECT * FROM channels WHERE id=?', channelId);
  if (!c) throw new Error('Kanalen finns inte');
  if (!(stop > start) || stop - start > 12 * 3600) throw new Error('Ogiltig tid (max 12 timmar)');
  const id = Number(run('INSERT INTO recordings(channel_id,channel_name,title,start,stop,created_by,created) VALUES(?,?,?,?,?,?,?)',
    c.id, c.name, safeName(title || c.name), start, stop, user?.id || null, now()).lastInsertRowid);
  setImmediate(tick); // börjar den nu startar inspelningen direkt
  return id;
}
export function addRule({ title, channelId, newOnly, keep }, user) {
  title = String(title || '').trim();
  if (!title) throw new Error('Ange en titel');
  const id = Number(run('INSERT INTO dvr_rules(title,channel_id,new_only,keep,created_by,created) VALUES(?,?,?,?,?,?)', title.slice(0, 200), channelId || null, newOnly ? 1 : 0, Math.max(0, +keep || 0), user?.id || null, now()).lastInsertRowid);
  applyRules();
  return id;
}
/** Serieinspelning: schemalägg alla kommande sändningar som matchar regeln (utan dubbletter). Bokningar från en regel som inte
 *  längre finns i guiden (t.ex. flyttad sändningstid) tas bort, så att den nya tiden kan bokas. */
export function applyRules() {
  const t = now();
  for (const r of all('SELECT * FROM dvr_rules')) {
    const progs = all(`SELECT * FROM programs WHERE title = ? COLLATE NOCASE AND start > ? ${r.channel_id ? 'AND channel_id=?' : ''} ORDER BY start`,
      ...[r.title, t - 60, ...(r.channel_id ? [r.channel_id] : [])]);
    const slots = new Set(progs.map(p => `${p.channel_id}:${p.start}`));
    for (const x of all("SELECT id, channel_id, start FROM recordings WHERE rule_id=? AND status='scheduled' AND start > ?", r.id, t + pad().before))
      if (!slots.has(`${x.channel_id}:${x.start}`)) run("DELETE FROM recordings WHERE id=? AND status='scheduled'", x.id);
    for (const p of progs) {
      if (r.new_only) {
        // Hoppa över repriser: samma avsnitt (säsong/avsnitt eller undertitel) redan inspelat, schemalagt eller inspelat och borttaget
        const dup = p.season != null && p.episode != null
          ? get("SELECT 1 FROM recordings WHERE title=? COLLATE NOCASE AND season=? AND episode=? AND status NOT IN ('failed','cancelled') AND NOT (channel_id=? AND start=?)", p.title, p.season, p.episode, p.channel_id, p.start)
          : p.subtitle ? get("SELECT 1 FROM recordings WHERE title=? COLLATE NOCASE AND subtitle=? COLLATE NOCASE AND status NOT IN ('failed','cancelled') AND NOT (channel_id=? AND start=?)", p.title, p.subtitle, p.channel_id, p.start) : null;
        if (dup) continue;
      }
      try { scheduleProgram(p.id, { id: r.created_by }, r.id); } catch {}
    }
  }
}

/** Tunerkrockar: för varje källa, hur många inspelningar som som mest pågår samtidigt inom [start, stop] (med marginaler)
 *  jämfört med antalet tuners. channelId begränsar till kanalens källa; excludeId räknas inte med. */
export function conflicts(start, stop, { channelId = null, excludeId = null } = {}) {
  const { before, after } = pad();
  const tunerOf = channelId ? get('SELECT tuner_id FROM channels WHERE id=?', channelId)?.tuner_id : null;
  if (channelId && !tunerOf) return [];
  const recs = all(`SELECT r.id, r.title, r.channel_name, r.start, r.stop, c.tuner_id FROM recordings r JOIN channels c ON c.id=r.channel_id
    WHERE r.status IN ('scheduled','recording') AND r.start - ? < ? AND r.stop + ? > ? ${tunerOf ? 'AND c.tuner_id=?' : ''} ${excludeId ? 'AND r.id != ?' : ''} ORDER BY r.start`,
    ...[before, stop + after, after, start - before, ...(tunerOf ? [tunerOf] : []), ...(excludeId ? [excludeId] : [])]);
  const by = new Map();
  for (const r of recs) { if (!by.has(r.tuner_id)) by.set(r.tuner_id, []); by.get(r.tuner_id).push(r); }
  if (tunerOf && !by.has(tunerOf)) by.set(tunerOf, []);
  return [...by].map(([tunerId, list]) => {
    const t = get('SELECT name, tuner_count FROM tuners WHERE id=?', tunerId);
    // Största antal samtidiga (svep över start/slut), plus den nya bokningen själv när en kanal anges
    const ev = list.flatMap(r => [[r.start - before, 1], [r.stop + after, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, peak = 0; for (const [, d] of ev) { cur += d; peak = Math.max(peak, cur); }
    const tuners = t?.tuner_count || 2;
    return { tunerId, tunerName: t?.name || null, tuners, peak, recordings: list.map(({ tuner_id, ...r }) => r), conflict: channelId ? peak >= tuners : peak > tuners };
  });
}

// ---------- inspelning ----------
const active = new Map(); // recordingId → { proc, key, tuner }
const converting = new Map(); // recordingId → pågående ffprobe/ffmpeg i efterbearbetningen
let shuttingDown = false;
const lastLine = (s, def) => s.trim().split('\n').pop() || def;
function startRecording(rec) {
  let ch = null, key = null, acquired = false;
  try {
    ch = get('SELECT * FROM channels WHERE id=?', rec.channel_id);
    if (!ch) { run("UPDATE recordings SET status='failed', error='Kanalen finns inte längre' WHERE id=?", rec.id); return; }
    key = `rec-${rec.id}`;
    if (!acquireTuner(ch.tuner_id, key)) {
      // Ingen ledig tuner just nu: vänta kvar som schemalagd och försök igen vid nästa kontroll (tills programmet är slut)
      if (rec.error !== WAIT_TUNER) run("UPDATE recordings SET error=? WHERE id=? AND status='scheduled'", WAIT_TUNER, rec.id);
      return;
    }
    acquired = true;
    const d = new Date(rec.start * 1000);
    const dir = path.join(dvrDir(), safeName(rec.title));
    fs.mkdirSync(dir, { recursive: true });
    const se = rec.season != null && rec.episode != null ? ` S${String(rec.season).padStart(2, '0')}E${String(rec.episode).padStart(2, '0')}` : '';
    const base = `${safeName(rec.title)}${se} ${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const ts = path.join(dir, base + '.ts');
    const until = rec.stop + pad().after;
    const dur = Math.max(10, until - now());
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_LIVE, ...httpOpts(ch.stream_url), '-fflags', '+genpts+discardcorrupt',
      '-i', ch.stream_url, '-map', '0:v:0?', '-map', '0:a?', '-map', '0:s?', '-c', 'copy', '-t', String(dur), '-f', 'mpegts', ts], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '', ended = false;
    proc.stderr.on('data', x => { err = (err + x).slice(-800); });
    active.set(rec.id, { proc, key, tuner: ch.tuner_id });
    run("UPDATE recordings SET status='recording', file=?, error=NULL WHERE id=?", ts, rec.id);
    console.log('[dvr] spelar in', rec.title, '→', ts);
    const tunerId = ch.tuner_id;
    const finish = (code, spawnErr) => {
      if (ended) return; ended = true;
      active.delete(rec.id);
      releaseTuner(tunerId, key);
      try {
        const r = get('SELECT status FROM recordings WHERE id=?', rec.id);
        if (!r || r.status === 'deleted') { fs.rmSync(ts, { force: true }); return; } // borttagen under inspelningen – ingen notis
        if (r.status === 'cancelled') return;
        if (shuttingDown) return; // servern stängs: den delvisa filen tas om hand vid nästa start
        const size = fs.existsSync(ts) ? fs.statSync(ts).size : 0;
        if (size < 100e3) {
          const why = spawnErr ? 'ffmpeg kunde inte startas: ' + spawnErr.message : lastLine(err, `ffmpeg avslutades (${code})`);
          run("UPDATE recordings SET status='failed', error=? WHERE id=?", why.slice(0, 300), rec.id);
          notify('dvr', 'Inspelning misslyckades', `${rec.title}: ${spawnErr ? why : lastLine(err, 'tom fil')}`, { priority: 4 });
          return;
        }
        run("UPDATE recordings SET status='processing', size=? WHERE id=?", size, rec.id);
        postProcess(rec.id, ts);
      } catch (e) { console.warn('[dvr] efter inspelning:', e.message); }
    };
    proc.on('error', (e) => finish(null, e));
    proc.on('close', (code) => finish(code));
  } catch (e) {
    console.warn('[dvr] kunde inte starta inspelning:', e.message);
    const a = active.get(rec.id);
    if (a) { active.delete(rec.id); try { a.proc.kill('SIGKILL'); } catch {} }
    if (acquired) releaseTuner(ch.tuner_id, key);
    try { run("UPDATE recordings SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 300), rec.id); } catch {}
  }
}

/** MPEG-TS → MP4 (H.264/AAC, faststart) som spelas i webbläsare och appar. TS-filen tas bort efteråt (om inställt). */
let processing = Promise.resolve();
const recStatus = (id) => get('SELECT status FROM recordings WHERE id=?', id)?.status;
function postProcess(id, ts) {
  processing = processing.then(() => new Promise((resolve) => {
    const mp4 = ts.replace(/\.ts$/, '.mp4');
    // Borttagen medan den väntade i kön
    if (!['processing', 'recording'].includes(recStatus(id))) { fs.rmSync(ts, { force: true }); return resolve(); }
    const gone = () => { const st = recStatus(id); return !st || st === 'deleted' || st === 'cancelled'; };
    const cleanup = () => { fs.rmSync(mp4, { force: true }); fs.rmSync(ts, { force: true }); };
    const enc = liveEncoder({ deinterlace: true });
    const go = (copy) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', ...(copy ? [] : enc.pre), '-fflags', '+genpts', '-i', ts,
        '-map', '0:v:0', '-map', '0:a:0?', ...(copy ? ['-c:v', 'copy'] : [...enc.vf, ...enc.enc]), '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-movflags', '+faststart', mp4];
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      converting.set(id, p);
      let err = '', ended = false; p.stderr.on('data', x => { err = (err + x).slice(-500); });
      const done = (code, spawnErr) => {
        if (ended) return; ended = true;
        converting.delete(id);
        let retry = false;
        try {
          if (gone()) { cleanup(); return; } // borttagen under konverteringen
          if (shuttingDown) return; // görs om vid nästa start
          if (code !== 0 && copy && !spawnErr) { retry = true; return go(false); }
          if (code !== 0) { run("UPDATE recordings SET status='done', error=? WHERE id=?", 'Kunde inte göra MP4: ' + (spawnErr ? spawnErr.message : lastLine(err, '')), id); return; }
          if (getSetting('dvr_keep_ts', '0') !== '1') fs.rmSync(ts, { force: true });
          const st = fs.statSync(mp4);
          run("UPDATE recordings SET status='done', file=?, size=? WHERE id=?", mp4, st.size, id);
          const rec = get('SELECT * FROM recordings WHERE id=?', id);
          notify('dvr', 'Inspelning klar', `${rec.title}${rec.subtitle ? ' – ' + rec.subtitle : ''} (${rec.channel_name}) finns att titta på.`, { priority: 2 });
          enforceKeep(rec.rule_id);
        } catch (e) { retry = false; console.warn('[dvr] efterbearbetning:', e.message); }
        finally { if (!retry) resolve(); }
      };
      p.on('error', (e) => done(null, e));
      p.on('close', (code) => done(code));
    };
    // H.264-källor (IPTV/DVB-T2) kopieras direkt, annars omkodning (MPEG-2 från DVB-T/kabel)
    try {
      const probe = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,field_order', '-of', 'csv=p=0', ts], { stdio: ['ignore', 'pipe', 'ignore'] });
      converting.set(id, probe);
      let out = '', ended = false; probe.stdout.on('data', x => out += x);
      const next = () => {
        if (ended) return; ended = true;
        converting.delete(id);
        try {
          if (gone()) { cleanup(); return resolve(); }
          if (shuttingDown) return resolve();
          go(/^h264,(progressive|unknown)?/.test(out.trim()) || out.trim() === 'h264');
        } catch (e) { console.warn('[dvr] efterbearbetning:', e.message); resolve(); }
      };
      probe.on('error', next);
      probe.on('close', next);
    } catch (e) { console.warn('[dvr] efterbearbetning:', e.message); resolve(); }
  })).catch((e) => console.warn('[dvr] efterbearbetning:', e.message)); // kedjan får aldrig fastna
}
function enforceKeep(ruleId) {
  if (!ruleId) return;
  const r = get('SELECT keep FROM dvr_rules WHERE id=?', ruleId);
  if (!r?.keep) return;
  for (const old of all("SELECT * FROM recordings WHERE rule_id=? AND status='done' ORDER BY start DESC LIMIT -1 OFFSET ?", ruleId, r.keep)) removeRecording(old.id);
}
/** Ta bort en inspelning: filerna tas bort och raden blir en gravsten ('deleted') så att avsnittet inte spelas in igen. */
export function removeRecording(id) {
  const r = get('SELECT * FROM recordings WHERE id=?', id); if (!r) return;
  if (r.status === 'scheduled') return cancel(id);
  if (r.status === 'cancelled' || r.status === 'deleted') return;
  if (r.status === 'failed') { run('DELETE FROM recordings WHERE id=?', id); return; } // inget spelades in – inget att komma ihåg
  // Markera först, så att avslutande processer ser att den är borttagen (ingen felnotis, ingen efterbearbetning)
  run("UPDATE recordings SET status='deleted', file=NULL, size=NULL, error=NULL WHERE id=?", id);
  const a = active.get(id);
  if (a) try { a.proc.kill('SIGINT'); } catch {}
  const c = converting.get(id);
  if (c) try { c.kill('SIGKILL'); } catch {}
  if (r.file) {
    const ts = r.file.replace(/\.mp4$/, '.ts');
    for (const f of new Set([r.file, ts, ts.replace(/\.ts$/, '.mp4')])) fs.rmSync(f, { force: true });
    try { const dir = path.dirname(r.file); if (dir !== dvrDir() && !fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {}
  }
}
export function stopRecording(id) {
  const a = active.get(id);
  if (a) try { a.proc.kill('SIGINT'); } catch {} // ffmpeg avslutar filen snyggt och efterbearbetningen körs
}

/** Körs var 5:e sekund: starta inspelningar som ska börja */
function tick() {
  try {
    const { before } = pad();
    for (const rec of all("SELECT * FROM recordings WHERE status='scheduled' AND start - ? <= ?", before, now())) {
      try {
        if (rec.stop <= now()) {
          const noTuner = rec.error === WAIT_TUNER;
          run("UPDATE recordings SET status='failed', error=? WHERE id=?", noTuner ? 'Ingen ledig tuner' : 'Missades (servern var avstängd)', rec.id);
          if (noTuner) notify('dvr', 'Inspelning misslyckades', `${rec.title}: ingen ledig tuner.`, { priority: 4 });
          continue;
        }
        if (!active.has(rec.id)) startRecording(rec);
      } catch (e) { console.warn('[dvr] inspelning', rec.id, e.message); }
    }
    // Gamla gravstenar: avbokningar behövs bara tills sändningen är över, borttagna utan avsnittsinfo hindrar inga dubbletter
    run("DELETE FROM recordings WHERE (status='cancelled' AND stop < ?) OR (status='deleted' AND stop < ? AND season IS NULL AND subtitle IS NULL)", now() - 86400, now() - 86400);
  } catch (e) { console.warn('[dvr] tick:', e.message); }
}
setInterval(tick, 5000).unref();
setInterval(() => { try { applyRules(); } catch (e) { console.warn('[dvr] regler:', e.message); } }, 3600e3).unref();
// Avbrutna inspelningar vid omstart
for (const r of all("SELECT * FROM recordings WHERE status IN ('recording','processing')")) {
  // Det som hann spelas in innan omstarten tas till vara
  if (r.file && fs.existsSync(r.file) && fs.statSync(r.file).size > 1e6 && r.file.endsWith('.ts')) { run("UPDATE recordings SET status='processing', error='Avbröts av omstart – delvis inspelad' WHERE id=?", r.id); postProcess(r.id, r.file); }
  else run("UPDATE recordings SET status='failed', error='Avbröts av omstart' WHERE id=?", r.id);
}

/** Vid avstängning: be ffmpeg avsluta inspelningarna snyggt (SIGINT skriver klart .ts-filen) och avbryt konverteringar.
 *  Inspelningarna efterbearbetas vid nästa start. Väntar högst timeoutMs. */
export async function shutdown(timeoutMs = 5000) {
  shuttingDown = true;
  const procs = [...active.values()].map(a => a.proc);
  for (const p of procs) try { p.kill('SIGINT'); } catch {}
  for (const p of converting.values()) try { p.kill('SIGKILL'); } catch {}
  await Promise.race([
    Promise.all(procs.map(p => p.exitCode != null || p.signalCode != null ? null : new Promise(r => p.once('close', r)))),
    new Promise(r => setTimeout(r, timeoutMs).unref())
  ]);
  for (const p of procs) if (p.exitCode == null && p.signalCode == null) try { p.kill('SIGKILL'); } catch {}
}

// ---------- API-hjälp ----------
export const list = () => ({
  scheduled: all("SELECT * FROM recordings WHERE status IN ('scheduled','recording') ORDER BY start"),
  done: all("SELECT * FROM recordings WHERE status IN ('done','processing','failed') ORDER BY start DESC LIMIT 500"),
  rules: all('SELECT r.*, c.name AS channel_name, (SELECT COUNT(*) FROM recordings x WHERE x.rule_id=r.id AND x.status=\'scheduled\') AS upcoming FROM dvr_rules r LEFT JOIN channels c ON c.id=r.channel_id ORDER BY r.title')
});
export const removeRule = (id) => { run("DELETE FROM recordings WHERE rule_id=? AND status IN ('scheduled','cancelled')", id); run('DELETE FROM dvr_rules WHERE id=?', id); };
/** Avboka: en schemalagd blir en gravsten (bokas inte om av serieinspelningen), en pågående stoppas och sparas. */
export const cancel = (id) => {
  const r = get('SELECT status FROM recordings WHERE id=?', id);
  if (r?.status === 'scheduled') run("UPDATE recordings SET status='cancelled', error=NULL WHERE id=? AND status='scheduled'", id);
  else if (r?.status === 'recording') stopRecording(id);
};

export function serveRecording(req, res, id) {
  const r = get('SELECT * FROM recordings WHERE id=?', id);
  if (!r?.file || !fs.existsSync(r.file) || !r.file.endsWith('.mp4')) return fail(res, 404, 'Inspelningen är inte klar');
  const st = fs.statSync(r.file);
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1, code = 200;
  if (m) { start = m[1] === '' ? Math.max(0, st.size - +m[2]) : +m[1]; if (m[1] !== '' && m[2] !== '') end = Math.min(+m[2], end); code = 206; }
  if (start > end) return send(res, 416, '', { 'Content-Range': `bytes */${st.size}` });
  const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
  if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(code, h);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(r.file, { start, end }).pipe(res);
}
