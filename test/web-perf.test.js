// Upplevd snabbhet: platshållarfärger för bilder, asynkron komprimering av stora svar, ep_watched-frågans plan
// och att startsidan bara laddar sina egna moduler (spelaren och övriga vyer vid behov). Kräver ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { freePort } from './helpers/port.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-perf-'));
const { db, run, all, IMAGES } = await import('../server/db.js');
const { listItems, PROG, FROM } = await import('../server/http/context.js');
const { send } = await import('../server/util.js');

const lib = Number(run(`INSERT INTO libraries(name,type,path) VALUES('Serier','show','/x')`).lastInsertRowid);
const uid = Number(run(`INSERT INTO users(name,pass,created) VALUES('perf','x',1)`).lastInsertRowid);
const item = (kind, title, extra = {}) => {
  const cols = { library_id: lib, kind, title, sort_title: title, added: 1, ...extra };
  return Number(run(`INSERT INTO items(${Object.keys(cols)}) VALUES(${Object.keys(cols).map(() => '?')})`, ...Object.values(cols)).lastInsertRowid);
};

test('platshållarfärg: medelfärgen räknas fram i bakgrunden och skickas i listsvaren', { skip: !hasFfmpeg && 'ffmpeg saknas' }, async () => {
  const colors = await import('../server/imgcolor.js');
  const show = item('show', 'Färgserien', { poster: 1, backdrop: 1 });
  const ep = item('episode', 'Avsnitt 1', { parent_id: show, season: 1, episode: 1, thumb: 1 });
  const ff = (c, f, s) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=${s}`, '-frames:v', '1', '-q:v', '2', path.join(IMAGES, f)]);
  ff('0xc81e1e', `${show}-poster.jpg`, '200x300');
  ff('0x1e3cc8', `${show}-backdrop.jpg`, '320x180');
  // Halva bilden svart, halva vit: medelvärdet ska bli grått, inte en enskild bildpunkt
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90', '-f', 'lavfi', '-i', 'color=c=white:s=160x90',
    '-filter_complex', '[0][1]hstack', '-frames:v', '1', '-q:v', '2', path.join(IMAGES, `${ep}-thumb.jpg`)]);
  await colors.fillAll();
  const near = (hex, rgb, tol = 14) => {
    const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    return v.every((x, i) => Math.abs(x - rgb[i]) <= tol);
  };
  const [s] = listItems(uid, 'i.id=?', [show]);
  assert.match(s.ph, /^#[0-9a-f]{6}$/);
  assert.ok(near(s.ph, [200, 30, 30]), s.ph);
  assert.ok(near(s.phBackdrop, [30, 60, 200]), s.phBackdrop);
  assert.equal(s.phThumb, undefined); // ingen miniatyr
  const [e] = listItems(uid, 'i.id=?', [ep], 'i.id', 1, 0, { slim: true });
  assert.ok(near(e.phThumb, [128, 128, 128], 20), e.phThumb);
  assert.equal(e.showPh, s.ph); // stående avsnittskort visar seriens affisch
  // Ny bild: färgen glöms och räknas om
  ff('0x1ec81e', `${show}-poster.jpg`, '200x300');
  colors.forget(show, ['poster']);
  assert.equal(listItems(uid, 'i.id=?', [show])[0].ph, undefined);
  await colors.fillAll();
  assert.ok(near(listItems(uid, 'i.id=?', [show])[0].ph, [30, 200, 30]));
  // Saknad fil: markeras som försökt (''), inget fält i svaret och ingen evig slinga
  const lost = item('movie', 'Utan fil', { poster: 1 });
  await colors.fillAll();
  assert.equal(all('SELECT poster_color FROM items WHERE id=?', lost)[0].poster_color, '');
  assert.equal(listItems(uid, 'i.id=?', [lost])[0].ph, undefined);
  // En trasig fil i samma ffmpeg-körning som en hel: den hela får sin färg ändå
  const broken = item('movie', 'Trasig', { poster: 1 }), fine = item('movie', 'Hel', { poster: 1 });
  fs.writeFileSync(path.join(IMAGES, `${broken}-poster.jpg`), 'inte en bild');
  ff('0xc8c81e', `${fine}-poster.jpg`, '200x300');
  await colors.fillAll();
  assert.equal(all('SELECT poster_color FROM items WHERE id=?', broken)[0].poster_color, '');
  assert.ok(near(listItems(uid, 'i.id=?', [fine])[0].ph, [200, 200, 30]));
});

test('ep_watched: seriens avsnitt först, inte alla användarens progress-rader (även utan statistik)', () => {
  db.exec('DROP TABLE IF EXISTS sqlite_stat1');
  const q = `SELECT i.id, ${PROG} ${FROM} WHERE i.kind='show'`;
  const plan = all('EXPLAIN QUERY PLAN ' + q, uid).map(r => r.detail);
  const sub = plan.slice(plan.findIndex(d => /CORRELATED SCALAR SUBQUERY/.test(d)));
  const e = sub.findIndex(d => /SEARCH e USING (COVERING )?INDEX items_parent_se/.test(d));
  const p = sub.findIndex(d => /SEARCH q USING .*\(user_id=\? AND item_id=\?/.test(d));
  assert.ok(e >= 0 && p > e, plan.join('\n'));
  assert.ok(!plan.some(d => /SEARCH q USING .*\(user_id=\?\)$/.test(d)), plan.join('\n'));
  // Rätt antal: 3 av 5 avsnitt sedda (ett påbörjat räknas inte)
  const show = item('show', 'Räkneserien');
  const eps = [1, 2, 3, 4, 5].map(n => item('episode', `A${n}`, { parent_id: show, season: 1, episode: n }));
  for (const [k, w] of [[0, 1], [1, 1], [2, 1], [3, 0]]) run('INSERT INTO progress(user_id,item_id,position,watched,updated) VALUES(?,?,?,?,1)', uid, eps[k], 10, w);
  const [s] = listItems(uid, 'i.id=?', [show]);
  assert.equal(s.episodes, 5); assert.equal(s.watchedEpisodes, 3); assert.equal(s.watched, false);
});

test('stora svar komprimeras asynkront (brotli/gzip), små som förut, ETag oförändrad', async () => {
  const big = { items: Array.from({ length: 3000 }, (_, i) => ({ id: i, title: `Titel nummer ${i}`, overview: 'Text '.repeat(10) })) };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    send(res, 200, u.pathname === '/big' ? big : { ok: true, pad: 'x'.repeat(2000) }, { ETag: 'auto' });
    if (u.pathname === '/big') send(res, 500, { error: 'ska inte skickas' }); // ett andra svar medan det första komprimeras
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = (p, headers = {}) => new Promise((res) => http.get({ host: '127.0.0.1', port, path: p, headers }, (r) => {
    const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => res({ status: r.statusCode, h: r.headers, body: Buffer.concat(ch) }));
  }));
  try {
    const json = JSON.stringify(big);
    const br = await get('/big', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(br.status, 200);
    assert.equal(br.h['content-encoding'], 'br');
    assert.equal(br.h.vary, 'Accept-Encoding');
    assert.equal(zlib.brotliDecompressSync(br.body).toString(), json);
    const gz = await get('/big', { 'accept-encoding': 'gzip' });
    assert.equal(gz.h['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(gz.body).toString(), json);
    assert.equal(gz.h.etag, br.h.etag); // ETag av innehållet, inte av kodningen
    const raw = await get('/big');
    assert.equal(raw.h['content-encoding'], undefined);
    assert.equal(raw.body.toString(), json);
    assert.equal(raw.h.etag, br.h.etag);
    const nm = await get('/big', { 'accept-encoding': 'br', 'if-none-match': br.h.etag });
    assert.equal(nm.status, 304); assert.equal(nm.body.length, 0);
    // Små svar: gzip direkt som tidigare (brotli bara för stora)
    const small = await get('/small', { 'accept-encoding': 'gzip, br' });
    assert.equal(small.h['content-encoding'], 'gzip');
    assert.equal(JSON.parse(zlib.gunzipSync(small.body)).ok, true);
  } finally { srv.close(); }
});

test('webben: startsidan laddar bara sina egna moduler – spelaren och övriga vyer laddas vid behov', async () => {
  const web = path.join(import.meta.dirname, '..', 'web');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const relOf = (f) => path.relative(web, f).split(path.sep).join('/');
  const files = walk(path.join(web, 'js')).filter(f => f.endsWith('.js'));
  const { PRELOAD_FILES, LAZY_DEPS, serveStatic } = await import('../server/http/static.js');
  const isLazy = (src) => /^\/\/ @lazy\b/m.test(String(src).slice(0, 600));
  const lazy = new Set(files.filter(f => isLazy(fs.readFileSync(f, 'utf8'))).map(relOf));
  const start = new Set(PRELOAD_FILES);
  // Startens moduler = det app.js importerar statiskt. Varje modul är en förfrågan och HTTP/1.1 tar sex åt gången –
  // håll mängden liten. Spelaren, ljudspelaren och musikens moduler hör aldrig dit (fasaderna i js/lazy.js).
  assert.ok(PRELOAD_FILES.length <= 12, `${PRELOAD_FILES.length} moduler vid start: ${PRELOAD_FILES.join(' ')}`);
  // …och deras storlek (okomprimerat, med app.js): 139 kB när gränsen sattes
  const bytes = [...PRELOAD_FILES, 'app.js'].reduce((a, f) => a + fs.statSync(path.join(web, f)).size, 0);
  assert.ok(bytes <= 160_000, `${bytes} byte JavaScript vid start`);
  // Kortmenyn och bibliotekets filter laddas vid behov (app.js kopplar korten, views.lib hämtar filtret)
  for (const f of ['js/ui/cardmenu.js', 'js/ui/libfilter.js']) assert.ok(!start.has(f), `${f} laddas vid start`);
  for (const f of ['js/core.js', 'js/router.js', 'js/lazy.js', 'js/views/home.js', 'js/ui/cards.js']) assert.ok(start.has(f), f);
  for (const f of PRELOAD_FILES) assert.ok(!/^js\/(player\/|audio|sonic|musicinfo|views\/(?!home\.js))/.test(f), `${f} laddas vid start`);
  for (const m of ['admin', 'admin-ops', 'stats', 'wrapped', 'requests', 'streaming', 'live', 'item', 'music', 'books', 'search', 'account', 'login'])
    assert.ok(lazy.has(`js/views/${m}.js`), m);
  // En @lazy-modul får inte nås statiskt från app.js (då laddas den ändå direkt) – kedjan anges i felet
  for (const f of lazy) assert.ok(!start.has(f), `${f} är märkt @lazy men laddas vid start`);
  for (const f of [path.join(web, 'app.js'), ...files]) {
    const name = relOf(f);
    if (name !== 'app.js' && !start.has(name)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/^import (?:[^'"]* from )?'([^']+)';$/gm)) {
      const target = relOf(path.join(path.dirname(f), m[1]));
      assert.ok(!lazy.has(target) && !/^js\/player\//.test(target), `${name} importerar ${target} statiskt`);
    }
  }
  // Fasaderna: lazy.js importerar bara core.js (startmodulerna och spelaren importerar den)
  const lz = fs.readFileSync(path.join(web, 'js', 'lazy.js'), 'utf8');
  assert.deepEqual([...lz.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]), ['./core.js']);
  // Spelarmodulerna som fasaderna svarar för anmäler sig
  for (const [f, n] of [['player/video.js', 'video'], ['audio.js', 'audio'], ['player/live.js', 'live'], ['player/remote.js', 'remote']])
    assert.match(fs.readFileSync(path.join(web, 'js', f), 'utf8'), new RegExp(`^provide\\('${n}', self\\);`, 'm'), f);
  // Varje vy i router.js LAZY finns och registreras av sin modul
  const router = fs.readFileSync(path.join(web, 'js', 'router.js'), 'utf8');
  const table = Object.entries(JSON.parse(router.match(/const LAZY = new Map\(Object\.entries\((\{[^}]*\})\)\)/)[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"')));
  assert.ok(table.length >= 30);
  for (const [view, mod] of table) {
    assert.ok(lazy.has(`js/${mod}.js`), mod);
    assert.match(fs.readFileSync(path.join(web, 'js', mod + '.js'), 'utf8'), new RegExp(`^views\\.${view} = `, 'm'), `${mod}.js registrerar ${view}`);
  }
  // Beroendena för need(): varje modul utanför starten med alla sina importer utanför starten, och samma lista i index.html
  for (const f of files.map(relOf).filter(f => !start.has(f))) {
    const src = fs.readFileSync(path.join(web, f), 'utf8');
    const want = [...src.matchAll(/^import (?:[^'"]* from )?'([^']+)';$/gm)].map(m => relOf(path.join(web, path.dirname(f), m[1]))).filter(t => !start.has(t)).map(t => t.slice(3));
    assert.deepEqual(LAZY_DEPS[f.slice(3)] || [], want, f);
  }
  assert.ok(LAZY_DEPS['views/music.js'].includes('audio.js'));
  const html = await new Promise((resolve) => {
    const res = { writeHead() {}, end: (b) => resolve(String(b)) };
    serveStatic({ method: 'GET', headers: {} }, res, '/');
  });
  assert.deepEqual(JSON.parse(/<script type="application\/json" id="moddeps">([^<]*)<\/script>/.exec(html)[1]), LAZY_DEPS);
  // Förladdningen pekar på adresserna med innehållshash – samma som import map ger import(). Startskriptet ligger
  // direkt i sidan (först, före stilmallen) och lägger in förladdningen efter sina API-anrop: som <link> i HTML:en
  // hittar webbläsaren dem i förväg och de tar alla sex anslutningarna före /status och /home.
  const imap = JSON.parse(/<script type="importmap">([^<]*)<\/script>/.exec(html)[1]).imports;
  const inline = /<script>(self\.__preload=(\[[^\]]*\]);[\s\S]*?)<\/script>/.exec(html);
  assert.ok(inline, 'startskriptet saknas i sidan');
  const preloads = JSON.parse(inline[2]);
  for (const f of PRELOAD_FILES) assert.ok(preloads.includes(imap['/m/' + f]), `${f} förladdas inte med sin hash`);
  assert.ok(imap['/m/js/player/video.js'], 'spelaren saknas i import map (need() slår upp adressen där)');
  assert.ok(!preloads.some(u => u.includes('/player/')), 'spelaren förladdas vid start');
  assert.deepEqual([...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1].replace(/\?.*/, '')), ['/m/app.js'], 'bara app.js som <link> i sidan');
  assert.ok(html.indexOf('<script>self.__preload') < html.indexOf('rel="stylesheet"'), 'startskriptet före stilmallen');
  // Import map före startskriptet: förladdningen som startskriptet lägger in löser modulernas importer – kom den först
  // (snabbt ur service workerns cache) tappade Chrome import map-reglerna ("An import map rule … was removed") och
  // hämtade modulerna en gång till utan hash
  assert.ok(html.indexOf('<script type="importmap">') < html.indexOf('<script>self.__preload'), 'import map före startskriptet');
  assert.ok(!/start\.js/.test(html), 'start.js som egen fil');
  const fetches = inline[1].indexOf("fetch('/api'"), links = inline[1].indexOf("rel = 'modulepreload'");
  assert.ok(fetches > 0 && links > fetches, 'API-anropen startar före förladdningen');
  const csp = await new Promise((resolve) => {
    const res = { writeHead: (s, h) => resolve(h['Content-Security-Policy']), end() {} };
    serveStatic({ method: 'GET', headers: {} }, res, '/');
  });
  const hash = `'sha256-${(await import('node:crypto')).createHash('sha256').update(inline[1]).digest('base64')}'`;
  assert.ok(csp.includes(hash), 'startskriptets hash saknas i CSP');
  // Engelska: katalogen (~300 kB) stoppar inte HTML-läsningen (defer – körs ändå före modulerna)
  const en = await new Promise((resolve) => {
    const res = { writeHead() {}, end: (b) => resolve(String(b)) };
    serveStatic({ method: 'GET', headers: {} }, res, '/', '', () => 'en');
  });
  assert.match(en, /<script src="[^"]*i18n\/en\.js[^"]*" defer><\/script>/);
});

test('servern: /api/home och /api/status svarar snabbt med ett större bibliotek, ?web=1 ger samlingarna i samma svar', async () => {
  const { spawn } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-perfhome-')), CONFIG = path.join(ROOT, 'config'), MEDIA = path.join(ROOT, 'media');
  fs.mkdirSync(MEDIA, { recursive: true });
  const PORT = await freePort(), B = `http://127.0.0.1:${PORT}`, PW = 'Testlösen-2026!';
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(PORT + 1), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'),
      TMDB_API_KEY: '', WATCH_FILES: '0', UPDATE_CHECK: '0' }, stdio: ['ignore', 'ignore', 'ignore'] });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(150); } }
    const j = async (p, o = {}) => (await fetch(B + p, { method: o.method || 'GET', headers: { 'content-type': 'application/json' }, body: o.body && JSON.stringify(o.body) })).json();
    await j('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } });
    const tok = (await j('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true } })).token;
    const auth = { authorization: 'Bearer ' + tok };
    // 3000 filmer i två bibliotek, 120 serier med 20 avsnitt, 1500 sedda/påbörjade och en lista
    const d = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
    d.exec('PRAGMA busy_timeout=5000');
    const lib = (n, t) => Number(d.prepare('INSERT INTO libraries(name,type,path) VALUES(?,?,?)').run(n, t, path.join(MEDIA, n)).lastInsertRowid);
    const L = [lib('Filmer', 'movie'), lib('Barn', 'movie'), lib('Serier', 'show')];
    const ins = d.prepare(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,year,season,episode,duration,rating,genres,overview,poster,backdrop,collection_id,added)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?)`);
    const now = Math.floor(Date.now() / 1000), movies = [], eps = [];
    d.exec('BEGIN');
    const col = Number(d.prepare("INSERT INTO collections(name) VALUES('Samlingen')").run().lastInsertRowid);
    for (let i = 0; i < 3000; i++) movies.push(Number(ins.run(L[i % 2], 'movie', null, 'Film ' + i, 'film ' + i, 1960 + i % 60, null, null, 5400, 5 + i % 5, '["Drama","Action"]', 'Text '.repeat(40), i < 3 ? col : null, now - i * 900).lastInsertRowid));
    for (let s = 0; s < 120; s++) {
      const sid = Number(ins.run(L[2], 'show', null, 'Serie ' + s, 'serie ' + s, 2000 + s % 25, null, null, null, 7, '["Drama"]', 'Serie', null, now - s * 3600).lastInsertRowid);
      for (let e = 0; e < 20; e++) eps.push(Number(ins.run(L[2], 'episode', sid, 'A' + e, 'a' + e, null, 1 + (e >> 3), 1 + e, 2400, null, null, null, null, now - s * 3600 - e).lastInsertRowid));
    }
    const pr = d.prepare('INSERT OR IGNORE INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(1,?,?,?,?,?)');
    for (let i = 0; i < 1000; i++) pr.run(movies[(i * 7) % movies.length], i % 50 ? 0 : 1200, 5400, i % 50 ? 1 : 0, now - i * 60);
    for (let i = 0; i < 500; i++) pr.run(eps[(i * 3) % eps.length], 0, 2400, 1, now - i * 30);
    for (let i = 0; i < 30; i++) d.prepare('INSERT OR IGNORE INTO watchlist(user_id,item_id,added) VALUES(1,?,?)').run(movies[i * 11], now);
    d.exec('COMMIT'); d.exec('ANALYZE'); d.close();
    const time = async (p) => { const s = performance.now(); const r = await fetch(B + p, { headers: auth }); const body = await r.json(); return [performance.now() - s, body]; };
    const [, home] = await time('/api/home?web=1'); // första gången: frågorna förbereds, rekommendationerna räknas
    assert.ok(Array.isArray(home.collectionsList) && Array.isArray(home.ownCollections), 'samlingarna saknas i ?web=1');
    assert.ok(home.rows.length >= 3 && home.continue.length > 0, 'startsidan är tom');
    const [, plain] = await time('/api/home');
    assert.equal(plain.collectionsList, undefined, 'apparnas svar ska vara oförändrat');
    assert.equal(plain.ownCollections, undefined);
    const med = async (p) => { const t = []; for (let i = 0; i < 9; i++) t.push((await time(p))[0]); return t.sort((a, b) => a - b)[4]; };
    // Lokalt ~30 ms resp. ~2 ms – gränserna har marginal för en långsam CI-maskin. Blir de för snäva: titta på
    // frågeplanerna i /api/home (listItems, PROG) innan gränsen höjs.
    const h = await med('/api/home?web=1'), st = await med('/api/status');
    assert.ok(h < 250, `/api/home ${h.toFixed(0)} ms (median)`);
    assert.ok(st < 40, `/api/status ${st.toFixed(0)} ms (median)`);
  } finally { srv.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); }
});

test('service workern: startsidan från servern först (cachen per språk som reserv), ett bygge i taget, förra byggets filer ett dygn', () => {
  const sw = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'sw.js'), 'utf8');
  // Startsidan (även /?app=1): servern först med kort tidsgräns, sidan ur cachen (per språk via kakan bxlang) som reserv.
  // Förr kom den ur cachen först – en trasig sida där visades om och om igen (incident 2026-11-03, test/web-selfheal.test.js)
  assert.match(sw, /cookieStore\?\.get\('bxlang'\)/);
  assert.match(sw, /if \(u\.pathname === '\/'\) \{ e\.respondWith\(startPage\(e\)\)/);
  assert.match(sw, /const NAV_TIMEOUT = [1-4]\d{3};/);
  assert.match(sw, /e\.waitUntil\(net\.then\(res => savePage/); // alltid en ny i bakgrunden
  // Bara sidor och filer från det här bygget sparas
  assert.match(sw, /<meta name="bx-build" content="\$\{BUILD\}">/);
  assert.match(sw, /versioned\(url\) && !confirmed\(res\)\) throw/);
  assert.match(sw, /'\/__retired'/);
  // Registreras först när sidan är ritad
  const router = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'js', 'router.js'), 'utf8');
  assert.match(router, /idle\(\(\) => navigator\.serviceWorker\.register\('\/sw\.js', \{ updateViaCache: 'none' \}\)/);
});
