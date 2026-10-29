// Ögonblick (server/moments.js, server/routes/moments.js, web/js/views/moments.js, web/js/player/moments.js).
// Testfilerna skapas med ffmpeg: en H.264-film med nyckelbild varje sekund och engelska undertexter med svordomar
// (stream copy), en med nyckelbild var tionde sekund (omkodning), en WebM (spelas i Playwrights Chromium, som saknar
// H.264) och en film i ett annat bibliotek. Kontrolleras: exakt längd, stream copy mot omkodning, inbränd undertext och
// vattenstämpel, familjefiltret (tystat klipp för barnprofilen, tystad variant, dolt klipp med inbrända svordomar),
// behörighet (åldersgräns och bibliotek för den som skapar och den som ser, andra hushåll, barn delar inte), max längd,
// lagringsgränsen, delade länkar (giltig, förfalskad, utgången, återkallad, ingen annan åtkomst, Open Graph) och i
// Chromium: spara från spelaren, flödet, reaktion, kommentar och "Spela filmen härifrån" på 375 och 1280 px.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-moments-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 32000 + Math.floor(Math.random() * 900);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const SHOTS = process.env.SHOTS || '';
process.env.CONFIG_DIR = path.join(ROOT, 'unitconfig');
const M = await import('../server/moments.js');
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas', timeout: 240000 }, fn);
const tw = (name, fn) => test(name, { skip: !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false, timeout: 300000 }, fn);
let srv, browser;
after(async () => { await browser?.close(); srv?.kill(); if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true }); });

