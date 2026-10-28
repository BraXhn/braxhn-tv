// Status, första kontot, inloggning, lösenord, tvåstegsverifiering, sessioner, passkeys och profiler (hushåll).
import crypto from 'node:crypto';
import { get, getSetting, setSetting, run, now, all } from '../db.js';
import { send, fail, readJson, clientIp, isHttps, isPrivate } from '../util.js';
import { weakPassword, hashPw, audit, cookieHeader, createSession, ipBlocked, userLocked, noteFail, checkPw, dummyCheck, require2faRemote, verifyTotp, useRecoveryCode, clearFails, clearCookies, newTotpSecret, totpUri, newRecoveryCodes, listSessions, ipKey,
  quickConnectOn, qcCreate, qcFind, qcFindCode, qcApprove, qcRemove, QC_TTL } from '../auth.js';
import { hasTmdb } from '../scanner.js';
import * as pk from '../passkeys.js';
import * as updates from '../updates.js';
import { VERSION } from '../updates.js';
import * as screen from '../screentime.js';
import { revokeHousehold as revokeSubsonicHousehold } from '../subsonic.js';
import * as invites from '../invites.js';
import { kidsHaveChannels } from '../iptv/channels.js';
import { vodAllowed } from '../iptv/vod.js';
import * as family from '../familyfilter.js';
import * as sso from '../sso.js';
import { route, pub, isTrusted, adminAnywhere, user, has2fa } from '../http/router.js';
import { ctx, householdRoot, canManage, setupPending, canDownload } from '../http/context.js';

