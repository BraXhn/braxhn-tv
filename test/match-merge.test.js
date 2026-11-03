// Serier i flera mappar och omprövning av gamla matchningar genom skanningen (låtsas-TMDB: test/fixtures/match/tmdb.js):
// "Clarkson's Farm" och "Clarksons gård" blir EN serie (Min lista, betyg, framsteg och följningar följer med, samma avsnitt i
// båda blir versioner) och delas inte upp igen vid nästa skanning; olika serier med samma namn och olika år slås aldrig ihop;
// en felmatchad serie ("Clark" → "Lois & Clark") rättas när den nya träffen är klart bättre men aldrig när den är låst;
// Administrationens osäkra matchningar och förslag för omatchade, och "Godkänn".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { startFakeTmdb } from './fixtures/match/tmdb.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-mmerge-'));
const MEDIA = path.join(ROOT, 'media');
const fake = await startFakeTmdb();
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.CREDITS_PER_SCAN = '0';
process.env.TMDB_API_URL = fake.url;
delete process.env.TMDB_API_KEY; // första skanningen utan TMDB: två rader för samma serie, som i en äldre version

const touch = (...p) => { const f = path.join(MEDIA, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); return f; };
const SER = path.join(MEDIA, 'Serier'), FILM = path.join(MEDIA, 'Barnfilm');
touch('Serier', "Clarkson's Farm", 'Season 1', "Clarkson's Farm S01E01.mkv");
touch('Serier', "Clarkson's Farm", 'Season 1', "Clarkson's Farm S01E02.mkv");
const dupFile = touch('Serier', 'Clarksons gård', 'Säsong 1', 'Clarksons gård S01E02.mkv');
touch('Serier', 'Clarksons gård', 'Säsong 2', 'Clarksons gård S02E01.mkv');
touch('Serier', 'Doctor Who (1963)', 'Season 1', 'Doctor Who S01E01.mkv');
touch('Serier', 'Doctor Who (2005)', 'Season 1', 'Doctor Who S01E01.mkv');
for (let e = 1; e <= 6; e++) touch('Serier', 'Clark', `Clark S01E0${e}.mkv`);
touch('Barnfilm', 'Pelle Svanslös.avi');
touch('Barnfilm', 'Emil i Lönneberga.avi');

