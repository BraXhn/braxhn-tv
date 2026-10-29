// Engelska i webbklienten: katalogen web/i18n/en.js, t() i web/js/core.js, språk per profil och sidans språk från
// servern. Statiska kontroller (alla svenska nycklar i t('…') har en översättning, platshållare och taggar stämmer),
// serverns val av språk för index.html, och i Chromium (Playwright): alla vyer på engelska ska sakna svensk text
// (å ä ö och vanliga svenska ord) i synlig text och i aria-label/title/placeholder/alt, och tillgänglighetsgranskningen
// (test/helpers/a11y-audit.js) ska vara grön även på engelska. Biblioteket i testet har engelska namn, så det som
// flaggas är gränssnittet. Hoppas över (webbläsardelen) om ffmpeg eller Playwright saknas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { spawnSync, execFileSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';
import { auditPage } from './helpers/a11y-audit.js';
import { epub, cbz, png, paragraphs } from './helpers/ebook-fixtures.js';

const WEB = path.join(import.meta.dirname, '..', 'web');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const skip = !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- katalogen ----------
const catalog = () => { const ctx = { self: {} }; vm.runInNewContext(fs.readFileSync(path.join(WEB, 'i18n', 'en.js'), 'utf8'), ctx); return ctx.self.BX_I18N; };
const unq = (s) => s.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|[\s\S])/gi, (m, x) => x[0] === 'u' && x.length > 1 ? String.fromCodePoint(parseInt(x.replace(/[u{}]/g, ''), 16)) : ({ n: '\n', t: '\t' }[x] ?? x));
/** Alla nycklar i t('…') och tn(n, '…', '…') i web/js (strängar inom enkla citattecken) */
function keys() {
  const out = new Map();
  for (const f of fs.readdirSync(path.join(WEB, 'js'), { recursive: true }).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(WEB, 'js', f), 'utf8');
    for (const m of src.matchAll(/\bt\('((?:[^'\\\n]|\\.)*)'/g)) out.set(unq(m[1]).trim(), f);
    for (const m of src.matchAll(/\btn\([^,]+,\s*'((?:[^'\\\n]|\\.)*)',\s*'((?:[^'\\\n]|\\.)*)'/g)) { out.set(unq(m[1]).trim(), f); out.set(unq(m[2]).trim(), f); }
  }
  return out;
}

test('katalogen: varje svensk text i t() har en engelsk översättning med samma platshållare och taggar', () => {
  const cat = catalog();
  assert.ok(Object.keys(cat).length > 2000, 'katalogen är för liten');
  const missing = [], bad = [];
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  const tags = (s) => [...s.matchAll(/<\/?([a-z0-9]+)\b/gi)].map(m => m[0].toLowerCase()).join('');
  for (const [k, f] of keys()) {
    if (!/[åäöÅÄÖ]/.test(k)) continue; // ord utan å/ä/ö kan vara lika på engelska (t.ex. "Album", "Trailer")
    if (cat[k] == null) missing.push(`${f}: ${k}`);
  }
  for (const [k, v] of Object.entries(cat)) {
    if (typeof v !== 'string') bad.push(`${k}: inte en sträng`);
    else if (ph(k) !== ph(v)) bad.push(`platshållare: ${k} → ${v}`);
    else if (tags(k) !== tags(v)) bad.push(`taggar: ${k} → ${v}`);
    else if (/[åäöÅÄÖ]/.test(v.replace(/<code>[^<]*<\/code>|\/[\w/åäö.-]+|Ljudböcker|Sommar i P1/g, ''))) bad.push(`svenska kvar i översättningen: ${k} → ${v}`);
  }
  assert.deepEqual(missing, [], `${missing.length} saknas i web/i18n/en.js:\n${missing.join('\n')}`);
  assert.deepEqual(bad, []);
});

