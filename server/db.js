import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG = process.env.CONFIG_DIR || '/config';
export const IMAGES = path.join(CONFIG, 'images');
fs.mkdirSync(IMAGES, { recursive: true });

// Återställning: en förberedd databas (restore.db) byts in innan databasen öppnas
const DBFILE = path.join(CONFIG, 'braxhn-tv.db'), RESTORE = path.join(CONFIG, 'restore.db');
// En trasig eller ofullständig fil byts aldrig in – då startar servern inte alls
function validRestore(f) {
  try {
    const fd = fs.openSync(f, 'r'), head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
    if (head.toString('latin1') !== 'SQLite format 3\0') return false;
    // Kontrollen kan skapa -wal/-shm bredvid filen; ta bort dem som inte fanns innan
    const extra = ['-wal', '-shm'].map(x => f + x).filter(x => !fs.existsSync(x));
    const t = new DatabaseSync(f, { readOnly: true });
    try {
      if (t.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') return false;
      // En annan SQLite-databas (inte BraXhn TV) får inte heller bytas in – då skulle servern starta tom
      const names = new Set(t.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
      return ['users', 'items', 'progress', 'settings'].every(n => names.has(n));
    }
    finally { t.close(); for (const x of extra) fs.rmSync(x, { force: true }); }
  } catch { return false; }
}
if (fs.existsSync(RESTORE) && !validRestore(RESTORE)) {
  const bad = `${RESTORE}.ogiltig-${Date.now()}`;
  fs.renameSync(RESTORE, bad);
  console.error('[db] Säkerhetskopian att återställa är trasig och användes inte – den sparades som', path.basename(bad));
}
if (fs.existsSync(RESTORE)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(DBFILE + ext)) fs.renameSync(DBFILE + ext, `${DBFILE}.före-återställning-${stamp}${ext}`);
  fs.renameSync(RESTORE, DBFILE);
  console.log('[db] Säkerhetskopian återställdes. Den tidigare databasen sparades som', `braxhn-tv.db.före-återställning-${stamp}`);
}
export const RESTORE_FILE = RESTORE;
export const db = new DatabaseSync(DBFILE);
// Säkerhetskopia före uppgradering: ny programversion mot en befintlig databas (schemat ändras strax nedan).
// Sparas i backups/ som före-uppgradering-<gammal version>.db; de tre senaste behålls.
{
  const APP_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  let prev = null;
  try { prev = db.prepare("SELECT v FROM settings WHERE k='app_version'").get()?.v ?? ''; } catch {} // ny databas: ingen tabell än
  if (prev !== null && prev !== APP_VERSION) {
    try {
      const dir = path.join(path.dirname(DBFILE), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `före-uppgradering-${(prev || 'okänd').replace(/[^\p{L}\p{N}.-]/gu, '')}-${Date.now()}.db`);
      db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
      const old = fs.readdirSync(dir).filter(f => f.startsWith('före-uppgradering-')).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const x of old.slice(3)) fs.rmSync(path.join(dir, x.f), { force: true });
      console.log(`[db] uppgradering ${prev || '?'} → ${APP_VERSION}: säkerhetskopia sparad som backups/${path.basename(out)}`);
    } catch (e) { console.warn('[db] kunde inte spara säkerhetskopia före uppgradering:', e.message); }
  }
  globalThis.__braxhnAppVersion = APP_VERSION;
}
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE NOT NULL,
  pass TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS libraries(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN('movie','show','music')),
  path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('movie','show','episode')),
  parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  title TEXT NOT NULL, sort_title TEXT, year INTEGER, season INTEGER, episode INTEGER,
  path TEXT, size INTEGER, mtime INTEGER, duration REAL, container TEXT,
  vcodec TEXT, acodec TEXT, width INTEGER, height INTEGER, streams TEXT,
  overview TEXT, rating REAL, tmdb_id INTEGER, meta_done INTEGER NOT NULL DEFAULT 0,
  poster INTEGER NOT NULL DEFAULT 0, backdrop INTEGER NOT NULL DEFAULT 0, thumb INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS items_lib ON items(library_id, kind);
