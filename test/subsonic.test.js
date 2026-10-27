// Musikappar via Subsonic/OpenSubsonic (/rest/*) mot en riktig server och ett litet musikbibliotek gjort med ffmpeg:
// app-lösenordet (skapa, md5+salt, p=, enc:, apiKey, återkalla), hastighetsgränsen, fjärrreglerna (fjärråtkomst, 2FA),
// barnprofiler och skärmtid, att /rest bara når musik och att vanliga token inte fungerar där (och tvärtom),
// samt varje endpoint i både XML och JSON.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-subsonic-'));
const MEDIA = path.join(ROOT, 'media');
Object.assign(process.env, { CONFIG_DIR: path.join(ROOT, 'config'), TRANSCODE_DIR: path.join(ROOT, 'tc'), MEDIA_ROOT: MEDIA, WATCH_FILES: '0',
  MUSIC_LOUDNESS: '0', SCROBBLE_INTERVAL: '0', CALENDAR_REFRESH: '0', DVR_DIR: path.join(ROOT, 'rec'), PODCAST_DIR: path.join(ROOT, 'pod') });
fs.mkdirSync(MEDIA, { recursive: true });
const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const S = await import('../server/subsonic.js');
const music = await import('../server/music.js');
const screen = await import('../server/screentime.js');
const app = await import('../server/app.js');
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const PW = 'Hemligt-lösen-123';
const hash = await auth.hashPw(PW);
const ANNA = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('anna',?,1,0)", hash).lastInsertRowid);
const BO = Number(D.run("INSERT INTO users(name,pass,is_admin,created,remote_allowed) VALUES('bo',?,0,0,0)", hash).lastInsertRowid);
const KID = Number(D.run("INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES('lisa','x',0,0,?,7)", ANNA).lastInsertRowid);
const LIMITED = Number(D.run("INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES('olle','x',0,0,?,11)", ANNA).lastInsertRowid);
const tok = Object.fromEntries([ANNA, BO, KID, LIMITED].map(id => [id, auth.createSession(id, 'app')]));

// ---------- musikbibliotek ----------
const LIBDIR = path.join(MEDIA, 'Musik');
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
let LIB = 0, IDS = {};
if (hasFfmpeg) {
  const abba = path.join(LIBDIR, 'ABBA', 'Arrival'), robyn = path.join(LIBDIR, 'Robyn', 'Body Talk');
  fs.mkdirSync(abba, { recursive: true }); fs.mkdirSync(robyn, { recursive: true });
  const meta = (o) => Object.entries(o).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=31', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k',
    ...meta({ title: 'Dancing Queen', artist: 'ABBA', album: 'Arrival', track: '1', date: '1976', genre: 'Pop' }), path.join(abba, '01 - Dancing Queen.mp3'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=550:duration=31', '-ac', '1', '-ar', '8000',
    ...meta({ title: 'Knowing Me, Knowing You', artist: 'ABBA', album: 'Arrival', track: '2', date: '1976', genre: 'Pop' }), path.join(abba, '02 - Knowing Me.flac'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=660:duration=31', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k',
    ...meta({ title: 'Dancing On My Own <&>', artist: 'Robyn', album: 'Body Talk', track: '1', date: '2010', genre: 'Electro' }), path.join(robyn, '01 - Dancing On My Own.mp3'));
  fs.writeFileSync(path.join(robyn, '01 - Dancing On My Own.lrc'), '[00:01.00]Somebody said\n[00:03.50]you got a new friend\n');
  ff('-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', path.join(abba, 'cover.jpg'));
  LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Musik','music',?)", LIBDIR).lastInsertRowid);
  await music.scanMusic(D.get('SELECT * FROM libraries WHERE id=?', LIB), {});
  const tr = (title) => D.get('SELECT id FROM tracks WHERE title=?', title).id;
  IDS = { dq: tr('Dancing Queen'), km: tr('Knowing Me, Knowing You'), rob: tr('Dancing On My Own <&>'),
    arrival: D.get("SELECT id FROM albums WHERE title='Arrival'").id, bodytalk: D.get("SELECT id FROM albums WHERE title='Body Talk'").id,
    abba: D.get("SELECT id FROM artists WHERE name='ABBA'").id, robyn: D.get("SELECT id FROM artists WHERE name='Robyn'").id };
}

// ---------- hjälpare ----------
async function api(uid, p, { method = 'GET', body, xff } = {}) {
  const h = { Authorization: `Bearer ${tok[uid]}` };
  if (body) h['Content-Type'] = 'application/json';
  if (xff) h['X-Forwarded-For'] = xff;
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}
const creds = {}; // användar-id → app-lösenord
async function makePassword(uid, opts = {}) {
  const r = await api(uid, '/api/me/subsonic', { method: 'POST', body: { password: PW, ...opts.body }, xff: opts.xff });
  if (r.status === 200) creds[uid] = r.data.password;
  return r;
}
const nameOf = (uid) => D.get('SELECT name FROM users WHERE id=?', uid).name;
/** Anrop till /rest/<metod>. auth: 'token' (md5+salt, standard), 'plain', 'enc', 'apikey' eller egna parametrar */
async function rest(method, params = {}, { uid = ANNA, as = 'token', f, post = false, headers = {}, xff, raw = false } = {}) {
  const q = new URLSearchParams();
  const pw = creds[uid];
  if (as === 'token') { const s = crypto.randomBytes(6).toString('hex'); q.set('u', nameOf(uid)); q.set('t', md5(pw + s)); q.set('s', s); }
  else if (as === 'plain') { q.set('u', nameOf(uid)); q.set('p', pw); }
  else if (as === 'enc') { q.set('u', nameOf(uid)); q.set('p', 'enc:' + Buffer.from(pw).toString('hex')); }
  else if (as === 'apikey') q.set('apiKey', pw);
  q.set('v', '1.16.1'); q.set('c', 'testklient');
  if (f) q.set('f', f);
  for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) q.append(k, String(x));
  const h = { ...headers, ...(xff ? { 'X-Forwarded-For': xff } : {}) };
  const r = post ? await fetch(`${B}/rest/${method}`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' }, body: q.toString() })
    : await fetch(`${B}/rest/${method}?${q}`, { headers: h });
  if (raw) return r;
  const text = await r.text(), ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) { const j = JSON.parse(text)['subsonic-response']; return { http: r.status, ct, ok: j.status === 'ok', code: j.error?.code, body: j, text }; }
  return { http: r.status, ct, ok: /status="ok"/.test(text), code: +(/<error code="(\d+)"/.exec(text)?.[1] ?? NaN), text };
}
const json = (m, p, o = {}) => rest(m, p, { ...o, f: 'json' });