test('t(): svenska nyckeln utan katalog, variabler, blanktecken och plural', async () => {
  // core.js läser document vid start – kör t()/tn() i en minimal sandlåda med och utan katalog
  const src = fs.readFileSync(path.join(WEB, 'js', 'core.js'), 'utf8');
  const body = src.slice(src.indexOf('const CAT'), src.indexOf('/** Talet med tusentalsavgränsare'));
  const run = (html, cat) => vm.runInNewContext(`${body.replace(/export /g, '')}; ({ t, tn, lang, locale })`, { globalThis: { BX_I18N: cat, document: { documentElement: { lang: html } } }, Intl, Number });
  const sv = run('sv', { 'Spela': 'Play' });
  assert.equal(sv.lang, 'sv'); assert.equal(sv.locale, 'sv-SE');
  assert.equal(sv.t('Spela'), 'Spela'); // katalogen används bara på engelska
  assert.equal(sv.t('Visa {n} titlar', { n: 3 }), 'Visa 3 titlar');
  assert.equal(sv.t('{a} och {b}', { a: '{b}', b: 'x' }), '{b} och x'); // värden tolkas inte igen
  assert.equal(sv.tn(1, '{n} titel', '{n} titlar'), '1 titel');
  assert.equal(sv.tn(2, '{n} titel', '{n} titlar'), '2 titlar');
  const en = run('en', { 'Spela': 'Play', 'Visa {n} titlar': 'Show {n} titles', '{n} titel': '{n} title', '{n} titlar': '{n} titles' });
  assert.equal(en.lang, 'en'); assert.equal(en.locale, 'en-GB');
  assert.equal(en.t('Spela'), 'Play');
  assert.equal(en.t(' Spela '), ' Play '); // blanktecken runt texten behålls
  assert.equal(en.t('Saknas'), 'Saknas'); // ingen översättning: svenska
  assert.equal(en.t('Visa {n} titlar', { n: 3 }), 'Show 3 titles');
  assert.equal(en.tn(1, '{n} titel', '{n} titlar'), '1 title');
  assert.equal(en.tn(1200, '{n} titel', '{n} titlar'), '1,200 titles');
  // Utan katalog (skriptet kunde inte laddas) blir sidan svensk även om html säger engelska
  assert.equal(run('en', undefined).lang, 'sv');
});

