// Tillgänglighet (WCAG 2.2 AA) i Chromium (Playwright): granskningsskriptet i test/helpers/a11y-audit.js körs över
// alla vyer vid 375 och 1280 px och i TV-läge (1920 × 1080, TV-webbläsare, bara tangentbord), med textstorlek 200 %,
// forced-colors och minska rörelse. Dessutom tangentbordsflöden: fokusordning och synlig fokus (Tab genom sidan),
// dialogernas fokusfälla och återställning, kortmenyn, spelaren med kortkommandon och ?-dialogen, TV-guidens rutnät,
// fotobiblioteket, filterpanelen och Nedladdat. Riktiga skärmläsare provas inte (bara rollerna och namnen de läser).
// Hoppas över om ffmpeg eller Playwright saknas. A11Y_REPORT=fil skriver alla fynd som JSON (felsökning).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';
import { auditPage, focusInfo } from './helpers/a11y-audit.js';
import { epub, cbz, png, paragraphs } from './helpers/ebook-fixtures.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const skip = !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-a11y-'));
const MEDIA = path.join(ROOT, 'media');
const SHOTS = process.env.SHOTS || '';
const REPORT = process.env.A11Y_REPORT || '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let srv, browser, iptv, cookie = '';
const S = {};
const report = {};

const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
// Chromium (Playwright) saknar H.264/AAC – därför WebM (VP8/Opus), som spelas direkt
const clip = (file, secs, freq = 440) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ff('-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`,
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', file);
};
const xt = (t) => new Date(t * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

before(async () => {
  if (skip) return;
  const F = path.join(MEDIA, 'Filmer');
  // Filmen: svenskt ljud, svensk syntolkning (disposition visual_impaired) och en extern undertext
  fs.mkdirSync(path.join(F, 'Alfa (2020)'), { recursive: true });
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=900:duration=20',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus',
    '-metadata:s:a:0', 'language=swe', '-metadata:s:a:1', 'language=swe', '-metadata:s:a:1', 'title=Syntolkning', '-disposition:a:1', 'visual_impaired',
    path.join(F, 'Alfa (2020)', 'Alfa (2020).webm'));
  fs.writeFileSync(path.join(F, 'Alfa (2020)', 'Alfa (2020).sv.srt'), '1\n00:00:01,000 --> 00:00:09,000\nHej och välkommen\n');
  clip(path.join(F, 'Beta (2021)', 'Beta (2021).webm'), 4, 500);
  const se = path.join(MEDIA, 'Serier', 'Serien', 'Season 1');
  clip(path.join(se, 'Serien S01E01.webm'), 4, 600);
  clip(path.join(se, 'Serien S01E02.webm'), 4, 700);
  const alb = path.join(MEDIA, 'Musik', 'Artisten', 'Albumet'); fs.mkdirSync(alb, { recursive: true });
  for (const n of [1, 2]) ff('-f', 'lavfi', '-i', `sine=frequency=${300 * n}:duration=8`, '-metadata', `title=Låt ${n}`, '-metadata', 'artist=Artisten', '-metadata', 'album=Albumet',
    '-metadata', `track=${n}`, path.join(alb, `0${n} Låt ${n}.mp3`));
  const bok = path.join(MEDIA, 'Ljudböcker', 'Författaren', 'Boken'); fs.mkdirSync(bok, { recursive: true });
  ff('-f', 'lavfi', '-i', 'sine=frequency=250:duration=10', '-metadata', 'title=Del 1', '-metadata', 'album=Boken', '-metadata', 'artist=Författaren', path.join(bok, '01.mp3'));
  const pics = path.join(MEDIA, 'Foton', '2024', 'Sommar'); fs.mkdirSync(pics, { recursive: true });
  for (const [n, c] of [[1, 'red'], [2, 'blue'], [3, 'green']]) ff('-f', 'lavfi', '-i', `color=c=${c}:s=320x240`, '-frames:v', '1', path.join(pics, `bild${n}.jpg`));
  // E-böcker: en EPUB med omslag och en serietidning
  const eb = path.join(MEDIA, 'E-böcker', 'Serien'); fs.mkdirSync(eb, { recursive: true });
  fs.writeFileSync(path.join(MEDIA, 'E-böcker', 'Boken.epub'), epub({ title: 'Boken', author: 'Författaren', cover: png(120, 180), chapters: [{ title: 'Början', body: paragraphs(20) }, { title: 'Slutet', body: paragraphs(3) }] }));
  fs.writeFileSync(path.join(eb, 'Serien 001.cbz'), cbz({ pages: 4, w: 120, h: 180, info: { Series: 'Serien', Number: '1' } }));
  // IPTV: en M3U-lista med guide från en liten lokal server
  const T0 = Math.floor(Date.now() / 1000 / 1800) * 1800;
  const guide = `<tv><channel id="k1"><display-name>Kanal Ett</display-name></channel><channel id="k2"><display-name>Kanal Två</display-name></channel>
    ${[-1, 0, 1, 2].map(h => `<programme start="${xt(T0 + h * 3600)}" stop="${xt(T0 + (h + 1) * 3600)}" channel="k1"><title>Program ${h + 2}</title><desc>Beskrivning</desc></programme>
    <programme start="${xt(T0 + h * 3600)}" stop="${xt(T0 + (h + 1) * 3600)}" channel="k2"><title>Andra ${h + 2}</title></programme>`).join('')}</tv>`;
  iptv = http.createServer((q, r) => {
    if (q.url === '/list.m3u') r.end(`#EXTM3U url-tvg="http://127.0.0.1:${iptv.address().port}/guide.xml"\n#EXTINF:-1 tvg-id="k1" tvg-chno="1" group-title="Nyheter",Kanal Ett\nhttp://127.0.0.1:${iptv.address().port}/1.ts\n#EXTINF:-1 tvg-id="k2" tvg-chno="2" group-title="Nöje",Kanal Två\nhttp://127.0.0.1:${iptv.address().port}/2.ts\n`);
    else if (q.url === '/guide.xml') r.end(guide);
    else { r.writeHead(404); r.end(); }
  });
  await new Promise(r => iptv.listen(0, '127.0.0.1', r));
  srv = await startServer({ root: ROOT, media: MEDIA, env: { TMDB_API_KEY: '', WATCH_FILES: '0', DVR_DIR: path.join(ROOT, 'rec') } });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.stop(); iptv?.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

let last = null;
const t = (name, fn) => test(name, { skip, timeout: 600000 }, async () => {
  try { await fn(); }
  catch (e) {
    if (last && !last.page.isClosed()) {
      const f = path.join(SHOTS || os.tmpdir(), `a11y-fel-${name.replace(/[^a-zåäö0-9]+/gi, '-').slice(0, 40)}.png`);
      await last.page.screenshot({ path: f }).catch(() => {});
      e.message += `\nSkärmdump: ${f}\nKonsolfel: ${JSON.stringify(last.errors)}`;
    }
    throw e;
  }
});

const MODES = {
  phone: { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true },
  desktop: { viewport: { width: 1280, height: 800 } },
  // TV-läge: stor skärm på avstånd, TV-webbläsare utan mus – allt via piltangenter/Tab och Enter
  tv: { viewport: { width: 1920, height: 1080 }, userAgent: 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 SMART-TV' }
};
async function newPage(mode = 'desktop', { media, storage } = {}) {
  const ctx = await browser.newContext({ ...MODES[mode], ...(media ? { reducedMotion: media.reducedMotion, forcedColors: media.forcedColors, colorScheme: 'dark' } : {}) });
  await ctx.addCookies([{ name: 'kt', value: cookie, url: srv.base }]);
  if (storage) await ctx.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  last = { page, errors };
  return { page, errors, close: () => ctx.close() };
}
/** Öppnar en vy och väntar tills den är ritad (inget aria-busy, inga anrop i luften) */
async function open(page, hash) {
  await page.goto(srv.base + '/#/' + hash);
  await page.waitForFunction(() => document.querySelector('#main') && !document.querySelector('#main[aria-busy]') && !document.querySelector('#main .sk'), null, { timeout: 15000 }).catch(() => {});
  // Ingen networkidle: "Spela på…" håller en SSE-anslutning öppen. Vänta tills inga bilder/anrop laddas.
  await page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 5000 }).catch(() => {});
  await sleep(250);
  await settled(page);
}
// Inga pågående in-animationer (dialogens tona-in ger annars för låg kontrast mitt i)
const settled = (page) => page.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))), new Promise(r => setTimeout(r, 2000))]));
const fmt = (list) => list.map(f => `  [${f.rule}] ${f.view ? f.view + ': ' : ''}${f.sel} – ${f.msg}`).join('\n');

