// Robusthet: skanning när disken saknas, dubbletter av serier, tomma filer, cachning av inställningar.
// Körs i samma process som modulerna (egen konfigurationsmapp); kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-rob-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
const D = await import('../server/db.js');
const sc = await import('../server/scanner.js');
const util = await import('../server/util.js');
const st = await import('../server/stream.js');
const auth = await import('../server/auth.js');
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const touch = (f, data = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const count = (libId, kind) => D.get('SELECT COUNT(*) AS n FROM items WHERE library_id=? AND kind=?', libId, kind).n;

test('skanning: saknad eller tom biblioteksmapp tömmer inte biblioteket', async () => {
  const dir = path.join(MEDIA, 'Filmer');
  for (const t of ['Alfa (2001)', 'Beta (2002)', 'Gamma (2003)']) touch(path.join(dir, `${t}.mkv`));
  const lib = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Film','movie',?)", dir).lastInsertRowid);
  await sc.scan(lib);
  assert.equal(count(lib, 'movie'), 3);

  // NAS:en avmonterad: mappen finns inte alls
  fs.renameSync(dir, dir + '-borta');
  await sc.scan(lib);
  assert.equal(count(lib, 'movie'), 3, 'inget får tas bort när mappen saknas');
  assert.ok(sc.status.warnings.some(w => /går inte att läsa/.test(w)), 'varning ska visas i skanningsstatus');

  // Tom monteringspunkt: mappen finns men är tom
  fs.mkdirSync(dir);
  await sc.scan(lib);
  assert.equal(count(lib, 'movie'), 3, 'inget får tas bort när inga filer hittas');
  assert.ok(sc.status.warnings.some(w => /inga filer hittades/.test(w)));

  // Tillbaka – och en film borttagen på riktigt: den ska försvinna
  fs.rmSync(dir, { recursive: true });
  fs.renameSync(dir + '-borta', dir);
  fs.rmSync(path.join(dir, 'Gamma (2003).mkv'));
  await sc.scan(lib);
  assert.equal(count(lib, 'movie'), 2);
  assert.deepEqual(sc.status.warnings, []);
});

test('skanning: mer än hälften saknas i ett stort bibliotek → inget tas bort', () => {
  assert.ok(util.deletionBlocked({ name: 'X', rootOk: true, files: 10, known: 40, missing: 30 }));
  assert.equal(util.deletionBlocked({ name: 'X', rootOk: true, files: 10, known: 40, missing: 30, allowMass: true }), null);
  assert.equal(util.deletionBlocked({ name: 'X', rootOk: true, files: 38, known: 40, missing: 2 }), null);
  assert.equal(util.deletionBlocked({ name: 'X', rootOk: true, files: 1, known: 3, missing: 2 }), null, 'små bibliotek får städas');
  assert.ok(util.underFailed('/m/a/b.mkv', ['/m/a']));
  assert.ok(!util.underFailed('/m/ab/b.mkv', ['/m/a']));
});

test('skanning: serie som bytt namn via TMDB får inga dubbletter (src_name)', async () => {
  const dir = path.join(MEDIA, 'Serier');
  touch(path.join(dir, 'Serien', 'Season 1', 'Serien S01E01.mkv'));
  const lib = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('TV','show',?)", dir).lastInsertRowid);
  await sc.scan(lib);
  assert.equal(count(lib, 'show'), 1);
  const show = D.get("SELECT id, src_name FROM items WHERE library_id=? AND kind='show'", lib);
  assert.equal(show.src_name, 'Serien');
  // Som refreshItem gör när TMDB har en annan titel
  D.run('UPDATE items SET title=?, sort_title=? WHERE id=?', 'The Real Serien', 'real serien', show.id);
  touch(path.join(dir, 'Serien', 'Season 1', 'Serien S01E02.mkv'));
  await sc.scan(lib);
  assert.equal(count(lib, 'show'), 1, 'nytt avsnitt får inte skapa en ny serie');
  assert.equal(D.get('SELECT COUNT(*) AS n FROM items WHERE parent_id=?', show.id).n, 2);

  // Rad från en äldre version (utan src_name, redan omdöpt): fylls i från avsnittens sökvägar
  D.run('UPDATE items SET src_name=NULL WHERE id=?', show.id);
  touch(path.join(dir, 'Serien', 'Season 1', 'Serien S01E03.mkv'));
  await sc.scan(lib);
  assert.equal(count(lib, 'show'), 1);
  assert.equal(D.get('SELECT src_name FROM items WHERE id=?', show.id).src_name, 'Serien');
  assert.equal(D.get('SELECT COUNT(*) AS n FROM items WHERE parent_id=?', show.id).n, 3);
});

test('skanning: serier med samma namn men olika år hålls isär (även efter äldre sammanslagning)', async () => {
  const dir = path.join(MEDIA, 'Serier2');
  touch(path.join(dir, 'Doctor Who (1963)', 'Season 1', 'Doctor Who S01E01.mkv'));
  touch(path.join(dir, 'Doctor Who (2005)', 'Season 1', 'Doctor Who S01E01.mkv'));
  const lib = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('TV2','show',?)", dir).lastInsertRowid);
  await sc.scan(lib);
  const shows = () => D.all("SELECT s.id, s.year, s.src_name, (SELECT COUNT(*) FROM items e WHERE e.parent_id=s.id) AS n FROM items s WHERE library_id=? AND kind='show' ORDER BY year", lib);
  assert.deepEqual(shows().map(x => [x.year, x.src_name, x.n]), [[1963, 'Doctor Who (1963)', 1], [2005, 'Doctor Who (2005)', 1]]);

  // Som en äldre version: allt under en serie med namnet utan årtal
  const [a, b] = shows();
  D.run('UPDATE items SET parent_id=? WHERE parent_id=?', a.id, b.id);
  D.run('DELETE FROM items WHERE id=?', b.id);
  D.run("UPDATE items SET src_name='Doctor Who' WHERE id=?", a.id);
  await sc.scan(lib);
  const after2 = shows();
  assert.deepEqual(after2.map(x => [x.year, x.src_name, x.n]), [[1963, 'Doctor Who (1963)', 1], [2005, 'Doctor Who (2005)', 1]]);
  assert.equal(after2[0].id, a.id, 'den gamla serien (och dess framsteg) behålls för rätt årtal');

  // Serie utan årtal påverkas inte
  touch(path.join(dir, 'Utan år', 'Season 1', 'Utan år S01E01.mkv'));
  await sc.scan(lib); await sc.scan(lib);
  assert.equal(D.get("SELECT COUNT(*) AS n FROM items WHERE library_id=? AND kind='show' AND src_name='Utan år'", lib).n, 1);
});

async function serve(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('Range: tom fil ger 200 med tom kropp, vanliga intervall fungerar', async () => {
  const empty = path.join(ROOT, 'tom.mp4'), ten = path.join(ROOT, 'tio.mp4');
  touch(empty, ''); touch(ten, '0123456789');
  await serve((req, res) => st.serveDirect(req, res, { path: req.url === '/tom' ? empty : ten }), async (B) => {
    for (const range of [undefined, 'bytes=0-', 'bytes=-500', 'bytes=0-0']) {
      const r = await fetch(B + '/tom', { headers: range ? { range } : {} });
      assert.equal(r.status, 200, `tom fil med ${range}`);
      assert.equal((await r.arrayBuffer()).byteLength, 0);
    }
    let r = await fetch(B + '/tio', { headers: { range: 'bytes=2-5' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await r.text(), '2345');
    r = await fetch(B + '/tio', { headers: { range: 'bytes=-3' } });
    assert.equal(await r.text(), '789');
    r = await fetch(B + '/tio', { headers: { range: 'bytes=20-' } });
    assert.equal(r.status, 416);
    r = await fetch(B + '/tio');
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '0123456789');
  });
});

test('inställningar och satscache: nya värden syns direkt, även efter återställd transaktion', () => {
  assert.equal(D.getSetting('rob_x', 'standard'), 'standard');
  D.setSetting('rob_x', '1');
  assert.equal(D.getSetting('rob_x'), '1');
  D.setSetting('rob_x', '2');
  assert.equal(D.getSetting('rob_x'), '2');
  // Samma SQL (cachad sats) ger uppdaterade rader
  assert.equal(D.get('SELECT v FROM settings WHERE k=?', 'rob_x').v, '2');
  D.run('UPDATE settings SET v=? WHERE k=?', '3', 'rob_x');
  assert.equal(D.get('SELECT v FROM settings WHERE k=?', 'rob_x').v, '3');
  // Transaktion som rullas tillbaka – cachen får inte visa det kasserade värdet
  assert.throws(() => D.tx(() => { D.setSetting('rob_y', 'ja'); throw new Error('avbryt'); }));
  assert.equal(D.getSetting('rob_y', 'nej'), 'nej');
  // Kapslade transaktioner (SAVEPOINT): inre fel rullar bara tillbaka den inre delen
  D.tx(() => {
    D.setSetting('rob_z', 'yttre');
    try { D.tx(() => { D.setSetting('rob_z', 'inre'); throw new Error('inre'); }); } catch {}
  });
  assert.equal(D.getSetting('rob_z'), 'yttre');
});

test('lösenordshashning: högst 4 samtidiga scrypt-körningar', async () => {
  let max = 0;
  const timer = setInterval(() => { max = Math.max(max, auth.scryptActive()); }, 1);
  await Promise.all(Array.from({ length: 12 }, (_, i) => auth.hashPw('lösenord-' + i)));
  clearInterval(timer);
  assert.ok(max <= 4, `max ${max}`);
  assert.equal(auth.scryptActive(), 0);
});

test('nyckelbildscache i minnet är begränsad', () => {
  for (let i = 0; i < 200; i++) {
    const it = { id: 900000 + i, mtime: 1 };
    fs.writeFileSync(path.join(D.CACHE, 'keyframes', `${it.id}-1.json`), '[0,6,12]');
    assert.deepEqual(st.keyframesReady(it), [0, 6, 12]);
    assert.ok(st.keyframesCached(it));
  }
  assert.ok(st.kfCacheSize() <= 64);
  assert.ok(!st.keyframesCached({ id: 123456789, mtime: 1 }));
});

test('HLS: varje uppspelning får ett eget sessions-id (två enheter på samma konto stör inte varandra)', () => {
  const d = { mode: 'transcode', q: '1080', audio: '', audioMode: 'aac', burn: '', tonemap: false, fmt: 'ts', tag: '' };
  const a = st.hlsParams(d, {}, null).get('pid'), b = st.hlsParams(d, {}, null).get('pid');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test('start: omkodningsmappen töms men tas inte bort (den är ofta en monterad volym)', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = path.join(ROOT, 'tc-mount');
  fs.mkdirSync(path.join(dir, 'gammal-session'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gammal-session', 'seg_00001.ts'), 'x');
  const born = fs.statSync(dir).birthtimeMs;
  await new Promise(r => setTimeout(r, 50));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', "await import('./server/stream.js'); process.exit(0)"],
    { env: { ...process.env, TRANSCODE_DIR: dir, CONFIG_DIR: path.join(ROOT, 'config-tc') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(dir).birthtimeMs, born, 'mappen själv ska finnas kvar (inte raderas och skapas om)');
  assert.deepEqual(fs.readdirSync(dir), []);
});
