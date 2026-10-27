// Bibliotekets filter, sortering, "Blanda" och smarta samlingar mot en riktig server (server/libfilter.js,
// /api/libraries/:id/items|facets|shuffle, smarta samlingar i /api/custom-collections). Titlarna läggs direkt i
// databasen med ffprobe-liknande streams (biblioteksmapparna finns inte, så skanningen rör dem inte).
// Kontrollerar varje filter och sortering, att de gamla parametrarna ger samma svar som förut, injektionsförsök,
// barnprofilens åldersgräns och biblioteksbehörighet. Kräver ffmpeg som övriga servertester.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-lf-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 26000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, admin = '', bo = '', kid = '';
const S = {};
const NOW = Math.floor(Date.now() / 1000), DAY = 86400;

async function req(p, { method = 'GET', body, tok = admin } = {}) {
  const h = {};
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (name, password) => (await req('/api/login', { method: 'POST', body: { name, password, app: true }, tok: '' })).data.token;
/** Titlarnas namn för en fråga mot filmbiblioteket (eller serier) */
const names = async (q, lib = S.movies, tok = admin) => {
  const r = await req(`/api/libraries/${lib}/items${q ? '?' + q : ''}`, { tok });
  assert.equal(r.status, 200, `${q}: ${JSON.stringify(r.data)}`);
  return r.data.items.map(i => i.title);
};
const set = (a) => [...a].sort();

before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(MEDIA, { recursive: true });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '', WATCH_FILES: '0', SCAN_INTERVAL: '0' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

const streams = ({ a = [], s = [] } = {}) => JSON.stringify([{ index: 0, type: 'video', codec: 'hevc' },
  ...a.map((x, i) => ({ index: 1 + i, type: 'audio', codec: x.codec || 'aac', lang: x.lang || null, channels: x.ch || 2, title: x.title || null, ...(x.profile ? { profile: x.profile } : {}) })),
  ...s.map((l, i) => ({ index: 10 + i, type: 'subtitle', codec: 'subrip', lang: l }))]);

t('förberedelse: konton, barnprofil, bibliotek och titlar', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin', PW); assert.ok(admin);
  for (let i = 0; i < 60; i++) { if ((await req('/api/scan')).data.last) break; await sleep(250); }
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const lib = (name, type) => Number(db.prepare('INSERT INTO libraries(name,type,path) VALUES(?,?,?)').run(name, type, path.join(MEDIA, 'saknas-' + type)).lastInsertRowid);
  S.movies = lib('Filmer', 'movie'); S.shows = lib('Serier', 'show'); S.other = lib('Annat', 'movie');
  const ins = db.prepare(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,year,season,episode,duration,rating,age,added,genres,width,height,hdr,streams,path,collection_id,version_of)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  const item = (l, kind, title, o = {}) => Number(ins.run(l, kind, o.parent ?? null, title, title.toLowerCase(), o.year ?? null, o.season ?? null, o.episode ?? null,
    o.dur ?? null, o.rating ?? null, o.age ?? null, o.added ?? NOW - 400 * DAY, o.genres ? JSON.stringify(o.genres) : null, o.w ?? null, o.h ?? null, o.hdr ?? null,
    o.streams ?? null, kind === 'show' ? null : path.join(MEDIA, 'saknas', `${title}-${++n}.mkv`), o.coll ?? null, o.version ?? null).lastInsertRowid);
  // Filmer: Alfa (90-tal, 4K Dolby Vision, Atmos, svenskt ljud), Beta (1080p HDR10, 5.1 engelska, sv undertext),
  // Gamma (720p stereo), Delta (SD, barntillåten, i en samling), Epsilon (vuxen, utan betyg och åldersgräns)
  S.alfa = item(S.movies, 'movie', 'Alfa', { year: 1994, dur: 150 * 60, rating: 8.5, age: 15, added: NOW - 2 * DAY, genres: ['Drama', 'Thriller'], w: 3840, h: 2160, hdr: 'dovi',
    streams: streams({ a: [{ lang: 'swe', ch: 8, codec: 'truehd', profile: 'Dolby TrueHD + Dolby Atmos' }], s: ['eng'] }) });
  S.beta = item(S.movies, 'movie', 'Beta', { year: 2005, dur: 100 * 60, rating: 7.1, age: 11, added: NOW - 40 * DAY, genres: ['Drama', 'Komedi'], w: 1920, h: 800, hdr: 'hdr10',
    streams: streams({ a: [{ lang: 'eng', ch: 6 }], s: ['swe', 'fin'] }) });
  S.gamma = item(S.movies, 'movie', 'Gamma', { year: 1999, dur: 80 * 60, rating: 5.0, age: 7, added: NOW - 100 * DAY, genres: ['Komedi'], w: 1280, h: 720,
    streams: streams({ a: [{ lang: 'eng', ch: 2 }] }) });
  S.delta = item(S.movies, 'movie', 'Delta', { year: 1985, dur: 95 * 60, rating: 6.0, age: 0, added: NOW - 300 * DAY, genres: ['Animerat'], w: 720, h: 576, coll: 1,
    streams: streams({ a: [{ lang: 'swe', ch: 2, title: 'Svenska' }] }) });
  S.eps = item(S.movies, 'movie', 'Epsilon', { year: 2020, dur: 120 * 60, age: null, added: NOW - 10 * DAY, genres: ['Skräck'], w: 1920, h: 1080,
    streams: streams({ a: [{ lang: 'fre', ch: 2, title: 'Français DTS:X' }] }) });
  // En 4K-version av Gamma (version_of): Gamma ska träffas av 4K men bara visas en gång
  S.gamma4k = item(S.movies, 'movie', 'Gamma', { year: 1999, dur: 80 * 60, age: 7, w: 3840, h: 2160, hdr: 'hdr10', version: S.gamma, streams: streams({ a: [{ lang: 'eng', ch: 6 }] }) });
  S.zeta = item(S.other, 'movie', 'Zeta', { year: 2001, age: 0, genres: ['Drama'], w: 1920, h: 1080, streams: streams({ a: [{ lang: 'swe' }] }) });
  // Serier: Pågående (3 säsonger, ett 4K-avsnitt med svenskt ljud) och Avslutad (1 säsong, 1080p, barntillåten)
  S.ong = item(S.shows, 'show', 'Pågående', { year: 2019, rating: 8, age: 15, genres: ['Drama'], added: NOW - 200 * DAY });
  S.end = item(S.shows, 'show', 'Avslutad', { year: 2010, rating: 6, age: 0, genres: ['Komedi'], added: NOW - 200 * DAY });
  S.ongEps = [];
  for (const [s, e, w, h, l] of [[1, 1, 1920, 1080, 'eng'], [1, 2, 1920, 1080, 'eng'], [2, 1, 3840, 2160, 'swe'], [3, 1, 1920, 1080, 'eng']])
    S.ongEps.push(item(S.shows, 'episode', `Pågående S${s}E${e}`, { parent: S.ong, season: s, episode: e, dur: 45 * 60, w, h, added: NOW - (s === 3 ? 1 : 200) * DAY, streams: streams({ a: [{ lang: l, ch: 2 }] }) }));
  S.endEps = [1, 2].map(e => item(S.shows, 'episode', `Avslutad S1E${e}`, { parent: S.end, season: 1, episode: e, dur: 22 * 60, w: 1920, h: 1080, added: NOW - 200 * DAY, streams: streams({ a: [{ lang: 'swe', ch: 2 }] }) }));
  db.prepare("INSERT INTO calendar_shows(show_id,tmdb_id,status,fetched) VALUES(?,1,'Returning Series',1),(?,2,'Ended',1)").run(S.ong, S.end);
  db.prepare("INSERT INTO collections(id,name) VALUES(1,'Deltaserien')").run();
  // Framsteg för administratören: Alfa sedd (senast), Beta påbörjad, Pågående: ett avsnitt sett
  const uid = db.prepare("SELECT id FROM users WHERE name='admin'").get().id;
  const prog = db.prepare('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,?,?)');
  prog.run(uid, S.alfa, 0, 9000, 1, NOW - 100); prog.run(uid, S.beta, 600, 6000, 0, NOW - 50); prog.run(uid, S.ongEps[0], 0, 2700, 1, NOW - 10);
  db.close();
  // Bo får bara se filmbiblioteket; barnprofilen Lisa har åldersgräns 7
  const r = await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW, libraries: [S.movies] } });
  assert.equal(r.status, 200);
  bo = await login('bo', PW); assert.ok(bo);
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  const k = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  kid = (await req('/api/profiles/switch', { method: 'POST', body: { id: k } })).data.token;
  assert.ok(kid);
  admin = await login('admin', PW);
});

