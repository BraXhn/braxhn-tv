// Jämn strömning trots bakgrundsjobb: händelseslingan hålls låg medan segment levereras (skanning av ett stort
// bibliotek, nyckelbilder, miniatyrer, repliksökning, hälsokontroll pågår), omkodningen är snabbare än realtid och
// ligger före spelaren, hls.js-inställningarna (buffertar, glapp, bandbredd från första byte) och orsaken vid hack.
// Mätningarna med riktiga filmer (1080p/4K/HEVC HDR/DTS/TrueHD/DVD) gjordes med ett separat mätskript – se BRAIN.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { HLS_VOD, hlsConfig, abrClass, holdEmergency, fromFirstByte, TTFB_CAP } from '../web/js/player/hlsconfig.js';
import { stallCause } from '../server/stalls.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-smooth-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 19000 + Math.floor(Math.random() * 900);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const BIG = +(process.env.SMOOTH_BIG || 600); // filmer i störbiblioteket
let srv, cookie = '';
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function req(p, { method = 'GET', body } = {}) {
  const h = {};
  if (cookie) h.cookie = cookie;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc) && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const t = (name, opts, fn) => fn ? test(name, { ...opts, skip: !hasFfmpeg && 'ffmpeg saknas' }, fn) : test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, opts);

// ---------- hls.js-inställningarna ----------
test('hls.js: buffert bakåt begränsad, en minut framåt, glapp upp till 0,5 s och tålamod med omkodningen', () => {
  const c = hlsConfig({ start: 12, est: 5e6 });
  assert.ok(Number.isFinite(c.backBufferLength) && c.backBufferLength > 0 && c.backBufferLength <= 60, 'backBufferLength får inte vara obegränsad (SourceBuffer-kvoten)');
  assert.ok(c.maxBufferLength >= 40 && c.maxBufferLength <= 90);
  assert.ok(c.maxBufferHole >= 0.3, 'TS-remux kan börja 0,08–0,2 s efter 0');
  assert.ok(c.nudgeMaxRetry >= 5);
  assert.equal(c.startPosition, 12);
  assert.equal(c.abrEwmaDefaultEstimate, 5e6);
  assert.ok(c.fragLoadPolicy.default.maxTimeToFirstByteMs >= 30000, 'servern väntar upp till 90 s på ett segment');
  assert.ok(c.capLevelToPlayerSize);
  assert.equal(c.slowPolicy, undefined);
  assert.ok(Object.isFrozen(HLS_VOD));
});

test('hls.js ABR: bandbredd från första byte, svarstiden kapas, inget nödbyte före första byte', () => {
  assert.equal(holdEmergency({ loading: { start: 100, first: 0 } }), true);
  assert.equal(holdEmergency({ loading: { start: 100, first: 900 } }), false);
  assert.equal(holdEmergency({ aborted: true, loading: { start: 1, first: 0 } }), false);
  assert.equal(fromFirstByte({ loading: { start: 100, first: 4100, end: 4300 } }), 4100);
  assert.equal(fromFirstByte({ loading: { start: 100, first: 0 } }), null);
  // Med en påhittad standardkontroll: vad ser hls.js när ett omkodat segment väntat 4 s på servern?
  const seen = [];
  class Base {
    constructor() { this._abandonRulesCheck = () => seen.push('abandon'); this.bwEstimator = this.initEstimator(); }
    initEstimator() { return { ttfb: [], sampleTTFB(ms) { this.ttfb.push(ms); } }; }
    onFragBuffered(e, d) { const s = d.frag.stats; seen.push(s.loading.end - s.loading.start); }
  }
  const Abr = abrClass({ DefaultConfig: { abrController: Base } });
  const a = new Abr({});
  const stats = { loading: { start: 0, first: 4000, end: 4250 }, loaded: 3e6 };
  a.onFragBuffered('x', { frag: { stats } });
  assert.deepEqual(seen, [250], 'överföringen räknas från första byte');
  assert.equal(stats.loading.start, 0, 'stats återställs');
  a.bwEstimator.sampleTTFB(4000);
  assert.deepEqual(a.bwEstimator.ttfb, [TTFB_CAP]);
  a.fragCurrent = { stats: { loading: { start: 0, first: 0 } } };
  a._abandonRulesCheck();
  assert.deepEqual(seen, [250], 'inget nödbyte medan servern förbereder segmentet');
  a.fragCurrent = { stats: { loading: { start: 0, first: 10 } } };
  a._abandonRulesCheck();
  assert.deepEqual(seen, [250, 'abandon'], 'när data väl kommer gäller hls.js vanliga regel');
  assert.equal(abrClass({}), null, 'annan hls.js utan standardkontroll: ingen egen');
});

