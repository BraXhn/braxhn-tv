// Rollista, personsidor, lokala trailers och årssammanfattning mot en riktig server. Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-ppls-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 21000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, token = '';
const S = {};

async function req(p, { method = 'GET', body, headers = {}, tok = token } = {}) {
  const h = { ...headers };
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async () => { const r = await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, tok: '' }); assert.equal(r.status, 200); token = r.data.token; };

before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(path.join(MEDIA, 'Filmer'), { recursive: true });
  const f = path.join(MEDIA, 'Filmer', 'Film (2020).mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
  fs.copyFileSync(f, path.join(MEDIA, 'Filmer', 'Film (2020)-trailer.mp4'));
  fs.copyFileSync(f, path.join(MEDIA, 'Filmer', 'Barn (2019).mp4'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

t('skanning: trailern blir ingen egen film', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  await login();
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).status, 200);
  for (let i = 0; i < 120; i++) { await sleep(500); const r = await req('/api/scan'); if (!r.data.running && !r.data.analysis?.running && r.data.last) break; }
  const lib = (await req('/api/libraries')).data[0];
  const items = (await req(`/api/libraries/${lib.id}/items`)).data.items;
  assert.deepEqual(items.map(i => i.title).sort(), ['Barn', 'Film']);
  S.film = items.find(i => i.title === 'Film').id; S.barn = items.find(i => i.title === 'Barn').id;
  // Rollista och åldersgränser läggs in direkt i databasen (ingen TMDB i testet)
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare('UPDATE items SET age=15, trailer_yt=? WHERE id=?').run('dQw4w9WgXcQ', S.film);
  db.prepare("UPDATE items SET age=7, trailer_yt='abcdefghijk' WHERE id=?").run(S.barn);
  db.prepare(`INSERT INTO people(id,name,bio,bio_fetched) VALUES(77,'Anna Aktris','Svensk skådespelare.',?),(78,'Vuxen Västerling',NULL,?)`).run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
  const ins = db.prepare('INSERT INTO item_people(item_id,person_id,role,character,ord) VALUES(?,?,?,?,?)');
  ins.run(S.film, 77, 'cast', 'Hjältinnan', 0); ins.run(S.film, 78, 'director', null, 0); ins.run(S.barn, 77, 'cast', 'Mamman', 0);
  db.close();
});

t('titelsidan visar rollista, lokal trailer och YouTube-trailer', async () => {
  const it = (await req('/api/items/' + S.film)).data;
  assert.deepEqual(it.cast.map(p => [p.name, p.role, p.character]), [['Vuxen Västerling', 'director', null], ['Anna Aktris', 'cast', 'Hjältinnan']]);
  assert.equal(it.trailers.length, 1);
  assert.equal(it.youtube, 'dQw4w9WgXcQ');
  S.trailer = it.trailers[0].id;
});

t('lokal trailer spelas direkt med Range och mediatoken gäller bara trailern', async () => {
  const r = await req(`/api/trailers/${S.trailer}/stream`, { headers: { range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal(r.data.length, 10);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal((await req(`/api/trailers/${S.trailer}/stream`, { tok: '' })).status, 401);
  const p = (await req(`/api/trailers/${S.trailer}/play`)).data;
  assert.match(p.url, /^\/api\/trailers\/\d+\/stream\?t=[0-9a-f]+$/);
  const mt = p.url.split('?t=')[1];
  assert.equal((await req(p.url, { tok: '' })).status, 200);
  assert.equal((await req(`/api/stream/${S.film}/direct?t=${mt}`, { tok: '' })).status, 401); // fel titel
  assert.equal((await req(`/api/people/77?t=${mt}`, { tok: '' })).status, 401);               // ingen media-route
  assert.equal((await req('/api/trailers/999999/stream')).status, 404);
});

t('personsida och personsökning', async () => {
  const p = (await req('/api/people/77')).data;
  assert.equal(p.name, 'Anna Aktris');
  assert.equal(p.bio, 'Svensk skådespelare.');
  assert.deepEqual(p.items.map(i => [i.title, i.roles[0].character]).sort(), [['Barn', 'Mamman'], ['Film', 'Hjältinnan']]);
  const s = (await req('/api/search/people?q=' + encodeURIComponent('västerling'))).data;
  assert.deepEqual(s.map(x => x.id), [78]);
  assert.equal((await req('/api/people/12345')).status, 404);
  assert.equal((await req('/api/people/78/image')).status, 404); // ingen bild
});

t('årssammanfattning: egen, och administratören ser andras', async () => {
  await req(`/api/items/${S.film}/playback`); // registrerar en uppspelning
  const year = new Date().getFullYear();
  const w = (await req(`/api/wrapped/${year}`)).data;
  assert.equal(w.video.plays, 1);
  assert.equal(w.video.titles[0].title, 'Film');
  assert.ok(w.users.some(u => u.name === 'admin'));
  assert.equal((await req('/api/wrapped/1800')).status, 400);
  assert.equal((await req(`/api/wrapped/${year}?user=99999`)).status, 404);
});

t('barnprofil: ser bara personer och titlar inom åldersgränsen, inte andras sammanfattning', async () => {
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  const prof = (await req('/api/profiles')).data;
  const adminId = prof.current, kid = prof.profiles.find(p => p.name === 'Lisa').id;
  const r = await req('/api/profiles/switch', { method: 'POST', body: { id: kid } });
  assert.equal(r.status, 200);
  const kt = r.data.token;
  const p = (await req('/api/people/77', { tok: kt })).data;
  assert.deepEqual(p.items.map(i => i.title), ['Barn']);
  assert.equal((await req('/api/people/78', { tok: kt })).status, 404);
  assert.deepEqual((await req('/api/search/people?q=an', { tok: kt })).data.map(x => x.id), [77]);
  assert.deepEqual((await req('/api/search/people?q=' + encodeURIComponent('västerling'), { tok: kt })).data, []);
  assert.equal((await req(`/api/trailers/${S.trailer}/stream`, { tok: kt })).status, 403);
  assert.equal((await req('/api/items/' + S.barn, { tok: kt })).data.youtube, null);
  const year = new Date().getFullYear();
  assert.equal((await req(`/api/wrapped/${year}?user=${adminId}`, { tok: kt })).status, 403);
  const own = await req(`/api/wrapped/${year}`, { tok: kt });
  assert.equal(own.status, 200);
  assert.equal(own.data.users, undefined);
  await login(); // profilbytet loggade ut adminens token
  assert.equal((await req(`/api/wrapped/${year}?user=${kid}`)).data.user.name, 'Lisa');
});
