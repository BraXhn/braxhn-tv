// Låttexter och musikvideor i webben (Chromium via Playwright): synkad text i panelen som markerar och rullar med
// låten, klick på en rad spolar dit, karaokeläget med ordtider, att texten byter med låten genom den glapplösa
// motorn, musikvideohyllan på album- och artistsidan, "Spela videon" i låtens ⋮-meny och videospelaren.
// Skärmdumpar på 375 och 1280 px om SHOTS är satt. Hoppas över om ffmpeg eller Playwright saknas.
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
const skip = !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-weblyr-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 30000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const SHOTS = process.env.SHOTS || '';
let srv, browser, tok = '', cookie = '';
const S = {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
async function req(p, { method = 'GET', body } = {}) {
  const h = { authorization: 'Bearer ' + tok };
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
}

before(async () => {
  if (skip) return;
  const AL = path.join(MEDIA, 'Musik', 'Sångaren', 'Skivan');
  fs.mkdirSync(AL, { recursive: true });
  const song = (n, title, secs) => ff('-f', 'lavfi', '-i', `sine=frequency=${300 + n * 100}:duration=${secs}`, '-ac', '2', '-c:a', 'flac', '-metadata', `title=${title}`,
    '-metadata', 'artist=Sångaren', '-metadata', 'album=Skivan', '-metadata', `track=${n}`, path.join(AL, `0${n} - ${title}.flac`));
  song(1, 'Ettan', 5); song(2, 'Tvåan', 12);
  fs.writeFileSync(path.join(AL, '01 - Ettan.lrc'), '[00:00.20]Ettan rad ett\n[00:02.00]Ettan rad två\n[00:03.50]Ettan rad tre\n');
  // Utökad LRC med ordtider (karaokeläget), många rader så att panelen måste rulla
  fs.writeFileSync(path.join(AL, '02 - Tvåan.lrc'), Array.from({ length: 24 }, (_, i) => {
    const s = (i * 0.5).toFixed(2).padStart(5, '0');
    return `[00:${s}]<00:${s}>Tvåan <00:${(i * 0.5 + 0.25).toFixed(2).padStart(5, '0')}>rad ${i + 1}`;
  }).join('\n'));
  // Musikvideo till Ettan (VP9/Opus i WebM – Chromium i Playwright saknar H.264)
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=4', '-c:v', 'libvpx-vp9', '-b:v', '200k',
    '-deadline', 'realtime', '-c:a', 'libopus', '-shortest', path.join(AL, '01 - Ettan.webm'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '',
      WATCH_FILES: '0', MUSIC_SONIC: '0', MUSIC_LOUDNESS: '0', MUSIC_LYRICS_ONLINE: '0', MUSIC_META: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip }, fn);

async function newPage(width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 740 : 800 }, ...(width < 500 ? { hasTouch: true, isMobile: true } : {}) });
  await ctx.addCookies([{ name: 'kt', value: cookie, url: B }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  return { page, errors, close: () => ctx.close() };
}
const shot = (page, name) => SHOTS ? page.screenshot({ path: path.join(SHOTS, `lyr-${name}.png`) }) : null;
const pos = (page) => page.evaluate(() => +document.querySelector('#mbar')?.dataset.t || 0);
const onLine = (page, sel = '#lybody') => page.evaluate((s) => { const e = document.querySelector(`${s} p.on`); return e ? { i: +e.dataset.ly, text: e.textContent } : null; }, sel);

t('förberedelse: konto, musikbibliotek och glapplös analys', async () => {
  assert.equal((await fetch(B + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) })).status, 200);
  tok = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW, app: true }) })).json()).token;
  const lr = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) });
  cookie = /kt=([0-9a-f]+)/.exec(lr.headers.get('set-cookie'))[1];
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Musik', type: 'music', path: path.join(MEDIA, 'Musik') } })).status, 200);
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const r = (await req('/api/scan')).data;
    if (!r.running && r.last && db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n === 2 && db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE gl IS NULL').get().n === 0
      && db.prepare('SELECT COUNT(*) AS n FROM music_videos').get().n === 1) break;
  }
  S.album = db.prepare("SELECT id FROM albums WHERE title='Skivan'").get()?.id;
  S.artist = db.prepare("SELECT id FROM artists WHERE name='Sångaren'").get()?.id;
  db.close();
  assert.ok(S.album && S.artist);
  await req('/api/me/listening', { method: 'PUT', body: { normMode: 'off', gapless: true, crossfade: 0 } });
});

