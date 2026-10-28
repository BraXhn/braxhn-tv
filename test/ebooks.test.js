// E-böcker och serietidningar: ZIP-läsaren (zip-bomber, sökvägar ut ur arkivet, lögner i katalogen, kontrollsumma),
// XML-tolken (entiteter, djup, linjär tid), metadata ur EPUB 2/3, ComicInfo, filnamn och PDF – och mot en riktig server
// skanningen (fientliga filer stoppar inte skanningen, raderingsskyddet), API:t (bibliotek, bok, omslag, EPUB-poster
// med typvitlista och CSP sandbox, serietidningssidor, läsposition på startsidan, bokmärken och markeringar, sök),
// behörigheten (biblioteksbehörighet, barnprofiler och åldersgräns, nedladdning, appar) och OPDS (Basic-inloggning
// med lösenordet för läsappar, flödena, sidströmning, spärr efter för många fel). Kräver ffmpeg (omslagen).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { openZip, safeName } from '../server/ebooks/zip.js';
import { parseXml, textOf, find } from '../server/ebooks/xml.js';
import { readEpub, parseComicInfo, seriesFromName, ageFromRating, readPdf, resolveHref, pdfString, imageType } from '../server/ebooks/formats.js';
import { zip, epub, cbz, pdf, png, paragraphs } from './helpers/ebook-fixtures.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-ebook-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config'), LIB = path.join(MEDIA, 'Böcker'), LIB2 = path.join(MEDIA, 'Manga');
const PORT = 25000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = (name, buf) => { const f = path.join(ROOT, name); fs.writeFileSync(f, buf); return f; };
let srv, admin = '', webCookie = '';
const S = {};
const st = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

// ---------- ZIP ----------
test('ZIP: lagrade och packade poster, naturliga namn och CRC-kontroll', async () => {
  const f = tmp('a.zip', zip([{ name: 'a.txt', data: 'hej', method: 0 }, { name: 'mapp/b.txt', data: 'då'.repeat(1000) }, { name: 'mapp/', data: '' }]));
  const z = await openZip(f);
  try {
    assert.deepEqual([...z.entries.keys()], ['a.txt', 'mapp/b.txt']);
    assert.equal((await z.read('a.txt')).toString(), 'hej');
    assert.equal((await z.read('mapp/b.txt')).toString(), 'då'.repeat(1000));
    await assert.rejects(z.read('saknas'), /finns inte/);
  } finally { await z.close(); }
  const bad = tmp('crc.zip', zip([{ name: 'x.txt', data: 'abc', crc: 1234 }]));
  const z2 = await openZip(bad);
  await assert.rejects(z2.read('x.txt'), /kontrollsumma/); await z2.close();
  await assert.rejects(openZip(tmp('inte.zip', Buffer.from('det här är ingen zip-fil alls, bara text'))), /inget ZIP-arkiv/);
});

test('ZIP: sökvägar ut ur arkivet, absoluta sökvägar och styrtecken godtas aldrig', async () => {
  for (const n of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/Windows/x', '..\\..\\x', 'a\u0000b', 'a/..']) assert.equal(safeName(n), null, n);
  assert.equal(safeName('./OEBPS//text/ch1.xhtml'), 'OEBPS/text/ch1.xhtml');
  const f = tmp('trav.zip', zip([{ name: '../../evil.jpg', data: 'x' }, { name: '/abs.jpg', data: 'x' }, { name: 'ok.jpg', data: 'x' }]));
  const z = await openZip(f);
  assert.deepEqual([...z.entries.keys()], ['ok.jpg']);
  assert.equal(z.rejected, 2);
  await z.close();
  // Hänvisningar i EPUB:en löses inom arkivet – aldrig ovanför roten, aldrig andra scheman
  assert.equal(resolveHref('OEBPS/text', '../images/a.png#x'), 'OEBPS/images/a.png');
  assert.equal(resolveHref('OEBPS', '../../../etc/passwd'), null);
  assert.equal(resolveHref('OEBPS', 'http://evil.example/x.png'), null);
  assert.equal(resolveHref('OEBPS', 'javascript:alert(1)'), null);
});

test('ZIP: zip-bomber – orimlig packningsgrad, lögn om storleken och för många poster', async () => {
  const zeros = Buffer.alloc(50 << 20); // 50 MB nollor ≈ 50 kB packat
  const honest = await openZip(tmp('bomb1.zip', zip([{ name: 'bomb.xhtml', data: zeros }])));
  const t0 = Date.now();
  await assert.rejects(honest.read('bomb.xhtml'), /zip-bomb/);
  assert.ok(Date.now() - t0 < 500, 'packningsgraden avvisas innan något packas upp');
  await assert.rejects(honest.read('bomb.xhtml', 1 << 20), /för stor/);
  await honest.close();
  // Katalogen säger 1 kB – uppackningen stannar där (aldrig 50 MB i minnet)
  const liar = await openZip(tmp('bomb2.zip', zip([{ name: 'bomb.png', data: zeros, usize: 1024 }])));
  await assert.rejects(liar.read('bomb.png'), /zip-bomb|mer data/);
  await liar.close();
  const many = tmp('many.zip', zip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }))));
  await assert.rejects(openZip(many, { entries: 20 }), /för många poster/);
});

