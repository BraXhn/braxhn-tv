// Webben i Chromium (Playwright): bio-läget med riktiga testfiler och Chromecast med en låtsad Cast-SDK.
// Cast-SDK:n (window.chrome.cast / window.cast.framework) definieras före sidans skript och skriptet från gstatic.com
// besvaras lokalt – stubben loggar laddningar, köade titlar, spårbyten och kontrollanrop, och testet driver
// "mottagaren" (tid, paus, nästa titel i kön) och kontrollerar att framstegs-anropen når servern.
// Hoppas över om ffmpeg eller Playwright saknas (Playwright är inget beroende – det används om det finns installerat,
// t.ex. PLAYWRIGHT=/sökväg/till/playwright/index.mjs). Riktig Chromecast-hårdvara provas inte.
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-webcast-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 28000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const SHOTS = process.env.SHOTS || ''; // mapp för skärmdumpar (valfritt)
let srv, browser, tok = '', cookie = '';
const S = {};

async function req(p, { method = 'GET', body } = {}) {
  const h = { authorization: 'Bearer ' + tok };
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
// Chromium (Playwright) saknar H.264/AAC – därför WebM (VP8/Opus), som spelas direkt
const clip = (file, secs, freq = 440) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ff('-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`,
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', file);
};

before(async () => {
  if (skip) return;
  const F = path.join(MEDIA, 'Filmer');
  clip(path.join(F, 'Huvudfilmen (2022)', 'Huvudfilmen (2022).webm'), 40);
  for (const [n, f] of [['Andra (2021)', 300], ['Tredje (2019)', 500]]) {
    clip(path.join(F, n, n + '.webm'), 3, f);
    clip(path.join(F, n, n + '-trailer.webm'), 2, f + 50);
  }
  clip(path.join(MEDIA, 'Förfilmer', 'popcorn.webm'), 1, 900);
  // Avsnitt 1: två ljudspår och en extern undertext (spårval i castpanelen)
  const se = path.join(MEDIA, 'Serier', 'Serien', 'Season 1');
  fs.mkdirSync(se, { recursive: true });
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=600:duration=6',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus', '-metadata:s:a:0', 'language=swe', '-metadata:s:a:1', 'language=eng',
    path.join(se, 'Serien S01E01.webm'));
  fs.writeFileSync(path.join(se, 'Serien S01E01.sv.srt'), '1\n00:00:01,000 --> 00:00:04,000\nHej\n');
  clip(path.join(se, 'Serien S01E02.webm'), 6, 700);
  clip(path.join(se, 'Serien S01E03.webm'), 6, 800);
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
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip }, fn);

