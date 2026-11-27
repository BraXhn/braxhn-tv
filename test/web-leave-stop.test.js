// Fliken eller webbläsaren stängs mitt i en omkodad film: webbspelaren stoppar sin egen ström vid pagehide
// (sendBeacon till /api/stream/:id/stop?pid=), så att ffmpeg försvinner direkt i stället för att koda vidare tills
// städningen efter 60 s. Läggs sidan bara undan i bfcache (pagehide med persisted) lever strömmen kvar och spelar
// vidare när man går tillbaka. Omladdningen prövas med service workern aktiv: där försvann stoppet ofta på vägen
// (web/sw.js låter därför ändrande anrop gå direkt till nätet). Riktig Chrome (H.264); hoppas över utan Chrome,
// Playwright, ffmpeg eller /proc.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer } from './media/server.mjs';
import { freePort } from './helpers/port.js';
import { CHROME, chromium, loginPage, installProbes } from './helpers/chrome.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = !CHROME ? 'Google Chrome saknas' : !chromium ? 'Playwright saknas' : !hasFfmpeg ? 'ffmpeg saknas'
  : !fs.existsSync('/proc/self/stat') ? '/proc saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-leave-'));
let srv, browser, film;

before(async () => {
  if (skip) return;
  const dir = path.join(ROOT, 'media', 'Filmer'); fs.mkdirSync(dir, { recursive: true });
  // H.264 i 10 bitar kodas alltid om för webbläsaren
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '240',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', '-ac', '2', path.join(dir, 'Tio Bitar (2023).mkv')]);
  srv = await startServer({ root: ROOT, media: path.join(ROOT, 'media'), port: await freePort(), env: { NODE_ENV: 'test', TMDB_API_KEY: '', WATCH_FILES: '0', HWACCEL: 'none' } });
  await srv.setup();
  film = (await srv.req('/api/libraries/1/items')).data.items.find(x => /Tio Bitar/.test(x.title));
  // Playwright stänger av bfcache som standard – här ska den finnas, som i en vanlig Chrome
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'], ignoreDefaultArgs: ['--disable-back-forward-cache'] });
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

/** Serverns ffmpeg-processer som skriver strömsegment (seg_%05d) – inte analyser och prov */
function segmenters() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8'), ppid = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
      if (ppid !== srv.proc.pid) continue;
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (/ffmpeg/.test(cmd) && cmd.includes('seg_%05d')) out.push(+d);
    } catch {}
  }
  return out;
}
const waitFor = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return Date.now() - t0; await new Promise(r => setTimeout(r, 100)); } return null; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Ny sida som spelar filmen omkodad och visar bild */
async function playing() {
  const pg = await loginPage(browser, srv.base);
  await installProbes(pg.p);
  const r = await pg.p.evaluate(async (id) => { window.__L.play(id, 0); const f = await window.__frame(t => t > 0.5, 40000); return { f, mode: window.__V.P?.pb?.mode }; }, film.id);
  assert.ok(r.f.ms != null, `filmen startade inte: ${r.f.state}`);
  assert.equal(r.mode, 'transcode', 'förutsättning: filmen kodas om');
  assert.ok(segmenters().length >= 1, 'förutsättning: ffmpeg kodar');
  return pg;
}

test('fliken stängs mitt i en omkodning: ffmpeg stoppas inom några sekunder', { skip }, async () => {
  const pg = await playing();
  // Som när användaren stänger fliken (runBeforeUnload: sidan avslutas på vanligt sätt, med pagehide)
  const pids = segmenters();
  await pg.p.close({ runBeforeUnload: true });
  const ms = await waitFor(() => segmenters().length === 0, 8000);
  assert.ok(ms != null, `ffmpeg kodar fortfarande 8 s efter att fliken stängdes (pid ${segmenters()}, före ${pids})`);
  await pg.close();
});

test('sidan laddas om (service workern styr sidan): den gamla strömmen stoppas', { skip }, async () => {
  const pg = await playing();
  const sw = await pg.p.evaluate(async () => { await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(r, 10000))]);
    for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 100));
    return !!navigator.serviceWorker.controller; });
  assert.ok(sw, 'förutsättning: service workern styr sidan');
  // Omladdning läggs aldrig i bfcache – sidan avslutas (och spelar inget efteråt)
  const pids = segmenters();
  await pg.p.reload();
  const ms = await waitFor(() => segmenters().length === 0, 8000);
  assert.ok(ms != null, `ffmpeg kodar fortfarande 8 s efter omladdningen (pid ${segmenters()}, före ${pids})`);
  await pg.close();
});

test('sidan läggs i bfcache: strömmen lever kvar och spelar vidare efter Tillbaka', { skip }, async (t) => {
  const pg = await playing();
  await pg.p.evaluate(() => { window.__hid = []; addEventListener('pagehide', (e) => window.__hid.push(e.persisted)); });
  const before = segmenters();
  // En annan webbplats och tillbaka (Chrome återställer sidan ur bfcache utan load-händelse)
  await pg.p.goto('about:blank');
  await sleep(3000);
  const away = segmenters();
  await pg.p.goBack({ waitUntil: 'commit' });
  await sleep(500);
  const hid = await pg.p.evaluate(() => window.__hid || null);
  if (!hid?.[0]) { t.skip(`Chrome lade inte sidan i bfcache här (pagehide: ${JSON.stringify(hid)})`); await pg.close(); return; }
  assert.deepEqual(away, before, 'samma ffmpeg finns kvar medan sidan ligger undan');
  const f = await pg.p.evaluate(async () => { const v = document.querySelector('#vid'); const c0 = v.currentTime; if (v.paused) await v.play().catch(() => {});
    await new Promise(r => setTimeout(r, 3000)); return { moved: v.currentTime - c0, state: window.__state() }; });
  assert.ok(f.moved > 1, `filmen spelar vidare efter Tillbaka (${f.state})`);
  await pg.close();
});
