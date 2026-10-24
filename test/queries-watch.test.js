// Frågor och bevakning utan HTTP: musikhemmets "Spelat nyligen", cachen för smarta listor, TV-guidens index och långa program,
// lokala guidefiler som måste ligga i /config och filbevakningen (ljudformat, mappar med punkt, start efter svaret).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-queries-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.DVR_DIR = path.join(ROOT, 'rec');
process.env.NODE_ENV = 'test';
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.TRANSCODE_DIR, { recursive: true });
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { db, run, all, now, setSetting } = await import('../server/db.js');
const music = await import('../server/music.js');
const L = await import('../server/listening.js');
const live = await import('../server/livetv.js');
const act = await import('../server/activity.js');
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
const plan = (sql, ...p) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...p).map(r => r.detail).join(' | ');

test('musik: Spelat nyligen i ordning, bara det egna biblioteket', () => {
  const t0 = 1_800_000_000;
  for (const lib of [30, 31]) {
    run("INSERT INTO libraries(id,name,type,path) VALUES(?,?,'music','/finns/inte')", lib, 'M' + lib);
    run("INSERT INTO artists(id,library_id,name,sort_name) VALUES(?,?,'A','a')", lib, lib);
  }
  // Fem album i bibliotek 30 och 30 nyare i bibliotek 31 (som förr trängde undan albumen före biblioteksfiltret)
  let tid = 1000;
  const album = (id, lib) => {
    run("INSERT INTO albums(id,library_id,artist_id,title,sort_title,added) VALUES(?,?,?,?,?,0)", id, lib, lib, 'Album ' + id, 'album ' + id);
    run("INSERT INTO tracks(id,library_id,album_id,artist_id,title,track_no,disc_no,path,added) VALUES(?,?,?,?,'Låt',1,1,?,0)", ++tid, lib, id, lib, `/x/${tid}.mp3`);
    return tid;
  };
  const order = [303, 301, 305, 302, 304]; // spelordning, senast först
  for (const id of [301, 302, 303, 304, 305]) album(id, 30);
  order.forEach((id, i) => run('INSERT INTO track_plays(user_id,track_id,ts) VALUES(1,?,?)', 1000 + (id - 300), t0 - 100 * (i + 1)));
  for (let i = 0; i < 30; i++) run('INSERT INTO track_plays(user_id,track_id,ts) VALUES(1,?,?)', album(400 + i, 31), t0 + i);
  assert.deepEqual(music.musicHome(30, 1).recentlyPlayed.map(a => a.id), order);
  assert.equal(music.musicHome(31, 1).recentlyPlayed.length, 24);
  assert.equal(music.musicHome(31, 1).recentlyPlayed[0].id, 429);
});

test('smarta listor: översikten cachas en stund, och "nytt" använder indexet', () => {
  const first = L.smartLists(30, 1);
  run("INSERT INTO tracks(id,library_id,album_id,artist_id,title,track_no,disc_no,path,added) VALUES(9999,30,301,30,'Ny',2,1,'/x/ny.mp3',?)", now());
  assert.deepEqual(L.smartLists(30, 1), first, 'samma svar inom en minut');
  assert.ok(L.smartTracks(30, 1, 'recent').some(t => t.id === 9999), 'själva listan är inte cachad');
  assert.match(plan("SELECT t.id FROM tracks t WHERE t.library_id=? ORDER BY t.added DESC LIMIT 50", 30), /tracks_lib_added/);
});

