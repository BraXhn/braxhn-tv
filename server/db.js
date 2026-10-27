import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { searchKey, compactKey } from './searchkey.js';

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
// Webbinloggning: 1 = håll inloggad i 30 dagar, 0 = bara tills webbläsaren stängs (och högst 12 h utan aktivitet)
addCol('sessions', 'remember', 'INTEGER NOT NULL DEFAULT 1');
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
// Bio-läge: trailers/förfilm före filmer (JSON per användare, server/cinema.js)
addCol('users', 'cinema', 'TEXT');
// Uppspelningsval: ljud-/undertextspråk, undertextläge, automatisk överhoppning, nästa avsnitt och standardkvalitet
// (JSON per användare, server/playprefs.js)
addCol('users', 'playback_prefs', 'TEXT');
// Platshållarfärg per bild ('#rrggbb', '' = kunde inte läsas, NULL = inte uträknad) – server/imgcolor.js
addCol('items', 'poster_color', 'TEXT');
addCol('items', 'backdrop_color', 'TEXT');
addCol('items', 'thumb_color', 'TEXT');
// Premiärdatum från TMDB ('YYYY-MM-DD', hyllan "Den här dagen") och startsidans egen ordning per användare (JSON, server/homeshelves.js)
addCol('items', 'released', 'TEXT');
addCol('users', 'home_layout', 'TEXT');
// Rättigheter per användare (server/perms.js): libraries = JSON-lista med biblioteks-id (NULL = alla; profiler ärver kontots),
// can_download = originalfil/offline/musikappars nedladdning, remote_quality = kvalitetstak utanför hemmet (NULL = serverns),
// max_streams = högsta antal samtidiga videoströmmar för hushållet (NULL = obegränsat)
addCol('users', 'libraries', 'TEXT');
addCol('users', 'can_download', 'INTEGER NOT NULL DEFAULT 1');
addCol('users', 'remote_quality', 'TEXT');
addCol('users', 'max_streams', 'INTEGER');
// Inbjudningslänkar (server/invites.js): token lagras bara som SHA-256, perms = förvalda rättigheter (JSON), engångs
db.exec(`CREATE TABLE IF NOT EXISTS invites(id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created INTEGER NOT NULL, expires INTEGER NOT NULL, perms TEXT NOT NULL, note TEXT, used_at INTEGER, used_by INTEGER REFERENCES users(id) ON DELETE SET NULL, used_name TEXT);`);
// "Ta bort från Fortsätt titta" för en serie: döljer nästa avsnitt tills man tittar på serien igen (progress.updated > at)
db.exec(`CREATE TABLE IF NOT EXISTS continue_hidden(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, at INTEGER NOT NULL, PRIMARY KEY(user_id,item_id));`);
// Scrobbling av musik per person (ListenBrainz/Last.fm): kopplingen (token/sessionsnyckel – lämnas aldrig ut i API:t)
// och kön med lyssningar. En rad i kön blir en lyssning när due passerats (spåret spelat ≥ 50 % eller 4 min);
// raden tas bort när tjänsten tagit emot den, annars nytt försök vid next_try.
db.exec(`CREATE TABLE IF NOT EXISTS scrobble_accounts(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, service TEXT NOT NULL,
  secret TEXT NOT NULL, username TEXT, error TEXT, connected INTEGER NOT NULL, last_ok INTEGER, PRIMARY KEY(user_id, service));
CREATE TABLE IF NOT EXISTS scrobble_queue(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, service TEXT NOT NULL,
  track_id INTEGER, artist TEXT NOT NULL, title TEXT NOT NULL, album TEXT, album_artist TEXT, duration INTEGER, track_no INTEGER,
  listened_at INTEGER NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, error TEXT,
  UNIQUE(user_id, service, listened_at, title));`);
