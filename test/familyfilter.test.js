// Familjefiltret (server/familyfilter.js): svordomar i undertexten → tysta intervall, maskerad undertext och scener att
// hoppa över. Testfilerna skapas med ffmpeg (en ton genom hela filmen) med en känd .srt som har svordomar på kända tider.
// Kontrolleras: ordlistorna (ordgräns, böjningar, fraser, administratörens ord), intervallen (marginal, sammanslagning,
// undertextsynken), /playback-planen per profil (av för vuxna, administratörens standard för barnprofiler), maskerad
// undertext, att servern faktiskt tystar ljudet i HLS-strömmen (ffmpeg volumedetect på segmenten – från början och efter
// spolning, remux och omkodning), scener att hoppa över (vem som ser/får ändra) och webbspelaren i Chromium (video.muted
// på rätt tider, indikatorn, *** i undertexten och överhoppad scen). Kräver ffmpeg; webbdelen kräver Playwright.
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-family-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 29000 + Math.floor(Math.random() * 900);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const SHOTS = process.env.SHOTS || '';
// Modulen i den här processen (egen databas) för de rena funktionerna
process.env.CONFIG_DIR = path.join(ROOT, 'unitconfig');
process.env.TRANSCODE_DIR = path.join(ROOT, 'unit-tc');
const F = await import('../server/familyfilter.js');
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
const tw = (name, fn) => test(name, { skip: !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false }, fn);
let srv, browser;
after(async () => { await browser?.close(); srv?.kill(); if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true }); else console.log('kvar:', ROOT); });

const srtTime = (x) => { const ms = Math.round(x * 1000); const h = Math.floor(ms / 3600e3), m = Math.floor(ms / 60e3) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const srt = (cues) => cues.map(([s, e, text], i) => `${i + 1}\n${srtTime(s)} --> ${srtTime(e)}\n${text}\n`).join('\n');
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
// Repliker: svordomar 3–4,5 s och 16–17,5 s (förväntat tyst 2,75–4,8 och 15,75–17,8), vanliga repliker emellan
const CUES = [[1, 2, 'Hello there.'], [3, 4.5, 'What the <i>fuck</i> is this?'], [8, 9.5, 'Nice weather.'], [16, 17.5, 'Oh shit, run!'], [24, 25, 'Class dismissed.']];
const MUTE = [[2.75, 4.8], [15.75, 17.8]];

// ---------------- rena funktioner ----------------
test('ordlistorna: ordgräns, böjningar, sammansättningar, fraser och undantag', () => {
  const m = (s, l) => F.maskText(s, l);
  assert.equal(m('Fan, vad fans! Jävla skitbra. <i>Helvetet</i> hundskit', 'swe'), '***, vad fans! *** ***. <i>***</i> ***');
  assert.equal(m('What the FUCK, motherfucker? Son of a bitch!', 'eng'), 'What the ***, ***? ***!');
  assert.equal(m('Cocktail, class, glass, assess, hello, Dickens, pricked, Scunthorpe', 'eng'), 'Cocktail, class, glass, assess, hello, Dickens, pricked, Scunthorpe');
  assert.equal(m('{\\an8}Damn it, shitty bitches', 'en'), '{\\an8}*** it, *** ***');
  // Svenska orden prövas inte mot engelska undertexter (och tvärtom); okänt språk = båda
  assert.equal(m('fan club', 'eng'), 'fan club');
  assert.equal(m('Fan! Shit!', null), '***! ***!');
  assert.equal(F.hasProfanity('Hej på dig', 'sv'), false);
  assert.equal(F.hasProfanity('Jävlar!', 'sv'), true);
  assert.equal(F.maskVtt('WEBVTT\n\nNOTE fuck\n\n1\n00:00:01.000 --> 00:00:02.000 align:start\nOh shit!\n- Damn it.\n', 'en'),
    'WEBVTT\n\nNOTE fuck\n\n1\n00:00:01.000 --> 00:00:02.000 align:start\nOh ***!\n- *** it.\n');
  // Administratörens ord och avstängda inbyggda ord
  F.setCustomWords({ sv: ['Tusan', 'sjutton*', '*', 'a*b', ''], off: ['hell', 'påhittat'] });
  assert.deepEqual(F.customWords(), { sv: ['tusan', 'sjutton*'], en: [], off: ['hell'] });
  assert.equal(m('Tusan och sjuttonhundra!', 'sv'), '*** och ***!');
  assert.equal(m('Go to hell', 'en'), 'Go to hell');
  F.setCustomWords({ sv: [], en: [], off: [] });
  assert.equal(m('Go to hell', 'en'), 'Go to ***');
});

test('intervallen: hela repliken med marginal, nära intervall slås ihop, volymfiltret flyttas med körningens start', () => {
  assert.deepEqual(F.intervalsOf(CUES.map(([s, e, text]) => ({ s, e, text })), 'eng'), MUTE);
  assert.deepEqual(F.intervalsOf([{ s: 1, e: 2, text: 'Fan!' }, { s: 2.4, e: 3, text: 'Skit.' }, { s: 0.1, e: 0.5, text: 'jävlar' }], 'sv'), [[0, 3.3]]);
  assert.deepEqual(F.mergeIntervals([[5, 6], [1, 2], [2.5, 3]]), [[1, 3], [5, 6]]);
  assert.deepEqual(F.muteFilters(MUTE, 0), ["volume=volume=0:enable='between(t,2.750,4.800)+between(t,15.750,17.800)'"]);
  assert.deepEqual(F.muteFilters(MUTE, 12), ["volume=volume=0:enable='between(t,3.750,5.800)'"], 'intervall före körningen tas bort');
  assert.equal(F.muteFilters(Array.from({ length: 250 }, (_, i) => [i * 2, i * 2 + 1]), 0).length, 3, 'högst 100 intervall per filter');
  assert.deepEqual(F.muteFilters([], 0), []);
});

// ---------------- mot en riktig server ----------------
let admin = '', S = {};
async function req(p, { method = 'GET', body, tok = admin } = {}) {
  const h = {};
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (name, password = PW) => (await req('/api/login', { method: 'POST', body: { name, password, app: true }, tok: '' })).data.token;
async function until(fn, what, n = 240) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await sleep(250); }
  assert.fail('väntade förgäves: ' + what);
}
const FILM = 'Svordomar (2020)', WEBM = 'Webbfilmen (2021)';