// ---------- XML ----------
test('XML: inga egna entiteter (billion laughs), djupgräns och linjär tid för fientlig text', () => {
  const lol = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><r>&lol2;&amp;&#229;&#x00E4;</r>`;
  const d = parseXml(lol);
  assert.equal(textOf(find(d, 'r')), '&lol2;&åä');
  assert.throws(() => parseXml('<a>'.repeat(200)), /djupt/);
  const t0 = Date.now();
  parseXml('<a b="'.repeat(200000)); parseXml('<a '.repeat(300000)); parseXml('<!--'.repeat(300000)); parseXml('<x>'.repeat(90) + '</y>'.repeat(200000));
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal(find(parseXml('<a x=\'1>2\'><b/>text</a>'), 'b').local, 'b', '> i ett attributvärde avslutar inte taggen');
});

// ---------- metadata ----------
test('EPUB 3: titel, författare, serie (belongs-to-collection), innehållsförteckning (nav), omslag och teckenantal', async () => {
  const f = tmp('e3.epub', epub({ title: 'Äventyret', author: 'Anna Andersson', series: 'Sagan', seriesNo: 2, isbn: '9789100000002', description: '<p>En <b>bok</b>.</p>',
    cover: png(30, 45), chapters: [{ title: 'Början', body: paragraphs(4) }, { title: 'Slutet', body: paragraphs(1) }], rtl: true }));
  const z = await openZip(f);
  const r = await readEpub(z); await z.close();
  assert.equal(r.meta.title, 'Äventyret'); assert.equal(r.meta.author, 'Anna Andersson');
  assert.equal(r.meta.series, 'Sagan'); assert.equal(r.meta.seriesNo, 2); assert.equal(r.meta.isbn, '9789100000002');
  assert.equal(r.meta.year, 2021); assert.equal(r.meta.language, 'sv'); assert.equal(r.meta.description, 'En bok .');
  assert.deepEqual(r.toc.map(x => x.title), ['Början', 'Slutet']);
  assert.deepEqual(r.spine.map(s => s.href), ['OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml']);
  assert.ok(r.spine[0].chars > r.spine[1].chars * 2);
  assert.equal(r.cover, 'OEBPS/images/cover.png'); assert.equal(r.rtl, true);
  assert.equal(r.manifest['OEBPS/style.css'], undefined);
});
test('EPUB 2: calibre-serie, NCX och omslag via <meta name="cover">', async () => {
  const z = await openZip(tmp('e2.epub', epub({ title: 'Gammal', ncx: true, series: 'Klassiker', seriesNo: 1.5, cover: png(20, 30), chapters: [{ title: 'Ett', body: 'a' }, { title: 'Två', body: 'b' }] })));
  const r = await readEpub(z); await z.close();
  assert.equal(r.meta.series, 'Klassiker'); assert.equal(r.meta.seriesNo, 1.5);
  assert.deepEqual(r.toc.map(x => [x.title, x.href]), [['Ett', 'OEBPS/text/ch1.xhtml'], ['Två', 'OEBPS/text/ch2.xhtml']]);
  assert.equal(r.cover, 'OEBPS/images/cover.png');
});
test('serietidningar: ComicInfo, åldersgräns, manga och serie/nummer ur filnamnet', () => {
  const ci = parseComicInfo(`<?xml version="1.0"?><ComicInfo><Series>One Piece</Series><Number>12</Number><Writer>Eiichiro Oda</Writer><AgeRating>Teen</AgeRating>
    <Manga>YesAndRightToLeft</Manga><Summary>Pirater &amp; skatter</Summary><Pages><Page Image="2" Type="FrontCover"/></Pages></ComicInfo>`);
  assert.deepEqual([ci.series, ci.seriesNo, ci.author, ci.age, ci.rtl, ci.manga, ci.description, ci.frontCover], ['One Piece', 12, 'Eiichiro Oda', 13, true, true, 'Pirater & skatter', 2]);
  assert.equal(ageFromRating('Mature 17+'), 17); assert.equal(ageFromRating('Adults Only 18+'), 18); assert.equal(ageFromRating('Everyone'), 0); assert.equal(ageFromRating('Rating Pending'), null);
  assert.deepEqual(seriesFromName('Saga 012 (2014)'), { series: 'Saga', no: 12 });
  assert.deepEqual(seriesFromName('Berserk v03'), { series: 'Berserk', no: 3 });
  assert.deepEqual(seriesFromName('Bamse_-_#1987.5'), { series: 'Bamse', no: 1987.5 });
  assert.equal(seriesFromName('Ensam'), null);
  assert.equal(imageType(png(2, 2)), 'image/png'); assert.equal(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});
test('PDF: titel och författare ur Info (även UTF-16), sidantal, och skräp ger fel utan att hänga', async () => {
  const a = await readPdf(tmp('a.pdf', pdf({ title: 'Rapport (slutlig)', author: 'Åsa Öberg', pages: 7 })));
  assert.deepEqual([a.meta.title, a.meta.author, a.meta.year, a.pages], ['Rapport (slutlig)', 'Åsa Öberg', 2019, 7]);
  const b = await readPdf(tmp('b.pdf', pdf({ title: 'Ödet', author: 'Ünal', utf16: true })));
  assert.deepEqual([b.meta.title, b.meta.author], ['Ödet', 'Ünal']);
  assert.equal(pdfString('a\\(b\\)\\101'), 'a(b)A');
  await assert.rejects(readPdf(tmp('c.pdf', Buffer.from('inte en pdf'))), /inte en PDF/);
  const t0 = Date.now();
  await readPdf(tmp('d.pdf', Buffer.from('%PDF-1.4\n' + '/Info 1 0 R /Type /Pages /Count 3 /DCTDecode stream '.repeat(30000), 'latin1')));
  assert.ok(Date.now() - t0 < 3000);
});

// ---------- servern ----------
const W = (rel, buf) => { const f = path.join(LIB, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return f; };
before(async () => {
  if (!hasFfmpeg) return;
  W('Anna Andersson/Äventyret.epub', epub({ title: 'Äventyret', author: 'Anna Andersson', series: 'Sagan', seriesNo: 1, cover: png(300, 450),
    css: 'body { color: red; background: url(http://evil.example/x.png) } @import url("http://evil.example/a.css");',
    chapters: [{ title: 'Början', body: paragraphs(30) + '<p><img src="../images/cover.png" alt="Bild"/></p>' }, { title: 'Mitten', body: paragraphs(10) }, { title: 'Slutet', body: paragraphs(3) }] }));
  W('Anna Andersson/Fortsättningen.epub', epub({ title: 'Fortsättningen', author: 'Anna Andersson', series: 'Sagan', seriesNo: 2, ncx: true }));
  // Fientliga filer: skript och externa resurser i XHTML, en zip-bomb som kapitel, ../-poster, trasig fil, RAR-CBR
  W('Fientligt/Skript.epub', epub({ title: 'Skriptboken', chapters: [{ title: 'Elakt', head: '<script>parent.pwned=1</script><meta http-equiv="refresh" content="0;url=http://evil.example/"/>',
    body: '<p onclick="parent.pwned=2">Klicka</p><img src="http://evil.example/spy.png" onerror="parent.pwned=3"/><a href="javascript:parent.pwned=4">länk</a><iframe src="http://evil.example/"></iframe>' }],
    extra: [{ name: '../../../utanfor.txt', data: 'ut' }] }));
  W('Fientligt/Bomb.epub', epub({ title: 'Bomben', chapters: [{ title: 'Kort', body: 'kort' }], extra: [{ name: 'OEBPS/text/bomb.xhtml', data: Buffer.alloc(40 << 20) }] }));
  W('Fientligt/Trasig.epub', Buffer.from('PK\u0003\u0004 det här är ingen riktig EPUB'));
  W('Serier/Fel.cbr', Buffer.concat([Buffer.from('Rar!\u001a\u0007\u0000'), Buffer.alloc(100)]));
  W('Serier/Zip med fel ändelse.cbr', cbz({ pages: 2 }));
  W('Serier/Saga/Saga 001.cbz', cbz({ pages: 5, info: { Series: 'Saga', Number: '1', AgeRating: 'Teen', Writer: 'Brian K. Vaughan' }, extra: [{ name: '../../flykt.png', data: png(4, 4) }] }));
  W('Serier/Saga/Saga 002.cbz', cbz({ pages: 3, info: { Series: 'Saga', Number: '2', AgeRating: 'Mature 17+' } }));
  W('Dokument.pdf', pdf({ title: 'Manualen', author: 'Tillverkaren', pages: 12 }));
  fs.mkdirSync(LIB2, { recursive: true });
  fs.writeFileSync(path.join(LIB2, 'Manga 01.cbz'), cbz({ pages: 4, info: { Series: 'Manga', Number: '1', Manga: 'YesAndRightToLeft', AgeRating: 'Everyone' } }));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', SCAN_INTERVAL: '0', BOOK_METADATA: '0' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  srv.stdout.on('data', () => {});
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });

async function req(p, { method = 'GET', body, tok = admin, cookie = '', headers = {} } = {}) {
  const h = { ...headers };
  if (tok && !cookie && !h.authorization) h.authorization = 'Bearer ' + tok;
  if (cookie) { h.cookie = cookie; h.origin = B; }
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
const login = async (name, password) => (await req('/api/login', { method: 'POST', body: { name, password, app: true }, tok: '' })).data.token;
const webLogin = async (name, password) => (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: B }, body: JSON.stringify({ name, password }) })).headers.get('set-cookie').split(';')[0];
async function waitScan() {
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    const s = (await req('/api/scan')).data;
    if (!s.running && !s.queued && s.last) return s;
  }
  throw new Error('skanningen blev inte klar');
}
const web = (p, o = {}) => req(p, { ...o, cookie: webCookie });
const basic = (name, pw) => ({ authorization: 'Basic ' + Buffer.from(`${name}:${pw}`).toString('base64') });

