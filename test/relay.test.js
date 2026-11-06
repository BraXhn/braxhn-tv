// BraXhn Relay: reläet (relay/server.js, egen process) och hemserverns tunnel (server/relay.js, i testprocessen).
// Parning med engångskod, inloggning/API/bilder, direktuppspelning med Range, HLS-segment, SSE, en stor fil utan att
// minnet växer, återanslutning när reläet startas om – och säkerheten: allt genom reläet räknas som utanför hemmet
// (admin nekas, curate kräver 2FA, konton utan fjärråtkomst nekas, X-Forwarded-For ändrar ingenting), oparade och
// förfalskade tunnlar nekas och reläet skickar aldrig vidare till något annat än den parade servern.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { freePort } from './helpers/port.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-relay-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.RELAY_HEARTBEAT_MS = '1000';
fs.mkdirSync(path.join(MEDIA, 'Filmer'), { recursive: true });
const D = await import('../server/db.js');
const sc = await import('../server/scanner.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const relay = await import('../server/relay.js');
const { imageFile } = await import('../server/localmeta.js');

const REPO = path.join(import.meta.dirname, '..');
const RELAY_PORT = await freePort(1);
const R = `http://127.0.0.1:${RELAY_PORT}`;
const TOKEN = 'testtoken-' + crypto.randomBytes(8).toString('hex');
const PW = 'Relä-testlösen-2026!';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Hemservern lyssnar bara på loopback (betrott nät): administrationen görs direkt, klienterna går via reläet
const home = http.createServer(app.handle);
await new Promise(r => home.listen(0, '127.0.0.1', r));
const H = `http://127.0.0.1:${home.address().port}`;

// Konton: administratör utan 2FA, vanlig användare, användare utan fjärråtkomst
const ANNA = Number(D.run('INSERT INTO users(name,pass,is_admin,created) VALUES(?,?,1,0)', 'anna', await auth.hashPw(PW)).lastInsertRowid);
D.run('INSERT INTO users(name,pass,is_admin,created) VALUES(?,?,0,0)', 'bo', await auth.hashPw(PW));
D.run('INSERT INTO users(name,pass,is_admin,created,remote_allowed) VALUES(?,?,0,0,0)', 'hemma', await auth.hashPw(PW));
const annaTok = auth.createSession(ANNA, 'app');

// Media: en riktig kort film (Range, HLS) och en stor gles fil (minnet)
const FILM = path.join(MEDIA, 'Filmer', 'Testfilm (2020).mp4');
const STOR = path.join(MEDIA, 'Filmer', 'Stor film (2021).mkv');
if (hasFfmpeg) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-shortest', FILM]);
else fs.writeFileSync(FILM, crypto.randomBytes(200000));
fs.writeFileSync(STOR, 'x');
const LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", path.join(MEDIA, 'Filmer')).lastInsertRowid);
await sc.scan(LIB);
const FILM_ID = D.get("SELECT id FROM items WHERE path=?", FILM).id;
const STOR_ID = D.get("SELECT id FROM items WHERE path=?", STOR).id;
const BIG = 600 * 1048576;
fs.truncateSync(STOR, BIG); // gles fil: tar ingen plats på disken
const POSTER = crypto.randomBytes(5000);
fs.mkdirSync(path.dirname(imageFile(FILM_ID, 'poster')), { recursive: true });
fs.writeFileSync(imageFile(FILM_ID, 'poster'), POSTER);

// ---------- reläet som egen process ----------
let relayProc = null, relayLog = '';
function startRelay() {
  return new Promise((ok, no) => {
    const env = { ...process.env, RELAY_PORT: String(RELAY_PORT), RELAY_BIND: '127.0.0.1', RELAY_DATA_DIR: path.join(ROOT, 'relaydata'), RELAY_ADMIN_TOKEN: TOKEN,
      RELAY_HEARTBEAT_MS: '1000', RELAY_TRUSTED_PROXIES: 'none', RELAY_DEBUG: '1' };
    const p = spawn(process.execPath, [path.join(REPO, 'relay', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    relayProc = p;
    const t = setTimeout(() => no(new Error('reläet startade inte: ' + relayLog)), 15000);
    const on = (d) => { relayLog += d; if (/lyssnar på port/.test(relayLog)) { clearTimeout(t); ok(p); } };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('exit', () => { if (relayProc === p) relayProc = null; });
    if (process.env.RELAY_TEST_LOG) p.stdout.pipe(process.stderr);
  });
}
async function stopRelay() {
  const p = relayProc; if (!p) return;
  const gone = new Promise(r => p.once('exit', r));
  process.kill(p.pid, 'SIGTERM'); // via PID (aldrig pkill -f)
  await gone;
}
before(startRelay);
after(async () => {
  await relay.unpair().catch(() => {});
  await stopRelay();
  home.closeAllConnections?.(); home.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------- hjälpare ----------
let cookie = '';
async function req(base, p, { method = 'GET', body, headers = {}, ck = true, raw = false } = {}) {
  const h = { ...headers };
  if (ck && cookie) h.cookie = cookie;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (ck && sc && /kt=/.test(sc) && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: raw ? Buffer.from(await r.arrayBuffer()) : ct.includes('json') ? await r.json() : await r.text() };
}
const adminApi = (p, opts = {}) => req(R, '/_relay/api/' + p, { ...opts, ck: false, headers: { Authorization: 'Bearer ' + TOKEN, ...(opts.headers || {}) } });
async function waitFor(fn, ms = 15000, what = 'villkoret') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(100); }
  throw new Error('väntade förgäves på ' + what);
}
const startCode = () => /parningskod ([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(relayLog)?.[1];
/** Rå HTTP mot reläet (uppgraderingar, absoluta adresser, CONNECT) */
function rawReq(text) {
  return new Promise((ok) => {
    const s = net.connect(RELAY_PORT, '127.0.0.1', () => s.write(text));
    let out = ''; s.on('data', d => { out += d; }); s.on('end', () => ok(out)); s.on('error', () => ok(out)); s.on('close', () => ok(out));
    setTimeout(() => { s.destroy(); ok(out); }, 3000);
  });
}

// ---------------- parning ----------------
test('parning: oparad server nås inte, fel kod nekas, rätt kod parar en gång och tunneln ansluter', async () => {
  assert.equal(relay.status().paired, false);
  assert.equal((await req(R, '/api/status', { ck: false })).status, 404, 'ingen parad server – reläet skickar inget vidare');
  assert.match(startCode() || '', /^[A-Z2-9-]{19}$/, 'reläet loggar en parningskod vid start');
  // Admin utan token; adminsidan utan inbäddade skript
  assert.equal((await req(R, '/_relay/api/status', { ck: false })).status, 401);
  const ap = await req(R, '/_relay/admin', { ck: false });
  assert.equal(ap.status, 200); assert.match(ap.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await req(R, '/_relay/api/codes', { method: 'POST', body: {}, ck: false, headers: { Authorization: 'Bearer ' + TOKEN, origin: 'https://evil.example' } })).status, 403, 'adminens ändringar bara från samma origin');
  // Fel kod (rätt format) – och koden visas aldrig i hemserverns svar
  const bad = await req(H, '/api/relay/pair', { method: 'POST', body: { url: R, code: 'AAAA-BBBB-CCCC-DDDD' }, headers: { authorization: 'Bearer ' + annaTok }, ck: false });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /ogiltig/i);
  // Koden från admin (med reläets adress som värdnamn)
  const { data: code } = await adminApi('codes', { method: 'POST', body: { host: '127.0.0.1' } });
  assert.match(code.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  const ok = await req(H, '/api/relay/pair', { method: 'POST', body: { url: R + '/', code: code.code.toLowerCase(), name: 'Hemma' }, headers: { authorization: 'Bearer ' + annaTok }, ck: false });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.paired, true); assert.equal(ok.data.url, R);
  assert.equal(ok.data.secret, undefined, 'hemligheten lämnas aldrig ut');
  assert.ok(!JSON.stringify(ok.data).includes(D.getSetting('relay_secret')));
  await waitFor(() => relay.status().connected, 15000, 'tunneln');
  // Engångskod: samma kod igen nekas
  const again = await req(H, '/api/relay/pair', { method: 'POST', body: { url: R, code: code.code }, headers: { authorization: 'Bearer ' + annaTok }, ck: false });
  assert.equal(again.status, 400);
  assert.equal(relay.status().connected, true, 'ett misslyckat försök lämnar den fungerande parningen orörd');
  // Para igen med startkoden (loggad vid start)
  const ok2 = await req(H, '/api/relay/pair', { method: 'POST', body: { url: R, code: startCode() }, headers: { authorization: 'Bearer ' + annaTok }, ck: false });
  assert.equal(ok2.status, 200, JSON.stringify(ok2.data));
  await waitFor(() => relay.status().connected, 15000, 'tunneln');
  const st = (await adminApi('status')).data;
  assert.equal(st.servers.filter(s => s.connected).length, 1);
  // Reläets datafil: bara läsbar för ägaren
  const mode = fs.statSync(path.join(ROOT, 'relaydata', 'relay.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  // Admin-routen genom reläet: nekad (räknas aldrig som betrott nät)
  assert.equal((await req(R, '/api/relay', { headers: { authorization: 'Bearer ' + annaTok }, ck: false })).status, 403);
  assert.equal((await req(R, '/api/relay', { method: 'DELETE', headers: { authorization: 'Bearer ' + annaTok }, ck: false })).status, 403);
});

// ---------------- vanlig användning ----------------
test('inloggning, API och bilder genom reläet', async () => {
  const s = await req(R, '/api/status', { ck: false });
  assert.equal(s.status, 200); assert.equal(s.data.name, 'BraXhn TV'); assert.equal(s.data.needsSetup, false);
  const li = await req(R, '/api/login', { method: 'POST', body: { name: 'bo', password: PW } });
  assert.equal(li.status, 200, JSON.stringify(li.data));
  assert.ok(cookie, 'inloggningskakan kommer fram genom reläet');
  const me = await req(R, '/api/status');
  assert.equal(me.data.user.name, 'bo'); assert.equal(me.data.remote, true, 'reläet räknas som utanför hemmet');
  const items = await req(R, `/api/items/${FILM_ID}`);
  assert.equal(items.status, 200); assert.equal(items.data.id ?? items.data.item?.id, FILM_ID);
  // Bilder (bildroute) och statiska filer
  const img = await req(R, `/api/image/${FILM_ID}/poster`, { raw: true });
  assert.equal(img.status, 200); assert.ok(img.data.equals(POSTER));
  const icon = await req(R, '/icon.png', { raw: true, ck: false });
  assert.equal(icon.status, 200); assert.ok(icon.data.equals(fs.readFileSync(path.join(REPO, 'web', 'icon.png'))));
  const index = await req(R, '/', { ck: false });
  assert.equal(index.status, 200); assert.match(index.data, /<html/i);
  // Parallella förfrågningar över samma tunnel
  const many = await Promise.all(Array.from({ length: 40 }, () => req(R, `/api/image/${FILM_ID}/poster`, { raw: true })));
  assert.ok(many.every(r => r.status === 200 && r.data.equals(POSTER)));
  // Felaktig inloggning: 401 som vanligt
  assert.equal((await req(R, '/api/login', { method: 'POST', body: { name: 'bo', password: 'fel' }, ck: false })).status, 401);
});

test('direktuppspelning med Range (206) och HEAD genom reläet', async () => {
  const file = fs.readFileSync(FILM);
  const r = await req(R, `/api/stream/${FILM_ID}/direct`, { headers: { range: 'bytes=1000-5999' }, raw: true });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 1000-5999/${file.length}`);
  assert.ok(r.data.equals(file.subarray(1000, 6000)));
  const tail = await req(R, `/api/stream/${FILM_ID}/direct`, { headers: { range: 'bytes=-100' }, raw: true });
  assert.ok(tail.data.equals(file.subarray(file.length - 100)));
  const head = await req(R, `/api/stream/${FILM_ID}/direct`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(+head.headers.get('content-length'), file.length);
  // Kortlivad mediatoken (Chromecast): fungerar via reläet för just den titeln
  const tok = auth.createSession(D.get("SELECT id FROM users WHERE name='bo'").id, 'media', { item: FILM_ID });
  assert.equal((await req(R, `/api/stream/${FILM_ID}/direct?t=${tok}`, { ck: false, headers: { range: 'bytes=0-9' }, raw: true })).status, 206);
  assert.equal((await req(R, `/api/stream/${STOR_ID}/direct?t=${tok}`, { ck: false, headers: { range: 'bytes=0-9' } })).status, 401, 'token för en annan titel');
});

test('HLS: spellista och segment genom reläet', { skip: !hasFfmpeg && 'ffmpeg saknas' }, async () => {
  const m = await req(R, `/api/stream/${FILM_ID}/hls/index.m3u8?mode=transcode&q=360`);
  assert.equal(m.status, 200); assert.match(m.data, /#EXTM3U/);
  const seg = await req(R, `/api/stream/${FILM_ID}/hls/seg-0.ts?mode=transcode&q=360`, { raw: true });
  assert.equal(seg.status, 200, seg.data.toString().slice(0, 200));
  assert.ok(seg.data.length > 1000 && seg.data[0] === 0x47, 'MPEG-TS');
  await req(R, `/api/stream/${FILM_ID}/stop`, { method: 'POST', body: {}, headers: { origin: R } });
});

test('SSE (Spela på…): händelser kommer fram direkt och strömmen hålls öppen', { timeout: 40000 }, async () => {
  const key = 'relatestnyckel-000001';
  const events = [];
  let wake = null;
  const r = http.get(`${R}/api/remote/events?key=${key}&name=Rel%C3%A4-TV`, { headers: { cookie } });
  const res = await new Promise((ok, no) => { r.on('response', ok); r.on('error', no); });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  let buf = '';
  res.setEncoding('utf8');
  res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.*)$/m.exec(b)?.[1]; if (ev) { events.push({ ev, data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] || 'null') }); wake?.(); } } });
  // 15 s: CI-maskinen kör ffmpeg-testerna parallellt; lokalt kommer händelserna på några millisekunder
  const next = (pred, what) => new Promise((ok, no) => { const t = setTimeout(() => no(new Error(`ingen händelse: ${what} (fick ${JSON.stringify(events.map(e => e.ev + ':' + (e.data?.name || '')))})`)), 15000); const chk = () => { const e = events.find(x => !x.used && pred(x)); if (e) { e.used = true; clearTimeout(t); ok(e); } else wake = chk; }; chk(); });
  const hello = await next(e => e.ev === 'hello', 'hello vid anslutning');
  // Ändra namnet med ett annat anrop – mottagaren får det över den öppna strömmen
  const put = await req(R, `/api/remote/devices/${hello.data.id}`, { method: 'PUT', body: { name: 'Nytt namn' }, headers: { origin: R } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  await next(e => e.ev === 'hello' && e.data.name === 'Nytt namn', 'hello med nytt namn');
  r.destroy();
});

test('stor fil genom reläet: mottrycket håller minnet nere (reläet och hemservern)', async (t) => {
  const rss0 = (await adminApi('status')).data.rss, home0 = process.memoryUsage().rss;
  let got = 0, peakRelay = rss0, peakHome = home0;
  await new Promise((ok, no) => {
    const r = http.get(`${R}/api/stream/${STOR_ID}/direct`, { headers: { cookie } }, (res) => (async () => {
      assert.equal(res.statusCode, 200);
      assert.equal(+res.headers['content-length'], BIG);
      res.on('data', (d) => { got += d.length; });
      res.on('end', ok); res.on('error', no);
      // Klienten läser långsamt: pausa två gånger och se att inget buffras upp i reläet eller hemma
      for (const at of [50, 300]) {
        await waitFor(() => got > at * 1048576, 60000, `${at} MB`);
        res.pause();
        await sleep(1500);
        const before = got;
        peakRelay = Math.max(peakRelay, (await adminApi('status')).data.rss);
        peakHome = Math.max(peakHome, process.memoryUsage().rss);
        assert.equal(got, before);
        res.resume();
      }
    })().catch(no));
    r.on('error', no);
  });
  assert.equal(got, BIG);
  t.diagnostic(`600 MB: reläets minne +${Math.round((peakRelay - rss0) / 1048576)} MB, hemserverns +${Math.round((peakHome - home0) / 1048576)} MB`);
  assert.ok(peakRelay - rss0 < 120 * 1048576, `reläets minne växte ${Math.round((peakRelay - rss0) / 1048576)} MB`);
  assert.ok(peakHome - home0 < 200 * 1048576, `hemserverns minne växte ${Math.round((peakHome - home0) / 1048576)} MB`);
  const s = relay.status();
  assert.ok(s.bytesOut > BIG, 'trafiken räknas');
});

// ---------------- säkerhet ----------------
test('via reläet är man alltid utanför hemmet: admin nekas, curate kräver 2FA bara om ägaren valt det, hemmakonton nekas, X-Forwarded-For ignoreras', async () => {
  const A = { authorization: 'Bearer ' + annaTok };
  const spoof = { 'x-forwarded-for': '192.168.1.10', 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1' };
  // Direkt från loopback (betrott nät): tillåtet
  assert.equal((await req(H, '/api/settings', { headers: A, ck: false })).status, 200);
  assert.equal((await req(H, `/api/items/${FILM_ID}/metadata`, { headers: A, ck: false })).status, 200);
  // Via reläet, även med förfalskade proxyrubriker
  for (const h of [A, { ...A, ...spoof }]) {
    const s = await req(R, '/api/settings', { headers: h, ck: false });
    assert.equal(s.status, 403); assert.match(s.data.error, /hemnätverket/);
    // Rätta matchning: tillåtet för admin utanför hemmet som standard, nekas när ägaren kräver 2FA
    assert.equal((await req(R, `/api/items/${FILM_ID}/metadata`, { headers: h, ck: false })).status, 200);
    D.setSetting('curate_require_2fa', '1');
    try {
      const cu = await req(R, `/api/items/${FILM_ID}/metadata`, { headers: h, ck: false });
      assert.equal(cu.status, 403, 'curate kräver tvåstegsverifiering när kravet är på');
    } finally { D.setSetting('curate_require_2fa', '0'); }
    const st = await req(R, '/api/status', { headers: h, ck: false });
    assert.equal(st.data.user.adminHere, false); assert.equal(st.data.remote, true);
  }
  // Konto utan fjärråtkomst: nekas via reläet, fungerar hemma
  assert.equal((await req(R, '/api/login', { method: 'POST', body: { name: 'hemma', password: PW }, headers: spoof, ck: false })).status, 403);
  assert.equal((await req(H, '/api/login', { method: 'POST', body: { name: 'hemma', password: PW }, ck: false })).status, 200);
  // Första kontot/installationen kan aldrig skapas via reläet
  assert.equal((await req(R, '/api/status', { ck: false })).data.needsSetup, false);
  // Säkerhetsloggen: klientens adress från reläet, inte från klientens egna rubriker
  await req(R, '/api/login', { method: 'POST', body: { name: 'bo', password: 'fel-igen' }, headers: { 'x-forwarded-for': '203.0.113.77' }, ck: false });
  const last = D.get("SELECT ip FROM audit WHERE event='login_fail' ORDER BY id DESC LIMIT 1");
  assert.equal(last.ip, '127.0.0.1');
});

test('förfalskade och oparade tunnlar nekas', async () => {
  const id = D.getSetting('relay_server');
  const up = (h) => rawReq(`GET /_relay/tunnel HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: braxhn-relay/1\r\n${h}\r\n`);
  const nonce = async (sid = id) => (await req(R, `/_relay/challenge?server=${sid}`, { ck: false })).data.nonce;
  const cn = crypto.randomBytes(16).toString('hex');
  // Okänd server, utan utmaning, fel bevis, gammal utmaning (engångs) och fel hemlighet
  assert.match(await up(`X-BraXhn-Server: finnsinte\r\nX-BraXhn-Nonce: ${await nonce('finnsinte')}\r\nX-BraXhn-Cnonce: ${cn}\r\nX-BraXhn-Proof: ${'0'.repeat(64)}\r\n`), /^HTTP\/1\.1 401/);
  assert.match(await up(`X-BraXhn-Server: ${id}\r\nX-BraXhn-Nonce: ${'a'.repeat(48)}\r\nX-BraXhn-Cnonce: ${cn}\r\nX-BraXhn-Proof: ${'0'.repeat(64)}\r\n`), /^HTTP\/1\.1 401/);
  const n1 = await nonce();
  assert.match(await up(`X-BraXhn-Server: ${id}\r\nX-BraXhn-Nonce: ${n1}\r\nX-BraXhn-Cnonce: ${cn}\r\nX-BraXhn-Proof: ${crypto.createHmac('sha256', 'gissning').update(`tunnel|${id}|${n1}|${cn}`).digest('hex')}\r\n`), /^HTTP\/1\.1 401/);
  // Rätt bevis men utmaningen är redan förbrukad (återspelning)
  const secret = Buffer.from(D.getSetting('relay_secret'), 'base64url');
  const proof = crypto.createHmac('sha256', secret).update(`tunnel|${id}|${n1}|${cn}`).digest('hex');
  assert.match(await up(`X-BraXhn-Server: ${id}\r\nX-BraXhn-Nonce: ${n1}\r\nX-BraXhn-Cnonce: ${cn}\r\nX-BraXhn-Proof: ${proof}\r\n`), /^HTTP\/1\.1 401/);
  // Andra uppgraderingar (WebSocket) skickas aldrig vidare
  assert.match(await rawReq('GET /api/status HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'), /^HTTP\/1\.1 501/);
  // Frånkoppling kräver beviset
  assert.equal((await req(R, '/_relay/unpair', { method: 'POST', body: { server: id, nonce: await nonce(), cnonce: cn, proof: '0'.repeat(64) }, ck: false })).status, 401);
  // Tunneln är kvar
  assert.equal(relay.status().connected, true);
  assert.equal((await req(R, '/api/status', { ck: false })).status, 200);
});

test('reläet är ingen öppen proxy: absoluta adresser och CONNECT når bara den parade servern', async () => {
  const hits = [];
  const target = http.createServer((q, r) => { hits.push(q.url); r.end('hemligt'); });
  await new Promise(r => target.listen(0, '127.0.0.1', r));
  const tp = target.address().port;
  const abs = await rawReq(`GET http://127.0.0.1:${tp}/hemligt HTTP/1.1\r\nHost: 127.0.0.1:${tp}\r\nConnection: close\r\n\r\n`);
  assert.doesNotMatch(abs, /hemligt$/m);
  const conn = await rawReq(`CONNECT 127.0.0.1:${tp} HTTP/1.1\r\nHost: 127.0.0.1:${tp}\r\n\r\n`);
  assert.doesNotMatch(conn, /^HTTP\/1\.1 200/);
  await req(R, '/api/status', { ck: false, headers: { host: `127.0.0.1:${tp}` } });
  target.close();
  assert.deepEqual(hits, [], 'målet nåddes aldrig');
  // Reläets svar på för stora uppladdningar (Content-Length över gränsen) utan att något skickas vidare
  const big = await rawReq(`POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${600 * 1048576}\r\nConnection: close\r\n\r\n`);
  assert.match(big, /^HTTP\/1\.1 413/);
});

test('återanslutning när reläet startas om – och tunneln stängs när servern tas bort på reläet', async () => {
  await stopRelay();
  await waitFor(() => !relay.status().connected, 10000, 'frånkopplingen');
  assert.ok(relay.status().lastError);
  relayLog = '';
  await startRelay();
  assert.equal(startCode(), undefined, 'ingen ny kod loggas när en server redan är parad och admintoken finns');
  await waitFor(() => relay.status().connected, 20000, 'återanslutningen');
  assert.ok(relay.status().reconnects >= 1);
  const r = await req(R, `/api/stream/${FILM_ID}/direct`, { headers: { range: 'bytes=0-99' }, raw: true });
  assert.equal(r.status, 206);
  // Koppla bort från hemservern: reläet glömmer servern
  const del = await req(H, '/api/relay', { method: 'DELETE', headers: { authorization: 'Bearer ' + annaTok }, ck: false });
  assert.equal(del.status, 200); assert.equal(del.data.relayForgot, true); assert.equal(del.data.paired, false);
  assert.equal((await adminApi('status')).data.servers.length, 0);
  assert.equal((await req(R, '/api/status', { ck: false })).status, 404);
  assert.equal(D.getSetting('relay_secret'), '');
});

test('hemservern ansluter inte till ett relä som inte kan bevisa hemligheten', async () => {
  // Ett falskt relä (t.ex. fel DNS-post): utmaningen fungerar, men beviset i 101-svaret är fel
  let upgraded = 0;
  const fake = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ nonce: 'ab'.repeat(24) })); });
  fake.on('upgrade', (q, sock) => { upgraded++; sock.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: braxhn-relay/1\r\nX-BraXhn-Proof: ${'0'.repeat(64)}\r\n\r\n`); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  D.setSetting('relay_url', `http://127.0.0.1:${fake.address().port}`); D.setSetting('relay_server', 'falsk'); D.setSetting('relay_secret', crypto.randomBytes(32).toString('base64url'));
  relay.reconnect();
  await waitFor(() => upgraded > 0 && relay.status().lastError, 10000, 'försöket');
  assert.equal(relay.status().connected, false);
  assert.match(relay.status().lastError, /bevisa/);
  await relay.unpair();
  fake.closeAllConnections?.(); fake.close();
});
