// Stöd projektet (server/project.js): user.donateUrl i /api/status skickas bara när länken är satt, är https till
// paypal.com/paypal.me, inställningen "Visa länken Stöd projektet" är på och användaren inte är en barnprofil.
// Länken styrs i testet med DONATE_URL_OVERRIDE (läses bara med NODE_ENV=test). I Chromium (Playwright): raden syns
// längst ner i Mitt konto och i Administration för vuxna, inte för barnprofilen. Webbläsardelen hoppas över utan Playwright.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, PW } from './media/server.mjs';
import { freePort } from './helpers/port.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-donate-'));
process.env.CONFIG_DIR = path.join(ROOT, 'unit-config');
const project = await import('../server/project.js');
let chromium = null;
const require = createRequire(import.meta.url);
for (const p of [process.env.PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = p.startsWith('/') ? await import(p) : require(p)); if (chromium) break; } catch {}
}
const TEST_URL = 'https://www.paypal.com/donate/?hosted_button_id=TEST123';
const srv = {}, ck = {};
let browser;

/** En server med en viss länk (undefined = den inbyggda DONATE_URL) och första kontot skapat */
async function server(name, override) {
  const root = path.join(ROOT, name); fs.mkdirSync(path.join(root, 'media'), { recursive: true });
  const env = { NODE_ENV: 'test', TMDB_API_KEY: '', WATCH_FILES: '0' };
  if (override !== undefined) env.DONATE_URL_OVERRIDE = override;
  const s = await startServer({ root, media: path.join(root, 'media'), port: await freePort(), env });
  const r = await s.req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return s;
}
const status = async (s, cookie) => (await fetch(s.base + '/api/status', { headers: cookie ? { cookie } : {} })).json();

before(async () => {
  srv.ok = await server('ok', TEST_URL);
  srv.empty = await server('empty', '');
  srv.other = await server('other', 'https://paypal.me.example.com/braxhn');
  // Barnprofil under huvudkontot och en egen inloggning som byter till den
  assert.equal((await srv.ok.req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  const lisa = (await srv.ok.req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  ck.admin = /kt=([0-9a-f]+)/.exec((await srv.ok.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW } })).headers.get('set-cookie'))[1];
  const lr = await fetch(srv.ok.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: PW }) });
  const sw = await fetch(srv.ok.base + '/api/profiles/switch', { method: 'POST', headers: { 'content-type': 'application/json', cookie: lr.headers.get('set-cookie').split(';')[0], origin: srv.ok.base }, body: JSON.stringify({ id: lisa }) });
  assert.equal(sw.status, 200);
  ck.lisa = /kt=([0-9a-f]+)/.exec(sw.headers.get('set-cookie'))[1];
  if (chromium) browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  for (const s of Object.values(srv)) await s.stop();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('validDonateUrl: bara https till paypal.com eller paypal.me', () => {
  for (const u of ['https://paypal.me/braxhn', 'https://www.paypal.com/donate/?hosted_button_id=X', 'https://PayPal.Me/braxhn']) assert.ok(project.validDonateUrl(u), u);
  for (const u of ['', '  ', null, undefined, 42, 'http://paypal.me/braxhn', 'https://paypal.me.evil.com/x', 'https://evilpaypal.com/x', 'https://paypal.me:8443/x',
    'https://user@paypal.me/x', 'javascript:alert(1)', 'paypal.me/braxhn', 'https://example.com/?u=https://paypal.me']) assert.equal(project.validDonateUrl(u), null, String(u));
  // Den inbyggda länken är giltig
  assert.ok(project.validDonateUrl(project.DONATE_URL));
});