const D = await import('../server/db.js');
const scanner = await import('../server/scanner.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
const LAN = { 'x-forwarded-for': '192.168.1.20' };
let tok, uid;
async function req(p, { method = 'GET', body } = {}) {
  const h = { ...LAN, authorization: `Bearer ${tok}` };
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
after(() => { srv.close(); fake.srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const shows = (re) => D.all(`SELECT * FROM items WHERE kind='show'`).filter(s => re.test(s.src_name));
const ids = {};

test('samma serie i två mappar slås ihop – med Min lista, betyg, framsteg och versioner', async () => {
  const r = await fetch(B + '/api/setup', { method: 'POST', headers: { ...LAN, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: 'Långt-lösen-123!' }) });
  assert.equal(r.status, 200);
  uid = D.get("SELECT id FROM users WHERE name='admin'").id;
  tok = auth.createSession(uid, 'app');
  ids.shows = (await req('/api/libraries', { method: 'POST', body: { name: 'Serier', type: 'show', path: SER } })).data.id;
  ids.movies = (await req('/api/libraries', { method: 'POST', body: { name: 'Barnfilm', type: 'movie', path: FILM } })).data.id;
  await scanner.scan(ids.shows);
  const [farm, gard] = [shows(/^Clarkson's Farm$/)[0], shows(/^Clarksons gård$/)[0]];
  assert.ok(farm && gard, 'två rader innan serierna matchats');
  // Profilen har serien i Min lista och har sett ett avsnitt – på den rad som ska försvinna
  const dupEp = D.get('SELECT id FROM items WHERE path=?', dupFile).id;
  D.run('INSERT INTO watchlist(user_id,item_id,added) VALUES(?,?,0)', uid, gard.id);
  D.run('INSERT INTO item_ratings(user_id,item_id,value,updated) VALUES(?,?,8,0)', uid, gard.id);
  D.run('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,0,0,1,1)', uid, dupEp);

  process.env.TMDB_API_KEY = 'testnyckel';
  D.run("UPDATE items SET meta_done=0 WHERE kind='show'");
  await scanner.scan(ids.shows);
  const cf = shows(/^Clarkson/);
  assert.equal(cf.length, 1, 'en serie: ' + cf.map(s => s.src_name).join(', '));
  const main = cf[0];
  assert.equal(main.tmdb_id, 100757);
  assert.ok(JSON.parse(main.src_alias || '[]').length >= 1, 'det andra mappnamnet sparas');
  assert.ok(D.get('SELECT 1 FROM watchlist WHERE user_id=? AND item_id=?', uid, main.id), 'Min lista följer med');
  assert.equal(D.get('SELECT value FROM item_ratings WHERE user_id=? AND item_id=?', uid, main.id)?.value, 8);
  // S01E02 finns i båda mapparna: ett avsnitt med två versioner, och "sedd" hamnar på avsnittet
  const e2 = D.all('SELECT * FROM items WHERE parent_id=? AND season=1 AND episode=2', main.id);
  assert.equal(e2.length, 2);
  const mainEp = e2.find(e => e.version_of == null), ver = e2.find(e => e.version_of != null);
  assert.equal(ver.version_of, mainEp.id);
  assert.equal(D.get('SELECT watched FROM progress WHERE user_id=? AND item_id=?', uid, mainEp.id)?.watched, 1);
  const out = await req(`/api/items/${main.id}`);
  assert.equal(out.status, 200);
  assert.equal(out.data.children.length, 3, 'S01E01, S01E02 och S02E01 – versionen listas inte');
  assert.equal(out.data.ep_total ?? out.data.children.length, 3);
  // Nästa skanning delar inte upp serien igen (mappnamnet finns i src_alias)
  await scanner.scan(ids.shows);
  assert.equal(shows(/^Clarkson/).length, 1);
  assert.equal(D.get('SELECT parent_id FROM items WHERE path=?', dupFile).parent_id, main.id);
  // Olika serier med samma namn och olika år slås aldrig ihop
  assert.equal(shows(/^Doctor Who/).length, 2);
});

test('skydd: två serier med samma TMDB-id men årtal långt ifrån varandra slås inte ihop', () => {
  const lib = D.get('SELECT * FROM libraries WHERE id=?', ids.shows);
  const a = Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,src_name,tmdb_id,meta_done,added) VALUES(?,?,?,?,?,?,1,0)`, lib.id, 'show', 'X', 'x', 'X (1990)', 5).lastInsertRowid);
  const b = Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,src_name,tmdb_id,meta_done,added) VALUES(?,?,?,?,?,?,1,0)`, lib.id, 'show', 'X', 'x', 'X (2010)', 5).lastInsertRowid);
  scanner.mergeShows(lib);
  assert.ok(D.get('SELECT 1 FROM items WHERE id=?', a) && D.get('SELECT 1 FROM items WHERE id=?', b));
  D.run('DELETE FROM items WHERE id IN (?, ?)', a, b);
});

test('skydd: två serier som bara osäkert matchats till samma TMDB-id slås inte ihop', () => {
  const lib = D.get('SELECT * FROM libraries WHERE id=?', ids.shows);
  const add = (src) => {
    const s = Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,src_name,tmdb_id,meta_done,match_unsure,match_score,added) VALUES(?,?,?,?,?,?,1,1,0.6,0)`,
      lib.id, 'show', src, src.toLowerCase(), src, 777).lastInsertRowid);
    const e = Number(D.run(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,season,episode,path,added) VALUES(?,?,?,?,?,1,1,?,0)`,
      lib.id, 'episode', s, 'Avsnitt 1', 'avsnitt 1', path.join(SER, src, `${src} S01E01.mkv`)).lastInsertRowid);
    return [s, e];
  };
  const [a, ea] = add('Bamse'), [b, eb] = add('Bamses äventyr');
  try {
    // Osäkra träffar väntar på administratörens granskning – att slå ihop dem går inte att ångra (avsnitten blir versioner)
    scanner.mergeShows(lib);
    assert.ok(D.get('SELECT 1 FROM items WHERE id=?', a) && D.get('SELECT 1 FROM items WHERE id=?', b), 'båda serierna finns kvar');
    assert.equal(D.get('SELECT version_of FROM items WHERE id=?', eb).version_of, null);
    // Godkänd (låst) matchning för båda: samma serie, slås ihop
    D.run('UPDATE items SET match_unsure=0, match_locked=1 WHERE id IN (?, ?)', a, b);
    scanner.mergeShows(lib);
    assert.equal([a, b].filter(id => D.get('SELECT 1 FROM items WHERE id=?', id)).length, 1);
  } finally { D.run('DELETE FROM items WHERE id IN (?, ?, ?, ?)', a, b, ea, eb); }
});

