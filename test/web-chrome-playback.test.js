// Uppspelning i riktig Chrome (H.264): webbappen ska använda sin egen spelare (hls.js) där – inte Chromes inbyggda
// HLS-spelare, som numera svarar ja på canPlayType('application/vnd.apple.mpegurl') men tömmer bufferten och fryser
// bilden på remux av filer med öppen GOP (vanligt i riktiga filer). Testet spelar en sådan fil och räknar bildrutor.
// Hoppas över utan Google Chrome (Playwrights Chromium saknar H.264), Playwright eller ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer } from './media/server.mjs';
import { freePort } from './helpers/port.js';
import { CHROME, chromium, launchChrome, loginPage, installProbes as helpers } from './helpers/chrome.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = !CHROME ? 'Google Chrome saknas' : !chromium ? 'Playwright saknas' : !hasFfmpeg ? 'ffmpeg saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-chrome-'));
const FPS = 24, SECS = 14;
let srv, browser, film, flat, lang, ten;

before(async () => {
  if (skip) return;
  const dir = path.join(ROOT, 'media', 'Filmer'); fs.mkdirSync(dir, { recursive: true });
  // Öppen GOP, B-bilder och AC-3 (ljudet konverteras): så ser många riktiga filer ut
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '70',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high', '-bf', '3', '-x264-params', 'keyint=96:min-keyint=24:open-gop=1', '-pix_fmt', 'yuv420p',
    '-c:a', 'ac3', path.join(dir, 'Oppen Film (2020).mkv')]);
  // Öppen GOP utan B-pyramid: här hänvisar även bilderna EFTER nyckelbilden till GOP:en före – avkodningen kan inte
  // börja mitt i filen i Chromes mjukvaruavkodare, vad servern än tar bort (se "omkodas i stället" nedan)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '70',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-x264-params', 'keyint=48:min-keyint=4:open-gop=1:b-pyramid=none:scenecut=0:b-adapt=0', '-pix_fmt', 'yuv420p',
    '-c:a', 'ac3', path.join(dir, 'Utan Pyramid (2021).mkv')]);
  // Två ljudspår med språk, en undertextfil bredvid och liten upplösning (180p): spårens namn och kvalitetsmenyn
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=300', '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '12',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-ac', '2',
    '-metadata:s:a:0', 'language=swe', '-metadata:s:a:1', 'language=eng', path.join(dir, 'Spraak (2022).mkv')]);
  fs.writeFileSync(path.join(dir, 'Spraak (2022).sv.srt'), '1\n00:00:01,000 --> 00:00:05,000\nHej\n');
  // H.264 i 10 bitar: kodas alltid om (spolning i en omkodning)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '180',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', '-ac', '2', path.join(dir, 'Tio Bitar (2023).mkv')]);
  srv = await startServer({ root: ROOT, media: path.join(ROOT, 'media'), port: await freePort(), env: { NODE_ENV: 'test', TMDB_API_KEY: '', WATCH_FILES: '0', HWACCEL: 'none' } });
  await srv.setup();
  const items = (await srv.req('/api/libraries/1/items')).data.items;
  film = items.find(x => /Oppen/.test(x.title)); flat = items.find(x => /Pyramid/.test(x.title)); lang = items.find(x => /Spraak/.test(x.title)); ten = items.find(x => /Tio Bitar/.test(x.title));
  browser = await launchChrome();
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const page = (userAgent, opts) => loginPage(browser, srv.base, userAgent, opts);

test('webbläsarens egen HLS-spelare väljs bara i Safari – i Chrome används hls.js', { skip }, async () => {
  const a = await page();
  const chrome = await a.p.evaluate(async () => { const m = await import('/m/js/player/caps.js'); return { native: m.nativeHls(), says: document.createElement('video').canPlayType('application/vnd.apple.mpegurl') }; });
  assert.equal(chrome.native, false, `Chrome (canPlayType säger "${chrome.says}")`);
  await a.close();
  // Samma fråga med Safaris användaragent: där ska den inbyggda spelaren användas (när webbläsaren säger att den kan)
  const b = await page('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15');
  const safari = await b.p.evaluate(async () => { const m = await import('/m/js/player/caps.js'); return { native: m.nativeHls(), says: document.createElement('video').canPlayType('application/vnd.apple.mpegurl') }; });
  assert.equal(safari.native, !!safari.says, 'Safari följer webbläsarens svar');
  await b.close();
});

test('remux av en fil med öppen GOP spelas utan frysning i Chrome', { skip }, async () => {
  const { p, close } = await page();
  const r = await p.evaluate(async ([id, secs]) => {
    const lazy = await import('/m/js/lazy.js');
    const vm = await lazy.loadPlayer();
    await lazy.play(id, 0);
    const t0 = performance.now();
    const v = () => document.querySelector('#vid');
    while (!(v() && !v().paused && v().readyState >= 3 && v().currentTime > 0.2)) { if (performance.now() - t0 > 30000) return { error: 'startade inte' }; await new Promise(r => setTimeout(r, 50)); }
    let waiting = 0; v().addEventListener('waiting', () => waiting++);
    const q0 = v().getVideoPlaybackQuality(), c0 = v().currentTime, w0 = performance.now();
    await new Promise(r => setTimeout(r, secs * 1000));
    const q1 = v().getVideoPlaybackQuality();
    return { mode: document.querySelector('#pmode')?.textContent || '', hlsjs: !!vm.P?.hls, frames: q1.totalVideoFrames - q0.totalVideoFrames, dropped: q1.droppedVideoFrames - q0.droppedVideoFrames,
      played: v().currentTime - c0, wall: (performance.now() - w0) / 1000, waiting, ranges: v().buffered.length, ahead: v().buffered.length ? v().buffered.end(v().buffered.length - 1) - v().currentTime : 0 };
  }, [film.id, SECS]);
  assert.ok(!r.error, r.error);
  assert.match(r.mode, /Remux/, 'filen remuxas (bilden kopieras)');
  assert.equal(r.hlsjs, true, 'hls.js spelar strömmen');
  // Med Chromes inbyggda spelare visades en tredjedel av bildrutorna och bufferten blev tom
  assert.ok(r.frames >= r.wall * FPS * 0.9, `${r.frames} bildrutor på ${r.wall.toFixed(1)} s (väntat ~${Math.round(r.wall * FPS)})`);
  assert.ok(r.dropped <= r.frames * 0.05, `${r.dropped} tappade bildrutor`);
  assert.ok(Math.abs(r.played - r.wall) < 1, `uppspelningen gick i takt (${r.played.toFixed(1)} s på ${r.wall.toFixed(1)} s)`);
  assert.equal(r.waiting, 0, 'ingen väntan på buffert');
  assert.ok(r.ranges === 1 && r.ahead > 5, `bufferten är hel och ligger före (${r.ranges} delar, ${r.ahead.toFixed(1)} s före)`);
  await close();
});