/** Minimal kontroll av välformad XML: balanserade element, citerade attribut, inga råa & eller < i text */
function wellFormed(x) {
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<subsonic-response xmlns="http:\/\/subsonic.org\/restapi" /);
  const body = x.replace(/^<\?xml[^>]*\?>\n/, '');
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.:-]*="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let m, end = 0;
  while ((m = re.exec(body))) {
    end = re.lastIndex;
    if (m[6]) assert.fail('lös < i XML vid ' + m.index);
    if (m[5] != null) { assert.doesNotMatch(m[5], /&(?!(amp|lt|gt|quot|apos);)/, 'oescapat & i text'); continue; }
    for (const a of m[3].matchAll(/="([^"]*)"/g)) assert.doesNotMatch(a[1], /&(?!(amp|lt|gt|quot|apos);)/, 'oescapat & i attribut');
    if (m[1]) assert.equal(stack.pop(), m[2], 'obalanserat element ' + m[2]);
    else if (!m[4]) stack.push(m[2]);
  }
  assert.equal(end, body.length);
  assert.deepEqual(stack, []);
}

// ---------- svarsformatet ----------
test('render: XML-escaping, ogiltiga tecken, listor och textinnehåll; JSON utan null', () => {
  const r = S.render({ song: [{ id: 'tr-1', title: 'A & B <"\'>\u0001\uD800', starred: null }, { id: 'tr-2' }], lyrics: { artist: 'x', value: 'rad 1\nrad <2>' } }, 'xml');
  assert.equal(r.type, 'text/xml; charset=utf-8');
  wellFormed(r.body);
  assert.match(r.body, /<song id="tr-1" title="A &amp; B &lt;&quot;&apos;&gt;"\/><song id="tr-2"\/>/);
  assert.match(r.body, /<lyrics artist="x">rad 1\nrad &lt;2&gt;<\/lyrics>/);
  assert.match(r.body, /status="ok" version="1.16.1" type="braxhn-tv" serverVersion="[^"]+" openSubsonic="true"/);
  const j = JSON.parse(S.render({ song: [{ id: 'tr-1', starred: null }] }, 'json').body)['subsonic-response'];
  assert.equal(j.status, 'ok'); assert.equal(j.openSubsonic, true);
  assert.deepEqual(j.song, [{ id: 'tr-1' }]);
  const e = S.render(null, 'xml', { code: 40, message: 'Fel' });
  assert.match(e.body, /status="failed"[^>]*><error code="40" message="Fel"\/><\/subsonic-response>/);
});

// ---------- app-lösenordet ----------
t('app-lösenord: skapas under Mitt konto, visas en gång, lagras krypterat', async () => {
  const before = await api(ANNA, '/api/me/subsonic');
  assert.equal(before.data.active, false);
  assert.equal(before.data.enabled, true);
  const bad = await api(ANNA, '/api/me/subsonic', { method: 'POST', body: { password: 'fel' } });
  assert.equal(bad.status, 400);
  const r = await makePassword(ANNA);
  assert.equal(r.status, 200);
  assert.match(r.data.password, /^[a-z2-9]{6}(-[a-z2-9]{6}){3}$/);
  assert.equal(r.data.username, 'anna');
  const info = await api(ANNA, '/api/me/subsonic');
  assert.equal(info.data.active, true);
  assert.equal(info.data.password, undefined, 'lösenordet visas bara när det skapas');
  const row = D.get('SELECT * FROM subsonic_passwords WHERE user_id=?', ANNA);
  assert.ok(!JSON.stringify(row).includes(r.data.password), 'klartexten finns inte i databasen');
  assert.ok(row.enc.startsWith('v1:'));
  const key = fs.statSync(path.join(process.env.CONFIG_DIR, 'subsonic.key'));
  assert.equal(key.size, 32);
  assert.equal(key.mode & 0o077, 0, 'nyckelfilen läses bara av ägaren');
  // En rad som flyttas till ett annat konto går inte att dekryptera (md5-inloggningen misslyckas)
  assert.equal((await rest('ping')).ok, true);
});

t('inloggning: md5+salt, p= i klartext och enc:hex, apiKey, POST-formulär och fel', async () => {
  for (const as of ['token', 'plain', 'enc', 'apikey']) {
    const r = await rest('ping', {}, { as });
    assert.equal(r.ok, true, as);
    assert.equal((await json('ping', {}, { as })).ok, true, as + ' json');
  }
  assert.equal((await rest('ping', {}, { post: true })).ok, true, 'formPost');
  S.resetLimits();
  const s = 'saltsalt';
  const wrong = await rest('ping', { u: 'anna', t: md5('fel' + s), s }, { as: 'none' });
  assert.equal(wrong.code, 40);
  assert.equal((await rest('ping', { u: 'anna', p: 'fel' }, { as: 'none' })).code, 40);
  assert.equal((await rest('ping', { u: 'ingen', p: creds[ANNA] }, { as: 'none' })).code, 40, 'okänd användare');
  assert.equal((await rest('ping', { apiKey: 'fel' }, { as: 'none' })).code, 44);
  assert.equal((await rest('ping', { u: 'anna' }, { as: 'apikey' })).code, 43, 'apiKey + u är motstridiga');
  assert.equal((await rest('ping', { p: 'x' }, { as: 'token' })).code, 43, 't/s + p är motstridiga');
  assert.equal((await rest('ping', {}, { as: 'none' })).code, 10);
  assert.equal((await json('ping', { u: 'anna', t: 'abc' }, { as: 'none' })).code, 10, 'salt saknas');
  // Kontots vanliga lösenord gäller inte
  assert.equal((await rest('ping', { u: 'anna', p: PW }, { as: 'none' })).code, 40);
  S.resetLimits();
});

