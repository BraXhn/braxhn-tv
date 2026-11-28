// Kortet i slutet av ett avsnitt i webbspelaren (onEnded i web/js/player/video.js) säger vilket avsnitt som kommer:
// namn, S1 · A2 och bild (nextEpisode i /api/items/:id, server/routes/library.js). Provas i datorbredd (1280×800) och
// telefonbredd (390×844), och med tangentbord/fjärrkontroll: Spela nu har fokus, pilarna flyttar fokus på kortet och
// Enter startar nästa avsnitt. Ett avsnitt sist i serien har inget kort.
// Hoppas över utan Google Chrome, Playwright eller ffmpeg. SHOTS=<mapp> sparar skärmbilder.
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-nextcard-'));
const LEN = 10;
const SHOTS = process.env.SHOTS || '';
let srv, browser, eps = [];

before(async () => {
  if (skip) return;
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
  const dir = path.join(ROOT, 'media', 'Serier', 'Kortserien', 'Season 1'); fs.mkdirSync(dir, { recursive: true });
  for (const e of [1, 2]) ff('-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=24`, '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', String(LEN),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', path.join(dir, `Kortserien S01E0${e}.mkv`));
  fs.mkdirSync(path.join(ROOT, 'media', 'Filmer'), { recursive: true });
  srv = await startServer({ root: ROOT, media: path.join(ROOT, 'media'), port: await freePort(), env: { NODE_ENV: 'test', TMDB_API_KEY: '', WATCH_FILES: '0', HWACCEL: 'none' } });
  await srv.setup();
  const lib = await srv.req('/api/libraries', { method: 'POST', body: { name: 'Serier', type: 'show', path: path.join(ROOT, 'media', 'Serier') } });
  assert.equal(lib.status, 200, JSON.stringify(lib.data));
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 500));
    const s = (await srv.req('/api/scan')).data;
    if (!s.running && !s.analysis?.running && (await srv.req(`/api/libraries/${lib.data.id}/items`)).data.items?.length === 1) break;
  }
  const show = (await srv.req(`/api/libraries/${lib.data.id}/items`)).data.items[0];
  eps = (await srv.req(`/api/items/${show.id}`)).data.children.map(x => x.id);
  assert.equal(eps.length, 2);
  // Egna namn på avsnitten (som från TMDB), och lång nedräkning så att kortet hinner provas
  assert.equal((await srv.req(`/api/items/${eps[0]}`, { method: 'PUT', body: { title: 'Början' } })).status, 200);
  assert.equal((await srv.req(`/api/items/${eps[1]}`, { method: 'PUT', body: { title: 'Fortsättningen' } })).status, 200);
  assert.equal((await srv.req('/api/me/playback-prefs', { method: 'PUT', body: { autoNext: true, nextCountdown: 60 } })).status, 200);
  browser = await launchChrome();
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('API: avsnittet säger namn, säsong, avsnitt och bild för nästa avsnitt', { skip }, async () => {
  const it = (await srv.req(`/api/items/${eps[0]}`)).data;
  assert.equal(it.nextId, eps[1]);
  assert.equal(it.nextEpisode?.id, eps[1], JSON.stringify(it.nextEpisode));
  assert.equal(it.nextEpisode.title, 'Fortsättningen');
  assert.equal(it.nextEpisode.season, 1); assert.equal(it.nextEpisode.episode, 2);
  assert.match(it.nextEpisode.image || '', /^\/api\/image\/\d+\/(thumb|backdrop|poster)$/);
  assert.equal((await srv.req(it.nextEpisode.image)).status, 200, 'bilden finns');
  const last = (await srv.req(`/api/items/${eps[1]}`)).data;
  assert.equal(last.nextId, null); assert.equal(last.nextEpisode ?? null, null, 'sista avsnittet har inget nästa');
});

for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`kortet i slutet visar nästa avsnitt (${vp.width}×${vp.height}), med fokus och pilar`, { skip }, async () => {
    const { p, close } = await loginPage(browser, srv.base, null, { viewport: vp, locale: 'sv-SE' });
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await installProbes(p);
    await p.evaluate(([id, start]) => window.__L.play(id, start), [eps[0], LEN - 3]);
    await p.waitForSelector('#player .next [data-go]', { timeout: 30000 });
    await p.waitForFunction(() => { const i = document.querySelector('#player .next img'); return !i || i.complete; }, null, { timeout: 10000 });
    const card = await p.evaluate(() => {
      const box = document.querySelector('#player .next'), r = box.getBoundingClientRect(), img = box.querySelector('img');
      const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight;
      const kids = [...box.querySelectorAll('*')].filter(x => x.offsetParent).map(x => x.getBoundingClientRect());
      return { text: box.innerText, img: img ? { src: img.getAttribute('src'), w: img.naturalWidth, shown: img.getBoundingClientRect().width } : null,
        inside: r.left >= 0 && r.top >= 0 && r.right <= W && r.bottom <= H, clipped: kids.some(k => k.right > r.right + 0.5 || k.left < r.left - 0.5),
        focus: document.activeElement?.hasAttribute('data-go'), opacity: getComputedStyle(box).opacity, rect: [r.left, r.top, r.width, r.height].map(Math.round) };
    });
    assert.match(card.text, /Fortsättningen/, 'nästa avsnitts namn: ' + card.text);
    assert.match(card.text, /S1 · A2/, 'säsong och avsnitt: ' + card.text);
    assert.match(card.text, /Nästa avsnitt om \d+ s/, 'nedräkningen finns kvar');
    assert.ok(card.img && card.img.w > 0 && card.img.shown > 40, 'bilden visas: ' + JSON.stringify(card.img));
    assert.ok(card.inside, `kortet ryms på skärmen: ${card.rect}`);
    assert.equal(card.clipped, false, 'inget i kortet sticker ut');
    assert.equal(card.opacity, '1');
    assert.equal(card.focus, true, 'Spela nu har fokus (fjärrkontroll/tangentbord)');
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `nasta-avsnitt-${vp.width}x${vp.height}.png`) }); }
    // Fjärrkontrollen: → till Avbryt, ← tillbaka, Enter startar nästa avsnitt
    await p.keyboard.press('ArrowRight');
    assert.equal(await p.evaluate(() => document.activeElement?.hasAttribute('data-stay')), true, '→ flyttar fokus till Avbryt');
    await p.keyboard.press('ArrowLeft');
    assert.equal(await p.evaluate(() => document.activeElement?.hasAttribute('data-go')), true, '← tillbaka till Spela nu');
    await p.keyboard.press('Enter');
    await p.waitForFunction((id) => window.__V.P?.it?.id === id, eps[1], { timeout: 30000 });
    // Sista avsnittet: inget kort
    await p.evaluate((len) => { const v = document.querySelector('#vid'); v.currentTime = len - 1.5; }, LEN);
    await p.waitForFunction(() => document.querySelector('#vid')?.ended || !window.__V.P, null, { timeout: 20000 });
    await new Promise(r => setTimeout(r, 500));
    assert.equal(await p.evaluate(() => !!document.querySelector('#player .next')), false, 'inget kort efter sista avsnittet');
    assert.deepEqual(errors, []);
    await close();
  });
}