// Smarta spellistor med egna regler (server/smartlists.js): def = reglerna som JSON (vitlistade fält/operatorer),
// shared = synlig för alla användare på servern, updated i ms (nyckel i den korta resultatcachen)
db.exec(`CREATE TABLE IF NOT EXISTS smart_playlists(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, def TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS smartpl_user ON smart_playlists(user_id);`);
// Egna samlingar (filmer och serier): delade (alla profiler, skapas av administratörer) eller privata (bara skaparen).
// sort: manual (pos), title, year eller added (när titeln lades i samlingen). on_home = visas som hylla på startsidan.
db.exec(`CREATE TABLE IF NOT EXISTS custom_collections(id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, overview TEXT, shared INTEGER NOT NULL DEFAULT 0, sort TEXT NOT NULL DEFAULT 'manual', on_home INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS custom_collection_items(collection_id INTEGER NOT NULL REFERENCES custom_collections(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, pos INTEGER NOT NULL, added INTEGER NOT NULL, PRIMARY KEY(collection_id,item_id));`);
// Kalender för kommande och saknade avsnitt (server/calendar.js): seriens status hos TMDB, avsnitten med sändningsdatum
// och den personliga kalendertoken för iCal-prenumerationen (egen tabell – den är ingen inloggning och når inget annat API)
db.exec(`CREATE TABLE IF NOT EXISTS calendar_shows(show_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL, status TEXT, network TEXT, next_air TEXT, last_air TEXT, fetched INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS calendar_episodes(show_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  season INTEGER NOT NULL, episode INTEGER NOT NULL, name TEXT, air_date TEXT, PRIMARY KEY(show_id, season, episode));
CREATE TABLE IF NOT EXISTS calendar_tokens(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, last_used INTEGER);`);
// Ljudböckernas metadata från nätet (bookmeta.js) och för hand. Egen tabell bredvid books (som skannern äger och skriver om
// från taggarna): state 0 = inte försökt, 1 = matchad, 2 = ingen träff (tried = senaste försöket); locked = vald för hand
// ("Fel bok?"), hämtas aldrig om automatiskt; edits = JSON med fält som administratören ändrat ('' = tömt) och som går före allt annat;
// chapters = kapitel från Audnexus (används bara när filen saknar egna); cover_net = omslaget hämtades från källan.
db.exec(`CREATE TABLE IF NOT EXISTS book_meta(book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  state INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, tried INTEGER, source TEXT, source_id TEXT, src_title TEXT,
  subtitle TEXT, narrator TEXT, description TEXT, publisher TEXT, year INTEGER, isbn TEXT, asin TEXT, language TEXT, genres TEXT,
  series TEXT, series_no TEXT, chapters TEXT, cover_net INTEGER NOT NULL DEFAULT 0, edits TEXT);`);
// Musikappar (Subsonic/OpenSubsonic, server/subsonic.js): ett app-lösenord per användare/profil. enc = lösenordet krypterat
// med AES-256-GCM och nyckeln i /config/subsonic.key (md5-inloggningen behöver klartexten), key_hash = SHA-256 för
// klartext-/apiKey-inloggning. Stjärnor på album och artister (spår använder favorites som webben).
db.exec(`CREATE TABLE IF NOT EXISTS subsonic_passwords(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enc TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, created_ip TEXT, trusted INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER, last_ip TEXT, client TEXT);
CREATE TABLE IF NOT EXISTS album_stars(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE, created INTEGER NOT NULL, PRIMARY KEY(user_id, album_id));
CREATE TABLE IF NOT EXISTS artist_stars(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE, created INTEGER NOT NULL, PRIMARY KEY(user_id, artist_id));`);
addCol('favorites', 'created', 'INTEGER');
addCol('playlists', 'comment', 'TEXT');
addCol('playlists', 'changed', 'INTEGER');
// Ljudanalys av musik (server/sonic.js): ver = analysens version (sonic-dsp.js VERSION), mtime = spårfilens mtime vid
// analysen (ändrad fil → analyseras om), ok = 0 om filen inte gick att analysera, ms = tid för analysen.
// vec = egenskaperna som Float32-vektor (DIMS i sonic-dsp.js); bpm/energy (0–100)/speech/key även som kolumner för
// visning och smarta spellistor.
db.exec(`CREATE TABLE IF NOT EXISTS track_sonic(track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  ver INTEGER NOT NULL, mtime INTEGER, analyzed INTEGER NOT NULL, ok INTEGER NOT NULL DEFAULT 1, ms INTEGER,
  bpm REAL, energy REAL, speech REAL, key TEXT, vec BLOB);`);