// Låtsad Cast-SDK (körs före sidans skript)
function castStub() {
  const listeners = {};
  const log = { loads: [], inserts: [], edits: [], calls: [] };
  const E = { IS_CONNECTED_CHANGED: 'isConnectedChanged', IS_MEDIA_LOADED_CHANGED: 'isMediaLoadedChanged', DURATION_CHANGED: 'durationChanged', CURRENT_TIME_CHANGED: 'currentTimeChanged',
    IS_PAUSED_CHANGED: 'isPausedChanged', VOLUME_LEVEL_CHANGED: 'volumeLevelChanged', IS_MUTED_CHANGED: 'isMutedChanged', MEDIA_INFO_CHANGED: 'mediaInfoChanged', PLAYER_STATE_CHANGED: 'playerStateChanged' };
  const player = { isConnected: false, isMediaLoaded: false, mediaInfo: null, currentTime: 0, duration: 0, isPaused: false, volumeLevel: 1, isMuted: false };
  const fire = (type, field, value) => (listeners[type] || []).forEach(f => f({ type, field, value }));
  const set = (field, value) => { player[field] = value; fire(field + 'Changed', field, value); };
  const media = { activeTrackIds: [],
    queueInsertItems(r, ok) { log.inserts.push(r.items.map(i => ({ contentId: i.media.contentId, customData: i.media.customData, activeTrackIds: i.activeTrackIds || [] }))); ok(); },
    editTracksInfo(r, ok) { log.edits.push(r.activeTrackIds); media.activeTrackIds = r.activeTrackIds; ok(); } };
  let current = null;
  const session = { getCastDevice: () => ({ friendlyName: 'Vardagsrummet' }), getMediaSession: () => media,
    loadMedia(r) {
      log.loads.push({ contentId: r.media.contentId, contentType: r.media.contentType, customData: r.media.customData, currentTime: r.currentTime, activeTrackIds: r.activeTrackIds || [],
        tracks: (r.media.tracks || []).map(x => x.trackContentId) });
      media.activeTrackIds = r.activeTrackIds || [];
      player.currentTime = r.currentTime || 0;
      set('isConnected', true); set('mediaInfo', r.media); set('isMediaLoaded', true); set('duration', 100);
      return Promise.resolve();
    } };
  const ctx = { setOptions() {}, getCurrentSession: () => current, requestSession() { current = session; return Promise.resolve(); },
    endCurrentSession() { log.calls.push('end'); current = null; set('isConnected', false); } };
  const cls = (f) => class { constructor(...a) { f?.call(this, ...a); } };
  window.chrome = Object.assign(window.chrome || {}, { cast: { AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' }, Image: cls(function (u) { this.url = u; }),
    media: { DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845', MediaInfo: cls(function (id, type) { this.contentId = id; this.contentType = type; }),
      LoadRequest: cls(function (m) { this.media = m; }), StreamType: { BUFFERED: 'BUFFERED' }, HlsSegmentFormat: { TS: 'ts' }, HlsVideoSegmentFormat: { MPEG2_TS: 'mpeg2_ts' },
      GenericMediaMetadata: cls(), MusicTrackMediaMetadata: cls(), Track: cls(function (id, type) { this.trackId = id; this.type = type; }), TrackType: { TEXT: 'TEXT' },
      TextTrackType: { SUBTITLES: 'SUBTITLES' }, QueueItem: cls(function (m) { this.media = m; }), QueueInsertItemsRequest: cls(function (items) { this.items = items; }),
      EditTracksInfoRequest: cls(function (ids) { this.activeTrackIds = ids; }) } } });
  window.cast = { framework: { CastContext: { getInstance: () => ctx }, RemotePlayerEventType: E, RemotePlayer: function () { return player; },
    RemotePlayerController: function () {
      return { addEventListener(type, f) { (listeners[type] ||= []).push(f); },
        playOrPause() { log.calls.push('playOrPause'); set('isPaused', !player.isPaused); },
        seek() { log.calls.push('seek:' + Math.round(player.currentTime)); fire(E.CURRENT_TIME_CHANGED, 'currentTime', player.currentTime); },
        setVolumeLevel() { log.calls.push('vol:' + player.volumeLevel); fire(E.VOLUME_LEVEL_CHANGED, 'volumeLevel', player.volumeLevel); },
        muteOrUnmute() { set('isMuted', !player.isMuted); }, stop() { log.calls.push('stop'); set('isMediaLoaded', false); } };
    } } };
  window.__castSim = { set, player, log };
}

