// Fotobibliotek: EXIF-läsaren (exif.js) med testbilder från ffmpeg och handskrivna EXIF-block, och mot en riktig
// server skanningen (photos.js: datum, orientering, GPS, mappar, videoklipp, HEIC utan stöd, raderingsskyddet),
// API:t (tidslinje, månad, album, Den här dagen, information, bilder, original, favoriter) och behörigheten
// (biblioteksbehörighet, barnprofiler, nedladdning, appar). Kräver ffmpeg som övriga servertester.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { parseImage, parseTiff, exifDate, sniff, heicFromVersion, iso6709 } from '../server/exif.js';
import { tiff, phoneExif, jpegWithExif, pngWithExif, webpWithExif, heifWithExif, heifIlocBomb } from './helpers/exif-builder.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-photo-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config'), PICS = path.join(MEDIA, 'Foton'), OTHER = path.join(MEDIA, 'Filmer');
const PORT = 24000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, admin = '', webCookie = '';
const S = {};
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...a]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
/** Bild från ffmpeg (lavfi) i formatet som filändelsen anger */
function still(file, size = '400x200', src = 'testsrc') {
  ff('-f', 'lavfi', '-i', `${src}=size=${size}`, '-frames:v', '1', file);
  return fs.readFileSync(file);
}
async function req(p, { method = 'GET', body, tok = admin, cookie = '', raw = false } = {}) {
  const h = {};
  if (tok && !cookie) h.authorization = 'Bearer ' + tok;
  if (cookie) { h.cookie = cookie; h.origin = B; }
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  if (raw) return r;
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
const login = async (name, password) => (await req('/api/login', { method: 'POST', body: { name, password, app: true }, tok: '' })).data.token;
async function waitScan() {
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    const s = (await req('/api/scan')).data;
    if (!s.running && !s.queued && s.last) return s;
  }
  throw new Error('skanningen blev inte klar');
}
const dims = (buf) => {
  const f = path.join(ROOT, `probe-${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(f, buf);
  try { return execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim(); }
  finally { fs.rmSync(f, { force: true }); }
};

// ---------- EXIF-läsaren ----------
t('EXIF i JPEG: datum, kamera, objektiv, exponering, orientering och GPS (little och big endian)', () => {
  const jpg = still(path.join(ROOT, 'a.jpg'));
  for (const le of [true, false]) {
    const r = parseImage(jpegWithExif(jpg, phoneExif({ le, orientation: 6, lat: 59.329323, lon: -18.068581 })));
    assert.equal(r.format, 'jpeg');
    // Orientering 6 = vriden ett kvarts varv: visningens bredd är filens höjd
    assert.deepEqual([r.width, r.height, r.orientation], [200, 400, 6]);
    assert.equal(r.exif.date, Date.UTC(2021, 5, 15, 14, 5, 30) / 1000, 'väggklockan som UTC');
    assert.equal(r.exif.offset, '+02:00');
    assert.equal(r.exif.make, 'Apple'); assert.equal(r.exif.model, 'iPhone 12');
    assert.equal(r.exif.lens, 'iPhone 12 back camera 4.2mm f/1.6');
    assert.equal(r.exif.fnumber, 1.6); assert.equal(r.exif.exposure, 1 / 120); assert.equal(r.exif.iso, 64); assert.equal(r.exif.focal, 4.2);
    assert.equal(r.exif.lat, 59.329323); assert.equal(r.exif.lon, -18.068581, 'väster blir negativt');
    assert.equal(r.exif.alt, 12.5);
  }
});

t('EXIF i PNG (eXIf), WebP (EXIF-chunk) och GIF utan EXIF', () => {
  const png = parseImage(pngWithExif(still(path.join(ROOT, 'a.png'), '320x240'), phoneExif({ date: '2024:12:24 15:00:00', lat: -33.8688, lon: 151.2093 })));
  assert.deepEqual([png.format, png.width, png.height], ['png', 320, 240]);
  assert.equal(png.exif.date, Date.UTC(2024, 11, 24, 15) / 1000);
  assert.ok(png.exif.lat < 0 && png.exif.lon > 0, 'södra halvklotet');
  const webp = parseImage(webpWithExif(still(path.join(ROOT, 'a.webp'), '330x250'), phoneExif({ date: '2023:07:01 12:00:00' })));
  assert.deepEqual([webp.format, webp.width, webp.height], ['webp', 330, 250]);
  assert.equal(webp.exif.date, Date.UTC(2023, 6, 1, 12) / 1000);
  const gif = parseImage(still(path.join(ROOT, 'a.gif'), '64x48'));
  assert.deepEqual([gif.format, gif.width, gif.height, gif.orientation], ['gif', 64, 48, 1]);
  assert.deepEqual(gif.exif, {});
});

test('EXIF i HEIC: objektet hittas via iinf/iloc, även efter den lästa början; irot vrider storleken', () => {
  const t1 = phoneExif({ date: '2022:08:09 07:08:09', orientation: 6, lat: 57.7, lon: 11.97 });
  const h = heifWithExif(t1);
  assert.equal(sniff(h), 'heic');
  const r = parseImage(h);
  assert.deepEqual([r.format, r.width, r.height], ['heic', 4032, 3024], 'största ispe (rutnätet), inte rutornas');
  assert.equal(r.orientation, 1, 'HEIF: rotationen står i behållaren, EXIF-orienteringen gäller inte');
  assert.equal(r.exif.date, Date.UTC(2022, 7, 9, 7, 8, 9) / 1000);
  assert.equal(r.exif.model, 'iPhone 12');
  // EXIF-objektet långt in i filen: bara början läses först, resten med readAt
  const far = heifWithExif(t1, { padding: 300000, irot: 1 });
  const head = far.subarray(0, 4096);
  assert.equal(parseImage(head).exif.date, undefined, 'utan readAt finns inget EXIF i början');
  const r2 = parseImage(head, (o, l) => far.subarray(o, o + l));
  assert.equal(r2.exif.date, Date.UTC(2022, 7, 9, 7, 8, 9) / 1000);
  assert.deepEqual([r2.width, r2.height], [3024, 4032], 'irot 90° byter bredd och höjd');
});

test('EXIF-läsaren tål trasiga och fientliga filer', () => {
  const good = phoneExif();
  // Avklippt på alla längder: inget undantag
  for (let n = 0; n < good.length; n += 7) parseTiff(good.subarray(0, n));
  const jpg = jpegWithExif(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]), good);
  for (let n = 0; n < jpg.length; n += 5) parseImage(jpg.subarray(0, n));
  // En IFD som pekar på sig själv (ExifIFD = IFD0) och enorma antal poster ger ingen slinga
  const loop = tiff({ ifd0: [[0x0112, 'short', 3], [0x8769, 'long', 8]] });
  loop.writeUInt32LE(8, 8 + 2 + 12 + 8); // ExifIFD-pekaren → IFD0
  assert.equal(parseTiff(loop).orientation, 3);
  const huge = Buffer.alloc(64); huge.write('II', 0, 'latin1'); huge.writeUInt16LE(42, 2); huge.writeUInt32LE(8, 4); huge.writeUInt16LE(65535, 8);
  assert.deepEqual(parseTiff(huge), {});
  // Ogiltiga datum och koordinater ignoreras
  assert.equal(exifDate('0000:00:00 00:00:00'), null);
  assert.equal(exifDate('2021:02:30 10:00:00'), null);
  assert.equal(exifDate('2021:02:28 10:00:00'), Date.UTC(2021, 1, 28, 10) / 1000);
  const zero = parseTiff(phoneExif({ lat: 0, lon: 0 }));
  assert.equal(zero.lat, undefined, '0,0 är ingen position');
  // Slumpmässigt skräp
  for (let i = 0; i < 200; i++) { const b = Buffer.from(Array.from({ length: 64 + i }, () => Math.floor(Math.random() * 256))); b.write(i % 2 ? 'MM\0*' : 'II*\0', 0, 'latin1'); parseTiff(b); parseImage(Buffer.concat([Buffer.from([0xFF, 0xD8]), b])); }
});

test('EXIF-läsaren: fientlig HEIC med tomma iloc-utsträckningar tar linjär tid (blockerade servern)', () => {
  const b = heifIlocBomb();
  assert.ok(b.length < 70000);
  const t0 = performance.now();
  assert.equal(parseImage(b).format, 'heic');
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `tog ${Math.round(ms)} ms`);
});

test('HEIC-stöd avgörs av ffmpeg-versionen och ISO 6709-platser tolkas', () => {
  assert.equal(heicFromVersion('ffmpeg version 5.1.6-0+deb12u1 Copyright'), false);
  assert.equal(heicFromVersion('ffmpeg version 6.1.1-3ubuntu5'), false);
  assert.equal(heicFromVersion('ffmpeg version 7.1.1-1+b1'), true);
  assert.equal(heicFromVersion('ffmpeg version n8.0'), true);
  assert.deepEqual(iso6709('+59.3293+018.0686+012.000/'), { lat: 59.3293, lon: 18.0686, alt: 12 });
  assert.equal(iso6709('+00.0000+000.0000/'), null);
});

// ---------- servern ----------
const MEMORY_YEAR = new Date().getFullYear() - 3;
const todayMD = () => { const d = new Date(); return [d.getMonth() + 1, d.getDate()]; };
before(async () => {
  if (!hasFfmpeg) return;
  for (const d of [path.join(PICS, '2021', 'Sommar'), path.join(PICS, '2022'), OTHER]) fs.mkdirSync(d, { recursive: true });
  const jpg = still(path.join(ROOT, 'base.jpg'), '400x200');
  fs.writeFileSync(path.join(PICS, '2021', 'Sommar', 'IMG_0001.jpg'), jpegWithExif(jpg, phoneExif({ date: '2021:06:15 14:05:30', orientation: 6, lat: 59.329323, lon: 18.068581 })));
  fs.writeFileSync(path.join(PICS, '2021', 'Sommar', 'IMG_0002.jpg'), jpegWithExif(jpg, phoneExif({ date: '2021:06:15 18:00:00' })));
  fs.writeFileSync(path.join(PICS, '2021', 'IMG_0003.jpg'), jpegWithExif(jpg, phoneExif({ date: '2021:07:01 09:00:00' })));
  const [m, d] = todayMD();
  fs.writeFileSync(path.join(PICS, '2022', 'minne.jpg'), jpegWithExif(jpg, phoneExif({ date: `${MEMORY_YEAR}:${String(m).padStart(2, '0')}:${String(d).padStart(2, '0')} 12:00:00` })));
  fs.writeFileSync(path.join(PICS, 'skärm.png'), pngWithExif(still(path.join(ROOT, 'b.png'), '320x240'), phoneExif({ date: '2024:12:24 15:00:00' })));
  fs.writeFileSync(path.join(PICS, 'webb.webp'), webpWithExif(still(path.join(ROOT, 'b.webp'), '320x240'), phoneExif({ date: '2023:07:01 12:00:00' })));
  still(path.join(PICS, 'anim.gif'), '160x120');
  fs.writeFileSync(path.join(PICS, 'iphone.heic'), heifWithExif(phoneExif({ date: '2022:08:09 07:08:09' })));
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata', 'com.apple.quicktime.creationdate=2023-07-01T18:30:00+0200', '-metadata', 'location=+59.3293+018.0686/',
    '-movflags', '+use_metadata_tags', path.join(PICS, 'klipp.mov'));
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(OTHER, 'Film (2020).mp4'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', SCAN_INTERVAL: '0', PHOTO_HEIC: '0' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  srv.stdout.on('data', () => {});
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });

t('förberedelse: konto, fotobibliotek och filmbibliotek skannas', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin', PW);
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: B }, body: JSON.stringify({ name: 'admin', password: PW }) });
  webCookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Okänd', type: 'bilder', path: PICS } })).status, 400);
  S.P = (await req('/api/libraries', { method: 'POST', body: { name: 'Foton', type: 'photo', path: PICS } })).data.id;
  S.F = (await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: OTHER } })).data.id;
  assert.ok(S.P && S.F);
  await waitScan();
  // Varningen syns i skanningens status (en ny skanning av fotobiblioteket ensamt)
  await req(`/api/libraries/${S.P}/scan`, { method: 'POST' });
  const s = await waitScan();
  assert.ok(s.warnings.some(w => /HEIC/.test(w) && /7\.1/.test(w)), 'tydlig varning om HEIC utan stöd: ' + JSON.stringify(s.warnings));
});

t('skanningen: datum ur EXIF, mappar, storlek efter orienteringen, GPS och videoklipp', async () => {
  const tl = (await req(`/api/photos/lib/${S.P}/timeline`)).data;
  assert.equal(tl.total, 8, 'sju bilder och ett videoklipp – HEIC hoppas över');
  // GIF:en saknar EXIF – filens tid (i dag) gäller; nyast först
  assert.deepEqual(tl.days.slice(0, 2).map(d => d[0]).slice(1), ['2024-12-24']);
  assert.deepEqual(tl.days.find(d => d[0] === '2021-06-15'), ['2021-06-15', 2]);
  const june = (await req(`/api/photos/lib/${S.P}/month/2021-06`)).data.photos;
  assert.equal(june.length, 2);
  assert.ok(june[0].t > june[1].t, 'senaste först inom dagen');
  const first = june.find(p => p.t === Date.UTC(2021, 5, 15, 14, 5, 30) / 1000);
  assert.ok(first, 'tiden är väggklockan ur EXIF');
  assert.deepEqual([first.w, first.h], [200, 400], 'orientering 6: stående');
  S.img = first.id;
  const info = (await req(`/api/photos/${S.img}`)).data;
  assert.equal(info.folder, '2021/Sommar');
  assert.equal(info.camera.model, 'iPhone 12');
  assert.deepEqual([info.gps.lat, info.gps.lon], [59.329323, 18.068581]);
  assert.equal(info.canDownload, true);
  assert.equal(info.path, undefined, 'serverns sökväg lämnas inte ut');
  const jul = (await req(`/api/photos/lib/${S.P}/month/2023-07`)).data.photos;
  const clip = jul.find(p => p.v);
  assert.ok(clip && clip.item, 'videoklippet har en rad för spelaren');
  assert.equal(clip.t, Date.UTC(2023, 6, 1, 18, 30) / 1000, 'Apples datum med tidszon = lokal tid');
  S.clip = clip.id; S.clipItem = clip.item;
  const ci = (await req(`/api/photos/${S.clip}`)).data;
  assert.deepEqual([ci.gps.lat, ci.gps.lon], [59.3293, 18.0686]);
  assert.ok(ci.duration > 2);
  // Klippet går att spela med den vanliga spelaren …
  const pb = await req(`/api/items/${S.clipItem}/playback`);
  assert.equal(pb.status, 200, JSON.stringify(pb.data));
  // … men syns inte bland filmerna: inte i biblioteket, inte på startsidan och inte i sök
  const libs = (await req('/api/libraries', { cookie: webCookie })).data;
  assert.equal(libs.find(l => l.id === S.P).count, 8);
  const home = (await req('/api/home')).data;
  assert.ok(!home.rows.some(r => r.library.id === S.P), 'ingen "Nytt i Foton"-rad');
  assert.ok(!home.rows.flatMap(r => r.items).some(i => i.id === S.clipItem));
  const sr = (await req('/api/search/all?q=klipp')).data;
  assert.ok(!JSON.stringify(sr).includes(`"id":${S.clipItem},`), 'klippet hittas inte i sök');
});

t('album = mappar, Den här dagen och startsidans minnen', async () => {
  const root = (await req(`/api/photos/lib/${S.P}/albums`)).data;
  assert.deepEqual(root.folders.map(f => f.name).sort(), ['2021', '2022']);
  assert.equal(root.folders.find(f => f.name === '2021').count, 3, 'undermapparna räknas med');
  assert.equal(root.photos.length, 4, 'png, webp, gif och klippet ligger direkt i mappen');
  const sub = (await req(`/api/photos/lib/${S.P}/albums?folder=${encodeURIComponent('2021/Sommar')}`)).data;
  assert.equal(sub.photos.length, 2); assert.equal(sub.parent, '2021'); assert.equal(sub.name, 'Sommar');
  assert.equal((await req(`/api/photos/lib/${S.P}/albums?folder=..%2F..`)).status, 400);
  assert.equal((await req(`/api/photos/lib/${S.P}/month/2021-6`)).status, 400);
  const mem = (await req('/api/photos/memories')).data;
  assert.equal(mem.groups.length, 1);
  assert.equal(mem.groups[0].year, MEMORY_YEAR); assert.equal(mem.groups[0].yearsAgo, 3); assert.equal(mem.groups[0].photos.length, 1);
  assert.equal((await req('/api/photos/memories?date=2021-06-15')).data.groups.length, 0, 'bara tidigare år');
  assert.equal((await req('/api/photos/memories?date=2022-06-15')).data.groups[0].count, 2);
  assert.equal((await req('/api/photos/memories?date=igår')).status, 400);
  // Startsidan: nytt fält för webben, inte för appar
  const web = (await req('/api/home', { cookie: webCookie })).data;
  assert.equal(web.photoMemories.length, 1);
  assert.equal(web.photoMemories[0].photos, undefined, 'bara omslag och antal');
  assert.ok(web.homeLayout.order.includes('memories'));
  assert.deepEqual((await req('/api/home')).data.photoMemories, [], 'apptoken: tomt');
});

t('bilder: miniatyrer med orienteringen tillämpad, originalet och format som webbläsaren inte kan visa', async () => {
  const small = await req(`/api/photos/${S.img}/img?w=160`);
  assert.equal(small.status, 200);
  assert.equal(small.headers.get('content-type'), 'image/jpeg');
  assert.equal(dims(small.data), '160,320', 'filen (400×200) skalas till 160 och vrids sedan ett kvarts varv');
  const orig = await req(`/api/photos/${S.img}/img`);
  assert.equal(orig.data.length, fs.statSync(path.join(PICS, '2021', 'Sommar', 'IMG_0001.jpg')).size, 'utan w: originalet (webbläsaren vrider själv)');
  const big = await req(`/api/photos/${S.img}/img?w=2560`);
  assert.equal(big.status, 200);
  const frame = await req(`/api/photos/${S.clip}/img?w=320`);
  assert.equal(frame.status, 200, 'videoklippets stillbild');
  assert.equal(dims(frame.data), '320,180');
  const dl = await req(`/api/photos/${S.img}/original`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="IMG_0001\.jpg"/);
  // Platshållarfärg och förgjorda miniatyrer i bakgrunden
  for (let i = 0; i < 120; i++) {
    if ((await req(`/api/photos/lib/${S.P}/month/2021-06`)).data.photos.every(p => p.c)) break;
    await sleep(250);
  }
  assert.ok((await req(`/api/photos/lib/${S.P}/month/2021-06`)).data.photos.every(p => /^#[0-9a-f]{6}$/.test(p.c)), 'platshållarfärg');
});

t('favoriter per profil', async () => {
  assert.equal((await req(`/api/photos/${S.img}/favorite`, { method: 'POST', body: { on: true } })).data.fav, true);
  const fav = (await req(`/api/photos/lib/${S.P}/timeline?fav=1`)).data;
  assert.equal(fav.total, 1); assert.equal(fav.favorites, 1);
  assert.equal((await req(`/api/photos/lib/${S.P}/month/2021-06?fav=1`)).data.photos[0].fav, 1);
  assert.equal((await req(`/api/photos/${S.img}`)).data.fav, 1);
  assert.equal((await req(`/api/photos/${S.img}/favorite`, { method: 'POST', body: { on: false } })).data.fav, false);
  assert.equal((await req(`/api/photos/lib/${S.P}/timeline?fav=1`)).data.total, 0);
});

t('behörighet: bibliotek, barnprofiler (standard nej), nedladdning och appar', async () => {
  // bo får bara filmbiblioteket och inte ladda ner; kalle allt men ingen nedladdning
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW, libraries: [S.F] } })).status, 200);
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'kalle', password: PW, canDownload: false } })).status, 200);
  const bo = await login('bo', PW), kalle = await login('kalle', PW);
  for (const p of [`/api/photos/lib/${S.P}/timeline`, `/api/photos/lib/${S.P}/month/2021-06`, `/api/photos/lib/${S.P}/albums`, `/api/photos/${S.img}`,
    `/api/photos/${S.img}/img?w=160`, `/api/photos/${S.img}/original`, `/api/items/${S.clipItem}`, `/api/items/${S.clipItem}/playback`]) {
    const r = await req(p, { tok: bo });
    assert.ok(r.status === 404 || r.status === 403, `${p} → ${r.status}`);
  }
  assert.equal((await req(`/api/photos/${S.img}/favorite`, { method: 'POST', body: { on: true }, tok: bo })).status, 404);
  assert.deepEqual((await req('/api/photos/memories', { tok: bo })).data.groups, []);
  assert.deepEqual((await req('/api/photos/libraries', { tok: bo })).data, []);
  // kalle ser fotona men får inte ladda ner originalet
  assert.equal((await req(`/api/photos/${S.img}`, { tok: kalle })).data.canDownload, false);
  assert.equal((await req(`/api/photos/${S.img}/original`, { tok: kalle })).status, 403);
  assert.equal((await req(`/api/photos/${S.img}/img?w=160`, { tok: kalle })).status, 200, 'visning är inte nedladdning');
  // Barnprofil: ser inte fotobiblioteket förrän administratören tillåter det
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  const kid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  const kt = (await req('/api/profiles/switch', { method: 'POST', body: { id: kid } })).data.token;
  admin = await login('admin', PW); // profilbytet tog bort administratörens token
  const web2 = (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: B }, body: JSON.stringify({ name: 'admin', password: PW }) })).headers.get('set-cookie').split(';')[0];
  const kidCookieRes = await fetch(B + '/api/profiles/switch', { method: 'POST', headers: { 'content-type': 'application/json', origin: B, cookie: web2 }, body: JSON.stringify({ id: kid }) });
  const kidCookie = kidCookieRes.headers.get('set-cookie').split(';')[0];
  assert.equal((await req(`/api/photos/lib/${S.P}/timeline`, { tok: kt })).status, 404);
  assert.equal((await req(`/api/photos/${S.img}/img?w=160`, { tok: kt })).status, 404);
  assert.equal((await req(`/api/items/${S.clipItem}`, { tok: kt })).status, 403);
  assert.ok(!(await req('/api/libraries', { cookie: kidCookie })).data.some(l => l.id === S.P));
  assert.equal((await req(`/api/libraries/${S.P}`, { method: 'PUT', body: { kids: true } })).status, 200);
  assert.equal((await req(`/api/photos/lib/${S.P}/timeline`, { tok: kt })).data.total, 8);
  assert.equal((await req(`/api/photos/${S.img}/img?w=160`, { tok: kt })).status, 200);
  assert.equal((await req(`/api/items/${S.clipItem}`, { tok: kt })).status, 200, 'klippet går att spela när biblioteket tillåts');
  assert.ok((await req('/api/libraries', { cookie: kidCookie })).data.some(l => l.id === S.P));
  assert.ok(!(await req('/api/home', { tok: kt })).data.continue.some(i => i.id === S.clipItem));
  assert.equal((await req(`/api/libraries/${S.P}`, { method: 'PUT', body: { kids: false } })).status, 200);
  assert.equal((await req(`/api/photos/lib/${S.P}/timeline`, { tok: kt })).status, 404);
  // Apparna känner inte till fotobibliotek: de listas inte för apptoken (webben ser dem)
  assert.ok(!(await req('/api/libraries')).data.some(l => l.type === 'photo'));
  assert.ok((await req('/api/libraries', { cookie: webCookie })).data.some(l => l.type === 'photo'));
});

t('raderingsskyddet: en saknad mapp tar inte bort något, en borttagen fil tas bort', async () => {
  const before = (await req(`/api/photos/lib/${S.P}/timeline`)).data.total;
  fs.renameSync(PICS, PICS + '-flyttad');
  await req(`/api/libraries/${S.P}/scan`, { method: 'POST' });
  const s = await waitScan();
  assert.equal((await req(`/api/photos/lib/${S.P}/timeline`)).data.total, before, 'inget togs bort');
  assert.ok(s.warnings.some(w => /inga foton tas bort/.test(w)), JSON.stringify(s.warnings));
  fs.renameSync(PICS + '-flyttad', PICS);
  fs.rmSync(path.join(PICS, '2021', 'IMG_0003.jpg'));
  fs.rmSync(path.join(PICS, 'klipp.mov'));
  await req(`/api/libraries/${S.P}/scan`, { method: 'POST' });
  await waitScan();
  assert.equal((await req(`/api/photos/lib/${S.P}/timeline`)).data.total, before - 2);
  assert.equal((await req(`/api/items/${S.clipItem}`)).status, 404, 'klippets rad i items togs bort med det');
  // En mapp som tas bort ur biblioteket glöms direkt
  const extra = path.join(MEDIA, 'Extra');
  fs.mkdirSync(extra, { recursive: true });
  fs.copyFileSync(path.join(PICS, '2022', 'minne.jpg'), path.join(extra, 'x.jpg'));
  assert.equal((await req(`/api/libraries/${S.P}`, { method: 'PUT', body: { paths: [PICS, extra] } })).status, 200);
  await waitScan();
  assert.equal((await req(`/api/photos/lib/${S.P}/timeline`)).data.total, before - 1);
  assert.equal((await req(`/api/libraries/${S.P}`, { method: 'PUT', body: { paths: [PICS] } })).status, 200);
  await waitScan();
  assert.equal((await req(`/api/photos/lib/${S.P}/timeline`)).data.total, before - 2);
});
