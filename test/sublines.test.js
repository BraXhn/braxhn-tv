// Repliksökning (server/sublines.js): textundertexter (inbäddade spår och externa filer) indexeras i FTS5 och söks med
// /api/search/lines. Testfilerna skapas med ffmpeg: en film med två inbäddade textspår (svenska med å ä ö, engelska),
// en extern .srt och en film i ett annat bibliotek. Kontrolleras: träff med markering, sammanhang, tidpunkt (även efter
// undertextsynk), inkrementell omindexering, borttagning med titeln, behörighet (bibliotek och barnprofil) och
// reserven utan FTS5 (LIKE). Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-lines-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 27000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
// Modulen i den här processen: reserven utan FTS5 (egen databas)
process.env.CONFIG_DIR = path.join(ROOT, 'unitconfig');
process.env.TRANSCODE_DIR = path.join(ROOT, 'unit-tc');
process.env.SUBINDEX_FTS = '0';
const L = await import('../server/sublines.js');
const D = await import('../server/db.js');
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
let srv;
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const srtTime = (x) => { const ms = Math.round(x * 1000); const h = Math.floor(ms / 3600e3), m = Math.floor(ms / 60e3) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const srt = (cues) => cues.map(([s, e, text], i) => `${i + 1}\n${srtTime(s)} --> ${srtTime(e)}\n${text}\n`).join('\n');
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const video = (file, dur = 20) => ff('-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=10`, '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', String(dur),
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '20', '-c:a', 'aac', file);

test('text: formatering bort, ord som FTS5, markering och repliker ur WebVTT', () => {
  assert.equal(L.cleanText('{\\an8}<i>Jag är</i>\ndin far &amp; mer'), 'Jag är din far & mer');
  assert.deepEqual(L.wordsOf("I'll be BACK – Åsa öl"), ['i', 'll', 'be', 'back', 'åsa', 'öl']);
  assert.deepEqual(L.marksOf('Luke… jag ÄR din fader.', ['är', 'din', 'fa']), [[10, 22]], 'sista ordet som prefix markeras helt');
  assert.deepEqual(L.marksOf('Hej, hej! Hejsan', ['hej']), [[0, 3], [5, 8], [10, 16]]);
  assert.deepEqual(L.marksOf('kär dinosaurie', ['är', 'din']), [], 'mitt i ett ord räknas inte');
  const cues = L.cuesOf('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<b>Hej</b>\n\n00:00:02.000 --> 00:00:03.000\nHej\n\n00:00:04.000 --> 00:00:05.000\n♪\n\n1:00:00.500 --> 1:00:01.000\nSlut\n');
  assert.deepEqual(cues, [{ s: 1, e: 2, text: 'Hej' }, { s: 3600.5, e: 3601, text: 'Slut' }]);
});

test('reserven utan FTS5: LIKE på normaliserad text, prefix på sista ordet, åldersfilter i SQL', () => {
  assert.equal(D.FTS5, false);
  const lib = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('F','movie','/x')").lastInsertRowid);
  const id = Number(D.run("INSERT INTO items(library_id,kind,title,sort_title,path,mtime,age,added) VALUES(?,'movie','Rymden','rymden','/x/a.mkv',1,7,1)", lib).lastInsertRowid);
  const w = { key: 'e2', sub: { lang: 'swe', label: 'Svenska' }, sig: 'e:1', fmtime: null };
  L.store({ id }, w, [{ s: 1, e: 2, text: 'Hej på dig.' }, { s: 10, e: 12, text: 'Nej. Jag är din far!' }, { s: 14, e: 15, text: 'Nej, nej!' }]);
  const all = { age: { sql: '', params: [] }, allowed: () => true };
  const r = L.search('jag är din f', all);
  assert.equal(r.length, 1);
  assert.equal(r[0].t, 10); assert.equal(r[0].line, 'Nej. Jag är din far!');
  assert.deepEqual(r[0].marks, [[5, 19]]);
  assert.equal(r[0].before, 'Hej på dig.'); assert.equal(r[0].after, 'Nej, nej!');
  assert.equal(L.search('ar din', all).length, 0, 'å ä ö är egna bokstäver');
  assert.equal(L.search('JAG ÄR', all).length, 1, 'versaler gör inget');
  assert.equal(L.search('100%_', all).length, 0);
  assert.equal(L.search('x', all).length, 0, 'för kort');
  // Åldersfiltret går in i frågan (i = titeln, s = serie/huvudrad)
  assert.equal(L.search('din far', { age: { sql: ' AND COALESCE(i.age, s.age, ?) <= ?', params: [999, 6] }, allowed: () => true }).length, 0);
  assert.equal(L.search('din far', { ...all, allowed: () => false }).length, 0);
  // Med titeln försvinner replikerna (kaskad)
  D.run('DELETE FROM items WHERE id=?', id);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM sub_lines').n, 0);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM sub_index').n, 0);
});

