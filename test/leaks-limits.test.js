// Läckor och gränser: övergivna undertextläsningar, köplatser, stopp av en enda uppspelning,
// tak för ljudomkodning och offline-status för filer som försvunnit. Kräver ffmpeg (ljudtestet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-leak-'));
process.env.TRANSCODE_DIR = path.join(process.env.CONFIG_DIR, 'tc');
const pgs = await import('../server/pgs.js');
const st = await import('../server/stream.js');
const music = await import('../server/music.js');
const offline = await import('../server/offline.js');
const { CACHE } = await import('../server/db.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-leakm-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('PGS: övergivet jobb städas efter 30 min (filhandtag, .part-fil, minne)', () => {
  const it = { id: 4711, mtime: 1, path: path.join(dir, 'finns-inte.mkv'), duration: 100, title: 'X' };
  const j = pgs.job(it, { id: 'e3' });
  assert.equal(j.done, false);
  assert.ok(fs.existsSync(j.bin), '.part-filen skapas');
  pgs.sweep(Date.now() + 10 * 60e3);
  assert.equal(pgs._jobs.get(j.key), j, 'nyligen frågat jobb lämnas kvar');
  pgs.sweep(Date.now() + 31 * 60e3);
  assert.equal(pgs._jobs.has(j.key), false);
  assert.equal(j.done, true);
  assert.equal(fs.existsSync(j.bin), false, '.part-filen tas bort');
  assert.ok(!fs.readdirSync(path.join(CACHE, 'pgs')).some(f => f.startsWith('4711-')));
  // Nästa fråga börjar om
  const k = pgs.job(it, { id: 'e3' });
  assert.notEqual(k, j);
  k.abort();
});

test('textundertext som läses live: övergiven läsning städas, klar lämnas', () => {
  let closed = 0;
  const reader = { close: () => closed++ };
  st._slots.liveSubs.set('a', { cues: [{}], done: false, last: Date.now() - 31 * 60e3, reader });
  st._slots.liveSubs.set('b', { cues: [], done: false, last: Date.now(), reader });
  st._slots.liveSubs.set('c', { cues: [], done: true, last: 0, reader });
  st.sweepLiveSubs();
  assert.deepEqual([...st._slots.liveSubs.keys()].sort(), ['b', 'c']);
  assert.equal(closed, 1);
  st._slots.liveSubs.clear();
});

test('nyckelbildsplatser: bakgrund högst två, prioriterad plats släpper inte fram bakgrund, ingen lucka', async () => {
  const { kfAcquire, kfRelease, kf } = st._slots;
  assert.equal(kfAcquire('a', false), null);
  assert.equal(kfAcquire('b', false), null);
  let cRan = false;
  const c = kfAcquire('c', false); c.then(() => { cRan = true; });
  assert.ok(c instanceof Promise, 'tredje bakgrundsjobbet väntar');
  assert.equal(kfAcquire('p', true), null, 'Spela får en egen plats');
  assert.deepEqual(kf(), { active: 3, waiting: 1 });
  kfRelease(); // prioriterat klart – bakgrunden har fortfarande två
  await sleep(0);
  assert.equal(cRan, false, 'bakgrundsväntaren ryms inte');
  assert.deepEqual(kf(), { active: 2, waiting: 1 });
  kfRelease(); // en bakgrundsplats frigörs och lämnas över direkt
  assert.deepEqual(kf(), { active: 2, waiting: 0 });
  assert.ok(kfAcquire('d', false) instanceof Promise, 'en ny anropare tar inte platsen innan den väckta kört');
  await sleep(0);
  assert.equal(cRan, true);
  kfRelease(); kfRelease(); await sleep(0); kfRelease();
  assert.deepEqual(kf(), { active: 0, waiting: 0 });
});

test('undertextplatser: högst två samtidigt, även när nya anropare kommer medan en släpps', async () => {
  let cur = 0, max = 0;
  const gates = [];
  const job = () => st._slots.subSlot(async () => { cur++; max = Math.max(max, cur); await new Promise(r => gates.push(r)); cur--; });
  const all = [job(), job(), job()];
  await sleep(0);
  assert.equal(cur, 2);
  // Släpp en och lägg till en ny i samma ögonblick
  gates.shift()(); all.push(job());
  for (let k = 0; k < 10; k++) { await sleep(0); while (gates.length) { gates.shift()(); all.push(...(all.length < 8 ? [job()] : [])); } }
  await Promise.all(all);
  assert.equal(max, 2);
  assert.equal(cur, 0);
});