// helpers(p): __frame, __moves, __errors och __modes i sidan – se test/helpers/chrome.js

test('öppen GOP i Chrome: fortsätt mitt i filen och spolning i bufferten ger bild på rätt ställe (remux behålls)', { skip }, async () => {
  const { p, close } = await page();
  await helpers(p);
  // Fortsätt vid 41 s (mitt i en GOP – avkodningen börjar på en nyckelbild som inte är IDR)
  const r = await p.evaluate(async (id) => { window.__L.play(id, 41); const f = await window.__frame(t => t >= 40 && t < 50); return { f, mv: f.ms == null ? null : await window.__moves(2000), mode: window.__V.P?.pb?.mode, errors: window.__errors }; }, film.id);
  assert.ok(r.f.ms != null, `fortsättning vid 41 s gav ingen bild: ${r.f.state}`);
  assert.equal(r.errors, 0, 'inget avkodningsfel vid starten');
  assert.equal(r.mode, 'remux');
  assert.ok(r.mv.frames >= 2 * FPS * 0.8 && r.mv.played > 1.5, `bilden rör sig efteråt (${r.mv.frames} bildrutor, ${r.mv.played.toFixed(1)} s)`);
  // Spolning till ett ställe som redan är buffrat, i en annan GOP. Förut: avkodningsfel, och filmen började om från början.
  const s = await p.evaluate(async () => {
    const v = document.querySelector('#vid'), t0 = performance.now();
    while (!(v.buffered.length && v.buffered.end(v.buffered.length - 1) - v.currentTime > 14)) { if (performance.now() - t0 > 20000) return { error: 'bufferten fylldes inte' }; await new Promise(r => setTimeout(r, 50)); }
    const to = v.currentTime + 10.5; v.currentTime = to;
    const f = await window.__frame(t => t >= to - 0.5 && t < to + 6);
    return { to, f, mv: f.ms == null ? null : await window.__moves(2000), modes: window.__modes, t: v.currentTime };
  });
  assert.ok(!s.error, s.error);
  assert.ok(s.f.ms != null, `spolning i bufferten till ${s.to?.toFixed(1)} s gav ingen bild där: ${s.f.state}`);
  assert.ok(s.mv.frames >= 2 * FPS * 0.8 && !s.mv.paused, `bilden rör sig efter spolningen (${s.mv.frames} bildrutor)`);
  assert.ok(s.t > s.to, `filmen fortsätter efter ${s.to.toFixed(1)} s (står på ${s.t.toFixed(1)})`);
  assert.deepEqual(s.modes, ['remux'], 'bilden kopieras hela tiden – ingen omkodning behövdes');
  // Spolning bakåt utanför bufferten (servern börjar om där): bild direkt, utan fel
  const b = await p.evaluate(async () => { const v = document.querySelector('#vid'), e0 = window.__errors; v.currentTime = 9; const f = await window.__frame(t => t >= 8.5 && t < 15); return { f, errors: window.__errors - e0 }; });
  assert.ok(b.f.ms != null, `spolning bakåt till 9 s gav ingen bild: ${b.f.state}`);
  assert.equal(b.errors, 0, 'inget avkodningsfel vid spolning utanför bufferten');
  await close();
});

// Vilket läge servern väljer för webbspelaren (mse=1, som hls.js i Chrome) – väntar tills öppen GOP-provet efter
// indexeringen (server/opengop.js) har gett svaret want
async function webMode(id, want, max = 30000) {
  const t0 = Date.now(); let m;
  while (Date.now() - t0 < max) { m = (await srv.req(`/api/items/${id}/playback?info=1&mse=1&start=31`)).data.mode; if (m === want) break; await new Promise(r => setTimeout(r, 250)); }
  return m;
}

