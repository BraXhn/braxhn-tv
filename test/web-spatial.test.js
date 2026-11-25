// Fjärrkontroll i webben (ui/spatial.js + router.js) i Chromium (Playwright) i TV-läge: bara piltangenter, Enter och
// Escape/Bakåt – aldrig Tab. Startsidan → hylla → titelsidan → Spela → spelarens kontroller → Bakåt till litet fönster →
// Bakåt till listan med fokus på samma kort; sökfältet (markören och att lämna fältet); dialog med fokusfälla; att
// fokus alltid syns på skärmen och att sidan aldrig rullar i sidled; prestanda med många kort.
// Riktiga TV-webbläsare (Tizen, webOS, Fire TV) provas inte – bara deras tangentkoder. Hoppas över utan ffmpeg/Playwright.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
const require = createRequire(import.meta.url);
for (const p of [process.env.PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = p.startsWith('/') ? await import(p) : require(p)); if (chromium) break; } catch {}
}
const skip = !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-spatial-'));
const MEDIA = path.join(ROOT, 'media');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let srv, browser, cookie = '';
const S = {};
const TV = { viewport: { width: 1920, height: 1080 }, userAgent: 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 SMART-TV' };

const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const clip = (file, secs, freq = 440) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ff('-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`,
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '150k', '-c:a', 'libopus', '-b:a', '32k', file);
};
const NAMES = ['Alfa', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'My', 'Ny', 'Xi', 'Omikron', 'Pi', 'Rho', 'Sigma'];

before(async () => {
  if (skip) return;
  const F = path.join(MEDIA, 'Filmer');
  // En riktig fil som kopieras: lång nog att spela en stund (vilket kort som helst kan öppnas)
  clip(path.join(ROOT, 'film.webm'), 30, 300);
  NAMES.forEach((n, i) => { const d = path.join(F, `${n} (${2001 + i})`); fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(ROOT, 'film.webm'), path.join(d, `${n} (${2001 + i}).webm`)); });
  srv = await startServer({ root: ROOT, media: MEDIA });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const t = (name, fn) => test(name, { skip, timeout: 300000 }, fn);

async function newPage(opts = TV) {
  const ctx = await browser.newContext(opts);
  await ctx.addCookies([{ name: 'kt', value: cookie, url: srv.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  return { page, errors, close: () => ctx.close() };
}
async function open(page, hash) {
  await page.goto(srv.base + '/#/' + hash);
  await page.waitForFunction(() => document.querySelector('#main') && !document.querySelector('#main[aria-busy]') && !document.querySelector('#main .sk'), null, { timeout: 30000 });
  await sleep(300);
}
/** Tangent som TV-webbläsare skickar den (Playwright känner inte till Bakåt- och mediaknapparna) */
const send = async (page, init) => { await page.evaluate((i) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { ...i, bubbles: true, cancelable: true })), init); await sleep(80); };
const press = async (page, ...keys) => { for (const k of keys) { await page.keyboard.press(k); await sleep(80); } };
/** Det fokuserade elementet: väljare, kortets id, om det syns helt på skärmen och om sidan rullar i sidled */
const focus = (page) => page.evaluate(() => {
  const a = document.activeElement, r = a?.getBoundingClientRect();
  const c = a?.closest?.('.card');
  return { tag: a?.tagName, id: a?.id || '', cls: a?.className || '', card: c?.dataset.id || null, inPlayer: !!a?.closest?.('#player'),
    play: !!a?.matches?.('[data-play]'), shelfCard: !!a?.matches?.('.shelf .card > .clink'), dialog: !!a?.closest?.('dialog'),
    onScreen: !!r && r.width > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
    ring: !!a && a !== document.body && (a.matches(':focus-visible') || !!a.querySelector?.(':focus-visible')),
    hscroll: document.documentElement.scrollWidth > innerWidth + 1 || scrollX !== 0 };
});
/** Väntar tills villkoret på fokus gäller (svar från servern och ritning tar en stund – ingen snäv tidsgräns) */
async function until(page, pred, what, ms = 15000) {
  const end = Date.now() + ms;
  let f;
  while (Date.now() < end) { f = await focus(page); if (pred(f)) return f; await sleep(100); }
  assert.fail(`${what}: ${JSON.stringify(f)}`);
}

t('förberedelse: konto, filmbibliotek och skanning', async () => {
  let r = await srv.req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } });
  assert.equal(r.status, 200);
  r = await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW } });
  cookie = /kt=([0-9a-f]+)/.exec(r.headers.get('set-cookie'))[1];
  r = await srv.req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (let i = 0; i < 600; i++) { await sleep(500); const s = (await srv.req('/api/scan')).data; if (!s.running && !s.analysis?.running && s.last) break; }
  const items = (await srv.req('/api/libraries/1/items')).data.items;
  assert.equal(items.length, NAMES.length);
  S.lib = 1;
  S.alfa = items.find(i => i.title === 'Alfa').id;
});

