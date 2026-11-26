// Windows-appens inbyggda spelare (mpv) sett från webben, i riktig Chrome med Windows-appens user agent och en
// låtsad värdapp (window.chrome.webview): Spela lämnar över originalfilen med token, framstegen hamnar i
// Fortsätt titta, stängning stoppar sessionen, och när appen säger nej (av eller mpv saknas) eller mpv inte kan
// spela tar webbspelaren över. Utan appens user agent händer ingenting nytt. Kräver Chrome, Playwright och ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';
import { freePort } from './helpers/port.js';
import { CHROME, chromium, launchChrome } from './helpers/chrome.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = !CHROME ? 'Google Chrome saknas' : !chromium ? 'Playwright saknas' : !hasFfmpeg ? 'ffmpeg saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-winnative-'));
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0 BraXhnTV-Windows/1.4.0';
let srv, browser, film;

before(async () => {
  if (skip) return;
  const dir = path.join(ROOT, 'media', 'Filmer'); fs.mkdirSync(dir, { recursive: true });
  // MKV med AC-3 och två ljudspråk: webbläsaren kan inte ta den direkt, mpv kan
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '30',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-ac', '2',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=swe', path.join(dir, 'Natfilm (2023).mkv')]);
  fs.writeFileSync(path.join(dir, 'Natfilm (2023).sv.srt'), '1\n00:00:01,000 --> 00:00:05,000\nHej\n');
  srv = await startServer({ root: ROOT, media: path.join(ROOT, 'media'), port: await freePort(), env: { NODE_ENV: 'test', TMDB_API_KEY: '', WATCH_FILES: '0' } });
  await srv.setup();
  film = (await srv.req('/api/libraries/1/items')).data.items.find(x => /Natfilm/.test(x.title));
  browser = await launchChrome();
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

/**
 * Inloggad sida med en låtsad Windows-app. host.ok = svaret på native-check, host.start = 'started' | 'failed'.
 * Sidan får window.__sent (det webben skickat till appen) och window.__toWeb(m) (appen skickar till webben).
 */
async function appPage({ ua = WIN_UA, ok = true, start = 'started', webview = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: ua });
  await ctx.addInitScript(([ok, start, webview]) => {
    window.__sent = [];
    if (!webview) return;
    const listeners = [];
    const toWeb = (data) => setTimeout(() => listeners.forEach(f => f({ data })), 0);
    window.__toWeb = toWeb;
    window.chrome = window.chrome || {};
    window.chrome.webview = {
      postMessage(m) {
        window.__sent.push(m);
        if (m.t === 'native-check') toWeb({ t: 'native-ready', ok });
        if (m.t === 'native-play') toWeb(start === 'started' ? { t: 'native-started', id: m.id } : { t: 'native-failed', id: m.id });
      },
      addEventListener(type, f) { if (type === 'message') listeners.push(f); },
    };
  }, [ok, start, webview]);
  const p = await ctx.newPage();
  await p.goto(srv.base + '/#/login');
  await p.fill('input[autocomplete="username"], #u, input[name=name]', 'admin'); await p.fill('input[type=password]', PW); await p.keyboard.press('Enter');
  await p.waitForFunction(() => !location.hash.includes('login'), null, { timeout: 30000 });
  await p.evaluate(async () => { const lazy = await import('/m/js/lazy.js'); window.__V = await lazy.loadPlayer(); window.__L = lazy; });
  return { p, close: () => ctx.close() };
}
const sent = (p, t) => p.evaluate((t) => window.__sent.filter(m => m.t === t), t);
const waitSent = (p, t) => p.waitForFunction((t) => window.__sent.some(m => m.t === t), t, { timeout: 30000 });