test('öppen GOP som Chrome inte kan börja avkoda mitt i: bilden omkodas i stället, på samma ställe', { skip }, async () => {
  const { p, close } = await page();
  await helpers(p);
  // Som en server som inte provat filen än (eller en fil där provet missade): utan mse=1 väljer servern remux,
  // och spelaren får klara felet själv
  await p.route(/\/api\/items\/\d+\/playback\?/, (r) => { const u = new URL(r.request().url()); u.searchParams.delete('mse'); r.continue({ url: String(u) }); });
  const r = await p.evaluate(async (id) => { window.__L.play(id, 31); const f = await window.__frame(t => t >= 30 && t < 40, 30000); return { f, mv: f.ms == null ? null : await window.__moves(2000), modes: window.__modes, label: document.querySelector('#pmode')?.textContent }; }, flat.id);
  assert.ok(r.f.ms != null, `fortsättning vid 31 s gav ingen bild: ${r.f.state}`);
  assert.deepEqual(r.modes, ['remux', 'transcode'], 'först remux, sedan omkodning när avkodningen inte gick');
  assert.ok(r.mv.frames >= 2 * FPS * 0.8 && !r.mv.paused, `bilden rör sig (${r.mv.frames} bildrutor)`);
  // Spolning i den omkodade strömmen fungerar, och samma titel startas omkodad direkt nästa gång under besöket
  const s = await p.evaluate(async (id) => {
    const v = document.querySelector('#vid'); v.currentTime = 12; const a = await window.__frame(t => t >= 11.5 && t < 18);
    window.__L.closeAllPlayers(); await new Promise(r => setTimeout(r, 800)); window.__modes = [];
    window.__L.play(id, 50); const b = await window.__frame(t => t >= 49 && t < 58, 30000);
    return { a, b, modes: window.__modes };
  }, flat.id);
  assert.ok(s.a.ms != null, `spolning till 12 s: ${s.a.state}`);
  assert.ok(s.b.ms != null, `ny start vid 50 s: ${s.b.state}`);
  assert.deepEqual(s.modes, ['transcode'], 'andra gången omkodas titeln från början');
  await close();
});

test('öppen GOP som Chrome inte kan börja avkoda mitt i: servern vet det och omkodar direkt, utan fel först', { skip }, async () => {
  assert.equal(await webMode(flat.id, 'transcode'), 'transcode', 'servern har provat filen');
  assert.equal(await webMode(film.id, 'remux', 1000), 'remux', 'öppen GOP där ra räcker remuxas');
  // Ny sida (inget minne från förra besöket i webbläsaren): fortsätt vid 31 s och spola
  const { p, close } = await page();
  await helpers(p);
  const r = await p.evaluate(async (id) => {
    const t0 = performance.now(); window.__L.play(id, 31); const f = await window.__frame(t => t >= 30 && t < 40, 30000);
    const v = document.querySelector('#vid'); v.currentTime = 12; const g = await window.__frame(t => t >= 11.5 && t < 18);
    return { f, g, ms: Math.round(performance.now() - t0), modes: window.__modes, errors: window.__errors, label: document.querySelector('#pmode')?.textContent, why: window.__V.P?.pb?.reasons };
  }, flat.id);
  assert.ok(r.f.ms != null, `fortsättning vid 31 s gav ingen bild: ${r.f.state}`);
  assert.ok(r.g.ms != null, `spolning till 12 s gav ingen bild: ${r.g.state}`);
  assert.deepEqual(r.modes, ['transcode'], 'omkodning från början – ingen remux som faller först');
  assert.equal(r.errors, 0, 'inget avkodningsfel');
  assert.match(r.why.join(', '), /öppen GOP/);
  await close();
});

test('öppen GOP som Chrome inte kan börja avkoda mitt i: start från början remuxas, spolning utanför bufferten byter till omkodning direkt', { skip }, async () => {
  assert.equal(await webMode(flat.id, 'transcode'), 'transcode', 'servern har provat filen');
  const { p, close } = await page();
  await helpers(p);
  const r = await p.evaluate(async (id) => {
    const t0 = performance.now(); window.__L.play(id, 0); const f = await window.__frame(t => t >= 0, 30000); const startMs = Math.round(performance.now() - t0);
    const v = document.querySelector('#vid'), gop = window.__V.P?.pb?.gop, m0 = [...window.__modes];
    // Spolning inom bufferten: inget byte
    while (!(v.buffered.length && v.buffered.end(0) > 3)) await new Promise(r => setTimeout(r, 20));
    v.currentTime = 1.5; const a = await window.__frame(t => t >= 1.2 && t < 6); const mA = [...window.__modes];
    // Spolning utanför bufferten (direkt, innan den hunnit fyllas dit)
    const bufEnd = v.buffered.end(v.buffered.length - 1); const to = 64;
    const e0 = window.__errors; v.currentTime = to; const b = await window.__frame(t => t >= to - 0.6 && t < to + 5, 30000);
    return { f, startMs, gop, m0, a, mA, bufEnd, to, b, modes: window.__modes, errors: window.__errors - e0 };
  }, flat.id);
  assert.ok(r.f.ms != null, `ingen bild vid start: ${r.f.state}`);
  assert.deepEqual(r.m0, ['remux'], 'från början: remux (snabbast)');
  assert.equal(r.gop, 'tc', 'svaret säger att filen inte går att börja mitt i');
  assert.ok(r.a.ms != null, `spolning inom bufferten: ${r.a.state}`);
  assert.deepEqual(r.mA, ['remux'], 'spolning inom bufferten byter inte');
  assert.ok(r.bufEnd < r.to - 1, `förutsättning: ${r.to} s ligger utanför bufferten (slut ${r.bufEnd.toFixed(1)})`);
  assert.ok(r.b.ms != null, `spolning till ${r.to} s gav ingen bild: ${r.b.state}`);
  assert.deepEqual(r.modes, ['remux', 'transcode'], 'omkodning vid spolningen');
  assert.equal(r.errors, 0, 'inget avkodningsfel – bytet kom före felet');
  await close();
});