t('de gamla parametrarna ger samma svar som förut (apparna)', async () => {
  assert.deepEqual(await names(''), ['Alfa', 'Beta', 'Delta', 'Epsilon', 'Gamma']);
  assert.deepEqual(await names('sort=title'), ['Alfa', 'Beta', 'Delta', 'Epsilon', 'Gamma']);
  assert.deepEqual(await names('sort=year'), ['Epsilon', 'Beta', 'Gamma', 'Alfa', 'Delta']);
  assert.deepEqual(await names('sort=added'), ['Alfa', 'Epsilon', 'Beta', 'Gamma', 'Delta']);
  assert.deepEqual(await names('sort=rating'), ['Alfa', 'Beta', 'Delta', 'Gamma', 'Epsilon']);
  assert.deepEqual(await names('filter=unwatched'), ['Beta', 'Delta', 'Epsilon', 'Gamma']);
  assert.deepEqual(await names('filter=watched'), ['Alfa']);
  const r = await req(`/api/libraries/${S.movies}/items`);
  assert.equal(r.data.total, undefined, 'total bara med filter eller sidindelning');
  assert.equal(r.data.query, '');
  const p = await req(`/api/libraries/${S.movies}/items?limit=2&offset=1`);
  assert.deepEqual([p.data.total, p.data.limit, p.data.offset, p.data.items.length], [5, 2, 1, 2]);
  // Serier: avsnittsräkning som förut
  const sh = (await req(`/api/libraries/${S.shows}/items?filter=unwatched`)).data.items;
  assert.deepEqual(sh.map(i => [i.title, i.episodes, i.watchedEpisodes, i.seasons]), [['Avslutad', 2, 0, 1], ['Pågående', 4, 1, 3]]);
});

