// Metadata och kapitel för ljudböcker från nätet (bookmeta.js) mot en låtsasserver i stället för Google Books,
// Open Library och Audnexus: matchning (svenska först), reserv, kapitel med längdkontroll, omslag, "Fel bok?" med låsning,
// redigering för hand och att matchade böcker inte hämtas om.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-bookmeta-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.BOOK_META_GAP_MS = '0';
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);

// ---------- låtsasserver ----------
const log = [];
let base = '', cover = Buffer.alloc(0), googleDown = false;
const json = (r, v, code = 200) => { r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(v)); };
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  log.push(u.pathname + u.search);
  if (u.pathname === '/gb/volumes') {
    if (googleDown) return json(r, { error: 'nej' }, 503);
    const s = u.searchParams.get('q') || '';
    // Mio finns bara bland svenska böcker (langRestrict=sv), så att testet ser att den sökningen görs först
    if (/Mio/.test(s) && u.searchParams.get('langRestrict') === 'sv') return json(r, { items: [
      { id: 'fel1', volumeInfo: { title: 'Mio min Mio – lärarhandledning', authors: ['Någon Annan'] } },
      { id: 'mio1', volumeInfo: { title: 'Mio, min Mio', authors: ['Astrid Lindgren'], publishedDate: '1954' } }] });
    if (/Bröderna/.test(s)) return json(r, { items: [{ id: 'bro1', volumeInfo: { title: 'Bröderna Lejonhjärta', authors: ['Astrid Lindgren'] } }] });
    return json(r, { totalItems: 0 });
  }
  if (u.pathname === '/gb/volumes/mio1') return json(r, { id: 'mio1', volumeInfo: { title: 'Mio, min Mio', authors: ['Astrid Lindgren'], publisher: 'Rabén & Sjögren',
    publishedDate: '1954-01-01', description: '<p>Bo Vilhelm Olsson blir <b>Mio</b>.</p>', industryIdentifiers: [{ type: 'ISBN_13', identifier: '9789129688313' }],
    categories: ['Fiction / Fantasy'], language: 'sv', imageLinks: { thumbnail: `${base}/img/mio.jpg` } } });
  if (u.pathname === '/gb/volumes/bro1') return json(r, { id: 'bro1', volumeInfo: { title: 'Bröderna Lejonhjärta', authors: ['Astrid Lindgren'], publishedDate: '1973', description: 'Om Nangijala.' } });
  if (u.pathname === '/ol/search.json') {
    if (/Okänd/i.test(u.searchParams.get('title') || '') || /OL7W/.test(u.searchParams.get('q') || ''))
      return json(r, { docs: [{ key: '/works/OL7W', title: 'Okänd bok', author_name: ['Selma Lagerlöf'], first_publish_year: 1891, publisher: ['Bonniers'], isbn: ['9789100000000'], subject: ['Sagor'] }] });
    return json(r, { docs: [] });
  }
  if (u.pathname === '/ol/works/OL7W.json') return json(r, { title: 'Okänd bok', description: { value: 'Beskrivning från Open Library.' } });
  if (u.pathname === '/ax/books/B0TESTASIN') return json(r, { asin: 'B0TESTASIN', title: 'Kapitelboken', authors: [{ name: 'Selma Lagerlöf' }], narrators: [{ name: 'Uppläsaren Ett' }],
    seriesPrimary: { name: 'Testserien', position: 'Book 2' }, summary: '<p>Från Audnexus.</p>', releaseDate: '2001-02-03', genres: [{ name: 'Klassiker', type: 'genre' }] });
  if (u.pathname === '/ax/books/B0TESTASIN/chapters') return json(r, { runtimeLengthMs: 8000, chapters: [
    { title: 'Början', startOffsetMs: 0, lengthMs: 4000 }, { title: 'Slutet', startOffsetMs: 4000, lengthMs: 4000 }] });
  // Fel längd: 20 s mot bokens 8 s – kapitlen får inte användas
  if (u.pathname === '/ax/books/B0LANGASIN/chapters') return json(r, { runtimeLengthMs: 20000, chapters: [
    { title: 'A', startOffsetMs: 0, lengthMs: 10000 }, { title: 'B', startOffsetMs: 10000, lengthMs: 10000 }] });
  if (u.pathname === '/img/mio.jpg') { r.writeHead(200, { 'Content-Type': 'image/jpeg' }); return r.end(cover); }
  r.writeHead(404); r.end();
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${srv.address().port}`;
process.env.GOOGLE_BOOKS_URL = base + '/gb';
process.env.OPENLIBRARY_URL = base + '/ol';
process.env.AUDNEXUS_URL = base + '/ax';
process.env.AUDIBLE_URL = base + '/au'; // svarar 404 = inga träffar hos Audible
process.env.OPENLIBRARY_COVERS_URL = base + '/olc';

const { run, get, setSetting } = await import('../server/db.js');
const books = await import('../server/audiobooks.js');
const meta = await import('../server/bookmeta.js');
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('titlar för sökning, svenska och poäng', () => {
  assert.equal(meta.cleanTitle('01 - Mio min Mio (uppläst av Astrid Lindgren) [Oförkortad]'), 'Mio min Mio');
  assert.equal(meta.cleanTitle('Bröderna Lejonhjärta - Unabridged'), 'Bröderna Lejonhjärta');
  assert.ok(meta.looksSwedish('Mio min Mio')); assert.ok(meta.looksSwedish('Bröderna')); assert.ok(!meta.looksSwedish('The Hobbit'));
  const c = { title: 'Mio, min Mio', authors: ['Astrid Lindgren'] };
  assert.ok(meta.score(c, 'Mio min Mio', 'Astrid Lindgren') >= meta.GOOD);
  // Rätt titel men fel författare räcker inte
  assert.ok(meta.score({ ...c, authors: ['Någon Annan'] }, 'Mio min Mio', 'Astrid Lindgren') < meta.GOOD);
  assert.ok(meta.asinOk('B0036UF9BS')); assert.ok(!meta.asinOk('kort'));
  assert.equal(meta.coverUrlOk('http://books.google.com/books/content?id=x'), 'https://books.google.com/books/content?id=x');
  assert.equal(meta.coverUrlOk('https://evil.example/x.jpg'), null);
  assert.equal(meta.coverUrlOk('https://books.google.com:8443/x'), null);
});

let LIB, ids = {};
before(async () => {
  if (!hasFfmpeg) return;
  cover = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=300x400', '-frames:v', '1', '-f', 'mjpeg', 'pipe:1']);
  const lib = path.join(ROOT, 'books');
  const mk = (dir, name, meta_) => { fs.mkdirSync(dir, { recursive: true }); ff('-f', 'lavfi', '-i', 'sine=frequency=400:duration=8', ...meta_.flatMap(m => ['-metadata', m]), path.join(dir, name)); };
  mk(path.join(lib, 'Astrid Lindgren', 'Mio min Mio'), 'mio.mp3', ['album=Mio min Mio', 'artist=Astrid Lindgren']);
  mk(path.join(lib, 'Selma Lagerlöf', 'Okänd bok'), 'bok.mp3', ['album=Okänd bok', 'artist=Selma Lagerlöf']);
  mk(path.join(lib, 'Selma Lagerlöf', 'Kapitelboken'), 'kap.mp3', ['album=Kapitelboken', 'artist=Selma Lagerlöf', 'asin=B0TESTASIN']);
  mk(path.join(lib, 'Selma Lagerlöf', 'Långa boken'), 'lang.mp3', ['album=Långa boken', 'artist=Selma Lagerlöf', 'asin=B0LANGASIN']);
  mk(path.join(lib, 'Ingen', 'Finns inte alls'), 'x.mp3', ['album=Finns inte alls', 'artist=Ingen Alls']);
  run("INSERT INTO libraries(id,name,type,path) VALUES(9,'Böcker','audiobook',?)", lib);
  LIB = get('SELECT * FROM libraries WHERE id=9');
  await books.scanBooks(LIB, {});
  for (const b of books.listBooks(9, 1)) ids[b.title] = b.id;
});

test('bakgrundsmatchning: Google (svenska först), Open Library som reserv, Audnexus via ASIN', { skip: !hasFfmpeg }, async () => {
  await meta.queue(9);
  // Svenska titlar söks först med langRestrict=sv
  const first = log.find(l => l.startsWith('/gb/volumes?') && /Mio/.test(decodeURIComponent(l)));
  assert.match(first, /langRestrict=sv/);
  const mio = books.book(ids['Mio min Mio'], 1);
  assert.equal(mio.title, 'Mio min Mio');               // titel och författare från filen
  assert.equal(mio.description, 'Bo Vilhelm Olsson blir Mio.');
  assert.equal(mio.year, 1954); assert.equal(mio.publisher, 'Rabén & Sjögren'); assert.equal(mio.isbn, '9789129688313');
  assert.deepEqual(mio.genres, ['Fiction', 'Fantasy']);
  assert.equal(mio.meta.source, 'google'); assert.equal(mio.meta.sourceId, 'mio1'); assert.equal(mio.meta.locked, false);
  assert.equal(mio.cover, true, 'omslaget hämtades eftersom boken saknade eget');
  assert.ok(fs.existsSync(books.coverPath(mio.id)));
  // Reserv: Open Library när Google saknar boken
  const okand = books.book(ids['Okänd bok'], 1);
  assert.equal(okand.meta.source, 'openlibrary'); assert.equal(okand.description, 'Beskrivning från Open Library.'); assert.equal(okand.year, 1891);
  // ASIN i taggen: Audnexus ger uppläsare, serie och kapitel (längden stämmer)
  const kap = books.book(ids['Kapitelboken'], 1);
  assert.equal(kap.meta.source, 'audnexus'); assert.equal(kap.narrator, 'Uppläsaren Ett');
  assert.equal(kap.series, 'Testserien'); assert.equal(kap.seriesNo, '2'); assert.equal(kap.asin, 'B0TESTASIN');
  assert.equal(kap.chapterSource, 'audnexus'); assert.deepEqual(kap.chapters.map(c => c.title), ['Början', 'Slutet']);
  // Fel längd (±2 %): filens kapitel behålls
  const lang = books.book(ids['Långa boken'], 1);
  assert.equal(lang.chapterSource, 'fil'); assert.equal(lang.chapters.length, 1);
  // Ingen träff: state 2
  assert.equal(get('SELECT state FROM book_meta WHERE book_id=?', ids['Finns inte alls']).state, 2);
  // Nya fält i listan (tillägg)
  const l = books.listBooks(9, 1, 'series');
  assert.equal(l[0].series, 'Testserien');
  // Matchade och ej hittade böcker hämtas inte om vid nästa skanning
  const n = log.length;
  await meta.queue(9);
  assert.equal(log.length, n);
});

test('"Fel bok?": sök, välj och lås – lås upp ger automatisk matchning igen', { skip: !hasFfmpeg }, async () => {
  const id = ids['Mio min Mio'];
  const res = await meta.search('Bröderna Lejonhjärta', 'Astrid Lindgren');
  assert.ok(res.some(x => x.source === 'google' && x.id === 'bro1'));
  assert.equal(await meta.matchManual(id, 'google', 'bro1'), true);
  let b = books.book(id, 1);
  assert.equal(b.meta.locked, true); assert.equal(b.description, 'Om Nangijala.'); assert.equal(b.year, 1973);
  assert.equal(b.title, 'Mio min Mio');
  // Låst: körs inte om
  const n = log.length; await meta.queue(9); assert.equal(log.length, n);
  // Okänd träff hos källan
  assert.equal(await meta.matchManual(id, 'google', 'finnsinte'), false);
  // ASIN direkt i sökningen
  assert.equal((await meta.search('B0TESTASIN', ''))[0].source, 'audnexus');
  meta.unlock(id);
  await meta.queue(9);
  b = books.book(id, 1);
  assert.equal(b.meta.locked, false); assert.equal(b.meta.sourceId, 'mio1');
});

test('redigering för hand går före filen och källan, även efter omskanning', { skip: !hasFfmpeg }, async () => {
  const id = ids['Okänd bok'];
  await meta.edit(id, { title: 'Ett nytt namn', narrator: 'Läsaren', description: '', series: 'Sagorna', seriesNo: '3', genres: 'Saga, Klassiker' });
  let b = books.book(id, 1);
  assert.equal(b.title, 'Ett nytt namn'); assert.equal(b.narrator, 'Läsaren'); assert.equal(b.description, null);
  assert.equal(b.series, 'Sagorna'); assert.equal(b.seriesNo, '3'); assert.deepEqual(b.genres, ['Saga', 'Klassiker']);
  assert.deepEqual(b.meta.edited.sort(), ['description', 'genres', 'narrator', 'series', 'seriesNo', 'title']);
  await assert.rejects(meta.edit(id, { year: 'förra året' }), /Året/);
  await assert.rejects(meta.edit(id, { asin: '123' }), /ASIN/);
  // Omskanning med ändrad fil skriver om books-raden – ändringarna står kvar
  const f = get('SELECT path FROM book_files WHERE book_id=?', id).path;
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  await books.scanBooks(LIB, {});
  b = books.book(id, 1);
  assert.equal(b.title, 'Ett nytt namn'); assert.equal(b.narrator, 'Läsaren');
  // null tar bort ändringen: källans beskrivning gäller igen
  await meta.edit(id, { description: null });
  assert.equal(books.book(id, 1).description, 'Beskrivning från Open Library.');
  // Nytt ASIN för hand: kapitel från Audnexus
  await meta.edit(id, { asin: 'B0TESTASIN' });
  b = books.book(id, 1);
  assert.equal(b.chapterSource, 'audnexus'); assert.equal(b.asin, 'B0TESTASIN');
  await meta.edit(id, { asin: '' });
  assert.equal(books.book(id, 1).chapterSource, 'fil');
});

test('avstängd i inställningarna och fel hos källan', { skip: !hasFfmpeg }, async () => {
  setSetting('book_meta', '0');
  run('UPDATE book_meta SET state=0, locked=0');
  const n = log.length; await meta.queue(9); assert.equal(log.length, n, 'inga anrop när funktionen är avstängd');
  setSetting('book_meta', '1');
  // Google svarar fel: kön avbryts efter några fel och böckerna markeras inte som "ingen träff"
  meta.clearCache(); googleDown = true;
  await meta.queue(9);
  googleDown = false;
  assert.ok(meta.status.error);
  assert.ok(get('SELECT COUNT(*) AS n FROM book_meta WHERE state=0').n >= 1);
});
