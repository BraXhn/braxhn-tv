// Skärmtid, följda serier ("Nytt för dig", personliga notiser) och automatisk offline-synk.
// Körs i samma process (servern startas på en slumpad port); kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-st-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.NEW_EPISODE_NOTIFY_DELAY = '0';
process.env.WATCH_FILES = '0';
fs.mkdirSync(MEDIA, { recursive: true });
const D = await import('../server/db.js');
const screen = await import('../server/screentime.js');
const follows = await import('../server/follows.js');
const pods = await import('../server/podcasts.js');
const sc = await import('../server/scanner.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');

const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const touch = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };
const ROOTUSER = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('mamma','x',0,0)").lastInsertRowid);
const KID = Number(D.run("INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES('lisa','x',0,0,?,7)", ROOTUSER).lastInsertRowid);
const OTHER = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('granne','x',0,0)").lastInsertRowid);
const tok = { [ROOTUSER]: auth.createSession(ROOTUSER, 'app'), [KID]: auth.createSession(KID, 'app'), [OTHER]: auth.createSession(OTHER, 'app') };
async function req(uid, p, { method = 'GET', body } = {}) {
  const h = { Authorization: `Bearer ${tok[uid]}` };
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}

// Bibliotek med en barntillåten serie (avsnitt utan riktiga videodata räcker här)
const SHOWDIR = path.join(MEDIA, 'Serier');
for (const n of [1, 2, 3, 4]) touch(path.join(SHOWDIR, 'Bamse', 'Season 1', `Bamse S01E0${n}.mkv`));
touch(path.join(SHOWDIR, 'Vuxenserie', 'Season 1', 'Vuxenserie S01E01.mkv'));
const LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('TV','show',?)", SHOWDIR).lastInsertRowid);
await sc.scan(LIB);
const SHOW = D.get("SELECT id FROM items WHERE kind='show' AND title='Bamse'").id;
const ADULT = D.get("SELECT id FROM items WHERE kind='show' AND title='Vuxenserie'").id;
D.run('UPDATE items SET age=0 WHERE id=?', SHOW);
D.run('UPDATE items SET age=15 WHERE id=?', ADULT);
const ep = (n, sid = SHOW) => D.get('SELECT id FROM items WHERE parent_id=? AND episode=?', sid, n).id;
const watch = (uid, id) => D.run('INSERT INTO progress(user_id,item_id,position,watched,updated) VALUES(?,?,0,1,?) ON CONFLICT(user_id,item_id) DO UPDATE SET watched=1', uid, id, D.now());

// ---------------- skärmtid ----------------
test('skärmtid: regler tvättas och veckodagar ersätter standardvärden', () => {
  assert.equal(screen.normalize({}), null);
  assert.equal(screen.normalize({ daily: '', from: 'x', until: '25:00' }), null);
  const r = screen.normalize({ daily: '60', until: '20:00', from: '7:05', audio: 1, days: { 5: { daily: 120, until: '21:30' }, 6: { daily: '' } } });
  assert.deepEqual(r, { daily: 60, from: '07:05', until: '20:00', audio: true, days: { 5: { daily: 120, until: '21:30' } } });
  const fri = new Date(2026, 9, 16, 12), mon = new Date(2026, 9, 12, 12); // fredag / måndag
  assert.deepEqual(screen.rulesToday(r, fri), { daily: 120, from: '07:05', until: '21:30', audio: true });
  assert.deepEqual(screen.rulesToday(r, mon), { daily: 60, from: '07:05', until: '20:00', audio: true });
});

