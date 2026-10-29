// Språkinlärningsläget: ordlistan per profil (server/vocab.js, server/routes/vocab.js) och webbspelaren
// (web/js/player/learn.js, views/vocab.js). Testfilerna skapas med ffmpeg: en WebM-film (spelas direkt i Chromium)
// med två externa SRT – engelska (målspråket) och svenska (översättningen) på nästan samma tider – och en film i ett
// annat bibliotek. Kontrolleras: export till Anki (TSV/CSV med filhuvud, citattecken, ZIP med ljudklipp som MP3),
// behörighet (andra profiler, biblioteksbehörighet, nedladdningsrätt), dubbletter och i Chromium: dubbla undertexter
// (översättningen under repliken), paus efter repliken, upprepa (r), långsamt (x) med tillbakaställd hastighet,
// nästa/föregående (d/a), ord som sparas med mus och tangentbord, telefonbredd och vyn #/vocab. Kräver ffmpeg;
// webbdelen kräver Playwright.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { auditPage } from './helpers/a11y-audit.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-learn-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 31000 + Math.floor(Math.random() * 900);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const SHOTS = process.env.SHOTS || '';
process.env.CONFIG_DIR = path.join(ROOT, 'unitconfig');
process.env.TRANSCODE_DIR = path.join(ROOT, 'unit-tc');
const V = await import('../server/vocab.js');
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
const tw = (name, fn) => test(name, { skip: !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false, timeout: 300000 }, fn);
let srv, browser;
after(async () => { await browser?.close(); srv?.kill(); if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true }); });

const srtTime = (x) => { const ms = Math.round(x * 1000); const h = Math.floor(ms / 3600e3), m = Math.floor(ms / 60e3) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const srt = (cues) => cues.map(([s, e, text], i) => `${i + 1}\n${srtTime(s)} --> ${srtTime(e)}\n${text}\n`).join('\n');
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const EN = [[2, 4, 'Hello there, my friend.'], [6, 8, "I'll be back."], [10, 12, 'See you tomorrow.']];
const SV = [[2.1, 4, 'Hej där, min vän.'], [6, 8, 'Jag kommer tillbaka.'], [10.2, 12, 'Vi ses i morgon.']];
const FILM = 'Lektionen (2020)';

// ---------------- rena funktioner ----------------
test('export: Ankis filhuvud, citattecken i CSV, tabbar bort i TSV, ljudfältet bara med ZIP', () => {
  const rows = [{ id: 7, word: 'friend', sentence: 'Hello, "my" friend.', translation: 'Hej, min vän.', source: 'Film (2020)' },
    { id: 8, word: 'tab', sentence: 'A\tB', translation: '', source: 'X' }];
  const tsv = V.exportText(rows, 'tsv').split('\n');
  assert.deepEqual(tsv.slice(0, 3), ['#separator:Tab', '#html:false', '#columns:Ord\tMening\tÖversättning\tKälla']);
  assert.equal(tsv[3], 'friend\tHello, "my" friend.\tHej, min vän.\tFilm (2020)');
  assert.equal(tsv[4], 'tab\tA B\t\tX');
  const csv = V.exportText(rows, 'csv').split('\n');
  assert.equal(csv[0], '#separator:Comma');
  assert.equal(csv[3], 'friend,"Hello, ""my"" friend.","Hej, min vän.",Film (2020)');
  const z = V.exportText(rows, 'tsv', new Set([7])).split('\n');
  assert.match(z[2], /\tLjud$/);
  assert.match(z[3], /\t\[sound:braxhn-7\.mp3\]$/);
  assert.match(z[4], /\t$/);
  assert.deepEqual(V.parse({ word: '  ' }).error, 'Ordet saknas');
  assert.deepEqual(V.parse({ word: '!!' }).error, 'Ordet saknas');
  const w = V.parse({ word: 'x'.repeat(300), sentence: 'a\u0000b\n c', start: 2, end: 1, audio: '1', lang: 'en<script>' });
  assert.equal(w.word.length, 100); assert.equal(w.sentence, 'ab c'); assert.equal(w.e, null); assert.equal(w.audio, 1); assert.equal(w.lang, 'enscript');
});

test('zip: lagrade poster som går att läsa (python zipfile)', () => {
  const buf = V.zip([{ name: 'ordlista.txt', data: Buffer.from('hej å\n') }, { name: 'braxhn-1.mp3', data: Buffer.from([1, 2, 3]) }]);
  const f = path.join(ROOT, 'u.zip'); fs.writeFileSync(f, buf);
  const r = spawnSync('python3', ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(z.namelist(), z.read("ordlista.txt").decode())', f]);
  if (r.error) return; // utan python: bara att det inte kastar
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(r.stdout.toString(), /\['ordlista\.txt', 'braxhn-1\.mp3'\] hej å/);
});

// ---------------- mot en riktig server ----------------
let admin = '', S = {};
async function req(p, { method = 'GET', body, tok = admin, raw = false } = {}) {
  const h = {};
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: raw ? Buffer.from(await r.arrayBuffer()) : ct.includes('json') ? await r.json() : await r.text() };
}
const login = async (name) => (await req('/api/login', { method: 'POST', body: { name, password: PW, app: true }, tok: '' })).data.token;
async function until(fn, what, n = 120) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await sleep(500); }
  assert.fail('väntade förgäves: ' + what);
}

