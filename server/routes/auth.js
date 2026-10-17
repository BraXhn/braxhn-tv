// Status, första kontot, inloggning, lösenord, tvåstegsverifiering, sessioner, passkeys och profiler (hushåll).
import crypto from 'node:crypto';
import { get, getSetting, run, now, all } from '../db.js';
import { send, fail, readJson, clientIp, isHttps, isPrivate } from '../util.js';
import { weakPassword, hashPw, audit, cookieHeader, createSession, ipBlocked, userLocked, noteFail, checkPw, dummyCheck, require2faRemote, verifyTotp, useRecoveryCode, clearFails, clearCookies, newTotpSecret, totpUri, newRecoveryCodes, listSessions, ipKey } from '../auth.js';
import { hasTmdb } from '../scanner.js';
import * as pk from '../passkeys.js';
import * as updates from '../updates.js';
import { VERSION } from '../updates.js';
import * as screen from '../screentime.js';
import { route, pub, isTrusted, adminAnywhere, user } from '../http/router.js';
import { allowUnrated, ctx, householdRoot, canManage } from '../http/context.js';

// Hälsokontroll (Docker HEALTHCHECK): databasen måste svara, annars startas containern om
route('GET', '/api/health', pub, (c) => {
  try { get('SELECT 1'); } catch (e) { return send(c.res, 503, { ok: false, error: 'Databasen svarar inte' }); }
  send(c.res, 200, { ok: true });
});
route('GET', '/api/status', pub, (c) => send(c.res, 200, {
  // Avslöja inte för utomstående att servern är nyinstallerad
  needsSetup: isTrusted(c.req) && !get('SELECT 1 FROM users LIMIT 1'), version: VERSION, name: 'BraXhn TV',
  publicUrl: getSetting('public_url', process.env.PUBLIC_URL || '') || null,
  user: c.user ? { id: c.user.id, name: c.user.name, is_admin: c.user.is_admin, totp: !!c.user.totp_enabled,
    profiles: get('SELECT COUNT(*) AS n FROM users WHERE id=? OR parent_id=?', c.user.parent_id || c.user.id, c.user.parent_id || c.user.id).n,
    kid: c.user.max_age != null, maxAge: c.user.max_age ?? null,
    adminHere: !!c.user.is_admin && (adminAnywhere() || isTrusted(c.req)),
    update: c.user.is_admin && updates.info().available ? updates.state.latest : null,
    streaming: c.user.max_age == null && hasTmdb(), screenTime: screen.status(c.user.id),
    liveTv: (c.user.max_age == null || allowUnrated()) && !!get('SELECT 1 FROM channels c JOIN tuners t ON t.id=c.tuner_id WHERE t.enabled=1 AND c.hidden=0 LIMIT 1') } : null
}));
route('POST', '/api/setup', pub, async (c) => {
  // Förhindra att någon utifrån hinner skapa adminkontot på en nyinstallerad server
  if (!isTrusted(c.req)) return fail(c.res, 403, 'Det första kontot kan bara skapas från hemnätverket');
  if (get('SELECT 1 FROM users LIMIT 1')) return fail(c.res, 403, 'Redan konfigurerad');
  const { name, password } = await readJson(c.req);
  if (!name?.trim()) return fail(c.res, 400, 'Namn krävs');
  const weak = weakPassword(password, name); if (weak) return fail(c.res, 400, weak);
  const hash = await hashPw(password);
  // Atomiskt: skapas bara om det fortfarande inte finns några användare (två samtidiga förfrågningar)
  const r = run('INSERT INTO users(name,pass,is_admin,created,pw_changed) SELECT ?,?,1,?,? WHERE NOT EXISTS (SELECT 1 FROM users)', name.trim(), hash, now(), now());
  if (!r.changes) return fail(c.res, 403, 'Redan konfigurerad');
  const id = Number(r.lastInsertRowid);
  audit('setup', { user: { id, name }, ip: clientIp(c.req) });
  send(c.res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(createSession(id, 'web', { ua: c.req.headers['user-agent'], ip: clientIp(c.req) }), isHttps(c.req)) });
});

