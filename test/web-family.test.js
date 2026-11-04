// Föräldraöversikten i Chromium (Playwright): huvudkontot med två barnprofiler. Dator (1280 px): flikar per barn,
// tid per dag, mest sett, senaste uppspelningarna, +15 min skärmtid, period 30 dagar, Spelas nu och Stoppa (barnets
// spelare får stopp). Telefon (375 px): ingen sidledsrullning, granskning. TV-läge (?tv=1): bara pilar, Enter och
// Bakåt – till +15 min, perioden och en titel och tillbaka. Barnprofilen själv ser ingen översikt och inget menyval.
// Hoppas över om ffmpeg eller Playwright saknas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync, execFileSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';
import { freePort } from './helpers/port.js';
import { auditPage } from './helpers/a11y-audit.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
const require = createRequire(import.meta.url);
for (const p of [process.env.PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = p.startsWith('/') ? await import(p) : require(p)); if (chromium) break; } catch {}
}
const skip = !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-webfamily-'));
const MEDIA = path.join(ROOT, 'media');
const SHOTS = process.env.SHOTS || '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (list) => list.map(f => `  [${f.rule}] ${f.sel} – ${f.msg}`).join('\n');
let srv, browser;
const S = {}, ck = {};
const MODES = {
  phone: { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true },
  desktop: { viewport: { width: 1280, height: 800 } },
  tv: { viewport: { width: 1920, height: 1080 } }
};

before(async () => {
  if (skip) return;
  for (const [n, f] of [['Pippi Långstrump', 300], ['Emil i Lönneberga', 500]]) {
    const d = path.join(MEDIA, 'Filmer', `${n} (1970)`); fs.mkdirSync(d, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=4', '-f', 'lavfi', '-i', `sine=frequency=${f}:duration=4`,
      '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', path.join(d, `${n} (1970).webm`)]);
  }
  srv = await startServer({ root: ROOT, media: MEDIA, port: await freePort(), env: { TMDB_API_KEY: '', WATCH_FILES: '0' } });
  const items = await srv.setup();
  S.pippi = items.find(i => /Pippi/.test(i.title)).id; S.emil = items.find(i => /Emil/.test(i.title)).id;
  for (const [name, maxAge] of [['Lisa', 7], ['Olle', 11]]) assert.equal((await srv.req('/api/profiles', { method: 'POST', body: { name, maxAge } })).status, 200);
  const P = (await srv.req('/api/profiles')).data.profiles;
  S.lisa = P.find(p => p.name === 'Lisa').id; S.olle = P.find(p => p.name === 'Olle').id;
  ck.admin = /kt=([0-9a-f]+)/.exec((await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW } })).headers.get('set-cookie'))[1];
  // Lisas egen inloggning (profilbyte från en ny inloggning)
  const lr = await fetch(srv.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) });
  const sw = await fetch(srv.base + '/api/profiles/switch', { method: 'POST', headers: { 'content-type': 'application/json', cookie: lr.headers.get('set-cookie').split(';')[0], origin: srv.base }, body: JSON.stringify({ id: S.lisa }) });
  assert.equal(sw.status, 200);
  ck.lisa = /kt=([0-9a-f]+)/.exec(sw.headers.get('set-cookie'))[1];
  // Barntillåtna filmer och Lisas historik: i dag, i går kväll och utanför hemmet
  const db = new DatabaseSync(path.join(ROOT, 'config', 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare('UPDATE items SET age=0').run();
  const now = Math.floor(Date.now() / 1000), d = new Date();
  const at = (daysAgo, h) => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, h).getTime() / 1000);
  const ins = db.prepare(`INSERT INTO plays(user_id,item_id,ts,ended,played,duration,pos_end,remote,device,kind,title) VALUES(?,?,?,?,?,4,?,?,?,'movie',?)`);
  ins.run(S.lisa, S.pippi, Math.min(now - 3600, at(0, 8)), now, 1800, 4, 0, 'Chrome', 'Pippi Långstrump');
  ins.run(S.lisa, S.emil, at(1, 22), at(1, 23), 2400, 2, 1, 'iPhone/iPad-app', 'Emil i Lönneberga');
  ins.run(S.lisa, S.pippi, at(3, 17), at(3, 18), 1200, 4, 0, 'Chrome', 'Pippi Långstrump');
  db.close();
  assert.equal((await srv.req(`/api/screentime/${S.lisa}`, { method: 'PUT', body: { daily: 60 } })).status, 200);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const bt = (name, fn) => test(name, { skip, timeout: 240000 }, fn);
