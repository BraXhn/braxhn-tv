// Startsidans tematiska hyllor och användarens layout mot en riktig server: Eftersom du såg, Topprankat, Glömda guldkorn,
// Kort film ikväll, Den här dagen, Dagens genre, Fortsätt lyssna och Utvalt – filtrerade på barnprofilens åldersgräns –
// samt "Anpassa startsidan" (ordning, dolda hyllor, Utvalt) som sparas per användare. Titlarna läggs direkt i databasen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-homesh-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 26000 + Math.floor(Math.random() * 1000);
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
const home = async (tok = token) => (await req('/api/home', { tok })).data;
const ids = (list) => (list || []).map(i => i.id);
const openDb = () => { const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db')); db.exec('PRAGMA busy_timeout=5000'); return db; };

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

t('förberedelse: konto, barnprofil, titlar och framsteg', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  token = (await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, tok: '' })).data.token;
  for (let i = 0; i < 60; i++) { if ((await req('/api/scan')).data.last) break; await sleep(250); }
  const db = openDb();
  const lib = Number(db.prepare('INSERT INTO libraries(name,type,path) VALUES(?,?,?)').run('Filmer', 'movie', path.join(MEDIA, 'saknas')).lastInsertRowid);
  const now = Math.floor(Date.now() / 1000), d = new Date();
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ins = db.prepare(`INSERT INTO items(library_id,kind,title,sort_title,year,duration,age,rating,genres,overview,backdrop,added,released)
    VALUES(?,'movie',?,?,?,?,?,?,?,?,?,?,?)`);
  const movie = (title, { age = 7, rating = 7, genres = ['Komedi'], dur = 110, added = now - 400 * 86400, released = '2001-02-03', backdrop = 1 } = {}) =>
    Number(ins.run(lib, title, title.toLowerCase(), +released.slice(0, 4), dur * 60, age, rating, JSON.stringify(genres), `Om ${title}`, backdrop, added, released).lastInsertRowid);
  S.seed = movie('Fröfilm', { genres: ['Komedi', 'Familj'], rating: 6 });
  S.top = movie('Mästerverket', { rating: 9.6 });
  S.topSeen = movie('Sedd klassiker', { rating: 9.8 });
  S.adultTop = movie('Vuxenfilm', { rating: 9.9, age: 15, genres: ['Komedi', 'Familj'] });
  S.gem = movie('Glömd pärla', { rating: 8.4, added: now - 900 * 86400 });
  S.newGood = movie('Ny och bra', { rating: 8.5, added: now - 5 * 86400 });
  S.short = movie('Kortisen', { dur: 80, rating: 7.2 });
  S.tooShort = movie('Kortfilm', { dur: 12 });
  S.anniversary = movie('Jubilaren', { released: `${d.getFullYear() - 30}-${md}`, rating: 7.5 });
  S.yearAgo = movie('Förra året', { rating: 6.8 });
  S.kidShort = movie('Barnkort', { dur: 75, rating: 7.4, genres: ['Familj', 'Komedi'] });
  for (let i = 0; i < 10; i++) movie(`Komedi ${i}`, { rating: 6 + i / 10, genres: ['Komedi', 'Familj'] });
  // Framsteg: frön och sedda titlar
  const pr = db.prepare('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,6600,?,?)');
  const uid = db.prepare("SELECT id FROM users WHERE name='admin'").get().id;
  const ago = Math.floor(new Date(d.getFullYear() - 1, d.getMonth(), d.getDate(), 12).getTime() / 1000);
  // 29 februari: inget "för ett år sedan" (året innan saknar datumet) – testet hoppar då över den delen
  S.leap = new Date(ago * 1000).getMonth() !== d.getMonth();
  pr.run(uid, S.yearAgo, 0, 1, ago);
  pr.run(uid, S.topSeen, 0, 1, now - 3600);
  pr.run(uid, S.seed, 0, 1, now - 60);
  // Poddavsnitt halvvägs (Fortsätt lyssna)
  db.exec(`INSERT INTO podcasts(id,url,title,added) VALUES(1,'https://example.invalid/feed','Testpodden',${now})`);
  db.exec(`INSERT INTO podcast_episodes(id,podcast_id,guid,title,duration,url,added) VALUES(1,1,'g1','Avsnitt ett',3600,'https://example.invalid/1.mp3',${now})`);
  db.exec(`INSERT INTO podcast_progress(user_id,episode_id,position,played,updated) VALUES(${uid},1,1200,0,${now})`);
  db.close();
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  const kid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  kidToken = (await req('/api/profiles/switch', { method: 'POST', body: { id: kid } })).data.token;
  assert.ok(kidToken);
  token = (await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, tok: '' })).data.token;
});

t('nya fält läggs till, befintliga finns kvar', async () => {
  const d = await home();
  for (const k of ['continue', 'rows', 'watchlist', 'recommended', 'forYou', 'customCollections', 'upcoming']) assert.ok(k in d, k);
  for (const k of ['featured', 'because', 'topRated', 'hiddenGems', 'shortTonight', 'onThisDay', 'listening']) assert.ok(Array.isArray(d[k]), k);
  assert.equal(d.homeLayout.hero, 'auto');
  assert.equal(d.homeLayout.custom, false);
  assert.ok(d.homeLayout.order.includes('because') && d.homeLayout.order.includes('collections'));
});

