// Personuppgifter (server/privacy.js, routes/privacy.js): exporten innehåller allt om kontot och dess profiler men
// inga hemligheter och inget om andra, radering (själv, av administratören, av en profil) lämnar inga spår i någon
// tabell – namn, IP-adress och koppling försvinner även där raden ska finnas kvar – och gallringen tar bort gamla
// loggrader och IP-adresser i historiken.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-privacy-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = path.join(ROOT, 'media');
process.env.WATCH_FILES = '0';
fs.mkdirSync(path.join(ROOT, 'media'), { recursive: true });
// Låtsas-TMDB för bilderna (/api/tmdbimg): räknar anropen så att cachen syns
const tmdbHits = [];
const fakeTmdb = http.createServer((q, r) => { tmdbHits.push(q.url); if (q.url === '/t/p/w154/affisch.jpg') { r.writeHead(200, { 'content-type': 'image/jpeg' }); r.end(Buffer.from([0xff, 0xd8, 0xff, 7])); } else { r.writeHead(404); r.end(); } });
await new Promise(r => fakeTmdb.listen(0, '127.0.0.1', r));
process.env.TMDB_IMAGE_URL = `http://127.0.0.1:${fakeTmdb.address().port}/t/p`;
const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const privacy = await import('../server/privacy.js');

const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fakeTmdb.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const PW = 'Integritet-test-2026!';
const NAME = 'Zebulon-unik', KID = 'Zebulon-barn', IP = '203.0.113.45', SECRET = 'scrobble-hemlighet-9f3a';
const T = Math.floor(Date.now() / 1000);
const addUser = async (name, { admin = 0, parent = null, maxAge = null } = {}) =>
  Number(D.run('INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES(?,?,?,?,?,?)', name, await auth.hashPw(PW), admin, T, parent, maxAge).lastInsertRowid);
const req = async (p, tok, { method = 'GET', body } = {}) => {
  const h = { authorization: 'Bearer ' + tok }; if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, text, data };
};

const OWNER = await addUser('ägaren', { admin: 1 });
const ZEB = await addUser(NAME), ZKID = await addUser(KID, { parent: ZEB, maxAge: 7 });
const OTHER = await addUser('Annan');
const LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", path.join(ROOT, 'media')).lastInsertRowid);
const ITEM = Number(D.run("INSERT INTO items(library_id,kind,title,year,path,added) VALUES(?,'movie','Testfilmen',2020,?,?)", LIB, path.join(ROOT, 'media', 'Testfilmen (2020).mkv'), T).lastInsertRowid);
const tok = { owner: auth.createSession(OWNER, 'app'), zeb: auth.createSession(ZEB, 'app'), kid: auth.createSession(ZKID, 'app'), other: auth.createSession(OTHER, 'app') };

/** Tittande, historik med IP, säkerhetslogg, koppling till Last.fm och en inbjudan – för kontot, profilen och någon annan */
function seed(uid, name) {
  D.run('INSERT INTO progress(user_id,item_id,position,watched,updated) VALUES(?,?,600,0,?)', uid, ITEM, T);
  D.run("INSERT INTO plays(user_id,item_id,ts,mode,device,ip,title,kind) VALUES(?,?,?,'direct','Firefox',?,'Testfilmen','movie')", uid, ITEM, T - 60, IP);
  D.run("INSERT INTO watchlist(user_id,item_id,added) VALUES(?,?,?)", uid, ITEM, T);
  auth.audit('login_ok', { user: { id: uid, name }, ip: IP });
  auth.audit('profile_updated', { user: { id: OWNER, name: 'ägaren' }, ip: '192.168.1.2', detail: name });
}
seed(ZEB, NAME); seed(ZKID, KID); seed(OTHER, 'Annan');
D.run("INSERT INTO scrobble_accounts(user_id,service,secret,username,connected) VALUES(?,'lastfm',?,'zeb_fm',?)", ZEB, SECRET, T);
D.run("INSERT INTO invites(token_hash,created_by,used_by,created,expires,perms) VALUES('abc123hash',?,?,?,?,'{}')", OWNER, ZEB, T, T + 86400);

/** Alla rader i alla tabeller som nämner något av orden (text) – raderingen ska inte lämna något */
function mentions(words) {
  const hits = [];
  for (const { name } of D.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'")) {
    const cols = D.all(`PRAGMA table_info("${name}")`).filter(c => !c.type || /TEXT|CHAR|CLOB/i.test(c.type)).map(c => c.name);
    for (const c of cols) for (const w of words) {
      const n = D.get(`SELECT COUNT(*) AS n FROM "${name}" WHERE instr(CAST("${c}" AS TEXT), ?) > 0`, w).n;
      if (n) hits.push(`${name}.${c} (${w}): ${n}`);
    }
  }
  return hits;
}
/** Rader som fortfarande pekar på något av kontona */
const refs = (ids) => privacy.userRefs().flatMap(r => {
  const n = D.get(`SELECT COUNT(*) AS n FROM "${r.table}" WHERE "${r.col}" IN (${ids.map(() => '?').join(',')})`, ...ids).n;
  return n ? [`${r.table}.${r.col}: ${n}`] : [];
});

