// Hemma via den publika adressen (server/localaddr.js, server/routes/local.js): adresserna på hemnätet bara för
// inloggade, provanropet svarar med serverns id och ett bevis bara på hemnätet, webbens engångskod löses in bara hemma
// och en gång – och ingen utifrån blir hemma av egna rubriker (X-Forwarded-For, Host, Origin) eller via reläet.
// Klientlogiken (apps/expo/src/localpick.ts) provas sist: lokal adress när den svarar rätt, annars den sparade.
// Körs i samma process (servern startas på en slumpad port); kräver inte ffmpeg och inget nät utåt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-local-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = path.join(ROOT, 'media');
process.env.WATCH_FILES = '0';
process.env.LOCAL_DETECT = '0'; // nätverkskorten på testmaskinen ska inte synas i svaren
delete process.env.LOCAL_URL;
fs.mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
fs.mkdirSync(process.env.TRANSCODE_DIR, { recursive: true });
const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const local = await import('../server/localaddr.js');
const app = await import('../server/app.js');
const { RELAY } = await import('../server/util.js');

const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
// "Reläet": samma handle(), men varje anslutning märks som tunnel – och reläet uppger en privat adress
const relaySrv = http.createServer(app.handle);
relaySrv.on('connection', (s) => { s[RELAY] = { ip: '192.168.1.50', https: true }; });
await new Promise(r => relaySrv.listen(0, '127.0.0.1', r));
const R = `http://127.0.0.1:${relaySrv.address().port}`;
after(() => { for (const s of [srv, relaySrv]) { s.closeAllConnections?.(); s.close(); } fs.rmSync(ROOT, { recursive: true, force: true }); });

const user = (name, admin = 0) => Number(D.run('INSERT INTO users(name,pass,is_admin,created) VALUES(?,?,?,0)', name, 'x', admin).lastInsertRowid);
const ADMIN = user('anton', 1), BARN = user('lisa');
const app_ = { [ADMIN]: auth.createSession(ADMIN, 'app'), [BARN]: auth.createSession(BARN, 'app') };
const web = auth.createSession(BARN, 'web', { remember: false });
const OUT = { 'X-Forwarded-For': '203.0.113.9' }; // utifrån genom en proxy i hemnätet (som en riktig omvänd proxy)

// http.request i stället för fetch: Host måste kunna sättas (fetch tar alltid adressens värd)
function req(base, p, { method = 'GET', tok, cookie, body, headers = {} } = {}) {
  return new Promise((ok, no) => {
    const h = { ...headers };
    if (tok) h.Authorization = 'Bearer ' + tok;
    if (cookie) h.Cookie = 'kt=' + cookie;
    const b = body ? Buffer.from(JSON.stringify(body)) : null;
    if (b) { h['Content-Type'] = 'application/json'; h['Content-Length'] = b.length; }
    const r = http.request(base + p, { method, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = text; try { data = JSON.parse(text); } catch {}
        ok({ status: res.statusCode, data, headers: res.headers });
      });
    });
    r.on('error', no); r.end(b);
  });
}

test('adresserna bara för inloggade, med ett nytt prov varje gång', async () => {
  assert.equal((await req(B, '/api/local')).status, 401);
  assert.equal((await req(B, '/api/local', { tok: 'f'.repeat(64) })).status, 401);
  const a = await req(B, '/api/local', { tok: app_[BARN] });
  assert.equal(a.status, 200);
  assert.match(a.data.id, /^[a-f0-9]{32}$/);
  assert.ok(Array.isArray(a.data.addrs));
  assert.equal(a.data.here, true, 'från 127.0.0.1 är man hemma');
  assert.match(a.data.n, /^\d{10}\.[a-f0-9]{32}$/);
  assert.match(a.data.proof, /^[a-f0-9]{64}$/);
  assert.equal(a.headers['cache-control'], 'no-store');
  const b = await req(B, '/api/local', { tok: app_[BARN] });
  assert.notEqual(a.data.n, b.data.n);
  // Utifrån och via reläet: samma svar (det är där klienten behöver dem), men here = false
  assert.equal((await req(B, '/api/local', { tok: app_[BARN], headers: OUT })).data.here, false);
  assert.equal((await req(R, '/api/local', { tok: app_[BARN] })).data.here, false);
  // Media- och bildtoken gäller inte här
  const media = auth.createSession(BARN, 'img');
  assert.equal((await req(B, '/api/local?t=' + media)).status, 401);
});

