// Webbens musikspelare i Chromium (Playwright): glapplöst, övertoning och jämn ljudnivå mätt på själva ljudet.
// Spåren är ffmpeg-genererade sinustoner: ett album där en obruten ton delats mitt i (FLAC och MP3 med LAME-fördröjning),
// album för övertoningen (samma album går ihop, annat album tonas över) och spår med kända ReplayGain-taggar.
// Utgången spelas in med en AudioWorklet efter begränsaren (window.__bxAudioTap i audioengine.js) och analyseras:
//   – glapp: en ren sinus uppfyller x[n] = 2cos(ω)·x[n−1] − x[n−2]; ett glapp eller fasfel ger ett stort residualvärde
//   – övertoning: Goertzel per fönster – hur länge två toner hörs samtidigt
//   – ljudnivå: amplituden mot förväntad förstärkning, och att toppen aldrig når 0 dBFS
// Hoppas över om ffmpeg eller Playwright saknas. Riktiga högtalare, Safari och Firefox provas inte.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const skip = !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-gapless-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 29000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const SR = 44100;
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

/** En obruten sinuston delad på exakta sampel i flera filer (samma fas genom skarvarna). */
function splitTone(dir, name, freq, lens, enc, ext, tags = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const total = lens.reduce((a, b) => a + b, 0);
  const wav = path.join(ROOT, `${name}.wav`);
  ff('-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*${freq}*t):s=${SR}:d=${total + 0.1}`, '-ac', '1', '-c:a', 'pcm_s16le', wav);
  let at = 0;
  lens.forEach((l, i) => {
    const a = Math.round(at * SR), b = Math.round((at + l) * SR);
    ff('-i', wav, '-af', `atrim=start_sample=${a}:end_sample=${b}`, ...enc, '-metadata', `title=${name} ${i + 1}`, '-metadata', 'artist=Testaren',
      '-metadata', `album=${name}`, '-metadata', `track=${i + 1}`, ...Object.entries(tags[i] || {}).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]),
      path.join(dir, `0${i + 1} ${name} ${i + 1}.${ext}`));
    at += l;
  });
}
const FLAC = ['-c:a', 'flac'], MP3 = ['-c:a', 'libmp3lame', '-b:a', '256k'];

before(async () => {
  if (skip) return;
  const M = path.join(MEDIA, 'Musik', 'Testaren');
  // Glapplöst album: 440 Hz genom tre FLAC-spår (skarvar mitt i en period)
  splitTone(path.join(M, 'Glapplöst'), 'Glapplöst', 440, [1.7031, 2.2017, 1.5], FLAC, 'flac');
  // MP3 med LAME-fördröjning och utfyllnad (webbläsaren eller vi tar bort den)
  splitTone(path.join(M, 'Livealbum'), 'Livealbum', 523.25, [2.0113, 2.5], MP3, 'mp3');
  // Övertoning: spår 1 → 2 på samma album går ihop, spår 2 → nästa album tonas över
  splitTone(path.join(M, 'Albumet A'), 'Albumet A', 300, [2, 6], FLAC, 'flac');
  splitTone(path.join(M, 'Albumet B'), 'Albumet B', 700, [6], FLAC, 'flac');
  // Jämn ljudnivå: amplitud 0,5 (toppvärde 0,5) med kända taggar
  splitTone(path.join(M, 'Nivåer'), 'Nivåer', 500, [3, 3], FLAC, 'flac', [
    { REPLAYGAIN_TRACK_GAIN: '-6.02 dB', REPLAYGAIN_ALBUM_GAIN: '-12.04 dB', REPLAYGAIN_TRACK_PEAK: '0.5' },
    { REPLAYGAIN_TRACK_GAIN: '+12.00 dB', REPLAYGAIN_ALBUM_GAIN: '-12.04 dB', REPLAYGAIN_TRACK_PEAK: '0.5' }]);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '',
      WATCH_FILES: '0', MUSIC_SONIC: '0', MUSIC_LOUDNESS: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip }, fn);

