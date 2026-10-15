// Ljudböcker (gruppering, kapitel, position) och poddar (RSS, säker hämtning, nedladdning)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-books-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);

const { run, get } = await import('../server/db.js');
const books = await import('../server/audiobooks.js');
const pods = await import('../server/podcasts.js');
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('gruppering av ljudboksfiler', () => {
  const g = books.groupBooks(['/b/Lindgren/Mio min Mio/CD1/01.mp3', '/b/Lindgren/Mio min Mio/CD2/01.mp3', '/b/Serie/Bok 1.m4b', '/b/Serie/Bok 2.m4b', '/b/Ensam/bok.mp3']);
  assert.equal(g.length, 4);
  assert.deepEqual(g.find(x => x.key === '/b/Lindgren/Mio min Mio').files.length, 2);
  assert.ok(g.find(x => x.key === '/b/Serie/Bok 1.m4b'));
});

test('skanning av ljudböcker: kapitel, författare, position', { skip: !hasFfmpeg }, async () => {
  const lib = path.join(ROOT, 'books');
  const a = path.join(lib, 'Astrid Lindgren', 'Mio min Mio'); fs.mkdirSync(a, { recursive: true });
  for (const n of [1, 2]) ff('-f', 'lavfi', '-i', `sine=frequency=${300 * n}:duration=6`, '-metadata', `title=Del ${n}`, '-metadata', 'album=Mio min Mio', '-metadata', 'artist=Astrid Lindgren', path.join(a, `0${n}.mp3`));
  const b = path.join(lib, 'Selma Lagerlöf'); fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'ch.txt'), ';FFMETADATA1\ntitle=Nils Holgersson\nartist=Selma Lagerlöf\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=4000\ntitle=Pojken\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=4000\nEND=8000\ntitle=Akka\n');
  ff('-f', 'lavfi', '-i', 'sine=frequency=500:duration=8', '-i', path.join(ROOT, 'ch.txt'), '-map', '0', '-map_metadata', '1', '-c:a', 'aac', '-f', 'mp4', path.join(b, 'Nils.m4b'));
  run("INSERT INTO libraries(id,name,type,path) VALUES(5,'Böcker','audiobook',?)", lib);
  const st = {};
  await books.scanBooks(get('SELECT * FROM libraries WHERE id=5'), st);
  const list = books.listBooks(5, 1);
  assert.equal(list.length, 2);
  const mio = list.find(x => x.title === 'Mio min Mio');
  assert.equal(mio.author, 'Astrid Lindgren');
  const m = books.book(mio.id, 1);
  assert.equal(m.files.length, 2); assert.ok(Math.abs(m.files[1].offset - 6) < 0.2);
  assert.deepEqual(m.chapters.map(c => c.title), ['Del 1', 'Del 2']);
  const nils = books.book(list.find(x => x.title === 'Nils Holgersson').id, 1);
  assert.deepEqual(nils.chapters.map(c => c.title), ['Pojken', 'Akka']);
  books.saveProgress(1, mio.id, 7.5, 1.5);
  assert.equal(books.book(mio.id, 1).position, 7.5); assert.equal(books.book(mio.id, 1).speed, 1.5);
  assert.equal(books.continueBooks(1).length, 0); // under 30 s räknas inte som påbörjad
  books.saveProgress(1, mio.id, 11.9);
  assert.equal(books.book(mio.id, 1).finished, true);
  // Omskanning utan ändringar behåller id och position
  await books.scanBooks(get('SELECT * FROM libraries WHERE id=5'), st);
  assert.equal(books.book(mio.id, 1).finished, true);
});