const srtTime = (x) => { const ms = Math.round(x * 1000); return `${String(Math.floor(ms / 3600e3)).padStart(2, '0')}:${String(Math.floor(ms / 60e3) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const srt = (cues) => cues.map(([s, e, text], i) => `${i + 1}\n${srtTime(s)} --> ${srtTime(e)}\n${text}\n`).join('\n');
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CUES = [[1, 2, 'Hello there.'], [3, 4.5, 'What the fuck is this?'], [8, 9.5, 'Nice weather.'], [16, 17.5, 'Oh shit, run!']];
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', f]).toString());
function maxVolume(f, a, b) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-vn', '-af', `atrim=start=${a}:end=${b},volumedetect`, '-f', 'null', '-']);
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr.toString());
  assert.ok(m, r.stderr.toString().slice(-400));
  return m[1] === '-inf' ? -200 : parseFloat(m[1]);
}

// ---------------- rena funktioner ----------------
test('tider: kortare än en sekund, längre än maxlängden och negativ start nekas; slutet kapas vid filmens längd', () => {
  assert.deepEqual(M.parseRange({ start: 2, end: 12.5 }, 100), { s: 2, e: 12.5 });
  assert.deepEqual(M.parseRange({ start: 95, end: 130 }, 100), { s: 95, e: 100 });
  for (const b of [{ start: 2, end: 2.5 }, { start: -1, end: 5 }, { start: 'x', end: 5 }, { start: 0, end: M.MAX_LEN + 1 }]) assert.throws(() => M.parseRange(b, 1000), (e) => e.status === 400);
  const ass = M.assFile([{ s: 0.5, e: 2, text: 'Hej {\\b1}där\nrad två' }], 'Mitt klipp · Film (2020)', 10);
  assert.match(ass, /Dialogue: 0,0:00:00\.50,0:00:02\.00,Sub,,0,0,0,,Hej （＼b1）där\\Nrad två/);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:11\.00,Mark,,0,0,0,,Mitt klipp · Film \(2020\)/);
  assert.equal(M.resolveShare('1.2.' + 'x'.repeat(32)), null, 'förfalskad signatur');
  assert.equal(M.resolveShare('../../etc'), null);
});

// ---------------- mot en riktig server ----------------
let admin = '', S = {};
async function req(p, { method = 'GET', body, tok = admin, raw = false, headers = {} } = {}) {
  const h = { ...headers };
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: raw ? Buffer.from(await r.arrayBuffer()) : ct.includes('json') ? await r.json() : await r.text() };
}
const login = async (name) => (await req('/api/login', { method: 'POST', body: { name, password: PW, app: true }, tok: '' })).data.token;
async function until(fn, what, n = 240) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await sleep(250); }
  assert.fail('väntade förgäves: ' + what);
}
const dbRun = (sql, ...a) => { const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db')); db.exec('PRAGMA busy_timeout=5000'); try { return db.prepare(sql)[/^\s*select/i.test(sql) ? 'get' : 'run'](...a); } finally { db.close(); } };
/** Skapar ett ögonblick och väntar tills det är klart (eller misslyckat) */
async function make(item, body, tok = admin) {
  const r = await req(`/api/items/${item}/moments`, { method: 'POST', body, tok });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.state, 'pending');
  return until(async () => { const x = (await req('/api/moments/' + r.data.id, { tok })).data; return x.state !== 'pending' && x; }, 'klippet ' + body.title);
}
async function saveVideo(id, tok = admin, name = 'v') {
  const r = await req(`/api/moments/${id}/video`, { tok, raw: true });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'video/mp4');
  const f = path.join(ROOT, `${name}-${id}.mp4`); fs.writeFileSync(f, r.data); return f;
}

before(async () => {
  if (!hasFfmpeg) return;
  const dirs = { tata: path.join(MEDIA, 'Filmer', 'Täta (2020)'), gles: path.join(MEDIA, 'Filmer', 'Glesa (2021)'), webm: path.join(MEDIA, 'Filmer', 'Webben (2022)'), annan: path.join(MEDIA, 'Annat', 'Annan (2019)') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const h264 = (gop, out, dur = 30) => ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '96k', '-metadata:s:a:0', 'language=eng', out);
  h264(25, path.join(dirs.tata, 'Täta (2020).mkv'));
  fs.writeFileSync(path.join(dirs.tata, 'Täta (2020).en.srt'), srt(CUES));
  h264(250, path.join(dirs.gles, 'Glesa (2021).mp4'));
  h264(25, path.join(dirs.annan, 'Annan (2019).mp4'), 10);
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', path.join(dirs.webm, 'Webben (2022).webm'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', MOMENTS_MAX_SECONDS: '60', MOMENTS_MAX_MB: '50' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});

t('förberedelse: bibliotek, åldersgränser, profiler och ett annat hushåll', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin');
  S.F = (await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).data.id;
  S.A = (await req('/api/libraries', { method: 'POST', body: { name: 'Annat', type: 'movie', path: path.join(MEDIA, 'Annat') } })).data.id;
  const items = await until(async () => { const r = (await req(`/api/libraries/${S.F}/items`)).data.items; return r?.length === 3 && r; }, 'filmerna skannades');
  S.tata = items.find(i => i.title === 'Täta').id; S.gles = items.find(i => i.title === 'Glesa').id; S.webm = items.find(i => i.title === 'Webben').id;
  S.annan = await until(async () => (await req(`/api/libraries/${S.A}/items`)).data.items?.[0]?.id, 'den andra filmen');
  // Åldersgränser (utan TMDB har titlarna ingen): Täta och Webben 7 år, Glesa 15 år
  dbRun('UPDATE items SET age=7 WHERE id IN (?,?,?)', S.tata, S.webm, S.annan);
  dbRun('UPDATE items SET age=15 WHERE id=?', S.gles);
  // Barnprofil (11 år) med påtvingat familjefilter (administratörens standard: tysta)
  assert.equal((await req('/api/admin/family-filter', { method: 'PUT', body: { kidsDefault: 'mute' } })).status, 200);
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lill', maxAge: 11 } })).status, 200);
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Smal' } })).status, 200);
  const profs = (await req('/api/profiles')).data.profiles;
  S.lillId = profs.find(p => p.name === 'Lill').id; S.smalId = profs.find(p => p.name === 'Smal').id;
  S.lill = (await req('/api/profiles/switch', { method: 'POST', body: { id: S.lillId }, tok: await login('admin') })).data.token;
  S.smal = (await req('/api/profiles/switch', { method: 'POST', body: { id: S.smalId }, tok: await login('admin') })).data.token;
  // Smal: en vuxen profil i hushållet som bara får se biblioteket Annat
  dbRun('UPDATE users SET libraries=? WHERE id=?', JSON.stringify([S.A]), S.smalId);
  // Ett annat hushåll
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW } })).status, 200);
  S.bo = await login('bo');
  // Familjefiltret behöver de indexerade replikerna
  await until(async () => (await req(`/api/items/${S.tata}/playback?info=1&ffc=1`, { tok: S.lill })).data.filter?.mute?.length, 'replikerna indexerades');
});

t('stream copy: nyckelbild varje sekund ger kopierad bild, exakt längd och start på nyckelbilden', async () => {
  const m = await make(S.tata, { start: 2, end: 12, title: 'Kopierat' });
  assert.equal(m.state, 'ready', m.error); assert.equal(m.mode, 'copy');
  assert.ok(Math.abs(m.start - 2) < 0.05, 'start ' + m.start);
  const p = probe(await saveVideo(m.id));
  assert.ok(Math.abs(parseFloat(p.format.duration) - 10) < 0.15, 'längd ' + p.format.duration);
  assert.deepEqual(p.streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
  assert.equal(p.streams.find(s => s.codec_type === 'video').width, 320, 'originalupplösningen (kopierad)');
  // Mellan två nyckelbilder (2,3 s): börjar på nyckelbilden 2,0 – fortfarande kopierat
  const m2 = await make(S.tata, { start: 2.3, end: 8.3, title: 'Strax efter' });
  assert.equal(m2.mode, 'copy'); assert.ok(Math.abs(m2.start - 2) < 0.05, 'start ' + m2.start);
  assert.ok(Math.abs(parseFloat(probe(await saveVideo(m2.id)).format.duration) - 6.3) < 0.15);
  S.copy = m.id; S.copy2 = m2.id;
  // Miniatyren
  const th = await req(`/api/moments/${m.id}/thumb`, { raw: true });
  assert.equal(th.status, 200); assert.equal(th.headers.get('content-type'), 'image/jpeg'); assert.ok(th.data.length > 500);
});

t('omkodning: gles nyckelbild ger H.264/AAC med exakt start och längd; inbränd undertext och vattenstämpel kodas om', async () => {
  const m = await make(S.gles, { start: 3.5, end: 9.5, title: 'Omkodat' });
  assert.equal(m.state, 'ready', m.error); assert.equal(m.mode, 'encode'); assert.equal(m.start, 3.5);
  const p = probe(await saveVideo(m.id));
  assert.ok(Math.abs(parseFloat(p.format.duration) - 6) < 0.12, 'längd ' + p.format.duration);
  assert.deepEqual(p.streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
  // Täta med undertexten inbränd (repliken 8–9,5 s) och vattenstämpel: omkodning trots täta nyckelbilder
  const it = (await req(`/api/items/${S.tata}`)).data;
  S.sub = it.subtitles.find(s => s.lang === 'en').id;
  const plain = await make(S.tata, { start: 7, end: 10, title: 'Utan text', watermark: false });
  const burned = await make(S.tata, { start: 7, end: 10, title: 'Med text', sub: S.sub, watermark: true });
  assert.equal(burned.state, 'ready', burned.error); assert.equal(burned.mode, 'encode'); assert.equal(burned.subs, true); assert.equal(burned.watermark, true);
  assert.ok(Math.abs(parseFloat(probe(await saveVideo(burned.id)).format.duration) - 3) < 0.12);
  // Bilden skiljer sig från den kopierade där texten och stämpeln ritats (1,5 s in: repliken syns)
  const frame = (f) => execFileSync('ffmpeg', ['-v', 'error', '-ss', '1.5', '-i', f, '-frames:v', '1', '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
  const a = frame(await saveVideo(plain.id, admin, 'p')), b = frame(await saveVideo(burned.id, admin, 'b'));
  let diff = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 60) diff++;
  assert.ok(diff > 150, 'inbränd text syns: ' + diff + ' bildpunkter');
  // Bildundertexter och okänd undertext nekas; max längd (MOMENTS_MAX_SECONDS=60)
  assert.equal((await req(`/api/items/${S.tata}/moments`, { method: 'POST', body: { start: 0, end: 5, title: 'x', sub: 'e99' } })).status, 400);
  const long = await req(`/api/items/${S.tata}/moments`, { method: 'POST', body: { start: 0, end: 29, title: 'x' } });
  assert.equal(long.status, 202, 'under gränsen');
  await until(async () => (await req('/api/moments/' + long.data.id)).data.state !== 'pending', 'långa');
  dbRun('UPDATE items SET duration=500 WHERE id=?', S.tata);
  const over = await req(`/api/items/${S.tata}/moments`, { method: 'POST', body: { start: 0, end: 61, title: 'För långt' } });
  assert.equal(over.status, 400); assert.match(over.data.error, /högst en minut/);
  assert.equal((await req(`/api/items/${S.tata}/moments`, { method: 'POST', body: { start: 1, end: 5, title: '  ' } })).status, 400, 'titel krävs');
  S.burned = burned.id;
});

t('familjefiltret: barnprofilens klipp tystas, vuxnas klipp får en tystad variant, inbrända svordomar döljs för barnet', async () => {
  // Lill (påtvingat filter): svordomen 3–4,5 s (tyst ca 2,75–4,8) tystas i själva klippet
  const k = await make(S.tata, { start: 0, end: 8, title: 'Lills klipp' }, S.lill);
  assert.equal(k.state, 'ready', k.error);
  const kf = await saveVideo(k.id, S.lill, 'k');
  assert.ok(maxVolume(kf, 3.2, 4.3) < -60, 'tyst under svordomen');
  assert.ok(maxVolume(kf, 0.5, 2.5) > -30, 'ljud annars');
  // Administratörens klipp 0–8 s: originalet för vuxna, den tystade varianten för Lill
  const a = await make(S.tata, { start: 0, end: 8, title: 'Vuxnas klipp' });
  assert.ok(maxVolume(await saveVideo(a.id, admin, 'a'), 3.2, 4.3) > -30, 'vuxna hör allt');
  assert.ok(maxVolume(await saveVideo(a.id, S.lill, 'al'), 3.2, 4.3) < -60, 'barnet får den tystade varianten');
  // Inbränd undertext med svordom (omaskerad – administratörens filter är av): syns inte för Lill
  const bw = await make(S.tata, { start: 2, end: 6, title: 'Svär i text', sub: S.sub });
  assert.equal((await req('/api/moments/' + bw.id, { tok: S.lill })).status, 404);
  assert.equal((await req(`/api/moments/${bw.id}/video`, { tok: S.lill, raw: true })).status, 404);
  assert.ok(!(await req('/api/moments', { tok: S.lill })).data.moments.some(m => m.id === bw.id));
  // Repliken utan svordom (7–10 s) går bra
  assert.equal((await req('/api/moments/' + S.burned, { tok: S.lill })).status, 200);
  S.adult = a.id; S.kid = k.id;
});

t('behörighet: åldersgräns och bibliotek för både den som skapar och den som ser, andra hushåll ser inget', async () => {
  // Glesa är 15 år: Lill kan inte skapa och ser inte administratörens klipp ur den
  assert.equal((await req(`/api/items/${S.gles}/moments`, { method: 'POST', body: { start: 0, end: 5, title: 'x' }, tok: S.lill })).status, 404);
  const glesClip = (await req('/api/moments')).data.moments.find(m => m.itemId === S.gles);
  assert.ok(glesClip);
  assert.equal((await req('/api/moments/' + glesClip.id, { tok: S.lill })).status, 404);
  assert.equal((await req(`/api/moments/${glesClip.id}/thumb`, { tok: S.lill, raw: true })).status, 404);
  const lillFeed = (await req('/api/moments', { tok: S.lill })).data;
  assert.ok(lillFeed.moments.length > 0 && lillFeed.moments.every(m => m.itemId !== S.gles));
  assert.equal(lillFeed.canShare, false);
  // Smal får bara se biblioteket Annat: inga klipp ur Filmer, kan inte skapa där men i Annat
  assert.deepEqual((await req('/api/moments', { tok: S.smal })).data.moments, []);
  assert.equal((await req(`/api/items/${S.tata}/moments`, { method: 'POST', body: { start: 0, end: 5, title: 'x' }, tok: S.smal })).status, 404);
  const sm = await make(S.annan, { start: 0, end: 4, title: 'Smals' }, S.smal);
  assert.equal(sm.state, 'ready', sm.error);
  // Bo (ett annat hushåll) ser inget av hushållets ögonblick
  assert.deepEqual((await req('/api/moments', { tok: S.bo })).data.moments, []);
  for (const p of ['', '/video', '/thumb']) assert.equal((await req(`/api/moments/${S.copy}${p}`, { tok: S.bo, raw: true })).status, 404);
  assert.equal((await req(`/api/moments/${S.copy}`, { method: 'DELETE', tok: S.bo })).status, 404);
  assert.equal((await req('/api/moments', { tok: '' })).status, 401);
  // Lill kan inte ta bort administratörens ögonblick, men sitt eget; huvudkontot kan ta bort profilernas
  assert.equal((await req(`/api/moments/${S.adult}`, { method: 'DELETE', tok: S.lill })).status, 403);
  assert.equal((await req(`/api/moments/${sm.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(path.join(CONFIG, 'moments', sm.id + '.mp4')), 'filerna tas bort');
});