CREATE INDEX IF NOT EXISTS items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS items_path ON items(path);
CREATE TABLE IF NOT EXISTS progress(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0, duration REAL, watched INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL, PRIMARY KEY(user_id,item_id));
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
`);

// ---- migreringar ----
const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name));
const addCol = (t, c, def) => { if (!cols(t).has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('sessions', 'kind', "TEXT NOT NULL DEFAULT 'web'");
addCol('sessions', 'expires', 'INTEGER');
addCol('items', 'intro_start', 'REAL');
addCol('items', 'intro_end', 'REAL');
addCol('items', 'credits_start', 'REAL');
addCol('items', 'markers_done', 'INTEGER NOT NULL DEFAULT 0');
addCol('items', 'hdr', 'TEXT');
addCol('sessions', 'scope_item', 'INTEGER');
addCol('sessions', 'ua', 'TEXT');
addCol('sessions', 'ip', 'TEXT');
addCol('sessions', 'last_seen', 'INTEGER');
addCol('users', 'totp_secret', 'TEXT');
addCol('users', 'totp_pending', 'TEXT');
addCol('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'totp_last', 'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'recovery', 'TEXT');
addCol('users', 'remote_allowed', 'INTEGER NOT NULL DEFAULT 1');
addCol('users', 'pw_changed', 'INTEGER');
db.exec(`CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id INTEGER, user_name TEXT,
  ip TEXT, event TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);`);
addCol('items', 'genres', 'TEXT');
addCol('items', 'recap_start', 'REAL');
addCol('items', 'recap_end', 'REAL');
addCol('items', 'trickplay', 'INTEGER NOT NULL DEFAULT 0');
addCol('items', 'cert', 'TEXT');
addCol('items', 'age', 'INTEGER');
addCol('items', 'collection_id', 'INTEGER');
addCol('users', 'parent_id', 'INTEGER');
addCol('users', 'pin', 'TEXT');
addCol('users', 'max_age', 'INTEGER');
addCol('users', 'color', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS collections(id INTEGER PRIMARY KEY, name TEXT NOT NULL, overview TEXT,
  poster INTEGER NOT NULL DEFAULT 0, backdrop INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS watchlist(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, added INTEGER NOT NULL, PRIMARY KEY(user_id,item_id));
CREATE INDEX IF NOT EXISTS items_coll ON items(collection_id);`);
// v0.5: biblioteket får även typen 'music' (SQLite kan inte ändra CHECK – bygg om tabellen)
if (!/'music'/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name='libraries'").get().sql)) {
  db.exec(`PRAGMA foreign_keys=OFF; BEGIN;
    CREATE TABLE libraries_new(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN('movie','show','music')), path TEXT NOT NULL);
    INSERT INTO libraries_new SELECT id,name,type,path FROM libraries; DROP TABLE libraries; ALTER TABLE libraries_new RENAME TO libraries;
    COMMIT; PRAGMA foreign_keys=ON;`);
}
db.exec(`CREATE TABLE IF NOT EXISTS artists(id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sort_name TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS artists_name ON artists(library_id, name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS albums(id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL, title TEXT NOT NULL, sort_title TEXT, year INTEGER, genre TEXT,
  cover INTEGER NOT NULL DEFAULT 0, dir TEXT, added INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS albums_artist ON albums(artist_id);
CREATE TABLE IF NOT EXISTS tracks(id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  album_id INTEGER REFERENCES albums(id) ON DELETE CASCADE, artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  title TEXT NOT NULL, track_no INTEGER, disc_no INTEGER, duration REAL, path TEXT NOT NULL, size INTEGER, mtime INTEGER,
  codec TEXT, bitrate INTEGER, sample_rate INTEGER, channels INTEGER, added INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_id, disc_no, track_no);
CREATE INDEX IF NOT EXISTS tracks_path ON tracks(path);
CREATE TABLE IF NOT EXISTS playlists(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS playlist_items(playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, pos INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pli ON playlist_items(playlist_id, pos);
CREATE TABLE IF NOT EXISTS track_plays(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tp_user ON track_plays(user_id, ts);
CREATE TABLE IF NOT EXISTS favorites(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, PRIMARY KEY(user_id, track_id));`);
// v0.5: ljudböcker som bibliotekstyp + anime-flagga
if (!/'audiobook'/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name='libraries'").get().sql)) {
  db.exec(`PRAGMA foreign_keys=OFF; BEGIN;
    CREATE TABLE libraries_new(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN('movie','show','music','audiobook')), path TEXT NOT NULL,
      anime INTEGER NOT NULL DEFAULT 0);
    INSERT INTO libraries_new(id,name,type,path) SELECT id,name,type,path FROM libraries; DROP TABLE libraries; ALTER TABLE libraries_new RENAME TO libraries;
    COMMIT; PRAGMA foreign_keys=ON;`);
}
addCol('items', 'match_locked', 'INTEGER NOT NULL DEFAULT 0');
addCol('items', 'abs_episode', 'INTEGER');
addCol('items', 'sub_auto', 'INTEGER NOT NULL DEFAULT 0');
addCol('items', 'chapters', 'TEXT');
addCol('items', 'src_name', 'TEXT'); // seriens namn enligt mappen/filen (TMDB kan byta titel)
// Rollista och trailers: credits_done = rollistan hämtad (1) eller saknas hos TMDB (2), trailer_yt = YouTube-nyckel från TMDB
addCol('items', 'credits_done', 'INTEGER NOT NULL DEFAULT 0');
addCol('items', 'trailer_yt', 'TEXT');
// Flera versioner av samma film: versionen pekar på huvudraden (NULL = huvudrad / vanlig titel)
addCol('items', 'version_of', 'INTEGER REFERENCES items(id) ON DELETE SET NULL');
// Avsnittsnummer gissat ur namnordningen (fil utan nummer) – matchas mot TMDB på titel i stället för nummer
addCol('items', 'ep_guess', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS items_version ON items(version_of)');
// Lyssningsfunktioner – jämn ljudnivå: ReplayGain i dB mot -18 LUFS, toppvärde (linjärt) och källa ('tag', 'mätt', 'fel'; NULL = inte kontrollerat)
addCol('tracks', 'rg_track', 'REAL');
addCol('tracks', 'rg_album', 'REAL');
addCol('tracks', 'rg_peak', 'REAL');
addCol('tracks', 'loudness', 'TEXT');
// Skärmtid, notiser om nya avsnitt och automatisk offline-synk (JSON per användare)
addCol('users', 'screen_time', 'TEXT');
addCol('users', 'notify_personal', 'TEXT');
addCol('users', 'offline_sync', 'TEXT');
// "Ta bort från Fortsätt titta" för en serie: döljer nästa avsnitt tills man tittar på serien igen (progress.updated > at)
db.exec(`CREATE TABLE IF NOT EXISTS continue_hidden(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, at INTEGER NOT NULL, PRIMARY KEY(user_id,item_id));`);
// Index för vanliga uppslag (kaskadborttagning, "Fortsätt titta", rensning av sessioner m.m.)
db.exec(`CREATE INDEX IF NOT EXISTS items_lib_added ON items(library_id, kind, added);
CREATE INDEX IF NOT EXISTS items_lib_sort ON items(library_id, kind, sort_title);
CREATE INDEX IF NOT EXISTS items_parent_se ON items(parent_id, season, episode);
DROP INDEX IF EXISTS items_parent;
CREATE INDEX IF NOT EXISTS items_tmdb ON items(tmdb_id);
CREATE INDEX IF NOT EXISTS items_kind_added ON items(kind, added);
CREATE INDEX IF NOT EXISTS items_src ON items(library_id, kind, src_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS progress_item ON progress(item_id);
CREATE INDEX IF NOT EXISTS watchlist_item ON watchlist(item_id);
CREATE INDEX IF NOT EXISTS tp_track ON track_plays(track_id);
CREATE INDEX IF NOT EXISTS fav_track ON favorites(track_id);
CREATE INDEX IF NOT EXISTS pli_track ON playlist_items(track_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);`);

// Versionsmigreringar körs i tur och ordning så att även uppgradering från mycket gamla versioner får alla steg
const LATEST = 5;
let ver = db.prepare('PRAGMA user_version').get().user_version;
if (ver < 2) {
  // v0.2: analysera om alla filer (HDR-info, bildundertexter)
  db.exec('UPDATE items SET mtime=0 WHERE path IS NOT NULL');
  ver = 2;
}
if (ver < 3) {
  // v0.3: token lagras hashade – gamla sessioner gäller inte längre (alla loggas ut en gång)
  db.exec('DELETE FROM sessions');
  ver = 3;
}
if (ver < 4) {
  // v0.4: hämta om metadata för genrer, åldersgräns och samlingar
  db.exec("UPDATE items SET meta_done=0 WHERE kind IN ('movie','show') AND tmdb_id IS NOT NULL");
  ver = 4;
}
if (ver < 5) {
  // v0.5: items.src_name (fylls i av skannern) och nya index – inget att göra här
  ver = 5;
}
if (ver !== db.prepare('PRAGMA user_version').get().user_version) db.exec(`PRAGMA user_version=${Math.max(ver, LATEST)}`);
// Äldre programversion mot en nyare databas (t.ex. efter återgång till en gammal image): fungerar oftast,
// men nya kolumner och tabeller används inte – varna tydligt
if (ver > LATEST) console.warn(`[db] Databasen kommer från en nyare version av BraXhn TV (schema ${ver} > ${LATEST}). Uppdatera imagen – eller återställ backups/före-uppgradering-*.db om du vill gå tillbaka.`);
try { db.prepare("INSERT INTO settings(k,v) VALUES('app_version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(globalThis.__braxhnAppVersion); } catch {}

// Låt SQLite uppdatera statistik för frågeplaneraren (billigt; körs vid start och var 12:e timme)
const optimize = () => { try { db.exec('PRAGMA optimize'); } catch (e) { console.warn('[db] optimize:', e.message); } };
optimize();
setInterval(optimize, 12 * 3600e3).unref();
export const CACHE = path.join(CONFIG, 'cache');
export const SUBS_DIR = path.join(CONFIG, 'subtitles');
for (const d of [CACHE, SUBS_DIR, path.join(CACHE, 'keyframes'), path.join(CACHE, 'fingerprints')]) fs.mkdirSync(d, { recursive: true });

// Förberedda satser återanvänds (att kompilera SQL kostar mer än att köra enkla frågor)
const stmts = new Map();
const STMT_MAX = 500;
export function stmt(sql) {
  let st = stmts.get(sql);
  if (st) { stmts.delete(sql); stmts.set(sql, st); return st; } // LRU: senast använd sist
  st = db.prepare(sql);
  stmts.set(sql, st);
  if (stmts.size > STMT_MAX) stmts.delete(stmts.keys().next().value);
  return st;
}
export const get = (sql, ...p) => stmt(sql).get(...p);
export const all = (sql, ...p) => stmt(sql).all(...p);
export const run = (sql, ...p) => stmt(sql).run(...p);

/**
 * Kör fn i en transaktion (BEGIN IMMEDIATE/COMMIT, ROLLBACK vid fel). Kapslade anrop – eller anrop
 * medan någon annan transaktion pågår – använder SAVEPOINT. fn måste vara synkron.
 */
let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0 || db.isTransaction) {
    const sp = `sp${++txDepth}`;
    db.exec(`SAVEPOINT ${sp}`);
    try { const r = fn(); db.exec(`RELEASE ${sp}`); return r; }
    catch (e) { try { db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch {} throw e; }
    finally { txDepth--; }
  }
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  finally { txDepth--; }
}

const settingsCache = new Map();
export function getSetting(k, def = '') {
  if (settingsCache.has(k)) { const v = settingsCache.get(k); return v === null ? def : v; }
  const r = get('SELECT v FROM settings WHERE k=?', k);
  settingsCache.set(k, r ? r.v : null);
  return r ? r.v : def;
}
export function setSetting(k, v) {
  run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v));
  settingsCache.delete(k); // läses om från databasen nästa gång (rätt även om en transaktion rullas tillbaka)
}
export const now = () => Math.floor(Date.now() / 1000);
