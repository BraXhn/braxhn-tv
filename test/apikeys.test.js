// API-nycklar (server/apikeys.js, routes/apikeys.js): administratören skapar och tar bort nycklar, nyckeln visas en
// gång och sparas bara som hash, behörigheterna gäller, /api/v1/* tar aldrig emot vanlig inloggning och nyckeln
// gäller ingen annanstans. Nu spelas visar film/serier (sessioner), musik, ljudböcker och poddar.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-apikeys-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = path.join(ROOT, 'media');
process.env.WATCH_FILES = '0';
fs.mkdirSync(path.join(ROOT, 'media'), { recursive: true });
const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const act = await import('../server/activity.js');
const keys = await import('../server/apikeys.js');

const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const T = Math.floor(Date.now() / 1000);
const ADMIN = Number(D.run('INSERT INTO users(name,pass,is_admin,created) VALUES(?,?,1,0)', 'ägaren', await auth.hashPw('Api-nyckel-test-2026!')).lastInsertRowid);
const BO = Number(D.run('INSERT INTO users(name,pass,is_admin,created) VALUES(?,?,0,0)', 'Bo', await auth.hashPw('Api-nyckel-test-2026!')).lastInsertRowid);
const tok = { admin: auth.createSession(ADMIN, 'app'), bo: auth.createSession(BO, 'app') };
const req = async (p, { method = 'GET', body, headers = {} } = {}) => {
  const h = { ...headers }; if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, data, text };
};
const asAdmin = { authorization: 'Bearer ' + tok.admin };

// Bibliotek: en film, en serie med ett avsnitt, ett musikspår, en ljudbok och ett poddavsnitt
const LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", path.join(ROOT, 'media')).lastInsertRowid);
const MLIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Musik','music',?)", path.join(ROOT, 'media')).lastInsertRowid);
const item = (o) => Number(D.run('INSERT INTO items(library_id,kind,title,year,path,added,duration,parent_id,season,episode) VALUES(?,?,?,?,?,?,?,?,?,?)',
  LIB, o.kind, o.title, o.year ?? null, o.path ?? null, o.added ?? T, o.duration ?? null, o.parent ?? null, o.season ?? null, o.episode ?? null).lastInsertRowid);
const FILM = item({ kind: 'movie', title: 'Testfilmen', year: 2020, path: '/m/a.mkv', duration: 6000, added: T - 100 });
const SHOW = item({ kind: 'show', title: 'Bron', year: 2011 });
const EP = item({ kind: 'episode', title: 'Pilot', path: '/m/b.mkv', duration: 3000, parent: SHOW, season: 1, episode: 2, added: T - 50 });
const AR = Number(D.run("INSERT INTO artists(library_id,name) VALUES(?, 'Kent')", MLIB).lastInsertRowid);
const AL = Number(D.run("INSERT INTO albums(library_id,artist_id,title,added) VALUES(?,?,'Isola',?)", MLIB, AR, T).lastInsertRowid);
const TR = Number(D.run("INSERT INTO tracks(library_id,album_id,artist_id,title,duration,path,added) VALUES(?,?,?,'Om du var här',240,'/m/t.flac',?)", MLIB, AL, AR, T).lastInsertRowid);

