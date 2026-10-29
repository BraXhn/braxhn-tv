// Ögonblick: klipp ur filmer och avsnitt som hushållet sparar och delar (flödet #/moments i webben).
//
// Ett ögonblick är en egen MP4-fil (H.264/AAC) i /config/moments/<id>.mp4 med miniatyr <id>.jpg. Klippet görs i
// bakgrunden med ffmpeg, ett jobb i taget (MOMENTS_JOBS) och med lägsta prioritet (lowPriority):
//   - copy:   bilden kopieras (stream copy) när källan är H.264 i 8 bitar utan HDR/fläta, ingen undertext eller
//             vattenstämpel ska brännas in och det finns en nyckelbild högst COPY_TOL s före start (klippet börjar då
//             på nyckelbilden). Ljudet kodas alltid om till AAC (billigt, och spelbart överallt).
//   - encode: annars snabb omkodning till H.264 (veryfast, högst 720 rader) – exakt start och längd.
// Inbränd undertext och vattenstämpel (titeln) ritas med libass ur en ASS-fil som skrivs bredvid (<id>.ass).
//
// Familjefiltret: har skaparen påtvingat filter (barnprofil) tystas svordomarna i själva klippet och den inbrända
// undertexten maskeras (***). Annars görs, när klippet innehåller tysta intervall, en tystad variant <id>.ff.mp4
// (bilden kopieras ur klippet) som profiler med filtret på får. Inbränd undertext med svordomar som inte maskerats
// (burn_prof) kan inte tystas i efterhand – sådana klipp visas inte alls för profiler med påtvingat filter.
//
// Delning utanför hemmet: en länk /api/share/<id>.<utgång>.<HMAC> (nyckeln moments_share_key i inställningarna).
// Länken gäller bara routes med alternativet share i http/router.js (klippet, miniatyren och sidan med Open Graph),
// till utgångstiden och så länge raden i moment_shares inte är återkallad. Den är ingen inloggning.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { all, get, run, now, CONFIG, getSetting, setSetting } from './db.js';
import { SAFE_IN, streamsOf, subtitlesOf, subtitleVtt } from './stream.js';
import { lowPriority } from './util.js';
import { cuesOf } from './sublines.js';
import { adjustment } from './subsync.js';
import { sourceOf } from './vocab.js';
import * as family from './familyfilter.js';
import * as jobs from './jobs.js';

export const DIR = path.join(CONFIG, 'moments');
const envNum = (k, def, lo, hi) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? Math.max(lo, Math.min(hi, v)) : def; };
export const MAX_LEN = envNum('MOMENTS_MAX_SECONDS', 180, 5, 600);   // längsta klipp (sekunder)
export const MIN_LEN = 1;
export const maxBytes = () => envNum('MOMENTS_MAX_MB', 2048, 10, 1e6) * 1048576; // lagringsgräns för alla ögonblick
const MAX_JOBS = envNum('MOMENTS_JOBS', 1, 1, 4);                     // samtidiga ffmpeg-jobb
const MAX_QUEUE = 8;                                                  // väntande jobb (fler → 429)
export const MAX_PER_PROFILE = 200;
const COPY_TOL = 0.5;          // stream copy bara om nyckelbilden ligger högst så här långt före start
const COPY_MAX_BYTES = 250 << 20; // större uppskattat klipp → omkodning (4K-remux blir annars enormt)
export const EMOJI = ['❤️', '😂', '😮', '👍', '😢', '🔥'];
export const SHARE_HOURS = [1, 24, 168, 720];
const MAX_TITLE = 80, MAX_COMMENT = 500, MAX_COMMENTS = 300;
export const STATE = ['pending', 'ready', 'failed'];

const err = (status, message) => Object.assign(new Error(message), { status });
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export const fileOf = (id, kind = 'mp4') => path.join(DIR, `${+id}.${kind}`);
const rootOf = (u) => u.parent_id || u.id;

