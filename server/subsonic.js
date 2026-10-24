// Musikappar via Subsonic/OpenSubsonic-API:t (Symfonium, Amperfy, play:Sub, Feishin, Supersonic, Music Assistant …):
// app-lösenordet, inloggningen och svarsformatet (XML/JSON). Själva endpoints ligger i server/routes/subsonic.js.
//
// Varför ett eget lösenord: Subsonic-inloggningen t=md5(lösenord+salt)&s=salt kräver att servern har lösenordet i
// klartext, men kontolösenorden lagras bara som scrypt. Varje användare (och profil) kan därför skapa ett slumpat
// app-lösenord under Mitt konto. Det visas en gång och kan återkallas.
//   - Lagring: krypterat med AES-256-GCM (nyckeln i /config/subsonic.key, utanför databasen) så att md5-kontrollen
//     går, plus SHA-256 för klartext (p=) och OpenSubsonic apiKey. Ett läckt databasutdrag eller en säkerhetskopia
//     av databasen räcker alltså inte för att logga in. Försvinner nyckelfilen fungerar bara p=/apiKey tills
//     ett nytt lösenord skapas.
//   - Räckvidd: lösenordet finns inte i sessions och hittas aldrig av userFromReq – det gäller bara /rest/*
//     (routealternativet subsonic i http/router.js), och /rest/* tar inte emot kaka, Bearer eller ?t=.
//   - Gissning: egen spärr per IP (/64 för IPv6) och per användarnamn utifrån; påverkar inte webbinloggningen.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { get, run, now, getSetting, CONFIG } from './db.js';
import { sha, ipKey } from './auth.js';

export const API_VERSION = '1.16.1';
export const enabled = () => getSetting('subsonic', process.env.SUBSONIC || '1') === '1';