t('varje filter för filmer', async () => {
  assert.deepEqual(set(await names('genre=Drama')), ['Alfa', 'Beta']);
  assert.deepEqual(set(await names('genre=Drama,Komedi')), ['Alfa', 'Beta', 'Gamma'], 'någon av genrerna');
  assert.deepEqual(set(await names('genre=Drama&genre=Komedi&genreAll=1')), ['Beta'], 'alla valda genrer');
  assert.deepEqual(set(await names('yearMin=1990&yearMax=1999')), ['Alfa', 'Gamma']);
  assert.deepEqual(set(await names('yearMin=1999&yearMax=1990')), ['Alfa', 'Gamma'], 'omvänt intervall vänds');
  assert.deepEqual(set(await names('ratingMin=7')), ['Alfa', 'Beta']);
  assert.deepEqual(set(await names('durMax=89')), ['Gamma']);
  assert.deepEqual(set(await names('durMin=90&durMax=130')), ['Beta', 'Delta', 'Epsilon']);
  assert.deepEqual(set(await names('durMin=131')), ['Alfa']);
  assert.deepEqual(set(await names('res=4k')), ['Alfa', 'Gamma'], 'Gamma har en 4K-version');
  assert.deepEqual(set(await names('res=1080')), ['Beta', 'Epsilon'], '1920×800 räknas som 1080p');
  assert.deepEqual(set(await names('res=720')), ['Gamma']);
  assert.deepEqual(set(await names('res=sd')), ['Delta']);
  assert.deepEqual(set(await names('res=sd,720')), ['Delta', 'Gamma']);
  assert.deepEqual(set(await names('hdr=dovi')), ['Alfa']);
  assert.deepEqual(set(await names('hdr=hdr')), ['Alfa', 'Beta', 'Gamma']);
  assert.deepEqual(set(await names('hdr=sdr')), ['Delta', 'Epsilon', 'Gamma']);
  assert.deepEqual(set(await names('audio=atmos')), ['Alfa', 'Epsilon'], 'Atmos ur profilen, DTS:X ur spårets titel');
  assert.deepEqual(set(await names('audio=surround')), ['Alfa', 'Beta', 'Gamma']);
  assert.deepEqual(set(await names('audio=stereo')), ['Delta', 'Epsilon', 'Gamma']);
  assert.deepEqual(set(await names('alang=sv')), ['Alfa', 'Delta'], 'swe normaliseras till sv');
  assert.deepEqual(set(await names('alang=swe')), ['Alfa', 'Delta']);
  assert.deepEqual(set(await names('slang=sv')), ['Beta']);
  assert.deepEqual(set(await names('slang=fi,en')), ['Alfa', 'Beta']);
  // Samma fil: 4K och engelskt surroundljud finns bara i Gammas 4K-version, Alfa har 4K men svenskt ljud
  assert.deepEqual(set(await names('res=4k&alang=en')), ['Gamma']);
  assert.deepEqual(set(await names('filter=inprogress')), ['Beta']);
  assert.deepEqual(set(await names('addedDays=30')), ['Alfa', 'Epsilon']);
  assert.deepEqual(set(await names('ageMax=7')), ['Delta', 'Gamma'], 'utan åldersgräns räknas inte');
  assert.deepEqual(set(await names('coll=yes')), ['Delta']);
  assert.deepEqual(set(await names('coll=no')), ['Alfa', 'Beta', 'Epsilon', 'Gamma']);
  // Kombinerade
  assert.deepEqual(await names('genre=Drama,Komedi&ratingMin=5&res=1080,4k&sort=year&order=asc'), ['Alfa', 'Gamma', 'Beta']);
  const r = await req(`/api/libraries/${S.movies}/items?res=4k&genre=Drama`);
  assert.equal(r.data.total, 1);
  assert.equal(r.data.query, 'genre=Drama&res=4k', 'normaliserat i fast ordning');
});