test('stopp med pid stoppar bara den uppspelningen; utan pid alla (appar)', () => {
  const S = st._slots.sessions;
  const killed = [];
  const fake = (key, pid) => S.set(key, { key, d: { pid, fmt: 'fmp4' }, proc: { kill: () => killed.push(key) } });
  fake('7-12-remux-a', 'aaaaaaaa'); fake('7-12-transcode-b', 'bbbbbbbb'); fake('8-12-remux-c', 'aaaaaaaa');
  st.stopUserSessions(12, 7, 'bbbbbbbb');
  assert.deepEqual(killed, ['7-12-transcode-b']);
  st.stopUserSessions(12, 7);
  assert.deepEqual(killed, ['7-12-transcode-b', '7-12-remux-a']);
  S.clear();
});

test('undertexter: mapplistningen cachas en kort stund (även saknad mapp)', () => {
  const d = path.join(dir, 'subs-cache'); fs.mkdirSync(d);
  const it = { id: 99, path: path.join(d, 'Film.mkv'), streams: '[]' };
  fs.writeFileSync(path.join(d, 'Film.sv.srt'), '');
  assert.equal(st.subtitlesOf(it).length, 1);
  fs.writeFileSync(path.join(d, 'Film.en.srt'), '');
  assert.equal(st.subtitlesOf(it).length, 1, 'ingen ny diskåtkomst inom 30 s');
  st.forgetSubtitles(it);
  assert.equal(st.subtitlesOf(it).length, 2);
  assert.deepEqual(st._slots.listDir(path.join(dir, 'saknas')), []);
});

test('ljudomkodning: tak per användare och totalt, spolning ersätter äldre körning', async () => {
  const src = path.join(dir, 'a.flac');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=900:r=8000', '-ac', '1', src]);
  const tr = (n) => { const f = path.join(dir, `t${n}.flac`); if (!fs.existsSync(f)) fs.copyFileSync(src, f); return { path: f, codec: 'flac', bitrate: 0 }; };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    music.streamTrack(req, res, tr(u.searchParams.get('n')), new URLSearchParams('a=mp3,aac'), +u.searchParams.get('u'));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port, open = [];
  // Läser inte svaret: ffmpeg blir stående (mottryck) som en pågående uppspelning
  const get = (n, u) => new Promise((ok, no) => {
    const rq = http.get({ port, host: '127.0.0.1', path: `/?n=${n}&u=${u}` }, (res) => { res.pause(); open.push(rq); ok(res.statusCode); });
    rq.on('error', no);
  });
  try {
    assert.equal(await get(1, 1), 200);
    assert.equal(await get(2, 1), 200);
    assert.equal(await get(3, 1), 200);
    assert.equal(await get(4, 1), 503, 'fjärde samtidiga för samma användare');
    assert.equal(music.audioTranscodes(), 3);
    assert.equal(await get(1, 1), 200, 'spolning i samma spår');
    await sleep(200);
    assert.equal(music.audioTranscodes(), 3, 'den äldre körningen av spåret stoppades');
    const old = music.AUDIO_LIMITS.total;
    music.AUDIO_LIMITS.total = 4;
    try {
      assert.equal(await get(5, 2), 200);
      assert.equal(await get(6, 3), 503, 'totala taket');
    } finally { music.AUDIO_LIMITS.total = old; }
  } finally {
    for (const rq of open) rq.destroy();
    for (let k = 0; k < 50 && music.audioTranscodes(); k++) await sleep(100);
    srv.close();
  }
  assert.equal(music.audioTranscodes(), 0);
});

test('offline: borttagen originalfil ger status missing, städningen kastar aldrig', () => {
  const it = { id: 5, mtime: 1, path: path.join(dir, 'borta.mp4'), streams: JSON.stringify([{ type: 'video', codec: 'h264', pix: 'yuv420p' }, { type: 'audio', codec: 'aac' }]) };
  assert.equal(offline.status(it, 'orig').status, 'missing');
  assert.equal(offline.start(it, '720').status, 'missing');
  const od = path.join(CACHE, 'offline');
  fs.rmSync(od, { recursive: true, force: true });
  assert.doesNotThrow(() => offline.cleanup());
  fs.mkdirSync(od, { recursive: true });
});
