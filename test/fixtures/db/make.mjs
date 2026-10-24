// Fixturer för uppgraderingstesterna (test/upgrade.test.js): databaser skapade av äldre versioner av BraXhn TV.
//
// För varje version i VERSIONS packas server/, web/ och package.json från den git-revisionen upp i en tmp-mapp.
// Den gamla servern startas mot en tom CONFIG_DIR (så att varje modul skapar sina tabeller precis som hos en
// användare), första kontot skapas och loggas in via API:t (riktig lösenordshash och apptoken), och servern
// stoppas. Sedan fylls databasen med representativ data via SQL – bara tabeller och kolumner som finns i
// den versionens schema – och dumpas som SQL-text till test/fixtures/db/<version>.sql.
//
// Lägga till en version: lägg till { version, rev } i VERSIONS och kör
//   node test/fixtures/db/make.mjs            (alla)
//   node test/fixtures/db/make.mjs 0.9.3      (en)
// Kräver git-historiken (inte en grund klon) och Node 22+. Fixturerna checkas in; testet kör inte git.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

export const VERSIONS = [
  { version: '0.5.0', rev: '91dea16' },  // äldsta commit i historiken
  { version: '0.5.1', rev: 'v0.5.1' },
  { version: '0.6.1', rev: 'bde94b4' },  // routes uppdelade, skärmtid och flera versioner av filmer
  { version: '0.7.0', rev: '907ac31' },  // säkerhetskopia före uppgradering, "håll mig inloggad"
  { version: '0.8.2', rev: '8559d53' },
  { version: '0.9.3', rev: 'ef9ac0f' },  // senaste utgåvan
];
export const USER = 'anna', PASSWORD = 'Uppgradering-Test-2026!';

// ---- dumpa/läsa SQL-text (inget sqlite3-program behövs) ----
const lit = (v) => v === null ? 'NULL'
  : typeof v === 'number' || typeof v === 'bigint' ? String(v)
  : v instanceof Uint8Array ? `X'${Buffer.from(v).toString('hex')}'`
  : `'${String(v).replace(/'/g, "''")}'`;

/** Hela databasen som SQL: tabeller med rader, sedan index/vyer/utlösare, sist user_version. sqlite_* utelämnas. */
export function dumpSql(db) {
  const out = ['BEGIN;'];
  const objs = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  for (const t of objs.filter(o => o.type === 'table')) {
    out.push(t.sql + ';');
    const q = `"${t.name.replace(/"/g, '""')}"`;
    for (const r of db.prepare(`SELECT * FROM ${q} ORDER BY rowid`).all()) {
      out.push(`INSERT INTO ${q}(${Object.keys(r).map(k => `"${k}"`).join(',')}) VALUES(${Object.values(r).map(lit).join(',')});`);
    }
  }
  for (const o of objs.filter(o => o.type !== 'table')) out.push(o.sql + ';');
  out.push(`PRAGMA user_version=${db.prepare('PRAGMA user_version').get().user_version};`, 'COMMIT;');
  return out.join('\n') + '\n';
}
/** Skapar databasfilen file från SQL-text (från dumpSql). */
export function loadSql(file, sql) {
  // Tabellerna kommer i skapandeordning, inte i beroendeordning (node:sqlite slår annars på främmande nycklar)
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  try { db.exec(sql); } finally { db.close(); }
}
/** Metadata som make.mjs skriver i fixturens första rad. */
export const fixtureMeta = (sql) => JSON.parse(/^-- fixtur: (.*)$/m.exec(sql)[1]);

// ---- generera ----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const git = (...a) => execFileSync('git', a, { cwd: REPO, maxBuffer: 1 << 28 });

async function startOld(dir, config, port) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: dir, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(port), HTTPS_PORT: String(port + 1), CONFIG_DIR: config,
      MEDIA_ROOT: path.join(dir, 'media'), TRANSCODE_DIR: path.join(dir, 'tc'), SCAN_INTERVAL: '0' } });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return p; } catch {}
    if (p.exitCode !== null) throw new Error('den gamla servern avslutades');
    await sleep(200);
  }
  throw new Error('den gamla servern startade inte');
}
async function stop(p) {
  if (p.exitCode !== null) return;
  const done = new Promise(r => p.once('exit', r));
  process.kill(p.pid, 'SIGTERM');
  await Promise.race([done, sleep(5000)]);
  if (p.exitCode === null && p.signalCode === null) { process.kill(p.pid, 'SIGKILL'); await done; }
}