t('varje filter för serier', async () => {
  const sh = (q) => names(q, S.shows);
  assert.deepEqual(await sh('status=ongoing'), ['Pågående']);
  assert.deepEqual(await sh('status=ended'), ['Avslutad']);
  assert.deepEqual(await sh('seasonsMin=2'), ['Pågående']);
  assert.deepEqual(await sh('seasonsMax=1'), ['Avslutad']);
  assert.deepEqual(await sh('res=4k'), ['Pågående'], 'något avsnitt i 4K');
  assert.deepEqual(await sh('alang=sv'), ['Avslutad', 'Pågående']);
  assert.deepEqual(await sh('res=4k&alang=en'), [], 'samma avsnitt ska ha båda');
  assert.deepEqual(await sh('durMax=29'), ['Avslutad'], 'avsnittens längd');
  assert.deepEqual(await sh('addedDays=7'), ['Pågående'], 'nytt avsnitt räknas');
  assert.deepEqual(await sh('filter=inprogress'), ['Pågående']);
  assert.deepEqual(await sh('filter=watched'), []);
  assert.deepEqual(await sh('coll=yes'), ['Avslutad', 'Pågående'], 'samlingsfiltret gäller bara filmer');
  assert.deepEqual(await sh('sort=lastwatched'), ['Pågående', 'Avslutad']);
});

t('sortering: alla nycklar med stigande och fallande', async () => {
  assert.deepEqual(await names('sort=title&order=desc'), ['Gamma', 'Epsilon', 'Delta', 'Beta', 'Alfa']);
  assert.deepEqual(await names('sort=year&order=asc'), ['Delta', 'Alfa', 'Gamma', 'Beta', 'Epsilon']);
  assert.deepEqual(await names('sort=rating&order=asc'), ['Gamma', 'Delta', 'Beta', 'Alfa', 'Epsilon'], 'utan betyg sist');
  assert.deepEqual(await names('sort=added&order=asc'), ['Delta', 'Gamma', 'Beta', 'Epsilon', 'Alfa']);
  assert.deepEqual(await names('sort=lastwatched'), ['Beta', 'Alfa', 'Delta', 'Epsilon', 'Gamma'], 'aldrig sedda sist');
  assert.deepEqual(await names('sort=lastwatched&order=asc'), ['Alfa', 'Beta', 'Delta', 'Epsilon', 'Gamma']);
  assert.deepEqual(await names('sort=duration'), ['Alfa', 'Epsilon', 'Beta', 'Delta', 'Gamma']);
  assert.deepEqual(await names('sort=duration&order=asc'), ['Gamma', 'Delta', 'Beta', 'Epsilon', 'Alfa']);
  // Blandat: samma frö = samma ordning (sidindelning), alla titlar med
  const a = await names('sort=random&seed=42'), b = await names('sort=random&seed=42');
  assert.deepEqual(a, b);
  assert.deepEqual(set(a), ['Alfa', 'Beta', 'Delta', 'Epsilon', 'Gamma']);
  const seeds = new Set();
  for (let s = 1; s <= 8; s++) seeds.add((await names('sort=random&seed=' + s)).join());
  assert.ok(seeds.size > 1, 'olika frön ger olika ordning');
  const p1 = await names('sort=random&seed=7&limit=2'), p2 = await names('sort=random&seed=7&limit=3&offset=2');
  assert.deepEqual([...p1, ...p2], await names('sort=random&seed=7'));
});

