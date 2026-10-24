// Webhooks för händelser och tittarstatistik/historik: uppspelningens tillstånd (play/pause/resume/stop/scrobble) ur
// framstegsanropen, leverans mot en låtsasserver (HMAC-signatur, omförsök med backoff, händelsefilter, Discord-format,
// spärr mot lokala adresser utan uttryckligt tillstånd), statistikfrågor och filter, CSV-export och behörighet
// (barnprofiler ser bara sin egen historik, administratören allt). Körs i samma process; kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-wh-'));
const MEDIA = path.join(ROOT, 'media');
Object.assign(process.env, { CONFIG_DIR: path.join(ROOT, 'config'), TRANSCODE_DIR: path.join(ROOT, 'tc'), MEDIA_ROOT: MEDIA, WATCH_FILES: '0',
  WEBHOOK_INTERVAL: '0', PLAY_STOP_GRACE: '0', NEW_EPISODE_NOTIFY_DELAY: '0', DVR_DIR: path.join(ROOT, 'rec'), PODCAST_DIR: path.join(ROOT, 'pod') });
fs.mkdirSync(MEDIA, { recursive: true });

// ---------- låtsasserver ----------
const got = [];
let failNext = 0, failStatus = 500;
const fake = http.createServer((q, r) => {
  let b = ''; q.on('data', d => b += d);
  q.on('end', () => {
    if (failNext > 0) { failNext--; r.writeHead(failStatus); return r.end('nere'); }
    got.push({ path: q.url, headers: q.headers, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() });
    r.writeHead(204); r.end();
  });
}).listen(0, '0.0.0.0');
await new Promise(r => fake.once('listening', r));
const PORT = fake.address().port;
const FB = `http://127.0.0.1:${PORT}`;

const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const sc = await import('../server/scanner.js');
const act = await import('../server/activity.js');
const wh = await import('../server/webhooks.js');
const ps = await import('../server/playstats.js');
const pods = await import('../server/podcasts.js');
const app = await import('../server/app.js');
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fake.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const ADMIN = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('anna','x',1,0)").lastInsertRowid);
const BO = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('bo','x',0,0)").lastInsertRowid);
const KID = Number(D.run("INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES('lisa','x',0,0,?,7)", ADMIN).lastInsertRowid);
const tok = Object.fromEntries([ADMIN, BO, KID].map(u => [u, auth.createSession(u, 'app')]));
const U = (id) => D.get('SELECT * FROM users WHERE id=?', id);
async function req(uid, p, { method = 'GET', body } = {}) {
  const h = { Authorization: `Bearer ${tok[uid]}` };
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, type: ct, headers: r.headers, data: ct.includes('json') ? await r.json() : await r.text() };
}

// Bibliotek: en film och en serie (filerna behöver inga riktiga videodata här)
const touch = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };
touch(path.join(MEDIA, 'Film', 'Alfa (2020)', 'Alfa (2020).mkv'));
touch(path.join(MEDIA, 'Film', 'Vuxenfilm (2019)', 'Vuxenfilm (2019).mkv'));
for (const n of [1, 2]) touch(path.join(MEDIA, 'TV', 'Bamse', 'Season 1', `Bamse S01E0${n}.mkv`));
const MLIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", path.join(MEDIA, 'Film')).lastInsertRowid);
const TLIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('TV','show',?)", path.join(MEDIA, 'TV')).lastInsertRowid);
await sc.scan();
const ALFA = D.get("SELECT * FROM items WHERE kind='movie' AND title='Alfa'");
const ADULT = D.get("SELECT * FROM items WHERE kind='movie' AND title='Vuxenfilm'");
const SHOW = D.get("SELECT * FROM items WHERE kind='show' AND title='Bamse'");
const EP1 = D.get("SELECT * FROM items WHERE parent_id=? AND episode=1", SHOW.id);
D.run('UPDATE items SET duration=1000, tmdb_id=4242, age=0 WHERE id=?', ALFA.id);
D.run('UPDATE items SET duration=2000, age=15 WHERE id=?', ADULT.id);
D.run('UPDATE items SET age=0 WHERE id=?', SHOW.id);
D.run('UPDATE items SET duration=600 WHERE parent_id=?', SHOW.id);
D.run('DELETE FROM plays'); // skanningen gav inga, men för säkerhets skull

