// Musikkön överlever omladdning (server/musicqueue.js ↔ web/js/audio.js): samma låt, kö (blandad ordning, upprepning)
// och position efter omladdning, pausad – Spela fortsätter där man var. Flera flikar (den senast använda vinner, en
// flik som bara visar kön skriver inget), profiler (en annan profils kö visas aldrig), låtar som tagits bort eller som
// en barnprofil inte får se (hoppas över), storleksgräns, stängd spelare och GDPR-exporten/raderingen.
// Webbläsardelen hoppas över om ffmpeg eller Playwright saknas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './helpers/port.js';
import { clearMusicQueue } from './helpers/musicqueue.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const skip = !hasFfmpeg ? 'ffmpeg saknas' : false;
const skipWeb = skip || (!chromium ? 'Playwright saknas' : false);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-mqueue-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, browser, tok = '', cookie = '', kidTok = '', kidCookie = '', kidId = 0, adminId = 0;
const L = [], H = []; // låtarnas id: albumet Lugna (biblioteket Musik) och Hemlig (biblioteket Vuxen)
const S = {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
async function req(p, { method = 'GET', body, token = tok } = {}) {
  const h = { authorization: 'Bearer ' + token };
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
}
const login = async (app) => fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW, app }) });
function album(lib, name, freq, n, len) {
  const dir = path.join(MEDIA, lib, 'Testaren', name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) ff('-f', 'lavfi', '-i', `sine=f=${freq + i * 50}:r=44100:d=${len}`, '-ac', '1', '-c:a', 'flac', '-metadata', `title=${name} ${i + 1}`,
    '-metadata', 'artist=Testaren', '-metadata', `album=${name}`, '-metadata', `track=${i + 1}`, path.join(dir, `0${i + 1} ${name} ${i + 1}.flac`));
}

before(async () => {
  if (skip) return;
  album('Musik', 'Lugna', 330, 4, 20);
  album('Vuxen', 'Hemlig', 550, 3, 5);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '',
      WATCH_FILES: '0', MUSIC_SONIC: '0', MUSIC_LOUDNESS: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  if (!skipWeb) browser = await chromium.launch(fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : {});
});
after(async () => { await browser?.close(); srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip }, fn);
const tw = (name, fn) => test(name, { skip: skipWeb }, fn);

t('förberedelse: konto, två musikbibliotek och en barnprofil som bara får se det ena', async () => {
  assert.equal((await fetch(B + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) })).status, 200);
  tok = (await (await login(true)).json()).token;
  cookie = /kt=([0-9a-f]+)/.exec((await login(false)).headers.get('set-cookie'))[1];
  for (const lib of ['Musik', 'Vuxen']) assert.equal((await req('/api/libraries', { method: 'POST', body: { name: lib, type: 'music', path: path.join(MEDIA, lib) } })).status, 200);
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const r = (await req('/api/scan')).data;
    if (!r.running && r.last && db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n === 7) break;
  }
  for (const r of db.prepare("SELECT t.id, al.title FROM tracks t JOIN albums al ON al.id=t.album_id ORDER BY t.track_no").all()) (r.title === 'Lugna' ? L : H).push(r.id);
  for (const r of db.prepare('SELECT id, title FROM albums').all()) S[r.title] = r.id;
  const musik = db.prepare("SELECT id FROM libraries WHERE name='Musik'").get().id;
  adminId = db.prepare("SELECT id FROM users WHERE name='admin'").get().id;
  assert.equal(L.length, 4); assert.equal(H.length, 3);
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  kidId = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  db.prepare('UPDATE users SET libraries=? WHERE id=?').run(JSON.stringify([musik]), kidId);
  db.close();
  // Bytet tar bort sessionen det görs från – egna inloggningar till det
  kidTok = (await req('/api/profiles/switch', { method: 'POST', body: { id: kidId }, token: (await (await login(true)).json()).token })).data.token;
  const wc = /kt=([0-9a-f]+)/.exec((await login(false)).headers.get('set-cookie'))[1];
  const sw = await fetch(B + '/api/profiles/switch', { method: 'POST', headers: { 'content-type': 'application/json', origin: B, cookie: 'kt=' + wc }, body: JSON.stringify({ id: kidId }) });
  kidCookie = /kt=([0-9a-f]+)/.exec(sw.headers.get('set-cookie'))[1];
  await req('/api/me/listening', { method: 'PUT', body: { normMode: 'off', gapless: true, crossfade: 0 } });
});

