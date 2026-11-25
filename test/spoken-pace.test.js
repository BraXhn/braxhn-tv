// Ljudböcker i webbläsaren utanför hemmet (ärende #2): ljudelementet får boken i åtta gånger filens takt efter en kort
// start, så att sidor och omslag inte väntar bakom ljudet i hemmets uppladdning (och reläets tunnel). Filens huvud går
// alltid fritt, varje förfrågan (start, hopp) börjar snabbt, och hemma, offline-nedladdning och appar går i full fart.
// Mätt via reläet med 10 Mbit/s uppladdning: en boksida som öppnas direkt efter att man bytt bok tog 1,8–3,4 s, nu 0,1–1,7 s.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { freePort } from './helpers/port.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-spokenpace-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const pace = await import('../server/pace.js');
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const REMOTE = { 'x-forwarded-for': '81.2.3.4' };
const AUDIO = { 'sec-fetch-dest': 'audio' };
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let srv, tok = '';
const S = {};
const BOOK = path.join(MEDIA, 'Böcker', 'Tove Testare', 'Lång bok');

before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(BOOK, { recursive: true });
  // Omslag i ID3 (som de flesta MP3-böcker) och tio minuter brus i 64 kbit/s ≈ 4,8 MB
  ff('-f', 'lavfi', '-i', 'mandelbrot=s=600x600', '-frames:v', '1', '-q:v', '2', path.join(ROOT, 'omslag.jpg'));
  ff('-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=44100:a=0.05:d=600:seed=3', '-i', path.join(ROOT, 'omslag.jpg'), '-map', '0', '-map', '1', '-ac', '1',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-c:v', 'copy', '-id3v2_version', '3', '-metadata', 'title=Del 1', '-metadata', 'album=Lång bok',
    '-metadata', 'artist=Tove Testare', path.join(BOOK, '01.mp3'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

async function api(p, { method = 'GET', body } = {}) {
  const h = { authorization: 'Bearer ' + tok };
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
/** Läser strömmen i högst ms millisekunder: { bytes, done, ms } */
async function readFor(url, headers, ms) {
  const ctl = new AbortController();
  const t0 = Date.now();
  const r = await fetch(B + url, { headers: { authorization: 'Bearer ' + tok, ...headers }, signal: ctl.signal });
  assert.ok(r.status === 200 || r.status === 206, `strömmen svarar (${r.status})`);
  const rd = r.body.getReader();
  let bytes = 0, done = false;
  const timer = setTimeout(() => ctl.abort(), ms);
  try { for (;;) { const x = await rd.read(); if (x.done) { done = true; break; } bytes += x.value.length; } } catch {}
  clearTimeout(timer);
  return { bytes, done, ms: Date.now() - t0 };
}

t('förberedelse: ljudboken skannas', async () => {
  assert.equal((await fetch(B + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) })).status, 200);
  tok = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW, app: true }) })).json()).token;
  const lib = (await api('/api/libraries', { method: 'POST', body: { name: 'Böcker', type: 'audiobook', path: path.join(MEDIA, 'Böcker') } })).data.id;
  for (let i = 0; i < 120 && !S.book; i++) {
    await sleep(500);
    S.book = (await api('/api/audiobooks/' + lib)).data?.books?.[0];
  }
  assert.ok(S.book, 'boken finns');
  const b = (await api('/api/audiobooks/book/' + S.book.id)).data;
  S.url = `/api/audiobooks/files/${b.files[0].id}/stream?a=mp3,aac`;
  S.size = fs.statSync(path.join(BOOK, '01.mp3')).size;
  S.head = await pace.headerRange(path.join(BOOK, '01.mp3'));
  assert.ok(S.size > 4e6, `filen är stor nog för provet (${S.size} byte)`);
});

t('utanför hemmet: ljudelementet får start och huvud direkt, sedan filens takt – inte hela filen på en gång', async () => {
  const r = await readFor(S.url, { ...REMOTE, ...AUDIO, range: 'bytes=0-' }, 1500);
  // Huvudet (ID3 med omslag) och starten (minst 2 MB) kommer direkt …
  assert.ok(r.bytes >= S.head[1] + 1.5e6, `starten kommer direkt (${r.bytes} byte på ${r.ms} ms)`);
  // … men resten bara i åtta gånger filens takt (64 kbit/s × 8 ≈ 64 kB/s): före rättningen kom hela filen på några ms
  assert.ok(!r.done && r.bytes < S.size * 0.75, `hela filen skickas inte på en gång (${r.bytes} av ${S.size} byte på ${r.ms} ms)`);
});

t('utanför hemmet: ett hopp i filen (ny förfrågan) börjar också snabbt', async () => {
  const from = Math.floor(S.size / 2);
  const r = await readFor(S.url, { ...REMOTE, ...AUDIO, range: `bytes=${from}-` }, 1500);
  assert.ok(r.bytes >= 1.5e6, `hoppet får sin start direkt (${r.bytes} byte)`);
  assert.ok(!r.done, 'men inte resten av filen på en gång');
});

t('hemma, offline-nedladdning utanför hemmet och appar: hela filen i full fart som förut', async () => {
  for (const [what, headers] of [['hemma (ljudelement)', { ...AUDIO, range: 'bytes=0-' }], ['nedladdning utanför hemmet', { ...REMOTE }],
    ['app utanför hemmet (utan Sec-Fetch-Dest)', { ...REMOTE, range: 'bytes=0-' }]]) {
    const r = await readFor(S.url, headers, 20000);
    assert.ok(r.done && r.bytes === S.size, `${what}: hela filen (${r.bytes} av ${S.size} byte på ${r.ms} ms)`);
  }
});

t('filens huvud: MP4:s moov först eller sist, MP3:s ID3-tagg', async () => {
  const dir = path.join(ROOT, 'huvud'); fs.mkdirSync(dir, { recursive: true });
  const src = ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=20', '-c:a', 'aac', '-b:a', '32k'];
  ff(...src, '-movflags', '+faststart', '-f', 'mp4', path.join(dir, 'först.m4b'));
  ff(...src, '-f', 'mp4', path.join(dir, 'sist.m4b'));
  const first = await pace.headerRange(path.join(dir, 'först.m4b')), last = await pace.headerRange(path.join(dir, 'sist.m4b'));
  const size = fs.statSync(path.join(dir, 'sist.m4b')).size;
  assert.ok(first && first[0] < 64 && first[1] > first[0], `moov först: ${first}`);
  assert.ok(last && last[1] === size && last[0] > size / 2, `moov sist: ${last} (${size})`);
  assert.deepEqual(S.head ? [S.head[0], S.head[1] > 30000] : null, [0, true], 'ID3 med omslag');
  assert.equal(await pace.headerRange(path.join(ROOT, 'omslag.jpg')), null, 'annat än MP3/MP4 har inget huvud');
  // Takten: åtta gånger bithastigheten, men aldrig långsammare än ~0,4 Mbit/s; starten minst 2 MB
  const p = pace.audioPaceFor({ size: 4.8e6, duration: 600 });
  assert.equal(p.rate, 8 * 8000); assert.equal(p.burst, 2 * 1048576);
  assert.equal(pace.audioPaceFor({ size: 1e6, duration: 600 }).rate, 48 * 1024);
});
