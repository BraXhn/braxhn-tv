// "Det här har hänt" (server/recap.js, server/routes/recap.js, web/js/player/recap.js).
// Testserien skapas med ffmpeg: säsong 1 med tre avsnitt (60 s, svenska undertexter, svart bild 20–28 s och tystnad
// 30–37 s med repliker fulla av nyckelord, intro 0–6 s och eftertexter från 54 s markerade i databasen), avsnitt 2 med
// gles nyckelbild (omkodas, de andra kopieras) och avsnitt 1 med en svordom; säsong 2 som WebM (spelas i Playwrights
// Chromium, som saknar H.264). Kontrolleras: urvalet (inga osedda avsnitt, ingen intro/eftertext, ingen svart bild eller
// tystnad, säsongens sista avsnitt tyngst), längd och tider för klippen, spellistan (titelskylt + diskontinuiteter),
// stream copy/omkodning, cachen (samma sett-läge = samma sammanfattning, ändrat läge = ny), behörigheten (åldersgräns,
// bibliotek, spoilergränsen för andra profiler, familjefiltret) och erbjudandet efter uppehåll; i Chromium knappen på
// seriesidan och erbjudandet i spelaren med Hoppa över på 375 och 1280 px.
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-recap-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 33000 + Math.floor(Math.random() * 900);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const SHOTS = process.env.SHOTS || '';
process.env.CONFIG_DIR = path.join(ROOT, 'unitconfig');
const R = await import('../server/recap.js');
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas', timeout: 300000 }, fn);
const tw = (name, fn) => test(name, { skip: !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false, timeout: 300000 }, fn);
let srv, browser;
after(async () => { await browser?.close(); srv?.kill(); if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true }); });