t('startsidan → hylla → titelsidan → Spela → kontrollerna → Bakåt till litet fönster → Bakåt till samma kort', async () => {
  const { page, errors, close } = await newPage();
  await open(page, '');
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('tv')), 'TV-läget känns igen på webbläsaren');
  assert.equal((await focus(page)).tag, 'BODY');
  // Första pilen utan fokus: första hyllans första kort (flyttar inte vidare)
  await press(page, 'ArrowDown');
  let f = await until(page, x => x.shelfCard, 'första pilen ger fokus på första hyllans kort');
  assert.ok(f.onScreen && f.ring, 'fokus syns');
  const first = f.card;
  // → två gånger i hyllan
  await press(page, 'ArrowRight', 'ArrowRight');
  f = await until(page, x => x.shelfCard && x.card !== first, '→ i hyllan');
  assert.ok(f.onScreen && f.ring && !f.hscroll, JSON.stringify(f));
  // Ner och upp igen: tillbaka i samma kolumn (föredragen kolumn), aldrig utanför skärmen
  const picked = f.card;
  await press(page, 'ArrowDown');
  f = await focus(page);
  assert.ok(f.onScreen && !f.hscroll, 'ner: ' + JSON.stringify(f));
  await press(page, 'ArrowUp');
  f = await until(page, x => x.card === picked, 'upp igen till samma kort');
  // Enter: titelsidan med fokus på Spela
  await press(page, 'Enter');
  await page.waitForFunction(() => location.hash.startsWith('#/item/'));
  f = await until(page, x => x.play, 'fokus på Spela på titelsidan');
  assert.ok(f.onScreen && f.ring);
  // Spela: fokus i spelaren, Enter pausar (så att kontrollerna inte döljs), pilarna flyttar mellan kontrollerna
  await press(page, 'Enter');
  await page.waitForSelector('#player:not([hidden]):not(.mini) #vid');
  await page.waitForFunction(() => document.querySelector('#vid').currentTime > 0.3, null, { timeout: 30000 });
  f = await until(page, x => x.inPlayer && x.id === 'cplay', 'fokus på Spela/pausa i spelaren');
  await press(page, 'Enter');
  await page.waitForFunction(() => document.querySelector('#vid').paused);
  const t0 = await page.evaluate(() => document.querySelector('#vid').currentTime);
  await press(page, 'ArrowRight');
  f = await until(page, x => x.inPlayer && x.id !== 'cplay' && x.ring, '→ i kontrollraden');
  const right = f.id;
  await press(page, 'ArrowLeft');
  f = await until(page, x => x.id === 'cplay', '← tillbaka till Spela/pausa');
  await press(page, 'ArrowUp');
  f = await until(page, x => x.inPlayer && x.id !== 'cplay', '↑ ovanför kontrollraden (tidslinjen)');
  assert.ok(right && f.id, JSON.stringify(f));
  await press(page, 'ArrowDown');
  await until(page, x => x.inPlayer && x.id !== '' && x.id !== f.id, '↓ tillbaka till kontrollraden');
  // Navigeringen spolade inte
  assert.ok(Math.abs(await page.evaluate(() => document.querySelector('#vid').currentTime) - t0) < 0.5, 'pilarna flyttade fokus i stället för att spola');
  // Dolda kontroller (som efter några sekunder när filmen spelar): ← → spolar och fokus hamnar på tidslinjen
  await page.evaluate(() => document.querySelector('#player').classList.add('idle'));
  await press(page, 'ArrowRight');
  assert.ok(await page.evaluate((t) => document.querySelector('#vid').currentTime > t + 5, t0), 'dolda kontroller: → spolar');
  f = await until(page, x => x.id === 'scrub', 'fokus på tidslinjen efter spolning');
  // Mediaknappar (Playwright saknar dem – som TV-webbläsaren skickar dem): spela/pausa, LG:s Paus (keyCode 19)
  await send(page, { key: 'MediaPlayPause' });
  await page.waitForFunction(() => !document.querySelector('#vid').paused);
  await send(page, { keyCode: 19 });
  await page.waitForFunction(() => document.querySelector('#vid').paused);
  // Bakåt (Escape): litet fönster, fokus tillbaka på Spela
  await press(page, 'Escape');
  await page.waitForSelector('#player.mini');
  f = await until(page, x => x.play, 'fokus tillbaka på Spela efter litet fönster');
  // Bakåt (fjärrkontrollens Bakåt-knapp, Samsung keyCode 10009): förra sidan med fokus på kortet man öppnade
  await sleep(200);
  await send(page, { keyCode: 10009 });
  await page.waitForFunction(() => location.hash === '#/' || location.hash === '');
  f = await until(page, x => x.card === picked, 'fokus tillbaka på samma kort i listan');
  assert.ok(f.onScreen && f.ring && !f.hscroll, JSON.stringify(f));
  assert.ok(await page.evaluate(() => !document.querySelector('#player').hidden && document.querySelector('#player').classList.contains('mini')), 'filmen spelar vidare i litet fönster');
  // Ner till mini-spelaren och Bakåt på startsidan gör ingenting (lämnar inte appen)
  for (let i = 0; i < 8 && !(await focus(page)).inPlayer; i++) await press(page, 'ArrowDown');
  f = await focus(page);
  assert.ok(f.inPlayer && f.onScreen, 'mini-spelaren nås med ↓: ' + JSON.stringify(f));
  await page.evaluate(() => document.querySelector('#cstop')?.click());
  await press(page, 'Escape');
  await sleep(300);
  assert.ok(await page.evaluate(() => location.hash === '#/' || location.hash === ''));
  assert.deepEqual(errors, []);
  await close();
});