test('exporten: kontot och dess profiler, med titlar – inga hemligheter och inget om andra', async () => {
  const r = await req('/api/me/export', tok.zeb);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="braxhn-tv-mina-uppgifter-\d{4}-\d\d-\d\d\.json"/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const E = r.data;
  assert.deepEqual(E.users.map(u => u.name).sort(), [KID, NAME].sort(), 'profilen kommer med huvudkontot');
  assert.equal(E.tables.progress.length, 2); assert.equal(E.tables.plays.length, 2); assert.equal(E.tables.watchlist.length, 2);
  assert.ok(E.tables.audit.some(a => a.event === 'login_ok' && a.ip === IP), 'säkerhetsloggen med IP');
  assert.equal(E.tables.scrobble_accounts[0].username, 'zeb_fm');
  assert.equal(E.tables.invites.length, 1);
  assert.equal(E.items[ITEM].title, 'Testfilmen', 'titlarna raderna pekar på');
  // Inga hemligheter: lösenordshash, scrobble-nyckel, inloggningstoken, inbjudans hash
  const hash = D.get('SELECT pass FROM users WHERE id=?', ZEB).pass;
  for (const s of [hash, SECRET, tok.zeb, 'abc123hash']) assert.ok(!r.text.includes(s), `exporten innehåller inte ${s.slice(0, 12)}…`);
  for (const u of E.users) for (const k of ['pass', 'pin', 'totp_secret', 'recovery']) assert.ok(!(k in u), k);
  assert.ok(!E.tables.sessions || E.tables.sessions.every(s => !('token' in s)));
  // Inget om andra
  assert.ok(!r.text.includes('"Annan"'));
  assert.ok(E.tables.plays.every(p => [ZEB, ZKID].includes(p.user_id)));
  // Profilen får bara sitt eget
  const K = (await req('/api/me/export', tok.kid)).data;
  assert.deepEqual(K.users.map(u => u.name), [KID]); assert.equal(K.tables.progress.length, 1);
  // Exporten loggas
  assert.ok(D.get("SELECT 1 FROM audit WHERE event='data_exported' AND user_id=?", ZEB));
});

test('sidan Integritet: lagringstider, kontakt och vem som får radera sig själv', async () => {
  D.setSetting('privacy_contact', 'Ägaren, ägaren@example.com');
  const P = (await req('/api/privacy', tok.zeb)).data;
  assert.equal(P.contact, 'Ägaren, ägaren@example.com');
  assert.deepEqual(P.retention, { historyDays: 365, auditDays: 180, ipDays: 90 });
  assert.equal(P.canDeleteSelf, true); assert.equal(P.hasPassword, true);
  assert.equal(P.services.scrobble, true); assert.equal(P.services.relay, false);
  assert.equal((await req('/api/privacy', tok.owner)).data.canDeleteSelf, false, 'administratören');
  assert.equal((await req('/api/privacy', tok.kid)).data.canDeleteSelf, false, 'profilen');
  // Administratören ställer in kontakt och loggtid (från hemnätet); loggtiden har golv och tak
  assert.equal((await req('/api/settings', tok.owner, { method: 'PUT', body: { privacyContact: 'Ny kontakt\n', auditDays: 5 } })).status, 200);
  assert.equal(privacy.contact(), 'Ny kontakt'); assert.equal(privacy.auditDays(), 30);
  await req('/api/settings', tok.owner, { method: 'PUT', body: { auditDays: 180 } });
  assert.equal((await req('/api/privacy', tok.zeb)).status, 200);
  assert.equal((await fetch(B + '/api/privacy')).status, 401, 'kräver inloggning');
});

test('radera mitt konto: bara vanliga huvudkonton, med lösenordet – och inga spår i någon tabell', async () => {
  assert.equal((await req('/api/me', tok.owner, { method: 'DELETE', body: { password: PW } })).status, 400, 'administratören');
  assert.equal((await req('/api/me', tok.kid, { method: 'DELETE', body: { password: PW } })).status, 400, 'profilen');
  const bad = await req('/api/me', tok.zeb, { method: 'DELETE', body: { password: 'fel' } });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /Lösenordet/);
  assert.ok(D.get('SELECT 1 FROM users WHERE id=?', ZEB), 'finns kvar efter fel lösenord');
  const r = await req('/api/me', tok.zeb, { method: 'DELETE', body: { password: PW } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers.get('set-cookie') || '', /Max-Age=0/);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM users WHERE id IN (?,?)', ZEB, ZKID).n, 0, 'kontot och profilen');
  assert.deepEqual(refs([ZEB, ZKID]), [], 'inga rader pekar på kontona');
  assert.deepEqual(mentions([NAME, KID, 'zeb_fm', SECRET]), [], 'namnen finns inte kvar någonstans');
  assert.equal(D.get('SELECT COUNT(*) AS n FROM plays WHERE ip=?', IP).n, 1, 'bara den andra användarens historik är kvar');
  assert.equal((await req('/api/status', tok.zeb)).data.user, null, 'utloggad');
  const ev = D.get("SELECT * FROM audit WHERE event='account_self_deleted'");
  assert.ok(ev); assert.equal(ev.user_id, null); assert.equal(ev.ip, null); assert.equal(ev.user_name, null);
  // Inbjudan finns kvar (ägarens), men utan koppling till det raderade kontot
  assert.equal(D.get("SELECT used_by FROM invites WHERE token_hash='abc123hash'").used_by, null);
});

