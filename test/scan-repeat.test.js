// Det som timskanningen gjorde om varje gång hos ägaren: en trasig fil ("moov atom not found") lästes och loggades
// varje timme, OpenSubtitles/Google Books svarade 429 för samma titel varje timme, och "N serier delades upp eller
// slogs ihop efter årtal" loggades vid varje skanning. Här: andra skanningen av ett oförändrat bibliotek gör ingenting,
// och händelseslingan står aldrig still länge under skanningen av ett barnbibliotek med konstiga filnamn.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-repeat-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.CREDITS_PER_SCAN = '0';
process.env.TMDB_API_KEY = '';
process.env.BOOK_META_GAP_MS = '0';
const hasFfmpeg = spawnSync('ffprobe', ['-version']).status === 0;

// ---------- låtsas-Google Books och -OpenSubtitles: alltid 429 ----------
const calls = [];
let retryAfter = '3600', osShort = 0;
const srv = http.createServer((q, r) => {
  calls.push(q.url);
  if (q.url.startsWith('/os/') && osShort > 0) { osShort--; r.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }); return r.end('{"message":"API rate limit exceeded"}'); }
  if (q.url.startsWith('/os/')) {
    if (decodeURIComponent(q.url).includes('ok=1')) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{"data":[]}'); }
    r.writeHead(429, { 'retry-after': retryAfter, 'content-type': 'application/json' }); return r.end('{"message":"API rate limit exceeded"}');
  }
  r.writeHead(429, { 'retry-after': retryAfter }); r.end('{}');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
process.env.GOOGLE_BOOKS_URL = B + '/gb';
process.env.OPENLIBRARY_URL = B + '/ol';
process.env.AUDIBLE_URL = B + '/au';
process.env.AUDNEXUS_URL = B + '/ax';
process.env.OPENSUBTITLES_API_URL = B + '/os';