test('administrationen: skapa, lista och ta bort – nyckeln visas en gång och sparas som hash', async () => {
  assert.equal((await req('/api/apikeys', { headers: { authorization: 'Bearer ' + tok.bo } })).status, 403, 'bara administratörer');
  assert.equal((await req('/api/apikeys', { method: 'POST', headers: asAdmin, body: { name: '', scopes: ['nowplaying'] } })).status, 400);
  assert.equal((await req('/api/apikeys', { method: 'POST', headers: asAdmin, body: { name: 'X', scopes: ['admin'] } })).status, 400, 'okänd behörighet');
  const r = await req('/api/apikeys', { method: 'POST', headers: asAdmin, body: { name: 'Väggskärmen', scopes: ['nowplaying', 'admin'] } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.data.key, /^bxtv_[A-Za-z0-9_-]{40}$/);
  assert.deepEqual(r.data.scopes, ['nowplaying']); assert.equal(r.data.homeOnly, true);
  const L = (await req('/api/apikeys', { headers: asAdmin })).data;
  assert.equal(L.keys.length, 1); assert.ok(!JSON.stringify(L).includes(r.data.key), 'listan visar aldrig nyckeln');
  assert.ok(!JSON.stringify(D.all('SELECT * FROM api_keys')).includes(r.data.key), 'databasen har bara hashen');
  assert.ok(D.get("SELECT 1 FROM audit WHERE event='apikey_created'"));
  const del = await req('/api/apikeys/' + r.data.id, { method: 'DELETE', headers: asAdmin });
  assert.equal(del.status, 200);
  assert.equal((await req('/api/v1/status', { headers: { 'x-api-key': r.data.key } })).status, 401, 'borttagen nyckel gäller inte');
});

test('nyckeln: bara /api/v1/*, bara sina behörigheter, aldrig i adressen – och /api/v1 tar inte emot vanlig inloggning', async () => {
  const k = keys.create({ name: 'Bara nu spelas', scopes: ['nowplaying'] }, ADMIN).key;
  const H = { 'x-api-key': k };
  assert.equal((await req('/api/v1/status', { headers: H })).status, 200);
  assert.equal((await req('/api/v1/now-playing', { headers: { authorization: 'Bearer ' + k } })).status, 200, 'även som Bearer');
  assert.equal((await req('/api/v1/library', { headers: H })).status, 403, 'saknar behörigheten library');
  assert.equal((await req('/api/v1/now-playing')).status, 401);
  assert.equal((await req('/api/v1/now-playing?key=' + k)).status, 401, 'inte i adressen');
  assert.equal((await req('/api/v1/now-playing', { headers: asAdmin })).status, 401, 'administratörens inloggning gäller inte här');
  for (const p of ['/api/status', '/api/activity', '/api/libraries', '/api/apikeys']) {
    const r = await req(p, { headers: H });
    assert.ok(r.status === 401 || r.status === 403 || (r.status === 200 && !r.data?.user && p === '/api/status'), `${p}: ${r.status}`);
  }
  assert.equal((await req('/api/v1/finnsinte', { headers: H })).status, 404);
  assert.equal((await req('/api/v1/now-playing', { method: 'POST', headers: H })).status, 404, 'bara läsning');
});

test('bara hemnätet: nyckeln nekas utifrån (via reläet), om den inte uttryckligen får gälla överallt', () => {
  const home = keys.create({ name: 'Hemma', scopes: ['nowplaying'] }, ADMIN).key;
  const out = keys.create({ name: 'Ute', scopes: ['nowplaying'], homeOnly: false }, ADMIN).key;
  const fake = (k) => ({ headers: { 'x-api-key': k } });
  assert.match(keys.check(fake(home), 'nowplaying', { trusted: false, ip: '203.0.113.9' }).error, /hemnätverket/);
  assert.ok(keys.check(fake(home), 'nowplaying', { trusted: true, ip: '192.168.1.5' }).key);
  assert.ok(keys.check(fake(out), 'nowplaying', { trusted: false, ip: '203.0.113.9' }).key);
  // Senast använd och från var
  assert.equal(D.get("SELECT last_ip FROM api_keys WHERE name='Ute'").last_ip, '203.0.113.9');
});

test('Nu spelas: film, avsnitt (med serien), musik, ljudbok och podd – med bilder via nyckeln', async () => {
  const k = keys.create({ name: 'Skärmen', scopes: ['nowplaying', 'library'] }, ADMIN).key;
  const H = { 'x-api-key': k };
  act.startPlay({ user: { id: BO, name: 'Bo' }, item: { id: FILM }, mode: 'remux', start: 600, ua: 'Mozilla/5.0 Chrome/120', ip: '192.168.1.20' });
  act.startPlay({ user: { id: ADMIN, name: 'ägaren' }, item: { id: EP }, mode: 'direct', start: 0, ua: 'BraXhnTV-Android', ip: '192.168.1.21' });
  D.run('INSERT INTO track_plays(user_id,track_id,ts) VALUES(?,?,?)', BO, TR, T - 30);
  const r = await req('/api/v1/now-playing', { headers: H });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const S = r.data.sessions;
  const film = S.find(s => s.kind === 'movie'), ep = S.find(s => s.kind === 'episode'), mu = S.find(s => s.kind === 'music');
  assert.deepEqual([film.user, film.title, film.year, film.mode, film.device], ['Bo', 'Testfilmen', 2020, 'remux', 'Chrome']);
  assert.equal(film.position, 600); assert.equal(film.duration, 6000); assert.equal(film.image, 'v' + FILM);
  assert.deepEqual([ep.title, ep.subtitle, ep.season, ep.episode, ep.image], ['Bron', 'S01E02 · Pilot', 1, 2, 'v' + SHOW]);
  assert.deepEqual([mu.user, mu.title, mu.subtitle, mu.duration, mu.image], ['Bo', 'Om du var här', 'Kent · Isola', 240, 'a' + AL]);
  assert.ok(mu.position >= 29 && mu.position <= 31);
  assert.equal(r.data.count, S.length);
  // Ett spår som tagit slut visas inte
  D.run('UPDATE track_plays SET ts=? WHERE user_id=?', T - 1000, BO);
  assert.ok(!(await req('/api/v1/now-playing', { headers: H })).data.sessions.some(s => s.kind === 'music'));
  // Inga IP-adresser eller andra interna fält
  assert.ok(!r.text.includes('192.168.1.2'), 'IP-adressen lämnas inte ut');
  assert.ok(!/"key"|"userId"|"playId"/.test(r.text));
  // Bilder: bara kända slag och id, kräver nyckeln
  assert.equal((await req('/api/v1/image/v' + FILM, { headers: H })).status, 404, 'ingen affisch finns i testet');
  assert.equal((await req('/api/v1/image/x1', { headers: H })).status, 404);
  assert.equal((await req('/api/v1/image/v' + FILM)).status, 401);
});

test('biblioteket: antal och nyligen tillagt', async () => {
  const k = keys.create({ name: 'Bibliotek', scopes: ['library'] }, ADMIN).key;
  const r = await req('/api/v1/library?limit=5', { headers: { 'x-api-key': k } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.counts.movies, 1); assert.equal(r.data.counts.shows, 1); assert.equal(r.data.counts.episodes, 1); assert.equal(r.data.counts.tracks, 1);
  assert.deepEqual(r.data.recent.map(x => x.title), ['Bron', 'Testfilmen'], 'senast tillagt först');
  assert.equal(r.data.recent[0].subtitle, 'S01E02 · Pilot');
  assert.equal((await req('/api/v1/now-playing', { headers: { 'x-api-key': k } })).status, 403);
});