t('API: kön sparas och läses i samma ordning, med plats, position, upprepning och låtradio', async () => {
  assert.deepEqual((await req('/api/me/queue')).data.tracks, [], 'ingen kö från början');
  const order = [L[2], L[0], L[3], L[1]]; // blandad ordning
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { uid: adminId, ids: order, idx: 2, pos: 7.53, repeat: true, radio: { seed: { albumId: S.Lugna, x: 1 }, name: 'Lugna' } } })).status, 200);
  const q = (await req('/api/me/queue')).data;
  assert.deepEqual(q.tracks.map(x => x.id), order);
  assert.equal(q.idx, 2); assert.equal(q.pos, 7.5); assert.equal(q.repeat, true);
  assert.deepEqual(q.radio, { seed: { albumId: S.Lugna }, name: 'Lugna' });
  assert.equal(q.tracks[0].title, 'Lugna 3', 'låtarna som i albumlistorna');
});

t('API: felaktiga köer och en annan profils kö nekas', async () => {
  for (const body of [{ ids: 'x', idx: 0 }, { ids: [L[0], -1], idx: 0 }, { ids: [L[0]], idx: 1 }, { ids: [L[0]], idx: 0.5 }, [1, 2]]) {
    assert.equal((await req('/api/me/queue', { method: 'PUT', body })).status, 400, JSON.stringify(body));
  }
  // En flik från före ett profilbyte (uid = den gamla profilen) får inte skriva i den nya profilens kö
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { uid: adminId, ids: [L[0]], idx: 0 }, token: kidTok })).status, 409);
  assert.deepEqual((await req('/api/me/queue', { token: kidTok })).data.tracks, [], 'barnprofilen har ingen kö');
  assert.equal((await req('/api/me/queue')).data.tracks.length, 4, 'administratörens kö är orörd');
});

t('API: för lång kö kortas till ett fönster runt platsen', async () => {
  const ids = Array.from({ length: 3000 }, (_, i) => L[i % 4]);
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { ids, idx: 1500, pos: 1 } })).status, 200);
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  const r = db.prepare('SELECT tracks, idx FROM music_queue WHERE user_id=?').get(adminId);
  db.close();
  assert.equal(JSON.parse(r.tracks).length, 1000);
  assert.equal(r.idx, 200, 'platsen följer med (200 låtar före den behålls)');
  assert.equal(JSON.parse(r.tracks)[r.idx], ids[1500]);
});

t('API: borttagna låtar och låtar som barnprofilen inte får se hoppas över – platsen går till nästa låt', async () => {
  // Barnprofilen: Hemlig ligger i ett bibliotek den inte får se
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { uid: kidId, ids: [L[0], H[0], L[1], H[1]], idx: 1, pos: 3 }, token: kidTok })).status, 200);
  let q = (await req('/api/me/queue', { token: kidTok })).data;
  assert.deepEqual(q.tracks.map(x => x.id), [L[0], L[1]]);
  assert.equal(q.idx, 1, 'platsen på nästa låt som finns kvar'); assert.equal(q.pos, 0);
  // Spelade låten själv är synlig: positionen står kvar
  await req('/api/me/queue', { method: 'PUT', body: { ids: [H[0], L[0], L[1]], idx: 1, pos: 4 }, token: kidTok });
  q = (await req('/api/me/queue', { token: kidTok })).data;
  assert.deepEqual([q.tracks.length, q.idx, q.pos], [2, 0, 4]);
  // Låten har tagits bort ur biblioteket
  await req('/api/me/queue', { method: 'PUT', body: { ids: [L[0], H[2], L[1]], idx: 1, pos: 3 } });
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare('DELETE FROM tracks WHERE id=?').run(H[2]);
  db.close();
  q = (await req('/api/me/queue')).data;
  assert.deepEqual([q.tracks.map(x => x.id), q.idx, q.pos], [[L[0], L[1]], 1, 0]);
  // Inget kvar efter platsen och ingen upprepning: kön var slut
  await req('/api/me/queue', { method: 'PUT', body: { ids: [L[0], H[0]], idx: 1, pos: 2 }, token: kidTok });
  assert.deepEqual((await req('/api/me/queue', { token: kidTok })).data.tracks, []);
});