st('skanning: metadata, omslag, serier – fientliga filer stoppar inte skanningen', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin', PW);
  webCookie = await webLogin('admin', PW);
  let r = await req('/api/libraries', { method: 'POST', body: { name: 'Manga', type: 'ebook', path: LIB2, kids: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); S.M = r.data.id;
  await waitScan();
  r = await req('/api/libraries', { method: 'POST', body: { name: 'Böcker', type: 'ebook', path: LIB } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); S.L = r.data.id;
  const s = await waitScan();
  assert.ok(s.warnings.some(w => /RAR/.test(w)), JSON.stringify(s.warnings));
  assert.ok(s.warnings.some(w => /otillåtna sökvägar/.test(w)), JSON.stringify(s.warnings));
  const lib = (await web(`/api/ebooks/lib/${S.L}?sort=title`)).data;
  const titles = lib.books.map(b => b.title);
  for (const tl of ['Äventyret', 'Fortsättningen', 'Skriptboken', 'Bomben', 'Saga #1', 'Saga #2', 'Manualen']) assert.ok(titles.includes(tl), `${tl} saknas: ${titles}`);
  assert.ok(titles.includes('Zip med fel ändelse'), 'CBR som egentligen är ZIP läses');
  assert.ok(!titles.includes('Trasig') && !titles.includes('Fel'), 'trasiga filer och RAR hoppas över');
  const sagan = lib.series.find(x => x.name === 'Sagan');
  assert.equal(sagan.count, 2); assert.ok(sagan.cover);
  assert.equal(lib.series.find(x => x.name === 'Saga').count, 2);
  const by = Object.fromEntries(lib.books.map(b => [b.title, b]));
  S.epub = by['Äventyret'].id; S.epub2 = by['Fortsättningen'].id; S.script = by['Skriptboken'].id; S.bomb = by['Bomben'].id;
  S.saga1 = by['Saga #1'].id; S.saga2 = by['Saga #2'].id; S.pdf = by['Manualen'].id;
  assert.equal(by['Äventyret'].author, 'Anna Andersson'); assert.equal(by['Äventyret'].cover, true); assert.equal(by['Äventyret'].seriesNo, 1);
  assert.equal(by['Saga #1'].pages, 5); assert.equal(by['Manualen'].format, 'pdf'); assert.equal(by['Manualen'].pages, 12);
  const libs = (await web('/api/libraries')).data;
  assert.equal(libs.find(l => l.id === S.L).count, 8);
  assert.ok(!(await req('/api/libraries')).data.some(l => l.type === 'ebook'), 'apparna får inte e-boksbibliotek');
  // Serien som filter
  assert.deepEqual((await web(`/api/ebooks/lib/${S.L}?series=sagan`)).data.books.map(b => b.title), ['Äventyret', 'Fortsättningen']);
});

st('boken, omslaget och EPUB-posterna: typvitlista, CSP sandbox och inga sökvägar ut ur arkivet', async () => {
  const b = (await web(`/api/ebooks/${S.epub}`)).data;
  assert.deepEqual(b.toc.map(x => x.title), ['Början', 'Mitten', 'Slutet']);
  assert.equal(b.spine.length, 3); assert.ok(b.spine[0].chars > b.spine[2].chars);
  assert.equal(b.path, undefined, 'serverns sökväg lämnas inte ut'); assert.equal(b.manifest, undefined);
  assert.deepEqual(b.sameSeries.map(x => x.title), ['Fortsättningen']);
  const cov = await web(`/api/ebooks/${S.epub}/cover?w=160`);
  assert.equal(cov.status, 200); assert.equal(cov.headers.get('content-type'), 'image/jpeg');
  // Kapitlet är text, aldrig en sida: text/plain med CSP sandbox
  const ch = await web(`/api/ebooks/${S.script}/res?p=${encodeURIComponent('OEBPS/text/ch1.xhtml')}`);
  assert.equal(ch.status, 200);
  assert.match(ch.headers.get('content-type'), /^text\/plain/);
  assert.match(ch.headers.get('content-security-policy'), /sandbox/);
  assert.match(ch.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(ch.headers.get('x-content-type-options'), 'nosniff');
  assert.match(ch.data.toString(), /<script>/, 'innehållet lämnas orört – läsaren rensar det i webbläsaren');
  const css = await web(`/api/ebooks/${S.epub}/res?p=OEBPS/style.css`);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  const im = await web(`/api/ebooks/${S.epub}/res?p=OEBPS/images/cover.png`);
  assert.equal(im.headers.get('content-type'), 'image/png');
  for (const p of ['../../../etc/passwd', '/etc/passwd', 'OEBPS/../../x', '']) assert.equal((await web(`/api/ebooks/${S.epub}/res?p=${encodeURIComponent(p)}`)).status, 400, p);
  assert.equal((await web(`/api/ebooks/${S.script}/res?p=utanfor.txt`)).status, 404);
  assert.equal((await web(`/api/ebooks/${S.epub}/res?p=OEBPS/saknas.png`)).status, 404);
  // Zip-bomben som kapitel: avvisas direkt
  const t0 = Date.now();
  const bomb = await web(`/api/ebooks/${S.bomb}/res?p=OEBPS/text/bomb.xhtml`);
  assert.equal(bomb.status, 422); assert.match(bomb.data.error, /zip-bomb/);
  assert.ok(Date.now() - t0 < 1500);
  assert.equal((await web(`/api/ebooks/${S.saga1}/res?p=ComicInfo.xml`)).status, 404, 'bara EPUB har poster');
});

st('serietidningssidor, PDF och nedladdning', async () => {
  const p0 = await web(`/api/ebooks/${S.saga1}/page/0`);
  assert.equal(p0.status, 200); assert.equal(p0.headers.get('content-type'), 'image/png');
  const p4 = await web(`/api/ebooks/${S.saga1}/page/4`);
  assert.notDeepEqual(p0.data, p4.data, 'sidorna sorteras (arkivet har dem i omvänd ordning)');
  for (const n of ['5', '-1', 'x', '1e3']) assert.equal((await web(`/api/ebooks/${S.saga1}/page/${n}`)).status, 404, n);
  const pd = await web(`/api/ebooks/${S.pdf}/pdf`);
  assert.equal(pd.status, 200); assert.equal(pd.headers.get('content-type'), 'application/pdf'); assert.match(pd.headers.get('content-disposition'), /^inline/);
  assert.equal((await web(`/api/ebooks/${S.epub}/pdf`)).status, 404);
  const dl = await web(`/api/ebooks/${S.epub}/file`);
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'application/epub+zip'); assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal(dl.data.readUInt32LE(0), 0x04034b50);
});

st('läsposition per profil, Fortsätt läsa på startsidan, bokmärken och markeringar, sök', async () => {
  let r = await web(`/api/ebooks/${S.epub}/progress`, { method: 'POST', body: { locator: { ch: 1, p: 0.5 }, percent: 42.5 } });
  assert.equal(r.status, 200); assert.equal(r.data.finished, false);
  const b = (await web(`/api/ebooks/${S.epub}`)).data;
  assert.deepEqual(b.locator, { ch: 1, p: 0.5 }); assert.equal(b.percent, 42.5);
  await sleep(1100); // senast läst först (sekundupplösning)
  await web(`/api/ebooks/${S.saga1}/progress`, { method: 'POST', body: { locator: { page: 2 }, percent: 50 } });
  const home = (await web('/api/home')).data;
  assert.deepEqual(home.reading.map(x => x.id), [S.saga1, S.epub]);
  assert.ok(home.homeLayout.order.includes('reading'));
  assert.deepEqual((await req('/api/home')).data.reading, [], 'apparna får inget nytt fält att visa');
  // Ett äldre sparat läge (offline) skriver inte över ett nyare
  r = await web(`/api/ebooks/${S.epub}/progress`, { method: 'POST', body: { locator: { ch: 0, p: 0 }, percent: 1, at: Math.floor(Date.now() / 1000) - 3600 } });
  assert.equal(r.data.stale, true);
  assert.equal((await web(`/api/ebooks/${S.epub}`)).data.percent, 42.5);
  // Utläst
  r = await web(`/api/ebooks/${S.epub2}/progress`, { method: 'POST', body: { locator: { ch: 0, p: 1 }, percent: 100 } });
  assert.equal(r.data.finished, true);
  assert.ok(!(await web('/api/home')).data.reading.some(x => x.id === S.epub2));
  assert.equal((await web(`/api/ebooks/${S.epub2}/progress`, { method: 'DELETE' })).status, 200);
  assert.equal((await web(`/api/ebooks/${S.epub2}`)).data.percent, 0);
  // Ogiltig position sparas inte (för stor) men procenten gör det
  await web(`/api/ebooks/${S.epub2}/progress`, { method: 'POST', body: { locator: { x: 'a'.repeat(5000) }, percent: 3 } });
  assert.equal((await web(`/api/ebooks/${S.epub2}`)).data.locator, null);
  // Bokmärke och markering
  const bm = (await web(`/api/ebooks/${S.epub}/marks`, { method: 'POST', body: { kind: 'bookmark', locator: { ch: 2, p: 0 }, text: 'Slutet' } })).data;
  const hl = (await web(`/api/ebooks/${S.epub}/marks`, { method: 'POST', body: { kind: 'highlight', locator: { ch: 0, start: 10, end: 30 }, text: 'det var en gång', color: 'green', note: 'Fint' } })).data;
  assert.equal(hl.color, 'green');
  assert.equal((await web(`/api/ebooks/${S.epub}/marks`, { method: 'POST', body: { kind: 'skript', locator: {} } })).status, 400);
  assert.equal((await web(`/api/ebooks/marks/${hl.id}`, { method: 'PUT', body: { note: 'Ändrad', color: 'lila' } })).data.color, 'green', 'okänd färg ignoreras');
  let marks = (await web(`/api/ebooks/${S.epub}`)).data.marks;
  assert.deepEqual(marks.map(m => [m.kind, m.note]), [['bookmark', null], ['highlight', 'Ändrad']]);
  assert.equal((await web(`/api/ebooks/marks/${bm.id}`, { method: 'DELETE' })).data.ok, true);
  marks = (await web(`/api/ebooks/${S.epub}`)).data.marks;
  assert.equal(marks.length, 1);
  // Sök
  const sr = (await web('/api/search/all?q=aventyret')).data;
  assert.ok(sr.ebooks.some(x => x.id === S.epub), JSON.stringify(sr.ebooks));
  assert.ok(sr.order.includes('ebooks'));
  assert.deepEqual((await req('/api/search/all?q=aventyret')).data.ebooks, []);
});

st('behörighet: bibliotek, barnprofiler (standard nej) och åldersgräns, nedladdning', async () => {
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW, libraries: [S.M] } })).status, 200);
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'kalle', password: PW, canDownload: false } })).status, 200);
  const bo = await webLogin('bo', PW), kalle = await webLogin('kalle', PW);
  for (const p of [`/api/ebooks/lib/${S.L}`, `/api/ebooks/${S.epub}`, `/api/ebooks/${S.epub}/cover`, `/api/ebooks/${S.epub}/res?p=OEBPS/style.css`,
    `/api/ebooks/${S.saga1}/page/0`, `/api/ebooks/${S.epub}/file`, `/api/ebooks/${S.pdf}/pdf`]) assert.equal((await req(p, { cookie: bo })).status, 404, p);
  assert.equal((await req(`/api/ebooks/${S.epub}/progress`, { method: 'POST', body: { percent: 5 }, cookie: bo })).status, 404);
  assert.equal((await req(`/api/ebooks/${S.epub}/marks`, { method: 'POST', body: { kind: 'bookmark', locator: { ch: 0 } }, cookie: bo })).status, 404);
  assert.deepEqual((await req('/api/search/all?q=aventyret', { cookie: bo })).data.ebooks, []);
  assert.equal((await req(`/api/ebooks/lib/${S.M}`, { cookie: bo })).status, 200);
  // Markeringar är personliga
  const mine = (await web(`/api/ebooks/${S.epub}`)).data.marks[0];
  assert.equal((await req(`/api/ebooks/marks/${mine.id}`, { method: 'DELETE', cookie: kalle })).data.ok, false);
  assert.equal((await req(`/api/ebooks/${S.epub}`, { cookie: kalle })).data.marks.length, 0);
  // Nedladdning kräver rätten – läsning gör det inte
  assert.equal((await req(`/api/ebooks/${S.epub}/file`, { cookie: kalle })).status, 403);
  assert.equal((await req(`/api/ebooks/${S.epub}/res?p=OEBPS/style.css`, { cookie: kalle })).status, 200);
  assert.equal((await req(`/api/ebooks/${S.epub}`, { cookie: kalle })).data.canDownload, false);
  // Barnprofil (15 år): ser bara bibliotek med "barnprofiler får se", och där bara böcker inom åldersgränsen
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 15 }, cookie: webCookie })).status, 200);
  const kid = (await req('/api/profiles', { cookie: webCookie })).data.profiles.find(p => p.name === 'Lisa').id;
  const kidCookie = (await fetch(B + '/api/profiles/switch', { method: 'POST', headers: { 'content-type': 'application/json', origin: B, cookie: await webLogin('admin', PW) }, body: JSON.stringify({ id: kid }) })).headers.get('set-cookie').split(';')[0];
  const kidLibs = (await req('/api/libraries', { cookie: kidCookie })).data;
  assert.ok(kidLibs.some(l => l.id === S.M) && !kidLibs.some(l => l.id === S.L), JSON.stringify(kidLibs.map(l => l.id)));
  assert.equal((await req(`/api/ebooks/lib/${S.L}`, { cookie: kidCookie })).status, 404);
  assert.equal((await req(`/api/ebooks/${S.saga1}/page/0`, { cookie: kidCookie })).status, 404);
  assert.equal((await req(`/api/libraries/${S.L}`, { method: 'PUT', body: { kids: true } })).status, 200);
  const kl = (await req(`/api/ebooks/lib/${S.L}`, { cookie: kidCookie })).data;
  assert.ok(kl.books.some(b => b.id === S.saga1), 'Teen (13) syns för 15 år');
  assert.ok(!kl.books.some(b => b.id === S.saga2), 'Mature 17+ döljs');
  assert.equal(kl.series.find(x => x.name === 'Saga').count, 1);
  for (const p of [`/api/ebooks/${S.saga2}`, `/api/ebooks/${S.saga2}/page/0`, `/api/ebooks/${S.saga2}/cover`]) assert.equal((await req(p, { cookie: kidCookie })).status, 404, p);
  assert.equal((await req(`/api/ebooks/${S.saga1}/page/0`, { cookie: kidCookie })).status, 200);
  assert.ok(!(await req('/api/search/all?q=saga', { cookie: kidCookie })).data.ebooks.some(b => b.id === S.saga2));
  assert.equal((await req(`/api/libraries/${S.L}`, { method: 'PUT', body: { kids: false } })).status, 200);
  assert.equal((await req(`/api/ebooks/${S.saga1}`, { cookie: kidCookie })).status, 404);
});