t('vanliga token gäller inte på /rest och app-lösenordet gäller inte på /api', async () => {
  const bearer = await fetch(`${B}/rest/ping?f=json`, { headers: { Authorization: `Bearer ${tok[ANNA]}` } });
  assert.equal(JSON.parse(await bearer.text())['subsonic-response'].error.code, 10);
  const cookie = await fetch(`${B}/rest/ping?f=json`, { headers: { Cookie: `kt=${tok[ANNA]}` } });
  assert.equal(JSON.parse(await cookie.text())['subsonic-response'].status, 'failed');
  const media = auth.createSession(ANNA, 'media', { item: -IDS.dq });
  const mt = await (await fetch(`${B}/rest/stream?f=json&id=tr-${IDS.dq}&t=${media}`)).json();
  assert.equal(mt['subsonic-response'].status, 'failed', 'mediatoken (?t=) gäller inte');
  // App-lösenordet som Bearer, kaka, ?t= eller apiKey mot /api
  for (const h of [{ Authorization: `Bearer ${creds[ANNA]}` }, { Cookie: `kt=${creds[ANNA]}` }]) assert.equal((await fetch(`${B}/api/libraries`, { headers: h })).status, 401);
  assert.equal((await fetch(`${B}/api/music/tracks/${IDS.dq}/stream?t=${encodeURIComponent(creds[ANNA])}`)).status, 401);
  const q = new URLSearchParams({ u: 'anna', p: creds[ANNA], apiKey: creds[ANNA] });
  assert.equal((await fetch(`${B}/api/libraries?${q}`)).status, 401);
  // /rest når bara musikappens metoder – inte /api-routes under en annan väg
  for (const p of ['/rest/../api/libraries', '/rest/api/libraries', '/rest/getVideos', '/rest/getPodcasts.view']) {
    const r = await fetch(`${B}${p}?u=anna&p=${encodeURIComponent(creds[ANNA])}&f=json`);
    const j = await r.json().catch(() => ({}));
    assert.ok(!Array.isArray(j), p);
    assert.equal(j['subsonic-response']?.status ?? 'failed', 'failed', p);
  }
  // CORS för webbklienter (Feishin i webbläsaren) – utan kakor
  const o = await fetch(`${B}/rest/ping.view`, { method: 'OPTIONS' });
  assert.equal(o.status, 204);
  assert.equal(o.headers.get('access-control-allow-origin'), '*');
  assert.equal(o.headers.get('access-control-allow-credentials'), null);
});

t('hastighetsgräns: tio fel per IP spärrar, och användarnamnet spärras utifrån men inte hemma', async () => {
  S.resetLimits();
  for (let i = 0; i < 10; i++) await rest('ping', { u: 'nisse' + i, p: 'fel' }, { as: 'none', xff: '198.51.100.7' });
  const blocked = await rest('ping', {}, { xff: '198.51.100.7' });
  assert.equal(blocked.http, 429, 'rätt lösenord nekas också från spärrad IP');
  assert.equal((await rest('ping', {}, { xff: '198.51.100.8' })).ok, true, 'annan IP påverkas inte');
  // Spärren gäller inte webbinloggningen
  assert.equal(auth.ipBlocked('198.51.100.7'), false);
  // Användarnamnet: tio fel utifrån från olika adresser → spärrat utifrån, men hemma fungerar det
  S.resetLimits();
  for (let i = 0; i < 10; i++) await rest('ping', { u: 'anna', p: 'fel' }, { as: 'none', xff: `203.0.113.${i + 1}` });
  assert.equal((await rest('ping', {}, { xff: '203.0.113.99' })).code, 40, 'spärrat utifrån');
  assert.equal((await rest('ping')).ok, true, 'hemma fungerar det');
  // Fel hemifrån spärrar inte kontot
  S.resetLimits();
  for (let i = 0; i < 12; i++) await rest('ping', { u: 'anna', p: 'fel' }, { as: 'none', xff: i < 6 ? '192.168.1.50' : '192.168.1.51' });
  assert.equal((await rest('ping', {}, { xff: '203.0.113.99' })).ok, true);
  S.resetLimits();
  assert.ok(D.get("SELECT COUNT(*) AS n FROM audit WHERE event='subsonic_login_fail'").n > 0);
});