// Hälsokontroll (Docker HEALTHCHECK): databasen måste svara, annars startas containern om
route('GET', '/api/health', pub, (c) => {
  try { get('SELECT 1'); } catch (e) { return send(c.res, 503, { ok: false, error: 'Databasen svarar inte' }); }
  send(c.res, 200, { ok: true });
});
// API-version för apparna (docs/api.md): höjs bara om något som installerade appar läser måste ändras.
// Inom samma version får fält bara läggas till – test/api-contract.test.js kontrollerar det apparna avkodar.
const API_VERSION = 1;
route('GET', '/api/status', pub, (c) => send(c.res, 200, {
  api: API_VERSION,
  // Avslöja inte för utomstående att servern är nyinstallerad
  needsSetup: isTrusted(c.req) && !get('SELECT 1 FROM users LIMIT 1'), version: VERSION, name: 'BraXhn TV',
  // Utanför hemmet: webbspelaren mäter då uppkopplingen och anpassar kvaliteten
  remote: c.user ? !isPrivate(clientIp(c.req)) : undefined,
  publicUrl: getSetting('public_url', process.env.PUBLIC_URL || '') || null,
  quickConnect: quickConnectOn(), // "Logga in med kod" på inloggningssidan
  user: c.user ? { id: c.user.id, name: c.user.name, is_admin: c.user.is_admin, totp: !!c.user.totp_enabled,
    profiles: get('SELECT COUNT(*) AS n FROM users WHERE id=? OR parent_id=?', c.user.parent_id || c.user.id, c.user.parent_id || c.user.id).n,
    kid: c.user.max_age != null, maxAge: c.user.max_age ?? null,
    // Webbklientens språk (nytt fält): 'sv' | 'en', null = inte valt (svenska; sätts från webbläsaren vid första inloggningen)
    lang: c.user.lang || null,
    // Rättigheter per användare (perms.js): webben döljer nedladdning när den inte är tillåten (nytt fält)
    canDownload: canDownload(c.user.id),
    adminHere: !!c.user.is_admin && (adminAnywhere() || isTrusted(c.req)),
    // Installationsguiden är inte klar: startsidan visar "Slutför installationen" (bara för administratörer som får administrera här)
    setupPending: !!c.user.is_admin && (adminAnywhere() || isTrusted(c.req)) && setupPending(),
    update: c.user.is_admin && updates.info().available ? updates.state.latest : null,
    streaming: c.user.max_age == null && hasTmdb(), screenTime: screen.status(c.user.id),
    liveTv: c.user.max_age == null ? !!get('SELECT 1 FROM channels c JOIN tuners t ON t.id=c.tuner_id WHERE t.enabled=1 AND c.hidden=0 LIMIT 1') : kidsHaveChannels(c.user),
    iptvVod: !!get("SELECT 1 FROM iptv_vod v JOIN tuners t ON t.id=v.tuner_id WHERE t.enabled=1 LIMIT 1") && vodAllowed(c.user) } : null
}));
// Webbklientens språk för profilen (Mitt konto → Språk). Sidan (index.html) väljs efter det, se pageLang i http/router.js.
route('PUT', '/api/me/lang', user, async (c) => {
  const { lang } = await readJson(c.req);
  if (!['sv', 'en'].includes(lang)) return fail(c.res, 400, 'Okänt språk');
  run('UPDATE users SET lang=? WHERE id=?', lang, c.user.id);
  send(c.res, 200, { ok: true, lang });
});
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
  setSetting('setup_done', '0'); // installationsguiden (#/setup) väntar
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
  let u = u0 && !u0.parent_id ? u0 : null; // profiler nås bara via profilbyte i sitt hushåll
  let ok = u ? await checkPw(String(password || ''), u.pass) : await dummyCheck(String(password || ''));
  // Enkel inloggning (sso.js): "bara administratörer med lösenord" – andra loggar in via leverantören (LDAP nedan eller
  // "Logga in med …"). Administratörernas lokala lösenord fungerar alltid (reservinloggning).
  const adminOnly = ok && !u.is_admin && sso.localLogin() === 'admin';
  if (adminOnly) ok = false;
  // LDAP: samma formulär. Lokala konton provas först; ett lokalt konto tas aldrig över av en LDAP-användare med samma
  // namn – då krävs bekräftelse med det lokala lösenordet (biljett, #/login/link/…).
  let via = null, ldapDown = false;
  if (!ok && uname && password && sso.ldapProviders().length) {
    const l = await sso.ldapLogin(uname, String(password));
    if (l?.id) {
      const r = await sso.resolve(l.p, l.id, { hashPw: () => hashPw(crypto.randomBytes(24).toString('hex')), remember: remember !== false, app: !!app });
      if (r.deny) { audit('login_denied', { ip, user: { name: uname }, detail: `${l.p.name}: ${r.deny}` }); return fail(c.res, 403, r.deny); }
      if (r.ticket) { audit('sso_link_pending', { ip, user: { name: r.account }, detail: l.p.name }); return send(c.res, 409, { error: 'Det finns redan ett konto med samma namn', needLink: true, ticket: r.ticket, account: r.account, provider: l.p.name }); }
      if (r.created) audit('sso_user_created', { ip, user: get('SELECT id, name FROM users WHERE id=?', r.uid), detail: l.p.name });
      u = get('SELECT * FROM users WHERE id=?', r.uid); ok = !!u; via = l.p.name;
    } else if (l?.error) ldapDown = true;
  }
  if (!ok && adminOnly) { audit('login_denied', { ip, user: u0, detail: 'lösenord bara för administratörer' }); return fail(c.res, 403, 'Logga in med enkel inloggning – lösenordsinloggning är bara för administratörer'); }
  if (!ok) {
    const locked = noteFail(ip, isTrusted(c.req) ? null : uname);
    audit('login_fail', { ip, user: { id: u?.id, name: uname }, detail: locked ? 'kontot spärrat tillfälligt för inloggning utifrån' : ldapDown ? 'LDAP-servern svarar inte' : null });
    if (ldapDown && !u) return fail(c.res, 503, 'Inloggningen via katalogtjänsten (LDAP) fungerar inte just nu – försök igen om en stund');
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
  audit('login_ok', { ip, user: u, detail: (app ? 'app' : 'webb') + (via ? ', ' + via : '') });
  const meta = { ua: c.req.headers['user-agent'], ip };
  const pwOld = !via && weakPassword(password, u.name) ? true : false; // LDAP-lösenordet ägs av katalogen

  if (app) return send(c.res, 200, { ok: true, token: createSession(u.id, 'app', meta), user: { id: u.id, name: u.name, is_admin: u.is_admin }, weakPassword: pwOld });
  const keep = remember !== false; // äldre klienter skickar inget: håll inloggad som förut
  send(c.res, 200, { ok: true, weakPassword: pwOld }, { 'Set-Cookie': cookieHeader(createSession(u.id, 'web', { ...meta, remember: keep }), isHttps(c.req), keep) });
});
// ---------- Inbjudningslänkar (server/invites.js) ----------
// Länken <adress>/#/invite/<token> öppnar webbens vy för att skapa konto. Gissning spärras som inloggning (ipBlocked/noteFail):
// ogiltig, använd och utgången inbjudan ger samma svar. Kontot får inbjudans rättigheter och blir aldrig administratör.
const inviteGone = (c, ip) => { noteFail(ip); audit('invite_invalid', { ip }); return fail(c.res, 404, 'Inbjudan är ogiltig, redan använd eller har gått ut'); };
route('GET', '/api/invite/:token', pub, (c) => {
  const ip = clientIp(c.req);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund och försök igen');
  const r = invites.find(c.p.token);
  if (!r) return inviteGone(c, ip);
  const p = invites.normPerms(JSON.parse(r.perms || '{}'));
  send(c.res, 200, { valid: true, expires: r.expires, name: 'BraXhn TV', homeOnly: !p.remoteAllowed, atHome: isTrusted(c.req) });
});
route('POST', '/api/invite/:token', pub, async (c) => {
  const ip = clientIp(c.req);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund och försök igen');
  const r = invites.find(c.p.token);
  if (!r) return inviteGone(c, ip);
  const { name, password, app, remember } = await readJson(c.req);
  const nm = String(name || '').replace(/[\u0000-\u001f]/g, '').trim();
  if (!nm || nm.length > 64) return fail(c.res, 400, 'Ange ett namn (högst 64 tecken)');
  const weak = weakPassword(password, nm); if (weak) return fail(c.res, 400, weak);
  const p = invites.normPerms(JSON.parse(r.perms || '{}'));
  const remote = !isTrusted(c.req);
  if (remote && !p.remoteAllowed) return fail(c.res, 403, 'Den här inbjudan gäller bara hemnätverket – öppna länken hemma');
  if (remote && require2faRemote()) return fail(c.res, 403, 'Servern kräver tvåstegsverifiering utanför hemmet – öppna länken hemma och aktivera den under Mitt konto');
  let uid;
  try { uid = invites.accept(c.p.token, nm, await hashPw(String(password))); }
  catch (e) { if (e.status === 410) return inviteGone(c, ip); return fail(c.res, e.status || 400, e.message); }
  audit('invite_used', { ip, user: { id: uid, name: nm }, detail: r.note || null });
  const meta = { ua: c.req.headers['user-agent'], ip };
  if (app) return send(c.res, 200, { ok: true, token: createSession(uid, 'app', meta), user: { id: uid, name: nm, is_admin: 0 } });
  const keep = remember !== false;
  send(c.res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(createSession(uid, 'web', { ...meta, remember: keep }), isHttps(c.req), keep) });
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
  // Lösenord för musikappar (hushållets) återkallas också – nytt lösenord betyder ofta att det gamla läckt
  revokeSubsonicHousehold(c.user.parent_id || c.user.id);
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
  // Lösenord för musikappar (hushållets) återkallas också – nytt lösenord betyder ofta att det gamla läckt
  revokeSubsonicHousehold(c.user.parent_id || c.user.id);
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
  // Lösenord för musikappar (hushållets) återkallas också – nytt lösenord betyder ofta att det gamla läckt
  revokeSubsonicHousehold(c.user.parent_id || c.user.id);
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
// ---------- Snabbinloggning med kod (TV-enheter, som Jellyfins Quick Connect) ----------
// 1. Enheten: POST /api/quickconnect → { secret, code }. Koden visas på TV:n, nyckeln behåller enheten.
// 2. Inloggad användare: POST /api/quickconnect/approve { code } visar enhet och IP, { code, confirm: true } godkänner
//    för den aktuella profilen (barnprofil → barnprofilens åldersgräns).
// 3. Enheten pollar GET /api/quickconnect/:secret tills status är approved (token eller kaka, exakt en gång) eller expired.
// Samma regler som /api/login: konton utan fjärråtkomst och krav på tvåstegsverifiering utifrån gäller även här.
const qcRate = new Map(); // ip → antal nya begäranden de senaste 10 minuterna
const qcFails = new Map(); // användar-id → tider för felaktiga koder
setInterval(() => qcRate.clear(), 600e3).unref();
const QC_OFF = 'Inloggning med kod är avstängd på servern';
/** Varför kontot inte får loggas in på enheten (samma regler som inloggning och routern), annars null. */
function qcDenied(u, trusted) {
  if (trusted) return null;
  if (!u.remote_allowed) return 'Ditt konto får bara användas på hemnätverket';
  // Samma 2FA-regel som routern (has2fa: TOTP, huvudkontots TOTP, passkey eller leverantör som sköter 2FA)
  if (require2faRemote() && !has2fa(u)) return 'Tvåstegsverifiering krävs för inloggning utanför hemmet. Aktivera den under Mitt konto från hemnätet.';
  return null;
}
const qcInfo = (r) => ({ name: r.name, device: r.device, ip: r.ip, created: r.created, expires: r.expires });
route('POST', '/api/quickconnect', pub, async (c) => {
  if (!quickConnectOn()) return fail(c.res, 403, QC_OFF);
  const ip = clientIp(c.req), k = ipKey(ip);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund och försök igen');
  if (!qcRate.has(k) && qcRate.size >= 10000) qcRate.clear();
  const n = (qcRate.get(k) || 0) + 1;
  if (n > 20) return fail(c.res, 429, 'För många försök – vänta en stund och försök igen');
  qcRate.set(k, n);
  const b = await readJson(c.req);
  const r = qcCreate({ ip, trusted: isTrusted(c.req), name: b.name, device: b.device, app: !!b.app, remember: b.remember });
  if (!r) return fail(c.res, 503, 'Servern är upptagen – försök igen om en stund');
  send(c.res, 200, { ...r, ttl: QC_TTL, interval: 3 });
});
route('POST', '/api/quickconnect/approve', user, async (c) => {
  if (!quickConnectOn()) return fail(c.res, 403, QC_OFF);
  const ip = clientIp(c.req);
  const tooMany = () => fail(c.res, 429, 'För många felaktiga koder – vänta en stund och försök igen');
  if (ipBlocked(ip)) return tooMany();
  const fails = (qcFails.get(c.user.id) || []).filter(t => Date.now() - t < 600e3);
  if (fails.length >= 5) return tooMany();
  const { code, confirm } = await readJson(c.req);
  const r = qcFindCode(code);
  if (!r) {
    // Felaktiga koder räknas både per användare och per IP (skydd mot att gissa sex siffror)
    qcFails.set(c.user.id, [...fails, Date.now()]); noteFail(ip);
    audit('quickconnect_fail', { ...ctx(c), detail: 'fel eller utgången kod' });
    return fail(c.res, 404, 'Koden finns inte eller har gått ut – kontrollera siffrorna på TV:n');
  }
  const u = get('SELECT * FROM users WHERE id=?', c.user.id);
  const denied = qcDenied(u, r.trusted);
  if (denied) { audit('quickconnect_denied', { ...ctx(c), detail: `${r.name || 'okänd enhet'} från ${r.ip}: ${denied}` }); return fail(c.res, 403, denied); }
  if (confirm !== true) return send(c.res, 200, { ok: true, approved: false, ...qcInfo(r), profile: u.name });
  qcApprove(r, u.id, ip);
  qcFails.delete(c.user.id);
  audit('quickconnect_approved', { ...ctx(c), detail: `${r.name || 'okänd enhet'}${r.device ? ' (' + r.device + ')' : ''} från ${r.ip}` });
  send(c.res, 200, { ok: true, approved: true, ...qcInfo(r), profile: u.name });
});
route('GET', '/api/quickconnect/:secret', pub, (c) => {
  if (!quickConnectOn()) return fail(c.res, 403, QC_OFF);
  const r = qcFind(c.p.secret);
  if (!r) return send(c.res, 200, { status: 'expired' });
  // Kakan för webben sätts bara för ett anrop från sidan själv (inte via en länk eller bild från en annan webbplats)
  if (!r.app) {
    const site = c.req.headers['sec-fetch-site'];
    if (c.req.headers['x-requested-with'] !== 'BraXhnTV' || (site && site !== 'same-origin')) return fail(c.res, 403, 'Förfrågan från annan webbplats nekades');
  }
  if (!r.userId) return send(c.res, 200, { status: 'pending', expires: r.expires });
  const ip = clientIp(c.req);
  const u = get('SELECT * FROM users WHERE id=?', r.userId);
  if (!u) { qcRemove(r); return send(c.res, 200, { status: 'expired' }); }
  // Enheten får inte ha bytt till ett nät utanför hemmet sedan begäran skapades
  const denied = qcDenied(u, r.trusted && isTrusted(c.req));
  if (denied) { qcRemove(r); audit('login_denied', { ip, user: u, detail: 'kod: ' + denied }); return fail(c.res, 403, denied); }
  qcRemove(r); // token lämnas ut exakt en gång
  audit('login_ok', { ip, user: u, detail: (r.app ? 'app' : 'webb') + ', kod' + (r.name ? ' – ' + r.name : '') });
  const meta = { ua: c.req.headers['user-agent'], ip };
  const out = { status: 'approved', ok: true };
  if (r.app) return send(c.res, 200, { ...out, token: createSession(u.id, 'app', meta), user: { id: u.id, name: u.name, is_admin: u.is_admin } });
  send(c.res, 200, out, { 'Set-Cookie': cookieHeader(createSession(u.id, 'web', { ...meta, remember: r.remember }), isHttps(c.req), r.remember) });
});

// ---------- Profiler (hushåll) ----------
// familyFilter = profilens val ('' = standard), familyMode = läget som gäller (familyfilter.js)
const profileOut = (p, rootId) => ({ id: p.id, name: p.name, owner: p.id === rootId, kid: p.max_age != null, maxAge: p.max_age, hasPin: !!p.pin, color: p.color || null,
  familyFilter: family.settingOf(p), familyMode: family.modeFor(p) });
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
  const { name, maxAge, pin, color, familyFilter } = await readJson(c.req);
  if (familyFilter !== undefined && familyFilter !== null && familyFilter !== '' && !family.MODES.includes(familyFilter)) return fail(c.res, 400, 'Ogiltigt läge för familjefiltret');
  if (name && p.id !== root) { try { run('UPDATE users SET name=? WHERE id=?', String(name).trim().slice(0, 40), p.id); } catch { return fail(c.res, 409, 'Namnet är upptaget'); } }
  if (maxAge !== undefined && p.id !== root) run('UPDATE users SET max_age=? WHERE id=?', maxAge === '' || maxAge == null ? null : Math.max(0, Math.min(18, parseInt(maxAge) || 0)), p.id);
  if (pin !== undefined) {
    if (pin && !/^\d{4,8}$/.test(String(pin))) return fail(c.res, 400, 'PIN ska vara 4–8 siffror');
    run('UPDATE users SET pin=? WHERE id=?', pin ? await hashPw(String(pin)) : null, p.id);
  }
  if (color !== undefined) run('UPDATE users SET color=? WHERE id=?', color ? String(color).slice(0, 20) : null, p.id);
  if (familyFilter !== undefined) family.setMode(p.id, familyFilter || '');
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