before(async () => {
  if (!hasFfmpeg) return;
  const dir = path.join(MEDIA, 'Filmer', FILM), other = path.join(MEDIA, 'Annat', 'Annan (2019)');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', '-metadata:s:a:0', 'language=eng', path.join(dir, FILM + '.webm'));
  fs.writeFileSync(path.join(dir, FILM + '.en.srt'), srt(EN));
  fs.writeFileSync(path.join(dir, FILM + '.sv.srt'), srt(SV));
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '6',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', path.join(other, 'Annan (2019).webm'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});

t('förberedelse: konto, två bibliotek och användare med begränsningar', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin');
  S.F = (await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).data.id;
  S.A = (await req('/api/libraries', { method: 'POST', body: { name: 'Annat', type: 'movie', path: path.join(MEDIA, 'Annat') } })).data.id;
  S.film = await until(async () => (await req(`/api/libraries/${S.F}/items`)).data.items?.[0]?.id, 'filmen skannades');
  S.annan = await until(async () => (await req(`/api/libraries/${S.A}/items`)).data.items?.[0]?.id, 'den andra filmen skannades');
  const it = (await req(`/api/items/${S.film}`)).data;
  assert.deepEqual(it.subtitles.filter(s => !s.bitmap).map(s => s.lang), ['en', 'sv']);
  S.audio = it.audio[0].index;
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW, libraries: [S.A] } })).status, 200);
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'kim', password: PW, canDownload: false } })).status, 200);
  S.bo = await login('bo'); S.kim = await login('kim');
});

