// Uppspelning i riktig Chrome (H.264): webbappen ska använda sin egen spelare (hls.js) där – inte Chromes inbyggda
// HLS-spelare, som numera svarar ja på canPlayType('application/vnd.apple.mpegurl') men tömmer bufferten och fryser
// bilden på remux av filer med öppen GOP (vanligt i riktiga filer). Testet spelar en sådan fil och räknar bildrutor.
// Hoppas över utan Google Chrome (Playwrights Chromium saknar H.264), Playwright eller ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';
import { freePort } from './helpers/port.js';

const CHROME = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].filter(Boolean).find(p => fs.existsSync(p));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
const require = createRequire(import.meta.url);
for (const p of [process.env.PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = p.startsWith('/') ? await import(p) : require(p)); if (chromium) break; } catch {}
}
const skip = !CHROME ? 'Google Chrome saknas' : !chromium ? 'Playwright saknas' : !hasFfmpeg ? 'ffmpeg saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-chrome-'));
const FPS = 24, SECS = 14;
let srv, browser, film, flat;

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
  srv = await startServer({ root: ROOT, media: path.join(ROOT, 'media'), port: await freePort(), env: { NODE_ENV: 'test', TMDB_API_KEY: '', WATCH_FILES: '0' } });
  await srv.setup();
  const items = (await srv.req('/api/libraries/1/items')).data.items;
  film = items.find(x => /Oppen/.test(x.title)); flat = items.find(x => /Pyramid/.test(x.title));
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

async function page(userAgent) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(userAgent ? { userAgent } : {}) });
  const p = await ctx.newPage();
  await p.goto(srv.base + '/#/login');
  await p.fill('input[autocomplete="username"], #u, input[name=name]', 'admin'); await p.fill('input[type=password]', PW); await p.keyboard.press('Enter');
  await p.waitForFunction(() => !location.hash.includes('login'), null, { timeout: 30000 });
  return { p, close: () => ctx.close() };
}

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

// Hjälp i sidan: __frame(pred, max) väntar på första nya bild som uppfyller pred(mediatid) – följer med om
// videoelementet byts – och ger { ms, at } eller { ms: null, läget }. __moves(ms) räknar bildrutor och speltid.
async function helpers(p) {
  await p.evaluate(async () => {
    const lazy = await import('/m/js/lazy.js'); window.__V = await lazy.loadPlayer(); window.__L = lazy;
    window.__errors = 0; window.__modes = [];
    const seen = new WeakSet();
    setInterval(() => {
      const v = document.querySelector('#vid'); if (v && !seen.has(v)) { seen.add(v); v.addEventListener('error', () => window.__errors++); }
      const m = window.__V.P?.pb?.mode; if (m && window.__modes.at(-1) !== m) window.__modes.push(m);
    }, 10);
    const state = () => { const v = document.querySelector('#vid'); if (!v) return 'ingen video';
      const b = []; for (let i = 0; i < v.buffered.length; i++) b.push(v.buffered.start(i).toFixed(1) + '–' + v.buffered.end(i).toFixed(1));
      return `tid ${v.currentTime.toFixed(1)}, ${v.paused ? 'pausad' : 'spelar'}, fel ${v.error?.code || 0} ${v.error?.message || ''}, buffert [${b}], läge ${window.__V.P?.pb?.mode}`; };
    window.__frame = (pred, max = 20000) => new Promise((ok) => {
      const t0 = performance.now(); let fin = false, cur = null;
      const lim = setTimeout(() => { fin = true; ok({ ms: null, state: state() }); }, max);
      const arm = () => { if (fin) return; const v = document.querySelector('#vid');
        if (v && v !== cur) { cur = v; const cb = (now, m) => { if (fin || v !== cur) return; if (pred(m.mediaTime)) { fin = true; clearTimeout(lim); ok({ ms: Math.round(performance.now() - t0), at: m.mediaTime }); } else v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); }
        setTimeout(arm, 20); };
      arm();
    });
    window.__moves = async (ms) => { const v = document.querySelector('#vid'); const q0 = v.getVideoPlaybackQuality().totalVideoFrames, c0 = v.currentTime; await new Promise(r => setTimeout(r, ms));
      return { frames: v.getVideoPlaybackQuality().totalVideoFrames - q0, played: v.currentTime - c0, same: document.querySelector('#vid') === v, paused: v.paused }; };
  });
}

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

test('öppen GOP som Chrome inte kan börja avkoda mitt i: bilden omkodas i stället, på samma ställe', { skip }, async () => {
  const { p, close } = await page();
  await helpers(p);
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
