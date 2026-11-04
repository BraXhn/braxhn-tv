// Föräldraöversikten (server/parents.js, server/routes/parents.js): vem som får se vad, tid per dag, mest sett,
// kvällstittande, ljudböcker, Spelas nu och Stoppa. Körs i samma process (servern på en ledig port); kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-parents-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
fs.mkdirSync(MEDIA, { recursive: true });
const D = await import('../server/db.js');
const parents = await import('../server/parents.js');
const screen = await import('../server/screentime.js');
const act = await import('../server/activity.js');
const sc = await import('../server/scanner.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const { freePort } = await import('./helpers/port.js');

const PORT = await freePort(1);
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
const B = `http://127.0.0.1:${PORT}`;
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const user = (sql, ...a) => Number(D.run(`INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES(?,'x',0,0,?,?)`, sql, ...a).lastInsertRowid);
const MAMMA = user('mamma', null, null);
const LISA = user('lisa', MAMMA, 7);
const OLLE = user('olle', MAMMA, 11);
const PAPPA = user('pappa', MAMMA, null); // vuxen profil i samma hushåll – syns aldrig i översikten
const GRANNE = user('granne', null, null);
const GRANNBARN = user('grannbarn', GRANNE, 7);
const tok = Object.fromEntries([MAMMA, LISA, OLLE, PAPPA, GRANNE].map(id => [id, auth.createSession(id, 'app')]));
async function req(uid, p, { method = 'GET', body } = {}) {
  const h = { Authorization: `Bearer ${tok[uid]}` };
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}

const touch = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };
const SHOWDIR = path.join(MEDIA, 'Serier');
for (const n of [1, 2, 3]) touch(path.join(SHOWDIR, 'Bamse', 'Season 1', `Bamse S01E0${n}.mkv`));
const FILMDIR = path.join(MEDIA, 'Filmer');
touch(path.join(FILMDIR, 'Pippi Långstrump (1969)', 'Pippi Långstrump (1969).mkv'));
touch(path.join(FILMDIR, 'Emil i Lönneberga (1971)', 'Emil i Lönneberga (1971).mkv'));
const TV = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Barnserier','show',?)", SHOWDIR).lastInsertRowid);
const FILM = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Barnfilm','movie',?)", FILMDIR).lastInsertRowid);
await sc.scan(TV); await sc.scan(FILM);
D.run('UPDATE items SET age=0');
const SHOW = D.get("SELECT id FROM items WHERE kind='show' AND title='Bamse'").id;
const ep = (n) => D.get('SELECT id FROM items WHERE parent_id=? AND episode=?', SHOW, n).id;
const PIPPI = D.get("SELECT id FROM items WHERE kind='movie' AND title LIKE 'Pippi%'").id;
const EMIL = D.get("SELECT id FROM items WHERE kind='movie' AND title LIKE 'Emil%'").id;
const BOOKLIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Böcker','audiobook',?)", path.join(MEDIA, 'Böcker')).lastInsertRowid);
const BOOK = Number(D.run("INSERT INTO books(library_id,key,title,added) VALUES(?,?,?,0)", BOOKLIB, 'mamma-mu', 'Mamma Mu åker bobsläde').lastInsertRowid);

// Fast "nu": onsdag 14 oktober 2026 kl. 12 (lokal tid) – dagarna räknas bakåt därifrån
const AT = Math.floor(new Date(2026, 9, 14, 12).getTime() / 1000);
const ts = (daysAgo, h, m = 0) => Math.floor(new Date(2026, 9, 14 - daysAgo, h, m).getTime() / 1000);
const play = (uid, item, at, played, extra = {}) => D.run(`INSERT INTO plays(user_id,item_id,ts,ended,played,duration,pos_end,remote,device,kind,title,season,episode,show_id,show_title)
  SELECT ?,i.id,?,?,?,1000,?,?,?,i.kind,i.title,i.season,i.episode,i.parent_id,s.title FROM items i LEFT JOIN items s ON s.id=i.parent_id WHERE i.id=?`,
  uid, at, at + played, played, extra.pos ?? played, extra.remote ? 1 : 0, extra.device || 'Chrome', item);
