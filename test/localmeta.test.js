// Lokal metadata och bibliotekens mappar: NFO-tolkning (även skadliga och enorma filer), lokala bilder före TMDB,
// exakt TMDB-matchning på NFO:ns id, flera mappar per bibliotek (raderingsskyddet per mapp – en saknad disk tar
// aldrig bort något), byte/borttagning av mappar, hemvideor (titel från filnamn, datum, mappar) och att fälten i
// /api/libraries som apparna läser är oförändrade. Kräver ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-local-'));
const MEDIA = path.join(ROOT, 'media');

// Låtsas-TMDB: film 567 (Rear Window) och serien 1408 (Bron); sökningar ger inget (exakt matchning måste användas)
const hits = [];
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.push(u.pathname);
  const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/3/movie/567') return json(200, { id: 567, title: 'Rear Window', original_title: 'Rear Window', overview: 'Från TMDB', release_date: '1954-09-01',
    vote_average: 8.1, genres: [{ name: 'Thriller' }], poster_path: null, backdrop_path: null, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG' }] }] }, credits: { cast: [], crew: [] }, videos: { results: [] } });
  if (u.pathname === '/3/find/tt0113277') return json(200, { movie_results: [{ id: 949 }], tv_results: [] });
  if (u.pathname === '/3/movie/949') return json(200, { id: 949, title: 'Heat', overview: 'Från TMDB', release_date: '1995-12-15', genres: [], release_dates: { results: [] }, credits: { cast: [], crew: [] }, videos: { results: [] } });
  if (u.pathname === '/3/tv/1408') return json(200, { id: 1408, name: 'The Bridge', original_name: 'Bron/Broen', overview: 'TMDB-serie', first_air_date: '2011-09-21', genres: [],
    seasons: [{ season_number: 1, episode_count: 1 }], content_ratings: { results: [] }, aggregate_credits: { cast: [] }, videos: { results: [] } });
  if (u.pathname === '/3/tv/1408/season/1') return json(200, { episodes: [{ episode_number: 1, name: 'TMDB-avsnitt', overview: 'TMDB', still_path: null }] });
  if (u.pathname === '/3/search/movie' && /rear window/i.test(u.searchParams.get('query') || '')) return json(200, { results: [{ id: 567, title: 'Rear Window', release_date: '1954-09-01' }] });
  if (/^\/3\/search\//.test(u.pathname)) return json(200, { results: [] });
  json(404, { status_message: 'saknas' });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));

process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.CREDITS_PER_SCAN = '0';
process.env.TMDB_API_URL = `http://127.0.0.1:${fake.address().port}/3`;
process.env.TMDB_API_KEY = 'testnyckel';

const nfo = await import('../server/nfo.js');

// ---------------- NFO-tolkning (inga filer) ----------------
const MOVIE_NFO = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>Fönstret mot gården</title>
  <originaltitle>Rear Window</originaltitle>
  <sorttitle>Fonstret mot garden</sorttitle>
  <ratings><rating name="imdb" max="10" default="true"><value>8.5</value><votes>10</votes></rating><rating name="tmdb"><value>6</value></rating></ratings>
  <year>1954</year>
  <plot><![CDATA[En fotograf i rullstol <b>spionerar</b> på grannarna.]]></plot>
  <mpaa>Sweden:11</mpaa>
  <uniqueid type="imdb">tt0047396</uniqueid>
  <uniqueid type="tmdb" default="true">567</uniqueid>
  <genre>Thriller / Mysterium</genre><genre>Drama</genre>
  <studio>Paramount</studio>
  <premiered>1954-08-01</premiered>
  <set><name>Hitchcock-samlingen</name></set>
  <actor><name>James Stewart</name><role>Jeff</role><order>0</order><tmdbid>854</tmdbid></actor>
  <actor><name>Grace Kelly</name><role>Lisa</role></actor>
  <fileinfo><streamdetails><video><codec>h264</codec></video></streamdetails></fileinfo>