route('POST', '/api/login', pub, async (c) => {
  const ip = clientIp(c.req);
  const { name, password, app, code, remember } = await readJson(c.req);
  const uname = String(name || '').trim().slice(0, 64);
  const generic = () => fail(c.res, 401, 'Fel namn eller lösenord');
  if (ipBlocked(ip)) { audit('login_denied', { ip, detail: 'ip-spärr' }); return fail(c.res, 429, 'För många försök – vänta en stund och försök igen'); }
  // Kontospärren gäller inte från hemnätet – annars kan en angripare låsa ute dig från ditt eget nät
  if (userLocked(uname) && !isTrusted(c.req)) { noteFail(ip); audit('login_locked', { ip, user: { name: uname } }); return fail(c.res, 429, 'För många försök – vänta en stund och försök igen'); }
  const u0 = get('SELECT * FROM users WHERE name=?', uname);
  const u = u0 && !u0.parent_id ? u0 : null; // profiler nås bara via profilbyte i sitt hushåll
  const ok = u ? await checkPw(String(password || ''), u.pass) : await dummyCheck(String(password || ''));
  if (!ok) {
    const locked = noteFail(ip, isTrusted(c.req) ? null : uname);
    audit('login_fail', { ip, user: { id: u?.id, name: uname }, detail: locked ? 'kontot spärrat tillfälligt för inloggning utifrån' : null });
    return generic();
  }
  // Läs om 2FA-fälten efter den långsamma lösenordskontrollen: två samtidiga inloggningar får inte
  // använda samma engångskod eller återställningskod (resten av routen är synkron)
  Object.assign(u, get('SELECT totp_enabled, totp_secret, totp_last, recovery FROM users WHERE id=?', u.id));
  const remote = !isTrusted(c.req);
  if (remote && !u.remote_allowed) { audit('login_denied', { ip, user: u, detail: 'fjärråtkomst ej tillåten' }); return fail(c.res, 403, 'Ditt konto får bara användas på hemnätverket'); }
  if (remote && require2faRemote() && !u.totp_enabled) { audit('login_denied', { ip, user: u, detail: '2FA krävs utifrån' }); return fail(c.res, 403, 'Tvåstegsverifiering krävs för inloggning utanför hemmet. Aktivera den under Mitt konto från hemnätet.'); }
  if (u.totp_enabled) {
    if (!code) return send(c.res, 401, { error: 'Ange koden från din autentiseringsapp', need2fa: true });
    const step = verifyTotp(u.totp_secret, code, u.totp_last);
    if (step > 0) run('UPDATE users SET totp_last=? WHERE id=?', step, u.id);
    else if (useRecoveryCode(u, code)) audit('2fa_recovery_used', { ip, user: u });
    else {
      const locked = noteFail(ip, uname);
      audit('login_fail', { ip, user: u, detail: 'fel tvåstegskod' + (locked ? ', kontot spärrat tillfälligt' : '') });
      return send(c.res, 401, { error: 'Fel kod', need2fa: true });
    }
  }
  clearFails(uname);
  audit('login_ok', { ip, user: u, detail: app ? 'app' : 'webb' });
  const meta = { ua: c.req.headers['user-agent'], ip };
  const pwOld = weakPassword(password, u.name) ? true : false;
  if (app) return send(c.res, 200, { ok: true, token: createSession(u.id, 'app', meta), user: { id: u.id, name: u.name, is_admin: u.is_admin }, weakPassword: pwOld });
  const keep = remember !== false; // äldre klienter skickar inget: håll inloggad som förut
  send(c.res, 200, { ok: true, weakPassword: pwOld }, { 'Set-Cookie': cookieHeader(createSession(u.id, 'web', { ...meta, remember: keep }), isHttps(c.req), keep) });
});
route('POST', '/api/logout', user, (c) => {
  run('DELETE FROM sessions WHERE token=?', c.user.tokenHash);
  send(c.res, 200, { ok: true }, { 'Set-Cookie': clearCookies() });
});
// Bildtoken för appar (bilder laddas via URL och kan inte skicka Authorization-header)
route('POST', '/api/media-token', user, (c) => send(c.res, 200, { token: createSession(c.user.id, 'img'), ttl: 7 * 86400 }));