before(async () => {
  if (!hasFfmpeg) return;
  const dir = path.join(MEDIA, 'Filmer', FILM), wdir = path.join(MEDIA, 'Filmer', WEBM);
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(wdir, { recursive: true });
  // H.264/AAC (MP4) med en nyckelbild per sekund: remux delar på 0, 6, 12, 18, 24 s
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '96k', '-metadata:s:a:0', 'language=eng', '-movflags', '+faststart', path.join(dir, FILM + '.mp4'));
  fs.writeFileSync(path.join(dir, FILM + '.en.srt'), srt(CUES));
  // WebM (Chromium i Playwright saknar H.264) – spelas direkt i webbläsaren
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', '-metadata:s:a:0', 'language=eng', path.join(wdir, WEBM + '.webm'));
  fs.writeFileSync(path.join(wdir, WEBM + '.en.srt'), srt(CUES));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', SUBINDEX_FTS: '' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});

// HLS: hämta mastern → spellistan → segmenten (från första till sista eller bara ett) och spara dem som en TS-fil
async function hlsFile(url, out, only = null) {
  const abs = (u, base) => new URL(u, base).href;
  const master = B + url;
  const mtext = await (await fetch(master)).text();
  const idx = abs(mtext.split('\n').find(l => l && !l.startsWith('#')), master);
  const list = (await (await fetch(idx)).text()).split('\n').filter(l => l && !l.startsWith('#')).map(l => abs(l, idx));
  const bufs = [];
  for (const [i, u] of list.entries()) {
    if (only != null && i !== only) continue;
    const r = await fetch(u); assert.equal(r.status, 200, u);
    bufs.push(Buffer.from(await r.arrayBuffer()));
  }
  fs.writeFileSync(out, Buffer.concat(bufs));
  return out;
}
const audioStart = (f) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', f]).toString()) || 0;
/** Högsta nivån (dB) i ljudet mellan a och b – ffmpeg volumedetect. -copyts: segmentens tider är filmens tider. */
function maxVolume(f, a, b) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-copyts', '-i', f, '-vn', '-af', `atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},volumedetect`, '-f', 'null', '-']);
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr.toString());
  assert.ok(m, r.stderr.toString().slice(-500));
  return m[1] === '-inf' ? -200 : parseFloat(m[1]);
}
const SILENT = -60, LOUD = -30;
function assertMuted(f, windows) {
  for (const [a, b, silent] of windows) {
    const v = maxVolume(f, a, b);
    if (silent) assert.ok(v < SILENT, `tyst ${a}–${b} s: ${v} dB`);
    else assert.ok(v > LOUD, `ljud ${a}–${b} s: ${v} dB`);
  }
}

