// Egna samlingar mot en riktig server: skapa/ändra/ta bort, privat och delad, administratörskrav, barnprofilens
// åldersgräns, manuell ordning, sortering och hyllan på startsidan. TMDB-samlingarna (/api/collections) ska inte påverkas.
// Titlarna läggs direkt i databasen (biblioteksmapparna finns inte, så skanningen rör dem inte). Kräver ffmpeg som övriga servertester.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-ccol-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 25000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, admin = '', bo = '', kid = '';
const S = {};

async function req(p, { method = 'GET', body, tok = admin, headers = {} } = {}) {
  const h = { ...headers };
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (name, password) => (await req('/api/login', { method: 'POST', body: { name, password, app: true }, tok: '' })).data.token;
const titles = (d) => d.items.map(i => i.title);

before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(MEDIA, { recursive: true });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '', WATCH_FILES: '0' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

t('förberedelse: konton, barnprofil och titlar', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin', PW); assert.ok(admin);
  for (let i = 0; i < 60; i++) { if ((await req('/api/scan')).data.last) break; await sleep(250); }
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW } })).status, 200);
  bo = await login('bo', PW); assert.ok(bo);
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const lib = (name, type) => Number(db.prepare('INSERT INTO libraries(name,type,path) VALUES(?,?,?)').run(name, type, path.join(MEDIA, 'saknas-' + type)).lastInsertRowid);
  S.movies = lib('Filmer', 'movie'); S.shows = lib('Serier', 'show');
  const ins = db.prepare(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,year,season,episode,duration,age,added,version_of)
    VALUES(?,?,?,?,?,?,?,?,3600,?,?,?)`);
  const item = (l, kind, title, { parent = null, season = null, episode = null, age = 15, year = 2020, added = 1000, version = null } = {}) =>
    Number(ins.run(l, kind, parent, title, title.toLowerCase(), year, season, episode, age, added, version).lastInsertRowid);
  S.c = item(S.movies, 'movie', 'Cesar', { year: 1999, age: 7 });
  S.a = item(S.movies, 'movie', 'Anna', { year: 2010, age: 15 });
  S.b = item(S.movies, 'movie', 'Bertil', { year: 2005, age: 0 });
  S.bv = item(S.movies, 'movie', 'Bertil', { year: 2005, age: 0, version: S.b }); // version av Bertil
  S.show = item(S.shows, 'show', 'Dansbandet', { age: 15 });
  S.ep = item(S.shows, 'episode', 'Dansbandet S1E1', { parent: S.show, season: 1, episode: 1, age: null });
  db.close();
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  const k = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  kid = (await req('/api/profiles/switch', { method: 'POST', body: { id: k } })).data.token;
  assert.ok(kid);
  admin = await login('admin', PW);
});

t('CRUD: skapa, lägga till, ändra och ta bort en delad samling', async () => {
  const r = await req('/api/custom-collections', { method: 'POST', body: { name: '  Julfilmer ', overview: 'Mys', shared: true, item: S.a } });
  assert.equal(r.status, 200); S.jul = r.data.id;
  assert.equal((await req('/api/custom-collections', { method: 'POST', body: { name: ' ' } })).status, 400, 'namn krävs');
  // Avsnitt läggs till som serien och en filmversion som filmen; samma titel två gånger blir en rad
  for (const id of [S.ep, S.bv, S.c, S.c]) assert.equal((await req(`/api/custom-collections/${S.jul}/items`, { method: 'POST', body: { id } })).status, 200);
  let d = (await req(`/api/custom-collections/${S.jul}`)).data;
  assert.equal(d.name, 'Julfilmer'); assert.equal(d.kind, 'custom'); assert.equal(d.shared, true); assert.equal(d.editable, true);
  assert.deepEqual(d.items.map(i => i.id), [S.a, S.show, S.b, S.c], 'manuell ordning = i den ordning titlarna lades till');
  assert.equal(d.count, 4); assert.equal(d.cover, S.a); assert.deepEqual(d.years, [1999, 2020]);
  assert.equal((await req(`/api/custom-collections/${S.jul}`, { method: 'PUT', body: { name: 'Jul', sort: 'title', home: true } })).status, 200);
  d = (await req(`/api/custom-collections/${S.jul}`)).data;
  assert.equal(d.name, 'Jul'); assert.equal(d.overview, 'Mys'); assert.equal(d.home, true);
  assert.deepEqual(titles(d), ['Anna', 'Bertil', 'Cesar', 'Dansbandet']);
  // Ta bort en titel (avsnittets id tar bort serien)
  assert.equal((await req(`/api/custom-collections/${S.jul}/items/${S.ep}`, { method: 'DELETE' })).status, 200);
  assert.equal((await req(`/api/custom-collections/${S.jul}`)).data.count, 3);
  // Listan markerar om en titel finns i samlingen
  const l = (await req(`/api/custom-collections?item=${S.bv}`)).data;
  assert.equal(l.find(x => x.id === S.jul).has, true);
  // Ta bort hela samlingen
  const tmp = (await req('/api/custom-collections', { method: 'POST', body: { name: 'Tillfällig' } })).data.id;
  assert.equal((await req(`/api/custom-collections/${tmp}`, { method: 'DELETE' })).status, 200);
  assert.equal((await req(`/api/custom-collections/${tmp}`)).status, 404);
  assert.equal((await req(`/api/custom-collections/${S.jul}/items`, { method: 'POST', body: { id: 999999 } })).status, 404, 'okänd titel');
});

t('sortering: år, tillagd och manuell ordning med flytt', async () => {
  await req(`/api/custom-collections/${S.jul}`, { method: 'PUT', body: { sort: 'year' } });
  assert.deepEqual(titles((await req(`/api/custom-collections/${S.jul}`)).data), ['Cesar', 'Bertil', 'Anna']);
  await req(`/api/custom-collections/${S.jul}`, { method: 'PUT', body: { sort: 'added' } });
  assert.equal(titles((await req(`/api/custom-collections/${S.jul}`)).data).length, 3);
  await req(`/api/custom-collections/${S.jul}`, { method: 'PUT', body: { sort: 'manual' } });
  assert.deepEqual(titles((await req(`/api/custom-collections/${S.jul}`)).data), ['Anna', 'Bertil', 'Cesar']);
  // Ny ordning; okända id ignoreras och titlar som inte skickas hamnar sist
  assert.equal((await req(`/api/custom-collections/${S.jul}/order`, { method: 'PUT', body: { ids: [S.c, 424242, S.a] } })).status, 200);
  assert.deepEqual(titles((await req(`/api/custom-collections/${S.jul}`)).data), ['Cesar', 'Anna', 'Bertil']);
  assert.equal((await req(`/api/custom-collections/${S.jul}/order`, { method: 'PUT', body: { ids: 'x' } })).status, 400);
  // Ogiltig sortering behåller den gamla
  await req(`/api/custom-collections/${S.jul}`, { method: 'PUT', body: { sort: 'slump' } });
  assert.equal((await req(`/api/custom-collections/${S.jul}`)).data.sort, 'manual');
});

t('behörighet: privat syns bara för skaparen, delad ändras bara av administratörer på hemnätet', async () => {
  const p = await req('/api/custom-collections', { method: 'POST', body: { name: 'Bos favoriter', item: S.a }, tok: bo });
  assert.equal(p.status, 200); S.bos = p.data.id;
  assert.equal((await req('/api/custom-collections', { method: 'POST', body: { name: 'Försök', shared: true }, tok: bo })).status, 403, 'vanlig användare kan inte skapa delad');
  assert.equal((await req(`/api/custom-collections/${S.bos}`, { method: 'PUT', body: { shared: true }, tok: bo })).status, 403, 'eller dela sin');
  // Admin ser inte Bos privata samling och kan inte ändra den
  assert.ok(!(await req('/api/custom-collections')).data.some(x => x.id === S.bos));
  assert.equal((await req(`/api/custom-collections/${S.bos}`)).status, 404);
  assert.equal((await req(`/api/custom-collections/${S.bos}`, { method: 'DELETE' })).status, 404);
  assert.equal((await req(`/api/custom-collections/${S.bos}/items`, { method: 'POST', body: { id: S.b } })).status, 404);
  // Bo ser den delade men får inte ändra den
  const l = (await req('/api/custom-collections', { tok: bo })).data;
  const jul = l.find(x => x.id === S.jul);
  assert.ok(jul); assert.equal(jul.editable, false); assert.equal(jul.mine, false);
  assert.equal(l.find(x => x.id === S.bos).editable, true);
  assert.equal((await req(`/api/custom-collections/${S.jul}`, { method: 'PUT', body: { name: 'Hackad' }, tok: bo })).status, 403);
  assert.equal((await req(`/api/custom-collections/${S.jul}/items`, { method: 'POST', body: { id: S.b }, tok: bo })).status, 403);
  assert.equal((await req(`/api/custom-collections/${S.jul}/order`, { method: 'PUT', body: { ids: [S.b] }, tok: bo })).status, 403);
  assert.equal((await req(`/api/custom-collections/${S.jul}`, { method: 'DELETE', tok: bo })).status, 403);
  assert.ok(!(await req('/api/custom-collections?editable=1', { tok: bo })).data.some(x => x.id === S.jul));
  // Administratören utanför hemnätet får inte ändra delade samlingar
  const far = { 'x-forwarded-for': '81.2.3.4' };
  assert.equal((await req(`/api/custom-collections/${S.jul}`, { method: 'PUT', body: { name: 'Bortifrån' }, headers: far })).status, 403);
  assert.equal((await req('/api/custom-collections', { method: 'POST', body: { name: 'Bortifrån', shared: true }, headers: far })).status, 403);
  assert.equal((await req(`/api/custom-collections/${S.jul}`)).data.name, 'Jul');
});

t('barnprofil: bara titlar inom åldersgränsen och bara samlingar med någon synlig titel', async () => {
  // En delad samling med bara vuxentitlar ska inte synas alls (varken namn eller beskrivning)
  S.vuxen = (await req('/api/custom-collections', { method: 'POST', body: { name: 'Skräck', overview: 'Hemlig', shared: true, home: true, item: S.a } })).data.id;
  const l = (await req('/api/custom-collections', { tok: kid })).data;
  assert.ok(!l.some(x => x.id === S.vuxen), 'vuxensamlingen döljs');
  assert.ok(!l.some(x => x.id === S.bos), 'någon annans privata syns inte');
  assert.equal((await req(`/api/custom-collections/${S.vuxen}`, { tok: kid })).status, 404);
  const jul = l.find(x => x.id === S.jul);
  assert.equal(jul.count, 2, 'bara Cesar (7) och Bertil (0)');
  assert.equal(jul.cover, S.c, 'omslaget är första synliga titeln, inte Anna');
  assert.deepEqual(titles((await req(`/api/custom-collections/${S.jul}`, { tok: kid })).data), ['Cesar', 'Bertil']);
  // Barnet kan inte lägga till en titel över sin gräns i en egen samling
  const own = (await req('/api/custom-collections', { method: 'POST', body: { name: 'Lisas', item: S.b }, tok: kid }));
  assert.equal(own.status, 200);
  assert.equal((await req(`/api/custom-collections/${own.data.id}/items`, { method: 'POST', body: { id: S.a }, tok: kid })).status, 404);
  assert.equal((await req('/api/custom-collections', { method: 'POST', body: { name: 'X', item: S.a }, tok: kid })).status, 404);
  // Startsidan: vuxensamlingen visas inte som hylla för barnet
  const home = (await req('/api/home', { tok: kid })).data;
  assert.ok(!home.customCollections.some(x => x.id === S.vuxen));
  assert.deepEqual(home.customCollections.find(x => x.id === S.jul).items.map(i => i.title), ['Cesar', 'Bertil']);
});

t('startsidan: hyllor för samlingar med "Visa på startsidan", TMDB-samlingarna oförändrade', async () => {
  let home = (await req('/api/home')).data;
  const ids = home.customCollections.map(x => x.id);
  assert.ok(ids.includes(S.jul) && ids.includes(S.vuxen));
  assert.deepEqual(home.customCollections.find(x => x.id === S.jul).items.map(i => i.title), ['Cesar', 'Anna', 'Bertil']);
  assert.ok(Array.isArray(home.rows) && Array.isArray(home.continue), 'befintliga fält finns kvar');
  await req(`/api/custom-collections/${S.jul}`, { method: 'PUT', body: { home: false } });
  home = (await req('/api/home')).data;
  assert.ok(!home.customCollections.some(x => x.id === S.jul));
  // Bos privata hylla syns bara för Bo
  await req(`/api/custom-collections/${S.bos}`, { method: 'PUT', body: { home: true }, tok: bo });
  assert.ok((await req('/api/home', { tok: bo })).data.customCollections.some(x => x.id === S.bos));
  assert.ok(!home.customCollections.some(x => x.id === S.bos));
  // En tom samling blir ingen hylla
  const empty = (await req('/api/custom-collections', { method: 'POST', body: { name: 'Tom', home: true } })).data.id;
  assert.ok(!(await req('/api/home')).data.customCollections.some(x => x.id === empty));
  assert.ok((await req('/api/custom-collections')).data.some(x => x.id === empty), 'men syns i listan för den som kan fylla den');
  // Biblioteksfilter: bara samlingar med titlar från biblioteket
  const inShows = (await req(`/api/custom-collections?library=${S.shows}`)).data;
  assert.ok(!inShows.some(x => x.id === S.jul));
  // TMDB-samlingarna har samma form som förut (tom lista här)
  assert.deepEqual((await req('/api/collections')).data, []);
});

t('borttagen titel försvinner ur samlingen, borttagen användare tar med sina samlingar', async () => {
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
  db.prepare('DELETE FROM items WHERE id=?').run(S.c);
  db.close();
  assert.deepEqual(titles((await req(`/api/custom-collections/${S.jul}`)).data), ['Anna', 'Bertil']);
  const bid = (await req('/api/users')).data.find(u => u.name === 'bo').id;
  assert.equal((await req(`/api/users/${bid}`, { method: 'DELETE' })).status, 200);
  const db2 = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM custom_collections WHERE id=?').get(S.bos).n, 0);
  db2.close();
});