test('webben: katalogen är inget startberoende – bara ett vanligt skript i den engelska sidan och i service workern', async () => {
  const { serveStatic, PRELOAD_FILES } = await import('../server/http/static.js');
  assert.ok(!PRELOAD_FILES.some(f => f.includes('i18n')));
  const page = (lang) => new Promise((resolve) => {
    const res = { writeHead() {}, end: (b) => resolve(String(b)) };
    serveStatic({ method: 'GET', headers: {} }, res, '/', '', lang ? () => lang : null);
  });
  const sv = await page(null), sv2 = await page('sv'), en = await page('en');
  assert.match(sv, /<html lang="sv">/); assert.equal(sv, sv2);
  assert.ok(!sv.includes('i18n/en.js'), 'svenska sidan laddar katalogen');
  assert.match(en, /<html lang="en">/);
  const src = /<script src="([^"]*i18n\/en\.js[^"]*)"><\/script>/.exec(en)?.[1];
  assert.ok(src && /\?h=[0-9a-f]+$/.test(src), 'katalogen med innehållshash');
  assert.ok(en.indexOf(src) < en.indexOf('type="module"'), 'katalogen före modulerna');
  assert.match(fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8'), /'\/i18n\/en\.js'/);
  // router.js laddar databasen – utan egen mapp skulle den skapa /config (nekas i CI)
  process.env.CONFIG_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-i18n-cfg-'));
  const { acceptLang } = await import('../server/http/router.js');
  assert.equal(acceptLang('en-US,en;q=0.9'), 'en');
  assert.equal(acceptLang('sv-SE,sv;q=0.9,en;q=0.8'), 'sv');
  assert.equal(acceptLang('de-DE,de;q=0.9,en;q=0.8'), 'en');
  assert.equal(acceptLang('nb-NO'), 'sv');
  assert.equal(acceptLang('en;q=0.5,da;q=0.9'), 'sv');
  assert.equal(acceptLang(''), 'sv');
  assert.equal(acceptLang('fr-FR'), 'sv');
});

// ---------- servern och webbläsaren ----------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-i18n-'));
const MEDIA = path.join(ROOT, 'media');
let srv, browser, iptv, cookie = '';
const S = {};
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const clip = (file, secs, freq = 440) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ff('-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`,
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', '-metadata:s:a:0', 'language=eng', file);
};
const xt = (s) => new Date(s * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

before(async () => {
  if (skip) return;
  clip(path.join(MEDIA, 'Movies', 'Alpha (2020)', 'Alpha (2020).webm'), 12, 300);
  fs.writeFileSync(path.join(MEDIA, 'Movies', 'Alpha (2020)', 'Alpha (2020).en.srt'), '1\n00:00:01,000 --> 00:00:09,000\nHello and welcome\n');
  clip(path.join(MEDIA, 'Movies', 'Beta (2021)', 'Beta (2021).webm'), 4, 500);
  const se = path.join(MEDIA, 'Shows', 'The Show', 'Season 1');
  clip(path.join(se, 'The Show S01E01.webm'), 4, 600);
  clip(path.join(se, 'The Show S01E02.webm'), 4, 700);
  const alb = path.join(MEDIA, 'Music', 'The Artist', 'The Album'); fs.mkdirSync(alb, { recursive: true });
  for (const n of [1, 2]) ff('-f', 'lavfi', '-i', `sine=frequency=${300 * n}:duration=8`, '-metadata', `title=Song ${n}`, '-metadata', 'artist=The Artist', '-metadata', 'album=The Album',
    '-metadata', `track=${n}`, path.join(alb, `0${n} Song ${n}.mp3`));
  const bok = path.join(MEDIA, 'Audiobooks', 'The Writer', 'The Book'); fs.mkdirSync(bok, { recursive: true });
  ff('-f', 'lavfi', '-i', 'sine=frequency=250:duration=10', '-metadata', 'title=Part 1', '-metadata', 'album=The Book', '-metadata', 'artist=The Writer', path.join(bok, '01.mp3'));
  const pics = path.join(MEDIA, 'Photos', '2024', 'Summer'); fs.mkdirSync(pics, { recursive: true });
  for (const [n, c] of [[1, 'red'], [2, 'blue']]) ff('-f', 'lavfi', '-i', `color=c=${c}:s=320x240`, '-frames:v', '1', path.join(pics, `pic${n}.jpg`));
  const eb = path.join(MEDIA, 'Ebooks', 'The Saga'); fs.mkdirSync(eb, { recursive: true });
  fs.writeFileSync(path.join(MEDIA, 'Ebooks', 'The Novel.epub'), epub({ title: 'The Novel', author: 'The Author', lang: 'en', publisher: 'The Publisher', subject: 'Adventure', cover: png(120, 180),
    chapters: [{ title: 'Beginning', body: '<p>It was a dark and stormy night. The end came quickly.</p>'.repeat(30) }, { title: 'Ending', body: '<p>The end.</p>' }] }));
  fs.writeFileSync(path.join(eb, 'The Saga 001.cbz'), cbz({ pages: 4, w: 120, h: 180, info: { Series: 'The Saga', Number: '1' } }));
  const T0 = Math.floor(Date.now() / 1000 / 1800) * 1800;
  const guide = `<tv><channel id="k1"><display-name>Channel One</display-name></channel>
    ${[-1, 0, 1, 2].map(h => `<programme start="${xt(T0 + h * 3600)}" stop="${xt(T0 + (h + 1) * 3600)}" channel="k1"><title>Programme ${h + 2}</title><desc>Description</desc></programme>`).join('')}</tv>`;
  iptv = http.createServer((q, r) => {
    const base = `http://127.0.0.1:${iptv.address().port}`;
    if (q.url === '/list.m3u') r.end(`#EXTM3U url-tvg="${base}/guide.xml"\n#EXTINF:-1 tvg-id="k1" tvg-chno="1" group-title="News",Channel One\n${base}/1.ts\n`);
    else if (q.url === '/guide.xml') r.end(guide);
    else { r.writeHead(404); r.end(); }
  });
  await new Promise(r => iptv.listen(0, '127.0.0.1', r));
  srv = await startServer({ root: ROOT, media: MEDIA, env: { TMDB_API_KEY: '', WATCH_FILES: '0', DVR_DIR: path.join(ROOT, 'rec') } });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.stop(); iptv?.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const bt = (name, fn) => test(name, { skip, timeout: 600000 }, fn);

bt('förberedelse: konto, språk per profil och sidans språk från servern', async () => {
  let r = await srv.req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } });
  assert.equal(r.status, 200);
  r = await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW } });
  cookie = /kt=([0-9a-f]+)/.exec(r.headers.get('set-cookie'))[1];
  // Inget val ännu: null i /api/status och svensk sida även om webbläsaren vill ha engelska
  assert.equal((await srv.req('/api/status')).data.user.lang, null);
  const html = async (headers) => String((await srv.req('/', { headers, raw: true })).data);
  assert.match(await html({ 'accept-language': 'en-US' }), /<html lang="sv">/);
  // Utloggad: webbläsarens språk, och kakan bxlang går före
  const anon = async (headers) => String(Buffer.from(await (await fetch(srv.base + '/', { headers })).arrayBuffer()));
  assert.match(await anon({ 'accept-language': 'en-US,en;q=0.9' }), /<html lang="en">.*i18n\/en\.js/s);
  assert.match(await anon({ 'accept-language': 'sv-SE' }), /<html lang="sv">/);
  assert.match(await anon({ 'accept-language': 'en-US', cookie: 'bxlang=sv' }), /<html lang="sv">/);
  assert.match(await anon({ 'accept-language': 'sv', cookie: 'bxlang=en' }), /<html lang="en">/);
  assert.equal((await srv.req('/api/me/lang', { method: 'PUT', body: { lang: 'de' } })).status, 400);
  assert.equal((await srv.req('/api/me/lang', { method: 'PUT', body: { lang: 'en' } })).status, 200);
  assert.equal((await srv.req('/api/status')).data.user.lang, 'en');
  assert.match(await html({ 'accept-language': 'sv-SE' }), /<html lang="en">/); // profilens val går före
  for (const [name, type, p] of [['Movies', 'movie', 'Movies'], ['Shows', 'show', 'Shows'], ['Music', 'music', 'Music'], ['Audiobooks', 'audiobook', 'Audiobooks'], ['Photos', 'photo', 'Photos'], ['Ebooks', 'ebook', 'Ebooks']]) {
    r = await srv.req('/api/libraries', { method: 'POST', body: { name, type, path: path.join(MEDIA, p) } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  r = await srv.req('/api/iptv/sources', { method: 'POST', body: { type: 'm3u', url: `http://127.0.0.1:${iptv.address().port}/list.m3u`, name: 'List' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (let i = 0; i < 240; i++) { await sleep(500); const s = (await srv.req('/api/scan')).data; if (!s.running && !s.analysis?.running && s.last) break; }
  const libs = (await srv.req('/api/libraries')).data;
  for (const l of libs) S[l.type] = l.id;
  const items = (await srv.req(`/api/libraries/${S.movie}/items`)).data.items;
  S.alfa = items.find(i => i.title === 'Alpha').id;
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

const VIEWS = () => [
  ['', 'Hem'], [`lib/${S.movie}`, 'Filmer'], [`lib/${S.show}`, 'Serier'], [`item/${S.alfa}`, 'Film'], [`item/${S.show}`, 'Serie'],
  [`music/${S.music}`, 'Musik'], ...(S.album ? [[`album/${S.album}`, 'Album']] : []), [`books/${S.audiobook}`, 'Ljudböcker'], ...(S.book ? [[`book/${S.book}`, 'Ljudbok']] : []),
  ['podcasts', 'Poddar'], [`photos/${S.photo}`, 'Foton'], [`ebooks/${S.ebook}`, 'E-böcker'], [`ebook/${S.epub}`, 'E-bok'], [`read/${S.epub}`, 'Läsaren (EPUB)'], [`read/${S.comic}`, 'Läsaren (serietidning)'], ['search?q=alpha', 'Sök'], ['watchlist', 'Min lista'], ['calendar', 'Kommande'],
  ['collections', 'Samlingar'], ['account', 'Mitt konto'], ['admin', 'Administration'], ['stats', 'Statistik'], ['wrapped', 'Årssammanfattning'],
  ['requests', 'Önskningar'], ['history', 'Historik'], ['playstats', 'Tittarstatistik'], ['webhooks', 'Webhooks'], ['downloads', 'Nedladdat'],
  ['live', 'Live-TV'], ['epg', 'TV-guide'], ['vod', 'VOD'], ['iptvadmin', 'IPTV'], ['dvr', 'Inspelningar'], ['health', 'Hälsokontroll'],
  ['quickconnect', 'Godkänn TV'], ['streaming', 'Strömmande'], ['setup', 'Installation'], ['setup/libraries', 'Installation: bibliotek'],
  ['setup/transcode', 'Installation: omkodning'], ['setup/household', 'Installation: hushållet'], ['iptvadmin/channels', 'IPTV: kanaler'], ['dvr/rules', 'Inspelningar: serier'],
  ['shrink', 'Diskrådgivaren'], ['shrink/titles', 'Diskrådgivaren: titlar'], ['shrink/versions', 'Diskrådgivaren: versioner'], ['shrink/jobs', 'Diskrådgivaren: kö'], ['shrink/settings', 'Diskrådgivaren: inställningar'],
  ['tonight', 'Kvällsvalet'], [`tonight/${S.tonight}`, 'Kvällsvalet: lobby'], ['vocab', 'Ordlista'],
  ['sso', 'Enkel inloggning'], ['sso/new-oidc', 'Enkel inloggning: OIDC'], ['sso/new-ldap', 'Enkel inloggning: LDAP']
];
const MODES = {
  phone: { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true },
  desktop: { viewport: { width: 1280, height: 800 } },
  tv: { viewport: { width: 1920, height: 1080 }, userAgent: 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 SMART-TV' }
};
async function newPage(mode = 'desktop') {
  const ctx = await browser.newContext({ ...MODES[mode], locale: 'en-US' });
  await ctx.addCookies([{ name: 'kt', value: cookie, url: srv.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  return { page, errors, close: () => ctx.close() };
}
async function open(page, hash) {
  await page.goto(srv.base + '/#/' + hash);
  await page.waitForFunction(() => document.querySelector('#main') && !document.querySelector('#main[aria-busy]') && !document.querySelector('#main .sk'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 5000 }).catch(() => {});
  await sleep(300);
  await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))), new Promise(r => setTimeout(r, 2000))]));
}

// Vanliga svenska ord som inte är engelska (ord med å/ä/ö flaggas alltid)
const SV_WORDS = ['och', 'att', 'inte', 'för', 'med', 'som', 'till', 'eller', 'inga', 'ingen', 'inget', 'finns', 'visa', 'spela', 'spara', 'avbryt',
  'alla', 'nytt', 'nya', 'kan', 'ska', 'har', 'din', 'dina', 'ditt', 'efter', 'filmer', 'serier', 'musik', 'ljud', 'bilder', 'avsnitt', 'titlar', 'titel',
  'sedd', 'osedd', 'kanaler', 'bibliotek', 'biblioteket', 'konto', 'kontot', 'profil', 'profiler', 'logga', 'skapa', 'lagg', 'kommande', 'titta', 'lyssna',
  'senaste', 'tillagda', 'poddar', 'foton', 'samlingar', 'samling', 'mitt', 'mina', 'historik', 'nedladdat', 'inspelningar', 'guiden', 'statistik',
  'uppspelning', 'undertexter', 'kvalitet', 'dagar', 'timmar', 'minuter', 'sekunder', 'idag', 'imorgon', 'bara', 'alltid', 'aldrig', 'redan', 'vill',
  'eller', 'mappen', 'mappar', 'inloggning', 'enheter', 'skanning', 'omkodning', 'hemma', 'utanför', 'hemmet', 'servern', 'webbläsaren', 'sparat',
  'hoppa', 'stoppa', 'pausa', 'nedladdning', 'serie', 'serien', 'filmen', 'betyg', 'genrer', 'sortera', 'filtrera', 'rensa', 'markera', 'ladda'];
const SV = new Set(SV_WORDS);
/** Synlig text och tillgängliga namn i sidan (eller i scope) – element med lang ≠ en (t.ex. "Svenska" i språkvalet) räknas inte */
function visibleText(scope) {
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return [];
  const out = [];
  // translate="no": serverns logg och säkerhetsloggens fritext (skrivs av servern på svenska)
  const skipEl = (el) => !el.checkVisibility?.({ visibilityProperty: true, opacityProperty: false }) && !el.closest('dialog[open], [role=menu]') || (el.closest('[lang]')?.getAttribute('lang') || 'en') !== 'en' || !!el.closest('[translate=no]');
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement && !/^(SCRIPT|STYLE|TEMPLATE)$/.test(n.parentElement.tagName) && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  for (let n = w.nextNode(); n; n = w.nextNode()) if (!skipEl(n.parentElement)) out.push({ t: n.nodeValue.trim(), where: n.parentElement.closest('[id]')?.id || n.parentElement.localName });
  for (const el of [root, ...root.querySelectorAll('[aria-label], [title], [placeholder], img[alt], [aria-valuetext]')]) {
    if ((el.closest('[lang]')?.getAttribute('lang') || 'en') !== 'en') continue;
    for (const a of ['aria-label', 'title', 'placeholder', 'alt', 'aria-valuetext']) { const v = el.getAttribute(a); if (v?.trim()) out.push({ t: v.trim(), where: `${el.id || el.localName}[${a}]` }); }
  }
  for (const o of root.querySelectorAll('option')) if ((o.closest('[lang]')?.getAttribute('lang') || 'en') === 'en') out.push({ t: o.textContent.trim(), where: `option(${o.closest('select')?.id || ''})` });
  return out;
}
// Text som får vara svensk: innehåll från servern som inte är gränssnitt (sökvägar, exempel) och egennamn
const ALLOW = [/Avsnitt \d+/ /* avsnittstitel som servern sätter när TMDB saknas (data, inte gränssnitt) */, /\/media\/(Filmer|Serier)\b/, /Sommar i P1/, /BraXhn/, /Ljudböcker\/Audiobooks/, /Filmer\/Movies|Serier\/TV|Musik\/Music/, /Europe\/Stockholm/, /tv\.dindomän/];
function swedish(list) {
  const found = [];
  for (const { t, where } of list) {
    let s = t; for (const re of ALLOW) s = s.replace(new RegExp(re.source, 'g'), ' ');
    const words = s.toLowerCase().match(/\p{L}+/gu) || [];
    const bad = words.filter(w => /[åäö]/.test(w) || SV.has(w));
    if (bad.length) found.push(`${where}: "${t.slice(0, 120)}" (${[...new Set(bad)].join(', ')})`);
  }
  return [...new Set(found)];
}
const fmt = (list) => list.map(f => `  [${f.rule}] ${f.view ? f.view + ': ' : ''}${f.sel} – ${f.msg}`).join('\n');

for (const mode of ['desktop', 'phone', 'tv']) {
  bt(`alla vyer på engelska (${mode}): ingen svensk text kvar och tillgänglighetsgranskningen är grön`, async () => {
    const { page, errors, close } = await newPage(mode);
    const sv = [], a11y = [];
    for (const [hash, name] of VIEWS()) {
      await open(page, hash);
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'en', name);
      if (mode !== 'tv') for (const x of swedish(await page.evaluate(visibleText))) sv.push(`${name}: ${x}`);
      for (const x of await page.evaluate(auditPage, {})) a11y.push({ ...x, view: name });
      if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `i18n-${mode}-${name.replace(/\W+/g, '-')}.png`) });
    }
    await close();
    assert.deepEqual(sv, [], `${sv.length} texter på svenska (${mode}):\n${sv.join('\n')}`);
    assert.deepEqual(a11y, [], `${a11y.length} fynd (${mode}):\n${fmt(a11y)}`);
    assert.deepEqual(errors, []);
  });
}