test('donateUrl skickas för vuxna när länken är satt och visas, aldrig utan inloggning', async () => {
  assert.equal((await status(srv.ok)).user, null);
  const st = await status(srv.ok, `kt=${ck.admin}`);
  assert.equal(st.user.donateUrl, TEST_URL);
  assert.equal(st.donateUrl, TEST_URL, 'apparna läser fältet på toppnivå');
  assert.equal('donateUrl' in (await status(srv.ok)), false, 'inte utan inloggning');
  const S = (await srv.ok.req('/api/settings')).data;
  assert.equal(S.donateUrl, TEST_URL); assert.equal(S.showDonate, true);
});

test('donateUrl skickas inte till barnprofiler', async () => {
  const st = await status(srv.ok, `kt=${ck.lisa}`), u = st.user;
  assert.equal(u.kid, true);
  assert.equal('donateUrl' in u, false);
  assert.equal('donateUrl' in st, false);
});

test('inställningen döljer länken för hela servern', async () => {
  assert.equal((await srv.ok.req('/api/settings', { method: 'PUT', body: { showDonate: false } })).status, 200);
  assert.equal('donateUrl' in (await status(srv.ok, `kt=${ck.admin}`)).user, false);
  assert.equal((await srv.ok.req('/api/settings')).data.showDonate, false);
  assert.equal((await srv.ok.req('/api/settings', { method: 'PUT', body: { showDonate: true } })).status, 200);
  assert.equal((await status(srv.ok, `kt=${ck.admin}`)).user.donateUrl, TEST_URL);
});

test('donateUrl skickas inte när länken är tom eller inte går till PayPal', async () => {
  for (const s of [srv.empty, srv.other]) {
    const u = (await s.req('/api/status')).data.user;
    assert.equal(u.is_admin, 1);
    assert.equal('donateUrl' in u, false);
    assert.equal((await s.req('/api/settings')).data.donateUrl, null);
  }
});

const bt = (name, fn) => test(name, { skip: chromium ? false : 'Playwright saknas', timeout: 120000 }, fn);
async function page(who) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name: 'kt', value: ck[who], url: srv.ok.base }]);
  const p = await ctx.newPage();
  const errors = [];
  // Inget anrop till PayPal förrän någon klickar
  const outside = [];
  p.on('request', r => { if (!r.url().startsWith(srv.ok.base) && !r.url().startsWith('data:')) outside.push(r.url()); });
  p.on('pageerror', e => errors.push(e.message));
  return { p, errors, outside, close: () => ctx.close() };
}

bt('webben: Stöd projektet längst ner i Mitt konto och i Administration, inte för barnprofilen', async () => {
  const a = await page('admin');
  await a.p.goto(srv.ok.base + '/#/account');
  await a.p.waitForSelector('#donate a', { timeout: 15000 });
  const link = await a.p.$eval('#donate a', el => ({ href: el.href, target: el.target, rel: el.rel, text: el.textContent, last: el.parentElement === el.parentElement.parentElement.lastElementChild }));
  assert.deepEqual(link, { href: TEST_URL, target: '_blank', rel: 'noopener noreferrer', text: 'Stöd projektet', last: true });
  assert.match(await a.p.textContent('#donate'), /gratis och utan reklam.*helt frivilligt/);
  await a.p.goto(srv.ok.base + '/#/admin');
  await a.p.waitForSelector('#sdon', { timeout: 20000 });
  assert.equal(await a.p.getAttribute('#donate a', 'href'), TEST_URL);
  assert.equal(await a.p.isChecked('#sdon'), true);
  assert.deepEqual(a.outside, []);
  assert.deepEqual(a.errors, []);
  await a.close();

  const k = await page('lisa');
  await k.p.goto(srv.ok.base + '/#/account');
  await k.p.waitForSelector('#revall', { timeout: 15000 });
  await k.p.waitForFunction(() => !document.querySelector('#main[aria-busy]'), null, { timeout: 15000 });
  assert.equal(await k.p.$('#donate'), null);
  assert.doesNotMatch(await k.p.textContent('#main'), /Stöd projektet|PayPal/);
  assert.deepEqual(k.errors, []);
  await k.close();
});