test('skärmtid: tid räknas per användare (ingen dubbelräkning), paus och glapp räknas inte', () => {
  const uid = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('räknare','x',0,0)").lastInsertRowid);
  screen.setRules(uid, { daily: 1 });
  const t0 = new Date(2026, 9, 14, 10).getTime();
  assert.equal(screen.heartbeat(uid, 'i:1', 10, { at: t0 }).used, 0, 'första rapporten räknas inte');
  screen.heartbeat(uid, 'i:1', 20, { at: t0 + 10e3 });
  // Två samtidiga strömmar: väggklockan räknas, inte summan
  screen.heartbeat(uid, 'i:2', 100, { at: t0 + 15e3 });
  screen.heartbeat(uid, 'i:1', 30, { at: t0 + 20e3 });
  screen.heartbeat(uid, 'i:2', 110, { at: t0 + 25e3 });
  let s = screen.status(uid, new Date(t0 + 25e3));
  assert.equal(s.used, 25);
  // Pausad (samma position): räknas inte
  screen.heartbeat(uid, 'i:1', 30, { at: t0 + 35e3 });
  screen.heartbeat(uid, 'i:2', 110, { at: t0 + 35e3 });
  assert.equal(screen.status(uid, new Date(t0 + 35e3)).used, 25);
  // Långt glapp (stoppat en stund): bara tiden efter återstarten räknas. Live startar 10 s efter filmens rapport: en ny
  // ström, så de 10 s räknas inte (fortsatte filmen räknas den med sin nästa rapport)
  screen.heartbeat(uid, 'i:1', 40, { at: t0 + 600e3 });
  screen.heartbeat(uid, 'l:3', null, { at: t0 + 610e3 }); // live (utan position)
  s = screen.status(uid, new Date(t0 + 610e3));
  assert.equal(s.used, 25); assert.equal(s.allowed, true); assert.equal(s.remaining, 35);
  for (let i = 1; i <= 4; i++) s = screen.heartbeat(uid, 'l:3', null, { at: t0 + 610e3 + i * 10e3 });
  assert.equal(s.allowed, false); assert.equal(s.reason, 'limit');
  assert.match(s.message, /Tiden är slut för idag/);
  // Extra tid för idag
  screen.addExtra(uid, 5, new Date(t0 + 660e3));
  s = screen.status(uid, new Date(t0 + 660e3));
  assert.equal(s.allowed, true); assert.equal(s.extra, 5);
  // Ljud räknas bara om regeln gäller ljud
  assert.equal(screen.heartbeat(uid, 'b:1', 5, { audio: true, at: t0 + 670e3 }), null);
  assert.equal(screen.check(uid, { audio: true, d: new Date(t0 + 660e3) }), null);
});

test('skärmtid: en ström räknas fram till när data senast skickades – paus räknas inte (streamMeter)', () => {
  // Uppmätt i Chrome före rättningen: direktuppspelning i 6 s och sedan 60 s paus gav 20 s räknad tid (14 s av pausen),
  // eftersom livstecknet var 20:e sekund räknade fram till sig självt så fort något skickats sedan förra
  const uid = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('strömmen','x',0,0)").lastInsertRowid);
  screen.setRules(uid, { daily: 60 });
  const t0 = new Date(2026, 9, 14, 10).getTime();
  const meter = screen.streamMeter(20000, t0, 0);
  screen.heartbeat(uid, 'i:9', null, { at: t0 }); // svaret börjar
  const beats = [];
  // Spelar i 26 s (data varannan sekund), pausas sedan i två minuter med svaret öppet (inget skickas)
  for (let s = 2, n = 0; s <= 146; s += 2) {
    if (s <= 26) n += 65536;
    const at = meter(t0 + s * 1000, n);
    if (at != null) { beats.push((at - t0) / 1000); screen.heartbeat(uid, 'i:9', null, { at }); }
  }
  assert.deepEqual(beats, [20, 26], 'livstecken bara medan data skickas, det sista vid pausen');
  assert.equal(screen.status(uid, new Date(t0 + 146e3)).used, 26, 'pausen räknas inte');
  // Startar igen efter pausen: tiden räknas igen (efter ett glapp längre än CAP räknas glappet inte)
  let n = 26 / 2 * 65536;
  for (let s = 148; s <= 190; s += 2) {
    n += 65536;
    const at = meter(t0 + s * 1000, n);
    if (at != null) screen.heartbeat(uid, 'i:9', null, { at });
  }
  assert.equal(screen.status(uid, new Date(t0 + 190e3)).used, 26 + (188 - 148), 'uppspelningen efter pausen räknas (glappet över pausen inte)');
  // Data hela tiden: ett livstecken per period, fram till senaste skickade data
  const m2 = screen.streamMeter(20000, 0, 0), got = [];
  for (let s = 1; s <= 60; s++) { const at = m2(s * 1000, s); if (at != null) got.push(at / 1000); }
  assert.deepEqual(got, [20, 40, 60]);
});

