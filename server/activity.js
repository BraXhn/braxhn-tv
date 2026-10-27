// Aktiva uppspelningar ("Spelas nu"), uppspelningshistorik, säkerhetskopiering och filbevakning.
import fs from 'node:fs';
import path from 'node:path';
import { db, get, all, run, now, getSetting, CONFIG } from './db.js';
import { notify } from './notify.js';
import * as webhooks from './webhooks.js';
import * as offsite from './offsite.js';
import { AUDIO } from './music.js';
import { rootsOf } from './libpaths.js';

// ---------------- spelas nu ----------------
// En uppspelning (session) per användare och titel. Servern ser: uppspelningsbeslutet (GET /api/items/:id/playback =
// start), framstegsanropen (POST /api/items/:id/progress – webben, iOS/tvOS och Android skickar var 10:e sekund medan
// filmen spelas, och när den pausas eller stängs), strömmens förfrågningar (segment/direktfil, touch) och stoppet
// (POST /api/stream/:id/stop när spelaren stängs). Paus syns som att framstegen slutar komma eller att positionen står
// still; nästa framsteg med ny position är "fortsätter". Utan stopp (fliken stängd) slutar sessionen efter 90 s utan
// aktivitet, eller efter 15 min om den var pausad. Övergångarna blir webhooks (media.play/pause/resume/stop/scrobble)
// och historiken i plays (en rad per tittning; samma titel inom 30 min fortsätter på samma rad).
const active = new Map(); // key -> session
const stopped = new Map(); // `${userId}-${itemId}` -> tidpunkt (stoppad av admin)
const keyOf = (userId, itemId) => `${userId}-${itemId}`;
export const PAUSE_AFTER = 25, IDLE_PLAYING = 90, IDLE_PAUSED = 15 * 60;
// Stopp följt av ny start inom några sekunder (byte av kvalitet/ljudspår i apparna) är samma uppspelning
const stopGrace = () => Math.max(0, +(process.env.PLAY_STOP_GRACE ?? 5));

export const itemMeta = (id) => get(`SELECT i.id, i.kind, i.title, i.year, i.season, i.episode, i.duration, i.tmdb_id, i.library_id, i.width, i.height, i.hdr, i.age, i.parent_id,
  l.name AS library, s.id AS show_id, s.title AS show_title, s.year AS show_year, s.tmdb_id AS show_tmdb
  FROM items i LEFT JOIN items s ON s.id=i.parent_id LEFT JOIN libraries l ON l.id=i.library_id WHERE i.id=?`, id);
/** Webhookens metadata för titeln (Plex-liknande: typ, titel, serie/säsong/avsnitt, TMDB-id, längd, position) */
export function metadataOf(m, position = null) {
  if (!m) return null;
  const ep = m.kind === 'episode';
  const pos = position == null ? null : Math.round(position);
  return {
    id: m.id, type: m.kind, title: m.title, year: ep ? m.show_year ?? null : m.year ?? null,
    ...(ep ? { show: m.show_title, showId: m.show_id, season: m.season, episode: m.episode, showTmdbId: m.show_tmdb || null } : {}),
    tmdbId: m.tmdb_id || null, library: m.library_id ? { id: m.library_id, name: m.library } : null,
    duration: m.duration ? Math.round(m.duration) : null, position: pos,
    progress: pos != null && m.duration ? Math.min(100, Math.round(pos / m.duration * 100)) : null,
    ...(m.height ? { resolution: m.height >= 2000 ? '4K' : `${m.height}p`, hdr: m.hdr || null } : {})
  };
}
function payload(s) {
  return {
    user: { id: s.userId, name: s.user }, player: { device: s.device, ip: s.ip, local: !s.remote },
    metadata: metadataOf(s.meta, s.position),
    playback: { mode: s.mode, transcode: s.mode === 'transcode', quality: s.quality || null, kbps: s.kbps || null, reasons: s.reasons || [] }
  };
}
const fire = (event, s) => { try { webhooks.emit(event, payload(s), { userId: s.userId }); } catch (e) { console.warn('[webhook]', e.message); } };
function saveRow(s, at) {
  try { run('UPDATE plays SET ended=?, pos_end=?, played=?, mode=?, quality=?, kbps=? WHERE id=?', at, s.position, Math.round(s.played), s.mode, s.quality || null, s.kbps || null, s.playId); } catch {}
}