// Inspelning av spelarens utgång: AudioWorklet (bypassCSP – blob-modul) som skickar block om 4096 sampel
function tapScript() {
  const chunks = [];
  window.__rec = { chunks, on: false };
  window.__bxAudioTap = async (ctx, node) => {
    const code = `class Rec extends AudioWorkletProcessor { constructor() { super(); this.b = new Float32Array(4096); this.n = 0; }
      process(inp) { const c = inp[0] && inp[0][0]; if (c) { for (let i = 0; i < c.length; i++) { this.b[this.n++] = c[i]; if (this.n === 4096) { this.port.postMessage(this.b.slice()); this.n = 0; } } } return true; } }
      registerProcessor('rec', Rec);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const w = new AudioWorkletNode(ctx, 'rec');
    w.port.onmessage = (e) => { if (window.__rec.on) chunks.push(e.data); };
    node.connect(w); w.connect(ctx.destination);
    window.__rec.ctx = ctx;
    window.__rec.on = true;
  };
}
async function newPage(width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 740 : 800 }, bypassCSP: true });
  await ctx.addCookies([{ name: 'kt', value: cookie, url: B }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(tapScript);
  return { page, errors, close: () => ctx.close() };
}
/** Spelar albumet från första spåret och spelar in tills spelaren pausat vid köns slut (högst `secs` sekunder ljud). */
async function playAndRecord(page, albumId, secs) {
  await page.goto(B + '/#/album/' + albumId);
  await page.click('tr[data-ti="0"]');
  await page.waitForFunction(() => window.__rec?.on);
  try { await page.waitForFunction((n) => window.__rec.chunks.length * 4096 >= n || (window.__rec.chunks.length > 4 && window.__rec.ctx.state === 'suspended'), Math.round(secs * SR), { timeout: (secs + 30) * 1000 }); }
  catch (e) {
    const st = await page.evaluate(async () => { const m = await import('/m/js/audioengine.js'); return { ...m.debugState(), ctx: m.E.ctx?.state, chunks: window.__rec.chunks.length, el: document.querySelector('#maudio').currentTime }; }).catch(x => String(x));
    e.message += ' ' + JSON.stringify(st); throw e;
  }
  const data = await page.evaluate(() => { const c = window.__rec.chunks; const out = new Float32Array(c.length * 4096); c.forEach((b, i) => out.set(b, i * 4096)); return Array.from(out); });
  return Float32Array.from(data);
}
function activeRange(x, thr = 0.05) {
  let a = 0; while (a < x.length && Math.abs(x[a]) < thr) a++;
  let b = x.length - 1; while (b > a && Math.abs(x[b]) < thr) b--;
  return [a, b];
}
/** Största avvikelse från en ren sinus (rekursionen) i [a, b]. */
function sineResidual(x, a, b, freq) {
  const c = 2 * Math.cos(2 * Math.PI * freq / SR);
  let max = 0, at = -1;
  for (let n = a + 2; n <= b; n++) { const r = Math.abs(x[n] - c * x[n - 1] + x[n - 2]); if (r > max) { max = r; at = n; } }
  return { max, at };
}
const goertzel = (x, s, n, f) => {
  const k = 2 * Math.cos(2 * Math.PI * f / SR); let p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) { const v = x[s + i] + k * p1 - p2; p2 = p1; p1 = v; }
  return Math.sqrt(p1 * p1 + p2 * p2 - k * p1 * p2) * 2 / n; // amplitud
};
const peakAmp = (x, a, b) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i])); return m; };

t('förberedelse: konto, musikbibliotek och analys', async () => {
  assert.equal((await fetch(B + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) })).status, 200);
  tok = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW, app: true }) })).json()).token;
  const lr = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) });
  cookie = /kt=([0-9a-f]+)/.exec(lr.headers.get('set-cookie'))[1];
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Musik', type: 'music', path: path.join(MEDIA, 'Musik') } })).status, 200);
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  // Skanningen och sedan bakgrundsjobbet (trim och tystnad i kanterna) för alla spår
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const r = (await req('/api/scan')).data;
    if (!r.running && r.last && db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE gl IS NULL').get().n === 0 && db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n === 10) break;
  }
  for (const r of db.prepare('SELECT id, title FROM albums').all()) S[r.title] = r.id;
  db.close();
  assert.ok(S['Glapplöst'] && S['Livealbum'] && S['Albumet A'] && S['Albumet B'] && S['Nivåer'], JSON.stringify(S));
  const al = (await req('/api/music/albums/' + S['Livealbum'])).data;
  const g = al.trackList[0].gapless;
  assert.equal(g.sampleRate, SR);
  assert.equal(g.samples, Math.round(2.0113 * SR)); // exakt längd ur LAME-taggen
  assert.ok(g.skip > 529 && g.pad >= 0, JSON.stringify(g));
});

t('glapplöst: obruten ton genom tre FLAC-spår utan glapp', async () => {
  await req('/api/me/listening', { method: 'PUT', body: { normMode: 'off', gapless: true, crossfade: 0 } });
  const { page, errors, close } = await newPage();
  const x = await playAndRecord(page, S['Glapplöst'], 7.2);
  const [a, b] = activeRange(x);
  const want = Math.round((1.7031 + 2.2017 + 1.5) * SR);
  const res = sineResidual(x, a + 8, b - 8, 440);
  assert.ok(res.max < 0.01, `skarv med glapp eller fasfel: residual ${res.max.toFixed(4)} vid sampel ${res.at - a}`);
  assert.ok(Math.abs((b - a + 1) - want) < SR * 0.003, `längd ${b - a + 1} mot ${want} sampel`);
  // Begränsaren och kompensationen ändrar inte nivån under tröskeln
  assert.ok(Math.abs(peakAmp(x, a, b) - 0.5) < 0.01, 'amplitud ' + peakAmp(x, a, b));
  const st = await page.evaluate(async () => (await import('/m/js/audioengine.js')).debugState());
  assert.equal(st.on, true, 'motorn spelade buffertar');
  assert.deepEqual(errors, []);
  await close();
});

t('glapplöst: första låten hinner inte avkodas – elementet spelar och motorn tar över utan tystnad', async () => {
  await req('/api/me/listening', { method: 'PUT', body: { normMode: 'off', gapless: true, crossfade: 0 } });
  const { page, errors, close } = await newPage();
  const first = (await req('/api/music/albums/' + S['Glapplöst'])).data.trackList[0].id;
  // Motorns hämtning av första låten fördröjs längre än väntetiden (GRACE) – elementet tar den
  await page.route(new RegExp(`/api/music/tracks/${first}/stream\\?.*gl=1`), async (r) => { await sleep(4000); r.continue().catch(() => {}); });
  const x = await playAndRecord(page, S['Glapplöst'], 7.2);
  const [a, b] = activeRange(x);
  // Elementets precision är några millisekunder: ingen tystnad över 6 ms nära noll (2 ms räckte inte när datorn
  // var hårt belastad – 2,6 ms en gång i hela sviten), längden inom 25 ms
  let run = 0, worst = 0;
  for (let i = a; i <= b; i++) { if (Math.abs(x[i]) < 0.02) { run++; worst = Math.max(worst, run); } else run = 0; }
  assert.ok(worst < SR * 0.006, `tystnad i övergången: ${(worst / SR * 1000).toFixed(1)} ms`);
  const want = Math.round((1.7031 + 2.2017 + 1.5) * SR);
  assert.ok(Math.abs((b - a + 1) - want) < SR * 0.025, `längd ${b - a + 1} mot ${want} sampel`);
  // Andra → tredje är buffert → buffert: exakt
  const res = sineResidual(x, b - Math.round(1.5 * SR) - Math.round(0.3 * SR), b - 8, 440);
  assert.ok(res.max < 0.01, `skarv buffert → buffert: residual ${res.max.toFixed(4)}`);
  assert.deepEqual(errors, []);
  await close();
});

t('glapplöst: MP3 med kodarfördröjning – ingen tystnad i skarven', async () => {
  const { page, errors, close } = await newPage();
  const x = await playAndRecord(page, S['Livealbum'], 5.5);
  const [a, b] = activeRange(x);
  const res = sineResidual(x, a + Math.round(0.05 * SR), b - Math.round(0.05 * SR), 523.25);
  // MP3 är förstörande – ett glapp på ett enda sampel ger ändå residual ≈ amplituden
  assert.ok(res.max < 0.1, `skarv i MP3: residual ${res.max.toFixed(4)} vid ${(res.at - a) / SR} s`);
  const want = Math.round((2.0113 + 2.5) * SR);
  assert.ok(Math.abs((b - a + 1) - want) < SR * 0.01, `längd ${b - a + 1} mot ${want} sampel (fördröjning/utfyllnad kvar?)`);
  assert.deepEqual(errors, []);
  await close();
});

t('övertoning: inte inom albumet där spåren går ihop, men till nästa album', async () => {
  await req('/api/me/listening', { method: 'PUT', body: { normMode: 'off', gapless: true, crossfade: 2 } });
  const { page, errors, close } = await newPage();
  // Kön: Albumet A (2 spår) och sedan Albumet B – från albumsidan läggs bara albumet i kön, så kön byggs direkt
  await page.goto(B + '/#/album/' + S['Albumet A']);
  await page.waitForSelector('tr[data-ti="0"]');
  await page.evaluate(async (ids) => {
    const { api } = await import('/m/js/core.js');
    const { playQueue } = await import('/m/js/audio.js');
    const [a, b] = await Promise.all(ids.map(id => api('/music/albums/' + id)));
    playQueue([...a.trackList, ...b.trackList], 0);
  }, [S['Albumet A'], S['Albumet B']]);
  await page.waitForFunction(() => window.__rec?.on);
  await page.waitForFunction(() => window.__rec.chunks.length > 4 && window.__rec.ctx.state === 'suspended', null, { timeout: 60000 });
  const x = Float32Array.from(await page.evaluate(() => { const c = window.__rec.chunks; const o = new Float32Array(c.length * 4096); c.forEach((b, i) => o.set(b, i * 4096)); return Array.from(o); }));
  const N = 1024, both = (f1, f2) => { let n = 0; for (let s = 0; s + N < x.length; s += N) if (goertzel(x, s, N, f1) > 0.08 && goertzel(x, s, N, f2) > 0.08) n++; return n; };
  const ab = both(300, 700);
  assert.ok(ab * N / SR > 1.2 && ab * N / SR < 2.6, `övertoning till nästa album: ${(ab * N / SR).toFixed(2)} s med båda tonerna`);
  // Albumet A är en obruten 300 Hz-ton genom skarven: ingen övertoning (då skulle nivån dippa), inget glapp
  const [a] = activeRange(x);
  const res = sineResidual(x, a + 8, a + Math.round(5 * SR), 300);
  assert.ok(res.max < 0.01, `skarven inom albumet: residual ${res.max.toFixed(4)}`);
  assert.ok(Math.abs(peakAmp(x, a + Math.round(1.5 * SR), a + Math.round(2.5 * SR)) - 0.5) < 0.01, 'ingen nedtoning i albumskarven');
  assert.deepEqual(errors, []);
  await close();
});

t('jämn ljudnivå: spår- och albumläge, toppvärdet hindrar klippning', async () => {
  const amps = async (mode) => {
    await req('/api/me/listening', { method: 'PUT', body: { normMode: mode, gapless: true, crossfade: 0 } });
    const { page, errors, close } = await newPage();
    const x = await playAndRecord(page, S['Nivåer'], 6.5);
    const [a] = activeRange(x, 0.02);
    const r = [peakAmp(x, a + Math.round(0.8 * SR), a + Math.round(2.8 * SR)), peakAmp(x, a + Math.round(3.8 * SR), a + Math.round(5.8 * SR))];
    assert.deepEqual(errors, []);
    await close();
    return r;
  };
  const tr = await amps('track');
  assert.ok(Math.abs(tr[0] - 0.25) < 0.01, `spår 1 (−6 dB): ${tr[0]}`);
  // +12 dB begränsas av toppvärdet till ×2 (0 dBFS) och begränsaren håller toppen under 0 dBFS
  assert.ok(tr[1] > 0.8 && tr[1] < 0.995, `spår 2 (+12 dB, topp 0,5): ${tr[1]}`);
  const al = await amps('album');
  assert.ok(Math.abs(al[0] - 0.125) < 0.01 && Math.abs(al[1] - 0.125) < 0.01, `albumläge (−12 dB): ${al}`);
  const off = await amps('off');
  assert.ok(Math.abs(off[0] - 0.5) < 0.01 && Math.abs(off[1] - 0.5) < 0.01, `av: ${off}`);
});

t('ljudmenyn i musikspelaren: inställningarna sparas på kontot', async () => {
  await req('/api/me/listening', { method: 'PUT', body: { normMode: 'track', gapless: true, crossfade: 0 } });
  const { page, errors, close } = await newPage();
  await page.goto(B + '/#/album/' + S['Glapplöst']);
  await page.click('tr[data-ti="0"]');
  await page.click('#mset');
  await page.getByRole('menuitem', { name: /Övertoning/ }).click();
  const saved = page.waitForResponse(r => r.url().endsWith('/api/me/listening') && r.request().method() === 'PUT');
  await page.getByRole('menuitem', { name: '6 sekunder' }).click();
  await saved;
  await page.click('#mset');
  await page.getByRole('menuitem', { name: /Jämn ljudnivå/ }).click();
  const saved2 = page.waitForResponse(r => r.url().endsWith('/api/me/listening') && r.request().method() === 'PUT');
  await page.getByRole('menuitem', { name: /^Album/ }).click();
  await saved2;
  if (process.env.SHOTS) { await page.click('#mset'); await page.screenshot({ path: path.join(process.env.SHOTS, 'ljudmeny-1280.png') }); await page.keyboard.press('Escape'); }
  const p = (await req('/api/me/listening')).data;
  assert.equal(p.crossfade, 6); assert.equal(p.normMode, 'album'); assert.equal(p.normalize, true);
  assert.deepEqual(errors, []);
  await close();
  // Telefon: knappen syns och menyn öppnas som ark nerifrån
  const m = await newPage(375);
  await m.page.goto(B + '/#/album/' + S['Glapplöst']);
  await m.page.click('tr[data-ti="0"]');
  await m.page.waitForSelector('#mbar:not([hidden]) #mset');
  if (process.env.SHOTS) await m.page.screenshot({ path: path.join(process.env.SHOTS, 'musikspelare-375.png') });
  await m.page.click('#mset');
  await m.page.getByRole('menuitem', { name: /Glapplös uppspelning/ }).waitFor();
  if (process.env.SHOTS) await m.page.screenshot({ path: path.join(process.env.SHOTS, 'ljudmeny-375.png') });
  assert.deepEqual(m.errors, []);
  await m.close();
});
