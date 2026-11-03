// En hemanvändares första dag i Chromium (Playwright): installationsguiden från tom server, barnprofil utan TMDB-nyckel,
// profilbyte tillbaka med fel lösenord, ljudspelaren på telefonen, videospelaren på engelska och en varm start ur
// service workerns cache. Varje del är ett fel som en verklig användare såg (CHANGELOG: "Rättat efter en genomgång som ny hemanvändare").
// Hoppas över om ffmpeg eller Playwright saknas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const skip = !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-household-'));
const MEDIA = path.join(ROOT, 'media');
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const clip = (file, secs, freq = 440) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ff('-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`,
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', file);
};
let srv, browser;
const S = {};
const PHONE = { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };

before(async () => {
  if (skip) return;
  clip(path.join(MEDIA, 'Filmer', 'Sommarlov (2019)', 'Sommarlov (2019).webm'), 6, 300);
  const alb = path.join(MEDIA, 'Musik', 'Kalle Kula', 'Första plattan'); fs.mkdirSync(alb, { recursive: true });
  ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-metadata', 'title=En väldigt lång låttitel som inte får plats', '-metadata', 'artist=Kalle Kula',
    '-metadata', 'album=Första plattan', '-metadata', 'track=1', path.join(alb, '01 Lat.mp3'));
  const bok = path.join(MEDIA, 'Ljudböcker', 'Anna Andersson', 'Skogens hemlighet'); fs.mkdirSync(bok, { recursive: true });
  ff('-f', 'lavfi', '-i', 'sine=frequency=250:duration=20', '-metadata', 'title=Skogens hemlighet', '-metadata', 'album=Skogens hemlighet', '-metadata', 'artist=Anna Andersson', path.join(bok, '01.mp3'));
  srv = await startServer({ root: ROOT, media: MEDIA, env: { TMDB_API_KEY: '', WATCH_FILES: '0' } });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const bt = (name, fn) => test(name, { skip, timeout: 300000 }, fn);
async function newPage(opts = DESKTOP, locale = 'sv-SE') {
  const ctx = await browser.newContext({ ...opts, locale });
  const page = await ctx.newPage();
  const errors = [], warnings = [], requests = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); if (m.type() === 'warning') warnings.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => requests.push(r.url()));
  return { ctx, page, errors, warnings, requests };
}
const settle = (page) => page.waitForFunction(() => document.querySelector('#main') && !document.querySelector('#main[aria-busy]') && !document.querySelector('#main .sk'), null, { timeout: 15000 }).catch(() => {});
const login = async (ctx) => {
  const r = await srv.req('/api/login', { method: 'POST', body: { name: 'Pappa', password: PW } });
  await ctx.addCookies([{ name: 'kt', value: /kt=([0-9a-f]+)/.exec(r.headers.get('set-cookie'))[1], url: srv.base }]);
};