test('öppen GOP: efter bytet till omkodning ger ett uttryckligt val av Original remux igen (servern avgör)', { skip }, async () => {
  assert.equal(await webMode(flat.id, 'transcode'), 'transcode', 'servern har provat filen');
  const { p, close } = await page();
  await helpers(p);
  const asks = [];
  p.on('request', (q) => { if (/\/api\/items\/\d+\/playback\?/.test(q.url()) && !/warm=1/.test(q.url())) asks.push(q.url()); });
  const r = await p.evaluate(async (id) => {
    window.__L.play(id, 0); const f = await window.__frame(t => t >= 0, 30000);
    const v = () => document.querySelector('#vid');
    while (!(v().buffered.length && v().buffered.end(0) > 3)) await new Promise(r => setTimeout(r, 20));
    // Spolning utanför bufferten: omkodning (forceTc)
    v().currentTime = 64; const b = await window.__frame(t => t >= 63.4 && t < 69, 30000); const mB = [...window.__modes];
    // Tillbaka till början i den omkodade strömmen och välj Original i kvalitetsmenyn
    v().currentTime = 0.2; const c = await window.__frame(t => t < 5, 30000);
    const pq = document.querySelector('#pq'); pq.value = 'orig'; pq.dispatchEvent(new Event('change'));
    const t0 = performance.now();
    while (window.__V.P?.pb?.mode !== 'remux' && performance.now() - t0 < 30000) await new Promise(r => setTimeout(r, 50));
    const d = await window.__frame(t => t < 8, 30000);
    return { f, b, mB, c, d, modes: window.__modes, label: document.querySelector('#pmode')?.textContent };
  }, flat.id);
  assert.ok(r.f.ms != null && r.b.ms != null && r.c.ms != null, `förutsättning: start, spolning och återgång gav bild (${r.f.state || ''} ${r.b.state || ''} ${r.c.state || ''})`);
  assert.deepEqual(r.mB, ['remux', 'transcode'], 'förutsättning: spolningen bytte till omkodning');
  const last = asks.at(-1) || '';
  assert.match(last, /[?&]q=orig/, 'valet av Original skickas: ' + last);
  assert.doesNotMatch(last, /force=transcode/, 'Original efter omkodningen tvingar inte omkodning: ' + last);
  assert.deepEqual(r.modes, ['remux', 'transcode', 'remux'], `Original från början av filen remuxas igen (${r.label})`);
  assert.ok(r.d.ms != null, `bild efter valet av Original: ${r.d.state}`);
  await close();
});

// Vad servern svarar webbspelaren om filens GOP (mse=1, start från början) – väntar på öppen GOP-provet
async function webGop(id, want, max = 30000) {
  const t0 = Date.now(); let g;
  while (Date.now() - t0 < max) { g = (await srv.req(`/api/items/${id}/playback?info=1&mse=1`)).data.gop; if (g === want) break; await new Promise(r => setTimeout(r, 250)); }
  return g;
}

// Spolning några sekunder inom bufferten: Chrome börjar avkoda om på nyckelbilden före målet, och i en fil med öppen
// GOP har den bilder som hänvisar till GOP:en innan (de tas bara bort i segment hämtade med ra=). Förut kom
// PIPELINE_ERROR_DECODE vid nästan varje sådan spolning – spelaren återhämtade sig (ra) eller bytte till omkodning
// efter felet (tc). Testen ovan räknade inte felen. Se guardSeeks i web/js/player/video.js.
test('öppen GOP: spolning inom bufferten ger inget avkodningsfel (ra hämtar om segmentet, tc kodar om direkt)', { skip }, async () => {
  assert.equal(await webGop(film.id, 'ra'), 'ra', 'servern har provat filen: öppen GOP där ra räcker');
  assert.equal(await webGop(flat.id, 'tc'), 'tc', 'servern har provat filen: öppen GOP som måste omkodas mitt i');
  const run = async (id, steps) => {
    const { p, close } = await page();
    await helpers(p);
    const r = await p.evaluate(async ([id, steps]) => {
      window.__L.play(id, 0); const f0 = await window.__frame(t => t >= 0, 30000);
      if (f0.ms == null) return { error: 'ingen bild vid start: ' + f0.state };
      const v = document.querySelector('#vid'), sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const inBuf = (t) => { for (let i = 0; i < v.buffered.length; i++) if (t >= v.buffered.start(i) && t < v.buffered.end(i) - 0.5) return true; return false; };
      const out = [];
      for (const rel of steps) {
        const w = performance.now();
        while (!(v.currentTime > 2 && inBuf(v.currentTime + Math.max(rel, 0) + 2)) && performance.now() - w < 20000) await sleep(50);
        const to = v.currentTime + rel, buffered = inBuf(to), e0 = window.__errors, t0 = performance.now();
        v.currentTime = to;
        const f = await window.__frame(t => t >= to - 0.6 && t < to + 6);
        out.push({ to: +to.toFixed(1), buffered, ms: f.ms == null ? null : Math.round(performance.now() - t0), state: f.state, errors: window.__errors - e0 });
      }
      const mv = await window.__moves(1500);
      return { out, mv, errors: window.__errors, errlog: window.__errlog, modes: window.__modes };
    }, [id, steps]);
    await close();
    assert.ok(!r.error, r.error);
    for (const s of r.out) {
      assert.ok(s.ms != null, `spolning till ${s.to} s gav ingen bild där: ${s.state}`);
      assert.ok(s.buffered, `förutsättning: ${s.to} s låg i bufferten`);
    }
    assert.equal(r.errors, 0, `avkodningsfel vid spolning inom bufferten: ${r.errlog.join('; ')} (${r.out.map(s => `${s.to} s: ${s.errors}`).join(', ')})`);
    assert.ok(r.mv.frames >= 1.5 * FPS * 0.8 && !r.mv.paused, `bilden rör sig efteråt (${r.mv.frames} bildrutor)`);
    return r;
  };
  // ra: framåt två gånger, bakåt och framåt igen – bilden kopieras hela tiden
  const a = await run(film.id, [8, 8, -5, 8]);
  assert.deepEqual(a.modes, ['remux'], 'ingen omkodning behövdes');
  // tc: spolning förbi filens första GOP byter till omkodning innan Chrome hinner avkoda något
  const b = await run(flat.id, [8]);
  assert.deepEqual(b.modes, ['remux', 'transcode'], 'omkodning vid spolningen');
});

