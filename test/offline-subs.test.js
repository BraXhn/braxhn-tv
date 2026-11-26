// Offline-filen (server/offline.js) har textundertexterna som mov_text-spår i själva MP4-filen, så att telefonens egen
// spelare (helskärm, bild-i-bild, AirPlay/Chromecast) kan visa dem. En kort genererad MKV med två inbäddade
// textundertexter (sv, en), en PGS-bildundertext (hoppas över) och en extern .de.srt. Kontrolleras med ffprobe: spåren,
// språken, titlarna och standardspåret efter kontots val – och att familjefiltrets maskning (*** i stället för
// svordomen) finns i filen för en profil med filtret på men inte för en utan, i två olika cachefiler. Kräver ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { freePort } from './helpers/port.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-offsubs-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config'), OUT = path.join(ROOT, 'out');
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv;
after(() => { srv?.kill(); if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true }); else console.log('kvar:', ROOT); });

const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let admin = '';
async function req(p, { method = 'GET', body, tok = admin } = {}) {
  const h = {};
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const login = async (name) => (await req('/api/login', { method: 'POST', body: { name, password: PW, app: true }, tok: '' })).data.token;
async function until(fn, what, n = 240) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await sleep(250); }
  assert.fail('väntade förgäves: ' + what);
}

// Minimal PGS-ström (som i fast-start.test.js): ett rött block 1–3 s
function seg(type, pts, body) {
  const h = Buffer.alloc(13);
  h.write('PG', 0, 'latin1'); h.writeUInt32BE(Math.round(pts * 90000), 2); h[10] = type; h.writeUInt16BE(body.length, 11);
  return Buffer.concat([h, body]);
}
function sup() {
  const pcs = (pts, objs, state) => {
    const b = Buffer.alloc(11 + objs * 8);
    b.writeUInt16BE(1920, 0); b.writeUInt16BE(1080, 2); b[4] = 0x10; b.writeUInt16BE(1, 5); b[7] = state; b[8] = 0; b[9] = 0; b[10] = objs;
    if (objs) { b.writeUInt16BE(0, 11); b[13] = 0; b[14] = 0; b.writeUInt16BE(100, 15); b.writeUInt16BE(900, 17); }
    return seg(0x16, pts, b);
  };
  const wds = (pts) => { const b = Buffer.alloc(10); b[0] = 1; b[1] = 0; b.writeUInt16BE(100, 2); b.writeUInt16BE(900, 4); b.writeUInt16BE(8, 6); b.writeUInt16BE(2, 8); return seg(0x17, pts, b); };
  const pds = seg(0x14, 1, Buffer.from([0, 0, 1, 63, 240, 102, 255]));
  const rle = Buffer.from([0x00, 0x88, 0x01, 0x00, 0x00, 0x00, 0x84, 0x01, 0x00, 0x04, 0x00, 0x00]);
  const ods = Buffer.alloc(11); ods.writeUInt16BE(0, 0); ods[2] = 0; ods[3] = 0xc0; ods.writeUIntBE(rle.length + 4, 4, 3); ods.writeUInt16BE(8, 7); ods.writeUInt16BE(2, 9);
  return Buffer.concat([pcs(1, 1, 0x80), wds(1), pds, seg(0x15, 1, Buffer.concat([ods, rle])), seg(0x80, 1, Buffer.alloc(0)),
    pcs(3, 0, 0), wds(3), seg(0x80, 3, Buffer.alloc(0))]);
}

const FILM = 'Undertexter (2022)', MP4 = 'Passar (2023)', BARE = 'Utan text (2024)';
const SV = '1\n00:00:01,000 --> 00:00:02,500\nFan, vad kallt det är!\n\n2\n00:00:03,000 --> 00:00:04,000\nHej på dig.\n';
const EN = '1\n00:00:01,000 --> 00:00:02,500\nOh shit, it is cold!\n\n2\n00:00:03,000 --> 00:00:04,000\nHello there.\n';
const DE = '1\n00:00:01,500 --> 00:00:03,000\nGuten Tag.\n';
const S = {};