t('förberedelse: konto, bibliotek, IPTV och skanning', async () => {
  let r = await srv.req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } });
  assert.equal(r.status, 200);
  r = await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW } });
  cookie = /kt=([0-9a-f]+)/.exec(r.headers.get('set-cookie'))[1];
  for (const [name, type, p] of [['Filmer', 'movie', 'Filmer'], ['Serier', 'show', 'Serier'], ['Musik', 'music', 'Musik'], ['Ljudböcker', 'audiobook', 'Ljudböcker'], ['Foton', 'photo', 'Foton'], ['E-böcker', 'ebook', 'E-böcker']]) {
    r = await srv.req('/api/libraries', { method: 'POST', body: { name, type, path: path.join(MEDIA, p) } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  r = await srv.req('/api/iptv/sources', { method: 'POST', body: { type: 'm3u', url: `http://127.0.0.1:${iptv.address().port}/list.m3u`, name: 'Lista' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (let i = 0; i < 240; i++) { await sleep(500); const s = (await srv.req('/api/scan')).data; if (!s.running && !s.analysis?.running && s.last) break; }
  const libs = (await srv.req('/api/libraries')).data;
  for (const l of libs) S[l.type] = l.id;
  const items = (await srv.req(`/api/libraries/${S.movie}/items`)).data.items;
  S.alfa = items.find(i => i.title === 'Alfa').id;
  S.show = (await srv.req(`/api/libraries/${S.show}/items`)).data.items[0].id;
  const albums = (await srv.req(`/api/music/${S.music}/albums`)).data;
  S.album = (albums.albums || albums.items || albums)[0]?.id;
  const books = (await srv.req(`/api/audiobooks/${S.audiobook}`)).data;
  S.book = (books.books || books.items || books)[0]?.id;
  const ebs = (await srv.req(`/api/ebooks/lib/${S.ebook}`)).data.books;
  S.epub = ebs.find(b => b.format === 'epub')?.id; S.comic = ebs.find(b => b.format === 'cbz')?.id;
  assert.ok(S.alfa && S.show && S.epub && S.comic, JSON.stringify(S));
  // Kvällsvalet: en lobby där administratören är värd (filterformuläret, koden och QR-koden)
  S.tonight = (await srv.req('/api/tonight', { method: 'POST', body: {} })).data.id;
  assert.ok(S.tonight);
});

// Vyerna som granskas (hash → namn)
const VIEWS = () => [
  ['', 'Hem'], [`lib/${S.movie}`, 'Filmer'], [`lib/${S.show}`, 'Serier'], [`item/${S.alfa}`, 'Film'], [`item/${S.show}`, 'Serie'],
  [`music/${S.music}`, 'Musik'], ...(S.album ? [[`album/${S.album}`, 'Album']] : []), [`books/${S.audiobook}`, 'Ljudböcker'], ...(S.book ? [[`book/${S.book}`, 'Ljudbok']] : []),
  ['podcasts', 'Poddar'], [`photos/${S.photo}`, 'Foton'], [`ebooks/${S.ebook}`, 'E-böcker'], [`ebook/${S.epub}`, 'E-bok'], [`read/${S.epub}`, 'Läsaren (EPUB)'], [`read/${S.comic}`, 'Läsaren (serietidning)'], ['search?q=alfa', 'Sök'], ['watchlist', 'Min lista'], ['calendar', 'Kommande'],
  ['collections', 'Samlingar'], ['account', 'Mitt konto'], ['admin', 'Administration'], ['stats', 'Statistik'], ['wrapped', 'Årssammanfattning'],
  ['requests', 'Önskningar'], ['history', 'Historik'], ['playstats', 'Tittarstatistik'], ['webhooks', 'Webhooks'], ['downloads', 'Nedladdat'],
  ['live', 'Live-TV'], ['epg', 'TV-guide'], ['vod', 'VOD'], ['iptvadmin', 'IPTV'], ['dvr', 'Inspelningar'], ['health', 'Hälsokontroll'], ['shrink', 'Diskrådgivaren'],
  ['quickconnect', 'Godkänn TV'], ['streaming', 'Strömmande'], ['setup', 'Installation'], ['tonight', 'Kvällsvalet'], [`tonight/${S.tonight}`, 'Kvällsvalet: lobby'], ['vocab', 'Ordlista']
];

/** Tab genom sidan: varje stopp ska synas på skärmen, ha synlig fokus och inte ligga i något dolt */
async function tabWalk(page, max = 60) {
  const out = [];
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.mouse.move(0, 0).catch(() => {});
  const seen = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    // En bildruta: med minska rörelse är övergångarna 0,01 ms men börjar ändå först i nästa bildruta
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const f = await page.evaluate(focusInfo);
    if (f.body) break;
    if (seen.includes(f.sel + f.x + ',' + f.y)) break;
    seen.push(f.sel + f.x + ',' + f.y);
    if (f.hidden) out.push({ rule: 'fokusordning', sel: f.sel, msg: 'fokus i dolt/inert innehåll' });
    else if (!f.onScreen) out.push({ rule: 'fokusordning', sel: f.sel, msg: 'fokus utanför skärmen' });
    else if (!f.ring) out.push({ rule: 'fokusmarkering', sel: f.sel, msg: 'ingen synlig fokusmarkering' });
  }
  return out;
}

for (const mode of ['phone', 'desktop', 'tv']) {
  t(`granskning av alla vyer (${mode})`, async () => {
    const { page, errors, close } = await newPage(mode);
    const found = [];
    for (const [hash, name] of VIEWS()) {
      await open(page, hash);
      const f = await page.evaluate(auditPage, {});
      if (mode !== 'phone') f.push(...await tabWalk(page, mode === 'tv' ? 80 : 50));
      for (const x of f) found.push({ ...x, view: name });
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `a11y-${mode}-${name}.png`) });
    }
    report[mode] = found;
    if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
    await close();
    assert.deepEqual(found, [], `${found.length} fynd (${mode}):\n${fmt(found)}`);
    assert.deepEqual(errors, []);
  });
}

