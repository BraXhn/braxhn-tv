import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, all, run, now, getSetting, setSetting, IMAGES, RESTORE_FILE } from './db.js';
import { send, fail, readJson, MIME, clientIp, peerIp, isLocalReq, isHttps, isPrivate, inCidr } from './util.js';
import { hashPw, checkPw, dummyCheck, weakPassword, createSession, cookieHeader, userFromReq, listSessions, ipBlocked, userLocked, noteFail,
  clearFails, auditHooks, newTotpSecret, totpUri, verifyTotp, newRecoveryCodes, useRecoveryCode, audit, require2faRemote, clearCookies } from './auth.js';
import { scan, status as scanStatus, refreshItem, extractThumb, removeImages, hooks, tmdbSearch, autoSubs, readChapters, tvdbOf, hasTmdb } from './scanner.js';
import * as st from './stream.js';
import * as os from './opensubtitles.js';
import { detectMarkers } from './intro.js';
import * as act from './activity.js';
import * as trick from './trickplay.js';
import * as music from './music.js';
import * as party from './party.js';
import * as offline from './offline.js';
import * as acme from './acme.js';
import * as pk from './passkeys.js';
import * as notifier from './notify.js';
import * as updates from './updates.js';
import * as offsite from './offsite.js';
import * as arr from './arr.js';
import * as trakt from './trakt.js';
import * as books from './audiobooks.js';
import * as pods from './podcasts.js';

hooks.keyframes = (it) => st.computeKeyframes(it);
hooks.markers = (lib, status) => detectMarkers(lib, status);
hooks.trickplay = (lib, status) => trick.generateLibrary(lib, status);
hooks.music = (lib, status) => music.scanMusic(lib, status);
hooks.subtitlesOf = (it) => st.subtitlesOf(it);
hooks.afterScan = () => arr.markAvailable();
hooks.audiobooks = (lib, status) => books.scanBooks(lib, status);

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/media');
import { VERSION } from './updates.js';

// ---------- formning av objekt ----------
const PROG = `p.position AS p_pos, p.watched AS p_watched, p.updated AS p_updated,
  (SELECT COUNT(*) FROM items e WHERE e.parent_id=i.id) AS ep_total,
  (SELECT COUNT(*) FROM items e JOIN progress q ON q.item_id=e.id AND q.user_id=p_uid.uid AND q.watched=1 WHERE e.parent_id=i.id) AS ep_watched`;
const FROM = `FROM items i JOIN (SELECT ? AS uid) p_uid LEFT JOIN progress p ON p.item_id=i.id AND p.user_id=p_uid.uid`;