// Uppspelningshistorik (activity.js, playstats.js). Tabellen skapades tidigare i activity.js – den skapas här så att
// de nya kolumnerna når befintliga databaser. En rad = en tittning (samma titel inom 30 min slås ihop): ts = start,
// ended = senaste aktivitet, played = sekunder som faktiskt spelats, pos_start/pos_end = position i filen,
// kbps = uppskattad bithastighet (omkodningens steg eller filens), title/kind/show_*/library_id = kopia av titeln
// (historiken finns kvar när filen tas bort).
db.exec(`CREATE TABLE IF NOT EXISTS plays(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, item_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  mode TEXT, remote INTEGER, device TEXT);`);
for (const [c, def] of [['ended', 'INTEGER'], ['played', 'REAL NOT NULL DEFAULT 0'], ['pos_start', 'REAL'], ['pos_end', 'REAL'], ['ip', 'TEXT'],
  ['quality', 'TEXT'], ['kbps', 'INTEGER'], ['duration', 'REAL'], ['title', 'TEXT'], ['kind', 'TEXT'], ['year', 'INTEGER'], ['season', 'INTEGER'],
  ['episode', 'INTEGER'], ['show_id', 'INTEGER'], ['show_title', 'TEXT'], ['library_id', 'INTEGER']]) addCol('plays', c, def);
// Webhooks (webhooks.js): user_id NULL = serverns (administratören, alla händelser), annars personens egna händelser.
// secret = HMAC-nyckeln för X-BraXhn-Signature (visas bara när den skapas). allow_local = administratören har uttryckligen
// tillåtit en adress i hemnätet (Home Assistant). Kön har omförsök med backoff; loggen sparar de senaste leveranserna.
db.exec(`CREATE TABLE IF NOT EXISTS webhooks(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  url TEXT NOT NULL, events TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'json', secret TEXT NOT NULL, allow_local INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, last_ok INTEGER, last_error TEXT);
CREATE TABLE IF NOT EXISTS webhook_queue(id INTEGER PRIMARY KEY, hook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, event TEXT NOT NULL,
  body TEXT NOT NULL, created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS webhook_log(id INTEGER PRIMARY KEY, hook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, event TEXT NOT NULL,
  ts INTEGER NOT NULL, status INTEGER, ok INTEGER NOT NULL, error TEXT, attempt INTEGER NOT NULL, ms INTEGER);`);
