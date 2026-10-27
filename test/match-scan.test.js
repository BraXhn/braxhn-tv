// Matchningen genom skanningen: kategorimappar ("Barn/Bluey/…"), datumavsnitt mot TMDB:s sändningsdatum,
// årtal i filnamnet, att en serie som tolkas om byter namn i stället för att bli en ny rad (Min lista och låsning
// följer med), att låsta matchningar ("Fel titel?") aldrig ändras, engångsförsöket efter uppgraderingen och
// Administrationens lista över omatchade titlar med "Försök matcha omatchade igen". Låtsas-TMDB: test/fixtures/match/tmdb.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startFakeTmdb } from './fixtures/match/tmdb.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-mscan-'));
const MEDIA = path.join(ROOT, 'media');
const fake = await startFakeTmdb();
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.CREDITS_PER_SCAN = '0';
process.env.TMDB_API_URL = fake.url;
process.env.TMDB_API_KEY = 'testnyckel';

// Tomma filer räcker: ffprobe misslyckas men filen blir ändå en titel
const touch = (...p) => { const f = path.join(MEDIA, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); return f; };
const BARN = path.join(MEDIA, 'Barnserier'), FILM = path.join(MEDIA, 'Barnfilm');
touch('Barnserier', 'Barn', 'Bluey', 'Season 1', 'Bluey S01E01.mkv');
touch('Barnserier', 'Tecknat', 'Paw.Patrol.S02E03.SWEDiSH.mkv');
touch('Barnserier', 'Skavlan', 'Skavlan 2009-01-05.mkv');
touch('Barnserier', 'Doctor Who', 'Doctor.Who.2005.S01E01.mkv');
touch('Barnfilm', 'Lejonkungen (svenskt tal).mkv');
touch('Barnfilm', 'Frost 2 (2019) [Svenskt tal].mkv');
touch('Barnfilm', 'Helt okänd barnfilm (2015).mkv');