t('förberedelse: bibliotek, indexerade repliker och barnprofil', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin');
  const lib = (await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).data.id;
  const items = await until(async () => { const r = (await req(`/api/libraries/${lib}/items`)).data.items; return r?.length === 2 && r; }, 'filmerna skannades');
  S.film = items.find(i => i.title === 'Svordomar').id; S.webm = items.find(i => i.title === 'Webbfilmen').id;
  // Barnprofiler ser bara titlar med en åldersgräns inom sin egen (utan TMDB har titlarna ingen)
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare('UPDATE items SET age=7 WHERE id IN (?,?)').run(S.film, S.webm);
  db.close();
  // Vuxna: filtret är av som standard – ingen plan, inga ändrade adresser
  const pb = (await req(`/api/items/${S.film}/playback?info=1`)).data;
  assert.equal(pb.filter, undefined);
  assert.ok(!pb.subtitles[0].url.includes('ff=1'));
  // Barnprofil med administratörens standard (tysta)
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lill', maxAge: 11 } })).status, 200);
  S.lillId = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lill').id;
  S.lill = (await req('/api/profiles/switch', { method: 'POST', body: { id: S.lillId }, tok: await login('admin') })).data.token;
  assert.equal((await req('/api/me/family-filter', { tok: S.lill })).data.mode, 'off');
  const A = (await req('/api/admin/family-filter', { method: 'PUT', body: { kidsDefault: 'mute' } })).data;
  assert.equal(A.kidsDefault, 'mute'); assert.ok(A.builtin.en.includes('fuck*'));
  assert.equal((await req('/api/admin/family-filter', { tok: S.lill })).status, 403, 'bara administratören');
  const me = (await req('/api/me/family-filter', { tok: S.lill })).data;
  assert.deepEqual([me.mode, me.setting, me.kid, me.canChange], ['mute', '', true, false]);
  assert.equal((await req('/api/me/family-filter', { method: 'PUT', body: { mode: 'off' }, tok: S.lill })).status, 403, 'barnet kan inte stänga av');
  const p = (await req('/api/profiles')).data.profiles.find(x => x.id === S.lillId);
  assert.deepEqual([p.familyFilter, p.familyMode], ['', 'mute']);
  // Replikerna indexeras efter skanningen – därefter har planen intervallen
  S.plan = await until(async () => { const f = (await req(`/api/items/${S.film}/playback?info=1&ffc=1`, { tok: S.lill })).data.filter; return f?.ready && f.mute.length && f; }, 'planen');
  assert.deepEqual(S.plan.mute, MUTE);
  assert.deepEqual([S.plan.mode, S.plan.item, S.plan.server, S.plan.skip], ['mute', S.film, false, []]);
});

