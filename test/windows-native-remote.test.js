// Ärende #4: Windows-appens inbyggda spelare (mpv) utanför hemmet (via den publika adressen) med kvalitet Auto.
// En 1080p-film i H.264/E-AC3 i MKV med hög bithastighet ska spelas orörd i mpv när den uppmätta uppkopplingen
// räcker eller inte hann mätas – mpv buffrar själv (buf=1) och behöver inte webbspelarens marginaler eller kvalitetstakets bithastighet.
// Webbspelaren (utan buf=1) beter sig som förut. Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { freePort } from './helpers/port.js';
import { NATIVE_CAPS, nativeQuery } from '../web/js/player/nativeplan.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-natrem-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, cookie = '';

async function req(p, { method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc) && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
  if (!hasFfmpeg) return;
  const dir = path.join(MEDIA, 'Filmer', 'Mentalist (2013)');
  fs.mkdirSync(dir, { recursive: true });
  // 1080p med brus: omkring 14 Mbit/s – mer än kvalitetstakets 1080p (8 Mbit/s × 1,3) utanför hemmet
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24,noise=alls=30:allf=t',
    '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-b:v', '14M', '-minrate', '14M', '-maxrate', '14M', '-bufsize', '4M', '-g', '48', '-ac', '6', '-c:a', 'eac3', '-b:a', '384k',
    path.join(dir, 'Mentalist (2013).mkv')]);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1) },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('utanför hemmet med Auto: mpv får originalfilen när uppkopplingen räcker, webbspelaren som förut', { skip: !hasFfmpeg && 'ffmpeg saknas' }, async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } })).status, 200);
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).status, 200);
  let film;
  for (let i = 0; i < 120 && !film; i++) {
    await sleep(500);
    const libs = (await req('/api/libraries')).data;
    const l = libs.find(x => x.type === 'movie');
    const it = l && (await req(`/api/libraries/${l.id}/items`)).data.items?.[0];
    const scan = (await req('/api/scan')).data;
    if (it && !scan.running && !scan.analysis?.running) film = (await req(`/api/items/${it.id}`)).data;
  }
  assert.ok(film, 'filmen skannades');
  const kbps = film.size * 8 / film.duration / 1000;
  assert.ok(kbps > 10400, `filen är över takets bithastighet (${Math.round(kbps)} kbit/s)`);

  const R = { headers: { 'x-forwarded-for': '81.2.3.4' } };
  const pb = async (q) => (await req(`/api/items/${film.id}/playback?${q}`, R)).data;
  const mpv = (bw) => pb(nativeQuery({ q: 'auto', bw }));
  assert.equal(NATIVE_CAPS.buf, '1', 'mpv säger att den buffrar själv');

  // Snabb uppkoppling (50 Mbit/s) och lagom (≈ 1,1 × filen): originalfilen
  const fast = await mpv(50000);
  assert.equal(fast.remote, true);
  assert.equal(fast.mode, 'direct', `snabb uppkoppling: ${fast.mode} (${(fast.reasons || []).join(', ')})`);
  assert.equal((await mpv(Math.ceil(kbps * 1.1 + 200))).mode, 'direct', 'uppkopplingen räcker precis');
  // För långsam för filen: servern kodar om (då spelar webbspelaren)
  assert.equal((await mpv(Math.floor(kbps * 0.9))).mode, 'transcode', 'för långsam');
  // Ingen mätning (provet hann inte klart): mpv buffrar, så uppkopplingen antas räcka
  assert.equal((await mpv(0)).mode, 'direct', 'utan mätning');
  // Upplösningstaket gäller fortfarande: kontots tak 720p utanför hemmet → omkodning
  assert.equal((await req('/api/me/playback-prefs', { method: 'PUT', body: { qualityRemote: '720' } })).data.qualityRemote, '720');
  assert.equal((await mpv(50000)).mode, 'transcode', 'kontots tak 720p utanför hemmet');
  assert.equal((await req('/api/me/playback-prefs', { method: 'PUT', body: { qualityRemote: 'auto' } })).data.qualityRemote, 'auto');

  // Webbspelaren och andra appar (utan buf=1): som förut – taket och marginalerna gäller, även utan mätning
  const web = new URLSearchParams(NATIVE_CAPS); web.delete('buf'); web.set('bw', '50000');
  assert.equal((await pb(web.toString())).mode, 'transcode', 'utan buf=1 ändras ingenting');
  web.delete('bw');
  assert.equal((await pb(web.toString())).mode, 'transcode', 'utan buf=1 och utan mätning: som förut');
});
