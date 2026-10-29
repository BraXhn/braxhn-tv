// Ljudböckernas verktyg mot en riktig server: privata RSS-flöden (XML, enclosure med Range, kapitel som Podcasting 2.0
// JSON, nyckeln gäller bara /api/feeds/*, återkallning, barnprofiler nekas), kapitelredigeraren (spara utan att skriva om
// filen, Audnexus via ASIN, skriv in i M4B med ångra), sammanslagning av MP3 till M4B (papperskorg, samma bok-id och
// position), metadatasökning i Audible (låtsasserver), lyssningsstatistik och jämn ljudnivå för tal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { parseXml, find, kids, textOf } from '../server/ebooks/xml.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const st = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-booktools-'));
const MEDIA = path.join(ROOT, 'media'), LIB = path.join(MEDIA, 'Ljudböcker'), CONFIG = path.join(ROOT, 'config');
const PORT = 21000 + Math.floor(Math.random() * 20000), B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
// Strikt kontroll av XML:en med xmllint när det finns (libxml2), annars bara den egna tolken
const hasXmllint = spawnSync('xmllint', ['--version']).status === 0;
const wellFormed = (xml) => { if (hasXmllint) { const r = spawnSync('xmllint', ['--noout', '-'], { input: xml }); assert.equal(r.status, 0, r.stderr.toString()); } };
const chaptersOf = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_chapters', f]).toString()).chapters.map(c => c.tags?.title);

// ---------- låtsasserver för Audible och Audnexus ----------
const json = (r, v, code = 200) => { r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(v)); };
const meta = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/au/1.0/catalog/products') {
    if (/Bok Ett/i.test(u.searchParams.get('title') || '')) return json(r, { products: [{ asin: 'B0BOKETT01', title: 'Bok Ett', authors: [{ name: 'Författaren' }],
      narrators: [{ name: 'Berättaren Bertil' }], series: [{ title: 'Testserien', sequence: '1' }], release_date: '2020-05-01', publisher_name: 'Förlaget', merchandising_summary: '<p>En bok.</p>' }] });
    return json(r, { products: [] });
  }
  if (u.pathname === '/ax/books/B0BOKETT01') return json(r, { asin: 'B0BOKETT01', title: 'Bok Ett', authors: [{ name: 'Författaren' }], narrators: [{ name: 'Berättaren Bertil' }],
    seriesPrimary: { name: 'Testserien', position: '1' }, summary: 'Från Audnexus.', releaseDate: '2020-05-01', genres: [{ name: 'Deckare', type: 'genre' }] });
  if (u.pathname === '/ax/books/B0BOKETT01/chapters') return json(r, { runtimeLengthMs: 12000, chapters: [
    { title: 'Öppning', startOffsetMs: 0, lengthMs: 5000 }, { title: 'Mitten', startOffsetMs: 5000, lengthMs: 4000 }, { title: 'Slut', startOffsetMs: 9000, lengthMs: 3000 }] });
  if (u.pathname.startsWith('/gb/volumes')) return json(r, { totalItems: 0 });
  if (u.pathname === '/ol/search.json') return json(r, { docs: [] });
  r.writeHead(404); r.end();
});
let srv, admin;
const S = {};
before(async () => {
  if (!hasFfmpeg) return;
  await new Promise(r => meta.listen(0, '127.0.0.1', r));
  const mb = `http://127.0.0.1:${meta.address().port}`;
  // Bok i två MP3-filer (slås ihop senare) och två M4B i samma mapp (en serie)
  const one = path.join(LIB, 'Författaren', 'Bok Ett'); fs.mkdirSync(one, { recursive: true });
  for (const n of [1, 2]) ff('-f', 'lavfi', '-i', `sine=frequency=${300 * n}:duration=6`, '-metadata', `title=Del ${n}`, '-metadata', 'album=Bok Ett', '-metadata', 'artist=Författaren', '-b:a', '64k', path.join(one, `0${n}.mp3`));
  const ser = path.join(LIB, 'Selma'); fs.mkdirSync(ser, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'ch.txt'), ';FFMETADATA1\ntitle=Saga A\nartist=Selma\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=4000\ntitle=Pojken\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=4000\nEND=8000\ntitle=Akka\n');
  ff('-f', 'lavfi', '-i', 'sine=frequency=500:duration=8', '-i', path.join(ROOT, 'ch.txt'), '-map', '0', '-map_metadata', '1', '-c:a', 'aac', '-b:a', '48k', '-f', 'mp4', path.join(ser, 'Saga A.m4b'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=600:duration=5', '-metadata', 'title=Saga B', '-metadata', 'artist=Selma', '-c:a', 'aac', '-b:a', '48k', '-f', 'mp4', path.join(ser, 'Saga B.m4b'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(PORT + 1), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'),
      TMDB_API_KEY: '', WATCH_FILES: '0', SCAN_INTERVAL: '0', BOOK_METADATA: '0', BOOK_META_GAP_MS: '0',
      AUDIBLE_URL: mb + '/au', AUDNEXUS_URL: mb + '/ax', GOOGLE_BOOKS_URL: mb + '/gb', OPENLIBRARY_URL: mb + '/ol', OPENLIBRARY_COVERS_URL: mb + '/olc' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  srv.stdout.on('data', () => {});
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); meta.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

async function req(p, { method = 'GET', body, tok = admin, cookie = '', headers = {} } = {}) {
  const h = { ...headers };
  if (tok && !cookie && !h.authorization) h.authorization = 'Bearer ' + tok;
  if (cookie) { h.cookie = cookie; h.origin = B; }
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(p.startsWith('http') ? p : B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  const data = /json/.test(ct) && !/chapters/.test(ct) ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
const webLogin = async (name, password) => (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: B }, body: JSON.stringify({ name, password }) })).headers.get('set-cookie').split(';')[0];
async function waitScan() {
  for (let i = 0; i < 240; i++) { await sleep(250); const s = (await req('/api/scan')).data; if (!s.running && !s.queued && s.last) return s; }
  throw new Error('skanningen blev inte klar');
}
/** Väntar tills bokens verktyg (kapitel in i filen, sammanslagning, ångra) är klart */
async function waitTool(id) {
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    const b = (await req(`/api/audiobooks/book/${id}`)).data;
    if (b.tools?.state && !b.tools.state.running) { assert.equal(b.tools.state.ok, true, b.tools.state.error); return b; }
  }
  throw new Error('verktyget blev inte klart');
}

