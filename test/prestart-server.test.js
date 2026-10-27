// Snabbstart mot en riktig server: startcachen fylls via administrationen, HLS-remux från början läser ur
// cachen (ffmpeg får en sammansatt ström) och ger samma bilder som originalfilen, direktuppspelning med Range
// ger exakt filens byte, och administrationens inställningar kontrolleras. Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-pres-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config'), SSD = path.join(ROOT, 'ssd');
const PORT = 19000 + Math.floor(Math.random() * 900);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, cookie = '';
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function req(p, { method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc) && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(path.join(MEDIA, 'Filmer'), { recursive: true });
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '3000k', '-x264-params', 'keyint=48:min-keyint=12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(MEDIA, 'Filmer', 'Snabb Film (2020).mkv'));
  ff('-i', path.join(MEDIA, 'Filmer', 'Snabb Film (2020).mkv'), '-c', 'copy', '-movflags', '+faststart', path.join(MEDIA, 'Filmer', 'Direkt Film (2021).mp4'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), PRESTART_DIR: SSD, PRESTART_SECONDS: '10' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } })).status, 200);
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).status, 200);
  for (let i = 0; i < 120; i++) { await sleep(500); const r = await req('/api/scan'); if (!r.data.running && !r.data.analysis?.running && r.data.last) break; }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const items = async () => (await req('/api/libraries/1/items')).data.items;

t('administrationen: läge, storlek och Fyll nu', async () => {
  let I = (await req('/api/ops/prestart')).data;
  assert.equal(I.active, true);
  assert.equal(I.dir, SSD);
  assert.equal((await req('/api/ops/prestart', { method: 'PUT', body: { maxGb: 0 } })).status, 400);
  assert.equal((await req('/api/ops/prestart', { method: 'PUT', body: { maxGb: 5 } })).data.maxGb, 5);
  assert.equal((await req('/api/ops/prestart', { method: 'PUT', body: { on: false } })).data.active, false);
  assert.equal((await req('/api/ops/prestart', { method: 'PUT', body: { on: true } })).data.active, true);
  await req('/api/ops/prestart/fill', { method: 'POST' });
  for (let i = 0; i < 60 && ((I = (await req('/api/ops/prestart')).data).running || I.entries < 2); i++) await sleep(250);
  assert.equal(I.entries, 2, 'båda nya filmerna cachade');
  assert.ok(I.used > 0);
  // Väckning: titel som profilen får se; okänd titel = 404
  const it = (await items())[0];
  assert.equal((await req(`/api/items/${it.id}/wake`, { method: 'POST' })).status, 200);
  assert.equal((await req('/api/items/99999/wake', { method: 'POST' })).status, 404);
});

t('HLS-remux från början läser ur startcachen och ger samma bilder som originalfilen', async () => {
  const it = (await items()).find(i => i.title === 'Snabb Film');
  const before = (await req('/api/ops/prestart')).data;
  const pb = (await req(`/api/items/${it.id}/playback`)).data;
  assert.equal(pb.mode, 'remux', pb.reasons?.join(', '));
  const idx = pb.url.replace('master.m3u8', 'index.m3u8');
  const pl = (await req(idx)).data.toString();
  const n = [...pl.matchAll(/#EXTINF/g)].length;
  assert.ok(n > 3);
  const segs = [];
  for (let k = 0; k < n; k++) {
    const r = await req(idx.replace('index.m3u8', `seg-${k}.ts`));
    assert.equal(r.status, 200, `segment ${k}`);
    const f = path.join(ROOT, `p${k}.ts`); fs.writeFileSync(f, r.data); segs.push(f);
  }
  const after = (await req('/api/ops/prestart')).data;
  assert.ok(after.hits > before.hits, 'uppspelningen räknades som träff');
  assert.ok(after.served > before.served, 'ffmpeg läste ur cachen');
  const frames = (args) => execFileSync('ffmpeg', ['-v', 'error', ...args, '-map', '0:v', '-f', 'framemd5', '-'], { maxBuffer: 64 << 20 })
    .toString().split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').at(-1).trim());
  const ref = frames(['-i', path.join(MEDIA, 'Filmer', 'Snabb Film (2020).mkv')]);
  const got = frames(['-i', 'concat:' + segs.join('|')]);
  assert.equal(got.length, ref.length, 'alla bilder kom med');
  assert.deepEqual(got, ref);
});

t('direktuppspelning med Range: exakt filens byte, även över cachens skarv', async () => {
  const it = (await items()).find(i => i.title === 'Direkt Film');
  const file = fs.readFileSync(path.join(MEDIA, 'Filmer', 'Direkt Film (2021).mp4'));
  const meta = JSON.parse(fs.readFileSync(path.join(SSD, it.id + '.json'), 'utf8'));
  const seam = meta.parts[0].to + 1;
  const r = await req(`/api/stream/${it.id}/direct`, { headers: { range: 'bytes=0-' } });
  assert.equal(r.status, 206);
  assert.ok(r.data.equals(file));
  const x = await req(`/api/stream/${it.id}/direct`, { headers: { range: `bytes=${seam - 10}-${seam + 10}` } });
  assert.equal(x.headers.get('content-range'), `bytes ${seam - 10}-${seam + 10}/${file.length}`);
  assert.ok(x.data.equals(file.subarray(seam - 10, seam + 11)));
  // Utanför cachen: vanliga vägen, samma byte
  const y = await req(`/api/stream/${it.id}/direct`, { headers: { range: `bytes=${seam + 1000}-${seam + 2000}` } });
  assert.ok(y.data.equals(file.subarray(seam + 1000, seam + 2001)));
});
