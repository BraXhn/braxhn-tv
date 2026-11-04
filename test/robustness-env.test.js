// Robusthet i okända miljöer (tusentals Unraid-servrar med olika diskar, nät och hårdvara): behörighetsfel, en
// nätverksresurs som försvinner mitt i skanningen, symboliska länkar (även slingor och trasiga), ogiltig UTF-8 i
// filnamn, mycket djupa mappar, full disk för databasen, skadad databas vid start (nödsidan), TMDB som inte går att nå,
// containerns minnesgräns, hårdvaruval och installationsguiden utan mediamapp.
// Behörighetsfel görs med chmod på egna tempmappar när testet inte körs som root; root struntar i behörigheter, och
// då simuleras felet i stället (fs.promises.opendir kastar EACCES för mappen).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/port.js';

const REPO = path.join(import.meta.dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-robenv-'));
const MEDIA = path.join(ROOT, 'media-saknas'); // finns inte: guiden ska förklara det
const LIBS = path.join(ROOT, 'bibliotek');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.HEALTH = '0';
process.env.TRANSCODE_PROBE = '0';
delete process.env.TMDB_API_KEY;
// TMDB på en port där ingen lyssnar: anslutningen nekas (som en brandvägg som säger nej)
const closed = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
process.env.TMDB_API_URL = `http://127.0.0.1:${closed}/3`;

const D = await import('../server/db.js');
const sc = await import('../server/scanner.js');
const util = await import('../server/util.js');
const backoff = await import('../server/backoff.js');
const envcheck = await import('../server/envcheck.js');
const rescue = await import('../server/rescue.js');
const st = await import('../server/stream.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const router = await import('../server/http/router.js');
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
const kids = new Set();
after(() => { srv.close(); for (const k of kids) { try { process.kill(k.pid, 'SIGKILL'); } catch {} } fs.rmSync(ROOT, { recursive: true, force: true }); });

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const touch = (f, data = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const count = (libId) => D.get("SELECT COUNT(*) AS n FROM items WHERE library_id=? AND kind='movie'", libId).n;
const addLib = (name, dir) => Number(D.run("INSERT INTO libraries(name,type,path) VALUES(?,'movie',?)", name, dir).lastInsertRowid);
/** Kör fn med fs.promises[name] utbytt mot fake (återställs alltid) */
async function patched(name, fake, fn) {
  const orig = fs.promises[name];
  fs.promises[name] = (p, ...a) => fake(String(p), () => orig.call(fs.promises, p, ...a));
  try { return await fn(); } finally { fs.promises[name] = orig; }
}
const errno = (code) => Object.assign(new Error(`${code}: simulerat`), { code });

test('behörighetsfel på en mapp: inget tas bort där, begriplig varning, resten av biblioteket skannas', async () => {
  const dir = path.join(LIBS, 'Filmer');
  for (const t of ['Alfa (2001)', 'Beta (2002)']) touch(path.join(dir, 'Öppen', `${t}.mkv`));
  for (const t of ['Gamma (2003)', 'Delta (2004)']) touch(path.join(dir, 'Låst', `${t}.mkv`));
  const lib = addLib('Film', dir);
  await sc.scan(lib);
  assert.equal(count(lib), 4);
  const locked = path.join(dir, 'Låst');
  touch(path.join(dir, 'Öppen', 'Epsilon (2005).mkv'));
  const run = () => sc.scan(lib);
  if (isRoot) await patched('opendir', (p, real) => p === locked ? Promise.reject(errno('EACCES')) : real(), run);
  else { fs.chmodSync(locked, 0o000); try { await run(); } finally { fs.chmodSync(locked, 0o755); } }
  assert.equal(count(lib), 5, 'titlarna i den låsta mappen finns kvar och den nya filen kom med');
  assert.ok(sc.status.warnings.some(w => /Låst/.test(w) && /behörighet saknas/.test(w) && /PUID\/PGID/.test(w)), sc.status.warnings.join('\n'));
});

test('nätverksresursen försvinner mitt i skanningen (efter listningen): inget tas bort, en sammanslagen varning', async () => {
  const dir = path.join(LIBS, 'NAS');
  for (let i = 1; i <= 30; i++) touch(path.join(dir, `Film ${i} (${1980 + i}).mkv`));
  const lib = addLib('NAS', dir);
  await sc.scan(lib);
  assert.equal(count(lib), 30);
  // Varje fil ändras (ny storlek) så att skanningen måste läsa dem – och då är resursen borta
  for (let i = 1; i <= 30; i++) touch(path.join(dir, `Film ${i} (${1980 + i}).mkv`), 'xx');
  await patched('stat', (p, real) => p.startsWith(dir + path.sep) ? Promise.reject(errno('EHOSTDOWN')) : real(), () => sc.scan(lib));
  assert.equal(count(lib), 30, 'inget får tas bort');
  const w = sc.status.warnings.filter(x => /NAS: 30 filer gick inte att läsa/.test(x));
  assert.equal(w.length, 1, sc.status.warnings.join('\n'));
  assert.match(w[0], /svarar inte/);
  // Resursen försvinner under själva listningen (opendir på undermapparna misslyckas): också skyddat
  const dir2 = path.join(LIBS, 'NAS2');
  for (let i = 1; i <= 6; i++) touch(path.join(dir2, `Mapp ${i}`, `Titel ${i} (${1990 + i}).mkv`));
  const lib2 = addLib('NAS2', dir2);
  await sc.scan(lib2);
  assert.equal(count(lib2), 6);
  await patched('opendir', (p, real) => p !== dir2 && p.startsWith(dir2) ? Promise.reject(errno('ESTALE')) : real(), () => sc.scan(lib2));
  assert.equal(count(lib2), 6);
  assert.ok(sc.status.warnings.some(x => /kunde inte läsa .* och 3 till – nätverksresursen \(NFS\) har tappats/.test(x)), sc.status.warnings.join('\n'));
});

test('symboliska länkar följs utan slinga; trasig länk behåller sin titel; djupa mappar och långa namn stoppar inget', async () => {
  const dir = path.join(LIBS, 'Länkar'), ext = path.join(ROOT, 'annan-disk');
  touch(path.join(ext, 'Länkad film (2010).mkv'));
  touch(path.join(ext, 'Undermapp', 'Djupare (2011).mkv'));
  touch(path.join(dir, 'Vanlig (2012).mkv'));
  fs.symlinkSync(ext, path.join(dir, 'disk2'));                       // länkad mapp utanför biblioteket
  fs.symlinkSync('..', path.join(ext, 'Undermapp', 'slinga'));         // slinga tillbaka uppåt
  fs.symlinkSync(dir, path.join(dir, 'själv'));                        // länk till biblioteket självt
  fs.symlinkSync(path.join(ext, 'Länkad film (2010).mkv'), path.join(dir, 'Filmlänk (2013).mkv'));
  fs.symlinkSync(path.join(dir, 'a-loop'), path.join(dir, 'b-loop')); fs.symlinkSync(path.join(dir, 'b-loop'), path.join(dir, 'a-loop')); // ELOOP
  // Mycket djupt (fler nivåer än taket) och ett namn på 240 byte
  let deep = path.join(dir, 'djup');
  for (let i = 0; i < util.MAX_SCAN_DEPTH + 5; i++) deep = path.join(deep, 'd');
  touch(path.join(deep, 'För djup (2014).mkv'));
  touch(path.join(dir, `${'Å'.repeat(100)} (2015).mkv`)); // 200 byte + år och ändelse
  const t0 = Date.now();
  const list = await util.listFiles(dir, (n) => n.endsWith('.mkv'));
  assert.ok(Date.now() - t0 < 10000, 'slingan ska inte gå runt');
  const names = list.files.map(f => path.basename(f)).sort();
  assert.deepEqual(names.filter(n => !n.startsWith('Å')), ['Djupare (2011).mkv', 'Filmlänk (2013).mkv', 'Länkad film (2010).mkv', 'Vanlig (2012).mkv']);
  assert.equal(names.filter(n => n.startsWith('Å')).length, 1);
  assert.ok(list.errors.some(e => e.code === 'EDEPTH'), 'djupet har ett tak');
  const lib = addLib('Länkar', dir);
  await sc.scan(lib);
  assert.equal(count(lib), 5);
  // Målet för en länkad fil försvinner (t.ex. rclone-monteringen släppte): titeln behålls
  fs.rmSync(path.join(ext, 'Länkad film (2010).mkv'));
  const again = await util.listFiles(dir, (n) => n.endsWith('.mkv'));
  assert.ok(again.failed.includes(path.join(dir, 'Filmlänk (2013).mkv')));
  await sc.scan(lib);
  assert.ok(D.get('SELECT 1 FROM items WHERE path=?', path.join(dir, 'Filmlänk (2013).mkv')), 'trasig länk tar inte bort titeln');
});

test('filnamn med ogiltig UTF-8, NFD och emoji: hoppas över med en förklaring eller läses som vanligt', async (t) => {
  const dir = path.join(LIBS, 'Namn');
  touch(path.join(dir, 'Amélie (2001).mkv'));   // NFD (macOS över SMB)
  touch(path.join(dir, 'Film 🎬 (2019).mkv'));
  try { fs.writeFileSync(Buffer.concat([Buffer.from(dir + '/Tr'), Buffer.from([0xe4, 0xff]), Buffer.from('sk (2000).mkv')]), 'x'); }
  catch { return t.skip('filsystemet tar inte emot ogiltig UTF-8'); }
  const lib = addLib('Namn', dir);
  await sc.scan(lib);
  assert.equal(count(lib), 2);
  assert.ok(sc.status.warnings.some(w => /1 fil eller mapp har ett namn som inte är giltig UTF-8/.test(w) && /convmv/.test(w)), sc.status.warnings.join('\n'));
});

test('full disk för databasen: läsning fungerar, skrivning ger 507 med förklaring, inloggning fortsätter, läget syns och nollställs', async () => {
  const uid = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('disk','x',1,?)", D.now()).lastInsertRowid);
  const tok = auth.createSession(uid, 'app');
  D.run('UPDATE sessions SET last_seen=0'); // tvinga fram "senast sedd"-skrivningen i userFromReq
  router.route('POST', '/api/test-robust-write', router.user, (c) => { D.run('INSERT INTO audit(ts,event,detail) VALUES(?,?,?)', D.now(), 'test', 'x'.repeat(4000)); util.send(c.res, 200, { ok: true }); });
  const dir = path.join(LIBS, 'Full');
  // Långa namn: raderna behöver nya sidor i databasen (korta rader får plats i sidor som redan finns)
  for (let i = 1; i <= 60; i++) touch(path.join(dir, `${'Ny film med ett mycket långt namn '.repeat(5)}${i} (${1950 + i}).mkv`));
  const lib = addLib('Full', dir);
  D.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pages = D.db.prepare('PRAGMA page_count').get().page_count;
  D.db.exec(`PRAGMA max_page_count=${pages}`);
  try {
    const h = { authorization: `Bearer ${tok}`, 'x-forwarded-for': '192.168.1.5' };
    let r;
    for (let i = 0; i < 20; i++) { r = await fetch(B + '/api/test-robust-write', { method: 'POST', headers: h }); if (r.status !== 200) break; }
    assert.equal(r.status, 507);
    assert.match((await r.json()).error, /Disken där \/config ligger är full/);
    assert.equal(D.dbHealth.problem, 'full');
    // Läsning med samma inloggning fungerar (senast sedd kunde inte sparas – det stoppar ingenting)
    const me = await fetch(B + '/api/libraries', { headers: h });
    assert.equal(me.status, 200);
    assert.ok((await me.json()).some(l => l.name === 'Full'));
    const items = envcheck.checkItems('sv');
    assert.ok(items.some(x => x.level === 'bad' && /kan inte skriva/.test(x.title)), JSON.stringify(items));
    // Skanningen avbryts med en rad i stället för en per fil – och tar inte bort något
    for (let i = 0; i < 200000; i++) { try { D.db.prepare('INSERT INTO audit(ts,event) VALUES(0,?)').run('fyll'); } catch { break; } }
    await sc.scan(lib);
    assert.ok(sc.status.warnings.some(w => /skanningen avbröts – Disken där \/config ligger är full/.test(w)), sc.status.warnings.join('\n'));
  } finally { D.db.exec('PRAGMA max_page_count=1073741823'); D.db.exec("DELETE FROM audit WHERE event='fyll'"); }
  D.run('INSERT INTO audit(ts,event) VALUES(?,?)', D.now(), 'test');
  assert.equal(D.dbHealth.problem, null, 'första lyckade skrivningen nollställer läget');
});

test('TMDB går inte att nå: anropen slutar efter tre fel, titlarna räknas inte som "hittades inte", läget syns', async () => {
  backoff.netReset();
  D.setSetting('tmdb_key', 'nyckel');
  try {
    const dir = path.join(LIBS, 'Utan nät');
    for (let i = 1; i <= 8; i++) touch(path.join(dir, `Okänd film ${i} (${2000 + i}).mkv`));
    const lib = addLib('Utan nät', dir);
    const t0 = Date.now();
    await sc.scan(lib);
    assert.ok(Date.now() - t0 < 30000);
    assert.equal(count(lib), 8, 'filerna kommer med utan metadata');
    assert.equal(D.get('SELECT COUNT(*) AS n FROM items WHERE library_id=? AND meta_done=2', lib).n, 0, 'inget får märkas som "hittades inte" när TMDB inte svarar');
    assert.ok(sc.status.warnings.some(w => /metadata för \d+ titlar hämtas senare – TMDB går inte att nå/.test(w)), sc.status.warnings.join('\n'));
    const t1 = Date.now();
    await assert.rejects(sc.tmdb('/movie/1'), (e) => e.offline === true && /anslutningen nekades/.test(e.message));
    assert.ok(Date.now() - t1 < 100, 'under pausen görs inget anrop');
    assert.ok(envcheck.checkItems('en').some(x => /TMDB cannot be reached/.test(x.title)));
  } finally { D.setSetting('tmdb_key', ''); backoff.netReset(); }
});

test('installationsguiden utan mediamapp: servern startar och förklarar vad som ska göras i Unraid', async () => {
  const r = await fetch(B + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.168.1.20' }, body: JSON.stringify({ name: 'ny', password: 'Långt-lösen-123!' }) });
  // Det kan redan finnas ett konto från testerna ovan (direkt i databasen) – då skapas en session direkt
  const uid = r.status === 200 ? D.get("SELECT id FROM users WHERE name='ny'").id : D.get('SELECT id FROM users WHERE is_admin=1 LIMIT 1').id;
  const tok = auth.createSession(uid, 'app');
  const s = await fetch(B + '/api/setup/suggest', { headers: { authorization: `Bearer ${tok}`, 'x-forwarded-for': '192.168.1.20' } });
  assert.equal(s.status, 200);
  const j = await s.json();
  assert.equal(j.problem, 'missing');
  assert.deepEqual(j.suggestions, []);
});

test('containerns minnesgräns (cgroup v1/v2) och standardtaket för omkodningar på svag hårdvara', () => {
  const fake = path.join(ROOT, 'cg');
  const put = (f, v) => { fs.mkdirSync(path.dirname(fake + f), { recursive: true }); fs.writeFileSync(fake + f, v); };
  put('/sys/fs/cgroup/memory.max', 'max\n');
  assert.equal(envcheck.memLimit(fake), null, 'max = ingen gräns');
  put('/sys/fs/cgroup/memory.max', String(2 * 2 ** 30));
  assert.equal(envcheck.memLimit(fake), Math.min(2 * 2 ** 30, os.totalmem()));
  fs.rmSync(fake + '/sys/fs/cgroup/memory.max');
  put('/sys/fs/cgroup/memory/memory.limit_in_bytes', '9223372036854771712');
  assert.equal(envcheck.memLimit(fake), null, 'v1 utan gräns är ett jättetal');
  assert.equal(envcheck.memLimit(path.join(ROOT, 'finns-inte')), null);
  const G = 2 ** 30;
  assert.equal(envcheck.autoMaxTranscodes({ hw: 'none', ncores: 4, mem: 2 * G }), 2, 'Raspberry Pi 4 med 2 GB');
  assert.equal(envcheck.autoMaxTranscodes({ hw: 'none', ncores: 4, mem: G }), 1);
  assert.equal(envcheck.autoMaxTranscodes({ hw: 'none', ncores: 1, mem: 8 * G }), 1);
  assert.equal(envcheck.autoMaxTranscodes({ hw: 'none', ncores: 16, mem: 32 * G }), 4, 'som förut på en vanlig server');
  assert.equal(envcheck.autoMaxTranscodes({ hw: 'nvenc', ncores: 2, mem: 2 * G }), 4);
  let cleared = 0;
  envcheck.onMemoryPressure(() => cleared++);
  assert.equal(envcheck.checkMemory(500, 1000), false);
  assert.equal(envcheck.checkMemory(900, 1000), true);
  assert.equal(cleared, 1, 'cacherna töms nära gränsen');
});

test('hårdvara: felskrivna värden och auto faller tillbaka på processorn med en åtgärd', () => {
  const none = () => false;
  assert.equal(st.hwFromEnv('NVIDIA', none), 'nvenc');
  assert.equal(st.hwFromEnv('intel', none), 'vaapi');
  assert.equal(st.hwFromEnv('off', none), 'none');
  assert.equal(st.hwFromEnv('', none), 'none');
  assert.equal(st.hwFromEnv('auto', none), 'none', 'inget grafikkort: processorn');
  assert.equal(st.hwFromEnv('auto', (f) => f === '/dev/dri/renderD128'), 'vaapi');
  assert.equal(st.hwFromEnv('auto', (f) => f === '/dev/nvidiactl'), 'nvenc');
  assert.match(st.hwHint('Error creating a MFX session: unsupported (-3)'), /Intel-grafik/);
  assert.match(st.hwHint('Cannot load libcuda.so.1'), /Nvidia-Driver/);
});

test('skadad databas vid start: nödsida (svenska/engelska), engångskod, starta med tom databas och sedan normalt', { timeout: 90000 }, async () => {
  const cfg = path.join(ROOT, 'trasig');
  fs.mkdirSync(path.join(cfg, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'braxhn-tv.db'), Buffer.alloc(32768, 0x41));
  assert.deepEqual(rescue.startupProblem(Object.assign(new Error('file is not a database'), { code: 'ERR_SQLITE_ERROR', errcode: 26 }))?.kind, 'corrupt');
  assert.equal(rescue.startupProblem(new TypeError('x is not a function')), null, 'programfel ger ingen nödsida');
  const PORT = await freePort();
  const start = () => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: REPO,
      env: { ...process.env, CONFIG_DIR: cfg, TRANSCODE_DIR: path.join(cfg, 'tc'), PORT: String(PORT), HTTPS_PORT: String(PORT + 1), NODE_TEST_CONTEXT: '', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    kids.add(p); p.out = '';
    p.stdout.on('data', d => { p.out += d; }); p.stderr.on('data', d => { p.out += d; });
    p.done = new Promise(r => p.on('exit', (code) => { kids.delete(p); r(code); }));
    return p;
  };
  const wait = async (p, re) => { for (let i = 0; i < 300 && !re.test(p.out); i++) await new Promise(r => setTimeout(r, 100)); return re.exec(p.out); };
  const p1 = start();
  const m = await wait(p1, /Engångskod: (\d{6})/);
  assert.ok(m, p1.out);
  const sv = await fetch(`http://127.0.0.1:${PORT}/`, { headers: { 'accept-language': 'sv-SE' } });
  assert.equal(sv.status, 503);
  assert.match(await sv.text(), /Databasen \(braxhn-tv.db i \/config\) är skadad/);
  const en = await (await fetch(`http://127.0.0.1:${PORT}/`, { headers: { 'accept-language': 'en-US,en;q=0.9' } })).text();
  assert.match(en, /The database \(braxhn-tv.db in \/config\) is damaged/);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/status`)).status, 503);
  const post = (code) => fetch(`http://127.0.0.1:${PORT}/rescue/fresh`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${code}` });
  assert.equal((await post(m[1] === '000000' ? '111111' : '000000')).status, 403, 'fel kod');
  assert.equal((await post(m[1])).status, 200);
  assert.equal(await p1.done, 75, 'processen avslutas så att Docker startar om den');
  assert.ok(fs.readdirSync(cfg).some(f => /^braxhn-tv\.db\.skadad-/.test(f)), 'den skadade databasen sparas');
  const p2 = start();
  assert.ok(await wait(p2, /lyssnar på port/), p2.out);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/status`)).status, 200);
  p2.kill('SIGTERM');
  await p2.done;
});