const chaptersOf = (it) => { try { return JSON.parse(it.chapters || '[]'); } catch { return []; } };
function shape(r) {
  const o = {
    id: r.id, kind: r.kind, title: r.title, year: r.year, library: r.library_id,
    poster: !!r.poster, backdrop: !!r.backdrop, thumb: !!r.thumb,
    duration: r.duration, rating: r.rating, overview: r.overview, added: r.added, hdr: r.hdr || null,
    genres: (() => { try { return JSON.parse(r.genres || '[]'); } catch { return []; } })(), cert: r.cert || null, age: r.age ?? null,
    collection: r.collection_id || null
  };
  if (r.kind === 'episode') Object.assign(o, { season: r.season, episode: r.episode, show: r.parent_id, showTitle: r.show_title });
  if (r.kind === 'show') Object.assign(o, { episodes: r.ep_total, watchedEpisodes: r.ep_watched, watched: r.ep_total > 0 && r.ep_total === r.ep_watched });
  else Object.assign(o, { position: r.p_pos || 0, watched: !!r.p_watched, height: r.height,
    intro: r.intro_end ? { start: r.intro_start || 0, end: r.intro_end } : null, credits: r.credits_start || null,
    recap: r.recap_end ? { start: r.recap_start || 0, end: r.recap_end } : null, trickplay: r.trickplay === 1 });
  return o;
}
// ---------- åldersgräns för profiler ----------
const allowUnrated = () => getSetting('allow_unrated', '0') === '1';
const maxAgeOf = (uid) => get('SELECT max_age FROM users WHERE id=?', uid)?.max_age ?? null;
/** Får användaren se titeln? Avsnitt ärver seriens åldersgräns. Okänd ålder döljs för begränsade profiler. */
function allowedFor(uid, it) {
  const max = maxAgeOf(uid);
  if (max == null || !it) return true;
  let age = it.age;
  if (age == null && it.parent_id) age = get('SELECT age FROM items WHERE id=?', it.parent_id)?.age;
  return age == null ? allowUnrated() : age <= max;
}
const listItems = (uid, where, params = [], order = 'i.sort_title', limit = 500, offset = 0) => {
  const max = maxAgeOf(uid);
  const ageSql = max == null ? '' : ` AND COALESCE(i.age, s.age, ?) <= ?`;
  const ageParams = max == null ? [] : [allowUnrated() ? max : 999, max];
  return all(`SELECT i.*, s.title AS show_title, ${PROG} ${FROM} LEFT JOIN items s ON s.id=i.parent_id WHERE (${where})${ageSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    uid, ...params, ...ageParams, limit, offset).map(shape);
};
const oneItem = (uid, id) => listItems(uid, 'i.id=?', [id], 'i.id', 1)[0];

function insideMedia(p) {
  try { const r = fs.realpathSync(p); return r === MEDIA_ROOT || r.startsWith(MEDIA_ROOT + path.sep) ? r : null; }
  catch { return null; }
}

// ---------- routing ----------
const routes = [];
const route = (method, pattern, opts, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, fn, ...opts });
};
const pub = { auth: false }, user = { auth: true }, admin = { auth: true, admin: true };
const media = { auth: true, media: true }; // strömmar: tillåter kortlivad mediatoken (?t=) för just den titeln
const img = { auth: true, img: true };     // bilder: tillåter bildtoken (?t=) för appar
const audio = { auth: true, media: true, music: true }; // musikströmmar: mediatoken för just det spåret

// ---------- betrodda nätverk ----------
// Hemnät (RFC1918), VPN/CGNAT (100.64.0.0/10, t.ex. NetBird/Tailscale) och egna nät i inställningarna
function trustedNets() {
  return [...String(getSetting('trusted_networks', '')).split(','), ...String(process.env.TRUSTED_NETWORKS || '').split(',')].map(s => s.trim()).filter(Boolean);
}
// 100.64.0.0/10 (CGNAT/VPN) är avstängt som standard: hos vissa operatörer kan andra kunder nå dig från det nätet.
// NetBird/Tailscale-routing via OPNsense maskerar normalt till en LAN-adress och behöver det inte.
const trustVpn = () => getSetting('trust_vpn_range', process.env.TRUST_VPN_RANGE || '0') === '1';
const isTrusted = (req) => { const ip = clientIp(req); return isPrivate(ip) || (trustVpn() && inCidr(ip, '100.64.0.0/10')) || trustedNets().some(n => inCidr(ip, n)); };
const adminAnywhere = () => getSetting('admin_anywhere', process.env.ADMIN_ANYWHERE || '0') === '1';
const ctx = (c) => ({ user: c.user, ip: clientIp(c.req) });

route('GET', '/api/health', pub, (c) => send(c.res, 200, { ok: true }));
route('GET', '/api/status', pub, (c) => send(c.res, 200, {
  // Avslöja inte för utomstående att servern är nyinstallerad
  needsSetup: isTrusted(c.req) && !get('SELECT 1 FROM users LIMIT 1'), version: VERSION, name: 'BraXhn TV',
  publicUrl: getSetting('public_url', process.env.PUBLIC_URL || '') || null,
  user: c.user ? { id: c.user.id, name: c.user.name, is_admin: c.user.is_admin, totp: !!c.user.totp_enabled,
    profiles: get('SELECT COUNT(*) AS n FROM users WHERE id=? OR parent_id=?', c.user.parent_id || c.user.id, c.user.parent_id || c.user.id).n,
    kid: c.user.max_age != null, maxAge: c.user.max_age ?? null,
    adminHere: !!c.user.is_admin && (adminAnywhere() || isTrusted(c.req)),
    update: c.user.is_admin && updates.info().available ? updates.state.latest : null } : null
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
  const { name, password, app, code } = await readJson(c.req);
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
  send(c.res, 200, { ok: true, weakPassword: pwOld }, { 'Set-Cookie': cookieHeader(createSession(u.id, 'web', meta), isHttps(c.req)) });
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
  run('DELETE FROM sessions WHERE user_id=? AND token != ?', c.user.id, c.user.tokenHash); // alla andra, även media/bildtoken
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
  run('DELETE FROM sessions WHERE user_id=? AND token != ?', c.user.id, c.user.tokenHash);
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
  run('DELETE FROM sessions WHERE user_id=? AND token != ?', c.user.id, c.user.tokenHash);
  audit('sessions_revoked_all', ctx(c));
  send(c.res, 200, { ok: true });
});

// ---------- Passkeys (WebAuthn) ----------
const hostOf = (req) => (isPrivate(req.socket.remoteAddress) && req.headers['x-forwarded-host']) || req.headers.host;
const rpFor = (req) => pk.rpOf(String(hostOf(req) || '').split(',')[0].trim(), getSetting('public_url', process.env.PUBLIC_URL || '') || null);
route('GET', '/api/me/passkeys', user, (c) => send(c.res, 200, pk.list(c.user.id)));
route('POST', '/api/me/passkeys/options', user, async (c) => {
  if (c.user.parent_id) return fail(c.res, 400, 'Passkeys läggs till på huvudkontot');
  const { password } = await readJson(c.req);
  const u = get('SELECT pass FROM users WHERE id=?', c.user.id);
  if (!await checkPw(String(password || ''), u.pass)) return fail(c.res, 401, 'Fel lösenord');
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
route('POST', '/api/passkey/options', pub, (c) => {
  if (ipBlocked(clientIp(c.req))) return fail(c.res, 429, 'För många försök – vänta en stund och försök igen');
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
  send(c.res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(createSession(u.id, 'web', meta), isHttps(c.req)) });
});

// ---------- Let's Encrypt ----------
const reloadTls = () => globalThis.__braxhnReloadTls?.();
route('GET', '/api/acme', admin, (c) => send(c.res, 200, {
  domain: getSetting('acme_domain', process.env.ACME_DOMAIN || ''), email: getSetting('acme_email', process.env.ACME_EMAIL || ''),
  staging: getSetting('acme_staging', '0') === '1', auto: getSetting('acme_auto', '1') === '1',
  running: acme.state.running, log: acme.state.log, error: acme.state.error, cert: acme.certInfo(), httpsPort: +process.env.HTTPS_PORT || 8443
}));
route('PUT', '/api/acme', admin, async (c) => {
  const b = await readJson(c.req);
  if (typeof b.domain === 'string') {
    const d = b.domain.trim().toLowerCase();
    if (d && !/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(d)) return fail(c.res, 400, 'Ange en giltig domän, t.ex. tv.dindomän.se');
    setSetting('acme_domain', d);
  }
  if (typeof b.email === 'string') {
    const e = b.email.trim();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return fail(c.res, 400, 'Ogiltig e-postadress');
    setSetting('acme_email', e);
  }
  if (b.staging != null) setSetting('acme_staging', b.staging ? '1' : '0');
  if (b.auto != null) setSetting('acme_auto', b.auto ? '1' : '0');
  audit('settings_changed', { ...ctx(c), detail: 'acme' });
  send(c.res, 200, { ok: true });
});
route('POST', '/api/acme/obtain', admin, (c) => {
  if (acme.state.running) return fail(c.res, 409, 'Pågår redan');
  audit('acme_obtain', ctx(c));
  acme.obtain(reloadTls).catch(() => {});
  send(c.res, 202, { ok: true });
});

// Bibliotek
route('GET', '/api/libraries', user, (c) => send(c.res, 200, all(`SELECT l.*,
  CASE WHEN l.type='music' THEN (SELECT COUNT(*) FROM albums a WHERE a.library_id=l.id)
  WHEN l.type='audiobook' THEN (SELECT COUNT(*) FROM books b WHERE b.library_id=l.id)
  ELSE (SELECT COUNT(*) FROM items i WHERE i.library_id=l.id AND i.kind IN('movie','show')) END AS count FROM libraries l ORDER BY l.type IN ('music','audiobook'), l.type, l.name`)));
route('POST', '/api/libraries', admin, async (c) => {
  const { name, type, path: p, anime } = await readJson(c.req);
  const real = insideMedia(String(p || ''));
  if (!name?.trim() || !['movie', 'show', 'music', 'audiobook'].includes(type)) return fail(c.res, 400, 'Namn och typ krävs');
  if (!real) return fail(c.res, 400, `Sökvägen måste finnas och ligga under ${MEDIA_ROOT}`);
  const id = Number(run('INSERT INTO libraries(name,type,path,anime) VALUES(?,?,?,?)', name.trim(), type, real, anime && type === 'show' ? 1 : 0).lastInsertRowid);
  audit('library_added', { ...ctx(c), detail: `${name.trim()} (${real})` });
  act.watchLibraries(scan);
  scan(id);
  send(c.res, 200, { id });
});
route('DELETE', '/api/libraries/:id', admin, (c) => {
  for (const r of all('SELECT id FROM items WHERE library_id=?', c.p.id)) removeImages(r.id);
  audit('library_removed', { ...ctx(c), detail: get('SELECT name FROM libraries WHERE id=?', c.p.id)?.name });
  run('DELETE FROM libraries WHERE id=?', c.p.id);
  act.watchLibraries(scan);
  send(c.res, 200, { ok: true });
});
route('POST', '/api/libraries/:id/scan', admin, (c) => { scan(+c.p.id); send(c.res, 200, { ok: true }); });
route('POST', '/api/scan', admin, (c) => { scan(); send(c.res, 200, { ok: true }); });
route('GET', '/api/scan', user, (c) => send(c.res, 200, scanStatus));
route('GET', '/api/fs', admin, (c) => {
  const p = insideMedia(c.q.get('path') || MEDIA_ROOT);
  if (!p) return fail(c.res, 400, 'Ogiltig sökväg');
  let dirs = [];
  try { dirs = fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort(); } catch {}
  send(c.res, 200, { path: p, parent: p === MEDIA_ROOT ? null : path.dirname(p), dirs });
});

// Bläddra
route('GET', '/api/home', user, (c) => {
  const uid = c.user.id;
  const cont = listItems(uid, `i.kind IN('movie','episode') AND p.position > 0 AND p.watched=0`, [], 'p.updated DESC', 20);
  // "Nästa avsnitt" för serier man håller på med
  const shows = all(`SELECT e.parent_id AS sid, MAX(p.updated) AS t FROM progress p JOIN items e ON e.id=p.item_id
    WHERE p.user_id=? AND e.kind='episode' GROUP BY e.parent_id ORDER BY t DESC LIMIT 20`, uid);
  const have = new Set(cont.map(x => x.show).filter(Boolean));
  for (const s of shows) {
    if (have.has(s.sid)) continue;
    const next = listItems(uid, `i.parent_id=? AND COALESCE(p.watched,0)=0 AND (i.season*10000+i.episode) > COALESCE(
      (SELECT MAX(e.season*10000+e.episode) FROM items e JOIN progress q ON q.item_id=e.id AND q.user_id=p_uid.uid AND q.watched=1 WHERE e.parent_id=i.parent_id),-1)`,
      [s.sid], 'i.season, i.episode', 1)[0];
    if (next) cont.push(next);
  }
  const rows = all("SELECT * FROM libraries WHERE type != 'music' ORDER BY name").map(l => ({
    library: l, title: `Nytt i ${l.name}`,
    items: listItems(uid, `i.library_id=? AND i.kind=?`, [l.id, l.type], 'i.added DESC', 24)
  }));
  const watchlist = listItems(uid, 'i.id IN (SELECT item_id FROM watchlist WHERE user_id=p_uid.uid)', [], '(SELECT added FROM watchlist w WHERE w.user_id=p_uid.uid AND w.item_id=i.id) DESC', 30);
  const recommended = recommend(uid, 20);
  send(c.res, 200, { continue: cont, rows, watchlist, recommended });
});
const SORTS = { title: 'i.sort_title', added: 'i.added DESC', year: 'i.year DESC, i.sort_title', rating: 'i.rating DESC NULLS LAST, i.sort_title' };
route('GET', '/api/libraries/:id/items', user, (c) => {
  const lib = get('SELECT * FROM libraries WHERE id=?', c.p.id);
  if (!lib) return fail(c.res, 404, 'Biblioteket finns inte');
  const where = [`i.library_id=?`, `i.kind=?`], params = [lib.id, lib.type];
  const filter = c.q.get('filter');
  if (filter === 'unwatched') where.push(lib.type === 'show' ? 'ep_watched < ep_total' : 'COALESCE(p.watched,0)=0');
  if (filter === 'watched') where.push(lib.type === 'show' ? 'ep_watched = ep_total' : 'p.watched=1');
  send(c.res, 200, { library: lib, items: listItems(c.user.id, where.join(' AND '), params, SORTS[c.q.get('sort')] || SORTS.title, 5000) });
});
route('GET', '/api/search', user, (c) => {
  const q = `%${(c.q.get('q') || '').trim()}%`;
  if (q.length < 3) return send(c.res, 200, []);
  send(c.res, 200, listItems(c.user.id, `(i.title LIKE ? OR (i.kind='show' AND i.overview LIKE ?))`, [q, q],
    `CASE i.kind WHEN 'movie' THEN 0 WHEN 'show' THEN 0 ELSE 1 END, i.sort_title`, 60));
});
route('GET', '/api/items/:id', user, (c) => {
  const uid = c.user.id, it = get('SELECT * FROM items WHERE id=?', c.p.id);
  if (!it) return fail(c.res, 404, 'Finns inte');
  if (!allowedFor(uid, it)) return fail(c.res, 403, 'Inte tillgänglig i den här profilen');
  const out = oneItem(uid, it.id);
  out.inWatchlist = !!get('SELECT 1 FROM watchlist WHERE user_id=? AND item_id=?', uid, it.kind === 'episode' ? it.parent_id : it.id);
  if (it.collection_id) {
    const col = get('SELECT * FROM collections WHERE id=?', it.collection_id);
    if (col) out.collectionInfo = { id: col.id, name: col.name, items: listItems(uid, 'i.collection_id=? AND i.kind=\'movie\'', [col.id], 'i.year', 50) };
  }
  if (it.kind !== 'episode') out.similar = similarTo(uid, it, 12);
  if (it.kind === 'show') {
    out.children = listItems(uid, 'i.parent_id=?', [it.id], 'i.season, i.episode', 5000);
    out.next = out.children.find(e => !e.watched && e.position > 0) || out.children.find(e => !e.watched) || out.children[0] || null;
  } else {
    Object.assign(out, {
      file: path.basename(it.path), size: it.size, container: it.container, vcodec: it.vcodec, acodec: it.acodec,
      width: it.width, height: it.height, chapters: chaptersOf(it),
      audio: st.streamsOf(it).filter(s => s.type === 'audio'), subtitles: st.subtitlesOf(it).map(({ file, ...s }) => s)
    });
    if (it.kind === 'episode') {
      const sib = all(`SELECT id FROM items WHERE parent_id=? ORDER BY season, episode`, it.parent_id).map(r => r.id);
      const i = sib.indexOf(it.id);
      out.prevId = sib[i - 1] || null; out.nextId = sib[i + 1] || null;
    }
  }
  send(c.res, 200, out);
});
route('POST', '/api/items/:id/progress', user, async (c) => {
  const { position, duration } = await readJson(c.req);
  const it = get('SELECT * FROM items WHERE id=? AND kind!=\'show\'', c.p.id);
  if (!it) return fail(c.res, 404, 'Finns inte');
  const dur = it.duration || +duration || 0, pos = Math.max(0, +position || 0);
  const wasWatched = !!get('SELECT watched FROM progress WHERE user_id=? AND item_id=?', c.user.id, it.id)?.watched;
  const watched = dur && (pos / dur > 0.92 || dur - pos < 120 && pos > 60) ? 1 : 0;
  run(`INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,item_id) DO UPDATE SET position=excluded.position, duration=excluded.duration,
    watched=MAX(watched,excluded.watched), updated=excluded.updated`, c.user.id, it.id, watched ? 0 : pos, dur, watched, now());
  if (watched) run('UPDATE progress SET position=0 WHERE user_id=? AND item_id=?', c.user.id, it.id);
  if (watched && !wasWatched) trakt.scrobble(c.user.id, it, 'stop', 100).catch(() => {});
  act.touch(c.user.id, it.id, pos);
  send(c.res, 200, { watched: !!watched, stop: act.isStopped(c.user.id, it.id) });
});
route('POST', '/api/items/:id/watched', user, async (c) => {
  const { watched } = await readJson(c.req);
  const it = get('SELECT id,kind FROM items WHERE id=?', c.p.id);
  if (!it) return fail(c.res, 404, 'Finns inte');
  const ids = it.kind === 'show' ? all('SELECT id FROM items WHERE parent_id=?', it.id).map(r => r.id) : [it.id];
  const season = c.q.get('season');
  const targets = season != null && it.kind === 'show'
    ? all('SELECT id FROM items WHERE parent_id=? AND season=?', it.id, +season).map(r => r.id) : ids;
  for (const id of targets) run(`INSERT INTO progress(user_id,item_id,position,watched,updated) VALUES(?,?,0,?,?)
    ON CONFLICT(user_id,item_id) DO UPDATE SET position=0, watched=excluded.watched, updated=excluded.updated`, c.user.id, id, watched ? 1 : 0, now());
  if (watched) trakt.markWatched(c.user.id, targets.map(id => get('SELECT * FROM items WHERE id=?', id)).filter(Boolean)).catch(() => {});
  send(c.res, 200, { ok: true });
});
route('POST', '/api/items/:id/refresh', admin, async (c) => {
  const it = get('SELECT * FROM items WHERE id=?', c.p.id);
  if (!it) return fail(c.res, 404, 'Finns inte');
  const { tmdbId } = await readJson(c.req);
  try {
    if (it.kind !== 'episode' && (getSetting('tmdb_key') || process.env.TMDB_API_KEY)) await refreshItem(it, tmdbId ? +tmdbId : null);
    if (it.kind !== 'show' && it.path) { run('UPDATE items SET thumb=0 WHERE id=?', it.id); await extractThumb(it); }
    send(c.res, 200, { ok: true });
  } catch (e) { fail(c.res, 502, 'Metadata misslyckades: ' + e.message); }
});
// Manuell matchning ("fel film?") – sök i TMDB och välj rätt titel. Matchningen låses så att omskanning inte ändrar den.
route('GET', '/api/items/:id/match', admin, async (c) => {
  const it = get('SELECT * FROM items WHERE id=?', c.p.id);
  if (!it || it.kind === 'episode') return fail(c.res, 404, 'Finns inte');
  if (!(getSetting('tmdb_key') || process.env.TMDB_API_KEY)) return fail(c.res, 400, 'Ange en TMDB-nyckel under Administration först');
  const q = String(c.q.get('q') || it.title).slice(0, 200), year = parseInt(c.q.get('year')) || null;
  try { send(c.res, 200, { current: it.tmdb_id, locked: !!it.match_locked, results: await tmdbSearch(it.kind, q, year) }); }
  catch (e) { fail(c.res, 502, 'TMDB: ' + e.message); }
});
route('POST', '/api/items/:id/match', admin, async (c) => {
  const it = get('SELECT * FROM items WHERE id=?', c.p.id);
  if (!it || it.kind === 'episode') return fail(c.res, 404, 'Finns inte');
  const { tmdbId, unlock } = await readJson(c.req);
  if (unlock) { run('UPDATE items SET match_locked=0, meta_done=0 WHERE id=?', it.id); scan(it.library_id); return send(c.res, 200, { ok: true }); }
  if (!(+tmdbId > 0)) return fail(c.res, 400, 'Välj en titel');
  try {
    if (!(await refreshItem(it, +tmdbId))) return fail(c.res, 404, 'Titeln hittades inte i TMDB');
    run('UPDATE items SET match_locked=1 WHERE id=?', it.id);
    audit('item_matched', { ...ctx(c), detail: `${it.title} → tmdb ${+tmdbId}` });
    send(c.res, 200, oneItem(c.user.id, it.id));
  } catch (e) { fail(c.res, 502, 'TMDB: ' + e.message); }
});
route('PUT', '/api/libraries/:id', admin, async (c) => {
  const b = await readJson(c.req);
  const l = get('SELECT * FROM libraries WHERE id=?', c.p.id); if (!l) return fail(c.res, 404, 'Finns inte');
  if (typeof b.name === 'string' && b.name.trim()) run('UPDATE libraries SET name=? WHERE id=?', b.name.trim().slice(0, 60), l.id);
  if (b.anime != null) { run('UPDATE libraries SET anime=? WHERE id=?', b.anime ? 1 : 0, l.id); run("UPDATE items SET meta_done=0 WHERE library_id=? AND kind='show' AND meta_done=1", l.id); scan(l.id); }
  send(c.res, 200, { ok: true });
});
route('PUT', '/api/items/:id', admin, async (c) => {
  const { title, year, overview, age } = await readJson(c.req);
  run(`UPDATE items SET title=COALESCE(?,title), sort_title=COALESCE(lower(?),sort_title), year=?, overview=? WHERE id=?`,
    title || null, title || null, year ? +year : null, overview ?? null, c.p.id);
  if (age !== undefined) run('UPDATE items SET age=?, cert=? WHERE id=?', age === '' || age == null ? null : Math.max(0, Math.min(18, parseInt(age) || 0)), age === '' || age == null ? null : 'manuell', c.p.id);
  send(c.res, 200, { ok: true });
});



// ---------- Musik ----------
const musicLib = (c) => { const l = get("SELECT * FROM libraries WHERE id=? AND type='music'", +c.p.lib); if (!l) fail(c.res, 404, 'Inget musikbibliotek'); return l; };
route('GET', '/api/music/:lib/home', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, { library: l, ...music.musicHome(l.id, c.user.id), playlists: music.playlists(c.user.id) }); });
route('GET', '/api/music/:lib/albums', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, music.albums(l.id, c.q.get('sort') || 'title')); });
route('GET', '/api/music/:lib/artists', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, music.artists(l.id)); });
route('GET', '/api/music/:lib/search', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, music.searchMusic(String(c.q.get('q') || '').slice(0, 100), c.user.id)); });
route('GET', '/api/music/albums/:aid', user, (c) => { const a = music.album(+c.p.aid, c.user.id); a ? send(c.res, 200, a) : fail(c.res, 404, 'Finns inte'); });
route('GET', '/api/music/artists/:arid', user, (c) => { const a = music.artist(+c.p.arid, c.user.id); a ? send(c.res, 200, a) : fail(c.res, 404, 'Finns inte'); });
route('GET', '/api/music/cover/:aid', img, (c) => {
  const f = music.coverPath(+c.p.aid);
  if (!f) return fail(c.res, 404, 'Inget omslag');
  fs.readFile(f, (e, data) => e ? fail(c.res, 404, '') : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800' }));
});
const trackRow = (c) => { const t = get('SELECT * FROM tracks WHERE id=?', +c.p.tid); if (!t) fail(c.res, 404, 'Spåret finns inte'); return t; };
route('GET', '/api/music/tracks/:tid/stream', audio, (c) => { const t = trackRow(c); if (t) music.streamTrack(c.req, c.res, t, c.q); });
route('HEAD', '/api/music/tracks/:tid/stream', audio, (c) => { const t = trackRow(c); if (t) music.streamTrack(c.req, c.res, t, c.q); });
// Kortlivad länk till ett spår (för appar, Chromecast och AirPlay)
route('GET', '/api/music/tracks/:tid/play', user, (c) => {
  const t = trackRow(c); if (!t) return;
  const tok = createSession(c.user.id, 'media', { item: -t.id, ip: clientIp(c.req) });
  send(c.res, 200, { url: `/api/music/tracks/${t.id}/stream?t=${tok}` });
});
route('POST', '/api/music/tracks/:tid/played', user, (c) => {
  const t = trackRow(c); if (!t) return;
  run('INSERT INTO track_plays(user_id,track_id,ts) VALUES(?,?,?)', c.user.id, t.id, now());
  send(c.res, 200, { ok: true });
});
route('POST', '/api/music/tracks/:tid/favorite', user, async (c) => {
  const t = trackRow(c); if (!t) return;
  const { on } = await readJson(c.req);
  if (on === false) run('DELETE FROM favorites WHERE user_id=? AND track_id=?', c.user.id, t.id);
  else run('INSERT OR IGNORE INTO favorites(user_id,track_id) VALUES(?,?)', c.user.id, t.id);
  send(c.res, 200, { ok: true });
});
route('GET', '/api/music/playlists', user, (c) => send(c.res, 200, music.playlists(c.user.id)));
route('POST', '/api/music/playlists', user, async (c) => {
  const { name, trackIds } = await readJson(c.req);
  const nm = String(name || '').trim().slice(0, 100);
  if (!nm) return fail(c.res, 400, 'Namn krävs');
  if (all('SELECT id FROM playlists WHERE user_id=?', c.user.id).length >= 200) return fail(c.res, 400, 'För många spellistor');
  const id = Number(run('INSERT INTO playlists(user_id,name,created) VALUES(?,?,?)', c.user.id, nm, now()).lastInsertRowid);
  (Array.isArray(trackIds) ? trackIds.slice(0, 5000) : []).forEach((t, i) => { if (get('SELECT 1 FROM tracks WHERE id=?', +t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', id, +t, i); });
  send(c.res, 200, { id });
});
route('GET', '/api/music/playlists/:pid', user, (c) => { const p = music.playlist(+c.p.pid, c.user.id); p ? send(c.res, 200, p) : fail(c.res, 404, 'Finns inte'); });
route('PUT', '/api/music/playlists/:pid', user, async (c) => {
  const p = get('SELECT * FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id);
  if (!p) return fail(c.res, 404, 'Finns inte');
  const { name, trackIds } = await readJson(c.req);
  if (name) run('UPDATE playlists SET name=? WHERE id=?', String(name).trim().slice(0, 100), p.id);
  if (Array.isArray(trackIds)) { // ny ordning / nytt innehåll
    run('DELETE FROM playlist_items WHERE playlist_id=?', p.id);
    trackIds.slice(0, 5000).forEach((t, i) => { if (get('SELECT 1 FROM tracks WHERE id=?', +t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', p.id, +t, i); });
  }
  send(c.res, 200, { ok: true });
});
route('POST', '/api/music/playlists/:pid/tracks', user, async (c) => {
  const p = get('SELECT * FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id);
  if (!p) return fail(c.res, 404, 'Finns inte');
  const { trackIds } = await readJson(c.req);
  let pos = (get('SELECT MAX(pos) AS m FROM playlist_items WHERE playlist_id=?', p.id).m ?? -1) + 1;
  for (const t of (Array.isArray(trackIds) ? trackIds : []).slice(0, 2000)) if (get('SELECT 1 FROM tracks WHERE id=?', +t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', p.id, +t, pos++);
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/music/playlists/:pid', user, (c) => { run('DELETE FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id); send(c.res, 200, { ok: true }); });



// ---------- Offline-nedladdning (appar) ----------
route('GET', '/api/items/:id/offline', user, (c) => {
  const it = mediaItem(c); if (!it) return;
  const q = c.q.get('q') || '720';
  const st = offline.status(it, q);
  if (st.status === 'ready') st.url = `/api/stream/${it.id}/offline-file?q=${encodeURIComponent(q)}&t=${createSession(c.user.id, 'media', { item: it.id, ip: clientIp(c.req) })}`;
  send(c.res, 200, st);
});
route('POST', '/api/items/:id/offline', user, async (c) => {
  const it = mediaItem(c); if (!it) return;
  const { q } = await readJson(c.req);
  send(c.res, 200, offline.start(it, q || '720'));
});
route('DELETE', '/api/items/:id/offline', user, (c) => { const it = mediaItem(c); if (!it) return; offline.cancel(it, c.q.get('q') || '720'); send(c.res, 200, { ok: true }); });
route('GET', '/api/stream/:id/offline-file', media, (c) => { const it = mediaItem(c); if (it) offline.serveFile(c.req, c.res, it, c.q.get('q') || '720'); });
route('HEAD', '/api/stream/:id/offline-file', media, (c) => { const it = mediaItem(c); if (it) offline.serveFile(c.req, c.res, it, c.q.get('q') || '720'); });

// ---------- Titta tillsammans ----------
route('POST', '/api/party', user, async (c) => {
  const { itemId } = await readJson(c.req);
  const it = get(`SELECT * FROM items WHERE id=? AND kind != 'show'`, +itemId);
  if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  const id = party.createRoom(c.user, it.id);
  audit('party_created', { ...ctx(c), detail: it.title });
  send(c.res, 200, { id });
});
const roomFor = (c) => {
  const r = party.getRoom(c.p.rid);
  if (!r) { fail(c.res, 404, 'Rummet finns inte längre'); return null; }
  const it = get('SELECT * FROM items WHERE id=?', r.itemId);
  if (!allowedFor(c.user.id, it)) { fail(c.res, 403, 'Inte tillgänglig i den här profilen'); return null; }
  return r;
};
route('GET', '/api/party/:rid', user, (c) => { const r = roomFor(c); if (r) send(c.res, 200, party.roomInfo(r)); });
route('GET', '/api/party/:rid/events', user, (c) => { const r = roomFor(c); if (r) party.subscribe(r, c.user, c.req, c.res); });
route('POST', '/api/party/:rid/state', user, async (c) => {
  const r = roomFor(c); if (!r) return;
  const b = await readJson(c.req);
  if (b.itemId) { const it = get(`SELECT * FROM items WHERE id=? AND kind != 'show'`, +b.itemId); if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte'); }
  party.setState(r, c.user, b);
  send(c.res, 200, { ok: true });
});
route('POST', '/api/party/:rid/chat', user, async (c) => { const r = roomFor(c); if (!r) return; party.chat(r, c.user, (await readJson(c.req)).text); send(c.res, 200, { ok: true }); });
route('DELETE', '/api/party/:rid', user, (c) => {
  const r = party.getRoom(c.p.rid);
  if (r && (r.host === c.user.id || c.user.is_admin)) party.closeRoom(r.id);
  send(c.res, 200, { ok: true });
});

// ---------- Min lista ----------
route('GET', '/api/watchlist', user, (c) => send(c.res, 200,
  listItems(c.user.id, 'i.id IN (SELECT item_id FROM watchlist WHERE user_id=p_uid.uid)', [], '(SELECT added FROM watchlist w WHERE w.user_id=p_uid.uid AND w.item_id=i.id) DESC', 500)));
route('POST', '/api/items/:id/watchlist', user, async (c) => {
  const { add } = await readJson(c.req);
  let it = get('SELECT id, kind, parent_id, age FROM items WHERE id=?', c.p.id);
  if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  const id = it.kind === 'episode' ? it.parent_id : it.id; // avsnitt → hela serien
  if (add === false) run('DELETE FROM watchlist WHERE user_id=? AND item_id=?', c.user.id, id);
  else run('INSERT OR IGNORE INTO watchlist(user_id,item_id,added) VALUES(?,?,?)', c.user.id, id, now());
  send(c.res, 200, { ok: true });
});

// ---------- Samlingar ----------
route('GET', '/api/collections', user, (c) => {
  const cols = all(`SELECT c.*, COUNT(i.id) AS n, MIN(i.year) AS y0, MAX(i.year) AS y1 FROM collections c JOIN items i ON i.collection_id=c.id AND i.kind='movie'
    GROUP BY c.id HAVING n >= 2 ORDER BY c.name`);
  // dölj samlingar där profilen inte får se något
  send(c.res, 200, cols.map(col => ({ id: col.id, name: col.name, overview: col.overview, poster: !!col.poster, backdrop: !!col.backdrop, count: col.n, years: [col.y0, col.y1],
    visible: listItems(c.user.id, 'i.collection_id=?', [col.id], 'i.year', 1).length > 0 })).filter(x => x.visible));
});
route('GET', '/api/collections/:cid', user, (c) => {
  const col = get('SELECT * FROM collections WHERE id=?', +c.p.cid);
  if (!col) return fail(c.res, 404, 'Finns inte');
  send(c.res, 200, { id: col.id, name: col.name, overview: col.overview, poster: !!col.poster, backdrop: !!col.backdrop,
    items: listItems(c.user.id, 'i.collection_id=? AND i.kind=\'movie\'', [col.id], 'i.year', 100) });
});

// ---------- Profiler (hushåll) ----------
const householdRoot = (u) => u.parent_id || u.id;
const profileOut = (p, rootId) => ({ id: p.id, name: p.name, owner: p.id === rootId, kid: p.max_age != null, maxAge: p.max_age, hasPin: !!p.pin, color: p.color || null });
route('GET', '/api/profiles', user, (c) => {
  const me = get('SELECT * FROM users WHERE id=?', c.user.id), root = householdRoot(me);
  const list = all('SELECT * FROM users WHERE id=? OR parent_id=? ORDER BY parent_id IS NOT NULL, name', root, root);
  send(c.res, 200, { current: c.user.id, profiles: list.map(p => profileOut(p, root)) });
});
const canManage = (c, root) => c.user.is_admin || (c.user.id === root);
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
    if (t.pin) {
      if (!pin || !await checkPw(String(pin), t.pin)) { noteFail(ip, t.name); audit('profile_pin_fail', { ip, user: t }); return send(c.res, 401, { error: 'Fel PIN', needPin: true }); }
    } else if (t.max_age == null && me.max_age != null) {
      // Från en barnprofil till en vuxenprofil utan PIN: kräv huvudkontots lösenord
      const r = get('SELECT * FROM users WHERE id=?', root);
      if (!password || !await checkPw(String(password), r.pass)) { noteFail(ip, r.name); return send(c.res, 401, { error: 'Ange huvudkontots lösenord', needPassword: true }); }
    }
  }
  const meta = { ua: c.req.headers['user-agent'], ip };
  run('DELETE FROM sessions WHERE token=?', c.user.tokenHash);
  audit('profile_switched', { ip, user: t, detail: `från ${me.name}` });
  if (c.user.kind === 'app') return send(c.res, 200, { ok: true, token: createSession(t.id, 'app', meta), user: { id: t.id, name: t.name, is_admin: t.is_admin } });
  send(c.res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(createSession(t.id, 'web', meta), isHttps(c.req)) });
});

// ---------- Rekommendationer (lokalt, utan molntjänst) ----------
function genreProfile(uid) {
  const rows = all(`SELECT COALESCE(s.genres, i.genres) AS g, COUNT(*) AS n FROM progress p JOIN items i ON i.id=p.item_id LEFT JOIN items s ON s.id=i.parent_id
    WHERE p.user_id=? AND (p.watched=1 OR p.position > 300) GROUP BY COALESCE(s.id, i.id)`, uid);
  const w = {};
  for (const r of rows) { let g = []; try { g = JSON.parse(r.g || '[]'); } catch {} for (const x of g) w[x] = (w[x] || 0) + 1; }
  for (const r of all(`SELECT i.genres FROM watchlist l JOIN items i ON i.id=l.item_id WHERE l.user_id=?`, uid)) {
    let g = []; try { g = JSON.parse(r.genres || '[]'); } catch {} for (const x of g) w[x] = (w[x] || 0) + 0.5;
  }
  return w;
}
function recommend(uid, limit) {
  const w = genreProfile(uid);
  if (!Object.keys(w).length) return [];
  const cands = listItems(uid, `i.kind IN ('movie','show') AND i.genres IS NOT NULL AND i.genres != '[]'
    AND NOT EXISTS (SELECT 1 FROM progress q JOIN items e ON e.id=q.item_id WHERE q.user_id=p_uid.uid AND (e.id=i.id OR e.parent_id=i.id) AND (q.watched=1 OR q.position > 0))
    AND NOT EXISTS (SELECT 1 FROM watchlist l WHERE l.user_id=p_uid.uid AND l.item_id=i.id)`, [], 'i.added DESC', 3000);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  return cands.map(it => ({ it, score: it.genres.reduce((a, g) => a + (w[g] || 0) / total, 0) / Math.sqrt(it.genres.length || 1) + (it.rating || 6) / 50 }))
    .filter(x => x.score > 0.2).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.it);
}
function similarTo(uid, it, limit) {
  let g = []; try { g = JSON.parse(it.genres || '[]'); } catch {}
  if (!g.length) return [];
  const cands = listItems(uid, `i.kind=? AND i.id != ? AND i.genres IS NOT NULL`, [it.kind, it.id], 'i.rating DESC', 2000);
  return cands.map(x => ({ x, s: x.genres.filter(y => g.includes(y)).length / Math.max(g.length, x.genres.length) + (x.collection && x.collection === it.collection_id ? 1 : 0) }))
    .filter(o => o.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, limit).map(o => o.x);
}

// Förhandsbilder vid spolning
route('GET', '/api/items/:id/trickplay', user, (c) => {
  const it = get('SELECT * FROM items WHERE id=?', c.p.id);
  if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  const i = trick.info(it);
  i ? send(c.res, 200, i) : fail(c.res, 404, 'Inga förhandsbilder');
});
route('GET', '/api/items/:id/trickplay/:n', img, (c) => {
  const it = get('SELECT * FROM items WHERE id=?', c.p.id);
  if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  const f = trick.sprite(it, parseInt(c.p.n));
  if (!f) return fail(c.res, 404, 'Finns inte');
  fs.readFile(f, (e, data) => e ? fail(c.res, 404, '') : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800' }));
});

// Bilder
route('GET', '/api/collection-image/:cid/:type', img, (c) => {
  if (!['poster', 'backdrop'].includes(c.p.type)) return fail(c.res, 404, '');
  fs.readFile(path.join(IMAGES, `c${+c.p.cid}-${c.p.type}.jpg`), (e, data) => e ? fail(c.res, 404, 'Ingen bild')
    : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }));
});
route('GET', '/api/image/:id/:type', img, (c) => {
  if (!['poster', 'backdrop', 'thumb'].includes(c.p.type)) return fail(c.res, 404, '');
  const f = path.join(IMAGES, `${+c.p.id}-${c.p.type}.jpg`);
  fs.readFile(f, (e, data) => e ? fail(c.res, 404, 'Ingen bild')
    : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }));
});

// Uppspelning
const mediaItem = (c) => {
  const it = get(`SELECT * FROM items WHERE id=? AND kind!='show'`, c.p.id);
  if (!it) { fail(c.res, 404, 'Finns inte'); return null; }
  if (!allowedFor(c.user.id, it)) { fail(c.res, 403, 'Inte tillgänglig i den här profilen'); return null; }
  if (c.req.url.includes('/api/stream/')) {
    if (act.isStopped(c.user.id, it.id)) { fail(c.res, 403, 'Uppspelningen stoppades av administratören'); return null; }
    act.touch(c.user.id, it.id);
  }
  return it;
};
// Klienten skickar sina förmågor; svaret anger läge och färdiga URL:er
route('GET', '/api/items/:id/playback', user, (c) => {
  const it = mediaItem(c); if (!it) return;
  if (act.isStopped(c.user.id, it.id)) return fail(c.res, 403, 'Uppspelningen stoppades av administratören');
  const o = st.parseCaps(c.q);
  const remote = !isLocalReq(c.req);
  // Utanför hemmet: begränsa kvaliteten automatiskt (om klienten inte valt själv)
  const auto = !c.q.get('q') || c.q.get('q') === 'auto';
  if (remote && auto) o.q = getSetting('remote_quality', process.env.REMOTE_QUALITY || '1080');
  o.maxBitrate = st.QUALITIES[o.q]?.br || null;
  const d = st.decide(it, o);
  // Token i URL behövs för appar, Chromecast och AirPlay (de skickar inte webbläsarens cookie)
  // Strömlänkar får en egen kortlivad token som bara gäller den här titeln (aldrig kontots token i URL:er)
  let token = null;
  if (c.q.get('cast') === '1' || c.user.via !== 'cookie') token = createSession(c.user.id, 'media', { item: it.id, ip: clientIp(c.req) });
  const tq = token ? `?t=${token}` : '';
  const base = `/api/stream/${it.id}`;
  const url = d.mode === 'direct' ? `${base}/direct${tq}` : `${base}/hls/master.m3u8?${st.hlsParams(d, o, token)}`;
  if (it.duration) trakt.scrobble(c.user.id, it, 'start', (+c.q.get('start') || 0) / it.duration * 100).catch(() => {});
  act.startPlay({ user: c.user, item: it, mode: d.mode, quality: d.q, ip: clientIp(c.req), remote, ua: c.req.headers['user-agent'], reasons: d.reasons });
  const subs = st.subtitlesOf(it).filter(s => !s.bitmap).map(s => ({
    id: s.id, label: s.label, lang: s.lang, forced: s.forced, url: `${base}/subs/${s.id}.vtt${tq}`
  }));
  send(c.res, 200, {
    mode: d.mode, url, reasons: d.reasons, hdr: it.hdr, tonemap: d.tonemap, burn: d.burn || null,
    duration: it.duration, subtitles: subs, token, remote, quality: d.q,
    intro: it.intro_end ? { start: it.intro_start || 0, end: it.intro_end } : null, credits: it.credits_start || null,
    recap: it.recap_end ? { start: it.recap_start || 0, end: it.recap_end } : null,
    chapters: chaptersOf(it), audio: st.streamsOf(it).filter(s => s.type === 'audio').map(a => ({ index: a.index, lang: a.lang, title: a.title, codec: a.codec, channels: a.channels, default: a.default })),
    audioSelected: d.audio ?? null,
    mime: d.mode === 'direct' ? (MIME[path.extname(it.path).toLowerCase()] || 'video/mp4') : 'application/vnd.apple.mpegurl'
  });
});
route('GET', '/api/stream/:id/direct', media, (c) => { const it = mediaItem(c); if (it) st.serveDirect(c.req, c.res, it); });
route('HEAD', '/api/stream/:id/direct', media, (c) => { const it = mediaItem(c); if (it) st.serveDirect(c.req, c.res, it); });
route('GET', '/api/stream/:id/download', user, (c) => { const it = mediaItem(c); if (it) st.serveDownload(c.req, c.res, it); });
route('GET', '/api/stream/:id/hls/master.m3u8', media, (c) => { const it = mediaItem(c); if (it) st.serveMaster(c.res, it, c.q); });
route('GET', '/api/stream/:id/hls/index.m3u8', media, (c) => { const it = mediaItem(c); if (it) st.servePlaylist(c.res, it, c.q); });
route('GET', '/api/stream/:id/hls/init.mp4', media, async (c) => { const it = mediaItem(c); if (it) await st.serveInit(c.req, c.res, it, c.q, c.user.id); });
route('GET', '/api/stream/:id/hls/seg-:n.m4s', media, async (c) => { const it = mediaItem(c); if (it) await st.serveSegment(c.req, c.res, it, +c.p.n, c.q, c.user.id); });
route('GET', '/api/stream/:id/hls/seg-:n.ts', media, async (c) => { const it = mediaItem(c); if (it) await st.serveSegment(c.req, c.res, it, +c.p.n, c.q, c.user.id); });
route('GET', '/api/stream/:id/hls/subs-:sid.m3u8', media, (c) => { const it = mediaItem(c); if (it) st.serveSubPlaylist(c.res, it, c.p.sid, c.q); });
route('GET', '/api/stream/:id/subs/:sid', media, (c) => { const it = mediaItem(c); if (it) st.serveSubtitle(c.req, c.res, it, c.p.sid.replace(/\.vtt$/, ''), c.q); });
route('POST', '/api/stream/:id/stop', user, (c) => { st.stopUserSessions(+c.p.id, c.user.id); send(c.res, 200, { ok: true }); });

// Undertexter från OpenSubtitles
route('GET', '/api/items/:id/subsearch', user, async (c) => {
  const it = mediaItem(c); if (!it) return;
  const langs = (c.q.get('lang') || 'sv,en').split(',').map(x => x.trim().toLowerCase()).filter(x => /^[a-z]{2}(-[a-z]{2})?$/.test(x)).slice(0, 5);
  try { send(c.res, 200, await os.search(it, langs.length ? langs : ['sv'])); }
  catch (e) { fail(c.res, e.status || 502, e.message); }
});
route('POST', '/api/items/:id/subdownload', user, async (c) => {
  const it = mediaItem(c); if (!it) return;
  const { fileId, lang } = await readJson(c.req);
  if (!fileId) return fail(c.res, 400, 'fileId saknas');
  try { send(c.res, 200, await os.download(it, fileId, lang)); }
  catch (e) { fail(c.res, e.status || 502, e.message); }
});
route('DELETE', '/api/items/:id/subs/:sid', admin, (c) => {
  const it = mediaItem(c); if (!it) return;
  const s = st.subtitlesOf(it).find(x => x.id === c.p.sid);
  if (!s || s.source !== 'downloaded') return fail(c.res, 400, 'Endast nedladdade undertexter kan tas bort');
  os.removeDownloaded(it, s.file);
  send(c.res, 200, { ok: true });
});
// Intro/eftertexter: justera manuellt eller analysera om
route('PUT', '/api/items/:id/markers', admin, async (c) => {
  const { introStart, introEnd, creditsStart } = await readJson(c.req);
  const n = (x) => x === null || x === '' || x === undefined ? null : Math.max(0, +x);
  run('UPDATE items SET intro_start=?, intro_end=?, credits_start=?, markers_done=1 WHERE id=?', n(introStart), n(introEnd), n(creditsStart), c.p.id);
  send(c.res, 200, { ok: true });
});
route('POST', '/api/items/:id/markers/redetect', admin, (c) => {
  const it = get('SELECT * FROM items WHERE id=?', c.p.id);
  if (!it) return fail(c.res, 404, 'Finns inte');
  if (it.kind === 'show') run('UPDATE items SET markers_done=0 WHERE parent_id=?', it.id);
  else if (it.kind === 'episode') run('UPDATE items SET markers_done=0 WHERE parent_id=? AND season=?', it.parent_id, it.season);
  scan(it.library_id);
  send(c.res, 200, { ok: true });
});

// Admin: användare och inställningar
route('GET', '/api/users', admin, (c) => send(c.res, 200, all(`SELECT id,name,is_admin,created,totp_enabled,remote_allowed,pw_changed,
  (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id=users.id AND s.kind IN ('web','app')) AS last_seen FROM users ORDER BY name`)));
route('POST', '/api/users', admin, async (c) => {
  const { name, password, isAdmin, remoteAllowed } = await readJson(c.req);
  if (!name?.trim() || name.trim().length > 64) return fail(c.res, 400, 'Namn krävs');
  const weak = weakPassword(password, name); if (weak) return fail(c.res, 400, weak);
  try { run('INSERT INTO users(name,pass,is_admin,created,remote_allowed,pw_changed) VALUES(?,?,?,?,?,?)', name.trim(), await hashPw(password), isAdmin ? 1 : 0, now(), remoteAllowed === false ? 0 : 1, now()); }
  catch { return fail(c.res, 409, 'Namnet är upptaget'); }
  audit('user_created', { ...ctx(c), detail: `${name.trim()}${isAdmin ? ' (admin)' : ''}` });
  send(c.res, 200, { ok: true });
});
route('PUT', '/api/users/:id', admin, async (c) => {
  const { password, isAdmin, remoteAllowed, reset2fa, logoutAll } = await readJson(c.req);
  const target = get('SELECT id,name FROM users WHERE id=?', +c.p.id);
  if (!target) return fail(c.res, 404, 'Finns inte');
  const changes = [];
  if (password) {
    const weak = weakPassword(password, target.name); if (weak) return fail(c.res, 400, weak);
    run('UPDATE users SET pass=?, pw_changed=? WHERE id=?', await hashPw(password), now(), target.id);
    run('DELETE FROM sessions WHERE user_id=?', target.id); changes.push('nytt lösenord');
  }
  if (isAdmin != null && target.id !== c.user.id) { run('UPDATE users SET is_admin=? WHERE id=?', isAdmin ? 1 : 0, target.id); changes.push(isAdmin ? 'admin' : 'ej admin'); }
  if (remoteAllowed != null) {
    run('UPDATE users SET remote_allowed=? WHERE id=?', remoteAllowed ? 1 : 0, target.id); changes.push(remoteAllowed ? 'fjärråtkomst på' : 'fjärråtkomst av');
    if (!remoteAllowed) run("DELETE FROM sessions WHERE user_id=? AND kind IN ('media','img')", target.id);
  }
  if (reset2fa) { run('UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_pending=NULL, recovery=NULL WHERE id=?', target.id); changes.push('2FA återställd'); }
  if (logoutAll) { run('DELETE FROM sessions WHERE user_id=? AND token != ?', target.id, c.user.tokenHash); changes.push('utloggad överallt'); }
  audit('user_updated', { ...ctx(c), detail: `${target.name}: ${changes.join(', ')}` });
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/users/:id', admin, (c) => {
  if (+c.p.id === c.user.id) return fail(c.res, 400, 'Du kan inte ta bort dig själv');
  const t = get('SELECT name FROM users WHERE id=?', +c.p.id);
  run('DELETE FROM users WHERE id=?', c.p.id);
  audit('user_deleted', { ...ctx(c), detail: t?.name });
  send(c.res, 200, { ok: true });
});
route('GET', '/api/settings', admin, (c) => {
  const k = getSetting('tmdb_key') || '';
  send(c.res, 200, {
    tmdbKeySet: !!(k || process.env.TMDB_API_KEY), tmdbFromEnv: !k && !!process.env.TMDB_API_KEY,
    language: getSetting('language', 'sv-SE'), scanInterval: +getSetting('scan_interval', process.env.SCAN_INTERVAL || '60'),
    hwaccel: st.hwMode, mediaRoot: MEDIA_ROOT, activeTranscodes: st.activeTranscodes().length, version: VERSION,
    osKeySet: !!(getSetting('os_key') || process.env.OPENSUBTITLES_API_KEY), osUser: getSetting('os_user'), osPassSet: !!getSetting('os_pass'),
    subLangs: getSetting('sub_langs', 'sv,en'),
    subAuto: getSetting('sub_auto', '0') === '1', subAutoLangs: getSetting('sub_auto_langs', getSetting('sub_langs', 'sv,en')), subAutoHash: getSetting('sub_auto_hash', '1') === '1',
    subAutoMax: +getSetting('sub_auto_max', '10'), subAutoStats: autoSubs,
    remoteQuality: getSetting('remote_quality', process.env.REMOTE_QUALITY || '1080'), publicUrl: getSetting('public_url', process.env.PUBLIC_URL || ''),
    youAreLocal: isLocalReq(c.req), https: isHttps(c.req), tlsBuiltin: !!globalThis.__braxhnTls,
    adminAnywhere: adminAnywhere(), require2faRemote: require2faRemote(), trustedNetworks: getSetting('trusted_networks', ''), trustVpnRange: trustVpn(),
    clientIp: clientIp(c.req), peerIp: peerIp(c.req),
    maxTranscodes: st.limits().global, maxTranscodesUser: st.limits().user,
    watchEnabled: getSetting('watch_enabled', process.env.WATCH_FILES || '1') === '1', watching: act.watchingCount(), allowUnrated: allowUnrated(),
    trickplay: getSetting('trickplay', process.env.TRICKPLAY || '1') === '1', detectRecap: getSetting('detect_recap', '1') === '1'
  });
});
route('PUT', '/api/settings', admin, async (c) => {
  const b = await readJson(c.req);
  const changed = Object.keys(b).filter(k => !/pass|key/i.test(k));
  if (typeof b.tmdbKey === 'string') setSetting('tmdb_key', b.tmdbKey.trim());
  if (b.language) setSetting('language', String(b.language).slice(0, 10));
  if (b.scanInterval != null) setSetting('scan_interval', Math.max(0, parseInt(b.scanInterval) || 0));
  if (b.resetMeta) run('UPDATE items SET meta_done=0');
  if (typeof b.osKey === 'string') setSetting('os_key', b.osKey.trim());
  if (typeof b.osUser === 'string') setSetting('os_user', b.osUser.trim());
  if (typeof b.osPass === 'string' && b.osPass) setSetting('os_pass', b.osPass);
  if (typeof b.subLangs === 'string') setSetting('sub_langs', b.subLangs.replace(/[^a-z,-]/gi, ''));
  if (b.remoteQuality && st.QUALITIES[b.remoteQuality]) setSetting('remote_quality', b.remoteQuality);
  if (typeof b.publicUrl === 'string') {
    const u = b.publicUrl.trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s/]+$/i.test(u)) return fail(c.res, 400, 'Publik adress ska vara t.ex. https://tv.dindomän.se');
    setSetting('public_url', u);
  }
  if (b.resetMarkers) run("UPDATE items SET markers_done=0 WHERE kind='episode'");
  if (b.adminAnywhere != null) {
    // Får bara slås på/av från ett betrott nät (annars kan man låsa ute sig själv eller en angripare öppna upp)
    if (!isTrusted(c.req)) return fail(c.res, 403, 'Kan bara ändras från hemnätverket');
    setSetting('admin_anywhere', b.adminAnywhere ? '1' : '0');
  }
  if (b.trustVpnRange != null) {
    if (!isTrusted(c.req)) return fail(c.res, 403, 'Kan bara ändras från hemnätverket');
    setSetting('trust_vpn_range', b.trustVpnRange ? '1' : '0');
  }
  if (b.require2faRemote != null) setSetting('require_2fa_remote', b.require2faRemote ? '1' : '0');
  if (typeof b.trustedNetworks === 'string') {
    const nets = b.trustedNetworks.split(',').map(s => s.trim()).filter(Boolean);
    if (nets.some(n => !/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-f:]+$/i.test(n))) return fail(c.res, 400, 'Ange nät som t.ex. 10.8.0.0/24, kommaseparerade');
    if (nets.some(n => n.includes('/') && parseInt(n.split('/')[1]) < 16)) return fail(c.res, 400, 'För stora nät (minst /16) – annars kan hela internet räknas som hemma');
    if (!isTrusted(c.req)) return fail(c.res, 403, 'Kan bara ändras från hemnätverket');
    setSetting('trusted_networks', nets.join(','));
  }
  if (b.trickplay != null) setSetting('trickplay', b.trickplay ? '1' : '0');
  if (b.detectRecap != null) setSetting('detect_recap', b.detectRecap ? '1' : '0');
  if (b.subAuto != null) setSetting('sub_auto', b.subAuto ? '1' : '0');
  if (typeof b.subAutoLangs === 'string') setSetting('sub_auto_langs', b.subAutoLangs.replace(/[^a-z,-]/gi, '').slice(0, 40));
  if (b.subAutoHash != null) setSetting('sub_auto_hash', b.subAutoHash ? '1' : '0');
  if (b.subAutoMax != null) setSetting('sub_auto_max', Math.max(1, Math.min(100, parseInt(b.subAutoMax) || 10)));
  if (b.subAutoRetry) run('UPDATE items SET sub_auto=0');
  if (b.allowUnrated != null) setSetting('allow_unrated', b.allowUnrated ? '1' : '0');
  if (b.backupEnabled != null) setSetting('backup_enabled', b.backupEnabled ? '1' : '0');
  if (b.backupKeep != null) setSetting('backup_keep', Math.max(1, Math.min(365, parseInt(b.backupKeep) || 14)));
  if (b.watchEnabled != null) { setSetting('watch_enabled', b.watchEnabled ? '1' : '0'); act.watchLibraries(scan); }
  if (b.maxTranscodes != null) setSetting('max_transcodes', Math.max(1, Math.min(32, parseInt(b.maxTranscodes) || 4)));
  if (b.maxTranscodesUser != null) setSetting('max_transcodes_user', Math.max(1, Math.min(16, parseInt(b.maxTranscodesUser) || 2)));
  audit('settings_changed', { ...ctx(c), detail: changed.join(', ') });
  send(c.res, 200, { ok: true });
});

// ---------- Ljudböcker ----------
const bookLib = (c) => { const l = get("SELECT * FROM libraries WHERE id=? AND type='audiobook'", +c.p.lib); if (!l) fail(c.res, 404, 'Inget ljudboksbibliotek'); return l; };
route('GET', '/api/audiobooks/:lib', user, (c) => { const l = bookLib(c); if (l) send(c.res, 200, { library: l, continue: books.continueBooks(c.user.id).filter(b => b.library === l.id), books: books.listBooks(l.id, c.user.id, c.q.get('sort') || 'title') }); });
route('GET', '/api/audiobooks/book/:bid', user, (c) => { const b = books.book(+c.p.bid, c.user.id); b ? send(c.res, 200, b) : fail(c.res, 404, 'Finns inte'); });
route('POST', '/api/audiobooks/book/:bid/progress', user, async (c) => {
  const { position, speed } = await readJson(c.req);
  const r = books.saveProgress(c.user.id, +c.p.bid, position, speed); r ? send(c.res, 200, r) : fail(c.res, 404, 'Finns inte');
});
route('POST', '/api/audiobooks/book/:bid/bookmarks', user, async (c) => {
  const { position, note } = await readJson(c.req);
  if (!get('SELECT 1 FROM books WHERE id=?', +c.p.bid)) return fail(c.res, 404, 'Finns inte');
  if (get('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id=? AND book_id=?', c.user.id, +c.p.bid).n >= 200) return fail(c.res, 400, 'För många bokmärken');
  run('INSERT INTO bookmarks(user_id,book_id,position,note,created) VALUES(?,?,?,?,?)', c.user.id, +c.p.bid, Math.max(0, +position || 0), String(note || '').slice(0, 200) || null, now());
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/audiobooks/bookmarks/:mid', user, (c) => { run('DELETE FROM bookmarks WHERE id=? AND user_id=?', +c.p.mid, c.user.id); send(c.res, 200, { ok: true }); });
route('GET', '/api/audiobooks/cover/:bid', img, (c) => {
  const f = books.coverPath(+c.p.bid);
  if (!f) return fail(c.res, 404, 'Inget omslag');
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); fs.createReadStream(f).pipe(c.res);
});
const bookFile = (c) => { const f = books.fileRow(+c.p.fid); if (!f) fail(c.res, 404, 'Finns inte'); return f; };
route('GET', '/api/audiobooks/files/:fid/stream', user, (c) => { const f = bookFile(c); if (f) music.streamTrack(c.req, c.res, f, c.q); });
route('HEAD', '/api/audiobooks/files/:fid/stream', user, (c) => { const f = bookFile(c); if (f) music.streamTrack(c.req, c.res, f, c.q); });

// ---------- Poddar ----------
route('GET', '/api/podcasts', user, (c) => send(c.res, 200, { podcasts: pods.list(c.user.id), latest: pods.latest(c.user.id, 30), canAdd: c.user.max_age == null }));
route('POST', '/api/podcasts', user, async (c) => {
  if (c.user.max_age != null) return fail(c.res, 403, 'Barnprofiler kan inte lägga till poddar');
  const { url } = await readJson(c.req);
  try { const id = await pods.subscribe(url, c.user); audit('podcast_added', { ...ctx(c), detail: String(url).slice(0, 200) }); send(c.res, 200, { id }); }
  catch (e) { fail(c.res, 400, e.message); }
});
route('GET', '/api/podcasts/:pid', user, (c) => { const p = pods.podcast(+c.p.pid, c.user.id); p ? send(c.res, 200, p) : fail(c.res, 404, 'Finns inte'); });
route('PUT', '/api/podcasts/:pid', user, async (c) => {
  const { keep } = await readJson(c.req);
  if (keep != null) run('UPDATE podcasts SET keep=? WHERE id=?', Math.max(0, Math.min(50, parseInt(keep) || 0)), +c.p.pid);
  send(c.res, 200, { ok: true });
});
route('POST', '/api/podcasts/:pid/refresh', user, async (c) => { try { send(c.res, 200, await pods.refresh(+c.p.pid)); } catch (e) { fail(c.res, 502, e.message); } });
route('DELETE', '/api/podcasts/:pid', user, (c) => {
  const p = get('SELECT * FROM podcasts WHERE id=?', +c.p.pid); if (!p) return fail(c.res, 404, 'Finns inte');
  if (!c.user.is_admin && p.added_by !== c.user.id) return fail(c.res, 403, 'Bara den som lade till podden eller en administratör kan ta bort den');
  pods.unsubscribe(p.id); send(c.res, 200, { ok: true });
});
route('GET', '/api/podcasts/:pid/image', img, (c) => {
  const f = pods.imagePath(+c.p.pid); if (!f) return fail(c.res, 404, 'Ingen bild');
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); fs.createReadStream(f).pipe(c.res);
});
route('POST', '/api/podcasts/episodes/:eid/progress', user, async (c) => {
  const { position, played } = await readJson(c.req);
  const r = pods.saveProgress(c.user.id, +c.p.eid, position, played); r ? send(c.res, 200, r) : fail(c.res, 404, 'Finns inte');
});
route('POST', '/api/podcasts/episodes/:eid/download', user, (c) => { pods.download(+c.p.eid); send(c.res, 200, { ok: true }); });
const podEp = (c) => { const e = pods.episodeRow(+c.p.eid); if (!e) fail(c.res, 404, 'Finns inte'); return e; };
route('GET', '/api/podcasts/episodes/:eid/stream', user, async (c) => { const e = podEp(c); if (e) await pods.stream(c.req, c.res, e).catch(er => fail(c.res, 502, er.message)); });
route('HEAD', '/api/podcasts/episodes/:eid/stream', user, async (c) => { const e = podEp(c); if (e) await pods.stream(c.req, c.res, e).catch(er => fail(c.res, 502, er.message)); });

// ---------- Sonarr/Radarr och önskemål ----------
route('POST', '/api/webhook/arr', pub, async (c) => {
  if (!arr.checkKey(c.q.get('key'))) { audit('webhook_denied', { ip: clientIp(c.req) }); return fail(c.res, 403, 'Fel nyckel'); }
  const b = await readJson(c.req, 2 << 20);
  const w = arr.parseWebhook(b);
  if (arr.SCAN_EVENTS.test(w.event)) { for (const id of w.libIds) scan(id); console.log(`[arr] ${w.event}: ${w.title || ''} → skannar`); }
  send(c.res, 200, { ok: true, event: w.event, scanned: arr.SCAN_EVENTS.test(w.event) ? w.libIds.length : 0 });
});
const canRequest = (u) => getSetting('requests_enabled', '1') === '1' && u.max_age == null && (arr.configured('movie') || arr.configured('show') || getSetting('requests_without_arr', '1') === '1');
const reqShape = (r) => ({ id: r.id, kind: r.kind, tmdbId: r.tmdb_id, title: r.title, year: r.year, poster: r.poster, overview: r.overview, status: r.status, note: r.note,
  user: r.user_name, userId: r.user_id, created: r.created });
route('GET', '/api/requests/search', user, async (c) => {
  if (!canRequest(c.user)) return fail(c.res, 403, 'Önskemål är inte tillgängliga');
  if (!hasTmdb()) return fail(c.res, 400, 'Kräver en TMDB-nyckel (Administration → Inställningar)');
  const kind = c.q.get('kind') === 'show' ? 'show' : 'movie';
  try {
    const res = await tmdbSearch(kind, String(c.q.get('q') || '').slice(0, 100), null);
    send(c.res, 200, res.map(r => {
      const lib = get('SELECT id FROM items WHERE tmdb_id=? AND kind=?', r.id, kind);
      const rq = get('SELECT status FROM requests WHERE tmdb_id=? AND kind=?', r.id, kind);
      return { ...r, kind, inLibrary: lib?.id || null, request: rq?.status || null };
    }));
  } catch (e) { fail(c.res, 502, 'TMDB: ' + e.message); }
});
async function sendRequest(row) {
  if (!arr.configured(row.kind)) { arr.setStatus(row.id, 'approved', 'Godkänd – lägg till manuellt (Radarr/Sonarr är inte inställt)'); return; }
  try { const r = await arr.send(row, tvdbOf); arr.setStatus(row.id, 'sent', r.already ? 'Fanns redan i ' + (row.kind === 'movie' ? 'Radarr' : 'Sonarr') : null); }
  catch (e) { arr.setStatus(row.id, 'failed', e.message); throw e; }
}
route('GET', '/api/requests', user, (c) => send(c.res, 200, {
  canRequest: canRequest(c.user), radarr: arr.configured('movie'), sonarr: arr.configured('show'), autoApprove: getSetting('requests_auto', '0') === '1',
  items: all('SELECT * FROM requests ORDER BY created DESC LIMIT 300').map(reqShape)
}));
route('POST', '/api/requests', user, async (c) => {
  if (!canRequest(c.user)) return fail(c.res, 403, 'Önskemål är inte tillgängliga');
  const { kind, tmdbId, title, year, poster, overview } = await readJson(c.req);
  if (!['movie', 'show'].includes(kind) || !(+tmdbId > 0) || !title) return fail(c.res, 400, 'Ogiltig önskan');
  if (poster && !/^https:\/\/image\.tmdb\.org\//.test(poster)) return fail(c.res, 400, 'Ogiltig bild');
  const open = get("SELECT COUNT(*) AS n FROM requests WHERE user_id=? AND status='pending'", c.user.id).n;
  if (open >= 20 && !c.user.is_admin) return fail(c.res, 429, 'Du har redan 20 obesvarade önskemål');
  const { row, existing } = arr.create(c.user, { kind, tmdbId: +tmdbId, title, year: +year || null, poster, overview });
  if (existing) return send(c.res, 200, reqShape(row));
  audit('request_created', { ...ctx(c), detail: `${title} (${kind})` });
  if (c.user.is_admin || getSetting('requests_auto', '0') === '1') { try { await sendRequest(row); } catch (e) { return fail(c.res, 502, e.message); } }
  else notifier.notify('request', 'Ny önskan', `${c.user.name} önskar ${kind === 'movie' ? 'filmen' : 'serien'} ${title}${year ? ` (${year})` : ''}.`);
  send(c.res, 200, reqShape(get('SELECT * FROM requests WHERE id=?', row.id)));
});
route('POST', '/api/requests/:rid/approve', admin, async (c) => {
  const row = get('SELECT * FROM requests WHERE id=?', +c.p.rid); if (!row) return fail(c.res, 404, 'Finns inte');
  try { await sendRequest(row); audit('request_approved', { ...ctx(c), detail: row.title }); send(c.res, 200, reqShape(get('SELECT * FROM requests WHERE id=?', row.id))); }
  catch (e) { fail(c.res, 502, e.message); }
});
route('POST', '/api/requests/:rid/decline', admin, async (c) => {
  const { note } = await readJson(c.req);
  arr.setStatus(+c.p.rid, 'declined', String(note || '').slice(0, 200) || null);
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/requests/:rid', user, (c) => {
  const row = get('SELECT * FROM requests WHERE id=?', +c.p.rid); if (!row) return fail(c.res, 404, 'Finns inte');
  if (!c.user.is_admin && !(row.user_id === c.user.id && row.status === 'pending')) return fail(c.res, 403, 'Kan inte tas bort');
  run('DELETE FROM requests WHERE id=?', row.id);
  send(c.res, 200, { ok: true });
});
route('GET', '/api/integrations', admin, (c) => send(c.res, 200, {
  radarrUrl: getSetting('radarr_url', process.env.RADARR_URL || ''), radarrKeySet: !!getSetting('radarr_key', process.env.RADARR_API_KEY || ''),
  radarrProfile: +getSetting('radarr_profile', '0'), radarrRoot: getSetting('radarr_root', ''),
  sonarrUrl: getSetting('sonarr_url', process.env.SONARR_URL || ''), sonarrKeySet: !!getSetting('sonarr_key', process.env.SONARR_API_KEY || ''),
  sonarrProfile: +getSetting('sonarr_profile', '0'), sonarrRoot: getSetting('sonarr_root', ''),
  pathMap: getSetting('arr_path_map', process.env.ARR_PATH_MAP || ''), webhookPath: `/api/webhook/arr?key=${arr.webhookKey()}`,
  requestsEnabled: getSetting('requests_enabled', '1') === '1', requestsAuto: getSetting('requests_auto', '0') === '1',
  traktClientId: getSetting('trakt_client_id', process.env.TRAKT_CLIENT_ID || ''), traktSecretSet: !!getSetting('trakt_client_secret', process.env.TRAKT_CLIENT_SECRET || '')
}));
route('PUT', '/api/integrations', admin, async (c) => {
  const b = await readJson(c.req);
  for (const k of ['radarr', 'sonarr']) {
    if (typeof b[k + 'Url'] === 'string') {
      const u = b[k + 'Url'].trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return fail(c.res, 400, 'Adressen ska vara t.ex. http://192.168.1.10:7878');
      setSetting(k + '_url', u);
    }
    if (typeof b[k + 'Key'] === 'string' && b[k + 'Key']) setSetting(k + '_key', b[k + 'Key'].trim());
    if (b[k + 'Profile'] != null) setSetting(k + '_profile', parseInt(b[k + 'Profile']) || 0);
    if (typeof b[k + 'Root'] === 'string') setSetting(k + '_root', b[k + 'Root']);
  }
  if (typeof b.pathMap === 'string') setSetting('arr_path_map', b.pathMap.trim().slice(0, 500));
  if (b.requestsEnabled != null) setSetting('requests_enabled', b.requestsEnabled ? '1' : '0');
  if (b.requestsAuto != null) setSetting('requests_auto', b.requestsAuto ? '1' : '0');
  if (typeof b.traktClientId === 'string') setSetting('trakt_client_id', b.traktClientId.trim());
  if (typeof b.traktSecret === 'string' && b.traktSecret) setSetting('trakt_client_secret', b.traktSecret.trim());
  if (b.newWebhookKey) setSetting('arr_webhook_key', '');
  audit('settings_changed', { ...ctx(c), detail: 'integrationer' });
  send(c.res, 200, { ok: true });
});
route('GET', '/api/integrations/arr-options', admin, async (c) => {
  try { send(c.res, 200, await arr.options(c.q.get('kind') === 'show' ? 'show' : 'movie')); } catch (e) { fail(c.res, 502, e.message); }
});
// Trakt (per användare)
route('GET', '/api/me/trakt', user, (c) => send(c.res, 200, trakt.info(c.user.id)));
route('POST', '/api/me/trakt/connect', user, async (c) => { try { send(c.res, 200, await trakt.startDevice(c.user.id)); } catch (e) { fail(c.res, 400, e.message); } });
route('POST', '/api/me/trakt/poll', user, async (c) => { try { send(c.res, 200, await trakt.pollDevice(c.user.id)); } catch (e) { fail(c.res, 502, e.message); } });
route('POST', '/api/me/trakt/sync', user, async (c) => { try { send(c.res, 200, await trakt.sync(c.user.id)); } catch (e) { fail(c.res, 502, 'Trakt: ' + e.message); } });
route('DELETE', '/api/me/trakt', user, (c) => { trakt.disconnect(c.user.id); send(c.res, 200, { ok: true }); });

// Notiser och uppdateringar
auditHooks.push(notifier.onAudit);
route('GET', '/api/notify', admin, (c) => send(c.res, 200, { kind: getSetting('notify_kind', process.env.NOTIFY_KIND || 'none'), url: getSetting('notify_url', process.env.NOTIFY_URL || ''),
  user: getSetting('notify_user', process.env.NOTIFY_USER || ''), tokenSet: !!getSetting('notify_token', process.env.NOTIFY_TOKEN || ''),
  events: getSetting('notify_events', 'security,cert,backup,update,dvr,request').split(',').filter(Boolean), kinds: notifier.KINDS, allEvents: notifier.EVENTS, recent: notifier.sent.slice(-10).reverse() }));
route('PUT', '/api/notify', admin, async (c) => {
  const b = await readJson(c.req);
  if (b.kind != null) { if (!notifier.KINDS.includes(b.kind)) return fail(c.res, 400, 'Okänd typ'); setSetting('notify_kind', b.kind); }
  if (typeof b.url === 'string') {
    const u = b.url.trim();
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return fail(c.res, 400, 'Adressen ska börja med https://');
    setSetting('notify_url', u);
  }
  if (typeof b.user === 'string') setSetting('notify_user', b.user.trim().slice(0, 200));
  if (typeof b.token === 'string' && b.token) setSetting('notify_token', b.token.trim().slice(0, 500));
  if (Array.isArray(b.events)) setSetting('notify_events', b.events.filter(e => notifier.EVENTS[e]).join(','));
  audit('settings_changed', { ...ctx(c), detail: 'notiser' });
  send(c.res, 200, { ok: true });
});
route('POST', '/api/notify/test', admin, async (c) => {
  try { await notifier.notify('test', 'Testnotis', 'Det fungerar! Så här ser larm från BraXhn TV ut.', { force: true }); send(c.res, 200, { ok: true }); }
  catch (e) { fail(c.res, 502, 'Kunde inte skicka: ' + e.message); }
});
route('GET', '/api/updates', admin, (c) => send(c.res, 200, updates.info()));
route('POST', '/api/updates/check', admin, async (c) => { await updates.check(); send(c.res, 200, updates.info()); });
route('PUT', '/api/updates', admin, async (c) => { const b = await readJson(c.req); if (b.enabled != null) setSetting('update_check', b.enabled ? '1' : '0'); send(c.res, 200, updates.info()); });

// Spelas nu, statistik och säkerhetskopior
route('GET', '/api/activity', admin, (c) => send(c.res, 200, act.listActive()));
route('POST', '/api/activity/:key/stop', admin, (c) => {
  const s = act.stopPlay(c.p.key);
  if (!s) return fail(c.res, 404, 'Uppspelningen finns inte längre');
  st.stopUserSessions(s.itemId, s.userId);
  run("DELETE FROM sessions WHERE user_id=? AND kind='media' AND scope_item=?", s.userId, s.itemId);
  audit('stream_stopped', { ...ctx(c), detail: `${s.user}: ${s.itemId}` });
  send(c.res, 200, { ok: true });
});
route('GET', '/api/stats', admin, (c) => send(c.res, 200, { ...act.stats(), active: act.listActive().length, transcodes: st.activeTranscodes().length, watching: act.watchingCount() }));
route('GET', '/api/backups', admin, (c) => send(c.res, 200, { dir: act.BACKUP_DIR, enabled: getSetting('backup_enabled', '1') === '1', keep: +getSetting('backup_keep', '14'), files: act.listBackups() }));
route('POST', '/api/backups', admin, (c) => {
  try { const name = act.backupNow(); audit('backup_created', { ...ctx(c), detail: name }); send(c.res, 200, { name }); }
  catch (e) { fail(c.res, 500, 'Säkerhetskopieringen misslyckades: ' + e.message); }
});
route('GET', '/api/backups/:name', admin, (c) => {
  const f = act.listBackups().find(b => b.name === c.p.name);
  if (!f) return fail(c.res, 404, 'Finns inte');
  audit('backup_downloaded', { ...ctx(c), detail: f.name });
  c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${f.name}"`, 'Content-Length': f.size });
  fs.createReadStream(path.join(act.BACKUP_DIR, f.name)).pipe(c.res);
});

