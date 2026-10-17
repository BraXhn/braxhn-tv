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

test('Blu-ray-mappar: bara huvudfilmen blir en titel och får skivans namn', async () => {
  const d = (...p) => path.join('/m', ...p);
  assert.equal(sc.discRoot(d('Titanic (1997)', 'BDMV', 'STREAM', '00800.m2ts')), d('Titanic (1997)'));
  assert.equal(sc.discRoot(d('Film (2020)', 'Film.mkv')), null);
  assert.deepEqual(sc.parseMovie(d('Titanic (1997)', 'BDMV', 'STREAM', '00800.m2ts')), { title: 'Titanic', year: 1997 });
  assert.deepEqual(sc.parseMovie(d('Titanic (1997)', 'Disc 2', 'BDMV', 'STREAM', '00001.m2ts')), { title: 'Titanic', year: 1997 });
  assert.deepEqual(sc.parseMovie(d('TITANIC_1997_D1', 'BDMV', 'STREAM', '00001.m2ts')), { title: 'TITANIC', year: 1997 });

  const dir = path.join(MEDIA, 'Filmer-BD');
  const disc = path.join(dir, 'Titanic (1997)', 'BDMV');
  touch(path.join(disc, 'STREAM', '00000.m2ts'), 'x'.repeat(10));           // varningstext
  touch(path.join(disc, 'STREAM', '00001.m2ts'), 'x'.repeat(20));           // logga
  touch(path.join(disc, 'STREAM', '00800.m2ts'), 'x'.repeat(5000));         // huvudfilmen
  touch(path.join(disc, 'BACKUP', 'STREAM', '00800.m2ts'), 'x'.repeat(6000)); // reservkopia på skivan – aldrig med
  touch(path.join(dir, 'Arrival (2016).mkv'));
  const lib = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('BD','movie',?)", dir).lastInsertRowid);
  // Som en tidigare version: varje klipp blev en egen "film" med filnamnet som titel
  for (const f of ['00000', '00001', '00800']) {
    D.run("INSERT INTO items(library_id,kind,title,sort_title,path,size,mtime,added) VALUES(?,?,?,?,?,?,?,?)",
      lib, 'movie', f, f, path.join(disc, 'STREAM', f + '.m2ts'), 1, 1, 0);
  }
  await sc.scan(lib);
  const rows = D.all("SELECT title, year, path FROM items WHERE library_id=? AND kind='movie' ORDER BY title", lib);
  assert.deepEqual(rows.map(r => [r.title, r.year]), [['Arrival', 2016], ['Titanic', 1997]]);
  assert.equal(rows[1].path, path.join(disc, 'STREAM', '00800.m2ts'));
});

test('skanning väntar inte på tunga analyser (förhandsbilder m.m.) i ett annat bibliotek', async () => {
  const a = path.join(MEDIA, 'Kö-A'), b = path.join(MEDIA, 'Kö-B');
  touch(path.join(a, 'Alfa (2001).mkv')); touch(path.join(b, 'Beta (2002).mkv'));
  const libA = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Kö-A','movie',?)", a).lastInsertRowid);
  const libB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Kö-B','movie',?)", b).lastInsertRowid);
  // En analys som "tar timmar" tills vi släpper den
  const orig = sc.hooks.trickplay; let release; const blocked = new Promise(r => { release = r; });
  sc.hooks.trickplay = (lib, st) => { st.phase = 'Skapar förhandsbilder'; return lib.id === libA ? blocked : null; };
  try {
    const pa = sc.scan(libA);
    for (let i = 0; i < 100 && !(sc.analysis.running && sc.analysis.library === 'Kö-A' && sc.analysis.phase === 'Skapar förhandsbilder'); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(sc.analysis.running, 'analysen av A pågår');
    // Skanningen av B ska bli klar (filer + metadata) trots att A:s analys står still
    sc.scan(libB);
    for (let i = 0; i < 100 && !D.get("SELECT 1 FROM items WHERE library_id=? AND title='Beta'", libB); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(D.get("SELECT 1 FROM items WHERE library_id=? AND title='Beta'", libB), 'B skannades medan A analyserades');
    assert.equal(sc.status.running, false);
    release(); await pa;
  } finally { sc.hooks.trickplay = orig; release?.(); }
});

test('iPhone (Safaris egen HLS): Dolby Digital i TS-segment blir AAC, men skickas orört till hls.js och i fMP4', () => {
  const it = { id: 999999, path: '/m/Film (2020).mkv', size: 1e9, duration: 6000, hdr: null, mtime: 1,
    streams: JSON.stringify([{ index: 0, type: 'video', codec: 'h264', width: 1920, height: 1080, pix: 'yuv420p' },
      { index: 1, type: 'audio', codec: 'ac3', channels: 6, default: true }]) };
  const caps = (extra = '') => st.parseCaps(new URLSearchParams('c=mp4&v=h264,hevc&a=aac,mp3,ac3,eac3&hdr=0&q=720' + extra));
  assert.equal(st.decide(it, caps()).audioMode, 'copy', 'hls.js/appar: orört');
  const d = st.decide(it, caps('&nhls=1'));
  assert.equal(d.fmt, 'ts'); assert.equal(d.audioMode, 'aac', 'Safari: AAC i TS');
  assert.ok(!d.reasons.some(r => /skickas orört/.test(r)));
});

test('nyckelbilder: den som trycker på Spela går före bakgrundsanalysen', async () => {
  // Fyll de två bakgrundsplatserna med filer som inte finns klara, och kontrollera att en prioriterad
  // beräkning ändå startar direkt (den tredje platsen) i stället för att köa bakom dem
  const dir = path.join(MEDIA, 'kf'); fs.mkdirSync(dir, { recursive: true });
  const mk = (id) => ({ id, vcodec: 'h264', mtime: 1, path: path.join(dir, `saknas-${id}.mkv`) });
  const bg = [st.computeKeyframes(mk(900001)), st.computeKeyframes(mk(900002)), st.computeKeyframes(mk(900003))];
  const t0 = Date.now();
  await st.computeKeyframes(mk(900004), { priority: true });
  assert.ok(Date.now() - t0 < 5000);
  await Promise.all(bg);
});
