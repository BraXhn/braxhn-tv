// Integrationstester mot en riktig server med genererade testfiler. Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-int-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
let srv, cookie = '';
const PW = 'Testlösen-2026!';

const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
async function req(p, { method = 'GET', body, headers = {}, auth = true } = {}) {
  const h = { ...headers };
  if (auth && cookie) h.cookie = cookie;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc) && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitScan() { for (let i = 0; i < 120; i++) { await sleep(1000); const r = await req('/api/scan'); if (!r.data.running && !r.data.analysis?.running && r.data.last) return; } throw new Error('skanning tog för lång tid'); }

before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(path.join(MEDIA, 'Filmer'), { recursive: true });
  fs.mkdirSync(path.join(MEDIA, 'Serier', 'Serien', 'Season 1'), { recursive: true });
  // Film: H.264 i MKV med AC3 (→ remux), oregelbundna nyckelbilder
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-x264-params', 'keyint=72:min-keyint=10', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', path.join(MEDIA, 'Filmer', 'Remux Film (2020).mkv'));
  fs.writeFileSync(path.join(MEDIA, 'Filmer', 'Remux Film (2020).sv.srt'), '1\n00:00:01,000 --> 00:00:04,000\nHej\n');
  // Film: HEVC 8-bit i MKV med E-AC-3 5.1 (→ fMP4-remux för Apple, passthrough)
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=200', '-t', '40',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=96:min-keyint=24:log-level=error', '-pix_fmt', 'yuv420p', '-c:a', 'eac3', '-ac', '6', path.join(MEDIA, 'Filmer', 'Hevc Film (2022).mkv'));
  // Film: MP4 (direkt)
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(MEDIA, 'Filmer', 'Direkt (2021).mp4'));
  // Serie med gemensamt intro
  ff('-f', 'lavfi', '-i', 'anoisesrc=seed=7:color=pink:amplitude=0.4', '-t', '30', '-ar', '48000', path.join(ROOT, 'intro.wav'));
  for (const [n, pre] of [[1, 15], [2, 40], [3, 5]]) {
    const w = path.join(ROOT, `ep${n}.wav`);
    ff('-f', 'lavfi', '-i', `anoisesrc=seed=${n}:color=brown:amplitude=0.4`, '-t', String(pre), '-ar', '48000', path.join(ROOT, 'pre.wav'));
    ff('-f', 'lavfi', '-i', `anoisesrc=seed=${n + 100}:color=white:amplitude=0.2`, '-t', String(140 - pre), '-ar', '48000', path.join(ROOT, 'post.wav'));
    ff('-i', path.join(ROOT, 'pre.wav'), '-i', path.join(ROOT, 'intro.wav'), '-i', path.join(ROOT, 'post.wav'), '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1[a]', '-map', '[a]', w);
    ff('-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=5', '-i', w, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(MEDIA, 'Serier', 'Serien', 'Season 1', `Serien S01E0${n}.mkv`));
  }
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1) },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

t('första kontot: svagt lösenord nekas, utifrån nekas', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: 'kort' } })).status, 400);
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, headers: { 'x-forwarded-for': '81.2.3.4' } })).status, 403);
  // en utomstående får inte veta att servern är nyinstallerad
  assert.equal((await req('/api/status', { headers: { 'x-forwarded-for': '81.2.3.4' } })).data.needsSetup, false);
  assert.equal((await req('/api/status')).data.needsSetup, true);
});

t('skapa admin och bibliotek, skanna', async () => {
  const r = await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).status, 200);
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Serier', type: 'show', path: path.join(MEDIA, 'Serier') } })).status, 200);
  await waitScan();
  const libs = (await req('/api/libraries')).data;
  assert.equal(libs.find(l => l.type === 'movie').count, 3);
  assert.equal(libs.find(l => l.type === 'show').count, 1);
});

t('säkerhet: CSRF, admin utifrån, setup igen, token i URL', async () => {
  assert.equal((await req('/api/logout', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req('/api/users', { headers: { 'x-forwarded-for': '81.2.3.4' } })).status, 403);
  // förfalskad vänsterdel i XFF hjälper inte
  assert.equal((await req('/api/users', { headers: { 'x-forwarded-for': '192.168.1.2, 81.2.3.4' } })).status, 403);
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'x', password: PW } })).status, 403);
  const lr = await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, auth: false });
  assert.equal(lr.status, 200);
  const app = lr.data.token;
  assert.equal((await req('/api/home?t=' + app, { auth: false })).status, 401, 'kontotoken får inte accepteras i URL');
  assert.equal((await req('/api/home', { auth: false, headers: { authorization: 'Bearer ' + app } })).status, 200);
});

t('inloggning: fel lösenord ger samma svar för okänt konto', async () => {
  const a = await req('/api/login', { method: 'POST', body: { name: 'admin', password: 'fel' }, auth: false, headers: { 'x-forwarded-for': '81.9.9.1' } });
  const b = await req('/api/login', { method: 'POST', body: { name: 'finnsinte', password: 'fel' }, auth: false, headers: { 'x-forwarded-for': '81.9.9.2' } });
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.data.error, b.data.error);
});