t('planen: webbspelaren (ffc=1) spelar direkt, appar och Chromecast får ljudet tystat av servern', async () => {
  const web = (await req(`/api/items/${S.film}/playback?ffc=1`, { tok: S.lill })).data;
  assert.equal(web.mode, 'direct'); assert.equal(web.filter.server, false);
  const app = (await req(`/api/items/${S.film}/playback`, { tok: S.lill })).data;
  assert.equal(app.mode, 'remux', JSON.stringify(app.reasons));
  assert.ok(app.reasons.includes('familjefiltret tystar svordomar'));
  assert.ok(app.url.includes('ff=1'));
  assert.equal(app.filter.server, true); assert.deepEqual(app.filter.mute, MUTE);
  // Vuxen: oförändrat
  assert.equal((await req(`/api/items/${S.film}/playback`)).data.mode, 'direct');
  await req(`/api/stream/${S.film}/stop`, { method: 'POST', tok: S.lill });
});

t('undertexten maskeras för profilen med filtret på (även repliksökningen)', async () => {
  const pb = (await req(`/api/items/${S.film}/playback?info=1`, { tok: S.lill })).data;
  const u = pb.subtitles[0].url;
  assert.ok(u.includes('ff=1'), u);
  const kid = (await req(u, { tok: S.lill })).data;
  assert.match(kid, /What the <i>\*\*\*<\/i> is this\?/); assert.match(kid, /Oh \*\*\*, run!/); assert.match(kid, /Class dismissed/);
  assert.doesNotMatch(kid, /fuck|shit/);
  assert.match(kid, /(00:)?00:03\.000 --> (00:)?00:04\.500/, 'tiderna är orörda');
  // Samma adress för en vuxen: omaskerad (servern går på profilen, inte på adressen)
  assert.match((await req(u)).data, /fuck/);
  // Undertextsynken flyttar intervallen
  assert.equal((await req(`/api/items/${S.film}/subs/${pb.subtitles[0].id}/sync`, { method: 'PUT', body: { offset: 1, ratio: 1 } })).status, 200);
  assert.deepEqual((await req(`/api/items/${S.film}/playback?info=1&ffc=1`, { tok: S.lill })).data.filter.mute, [[3.75, 5.8], [16.75, 18.8]]);
  await req(`/api/items/${S.film}/subs/${pb.subtitles[0].id}/sync`, { method: 'PUT', body: { offset: 0, ratio: 1 } });
  const lines = (await req('/api/search/lines?q=run', { tok: S.lill })).data.lines;
  assert.equal(lines[0].line, 'Oh ***, run!'); assert.equal(lines[0].line.slice(...lines[0].marks[0]), 'run');
  assert.equal((await req('/api/search/lines?q=run')).data.lines[0].line, 'Oh shit, run!');
});

t('servern tystar ljudet i HLS-strömmen: remux från början, remux och omkodning efter spolning', async () => {
  // Hela filmen som remux (segment 0 → sista)
  const app = (await req(`/api/items/${S.film}/playback`, { tok: S.lill })).data;
  const all = await hlsFile(app.url, path.join(ROOT, 'remux.ts'));
  assertMuted(all, [[0.3, 2.5, false], [3.0, 4.6, true], [5.2, 15.4, false], [16.0, 17.6, true], [18.2, 29, false]]);
  // Spolning: en ny uppspelning från 12 s – ffmpeg startar med -ss mitt i filmen, intervallet ska ändå hamna rätt
  const seek = (await req(`/api/items/${S.film}/playback?start=12`, { tok: S.lill })).data;
  const s2 = await hlsFile(seek.url, path.join(ROOT, 'remux-seg2.ts'), 2); // 12–18 s
  const st = audioStart(s2);
  assert.ok(st > 11 && st < 13, 'segmentet börjar vid 12 s: ' + st);
  assertMuted(s2, [[12.5, 15.4, false], [16.0, 17.6, true]]); // TS-tiderna är filmens tider
  // Omkodning (force=transcode) från 12 s: segmentet 12–18 s (segmentindex 4: 0, 2, 4, 6, 12)
  const tc = (await req(`/api/items/${S.film}/playback?force=transcode&start=12`, { tok: S.lill })).data;
  assert.equal(tc.mode, 'transcode');
  const s4 = await hlsFile(tc.url, path.join(ROOT, 'tc-seg4.ts'), 4);
  assertMuted(s4, [[12.5, 15.4, false], [16.0, 17.6, true]]);
  await req(`/api/stream/${S.film}/stop`, { method: 'POST', tok: S.lill });
});