t('ordlistan: spara, dubblett, lista, ändra, behörighet per profil och bibliotek', async () => {
  const word = { itemId: S.film, word: 'friend', sentence: 'Hello there, my friend.', translation: 'Hej där, min vän.', start: 2, end: 4, position: 3.1, lang: 'en', audio: S.audio };
  const r = await req('/api/vocab', { method: 'POST', body: word });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.dup, false);
  S.w1 = r.data.id;
  assert.deepEqual((await req('/api/vocab', { method: 'POST', body: { ...word, word: 'FRIEND' } })).data, { id: S.w1, dup: true });
  assert.equal((await req('/api/vocab', { method: 'POST', body: { ...word, word: '' } })).status, 400);
  assert.equal((await req('/api/vocab', { method: 'POST', body: { ...word, itemId: 999999 } })).status, 404);
  assert.equal((await req('/api/vocab', { method: 'POST', body: { ...word, word: 'back', sentence: "I'll be back.", translation: 'Jag kommer tillbaka.', start: 6, end: 8 } })).status, 200);
  const list = (await req('/api/vocab')).data.words;
  assert.equal(list.length, 2);
  const f = list.find(w => w.word === 'friend');
  assert.equal(f.sentence, 'Hello there, my friend.'); assert.equal(f.translation, 'Hej där, min vän.');
  assert.equal(f.source, 'Lektionen (2020)'); assert.equal(f.start, 2); assert.equal(f.end, 4); assert.equal(f.itemId, S.film); assert.equal(f.clip, true);
  assert.deepEqual((await req(`/api/vocab?q=tillbaka`)).data.words.map(w => w.word), ['back']);
  assert.deepEqual((await req(`/api/vocab?item=${S.annan}`)).data.words, []);
  const u = await req('/api/vocab/' + S.w1, { method: 'PUT', body: { translation: '  Hej, min vän!  ' } });
  assert.equal(u.status, 200); assert.equal(u.data.translation, 'Hej, min vän!');
  // Bo: får inte se biblioteket Filmer – kan inte spara ord ur filmen och ser inte administratörens ord
  assert.equal((await req('/api/vocab', { method: 'POST', body: word, tok: S.bo })).status, 404);
  assert.deepEqual((await req('/api/vocab', { tok: S.bo })).data.words, []);
  assert.equal((await req('/api/vocab/' + S.w1, { method: 'DELETE', tok: S.bo })).status, 404);
  assert.equal((await req('/api/vocab/' + S.w1, { method: 'PUT', body: { word: 'x' }, tok: S.bo })).status, 404);
  assert.equal((await req(`/api/vocab/${S.w1}/clip`, { tok: S.bo, raw: true })).status, 404);
  assert.equal((await req('/api/vocab', { method: 'POST', body: { ...word, itemId: S.annan }, tok: S.bo })).status, 200);
  assert.equal((await req('/api/vocab', { tok: S.bo })).data.words.length, 1);
  assert.equal((await req('/api/vocab', { tok: '' })).status, 401);
  // Biblioteket tas ifrån Bo: orden från den filmen döljs
  const boId = (await req('/api/users')).data.find(x => x.name === 'bo').id;
  assert.equal((await req(`/api/users/${boId}`, { method: 'PUT', body: { libraries: [S.F] } })).status, 200);
  assert.deepEqual((await req('/api/vocab', { tok: S.bo })).data.words, []);
});

t('export: TSV/CSV som nedladdning, ljudklipp (MP3) och ZIP – nedladdningsrätten krävs för ljud', async () => {
  const tsv = await req('/api/vocab/export?format=tsv');
  assert.equal(tsv.status, 200);
  assert.match(tsv.headers.get('content-type'), /^text\/tab-separated-values/);
  assert.match(tsv.headers.get('content-disposition'), /attachment; filename="ordlista-\d{4}-\d\d-\d\d\.txt"/);
  const lines = tsv.data.replace(/^﻿/, '').trim().split('\n');
  assert.equal(lines[0], '#separator:Tab');
  assert.ok(lines.includes('friend\tHello there, my friend.\tHej, min vän!\tLektionen (2020)'), lines.join('\n'));
  const csv = await req('/api/vocab/export?format=csv');
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.ok(csv.data.includes('friend,"Hello there, my friend.","Hej, min vän!",Lektionen (2020)'), csv.data);
  // Ljudklippet: repliken 2–4 s med marginal, MP3
  const clip = await req(`/api/vocab/${S.w1}/clip`, { raw: true });
  assert.equal(clip.status, 200); assert.equal(clip.headers.get('content-type'), 'audio/mpeg');
  const mp3 = path.join(ROOT, 'clip.mp3'); fs.writeFileSync(mp3, clip.data);
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3]).toString());
  assert.ok(dur > 2.2 && dur < 2.9, 'längd ' + dur);
  const z = await req('/api/vocab/export?format=zip', { raw: true });
  assert.equal(z.status, 200); assert.equal(z.headers.get('content-type'), 'application/zip');
  const zf = path.join(ROOT, 'o.zip'); fs.writeFileSync(zf, z.data);
  const py = spawnSync('python3', ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print("|".join(sorted(z.namelist())));print(z.read("ordlista.txt").decode())', zf]);
  if (!py.error) {
    assert.equal(py.status, 0, py.stderr.toString());
    const [names, ...txt] = py.stdout.toString().split('\n');
    assert.equal(names.split('|').filter(n => n.endsWith('.mp3')).length, 2);
    assert.ok(txt.some(l => l.startsWith('friend\t') && l.endsWith(`[sound:braxhn-${S.w1}.mp3]`)), txt.join('\n'));
  }
  // Kim får inte ladda ner: text ja, ljud nej
  const kw = await req('/api/vocab', { method: 'POST', tok: S.kim, body: { itemId: S.film, word: 'tomorrow', sentence: 'See you tomorrow.', start: 10, end: 12 } });
  assert.equal(kw.status, 200);
  assert.equal((await req('/api/vocab/export?format=tsv', { tok: S.kim })).status, 200);
  assert.equal((await req('/api/vocab/export?format=zip', { tok: S.kim, raw: true })).status, 403);
  assert.equal((await req(`/api/vocab/${kw.data.id}/clip`, { tok: S.kim, raw: true })).status, 403);
  // Borttagen titel: ordet finns kvar med källan, men utan ljudklipp
  assert.equal((await req('/api/vocab/' + kw.data.id, { method: 'DELETE', tok: S.kim })).status, 200);
  assert.deepEqual((await req('/api/vocab', { tok: S.kim })).data.words, []);
});

