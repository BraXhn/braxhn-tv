// Synk av tittarhistorik från Plex med flera profiler: en simulerad Plex-server och plex.tv (hemanvändare, växling
// med PIN, delade vänner, sidindelning som Plex kapar), en genererad Plex-databas i två schemavarianter, matchningsfallen
// (flera versioner, NFD-sökvägar, specials, dubbelavsnitt, TVDB- mot TMDB-ordning, samma titel olika år, originaltitel,
// romerska siffror), profiler som kopplas/skapas, att nyare historik här inte skrivs över utan val, löpande synk
// (bara ändringar, sparad token) och att token/PIN aldrig syns i svar eller loggar. Kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './helpers/port.js';
// Före första test(): en top-level await mellan testerna lät node:test köra after() innan de sista testerna
const PORT = await freePort();

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-plexsync-'));
const MEDIA = path.join(ROOT, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.DVR_DIR = path.join(ROOT, 'rec');
process.env.PODCAST_DIR = path.join(ROOT, 'pod');
delete process.env.TMDB_API_KEY;

// ---------- simulerad Plex-server och plex.tv ----------
const SECRETS = ['ownertok', 'anna-user', 'anna-srv', 'lilla-user', '1234'];
const T0 = 1700000000;
const fileM = (...files) => files.map(f => ({ Part: [{ file: f }] }));
const NFD = (s) => s.normalize('NFD');
const movies = [
  { ratingKey: '1', title: 'Arrival', year: 2016, duration: 6960000, Guid: [{ id: 'imdb://tt2543164' }, { id: 'tmdb://329865' }] },
  { ratingKey: '2', title: 'Fönstret', year: 2020, guid: 'plex://movie/5d77a', Media: fileM(NFD('/data/movies/Fönstret (2020)/Fönstret (2020).mkv')) },
  { ratingKey: '3', title: 'Fönstret', year: 1999, guid: 'plex://movie/5d77b' },
  { ratingKey: '4', title: 'Dune: Part One', year: 2021, guid: 'plex://movie/5d77c', Media: fileM('/data/movies4k/Dune.2021.2160p.mkv', '/data/movies/Dune (2021)/Dune (2021).mkv') },
  { ratingKey: '5', title: 'Amélie', originalTitle: "Le Fabuleux Destin d'Amélie Poulain", year: 2001, guid: 'plex://movie/5d77d' },
  { ratingKey: '6', title: 'Tystnaden', year: 1963, guid: 'plex://movie/5d77e', Guid: [{ id: 'imdb://tt0057611' }] },
  { ratingKey: '7', title: 'Rocky II', year: 1979, guid: 'plex://movie/5d77f' },
  { ratingKey: '8', title: 'Osedd', year: 2020 }
];
const shows = [
  { ratingKey: '100', title: 'Bron', year: 2011, Guid: [{ id: 'tmdb://555' }, { id: 'tvdb://252019' }] },
  { ratingKey: '200', title: 'Ordning', year: 2015, Guid: [{ id: 'tmdb://777' }] },
  { ratingKey: '300', title: 'Champions of Champions', year: 2008, guid: 'plex://show/mm' }
];
const ep = (rk, show, s, e, title, file) => ({ ratingKey: rk, grandparentRatingKey: show, grandparentTitle: shows.find(x => x.ratingKey === show).title, parentIndex: s, index: e, title, duration: 3600000, ...(file ? { Media: fileM(file) } : {}) });
const episodes = [
  ep('101', '100', 1, 1, 'Ett', '/data/tv/Bron/Season 1/Bron S01E01.mkv'),
  ep('102', '100', 1, 2, 'Två', '/data/tv/Bron/Season 1/Bron S01E02.mkv'),
  ep('103', '100', 1, 3, 'Tre'),
  ep('104', '100', 1, 4, 'Fyra', '/data/tv/Bron/Season 1/Bron S01E04-E05.mkv'),
  ep('105', '100', 1, 5, 'Fem', '/data/tv/Bron/Season 1/Bron S01E04-E05.mkv'),
  ep('110', '100', 0, 1, 'Special'),
  // Plex följer TMDB:s ordning (S02E01) – filen och biblioteket här följer TVDB (S01E10)
  ep('201', '200', 2, 1, 'Tio', '/plexonly/tv/Ordning/Season 1/Ordning S01E10.mkv'),
  ep('301', '300', 1, 1, 'Premiär', '/annan/plats/Mästarnas mästare/Säsong 1/Mästarnas mästare - S01E01.mkv')
];
// Tittarläge per servertoken (ratingKey → läge)
const state = {
  ownertok: {
    1: { viewCount: 1, lastViewedAt: T0 }, 2: { viewCount: 1, lastViewedAt: T0 + 1 }, 3: { viewCount: 0, viewOffset: 1200000, lastViewedAt: T0 + 2 },
    4: { viewCount: 1, lastViewedAt: T0 + 3 }, 5: { viewCount: 2, lastViewedAt: T0 + 4 }, 6: { viewCount: 1, lastViewedAt: T0 + 5 },
    7: { viewCount: 2, viewOffset: 300000, lastViewedAt: T0 + 500 },
    101: { viewCount: 1, lastViewedAt: T0 + 10 }, 102: { viewCount: 0, viewOffset: 900000, lastViewedAt: T0 + 1000 }, 104: { viewCount: 1, lastViewedAt: T0 + 11 },
    105: { viewOffset: 100000, lastViewedAt: T0 + 12 }, 110: { viewCount: 1, lastViewedAt: T0 + 13 }, 201: { viewCount: 1, lastViewedAt: T0 + 14 }, 301: { viewCount: 1, lastViewedAt: T0 + 15 }
  },
  'anna-srv': { 1: { viewOffset: 1800000, lastViewedAt: T0 + 2000 }, 103: { viewCount: 1, lastViewedAt: T0 + 2001 } },
  'lilla-user': { 2: { viewCount: 1, lastViewedAt: T0 + 3000 } }
};
const history = { 12: [{ ratingKey: '103', type: 'episode', viewedAt: T0 + 2001, accountID: 12 }], 99: [{ ratingKey: '1', type: 'movie', viewedAt: T0 - 5000, accountID: 99 },
  { ratingKey: '9999', type: 'movie', title: 'Borttagen', year: 1990, viewedAt: T0 - 4000, accountID: 99 }] };
const homeUsers = [
  { id: 1, uuid: 'uuid-bertil', title: 'Bertil', admin: true, restricted: false, protected: true },
  { id: 12, uuid: 'uuid-anna', title: 'Anna', admin: false, restricted: false, protected: true },
  { id: 13, uuid: 'uuid-lilla', title: 'Lilla', admin: false, restricted: true, restrictionProfile: 'little_kid', protected: false }
];
const calls = { switch: 0, pages: 0 };
const fake = http.createServer((q, r) => {
  const J = (o, s = 200) => { r.writeHead(s, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
  const u = new URL(q.url, 'http://x'), tok = q.headers['x-plex-token'];
  if (u.pathname.startsWith('/plextv/')) {
    const p = u.pathname.slice(7);
    if (p === '/api/v2/home/users') return tok === 'ownertok' ? J({ id: 1, name: 'Hemma', users: homeUsers }) : J({}, 401);
    const sw = /^\/api\/v2\/home\/users\/([^/]+)\/switch$/.exec(p);
    if (sw && q.method === 'POST') {
      calls.switch++;
      if (tok !== 'ownertok') return J({}, 401);
      if (sw[1] === 'uuid-anna') return u.searchParams.get('pin') === '1234' ? J({ authToken: 'anna-user' }) : J({ error: 'pin' }, 401);
      if (sw[1] === 'uuid-lilla') return J({ authToken: 'lilla-user' });
      return J({}, 404);
    }
    if (p === '/api/v2/resources') return tok === 'anna-user' ? J([{ clientIdentifier: 'machine-1', provides: 'server', accessToken: 'anna-srv' }]) : J([]);
    return J({}, 404);
  }
  if (!u.pathname.startsWith('/plex/')) return J({}, 404);
  const p = u.pathname.slice(5);
  if (p === '/identity') return J({ MediaContainer: { machineIdentifier: 'machine-1' } });
  if (!state[tok]) return J({}, 401);
  const start = +u.searchParams.get('X-Plex-Container-Start') || 0;
  const size = Math.min(+u.searchParams.get('X-Plex-Container-Size') || 50, 3); // Plex kapar sidan – totalSize gäller
  const page = (list) => { calls.pages++; J({ MediaContainer: { size: Math.min(size, Math.max(0, list.length - start)), totalSize: list.length, offset: start, Metadata: list.slice(start, start + size) } }); };
  const withState = (list) => list.map(m => ({ ...m, ...(state[tok][m.ratingKey] || {}) }));
  if (p === '/library/sections') return J({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Filmer' }, { key: '2', type: 'show', title: 'Serier' }, { key: '3', type: 'artist', title: 'Musik' }] } });
  if (p === '/library/sections/1/all') return page(withState(movies));
  if (p === '/library/sections/2/all' && u.searchParams.get('type') === '2') return page(shows);
  if (p === '/library/sections/2/all' && u.searchParams.get('type') === '4') return page(withState(episodes));
  if (p === '/accounts') return tok === 'ownertok' ? J({ MediaContainer: { Account: [{ id: 0, name: '' }, { id: 1, name: 'bertil' }, { id: 12, name: 'Anna' }, { id: 13, name: 'Lilla' }, { id: 99, name: 'Kompis' }, { id: 100, name: 'Tyst' }] } }) : J({}, 401);
  if (p === '/status/sessions/history/all') return page(history[u.searchParams.get('accountID')] || []);
  J({}, 404);
}).listen(0);
await new Promise(r => fake.once('listening', r));
const FB = `http://127.0.0.1:${fake.address().port}`;
process.env.PLEX_TV_URL = FB + '/plextv';
after(() => { fake.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const D = await import('../server/db.js');
const imp = await import('../server/mediaimport.js');
const pdb = await import('../server/plexdb.js');
const { run, get, all, getSetting } = D;

// ---------- biblioteket här ----------
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'bertil','x',1,0)");
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(3,'anna','x',0,0)"); // ett annat hushåll med samma namn
const FILM = path.join(MEDIA, 'Filmer'), TV = path.join(MEDIA, 'Serier');
run('INSERT INTO libraries(id,name,type,path) VALUES(1,?,?,?),(2,?,?,?)', 'Filmer', 'movie', FILM, 'Serier', 'show', TV);
const item = (o) => Number(run(`INSERT INTO items(library_id,kind,title,sort_title,original_title,year,tmdb_id,imdb_id,path,duration,parent_id,season,episode,src_name,added)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`, o.lib, o.kind, o.title, o.title.toLowerCase(), o.orig ?? null, o.year ?? null, o.tmdb ?? null, o.imdb ?? null, o.path ?? null,
  o.duration ?? null, o.parent ?? null, o.season ?? null, o.episode ?? null, o.src ?? null).lastInsertRowid);
const M = {
  arrival: item({ lib: 1, kind: 'movie', title: 'Arrival', year: 2016, tmdb: 329865, path: path.join(FILM, 'Arrival (2016).mkv'), duration: 6960 }),
  fon20: item({ lib: 1, kind: 'movie', title: 'Fönstret', year: 2020, path: path.join(FILM, 'Fönstret (2020)', 'Fönstret (2020).mkv') }),
  fon99: item({ lib: 1, kind: 'movie', title: 'Fönstret', year: 1999, path: path.join(FILM, 'Fönstret (1999).mkv'), duration: 5400 }),
  dune: item({ lib: 1, kind: 'movie', title: 'Dune', year: 2021, path: path.join(FILM, 'Dune (2021)', 'Dune (2021).mkv') }),
  amelie: item({ lib: 1, kind: 'movie', title: 'Den fantastiska Amélie från Montmartre', orig: "Le fabuleux destin d'Amélie Poulain", year: 2001, path: path.join(FILM, 'amelie.mkv') }),
  silence: item({ lib: 1, kind: 'movie', title: 'The Silence', year: 1963, imdb: 'tt0057611', path: path.join(FILM, 'silence.mkv') }),
  rocky: item({ lib: 1, kind: 'movie', title: 'Rocky 2', year: 1979, path: path.join(FILM, 'rocky2.mkv'), duration: 7000 })
};
const bron = item({ lib: 2, kind: 'show', title: 'Bron', year: 2011, tmdb: 555, src: 'Bron' });
const E = {};
for (const [s, e, f] of [[1, 1, 'Bron S01E01.mkv'], [1, 2, 'Bron S01E02.mkv'], [1, 3, 'Bron S01E03.mkv'], [1, 4, 'Bron S01E04-E05.mkv'], [0, 1, 'Bron S00E01.mkv']])
  E[`b${s}${e}`] = item({ lib: 2, kind: 'episode', title: `Bron ${s}x${e}`, parent: bron, season: s, episode: e, path: path.join(TV, 'Bron', s ? 'Season 1' : 'Specials', f), duration: 3600 });
const ord = item({ lib: 2, kind: 'show', title: 'Ordning', year: 2015, tmdb: 777, src: 'Ordning' });
E.o110 = item({ lib: 2, kind: 'episode', title: 'Tio', parent: ord, season: 1, episode: 10, path: path.join(TV, 'Ordning', 'Season 1', 'Ordning S01E10.mkv') });
E.o201 = item({ lib: 2, kind: 'episode', title: 'Annat avsnitt', parent: ord, season: 2, episode: 1, path: path.join(TV, 'Ordning', 'Season 2', 'Ordning S02E01.mkv') });
const mm = item({ lib: 2, kind: 'show', title: 'Mästarnas mästare', year: 2008, src: 'Mästarnas mästare' });
E.mm11 = item({ lib: 2, kind: 'episode', title: 'Premiär', parent: mm, season: 1, episode: 1, path: path.join(TV, 'MM', 'mm.s01e01.mkv') });
const PATHS = `/data/movies=${FILM}\n/data/tv=${TV}`;
const prog = (uid, id) => { const r = get('SELECT position, watched, updated FROM progress WHERE user_id=? AND item_id=?', uid, id); return r ? { ...r } : undefined; };
const noSecrets = (o, what) => { const s = JSON.stringify(o); for (const x of SECRETS) assert.ok(!s.includes(x), `${what} innehåller inte ${x}`); };

test('plex: titelnyckel, tider och guid', () => {
  assert.equal(imp.titleKey('Rocky II'), imp.titleKey('Rocky 2'));
  assert.equal(imp.titleKey('Tom & Jerry'), imp.titleKey('Tom and Jerry'));
  assert.equal(imp.titleKey('Søren'), imp.titleKey('Soren'));
  assert.equal(imp.titleKey('Så som i himmelen'), imp.titleKey(NFD('Så som i himmelen')));
  assert.ok(imp.titleKey('千と千尋の神隠し').length > 0, 'andra skriftsystem ger en nyckel');
  assert.equal(pdb.plexTime(1700000000), 1700000000);
  assert.equal(pdb.plexTime(1700000000123), 1700000000);
  assert.equal(pdb.plexTime('2023-11-14 22:13:20'), 1700000000);
  assert.equal(pdb.plexTime(null), null);
  assert.deepEqual(pdb.plexIds({ guid: 'plex://movie/5d77' }), {});
  assert.deepEqual(pdb.plexIds({ Guid: [{ id: 'imdb://tt1' }, { id: 'tmdb://x' }], guid: 'com.plexapp.agents.themoviedb://42?lang=sv' }), { imdb: 'tt1', tmdb: '42' });
});

let P1;
test('plex-api: ägaren, hemanvändare (PIN) och delade vänner – sidor som Plex kapar läses till slutet', async () => {
  P1 = await imp.preview({ source: 'plex', url: FB + '/plex', token: 'ownertok', pathMap: PATHS, rootId: 1 });
  noSecrets(P1, 'förhandsvisningen');
  assert.deepEqual(P1.profiles.map(p => [p.key, p.name, p.kind]), [['plex:1', 'Bertil', 'owner'], ['plex:12', 'Anna', 'home'], ['plex:13', 'Lilla', 'home'], ['plex:99', 'Kompis', 'friend']],
    'konton utan historik (Tyst) och id 0 visas inte');
  const [owner, anna, lilla, kompis] = P1.profiles;
  // Ägaren: 7 filmer (inte den osedda) och 7 avsnitt trots att Plex bara ger 3 per sida
  assert.equal(owner.total, 14);
  assert.equal(owner.matched, 14, JSON.stringify(P1.unmatchedSample));
  assert.equal(P1.total, 14, 'sammanfattningen överst gäller ägaren');
  assert.deepEqual(owner.suggest, { id: 1, name: 'bertil' }, 'samma namn som huvudkontot');
  assert.equal(anna.needPin, true); assert.equal(anna.partial, true); assert.equal(anna.pinError, false);
  assert.equal(anna.total, 1, 'utan PIN: bara sedda ur serverns historik');
  assert.deepEqual(anna.suggest, { id: 3, name: 'anna' });
  assert.equal(lilla.kid, true); assert.equal(lilla.maxAge, 7); assert.equal(lilla.partial, false); assert.equal(lilla.total, 1);
  assert.equal(lilla.suggest, null);
  assert.equal(kompis.partial, true); assert.equal(kompis.total, 2); assert.equal(kompis.matched, 1, 'en borttagen titel saknas här');
  // Fel PIN och rätt PIN
  const P2 = await imp.preview({ source: 'plex', url: FB + '/plex', token: 'ownertok', pathMap: PATHS, pins: { 'plex:12': '0000' }, rootId: 1 });
  assert.equal(P2.profiles[1].pinError, true); assert.equal(P2.profiles[1].needPin, true);
  noSecrets(P2, 'förhandsvisningen');
  const P3 = await imp.preview({ source: 'plex', url: FB + '/plex', token: 'ownertok', pathMap: PATHS, pins: { 'plex:12': '1234' }, rootId: 1 });
  assert.equal(P3.profiles[1].needPin, false); assert.equal(P3.profiles[1].partial, false);
  assert.equal(P3.profiles[1].total, 2); assert.equal(P3.profiles[1].inProgress, 1);
  noSecrets(P3, 'förhandsvisningen');
  P1 = P3;
});

test('plex-api: matchningen – flera versioner, NFD, samma titel olika år, originaltitel, specials, dubbelavsnitt, TVDB/TMDB-ordning', async () => {
  // Nyare här: Rocky påbörjad efter tiden i Plex, avsnitt 2 längre fram – skrivs inte över utan val
  const t = Math.floor(Date.now() / 1000);
  run('INSERT INTO progress(user_id,item_id,position,watched,updated) VALUES(1,?,500,0,?)', M.rocky, t - 10);
  run('INSERT INTO progress(user_id,item_id,position,watched,updated) VALUES(1,?,2000,0,?)', E.b12, t - 10);
  const r = await imp.runProfiles(P1.id, [
    { key: 'plex:1', action: 'link', userId: 1 }, { key: 'plex:12', action: 'create' }, { key: 'plex:13', action: 'create' }, { key: 'plex:99', action: 'skip' }
  ], { rootId: 1 });
  noSecrets(r, 'importsvaret');
  assert.deepEqual(r.profiles.map(p => [p.key, p.action, p.userName]), [['plex:1', 'link', 'bertil'], ['plex:12', 'create', 'Anna (Plex)'], ['plex:13', 'create', 'Lilla'], ['plex:99', 'skip', null]]);
  // Ägaren
  assert.deepEqual(prog(1, M.arrival), { position: 0, watched: 1, updated: T0 }, 'lastViewedAt bevaras');
  assert.equal(prog(1, M.fon20)?.watched, 1, 'NFD-sökväg från Plex = NFC här');
  assert.deepEqual(prog(1, M.fon99), { position: 1200, watched: 0, updated: T0 + 2 }, 'viewCount 0 med viewOffset: påbörjad, rätt årtal');
  assert.equal(prog(1, M.dune)?.watched, 1, 'version nummer två i Plex är filen här');
  assert.equal(prog(1, M.amelie)?.watched, 1, 'originaltiteln');
  assert.equal(prog(1, M.silence)?.watched, 1, 'IMDb-id utan TMDB-nyckel');
  assert.deepEqual(prog(1, M.rocky), { position: 500, watched: 0, updated: t - 10 }, 'påbörjad här efter Plex – inte överskriven');
  assert.equal(prog(1, E.b11)?.watched, 1);
  assert.equal(prog(1, E.b12).position, 2000, 'nyare position här behålls');
  assert.equal(prog(1, E.b01)?.watched, 1, 'special S00');
  assert.equal(prog(1, E.b14)?.watched, 1, 'dubbelavsnitt: sedd del + påbörjad del = sedd');
  assert.equal(prog(1, E.o110)?.watched, 1, 'filens numrering (TVDB) går före Plex (TMDB)');
  assert.equal(prog(1, E.o201), undefined, 'fel avsnitt markeras inte');
  assert.equal(prog(1, E.mm11)?.watched, 1, 'seriemappen tolkad som skannern gör, trots engelsk titel i Plex');
  // Nya profiler under huvudkontot
  const annaU = get("SELECT * FROM users WHERE name='Anna (Plex)'"), lillaU = get("SELECT * FROM users WHERE name='Lilla'");
  assert.equal(annaU.parent_id, 1); assert.equal(annaU.max_age, null);
  assert.equal(lillaU.parent_id, 1); assert.equal(lillaU.max_age, 7, 'begränsad Plex-profil blir barnprofil');
  assert.deepEqual(prog(annaU.id, M.arrival), { position: 1800, watched: 0, updated: T0 + 2000 });
  assert.equal(prog(annaU.id, E.b13)?.watched, 1);
  assert.equal(prog(lillaU.id, M.fon20)?.watched, 1);
  // Kopplingarna sparas (även "hoppa över"); token sparas bara med löpande synk
  const L = Object.fromEntries(all("SELECT ext_key, user_id, secret FROM import_links WHERE source='plex'").map(x => [x.ext_key, x]));
  assert.equal(L['plex:1'].user_id, 1); assert.equal(L['plex:12'].user_id, annaU.id); assert.equal(L['plex:99'].user_id, null);
  assert.ok(Object.values(L).every(x => x.secret == null));
  // Ny förhandsvisning föreslår de sparade kopplingarna; "skriv över" ändrar nyare positioner här
  const P = await imp.preview({ source: 'plex', url: FB + '/plex', token: 'ownertok', pathMap: PATHS, rootId: 1 });
  assert.deepEqual(P.profiles.map(p => p.link), [{ id: 1, name: 'bertil' }, { id: annaU.id, name: 'Anna (Plex)' }, { id: lillaU.id, name: 'Lilla' }, { skip: true }]);
  await imp.runProfiles(P.id, [{ key: 'plex:1', action: 'link', userId: 1 }], { rootId: 1, overwrite: true });
  assert.equal(prog(1, M.rocky).watched, 1, 'med "skriv över"');
  assert.equal(prog(1, E.b12).position, 900);
  await assert.rejects(imp.runProfiles(P.id, [{ key: 'plex:1', action: 'link', userId: 1 }], { rootId: 1 }), /gått ut/);
  const Q = await imp.preview({ source: 'plex', url: FB + '/plex', token: 'ownertok', pathMap: PATHS, rootId: 1 });
  await assert.rejects(imp.runProfiles(Q.id, [{ key: 'plex:1', action: 'link', userId: 999 }], { rootId: 1 }), /befintlig profil/);
  await assert.rejects(imp.runProfiles(Q.id, [{ key: 'plex:1', action: 'skip' }], { rootId: 1 }), /minst en profil/);
});

test('plex-api: löpande synk – sparad token, bara nya ändringar, envägs, av som standard', async () => {
  assert.equal(imp.syncInfo().on, false, 'av som standard');
  assert.throws(() => imp.updateSync({ on: true }), /löpande synk ikryssad/);
  const P = await imp.preview({ source: 'plex', url: FB + '/plex', token: 'ownertok', pathMap: PATHS, pins: { 'plex:12': '1234' }, rootId: 1 });
  const annaId = get("SELECT id FROM users WHERE name='Anna (Plex)'").id;
  await imp.runProfiles(P.id, P.profiles.map(p => p.link?.id ? { key: p.key, action: 'link', userId: p.link.id } : { key: p.key, action: 'skip' }), { rootId: 1, sync: { on: true, hours: 6 } });
  const S = imp.syncInfo();
  assert.equal(S.on, true); assert.equal(S.hours, 6); assert.equal(S.mode, 'api'); assert.equal(S.tokenSet, true);
  noSecrets(S, 'synkinställningen');
  assert.equal(get("SELECT secret FROM import_links WHERE ext_key='plex:12'").secret, 'anna-srv', 'hemanvändarens servertoken sparas för synken');
  // Ändringar i Plex efter importen; här har ägaren tagit bort Arrival ur sin historik
  state['anna-srv'][101] = { viewCount: 1, lastViewedAt: Math.floor(Date.now() / 1000) - 60 };
  run('DELETE FROM progress WHERE user_id=1 AND item_id=?', M.arrival);
  const sw = calls.switch;
  const r = await imp.syncNow();
  assert.equal(r.profiles, 3); assert.equal(r.watched, 1);
  assert.equal(calls.switch, sw, 'den sparade token används – ingen ny växling (PIN behövs inte)');
  assert.equal(prog(annaId, E.b11)?.watched, 1, 'nytt i Plex');
  assert.equal(prog(1, M.arrival), undefined, 'gammal historik förs inte in igen');
  assert.equal(await imp.syncTick(), null, 'inte dags än');
  const later = await imp.syncTick(Math.floor(Date.now() / 1000) + 7 * 3600);
  assert.equal(later.watched, 0, 'inget nytt');
  noSecrets(imp.syncInfo(), 'synkinställningen');
  imp.updateSync({ on: false });
  assert.equal(getSetting('import_sync_token', ''), '', 'token tas bort när synken stängs av');
  assert.equal(get("SELECT count(*) n FROM import_links WHERE secret IS NOT NULL").n, 0);
});

// ---------- Plex databasfil ----------
function makePlexDb(file, variant) {
  const db = new DatabaseSync(file);
  const modern = variant === 'modern';
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE accounts(id INTEGER PRIMARY KEY, name TEXT, hashed_password TEXT, salt TEXT, created_at INTEGER);
    CREATE TABLE library_sections(id INTEGER PRIMARY KEY, name TEXT, section_type INTEGER);
    CREATE TABLE metadata_items(id INTEGER PRIMARY KEY, library_section_id INTEGER, parent_id INTEGER, metadata_type INTEGER, guid TEXT, title TEXT,
      ${modern ? 'original_title TEXT, duration INTEGER,' : ''} year INTEGER, "index" INTEGER, originally_available_at ${modern ? 'INTEGER' : 'TEXT'});
    CREATE TABLE media_items(id INTEGER PRIMARY KEY, metadata_item_id INTEGER, duration INTEGER);
    CREATE TABLE media_parts(id INTEGER PRIMARY KEY, media_item_id INTEGER, file TEXT, size INTEGER);
    CREATE TABLE metadata_item_settings(id INTEGER PRIMARY KEY, account_id INTEGER, guid TEXT, rating REAL, view_offset INTEGER, view_count INTEGER,
      last_viewed_at ${modern ? 'INTEGER' : 'TEXT'}, created_at INTEGER, updated_at INTEGER);
    ${modern ? `CREATE TABLE tags(id INTEGER PRIMARY KEY, tag TEXT, tag_type INTEGER);
    CREATE TABLE taggings(id INTEGER PRIMARY KEY, metadata_item_id INTEGER, tag_id INTEGER);
    CREATE TABLE metadata_item_views(id INTEGER PRIMARY KEY, account_id INTEGER, guid TEXT, metadata_type INTEGER, library_section_id INTEGER,
      grandparent_title TEXT, parent_index INTEGER, "index" INTEGER, title TEXT, viewed_at INTEGER, grandparent_guid TEXT, originally_available_at INTEGER);` : ''}`);
  db.exec("INSERT INTO accounts(id,name) VALUES(1,'bertil'),(12,'Anna'),(13,'Lilla'),(14,'Ingen historik')");
  const mi = (id, type, guid, title, extra = {}) => db.prepare(`INSERT INTO metadata_items(id,metadata_type,guid,title,year,"index",parent_id${modern ? ',original_title' : ''}) VALUES(?,?,?,?,?,?,?${modern ? ',?' : ''})`)
    .run(id, type, guid, title, extra.year ?? null, extra.index ?? null, extra.parent ?? null, ...(modern ? [extra.orig ?? null] : []));
  const addFile = (id, f) => { db.prepare('INSERT INTO media_items(id,metadata_item_id) VALUES(?,?)').run(id, id); db.prepare('INSERT INTO media_parts(media_item_id,file) VALUES(?,?)').run(id, f); };
  const ts = (n) => modern ? n : new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const set = (acc, guid, vc, vo, lv) => db.prepare('INSERT INTO metadata_item_settings(account_id,guid,view_count,view_offset,last_viewed_at) VALUES(?,?,?,?,?)').run(acc, guid, vc, vo, ts(lv));
  if (modern) {
    mi(1, 1, 'plex://movie/arr', 'Arrival', { year: 2016 });
    db.exec("INSERT INTO tags(id,tag,tag_type) VALUES(1,'tmdb://329865',314),(2,'imdb://tt2543164',314),(3,'tmdb://555',314),(4,'Drama',1)");
    db.exec('INSERT INTO taggings(metadata_item_id,tag_id) VALUES(1,1),(1,2),(1,4),(10,3)');
    mi(10, 2, 'plex://show/bron', 'Bron', { year: 2011 });
  } else {
    mi(1, 1, 'com.plexapp.agents.themoviedb://329865?lang=en', 'Arrival', { year: 2016 });
    mi(10, 2, 'com.plexapp.agents.themoviedb://555?lang=en', 'Bron', { year: 2011 });
  }
  mi(2, 1, 'com.plexapp.agents.imdb://tt9999999?lang=sv', 'Fönstret', { year: 2020 });
  mi(11, 3, 'plex://season/b1', 'Säsong 1', { index: 1, parent: 10 });
  mi(12, 4, modern ? 'plex://episode/b11' : 'com.plexapp.agents.thetvdb://252019/1/1?lang=en', 'Ett', { index: 1, parent: 11 });
  mi(13, 4, 'plex://episode/b12', 'Två', { index: 2, parent: 11 });
  addFile(12, '/data/tv/Bron/Season 1/Bron S01E01.mkv');
  const g = (id) => db.prepare('SELECT guid FROM metadata_items WHERE id=?').get(id).guid;
  set(1, g(1), 1, 0, T0);
  set(1, g(12), 1, 0, T0 + 1);
  set(12, g(13), 0, 900000, T0 + 2);
  set(12, g(2), 0, 0, T0 + 3); // markerad som osedd i Plex – ingenting
  set(13, g(2), 1, 0, T0 + 4);
  if (modern) {
    // Uppspelningar: senare tid för en titel med inställningsrad (raden gäller) och ett avsnitt som tagits bort ur Plex
    db.prepare('INSERT INTO metadata_item_views(account_id,guid,metadata_type,title,viewed_at) VALUES(1,?,1,?,?)').run(g(1), 'Arrival', T0 + 900);
    db.prepare(`INSERT INTO metadata_item_views(account_id,guid,metadata_type,grandparent_title,parent_index,"index",title,viewed_at,grandparent_guid)
      VALUES(12,'plex://episode/gone',4,'Bron',1,3,'Tre',?, 'plex://show/bron')`).run(T0 + 5);
  }
  return db; // öppen: ändringarna ligger kvar i -wal
}

test('plex-db: två schemavarianter, flera konton, -wal och borttagna titlar', async () => {
  const dir = path.join(ROOT, 'plexdb', 'Plug-in Support', 'Databases');
  fs.mkdirSync(dir, { recursive: true });
  const live = makePlexDb(path.join(dir, pdb.PLEX_DB), 'modern');
  assert.ok(fs.statSync(path.join(dir, pdb.PLEX_DB + '-wal')).size > 0, 'testet har data i -wal');
  const A = await pdb.readPlexDb(path.join(ROOT, 'plexdb')); // Plex-mappen räcker
  assert.deepEqual(A.profiles.map(p => [p.key, p.name, p.kind, p.records.length]), [['plex:1', 'bertil', 'owner', 2], ['plex:12', 'Anna', 'user', 2], ['plex:13', 'Lilla', 'user', 1]]);
  const arr = A.profiles[0].records.find(r => r.title === 'Arrival');
  assert.equal(arr.ids.tmdb, '329865'); assert.equal(arr.updated, T0, 'tiden från inställningsraden gäller');
  const ep1 = A.profiles[0].records.find(r => r.kind === 'episode');
  assert.deepEqual([ep1.show.title, ep1.show.ids.tmdb, ep1.season, ep1.episode, ep1.path], ['Bron', '555', 1, 1, '/data/tv/Bron/Season 1/Bron S01E01.mkv']);
  const gone = A.profiles[1].records.find(r => r.episode === 3);
  assert.deepEqual([gone.show.title, gone.season, gone.watched], ['Bron', 1, true], 'borttagen ur Plex: från uppspelningshistoriken');
  live.close();
  // Förhandsvisning och import från filen
  const P = await imp.preview({ source: 'plex', mode: 'db', dbPath: path.join(dir, pdb.PLEX_DB), pathMap: PATHS, rootId: 1 });
  noSecrets(P, 'förhandsvisningen');
  assert.equal(P.mode, 'db');
  assert.deepEqual(P.profiles.map(p => [p.matched, p.total]), [[2, 2], [2, 2], [1, 1]]);
  assert.equal(P.profiles[1].link.name, 'Anna (Plex)', 'samma nyckel som via Plex-API:t (plex:<konto-id>)');
  const nyU = Number(run("INSERT INTO users(name,pass,is_admin,created,parent_id) VALUES('Ny','x',0,0,1)").lastInsertRowid);
  run('DELETE FROM progress WHERE user_id=?', nyU);
  await imp.runProfiles(P.id, [{ key: 'plex:12', action: 'link', userId: nyU }], { rootId: 1 });
  assert.deepEqual(prog(nyU, E.b12), { position: 900, watched: 0, updated: T0 + 2 });
  assert.equal(prog(nyU, E.b13)?.watched, 1);
  assert.equal(prog(nyU, M.fon20), undefined, 'osedd i Plex');

  // Äldre schema: utan taggar, uppspelningar, originaltitel och längd; tider som text
  const old = path.join(ROOT, 'old.db');
  makePlexDb(old, 'old').close();
  const B = await pdb.readPlexDb(old);
  assert.deepEqual(B.profiles.map(p => [p.key, p.records.length]), [['plex:1', 2], ['plex:12', 1], ['plex:13', 1]]);
  assert.equal(B.profiles[0].records.find(r => r.kind === 'movie').updated, T0);
  assert.equal(B.profiles[0].records.find(r => r.kind === 'movie').ids.tmdb, '329865');
  const Pb = await imp.preview({ source: 'plex', mode: 'db', dbPath: old, pathMap: PATHS, rootId: 1 });
  assert.deepEqual(Pb.profiles.map(p => p.matched), [2, 1, 1]);

  // Fel: relativ sökväg, saknas, inte SQLite, SQLite men inte Plex
  await assert.rejects(pdb.readPlexDb('plex.db'), /hela sökvägen/);
  await assert.rejects(pdb.readPlexDb(path.join(ROOT, 'finns-inte.db')), /Hittar inte/);
  fs.writeFileSync(path.join(ROOT, 'text.db'), 'hemligt innehåll');
  await assert.rejects(pdb.readPlexDb(path.join(ROOT, 'text.db')), (e) => /ingen SQLite/.test(e.message) && !e.message.includes('hemligt'));
  const other = new DatabaseSync(path.join(ROOT, 'other.db')); other.exec('CREATE TABLE x(a)'); other.close();
  await assert.rejects(pdb.readPlexDb(path.join(ROOT, 'other.db')), /inte Plex/);
  assert.equal(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('bxtv-plexdb-')).length, 0, 'den tillfälliga kopian tas bort');
});

// ---------- HTTP: bara admin på betrott nät, inga hemligheter i svar eller loggar ----------
const B = `http://127.0.0.1:${PORT}`;
test('http: importen kräver admin på hemnätet; token och PIN syns aldrig i svar eller logg', async () => {
  const cfg = path.join(ROOT, 'srv');
  let out = '';
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(PORT + 1), CONFIG_DIR: cfg, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(cfg, 'tc'),
      DVR_DIR: path.join(cfg, 'rec'), PODCAST_DIR: path.join(cfg, 'pod'), DLNA_SSDP: '0', PLEX_TV_URL: FB + '/plextv' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
    const jar = {};
    const req = async (p, { method = 'GET', body, headers = {}, as = 'admin' } = {}) => {
      const r = await fetch(B + p, { method, headers: { ...headers, ...(jar[as] ? { cookie: jar[as] } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc)) jar[as] = sc.split(';')[0];
      const text = await r.text();
      return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
    };
    assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: 'Testlösen-2026!' } })).status, 200);
    const U = await req('/api/users', { method: 'POST', body: { name: 'vanlig', password: 'Grön-Ödla-2026!' } }); assert.equal(U.status, 200, U.text);
    assert.equal((await req('/api/login', { method: 'POST', body: { name: 'vanlig', password: 'Grön-Ödla-2026!' }, as: 'user' })).status, 200);
    const ext = { 'x-forwarded-for': '81.2.3.4' };
    const body = { source: 'plex', url: FB + '/plex', token: 'ownertok', pins: { 'plex:12': '1234' } };
    for (const [m, p, b] of [['POST', '/api/import/preview', body], ['POST', '/api/import/run', { id: 'x', profiles: [] }], ['GET', '/api/import/sync'], ['PUT', '/api/import/sync', { on: true }], ['POST', '/api/import/sync/run']]) {
      assert.equal((await req(p, { method: m, body: b, as: 'user' })).status, 403, `${p} kräver admin`);
      assert.equal((await req(p, { method: m, body: b, headers: ext })).status, 403, `${p} nekas utifrån`);
    }
    const P = await req('/api/import/preview', { method: 'POST', body });
    assert.equal(P.status, 200, P.text);
    assert.equal(P.json.profiles.length, 4);
    for (const x of SECRETS) assert.ok(!P.text.includes(x), `svaret innehåller inte ${x}`);
    const R = await req('/api/import/run', { method: 'POST', body: { id: P.json.id, profiles: [{ key: 'plex:13', action: 'create' }, { key: 'plex:1', action: 'link', userId: 1 }], sync: { on: true, hours: 12 } } });
    assert.equal(R.status, 200, R.text);
    assert.equal(R.json.created[0].name, 'Lilla');
    const S = await req('/api/import/sync');
    assert.equal(S.json.on, true); assert.equal(S.json.tokenSet, true);
    const SR = await req('/api/import/sync/run', { method: 'POST' });
    assert.equal(SR.status, 200, SR.text);
    for (const t of [R.text, S.text, SR.text]) for (const x of SECRETS) assert.ok(!t.includes(x), `svaret innehåller inte ${x}`);
    const L = await req('/api/logs?limit=400');
    assert.equal(L.status, 200);
    for (const x of SECRETS) { assert.ok(!L.text.includes(x), `serverloggen innehåller inte ${x}`); assert.ok(!out.includes(x), `konsolen innehåller inte ${x}`); }
    assert.equal((await req('/api/import/sync', { method: 'PUT', body: { on: false } })).json.tokenSet, false);
  } finally { srv.kill(); }
});