test('skärmtid: en kort paus (under CAP) räknas inte när spelaren rapporterar både paus och start', () => {
  // Uppmätt i Chrome före rättningen: 20 s uppspelning, 30 s paus och 20 s till gav 63 s räknad tid (pausen räknades
  // när nästa rapport kom, eftersom glappet var kortare än CAP)
  const uid = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('kortpaus','x',0,0)").lastInsertRowid);
  screen.setRules(uid, { daily: 60 });
  const t0 = new Date(2026, 9, 14, 18).getTime(), hb = (pos, s) => screen.heartbeat(uid, 'i:5', pos, { at: t0 + s * 1000 });
  hb(10, 0); hb(20, 10);
  hb(25, 15); // pausad: rapport vid pausen
  hb(null, 16); // strömmen skickar det sista strax efter pausen
  hb(25, 45); // startar igen 29 s senare: samma position
  hb(35, 55);
  assert.equal(screen.status(uid, new Date(t0 + 55e3)).used, 10 + 5 + 1 + 10, 'pausen 16–45 s räknas inte');
  // En klient som säger att positionen står still medan strömmen skickar data räknas som vanligt
  hb(null, 62); hb(35, 70); hb(45, 75);
  assert.equal(screen.status(uid, new Date(t0 + 75e3)).used, 26 + 7 + 13);
});

test('skärmtid: tiden mellan två uppspelningar räknas inte (ny titel, samma titel efter stopp)', () => {
  // Uppmätt i Chrome före rättningen (webbspelaren, originalfilen): 10 s film, stäng, 20 s senare 10 s av en annan film
  // gav 41 s räknad tid för 20,8 s rörlig bild – samma film igen likaså. Glappet (CAP) gällde mellan alla strömmar.
  const mk = (n) => { const u = Number(D.run('INSERT INTO users(name,pass,is_admin,created) VALUES(?,\'x\',0,0)', n).lastInsertRowid); screen.setRules(u, { daily: 60 }); return u; };
  const t0 = new Date(2026, 10, 28, 17).getTime();
  const used = (uid, s) => screen.status(uid, new Date(t0 + s * 1000)).used;
  // Två titlar: första strömmen slutar vid 11 s, nästa börjar vid 50 s (inom CAP) – bara bilden räknas
  let uid = mk('tvåtitlar');
  let hb = (k, pos, s) => screen.heartbeat(uid, k, pos, { at: t0 + s * 1000 });
  hb('i:1', null, 0); hb('i:1', 1, 1); hb('i:1', null, 6); hb('i:1', 11, 11);
  hb('i:2', null, 50); hb('i:2', 1, 51); hb('i:2', null, 56); hb('i:2', 10, 60);
  assert.equal(used(uid, 60), 11 + 10);
  // Nästa avsnitt startar direkt (inom några sekunder) efter att det förra tagit slut: inte heller det räknas
  hb('i:3', null, 63); hb('i:3', 10, 73);
  assert.equal(used(uid, 73), 21 + 10);

  // Samma titel igen: spelaren stängs (POST /api/stream/:id/stop) och öppnas 20 s senare
  uid = mk('sammaigen');
  hb = (k, pos, s) => screen.heartbeat(uid, k, pos, { at: t0 + s * 1000 });
  hb('i:1', null, 0); hb('i:1', 5, 5); hb('i:1', 10, 10);
  screen.stopped(uid, 'i:1', t0 + 10.5e3);
  hb('i:1', null, 30); hb('i:1', 15, 35); hb('i:1', 20, 40);
  assert.equal(used(uid, 40), 10 + 10, 'stängd i 20 s räknas inte');
  // Ny ström strax efter stoppet (byte av version, under STOP_GAP): samma uppspelning
  screen.stopped(uid, 'i:1', t0 + 40.5e3);
  hb('i:1', null, 42); hb('i:1', 26, 46);
  assert.equal(used(uid, 46), 26);

  // Fusk: stopp hela tiden medan originalfilen hämtas – datan visar att uppspelningen pågår, allt räknas
  uid = mk('stoppfusk');
  const meter = screen.streamMeter(20000, t0, 0);
  screen.heartbeat(uid, 'i:7', null, { at: t0 });
  for (let s = 2, n = 0; s <= 120; s += 2) {
    n += 65536; screen.streamFlow(uid, t0 + s * 1000);
    screen.stopped(uid, 'i:7', t0 + s * 1000 + 500);
    const at = meter(t0 + s * 1000, n);
    if (at != null) screen.heartbeat(uid, 'i:7', null, { at });
  }
  assert.equal(used(uid, 120), 120);
  // Fusk: rapporter om att positionen står still medan originalfilen skickas bryter inte räkningen (en sådan rapport
  // blir bara en ny startpunkt när strömmen ändå inte hänger ihop)
  uid = mk('stillfusk');
  const m2 = screen.streamMeter(20000, t0, 0);
  screen.heartbeat(uid, 'i:8', null, { at: t0 });
  screen.heartbeat(uid, 'i:8', 0, { at: t0 + 1000 });
  for (let s = 2; s <= 120; s += 2) {
    screen.streamFlow(uid, t0 + s * 1000);
    const at = m2(t0 + s * 1000, s);
    if (at != null) screen.heartbeat(uid, 'i:8', null, { at });
    if (s % 10 === 0) screen.heartbeat(uid, 'i:8', 0, { at: t0 + s * 1000 + 300 }); // var 10:e sekund
  }
  assert.equal(used(uid, 120), 120);
});