// Förut hämtade play() titelns uppgifter först och skickade /playback 40–150 ms efter klicket. Nu går frågorna samtidigt:
// servern startar strömmen medan spelaren väntar på uppgifterna. Titelns svar fördröjs här så att ordningen syns.
test('/playback skickas innan titelns uppgifter har kommit, och svaret används (ingen andra fråga)', { skip }, async () => {
  const { p, close } = await page();
  await helpers(p);
  const log = [];
  const t = () => Date.now();
  p.on('request', (q) => { const u = q.url(); if (/\/playback\?/.test(u) && !/warm=1/.test(u)) log.push({ pb: t(), url: u }); });
  await p.route(new RegExp(`/api/items/${lang.id}(\\?|$)`), async (r) => { await new Promise(x => setTimeout(x, 600)); log.push({ items: t() }); r.continue(); });
  const r = await p.evaluate(async (id) => { window.__L.play(id, 0); const f = await window.__frame(x => x >= 0, 30000); return { f, mode: window.__V.P?.pb?.mode, audio: window.__V.P?.audio, url: window.__V.P?.pb?.url }; }, lang.id);
  assert.ok(r.f.ms != null, `ingen bild: ${r.f.state}`);
  const pbs = log.filter(x => x.pb), items = log.find(x => x.items);
  assert.equal(pbs.length, 1, 'en enda fråga till /playback: ' + pbs.map(x => x.url).join(' | '));
  assert.ok(pbs[0].pb < items.items, `/playback skickades ${items.items - pbs[0].pb} ms innan titelns uppgifter kom`);
  assert.doesNotMatch(pbs[0].url, /[?&]audio=/, 'ljudspåret väljer servern (samma förval som titelns uppgifter)');
  const a = new URL(r.url, srv.base).searchParams.get('audio');
  if (a != null) assert.equal(a, String(r.audio), 'spåret i strömmen är spelarens förval');
  await close();
  // Förvärmningen tar fortfarande över: warm=1 före klicket, sedan play() – samma ström (pid)
  const b = await page();
  await helpers(b.p);
  // Förvärmningen väntar medan en annan omkodning spelas: stoppa de tidigare testernas strömmar (som /stop)
  for (const x of [film, flat, lang]) await srv.req(`/api/stream/${x.id}/stop`, { method: 'POST' });
  const warmed = () => (fs.readFileSync(srv.logFile, 'utf8').match(/Tio Bitar: första segmentet klart .*\(förvärmd\)/g) || []).length;
  const w0 = warmed();
  const warm = await b.p.evaluate(async (id) => {
    window.__V.warmPlay(id, 0, { movie: true });
    await new Promise(x => setTimeout(x, 800));
    window.__L.play(id, 0); const f = await window.__frame(x => x >= 0, 30000);
    return { f };
  }, ten.id);
  assert.ok(warm.f.ms != null, `ingen bild efter förvärmningen: ${warm.f.state}`);
  await new Promise(x => setTimeout(x, 300));
  assert.equal(warmed(), w0 + 1, 'uppspelningen tog över den förvärmda strömmen');
  await b.close();
});