// ---------------- tider och nyckelbilder ----------------
const maxText = () => MAX_LEN === 60 ? 'en minut' : MAX_LEN % 60 === 0 ? `${MAX_LEN / 60} minuter` : `${MAX_LEN} sekunder`;
/** Läser och kontrollerar klientens start/slut. Ger { s, e } eller kastar ett fel för användaren. */
export function parseRange(b, duration) {
  const s = Number(b?.start), e = Number(b?.end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0) throw err(400, 'Ogiltig start eller slut');
  const end = duration > 0 ? Math.min(e, duration) : e;
  if (end - s < MIN_LEN) throw err(400, 'Ögonblicket måste vara minst en sekund');
  if (end - s > MAX_LEN + 0.001) throw err(400, `Ett ögonblick kan vara högst ${maxText()}`);
  return { s: Math.round(s * 1000) / 1000, e: Math.round(end * 1000) / 1000 };
}
/** Nyckelbilderna nära start (ffprobe läser bara ett fönster). Tiderna är relativa filens starttid (som ffmpeg -ss). */
export function keyframesNear(file, t) {
  return new Promise((ok) => {
    const from = Math.max(0, t - 4);
    execFile('ffprobe', ['-v', 'error', ...SAFE_IN, '-select_streams', 'v:0', '-show_entries', 'format=start_time:packet=pts_time,flags',
      '-read_intervals', `${from.toFixed(3)}%+${(t - from + 1).toFixed(3)}`, '-of', 'json', file], { timeout: 30000, maxBuffer: 16 << 20 }, (e, out) => {
      if (e) return ok([]);
      try {
        const j = JSON.parse(out);
        const st = parseFloat(j.format?.start_time) || 0;
        ok((j.packets || []).filter(p => p.flags?.[0] === 'K' && p.pts_time != null).map(p => parseFloat(p.pts_time) - st).filter(Number.isFinite).sort((a, b) => a - b));
      } catch { ok([]); }
    });
  });
}
/** Kan bilden kopieras? Ger nyckelbildens tid (klippets start) eller null. */
export async function copyStart(it, r, o) {
  const v = streamsOf(it).find(s => s.type === 'video');
  if (o.sub || o.watermark || !v || v.codec !== 'h264' || !/^yuvj?420p$/.test(v.pix || 'yuv420p') || it.hdr || /^(tt|bb|tb|bt)$/.test(v.field || '')) return null;
  if (it.size && it.duration && it.size / it.duration * (r.e - r.s) > COPY_MAX_BYTES) return null;
  const kf = (await keyframesNear(it.path, r.s)).filter(k => k <= r.s + 0.05 && k >= r.s - COPY_TOL);
  // (upp till 50 ms efter start räknas som start: filens starttid kan vara negativ, t.ex. AAC:s inledande ram i MKV)
  return kf.length ? Math.max(0, kf[kf.length - 1]) : null;
}

