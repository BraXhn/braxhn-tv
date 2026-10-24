// Snabbinloggning med kod (TV): begäran, godkännande, pollning, engångstoken, utgång, gissningsskydd,
// barnprofil, fjärråtkomst och avstängd funktion. Körs i samma process; kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-qc-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = path.join(ROOT, 'media');
process.env.WATCH_FILES = '0';
fs.mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');

const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const MAMMA = Number(D.run("INSERT INTO users(name,pass,is_admin,created,remote_allowed) VALUES('mamma','x',1,0,1)").lastInsertRowid);
const KID = Number(D.run("INSERT INTO users(name,pass,is_admin,created,parent_id,max_age,remote_allowed) VALUES('lisa','x',0,0,?,7,1)", MAMMA).lastInsertRowid);
const HEMMA = Number(D.run("INSERT INTO users(name,pass,is_admin,created,remote_allowed) VALUES('farfar','x',0,0,0)").lastInsertRowid);
const GISSARE = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('gissare','x',0,0)").lastInsertRowid);
const tok = { [MAMMA]: auth.createSession(MAMMA, 'app'), [KID]: auth.createSession(KID, 'app'), [HEMMA]: auth.createSession(HEMMA, 'app'), [GISSARE]: auth.createSession(GISSARE, 'app') };

let ipSeq = 0;
async function req(p, { method = 'GET', body, uid, token, headers = {} } = {}) {
  const h = { ...headers };
  if (uid) h.authorization = `Bearer ${tok[uid]}`;
  if (token) h.authorization = `Bearer ${token}`;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : await r.text() };
}
// Varje test använder egna adresser (begränsningarna räknas per IP)
const lan = () => ({ 'x-forwarded-for': `192.168.50.${++ipSeq}` });
const start = (body = { app: true, name: 'Vardagsrummet', device: 'Apple TV' }, headers = lan()) => req('/api/quickconnect', { method: 'POST', body, headers });
const approve = (uid, code, confirm = true, headers = lan()) => req('/api/quickconnect/approve', { method: 'POST', uid, body: { code, confirm }, headers });

test('hela flödet: kod, ingen token före godkännande, bekräftelse med enhet och IP, token exakt en gång', async () => {
  const h = lan();
  const s = await start(undefined, h);
  assert.equal(s.status, 200);
  assert.match(s.data.code, /^\d{6}$/);
  assert.match(s.data.secret, /^[a-f0-9]{64}$/);
  assert.equal(s.data.ttl, 300);

  const p0 = await req('/api/quickconnect/' + s.data.secret);
  assert.deepEqual([p0.data.status, p0.data.token], ['pending', undefined]);

  // Första steget visar bara enheten – godkänner inte
  const look = await approve(MAMMA, s.data.code, false);
  assert.equal(look.status, 200);
  assert.equal(look.data.approved, false);
  assert.equal(look.data.name, 'Vardagsrummet');
  assert.equal(look.data.device, 'Apple TV');
  assert.equal(look.data.ip, h['x-forwarded-for']);
  assert.equal((await req('/api/quickconnect/' + s.data.secret)).data.status, 'pending');

  const ok = await approve(MAMMA, s.data.code);
  assert.equal(ok.data.approved, true);
  assert.equal(ok.data.profile, 'mamma');
  // Koden kan inte godkännas igen
  assert.equal((await approve(MAMMA, s.data.code)).status, 404);

  const p1 = await req('/api/quickconnect/' + s.data.secret, { headers: { 'user-agent': 'BraXhnTV-tvOS' } });
  assert.equal(p1.data.status, 'approved');
  assert.match(p1.data.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(p1.data.user, { id: MAMMA, name: 'mamma', is_admin: 1 });
  // Samma format som apparnas inloggning: en apptoken som fungerar
  const st = await req('/api/status', { token: p1.data.token });
  assert.equal(st.data.user.id, MAMMA);
  assert.equal(D.get('SELECT kind FROM sessions WHERE token=?', auth.sha(p1.data.token)).kind, 'app');
  // Andra pollningen får ingen token
  const p2 = await req('/api/quickconnect/' + s.data.secret);
  assert.deepEqual([p2.data.status, p2.data.token], ['expired', undefined]);
  const log = D.all("SELECT event, detail FROM audit WHERE event IN ('quickconnect_approved','login_ok') ORDER BY id DESC LIMIT 2");
  assert.ok(log.some(l => l.event === 'quickconnect_approved' && l.detail.includes('Vardagsrummet')));
  assert.ok(log.some(l => l.event === 'login_ok' && /kod/.test(l.detail)));
});

test('okänd nyckel och utgången begäran ger expired; en utgången kod kan inte godkännas', async () => {
  assert.equal((await req('/api/quickconnect/' + 'a'.repeat(64))).data.status, 'expired');
  assert.equal((await req('/api/quickconnect/inte-hex')).data.status, 'expired');
  const s = await start();
  const real = Date.now;
  try {
    Date.now = () => real() + 301e3;
    assert.equal((await req('/api/quickconnect/' + s.data.secret)).data.status, 'expired');
    assert.equal((await approve(MAMMA, s.data.code)).status, 404);
  } finally { Date.now = real; }
});

test('felaktiga koder räknas mot en gräns per användare', async () => {
  const s = await start();
  const wrong = s.data.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await approve(GISSARE, wrong)).status, 404);
  // Nu nekas även rätt kod en stund
  assert.equal((await approve(GISSARE, s.data.code)).status, 429);
  assert.equal((await req('/api/quickconnect/' + s.data.secret)).data.status, 'pending');
  assert.ok(D.get("SELECT 1 FROM audit WHERE event='quickconnect_fail' AND user_id=?", GISSARE));
});