t('inloggningssidan och profilval', async () => {
  const ctx = await browser.newContext(MODES.desktop);
  const page = await ctx.newPage();
  await page.goto(srv.base + '/#/login');
  await page.waitForSelector('#main input');
  const f = await page.evaluate(auditPage, {});
  await ctx.close();
  assert.deepEqual(f, [], fmt(f));
});

// ---------- tangentbordsflöden ----------
const active = (page) => page.evaluate(focusInfo);
const press = async (page, ...keys) => { for (const k of keys) { await page.keyboard.press(k); await sleep(60); } };

t('dialoger: ?-dialogen har fokusfälla, Escape stänger och fokus kommer tillbaka', async () => {
  const { page, errors, close } = await newPage('desktop');
  await open(page, `lib/${S.movie}`);
  await page.focus('.card a[href^="#/item/"]');
  const before = (await active(page)).sel;
  await press(page, '?');
  await page.waitForSelector('dialog[open]');
  await settled(page);
  const d = await page.evaluate(auditPage, { scope: 'dialog[open]' });
  assert.deepEqual(d, [], fmt(d));
  assert.ok((await active(page)).inDialog, 'fokus i dialogen');
  for (let i = 0; i < 12; i++) { await press(page, 'Tab'); assert.ok((await active(page)).inDialog, 'Tab lämnade dialogen'); }
  for (let i = 0; i < 4; i++) { await press(page, 'Shift+Tab'); assert.ok((await active(page)).inDialog, 'Shift+Tab lämnade dialogen'); }
  assert.match(await page.textContent('dialog[open]'), /Undertexter av\/på/);
  assert.match(await page.textContent('dialog[open]'), /TV-guiden/);
  await press(page, 'Escape');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  assert.equal((await active(page)).sel, before);
  assert.deepEqual(errors, []);
  await close();
});