// Musikmetadata från nätet (server/musicmeta.js). artist_meta: state 0 = inte försökt, 1 = matchad mot MusicBrainz (mbid),
// 2 = ingen säker träff (tried = senaste försöket); locked = vald för hand ("Fel artist?"); kind = Person/Group …,
// life_begin/life_end = född/bildad och död/upplöst (ÅÅÅÅ[-MM[-DD]]); genres/links/related = JSON; bio från Wikipedia
// (bio_lang sv/en, bio_url = artikeln); image/backdrop = 1 när bilden finns i /config/images (ar<id>-photo/-bg.jpg).
// album_meta: releasegruppen i MusicBrainz (kind = album/single/ep/compilation/live …) och beskrivningen från Wikipedia.
// track_lyrics: låttexter från LRCLIB (state 1 = hittad, 2 = ingen; fetched = när), bara när filen saknar egen text.
db.exec(`CREATE TABLE IF NOT EXISTS artist_meta(artist_id INTEGER PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
  state INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, tried INTEGER, fetched INTEGER, mbid TEXT, mb_name TEXT, kind TEXT,
  disambiguation TEXT, country TEXT, area TEXT, begin_area TEXT, life_begin TEXT, life_end TEXT, ended INTEGER NOT NULL DEFAULT 0,
  genres TEXT, links TEXT, related TEXT, bio TEXT, bio_lang TEXT, bio_url TEXT, wikidata TEXT, lastfm_url TEXT,
  image INTEGER NOT NULL DEFAULT 0, image_src TEXT, backdrop INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS album_meta(album_id INTEGER PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  mbid TEXT, kind TEXT, released TEXT, description TEXT, desc_lang TEXT, desc_url TEXT, tried INTEGER);
CREATE TABLE IF NOT EXISTS track_lyrics(track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  state INTEGER NOT NULL, fetched INTEGER NOT NULL, synced INTEGER NOT NULL DEFAULT 0, instrumental INTEGER NOT NULL DEFAULT 0,
  lyrics TEXT, source TEXT, ext_id TEXT);`);
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
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);
CREATE INDEX IF NOT EXISTS tracks_lib_added ON tracks(library_id, added);
CREATE INDEX IF NOT EXISTS scrobble_due ON scrobble_queue(due, next_try);
CREATE INDEX IF NOT EXISTS scrobble_user ON scrobble_queue(user_id, due);
CREATE INDEX IF NOT EXISTS cc_owner ON custom_collections(owner_id);
CREATE INDEX IF NOT EXISTS cci_item ON custom_collection_items(item_id);
CREATE INDEX IF NOT EXISTS calendar_ep_air ON calendar_episodes(air_date);
CREATE INDEX IF NOT EXISTS album_stars_album ON album_stars(album_id);
CREATE INDEX IF NOT EXISTS artist_stars_artist ON artist_stars(artist_id);
CREATE INDEX IF NOT EXISTS albums_lib_sort ON albums(library_id, sort_title);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS sonic_ver ON track_sonic(ver);
CREATE INDEX IF NOT EXISTS plays_ts ON plays(ts);
CREATE INDEX IF NOT EXISTS plays_user ON plays(user_id, ts);
CREATE INDEX IF NOT EXISTS plays_item ON plays(item_id);
CREATE INDEX IF NOT EXISTS plays_show ON plays(show_id);
CREATE INDEX IF NOT EXISTS webhooks_user ON webhooks(user_id);
CREATE INDEX IF NOT EXISTS whq_due ON webhook_queue(next_try);
CREATE INDEX IF NOT EXISTS whq_hook ON webhook_queue(hook_id, id);
CREATE INDEX IF NOT EXISTS whlog_hook ON webhook_log(hook_id, id);
CREATE INDEX IF NOT EXISTS artist_meta_mbid ON artist_meta(mbid);`);

// Originaltitel från TMDB (sökbar: "Le Fabuleux Destin d'Amélie Poulain" hittar Amélie)
addCol('items', 'original_title', 'TEXT');

// Flera mappar per bibliotek (server/libpaths.js): alla mappar i ordning. Saknas rader gäller libraries.path,
// som alltid är den första mappen (apparna och äldre versioner läser bara den).
db.exec(`CREATE TABLE IF NOT EXISTS library_paths(library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path TEXT NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY(library_id, path));`);
// Lokal metadata (server/localmeta.js): nfo = 1 läser Kodi/Jellyfin-NFO, home_video = 1 är hemvideor (ingen TMDB,
// titel från filnamnet, datum från filen, mappar som navigering)
addCol('libraries', 'nfo', 'INTEGER NOT NULL DEFAULT 1');
addCol('libraries', 'home_video', 'INTEGER NOT NULL DEFAULT 0');
// items.nfo = den tolkade NFO-filen (JSON), nfo_sig = fil|ändringstid|storlek, local_img = JSON typ → signatur för lokala bilder
addCol('items', 'nfo', 'TEXT');
addCol('items', 'nfo_sig', 'TEXT');
addCol('items', 'local_img', 'TEXT');
addCol('items', 'studio', 'TEXT');
addCol('items', 'premiered', 'TEXT');
addCol('items', 'imdb_id', 'TEXT');
// Hemvideor: inspelningsdatum (unix-sekunder) och mappen relativt biblioteksmappen ('' = direkt i mappen)
addCol('items', 'taken', 'INTEGER');
addCol('items', 'folder', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS items_folder ON items(library_id, folder)');
// Bibliotekens filter (server/libfilter.js): ljud-/undertextspråk (',sv,en,'), flest ljudkanaler och Atmos/DTS:X per fil,
// räknade ur streams och undertextfilerna. f_v = beräkningens version, NULL = räknas om (utlösaren nedan när filen ändras).
addCol('items', 'f_alang', 'TEXT');
addCol('items', 'f_slang', 'TEXT');
addCol('items', 'f_ach', 'INTEGER');
addCol('items', 'f_atmos', 'INTEGER');
addCol('items', 'f_v', 'INTEGER');
db.exec(`CREATE INDEX IF NOT EXISTS items_facets_todo ON items(id) WHERE f_v IS NULL AND path IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS items_facets_upd AFTER UPDATE OF streams, path ON items WHEN NEW.f_v IS NOT NULL
BEGIN UPDATE items SET f_v=NULL WHERE id=NEW.id; END;`);
// Smarta samlingar (server/customcollections.js): kind 'smart' = innehållet räknas fram vid visning ur def
// (JSON { library, query } – bibliotekets filter som adressdel, libfilter.js); 'manual' = titlarna i custom_collection_items
addCol('custom_collections', 'kind', "TEXT NOT NULL DEFAULT 'manual'");
addCol('custom_collections', 'def', 'TEXT');
// Fotobibliotek (server/photos.js). libraries.kids = 1: barnprofiler får se biblioteket (foton har ingen åldersgräns,
// standard nej). photos: en rad per bild eller videoklipp. taken = när bilden togs som lokal väggklocka räknad som
// UTC-sekunder (EXIF har ingen tidszon – 14:05 i Stockholm sparas som 14:05 UTC), day = 'YYYY-MM-DD' och md = 'MM-DD'
// ur samma tid (tidslinjen och "Den här dagen"). folder = mappen relativt biblioteksmappen ('' = direkt i den).
// width/height = så som bilden visas (efter orientation), orientation = EXIF 1–8 (tillämpas när miniatyrer görs).
// item_id = videoklippets rad i items (spelas med den vanliga spelaren). thumb 0 = miniatyren inte gjord, 1 = klar,
// 2 = gick inte; color = platshållarfärg ('#rrggbb'). Favoriter per profil i photo_favorites.
addCol('libraries', 'kids', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path TEXT NOT NULL, folder TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'image', format TEXT,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL, size INTEGER, mtime INTEGER, taken INTEGER NOT NULL, day TEXT NOT NULL, md TEXT NOT NULL,
  width INTEGER, height INTEGER, orientation INTEGER NOT NULL DEFAULT 1, duration REAL, make TEXT, model TEXT, lens TEXT,
  fnumber REAL, exposure REAL, iso INTEGER, focal REAL, focal35 INTEGER, lat REAL, lon REAL, alt REAL,
  thumb INTEGER NOT NULL DEFAULT 0, color TEXT, added INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS photo_favorites(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE, created INTEGER NOT NULL, PRIMARY KEY(user_id, photo_id));
CREATE UNIQUE INDEX IF NOT EXISTS photos_path ON photos(library_id, path);
CREATE INDEX IF NOT EXISTS photos_taken ON photos(library_id, taken);
CREATE INDEX IF NOT EXISTS photos_day ON photos(library_id, day);
CREATE INDEX IF NOT EXISTS photos_md ON photos(md, library_id);
CREATE INDEX IF NOT EXISTS photos_folder ON photos(library_id, folder);
CREATE INDEX IF NOT EXISTS photos_thumb ON photos(thumb);
CREATE INDEX IF NOT EXISTS photos_item ON photos(item_id);
CREATE INDEX IF NOT EXISTS photo_fav_photo ON photo_favorites(photo_id);`);