</movie>`;

test('NFO för film: titel, originaltitel, sortering, år, beskrivning, betyg, åldersgräns, genrer, studio, id, rollista', () => {
  const n = nfo.parseNfo(MOVIE_NFO, 'movie');
  assert.equal(n.title, 'Fönstret mot gården');
  assert.equal(n.originalTitle, 'Rear Window');
  assert.equal(n.sortTitle, 'Fonstret mot garden');
  assert.equal(n.year, 1954);
  assert.equal(n.plot, 'En fotograf i rullstol spionerar på grannarna.');
  assert.equal(n.rating, 8.5, 'standardbetyget i <ratings>');
  assert.deepEqual(n.genres, ['Thriller', 'Mysterium', 'Drama']);
  assert.equal(n.studio, 'Paramount');
  assert.equal(n.premiered, '1954-08-01');
  assert.deepEqual(n.ids, { tmdb: 567, imdb: 'tt0047396', tvdb: null });
  assert.equal(n.actors.length, 2);
  assert.deepEqual(n.actors[0], { name: 'James Stewart', role: 'Jeff', order: 0, tmdb: 854 });
  // Samlingens <name> och filinfo blir inte titel eller något annat
  assert.ok(!JSON.stringify(n).includes('Hitchcock-samlingen'));
  assert.deepEqual(nfo.certFromNfo(n.mpaa), { cert: 'SE:11', age: 11 });
});

test('NFO: avsnitt, serie, äldre id-taggar, länk-NFO och åldersgränser i olika format', () => {
  const e = nfo.parseNfo('<episodedetails><title>Liket på bron</title><season>1</season><episode>1</episode><aired>2011-09-21</aired><rating>8,1</rating></episodedetails><episodedetails><title>Del 2</title></episodedetails>', 'episodedetails');
  assert.equal(e.title, 'Liket på bron', 'flera avsnitt i samma fil: det första');
  assert.equal(e.season, 1); assert.equal(e.episode, 1); assert.equal(e.rating, 8.1); assert.equal(e.premiered, '2011-09-21');
  const s = nfo.parseNfo('<tvshow><title>Bron</title><id>252019</id><imdbid>tt1733785</imdbid><namedseason number="1">Första</namedseason></tvshow>', 'tvshow');
  assert.deepEqual(s.ids, { tmdb: null, imdb: 'tt1733785', tvdb: 252019 });
  assert.equal(s.title, 'Bron');
  assert.deepEqual(nfo.parseNfo('https://www.themoviedb.org/movie/603-the-matrix\n', 'movie').ids.tmdb, 603);
  assert.equal(nfo.parseNfo('http://www.imdb.com/title/tt0133093/', 'movie').ids.imdb, 'tt0133093');
  assert.equal(nfo.parseNfo('<tvshow><title>Fel typ</title></tvshow>', 'movie'), null, 'fel rotelement');
  assert.equal(nfo.parseNfo('', 'movie'), null);
  assert.equal(nfo.parseNfo('<movie><title>Avklippt fil', 'movie'), null, 'utan sluttagg finns ingen titel');
  assert.equal(nfo.parseNfo('<movie><title>Halv</title><plot>…', 'movie').title, 'Halv', 'avklippt efter titeln');
  for (const [s2, want] of [['Rated PG-13', 'US:PG-13'], ['US:R', 'US:R'], ['SE:15 / US:R', 'SE:15'], ['FSK 12', 'DE:12'], ['TV-MA', 'US:TV-MA'], ['de:16', 'DE:16'], ['Btl', 'SE:Btl']])
    assert.equal(nfo.certFromNfo(s2)?.cert, want, s2);
  assert.equal(nfo.certFromNfo('Okänd'), null);
  assert.equal(nfo.isoDate('16.07.2010'), '2010-07-16');
  assert.equal(nfo.isoDate('2010-13-40'), null);
});

test('skadliga och enorma NFO-filer: storleksgräns, inga entiteter från DOCTYPE, linjär tid', () => {
  assert.equal(nfo.parseNfo('<movie><title>x</title></movie>' + ' '.repeat(nfo.NFO_MAX), 'movie'), null, 'över storleksgränsen');
  assert.equal(nfo.parseNfo(Buffer.alloc(nfo.NFO_MAX + 1, 32), 'movie'), null);
  const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><movie><title>&lol2;&amp;</title></movie>';
  assert.equal(nfo.parseNfo(bomb, 'movie').title, '&lol2;&', 'egna entiteter expanderas aldrig');
  const evil = [
    '<movie>' + '<'.repeat(450000) + '</movie>',
    '<movie><title>' + '<a '.repeat(150000),
    '<movie>' + '<actor>'.repeat(70000),
    '<movie>' + '<set>'.repeat(80000) + '<title>ok</title></movie>',
    '<movie><title>a</title>' + '<title '.repeat(70000) + '>',
    '<movie>' + '<genre>x</genre>'.repeat(30000) + '</movie>',
    '<movie><title>' + '&#x'.repeat(150000) + '</title></movie>',
    '<movie><plot>' + '<![CDATA['.repeat(50000) + '</plot></movie>',
    '<movie>' + '<uniqueid type="'.repeat(30000) + '</movie>'
  ];
  for (const x of evil) {
    assert.ok(x.length <= nfo.NFO_MAX);
    const t0 = performance.now();
    const r = nfo.parseNfo(x, 'movie');
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${x.slice(0, 30)}… tog ${Math.round(ms)} ms`);
    if (r) assert.ok(JSON.stringify(r).length < 200000);
  }
  assert.ok(nfo.parseNfo(evil[5], 'movie').genres.length <= 60, 'begränsat antal genrer');
});