const D = await import('../server/db.js');
const sc = await import('../server/scanner.js');
const backoff = await import('../server/backoff.js');
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const logs = [];
const capture = async (fn) => {
  const ol = console.log, ow = console.warn; const mine = [];
  console.log = (...a) => { mine.push(a.join(' ')); }; console.warn = (...a) => { mine.push(a.join(' ')); };
  try { await fn(); } finally { console.log = ol; console.warn = ow; }
  logs.push(...mine);
  return mine;
};
const put = (rel, data = '') => { const f = path.join(MEDIA, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };

// Barnbibliotek med ägarens konstiga namn, serier med och utan årtal i mappnamnet och en trasig MP4
const BARN = path.join(MEDIA, 'Barn TV');
const broken = put('Barn TV/Nostalgikanalen/julkalender/Trolltider.2.mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.alloc(4000, 7)]));
for (const f of ['Trolltider.1.mp4', 'Trolltider.3.mp4']) put('Barn TV/Nostalgikanalen/julkalender/' + f);
for (const f of ['Broderna fluff 103 dvdrip-pripps.avi', 'Bröderna Fluff/Broderna fluff 104 dvdrip-pripps.avi', 'Barn/Dexters labratorium/Säsong 1/03a - DextersRival.avi',
  'Barn/Dexters labratorium/Säsong 1/03b - Simion.avi', 'Dexters labratorium/01a - Changes.avi', 'Alfons Åberg (2013)/Alfons Åberg S01E01.mkv', 'Alfons Åberg/Alfons Åberg S01E02.mkv',
  'pripps-alfons.aberg.s01e09.avi', 'Bluey (2018)/Bluey S01E01.mkv', 'Bluey/Bluey 1x15.mkv', 'Bluey/Säsong 2/Avsnitt 17.mkv', 'Pokémon (1997)/Pokemon 001.avi',
  'Pokémon/Pokémon - Del 50.mp4', 'Pokemon Svenskt tal/Pokemon - 090.avi', 'Doctor Who (1963)/Doctor Who S01E01.mkv', 'Doctor Who (2005)/Doctor.Who.2005.S01E01.mkv',
  'Mumin/Mumintrollen/Mumintrollen - Avsnitt 7.avi', 'Bamse/Bamse 1x01.mkv', 'Bamse (1972)/Bamse - 02.mkv', '...mkv', 'Avsnitt.mkv', '01.mkv', '2.mp4']) put('Barn TV/' + f);
const LIB = Number(D.run("INSERT INTO libraries(name,type,path,anime) VALUES('Barn TV','show',?,0)", BARN).lastInsertRowid);
const shows = () => D.all("SELECT id, src_name, src_alias FROM items WHERE kind='show' AND library_id=? ORDER BY id", LIB);
const eps = () => D.all("SELECT id, path, parent_id FROM items WHERE kind='episode' AND library_id=? ORDER BY id", LIB);

test('skanning två gånger: andra gången inga ändringar, ingen ny ffprobe av den trasiga filen, ingen omgruppering', { skip: !hasFfmpeg && 'ffprobe saknas', timeout: 120000 }, async () => {
  const first = await capture(() => sc.scan(LIB));
  const probeLogs = (l) => l.filter(x => x.includes('ffprobe misslyckades') && x.includes('Trolltider.2.mp4'));
  assert.equal(probeLogs(first).length, 1, 'den trasiga filen loggas en gång');
  assert.match(probeLogs(first)[0], /moov atom not found|Invalid data/, 'felet utan kommandoraden');
  assert.doesNotMatch(probeLogs(first)[0], /Command failed/);
  const fail = D.get('SELECT * FROM probe_fail WHERE path=?', broken);
  assert.ok(fail, 'misslyckandet sparas');
  assert.equal(fail.size, fs.statSync(broken).size);
  assert.ok(D.get('SELECT id FROM items WHERE path=?', broken), 'filen finns ändå kvar som titel');
  const before = { shows: shows(), eps: eps() };

  for (let round = 2; round <= 3; round++) {
    const again = await capture(() => sc.scan(LIB));
    assert.equal(probeLogs(again).length, 0, `skanning ${round}: den oförändrade trasiga filen läses inte igen`);
    assert.deepEqual(again.filter(x => /delades upp|slogs ihop/.test(x)), [], `skanning ${round}: inga omgrupperingar`);
    assert.deepEqual(shows(), before.shows, `skanning ${round}: samma serier`);
    assert.deepEqual(eps(), before.eps, `skanning ${round}: avsnitten ligger kvar under samma serie`);
    assert.ok(D.get('SELECT id FROM items WHERE path=?', broken), 'den trasiga filen tas inte bort');
  }
  // Admins Hälsokontroll visar filen
  const u = sc.unreadableFiles().filter(x => x.path === broken);
  assert.equal(u.length, 1);
  assert.ok(u[0].skipped);
  assert.match(u[0].error, /moov atom|Invalid data/);

  // Filen byts ut (ny storlek): läses igen, och lyckas den försvinner raden
  const ok = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x36:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', broken]);
  assert.equal(ok.status, 0);
  const fixed = await capture(() => sc.scan(LIB));
  assert.equal(probeLogs(fixed).length, 0);
  assert.equal(D.get('SELECT * FROM probe_fail WHERE path=?', broken), undefined, 'läst igen efter ändringen');
  assert.ok(D.get('SELECT duration FROM items WHERE path=?', broken).duration > 0);
});

test('en serie som tar över ett namn med årtal behåller det gamla namnet (regroupShows flyttar inget nästa gång)', { skip: !hasFfmpeg && 'ffprobe saknas' }, async () => {
  // Först bara mappen utan årtal, sedan en mapp med årtal: den befintliga serien tar över nyckeln "Mamma Mu (2008)"
  const dir = path.join(MEDIA, 'Barn Ar');
  put('Barn Ar/Mamma Mu/Mamma Mu S01E01.mkv');
  const id = Number(D.run("INSERT INTO libraries(name,type,path,anime) VALUES('Barn Ar','show',?,0)", dir).lastInsertRowid);
  await capture(() => sc.scan(id));
  put('Barn Ar/Mamma Mu (2008)/Mamma Mu S01E02.mkv');
  await capture(() => sc.scan(id));
  const list = D.all("SELECT id, src_name, src_alias FROM items WHERE kind='show' AND library_id=?", id);
  assert.equal(list.length, 1, JSON.stringify(list));
  assert.equal(list[0].src_name, 'Mamma Mu (2008)');
  assert.deepEqual(JSON.parse(list[0].src_alias), ['Mamma Mu'], 'det gamla namnet blir ett alias');
  // Nästa skanning: avsnittet i mappen utan årtal ligger kvar (förut: ny serie + ihopslagning, samma logg varje gång)
  const again = await capture(() => sc.scan(id));
  assert.deepEqual(again.filter(x => /delades upp|slogs ihop/.test(x)), []);
  assert.equal(D.all("SELECT id FROM items WHERE kind='show' AND library_id=?", id).length, 1);
  assert.ok(D.all("SELECT parent_id FROM items WHERE kind='episode' AND library_id=?", id).every(e => e.parent_id === list[0].id));
});

test('händelseslingan under skanning av ett större barnbibliotek med konstiga namn: inga långa stopp, inga oändliga loopar', { skip: !hasFfmpeg && 'ffprobe saknas', timeout: 300000 }, async () => {
  const dir = path.join(MEDIA, 'Stora Barn');
  const names = ['Trolltider', 'Broderna fluff', 'Dexters labratorium', 'Bamse', 'Pippi Långstrump', 'Alfons Åberg', 'Mumin', 'Bolibompa'];
  for (let i = 0; i < 200; i++) {
    const nm = `${names[i % names.length]} ${i}`, yr = i % 3 === 0 ? ` (${1990 + i % 30})` : '';
    const d = path.join(dir, i % 5 === 0 ? 'Barn' : '', `${nm}${yr}`, i % 2 ? 'Säsong 1' : '');
    fs.mkdirSync(d, { recursive: true });
    for (let e = 1; e <= 10; e++) {
      const f = [`${nm}.${e}.mp4`, `${nm} 1${String(e).padStart(2, '0')} dvdrip-pripps.avi`, `${String(e).padStart(2, '0')}a - DextersRival.avi`,
        `${nm} S01E${String(e).padStart(2, '0')}.mkv`, `Avsnitt ${e}.mp4`][e % 5];
      fs.writeFileSync(path.join(d, f), '');
    }
  }
  const id = Number(D.run("INSERT INTO libraries(name,type,path,anime) VALUES('Stora Barn','show',?,0)", dir).lastInsertRowid);
  for (let round = 1; round <= 2; round++) {
    const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
    let worst = 0, last = performance.now();
    const iv = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last - 10); last = n; }, 10);
    const t0 = Date.now();
    const out = await capture(() => sc.scan(id));
    clearInterval(iv); h.disable();
    const n = D.get("SELECT COUNT(*) AS n FROM items WHERE kind='episode' AND library_id=?", id).n;
    console.log(`[mätning] skanning ${round}: ${n} avsnitt på ${Date.now() - t0} ms, längsta stopp ${worst.toFixed(0)} ms, p99 ${(h.percentile(99) / 1e6).toFixed(0)} ms`);
    assert.equal(n, 2000);
    // CI-maskiner är långsamma: gränsen är generös men fångar en loop som blockerar i sekunder
    assert.ok(worst < 1500, `händelseslingan stod still ${worst.toFixed(0)} ms`);
    if (round === 2) assert.deepEqual(out.filter(x => /delades upp|slogs ihop/.test(x)), []);
  }
});

