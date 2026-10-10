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

// ---------- schemaläggning ----------
export function scheduleProgram(programId, user, ruleId = null) {
  const p = get('SELECT p.*, c.name AS cname FROM programs p JOIN channels c ON c.id=p.channel_id WHERE p.id=?', programId);
  if (!p) throw new Error('Programmet finns inte');
  if (p.stop < now()) throw new Error('Programmet har redan sänts');
  const ex = get("SELECT id FROM recordings WHERE channel_id=? AND start=? AND status IN ('scheduled','recording','processing','done')", p.channel_id, p.start);
  if (ex) return ex.id;
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
/** Serieinspelning: schemalägg alla kommande sändningar som matchar regeln (utan dubbletter) */
export function applyRules() {
  for (const r of all('SELECT * FROM dvr_rules')) {
    const progs = all(`SELECT * FROM programs WHERE title = ? COLLATE NOCASE AND start > ? ${r.channel_id ? 'AND channel_id=?' : ''} ORDER BY start`,
      ...[r.title, now() - 60, ...(r.channel_id ? [r.channel_id] : [])]);
    for (const p of progs) {
      if (r.new_only) {
        // Hoppa över repriser: samma avsnitt (säsong/avsnitt eller undertitel) redan inspelat eller schemalagt
        const dup = p.season != null && p.episode != null
          ? get("SELECT 1 FROM recordings WHERE title=? COLLATE NOCASE AND season=? AND episode=? AND status NOT IN ('failed','cancelled')", p.title, p.season, p.episode)
          : p.subtitle ? get("SELECT 1 FROM recordings WHERE title=? COLLATE NOCASE AND subtitle=? COLLATE NOCASE AND status NOT IN ('failed','cancelled')", p.title, p.subtitle) : null;
        if (dup) continue;
      }
      try { scheduleProgram(p.id, { id: r.created_by }, r.id); } catch {}
    }
  }
}

// ---------- inspelning ----------
const active = new Map(); // recordingId → { proc, tunerKey }
function startRecording(rec) {
  const ch = get('SELECT * FROM channels WHERE id=?', rec.channel_id);
  if (!ch) { run("UPDATE recordings SET status='failed', error='Kanalen finns inte längre' WHERE id=?", rec.id); return; }
  const key = `rec-${rec.id}`;
  if (!acquireTuner(ch.tuner_id, key)) {
    run("UPDATE recordings SET status='failed', error='Ingen ledig tuner' WHERE id=?", rec.id);
    notify('dvr', 'Inspelning misslyckades', `${rec.title}: ingen ledig tuner.`, { priority: 4 });
    return;
  }
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
  let err = '';
  proc.stderr.on('data', x => { err = (err + x).slice(-800); });
  active.set(rec.id, { proc, key, tuner: ch.tuner_id });
  run("UPDATE recordings SET status='recording', file=?, error=NULL WHERE id=?", ts, rec.id);
  console.log('[dvr] spelar in', rec.title, '→', ts);
  proc.on('close', (code) => {
    active.delete(rec.id);
    releaseTuner(ch.tuner_id, key);
    const r = get('SELECT status FROM recordings WHERE id=?', rec.id);
    if (r?.status === 'cancelled') return;
    const size = fs.existsSync(ts) ? fs.statSync(ts).size : 0;
    if (size < 100e3) {
      run("UPDATE recordings SET status='failed', error=? WHERE id=?", (err.trim().split('\n').pop() || `ffmpeg avslutades (${code})`).slice(0, 300), rec.id);
      notify('dvr', 'Inspelning misslyckades', `${rec.title}: ${err.trim().split('\n').pop() || 'tom fil'}`, { priority: 4 });
      return;
    }
    run("UPDATE recordings SET status='processing', size=? WHERE id=?", size, rec.id);
    postProcess(rec.id, ts);
  });
}

/** MPEG-TS → MP4 (H.264/AAC, faststart) som spelas i webbläsare och appar. TS-filen tas bort efteråt (om inställt). */
let processing = Promise.resolve();
function postProcess(id, ts) {
  processing = processing.then(() => new Promise((resolve) => {
    const mp4 = ts.replace(/\.ts$/, '.mp4');
    const enc = liveEncoder({ deinterlace: true });
    const go = (copy) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', ...(copy ? [] : enc.pre), '-fflags', '+genpts', '-i', ts,
        '-map', '0:v:0', '-map', '0:a:0?', ...(copy ? ['-c:v', 'copy'] : [...enc.vf, ...enc.enc]), '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-movflags', '+faststart', mp4];
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; p.stderr.on('data', x => { err = (err + x).slice(-500); });
      p.on('close', (code) => {
        if (code !== 0 && copy) return go(false);
        if (code !== 0) { run("UPDATE recordings SET status='done', error=? WHERE id=?", 'Kunde inte göra MP4: ' + err.trim().split('\n').pop(), id); return resolve(); }
        if (getSetting('dvr_keep_ts', '0') !== '1') fs.rmSync(ts, { force: true });
        const st = fs.statSync(mp4);
        run("UPDATE recordings SET status='done', file=?, size=? WHERE id=?", mp4, st.size, id);
        const rec = get('SELECT * FROM recordings WHERE id=?', id);
        notify('dvr', 'Inspelning klar', `${rec.title}${rec.subtitle ? ' – ' + rec.subtitle : ''} (${rec.channel_name}) finns att titta på.`, { priority: 2 });
        enforceKeep(rec.rule_id);
        resolve();
      });
    };
    // H.264-källor (IPTV/DVB-T2) kopieras direkt, annars omkodning (MPEG-2 från DVB-T/kabel)
    const probe = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,field_order', '-of', 'csv=p=0', ts], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; probe.stdout.on('data', x => out += x);
    probe.on('close', () => go(/^h264,(progressive|unknown)?/.test(out.trim()) || out.trim() === 'h264'));
  }));
}
function enforceKeep(ruleId) {
  if (!ruleId) return;
  const r = get('SELECT keep FROM dvr_rules WHERE id=?', ruleId);
  if (!r?.keep) return;
  for (const old of all("SELECT * FROM recordings WHERE rule_id=? AND status='done' ORDER BY start DESC LIMIT -1 OFFSET ?", ruleId, r.keep)) removeRecording(old.id);
}
export function removeRecording(id) {
  const r = get('SELECT * FROM recordings WHERE id=?', id); if (!r) return;
  const a = active.get(id);
  if (a) { run("UPDATE recordings SET status='cancelled' WHERE id=?", id); try { a.proc.kill('SIGINT'); } catch {} }
  if (r.file) { fs.rmSync(r.file, { force: true }); fs.rmSync(r.file.replace(/\.mp4$/, '.ts'), { force: true });
    try { const dir = path.dirname(r.file); if (dir !== dvrDir() && !fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {} }
  run('DELETE FROM recordings WHERE id=?', id);
}
export function stopRecording(id) {
  const a = active.get(id);
  if (a) try { a.proc.kill('SIGINT'); } catch {} // ffmpeg avslutar filen snyggt och efterbearbetningen körs
}

/** Körs var 15:e sekund: starta inspelningar som ska börja */
function tick() {
  const { before } = pad();
  for (const rec of all("SELECT * FROM recordings WHERE status='scheduled' AND start - ? <= ?", before, now())) {
    if (rec.stop + pad().after < now()) { run("UPDATE recordings SET status='failed', error='Missades (servern var avstängd)' WHERE id=?", rec.id); continue; }
    startRecording(rec);
  }
}
setInterval(tick, 5000).unref();
setInterval(() => { try { applyRules(); } catch (e) { console.warn('[dvr] regler:', e.message); } }, 3600e3).unref();
// Avbrutna inspelningar vid omstart
for (const r of all("SELECT * FROM recordings WHERE status IN ('recording','processing')")) {
  // Det som hann spelas in innan omstarten tas till vara
  if (r.file && fs.existsSync(r.file) && fs.statSync(r.file).size > 1e6 && r.file.endsWith('.ts')) { run("UPDATE recordings SET status='processing', error='Avbröts av omstart – delvis inspelad' WHERE id=?", r.id); postProcess(r.id, r.file); }
  else run("UPDATE recordings SET status='failed', error='Avbröts av omstart' WHERE id=?", r.id);
}

// ---------- API-hjälp ----------
export const list = () => ({
  scheduled: all("SELECT * FROM recordings WHERE status IN ('scheduled','recording') ORDER BY start"),
  done: all("SELECT * FROM recordings WHERE status IN ('done','processing','failed') ORDER BY start DESC LIMIT 500"),
  rules: all('SELECT r.*, c.name AS channel_name, (SELECT COUNT(*) FROM recordings x WHERE x.rule_id=r.id AND x.status=\'scheduled\') AS upcoming FROM dvr_rules r LEFT JOIN channels c ON c.id=r.channel_id ORDER BY r.title')
});
export const removeRule = (id) => { run("DELETE FROM recordings WHERE rule_id=? AND status='scheduled'", id); run('DELETE FROM dvr_rules WHERE id=?', id); };
export const cancel = (id) => { const r = get('SELECT status FROM recordings WHERE id=?', id); if (r?.status === 'scheduled') run('DELETE FROM recordings WHERE id=?', id); else if (r?.status === 'recording') stopRecording(id); };

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
