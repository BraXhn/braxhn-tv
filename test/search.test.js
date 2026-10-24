// Sökning: söknyckeln (å/ä/ö, accenter, bindestreck), rankning, stavfel, år, %/_ och prestanda direkt mot
// modulerna (egen databas), och /api/search, /api/search/people och /api/search/all mot en riktig server (med
// barnprofil). Kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-search-'));
process.env.CONFIG_DIR = path.join(ROOT, 'unit');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
let srv;
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const { searchKey, compactKey, parseQuery, keyScore, editDistance } = await import('../server/searchkey.js');
const D = await import('../server/db.js');
const S = await import('../server/search.js');
const none = { sql: '', params: [] };

test('söknyckeln: å/ä/ö viks, accenter och skiljetecken bort, gemener', () => {
  assert.equal(searchKey('Änglagård'), 'anglagard');
  assert.equal(searchKey('Amélie'), 'amelie');
  assert.equal(searchKey('Spider-Man: Över Gränsen'), 'spider man over gransen');
  assert.equal(compactKey(searchKey('Spider-Man')), 'spiderman');
  assert.equal(searchKey("Schindler's List"), 'schindlers list');
  assert.equal(searchKey('Ørnen ÆØÅ straße'), 'ornen aeoa strasse');
  assert.equal(searchKey('ＡＢＣ ﬁlm'), 'abc film', 'NFKD: breda tecken och ligaturer');
  assert.equal(searchKey(null), '');
  assert.equal(searchKey('%_'), '');
});

test('frågan: år bland flera ord blir ett filter, ensamt år är text', () => {
  assert.deepEqual([parseQuery('matrix 1999').year, parseQuery('matrix 1999').text.key], [1999, 'matrix']);
  assert.equal(parseQuery('1917').year, null);
  assert.equal(parseQuery('1917').all.key, '1917');
  assert.ok(parseQuery('  %  ').empty);
});

test('redigeringsavstånd med intilliggande byte', () => {
  assert.equal(editDistance('matirx', 'matrix'), 1);
  assert.equal(editDistance('hobit', 'hobbit'), 1);
  assert.equal(editDistance('abc', 'xyz', 1), 2);
});

test('nivåerna: exakt > början av titeln > början av ord > innehåller > stavfel', () => {
  const Q = parseQuery('matrix').all;
  const s = (t, f = false) => keyScore(Q, searchKey(t), f);
  assert.ok(s('Matrix') > s('The Matrix'));
  assert.ok(s('The Matrix') > s('Matrix Reloaded'));
  assert.ok(s('Matrix Reloaded') > s('Det är en Matrix-film'));
  assert.ok(s('Det är en Matrix-film') > s('Animatrix'));
  assert.equal(s('Matirx'), 0, 'stavfel räknas bara när det är påslaget');
  assert.ok(s('Matirx', true) > 0 && s('Matirx', true) < s('Animatrix'));
});