// Extern säkerhetskopiering och återställning
route('GET', '/api/offsite', admin, (c) => {
  const k = offsite.cfg();
  send(c.res, 200, { kind: k.kind, dir: k.dir, endpoint: k.endpoint, region: k.region, bucket: k.bucket, prefix: k.prefix, accessKey: k.accessKey, vhost: k.vhost, keep: k.keep,
    secretSet: !!k.secretKey, passSet: !!k.passphrase, state: offsite.state, restorePending: fs.existsSync(RESTORE_FILE) });
});
route('PUT', '/api/offsite', admin, async (c) => {
  const b = await readJson(c.req);
  if (b.kind != null) { if (!['none', 'folder', 's3'].includes(b.kind)) return fail(c.res, 400, 'Okänd typ'); setSetting('offsite_kind', b.kind); }
  if (typeof b.dir === 'string') setSetting('offsite_dir', b.dir.trim());
  for (const [k, s] of [['endpoint', 's3_endpoint'], ['region', 's3_region'], ['bucket', 's3_bucket'], ['prefix', 's3_prefix'], ['accessKey', 's3_access_key']])
    if (typeof b[k] === 'string') setSetting(s, b[k].trim().slice(0, 300));
  if (typeof b.secretKey === 'string' && b.secretKey) setSetting('s3_secret_key', b.secretKey.trim());
  if (typeof b.passphrase === 'string' && b.passphrase) {
    if (b.passphrase.length < 12) return fail(c.res, 400, 'Lösenfrasen ska vara minst 12 tecken');
    setSetting('offsite_pass', b.passphrase);
  }
  if (b.vhost != null) setSetting('s3_vhost', b.vhost ? '1' : '0');
  if (b.keep != null) setSetting('offsite_keep', Math.max(1, Math.min(365, parseInt(b.keep) || 30)));
  audit('settings_changed', { ...ctx(c), detail: 'extern säkerhetskopiering' });
  send(c.res, 200, { ok: true });
});
route('POST', '/api/offsite/test', admin, async (c) => {
  try { await offsite.test(); send(c.res, 200, { ok: true }); } catch (e) { fail(c.res, 400, e.message); }
});
route('POST', '/api/offsite/run', admin, async (c) => {
  try { const name = act.backupNow(); const r = await offsite.upload(path.join(act.BACKUP_DIR, name)); audit('backup_created', { ...ctx(c), detail: 'extern: ' + r }); send(c.res, 200, { name: r }); }
  catch (e) { fail(c.res, 400, e.message); }
});
route('GET', '/api/offsite/list', admin, async (c) => {
  try { send(c.res, 200, await offsite.list()); } catch (e) { fail(c.res, 502, e.message); }
});
// Förbered återställning – databasen byts vid nästa omstart av containern
route('POST', '/api/restore', admin, async (c) => {
  const { local, remote } = await readJson(c.req);
  try {
    if (local) {
      const f = act.listBackups().find(b => b.name === local);
      if (!f) return fail(c.res, 404, 'Finns inte');
      fs.copyFileSync(path.join(act.BACKUP_DIR, f.name), RESTORE_FILE + '.part');
      fs.renameSync(RESTORE_FILE + '.part', RESTORE_FILE);
    } else if (remote) await offsite.fetchAndDecrypt(String(remote), RESTORE_FILE);
    else return fail(c.res, 400, 'Välj en säkerhetskopia');
    audit('restore_prepared', { ...ctx(c), detail: local || remote });
    send(c.res, 200, { ok: true });
  } catch (e) { fs.rmSync(RESTORE_FILE, { force: true }); fail(c.res, 400, e.message); }
});
route('DELETE', '/api/restore', admin, (c) => { fs.rmSync(RESTORE_FILE, { force: true }); send(c.res, 200, { ok: true }); });