t('sökfältet: nås med pilar, ← → flyttar markören, ↓ lämnar fältet', async () => {
  const { page, errors, close } = await newPage();
  await open(page, `lib/${S.lib}`);
  await press(page, 'ArrowDown');
  await until(page, x => !!x.card, 'första kortet i rutnätet');
  // Upp till menyraden och i sidled till sökfältet
  let f;
  for (let i = 0; i < 6; i++) { await press(page, 'ArrowUp'); f = await focus(page); if (!f.card) break; }
  for (let i = 0; i < 15 && f.id !== 'q'; i++) { await press(page, 'ArrowRight'); f = await focus(page); }
  for (let i = 0; i < 25 && f.id !== 'q'; i++) { await press(page, 'ArrowLeft'); f = await focus(page); }
  assert.equal(f.id, 'q', 'sökfältet nås med pilarna');
  await page.keyboard.type('alf');
  const caret = () => page.evaluate(() => document.activeElement.selectionStart);
  await press(page, 'ArrowLeft');
  assert.equal((await focus(page)).id, 'q');
  assert.equal(await caret(), 2, '← flyttar markören');
  await press(page, 'ArrowRight');
  assert.equal(await caret(), 3);
  assert.equal((await focus(page)).id, 'q', '→ vid slutet av texten lämnar fältet bara när markören redan står där');
  // ↓: till träffarna
  await page.waitForFunction(() => location.hash.startsWith('#/search'), null, { timeout: 15000 });
  await page.waitForSelector('#main .clink, #main a.card', { timeout: 15000 });
  await press(page, 'ArrowDown');
  f = await until(page, x => x.id !== 'q' && x.tag !== 'BODY', '↓ lämnar sökfältet');
  assert.ok(f.onScreen && !f.hscroll, JSON.stringify(f));
  assert.deepEqual(errors, []);
  await close();
});