st('skanning och metadatasökning i Audible (uppläsare, serie, nummer)', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = (await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, tok: '' })).data.token;
  const r = await req('/api/libraries', { method: 'POST', body: { name: 'Ljudböcker', type: 'audiobook', path: LIB } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); S.lib = r.data.id;
  await waitScan();
  const list = (await req(`/api/audiobooks/${S.lib}`)).data.books;
  assert.equal(list.length, 3);
  S.one = list.find(b => b.title === 'Bok Ett').id; S.a = list.find(b => b.title === 'Saga A').id; S.b = list.find(b => b.title === 'Saga B').id;
  const m = (await req(`/api/audiobooks/book/${S.one}/match?title=Bok%20Ett&author=F%C3%B6rfattaren`)).data;
  const hit = m.results.find(x => x.source === 'audible');
  assert.ok(hit, JSON.stringify(m));
  assert.deepEqual([hit.id, hit.narrators[0], hit.series, hit.seriesNo], ['B0BOKETT01', 'Berättaren Bertil', 'Testserien', '1']);
  const b = (await req(`/api/audiobooks/book/${S.one}/match`, { method: 'POST', body: { source: 'audible', id: hit.id } })).data;
  assert.deepEqual([b.narrator, b.series, b.seriesNo, b.asin, b.meta.source], ['Berättaren Bertil', 'Testserien', '1', 'B0BOKETT01', 'audible']);
  assert.deepEqual(b.genres, ['Deckare']); // detaljerna från Audnexus
  const tools = (await req(`/api/audiobooks/book/${S.one}`)).data.tools;
  assert.equal(tools.canMerge, true); assert.equal(tools.canEmbed, false);
});