// Revisionslogg och säkerhetskontroll
route('GET', '/api/audit', admin, (c) => {
  const lim = Math.min(500, parseInt(c.q.get('limit')) || 200);
  const ev = c.q.get('event');
  send(c.res, 200, ev ? all('SELECT * FROM audit WHERE event LIKE ? ORDER BY id DESC LIMIT ?', ev + '%', lim) : all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', lim));
});
route('GET', '/api/security-check', admin, (c) => {
  const items = [];
  const add = (level, title, detail) => items.push({ level, title, detail });
  const pub = getSetting('public_url', process.env.PUBLIC_URL || '');
  const https = isHttps(c.req);
  if (pub && !pub.startsWith('https://')) add('bad', 'Publik adress använder inte HTTPS', 'Lösenord och strömmar skickas okrypterat över internet. Använd en omvänd proxy med Let\'s Encrypt eller inbyggd HTTPS.');
  else if (pub) add('ok', 'Publik adress använder HTTPS', pub);
  else add('info', 'Ingen publik adress angiven', 'Servern verkar bara användas på hemnätet/VPN. Ange publik adress om den nås från internet.');
  if (!isLocalReq(c.req) && !https) add('bad', 'Du är ansluten utifrån utan HTTPS', 'Den här anslutningen är okrypterad.');
  const cip = clientIp(c.req), pip = peerIp(c.req);
  add('info', `Din adress enligt servern: ${cip}`, pip !== cip ? `Via proxy ${pip}. Stämmer inte adressen? Kontrollera att proxyn skickar X-Forwarded-For.` :
    (isPrivate(pip) && pub ? 'Om du ansluter utifrån och ändå ser en lokal adress här skickar proxyn/NAT inte klientens adress – då räknas alla som "hemma". Se README.' : ''));
  const admins = all('SELECT name, totp_enabled FROM users WHERE is_admin=1');
  const no2fa = admins.filter(a => !a.totp_enabled).map(a => a.name);
  if (no2fa.length) add(pub ? 'bad' : 'warn', 'Administratörer utan tvåstegsverifiering', no2fa.join(', ') + ' – aktivera under Mitt konto.');
  else add('ok', 'Alla administratörer har tvåstegsverifiering', '');
  const users = all('SELECT name, totp_enabled, remote_allowed FROM users WHERE is_admin=0');
  const uNo = users.filter(u => !u.totp_enabled && u.remote_allowed).map(u => u.name);
  if (uNo.length) add(require2faRemote() ? 'ok' : 'warn', 'Användare med fjärråtkomst utan tvåstegsverifiering', uNo.join(', ') + (require2faRemote() ? ' – de kan bara logga in på hemnätet tills 2FA aktiverats.' : ' – överväg "Kräv tvåstegsverifiering utanför hemmet".'));
  add(adminAnywhere() ? 'warn' : 'ok', adminAnywhere() ? 'Administration tillåten från internet' : 'Administration endast från hemnät/VPN', adminAnywhere() ? 'Slå av om du inte behöver administrera utifrån.' : '');
  add(require2faRemote() ? 'ok' : 'warn', require2faRemote() ? 'Tvåstegsverifiering krävs utanför hemmet' : 'Tvåstegsverifiering krävs inte utanför hemmet', '');
  const fails = get(`SELECT COUNT(*) AS n FROM audit WHERE event IN ('login_fail','login_locked','login_denied') AND ts > ?`, now() - 86400).n;
  add(fails > 50 ? 'bad' : fails > 10 ? 'warn' : 'ok', `${fails} misslyckade inloggningar senaste dygnet`, fails > 10 ? 'Se säkerhetsloggen. Överväg geoblockering eller CrowdSec i OPNsense.' : '');
  if (typeof process.getuid === 'function' && process.getuid() === 0) add('warn', 'Servern körs som root', 'Kör containern med PUID/PGID (standard i Unraid-mallen).');
  else add('ok', 'Servern körs utan root-rättigheter', '');
  const old = all(`SELECT name FROM users WHERE pass NOT LIKE 's2:%'`).map(u => u.name);
  if (old.length) add('warn', 'Konton med äldre lösenordsformat', old.join(', ') + ' – uppgraderas automatiskt vid nästa lösenordsbyte.');
  send(c.res, 200, items);
});

// ---------- statiska filer ----------
// Content Security Policy: bara egna skript (plus Googles Cast-SDK och reserv-CDN för hls.js/QR)
const CSP = ["default-src 'self'", "script-src 'self' https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https://image.tmdb.org", "media-src 'self' blob:", "connect-src 'self'",
  "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "frame-src https://www.gstatic.com"].join('; ');
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '');
  let f;
  try { f = path.normalize(path.join(WEB, decodeURIComponent(pathname))); } catch { return fail(res, 400, ''); }
  if (f !== WEB && !f.startsWith(WEB + path.sep)) return fail(res, 403, '');
  fs.stat(f, (e, s) => {
    if (e || s.isDirectory()) {
      // Saknade filer med filändelse (t.ex. /vendor/x.js) ger 404 i stället för startsidan
      if (path.extname(f) && !s?.isDirectory()) return fail(res, 404, 'Hittades inte');
      f = path.join(WEB, 'index.html');
    }
    fs.readFile(f, (e2, data) => {
      if (e2) return fail(res, 404, 'Hittades inte');
      const ext = path.extname(f);
      const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=3600' };
      if (ext === '.html') h['Content-Security-Policy'] = CSP;
      send(res, 200, data, h);
    });
  });
}

