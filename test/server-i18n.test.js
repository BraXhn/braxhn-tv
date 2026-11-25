// Serverns texter på engelska (server/i18n.js): språket följer profilens val (users.lang), annars kakan bxlang och
// Accept-Language, annars svenska. Samma anrop med en svensk och en engelsk profil, och utan inloggning, ska ge
// felmeddelanden, hyllnamn, avsnitt utan namn, spåretiketter, skärmtid och notiser på rätt språk – medan felkoder och
// fält som apparna läser (code, need2fa, id …) är desamma. Sist en genomgång av vanliga anrop på engelska som letar
// efter svensk text i svaret. Kräver ffmpeg (riktiga videofiler skannas in) som övriga servertester.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { freePort } from './helpers/port.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-i18n-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlosen-2026!x';
let srv;
const S = {};

async function req(p, { method = 'GET', body, tok = S.admin, headers = {} } = {}) {
  const h = { ...headers };
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (name, headers = {}) => (await req('/api/login', { method: 'POST', body: { name, password: PW, app: true }, tok: '', headers })).data.token;
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const video = (file, sub) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file);
  if (sub) fs.writeFileSync(file.replace(/\.mp4$/, '.srt'), '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
};
const EN = { 'accept-language': 'en-US,en;q=0.9' }, SV = { 'accept-language': 'sv-SE,sv;q=0.9' };

