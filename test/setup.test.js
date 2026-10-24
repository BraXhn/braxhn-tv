// Installationsguiden: första kontot sätter guiden som ej klar, sparat läge, förslag på bibliotek ur MEDIA_ROOT
// (gissning från namn och innehåll, skydd mot sökvägar och symboliska länkar utanför), TMDB-test mot en
// låtsasserver (nyckeln sparas aldrig och syns aldrig i svar), hårdvarutest och åtkomst (admin + betrott nät).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Låtsas-TMDB: v3-nyckeln "bra-nyckel" eller v4-token "eyJbra" godkänns
const tmdbHits = [];
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  tmdbHits.push(u.pathname);
  const ok = u.searchParams.get('api_key') === 'bra-nyckel' || req.headers.authorization === 'Bearer eyJbra';
  res.writeHead(u.pathname === '/3/configuration' && ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ok ? { images: {} } : { status_message: 'Invalid API key' }));
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-setup-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.TMDB_API_URL = `http://127.0.0.1:${fake.address().port}/3`;
delete process.env.TMDB_API_KEY;

// Testmappar: namn som avslöjar typen, och mappar där bara innehållet gör det
const touch = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); };
touch(path.join(MEDIA, 'Filmer', 'Sagan om ringen (2001)', 'Sagan om ringen (2001).mkv'));
touch(path.join(MEDIA, 'Serier', 'Bron', 'Season 1', 'Bron.S01E01.mkv'));
touch(path.join(MEDIA, 'Musik', 'ABBA', 'Arrival', '01 Dancing Queen.flac'));
touch(path.join(MEDIA, 'Ljudböcker', 'Astrid Lindgren', 'Bröderna Lejonhjärta.m4b'));
for (let e = 1; e <= 6; e++) touch(path.join(MEDIA, 'Nerladdat', `Wallander.S02E0${e}.720p.mkv`));
touch(path.join(MEDIA, 'Hemvideo', 'midsommar.mp4'));
touch(path.join(MEDIA, 'data', 'Movies', 'Heat (1995).mkv'));
touch(path.join(MEDIA, 'data', 'TV', 'Fargo', 'Fargo S01E01.mkv'));
fs.mkdirSync(path.join(MEDIA, 'Tomt'));
// En hemlig mapp utanför MEDIA_ROOT och en symbolisk länk dit
const SECRET = path.join(ROOT, 'hemligt');
touch(path.join(SECRET, 'Filmer', 'privat.mkv'));
fs.symlinkSync(SECRET, path.join(MEDIA, 'ut'));

const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fake.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const LAN = { 'x-forwarded-for': '192.168.1.20' }, NET = { 'x-forwarded-for': '8.8.8.8' };
async function req(p, { method = 'GET', body, token, headers = LAN } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : await r.text() };
}

let ADMIN, tok;
test('första kontot: guiden blir ej klar och startsidan ska visa "Slutför installationen"', async () => {
  const r = await req('/api/setup', { method: 'POST', body: { name: 'anna', password: 'Långt-lösen-123!' } });
  assert.equal(r.status, 200);
  ADMIN = D.get("SELECT id FROM users WHERE name='anna'").id;
  tok = auth.createSession(ADMIN, 'app');
  assert.equal(D.getSetting('setup_done'), '0');
  const s = await req('/api/status', { token: tok });
  assert.equal(s.data.user.setupPending, true);
  // Utifrån (utan "administration överallt") visas inte rutan
  const s2 = await req('/api/status', { token: tok, headers: NET });
  assert.equal(s2.data.user.setupPending, false);
});

test('läget sparas: aktuellt steg, klarade och överhoppade steg, hela guiden klar', async () => {
  let g = await req('/api/setup', { token: tok });
  assert.equal(g.status, 200);
  assert.deepEqual(g.data.steps, ['welcome', 'metadata', 'libraries', 'hardware', 'remote', 'household', 'done']);
  assert.equal(g.data.done, false);
  assert.equal(g.data.current, 'welcome');
  assert.equal(g.data.mediaRoot, fs.realpathSync(MEDIA));
  assert.ok(g.data.timezone);
  assert.equal(g.data.checks.tmdb, false);
  assert.equal((await req('/api/setup', { method: 'PUT', token: tok, body: { current: 'libraries', step: 'welcome', status: 'done' } })).status, 200);
  await req('/api/setup', { method: 'PUT', token: tok, body: { step: 'metadata', status: 'skipped' } });
  g = await req('/api/setup', { token: tok });
  assert.equal(g.data.current, 'libraries');
  assert.equal(g.data.state.welcome, 'done');
  assert.equal(g.data.state.metadata, 'skipped');
  assert.equal(g.data.state.libraries, null);
  assert.equal((await req('/api/setup', { method: 'PUT', token: tok, body: { current: '../admin' } })).status, 400);
  assert.equal((await req('/api/setup', { method: 'PUT', token: tok, body: { step: 'welcome', status: 'kanske' } })).status, 400);
  await req('/api/setup', { method: 'PUT', token: tok, body: { done: true } });
  assert.equal((await req('/api/status', { token: tok })).data.user.setupPending, false);
  assert.equal((await req('/api/setup', { token: tok })).data.done, true);
  await req('/api/setup', { method: 'PUT', token: tok, body: { done: false } });
  assert.equal((await req('/api/status', { token: tok })).data.user.setupPending, true);
});

