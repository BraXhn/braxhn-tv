// Självläkande start (web/start.js, web/sw.js, /reset i server/http/static.js) i Chromium (Playwright).
// Incident 2026-11-03: en sida ur service workerns cache med startskriptet före import map fastnade för evigt på
// laddningen i Safari – bara en privat flik eller att radera webbplatsdatan hjälpte. Appen får aldrig mer hamna i ett
// läge som användaren inte kommer ur själv:
//  (a) en trasig modul i service workerns cache → vakthunden läker (avregistrerar, tömmer appens cache) och appen startar
//  (b) en start som kastar fel → EN omladdning, sedan felsidan – ingen slinga; "Rensa och ladda om" fungerar
//  (c) en gammal sida med fel ordning (startskript före import map) i cachen visas inte när servern svarar
//  (d) /reset: Clear-Site-Data, inloggningen behålls, ?soft=1 låter Nedladdat vara
// Inga snäva tidsgränser: vakthunden väntar själv så länge något går framåt; testerna väntar på utfallet (högst minuter).
// Hoppas över om Playwright saknas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { startServer, PW } from './media/server.mjs';

let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
if (!chromium) { try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {} }
const skip = !chromium ? 'Playwright saknas' : false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-selfheal-'));
const MEDIA = path.join(ROOT, 'media');
let srv, browser, kt;