test('hls.js i Chromium: den riktiga biblioteksversionen tar emot inställningarna och den egna ABR-kontrollen', { skip: !chromium && 'Playwright saknas' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><video></video>');
    await page.addScriptTag({ content: fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'vendor', 'hls.min.js'), 'utf8') });
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'js', 'player', 'hlsconfig.js'), 'utf8').replace(/export /g, '');
    const r = await page.evaluate((code) => {
      const m = new Function(`${code}; return { hlsConfig, abrClass };`)();
      const Hls = window.Hls;
      const hls = new Hls(m.hlsConfig({ start: 5, Abr: m.abrClass(Hls) }));
      hls.attachMedia(document.querySelector('video'));
      const ac = hls.abrController;
      // Nödbytet ska hoppas över medan inget byte kommit
      ac.fragCurrent = { stats: { loading: { start: performance.now() - 20000, first: 0 }, aborted: false }, level: 1, duration: 6 };
      let threw = null; try { ac._abandonRulesCheck(); } catch (e) { threw = e.message; }
      const out = { name: ac.constructor.name, back: hls.config.backBufferLength, hole: hls.config.maxBufferHole, len: hls.config.maxBufferLength,
        ttfbFn: typeof ac.bwEstimator?.sampleTTFB, threw, version: Hls.version };
      hls.destroy();
      return out;
    }, src);
    assert.equal(r.name, 'BraxhnAbr');
    assert.equal(r.back, HLS_VOD.backBufferLength);
    assert.equal(r.hole, HLS_VOD.maxBufferHole);
    assert.equal(r.len, HLS_VOD.maxBufferLength);
    assert.equal(r.ttfbFn, 'function');
    assert.equal(r.threw, null);
  } finally { await browser.close(); }
});

// ---------- orsaken vid hack ----------
test('hack: orsaken väljs ur serverns och spelarens mätvärden', () => {
  const now = 1e6;
  assert.equal(stallCause(null, {}, { block: { ms: 420, jobs: ['scan', 'health'] } }, now).cause, 'server-busy');
  assert.match(stallCause(null, {}, { block: { ms: 420, jobs: ['scan'] } }, now).text, /420 ms \(scan\)/);
  const slowTc = { mode: 'transcode', running: true, keepingUp: false, speed: 0.8, encoder: 'libx264', lastWait: null };
  assert.equal(stallCause(slowTc, {}, {}, now).cause, 'transcode');
  assert.match(stallCause(slowTc, {}, {}, now).text, /0,8 × realtid/);
  const remuxWait = { mode: 'remux', running: true, keepingUp: true, lastWait: { n: 7, ms: 5200, at: now - 2000, dur: 6 } };
  assert.equal(stallCause(remuxWait, {}, {}, now).cause, 'disk');
  const ok = { mode: 'transcode', running: true, keepingUp: true, speed: 2.4, lastWait: null };
  assert.equal(stallCause(ok, { bw: 3e6, bitrate: 8e6 }, {}, now).cause, 'network');
  assert.equal(stallCause(ok, { lastFrag: { load: 7000, wait: 100, dur: 6 } }, {}, now).cause, 'network');
  // Bara överföringstiden känd (ingen bandbredd/bithastighet): texten säger det, utan tomma parenteser
  assert.equal(stallCause(ok, { lastFrag: { load: 7000, wait: 100, dur: 6 } }, {}, now).text, 'nätet hann inte med (segmentet på 6 s tog 6,9 s att hämta)');
  assert.equal(stallCause(ok, { bw: 3e6, bitrate: 8e6 }, {}, now).text, 'nätet hann inte med (uppmätt 3,0 Mbit/s, strömmen behöver 8,0 Mbit/s)');
  // Lång väntan på servern räknas inte som nät
  assert.equal(stallCause(ok, { lastFrag: { load: 7000, wait: 6900, dur: 6 } }, {}, now).cause, 'client');
  assert.equal(stallCause(ok, { bw: 80e6, bitrate: 8e6, dropped: 40 }, { block: { ms: 60 } }, now).cause, 'client');
  assert.match(stallCause(ok, { dropped: 40 }, {}, now).text, /40 tappade bildrutor/);
});