test('skärmtid: efter en lång paus räknas uppspelningen från starten, inte från nästa rapport', () => {
  // Data skickades en stund efter pausen (spelaren fyllde bufferten): rapporten vid starten blev då ingen startpunkt,
  // och de första 10 s efter pausen räknades inte
  const uid = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('långpaus','x',0,0)").lastInsertRowid);
  screen.setRules(uid, { daily: 60 });
  const t0 = new Date(2026, 10, 28, 19).getTime(), hb = (pos, s) => screen.heartbeat(uid, 'i:4', pos, { at: t0 + s * 1000 });
  hb(null, 0); hb(1, 1); hb(10, 10); hb(15, 15); // pausad vid 15 s
  screen.streamFlow(uid, t0 + 30e3);
  hb(15, 615); // startar igen 10 min senare
  hb(25, 625);
  assert.equal(screen.status(uid, new Date(t0 + 625e3)).used, 15 + 10);
  // Startrapporten räknas aldrig längre än positionen rört sig (en paus med rapporter som står still)
  hb(25, 1300); hb(28, 1310);
  assert.equal(screen.status(uid, new Date(t0 + 1310e3)).used, 25 + 3);
});

test('skärmtid i spelaren: "X min kvar idag", varning de sista fem minuterna och inget utan skärmtid (playerLeft)', async () => {
  const { playerLeft, WARN_LEFT } = await import('../web/js/player/screenleft.js');
  assert.equal(WARN_LEFT, 300);
  assert.equal(playerLeft(null), null, 'utan skärmtid');
  assert.equal(playerLeft({ limited: false }), null);
  assert.equal(playerLeft({ limited: true, allowed: true, left: null }), null, 'ingen gräns idag (bara veckodagar med gräns)');
  assert.equal(playerLeft({ limited: true, allowed: false, left: 0 }), null, 'slut: spelaren stängs i stället');
  assert.deepEqual(playerLeft({ limited: true, allowed: true, left: 720 }), { min: 12, warn: false });
  assert.deepEqual(playerLeft({ limited: true, allowed: true, left: 301 }), { min: 6, warn: false });
  assert.deepEqual(playerLeft({ limited: true, allowed: true, left: 300 }), { min: 5, warn: true });
  assert.deepEqual(playerLeft({ limited: true, allowed: true, left: 20 }), { min: 1, warn: true }, 'sista minuten visas som 1 min');
  // Samma fält som serverns status ger
  const uid = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('kvar','x',0,0)").lastInsertRowid);
  screen.setRules(uid, { daily: 30 });
  assert.deepEqual(playerLeft(screen.status(uid, new Date(2026, 9, 14, 10))), { min: 30, warn: false });
});

