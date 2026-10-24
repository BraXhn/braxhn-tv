// Smarta spellistor med egna regler: varje operator, injektionsförsök (fält, operator, värden, sortering),
// gränser, delning mellan användare och barnprofiler (musik har ingen åldersgräns – delade listor syns för alla).
// Regelmotorn testas direkt mot databasen; API:t mot en riktig server (kräver ffmpeg för musikfilerna).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-smartl-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const { run, get } = await import('../server/db.js');
const S = await import('../server/smartlists.js');
const L = await import('../server/listening.js');
let srv;
after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

// ---------- testdata ----------
const t0 = 1_800_000_000, DAY = 86400;
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0),(2,'bo','x',0,0)");
run("INSERT INTO libraries(id,name,type,path) VALUES(30,'M1','music','/finns/inte'),(31,'M2','music','/finns/inte2')");
run("INSERT INTO artists(id,library_id,name,sort_name) VALUES(30,30,'ABBA','abba'),(31,30,'Kent','kent'),(32,30,'Various','various'),(33,31,'Robyn','robyn')");
run(`INSERT INTO albums(id,library_id,artist_id,title,sort_title,year,genre,added) VALUES(30,30,30,'Gold','gold',1992,'Pop',0),
  (31,30,31,'Isola','isola',1997,'Rock',0),(32,30,32,'Mix','mix',2005,NULL,0),(33,31,33,'Body Talk','body talk',2010,'Pop',0)`);
const ins = (id, lib, al, ar, title, dur, codec, br, ago) =>
  run('INSERT INTO tracks(id,library_id,album_id,artist_id,title,track_no,disc_no,duration,path,codec,bitrate,added) VALUES(?,?,?,?,?,1,1,?,?,?,?,?)', id, lib, al, ar, title, dur, `/x/${id}.mp3`, codec, br, t0 - ago * DAY);
ins(301, 30, 30, 30, 'Dancing Queen', 230, 'mp3', 320000, 400);
ins(302, 30, 30, 30, 'Waterloo', 165, 'flac', 900000, 10);
ins(303, 30, 31, 31, '747', 300, 'mp3', 192000, 100);
ins(304, 30, 32, 31, '100% ren', 120, 'mp3', 128000, 2);
ins(305, 30, 32, 31, 'a_b', 200, 'opus', 96000, 1);
ins(306, 31, 33, 33, 'Dancing On My Own', 280, 'flac', 1000000, 5);
const play = (uid, tid, ago) => run('INSERT INTO track_plays(user_id,track_id,ts) VALUES(?,?,?)', uid, tid, t0 - ago * DAY);
play(1, 301, 1); play(1, 301, 2); play(1, 301, 3); play(1, 302, 50); play(1, 303, 200); play(2, 306, 1); play(2, 306, 2);
run('INSERT INTO favorites(user_id,track_id) VALUES(1,302),(1,306),(2,301)');
const ALL = [301, 302, 303, 304, 305, 306];
const iso = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** Spår-id för en definition (sorterade om ordningen inte är det som testas) */
const ids = (d, { uid = 1, sorted = true } = {}) => { const r = S.evaluate(S.normalize(d), uid, { at: t0 }).map(t => t.id); return sorted ? r.sort((a, b) => a - b) : r; };
const one = (field, op, value, uid) => ids({ rules: [{ field, op, value }] }, { uid });
const not = (list) => ALL.filter(x => !list.includes(x));

test('textoperatorer: är, är inte, innehåller, innehåller inte, börjar med', () => {
  assert.deepEqual(one('title', 'is', 'waterloo'), [302]); // skiftlägesokänsligt
  assert.deepEqual(one('title', 'isNot', 'Waterloo'), not([302]));
  assert.deepEqual(one('title', 'contains', 'dancing'), [301, 306]);
  assert.deepEqual(one('title', 'notContains', 'dancing'), [302, 303, 304, 305]);
  assert.deepEqual(one('title', 'startsWith', '7'), [303]);
  assert.deepEqual(one('genre', 'is', 'pop'), [301, 302, 306]);
  assert.deepEqual(one('genre', 'isNot', 'Pop'), [303, 304, 305]); // saknad genre räknas som "inte Pop"
  assert.deepEqual(one('genre', 'notContains', 'o'), [304, 305]);
  assert.deepEqual(one('artist', 'is', 'Kent'), [303, 304, 305]);
  assert.deepEqual(one('album', 'startsWith', 'bo'), [306]);
  assert.deepEqual(one('albumartist', 'is', 'Various'), [304, 305]);
  assert.deepEqual(one('format', 'is', 'FLAC'), [302, 306]);
});