// Lägger in en rad med bara de kolumner som finns. NOT NULL-kolumner utan standardvärde som inte angetts
// får ett värde efter sin typ. Saknas tabellen hoppas raden över. Returnerar rowid (eller null).
function inserter(db) {
  const info = new Map();
  const colsOf = (t) => {
    if (!info.has(t)) info.set(t, db.prepare(`PRAGMA table_info("${t}")`).all());
    return info.get(t);
  };
  return (t, row) => {
    const cols = colsOf(t);
    if (!cols.length) return null;
    const r = {};
    for (const c of cols) {
      if (c.name in row) r[c.name] = row[c.name];
      else if (c.notnull && c.dflt_value === null && !(c.pk && /^INTEGER$/i.test(c.type))) r[c.name] = /INT|REAL/i.test(c.type) ? 0 : 'x';
    }
    const k = Object.keys(r);
    return Number(db.prepare(`INSERT INTO "${t}"(${k.map(x => `"${x}"`).join(',')}) VALUES(${k.map(() => '?').join(',')})`)
      .run(...Object.values(r)).lastInsertRowid);
  };
}

function fill(db) {
  const ins = inserter(db), T = 1760000000; // fasta tider så att fixturerna blir stabila
  const admin = db.prepare('SELECT * FROM users WHERE name=?').get(USER);
  ins('users', { name: 'Bertil', pass: admin.pass, is_admin: 0, created: T, remote_allowed: 0, color: '#3a7' });
  const kid = ins('users', { name: 'Lilla Ö', pass: admin.pass, is_admin: 0, created: T, parent_id: admin.id, max_age: 7, color: '#e55',
    screen_time: '{"daily":60}' });
  const lib = {};
  for (const [name, type] of [['Filmer', 'movie'], ['Serier', 'show'], ['Musik', 'music'], ['Ljudböcker', 'audiobook']]) {
    try { lib[type] = ins('libraries', { name, type, path: `/finns-inte/braxhn-uppgradering/${name}`, anime: 0 }); } catch {} // typen saknas i den versionen
  }
  const coll = ins('collections', { name: 'Samlingen', overview: 'Två filmer' });
  const it = (o) => ins('items', { library_id: lib.movie, meta_done: 1, added: T, mtime: T, size: 1000, ...o });
  const m1 = it({ kind: 'movie', title: 'Fönstret mot gården', sort_title: 'fonstret mot garden', year: 1954, path: '/finns-inte/Filmer/Fönstret (1954).mkv',
    duration: 6720.5, container: 'matroska', vcodec: 'h264', acodec: 'ac3', width: 1920, height: 1080, tmdb_id: 567, rating: 8.3,
    overview: "En fotograf med gipsat ben – \"Jeff\" – ser något han inte borde.\nRad två.", genres: '["Thriller"]', cert: '11', age: 11,
    collection_id: coll, intro_start: null, chapters: '[{"t":0,"n":"Början"}]', streams: '[{"type":"video","codec":"h264"}]' });
  const m2 = it({ kind: 'movie', title: "Bröderna Lejonhjärta", year: 1977, path: '/finns-inte/Filmer/Bröderna (1977).mp4', duration: 6480,
    tmdb_id: 11034, cert: '7', age: 7, collection_id: coll });
  it({ kind: 'movie', title: 'Bröderna Lejonhjärta', year: 1977, path: '/finns-inte/Filmer/Bröderna (1977) 4K.mkv', duration: 6480, version_of: m2 });
  const show = ins('items', { library_id: lib.show, kind: 'show', title: 'Serien', year: 2020, tmdb_id: 999, meta_done: 1, added: T, src_name: 'Serien' });
  const eps = [1, 2, 3].map(n => ins('items', { library_id: lib.show, kind: 'episode', parent_id: show, title: `Avsnitt ${n}`, season: 1, episode: n,
    path: `/finns-inte/Serier/Serien/Season 1/Serien S01E0${n}.mkv`, duration: 1500, added: T + n, mtime: T, intro_start: 15, intro_end: 45,
    credits_start: 1400, markers_done: 1 }));
  const prog = (user_id, item_id, position, watched) => ins('progress', { user_id, item_id, position, duration: 1500, watched, updated: T + item_id });
  prog(admin.id, m1, 1234.5, 0); prog(admin.id, eps[0], 1500, 1); prog(admin.id, eps[1], 300.25, 0); prog(kid, m2, 60, 0);
  ins('watchlist', { user_id: admin.id, item_id: m2, added: T });
  ins('continue_hidden', { user_id: admin.id, item_id: show, at: T });
  for (const [k, v] of [['scan_interval', '120'], ['public_url', 'https://tv.exempel.se'], ['lang', 'sv'], ['tmdb_key', '']]) {
    db.prepare('INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)').run(k, v);
  }
  // Musik
  if (lib.music) {
    const ar = ins('artists', { library_id: lib.music, name: 'Artisten', sort_name: 'artisten' });
    const al = ins('albums', { library_id: lib.music, artist_id: ar, title: 'Skivan', year: 1999, genre: 'Pop', dir: '/finns-inte/Musik/Skivan', added: T });
    const tr = [1, 2].map(n => ins('tracks', { library_id: lib.music, album_id: al, artist_id: ar, title: `Låt ${n}`, track_no: n, disc_no: 1, duration: 200,
      path: `/finns-inte/Musik/Skivan/0${n}.flac`, size: 100, mtime: T, codec: 'flac', added: T, rg_track: -6.5 }));
    const pl = ins('playlists', { user_id: admin.id, name: 'Favoriter', created: T });
    tr.forEach((t, i) => ins('playlist_items', { playlist_id: pl, track_id: t, pos: i }));
    ins('track_plays', { user_id: admin.id, track_id: tr[0], ts: T });
    ins('favorites', { user_id: admin.id, track_id: tr[1] });
  }
  if (lib.audiobook && db.prepare("SELECT 1 FROM sqlite_master WHERE name='books'").get()) {
    const b = ins('books', { library_id: lib.audiobook, key: 'boken', title: 'Boken', author: 'Författaren', path: '/finns-inte/Ljudböcker/Boken', duration: 36000, added: T });
    ins('book_files', { book_id: b, path: '/finns-inte/Ljudböcker/Boken/01.mp3', idx: 0, duration: 36000 });
    ins('book_progress', { user_id: admin.id, book_id: b, position: 4321, updated: T });
    ins('bookmarks', { user_id: admin.id, book_id: b, position: 100, note: 'Här', created: T });
  }
  const pod = ins('podcasts', { url: 'https://exempel.se/pod.xml', title: 'Podden', added_by: admin.id, added: T });
  if (pod) {
    const pe = ins('podcast_episodes', { podcast_id: pod, guid: 'ep1', title: 'Första', url: 'https://exempel.se/1.mp3', published: T, duration: 1800, added: T });
    ins('podcast_progress', { user_id: admin.id, episode_id: pe, position: 900, updated: T });
  }
  const person = ins('people', { id: 4070, name: 'Grace Kelly' });
  if (person) ins('item_people', { item_id: m1, person_id: person, role: 'cast', character: 'Lisa', ord: 0 });
  ins('plays', { user_id: admin.id, item_id: m1, ts: T, mode: 'remux', remote: 0, device: 'Webb' });
  ins('follows', { user_id: admin.id, show_id: show, added: T });
  ins('new_episodes', { user_id: admin.id, show_id: show, season: 1, episode: 3, item_id: eps[2], added: T });
}