t('ljudböckernas dialoger: kapitelredigeraren, RSS-flödet och lyssningsstatistiken', async () => {
  const { page, errors, close } = await newPage('desktop');
  const found = [];
  const audit = async (name, opener, view) => {
    await open(page, view);
    await page.click(opener);
    await page.waitForSelector('dialog[open]');
    await page.waitForFunction(() => !document.querySelector('dialog[open] [aria-busy="true"]'));
    await settled(page);
    for (const x of await page.evaluate(auditPage, { scope: 'dialog[open]' })) found.push({ ...x, view: name });
    assert.ok((await active(page)).inDialog, `fokus i dialogen (${name})`);
    await press(page, 'Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
  };
  await audit('Kapitelredigeraren', '#bchap', `book/${S.book}`);
  await audit('RSS-flöde', '#bfeed', `book/${S.book}`);
  await audit('Lyssningsstatistik', '#bstats', `books/${S.audiobook}`);
  assert.deepEqual(found, [], fmt(found));
  assert.deepEqual(errors, []);
  await close();
});

t('kortmenyn: öppnas med Shift+F10, piltangenter, Escape lämnar fokus på kortet', async () => {
  const { page, errors, close } = await newPage('tv');
  await open(page, `lib/${S.movie}`);
  await page.focus('.card a[href^="#/item/"]');
  const card = (await active(page)).sel;
  await press(page, 'Shift+F10');
  await page.waitForSelector('[role=menu]');
  await settled(page);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'menuitem');
  const txt = () => page.evaluate(() => document.activeElement.textContent);
  const first = await txt();
  await press(page, 'ArrowDown');
  assert.notEqual(await txt(), first);
  const m = await page.evaluate(auditPage, { scope: '[role=menu]' });
  assert.deepEqual(m, [], fmt(m));
  await press(page, 'Escape');
  assert.equal(await page.$('[role=menu]'), null);
  assert.equal((await active(page)).sel, card);
  assert.deepEqual(errors, []);
  await close();
});

