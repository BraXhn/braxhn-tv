// Offline i webbappen: serverns delar (q=src med Range, undertexter, album- och ljudboksplaner med kortlivade token,
// tittarposition med "at") mot en riktig server, och webbklienten i Chromium (Playwright): Spara offline från titelsidan,
// albumet och ljudboken, Nedladdat, återupptagen nedladdning, start utan kontakt med servern (service workern) och
// uppspelning offline, och att positionen som sparats offline når servern när den svarar igen.
// Kräver ffmpeg; webbdelen hoppas över utan Playwright (PLAYWRIGHT=/sökväg/till/playwright/index.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-offline-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 29000 + Math.floor(Math.random() * 900);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const SHOTS = process.env.SHOTS || '';
let srv, browser, tok = '', cookie = '';
const S = {};

async function req(p, { method = 'GET', body, auth = tok, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (auth) h.authorization = 'Bearer ' + auth;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  if (raw) return r;
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('Väntade förgäves på: ' + what); await sleep(100); }
}
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
// Chromium (Playwright) saknar H.264/AAC – WebM (VP8/Opus) spelas direkt, och då kan originalet sparas
const clip = (file, secs, freq = 440) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ff('-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`,
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', file);
};

before(async () => {
  if (!hasFfmpeg) return;
  clip(path.join(MEDIA, 'Filmer', 'Filmen (2022)', 'Filmen (2022).webm'), 30);
  const se = path.join(MEDIA, 'Serier', 'Serien', 'Season 1');
  clip(path.join(se, 'Serien S01E01.webm'), 6, 300);
  clip(path.join(se, 'Serien S01E02.webm'), 6, 500);
  fs.writeFileSync(path.join(se, 'Serien S01E01.sv.srt'), '1\n00:00:01,000 --> 00:00:04,000\nHej offline\n');
  const alb = path.join(MEDIA, 'Musik', 'Artisten', 'Albumet'); fs.mkdirSync(alb, { recursive: true });
  for (const n of [1, 2]) ff('-f', 'lavfi', '-i', `sine=frequency=${300 * n}:duration=20`, '-metadata', `title=Låt ${n}`, '-metadata', 'artist=Artisten', '-metadata', 'album=Albumet',
    '-metadata', `track=${n}`, path.join(alb, `0${n} Låt ${n}.mp3`));
  const bok = path.join(MEDIA, 'Ljudböcker', 'Författaren', 'Boken'); fs.mkdirSync(bok, { recursive: true });
  for (const n of [1, 2]) ff('-f', 'lavfi', '-i', `sine=frequency=${250 * n}:duration=30`, '-metadata', `title=Del ${n}`, '-metadata', 'album=Boken', '-metadata', 'artist=Författaren', path.join(bok, `0${n}.mp3`));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '', WATCH_FILES: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(async () => { await browser?.close(); srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
const w = (name, fn) => test(name, { skip: !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false }, fn);

t('förberedelse: konto, bibliotek och titlar', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, auth: '' })).status, 200);
  tok = (await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, auth: '' })).data.token;
  const lr = await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW }, auth: '', raw: true });
  cookie = /kt=([0-9a-f]+)/.exec(lr.headers.get('set-cookie'))[1];
  for (const [name, type, p] of [['Filmer', 'movie', 'Filmer'], ['Serier', 'show', 'Serier'], ['Musik', 'music', 'Musik'], ['Ljudböcker', 'audiobook', 'Ljudböcker']])
    assert.equal((await req('/api/libraries', { method: 'POST', body: { name, type, path: path.join(MEDIA, p) } })).status, 200);
  for (let i = 0; i < 240; i++) { await sleep(500); const r = (await req('/api/scan')).data; if (!r.running && !r.analysis?.running && r.last) break; }
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const id = (sql, ...a) => db.prepare(sql).get(...a)?.id;
  S.movie = id("SELECT id FROM items WHERE kind='movie'");
  S.show = id("SELECT id FROM items WHERE kind='show'");
  S.e1 = id("SELECT id FROM items WHERE kind='episode' AND episode=1"); S.e2 = id("SELECT id FROM items WHERE kind='episode' AND episode=2");
  S.album = id('SELECT id FROM albums'); S.book = id('SELECT id FROM books');
  S.tracks = db.prepare('SELECT id FROM tracks ORDER BY track_no').all().map(r => r.id);
  S.moviePath = db.prepare('SELECT path FROM items WHERE id=?').get(S.movie).path;
  db.close();
  assert.ok(S.movie && S.e1 && S.e2 && S.album && S.book && S.tracks.length === 2, JSON.stringify(S));
});