// ---------------- ASS (inbränd undertext och vattenstämpel) ----------------
const assTime = (t) => { t = Math.max(0, t); const cs = Math.round(t * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
const assText = (s) => String(s).replace(/\\/g, '＼').replace(/[{}]/g, (c) => c === '{' ? '（' : '）').replace(/\r?\n/g, '\\N');
/** ASS-filen: cues [{ s, e, text }] relativt klippets start, mark = vattenstämpelns text (eller ''), dur = klippets längd */
export function assFile(cues, mark, dur) {
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,DejaVu Sans,46,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2.5,1,2,60,60,40,1
Style: Mark,DejaVu Sans,22,&H50FFFFFF,&H50FFFFFF,&H90000000,&H00000000,1,0,0,0,100,100,0,0,1,1.2,0,9,24,24,18,1

[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const ev = cues.map(c => `Dialogue: 0,${assTime(c.s)},${assTime(c.e)},Sub,,0,0,0,,${assText(c.text)}`);
  if (mark) ev.push(`Dialogue: 1,${assTime(0)},${assTime(dur + 1)},Mark,,0,0,0,,${assText(mark)}`);
  return head + ev.join('\n') + '\n';
}
/** Undertextens repliker inom klippet, med undertextsynken och ev. maskning, relativt klippets start */
async function burnCues(it, sub, r, mask) {
  const vtt = await subtitleVtt(it, sub, {});
  const adj = adjustment(it, sub), ratio = adj?.ratio || 1, off = adj?.offset || 0;
  const out = []; let prof = false;
  for (const c of cuesOf(vtt)) {
    const s = c.s * ratio + off, e = c.e * ratio + off;
    if (e <= r.s || s >= r.e) continue;
    if (family.hasProfanity(c.text, family.langOf(sub.lang))) prof = true;
    out.push({ s: Math.max(0, s - r.s), e: Math.min(r.e, e) - r.s, text: mask ? family.maskText(c.text, family.langOf(sub.lang)) : c.text });
  }
  return { cues: out, prof: prof && !mask };
}

// ---------------- ffmpeg ----------------
function ffmpeg(args, { cwd, timeout = 15 * 60e3, label = '' } = {}) {
  return new Promise((ok, no) => {
    const p = lowPriority(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] }));
    let e = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stderr.on('data', (c) => { if (e.length < 4000) e += c; });
    p.on('error', (x) => { clearTimeout(timer); no(x); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? ok() : no(new Error((label ? label + ': ' : '') + (e.trim().split('\n').pop() || 'ffmpeg avbröts'))); });
  });
}
const probe = (file) => new Promise((ok) => execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { timeout: 30000 }, (e, out) => {
  try { const j = JSON.parse(out); const v = j.streams.find(s => s.codec_type === 'video'); ok({ dur: parseFloat(j.format.duration) || 0, width: v?.width || null, height: v?.height || null }); } catch { ok(null); }
}));
/** Volymfilter som tystar intervallen [[a, b]] (relativt klippet) */
const muteAf = (list) => family.muteFilters(list, 0);
const audioArgs = (m, it, mute) => {
  const a = streamsOf(it).filter(s => s.type === 'audio');
  if (!a.length) return ['-an'];
  const sel = m.audio != null && a.some(s => s.index === m.audio) ? `0:${m.audio}` : '0:a:0';
  const af = mute?.length ? ['-af', [...muteAf(mute), 'aresample=async=1'].join(',')] : [];
  return ['-map', sel, ...af, '-c:a', 'aac', '-b:a', '160k', '-ac', '2'];
};

