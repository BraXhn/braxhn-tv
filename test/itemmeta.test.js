// Metadataredigering och bildval (server/itemmeta.js, routes/metadata.js): lås per fält som överlever "Uppdatera
// metadata" (TMDB), NFO och omskanning; TMDB:s bilder (språkordning, bara listade filnamn), uppladdning (rå kropp och
// multipart, fel typ, trasig fil, för stor fil), återställning till automatiskt och behörighet (admin, betrott nät,
// CSRF). Kräver ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-meta-'));
const MEDIA = path.join(ROOT, 'media'), PICS = path.join(ROOT, 'pics');
fs.mkdirSync(PICS, { recursive: true });
const pic = (f, size = "300x450", src = "testsrc", extra = []) => { fs.mkdirSync(path.dirname(f), { recursive: true }); execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", src.endsWith(":s") ? `${src.slice(0, -2)}:size=${size}` : `${src}=size=${size}`, '-frames:v', '1', ...extra, f]); };
const vid = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]); };
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// Låtsas-TMDB: API under /3, bilder under /t/p/<storlek>/<fil>
const hits = [];
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.push(u.pathname);
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const im = /^\/t\/p\/\w+\/([\w-]+\.(jpg|png))$/.exec(u.pathname);
  if (im) {
    const f = path.join(PICS, im[1]);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': im[2] === 'png' ? 'image/png' : 'image/jpeg' });
    return res.end(fs.readFileSync(f));
  }
  if (u.pathname === '/3/search/movie') return json({ results: [{ id: 603, title: 'The Matrix', release_date: '1999-03-31' }] });
  if (u.pathname === '/3/movie/603') return json({ id: 603, title: 'The Matrix', original_title: 'The Matrix', overview: 'Från TMDB', tagline: 'TMDB-tagline', release_date: '1999-03-31',
    vote_average: 8.2, genres: [{ name: 'Action' }], poster_path: '/defpost.jpg', backdrop_path: null, release_dates: { results: [] }, credits: { cast: [], crew: [] }, videos: { results: [] },
    images: { logos: [{ file_path: '/logo.svg', iso_639_1: 'sv' }, { file_path: '/logo-en.png', iso_639_1: 'en' }] } });
  if (u.pathname === '/3/movie/603/images') {
    assert.match(u.searchParams.get('include_image_language'), /^sv,en,null$/);
    return json({ posters: [{ file_path: '/p-en.jpg', iso_639_1: 'en', vote_average: 5, width: 300, height: 450 }, { file_path: '/p-sv.jpg', iso_639_1: 'sv', vote_average: 1 },
      { file_path: '/p-null.jpg', iso_639_1: null, vote_average: 9 }, { file_path: '/../../etc/passwd.jpg', iso_639_1: 'sv' }, { file_path: '/trasig.jpg', iso_639_1: 'en' }],
    backdrops: [{ file_path: '/b1.jpg', iso_639_1: null }], logos: [{ file_path: '/logo.svg', iso_639_1: 'sv' }, { file_path: '/logo-en.png', iso_639_1: 'en' }] });
  }
  if (u.pathname === '/3/search/tv') return json({ results: [{ id: 1399, name: 'Bron', first_air_date: '2011-09-21' }] });
  if (u.pathname === '/3/tv/1399') return json({ id: 1399, name: 'Bron', overview: 'TMDB-serie', first_air_date: '2011-09-21', genres: [], poster_path: null,
    seasons: [{ season_number: 1, episode_count: 2 }], content_ratings: { results: [] }, aggregate_credits: { cast: [] }, videos: { results: [] } });
  if (u.pathname === '/3/tv/1399/season/1') return json({ episodes: [{ episode_number: 1, name: 'TMDB ett', overview: 'TMDB 1' }, { episode_number: 2, name: 'TMDB två', overview: 'TMDB 2' }] });
  if (u.pathname === '/3/tv/1399/season/1/images') return json({ posters: [{ file_path: '/sp1.jpg', iso_639_1: 'sv' }] });
  // Avsnittet har fått nummer 5 (låst) i testet ovan – TMDB frågas om det numret
  if (/^\/3\/tv\/1399\/season\/1\/episode\/5\/images$/.test(u.pathname)) return json({ stills: [{ file_path: '/s1.jpg', iso_639_1: null }] });
  if (/^\/3\/(movie|tv)\/\d+\/(alternative_titles|external_ids)$/.test(u.pathname)) return json({ titles: [], results: [] });
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.CREDITS_PER_SCAN = '0';
process.env.TMDB_API_URL = FAKE + '/3';
process.env.TMDB_IMAGE_URL = FAKE + '/t/p';
process.env.TMDB_API_KEY = 'testnyckel';
process.env.IMAGE_UPLOAD_MAX_MB = '1';