t('fjärrregler: konto utan fjärråtkomst, krav på 2FA utifrån och att skapa lösenordet utifrån', async () => {
  // bo får bara användas hemma
  assert.equal((await makePassword(BO)).status, 200);
  assert.equal((await rest('ping', {}, { uid: BO })).ok, true);
  const out = await rest('ping', {}, { uid: BO, xff: '203.0.113.5' });
  assert.equal(out.code, 50);
  // 2FA krävs utifrån: anna har ingen 2FA → nekas utifrån, fungerar hemma
  D.setSetting('require_2fa_remote', '1');
  try {
    assert.equal((await rest('ping', {}, { xff: '203.0.113.5' })).code, 50);
    assert.equal((await rest('ping')).ok, true);
    D.run('UPDATE users SET totp_enabled=1, totp_secret=? WHERE id=?', auth.newTotpSecret(), ANNA);
    assert.equal((await rest('ping', {}, { xff: '203.0.113.5' })).ok, true, 'med 2FA på kontot');
    // Profiler ärver huvudkontots 2FA
    assert.equal((await makePassword(KID)).status, 200);
    assert.equal((await rest('ping', {}, { uid: KID, xff: '203.0.113.5' })).ok, true);
  } finally { D.setSetting('require_2fa_remote', '0'); }
  // Skapa lösenordet utifrån: kräver kod från autentiseringsappen
  const noCode = await makePassword(ANNA, { xff: '203.0.113.5' });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.data.need2fa, true);
  const secret = D.get('SELECT totp_secret FROM users WHERE id=?', ANNA).totp_secret;
  const code = auth.hotp(secret, Math.floor(Date.now() / 30000));
  const okRemote = await makePassword(ANNA, { xff: '203.0.113.5', body: { code } });
  assert.equal(okRemote.status, 200);
  assert.equal((await api(ANNA, '/api/me/subsonic')).data.createdAtHome, false);
  D.run('UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_last=0 WHERE id=?', ANNA);
  // Utan 2FA kan det inte skapas utifrån alls
  const no2fa = await makePassword(ANNA, { xff: '203.0.113.5' });
  assert.equal(no2fa.status, 403);
  assert.equal((await makePassword(ANNA)).status, 200, 'hemifrån går det');
});

t('barnprofiler: musik utan åldersgräns, men profiler med skärmtid för ljud nekas', async () => {
  assert.equal((await rest('ping', {}, { uid: KID })).ok, true);
  const al = await json('getAlbum', { id: `al-${IDS.arrival}` }, { uid: KID });
  assert.equal(al.ok, true);
  assert.equal((await json('getUser', {}, { uid: KID })).body.user.scrobblingEnabled, false);
  assert.equal((await makePassword(LIMITED)).status, 200);
  screen.setRules(LIMITED, { daily: 60, audio: true });
  const r = await json('ping', {}, { uid: LIMITED });
  assert.equal(r.code, 50);
  assert.match(r.body.error.message, /skärmtid/);
  assert.equal((await api(LIMITED, '/api/me/subsonic')).data.screenTimeAudio, true);
  screen.setRules(LIMITED, { daily: 60, audio: false });
  assert.equal((await rest('ping', {}, { uid: LIMITED })).ok, true, 'skärmtid bara för video påverkar inte musiken');
});

t('återkallat lösenord, nytt lösenord ersätter det gamla och lösenordsbyte återkallar', async () => {
  const old = creds[ANNA];
  assert.equal((await makePassword(ANNA)).status, 200);
  assert.notEqual(creds[ANNA], old);
  assert.equal((await rest('ping', { u: 'anna', p: old }, { as: 'none' })).code, 40, 'det gamla slutar fungera');
  assert.equal((await rest('ping')).ok, true);
  const del = await api(ANNA, '/api/me/subsonic', { method: 'DELETE' });
  assert.equal(del.data.active, false);
  for (const as of ['token', 'plain', 'apikey']) assert.ok([40, 44].includes((await rest('ping', {}, { as })).code), as);
  S.resetLimits();
  assert.equal((await makePassword(ANNA)).status, 200);
  // Lösenordsbyte: hushållets app-lösenord (även profilernas) återkallas
  assert.ok(D.get('SELECT 1 FROM subsonic_passwords WHERE user_id=?', KID));
  const ch = await api(ANNA, '/api/me/password', { method: 'POST', body: { current: PW, password: 'Byt-till-Nytt-789!' } });
  assert.equal(ch.status, 200);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM subsonic_passwords WHERE user_id IN (?,?)', ANNA, KID).n, 0);
  D.run('UPDATE users SET pass=? WHERE id=?', hash, ANNA);
  tok[KID] = auth.createSession(KID, 'app'); tok[LIMITED] = auth.createSession(LIMITED, 'app'); // profilernas sessioner loggades ut
  S.resetLimits();
  assert.equal((await makePassword(ANNA)).status, 200);
  assert.equal((await makePassword(KID)).status, 200);
});

t('avstängt av administratören: /rest och skapandet nekas', async () => {
  D.setSetting('subsonic', '0');
  try {
    assert.equal((await rest('ping')).http, 403);
    assert.equal((await api(ANNA, '/api/me/subsonic', { method: 'POST', body: { password: PW } })).status, 403);
  } finally { D.setSetting('subsonic', '1'); }
  assert.equal((await rest('ping')).ok, true);
});

// ---------- endpoints ----------
/** Kör metoden i både XML och JSON och kontrollerar att svaret är ok och välformat */
async function both(method, params = {}, opts = {}) {
  const x = await rest(method, params, opts);
  assert.equal(x.ok, true, `${method} XML: ${x.text.slice(0, 300)}`);
  assert.match(x.ct, /text\/xml/);
  wellFormed(x.text);
  const j = await json(method, params, opts);
  assert.equal(j.ok, true, `${method} JSON: ${j.text.slice(0, 300)}`);
  return { xml: x.text, json: j.body };
}

t('system: ping, getLicense, getOpenSubsonicExtensions (utan inloggning), getUser, getScanStatus, getMusicFolders', async () => {
  await both('ping');
  assert.equal((await both('getLicense')).json.license.valid, true);
  const ext = await fetch(`${B}/rest/getOpenSubsonicExtensions?f=json`).then(r => r.json());
  const names = ext['subsonic-response'].openSubsonicExtensions.map(e => e.name);
  for (const n of ['apiKeyAuthentication', 'formPost', 'songLyrics', 'transcodeOffset']) assert.ok(names.includes(n), n);
  const u = await both('getUser', { username: 'anna' });
  assert.equal(u.json.user.username, 'anna');
  assert.equal(u.json.user.adminRole, false, 'ingen administration via musikappar');
  assert.equal((await json('getUser', { username: 'bo' })).code, 50);
  assert.equal(typeof (await both('getScanStatus')).json.scanStatus.scanning, 'boolean');
  const mf = await both('getMusicFolders');
  assert.deepEqual(mf.json.musicFolders.musicFolder, [{ id: LIB, name: 'Musik' }]);
  assert.match(mf.xml, new RegExp(`<musicFolder id="${LIB}" name="Musik"/>`));
});

