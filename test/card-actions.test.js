// Snabbåtgärder från kortens meny (⋮): kortets läge och "Ta bort från Fortsätt titta" mot en riktig server.
// Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-cards-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 23000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, token = '';
const S = {};

async function req(p, { method = 'GET', body, tok = token } = {}) {
  const h = {};
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async () => { const r = await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, tok: '' }); assert.equal(r.status, 200); token = r.data.token; };
const home = async (tok) => (await req('/api/home', { tok })).data.continue.map(i => i.id);

before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(path.join(MEDIA, 'Filmer'), { recursive: true });
  fs.mkdirSync(path.join(MEDIA, 'Serier', 'Serien', 'Season 1'), { recursive: true });
  const f = path.join(MEDIA, 'Filmer', 'Vuxenfilm (2020).mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
  fs.copyFileSync(f, path.join(MEDIA, 'Filmer', 'Barnfilm (2019).mp4'));
  for (const n of [1, 2]) fs.copyFileSync(f, path.join(MEDIA, 'Serier', 'Serien', 'Season 1', `Serien S01E0${n}.mp4`));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

t('förberedelse: konto, bibliotek och åldersgränser', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  await login();
  for (const [name, type] of [['Filmer', 'movie'], ['Serier', 'show']])
    assert.equal((await req('/api/libraries', { method: 'POST', body: { name, type, path: path.join(MEDIA, name) } })).status, 200);
  for (let i = 0; i < 120; i++) { await sleep(500); const r = await req('/api/scan'); if (!r.data.running && !r.data.analysis?.running && r.data.last) break; }
  const libs = (await req('/api/libraries')).data;
  const movies = (await req(`/api/libraries/${libs.find(l => l.type === 'movie').id}/items`)).data.items;
  S.adult = movies.find(i => i.title === 'Vuxenfilm').id; S.kids = movies.find(i => i.title === 'Barnfilm').id;
  S.show = (await req(`/api/libraries/${libs.find(l => l.type === 'show').id}/items`)).data.items[0].id;
  const eps = (await req('/api/items/' + S.show)).data.children;
  [S.ep1, S.ep2] = eps.map(e => e.id);
  // Långa titlar (så att en position inte räknas som sedd) och åldersgränser direkt i databasen
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('UPDATE items SET duration=3600');
  db.prepare('UPDATE items SET age=15 WHERE id IN (?,?)').run(S.adult, S.show);
  db.prepare('UPDATE items SET age=7 WHERE id=?').run(S.kids);
  db.close();
});

t('kortets läge: Min lista, följer och nästa avsnitt', async () => {
  let st = (await req(`/api/items/${S.adult}/state`)).data;
  assert.equal(st.inWatchlist, false);
  assert.equal(st.following, undefined); // filmer kan inte följas
  await req(`/api/items/${S.adult}/watchlist`, { method: 'POST', body: { add: true } });
  assert.equal((await req(`/api/items/${S.adult}/state`)).data.inWatchlist, true);
  st = (await req(`/api/items/${S.show}/state`)).data;
  assert.equal(st.following, false);
  assert.equal(st.next.id, S.ep1);
  // Avsnitt: Min lista och följ gäller serien
  await req(`/api/items/${S.ep2}/watchlist`, { method: 'POST', body: { add: true } });
  st = (await req(`/api/items/${S.ep1}/state`)).data;
  assert.equal(st.inWatchlist, true);
  assert.equal(st.following, true); // Min lista följer serien automatiskt
  assert.equal((await req('/api/items/999999/state')).status, 404);
});

t('ta bort en film från Fortsätt titta och ångra', async () => {
  await req(`/api/items/${S.adult}/progress`, { method: 'POST', body: { position: 600 } });
  assert.ok((await home()).includes(S.adult));
  const r = await req(`/api/items/${S.adult}/continue`, { method: 'POST', body: { hide: true } });
  assert.equal(r.status, 200);
  assert.equal(r.data.position, 600);
  assert.ok(!(await home()).includes(S.adult));
  const it = (await req('/api/items/' + S.adult)).data;
  assert.equal(it.position, 0);
  assert.equal(it.watched, false); // inte markerad som sedd
  await req(`/api/items/${S.adult}/continue`, { method: 'POST', body: { hide: false, position: r.data.position } });
  assert.equal((await req('/api/items/' + S.adult)).data.position, 600);
  assert.ok((await home()).includes(S.adult));
  // Serier kan inte tas bort (bara filmer och avsnitt har en position)
  assert.equal((await req(`/api/items/${S.show}/continue`, { method: 'POST', body: { hide: true } })).status, 404);
});

t('ta bort ett avsnitt: serien döljs tills man tittar igen', async () => {
  await req(`/api/items/${S.ep1}/progress`, { method: 'POST', body: { position: 300 } });
  assert.ok((await home()).includes(S.ep1));
  const r = await req(`/api/items/${S.ep1}/continue`, { method: 'POST', body: { hide: true } });
  assert.equal(r.data.position, 300);
  const ids = await home();
  // Varken avsnittet eller "nästa avsnitt" i samma serie
  assert.ok(!ids.includes(S.ep1) && !ids.includes(S.ep2), JSON.stringify(ids));
  await sleep(1100); // nytt tittande senare än döljningen
  await req(`/api/items/${S.ep1}/progress`, { method: 'POST', body: { position: 320 } });
  assert.ok((await home()).includes(S.ep1));
  // Ångra tar bort döljningen
  await req(`/api/items/${S.ep1}/continue`, { method: 'POST', body: { hide: true } });
  await req(`/api/items/${S.ep1}/continue`, { method: 'POST', body: { hide: false, position: 320 } });
  assert.ok((await home()).includes(S.ep1));
});

t('barnprofil: kan inte se eller ändra titlar över åldersgränsen', async () => {
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  const kid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  const kt = (await req('/api/profiles/switch', { method: 'POST', body: { id: kid } })).data.token;
  for (const id of [S.adult, S.show, S.ep1]) {
    assert.equal((await req(`/api/items/${id}/state`, { tok: kt })).status, 404);
    assert.equal((await req(`/api/items/${id}/watched`, { method: 'POST', body: { watched: true }, tok: kt })).status, 404);
  }
  for (const id of [S.adult, S.ep1]) assert.equal((await req(`/api/items/${id}/continue`, { method: 'POST', body: { hide: true }, tok: kt })).status, 404);
  assert.equal((await req(`/api/items/${S.kids}/state`, { tok: kt })).status, 200);
  await req(`/api/items/${S.kids}/progress`, { method: 'POST', body: { position: 200 }, tok: kt });
  assert.ok((await home(kt)).includes(S.kids));
  assert.equal((await req(`/api/items/${S.kids}/continue`, { method: 'POST', body: { hide: true }, tok: kt })).status, 200);
  assert.ok(!(await home(kt)).includes(S.kids));
  // Adminens framsteg påverkas inte av barnets åtgärder
  await login();
  assert.equal((await req('/api/items/' + S.adult)).data.position, 600);
});