t('GDPR: kön följer med i exporten och försvinner när profilen raderas', async () => {
  await req('/api/me/queue', { method: 'PUT', body: { ids: [L[0], L[1]], idx: 0, pos: 2 }, token: kidTok });
  const ex = (await req('/api/me/export')).data;
  const rows = ex.tables.music_queue || [];
  assert.ok(rows.some(r => r.user_id === adminId) && rows.some(r => r.user_id === kidId), 'båda profilernas köer i exporten: ' + JSON.stringify(rows));
  // Raderingen prövas på en egen profil (barnprofilen behövs i webbläsartesterna)
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Tillfällig' } })).status, 200);
  const pid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Tillfällig').id;
  const ptok = (await req('/api/profiles/switch', { method: 'POST', body: { id: pid }, token: (await (await login(true)).json()).token })).data.token;
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { ids: [L[0]], idx: 0 }, token: ptok })).status, 200);
  assert.equal((await req('/api/profiles/' + pid, { method: 'DELETE' })).status, 200);
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM music_queue WHERE user_id=?').get(pid).n, 0);
  db.close();
  await req('/api/me/queue', { method: 'DELETE' });
  await req('/api/me/queue', { method: 'DELETE', token: kidTok });
});

// ---------- webbläsaren ----------
async function newContext(kt = cookie, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport, bypassCSP: true });
  await ctx.addCookies([{ name: 'kt', value: kt, url: B }]);
  return ctx;
}
async function newPage(ctx) {
  const page = await ctx.newPage();
  const errors = [], puts = [], played = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => {
    if (/\/api\/me\/queue$/.test(r.url()) && r.method() === 'PUT') puts.push(JSON.parse(r.postData() || '{}'));
    if (/\/played$/.test(r.url())) played.push(r.url());
  });
  const mods = () => page.evaluate(async () => { window.__ae = await import('/m/js/audioengine.js'); window.__au = await import('/m/js/audio.js'); });
  const info = () => page.evaluate(() => {
    const M = window.__au.M, el = document.querySelector('#maudio');
    return { idx: M.idx, ids: M.queue.map(x => x.id), repeat: M.repeat, resume: M.resume, paused: M.audio?.paused ?? null, pos: M.audio?.currentTime ?? null,
      title: document.querySelector('#mtitle')?.textContent, hidden: document.querySelector('#mbar')?.hidden ?? true,
      rep: document.querySelector('#mrep')?.getAttribute('aria-pressed'), curt: document.querySelector('#mcurt')?.textContent, engine: window.__ae.debugState().on, elSrc: !!el?.getAttribute('src') };
  });
  /** Väntar tills minispelaren visar en återställd kö (router.js när sidan ritats) */
  const restored = () => page.waitForFunction(() => document.querySelector('#mbar') && !document.querySelector('#mbar').hidden, null, { timeout: 15000 });
  return { page, errors, puts, played, mods, info, restored };
}
const playing = (page) => page.waitForFunction(() => { const el = document.querySelector('#maudio'); return window.__ae.debugState().on ? !window.__ae.E.paused : !!el && !el.paused && el.currentTime > 0.1; }, null, { timeout: 30000 });

tw('omladdning: samma låt, blandad kö, upprepning och position – pausad, och Spela fortsätter där', async () => {
  const ctx = await newContext(), A = await newPage(ctx);
  await A.page.goto(B + '/#/album/' + S.Lugna);
  await A.page.waitForSelector('#sa');
  await A.mods();
  await A.page.click('#sa'); // Blanda
  await playing(A.page);
  await A.page.click('#mnext');
  await A.page.waitForFunction(() => window.__au.M.idx === 1);
  await playing(A.page);
  await A.page.click('#mrep');
  await A.page.evaluate(() => window.__au.seekTo(9));
  await sleep(800);
  await A.page.click('#mplay'); // paus
  await sleep(1500); // sparas en sekund efter senaste ändringen
  const before = await A.info();
  assert.ok(before.paused && before.pos >= 9 && before.pos < 11, JSON.stringify(before));
  const last = A.puts.at(-1);
  assert.ok(last && last.idx === 1 && last.repeat === true && Math.abs(last.pos - before.pos) < 0.3, 'sparat vid paus: ' + JSON.stringify(last));
  const playedBefore = A.played.length;

  await A.page.reload();
  await A.restored();
  await A.mods();
  const after = await A.info();
  assert.equal(after.title, before.title, 'samma låt');
  assert.deepEqual(after.ids, before.ids, 'samma kö i samma (blandade) ordning');
  assert.equal(after.idx, 1);
  assert.equal(after.repeat, true); assert.equal(after.rep, 'true', 'upprepningsknappen är på');
  assert.equal(after.paused, true, 'pausad');
  assert.ok(Math.abs(after.pos - before.pos) < 0.3, `samma position: ${after.pos} mot ${before.pos}`);
  assert.equal(after.curt, '0:' + String(Math.floor(after.pos)).padStart(2, '0'), 'tiden visas');
  assert.equal(await A.page.locator('#mplay').getAttribute('aria-label'), 'Spela');
  await sleep(1500);
  assert.equal(A.played.length, playedBefore, 'en återställd kö räknas inte som spelad');
  assert.equal(A.puts.length, 1 + A.puts.indexOf(last), 'en flik som bara visar kön skriver inget');

  await A.page.click('#mplay');
  await playing(A.page);
  await sleep(500);
  const go = await A.info();
  assert.equal(go.idx, 1);
  assert.ok(go.pos >= before.pos - 0.2 && go.pos < before.pos + 3, `fortsatte där: ${go.pos} (sparat ${before.pos})`);
  assert.equal(A.played.length, playedBefore + 1, 'nu räknas låten som spelad');
  assert.deepEqual(A.errors, []);
  await ctx.close();
});