// ---------- bakgrundsjobb och mappbevakning ----------
test('bakgrundsjobb: väntar medan någon tittar, annars bara ett varv i händelseslingan', async () => {
  const jobs = await import('../server/jobs.js');
  let watching = true;
  jobs.setWatching(() => watching);
  try {
    const t0 = Date.now();
    assert.equal(await jobs.yieldToPlayback({ gap: 30 }), true);
    assert.ok(Date.now() - t0 >= 25, 'kort paus mellan stegen medan någon tittar');
    let done = false;
    const p = jobs.yieldToPlayback({ pause: true }).then(() => { done = true; });
    await sleep(300);
    assert.equal(done, false, 'pausat jobb väntar');
    watching = false;
    await p;
    assert.equal(done, true);
    assert.equal(await jobs.yieldToPlayback({ pause: true }), false);
  } finally { jobs.setWatching(() => false); }
});

test('mappbevakningen: stort träd blockerar inte händelseslingan, nya mappar och filer syns', async () => {
  const { watchTree } = await import('../server/activity.js');
  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  const root = path.join(ROOT, 'tree');
  for (let i = 0; i < 1500; i++) fs.mkdirSync(path.join(root, `Film ${i} (2000)`, 'Extras'), { recursive: true });
  const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
  const ev = [];
  const w = watchTree(root, (e, f) => ev.push(f));
  try {
    for (let i = 0; i < 400 && w.size < 3001; i++) await sleep(10);
    h.disable();
    assert.equal(w.size, 3001, 'alla mappar bevakas');
    assert.ok(h.max / 1e6 < 60, `händelseslingan stod still ${(h.max / 1e6).toFixed(0)} ms (fs.watch recursive: ~800 ms)`);
    fs.mkdirSync(path.join(root, 'Ny film (2024)'));
    await sleep(300);
    fs.writeFileSync(path.join(root, 'Ny film (2024)', 'Ny film (2024).mkv'), 'x');
    fs.writeFileSync(path.join(root, 'Film 5 (2000)', 'Extras', 'trailer.mkv'), 'x');
    for (let i = 0; i < 100 && !(ev.some(f => f === path.join('Ny film (2024)', 'Ny film (2024).mkv')) && ev.some(f => f === path.join('Film 5 (2000)', 'Extras', 'trailer.mkv'))); i++) await sleep(20);
    assert.ok(ev.includes(path.join('Ny film (2024)', 'Ny film (2024).mkv')), 'fil i en ny mapp');
    assert.ok(ev.includes(path.join('Film 5 (2000)', 'Extras', 'trailer.mkv')), 'fil i en undermapp, relativt roten');
  } finally { w.close(); }
});