t('reaktioner och kommentarer: av/på, bara kända reaktioner, egna kommentarer tas bort av en själv', async () => {
  let r = await req(`/api/moments/${S.copy}/reactions`, { method: 'POST', body: { emoji: '❤️' }, tok: S.lill });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.reactions.find(x => x.emoji === '❤️'), { emoji: '❤️', n: 1, mine: true });
  r = await req(`/api/moments/${S.copy}/reactions`, { method: 'POST', body: { emoji: '❤️' } });
  assert.deepEqual(r.data.reactions.find(x => x.emoji === '❤️'), { emoji: '❤️', n: 2, mine: true });
  r = await req(`/api/moments/${S.copy}/reactions`, { method: 'POST', body: { emoji: '❤️' } });
  assert.deepEqual(r.data.reactions.find(x => x.emoji === '❤️'), { emoji: '❤️', n: 1, mine: false });
  assert.equal((await req(`/api/moments/${S.copy}/reactions`, { method: 'POST', body: { emoji: '<b>' } })).status, 400);
  r = await req(`/api/moments/${S.copy}/comments`, { method: 'POST', body: { text: '  Haha, <b>titta</b>!  ' }, tok: S.lill });
  assert.equal(r.status, 200);
  const c = r.data.commentList.at(-1);
  assert.equal(c.text, 'Haha, <b>titta</b>!'); assert.equal(c.by.name, 'Lill'); assert.equal(c.mine, true);
  assert.equal((await req(`/api/moments/${S.copy}/comments`, { method: 'POST', body: { text: '' } })).status, 400);
  assert.equal((await req('/api/moments')).data.moments.find(m => m.id === S.copy).comments, 1);
  // Lill kan inte ta bort administratörens kommentar; administratören (som äger ögonblicket) tar bort Lills
  const ac = (await req(`/api/moments/${S.copy}/comments`, { method: 'POST', body: { text: 'Ja!' } })).data.commentList.at(-1);
  assert.equal((await req(`/api/moments/${S.copy}/comments/${ac.id}`, { method: 'DELETE', tok: S.lill })).status, 403);
  assert.equal((await req(`/api/moments/${S.copy}/comments/${c.id}`, { method: 'DELETE' })).status, 200);
});

