// Två enheter i familjen med samma profil tittar på samma film: den ena spelar filen direkt (/direct), den andra via
// HLS (omkodad). Stängs direktuppspelningen ska bara den stoppas – förut saknade /direct ett pid, webbspelaren skickade
// stoppet utan pid och servern stoppade alla profilens sessioner av titeln (även den andra enhetens ffmpeg). Apparna
// stoppar fortfarande utan pid: det stoppar den egna enhetens ström, men inte en ström som en annan enhet (annan
// adress) hämtat data från den senaste minuten. Enheterna skiljs åt med X-Forwarded-For (loopback räknas som proxy).
// Sist prövas webbspelaren i riktig Chrome: stoppet från closePlayer har pid och keepalive, och pagehide skickar
// stoppet även vid direktuppspelning. Hoppas över utan ffmpeg (Chrome-delen utan Chrome eller Playwright).
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
const skip = !hasFfmpeg ? 'ffmpeg saknas' : false;
const skipChrome = skip || (!CHROME ? 'Google Chrome saknas' : !chromium ? 'Playwright saknas' : false);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-directpid-'));
let srv, film;

before(async () => {
  if (skip) return;
  const dir = path.join(ROOT, 'media', 'Filmer'); fs.mkdirSync(dir, { recursive: true });
  // H.264 (8 bitar) och AAC i MP4: spelas direkt i en webbläsare, omkodas med force=transcode
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '300',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', path.join(dir, 'Samma Film (2024).mp4')]);
  srv = await startServer({ root: ROOT, media: path.join(ROOT, 'media'), port: await freePort(), env: { NODE_ENV: 'test', TMDB_API_KEY: '', WATCH_FILES: '0', HWACCEL: 'none' } });
  await srv.setup();
  film = (await srv.req('/api/libraries/1/items')).data.items.find(x => /Samma Film/.test(x.title));
});
after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const TV = '192.168.1.20', PHONE = '192.168.1.10';
const from = (ip) => ({ headers: { 'x-forwarded-for': ip } });
const pidOf = (url) => new URL(url, srv.base).searchParams.get('pid') || '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** TV:n spelar filmen omkodad (HLS) och har hämtat första segmentet – ffmpeg kodar */
async function hlsOnTv() {
  const pb = (await srv.req(`/api/items/${film.id}/playback?force=transcode`, from(TV))).data;
  assert.equal(pb.mode, 'transcode', 'förutsättning: TV:n får HLS');
  const master = (await srv.req(pb.url, from(TV))).data.toString();
  const idxUrl = new URL(master.split('\n').find(l => l && !l.startsWith('#')), srv.base + pb.url).href;
  const idx = (await srv.req(idxUrl, from(TV))).data.toString();
  const seg = new URL(idx.split('\n').find(l => l && !l.startsWith('#')), idxUrl).href;
  assert.equal((await srv.req(seg, from(TV))).status, 200, 'förutsättning: första segmentet');
  return pb;
}
const stats = async (pb) => (await srv.req(`/api/stream/${film.id}/stats?pid=${pidOf(pb.url)}`, from(TV))).data.session;
async function assertRunning(pb, msg) {
  await sleep(300);
  const s = await stats(pb);
  assert.ok(s && s.running, `${msg} (${JSON.stringify(s && { running: s.running, done: s.done })})`);
}
const stopAll = async (pb) => srv.req(`/api/stream/${film.id}/stop?pid=${pidOf(pb.url)}`, { method: 'POST', ...from(TV) });

test('direktuppspelning har ett eget pid i länken', { skip }, async () => {
  const pb = (await srv.req(`/api/items/${film.id}/playback`, from(PHONE))).data;
  assert.equal(pb.mode, 'direct', 'förutsättning: filmen spelas direkt');
  assert.match(pb.url, new RegExp(`^/api/stream/${film.id}/direct\\?pid=[0-9a-f]{8}$`));
  const pb2 = (await srv.req(`/api/items/${film.id}/playback`, from(PHONE))).data;
  assert.notEqual(pidOf(pb2.url), pidOf(pb.url), 'varje uppspelning har sitt eget pid');
  // Appens länk (token) har pid efter token; filen går att hämta med pid i adressen
  const tok = await srv.appToken();
  const ap = (await srv.req(`/api/items/${film.id}/playback`, { headers: { authorization: `Bearer ${tok}` }, auth: false })).data;
  assert.match(ap.url, /\/direct\?t=[^&]+&pid=[0-9a-f]{8}$/);
  const r = await srv.req(ap.url, { headers: { range: 'bytes=0-99' }, auth: false });
  assert.equal(r.status, 206);
});