test('mappbevakningen: borttagen och återskapad mapp bevakas igen, omdöpt mapp ger nya namnet', async () => {
  const { watchTree } = await import('../server/activity.js');
  const root = path.join(ROOT, 'tree2');
  fs.mkdirSync(path.join(root, 'Film (2020)'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Gammal'), { recursive: true });
  const ev = [];
  const w = watchTree(root, (e, f) => ev.push(f));
  const seen = async (f) => { for (let i = 0; i < 100 && !ev.includes(f); i++) await sleep(20); return ev.includes(f); };
  try {
    for (let i = 0; i < 100 && w.size < 3; i++) await sleep(10);
    // Radarr/Sonarr: mappen tas bort och laddas ner på nytt med samma namn
    fs.rmSync(path.join(root, 'Film (2020)'), { recursive: true });
    await sleep(200);
    fs.mkdirSync(path.join(root, 'Film (2020)'));
    await sleep(300);
    fs.writeFileSync(path.join(root, 'Film (2020)', 'Film (2020).mkv'), 'x');
    assert.ok(await seen(path.join('Film (2020)', 'Film (2020).mkv')), 'fil i en återskapad mapp');
    // Omdöpt mapp: händelserna har det nya namnet, och en ny mapp med det gamla namnet bevakas
    fs.renameSync(path.join(root, 'Gammal'), path.join(root, 'Ny'));
    await sleep(300);
    ev.length = 0;
    fs.writeFileSync(path.join(root, 'Ny', 'a.mkv'), 'x');
    assert.ok(await seen(path.join('Ny', 'a.mkv')));
    await sleep(100);
    assert.ok(!ev.includes(path.join('Gammal', 'a.mkv')), 'inga händelser med det gamla namnet: ' + ev.join(', '));
    fs.mkdirSync(path.join(root, 'Gammal'));
    await sleep(300);
    fs.writeFileSync(path.join(root, 'Gammal', 'b.mkv'), 'x');
    assert.ok(await seen(path.join('Gammal', 'b.mkv')), 'ny mapp med det gamla namnet');
    assert.equal(w.size, 4, 'roten och tre mappar');
  } finally { w.close(); }
});

// ---------- riktig server under belastning ----------
before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(path.join(MEDIA, 'Filmer'), { recursive: true });
  // Film att titta på: 720p H.264 med AC-3 5.1 i MKV (omkodning till 480p och remux)
  ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24,noise=alls=8:allf=t', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000', '-t', '60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '4000k', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', path.join(MEDIA, 'Filmer', 'Jämn Film (2020).mkv'));
  // Störbiblioteket: många filmer (hårda länkar till ett kort klipp) med undertexter – skanning, analys, repliksökning, hälsokontroll
  const clip = path.join(ROOT, 'clip.mkv');
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=f=200', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-c:a', 'aac', clip);
  let srt = '';
  for (let i = 0; i < 600; i++) srt += `${i + 1}\n00:${String(Math.floor(i * 4 / 60) % 60).padStart(2, '0')}:${String(i * 4 % 60).padStart(2, '0')},000 --> 00:${String(Math.floor(i * 4 / 60) % 60).padStart(2, '0')}:${String(i * 4 % 60 + 2).padStart(2, '0')},500\ndet var en gång en katt som hette Måns och bodde vid sjön\n\n`;
  for (let i = 0; i < BIG; i++) {
    const d = path.join(MEDIA, 'Stora', `Testfilm ${i} (${1950 + i % 70})`);
    fs.mkdirSync(d, { recursive: true });
    fs.linkSync(clip, path.join(d, `Testfilm ${i} (${1950 + i % 70}).mkv`));
    fs.writeFileSync(path.join(d, `Testfilm ${i} (${1950 + i % 70}).sv.srt`), srt);
  }
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), HEALTH_START_DELAY: '1000' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } })).status, 200);
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).status, 200);
  for (let i = 0; i < 240; i++) { await sleep(500); const r = await req('/api/scan'); if (!r.data.running && !r.data.analysis?.running && r.data.last) break; }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });

/** Spelar en HLS-ström som hls.js (ett segment åt gången, buffert framåt, realtid) och samlar serverns Statistik */
async function playFor(pbUrl, seconds, { maxBuf = 30 } = {}) {
  const master = (await req(pbUrl)).data.toString();
  const vurl = new URL(master.split('\n').find(l => l && !l.startsWith('#')), B + pbUrl);
  const list = (await req(vurl.pathname + vurl.search)).data.toString();
  const segs = []; let dur = 0;
  for (const l of list.split('\n')) { if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)); else if (l && !l.startsWith('#')) segs.push({ u: new URL(l, vurl), dur }); }
  const id = /\/api\/stream\/(\d+)\//.exec(pbUrl)[1], pid = new URL(B + pbUrl).searchParams.get('pid');
  const stats = [], waits = [];
  let i = 0, buf = 0, play = 0, t0 = null, stalls = 0, full = false;
  const steady = []; // väntan på segment som begärts efter att spelarens buffert varit full (som hls.js i drift)
  const end = Date.now() + seconds * 1000;
  const poll = setInterval(async () => { try { stats.push((await req(`/api/stream/${id}/stats?pid=${pid}`)).data); } catch {} }, 1000);
  try {
    while (Date.now() < end && i < segs.length) {
      if (t0) { const p = (Date.now() - t0) / 1000; if (p > buf + 0.25 && i < segs.length) { stalls++; t0 += (p - buf) * 1000; } play = Math.min(p, buf); }
      if (buf - play < maxBuf) {
        const r = await fetch(segs[i].u, { headers: { cookie } });
        assert.equal(r.status, 200, `segment ${i}`);
        assert.ok(r.headers.get('content-length'), 'Content-Length');
        assert.equal(r.headers.get('content-encoding'), null, 'segment komprimeras inte');
        waits.push(+r.headers.get('x-seg-wait') || 0);
        if (full) steady.push(waits.at(-1));
        await r.arrayBuffer();
        buf += segs[i].dur; i++;
        if (!t0) t0 = Date.now();
      } else { full = true; await sleep(100); }
    }
  } finally { clearInterval(poll); }
  await req(`/api/stream/${id}/stop?pid=${pid}`, { method: 'POST' });
  return { stats, waits, steady, stalls, segs: i };
}

t('belastning: händelseslingan hålls låg medan segment levereras under skanning, analys, repliksökning och hälsokontroll', { timeout: 300000 }, async () => {
  const it = (await req('/api/libraries/1/items')).data.items[0];
  const med = (r) => { const v = r.stats.map(s => s.loop.p99).filter(Number.isFinite).sort((a, b) => a - b); return { med: v[Math.floor(v.length / 2)], worst: v[v.length - 1] }; };
  // Jämförelse utan bakgrundsjobb på samma maskin (en upptagen testmaskin har högre grundnivå)
  const pq = (await req(`/api/items/${it.id}/playback?c=mp4&v=h264&a=aac&hdr=0&q=480`)).data;
  const quiet = med(await playFor(pq.url, 8));
  // Störningarna startar: ett stort bibliotek läggs till (skanning, nyckelbilder, miniatyrer, kapitel, förhandsbilder,
  // sedan repliksökning och hälsokontroll), och hälsokontrollen körs om var 10:e sekund
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Stora', type: 'movie', path: path.join(MEDIA, 'Stora') } })).status, 200);
  const kick = setInterval(() => { req('/api/admin/health/run', { method: 'POST' }).catch(() => {}); }, 10000);
  await sleep(1500);
  let pb;
  try {
    pb = (await req(`/api/items/${it.id}/playback?c=mp4&v=h264&a=aac&hdr=0&q=480`)).data;
    assert.equal(pb.mode, 'transcode');
    const r = await playFor(pb.url, 40);
    const { med: m, worst } = med(r);
    console.log(`  händelseslingan p99 per sekund: median ${m} ms, sämsta ${worst} ms (utan bakgrundsjobb ${quiet.med} ms); väntan på segment ${Math.max(...r.waits)} ms, hack ${r.stalls}`);
    assert.ok(r.stats.length >= 20);
    assert.ok(r.stats.some(s => s.jobs.length), 'bakgrundsjobben pågick under mätningen');
    // < 50 ms (förut 96–144 ms med samma slags störningar); på en överbelastad testmaskin högst 20 ms över grundnivån
    assert.ok(m < Math.max(50, quiet.med + 20), `p99 median ${m} ms (< 50 ms, utan bakgrundsjobb ${quiet.med} ms)`);
    assert.ok(worst < Math.max(150, quiet.worst + 60), `sämsta sekunden ${worst} ms`);
    assert.ok(r.stats.every(s => s.watching), 'servern ser att någon tittar');
    assert.equal(r.stalls, 0, 'inga hack i den simulerade spelaren');
  } finally { clearInterval(kick); }
});