t('dialog: pilarna stannar i dialogen, Escape och Bakåt stänger och fokus kommer tillbaka', async () => {
  const { page, errors, close } = await newPage();
  await open(page, '');
  await press(page, 'ArrowDown');
  const start = await until(page, x => x.shelfCard, 'kort på startsidan');
  for (const back of ['Escape', 'GoBack']) {
    await page.evaluate(() => import('/m/js/ui/dialog.js').then(m => { m.formDialog({ title: 'Prov', okLabel: 'Spara', fields: [{ name: 'a', label: 'Första' }, { name: 'b', label: 'Andra' }] }); }));
    await page.waitForSelector('dialog[open]');
    await until(page, x => x.dialog && x.tag === 'INPUT', 'fokus i dialogens första fält');
    const seen = new Set();
    for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp']) {
      await press(page, k);
      const f = await focus(page);
      assert.ok(f.dialog, `${k}: fokus lämnade dialogen ${JSON.stringify(f)}`);
      seen.add(f.tag + f.cls);
    }
    assert.ok(seen.size >= 3, 'pilarna når fälten och knapparna: ' + [...seen].join(', '));
    if (back === 'Escape') await press(page, 'Escape');
    else await send(page, { key: 'GoBack' });
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await until(page, x => x.card === start.card, `${back}: fokus tillbaka på kortet`);
    assert.ok(await page.evaluate(() => location.hash === '#/' || location.hash === ''), 'dialogen stängdes utan att sidan byttes');
  }
  assert.deepEqual(errors, []);
  await close();
});

t('bakåt från en djuplänk går till startsidan; Backspace utanför fält är Bakåt', async () => {
  const { page, errors, close } = await newPage();
  await open(page, `item/${S.alfa}`);
  await press(page, 'ArrowDown');
  await until(page, x => x.tag !== 'BODY', 'fokus på titelsidan');
  await press(page, 'Backspace');
  await page.waitForFunction(() => location.hash === '#/' || location.hash === '');
  assert.deepEqual(errors, []);
  await close();
});

t('många kort: varje tryck mäter bara kandidaterna nära fokus', async () => {
  const { page, errors, close } = await newPage();
  await open(page, `lib/${S.lib}`);
  await press(page, 'ArrowDown');
  await until(page, x => !!x.card, 'kort i rutnätet');
  // 3000 kort till i rutnätet (samma mall) – räkna getBoundingClientRect per tryck
  const n = await page.evaluate(() => {
    const grid = document.activeElement.closest('.card').parentElement, tpl = grid.querySelector('.card');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 3000; i++) { const c = tpl.cloneNode(true); c.dataset.id = 'x' + i; frag.append(c); }
    grid.append(frag);
    let calls = 0; const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { calls++; return orig.call(this); };
    window.__rects = () => { const c = calls; calls = 0; return c; };
    return grid.querySelectorAll('.card').length;
  });
  assert.ok(n > 3000);
  await page.evaluate(() => window.__rects());
  let max = 0;
  for (const k of ['ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowDown']) {
    await press(page, k);
    max = Math.max(max, await page.evaluate(() => window.__rects()));
  }
  assert.ok(max < 600, `${max} mätningar för ett tryck med ${n} kort`);
  const f = await until(page, x => x.onScreen, 'fokus på skärmen (sidan rullar mjukt dit)');
  assert.ok(!f.hscroll, JSON.stringify(f));
  assert.deepEqual(errors, []);
  await close();
});