t('spelaren: fokus i spelaren, sidan bakom inert, kortkommandon, tidslinje som reglage och uppläst läge', async () => {
  for (const mode of ['desktop', 'tv']) {
    const { page, errors, close } = await newPage(mode);
    await open(page, `item/${S.alfa}`);
    await page.focus('[data-play]');
    await press(page, 'Enter');
    await page.waitForSelector('#player:not([hidden]) #vid');
    await page.waitForFunction(() => document.querySelector('#vid').currentTime > 0.3, null, { timeout: 20000 });
    await sleep(100);
    assert.ok(await page.evaluate(() => document.querySelector('#player').contains(document.activeElement)), 'fokus i spelaren');
    assert.ok(await page.evaluate(() => document.querySelector('#main').inert && document.querySelector('#top').inert), 'sidan bakom är inert');
    const a = await page.evaluate(auditPage, { scope: '#player', contrast: false, target: false });
    assert.deepEqual(a, [], fmt(a));
    // Språkinlärningen (⚙): verktygsraden granskas också, och a/d/r/x/p/w går till läget
    await page.evaluate(() => { const c = document.querySelector('#plearn'); c.checked = true; c.dispatchEvent(new Event('change')); });
    await page.waitForSelector('#plearnbar:not([hidden]) #lrep');
    const la = await page.evaluate(auditPage, { scope: '#player', contrast: false, target: false });
    assert.deepEqual(la, [], fmt(la));
    await page.evaluate(() => { const c = document.querySelector('#plearn'); c.checked = false; c.dispatchEvent(new Event('change')); });
    await page.waitForSelector('#plearnbar[hidden]', { state: 'attached' });
    await press(page, 'k');
    await page.waitForFunction(() => document.querySelector('#vid').paused);
    await page.waitForFunction(() => document.querySelector('#pstate').textContent === 'Pausad');
    await press(page, 'ArrowUp');
    await page.waitForFunction(() => /^Volym \d+ %$/.test(document.querySelector('#pstate').textContent));
    await press(page, 'c');
    await page.waitForFunction(() => /^Undertexter/.test(document.querySelector('#pstate').textContent));
    await page.focus('#scrub');
    await press(page, 'End');
    assert.ok(+await page.getAttribute('#scrub', 'aria-valuenow') >= 15, 'End på tidslinjen');
    assert.match(await page.getAttribute('#scrub', 'aria-valuetext'), /^\d+:\d\d av \d+:\d\d$/);
    await press(page, 'Home');
    assert.ok(+await page.getAttribute('#scrub', 'aria-valuenow') <= 1);
    await press(page, '?');
    await page.waitForSelector('dialog[open]');
    await press(page, 'Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    // Escape: litet fönster – sidan går att nå igen och fokus tillbaka på Spela-knappen
    await page.focus('#cplay');
    await press(page, 'Escape');
    await page.waitForSelector('#player.mini');
    assert.ok(await page.evaluate(() => !document.querySelector('#main').inert));
    assert.ok(await page.evaluate(() => !!document.activeElement?.matches('[data-play]')), 'fokus tillbaka på Spela');
    assert.deepEqual(errors, []);
    await close();
  }
});

t('syntolkning: profilens val ger ljudbeskrivningen som förvalt ljudspår', async () => {
  const before = (await srv.req(`/api/items/${S.alfa}`)).data;
  const vi = before.audio.find(a => /syntolk/i.test(a.title || '') || a.vi);
  assert.ok(vi, JSON.stringify(before.audio));
  assert.notEqual(before.defaultAudio, vi.index);
  assert.equal((await srv.req('/api/me/playback-prefs', { method: 'PUT', body: { audioDesc: true } })).status, 200);
  assert.equal((await srv.req(`/api/items/${S.alfa}`)).data.defaultAudio, vi.index);
  const { page, close } = await newPage('desktop');
  await open(page, 'account');
  await page.waitForSelector('#ppad');
  assert.equal(await page.isChecked('#ppad'), true);
  await close();
  assert.equal((await srv.req('/api/me/playback-prefs', { method: 'PUT', body: { audioDesc: false } })).status, 200);
});

t('TV-guiden och fotobiblioteket: piltangenter i rutnäten', async () => {
  const { page, errors, close } = await newPage('tv');
  await open(page, 'epg');
  await page.waitForSelector('.epgp');
  await page.focus('.epgp[tabindex="0"], .epgch[tabindex="0"]');
  const a = await active(page);
  await press(page, 'ArrowRight');
  const b = await active(page);
  assert.notEqual(a.sel + a.x + a.y, b.sel + b.x + b.y, 'pil höger flyttar i guiden');
  await press(page, 'ArrowDown');
  assert.ok((await active(page)).ring);
  await open(page, `photos/${S.photo}`);
  await page.waitForSelector('.ph-t');
  await page.focus('.ph-t');
  const p1 = await active(page);
  await press(page, 'ArrowRight');
  const p2 = await active(page);
  assert.notEqual(p1.x + ',' + p1.y, p2.x + ',' + p2.y, 'pil höger flyttar bland fotona');
  await press(page, 'Enter');
  await sleep(400);
  await press(page, 'Escape');
  await sleep(300);
  assert.ok(!(await active(page)).body, 'fokus tillbaka efter visaren');
  assert.deepEqual(errors, []);
  await close();
});

t('filterpanelen: öppnas och stängs med tangentbordet, fokus tillbaka på Filter', async () => {
  const { page, errors, close } = await newPage('desktop');
  await open(page, `lib/${S.movie}`);
  await page.focus('#fbtn');
  await press(page, 'Enter');
  await page.waitForSelector('.fpanel');
  await settled(page);
  const f = await page.evaluate(auditPage, { scope: '.fpanel' });
  assert.deepEqual(f, [], fmt(f));
  assert.ok(await page.evaluate(() => !!document.activeElement.closest('dialog, .pop, .fpanel')), 'fokus i panelen');
  await press(page, 'Escape');
  await sleep(200);
  assert.equal((await active(page)).sel, '#fbtn');
  assert.deepEqual(errors, []);
  await close();
});

t('textstorlek 200 %: inget klipps och sidan blir inte bredare än skärmen', async () => {
  const found = [];
  for (const mode of ['phone', 'desktop']) {
    const { page, close } = await newPage(mode, { storage: { 'braxhn-tv.a11y': JSON.stringify({ text: 200 }) } });
    for (const [hash, name] of VIEWS()) {
      await open(page, hash);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '32px');
      const f = await page.evaluate(auditPage, { clip: true, contrast: false, target: false });
      for (const x of f) if (/klippt|omflytning/.test(x.rule)) found.push({ ...x, view: `${name} (${mode})` });
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `a11y-text200-${mode}-${name}.png`) });
    }
    await close();
  }
  report.text200 = found;
  if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
  assert.deepEqual(found, [], fmt(found));
});