test('LIKE-tecken i värden är vanliga tecken (% och _ matchar bara sig själva)', () => {
  assert.deepEqual(one('title', 'contains', '%'), [304]);
  assert.deepEqual(one('title', 'contains', '_'), [305]);
  assert.deepEqual(one('title', 'startsWith', '1%'), []);
  assert.deepEqual(one('title', 'contains', '\\'), []);
});

test('taloperatorer: är, är inte, större/mindre än, mellan', () => {
  assert.deepEqual(one('year', 'is', 1997), [303]);
  assert.deepEqual(one('year', 'isNot', 1997), not([303]));
  assert.deepEqual(one('year', 'gt', 2000), [304, 305, 306]);
  assert.deepEqual(one('year', 'lt', '1995'), [301, 302]); // tal som text godtas
  assert.deepEqual(one('year', 'between', [2010, 1997]), [303, 304, 305, 306]); // ordningen spelar ingen roll
  assert.deepEqual(one('duration', 'between', [150, 240]), [301, 302, 305]);
  assert.deepEqual(one('bitrate', 'gt', 500), [302, 306]); // kbit/s
  assert.deepEqual(one('bitrate', 'lt', 150), [304, 305]);
});

test('spelningar och favoriter räknas per användare', () => {
  assert.deepEqual(one('plays', 'gt', 0), [301, 302, 303]);
  assert.deepEqual(one('plays', 'is', 3), [301]);
  assert.deepEqual(one('plays', 'is', 0), [304, 305, 306]);
  assert.deepEqual(one('plays', 'gt', 0, 2), [306]);
  assert.deepEqual(one('favorite', 'is', true), [302, 306]);
  assert.deepEqual(one('favorite', 'is', false), not([302, 306]));
  assert.deepEqual(one('favorite', 'is', true, 2), [301]);
});

test('datumoperatorer: inom/inte inom senaste N dagar, efter, före, mellan', () => {
  assert.deepEqual(one('lastplayed', 'inLast', 7), [301]);
  assert.deepEqual(one('lastplayed', 'notInLast', 30), [302, 303, 304, 305, 306]); // aldrig spelade ingår
  assert.deepEqual(one('added', 'inLast', 3), [304, 305]);
  assert.deepEqual(one('added', 'notInLast', 50), [301, 303]);
  assert.deepEqual(one('added', 'after', iso(t0 - 11 * DAY)), [302, 304, 305, 306]);
  assert.deepEqual(one('added', 'before', iso(t0 - 100 * DAY)), [301]);
  assert.deepEqual(one('added', 'between', [iso(t0 - 10 * DAY), iso(t0 - 100 * DAY)]), [302, 303]);
  assert.deepEqual(one('lastplayed', 'after', iso(t0 - 60 * DAY)), [301, 302]);
});

test('bibliotek, grupper med alla/någon och en nivå av nästling', () => {
  assert.deepEqual(one('library', 'is', 31), [306]);
  assert.deepEqual(one('library', 'isNot', 31), not([306]));
  assert.deepEqual(ids({ match: 'any', rules: [{ field: 'title', op: 'is', value: 'Waterloo' },
    { match: 'all', rules: [{ field: 'artist', op: 'is', value: 'Kent' }, { field: 'duration', op: 'lt', value: 150 }] }] }), [302, 304]);
  assert.deepEqual(ids({ match: 'all', rules: [{ field: 'genre', op: 'is', value: 'Pop' },
    { match: 'any', rules: [{ field: 'favorite', op: 'is', value: true }, { field: 'plays', op: 'gt', value: 2 }] }] }), [301, 302, 306]);
  assert.deepEqual(ids({ rules: [] }), ALL); // inga regler = alla låtar
  assert.deepEqual(ids({ rules: [{ match: 'all', rules: [] }] }), ALL); // tom grupp påverkar inte
});