const srtTime = (x) => { const ms = Math.round(x * 1000); return `${String(Math.floor(ms / 3600e3)).padStart(2, '0')}:${String(Math.floor(ms / 60e3) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const srt = (cues) => cues.map(([s, e, text], i) => `${i + 1}\n${srtTime(s)} --> ${srtTime(e)}\n${text}\n`).join('\n');
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BLACK = [20, 28], SILENT = [30, 37], INTRO = [0, 6], CREDITS = 54;
const cuesOf = (n) => [[1, 4, 'Saga och Martin i introt'], [8, 10, `Saga hittar spåret ${n}.`], [10.5, 12.5, 'Martin ringer från Köpenhamn.'],
  [22, 24.5, 'Saga Martin Köpenhamn Öresundsbron mördaren'], [32, 35, 'Saga Martin Köpenhamn Öresundsbron kroppen'],
  [42, 44, 'Vi måste tala med Martin.'], [44.5, 46.5, n === 1 ? 'Fan, Saga, vänta!' : 'Saga, vänta!'], [56, 58, 'Saga Martin Köpenhamn eftertexter']];
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', f]).toString());
function stats(f) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-vf', 'blackdetect=d=0.3:pix_th=0.12', '-af', 'volumedetect', '-f', 'null', '-']);
  const s = r.stderr.toString();
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(s);
  return { black: [...s.matchAll(/black_duration:\s*([\d.]+)/g)].reduce((a, x) => a + parseFloat(x[1]), 0), vol: !m || m[1] === '-inf' ? -200 : parseFloat(m[1]) };
}

// ---------------- rena funktioner ----------------
test('nyckelord, fönster, val av klipp, svart/tyst-tolkningen och spellistan', () => {
  const kw = R.keywordsOf(['Saga Norén hittar en kropp på bron. Kommissarien Martin Rohde tar hand om utredningen.']);
  assert.equal(kw.get('martin'), 3, 'namn mitt i meningen'); assert.equal(kw.get('rohde'), 3);
  assert.equal(kw.get('utredningen'), 1); assert.equal(kw.get('saga'), undefined, 'första ordet i meningen är inget namn (och för kort)');
  assert.equal(kw.get('kropp'), 1);
  const ep = { id: 1, duration: 60, intro_start: 0, intro_end: 6, credits_start: 54 };
  const cues = cuesOf(2).map(([s, e, text]) => ({ s, e, text }));
  const w = R.windowsOf(ep, cues, new Map([['martin', 3]]), R.blockedOf(ep));
  assert.ok(w.length >= 4);
  for (const x of w) {
    assert.ok(x.e - x.s >= R.MIN_CLIP - 0.01 && x.e - x.s <= R.MAX_CLIP + 0.01, JSON.stringify(x));
    assert.ok(x.s > INTRO[1] && x.e < CREDITS, 'intro och eftertexter undviks: ' + JSON.stringify(x));
  }
  // Svordomar med familjefiltret: fönster som rör repliken försvinner
  const noProf = R.windowsOf(ep, cuesOf(1).map(([s, e, text]) => ({ s, e, text })), new Map(), R.blockedOf(ep), (s) => /fan/i.test(s));
  assert.ok(noProf.every(x => !(x.e > 44.5 && x.s < 46.5)));
  // Utan undertexter: jämnt fördelade fönster utanför markeringarna
  assert.ok(R.windowsOf({ id: 2, duration: 300 }, [], new Map(), R.blockedOf({ duration: 300 })).length >= 3);
  // Kvoter: det tyngre avsnittet får fler, inga överlapp
  const per = new Map([[1, w.map(x => ({ ...x, item: 1 }))], [2, w.map(x => ({ ...x, item: 2 }))]]);
  const { clips, spare } = R.choose(per, new Map([[1, 1], [2, 3]]), 6);
  assert.equal(clips.length, 6);
  assert.ok(clips.filter(c => c.item === 2).length > clips.filter(c => c.item === 1).length);
  for (const c of clips) assert.ok(!clips.some(d => d !== c && d.item === c.item && d.e > c.s - 4 && d.s < c.e + 4), 'överlapp');
  assert.ok(Array.isArray(spare));
  const bs = R.badShare('[blackdetect @ 0x1] black_start:1 black_end:3 black_duration:2\n[silencedetect @ 0x2] silence_start: 4\n', 10);
  assert.equal(bs.black, 0.2); assert.equal(bs.silence, 0.6, 'tystnad till slutet');
  const pl = R.playlist([{ file: 't.ts', d: 3 }, { file: 'c0.ts', d: 7.5 }, { file: 'c1.ts', d: 11.2 }]);
  assert.match(pl, /#EXT-X-TARGETDURATION:12\n/);
  assert.equal((pl.match(/#EXT-X-DISCONTINUITY/g) || []).length, 2);
  assert.match(pl, /#EXTINF:3\.000,\nt\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:7\.500,\nc0\.ts/);
  assert.match(pl, /#EXT-X-ENDLIST\n$/);
  assert.match(R.titleAss('Tidigare i {Bron}', 'Säsong 1'), /\\pos\(640,330\)\}Tidigare i （Bron）/);
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
async function until(fn, what, n = 480) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await sleep(250); }
  assert.fail('väntade förgäves: ' + what);
}
const db = (sql, ...a) => { const d = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db')); d.exec('PRAGMA busy_timeout=5000'); try { return d.prepare(sql)[/^\s*select/i.test(sql) ? 'get' : 'run'](...a); } finally { d.close(); } };
const watch = (id, tok = admin, watched = true) => req(`/api/items/${id}/watched`, { method: 'POST', body: { watched }, tok });
/** Gör sammanfattningen inför id och väntar tills den är klar */
async function build(id, tok = admin) {
  const r = await req(`/api/items/${id}/recap`, { method: 'POST', tok });
  assert.ok([200, 202].includes(r.status), JSON.stringify(r.data));
  return until(async () => { const x = (await req(`/api/items/${id}/recap`, { tok })).data; return x.state !== 'pending' && x; }, 'sammanfattningen');
}

before(async () => {
  if (!hasFfmpeg) return;
  const s1 = path.join(MEDIA, 'Serier', 'Bron', 'Season 01'), s2 = path.join(MEDIA, 'Serier', 'Bron', 'Season 02');
  fs.mkdirSync(s1, { recursive: true }); fs.mkdirSync(s2, { recursive: true });
  fs.mkdirSync(path.join(MEDIA, 'Annat', 'Film (2020)'), { recursive: true });
  for (const n of [1, 2, 3]) {
    const gop = n === 2 ? 250 : 12; // avsnitt 2: gles nyckelbild → omkodning
    ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', `sine=frequency=${300 + n * 100}:sample_rate=48000`, '-t', '60',
      '-vf', `drawbox=enable='between(t,${BLACK[0]},${BLACK[1]})':color=black:t=fill`, '-af', `volume=enable='between(t,${SILENT[0]},${SILENT[1]})':volume=0`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '96k', '-metadata:s:a:0', 'language=swe', path.join(s1, `Bron S01E0${n}.mkv`));
    fs.writeFileSync(path.join(s1, `Bron S01E0${n}.sv.srt`), srt(cuesOf(n)));
  }
  for (const n of [1, 2]) ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', path.join(s2, `Bron S02E0${n}.webm`));
  ff('-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(MEDIA, 'Annat', 'Film (2020)', 'Film (2020).mp4'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});

t('förberedelse: serien, markeringar, handlingar, åldersgräns och profiler', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin');
  S.lib = (await req('/api/libraries', { method: 'POST', body: { name: 'Serier', type: 'show', path: path.join(MEDIA, 'Serier') } })).data.id;
  S.other = (await req('/api/libraries', { method: 'POST', body: { name: 'Annat', type: 'movie', path: path.join(MEDIA, 'Annat') } })).data.id;
  S.show = await until(async () => (await req(`/api/libraries/${S.lib}/items`)).data.items?.[0]?.id, 'serien skannades');
  const it = await until(async () => { const x = (await req('/api/items/' + S.show)).data; return x.children?.length === 5 && x; }, 'avsnitten');
  const ep = (s, e) => it.children.find(c => c.season === s && c.episode === e).id;
  S.e1 = ep(1, 1); S.e2 = ep(1, 2); S.e3 = ep(1, 3); S.n1 = ep(2, 1); S.n2 = ep(2, 2);
  db('UPDATE items SET age=7, overview=? WHERE id=?', 'En kropp hittas på Öresundsbron. Kommissarien Saga och Martin samarbetar över gränsen.', S.show);
  for (const [id, n] of [[S.e1, 1], [S.e2, 2], [S.e3, 3]]) {
    db('UPDATE items SET intro_start=?, intro_end=?, credits_start=?, overview=? WHERE id=?', INTRO[0], INTRO[1], CREDITS,
      `Avsnitt ${n}: Saga följer spåret till Köpenhamn där Martin väntar.`, id);
  }
  // Barnprofiler: Lill (11 år, påtvingat familjefilter) och Liten (5 år – serien är från 7), Smal (bara biblioteket
  // Annat) och Ny (vuxen, har inte sett något)
  assert.equal((await req('/api/admin/family-filter', { method: 'PUT', body: { kidsDefault: 'mute' } })).status, 200);
  for (const [name, maxAge] of [['Lill', 11], ['Liten', 5], ['Smal'], ['Ny']]) assert.equal((await req('/api/profiles', { method: 'POST', body: { name, ...(maxAge ? { maxAge } : {}) } })).status, 200);
  const profs = (await req('/api/profiles')).data.profiles;
  for (const n of ['Lill', 'Liten', 'Smal', 'Ny']) S[n] = (await req('/api/profiles/switch', { method: 'POST', body: { id: profs.find(p => p.name === n).id }, tok: await login('admin') })).data.token;
  db('UPDATE users SET libraries=? WHERE id=?', JSON.stringify([S.other]), profs.find(p => p.name === 'Smal').id);
  // Repliksökningens index behövs för urvalet
  await until(() => db('SELECT COUNT(*) AS n FROM sub_index WHERE state=1').n >= 3, 'replikerna indexerades');
});

t('urvalet: mitt i säsongen de senaste avsnitten, inför ny säsong förra säsongen – bara sedda avsnitt', async () => {
  await watch(S.e1); await watch(S.e2);
  let r = (await req(`/api/items/${S.e3}/recap`)).data;
  assert.equal(r.available, true, JSON.stringify(r)); assert.equal(r.scope, 'episodes'); assert.equal(r.season, 1);
  assert.deepEqual(r.episodes.map(e => e.id), [S.e1, S.e2]); assert.equal(r.offer, false); assert.equal(r.state, 'none');
  assert.equal(r.title, 'Tidigare i Bron');
  // Inför säsong 2 utan att ha sett avsnitt 3: bara 1 och 2 (spoilergränsen)
  r = (await req(`/api/items/${S.n1}/recap`)).data;
  assert.equal(r.scope, 'season'); assert.deepEqual(r.episodes.map(e => e.id), [S.e1, S.e2]);
  // Serien: nästa avsnitt är S01E03
  r = (await req(`/api/items/${S.show}/recap`)).data;
  assert.equal(r.target.id, S.e3);
  // Inget sett före första avsnittet
  r = (await req(`/api/items/${S.e1}/recap`)).data;
  assert.equal(r.available, false); assert.ok(r.reason);
  assert.equal((await req(`/api/items/${S.e1}/recap`, { method: 'POST' })).status, 409);
  assert.equal((await req('/api/items/999999/recap')).status, 404);
});

t('sammanfattningen: 6 klipp på 5–12 s, rätt avsnitt och tider, ingen intro/eftertext/svart bild/tystnad, titelskylt och diskontinuiteter', async () => {
  await watch(S.e3);
  let r = (await req(`/api/items/${S.show}/recap`)).data;
  assert.equal(r.target.id, S.n1); assert.deepEqual(r.episodes.map(e => e.id), [S.e1, S.e2, S.e3]);
  assert.equal(r.offer, false, 'nyss sett – inget erbjudande');
  db('UPDATE progress SET updated=updated-20*86400');
  r = (await req(`/api/items/${S.show}/recap`)).data;
  assert.equal(r.offer, true, 'efter mer än två veckor erbjuds sammanfattningen');
  const p = await req(`/api/items/${S.show}/recap`, { method: 'POST' });
  assert.equal(p.status, 202); assert.equal(p.data.state, 'pending');
  r = await build(S.show);
  assert.equal(r.state, 'ready', r.error);
  S.recap = r.id;
  const clips = r.clipList;
  assert.equal(clips.length, 6, JSON.stringify(clips));
  assert.deepEqual([...new Set(clips.map(c => c.item))], [S.e1, S.e2, S.e3], 'alla tre avsnitten, i ordning');
  assert.ok(clips.filter(c => c.item === S.e3).length >= 2, 'säsongens sista avsnitt väger tyngst');
  for (const c of clips) {
    const len = c.e - c.s;
    assert.ok(len >= R.MIN_CLIP - 0.6 && len <= R.MAX_CLIP + 0.6, 'längd ' + JSON.stringify(c));
    assert.ok(Math.abs(c.d - len) < 0.25, 'segmentets längd motsvarar tiderna ' + JSON.stringify(c));
    for (const [a, b] of [INTRO, BLACK, SILENT, [CREDITS, 60]]) assert.ok(!(c.e > a + 0.5 && c.s < b - 0.5), `klippet ${c.s}–${c.e} ligger i ${a}–${b}`);
    assert.equal(c.mode, c.item === S.e2 ? 'encode' : 'copy', JSON.stringify(c));
  }
  assert.equal(r.mode, 'mixed');
  // Spellistan och segmenten
  const pl = await req(`/api/recaps/${r.id}/index.m3u8`);
  assert.equal(pl.status, 200); assert.equal(pl.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  const files = pl.data.split('\n').filter(l => l && !l.startsWith('#'));
  assert.deepEqual(files, ['t.ts', ...clips.map((_, i) => `c${i}.ts`)]);
  assert.equal((pl.data.match(/#EXT-X-DISCONTINUITY/g) || []).length, clips.length);
  const total = [...pl.data.matchAll(/#EXTINF:([\d.]+)/g)].reduce((s, m) => s + parseFloat(m[1]), 0);
  assert.ok(Math.abs(total - r.duration) < 0.05 && total > 30 && total < 3 + 12 * 12, 'längd ' + total);
  for (const [i, f] of files.entries()) {
    const seg = await req(`/api/recaps/${r.id}/${f}`, { raw: true });
    assert.equal(seg.status, 200); assert.equal(seg.headers.get('content-type'), 'video/mp2t');
    const out = path.join(ROOT, `seg-${f}`); fs.writeFileSync(out, seg.data);
    const pr = probe(out);
    assert.deepEqual(pr.streams.map(s => s.codec_name).sort(), ['aac', 'h264'], f);
    if (i === 0) { assert.equal(pr.streams.find(s => s.codec_type === 'video').width, 1280, 'titelskylten'); continue; }
    const st = stats(out);
    assert.ok(st.black < 1, `${f}: svart bild ${st.black} s`);
    assert.ok(st.vol > -30, `${f}: tyst (${st.vol} dB)`);
    assert.equal(pr.streams.find(s => s.codec_type === 'video').width, 320, 'originalupplösningen');
  }
  assert.equal((await req(`/api/recaps/${r.id}/../../braxhn-tv.db`)).status, 404);
  assert.equal((await req(`/api/recaps/${r.id}/x.ts`)).status, 404);
});

t('cachen: samma sett-läge ger samma sammanfattning (även för en annan profil), ändrat läge en ny', async () => {
  const f = path.join(CONFIG, 'recaps', String(S.recap), 'index.m3u8');
  const mt = fs.statSync(f).mtimeMs;
  const again = await req(`/api/items/${S.show}/recap`, { method: 'POST' });
  assert.equal(again.status, 200); assert.equal(again.data.id, S.recap); assert.equal(again.data.state, 'ready');
  assert.equal((await req(`/api/items/${S.n1}/recap`)).data.id, S.recap, 'serien och första avsnittet i säsong 2 ger samma');
  assert.equal(fs.statSync(f).mtimeMs, mt, 'inte omgjord');
  // Ny har inte sett något: ingen sammanfattning och ingen åtkomst till administratörens (spoilergränsen)
  let r = (await req(`/api/items/${S.n1}/recap`, { tok: S.Ny })).data;
  assert.equal(r.available, false);
  assert.equal((await req(`/api/recaps/${S.recap}/index.m3u8`, { tok: S.Ny })).status, 404);
  assert.equal((await req(`/api/recaps/${S.recap}/c0.ts`, { tok: S.Ny })).status, 404);
  for (const id of [S.e1, S.e2, S.e3]) await watch(id, S.Ny);
  r = (await req(`/api/items/${S.n1}/recap`, { tok: S.Ny })).data;
  assert.equal(r.id, S.recap); assert.equal(r.state, 'ready', 'delad med samma sett-läge');
  assert.equal((await req(`/api/recaps/${S.recap}/index.m3u8`, { tok: S.Ny })).status, 200);
  // Administratören markerar avsnitt 3 som osett: en annan sammanfattning, och den gamla gäller inte längre för profilen
  await watch(S.e3, admin, false);
  r = (await req(`/api/items/${S.n1}/recap`)).data;
  assert.notEqual(r.id, S.recap); assert.deepEqual(r.episodes.map(e => e.id), [S.e1, S.e2]);
  assert.equal((await req(`/api/recaps/${S.recap}/index.m3u8`)).status, 404, 'avsnitt 3 är inte sett längre');
  await watch(S.e3);
});

t('behörighet: åldersgräns och bibliotek; familjefiltret ger en egen sammanfattning utan svordomen', async () => {
  for (const tok of [S.Liten, S.Smal]) {
    assert.equal((await req(`/api/items/${S.show}/recap`, { tok })).status, 404);
    assert.equal((await req(`/api/items/${S.n1}/recap`, { tok, method: 'POST' })).status, 404);
    assert.equal((await req(`/api/recaps/${S.recap}/index.m3u8`, { tok })).status, 404);
  }
  for (const id of [S.e1, S.e2, S.e3]) await watch(id, S.Lill);
  let r = (await req(`/api/items/${S.n1}/recap`, { tok: S.Lill })).data;
  assert.equal(r.available, true); assert.notEqual(r.id, S.recap, 'familjefiltret: egen nyckel');
  assert.equal((await req(`/api/recaps/${S.recap}/index.m3u8`, { tok: S.Lill })).status, 404, 'otystad sammanfattning nekas');
  r = await build(S.n1, S.Lill);
  assert.equal(r.state, 'ready', r.error);
  for (const c of r.clipList.filter(c => c.item === S.e1)) assert.ok(!(c.e > 44.5 && c.s < 46.5), 'repliken med svordomen är inte med: ' + JSON.stringify(c));
  assert.equal((await req(`/api/recaps/${r.id}/index.m3u8`, { tok: S.Lill })).status, 200);
  assert.equal((await req(`/api/recaps/${r.id}/index.m3u8`)).status, 200, 'den tystade får administratören också se');
});

tw('webben: knappen på seriesidan och erbjudandet i spelaren med Hoppa över (375 och 1280 px)', async () => {
  const lr = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) });
  const cookie = /kt=([0-9a-f]+)/.exec(lr.headers.get('set-cookie'))[1];
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const mode of ['desktop', 'phone']) {
    const phone = mode === 'phone';
    const ctx = await browser.newContext(phone ? { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name: 'kt', value: cookie, url: B }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400 && !/\/api\/(image|items\/\d+\/trickplay)/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
    db('UPDATE progress SET updated=? WHERE user_id=1', Math.floor(Date.now() / 1000) - 20 * 86400);
    await page.goto(B + '/#/item/' + S.show);
    await page.waitForSelector('#recap');
    assert.match(await page.textContent('#recap'), /Det här har hänt/);
    assert.match(await page.getAttribute('#recap', 'title'), /Säsong 1 · 3 avsnitt · cirka/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `recap-show-${mode}.png`) });
    await page.click('#recap');
    await page.waitForSelector('dialog.recapdlg[open]');
    assert.match(await page.textContent('dialog[open] .dlg-title'), /Det här har hänt/);
    assert.match(await page.textContent('#rcsum'), /^Tidigare i Bron · Säsong 1/);
    // Klar sedan tidigare: videon kopplas in (Playwrights Chromium saknar H.264 – då ett meddelande i stället)
    await page.waitForFunction(() => { const v = document.querySelector('#rcvid'); const s = document.querySelector('#rcstate'); return (v && !v.hidden && (v.src || v.readyState > 0 || v.srcObject !== undefined)) || /kan inte spelas/.test(s?.textContent || ''); });
    assert.equal(await page.isVisible('dialog[open] button:has-text("▶ Spela S02E01")'), true);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `recap-dialog-${mode}.png`) });
    await page.click('dialog[open] button:has-text("Hoppa över")');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    // Spelaren: första avsnittet i säsong 2 efter uppehållet → erbjudandet
    await page.click('#playnext');
    await page.waitForSelector('#precap');
    assert.match(await page.textContent('#precap'), /Det här har hänt.*Säsong 1/s);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `recap-offer-${mode}.png`) });
    await page.waitForFunction(() => document.querySelector('#vid')?.readyState >= 2, null, { timeout: 60000 });
    await page.click('#precapgo');
    await page.waitForSelector('dialog.recapdlg[open]');
    assert.equal(await page.evaluate(() => document.querySelector('#vid').paused), true, 'avsnittet pausas');
    assert.equal(await page.isVisible('#precap'), false);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await page.waitForFunction(() => !document.querySelector('#vid').paused, null, { timeout: 10000 });
    await page.click('#cstop');
    // Hoppa över: rutan försvinner och kommer inte igen för avsnittet
    await page.goto(B + '/#/item/' + S.show);
    await page.click('#playnext');
    await page.waitForSelector('#precap');
    await page.click('#precapx');
    assert.equal(await page.isVisible('#precap'), false);
    await page.click('#cstop');
    await page.click('#playnext');
    await page.waitForFunction(() => document.querySelector('#vid')?.readyState >= 2, null, { timeout: 60000 });
    await sleep(800);
    assert.equal(await page.isVisible('#precap'), false, 'Hoppa över gäller avsnittet');
    await page.click('#cstop');
    assert.deepEqual(errors.filter(e => !/\/api\/recaps\//.test(e)), []);
    await ctx.close();
  }
});
