// Enkel inloggning (server/sso.js, oidc.js, ldap.js, routes/sso.js) mot en simulerad OIDC-leverantör (egna nycklar,
// discovery, authorize, token-endpoint med PKCE-kontroll, JWKS, userinfo) och en simulerad LDAP-server (minimal
// BER-server i testet med egen avkodning: bind, sökning med filter, StartTLS och LDAPS). Kontrollerar lyckad inloggning,
// felaktig signatur, fel nonce/aud/iss, utgånget token och klockavvikelse, state bundet till webbläsaren, grupper → roll
// och bibliotek, bekräftad koppling till befintligt konto, LDAP-injektion, tidsgränser, reservinloggning för
// administratören och att hemligheter aldrig syns i API-svar eller loggar. Körs i samma process; kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-sso-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = path.join(ROOT, 'media');
process.env.WATCH_FILES = '0';
fs.mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
// Allt som servern skriver i loggen samlas – inga hemligheter får finnas där
const logged = [];
for (const k of ['log', 'warn', 'error']) { const orig = console[k]; console[k] = (...a) => { logged.push(a.map(String).join(' ')); if (k === 'error') orig(...a); }; }
const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const ldapc = await import('../server/ldap.js');

const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
const CLIENT_SECRET = 'hemlig-klient-' + crypto.randomBytes(8).toString('hex');
const BIND_PW = 'tjanst-' + crypto.randomBytes(8).toString('hex');

const ADMIN = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('admin',?,1,0)", await auth.hashPw('Admin-lösen-123')).lastInsertRowid);
const ADM = auth.createSession(ADMIN, 'app');
D.run("INSERT INTO libraries(id,name,type,path) VALUES(1,'Filmer','movie','/m/f'),(2,'Barn','movie','/m/b')");

let ipSeq = 0;
const lan = () => `192.168.70.${++ipSeq % 250 + 1}`;
async function req(p, { method = 'GET', body, token = ADM, headers = {}, ip = '192.168.69.1', cookie } = {}) {
  const h = { 'x-forwarded-for': ip, ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = cookie;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : await r.text() };
}
const cookieOf = (r, name) => (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => c.startsWith(name + '='));