let D, scanner, auth, B, tok, srv, userTok;
const LAN = { 'x-forwarded-for': '192.168.1.20' };
async function req(p, { method = 'GET', body, raw, type, headers = {}, t = tok } = {}) {
  const h = { ...LAN, authorization: `Bearer ${t}`, ...headers };
  if (body) h['content-type'] = 'application/json';
  if (raw) h['content-type'] = type;
  const r = await fetch(B + p, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), ct };
}
const item = (where, ...p) => D.get(`SELECT * FROM items WHERE ${where}`, ...p);
const IM = () => path.join(process.env.CONFIG_DIR, 'images');
const MOV = path.join(MEDIA, 'Filmer', 'The Matrix (1999)'), SER = path.join(MEDIA, 'Serier');
const ids = {};

test('förbered mediafiler och server', { skip: !hasFfmpeg }, async () => {
  vid(path.join(MOV, 'The Matrix (1999).mp4'));
  vid(path.join(SER, 'Bron', 'Season 1', 'Bron S01E01.mp4'));
  vid(path.join(SER, 'Bron', 'Season 1', 'Bron S01E02.mp4'));
  for (const n of ['defpost', 'p-en', 'p-sv', 'p-null', 'b1', 'sp1', 's1']) pic(path.join(PICS, n + '.jpg'), n === 'b1' || n === 's1' ? '640x360' : '300x450', n === 'p-sv' ? 'testsrc2' : 'testsrc');
  pic(path.join(PICS, 'logo-en.png'), '400x100', 'color=c=red@0.5:s', ['-pix_fmt', 'rgba']);
  fs.writeFileSync(path.join(PICS, 'trasig.jpg'), Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 7)]));
  D = await import('../server/db.js');
  scanner = await import('../server/scanner.js');
  auth = await import('../server/auth.js');
  const app = await import('../server/app.js');
  srv = http.createServer(app.handle);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  B = `http://127.0.0.1:${srv.address().port}`;
  const r = await fetch(B + '/api/setup', { method: 'POST', headers: { ...LAN, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: 'Långt-lösen-123!' }) });
  assert.equal(r.status, 200);
  tok = auth.createSession(D.get("SELECT id FROM users WHERE name='admin'").id, 'app');
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'vanlig', password: 'Ett-annat-lösen-456!' } })).status, 200);
  userTok = auth.createSession(D.get("SELECT id FROM users WHERE name='vanlig'").id, 'app');
  ids.movies = (await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).data.id;
  ids.shows = (await req('/api/libraries', { method: 'POST', body: { name: 'Serier', type: 'show', path: SER } })).data.id;
  await scanner.scan(ids.movies);
  await scanner.scan(ids.shows);
  const m = item("kind='movie'");
  assert.equal(m.tmdb_id, 603);
  assert.equal(m.tagline, 'TMDB-tagline');
  assert.equal(m.poster, 1, 'TMDB:s affisch hämtades från bildvärden');
  assert.equal(m.logo, 1, 'PNG-logotypen (SVG hoppas över)');
  ids.movie = m.id;
  ids.show = item("kind='show'").id;
  ids.ep1 = item("kind='episode' AND episode=1").id;
  const d = await req(`/api/items/${m.id}`);
  assert.equal(d.data.tagline, 'TMDB-tagline'); assert.equal(d.data.logo, true);
  const logo = await req(`/api/image/${m.id}/logo?w=240`);
  assert.equal(logo.status, 200); assert.equal(logo.ct, 'image/png'); assert.equal(logo.data[1], 0x50, 'PNG, inte nedskalad JPEG');
});
after(() => { srv?.close(); fake.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('låsta fält överlever Uppdatera metadata (TMDB), NFO och omskanning – olåsta uppdateras', { skip: !hasFfmpeg }, async () => {
  const id = ids.movie;
  const e = await req(`/api/items/${id}/metadata`);
  assert.equal(e.status, 200);
  assert.deepEqual(e.data.locked, []);
  assert.ok(e.data.fields.includes('tagline') && !e.data.fields.includes('season'));
  assert.ok(e.data.genreSuggestions.includes('Action'));
  assert.equal(e.data.values.title, 'The Matrix');
  // Utan locked låses de ändrade fälten (som Plex); titeln låser sorteringen också
  const s = await req(`/api/items/${id}/metadata`, { method: 'PUT', body: { values: { title: 'Matrix – min version', overview: 'Egen beskrivning', genres: ['Sci-fi', 'Action', 'sci-fi'],
    age: 15, year: 2000, released: '2000-01-02', tagline: 'Egen tagline', rating: 9.15 } } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.deepEqual(new Set(s.data.locked), new Set(['title', 'sortTitle', 'overview', 'genres', 'age', 'year', 'released', 'tagline', 'rating']));
  assert.equal(s.data.item.title, 'Matrix – min version');
  assert.deepEqual(s.data.item.genres, ['Sci-fi', 'Action'], 'genrer är fortfarande en lista (apparna)');
  assert.equal(s.data.item.year, 2000); assert.equal(s.data.item.age, 15); assert.equal(s.data.item.rating, 9.2);
  // Uppdatera metadata: TMDB svarar med sina värden
  assert.equal((await req(`/api/items/${id}/refresh`, { method: 'POST', body: {} })).status, 200);
  let m = item('id=?', id);
  assert.equal(m.title, 'Matrix – min version');
  assert.equal(m.sort_title, 'matrix – min version');
  assert.equal(m.overview, 'Egen beskrivning');
  assert.deepEqual(JSON.parse(m.genres), ['Sci-fi', 'Action']);
  assert.equal(m.age, 15); assert.equal(m.year, 2000); assert.equal(m.released, '2000-01-02'); assert.equal(m.tagline, 'Egen tagline');
  assert.equal(m.original_title, null, 'olåst fält skrivs av TMDB som vanligt');
  // NFO bredvid filen: låsta fält rörs inte, olåsta (studio) tas in
  write(path.join(MOV, 'movie.nfo'), '<movie><title>NFO-titel</title><plot>NFO-beskrivning</plot><studio>Warner</studio><year>1999</year><genre>Drama</genre></movie>');
  await scanner.scan(ids.movies);
  m = item('id=?', id);
  assert.equal(m.title, 'Matrix – min version'); assert.equal(m.overview, 'Egen beskrivning'); assert.equal(m.year, 2000);
  assert.deepEqual(JSON.parse(m.genres), ['Sci-fi', 'Action']);
  assert.equal(m.studio, 'Warner', 'olåst fält från NFO');
  // Skrivning direkt i databasen (en annan väg) kan inte heller ändra ett låst fält
  D.run("UPDATE items SET title='Rått', overview='Rått' WHERE id=?", id);
  assert.equal(item('id=?', id).title, 'Matrix – min version');
  // Lås upp beskrivningen: nästa uppdatering ger NFO:ns/TMDB:s värde igen
  const cur = (await req(`/api/items/${id}/metadata`)).data.locked.filter(k => k !== 'overview');
  assert.equal((await req(`/api/items/${id}/metadata`, { method: 'PUT', body: { values: {}, locked: cur } })).status, 200);
  await req(`/api/items/${id}/refresh`, { method: 'POST', body: {} });
  m = item('id=?', id);
  assert.equal(m.overview, 'NFO-beskrivning', 'upplåst fält följer NFO (som går före TMDB)');
  assert.equal(m.title, 'Matrix – min version');
  // Lås ett fält med sitt nuvarande värde (utan att ändra det)
  assert.equal((await req(`/api/items/${id}/metadata`, { method: 'PUT', body: { values: {}, locked: [...cur, 'studio'] } })).status, 200);
  write(path.join(MOV, 'movie.nfo'), '<movie><title>NFO-titel</title><plot>NFO-beskrivning</plot><studio>Annan studio</studio></movie>');
  await scanner.scan(ids.movies);
  assert.equal(item('id=?', id).studio, 'Warner');
  fs.rmSync(path.join(MOV, 'movie.nfo'));
  await scanner.scan(ids.movies);
  // Den äldre redigeringen (PUT /api/items/:id) låser också
  assert.equal((await req(`/api/items/${id}`, { method: 'PUT', body: { title: 'Matrix igen', year: 2001 } })).status, 200);
  await req(`/api/items/${id}/refresh`, { method: 'POST', body: {} });
  assert.equal(item('id=?', id).title, 'Matrix igen'); assert.equal(item('id=?', id).year, 2001);
});

test('avsnitt: titel, beskrivning, säsong och avsnittsnummer låses mot TMDB och omskanning', { skip: !hasFfmpeg }, async () => {
  const id = ids.ep1;
  const e = await req(`/api/items/${id}/metadata`);
  assert.ok(e.data.fields.includes('season') && !e.data.fields.includes('genres'));
  assert.equal(e.data.values.title, 'TMDB ett');
  const s = await req(`/api/items/${id}/metadata`, { method: 'PUT', body: { values: { title: 'Pilot', overview: 'Min text', season: 1, episode: 5 } } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.item.season, 1); assert.equal(s.data.item.episode, 5);
  assert.equal((await req(`/api/items/${ids.show}/refresh`, { method: 'POST', body: {} })).status, 200);
  D.run('UPDATE items SET mtime=0 WHERE id=?', id); // filen läses om (filnamnet säger E01)
  await scanner.scan(ids.shows);
  const ep = item('id=?', id);
  assert.equal(ep.title, 'Pilot'); assert.equal(ep.overview, 'Min text'); assert.equal(ep.episode, 5);
  assert.equal(item("kind='episode' AND path LIKE '%S01E02%'").title, 'TMDB två', 'andra avsnittet uppdateras som vanligt');
  // Ogiltiga värden och fält som inte hör till avsnitt
  for (const values of [{ title: '' }, { genres: ['x'] }, { season: -1 }, { episode: 'tre' }, { rating: 11 }, { okänt: 1 }])
    assert.equal((await req(`/api/items/${id}/metadata`, { method: 'PUT', body: { values } })).status, 400, JSON.stringify(values));
  assert.equal((await req(`/api/items/${ids.movie}/metadata`, { method: 'PUT', body: { values: { released: '2001-02-30' } } })).status, 400);
  assert.equal((await req(`/api/items/${ids.movie}/metadata`, { method: 'PUT', body: { values: {}, locked: ['season'] } })).status, 400);
});

test('bildval från TMDB: språkordning, bara listade filnamn, låst mot omskanning', { skip: !hasFfmpeg }, async () => {
  const id = ids.movie;
  const r = await req(`/api/items/${id}/images/poster`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.options.map(o => o.path), ['/p-sv.jpg', '/p-en.jpg', '/trasig.jpg', '/p-null.jpg'], 'sv, en, utan text; skadliga sökvägar tas bort');
  assert.deepEqual((await req(`/api/items/${id}/images/logo`)).data.options.map(o => o.path), ['/logo-en.png'], 'SVG-logotyper visas inte');
  assert.equal((await req(`/api/items/${id}/images/fel`)).status, 404);
  assert.equal((await req(`/api/items/${id}/images/season1`)).status, 404, 'filmer har inga säsonger');
  // Bara filnamn som TMDB listar för titeln – inga sökvägar eller adresser från klienten
  for (const p of ['/../../etc/passwd.jpg', 'https://evil.example/x.jpg', '/p-sv.jpg?x', 42])
    assert.equal((await req(`/api/items/${id}/images/poster`, { method: 'POST', body: { tmdbPath: p } })).status, 400, String(p));
  assert.equal((await req(`/api/items/${id}/images/poster`, { method: 'POST', body: { tmdbPath: '/inte-listad.jpg' } })).status, 404);
  assert.equal((await req(`/api/items/${id}/images/poster`, { method: 'POST', body: { tmdbPath: '/trasig.jpg' } })).status, 400, 'trasig bild från TMDB sparas inte');
  const before = fs.readFileSync(path.join(IM(), `${id}-poster.jpg`));
  D.run("UPDATE items SET poster_color='#000000' WHERE id=?", id);
  const ch = await req(`/api/items/${id}/images/poster`, { method: 'POST', body: { tmdbPath: '/p-sv.jpg' } });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  assert.deepEqual(ch.data.images.poster, { has: true, lock: 'tmdb', path: '/p-sv.jpg' });
  const after1 = fs.readFileSync(path.join(IM(), `${id}-poster.jpg`));
  assert.ok(!after1.equals(before)); assert.equal(after1[0], 0xFF);
  assert.equal(item('id=?', id).poster_color, null, 'platshållarfärgen räknas om');
  // Uppdatera metadata hämtar inte TMDB:s standardaffisch över den valda
  const n = hits.filter(h => h.endsWith('/defpost.jpg')).length;
  await req(`/api/items/${id}/refresh`, { method: 'POST', body: {} });
  await scanner.scan(ids.movies);
  assert.equal(hits.filter(h => h.endsWith('/defpost.jpg')).length, n);
  assert.ok(fs.readFileSync(path.join(IM(), `${id}-poster.jpg`)).equals(after1));
  // Logotyp: PNG med genomskinlighet
  assert.equal((await req(`/api/items/${id}/images/logo`, { method: 'POST', body: { tmdbPath: '/logo-en.png' } })).status, 200);
  assert.equal(fs.readFileSync(path.join(IM(), `${id}-logo.png`))[1], 0x50);
  // Säsongsaffisch och avsnittets stillbild
  assert.deepEqual((await req(`/api/items/${ids.show}/images/season1`)).data.options.map(o => o.path), ['/sp1.jpg']);
  assert.equal((await req(`/api/items/${ids.show}/images/season1`, { method: 'POST', body: { tmdbPath: '/sp1.jpg' } })).status, 200);
  assert.deepEqual((await req(`/api/items/${ids.show}`)).data.seasonPosters, [1]);
  assert.equal((await req(`/api/image/${ids.show}/season1`)).status, 200);
  await scanner.scan(ids.shows);
  assert.equal((await req(`/api/image/${ids.show}/season1`)).status, 200, 'omskanning utan lokal fil tar inte bort den valda');
  assert.deepEqual((await req(`/api/items/${ids.ep1}/images/thumb`)).data.options.map(o => o.path), ['/s1.jpg']);
  assert.equal((await req(`/api/items/${ids.ep1}/images/thumb`, { method: 'POST', body: { tmdbPath: '/s1.jpg' } })).status, 200);
});

test('uppladdning: JPEG/PNG/WebP (rå kropp eller multipart), fel typ, trasig fil, för stor fil', { skip: !hasFfmpeg }, async () => {
  const id = ids.movie;
  const png = path.join(ROOT, 'egen.png'), webp = path.join(ROOT, 'egen.webp');
  pic(png, '800x1200', 'testsrc2');
  pic(webp, '1280x720', 'testsrc');
  const up = (type, raw, t = 'poster', headers) => req(`/api/items/${id}/images/${t}`, { method: 'PUT', raw, type, headers });
  const r = await up('image/png', fs.readFileSync(png));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.images.poster, { has: true, lock: 'upload' });
  const saved = fs.readFileSync(path.join(IM(), `${id}-poster.jpg`));
  assert.equal(saved[0], 0xFF, 'konverterad till JPEG');
  assert.equal(JSON.parse(item('id=?', id).img_locked).poster, 'upload');
  assert.equal((await up('image/webp', fs.readFileSync(webp), 'backdrop')).status, 200);
  assert.equal(item('id=?', id).backdrop, 1);
  // Multipart (som ett vanligt formulär)
  const bd = 'xyzGRANS123';
  const mp = Buffer.concat([Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), fs.readFileSync(png), Buffer.from(`\r\n--${bd}--\r\n`)]);
  const mr = await up(`multipart/form-data; boundary=${bd}`, mp, 'thumb');
  assert.equal(mr.status, 200, JSON.stringify(mr.data));
  // Fel typ: GIF, text som utger sig för att vara PNG, SVG
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x00\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'latin1');
  assert.equal((await up('image/gif', gif)).status, 415);
  assert.equal((await up('image/png', gif)).status, 415);
  assert.equal((await up('image/png', Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd\n'))).status, 415);
  assert.equal((await up('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status, 415);
  // Trasig fil med rätt inledning
  assert.equal((await up('image/png', Buffer.concat([fs.readFileSync(png).subarray(0, 40), Buffer.alloc(500, 1)]))).status, 400);
  assert.equal((await up('image/jpeg', Buffer.alloc(0))).status, 400);
  // För stor (gränsen är 1 MB i testet)
  const big = Buffer.concat([fs.readFileSync(png), Buffer.alloc(1200 << 10)]);
  assert.equal((await up('image/png', big)).status, 413);
  assert.ok(fs.readFileSync(path.join(IM(), `${id}-poster.jpg`)).equals(saved), 'misslyckade uppladdningar rör inte bilden');
  assert.ok(!fs.readdirSync(IM()).some(f => f.startsWith('.upload-') || f.endsWith('.tmp')), 'inga temporära filer kvar');
  // Bilden serveras och nedskalas som vanligt
  const im = await req(`/api/image/${id}/poster?w=240`);
  assert.equal(im.status, 200);
});

test('återställ till automatiskt: låset tas bort och TMDB:s bild hämtas igen', { skip: !hasFfmpeg }, async () => {
  const id = ids.movie;
  const r = await req(`/api/items/${id}/images/poster`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.images.poster, { has: true, lock: null });
  assert.equal(JSON.parse(item('id=?', id).img_locked).poster, undefined);
  assert.ok(fs.readFileSync(path.join(IM(), `${id}-poster.jpg`)).equals(fs.readFileSync(path.join(PICS, 'defpost.jpg'))), 'TMDB:s standardaffisch');
  // Säsongsaffischen utan lokal fil försvinner
  assert.equal((await req(`/api/items/${ids.show}/images/season1`, { method: 'DELETE' })).status, 200);
  assert.equal((await req(`/api/image/${ids.show}/season1`)).status, 404);
  // En lokal affisch bredvid filen tar över vid skanningen
  pic(path.join(MOV, 'poster.jpg'), '300x450', 'testsrc2');
  await scanner.scan(ids.movies);
  assert.ok(JSON.parse(item('id=?', id).local_img).poster.includes('poster.jpg'));
  // … men en uppladdad bild går före den lokala filen tills den återställs
  const png = path.join(ROOT, 'egen.png');
  assert.equal((await req(`/api/items/${id}/images/poster`, { method: 'PUT', raw: fs.readFileSync(png), type: 'image/png' })).status, 200);
  const up = fs.readFileSync(path.join(IM(), `${id}-poster.jpg`));
  fs.utimesSync(path.join(MOV, 'poster.jpg'), new Date(), new Date(Date.now() + 5000));
  await scanner.scan(ids.movies);
  assert.ok(fs.readFileSync(path.join(IM(), `${id}-poster.jpg`)).equals(up));
  await req(`/api/items/${id}/images/poster`, { method: 'DELETE' });
  await scanner.scan(ids.movies);
  assert.ok(!fs.readFileSync(path.join(IM(), `${id}-poster.jpg`)).equals(up), 'den lokala filen läses in igen');
  assert.ok(JSON.parse(item('id=?', id).local_img).poster);
});

test('behörighet: bara administratör, bara betrott nät, CSRF med kaka', { skip: !hasFfmpeg }, async () => {
  const id = ids.movie, png = fs.readFileSync(path.join(ROOT, 'egen.png'));
  const calls = [['GET', `/api/items/${id}/metadata`], ['PUT', `/api/items/${id}/metadata`, { values: { title: 'x' } }], ['GET', `/api/items/${id}/images/poster`],
    ['POST', `/api/items/${id}/images/poster`, { tmdbPath: '/p-sv.jpg' }], ['DELETE', `/api/items/${id}/images/poster`]];
  for (const [method, p, body] of calls) {
    assert.equal((await req(p, { method, body, t: userTok })).status, 403, `${method} ${p} som vanlig användare`);
    assert.equal((await req(p, { method, body, headers: { 'x-forwarded-for': '8.8.8.8' } })).status, 403, `${method} ${p} utifrån`);
  }
  assert.equal((await req(`/api/items/${id}/images/poster`, { method: 'PUT', raw: png, type: 'image/png', t: userTok })).status, 403);
  assert.equal((await req(`/api/items/${id}/images/poster`, { method: 'PUT', raw: png, type: 'image/png', headers: { 'x-forwarded-for': '8.8.8.8' } })).status, 403);
  assert.equal((await req(`/api/items/${id}/metadata`, { t: '' })).status, 401);
  const web = auth.createSession(D.get("SELECT id FROM users WHERE name='admin'").id, 'web');
  const put = (origin) => fetch(`${B}/api/items/${id}/images/poster`, { method: 'PUT', headers: { ...LAN, cookie: `kt=${web}`, 'content-type': 'image/png', origin }, body: png });
  assert.equal((await put('https://elak.example')).status, 403);
  assert.equal((await put(B)).status, 200);
  assert.equal((await req('/api/items/999999/metadata')).status, 404);
  assert.equal(item('id=?', id).title, 'Matrix igen', 'inget nekat anrop ändrade titeln');
});
