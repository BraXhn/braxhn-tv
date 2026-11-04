// Upplevd kvalitet i webben: kontrast för färgerna i style.css (WCAG AA), att .small bara ger knappar inre luft,
// och i Chromium (Playwright) vid 375 px, 1280 px och i TV-läge: ingen vågrät rullning, bilder med mått, ingen
// layoutförskjutning när startsidan och biblioteket laddas (sidomenyn gled förut in vid varje start), kortens titlar
// på två rader i stället för klippta efter ett ord, och ett begripligt läge för en titel som inte finns (404).
// Webbläsardelen hoppas över om ffmpeg eller Playwright saknas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, PW } from './media/server.mjs';
import { freePort } from './helpers/port.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(DIR, '..', 'web', 'style.css'), 'utf8');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}

// ---------- kontrast (utan webbläsare) ----------
const tokens = Object.fromEntries([...CSS.match(/:root\{([^}]*)\}/)[1].matchAll(/--([\w-]+):(#[0-9a-f]{3,6})\b/gi)].map(m => [m[1], m[2]]));
const lum = (hex) => {
  const h = hex.length === 4 ? [...hex.slice(1)].map(c => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('kontrast: textfärgerna mot alla bakgrunder minst 4,5:1 (WCAG AA)', () => {
  for (const k of ['bg', 'bg2', 'bg3', 'chrome', 'text', 'dim', 'accent', 'err', 'ok', 'warn']) assert.ok(tokens[k], `--${k} saknas i :root`);
  const bad = [];
  // Brödtext och dämpad text på sidan, panelerna, knapparna och menyraden; statusfärgerna på sidan och panelerna
  for (const fg of ['text', 'dim']) for (const bg of ['bg', 'bg2', 'bg3', 'chrome']) if (ratio(tokens[fg], tokens[bg]) < 4.5) bad.push(`--${fg} på --${bg}: ${ratio(tokens[fg], tokens[bg]).toFixed(2)}`);
  for (const fg of ['accent', 'err', 'ok', 'warn']) for (const bg of ['bg', 'bg2', 'chrome']) if (ratio(tokens[fg], tokens[bg]) < 4.5) bad.push(`--${fg} på --${bg}: ${ratio(tokens[fg], tokens[bg]).toFixed(2)}`);
  // Primärknappen: mörk text på accentfärgen
  const onAccent = /button\.primary\{background:var\(--accent\);border-color:var\(--accent\);color:(#[0-9a-f]{3,6})/i.exec(CSS)?.[1];
  assert.ok(onAccent, 'primärknappens textfärg hittades inte');
  if (ratio(onAccent, tokens.accent) < 4.5) bad.push(`primärknappen: ${ratio(onAccent, tokens.accent).toFixed(2)}`);
  assert.deepEqual(bad, []);
});

test('.small ger bara knappar inre luft (text med .small ligger i linje med texten runt)', () => {
  // En regel med bara .small som väljare och padding flyttade 450 textrader 10 px åt höger (paneler, kortens rader, mini-spelaren)
  const rules = [...CSS.matchAll(/(^|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter(m => /padding/.test(m[3]));
  const bare = rules.filter(m => m[2].split(',').some(s => s.trim() === '.small'));
  assert.deepEqual(bare.map(m => m[2].trim()), []);
});

test('sidomenyn glider bara när användaren fäller ut den (ingen övergång på main vid start)', () => {
  const tr = [...CSS.matchAll(/([^{}]+)\{[^}]*transition:[^}]*margin-left[^}]*\}/g)].map(m => m[1].trim());
  assert.ok(tr.length, 'övergången för sidomenyn saknas');
  for (const sel of tr) for (const s of sel.split(',')) if (/\bmain\b/.test(s)) assert.match(s, /rail-anim/, `övergång på main utan html.rail-anim: ${s}`);
});

// ---------- i webbläsaren ----------
const skip = !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-quality-'));
const MEDIA = path.join(ROOT, 'media');
const LONG = 'Midsommarfirandet hos mormor och morfar i Dalarna';
let srv, browser, cookie = '';
const S = {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clip = (file, secs) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`,
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', file]);
};

before(async () => {
  if (skip) return;
  for (const n of ['Alfa (2020)', 'Beta (2021)', `${LONG} (2023)`]) clip(path.join(MEDIA, 'Filmer', n, n + '.webm'), 3);
  clip(path.join(MEDIA, 'Serier', 'Serien', 'Season 1', 'Serien S01E01.webm'), 3);
  srv = await startServer({ root: ROOT, media: MEDIA, port: await freePort(), env: { TMDB_API_KEY: '', WATCH_FILES: '0' } });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const t = (name, fn) => test(name, { skip, timeout: 300000 }, fn);
const MODES = {
  phone: { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true },
  desktop: { viewport: { width: 1280, height: 800 } },
  tv: { viewport: { width: 1920, height: 1080 }, userAgent: 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 SMART-TV' }
};
async function page(mode) {
  const ctx = await browser.newContext(MODES[mode]);
  await ctx.addCookies([{ name: 'kt', value: cookie, url: srv.base }]);
  // Layoutförskjutningar (CLS) från första ritningen, utan de som följer på något användaren gjort
  await ctx.addInitScript(() => {
    window.__cls = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls.push({ v: e.value, src: (e.sources || []).map(s => s.node?.id || s.node?.className || s.node?.nodeName).join(' ') }); }).observe({ type: 'layout-shift', buffered: true }); } catch {}
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  return { p, errors, close: () => ctx.close() };
}
async function open(p, hash) {
  await p.goto(srv.base + '/#/' + hash);
  await p.waitForFunction(() => document.querySelector('#main') && !document.querySelector('#main[aria-busy]') && !document.querySelector('#main .sk'), null, { timeout: 15000 });
  await p.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 5000 }).catch(() => {});
  await sleep(600);
}

t('förberedelse: konto, bibliotek och skanning', async () => {
  let r = await srv.req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } });
  assert.equal(r.status, 200);
  r = await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW } });
  cookie = /kt=([0-9a-f]+)/.exec(r.headers.get('set-cookie'))[1];
  for (const [name, type, p] of [['Filmer', 'movie', 'Filmer'], ['Serier', 'show', 'Serier']]) {
    r = await srv.req('/api/libraries', { method: 'POST', body: { name, type, path: path.join(MEDIA, p) } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  for (let i = 0; i < 240; i++) { await sleep(500); const s = (await srv.req('/api/scan')).data; if (!s.running && !s.analysis?.running && s.last) break; }
  const libs = (await srv.req('/api/libraries')).data;
  for (const l of libs) S[l.type] = l.id;
  const items = (await srv.req(`/api/libraries/${S.movie}/items`)).data.items;
  S.alfa = items.find(i => i.title === 'Alfa').id;
  S.long = items.find(i => i.title.startsWith('Midsommar'))?.id;
  assert.ok(S.alfa && S.long, JSON.stringify(items.map(i => i.title)));
});

for (const mode of ['phone', 'desktop', 'tv']) {
  t(`ingen vågrät rullning, bilder med mått och ingen layoutförskjutning (${mode})`, async () => {
    const { p, errors, close } = await page(mode);
    const found = [];
    for (const hash of ['', `lib/${S.movie}`, `lib/${S.show}`, `item/${S.alfa}`, 'search?q=alfa', 'account', 'admin']) {
      await open(p, hash);
      const r = await p.evaluate(() => ({
        wide: document.scrollingElement.scrollWidth > innerWidth + 1 ? document.scrollingElement.scrollWidth : 0,
        // Bilder utan width/height ger en hoppande sida när de laddas (den som saknar mått i CSS också)
        noDim: [...document.querySelectorAll('#main img')].filter(i => !(i.getAttribute('width') && i.getAttribute('height'))).map(i => i.className || i.getAttribute('src')),
        cls: window.__cls.reduce((a, e) => a + e.v, 0), shifts: window.__cls.filter(e => e.v > 0.001).map(e => e.src)
      }));
      if (r.wide) found.push(`#/${hash}: sidan är ${r.wide} px bred`);
      if (r.noDim.length) found.push(`#/${hash}: bilder utan width/height: ${r.noDim.join(', ')}`);
      // Startsidan och biblioteket (laddas direkt, skelettet i samma form): i stort sett ingen förskjutning
      if ((hash === '' || hash.startsWith('lib/')) && r.cls > 0.02) found.push(`#/${hash}: layoutförskjutning ${r.cls.toFixed(3)} (${r.shifts.join(' | ')})`);
    }
    await close();
    assert.deepEqual(found, []);
    assert.deepEqual(errors, []);
  });
}

t('kortens titlar: lång titel på två rader, inte klippt efter första ordet', async () => {
  const { p, close } = await page('desktop');
  await open(p, `lib/${S.movie}`);
  const r = await p.evaluate((id) => {
    const el = document.querySelector(`.card[data-id="${id}"] .t`), cs = getComputedStyle(el);
    return { lines: Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight)), clamp: cs.webkitLineClamp, ws: cs.whiteSpace };
  }, S.long);
  await close();
  assert.equal(r.lines, 2, JSON.stringify(r));
  assert.equal(r.clamp, '2');
});

t('en titel som inte finns: "Hittades inte" med väg vidare och sidrubrik, inget "Försök igen"', async () => {
  for (const lang of ['sv', 'en']) {
    assert.equal((await srv.req('/api/me/lang', { method: 'PUT', body: { lang } })).status, 200);
    const { p, errors, close } = await page('desktop');
    await p.goto(srv.base + '/#/item/999999');
    await p.waitForSelector('#main .state.error');
    const r = await p.evaluate(() => ({ h1: !!document.querySelector('#main h1'), h2: document.querySelector('#main .state h2')?.textContent,
      home: document.querySelector('#main .state a[href="#/"]')?.textContent, retry: !!document.querySelector('#main #retry'), text: document.querySelector('#main .state p')?.textContent }));
    await close();
    assert.equal(r.h1, true, 'sidan saknar h1');
    assert.equal(r.retry, false);
    assert.equal(r.h2, lang === 'sv' ? 'Hittades inte' : 'Not found');
    assert.equal(r.home, lang === 'sv' ? 'Till startsidan' : 'To the start page');
    assert.doesNotMatch(r.text, /^(Finns inte|Does not exist|Fel 404|Error 404)$/);
    assert.deepEqual(errors, []);
  }
  await srv.req('/api/me/lang', { method: 'PUT', body: { lang: 'sv' } });
});

t('TV-läge: större text och kort än på datorn (tre meters avstånd)', async () => {
  const sizes = {};
  for (const mode of ['desktop', 'tv']) {
    const { p, close } = await page(mode);
    await open(p, `lib/${S.movie}`);
    sizes[mode] = await p.evaluate(() => ({ font: parseFloat(getComputedStyle(document.querySelector('.card .t')).fontSize), card: document.querySelector('.card').getBoundingClientRect().width }));
    await close();
  }
  assert.ok(sizes.tv.font >= sizes.desktop.font * 1.2, JSON.stringify(sizes));
  assert.ok(sizes.tv.card >= sizes.desktop.card * 1.25, JSON.stringify(sizes));
});