t('samlingskort med sidindelning delar aldrig en samling', async () => {
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.prepare('UPDATE items SET collection_id=1 WHERE id IN (?,?)').run(S.alfa, S.eps);
  db.close();
  const all = (await req(`/api/libraries/${S.movies}/items?collections=1`)).data.items;
  assert.deepEqual(all.map(i => i.kind === 'collection' ? 'samling' : i.title), ['samling', 'Beta', 'Gamma'], 'tre filmer i samlingen blir ett kort');
  const p1 = (await req(`/api/libraries/${S.movies}/items?collections=1&limit=2`)).data, p2 = (await req(`/api/libraries/${S.movies}/items?collections=1&limit=2&offset=2`)).data;
  assert.equal(p1.total, 3);
  assert.deepEqual([...p1.items, ...p2.items].map(i => i.kind === 'collection' ? 'samling:' + i.count : i.title), ['samling:3', 'Beta', 'Gamma']);
  const db2 = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db2.prepare('UPDATE items SET collection_id=NULL WHERE id IN (?,?)').run(S.alfa, S.eps);
  db2.close();
});

t('injektionsförsök blir parametrar eller ignoreras', async () => {
  const before = (await req(`/api/libraries/${S.movies}/items`)).data.items.length;
  for (const q of ["genre=Drama')%20OR%201=1--", 'genre=%22%5D%27%29;DROP%20TABLE%20items;--', "sort=i.id;DROP%20TABLE%20items", 'sort=title&order=desc;--',
    "alang=sv',1)%20OR%201=1--", 'yearMin=1990%20OR%201=1', 'ratingMin=1e9', 'durMin=-5', 'res=4k)%20OR%20(1=1', 'hdr=dovi%27', 'seed=1;DROP', 'sort=random&seed=1%20OR%201',
    'ageMax=7%20OR%201=1', 'coll=yes%27--', 'filter=watched%27%20OR%201=1--', 'genre=' + 'x,'.repeat(500)]) {
    const r = await req(`/api/libraries/${S.movies}/items?${q}`);
    assert.equal(r.status, 200, q);
    assert.ok(r.data.items.length <= before, q);
  }
  assert.deepEqual(await names("genre=Drama')%20OR%201=1--"), [], 'genren är bara ett värde');
  assert.equal((await req(`/api/libraries/${S.movies}/items?yearMin=1990%20OR%201=1`)).data.query, '', 'ogiltiga tal tas bort');
  assert.equal((await req(`/api/libraries/${S.movies}/items?sort=i.id;DROP`)).data.query, '');
  const many = Array.from({ length: 100 }, (_, i) => 'g' + i).join(',');
  assert.equal(decodeURIComponent((await req(`/api/libraries/${S.movies}/items?genre=${many}`)).data.query).split(',').length, 30, 'högst 30 värden');
  assert.equal((await req(`/api/libraries/${S.movies}/items`)).data.items.length, before, 'tabellen finns kvar');
  // Smart samling med fientligt filter: normaliseras och sparas som vanlig text
  const c = await req('/api/custom-collections', { method: 'POST', body: { name: 'Elak', smart: { library: S.movies, query: "genre=Drama&sort=title;DROP TABLE items&__proto__=1&ratingMin=x" } } });
  assert.equal(c.status, 200);
  const d = (await req(`/api/custom-collections/${c.data.id}`)).data;
  assert.equal(d.query, 'genre=Drama');
  assert.deepEqual(set(d.items.map(i => i.title)), ['Alfa', 'Beta']);
  assert.equal((await req(`/api/custom-collections/${c.data.id}`, { method: 'DELETE' })).status, 200);
});