// ---- mot databasen (egen CONFIG_DIR) ----
D.run("INSERT INTO libraries(id,name,type,path) VALUES(1,'Filmer','movie','/finns-inte'),(2,'Serier','show','/finns-inte')");
const add = (title, year, extra = {}) => Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,year,added,age,original_title,parent_id) VALUES(?,?,?,?,?,0,?,?,?)`,
  extra.lib || 1, extra.kind || 'movie', title, title.toLowerCase(), year ?? null, extra.age ?? null, extra.orig ?? null, extra.parent ?? null).lastInsertRowid);
const titles = (q, kinds = ['movie', 'show'], age = none, limit = 20) => { S.freshKeys(); const ids = S.searchItemIds(parseQuery(q), kinds, age, limit).map(r => r.id);
  return ids.map(id => D.get('SELECT title FROM items WHERE id=?', id).title); };
const IDS = {
  angla: add('Änglagård', 1992), amelie: add('Amélie', 2001, { orig: "Le Fabuleux Destin d'Amélie Poulain" }), spider: add('Spider-Man', 2002),
  matrix: add('The Matrix', 1999), matrix2: add('Matrix Reloaded', 2003), animatrix: add('Animatrix', 2003), oden: add('Oden', 2010), odens: add('Ödets man', 2011),
  pct: add('100% Wolf', 2020), under: add('Under_score', 2020), u2: add('Undrscore', 2020), odyssey: add('2001: A Space Odyssey', 1968), kids: add('Bamse', 2018, { age: 7 }),
  adult: add('Bamse och vuxenfilmen', 2019, { age: 15 })
};

test('å/ä/ö: "änglag", "anglag" och "ÄNGLAG" hittar Änglagård; ö hittar både ö och o', () => {
  for (const q of ['änglag', 'anglag', 'ÄNGLAG', 'Änglagård']) assert.deepEqual(titles(q), ['Änglagård'], q);
  const r = titles('öd');
  assert.ok(r.includes('Oden') && r.includes('Ödets man'), r.join());
  assert.equal(titles('ödets')[0], 'Ödets man');
  assert.equal(titles('ode')[0], 'Oden');
});

test('accenter, bindestreck och originaltitel', () => {
  assert.deepEqual(titles('amelie'), ['Amélie']);
  assert.deepEqual(titles('spiderman'), ['Spider-Man']);
  assert.deepEqual(titles('spider man'), ['Spider-Man']);
  assert.deepEqual(titles('man spider'), ['Spider-Man']);
  assert.deepEqual(titles('fabuleux destin'), ['Amélie'], 'originaltiteln är sökbar');
});

test('rankning: exakt titel före början, ordbörjan och innehåller', () => {
  assert.deepEqual(titles('matrix'), ['The Matrix', 'Matrix Reloaded', 'Animatrix']);
  assert.deepEqual(titles('animatrix'), ['Animatrix']);
});

test('stavfel: ett fel i ord från fyra tecken, bara när inget stämmer exakt', () => {
  assert.deepEqual(titles('matirx'), ['The Matrix', 'Matrix Reloaded']);
  assert.deepEqual(titles('anglagrd'), ['Änglagård']);
  assert.deepEqual(titles('spidermn'), ['Spider-Man']);
  assert.deepEqual(titles('xyz'), [], 'korta ord: inga stavfel');
  assert.ok(titles('undrscore').length === 1 && titles('undrscore')[0] === 'Undrscore', 'exakt träff stänger av stavfelen');
});

test('år: "matrix 1999" väljer rätt film; tal i titeln fungerar ändå', () => {
  assert.deepEqual(titles('matrix 1999'), ['The Matrix']);
  assert.deepEqual(titles('matrix 2003'), ['Matrix Reloaded', 'Animatrix']);
  assert.deepEqual(titles('2001 space'), ['2001: A Space Odyssey']);
  assert.deepEqual(titles('amelie 2001'), ['Amélie']);
});

test('% och _ är vanliga tecken (ingen LIKE)', () => {
  assert.deepEqual(titles('%'), []);
  assert.deepEqual(titles('_'), []);
  assert.deepEqual(titles('100%'), ['100% Wolf']);
  assert.deepEqual(titles('under_'), ['Under_score']);
  assert.deepEqual(titles('m%x'), [], 'm%x är inte "m, något, x" (Matrix)');
});

test('åldersgräns: barnprofilens filter gäller i sökningen', () => {
  const seven = { sql: ' AND COALESCE(i.age, s.age, ?) <= ?', params: [999, 7] };
  assert.deepEqual(titles('bamse', ['movie', 'show'], seven), ['Bamse']);
  assert.deepEqual(titles('bamse'), ['Bamse', 'Bamse och vuxenfilmen']);
});

test('nyckeln hålls aktuell när titeln ändras (även från en annan anslutning)', () => {
  D.run('UPDATE items SET title=? WHERE id=?', 'Sällskapsresan', IDS.oden);
  assert.deepEqual(titles('sallskap'), ['Sällskapsresan']);
  const other = new DatabaseSync(path.join(process.env.CONFIG_DIR, 'braxhn-tv.db'));
  other.exec('PRAGMA busy_timeout=5000');
  other.prepare('UPDATE items SET title=? WHERE id=?').run('Jönssonligan', IDS.oden);
  other.prepare("INSERT INTO items(library_id,kind,title,added) VALUES(1,'movie','Ronja Rövardotter',0)").run();
  other.close();
  assert.deepEqual(titles('sallskap'), []);
  assert.deepEqual(titles('jonsson'), ['Jönssonligan']);
  assert.deepEqual(titles('rovardotter'), ['Ronja Rövardotter']);
});

test('prestanda: 10 000 titlar söks på under 50 ms', () => {
  const words = ['röd', 'blå', 'natt', 'dag', 'stad', 'skog', 'hav', 'resan', 'mannen', 'kvinnan', 'hemlig', 'sista', 'första', 'stora', 'lilla'];
  D.tx(() => { for (let i = 0; i < 10000; i++) add(`${words[i % 15]} ${words[(i * 7) % 15]} ${words[(i * 11 + 3) % 15]} ${i}`, 1950 + (i % 70)); });
  S.freshKeys();
  // Bästa av fem körningar per fråga: testet mäter sökningen, inte hur belastad maskinen råkar vara
  for (const q of ['skog', 'hemlig natt', 'stora 1999', 'matirx', 'kvinan', 'e']) {
    let ms = Infinity, r = [];
    for (let i = 0; i < 5; i++) { const t = performance.now(); r = S.searchItemIds(parseQuery(q), ['movie', 'show'], none, 20); ms = Math.min(ms, performance.now() - t); }
    assert.ok(ms < 50, `"${q}" tog ${ms.toFixed(1)} ms`);
    if (q !== 'matirx') assert.ok(r.length > 0, q);
  }
});

// ---- mot en riktig server ----
const PORT = 21000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`, CONFIG = path.join(ROOT, 'config'), PW = 'Testlösen-2026!';
let token = '';
async function req(p, { method = 'GET', body, tok = token } = {}) {
  const h = {};
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('servern: /api/search, /api/search/people och /api/search/all med barnprofil', async () => {
  fs.mkdirSync(CONFIG, { recursive: true });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: path.join(ROOT, 'media'), TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      PODCAST_DIR: path.join(ROOT, 'pod'), DVR_DIR: path.join(ROOT, 'rec'), TMDB_API_KEY: '' }, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(B + '/api/health')).ok) break; } catch {} await sleep(200); }
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  token = (await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, tok: '' })).data.token;
  // Innehåll direkt i databasen (bibliotekens mappar finns inte – skanningen tar inte bort något)
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec(`PRAGMA busy_timeout=5000;
    INSERT INTO libraries(id,name,type,path) VALUES(1,'Filmer','movie','/finns-inte'),(2,'Serier','show','/finns-inte'),(3,'Musik','music','/finns-inte'),(4,'Böcker','audiobook','/finns-inte');
    INSERT INTO items(id,library_id,kind,title,sort_title,year,age,added) VALUES(1,1,'movie','Änglagård','anglagard',1992,15,0),(2,1,'movie','Bamse – världens starkaste björn','bamse',2014,7,0),
      (3,2,'show','Bamses äventyr','bamses',2010,7,0);
    INSERT INTO items(id,library_id,kind,parent_id,title,season,episode,added) VALUES(4,2,'episode',3,'Bamse och tjuvstaden',1,1,0);
    INSERT INTO people(id,name) VALUES(10,'Björn Bamse'),(11,'Vuxen Skådis');
    INSERT INTO item_people(item_id,person_id,role,ord) VALUES(2,10,'cast',0),(1,11,'cast',0);
    INSERT INTO artists(id,library_id,name,sort_name) VALUES(20,3,'Bamse-bandet','bamse-bandet');
    INSERT INTO albums(id,library_id,artist_id,title,year,added) VALUES(21,3,20,'Bamsesånger',2001,0);
    INSERT INTO tracks(id,library_id,album_id,artist_id,title,path,added) VALUES(22,3,21,20,'Bamses vaggvisa','/finns-inte/1.mp3',0);
    INSERT INTO books(id,library_id,key,title,author,added) VALUES(30,4,'k','Bamse läser','Rune Andréasson',0);
    INSERT INTO podcasts(id,url,title,author,added) VALUES(40,'https://example.com/feed','Bamsepodden','Radio',0);
    INSERT INTO podcast_episodes(id,podcast_id,guid,title,url,added) VALUES(41,40,'g','Bamse i rymden','https://example.com/1.mp3',0);`);
  db.close();

  // Appernas format är oförändrat: en lista med titlar
  const s = (await req('/api/search?q=' + encodeURIComponent('anglagard'))).data;
  assert.deepEqual(s.map(i => [i.id, i.kind, i.title]), [[1, 'movie', 'Änglagård']]);
  for (const k of ['id', 'kind', 'title', 'year', 'library', 'poster', 'position', 'watched']) assert.ok(k in s[0], k);
  assert.deepEqual((await req('/api/search?q=bamse')).data.map(i => i.id), [2, 3, 4], 'filmer/serier före avsnitt');
  assert.deepEqual((await req('/api/search?q=' + encodeURIComponent('%'))).data, []);
  assert.deepEqual((await req('/api/search/people?q=' + encodeURIComponent('bjorn'))).data, [{ id: 10, name: 'Björn Bamse', image: false, titles: 1 }]);

  const a = (await req('/api/search/all?q=bamse&limit=5')).data;
  assert.deepEqual(a.movies.map(i => i.id), [2]);
  assert.deepEqual(a.shows.map(i => i.id), [3]);
  assert.deepEqual(a.episodes.map(i => i.id), [4]);
  assert.deepEqual(a.people.map(p => p.id), [10]);
  assert.deepEqual(a.artists, [{ id: 20, name: 'Bamse-bandet' }]);
  assert.deepEqual(a.albums.map(x => x.id), [21]);
  assert.deepEqual(a.tracks.map(x => x.id), [22]);
  assert.deepEqual(a.books.map(x => [x.id, x.author]), [[30, 'Rune Andréasson']]);
  assert.deepEqual(a.podcasts.map(x => x.id), [40]);
  assert.deepEqual(a.podcastEpisodes.map(x => x.id), [41]);
  assert.ok(a.order.length >= 10 && a.order.every(g => a[g].length), a.order.join());
  assert.deepEqual((await req('/api/search/all?q=' + encodeURIComponent('andreasson'))).data.books.map(x => x.id), [30], 'författaren är sökbar');
  assert.deepEqual((await req('/api/search/all?q=')).data.order, []);

  // Barnprofil (max 7 år): inga titlar över gränsen, inga personer bara från sådana titlar, inga poddar
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  const kid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  const kt = (await req('/api/profiles/switch', { method: 'POST', body: { id: kid } })).data.token;
  const k = (await req('/api/search/all?q=bamse', { tok: kt })).data;
  assert.deepEqual([k.movies.map(i => i.id), k.shows.map(i => i.id), k.episodes.map(i => i.id)], [[2], [3], [4]]);
  assert.deepEqual([k.podcasts, k.podcastEpisodes, k.channels, k.programs], [[], [], [], []]);
  const k2 = (await req('/api/search/all?q=' + encodeURIComponent('änglagård'), { tok: kt })).data;
  assert.deepEqual(k2.movies, []);
  assert.deepEqual((await req('/api/search/all?q=skadis', { tok: kt })).data.people, []);
  assert.deepEqual((await req('/api/search?q=anglagard', { tok: kt })).data, []);
});