// ---------- servernyckeln ----------
const KEY_FILE = path.join(CONFIG, 'subsonic.key');
let key = null;
function serverKey() {
  if (key) return key;
  try { const k = fs.readFileSync(KEY_FILE); if (k.length === 32) return (key = k); } catch {}
  const k = randomBytes(32);
  try { fs.writeFileSync(KEY_FILE, k, { mode: 0o600, flag: 'wx' }); key = k; }
  catch { const r = fs.readFileSync(KEY_FILE); if (r.length !== 32) throw new Error('subsonic.key är trasig'); key = r; } // annan process hann först
  return key;
}
// Raden är knuten till användaren (AAD): en krypterad rad som flyttas till ett annat konto går inte att läsa
function encrypt(uid, text) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', serverKey(), iv);
  c.setAAD(Buffer.from(`subsonic:${uid}`));
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(uid, enc) {
  try {
    const b = Buffer.from(String(enc).slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', serverKey(), b.subarray(0, 12));
    d.setAAD(Buffer.from(`subsonic:${uid}`));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

// ---------- app-lösenordet ----------
// 24 tecken utan förväxlingsbara (i, l, o, 0, 1) i grupper om sex: ~118 bitar
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newSecret() {
  let s = '';
  for (let i = 0; i < 24; i++) s += (i && i % 6 === 0 ? '-' : '') + ALPHA[randomInt(ALPHA.length)];
  return s;
}
/** Skapar (eller ersätter) användarens app-lösenord. Returnerar klartexten – den visas bara en gång. */
export function createPassword(uid, { ip = null, trusted = false } = {}) {
  const secret = newSecret();
  run(`INSERT INTO subsonic_passwords(user_id,enc,key_hash,created,created_ip,trusted,last_used,last_ip,client) VALUES(?,?,?,?,?,?,NULL,NULL,NULL)
    ON CONFLICT(user_id) DO UPDATE SET enc=excluded.enc, key_hash=excluded.key_hash, created=excluded.created, created_ip=excluded.created_ip,
    trusted=excluded.trusted, last_used=NULL, last_ip=NULL, client=NULL`, uid, encrypt(uid, secret), sha(secret), now(), ip, trusted ? 1 : 0);
  return secret;
}
export const revokePassword = (uid) => run('DELETE FROM subsonic_passwords WHERE user_id=?', uid).changes > 0;
/** Återkallar app-lösenorden för ett hushåll (kontot och dess profiler), t.ex. när lösenordet byts */
export const revokeHousehold = (rootId) => Number(run('DELETE FROM subsonic_passwords WHERE user_id IN (SELECT id FROM users WHERE id=?1 OR parent_id=?1)', rootId).changes);
/** Status för Mitt konto – aldrig lösenordet */
export function info(uid) {
  const r = get('SELECT created, created_ip, trusted, last_used, last_ip, client FROM subsonic_passwords WHERE user_id=?', uid);
  return r ? { active: true, created: r.created, createdIp: r.created_ip, createdAtHome: !!r.trusted, lastUsed: r.last_used, lastIp: r.last_ip, client: r.client } : { active: false };
}

// ---------- skydd mot gissning ----------
// Eget register (inte webbinloggningens): en felinställd musikapp hemma ska inte spärra webben, och tvärtom.
const WINDOW = 600e3, IP_MAX = 10, USER_MAX = 10, USER_LOCK = 15 * 60e3;
const ipFails = new Map(), userFails = new Map();
const recent = (l) => (l || []).filter(t => Date.now() - t < WINDOW);
export function ipBlocked(ip) { const k = ipKey(ip), f = recent(ipFails.get(k)); if (f.length) ipFails.set(k, f); else ipFails.delete(k); return f.length >= IP_MAX; }
export function userLocked(name) { const u = userFails.get(String(name).toLowerCase()); return !!(u && u.until > Date.now()); }
function noteFail(ip, name, trusted) {
  const k = ipKey(ip);
  if (!ipFails.has(k) && ipFails.size >= 50000) ipFails.clear();
  ipFails.set(k, [...recent(ipFails.get(k)), Date.now()]);
  // Kontospärren gäller bara försök utifrån – annars kan en angripare låsa ute hushållets egna appar
  if (name && !trusted) {
    const n = String(name).toLowerCase().slice(0, 64);
    if (!userFails.has(n) && userFails.size >= 50000) userFails.clear();
    const u = { list: [...recent(userFails.get(n)?.list), Date.now()], until: userFails.get(n)?.until || 0 };
    if (u.list.length >= USER_MAX) u.until = Date.now() + USER_LOCK;
    userFails.set(n, u);
  }
}
export function resetLimits() { ipFails.clear(); userFails.clear(); }
setInterval(() => {
  for (const [k, v] of ipFails) if (!recent(v).length) ipFails.delete(k);
  for (const [k, v] of userFails) if (v.until < Date.now() && !recent(v.list).length) userFails.delete(k);
}, WINDOW).unref();

// ---------- inloggning ----------
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const USER_COLS = 'u.id, u.name, u.remote_allowed, u.totp_enabled, u.parent_id, u.max_age, s.enc, s.key_hash, s.last_used';
/** p= i klartext eller enc:<hex> (Subsonic) */
function plainPassword(p) {
  p = String(p);
  if (!p.startsWith('enc:')) return p;
  const hex = p.slice(4);
  return /^(?:[0-9a-f]{2})*$/i.test(hex) ? Buffer.from(hex, 'hex').toString('utf8') : null;
}
export class SubsonicError extends Error {
  constructor(code, message, http = 200) { super(message); this.code = code; this.http = http; }
}
/**
 * Loggar in en förfrågan till /rest/* med parametrarna P (URLSearchParams, query + formulär).
 * Stöder u+t+s (md5 med salt), u+p (klartext/enc:hex) och apiKey (OpenSubsonic). Kastar SubsonicError.
 * Fjärrreglerna (fjärråtkomst, 2FA utifrån) kontrolleras av routen med remoteDenied i http/router.js.
 */
export function authenticate(P, { ip, trusted, client }) {
  if (ipBlocked(ip)) throw new SubsonicError(0, 'För många misslyckade inloggningar – vänta en stund och försök igen', 429);
  const apiKey = P.get('apiKey'), name = P.get('u'), p = P.get('p'), t = P.get('t'), s = P.get('s');
  let u = null;
  if (apiKey != null) {
    if (name != null || p != null || t != null || s != null) throw new SubsonicError(43, 'Ange antingen apiKey eller användarnamn och lösenord, inte båda');
    u = apiKey ? get(`SELECT ${USER_COLS} FROM subsonic_passwords s JOIN users u ON u.id=s.user_id WHERE s.key_hash=?`, sha(apiKey)) : null;
    if (!u) { noteFail(ip, null, trusted); throw new SubsonicError(44, 'Ogiltig API-nyckel'); }
  } else {
    if (!name) throw new SubsonicError(10, 'Parametern u (användarnamn) saknas');
    if (p != null && (t != null || s != null)) throw new SubsonicError(43, 'Ange antingen p eller t och s, inte båda');
    if (p == null && (!t || !s)) throw new SubsonicError(10, 'Lösenord saknas (p, eller t och s)');
    if (!trusted && userLocked(name)) { noteFail(ip, null, trusted); throw new SubsonicError(40, 'Fel användarnamn eller lösenord'); }
    const row = get(`SELECT ${USER_COLS} FROM subsonic_passwords s JOIN users u ON u.id=s.user_id WHERE u.name=?`, String(name).slice(0, 64));
    let ok = false;
    if (row && p != null) { const pw = plainPassword(p); ok = pw != null && eq(sha(pw), row.key_hash); }
    else if (row) { const pw = decrypt(row.id, row.enc); ok = pw != null && /^[0-9a-f]{32}$/i.test(t) && eq(md5(pw + s), String(t).toLowerCase()); }
    if (!ok) { noteFail(ip, name, trusted); throw new SubsonicError(40, 'Fel användarnamn eller lösenord'); }
    u = row;
    userFails.delete(String(name).toLowerCase());
  }
  if (now() - (u.last_used || 0) > 600) run('UPDATE subsonic_passwords SET last_used=?, last_ip=?, client=? WHERE user_id=?', now(), ip, client ? String(client).replace(/[\u0000-\u001f]/g, '').slice(0, 60) : null, u.id);
  const { enc, key_hash, last_used, ...user } = u;
  return { ...user, is_admin: 0, kind: 'subsonic', via: 'subsonic' };
}

// ---------- svar ----------
// Samma objekt blir XML (skalära fält = attribut, objekt och listor = barnelement, value = textinnehåll) eller JSON.
// Tecken som XML 1.0 inte tillåter (styrtecken, ensamma surrogat) tas bort så att klientens tolk inte stannar.
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const xmlEsc = (v) => String(v).replace(BAD_XML, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const XML_NAME = /^[A-Za-z_][\w.-]*$/;
/** Ett textfält som ska bli ett eget element i XML (<biography>…</biography>) men en vanlig sträng i JSON (artistInfo, albumInfo) */
export class Elem { constructor(v) { this.v = v; } toJSON() { return this.v; } }
export const elem = (v) => v == null || v === '' ? undefined : new Elem(v);
function xmlNode(name, obj) {
  if (!XML_NAME.test(name)) throw new Error('ogiltigt elementnamn ' + name);
  let attrs = '', kids = '', text = null;
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (k === 'value' && typeof v !== 'object') { text = v; continue; }
    if (v instanceof Elem) { if (!XML_NAME.test(k)) throw new Error('ogiltigt elementnamn ' + k); kids += `<${k}>${xmlEsc(v.v)}</${k}>`; continue; }
    if (Array.isArray(v)) { for (const x of v) if (x != null) kids += typeof x === 'object' ? xmlNode(k, x) : `<${k}>${xmlEsc(x)}</${k}>`; }
    else if (typeof v === 'object') kids += xmlNode(k, v);
    else { if (!XML_NAME.test(k)) throw new Error('ogiltigt attributnamn ' + k); attrs += ` ${k}="${xmlEsc(v)}"`; }
  }
  return kids || text != null ? `<${name}${attrs}>${text != null ? xmlEsc(text) : ''}${kids}</${name}>` : `<${name}${attrs}/>`;
}
const prune = (v) => {
  if (v instanceof Elem) return v.v;
  if (Array.isArray(v)) return v.filter(x => x != null).map(prune);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (x != null) o[k] = prune(x); return o; }
  return v;
};
const head = () => ({ status: 'ok', version: API_VERSION, type: 'braxhn-tv', serverVersion: globalThis.__braxhnAppVersion || '0', openSubsonic: true });
/** Hela svaret som text: { body, type }. format = värdet på f (xml som standard; json och jsonp ger JSON). */
export function render(payload, format, error = null) {
  const root = { ...head(), ...(error ? { status: 'failed', error: { code: error.code, message: error.message } } : {}), ...(payload || {}) };
  if (format === 'json' || format === 'jsonp') return { type: 'application/json; charset=utf-8', body: JSON.stringify({ 'subsonic-response': prune(root) }) };
  const x = xmlNode('subsonic-response', root).replace(/^<subsonic-response/, '<subsonic-response xmlns="http://subsonic.org/restapi"');
  return { type: 'text/xml; charset=utf-8', body: '<?xml version="1.0" encoding="UTF-8"?>\n' + x };
}