async function make({ version, rev }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bxtv-fixtur-${version}-`));
  try {
    execFileSync('tar', ['-x', '-C', dir], { input: git('archive', rev, 'server', 'web', 'package.json') });
    const real = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    if (real !== version) throw new Error(`${rev} har version ${real}, inte ${version}`);
    fs.mkdirSync(path.join(dir, 'media'));
    const config = path.join(dir, 'config'), port = 19000 + Math.floor(Math.random() * 900) * 2;
    const p = await startOld(dir, config, port);
    let appToken;
    try {
      const B = `http://127.0.0.1:${port}`, json = { 'content-type': 'application/json' };
      const s = await fetch(B + '/api/setup', { method: 'POST', headers: json, body: JSON.stringify({ name: USER, password: PASSWORD }) });
      if (!s.ok) throw new Error('setup: ' + await s.text());
      const l = await fetch(B + '/api/login', { method: 'POST', headers: json, body: JSON.stringify({ name: USER, password: PASSWORD, app: true }) });
      appToken = (await l.json()).token;
      if (!appToken) throw new Error('ingen apptoken');
    } finally { await stop(p); }
    const db = new DatabaseSync(path.join(config, 'braxhn-tv.db'));
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('BEGIN'); fill(db); db.exec('COMMIT');
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error('främmande nycklar: ' + JSON.stringify(bad));
    const meta = { version, rev: git('rev-parse', '--short', rev).toString().trim(), user: USER, password: PASSWORD, appToken };
    const sql = `-- fixtur: ${JSON.stringify(meta)}\n-- Skapad av test/fixtures/db/make.mjs med BraXhn TV ${version} – redigera inte för hand.\n` + dumpSql(db);
    db.close();
    fs.writeFileSync(path.join(HERE, `${version}.sql`), sql);
    console.log(`${version}.sql: ${(sql.length / 1024).toFixed(1)} kB`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const want = process.argv.slice(2);
  for (const v of VERSIONS.filter(v => !want.length || want.includes(v.version))) await make(v);
}