// CSRF: ändrande anrop med cookie-inloggning måste komma från samma origin
function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = (isPrivate(req.socket.remoteAddress) && req.headers['x-forwarded-host']) || req.headers.host;
  if (origin) { try { return new URL(origin).host === host; } catch { return false; } }
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

export async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return fail(res, 400, 'Ogiltig adress'); }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (!url.pathname.startsWith('/api/stream/')) res.setHeader('X-Frame-Options', 'DENY');
  if (isHttps(req) && process.env.HSTS !== '0') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  if (url.pathname.startsWith('/.well-known/acme-challenge/')) {
    const ka = acme.challenges.get(url.pathname.slice(28));
    return ka ? send(res, 200, ka, { 'Content-Type': 'text/plain' }) : fail(res, 404, 'Finns inte');
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  // Chromecast-mottagare och andra enheter hämtar media från annan origin
  if (url.pathname.startsWith('/api/stream/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' }); return res.end(); }
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    let p;
    try { p = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); } catch { return fail(res, 400, 'Ogiltig adress'); }
    const c = { req, res, q: url.searchParams, p, user: userFromReq(req, url.searchParams, !!(r.media || r.img)) };
    const u = c.user;
    if (u) {
      // Kortlivade token gäller bara där de är avsedda
      if (u.kind === 'media' && !(r.media || r.img)) c.user = null;
      else if (u.kind === 'media' && u.scope_item && String(u.scope_item) !== (r.music ? String(-(+p.tid)) : String(p.id))) c.user = null;
      else if (u.kind === 'img' && !r.img) c.user = null;
    }
    if (r.auth && !c.user) return fail(res, 401, 'Inte inloggad');
    if (c.user) {
      const trusted = isTrusted(req);
      if (!trusted && !c.user.remote_allowed) return fail(res, 403, 'Ditt konto får bara användas på hemnätverket');
      // Profiler ärver huvudkontots tvåstegsverifiering (de nås bara via ett inloggat hushåll)
      const owner = c.user.parent_id || c.user.id;
      const has2fa = c.user.totp_enabled || (c.user.parent_id && get('SELECT totp_enabled FROM users WHERE id=?', c.user.parent_id)?.totp_enabled) || pk.hasPasskey(owner);
      if (!trusted && (c.user.kind === 'web' || c.user.kind === 'app') && require2faRemote() && !has2fa) return fail(res, 403, 'Tvåstegsverifiering krävs utanför hemmet');
    }
    if (r.admin) {
      if (!c.user.is_admin) return fail(res, 403, 'Kräver administratör');
      if (!adminAnywhere() && !isTrusted(req)) { audit('admin_denied', { user: c.user, ip: clientIp(req), detail: url.pathname }); return fail(res, 403, 'Administration är bara tillåten från hemnätverket eller VPN'); }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && c.user?.via === 'cookie' && !sameOrigin(req)) return fail(res, 403, 'Förfrågan från annan webbplats nekades');
    if (!c.user && !['GET', 'HEAD'].includes(req.method) && !sameOrigin(req) && r.method === 'POST' && /\/api\/(login|setup|passkey\/login)$/.test(url.pathname) && req.headers.origin) return fail(res, 403, 'Förfrågan från annan webbplats nekades');
    try { return await r.fn(c); }
    catch (e) { if (!e.status) console.error(e); return fail(res, e.status || 500, e.status ? e.message : 'Internt fel'); }
  }
  fail(res, 404, 'Okänd endpoint');
}

// Filbevakning: skanna direkt när filer läggs till/tas bort (med periodisk skanning som reserv)
setTimeout(() => act.watchLibraries(scan), 5000);

// Periodisk skanning
let lastAuto = Date.now();
setInterval(() => {
  const min = +getSetting('scan_interval', process.env.SCAN_INTERVAL || '60');
  if (min > 0 && Date.now() - lastAuto > min * 60000 && !scanStatus.running) { lastAuto = Date.now(); scan(); }
}, 30000).unref();