test('sortering, slumpad ordning och gränser i antal och minuter', () => {
  assert.deepEqual(ids({ sort: 'duration', order: 'asc' }, { sorted: false }), [304, 302, 305, 301, 306, 303]);
  assert.deepEqual(ids({ sort: 'plays', order: 'desc', limit: 2 }, { sorted: false }), [301, 302]);
  assert.deepEqual(ids({ sort: 'title', order: 'asc', limit: 3 }, { sorted: false }), [304, 303, 305]);
  // 5 minuter: 120 + 165 s ryms, nästa (200 s) skulle gå över
  assert.deepEqual(ids({ sort: 'duration', order: 'asc', limitMinutes: 5 }, { sorted: false }), [304, 302]);
  // Slumpad: samma frö ger samma ordning, alla spår kommer med
  const r1 = S.evaluate(S.normalize({ sort: 'random' }), 1, { at: t0, seed: 7 }).map(t => t.id);
  const r2 = S.evaluate(S.normalize({ sort: 'random' }), 1, { at: t0, seed: 7 }).map(t => t.id);
  assert.deepEqual(r1, r2);
  assert.deepEqual([...r1].sort(), ALL);
  assert.equal(S.countMatches(S.normalize({ sort: 'random', limit: 2 }), 1, t0), 6); // antal träffar utan gräns
  for (const bad of [{ limit: -1 }, { limit: 5001 }, { limit: 1.5 }, { limitMinutes: 'x' }, { limit: 10, limitMinutes: 10 }])
    assert.throws(() => S.normalize(bad), /gräns|Gräns/i, JSON.stringify(bad));
  assert.equal(S.normalize({ limit: 0 }).limit, null); // 0 = ingen gräns
});

test('injektionsförsök: fält, operatorer, sortering och värden kommer aldrig in i SQL-texten', () => {
  const rejects = [
    { rules: [{ field: 'title; DROP TABLE tracks', op: 'is', value: 'x' }] },
    { rules: [{ field: 't.title', op: 'is', value: 'x' }] },
    { rules: [{ field: '__proto__', op: 'is', value: 'x' }] },
    { rules: [{ field: 'constructor', op: 'is', value: 'x' }] },
    { rules: [{ field: 'toString', op: 'is', value: 'x' }] },
    { rules: [{ field: ['title'], op: 'is', value: 'x' }] },
    { rules: [{ field: 'title', op: "= '' OR 1=1 --", value: 'x' }] },
    { rules: [{ field: 'title', op: 'gt', value: 'x' }] }, // operatorn passar inte fältet
    { rules: [{ field: 'title', op: 'is', value: { sql: '1=1' } }] },
    { rules: [{ field: 'year', op: 'is', value: '1 OR 1=1' }] },
    { rules: [{ field: 'year', op: 'between', value: ['1', '2); DROP TABLE tracks; --'] }] },
    { rules: [{ field: 'added', op: 'after', value: "2020-01-01' OR 1=1" }] },
    { rules: [{ field: 'added', op: 'inLast', value: '7 OR 1=1' }] },
    { rules: [{ field: 'library', op: 'is', value: '30 OR 1=1' }] },
    { rules: [{ field: 'favorite', op: 'is', value: 'true' }] },
    { sort: 't.title; DROP TABLE tracks' },
    { sort: '__proto__' },
    { match: 'all', rules: [{ match: 'any', rules: [{ match: 'all', rules: [] }] }] }, // två nivåer
    { rules: 'title' },
    { rules: Array.from({ length: 31 }, () => ({ field: 'title', op: 'is', value: 'x' })) }
  ];
  for (const d of rejects) assert.throws(() => S.normalize(d), (e) => e.status === 400 && typeof e.message === 'string', JSON.stringify(d).slice(0, 80));
  // Värden med SQL blir bara parametrar
  const evil = "x' OR '1'='1'; DROP TABLE tracks; --";
  const d = S.normalize({ rules: [{ field: 'title', op: 'is', value: evil }, { field: 'genre', op: 'contains', value: evil }], match: 'any', order: 'asc; DROP TABLE tracks' });
  assert.equal(d.order, 'desc');
  const q = S.compile(d, 1);
  assert.ok(!q.sql.includes(evil) && !q.sql.includes('DROP'));
  assert.ok(q.params.includes(evil));
  assert.deepEqual(ids(d), []);
  assert.equal(get('SELECT COUNT(*) AS n FROM tracks').n, 6);
  // Okända nycklar tas bort ur den sparade definitionen
  assert.deepEqual(Object.keys(S.normalize({ sql: 'DROP', rules: [{ field: 'title', op: 'is', value: 'a', extra: 'DROP' }] }).rules[0]), ['field', 'op', 'value']);
});