bt('installationsguiden: Nästa utan bibliotek erbjuder att lägga till förslagen, antal i singular', async () => {
  const { ctx, page, errors } = await newPage();
  await page.goto(srv.base + '/');
  await page.waitForSelector('#n');
  await page.fill('#n', 'Pappa'); await page.fill('#p', PW);
  await page.click('button.primary');
  await page.waitForFunction(() => location.hash.startsWith('#/setup'));
  await srv.req('/api/login', { method: 'POST', body: { name: 'Pappa', password: PW } }); // srv.req som Pappa
  await page.goto(srv.base + '/#/setup/libraries');
  await page.waitForSelector('[data-sga]:not([disabled])');
  // Mappnamnet – 1 videofil/ljudfil (inte "1 videofiler")
  assert.match(await page.textContent('#stsug'), /1 videofil(?!e)/);
  assert.match(await page.textContent("#stsug"), /1 ljudfil(?!e)/);
  // Nästa utan att ha lagt till något: förr gick guiden vidare och servern stod tom
  await page.click('#stnext');
  await page.waitForSelector('dialog[open]');
  assert.match(await page.textContent('dialog[open]'), /Inga bibliotek ännu/);
  await page.click('dialog[open] button:has-text("Stanna kvar")');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  assert.match(page.url(), /setup\/libraries$/, 'Stanna kvar = samma steg');
  await page.click('#stnext');
  await page.click('dialog[open] button:has-text("Lägg till förslagen")');
  await page.waitForFunction(() => location.hash === '#/setup/hardware', null, { timeout: 30000 });
  const libs = (await srv.req('/api/libraries')).data;
  assert.deepEqual(libs.map(l => l.type).sort(), ['audiobook', 'movie', 'music']);
  for (let i = 0; i < 120; i++) { const s = (await srv.req('/api/scan')).data; if (!s.running && !s.analysis?.running && s.last) break; await sleep(500); }
  for (const l of libs) S[l.type] = l.id;
  // Bibliotekslistan: "1 titel", "1 bok" (förr "1 titlar", "1 böcker")
  await page.goto(srv.base + '/#/setup/libraries');
  await page.waitForSelector('#stlibs .ok-badge');
  const badges = await page.$$eval('#stlibs .ok-badge', b => b.map(x => x.textContent.trim()));
  assert.ok(badges.includes('1 titel') && badges.includes('1 bok') && badges.includes('1 album'), badges.join(', '));
  // Hushållet: barnprofil med PIN – etiketten säger vad PIN:en gör (krävs för att byta TILL profilen)
  await page.goto(srv.base + '/#/setup/household');
  await page.waitForSelector('#stkp');
  assert.match(await page.textContent('label[for="stkp"]'), /byta till profilen/);
  await page.fill('#stkn', 'Lisa'); await page.selectOption('#stka', '11'); await page.fill('#stkp', '1234');
  await page.click('#stkid button');
  await page.waitForFunction(() => /Lisa/.test(document.querySelector('.setup-libs')?.textContent || ''));
  await page.goto(srv.base + '/#/setup/done');
  await page.waitForSelector('.checks');
  assert.match(await page.textContent('.checks'), /1 konto, 1 profil \(varav 1 barnprofil\)/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

bt('barnprofil utan TMDB-nyckel: begriplig tom startsida, och fel lösenord tillbaka till vuxenprofilen sägs', async () => {
  const { ctx, page, errors } = await newPage();
  await login(ctx);
  await page.goto(srv.base + '/#/profiles');
  await page.click('[data-pid][data-kid="1"]');
  await page.waitForSelector('dialog[open] input');
  await page.fill('dialog[open] input', '1234'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash === '#/' && document.querySelector('#main .state.empty'), null, { timeout: 15000 });
  await settle(page);
  const txt = await page.textContent('#main');
  // Förr: "Inget innehåll hittades – Kontrollera sökvägarna under Administration" (sökvägarna var rätt)
  assert.doesNotMatch(txt, /Kontrollera sökvägarna/);
  assert.match(txt, /Inget här inom åldersgränsen ännu/);
  assert.match(txt, /utan känd åldersgräns/);
  // Tillbaka till Pappa: huvudkontots lösenord – fel lösenord ska sägas (förr samma dialog igen utan förklaring)
  await page.goto(srv.base + '/#/profiles');
  await page.click('[data-pid][data-kid="0"]');
  await page.waitForSelector('dialog[open] input[type=password]');
  assert.doesNotMatch(await page.textContent('dialog[open]'), /Fel lösenord/);
  await page.fill('dialog[open] input', 'inte-rätt-lösen'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Fel lösenord/.test(document.querySelector('dialog[open]')?.textContent || ''), null, { timeout: 10000 });
  await page.fill('dialog[open] input', PW); await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('dialog[open]') && location.hash === '#/', null, { timeout: 10000 });
  assert.equal((await page.evaluate(() => fetch('/api/status').then(r => r.json()))).user.name, 'Pappa');
  assert.deepEqual(errors, []);
  await ctx.close();
});

bt('telefon: ljudspelaren visar titeln och går att stänga, utan vågrät rullning', async () => {
  const { ctx, page, errors } = await newPage(PHONE);
  await login(ctx);
  const check = async (what) => {
    await page.waitForFunction(() => document.querySelector('#mtitle')?.textContent, null, { timeout: 15000 });
    await sleep(400);
    const r = await page.evaluate(() => {
      const box = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && { l: b.left, r: b.right, w: b.width, t: b.top, b: b.bottom }; };
      return { W: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, title: box('#mtitle'), close: box('#mx'), vis: getComputedStyle(document.querySelector('#mx')).display !== 'none', ctl: box('#mbar .mctl') };
    });
    // Förr: titeln trycktes ihop till en bokstav av knappraden och ✕/Kö/hastigheten var dolda på telefon
    assert.ok(r.title.w > 120, `${what}: titeln är ${r.title.w} px bred`);
    assert.ok(r.vis && r.close.w >= 30 && r.close.r <= r.W && r.close.l >= 0, `${what}: stängknappen nås inte ${JSON.stringify(r.close)}`);
    assert.ok(r.ctl.r <= r.W + 1 && r.ctl.l >= -1, `${what}: knappraden går utanför skärmen ${JSON.stringify(r.ctl)}`);
    assert.ok(r.sw <= r.W, `${what}: sidan rullar i sidled (${r.sw} > ${r.W})`);
    assert.ok(r.close.b <= r.ctl.t + 2 || r.close.r <= r.ctl.l, `${what}: stängknappen ligger över knapparna`);
  };
  const albums = (await srv.req(`/api/music/${S.music}/albums`)).data;
  await page.goto(srv.base + `/#/album/${(albums.albums || albums.items || albums)[0].id}`);
  await page.click('#pa');
  await check('musik');
  await page.click('#mx');
  await page.waitForFunction(() => document.querySelector('#mbar')?.hidden);
  const books = (await srv.req(`/api/audiobooks/${S.audiobook}`)).data;
  await page.goto(srv.base + `/#/book/${(books.books || books.items || books)[0].id}`);
  await page.click('#bp');
  await check('ljudbok');
  assert.ok(await page.isVisible('#mspeed'), 'ljudbokens hastighet nås på telefonen');
  assert.deepEqual(errors, []);
  await ctx.close();
});

bt('engelska: videospelarens namn för skärmläsare är översatt', async () => {
  await srv.req('/api/me/lang', { method: 'PUT', body: { lang: 'en' } });
  const { ctx, page, errors } = await newPage(DESKTOP, 'en-US');
  await login(ctx);
  const items = (await srv.req(`/api/libraries/${S.movie}/items`)).data.items;
  await page.goto(srv.base + `/#/item/${items[0].id}`);
  await page.click('[data-play]');
  await page.waitForSelector('#player:not([hidden]) #vid');
  assert.equal(await page.getAttribute('#player', 'aria-label'), 'Video player: Sommarlov');
  assert.deepEqual(errors, []);
  await ctx.close();
  await srv.req('/api/me/lang', { method: 'PUT', body: { lang: 'sv' } });
});

bt('varm start ur service workerns cache: import map gäller, modulerna hämtas bara med hash', async () => {
  const { ctx, page, errors, warnings, requests } = await newPage();
  await login(ctx);
  await page.goto(srv.base + '/#/');
  await settle(page);
  await page.evaluate(() => navigator.serviceWorker.ready); // registreras när första sidan ritats
  for (const u of ['/?a=1#/', `/#/lib/${S.movie}`, '/?b=2#/', `/#/books/${S.audiobook}`]) {
    await page.goto(srv.base + u);
    await settle(page);
    await sleep(500);
  }
  // Förr: startskriptet lade in förladdningen före import map – ur cachen hann modulerna lösas först, Chrome tappade
  // reglerna och hämtade core.js, router.js … en gång till utan hash
  assert.deepEqual(warnings.filter(w => /import map/i.test(w)), []);
  assert.deepEqual(requests.filter(u => /\/m\/js\/[\w/]+\.js$/.test(u)), [], 'moduler utan innehållshash');
  assert.deepEqual(errors, []);
  await ctx.close();
});
