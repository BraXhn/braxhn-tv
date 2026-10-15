// Robusthet: DVR-gravstenar och tunerkrockar, TV-guide utan dubbletter, kanaler som behålls när IPTV-adresser byter token,
// ljudböcker när biblioteksmappen saknas, säkerhetskopior med fel lösenfras och poddnedladdningar som avbröts av omstart.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-robust-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.DVR_DIR = path.join(ROOT, 'rec');
process.env.NODE_ENV = 'test';
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { run, get, all, now, setSetting } = await import('../server/db.js');
const live = await import('../server/livetv.js');
const dvr = await import('../server/dvr.js');
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");

/** Kör ett skript i en egen process (egen databas) och returnerar stdout */
const child = (cfg, code) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code],
  { env: { ...process.env, CONFIG_DIR: cfg, TRANSCODE_DIR: path.join(cfg, 'tc'), DVR_DIR: path.join(cfg, 'rec'), PODCAST_DIR: path.join(cfg, 'pod') }, timeout: 60000 }).toString();

const xt = (t) => { const d = new Date(t * 1000); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`; };

test('DVR: avbokad sändning bokas inte om, flyttad sändningstid synkas, krockar och tunerkö', () => {
  const tid = Number(run("INSERT INTO tuners(kind,name,url,tuner_count) VALUES('m3u','t','http://x',1)").lastInsertRowid);
  const ch = Number(run('INSERT INTO channels(tuner_id,name,stream_url) VALUES(?,?,?)', tid, 'K', 'http://s/1').lastInsertRowid);
  const ch2 = Number(run('INSERT INTO channels(tuner_id,name,stream_url) VALUES(?,?,?)', tid, 'K2', 'http://s/2').lastInsertRowid);
  const t = now() + 86400;
  run('INSERT INTO programs(channel_id,start,stop,title) VALUES(?,?,?,?)', ch, t, t + 1800, 'Nyheterna');
  const p2 = Number(run('INSERT INTO programs(channel_id,start,stop,title) VALUES(?,?,?,?)', ch, t + 3600, t + 5400, 'Nyheterna').lastInsertRowid);
  dvr.addRule({ title: 'Nyheterna', newOnly: false }, { id: 1 });
  const sched = () => all("SELECT id, start FROM recordings WHERE status='scheduled' AND title='Nyheterna' ORDER BY start");
  assert.equal(sched().length, 2);
  dvr.cancel(sched()[0].id);
  dvr.applyRules();
  assert.deepEqual(sched().map(r => r.start), [t + 3600], 'avbokningen ska stå sig');
  assert.ok(!dvr.list().scheduled.some(r => r.status === 'cancelled'), 'gravstenar visas inte');
  // En användare kan boka den igen manuellt
  const pid = get('SELECT id FROM programs WHERE channel_id=? AND start=?', ch, t).id;
  dvr.scheduleProgram(pid, { id: 1 });
  assert.equal(sched().length, 2);
  // Guiden flyttar den andra sändningen en kvart: gamla bokningen tas bort, nya bokas
  run('UPDATE programs SET start=?, stop=? WHERE id=?', t + 4500, t + 6300, p2);
  dvr.applyRules();
  assert.deepEqual(sched().map(r => r.start), [t, t + 4500]);
  // Krock: en tuner, två samtidiga bokningar
  const other = Number(run('INSERT INTO programs(channel_id,start,stop,title) VALUES(?,?,?,?)', ch2, t, t + 1800, 'Annat').lastInsertRowid);
  const c = dvr.conflicts(t, t + 1800, { channelId: ch2 });
  assert.equal(c.length, 1); assert.equal(c[0].conflict, true); assert.equal(c[0].tuners, 1);
  dvr.scheduleProgram(other, { id: 1 });
  assert.equal(dvr.conflicts(t, t + 1800)[0].conflict, true);
  // Upptagen tuner när inspelningen ska börja: väntar kvar som schemalagd i stället för att misslyckas direkt
  setSetting('dvr_pad_before', '0'); setSetting('dvr_pad_after', '0');
  assert.ok(live.acquireTuner(tid, 'live-test'));
  const id = dvr.scheduleManual({ channelId: ch, start: now() - 5, stop: now() + 600, title: 'Väntar' }, { id: 1 });
  return new Promise(r => setTimeout(r, 50)).then(() => {
    const row = get('SELECT status, error FROM recordings WHERE id=?', id);
    assert.equal(row.status, 'scheduled'); assert.equal(row.error, 'Väntar på ledig tuner');
    live.releaseTuner(tid, 'live-test');
    dvr.cancel(id);
  });
});

test('DVR: borttaget avsnitt spelas inte in igen (bara nya avsnitt)', () => {
  const tid = Number(run("INSERT INTO tuners(kind,name,url,tuner_count) VALUES('m3u','t2','http://x2',2)").lastInsertRowid);
  const ch = Number(run('INSERT INTO channels(tuner_id,name,stream_url) VALUES(?,?,?)', tid, 'K3', 'http://s/3').lastInsertRowid);
  const t = now() + 2 * 86400;
  run("INSERT INTO recordings(channel_id,title,season,episode,start,stop,status,file,created) VALUES(?,?,?,?,?,?,'done',?,0)", ch, 'Bron', 1, 1, now() - 7200, now() - 5400, path.join(ROOT, 'finns-inte.mp4'));
  const done = get("SELECT id FROM recordings WHERE title='Bron'").id;
  dvr.removeRecording(done);
  assert.equal(get('SELECT status FROM recordings WHERE id=?', done).status, 'deleted');
  assert.ok(!dvr.list().done.some(r => r.id === done));
  run('INSERT INTO programs(channel_id,start,stop,title,season,episode) VALUES(?,?,?,?,?,?)', ch, t, t + 3600, 'Bron', 1, 1);
  dvr.addRule({ title: 'Bron', channelId: ch, newOnly: true }, { id: 1 });
  assert.equal(get("SELECT COUNT(*) AS n FROM recordings WHERE title='Bron' AND status='scheduled'").n, 0);
});

test('DVR: borttagning under efterbearbetning kraschar inte', { skip: !hasFfmpeg, timeout: 90000 }, () => {
  const cfg = path.join(ROOT, 'dvrcrash'); fs.mkdirSync(path.join(cfg, 'rec'), { recursive: true });
  const ts = path.join(cfg, 'rec', 'show.ts');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25', '-t', '40', '-c:v', 'mpeg2video', '-b:v', '6M', '-f', 'mpegts', ts]);
  const out = child(cfg, `
    const { db, run, get } = await import(${JSON.stringify(path.join(SERVER, 'db.js'))});
    await import(${JSON.stringify(path.join(SERVER, 'livetv.js'))});
    db.exec(\`CREATE TABLE IF NOT EXISTS dvr_rules(id INTEGER PRIMARY KEY, title TEXT NOT NULL, channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      new_only INTEGER NOT NULL DEFAULT 1, keep INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS recordings(id INTEGER PRIMARY KEY, channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL, channel_name TEXT,
      program_id INTEGER, rule_id INTEGER REFERENCES dvr_rules(id) ON DELETE SET NULL, title TEXT NOT NULL, subtitle TEXT, description TEXT,
      season INTEGER, episode INTEGER, start INTEGER NOT NULL, stop INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
      file TEXT, size INTEGER, duration REAL, error TEXT, created_by INTEGER, created INTEGER NOT NULL);\`);
    const id = Number(run("INSERT INTO recordings(title,start,stop,status,file,created) VALUES('Show',1,2,'recording',?,1)", ${JSON.stringify(ts)}).lastInsertRowid);
    const dvr = await import(${JSON.stringify(path.join(SERVER, 'dvr.js'))}); // startar efterbearbetningen av den avbrutna inspelningen
    await new Promise(r => setTimeout(r, 700));
    dvr.removeRecording(id);
    await new Promise(r => setTimeout(r, 3000));
    console.log(JSON.stringify({ status: get('SELECT status FROM recordings WHERE id=?', id)?.status, files: (await import('node:fs')).readdirSync(${JSON.stringify(path.join(cfg, 'rec'))}) }));
    process.exit(0);`);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.status, 'deleted');
  assert.deepEqual(r.files, []);
});