test('lagring per användare, delning och kort cache', () => {
  const id = S.create(1, { name: '  Mina  favoriter ', rules: [{ field: 'favorite', op: 'is', value: true }], sort: 'title', order: 'asc' });
  assert.equal(S.getFor(id, 1).name, 'Mina favoriter');
  assert.equal(S.getFor(id, 2), null); // privat
  assert.equal(S.update(id, 2, { name: 'Kapad' }), false); // bara ägaren ändrar
  assert.equal(S.remove(id, 2), false);
  assert.deepEqual(L.smartTracks(30, 1, `u${id}`).map(t => t.id), [306, 302]);
  assert.equal(L.smartTracks(30, 2, `u${id}`), null);
  assert.equal(L.smartTracks(30, 1, 'u0'), null);
  assert.equal(L.smartName(`u${id}`, 1), 'Mina favoriter');
  // Delad: den andra ser listan med sina egna favoriter
  assert.equal(S.update(id, 1, { shared: true }), true);
  L.clearSmartCache();
  const seen = S.listFor(2).find(l => l.id === id);
  assert.equal(seen.mine, false); assert.equal(seen.owner, 'anna'); assert.equal(seen.shared, true);
  assert.deepEqual(L.smartTracks(30, 2, `u${id}`).map(t => t.id), [301]);
  // Översikten (musikhemmet, apparna): samma fält som de fasta listorna + tillägg
  const home = L.smartLists(30, 2).find(s => s.id === `u${id}`);
  assert.equal(home.name, 'Mina favoriter'); assert.equal(home.count, 1); assert.equal(typeof home.id, 'string');
  assert.equal(home.custom, true); assert.equal(home.mine, false); assert.equal(home.owner, 'anna');
  // Cachen: samma version av listan återanvänds, en ändring räknas om direkt
  assert.deepEqual(L.smartTracks(30, 1, `u${id}`).map(t => t.id), [306, 302]);
  run('INSERT INTO favorites(user_id,track_id) VALUES(1,301)');
  assert.deepEqual(L.smartTracks(30, 1, `u${id}`).map(t => t.id), [306, 302]);
  S.update(id, 1, { name: 'Favoriter' });
  assert.deepEqual(L.smartTracks(30, 1, `u${id}`).map(t => t.id), [306, 301, 302]);
  run('DELETE FROM favorites WHERE user_id=1 AND track_id=301');
  // Ogiltiga ändringar sparas inte
  assert.throws(() => S.update(id, 1, { rules: [{ field: 'x', op: 'is', value: 1 }] }), /Okänt fält/);
  assert.throws(() => S.create(1, { name: '', rules: [] }), /Namn/);
  assert.equal(S.remove(id, 1), true);
  assert.equal(S.getFor(id, 2), null);
});

test('högst 100 egna listor per användare', () => {
  for (let i = 0; i < S.MAX_LISTS; i++) S.create(2, { name: 'L' + i, rules: [] });
  assert.throws(() => S.create(2, { name: 'en till', rules: [] }), /För många/);
  run('DELETE FROM smart_playlists WHERE user_id=2');
});