tw('flera flikar: den senast använda vinner, en stängd flik som inte använts skriver inte över', async () => {
  const ctx = await newContext(), A = await newPage(ctx);
  await A.page.goto(B + '/#/album/' + S.Lugna);
  await A.page.waitForSelector('tr[data-ti="0"]');
  await A.mods();
  await A.page.click('tr[data-ti="0"]');
  await playing(A.page);
  await sleep(1300); // låtbytet sparas efter en sekund
  const Bt = await newPage(ctx);
  await Bt.page.goto(B + '/');
  await Bt.restored();
  await Bt.mods();
  assert.equal((await Bt.info()).idx, 0);
  await sleep(2500);
  assert.equal(Bt.puts.length, 0, 'fliken som bara visar kön skriver inget medan A spelar: ' + JSON.stringify(Bt.puts));
  await A.page.click('#mplay'); // A pausar …
  await sleep(1300);
  await Bt.page.click('#mnext'); // … och B används: nästa låt
  await Bt.page.waitForFunction(() => window.__au.M.idx === 1);
  await playing(Bt.page);
  await sleep(1300);
  assert.ok(Bt.puts.length >= 1 && Bt.puts.at(-1).idx === 1, 'B sparar: ' + JSON.stringify(Bt.puts.at(-1)));
  const aPuts = A.puts.length;
  await A.page.close({ runBeforeUnload: true }); // A är pausad och har inget osparat
  await sleep(500);
  assert.equal(A.puts.length, aPuts, 'A skrev inget när fliken stängdes');
  await Bt.page.click('#mplay');
  await sleep(1300);
  const C = await newPage(ctx);
  await C.page.goto(B + '/');
  await C.restored();
  await C.mods();
  const c = await C.info();
  assert.equal(c.idx, 1, 'den senast använda fliken (B) vann');
  assert.equal(c.ids[1], L[1]);
  assert.deepEqual([...A.errors, ...Bt.errors, ...C.errors], []);
  await ctx.close();
});

tw('profiler: barnprofilen ser aldrig administratörens kö, och tvärtom', async () => {
  // Administratörens kö finns kvar från förra testet
  assert.equal((await req('/api/me/queue')).data.tracks.length, 4);
  const kctx = await newContext(kidCookie), K = await newPage(kctx);
  await K.page.goto(B + '/');
  await K.page.waitForSelector('#userbtn');
  await sleep(2500);
  assert.equal(await K.page.evaluate(() => !document.querySelector('#mbar') || document.querySelector('#mbar').hidden), true, 'ingen minispelare för barnprofilen');
  // Barnprofilen spelar en egen kö; administratörens är orörd
  await K.page.goto(B + '/#/album/' + S.Lugna);
  await K.page.waitForSelector('tr[data-ti="3"]');
  await K.mods();
  await K.page.click('tr[data-ti="3"]');
  await playing(K.page);
  await sleep(1300);
  assert.equal((await req('/api/me/queue', { token: kidTok })).data.idx, 3);
  const a = (await req('/api/me/queue')).data;
  assert.equal(a.idx, 1, 'administratörens kö är orörd');
  // Byte av profil i samma flik: kön stängs innan profilen väljs
  await K.page.evaluate(() => { location.hash = '#/profiles'; });
  await K.page.waitForFunction(() => document.querySelector('#mbar').hidden);
  assert.deepEqual(await K.page.evaluate(() => window.__au.M.queue.length), 0);
  assert.deepEqual(K.errors, []);
  await kctx.close();
});