// ---------------- webbspelaren i Chromium ----------------
tw('webbspelaren: dubbla undertexter, paus efter repliken, upprepa, långsamt, nästa/föregående och ord som sparas', async () => {
  const lr = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) });
  const cookie = /kt=([0-9a-f]+)/.exec(lr.headers.get('set-cookie'))[1];
  // Rena ordlistan från förra testet
  for (const w of (await req('/api/vocab')).data.words) await req('/api/vocab/' + w.id, { method: 'DELETE' });
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const mode of ['desktop', 'phone']) {
    const phone = mode === 'phone';
    const ctx = await browser.newContext(phone ? { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name: 'kt', value: cookie, url: B }]);
    await ctx.addInitScript(() => { try { localStorage.setItem('braxhn-tv.learn', 'true'); } catch {} });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400 && !/\/api\/(image|items\/\d+\/trickplay)/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
    await page.goto(B + '/#/item/' + S.film);
    await page.click('[data-play="0"]');
    await page.waitForFunction(() => document.querySelector('#vid')?.readyState >= 2, null, { timeout: 60000 });
    await page.waitForSelector('#plearnbar:not([hidden]) #lrep');
    assert.equal(await page.isChecked('#plearn'), true, 'valet sparat i webbläsaren');
    // Målspråk engelska, översättning svenska
    await page.evaluate(() => {
      const v = document.querySelector('#vid'); v.pause();
      const pick = (sel, lang) => { const s = document.querySelector(sel); s.value = [...s.options].find(o => o.textContent.startsWith(lang)).value; s.dispatchEvent(new Event('change')); };
      pick('#ps', 'en'); pick('#ps2', 'sv');
    });
    await page.waitForFunction(() => document.querySelector('#lhint')?.textContent === '');
    await page.evaluate(() => { const v = document.querySelector('#vid'); v.currentTime = 2.4; v.play(); });
    // Dubbla undertexter: repliken som ord-knappar och översättningen under
    await page.waitForFunction(() => document.querySelectorAll('#subtxt .lw').length === 4, null, { timeout: 20000 });
    assert.deepEqual(await page.$$eval('#subtxt .lw', b => b.map(x => x.textContent)), ['Hello', 'there', 'my', 'friend']);
    assert.equal(await page.textContent('#subtxt .ltr'), 'Hej där, min vän.');
    assert.equal(await page.isVisible('#sub2'), false, 'den övre andra undertexten döljs i läget');
    // Paus efter repliken (slutar 4,0 s)
    await page.waitForFunction(() => document.querySelector('#vid').paused, null, { timeout: 10000 });
    let tm = await page.evaluate(() => document.querySelector('#vid').currentTime);
    assert.ok(tm > 3.6 && tm < 4.0, 'pausad vid repliken slut: ' + tm);
    await page.waitForFunction(() => document.querySelector('#pstate').textContent === 'Pausad efter repliken');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `learn-${mode}.png`) });
    // Ord sparas med klick/tryck: meningen, översättningen och tiden
    if (phone) await page.tap('#subtxt .lw:nth-of-type(4)'); else await page.click('#subtxt .lw:nth-of-type(4)');
    await page.waitForSelector('#subtxt .lw.saved');
    let words = (await req('/api/vocab')).data.words;
    const fr = words.find(w => w.word === 'friend');
    assert.ok(fr, JSON.stringify(words));
    assert.equal(fr.sentence, 'Hello there, my friend.'); assert.equal(fr.translation, 'Hej där, min vän.');
    assert.equal(fr.start, 2); assert.equal(fr.end, 4); assert.equal(fr.lang, 'en'); assert.equal(fr.source, 'Lektionen (2020)');
    // Upprepa (r): tillbaka till 2 s, spelar och pausar vid slutet igen
    await page.focus('#cplay');
    await page.keyboard.press('r');
    await page.waitForFunction(() => { const v = document.querySelector('#vid'); return !v.paused && v.currentTime < 3; }, null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#vid').paused, null, { timeout: 10000 });
    tm = await page.evaluate(() => document.querySelector('#vid').currentTime);
    assert.ok(tm > 3.6 && tm < 4.0, 'upprepningen stannade vid slutet: ' + tm);
    // Långsamt (x): 0,75× med bibehållen tonhöjd under repliken, sedan tillbaka till normal hastighet
    await page.keyboard.press('x');
    await page.waitForFunction(() => { const v = document.querySelector('#vid'); return !v.paused && v.playbackRate === 0.75 && v.preservesPitch; }, null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#vid').paused, null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => document.querySelector('#vid').playbackRate), 1);
    // Nästa replik (d) och föregående (a)
    await page.keyboard.press('d');
    await page.waitForFunction(() => { const v = document.querySelector('#vid'); return v.currentTime >= 6 && v.currentTime < 7; }, null, { timeout: 5000 });
    await page.waitForFunction(() => [...document.querySelectorAll('#subtxt .lw')].map(b => b.textContent).join(' ') === "I'll be back", null, { timeout: 5000 });
    assert.equal(await page.textContent('#subtxt .ltr'), 'Jag kommer tillbaka.');
    await page.waitForFunction(() => document.querySelector('#vid').paused, null, { timeout: 10000 });
    tm = await page.evaluate(() => document.querySelector('#vid').currentTime);
    assert.ok(tm > 7.6 && tm < 8.0, 'paus efter andra repliken: ' + tm);
    await page.keyboard.press('a');
    await page.waitForFunction(() => { const v = document.querySelector('#vid'); return v.currentTime >= 2 && v.currentTime < 3.5; }, null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#vid').paused, null, { timeout: 10000 });
    // Tangentbordet: w väljer första ordet, → nästa, Enter sparar
    await page.keyboard.press('w');
    await page.waitForFunction(() => document.activeElement?.classList.contains('lw'));
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'there');
    await page.keyboard.press('Enter');
    await until(async () => (await req('/api/vocab')).data.words.some(w => w.word === 'there'), 'ordet sparades med tangentbordet', 20);
    // Paus efter repliken av (p): spelar förbi slutet
    await page.keyboard.press('Escape');
    await page.keyboard.press('p');
    assert.equal(await page.getAttribute('#lauto', 'aria-pressed'), 'false');
    await page.evaluate(() => { const v = document.querySelector('#vid'); v.currentTime = 3.2; v.play(); });
    await page.waitForFunction(() => document.querySelector('#vid').currentTime > 4.4, null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => document.querySelector('#vid').paused), false);
    await page.keyboard.press('p');
    // Verktygsraden: tillgänglig och utan vågrät rullning på telefonen
    const a = await page.evaluate(auditPage, { scope: '#plearnbar', contrast: false });
    assert.deepEqual(a, [], JSON.stringify(a));
    if (phone) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'ingen vågrät rullning');
    // Ordlistan
    await page.evaluate(() => document.querySelector('#vid').pause());
    await page.click('#lvocab');
    await page.waitForSelector('.vocab .vrow');
    words = (await req('/api/vocab')).data.words;
    assert.equal(await page.$$eval('.vocab .vrow', r => r.length), words.length);
    assert.match(await page.textContent('.vocab'), /Hej där, min vän\./);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `vocab-${mode}.png`), fullPage: true });
    const av = await page.evaluate(auditPage, { scope: '#main', contrast: true });
    assert.deepEqual(av, [], JSON.stringify(av));
    // Ta bort med bekräftelse
    await page.click('.vocab .vrow [data-del]');
    await page.click('dialog[open] .danger, dialog[open] button.danger');
    await page.waitForFunction((n) => document.querySelectorAll('.vocab .vrow').length === n - 1, words.length);
    assert.deepEqual(errors, []);
    for (const w of (await req('/api/vocab')).data.words) await req('/api/vocab/' + w.id, { method: 'DELETE' });
    await ctx.close();
  }
});
