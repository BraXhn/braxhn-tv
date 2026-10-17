// Bilder i rätt storlek (?w=): fasta bredder, ingen förstoring, cache, ogiltiga värden och behörighet. Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-img-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const IMAGES = path.join(CONFIG, 'images'), VARIANTS = path.join(CONFIG, 'cache', 'img');
const PORT = 23000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, token = '';
const S = {};

async function req(p, { tok = token, headers = {} } = {}) {
  const h = { ...headers };
  if (tok) h.authorization = 'Bearer ' + tok;
  const r = await fetch(B + p, { headers: h });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const post = async (p, body, tok = token) => {
  const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** Bredd och höjd på en JPEG (ffprobe) */
const dims = (buf) => {
  const f = path.join(ROOT, 'probe.jpg'); fs.writeFileSync(f, buf);
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim().split(',').map(Number);
  return { w, h };
};
const variants = (key) => { try { return fs.readdirSync(path.join(VARIANTS, key)).sort(); } catch { return []; } };

before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(path.join(MEDIA, 'Filmer'), { recursive: true });
  const f = path.join(MEDIA, 'Filmer', 'Film (2020).mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
  fs.copyFileSync(f, path.join(MEDIA, 'Filmer', 'Vuxen (2019).mp4'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

t('förberedelse: konto, bibliotek och bilder i TMDB-storlek', async () => {
  assert.equal((await post('/api/setup', { name: 'admin', password: PW }, '')).status, 200);
  const l = await post('/api/login', { name: 'admin', password: PW, app: true }, '');
  token = l.data.token;
  assert.equal((await post('/api/libraries', { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') })).status, 200);
  for (let i = 0; i < 120; i++) { await sleep(500); const r = await req('/api/scan'); if (!r.data.running && !r.data.analysis?.running && r.data.last) break; }
  const lib = (await req('/api/libraries')).data[0];
  const items = (await req(`/api/libraries/${lib.id}/items`)).data.items;
  S.film = items.find(i => i.title === 'Film').id; S.vuxen = items.find(i => i.title === 'Vuxen').id;
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare('UPDATE items SET age=7 WHERE id=?').run(S.film);
  db.prepare('UPDATE items SET age=15 WHERE id=?').run(S.vuxen);
  db.close();
  for (const id of [S.film, S.vuxen]) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=500x750', '-frames:v', '1', '-q:v', '2', path.join(IMAGES, `${id}-poster.jpg`)]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720', '-frames:v', '1', '-q:v', '2', path.join(IMAGES, `${id}-backdrop.jpg`)]);
  }
});

t('?w= skalas till närmaste fasta bredd uppåt, proportionerna behålls', async () => {
  const orig = await req(`/api/image/${S.film}/poster`);
  assert.equal(orig.status, 200);
  assert.deepEqual(dims(orig.data), { w: 500, h: 750 });
  const r = await req(`/api/image/${S.film}/poster?w=200`); // → 240
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=86400');
  assert.ok(r.headers.get('etag'));
  assert.deepEqual(dims(r.data), { w: 240, h: 360 });
  assert.ok(r.data.length < orig.data.length / 2, `${r.data.length} mot ${orig.data.length}`);
  assert.deepEqual(dims((await req(`/api/image/${S.film}/poster?w=320`)).data), { w: 320, h: 480 });
  assert.deepEqual(dims((await req(`/api/image/${S.film}/backdrop?w=700`)).data), { w: 720, h: 406 });
  // Bara de fasta bredderna hamnar i cachen
  assert.deepEqual(variants(`images_${S.film}-poster.jpg`).map(f => f.split('-')[0]), ['240', '320']);
});

t('ingen förstoring: smalare källa ger originalet', async () => {
  const orig = await req(`/api/image/${S.film}/poster`);
  const r = await req(`/api/image/${S.film}/poster?w=720`);
  assert.deepEqual(r.data, orig.data);
  assert.equal(variants(`images_${S.film}-poster.jpg`).filter(f => f.startsWith('720-')).length, 0);
  // Större än största bredden: originalet
  assert.deepEqual((await req(`/api/image/${S.film}/backdrop?w=4000`)).data, (await req(`/api/image/${S.film}/backdrop`)).data);
});

t('ogiltiga ?w= ignoreras (originalet, ingen cachefil)', async () => {
  const orig = (await req(`/api/image/${S.film}/backdrop`)).data;
  for (const w of ['abc', '-5', '0', '1e3', '240.5', '999999', '']) {
    const r = await req(`/api/image/${S.film}/backdrop?w=${encodeURIComponent(w)}`);
    assert.equal(r.status, 200, w);
    assert.deepEqual(r.data, orig, w);
  }
  assert.deepEqual(variants(`images_${S.film}-backdrop.jpg`).map(f => f.split('-')[0]), ['720']);
});

t('cache: andra förfrågan skalar inte om, samtidiga förfrågningar ger en skalning', async () => {
  const key = `images_${S.film}-backdrop.jpg`;
  const parallel = await Promise.all(Array.from({ length: 6 }, () => req(`/api/image/${S.film}/backdrop?w=480`)));
  assert.ok(parallel.every(r => r.status === 200 && r.data.equals(parallel[0].data)));
  const f = path.join(VARIANTS, key, variants(key).find(x => x.startsWith('480-')));
  const before = fs.statSync(f);
  await sleep(30);
  const again = await req(`/api/image/${S.film}/backdrop?w=480`);
  assert.deepEqual(again.data, parallel[0].data);
  const after = fs.statSync(f);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
  assert.equal(variants(key).filter(x => x.startsWith('480-')).length, 1);
  // ETag fungerar för varianten
  assert.equal((await req(`/api/image/${S.film}/backdrop?w=480`, { headers: { 'if-none-match': again.headers.get('etag') } })).status, 304);
});

t('ny källbild: varianten görs om och den gamla tas bort', async () => {
  const key = `images_${S.film}-poster.jpg`;
  const old = variants(key).find(x => x.startsWith('240-'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=600x900', '-frames:v', '1', path.join(IMAGES, `${S.film}-poster.jpg`)]);
  const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(IMAGES, `${S.film}-poster.jpg`), later, later);
  const r = await req(`/api/image/${S.film}/poster?w=240`);
  assert.deepEqual(dims(r.data), { w: 240, h: 360 });
  await sleep(200);
  const now = variants(key);
  assert.ok(!now.includes(old), now.join());
  assert.deepEqual(now.map(f => f.split('-')[0]), ['240']);
});

t('behörighet: utan inloggning 401, barnprofil når inte bilder över åldersgränsen', async () => {
  assert.equal((await req(`/api/image/${S.film}/poster?w=240`, { tok: '' })).status, 401);
  assert.equal((await req(`/api/image/${S.film}/poster?w=abc`, { tok: '' })).status, 401);
  assert.equal((await post('/api/profiles', { name: 'Lisa', maxAge: 7 })).status, 200);
  const prof = (await req('/api/profiles')).data;
  const kid = prof.profiles.find(p => p.name === 'Lisa').id;
  const kt = (await post('/api/profiles/switch', { id: kid })).data.token;
  assert.equal((await req(`/api/image/${S.film}/poster?w=240`, { tok: kt })).status, 200);
  const n = variants(`images_${S.vuxen}-poster.jpg`).length;
  assert.equal((await req(`/api/image/${S.vuxen}/poster?w=240`, { tok: kt })).status, 404);
  assert.equal((await req(`/api/image/${S.vuxen}/poster`, { tok: kt })).status, 404);
  assert.equal(variants(`images_${S.vuxen}-poster.jpg`).length, n); // ingen skalning för en nekad bild
});

t('trasig källbild: originalet skickas', async () => {
  fs.writeFileSync(path.join(IMAGES, `${S.vuxen}-backdrop.jpg`), Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0]), Buffer.alloc(3000, 7)]));
  const l = await post('/api/login', { name: 'admin', password: PW, app: true }, '');
  const r = await req(`/api/image/${S.vuxen}/backdrop?w=240`, { tok: l.data.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 3008);
});

t('i processen: fasta bredder, bredd ur JPEG/PNG, en ffmpeg per variant och alla köade varianter blir klara', async () => {
  process.env.CONFIG_DIR = path.join(ROOT, 'unit');
  const m = await import('../server/imgsize.js');
  assert.deepEqual(['1', '160', '161', '240', '300', '1280', '1281', '0', 'x', null, '12.5'].map(m.snapWidth), [160, 160, 240, 240, 320, 1280, null, null, null, null, null]);
  const src = path.join(process.env.CONFIG_DIR, 'images', 'a-poster.jpg'), png = path.join(process.env.CONFIG_DIR, 'images', 'b.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=500x750', '-frames:v', '1', src]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=300x300', '-frames:v', '1', png]);
  assert.equal(m.imageWidth(fs.readFileSync(src)), 500);
  assert.equal(m.imageWidth(fs.readFileSync(png)), 300);
  assert.equal(m.imageWidth(Buffer.from('inte en bild')), null);
  // Fem samtidiga förfrågningar efter samma variant: en skalning
  const outs = await Promise.all(Array.from({ length: 5 }, () => m.sized(src, '240')));
  assert.equal(m.stats.resized, 1);
  assert.ok(outs.every(o => o === outs[0] && o !== src));
  assert.equal(await m.sized(src, '240'), outs[0]);
  assert.equal(m.stats.resized, 1);
  assert.equal(await m.sized(png, '480'), png); // ingen förstoring
  assert.equal(await m.sized(src, 'abc'), src);
  // Många olika varianter samtidigt: alla blir klara (kön släpper fram nästa)
  const all = await Promise.all(['160', '240', '320', '480'].flatMap(w => [m.sized(src, w), m.sized(png, w)]));
  assert.equal(new Set(all).size, 7); // sex varianter + originalet för PNG:en i 320 och 480
  // nya: affischen i 160/320/480 och PNG:en i 160/240
  assert.equal(m.stats.resized, 6);
  assert.equal(m.stats.failed, 0);
});