test('TV-guiden: index på start och inga långa program tappas', () => {
  const tid = Number(run("INSERT INTO tuners(kind,name,url,tuner_count) VALUES('m3u','t','http://x',1)").lastInsertRowid);
  const ch = Number(run('INSERT INTO channels(tuner_id,name,stream_url) VALUES(?,?,?)', tid, 'K', 'http://s/1').lastInsertRowid);
  const from = now();
  run('INSERT INTO programs(channel_id,start,stop,title) VALUES(?,?,?,?)', ch, from - 30 * 3600, from + 3600, 'Maraton'); // 31 timmar
  run('INSERT INTO programs(channel_id,start,stop,title) VALUES(?,?,?,?)', ch, from - 13 * 3600, from - 12 * 3600, 'Slut');
  run('INSERT INTO programs(channel_id,start,stop,title) VALUES(?,?,?,?)', ch, from + 3600, from + 7200, 'Nyheter');
  const titles = live.guide(from, from + 3 * 3600).find(c => c.id === ch).programs.map(p => p.title);
  assert.deepEqual(titles, ['Maraton', 'Nyheter']);
  assert.match(plan('SELECT id FROM programs WHERE start > ? AND stop > ? AND start < ? ORDER BY start', 0, 1, 2), /programs_start/);
});

test('lokala guidefiler måste verkligen ligga i /config', async () => {
  const cfg = process.env.CONFIG_DIR, sib = cfg + '2';
  fs.mkdirSync(sib, { recursive: true });
  const xml = '<?xml version="1.0"?><tv></tv>';
  fs.writeFileSync(path.join(sib, 'g.xml'), xml);
  fs.writeFileSync(path.join(cfg, 'g.xml'), xml);
  fs.symlinkSync(path.join(sib, 'g.xml'), path.join(cfg, 'länk.xml'));
  run('UPDATE tuners SET enabled=0');
  const tid = Number(run("INSERT INTO tuners(kind,name,url,tuner_count) VALUES('m3u','lokal','http://x',1)").lastInsertRowid);
  const tryUrl = async (u) => { run('UPDATE tuners SET epg_url=? WHERE id=?', u, tid); try { await live.refreshGuide(tid); } catch {} return live.guideState.error || ''; };
  assert.match(await tryUrl(path.join(sib, 'g.xml')), /Lokala filer/, 'grannmapp med samma prefix');
  assert.match(await tryUrl('file://' + path.join(cfg, 'länk.xml')), /Lokala filer/, 'symlänk ut ur /config');
  assert.match(await tryUrl(path.join(cfg, '..', path.basename(sib), 'g.xml')), /Lokala filer/);
  assert.doesNotMatch(await tryUrl(path.join(cfg, 'g.xml')), /Lokala filer/);
});

test('filbevakning: startar efter svaret och känner igen ljudformat och mappar med punkt', async () => {
  const dir = path.join(ROOT, 'bevakad');
  fs.mkdirSync(path.join(dir, 'Film.2020'), { recursive: true });
  run('DELETE FROM libraries');
  run("INSERT INTO libraries(id,name,type,path) VALUES(50,'F','movie',?)", dir);
  run("INSERT INTO libraries(id,name,type,path) VALUES(51,'B','audiobook',?)", dir);
  setSetting('watch_enabled', '1');
  act.watchLibraries(() => {});
  assert.equal(act.watchingCount(), 0, 'inget synkront arbete i anropet');
  await new Promise(r => setImmediate(r));
  assert.equal(act.watchingCount(), 1, 'ett bibliotek per varv');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(act.watchingCount(), 2);
  for (const f of ['bok.m4b', 'a.oga', 'b.aiff', 'c.aif', 'd.ape', 'e.wv', 'f.mka', 'film.mkv', 'Film.2020', 'Ny mapp', 'Borttagen'])
    assert.ok(act.watchRelevant(dir, f), f);
  fs.writeFileSync(path.join(dir, 'omslag.jpg'), '');
  for (const f of ['omslag.jpg', 'info.nfo']) assert.ok(!act.watchRelevant(dir, f), f);
  // Ett nytt anrop medan den förra omgången pågår tar över (inga dubbla bevakare)
  act.watchLibraries(() => {});
  act.watchLibraries(() => {});
  await new Promise(r => setTimeout(r, 20));
  assert.equal(act.watchingCount(), 2);
  setSetting('watch_enabled', '0');
  act.watchLibraries(() => {});
  assert.equal(act.watchingCount(), 0);
});