export function startPlay({ user, item, mode, quality, ip, remote, ua, reasons, start = 0, kbps = null }, at = now()) {
  const key = keyOf(user.id, item.id);
  stopped.delete(key);
  const prev = active.get(key);
  if (prev && !expired(prev, at)) {
    // Samma uppspelning (ny kvalitet, nytt ljudspår, stopp och start i apparna): ingen ny händelse
    if (prev.stopTimer) { clearTimeout(prev.stopTimer); prev.stopTimer = null; }
    Object.assign(prev, { mode, quality, ip, remote: !!remote, reasons, kbps: kbps || prev.kbps, last: at });
    if (start > 0) prev.position = start;
    saveRow(prev, at);
    return prev;
  }
  if (prev) end(prev, at);
  const meta = itemMeta(item.id);
  const device = deviceName(ua);
  // Historik: samma titel inom 30 minuter fortsätter på samma rad
  const recent = get('SELECT id, played FROM plays WHERE user_id=? AND item_id=? AND COALESCE(ended, ts) > ? ORDER BY ts DESC LIMIT 1', user.id, item.id, at - 1800);
  let playId = recent?.id;
  if (recent) run('UPDATE plays SET ended=?, mode=?, remote=?, device=?, ip=?, quality=?, kbps=? WHERE id=?', at, mode, remote ? 1 : 0, device, ip || null, quality || null, kbps || null, recent.id);
  else playId = Number(run(`INSERT INTO plays(user_id,item_id,ts,ended,mode,remote,device,ip,quality,kbps,pos_start,pos_end,duration,title,kind,year,season,episode,show_id,show_title,library_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, user.id, item.id, at, at, mode, remote ? 1 : 0, device, ip || null, quality || null, kbps || null, start || 0, start || 0,
    meta?.duration || null, meta?.title || null, meta?.kind || null, meta?.kind === 'episode' ? meta.show_year ?? null : meta?.year ?? null, meta?.season ?? null, meta?.episode ?? null,
    meta?.show_id || null, meta?.show_title || null, meta?.library_id || null).lastInsertRowid);
  const s = {
    key, userId: user.id, user: user.name, itemId: item.id, mode, quality, ip, remote: !!remote, device, reasons, kbps,
    started: at, last: at, lastProgress: 0, position: start || 0, paused: false, played: recent?.played || 0,
    playId, meta, scrobbled: !!(meta?.duration && start / meta.duration >= 0.9), stopTimer: null
  };
  active.set(key, s);
  fire('media.play', s);
  return s;
}
/** Framsteg från spelaren (position i sekunder) – paus, fortsätter, sedd ≥ 90 % och historikens speltid */
export function progress(userId, itemId, position, at = now()) {
  const s = active.get(keyOf(userId, itemId));
  if (!s || s.stopTimer) return;
  position = Math.max(0, +position || 0);
  const dPos = position - s.position, dt = at - (s.lastProgress || s.started);
  if (Math.abs(dPos) < 1) {
    // Positionen står still sedan förra framsteget (apparna och webben skickar när filmen pausas)
    if (s.lastProgress && dt >= 5 && !s.paused) { s.paused = true; fire('media.pause', s); }
  } else {
    if (s.paused) { s.paused = false; fire('media.resume', s); }
    // Spolning framåt räknas inte som tittande: högst den tid som gått (plus marginal)
    if (dPos > 0) s.played += Math.min(dPos, dt + 15);
  }
  s.position = position; s.lastProgress = at; s.last = at;
  const dur = s.meta?.duration;
  if (!s.scrobbled && dur && position / dur >= 0.9) { s.scrobbled = true; fire('media.scrobble', s); }
  saveRow(s, at);
}
/** Strömmen hämtas (segment, direktfil) eller framsteg kom – sessionen lever. position: se progress() */
export function touch(userId, itemId, position = null, at = now()) {
  if (position != null) return progress(userId, itemId, position, at);
  const s = active.get(keyOf(userId, itemId));
  if (s) s.last = at;
}
const expired = (s, at) => at - s.last > (s.paused ? IDLE_PAUSED : IDLE_PLAYING);
function end(s, at = now()) {
  if (active.get(s.key) !== s) return;
  if (s.stopTimer) { clearTimeout(s.stopTimer); s.stopTimer = null; }
  active.delete(s.key);
  saveRow(s, Math.min(at, Math.max(s.last, s.started)));
  fire('media.stop', s);
}
/** Spelaren stängdes (POST /api/stream/:id/stop). Stoppet väntar några sekunder: startar samma titel igen är det samma uppspelning. */
export function clientStop(userId, itemId, at = now()) {
  const s = active.get(keyOf(userId, itemId));
  if (!s || s.stopTimer) return;
  s.last = at;
  if (stopGrace() <= 0) return end(s, at);
  // Hämtas strömmen ändå under väntan (webben lämnade över till Chromecast) fortsätter uppspelningen
  s.stopTimer = setTimeout(() => { s.stopTimer = null; if (s.last > at + 1) return; end(s, now()); }, stopGrace() * 1000);
  s.stopTimer.unref?.();
}
/** Pausa sessioner där framstegen slutat komma och avsluta de som varit tysta för länge (körs var 10:e sekund) */
export function sweep(at = now()) {
  for (const s of [...active.values()]) {
    if (s.stopTimer) continue;
    if (expired(s, at)) { end(s, at); continue; }
    if (!s.paused && s.lastProgress && at - s.lastProgress > PAUSE_AFTER) { s.paused = true; fire('media.pause', s); }
  }
}
setInterval(() => { try { sweep(); } catch (e) { console.warn('[aktivitet]', e.message); } }, 10e3).unref();
export function isStopped(userId, itemId) {
  const t = stopped.get(keyOf(userId, itemId));
  return !!(t && now() - t < 120);
}
/** Administratören stoppar uppspelningen */
export function stopPlay(key) {
  const s = active.get(key);
  if (!s) return null;
  stopped.set(key, now());
  end(s);
  return s;
}
/** Pågående videoströmmar för hushållet (kontot root och dess profiler), utom titeln exceptItem (perms.js max_streams) */
export function householdStreams(root, exceptItem = null) {
  const ids = new Set(all('SELECT id FROM users WHERE id=?1 OR parent_id=?1', root).map(r => r.id));
  let n = 0;
  // En uppspelning som klienten stoppat (clientStop, väntar på att avslutas) räknas inte – nästa titel kan starta direkt
  for (const s of active.values()) if (ids.has(s.userId) && s.itemId !== exceptItem && !s.stopTimer && now() - s.last <= 90) n++;
  return n;
}
// Stopp-markeringar behövs bara i två minuter – rensa gamla så att kartan inte växer
setInterval(() => { for (const [k, t] of stopped) if (now() - t > 86400) stopped.delete(k); }, 3600e3).unref();
const view = ({ meta, stopTimer, lastProgress, playId, scrobbled, played, ...s }, m) => ({ ...s,
  title: m ? (m.kind === 'episode' ? `${m.show_title} – S${String(m.season).padStart(2, '0')}E${String(m.episode).padStart(2, '0')} ${m.title}` : m.title) : '?', duration: m?.duration });
export function listActive() {
  sweep();
  const out = [];
  for (const [, s] of active) {
    if (s.stopTimer) continue;
    out.push(view(s, itemMeta(s.itemId) || s.meta));
  }
  return out.sort((a, b) => b.started - a.started);
}
function deviceName(ua = '') {
  ua = String(ua || '');
  if (/BraXhnTV-Android/i.test(ua)) return 'Android-app';
  if (/AppleTV|tvOS/i.test(ua)) return 'Apple TV';
  if (/CFNetwork|Darwin/i.test(ua)) return 'iPhone/iPad-app';
  if (/CrKey/i.test(ua)) return 'Chromecast';
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Webbläsare';
  return b;
}

// ---------------- statistik ----------------
export function stats() {
  const lib = get(`SELECT
    (SELECT COUNT(*) FROM items WHERE kind='movie' AND version_of IS NULL) AS movies,
    (SELECT COUNT(*) FROM items WHERE kind='show') AS shows,
    (SELECT COUNT(*) FROM items WHERE kind='episode') AS episodes,
    (SELECT COALESCE(SUM(size),0) FROM items WHERE path IS NOT NULL) AS bytes,
    (SELECT COALESCE(SUM(duration),0) FROM items WHERE path IS NOT NULL AND version_of IS NULL) AS seconds`);
  const since = now() - 30 * 86400;
  const users = all(`SELECT u.name, COUNT(p.id) AS plays,
      (SELECT COALESCE(SUM(i.duration),0) FROM progress g JOIN items i ON i.id=g.item_id WHERE g.user_id=u.id AND g.watched=1 AND g.updated > ?) AS watched_seconds
    FROM users u LEFT JOIN plays p ON p.user_id=u.id AND p.ts > ? GROUP BY u.id ORDER BY plays DESC`, since, since);
  const top = all(`SELECT COALESCE(s.id, i.id) AS id, COALESCE(s.title, i.title) AS title, COUNT(*) AS plays, COUNT(DISTINCT p.user_id) AS viewers
    FROM plays p JOIN items i ON i.id=p.item_id LEFT JOIN items s ON s.id=i.parent_id WHERE p.ts > ?
    GROUP BY COALESCE(s.id, i.id) ORDER BY plays DESC LIMIT 10`, since);
  const modes = all(`SELECT mode, COUNT(*) AS n FROM plays WHERE ts > ? GROUP BY mode`, since);
  const devices = all(`SELECT device, COUNT(*) AS n FROM plays WHERE ts > ? GROUP BY device ORDER BY n DESC`, since);
  const days = all(`SELECT date(ts, 'unixepoch', 'localtime') AS day, COUNT(*) AS n FROM plays WHERE ts > ? GROUP BY day ORDER BY day`, since);
  const recent = all(`SELECT p.ts, u.name AS user, p.mode, p.remote, p.device,
      CASE WHEN i.kind='episode' THEN s.title || ' – S' || printf('%02d', i.season) || 'E' || printf('%02d', i.episode) ELSE i.title END AS title
    FROM plays p JOIN users u ON u.id=p.user_id JOIN items i ON i.id=p.item_id LEFT JOIN items s ON s.id=i.parent_id
    ORDER BY p.ts DESC LIMIT 30`);
  return { library: lib, users, top, modes, devices, days, recent };
}

// ---------------- säkerhetskopiering ----------------
export const BACKUP_DIR = process.env.BACKUP_DIR || path.join(CONFIG, 'backups');
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function backupNow() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const d = new Date();
  // Lokalt datum och lokal tid (tidigare blandades UTC-datum med lokal tid)
  const name = `braxhn-tv-${localDay(d)}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.db`;
  const file = path.join(BACKUP_DIR, name);
  // Via .part: en krasch mitt i kopieringen får inte lämna en halv fil som räknas som den senaste säkerhetskopian
  // (och knuffar bort en hel kopia vid gallringen)
  const part = file + '.part';
  // Rester från en avbruten kopiering (även -journal, som annars kunde spelas upp i den nya filen)
  for (const f of fs.readdirSync(BACKUP_DIR)) if (/^braxhn-tv-[\d-]+\.db\.part/.test(f)) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  try { db.exec(`VACUUM INTO '${part.replace(/'/g, "''")}'`); fs.renameSync(part, file); }
  catch (e) { fs.rmSync(part, { force: true }); throw e; }
  const keep = Math.max(1, +getSetting('backup_keep', '14'));
  const files = listBackups();
  for (const f of files.slice(keep)) fs.rmSync(path.join(BACKUP_DIR, f.name), { force: true });
  return name;
}
export function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter(f => /^braxhn-tv-[\d-]+\.db$/.test(f))
      .map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