t('uppspelningsbeslut och mediatoken per titel', async () => {
  const items = (await req('/api/libraries/1/items')).data.items;
  const remux = items.find(i => i.title === 'Remux Film'), direct = items.find(i => i.title === 'Direkt');
  const lr = await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, auth: false });
  const H = { authorization: 'Bearer ' + lr.data.token };
  const p1 = (await req(`/api/items/${direct.id}/playback`, { auth: false, headers: H })).data;
  assert.equal(p1.mode, 'direct');
  const p2 = (await req(`/api/items/${remux.id}/playback`, { auth: false, headers: H })).data;
  assert.equal(p2.mode, 'remux');
  const tok = new URL(B + p2.url).searchParams.get('t');
  assert.match(tok, /^[a-f0-9]{64}$/);
  assert.equal((await req(`/api/stream/${direct.id}/direct?t=${tok}`, { auth: false })).status, 401, 'token gäller bara sin titel');
  assert.equal((await req(`/api/home?t=${tok}`, { auth: false })).status, 401);
  // undertext via mediatoken + tidsförskjutning
  const sub = p2.subtitles[0];
  const vtt = (await req(sub.url + '&offset=2', { auth: false })).data.toString();
  assert.match(vtt, /00:00:03\.000 --> 00:00:06\.000/);
});

t('remux: segmentgränser följer nyckelbilder, även efter spolning', async () => {
  const items = (await req('/api/libraries/1/items')).data.items;
  const it = items.find(i => i.title === 'Remux Film');
  const pb = (await req(`/api/items/${it.id}/playback`)).data;
  const idx = pb.url.replace('master.m3u8', 'index.m3u8');
  const pl = (await req(idx)).data.toString();
  const durs = [...pl.matchAll(/#EXTINF:([\d.]+)/g)].map(m => +m[1]);
  const starts = durs.reduce((a, d, i) => (a.push(i ? a[i - 1] + durs[i - 1] : 0), a), []);
  const segUrl = (n) => idx.replace('index.m3u8', `seg-${n}.ts`);
  for (const n of [0, 1, 5, 2]) {
    const r = await req(segUrl(n));
    assert.equal(r.status, 200);
    const f = path.join(ROOT, `s${n}.ts`); fs.writeFileSync(f, r.data);
    const st = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', f]).toString();
    assert.ok(Math.abs(st - starts[n]) < 0.1, `segment ${n}: start ${st} ≠ ${starts[n]}`);
    const codecs = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', f]).toString();
    assert.match(codecs, /h264/); assert.match(codecs, /aac/);
  }
});

t('intro hittas automatiskt', async () => {
  for (let i = 0; i < 90; i++) {
    const show = (await req('/api/libraries/2/items')).data.items[0];
    const d = (await req(`/api/items/${show.id}`)).data;
    const eps = d.children;
    if (eps.every(e => e.intro)) {
      const exp = { 1: 15, 2: 40, 3: 5 };
      for (const e of eps) {
        assert.ok(Math.abs(e.intro.start - exp[e.episode]) < 1.5, `avsnitt ${e.episode}: start ${e.intro.start}`);
        assert.ok(Math.abs(e.intro.end - (exp[e.episode] + 30)) < 1.5, `avsnitt ${e.episode}: slut ${e.intro.end}`);
      }
      return;
    }
    await sleep(1000);
  }
  assert.fail('intro hittades inte');
});

t('HEVC: fMP4-remux med orört E-AC-3 för Apple-enheter, absolut tidsstämpel efter spolning', async () => {
  const items = (await req('/api/libraries/1/items')).data.items;
  const it = items.find(i => i.title === 'Hevc Film');
  const apple = 'c=mp4&v=h264,hevc&a=aac,ac3,eac3&hdr=1';
  const pb = (await req(`/api/items/${it.id}/playback?${apple}`)).data;
  assert.equal(pb.mode, 'remux'); assert.match(pb.url, /fmt=fmp4/); assert.match(pb.url, /am=copy/);
  const web = (await req(`/api/items/${it.id}/playback`)).data;
  assert.equal(web.mode, 'transcode', 'webbläsare utan HEVC ska få omkodning');
  const q = pb.url.split('?')[1];
  const pl = (await req(`/api/stream/${it.id}/hls/index.m3u8?${q}`)).data.toString();
  assert.match(pl, /#EXT-X-MAP:URI="init\.mp4/);
  const durs = [...pl.matchAll(/#EXTINF:([\d.]+)/g)].map(m => +m[1]);
  const n = durs.length - 2, expected = durs.slice(0, n).reduce((a, b) => a + b, 0);
  const seg = (await req(`/api/stream/${it.id}/hls/seg-${n}.m4s?${q}`)).data;   // startar mitt i filen
  const init = (await req(`/api/stream/${it.id}/hls/init.mp4?${q}`)).data;
  assert.ok(init.length > 500 && seg.length > 1000);
  const f = path.join(ROOT, 'hevc.mp4'); fs.writeFileSync(f, Buffer.concat([init, seg]));
  const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_tag_string,start_time', '-of', 'csv=p=0', f]).toString();
  assert.match(info, /hevc,hvc1/); assert.match(info, /eac3/);
  const vstart = +info.split('\n').find(l => l.startsWith('hevc')).split(',')[2];
  assert.ok(Math.abs(vstart - expected) < 0.4, `start ${vstart} ≠ ${expected}`);
});