// Var fokus står: i sidomenyn, i menyraden, i spelarens inställningspanel
const where = (page) => page.evaluate(() => { const a = document.activeElement; return { id: a?.id || '', rail: !!a?.closest?.('#rail'), top: !!a?.closest?.('#top'), setp: !!a?.closest?.('#setp'), tag: a?.tagName }; });

t('↑ från innehållet går aldrig till sidomenyn (den nås med ←)', async () => {
  const { page, errors, close } = await newPage();
  // Titelsidan: ↑ från Spela ska till menyraden – sidomenyns länkar ligger snett ovanför och närmare
  await open(page, `item/${S.alfa}`);
  await press(page, 'ArrowDown');
  await until(page, x => x.play, 'fokus på Spela');
  await press(page, 'ArrowUp');
  let w = await where(page);
  assert.ok(!w.rail, '↑ från Spela hamnade i sidomenyn: ' + JSON.stringify(w));
  // Startsidan: ett kort i första kolumnen, rullat så att en länk i sidomenyn ligger precis ovanför kortets överkant
  await open(page, '');
  await page.waitForSelector('.shelf .card > .clink');
  for (const y of [300, 390, 480]) {
    await page.evaluate((y) => {
      const c = [...document.querySelectorAll('.shelf .card > .clink')].find(e => e.getBoundingClientRect().left < 200);
      c.focus({ preventScroll: true });
      window.scrollTo({ top: scrollY + c.getBoundingClientRect().top - y, behavior: 'instant' });
    }, y);
    await sleep(100);
    await press(page, 'ArrowUp');
    await sleep(200);
    w = await where(page);
    assert.ok(!w.rail, `↑ från ett kort (överkant ${y} px) hamnade i sidomenyn: ${JSON.stringify(w)}`);
  }
  // ← från första kolumnen når fortfarande sidomenyn
  await page.evaluate(() => [...document.querySelectorAll('.shelf .card > .clink')].find(e => e.getBoundingClientRect().left < 200).focus({ preventScroll: true }));
  await press(page, 'ArrowLeft');
  await sleep(200);
  assert.ok((await where(page)).rail, '← från första kortet går till sidomenyn');
  assert.deepEqual(errors, []);
  await close();
});

t('stjärnorna på titelsidan: ↑ ↓ går vidare utan att sätta betyg, ← → ändrar betyget', async () => {
  const { page, errors, close } = await newPage();
  await open(page, `item/${S.alfa}`);
  await press(page, 'ArrowDown');
  await until(page, x => x.play, 'fokus på Spela');
  await press(page, 'ArrowDown');
  await until(page, x => x.id === 'myrate', '↓ till stjärnorna');
  const rated = () => page.evaluate(() => document.querySelector('#myrate').getAttribute('aria-valuenow'));
  await press(page, 'ArrowDown');
  let f = await until(page, x => x.id !== 'myrate', '↓ lämnar stjärnorna');
  assert.equal(await rated(), '0', '↓ satte inget betyg');
  await press(page, 'ArrowUp');
  await until(page, x => x.id === 'myrate', '↑ tillbaka till stjärnorna');
  // ← utan betyg (reglaget står på sitt minsta värde) ändrar inget; → sätter betyg och ← tar bort det igen
  await press(page, 'ArrowLeft');
  assert.equal(await rated(), '0');
  await page.evaluate(() => document.querySelector('#myrate').focus());
  await press(page, 'ArrowRight');
  await page.waitForFunction(() => +document.querySelector('#myrate').getAttribute('aria-valuenow') > 0);
  assert.equal((await focus(page)).id, 'myrate', '→ ändrar betyget och fokus står kvar');
  await press(page, 'ArrowLeft');
  await page.waitForFunction(() => +document.querySelector('#myrate').getAttribute('aria-valuenow') === 0);
  await press(page, 'ArrowUp');
  f = await until(page, x => x.id !== 'myrate', '↑ lämnar stjärnorna');
  assert.equal(await rated(), '0', '↑ satte inget betyg');
  assert.deepEqual(errors, []);
  await close();
});