async function newPage(mode, who = 'admin') {
  const ctx = await browser.newContext(MODES[mode]);
  await ctx.addCookies([{ name: 'kt', value: ck[who], url: srv.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  return { page, errors, close: () => ctx.close() };
}
const settled = (page) => page.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))), new Promise(r => setTimeout(r, 2000))]));
async function open(page, hash) {
  await page.goto(srv.base + '/' + hash);
  await page.waitForSelector('#famdetail .tiles', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#main[aria-busy]'), null, { timeout: 15000 });
  await sleep(250); await settled(page);
}
async function audit(page, name) {
  const f = await page.evaluate(auditPage, {});
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `family-${name}.png`), fullPage: true });
  assert.deepEqual(f, [], `${f.length} fynd (${name}):\n${fmt(f)}`);
}
/** Lisa spelar Pippi (uppspelningsbeslut + framsteg som barnets spelare skickar) */
async function lisaPlays(position = 2, start = true) {
  const h = { cookie: `kt=${ck.lisa}`, origin: srv.base, 'content-type': 'application/json' };
  if (start) assert.equal((await fetch(`${srv.base}/api/items/${S.pippi}/playback`, { headers: h })).status, 200);
  return (await fetch(`${srv.base}/api/items/${S.pippi}/progress`, { method: 'POST', headers: h, body: JSON.stringify({ position, duration: 4 }) })).json();
}

bt('dator: översikten, extra skärmtid, perioden och Stoppa', async () => {
  const { page, errors, close } = await newPage('desktop');
  await open(page, '#/family');
  assert.equal(await page.textContent('h1'), 'Föräldraöversikt');
  // En flik per barn (bara barnprofiler, inte huvudkontot)
  assert.deepEqual((await page.$$eval('#famkids [role=tab]', a => a.map(x => x.textContent.split(' · ')[0]))), ['Lisa', 'Olle']);
  assert.equal(await page.getAttribute('#famkids [aria-selected=true]', 'href'), `#/family/${S.lisa}`);
  // Skärmtid: 60 min/dag
  assert.match(await page.textContent('#famst'), /kvar idag/);
  assert.ok(await page.$('#famst .fam-meter'));
  // Tid per dag (diagram), mest sett (Pippi före Emil: 3000 s mot 2400 s) och senaste med kväll/utanför hemmet
  assert.ok(await page.$('#famper svg.chart'));
  assert.deepEqual(await page.$$eval('.fam-list .fam-t', a => a.map(x => x.textContent)), ['Pippi Långstrump', 'Emil i Lönneberga']);
  const hist = await page.textContent('#famdetail');
  assert.ok(await page.$('.fam-hist .warn-badge'), 'kvällstittande märks'); assert.ok(await page.$('.fam-hist .ok-badge'), 'utanför hemmet märks');
  assert.match(hist, /Emil i Lönneberga/);
  await audit(page, 'desktop');
  // +15 min
  await page.click('[data-ex="15"]');
  await page.waitForFunction(() => /Lisa fick 15 min extra idag/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 5000 })
    .catch(async () => { throw new Error('ingen toast: ' + await page.textContent('#toast') + ' | ' + await page.textContent('#famst') + ' | ' + errors.join(',')); });
  await page.waitForFunction(() => /15 min extra/.test(document.querySelector('#famst')?.textContent || ''));
  assert.equal((await srv.req(`/api/screentime/${S.lisa}`)).data.status.extra, 15);
  // Perioden: 30 dagar ger 30 staplar och fokus står kvar på fliken
  const bars = () => page.$$eval('#famper svg.chart .ch-g', g => g.length);
  assert.equal(await bars(), 7);
  await page.click('#famdays [data-tab-key="30"]');
  await page.waitForFunction(() => document.querySelectorAll('#famper svg.chart .ch-g').length === 30);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.tabKey), '30');
  // Olle: inget sett de senaste dagarna förutom inget – tom period, och tillbaka till Lisa
  await page.click(`#famkids [href="#/family/${S.olle}"]`);
  await page.waitForFunction((id) => document.querySelector('#famkids [aria-selected=true]')?.getAttribute('href') === `#/family/${id}`, S.olle);
  await page.waitForSelector('#famdetail .tiles');
  assert.match(await page.textContent('#famdetail'), /Olle har inte tittat eller lyssnat/);
  // Spelas nu och Stoppa
  await lisaPlays();
  await page.goto(srv.base + `/#/family/${S.lisa}`);
  await page.waitForSelector('#famstop');
  assert.match(await page.textContent('#famnow'), /Pippi Långstrump/);
  await audit(page, 'desktop-spelas');
  await page.click('#famstop');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog[open] button:has-text("Stoppa")');
  await page.waitForFunction(() => /stoppas inom några sekunder/.test(document.querySelector('#toast')?.textContent || ''));
  await page.waitForFunction(() => !document.querySelector('#famstop'), null, { timeout: 10000 });
  const r = await lisaPlays(3, false);
  assert.equal(r.stop, true, 'Lisas spelare får stopp');
  assert.equal((await fetch(`${srv.base}/api/items/${S.pippi}/playback`, { headers: { cookie: `kt=${ck.lisa}` } })).status, 403, 'kan inte starta om direkt');
  // Menyvalet finns för huvudkontot
  await page.click('#userbtn');
  assert.equal(await page.isVisible('#usermenu a[href="#/family"]'), true);
  assert.deepEqual(errors, []);
  await close();
});

