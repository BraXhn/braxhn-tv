// Tredje säkerhetsgranskningen (barnprofiler och hemnätet) mot en riktig server: barnprofiler ser inte vuxenkanalers namn,
// program eller logotyper i den universella sökningen, kan inte boka, lista eller spela inspelningar från kanaler över
// åldersgränsen och får inga poddar; en gissad PIN vid profilbyte spärras även på hemnätet; DLNA svarar inte på ett
// främmande värdnamn (DNS-rebinding från en webbplats) och en länk från en annan webbplats till /reset raderar inte
// Nedladdat. Behöver inte ffmpeg (inga mediafiler skannas).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './helpers/port.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-sec3-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let srv, admin = '', kid = '';
const S = {};

async function req(p, { method = 'GET', body, tok = admin, headers = {} } = {}) {
  const h = { ...headers };
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
const login = async () => (await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, tok: '' })).data.token;

before(async () => {
  fs.mkdirSync(MEDIA, { recursive: true });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', DLNA: '1', DLNA_IP: '127.0.0.1' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 100; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login();
  // Okänd åldersgräns tillåten för barnprofiler (då syns live-TV för barn) – kanalens egen gräns ska ändå gälla
  assert.equal((await req('/api/settings', { method: 'PUT', body: { allowUnrated: true } })).status, 200);
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Vuxen', pin: '4711' } })).status, 200);
  const list = (await req('/api/profiles')).data.profiles;
  S.kid = list.find(p => p.name === 'Lisa').id; S.adult = list.find(p => p.name === 'Vuxen').id;
  S.adminId = list.find(p => p.owner).id;
  kid = (await req('/api/profiles/switch', { method: 'POST', body: { id: S.kid } })).data.token;
  assert.ok(kid);
  admin = await login(); // profilbytet tog bort administratörens token

  // Live-TV: en barnkanal (okänd ålder) och en vuxenkanal (märkt vuxen = 18 år), program och en klar inspelning från vuxenkanalen
  const T = Math.floor(Date.now() / 1000);
  const rec = path.join(MEDIA, 'inspelning.mp4');
  fs.writeFileSync(rec, crypto.randomBytes(4096));
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`INSERT INTO tuners(id,kind,name,url,enabled) VALUES(1,'m3u','Lista','http://example.invalid/lista.m3u',1);
    INSERT INTO channels(id,tuner_id,number,name,logo,stream_url,group_name) VALUES(1,1,'1','Barnkanalen',NULL,'http://example.invalid/1.ts','Barn'),
      (2,1,'2','Hemlig vuxenkanal','http://example.invalid/logo.png','http://example.invalid/2.ts','Adult');
    INSERT INTO channel_ext(channel_id,adult) VALUES(2,1);
    INSERT INTO programs(id,channel_id,start,stop,title) VALUES(1,1,${T - 600},${T + 3600},'Barnprogrammet'),(2,2,${T - 600},${T + 3600},'Hemligt vuxenprogram'),
      (3,2,${T + 7200},${T + 9000},'Hemligt vuxenprogram');
    INSERT INTO recordings(id,channel_id,channel_name,title,start,stop,status,file,size,created_by,created)
      VALUES(1,2,'Hemlig vuxenkanal','Hemligt vuxenprogram',${T - 90000},${T - 86400},'done','${rec}',4096,${S.adminId},${T});
    INSERT INTO podcasts(id,url,title,added) VALUES(1,'https://example.invalid/feed','Vuxenpodden',${T});
    INSERT INTO podcast_episodes(id,podcast_id,guid,title,url,added) VALUES(1,1,'g1','Avsnitt ett','https://example.invalid/1.mp3',${T});`);
  db.close();
  // Logotypen finns redan i cachen (servern hämtar den annars från källan)
  fs.mkdirSync(path.join(CONFIG, 'images'), { recursive: true });
  const logo = path.join(CONFIG, 'images', `ch2-${crypto.createHash('sha1').update('http://example.invalid/logo.png').digest('hex').slice(0, 10)}.img`);
  fs.writeFileSync(logo, Buffer.concat([Buffer.from('image/png'.padEnd(32)), Buffer.from('PNGDATA')]));
});
after(async () => {
  if (srv && srv.exitCode == null) { const done = new Promise(r => srv.once('exit', r)); srv.kill('SIGTERM'); await done; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('universell sökning: barnprofilen ser inte vuxenkanalens namn eller program (administratören gör det)', async () => {
  const a = (await req('/api/search/all?q=hemlig')).data;
  assert.deepEqual(a.channels.map(c => c.id), [2]);
  assert.deepEqual(a.programs.map(p => p.channel_id), [2]);
  const k = (await req('/api/search/all?q=hemlig', { tok: kid })).data;
  assert.deepEqual(k.channels, []);
  assert.deepEqual(k.programs, []);
  // Barnkanalen syns fortfarande
  const k2 = (await req('/api/search/all?q=barn', { tok: kid })).data;
  assert.deepEqual(k2.channels.map(c => c.id), [1]);
  assert.deepEqual(k2.programs.map(p => p.channel_id), [1]);
});

test('kanallogotyp: barnprofilen får inte vuxenkanalens logotyp', async () => {
  assert.equal((await req('/api/live/logo/2')).status, 200);
  assert.equal((await req('/api/live/logo/2', { tok: kid })).status, 404);
});

test('inspelningar: barnprofilen kan inte lista, spela eller boka från en kanal över åldersgränsen', async () => {
  const a = (await req('/api/dvr')).data;
  assert.deepEqual(a.done.map(r => r.id), [1]);
  assert.equal((await req('/api/dvr/recordings/1/stream')).status, 200);
  const k = await req('/api/dvr', { tok: kid });
  assert.equal(k.status, 200);
  assert.deepEqual(k.data.done, []);
  assert.equal((await req('/api/dvr/recordings/1/play', { method: 'POST', tok: kid })).status, 404);
  assert.equal((await req('/api/dvr/recordings/1/stream', { tok: kid })).status, 404);
  assert.equal((await req('/api/dvr/program', { method: 'POST', tok: kid, body: { programId: 3 } })).status, 404);
  assert.equal((await req('/api/dvr/manual', { method: 'POST', tok: kid, body: { channelId: 2, start: Math.floor(Date.now() / 1000) + 3600, stop: Math.floor(Date.now() / 1000) + 7200, title: 'x' } })).status, 404);
  // Ingen bokning kom till
  assert.deepEqual((await req('/api/dvr')).data.scheduled, []);
});

test('poddar: barnprofilen får inga poddar, avsnitt eller strömmar (som menyn och sökningen)', async () => {
  assert.equal((await req('/api/podcasts')).data.podcasts.length, 1);
  const k = await req('/api/podcasts', { tok: kid });
  assert.equal(k.status, 200);
  assert.deepEqual([k.data.podcasts, k.data.latest], [[], []]);
  assert.equal((await req('/api/podcasts/1', { tok: kid })).status, 404);
  assert.equal((await req('/api/podcasts/episodes/1', { tok: kid })).status, 404);
  assert.equal((await req('/api/podcasts/episodes/1/play', { tok: kid })).status, 404);
  assert.equal((await req('/api/podcasts/episodes/1/stream', { tok: kid })).status, 404);
  assert.equal((await req('/api/podcasts/episodes/1/progress', { method: 'POST', tok: kid, body: { position: 10 } })).status, 404);
});

test('profilbyte: gissad PIN spärras även på hemnätet (rätt PIN efter fem fel nekas en stund)', async () => {
  // Egna adresser i hemnätet (via den betrodda proxyn 127.0.0.1), så att IP-spärren inte delas med andra tester
  const sw = (tok, ip, body) => req('/api/profiles/switch', { method: 'POST', tok, headers: { 'x-forwarded-for': ip }, body });
  // Utan PIN (appen frågar först) räknas inte som fel: tre sådana och fyra fel PIN – rätt PIN fungerar sedan
  for (let i = 0; i < 3; i++) assert.equal((await sw(kid, '192.168.50.7', { id: S.adult })).status, 401);
  for (let i = 0; i < 4; i++) assert.equal((await sw(kid, '192.168.50.7', { id: S.adult, pin: String(1000 + i) })).status, 401);
  const ok = await sw(kid, '192.168.50.7', { id: S.adult, pin: '4711' });
  assert.equal(ok.status, 200);
  kid = (await sw(ok.data.token, '192.168.50.8', { id: S.kid })).data.token; // tillbaka till barnprofilen
  assert.ok(kid);
  for (let i = 0; i < 5; i++) assert.equal((await sw(kid, '192.168.50.8', { id: S.adult, pin: String(2000 + i) })).status, 401, 'fel PIN');
  assert.equal((await sw(kid, '192.168.50.8', { id: S.adult, pin: '4711' })).status, 429, 'spärrad trots rätt PIN');
  assert.equal((await sw(kid, '192.168.50.9', { id: S.adult, pin: '4711' })).status, 429, 'spärren gäller profilen, inte bara adressen');
});

// fetch skriver alltid Host efter adressen – en webbläsare efter DNS-rebinding skickar angriparens namn
const rawStatus = (p, { method = 'GET', headers = {}, body = '' } = {}) => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); ok(res.statusCode); });
  r.on('error', no); r.end(body);
});
test('DLNA: svarar bara på serverns adress, inte på ett främmande värdnamn (DNS-rebinding)', async () => {
  assert.equal(await rawStatus('/dlna/description.xml', { headers: { host: `127.0.0.1:${PORT}` } }), 200);
  assert.equal(await rawStatus('/dlna/description.xml', { headers: { host: `angripare.example:${PORT}` } }), 403);
  assert.equal(await rawStatus('/dlna/control/ContentDirectory', { method: 'POST', headers: { host: 'rebind.angripare.example', 'content-type': 'text/xml', soapaction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' },
    body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ObjectID>0</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag></u:Browse></s:Body></s:Envelope>' }), 403);
});

test('/reset: en länk från en annan webbplats rensar bara cachen, aldrig Nedladdat', async () => {
  const r = await fetch(B + '/reset', { headers: { 'sec-fetch-site': 'cross-site' }, redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/reset?soft=1');
  assert.equal(r.headers.get('clear-site-data'), null);
  const own = await fetch(B + '/reset', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(own.headers.get('clear-site-data'), '"cache", "storage"');
  const typed = await fetch(B + '/reset', { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(typed.headers.get('clear-site-data'), '"cache", "storage"');
});

// Sist i filen: spärrar 127.0.0.1 för inloggning en stund
test('inloggning: en enhet i hemnätet kan inte kringgå gissningsspärren med påhittade hemadresser i X-Forwarded-For', async () => {
  const wrong = (xff) => req('/api/login', { method: 'POST', tok: '', headers: { 'x-forwarded-for': xff }, body: { name: 'admin', password: 'fel-' + xff } });
  for (let i = 1; i <= 10; i++) assert.equal((await wrong(`192.168.77.${i}`)).status, 401);
  // En ny påhittad adress räknas på samma avsändare – spärrad
  assert.equal((await wrong('192.168.77.200')).status, 429);
  assert.equal((await wrong('100.64.1.1')).status, 429);
  // En publik adress som proxyn lagt till räknas fortfarande för sig (internet via omvänd proxy påverkas inte)
  assert.equal((await wrong('81.2.3.4')).status, 401);
});
