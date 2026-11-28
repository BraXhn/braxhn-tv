// Ljudboken eller poddavsnittet finns kvar i minispelaren efter omladdning (server/musicqueue.js `spoken` ↔
// web/js/audio.js playSpoken/restoreQueue): kön minns vilken bok eller vilket avsnitt som spelades, positionen kommer
// från profilens framsteg. Efter omladdning visas boken pausad på rätt plats, utan att något hämtas eller räknas
// (skärmtid, lyssnad tid) förrän man trycker Spela. Per profil: en annan profil ser aldrig boken.
// Webbläsardelen hoppas över om ffmpeg eller Playwright saknas. SHOTS=<mapp> sparar skärmbilder (1280×800, 390×844).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './helpers/port.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const skip = !hasFfmpeg ? 'ffmpeg saknas' : false;
const skipWeb = skip || (!chromium ? 'Playwright saknas' : false);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-spoken-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const SHOTS = process.env.SHOTS || '';
let srv, browser, tok = '', cookie = '', perTok = '', perCookie = '', kidTok = '', adminId = 0, perId = 0, kidId = 0, bookId = 0, epId = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
async function req(p, { method = 'GET', body, token = tok } = {}) {
  const h = { authorization: 'Bearer ' + token };
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
}
const login = async (app) => fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW, app }) });
/** Ny profil med egen token (appar) och egen kaka (webbläsaren) */
async function profile(name, extra = {}) {
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name, ...extra } })).status, 200);
  const id = (await req('/api/profiles')).data.profiles.find(p => p.name === name).id;
  const token = (await req('/api/profiles/switch', { method: 'POST', body: { id }, token: (await (await login(true)).json()).token })).data.token;
  const wc = /kt=([0-9a-f]+)/.exec((await login(false)).headers.get('set-cookie'))[1];
  const sw = await fetch(B + '/api/profiles/switch', { method: 'POST', headers: { 'content-type': 'application/json', origin: B, cookie: 'kt=' + wc }, body: JSON.stringify({ id }) });
  return { id, token, cookie: /kt=([0-9a-f]+)/.exec(sw.headers.get('set-cookie'))[1] };
}

before(async () => {
  if (skip) return;
  // En bok i två filer (90 + 60 s), så att positionen ligger i den andra filen efter spolning
  const dir = path.join(MEDIA, 'Böcker', 'Testförfattaren', 'Testboken');
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, len] of [[1, 90], [2, 60]]) ff('-f', 'lavfi', '-i', `sine=f=${300 + n * 100}:r=44100:d=${len}`, '-ac', '1', '-b:a', '64k', '-metadata', `title=Del ${n}`,
    '-metadata', 'album=Testboken', '-metadata', 'artist=Testförfattaren', path.join(dir, `0${n}.mp3`));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '',
      WATCH_FILES: '0', MUSIC_SONIC: '0', MUSIC_LOUDNESS: '0', BOOK_METADATA: '0', MUSIC_METADATA: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  if (!skipWeb) browser = await chromium.launch(fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : {});
});
after(async () => { await browser?.close(); srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip }, fn);
const tw = (name, fn) => test(name, { skip: skipWeb }, fn);