t('bläddra: getIndexes, getArtists, getArtist, getArtistInfo2, getAlbum, getSong, getMusicDirectory, getGenres', async () => {
  const idx = await both('getIndexes');
  assert.deepEqual(idx.json.indexes.index.map(i => i.name), ['A', 'R']);
  assert.equal(idx.json.indexes.index[0].artist[0].id, `ar-${IDS.abba}`);
  const ar = await both('getArtists');
  const abba = ar.json.artists.index[0].artist[0];
  assert.deepEqual({ id: abba.id, name: abba.name, albumCount: abba.albumCount, coverArt: abba.coverArt }, { id: `ar-${IDS.abba}`, name: 'ABBA', albumCount: 1, coverArt: `ar-${IDS.abba}` });
  assert.equal((await json('getArtists', { musicFolderId: 9999 })).code, 70);
  const a = await both('getArtist', { id: `ar-${IDS.abba}` });
  assert.equal(a.json.artist.album[0].id, `al-${IDS.arrival}`);
  assert.equal((await json('getArtist', { id: `al-${IDS.arrival}` })).code, 70, 'fel prefix ger 70');
  assert.equal((await json('getArtist', {})).code, 10);
  await both('getArtistInfo2', { id: `ar-${IDS.abba}` });
  const al = await both('getAlbum', { id: `al-${IDS.arrival}` });
  const A = al.json.album;
  assert.equal(A.name, 'Arrival'); assert.equal(A.artist, 'ABBA'); assert.equal(A.songCount, 2); assert.equal(A.year, 1976); assert.equal(A.genre, 'Pop');
  assert.equal(A.coverArt, `al-${IDS.arrival}`);
  assert.deepEqual(A.song.map(s => s.title), ['Dancing Queen', 'Knowing Me, Knowing You']);
  const s0 = A.song[0];
  assert.equal(s0.id, `tr-${IDS.dq}`); assert.equal(s0.suffix, 'mp3'); assert.equal(s0.contentType, 'audio/mpeg'); assert.equal(s0.duration, 31);
  assert.equal(s0.albumId, `al-${IDS.arrival}`); assert.equal(s0.artistId, `ar-${IDS.abba}`); assert.equal(s0.isDir, false); assert.equal(s0.type, 'music');
  assert.ok(!s0.path.startsWith('/') && !s0.path.includes(MEDIA), 'serverns sökvägar lämnas inte ut');
  assert.equal(A.song[1].suffix, 'flac');
  assert.match(al.xml, /<song id="tr-\d+" parent="al-\d+" isDir="false" title="Dancing Queen"/);
  const so = await both('getSong', { id: `tr-${IDS.rob}` });
  assert.equal(so.json.song.title, 'Dancing On My Own <&>');
  assert.match(so.xml, /title="Dancing On My Own &lt;&amp;&gt;"/);
  assert.equal((await json('getSong', { id: 'tr-999999' })).code, 70);
  const dir = await both('getMusicDirectory', { id: `ar-${IDS.abba}` });
  assert.equal(dir.json.directory.child[0].isDir, true);
  const dir2 = await both('getMusicDirectory', { id: `al-${IDS.arrival}` });
  assert.equal(dir2.json.directory.child.length, 2);
  const g = await both('getGenres');
  assert.deepEqual(g.json.genres.genre.map(x => [x.value, x.songCount, x.albumCount]), [['Electro', 1, 1], ['Pop', 2, 1]]);
  assert.match(g.xml, /<genre songCount="1" albumCount="1">Electro<\/genre>/);
});

t('listor: getAlbumList2 (alla typer), getAlbumList, getRandomSongs, getSongsByGenre, search3', async () => {
  const L = async (type, p = {}) => (await both('getAlbumList2', { type, ...p })).json.albumList2.album.map(a => a.name);
  assert.deepEqual(await L('alphabeticalByName'), ['Arrival', 'Body Talk']);
  assert.deepEqual(await L('alphabeticalByArtist'), ['Arrival', 'Body Talk']);
  assert.equal((await L('newest')).length, 2);
  assert.equal((await L('random')).length, 2);
  assert.deepEqual(await L('byYear', { fromYear: 2000, toYear: 2020 }), ['Body Talk']);
  assert.deepEqual(await L('byYear', { fromYear: 2020, toYear: 1970 }), ['Body Talk', 'Arrival'], 'fallande när fromYear > toYear');
  assert.deepEqual(await L('byGenre', { genre: 'pop' }), ['Arrival']);
  assert.deepEqual(await L('frequent'), []);
  assert.deepEqual(await L('recent'), []);
  assert.deepEqual(await L('starred'), []);
  assert.deepEqual(await L('alphabeticalByName', { size: 1, offset: 1 }), ['Body Talk']);
  assert.equal((await json('getAlbumList2', { type: 'byYear' })).code, 10);
  assert.equal((await json('getAlbumList2', {})).code, 10);
  assert.equal((await json('getAlbumList2', { type: 'nonsens' })).code, 0);
  assert.equal((await both('getAlbumList', { type: 'newest' })).json.albumList.album.length, 2);
  const rnd = await both('getRandomSongs', { size: 2 });
  assert.equal(rnd.json.randomSongs.song.length, 2);
  assert.equal((await both('getRandomSongs', { genre: 'Electro' })).json.randomSongs.song.length, 1);
  assert.equal((await both('getRandomSongs', { fromYear: 1970, toYear: 1980 })).json.randomSongs.song.length, 2);
  const byg = await both('getSongsByGenre', { genre: 'Pop' });
  assert.equal(byg.json.songsByGenre.song.length, 2);
  const s = await both('search3', { query: 'dancing' });
  assert.deepEqual(s.json.searchResult3.song.map(x => x.title).sort(), ['Dancing On My Own <&>', 'Dancing Queen']);
  const s2 = await both('search3', { query: 'abba queen' });
  assert.deepEqual(s2.json.searchResult3.song.map(x => x.title), ['Dancing Queen'], 'alla ord måste matcha');
  assert.deepEqual(s2.json.searchResult3.artist, []);
  const s3 = await both('search3', { query: 'rob' });
  assert.deepEqual(s3.json.searchResult3.artist.map(x => x.name), ['Robyn']);
  assert.deepEqual(s3.json.searchResult3.album.map(x => x.name), ['Body Talk']);
  // Tom fråga = hela biblioteket, sida för sida (så synkar Symfonium)
  const all1 = await both('search3', { query: '""', songCount: 2, songOffset: 0, artistCount: 10, albumCount: 10 });
  const all2 = await json('search3', { query: '', songCount: 2, songOffset: 2 });
  assert.equal(all1.json.searchResult3.song.length + all2.body.searchResult3.song.length, 3);
  assert.equal(all1.json.searchResult3.artist.length, 2);
  // LIKE-tecken tolkas bokstavligt
  assert.deepEqual((await json('search3', { query: '%' })).body.searchResult3.song, []);
});