// Fotobibliotek (server/photos.js): libraries.type får även 'photo'. SQLite kan inte ändra en CHECK-begränsning, så
// tabellen byggs om med samma kolumner (även de som addCol lagt till) och alla rader. Främmande nycklar stängs av under
// ombyggnaden – annars skulle DROP TABLE ta bort alla titlar, låtar och böcker (ON DELETE CASCADE) – och kontrolleras
// efteråt i samma transaktion. Körs en gång (user_version 6) och bara om CHECK-listan saknar 'photo'.
function allowPhotoLibraries() {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='libraries'").get().sql;
  if (/'photo'/.test(sql)) return;
  const check = /CHECK\s*\(\s*type\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sql);
  if (!check) throw new Error('[db] libraries: hittar inte typbegränsningen');
  const newSql = sql.replace(check[0], `CHECK(type IN(${check[1].trim()},'photo'))`).replace(/^CREATE TABLE\s+("?)libraries\1/i, 'CREATE TABLE libraries_new');
  const names = db.prepare('PRAGMA table_info(libraries)').all().map(c => `"${c.name.replace(/"/g, '""')}"`).join(',');
  const before = db.prepare('SELECT COUNT(*) AS n FROM libraries').get().n;
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`DROP TABLE IF EXISTS libraries_new; ${newSql}; INSERT INTO libraries_new(${names}) SELECT ${names} FROM libraries;
        DROP TABLE libraries; ALTER TABLE libraries_new RENAME TO libraries;`);
      if (db.prepare('SELECT COUNT(*) AS n FROM libraries').get().n !== before) throw new Error('antalet bibliotek stämmer inte');
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`${broken.length} brutna främmande nycklar (${[...new Set(broken.map(b => b.table))].join(', ')})`);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  } finally { db.exec('PRAGMA foreign_keys=ON'); }
}
// Redigerad metadata (server/itemmeta.js): locked = JSON fält → administratörens värde för låsta fält, img_locked = JSON
// bildtyp → 'tmdb:<sökväg>' | 'upload' för vald/uppladdad bild, logo = 1 när titeln har en logotyp (<id>-logo.png).
// Utlösaren skriver tillbaka de låsta värdena efter varje ändring av fälten, så att ingen väg (TMDB, NFO, filnamnet,
// en äldre programversion) kan skriva över dem. SQLite kör inte om utlösaren för sin egen UPDATE (recursive_triggers av).
addCol('items', 'tagline', 'TEXT');
addCol('items', 'locked', 'TEXT');
addCol('items', 'img_locked', 'TEXT');
addCol('items', 'logo', 'INTEGER NOT NULL DEFAULT 0');
{
  const F = ['title', 'sort_title', 'original_title', 'year', 'released', 'premiered', 'overview', 'genres', 'studio', 'cert', 'age', 'rating', 'tagline', 'season', 'episode'];
  const set = F.map(f => `${f}=CASE WHEN json_type(NEW.locked,'$.${f}') IS NULL THEN ${f} ELSE json_extract(NEW.locked,'$.${f}') END`).join(', ');
  const sql = `CREATE TRIGGER items_locked_upd AFTER UPDATE OF ${F.join(', ')}, locked ON items WHEN NEW.locked IS NOT NULL AND json_valid(NEW.locked)
BEGIN UPDATE items SET ${set} WHERE id=NEW.id; END`;
  // Skapas om bara när listan ändrats (en andra start ska inte ändra databasen)
  if (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='items_locked_upd'").get()?.sql !== sql) db.exec(`DROP TRIGGER IF EXISTS items_locked_upd; ${sql};`);
}

// Versionsmigreringar körs i tur och ordning så att även uppgradering från mycket gamla versioner får alla steg
const LATEST = 6;
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
if (ver < 6) {
  // Fotobibliotek: libraries.type tillåter 'photo' (allowPhotoLibraries ovan)
  allowPhotoLibraries();
  ver = 6;
}
if (ver !== db.prepare('PRAGMA user_version').get().user_version) db.exec(`PRAGMA user_version=${Math.max(ver, LATEST)}`);
// Äldre programversion mot en nyare databas (t.ex. efter återgång till en gammal image): fungerar oftast,
// men nya kolumner och tabeller används inte – varna tydligt
if (ver > LATEST) console.warn(`[db] Databasen kommer från en nyare version av BraXhn TV (schema ${ver} > ${LATEST}). Uppdatera imagen – eller återställ backups/före-uppgradering-*.db om du vill gå tillbaka.`);
try { db.prepare("INSERT INTO settings(k,v) VALUES('app_version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(globalThis.__braxhnAppVersion); } catch {}

// ---- söknycklar (searchkey.js) ----
// skey = normaliserad titel/namn med ord, skey2 = ev. andra sökbara fält (originaltitel, författare …), skeyc = båda i
// kompakt form ("spiderman lefabuleux…", för förurvalet i SQL utan replace() per rad). En utlösare i ren SQL
// nollställer skey när källfälten ändras och refreshKeys() räknar om de nollställda (vid start, efter skanning och
// före varje sökning). Så hålls nyckeln aktuell vid alla ställen som skriver titlar – även andra anslutningar
// (tester, sqlite3) och en äldre programversion kan skriva i tabellerna, eftersom utlösaren inte anropar JS.
const SEARCH_TABLES = new Map(); // tabell → { a: kolumner till skey, b: kolumner till skey2 }
const ident = (s) => { if (!/^[a-z_]+$/.test(s)) throw new Error('ogiltigt namn: ' + s); return s; };
/** Gör tabellen sökbar: kolumner via addCol, index, utlösare och nycklar för befintliga rader (i tx). Tabeller som
 *  skapas i andra moduler anropar den direkt efter sin CREATE TABLE. */
export function searchKeys(table, a, b = []) {
  ident(table); [...a, ...b].forEach(ident);
  addCol(table, 'skey', 'TEXT');
  if (b.length) addCol(table, 'skey2', 'TEXT');
  addCol(table, 'skeyc', 'TEXT');
  const src = [...a, ...b];
  db.exec(`CREATE INDEX IF NOT EXISTS ${table}_skey ON ${table}(skey);
    CREATE TRIGGER IF NOT EXISTS ${table}_skey_upd AFTER UPDATE OF ${src.join(', ')} ON ${table}
    WHEN ${src.map(c => `old.${c} IS NOT new.${c}`).join(' OR ')} BEGIN UPDATE ${table} SET skey=NULL WHERE rowid=new.rowid; END;`);
  SEARCH_TABLES.set(table, { a, b });
  const n = refreshKeys(table, Infinity);
  if (n > 1000) console.log(`[db] söknycklar: ${n} rader i ${table}`);
}
const joinKey = (r, cols) => searchKey(cols.map(c => r[c] ?? '').join(' '));
/** Räkna om nycklar som saknas (nya eller ändrade rader). max = högst så många rader per tabell i det här anropet. */
export function refreshKeys(only = null, max = 20000) {
  let n = 0;
  for (const [t, { a, b }] of SEARCH_TABLES) {
    if (only && t !== only) continue;
    for (let left = max; left > 0;) {
      const rows = stmt(`SELECT rowid AS _id, ${[...a, ...b].join(', ')} FROM ${t} WHERE skey IS NULL LIMIT ?`).all(Math.min(5000, left));
      if (!rows.length) break;
      tx(() => {
        const st = b.length ? stmt(`UPDATE ${t} SET skey=?, skeyc=?, skey2=? WHERE rowid=?`) : stmt(`UPDATE ${t} SET skey=?, skeyc=? WHERE rowid=?`);
        for (const r of rows) {
          const k = joinKey(r, a), k2 = b.length ? joinKey(r, b) || null : null;
          const kc = compactKey(k) + (k2 ? ' ' + compactKey(k2) : '');
          b.length ? st.run(k, kc, k2, r._id) : st.run(k, kc, r._id);
        }
      });
      n += rows.length; left -= rows.length;
      if (rows.length < 5000) break;
    }
  }
  return n;
}

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

// Söknycklar för tabellerna i db.js (övriga moduler anropar searchKeys efter sin CREATE TABLE)
searchKeys('items', ['title'], ['original_title']);
searchKeys('artists', ['name']);
searchKeys('albums', ['title']);
searchKeys('tracks', ['title']);