test('provanropet: serverns id och rätt bevis på hemnätet, annars finns det inte', async () => {
  const a = (await req(B, '/api/local', { tok: app_[BARN], headers: OUT })).data; // provet hämtas utifrån
  const p = await req(B, '/api/local/ping?n=' + a.n); // utan inloggning, från hemnätet
  assert.equal(p.status, 200);
  assert.deepEqual(p.data, { id: a.id, proof: a.proof });
  // Ogiltigt eller gammalt prov
  assert.equal((await req(B, '/api/local/ping?n=nej')).status, 400);
  assert.equal((await req(B, '/api/local/ping?n=1000000000.' + 'a'.repeat(32))).status, 400);
  assert.equal((await req(B, `/api/local/ping?n=${Math.floor(Date.now() / 1000) + 3600}.${'a'.repeat(32)}`)).status, 400, 'utgången får inte ligga långt fram');
  // Utifrån: inget svar, oavsett vad klienten skriver i rubrikerna
  for (const headers of [OUT, { 'X-Forwarded-For': '192.168.1.5, 203.0.113.9' }, { ...OUT, Host: '192.168.1.10:8420' },
    { ...OUT, Origin: 'http://192.168.1.10:8420', 'X-Forwarded-Host': '192.168.1.10' }, { ...OUT, Forwarded: 'for=192.168.1.5' }]) {
    const r = await req(B, '/api/local/ping?n=' + a.n, { headers });
    assert.equal(r.status, 404, JSON.stringify(headers));
    assert.ok(!JSON.stringify(r.data).includes(a.proof));
  }
  // Via reläet – även när reläet uppger en privat adress och klienten skickar egna X-Forwarded-For
  for (const headers of [{}, { 'X-Forwarded-For': '192.168.1.5' }, { Host: '192.168.1.10:8420' }]) {
    assert.equal((await req(R, '/api/local/ping?n=' + a.n, { headers })).status, 404);
  }
  // Ett annat bevis för ett annat prov (svaret kan inte återanvändas)
  const b = (await req(B, '/api/local', { tok: app_[BARN] })).data;
  assert.notEqual(b.proof, a.proof);
  assert.equal((await req(B, '/api/local/ping?n=' + b.n)).data.proof, b.proof);
});

test('hemadressen: administratörens egen, eller den en administratör öppnat servern på direkt hemma', async () => {
  const addrs = async () => (await req(B, '/api/local', { tok: app_[BARN] })).data.addrs;
  assert.deepEqual(await addrs(), []);
  // Inte från vanliga användare, inte genom proxy, inte via reläet, inte utifrån och inte loopback/publika adresser
  await req(B, '/api/status', { tok: app_[BARN], headers: { Host: '192.168.1.66:8420' } });
  await req(B, '/api/status', { tok: app_[ADMIN], headers: { Host: '192.168.1.67:8420', 'X-Forwarded-For': '192.168.1.5' } });
  await req(B, '/api/status', { tok: app_[ADMIN], headers: { Host: '192.168.1.68:8420', ...OUT } });
  await req(R, '/api/status', { tok: app_[ADMIN], headers: { Host: '192.168.1.69:8420' } });
  await req(B, '/api/status', { tok: app_[ADMIN], headers: { Host: '203.0.113.7:8420' } });
  await req(B, '/api/status', { tok: app_[ADMIN], headers: { Host: 'tv.example.com' } });
  await req(B, '/api/status', { tok: app_[ADMIN], headers: { Host: '192.168.1.70:8420/x' } });
  assert.deepEqual(await addrs(), []);
  // Administratören hemma, direkt mot IP-adressen
  await req(B, '/api/status', { tok: app_[ADMIN], headers: { Host: '192.168.1.10:8420' } });
  assert.deepEqual(await addrs(), ['http://192.168.1.10:8420']);
  // Administratörens egen adress går först; felaktiga adresser nekas
  assert.equal((await req(B, '/api/settings', { method: 'PUT', tok: app_[ADMIN], body: { localUrl: 'ftp://x' } })).status, 400);
  assert.equal((await req(B, '/api/settings', { method: 'PUT', tok: app_[ADMIN], body: { localUrl: 'http://192.168.1.2:8420/sökväg' } })).status, 400);
  assert.equal((await req(B, '/api/settings', { method: 'PUT', tok: app_[ADMIN], body: { localUrl: 'http://u:p@192.168.1.2:8420' } })).status, 400);
  assert.equal((await req(B, '/api/settings', { method: 'PUT', tok: app_[ADMIN], body: { localUrl: 'http://192.168.1.2:8420/, http://tv.lan' } })).status, 200);
  assert.deepEqual(await addrs(), ['http://192.168.1.2:8420', 'http://tv.lan', 'http://192.168.1.10:8420']);
  const s = (await req(B, '/api/settings', { tok: app_[ADMIN] })).data;
  assert.equal(s.localUrl, 'http://192.168.1.2:8420,http://tv.lan');
  // Inställningen kräver administratör
  assert.equal((await req(B, '/api/settings', { method: 'PUT', tok: app_[BARN], body: { localUrl: 'http://192.168.1.99' } })).status, 403);
  assert.equal((await req(B, '/api/settings', { method: 'PUT', tok: app_[ADMIN], body: { localUrl: '' } })).status, 200);
});