t('favoriter: star/unstar för låtar, album och artister, getStarred2 – och webbens favoriter syns', async () => {
  await both('star', { id: [`tr-${IDS.dq}`, `al-${IDS.bodytalk}`], artistId: `ar-${IDS.robyn}` });
  const st = (await both('getStarred2')).json.starred2;
  assert.deepEqual(st.song.map(s => s.id), [`tr-${IDS.dq}`]);
  assert.deepEqual(st.album.map(a => a.id), [`al-${IDS.bodytalk}`]);
  assert.deepEqual(st.artist.map(a => a.id), [`ar-${IDS.robyn}`]);
  assert.ok(st.song[0].starred, 'starred har ett datum');
  // Samma favoritlista som webben och apparna
  assert.ok(D.get('SELECT 1 FROM favorites WHERE user_id=? AND track_id=?', ANNA, IDS.dq));
  assert.equal((await both('getAlbumList2', { type: 'starred' })).json.albumList2.album.length, 1);
  assert.ok((await json('getSong', { id: `tr-${IDS.dq}` })).body.song.starred);
  await both('unstar', { id: `tr-${IDS.dq}`, albumId: `al-${IDS.bodytalk}`, artistId: `ar-${IDS.robyn}` });
  const st2 = (await json('getStarred2')).body.starred2;
  assert.deepEqual([st2.song.length, st2.album.length, st2.artist.length], [0, 0, 0]);
  assert.equal((await json('star', {})).code, 10);
  assert.equal((await json('star', { id: 'x-1' })).code, 70);
  // Andras favoriter syns inte
  await json('star', { id: `tr-${IDS.km}` }, { uid: KID });
  assert.equal((await json('getStarred2')).body.starred2.song.length, 0);
});

t('spellistor: skapa, hämta, ändra, ta bort – och smarta listor är skrivskyddade', async () => {
  // Ändrande anrop görs en gång per format (both() skulle köra dem två gånger)
  const cx = await rest('createPlaylist', { name: 'XML-lista', songId: `tr-${IDS.dq}` });
  assert.equal(cx.ok, true); wellFormed(cx.text);
  assert.match(cx.text, /<playlist id="pl-\d+" name="XML-lista"[^>]*><entry id="tr-\d+"/);
  await rest('deletePlaylist', { id: /<playlist id="(pl-\d+)"/.exec(cx.text)[1] });
  const c = await json('createPlaylist', { name: 'Fest & dans', songId: [`tr-${IDS.dq}`, `tr-${IDS.rob}`] });
  assert.equal(c.ok, true);
  const pid = c.body.playlist.id;
  assert.match(pid, /^pl-\d+$/);
  assert.equal(c.body.playlist.songCount, 2);
  // Samma spellista i webbens API
  const web = await api(ANNA, '/api/music/playlists');
  assert.deepEqual(web.data.map(p => [p.name, p.tracks]), [['Fest & dans', 2]]);
  const lists = await both('getPlaylists');
  const own = lists.json.playlists.playlist.find(p => p.id === pid);
  assert.equal(own.owner, 'anna'); assert.equal(own.readonly, false); assert.equal(own.coverArt, `al-${IDS.arrival}`);
  const g = await both('getPlaylist', { id: pid });
  assert.deepEqual(g.json.playlist.entry.map(e => e.id), [`tr-${IDS.dq}`, `tr-${IDS.rob}`]);
  const up = await rest('updatePlaylist', { playlistId: pid, name: 'Fest', comment: 'Lördag', songIdToAdd: `tr-${IDS.km}`, songIndexToRemove: 0 });
  assert.equal(up.ok, true);
  const g2 = (await json('getPlaylist', { id: pid })).body.playlist;
  assert.equal(g2.name, 'Fest'); assert.equal(g2.comment, 'Lördag');
  assert.deepEqual(g2.entry.map(e => e.id), [`tr-${IDS.rob}`, `tr-${IDS.km}`]);
  assert.equal((await json('updatePlaylist', { playlistId: pid, songIndexToRemove: 1 })).ok, true);
  assert.deepEqual((await json('getPlaylist', { id: pid })).body.playlist.entry.map(e => e.id), [`tr-${IDS.rob}`]);
  // createPlaylist med playlistId ersätter innehållet
  assert.equal((await json('createPlaylist', { playlistId: pid, songId: `tr-${IDS.km}` })).ok, true);
  assert.deepEqual((await json('getPlaylist', { id: pid })).body.playlist.entry.map(e => e.id), [`tr-${IDS.km}`]);
  // Andras spellistor syns inte och kan inte ändras
  assert.equal((await json('getPlaylist', { id: pid }, { uid: KID })).code, 70);
  assert.equal((await json('deletePlaylist', { id: pid }, { uid: KID })).code, 70);
  assert.equal((await json('getPlaylists', { username: 'lisa' })).code, 50);
  // Smarta listor ("Nyligen tillagt") visas, men kan inte ändras
  const smart = lists.json.playlists.playlist.find(p => p.id === `sp-${LIB}-recent`);
  assert.ok(smart, 'smart lista finns');
  assert.equal(smart.readonly, true);
  assert.equal((await both('getPlaylist', { id: smart.id })).json.playlist.entry.length, 3);
  assert.equal((await json('deletePlaylist', { id: smart.id })).code, 50);
  assert.equal((await json('updatePlaylist', { playlistId: smart.id, name: 'x' })).code, 50);
  assert.equal((await json('deletePlaylist', { id: pid })).ok, true);
  assert.equal((await json('getPlaylist', { id: pid })).code, 70);
  assert.equal((await json('createPlaylist', {})).code, 10);
});