test('skärmtid: tillåtna klockslag, även över midnatt, och extra tid förlänger kvällen', () => {
  const uid = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('klocka','x',0,0)").lastInsertRowid);
  screen.setRules(uid, { from: '07:00', until: '20:00' });
  const at = (h, m = 0) => new Date(2026, 9, 14, h, m);
  assert.equal(screen.status(uid, at(6, 59)).allowed, false);
  assert.equal(screen.status(uid, at(12)).allowed, true);
  assert.equal(screen.status(uid, at(19, 50)).left, 600);
  const late = screen.status(uid, at(20, 5));
  assert.equal(late.allowed, false); assert.equal(late.reason, 'window');
  assert.match(late.message, /onsdagar går det att titta mellan 07:00 och 20:00/);
  screen.addExtra(uid, 30, at(20, 5));
  assert.equal(screen.status(uid, at(20, 5)).allowed, true);
  assert.equal(screen.status(uid, at(20, 5)).until, '20:30');
  screen.setRules(uid, { from: '22:00', until: '02:00' });
  assert.equal(screen.status(uid, new Date(2026, 9, 15, 23)).allowed, true);
  assert.equal(screen.status(uid, new Date(2026, 9, 15, 1)).allowed, true);
  assert.equal(screen.status(uid, new Date(2026, 9, 15, 12)).allowed, false);
});

test('skärmtid via API: huvudkontot styr, uppspelning nekas med svensk felkod, ström stoppas', async () => {
  // Bara huvudkontot (eller admin) – inte barnet själv eller grannen
  assert.equal((await req(KID, `/api/screentime/${KID}`, { method: 'PUT', body: { daily: 999 } })).status, 403);
  assert.equal((await req(OTHER, `/api/screentime/${KID}`, { method: 'PUT', body: { daily: 999 } })).status, 403);
  assert.equal((await req(ROOTUSER, `/api/screentime/${ROOTUSER}`, { method: 'PUT', body: { daily: 1 } })).status, 403);
  let r = await req(ROOTUSER, `/api/screentime/${KID}`, { method: 'PUT', body: { daily: 0 } });
  assert.equal(r.status, 200); assert.equal(r.data.rules.daily, 0);
  assert.equal((await req(KID, '/api/status')).data.user.screenTime.allowed, false);

  r = await req(KID, `/api/items/${ep(1)}/playback`);
  assert.equal(r.status, 403); assert.equal(r.data.code, 'screen_time'); assert.match(r.data.error, /Tiden är slut för idag/);
  assert.notEqual((await req(KID, `/api/items/${ep(1)}/playback?info=1`)).status, 403, 'titelsidans info är ingen uppspelning');
  assert.equal((await req(KID, `/api/stream/${ep(1)}/direct`)).data.code, 'screen_time');
  // Framstegsrapport säger åt klienten att stoppa
  r = await req(KID, `/api/items/${ep(1)}/progress`, { method: 'POST', body: { position: 50, duration: 1000 } });
  assert.equal(r.data.stop, true); assert.equal(r.data.screenTime.reason, 'limit');

  // Extra tid för idag
  r = await req(ROOTUSER, `/api/screentime/${KID}/extra`, { method: 'POST', body: { minutes: 15 } });
  // Stoppet (spelaren stängs) gäller titeln: nästa start räknas som en ny uppspelning
  const t1 = Date.now();
  screen.heartbeat(KID, 'i:' + ep(2), 5, { at: t1 - 10e3 });
  assert.equal((await req(KID, `/api/stream/${ep(2)}/stop`, { method: 'POST' })).status, 200);
  const u0 = screen.status(KID).used;
  screen.heartbeat(KID, 'i:' + ep(2), 6, { at: t1 + 20e3 }); // 20 s efter stoppet, inom CAP
  assert.equal(screen.status(KID).used, u0, 'tiden efter stoppet räknas inte');
  assert.equal(r.data.status.allowed, true); assert.equal(r.data.status.remaining, 15 * 60);
  assert.notEqual((await req(KID, `/api/items/${ep(1)}/playback`)).data.code, 'screen_time');
  r = await req(KID, '/api/screentime');
  assert.equal(r.data.allowed, true); assert.equal(r.data.extra, 15);
  // Ta bort gränsen
  r = await req(ROOTUSER, `/api/screentime/${KID}`, { method: 'PUT', body: {} });
  assert.equal(r.data.rules, null); assert.equal((await req(KID, '/api/screentime')).data.limited, false);
});