// ---------- API mot en riktig server ----------
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
const A = {};
t('API: skapa, förhandsvisa, öppna, dela, barnprofil och ta bort', async () => {
  const MEDIA = path.join(ROOT, 'media'), dir = path.join(MEDIA, 'Musik', 'Artisten', 'Skivan');
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, genre] of [[1, 'Pop'], [2, 'Rock']])
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${300 * n}:duration=2`, '-metadata', `title=Låt ${n}`, '-metadata', 'artist=Artisten',
      '-metadata', `album=Skiva ${n}`, '-metadata', `genre=${genre}`, '-metadata', `track=${n}`, path.join(dir, `0${n} Låt ${n}.mp3`)]);
  fs.mkdirSync(path.join(ROOT, 'srv'), { recursive: true });
  srv = await startServer({ root: path.join(ROOT, 'srv'), media: MEDIA, env: { TMDB_API_KEY: '', MUSIC_LOUDNESS: '0' } });
  const req = (p, o = {}, tok = A.admin) => srv.req(p, { ...o, headers: tok ? { authorization: 'Bearer ' + tok } : {}, auth: false });
  assert.equal((await srv.req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } })).status, 200);
  A.admin = (await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, auth: false })).data.token;
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Musik', type: 'music', path: path.join(MEDIA, 'Musik') } })).status, 200);
  for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 300)); const s = (await req('/api/scan')).data; if (!s.running && s.last) break; }
  const lib = (await req('/api/libraries')).data.find(l => l.type === 'music').id;
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW } })).status, 200);
  A.bo = (await srv.req('/api/login', { method: 'POST', body: { name: 'bo', password: PW, app: true }, auth: false })).data.token;

  assert.equal((await req('/api/music/smartlists', {}, '')).status, 401);
  const cat = (await req('/api/music/smartlists')).data;
  assert.deepEqual(cat.lists, []);
  assert.ok(cat.fields.find(f => f.id === 'genre').ops.includes('contains'));
  // Ogiltiga regler ger 400 med svensk text, inget sparas
  for (const body of [{ name: 'x', rules: [{ field: 'title) OR (1=1', op: 'is', value: 'a' }] }, { name: 'x', rules: [], sort: '1; DROP TABLE tracks' },
    { name: 'x', rules: [{ field: 'title', op: 'LIKE', value: '%' }] }, { name: '', rules: [] }]) {
    const r = await req('/api/music/smartlists', { method: 'POST', body });
    assert.equal(r.status, 400, JSON.stringify(body)); assert.ok(r.data.error);
  }
  const pv = (await req('/api/music/smartlists/preview', { method: 'POST', body: { rules: [{ field: 'genre', op: 'is', value: 'pop' }] } })).data;
  assert.equal(pv.count, 1); assert.equal(pv.matches, 1); assert.equal(pv.trackList[0].title, 'Låt 1');
  assert.equal((await req('/api/music/smartlists/preview?tracks=1', { method: 'POST', body: { rules: [], limit: 1 } })).data.matches, 2);
  assert.equal((await req('/api/music/smartlists/preview', { method: 'POST', body: { rules: [{ field: 'year', op: 'gt', value: 'x' }] } })).status, 400);

  const id = (await req('/api/music/smartlists', { method: 'POST', body: { name: 'Allt av Artisten', rules: [{ field: 'artist', op: 'contains', value: 'artist' }], sort: 'title', order: 'asc' } })).data.id;
  // Syns i musikhemmet bland de fasta listorna (apparna läser id/name/count) och öppnas på samma adress
  const home = (await req(`/api/music/${lib}/home`)).data.smart;
  const s = home.find(x => x.id === `u${id}`);
  assert.equal(s.name, 'Allt av Artisten'); assert.equal(s.count, 2); assert.equal(s.mine, true);
  const det = (await req(`/api/music/${lib}/smart/u${id}`)).data;
  assert.deepEqual(det.trackList.map(x => x.title), ['Låt 1', 'Låt 2']);
  assert.equal(det.custom, true); assert.equal(det.listId, id);
  // Privat: den andra användaren ser den inte och kan inte ändra eller ta bort den
  assert.equal((await req(`/api/music/${lib}/smart/u${id}`, {}, A.bo)).status, 404);
  assert.equal((await req(`/api/music/smartlists/${id}`, {}, A.bo)).status, 404);
  assert.equal((await req(`/api/music/smartlists/${id}`, { method: 'PUT', body: { name: 'Kapad', shared: true } }, A.bo)).status, 404);
  assert.equal((await req(`/api/music/smartlists/${id}`, { method: 'DELETE' }, A.bo)).status, 404);
  assert.ok(!(await req(`/api/music/${lib}/home`, {}, A.bo)).data.smart.some(x => x.id === `u${id}`));
  // Delad: syns för alla, men bara ägaren ändrar
  assert.equal((await req(`/api/music/smartlists/${id}`, { method: 'PUT', body: { shared: true } })).status, 200);
  const bl = (await req('/api/music/smartlists', {}, A.bo)).data.lists;
  assert.equal(bl.length, 1); assert.equal(bl[0].owner, 'admin'); assert.equal(bl[0].mine, false);
  assert.equal((await req(`/api/music/${lib}/smart/u${id}`, {}, A.bo)).data.trackList.length, 2);
  assert.ok((await req(`/api/music/${lib}/home`, {}, A.bo)).data.smart.some(x => x.id === `u${id}`));
  assert.equal((await req(`/api/music/smartlists/${id}`, { method: 'PUT', body: { name: 'Kapad' } }, A.bo)).status, 404);
  // Barnprofil: musik har ingen åldersgräns, så delade listor syns; profilens egna listor är privata
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  const kid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  A.kid = (await req('/api/profiles/switch', { method: 'POST', body: { id: kid } })).data.token;
  // Profilbytet avslutar huvudkontots session – logga in igen
  A.admin = (await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, auth: false })).data.token;
  assert.equal((await req(`/api/music/${lib}/smart/u${id}`, {}, A.kid)).status, 200);
  const kidList = (await req('/api/music/smartlists', { method: 'POST', body: { name: 'Lisas', rules: [{ field: 'genre', op: 'is', value: 'Rock' }] } }, A.kid)).data.id;
  assert.equal((await req(`/api/music/${lib}/smart/u${kidList}`, {}, A.kid)).data.trackList.length, 1);
  assert.equal((await req(`/api/music/${lib}/smart/u${kidList}`)).status, 404);
  // Borttagen
  assert.equal((await req(`/api/music/smartlists/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await req(`/api/music/${lib}/smart/u${id}`, {}, A.bo)).status, 404);
  assert.ok(!(await req(`/api/music/${lib}/home`, {}, A.bo)).data.smart.some(x => x.id === `u${id}`));
});
