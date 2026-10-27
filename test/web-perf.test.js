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
  assert.ok(PRELOAD_FILES.length <= 16, `${PRELOAD_FILES.length} moduler vid start: ${PRELOAD_FILES.join(' ')}`);
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
  // Förladdningen pekar på adresserna med innehållshash – samma som import map ger import()
  const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]);
  const imap = JSON.parse(/<script type="importmap">([^<]*)<\/script>/.exec(html)[1]).imports;
  for (const f of PRELOAD_FILES) assert.ok(preloads.includes(imap['/m/' + f]), `${f} förladdas inte med sin hash`);
  assert.ok(imap['/m/js/player/video.js'], 'spelaren saknas i import map (need() slår upp adressen där)');
  assert.ok(!preloads.some(u => u.includes('/player/')), 'spelaren förladdas vid start');
});