test('TV-guide: långa pågående program dubbleras inte och oförändrade program behåller id', async () => {
  const T = now();
  const xml = (title2) => `<?xml version="1.0"?><tv><channel id="a.se"><display-name>Kanal A</display-name></channel>
    <programme start="${xt(T - 4 * 3600)}" stop="${xt(T + 2 * 3600)}" channel="a.se"><title>Långfilm</title></programme>
    <programme start="${xt(T + 2 * 3600)}" stop="${xt(T + 3 * 3600)}" channel="a.se"><title>${title2}</title></programme>
    <programme start="${xt(T - 10 * 3600)}" stop="${xt(T - 9 * 3600)}" channel="a.se"><title>Gammalt</title></programme></tv>`;
  const f = path.join(process.env.CONFIG_DIR, 'guide.xml');
  fs.writeFileSync(f, xml('Nyheter'));
  const tid = Number(run("INSERT INTO tuners(kind,name,url,epg_url,tuner_count) VALUES('m3u','g','http://g',?,2)", f).lastInsertRowid);
  const ch = Number(run('INSERT INTO channels(tuner_id,name,stream_url) VALUES(?,?,?)', tid, 'Kanal A HD', 'http://g/1').lastInsertRowid);
  await live.refreshGuide(tid);
  const rows = () => all('SELECT id, title FROM programs WHERE channel_id=? ORDER BY start', ch);
  assert.deepEqual(rows().map(r => r.title), ['Långfilm', 'Nyheter']);
  const film = rows()[0].id;
  // Två samtidiga anrop delar på samma körning
  const [a, b] = [live.refreshGuide(tid), live.refreshGuide(tid)];
  assert.equal(a, b);
  await a;
  fs.writeFileSync(f, xml('Sport'));
  await live.refreshGuide(tid);
  assert.deepEqual(rows().map(r => r.title), ['Långfilm', 'Sport']);
  assert.equal(rows()[0].id, film);
  // En källa vars guide inte går att hämta stoppar inte de andra, och den gamla guiden finns kvar
  const bad = Number(run("INSERT INTO tuners(kind,name,url,epg_url,tuner_count) VALUES('m3u','trasig','http://b',?,2)", path.join(process.env.CONFIG_DIR, 'saknas.xml')).lastInsertRowid);
  await live.refreshGuide();
  assert.match(live.guideState.error, /trasig/);
  assert.deepEqual(rows().map(r => r.title), ['Långfilm', 'Sport']);
  run('DELETE FROM tuners WHERE id IN (?,?)', tid, bad);
});