test('administratören tar bort en användare: historik och namn i loggen försvinner också', async () => {
  const r = await req('/api/users/' + OTHER, tok.owner, { method: 'DELETE' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(refs([OTHER]), []);
  assert.deepEqual(mentions(['Annan']), []);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM plays').n, 0);
  assert.ok(D.get("SELECT 1 FROM audit WHERE event='user_deleted' AND detail=?", '#' + OTHER), 'händelsen loggas med id, inte namn');
});

test('en profil tas bort av huvudkontot: profilens historik och namn försvinner', async () => {
  const main = await addUser('Huvud'), prof = await addUser('Profil-unik', { parent: main });
  seed(prof, 'Profil-unik');
  const r = await req('/api/profiles/' + prof, auth.createSession(main, 'app'), { method: 'DELETE' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(refs([prof]), []);
  assert.deepEqual(mentions(['Profil-unik']), []);
});

test('gallring: gamla loggrader och IP-adresser i historiken tas bort, resten finns kvar', () => {
  const u = OWNER;
  D.run("INSERT INTO audit(ts,user_id,user_name,ip,event) VALUES(?,?,?,?,'login_ok')", T - 200 * 86400, u, 'ägaren', '198.51.100.1');
  D.run("INSERT INTO audit(ts,user_id,user_name,ip,event) VALUES(?,?,?,?,'login_ok')", T - 10 * 86400, u, 'ägaren', '198.51.100.2');
  D.run("INSERT INTO plays(user_id,item_id,ts,mode,ip) VALUES(?,?,?,'direct','198.51.100.3')", u, ITEM, T - 100 * 86400);
  D.run("INSERT INTO plays(user_id,item_id,ts,mode,ip) VALUES(?,?,?,'direct','198.51.100.4')", u, ITEM, T - 10 * 86400);
  const r = privacy.prune(T);
  assert.ok(r.audit >= 1 && r.ips >= 1, JSON.stringify(r));
  assert.ok(!D.get("SELECT 1 FROM audit WHERE ip='198.51.100.1'"), 'äldre än 180 dagar');
  assert.ok(D.get("SELECT 1 FROM audit WHERE ip='198.51.100.2'"));
  const old = D.get('SELECT ip FROM plays WHERE ts=?', T - 100 * 86400);
  assert.ok(old, 'raden finns kvar för statistiken'); assert.equal(old.ip, null);
  assert.equal(D.get('SELECT ip FROM plays WHERE ts=?', T - 10 * 86400).ip, '198.51.100.4');
});

test('TMDB-bilder via servern: webbläsaren kontaktar aldrig TMDB, och bara giltiga storlekar och filnamn', async () => {
  const r = await req('/api/tmdbimg/w154/affisch.jpg', tok.owner);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.match(r.headers.get('cache-control'), /private/);
  assert.equal((await req('/api/tmdbimg/w154/affisch.jpg', tok.owner)).status, 200);
  assert.equal(tmdbHits.filter(u => u === '/t/p/w154/affisch.jpg').length, 1, 'andra gången från minnet');
  for (const bad of ['/api/tmdbimg/w9999/affisch.jpg', '/api/tmdbimg/w154/..%2Fetc.jpg', '/api/tmdbimg/w154/a.html', '/api/tmdbimg/w154/finnsinte.jpg']) assert.equal((await req(bad, tok.owner)).status, 404, bad);
  assert.equal(tmdbHits.length, 2, 'ogiltiga adresser skickas aldrig vidare');
  assert.equal((await fetch(B + '/api/tmdbimg/w154/affisch.jpg')).status, 401, 'kräver inloggning');
  // CSP: bilder bara från servern
  const csp = (await fetch(B + '/')).headers.get('content-security-policy') || '';
  assert.match(csp, /img-src 'self' data: blob:;/); assert.ok(!csp.includes('image.tmdb.org'));
  // Webbens omskrivning
  const { tmdbImg } = await import('../web/js/core.js').catch(() => ({}));
  if (tmdbImg) {
    assert.equal(tmdbImg('https://image.tmdb.org/t/p/w92/abc.png'), '/api/tmdbimg/w92/abc.png');
    assert.equal(tmdbImg('/api/image/1/poster'), '/api/image/1/poster');
    assert.equal(tmdbImg(null), null);
  }
});