before(async () => {
  if (skip) return;
  fs.mkdirSync(path.join(MEDIA, 'Filmer'), { recursive: true });
  srv = await startServer({ root: ROOT, media: MEDIA, env: { TMDB_API_KEY: '', WATCH_FILES: '0', UPDATE_CHECK: '0' } });
  const r = await srv.req('/api/setup', { method: 'POST', body: { name: 'Pappa', password: PW } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const l = await srv.req('/api/login', { method: 'POST', body: { name: 'Pappa', password: PW } });
  kt = /kt=([0-9a-f]+)/.exec(l.headers.get('set-cookie'))[1];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const bt = (name, fn) => test(name, { skip, timeout: 300000 }, fn);
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'sv-SE', ...opts });
  await ctx.addCookies([{ name: 'kt', value: kt, url: srv.base }]);
  const page = await ctx.newPage();
  const docs = [], requests = [], warnings = [];
  page.on('request', (r) => { requests.push(r.url()); if (r.isNavigationRequest() && r.frame() === page.mainFrame()) docs.push(r.url().replace(srv.base, '')); });
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
  return { ctx, page, docs, requests, warnings };
}
// Utvärderar fn tills den ger ett sant värde – tål navigeringar mitt i (läkningen laddar om sidan)
async function until(page, fn, what, ms = 150000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await page.evaluate(fn); if (v) return v; } catch {}
    await sleep(250);
  }
  throw new Error('väntade förgäves: ' + what + ' (' + page.url() + ')');
}
const booted = (page) => until(page, () => !!self.__bxBootedAt && !document.querySelector('#bxstartfail') && !/bxheal=/.test(location.search), 'appen startade');
const failPage = (page) => until(page, () => document.querySelector('#bxstartfail')?.dataset.kind, 'felsidan');
const cacheKeys = (page) => page.evaluate(() => caches.keys());
/** Första besöket: appen startar och service workern har installerat skalet */
async function warm(page) {
  await page.goto(srv.base + '/');
  await booted(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await until(page, async () => (await caches.keys()).some(k => k.startsWith('braxhn-app-')), 'appens cache');
}

bt('(a) en trasig modul i service workerns cache: vakthunden läker och appen startar', async () => {
  const { ctx, page, docs } = await newPage();
  await warm(page);
  // Byt core.js i cachen mot en gammal/trasig modul (fel som i ett halvt uppdaterat skal)
  const swapped = await page.evaluate(async () => {
    const name = (await caches.keys()).find(k => k.startsWith('braxhn-app-'));
    const c = await caches.open(name);
    const key = (await c.keys()).map(r => r.url).find(u => /\/m\/js\/core\.js\?h=/.test(u));
    await c.put(key, new Response('export const gammal = 1; throw new Error("trasig modul ur cachen");', { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=31536000, immutable' } }));
    return key;
  });
  assert.ok(swapped, 'core.js saknas i cachen');
  docs.length = 0;
  await page.goto(srv.base + '/', { waitUntil: 'commit' });
  await booted(page);
  assert.ok(docs.some(u => u.startsWith('/reset?soft=1')), 'läkningen gick inte via /reset?soft=1: ' + docs.join(', '));
  assert.equal(docs.filter(u => u === '/' || u.startsWith('/?')).length, 2, 'en omladdning: ' + docs.join(', '));
  // Den trasiga modulen finns inte kvar (en ny service worker installerar skalet från servern)
  const bad = await page.evaluate(async (key) => { const r = await caches.match(key); return r ? /trasig modul/.test(await r.text()) : false; }, swapped);
  assert.equal(bad, false, 'den trasiga modulen ligger kvar i cachen');
  assert.ok(await page.$('#main'), 'sidan ritades inte');
  await ctx.close();
});

bt('(b) en start som kastar fel: en omladdning, sedan felsidan utan slinga – "Rensa och ladda om" och Försök igen', async () => {
  // Utan service worker: page.route ser då alla förfrågningar
  const { ctx, page, docs } = await newPage({ serviceWorkers: 'block' });
  let broken = true;
  await page.route(/\/m\/app\.js\?h=/, async (route) => {
    if (!broken) return route.continue();
    const res = await route.fetch();
    route.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("starten kraschar");\n' + await res.text() });
  });
  await page.goto(srv.base + '/#/', { waitUntil: 'commit' });
  assert.equal(await failPage(page), 'broken');
  const n = docs.length;
  assert.deepEqual(docs.map(u => u.replace(/#.*/, '').replace(/bxheal=\w+/, 'bxheal=X')), ['/', '/reset?soft=1', '/?bxheal=X'], 'en läkning: ' + docs.join(', '));
  // Ingen slinga: felsidan står kvar
  await sleep(15000);
  assert.equal(docs.length, n, 'sidan laddades om igen: ' + docs.join(', '));
  assert.match(await page.textContent('#bxstartfail'), /kunde inte starta/);
  assert.match(await page.textContent('#bxstartfail'), /\/reset/);
  // Rensa och ladda om: /reset och tillbaka – fortfarande trasigt → felsidan igen, ingen slinga
  await page.click('#bxreset');
  await until(page, () => /bxheal=/.test(location.search) && document.querySelector('#bxstartfail'), 'felsidan efter Rensa och ladda om');
  assert.ok(docs.slice(n).some(u => u.replace(/#.*/, '') === '/reset'), 'knappen gick inte till /reset: ' + docs.slice(n).join(', '));
  const m = docs.length;
  await sleep(12000);
  assert.equal(docs.length, m, 'slinga efter Rensa och ladda om: ' + docs.join(', '));
  // Felet rättat (ny version på servern): Försök igen startar appen och tar bort bxheal ur adressen
  broken = false;
  await page.click('#bxretry');
  await booted(page);
  await ctx.close();
});

bt('(b2) modulerna hänger utan fel (som i Safari): läkning efter tidsgränsen, sedan felsidan', async () => {
  const { ctx, page, docs } = await newPage({ serviceWorkers: 'block' });
  const held = [];
  await page.route(/\/m\/app\.js\?h=/, (route) => { held.push(route); }); // svarar aldrig
  await page.goto(srv.base + '/', { waitUntil: 'commit' });
  assert.equal(await failPage(page), 'broken');
  assert.equal(docs.filter(u => u.startsWith('/reset?soft=1')).length, 1, docs.join(', '));
  const n = docs.length;
  await sleep(12000);
  assert.equal(docs.length, n, 'slinga: ' + docs.join(', '));
  await page.unroute(/\/m\/app\.js\?h=/);
  await ctx.close();
});

bt('(b3) servern svarar inte: cachen rörs inte, ingen läkning – efter en minut sidan om att servern inte svarar', async () => {
  const { ctx, page, docs } = await newPage({ serviceWorkers: 'block' });
  await page.goto(srv.base + '/offline.html');
  await page.evaluate(async () => { await (await caches.open('braxhn-app-test')).put('/x', new Response('x')); });
  // API:t (även /api/health) nås inte och modulerna kommer aldrig – som när servern försvinner mitt i starten
  await page.route(/\/api\//, (route) => route.abort('connectionrefused'));
  await page.route(/\/m\/app\.js\?h=/, () => {});
  docs.length = 0;
  await page.goto(srv.base + '/', { waitUntil: 'commit' });
  assert.equal(await failPage(page), 'offline');
  assert.deepEqual(docs, ['/'], 'läkte trots att servern inte svarar');
  assert.ok((await cacheKeys(page)).includes('braxhn-app-test'), 'cachen tömdes trots att servern inte svarar');
  assert.match(await page.textContent('#bxstartfail'), /Servern svarar inte/);
  await page.unroute(/\/api\//); await page.unroute(/\/m\/app\.js\?h=/);
  await ctx.close();
});

bt('(c) gammal sida med startskriptet före import map i cachen: visas inte när servern svarar', async () => {
  const { ctx, page, requests, warnings } = await newPage();
  await warm(page);
  // Sidan som den såg ut i den trasiga versionen: startskriptet före import map, ett gammalt bygge
  const html = await (await fetch(srv.base + '/', { headers: { cookie: 'kt=' + kt } })).text();
  const imap = /<script type="importmap">[^<]*<\/script>\n/.exec(html)[0];
  const old = html.replace(imap, '').replace('</head>', imap + '</head>').replace(/<meta name="bx-build" content="\w+">/, '<meta name="bx-build" content="000000000000">')
    .replace(/\/m\/app\.js\?h=\w+/g, '/m/app.js?h=0000000000');
  assert.ok(old.indexOf('self.__preload') < old.indexOf('type="importmap"'), 'testsidan har inte fel ordning');
  await page.evaluate(async (body) => {
    const name = (await caches.keys()).find(k => k.startsWith('braxhn-app-'));
    const c = await caches.open(name);
    for (const k of ['/', '/__page/sv', '/__page/en']) await c.put(k, new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  }, old);
  requests.length = 0;
  for (const u of ['/', '/?app=1']) {
    await page.goto(srv.base + u, { waitUntil: 'commit' });
    await booted(page);
  }
  assert.ok(!requests.some(u => /h=0000000000/.test(u)), 'den gamla sidan ur cachen användes');
  const order = await page.evaluate(() => {
    const s = [...document.querySelectorAll('head script')];
    return [s.findIndex(x => x.type === 'importmap'), s.findIndex(x => !x.type && /__preload/.test(x.textContent))];
  });
  assert.ok(order[0] >= 0 && order[0] < order[1], 'import map före startskriptet');
  assert.deepEqual(warnings.filter(w => /import map/i.test(w)), []);
  await ctx.close();
});

bt('(c2) startskriptet före import map i en ny sida: ingen förladdning före reglerna, appen startar', async () => {
  const { ctx, page, requests, warnings } = await newPage({ serviceWorkers: 'block' });
  await page.route((u) => u.pathname === '/', async (route) => {
    const res = await route.fetch();
    const html = await res.text();
    const imap = /<script type="importmap">[^<]*<\/script>\n/.exec(html)[0];
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': res.headers()['content-security-policy'] },
      body: html.replace(imap, '').replace('</head>', imap + '</head>') });
  });
  await page.goto(srv.base + '/');
  await booted(page);
  // Startskriptets förladdning (self.__preload) lades inte in – den hade löst modulerna före import map
  assert.equal(await page.evaluate(() => self.__preload.filter(h => document.querySelector(`link[rel=modulepreload][href="${h}"]`)).length), 0, 'förladdning före import map');
  assert.deepEqual(warnings.filter(w => /import map/i.test(w)), []);
  assert.deepEqual(requests.filter(u => /\/m\/js\/[\w/]+\.js$/.test(u)), [], 'moduler utan innehållshash');
  await ctx.close();
});

bt('(d) /reset: Clear-Site-Data, CSP-hash för skriptet, inloggningen behålls och ?soft=1 låter Nedladdat vara', async () => {
  // Servern: rubrikerna
  for (const [u, csd] of [['/reset', '"cache", "storage"'], ['/?reset=1', '"cache", "storage"'], ['/reset?soft=1', '"cache"']]) {
    const r = await fetch(srv.base + u);
    assert.equal(r.status, 200, u);
    assert.equal(r.headers.get('clear-site-data'), csd, u);
    assert.equal(r.headers.get('cache-control'), 'no-store', u);
    const body = await r.text();
    const js = /<script>([\s\S]*?)<\/script>/.exec(body)[1];
    assert.ok(r.headers.get('content-security-policy').includes(`'sha256-${crypto.createHash('sha256').update(js).digest('base64')}'`), 'skriptets hash saknas i CSP');
    assert.match(body, /bxheal=/);
  }
  assert.match(await (await fetch(srv.base + '/reset', { headers: { cookie: 'bxlang=en' } })).text(), /Clearing saved app files/);
  // Webbläsaren: Nedladdat (egen cache) finns, sedan soft – kvar; sedan /reset – borta, men fortfarande inloggad
  const { ctx, page, docs } = await newPage();
  await warm(page);
  await page.evaluate(async () => { await (await caches.open('braxhn-dl-v1')).put('/dl/test', new Response('x')); });
  await page.goto(srv.base + '/reset?soft=1#/', { waitUntil: 'commit' });
  await booted(page);
  assert.ok((await cacheKeys(page)).includes('braxhn-dl-v1'), 'soft tog bort Nedladdat');
  await page.goto(srv.base + '/reset', { waitUntil: 'commit' });
  await booted(page);
  assert.ok(docs.some(u => u.startsWith('/?bxheal=')), docs.join(', '));
  assert.ok(!(await cacheKeys(page)).includes('braxhn-dl-v1'), 'Nedladdat finns kvar efter /reset');
  assert.ok((await ctx.cookies()).some(c => c.name === 'kt' && c.value === kt), 'inloggningskakan försvann');
  const st = await page.evaluate(() => fetch('/api/status').then(r => r.json()));
  assert.equal(st.user?.name, 'Pappa', 'utloggad efter /reset');
  assert.equal(await page.evaluate(() => location.pathname + location.search), '/', 'bxheal ligger kvar i adressen');
  await ctx.close();
});