st('OPDS: Basic-inloggning med lösenordet för läsappar, flödena och sidströmning', async () => {
  // Utan inloggning: utmaning; webbens kaka och appens token gäller inte här
  let r = await req('/api/opds', { tok: '' });
  assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /^Basic realm="BraXhn TV"/);
  assert.equal((await req('/api/opds', { cookie: webCookie })).status, 401);
  assert.equal((await req('/api/opds')).status, 401);
  assert.equal((await req('/api/opds', { tok: '', headers: basic('admin', PW) })).status, 401, 'kontots lösenord gäller inte');
  // Lösenordet skapas med kontots lösenord och visas en gång
  assert.equal((await web('/api/me/opds', { method: 'POST', body: { password: 'fel' } })).status, 400);
  r = await web('/api/me/opds', { method: 'POST', body: { password: PW } });
  assert.equal(r.status, 200); const secret = r.data.secret;
  assert.match(secret, /^[A-Za-z0-9-]{20,}$/);
  const info = (await web('/api/me/opds')).data;
  assert.ok(info.password.created); assert.equal(info.secret, undefined); assert.ok(!JSON.stringify(info).includes(secret));
  const A = { tok: '', headers: basic('admin', secret) };
  r = await req('/api/opds', A);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /kind=navigation/);
  const root = r.data.toString();
  assert.match(root, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom"/);
  assert.ok(root.includes(`/api/opds/lib/${S.L}`) && root.includes('Fortsätt läsa'));
  r = await req(`/api/opds/lib/${S.L}`, A);
  assert.match(r.headers.get('content-type'), /kind=acquisition/);
  const acq = r.data.toString();
  assert.ok(acq.includes('<title>Äventyret</title>'));
  assert.ok(acq.includes(`href="/api/opds/book/${S.epub}/file" type="application/epub+zip"`));
  assert.ok(acq.includes(`pse:count="5"`), 'sidströmning för serietidningar');
  assert.ok(acq.includes('<opensearch:totalResults>8</opensearch:totalResults>'));
  // Lösenordet för läsappar gäller bara /api/opds/*
  assert.equal((await req(`/api/ebooks/${S.epub}`, A)).status, 401);
  assert.equal((await req('/api/home', A)).status, 401);
  // Serier, sök, fil, omslag och sida
  assert.ok((await req(`/api/opds/lib/${S.L}/series`, A)).data.toString().includes('/series/Sagan'));
  assert.ok((await req(`/api/opds/lib/${S.L}/series/Sagan`, A)).data.toString().includes('<title>Fortsättningen</title>'));
  assert.ok((await req('/api/opds/search?q=manualen', A)).data.toString().includes('<title>Manualen</title>'));
  assert.match((await req('/api/opds/opensearch.xml', A)).data.toString(), /search\?q=\{searchTerms\}/);
  r = await req(`/api/opds/book/${S.epub}/file`, A);
  assert.equal(r.status, 200); assert.equal(r.data.readUInt32LE(0), 0x04034b50);
  assert.equal((await req(`/api/opds/book/${S.epub}/cover`, A)).headers.get('content-type'), 'image/jpeg');
  assert.equal((await req(`/api/opds/book/${S.saga1}/page/2`, A)).headers.get('content-type'), 'image/png');
  assert.ok((await req('/api/opds/continue', A)).data.toString().includes('<title>Saga #1</title>'));
  // Ett konto utan nedladdning får flödet men inte filen
  const kc = await webLogin('kalle', PW);
  const ks = (await req('/api/me/opds', { method: 'POST', body: { password: PW }, cookie: kc })).data.secret;
  const K = { tok: '', headers: basic('kalle', ks) };
  assert.ok(!(await req(`/api/opds/lib/${S.L}`, K)).data.toString().includes('opds-spec.org/acquisition"'));
  assert.equal((await req(`/api/opds/book/${S.epub}/file`, K)).status, 403);
  // Återkallat lösenord slutar gälla
  assert.equal((await req('/api/me/opds', { method: 'DELETE', cookie: kc })).status, 200);
  assert.equal((await req('/api/opds', K)).status, 401);
});