t('förberedelse: film med två inbäddade textundertexter, en bildundertext och en extern .srt', async () => {
  const dir = path.join(MEDIA, 'Filmer', FILM), tmp = path.join(ROOT, 'src');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(tmp, { recursive: true }); fs.mkdirSync(OUT);
  fs.writeFileSync(path.join(tmp, 'sv.srt'), SV); fs.writeFileSync(path.join(tmp, 'en.srt'), EN); fs.writeFileSync(path.join(tmp, 'a.sup'), sup());
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-i', path.join(tmp, 'sv.srt'), '-i', path.join(tmp, 'en.srt'), '-i', path.join(tmp, 'a.sup'), '-t', '6',
    '-map', '0:v', '-map', '1:a', '-map', '2', '-map', '3', '-map', '4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-c:s:0', 'srt', '-c:s:1', 'srt', '-c:s:2', 'copy',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:s:0', 'language=swe', '-metadata:s:s:0', 'title=Svenska',
    '-metadata:s:s:1', 'language=eng', '-metadata:s:s:2', 'language=swe', path.join(dir, FILM + '.mkv'));
  fs.writeFileSync(path.join(dir, FILM + '.de.srt'), DE);
  // MP4 som redan passar telefonen (H.264/AAC): en med extern .sv.srt, en helt utan undertexter
  for (const name of [MP4, BARE]) {
    const d = path.join(MEDIA, 'Filmer', name); fs.mkdirSync(d, { recursive: true });
    ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', path.join(d, name + '.mp4'));
  }
  fs.writeFileSync(path.join(MEDIA, 'Filmer', MP4, MP4 + '.sv.srt'), SV);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', SUBINDEX_FTS: '' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin');
  const lib = (await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).data.id;
  const items = await until(async () => { const r = (await req(`/api/libraries/${lib}/items`)).data.items; return r?.length === 3 && r; }, 'filmerna skannades');
  S.film = items.find(i => i.title === 'Undertexter').id; S.mp4 = items.find(i => i.title === 'Passar').id; S.bare = items.find(i => i.title === 'Utan text').id;
  const subs = (await req(`/api/items/${S.film}`)).data.subtitles;
  assert.deepEqual(subs.map(s => [s.id, s.bitmap]), [['e2', false], ['e3', false], ['e4', true], ['x0', false]]);
  // En vuxen profil som valt familjefiltret (maskerar undertexter) och vill ha engelska undertexter
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'valt', password: PW } })).status, 200);
  S.valt = await login('valt');
  assert.equal((await req('/api/me/family-filter', { method: 'PUT', body: { mode: 'mute' }, tok: S.valt })).status, 200);
  assert.equal((await req('/api/me/playback-prefs', { method: 'PUT', body: { subMode: 'always', subLangs: ['en'] }, tok: S.valt })).status, 200);
});