st('kapitelredigeraren: spara utan att skriva om filen, Audnexus via ASIN, återställ', async () => {
  const file = path.join(LIB, 'Selma', 'Saga A.m4b'), before = fs.statSync(file).mtimeMs;
  let r = await req(`/api/audiobooks/book/${S.a}/chapters`, { method: 'PUT', body: { chapters: [{ start: 0, title: 'Början' }, { start: 2.5, title: 'Nytt kapitel' }, { start: 4, title: 'Akka' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.chapterSource, 'redigerad');
  assert.deepEqual(r.data.chapters.map(c => [c.start, c.end, c.title]), [[0, 2.5, 'Början'], [2.5, 4, 'Nytt kapitel'], [4, r.data.duration, 'Akka']]);
  assert.equal(fs.statSync(file).mtimeMs, before, 'filen ska inte skrivas om');
  // Felaktiga kapitel nekas
  assert.equal((await req(`/api/audiobooks/book/${S.a}/chapters`, { method: 'PUT', body: { chapters: [{ start: 99, title: 'x' }] } })).status, 400);
  assert.equal((await req(`/api/audiobooks/book/${S.a}/chapters`, { method: 'PUT', body: { chapters: [{ start: 1, title: 'a' }, { start: 1.2, title: 'b' }] } })).status, 400);
  assert.equal((await req(`/api/audiobooks/book/${S.a}/chapters`, { method: 'PUT', body: { chapters: [] } })).status, 400);
  // Omskanning behåller ändringen
  await req(`/api/libraries/${S.lib}/scan`, { method: 'POST' }).catch(() => {});
  assert.equal((await req(`/api/audiobooks/book/${S.a}`)).data.chapterSource, 'redigerad');
  // Audnexus: utan ASIN nekas, med ASIN hämtas kapitlen (Bok Ett är 12 s = stämmer)
  assert.equal((await req(`/api/audiobooks/book/${S.a}/chapters/audnexus`)).status, 400);
  const ax = (await req(`/api/audiobooks/book/${S.one}/chapters/audnexus`)).data;
  assert.deepEqual(ax.chapters.map(c => c.title), ['Öppning', 'Mitten', 'Slut']); assert.equal(ax.lengthOk, true);
  const ax2 = (await req(`/api/audiobooks/book/${S.a}/chapters/audnexus?asin=B0BOKETT01`)).data;
  assert.equal(ax2.lengthOk, false); // 12 s mot 8 s – redigeraren varnar
  // Bara administratören
  await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW + 'b' } });
  S.boCookie = await webLogin('bo', PW + 'b');
  assert.equal((await req(`/api/audiobooks/book/${S.a}/chapters`, { method: 'PUT', body: { reset: true }, cookie: S.boCookie })).status, 403);
  r = await req(`/api/audiobooks/book/${S.a}/chapters`, { method: 'PUT', body: { reset: true } });
  assert.deepEqual(r.data.chapters.map(c => c.title), ['Pojken', 'Akka']); assert.equal(r.data.chapterSource, 'fil');
});

st('RSS-flöde per bok: giltig XML, enclosure med Range, kapitel som JSON, nyckeln gäller bara flödet, återkallning', async () => {
  const r = await req('/api/audiobooks/feeds', { method: 'POST', body: { book: S.one } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.path, /^\/api\/feeds\/[a-f0-9]{48}\/feed\.xml$/);
  const token = r.data.path.split('/')[3];
  // Listan visar aldrig nyckeln
  const lst = (await req(`/api/audiobooks/feeds?book=${S.one}`)).data;
  assert.equal(lst.feeds.length, 1); assert.ok(!JSON.stringify(lst).includes(token));
  // Flödet utan inloggning
  const x = await fetch(B + r.data.path);
  assert.equal(x.status, 200); assert.match(x.headers.get('content-type'), /application\/rss\+xml/);
  const xml = await x.text();
  wellFormed(xml);
  const doc = parseXml(xml);
  const ch = find(doc, 'channel');
  assert.equal(textOf(find(ch, 'title')), 'Bok Ett');
  const items = kids(ch, 'item');
  assert.equal(items.length, 2); // en bok i två filer = två avsnitt
  const enc = find(items[0], 'enclosure').attrs;
  assert.equal(enc.type, 'audio/mpeg'); assert.ok(+enc.length > 1000);
  assert.ok(enc.url.startsWith(`${B}/api/feeds/${token}/audio/`), enc.url);
  assert.ok(xml.includes('xmlns:podcast="https://podcastindex.org/namespace/1.0"'));
  // Range (poddappar spolar och laddar ner i delar)
  let a = await fetch(enc.url, { headers: { range: 'bytes=0-99' } });
  assert.equal(a.status, 206); assert.equal(a.headers.get('content-range'), `bytes 0-99/${enc.length}`); assert.equal((await a.arrayBuffer()).byteLength, 100);
  a = await fetch(enc.url, { method: 'HEAD' });
  assert.equal(a.status, 200); assert.equal(a.headers.get('accept-ranges'), 'bytes'); assert.equal(a.headers.get('content-length'), enc.length);
  // Kapitel (Podcasting 2.0 chapters JSON), relativt filen
  const cu = find(items[1], 'chapters').attrs;
  assert.equal(cu.type, 'application/json+chapters');
  const cj = await (await fetch(cu.url)).json();
  assert.equal(cj.version, '1.2.0'); assert.equal(cj.chapters[0].startTime, 0); assert.equal(cj.chapters[0].title, 'Del 2');
  // Nyckeln gäller inget annat API – och inloggning gäller inte i flödet
  assert.notEqual((await req(`/api/audiobooks/book/${S.one}?t=${token}`, { tok: '' })).status, 200);
  assert.ok(!(await req(`/api/status?t=${token}`, { tok: '' })).data.user);
  assert.equal((await req(`/api/audiobooks/book/${S.one}`, { tok: token })).status, 401);
  assert.equal((await fetch(`${B}/api/feeds/${'0'.repeat(48)}/feed.xml`)).status, 404);
  // En fil från en annan bok nås inte genom flödet
  const other = (await req(`/api/audiobooks/book/${S.a}`)).data.files[0].id;
  assert.equal((await fetch(`${B}/api/feeds/${token}/audio/${other}.m4b`)).status, 404);
  // Återkalla
  assert.equal((await req(`/api/audiobooks/feeds/${lst.feeds[0].id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(B + r.data.path)).status, 404);
  assert.equal((await fetch(enc.url)).status, 404);
});

st('RSS-flöde per serie och vem som får skapa flöden', async () => {
  for (const id of [S.a, S.b]) assert.equal((await req(`/api/audiobooks/book/${id}`, { method: 'PUT', body: { series: 'Sagorna', seriesNo: id === S.a ? '1' : '2' } })).status, 200);
  const r = await req('/api/audiobooks/feeds', { method: 'POST', body: { library: S.lib, series: 'sagorna' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sx = await (await fetch(B + r.data.path)).text();
  wellFormed(sx);
  const doc = parseXml(sx);
  const items = kids(find(doc, 'channel'), 'item');
  assert.deepEqual(items.map(i => textOf(find(i, 'title'))), ['#1 Saga A', '#2 Saga B']);
  assert.equal(find(items[0], 'enclosure').attrs.type, 'audio/x-m4b');
  assert.equal((await req('/api/audiobooks/feeds', { method: 'POST', body: { library: S.lib, series: 'Finns inte' } })).status, 404);
  // Barnprofil: nekas
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 11 } })).status, 200);
  const kid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  const kc = (await fetch(B + '/api/profiles/switch', { method: 'POST', headers: { 'content-type': 'application/json', origin: B, cookie: await webLogin('admin', PW) }, body: JSON.stringify({ id: kid }) })).headers.get('set-cookie').split(';')[0];
  const kr = await req('/api/audiobooks/feeds', { method: 'POST', body: { book: S.a }, cookie: kc });
  assert.equal(kr.status, 403); assert.match(kr.data.error, /Barnprofiler/);
  assert.equal((await req('/api/audiobooks/feeds', { cookie: kc })).data.allowed, false);
});

st('lyssningsstatistik, markera som utläst/oläst och jämn ljudnivå för tal', async () => {
  await req(`/api/audiobooks/book/${S.one}/progress`, { method: 'POST', body: { position: 1, speed: 1 } });
  await sleep(1100);
  await req(`/api/audiobooks/book/${S.one}/progress`, { method: 'POST', body: { position: 3, speed: 1 } });
  // Ett hopp långt fram räknas inte som lyssning
  await req(`/api/audiobooks/book/${S.one}/progress`, { method: 'POST', body: { position: 11 } });
  const one = (await req(`/api/audiobooks/book/${S.one}`)).data;
  assert.ok(one.listened >= 2 && one.listened <= 3, String(one.listened));
  const s = (await req('/api/audiobooks/stats')).data;
  assert.ok(s.total >= 2); assert.equal(s.books[0].id, S.one); assert.ok(s.days.length === 1);
  const b = (await req(`/api/audiobooks/book/${S.a}`)).data;
  assert.ok(s.profiles.some(p => p.name === 'admin' && p.seconds >= 2));
  assert.equal((await req('/api/audiobooks/stats', { cookie: S.boCookie })).data.profiles, undefined);
  // Markera som utläst (hela längden) och oläst (position 0)
  await req(`/api/audiobooks/book/${S.a}/progress`, { method: 'POST', body: { position: b.duration } });
  assert.equal((await req(`/api/audiobooks/book/${S.a}`)).data.finished, true);
  assert.equal((await req('/api/audiobooks/stats')).data.finished, 1);
  await req(`/api/audiobooks/book/${S.a}/progress`, { method: 'POST', body: { position: 0 } });
  assert.equal((await req(`/api/audiobooks/book/${S.a}`)).data.finished, false);
  // Hastighet per bok
  await req(`/api/audiobooks/book/${S.b}/progress`, { method: 'POST', body: { position: 1, speed: 1.75 } });
  assert.equal((await req(`/api/audiobooks/book/${S.b}`)).data.speed, 1.75);
  assert.equal((await req(`/api/audiobooks/book/${S.a}`)).data.speed, 1);
  // Jämn ljudnivå för tal sparas på profilen
  assert.equal((await req('/api/me/listening')).data.speechLevel, false);
  assert.equal((await req('/api/me/listening', { method: 'PUT', body: { speechLevel: true } })).data.speechLevel, true);
});

st('skriv in kapitel i M4B (på begäran, atomärt, originalet i papperskorgen) och ångra', async () => {
  const file = path.join(LIB, 'Selma', 'Saga A.m4b');
  await req(`/api/audiobooks/book/${S.a}/chapters`, { method: 'PUT', body: { chapters: [{ start: 0, title: 'Ett' }, { start: 3, title: 'Två' }, { start: 6, title: 'Tre' }] } });
  assert.equal((await req(`/api/audiobooks/book/${S.one}/chapters/embed`, { method: 'POST' })).status, 400); // MP3 i två filer
  assert.equal((await req(`/api/audiobooks/book/${S.a}/chapters/embed`, { method: 'POST' })).status, 202);
  const b = await waitTool(S.a);
  assert.deepEqual(chaptersOf(file), ['Ett', 'Två', 'Tre']);
  assert.equal(b.chapterSource, 'fil'); assert.deepEqual(b.chapters.map(c => c.title), ['Ett', 'Två', 'Tre']);
  assert.equal(b.tools.trash.kind, 'embed');
  const trash = path.join(LIB, '.braxhn-papperskorg');
  assert.equal(fs.readdirSync(trash).filter(f => f.endsWith('.original')).length, 1);
  assert.equal(fs.readdirSync(path.join(LIB, 'Selma')).filter(f => f.startsWith('.braxhn')).length, 0); // ingen halv fil kvar
  assert.equal((await req(`/api/audiobooks/book/${S.a}/restore`, { method: 'POST' })).status, 202);
  const r = await waitTool(S.a);
  assert.deepEqual(chaptersOf(file), ['Pojken', 'Akka']);
  assert.equal(r.tools.trash, null);
  assert.equal((await req(`/api/audiobooks/book/${S.a}/restore`, { method: 'POST' })).status, 404);
});

st('slå ihop MP3-filer till en M4B: kapitel, samma bok och position, originalen i papperskorgen, ångra', async () => {
  await req(`/api/audiobooks/book/${S.one}/progress`, { method: 'POST', body: { position: 7 } });
  await req(`/api/audiobooks/book/${S.one}/bookmarks`, { method: 'POST', body: { position: 8, note: 'Här' } });
  assert.equal((await req(`/api/audiobooks/book/${S.a}/merge`, { method: 'POST' })).status, 400); // redan en fil
  assert.equal((await req(`/api/audiobooks/book/${S.one}/merge`, { method: 'POST', cookie: S.boCookie })).status, 403);
  assert.equal((await req(`/api/audiobooks/book/${S.one}/merge`, { method: 'POST' })).status, 202);
  assert.equal((await req(`/api/audiobooks/book/${S.a}/chapters/embed`, { method: 'POST' })).status, 409); // en åtgärd åt gången
  const b = await waitTool(S.one);
  const dir = path.join(LIB, 'Författaren', 'Bok Ett');
  assert.deepEqual(fs.readdirSync(dir), ['Bok Ett.m4b']);
  assert.equal(b.files.length, 1); assert.ok(Math.abs(b.duration - 12) < 0.3, String(b.duration));
  assert.deepEqual(b.chapters.map(c => c.title), ['Del 1', 'Del 2']);
  assert.deepEqual(chaptersOf(path.join(dir, 'Bok Ett.m4b')), ['Del 1', 'Del 2']);
  assert.equal(b.position, 7); assert.equal(b.bookmarks.length, 1); assert.equal(b.narrator, 'Berättaren Bertil');
  assert.equal(b.tools.trash.kind, 'merge'); assert.equal(b.tools.trash.files, 2);
  assert.equal(fs.readdirSync(path.join(LIB, '.braxhn-papperskorg')).filter(f => /^bok\d+-.*\.mp3\.original$/.test(f)).length, 2);
  // Ångra: MP3-filerna tillbaka, M4B:n borttagen, samma bok
  assert.equal((await req(`/api/audiobooks/book/${S.one}/restore`, { method: 'POST' })).status, 202);
  const r = await waitTool(S.one);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['01.mp3', '02.mp3']);
  assert.equal(r.files.length, 2); assert.equal(r.position, 7); assert.equal(r.id, S.one);
});