t('förberedelse: konto, ett ljudboksbibliotek, ett poddavsnitt, en vuxen profil till och en barnprofil', async () => {
  assert.equal((await fetch(B + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) })).status, 200);
  tok = (await (await login(true)).json()).token;
  cookie = /kt=([0-9a-f]+)/.exec((await login(false)).headers.get('set-cookie'))[1];
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Böcker', type: 'audiobook', path: path.join(MEDIA, 'Böcker') } })).status, 200);
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const r = (await req('/api/scan')).data;
    if (!r.running && r.last && db.prepare('SELECT COUNT(*) AS n FROM book_files').get().n === 2) break;
  }
  bookId = db.prepare("SELECT id FROM books WHERE title='Testboken'").get()?.id;
  assert.ok(bookId, 'boken är inläst');
  adminId = db.prepare("SELECT id FROM users WHERE name='admin'").get().id;
  // Ett avsnitt utan nät: raden räcker för kön (strömmen prövas inte här)
  const pid = db.prepare("INSERT INTO podcasts(url, title, added) VALUES('http://127.0.0.1:9/feed.xml', 'Testpodden', 0)").run().lastInsertRowid;
  epId = Number(db.prepare("INSERT INTO podcast_episodes(podcast_id, guid, title, duration, url, added) VALUES(?, 'g1', 'Avsnitt 1', 1200, 'http://127.0.0.1:9/a.mp3', 0)").run(pid).lastInsertRowid);
  db.close();
  ({ id: perId, token: perTok, cookie: perCookie } = await profile('Per'));
  ({ id: kidId, token: kidTok } = await profile('Lisa', { maxAge: 7 }));
});

t('API: boken eller avsnittet sparas i kön och kommer tillbaka med profilens position – inte för en annan profil', async () => {
  assert.equal((await req(`/api/audiobooks/book/${bookId}/progress`, { method: 'POST', body: { position: 100.5, speed: 1 } })).status, 200);
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { uid: adminId, ids: [], spoken: { kind: 'book', id: bookId } } })).status, 200);
  let q = (await req('/api/me/queue')).data;
  assert.deepEqual(q.spoken, { kind: 'book', id: bookId, position: 100.5 });
  assert.deepEqual(q.tracks, [], 'ingen musik i kön');
  // Per har ingen kö, och Pers framsteg i samma bok är hans egna
  assert.equal((await req('/api/me/queue', { token: perTok })).data.spoken ?? null, null, 'en annan profil ser inte boken');
  assert.equal((await req(`/api/audiobooks/book/${bookId}/progress`, { method: 'POST', body: { position: 40 }, token: perTok })).status, 200);
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { ids: [], spoken: { kind: 'book', id: bookId } }, token: perTok })).status, 200);
  assert.equal((await req('/api/me/queue', { token: perTok })).data.spoken.position, 40);
  assert.equal((await req('/api/me/queue')).data.spoken.position, 100.5, 'administratörens position är orörd');
  // En flik från före ett profilbyte får inte skriva i Pers kö
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { uid: adminId, ids: [], spoken: { kind: 'book', id: bookId } }, token: perTok })).status, 409);
  // Avsnitt: positionen ur poddens framsteg; lyssnat klart = från början
  await req(`/api/podcasts/episodes/${epId}/progress`, { method: 'POST', body: { position: 300 }, token: perTok });
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { ids: [], spoken: { kind: 'podcast', id: epId } }, token: perTok })).status, 200);
  assert.deepEqual((await req('/api/me/queue', { token: perTok })).data.spoken, { kind: 'podcast', id: epId, position: 300 });
  await req(`/api/podcasts/episodes/${epId}/progress`, { method: 'POST', body: { position: 1200, played: true }, token: perTok });
  assert.equal((await req('/api/me/queue', { token: perTok })).data.spoken.position, 0);
  // Barnprofiler har inga poddar: avsnittet kommer inte tillbaka
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { ids: [], spoken: { kind: 'podcast', id: epId } }, token: kidTok })).status, 200);
  assert.deepEqual((await req('/api/me/queue', { token: kidTok })).data, { tracks: [], idx: -1, pos: 0, repeat: false, radio: null, spoken: null, updated: 0 });
  // Felaktiga
  for (const spoken of [{ kind: 'film', id: bookId }, { kind: 'book', id: -1 }, { kind: 'book' }, 'x']) {
    assert.equal((await req('/api/me/queue', { method: 'PUT', body: { ids: [], spoken } })).status, 400, JSON.stringify(spoken));
  }
  // En borttagen bok: ingen kö
  assert.equal((await req('/api/me/queue', { method: 'PUT', body: { ids: [], spoken: { kind: 'book', id: 987654 } }, token: kidTok })).status, 200);
  assert.equal((await req('/api/me/queue', { token: kidTok })).data.spoken, null);
  for (const token of [tok, perTok, kidTok]) await req('/api/me/queue', { method: 'DELETE', token });
});