test('429 från OpenSubtitles: kort Retry-After väntas ut, lång pausar tjänsten exponentiellt med en loggrad', async () => {
  const os_ = await import('../server/opensubtitles.js');
  D.setSetting('os_key', 'nyckel');
  // Två korta 429 ("API rate limit exceeded", Retry-After 0) och sedan svar: anroparen märker inget
  osShort = 2; calls.length = 0;
  const it = { id: 1, kind: 'movie', title: 'Film', path: '/finns/inte', tmdb_id: null, year: 2000 };
  assert.deepEqual(await os_.search({ ...it, title: 'ok=1' }, ['sv']), []);
  assert.equal(calls.length, 3);
  // Lång Retry-After: fel med rateLimited och retryAfter, ingen väntan
  osShort = 0; retryAfter = '7200';
  await assert.rejects(os_.search(it, ['sv']), (e) => e.rateLimited && e.retryAfter === 7200000);
  // Backoff: Retry-After styr när den är längre än den exponentiella pausen; därefter fördubblas pausen
  backoff.reset('x');
  const l1 = await capture(async () => { assert.equal(backoff.limited('x', { retryAfter: 7200e3, label: 'X', tag: 't' }), 7200e3); });
  assert.equal(l1.length, 1);
  assert.ok(backoff.waitMs('x') > 7000e3);
  assert.equal(backoff.limited('x', { label: 'X', tag: 't' }), 30 * 60e3, 'andra gången i rad: 2 × 15 min');
  assert.equal(backoff.limited('x', { label: 'X', tag: 't' }), 60 * 60e3);
  for (let i = 0; i < 10; i++) backoff.limited('x', { label: 'X', tag: 't' });
  assert.equal(backoff.info('x').wait <= backoff.MAX_MS, true, 'högst ett dygn');
  const l2 = await capture(async () => backoff.ok('x', { label: 'X', tag: 't' }));
  assert.match(l2[0], /svarar igen efter 13 pauser/);
  assert.equal(backoff.waitMs('x'), 0);
  assert.equal(backoff.retryAfterMs('120'), 120000);
  assert.equal(backoff.retryAfterMs(new Date(Date.now() + 60e3).toUTCString()) > 55e3, true);
  assert.equal(backoff.retryAfterMs('nonsens'), null);
  assert.deepEqual([1, 2, 3].map(backoff.nextTrySec), [3600, 4 * 3600, 16 * 3600]);
});