const D = await import('../server/db.js');
const scanner = await import('../server/scanner.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
const LAN = { 'x-forwarded-for': '192.168.1.20' };
let tok;
async function req(p, { method = 'GET', body } = {}) {
  const h = { ...LAN, authorization: `Bearer ${tok}` };
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
after(() => { srv.close(); fake.srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const show = (name) => D.get(`SELECT * FROM items WHERE kind='show' AND src_name=?`, name);
const ids = {};

test('skanning: kategorimappar, datumavsnitt och årtal i filnamnet', async () => {
  const r = await fetch(B + '/api/setup', { method: 'POST', headers: { ...LAN, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: 'Långt-lösen-123!' }) });
  assert.equal(r.status, 200);
  tok = auth.createSession(D.get("SELECT id FROM users WHERE name='admin'").id, 'app');
  ids.shows = (await req('/api/libraries', { method: 'POST', body: { name: 'Barnserier', type: 'show', path: BARN } })).data.id;
  ids.movies = (await req('/api/libraries', { method: 'POST', body: { name: 'Barnfilm', type: 'movie', path: FILM } })).data.id;
  await scanner.scan(ids.shows); await scanner.scan(ids.movies);
  assert.equal(show('Bluey')?.tmdb_id, 82728, 'Barn/Bluey: kategorimappen är inte serien');
  assert.equal(show('Paw Patrol')?.tmdb_id, 57532, 'Tecknat/Paw.Patrol.S02E03: serien ur filnamnet');
  assert.equal(D.get(`SELECT COUNT(*) AS n FROM items WHERE kind='show' AND src_name IN ('Barn','Tecknat')`).n, 0);
  // Årtalet i filnamnet är en ledtråd (2005 och inte 1963), men inte en del av seriens nyckel
  assert.equal(show('Doctor Who')?.tmdb_id, 57243);
  // Datumavsnitt: 2009-01-05 är säsong 1 avsnitt 3 hos låtsas-TMDB (varannan dag från 1 januari)
  const sk = show('Skavlan');
  assert.equal(sk?.tmdb_id, 8436);
  const ep = D.get(`SELECT season, episode, released FROM items WHERE parent_id=?`, sk.id);
  assert.deepEqual({ ...ep }, { season: 1, episode: 3, released: '2009-01-05' });
  // Barnfilm utan år: den tecknade från 1994, inte nyinspelningen
  assert.equal(D.get(`SELECT tmdb_id FROM items WHERE path LIKE '%Lejonkungen (svenskt tal)%'`).tmdb_id, 8587);
  assert.equal(D.get(`SELECT tmdb_id FROM items WHERE path LIKE '%Frost 2%'`).tmdb_id, 330457);
  assert.equal(D.get(`SELECT meta_done FROM items WHERE path LIKE '%okänd barnfilm%'`).meta_done, 2);
});

test('omtolkad serie byter namn: raden, Min lista och låsningen behålls', async () => {
  // Som en äldre version: serien hette efter kategorimappen och var låst till en titel för hand
  const f = touch('Barnserier', 'Babblarna (Svenskt tal)', 'Säsong 1', 'Babblarna S01E02.mkv');
  const old = Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,src_name,tmdb_id,meta_done,match_locked,added) VALUES(?,?,?,?,?,?,1,1,0)`,
    ids.shows, 'show', 'Babblarna', 'babblarna', 'Babblarna (Svenskt tal)', 64196).lastInsertRowid);
  D.run(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,season,episode,path,size,mtime,added) VALUES(?,?,?,?,?,1,2,?,0,0,0)`, ids.shows, 'episode', old, 'x', 'x', f);
  const uid = D.get("SELECT id FROM users WHERE name='admin'").id;
  D.run('INSERT INTO watchlist(user_id,item_id,added) VALUES(?,?,0)', uid, old);
  await scanner.scan(ids.shows);
  const s = show('Babblarna');
  assert.equal(s?.id, old, 'samma rad, nytt namn');
  assert.equal(s.match_locked, 1); assert.equal(s.tmdb_id, 64196);
  assert.ok(D.get('SELECT 1 FROM watchlist WHERE item_id=?', old));
});

test('låst matchning ändras aldrig; omatchade i Administration och nytt försök', async () => {
  // "Fel titel?": Lejonkungen låst till 2019 års version – varken skanning eller "Uppdatera metadata" ändrar det
  const lk = D.get(`SELECT * FROM items WHERE path LIKE '%Lejonkungen (svenskt tal)%'`);
  assert.equal((await req(`/api/items/${lk.id}/match`, { method: 'POST', body: { tmdbId: 420818 } })).status, 200);
  assert.equal((await req(`/api/items/${lk.id}/refresh`, { method: 'POST', body: {} })).status, 200);
  D.run('UPDATE items SET meta_done=0 WHERE id=?', lk.id);
  await scanner.scan(ids.movies);
  assert.equal(D.get('SELECT tmdb_id FROM items WHERE id=?', lk.id).tmdb_id, 420818);

  const u = await req('/api/unmatched');
  assert.equal(u.status, 200);
  const x = u.data.items.find(i => /okänd barnfilm/.test(i.file));
  assert.ok(x, JSON.stringify(u.data));
  assert.deepEqual(x.parsed, { title: 'Helt okänd barnfilm', year: 2015 });
  assert.equal(x.library, 'Barnfilm'); assert.equal(x.kind, 'movie');
  assert.ok(!u.data.items.some(i => i.id === lk.id), 'låsta och matchade visas inte');
  // Engångsförsöket efter uppgraderingen: sätts flaggan tillbaka söks omatchade om vid nästa skanning
  const before = fake.calls.length;
  D.setSetting('match_v3', '0');
  await scanner.scan(ids.movies);
  assert.ok(fake.calls.slice(before).some(c => /search\/movie\?Helt okänd/.test(c)), 'söktes igen efter uppgraderingen');
  assert.equal(D.getSetting('match_v3'), '1');
  // Knappen: alla omatchade (inte låsta) markeras för ny matchning
  const rr = await req('/api/unmatched/retry', { method: 'POST' });
  assert.equal(rr.status, 200); assert.ok(rr.data.count >= 1);
  await new Promise(r => setTimeout(r, 300));
  while (scanner.status.running) await new Promise(r => setTimeout(r, 100));
  assert.equal(D.get('SELECT tmdb_id FROM items WHERE id=?', lk.id).tmdb_id, 420818);
});