// Ladda ner offline-filen för profilen (POST, vänta på ready, hämta url) och ge sökvägen
async function download(tok, name, q = '480', id = S.film) {
  const st0 = (await req(`/api/items/${id}/offline`, { method: 'POST', body: { q }, tok })).data;
  assert.ok(['queued', 'running', 'ready'].includes(st0.status), JSON.stringify(st0));
  const st = await until(async () => { const r = (await req(`/api/items/${id}/offline?q=${q}`, { tok })).data; assert.notEqual(r.status, 'error', r.error); return r.status === 'ready' && r; }, 'offline-filen');
  const r = await fetch(B + st.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  const f = path.join(OUT, name + '.mp4');
  fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  return f;
}
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', f]).toString()).streams;
const subText = (f, n) => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', `0:s:${n}`, '-f', 'srt', '-']).toString();

t('offline-filen har textundertexterna som mov_text med språk och titel; bildundertexten hoppas över', async () => {
  const f = await download(admin, 'admin');
  const s = probe(f);
  assert.deepEqual(s.filter(x => x.codec_type !== 'subtitle').map(x => x.codec_type), ['video', 'audio']);
  const subs = s.filter(x => x.codec_type === 'subtitle');
  assert.deepEqual(subs.map(x => x.codec_name), ['mov_text', 'mov_text', 'mov_text'], 'två inbäddade och den externa, inte PGS');
  assert.deepEqual(subs.map(x => x.tags?.language), ['swe', 'eng', 'ger']);
  assert.match(subs[0].tags?.handler_name || '', /Svenska/);
  // Administratören har standardvalet (bara tvingade undertexter): inget spår förvalt av servern. MP4-muxern i ffmpeg
  // markerar ändå alltid första spåret av varje typ som påslaget när inget är förvalt (enable_tracks i movenc.c).
  assert.deepEqual(subs.map(x => x.disposition.default), [1, 0, 0]);
  assert.deepEqual(subs.map(x => x.disposition.forced), [0, 0, 0]);
  assert.match(subText(f, 1), /Oh shit, it is cold!/, 'omaskat utan filtret');
  assert.match(subText(f, 0), /Fan, vad kallt det är!/);
  assert.match(subText(f, 2), /Guten Tag\./);
  assert.match(subText(f, 2), /00:00:01,500 --> 00:00:03,000/);
});

t('familjefiltret: maskerad undertext i filen för profilen med filtret, egen cachefil, standardspåret efter kontots val', async () => {
  const f = await download(S.valt, 'valt');
  const subs = probe(f).filter(x => x.codec_type === 'subtitle');
  assert.deepEqual(subs.map(x => x.tags?.language), ['swe', 'eng', 'ger']);
  assert.deepEqual(subs.map(x => x.disposition.default), [0, 1, 0], 'engelska förvalt (always + en)');
  assert.match(subText(f, 1), /Oh \*\*\*, it is cold!/);
  assert.match(subText(f, 0), /\*\*\*, vad kallt det är!/);
  // Administratörens fil är fortfarande omaskad (varianterna blandas inte ihop)
  const g = await download(admin, 'admin2');
  assert.match(subText(g, 1), /Oh shit, it is cold!/);
  const cache = fs.readdirSync(path.join(CONFIG, 'cache', 'offline')).filter(x => x.endsWith('.mp4'));
  assert.ok(cache.length >= 2, cache.join(', '));
});

t('full upplösning (orig): bilden kopieras och undertexterna följer med', async () => {
  const f = await download(admin, 'orig', 'orig');
  const s = probe(f);
  assert.equal(s.find(x => x.codec_type === 'video').codec_name, 'h264');
  assert.equal(s.filter(x => x.codec_type === 'subtitle' && x.codec_name === 'mov_text').length, 3);
});

t('full upplösning: MP4 som redan passar muxas om med undertexten; utan undertexter serveras originalfilen som förut', async () => {
  const f = await download(admin, 'mp4', 'orig', S.mp4);
  const s = probe(f);
  assert.deepEqual(s.map(x => x.codec_name), ['h264', 'aac', 'mov_text']);
  assert.equal(s[2].tags?.language, 'swe', '.sv.srt → swe');
  assert.match(subText(f, 0), /Fan, vad kallt det är!/);
  const st = (await req(`/api/items/${S.bare}/offline?q=orig`)).data;
  assert.equal(st.status, 'ready'); assert.equal(st.original, true);
  assert.equal(st.size, fs.statSync(path.join(MEDIA, 'Filmer', BARE, BARE + '.mp4')).size);
});

t('cachen: grundfilen (gamla nyckeln, utan undertexter) serveras inte för en titel med undertexter', async () => {
  const dir = path.join(CONFIG, 'cache', 'offline');
  const files = fs.readdirSync(dir).filter(x => x.endsWith('.mp4'));
  const base = files.find(x => new RegExp(`^${S.film}-\\d+-480\\.mp4$`).test(x));
  assert.ok(base, 'grundfilen finns: ' + files.join(', '));
  assert.equal(probe(path.join(dir, base)).filter(x => x.codec_type === 'subtitle').length, 0);
  assert.equal(files.filter(x => x.startsWith(base.replace('.mp4', '-t'))).length, 2, 'en omaskad och en maskerad variant');
  // Utan undertexter i titeln (480p): filen har samma nyckel som förut
  await download(admin, 'bare480', '480', S.bare);
  assert.ok(fs.readdirSync(dir).some(x => new RegExp(`^${S.bare}-\\d+-480\\.mp4$`).test(x)));
});