async function newPage({ cast = false, width = 1280 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 740 : 800 } });
  await ctx.addCookies([{ name: 'kt', value: cookie, url: B }]);
  const page = await ctx.newPage();
  const errors = [], reqs = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => reqs.push({ url: r.url(), method: r.method(), body: r.postData() }));
  // Saknade bilder (inga affischer utan TMDB, inga spolningsbilder än) är väntade – allt annat räknas som fel
  page.on('response', r => { if (r.status() >= 400 && !/\/api\/(image|items\/\d+\/trickplay|music\/cover|audiobooks\/cover)/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  if (cast) {
    await page.addInitScript(castStub);
    await page.route('https://www.gstatic.com/**', r => r.fulfill({ contentType: 'text/javascript', body: 'window.__onGCastApiAvailable && window.__onGCastApiAvailable(true);' }));
  }
  return { page, errors, reqs, close: () => ctx.close() };
}
const progressCalls = (reqs, re) => reqs.filter(r => r.method === 'POST' && re.test(r.url)).map(r => JSON.parse(r.body || '{}'));
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

t('förberedelse: konto, bibliotek och bio-läge', async () => {
  assert.equal((await fetch(B + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) })).status, 200);
  tok = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW, app: true }) })).json()).token;
  const lr = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) });
  cookie = /kt=([0-9a-f]+)/.exec(lr.headers.get('set-cookie'))[1];
  for (const [name, type, p] of [['Filmer', 'movie', 'Filmer'], ['Serier', 'show', 'Serier'], ['Musik', 'music', 'Musik'], ['Ljudböcker', 'audiobook', 'Ljudböcker']])
    assert.equal((await req('/api/libraries', { method: 'POST', body: { name, type, path: path.join(MEDIA, p) } })).status, 200);
  for (let i = 0; i < 240; i++) { await sleep(500); const r = (await req('/api/scan')).data; if (!r.running && !r.analysis?.running && r.last) break; }
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const id = (sql, ...a) => db.prepare(sql).get(...a)?.id;
  S.main = id("SELECT id FROM items WHERE kind='movie' AND title='Huvudfilmen'");
  S.andra = id("SELECT id FROM items WHERE kind='movie' AND title='Andra'");
  S.tredje = id("SELECT id FROM items WHERE kind='movie' AND title='Tredje'");
  for (const n of [1, 2, 3]) S['e' + n] = id("SELECT id FROM items WHERE kind='episode' AND episode=?", n);
  S.album = id('SELECT id FROM albums'); S.book = id('SELECT id FROM books');
  S.tracks = db.prepare('SELECT id FROM tracks ORDER BY track_no').all().map(r => r.id);
  db.prepare('UPDATE items SET genres=? WHERE id IN (?,?,?)').run('["Action"]', S.main, S.andra, S.tredje);
  db.close();
  assert.ok(S.main && S.andra && S.tredje && S.e1 && S.e3 && S.album && S.book && S.tracks.length === 2, JSON.stringify(S));
  assert.equal((await req('/api/settings', { method: 'PUT', body: { cinemaPreroll: path.join(MEDIA, 'Förfilmer') } })).status, 200);
});

t('Mitt konto: bio-lägets inställning sparas', async () => {
  const { page, errors, close } = await newPage();
  await page.goto(B + '/#/account');
  await page.waitForSelector('#cinemaprefs #cmn');
  const saved = () => page.waitForResponse(r => r.url().endsWith('/api/me/cinema') && r.request().method() === 'PUT');
  await Promise.all([saved(), page.selectOption('#cmn', '2')]);
  await Promise.all([saved(), page.check('#cmp')]);
  assert.deepEqual((await req('/api/me/cinema')).data, { trailers: 2, preroll: true, max: 3, prerollAvailable: true });
  await page.locator('#cinemaprefs').scrollIntoViewIfNeeded(); await shot(page, 'konto-bio-1280');
  assert.deepEqual(errors, []);
  await close();
});

