import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG = process.env.CONFIG_DIR || '/config';
export const IMAGES = path.join(CONFIG, 'images');
fs.mkdirSync(IMAGES, { recursive: true });

export const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
db.exec(`
PRAGMA journal_mode=WAL;
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
const ver = db.prepare('PRAGMA user_version').get().user_version;
if (ver >= 3 && ver < 4) {
  // v0.4: hämta om metadata för genrer, åldersgräns och samlingar
  db.exec("UPDATE items SET meta_done=0 WHERE kind IN ('movie','show') AND tmdb_id IS NOT NULL; PRAGMA user_version=4;");
}
if (ver < 3) {
  // v0.3: token lagras hashade – gamla sessioner gäller inte längre (alla loggas ut en gång)
  db.exec("DELETE FROM sessions; UPDATE sessions SET expires = 0 WHERE expires IS NULL;");
  if (ver >= 2) db.exec("PRAGMA user_version=4; UPDATE items SET meta_done=0 WHERE kind IN ('movie','show') AND tmdb_id IS NOT NULL;");
}
if (ver < 2) {
  // v0.2: analysera om alla filer (HDR-info, bildundertexter)
  db.exec("UPDATE items SET mtime=0 WHERE path IS NOT NULL; PRAGMA user_version=4;");
}
export const CACHE = path.join(CONFIG, 'cache');
export const SUBS_DIR = path.join(CONFIG, 'subtitles');
for (const d of [CACHE, SUBS_DIR, path.join(CACHE, 'keyframes'), path.join(CACHE, 'fingerprints')]) fs.mkdirSync(d, { recursive: true });

export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function getSetting(k, def = '') {
  const r = get('SELECT v FROM settings WHERE k=?', k);
  return r ? r.v : def;
}
export function setSetting(k, v) {
  run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v));
}
export const now = () => Math.floor(Date.now() / 1000);