t('scener att hoppa över: vuxna markerar, barnet ser hushållets i läget Tysta + hoppa över', async () => {
  const add = (body, tok = admin) => req(`/api/items/${S.film}/skips`, { method: 'POST', body, tok });
  assert.equal((await add({ start: 20, end: 23, label: 'Läskigt', scope: 'household' })).status, 200);
  assert.equal((await add({ start: 26, end: 28, scope: 'me' })).status, 200);
  assert.equal((await add({ start: 5, end: 5.2 })).status, 400, 'för kort');
  assert.equal((await add({ start: 1, end: 2 }, S.lill)).status, 403, 'barnprofiler markerar inte');
  // Läget tysta: inga scener i planen
  assert.deepEqual((await req(`/api/items/${S.film}/playback?info=1&ffc=1`, { tok: S.lill })).data.filter.skip, []);
  // Huvudkontot sätter barnets läge till Tysta + hoppa över
  assert.equal((await req(`/api/profiles/${S.lillId}`, { method: 'PUT', body: { familyFilter: 'skip' } })).status, 200);
  assert.equal((await req(`/api/profiles/${S.lillId}`, { method: 'PUT', body: { familyFilter: 'konstigt' } })).status, 400);
  const plan = (await req(`/api/items/${S.film}/playback?info=1&ffc=1`, { tok: S.lill })).data.filter;
  assert.equal(plan.mode, 'skip');
  assert.deepEqual(plan.skip.map(k => [k.start, k.end, k.label]), [[20, 23, 'Läskigt']], 'bara hushållets – inte huvudkontots egna');
  const list = (await req(`/api/items/${S.film}/skips`, { tok: S.lill })).data;
  assert.equal(list.canAdd, false); assert.equal(list.skips[0].canDelete, false);
  assert.equal((await req('/api/skips/' + list.skips[0].id, { method: 'DELETE', tok: S.lill })).status, 403);
  // Ett annat konto ser inte hushållets markeringar
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'granne', password: PW } })).status, 200);
  const granne = await login('granne');
  assert.deepEqual((await req(`/api/items/${S.film}/skips`, { tok: granne })).data.skips, []);
  assert.equal((await req('/api/skips/' + list.skips[0].id, { method: 'DELETE', tok: granne })).status, 404);
  assert.equal((await req(`/api/items/${S.film}/skips`, { method: 'POST', body: { start: 1, end: 3, scope: 'all' }, tok: granne })).status, 403, 'bara administratören delar med alla');
  // Administratören tar bort; profilens läge tillbaka till standard
  assert.equal((await req('/api/skips/' + list.skips[0].id, { method: 'DELETE' })).status, 200);
  assert.equal((await req(`/api/profiles/${S.lillId}`, { method: 'PUT', body: { familyFilter: '' } })).status, 200);
  assert.equal((await req('/api/me/family-filter', { tok: S.lill })).data.mode, 'mute');
});