tw('omladdning på långsamt nät: elementet tar låten och börjar på den sparade positionen', async () => {
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { ids: L, idx: 2, pos: 12 } })).status, 200);
  const ctx = await newContext(), A = await newPage(ctx);
  await A.page.goto(B + '/');
  await A.restored();
  await A.mods();
  assert.equal((await A.info()).pos, 12);
  const cdp = await ctx.newCDPSession(A.page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 60e3 / 8, uploadThroughput: 1e6 }); // under låtens bithastighet
  await A.page.click('#mplay');
  await A.page.waitForFunction(() => { const el = document.querySelector('#maudio'); return !!el.getAttribute('src') && el.currentTime >= 11.5; }, null, { timeout: 30000 });
  const st = await A.info();
  assert.equal(st.engine, false, 'elementet spelar');
  assert.equal(st.idx, 2); assert.equal(st.resume, null);
  assert.ok(st.pos >= 11.5 && st.pos < 16, 'positionen: ' + st.pos);
  assert.deepEqual(A.errors, []);
  await ctx.close();
});

tw('ljudbok eller podd efter en återställd kö: talet spelar som förut och musikkön kommer inte tillbaka', async () => {
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { ids: L, idx: 1, pos: 5 } })).status, 200);
  const ctx = await newContext(), A = await newPage(ctx);
  await A.page.goto(B + '/');
  await A.restored();
  await A.mods();
  // Ett avsnitt med en fil (låtens ström duger som ljudfil; positionen på servern prövas i audiobook-tools.test.js)
  await A.page.evaluate((id) => window.__au.playSpoken({ kind: 'podcast', id: 999999, title: 'Avsnittet', duration: 20, position: 0, files: [{ url: `/api/music/tracks/${id}/stream`, offset: 0 }] }), L[3]);
  await A.page.waitForFunction(() => { const el = document.querySelector('#maudio'); return !el.paused && el.currentTime > 1; }, null, { timeout: 20000 });
  const st = await A.page.evaluate(() => ({ spoken: !!window.__au.M.spoken, resume: window.__au.M.resume, title: document.querySelector('#mtitle').textContent, speed: !document.querySelector('#mspeed').hidden, q: window.__au.M.queue.length }));
  assert.deepEqual(st, { spoken: true, resume: null, title: 'Avsnittet', speed: true, q: 0 });
  await sleep(1200);
  assert.deepEqual((await req('/api/me/queue')).data.tracks, [], 'musikkön är borttagen');
  // Kön minns bara vilket avsnitt (web-spoken-queue.test.js) – inga låtar. Avsnittet finns inte på servern, så efter
  // omladdning visas inget alls.
  assert.deepEqual(A.puts, [{ uid: adminId, ids: [], spoken: { kind: 'podcast', id: 999999 } }], 'talet skriver ingen musikkö');
  await A.page.click('#mplay');
  await A.page.reload();
  await A.page.waitForSelector('#userbtn');
  await sleep(2500);
  assert.equal(await A.page.evaluate(() => !document.querySelector('#mbar') || document.querySelector('#mbar').hidden), true);
  assert.deepEqual(A.errors, []);
  await ctx.close();
});

tw('musikfältet: ikoner med namn i stället för emoji, och hela raden ryms på en telefon (390 px)', async () => {
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { ids: L, idx: 0, pos: 2 } })).status, 200);
  for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const ctx = await newContext(cookie, vp), A = await newPage(ctx);
    await A.page.goto(B + '/');
    await A.restored();
    const r = await A.page.evaluate(() => {
      const row = document.querySelector('#mbar .mctl'), W = document.documentElement.clientWidth;
      const btns = [...document.querySelectorAll('#mbar button')].filter(b => !b.hidden && getComputedStyle(b).display !== 'none');
      return { sw: row.scrollWidth, cw: row.clientWidth, W, out: btns.filter(b => { const x = b.getBoundingClientRect(); return x.left < 0 || x.right > W; }).map(b => b.id),
        unnamed: btns.filter(b => !b.getAttribute('aria-label') && !b.textContent.trim()).map(b => b.id),
        emoji: btns.filter(b => /\p{Extended_Pictographic}|[☾✕⏮⏭↺↻]/u.test(b.textContent)).map(b => b.id + ':' + b.textContent.trim()),
        noIcon: btns.filter(b => b.id !== 'mq' && !b.querySelector('svg')).map(b => b.id) };
    });
    // Förut: 🔁 📻 ⏮ ⏭ ☾ 📺 ✕ som text, Låttext utan namn, och på 390 px rullade raden så att 📻 klipptes
    assert.ok(r.sw <= r.cw, `${vp.width}: knappraden rullar (${r.sw} > ${r.cw})`);
    assert.deepEqual(r.out, [], `${vp.width}: knappar utanför skärmen`);
    assert.deepEqual(r.emoji, [], `${vp.width}: emoji i knapparna`);
    assert.deepEqual(r.noIcon, [], `${vp.width}: knappar utan ikon`);
    assert.deepEqual(r.unnamed, [], `${vp.width}: knappar utan namn`);
    for (const id of ['mprev', 'mnext', 'mrep', 'msleep', 'mlyr', 'mradio', 'mx']) assert.ok(await A.page.locator('#' + id).getAttribute('aria-label'), id + ' har namn');
    assert.deepEqual(A.errors, []);
    await ctx.close();
  }
});