test('XMLTV-tolken klarar element som delas mellan bitar', () => {
  const xml = `<tv><channel id="c"><display-name>C &amp; D</display-name></channel>` +
    Array.from({ length: 50 }, (_, i) => `<programme start="20261010${String(10 + (i % 10)).padStart(2, '0')}0000 +0000" channel="c"><title>P${i}</title></programme>`).join('\n') + '</tv>';
  const got = []; let chans = [];
  const p = new live.XmltvParser({ onChannel: c => chans.push(c), onProgram: x => got.push(x.title) });
  for (let i = 0; i < xml.length; i += 7) p.feed(xml.slice(i, i + 7));
  assert.equal(got.length, 50); assert.equal(got[49], 'P49'); assert.deepEqual(chans[0].names, ['C & D']);
});

test('IPTV: kanaler behålls (favorit, id) när adressernas token byts', async () => {
  const f = path.join(process.env.CONFIG_DIR, 'list.m3u');
  const m3u = (tok) => `#EXTM3U\n#EXTINF:-1 tvg-id="svt1.se",SVT1\nhttp://iptv/svt1?token=${tok}\n#EXTINF:-1 tvg-id="tv4.se",TV4\nhttp://iptv/tv4?token=${tok}\n#EXTINF:-1,Utan id\nhttp://iptv/x?token=${tok}\n`;
  fs.writeFileSync(f, m3u('aaa'));
  const tid = Number(run("INSERT INTO tuners(kind,name,url,tuner_count) VALUES('m3u','iptv',?,2)", f).lastInsertRowid);
  await live.refreshTuner(tid, { guide: false });
  const before = all('SELECT id, name FROM channels WHERE tuner_id=? ORDER BY name', tid);
  assert.equal(before.length, 3);
  const svt = before.find(c => c.name === 'SVT1').id;
  run('UPDATE channels SET favorite=1, hidden=1 WHERE id=?', svt);
  const rule = dvr.addRule({ title: 'Rapport', channelId: svt, newOnly: true }, { id: 1 });
  fs.writeFileSync(f, m3u('bbb'));
  await live.refreshTuner(tid, { guide: false });
  const afterRows = all('SELECT id, name, stream_url, favorite, hidden FROM channels WHERE tuner_id=? ORDER BY name', tid);
  assert.deepEqual(afterRows.map(c => c.id), before.map(c => c.id));
  const s = afterRows.find(c => c.id === svt);
  assert.equal(s.stream_url, 'http://iptv/svt1?token=bbb'); assert.equal(s.favorite, 1); assert.equal(s.hidden, 1);
  assert.ok(get('SELECT 1 FROM dvr_rules WHERE id=?', rule), 'serieinspelningen finns kvar');
  // Två kanaler som byter adress med varandra krockar inte med UNIQUE-indexet
  fs.writeFileSync(f, `#EXTM3U\n#EXTINF:-1 tvg-id="svt1.se",SVT1\nhttp://iptv/tv4?token=bbb\n#EXTINF:-1 tvg-id="tv4.se",TV4\nhttp://iptv/svt1?token=bbb\n`);
  await live.refreshTuner(tid, { guide: false });
  assert.equal(get('SELECT stream_url FROM channels WHERE id=?', svt).stream_url, 'http://iptv/tv4?token=bbb');
  assert.equal(get('SELECT COUNT(*) AS n FROM channels WHERE tuner_id=?', tid).n, 2);
});

