// Aktiva uppspelningar ("Spelas nu"), uppspelningshistorik, säkerhetskopiering och filbevakning.
import fs from 'node:fs';
import path from 'node:path';
import { db, get, all, run, now, getSetting, CONFIG } from './db.js';
import { notify } from './notify.js';
import * as offsite from './offsite.js';

db.exec(`CREATE TABLE IF NOT EXISTS plays(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, item_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  mode TEXT, remote INTEGER, device TEXT);
CREATE INDEX IF NOT EXISTS plays_ts ON plays(ts);
CREATE INDEX IF NOT EXISTS plays_user ON plays(user_id, ts);`);

// ---------------- spelas nu ----------------
const active = new Map(); // key -> session
const stopped = new Map(); // `${userId}-${itemId}` -> tidpunkt (stoppad av admin)
const keyOf = (userId, itemId) => `${userId}-${itemId}`;

export function startPlay({ user, item, mode, quality, ip, remote, ua, reasons }) {
  const key = keyOf(user.id, item.id);
  stopped.delete(key);
  const prev = active.get(key);
  active.set(key, {
    key, userId: user.id, user: user.name, itemId: item.id, mode, quality, ip, remote: !!remote,
    device: deviceName(ua), reasons, started: prev?.started || now(), last: now(), position: prev?.position || 0, paused: false
  });
  // Historik: högst en rad per användare och titel per 30 minuter
  const recent = get('SELECT id FROM plays WHERE user_id=? AND item_id=? AND ts > ?', user.id, item.id, now() - 1800);
  if (!recent) run('INSERT INTO plays(user_id,item_id,ts,mode,remote,device) VALUES(?,?,?,?,?,?)', user.id, item.id, now(), mode, remote ? 1 : 0, deviceName(ua));
}
export function touch(userId, itemId, position = null) {
  const s = active.get(keyOf(userId, itemId));
  if (!s) return;
  if (position != null) { s.paused = Math.abs(position - s.position) < 1 && now() - s.last < 20; s.position = position; }
  s.last = now();
}
export function isStopped(userId, itemId) {
  const t = stopped.get(keyOf(userId, itemId));
  return !!(t && now() - t < 120);
}
export function stopPlay(key) {
  const s = active.get(key);
  if (!s) return null;
  stopped.set(key, now());
  active.delete(key);
  return s;
}
// Stopp-markeringar behövs bara i två minuter – rensa gamla så att kartan inte växer
setInterval(() => { for (const [k, t] of stopped) if (now() - t > 86400) stopped.delete(k); }, 3600e3).unref();
export function listActive() {
  const out = [];
  for (const [k, s] of active) {
    if (now() - s.last > 90) { active.delete(k); continue; }
    const it = get(`SELECT i.title, i.kind, i.season, i.episode, i.duration, s.title AS show FROM items i LEFT JOIN items s ON s.id=i.parent_id WHERE i.id=?`, s.itemId);
    out.push({ ...s, title: it ? (it.kind === 'episode' ? `${it.show} – S${String(it.season).padStart(2, '0')}E${String(it.episode).padStart(2, '0')} ${it.title}` : it.title) : '?', duration: it?.duration });
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
    (SELECT COUNT(*) FROM items WHERE kind='movie') AS movies,
    (SELECT COUNT(*) FROM items WHERE kind='show') AS shows,
    (SELECT COUNT(*) FROM items WHERE kind='episode') AS episodes,
    (SELECT COALESCE(SUM(size),0) FROM items WHERE path IS NOT NULL) AS bytes,
    (SELECT COALESCE(SUM(duration),0) FROM items WHERE path IS NOT NULL) AS seconds`);
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
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
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
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg|flv|ogv|srt|vtt|ass|mp3|flac|m4a|aac|ogg|opus|wav|alac|wma)$/i;
const watchers = new Map();
export function watchLibraries(onChange) {
  for (const [, w] of watchers) w.close();
  watchers.clear();
  if (getSetting('watch_enabled', process.env.WATCH_FILES || '1') !== '1') return;
  for (const lib of all('SELECT * FROM libraries')) {
    let timer = null;
    try {
      const w = fs.watch(lib.path, { recursive: true, persistent: false }, (ev, file) => {
        if (file && !VIDEO.test(String(file)) && !/^[^.]*$/.test(path.basename(String(file)))) return; // mappar saknar ändelse
        clearTimeout(timer);
        // Vänta tills kopieringen är klar (inga nya händelser på 30 s)
        timer = setTimeout(() => onChange(lib.id), 30000);
      });
      w.on('error', (e) => { console.warn('[watch]', lib.path, e.message); w.close(); watchers.delete(lib.id); });
      watchers.set(lib.id, w);
    } catch (e) {
      console.warn(`[watch] kan inte bevaka ${lib.path}: ${e.message}${e.code === 'ENOSPC' ? ' (höj fs.inotify.max_user_watches)' : ''}`);
    }
  }
}
export const watchingCount = () => watchers.size;