// ---------------- mot en riktig server (FTS5) ----------------
let admin = '', S = {};
async function req(p, { method = 'GET', body, tok = admin } = {}) {
  const h = {};
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (name, password) => (await req('/api/login', { method: 'POST', body: { name, password, app: true }, tok: '' })).data.token;
const lines = async (q, tok = admin) => (await req(`/api/search/lines?q=${encodeURIComponent(q)}`, { tok })).data;
async function until(fn, what, n = 120) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await sleep(500); }
  assert.fail('väntade förgäves: ' + what);
}
const FILM = 'Stjärnornas krig (1980)';
const EXT = () => path.join(MEDIA, 'Filmer', FILM, `${FILM}.en.srt`);

before(async () => {
  if (!hasFfmpeg) return;
  const dir = path.join(MEDIA, 'Filmer', FILM);
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(MEDIA, 'Hemligt'), { recursive: true });
  const v = path.join(ROOT, 'v.mkv'); video(v);
  const sv = path.join(ROOT, 'sv.srt'), en = path.join(ROOT, 'en.srt');
  fs.writeFileSync(sv, srt([[1, 2.5, 'Luke, kom hit.'], [3, 5, '<i>Nej. Jag är din far.</i>'], [6, 8, 'Det är omöjligt!\nNej, nej!'], [9, 11, 'Sök i dina känslor.']]));
  fs.writeFileSync(en, srt([[3, 5, 'No. I am your father.'], [12, 14, 'Search your feelings.']]));
  ff('-i', v, '-i', sv, '-i', en, '-map', '0', '-map', '1', '-map', '2', '-c', 'copy', '-c:s', 'srt',
    '-metadata:s:s:0', 'language=swe', '-metadata:s:s:1', 'language=eng', path.join(dir, `${FILM}.mkv`));
  fs.writeFileSync(EXT(), srt([[2, 3, 'Hello there.'], [15, 17, "I'll be back."], [18, 19, 'Hasta la vista.']]));
  video(path.join(MEDIA, 'Hemligt', 'Hemlig (2019).mkv'));
  fs.writeFileSync(path.join(MEDIA, 'Hemligt', 'Hemlig (2019).sv.srt'), srt([[4, 6, 'Jag är din far, sa den hemliga.']]));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', SUBINDEX_FTS: '' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});

t('indexering: inbäddade spår och extern fil, sökning med markering, sammanhang och tidpunkt', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin', PW);
  S.F = (await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).data.id;
  S.X = (await req('/api/libraries', { method: 'POST', body: { name: 'Hemligt', type: 'movie', path: path.join(MEDIA, 'Hemligt') } })).data.id;
  S.film = await until(async () => (await req(`/api/libraries/${S.F}/items`)).data.items?.[0]?.id, 'filmen skannades');
  S.hem = await until(async () => (await req(`/api/libraries/${S.X}/items`)).data.items?.[0]?.id, 'den hemliga filmen skannades');
  // Indexeringen startar strax efter skanningen
  const d = await until(async () => { const x = await lines('jag är din far'); return x.lines.length >= 2 && !x.status.indexing && x.status.titles === 2 && x; }, 'replikerna indexerades');
  assert.equal(d.status.fts, true);
  const hit = d.lines.find(l => l.id === S.film);
  assert.ok(hit, JSON.stringify(d.lines));
  assert.equal(hit.kind, 'movie'); assert.equal(hit.title, 'Stjärnornas krig'); assert.equal(hit.year, 1980);
  assert.equal(hit.line, 'Nej. Jag är din far.'); assert.equal(hit.t, 3); assert.equal(hit.end, 5);
  assert.deepEqual(hit.marks, [[5, 19]]); assert.equal(hit.line.slice(5, 19), 'Jag är din far');
  assert.equal(hit.before, 'Luke, kom hit.'); assert.equal(hit.after, 'Det är omöjligt! Nej, nej!');
  assert.equal(hit.lang, 'swe');
  // Engelska spåret, prefix på sista ordet, versaler och apostrof
  const en = (await lines('I AM YOUR FATH')).lines;
  assert.equal(en.length, 1); assert.equal(en[0].t, 3); assert.equal(en[0].lang, 'eng');
  const back = (await lines("i'll be back")).lines;
  assert.equal(back.length, 1); assert.equal(back[0].t, 15); assert.equal(back[0].label, 'en (fil)');
  assert.equal(back[0].after, 'Hasta la vista.');
  assert.deepEqual((await lines('omöjligt')).lines.map(l => l.t), [6]);
  assert.equal((await lines('omojligt')).lines.length, 0);
  assert.deepEqual((await lines('')).lines, []);
  // Indexet finns i databasen: tre undertexter för filmen, en för den hemliga
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT sub FROM sub_index WHERE item_id=? ORDER BY sub').all(S.film).map(r => r.sub), ['e2', 'e3', `external:${FILM}.en.srt`]);
  } finally { db.close(); }
  // Jobbet syns i aktivitetspanelen när det körs – nu är det klart
  assert.ok(!(await req('/api/jobs')).data.jobs.some(j => j.kind === 'subindex'));
});

