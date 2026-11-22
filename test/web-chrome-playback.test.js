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
let srv, browser, film;

before(async () => {
  if (skip) return;
  const dir = path.join(ROOT, 'media', 'Filmer'); fs.mkdirSync(dir, { recursive: true });
  // Öppen GOP, B-bilder och AC-3 (ljudet konverteras): så ser många riktiga filer ut
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '70',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high', '-bf', '3', '-x264-params', 'keyint=96:min-keyint=24:open-gop=1', '-pix_fmt', 'yuv420p',
    '-c:a', 'ac3', path.join(dir, 'Oppen Film (2020).mkv')]);
  srv = await startServer({ root: ROOT, media: path.join(ROOT, 'media'), port: await freePort(), env: { NODE_ENV: 'test', TMDB_API_KEY: '', WATCH_FILES: '0' } });
  await srv.setup();
  film = (await srv.req('/api/libraries/1/items')).data.items[0];
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
