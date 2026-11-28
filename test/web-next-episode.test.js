// Nästa avsnitt i riktig Chrome: när eftertexterna börjar (knappen Nästa avsnitt) och när kortet "Nästa avsnitt om …"
// visas förvärmer webbspelaren nästa avsnitt (/playback?warm=1), så att första segmentet är klart när bytet sker.
// Mäter tiden från klicket till första bilden i nästa avsnitt, för remux och omkodning, och kräver att uppspelningen
// tog över den förvärmda strömmen (serverns logg: "(förvärmd)"). Omkodningen förvärms trots att det egna avsnittet
// fortfarande kodas om – den strömmen är snart slut (server/stream.js warm).
// Hoppas över utan Google Chrome, Playwright eller ffmpeg (som web-chrome-playback.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer } from './media/server.mjs';
import { freePort } from './helpers/port.js';
import { CHROME, chromium, launchChrome, loginPage, installProbes } from './helpers/chrome.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = !CHROME ? 'Google Chrome saknas' : !chromium ? 'Playwright saknas' : !hasFfmpeg ? 'ffmpeg saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-next-'));
const LEN = 40, CREDITS = LEN - 12;
let srv, browser;
const eps = {};

before(async () => {
  if (skip) return;
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
  // Remux: H.264 8 bitar och AC-3 (bilden kopieras, ljudet konverteras). Omkodning: 720p i 10 bitar med brus, som
  // en riktig film där kodningen tar tid.
  const shows = {
    remux: ['Kopierad Serie', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', String(LEN),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'ac3']],
    transcode: ['Omkodad Serie', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24,noise=alls=8:allf=t', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', String(LEN),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', '-ac', '2']]
  };
  for (const [name, args] of Object.values(shows)) {
    const dir = path.join(ROOT, 'media', 'Serier', name, 'Season 1'); fs.mkdirSync(dir, { recursive: true });
    for (const e of [1, 2]) ff(...args, path.join(dir, `${name} S01E0${e}.mkv`));
  }
  fs.mkdirSync(path.join(ROOT, 'media', 'Filmer'), { recursive: true });
  // Samma tak för omkodningar som en vanlig server med fyra kärnor (startServer sätter annars 32)
  srv = await startServer({ root: ROOT, media: path.join(ROOT, 'media'), port: await freePort(),
    env: { NODE_ENV: 'test', TMDB_API_KEY: '', WATCH_FILES: '0', HWACCEL: 'none', MAX_TRANSCODES: '4', MAX_TRANSCODES_USER: '2' } });
  await srv.setup();
  const lib = await srv.req('/api/libraries', { method: 'POST', body: { name: 'Serier', type: 'show', path: path.join(ROOT, 'media', 'Serier') } });
  assert.equal(lib.status, 200, JSON.stringify(lib.data));
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 500));
    const s = (await srv.req('/api/scan')).data;
    if (!s.running && !s.analysis?.running && (await srv.req(`/api/libraries/${lib.data.id}/items`)).data.items?.length === 2) break;
  }
  for (const [mode, [name]] of Object.entries(shows)) {
    const show = (await srv.req(`/api/libraries/${lib.data.id}/items`)).data.items.find(x => x.title === name);
    const kids = (await srv.req(`/api/items/${show.id}`)).data.children;
    eps[mode] = kids.map(x => x.id);
    // Eftertexterna börjar 12 s före slutet (annars ger analysen dem)
    for (const id of eps[mode]) await srv.req(`/api/items/${id}/markers`, { method: 'PUT', body: { creditsStart: CREDITS } });
  }
  browser = await launchChrome();
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const warmedLines = () => (fs.readFileSync(srv.logFile, 'utf8').match(/första segmentet klart .*\(förvärmd\)/g) || []).length;
const stopAll = async () => { for (const m of Object.values(eps)) for (const id of m) await srv.req(`/api/stream/${id}/stop`, { method: 'POST' }); };

/**
 * Spelar första avsnittet nära slutet och byter till nästa. how = 'credits' (knappen Nästa avsnitt när eftertexterna
 * börjar), 'end' (Spela nu på kortet efter sista bilden) eller 'pnext' (pekaren på knappen Nästa avsnitt i
 * kontrollerna, sedan klick). Väntar wait ms efter att knappen/kortet visats. warm = false: förvärmningen stoppas i
 * webbläsaren (som före ändringen) – jämförelsen görs i samma körning, under samma last.
 * Ger tiden från klicket till första bilden i nästa avsnitt.
 */
async function next(mode, how, { warm = true, wait = 3000 } = {}) {
  await stopAll();
  const { p, close } = await loginPage(browser, srv.base);
  await installProbes(p);
  if (!warm) await p.route(/[?&]warm=1(&|$)/, r => r.abort());
  const w0 = warmedLines();
  const r = await p.evaluate(async ([a, b, how, wait, credits, len]) => {
    const sleep = (ms) => new Promise(x => setTimeout(x, ms));
    const until = async (f, max = 30000) => { const t0 = performance.now(); while (!f()) { if (performance.now() - t0 > max) return false; await sleep(20); } return true; };
    const start = how === 'end' ? len - 5 : credits - 2;
    window.__L.play(a, start);
    const f = await window.__frame(x => x >= start, 30000);
    if (f.ms == null) return { error: 'första avsnittet startade inte: ' + f.state };
    let btn;
    if (how === 'credits') {
      if (!await until(() => { const s = document.querySelector('#pskip'); return s && !s.hidden && s.dataset.k === 'credits'; })) return { error: 'ingen knapp vid eftertexterna' };
      btn = document.querySelector('#pskip');
    } else if (how === 'end') {
      if (!await until(() => document.querySelector('.next [data-go]'))) return { error: 'inget kort efter avsnittet: ' + window.__state() };
      btn = document.querySelector('.next [data-go]');
    } else {
      btn = document.querySelector('#pnext');
      // före eftertexterna, så att bara pekaren förvärmer
      btn.dispatchEvent(new PointerEvent('pointerenter'));
    }
    await sleep(wait);
    const t0 = performance.now();
    btn.click();
    const g = await window.__frame(() => window.__V.P?.it?.id === b, 30000);
    return { ms: g.ms == null ? null : Math.round(performance.now() - t0), state: g.state, mode: window.__V.P?.pb?.mode };
  }, [eps[mode][0], eps[mode][1], how, how === 'pnext' ? 1500 : wait, CREDITS, LEN]);
  await new Promise(x => setTimeout(x, 300));
  const warmed = warmedLines() - w0;
  await close();
  return { ...r, warmed };
}

// NEXT_RUNS=n: varje fall n gånger med och utan förvärmning, omväxlande (median i sammanfattningen)
const RUNS = Math.max(1, +process.env.NEXT_RUNS || 1);
const HOW = { credits: 'knappen vid eftertexterna', end: 'kortet efter avsnittet', pnext: 'pekaren på Nästa avsnitt' };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const results = [];
for (const mode of ['remux', 'transcode']) {
  for (const how of Object.keys(HOW)) {
    test(`nästa avsnitt (${mode}, ${HOW[how]}) är förvärmt när det startar`, { skip }, async (t) => {
      const on = [], off = [];
      for (let i = 0; i < RUNS; i++) {
        const c = await next(mode, how, { warm: false });
        assert.ok(!c.error && c.ms != null, `utan förvärmning: ${c.error || c.state}`);
        assert.equal(c.warmed, 0, 'förutsättning: utan förvärmning tas ingen förvärmd ström över');
        off.push(c.ms);
        const r = await next(mode, how);
        assert.ok(!r.error, r.error);
        assert.ok(r.ms != null, `ingen bild i nästa avsnitt: ${r.state}`);
        assert.equal(r.mode, mode, 'förutsättning: läget för nästa avsnitt');
        on.push(r.ms);
        assert.equal(r.warmed, 1, `uppspelningen tog över den förvärmda strömmen (${r.ms} ms)`);
      }
      results.push(`${mode}, ${HOW[how]}: utan förvärmning ${med(off)} ms [${off}], med ${med(on)} ms [${on}]`);
      t.diagnostic(results.at(-1));
    });
  }
}
test('sammanfattning (tid från klicket till första bilden i nästa avsnitt)', { skip }, (t) => { for (const x of results) t.diagnostic(x); });