// Daglig kopia kl. 03.xx lokal tid (kollas var 10:e minut)
let lastBackupDay = '';
setInterval(() => {
  if (getSetting('backup_enabled', '1') !== '1') return;
  const d = new Date(), day = localDay(d);
  if (d.getHours() === 3 && day !== lastBackupDay) {
    lastBackupDay = day;
    try { const name = backupNow(); console.log('[backup] skapade', name); offsite.upload(path.join(BACKUP_DIR, name)).catch(() => {}); } catch (e) { console.warn('[backup] misslyckades:', e.message); notify('backup', 'Säkerhetskopieringen misslyckades', e.message, { priority: 4 }); }
  }
}, 600e3).unref();

// ---------------- filbevakning ----------------
// Video och undertexter (scanner.js) samt ljud (music.js, som musik- och ljudboksskannern använder)
const MEDIA_EXT = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm', '.ts', '.m2ts', '.wmv', '.mpg', '.mpeg', '.flv', '.ogv',
  '.srt', '.vtt', '.ass', ...AUDIO]);
/** Ska en ändring av filen (relativ till root) ge en skanning? Mediefiler och mappar – även med punkt i namnet
 *  ("Film.2020") – och borttagna saker utan ändelse räknas, andra filer (bilder, .nfo …) inte. */