t('scrobble: submission=true räknar lyssningen (och köar scrobbling), submission=false bara "spelas nu"', async () => {
  // Koppla ett låtsaskonto för scrobbling (inget anrop görs: SCROBBLE_INTERVAL=0 och felmarkerat konto får inga "spelas nu")
  D.run("INSERT INTO scrobble_accounts(user_id,service,secret,username,connected,error) VALUES(?,'listenbrainz','x','anna',0,'test')", ANNA);
  assert.equal((await rest('scrobble', { id: `tr-${IDS.rob}`, submission: 'false' })).ok, true);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM track_plays WHERE user_id=?', ANNA).n, 0, 'spelas nu räknas inte');
  assert.equal(D.get('SELECT COUNT(*) AS n FROM scrobble_queue WHERE user_id=?', ANNA).n, 0);
  const when = Date.now() - 120e3;
  assert.equal((await rest('scrobble', { id: `tr-${IDS.rob}`, time: when })).ok, true);
  await json('scrobble', { id: `tr-${IDS.rob}`, time: when }); // appen skickar om sin kö
  assert.equal(D.get('SELECT COUNT(*) AS n FROM track_plays WHERE user_id=? AND track_id=?', ANNA, IDS.rob).n, 1, 'räknas en gång');
  const q = D.all('SELECT * FROM scrobble_queue WHERE user_id=?', ANNA);
  assert.equal(q.length, 1);
  assert.equal(q[0].listened_at, Math.floor(when / 1000));
  assert.ok(q[0].due <= Math.floor(Date.now() / 1000), 'klar att skickas direkt');
  assert.equal(q[0].artist, 'Robyn');
  // Spelräknare och "recent"/"frequent" följer med
  const s = (await json('getSong', { id: `tr-${IDS.rob}` })).body.song;
  assert.equal(s.playCount, 1); assert.ok(s.played);
  assert.deepEqual((await json('getAlbumList2', { type: 'recent' })).body.albumList2.album.map(a => a.name), ['Body Talk']);
  assert.deepEqual((await json('getAlbumList2', { type: 'frequent' })).body.albumList2.album.map(a => a.name), ['Body Talk']);
  assert.deepEqual((await json('getTopSongs', { artist: 'Robyn' })).body.topSongs.song.map(x => x.title), ['Dancing On My Own <&>']);
  // Barnprofiler scrobblar aldrig
  D.run("INSERT INTO scrobble_accounts(user_id,service,secret,username,connected) VALUES(?,'listenbrainz','x','lisa',0)", KID);
  await json('scrobble', { id: `tr-${IDS.dq}` }, { uid: KID });
  assert.equal(D.get('SELECT COUNT(*) AS n FROM scrobble_queue WHERE user_id=?', KID).n, 0);
  assert.equal((await json('scrobble', {})).code, 10);
  assert.equal((await json('scrobble', { id: 'tr-999999' })).code, 70);
});

