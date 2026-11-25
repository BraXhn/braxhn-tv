// Webbens musikspelare i Chrome/Chromium (Playwright) när det inte går som det ska: många låtar i rad (minne), snabba
// hopp i kön, långsamt nät och nätavbrott. Mäts i motorn (debugState), på nätet (CDP: vilka hämtningar som avbryts) och
// på själva ljudet (inspelning efter begränsaren, som i web-gapless.test.js).
// Hoppas över om ffmpeg eller Playwright saknas. Riktiga högtalare, Safari och Firefox provas inte.
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-robust-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
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
/** Ett album där en obruten sinus (vänster kanal) delats på exakta sampel; noise = brus i höger kanal (verklig filstorlek). */
function album(name, freq, sr, n, len, noise) {
  const dir = path.join(MEDIA, 'Musik', 'Testaren', name);
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(ROOT, `${name}.wav`);
  if (noise) ff('-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*${freq}*t):s=${sr}:d=${n * len}`, '-f', 'lavfi', '-i', `anoisesrc=c=white:r=${sr}:a=0.3:d=${n * len}:seed=5`,
    '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo', '-c:a', 'pcm_s16le', wav);
  else ff('-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*${freq}*t):s=${sr}:d=${n * len}`, '-ac', '1', '-c:a', 'pcm_s16le', wav);
  for (let i = 0; i < n; i++) ff('-i', wav, '-af', `atrim=start_sample=${i * len * sr}:end_sample=${(i + 1) * len * sr},asetpts=N/SR/TB`, '-c:a', 'flac',
    '-metadata', `title=${name} ${i + 1}`, '-metadata', 'artist=Testaren', '-metadata', `album=${name}`, '-metadata', `track=${i + 1}`, path.join(dir, `0${i + 1} ${name} ${i + 1}.flac`));
  fs.rmSync(wav);
}

before(async () => {
  if (skip) return;
  album('Korta', 440, 44100, 5, 3, false);   // fem korta spår: glapplösa övergångar utan att någon rör spelaren
  album('Stora', 500, 44100, 6, 24, true);   // ~1,9 MB per spår (≈ 640 kbit/s): hopp i kön och långsamt nät
  album('Takt48', 600, 48000, 2, 3, false);  // 48 kHz: ljudsammanhanget ska få låtens takt
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

function tapScript() {
  const chunks = [];
  window.__rec = { chunks, on: false, n: 0 };
  window.__bxAudioTap = async (ctx, node) => {
    const code = `class Rec extends AudioWorkletProcessor {
      process(inp) { const c = inp[0] && inp[0][0]; if (c) this.port.postMessage(c.slice()); return true; } }
      registerProcessor('rec', Rec);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const w = new AudioWorkletNode(ctx, 'rec');
    w.port.onmessage = (e) => { if (window.__rec.on) { chunks.push(e.data); window.__rec.n += e.data.length; } };
    node.connect(w); w.connect(ctx.destination);
    window.__rec.ctx = ctx; window.__rec.on = true;
  };
}
/** Sida med inspelning, nätstrypning (CDP) och bokföring av musikhämtningarna: { url, gl, done, canceled } */
async function newPage() {
  await clearMusicQueue(req); // ingen minispelare från förra testets kö
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true });
  await ctx.addCookies([{ name: 'kt', value: cookie, url: B }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(tapScript);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const streams = new Map();
  cdp.on('Network.requestWillBeSent', e => { if (/\/stream\?/.test(e.request.url) && e.request.method === 'GET') streams.set(e.requestId, { url: e.request.url, gl: /gl=1/.test(e.request.url), done: false, canceled: false }); });
  cdp.on('Network.loadingFinished', e => { const s = streams.get(e.requestId); if (s) s.done = true; });
  cdp.on('Network.loadingFailed', e => { const s = streams.get(e.requestId); if (s) s.canceled = true; });
  const net = (o) => cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, ...o });
  const open = async (albumId) => {
    await page.goto(B + '/#/album/' + albumId);
    await page.waitForSelector('tr[data-ti="0"]');
    await page.evaluate(async () => { window.__ae = await import('/m/js/audioengine.js'); window.__au = await import('/m/js/audio.js'); });
  };
  const state = () => page.evaluate(() => { const el = document.querySelector('#maudio'); return { ...window.__ae.debugState(), idx: window.__au.M.idx, elPlaying: !!el && !el.paused && el.currentTime > 0, elErr: el?.error?.code || 0 }; });
  const grab = async () => Float32Array.from(await page.evaluate(() => { const c = window.__rec.chunks; const out = new Float32Array(c.reduce((n, b) => n + b.length, 0)); let o = 0; for (const b of c) { out.set(b, o); o += b.length; } return Array.from(out); }));
  return { page, errors, net, open, state, grab, streams: () => [...streams.values()], close: () => ctx.close() };
}
function sineResidual(x, a, b, freq, sr) {
  const c = 2 * Math.cos(2 * Math.PI * freq / sr);
  let max = 0, at = -1;
  for (let n = a + 2; n <= b; n++) { const r = Math.abs(x[n] - c * x[n - 1] + x[n - 2]); if (r > max) { max = r; at = n; } }
  return { max, at };
}
function longestSilence(x, a, b) { let run = 0, worst = 0; for (let i = a; i < b; i++) { if (Math.abs(x[i]) < 0.02) { run++; worst = Math.max(worst, run); } else run = 0; } return worst; }
const first = (x) => { let a = 0; while (a < x.length && Math.abs(x[a]) < 0.05) a++; return a; };

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
    if (!r.running && r.last && db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE gl IS NULL').get().n === 0 && db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n === 13) break;
  }
  for (const r of db.prepare('SELECT id, title FROM albums').all()) S[r.title] = r.id;
  db.close();
  assert.ok(S.Korta && S.Stora && S.Takt48, JSON.stringify(S));
  await req('/api/me/listening', { method: 'PUT', body: { normMode: 'off', gapless: true, crossfade: 0 } });
});

t('minne: glapplösa övergångar lämnar inga gamla buffertar kvar i motorn', async () => {
  const P = await newPage();
  await P.open(S.Korta);
  await P.page.click('tr[data-ti="0"]');
  await P.page.waitForFunction(() => window.__au.M.idx === 4, null, { timeout: 60000 });
  await sleep(600);
  const st = await P.state();
  // Förut låg varje spelad låt kvar (med sin avkodade buffert, ~20 MB per minut) tills någon spolade eller bytte låt
  assert.ok(st.old <= 1, `gamla röster kvar efter fyra övergångar: ${st.old}`);
  assert.ok(st.cache <= 2, 'cachen: ' + st.cache);
  assert.deepEqual(P.errors, []);
  await P.close();
});

t('hopp i kön: överhoppade låtar hämtas inte färdigt, och rätt låt spelar', async () => {
  const P = await newPage();
  await P.net({ downloadThroughput: 4e6 / 8, uploadThroughput: 1e6 }); // 1,9 MB per låt tar ~4 s
  await P.open(S.Stora);
  await P.page.click('tr[data-ti="0"]');
  for (let i = 0; i < 5; i++) { await sleep(80); await P.page.click('#mnext'); }
  await P.page.waitForFunction(() => window.__ae.debugState().on || !document.querySelector('#maudio').paused, null, { timeout: 30000 });
  await sleep(500);
  const st = await P.state(), ss = P.streams();
  assert.equal(st.idx, 5, 'kön står på sjätte låten');
  const ids = await P.page.evaluate(() => ({ visar: window.__au.M.cur.id, köns: window.__au.M.queue[5].id }));
  assert.equal(st.cur ?? st.elT, ids.köns, 'låten som spelar är köns sjätte');
  assert.equal(ids.visar, ids.köns);
  assert.ok(ss.filter(s => s.canceled).length >= 4, `avbrutna hämtningar: ${ss.filter(s => s.canceled).length} av ${ss.length}`);
  assert.deepEqual(P.errors, []);
  await P.close();
});

t('långsamt nät som ändå hinner med låten: motorn börjar på det som kommit och växer utan skarv', async () => {
  const P = await newPage();
  await P.net({ latency: 100, downloadThroughput: 1.6e6 / 8, uploadThroughput: 1e6 }); // 2,5 × låtens bithastighet
  await P.open(S.Stora);
  await P.page.click('tr[data-ti="0"]');
  await P.page.waitForFunction(() => window.__rec?.on && (window.__ae.debugState().on || !document.querySelector('#maudio').paused), null, { timeout: 30000 });
  const st1 = await P.state();
  // Förut krävdes att hela resten hann fram innan början tog slut – annars väntade spelaren 1,5 s och lät elementet börja om
  assert.ok(st1.on && st1.partial, 'motorn spelar en början: ' + JSON.stringify(st1));
  const sr = await P.page.evaluate(() => window.__rec.ctx.sampleRate);
  await P.page.evaluate(() => { window.__rec.chunks.length = 0; window.__rec.n = 0; });
  await P.page.waitForFunction((n) => window.__rec.n >= n, sr * 12, { timeout: 60000 });
  const st2 = await P.state(), x = await P.grab(), a = first(x);
  assert.ok(st2.on, 'motorn spelar fortfarande (inget övertag): ' + JSON.stringify(st2));
  assert.ok(st2.upgrades >= 2, 'början har vuxit flera gånger: ' + st2.upgrades);
  const res = sineResidual(x, a + 8, x.length - 8, 500, sr);
  assert.ok(res.max < 0.01, `skarv när början växte: residual ${res.max.toFixed(4)} vid ${((res.at - a) / sr).toFixed(2)} s`);
  assert.ok(longestSilence(x, a, x.length) < sr * 0.002, 'tystnad');
  assert.equal(P.streams().filter(s => !s.gl).length, 0, 'elementet hämtade inget');
  assert.deepEqual(P.errors, []);
  await P.close();
});

t('för långsamt nät: elementet strömmar ensamt – motorns hämtning av samma låt avbryts', async () => {
  const P = await newPage();
  await P.net({ latency: 100, downloadThroughput: 0.5e6 / 8, uploadThroughput: 1e6 }); // under låtens bithastighet
  await P.open(S.Stora);
  await P.page.click('tr[data-ti="0"]');
  await P.page.waitForFunction(() => { const el = document.querySelector('#maudio'); return el && !!el.getAttribute('src'); }, null, { timeout: 30000 });
  await sleep(1500);
  const ss = P.streams(), st = await P.state();
  assert.equal(st.on, false, 'elementet har låten');
  // Förut fortsatte motorns hämtning i bakgrunden och delade det lilla som fanns med elementet (hack i ljudet)
  assert.ok(ss.filter(s => s.gl).every(s => s.canceled), 'motorns hämtning avbruten: ' + JSON.stringify(ss));
  assert.deepEqual(P.errors, []);
  await P.close();
});

t('nätavbrott vid låtbyte: spelaren väntar och fortsätter av sig själv när nätet är tillbaka', async () => {
  const P = await newPage();
  await P.open(S.Stora);
  await P.page.click('tr[data-ti="0"]');
  await P.page.waitForFunction(() => window.__ae.debugState().on && !window.__ae.debugState().partial, null, { timeout: 30000 });
  await P.net({ offline: true });
  await P.page.click('#mnext');
  await P.page.getByText('Inget nät – musiken fortsätter när det är tillbaka').waitFor({ timeout: 15000 });
  assert.equal(await P.page.getByText('Kunde inte spela låten').count(), 0, 'inget felmeddelande om låten');
  await sleep(1500);
  await P.net({});
  // Förut: "Kunde inte spela låten" och tyst tills någon tryckte själv
  await P.page.waitForFunction(() => window.__ae.debugState().on || (!document.querySelector('#maudio').paused && document.querySelector('#maudio').currentTime > 0.2), null, { timeout: 25000 });
  const st = await P.state();
  assert.equal(st.idx, 1, 'andra låten spelar');
  await P.close();
});

t('spolning precis när nästa låt börjat (före bytet i tick): bara låten man spolar i spelar', async () => {
  const P = await newPage();
  await P.open(S.Korta);
  await P.page.click('tr[data-ti="0"]');
  // Nästa låt startar vid next.at men byts in först i nästa tick (var 250:e ms) – spola i det fönstret
  const hit = await P.page.evaluate(() => new Promise((ok) => {
    const E = window.__ae.E, end = Date.now() + 20000;
    const iv = setInterval(() => {
      if (Date.now() > end) { clearInterval(iv); ok(null); }
      if (E.cur && E.next && E.ctx.currentTime >= E.next.at && E.cur.t.id !== E.next.t.id) {
        clearInterval(iv);
        const r = { from: E.cur.t.id, idx: window.__au.M.idx, late: E.ctx.currentTime - E.next.at };
        window.__au.M.audio.currentTime = 0.5;
        ok(r);
      }
    }, 2);
  }));
  assert.ok(hit, 'fönstret mellan nästa låts start och bytet hittades inte');
  await sleep(700);
  const st = await P.state();
  const live = await P.page.evaluate(() => { const E = window.__ae.E; return [E.cur, E.next, ...E.old].filter(v => v && !v.done && v.at <= E.ctx.currentTime).map(v => v.t.id); });
  // Förut: den startade nästa låten fick ligga kvar, tick() bytte till den och den spolade låten fortsatte bland de gamla – två låtar samtidigt
  assert.equal(st.cur, hit.from, `låten man spolade i spelar (${JSON.stringify(st)}, ${JSON.stringify(hit)})`);
  assert.equal(st.idx, hit.idx, 'kön står kvar på låten');
  assert.deepEqual(live, [hit.from], 'bara en låt låter');
  // Nästa låt planeras om och kommer när den spolade låten tagit slut
  await P.page.waitForFunction((i) => window.__au.M.idx === i + 1, hit.idx, { timeout: 10000 });
  assert.deepEqual(P.errors, []);
  await P.close();
});

t('Föregående medan nästa låt väntar på sin buffert: byter tillbaka i stället för att spola förra låtens element', async () => {
  const P = await newPage();
  await P.net({ latency: 100, downloadThroughput: 0.5e6 / 8, uploadThroughput: 1e6 }); // elementet spelar (för långsamt för motorn)
  await P.open(S.Stora);
  await P.page.click('tr[data-ti="0"]');
  await P.page.waitForFunction(() => { const el = document.querySelector('#maudio'); return !window.__ae.debugState().on && el.currentTime > 3.5; }, null, { timeout: 40000 });
  await P.page.click('#mnext');
  await sleep(150);
  // Nästa låt väntar (upp till GRACE) på motorn; elementet står pausat kvar på förra låtens position (> 3 s)
  assert.equal(await P.page.evaluate(() => window.__au.M.idx), 1);
  await P.page.click('#mprev');
  await sleep(300);
  // Förut lästes elementets gamla position: > 3 s → "spola till början" av en låt som inte längre spelade, och kön stod kvar på låt 2
  assert.equal(await P.page.evaluate(() => window.__au.M.idx), 0, 'Föregående gick tillbaka till första låten');
  await P.page.waitForFunction(() => { const el = document.querySelector('#maudio'); return window.__ae.debugState().on || (!!el.getAttribute('src') && !el.paused); }, null, { timeout: 30000 });
  const ids = await P.page.evaluate(() => ({ cur: window.__au.M.cur.id, first: window.__au.M.queue[0].id }));
  assert.equal(ids.cur, ids.first);
  assert.deepEqual(P.errors, []);
  await P.close();
});

t('samplingsfrekvens: ljudsammanhanget får låtens takt – 48 kHz-album utan fel i skarven', async () => {
  const P = await newPage();
  await P.open(S.Takt48);
  await P.page.click('tr[data-ti="0"]');
  await P.page.waitForFunction(() => window.__rec?.on);
  await P.page.waitForFunction(() => window.__rec.chunks.length > 128 && window.__rec.ctx.state === 'suspended', null, { timeout: 40000 });
  const st = await P.state(), x = await P.grab(), a = first(x);
  assert.equal(st.rate, 48000, 'sammanhangets takt');
  let b = x.length - 1; while (b > a && Math.abs(x[b]) < 0.05) b--;
  // Omräknat till 44,1 kHz spår för spår tappades ett sampel i skarven (residual ≈ 0,06)
  // Hann första låten inte avkodas (hårt belastad dator) spelade elementet den och motorn tog över med elementets
  // precision (några ms, se web-gapless.test.js) – då går skarven inte att mäta på sampel
  const res = sineResidual(x, a + 8, b - 8, 600, 48000);
  if (!st.handovers) assert.ok(res.max < 0.005, `skarven: residual ${res.max.toFixed(4)} vid ${((res.at - a) / 48000).toFixed(3)} s (${JSON.stringify(st)})`);
  // Längden mäts på inspelningen, som kan tappa några ms i början när datorn är hårt belastad (hela testsviten) –
  // skarven själv mäts provexakt ovan, så här räcker det att ingen låt saknas eller spelas två gånger
  assert.ok(Math.abs((b - a + 1) - 6 * 48000) < 48000 * (st.handovers ? 0.025 : 0.015), `längd ${b - a + 1} (${JSON.stringify(st)})`);
  assert.deepEqual(P.errors, []);
  await P.close();
});