t('facets: värdena i biblioteket inom profilens gränser', async () => {
  const f = (await req(`/api/libraries/${S.movies}/facets`)).data;
  assert.equal(f.total, 5);
  assert.deepEqual(f.genres.map(g => g.name), ['Animerat', 'Drama', 'Komedi', 'Skräck', 'Thriller']);
  assert.deepEqual(f.years, { min: 1985, max: 2020 });
  assert.deepEqual(f.res.map(x => [x.value, x.count]), [['sd', 1], ['720', 1], ['1080', 2], ['4k', 2]]);
  assert.ok(f.hdr.find(x => x.value === 'dovi' && x.count === 1));
  assert.ok(f.audio.find(x => x.value === 'atmos' && x.count === 2));
  assert.deepEqual(f.alang.map(x => x.value).sort(), ['en', 'fr', 'sv']);
  assert.deepEqual(f.slang.map(x => x.value).sort(), ['en', 'fi', 'sv']);
  assert.deepEqual(f.ages.map(a => a.age), [0, 7, 11, 15]);
  assert.equal(f.collections, 1);
  const s = (await req(`/api/libraries/${S.shows}/facets`)).data;
  assert.deepEqual(s.status, { ongoing: 1, ended: 1 });
  assert.equal(s.seasonsMax, 3);
  // Barnprofilen (högst 7 år) ser inte de vuxna titlarnas genrer eller egenskaper
  const k = (await req(`/api/libraries/${S.movies}/facets`, { tok: kid })).data;
  assert.equal(k.total, 2);
  assert.deepEqual(k.genres.map(g => g.name), ['Animerat', 'Komedi']);
  assert.ok(!k.hdr.find(x => x.value === 'dovi'), 'Alfas Dolby Vision syns inte');
  assert.ok(!k.audio.find(x => x.value === 'atmos'));
});

t('barnprofil och biblioteksbehörighet gäller alltid', async () => {
  assert.deepEqual(set(await names('', S.movies, kid)), ['Delta', 'Gamma']);
  assert.deepEqual(set(await names('genre=Drama,Komedi,Thriller,Skräck', S.movies, kid)), ['Gamma']);
  assert.deepEqual(await names('ageMax=21', S.movies, kid), ['Delta', 'Gamma'], 'filtret kan inte vidga åldersgränsen');
  assert.deepEqual(await names('audio=atmos', S.movies, kid), []);
  assert.deepEqual(await names('', S.shows, kid), ['Avslutad']);
  for (let i = 0; i < 15; i++) {
    const r = await req(`/api/libraries/${S.movies}/shuffle`, { tok: kid });
    assert.equal(r.status, 200);
    assert.ok([S.delta, S.gamma].includes(r.data.play.id), 'Blanda väljer bara tillåtna titlar');
  }
  // Bo ser bara filmbiblioteket
  assert.equal((await req(`/api/libraries/${S.shows}/items?genre=Drama`, { tok: bo })).status, 404);
  assert.equal((await req(`/api/libraries/${S.shows}/facets`, { tok: bo })).status, 404);
  assert.equal((await req(`/api/libraries/${S.shows}/shuffle`, { tok: bo })).status, 404);
  assert.equal((await req(`/api/libraries/${S.other}/items`, { tok: bo })).status, 404);
  assert.equal((await req('/api/custom-collections', { method: 'POST', body: { name: 'X', smart: { library: S.shows, query: '' } }, tok: bo })).status, 400,
    'smart samling bara för bibliotek man ser');
  assert.equal((await req('/api/custom-collections', { method: 'POST', body: { name: 'X', smart: { library: 99999, query: '' } } })).status, 400);
});

t('Blanda: film ur filtreringen, serie → slumpat avsnitt', async () => {
  for (let i = 0; i < 10; i++) {
    const r = (await req(`/api/libraries/${S.movies}/shuffle?genre=Drama`)).data;
    assert.ok([S.alfa, S.beta].includes(r.play.id));
    assert.equal(r.item.id, r.play.id);
  }
  const ids = new Set();
  for (let i = 0; i < 20; i++) {
    const r = (await req(`/api/libraries/${S.shows}/shuffle?status=ongoing`)).data;
    assert.equal(r.item.id, S.ong); assert.equal(r.play.kind, 'episode'); assert.ok(S.ongEps.includes(r.play.id));
    ids.add(r.play.id);
  }
  assert.ok(ids.size > 1, 'olika avsnitt');
  // Osedda: aldrig det sedda avsnittet
  for (let i = 0; i < 15; i++) assert.notEqual((await req(`/api/libraries/${S.shows}/shuffle?status=ongoing&filter=unwatched`)).data.play.id, S.ongEps[0]);
  assert.equal((await req(`/api/libraries/${S.movies}/shuffle?genre=Finns-inte`)).status, 404);
});