// ---------------- webbspelaren i Chromium ----------------
tw('webbspelaren: tystar exakt i intervallen, visar indikatorn och ***, hoppar över markerad scen', async () => {
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'vuxen', password: PW } })).status, 200);
  const vtok = await login('vuxen');
  assert.equal((await req('/api/me/family-filter', { method: 'PUT', body: { mode: 'skip' }, tok: vtok })).data.mode, 'skip');
  assert.equal((await req(`/api/items/${S.webm}/skips`, { method: 'POST', body: { start: 20, end: 24, scope: 'me' }, tok: vtok })).status, 200);
  await until(async () => (await req(`/api/items/${S.webm}/playback?info=1&ffc=1`, { tok: vtok })).data.filter?.mute?.length === 2, 'webbfilmens plan');
  const lr = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'vuxen', password: PW }) });
  const cookie = /kt=([0-9a-f]+)/.exec(lr.headers.get('set-cookie'))[1];
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const width of [1280, 375]) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 740 : 800 } });
    await ctx.addCookies([{ name: 'kt', value: cookie, url: B }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400 && !/\/api\/(image|items\/\d+\/trickplay)/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
    const pbReq = page.waitForRequest(r => r.url().includes(`/api/items/${S.webm}/playback`) && !r.url().includes('info=1'));
    await page.goto(B + '/#/item/' + S.webm);
    await page.click('[data-play="0"]');
    assert.ok((await pbReq).url().includes('ffc=1'), 'spelaren tystar själv');
    await page.waitForFunction(() => document.querySelector('#vid')?.readyState >= 2, null, { timeout: 60000 });
    // Logg över tiden och muted per bildruta (det spelaren faktiskt gör)
    await page.evaluate(() => {
      const v = document.querySelector('#vid'); window.__ff = [];
      const f = (_, md) => { window.__ff.push([md.mediaTime, v.muted, !document.querySelector('#ffbadge').hidden]); v.requestVideoFrameCallback(f); };
      v.requestVideoFrameCallback(f);
    });
    // Undertexten (engelska) på – *** visas
    await page.evaluate(() => { const s = document.querySelector('#ps'); s.value = s.options[1].value; s.dispatchEvent(new Event('change')); });
    await page.evaluate(() => { const v = document.querySelector('#vid'); v.currentTime = 2.2; v.play(); });
    await page.waitForFunction(() => document.querySelector('#vid').currentTime > 3.6, null, { timeout: 30000 });
    await page.waitForFunction(() => /\*\*\*/.test(document.querySelector('#subtxt')?.textContent || ''), null, { timeout: 10000 });
    assert.doesNotMatch(await page.textContent('#subtxt'), /fuck/);
    assert.equal(await page.isVisible('#ffbadge'), true);
    assert.match(await page.textContent('#ffbadge'), /familjefiltret/);
    // Ljudknappen visar användarens val (ljud på), inte filtrets tystnad
    assert.match(await page.getAttribute('#cmute', 'aria-label'), /Stäng av ljudet/);
    if (width === 1280) await shot(page, 'familjefilter-tystat-1280'); else await shot(page, 'familjefilter-tystat-375');
    await page.waitForFunction(() => document.querySelector('#vid').currentTime > 5.3, null, { timeout: 30000 });
    // Scen att hoppa över: 20–24 s
    await page.evaluate(() => { document.querySelector('#vid').currentTime = 19.3; });
    await page.waitForFunction(() => document.querySelector('#vid').currentTime >= 24, null, { timeout: 20000 });
    await page.waitForFunction(() => /Hoppade över/.test(document.querySelector('#ffbadge')?.textContent || ''), null, { timeout: 5000 });
    const log = await page.evaluate(() => window.__ff);
    const at = (a, b) => log.filter(([t]) => t >= a && t <= b);
    assert.ok(at(3.0, 4.6).length > 5, 'bildrutor i intervallet: ' + JSON.stringify(log.slice(0, 40)));
    assert.ok(at(2.8, 4.75).every(([, m]) => m), 'tyst i hela intervallet: ' + JSON.stringify(at(2.6, 5)));
    assert.ok(at(2.2, 2.68).every(([, m]) => !m) && at(4.9, 5.3).every(([, m]) => !m), 'ljud före och efter: ' + JSON.stringify(at(2.2, 5.3)));
    assert.ok(at(3.0, 4.6).every(([, , b]) => b), 'indikatorn syns');
    assert.ok(!log.some(([t]) => t > 20.3 && t < 23.7), 'scenen spelades inte');
    // Inställningarna: gruppen Familjefilter med markering
    await page.evaluate(() => document.querySelector('#cset').click()); // kontrollerna är dolda medan filmen spelas
    assert.match(await page.textContent('#ffgrp'), /Tystar svordomar och hoppar över/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