test('äldre installation utan inställningen: klar om det finns bibliotek', async () => {
  // Tomt värde = som en databas från före guiden (setSetting håller inställningscachen i fas)
  D.setSetting('setup_done', '');
  assert.equal((await req('/api/status', { token: tok })).data.user.setupPending, true, 'inga bibliotek → guiden visas');
  const id = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Gammal','movie',?)", path.join(fs.realpathSync(MEDIA), 'Filmer')).lastInsertRowid);
  assert.equal((await req('/api/status', { token: tok })).data.user.setupPending, false, 'bibliotek finns → ingen ruta');
  D.run('DELETE FROM libraries WHERE id=?', id);
  D.setSetting('setup_done', '0');
});

test('förslag på bibliotek: typ från mappnamn och innehåll, en nivå ner i okända mappar', async () => {
  const r = await req('/api/setup/suggest', { token: tok });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.data.suggestions.map(s => [s.name, s]));
  assert.equal(by.Filmer.type, 'movie'); assert.equal(by.Filmer.by, 'name');
  assert.equal(by.Serier.type, 'show');
  assert.equal(by.Musik.type, 'music');
  assert.equal(by['Ljudböcker'].type, 'audiobook');
  assert.equal(by.Nerladdat.type, 'show'); assert.equal(by.Nerladdat.by, 'content');
  assert.equal(by.Nerladdat.episodes, 6);
  assert.match(by.Nerladdat.reason, /SxxEyy/);
  assert.equal(by.Hemvideo.type, 'movie');
  assert.equal(by['data/Movies'].type, 'movie'); assert.equal(by['data/Movies'].suggestedName, 'Filmer');
  assert.equal(by['data/TV'].type, 'show'); assert.equal(by['data/TV'].suggestedName, 'Serier');
  assert.equal(by.Tomt.type, null);
  for (const s of r.data.suggestions) assert.ok(s.path.startsWith(fs.realpathSync(MEDIA) + path.sep), s.path);
  // Den symboliska länken ut ur MEDIA_ROOT finns inte med
  assert.ok(!r.data.suggestions.some(s => s.name.startsWith('ut') || s.path.startsWith(SECRET)));
  // Mappar som redan är bibliotek markeras
  const id = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Mina filmer','movie',?)", by.Filmer.path).lastInsertRowid);
  const r2 = await req('/api/setup/suggest', { token: tok });
  assert.equal(r2.data.suggestions.find(s => s.name === 'Filmer').library, 'Mina filmer');
  D.run('DELETE FROM libraries WHERE id=?', id);
});

test('förslag på bibliotek: sökvägar utanför MEDIA_ROOT nekas (path traversal, absolut sökväg, symbolisk länk)', async () => {
  for (const p of ['../', `${MEDIA}/../hemligt`, '/etc', SECRET, path.join(MEDIA, 'ut'), path.join(MEDIA, 'ut', 'Filmer'), `${MEDIA}/Filmer/../../hemligt`, path.join(MEDIA, 'finns-inte'), `${MEDIA}%00/etc`]) {
    const r = await req('/api/setup/suggest?path=' + encodeURIComponent(p), { token: tok });
    assert.equal(r.status, 400, p);
    assert.ok(!JSON.stringify(r.data).includes('privat.mkv'));
  }
  const sub = await req('/api/setup/suggest?path=' + encodeURIComponent(path.join(MEDIA, 'data')), { token: tok });
  assert.equal(sub.status, 200);
  assert.deepEqual(sub.data.suggestions.map(s => s.name).sort(), ['Movies', 'TV']);
  assert.equal(sub.data.parent, fs.realpathSync(MEDIA));
});

