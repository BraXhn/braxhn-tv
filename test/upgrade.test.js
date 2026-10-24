// Uppgradering från gamla databaser: varje fixtur i test/fixtures/db/<version>.sql är en databas skapad av en äldre
// version (se make.mjs där). Den nuvarande koden öppnar den i en egen process – db.js öppnar databasen när modulen
// importeras – och ingenting får försvinna: rader, lösenord, framsteg och titlar finns kvar, schemat blir det
// senaste, en säkerhetskopia tas och en andra start ändrar ingenting. Sist startas servern och fixturens konto
// loggar in. Kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dumpSql, loadSql, fixtureMeta } from './fixtures/db/make.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXDIR = path.join(REPO, 'test', 'fixtures', 'db');
const DB_URL = pathToFileURL(path.join(REPO, 'server', 'db.js')).href;
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-upg-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const semver = (v) => v.split('.').map(Number);
const FIXTURES = fs.readdirSync(FIXDIR).filter(f => f.endsWith('.sql')).map(f => f.slice(0, -4))
  .sort((a, b) => { const x = semver(a), y = semver(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dbFile = (config) => path.join(config, 'braxhn-tv.db');
const env = (config) => ({ ...process.env, CONFIG_DIR: config, TRANSCODE_DIR: path.join(config, '..', 'tc'), MEDIA_ROOT: path.join(config, '..', 'media'),
  DVR_DIR: path.join(config, '..', 'rec'), PODCAST_DIR: path.join(config, '..', 'pod'), TMDB_API_KEY: '' });

// Läs databasen utan att ändra den (ingen WAL kvar efter att processen avslutats)
function inspect(config, fn) {
  const db = new DatabaseSync(dbFile(config), { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
function snapshot(db) {
  const counts = Object.fromEntries(tables(db).map(t => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
  return {
    counts,
    users: db.prepare('SELECT id, name, pass, is_admin FROM users ORDER BY id').all(),
    progress: db.prepare('SELECT user_id, item_id, position, watched, updated FROM progress ORDER BY user_id, item_id').all(),
    items: db.prepare('SELECT id, kind, parent_id, library_id, title, path, season, episode FROM items ORDER BY id').all(),
    libraries: db.prepare('SELECT id, name, type, path FROM libraries ORDER BY id').all(),
    settings: db.prepare("SELECT k, v FROM settings WHERE k != 'app_version' ORDER BY k").all(),
    sessions: db.prepare('SELECT token, user_id, kind FROM sessions ORDER BY token').all(),
  };
}
const schema = (db) => Object.fromEntries(tables(db).map(t => [t, db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name).sort()]));
const indexes = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(r => r.name);

// Bara db.js, i en egen process (öppnar och migrerar databasen när modulen importeras)
function openWithDbJs(config) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `await import(${JSON.stringify(DB_URL)})`],
    { env: env(config), encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, `db.js avslutades med ${r.status}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout + r.stderr;
}

async function startServer(config) {
  const port = 21000 + Math.floor(Math.random() * 900) * 2;
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: REPO, env: { ...env(config), PORT: String(port), HTTPS_PORT: String(port + 1) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return { p, base, log: () => log }; } catch {}
    if (p.exitCode !== null) break;
    await sleep(200);
  }
  await stopServer({ p });
  throw new Error('servern startade inte mot den uppgraderade databasen:\n' + log);
}
async function stopServer({ p }) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const done = new Promise(r => p.once('exit', r));
  process.kill(p.pid, 'SIGTERM');
  await Promise.race([done, sleep(5000)]);
  if (p.exitCode === null && p.signalCode === null) { process.kill(p.pid, 'SIGKILL'); await done; }
}

// Referens: en ny databas skapad av den nuvarande koden – först bara db.js, sedan hela servern (alla modulers tabeller)
const REF = path.join(ROOT, 'ref', 'config');
fs.mkdirSync(REF, { recursive: true });
openWithDbJs(REF);
const refDb = inspect(REF, db => ({ version: db.prepare('PRAGMA user_version').get().user_version, schema: schema(db), indexes: indexes(db) }));
let refFull = null;
async function fullReference() {
  if (refFull) return refFull;
  const cfg = path.join(ROOT, 'ref-full', 'config');
  fs.mkdirSync(cfg, { recursive: true });
  await stopServer(await startServer(cfg));
  return (refFull = inspect(cfg, db => ({ schema: schema(db), indexes: indexes(db) })));
}
function assertSchema(db, ref, where) {
  const s = schema(db);
  for (const [t, cols] of Object.entries(ref.schema)) {
    assert.ok(s[t], `${where}: tabellen ${t} saknas`);
    const missing = cols.filter(c => !s[t].includes(c));
    assert.deepEqual(missing, [], `${where}: kolumner saknas i ${t}`);
  }
  const idx = new Set(indexes(db));
  assert.deepEqual(ref.indexes.filter(i => !idx.has(i)), [], `${where}: index saknas`);
}

test('det finns fixturer för uppgraderingstesterna', () => {
  assert.ok(FIXTURES.length >= 4, FIXTURES.join(', '));
  for (const v of FIXTURES) assert.ok(fs.statSync(path.join(FIXDIR, `${v}.sql`)).size < 64 * 1024, `${v}.sql är för stor`);
});

for (const v of FIXTURES) {
  test(`uppgradering från ${v}: ingenting försvinner, schemat blir det senaste`, async () => {
    const sql = fs.readFileSync(path.join(FIXDIR, `${v}.sql`), 'utf8');
    const meta = fixtureMeta(sql);
    assert.equal(meta.version, v);
    const config = path.join(ROOT, v, 'config');
    fs.mkdirSync(config, { recursive: true });
    loadSql(dbFile(config), sql);
    // Apptoken gäller ett år från när fixturen skapades – flytta fram den så att testet inte åldras
    { const db = new DatabaseSync(dbFile(config)); db.prepare("UPDATE sessions SET expires=? WHERE kind='app'").run(Math.floor(Date.now() / 1000) + 86400); db.close(); }
    const before = inspect(config, db => ({ ...snapshot(db), ver: db.prepare('PRAGMA user_version').get().user_version,
      appVersion: db.prepare("SELECT v FROM settings WHERE k='app_version'").get()?.v ?? null }));
    assert.ok(before.users.some(u => u.name === meta.user), 'fixturens konto finns');
    assert.ok(before.progress.length >= 3 && before.items.length >= 5, 'fixturen har innehåll');

    // ---- första start med den nuvarande koden ----
    const log1 = openWithDbJs(config);
    const afterFirst = inspect(config, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, refDb.version, 'user_version blir den senaste');
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'inga brutna främmande nycklar');
      assertSchema(db, refDb, 'efter db.js');
      assert.equal(db.prepare("SELECT v FROM settings WHERE k='app_version'").get()?.v, VERSION);
      return { ...snapshot(db), dump: dumpSql(db) };
    });
    // Alla tabeller och rader finns kvar (inställningen app_version skrivs av db.js och jämförs inte)
    for (const [t, n] of Object.entries(before.counts)) {
      assert.equal(afterFirst.counts[t], t === 'settings' && before.appVersion === null ? n + 1 : n, `antal rader i ${t}`);
    }
    for (const k of ['users', 'progress', 'items', 'libraries', 'settings', 'sessions']) assert.deepEqual(afterFirst[k], before[k], k);

    // Säkerhetskopia före uppgradering – bara när programversionen byts
    const backups = () => { try { return fs.readdirSync(path.join(config, 'backups')).filter(f => f.startsWith('före-uppgradering-')); } catch { return []; } };
    const b1 = backups();
    if (before.appVersion !== VERSION) {
      assert.equal(b1.length, 1, `en säkerhetskopia före uppgradering (logg: ${log1})`);
      assert.ok(b1[0].startsWith(`före-uppgradering-${before.appVersion || 'okänd'}-`), b1[0]);
      const bk = new DatabaseSync(path.join(config, 'backups', b1[0]), { readOnly: true });
      try {
        assert.equal(bk.prepare('PRAGMA user_version').get().user_version, before.ver, 'kopian har det gamla schemat');
        const s = snapshot(bk);
        for (const k of ['users', 'progress', 'items', 'libraries', 'sessions']) assert.deepEqual(s[k], before[k], `kopian: ${k}`);
      } finally { bk.close(); }
    } else assert.equal(b1.length, 0, 'samma version: ingen säkerhetskopia');

    // ---- andra start: redan uppgraderad, ingenting ändras ----
    openWithDbJs(config);
    const dump2 = inspect(config, db => dumpSql(db));
    assert.equal(dump2, afterFirst.dump, 'en andra start ändrar inte databasen');
    assert.deepEqual(backups(), b1, 'ingen ny säkerhetskopia vid andra start');

    // ---- hela servern mot den uppgraderade databasen ----
    const srv = await startServer(config);
    try {
      const json = { 'content-type': 'application/json' };
      const l = await fetch(srv.base + '/api/login', { method: 'POST', headers: json, body: JSON.stringify({ name: meta.user, password: meta.password }) });
      assert.equal(l.status, 200, `inloggning med fixturens konto: ${await l.clone().text()}`);
      const cookie = l.headers.get('set-cookie').split(';')[0];
      const st = await (await fetch(srv.base + '/api/status', { headers: { cookie } })).json();
      assert.equal(st.user?.name, meta.user);
      assert.equal(st.user?.profiles, 2, 'kontot och barnprofilen');
      // Appen som loggade in med den gamla versionen är fortfarande inloggad
      const app = await (await fetch(srv.base + '/api/status', { headers: { authorization: `Bearer ${meta.appToken}` } })).json();
      assert.equal(app.user?.name, meta.user, 'den gamla apptoken gäller fortfarande');
      // Fortsätt titta: filmen med framsteg syns
      const home = await fetch(srv.base + '/api/home', { headers: { cookie } });
      assert.equal(home.status, 200);
      assert.match(await home.text(), /Fönstret mot gården/);
      // Skanningen vid start (biblioteksmapparna finns inte här) får inte ta bort något
      let done = false;
      for (let i = 0; i < 60 && !done; i++) {
        await sleep(500);
        const s = await (await fetch(srv.base + '/api/scan', { headers: { cookie } })).json();
        done = !!s.last && !s.running;
      }
      assert.ok(done, 'skanningen blev klar');
    } finally { await stopServer(srv); }
    const ref = await fullReference();
    inspect(config, db => {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'inga brutna främmande nycklar efter servern');
      assertSchema(db, ref, 'efter servern');
      const s = snapshot(db);
      for (const k of ['users', 'progress', 'items', 'libraries']) assert.deepEqual(s[k], before[k], `efter servern: ${k}`);
      for (const [t, n] of Object.entries(before.counts)) {
        if (!['sessions', 'audit', 'settings'].includes(t)) assert.equal(s.counts[t], n, `efter servern: antal rader i ${t}`);
      }
    });
  });
}

// Före v0.5 tillät libraries bara film och serie: tabellen byggs om (DROP TABLE) – filmer, avsnitt och framsteg
// som pekar på biblioteken får inte försvinna med den (främmande nycklar med ON DELETE CASCADE)
test('ombyggnaden av libraries (före v0.5) behåller titlar och framsteg', () => {
  const config = path.join(ROOT, 'pre05', 'config');
  fs.mkdirSync(config, { recursive: true });
  loadSql(dbFile(config), `BEGIN;
CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE NOT NULL, pass TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created INTEGER NOT NULL);
CREATE TABLE libraries(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN('movie','show')), path TEXT NOT NULL);
CREATE TABLE items(id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('movie','show','episode')), parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  title TEXT NOT NULL, sort_title TEXT, year INTEGER, season INTEGER, episode INTEGER, path TEXT, size INTEGER, mtime INTEGER, duration REAL,
  container TEXT, vcodec TEXT, acodec TEXT, width INTEGER, height INTEGER, streams TEXT, overview TEXT, rating REAL, tmdb_id INTEGER,
  meta_done INTEGER NOT NULL DEFAULT 0, poster INTEGER NOT NULL DEFAULT 0, backdrop INTEGER NOT NULL DEFAULT 0, thumb INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL);
CREATE TABLE progress(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0, duration REAL, watched INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL, PRIMARY KEY(user_id,item_id));
CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT);
INSERT INTO users VALUES(1,'anna','scrypt$x',1,1);
INSERT INTO libraries VALUES(1,'Filmer','movie','/m'),(2,'Serier','show','/s');
INSERT INTO items(id,library_id,kind,parent_id,title,path,mtime,added) VALUES(1,1,'movie',NULL,'Film','/m/f.mkv',5,1),(2,2,'show',NULL,'Serie',NULL,NULL,1),(3,2,'episode',2,'Avsnitt','/s/e.mkv',5,1);
INSERT INTO progress VALUES(1,1,100,200,0,1),(1,3,50,60,1,1);
PRAGMA user_version=1;
COMMIT;`);
  openWithDbJs(config);
  inspect(config, db => {
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='libraries'").get().sql, /'audiobook'/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, refDb.version);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assertSchema(db, refDb, 'före v0.5');
    const s = snapshot(db);
    assert.deepEqual(s.libraries.map(l => l.name), ['Filmer', 'Serier']);
    assert.deepEqual(s.items.map(i => i.title), ['Film', 'Serie', 'Avsnitt']);
    assert.deepEqual(s.progress.map(p => p.position), [100, 50]);
  });
});

// Databaser från före den äldsta fixturen (user_version 0–4) finns inte i historiken: simulera dem med den äldsta
// fixturen och kontrollera att alla versionssteg körs i tur och ordning utan att något annat än det avsedda ändras
for (const start of [0, 3]) {
  test(`versionsstegen från user_version ${start} körs i tur och ordning`, () => {
    const config = path.join(ROOT, `uv${start}`, 'config');
    fs.mkdirSync(config, { recursive: true });
    const sql = fs.readFileSync(path.join(FIXDIR, `${FIXTURES[0]}.sql`), 'utf8');
    loadSql(dbFile(config), sql.replace(/^PRAGMA user_version=\d+;$/m, `PRAGMA user_version=${start};`));
    const before = inspect(config, snapshot);
    assert.ok(before.sessions.length > 0);
    openWithDbJs(config);
    inspect(config, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, refDb.version);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const s = snapshot(db);
      // v0.3: token lagras hashade – gamla sessioner tas bort (en utloggning). Senare steg rör inte sessionerna.
      assert.deepEqual(s.sessions, start < 3 ? [] : before.sessions);
      // v0.2: alla filer analyseras om; v0.4: metadata hämtas om – raderna finns kvar
      if (start < 2) assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE path IS NOT NULL AND mtime != 0').get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE kind IN ('movie','show') AND tmdb_id IS NOT NULL AND meta_done != 0").get().n, 0);
      for (const k of ['users', 'progress', 'items', 'libraries', 'settings']) assert.deepEqual(s[k], before[k], k);
      for (const [t, n] of Object.entries(before.counts)) if (!['sessions', 'settings'].includes(t)) assert.equal(s.counts[t], n, `antal rader i ${t}`);
    });
  });
}