t('bio-läge: trailers och förfilm före filmen, Hoppa över, länk till titeln, sedan filmen', async () => {
  for (const width of [1280, 375]) {
    const { page, errors, reqs, close } = await newPage({ width });
    await page.goto(B + '/#/item/' + S.main);
    await page.click('[data-play="0"]');
    await page.waitForSelector('#player.cinema .cinemabox');
    assert.match(await page.textContent('.cinemabox'), /Trailer 1 av 2/);
    assert.match(await page.textContent('.cinemabox'), /Trailer: (Andra|Tredje)/);
    const href = await page.getAttribute('.cinemabox a[data-goto]', 'href');
    assert.ok([`#/item/${S.andra}`, `#/item/${S.tredje}`].includes(href), href);
    assert.ok(reqs.some(r => r.url.includes(`/api/items/${S.main}/playback`) && r.url.includes('cinema=1')));
    // Trailern spelas i en egen video ovanpå (riktig fil från servern)
    await page.waitForFunction(() => document.querySelector('#previd')?.currentTime > 0.2);
    assert.ok((await page.getAttribute('#previd', 'src')).includes('/api/trailers/'));
    await shot(page, `bio-trailer-${width}`);
    await page.click('.cinemabox [data-skip]');
    await page.waitForFunction(() => /Trailer 2 av 2/.test(document.querySelector('.cinemabox')?.textContent || ''));
    // Trailer 2 får spela klart av sig själv → förfilmen → filmen
    await page.waitForFunction(() => /Förfilm/.test(document.querySelector('.cinemabox')?.textContent || ''), null, { timeout: 15000 });
    assert.ok((await page.getAttribute('#previd', 'src')).includes('/api/cinema/preroll/0/stream'));
    await page.waitForSelector('.cinemabox', { state: 'detached', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('#vid')?.currentTime > 0.2, null, { timeout: 15000 });
    assert.ok(!(await page.$('#player.cinema')));
    // Filmen hämtades på nytt utan cinema=1
    assert.ok(reqs.some(r => r.url.includes(`/api/items/${S.main}/playback`) && !r.url.includes('cinema=1')));
    assert.deepEqual(errors, []);
    await close();
  }
  // Hoppa över alla: filmen startar direkt; länken stänger spelaren och öppnar titeln
  {
    const { page, errors, close } = await newPage();
    await page.goto(B + '/#/item/' + S.main);
    await page.click('[data-play="0"]');
    await page.waitForSelector('.cinemabox [data-all]');
    await page.click('.cinemabox [data-all]');
    await page.waitForSelector('.cinemabox', { state: 'detached' });
    await page.waitForFunction(() => document.querySelector('#vid')?.currentTime > 0.2, null, { timeout: 15000 });
    await page.click('#cstop');
    await page.click('[data-play="0"]');
    await page.waitForSelector('.cinemabox a[data-goto]');
    const href = await page.getAttribute('.cinemabox a[data-goto]', 'href');
    await page.click('.cinemabox a[data-goto]');
    await page.waitForFunction(() => document.querySelector('#player')?.hidden);
    await page.waitForFunction((h) => location.hash === h, href);
    assert.deepEqual(errors, []);
    await close();
  }
});

t('bio-läge: inte vid Fortsätt titta eller för avsnitt', async () => {
  await req(`/api/items/${S.main}/progress`, { method: 'POST', body: { position: 32, duration: 40 } });
  const { page, errors, reqs, close } = await newPage();
  await page.goto(B + '/#/item/' + S.main);
  await page.click('[data-play="32"]');
  await page.waitForFunction(() => document.querySelector('#vid')?.currentTime > 32, null, { timeout: 15000 });
  assert.ok(!(await page.$('.cinemabox')));
  await page.click('#cstop');
  await page.goto(B + '/#/item/' + S.e2);
  await page.click('[data-play="0"]');
  await page.waitForFunction(() => document.querySelector('#vid')?.currentTime > 0.2, null, { timeout: 15000 });
  assert.ok(!(await page.$('.cinemabox')));
  assert.ok(!reqs.some(r => r.url.includes('/playback') && r.url.includes('cinema=1')));
  assert.deepEqual(errors, []);
  await close();
  await req(`/api/items/${S.main}/progress`, { method: 'POST', body: { position: 0, duration: 40 } });
});

t('Chromecast: avsnitt med kö, framsteg, panelens styrning och spårbyten', async () => {
  const { page, errors, reqs, close } = await newPage({ cast: true });
  await page.goto(B + '/#/item/' + S.e1);
  await page.click('[data-play="0"]');
  await page.waitForSelector('#pcast:not([hidden])');
  await page.click('#pcast');
  await page.waitForSelector('#castbar:not([hidden])');
  const log = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__castSim.log)));
  let L = await log();
  assert.equal(L.loads.length, 1);
  assert.match(L.loads[0].contentId, new RegExp(`^${B}/api/stream/${S.e1}/.*t=[0-9a-f]{64}`));
  assert.equal(L.loads[0].customData.id, S.e1); assert.equal(L.loads[0].customData.nextId, S.e2);
  assert.equal(L.loads[0].tracks.length, 1); // den externa undertexten
  assert.ok(await page.$eval('#player', el => el.hidden), 'webbspelaren stängs');
  // Nästa avsnitt köas med en egen token
  await page.waitForFunction(() => window.__castSim.log.inserts.length === 1);
  L = await log();
  assert.equal(L.inserts[0][0].customData.id, S.e2);
  const t1 = /t=([0-9a-f]{64})/.exec(L.loads[0].contentId)[1], t2 = /t=([0-9a-f]{64})/.exec(L.inserts[0][0].contentId)[1];
  assert.notEqual(t1, t2);
  assert.match(L.inserts[0][0].contentId, new RegExp(`/api/stream/${S.e2}/`));
  assert.ok(reqs.some(r => r.url.includes(`/api/items/${S.e2}/playback`) && r.url.includes('queue=1') && r.url.includes('cast=1')));
  assert.match(await page.textContent('#cxtitle'), /Serien – S01E01/);
  await shot(page, 'cast-panel-1280');
  // Paus på mottagaren → framsteget sparas direkt
  await page.evaluate(() => { window.__castSim.set('currentTime', 2.5); window.__castSim.set('isPaused', true); });
  await page.waitForFunction(() => document.querySelector('#cxplay').textContent === '▶');
  await sleep(300);
  assert.ok(progressCalls(reqs, new RegExp(`/api/items/${S.e1}/progress$`)).some(b => Math.abs(b.position - 2.5) < 0.01));
  // Medan det spelas: var 10:e sekund
  await page.evaluate(() => window.__castSim.set('isPaused', false));
  const n0 = progressCalls(reqs, new RegExp(`/api/items/${S.e1}/progress$`)).length;
  await page.evaluate(() => window.__castSim.set('currentTime', 3));
  await sleep(10300);
  await page.evaluate(() => window.__castSim.set('currentTime', 3.5));
  await sleep(300);
  const calls = progressCalls(reqs, new RegExp(`/api/items/${S.e1}/progress$`));
  assert.ok(calls.length > n0 && calls.at(-1).position === 3.5, JSON.stringify(calls));
  // Panelen: ±10 s, spola, paus, volym
  await page.click('#cxplay');
  await page.click('#cxback');
  const box = await page.locator('#cxtrack').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.fill('#cxvol', '0.4');
  L = await log();
  assert.ok(L.calls.includes('playOrPause') && L.calls.includes('seek:0') && L.calls.some(c => /^seek:[23]$/.test(c)) && L.calls.includes('vol:0.4'), JSON.stringify(L.calls));
  // Undertext via tracks-API, ljudspår via ny laddning med det valda spåret
  await page.selectOption('#cxsub', '1');
  await page.waitForFunction(() => window.__castSim.log.edits.length === 1);
  assert.deepEqual((await log()).edits[0], [1]);
  const audios = await page.$$eval('#cxaudio option', o => o.map(x => x.value));
  assert.equal(audios.length, 2);
  await page.selectOption('#cxaudio', audios[1]);
  await page.waitForFunction(() => window.__castSim.log.loads.length === 2);
  L = await log();
  assert.equal(L.loads[1].customData.id, S.e1); assert.equal(L.loads[1].customData.audio, audios[1]);
  assert.deepEqual(L.loads[1].activeTrackIds, [1]); // undertexten följer med
  // Mottagaren går vidare till det köade avsnittet: det förra sparas (sett), nästa köas
  await page.evaluate(() => window.__castSim.set('currentTime', 5.9));
  await page.waitForFunction(() => window.__castSim.log.inserts.length >= 1);
  const queued = (await log()).inserts.at(-1)[0];
  await page.evaluate((q) => window.__castSim.set('mediaInfo', { contentId: q.contentId, customData: q.customData }), queued);
  await page.waitForFunction((id) => /S01E02/.test(document.querySelector('#cxtitle').textContent) && window.__castSim.log.inserts.some(l => l[0].customData.id === id), S.e3);
  await sleep(300);
  assert.equal((await req(`/api/items/${S.e1}`)).data.watched, true);
  // Stopp: framsteget sparas, castningen avslutas och panelen försvinner
  await page.evaluate(() => window.__castSim.set('currentTime', 2));
  await page.click('#cxstop');
  await page.waitForSelector('#castbar', { state: 'hidden' });
  L = await log();
  assert.ok(L.calls.includes('stop') && L.calls.includes('end'));
  await sleep(300);
  assert.ok(progressCalls(reqs, new RegExp(`/api/items/${S.e2}/progress$`)).some(b => b.position === 2));
  assert.deepEqual(errors, []);
  await close();
});