test('TMDB-test mot låtsasservern: rätt och fel nyckel, v4-token, nyckeln sparas aldrig och syns aldrig', async () => {
  tmdbHits.length = 0;
  const ok = await req('/api/setup/tmdb-test', { method: 'POST', token: tok, body: { key: ' bra-nyckel ' } });
  assert.equal(ok.status, 200); assert.deepEqual(ok.data, { ok: true });
  assert.deepEqual(tmdbHits, ['/3/configuration']);
  const v4 = await req('/api/setup/tmdb-test', { method: 'POST', token: tok, body: { key: 'eyJbra' } });
  assert.equal(v4.status, 200);
  const bad = await req('/api/setup/tmdb-test', { method: 'POST', token: tok, body: { key: 'fel-nyckel-123' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /godkände inte/);
  assert.ok(!JSON.stringify(bad.data).includes('fel-nyckel-123'));
  assert.equal(D.getSetting('tmdb_key', ''), '', 'testet sparar inte nyckeln');
  // Utan nyckel och ingen sparad
  const none = await req('/api/setup/tmdb-test', { method: 'POST', token: tok, body: {} });
  assert.equal(none.status, 400);
  // Sparad nyckel testas när fältet är tomt
  D.setSetting('tmdb_key', 'bra-nyckel');
  assert.equal((await req('/api/setup/tmdb-test', { method: 'POST', token: tok, body: { key: '' } })).status, 200);
  const g = await req('/api/setup', { token: tok });
  assert.equal(g.data.checks.tmdb, true);
  assert.ok(!JSON.stringify(g.data).includes('bra-nyckel'), 'nyckeln lämnas aldrig ut');
  D.setSetting('tmdb_key', '');
  // Nyckel med mellanslag/radbrytning i mitten nekas utan anrop
  tmdbHits.length = 0;
  assert.equal((await req('/api/setup/tmdb-test', { method: 'POST', token: tok, body: { key: 'a b' } })).status, 400);
  assert.equal(tmdbHits.length, 0);
});

test('hårdvara: vad servern ser och en kort testkodning (processorn fungerar, VAAPI utan /dev/dri ger åtgärd)', async () => {
  const h = await req('/api/setup/hw', { token: tok });
  assert.equal(h.status, 200);
  assert.ok(Array.isArray(h.data.dri) && Array.isArray(h.data.encoders));
  assert.ok(h.data.cpu.cores > 0);
  assert.ok(['none', 'vaapi', 'qsv', 'nvenc'].includes(h.data.recommend));
  const cpu = await req('/api/setup/hw-test', { method: 'POST', token: tok, body: { mode: 'none' } });
  assert.equal(cpu.status, 200);
  assert.equal(cpu.data.ok, true, cpu.data.error);
  assert.ok(cpu.data.fps > 0);
  assert.equal((await req('/api/setup/hw-test', { method: 'POST', token: tok, body: { mode: 'rm -rf' } })).status, 400);
  if (!fs.existsSync('/dev/dri/renderD128')) {
    const va = await req('/api/setup/hw-test', { method: 'POST', token: tok, body: { mode: 'vaapi' } });
    assert.equal(va.status, 200);
    assert.equal(va.data.ok, false);
    assert.ok(va.data.error);
  }
});

test('åtkomst: kräver administratör och betrott nät', async () => {
  const uid = Number(D.run("INSERT INTO users(name,pass,is_admin,created,remote_allowed) VALUES('bertil','x',0,0,1)").lastInsertRowid);
  const ut = auth.createSession(uid, 'app');
  const routes = [['GET', '/api/setup'], ['PUT', '/api/setup', { done: true }], ['GET', '/api/setup/suggest'], ['POST', '/api/setup/tmdb-test', { key: 'bra-nyckel' }],
    ['GET', '/api/setup/hw'], ['POST', '/api/setup/hw-test', { mode: 'none' }]];
  for (const [method, p, body] of routes) {
    assert.equal((await req(p, { method, body })).status, 401, `${method} ${p} utan inloggning`);
    assert.equal((await req(p, { method, body, token: ut })).status, 403, `${method} ${p} som vanlig användare`);
    assert.equal((await req(p, { method, body, token: tok, headers: NET })).status, 403, `${method} ${p} utifrån`);
  }
  assert.equal((await req('/api/status', { token: ut })).data.user.setupPending, false, 'bara administratörer ser rutan');
  assert.equal(D.getSetting('setup_done'), '0', 'inget av anropen ändrade läget');
});