t('undertextsynken gäller direkt: tiden flyttas utan omindexering', async () => {
  const pb = (await req(`/api/items/${S.film}/playback?info=1`)).data;
  const sub = pb.subtitles.find(s => s.source === 'external');
  assert.equal((await req(`/api/items/${S.film}/subs/${sub.id}/sync`, { method: 'PUT', body: { offset: 2.5, ratio: 1 } })).status, 200);
  assert.equal((await lines("i'll be back")).lines[0].t, 17.5);
  await req(`/api/items/${S.film}/subs/${sub.id}/sync`, { method: 'PUT', body: { offset: 0, ratio: 1 } });
  assert.equal((await lines("i'll be back")).lines[0].t, 15);
});

t('inkrementellt: ändrad fil indexeras om, borttagen fil och titel försvinner', async () => {
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'), { readOnly: true });
  const updated = () => db.prepare('SELECT sub, updated, sig FROM sub_index WHERE item_id=? ORDER BY sub').all(S.film);
  try {
    const before = updated();
    fs.writeFileSync(EXT(), srt([[2, 3, 'Hello there.'], [20, 22, 'Ny replik med räksmörgås.']]));
    fs.utimesSync(EXT(), new Date(), new Date(Date.now() + 5000));
    assert.equal((await req('/api/scan', { method: 'POST' })).status, 200);
    await until(async () => (await lines('räksmörgås')).lines.length === 1, 'den ändrade filen indexerades om');
    assert.equal((await lines("i'll be back")).lines.length, 0);
    const after = updated();
    // De inbäddade spåren lästes inte om
    assert.deepEqual(after.filter(r => /^e\d/.test(r.sub)), before.filter(r => /^e\d/.test(r.sub)));
    fs.rmSync(EXT());
    assert.equal((await req('/api/scan', { method: 'POST' })).status, 200);
    await until(async () => (await lines('räksmörgås')).lines.length === 0, 'den borttagna filen togs bort ur indexet');
    assert.deepEqual(updated().map(r => r.sub), ['e2', 'e3']);
  } finally { db.close(); }
  assert.equal((await lines('hemliga')).lines.length, 1);
});

t('behörighet: bibliotek och barnprofilens åldersgräns', async () => {
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare('UPDATE items SET age=15 WHERE id=?').run(S.film);
  db.prepare('UPDATE items SET age=7 WHERE id=?').run(S.hem);
  db.close();
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW, libraries: [S.F] } })).status, 200);
  const bo = await login('bo', PW);
  let r = await lines('jag är din far', bo);
  assert.deepEqual(r.lines.map(l => l.id), [S.film], 'bara biblioteket Filmer');
  assert.equal(r.status.titles, undefined, 'siffrorna bara för administratören');
  // Barnprofil (7 år) under huvudkontot: bara den hemliga filmen (åldersgräns 7), inte filmen från 15 år
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lill', maxAge: 7 } })).status, 200);
  const pid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lill').id;
  // Profilbytet ersätter token – med en egen inloggning
  const lill = (await req('/api/profiles/switch', { method: 'POST', body: { id: pid }, tok: await login('admin', PW) })).data.token;
  r = await lines('jag är din far', lill);
  assert.deepEqual(r.lines.map(l => l.id), [S.hem]);
  assert.equal((await lines('omöjligt', lill)).lines.length, 0);
  // Utan inloggning: ingenting
  assert.equal((await req('/api/search/lines?q=far', { tok: '' })).status, 401);
});

t('titeln tas bort: replikerna försvinner (kaskad genom FTS-indexet)', async () => {
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
  db.prepare('DELETE FROM items WHERE id=?').run(S.hem);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sub_lines WHERE item_id=?').get(S.hem).n, 0);
  db.close();
  assert.equal((await lines('hemliga')).lines.length, 0);
  assert.deepEqual((await lines('jag är din far')).lines.map(l => l.id), [S.film]);
});