t('spelarens inställningar: pilarna når kvalitet och undertexter, och fastnar inte på fällda fält', async () => {
  const { page, errors, close } = await newPage();
  await open(page, `item/${S.alfa}`);
  await press(page, 'ArrowDown');
  await until(page, x => x.play, 'fokus på Spela');
  await press(page, 'Enter');
  await page.waitForSelector('#player:not([hidden]):not(.mini) #vid');
  await until(page, x => x.inPlayer && x.id === 'cplay', 'fokus på Spela/pausa');
  await press(page, 'Enter'); // paus: kontrollerna ligger kvar
  await page.waitForFunction(() => document.querySelector('#vid').paused);
  for (let i = 0; i < 10 && (await focus(page)).id !== 'cset'; i++) await press(page, 'ArrowRight');
  assert.equal((await focus(page)).id, 'cset', '→ når kugghjulet');
  await press(page, 'Enter');
  await page.waitForFunction(() => !document.querySelector('#setp').hidden);
  // "Undertextens utseende" är fälld (details): fälten i den får inte vara mål – förut valdes ett av dem, fokus gick
  // inte att sätta och pilen gjorde ingenting
  const seen = [];
  for (let i = 0; i < 14; i++) {
    await press(page, 'ArrowUp');
    const w = await where(page);
    if (i === 0) assert.ok(w.setp, '↑ från kugghjulet går in i panelen: ' + JSON.stringify(w));
    assert.ok(w.setp, 'fokus stannar i panelen: ' + JSON.stringify(w));
    assert.ok(!/^pst-/.test(w.id), 'fokus på ett fällt fält: ' + w.id);
    seen.push(w.id || w.tag);
  }
  assert.ok(seen.includes('pq'), 'kvaliteten nås med ↑: ' + seen.join(' '));
  assert.ok(seen.includes('ps'), 'undertexterna nås med ↑: ' + seen.join(' '));
  // Kryssrutorna (små rutor längst till vänster i sin rad) hoppas inte över
  assert.ok(seen.includes('pnight') && seen.includes('pdialog'), 'kryssrutorna under Ljud nås med ↑: ' + seen.join(' '));
  await press(page, 'Escape');
  await until(page, x => x.id === 'cset', 'Escape stänger panelen med fokus på kugghjulet');
  await page.evaluate(() => document.querySelector('#cstop')?.click());
  assert.deepEqual(errors, []);
  await close();
});

