// Kvällsvalet i Chromium (Playwright): en dator (1280 px) och en telefon (375 px) – huvudkontot och en profil i hushållet. Den ena startar,
// den andra går med via QR-kodens länk (koden), värden börjar, båda sveper (med pekaren, knapparna och piltangenterna)
// och båda får samma match i realtid. Tillgänglighetsgranskningen körs i lobbyn, på kortet och på matchen, och
// Titta tillsammans syns för båda. Hoppas över om ffmpeg eller Playwright saknas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';
import { auditPage } from './helpers/a11y-audit.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let chromium = null;
for (const p of [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
const skip = !hasFfmpeg ? 'ffmpeg saknas' : !chromium ? 'Playwright saknas' : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-webtonight-'));
const MEDIA = path.join(ROOT, 'media');
const SHOTS = process.env.SHOTS || '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let srv, browser;
const ck = {};
const fmt = (list) => list.map(f => `  [${f.rule}] ${f.sel} – ${f.msg}`).join('\n');

before(async () => {
  if (skip) return;
  for (const [n, f] of [['Alfa', 300], ['Beta', 500], ['Gamma', 700], ['Delta', 900]]) {
    const d = path.join(MEDIA, 'Filmer', `${n} (2020)`); fs.mkdirSync(d, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=4', '-f', 'lavfi', '-i', `sine=frequency=${f}:duration=4`,
      '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', path.join(d, `${n} (2020).webm`)]);
  }
  srv = await startServer({ root: ROOT, media: MEDIA, env: { TMDB_API_KEY: '', WATCH_FILES: '0' } });
  await srv.setup();
  // Huvudkontot (kakan från setup) och en profil i hushållet med en egen inloggning
  ck.admin = /kt=([0-9a-f]+)/.exec((await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW } })).headers.get('set-cookie'))[1];
  const p = await srv.req('/api/profiles', { method: 'POST', body: { name: 'Sam' } });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const sam = (await srv.req('/api/profiles')).data.profiles.find(x => x.name === 'Sam');
  const lr = await fetch(srv.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) });
  const c2 = lr.headers.get('set-cookie').split(';')[0];
  const sw = await fetch(srv.base + '/api/profiles/switch', { method: 'POST', headers: { 'content-type': 'application/json', cookie: c2, origin: srv.base }, body: JSON.stringify({ id: sam.id }) });
  assert.equal(sw.status, 200);
  ck.sam = /kt=([0-9a-f]+)/.exec(sw.headers.get('set-cookie'))[1];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

async function phone(who, wide = false) {
  const ctx = await browser.newContext(wide ? { viewport: { width: 1280, height: 800 } } : { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
  await ctx.addCookies([{ name: 'kt', value: ck[who], url: srv.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  return { page, errors, close: () => ctx.close() };
}
const settle = (page) => page.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))), new Promise(r => setTimeout(r, 2000))]));
async function audit(page, name) {
  await page.waitForFunction(() => !document.querySelector('#main[aria-busy]'), null, { timeout: 15000 });
  await sleep(250); await settle(page);
  const f = await page.evaluate(auditPage, {});
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `tonight-${name}.png`), fullPage: true });
  assert.deepEqual(f, [], `${f.length} fynd (${name}):\n${fmt(f)}`);
}
const cardTitle = (page) => page.textContent('#tcard h2');

test('dator och telefon: gå med via kod, svep och få samma match i realtid', { skip, timeout: 180000 }, async () => {
  const A = await phone('admin', true), Bp = await phone('sam');
  // Startsidan och lobbyn (värden)
  await A.page.goto(srv.base + '/#/tonight');
  await A.page.waitForSelector('#tnew');
  await audit(A.page, 'start');
  await A.page.click('#tnew');
  await A.page.waitForSelector('#tform input[name=kind]');
  const code = (await A.page.textContent('.qc-code')).replace(/\D/g, '');
  assert.match(code, /^\d{6}$/);
  await A.page.waitForSelector('#tqr svg');
  // Profilen i hushållet ser kvällsvalet på startsidan – men går med via QR-kodens länk
  await Bp.page.goto(srv.base + '/#/tonight');
  await Bp.page.waitForSelector('[data-join]');
  await Bp.page.goto(srv.base + '/#/tonight/k/' + code);
  await Bp.page.waitForSelector('#tsum');
  assert.match(await Bp.page.textContent('#tbody'), /Väntar på att admin ska börja/);
  // Värden ser den nya deltagaren direkt
  await A.page.waitForFunction(() => /Sam/.test(document.querySelector('#tmem').textContent));
  await A.page.waitForFunction(() => /4 titlar passar/.test(document.querySelector('#tfits').textContent));
  await audit(A.page, 'lobby-värd');
  await audit(Bp.page, 'lobby');
  // Filter: bara filmer, tio förslag (sparas på servern och syns hos den andra)
  await A.page.selectOption('#tsize', '10');
  await Bp.page.waitForFunction(() => /10 förslag/.test(document.querySelector('#tsum').textContent));
  await A.page.click('#tstart');
  await A.page.waitForSelector('#tcard');
  await Bp.page.waitForSelector('#tcard');
  const first = await cardTitle(A.page);
  assert.equal(await cardTitle(Bp.page), first, 'samma ordning för alla');
  await audit(Bp.page, 'kort');
  await audit(A.page, 'kort-dator');
  // A: svep åt höger med pekaren, sedan →
  const box = await A.page.locator('#tcard').boundingBox();
  await A.page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await A.page.mouse.down();
  await A.page.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 3, { steps: 10 });
  await A.page.mouse.up();
  await A.page.waitForFunction((t) => document.querySelector('#tcard h2')?.textContent !== t, first);
  const second = await cardTitle(A.page);
  await A.page.keyboard.press('ArrowRight');
  // Ångra (Backsteg) och gilla igen: kortet kommer tillbaka
  await A.page.waitForFunction((t) => document.querySelector('#tcard h2')?.textContent !== t, second);
  await A.page.keyboard.press('Backspace');
  await A.page.waitForFunction((t) => document.querySelector('#tcard h2')?.textContent === t, second);
  await A.page.click('#tyes');
  // B: nej till det första med knappen, ja till det andra med → → match på det andra hos båda
  await Bp.page.click('#tno');
  await Bp.page.waitForFunction((t) => document.querySelector('#tcard h2')?.textContent === t, second);
  await Bp.page.keyboard.press('ArrowRight');
  await Promise.all([A.page.waitForSelector('.tmatch'), Bp.page.waitForSelector('.tmatch')]);
  assert.equal(await A.page.textContent('#tmh'), second);
  assert.equal(await Bp.page.textContent('#tmh'), second);
  assert.match(await Bp.page.textContent('.tmatch'), /Alla 2 gillade den/);
  assert.ok(await A.page.isVisible('#tplay') && await A.page.isVisible('#tcast'));
  await audit(Bp.page, 'match');
  await audit(A.page, 'match-dator');
  // Titta tillsammans: A skapar rummet, B får en länk dit
  await A.page.click('#tparty');
  // #/party/<rum> går vidare till titelsidan och startar spelaren i rummet (views/party.js)
  await A.page.waitForFunction(() => /^#\/(party|item)\//.test(location.hash));
  await Bp.page.waitForSelector('a[href^="#/party/"]');
  assert.deepEqual(A.errors, []);
  assert.deepEqual(Bp.errors, []);
  await A.close(); await Bp.close();
});