t('omkodning: snabbare än realtid och före spelaren, Statistik visar hastighet och försprång', { timeout: 120000 }, async () => {
  const it = (await req('/api/libraries/1/items')).data.items.find(x => x.title.startsWith('Jämn'));
  const pb = (await req(`/api/items/${it.id}/playback?c=mp4&v=h264&a=aac&hdr=0&q=480&start=20`)).data;
  const r = await playFor(pb.url, 28, { maxBuf: 12 });
  const last = r.stats.filter(s => s.session).at(-1)?.session;
  assert.ok(last, 'sessionen syns i Statistik');
  assert.equal(last.mode, 'transcode');
  assert.ok(last.speed > 1, `omkodningen ${last.speed} × realtid`);
  assert.ok(last.keepingUp, 'servern hinner med');
  assert.ok(last.ahead >= 12 || last.throttled || last.done, `försprång ${last.ahead} s`);
  assert.equal(r.stalls, 0);
  // När spelarens buffert väl är full är nästa segment redan klart när det behövs (omkodningen ligger före)
  assert.ok(r.steady.length >= 2, 'spelaren hann fylla bufferten');
  assert.ok(r.steady.every(w => w < 300), `väntan på segment i drift: ${r.steady.join(', ')} ms`);
});

t('hack: spelarens rapport loggas med orsak och syns i aktiviteten', async () => {
  const it = (await req('/api/libraries/1/items')).data.items.find(x => x.title.startsWith('Jämn'));
  const pb = (await req(`/api/items/${it.id}/playback?c=mp4&v=h264&a=aac&hdr=0&q=480`)).data;
  const id = /\/api\/stream\/(\d+)\//.exec(pb.url)[1], pid = new URL(B + pb.url).searchParams.get('pid');
  const r = await req(`/api/stream/${id}/stall?pid=${pid}`, { method: 'POST', body: { position: 12.5, bw: 2e6, bitrate: 1.6e6 * 2, buffer: 0, dropped: 0 } });
  assert.equal(r.status, 200);
  assert.ok(['network', 'transcode', 'server-busy', 'client', 'disk'].includes(r.data.cause), r.data.cause);
  const again = await req(`/api/stream/${id}/stall?pid=${pid}`, { method: 'POST', body: { position: 13 } });
  assert.equal(again.data.skipped, true, 'högst en rapport per 5 s');
  const s = (await req('/api/activity')).data.find(x => x.itemId === it.id);
  assert.ok(s, 'uppspelningen syns i aktiviteten');
  assert.equal(s.stalls, 1);
  assert.equal(s.stallCause, r.data.cause);
  assert.equal((await req(`/api/stream/${id}/stall`, { method: 'POST', body: 'x' })).status, 200);
  await req(`/api/stream/${id}/stop?pid=${pid}`, { method: 'POST' });
});