// ---------------- följa serier och nya avsnitt ----------------
test('följa: knapp, automatisk följning via Min lista och avföljning som håller', async () => {
  let r = await req(ROOTUSER, `/api/items/${SHOW}/follow`, { method: 'POST', body: { follow: true } });
  assert.deepEqual(r.data, { following: true, sync: null });
  assert.equal((await req(ROOTUSER, `/api/items/${SHOW}`)).data.following, true);
  // Barnprofilen får inte följa en serie över sin åldersgräns
  assert.equal((await req(KID, `/api/items/${ADULT}/follow`, { method: 'POST', body: {} })).status, 404);
  // Min lista → följs automatiskt; avföljd → följs inte igen automatiskt
  await req(KID, `/api/items/${SHOW}/watchlist`, { method: 'POST', body: { add: true } });
  assert.ok(follows.isFollowing(KID, SHOW));
  await req(KID, `/api/items/${SHOW}/follow`, { method: 'POST', body: { follow: false } });
  await req(KID, `/api/items/${SHOW}/watchlist`, { method: 'POST', body: { add: true } });
  assert.equal(follows.isFollowing(KID, SHOW), false);
  await req(KID, `/api/items/${SHOW}/follow`, { method: 'POST', body: { follow: true } });
  // Sett klart ett avsnitt → serien följs automatiskt
  await req(OTHER, `/api/items/${ep(1, ADULT)}/progress`, { method: 'POST', body: { position: 990, duration: 1000 } });
  assert.ok(follows.isFollowing(OTHER, ADULT));
  assert.deepEqual((await req(ROOTUSER, '/api/follows')).data.map(x => x.id), [SHOW]);
});

test('nya avsnitt: skannern ger "Nytt för dig" och en samlad personlig notis', async () => {
  const sent = [];
  follows.setPoster(async (url, body, headers) => { sent.push({ url, body: JSON.parse(body), headers }); });
  // Personlig adress: valideras (inga inloggningsuppgifter i URL, rätt schema)
  assert.equal((await req(ROOTUSER, '/api/me/notify', { method: 'PUT', body: { kind: 'ntfy', url: 'ftp://x' } })).status, 400);
  assert.equal((await req(ROOTUSER, '/api/me/notify', { method: 'PUT', body: { kind: 'webhook', url: 'https://a:b@example.com/h' } })).status, 400);
  assert.equal((await req(KID, '/api/me/notify', { method: 'PUT', body: { kind: 'ntfy', url: 'https://ntfy.sh/x' } })).status, 403);
  let r = await req(ROOTUSER, '/api/me/notify', { method: 'PUT', body: { kind: 'ntfy', url: 'https://ntfy.sh/bamse-hemlig', token: 'tk' } });
  assert.deepEqual([r.data.kind, r.data.url, r.data.hasToken], ['ntfy', 'https://ntfy.sh/bamse-hemlig', true]);

  for (const n of [5, 6]) touch(path.join(SHOWDIR, 'Bamse', 'Season 1', `Bamse S01E0${n}.mkv`));
  touch(path.join(SHOWDIR, 'Vuxenserie', 'Season 1', 'Vuxenserie S01E02.mkv'));
  await sc.scan(LIB);
  await follows.flushAll();
  const fy = (await req(ROOTUSER, '/api/foryou')).data;
  assert.deepEqual(fy.map(x => x.episode).sort(), [5, 6]);
  assert.equal((await req(ROOTUSER, '/api/home')).data.forYou.length, 2);
  assert.equal((await req(KID, '/api/foryou')).data.length, 2, 'barnet följer också Bamse');
  assert.deepEqual((await req(OTHER, '/api/foryou')).data.map(x => x.title), ['Avsnitt 2']);
  // En notis för båda avsnitten, bara till den som angett adress
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://ntfy.sh');
  assert.equal(sent[0].body.topic, 'bamse-hemlig');
  assert.equal(sent[0].body.title, 'BraXhn TV: 2 nya avsnitt av Bamse');
  assert.match(sent[0].body.message, /Bamse: S01E05, S01E06/);
  assert.equal(sent[0].headers.Authorization, 'Bearer tk');

  // Fil byts mot bättre version (samma avsnitt): ingen ny notis eller rad
  fs.renameSync(path.join(SHOWDIR, 'Bamse', 'Season 1', 'Bamse S01E06.mkv'), path.join(SHOWDIR, 'Bamse', 'Season 1', 'Bamse S01E06 1080p.mkv'));
  await sc.scan(LIB);
  await follows.flushAll();
  assert.equal(sent.length, 1);
  assert.equal((await req(ROOTUSER, '/api/foryou')).data.length, 2, 'den nya filen ersätter den gamla i listan');
  // Sedd → försvinner; markera som läst
  watch(ROOTUSER, ep(5));
  assert.equal((await req(ROOTUSER, '/api/foryou')).data.length, 1);
  await req(ROOTUSER, '/api/foryou/seen', { method: 'POST', body: {} });
  assert.equal((await req(ROOTUSER, '/api/foryou')).data.length, 0);
});