// ---------------- simulerad OIDC-leverantör ----------------
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaOther = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (k, kid, alg) => ({ ...k.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' });
const IDP = { mode: 'ok', user: null, codes: new Map(), seen: [], tokenCalls: 0 };
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function sign(claims, { alg = 'RS256', kid = 'rsa1', key = rsa.privateKey } = {}) {
  const head = b64u({ alg, kid, typ: 'JWT' }) + '.' + b64u(claims);
  if (alg === 'none') return head + '.';
  const sig = alg === 'ES256' ? crypto.sign('sha256', Buffer.from(head), { key, dsaEncoding: 'ieee-p1363' }) : crypto.sign('sha256', Buffer.from(head), key);
  return head + '.' + sig.toString('base64url');
}
const idp = http.createServer(async (rq, rs) => {
  const u = new URL(rq.url, ISS);
  const json = (code, o) => { rs.writeHead(code, { 'content-type': 'application/json' }); rs.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/openid-configuration') return json(200, { issuer: ISS, authorization_endpoint: ISS + '/authorize', token_endpoint: ISS + '/token',
    jwks_uri: ISS + '/jwks', userinfo_endpoint: ISS + '/userinfo', token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256', 'ES256'] });
  if (u.pathname === '/jwks') return json(200, { keys: [jwk(rsa, 'rsa1', 'RS256'), jwk(ec, 'ec1', 'ES256')] });
  if (u.pathname === '/authorize') {
    // "Användaren loggar in": koden knyts till nonce och code_challenge
    IDP.seen.push(Object.fromEntries(u.searchParams));
    const code = crypto.randomBytes(16).toString('hex');
    IDP.codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri'), user: IDP.user });
    const back = new URL(u.searchParams.get('redirect_uri'));
    if (IDP.mode === 'deny') back.searchParams.set('error', 'access_denied'); else back.searchParams.set('code', code);
    back.searchParams.set('state', u.searchParams.get('state'));
    rs.writeHead(302, { location: back.href }); return rs.end();
  }
  if (u.pathname === '/token') {
    IDP.tokenCalls++;
    let body = ''; for await (const c of rq) body += c;
    const f = new URLSearchParams(body);
    const basic = Buffer.from(String(rq.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
    if (basic !== `braxhn:${encodeURIComponent(CLIENT_SECRET)}`) return json(401, { error: 'invalid_client' });
    const c = IDP.codes.get(f.get('code')); IDP.codes.delete(f.get('code'));
    if (!c) return json(400, { error: 'invalid_grant' });
    // PKCE: verifieraren måste ge samma challenge (S256) och redirect_uri vara densamma
    if (crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant_pkce' });
    if (f.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_redirect' });
    const t = Math.floor(Date.now() / 1000), m = IDP.mode;
    const claims = { iss: m === 'iss' ? ISS + '/fel' : ISS, aud: m === 'aud' ? 'nagon-annan' : 'braxhn', sub: c.user.sub, nonce: m === 'nonce' ? 'fel-nonce' : c.nonce,
      iat: m === 'future' ? t + 600 : m === 'skew' ? t + 60 : t, exp: m === 'expired' ? t - 600 : t + 300, preferred_username: c.user.name, email: c.user.email,
      email_verified: true, name: c.user.display || c.user.name, ...(c.user.groupsInToken === false ? {} : { groups: c.user.groups }) };
    const id_token = m === 'badsig' ? sign(claims, { key: rsaOther.privateKey }) : m === 'es256' ? sign(claims, { alg: 'ES256', kid: 'ec1', key: ec.privateKey })
      : m === 'none' ? sign(claims, { alg: 'none' }) : m === 'hs256' ? (() => { const h = b64u({ alg: 'HS256', kid: 'rsa1' }) + '.' + b64u(claims); return h + '.' + crypto.createHmac('sha256', CLIENT_SECRET).update(h).digest('base64url'); })() : sign(claims);
    return json(200, { access_token: 'at-' + c.user.sub, token_type: 'Bearer', id_token, expires_in: 300 });
  }
  if (u.pathname === '/userinfo') {
    const sub = String(rq.headers.authorization || '').replace(/^Bearer at-/, '');
    return json(200, { sub, groups: ['bx-users'] });
  }
  json(404, {});
});
await new Promise(r => idp.listen(0, '127.0.0.1', r));
const ISS = `http://127.0.0.1:${idp.address().port}`;

/** Hela flödet i "webbläsaren": start → leverantören → återkomsten. Returnerar { location, kt, start } */
async function oidcLogin(pid, user, { mode = 'ok', ip = lan(), cookie, tamper } = {}) {
  IDP.mode = mode; IDP.user = user;
  const s = await req(`/api/sso/oidc/${pid}/start?remember=1`, { token: null, ip, cookie });
  assert.equal(s.status, 302, JSON.stringify(s.data));
  const bx = cookieOf(s, 'bxsso');
  const a = await fetch(s.headers.get('location'), { redirect: 'manual' });
  let cb = a.headers.get('location');
  if (tamper) cb = tamper(cb);
  const r = await req(new URL(cb).pathname + new URL(cb).search, { token: null, ip, cookie: [bx, cookie].filter(Boolean).join('; ') });
  assert.equal(r.status, 302);
  return { location: r.headers.get('location'), kt: cookieOf(r, 'kt'), start: s, bx };
}
const statusWith = async (kt) => (await req('/api/status', { token: null, cookie: kt })).data.user;

after(() => { srv.close(); idp.close(); ldapSrv?.close(); ldapsSrv?.close(); hang?.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

let OIDC;
test('OIDC: administratören lägger till leverantören – hemligheten lämnas aldrig ut, admin kräver hemnätet', async () => {
  const bad = await req('/api/sso/providers', { method: 'POST', body: { kind: 'oidc', name: 'Google', issuer: ISS, clientId: 'x', autoCreate: true } });
  assert.equal(bad.status, 400, 'automatiska konton utan grupper eller e-postlista nekas');
  const r = await req('/api/sso/providers', { method: 'POST', body: { kind: 'oidc', name: 'Authentik', issuer: ISS, clientId: 'braxhn', clientSecret: CLIENT_SECRET,
    autoCreate: true, groups: { admin: ['bx-admins'], user: ['bx-users'], kid: ['/bx-kids'] }, kidAge: 7, libraries: [{ group: 'bx-kids', ids: [2] }], redirectBase: B } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  OIDC = r.data.provider.id;
  assert.equal(r.data.provider.redirectUri, `${B}/api/sso/oidc/${OIDC}/callback`);
  const list = await req('/api/sso');
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.data).includes(CLIENT_SECRET), 'klienthemligheten finns inte i svaret');
  assert.equal(list.data.providers[0].hasSecret, true);
  assert.ok(!String(D.get('SELECT secret FROM sso_providers WHERE id=?', OIDC).secret).includes(CLIENT_SECRET), 'krypterad i databasen');
  // Utifrån: administrationen nekas
  assert.equal((await req('/api/sso', { ip: '203.0.113.9' })).status, 403);
  const test1 = await req(`/api/sso/providers/${OIDC}/test`, { method: 'POST', body: {} });
  assert.equal(test1.data.ok, true, JSON.stringify(test1.data));
  assert.equal(test1.data.pkce, true);
  // Knappen på inloggningssidan (utan inloggning) – utan hemligheter
  const pubList = await req('/api/sso/providers', { token: null });
  assert.deepEqual(pubList.data.providers, [{ id: OIDC, name: 'Authentik', kind: 'oidc' }]);
});

test('OIDC: lyckad inloggning skapar konto, PKCE och vitlistad redirect-URI, grupp → roll och bibliotek', async () => {
  const r = await oidcLogin(OIDC, { sub: 'u-1', name: 'kalle', email: 'kalle@example.com', groups: ['bx-users'] });
  assert.equal(r.location, '/#/login/done');
  assert.ok(r.kt, 'kaka för webben');
  const seen = IDP.seen.at(-1);
  assert.equal(seen.redirect_uri, `${B}/api/sso/oidc/${OIDC}/callback`);
  assert.equal(seen.code_challenge_method, 'S256');
  assert.ok(seen.nonce && seen.state && seen.code_challenge);
  assert.match(seen.scope, /openid/);
  const me = await statusWith(r.kt);
  assert.equal(me.name, 'kalle'); assert.equal(me.is_admin, 0); assert.equal(me.kid, false);
  assert.equal(D.get('SELECT managed FROM sso_links WHERE subject=?', 'u-1').managed, 1);
  // Samma användare igen: samma konto
  const again = await oidcLogin(OIDC, { sub: 'u-1', name: 'kalle', email: 'kalle@example.com', groups: ['bx-users'] });
  assert.equal((await statusWith(again.kt)).id, me.id);
  // Grupp → administratör, barn (med åldersgräns och bibliotek) – kontot följer grupperna vid varje inloggning
  const a = await oidcLogin(OIDC, { sub: 'u-2', name: 'mamma', email: 'mamma@example.com', groups: ['bx-admins'] });
  assert.equal((await statusWith(a.kt)).is_admin, 1);
  const k = await oidcLogin(OIDC, { sub: 'u-3', name: 'lisa', email: 'lisa@example.com', groups: ['bx-kids'] }); // "/bx-kids" i regeln = Keycloak-stil
  const kid = await statusWith(k.kt);
  assert.equal(kid.kid, true); assert.equal(kid.maxAge, 7);
  assert.equal(D.get('SELECT libraries FROM users WHERE id=?', kid.id).libraries, '[2]');
  await oidcLogin(OIDC, { sub: 'u-2', name: 'mamma', email: 'mamma@example.com', groups: ['bx-users'] });
  assert.equal(D.get("SELECT is_admin FROM users WHERE name='mamma'").is_admin, 0, 'flyttad ur admingruppen');
  // Grupper bara från userinfo (inte i ID-token)
  const ui = await oidcLogin(OIDC, { sub: 'u-4', name: 'olle', email: 'olle@example.com', groupsInToken: false });
  assert.equal(ui.location, '/#/login/done');
  // ES256
  const e = await oidcLogin(OIDC, { sub: 'u-5', name: 'eva', email: 'eva@example.com', groups: ['bx-users'] }, { mode: 'es256' });
  assert.equal(e.location, '/#/login/done');
  // Klockavvikelse inom marginalen (iat 60 s fram)
  assert.equal((await oidcLogin(OIDC, { sub: 'u-5', name: 'eva', groups: ['bx-users'] }, { mode: 'skew' })).location, '/#/login/done');
});

test('OIDC: felaktig signatur, fel nonce/aud/iss, utgånget token, för stor klockavvikelse och osignerat token nekas', async () => {
  const before = D.get('SELECT COUNT(*) AS n FROM sessions').n;
  for (const mode of ['badsig', 'nonce', 'aud', 'iss', 'expired', 'future', 'none', 'hs256']) {
    const r = await oidcLogin(OIDC, { sub: 'x-' + mode, name: 'angripare-' + mode, groups: ['bx-admins'] }, { mode });
    assert.equal(r.location, '/#/login/sso/token', mode);
    assert.equal(r.kt, undefined, mode);
  }
  assert.equal(D.get('SELECT COUNT(*) AS n FROM sessions').n, before);
  assert.equal(D.get("SELECT COUNT(*) AS n FROM users WHERE name LIKE 'angripare-%'").n, 0);
  const why = D.all("SELECT detail FROM audit WHERE event='login_fail' ORDER BY id DESC LIMIT 8").map(r => r.detail).join('\n');
  for (const s of ['Signaturen', 'nonce', 'aud', 'utfärdare', 'gått ut', 'framtiden', 'Algoritmen']) assert.match(why, new RegExp(s));
});

test('OIDC: state är engångs och bundet till webbläsaren (kakan bxsso), leverantörens avbrott och grupper krävs', async () => {
  IDP.mode = 'ok'; IDP.user = { sub: 'u-9', name: 'nisse', groups: ['bx-users'] };
  const ip = lan();
  const s = await req(`/api/sso/oidc/${OIDC}/start`, { token: null, ip });
  const a = await fetch(s.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(a.headers.get('location'));
  // Utan kakan (någon annans webbläsare – inloggnings-CSRF)
  let r = await req(cb.pathname + cb.search, { token: null, ip });
  assert.equal(r.headers.get('location'), '/#/login/sso/state');
  // state är redan förbrukat
  r = await req(cb.pathname + cb.search, { token: null, ip, cookie: cookieOf(s, 'bxsso') });
  assert.equal(r.headers.get('location'), '/#/login/sso/state');
  // Fel kaka
  const r2 = await oidcLogin(OIDC, IDP.user, { cookie: 'bxsso=' + 'a'.repeat(64) }); // en annan kaka än den som startade
  assert.equal(r2.location, '/#/login/sso/state');
  // Leverantören avbryter
  assert.equal((await oidcLogin(OIDC, IDP.user, { mode: 'deny' })).location, '/#/login/sso/denied');
  // Inte med i någon grupp
  assert.equal((await oidcLogin(OIDC, { sub: 'u-10', name: 'okand', groups: ['annat'] })).location, '/#/login/sso/groups');
  // Start från en annan adress: webbläsaren skickas först till den vitlistade adressen
  const other = await req(`/api/sso/oidc/${OIDC}/start`, { token: null, headers: { 'x-forwarded-host': 'tv.example.com' } });
  assert.equal(other.headers.get('location'), `${B}/api/sso/oidc/${OIDC}/start?remember=1`);
});

test('OIDC: ett befintligt konto med samma namn tas inte över – kopplingen kräver kontots lösenord', async () => {
  const pw = 'Pappas-lösen-456';
  const PAPPA = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('pappa',?,0,0)", await auth.hashPw(pw)).lastInsertRowid);
  const r = await oidcLogin(OIDC, { sub: 'u-20', name: 'pappa', email: 'pappa@example.com', groups: ['bx-admins'] });
  const m = /^\/#\/login\/link\/([a-f0-9]{64})$/.exec(r.location);
  assert.ok(m, r.location);
  assert.equal(r.kt, undefined, 'ingen inloggning utan bekräftelse');
  assert.equal(D.get('SELECT COUNT(*) AS n FROM sso_links WHERE user_id=?', PAPPA).n, 0);
  const t = m[1];
  const info = await req('/api/sso/link/' + t, { token: null });
  assert.deepEqual([info.data.account, info.data.provider], ['pappa', 'Authentik']);
  // Från en annan webbplats nekas bekräftelsen (CSRF)
  assert.equal((await req('/api/sso/link/' + t, { method: 'POST', token: null, body: { password: pw }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req('/api/sso/link/' + t, { method: 'POST', token: null, body: { password: 'fel' } })).status, 401);
  const ok = await req('/api/sso/link/' + t, { method: 'POST', token: null, body: { password: pw } });
  assert.equal(ok.status, 200);
  const kt = cookieOf(ok, 'kt');
  assert.equal((await statusWith(kt)).id, PAPPA);
  assert.equal(D.get('SELECT managed FROM sso_links WHERE user_id=?', PAPPA).managed, 0);
  // Biljetten gäller bara en gång
  assert.equal((await req('/api/sso/link/' + t, { method: 'POST', token: null, body: { password: pw } })).status, 404);
  // Kopplat befintligt konto: grupperna ändrar inte rollen (admingruppen gör inte pappa till administratör)
  const again = await oidcLogin(OIDC, { sub: 'u-20', name: 'pappa', groups: ['bx-admins'] });
  assert.equal((await statusWith(again.kt)).id, PAPPA);
  assert.equal(D.get('SELECT is_admin FROM users WHERE id=?', PAPPA).is_admin, 0);
  // Samma e-post från en annan användare hos leverantören: också bekräftelse, aldrig automatiskt
  const mail = await oidcLogin(OIDC, { sub: 'u-21', name: 'pappa2', email: 'pappa@example.com', groups: ['bx-users'] });
  assert.match(mail.location, /^\/#\/login\/link\//);
  // "Det är inte mitt konto": nytt konto med eget namn
  const t2 = mail.location.split('/').pop();
  const created = await req('/api/sso/link/' + t2, { method: 'POST', token: null, body: { create: true } });
  assert.equal(created.status, 200);
  assert.equal((await statusWith(cookieOf(created, 'kt'))).name, 'pappa2');
});

test('OIDC: koppla från Mitt konto och ta bort kopplingen', async () => {
  const pw = 'Mormors-lösen-789';
  const MOR = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('mormor',?,0,0)", await auth.hashPw(pw)).lastInsertRowid);
  const login = await req('/api/login', { method: 'POST', token: null, body: { name: 'mormor', password: pw } });
  const kt = cookieOf(login, 'kt');
  IDP.mode = 'ok'; IDP.user = { sub: 'u-30', name: 'mormor-idp', groups: ['bx-users'] };
  const ip = lan();
  const s = await req(`/api/sso/oidc/${OIDC}/start?link=1`, { token: null, ip, cookie: kt });
  const a = await fetch(s.headers.get('location'), { redirect: 'manual' });
  assert.equal(new URL(s.headers.get('location')).searchParams.get('prompt'), 'login');
  const cb = new URL(a.headers.get('location'));
  const r = await req(cb.pathname + cb.search, { token: null, ip, cookie: `${cookieOf(s, 'bxsso')}; ${kt}` });
  assert.equal(r.headers.get('location'), '/#/account');
  assert.equal(D.get('SELECT user_id FROM sso_links WHERE subject=?', 'u-30').user_id, MOR);
  const mine = await req('/api/me/sso', { token: null, cookie: kt });
  assert.equal(mine.data.providers.find(p => p.id === OIDC).linked, true);
  assert.equal((await req('/api/me/sso/' + OIDC, { method: 'DELETE', token: null, cookie: kt, headers: { origin: B } })).status, 200);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM sso_links WHERE user_id=?', MOR).n, 0);
  // Ett konto som leverantören skapat kan inte koppla bort sin enda inloggning
  const kalle = await oidcLogin(OIDC, { sub: 'u-1', name: 'kalle', groups: ['bx-users'] });
  assert.equal((await req('/api/me/sso/' + OIDC, { method: 'DELETE', token: null, cookie: kalle.kt, headers: { origin: B } })).status, 400);
});

// ---------------- simulerad LDAP-server ----------------
// Egen BER-avkodning (oberoende av klientens) och en liten katalog. Filter utvärderas mot posterna.
function tlvAt(b, o) {
  const tag = b[o]; let len = b[o + 1], p = o + 2;
  if (len & 0x80) { const k = len & 0x7f; len = 0; for (let i = 0; i < k; i++) len = len * 256 + b[p++]; }
  return { tag, v: b.subarray(p, p + len), next: p + len, end: p + len <= b.length };
}
const kids = (v) => { const out = []; for (let o = 0; o < v.length;) { const t = tlvAt(v, o); out.push(t); o = t.next; } return out; };
const enc = (tag, ...parts) => { const v = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(String(p)))); const l = v.length < 128 ? [v.length] : v.length < 256 ? [0x81, v.length] : [0x82, v.length >> 8, v.length & 255]; return Buffer.concat([Buffer.from([tag, ...l]), v]); };
const int = (n, tag = 2) => enc(tag, Buffer.from([n]));
const os_ = (s) => enc(4, s);
const result = (id, tag, code) => enc(0x30, int(id), enc(tag, int(code, 0x0a), os_(''), os_('')));
const DIR = [
  { dn: 'uid=anna,ou=people,dc=ex', a: { objectclass: ['person'], uid: ['anna'], mail: ['anna@ex.se'], displayname: ['Anna A'], entryuuid: ['11111111-aaaa'], memberof: ['cn=tv-admins,ou=groups,dc=ex'] }, pw: 'Annas-lösen-1' },
  { dn: 'uid=bertil,ou=people,dc=ex', a: { objectclass: ['person'], uid: ['bertil'], mail: ['bertil@ex.se'], entryuuid: ['22222222-bbbb'] }, pw: 'Bertils-lösen-2' },
  { dn: 'cn=Cilla (IT)\\2C Ek,ou=people,dc=ex', a: { objectclass: ['person'], uid: ['cilla'], entryuuid: ['33333333-cccc'] }, pw: 'Cillas-lösen-3' },
  { dn: 'uid=pappa,ou=people,dc=ex', a: { objectclass: ['person'], uid: ['pappa'], entryuuid: ['44444444-dddd'] }, pw: 'LDAP-pappa-4' },
  { dn: 'uid=utan,ou=people,dc=ex', a: { objectclass: ['person'], uid: ['utan'], entryuuid: ['55555555-eeee'] }, pw: 'Utan-grupp-5' },
  { dn: 'cn=tv-users,ou=groups,dc=ex', a: { objectclass: ['groupofnames'], cn: ['tv-users'], member: ['uid=bertil,ou=people,dc=ex', 'cn=Cilla (IT)\\2C Ek,ou=people,dc=ex', 'uid=pappa,ou=people,dc=ex'] } },
  { dn: 'cn=tv-admins,ou=groups,dc=ex', a: { objectclass: ['groupofnames'], cn: ['tv-admins'], member: ['uid=anna,ou=people,dc=ex'] } }
];
const SERVICE = { dn: 'cn=svc,dc=ex', pw: BIND_PW };
const LDAP = { binds: [], filters: [], tls: null };
/** Filtret som träd (för kontrollen av injektion) och utvärdering mot en post */
function decodeFilter(t) {
  const tag = t.tag, c = () => kids(t.v);
  if (tag === 0xa0) return { and: c().map(decodeFilter) };
  if (tag === 0xa1) return { or: c().map(decodeFilter) };
  if (tag === 0xa2) return { not: decodeFilter(c()[0]) };
  if (tag === 0x87) return { present: t.v.toString() };
  if (tag === 0xa3) { const [a, v] = c(); return { eq: [a.v.toString().toLowerCase(), v.v.toString()] }; }
  if (tag === 0xa4) { const [a, s] = c(); return { sub: [a.v.toString().toLowerCase(), kids(s.v).map(x => [x.tag, x.v.toString()])] }; }
  return { other: tag };
}
function match(f, e) {
  const vals = (a) => (e.a[a] || []).map(String);
  if (f.and) return f.and.every(x => match(x, e));
  if (f.or) return f.or.some(x => match(x, e));
  if (f.not) return !match(f.not, e);
  if (f.present) return vals(f.present.toLowerCase()).length > 0;
  if (f.eq) return vals(f.eq[0]).some(v => v.toLowerCase() === f.eq[1].toLowerCase());
  if (f.sub) return vals(f.sub[0]).some(v => { const re = f.sub[1].map(([tg, s]) => (tg === 0x80 ? '^' : '') + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (tg === 0x82 ? '$' : '')).join('.*'); return new RegExp(re, 'i').test(v); });
  return false;
}
let CERT = null;
if (spawnSync('openssl', ['version']).status === 0) {
  const k = path.join(ROOT, 'k.pem'), c = path.join(ROOT, 'c.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', k, '-out', c, '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost']);
  if (r.status === 0) CERT = { key: fs.readFileSync(k, 'utf8'), cert: fs.readFileSync(c, 'utf8') };
}
function ldapHandler(sock0) {
  let sock = sock0, buf = Buffer.alloc(0), bound = null;
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const m = tlvAt(buf, 0);
      if (!m.end) break;
      buf = buf.subarray(m.next);
      const [idT, op] = kids(m.v);
      const id = idT.v[idT.v.length - 1];
      if (op.tag === 0x60) { // bind
        const [, dnT, pwT] = kids(op.v);
        const dn = dnT.v.toString(), pw = pwT.v.toString();
        LDAP.binds.push({ dn, pw: pw ? '***' : '' });
        const e = DIR.find(x => x.dn === dn);
        const ok = (dn === SERVICE.dn && pw === SERVICE.pw) || (e && e.pw && pw === e.pw) || (!pw && LDAP.allowUnauth);
        bound = ok ? dn : null;
        sock.write(result(id, 0x61, ok ? 0 : 49));
      } else if (op.tag === 0x63) { // sökning
        const [baseT, , , , , , filterT, attrsT] = kids(op.v);
        const f = decodeFilter(filterT);
        LDAP.filters.push(f);
        const want = kids(attrsT.v).map(x => x.v.toString().toLowerCase());
        if (!bound) { sock.write(result(id, 0x65, 50)); continue; }
        for (const e of DIR.filter(x => x.dn.endsWith(baseT.v.toString()) && match(f, x))) {
          const attrs = Object.entries(e.a).filter(([k]) => want.includes(k)).map(([k, v]) => enc(0x30, os_(k), enc(0x31, ...v.map(os_))));
          sock.write(enc(0x30, int(id), enc(0x64, os_(e.dn), enc(0x30, ...attrs))));
        }
        sock.write(result(id, 0x65, 0));
      } else if (op.tag === 0x77) { // StartTLS
        if (!CERT) { sock.write(result(id, 0x78, 2)); continue; }
        sock.write(result(id, 0x78, 0));
        sock.removeListener('data', onData);
        const t = new tls.TLSSocket(sock, { isServer: true, key: CERT.key, cert: CERT.cert });
        t.on('secure', () => { LDAP.tls = 'starttls'; });
        t.on('error', () => {});
        t.on('data', onData); sock = t;
      } else if (op.tag === 0x42) { sock.end(); }
    }
  };
  sock.on('data', onData); sock.on('error', () => {});
}
const ldapSrv = net.createServer(ldapHandler);
await new Promise(r => ldapSrv.listen(0, '127.0.0.1', r));
const ldapsSrv = CERT ? tls.createServer({ key: CERT.key, cert: CERT.cert }, (s) => { LDAP.tls = 'ldaps'; ldapHandler(s); }) : null;
if (ldapsSrv) await new Promise(r => ldapsSrv.listen(0, '127.0.0.1', r));
// En server som tar emot anslutningen men aldrig svarar (tidsgränsen)
const hang = net.createServer((s) => { s.on('error', () => {}); });
await new Promise(r => hang.listen(0, '127.0.0.1', r));
const LDAP_URL = `ldap://127.0.0.1:${ldapSrv.address().port}`;
const LDAP_BASE = { kind: 'ldap', name: 'Katalogen', url: LDAP_URL, bindDn: SERVICE.dn, bindPassword: BIND_PW, baseDn: 'ou=people,dc=ex', userFilter: '(&(objectClass=person)(uid={user}))',
  groupBaseDn: 'ou=groups,dc=ex', groupFilter: '(&(objectClass=groupOfNames)(member={dn}))', autoCreate: true, groups: { admin: ['tv-admins'], user: ['tv-users'] }, timeout: 2 };

const ldapLogin = (name, password, ip = lan()) => req('/api/login', { method: 'POST', token: null, ip, body: { name, password, app: true } });

let LDAPID;
test('LDAP: filtret escapas enligt RFC 4515 och tolkas till BER', () => {
  assert.equal(ldapc.escapeFilter('*)(uid=*))(|(uid=*'), '\\2a\\29\\28uid=\\2a\\29\\29\\28|\\28uid=\\2a');
  assert.equal(ldapc.escapeFilter('a\\b\u0000'), 'a\\5cb\\00');
  const f = ldapc.parseFilter(ldapc.fillFilter('(&(objectClass=person)(uid={user}))', { user: '*)(uid=*' }));
  const t = decodeFilter(tlvAt(f, 0));
  assert.deepEqual(t, { and: [{ eq: ['objectclass', 'person'] }, { eq: ['uid', '*)(uid=*'] }] });
  assert.deepEqual(decodeFilter(tlvAt(ldapc.parseFilter('(cn=ab*c*d)'), 0)), { sub: ['cn', [[0x80, 'ab'], [0x81, 'c'], [0x82, 'd']]] });
  assert.deepEqual(decodeFilter(tlvAt(ldapc.parseFilter('(!(mail=*))'), 0)), { not: { present: 'mail' } });
  for (const bad of ['(uid=a)(uid=b)', 'uid=a', '(uid=a', '(uid=(a))', '(uid:dn:=a)', '(&)', '(uid=\\zz)']) assert.throws(() => ldapc.parseFilter(bad), /Ogiltigt LDAP-filter/, bad);
});

test('LDAP: inloggning med bind + sökning, grupper → roll, hemligheten lämnas inte ut', async () => {
  const r = await req('/api/sso/providers', { method: 'POST', body: LDAP_BASE });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  LDAPID = r.data.provider.id;
  assert.ok(!JSON.stringify((await req('/api/sso')).data).includes(BIND_PW));
  const t = await req(`/api/sso/providers/${LDAPID}/test`, { method: 'POST', body: { username: 'anna' } });
  assert.equal(t.data.ok, true, JSON.stringify(t.data));
  assert.equal(t.data.user.role, 'admin');
  // Administratören
  let l = await ldapLogin('anna', 'Annas-lösen-1');
  assert.equal(l.status, 200, JSON.stringify(l.data));
  assert.equal(l.data.user.is_admin, 1);
  assert.equal(l.data.user.name, 'anna');
  assert.ok(LDAP.binds.some(b => b.dn === 'uid=anna,ou=people,dc=ex'));
  // Vanlig användare via gruppfiltret – DN med specialtecken escapas i {dn}
  l = await ldapLogin('cilla', 'Cillas-lösen-3');
  assert.equal(l.status, 200, JSON.stringify(l.data));
  assert.equal(l.data.user.is_admin, 0);
  assert.ok(LDAP.filters.some(f => JSON.stringify(f).includes('cn=Cilla (IT)\\\\2C Ek')), 'DN:en skickas som ett likhetsvärde');
  // Inte med i någon grupp
  l = await ldapLogin('utan', 'Utan-grupp-5');
  assert.equal(l.status, 403);
  // Fel lösenord och tomt lösenord (aldrig "unauthenticated bind")
  assert.equal((await ldapLogin('bertil', 'fel')).status, 401);
  LDAP.allowUnauth = true;
  const n0 = LDAP.binds.length;
  assert.equal((await ldapLogin('bertil', '')).status, 401);
  assert.ok(!LDAP.binds.slice(n0).some(b => b.dn.startsWith('uid=bertil') && b.pw === ''), 'tomt lösenord skickas aldrig');
  LDAP.allowUnauth = false;
  // Hemligheterna finns varken i revisionsloggen eller i serverns logg
  const audit = JSON.stringify(D.all('SELECT * FROM audit'));
  for (const s of [BIND_PW, CLIENT_SECRET, 'Annas-lösen-1']) { assert.ok(!audit.includes(s)); assert.ok(!logged.join('\n').includes(s)); }
});

test('LDAP: injektionsförsök i användarnamnet blir vanliga likhetsvärden', async () => {
  for (const evil of ['*', 'a*', '*)(uid=*', '*)(|(uid=*', 'anna)(|(objectClass=*', 'anna\\', 'anna)(uid=bertil']) {
    LDAP.filters.length = 0;
    const r = await ldapLogin(evil, 'Annas-lösen-1');
    assert.equal(r.status, 401, evil);
    const f = LDAP.filters.find(x => x.and);
    assert.ok(f, evil);
    assert.deepEqual(f.and[1], { eq: ['uid', evil] }, `filtret ändrade form för ${evil}`);
    assert.ok(!JSON.stringify(f).includes('"sub"') && !JSON.stringify(f).includes('"or"') && !JSON.stringify(f).includes('"present"'));
  }
});

test('LDAP: lokalt konto med samma namn tas inte över – koppling kräver det lokala lösenordet', async () => {
  // pappa finns lokalt (från OIDC-testet) och i katalogen
  const l = await ldapLogin('pappa', 'LDAP-pappa-4');
  assert.equal(l.status, 409);
  assert.equal(l.data.needLink, true);
  assert.equal(l.data.account, 'pappa');
  // Det lokala lösenordet fungerar som förut
  assert.equal((await ldapLogin('pappa', 'Pappas-lösen-456')).status, 200);
  const ok = await req('/api/sso/link/' + l.data.ticket, { method: 'POST', token: null, body: { password: 'Pappas-lösen-456' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // Nu loggar LDAP-lösenordet in på det lokala kontot
  const again = await ldapLogin('pappa', 'LDAP-pappa-4');
  assert.equal(again.status, 200);
  assert.equal(again.data.user.id, D.get("SELECT id FROM users WHERE name='pappa'").id);
});

test('LDAP: tidsgräns när servern inte svarar, och StartTLS/LDAPS med certifikatkontroll', async () => {
  const p = (await req('/api/sso/providers', { method: 'POST', body: { ...LDAP_BASE, name: 'Hänger', url: `ldap://127.0.0.1:${hang.address().port}`, timeout: 1 } })).data.provider.id;
  await req(`/api/sso/providers/${LDAPID}`, { method: 'PUT', body: { enabled: false } });
  const t0 = Date.now();
  const r = await ldapLogin('okand-person', 'Något-lösen-1');
  assert.equal(r.status, 503);
  assert.ok(Date.now() - t0 < 5000, 'svarar inom tidsgränsen');
  await req(`/api/sso/providers/${p}`, { method: 'DELETE' });
  await req(`/api/sso/providers/${LDAPID}`, { method: 'PUT', body: { enabled: true } });
  if (!CERT) return; // openssl saknas
  const st = await req(`/api/sso/providers/${LDAPID}`, { method: 'PUT', body: { startTls: true, ca: CERT.cert } });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  LDAP.tls = null;
  assert.equal((await ldapLogin('bertil', 'Bertils-lösen-2')).status, 200);
  assert.equal(LDAP.tls, 'starttls');
  // Utan rätt CA godtas inte certifikatet (kontrollen är på som standard)
  await req(`/api/sso/providers/${LDAPID}`, { method: 'PUT', body: { ca: '' } });
  const bad = await req(`/api/sso/providers/${LDAPID}/test`, { method: 'POST', body: {} });
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.error, /certifikat/);
  // LDAPS
  await req(`/api/sso/providers/${LDAPID}`, { method: 'PUT', body: { url: `ldaps://127.0.0.1:${ldapsSrv.address().port}`, startTls: false, ca: CERT.cert } });
  LDAP.tls = null;
  assert.equal((await ldapLogin('bertil', 'Bertils-lösen-2')).status, 200);
  assert.equal(LDAP.tls, 'ldaps');
  await req(`/api/sso/providers/${LDAPID}`, { method: 'PUT', body: { url: LDAP_URL, ca: '' } });
});

test('reservinloggning: med lösenord bara för administratörer nekas andra lokala konton, administratören kommer alltid in', async () => {
  const pw = 'Vanlig-lösen-321';
  D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('vanlig',?,0,0)", await auth.hashPw(pw));
  assert.equal((await req('/api/sso/settings', { method: 'PUT', body: { localLogin: 'admin' } })).status, 200);
  const r = await req('/api/login', { method: 'POST', token: null, ip: lan(), body: { name: 'vanlig', password: pw } });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /enkel inloggning/);
  assert.equal((await req('/api/login', { method: 'POST', token: null, ip: lan(), body: { name: 'admin', password: 'Admin-lösen-123' } })).status, 200);
  // LDAP-användare loggar fortfarande in med katalogens lösenord
  assert.equal((await ldapLogin('bertil', 'Bertils-lösen-2')).status, 200);
  const pubList = await req('/api/sso/providers', { token: null });
  assert.equal(pubList.data.localLogin, 'admin');
  await req('/api/sso/settings', { method: 'PUT', body: { localLogin: 'all' } });
  assert.equal((await req('/api/login', { method: 'POST', token: null, ip: lan(), body: { name: 'vanlig', password: pw } })).status, 200);
});

test('fjärråtkomst: konto utan fjärråtkomst nekas utifrån, 2FA-kravet gäller om inte leverantören sköter det', async () => {
  D.setSetting('require_2fa_remote', '1');
  try {
    const r = await oidcLogin(OIDC, { sub: 'u-1', name: 'kalle', groups: ['bx-users'] }, { ip: '203.0.113.50' });
    assert.equal(r.location, '/#/login/sso/2fa');
    await req(`/api/sso/providers/${OIDC}`, { method: 'PUT', body: { trustMfa: true } });
    const ok = await oidcLogin(OIDC, { sub: 'u-1', name: 'kalle', groups: ['bx-users'] }, { ip: '203.0.113.51' });
    assert.equal(ok.location, '/#/login/done');
    assert.equal((await req('/api/status', { token: null, cookie: ok.kt, ip: '203.0.113.51' })).status, 200);
    await req(`/api/sso/providers/${OIDC}`, { method: 'PUT', body: { trustMfa: false } });
  } finally { D.setSetting('require_2fa_remote', '0'); }
  D.run("UPDATE users SET remote_allowed=0 WHERE name='kalle'");
  assert.equal((await oidcLogin(OIDC, { sub: 'u-1', name: 'kalle', groups: ['bx-users'] }, { ip: '203.0.113.52' })).location, '/#/login/sso/remote');
});