test('webben: stängd direktuppspelning på telefonen stoppar inte samma profils HLS på TV:n', { skip }, async () => {
  const tv = await hlsOnTv();
  await assertRunning(tv, 'förutsättning: TV:ns ffmpeg kodar');
  const phone = (await srv.req(`/api/items/${film.id}/playback`, from(PHONE))).data;
  assert.equal(phone.mode, 'direct');
  assert.equal((await srv.req(phone.url, { ...from(PHONE), headers: { ...from(PHONE).headers, range: 'bytes=0-999' } })).status, 206);
  // Som closePlayer i web/js/player/video.js: pid ur strömlänken när den har ett
  const pid = pidOf(phone.url);
  await srv.req(`/api/stream/${film.id}/stop${pid ? '?pid=' + pid : ''}`, { method: 'POST', ...from(PHONE) });
  await assertRunning(tv, 'TV:ns omkodning lever kvar när telefonen stänger sin direktuppspelning');
  await stopAll(tv);
});

test('appen: stopp utan pid från en annan enhet rör inte en ström som TV:n just hämtar', { skip }, async () => {
  const tv = await hlsOnTv();
  await srv.req(`/api/stream/${film.id}/stop`, { method: 'POST', ...from(PHONE) });
  await assertRunning(tv, 'TV:ns omkodning lever kvar när telefonens app stoppar utan pid');
  await stopAll(tv);
});

test('appen: stopp utan pid från samma enhet stoppar fortfarande dess ström', { skip }, async () => {
  const tv = await hlsOnTv();
  await assertRunning(tv, 'förutsättning: ffmpeg kodar');
  await srv.req(`/api/stream/${film.id}/stop`, { method: 'POST', ...from(TV) });
  await sleep(300);
  const s = await stats(tv);
  assert.ok(s && !s.running, 'ffmpeg stoppas när enheten själv stoppar utan pid');
});

test('webbspelaren i Chrome: stoppet har pid och keepalive, och pagehide skickar det även vid direktuppspelning', { skip: skipChrome }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const pg = await loginPage(browser, srv.base);
    await installProbes(pg.p);
    const r = await pg.p.evaluate(async (id) => {
      window.__L.play(id, 0);
      const f = await window.__frame(t => t > 0.5, 40000);
      const log = window.__stops = [];
      const of = window.fetch;
      window.fetch = (u, o) => { if (String(u).includes('/stop')) log.push({ how: 'fetch', url: String(u), keepalive: !!o?.keepalive }); return of(u, o); };
      navigator.sendBeacon = (u) => { log.push({ how: 'beacon', url: String(u) }); return true; };
      const url = window.__V.P?.pb?.url;
      // Sidan stängs (inte bfcache): pagehide med persisted = false
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      window.__V.closePlayer(false);
      return { f, mode: window.__V.P?.pb?.mode ?? null, url, log };
    }, film.id);
    assert.ok(r.f.ms != null, `filmen startade inte: ${r.f.state}`);
    assert.match(r.url, /\/direct\?pid=[0-9a-f]{8}$/, 'förutsättning: direktuppspelning');
    const pid = pidOf(r.url);
    const beacon = r.log.find(x => x.how === 'beacon');
    assert.ok(beacon, `pagehide skickade inget stopp (${JSON.stringify(r.log)})`);
    assert.match(beacon.url, new RegExp(`/stop\\?pid=${pid}&gone=1$`));
    const close = r.log.find(x => x.how === 'fetch');
    assert.ok(close, `closePlayer skickade inget stopp (${JSON.stringify(r.log)})`);
    assert.match(close.url, new RegExp(`/stop\\?pid=${pid}$`));
    assert.equal(close.keepalive, true, 'stoppet från closePlayer skickas med keepalive');
    await pg.close();
  } finally { await browser.close(); }
});