test('ljudböcker: saknad biblioteksmapp raderar inga böcker eller positioner', async () => {
  const books = await import('../server/audiobooks.js');
  const lib = path.join(ROOT, 'books-nas');
  fs.mkdirSync(lib, { recursive: true });
  run("INSERT INTO libraries(id,name,type,path) VALUES(9,'NAS-böcker','audiobook',?)", lib);
  for (let i = 0; i < 3; i++) {
    const id = Number(run('INSERT INTO books(library_id,key,title,added) VALUES(9,?,?,0)', path.join(lib, 'Bok ' + i), 'Bok ' + i).lastInsertRowid);
    run('INSERT INTO book_progress(user_id,book_id,position,updated) VALUES(1,?,100,0)', id);
  }
  fs.rmSync(lib, { recursive: true, force: true }); // NAS:en är inte monterad
  const st = {};
  await books.scanBooks(get('SELECT * FROM libraries WHERE id=9'), st);
  assert.equal(get('SELECT COUNT(*) AS n FROM books WHERE library_id=9').n, 3);
  assert.equal(get('SELECT COUNT(*) AS n FROM book_progress WHERE user_id=1').n, 3);
  assert.match((st.warnings || []).join(' '), /går inte att läsa/);
  // Tom men läsbar mapp: inte heller
  fs.mkdirSync(lib);
  await books.scanBooks(get('SELECT * FROM libraries WHERE id=9'), st);
  assert.equal(get('SELECT COUNT(*) AS n FROM books WHERE library_id=9').n, 3);
});

test('säkerhetskopia: fel lösenfras ger ett begripligt fel och ingen halv fil', async () => {
  const { encryptFile, decryptFile } = await import('../server/backupcrypt.js');
  const src = path.join(ROOT, 'db.bin'); fs.writeFileSync(src, Buffer.alloc(300000, 7));
  const enc = path.join(ROOT, 'db.bxtv'), out = path.join(ROOT, 'db.out');
  await encryptFile(src, enc, 'rätt lösenfras 123');
  await assert.rejects(() => decryptFile(enc, out, 'fel lösenfras 456'), /Fel lösenfras eller skadad fil/);
  assert.ok(!fs.existsSync(out) && !fs.existsSync(out + '.part') && !fs.existsSync(out + '.gz.part'));
  await decryptFile(enc, out, 'rätt lösenfras 123');
  assert.ok(fs.readFileSync(out).equals(fs.readFileSync(src)));
  // Kryptering som misslyckas lämnar ingen fil efter sig
  await assert.rejects(() => encryptFile(path.join(ROOT, 'saknas.db'), path.join(ROOT, 'x.bxtv'), 'lösenfras 1234567'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'x.bxtv')));
});

test('poddar: avbruten nedladdning nollställs och .part-filer tas bort vid start', () => {
  const cfg = path.join(ROOT, 'podrestart'); fs.mkdirSync(cfg, { recursive: true });
  const imp = `const { run, get } = await import(${JSON.stringify(path.join(SERVER, 'db.js'))}); const pods = await import(${JSON.stringify(path.join(SERVER, 'podcasts.js'))});`;
  child(cfg, `${imp}
    const pid = Number(run("INSERT INTO podcasts(url,added) VALUES('https://x/feed',1)").lastInsertRowid);
    run("INSERT INTO podcast_episodes(podcast_id,guid,url,downloading,added) VALUES(?,?,?,1,1)", pid, 'g1', 'https://x/a.mp3');
    (await import('node:fs')).writeFileSync(pods.DIR + '/1-1.mp3.part', 'halv');
    process.exit(0);`);
  const out = child(cfg, `${imp}
    console.log(JSON.stringify({ d: get('SELECT downloading FROM podcast_episodes').downloading, files: (await import('node:fs')).readdirSync(pods.DIR) }));
    process.exit(0);`);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.d, 0); assert.deepEqual(r.files, []);
});