test('avsnitt med versioner (ihopslagen serie): föregående/nästa och offlinesynken hoppar över versionen', async () => {
  const main = shows(/^Clarkson/)[0];
  const eps = D.all('SELECT id, season, episode, version_of FROM items WHERE parent_id=? ORDER BY season, episode, version_of IS NOT NULL', main.id);
  const [e1, e2] = [eps.find(e => e.season === 1 && e.episode === 1), eps.find(e => e.season === 1 && e.episode === 2 && e.version_of == null)];
  const ver = eps.find(e => e.version_of != null), s2 = eps.find(e => e.season === 2);
  assert.ok(e1 && e2 && ver && s2, JSON.stringify(eps));
  const one = async (id) => (await req(`/api/items/${id}`)).data;
  assert.equal((await one(e1.id)).nextId, e2.id, 'nästa efter S01E01 är S01E02 (inte en version av det)');
  assert.equal((await one(e2.id)).nextId, s2.id, 'nästa efter S01E02 är S02E01');
  assert.equal((await one(s2.id)).prevId, e2.id, 'föregående före S02E01 är S01E02');
  // Offlinesynken: nästa osedda avsnitt – versionen av ett sett avsnitt ska inte laddas ner (ännu en gång)
  const follows = await import('../server/follows.js');
  D.run('DELETE FROM progress WHERE user_id=?', uid);
  D.run('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,0,0,1,1)', uid, e1.id);
  D.run('INSERT OR REPLACE INTO follows(user_id,show_id,active,auto,sync,added) VALUES(?,?,1,0,5,0)', uid, main.id);
  try {
    const plan = follows.syncPlan(uid);
    assert.deepEqual(plan.ids, [e2.id, s2.id], JSON.stringify(plan));
  } finally { D.run('DELETE FROM follows WHERE user_id=? AND show_id=?', uid, main.id); D.run('DELETE FROM progress WHERE user_id=?', uid); }
});

test('felmatchad serie rättas när den nya träffen är klart bättre – aldrig när den är låst', async () => {
  const clark = shows(/^Clark$/)[0];
  assert.equal(clark.tmdb_id, 90241, 'Clark (2022) och inte Lois & Clark');
  // Som en äldre version: matchad till Lois & Clark utan poäng
  D.run('UPDATE items SET tmdb_id=90242, match_score=NULL, meta_done=0 WHERE id=?', clark.id);
  await scanner.refreshItem(D.get('SELECT * FROM items WHERE id=?', clark.id));
  assert.equal(D.get('SELECT tmdb_id FROM items WHERE id=?', clark.id).tmdb_id, 90241);
  // Låst ("Fel titel?") till Lois & Clark: omskanning ändrar ingenting
  D.run('UPDATE items SET tmdb_id=90242, match_locked=1, meta_done=0 WHERE id=?', clark.id);
  await scanner.scan(ids.shows);
  assert.equal(D.get('SELECT tmdb_id FROM items WHERE id=?', clark.id).tmdb_id, 90242);
});