// ---------------- skanning mot riktiga filer ----------------
const vid = (f, extra = []) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '1', ...extra, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
};
const pic = (f, size = '300x450', src = 'testsrc') => { fs.mkdirSync(path.dirname(f), { recursive: true }); execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `${src}=size=${size}`, '-frames:v', '1', f]); };
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

let D, scanner, B, tok, srv;
const LAN = { 'x-forwarded-for': '192.168.1.20' };
async function req(p, { method = 'GET', body } = {}) {
  const h = { ...LAN, authorization: `Bearer ${tok}` };
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const item = (where, ...p) => D.get(`SELECT * FROM items WHERE ${where}`, ...p);
const F1 = path.join(MEDIA, 'Filmer'), F2 = path.join(MEDIA, 'Filmer på NAS'), SER = path.join(MEDIA, 'Serier'), HV = path.join(MEDIA, 'Hemvideo');
const ids = {};

test('förbered mediafiler och server', { skip: !hasFfmpeg }, async () => {
  vid(path.join(F1, 'Rear Window (1954)', 'Rear Window (1954).mp4'));
  write(path.join(F1, 'Rear Window (1954)', 'movie.nfo'), MOVIE_NFO);
  pic(path.join(F1, 'Rear Window (1954)', 'poster.png'), '400x600');
  pic(path.join(F1, 'Rear Window (1954)', 'fanart.jpg'), '1280x720');
  // Två filmer i samma mapp: allmänna namn (poster.jpg) gäller ingen av dem, <film>-poster.jpg gäller sin film
  vid(path.join(F1, 'Blandat', 'Alfa (2001).mp4'));
  fs.copyFileSync(path.join(F1, 'Blandat', 'Alfa (2001).mp4'), path.join(F1, 'Blandat', 'Beta (2002).mp4'));
  pic(path.join(F1, 'Blandat', 'poster.jpg'));
  pic(path.join(F1, 'Blandat', 'Alfa (2001)-poster.jpg'), '300x450', 'testsrc2');
  // Andra mappen: IMDb-id i <film>.nfo (matchas via TMDB:s /find)
  vid(path.join(F2, 'Heat (1995).mp4'));
  write(path.join(F2, 'Heat (1995).nfo'), '<movie><uniqueid type="imdb">tt0113277</uniqueid><plot>Egen beskrivning</plot></movie>');
  // Serie med tvshow.nfo, avsnitts-NFO, affischer och miniatyr
  vid(path.join(SER, 'Bron', 'Season 1', 'Bron S01E01.mp4'));
  write(path.join(SER, 'Bron', 'tvshow.nfo'), '<tvshow><title>Bron</title><uniqueid type="tmdb">1408</uniqueid><mpaa>SE:15</mpaa><genre>Kriminal</genre></tvshow>');
  write(path.join(SER, 'Bron', 'Season 1', 'Bron S01E01.nfo'), '<episodedetails><title>Liket på bron</title><season>1</season><episode>1</episode><plot>Ett lik på gränsen.</plot></episodedetails>');
  pic(path.join(SER, 'Bron', 'poster.jpg'));
  pic(path.join(SER, 'Bron', 'season01-poster.jpg'));
  pic(path.join(SER, 'Bron', 'Season 1', 'Bron S01E01-thumb.jpg'), '640x360');
  // Hemvideor: datum ur creation_time, annars filens tid; mappar i flera nivåer
  vid(path.join(HV, '2023', 'Midsommar', 'dans_vid_stangen.mp4'), ['-metadata', 'creation_time=2023-06-24T14:00:00Z']);
  vid(path.join(HV, '2023', 'Jul', 'IMG_0001.mp4'), ['-metadata', 'creation_time=2023-12-24T15:00:00Z']);
  vid(path.join(HV, '2024', 'IMG_0001.mp4'), ['-metadata', 'creation_time=2024-05-01T10:00:00Z']);
  vid(path.join(HV, 'lös fil.mp4'));

  D = await import('../server/db.js');
  scanner = await import('../server/scanner.js');
  const auth = await import('../server/auth.js');
  const app = await import('../server/app.js');
  srv = http.createServer(app.handle);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  B = `http://127.0.0.1:${srv.address().port}`;
  const r = await fetch(B + '/api/setup', { method: 'POST', headers: { ...LAN, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: 'Långt-lösen-123!' }) });
  assert.equal(r.status, 200);
  tok = auth.createSession(D.get("SELECT id FROM users WHERE name='admin'").id, 'app');
});
after(() => { srv?.close(); fake.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('filmbibliotek med två mappar: NFO före TMDB, exakt TMDB-id, lokala bilder', { skip: !hasFfmpeg }, async () => {
  const r = await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', paths: [F1, F2] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ids.movies = r.data.id;
  await scanner.scan(ids.movies);
  const rw = item("path LIKE '%Rear Window (1954).mp4'");
  assert.equal(rw.title, 'Fönstret mot gården', 'NFO:ns titel går före TMDB:s');
  assert.equal(rw.sort_title, 'fonstret mot garden');
  assert.equal(rw.original_title, 'Rear Window');
  assert.equal(rw.tmdb_id, 567, 'exakt matchning på NFO:ns TMDB-id');
  assert.ok(hits.includes('/3/movie/567'));
  assert.ok(!hits.some(h => h.startsWith('/3/search/movie')) || !hits.includes('/3/search/movie?query=Rear'), 'ingen sökning behövdes');
  assert.equal(rw.overview, 'En fotograf i rullstol spionerar på grannarna.');
  assert.equal(rw.rating, 8.5);
  assert.equal(rw.age, 11); assert.equal(rw.cert, 'SE:11');
  assert.deepEqual(JSON.parse(rw.genres), ['Thriller', 'Mysterium', 'Drama']);
  assert.equal(rw.studio, 'Paramount');
  assert.equal(rw.imdb_id, 'tt0047396');
  assert.equal(rw.premiered, '1954-08-01');
  assert.equal(rw.poster, 1); assert.equal(rw.backdrop, 1);
  const IM = path.join(process.env.CONFIG_DIR, 'images');
  assert.ok(fs.statSync(path.join(IM, `${rw.id}-poster.jpg`)).size > 1000, 'poster.png konverterad till jpg');
  const local = JSON.parse(rw.local_img);
  assert.ok(local.poster.includes('poster.png') && local.backdrop.includes('fanart.jpg'));
  // Bilden går att hämta i mindre storlek och får en platshållarfärg
  const im = await req(`/api/image/${rw.id}/poster?w=240`);
  assert.equal(im.status, 200);
  const { fillAll } = await import('../server/imgcolor.js');
  await fillAll();
  assert.match(item('id=?', rw.id).poster_color, /^#[0-9a-f]{6}$/);
  // Rollistan i NFO:n används inte när TMDB har matchat (TMDB:s rollista gäller)
  // Två filmer i samma mapp: bara den egna <film>-poster.jpg
  const alfa = item("path LIKE '%Alfa (2001).mp4'"), beta = item("path LIKE '%Beta (2002).mp4'");
  assert.equal(alfa.poster, 1); assert.ok(JSON.parse(alfa.local_img).poster.includes('Alfa (2001)-poster.jpg'));
  assert.equal(beta.local_img, null, 'poster.jpg i en delad mapp hör inte till någon film');
  // Andra mappen: IMDb-id → TMDB /find → 949; NFO:ns beskrivning går före
  const heat = item("path LIKE '%Heat (1995).mp4'");
  assert.equal(heat.tmdb_id, 949); assert.equal(heat.overview, 'Egen beskrivning'); assert.equal(heat.title, 'Heat');
});

test('/api/libraries: samma fält för apparna (id, name, type, count), nya fält är tillägg', { skip: !hasFfmpeg }, async () => {
  const r = await req('/api/libraries');
  const l = r.data.find(x => x.id === ids.movies);
  assert.equal(typeof l.id, 'number'); assert.equal(l.name, 'Filmer'); assert.equal(l.type, 'movie'); assert.equal(typeof l.count, 'number');
  assert.equal(l.count, 4);
  assert.equal(l.path, F1, 'path = första mappen (bakåtkompatibelt)');
  assert.deepEqual(l.paths, [F1, F2]);
  assert.equal(l.nfo, 1); assert.equal(l.home_video, 0);
  // Kontraktet för apparna
  const contract = JSON.parse(fs.readFileSync(new URL('./contracts/apps.json', import.meta.url), 'utf8'));
  const types = { integer: (v) => Number.isInteger(v), string: (v) => typeof v === 'string', number: (v) => typeof v === 'number', boolean: (v) => typeof v === 'boolean' };
  for (const app of ['Library.ios', 'Library.android']) {
    const sch = contract.typer[app];
    assert.ok(sch, app);
    for (const [k, t] of Object.entries(sch.required)) assert.ok(types[t](l[k]), `${app}.${k}`);
    for (const [k, t] of Object.entries(sch.optional || {})) if (l[k] != null) assert.ok(types[t](l[k]), `${app}.${k}`);
  }
});

test('en saknad mapp tar aldrig bort något – varken i den eller i de andra mapparna', { skip: !hasFfmpeg }, async () => {
  const before = D.all('SELECT id, path FROM items WHERE library_id=? ORDER BY id', ids.movies);
  // Disken med andra mappen är avmonterad
  fs.renameSync(F2, F2 + '.borta');
  // ... och en film i första mappen tas bort på riktigt
  fs.rmSync(path.join(F1, 'Blandat', 'Beta (2002).mp4'));
  await scanner.scan(ids.movies);
  const now = D.all('SELECT id, path FROM items WHERE library_id=? ORDER BY id', ids.movies);
  assert.ok(now.some(r => r.path.endsWith('Heat (1995).mp4')), 'titeln på den saknade disken finns kvar');
  assert.ok(!now.some(r => r.path.endsWith('Beta (2002).mp4')), 'borttagen fil i en läsbar mapp tas bort som vanligt');
  assert.equal(now.length, before.length - 1);
  assert.ok(scanner.status.warnings.some(w => w.includes(F2)), scanner.status.warnings.join(' | '));
  // NFO och bilder i den saknade mappen glöms inte
  assert.equal(item("path LIKE '%Heat (1995).mp4'").overview, 'Egen beskrivning');
  // Tom monteringspunkt (mappen finns men är tom): inget tas bort
  fs.mkdirSync(F2);
  await scanner.scan(ids.movies);
  assert.ok(item("path LIKE '%Heat (1995).mp4'"), 'tom mapp tar inte bort något');
  fs.rmdirSync(F2); fs.renameSync(F2 + '.borta', F2);
  await scanner.scan(ids.movies);
  assert.equal(D.all('SELECT id FROM items WHERE library_id=?', ids.movies).length, before.length - 1);
});

test('raderingsskyddet >50 % gäller per mapp', { skip: !hasFfmpeg }, async () => {
  const src = path.join(F2, 'Heat (1995).mp4');
  const many = path.join(F2, 'Många');
  fs.mkdirSync(many, { recursive: true });
  for (let i = 1; i <= 22; i++) fs.copyFileSync(src, path.join(many, `Film ${i} (${1950 + i}).mp4`));
  await scanner.scan(ids.movies);
  const inMany = () => D.get('SELECT COUNT(*) AS n FROM items WHERE library_id=? AND path LIKE ?', ids.movies, `${many}/%`).n;
  assert.equal(inMany(), 22);
  // 15 av 23 titlar i andra mappen försvinner: spärras där – men en borttagning i första mappen går igenom
  for (let i = 1; i <= 15; i++) fs.rmSync(path.join(many, `Film ${i} (${1950 + i}).mp4`));
  fs.rmSync(path.join(F1, 'Blandat', 'Alfa (2001).mp4'));
  await scanner.scan(ids.movies);
  assert.equal(inMany(), 22, 'mappen där mer än hälften saknas: inget tas bort');
  assert.ok(!item("path LIKE '%Alfa (2001).mp4'"), 'den andra mappen påverkas inte av spärren');
  assert.ok(scanner.status.warnings.some(w => w.includes('saknas') && w.includes(F2)), scanner.status.warnings.join(' | '));
  // Tillåtet i inställningarna: då tas de bort
  fs.rmSync(many, { recursive: true, force: true });
  D.setSetting('scan_allow_mass_delete', '1');
  await scanner.scan(ids.movies);
  D.setSetting('scan_allow_mass_delete', '0');
  assert.equal(inMany(), 0);
});

test('ändrad NFO och bild läses om (ändringstid); borttagen NFO ger TMDB:s värden igen', { skip: !hasFfmpeg }, async () => {
  const dir = path.join(F1, 'Rear Window (1954)');
  const rw = () => item("path LIKE '%Rear Window (1954).mp4'");
  const oldSig = JSON.parse(rw().local_img).poster;
  write(path.join(dir, 'movie.nfo'), MOVIE_NFO.replace('Fönstret mot gården', 'Fönstret mot gården (restaurerad)'));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'movie.nfo'), later, later);
  pic(path.join(dir, 'poster.png'), '500x750', 'testsrc2');
  fs.utimesSync(path.join(dir, 'poster.png'), later, later);
  await scanner.scan(ids.movies);
  assert.equal(rw().title, 'Fönstret mot gården (restaurerad)');
  assert.notEqual(JSON.parse(rw().local_img).poster, oldSig, 'ny bild → ny signatur');
  assert.equal(rw().poster_color, null, 'platshållarfärgen räknas om');
  // NFO:n tas bort: nästa matchning ger TMDB:s titel
  fs.rmSync(path.join(dir, 'movie.nfo'));
  await scanner.scan(ids.movies);
  assert.equal(rw().nfo, null);
  assert.equal(rw().title, 'Rear Window');
  assert.equal(rw().overview, 'Från TMDB');
  // poster.png bort: den lokala affischen glöms (TMDB har ingen här)
  fs.rmSync(path.join(dir, 'poster.png'));
  await scanner.scan(ids.movies);
  assert.equal(rw().poster, 0);
  assert.ok(!JSON.parse(rw().local_img || '{}').poster);
  write(path.join(dir, 'movie.nfo'), MOVIE_NFO);
  await scanner.scan(ids.movies);
  assert.equal(rw().title, 'Fönstret mot gården');
});

test('serie: tvshow.nfo, avsnitts-NFO, affisch, säsongsaffisch och miniatyr före TMDB', { skip: !hasFfmpeg }, async () => {
  const r = await req('/api/libraries', { method: 'POST', body: { name: 'Serier', type: 'show', path: SER } });
  assert.equal(r.status, 200);
  ids.shows = r.data.id;
  await scanner.scan(ids.shows);
  const show = item("library_id=? AND kind='show'", ids.shows), ep = item("library_id=? AND kind='episode'", ids.shows);
  assert.equal(show.tmdb_id, 1408);
  assert.equal(show.title, 'Bron', 'NFO:ns titel före TMDB:s "The Bridge"');
  assert.equal(show.age, 15);
  assert.deepEqual(JSON.parse(show.genres), ['Kriminal']);
  assert.equal(show.poster, 1);
  assert.equal(ep.title, 'Liket på bron', 'avsnittets NFO före TMDB:s avsnittsnamn');
  assert.equal(ep.overview, 'Ett lik på gränsen.');
  assert.equal(ep.thumb, 1);
  assert.ok(JSON.parse(ep.local_img).thumb.includes('Bron S01E01-thumb.jpg'));
  const d = await req(`/api/items/${show.id}`);
  assert.deepEqual(d.data.seasonPosters, [1]);
  const sp = await req(`/api/image/${show.id}/season1`);
  assert.equal(sp.status, 200); assert.ok(sp.data.length > 500);
  assert.equal((await req(`/api/image/${show.id}/season2`)).status, 404);
  assert.equal((await req(`/api/image/${show.id}/season1x`)).status, 404);
});

test('hemvideor: ingen TMDB, titel från filnamnet, datum från filen, mappar som navigering, sortering på datum', { skip: !hasFfmpeg }, async () => {
  const before = hits.length;
  const r = await req('/api/libraries', { method: 'POST', body: { name: 'Hemvideo', type: 'movie', path: HV, homeVideo: true } });
  assert.equal(r.status, 200);
  ids.home = r.data.id;
  await scanner.scan(ids.home);
  assert.equal(hits.slice(before).filter(h => h.includes('/search/') || h.includes('/movie/')).length, 0, 'ingen TMDB för hemvideor');
  const dans = item("path LIKE '%dans_vid_stangen.mp4'");
  assert.equal(dans.title, 'dans vid stangen');
  assert.equal(dans.taken, Date.UTC(2023, 5, 24, 14) / 1000, 'creation_time');
  assert.equal(dans.year, 2023);
  assert.equal(dans.folder, path.join('2023', 'Midsommar'));
  // Två klipp med samma namn i olika mappar blir inte versioner av varandra
  assert.equal(D.get("SELECT COUNT(*) AS n FROM items WHERE library_id=? AND title='IMG 0001' AND version_of IS NULL", ids.home).n, 2);
  const loose = item("path LIKE '%lös fil.mp4'");
  assert.equal(loose.folder, '');
  assert.ok(loose.taken > Date.now() / 1000 - 3600, 'utan tagg: filens tid');
  // Roten: lösa klipp + mapparna 2023 och 2024
  const root = await req(`/api/libraries/${ids.home}/items?folder=&sort=date`);
  assert.equal(root.status, 200);
  assert.deepEqual(root.data.items.map(i => i.title), ['lös fil']);
  assert.deepEqual(root.data.folders.map(f => [f.name, f.count]), [['2024', 1], ['2023', 2]], 'senaste mappen först');
  assert.equal(root.data.folder, '');
  const y = await req(`/api/libraries/${ids.home}/items?folder=2023&sort=title`);
  assert.deepEqual(y.data.items, []);
  assert.deepEqual(y.data.folders.map(f => [f.name, f.path, f.count]), [['Jul', '2023/Jul', 1], ['Midsommar', '2023/Midsommar', 1]]);
  const m = await req(`/api/libraries/${ids.home}/items?folder=${encodeURIComponent('2023/Midsommar')}`);
  assert.deepEqual(m.data.items.map(i => i.title), ['dans vid stangen']);
  assert.equal(m.data.items[0].taken, dans.taken);
  assert.equal((await req(`/api/libraries/${ids.home}/items?folder=..%2F..`)).status, 400);
  // Utan ?folder= (apparna): hela biblioteket som förut, sorterat på datum
  const all = await req(`/api/libraries/${ids.home}/items?sort=date`);
  assert.equal(all.data.items.length, 4); assert.equal(all.data.folders, undefined);
  assert.deepEqual(all.data.items.slice(1).map(i => i.title), ['IMG 0001', 'IMG 0001', 'dans vid stangen']);
  // En flyttad fil (samma storlek) behåller framsteget
  const uid = D.get("SELECT id FROM users WHERE name='admin'").id;
  D.run('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,?,?)', uid, dans.id, 0.5, 1, 0, D.now());
  fs.mkdirSync(path.join(HV, '2023', 'Sommar'));
  fs.renameSync(dans.path, path.join(HV, '2023', 'Sommar', 'dans_vid_stangen.mp4'));
  await scanner.scan(ids.home);
  const moved = item("path LIKE '%Sommar/dans_vid_stangen.mp4'");
  assert.ok(moved);
  const main = moved.version_of ?? moved.id;
  assert.equal(D.get('SELECT position FROM progress WHERE user_id=? AND item_id=?', uid, main)?.position, 0.5);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM items WHERE library_id=? AND version_of IS NULL', ids.home).n, 4);
});

test('administration: lägg till och ta bort mappar, byt namn, NFO av – en borttagen mapp tar bara bort sina titlar', { skip: !hasFfmpeg }, async () => {
  for (const [body, re] of [[{ paths: [] }, /minst en mapp/], [{ paths: [F1, path.join(F1, 'Blandat')] }, /ligger i/], [{ paths: ['/etc'] }, /under/],
    [{ addPath: path.join(MEDIA, 'finns-inte') }, /under/]]) {
    const r = await req(`/api/libraries/${ids.movies}`, { method: 'PUT', body });
    assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.data.error, re);
  }
  const extra = path.join(MEDIA, 'Extra filmer');
  vid(path.join(extra, 'Ny film (2020).mp4'));
  let r = await req(`/api/libraries/${ids.movies}`, { method: 'PUT', body: { addPath: extra, name: 'Alla filmer' } });
  assert.equal(r.status, 200); assert.deepEqual(r.data.paths, [F1, F2, extra]);
  await scanner.scan(ids.movies);
  assert.ok(item("path LIKE '%Ny film (2020).mp4'"));
  const L = (await req('/api/libraries')).data.find(l => l.id === ids.movies);
  assert.equal(L.name, 'Alla filmer'); assert.deepEqual(L.paths, [F1, F2, extra]);
  // Ta bort andra mappen: bara dess titlar försvinner (filerna finns kvar på disken)
  r = await req(`/api/libraries/${ids.movies}`, { method: 'PUT', body: { paths: [extra, F1] } });
  assert.equal(r.status, 200);
  assert.ok(!item("path LIKE '%Heat (1995).mp4'"));
  assert.ok(fs.existsSync(path.join(F2, 'Heat (1995).mp4')));
  assert.ok(item("path LIKE '%Rear Window (1954).mp4'") && item("path LIKE '%Ny film (2020).mp4'"));
  assert.equal(D.get('SELECT path FROM libraries WHERE id=?', ids.movies).path, extra, 'libraries.path = första mappen');
  await scanner.scan(ids.movies);
  assert.ok(!item("path LIKE '%Heat (1995).mp4'"), 'skanningen läser inte den borttagna mappen');
  // NFO av: NFO-värdena glöms och TMDB:s gäller
  assert.equal(item("path LIKE '%Rear Window (1954).mp4'").title, 'Fönstret mot gården');
  r = await req(`/api/libraries/${ids.movies}`, { method: 'PUT', body: { nfo: false } });
  assert.equal(r.status, 200);
  await scanner.scan(ids.movies);
  const rw = item("path LIKE '%Rear Window (1954).mp4'");
  assert.equal(rw.nfo, null); assert.equal(rw.title, 'Rear Window');
  assert.ok(D.all("SELECT detail FROM audit WHERE event='library_changed'").some(a => a.detail.includes('NFO av')));
});