test('429 från Google Books: en loggrad, inga fler anrop under pausen och boken försöks inte först varje timme', async () => {
  const meta = await import('../server/bookmeta.js');
  const lib = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Böcker','audiobook',?)", path.join(ROOT, 'b')).lastInsertRowid);
  const ins = (t, added) => Number(D.run('INSERT INTO books(library_id,key,title,author,added) VALUES(?,?,?,?,?)', lib, t, t, 'Katarina Wennstam', added).lastInsertRowid);
  const smuts = ins('Katarina_Wennstam_-_Smuts-AUDiOBOOK-WEB-SE-2007-CRAViNGS_iNT', 200), other = ins('Flickan och skulden', 100);
  retryAfter = '0'; calls.length = 0;
  const first = await capture(() => meta.queue(lib));
  const gb = calls.filter(c => c.startsWith('/gb') || c.startsWith('/au'));
  assert.equal(gb.length, 1, `ett anrop som gav 429, sedan stopp: ${calls}`);
  const rl = first.filter(x => /för många anrop/.test(x));
  assert.equal(rl.length, 1, first.join('\n'));
  assert.match(rl[0], /pausar i 15 min/);
  const m = D.get('SELECT * FROM book_meta WHERE book_id=?', smuts);
  assert.equal(m.rl_tries, 1);
  assert.ok(m.next_try >= D.now() + 3500, 'boken försöks igen om en timme');
  assert.equal(m.state, 0, 'inte "ingen träff"');
  // Nästa timskanning medan pausen pågår: inga anrop alls och ingen loggrad
  calls.length = 0;
  const second = await capture(() => meta.queue(lib));
  assert.equal(calls.length, 0);
  assert.deepEqual(second.filter(x => /bokmetadata/.test(x)), []);
  // Pausen slut: den andra boken går först (Smuts väntar till sitt next_try)
  backoff.reset(`bookmeta:${new URL(B).host}`);
  calls.length = 0;
  await capture(() => meta.queue(lib));
  assert.ok(calls.length >= 1);
  assert.equal(D.get('SELECT rl_tries FROM book_meta WHERE book_id=?', other).rl_tries, 1, 'den andra boken försöktes');
  assert.equal(D.get('SELECT rl_tries FROM book_meta WHERE book_id=?', smuts).rl_tries, 1, 'Smuts försöktes inte igen');
});