t('smart samling: räknas fram vid visning, delad, barnprofil, startsidan', async () => {
  const r = await req('/api/custom-collections', { method: 'POST', body: { name: 'Drama och komedi', shared: true, home: true, smart: { library: S.movies, query: 'genre=Drama,Komedi&sort=year&order=asc' } } });
  assert.equal(r.status, 200); S.smart = r.data.id;
  let d = (await req(`/api/custom-collections/${S.smart}`)).data;
  assert.equal(d.smart, true); assert.equal(d.library, S.movies); assert.equal(d.query, 'genre=Drama%2CKomedi&sort=year&order=asc');
  assert.deepEqual(d.items.map(i => i.title), ['Alfa', 'Gamma', 'Beta'], 'filtrets ordning');
  assert.equal(d.count, 3);
  // Ny titel som matchar dyker upp utan att samlingen ändras
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  S.ny = Number(db.prepare(`INSERT INTO items(library_id,kind,title,sort_title,year,age,added,genres) VALUES(?,'movie','Ny','ny',2024,7,?,'["Komedi"]')`).run(S.movies, NOW).lastInsertRowid);
  db.close();
  d = (await req(`/api/custom-collections/${S.smart}`)).data;
  assert.deepEqual(d.items.map(i => i.title), ['Alfa', 'Gamma', 'Beta', 'Ny']);
  // Barnprofilen ser bara sina titlar; Bo (bara filmbiblioteket) ser den
  assert.deepEqual((await req(`/api/custom-collections/${S.smart}`, { tok: kid })).data.items.map(i => i.title), ['Gamma', 'Ny']);
  assert.equal((await req(`/api/custom-collections/${S.smart}`, { tok: bo })).status, 200);
  // Titlar läggs inte till för hand, ordningen följer filtret
  assert.equal((await req(`/api/custom-collections/${S.smart}/items`, { method: 'POST', body: { id: S.delta } })).status, 400);
  assert.equal((await req(`/api/custom-collections/${S.smart}/order`, { method: 'PUT', body: { ids: [S.beta] } })).status, 400);
  assert.ok(!(await req('/api/custom-collections?editable=1')).data.find(c => c.id === S.smart), 'inte i "Lägg till i samling…"');
  // has för en titel som filtret träffar, och listan per bibliotek
  assert.equal((await req(`/api/custom-collections?item=${S.beta}`)).data.find(c => c.id === S.smart).has, true);
  assert.equal((await req(`/api/custom-collections?item=${S.delta}`)).data.find(c => c.id === S.smart).has, false);
  assert.ok((await req(`/api/custom-collections?library=${S.movies}`)).data.find(c => c.id === S.smart));
  assert.ok(!(await req(`/api/custom-collections?library=${S.shows}`)).data.find(c => c.id === S.smart));
  // Startsidan
  const home = (await req('/api/home')).data.customCollections.find(c => c.id === S.smart);
  assert.deepEqual(home.items.map(i => i.title), ['Alfa', 'Gamma', 'Beta', 'Ny']);
  // Nytt filter (bara den som får ändra), och en vanlig samling blir inte smart
  assert.equal((await req(`/api/custom-collections/${S.smart}`, { method: 'PUT', body: { smart: { library: S.movies, query: 'res=4k' } } })).status, 200);
  d = (await req(`/api/custom-collections/${S.smart}`)).data;
  assert.deepEqual(set(d.items.map(i => i.title)), ['Alfa', 'Gamma']);
  assert.equal(d.name, 'Drama och komedi');
  assert.equal((await req(`/api/custom-collections/${S.smart}`, { method: 'PUT', body: { smart: { library: S.movies, query: '' } }, tok: bo })).status, 403);
  const plain = (await req('/api/custom-collections', { method: 'POST', body: { name: 'Vanlig' } })).data.id;
  assert.equal((await req(`/api/custom-collections/${plain}`, { method: 'PUT', body: { smart: { library: S.movies, query: '' } } })).status, 400);
  // Blanda i samlingen
  for (let i = 0; i < 6; i++) assert.ok([S.alfa, S.gamma].includes((await req(`/api/custom-collections/${S.smart}/shuffle`)).data.play.id));
  // Barnprofilen ser inte en smart samling utan tillåtna titlar (namnet läcker inte)
  assert.equal((await req(`/api/custom-collections/${S.smart}`, { method: 'PUT', body: { smart: { library: S.movies, query: 'hdr=dovi' } } })).status, 200);
  assert.equal((await req(`/api/custom-collections/${S.smart}`, { tok: kid })).status, 404);
  assert.ok(!(await req('/api/custom-collections', { tok: kid })).data.find(c => c.id === S.smart));
  assert.equal((await req(`/api/custom-collections/${S.smart}/shuffle`, { tok: kid })).status, 404);
  // Ett bibliotek man inte får se ger en tom (dold) samling
  const sh = (await req('/api/custom-collections', { method: 'POST', body: { name: 'Serier', shared: true, smart: { library: S.shows, query: '' } } })).data.id;
  assert.equal((await req(`/api/custom-collections/${sh}`)).data.count, 2);
  assert.equal((await req(`/api/custom-collections/${sh}`, { tok: bo })).status, 404);
});

