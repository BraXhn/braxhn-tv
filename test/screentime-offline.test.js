// Skärmtid som spelats utan nät: POST /api/screentime/offline (server/screentime.js addOffline).
// Tiden räknas på dagen den spelades (lokal tid, TZ), bara en gång per verklig sekund, med tak per post och dag.
// Körs i samma process (servern startas på en slumpad port); kräver inte ffmpeg.
process.env.TZ = 'Europe/Stockholm'; // som i Dockerfile – före all datumhantering
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-sto-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = path.join(ROOT, 'media');
process.env.WATCH_FILES = '0';
fs.mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
const D = await import('../server/db.js');
const screen = await import('../server/screentime.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');

const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const PARENT = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('mamma','x',0,0)").lastInsertRowid);
const KID = Number(D.run("INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES('lisa','x',0,0,?,7)", PARENT).lastInsertRowid);
const SIB = Number(D.run("INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES('olle','x',0,0,?,7)", PARENT).lastInsertRowid);
const tok = { [PARENT]: auth.createSession(PARENT, 'app'), [KID]: auth.createSession(KID, 'app'), [SIB]: auth.createSession(SIB, 'app') };
async function req(uid, p, { method = 'GET', body } = {}) {
  const h = uid ? { Authorization: `Bearer ${tok[uid]}` } : {};
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
let n = 0;
/** Ny profil med skärmtid (egen användare per test, så att testerna inte delar räknad tid) */
function kid(rules = { daily: 600 }) {
  const uid = Number(D.run(`INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES('barn${++n}','x',0,0,?,7)`, PARENT).lastInsertRowid);
  screen.setRules(uid, rules);
  return uid;
}
const sec = (d) => d.getTime() / 1000; // Unix-sekunder, som at i apparna
const used = (uid, y, m, d) => screen.status(uid, new Date(y, m - 1, d, 12)).used;

test('tiden räknas på dagen den spelades, även när den skickas dagen efter – och delas vid midnatt', () => {
  const uid = kid();
  const now = new Date(2026, 10, 12, 9).getTime(); // torsdag 12 nov 09:00: nätet är tillbaka
  // 11 nov 18:00, 30 min – och 11 nov 23:40 i 50 min (20 min före midnatt, 30 min efter)
  const r = screen.addOffline(uid, [
    { id: 'a', at: sec(new Date(2026, 10, 11, 18)), seconds: 1800 },
    { id: 'b', at: sec(new Date(2026, 10, 11, 23, 40)), seconds: 3000 }
  ], { device: 'surfplatta', now });
  assert.equal(r.added, 4800);
  assert.deepEqual(r.done, ['a', 'b']);
  assert.equal(used(uid, 2026, 11, 11), 1800 + 1200, 'dagen då det spelades');
  assert.equal(used(uid, 2026, 11, 12), 1800, 'efter midnatt: nästa dag');
  assert.equal(used(uid, 2026, 11, 10), 0);
});

test('sommartid (29 mars 2026): natten har 23 timmar och tiden räknas i verkliga sekunder', () => {
  const uid = kid();
  const now = new Date(2026, 2, 30, 12).getTime();
  // 28 mars 23:00 i tre verkliga timmar: en timme den 28:e, två timmar den 29:e (klockan visar 03:00 → 03:00 efter 2 h)
  const start = new Date(2026, 2, 28, 23);
  screen.addOffline(uid, [{ id: 'natt', at: sec(start), seconds: 3 * 3600 }], { now });
  assert.equal(used(uid, 2026, 3, 28), 3600);
  assert.equal(used(uid, 2026, 3, 29), 7200);
  // Klockan hoppar fram: 01:30–03:30 enligt klockan är en verklig timme
  const uid2 = kid();
  const a = new Date(2026, 2, 29, 1, 30), b = new Date(2026, 2, 29, 3, 30);
  assert.equal(sec(b) - sec(a), 3600);
  screen.addOffline(uid2, [{ id: 'x', at: sec(a), seconds: sec(b) - sec(a) }], { now });
  assert.equal(used(uid2, 2026, 3, 29), 3600);
});

test('vintertid (25 oktober 2026): natten har 25 timmar och båda timmarna 02–03 räknas', () => {
  const uid = kid();
  const now = new Date(2026, 9, 26, 12).getTime();
  const midnight = new Date(2026, 9, 25, 0);
  // Hela dygnet 25 oktober är 25 verkliga timmar; en post på 4 h från 01:00 slutar 04:00 enligt klockan
  screen.addOffline(uid, [{ id: 'v', at: sec(new Date(2026, 9, 25, 1)), seconds: 4 * 3600 }], { now });
  assert.equal(used(uid, 2026, 10, 25), 4 * 3600);
  assert.equal(new Date((sec(new Date(2026, 9, 25, 1)) + 4 * 3600) * 1000).getHours(), 4, 'klockan går tillbaka en timme');
  // 24 oktober 23:00 + 2 h: en timme var dag
  const uid2 = kid();
  screen.addOffline(uid2, [{ id: 'k', at: sec(new Date(2026, 9, 24, 23)), seconds: 7200 }], { now });
  assert.equal(used(uid2, 2026, 10, 24), 3600);
  assert.equal(used(uid2, 2026, 10, 25), 3600);
  assert.equal(sec(new Date(2026, 9, 26, 0)) - sec(midnight), 25 * 3600);
});

test('samma post två gånger räknas en gång; en post som växt räknas bara med det nya; överlapp räknas en gång', () => {
  const uid = kid();
  const now = new Date(2026, 10, 20, 20).getTime();
  const at = sec(new Date(2026, 10, 20, 10));
  const e = { id: 'resa-1', at, seconds: 600 };
  assert.equal(screen.addOffline(uid, [e], { device: 'telefon', now }).added, 600);
  assert.equal(screen.addOffline(uid, [e], { device: 'telefon', now }).added, 0, 'skickad igen (svaret kom aldrig fram)');
  assert.equal(screen.addOffline(uid, [e, e], { device: 'telefon', now }).added, 0);
  // Appen fortsatte räkna på samma post: bara de nya 300 sekunderna
  assert.equal(screen.addOffline(uid, [{ ...e, seconds: 900 }], { device: 'telefon', now }).added, 300);
  // En kortare version av samma post tar aldrig bort något
  assert.equal(screen.addOffline(uid, [{ ...e, seconds: 60 }], { device: 'telefon', now }).added, 0);
  // Samma tid från en annan enhet (eller med nytt id) räknas inte igen – tiden räknas per profil och väggklocka
  assert.equal(screen.addOffline(uid, [{ id: 'annan', at: at + 300, seconds: 900 }], { device: 'surfplatta', now }).added, 300);
  assert.equal(used(uid, 2026, 11, 20), 1200);
  // Samma id med en tid som inte hänger ihop med den sparade posten: räknas inte (första vinner)
  assert.equal(screen.addOffline(uid, [{ id: 'resa-1', at: at + 7200, seconds: 600 }], { device: 'telefon', now }).added, 0);
  assert.equal(used(uid, 2026, 11, 20), 1200);
});

test('för stora värden: tak per post, per dag, ingen framtid, inget minus och inget skräp', () => {
  const uid = kid();
  const now = new Date(2026, 10, 25, 23, 59).getTime();
  const r = screen.addOffline(uid, [
    { id: 'jätte', at: sec(new Date(2026, 10, 25, 0)), seconds: 1e9 },        // tak per post
    { id: 'framtid', at: now / 1000 + 3600, seconds: 600 },                    // har inte hänt än
    { id: 'pågår', at: now / 1000 - 30, seconds: 3600 },                       // högst fram till nu
    { id: 'minus', at: sec(new Date(2026, 10, 25, 9)), seconds: -500 },
    { id: 'text', at: 'igår', seconds: 'mycket' },
    { id: 'gammal', at: sec(new Date(2026, 5, 1, 12)), seconds: 600 },          // äldre än 60 dagar
    { at: sec(new Date(2026, 10, 25, 9)), seconds: 60 },                        // utan id
    null, 7
  ], { now });
  assert.equal(r.added, screen.OFFLINE_ENTRY + 30);
  assert.deepEqual(r.done, ['jätte', 'framtid', 'pågår', 'minus', 'text', 'gammal'], 'allt med id kan tas bort ur appens kö');
  // Tak per dag: många poster på samma dag ger högst OFFLINE_DAY
  const day = new Date(2026, 10, 24, 0).getTime() / 1000;
  const many = Array.from({ length: 24 }, (_, i) => ({ id: 'h' + i, at: day + i * 3600, seconds: 3600 }));
  screen.addOffline(uid, many, { now });
  assert.equal(used(uid, 2026, 11, 24), screen.OFFLINE_DAY);
  // Högst OFFLINE_MAX poster per anrop
  const lots = Array.from({ length: screen.OFFLINE_MAX + 50 }, (_, i) => ({ id: 'm' + i, at: sec(new Date(2026, 10, 23, 8)) + i * 10, seconds: 10 }));
  assert.equal(screen.addOffline(uid, lots, { now }).done.length, screen.OFFLINE_MAX);
});

test('bara ökning: tid som redan räknats på nätet finns kvar, och extra tid påverkas inte', () => {
  const uid = kid({ daily: 30 });
  const t0 = new Date(2026, 10, 26, 10).getTime();
  for (let i = 0; i <= 6; i++) screen.heartbeat(uid, 'i:1', i * 10, { at: t0 + i * 10e3 });
  screen.addExtra(uid, 5, new Date(t0));
  assert.equal(screen.status(uid, new Date(t0 + 60e3)).used, 60);
  const r = screen.addOffline(uid, [{ id: 'p', at: (t0 - 3600e3) / 1000, seconds: 1500 }], { now: t0 + 60e3 });
  assert.equal(r.added, 1500);
  const s = screen.status(uid, new Date(t0 + 60e3));
  assert.equal(s.used, 1560); assert.equal(s.extra, 5);
  assert.equal(s.remaining, 35 * 60 - 1560);
});

test('ljud räknas bara när regeln gäller ljud; vuxen profil utan skärmtid lämnas orörd', () => {
  const uid = kid({ daily: 60 });
  const now = new Date(2026, 10, 26, 20).getTime();
  const at = sec(new Date(2026, 10, 26, 9));
  assert.equal(screen.addOffline(uid, [{ id: 'bok', at, seconds: 600, audio: true }], { now }).added, 0);
  assert.equal(screen.addOffline(uid, [{ id: 'film', at, seconds: 600 }], { now }).added, 600);
  const adult = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('pappa','x',0,0)").lastInsertRowid);
  assert.deepEqual(screen.addOffline(adult, [{ id: 'film', at, seconds: 600 }], { now }), { added: 0, done: ['film'], status: null });
  assert.equal(D.get('SELECT COUNT(*) n FROM screen_usage WHERE user_id=?', adult).n, 0);
  assert.equal(D.get('SELECT COUNT(*) n FROM screen_offline WHERE user_id=?', adult).n, 0);
});

// ---------------- HTTP ----------------
const ago = (min) => Math.floor(Date.now() / 1000) - min * 60;

test('POST /api/screentime/offline: svaret har statusen i samma form som screenTime i framstegssvaret', async () => {
  screen.setRules(KID, { daily: 120 });
  const before = (await req(KID, '/api/screentime')).data;
  const r = await req(KID, '/api/screentime/offline', { method: 'POST', body: { device: 'tel-1', entries: [{ id: 'f1', at: ago(40), seconds: 900 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added, 900);
  assert.deepEqual(r.data.done, ['f1']);
  assert.equal(r.data.stop, false);
  assert.deepEqual(Object.keys(r.data.screenTime).sort(), Object.keys(before).sort());
  assert.equal(r.data.screenTime.used, before.used + 900);
  // Igen (svaret kom inte fram): ingen ändring
  const again = await req(KID, '/api/screentime/offline', { method: 'POST', body: { device: 'tel-1', entries: [{ id: 'f1', at: ago(40), seconds: 900 }] } });
  assert.equal(again.data.added, 0); assert.equal(again.data.screenTime.used, before.used + 900);
  // Engelska: beskedet på profilens språk som i framstegssvaret
  screen.setRules(KID, { daily: 1 });
  const en = await fetch(B + '/api/screentime/offline', { method: 'POST', headers: { Authorization: `Bearer ${tok[KID]}`, 'Content-Type': 'application/json', 'Accept-Language': 'en' }, body: '{"entries":[]}' }).then(x => x.json());
  assert.equal(en.stop, true); assert.equal(en.screenTime.allowed, false); assert.equal(en.screenTime.reason, 'limit');
  screen.setRules(KID, { daily: 120 });
});

test('POST /api/screentime/offline: behörighet – inloggning krävs, ingen kan lämna in åt någon annan, vuxen utan skärmtid', async () => {
  screen.setRules(SIB, { daily: 120 });
  assert.equal((await req(null, '/api/screentime/offline', { method: 'POST', body: { entries: [] } })).status, 401);
  const sib0 = screen.status(SIB).used, kid0 = screen.status(KID).used;
  // Barnprofilen försöker lämna in åt syskonet: räknas på den egna profilen
  const r = await req(KID, '/api/screentime/offline', { method: 'POST', body: { uid: SIB, userId: SIB, user: SIB, entries: [{ id: 'syskon', at: ago(200), seconds: 120 }] } });
  assert.equal(r.status, 200);
  assert.equal(screen.status(SIB).used, sib0);
  assert.equal(screen.status(KID).used, kid0 + 120);
  // /api/screentime/:uid/offline finns inte (bara den egna profilen)
  assert.equal((await req(PARENT, `/api/screentime/${KID}/offline`, { method: 'POST', body: { entries: [{ id: 'x', at: ago(300), seconds: 60 }] } })).status, 404);
  // Vuxen utan skärmtid: 200, inget räknas, screenTime null
  const a = await req(PARENT, '/api/screentime/offline', { method: 'POST', body: { entries: [{ id: 'v', at: ago(100), seconds: 600 }] } });
  assert.equal(a.status, 200); assert.equal(a.data.added, 0); assert.equal(a.data.screenTime, null); assert.equal(a.data.stop, false);
  assert.deepEqual(a.data.done, ['v']);
  // Fel form på kroppen: 200 utan att något räknas
  const bad = await req(KID, '/api/screentime/offline', { method: 'POST', body: { entries: 'många' } });
  assert.equal(bad.status, 200); assert.equal(bad.data.added, 0);
});