t('låttext: markerad rad följer låten, klick spolar, byter med låten genom glapplösa motorn', async () => {
  const { page, errors, close } = await newPage();
  await page.goto(B + '/#/album/' + S.album);
  await page.click('tr[data-ti="0"]');
  await page.waitForSelector('#mbar:not([hidden])');
  await page.click('#mlyr');
  await page.waitForSelector('#lybody p.sync');
  assert.equal(await page.locator('#lybody p').count(), 3);
  await page.waitForFunction(() => document.querySelector('#lybody p.on')?.dataset.ly === '1', null, { timeout: 8000 });
  assert.ok(await pos(page) >= 1.6, 'rad två markeras först vid sin tid');
  // Klick på tredje raden spolar dit
  await page.click('#lybody p[data-ly="2"]');
  await page.waitForFunction(() => document.querySelector('#lybody p.on')?.dataset.ly === '2', null, { timeout: 3000 });
  const p = await pos(page);
  assert.ok(p >= 3.2 && p < 4.8, `position efter klick: ${p}`);
  await shot(page, 'panel-1280');
  // Glapplöst till nästa låt: panelen visar Tvåans text och följer med
  const engine = await page.evaluate(async () => (await import('/m/js/audioengine.js')).on());
  await page.waitForFunction(() => document.querySelector('#lytitle')?.textContent === 'Tvåan', null, { timeout: 8000 });
  await page.waitForFunction(() => +document.querySelector('#lybody p.on')?.dataset.ly >= 3, null, { timeout: 6000 });
  const l = await onLine(page);
  const at = await pos(page);
  assert.ok(Math.abs(l.i * 0.5 - (at + 0.2)) < 0.9, `rad ${l.i} vid ${at} s`);
  // Panelen har rullat så att raden syns
  const vis = await page.evaluate(() => { const b = document.querySelector('#lybody'), e = b.querySelector('p.on'); const r = e.getBoundingClientRect(), q = b.getBoundingClientRect(); return r.top >= q.top && r.bottom <= q.bottom; });
  assert.ok(vis, 'markerade raden syns i panelen');
  assert.equal(engine, true, 'Tvåan spelas av den glapplösa motorn');
  assert.deepEqual(errors, []);
  await close();
});

t('karaokeläget: helskärmsdialog, ord fylls, klick spolar, Escape stänger', async () => {
  const { page, errors, close } = await newPage();
  await page.goto(B + '/#/album/' + S.album);
  await page.click('tr[data-ti="1"]');
  await page.click('#mlyr');
  await page.waitForSelector('#lybody p.sync');
  await page.click('#lykar');
  await page.waitForSelector('dialog.karaoke[open] .karbody p[data-ly]');
  assert.equal(await page.locator('dialog.karaoke [data-w]').count(), 48, 'två ord per rad');
  await page.waitForFunction(() => document.querySelector('.karbody p.on [data-w].sung, .karbody p.on [data-w].cur'), null, { timeout: 6000 });
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
  const box = await page.evaluate(() => { const d = document.querySelector('dialog.karaoke').getBoundingClientRect(); return [d.width, d.height, innerWidth, innerHeight]; });
  assert.ok(box[0] >= box[2] - 2 && box[1] >= box[3] - 2, 'dialogen fyller fönstret ' + box);
  await page.click('.karbody p[data-ly="20"]');
  await page.waitForFunction(() => +document.querySelector('.karbody p.on')?.dataset.ly >= 20, null, { timeout: 3000 });
  await page.waitForFunction(() => +document.querySelector('#mbar').dataset.t >= 9.7, null, { timeout: 2000 });
  await shot(page, 'karaoke-1280');
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog.karaoke', { state: 'detached' });
  assert.deepEqual(errors, []);
  await close();
});

for (const width of [375, 1280]) {
  t(`musikvideor (${width} px): hylla på album- och artistsidan, ⋮ Spela videon, videospelaren`, async () => {
    const { page, errors, close } = await newPage(width);
    await page.goto(B + '/#/artist/' + S.artist);
    await page.waitForSelector('.mvideos .mvcard');
    await page.goto(B + '/#/album/' + S.album);
    await page.waitForSelector('.mvideos .mvcard');
    await shot(page, `album-${width}`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(over <= 0, `vågrät rullning ${over}px`);
    // ⋮ på Tvåan saknar valet, på Ettan finns det
    await page.click('tr[data-ti="1"] [data-tmenu]');
    await page.waitForSelector('[role=menu]');
    assert.equal(await page.locator('[role=menuitem]:has-text("Spela videon")').count(), 0);
    await page.keyboard.press('Escape');
    await page.click('tr[data-ti="0"] [data-tmenu]');
    await page.click('[role=menuitem]:has-text("Spela videon")');
    await page.waitForSelector('#player:not([hidden]) #mvvid');
    await page.waitForFunction(() => { const v = document.querySelector('#mvvid'); return v && v.currentTime > 0.3 && !v.paused; }, null, { timeout: 10000 });
    assert.match(await page.textContent('#player .pbar .title'), /Ettan/);
    await shot(page, `video-${width}`);
    await page.click('#mvclose');
    await page.waitForSelector('#player', { state: 'hidden' });
    // Kortet startar också spelaren
    await page.click('.mvcard');
    await page.waitForSelector('#player:not([hidden]) #mvvid');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#player', { state: 'hidden' });
    assert.deepEqual(errors, []);
    await close();
  });
}