const FEED = `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>Testpodden &amp; vänner</title><itunes:author>Anna</itunes:author><description><![CDATA[<p>En <b>podd</b></p>]]></description><itunes:image href="IMG"/>
<item><title>Avsnitt 2</title><guid>ep2</guid><pubDate>Fri, 09 Oct 2026 06:00:00 GMT</pubDate><itunes:duration>1:02:03</itunes:duration>
<enclosure url="AUDIO" length="1234" type="audio/mpeg"/><content:encoded><![CDATA[Hej &amp; välkommen]]></content:encoded></item>
<item><title>Avsnitt 1</title><guid>ep1</guid><pubDate>Thu, 01 Oct 2026 06:00:00 GMT</pubDate><itunes:duration>300</itunes:duration><enclosure url="AUDIO" type="audio/mpeg"/></item>
</channel></rss>`;

test('RSS-tolkning', () => {
  const { feed, items } = pods.parseFeed(FEED);
  assert.equal(feed.title, 'Testpodden & vänner'); assert.equal(feed.author, 'Anna'); assert.equal(feed.description, 'En podd'); assert.equal(feed.image, 'IMG');
  assert.equal(items.length, 2); assert.equal(items[0].duration, 3723); assert.equal(items[1].duration, 300);
  assert.equal(items[0].description, 'Hej & välkommen'); assert.equal(items[0].guid, 'ep2');
});

test('poddar: lokala adresser nekas, prenumeration och nedladdning fungerar', async () => {
  const audio = Buffer.alloc(4000, 1);
  const srv = http.createServer((q, r) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (q.url === '/feed') { r.writeHead(200, { 'Content-Type': 'application/rss+xml' }); return r.end(FEED.replace(/AUDIO/g, base + '/a.mp3').replace('IMG', base + '/redir')); }
    if (q.url === '/redir') { r.writeHead(302, { Location: '/img.jpg' }); return r.end(); }
    if (q.url === '/img.jpg') { r.writeHead(200, { 'Content-Type': 'image/jpeg' }); return r.end(Buffer.from([0xff, 0xd8, 0xff])); }
    if (q.url === '/a.mp3') { r.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length }); return r.end(audio); }
    r.writeHead(404); r.end();
  }).listen(0);
  await new Promise(r => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/feed`;
  await assert.rejects(() => pods.subscribe(url, { id: 1 }), /lokalt nätverk/);
  await assert.rejects(() => pods.safeFetch('http://[::1]:1/'), /lokalt nätverk/);
  await assert.rejects(() => pods.safeFetch('file:///etc/passwd'), /http/);
  process.env.PODCAST_ALLOW_PRIVATE = '1';
  try {
    const id = await pods.subscribe(url, { id: 1 });
    const p = pods.podcast(id, 1);
    assert.equal(p.title, 'Testpodden & vänner'); assert.equal(p.episodes.length, 2); assert.equal(p.image, true);
    for (let i = 0; i < 50 && !pods.podcast(id, 1).episodes.every(e => e.downloaded); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(pods.podcast(id, 1).episodes.every(e => e.downloaded));
    const ep = p.episodes[0];
    pods.saveProgress(1, ep.id, 100);
    assert.equal(pods.podcast(id, 1).episodes[0].position, 100);
    pods.saveProgress(1, ep.id, 0, true);
    assert.equal(pods.latest(1).length, 1); // det lyssnade avsnittet syns inte i "senaste"
    pods.unsubscribe(id);
    assert.equal(fs.readdirSync(pods.DIR).length, 0);
  } finally { delete process.env.PODCAST_ALLOW_PRIVATE; srv.close(); }
});

test('poddar: spärrade adresser och skadliga flöden', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '100.64.1.1', '::1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '64:ff9b::a00:1', '2002:a00:1::'])
    assert.ok(pods.blockedIp(ip), ip);
  for (const ip of ['8.8.8.8', '2001:4860:4860::8888', '1.1.1.1']) assert.ok(!pods.blockedIp(ip), ip);
  // Tidigare kvadratisk regex: 1 MB skräp ska tolkas på under en sekund
  const evil = '<rss><channel><item>' + '<enclosure '.repeat(100000) + '</item>' + '<item><enclosure url="x"'.repeat(20000);
  const t0 = Date.now(); pods.parseFeed(evil); assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
});
