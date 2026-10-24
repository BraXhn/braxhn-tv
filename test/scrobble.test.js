// Scrobbling av musik till ListenBrainz och Last.fm mot låtsasservrar: koppling (token, webbinloggning med signerade
// anrop), "spelas nu", regeln för när en lyssning räknas, kön vid fel (backoff, max ålder, inga dubbletter),
// barnprofiler och att token/sessionsnycklar aldrig syns i API-svar. Modulen testas i samma process; routes och
// kopplingen till POST /played mot en riktig server. Kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-scrobble-'));
const LB_TOKEN = 'lb-token-0123456789abcdef', LF_KEY = 'lfkey-test', LF_SECRET = 'lfsecret-test', LF_SK = 'lf-session-key-hemlig';

// ---------- låtsasservrar ----------
const lb = { listens: [], playing: [], down: false, revoked: false };
const lf = { scrobbles: [], playing: [], down: false, approved: new Set(), badSig: 0, tokens: 0 };
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const fake = http.createServer((q, r) => {
  let b = ''; q.on('data', d => b += d);
  q.on('end', () => {
    const J = (o, s = 200) => { r.writeHead(s, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
    const u = new URL(q.url, 'http://x');
    if (u.pathname.startsWith('/lb/')) {
      if (lb.down) return J({ error: 'nere' }, 503);
      const ok = q.headers.authorization === `Token ${LB_TOKEN}` && !lb.revoked;
      if (u.pathname === '/lb/1/validate-token') return J(ok ? { code: 200, valid: true, user_name: 'anna_lb' } : { code: 200, valid: false, message: 'Invalid' });
      if (u.pathname === '/lb/1/submit-listens' && q.method === 'POST') {
        if (!ok) return J({ code: 401, error: 'Invalid authorization token.' }, 401);
        const j = JSON.parse(b);
        if (j.listen_type === 'playing_now') lb.playing.push(j.payload[0]); else lb.listens.push(...j.payload.map(p => ({ ...p, type: j.listen_type })));
        return J({ status: 'ok' });
      }
      return J({}, 404);
    }
    if (u.pathname === '/lf/2.0/') {
      if (lf.down) return J({ error: 16, message: 'Tillfälligt nere' }, 503);
      const p = Object.fromEntries(q.method === 'POST' ? new URLSearchParams(b) : u.searchParams);
      // Signaturen enligt Last.fm: sorterade parametrar (utan format/callback) + secret, md5
      const sig = md5(Object.keys(p).filter(k => !['format', 'callback', 'api_sig'].includes(k)).sort().map(k => k + p[k]).join('') + LF_SECRET);
      if (p.api_key !== LF_KEY) return J({ error: 10, message: 'Invalid API key' }, 403);
      if (p.api_sig !== sig) { lf.badSig++; return J({ error: 13, message: 'Invalid method signature supplied' }, 403); }
      if (p.method === 'auth.getToken') return J({ token: `tok${++lf.tokens}` });
      if (p.method === 'auth.getSession') return lf.approved.has(p.token) ? J({ session: { name: 'anna_fm', key: LF_SK, subscriber: 0 } }) : J({ error: 14, message: 'Unauthorized Token' }, 403);
      if (p.sk !== LF_SK) return J({ error: 9, message: 'Invalid session key' }, 403);
      if (p.method === 'track.updateNowPlaying' && q.method === 'POST') { lf.playing.push(p); return J({ nowplaying: {} }); }
      if (p.method === 'track.scrobble' && q.method === 'POST') {
        for (let i = 0; p[`artist[${i}]`]; i++) lf.scrobbles.push({ artist: p[`artist[${i}]`], track: p[`track[${i}]`], timestamp: +p[`timestamp[${i}]`], album: p[`album[${i}]`], duration: p[`duration[${i}]`] });
        return J({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } });
      }
      return J({ error: 3, message: 'Invalid method' }, 400);
    }
    J({}, 404);
  });
}).listen(0);
await new Promise(r => fake.once('listening', r));
const FB = `http://127.0.0.1:${fake.address().port}`;
const ENV = { LISTENBRAINZ_API: FB + '/lb', LASTFM_API: FB + '/lf/2.0/', LASTFM_AUTH_URL: FB + '/lfauth/', LASTFM_API_KEY: LF_KEY, LASTFM_SECRET: LF_SECRET, SCROBBLE_INTERVAL: '0' };
Object.assign(process.env, ENV, { CONFIG_DIR: path.join(ROOT, 'config'), TRANSCODE_DIR: path.join(ROOT, 'tc'), DVR_DIR: path.join(ROOT, 'rec'), PODCAST_DIR: path.join(ROOT, 'pod') });
after(() => { fake.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const { run, get, all } = await import('../server/db.js');
const S = await import('../server/scrobble.js');

run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
run("INSERT INTO users(id,name,pass,is_admin,created,parent_id,max_age) VALUES(2,'barn','x',0,0,1,7)");
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(3,'bo','x',0,0)");
const ANNA = { id: 1, max_age: null }, BARN = { id: 2, max_age: 7 }, BO = { id: 3, max_age: null };
run("INSERT INTO libraries(id,name,type,path) VALUES(1,'Musik','music','/x')");
run("INSERT INTO artists(id,library_id,name) VALUES(1,1,'Robyn'),(2,1,'Okänd artist')");
run("INSERT INTO albums(id,library_id,artist_id,title,added) VALUES(1,1,1,'Body Talk',0),(2,1,2,'Okänt',0)");
const track = (id, title, dur, album = 1, artist = 1) => run('INSERT INTO tracks(id,library_id,album_id,artist_id,title,track_no,duration,path,added) VALUES(?,1,?,?,?,?,?,?,0)', id, album, artist, title, id, dur, `/x/${id}.mp3`);
track(1, 'Dancing On My Own', 288); track(2, 'Hang With Me', 100); track(3, 'Kort intro', 20); track(4, 'Långt mixband', 3600); track(5, 'Utan artist', 200, 2, 2);

const queue = (uid = 1) => all('SELECT * FROM scrobble_queue WHERE user_id=? ORDER BY listened_at, service', uid);
const T0 = Math.floor(Date.now() / 1000) - 3600;

test('regler: tröskel, korta spår, backoff och Last.fm-signatur', () => {
  assert.equal(S.threshold(288), 144, 'halva spåret');
  assert.equal(S.threshold(3600), 240, 'högst 4 minuter');
  assert.equal(S.threshold(0), 240, 'okänd längd: 4 minuter');
  assert.equal(S.scrobblable(20), false); assert.equal(S.scrobblable(30), true); assert.equal(S.scrobblable(null), true);
  assert.deepEqual([1, 2, 3, 10, 30].map(S.backoff), [60, 120, 240, 6 * 3600, 6 * 3600]);
  assert.equal(S.lastfmSig({ method: 'auth.getToken', api_key: 'k', format: 'json' }, 's'), md5('api_keykmethodauth.getTokens'));
});

test('ListenBrainz: token valideras och lämnas aldrig ut', async () => {
  await assert.rejects(S.connectListenBrainz(1, 'kort'), /användartoken/);
  await assert.rejects(S.connectListenBrainz(1, 'fel-token-0123456789'), /godtar inte/);
  assert.equal(S.info(ANNA).listenbrainz.connected, false);
  assert.deepEqual(await S.connectListenBrainz(1, '  ' + LB_TOKEN + ' '), { username: 'anna_lb' });
  const i = S.info(ANNA);
  assert.equal(i.listenbrainz.connected, true); assert.equal(i.listenbrainz.username, 'anna_lb'); assert.equal(i.allowed, true);
  assert.ok(!JSON.stringify(i).includes(LB_TOKEN), 'token syns inte i status');
});

test('Last.fm: webbinloggning med signerade anrop', async () => {
  assert.equal(S.info(ANNA).lastfm.available, true);
  assert.deepEqual(await S.pollLastfm(1), { status: 'none' });
  const { url } = await S.startLastfm(1);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, FB + '/lfauth/'); assert.equal(u.searchParams.get('api_key'), LF_KEY);
  const tok = u.searchParams.get('token'); assert.ok(tok);
  assert.deepEqual(await S.pollLastfm(1), { status: 'pending' }, 'inte godkänd än');
  lf.approved.add(tok);
  assert.deepEqual(await S.pollLastfm(1), { status: 'connected', username: 'anna_fm' });
  assert.equal(lf.badSig, 0, 'alla signaturer stämmer');
  const i = S.info(ANNA);
  assert.equal(i.lastfm.connected, true); assert.equal(i.lastfm.username, 'anna_fm');
  assert.ok(!JSON.stringify(i).includes(LF_SK), 'sessionsnyckeln syns inte');
});

test('lyssning: spelas nu vid start, räknas efter halva spåret, överhoppat spår räknas inte', async () => {
  await S.played(ANNA, 1, T0);
  assert.equal(lb.playing.length, 1); assert.equal(lb.playing[0].track_metadata.track_name, 'Dancing On My Own');
  assert.equal(lb.playing[0].track_metadata.artist_name, 'Robyn'); assert.equal(lb.playing[0].track_metadata.release_name, 'Body Talk');
  assert.equal(lf.playing.length, 1); assert.equal(lf.playing[0].track, 'Dancing On My Own'); assert.equal(lf.playing[0].duration, '288');
  assert.equal(queue().length, 2, 'en väntande lyssning per tjänst');
  assert.ok(queue().every(r => r.due === T0 + 144));
  // Samma spår anmält igen strax efter (appen/omladdning): räknas en gång
  await S.played(ANNA, 1, T0 + 5);
  assert.equal(queue().length, 2); assert.equal(lb.playing.length, 1);
  // Inte räknat än
  assert.deepEqual(await S.processQueue(T0 + 100), { sent: 0, failed: 0 });
  // Nästa spår startar efter 200 s: det första räknas (≥ 50 %), det andra hoppas över efter 20 s
  await S.played(ANNA, 2, T0 + 200);
  await S.played(ANNA, 4, T0 + 220);
  assert.deepEqual(queue().map(r => r.title), ['Dancing On My Own', 'Dancing On My Own', 'Långt mixband', 'Långt mixband']);
  assert.ok(queue().filter(r => r.track_id === 4).every(r => r.due === T0 + 220 + 240), 'långt spår: 4 minuter');
  // Korta spår: spelas nu, men ingen lyssning
  await S.played(ANNA, 3, T0 + 900);
  assert.equal(lf.playing.at(-1).track, 'Kort intro');
  assert.equal(queue().length, 4, 'mixbandet spelades i 680 s och räknas, introt köas inte');
  // Spår utan känd artist skickas inte alls
  const before = lb.playing.length;
  await S.played(ANNA, 5, T0 + 1000);
  assert.equal(lb.playing.length, before); assert.equal(queue().length, 4);
  assert.deepEqual(await S.processQueue(T0 + 1000), { sent: 4, failed: 0 });
  assert.deepEqual(lb.listens.map(l => [l.listened_at, l.track_metadata.track_name, l.type]), [[T0, 'Dancing On My Own', 'import'], [T0 + 220, 'Långt mixband', 'import']]);
  assert.deepEqual(lf.scrobbles.map(s => [s.timestamp, s.track, s.album]), [[T0, 'Dancing On My Own', 'Body Talk'], [T0 + 220, 'Långt mixband', 'Body Talk']]);
  assert.equal(queue().length, 0);
  assert.ok(S.info(ANNA).listenbrainz.lastSent > 0);
  assert.equal(lf.badSig, 0);
});

test('kö: tjänsten nere → nytt försök med backoff, inga dubbletter, för gamla tas bort', async () => {
  lb.listens.length = 0; lf.scrobbles.length = 0;
  lb.down = true; lf.down = true;
  const t = T0 + 2000;
  await S.played(ANNA, 2, t); // "spelas nu" misslyckas tyst
  await S.played(ANNA, 1, t + 100);
  assert.deepEqual(await S.processQueue(t + 60), { sent: 0, failed: 2 });
  let q = queue().filter(r => r.track_id === 2);
  assert.ok(q.every(r => r.attempts === 1 && r.next_try === t + 60 + 60 && /svarade 503|nere/i.test(r.error)), JSON.stringify(q));
  assert.deepEqual(await S.processQueue(t + 90), { sent: 0, failed: 0 }, 'väntar till nästa försök');
  assert.deepEqual(await S.processQueue(t + 120), { sent: 0, failed: 2 });
  assert.ok(queue().filter(r => r.track_id === 2).every(r => r.attempts === 2 && r.next_try === t + 120 + 120));
  lb.down = false; lf.down = false;
  assert.deepEqual(await S.processQueue(t + 240), { sent: 2, failed: 0 }, 'spår 2 skickas; spår 1 räknas först efter 144 s');
  assert.deepEqual(await S.processQueue(t + 240), { sent: 0, failed: 0 }, 'inget skickas två gånger');
  assert.deepEqual(lb.listens.map(l => [l.listened_at, l.type]), [[t, 'single']]);
  assert.deepEqual(lf.scrobbles.map(s => s.timestamp), [t]);
  // Samma lyssning kan inte köas två gånger (unik per tjänst, tid och titel)
  run(`INSERT OR IGNORE INTO scrobble_queue(user_id,service,track_id,artist,title,listened_at,due) VALUES(1,'lastfm',1,'Robyn','Dancing On My Own',?,?)`, t + 100, t + 244);
  assert.equal(queue().filter(r => r.track_id === 1).length, 2);
  // Max ålder: Last.fm tar inte emot lyssningar äldre än 14 dagar, ListenBrainz (här) 30 dagar
  lb.listens.length = 0; lf.scrobbles.length = 0;
  const late = t + 100 + 15 * 86400;
  assert.deepEqual(await S.processQueue(late), { sent: 1, failed: 0 });
  assert.equal(lf.scrobbles.length, 0, 'för gammal för Last.fm');
  assert.deepEqual(lb.listens.map(l => l.listened_at), [t + 100]);
  assert.equal(queue().length, 0);
});

test('kopplingen gäller inte längre: lyssningarna väntar, ingen "spelas nu", ny koppling skickar dem', async () => {
  lb.listens.length = 0; lb.revoked = true;
  const t = T0 + 3000;
  await S.played(ANNA, 2, t);
  await S.played(ANNA, 1, t + 100);
  await S.processQueue(t + 100);
  assert.match(S.info(ANNA).listenbrainz.error, /koppla igen/);
  assert.equal(queue().filter(r => r.service === 'listenbrainz').length, 2, 'ligger kvar');
  assert.deepEqual(lf.scrobbles.map(s => s.timestamp).slice(-1), [t], 'Last.fm påverkas inte');
  const n = lb.playing.length;
  await S.played(ANNA, 4, t + 300);
  assert.equal(lb.playing.length, n, 'ingen "spelas nu" medan kopplingen är trasig');
  assert.equal(S.info(ANNA, t + 300).listenbrainz.queued, 2, 'spår 1 räknades när mixbandet startade');
  lb.revoked = false;
  await S.connectListenBrainz(1, LB_TOKEN);
  assert.equal(S.info(ANNA).listenbrainz.error, null);
  await S.processQueue(t + 300);
  assert.deepEqual(lb.listens.map(l => l.listened_at), [t, t + 100]);
});

test('barnprofiler ärver ingen koppling och kan inte scrobbla; andra personer påverkas inte', async () => {
  const n = lb.playing.length, m = lf.playing.length;
  await S.played(BARN, 1, T0 + 5000);
  await S.played(BO, 1, T0 + 5000);
  assert.equal(lb.playing.length, n); assert.equal(lf.playing.length, m);
  assert.equal(queue(2).length, 0); assert.equal(queue(3).length, 0);
  const k = S.info(BARN);
  assert.equal(k.allowed, false); assert.equal(k.listenbrainz.connected, false); assert.equal(k.lastfm.connected, false);
  // Annas pågående lyssning störs inte av att någon annan startar ett spår
  assert.ok(queue(1).some(r => r.track_id === 4));
});

test('koppla från tar bort kopplingen och dess kö', () => {
  assert.ok(queue().some(r => r.service === 'lastfm'));
  S.disconnect(1, 'lastfm');
  assert.equal(S.info(ANNA).lastfm.connected, false);
  assert.ok(!queue().some(r => r.service === 'lastfm'));
  assert.ok(get("SELECT 1 FROM scrobble_accounts WHERE user_id=1 AND service='listenbrainz'"));
});

// ---------- HTTP: routes och kopplingen till /played (webben och apparna) ----------
test('http: Mitt konto-routes, /played skickar "spelas nu", barnprofil nekas, hemligheter syns inte', async () => {
  const PORT = 19900 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`;
  const cfg = path.join(ROOT, 'srv');
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, ...ENV, LASTFM_API_KEY: '', LASTFM_SECRET: '', PORT: String(PORT), HTTPS_PORT: String(PORT + 1), CONFIG_DIR: cfg, MEDIA_ROOT: path.join(ROOT, 'media'),
      TRANSCODE_DIR: path.join(cfg, 'tc'), DVR_DIR: path.join(cfg, 'rec'), PODCAST_DIR: path.join(cfg, 'pod'), DLNA_SSDP: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
    let cookie = '';
    const req = async (p, { method = 'GET', body } = {}) => {
      const r = await fetch(B + p, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc)) cookie = sc.split(';')[0];
      const t = await r.text();
      return { status: r.status, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() };
    };
    assert.equal((await req('/api/me/scrobble')).status, 401);
    assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: 'Testlösen-2026!' } })).status, 200);
    let s = await req('/api/me/scrobble');
    assert.equal(s.status, 200); assert.equal(s.json.allowed, true);
    assert.equal(s.json.lastfm.available, false, 'utan API-nyckel: kräver nyckel');
    assert.equal((await req('/api/me/scrobble/lastfm/connect', { method: 'POST' })).status, 400);
    assert.equal((await req('/api/me/scrobble/listenbrainz', { method: 'PUT', body: { token: 'fel-token-0123456789' } })).status, 400);
    s = await req('/api/me/scrobble/listenbrainz', { method: 'PUT', body: { token: LB_TOKEN } });
    assert.equal(s.status, 200); assert.equal(s.json.listenbrainz.username, 'anna_lb'); assert.ok(!s.text.includes(LB_TOKEN));
    // Last.fm-nyckeln från Administration: syns som satt, secret lämnas aldrig ut
    assert.equal((await req('/api/integrations', { method: 'PUT', body: { lastfmApiKey: LF_KEY, lastfmSecret: LF_SECRET } })).status, 200);
    const I = await req('/api/integrations');
    assert.equal(I.json.lastfmApiKey, LF_KEY); assert.equal(I.json.lastfmSecretSet, true); assert.ok(!I.text.includes(LF_SECRET));
    s = await req('/api/me/scrobble');
    assert.equal(s.json.lastfm.available, true); assert.ok(!s.text.includes(LB_TOKEN));
    const c = await req('/api/me/scrobble/lastfm/connect', { method: 'POST' });
    assert.equal(c.status, 200); assert.match(c.json.url, /\/lfauth\/\?api_key=lfkey-test&token=tok\d+/);
    assert.equal((await req('/api/me/scrobble/lastfm/poll', { method: 'POST' })).json.status, 'pending');
    lf.approved.add(new URL(c.json.url).searchParams.get('token'));
    assert.equal((await req('/api/me/scrobble/lastfm/poll', { method: 'POST' })).json.status, 'connected');
    s = await req('/api/me/scrobble');
    assert.equal(s.json.lastfm.username, 'anna_fm'); assert.ok(!s.text.includes(LF_SK));
    // Ett spår i serverns databas; /played (som webben, iOS och Android anropar vid start) ger "spelas nu"
    const d = new DatabaseSync(path.join(cfg, 'braxhn-tv.db'));
    d.exec(`INSERT INTO libraries(id,name,type,path) VALUES(9,'Musik','music','/x'); INSERT INTO artists(id,library_id,name) VALUES(9,9,'Kent');
      INSERT INTO albums(id,library_id,artist_id,title,added) VALUES(9,9,9,'Isola',0);
      INSERT INTO tracks(id,library_id,album_id,artist_id,title,duration,path,added) VALUES(9,9,9,9,'747',420,'/x/747.mp3',0)`);
    d.close();
    const nLb = lb.playing.length, nLf = lf.playing.length;
    assert.equal((await req('/api/music/tracks/9/played', { method: 'POST', body: {} })).status, 200);
    for (let i = 0; i < 50 && (lb.playing.length === nLb || lf.playing.length === nLf); i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(lb.playing.at(-1).track_metadata.track_name, '747'); assert.equal(lf.playing.at(-1).artist, 'Kent');
    // Barnprofil: egen status utan förälderns koppling, får inte koppla
    assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: '7' } })).status, 200);
    const kid = (await req('/api/profiles')).json.profiles.find(p => p.name === 'Lisa');
    assert.equal((await req('/api/profiles/switch', { method: 'POST', body: { id: kid.id } })).status, 200);
    s = await req('/api/me/scrobble');
    assert.equal(s.json.allowed, false); assert.equal(s.json.listenbrainz.connected, false); assert.equal(s.json.lastfm.connected, false);
    assert.equal((await req('/api/me/scrobble/listenbrainz', { method: 'PUT', body: { token: LB_TOKEN } })).status, 403);
    assert.equal((await req('/api/me/scrobble/lastfm/connect', { method: 'POST' })).status, 403);
    const n2 = lb.playing.length;
    assert.equal((await req('/api/music/tracks/9/played', { method: 'POST', body: {} })).status, 200);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(lb.playing.length, n2, 'barnprofilens lyssning skickas inte');
    assert.equal((await req('/api/me/scrobble/okand', { method: 'DELETE' })).status, 404);
  } finally { srv.kill(); await new Promise(r => srv.once('exit', r)); }
});