// Spolning utanför bufferten i en omkodning: förut hämtade hls.js 6 s-segmentet med målet i samma ström, och servern
// kodade hela segmentet innan något visades. Nu laddar spelaren om strömmen från målet: korta segment där (hs), och
// servern stoppar den gamla strömmen (prev).
test('omkodning: spolning utanför bufferten startar en ny ström med korta segment vid målet', { skip }, async () => {
  const { p, close } = await page();
  await helpers(p);
  // Tidslinjen var 50:e ms: fyllnaden (#tfill), skärmläsarens värde (aria-valuenow) och tidstexten (#ctime), i sekunder.
  // restartMs = tills videon har data igen efter att den kopplats om; waits = väntetexter som visades
  await p.evaluate(() => { window.__timeline = () => {
    const min = { fill: Infinity, aria: Infinity, text: Infinity }, log = [], waits = [], t0 = performance.now();
    let n = 0, low = false, restartMs = null;
    const secs = (s) => { const m = /^(?:(\d+):)?(\d+):(\d\d)/.exec(s || ''); return m ? (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] : null; };
    const id = setInterval(() => {
      const P = window.__V.P, v = document.querySelector('#vid'); if (!P || !v) return;
      const d = P.it.duration, ms = Math.round(performance.now() - t0);
      const fill = parseFloat(document.querySelector('#tfill').style.width) / 100 * d, aria = +document.querySelector('#scrub').getAttribute('aria-valuenow');
      const txt = document.querySelector('#ctime').textContent, text = secs(txt);
      if (v.readyState < 2) low = true; else if (low && restartMs == null && v.readyState >= 3) restartMs = ms;
      n++; min.fill = Math.min(min.fill, fill); min.aria = Math.min(min.aria, aria); min.text = Math.min(min.text, text ?? -1);
      if (/Förbereder|Laddar|Startar|Preparing|Loading|Starting/.test(txt) && waits.at(-1)?.txt !== txt) waits.push({ ms, txt });
      if (log.length < 80) log.push(`${ms}ms ${fill.toFixed(1)}/${aria}/${txt}`);
    }, 50);
    return { stop: () => { clearInterval(id); return { n, min, log, waits, restartMs }; } };
  }; });
  const reqs = [];
  p.on('request', (q) => { const u = q.url(); if (/\/playback\?|\/seg-\d+\.ts/.test(u) && !/warm=1/.test(u)) reqs.push(u); });
  // Kvalitetsbytet (360p) får en långsam server: 2,5 s innan /playback svarar – då ska "Förbereder…" synas, men först efter 1,5 s
  await p.route(/\/playback\?.*[?&]q=360(&|$)/, async (rt) => { await new Promise(x => setTimeout(x, 2500)); rt.continue().catch(() => {}); });
  const r = await p.evaluate(async (id) => {
    window.__L.play(id, 0); const f = await window.__frame(x => x >= 0, 30000);
    const v = document.querySelector('#vid'), pb0 = window.__V.P.pb.url;
    // Första bilden kan visas innan videons loadeddata/playing har kommit, och spelaren startar inte om strömmen för
    // en spolning innan filmen har börjat (hls.js egna hopp): vänta tills den spelar
    const w0 = performance.now(); while (!(v.currentTime > 0.5 && !v.paused) && performance.now() - w0 < 15000) await new Promise(x => setTimeout(x, 50));
    const b = []; for (let i = 0; i < v.buffered.length; i++) b.push([v.buffered.start(i), v.buffered.end(i)]);
    const to = 150, n0 = window.__reqs?.length;
    const t0 = performance.now(); const tl = window.__timeline(); v.currentTime = to;
    const g = await window.__frame(x => x >= to - 0.6 && x < to + 6, 30000);
    const ms = Math.round(performance.now() - t0);
    await new Promise(x => setTimeout(x, 500)); const seekLine = tl.stop();
    const mv = g.ms == null ? null : await window.__moves(1500);
    // Spolning inom bufferten därefter: ingen ny ström
    const pb1 = window.__V.P.pb.url;
    const w = performance.now(); while (!(v.buffered.length && v.buffered.end(v.buffered.length - 1) > v.currentTime + 4) && performance.now() - w < 15000) await new Promise(x => setTimeout(x, 50));
    v.currentTime = v.currentTime + 2; const h = await window.__frame(x => x >= to, 10000);
    const pb2 = window.__V.P.pb.url;
    // Byte av kvalitet laddar om strömmen på samma sätt (load() från positionen): tidslinjen står kvar där
    const qTo = v.currentTime, ql = window.__timeline(), pq = document.querySelector('#pq');
    pq.value = pq.options[pq.options.length - 1].value; pq.dispatchEvent(new Event('change'));
    const w2 = performance.now();
    while (!(window.__V.P.pb.url !== pb2 && !v.paused && v.readyState >= 3 && v.currentTime > qTo - 1) && performance.now() - w2 < 20000) await new Promise(x => setTimeout(x, 50));
    await new Promise(x => setTimeout(x, 300));
    return { f, g, h, ms, mv, b, to, n0, pb0, pb1, pb2, pb3: window.__V.P.pb.url, seekLine, qTo, qLine: ql.stop(), errors: window.__errors, errlog: window.__errlog, modes: window.__modes };
  }, ten.id);
  assert.ok(r.f.ms != null, `ingen bild vid start: ${r.f.state}`);
  assert.ok(!r.b.some(([a, b]) => r.to >= a && r.to < b), `förutsättning: ${r.to} s låg utanför bufferten (${JSON.stringify(r.b)})`);
  assert.ok(r.g.ms != null, `spolning till ${r.to} s gav ingen bild: ${r.g.state}`);
  assert.ok(r.mv.frames >= 1.5 * FPS * 0.8 && !r.mv.paused, `bilden rör sig efteråt (${r.mv.frames} bildrutor)`);
  assert.equal(r.errors, 0, r.errlog.join('; '));
  assert.deepEqual(r.modes, ['transcode']);
  const pid0 = new URL(r.pb0, srv.base).searchParams.get('pid'), u1 = new URL(r.pb1, srv.base);
  assert.equal(u1.searchParams.get('hs'), String(r.to), 'ny ström med korta segment vid målet: ' + r.pb1);
  assert.notEqual(u1.searchParams.get('pid'), pid0);
  const i = reqs.findIndex(u => /\/playback\?/.test(u) && /[?&]start=150(&|$)/.test(u));
  assert.ok(i > 0, 'ny fråga till /playback vid spolningen: ' + reqs.filter(u => /playback/.test(u)).join(' | '));
  assert.match(reqs[i], new RegExp(`[?&]prev=${pid0}(&|$)`), 'servern stoppar den gamla strömmen');
  const after = reqs.slice(i + 1).filter(u => /seg-/.test(u));
  assert.ok(after.length && after.every(u => !u.includes(`pid=${pid0}`)), 'inga segment från den gamla strömmen efter spolningen');
  // Första segmentet efter spolningen är 1 s långt (processorn) och börjar vid målet
  const idx = await srv.req(new URL(r.pb1.replace('master.m3u8', 'index.m3u8'), srv.base).href);
  const lines = idx.data.toString().split('\n'); let at = 0; const segs = [];
  for (let k = 0; k < lines.length; k++) { const m = /^#EXTINF:([\d.]+)/.exec(lines[k]); if (m) { segs.push({ start: at, dur: +m[1], n: +/seg-(\d+)/.exec(lines[k + 1])[1] }); at += +m[1]; } }
  const first = segs[+/seg-(\d+)/.exec(after[0])[1]];
  assert.ok(first && Math.abs(first.start - r.to) < 0.01 && Math.abs(first.dur - 1) < 0.01, `första segmentet efter spolningen: ${JSON.stringify(first)}`);
  assert.ok(r.h.ms != null, `spolning inom bufferten efteråt: ${r.h.state}`);
  assert.equal(r.pb2, r.pb1, 'spolning inom bufferten startar ingen ny ström');
  // Medan strömmen startas om står tidslinjen, tidstexten och skärmläsarens värde på målet (förut 0:00 och
  // "Förbereder…" i ungefär en sekund), och ingen väntetext syns när omstarten går fort (under 1,5 s)
  for (const [what, line, to, pb] of [['spolningen', r.seekLine, r.to, r.pb1], ['kvalitetsbytet', r.qLine, r.qTo, r.pb3]]) {
    assert.ok(line.n >= 8, `${what}: för få avläsningar (${line.n})`);
    for (const k of ['fill', 'aria', 'text']) assert.ok(line.min[k] >= to - 1, `${what}: ${k} gick ner till ${line.min[k]} s (mål ${to.toFixed(1)} s): ${line.log.join(' | ')}`);
    const early = line.waits.filter(w => w.ms < 1400);
    assert.deepEqual(early, [], `${what}: väntetext före 1,5 s (omstart på ${line.restartMs} ms)`);
    if (line.restartMs != null && line.restartMs < 1400) assert.deepEqual(line.waits, [], `${what}: väntetext trots omstart på ${line.restartMs} ms`);
  }
  // Den långsamma omstarten: "Förbereder…" efter målets tid
  assert.ok(r.qLine.restartMs > 2500, `förutsättning: kvalitetsbytet var långsamt (${r.qLine.restartMs} ms)`);
  assert.ok(r.qLine.waits.some(w => /^\d+:\d\d \/ 3:00 · (Förbereder|Preparing)…$/.test(w.txt)), `kvalitetsbytet: väntetexten ${JSON.stringify(r.qLine.waits)}`);
  assert.notEqual(r.pb3, r.pb2, 'kvalitetsbytet startade en ny ström');
  console.log(`spolning utanför bufferten i omkodningen: ${r.ms} ms till bild (tidslinjen lägst ${r.seekLine.min.fill.toFixed(1)} s, mål ${r.to} s); kvalitetsbyte: ${r.qLine.restartMs} ms, lägst ${r.qLine.min.fill.toFixed(1)} s (mål ${r.qTo.toFixed(1)} s), väntetext ${r.qLine.waits.map(w => w.ms + ' ms').join(', ')}`);
  await close();
});

// Safaris egen HLS (iPhone, iPad): spolning utanför bufferten i en omkodning startar om strömmen vid målet
// (player/nativeseek.js). Safari finns inte här – Chrome med Safaris användaragent använder samma väg i webbappen
// (nativeHls: Chrome svarar också ja på canPlayType för HLS, strömmen spelas i v.src). Chromes inbyggda HLS är inte
// Safaris: den bryr sig inte om EXT-X-START och buffrar på sitt sätt, så tiderna här säger inget om en iPhone.
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
test('Safaris egen HLS (Chrome med Safaris användaragent): spolning i en omkodning startar en ny ström vid målet', { skip }, async () => {
  const { p, close } = await page(SAFARI);
  await helpers(p);
  const reqs = [];
  p.on('request', (q) => { const u = q.url(); if (/\/playback\?|\/hls\/(ready|index\.m3u8)|\/seg-\d+\./.test(u) && !/warm=1/.test(u)) reqs.push(u); });
  const r = await p.evaluate(async (id) => {
    const native = (await import('/m/js/player/caps.js')).nativeHls();
    window.__L.play(id, 0); const f = await window.__frame(x => x >= 0, 30000);
    const v = document.querySelector('#vid'), pb0 = window.__V.P.pb.url, hls = !!window.__V.P.hls;
    const w0 = performance.now(); while (!(v.currentTime > 0.5 && !v.paused) && performance.now() - w0 < 15000) await new Promise(x => setTimeout(x, 50));
    const b = []; for (let i = 0; i < v.buffered.length; i++) b.push([v.buffered.start(i), v.buffered.end(i)]);
    const to = 150, t0 = performance.now(); v.currentTime = to;
    // Tidslinjen står på målet medan strömmen startas om (holdTime)
    await new Promise(x => setTimeout(x, 100)); const held = v.currentTime;
    const g = await window.__frame(x => x >= to - 0.6 && x < to + 6, 30000);
    const ms = Math.round(performance.now() - t0), mv = g.ms == null ? null : await window.__moves(1500);
    return { native, hls, f, g, b, to, held, ms, mv, pb0, pb1: window.__V.P.pb.url, errors: window.__errors, errlog: window.__errlog, modes: window.__modes, state: window.__state() };
  }, ten.id);
  assert.equal(r.native, true, 'förutsättning: webbappen använder webbläsarens egen HLS-spelare');
  assert.equal(r.hls, false, 'ingen hls.js');
  assert.ok(r.f.ms != null, `ingen bild vid start: ${r.f.state}`);
  assert.ok(!r.b.some(([a, b]) => r.to >= a && r.to < b), `förutsättning: ${r.to} s låg utanför bufferten (${JSON.stringify(r.b)})`);
  assert.deepEqual(r.modes, ['transcode']);
  const pid0 = new URL(r.pb0, srv.base).searchParams.get('pid'), u1 = new URL(r.pb1, srv.base);
  assert.ok(reqs.some(u => u.includes('/hls/index.m3u8') && u.includes(`pid=${pid0}`)), 'spelaren läste spellistans segment');
  assert.ok(reqs.some(u => u.includes('/hls/ready') && u.includes(`pid=${pid0}`)), 'spelaren frågade vad servern har klart');
  const i = reqs.findIndex(u => /\/playback\?/.test(u) && /[?&]start=150(&|$)/.test(u));
  assert.ok(i > 0, 'ny fråga till /playback vid spolningen: ' + reqs.filter(u => /playback/.test(u)).join(' | '));
  assert.match(reqs[i], new RegExp(`[?&]prev=${pid0}(&|$)`), 'servern stoppar den gamla strömmen');
  assert.match(reqs[i], /[?&]nhls=1(&|$)/);
  assert.equal(u1.searchParams.get('xs'), String(r.to), 'den nya strömmen börjar vid målet (EXT-X-START): ' + r.pb1);
  assert.equal(u1.searchParams.get('hs'), String(r.to), 'korta segment vid målet');
  assert.ok(Math.abs(r.held - r.to) < 1, `tidslinjen på målet under omstarten (${r.held})`);
  assert.ok(r.g.ms != null, `spolning till ${r.to} s gav ingen bild: ${r.g.state} (${r.state})`);
  assert.ok(r.mv.frames >= 1.5 * FPS * 0.8 && !r.mv.paused, `bilden rör sig efteråt (${r.mv.frames} bildrutor)`);
  // Chromes inbyggda HLS (inte Safaris) ger ibland DEMUXER_ERROR_COULD_NOT_PARSE när den gamla strömmen avbryts mitt i
  // ett segment, och spelaren återhämtar sig. Felen skrivs ut men fäller inte testet – det säger inget om Safari.
  console.log(`Safaris väg i Chrome: spolning till ${r.to} s gav bild efter ${r.ms} ms (Chromes inbyggda HLS, inte Safari)${r.errors ? '; fel i Chromes HLS: ' + r.errlog.join('; ') : ''}`);
  await close();
});

test('kvalitetsmenyn erbjuder inget över källans upplösning, och spåren heter som språket (spelaren, Chromecast, fjärrstyrning)', { skip }, async () => {
  const { p, close } = await page();
  const r = await p.evaluate(async ([small, mid]) => {
    const lazy = await import('/m/js/lazy.js'); const vm = await lazy.loadPlayer();
    const opts = (s) => [...document.querySelectorAll(s + ' option')].map(o => [o.value, o.textContent]);
    await lazy.play(small, 0); const q180 = opts('#pq').map(o => o[0]), pa = opts('#pa').map(o => o[1]), ps = opts('#ps').map(o => o[1]);
    // Fjärrstyrningens läge och Chromecasts MediaInfo (Cast-SDK:t finns inte här – bara de delar videoMedia använder)
    const remote = (await import('/m/js/player/remote.js')).snapshot();
    const K = class { constructor(...a) { this.a = a; } };
    window.chrome = { ...window.chrome, cast: { Image: K, media: { MediaInfo: K, GenericMediaMetadata: K, Track: K, StreamType: {}, HlsSegmentFormat: {}, HlsVideoSegmentFormat: {}, TrackType: {}, TextTrackType: {} } } };
    const cast = await (await import('/m/js/player/cast.js')).videoMedia(vm.P.it, { audio: '' });
    lazy.closeAllPlayers(); await new Promise(r => setTimeout(r, 500));
    await lazy.play(mid, 0); const q360 = opts('#pq').map(o => o[0]);
    lazy.closeAllPlayers();
    return { ui: document.documentElement.lang, q180, q360, pa, ps, remote: { a: remote.audios.map(x => x.label), s: remote.subs.map(x => x.label) }, cast: { a: cast.info.customData.audios.map(x => x.l), s: cast.info.customData.subs.map(x => x.l), tracks: cast.info.tracks.map(x => x.name) } };
  }, [lang.id, film.id]);
  // 180p: bara Auto och Original. 360p: även 360p – men inte 480p, 720p eller 1080p
  assert.deepEqual(r.q180, ['auto', 'orig']);
  assert.deepEqual(r.q360, ['auto', 'orig', '360']);
  // Ljudspåren: språkets namn i stället för koden (swe/eng), på gränssnittets språk (profilens val – svenska eller engelska)
  const [sv, en, sub] = r.ui === 'en' ? ['Swedish', 'English', 'Swedish (file)'] : ['Svenska', 'Engelska', 'Svenska (fil)'];
  assert.equal(r.pa[0], `${sv} · ac3 · 2ch`);
  assert.ok(r.pa[1].startsWith(en + ' · '), r.pa[1]);
  assert.ok(r.ps.includes(sub), r.ps.join(' | '));
  for (const [where, x] of [['fjärrstyrningen', r.remote], ['Chromecast', r.cast]]) {
    assert.deepEqual(x.a.map(l => l.split(' · ')[0]), [sv, en], `${where}: ljud ${x.a.join(' | ')}`);
    assert.deepEqual(x.s, [sub], `${where}: undertexter`);
  }
  assert.deepEqual(r.cast.tracks, [sub], 'Chromecasts undertextspår');
  // Titelsidan: ljudet med språkets namn
  // Ny sidladdning: med spelaren öppen ändrar en ren hash-navigering sidan, och när spelaren stängs går den ett steg
  // bakåt i historiken – då hamnade testet på startsidan
  await p.goto('about:blank');
  // Webbappen kan själv byta adress precis efter laddningen (spelaren som stängs går bakåt) – försök då igen
  for (let i = 0; ; i++) {
    try { await p.goto(`${srv.base}/#/item/${lang.id}`); if (p.url().endsWith(`/#/item/${lang.id}`)) break; }
    catch (e) { if (i >= 2 || !/interrupted by another navigation/.test(e.message)) throw e; }
    if (i >= 2) break;
  }
  // Titelsidan kan vara långsam när hela sviten körs. Faller det: visa vad sidan visade, så att orsaken syns i loggen
  try { await p.waitForSelector(`text=${sv} · ac3`, { timeout: 60000 }); } catch (e) {
    const d = await p.evaluate(() => ({ hash: location.hash, player: document.querySelector('#player') ? getComputedStyle(document.querySelector('#player')).display : null, main: (document.querySelector('main')?.innerText || '').slice(0, 600) })).catch(() => null);
    e.message += '\nSidan: ' + JSON.stringify(d); throw e;
  }
  assert.doesNotMatch(await p.textContent('main'), /\bswe\b/);
  await close();
});