t('delade länkar: bara klippet, Open Graph, förfalskad/utgången/återkallad ger ingen åtkomst; barn delar inte', async () => {
  assert.equal((await req(`/api/moments/${S.kid}/shares`, { method: 'POST', body: { hours: 24 }, tok: S.lill })).status, 403, 'barnprofil');
  assert.equal((await req(`/api/moments/${S.copy}/shares`, { method: 'POST', body: { hours: 5 } })).status, 400, 'fast lista med tider');
  const s = (await req(`/api/moments/${S.copy}/shares`, { method: 'POST', body: { hours: 24 } })).data;
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/share\/\d+\.\d+\.[\w-]{32}$/);
  assert.ok(s.expires > Date.now() / 1000 + 23 * 3600);
  const tok = s.path.split('/').pop();
  // Sidan: utan inloggning, med Open Graph och egen CSP
  const page = await req(s.path, { tok: '' });
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(page.data, /<meta property="og:title" content="Kopierat">/);
  assert.match(page.data, new RegExp(`<meta property="og:video" content="${B}/api/share/${tok.replace(/\./g, '\\.')}/clip\\.mp4">`));
  assert.match(page.data, /og:image" content="[^"]+\/thumb\.jpg"/);
  const clip = await req(s.path + '/clip.mp4', { tok: '', raw: true, headers: { range: 'bytes=0-99' } });
  assert.equal(clip.status, 206); assert.equal(clip.data.length, 100); assert.equal(clip.headers.get('content-type'), 'video/mp4');
  assert.equal((await req(s.path + '/thumb.jpg', { tok: '', raw: true })).status, 200);
  // Ingen annan åtkomst med länken: som Bearer, som ?t= och som andra sökvägar under /api/share/
  assert.equal((await req('/api/moments', { tok })).status, 401);
  assert.equal((await req(`/api/stream/${S.tata}/direct?t=${tok}`, { tok: '' })).status, 401);
  assert.equal((await req(`/api/items/${S.tata}?t=${tok}`, { tok: '' })).status, 401);
  assert.equal((await req(`/api/share/${tok}/video`, { tok: '' })).status, 404);
  assert.equal((await req(`/api/share/${tok}/../../moments`, { tok: '' })).status, 401, "adressen normaliseras bort från /api/share/ – länken är ingen inloggning");
  assert.equal((await req('/api/moments', { tok: '', headers: { cookie: 'kt=' + tok } })).status, 401);
  // Inloggade routes nås aldrig under /api/share/ (routealternativet share)
  assert.equal((await req('/api/share/x', { tok: admin })).status, 404);
  // Förfalskad: annat id/utgång med samma signatur
  const [sid, exp, sig] = tok.split('.');
  assert.equal((await req(`/api/share/${sid}.${+exp + 3600}.${sig}`, { tok: '' })).status, 404);
  assert.equal((await req(`/api/share/${sid}.${exp}.${sig.slice(0, -1)}A/clip.mp4`, { tok: '', raw: true })).status, 404);
  // Utgången: en rad med utgång i det förflutna, signerad med serverns nyckel
  const key = Buffer.from(dbRun("SELECT v FROM settings WHERE k='moments_share_key'").v, 'hex');
  const past = Math.floor(Date.now() / 1000) - 60;
  const old = dbRun('INSERT INTO moment_shares(moment_id, user_id, expires, created) VALUES(?,?,?,?)', S.copy, 1, past, past - 3600).lastInsertRowid;
  const oldTok = `${old}.${past}.${crypto.createHmac('sha256', key).update(`moment-share:${old}.${past}`).digest('base64url').slice(0, 32)}`;
  const gone = await req('/api/share/' + oldTok, { tok: '' });
  assert.equal(gone.status, 410); assert.match(gone.data, /Länken gäller inte längre/); assert.doesNotMatch(gone.data, /og:video/);
  assert.equal((await req(`/api/share/${oldTok}/clip.mp4`, { tok: '', raw: true })).status, 410);
  // Visningar räknas; Lill ser inte länkarna; återkallad slutar fungera direkt
  const det = (await req('/api/moments/' + S.copy)).data;
  assert.equal(det.shares.find(x => x.id === s.id).views, 1);
  assert.equal((await req('/api/moments/' + S.copy, { tok: S.lill })).data.shares, undefined);
  assert.equal((await req(`/api/moments/${S.copy}/shares/${s.id}`, { method: 'DELETE', tok: S.lill })).status, 403);
  assert.equal((await req(`/api/moments/${S.copy}/shares/${s.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await req(s.path, { tok: '' })).status, 410);
  assert.equal((await req(s.path + '/clip.mp4', { tok: '', raw: true })).status, 410);
  // Borttaget ögonblick: länken gäller inte (raden försvinner med kaskaden)
  const s2 = (await req(`/api/moments/${S.copy2}/shares`, { method: 'POST', body: { hours: 1 } })).data;
  assert.equal((await req(s2.path, { tok: '' })).status, 200);
  assert.equal((await req('/api/moments/' + S.copy2, { method: 'DELETE' })).status, 200);
  assert.equal((await req(s2.path, { tok: '' })).status, 410);
  assert.equal((await req(s2.path + '/clip.mp4', { tok: '', raw: true })).status, 410);
});

t('lagringsgränsen: fullt lager nekar nya ögonblick', async () => {
  dbRun('UPDATE moments SET size=? WHERE id=?', 60 << 20, S.adult);
  const r = await req(`/api/items/${S.tata}/moments`, { method: 'POST', body: { start: 0, end: 3, title: 'För mycket' } });
  assert.equal(r.status, 409); assert.match(r.data.error, /Lagringen för ögonblick är full/);
  dbRun('UPDATE moments SET size=1000 WHERE id=?', S.adult);
  const st = (await req('/api/moments')).data.storage;
  assert.equal(st.max, 50 * 1048576); assert.ok(st.used > 0 && st.used < st.max);
});

// ---------------- webben i Chromium ----------------
tw('webben: spara ögonblick i spelaren, flödet, reaktion, kommentar, dela och "Spela filmen härifrån"', async () => {
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
    // Klippen är H.264, som Playwrights Chromium inte avkodar – bara laddningsfel från dem tillåts
    page.on('response', r => { if (r.status() >= 400 && !/\/api\/(image|items\/\d+\/trickplay)/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
    await page.goto(B + '/#/item/' + S.webm);
    await page.click('[data-play="0"]');
    await page.waitForFunction(() => document.querySelector('#vid')?.readyState >= 2, null, { timeout: 60000 });
    await page.evaluate(() => { const v = document.querySelector('#vid'); v.currentTime = 12; });
    await page.waitForFunction(() => document.querySelector('#vid').currentTime >= 12);
    await page.click('#pmoment');
    await page.waitForSelector('dialog[open] #mtitle');
    assert.equal(await page.inputValue('#mtitle'), 'Webben');
    assert.equal(await page.inputValue('#mstart'), '0:00', 'senaste 30 s men inte före början');
    assert.match(await page.inputValue('#mend'), /^0:1[23]/);
    await page.fill('#mtitle', `Från spelaren ${mode}`);
    await page.fill('#mstart', '0:02'); await page.fill('#mend', '0:06');
    assert.equal(await page.textContent('#mlen'), 'Längd 4 s');
    await page.check('#mmark');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `moment-dialog-${mode}.png`) });
    await page.click('#msave');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await page.waitForSelector('#toast >> text=Ögonblicket sparas');
    const mine = await until(async () => { const m = (await req('/api/moments')).data.moments.find(x => x.title === `Från spelaren ${mode}`); return m?.state === 'ready' && m; }, 'klippet från spelaren');
    assert.equal(mine.mode, 'encode'); assert.equal(mine.watermark, true); assert.equal(mine.start, 2);
    await page.click('#cstop');
    // Flödet
    await page.goto(B + '/#/moments');
    await page.waitForSelector(`.mcard[data-mid="${mine.id}"] img`);
    await page.waitForFunction((id) => document.querySelector(`.mcard[data-mid="${id}"] img`)?.naturalWidth > 0, mine.id);
    assert.equal(await page.textContent('h1'), 'Ögonblick');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `moments-${mode}.png`), fullPage: true });
    const rb = `.mcard[data-mid="${mine.id}"] [data-react="😂"]`;
    if (phone) await page.tap(rb); else await page.click(rb);
    await page.waitForSelector(`${rb}[aria-pressed="true"]`);
    // Ett ögonblick: klippet, kommentar, dela
    await page.click(`.mcard[data-mid="${mine.id}"] .mtitle a`);
    await page.waitForSelector('#mvid');
    assert.equal(await page.getAttribute('#mvid', 'src'), `/api/moments/${mine.id}/video`);
    await page.fill('#mctext', 'Så bra!');
    await page.click('#mcform button[type=submit]');
    await page.waitForSelector('.mcomments >> text=Så bra!');
    await page.click('#mshare');
    await page.waitForSelector('dialog[open] #mhours');
    await page.click('#mmake');
    await page.waitForFunction(() => /\/api\/share\//.test(document.querySelector('#murl')?.value || ''));
    const url = await page.inputValue('#murl');
    assert.equal((await fetch(url)).status, 200);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `moment-share-${mode}.png`) });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.mshares [data-revoke]');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `moment-${mode}.png`), fullPage: true });
    // Spela filmen härifrån: spelaren startar vid ögonblickets start
    await page.click('#mplay');
    await page.waitForFunction(() => { const v = document.querySelector('#vid'); return v && v.readyState >= 2 && v.currentTime >= 1.9 && v.currentTime < 5; }, null, { timeout: 60000 });
    await page.click('#cstop');
    assert.deepEqual(errors.filter(e => !/\/api\/moments\/\d+\/video/.test(e)), []);
    await ctx.close();
  }
});