play(LISA, ep(1), ts(0, 8), 600);
play(LISA, ep(2), ts(0, 9), 900, { remote: true, device: 'iPhone/iPad-app' });
play(LISA, PIPPI, ts(1, 22, 15), 3000, { pos: 500 }); // kvällstittande
play(LISA, ep(3), ts(3, 17), 1200);
play(LISA, EMIL, ts(12, 10), 4000); // utanför 7 dagar, inom 30
play(OLLE, EMIL, ts(0, 7), 300);
play(PAPPA, PIPPI, ts(0, 20), 5000);
play(GRANNBARN, PIPPI, ts(0, 10), 100);
D.run("INSERT INTO book_listen(user_id,book_id,day,seconds) VALUES(?,?,?,?)", LISA, BOOK, screen.localDay(new Date(ts(0, 12) * 1000)), 1200);
D.run("INSERT INTO book_listen(user_id,book_id,day,seconds) VALUES(?,?,?,?)", LISA, BOOK, screen.localDay(new Date(ts(2, 12) * 1000)), 600);

test('vem ser vad: bara huvudkontot, bara barnprofiler i det egna hushållet', async () => {
  assert.deepEqual(parents.kidsOf(D.get('SELECT * FROM users WHERE id=?', MAMMA)).map(k => k.name), ['lisa', 'olle']);
  let r = await req(MAMMA, '/api/parents');
  assert.equal(r.status, 200); assert.equal(r.data.owner, true);
  assert.deepEqual(r.data.kids.map(k => k.name), ['lisa', 'olle'], 'pappa (vuxen profil) syns inte');
  // Barnet själv, den vuxna profilen och grannen
  for (const [uid, owner, n] of [[LISA, false, 0], [PAPPA, false, 0], [GRANNE, true, 1]]) {
    r = await req(uid, '/api/parents');
    assert.equal(r.data.owner, owner, `owner för ${uid}`); assert.equal(r.data.kids.length, n);
  }
  // Andras barn, vuxna profiler och huvudkontot självt ger 404 – även Stoppa
  for (const [uid, pid] of [[MAMMA, GRANNBARN], [MAMMA, PAPPA], [MAMMA, MAMMA], [LISA, LISA], [PAPPA, LISA], [GRANNE, LISA], [MAMMA, 99999]]) {
    assert.equal((await req(uid, `/api/parents/${pid}`)).status, 404, `${uid} → ${pid}`);
    assert.equal((await req(uid, `/api/parents/${pid}/stop`, { method: 'POST' })).status, 404, `stopp ${uid} → ${pid}`);
  }
  assert.equal((await fetch(B + '/api/parents')).status, 401);
  // Menyn: antal barnprofiler i /api/status (bara för huvudkontot)
  assert.equal((await req(MAMMA, '/api/status')).data.user.kidProfiles, 2);
  for (const uid of [LISA, PAPPA]) assert.equal((await req(uid, '/api/status')).data.user.kidProfiles, 0);
  assert.equal((await req(GRANNE, '/api/status')).data.user.kidProfiles, 1);
});

test('detaljer: tid per dag, mest sett (serien som en titel), kvällstittande, utifrån och ljudböcker', () => {
  const kid = parents.kidOf(D.get('SELECT * FROM users WHERE id=?', MAMMA), LISA);
  const d = parents.detail(kid, 7, AT);
  assert.equal(d.days, 7); assert.equal(d.perDay.length, 7);
  const day = (n) => d.perDay[6 - n];
  assert.equal(day(0).day, '2026-10-14'); assert.equal(day(6).day, '2026-10-08');
  assert.deepEqual([day(0).video, day(0).audio], [1500, 1200]);
  assert.deepEqual([day(1).video, day(2).audio, day(3).video], [3000, 600, 1200]);
  assert.equal(d.totals.video, 1500 + 3000 + 1200, 'filmen för 12 dagar sedan räknas inte på 7 dagar');
  assert.equal(d.totals.audio, 1800);
  assert.equal(d.totals.plays, 4); assert.equal(d.totals.titles, 2, 'Bamse (tre avsnitt) och Pippi');
  assert.equal(d.totals.late, 1); assert.equal(d.totals.remote, 1);
  assert.equal(d.totals.avgPerDay, Math.round((5700 + 1800) / 7));
  // Mest sett: Pippi (3000 s) före Bamse (600 + 900 + 1200 = 2700 s, tre avsnitt)
  assert.deepEqual(d.top.map(t => [t.id, t.kind, t.seconds, t.plays, t.episodes]), [[PIPPI, 'movie', 3000, 1, 0], [SHOW, 'show', 2700, 3, 3]]);
  assert.deepEqual(d.books, [{ id: BOOK, title: 'Mamma Mu åker bobsläde', seconds: 1800 }]);
  // Senaste: nyast först, avsnittets fulla namn, procent sett, kväll och utanför hemmet
  assert.match(d.recent[0].title, /^Bamse – S01E02/);
  assert.equal(d.recent[0].remote, true); assert.equal(d.recent[0].device, 'iPhone/iPad-app');
  const pippi = d.recent.find(r => r.itemId === PIPPI);
  assert.equal(pippi.late, true); assert.equal(pippi.percent, 50);
  // 30 dagar tar med Emil; ogiltig period blir 7
  const m = parents.detail(kid, 30, AT);
  assert.equal(m.perDay.length, 30); assert.equal(m.totals.titles, 3);
  assert.equal(parents.detail(kid, 9999, AT).days, 7);
  // Olle har sitt eget
  assert.deepEqual(parents.detail(parents.kidOf(D.get('SELECT * FROM users WHERE id=?', MAMMA), OLLE), 7, AT).top.map(t => t.id), [EMIL]);
});