route('POST', '/api/me/password', user, async (c) => {
  const { current, password } = await readJson(c.req);
  if (ipBlocked(clientIp(c.req))) return fail(c.res, 429, 'För många försök – vänta en stund');
  const u = get('SELECT pass,name FROM users WHERE id=?', c.user.id);
  if (!await checkPw(String(current || ''), u.pass)) { noteFail(clientIp(c.req), u.name); return fail(c.res, 400, 'Nuvarande lösenord stämmer inte'); }
  const weak = weakPassword(password, u.name); if (weak) return fail(c.res, 400, weak);
  run('UPDATE users SET pass=?, pw_changed=? WHERE id=?', await hashPw(password), now(), c.user.id);
  // Logga ut alla andra enheter
  // alla andra, även media/bildtoken och profilernas sessioner (en profil kan byta tillbaka till kontot)
  run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=?1 OR parent_id=?1) AND token != ?2', c.user.id, c.user.tokenHash);
  audit('password_changed', ctx(c));
  send(c.res, 200, { ok: true });
});

// Tvåstegsverifiering
route('GET', '/api/me/2fa', user, (c) => {
  const u = get('SELECT totp_enabled, recovery FROM users WHERE id=?', c.user.id);
  let left = 0; try { left = JSON.parse(u.recovery || '[]').length; } catch {}
  send(c.res, 200, { enabled: !!u.totp_enabled, recoveryLeft: left, required: require2faRemote() });
});
route('POST', '/api/me/2fa/setup', user, (c) => {
  const secret = newTotpSecret();
  run('UPDATE users SET totp_pending=? WHERE id=?', secret, c.user.id);
  send(c.res, 200, { secret, uri: totpUri(secret, c.user.name) });
});
route('POST', '/api/me/2fa/enable', user, async (c) => {
  const { code, password, currentCode } = await readJson(c.req);
  const ip = clientIp(c.req);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund');
  const u = get('SELECT * FROM users WHERE id=?', c.user.id);
  if (!u.totp_pending) return fail(c.res, 400, 'Starta inställningen först');
  // Kräv lösenord – annars kan någon med en stulen session byta ut din tvåstegsverifiering
  if (!await checkPw(String(password || ''), u.pass)) { noteFail(ip, u.name); return fail(c.res, 400, 'Fel lösenord'); }
  if (u.totp_enabled && verifyTotp(u.totp_secret, currentCode, 0) < 0) return fail(c.res, 400, 'Ange en kod från din nuvarande autentiseringsapp');
  const step = verifyTotp(u.totp_pending, code, 0);
  if (step < 0) return fail(c.res, 400, 'Koden stämmer inte – kontrollera att klockan i telefonen går rätt');
  const rc = newRecoveryCodes();
  run('UPDATE users SET totp_secret=totp_pending, totp_pending=NULL, totp_enabled=1, totp_last=?, recovery=? WHERE id=?', step, JSON.stringify(rc.hashes), c.user.id);
  run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=?1 OR parent_id=?1) AND token != ?2', c.user.id, c.user.tokenHash);
  audit('2fa_enabled', ctx(c));
  send(c.res, 200, { ok: true, recoveryCodes: rc.codes });
});
route('POST', '/api/me/2fa/disable', user, async (c) => {
  const { password, code } = await readJson(c.req);
  const ip = clientIp(c.req);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund');
  const u = get('SELECT * FROM users WHERE id=?', c.user.id);
  if (!await checkPw(String(password || ''), u.pass)) { noteFail(ip, u.name); return fail(c.res, 400, 'Fel lösenord'); }
  if (u.totp_enabled && verifyTotp(u.totp_secret, code, 0) < 0 && !useRecoveryCode(u, code)) return fail(c.res, 400, 'Fel kod');
  run('UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_pending=NULL, recovery=NULL WHERE id=?', c.user.id);
  audit('2fa_disabled', ctx(c));
  send(c.res, 200, { ok: true });
});
route('POST', '/api/me/2fa/recovery', user, async (c) => {
  const { password } = await readJson(c.req);
  const u = get('SELECT * FROM users WHERE id=?', c.user.id);
  if (!u.totp_enabled) return fail(c.res, 400, 'Tvåstegsverifiering är inte aktiverad');
  if (ipBlocked(clientIp(c.req))) return fail(c.res, 429, 'För många försök – vänta en stund');
  if (!await checkPw(String(password || ''), u.pass)) { noteFail(clientIp(c.req), u.name); return fail(c.res, 400, 'Fel lösenord'); }
  const rc = newRecoveryCodes();
  run('UPDATE users SET recovery=? WHERE id=?', JSON.stringify(rc.hashes), u.id);
  audit('2fa_recovery_regenerated', ctx(c));
  send(c.res, 200, { recoveryCodes: rc.codes });
});