before(async () => {
  if (!hasFfmpeg) return;
  video(path.join(MEDIA, 'Movies', 'Alpha Movie (2020).mp4'), true);
  video(path.join(MEDIA, 'Shows', 'Night Show', 'Season 1', 'Night Show S01E02.mp4'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', BOOK_METADATA: '0', DLNA: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

t('förberedelse: bibliotek, en svensk och en engelsk användare, en barnprofil utan språk', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  S.admin = await login('admin');
  S.M = (await req('/api/libraries', { method: 'POST', body: { name: 'Movies', type: 'movie', path: path.join(MEDIA, 'Movies') } })).data.id;
  S.T = (await req('/api/libraries', { method: 'POST', body: { name: 'Shows', type: 'show', path: path.join(MEDIA, 'Shows') } })).data.id;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const s = (await req('/api/scan')).data;
    if (!s.running && s.last && (await req(`/api/libraries/${S.T}/items`)).data.items?.length) break;
  }
  S.movie = (await req(`/api/libraries/${S.M}/items`)).data.items[0].id;
  S.show = (await req(`/api/libraries/${S.T}/items`)).data.items[0].id;
  assert.ok(S.movie && S.show);
  for (const name of ['sven', 'anna']) assert.equal((await req('/api/users', { method: 'POST', body: { name, password: PW, canDownload: false } })).status, 200);
  S.sven = await login('sven'); S.anna = await login('anna');
  assert.equal((await req('/api/me/lang', { method: 'PUT', body: { lang: 'sv' }, tok: S.sven })).status, 200);
  assert.equal((await req('/api/me/lang', { method: 'PUT', body: { lang: 'en' }, tok: S.anna })).status, 200);
  S.annaId = (await req('/api/status', { tok: S.anna })).data.user.id;
  // Barnprofil i Annas hushåll (åldersgräns 7, inget eget språk) – loggar in med Annas apptoken och byter profil
  const kid = (await req('/api/profiles', { method: 'POST', body: { name: 'kid', maxAge: 7 }, tok: S.anna })).data;
  const kidId = kid.id ?? (await req('/api/profiles', { tok: S.anna })).data.profiles.find(p => p.name === 'kid').id;
  const tmp = await login('anna');
  S.kid = (await req('/api/profiles/switch', { method: 'POST', body: { id: kidId }, tok: tmp })).data.token;
  assert.ok(S.kid);
});

t('utan inloggning: Accept-Language och kakan bxlang väljer språket, ingen header ger svenska', async () => {
  assert.deepEqual((await req('/api/home', { tok: '', headers: EN })).data, { error: 'Not signed in' });
  assert.deepEqual((await req('/api/home', { tok: '', headers: SV })).data, { error: 'Inte inloggad' });
  assert.deepEqual((await req('/api/home', { tok: '' })).data, { error: 'Inte inloggad' });
  assert.deepEqual((await req('/api/home', { tok: '', headers: { 'accept-language': 'de-DE' } })).data, { error: 'Not signed in' }, 'övriga språk → engelska (som webben)');
  assert.deepEqual((await req('/api/home', { tok: '', headers: { ...EN, cookie: 'bxlang=sv' } })).data, { error: 'Inte inloggad' }, 'kakan går före webbläsarens språk');
  // Inloggningsfel och tvåstegsverifiering
  const bad = (h) => req('/api/login', { method: 'POST', body: { name: 'anna', password: 'fel-lösenord-123' }, tok: '', headers: h });
  const en = await bad(EN), sv = await bad(SV);
  assert.equal(en.status, 401); assert.equal(sv.status, 401);
  assert.equal(en.data.error, 'Wrong name or password');
  assert.equal(sv.data.error, 'Fel namn eller lösenord');
  assert.equal((await req('/api/nope', { tok: '', headers: EN })).data.error, 'Unknown endpoint');
});

t('felmeddelanden: profilens språk går före Accept-Language – felkoder och övriga fält är desamma', async () => {
  const gone = (tok, h) => req('/api/items/999999', { tok, headers: h });
  assert.equal((await gone(S.anna, SV)).data.error, 'Does not exist');
  assert.equal((await gone(S.sven, EN)).data.error, 'Finns inte');
  // Profil utan eget språk (barnprofilen, appens token): Accept-Language
  assert.equal((await gone(S.kid, EN)).data.error, 'Does not exist');
  assert.equal((await gone(S.kid, SV)).data.error, 'Finns inte');
  // Åldersgräns/familj: titeln utan åldersgräns är inte tillgänglig för barnprofilen
  const age = await req(`/api/items/${S.movie}/playback`, { tok: S.kid, headers: EN });
  assert.equal(age.status, 403); assert.equal(age.data.error, 'Not available in this profile');
  assert.equal((await req(`/api/items/${S.movie}/playback`, { tok: S.kid, headers: SV })).data.error, 'Inte tillgänglig i den här profilen');
  // Nedladdning nekad (rättigheten är av för sven och anna)
  const dl = (tok) => req(`/api/items/${S.movie}/offline`, { tok });
  assert.equal((await dl(S.anna)).data.error, 'Your account is not allowed to download');
  assert.equal((await dl(S.sven)).data.error, 'Ditt konto får inte ladda ner');
  // Administration
  assert.equal((await req('/api/users', { tok: S.anna })).data.error, 'Requires an administrator');
  // Ogiltig JSON (readJson) och fel med variabler (mönster i katalogen)
  const r = await fetch(B + '/api/me/lang', { method: 'PUT', headers: { authorization: 'Bearer ' + S.anna, 'content-type': 'application/json' }, body: '{' });
  assert.deepEqual(await r.json(), { error: 'Invalid JSON' });
});

t('skärmtid: beskedet och felet vid uppspelning på profilens språk, code är samma', async () => {
  assert.equal((await req(`/api/screentime/${S.annaId}`, { method: 'PUT', body: { daily: 0 } })).status, 200);
  const en = (await req('/api/screentime', { tok: S.anna })).data;
  assert.equal(en.allowed, false); assert.equal(en.reason, 'limit');
  assert.match(en.message, /^Time is up for today – you have watched 0 of 0 minutes\. Ask a grown-up/);
  const play = await req(`/api/items/${S.movie}/playback`, { tok: S.anna });
  assert.equal(play.status, 403); assert.equal(play.data.code, 'screen_time');
  assert.equal(play.data.error, play.data.screenTime.message); assert.match(play.data.error, /^Time is up/);
  // Samma regel för sven: svenska
  const svenId = (await req('/api/status', { tok: S.sven })).data.user.id;
  await req(`/api/screentime/${svenId}`, { method: 'PUT', body: { daily: 0 } });
  assert.match((await req('/api/screentime', { tok: S.sven })).data.message, /^Tiden är slut för idag – du har tittat 0 av 0 minuter/);
  // Tillåtna klockslag: veckodagen och tiden på engelska
  const d = new Date(), h = (d.getHours() + 2) % 24, hh = String(h).padStart(2, '0');
  await req(`/api/screentime/${S.annaId}`, { method: 'PUT', body: { from: `${hh}:00`, until: `${String((h + 1) % 24).padStart(2, '0')}:00` } });
  const w = (await req('/api/screentime', { tok: S.anna })).data;
  assert.equal(w.reason, 'window');
  assert.match(w.message, /^You can't watch right now\. On (Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)days you can watch between \d\d:00 and \d\d:00\.$/);
  for (const id of [S.annaId, svenId]) await req(`/api/screentime/${id}`, { method: 'PUT', body: {} });
  assert.equal((await req('/api/screentime', { tok: S.anna })).data.allowed ?? true, true);
});

t('startsidan: hyllnamnen och avsnitt utan namn på profilens språk', async () => {
  const names = async (tok) => Object.fromEntries((await req('/api/me/home-layout', { tok })).data.shelves.map(s => [s.id, s.name]));
  const en = await names(S.anna), sv = await names(S.sven);
  assert.equal(en.recent, 'Recently added'); assert.equal(sv.recent, 'Nyligen tillagda');
  assert.equal(en.continue, 'Continue watching'); assert.equal(sv.continue, 'Fortsätt titta');
  assert.deepEqual(Object.keys(en), Object.keys(sv), 'samma id:n');
  assert.equal((await req('/api/home', { tok: S.anna })).data.homeLayout.shelves.find(s => s.id === 'because').name, 'Because you watched …');
  // Avsnittet saknar titel i filnamnet och TMDB: sparas som "Avsnitt 2", visas som "Episode 2" på engelska
  const ep = async (tok) => (await req(`/api/items/${S.show}`, { tok })).data.children[0].title;
  assert.equal(await ep(S.anna), 'Episode 2');
  assert.equal(await ep(S.sven), 'Avsnitt 2');
});

t('spår- och versionsetiketter: undertextfilen på profilens språk', async () => {
  const subs = async (tok) => (await req(`/api/items/${S.movie}`, { tok })).data.subtitles.map(s => s.label);
  // Filen heter Alpha Movie (2020).srt – ingen språkkod: "Extern (fil)"
  assert.deepEqual(await subs(S.anna), ['External (file)']);
  assert.deepEqual(await subs(S.sven), ['Extern (fil)']);
});

test('webben tolkar spåretiketter på båda språken (web/js/ui/tracklabel.js)', async () => {
  const { subLabel } = await import('../web/js/ui/tracklabel.js');
  const { subLabel: srv } = await import('../server/i18n.js');
  const sub = (label, lang, source = 'external') => ({ label, lang, source });
  // Utan katalog (Node) blir t() svenska: samma visning oavsett om servern skrev etiketten på svenska eller engelska
  for (const [sv, lang, source] of [['Extern (fil)', null], ['sv (fil)', 'sv'], ['en.forced (fil)', 'en'], ['Spår 3', null, 'embedded'],
    ['Spår 4 (bild)', null, 'embedded'], ['sv (nedladdad)', 'sv', 'downloaded'], ['Kommentar · eng (bild)', 'eng', 'embedded']]) {
    const en = srv('en', sv);
    assert.equal(subLabel(sub(en, lang, source)), subLabel(sub(sv, lang, source)), `${sv} / ${en}`);
  }
  assert.equal(srv('en', 'Extern (fil)'), 'External (file)');
  assert.equal(srv('en', 'Spår 4 (bild)'), 'Track 4 (image)');
  assert.equal(srv('sv', 'Spår 4 (bild)'), 'Spår 4 (bild)');
});

t('notiser: administratörens språk för larmen, mottagarens språk för personliga notiser', async () => {
  // I samma process mot en egen databas
  process.env.CONFIG_DIR = path.join(ROOT, 'unit');
  fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
  const { run, setSetting } = await import('../server/db.js');
  setSetting('notify_kind', 'webhook'); setSetting('notify_url', 'http://127.0.0.1:9/notis'); // leveransen misslyckas (loggas), notisen sparas ändå i sent
  const notify = await import('../server/notify.js');
  const follows = await import('../server/follows.js');
  const { msg } = await import('../server/i18n.js');
  run("INSERT INTO users(name,pass,is_admin,created) VALUES('boss','x',1,0)");
  const last = () => notify.sent[notify.sent.length - 1];
  await notify.notify('security', msg('Testnotis'), msg('Det fungerar! Så här ser larm från BraXhn TV ut.'));
  assert.equal(last().title, 'BraXhn TV: Testnotis');
  run("UPDATE users SET lang='en' WHERE name='boss'");
  await notify.notify('security', msg('Testnotis'), msg('Det fungerar! Så här ser larm från BraXhn TV ut.'));
  assert.equal(last().title, 'BraXhn TV: Test notification');
  assert.equal(last().message, 'It works! This is what alerts from BraXhn TV look like.');
  // Säkerhetsloggen → larm (med variabler och en text i texten)
  notify.onAudit('password_changed', { user: { name: 'anna' }, ip: '81.2.3.4' });
  assert.equal(last().title, 'BraXhn TV: Password changed');
  assert.equal(last().message, "Password changed (anna) from 81.2.3.4. Wasn't it you? Sign in and change your password.");
  // Färdig svensk text (disklarmet) översätts med mönster
  await notify.notify('disk', 'Lite ledigt diskutrymme', 'Recordings: 12 GB ledigt av 1 000 GB (1 %).');
  assert.equal(last().title, 'BraXhn TV: Low on free disk space');
  assert.equal(last().message, 'Recordings: 12 GB free of 1 000 GB (1 %).');
  // Nya avsnitt (personlig notis)
  const eps = [{ show: 'A', season: 1, episode: 1, title: 'Avsnitt 1' }, { show: 'A', season: 1, episode: 2, title: 'Two' }];
  assert.deepEqual(follows.compose(eps, 'en'), { title: '2 new episodes of A', message: 'A: S01E01, S01E02 Two' });
  assert.deepEqual(follows.compose(eps), { title: '2 nya avsnitt av A', message: 'A: S01E01, S01E02 Two' });
});

t('offlinesidan: svenska som standard, engelska efter kakan eller webbläsarens språk (skriptet tillåts av CSP:n)', async () => {
  let chromium = null;
  for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
    try { ({ chromium } = await import(p)); break; } catch {}
  }
  if (!chromium) return; // utan Playwright: bara serverdelen ovan
  const browser = await chromium.launch();
  try {
    const text = async (locale, cookie) => {
      const ctx = await browser.newContext({ locale, serviceWorkers: 'block' });
      if (cookie) await ctx.addCookies([{ name: 'bxlang', value: cookie, url: B }]);
      const page = await ctx.newPage(), errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(B + '/offline.html');
      const out = { h1: await page.textContent('h1'), lang: await page.getAttribute('html', 'lang'), a: await page.textContent('a'), errors };
      await ctx.close();
      return out;
    };
    assert.deepEqual(await text('sv-SE'), { h1: 'Servern svarar inte', lang: 'sv', a: 'Försök igen', errors: [] });
    assert.deepEqual(await text('en-US'), { h1: "The server isn't responding", lang: 'en', a: 'Try again', errors: [] });
    assert.equal((await text('de-DE')).lang, 'en');
    assert.equal((await text('en-US', 'sv')).h1, 'Servern svarar inte');
    assert.equal((await text('sv-SE', 'en')).h1, "The server isn't responding");
  } finally { await browser.close(); }
});

// ---------- ingen svensk text i engelska svar ----------
const SV_WORDS = /\b(och|inte|finns|för|eller|måste|redan|kan|ska|har|till|från|av|med|utan|ingen|inga|avsnitt|spår|fil|bild)\b/i;
// Fält som är data, inte gränssnitt: namn och sökvägar ur biblioteket och användarnas egna namn, och weekday i
// skärmtidens status (läses inte av någon klient)
const DATA_KEYS = new Set(['path', 'file', 'name', 'title', 'sortTitle', 'weekday', 'folder', 'user', 'showTitle', 'library']);
function swedish(v, at = '', out = []) {
  if (typeof v === 'string') { if (/[åäöÅÄÖ]/.test(v) || (/\s/.test(v) && SV_WORDS.test(v))) out.push(`${at}: ${v.slice(0, 120)}`); }
  else if (Array.isArray(v)) v.forEach((x, i) => swedish(x, `${at}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!DATA_KEYS.has(k) || typeof x !== 'string') swedish(x, `${at}.${k}`, out);
  return out;
}
t('vanliga anrop med engelsk profil: ingen svensk text i svaren', async () => {
  const calls = [
    ['/api/status'], ['/api/home'], ['/api/me/home-layout'], [`/api/items/${S.movie}`], [`/api/items/${S.show}`],
    [`/api/items/${S.movie}/playback`], ['/api/screentime'], ['/api/items/999999'], ['/api/users'], ['/api/nope'],
    [`/api/items/${S.movie}/offline`], ['/api/dvr/conflicts'], ['/api/search?q=alpha'],
    ['/api/me/lang', { method: 'PUT', body: { lang: 'xx' } }], ['/api/profiles', { method: 'POST', body: {} }]
  ];
  const found = [];
  for (const [p, o = {}] of calls) {
    const r = await req(p, { tok: S.anna, ...o });
    for (const f of swedish(r.data)) found.push(`${o.method || 'GET'} ${p} (${r.status}) ${f}`);
  }
  // Utan inloggning med engelsk webbläsare
  for (const p of ['/api/home', '/api/items/1', '/api/scan']) for (const f of swedish((await req(p, { tok: '', headers: EN })).data)) found.push(`utloggad ${p} ${f}`);
  for (const f of swedish((await req('/api/login', { method: 'POST', body: { name: 'x', password: 'y' }, tok: '', headers: EN })).data)) found.push(`login ${f}`);
  assert.deepEqual(found, [], `svensk text i engelska svar:\n${found.join('\n')}`);
});