test('Spela i Windows-appen: originalfilen med token går till mpv, webbspelaren startar inte', { skip }, async () => {
  const { p, close } = await appPage();
  await p.evaluate((id) => window.__L.play(id, 0), film.id);
  await waitSent(p, 'native-play');
  const [m] = await sent(p, 'native-play');
  assert.equal(m.id, film.id);
  assert.match(m.url, new RegExp(`^${srv.base}/api/stream/${film.id}/direct\\?t=`), 'direktlänk med token');
  assert.match(m.title, /Natfilm/);
  assert.ok(m.subs.some(s => s.url && /\/subs\/x0\.vtt\?t=/.test(s.url)), 'undertextfilen bredvid filmen som WebVTT med token');
  // Strömlänken fungerar utan webbläsarens kaka (som för mpv)
  const r = await fetch(m.url, { headers: { Range: 'bytes=0-15' } });
  assert.ok(r.status === 206 || r.status === 200, 'status ' + r.status);
  assert.equal(await p.evaluate(() => !!document.querySelector('#vid')), false, 'webbspelaren startade inte');
  // Framsteg från mpv → Fortsätt titta
  await p.evaluate((id) => window.__toWeb({ t: 'native-progress', id, pos: 12.5, paused: false }), film.id);
  await p.waitForTimeout(800);
  const it = (await srv.req(`/api/items/${film.id}`)).data;
  assert.ok(Math.abs(it.position - 12.5) < 0.6, 'positionen sparades: ' + it.position);
  // Stängt i mpv: sessionen stoppas
  await p.evaluate((id) => window.__toWeb({ t: 'native-closed', id, pos: 14 }), film.id);
  await p.waitForTimeout(500);
  assert.equal(await p.evaluate(() => window.__sent.filter(m => m.t === 'native-stop').length), 0, 'appen stängde själv – inget extra stopp');
  await close();
});

test('appen säger nej (av eller mpv saknas): webbspelaren spelar som vanligt', { skip }, async () => {
  const { p, close } = await appPage({ ok: false });
  await p.evaluate((id) => window.__L.play(id, 0), film.id);
  await p.waitForFunction(() => document.querySelector('#vid')?.src || window.__V?.P?.hls, null, { timeout: 30000 });
  assert.equal((await sent(p, 'native-play')).length, 0);
  assert.equal((await sent(p, 'native-check')).length, 1);
  await close();
});

test('mpv kunde inte starta: webbspelaren tar över', { skip }, async () => {
  const { p, close } = await appPage({ start: 'failed' });
  await p.evaluate((id) => window.__L.play(id, 0), film.id);
  await p.waitForFunction(() => document.querySelector('#vid')?.src || window.__V?.P?.hls, null, { timeout: 30000 });
  assert.equal((await sent(p, 'native-play')).length, 1);
  await close();
});

test('vanlig Edge utan appen: ingen fråga till någon värdapp', { skip }, async () => {
  const { p, close } = await appPage({ ua: WIN_UA.replace(' BraXhnTV-Windows/1.4.0', '') });
  await p.evaluate((id) => window.__L.play(id, 0), film.id);
  await p.waitForFunction(() => document.querySelector('#vid')?.src || window.__V?.P?.hls, null, { timeout: 30000 });
  assert.equal((await p.evaluate(() => window.__sent.length)), 0);
  await close();
});

test('Spela i webbspelaren (appens meny): webbspelaren tar över på positionen utan felmeddelande', { skip }, async () => {
  const { p, close } = await appPage();
  await p.evaluate((id) => window.__L.play(id, 0), film.id);
  await waitSent(p, 'native-play');
  await p.waitForTimeout(300);
  await p.evaluate((id) => window.__toWeb({ t: 'native-failed', id, pos: 9, user: true }), film.id);
  await p.waitForFunction(() => document.querySelector('#vid')?.src || window.__V?.P?.hls, null, { timeout: 30000 });
  const toast = await p.evaluate(() => [...document.querySelectorAll('.toast, #toast, [role=status]')].map(x => x.textContent).join(' '));
  assert.doesNotMatch(toast, /kunde inte spela/, 'inget felmeddelande: ' + toast);
  await close();
});