test('nya begäranden begränsas per IP', async () => {
  const h = lan();
  let last;
  for (let i = 0; i < 21; i++) last = await start(undefined, h);
  assert.equal(last.status, 429);
});

test('barnprofil: token för barnprofilen och åldersgränsen följer med', async () => {
  const s = await start();
  assert.equal((await approve(KID, s.data.code)).data.profile, 'lisa');
  const p = await req('/api/quickconnect/' + s.data.secret);
  assert.equal(p.data.user.id, KID);
  const st = await req('/api/status', { token: p.data.token });
  assert.equal(st.data.user.kid, true);
  assert.equal(st.data.user.maxAge, 7);
});

test('kringgår inte fjärrreglerna: konto utan fjärråtkomst, krav på tvåstegsverifiering och byte av nät', async () => {
  const ute = { 'x-forwarded-for': '81.2.3.4' };
  // Enheten utanför hemmet, kontot får bara användas hemma
  const s = await start(undefined, ute);
  const r = await approve(HEMMA, s.data.code);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /hemnätverket/);
  // Krav på tvåstegsverifiering utifrån: mamma har ingen 2FA
  D.setSetting('require_2fa_remote', '1');
  try {
    const s2 = await start(undefined, { 'x-forwarded-for': '81.2.3.5' });
    assert.equal((await approve(MAMMA, s2.data.code)).status, 403);
    // Godkänd hemma men pollningen kommer plötsligt utifrån: ingen token
    const s3 = await start();
    assert.equal((await approve(MAMMA, s3.data.code)).status, 200);
    const p = await req('/api/quickconnect/' + s3.data.secret, { headers: { 'x-forwarded-for': '81.2.3.6' } });
    assert.equal(p.status, 403);
    assert.equal(p.data.token, undefined);
    assert.equal((await req('/api/quickconnect/' + s3.data.secret)).data.status, 'expired');
  } finally { D.setSetting('require_2fa_remote', '0'); }
  // Konto med fjärråtkomst och utan krav: går bra även utifrån
  const s4 = await start(undefined, { 'x-forwarded-for': '81.2.3.7' });
  assert.equal((await approve(MAMMA, s4.data.code)).status, 200);
  assert.ok((await req('/api/quickconnect/' + s4.data.secret, { headers: { 'x-forwarded-for': '81.2.3.7' } })).data.token);
});

test('webben: inloggningskaka bara för anrop från sidan själv', async () => {
  const s = await start({ name: 'TV-webbläsare' });
  await approve(MAMMA, s.data.code);
  // Utan sidans egen rubrik (t.ex. en länk från en annan webbplats) nekas det
  assert.equal((await req('/api/quickconnect/' + s.data.secret)).status, 403);
  assert.equal((await req('/api/quickconnect/' + s.data.secret, { headers: { 'x-requested-with': 'BraXhnTV', 'sec-fetch-site': 'cross-site' } })).status, 403);
  const p = await req('/api/quickconnect/' + s.data.secret, { headers: { 'x-requested-with': 'BraXhnTV', 'sec-fetch-site': 'same-origin' } });
  assert.equal(p.data.status, 'approved');
  assert.equal(p.data.token, undefined);
  const cookie = p.headers.get('set-cookie');
  assert.match(cookie, /kt=[a-f0-9]{64}; Path=\/; HttpOnly/);
  const st = await req('/api/status', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(st.data.user.id, MAMMA);
});

test('inställningen stänger av funktionen helt', async () => {
  const s = await start();
  assert.equal((await req('/api/status')).data.quickConnect, true);
  D.setSetting('quick_connect', '0');
  try {
    assert.equal((await req('/api/status')).data.quickConnect, false);
    assert.equal((await start()).status, 403);
    assert.equal((await approve(MAMMA, s.data.code)).status, 403);
    assert.equal((await req('/api/quickconnect/' + s.data.secret)).status, 403);
  } finally { D.setSetting('quick_connect', '1'); }
  // Godkännande kräver inloggning
  assert.equal((await req('/api/quickconnect/approve', { method: 'POST', body: { code: s.data.code, confirm: true } })).status, 401);
});
