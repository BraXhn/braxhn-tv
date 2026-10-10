import { randomBytes, scrypt, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { get, all, run, now, getSetting } from './db.js';
import { cookies, clean } from './util.js';

// ---------------- lösenord ----------------
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
// Lösenordshashning körs utanför händelseloopen och högst 4 samtidigt – så att en
// inloggningsstorm inte fryser strömmar för andra användare.
let active = 0; const waiting = [];
async function slot(fn) {
  if (active >= 4) await new Promise(r => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}
const scryptAsync = (pw, salt, opts) => slot(() => new Promise((ok, no) => scrypt(pw, salt, 64, opts, (e, k) => e ? no(e) : ok(k))));

export async function hashPw(pw) {
  const salt = randomBytes(16);
  return 's2:' + salt.toString('hex') + ':' + (await scryptAsync(String(pw), salt, SCRYPT)).toString('hex');
}
export async function checkPw(pw, stored) {
  let opts = {}, parts = String(stored || '').split(':');
  if (parts[0] === 's2') { opts = SCRYPT; parts = parts.slice(1); }
  const [s, h] = parts;
  if (!s || !h) return false;
  const a = await scryptAsync(String(pw).slice(0, 1024), Buffer.from(s, 'hex'), opts), b = Buffer.from(h, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
// Körs när användaren inte finns, så att svarstiden inte avslöjar vilka konton som finns
const DUMMY = 's2:' + randomBytes(16).toString('hex') + ':' + scryptSync('x', randomBytes(16), 64, SCRYPT).toString('hex');
export const dummyCheck = async (pw) => { await checkPw(pw, DUMMY); return false; };

const COMMON = new Set(['password', 'password1', 'lösenord', 'losenord', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyui',
  'sommar2024', 'sommar2025', 'sommar2026', 'vinter2025', 'hejsan123', 'abcd1234', 'admin123', 'administrator', 'welcome1', 'iloveyou',
  'letmein1', 'passw0rd', 'braxhntv', 'braxhn123', 'plex1234', 'jellyfin', '11111111', '00000000', 'asdfghjk', 'zxcvbnm1']);
/** Returnerar ett felmeddelande om lösenordet är för svagt, annars null. */
export function weakPassword(pw, name = '') {
  pw = String(pw || '');
  if (pw.length < 10) return 'Lösenordet måste ha minst 10 tecken';
  if (pw.length > 256) return 'Lösenordet är för långt';
  const low = pw.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pw)) return 'Lösenordet är för vanligt';
  if (name && low.includes(String(name).toLowerCase())) return 'Lösenordet får inte innehålla användarnamnet';
  const classes = [/[a-zåäö]/, /[A-ZÅÄÖ]/, /\d/, /[^\wåäöÅÄÖ]/].filter(r => r.test(pw)).length;
  if (pw.length < 14 && classes < 3) return 'Använd minst 3 av: små bokstäver, stora bokstäver, siffror, specialtecken – eller minst 14 tecken';
  return null;
}

// ---------------- sessioner och token ----------------
// Token lagras som SHA-256 i databasen – ett läckt databasutdrag går inte att logga in med.
// kind: web (cookie), app (Bearer, TV/mobil/bil), media (kortlivad, en titel, för strömmar/cast), img (bilder i appar)
const TTL = { web: 30 * 86400, app: 365 * 86400, media: 24 * 3600, img: 7 * 86400 };
export const sha = (t) => createHash('sha256').update(String(t)).digest('hex');

export function createSession(userId, kind = 'web', { item = null, ua = null, ip = null } = {}) {
  const token = randomBytes(32).toString('hex');
  run(`INSERT INTO sessions(token,user_id,created,kind,expires,scope_item,ua,ip,last_seen) VALUES(?,?,?,?,?,?,?,?,?)`,
    sha(token), userId, now(), kind, now() + TTL[kind], item, ua ? String(ua).slice(0, 200) : null, ip, now());
  run('DELETE FROM sessions WHERE expires < ?', now());
  return token;
}
// Över HTTPS används __Host--prefixet (kan inte sättas av andra underdomäner)
export const COOKIE = (secure) => secure ? '__Host-kt' : 'kt';
export const cookieHeader = (token, secure = false) =>
  `${COOKIE(secure)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL.web}${secure ? '; Secure' : ''}`;
export const clearCookies = () => ['kt=; Path=/; Max-Age=0', '__Host-kt=; Path=/; Max-Age=0; Secure'];

/** Hämta token. Token i URL (?t=) accepteras bara för media/bild-rutter och bara för kortlivade token. */
export function tokenFromReq(req, query, allowQuery) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return { token: h.slice(7).trim(), via: 'header' };
  const jar = cookies(req), c = jar['__Host-kt'] || jar.kt;
  if (c) return { token: c, via: 'cookie' };
  if (allowQuery && query?.get('t')) return { token: query.get('t'), via: 'query' };
  return null;
}

export function userFromReq(req, query, allowQuery = false) {
  const t = tokenFromReq(req, query, allowQuery);
  if (!t || !/^[a-f0-9]{64}$/.test(t.token)) return null;
  const h = sha(t.token);
  const u = get(`SELECT u.id,u.name,u.is_admin,u.remote_allowed,u.totp_enabled,u.parent_id,u.max_age,s.kind,s.scope_item,s.last_seen,s.rowid AS sid
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires > ?`, h, now());
  if (!u) return null;
  if (t.via === 'query' && !['media', 'img'].includes(u.kind)) return null;
  if (t.via !== 'query' && ['media', 'img'].includes(u.kind) && t.via === 'cookie') return null;
  // Glidande giltighetstid för web/app (uppdateras högst var 10:e minut)
  if (now() - (u.last_seen || 0) > 600) {
    if (u.kind === 'web' || u.kind === 'app') run('UPDATE sessions SET last_seen=?, expires=? WHERE token=?', now(), now() + TTL[u.kind], h);
    else run('UPDATE sessions SET last_seen=? WHERE token=?', now(), h);
  }
  u.token = t.token; u.tokenHash = h; u.via = t.via;
  return u;
}

export function listSessions(userId, currentHash) {
  return all(`SELECT rowid AS id, kind, ua, ip, created, last_seen, expires, token FROM sessions
    WHERE user_id=? AND kind IN ('web','app') AND expires > ? ORDER BY last_seen DESC`, userId, now())
    .map(({ token, ...s }) => ({ ...s, current: token === currentHash }));
}

// ---------------- skydd mot gissning ----------------
const ipFails = new Map();   // ip -> [tider]
const userFails = new Map(); // namn -> { n, until }
const WINDOW = 600e3;
// IPv6: räkna per /64 (en angripare har normalt ett helt /64-nät)
const ipKey = (ip) => String(ip).includes(':') ? String(ip).toLowerCase().split(':').slice(0, 4).join(':') : String(ip);
export function ipBlocked(ip) {
  ip = ipKey(ip);
  const f = (ipFails.get(ip) || []).filter(t => Date.now() - t < WINDOW);
  ipFails.set(ip, f);
  return f.length >= 10;
}
export function userLocked(name) {
  const u = userFails.get(String(name).toLowerCase());
  return !!(u && u.until > Date.now());
}
export function noteFail(ip, name) {
  ip = ipKey(ip);
  ipFails.set(ip, [...(ipFails.get(ip) || []), Date.now()]);
  if (name) {
    const k = String(name).toLowerCase();
    const u = userFails.get(k) || { n: 0, until: 0, last: 0 };
    if (Date.now() - u.last > 3600e3) u.n = 0;
    u.n++; u.last = Date.now();
    // 5 fel → 5 min spärr, därefter dubbleras spärren (max 24 h)
    if (u.n >= 5) u.until = Date.now() + Math.min(24 * 3600e3, 5 * 60e3 * 2 ** (u.n - 5));
    userFails.set(k, u);
    return u.until > Date.now();
  }
  return false;
}
export function clearFails(name) { userFails.delete(String(name).toLowerCase()); }
setInterval(() => {
  for (const [k, v] of ipFails) if (!v.some(t => Date.now() - t < WINDOW)) ipFails.delete(k);
  for (const [k, v] of userFails) if (v.until < Date.now() && Date.now() - v.last > 3600e3) userFails.delete(k);
}, 600e3).unref();

// ---------------- tvåstegsverifiering (TOTP, RFC 6238) ----------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = (val << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
export const newTotpSecret = () => base32(randomBytes(20));
export function totpUri(secret, name) {
  const label = encodeURIComponent(`BraXhn TV:${name}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('BraXhn TV')}&algorithm=SHA1&digits=6&period=30`;
}
/** Kontrollerar kod (±30 s) och förhindrar återanvändning. Returnerar använd tidsstegning eller -1. */
export function verifyTotp(secret, code, lastStep = 0) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return -1;
  const step = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    if (s <= lastStep) continue;
    const exp = hotp(secret, s);
    if (timingSafeEqual(Buffer.from(exp), Buffer.from(code))) return s;
  }
  return -1;
}
export function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
  return { codes, hashes: codes.map(c => sha(c.replace(/-/g, ''))) };
}
/** Förbrukar en reservkod om den stämmer. */
export function useRecoveryCode(user, code) {
  if (!user?.recovery) return false;
  const c = String(code || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  if (c.length !== 10) return false;
  let list; try { list = JSON.parse(user.recovery || '[]'); } catch { list = []; }
  const h = sha(c), i = list.indexOf(h);
  if (i < 0) return false;
  list.splice(i, 1);
  run('UPDATE users SET recovery=? WHERE id=?', JSON.stringify(list), user.id);
  return true;
}

// ---------------- revisionslogg ----------------
export const auditHooks = [];
export function audit(event, { user = null, ip = null, detail = null } = {}) {
  for (const h of auditHooks) { try { h(event, { user, ip, detail }); } catch {} }
  run('INSERT INTO audit(ts,user_id,user_name,ip,event,detail) VALUES(?,?,?,?,?,?)',
    now(), user?.id ?? null, user?.name != null ? clean(user.name, 64) : null, ip ? clean(ip, 64) : null, event, detail ? clean(detail, 300) : null);
  // Rad i loggen som t.ex. CrowdSec/fail2ban kan läsa (kontrolltecken borttagna, användarnamn inom citattecken)
  if (/fail|locked|denied/.test(event)) console.warn(`[auth] ${event} ip=${clean(ip || '-', 64).replace(/\s/g, '')} user="${clean(user?.name || '-', 64).replace(/"/g, "'")}"${detail ? ' ' + clean(detail, 120) : ''}`);
}
setInterval(() => run('DELETE FROM audit WHERE id <= (SELECT MAX(id) - 5000 FROM audit)'), 3600e3).unref();

export const require2faRemote = () => getSetting('require_2fa_remote', '0') === '1';