bt('engelska: dialoger, kortmenyn, spelaren och datum/tal med engelsk locale', async () => {
  const { page, errors, close } = await newPage('desktop');
  await open(page, `lib/${S.movie}`);
  // Kortkommandon (?)
  await page.keyboard.press('?');
  await page.waitForSelector('dialog[open]');
  assert.deepEqual(swedish(await page.evaluate(visibleText, 'dialog[open]')), []);
  assert.match(await page.textContent('dialog[open]'), /Keyboard shortcuts/);
  await page.keyboard.press('Escape');
  // Kortmenyn
  await page.focus('.card a[href^="#/item/"]');
  await page.keyboard.press('Shift+F10');
  await page.waitForSelector('[role=menu]');
  assert.deepEqual(swedish(await page.evaluate(visibleText, '[role=menu]')), []);
  await page.keyboard.press('Escape');
  // Spelaren
  await open(page, `item/${S.alfa}`);
  await page.click('[data-play]');
  await page.waitForSelector('#player:not([hidden]) #vid');
  await page.waitForFunction(() => document.querySelector('#vid').currentTime > 0.3, null, { timeout: 20000 });
  assert.deepEqual(swedish(await page.evaluate(visibleText, '#player')), []);
  assert.deepEqual(await page.evaluate(auditPage, { scope: '#player', contrast: false, target: false }), []);
  // Språkinlärningen (⚙): verktygsraden och tipset på engelska
  await page.evaluate(() => { const c = document.querySelector('#plearn'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await page.waitForSelector('#plearnbar:not([hidden]) #lrep');
  assert.deepEqual(swedish(await page.evaluate(visibleText, '#player')), []);
  assert.deepEqual(await page.evaluate(auditPage, { scope: '#player', contrast: false, target: false }), []);
  await page.evaluate(() => { const c = document.querySelector('#plearn'); c.checked = false; c.dispatchEvent(new Event('change')); });
  await page.keyboard.press('k');
  await page.waitForFunction(() => document.querySelector('#pstate').textContent === 'Paused');
  await page.keyboard.press('Escape');
  // Ljudböckernas dialoger: kapitelredigeraren, RSS-flödet och lyssningsstatistiken
  for (const [view, opener] of [[`book/${S.book}`, '#bchap'], [`book/${S.book}`, '#bfeed'], [`books/${S.audiobook}`, '#bstats']]) {
    await open(page, view);
    await page.click(opener);
    await page.waitForSelector('dialog[open]');
    await page.waitForFunction(() => !document.querySelector('dialog[open] [aria-busy="true"]'));
    assert.deepEqual(swedish(await page.evaluate(visibleText, 'dialog[open]')), [], opener);
    assert.deepEqual(await page.evaluate(auditPage, { scope: 'dialog[open]', contrast: false }), [], opener);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
  }
  // Datum i engelskt format (Intl med en-GB): veckodag/månad på engelska i historiken
  await open(page, 'history');
  const txt = await page.evaluate(() => document.querySelector('#main').innerText);
  assert.ok(!/\b(januari|februari|mars|maj|juni|juli|augusti|oktober|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)\b/i.test(txt), txt.slice(0, 300));
  // Byte till svenska i Mitt konto laddar om sidan på svenska och sparas för profilen
  await open(page, 'account');
  await Promise.all([page.waitForEvent('load'), page.selectOption('#uilang', 'sv')]);
  await page.waitForFunction(() => document.documentElement.lang === 'sv' && document.querySelector('#langprefs'));
  assert.match(await page.textContent('#langprefs h2'), /Språk/);
  assert.equal((await srv.req('/api/status')).data.user.lang, 'sv');
  assert.deepEqual(errors, []);
  await close();
  assert.equal((await srv.req('/api/me/lang', { method: 'PUT', body: { lang: 'en' } })).status, 200);
});

bt('första inloggningen: profilen utan språk får webbläsarens (inloggningssidan på engelska)', async () => {
  const r = await srv.req('/api/users', { method: 'POST', body: { name: 'guest', password: PW + 'x' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ctx = await browser.newContext({ ...MODES.desktop, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(srv.base + '/#/login');
  await page.waitForSelector('#main input');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  assert.deepEqual(swedish(await page.evaluate(visibleText)), []);
  assert.deepEqual(await page.evaluate(auditPage, {}), []);
  await page.fill('#n', 'guest'); await page.fill('#p', PW + 'x');
  await page.click('button.primary');
  await page.waitForFunction(() => !location.hash.startsWith('#/login'), null, { timeout: 15000 });
  await ctx.close();
  const u = (await srv.req('/api/users')).data;
  const g = (u.users || u).find(x => x.name === 'guest');
  // Språket sparas via /api/me/lang – kontrollera med gästens egen inloggning
  const lr = await fetch(srv.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'guest', password: PW + 'x' }) });
  const ck = lr.headers.get('set-cookie').split(';')[0];
  const st = await (await fetch(srv.base + '/api/status', { headers: { cookie: ck } })).json();
  assert.ok(g, 'gästen finns');
  assert.equal(st.user.lang, 'en');
});