test('notiser: sammanställning och SSRF-skydd för användarens adress', async () => {
  const eps = [{ show: 'A', season: 1, episode: 2, title: 'Två' }, { show: 'A', season: 1, episode: 1, title: 'Avsnitt 1' }, { show: 'B', season: 3, episode: 9, title: 'X' }];
  assert.deepEqual(follows.compose(eps), { title: '3 nya avsnitt', message: 'A: S01E01, S01E02 Två\nB: S03E09 X' });
  assert.equal(follows.compose([eps[2]]).title, 'Nytt avsnitt av B');
  await assert.rejects(pods.safePost('http://127.0.0.1:9/x', '{}'), /lokalt nätverk/);
  await assert.rejects(pods.safePost('http://[::ffff:192.168.1.1]/x', '{}'), /lokalt nätverk/);
  await assert.rejects(pods.safePost('file:///etc/passwd', '{}'), /http/);
});

// ---------------- automatisk offline-synk ----------------
test('offline-synk: nästa N osedda per serie och borttagning av sedda', async () => {
  const uid = OTHER;
  assert.equal((await req(uid, '/api/offline/sync')).data.enabled, false);
  // Följer Bamse med 2 avsnitt; har sett E01–E02 → E03, E04
  await req(uid, `/api/items/${SHOW}/follow`, { method: 'POST', body: { follow: true } });
  await req(uid, '/api/me/offline-sync', { method: 'PUT', body: { count: 2, quality: '480', wifiOnly: false } });
  watch(uid, ep(1)); watch(uid, ep(2));
  let r = await req(uid, `/api/offline/sync?have=${ep(1)},${ep(3)},999999`);
  assert.equal(r.data.enabled, true); assert.equal(r.data.quality, '480'); assert.equal(r.data.wifiOnly, false);
  const bamse = r.data.items.filter(x => x.show === SHOW).map(x => x.episode);
  assert.deepEqual(bamse, [3, 4]);
  assert.deepEqual(r.data.remove.sort((a, b) => a - b), [ep(1), 999999].sort((a, b) => a - b), 'sedda och borttagna tas bort, inte nästa avsnitt');
  // Per serie: 0 = av för just den serien
  await req(uid, `/api/items/${SHOW}/follow`, { method: 'POST', body: { sync: 0 } });
  r = await req(uid, '/api/offline/sync');
  assert.equal(r.data.items.filter(x => x.show === SHOW).length, 0);
  // Fortsätt titta: serier man tittat på nyligen (även utan att följa)
  await req(uid, `/api/items/${SHOW}/follow`, { method: 'POST', body: { follow: false } });
  await req(uid, '/api/me/offline-sync', { method: 'PUT', body: { scope: 'continue', count: 1 } });
  r = await req(uid, '/api/offline/sync');
  assert.deepEqual(r.data.items.map(x => x.episode), [2], 'Vuxenserie (påbörjad) – men inte avföljda Bamse');
  // Barnprofilens plan respekterar åldersgränsen
  await req(KID, '/api/me/offline-sync', { method: 'PUT', body: { count: 3 } });
  r = await req(KID, '/api/offline/sync');
  assert.ok(r.data.items.every(x => x.show === SHOW));
});