const verify = (secret, g) => g.headers['x-braxhn-signature'] === 'sha256=' + crypto.createHmac('sha256', secret).update(g.body).digest('hex');
const withPrivate = async (fn) => { process.env.PODCAST_ALLOW_PRIVATE = '1'; try { return await fn(); } finally { delete process.env.PODCAST_ALLOW_PRIVATE; } };
const drain = (at) => withPrivate(() => wh.processQueue(at));
const T0 = Math.floor(Date.now() / 1000) + 60; // köns tider räknas från nu
const start = (uid, item, at, extra = {}) => act.startPlay({ user: U(uid), item, mode: 'transcode', quality: '720', ip: '192.168.1.20', remote: false, ua: 'Mozilla/5.0 Chrome/120 Safari/537', reasons: ['ljud'], kbps: 4000, ...extra }, at);

let HOOK;
test('webhook: skapas med hemlighet en gång, adressen maskeras, händelser och format kontrolleras', async () => {
  let r = await req(ADMIN, '/api/admin/webhooks', { method: 'POST', body: { name: 'HA', url: `${FB}/hook/hemligt-id-123456789`, events: ['media.play', 'media.pause', 'media.resume', 'media.stop', 'media.scrobble', 'library.new', 'påhittad'] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  HOOK = r.data;
  assert.ok(HOOK.secret?.length > 20);
  assert.deepEqual(HOOK.events, ['media.play', 'media.pause', 'media.resume', 'media.stop', 'media.scrobble', 'library.new']);
  assert.ok(!HOOK.url.includes('hemligt-id-123456789'), HOOK.url);
  r = await req(ADMIN, '/api/admin/webhooks');
  assert.equal(r.data.hooks.length, 1);
  assert.ok(!JSON.stringify(r.data).includes(HOOK.secret), 'hemligheten lämnas inte ut igen');
  assert.ok(!JSON.stringify(r.data).includes('hemligt-id-123456789'), 'adressens hemliga del lämnas inte ut');
  assert.ok(r.data.events['server.update']);
  // Fel indata
  assert.equal((await req(ADMIN, '/api/admin/webhooks', { method: 'POST', body: { url: 'ftp://x/y', events: ['media.play'] } })).status, 400);
  assert.equal((await req(ADMIN, '/api/admin/webhooks', { method: 'POST', body: { url: `${FB}/x`, events: [] } })).status, 400);
  assert.equal((await req(ADMIN, '/api/admin/webhooks', { method: 'POST', body: { url: 'http://user:pw@example.com/', events: ['media.play'] } })).status, 400);
  // Ändring utan adress behåller adressen
  r = await req(ADMIN, `/api/admin/webhooks/${HOOK.id}`, { method: 'PUT', body: { name: 'Home Assistant', url: '' } });
  assert.equal(r.data.name, 'Home Assistant');
  assert.equal(D.get('SELECT url FROM webhooks WHERE id=?', HOOK.id).url, `${FB}/hook/hemligt-id-123456789`);
});

test('uppspelning: play, paus, fortsätter, sedd ≥ 90 % och stopp blir händelser med Plex-lik nyttolast', async () => {
  got.length = 0;
  const s = start(ADMIN, ALFA, T0, { start: 0 });
  act.progress(ADMIN, ALFA.id, 10, T0 + 10);
  act.progress(ADMIN, ALFA.id, 20, T0 + 20);
  act.progress(ADMIN, ALFA.id, 20, T0 + 30);      // positionen står still → paus
  act.progress(ADMIN, ALFA.id, 30, T0 + 100);     // ny position → fortsätter
  act.progress(ADMIN, ALFA.id, 905, T0 + 110);    // spolat förbi 90 % → sedd
  act.progress(ADMIN, ALFA.id, 950, T0 + 150);
  // Ny start inom samma session (byte av kvalitet) ger ingen ny händelse
  start(ADMIN, ALFA, T0 + 155, { quality: '1080', start: 950 });
  act.clientStop(ADMIN, ALFA.id, T0 + 160);
  assert.equal(s.playId > 0, true);
  await drain(T0 + 200);
  const events = got.map(g => g.json.event);
  assert.deepEqual(events, ['media.play', 'media.pause', 'media.resume', 'media.scrobble', 'media.stop']);
  for (const g of got) assert.ok(verify(HOOK.secret, g), 'signaturen stämmer');
  const play = got[0].json;
  assert.equal(got[0].headers['x-braxhn-event'], 'media.play');
  assert.equal(play.user.name, 'anna');
  assert.equal(play.player.ip, '192.168.1.20');
  assert.equal(play.player.local, true);
  assert.equal(play.player.device, 'Chrome');
  assert.equal(play.metadata.type, 'movie');
  assert.equal(play.metadata.title, 'Alfa');
  assert.equal(play.metadata.year, 2020);
  assert.equal(play.metadata.tmdbId, 4242);
  assert.equal(play.metadata.duration, 1000);
  assert.equal(play.playback.mode, 'transcode');
  assert.equal(play.playback.transcode, true);
  assert.equal(play.playback.quality, '720');
  assert.equal(play.server.name, 'BraXhn TV');
  const stop = got.at(-1).json;
  assert.equal(stop.metadata.position, 950);
  assert.equal(stop.metadata.progress, 95);
  // Historiken: en rad med start/slut, faktiskt spelad tid (spolningen räknas inte), enhet, kvalitet
  const row = D.get('SELECT * FROM plays WHERE id=?', s.playId);
  assert.equal(row.ts, T0);
  assert.equal(row.ended, T0 + 160);
  assert.equal(row.pos_end, 950);
  assert.ok(row.played >= 50 && row.played < 120, String(row.played));
  assert.equal(row.quality, '1080');
  assert.equal(row.kbps, 4000);
  assert.equal(row.title, 'Alfa');
  assert.equal(row.device, 'Chrome');
  assert.equal(row.ip, '192.168.1.20');
  assert.equal(act.listActive().length, 0);
});

test('uppspelning: framsteg som slutar komma blir paus, tyst session avslutas', async () => {
  got.length = 0;
  start(BO, EP1, T0 + 1000, { remote: true, ip: '203.0.113.9', mode: 'direct', quality: 'orig', ua: 'BraXhnTV-Android' });
  act.progress(BO, EP1.id, 10, T0 + 1010);
  act.sweep(T0 + 1020);
  act.sweep(T0 + 1040); // 30 s utan framsteg → pausad
  assert.equal(act.listActive().length, 1); // pausad session lever kvar (15 min)
  act.sweep(T0 + 1040 + act.IDLE_PAUSED + 10);
  await drain(T0 + 3000);
  assert.deepEqual(got.map(g => g.json.event), ['media.play', 'media.pause', 'media.stop']);
  const p = got[0].json;
  assert.equal(p.metadata.type, 'episode');
  assert.equal(p.metadata.show, 'Bamse');
  assert.equal(p.metadata.season, 1);
  assert.equal(p.metadata.episode, 1);
  assert.equal(p.player.local, false);
  assert.equal(p.player.device, 'Android-app');
  assert.equal(p.playback.transcode, false);
});

test('webhook: händelsefilter och profilens egna webhooks (bara egna händelser, inga barnprofiler, inga lokala adresser)', async () => {
  // Bo:s egen webhook: bara media.stop
  let r = await req(BO, '/api/webhooks', { method: 'POST', body: { name: 'Mitt', url: `${FB}/bo`, events: ['media.stop', 'request.new'], allowLocal: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.events, ['media.stop'], 'request.new är bara för serverns webhooks');
  assert.equal(r.data.allowLocal, false, 'en profil kan inte tillåta lokala adresser');
  const BOHOOK = r.data;
  assert.equal((await req(KID, '/api/webhooks', { method: 'POST', body: { url: `${FB}/kid`, events: ['media.play'] } })).status, 403);
  assert.equal((await req(KID, '/api/webhooks')).status, 403);
  // Bo ser inte serverns webhooks och kan inte ändra dem
  assert.equal((await req(BO, `/api/webhooks/${HOOK.id}`, { method: 'DELETE' })).status, 404);
  r = await req(BO, '/api/webhooks');
  assert.deepEqual(r.data.hooks.map(h => h.id), [BOHOOK.id]);
  assert.ok(!r.data.events['library.scan.done']);
  assert.equal((await req(BO, '/api/admin/webhooks')).status, 403);
  got.length = 0;
  // Annas uppspelning når inte Bo:s webhook; Bo:s når båda
  start(ADMIN, EP1, T0 + 4000); act.clientStop(ADMIN, EP1.id, T0 + 4010);
  start(BO, ALFA, T0 + 4100); act.clientStop(BO, ALFA.id, T0 + 4110);
  await drain(T0 + 4200);
  const toBo = got.filter(g => g.path === '/bo').map(g => `${g.json.event}:${g.json.user.name}`);
  assert.deepEqual(toBo, ['media.stop:bo']);
  assert.ok(verify(BOHOOK.secret, got.find(g => g.path === '/bo')));
  assert.equal(got.filter(g => g.path.startsWith('/hook')).length, 4);
  // Avstängd webhook får inget
  await req(BO, `/api/webhooks/${BOHOOK.id}`, { method: 'PUT', body: { enabled: false } });
  got.length = 0;
  start(BO, ALFA, T0 + 9000); act.clientStop(BO, ALFA.id, T0 + 9010);
  await drain(T0 + 9100);
  assert.equal(got.filter(g => g.path === '/bo').length, 0);
});

test('webhook: library.new följer åldersgränsen för profilens webhooks', async () => {
  const KIDHOOK = Number(D.run("INSERT INTO webhooks(user_id,name,url,events,secret,created) VALUES(?,?,?,?,?,?)", KID, 'x', `${FB}/kid`, 'library.new', 's', 0).lastInsertRowid);
  const BONEW = Number(D.run("INSERT INTO webhooks(user_id,name,url,events,secret,created) VALUES(?,?,?,?,?,?)", BO, 'ny', `${FB}/bonew`, 'library.new', 's2', 0).lastInsertRowid);
  got.length = 0;
  sc.hooks.newItems([ADULT.id]);
  sc.hooks.newItems([EP1.id, D.get('SELECT id FROM items WHERE parent_id=? AND episode=2', SHOW.id).id]);
  await drain(T0 + 9500);
  assert.equal(got.filter(g => g.path === '/kid').length, 0, 'barnprofiler får inga webhooks');
  assert.deepEqual(got.filter(g => g.path === '/bonew').map(g => g.json.metadata.title), ['Vuxenfilm', 'Avsnitt 1']);
  const ep = got.find(g => g.path === '/bonew' && g.json.metadata.type === 'episode').json;
  assert.equal(ep.metadata.newEpisodes, 2, 'ett säsongspaket blir en händelse');
  D.run('DELETE FROM webhooks WHERE id IN (?,?)', KIDHOOK, BONEW);
});

test('webhook: omförsök med backoff vid fel, permanenta fel ger upp, loggen visar leveranserna', async () => {
  got.length = 0;
  wh.emit('media.play', { user: { id: ADMIN, name: 'anna' }, metadata: { type: 'movie', title: 'Test' } }, { userId: ADMIN });
  failNext = 2; failStatus = 503;
  const t = T0 + 20000;
  await drain(t);
  assert.equal(got.length, 0);
  let q = D.get('SELECT * FROM webhook_queue WHERE hook_id=?', HOOK.id);
  assert.equal(q.attempts, 1);
  assert.equal(q.next_try, t + wh.backoff(1));
  await drain(t + 5); // inte dags än
  assert.equal(D.get('SELECT attempts FROM webhook_queue WHERE hook_id=?', HOOK.id).attempts, 1);
  await drain(t + wh.backoff(1));
  q = D.get('SELECT * FROM webhook_queue WHERE hook_id=?', HOOK.id);
  assert.equal(q.attempts, 2);
  assert.ok(wh.backoff(2) > wh.backoff(1));
  await drain(t + wh.backoff(1) + wh.backoff(2));
  assert.equal(got.length, 1);
  assert.equal(got[0].json.event, 'media.play');
  assert.equal(got[0].headers['x-braxhn-delivery'], String(q.id));
  assert.equal(D.get('SELECT COUNT(*) AS n FROM webhook_queue').n, 0);
  // 404 (fel adress) försöks inte igen
  failNext = 1; failStatus = 404;
  wh.emit('media.stop', { user: { id: ADMIN, name: 'anna' }, metadata: { type: 'movie', title: 'Test' } }, { userId: ADMIN });
  await drain(t + 9999);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM webhook_queue').n, 0);
  const r = await req(ADMIN, '/api/admin/webhooks');
  const log = r.data.log.filter(l => l.hookId === HOOK.id);
  assert.ok(log.some(l => !l.ok && l.status === 503 && l.attempt === 1));
  assert.ok(log.some(l => l.ok && l.attempt === 3));
  assert.ok(log.some(l => !l.ok && l.status === 404));
  assert.ok(r.data.hooks[0].lastError);
  // Högst MAX_ATTEMPTS försök
  assert.ok(wh.backoff(30) <= 3600);
});

test('webhook: lokala adresser spärras utan uttryckligt tillstånd – loopback och länklokalt alltid', async () => {
  assert.equal(pods.blockedFor('192.168.1.5'), true);
  assert.equal(pods.blockedFor('192.168.1.5', true), false);
  assert.equal(pods.blockedFor('10.0.0.8', true), false);
  assert.equal(pods.blockedFor('fd00::5', true), false);
  assert.equal(pods.blockedFor('127.0.0.1', true), true);
  assert.equal(pods.blockedFor('::1', true), true);
  assert.equal(pods.blockedFor('169.254.169.254', true), true);
  assert.equal(pods.blockedFor('::ffff:192.168.1.5', true), true);
  assert.equal(pods.blockedFor('8.8.8.8'), false);
  // Leverans till 127.0.0.1 utan undantag i miljön: spärras, även med allowLocal
  got.length = 0;
  const id = Number(D.run("INSERT INTO webhooks(user_id,name,url,events,secret,allow_local,created) VALUES(NULL,'lokal',?,'server.update','s',1,0)", `${FB}/lokal`).lastInsertRowid);
  const r = await req(ADMIN, `/api/admin/webhooks/${id}/test`, { method: 'POST' });
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /lokalt nätverk/);
  // Hemnätsadress: spärrad utan tillstånd, levereras med (om maskinen har en sådan adress)
  const lan = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal && !pods.blockedFor(a.address, true) && pods.blockedFor(a.address));
  if (lan) {
    D.run('UPDATE webhooks SET url=?, allow_local=0 WHERE id=?', `http://${lan.address}:${PORT}/lan`, id);
    assert.equal((await req(ADMIN, `/api/admin/webhooks/${id}/test`, { method: 'POST' })).data.ok, false);
    await req(ADMIN, `/api/admin/webhooks/${id}`, { method: 'PUT', body: { allowLocal: true } });
    const ok = await req(ADMIN, `/api/admin/webhooks/${id}/test`, { method: 'POST' });
    assert.equal(ok.data.ok, true, ok.data.error);
    assert.equal(got.at(-1).path, '/lan');
    assert.equal(got.at(-1).json.event, 'test');
  }
  D.run('DELETE FROM webhooks WHERE id=?', id);
});

test('webhook: Discord- och ntfy-format, ny version bara en gång', async () => {
  const dc = await req(ADMIN, '/api/admin/webhooks', { method: 'POST', body: { name: 'Discord', url: `${FB}/discord`, events: ['server.update', 'request.new'], format: 'discord' } });
  const nt = await req(ADMIN, '/api/admin/webhooks', { method: 'POST', body: { name: 'ntfy', url: `${FB}/mitt-amne`, events: ['server.update'], format: 'ntfy' } });
  got.length = 0;
  wh.updateAvailable({ current: '0.9.3', latest: '9.9.9' });
  wh.updateAvailable({ current: '0.9.3', latest: '9.9.9' });
  await drain(T0 + 30000);
  const d = got.filter(g => g.path === '/discord');
  assert.equal(d.length, 1);
  assert.equal(d[0].json.username, 'BraXhn TV');
  assert.match(d[0].json.embeds[0].description, /9\.9\.9/);
  const n = got.filter(g => g.path === '/');
  assert.equal(n.length, 1, 'ntfy publicerar till serverns rot');
  assert.equal(n[0].json.topic, 'mitt-amne');
  assert.match(n[0].json.title, /Ny version/);
  // Önskan från en profil når serverns webhook
  got.length = 0;
  wh.emit('request.new', { user: { id: BO, name: 'bo' }, request: { kind: 'movie', title: 'Önskefilm', year: 2024 } }, { userId: BO });
  await drain(T0 + 30100);
  assert.match(got.find(g => g.path === '/discord').json.embeds[0].description, /bo önskar filmen Önskefilm \(2024\)/);
  for (const h of [dc.data, nt.data]) assert.equal((await req(ADMIN, `/api/admin/webhooks/${h.id}`, { method: 'DELETE' })).status, 200);
});

// ---------- statistik ----------
test('statistik: filter, topplistor, fördelningar, samtidiga strömmar och bandbredd', async () => {
  D.run('DELETE FROM plays');
  const day = 86400, base = Math.floor(new Date(2026, 0, 5, 20, 0, 0).getTime() / 1000); // måndag 20.00
  const ins = (uid, it, ts, dur, extra = {}) => D.run(`INSERT INTO plays(user_id,item_id,ts,ended,played,mode,remote,device,kbps,quality,title,kind,library_id,show_id,duration,pos_end)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid, it.id, ts, ts + dur, dur, extra.mode || 'direct', extra.remote ? 1 : 0, extra.device || 'Chrome', extra.kbps ?? 8000, extra.q || 'orig',
    it.title, it.kind, it.library_id, it.parent_id || null, it.duration || 1000, dur);
  ins(ADMIN, ALFA, base, 3600);
  ins(BO, ALFA, base + 1800, 3600, { mode: 'transcode', remote: true, device: 'Android-app', kbps: 4000, q: '720' });
  ins(BO, EP1, base + day, 600);
  ins(KID, EP1, base + 2 * day + 3600 * 2, 600, { device: 'Apple TV' });
  const f = (q = {}, viewer = U(ADMIN)) => ps.filters(new URLSearchParams(q), viewer, { everyone: true, at: base + 10 * day });
  let o = ps.overview(f({ from: '2026-01-01', to: '2026-01-31' }));
  assert.equal(o.totals.plays, 4);
  assert.equal(o.totals.users, 3);
  assert.equal(o.totals.transcodes, 1);
  assert.equal(o.totals.remote, 1);
  assert.equal(o.top[0].title, 'Alfa');
  assert.equal(o.top[0].plays, 2);
  assert.equal(o.top[0].viewers, 2);
  assert.equal(o.top[1].title, 'Bamse');
  assert.equal(o.top[1].series, true);
  assert.equal(o.users[0].name, 'bo');
  assert.equal(o.platforms[0].key, 'Chrome');
  assert.equal(o.weekday[0].n, 2, 'måndag först');
  assert.equal(o.hour[20].n, 3);
  assert.equal(o.hour[22].n, 1);
  assert.equal(o.byDay.length, 3);
  // Filter
  assert.equal(ps.overview(f({ user: String(BO) })).totals.plays, 2);
  assert.equal(ps.overview(f({ kind: 'episode' })).totals.plays, 2);
  assert.equal(ps.overview(f({ library: String(MLIB) })).totals.plays, 2);
  assert.equal(ps.overview(f({ mode: 'transcode' })).totals.plays, 1);
  assert.equal(ps.overview(f({ remote: '1' })).totals.plays, 1);
  assert.equal(ps.overview(f({ item: String(SHOW.id) })).totals.plays, 2, 'serien räknar sina avsnitt');
  assert.equal(ps.history(f({ q: 'bams' })).total, 2);
  assert.equal(ps.history(f({ q: 'android' })).total, 1, 'sökning på enhet');
  assert.equal(ps.history(f({ from: '2026-01-06', to: '2026-01-06' })).total, 1);
  assert.equal(ps.history(f({ q: "'; DROP TABLE plays; --" })).total, 0);
  // Samtidiga strömmar: två samtidigt måndag 20.30–21.00, bandbredden summeras
  const cc = ps.concurrency(f({ from: '2026-01-05', to: '2026-01-05' }));
  assert.equal(cc.step, 3600);
  const b20 = cc.buckets.find(b => new Date(b.t * 1000).getHours() === 20);
  assert.equal(b20.peak, 2);
  assert.equal(b20.peakKbps, 12000);
  assert.equal(b20.kbps, 8000 + 2000, 'genomsnitt: 8000 hela timmen + 4000 halva');
  const long = ps.concurrency(f({ from: '2026-01-01', to: '2026-01-31' }));
  assert.equal(long.step, 86400);
  assert.equal(long.buckets.length, 31);
  // Gallring efter inställningen
  D.setSetting('history_days', '1');
  assert.equal(ps.prune(base + 2 * day + 7200 + 10), 3);
  D.setSetting('history_days', '0');
  assert.equal(ps.prune(base + 1000 * day), 0, '0 = spara för alltid');
  D.setSetting('history_days', '365');
});

test('historik: behörighet – egna rader för alla, allt för administratören, barnprofiler kan inte radera', async () => {
  D.run('DELETE FROM plays');
  const now = Math.floor(Date.now() / 1000);
  const ins = (uid, it, ts) => Number(D.run('INSERT INTO plays(user_id,item_id,ts,ended,played,mode,device,title,kind,ip) VALUES(?,?,?,?,?,?,?,?,?,?)', uid, it.id, ts, ts + 60, 60, 'direct', 'Chrome', it.title, it.kind, '10.0.0.' + uid).lastInsertRowid);
  const a = ins(ADMIN, ALFA, now - 100), b = ins(BO, ALFA, now - 200), k = ins(KID, EP1, now - 300);
  let r = await req(KID, '/api/history');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.rows.map(x => x.id), [k]);
  assert.equal(r.data.rows[0].user, undefined, 'ingen profil- eller IP-uppgift i den egna historiken');
  assert.equal(r.data.rows[0].ip, undefined);
  assert.equal(r.data.canDelete, false);
  // Filtret user= ignoreras för andra än administratören på statistik-routen
  r = await req(KID, `/api/history?user=${ADMIN}`);
  assert.deepEqual(r.data.rows.map(x => x.id), [k]);
  assert.equal((await req(KID, '/api/playstats')).status, 403);
  assert.equal((await req(BO, '/api/playstats/history')).status, 403);
  assert.equal((await req(KID, `/api/history/${k}`, { method: 'DELETE' })).status, 403);
  // Administratören: sin egen historik under /api/history, allt under /api/playstats
  r = await req(ADMIN, '/api/history');
  assert.deepEqual(r.data.rows.map(x => x.id), [a]);
  r = await req(ADMIN, '/api/playstats/history');
  assert.equal(r.data.total, 3);
  assert.equal(r.data.rows.find(x => x.id === k).user, 'lisa');
  r = await req(ADMIN, `/api/playstats?user=${KID}&days=30`);
  assert.equal(r.data.totals.plays, 1);
  assert.equal(r.data.historyDays, 365);
  // Radera: egen rad ja, någon annans nej
  assert.equal((await req(BO, `/api/history/${a}`, { method: 'DELETE' })).status, 404);
  assert.equal((await req(BO, `/api/history/${b}`, { method: 'DELETE' })).status, 200);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM plays WHERE id=?', b).n, 0);
  assert.equal((await req(ADMIN, `/api/playstats/history/${k}`, { method: 'DELETE' })).status, 200);
  // Inställningen för hur länge historiken sparas
  assert.equal((await req(ADMIN, '/api/playstats/settings', { method: 'PUT', body: { historyDays: -3 } })).status, 400);
  r = await req(ADMIN, '/api/playstats/settings', { method: 'PUT', body: { historyDays: 730 } });
  assert.equal(r.data.historyDays, 730);
  assert.equal((await req(BO, '/api/playstats/settings', { method: 'PUT', body: { historyDays: 1 } })).status, 403);
});

test('CSV-export: rubriker, semikolon, citattecken och skydd mot formler', async () => {
  D.run('DELETE FROM plays');
  const ts = Math.floor(Date.now() / 1000) - 50;
  D.run("INSERT INTO plays(user_id,item_id,ts,ended,played,mode,device,title,kind,ip,remote) VALUES(?,?,?,?,?,?,?,?,?,?,1)", BO, 999999, ts, ts + 120, 120, 'transcode', '=HYPERLINK("x")', 'Borttagen; "film"', 'movie', '10.0.0.9');
  D.run("INSERT INTO plays(user_id,item_id,ts,ended,played,mode,device,title,kind) VALUES(?,?,?,?,?,?,?,?,?)", ADMIN, ALFA.id, ts, ts + 60, 60, 'direct', 'Chrome', 'Alfa', 'movie');
  let r = await req(ADMIN, '/api/playstats/history.csv');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="tittarhistorik-/);
  const text = r.data.replace(/^﻿/, '');
  const lines = text.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Start;Slut;Profil;Titel;/);
  const bo = lines.find(l => l.includes('Borttagen'));
  assert.ok(bo.includes('"Borttagen; ""film"""'), bo);
  assert.ok(bo.includes(`"'=HYPERLINK(""x"")"`), 'formeln neutraliseras');
  assert.ok(bo.includes('Omkodning') && bo.includes('Utifrån') && bo.includes('2,0'), bo);
  // Den egna historiken som CSV: bara egna rader, utan profil och IP
  r = await req(BO, '/api/history.csv');
  const own = r.data.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(own.length, 2);
  assert.ok(!own[0].includes('Profil') && !own[0].includes('IP'));
  assert.ok(!r.data.includes('10.0.0.9'));
  assert.equal((await req(BO, '/api/playstats/history.csv')).status, 403);
});