t('Eftersom du såg: senast sedda titeln, liknande genrer, inget sett', async () => {
  const d = await home();
  const b = d.because.find(x => x.seed.id === S.seed);
  assert.ok(b, JSON.stringify(d.because.map(x => x.seed)));
  assert.equal(b.seed.title, 'Fröfilm');
  assert.ok(b.items.length >= 4);
  assert.ok(!ids(b.items).includes(S.seed) && !ids(b.items).includes(S.topSeen));
  assert.ok(b.items.every(i => i.genres.some(g => ['Komedi', 'Familj'].includes(g))));
});

t('Topprankat: osedda först; guldkorn: gamla, osedda, högt betyg; kort film: osedda under 95 min', async () => {
  const d = await home();
  const top = ids(d.topRated);
  assert.ok(top.indexOf(S.top) >= 0 && top.indexOf(S.topSeen) > top.indexOf(S.top), JSON.stringify(top));
  assert.ok(ids(d.hiddenGems).includes(S.gem));
  assert.ok(!ids(d.hiddenGems).includes(S.newGood), 'nyss tillagd är inget glömt guldkorn');
  assert.ok(!ids(d.hiddenGems).includes(S.topSeen));
  assert.ok(ids(d.shortTonight).includes(S.short) && ids(d.shortTonight).includes(S.kidShort));
  assert.ok(!ids(d.shortTonight).includes(S.tooShort) && !ids(d.shortTonight).includes(S.top));
  assert.ok(d.genreOfDay?.genre && d.genreOfDay.items.length >= 4);
});

t('Den här dagen: premiärdag och sedd för ett år sedan', async () => {
  const d = await home();
  const a = d.onThisDay.find(i => i.id === S.anniversary);
  assert.ok(a, JSON.stringify(d.onThisDay.map(i => i.title)));
  assert.deepEqual([a.onThisDay.kind, a.onThisDay.years], ['premiere', 30]);
  if (!S.leap) {
    const y = d.onThisDay.find(i => i.id === S.yearAgo);
    assert.ok(y);
    assert.equal(y.onThisDay.kind, 'watched');
    assert.match(y.onThisDay.note, /ett år sedan/);
  }
});

t('Fortsätt lyssna och Utvalt', async () => {
  const d = await home();
  assert.deepEqual(d.listening.map(x => [x.type, x.id, x.podcastTitle]), [['podcast', 1, 'Testpodden']]);
  assert.ok(d.featured.length >= 1 && d.featured.length <= 5);
  assert.ok(d.featured.every(i => i.backdrop && i.overview && !i.watched));
});

t('barnprofilen ser bara titlar inom åldersgränsen på alla hyllor', async () => {
  const d = await home(kidToken);
  const all = [...d.featured, ...d.topRated, ...d.hiddenGems, ...d.shortTonight, ...d.onThisDay, ...(d.genreOfDay?.items || []), ...d.because.flatMap(b => b.items), ...d.recommended];
  assert.ok(all.length > 0);
  assert.ok(all.every(i => i.age != null && i.age <= 7), JSON.stringify(all.filter(i => !(i.age <= 7)).map(i => i.title)));
  assert.ok(!all.some(i => i.id === S.adultTop));
  // Vuxenprofilen ser den
  assert.ok(ids((await home()).topRated).includes(S.adultTop));
});

t('sedd film försvinner direkt ur osedda hyllor (cachen följer framsteget)', async () => {
  assert.ok(ids((await home()).shortTonight).includes(S.short));
  assert.equal((await req(`/api/items/${S.short}/watched`, { method: 'POST', body: { watched: true } })).status, 200);
  const d = await home();
  assert.ok(!ids(d.shortTonight).includes(S.short));
  // ... och blir nytt frö för Eftersom du såg
  assert.equal(d.because[0]?.seed.id, S.short);
});

t('Anpassa startsidan: ordning, dolda hyllor och Utvalt sparas per användare', async () => {
  assert.equal((await req('/api/me/home-layout', { method: 'PUT', body: { order: 'fel' } })).status, 400);
  assert.equal((await req('/api/me/home-layout', { method: 'PUT', body: { hero: 'ibland' } })).status, 400);
  const r = await req('/api/me/home-layout', { method: 'PUT', body: { order: ['gems', 'okänd', 'continue'], hidden: ['toprated', 'listening', 'påhittad'], hero: 'off' } });
  assert.equal(r.status, 200);
  assert.ok(r.data.order.indexOf('gems') < r.data.order.indexOf('continue'), JSON.stringify(r.data.order));
  assert.equal(r.data.order.length, new Set(r.data.order).size);
  assert.ok(r.data.order.includes('collections') && !r.data.order.includes('okänd'), 'nya hyllor läggs till, okända tas bort');
  assert.deepEqual(r.data.hidden, ['toprated', 'listening']);
  const d = await home();
  assert.equal(d.homeLayout.hero, 'off');
  assert.deepEqual(d.featured, []);
  assert.deepEqual(d.topRated, [], 'dold hylla räknas inte');
  assert.deepEqual(d.listening, []);
  assert.ok(d.hiddenGems.length > 0);
  // Befintliga fält skickas alltid (apparna)
  assert.ok(Array.isArray(d.continue) && Array.isArray(d.recommended));
  // Barnprofilen har sin egen layout
  assert.equal((await home(kidToken)).homeLayout.custom, false);
  const reset = await req('/api/me/home-layout', { method: 'PUT', body: { reset: true } });
  assert.equal(reset.data.custom, false);
  assert.equal(reset.data.order[0], 'foryou');
  assert.ok((await home()).topRated.length > 0);
});