t('forced-colors och minska rörelse: synlig fokus, inga animationer', async () => {
  for (const media of [{ forcedColors: 'active' }, { reducedMotion: 'reduce' }]) {
    const { page, errors, close } = await newPage('desktop', { media });
    await open(page, '');
    const w = await tabWalk(page, 30);
    assert.deepEqual(w, [], fmt(w));
    const anim = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && (a.effect?.getComputedTiming().duration || 0) > 50).length);
    if (media.reducedMotion) assert.equal(anim, 0);
    assert.deepEqual(errors, []);
    await close();
  }
  // Valen i Mitt konto gör samma sak utan systemets inställning
  const { page, close } = await newPage('desktop', { storage: { 'braxhn-tv.a11y': JSON.stringify({ motion: 'reduce', contrast: 'more' }) } });
  await open(page, '');
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('reduce-motion') && document.documentElement.classList.contains('more-contrast')));
  await open(page, 'account');
  await page.selectOption('#a11ytext', '150');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '24px');
  await close();
});

test('textstorlek: style.css och vyerna anger font-size i rem/em, inte px (undertexterna undantagna)', () => {
  const web = path.join(import.meta.dirname, '..', 'web');
  const files = [path.join(web, 'style.css'), ...fs.readdirSync(path.join(web, 'js'), { recursive: true }).filter(f => f.endsWith('.js')).map(f => path.join(web, 'js', f))];
  const bad = [];
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/font-size:\s*([^;}"'`]+)/g)) if (/\dpx/.test(m[1]) && !/subscale/.test(m[1])) bad.push(`${path.relative(web, f)}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});