test('webben: engångskoden löses in bara på hemnätet, en gång, och ger samma profil', async () => {
  assert.equal((await req(B, '/api/local/handoff', { method: 'POST', tok: app_[BARN] })).status, 400, 'bara webbens inloggning');
  assert.equal((await req(B, '/api/local/handoff', { method: 'POST' })).status, 401);
  // Webben via reläet (där ägaren sitter) begär en kod
  const h = await req(R, '/api/local/handoff', { method: 'POST', cookie: web });
  assert.equal(h.status, 200);
  assert.match(h.data.code, /^[a-f0-9]{64}$/);
  assert.deepEqual(h.data.addrs, ['http://192.168.1.10:8420']);
  // Utifrån, via reläet och med påhittade rubriker: nekas, och koden förbrukas inte
  for (const [base, headers] of [[B, OUT], [R, {}], [R, { 'X-Forwarded-For': '192.168.1.5' }], [B, { 'X-Forwarded-For': '10.0.0.5, 198.51.100.4', Host: '192.168.1.10:8420' }]]) {
    const r = await req(base, '/api/local/redeem', { method: 'POST', body: { code: h.data.code }, headers });
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.ok(!r.headers['set-cookie']);
  }
  // Från en annan webbplats (inloggning via någon annans sida): nekas
  assert.equal((await req(B, '/api/local/redeem', { method: 'POST', body: { code: h.data.code }, headers: { Origin: 'http://evil.example' } })).status, 403);
  // Hemma: en vanlig webbinloggning för samma profil
  const r = await req(B, '/api/local/redeem', { method: 'POST', body: { code: h.data.code } });
  assert.equal(r.status, 200);
  const ck = /^kt=([a-f0-9]{64});/.exec(r.headers['set-cookie']?.[0] || '');
  assert.ok(ck, r.headers['set-cookie']?.[0]);
  assert.ok(!/Max-Age/.test(r.headers['set-cookie'][0]), '"håll mig inloggad" följer med från sessionen (här av)');
  assert.equal((await req(B, '/api/status', { cookie: ck[1] })).data.user.id, BARN);
  // En gång
  assert.equal((await req(B, '/api/local/redeem', { method: 'POST', body: { code: h.data.code } })).status, 400);
  assert.equal((await req(B, '/api/local/redeem', { method: 'POST', body: { code: 'x' } })).status, 400);
  // Inloggningen syns i säkerhetsloggen
  assert.ok(D.get("SELECT 1 FROM audit WHERE event='login_ok' AND detail='webb, hemadressen' AND user_id=?", BARN));
});

test('engångskoden går ut efter två minuter och högst fem per användare gäller', () => {
  const real = Date.now;
  try {
    const c = local.newCode(BARN, true);
    Date.now = () => real() + (local.TTL + 2) * 1000;
    assert.equal(local.takeCode(c), null);
    Date.now = real;
    const many = Array.from({ length: 7 }, () => local.newCode(BARN, false));
    assert.equal(local.takeCode(many[0]), null, 'den äldsta knuffades ut');
    assert.equal(local.takeCode(many[1]), null);
    for (const c of many.slice(2)) assert.deepEqual({ ...local.takeCode(c), exp: 0 }, { uid: BARN, remember: false, exp: 0 });
  } finally { Date.now = real; }
});