tw('stängd spelare (✕): kön tas bort och kommer inte tillbaka', async () => {
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { ids: L, idx: 0, pos: 2 } })).status, 200);
  const ctx = await newContext(), A = await newPage(ctx);
  await A.page.goto(B + '/');
  await A.restored();
  await A.page.click('#mx');
  await sleep(500);
  assert.deepEqual((await req('/api/me/queue')).data.tracks, []);
  await A.page.reload();
  await A.page.waitForSelector('#userbtn');
  await sleep(2500);
  assert.equal(await A.page.evaluate(() => !document.querySelector('#mbar') || document.querySelector('#mbar').hidden), true);
  assert.deepEqual(A.errors, []);
  await ctx.close();
});

tw('motorn tar över efter en omkodad låt som spolats: tiden och Föregående gäller nästa låt', async () => {
  await clearMusicQueue(req);
  const ctx = await newContext(), A = await newPage(ctx);
  // Elementets ström (och HEAD) kodas om (som för ett format webbläsaren inte spelar); motorn får inte första låten
  // (elementet tar den) men hämtar nästa som vanligt, så att den kan ta över vid övergången
  await A.page.route(/\/api\/music\/tracks\/\d+\/stream\?/, (r) => {
    const u = new URL(r.request().url());
    if (u.searchParams.get('gl') === '1') return u.pathname.includes(`/tracks/${L[0]}/`) ? r.abort() : r.continue();
    u.searchParams.set('a', 'mp3'); r.continue({ url: String(u) });
  });
  await A.page.goto(B + '/#/album/' + S.Lugna);
  await A.page.waitForSelector('tr[data-ti="0"]');
  await A.mods();
  await A.page.click('tr[data-ti="0"]');
  await A.page.waitForFunction(() => { const el = document.querySelector('#maudio'); return window.__au.M.transcoded && !el.paused && el.currentTime > 0.3; }, null, { timeout: 30000 });
  await A.page.evaluate(() => window.__au.seekTo(15));
  await A.page.waitForFunction(() => window.__au.M.offset === 15 && !document.querySelector('#maudio').paused, null, { timeout: 15000 });
  await A.page.waitForFunction(() => window.__au.M.idx === 1, null, { timeout: 30000 });
  await sleep(700);
  const st = await A.page.evaluate(() => ({ engine: window.__ae.debugState().on, offset: window.__au.M.offset, tc: window.__au.M.transcoded,
    pos: window.__au.M.audio.currentTime + (window.__au.M.offset || 0), curt: document.querySelector('#mcurt').textContent }));
  assert.equal(st.engine, true, 'förutsättning: motorn tog över vid övergången ' + JSON.stringify(st));
  assert.equal(st.offset, 0, 'förra låtens startposition följer inte med: ' + JSON.stringify(st));
  assert.equal(st.tc, false, 'nästa låt spelas inte omkodad');
  assert.ok(st.pos < 3, 'tiden räknas från nästa låts början: ' + JSON.stringify(st));
  // Föregående i början av låten går till förra låten (inte till början av den här)
  await A.page.click('#mprev');
  await A.page.waitForFunction(() => window.__au.M.idx === 0, null, { timeout: 5000 }).catch(() => {});
  assert.equal(await A.page.evaluate(() => window.__au.M.idx), 0, 'Föregående gick till förra låten');
  await A.page.click('#mx');
  await sleep(300);
  await ctx.close();
});
