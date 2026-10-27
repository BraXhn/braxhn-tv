// Egna betyg (server/ratings.js), extramaterial och temamusik (server/trailers.js) mot en riktig server i samma process:
// betyg via API:t per profil (även barnprofiler, bara för det de får se), sortering och filter i biblioteket, Trakt-synk
// mot en låtsasserver; skanning av Extras/Featurettes/… och Plex-suffix, koppling till filmen/serien, mediatokens scope,
// åldersgränsen och raderingsskyddet; temamusikens fält, ström och val per profil. Filerna behöver inga riktiga
// videodata (ffprobe misslyckas tyst) – kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-rate-'));
const MEDIA = path.join(ROOT, 'media');
Object.assign(process.env, { CONFIG_DIR: path.join(ROOT, 'config'), TRANSCODE_DIR: path.join(ROOT, 'tc'), MEDIA_ROOT: MEDIA, WATCH_FILES: '0',
  DVR_DIR: path.join(ROOT, 'rec'), PODCAST_DIR: path.join(ROOT, 'pod'), TMDB_API_KEY: '' });
fs.mkdirSync(MEDIA, { recursive: true });

// Låtsas-Trakt: tar emot betygen
const traktCalls = [];
const fakeTrakt = http.createServer((q, r) => {
  let b = ''; q.on('data', d => b += d);
  q.on('end', () => {
    traktCalls.push({ m: q.method, u: q.url, b: b ? JSON.parse(b) : null });
    const J = (o, s = 200) => { r.writeHead(s, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
    if (q.url.startsWith('/sync/watched/')) return J([]);
    if (q.url === '/sync/ratings') return J({ added: { movies: (JSON.parse(b).movies || []).length, shows: 0, episodes: 0 } }, 201);
    if (q.url === '/sync/ratings/remove') return J({ deleted: {} });
    J({ error: 'okänd' }, 404);
  });
}).listen(0, '127.0.0.1');
await new Promise(r => fakeTrakt.once('listening', r));
process.env.TRAKT_API = `http://127.0.0.1:${fakeTrakt.address().port}`;

const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const sc = await import('../server/scanner.js');
const trailers = await import('../server/trailers.js');
const ratings = await import('../server/ratings.js');
const libfilter = await import('../server/libfilter.js');
const app = await import('../server/app.js');
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fakeTrakt.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const ADMIN = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('anna','x',1,0)").lastInsertRowid);
const BO = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('bo','x',0,0)").lastInsertRowid);
const KID = Number(D.run("INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES('lisa','x',0,0,?,7)", ADMIN).lastInsertRowid);
const tok = Object.fromEntries([ADMIN, BO, KID].map(u => [u, auth.createSession(u, 'app')]));
async function req(uid, p, { method = 'GET', body, token } = {}) {
  const h = {};
  if (token !== '') h.Authorization = `Bearer ${token || tok[uid]}`;
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, type: ct, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

const touch = (f, data = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const F = path.join(MEDIA, 'Film'), T = path.join(MEDIA, 'TV');
const alfa = path.join(F, 'Alfa (2020)');
touch(path.join(alfa, 'Alfa (2020).mkv'));
touch(path.join(alfa, 'Alfa (2020)-trailer.mkv'));
touch(path.join(alfa, 'Alfa (2020)-deleted.mkv'));
touch(path.join(alfa, 'Featurettes', 'Making_of.mkv'), 'featurette-data');
touch(path.join(alfa, 'Behind The Scenes', 'På inspelningen.mp4'));
touch(path.join(alfa, 'Deleted Scenes', 'Scen 1.mkv'));
touch(path.join(alfa, 'Extras', 'Interviews', 'Regissören.mkv'));
touch(path.join(alfa, 'Featurettes', 'poster.jpg')); // bilder i extramaterialets mappar hör inte till filmen
touch(path.join(alfa, 'theme.mp3'), 'ID3-temamusik');
touch(path.join(F, 'Vuxen (2019)', 'Vuxen (2019).mkv'));
touch(path.join(F, 'Vuxen (2019)', 'Interviews', 'Intervju.mkv'));
touch(path.join(F, 'The Other (2010)', 'The Other (2010).mkv'));  // inte extramaterial trots namnet
touch(path.join(F, 'Shorts', 'Kort (2001).mkv'));                  // mappen "Shorts" direkt i biblioteket: vanliga filmer
touch(path.join(F, 'Extras', 'Skräp.mkv'));                        // Extras/ direkt i biblioteket: hoppas över som förut
for (const n of [1, 2]) touch(path.join(T, 'Bamse', 'Season 1', `Bamse S01E0${n}.mkv`));
touch(path.join(T, 'Bamse', 'Featurettes', 'Bakom Bamse.mkv'));
touch(path.join(T, 'Bamse', 'theme.m4a'), 'm4a-tema');
const MLIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", F).lastInsertRowid);
const TLIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('TV','show',?)", T).lastInsertRowid);
await sc.scan();
const item = (title, kind = 'movie') => D.get('SELECT * FROM items WHERE kind=? AND title=? AND version_of IS NULL', kind, title);
const ALFA = item('Alfa'), ADULT = item('Vuxen'), OTHER = item('The Other'), SHOW = item('Bamse', 'show');
const EP1 = D.get('SELECT * FROM items WHERE parent_id=? AND episode=1', SHOW.id);
D.run('UPDATE items SET age=0, tmdb_id=4242 WHERE id=?', ALFA.id);
D.run('UPDATE items SET age=15 WHERE id=?', ADULT.id);
D.run('UPDATE items SET age=0, tmdb_id=77 WHERE id=?', SHOW.id);
const extras = (id) => trailers.extrasOf(id);

test('skanning: extramaterial blir inga titlar och kopplas till filmen/serien, typ ur mapp eller suffix', () => {
  const movies = D.all("SELECT title FROM items WHERE library_id=? AND kind='movie' ORDER BY title", MLIB).map(r => r.title);
  assert.deepEqual(movies, ['Alfa', 'Kort', 'The Other', 'Vuxen']);
  const x = extras(ALFA.id);
  assert.deepEqual(x.map(e => [e.type, e.name]), [
    ['trailer', 'Trailer'], ['featurette', 'Making of'], ['behindthescenes', 'På inspelningen'],
    ['deleted', 'Borttagen scen'], ['deleted', 'Scen 1'], ['interview', 'Regissören']]);
  assert.deepEqual([...new Set(x.map(e => e.group))], ['Trailers', 'Featurettes', 'Bakom kulisserna', 'Borttagna scener', 'Intervjuer']);
  assert.deepEqual(trailers.trailersOf(ALFA.id).map(t => t.name), ['Trailer'], 'apparnas trailerlista har bara trailers');
  assert.deepEqual(extras(ADULT.id).map(e => e.type), ['interview']);
  assert.deepEqual(extras(OTHER.id), []);
  assert.deepEqual(extras(SHOW.id).map(e => [e.type, e.name]), [['featurette', 'Bakom Bamse']]);
  assert.equal(D.get("SELECT COUNT(*) AS n FROM trailers WHERE path LIKE '%Skräp%'").n, 0);
  // Ingen lokal bild från extramaterialets mapp på filmen
  assert.ok(!String(ALFA.local_img || '').includes('poster'));
});

test('extraOf: mappar och Plex-suffix, mappar direkt i biblioteket och hemvideor', () => {
  const x = (p, o) => trailers.extraOf(p.split('/'), o);
  assert.equal(x('Film (2020)/Behind.The.Scenes/a.mkv').type, 'behindthescenes');
  assert.equal(x('Film (2020)/deleted scenes/a.mkv').type, 'deleted');
  assert.equal(x('Film (2020)/Extras/Deleted Scenes/a.mkv').type, 'deleted');
  assert.deepEqual(x('Film (2020)/Extras/Deleted Scenes/a.mkv').home, ['Film (2020)']);
  assert.equal(x('Film (2020)/Film (2020)-featurette2.mkv').type, 'featurette');
  assert.equal(x('Film (2020)/Film (2020)-behindthescenes.mkv').type, 'behindthescenes');
  assert.equal(x('Film (2020)/Film (2020)-other.mkv').type, 'other');
  assert.equal(x('Film (2020)/Film (2020) - trailer.mkv').type, 'trailer');
  assert.equal(x('Trailers/Film-trailer.mkv').type, 'trailer');
  for (const p of ['The Other (2010)/The Other (2010).mkv', 'Shorts/Kort.mkv', 'Scenes/Film.mkv', 'Film/Film - Short Cuts.mkv', 'Film/Film.scene.mkv']) assert.equal(x(p), null, p);
  assert.equal(x('Extras/x.mkv'), 'skip');
  assert.equal(x('Featurettes/x.mkv'), 'skip');
  // Hemvideor: bara det gamla beteendet
  assert.equal(x('2019/Scenes/klipp.mp4', { legacy: true }), null);
  assert.equal(x('2019/Extras/klipp.mp4', { legacy: true }), 'skip');
  assert.equal(x('2019/klipp-trailer.mp4', { legacy: true }).type, 'trailer');
});

test('temamusik: kopplas till filmen och serien, fält och val per profil, strömmen följer åldersgränsen', async () => {
  assert.equal(item('Alfa').theme, path.join(alfa, 'theme.mp3'));
  assert.equal(item('Bamse', 'show').theme, path.join(T, 'Bamse', 'theme.m4a'));
  assert.equal(item('Vuxen').theme, null);
  // Standard: på för serier, av för filmer
  assert.deepEqual((await req(BO, '/api/me/theme-music')).data, { shows: true, movies: false });
  assert.deepEqual((await req(BO, `/api/items/${SHOW.id}`)).data.theme, { play: true });
  assert.deepEqual((await req(BO, `/api/items/${ALFA.id}`)).data.theme, { play: false });
  assert.equal((await req(BO, `/api/items/${ADULT.id}`)).data.theme, undefined, 'utan temafil: inget fält');
  assert.equal((await req(BO, `/api/items/${EP1.id}`)).data.theme, undefined, 'avsnitt: inget fält');
  assert.deepEqual((await req(BO, '/api/me/theme-music', { method: 'PUT', body: { movies: true, shows: 'ja' } })).data, { shows: true, movies: true });
  assert.deepEqual((await req(BO, `/api/items/${ALFA.id}`)).data.theme, { play: true });
  assert.deepEqual((await req(ADMIN, `/api/items/${ALFA.id}`)).data.theme, { play: false }, 'valet gäller bara profilen');
  const s = await req(BO, `/api/items/${SHOW.id}/theme`);
  assert.equal(s.status, 200); assert.equal(s.type, 'audio/mp4'); assert.equal(s.data.toString(), 'm4a-tema');
  assert.equal((await req(BO, `/api/items/${ALFA.id}/theme`)).type, 'audio/mpeg');
  assert.equal((await req(BO, `/api/items/${ADULT.id}/theme`)).status, 404);
  assert.equal((await req(BO, `/api/items/${ALFA.id}/theme`, { token: '' })).status, 401);
  D.run('UPDATE items SET theme=? WHERE id=?', path.join(alfa, 'theme.mp3'), ADULT.id);
  assert.equal((await req(KID, `/api/items/${ADULT.id}/theme`)).status, 404, 'barnprofil: titeln över åldersgränsen');
  assert.equal((await req(KID, `/api/items/${ALFA.id}/theme`)).status, 200);
  D.run('UPDATE items SET theme=NULL WHERE id=?', ADULT.id);
});

test('extramaterial: i titelns svar, strömmas med mediatoken för just den filen och huvudtitelns åldersgräns', async () => {
  const it = (await req(BO, `/api/items/${ALFA.id}`)).data;
  assert.equal(it.extras.length, 6);
  assert.deepEqual(it.trailers.map(t => t.name), ['Trailer']);
  const feat = it.extras.find(e => e.type === 'featurette'), del = it.extras.find(e => e.type === 'deleted');
  // Appar/Chromecast: kortlivad token som bara gäller den filen
  const play = (await req(BO, `/api/trailers/${feat.id}/play`)).data;
  assert.match(play.url, new RegExp(`^/api/trailers/${feat.id}/stream\\?t=`));
  const t = new URL(play.url, B).searchParams.get('t');
  const ok = await fetch(B + play.url);
  assert.equal(ok.status, 200); assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'featurette-data');
  assert.equal((await fetch(`${B}/api/trailers/${del.id}/stream?t=${t}`)).status, 401, 'token för en annan fil');
  assert.equal((await fetch(`${B}/api/items/${ALFA.id}?t=${t}`)).status, 401, 'token på en vanlig route');
  assert.equal((await fetch(`${B}/api/stream/${ALFA.id}/direct?t=${t}`)).status, 401, 'token för huvudtitelns ström');
  // Range fungerar
  const part = await fetch(B + play.url, { headers: { Range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  // Barnprofil: extramaterial för en film över åldersgränsen nekas (som titeln), egna barnfilmers går bra
  const interview = extras(ADULT.id)[0];
  assert.equal((await req(KID, `/api/trailers/${interview.id}/stream`)).status, 403);
  assert.equal((await req(KID, `/api/trailers/${interview.id}/play`)).status, 403);
  assert.equal((await req(KID, `/api/items/${ADULT.id}`)).status, 403);
  assert.equal((await req(KID, `/api/trailers/${feat.id}/stream`)).status, 200);
  assert.equal((await req(KID, `/api/items/${SHOW.id}`)).data.extras.length, 1);
  // Bio-läget väljer bara trailers, aldrig annat extramaterial
  const cinema = await import('../server/cinema.js');
  const picked = cinema.pickTrailers(BO, { id: OTHER.id, genres: '[]' }, 3, { rand: () => 0.5 });
  assert.ok(picked.every(p => D.get('SELECT kind FROM trailers WHERE id=?', p.tid).kind === 'trailer'));
});

test('extramaterial: raderingsskyddet – borttagen fil försvinner, oläsbar biblioteksmapp rör ingenting', async () => {
  const before = extras(ALFA.id).length;
  fs.rmSync(path.join(alfa, 'Deleted Scenes'), { recursive: true });
  await sc.scan(MLIB);
  assert.equal(extras(ALFA.id).length, before - 1);
  // Biblioteksmappen borta (avmonterad disk): extramaterial, temamusik och titlar ligger kvar
  fs.renameSync(F, F + '.borta');
  try {
    await sc.scan(MLIB);
    assert.equal(extras(ALFA.id).length, before - 1);
    assert.ok(item('Alfa')?.theme);
  } finally { fs.renameSync(F + '.borta', F); }
  // Temafilen borttagen: fältet försvinner
  fs.rmSync(path.join(alfa, 'theme.mp3'));
  await sc.scan(MLIB);
  assert.equal(item('Alfa').theme, null);
  assert.equal((await req(BO, `/api/items/${ALFA.id}`)).data.theme, undefined);
});

test('betyg: sätt, läs och ta bort per profil; ogiltiga värden; barnprofil bara för det den får se', async () => {
  const put = (uid, id, rating) => req(uid, `/api/items/${id}/rating`, { method: 'PUT', body: { rating } });
  assert.deepEqual((await put(BO, ALFA.id, 4.5)).data, { rating: 4.5 });
  for (const bad of [0.5, 4.3, 6, -1, 'fem', '4,5']) assert.equal((await put(BO, ALFA.id, bad)).status, 400, String(bad));
  assert.equal((await req(BO, `/api/items/${ALFA.id}`)).data.userRating, 4.5);
  assert.equal((await req(ADMIN, `/api/items/${ALFA.id}`)).data.userRating, undefined, 'andra profiler ser inte betyget');
  assert.equal((await put(BO, OTHER.id, '2')).data.rating, 2);
  assert.equal((await put(BO, SHOW.id, 3)).data.rating, 3);
  assert.equal((await put(BO, EP1.id, 5)).data.rating, 5);
  assert.equal((await req(BO, `/api/items/${SHOW.id}`)).data.children.find(e => e.id === EP1.id).userRating, 5);
  // Barnprofilen betygsätter sina egna, men inte titlar över åldersgränsen
  assert.equal((await put(KID, SHOW.id, 5)).status, 200);
  assert.equal((await put(KID, ADULT.id, 5)).status, 404);
  assert.equal(ratings.getOne(KID, 'item', ADULT.id), 0);
  assert.equal((await req(BO, `/api/items/${SHOW.id}`)).data.userRating, 3, 'barnprofilens betyg påverkar inte andras');
  assert.equal((await put(BO, 999999, 3)).status, 404);
  assert.equal((await req(BO, `/api/items/${ALFA.id}/rating`, { method: 'PUT', body: { rating: 3 }, token: '' })).status, 401);
  // 0 och null tar bort
  assert.equal((await put(BO, OTHER.id, 0)).data.rating, null);
  assert.equal((await req(BO, `/api/items/${OTHER.id}`)).data.userRating, undefined);
  // Listorna har fältet (bara när det finns)
  const list = (await req(BO, `/api/libraries/${MLIB}/items`)).data.items;
  assert.equal(list.find(i => i.id === ALFA.id).userRating, 4.5);
  assert.ok(!('userRating' in list.find(i => i.id === OTHER.id)));
});

test('betyg: sortering och filter i biblioteket (vitlistat), smarta samlingar räknar med tittarens betyg', async () => {
  const ids = async (uid, q) => (await req(uid, `/api/libraries/${MLIB}/items?${q}`)).data.items.map(i => i.title);
  await req(BO, `/api/items/${ADULT.id}/rating`, { method: 'PUT', body: { rating: 2.5 } });
  assert.deepEqual(await ids(BO, 'sort=myrating'), ['Alfa', 'Vuxen', 'Kort', 'The Other']);
  assert.deepEqual(await ids(BO, 'sort=myrating&order=asc'), ['Vuxen', 'Alfa', 'Kort', 'The Other'], 'utan betyg sist åt båda hållen');
  assert.deepEqual(await ids(BO, 'myRatingMin=3'), ['Alfa']);
  assert.deepEqual(await ids(BO, 'myRatingMin=2.5'), ['Alfa', 'Vuxen']);
  assert.deepEqual(await ids(BO, 'rated=no'), ['Kort', 'The Other']);
  assert.deepEqual(await ids(BO, 'rated=yes'), ['Alfa', 'Vuxen']);
  assert.deepEqual(await ids(ADMIN, 'rated=yes'), [], 'administratörens egna betyg');
  const r = (await req(BO, `/api/libraries/${MLIB}/items?myRatingMin=4.5&limit=1`)).data;
  assert.equal(r.total, 1); assert.equal(r.query, 'myRatingMin=4.5');
  // Ogiltigt tas bort (inget når SQL-texten)
  for (const q of ['myRatingMin=4.3', 'myRatingMin=9', "myRatingMin=1);DROP TABLE items;--", 'rated=kanske', 'sort=myrating;--'])
    assert.deepEqual(libfilter.parse(q), {}, q);
  assert.equal(libfilter.toQuery(libfilter.parse('rated=yes&myRatingMin=3.5&sort=myrating')), 'myRatingMin=3.5&rated=yes&sort=myrating');
  // Smart samling med eget betyg: innehållet räknas för den som tittar
  const col = await req(ADMIN, '/api/custom-collections', { method: 'POST', body: { name: 'Mina bästa', smart: { library: MLIB, query: 'myRatingMin=4' }, shared: true } });
  assert.equal(col.status, 200);
  const titles = async (uid) => ((await req(uid, `/api/custom-collections/${col.data.id}`)).data.items || []).map(i => i.title);
  assert.deepEqual(await titles(BO), ['Alfa']);
  assert.deepEqual(await titles(ADMIN), []);
});

test('betyg: Trakt får ändringen och synken skickar alla betyg', async () => {
  D.setSetting('trakt_client_id', 'id'); D.setSetting('trakt_client_secret', 'hemlis');
  D.run("INSERT INTO trakt(user_id,access,refresh,expires) VALUES(?,'tok','ref',?)", BO, Math.floor(Date.now() / 1000) + 30 * 86400);
  traktCalls.length = 0;
  await req(BO, `/api/items/${ALFA.id}/rating`, { method: 'PUT', body: { rating: 3.5 } });
  for (let i = 0; i < 50 && !traktCalls.some(c => c.u === '/sync/ratings'); i++) await new Promise(r => setTimeout(r, 50));
  const c = traktCalls.find(x => x.u === '/sync/ratings');
  assert.deepEqual(c.b.movies.map(m => [m.ids.tmdb, m.rating]), [[4242, 7]]);
  // Borttaget betyg → remove
  traktCalls.length = 0;
  await req(BO, `/api/items/${ALFA.id}/rating`, { method: 'PUT', body: { rating: 0 } });
  for (let i = 0; i < 60 && !traktCalls.some(x => x.u === '/sync/ratings/remove'); i++) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(traktCalls.find(x => x.u === '/sync/ratings/remove').b.movies.map(m => m.ids.tmdb), [4242]);
  // Synken skickar alla profilens betyg (serie och avsnitt via seriens TMDB-id)
  traktCalls.length = 0;
  const trakt = await import('../server/trakt.js');
  const r = await trakt.sync(BO);
  const body = traktCalls.find(x => x.u === '/sync/ratings').b;
  const show = body.shows.find(s => s.ids.tmdb === 77);
  assert.equal(show.rating, 6);
  assert.deepEqual(show.seasons, [{ number: 1, episodes: [{ number: 1, rating: 10, rated_at: show.seasons[0].episodes[0].rated_at }] }]);
  assert.equal(typeof r.ratings, 'number');
  assert.equal(D.get('SELECT sync_error FROM trakt WHERE user_id=?', BO).sync_error, null);
});

test('extramaterial som webbläsaren inte klarar: ?mp4=1 gör om filen till fragmenterad MP4', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg saknas' }, async () => {
  const f = path.join(alfa, 'Interviews', 'Gammal.avi');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '1',
    '-c:v', 'mpeg4', '-c:a', 'mp2', f]);
  await sc.scan(MLIB);
  const x = extras(ALFA.id).find(e => e.name === 'Gammal');
  assert.equal(x.type, 'interview');
  const r = await req(BO, `/api/trailers/${x.id}/stream?mp4=1`);
  assert.equal(r.status, 200); assert.equal(r.type, 'video/mp4');
  assert.equal(r.data.subarray(4, 8).toString(), 'ftyp');
  assert.ok(r.data.length > 1000);
  assert.equal((await req(KID, `/api/trailers/${extras(ADULT.id)[0].id}/stream?mp4=1`)).status, 403);
});
