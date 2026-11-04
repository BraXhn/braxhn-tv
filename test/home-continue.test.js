// Startsidan och samlingar mot en riktig server: ordningen i "Fortsätt titta", "Markera som osedd", specialavsnitt,
// ljudboksbibliotek som inte hör hemma bland raderna och samlingar som inte får läcka till barnprofiler.
// Titlarna läggs direkt i databasen (biblioteksmapparna finns inte, så skanningen rör dem inte). Kräver ffmpeg som övriga servertester.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './helpers/port.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-home-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, token = '', kidToken = '';
const S = {};

async function req(p, { method = 'GET', body, tok = token } = {}) {
  const h = {};
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async () => { token = (await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, tok: '' })).data.token; assert.ok(token); };
const cont = async (tok) => (await req('/api/home', { tok })).data.continue.map(i => i.id);

before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(MEDIA, { recursive: true });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '', WATCH_FILES: '0', BOOK_METADATA: '0' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

t('förberedelse: konto, barnprofil och titlar i databasen', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  await login();
  // Startskanningen ska vara klar innan titlarna läggs in
  for (let i = 0; i < 60; i++) { if ((await req('/api/scan')).data.last) break; await sleep(250); }
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const lib = (name, type) => Number(db.prepare('INSERT INTO libraries(name,type,path) VALUES(?,?,?)').run(name, type, path.join(MEDIA, 'saknas-' + type)).lastInsertRowid);
  const movies = lib('Filmer', 'movie'), shows = lib('Serier', 'show');
  lib('Böcker', 'audiobook');
  const ins = db.prepare(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,year,season,episode,duration,age,collection_id,added)
    VALUES(?,?,?,?,?,?,?,?,3600,?,?,?)`);
  const item = (l, kind, title, { parent = null, season = null, episode = null, age = 15, col = null, year = 2020 } = {}) =>
    Number(ins.run(l, kind, parent, title, title.toLowerCase(), year, season, episode, age, col, 1000).lastInsertRowid);
  db.exec("INSERT INTO collections(id,name,overview) VALUES(1,'Blandad samling','Barn och vuxna'),(2,'Vuxensamling','Hemlig beskrivning')");
  S.old = item(movies, 'movie', 'Gammal film');
  S.kidMovie = item(movies, 'movie', 'Barnfilm', { age: 7, col: 1, year: 2001 });
  item(movies, 'movie', 'Vuxen i samling', { col: 1, year: 2010 });
  S.v1 = item(movies, 'movie', 'Vuxen 1', { col: 2 }); item(movies, 'movie', 'Vuxen 2', { col: 2 });
  S.movies = movies; S.shows = shows;
  const show = (title, eps) => { const id = item(shows, 'show', title); return [id, ...eps.map(([s, e]) => item(shows, 'episode', `${title} S${s}E${e}`, { parent: id, season: s, episode: e }))]; };
  [S.a, S.a1, S.a2] = show('Alfa', [[1, 1], [1, 2]]);
  [S.b, S.b01, S.b02, S.b11] = show('Beta', [[0, 1], [0, 2], [1, 1]]);
  [S.c, S.c1, S.c2] = show('Gamma', [[1, 1], [1, 2]]);
  db.close();
  fs.mkdirSync(path.join(CONFIG, 'images'), { recursive: true });
  fs.writeFileSync(path.join(CONFIG, 'images', 'c2-poster.jpg'), 'jpg');
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  const kid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  kidToken = (await req('/api/profiles/switch', { method: 'POST', body: { id: kid } })).data.token;
  assert.ok(kidToken);
  await login(); // bytet av profil gäller den sessionen
});

t('Fortsätt titta sorteras på senaste aktivitet, även "nästa avsnitt"', async () => {
  await req(`/api/items/${S.old}/progress`, { method: 'POST', body: { position: 600 } });
  // Filmen började man på för en vecka sedan
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare('UPDATE progress SET updated=updated-7*86400 WHERE item_id=?').run(S.old);
  db.close();
  await req(`/api/items/${S.a1}/watched`, { method: 'POST', body: { watched: true } });
  const ids = await cont();
  assert.ok(ids.includes(S.a2) && ids.includes(S.old), JSON.stringify(ids));
  assert.ok(ids.indexOf(S.a2) < ids.indexOf(S.old), 'nyss sedda seriens nästa avsnitt före den gamla filmen');
});

t('specialavsnitt föreslås inte före säsong 1', async () => {
  await sleep(1100); // senare än förra testets tittande
  await req(`/api/items/${S.b01}/watched`, { method: 'POST', body: { watched: true } });
  const ids = await cont();
  assert.ok(ids.includes(S.b11), JSON.stringify(ids));
  assert.ok(!ids.includes(S.b02));
  assert.equal(ids[0], S.b11, 'senaste aktiviteten först');
});

t('mindre än 2 minuter sett räknas inte som påbörjat: varken i Fortsätt titta, filtret, nästa avsnitt eller "Fortsätt från"', async () => {
  await sleep(1100);
  // Bara tittat in i andra avsnittet av serien C och i en film
  await req(`/api/items/${S.c2}/progress`, { method: 'POST', body: { position: 90 } });
  await req(`/api/items/${S.v1}/progress`, { method: 'POST', body: { position: 90 } });
  let ids = await cont();
  assert.ok(![S.c1, S.c2, S.v1].some(id => ids.includes(id)), JSON.stringify(ids));
  // Positionen ligger kvar i databasen, men API:t (webben och apparna) säger 0: titeln börjar om från början
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  assert.equal(db.prepare('SELECT position FROM progress WHERE item_id=?').get(S.c2)?.position, 90);
  db.close();
  // (titlarna saknar fil, så filmens position läses ur bibliotekslistan i stället för titelsidan)
  const moviePos = async () => (await req(`/api/libraries/${S.movies}/items`)).data.items.find(i => i.id === S.v1).position;
  assert.equal(await moviePos(), 0);
  // Seriesidans ▶ och kortmenyn: första osedda avsnittet, inte det man tittat in i
  const show = (await req(`/api/items/${S.c}`)).data;
  assert.equal(show.next.id, S.c1);
  assert.equal(show.children.find(e => e.id === S.c2).position, 0);
  assert.equal((await req(`/api/items/${S.c}/state`)).data.next.id, S.c1);
  // Filtret Påbörjade
  const prog = async (lib) => (await req(`/api/libraries/${lib}/items?filter=inprogress`)).data.items.map(i => i.id);
  assert.ok(!(await prog(S.movies)).includes(S.v1));
  assert.ok(!(await prog(S.shows)).includes(S.c));
  // Två minuter eller mer: påbörjad överallt
  await req(`/api/items/${S.c2}/progress`, { method: 'POST', body: { position: 130 } });
  await req(`/api/items/${S.v1}/progress`, { method: 'POST', body: { position: 120 } });
  ids = await cont();
  assert.ok(ids.includes(S.c2) && ids.includes(S.v1), JSON.stringify(ids));
  assert.equal(await moviePos(), 120);
  assert.equal((await req(`/api/items/${S.c}`)).data.next.id, S.c2);
  assert.equal((await req(`/api/items/${S.c}/state`)).data.next.position, 130);
  assert.ok((await prog(S.movies)).includes(S.v1));
  assert.ok((await prog(S.shows)).includes(S.c));
  for (const id of [S.c2, S.v1]) await req(`/api/items/${id}/progress`, { method: 'POST', body: { position: 0 } });
});

test('gränsen för påbörjad: korta klipp från en fjärdedel, samma värde i webben som på servern', async () => {
  const { CONTINUE_MIN, isStarted, resumeAt, startedSql } = await import('../server/resume.js');
  assert.equal(CONTINUE_MIN, 120);
  assert.equal(isStarted(119, 3600), false); assert.equal(isStarted(120, 3600), true);
  assert.equal(isStarted(14, 60), false); assert.equal(isStarted(15, 60), true, 'en fjärdedel av ett kort klipp');
  assert.equal(isStarted(130, null), true, 'okänd längd: 2 minuter'); assert.equal(isStarted(0, 2), false);
  assert.equal(resumeAt(90, 3600), 0); assert.equal(resumeAt(600, 3600), 600);
  // SQL-varianten ger samma svar
  const db = new DatabaseSync(':memory:');
  const sql = (pos, dur) => !!db.prepare(`SELECT ${startedSql('?1', '?2')} AS s`).get(pos, dur).s;
  for (const [pos, dur] of [[119, 3600], [120, 3600], [14, 60], [15, 60], [130, null], [130, 0], [0, 2], [null, 3600]]) assert.equal(sql(pos, dur), isStarted(pos, dur), `${pos}/${dur}`);
  db.close();
  // Webbens kopia (web/js/core.js) – samma gräns och samma formel
  const core = fs.readFileSync(new URL('../web/js/core.js', import.meta.url), 'utf8');
  assert.equal(+core.match(/export const CONTINUE_MIN = (\d+);/)?.[1], CONTINUE_MIN);
  const body = core.match(/export const resumeAt = (\(pos, dur\) => [^\n]+);/)?.[1];
  assert.ok(body);
  const webResume = new Function('CONTINUE_MIN', `return ${body}`)(CONTINUE_MIN);
  for (const [pos, dur] of [[119, 3600], [120, 3600], [14, 60], [15, 60], [130, null], [0, 2], [600, 3600]]) assert.equal(webResume(pos, dur), resumeAt(pos, dur), `${pos}/${dur}`);
});

t('Markera som osedd lägger inte serien i Fortsätt titta', async () => {
  await req(`/api/items/${S.c}/watched`, { method: 'POST', body: { watched: false } });
  const ids = await cont();
  assert.ok(![S.c1, S.c2].some(id => ids.includes(id)), JSON.stringify(ids));
});

t('startsidan visar inte ljudboksbibliotek bland raderna', async () => {
  const rows = (await req('/api/home')).data.rows;
  assert.deepEqual(rows.map(r => r.library.type).sort(), ['movie', 'show']);
});

t('samlingar: barnprofilen ser bara det den får se', async () => {
  const adult = (await req('/api/collections')).data;
  assert.deepEqual(adult.map(c => [c.name, c.count]), [['Blandad samling', 2], ['Vuxensamling', 2]]);
  const kid = (await req('/api/collections', { tok: kidToken })).data;
  assert.deepEqual(kid.map(c => [c.name, c.count, c.years]), [['Blandad samling', 1, [2001, 2001]]]);
  assert.equal((await req('/api/collections/2', { tok: kidToken })).status, 404);
  const one = await req('/api/collections/1', { tok: kidToken });
  assert.equal(one.status, 200);
  assert.deepEqual(one.data.items.map(i => i.id), [S.kidMovie]);
  assert.equal((await req('/api/collections/2')).status, 200);
  assert.equal((await req('/api/collection-image/2/poster')).status, 200);
  assert.equal((await req('/api/collection-image/2/poster', { tok: kidToken })).status, 404);
});
