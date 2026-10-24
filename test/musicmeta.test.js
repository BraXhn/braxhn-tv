// Musikmetadata och låttexter från nätet (server/musicmeta.js) mot en låtsasserver i stället för MusicBrainz, Wikidata,
// Wikipedia, Commons och LRCLIB: matchning med albumtitlar (rätt artist bland flera med samma namn), hastighetsbegränsningen
// mot MusicBrainz, fasta värdar (omdirigering till en annan värd följs inte), biografi på svenska, artistbild, albumtyper och
// beskrivning, relaterade artister, "Fel artist?" med låsning, låttexter (lokal .lrc först, LRCLIB som reserv, cache i
// databasen) och Subsonics getArtistInfo2/getAlbumInfo2/getLyricsBySongId med signerade bildadresser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-musicmeta-'));
const MEDIA = path.join(ROOT, 'media');
Object.assign(process.env, { CONFIG_DIR: path.join(ROOT, 'config'), TRANSCODE_DIR: path.join(ROOT, 'tc'), MEDIA_ROOT: MEDIA, WATCH_FILES: '0',
  MUSIC_LOUDNESS: '0', MUSIC_SONIC: '0', SCROBBLE_INTERVAL: '0', CALENDAR_REFRESH: '0', DVR_DIR: path.join(ROOT, 'rec'), PODCAST_DIR: path.join(ROOT, 'pod'),
  MUSICBRAINZ_GAP_MS: '0', MUSIC_META_GAP_MS: '0', MUSIC_META_CONTACT: 'test@exempel.se' });
fs.mkdirSync(MEDIA, { recursive: true });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