/** Gör klippet för raden m (state 0). Kastar vid fel. */
export async function make(m) {
  const it = get('SELECT * FROM items WHERE id=? AND path IS NOT NULL', m.item_id);
  if (!it) throw new Error('Titeln finns inte längre');
  fs.mkdirSync(DIR, { recursive: true });
  const r = { s: m.s, e: m.e };
  const creator = get('SELECT id, max_age, family_filter FROM users WHERE id=?', m.user_id);
  const enforced = family.enforced(creator);
  const filterOn = family.modeFor(creator) !== 'off';
  const aLang = streamsOf(it).find(s => s.type === 'audio' && (m.audio == null || s.index === m.audio))?.lang || null;
  const sub = m.sub ? subtitlesOf(it).find(s => s.id === m.sub && !s.bitmap) : null;
  if (m.sub && !sub) throw new Error('Undertexten finns inte längre');
  const kf = await copyStart(it, r, { sub: m.sub, watermark: m.watermark });
  const start = kf ?? r.s, dur = r.e - start;
  // Tysta intervall inom klippet (relativt klippets start)
  const mute = family.muteIntervals(it, aLang).filter(([a, b]) => b > start && a < r.e).map(([a, b]) => [Math.max(0, a - start), Math.min(dur, b - start)]);
  const out = fileOf(m.id) + '.tmp', ass = fileOf(m.id, 'ass');
  let burnProf = false;
  const vf = [];
  try {
    if (kf == null) {
      if (sub || m.watermark) {
        const b = sub ? await burnCues(it, sub, { s: start, e: r.e }, filterOn) : { cues: [], prof: false };
        burnProf = b.prof;
        fs.writeFileSync(ass, assFile(b.cues, m.watermark ? `${m.title} · ${m.source}` : '', dur));
      }
      const v = streamsOf(it).find(s => s.type === 'video');
      if (it.hdr) vf.push('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv');
      if (/^(tt|bb|tb|bt)$/.test(v?.field || '')) vf.push('yadif=mode=0:deint=interlaced');
      if ((v?.height || 0) > 720) vf.push('scale=-2:720');
      if (sub || m.watermark) vf.push(`subtitles=${path.basename(ass)}`);
      vf.push('format=yuv420p');
    }
    const video = kf != null ? ['-map', '0:v:0', '-c:v', 'copy']
      : ['-map', '0:v:0', '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-threads', '2',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
    // Exakt start: -ss före -i med omkodning är bildexakt; med kopierad bild börjar klippet på nyckelbilden (start = kf).
    // ss avrundas uppåt till hela ms så att sökningen aldrig landar strax före nyckelbilden (då togs föregående GOP).
    const ss = kf != null ? Math.ceil(start * 1000) / 1000 : start;
    await ffmpeg([...SAFE_IN, '-ss', ss.toFixed(3), '-i', it.path, '-t', dur.toFixed(3), ...video, ...audioArgs(m, it, enforced ? mute : null),
      '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-f', 'mp4', out], { cwd: DIR, label: 'klippet' });
    fs.renameSync(out, fileOf(m.id));
    // Tystad variant för profiler med familjefiltret (bilden kopieras ur klippet)
    let ffSize = 0;
    if (!enforced && mute.length) {
      const ffo = fileOf(m.id, 'ff.mp4');
      await ffmpeg(['-i', fileOf(m.id), '-map', '0:v:0', '-c:v', 'copy', '-map', '0:a:0?', '-af', muteAf(mute).join(','), '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart', '-f', 'mp4', ffo + '.tmp'], { cwd: DIR, label: 'tystade varianten' });
      fs.renameSync(ffo + '.tmp', ffo); ffSize = fs.statSync(ffo).size;
    }
    const info = await probe(fileOf(m.id));
    await ffmpeg(['-ss', Math.min(dur / 2, 2).toFixed(2), '-i', fileOf(m.id), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', '-f', 'image2', fileOf(m.id, 'jpg')], { cwd: DIR, label: 'miniatyren' })
      .catch(e => console.warn('[ögonblick]', e.message));
    const size = fs.statSync(fileOf(m.id)).size;
    run('UPDATE moments SET state=1, mode=?, s=?, size=?, ff_size=?, dur=?, width=?, height=?, mute=?, muted=?, burn_prof=?, error=NULL WHERE id=?',
      kf != null ? 'copy' : 'encode', start, size, ffSize, info?.dur || dur, info?.width, info?.height, JSON.stringify(mute), enforced ? 1 : 0, burnProf ? 1 : 0, m.id);
  } finally {
    fs.rmSync(out, { force: true }); fs.rmSync(ass, { force: true }); fs.rmSync(fileOf(m.id, 'ff.mp4') + '.tmp', { force: true });
  }
}

// ---------------- kön ----------------
const queue = [];
let active = 0;
export const queued = () => queue.length + active;
/** Lägg raden i kön. Kastar 429 när kön är full. */
export function enqueue(id) {
  if (queue.length >= MAX_QUEUE) throw err(429, 'Många ögonblick görs redan – försök igen om en stund');
  queue.push(id);
  setImmediate(pump);
}
let idleWaiters = [];
/** Väntar tills kön är tom (tester) */
export const drain = () => queued() ? new Promise(r => idleWaiters.push(r)) : Promise.resolve();
function pump() {
  while (active < MAX_JOBS && queue.length) {
    const id = queue.shift();
    const m = get('SELECT * FROM moments WHERE id=? AND state=0', id);
    if (!m) continue;
    active++;
    const jb = jobs.track('moments', `Ögonblick: ${m.title}`, { detail: m.source });
    make(m).then(() => {
      // Lagringsgränsen: blev det ändå för mycket (uppskattningen före jobbet är grov) tas klippet bort
      if (used() > maxBytes()) { removeFiles(m.id); run("UPDATE moments SET state=2, size=0, ff_size=0, error=? WHERE id=?", 'Lagringen för ögonblick är full', m.id); }
    }, (e) => {
      console.warn(`[ögonblick] ${m.id}: ${e.message}`);
      removeFiles(m.id);
      run('UPDATE moments SET state=2, error=? WHERE id=?', clean(e.message.replace(/\/[^\s:]+/g, '…'), 300) || 'Klippet kunde inte göras', m.id);
    }).finally(() => {
      jb.end(); active--;
      if (!queued()) { const w = idleWaiters; idleWaiters = []; w.forEach(f => f()); }
      pump();
    });
  }
}
export function removeFiles(id) { for (const k of ['mp4', 'ff.mp4', 'jpg', 'ass', 'mp4.tmp', 'ff.mp4.tmp']) fs.rmSync(fileOf(id, k), { force: true }); }
/** Vid start: avbrutna jobb blir misslyckade, filer utan rad (titeln eller profilen borttagen) tas bort */
export function init() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  run("UPDATE moments SET state=2, error='Avbröts när servern startades om' WHERE state=0");
  sweep();
  setInterval(sweep, 3600e3).unref();
}
export function sweep() {
  let files = [];
  try { files = fs.readdirSync(DIR); } catch { return; }
  const ids = new Set(all('SELECT id FROM moments').map(r => r.id));
  for (const f of files) { const id = parseInt(f); if (/^\d+\./.test(f) && !ids.has(id) && !queue.includes(id)) fs.rmSync(path.join(DIR, f), { force: true }); }
  run('DELETE FROM moment_shares WHERE expires < ?', now() - 30 * 86400); // utgångna länkar glöms efter 30 dagar
}
export const used = () => get('SELECT COALESCE(SUM(size + ff_size), 0) AS n FROM moments').n;

// ---------------- skapa och visa ----------------
/** Nytt ögonblick (u = profilen, it = titelraden – behörigheten är redan kontrollerad). Ger raden. */
export function create(u, it, b) {
  const r = parseRange(b, it.duration || 0);
  const title = clean(b.title, MAX_TITLE);
  if (!title) throw err(400, 'Ge ögonblicket en titel');
  let sub = null;
  if (b.sub) {
    sub = subtitlesOf(it).find(s => s.id === String(b.sub));
    if (!sub) throw err(400, 'Undertexten finns inte');
    if (sub.bitmap) throw err(400, 'Bildundertexter kan inte brännas in i ett ögonblick – välj en textundertext');
  }
  const audio = Number.isInteger(b.audio) || /^\d{1,3}$/.test(String(b.audio ?? '')) ? +b.audio : null;
  if (get('SELECT COUNT(*) AS n FROM moments WHERE user_id=?', u.id).n >= MAX_PER_PROFILE) throw err(409, `Du har redan ${MAX_PER_PROFILE} ögonblick – ta bort några först`);
  const est = it.size && it.duration ? Math.min(it.size / it.duration * (r.e - r.s), 50 << 20) : 0;
  if (used() + est > maxBytes()) throw err(409, `Lagringen för ögonblick är full (${Math.round(maxBytes() / 1048576)} MB) – ta bort gamla ögonblick`);
  if (queue.length >= MAX_QUEUE) throw err(429, 'Många ögonblick görs redan – försök igen om en stund');
  const id = Number(run(`INSERT INTO moments(user_id, household, item_id, title, source, s, e, audio, sub, watermark, state, created) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)`,
    u.id, rootOf(u), it.id, title, sourceOf(it), r.s, r.e, audio, sub?.id || null, b.watermark ? 1 : 0, now()).lastInsertRowid);
  enqueue(id);
  return get('SELECT * FROM moments WHERE id=?', id);
}

const userRow = (uid) => get('SELECT id, name, parent_id, is_admin, max_age, family_filter FROM users WHERE id=?', uid);
/**
 * Får profilen se ögonblicket? Samma hushåll, titeln tillåten (allowed = allowedFor med åldersgräns och bibliotek) och –
 * med påtvingat familjefilter – en tystad version som går att visa. Ger raden med titelns fält eller null.
 */
export function visibleTo(uid, id, allowed) {
  const u = userRow(uid); if (!u) return null;
  const m = get(`SELECT m.*, i.library_id, i.age, i.parent_id AS i_parent, i.version_of, i.kind AS i_kind FROM moments m JOIN items i ON i.id=m.item_id WHERE m.id=? AND m.household=?`, id, rootOf(u));
  if (!m || !allowed({ id: m.item_id, library_id: m.library_id, age: m.age, parent_id: m.i_parent, version_of: m.version_of, kind: m.i_kind })) return null;
  if (!familyOk(u, m)) return null;
  return m;
}
const hasMute = (m) => { try { return JSON.parse(m.mute || '[]').length > 0; } catch { return false; } };
/** Påtvingat filter: klippet måste vara tystat (eller ha en tystad variant) och inte ha omaskerade svordomar inbrända */
function familyOk(u, m) {
  if (!family.enforced(u)) return true;
  if (m.burn_prof) return false;
  return m.state !== 1 || m.muted || !hasMute(m) || m.ff_size > 0;
}
/** Vilken fil profilen ska få: den tystade varianten när filtret är på för profilen och den finns */
export function videoFileFor(uid, m) {
  const u = userRow(uid);
  if (u && !m.muted && m.ff_size > 0 && family.modeFor(u) !== 'off') return fileOf(m.id, 'ff.mp4');
  return fileOf(m.id);
}
export const canDeleteMoment = (u, m) => m.user_id === u.id || u.id === rootOf(u) || !!u.is_admin;
/** Externa länkar: inte barnprofiler, och bara skaparen eller huvudkontot. Kontot måste få ladda ner (canDl). */
export const canShare = (u, m, canDl) => u.max_age == null && canDl && (m.user_id === u.id || u.id === rootOf(u));

/** Hushållets ögonblick för profilen, nyast först. before = id att fortsätta efter. */
export function feed(uid, allowed, { before = null, limit = 30, item = null } = {}) {
  const u = userRow(uid); if (!u) return [];
  const rows = all(`SELECT m.*, i.library_id, i.age, i.parent_id AS i_parent, i.version_of, i.kind AS i_kind FROM moments m JOIN items i ON i.id=m.item_id
    WHERE m.household=? ${before ? 'AND m.id < ?' : ''} ${item ? 'AND m.item_id=?' : ''} ORDER BY m.id DESC LIMIT 400`, rootOf(u), ...(before ? [before] : []), ...(item ? [item] : []));
  return rows.filter(m => allowed({ id: m.item_id, library_id: m.library_id, age: m.age, parent_id: m.i_parent, version_of: m.version_of, kind: m.i_kind }) && familyOk(u, m)).slice(0, limit);
}

/** Ögonblicket som API-svar för profilen u */
export function out(u, m, { canDl = true, full = false } = {}) {
  const by = get('SELECT name FROM users WHERE id=?', m.user_id);
  const reacts = all('SELECT emoji, COUNT(*) AS n, MAX(user_id=?) AS mine FROM moment_reactions WHERE moment_id=? GROUP BY emoji', u.id, m.id);
  const o = {
    id: m.id, title: m.title, itemId: m.item_id, source: m.source, start: m.s, end: m.e, duration: m.dur ?? Math.round((m.e - m.s) * 1000) / 1000,
    state: STATE[m.state] || 'failed', error: m.state === 2 ? m.error || 'Klippet kunde inte göras' : undefined, mode: m.mode || null,
    subs: !!m.sub, watermark: !!m.watermark, width: m.width || null, height: m.height || null,
    by: { id: m.user_id, name: by?.name || '' }, mine: m.user_id === u.id, created: m.created,
    reactions: EMOJI.map(e => { const r = reacts.find(x => x.emoji === e); return { emoji: e, n: r?.n || 0, mine: !!r?.mine }; }),
    comments: get('SELECT COUNT(*) AS n FROM moment_comments WHERE moment_id=?', m.id).n,
    canDelete: canDeleteMoment(u, m), canShare: m.state === 1 && canShare(u, m, canDl)
  };
  if (full) {
    o.commentList = all(`SELECT c.id, c.user_id, c.text, c.created, u.name FROM moment_comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.moment_id=? ORDER BY c.id`, m.id)
      .map(c => ({ id: c.id, text: c.text, created: c.created, by: { id: c.user_id, name: c.name || '' }, mine: c.user_id === u.id, canDelete: c.user_id === u.id || canDeleteMoment(u, m) }));
    if (o.canShare) o.shares = all('SELECT id, expires, revoked, views, created FROM moment_shares WHERE moment_id=? ORDER BY id DESC', m.id)
      .map(s => ({ id: s.id, expires: s.expires, revoked: !!s.revoked, expired: s.expires <= now(), views: s.views, created: s.created }));
  }
  return o;
}

export function remove(id) {
  run('DELETE FROM moments WHERE id=?', id);
  removeFiles(id);
}
/** Reaktion av/på. Ger true om den nu är på. */
export function react(uid, id, emoji) {
  if (!EMOJI.includes(emoji)) throw err(400, 'Okänd reaktion');
  if (Number(run('DELETE FROM moment_reactions WHERE moment_id=? AND user_id=? AND emoji=?', id, uid, emoji).changes)) return false;
  run('INSERT INTO moment_reactions(moment_id, user_id, emoji, created) VALUES(?,?,?,?)', id, uid, emoji, now());
  return true;
}
export function comment(uid, id, text) {
  const t = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_COMMENT);
  if (!t) throw err(400, 'Skriv en kommentar');
  if (get('SELECT COUNT(*) AS n FROM moment_comments WHERE moment_id=?', id).n >= MAX_COMMENTS) throw err(409, 'Ögonblicket har redan många kommentarer');
  return Number(run('INSERT INTO moment_comments(moment_id, user_id, text, created) VALUES(?,?,?,?)', id, uid, t, now()).lastInsertRowid);
}

export const deleteComment = (cid) => run('DELETE FROM moment_comments WHERE id=?', cid);

// ---------------- delning utanför hemmet ----------------
function shareKey() {
  let k = getSetting('moments_share_key', '');
  if (!/^[0-9a-f]{64}$/.test(k)) { k = crypto.randomBytes(32).toString('hex'); setSetting('moments_share_key', k); }
  return Buffer.from(k, 'hex');
}
const sign = (sid, exp) => crypto.createHmac('sha256', shareKey()).update(`moment-share:${sid}.${exp}`).digest('base64url').slice(0, 32);
export const tokenOf = (sid, exp) => `${sid}.${exp}.${sign(sid, exp)}`;
/** Ny länk: hours ur SHARE_HOURS. Ger { id, token, expires } – token visas bara nu. */
export function share(uid, m, hours) {
  if (!SHARE_HOURS.includes(+hours)) throw err(400, 'Välj hur länge länken ska gälla');
  if (get('SELECT COUNT(*) AS n FROM moment_shares WHERE moment_id=? AND revoked=0 AND expires > ?', m.id, now()).n >= 10) throw err(409, 'Ögonblicket har redan tio giltiga länkar – återkalla någon först');
  const expires = now() + hours * 3600;
  const sid = Number(run('INSERT INTO moment_shares(moment_id, user_id, expires, created) VALUES(?,?,?,?)', m.id, uid, expires, now()).lastInsertRowid);
  return { id: sid, token: tokenOf(sid, expires), expires };
}
export const revoke = (mid, sid) => Number(run('UPDATE moment_shares SET revoked=1 WHERE id=? AND moment_id=?', sid, mid).changes) > 0;
/**
 * Slår upp en länk. Ger { m, s } när signaturen stämmer, länken inte gått ut och inte återkallats och klippet finns –
 * annars { gone: true } (utgången/återkallad, för en vänlig sida) eller null (okänd/förfalskad).
 */
export function resolveShare(token) {
  const p = /^(\d{1,12})\.(\d{1,12})\.([\w-]{32})$/.exec(String(token || ''));
  if (!p) return null;
  const want = Buffer.from(sign(+p[1], +p[2])), got = Buffer.from(p[3]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const s = get('SELECT * FROM moment_shares WHERE id=? AND expires=?', +p[1], +p[2]);
  if (!s) return { gone: true };
  if (s.revoked || s.expires <= now()) return { gone: true };
  const m = get('SELECT m.* FROM moments m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.state=1', s.moment_id);
  if (!m || !fs.existsSync(fileOf(m.id))) return { gone: true };
  return { m, s };
}
export const countView = (sid) => run('UPDATE moment_shares SET views=views+1 WHERE id=?', sid);

/** Sidan bakom länken: bara klippet, med Open Graph för förhandsvisningen i chattappar */
export function sharePage(m, token, origin, lang = 'sv') {
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const base = `${origin}/api/share/${token}`;
  const en = lang === 'en';
  const secs = Math.round(m.dur || m.e - m.s);
  const desc = en ? `A moment from ${m.source} · ${secs} s` : `Ett ögonblick ur ${m.source} · ${secs} s`;
  return `<!doctype html><html lang="${en ? 'en' : 'sv'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(m.title)}</title><meta name="robots" content="noindex">
<meta property="og:type" content="video.other"><meta property="og:title" content="${e(m.title)}"><meta property="og:description" content="${e(desc)}">
<meta property="og:url" content="${e(base)}"><meta property="og:image" content="${e(base)}/thumb.jpg">
<meta property="og:video" content="${e(base)}/clip.mp4"><meta property="og:video:type" content="video/mp4">${m.width ? `<meta property="og:video:width" content="${+m.width}"><meta property="og:video:height" content="${+m.height}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<style>html,body{margin:0;background:#0d0f14;color:#e8eaf0;font:1rem/1.4 system-ui,sans-serif}main{max-width:960px;margin:0 auto;padding:16px}
video{width:100%;max-height:80vh;background:#000;border-radius:8px}h1{font-size:1.25rem;margin:12px 0 4px}p{margin:0;color:#a3a8b5}</style></head>
<body><main><video src="${e(base)}/clip.mp4" poster="${e(base)}/thumb.jpg" controls playsinline preload="metadata"></video>
<h1>${e(m.title)}</h1><p>${e(desc)}</p></main></body></html>`;
}
export const goneHtml = (lang = 'sv') => `<!doctype html><html lang="${lang === 'en' ? 'en' : 'sv'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${lang === 'en' ? 'The link has expired' : 'Länken gäller inte längre'}</title><style>body{margin:0;background:#0d0f14;color:#e8eaf0;font:1rem/1.4 system-ui,sans-serif;padding:40px 16px;text-align:center}</style></head>
<body><h1>${lang === 'en' ? 'The link has expired' : 'Länken gäller inte längre'}</h1><p>${lang === 'en' ? 'It has expired or been revoked by whoever shared it.' : 'Den har gått ut eller återkallats av den som delade den.'}</p></body></html>`;
