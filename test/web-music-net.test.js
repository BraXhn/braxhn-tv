// Musik på långsamt nät i riktig Chrome (Playwright, nätet strypt med CDP): tid från klick till ljud och tystnader
// under de första sekunderna, för M4A med `moov` sist och FLAC i 96 kHz/24 bit – hemma och utanför hemmet.
// Ljudet spelas in efter begränsaren (som i web-audio-robust.test.js); vänster kanal är en obruten sinus, så varje
// tystnad i inspelningen är ett hack. MEASURE=1 skriver ut siffrorna. Hoppas över om ffmpeg eller Playwright saknas.
// Riktiga högtalare, Safari och riktigt mobilnät provas inte.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './helpers/port.js';
import { clearMusicQueue } from './helpers/musicqueue.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const skip = !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-musicnet-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const LEN = 60; // sekunder per låt
let srv, browser, tok = '', cookie = '';
const S = {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
async function req(p, { method = 'GET', body } = {}) {
  const h = { authorization: 'Bearer ' + tok };
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
}
/** Två låtar: sinus i vänster kanal, brus i höger (verklig filstorlek). enc = kodarens argument, ext = filändelse, pic = omslag i filen. */
function album(name, freq, sr, enc, ext, pic) {
  const dir = path.join(MEDIA, 'Musik', 'Nätet', name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 2; i++) {
    ff('-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*${freq}*t):s=${sr}:d=${LEN}`, '-f', 'lavfi', '-i', `anoisesrc=c=pink:r=${sr}:a=0.25:d=${LEN}:seed=${i + 3}`,
      ...(pic ? ['-i', pic] : []), '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo[a]', '-map', '[a]',
      ...(pic ? ['-map', '2', '-c:v', 'copy', '-disposition:v', 'attached_pic'] : []), ...enc,
      '-metadata', `title=${name} ${i + 1}`, '-metadata', 'artist=Nätet', '-metadata', `album=${name}`, '-metadata', `track=${i + 1}`, path.join(dir, `0${i + 1} ${name} ${i + 1}.${ext}`));
  }
}
/** Toppnivåns lådor i en MP4-fil (namn i ordning) */
function topBoxes(buf) {
  const out = []; let o = 0;
  while (o + 8 <= buf.length) { let n = buf.readUInt32BE(o); const ty = buf.toString('latin1', o + 4, o + 8); if (n === 1) n = Number(buf.readBigUInt64BE(o + 8)); out.push(ty); if (n < 8) break; o += n; }
  return out;
}

before(async () => {
  if (skip) return;
  // AAC 256 kbit/s i M4A som ffmpeg (och många rippare) skriver den: moov sist, efter ljudet, med ett omslag på
  // 260 kB i filen (som från iTunes) – moov är då stor och måste hämtas innan något kan spelas
  const pic = path.join(ROOT, 'omslag.jpg');
  ff('-f', 'lavfi', '-i', 'nullsrc=s=600x600,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '2', pic);
  album('Moovsist', 500, 44100, ['-c:a', 'aac', '-b:a', '256k'], 'm4a', pic);
  // FLAC 96 kHz/24 bit (≈ 2,5 Mbit/s)
  album('Hires', 500, 96000, ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'], 'flac');
  // Tre korta låtar ur en obruten sinus (96 kHz/24 bit), delade på exakta sampel: övergångarna ska höras som en ton
  const dir = path.join(MEDIA, 'Musik', 'Nätet', 'Skarvar'), wav = path.join(ROOT, 'skarvar.wav');
  fs.mkdirSync(dir, { recursive: true });
  ff('-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*500*t):s=96000:d=12', '-ac', '2', '-c:a', 'pcm_s32le', wav);
  for (let i = 0; i < 3; i++) ff('-i', wav, '-af', `atrim=start_sample=${i * 4 * 96000}:end_sample=${(i + 1) * 4 * 96000},asetpts=N/SR/TB`, '-c:a', 'flac', '-sample_fmt', 's32',
    '-bits_per_raw_sample', '24', '-metadata', `title=Skarvar ${i + 1}`, '-metadata', 'artist=Nätet', '-metadata', 'album=Skarvar', '-metadata', `track=${i + 1}`, path.join(dir, `0${i + 1} Skarvar ${i + 1}.flac`));
  fs.rmSync(wav);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '',
      WATCH_FILES: '0', MUSIC_SONIC: '0', MUSIC_LOUDNESS: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  const exe = fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : {};
  browser = await chromium.launch(exe);
});
after(async () => { await browser?.close(); srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip }, fn);

// Inspelning efter begränsaren: varje bit får ljudsammanhangets tid, så att ljudet kan jämföras med klicket
function tapScript() {
  window.__rec = { chunks: [], on: false };
  window.__bxAudioTap = async (ctx, node) => {
    const code = `class Rec extends AudioWorkletProcessor {
      process(inp) { const c = inp[0] && inp[0][0]; if (c) this.port.postMessage([currentTime, c.slice()]); return true; } }
      registerProcessor('rec', Rec);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const w = new AudioWorkletNode(ctx, 'rec');
    w.port.onmessage = (e) => { if (window.__rec.on) window.__rec.chunks.push(e.data); };
    node.connect(w); w.connect(ctx.destination);
    window.__rec.ctx = ctx; window.__rec.on = true;
  };
}
async function newPage() {
  await clearMusicQueue(req);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true });
  await ctx.addCookies([{ name: 'kt', value: cookie, url: B }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(tapScript);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const streams = [];
  cdp.on('Network.requestWillBeSent', e => { if (/\/stream\?/.test(e.request.url) && e.request.method === 'GET') streams.push(e.request.url); });
  const net = (o) => cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, ...o });
  return { page, errors, net, streams, close: () => ctx.close() };
}
/**
 * Spelar albumets första låt och mäter: start = sekunder från klick till ljud, silence = summan av tystnader (≥ 5 ms)
 * efter starten fram till `window` sekunder efter klicket, gaps = antal sådana tystnader.
 */
async function measure(P, albumId, { kbps = 0, latency = 0, remote = false, secs = 40, setup = null, click = null } = {}) {
  const { page } = P;
  await page.goto(B + '/#/album/' + albumId);
  await page.waitForSelector('tr[data-ti="0"]');
  await page.evaluate(async (remote) => {
    window.__ae = await import('/m/js/audioengine.js'); window.__au = await import('/m/js/audio.js');
    if (remote) (await import('/m/js/core.js')).status.remote = true; // som utanför hemmet (servern säger det efter IP-adressen)
  }, remote);
  if (setup) await page.evaluate(setup);
  if (kbps) await P.net({ latency, downloadThroughput: kbps * 1000 / 8, uploadThroughput: 1e6 });
  await page.evaluate((c) => { window.__click = performance.now(); document.querySelector('tr[data-ti="0"]').click(); if (c) (0, eval)(c)(); }, click && String(click));
  await page.waitForFunction(() => window.__rec?.on, null, { timeout: 10000 });
  // Till `secs` sekunder efter klicket, eller tills albumet tagit slut (då stängs ljudsammanhanget av)
  await page.waitForFunction((w) => window.__rec.ctx.currentTime > w || (window.__rec.ctx.state === 'suspended' && window.__rec.chunks.length > 100), secs, { timeout: (secs + 30) * 1000 });
  const r = await page.evaluate((w) => {
    const { chunks, ctx } = window.__rec, sr = ctx.sampleRate;
    const ts = ctx.getOutputTimestamp();
    const perf = (ct) => ts.performanceTime + (ct - ts.contextTime) * 1000; // sammanhangets tid → performance.now()
    let start = null, run = 0, silence = 0, gaps = 0, runAt = 0, lastLoud = 0;
    const list = [];
    const MIN = Math.round(sr * 0.005);
    for (const [ct, d] of chunks) {
      for (let i = 0; i < d.length; i++) {
        const at = ct + i / sr;
        if ((perf(at) - window.__click) / 1000 > w) break;
        const loud = Math.abs(d[i]) >= 0.02;
        if (loud) lastLoud = at;
        if (start == null) { if (Math.abs(d[i]) >= 0.05) start = at; continue; }
        if (!loud) { if (!run) runAt = at; run++; }
        else { if (run >= MIN) { silence += run / sr; gaps++; list.push([+((perf(runAt) - window.__click) / 1000).toFixed(2), +(run / sr).toFixed(3)]); } run = 0; }
      }
    }
    if (run >= MIN) { silence += run / sr; gaps++; list.push([+((perf(runAt) - window.__click) / 1000).toFixed(2), +(run / sr).toFixed(3)]); }
    return { start: start == null ? null : (perf(start) - window.__click) / 1000, silence, gaps, list, engine: window.__ae.debugState().on, runAt: list.length ? list.at(-1)[0] : 0,
      lastLoud: lastLoud ? (perf(lastLoud) - window.__click) / 1000 : 0 };
  }, secs);
  return r;
}
const fmt = (r) => `start ${r.start?.toFixed(2)} s, tystnad ${r.silence.toFixed(2)} s i ${r.gaps} hack${r.gaps ? ' ' + JSON.stringify(r.list.slice(0, 6)) : ''}`;
const log = (name, r) => { if (process.env.MEASURE) console.log(`MÄTNING ${name}: ${fmt(r)}${r.extra ? ' ' + r.extra : ''}`); };

t('förberedelse: konto och musikbibliotek', async () => {
  assert.equal((await fetch(B + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) })).status, 200);
  tok = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW, app: true }) })).json()).token;
  const lr = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) });
  cookie = /kt=([0-9a-f]+)/.exec(lr.headers.get('set-cookie'))[1];
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Musik', type: 'music', path: path.join(MEDIA, 'Musik') } })).status, 200);
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const r = (await req('/api/scan')).data;
    if (!r.running && r.last && db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE gl IS NULL').get().n === 0 && db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n === 7) break;
  }
  for (const r of db.prepare('SELECT id, title FROM albums').all()) S[r.title] = r.id;
  S.track = Object.fromEntries(db.prepare('SELECT id, title FROM tracks').all().map(r => [r.title, r.id]));
  db.close();
  assert.ok(S.Moovsist && S.Hires && S.Skarvar, JSON.stringify(S));
  await req('/api/me/listening', { method: 'PUT', body: { normMode: 'off', gapless: true, crossfade: 0 } });
});

t('M4A med moov sist: servern skickar moov först (samma ljud, Range fungerar)', async () => {
  const id = S.track['Moovsist 1'];
  const orig = fs.readFileSync(path.join(MEDIA, 'Musik', 'Nätet', 'Moovsist', '01 Moovsist 1.m4a'));
  assert.deepEqual(topBoxes(orig).filter(b => b === 'moov' || b === 'mdat'), ['mdat', 'moov'], 'provfilen har moov sist');
  const r = await fetch(`${B}/api/music/tracks/${id}/stream?a=mp3,aac,flac`, { headers: { authorization: 'Bearer ' + tok } });
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200);
  assert.equal(+r.headers.get('content-length'), body.length);
  assert.equal(r.headers.get('x-moov-first'), '1');
  assert.ok(body.length < orig.length - 250e3, `omslaget i taggarna skickas inte (${orig.length} → ${body.length} byte)`);
  assert.deepEqual(topBoxes(body).filter(b => b === 'moov' || b === 'mdat'), ['moov', 'mdat'], 'moov före ljudet');
  // Samma avkodade ljud, bit för bit (ingen omkodning)
  const pcm = (buf) => { const f = path.join(ROOT, 'x.m4a'); fs.writeFileSync(f, buf); return execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-f', 's16le', '-'], { maxBuffer: 64 << 20 }); };
  assert.ok(pcm(body).equals(pcm(orig)), 'samma ljud');
  // Range: valfri bit av den omskrivna filen
  for (const [a, b] of [[0, 99], [100, 70000], [body.length - 500, body.length - 1], [30, 30]]) {
    const rr = await fetch(`${B}/api/music/tracks/${id}/stream?a=mp3,aac,flac`, { headers: { authorization: 'Bearer ' + tok, range: `bytes=${a}-${b}` } });
    assert.equal(rr.status, 206);
    assert.equal(rr.headers.get('content-range'), `bytes ${a}-${b}/${body.length}`);
    assert.ok(Buffer.from(await rr.arrayBuffer()).equals(body.subarray(a, b + 1)), `bytes=${a}-${b}`);
  }
  const tail = await fetch(`${B}/api/music/tracks/${id}/stream?a=mp3,aac,flac`, { headers: { authorization: 'Bearer ' + tok, range: 'bytes=-1000' } });
  assert.ok(Buffer.from(await tail.arrayBuffer()).equals(body.subarray(body.length - 1000)), 'bytes=-1000');
  const bad = await fetch(`${B}/api/music/tracks/${id}/stream?a=mp3,aac,flac`, { headers: { authorization: 'Bearer ' + tok, range: `bytes=${body.length}-` } });
  assert.equal(bad.status, 416);
});

t('M4A med moov sist hemma: ljud inom en halv sekund', async () => {
  const P = await newPage();
  const r = await measure(P, S.Moovsist, { secs: 10 });
  log('M4A moov sist, hemma, obegränsat', r);
  assert.ok(r.start != null && r.start < 0.5, fmt(r));
  assert.ok(r.silence < 0.1, fmt(r));
  assert.deepEqual(P.errors, []);
  await P.close();
});

for (const kbps of [20000, 1000]) {
  t(`M4A med moov sist utanför hemmet, ${kbps / 1000} Mbit/s: snabb start utan hack`, async () => {
    const P = await newPage();
    const r = await measure(P, S.Moovsist, { kbps, latency: 50, remote: true, secs: kbps > 5000 ? 15 : 40 });
    log(`M4A moov sist, borta, ${kbps / 1000} Mbit/s`, r);
    assert.ok(r.start != null && r.start < (kbps > 5000 ? 0.8 : 2), fmt(r));
    assert.ok(r.silence < 0.1, fmt(r));
    assert.deepEqual(P.errors, []);
    await P.close();
  });
}

for (const kbps of [20000, 1000]) {
  t(`FLAC 96 kHz utanför hemmet, ${kbps / 1000} Mbit/s: spelar utan hack de första 40 s`, async () => {
    const P = await newPage();
    const r = await measure(P, S.Hires, { kbps, latency: 50, remote: true, secs: 40 });
    r.extra = P.streams.map(u => /br=(\d+)/.exec(u)?.[1] || 'orig').join(',');
    log(`FLAC 96 kHz, borta, ${kbps / 1000} Mbit/s`, r);
    assert.ok(r.start != null && r.start < (kbps > 5000 ? 1 : 3), fmt(r));
    assert.ok(r.silence < 0.2, fmt(r));
    assert.deepEqual(P.errors, []);
    await P.close();
  });
}

t('FLAC 96 kHz utanför hemmet med för högt uppmätt takt: elementet stannar, kvaliteten sänks och låten fortsätter', async () => {
  const P = await newPage();
  // Takten mättes för en stund sedan (t.ex. på wifi) – nu är nätet 1 Mbit/s: originalet (≈ 2,5 Mbit/s) väljs först
  const r = await measure(P, S.Hires, { kbps: 1000, latency: 50, remote: true, secs: 40,
    setup: async () => (await import('/m/js/player/caps.js')).noteBandwidth(50000) });
  r.extra = P.streams.map(u => /br=(\d+)/.exec(u)?.[1] || 'orig').join(',');
  log('FLAC 96 kHz, borta, 1 Mbit/s, uppmätt 50 Mbit/s', r);
  assert.equal(P.streams[0].includes('br='), false, 'originalet först');
  assert.ok(P.streams.some(u => /br=\d+/.test(u)), 'lägre kvalitet efter stoppet: ' + r.extra);
  // Förut: tyst större delen av tiden (elementet hämtar 2,5 Mbit/s på 1 Mbit/s)
  assert.ok(r.silence < 8, fmt(r));
  assert.deepEqual(P.errors, []);
  await P.close();
});

/**
 * Tystnaderna i albumet Skarvar: övergången från elementet (första låten utanför hemmet) till motorn har elementets
 * precision (några ms, som i web-gapless.test.js; upp till 12 ms när datorn är hårt belastad), motor → motor ska vara exakt.
 * Sist kommer albumets slut.
 */
function joint(r) {
  const inner = r.list.filter(([at]) => at < 11.5);
  assert.ok(r.lastLoud - r.start > 11.9, `albumet spelade till slut: ${(r.lastLoud - r.start).toFixed(2)} s, ${fmt(r)}`);
  assert.ok(inner.every(([at, d]) => at > 3.5 && at < 5 && d < 0.012), 'bara övergången från elementet, och kort: ' + fmt(r));
}
/** Spelar albumet Skarvar (3 × 4 s ur en obruten sinus) och mäter tystnader från första ljudet till sista låtens slut */
async function joints(P, click) {
  const r = await measure(P, S.Skarvar, { remote: true, secs: 14, click });
  return r;
}
t('omkodat utanför hemmet (Opus): övergångarna mellan låtarna är glapplösa', async () => {
  const P = await newPage();
  await req('/api/me/listening', { method: 'PUT', body: { remoteQuality: '192' } });
  try {
    const r = await joints(P);
    r.extra = P.streams.map(u => (/br=(\d+)/.exec(u)?.[1] || 'orig') + (/fmt=opus/.test(u) ? 'opus' : '')).join(',');
    log('Skarvar, borta, 192 kbit/s Opus', r);
    assert.ok(P.streams.length >= 3 && P.streams.every(u => /br=192/.test(u)), r.extra);
    joint(r);
    assert.deepEqual(P.errors, []);
  } finally { await req('/api/me/listening', { method: 'PUT', body: { remoteQuality: 'auto' } }); await P.close(); }
});
t('omkodat utanför hemmet (AAC, utan Opus): kodarens fördröjning skärs bort i motorn', async () => {
  const P = await newPage();
  await req('/api/me/listening', { method: 'PUT', body: { remoteQuality: '192' } });
  try {
    // Motorn som i en webbläsare utan Opus (Safari): servern kodar då till AAC med 1024 sampels fördröjning först
    const r = await joints(P, () => { window.__ae.E.caps = 'mp3,aac,flac'; });
    r.extra = P.streams.map(u => (/br=(\d+)/.exec(u)?.[1] || 'orig') + (/fmt=opus/.test(u) ? 'opus' : '')).join(',');
    log('Skarvar, borta, 192 kbit/s AAC i motorn', r);
    assert.ok(P.streams.filter(u => !/fmt=opus/.test(u)).length >= 2, r.extra);
    joint(r);
    assert.deepEqual(P.errors, []);
  } finally { await req('/api/me/listening', { method: 'PUT', body: { remoteQuality: 'auto' } }); await P.close(); }
});