// ---------- webbläsaren ----------
async function newPage(kt = cookie, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport, bypassCSP: true });
  await ctx.addCookies([{ name: 'kt', value: kt, url: B }]);
  const page = await ctx.newPage();
  const errors = [], puts = [], progress = [], streams = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => {
    const u = r.url();
    if (/\/api\/me\/queue$/.test(u) && r.method() === 'PUT') puts.push(JSON.parse(r.postData() || '{}'));
    if (/\/progress$/.test(u) && r.method() === 'POST') progress.push(JSON.parse(r.postData() || '{}'));
    if (/\/stream(\?|$)/.test(u)) streams.push(r.method() + ' ' + u);
  });
  const mods = () => page.evaluate(async () => { window.__au = await import('/m/js/audio.js'); });
  const info = () => page.evaluate(() => {
    const M = window.__au.M, el = document.querySelector('#maudio');
    return { spoken: M.spoken ? { kind: M.spoken.kind, id: M.spoken.id } : null, paused: M.audio?.paused ?? null, pos: window.__au.spokenPos(),
      title: document.querySelector('#mtitle')?.textContent, hidden: document.querySelector('#mbar')?.hidden ?? true, curt: document.querySelector('#mcurt')?.textContent,
      speed: document.querySelector('#mspeed') ? !document.querySelector('#mspeed').hidden : false, play: document.querySelector('#mplay')?.getAttribute('aria-label'),
      elSrc: !!el?.getAttribute('src'), elPaused: el ? el.paused : null };
  });
  const restored = () => page.waitForFunction(() => document.querySelector('#mbar') && !document.querySelector('#mbar').hidden, null, { timeout: 15000 });
  return { ctx, page, errors, puts, progress, streams, mods, info, restored };
}
const spokenPlaying = (page, min = 0.5) => page.waitForFunction((min) => { const el = document.querySelector('#maudio'); return !!el && !el.paused && el.currentTime > min; }, min, { timeout: 30000 });