t('q=src: källfilen med Range, textundertexter och token som bara gäller titeln', async () => {
  const st = (await req(`/api/items/${S.movie}/offline?q=src&subs=1`)).data;
  assert.equal(st.status, 'ready'); assert.equal(st.original, true);
  const size = fs.statSync(S.moviePath).size;
  assert.equal(st.size, size);
  assert.match(st.url, /^\/api\/stream\/\d+\/offline-file\?q=src&t=[0-9a-f]+$/);
  // Range utan inloggning (bara token i adressen): rätt bytes och total storlek
  const r = await fetch(B + st.url, { headers: { Range: 'bytes=100-' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 100-${size - 1}/${size}`);
  assert.equal(r.headers.get('content-type'), 'video/webm');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), fs.readFileSync(S.moviePath).subarray(100));
  // POST med src startar ingen omkodning
  assert.equal((await req(`/api/items/${S.movie}/offline`, { method: 'POST', body: { q: 'src' } })).data.status, 'ready');
  // Tokenen gäller inte en annan titel
  const other = st.url.replace(`/stream/${S.movie}/`, `/stream/${S.e1}/`);
  assert.ok([401, 403].includes((await fetch(B + other)).status));
  // Avsnittet: den externa undertexten följer med som WebVTT
  const ep = (await req(`/api/items/${S.e1}/offline?q=src&subs=1`)).data;
  assert.equal(ep.subs.length, 1);
  const vtt = await (await fetch(B + ep.subs[0].url)).text();
  assert.match(vtt, /^WEBVTT/); assert.match(vtt, /Hej offline/);
  // Utan subs=1 (apparna): inga nya fält
  assert.equal('subs' in (await req(`/api/items/${S.e1}/offline?q=src`)).data, false);
});

t('omkodad MP4 för offline (q=480) blir klar och serveras med Range', async () => {
  let st = (await req(`/api/items/${S.e2}/offline`, { method: 'POST', body: { q: '480' } })).data;
  await until(async () => { st = (await req(`/api/items/${S.e2}/offline?q=480`)).data; return st.status === 'ready'; }, 'omkodningen', 90000);
  const r = await fetch(B + st.url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 206); assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal((await r.arrayBuffer()).byteLength, 100);
});

t('album och ljudbok: planer med kortlivade länkar per spår/bok', async () => {
  const a = (await req(`/api/music/albums/${S.album}/offline?a=mp3`)).data;
  assert.equal(a.tracks.length, 2); assert.equal(a.title, 'Albumet');
  const r = await fetch(B + a.tracks[0].url, { headers: { Range: 'bytes=10-' } });
  assert.equal(r.status, 206); await r.body.cancel();
  // Spårets token gäller bara det spåret
  const swapped = a.tracks[1].url.replace(/t=[0-9a-f]+/, /t=[0-9a-f]+/.exec(a.tracks[0].url)[0]);
  assert.ok([401, 403].includes((await fetch(B + swapped)).status));
  // Konstiga tecken i a= filtreras bort
  assert.match((await req(`/api/music/albums/${S.album}/offline?a=mp3%26x%3D1`)).data.tracks[0].url, /\?a=mp3x1&t=/);
  const b = (await req(`/api/audiobooks/book/${S.book}/offline?a=mp3`)).data;
  assert.equal(b.files.length, 2); assert.ok(b.chapters.length >= 1);
  const rb = await fetch(B + b.files[1].url);
  assert.equal(rb.status, 200); await rb.body.cancel();
});

t('tittarposition med at: ett senare framsteg från en annan enhet skrivs inte över', async () => {
  const now = Math.floor(Date.now() / 1000);
  const pos = async () => (await req(`/api/items/${S.e2}`)).data.position;
  assert.equal((await req(`/api/items/${S.e2}/progress`, { method: 'POST', body: { position: 2, at: now - 7200 } })).status, 200);
  assert.equal(await pos(), 2);
  // Nyare offline-position vinner över den äldre
  await req(`/api/items/${S.e2}/progress`, { method: 'POST', body: { position: 3, at: now - 3600 } });
  assert.equal(await pos(), 3);
  // Äldre än det som finns: stale, ingen ändring
  const r = (await req(`/api/items/${S.e2}/progress`, { method: 'POST', body: { position: 1, at: now - 5000 } })).data;
  assert.equal(r.stale, true); assert.equal(await pos(), 3);
  // at i framtiden räknas som nu; vanliga anrop utan at fungerar som förut
  await req(`/api/items/${S.e2}/progress`, { method: 'POST', body: { position: 4 } });
  assert.equal(await pos(), 4);
  // Ljudböcker på samma sätt
  await req(`/api/audiobooks/book/${S.book}/progress`, { method: 'POST', body: { position: 20, at: now - 100 } });
  const rb = (await req(`/api/audiobooks/book/${S.book}/progress`, { method: 'POST', body: { position: 5, at: now - 200 } })).data;
  assert.equal(rb.stale, true);
  assert.equal((await req(`/api/audiobooks/book/${S.book}`)).data.position, 20);
  await req(`/api/items/${S.e2}/progress`, { method: 'POST', body: { position: 0 } });
  await req(`/api/audiobooks/book/${S.book}/progress`, { method: 'POST', body: { position: 0 } });
});

t('barnprofil: titlar över åldersgränsen kan inte sparas offline', async () => {
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare("UPDATE items SET age=15 WHERE id=?").run(S.movie);
  db.close();
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  const kid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  // Profilbytet ersätter appens token – byt med en egen inloggning så att testernas token gäller kvar
  const own = (await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, auth: '' })).data.token;
  const kt = (await req('/api/profiles/switch', { method: 'POST', body: { id: kid }, auth: own })).data.token;
  assert.ok([403, 404].includes((await req(`/api/items/${S.movie}/offline?q=src`, { auth: kt })).status));
  assert.ok([403, 404].includes((await req(`/api/stream/${S.movie}/offline-file?q=src`, { auth: kt })).status));
  const db2 = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db2.prepare('UPDATE items SET age=NULL WHERE id=?').run(S.movie);
  db2.close();
});

// ---------- webbklienten ----------
async function newContext(width = 1280) {
  if (!browser) browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 740 : 800 } });
  await ctx.addCookies([{ name: 'kt', value: cookie, url: B }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.status() >= 400 && !/\/api\/(image|items\/\d+\/trickplay|music\/cover|audiobooks\/cover)/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  return { ctx, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); };
const dlList = (page) => page.evaluate(() => { const k = Object.keys(localStorage).find(x => /^braxhn-tv\.dl\.\d+$/.test(x)); return k ? JSON.parse(localStorage.getItem(k)) : []; });
let W = null;

w('webben: Spara offline från titelsidan, albumet och ljudboken – Nedladdat visar dem', async () => {
  W = await newContext(1280);
  const { page, errors } = W;
  await page.goto(B + '/');
  await page.waitForSelector('#libnav a');
  // Service workern måste ha installerat skalet innan vi går offline
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.goto(B + `/#/item/${S.movie}`);
  await page.click('#dloff');
  await page.waitForSelector('dialog .dlq');
  // Webbläsaren spelar WebM direkt: originalet erbjuds
  assert.ok(await page.$('dialog input[value=src]'), 'Original erbjuds');
  await page.check('dialog input[value=src]');
  await shot(page, 'offline-kvalitet-1280');
  await page.click('dialog .dlg-actions .primary');
  await until(async () => (await dlList(page)).find(e => e.key === 'v' + S.movie)?.state === 'done', 'filmen sparad');
  const e = (await dlList(page)).find(x => x.key === 'v' + S.movie);
  assert.equal(e.size, fs.statSync(S.moviePath).size); assert.equal(e.parts[0].mime, 'video/webm');
  // Avsnittet med undertext via kortmenyn (seriens sida → säsongen)
  await page.goto(B + `/#/item/${S.show}`);
  await page.click('#seasonOff');
  await page.waitForSelector('dialog .dlq');
  await page.check('dialog input[value="src?"]');
  await page.click('dialog .dlg-actions .primary');
  await until(async () => (await dlList(page)).filter(e => e.kind === 'episode' && e.state === 'done').length === 2, 'avsnitten sparade');
  assert.equal((await dlList(page)).find(x => x.key === 'v' + S.e1).subs.length, 1);
  // Albumet och ljudboken
  await page.goto(B + `/#/album/${S.album}`); await page.click('#aoff');
  await page.goto(B + `/#/book/${S.book}`); await page.click('#boff');
  await until(async () => { const l = await dlList(page); return ['a' + S.album, 'b' + S.book].every(k => l.find(e => e.key === k)?.state === 'done'); }, 'album och bok sparade');
  await page.goto(B + '/#/downloads');
  await page.waitForSelector(`[data-dl="v${S.movie}"] [data-a=play]`);
  assert.equal(await page.locator('[data-dl]').count(), 5);
  assert.match(await page.textContent('#dlspace'), /Använder/);
  await shot(page, 'nedladdat-1280');
  await page.setViewportSize({ width: 375, height: 740 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, 'ingen sidledes rullning på telefon');
  await shot(page, 'nedladdat-375');
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.deepEqual(errors, []);
});

w('webben: avbruten nedladdning fortsätter med Range där den slutade', async () => {
  const { page } = W;
  // Låtsas att nedladdningen avbröts: albumets andra spår halvvägs (första biten borttagen ur listan, inte ur cachen)
  const res = await page.evaluate(async (key) => {
    const k = Object.keys(localStorage).find(x => /^braxhn-tv\.dl\.\d+$/.test(x));
    const l = JSON.parse(localStorage.getItem(k)), e = l.find(x => x.key === key);
    const uid = k.split('.').pop();
    const c = await caches.open('braxhn-dl-v1');
    const full = await (await c.match(`/__dl/${uid}/${key}/1/0`)).arrayBuffer();
    // Byt den sparade biten mot de första 1000 byten och markera delen som ofärdig
    await c.put(`/__dl/${uid}/${key}/1/0`, new Response(full.slice(0, 1000)));
    Object.assign(e.parts[1], { got: 1000, chunks: 1, done: false }); e.state = 'queued';
    localStorage.setItem(k, JSON.stringify(l)); localStorage.setItem('braxhn-tv.dlwork', 'true');
    return { size: full.byteLength };
  }, 'a' + S.album);
  const ranges = [];
  page.on('request', r => { if (/\/api\/music\/tracks\/\d+\/stream/.test(r.url())) ranges.push(r.headers().range || ''); });
  await page.reload(); await page.waitForSelector('#libnav a');
  await until(async () => (await dlList(page)).find(e => e.key === 'a' + S.album)?.state === 'done', 'albumet klart igen');
  assert.ok(ranges.includes('bytes=1000-'), 'fortsatte med Range: ' + JSON.stringify(ranges));
  const e = (await dlList(page)).find(x => x.key === 'a' + S.album);
  assert.equal(e.parts[1].size, res.size); assert.equal(e.parts[1].chunks, 2);
  // Samma modul som appen (import map pekar /m/js/offline.js på adressen med hash)
  const len = await page.evaluate(async (key) => { const m = await import('/m/js/offline.js'); return (await m.partBlob(m.find(key), 1)).size; }, 'a' + S.album);
  assert.equal(len, res.size, 'bitarna sätts ihop till hela filen');
});

w('webben utan kontakt med servern: appen startar i Nedladdat och spelar det sparade', async () => {
  const { ctx, page, errors } = W;
  errors.length = 0;
  await ctx.setOffline(true);
  await page.goto(B + '/');
  await page.waitForSelector('.dlbanner', { timeout: 20000 });
  assert.equal(new URL(page.url()).hash, '#/downloads');
  await page.waitForSelector(`[data-dl="v${S.movie}"] [data-a=play]`);
  await shot(page, 'offline-start-1280');
  // Filmen: spelas från blob:, positionen sparas lokalt (pending)
  await page.click(`[data-dl="v${S.movie}"] [data-a=play]`);
  await page.waitForSelector('.dlplayer video');
  await page.evaluate(() => { const v = document.querySelector('#dlmedia'); v.muted = true; return v.play().catch(() => {}); });
  await until(() => page.evaluate(() => document.querySelector('#dlmedia')?.currentTime > 1), 'filmen spelas offline', 20000);
  assert.match(await page.evaluate(() => document.querySelector('#dlmedia').src), /^blob:/);
  await page.evaluate(() => { const v = document.querySelector('#dlmedia'); v.currentTime = 12; });
  await until(() => page.evaluate(() => document.querySelector('#dlmedia').currentTime >= 12), 'spolning');
  await shot(page, 'offline-spelare-1280');
  await page.click('#dlclose');
  let e = (await dlList(page)).find(x => x.key === 'v' + S.movie);
  assert.ok(e.pending && e.pending.pos >= 12, 'position sparad offline: ' + JSON.stringify(e.pending));
  // Avsnittet: undertexten finns som spår
  await page.click(`[data-dl="v${S.e1}"] [data-a=play]`);
  await page.waitForSelector('.dlplayer video track', { state: 'attached' });
  assert.equal(await page.evaluate(() => document.querySelector('#dlmedia').textTracks.length), 1);
  await page.keyboard.press('Escape');
  // Albumet
  await page.click(`[data-dl="a${S.album}"] [data-a=play]`);
  await page.waitForSelector('.dlplayer audio');
  await page.evaluate(() => { const a = document.querySelector('#dlmedia'); a.muted = true; return a.play().catch(() => {}); });
  await until(() => page.evaluate(() => document.querySelector('#dlmedia')?.currentTime > 0.5), 'albumet spelas offline', 20000);
  await page.click('#dltracks [data-t="1"]');
  await until(() => page.evaluate(() => document.querySelector('#dltracks [data-t="1"]').getAttribute('aria-current') === 'true'), 'spår 2');
  await page.keyboard.press('Escape');
  // Ljudboken: andra delen via kapitel, positionen räknas över filerna
  await page.click(`[data-dl="b${S.book}"] [data-a=play]`);
  await page.waitForSelector('.dlplayer #dltracks [data-ch]');
  const chs = await page.locator('#dltracks [data-ch]').count();
  await page.locator('#dltracks [data-ch]').nth(chs - 1).click();
  await page.evaluate(() => { const a = document.querySelector('#dlmedia'); a.muted = true; return a.play().catch(() => {}); });
  await until(() => page.evaluate(() => document.querySelector('#dlmedia')?.currentTime > 0.5), 'boken spelas offline', 20000);
  await page.click('#dlclose');
  e = (await dlList(page)).find(x => x.key === 'b' + S.book);
  assert.ok(e.pending && e.pending.pos > 25, 'bokens position över filgränsen: ' + JSON.stringify(e.pending));
  await page.setViewportSize({ width: 375, height: 740 }); await shot(page, 'offline-start-375'); await page.setViewportSize({ width: 1280, height: 800 });
  assert.deepEqual(errors.filter(x => !/ERR_INTERNET_DISCONNECTED|net::/.test(x)), []);
});

w('webben: positionerna från offline-läget når servern när den svarar igen', async () => {
  const { ctx, page } = W;
  await ctx.setOffline(false);
  await page.goto(B + '/');
  await page.waitForSelector('#libnav a');
  await until(async () => (await req(`/api/items/${S.movie}`)).data.position >= 12, 'filmens position på servern', 20000);
  await until(async () => (await req(`/api/audiobooks/book/${S.book}`)).data.position > 25, 'bokens position på servern', 20000);
  await until(async () => !(await dlList(page)).some(e => e.pending), 'kön tom');
  // Ta bort: filerna försvinner ur cachen
  await page.goto(B + '/#/downloads');
  await page.click(`[data-dl="v${S.movie}"] [data-a=del]`);
  await page.click('dialog .dlg-actions .danger');
  await until(async () => !(await dlList(page)).some(e => e.key === 'v' + S.movie), 'borttagen ur listan');
  const left = await page.evaluate(async (id) => (await (await caches.open('braxhn-dl-v1')).keys()).filter(r => r.url.includes(`/v${id}/`)).length, S.movie);
  assert.equal(left, 0);
  // Utloggning: Nedladdat visas inte längre utan server (nästa person på datorn)
  await page.evaluate(() => document.querySelector('#logout').click());
  await page.waitForFunction(() => location.hash === '#/login');
  assert.equal(await page.evaluate(() => localStorage.getItem('braxhn-tv.dl.last')), 'null');
  await ctx.close();
});