t('stream: direkt med Range, omkodning med maxBitRate/format, raw; download och skärmtid', async () => {
  const r = await rest('stream', { id: `tr-${IDS.dq}` }, { raw: true, headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  // FLAC → MP3 när appen ber om mp3
  const tc = await rest('stream', { id: `tr-${IDS.km}`, format: 'mp3', maxBitRate: 96 }, { raw: true });
  assert.equal(tc.status, 200);
  assert.equal(tc.headers.get('content-type'), 'audio/mpeg');
  assert.equal(tc.headers.get('x-transcoded'), '1');
  const buf = Buffer.from(await tc.arrayBuffer());
  assert.ok(buf.length > 1000);
  // FLAC utan format spelas direkt; med format=raw också
  const fl = await rest('stream', { id: `tr-${IDS.km}` }, { raw: true });
  assert.equal(fl.headers.get('content-type'), 'audio/flac'); await fl.arrayBuffer();
  const rw = await rest('stream', { id: `tr-${IDS.km}`, format: 'raw', maxBitRate: 64 }, { raw: true });
  assert.equal(rw.headers.get('content-type'), 'audio/flac'); await rw.arrayBuffer();
  const head = await fetch(`${B}/rest/stream.view?${new URLSearchParams({ u: 'anna', p: creds[ANNA], id: `tr-${IDS.dq}` })}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  const dl = await rest('download', { id: `tr-${IDS.dq}` }, { raw: true });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="01 - Dancing Queen.mp3"/);
  await dl.arrayBuffer();
  assert.equal((await json('stream', { id: `al-${IDS.arrival}` })).code, 70);
  assert.equal((await json('stream', {})).code, 10);
  // Skärmtid som bara gäller video (tidsruta som redan passerat) stoppar inte musiken
  screen.setRules(LIMITED, { from: '00:00', until: '00:01', audio: false });
  assert.equal((await rest('stream', { id: `tr-${IDS.dq}` }, { uid: LIMITED, raw: true })).status, 200, 'skärmtid utan ljud gäller inte musik');
  screen.setRules(LIMITED, null);
});

t('getCoverArt: album, låt, artist och spellista, storlek och 70 utan omslag', async () => {
  for (const id of [`al-${IDS.arrival}`, `tr-${IDS.dq}`, `ar-${IDS.abba}`]) {
    const r = await rest('getCoverArt', { id, size: 160 }, { raw: true });
    assert.equal(r.status, 200, id);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(b[0], 0xff); assert.equal(b[1], 0xd8);
  }
  const none = await json('getCoverArt', { id: `al-${IDS.bodytalk}` });
  assert.equal(none.code, 70); assert.equal(none.http, 404);
});

t('låttexter: getLyrics och getLyricsBySongId (synkade rader i ms)', async () => {
  const l = await both('getLyrics', { artist: 'Robyn', title: 'Dancing On My Own <&>' });
  assert.equal(l.json.lyrics.value, 'Somebody said\nyou got a new friend');
  assert.match(l.xml, /<lyrics artist="Robyn" title="Dancing On My Own &lt;&amp;&gt;">Somebody said\nyou got a new friend<\/lyrics>/);
  assert.deepEqual((await both('getLyrics', { artist: 'ABBA', title: 'Dancing Queen' })).json.lyrics, {});
  const s = await both('getLyricsBySongId', { id: `tr-${IDS.rob}` });
  const sl = s.json.lyricsList.structuredLyrics[0];
  assert.equal(sl.synced, true);
  assert.deepEqual(sl.line, [{ start: 1000, value: 'Somebody said' }, { start: 3500, value: 'you got a new friend' }]);
  assert.match(s.xml, /<line start="1000">Somebody said<\/line>/);
  assert.deepEqual((await json('getLyricsBySongId', { id: `tr-${IDS.dq}` })).body.lyricsList.structuredLyrics, []);
});

t('okända metoder och .view-suffix', async () => {
  assert.equal((await rest('ping.view')).ok, true);
  const u = await json('getPodcasts');
  assert.equal(u.code, 0); assert.equal(u.http, 404);
  assert.match(u.body.error.message, /stöds inte/);
});

t('egna betyg: setRating för låtar och album, userRating i svaren, webben och smarta listor ser samma betyg', async () => {
  assert.equal((await json('setRating', { id: `tr-${IDS.dq}`, rating: 4 })).ok, true);
  assert.equal((await json('setRating', { id: `al-${IDS.arrival}`, rating: 5 })).ok, true);
  assert.equal((await json('setRating', { id: `ar-${IDS.abba}`, rating: 3 })).ok, true, 'artister: ok men sparas inte');
  assert.equal((await json('setRating', { id: `tr-${IDS.dq}`, rating: 7 })).code, 10);
  assert.equal((await json('setRating', { id: 'tr-999999', rating: 3 })).code, 70);
  assert.equal((await json('getSong', { id: `tr-${IDS.dq}` })).body.song.userRating, 4);
  assert.equal((await json('getSong', { id: `tr-${IDS.km}` })).body.song.userRating, undefined);
  const al = (await json('getAlbum', { id: `al-${IDS.arrival}` })).body.album;
  assert.equal(al.userRating, 5);
  assert.equal(al.song.find(s => s.id === `tr-${IDS.dq}`).userRating, 4);
  // Webben: samma betyg (stjärnor); halva steg från webben avrundas till heltal i musikappen
  const web = await api(ANNA, `/api/music/albums/${IDS.arrival}`);
  assert.equal(web.data.userRating, 5);
  assert.equal(web.data.trackList.find(x => x.id === IDS.dq).userRating, 4);
  assert.equal((await api(ANNA, `/api/music/tracks/${IDS.km}/rating`, { method: 'PUT', body: { rating: 2.5 } })).data.rating, 2.5);
  assert.equal((await api(ANNA, `/api/music/tracks/${IDS.km}/rating`)).data.rating, 2.5);
  assert.equal((await api(ANNA, `/api/music/tracks/${IDS.km}/rating`, { method: 'PUT', body: { rating: 0.5 } })).status, 400);
  assert.equal((await json('getSong', { id: `tr-${IDS.km}` })).body.song.userRating, 3);
  // Smart lista med "Mitt betyg" – lyssnarens egna betyg
  const prev = await api(ANNA, '/api/music/smartlists/preview', { method: 'POST', body: { rules: [{ field: 'rating', op: 'gt', value: 3 }], sort: 'rating' } });
  assert.deepEqual(prev.data.trackList.map(x => x.id), [IDS.dq]);
  const albumRule = await api(ANNA, '/api/music/smartlists/preview', { method: 'POST', body: { rules: [{ field: 'albumrating', op: 'is', value: 5 }] } });
  assert.deepEqual(albumRule.data.trackList.map(x => x.id).sort(), [IDS.dq, IDS.km].sort());
  const kid = await api(KID, '/api/music/smartlists/preview', { method: 'POST', body: { rules: [{ field: 'rating', op: 'gt', value: 0 }] } });
  assert.equal(kid.data.trackList.length, 0, 'andra profilers betyg räknas inte');
  // 0 tar bort
  assert.equal((await json('setRating', { id: `tr-${IDS.dq}`, rating: 0 })).ok, true);
  assert.equal((await json('getSong', { id: `tr-${IDS.dq}` })).body.song.userRating, undefined);
});