// Inloggade enheter
route('GET', '/api/me/sessions', user, (c) => send(c.res, 200, listSessions(c.user.id, c.user.tokenHash)));
route('DELETE', '/api/me/sessions/:sid', user, (c) => {
  run('DELETE FROM sessions WHERE rowid=? AND user_id=?', +c.p.sid, c.user.id);
  audit('session_revoked', ctx(c));
  send(c.res, 200, { ok: true });
});
route('POST', '/api/me/sessions/revoke-others', user, (c) => {
  run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=?1 OR parent_id=?1) AND token != ?2', c.user.id, c.user.tokenHash);
  audit('sessions_revoked_all', ctx(c));
  send(c.res, 200, { ok: true });
});

// ---------- Passkeys (WebAuthn) ----------
const hostOf = (req) => (isPrivate(req.socket.remoteAddress) && req.headers['x-forwarded-host']) || req.headers.host;
const rpFor = (req) => pk.rpOf(String(hostOf(req) || '').split(',')[0].trim(), getSetting('public_url', process.env.PUBLIC_URL || '') || null);
route('GET', '/api/me/passkeys', user, (c) => send(c.res, 200, pk.list(c.user.id)));
route('POST', '/api/me/passkeys/options', user, async (c) => {
  if (c.user.parent_id) return fail(c.res, 400, 'Passkeys läggs till på huvudkontot');
  const { password, code } = await readJson(c.req);
  const ip = clientIp(c.req);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund');
  const u = get('SELECT name, pass, totp_enabled, totp_secret FROM users WHERE id=?', c.user.id);
  if (!await checkPw(String(password || ''), u.pass)) { noteFail(ip, u.name); return fail(c.res, 401, 'Fel lösenord'); }
  // En passkey loggar in utan tvåstegskod – kräv koden när den läggs till, annars kringgår en stulen session 2FA
  if (u.totp_enabled && verifyTotp(u.totp_secret, code, 0) < 0) { noteFail(ip, u.name); return send(c.res, 401, { error: 'Ange koden från din autentiseringsapp', need2fa: true }); }
  send(c.res, 200, pk.registrationOptions(c.user, rpFor(c.req)));
});
route('POST', '/api/me/passkeys', user, async (c) => {
  const b = await readJson(c.req, 64 * 1024);
  try { pk.verifyRegistration(c.user, b, rpFor(c.req)); }
  catch (e) { audit('passkey_add_fail', { ...ctx(c), detail: e.message }); return fail(c.res, 400, e.message); }
  audit('passkey_added', { ...ctx(c), detail: String(b.name || '').slice(0, 60) });
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/me/passkeys/:kid', user, (c) => {
  const r = pk.remove(c.user.id, c.p.kid);
  if (r.changes) audit('passkey_removed', ctx(c));
  send(c.res, 200, { ok: true });
});
const pkRate = new Map(); // ip → { n, t }
setInterval(() => pkRate.clear(), 60e3).unref();
route('POST', '/api/passkey/options', pub, (c) => {
  // Räkna per /64 för IPv6; en full tabell rensas i stället för att neka alla
  const ip = clientIp(c.req), k = ipKey(ip);
  if (!pkRate.has(k) && pkRate.size >= 10000) pkRate.clear();
  const r = pkRate.get(k) || { n: 0 };
  if (++r.n > 30) return fail(c.res, 429, 'För många försök – vänta en stund och försök igen');
  pkRate.set(k, r);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund och försök igen');
  send(c.res, 200, pk.loginOptions(rpFor(c.req)));
});
route('POST', '/api/passkey/login', pub, async (c) => {
  const ip = clientIp(c.req);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund och försök igen');
  const b = await readJson(c.req, 64 * 1024);
  let uid;
  try { uid = pk.verifyLogin(b, rpFor(c.req)); }
  catch (e) { noteFail(ip); audit('login_fail', { ip, detail: 'passkey: ' + e.message }); return fail(c.res, 401, e.message); }
  const u = get('SELECT * FROM users WHERE id=?', uid);
  if (!u || u.parent_id) return fail(c.res, 401, 'Okänd passkey');
  if (!isTrusted(c.req) && !u.remote_allowed) { audit('login_denied', { ip, user: u, detail: 'fjärråtkomst ej tillåten' }); return fail(c.res, 403, 'Ditt konto får bara användas på hemnätverket'); }
  clearFails(u.name);
  audit('login_ok', { ip, user: u, detail: (b.app ? 'app' : 'webb') + ', passkey' });
  const meta = { ua: c.req.headers['user-agent'], ip };
  if (b.app) return send(c.res, 200, { ok: true, token: createSession(u.id, 'app', meta), user: { id: u.id, name: u.name, is_admin: u.is_admin } });
  const keep = b.remember !== false;
  send(c.res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(createSession(u.id, 'web', { ...meta, remember: keep }), isHttps(c.req), keep) });
});
// ---------- Profiler (hushåll) ----------
const profileOut = (p, rootId) => ({ id: p.id, name: p.name, owner: p.id === rootId, kid: p.max_age != null, maxAge: p.max_age, hasPin: !!p.pin, color: p.color || null });
route('GET', '/api/profiles', user, (c) => {
  const me = get('SELECT * FROM users WHERE id=?', c.user.id), root = householdRoot(me);
  const list = all('SELECT * FROM users WHERE id=? OR parent_id=? ORDER BY parent_id IS NOT NULL, name', root, root);
  send(c.res, 200, { current: c.user.id, profiles: list.map(p => profileOut(p, root)) });
});
route('POST', '/api/profiles', user, async (c) => {
  const me = get('SELECT * FROM users WHERE id=?', c.user.id), root = householdRoot(me);
  if (!canManage(c, root)) return fail(c.res, 403, 'Bara huvudkontot kan skapa profiler');
  const { name, maxAge, pin, color } = await readJson(c.req);
  const nm = String(name || '').trim().slice(0, 40);
  if (!nm) return fail(c.res, 400, 'Namn krävs');
  if (pin != null && pin !== '' && !/^\d{4,8}$/.test(String(pin))) return fail(c.res, 400, 'PIN ska vara 4–8 siffror');
  if (all('SELECT id FROM users WHERE parent_id=?', root).length >= 10) return fail(c.res, 400, 'Max 10 profiler per hushåll');
  const pass = await hashPw(crypto.randomBytes(24).toString('hex')); // profiler loggar aldrig in med lösenord
  try {
    run('INSERT INTO users(name,pass,is_admin,created,parent_id,pin,max_age,color,remote_allowed) VALUES(?,?,0,?,?,?,?,?,?)', nm, pass, now(), root,
      pin ? await hashPw(String(pin)) : null, maxAge === '' || maxAge == null ? null : Math.max(0, Math.min(18, parseInt(maxAge) || 0)), color ? String(color).slice(0, 20) : null,
      get('SELECT remote_allowed FROM users WHERE id=?', root).remote_allowed);
  } catch { return fail(c.res, 409, 'Namnet är upptaget'); }
  audit('profile_created', { ...ctx(c), detail: nm + (maxAge != null && maxAge !== '' ? ` (max ${maxAge} år)` : '') });
  send(c.res, 200, { ok: true });
});
route('PUT', '/api/profiles/:pid', user, async (c) => {
  const me = get('SELECT * FROM users WHERE id=?', c.user.id), root = householdRoot(me);
  const p = get('SELECT * FROM users WHERE id=?', +c.p.pid);
  if (!p || (p.id !== root && p.parent_id !== root)) return fail(c.res, 404, 'Finns inte');
  if (!canManage(c, root)) return fail(c.res, 403, 'Bara huvudkontot kan ändra profiler');
  const { name, maxAge, pin, color } = await readJson(c.req);
  if (name && p.id !== root) { try { run('UPDATE users SET name=? WHERE id=?', String(name).trim().slice(0, 40), p.id); } catch { return fail(c.res, 409, 'Namnet är upptaget'); } }
  if (maxAge !== undefined && p.id !== root) run('UPDATE users SET max_age=? WHERE id=?', maxAge === '' || maxAge == null ? null : Math.max(0, Math.min(18, parseInt(maxAge) || 0)), p.id);
  if (pin !== undefined) {
    if (pin && !/^\d{4,8}$/.test(String(pin))) return fail(c.res, 400, 'PIN ska vara 4–8 siffror');
    run('UPDATE users SET pin=? WHERE id=?', pin ? await hashPw(String(pin)) : null, p.id);
  }
  if (color !== undefined) run('UPDATE users SET color=? WHERE id=?', color ? String(color).slice(0, 20) : null, p.id);
  audit('profile_updated', { ...ctx(c), detail: p.name });
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/profiles/:pid', user, (c) => {
  const me = get('SELECT * FROM users WHERE id=?', c.user.id), root = householdRoot(me);
  const p = get('SELECT * FROM users WHERE id=? AND parent_id=?', +c.p.pid, root);
  if (!p) return fail(c.res, 404, 'Finns inte');
  if (!canManage(c, root)) return fail(c.res, 403, 'Bara huvudkontot kan ta bort profiler');
  run('DELETE FROM users WHERE id=?', p.id);
  audit('profile_deleted', { ...ctx(c), detail: p.name });
  send(c.res, 200, { ok: true });
});
route('POST', '/api/profiles/switch', user, async (c) => {
  const ip = clientIp(c.req);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund');
  const me = get('SELECT * FROM users WHERE id=?', c.user.id), root = householdRoot(me);
  const { id, pin, password } = await readJson(c.req);
  const t = get('SELECT * FROM users WHERE id=?', +id);
  if (!t || (t.id !== root && t.parent_id !== root)) return fail(c.res, 404, 'Profilen finns inte');
  if (t.id !== me.id) {
    if (userLocked(t.name) && !isTrusted(c.req)) { noteFail(ip); return fail(c.res, 429, 'För många försök – vänta en stund'); }
    if (t.pin) {
      if (!pin || !await checkPw(String(pin), t.pin)) { noteFail(ip, t.name); audit('profile_pin_fail', { ip, user: t }); return send(c.res, 401, { error: 'Fel PIN', needPin: true }); }
    } else if (me.max_age != null && (t.max_age == null || t.max_age > me.max_age)) {
      // Från en barnprofil till en profil med högre åldersgräns utan PIN: kräv huvudkontots lösenord
      const r = get('SELECT * FROM users WHERE id=?', root);
      if (!password || !await checkPw(String(password), r.pass)) { noteFail(ip, r.name); return send(c.res, 401, { error: 'Ange huvudkontots lösenord', needPassword: true }); }
    }
  }
  const meta = { ua: c.req.headers['user-agent'], ip };
  run('DELETE FROM sessions WHERE token=?', c.user.tokenHash);
  audit('profile_switched', { ip, user: t, detail: `från ${me.name}` });
  if (c.user.kind === 'app') return send(c.res, 200, { ok: true, token: createSession(t.id, 'app', meta), user: { id: t.id, name: t.name, is_admin: t.is_admin } });
  // Profilbyte behåller valet "Håll mig inloggad" från inloggningen
  const keep = c.user.remember !== 0;
  send(c.res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(createSession(t.id, 'web', { ...meta, remember: keep }), isHttps(c.req), keep) });
});