// ---------- låtsasserver ----------
const KENT = '11111111-1111-4111-8111-111111111111', KENT_US = '22222222-2222-4222-8222-222222222222', JB = '33333333-3333-4333-8333-333333333333';
const ISOLA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', KV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const log = [];
let base = '', jpg = Buffer.alloc(0), evilBase = '';
const json = (r, v, code = 200) => { r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(v)); };
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x'), P = u.searchParams;
  log.push({ at: Date.now(), path: u.pathname, q: u.search, ua: q.headers['user-agent'] });
  if (u.pathname === '/mb/artist') {
    const s = P.get('query') || '';
    if (/Kent/.test(s)) return json(r, { artists: [
      { id: KENT_US, name: 'Kent', score: 100, type: 'Person', disambiguation: 'amerikansk rappare' },
      { id: KENT, name: 'Kent', score: 100, type: 'Group', country: 'SE' }] });
    if (/Joakim Berg/.test(s)) return json(r, { artists: [{ id: JB, name: 'Joakim Berg', score: 100, type: 'Person' }] });
    return json(r, { artists: [] });
  }
  if (u.pathname === '/mb/release-group') {
    const a = P.get('artist');
    if (a === KENT) return json(r, { 'release-group-count': 3, 'release-groups': [
      { id: ISOLA, title: 'Isola', 'primary-type': 'Album', 'first-release-date': '1997-02-12' },
      { id: KV, title: 'Kärleken väntar', 'primary-type': 'Single', 'first-release-date': '2002-01-01' },
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Box 1991–2008', 'primary-type': 'Album', 'secondary-types': ['Compilation'] }] });
    if (a === KENT_US) return json(r, { 'release-group-count': 1, 'release-groups': [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', title: 'Mixtape', 'primary-type': 'Album' }] });
    return json(r, { 'release-group-count': 0, 'release-groups': [] });
  }
  if (u.pathname === `/mb/artist/${KENT}`) return json(r, { id: KENT, name: 'Kent', type: 'Group', country: 'SE', area: { name: 'Sverige' }, 'begin-area': { name: 'Eskilstuna' },
    'life-span': { begin: '1990', end: '2016-12-17', ended: true }, genres: [{ name: 'alternative rock', count: 5 }, { name: 'rock', count: 9 }],
    relations: [
      { 'target-type': 'url', type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q1' } },
      { 'target-type': 'url', type: 'official homepage', url: { resource: 'https://www.kent.nu/' } },
      { 'target-type': 'url', type: 'free streaming', url: { resource: 'https://open.spotify.com/artist/x' } },
      { 'target-type': 'url', type: 'social network', url: { resource: 'javascript:alert(1)' } },
      { 'target-type': 'artist', type: 'member of band', artist: { id: JB, name: 'Joakim Berg' } }] });
  if (u.pathname === `/mb/artist/${KENT_US}`) return json(r, { id: KENT_US, name: 'Kent', type: 'Person', disambiguation: 'amerikansk rappare', relations: [] });
  if (u.pathname === `/mb/artist/${JB}`) return json(r, { id: JB, name: 'Joakim Berg', type: 'Person', 'life-span': { begin: '1970-10-12' },
    relations: [{ 'target-type': 'url', type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q9' } }] });
  if (u.pathname === `/mb/release-group/${ISOLA}`) return json(r, { id: ISOLA, relations: [{ 'target-type': 'url', type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q2' } }] });
  if (u.pathname.startsWith('/mb/release-group/')) return json(r, { relations: [] });
  if (u.pathname === '/wd/w/api.php') {
    const ids = P.get('ids') || P.get('entity');
    if (P.get('action') === 'wbgetentities') {
      if (ids === 'Q1') return json(r, { entities: { Q1: { sitelinks: { svwiki: { title: 'Kent (musikgrupp)' }, enwiki: { title: 'Kent (band)' } } } } });
      if (ids === 'Q2') return json(r, { entities: { Q2: { sitelinks: { enwiki: { title: 'Isola (album)' } } } } });
      if (ids === 'Q9') return json(r, { entities: { Q9: { sitelinks: { svwiki: { title: 'Joakim Berg' } } } } });
    }
    if (P.get('action') === 'wbgetclaims') {
      if (ids === 'Q1') return json(r, { claims: { P18: [{ rank: 'normal', mainsnak: { datavalue: { value: 'Kent band.jpg' } } }] } });
      if (ids === 'Q9') return json(r, { claims: { P18: [{ rank: 'normal', mainsnak: { datavalue: { value: 'Ond.jpg' } } }] } });
    }
    return json(r, {});
  }
  if (u.pathname === '/cm/wiki/Special:FilePath/Kent_band.jpg') { r.writeHead(302, { Location: `${base}/upload/kent.jpg` }); return r.end(); }
  // Omdirigering till en värd som inte är tillåten: får inte följas
  if (u.pathname === '/cm/wiki/Special:FilePath/Ond.jpg') { r.writeHead(302, { Location: `${evilBase}/stulen.jpg` }); return r.end(); }
  if (u.pathname === '/upload/kent.jpg' || u.pathname === '/upload/jb.jpg') { r.writeHead(200, { 'Content-Type': 'image/jpeg' }); return r.end(jpg); }
  if (u.pathname === '/wp/sv/api/rest_v1/page/summary/Kent_(musikgrupp)') return json(r, { type: 'standard', extract: 'Kent var en svensk rockgrupp från Eskilstuna.',
    content_urls: { desktop: { page: 'https://sv.wikipedia.org/wiki/Kent_(musikgrupp)' } } });
  if (u.pathname === '/wp/sv/api/rest_v1/page/summary/Joakim_Berg') return json(r, { type: 'standard', extract: 'Joakim Berg är en svensk musiker.', originalimage: { source: `${base}/upload/jb.jpg` } });
  if (u.pathname === '/wp/en/api/rest_v1/page/summary/Isola_(album)') return json(r, { type: 'standard', extract: 'Isola is the fourth studio album by Kent.' });
  if (u.pathname === '/lrc/get') {
    if (P.get('track_name') === 'Velvet' && P.get('artist_name') === 'Kent' && P.get('album_name') === 'Isola' && Math.abs(+P.get('duration') - 5) <= 1)
      return json(r, { id: 77, trackName: 'Velvet', artistName: 'Kent', duration: 5, instrumental: false, plainLyrics: 'Rad ett\nRad två', syncedLyrics: '[00:01.00]Rad ett\n[00:02.50]Rad två' });
    if (P.get('track_name') === 'Tyst') return json(r, { id: 78, trackName: 'Tyst', artistName: 'Kent', duration: 5, instrumental: true, plainLyrics: null, syncedLyrics: null });
    return json(r, { code: 404, message: 'Failed to find specified track' }, 404);
  }
  if (u.pathname === '/lrc/search') {
    if (P.get('track_name') === 'Kärleken väntar') return json(r, [
      { id: 1, trackName: 'Kärleken väntar', artistName: 'Kent', duration: 300, plainLyrics: 'Fel version' },
      { id: 2, trackName: 'Kärleken väntar', artistName: 'Kent', duration: 5, plainLyrics: 'Kärleken väntar\npå oss' }]);
    return json(r, []);
  }
  r.writeHead(404); r.end();
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${srv.address().port}`;
evilBase = `http://localhost:${srv.address().port}`; // annan värd (localhost ≠ 127.0.0.1)
Object.assign(process.env, { MUSICBRAINZ_URL: base + '/mb', WIKIDATA_URL: base + '/wd', WIKIPEDIA_URL: base + '/wp/{lang}', COMMONS_URL: base + '/cm', LRCLIB_URL: base + '/lrc' });

const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const S = await import('../server/subsonic.js');
const music = await import('../server/music.js');
const meta = await import('../server/musicmeta.js');
const app = await import('../server/app.js');
const web = http.createServer(app.handle);
await new Promise(r => web.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${web.address().port}`;
after(() => { srv.close(); web.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const ANNA = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('anna','x',1,0)").lastInsertRowid);
const BO = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('bo','x',0,0)").lastInsertRowid);
const tok = { [ANNA]: auth.createSession(ANNA, 'app'), [BO]: auth.createSession(BO, 'app') };
async function api(uid, p, { method = 'GET', body } = {}) {
  const r = await fetch(B + p, { method, headers: { Authorization: `Bearer ${tok[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.arrayBuffer() };
}

// ---------- musikbibliotek ----------
let LIB = 0;
const ID = {};
if (hasFfmpeg) {
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
  jpg = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=400x400', '-frames:v', '1', '-q:v', '2', '-f', 'mjpeg', 'pipe:1']);
  const song = (dir, file, tags) => { fs.mkdirSync(dir, { recursive: true });
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', ...Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]), path.join(dir, file)); };
  const L = path.join(MEDIA, 'Musik');
  for (const [i, title] of ['Saker man ser', 'Velvet', 'Tyst', 'Ingen text'].entries()) song(path.join(L, 'Kent', 'Isola'), `0${i + 1} - ${title}.mp3`, { title, artist: 'Kent', album: 'Isola', track: i + 1 });
  for (const [i, title] of ['Fem', 'Sex', 'Sju', 'Åtta', 'Nio', 'Tio', 'Elva', 'Tolv'].entries()) song(path.join(L, 'Kent', 'Isola'), `1${i} - ${title}.mp3`, { title, artist: 'Kent', album: 'Isola', track: i + 5 });
  song(path.join(L, 'Kent', 'Kärleken väntar'), '01 - Kärleken väntar.mp3', { title: 'Kärleken väntar', artist: 'Kent', album: 'Kärleken väntar', track: 1 });
  song(path.join(L, 'Joakim Berg', 'Solo'), '01 - Ensam.mp3', { title: 'Ensam', artist: 'Joakim Berg', album: 'Solo', track: 1 });
  fs.writeFileSync(path.join(L, 'Kent', 'Isola', '01 - Saker man ser.lrc'), '[00:00.50]Lokal text\n');
  LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Musik','music',?)", L).lastInsertRowid);
  await music.scanMusic(D.get('SELECT * FROM libraries WHERE id=?', LIB), {});
  const tr = (title) => D.get('SELECT id FROM tracks WHERE title=?', title).id;
  Object.assign(ID, { kent: D.get("SELECT id FROM artists WHERE name='Kent'").id, jb: D.get("SELECT id FROM artists WHERE name='Joakim Berg'").id,
    isola: D.get("SELECT id FROM albums WHERE title='Isola'").id, kv: D.get("SELECT id FROM albums WHERE title='Kärleken väntar'").id,
    local: tr('Saker man ser'), velvet: tr('Velvet'), tyst: tr('Tyst'), none: tr('Ingen text'), kvt: tr('Kärleken väntar') });
}

test('namn, albumtitlar, kontaktadress och fasta värdar', () => {
  assert.equal(meta.nameSim('The Knife', 'Knife'), 1);
  assert.equal(meta.nameSim('Björk', 'Bjork'), 1);
  assert.ok(meta.nameSim('Kent', 'Kents') > 0.8 && meta.nameSim('Kent', 'Abba') < 0.3);
  assert.equal(meta.nameSim('Кино', 'кино'), 1, 'icke-latinska namn jämförs också');
  assert.equal(meta.albumSim('Isola (Remastered 2011)', 'Isola'), 1);
  assert.equal(meta.albumSim('Hagnesta Hill [Deluxe Edition]', 'Hagnesta Hill'), 1);
  assert.equal(meta.validContact(' du@exempel.se '), 'du@exempel.se');
  assert.equal(meta.validContact(''), '');
  assert.throws(() => meta.validContact('x\r\nX-Evil: 1'), /e-postadress/);
  assert.throws(() => meta.validContact('inte en adress'));
  assert.match(meta.userAgent(), /^BraXhnTV\/\S+ \( test@exempel\.se \)$/);
  assert.ok(meta.hostOk(base + '/mb/artist'));
  assert.ok(meta.hostOk('https://upload.wikimedia.org/x.jpg'));
  assert.ok(!meta.hostOk('http://upload.wikimedia.org/x.jpg'), 'bildvärdar bara över https');
  assert.ok(!meta.hostOk('https://evil.example/x.jpg'));
  assert.ok(!meta.hostOk(evilBase + '/x'));
  assert.ok(!meta.hostOk('file:///etc/passwd'));
});

t('matchning: rätt Kent bland två med samma namn (albumtitlarna avgör), ingen träff hellre än fel', async () => {
  meta.clearCache();
  const m = await meta.findArtist('Kent', ['Isola', 'Kärleken väntar']);
  assert.equal(m?.mbid, KENT);
  // Utan albumträff och med två lika namn: ingen träff
  meta.clearCache();
  assert.equal(await meta.findArtist('Kent', ['Något helt annat']), null);
  assert.equal(await meta.findArtist('Okänd artist', ['x']), null);
  assert.equal(await meta.findArtist('Various Artists', ['x']), null);
  // User-Agent med kontaktadressen gick med varje anrop
  assert.ok(log.filter(l => l.path.startsWith('/mb/')).every(l => /^BraXhnTV\/.+test@exempel\.se/.test(l.ua)));
});

t('hastighetsbegränsning: högst ett anrop per paus till MusicBrainz', async () => {
  meta.clearCache();
  process.env.MUSICBRAINZ_GAP_MS = '150';
  try {
    const from = log.length;
    await meta.findArtist('Kent', ['Isola']);
    const mb = log.slice(from).filter(l => l.path.startsWith('/mb/'));
    assert.ok(mb.length >= 3, 'sökning + releasegrupper för kandidaterna');
    for (let i = 1; i < mb.length; i++) assert.ok(mb[i].at - mb[i - 1].at >= 140, `anrop ${i} kom ${mb[i].at - mb[i - 1].at} ms efter föregående`);
    // Cachade svar räknas inte: samma sökning igen gör inga anrop
    const n = log.length;
    await meta.findArtist('Kent', ['Isola']);
    assert.equal(log.length, n);
  } finally { process.env.MUSICBRAINZ_GAP_MS = '0'; }
});

t('bakgrundskön: biografi på svenska, fakta, bild via Commons, albumtyper och beskrivning, relaterade artister', async () => {
  meta.clearCache();
  await meta.queue(LIB);
  const k = meta.artistInfo(ID.kent);
  assert.equal(k.state, 1); assert.equal(k.mbid, KENT);
  assert.equal(k.bio, 'Kent var en svensk rockgrupp från Eskilstuna.'); assert.equal(k.bioLang, 'sv');
  assert.equal(k.type, 'Group'); assert.equal(k.begin, '1990'); assert.equal(k.end, '2016-12-17'); assert.equal(k.beginArea, 'Eskilstuna');
  assert.deepEqual(k.genres, ['rock', 'alternative rock']);
  assert.deepEqual(k.links.map(l => l.label), ['Officiell webbplats', 'Spotify', 'MusicBrainz'], 'javascript:-länkar tas inte med');
  assert.ok(k.image); assert.equal(k.imageSource, 'commons');
  assert.ok(fs.existsSync(meta.photoFile(ID.kent)));
  // Joakim Berg: Commons skickar vidare till en otillåten värd – den följs inte, bilden tas från Wikipedia i stället
  const j = meta.artistInfo(ID.jb);
  assert.equal(j.imageSource, 'wikipedia');
  assert.ok(!log.some(l => l.path === '/stulen.jpg'), 'otillåten omdirigering följdes inte');
  // Albumtyper och beskrivning (engelska när svenska saknas)
  const iso = meta.albumInfoOf(ID.isola), kv = meta.albumInfoOf(ID.kv);
  assert.equal(iso.type, 'album'); assert.equal(iso.mbid, ISOLA); assert.equal(iso.released, '1997-02-12');
  assert.equal(iso.description, 'Isola is the fourth studio album by Kent.'); assert.equal(iso.descLang, 'en');
  assert.equal(kv.type, 'single');
  assert.deepEqual(meta.relatedLocal(ID.kent).map(r => [r.name, r.relation]), [['Joakim Berg', 'Medlem']]);
  // Matchade artister hämtas inte om vid nästa skanning
  const n = log.length;
  await meta.queue(LIB);
  assert.equal(log.length, n);
});

t('artistsidans API: info, bild, albumtyper och relaterade; albumets beskrivning', async () => {
  const a = await api(BO, `/api/music/artists/${ID.kent}`);
  assert.equal(a.status, 200);
  assert.equal(a.data.name, 'Kent'); assert.ok(a.data.image); assert.equal(a.data.info.bio, 'Kent var en svensk rockgrupp från Eskilstuna.');
  assert.deepEqual(Object.fromEntries(a.data.albums.map(x => [x.title, x.type])), { Isola: 'album', 'Kärleken väntar': 'single' });
  assert.equal(a.data.related[0].id, ID.jb);
  assert.ok(Array.isArray(a.data.popular), 'befintliga fält finns kvar');
  const img = await api(BO, `/api/music/artists/${ID.kent}/image?w=160`);
  assert.equal(img.status, 200); assert.ok(img.data.byteLength > 500);
  assert.equal((await api(BO, `/api/music/artists/${ID.kent}/backdrop`)).status, 404);
  const list = await api(BO, `/api/music/${LIB}/artists`);
  assert.equal(list.data.find(x => x.id === ID.kent).image, true);
  const al = await api(BO, `/api/music/albums/${ID.isola}`);
  assert.equal(al.data.type, 'album'); assert.equal(al.data.info.description, 'Isola is the fourth studio album by Kent.');
});

t('"Fel artist?": bara administratör, sökning, manuell matchning låses, ingen av dem, lås upp', async () => {
  assert.equal((await api(BO, `/api/music/artists/${ID.kent}/match`)).status, 403);
  const s = await api(ANNA, `/api/music/artists/${ID.kent}/match`);
  assert.equal(s.status, 200); assert.equal(s.data.current.mbid, KENT);
  assert.deepEqual(s.data.results.map(x => x.mbid).sort(), [KENT, KENT_US].sort());
  assert.equal((await api(ANNA, `/api/music/artists/${ID.kent}/match`, { method: 'POST', body: { mbid: 'inte-ett-id' } })).status, 400);
  const m = await api(ANNA, `/api/music/artists/${ID.kent}/match`, { method: 'POST', body: { mbid: KENT_US } });
  assert.equal(m.status, 200);
  let k = meta.artistInfo(ID.kent);
  assert.equal(k.mbid, KENT_US); assert.equal(k.locked, true);
  assert.equal(D.get('SELECT event FROM audit ORDER BY id DESC LIMIT 1').event, 'artist_matched');
  await api(ANNA, `/api/music/artists/${ID.kent}/match`, { method: 'POST', body: { none: true } });
  k = meta.artistInfo(ID.kent);
  assert.equal(k.mbid, null); assert.equal(k.bio, null); assert.equal(k.image, false); assert.equal(k.locked, true);
  assert.equal((await api(BO, `/api/music/artists/${ID.kent}/image`)).status, 404);
  // Låst utan källa: bakgrundskön rör den inte
  meta.clearCache(); await meta.queue(LIB);
  assert.equal(meta.artistInfo(ID.kent).mbid, null);
  // Lås upp → matchas automatiskt igen
  await api(ANNA, `/api/music/artists/${ID.kent}/match`, { method: 'POST', body: { unlock: true } });
  await meta.queue(LIB);
  k = meta.artistInfo(ID.kent);
  assert.equal(k.mbid, KENT); assert.equal(k.locked, false); assert.ok(k.image);
});

t('låttexter: lokal .lrc först, LRCLIB som reserv (synkad, sökning med längd, instrumental), cache i databasen', async () => {
  const lrcCalls = () => log.filter(l => l.path.startsWith('/lrc/')).length;
  let n = lrcCalls();
  const loc = (await api(BO, `/api/music/tracks/${ID.local}/lyrics`)).data;
  assert.equal(loc.source, 'lrc'); assert.equal(loc.lines[0].text, 'Lokal text');
  assert.equal(lrcCalls(), n, 'ingen fråga till LRCLIB när filen har egen text');
  const v = (await api(BO, `/api/music/tracks/${ID.velvet}/lyrics`)).data;
  assert.equal(v.source, 'lrclib'); assert.equal(v.synced, true); assert.deepEqual(v.lines, [{ t: 1, text: 'Rad ett' }, { t: 2.5, text: 'Rad två' }]);
  n = lrcCalls();
  assert.deepEqual((await api(BO, `/api/music/tracks/${ID.velvet}/lyrics`)).data, v);
  assert.equal(lrcCalls(), n, 'andra gången från databasen');
  // /get hittar inget → /search, rätt längd vinner över fel version
  const kv = (await api(BO, `/api/music/tracks/${ID.kvt}/lyrics`)).data;
  assert.equal(kv.synced, false); assert.deepEqual(kv.lines.map(l => l.text), ['Kärleken väntar', 'på oss']);
  const ty = (await api(BO, `/api/music/tracks/${ID.tyst}/lyrics`)).data;
  assert.equal(ty.instrumental, true); assert.deepEqual(ty.lines, []);
  // Ingen text: sparas som "ingen" och frågas inte igen direkt
  assert.deepEqual((await api(BO, `/api/music/tracks/${ID.none}/lyrics`)).data.lines, []);
  n = lrcCalls();
  await api(BO, `/api/music/tracks/${ID.none}/lyrics`);
  assert.equal(lrcCalls(), n);
  // Avstängt: bara lokala texter
  D.setSetting('music_lyrics_online', '0');
  D.run('DELETE FROM track_lyrics');
  assert.deepEqual((await api(BO, `/api/music/tracks/${ID.velvet}/lyrics`)).data.lines, []);
  D.setSetting('music_lyrics_online', '1');
});

t('Subsonic: getArtistInfo2/getArtistInfo/getAlbumInfo2 med biografi och signerade bilder, getLyricsBySongId från LRCLIB', async () => {
  const pw = S.createPassword(BO, { ip: '127.0.0.1', trusted: true });
  const rest = async (m, p = {}) => (await (await fetch(`${B}/rest/${m}?${new URLSearchParams({ apiKey: pw, v: '1.16.1', c: 'test', f: 'json', ...p })}`)).json())['subsonic-response'];
  const i = (await rest('getArtistInfo2', { id: `ar-${ID.kent}` })).artistInfo2;
  assert.equal(i.biography, 'Kent var en svensk rockgrupp från Eskilstuna.'); assert.equal(i.musicBrainzId, KENT);
  assert.match(i.largeImageUrl, new RegExp(`^${B}/api/music/pubimg/artist/${ID.kent}/[0-9a-f]{32}\\?w=720$`));
  assert.equal(i.similarArtist[0].id, `ar-${ID.jb}`);
  // Bildadressen fungerar utan inloggning, men bara med rätt signatur och för rätt bild
  const img = await fetch(i.largeImageUrl);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(i.largeImageUrl.replace(/[0-9a-f]{32}/, '0'.repeat(32)))).status, 404);
  assert.equal((await fetch(i.largeImageUrl.replace(`/artist/${ID.kent}/`, `/artist/${ID.jb}/`))).status, 404);
  assert.equal((await fetch(i.largeImageUrl.replace('/artist/', '/album/'))).status, 404);
  const xml = await (await fetch(`${B}/rest/getArtistInfo?${new URLSearchParams({ apiKey: pw, v: '1.16.1', c: 'test', id: `ar-${ID.kent}` })}`)).text();
  assert.match(xml, /<artistInfo><biography>Kent var en svensk rockgrupp från Eskilstuna\.<\/biography>/);
  const al = (await rest('getAlbumInfo2', { id: `al-${ID.isola}` })).albumInfo;
  assert.equal(al.notes, 'Isola is the fourth studio album by Kent.'); assert.equal(al.musicBrainzId, ISOLA);
  assert.equal((await rest('getAlbumInfo2', { id: 'al-999999' })).error.code, 70);
  // Artistens omslag i appen = artistbilden
  const cov = await fetch(`${B}/rest/getCoverArt?${new URLSearchParams({ apiKey: pw, v: '1.16.1', c: 'test', id: `ar-${ID.kent}` })}`);
  assert.equal(cov.status, 200);
  const ly = (await rest('getLyricsBySongId', { id: `tr-${ID.velvet}` })).lyricsList.structuredLyrics[0];
  assert.equal(ly.synced, true); assert.deepEqual(ly.line, [{ start: 1000, value: 'Rad ett' }, { start: 2500, value: 'Rad två' }]);
  assert.equal((await rest('getLyrics', { artist: 'Kent', title: 'Velvet' })).lyrics.value, 'Rad ett\nRad två');
});

t('administrationen: inställningar, nyckeln lämnas aldrig ut, ogiltig kontaktadress ger 400', async () => {
  assert.equal((await api(BO, '/api/music/meta')).status, 403);
  const r = await api(ANNA, '/api/music/meta', { method: 'PUT', body: { contact: 'anna@exempel.se', fanartKey: 'abcdef0123456789abcdef', lyricsBackground: false } });
  assert.equal(r.status, 200);
  assert.equal(r.data.contact, 'anna@exempel.se'); assert.equal(r.data.fanartKeySet, true);
  assert.ok(!JSON.stringify(r.data).includes('abcdef0123456789abcdef'), 'nyckeln skickas aldrig tillbaka');
  assert.match(meta.userAgent(), /anna@exempel\.se/);
  assert.equal((await api(ANNA, '/api/music/meta', { method: 'PUT', body: { contact: 'a\nb' } })).status, 400);
  assert.equal((await api(ANNA, '/api/music/meta', { method: 'PUT', body: { fanartKey: 'kort!' } })).status, 400);
  D.setSetting('fanart_api_key', '');
});