t('sovtimern med fjärrkontrollen: månen i kontrollraden, val med pilar och Enter, nedtoning, paus och sparad position', async () => {
  const { page, errors, close } = await newPage();
  await open(page, `item/${S.alfa}`);
  await press(page, 'ArrowDown');
  await until(page, x => x.play, 'fokus på Spela');
  await press(page, 'Enter');
  await page.waitForSelector('#player:not([hidden]):not(.mini) #vid');
  await until(page, x => x.inPlayer && x.id === 'cplay', 'fokus på Spela/pausa');
  await press(page, 'Enter'); // paus: kontrollerna ligger kvar
  await page.waitForFunction(() => document.querySelector('#vid').paused);
  for (let i = 0; i < 10 && (await focus(page)).id !== 'psleep'; i++) await press(page, 'ArrowRight');
  assert.equal((await focus(page)).id, 'psleep', '→ når sovtimern');
  await press(page, 'Enter');
  await page.waitForSelector('dialog[open] [data-sl]');
  await until(page, x => x.dialog && x.ring, 'fokus i sovtimerns dialog');
  const sl = () => page.evaluate(() => document.activeElement?.dataset?.sl ?? null);
  assert.equal(await sl(), '15', 'första valet har fokus');
  await press(page, 'ArrowDown');
  assert.equal(await sl(), '30', '↓ till 30 minuter');
  await press(page, 'Enter');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  let f = await until(page, x => x.id === 'psleep', 'fokus tillbaka på sovtimern');
  assert.ok(f.ring && f.onScreen, JSON.stringify(f));
  const btn = () => page.evaluate(() => { const b = document.querySelector('#psleep'); return { text: b.textContent.trim(), aria: b.getAttribute('aria-label'), on: b.classList.contains('on') }; });
  assert.deepEqual(await btn(), { text: '30 min', aria: 'Sovtimer, 30 minuter kvar', on: true });
  // Timern löper ut om tre sekunder (i stället för 30 minuter): ljudet tonas ner och filmen pausas
  const vol0 = await page.evaluate(async () => {
    const v = document.querySelector('#vid'); v.volume = 0.8;
    const m = await import('/m/js/player/sleep.js'); m.SL.until = Date.now() + 3000;
    window.__minVol = 1; v.addEventListener('volumechange', () => { window.__minVol = Math.min(window.__minVol, v.volume); });
    await v.play(); return v.volume;
  });
  assert.equal(vol0, 0.8);
  await page.waitForFunction(() => document.querySelector('#vid').paused, null, { timeout: 10000 });
  const after = await page.evaluate(() => { const v = document.querySelector('#vid'); return { pos: v.currentTime, vol: v.volume, minVol: window.__minVol, opacity: v.style.opacity, toast: document.querySelector('#toast')?.textContent || '', open: !document.querySelector('#player').hidden }; });
  assert.ok(after.minVol < 0.8 * 0.4, `ljudet tonades ner (lägst ${after.minVol})`);
  assert.equal(after.vol, 0.8, 'volymen återställd efter pausen');
  assert.equal(after.opacity, '', 'bilden återställd efter pausen');
  assert.match(after.toast, /Sovtimern pausade uppspelningen/);
  assert.ok(after.open, 'spelaren står kvar pausad');
  assert.deepEqual(await btn(), { text: '', aria: 'Sovtimer', on: false });
  // Positionen sparas där timern pausade (Fortsätt titta; API:t visar den först efter två minuter, så läs databasen)
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(ROOT, 'config', 'braxhn-tv.db'), { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000');
  let pos = 0;
  for (let i = 0; i < 30 && Math.abs(pos - after.pos) > 1.5; i++) { await sleep(200); pos = db.prepare('SELECT position FROM progress WHERE item_id=?').get(S.alfa)?.position || 0; }
  db.close();
  assert.ok(Math.abs(pos - after.pos) <= 1.5, `sparad position ${pos} (pausad vid ${after.pos.toFixed(1)})`);
  // "När filmen tar slut": pausar strax före slutet i stället för att stänga spelaren och gå vidare
  await page.evaluate(async () => { const m = await import('/m/js/player/sleep.js'); m.setSleep('end'); const v = document.querySelector('#vid'); v.currentTime = v.duration - 3; await v.play(); });
  assert.deepEqual(await btn(), { text: 'slut', aria: 'Sovtimer, pausar vid slutet', on: true });
  await page.waitForFunction(() => document.querySelector('#vid').paused, null, { timeout: 10000 });
  const end = await page.evaluate(() => { const v = document.querySelector('#vid'); return { left: v.duration - v.currentTime, ended: v.ended, open: !document.querySelector('#player').hidden }; });
  assert.ok(end.open && !end.ended && end.left < 1.2, JSON.stringify(end));
  await page.evaluate(() => document.querySelector('#cstop')?.click());
  assert.deepEqual(errors, []);
  await close();
});

t('utan TV-läge: pilarna gör inget förrän något saknar fokus, sedan rumslig navigering', async () => {
  const { page, errors, close } = await newPage({ viewport: { width: 1280, height: 800 } });
  await open(page, '');
  assert.ok(await page.evaluate(() => !document.documentElement.classList.contains('tv')));
  await press(page, 'ArrowDown');
  const f = await until(page, x => x.shelfCard, 'första pilen utan fokus ger fokus på ett kort');
  assert.ok(f.onScreen && !f.hscroll);
  assert.deepEqual(errors, []);
  await close();
});