tw('omladdning: boken står kvar pausad på rätt plats, inget räknas förrän Spela, och Spela fortsätter där', async () => {
  const A = await newPage();
  await A.page.goto(B + '/#/book/' + bookId);
  await A.page.waitForSelector('#bp');
  await A.mods();
  await A.page.click('#bp');
  await spokenPlaying(A.page);
  await A.page.evaluate(() => window.__au.spokenSeek(115)); // i den andra filen
  await A.page.waitForFunction(() => window.__au.spokenPos() > 115.5 && !document.querySelector('#maudio').paused, null, { timeout: 20000 });
  await A.page.click('#mplay'); // paus: positionen sparas
  await sleep(800);
  const before = await A.info();
  assert.ok(before.paused && before.pos > 115 && before.pos < 120, JSON.stringify(before));
  assert.ok(A.puts.some(p => p.spoken?.kind === 'book' && p.spoken.id === bookId && p.uid === adminId && Array.isArray(p.ids) && !p.ids.length), 'kön minns boken: ' + JSON.stringify(A.puts));
  assert.ok(Math.abs(A.progress.at(-1).position - before.pos) < 0.5, 'positionen sparad vid paus: ' + JSON.stringify(A.progress.at(-1)));

  await A.page.reload();
  await A.restored();
  await A.mods();
  const p0 = A.progress.length, s0 = A.streams.length, q0 = A.puts.length;
  const after = await A.info();
  assert.deepEqual(after.spoken, { kind: 'book', id: bookId }, 'boken i minispelaren');
  assert.equal(after.title, 'Testboken');
  assert.equal(after.paused, true, 'pausad');
  assert.equal(after.play, 'Spela');
  assert.ok(Math.abs(after.pos - before.pos) < 0.6, `samma position: ${after.pos} mot ${before.pos}`);
  assert.equal(after.curt, '1:' + String(Math.floor(after.pos) - 60).padStart(2, '0'), 'tiden visas');
  assert.equal(after.speed, true, 'hastighetsvalet för tal syns');
  assert.equal(after.elSrc, false, 'ingen fil laddas innan man trycker Spela');
  // Hopp bakåt medan den är pausad flyttar bara platsen
  await A.page.click('#mprev');
  const back = await A.info();
  assert.ok(back.paused && Math.abs(back.pos - (after.pos - 15)) < 0.6, 'hopp bakåt i pausat läge: ' + JSON.stringify(back));
  await A.page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); // som när fliken göms/stängs
  await sleep(1500);
  assert.equal(A.progress.length, p0, 'inget framsteg (skärmtid, lyssnad tid) innan Spela: ' + JSON.stringify(A.progress.slice(p0)));
  assert.equal(A.streams.length, s0, 'inget hämtas innan Spela: ' + A.streams.slice(s0));
  assert.equal(A.puts.length, q0, 'en flik som bara visar boken skriver ingen kö');
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await A.page.screenshot({ path: path.join(SHOTS, 'bok-efter-omladdning-1280x800.png') });
    const Ph = await newPage(cookie, { width: 390, height: 844 });
    await Ph.page.goto(B + '/');
    await Ph.restored();
    await sleep(500);
    await Ph.page.screenshot({ path: path.join(SHOTS, 'bok-efter-omladdning-390x844.png') });
    const ph = await Ph.page.evaluate(() => { const r = document.querySelector('#mbar').getBoundingClientRect(); return { right: r.right, W: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }; });
    assert.ok(ph.sw <= ph.W, 'ingen sidled rullning på telefonen: ' + JSON.stringify(ph));
    assert.deepEqual(Ph.errors, []);
    await Ph.ctx.close();
  }

  await A.page.click('#mplay');
  await spokenPlaying(A.page, 0.3);
  await sleep(600);
  const go = await A.info();
  assert.ok(go.pos >= back.pos - 0.3 && go.pos < back.pos + 4, `fortsatte där: ${go.pos} (pausad på ${back.pos})`);
  assert.equal(go.paused, false);
  await A.page.click('#mplay');
  await sleep(600);
  assert.ok(A.progress.length > p0, 'nu sparas framsteget igen');
  assert.ok(Math.abs(A.progress.at(-1).position - (await A.info()).pos) < 0.5);
  assert.deepEqual(A.errors, []);
  await A.ctx.close();
});

tw('profiler: en annan profil ser inte boken, och ✕ tar bort den', async () => {
  // Administratörens kö har boken från förra testet
  assert.equal((await req('/api/me/queue')).data.spoken?.id, bookId);
  const Pp = await newPage(perCookie);
  await Pp.page.goto(B + '/');
  await Pp.page.waitForSelector('#userbtn');
  await sleep(2500);
  assert.equal(await Pp.page.evaluate(() => !document.querySelector('#mbar') || document.querySelector('#mbar').hidden), true, 'ingen minispelare för Per');
  assert.deepEqual(Pp.errors, []);
  await Pp.ctx.close();
  const A = await newPage();
  await A.page.goto(B + '/');
  await A.restored();
  await A.page.click('#mx');
  await sleep(500);
  assert.equal((await req('/api/me/queue')).data.spoken, null, '✕ tar bort boken ur kön');
  await A.page.reload();
  await A.page.waitForSelector('#userbtn');
  await sleep(2500);
  assert.equal(await A.page.evaluate(() => !document.querySelector('#mbar') || document.querySelector('#mbar').hidden), true);
  assert.deepEqual(A.errors, []);
  await A.ctx.close();
});