export function watchRelevant(root, file) {
  if (MEDIA_EXT.has(path.extname(file).toLowerCase())) return true;
  try { return fs.statSync(path.join(root, file)).isDirectory(); } catch { return !path.extname(file); }
}
// Fotobibliotek (photos.js): även bilder startar en skanning
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.jpe', '.png', '.webp', '.gif', '.heic', '.heif', '.hif']);
const watchers = new Map();
const pending = new Map(); // väntande skanning per bibliotek
let watchGen = 0;
export function watchLibraries(onChange) {
  for (const [, w] of watchers) w.close();
  watchers.clear();
  // Ändrade inställningar: gamla väntande skanningar (ev. för borttagna bibliotek) ska inte köras
  for (const [, t] of pending) clearTimeout(t);
  pending.clear();
  const gen = ++watchGen;
  if (getSetting('watch_enabled', process.env.WATCH_FILES || '1') !== '1') return;
  // Rekursiv fs.watch går igenom hela mappträdet synkront – körs efter svaret, ett bibliotek per varv i händelseloopen
  // En bevakning per mapp (bibliotek kan ha flera mappar, libpaths.js)
  const jobs = all('SELECT * FROM libraries').flatMap(lib => rootsOf(lib).map(root => [lib, root]));
  const next = () => {
    if (gen !== watchGen) return; // ett nyare anrop har tagit över
    const job = jobs.shift();
    if (!job) return;
    watchOne(job[0], job[1], onChange);
    setImmediate(next);
  };
  setImmediate(next);
}
function watchOne(lib, root, onChange) {
  const key = `${lib.id}:${root}`;
  try {
    const w = fs.watch(root, { recursive: true, persistent: false }, (ev, file) => {
      if (file && !watchRelevant(root, String(file)) && !(lib.type === 'photo' && PHOTO_EXT.has(path.extname(String(file)).toLowerCase()))) return;
      clearTimeout(pending.get(lib.id));
      // Vänta tills kopieringen är klar (inga nya händelser på 30 s)
      const t = setTimeout(() => { pending.delete(lib.id); onChange(lib.id); }, 30000);
      t.unref();
      pending.set(lib.id, t);
    });
    w.on('error', (e) => { console.warn('[watch]', root, e.message); w.close(); watchers.delete(key); });
    watchers.set(key, w);
  } catch (e) {
    console.warn(`[watch] kan inte bevaka ${root}: ${e.message}${e.code === 'ENOSPC' ? ' (höj fs.inotify.max_user_watches)' : ''}`);
  }
}
/** Antal bibliotek med minst en bevakad mapp */
export const watchingCount = () => new Set([...watchers.keys()].map(k => k.split(':')[0])).size;