t('Chromecast: musik och ljudbok från ljudspelaren', async () => {
  for (const width of [1280, 375]) {
    const { page, errors, reqs, close } = await newPage({ cast: true, width });
    await page.goto(B + '/#/album/' + S.album);
    await page.click('tr[data-ti="0"]');
    await page.waitForSelector('#mbar:not([hidden]) #mcast:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#maudio').currentTime > 0.3);
    await page.click('#mcast');
    await page.waitForSelector('#castbar:not([hidden])');
    const log = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__castSim.log)));
    let L = await log();
    assert.match(L.loads[0].contentId, new RegExp(`/api/music/tracks/${S.tracks[0]}/stream\\?t=[0-9a-f]{64}&a=`));
    assert.equal(L.loads[0].customData.kind, 'track');
    assert.ok(L.loads[0].currentTime > 0.2);
    await page.waitForFunction(() => window.__castSim.log.inserts.length === 1);
    L = await log();
    assert.equal(L.inserts[0][0].customData.id, S.tracks[1]);
    assert.ok(await page.$eval('#mbar', el => el.hidden), 'ljudspelaren här stängs');
    await shot(page, `cast-musik-${width}`);
    // Spåret räknades redan när det startade här – nästa räknas när mottagaren byter
    const played = () => reqs.filter(r => r.method === 'POST' && /\/played$/.test(r.url)).map(r => r.url);
    assert.equal(played().length, 1);
    await page.evaluate((q) => window.__castSim.set('mediaInfo', { contentId: q.contentId, customData: q.customData }), L.inserts[0][0]);
    await page.waitForFunction(() => /Låt 2/.test(document.querySelector('#cxtitle').textContent));
    await sleep(200);
    assert.ok(played().at(-1).includes(`/api/music/tracks/${S.tracks[1]}/played`));
    await page.click('#cxstop');
    await page.waitForSelector('#castbar', { state: 'hidden' });

    // Ljudbok: från sparad position i första delen, nästa del köas, framsteget sparas
    await req(`/api/audiobooks/book/${S.book}/progress`, { method: 'POST', body: { position: 12 } });
    await page.goto(B + '/#/book/' + S.book);
    await page.click('#bp');
    await page.waitForFunction(() => document.querySelector('#maudio').currentTime > 0.2);
    await page.click('#mcast');
    await page.waitForFunction(() => window.__castSim.log.loads.length === 2);
    L = await log();
    const bl = L.loads[1];
    assert.match(bl.contentId, /\/api\/audiobooks\/files\/\d+\/stream\?a=.*&t=[0-9a-f]{64}/);
    assert.equal(bl.customData.kind, 'book'); assert.equal(bl.customData.offset, 0);
    assert.ok(bl.currentTime >= 12 && bl.currentTime < 15, String(bl.currentTime));
    await page.waitForFunction(() => window.__castSim.log.inserts.length === 2);
    assert.ok(Math.abs((await log()).inserts[1][0].customData.offset - 30) < 1);
    await page.evaluate(() => { window.__castSim.set('currentTime', 20); window.__castSim.set('isPaused', true); });
    await sleep(300);
    assert.ok(progressCalls(reqs, new RegExp(`/api/audiobooks/book/${S.book}/progress$`)).some(b => b.position === 20));
    assert.equal((await req(`/api/audiobooks/book/${S.book}`)).data.position, 20);
    assert.deepEqual(errors, []);
    await close();
  }
});