bt('telefon: ingen sidledsrullning, granskning', async () => {
  const { page, errors, close } = await newPage('phone');
  await open(page, `#/family/${S.lisa}`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'sidan rullar i sidled');
  // Panelerna ligger under varandra
  const [a, b] = await page.$$eval('.fam-top2 > .panel', p => p.map(x => x.getBoundingClientRect().top));
  assert.ok(b > a + 20, 'Just nu och Skärmtid ska ligga under varandra på telefonen');
  await audit(page, 'telefon');
  assert.deepEqual(errors, []);
  await close();
});

bt('TV-läge: pilar, Enter och Bakåt', async () => {
  const { page, errors, close } = await newPage('tv');
  await open(page, `?tv=1#/family/${S.lisa}`);
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('tv')));
  const focus = () => page.evaluate(() => { const a = document.activeElement; const r = a?.getBoundingClientRect();
    return { id: a?.id || a?.className, tag: a?.tagName, ex: a?.dataset?.ex || null, key: a?.dataset?.tabKey || null, row: !!a?.classList?.contains('fam-row'), href: a?.getAttribute?.('href') || null,
      inMain: !!a?.closest?.('#main'), onScreen: !!r && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth }; });
  const press = async (k) => { await page.keyboard.press(k); await sleep(120); };
  // Ner tills +15 min har fokus
  let f;
  for (let i = 0; i < 12; i++) { await press('ArrowDown'); f = await focus(); if (f.ex) break; }
  for (let i = 0; i < 4 && f.ex !== '15'; i++) { await press('ArrowLeft'); f = await focus(); }
  assert.equal(f.ex, '15', 'fokus på +15 min: ' + JSON.stringify(f));
  assert.ok(f.onScreen);
  const extra = (await srv.req(`/api/screentime/${S.lisa}`)).data.status.extra; // +15 i datortestet före
  await press('Enter');
  await page.waitForFunction((n) => document.querySelector('#famst')?.textContent.includes(`${n} min extra`), extra + 15);
  // Vidare ner till periodflikarna, → 30 dagar, Enter
  for (let i = 0; i < 8 && !f.key; i++) { await press('ArrowDown'); f = await focus(); }
  assert.equal(f.key, '7', 'periodfliken: ' + JSON.stringify(f));
  await press('ArrowRight'); await press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#famper svg.chart .ch-g').length === 30);
  // Ner till en titel i Mest sett och in på titelsidan
  for (let i = 0; i < 10 && !f.row; i++) { await press('ArrowDown'); f = await focus(); assert.ok(f.onScreen, 'fokus på skärmen'); }
  assert.ok(f.row, 'en rad i Mest sett: ' + JSON.stringify(f));
  const href = f.href;
  await press('Enter');
  await page.waitForFunction((h) => location.hash === h, href);
  // Bakåt tillbaka till översikten
  await press('Escape');
  await page.waitForFunction(() => location.hash.startsWith('#/family'), null, { timeout: 10000 });
  await page.waitForSelector('#famdetail .tiles');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await audit(page, 'tv');
  assert.deepEqual(errors, []);
  await close();
});

bt('barnprofilen: ingen översikt och inget menyval', async () => {
  const { page, errors, close } = await newPage('desktop', 'lisa');
  await page.goto(srv.base + '/#/family');
  await page.waitForSelector('#main .empty, #main [class*=empty]');
  assert.match(await page.textContent('#main'), /Föräldraöversikten finns i huvudkontot/);
  await page.click('#userbtn');
  assert.equal(await page.isVisible('#usermenu a[href="#/family"]'), false);
  assert.deepEqual(errors, []);
  await close();
});