test('detaljer via API: kort för titlar som finns, en borttagen titel behåller namnet', async () => {
  // Uppspelning i dag av en titel som sedan tas bort ur biblioteket
  const gone = Number(D.run("INSERT INTO items(library_id,kind,title,path,added) VALUES(?,'movie','Borttagen film','/finns/inte.mkv',0)", FILM).lastInsertRowid);
  play(LISA, gone, D.now() - 60, 120);
  play(LISA, PIPPI, D.now() - 3600, 300); // uppspelningarna ovan har fasta datum – den här ligger alltid inom perioden
  D.run('DELETE FROM items WHERE id=?', gone);
  const r = await req(MAMMA, `/api/parents/${LISA}?days=30`);
  assert.equal(r.status, 200); assert.equal(r.data.days, 30);
  const g = r.data.recent.find(x => x.title === 'Borttagen film');
  assert.ok(g, 'raden finns kvar'); assert.equal(g.itemId, null);
  assert.equal(r.data.top.find(t => t.title === 'Borttagen film').item, null);
  const p = r.data.top.find(t => t.id === PIPPI);
  assert.equal(p.item.id, PIPPI); assert.equal(p.item.kind, 'movie');
});

test('sammanfattning: dagens tid och skärmtid, Spelas nu och Stoppa', async () => {
  screen.setRules(LISA, { daily: 60 });
  let r = await req(MAMMA, '/api/parents');
  let lisa = r.data.kids.find(k => k.id === LISA);
  assert.equal(lisa.screen.limited, true); assert.equal(lisa.screen.daily, 60);
  assert.ok(lisa.today.video >= 120, 'dagens uppspelning (den borttagna filmen) räknas');
  assert.ok(lisa.last.title);
  assert.deepEqual(lisa.now, []);
  // Lisa börjar titta (uppspelningsbeslutet startar sessionen) – mamma ser det och stoppar
  assert.equal((await req(LISA, `/api/items/${ep(1)}/playback`)).status, 200);
  await req(LISA, `/api/items/${ep(1)}/progress`, { method: 'POST', body: { position: 30, duration: 1000 } });
  r = await req(MAMMA, '/api/parents');
  lisa = r.data.kids.find(k => k.id === LISA);
  assert.equal(lisa.now.length, 1); assert.match(lisa.now[0].title, /^Bamse – S01E01/); assert.equal(lisa.now[0].position, 30);
  assert.deepEqual(r.data.kids.find(k => k.id === OLLE).now, []);
  // Grannen kan inte stoppa, mamma kan
  assert.equal((await req(GRANNE, `/api/parents/${LISA}/stop`, { method: 'POST' })).status, 404);
  assert.equal(act.isStopped(LISA, ep(1)), false);
  r = await req(MAMMA, `/api/parents/${LISA}/stop`, { method: 'POST' });
  assert.deepEqual(r.data, { stopped: 1 });
  assert.equal(act.isStopped(LISA, ep(1)), true);
  r = await req(LISA, `/api/items/${ep(1)}/progress`, { method: 'POST', body: { position: 40, duration: 1000 } });
  assert.equal(r.data.stop, true, 'barnets spelare får veta att den ska stoppa');
  assert.equal((await req(LISA, `/api/items/${ep(1)}/playback`)).status, 403, 'kan inte starta om direkt');
  assert.deepEqual((await req(MAMMA, `/api/parents/${LISA}/stop`, { method: 'POST' })).data, { stopped: 0 });
  // Säkerhetsloggen
  assert.ok(D.get("SELECT 1 FROM audit WHERE event='stream_stopped' AND detail LIKE 'lisa:%'"), 'stoppet loggas');
  screen.setRules(LISA, null);
});