test('ingen utifrån blir hemma: status, administration och kvalitet är som förut', async () => {
  for (const [base, headers] of [[B, OUT], [B, { 'X-Forwarded-For': '192.168.1.5, 203.0.113.9', Host: '192.168.1.10:8420', Origin: 'http://192.168.1.10:8420' }], [R, {}], [R, { 'X-Forwarded-For': '127.0.0.1' }]]) {
    const st = (await req(base, '/api/status', { tok: app_[ADMIN], headers })).data;
    assert.equal(st.remote, true, JSON.stringify(headers));
    assert.equal(st.user.adminHere, false);
    assert.equal((await req(base, '/api/settings', { tok: app_[ADMIN], headers })).status, 403);
  }
  assert.equal((await req(B, '/api/status', { tok: app_[ADMIN] })).data.remote, false);
});

// ---------- klientlogiken (Expo-appen, apps/expo/src/localpick.ts) ----------
// Node 22.18+ läser TypeScript utan byggsteg (typerna tas bort); äldre Node hoppar över de här fallen.
let pick = null;
try { pick = await import('../apps/expo/src/localpick.ts'); } catch {}
const noTs = pick ? false : 'Node utan TypeScript-stöd';

test('klienten: hemadressen när den svarar rätt, annars den sparade', { skip: noTs }, async () => {
  const { pickLocal, isLocalUrl } = pick;
  // Mot den riktiga servern: provet hämtas "utifrån", hemadressen är testservern
  const info = (await req(B, '/api/local', { tok: app_[BARN], headers: OUT })).data;
  const getJson = async (url, ms) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(String(r.status)); return await r.json(); } finally { clearTimeout(t); }
  };
  // En adress som inte svarar (stängd port) och en som svarar: den som svarar rätt vinner
  const dead = http.createServer(); await new Promise(r => dead.listen(0, '127.0.0.1', r));
  const deadUrl = `http://127.0.0.1:${dead.address().port}`; dead.close();
  assert.equal(await pickLocal({ ...info, addrs: [deadUrl, B] }, getJson), B);
  // Svarar inte alls inom tiden (porten tar emot men svarar aldrig): den sparade adressen, efter högst ~0,85 s
  const hang = http.createServer(() => {}); await new Promise(r => hang.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  assert.equal(await pickLocal({ ...info, addrs: [`http://127.0.0.1:${hang.address().port}`] }, getJson), null);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  hang.closeAllConnections(); hang.close();
  // En annan maskin på samma adress som svarar med fel id eller fel bevis (t.ex. ett annat nät): används inte
  const other = http.createServer((q, s) => { s.setHeader('Content-Type', 'application/json'); s.end(JSON.stringify(q.url.includes('x') ? { id: info.id, proof: 'f'.repeat(64) } : { id: 'annan', proof: info.proof })); });
  await new Promise(r => other.listen(0, '127.0.0.1', r));
  const O = `http://127.0.0.1:${other.address().port}`;
  assert.equal(await pickLocal({ ...info, addrs: [O] }, getJson), null);
  assert.equal(await pickLocal({ ...info, n: info.n + 'x', addrs: [O] }, getJson), null);
  other.close();
  // Ett gammalt prov: servern svarar 400 → den sparade
  assert.equal(await pickLocal({ ...info, n: '1000000000.' + 'a'.repeat(32), addrs: [B] }, getJson), null);
  // Redan hemma, inga adresser, trasigt svar: inget prov alls
  let calls = 0; const count = async () => { calls++; return {}; };
  for (const i of [null, { ...info, here: true }, { ...info, addrs: [] }, { ...info, addrs: ['javascript:alert(1)', 'http://x/y', 'http://u@x'] }, { ...info, proof: '' }]) assert.equal(await pickLocal(i, count), null);
  assert.equal(calls, 0);
  // Vad som räknas som en adress i hemnätet (där appen inte provar)
  for (const u of ['http://192.168.1.10:8420', 'http://10.0.0.2', 'http://172.20.1.1:8420', 'http://tower.local:8420', 'http://nas:8420', 'http://localhost:8420']) assert.equal(isLocalUrl(u), true, u);
  for (const u of ['https://tv.braxhn.net', 'http://172.32.0.1', 'https://192.168.1.10.example.com', 'nonsens']) assert.equal(isLocalUrl(u), false, u);
});