// Webbläsaren (Playwright om det finns): filterpanelen, chips, adressen, sparat filter och "Spara som smart samling"
test('webben: filterpanel, chips, adress och smart samling på 375 och 1280 px', { skip: !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false }, async () => {
  const lr = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) });
  const cookie = /kt=([0-9a-f]+)/.exec(lr.headers.get('set-cookie'))[1];
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 375]) {
      const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 740 : 800 } });
      await ctx.addCookies([{ name: 'kt', value: cookie, url: B }]);
      const page = await ctx.newPage(), errors = [];
      page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400 && !/\/api\/(image|collection-image)/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
      // En delad länk: filtret ur adressen, chips och antal
      await page.goto(`${B}/#/lib/${S.movies}?genre=Drama,Komedi&res=4k`);
      await page.waitForSelector('#libgrid .card');
      assert.deepEqual(set(await page.$$eval('#libgrid .card .t', a => a.map(x => x.textContent.trim()))), ['Alfa', 'Gamma']);
      assert.deepEqual(await page.$$eval('.fchip', a => a.map(x => x.textContent.replace('✕', '').trim())), ['Drama', 'Komedi', '4K']);
      assert.equal(await page.textContent('.fcount'), '3');
      // Panelen: tangentbord, förhandsräkning och Använd
      await page.click('#fbtn');
      await page.waitForSelector('.fpanel input[name=audio][value=atmos]');
      assert.equal(await page.getAttribute('#fbtn', 'aria-expanded'), 'true');
      await page.check('.fpanel input[name=audio][value=atmos]');
      await page.waitForFunction(() => /Visa 1 titel$/.test(document.querySelector('[data-apply]')?.textContent || ''));
      await page.click('[data-apply]');
      await page.waitForFunction(() => location.hash.includes('audio=atmos'));
      await page.waitForFunction(() => document.querySelectorAll('#libgrid .card').length === 1);
      // Ta bort ett chip med tangentbordet; Escape-stängd panel ger fokus tillbaka
      await page.focus('.fchip');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !location.hash.includes('genre=Drama%2C') && !/genre=Drama,/.test(location.hash));
      // Sortering och riktning syns i adressen och sparas per bibliotek
      await page.selectOption('#srt', 'year');
      await page.waitForFunction(() => location.hash.includes('sort=year'));
      await page.click('#sdir');
      await page.waitForFunction(() => location.hash.includes('order=asc'));
      const saved = await page.evaluate(() => location.hash.split('?')[1]);
      await page.goto(`${B}/#/`);
      await page.waitForSelector('.homefoot, .section');
      await page.goto(`${B}/#/lib/${S.movies}`);
      await page.waitForFunction((q) => location.hash.endsWith('?' + q) || location.hash.includes('sort=year'), saved);
      assert.ok((await page.evaluate(() => location.hash)).includes('order=asc'), 'filtret från webbläsaren');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'ingen vågrät rullning');
      if (width === 1280) {
        await page.click('[data-chip="all"]');
        await page.waitForFunction(() => !document.querySelector('.fchip'));
        await page.goto(`${B}/#/lib/${S.movies}?genre=Komedi`);
        await page.waitForSelector('#smartsave');
        await page.click('#smartsave');
        await page.fill('dialog input[name=name]', 'Komedier i webben');
        await page.click('dialog button[type=submit]');
        await page.waitForSelector('#toast.on');
        const c = (await req('/api/custom-collections')).data.find(x => x.name === 'Komedier i webben');
        assert.equal(c?.smart, true); assert.equal(c.query, 'genre=Komedi');
        await page.goto(`${B}/#/ucollection/${c.id}`);
        await page.waitForSelector('#cshuffle');
        assert.ok(!(await page.$('#corder')), 'ingen manuell ordning');
      }
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  } finally { await browser.close(); }
});
