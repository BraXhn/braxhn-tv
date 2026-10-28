// Diskrådgivaren (server/shrink.js, routes/shrink.js). Testfilerna görs med ffmpeg: en film i H.264 med hög
// bithastighet, två ljudspår (sv/en), undertext, kapitel, bilaga och titel; en film som redan är HEVC; en film i två
// versioner (720p och SD); en MP4 med mov_text-undertext och en serie med två avsnitt.
// Kontrolleras: uppskattningen och tidsfönstret (rena funktioner), kvalitetskontrollen (en suddig fil med låg
// bithastighet avvisas), analysen (bibliotek, serie, upplösning, codec, aldrig sedd, versioner, vinst), behörighet,
// kalibreringen, regler, avvisat jobb (originalet orört och markerat), atomärt byte där titeln behåller id, framsteg
// och betyg och skannern känner igen filen, att alla spår/kapitel/metadata följer med, återställning och papperskorgen.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasX265 = hasFfmpeg && /libx265/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-shrink-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 29000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
process.env.CONFIG_DIR = path.join(ROOT, 'unitconfig');
process.env.TRANSCODE_DIR = path.join(ROOT, 'unit-tc');
process.env.TRANSCODE_PROBE = '0';
const K = await import('../server/shrink.js');
const t = (name, fn) => test(name, { skip: !hasX265 && 'ffmpeg med libx265 saknas' }, fn);
let srv;
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', f]).toString());
const SRC = (size) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`];

// ---------------- rena funktioner ----------------
test('uppskattning, golv, redan effektiv codec, hinder och tidsfönster', () => {
  const st = JSON.stringify([{ type: 'video', index: 0 }, { type: 'audio', index: 1, codec: 'ac3', channels: 6 }]);
  // 2 h 1080p H.264 på 10 GB: video ≈ 11 111 − 640 kbit/s, HEVC 55 % → vinst ≈ 45 % av videon
  const e = K.estimate({ duration: 7200, size: 10e9, vcodec: 'h264', width: 1920, height: 1080, streams: st }, 'hevc', {});
  assert.ok(e.saving > 4e9 && e.saving < 5e9, JSON.stringify(e));
  assert.equal(e.after, 10e9 - e.saving);
  // Kalibrering skalar uppskattningen
  const e2 = K.estimate({ duration: 7200, size: 10e9, vcodec: 'h264', width: 1920, height: 1080, streams: st }, 'hevc', { hevc: { factor: 1.5 } });
  assert.ok(e2.saving < e.saving);
  // Låg bithastighet: golvet (2,5 Mbit/s för 1080p) gör att det inte lönar sig
  assert.match(K.estimate({ duration: 7200, size: 2.4e9, vcodec: 'h264', width: 1920, height: 1080, streams: st }, 'hevc', {}).skip, /låg bithastighet/);
  assert.equal(K.estimate({ duration: 60, size: 1e8, vcodec: 'hevc', width: 1920, height: 1080 }, 'hevc').skip, 'redan HEVC');
  assert.ok(K.estimate({ duration: 7200, size: 10e9, vcodec: 'hevc', width: 1920, height: 1080, streams: st }, 'av1', {}).saving > 0, 'HEVC → AV1 ger lite');
  assert.equal(K.resLabel(K.resBucket(3840, 1600)), '2160p'); assert.equal(K.resLabel(K.resBucket(1920, 800)), '1080p'); assert.equal(K.resLabel(K.resBucket(720, 576)), 'SD');
  assert.match(K.blocker({ hdr: 'dovi', streams: '[{"type":"video","dovi":true}]' }), /Dolby Vision/);
  assert.match(K.blocker({ hdr: 'hdr10', streams: '[{"type":"video"}]' }), /HDR/);
  assert.match(K.blocker({ streams: '[{"type":"video","field":"tt"}]' }), /flätad/);
  assert.equal(K.blocker({ streams: '[{"type":"video"}]' }), null);
  const at = (h, m) => new Date(2026, 0, 1, h, m);
  assert.ok(K.inWindow('01:00-07:00', at(3, 0))); assert.ok(!K.inWindow('01:00-07:00', at(7, 0))); assert.ok(!K.inWindow('01:00-07:00', at(20, 0)));
  assert.ok(K.inWindow('23:00-06:00', at(23, 30))); assert.ok(K.inWindow('23:00-06:00', at(5, 59))); assert.ok(!K.inWindow('23:00-06:00', at(12, 0)));
  assert.ok(K.inWindow('', at(12, 0)), 'tomt = alltid');
  assert.throws(() => K.saveSettings({ window: '25:00-01:00' }), /Tidsfönster/);
  assert.throws(() => K.saveSettings({ trashDays: 0 }), /papperskorgen/);
});

t('kvalitetskontrollen: en bra omkodning godkänns, en suddig med låg bithastighet avvisas', async () => {
  const d = path.join(ROOT, 'q'); fs.mkdirSync(d);
  const ref = path.join(d, 'ref.mkv'), good = path.join(d, 'good.mkv'), bad = path.join(d, 'bad.mkv');
  ff(...SRC('640x360'), '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', ref);
  ff('-i', ref, '-c:v', 'libx265', '-preset', 'fast', '-crf', '22', '-x265-params', 'log-level=error', good);
  ff('-i', ref, '-vf', 'boxblur=6', '-c:v', 'libx264', '-b:v', '30k', bad);
  const g = await K.qualityCheck(ref, good, { samples: 2, metric: 'ssim' });
  assert.ok(g.ok, JSON.stringify(g)); assert.ok(g.score > 0.98 && g.psnr > 38, JSON.stringify(g));
  assert.equal(g.samples.length, 2);
  const b = await K.qualityCheck(ref, bad, { samples: 2, metric: 'ssim' });
  assert.equal(b.ok, false, JSON.stringify(b)); assert.ok(b.score < 0.9);
});

// ---------------- mot en riktig server ----------------
let admin = '', user = '';
const S = {};
async function req(p, { method = 'GET', body, tok = admin } = {}) {
  const h = {};
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (name, password) => (await req('/api/login', { method: 'POST', body: { name, password, app: true }, tok: '' })).data.token;
async function until(fn, what, n = 240) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await sleep(500); }
  assert.fail('väntade förgäves: ' + what);
}
const DB = path.join(CONFIG, 'braxhn-tv.db');
const dbq = (sql, ...p) => { const db = new DatabaseSync(DB, { readOnly: true }); try { return db.prepare(sql).all(...p); } finally { db.close(); } };
const dbw = (sql, ...p) => { const db = new DatabaseSync(DB); try { db.exec('PRAGMA busy_timeout=5000'); return db.prepare(sql).run(...p); } finally { db.close(); } };
const advisor = async (q = '') => (await req('/api/admin/shrink' + q)).data;
const jobOf = async (id) => (await advisor()).jobs.find(j => j.id === id);
async function runJob(item, body = {}) {
  const r = await req('/api/admin/shrink/queue', { method: 'POST', body: { items: [item], ...body } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data.queued, [item], JSON.stringify(r.data));
  const id = (await advisor()).jobs.find(j => j.item === item && j.status === 'queued')?.id;
  assert.ok(id);
  await req('/api/admin/shrink/run', { method: 'POST', body: {} });
  return until(async () => { const j = await jobOf(id); return !['queued', 'running'].includes(j.status) && j; }, 'jobbet blev klart');
}
const scanned = () => until(async () => !(await req('/api/jobs')).data.jobs.some(j => j.kind === 'scan'), 'skanningen blev klar');
const film = (dir, name = dir, ext = '.mkv') => path.join(MEDIA, 'Filmer', dir, name + ext);

t('servern: analys, behörighet, kalibrering, regler, avvisning, byte, återställning och papperskorg', async (tt) => {
  for (const n of ['Stor (2010)', 'Liten (2011)', 'Dubbel (2012)', 'Mp4 (2013)']) fs.mkdirSync(path.join(MEDIA, 'Filmer', n), { recursive: true });
  const season = path.join(MEDIA, 'Serier', 'Bron', 'Season 01'); fs.mkdirSync(season, { recursive: true });
  const srt = path.join(ROOT, 's.srt'); fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nHej hej\n\n2\n00:00:05,000 --> 00:00:07,000\nHej då\n');
  const ch = path.join(ROOT, 'ch.txt'); fs.writeFileSync(ch, ';FFMETADATA1\ntitle=Stor film\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=6000\ntitle=Början\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=6000\nEND=12000\ntitle=Slutet\n');
  const font = path.join(ROOT, 'font.ttf'); fs.writeFileSync(font, Buffer.alloc(2048, 7));
  ff(...SRC('640x360'), '-f', 'lavfi', '-i', 'sine=frequency=300', '-f', 'lavfi', '-i', 'sine=frequency=500', '-i', srt, '-i', ch, '-t', '12',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3', '-map_metadata', '4', '-map_chapters', '4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=swe', '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=Engelska', '-metadata:s:s:0', 'language=swe',
    '-attach', font, '-metadata:s:t', 'mimetype=application/x-truetype-font', '-metadata:s:t', 'filename=font.ttf', film('Stor (2010)'));
  ff(...SRC('640x360'), '-t', '6', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', film('Liten (2011)'));
  ff(...SRC('1280x720'), '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', film('Dubbel (2012)', 'Dubbel (2012) - 720p'));
  ff(...SRC('640x360'), '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', film('Dubbel (2012)', 'Dubbel (2012) - SD'));
  ff(...SRC('640x360'), '-f', 'lavfi', '-i', 'sine=frequency=400', '-i', srt, '-t', '8', '-map', '0:v', '-map', '1:a', '-map', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'mov_text', film('Mp4 (2013)', 'Mp4 (2013)', '.mp4'));
  for (const e of ['01', '02']) ff(...SRC('640x360'), '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-pix_fmt', 'yuv420p', path.join(season, `Bron S01E${e}.mkv`));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', HEALTH: '0', SUBINDEX: '0', SHRINK_POLL_MS: '300', SHRINK_X265_PRESET: 'fast' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin', PW);
  S.F = (await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).data.id;
  S.T = (await req('/api/libraries', { method: 'POST', body: { name: 'Serier', type: 'show', path: path.join(MEDIA, 'Serier') } })).data.id;
  await until(async () => dbq("SELECT COUNT(*) AS n FROM items WHERE kind IN ('movie','episode')")[0].n === 7, 'filerna skannades');
  await scanned();
  for (const r of dbq("SELECT id, path FROM items WHERE kind IN ('movie','episode')")) S[path.basename(r.path)] = r.id;
  S.stor = S['Stor (2010).mkv']; S.mp4 = S['Mp4 (2013).mp4']; S.e1 = S['Bron S01E01.mkv'];
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'anna', password: PW } })).status, 200);
  user = await login('anna', PW);
  // Anna har sett halva Stor och gett den fyra stjärnor
  assert.equal((await req(`/api/items/${S.stor}/progress`, { method: 'POST', body: { position: 5, duration: 12 }, tok: user })).status, 200);
  assert.equal((await req(`/api/items/${S.stor}/rating`, { method: 'PUT', body: { rating: 4 }, tok: user })).status, 200);
  const rating0 = dbq('SELECT value FROM item_ratings WHERE item_id=?', S.stor)[0]?.value;
  assert.ok(rating0, 'betyget sparades');

  await tt.test('analysen', async () => {
    assert.equal((await req('/api/admin/shrink', { tok: user })).status, 403, 'bara administratören');
    const d = await advisor();
    const r = d.report;
    assert.equal(r.totals.count, 7);
    assert.deepEqual(r.libraries.map(l => l.label).sort(), ['Filmer', 'Serier']);
    assert.equal(r.shows.length, 1); assert.equal(r.shows[0].label, 'Bron'); assert.equal(r.shows[0].count, 2);
    assert.deepEqual(r.codecs.map(c => c.key).sort(), ['h264', 'hevc']);
    assert.ok(r.resolutions.some(x => x.key === '720p') && r.resolutions.some(x => x.key === 'SD'));
    assert.equal(r.totals.never.count, 6, 'alla utom Stor är osedda');
    const stor = r.titles.find(x => x.id === S.stor);
    assert.equal(stor.never, false); assert.ok(stor.lastSeen); assert.deepEqual(stor.wanted, ['påbörjad']);
    assert.ok(stor.mbPerMin > 0); assert.ok(stor.estimate.saving > 0, JSON.stringify(stor.estimate));
    assert.equal(r.titles.find(x => x.file === 'Liten (2011).mkv').estimate.skip, 'redan HEVC');
    assert.equal(r.versions.length, 1);
    assert.equal(r.versions[0].files.length, 2);
    assert.equal(r.versions[0].reclaim, r.titles.find(x => x.file === 'Dubbel (2012) - SD.mkv').size, 'SD-versionen är överflödig när 720p finns');
    // Sortering och filter per bibliotek
    const g = (await advisor(`?sort=gain&lib=${S.T}`)).report.titles;
    assert.deepEqual(g.map(x => x.kind), ['episode', 'episode']);
    assert.equal(d.metric, /libvmaf/.test(execFileSync('ffmpeg', ['-hide_banner', '-filters']).toString()) ? 'vmaf' : 'ssim');
    assert.deepEqual(d.jobs, []);
  });

  await tt.test('processorn bara om administratören valt det; kalibrering och regler', async () => {
    let r = await req('/api/admin/shrink/queue', { method: 'POST', body: { items: [S.stor] } });
    assert.equal(r.status, 409, 'ingen kodare på grafikkortet och processorn inte tillåten'); assert.match(r.data.error, /processorn/);
    assert.equal((await req('/api/admin/shrink/settings', { method: 'PUT', body: { window: '99:00' } })).status, 400);
    r = await req('/api/admin/shrink/settings', { method: 'PUT', body: { allowCpu: true, window: '', onlyIdle: false, samples: 2 } });
    assert.equal(r.status, 200); assert.equal(r.data.encoders.hevc.use, 'libx265'); assert.equal(r.data.settings.window, '');
    r = await req('/api/admin/shrink/calibrate', { method: 'POST', body: { item: S.e1 } });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(r.data.factor > 0 && r.data.measured > 0, JSON.stringify(r.data));
    assert.equal((await advisor()).report.calibration.hevc.n, 1);
    assert.ok(!fs.readdirSync(season).some(f => f.startsWith('.braxhn-prov')), 'provmappen städades bort');
    r = await req('/api/admin/shrink/queue', { method: 'POST', body: { rule: { codecs: ['h264'], library: S.F }, preview: true } });
    assert.equal(r.status, 200); assert.ok(r.data.titles.some(x => x.id === S.stor)); assert.ok(!r.data.titles.some(x => x.id === S.e1), 'bara biblioteket Filmer');
  });

  await tt.test('kvaliteten räcker inte: originalet behålls och titeln markeras', async () => {
    const before = sha(path.join(season, 'Bron S01E01.mkv'));
    await req('/api/admin/shrink/settings', { method: 'PUT', body: { minSsim: 0.99999, minPsnr: 99, minVmaf: 100 } });
    const j = await runJob(S.e1);
    assert.equal(j.status, 'rejected', JSON.stringify(j)); assert.match(j.error, /kvaliteten räckte inte/);
    assert.ok(j.score > 0 && j.scores.samples.length === 2);
    assert.equal(sha(path.join(season, 'Bron S01E01.mkv')), before, 'originalet orört');
    assert.deepEqual(fs.readdirSync(season).filter(f => f.startsWith('.')), [], 'ingen kandidat kvar');
    assert.equal((await advisor()).report.titles.find(x => x.id === S.e1).job.status, 'rejected');
    const r = await req('/api/admin/shrink/queue', { method: 'POST', body: { items: [S.e1] } });
    assert.deepEqual(r.data.queued, []); assert.match(r.data.skipped[0].reason, /kvaliteten/);
    await req('/api/admin/shrink/settings', { method: 'PUT', body: { minSsim: 0.97, minPsnr: 35, minVmaf: 90 } });
  });

  let storJob;
  await tt.test('byte: samma sökväg och id, framsteg och betyg kvar, alla spår, kapitel och metadata följer med', async () => {
    const file = film('Stor (2010)'), orig = sha(file), size0 = fs.statSync(file).size, p0 = probe(file);
    const prog0 = dbq('SELECT position, watched FROM progress WHERE item_id=?', S.stor);
    const j = storJob = await runJob(S.stor);
    assert.equal(j.status, 'done', JSON.stringify(j));
    assert.ok(j.outSize < size0); assert.equal(j.trash, true);
    const p = probe(file);
    assert.equal(p.streams.find(s => s.codec_type === 'video').codec_name, 'hevc');
    assert.deepEqual(p.streams.map(s => s.codec_type), p0.streams.map(s => s.codec_type), 'samma spår i samma ordning');
    assert.deepEqual(p.streams.filter(s => s.codec_type === 'audio').map(s => s.tags.language), ['swe', 'eng']);
    assert.equal(p.streams.find(s => s.codec_type === 'audio' && s.tags.language === 'eng').tags.title, 'Engelska');
    assert.equal(p.streams.find(s => s.codec_type === 'subtitle').tags.language, 'swe');
    assert.equal(p.streams.find(s => s.codec_type === 'attachment').tags.filename, 'font.ttf');
    assert.deepEqual(p.chapters.map(c => c.tags.title), ['Början', 'Slutet']);
    assert.equal(p.format.tags.title, 'Stor film');
    assert.ok(Math.abs(+p.format.duration - +p0.format.duration) < 0.5);
    // Originalet ligger orört i papperskorgen (som skannern inte läser)
    const trash = path.join(MEDIA, 'Filmer', '.braxhn-papperskorg');
    const tf = fs.readdirSync(trash); assert.equal(tf.length, 1); assert.match(tf[0], /\.original$/);
    assert.equal(sha(path.join(trash, tf[0])), orig);
    const row = dbq('SELECT id, path, vcodec, size FROM items WHERE id=?', S.stor)[0];
    assert.equal(row.path, file); assert.equal(row.vcodec, 'hevc'); assert.equal(row.size, fs.statSync(file).size);
    // Skanna om: samma rad, inga nya titlar, framsteg och betyg kvar
    await req('/api/scan', { method: 'POST', body: {} }); await sleep(800); await scanned();
    assert.equal(dbq("SELECT COUNT(*) AS n FROM items WHERE kind IN ('movie','episode')")[0].n, 7);
    assert.equal(dbq('SELECT id FROM items WHERE path=?', file)[0].id, S.stor);
    assert.deepEqual(dbq('SELECT position, watched FROM progress WHERE item_id=?', S.stor), prog0);
    assert.equal(dbq('SELECT value FROM item_ratings WHERE item_id=?', S.stor)[0].value, rating0);
    const est = (await advisor()).report.titles.find(x => x.id === S.stor);
    assert.equal(est.estimate.skip, 'redan HEVC'); assert.equal(est.job.status, 'done'); assert.ok(est.job.saved > 0);
  });

  await tt.test('MP4 med mov_text förblir MP4; återställning ger originalet tillbaka', async () => {
    const file = film('Mp4 (2013)', 'Mp4 (2013)', '.mp4'), orig = sha(file);
    const j = await runJob(S.mp4);
    assert.equal(j.status, 'done', JSON.stringify(j));
    const p = probe(file);
    assert.equal(p.streams.find(s => s.codec_type === 'video').codec_name, 'hevc');
    assert.equal(p.streams.find(s => s.codec_type === 'video').codec_tag_string, 'hvc1');
    assert.equal(p.streams.find(s => s.codec_type === 'subtitle').codec_name, 'mov_text');
    assert.equal(dbq('SELECT path FROM items WHERE id=?', S.mp4)[0].path, file);
    assert.equal((await req(`/api/admin/shrink/jobs/${j.id}/restore`, { method: 'POST', body: {} })).status, 200);
    assert.equal(sha(file), orig);
    assert.equal(dbq('SELECT vcodec FROM items WHERE id=?', S.mp4)[0].vcodec, 'h264');
    assert.equal((await jobOf(j.id)).status, 'restored');
    assert.equal((await req(`/api/admin/shrink/jobs/${j.id}/restore`, { method: 'POST', body: {} })).status, 404);
  });

  await tt.test('papperskorgen töms först efter sina dagar', async () => {
    const trash = path.join(MEDIA, 'Filmer', '.braxhn-papperskorg');
    await req('/api/admin/shrink/run', { method: 'POST', body: {} }); await sleep(800);
    assert.equal(fs.readdirSync(trash).length, 1, 'inte förrän datumet passerats');
    const until0 = dbq('SELECT trash_until, finished FROM shrink_jobs WHERE id=?', storJob.id)[0];
    assert.ok(until0.trash_until - until0.finished >= 14 * 86400 - 5, 'standard 14 dagar');
    dbw('UPDATE shrink_jobs SET trash_until=? WHERE id=?', Math.floor(Date.now() / 1000) - 10, storJob.id);
    await req('/api/admin/shrink/run', { method: 'POST', body: {} });
    await until(async () => fs.readdirSync(trash).length === 0, 'papperskorgen tömdes');
    assert.equal((await jobOf(storJob.id)).trash, false);
    assert.ok(fs.existsSync(film('Stor (2010)')), 'den nya filen finns kvar');
    assert.equal((await req(`/api/admin/shrink/jobs/${storJob.id}/trash`, { method: 'DELETE' })).status, 404);
  });
});