st('raderingsskyddet: en saknad mapp tar inte bort något, en borttagen fil tas bort', async () => {
  const count = async () => (await web(`/api/ebooks/lib/${S.L}`)).data.books.length;
  const before = await count();
  fs.renameSync(LIB, LIB + '.borta');
  await req(`/api/libraries/${S.L}/scan`, { method: 'POST' }); await waitScan();
  assert.equal(await count(), before, 'avmonterad mapp: inget tas bort');
  fs.renameSync(LIB + '.borta', LIB);
  fs.rmSync(path.join(LIB, 'Dokument.pdf'));
  await req(`/api/libraries/${S.L}/scan`, { method: 'POST' }); await waitScan();
  assert.equal(await count(), before - 1);
  assert.equal((await web(`/api/ebooks/${S.pdf}`)).status, 404);
});

st('OPDS: för många felaktiga inloggningar spärras (sist – spärren gäller adressen)', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await req('/api/opds', { tok: '', headers: basic('admin', 'fel-' + i) });
  assert.equal(last.status, 429);
});

test('zip-läsaren läser bara positionerat (ingen hel fil i minnet) – centralkatalogen är taket', async () => {
  // Ett arkiv med stor kommentar och en stor lagrad post: att öppna det läser bara slutet
  const big = zip([{ name: 'stor.bin', data: Buffer.alloc(8 << 20, 1), method: 0 }, { name: 'liten.txt', data: 'x' }]);
  const f = tmp('big.zip', big);
  const z = await openZip(f);
  assert.equal(z.entries.get('stor.bin').usize, 8 << 20);
  assert.equal((await z.read('liten.txt')).toString(), 'x');
  await z.close();
  assert.ok(zlib.crc32, 'Node har zlib.crc32');
});
