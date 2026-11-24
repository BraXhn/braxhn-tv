// Fjärde granskningen av servern mot en riktig server: skanningens status visar inte namnen på bibliotek som användaren
// inte får se, sortering och språk ur adressen slår bara upp egna nycklar (constructor/__proto__ gav internt fel), och
// skärmtiden räknas på servern även när klienten inte rapporterar framsteg – både när strömmen hämtas bit för bit och
// när originalfilen läses i ett enda långt svar, som bryts när tiden är slut. Behöver inte ffmpeg (inget skannas).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './helpers/port.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-sec4-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let srv, admin = '', bo = '', kid = '';
const S = {};

async function req(p, { method = 'GET', body, tok = admin, headers = {} } = {}) {
  const h = { ...headers };
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
const login = async (name) => (await req('/api/login', { method: 'POST', body: { name, password: PW, app: true }, tok: '' })).data.token;
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

before(async () => {
  fs.mkdirSync(path.join(MEDIA, 'filer'), { recursive: true });
  const film = path.join(MEDIA, 'filer', 'Barnfilm (2020).mp4'), stor = path.join(MEDIA, 'filer', 'Lång barnfilm (2021).mp4');
  fs.writeFileSync(film, crypto.randomBytes(200000));
  fs.writeFileSync(stor, 'x'); fs.truncateSync(stor, 400 * 1048576); // gles fil: tar ingen plats på disken
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', DLNA: '0', SCREEN_STREAM_TICK_MS: '300' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 100; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin');
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  S.kid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;

  // Bibliotek utan mappar på disken (skannern rör dem inte) och två filmer för barnprofilen
  const T = Math.floor(Date.now() / 1000);
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const lib = (name) => Number(db.prepare("INSERT INTO libraries(name,type,path) VALUES(?,'movie',?)").run(name, path.join(MEDIA, 'saknas-' + name)).lastInsertRowid);
  S.F = lib('Filmer'); S.X = lib('Hemligt bibliotek');
  const item = (title, file) => Number(db.prepare(`INSERT INTO items(library_id,kind,title,sort_title,year,path,size,duration,container,age,added) VALUES(?,'movie',?,?,2020,?,?,600,'mp4',0,?)`)
    .run(S.F, title, title.toLowerCase(), file, fs.statSync(file).size, T).lastInsertRowid);
  S.film = item('Barnfilm', film); S.stor = item('Lång barnfilm', stor);
  // Dagens förbrukning: 57 av 60 sekunder (läggs in innan profilen har någon skärmtid, så att servern läser raden)
  db.prepare('INSERT INTO screen_usage(user_id,day,seconds,extra) VALUES(?,?,57,0)').run(S.kid, localDay());
  db.close();

  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW, libraries: [S.F] } })).status, 200);
  bo = await login('bo');
  kid = (await req('/api/profiles/switch', { method: 'POST', body: { id: S.kid } })).data.token;
  assert.ok(bo && kid);
  admin = await login('admin'); // profilbytet tog bort administratörens token
});
after(async () => {
  if (srv && srv.exitCode == null) { const done = new Promise(r => srv.once('exit', r)); srv.kill('SIGTERM'); await done; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('skanningens status: en användare med begränsade bibliotek får inte veta vad de andra heter', async () => {
  assert.equal((await req('/api/scan', { method: 'POST' })).status, 200);
  let a;
  for (let i = 0; i < 100; i++) { a = (await req('/api/scan')).data; if (a.scanned?.includes('Hemligt bibliotek') && !a.running) break; await sleep(100); }
  assert.ok(a.scanned.includes('Hemligt bibliotek'), 'administratören ser vilka bibliotek som skannades');
  for (const tok of [bo, kid]) {
    const r = await req('/api/scan', { tok });
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.data).includes('Hemligt'), 'inget biblioteksnamn i svaret: ' + JSON.stringify(r.data));
    assert.equal(typeof r.data.running, 'boolean', 'läget (pågår/klar) finns kvar');
    assert.equal(r.data.scanned, undefined);
  }
});

test('sortering och språk ur adressen: constructor och __proto__ ger standardvalet, inte internt fel', async () => {
  for (const sort of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const h = await req(`/api/history?sort=${sort}`, { tok: bo });
    assert.equal(h.status, 200, `Min historik med sort=${sort}`);
    assert.ok(Array.isArray(h.data.rows ?? h.data.items ?? h.data.history ?? Object.values(h.data).find(Array.isArray)));
    assert.equal((await req(`/api/playstats/history?sort=${sort}`)).status, 200, `statistiken med sort=${sort}`);
    assert.equal((await req(`/api/admin/shrink?sort=${sort}`)).status, 200, `diskrådgivaren med sort=${sort}`);
    const f = await req('/api/admin/family-filter/test', { method: 'POST', body: { text: 'jävla skit', lang: sort } });
    assert.equal(f.status, 200, `familjefiltrets provruta med lang=${sort}`);
    assert.equal(f.data.hit, true, 'okänt språk = båda ordlistorna');
  }
});

const used = async () => (await req('/api/screentime', { tok: kid })).data;
const bit = () => req(`/api/stream/${S.film}/direct`, { tok: kid, headers: { range: 'bytes=0-999' } });

test('skärmtid: tiden går när strömmen hämtas, även utan framstegsrapporter från klienten', async () => {
  assert.equal((await req(`/api/screentime/${S.kid}`, { method: 'PUT', body: { daily: 1 } })).status, 200);
  const s0 = await used();
  assert.equal(s0.limited, true); assert.equal(s0.allowed, true); assert.equal(s0.used, 57);
  // En klient som bara hämtar strömmen (t.ex. adressen öppnad i en annan spelare) – inga anrop till /progress
  assert.equal((await bit()).status, 206);
  await sleep(1300);
  assert.equal((await bit()).status, 206);
  const s1 = await used();
  assert.ok(s1.used >= 58, `tiden räknas på servern (använt ${s1.used} s av 60)`);
  assert.equal(s1.allowed, true);
});

test('skärmtid: ett långt svar (originalfilen) räknas medan det läses och bryts när tiden är slut', { timeout: 30000 }, async () => {
  const t0 = Date.now();
  const got = await new Promise((ok, no) => {
    const r = http.get(`${B}/api/stream/${S.stor}/direct`, { headers: { authorization: 'Bearer ' + kid } }, (res) => {
      let n = 0;
      // Läser i lugn takt, som en spelare: en bit var 50:e millisekund
      res.on('data', (d) => { n += d.length; res.pause(); setTimeout(() => res.resume(), 50); });
      const done = (how) => ok({ status: res.statusCode, n, how, ms: Date.now() - t0 });
      res.on('end', () => done('end')); res.on('close', () => done('close')); res.on('error', () => done('error'));
    });
    r.on('error', no);
    setTimeout(() => { r.destroy(); ok({ how: 'timeout' }); }, 20000);
  });
  assert.equal(got.status, 200);
  assert.notEqual(got.how, 'timeout', 'servern bröt svaret');
  assert.ok(got.n < 400 * 1048576, 'svaret bröts innan hela filen skickats');
  assert.ok(got.ms < 15000, `bröts efter ${got.ms} ms`);
  const s = await used();
  assert.equal(s.allowed, false); assert.equal(s.reason, 'limit');
  const again = await bit();
  assert.equal(again.status, 403); assert.equal(again.data.code, 'screen_time');
  // Nedladdning för offline räknas inte som tittande och stoppas inte av skärmtiden
  assert.equal((await req(`/api/stream/${S.film}/download`, { tok: kid })).status, 200);
});