test('osäkra matchningar och förslag i Administration; Godkänn låser', async () => {
  await scanner.scan(ids.movies);
  // Pelle Svanslös utan år: 1981 och 2020 är lika bra – omatchad med båda som förslag
  const u = await req('/api/unmatched');
  assert.equal(u.status, 200);
  const pelle = u.data.items.find(i => /Pelle/.test(i.file));
  assert.ok(pelle, JSON.stringify(u.data.items.map(i => i.file)));
  assert.deepEqual(pelle.suggestions.map(s => s.tmdbId).sort(), [90101, 90102]);
  // Emil i Lönneberga utan år: filmen från 1971 (populärast), men osäker – den tecknade från 2013 är förslag
  const s = await req('/api/matches/unsure');
  const emil = s.data.items.find(i => /Emil/.test(i.file));
  assert.ok(emil, JSON.stringify(s.data.items));
  assert.equal(emil.tmdbId, 10950);
  assert.ok(emil.suggestions.some(x => x.tmdbId === 90111));
  // Ett id som inte är förslag kan inte väljas här
  assert.equal((await req(`/api/matches/${pelle.id}/approve`, { method: 'POST', body: { tmdbId: 603 } })).status, 400);
  assert.equal((await req(`/api/matches/${pelle.id}/approve`, { method: 'POST', body: { tmdbId: 90101 } })).status, 200);
  assert.equal((await req(`/api/matches/${emil.id}/approve`, { method: 'POST', body: {} })).status, 200);
  for (const id of [pelle.id, emil.id]) assert.equal(D.get('SELECT match_locked FROM items WHERE id=?', id).match_locked, 1);
  assert.equal(D.get('SELECT tmdb_id FROM items WHERE id=?', pelle.id).tmdb_id, 90101);
  assert.ok(!(await req('/api/matches/unsure')).data.items.some(i => i.id === emil.id), 'godkänd visas inte längre');
  // "Matcha omatchade och osäkra igen" rör inte låsta titlar
  const rr = await req('/api/unmatched/retry', { method: 'POST', body: { unsure: true } });
  assert.equal(rr.status, 200);
  await new Promise(r => setTimeout(r, 300));
  while (scanner.status.running) await new Promise(r => setTimeout(r, 100));
  assert.equal(D.get('SELECT tmdb_id FROM items WHERE id=?', pelle.id).tmdb_id, 90101);
});

test('intro och eftertexter: ett avsnitt jämförs aldrig med sin egen version', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg saknas' }, async () => {
  const intro = await import('../server/intro.js');
  const dir = path.join(ROOT, 'intro', 'Prov', 'Season 1');
  fs.mkdirSync(dir, { recursive: true });
  // Två olika avsnitt utan gemensamt ljud (ingen intro) och en exakt kopia av avsnitt 2 i en annan mapp (versionen)
  const ep = (n, seed) => {
    const f = path.join(dir, `Prov S01E0${n}.mka`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `anoisesrc=d=150:c=pink:r=22050:seed=${seed}`, '-c:a', 'libopus', '-b:a', '24k', f]);
    return f;
  };
  const f1 = ep(1, 11), f2 = ep(2, 22), f2v = path.join(ROOT, 'intro', 'Prov S01E02 kopia.mka');
  fs.copyFileSync(f2, f2v);
  const lib = Number(D.run(`INSERT INTO libraries(name,type,path) VALUES('Prov','show',?)`, path.join(ROOT, 'intro')).lastInsertRowid);
  const show = Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,added) VALUES(?,?,?,?,0)`, lib, 'show', 'Prov', 'prov').lastInsertRowid);
  const add = (f, e, ver = null) => Number(D.run(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,season,episode,path,duration,mtime,version_of,added)
    VALUES(?,?,?,?,?,1,?,?,150,1,?,0)`, lib, 'episode', show, 'A' + e, 'a' + e, e, f, ver).lastInsertRowid);
  const e1 = add(f1, 1), e2 = add(f2, 2);
  add(f2v, 2, e2);
  await intro.detectMarkers(D.get('SELECT * FROM libraries WHERE id=?', lib));
  for (const id of [e1, e2]) {
    const r = D.get('SELECT intro_start, intro_end, credits_start, markers_done FROM items WHERE id=?', id);
    // Förut: avsnitt 2 fick intro 0–67 s och eftertexter från 97,5 s (av 150 s) från jämförelsen med sin kopia
    assert.deepEqual({ ...r }, { intro_start: null, intro_end: null, credits_start: null, markers_done: 1 }, `avsnitt ${id}: ingen falsk intro/eftertexter`);
  }
});
