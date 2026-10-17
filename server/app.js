import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream';
import { get, all, run, tx, now, getSetting, setSetting, IMAGES, RESTORE_FILE } from './db.js';
import { send, fail, readJson, MIME, clientIp, peerIp, isLocalReq, isHttps, isPrivate, inCidr } from './util.js';
import { ipKey, hashPw, checkPw, dummyCheck, weakPassword, createSession, cookieHeader, userFromReq, listSessions, ipBlocked, userLocked, noteFail,
  clearFails, auditHooks, newTotpSecret, totpUri, verifyTotp, newRecoveryCodes, useRecoveryCode, audit, require2faRemote, clearCookies } from './auth.js';
import { scan, status as scanStatus, refreshItem, extractThumb, removeImages, hooks, tmdbSearch, autoSubs, readChapters, tvdbOf, hasTmdb } from './scanner.js';
import * as st from './stream.js';
import * as os from './opensubtitles.js';
import { detectMarkers } from './intro.js';
import * as act from './activity.js';
import * as trick from './trickplay.js';
import * as music from './music.js';
import * as listen from './listening.js';
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
import * as live from './livetv.js';
import * as dvr from './dvr.js';
import * as comskip from './comskip.js';
import * as timeshift from './timeshift.js';
import * as streaming from './streaming.js';
import { checkManifest } from './verify.js';
import { tmdb } from './scanner.js';
import { streamFile } from './util.js';
import * as people from './people.js';
import * as trailers from './trailers.js';
import * as wrapped from './wrapped.js';
import * as ver from './versions.js';
import * as screen from './screentime.js';
import * as follows from './follows.js';
import * as diskmon from './diskmon.js';
import * as metrics from './metrics.js';
import * as dlna from './dlna.js';
import * as mediaImport from './mediaimport.js';

// Skanningen kontrollerar bara att nyckelbildsfilen finns (läser inte in alla listor i minnet)
hooks.keyframes = (it) => st.keyframesCached(it) ? null : st.computeKeyframes(it);
hooks.markers = (lib, status) => detectMarkers(lib, status);
hooks.trickplay = (lib, status) => trick.generateLibrary(lib, status);
hooks.music = (lib, status) => music.scanMusic(lib, status);
hooks.subtitlesOf = (it) => st.subtitlesOf(it);
hooks.afterScan = () => arr.markAvailable();
hooks.audiobooks = (lib, status) => books.scanBooks(lib, status);
hooks.newEpisodes = (ids) => follows.onNewEpisodes(ids, (uid, it) => allowedFor(uid, it));

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/media');
import { VERSION } from './updates.js';

// ---------- formning av objekt ----------
// Avsnittsräkning behövs bara för serier (CASE gör att underfrågorna inte körs för filmer/avsnitt)
const PROG = `p.position AS p_pos, p.watched AS p_watched, p.updated AS p_updated,
  CASE WHEN i.kind='show' THEN (SELECT COUNT(*) FROM items e WHERE e.parent_id=i.id) END AS ep_total,
  CASE WHEN i.kind='show' THEN (SELECT COUNT(*) FROM items e JOIN progress q ON q.item_id=e.id AND q.user_id=p_uid.uid AND q.watched=1 WHERE e.parent_id=i.id) END AS ep_watched`;
// Kolumner som shape() använder – inte tunga fält som streams/chapters (och overview i listvyer)
const COLS = `i.id, i.kind, i.title, i.year, i.library_id, i.poster, i.backdrop, i.thumb, i.duration, i.rating, i.added, i.hdr,
  i.genres, i.cert, i.age, i.collection_id, i.season, i.episode, i.parent_id, i.height,
  i.intro_start, i.intro_end, i.credits_start, i.recap_start, i.recap_end, i.trickplay`;
const FROM = `FROM items i JOIN (SELECT ? AS uid) p_uid LEFT JOIN progress p ON p.item_id=i.id AND p.user_id=p_uid.uid`;

// Integritetskontroll: vid start och högst var 10:e minut (läser alla programfiler)
let integCache = null, integAt = 0;
const integrity = () => { if (Date.now() - integAt > 600e3) { try { integCache = checkManifest(); } catch { integCache = null; } integAt = Date.now(); } return integCache; };
setTimeout(() => { const r = integrity(); if (r && !r.ok) console.warn('[integritet] ändrade programfiler:', [...r.changed, ...r.added].join(', ')); else if (r) console.log(`[integritet] ${r.files} programfiler stämmer`); }, 2000).unref();
const chaptersOf = (it) => { try { return JSON.parse(it.chapters || '[]'); } catch { return []; } };
function shape(r) {
  const o = {
    id: r.id, kind: r.kind, title: r.title, year: r.year, library: r.library_id,
    poster: !!r.poster, backdrop: !!r.backdrop, thumb: !!r.thumb,
    duration: r.duration, rating: r.rating, overview: r.overview ?? undefined, added: r.added, hdr: r.hdr || null,
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
  // Avsnitt ärver seriens och filmversioner huvudradens åldersgräns
  const from = it.parent_id || it.version_of;
  if (age == null && from) age = get('SELECT age FROM items WHERE id=?', from)?.age;
  return age == null ? allowUnrated() : age <= max;
}
/** Åldersfilter för SQL (alias i = titeln, s = ev. serie) */
function ageFilter(uid) {
  const max = maxAgeOf(uid);
  return max == null ? { sql: '', params: [] } : { sql: ` AND COALESCE(i.age, s.age, ?) <= ?`, params: [allowUnrated() ? max : 999, max] };
}
// Filmversioner (version_of) listas aldrig – bara huvudraden syns i listor, sök och rekommendationer
const MAIN_ONLY = ' AND i.version_of IS NULL';
/** slim: utan beskrivning (för stora listor där den inte visas); versions: även filmversioner (bara för uppslag på id) */
const listItems = (uid, where, params = [], order = 'i.sort_title', limit = 500, offset = 0, { slim = false, versions = false } = {}) => {
  const age = ageFilter(uid);
  return all(`SELECT ${COLS}${slim ? '' : ', i.overview'}, s.title AS show_title, ${PROG} ${FROM} LEFT JOIN items s ON s.id=i.parent_id WHERE (${where})${versions ? '' : MAIN_ONLY}${age.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    uid, ...params, ...age.params, limit, offset).map(shape);
};
const oneItem = (uid, id) => listItems(uid, 'i.id=?', [id], 'i.id', 1, 0, { versions: true })[0];

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
  ELSE (SELECT COUNT(*) FROM items i WHERE i.library_id=l.id AND i.kind IN('movie','show') AND i.version_of IS NULL) END AS count FROM libraries l ORDER BY l.type IN ('music','audiobook'), l.type, l.name`)));
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
  // Även sedda titlar som man börjat se om (position > 0) räknas
  const cont = listItems(uid, `i.kind IN('movie','episode') AND p.position > 0`, [], 'p.updated DESC', 20);
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
  const forYou = listItems(uid, follows.FOR_YOU_WHERE, [], follows.FOR_YOU_ORDER, 30);
  send(c.res, 200, { continue: cont, rows, watchlist, recommended, forYou });
});
const SORTS = { title: 'i.sort_title', added: 'i.added DESC', year: 'i.year DESC, i.sort_title', rating: 'i.rating DESC NULLS LAST, i.sort_title' };
route('GET', '/api/libraries/:id/items', user, (c) => {
  const lib = get('SELECT * FROM libraries WHERE id=?', c.p.id);
  if (!lib) return fail(c.res, 404, 'Biblioteket finns inte');
  const where = [`i.library_id=?`, `i.kind=?`], params = [lib.id, lib.type];
  const filter = c.q.get('filter');
  if (filter === 'unwatched') where.push(lib.type === 'show' ? 'ep_watched < ep_total' : 'COALESCE(p.watched,0)=0');
  if (filter === 'watched') where.push(lib.type === 'show' ? 'ep_watched = ep_total' : 'p.watched=1');
  // Valfri sidindelning (?limit=&offset=); utan den skickas hela biblioteket (upp till 5000) som tidigare
  const limit = Math.min(10000, Math.max(1, parseInt(c.q.get('limit')) || 5000)), offset = Math.max(0, parseInt(c.q.get('offset')) || 0);
  const out = { library: lib, items: listItems(c.user.id, where.join(' AND '), params, SORTS[c.q.get('sort')] || SORTS.title, limit, offset, { slim: true }) };
  // ?collections=1: filmer i samma samling (minst två synliga i listan) visas som ett samlingskort på den första filmens plats
  if (lib.type === 'movie' && c.q.get('collections') === '1') out.items = collapseCollections(out.items);
  if (c.q.has('limit') || c.q.has('offset')) {
    const age = ageFilter(c.user.id);
    out.total = get(`SELECT COUNT(*) AS n FROM (SELECT ${PROG} ${FROM} LEFT JOIN items s ON s.id=i.parent_id WHERE (${where.join(' AND ')})${MAIN_ONLY}${age.sql})`, c.user.id, ...params, ...age.params).n;
    out.offset = offset; out.limit = limit;
  }
  send(c.res, 200, out);
});
route('GET', '/api/search', user, (c) => {
  const q = `%${(c.q.get('q') || '').trim()}%`;
  if (q.length < 3) return send(c.res, 200, []);
  send(c.res, 200, listItems(c.user.id, `(i.title LIKE ? OR (i.kind='show' AND i.overview LIKE ?))`, [q, q],
    `CASE i.kind WHEN 'movie' THEN 0 WHEN 'show' THEN 0 ELSE 1 END, i.sort_title`, 60));
});
route('GET', '/api/items/:id', user, (c) => {
  const uid = c.user.id, row = get('SELECT * FROM items WHERE id=?', c.p.id);
  if (!row) return fail(c.res, 404, 'Finns inte');
  // En filmversion visas som filmen (huvudraden) med just den versionens filinformation
  const it = ver.mainOf(row);
  if (!allowedFor(uid, it)) return fail(c.res, 403, 'Inte tillgänglig i den här profilen');
  const out = oneItem(uid, it.id);
  const versions = it.kind === 'movie' ? ver.versionsOf(it) : [it];
  const wanted = row.version_of ? row.id : +c.q.get('version') || it.id;
  const file = versions.find(v => v.id === wanted) || it;
  if (versions.length > 1) { out.versions = ver.versionList(versions); out.version = file.id; }
  out.inWatchlist = !!get('SELECT 1 FROM watchlist WHERE user_id=? AND item_id=?', uid, it.kind === 'episode' ? it.parent_id : it.id);
  Object.assign(out, titleExtras(c.user, it)); // rollista och trailers
  if (it.collection_id) {
    const col = get('SELECT * FROM collections WHERE id=?', it.collection_id);
    if (col) out.collectionInfo = { id: col.id, name: col.name, items: listItems(uid, 'i.collection_id=? AND i.kind=\'movie\'', [col.id], 'i.year', 50) };
  }
  if (it.kind !== 'episode') out.similar = similarTo(uid, it, 12);
  if (it.kind === 'show') {
    Object.assign(out, follows.followInfo(uid, it.id));
    out.children = listItems(uid, 'i.parent_id=?', [it.id], 'i.season, i.episode', 5000);
    out.next = out.children.find(e => !e.watched && e.position > 0) || out.children.find(e => !e.watched) || out.children[0] || null;
  } else {
    Object.assign(out, {
      file: path.basename(file.path), size: file.size, container: file.container, vcodec: file.vcodec, acodec: file.acodec,
      width: file.width, height: file.height, hdr: file.hdr || null, chapters: chaptersOf(file),
      audio: st.streamsOf(file).filter(s => s.type === 'audio'), subtitles: st.subtitlesOf(file).map(({ file, ...s }) => s)
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
  let it = get('SELECT id, kind, parent_id, version_of, age, duration, title, tmdb_id, season, episode FROM items WHERE id=? AND kind!=\'show\'', c.p.id);
  if (!it) return fail(c.res, 404, 'Finns inte');
  // Framsteg gäller filmen oavsett vilken version som spelades
  if (it.version_of) it = get('SELECT id, kind, parent_id, version_of, age, duration, title, tmdb_id, season, episode FROM items WHERE id=?', it.version_of) || it;
  if (!allowedFor(c.user.id, it)) return fail(c.res, 403, 'Inte tillgänglig i den här profilen');
  const dur = it.duration || +duration || 0;
  const rawPos = Math.max(0, +position || 0);
  let pos = rawPos;
  const prev = get('SELECT watched, position FROM progress WHERE user_id=? AND item_id=?', c.user.id, it.id);
  const wasWatched = !!prev?.watched;
  const watched = dur && (pos / dur > 0.92 || dur - pos < 120 && pos > 60) ? 1 : 0;
  // Omtittning av en sedd titel: sedd-markeringen behålls men positionen sparas (syns i "Fortsätt titta")
  // när man kommit en bit in – att bara öppna titeln en kort stund lägger inte till den.
  if (wasWatched && !watched && pos < 60) pos = 0;
  run(`INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,item_id) DO UPDATE SET position=excluded.position, duration=excluded.duration,
    watched=MAX(watched,excluded.watched), updated=excluded.updated`, c.user.id, it.id, watched ? 0 : pos, dur, watched, now());
  if (watched && !wasWatched) trakt.scrobble(c.user.id, get('SELECT * FROM items WHERE id=?', it.id), 'stop', 100).catch(() => {});
  if (watched && !wasWatched && it.kind === 'episode') follows.autoFollow(c.user.id, it.id);
  // Smakprofilen påverkas bara när titeln blir sedd eller passerar 5 minuter
  if ((watched && !wasWatched) || (pos > 300 && !((prev?.position || 0) > 300))) invalidateProfile(c.user.id);
  act.touch(c.user.id, it.id, rawPos);
  const sc = screen.heartbeat(c.user.id, 'i:' + it.id, rawPos);
  send(c.res, 200, { watched: !!watched, stop: act.isStopped(c.user.id, it.id) || (!!sc && !sc.allowed), ...(sc ? { screenTime: sc } : {}) });
});
route('POST', '/api/items/:id/watched', user, async (c) => {
  const { watched } = await readJson(c.req);
  const row = get('SELECT id,kind,version_of FROM items WHERE id=?', c.p.id);
  if (!row) return fail(c.res, 404, 'Finns inte');
  const it = row.version_of ? { id: row.version_of, kind: row.kind } : row; // sedd gäller filmen, inte filen
  const ids = it.kind === 'show' ? all('SELECT id FROM items WHERE parent_id=?', it.id).map(r => r.id) : [it.id];
  const season = c.q.get('season');
  const targets = season != null && it.kind === 'show'
    ? all('SELECT id FROM items WHERE parent_id=? AND season=?', it.id, +season).map(r => r.id) : ids;
  tx(() => { for (const id of targets) run(`INSERT INTO progress(user_id,item_id,position,watched,updated) VALUES(?,?,0,?,?)
    ON CONFLICT(user_id,item_id) DO UPDATE SET position=0, watched=excluded.watched, updated=excluded.updated`, c.user.id, id, watched ? 1 : 0, now()); });
  invalidateProfile(c.user.id);
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
route('GET', '/api/music/:lib/home', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, { library: l, ...music.musicHome(l.id, c.user.id), playlists: music.playlists(c.user.id), smart: listen.smartLists(l.id, c.user.id) }); });
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
route('GET', '/api/music/tracks/:tid/stream', audio, (c) => { const t = trackRow(c); if (t && !screenBlock(c, { audio: true })) music.streamTrack(c.req, c.res, t, c.q); });
route('HEAD', '/api/music/tracks/:tid/stream', audio, (c) => { const t = trackRow(c); if (t && !screenBlock(c, { audio: true })) music.streamTrack(c.req, c.res, t, c.q); });
// Kortlivad länk till ett spår (för appar, Chromecast och AirPlay)
route('GET', '/api/music/tracks/:tid/play', user, (c) => {
  const t = trackRow(c); if (!t || screenBlock(c, { audio: true })) return;
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
  const id = tx(() => {
    const id = Number(run('INSERT INTO playlists(user_id,name,created) VALUES(?,?,?)', c.user.id, nm, now()).lastInsertRowid);
    (Array.isArray(trackIds) ? trackIds.slice(0, 5000) : []).forEach((t, i) => { if (get('SELECT 1 FROM tracks WHERE id=?', +t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', id, +t, i); });
    return id;
  });
  send(c.res, 200, { id });
});
route('GET', '/api/music/playlists/:pid', user, (c) => { const p = music.playlist(+c.p.pid, c.user.id); p ? send(c.res, 200, p) : fail(c.res, 404, 'Finns inte'); });
route('PUT', '/api/music/playlists/:pid', user, async (c) => {
  const p = get('SELECT * FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id);
  if (!p) return fail(c.res, 404, 'Finns inte');
  const { name, trackIds } = await readJson(c.req);
  if (name) run('UPDATE playlists SET name=? WHERE id=?', String(name).trim().slice(0, 100), p.id);
  if (Array.isArray(trackIds)) { // ny ordning / nytt innehåll
    tx(() => {
      run('DELETE FROM playlist_items WHERE playlist_id=?', p.id);
      trackIds.slice(0, 5000).forEach((t, i) => { if (get('SELECT 1 FROM tracks WHERE id=?', +t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', p.id, +t, i); });
    });
  }
  send(c.res, 200, { ok: true });
});
route('POST', '/api/music/playlists/:pid/tracks', user, async (c) => {
  const p = get('SELECT * FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id);
  if (!p) return fail(c.res, 404, 'Finns inte');
  const { trackIds } = await readJson(c.req);
  let pos = (get('SELECT MAX(pos) AS m FROM playlist_items WHERE playlist_id=?', p.id).m ?? -1) + 1;
  tx(() => { for (const t of (Array.isArray(trackIds) ? trackIds : []).slice(0, 2000)) if (get('SELECT 1 FROM tracks WHERE id=?', +t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', p.id, +t, pos++); });
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/music/playlists/:pid', user, (c) => { run('DELETE FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id); send(c.res, 200, { ok: true }); });

// ---------- Lyssning: smarta spellistor, låttexter och lyssningsinställningar ----------
route('GET', '/api/music/:lib/smart', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, listen.smartLists(l.id, c.user.id)); });
route('GET', '/api/music/:lib/smart/:sid', user, (c) => {
  const l = musicLib(c); if (!l) return;
  const trackList = listen.smartTracks(l.id, c.user.id, c.p.sid);
  trackList ? send(c.res, 200, { id: c.p.sid, name: listen.smartName(c.p.sid), trackList }) : fail(c.res, 404, 'Listan finns inte');
});
route('GET', '/api/music/tracks/:tid/lyrics', user, async (c) => { const t = trackRow(c); if (t) send(c.res, 200, await listen.lyricsFor(t)); });
route('GET', '/api/me/listening', user, (c) => send(c.res, 200, listen.getPrefs(c.user.id)));
route('PUT', '/api/me/listening', user, async (c) => {
  const b = await readJson(c.req);
  try { send(c.res, 200, listen.setPrefs(c.user.id, b && typeof b === 'object' ? b : {})); } catch (e) { fail(c.res, 400, e.message); }
});



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
  let it = get('SELECT id, kind, parent_id, version_of, age FROM items WHERE id=?', c.p.id);
  if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  const id = it.kind === 'episode' ? it.parent_id : ver.mainIdOf(it); // avsnitt → hela serien, version → filmen
  if (add === false) run('DELETE FROM watchlist WHERE user_id=? AND item_id=?', c.user.id, id);
  else { run('INSERT OR IGNORE INTO watchlist(user_id,item_id,added) VALUES(?,?,?)', c.user.id, id, now()); follows.autoFollow(c.user.id, id); }
  invalidateProfile(c.user.id);
  send(c.res, 200, { ok: true });
});

// ---------- Samlingar ----------
function collapseCollections(items) {
  const n = new Map(), years = new Map();
  for (const it of items) if (it.collection) {
    n.set(it.collection, (n.get(it.collection) || 0) + 1);
    const y = years.get(it.collection) || [Infinity, -Infinity];
    if (it.year) years.set(it.collection, [Math.min(y[0], it.year), Math.max(y[1], it.year)]); else years.set(it.collection, y);
  }
  const ids = [...n].filter(([, k]) => k >= 2).map(([id]) => id);
  if (!ids.length) return items;
  const cols = new Map(all(`SELECT id, name, poster FROM collections WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map(r => [r.id, r]));
  const out = [], done = new Set();
  for (const it of items) {
    const col = it.collection && n.get(it.collection) >= 2 && cols.get(it.collection);
    if (!col) { out.push(it); continue; }
    if (done.has(col.id)) continue;
    done.add(col.id);
    const [y0, y1] = years.get(col.id);
    out.push({ kind: 'collection', id: col.id, name: col.name, poster: !!col.poster, count: n.get(col.id), years: isFinite(y0) ? [y0, y1] : [] });
  }
  return out;
}
route('GET', '/api/collections', user, (c) => {
  const cols = all(`SELECT c.*, COUNT(i.id) AS n, MIN(i.year) AS y0, MAX(i.year) AS y1 FROM collections c JOIN items i ON i.collection_id=c.id AND i.kind='movie' AND i.version_of IS NULL
    GROUP BY c.id HAVING n >= 2 ORDER BY c.name`);
  // dölj samlingar där profilen inte får se något (en fråga för alla samlingar)
  const age = ageFilter(c.user.id);
  const visible = new Set(all(`SELECT DISTINCT i.collection_id AS id FROM items i LEFT JOIN items s ON s.id=i.parent_id
    WHERE i.collection_id IS NOT NULL${MAIN_ONLY}${age.sql}`, ...age.params).map(r => r.id));
  send(c.res, 200, cols.filter(col => visible.has(col.id)).map(col => ({ id: col.id, name: col.name, overview: col.overview, poster: !!col.poster, backdrop: !!col.backdrop,
    count: col.n, years: [col.y0, col.y1], visible: true })));
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
  send(c.res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(createSession(t.id, 'web', meta), isHttps(c.req)) });
});

// ---------- Rekommendationer (lokalt, utan molntjänst) ----------
// Smakprofilen (genrevikter) cachas en stund per användare och räknas om när något relevant ändras
const profiles = new Map(); // uid -> { w, t }
const PROFILE_TTL = 5 * 60e3;
function invalidateProfile(uid) { profiles.delete(uid); }
const parseGenres = (g) => { try { const a = JSON.parse(g || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
function genreProfile(uid) {
  const c = profiles.get(uid);
  if (c && Date.now() - c.t < PROFILE_TTL) return c.w;
  const rows = all(`SELECT COALESCE(s.genres, i.genres) AS g, COUNT(*) AS n FROM progress p JOIN items i ON i.id=p.item_id LEFT JOIN items s ON s.id=i.parent_id
    WHERE p.user_id=? AND (p.watched=1 OR p.position > 300) GROUP BY COALESCE(s.id, i.id)`, uid);
  const w = {};
  for (const r of rows) for (const x of parseGenres(r.g)) w[x] = (w[x] || 0) + 1;
  for (const r of all(`SELECT i.genres FROM watchlist l JOIN items i ON i.id=l.item_id WHERE l.user_id=?`, uid)) {
    for (const x of parseGenres(r.genres)) w[x] = (w[x] || 0) + 0.5;
  }
  profiles.set(uid, { w, t: Date.now() });
  if (profiles.size > 1000) profiles.delete(profiles.keys().next().value);
  return w;
}
/** Hämtar fullständiga rader för id:n i given ordning */
function itemsByIds(uid, ids) {
  if (!ids.length) return [];
  const rows = listItems(uid, `i.id IN (${ids.map(() => '?').join(',')})`, ids, 'i.id', ids.length);
  const byId = new Map(rows.map(r => [r.id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}
// Poängsättning sker på lätta kolumner; bara de bästa hämtas sedan i sin helhet
function recommend(uid, limit) {
  const w = genreProfile(uid);
  if (!Object.keys(w).length) return [];
  const age = ageFilter(uid);
  // Titlar man redan börjat på/sett (serier räknas via sina avsnitt) och titlar i Min lista hoppas över
  const seen = new Set(all(`SELECT DISTINCT COALESCE(e.parent_id, e.id) AS id FROM progress q JOIN items e ON e.id=q.item_id
    WHERE q.user_id=? AND (q.watched=1 OR q.position > 0)`, uid).map(r => r.id));
  for (const r of all('SELECT item_id FROM watchlist WHERE user_id=?', uid)) seen.add(r.item_id);
  const cands = all(`SELECT i.id, i.genres, i.rating FROM items i LEFT JOIN items s ON s.id=i.parent_id
    WHERE i.kind IN ('movie','show') AND i.genres IS NOT NULL AND i.genres != '[]'${MAIN_ONLY}${age.sql} ORDER BY i.added DESC`, ...age.params)
    .filter(r => !seen.has(r.id)).slice(0, 3000);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const top = cands.map(r => { const g = parseGenres(r.genres); return { id: r.id, score: g.reduce((a, x) => a + (w[x] || 0) / total, 0) / Math.sqrt(g.length || 1) + (r.rating || 6) / 50 }; })
    .filter(x => x.score > 0.2).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.id);
  return itemsByIds(uid, top);
}
function similarTo(uid, it, limit) {
  const g = parseGenres(it.genres);
  if (!g.length) return [];
  const age = ageFilter(uid);
  const cands = all(`SELECT i.id, i.genres, i.collection_id FROM items i LEFT JOIN items s ON s.id=i.parent_id
    WHERE i.kind=? AND i.id != ? AND i.genres IS NOT NULL${MAIN_ONLY}${age.sql} ORDER BY i.rating DESC LIMIT 2000`, it.kind, it.id, ...age.params);
  const top = cands.map(x => { const xg = parseGenres(x.genres); return { id: x.id, s: xg.filter(y => g.includes(y)).length / Math.max(g.length, xg.length) + (x.collection_id && x.collection_id === it.collection_id ? 1 : 0) }; })
    .filter(o => o.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, limit).map(o => o.id);
  return itemsByIds(uid, top);
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
  const ok = (data) => send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
  fs.readFile(f, (e, data) => {
    if (!e) return ok(data);
    // Filmversioner har ingen egen affisch – använd filmens (t.ex. när Chromecast fått en token för versionen)
    const main = c.p.type !== 'thumb' && get('SELECT version_of FROM items WHERE id=?', +c.p.id)?.version_of;
    if (!main) return fail(c.res, 404, 'Ingen bild');
    fs.readFile(path.join(IMAGES, `${main}-${c.p.type}.jpg`), (e2, d2) => e2 ? fail(c.res, 404, 'Ingen bild') : ok(d2));
  });
});

// Uppspelning
const mediaItem = (c) => {
  const it = get(`SELECT * FROM items WHERE id=? AND kind!='show'`, c.p.id);
  if (!it) { fail(c.res, 404, 'Finns inte'); return null; }
  if (!allowedFor(c.user.id, it)) { fail(c.res, 403, 'Inte tillgänglig i den här profilen'); return null; }
  if (c.req.url.includes('/api/stream/')) {
    // "Spelas nu" och admins stopp gäller filmen (huvudraden), även när en annan version strömmas
    if (act.isStopped(c.user.id, ver.mainIdOf(it))) { fail(c.res, 403, 'Uppspelningen stoppades av administratören'); return null; }
    // Skärmtid: strömmar nekas när tiden är slut (nedladdningar för offline räknas inte som tittande)
    if (!/\/(offline-file|download)$/.test(c.req.url.split('?')[0]) && screenBlock(c)) return null;
    act.touch(c.user.id, ver.mainIdOf(it));
  }
  return it;
};
// Klienten skickar sina förmågor; svaret anger läge och färdiga URL:er
route('GET', '/api/items/:id/playback', user, async (c) => {
  const row = mediaItem(c); if (!row) return;
  const main = ver.mainOf(row);
  if (act.isStopped(c.user.id, main.id)) return fail(c.res, 403, 'Uppspelningen stoppades av administratören');
  if (c.q.get('info') !== '1' && screenBlock(c)) return;
  // Ej analyserad film: ta fram nyckelbilderna nu (före bakgrundsanalysen) så att den kan skickas utan
  // omkodning. Vänta högst 25 s – annars omkodas den den här gången och nästa gång går det direkt.
  if (c.q.get('info') !== '1' && c.q.get('force') !== 'transcode') {
    const todo = ver.versionsOf(main).filter(v => ['h264', 'hevc'].includes(v.vcodec) && !st.keyframesReady(v)).slice(0, 2);
    if (todo.length) await Promise.race([Promise.all(todo.map(v => st.computeKeyframes(v, { priority: true }))), new Promise(r => setTimeout(r, 25000))]);
    if (c.res.writableEnded || c.req.destroyed) return;
  }
  let o = st.parseCaps(c.q);
  const remote = !isLocalReq(c.req);
  // Utanför hemmet: begränsa kvaliteten automatiskt (om klienten inte valt själv)
  const auto = !c.q.get('q') || c.q.get('q') === 'auto';
  if (remote && auto) o.q = getSetting('remote_quality', process.env.REMOTE_QUALITY || '1080');
  o.maxBitrate = st.QUALITIES[o.q]?.br || null;
  // Flera versioner: klientens val (version=<id>) eller den som passar klienten bäst
  const versions = ver.versionsOf(main);
  const asked = versions.find(v => v.id === (+c.q.get('version') || (row.version_of ? row.id : 0)));
  const it = asked || ver.chooseVersion(versions, o, st.decide, st.QUALITIES[o.q]?.h || null);
  // Spårval utan angiven version kan komma från huvudfilens spårlista (appar) – översätt till den valda filen
  if (!asked) o = ver.mapTracks(o, main, it, st.streamsOf, st.subtitlesOf);
  const d = st.decide(it, o);
  // Automatisk kvalitet vid omkodning: mastern listar även lägre steg så att spelaren kan växla ner
  // Bara utanför hemmet: hemma räcker bandbredden, och byten mellan steg startar om omkodningen i onödan
  d.abr = auto && remote && d.mode === 'transcode';
  // Token i URL behövs för appar, Chromecast och AirPlay (de skickar inte webbläsarens cookie)
  // Strömlänkar får en egen kortlivad token som bara gäller den här titeln (aldrig kontots token i URL:er)
  let token = null;
  if (c.q.get('info') !== '1' && (c.q.get('cast') === '1' || c.user.via !== 'cookie')) token = createSession(c.user.id, 'media', { item: it.id, ip: clientIp(c.req) });
  const tq = token ? `?t=${token}` : '';
  const base = `/api/stream/${it.id}`;
  const url = d.mode === 'direct' ? `${base}/direct${tq}` : `${base}/hls/master.m3u8?${st.hlsParams(d, o, token)}`;
  // info=1: titelsidan visar bara uppspelningsläget – det är ingen uppspelning
  const info = c.q.get('info') === '1';
  if (it.duration && !info) trakt.scrobble(c.user.id, main, 'start', (+c.q.get('start') || 0) / it.duration * 100).catch(() => {});
  if (!info) act.startPlay({ user: c.user, item: main, mode: d.mode, quality: d.q, ip: clientIp(c.req), remote, ua: c.req.headers['user-agent'], reasons: d.reasons });
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
    ...(versions.length > 1 ? { version: it.id, versions: ver.versionList(versions) } : {}),
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
route('POST', '/api/stream/:id/stop', user, (c) => {
  // Klienten anger filmen; omkodningen kan gälla vilken version som helst av den
  const row = get('SELECT * FROM items WHERE id=?', +c.p.id);
  const ids = row ? ver.versionsOf(ver.mainOf(row)).map(v => v.id) : [+c.p.id];
  for (const id of new Set([+c.p.id, ...ids])) st.stopUserSessions(id, c.user.id);
  send(c.res, 200, { ok: true });
});

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
    run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=?1 OR parent_id=?1)', target.id); changes.push('nytt lösenord');
  }
  if (isAdmin != null && target.id !== c.user.id) { run('UPDATE users SET is_admin=? WHERE id=?', isAdmin ? 1 : 0, target.id); changes.push(isAdmin ? 'admin' : 'ej admin'); }
  if (remoteAllowed != null) {
    // Profilerna ärver kontots fjärråtkomst
    run('UPDATE users SET remote_allowed=?1 WHERE id=?2 OR parent_id=?2', remoteAllowed ? 1 : 0, target.id); changes.push(remoteAllowed ? 'fjärråtkomst på' : 'fjärråtkomst av');
    if (!remoteAllowed) run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=?1 OR parent_id=?1) AND kind IN ('media','img')", target.id);
  }
  if (reset2fa) { run('UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_pending=NULL, recovery=NULL WHERE id=?', target.id); changes.push('2FA återställd'); }
  if (logoutAll) { run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=?1 OR parent_id=?1) AND token != ?2', target.id, c.user.tokenHash); changes.push('utloggad överallt'); }
  audit('user_updated', { ...ctx(c), detail: `${target.name}: ${changes.join(', ')}` });
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/users/:id', admin, (c) => {
  if (+c.p.id === c.user.id) return fail(c.res, 400, 'Du kan inte ta bort dig själv');
  const t = get('SELECT name FROM users WHERE id=?', +c.p.id);
  // Profilerna försvinner med kontot (deras sessioner tas bort via ON DELETE CASCADE)
  tx(() => { run('DELETE FROM users WHERE parent_id=?', +c.p.id); run('DELETE FROM users WHERE id=?', +c.p.id); });
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
  const r = books.saveProgress(c.user.id, +c.p.bid, position, speed); if (!r) return fail(c.res, 404, 'Finns inte');
  const sc = screen.heartbeat(c.user.id, 'b:' + (+c.p.bid), +position, { audio: true });
  send(c.res, 200, sc ? { ...r, stop: !sc.allowed, screenTime: sc } : r);
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
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); pipeline(fs.createReadStream(f), c.res, () => {});
});
const bookFile = (c) => { const f = books.fileRow(+c.p.fid); if (!f) fail(c.res, 404, 'Finns inte'); return f; };
// Strömmar för ljudböcker/poddar: kortlivad token (24 h) som bara gäller den boken/det avsnittet – för appar och AirPlay
const BOOK_SCOPE = 2e9, POD_SCOPE = 3e9;
const bookStream = { auth: true, media: true, scope: (p) => BOOK_SCOPE + (books.fileRow(+p.fid)?.book_id || 0) };
const podStream = { auth: true, media: true, scope: (p) => POD_SCOPE + (+p.eid) };
route('GET', '/api/audiobooks/files/:fid/stream', bookStream, (c) => { const f = bookFile(c); if (f && !screenBlock(c, { audio: true })) music.streamTrack(c.req, c.res, f, c.q); });
route('HEAD', '/api/audiobooks/files/:fid/stream', bookStream, (c) => { const f = bookFile(c); if (f && !screenBlock(c, { audio: true })) music.streamTrack(c.req, c.res, f, c.q); });
route('GET', '/api/audiobooks/book/:bid/play', user, (c) => {
  const b = books.book(+c.p.bid, c.user.id); if (!b) return fail(c.res, 404, 'Finns inte');
  if (screenBlock(c, { audio: true })) return;
  const t = createSession(c.user.id, 'media', { item: BOOK_SCOPE + b.id, ip: clientIp(c.req) });
  const a = encodeURIComponent(String(c.q.get('a') || 'mp3,aac,flac'));
  send(c.res, 200, { ...b, token: t, files: b.files.map(f => ({ ...f, url: `/api/audiobooks/files/${f.id}/stream?a=${a}&t=${t}` })) });
});

// ---------- Poddar ----------
route('GET', '/api/podcasts', user, (c) => send(c.res, 200, { podcasts: pods.list(c.user.id), latest: pods.latest(c.user.id, 30), canAdd: c.user.max_age == null }));
route('POST', '/api/podcasts', user, async (c) => {
  if (c.user.max_age != null) return fail(c.res, 403, 'Barnprofiler kan inte lägga till poddar');
  const { url } = await readJson(c.req);
  try { const id = await pods.subscribe(url, c.user); audit('podcast_added', { ...ctx(c), detail: String(url).slice(0, 200) }); send(c.res, 200, { id }); }
  catch (e) { fail(c.res, 400, e.message); }
});
route('GET', '/api/podcasts/:pid', user, (c) => {
  const p = pods.podcast(+c.p.pid, c.user.id); if (!p) return fail(c.res, 404, 'Finns inte');
  // Flödesadressen kan innehålla en privat nyckel – visas bara för den som lade till podden och administratörer
  const owner = get('SELECT added_by FROM podcasts WHERE id=?', p.id)?.added_by;
  if (!c.user.is_admin && owner !== c.user.id) delete p.url;
  p.canEdit = c.user.max_age == null && (!!c.user.is_admin || owner === c.user.id);
  send(c.res, 200, p);
});
const podOwner = (c) => {
  const p = get('SELECT * FROM podcasts WHERE id=?', +c.p.pid);
  if (!p) { fail(c.res, 404, 'Finns inte'); return null; }
  if (c.user.max_age != null || (!c.user.is_admin && p.added_by !== c.user.id)) { fail(c.res, 403, 'Bara den som lade till podden eller en administratör kan ändra den'); return null; }
  return p;
};
route('PUT', '/api/podcasts/:pid', user, async (c) => {
  if (!podOwner(c)) return;
  const { keep } = await readJson(c.req);
  if (keep != null) run('UPDATE podcasts SET keep=? WHERE id=?', Math.max(0, Math.min(50, parseInt(keep) || 0)), +c.p.pid);
  send(c.res, 200, { ok: true });
});
route('POST', '/api/podcasts/:pid/refresh', user, async (c) => {
  if (c.user.max_age != null) return fail(c.res, 403, 'Inte tillgängligt i barnprofiler'); try { send(c.res, 200, await pods.refresh(+c.p.pid)); } catch (e) { fail(c.res, 502, e.message); } });
route('DELETE', '/api/podcasts/:pid', user, (c) => {
  const p = get('SELECT * FROM podcasts WHERE id=?', +c.p.pid); if (!p) return fail(c.res, 404, 'Finns inte');
  if (!c.user.is_admin && p.added_by !== c.user.id) return fail(c.res, 403, 'Bara den som lade till podden eller en administratör kan ta bort den');
  pods.unsubscribe(p.id); send(c.res, 200, { ok: true });
});
route('GET', '/api/podcasts/:pid/image', img, (c) => {
  const f = pods.imagePath(+c.p.pid); if (!f) return fail(c.res, 404, 'Ingen bild');
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); pipeline(fs.createReadStream(f), c.res, () => {});
});
route('POST', '/api/podcasts/episodes/:eid/progress', user, async (c) => {
  const { position, played } = await readJson(c.req);
  const r = pods.saveProgress(c.user.id, +c.p.eid, position, played); if (!r) return fail(c.res, 404, 'Finns inte');
  const sc = played ? null : screen.heartbeat(c.user.id, 'p:' + (+c.p.eid), +position, { audio: true });
  send(c.res, 200, sc ? { ...r, stop: !sc.allowed, screenTime: sc } : r);
});
route('POST', '/api/podcasts/episodes/:eid/download', user, (c) => { if (c.user.max_age != null) return fail(c.res, 403, 'Inte tillgängligt i barnprofiler'); pods.download(+c.p.eid); send(c.res, 200, { ok: true }); });
route('GET', '/api/podcasts/episodes/:eid', user, (c) => {
  const e = get(`SELECT e.*, p.title AS ptitle, q.position, q.played FROM podcast_episodes e JOIN podcasts p ON p.id=e.podcast_id
    LEFT JOIN podcast_progress q ON q.episode_id=e.id AND q.user_id=? WHERE e.id=?`, c.user.id, +c.p.eid);
  if (!e) return fail(c.res, 404, 'Finns inte');
  send(c.res, 200, { id: e.id, podcast: e.podcast_id, podcastTitle: e.ptitle, title: e.title, description: e.description, published: e.published, duration: e.duration,
    downloaded: !!e.file, position: e.position || 0, played: !!e.played });
});
const podEp = (c) => { const e = pods.episodeRow(+c.p.eid); if (!e) fail(c.res, 404, 'Finns inte'); return e; };
route('GET', '/api/podcasts/episodes/:eid/play', user, (c) => {
  const e = pods.episodeRow(+c.p.eid); if (!e) return fail(c.res, 404, 'Finns inte');
  if (screenBlock(c, { audio: true })) return;
  send(c.res, 200, { url: `/api/podcasts/episodes/${e.id}/stream?t=${createSession(c.user.id, 'media', { item: POD_SCOPE + e.id, ip: clientIp(c.req) })}` });
});
route('GET', '/api/podcasts/episodes/:eid/stream', podStream, async (c) => { const e = podEp(c); if (e && !screenBlock(c, { audio: true })) await pods.stream(c.req, c.res, e).catch(er => fail(c.res, 502, er.message)); });
route('HEAD', '/api/podcasts/episodes/:eid/stream', podStream, async (c) => { const e = podEp(c); if (e && !screenBlock(c, { audio: true })) await pods.stream(c.req, c.res, e).catch(er => fail(c.res, 502, er.message)); });

// ---------- Streamingtjänster ("var kan jag se den?") ----------
route('GET', '/api/items/:id/watch', user, async (c) => {
  let it = get('SELECT * FROM items WHERE id=?', +c.p.id); if (!it) return fail(c.res, 404, 'Finns inte');
  if (it.kind === 'episode') it = get('SELECT * FROM items WHERE id=?', it.parent_id);
  if (!it?.tmdb_id || !hasTmdb()) return send(c.res, 200, null);
  try { send(c.res, 200, await streaming.providersFor(it.kind, it.tmdb_id, it.title)); } catch { send(c.res, 200, null); }
});
route('GET', '/api/streaming/providers', user, async (c) => {
  if (!hasTmdb()) return fail(c.res, 400, 'Kräver en TMDB-nyckel (Administration → Inställningar)');
  try { send(c.res, 200, { region: streaming.region(), mine: streaming.myProviders(), all: await streaming.allProviders() }); } catch (e) { fail(c.res, 502, 'TMDB: ' + e.message); }
});
route('PUT', '/api/streaming/mine', admin, async (c) => {
  const { ids } = await readJson(c.req);
  setSetting('my_providers', (Array.isArray(ids) ? ids : []).map(Number).filter(n => n > 0).slice(0, 30).join(','));
  send(c.res, 200, { ok: true });
});
route('GET', '/api/streaming/discover', user, async (c) => {
  if (c.user.max_age != null) return fail(c.res, 403, 'Inte tillgängligt i barnprofiler');
  if (!hasTmdb()) return fail(c.res, 400, 'Kräver en TMDB-nyckel');
  const ids = String(c.q.get('providers') || '').split(',').map(Number).filter(Boolean);
  try { send(c.res, 200, await streaming.discover(c.q.get('kind') === 'show' ? 'show' : 'movie', ids, parseInt(c.q.get('page')) || 1, parseInt(c.q.get('genre')) || null)); }
  catch (e) { fail(c.res, 502, 'TMDB: ' + e.message); }
});
route('GET', '/api/streaming/title/:kind/:tid', user, async (c) => {
  if (!hasTmdb()) return fail(c.res, 400, 'Kräver en TMDB-nyckel');
  try { send(c.res, 200, await streaming.providersFor(c.p.kind === 'show' ? 'show' : 'movie', +c.p.tid, String(c.q.get('title') || '').slice(0, 200))); }
  catch (e) { fail(c.res, 502, 'TMDB: ' + e.message); }
});

// ---------- Live-TV och inspelningar ----------
const LIVE_SCOPE = 4e9, REC_SCOPE = 5e9;
const liveOk = (c) => { if (c.user.max_age != null && !allowUnrated()) { fail(c.res, 403, 'Live-TV är inte tillgängligt i barnprofiler'); return false; } return true; };
const liveStream = { auth: true, media: true, scope: (p) => LIVE_SCOPE + (+p.cid) };
const recStream = { auth: true, media: true, scope: (p) => REC_SCOPE + (+p.rid) };
route('GET', '/api/live/channels', user, (c) => { if (liveOk(c)) send(c.res, 200, { channels: live.channelList(false), tuners: get('SELECT COUNT(*) AS n FROM tuners WHERE enabled=1').n, active: live.activeLive() }); });
route('GET', '/api/live/guide', user, (c) => {
  if (!liveOk(c)) return;
  // Guiden sparar sändningar ett dygn bakåt (livetv.js) – så långt går det att bläddra
  const from = Math.max(now() - 25 * 3600, parseInt(c.q.get('from')) || now() - 1800), hours = Math.max(1, Math.min(24, parseInt(c.q.get('hours')) || 6));
  send(c.res, 200, { from, to: from + hours * 3600, channels: live.guide(from, from + hours * 3600), guide: live.guideState });
});
route('GET', '/api/live/programs/:pid', user, (c) => {
  if (!liveOk(c)) return;
  const p = live.program(+c.p.pid); if (!p) return fail(c.res, 404, 'Finns inte');
  const rec = get("SELECT id, status FROM recordings WHERE channel_id=? AND start=? AND status IN ('scheduled','recording','processing','done')", p.channel_id, p.start);
  const rule = get('SELECT id FROM dvr_rules WHERE title=? COLLATE NOCASE', p.title);
  send(c.res, 200, { ...p, recording: rec || null, rule: rule?.id || null,
    airings: all('SELECT p.id, p.start, p.stop, c.name AS channel FROM programs p JOIN channels c ON c.id=p.channel_id WHERE p.title=? COLLATE NOCASE AND p.start > ? AND p.id != ? ORDER BY p.start LIMIT 10', p.title, now(), p.id) });
});
// Kanallogotyper hämtas av servern och cachas (sidans säkerhetspolicy tillåter inte externa bilder)
route('GET', '/api/live/logo/:cid', img, async (c) => {
  const ch = get('SELECT id, logo FROM channels WHERE id=?', +c.p.cid);
  if (!ch?.logo || !/^https?:\/\//.test(ch.logo)) return fail(c.res, 404, 'Ingen logotyp');
  const f = path.join(IMAGES, `ch${ch.id}-${crypto.createHash('sha1').update(ch.logo).digest('hex').slice(0, 10)}.img`);
  if (!fs.existsSync(f)) {
    try {
      const { r } = await pods.safeFetch(ch.logo, { timeout: 10000 });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !/^image\/(png|jpeg|gif|webp|svg\+xml)/.test(ct)) { r.body.destroy(); return fail(c.res, 404, 'Ingen logotyp'); }
      const b = await pods.readLimited(r, 1 << 20);
      fs.writeFileSync(f, Buffer.concat([Buffer.from(ct.split(';')[0].padEnd(32)), b]));
    } catch { return fail(c.res, 404, 'Ingen logotyp'); }
  }
  const all_ = fs.readFileSync(f);
  const ct = all_.subarray(0, 32).toString().trim();
  // SVG serveras med egen CSP så att skript i filen inte kan köras
  c.res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'private, max-age=604800', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  c.res.end(all_.subarray(32));
});
route('GET', '/api/live/search', user, (c) => { if (liveOk(c)) send(c.res, 200, live.searchPrograms(String(c.q.get('q') || '').slice(0, 80))); });
route('POST', '/api/live/:cid/play', user, (c) => {
  if (!liveOk(c) || screenBlock(c)) return;
  if (!get('SELECT 1 FROM channels WHERE id=?', +c.p.cid)) return fail(c.res, 404, 'Kanalen finns inte');
  const t = c.user.via !== 'cookie' || c.q.get('cast') === '1' ? createSession(c.user.id, 'media', { item: LIVE_SCOPE + (+c.p.cid), ip: clientIp(c.req) }) : null;
  send(c.res, 200, { url: `/api/live/${+c.p.cid}/live.m3u8${t ? '?t=' + t : ''}`, token: t });
});
route('GET', '/api/live/:cid/live.m3u8', liveStream, async (c) => { if (liveOk(c) && !screenBlock(c)) await live.servePlaylist(c.res, +c.p.cid, c.q.get('t')); });
route('GET', '/api/live/:cid/seg-:n.ts', liveStream, (c) => {
  if (!liveOk(c) || screenBlock(c)) return;
  screen.heartbeat(c.user.id, 'l:' + (+c.p.cid)); // live-TV räknas som tittande så länge segment hämtas
  live.serveSegment(c.req, c.res, +c.p.cid, `seg-${c.p.n}.ts`);
});
// DVR
route('GET', '/api/dvr', user, (c) => { if (liveOk(c)) send(c.res, 200, { ...dvr.list(), dir: c.user.is_admin ? dvr.dvrDir() : null, comskip: { enabled: comskip.enabled(), autoSkip: comskip.autoSkipDefault() } }); });
route('POST', '/api/dvr/program', user, async (c) => {
  if (!liveOk(c)) return;
  const { programId, series, newOnly, keep } = await readJson(c.req);
  try {
    if (series) {
      const p = live.program(+programId); if (!p) return fail(c.res, 404, 'Finns inte');
      const id = dvr.addRule({ title: p.title, channelId: c.q.get('anyChannel') === '1' ? null : p.channel_id, newOnly: newOnly !== false, keep }, c.user);
      dvr.scheduleProgram(+programId, c.user, id);
      audit('dvr_rule', { ...ctx(c), detail: p.title });
      return send(c.res, 200, { rule: id });
    }
    const p = live.program(+programId);
    // Varna om fler inspelningar än det finns tuners överlappar
    const conflict = p ? dvr.conflicts(p.start, p.stop, { channelId: p.channel_id }).find(x => x.conflict) || null : null;
    send(c.res, 200, { id: dvr.scheduleProgram(+programId, c.user), conflict });
  } catch (e) { fail(c.res, 400, e.message); }
});
route('POST', '/api/dvr/manual', user, async (c) => {
  if (!liveOk(c)) return;
  const b = await readJson(c.req);
  try {
    const conflict = dvr.conflicts(+b.start, +b.stop, { channelId: +b.channelId }).find(x => x.conflict) || null;
    send(c.res, 200, { id: dvr.scheduleManual({ channelId: +b.channelId, start: +b.start, stop: +b.stop, title: b.title }, c.user), conflict });
  } catch (e) { fail(c.res, 400, e.message); }
});
route('DELETE', '/api/dvr/rules/:id', user, (c) => {
  const r = get('SELECT * FROM dvr_rules WHERE id=?', +c.p.id); if (!r) return fail(c.res, 404, 'Finns inte');
  if (!c.user.is_admin && r.created_by !== c.user.id) return fail(c.res, 403, 'Bara den som skapade serieinspelningen kan ta bort den');
  dvr.removeRule(r.id); send(c.res, 200, { ok: true });
});
route('DELETE', '/api/dvr/recordings/:rid', user, (c) => {
  const r = get('SELECT * FROM recordings WHERE id=?', +c.p.rid); if (!r) return fail(c.res, 404, 'Finns inte');
  if (!c.user.is_admin && r.created_by !== c.user.id) return fail(c.res, 403, 'Bara den som bokade inspelningen eller en administratör kan ta bort den');
  if (r.status === 'scheduled') dvr.cancel(r.id); else dvr.removeRecording(r.id);
  send(c.res, 200, { ok: true });
});
route('POST', '/api/dvr/recordings/:rid/stop', user, (c) => {
  if (!liveOk(c)) return;
  const r = get('SELECT * FROM recordings WHERE id=?', +c.p.rid); if (!r) return fail(c.res, 404, 'Finns inte');
  if (!c.user.is_admin && r.created_by !== c.user.id) return fail(c.res, 403, 'Bara den som bokade inspelningen eller en administratör kan stoppa den');
  dvr.stopRecording(r.id); send(c.res, 200, { ok: true });
});
route('POST', '/api/dvr/recordings/:rid/play', user, (c) => {
  if (!liveOk(c) || screenBlock(c)) return;
  const t = c.user.via !== 'cookie' || c.q.get('cast') === '1' ? createSession(c.user.id, 'media', { item: REC_SCOPE + (+c.p.rid), ip: clientIp(c.req) }) : null;
  send(c.res, 200, { url: `/api/dvr/recordings/${+c.p.rid}/stream${t ? '?t=' + t : ''}` });
});
route('GET', '/api/dvr/recordings/:rid/stream', recStream, (c) => { if (liveOk(c) && !screenBlock(c)) dvr.serveRecording(c.req, c.res, +c.p.rid); });
route('HEAD', '/api/dvr/recordings/:rid/stream', recStream, (c) => { if (liveOk(c) && !screenBlock(c)) dvr.serveRecording(c.req, c.res, +c.p.rid); });
// Administration av källor
route('GET', '/api/live/tuners', admin, (c) => send(c.res, 200, {
  tuners: all('SELECT id, kind, name, url, epg_url, tuner_count, enabled, last_refresh, error, (SELECT COUNT(*) FROM channels WHERE tuner_id=tuners.id) AS channels FROM tuners'),
  inUse: live.tunersInUse(), guide: live.guideState, channels: live.channelList(true),
  settings: { dvrDir: dvr.dvrDir(), padBefore: +getSetting('dvr_pad_before', '60'), padAfter: +getSetting('dvr_pad_after', '180'), liveTranscode: getSetting('live_transcode', 'auto'), keepTs: getSetting('dvr_keep_ts', '0') === '1',
    timeshiftMinutes: timeshift.timeshiftMinutes(), timeshiftMaxGb: timeshift.timeshiftMaxGb(), comskip: comskip.enabled(), comskipAutoSkip: comskip.autoSkipDefault() }
}));
route('POST', '/api/live/discover', admin, async (c) => send(c.res, 200, { found: await live.discoverHdhr() }));
route('POST', '/api/live/tuners', admin, async (c) => {
  const b = await readJson(c.req);
  if (b.epgUrl && !/^(https?:\/\/|\/config\/)/.test(b.epgUrl)) return fail(c.res, 400, 'TV-guiden ska vara en http(s)-adress eller en fil under /config');
  try { const id = await live.addTuner({ kind: b.kind, url: String(b.url || '').trim(), name: b.name, epgUrl: b.epgUrl, tuners: b.tuners }); dvr.applyRules(); audit('settings_changed', { ...ctx(c), detail: 'live-TV-källa' }); send(c.res, 200, { id }); }
  catch (e) { fail(c.res, 400, e.message); }
});
route('PUT', '/api/live/tuners/:id', admin, async (c) => {
  const b = await readJson(c.req);
  if (typeof b.epgUrl === 'string') { if (b.epgUrl && !/^(https?:\/\/|\/config\/)/.test(b.epgUrl)) return fail(c.res, 400, 'Ogiltig adress'); run('UPDATE tuners SET epg_url=? WHERE id=?', b.epgUrl.trim() || null, +c.p.id); }
  if (b.tuners != null) run('UPDATE tuners SET tuner_count=? WHERE id=?', Math.max(1, Math.min(20, +b.tuners || 2)), +c.p.id);
  if (b.enabled != null) run('UPDATE tuners SET enabled=? WHERE id=?', b.enabled ? 1 : 0, +c.p.id);
  if (typeof b.name === 'string' && b.name.trim()) run('UPDATE tuners SET name=? WHERE id=?', b.name.trim().slice(0, 60), +c.p.id);
  send(c.res, 200, { ok: true });
});
route('POST', '/api/live/tuners/:id/refresh', admin, async (c) => { try { const r = await live.refreshTuner(+c.p.id); dvr.applyRules(); send(c.res, 200, r); } catch (e) { fail(c.res, 502, e.message); } });
route('DELETE', '/api/live/tuners/:id', admin, (c) => { run('DELETE FROM tuners WHERE id=?', +c.p.id); send(c.res, 200, { ok: true }); });
route('PUT', '/api/live/channels/:cid', admin, async (c) => {
  const b = await readJson(c.req);
  if (b.hidden != null) run('UPDATE channels SET hidden=? WHERE id=?', b.hidden ? 1 : 0, +c.p.cid);
  if (b.favorite != null) run('UPDATE channels SET favorite=? WHERE id=?', b.favorite ? 1 : 0, +c.p.cid);
  if (typeof b.epgId === 'string') run('UPDATE channels SET epg_id=? WHERE id=?', b.epgId.trim() || null, +c.p.cid);
  send(c.res, 200, { ok: true });
});
route('PUT', '/api/live/settings', admin, async (c) => {
  const b = await readJson(c.req);
  if (typeof b.dvrDir === 'string' && b.dvrDir.trim()) {
    if (!path.isAbsolute(b.dvrDir.trim())) return fail(c.res, 400, 'Ange en absolut sökväg, t.ex. /recordings');
    setSetting('dvr_dir', b.dvrDir.trim());
  }
  if (b.padBefore != null) setSetting('dvr_pad_before', Math.max(0, Math.min(1800, parseInt(b.padBefore) || 0)));
  if (b.padAfter != null) setSetting('dvr_pad_after', Math.max(0, Math.min(3600, parseInt(b.padAfter) || 0)));
  if (['auto', 'always'].includes(b.liveTranscode)) setSetting('live_transcode', b.liveTranscode);
  if (b.keepTs != null) setSetting('dvr_keep_ts', b.keepTs ? '1' : '0');
  // Timeshift (gäller nya live-strömmar) och reklamavbrott
  if (b.timeshiftMinutes != null && b.timeshiftMinutes !== '') setSetting('live_timeshift_minutes', Math.max(0, Math.min(720, parseInt(b.timeshiftMinutes) || 0)));
  if (b.timeshiftMaxGb != null && b.timeshiftMaxGb !== '') setSetting('live_timeshift_max_gb', Math.max(0.5, Math.min(2000, parseFloat(b.timeshiftMaxGb) || 20)));
  if (b.comskip != null) { setSetting('dvr_comskip', b.comskip ? '1' : '0'); if (b.comskip) comskip.resume(); }
  if (b.comskipAutoSkip != null) setSetting('dvr_comskip_autoskip', b.comskipAutoSkip ? '1' : '0');
  send(c.res, 200, { ok: true });
});
// ---------- Reklamavbrott i inspelningar ----------
// Analysera om en inspelning (t.ex. efter ändrade inställningar); resultatet syns i /api/dvr
route('POST', '/api/dvr/recordings/:rid/commercials', admin, (c) => {
  const r = get("SELECT id FROM recordings WHERE id=? AND status='done'", +c.p.rid); if (!r) return fail(c.res, 404, 'Finns inte');
  if (!comskip.enqueue(r.id)) return fail(c.res, 400, 'Reklamanalysen är avstängd');
  send(c.res, 200, { ok: true });
});
route('POST', '/api/live/guide/refresh', admin, async (c) => { try { await live.refreshGuide(); dvr.applyRules(); send(c.res, 200, live.guideState); } catch (e) { fail(c.res, 502, e.message); } });

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
    const mine = streaming.myProviders().length > 0;
    send(c.res, 200, await Promise.all(res.map(async r => {
      const lib = get('SELECT id FROM items WHERE tmdb_id=? AND kind=? AND version_of IS NULL', r.id, kind);
      const rq = get('SELECT status FROM requests WHERE tmdb_id=? AND kind=?', r.id, kind);
      // Finns den redan på en tjänst ni har? Då behöver den inte laddas ner.
      const streams = mine && !lib ? (await streaming.providersFor(kind, r.id, r.title).catch(() => null))?.onMine || [] : [];
      return { ...r, kind, inLibrary: lib?.id || null, request: rq?.status || null, streaming: streams };
    })));
  } catch (e) { fail(c.res, 502, 'TMDB: ' + e.message); }
});
async function sendRequest(row) {
  if (!arr.configured(row.kind)) { arr.setStatus(row.id, 'approved', 'Godkänd – lägg till manuellt (Radarr/Sonarr är inte inställt)'); return; }
  try { const r = await arr.send(row, tvdbOf); arr.setStatus(row.id, 'sent', r.already ? 'Fanns redan i ' + (row.kind === 'movie' ? 'Radarr' : 'Sonarr') : null); }
  catch (e) { arr.setStatus(row.id, 'failed', e.message); throw e; }
}
route('GET', '/api/requests', user, (c) => send(c.res, 200, {
  canRequest: canRequest(c.user), radarr: arr.configured('movie'), sonarr: arr.configured('show'), autoApprove: getSetting('requests_auto', '0') === '1',
  items: c.user.max_age != null ? [] : all('SELECT * FROM requests ORDER BY created DESC LIMIT 300').map(reqShape)
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
  events: getSetting('notify_events', notifier.DEFAULT_EVENTS).split(',').filter(Boolean), kinds: notifier.KINDS, allEvents: notifier.EVENTS, recent: notifier.sent.slice(-10).reverse() }));
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
  // Alla versioner av filmen (strömmen kan gälla en annan fil än huvudraden)
  const main = get('SELECT * FROM items WHERE id=?', s.itemId);
  for (const id of main ? ver.versionsOf(main).map(v => v.id) : [s.itemId]) {
    st.stopUserSessions(id, s.userId);
    run("DELETE FROM sessions WHERE user_id=? AND kind='media' AND scope_item=?", s.userId, id);
  }
  audit('stream_stopped', { ...ctx(c), detail: `${s.user}: ${s.itemId}` });
  send(c.res, 200, { ok: true });
});
route('GET', '/api/stats', admin, (c) => send(c.res, 200, { ...act.stats(), active: act.listActive().length, transcodes: st.activeTranscodes().length, watching: act.watchingCount(), disk: diskmon.snapshot() }));
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
  pipeline(fs.createReadStream(path.join(act.BACKUP_DIR, f.name)), c.res, () => {});
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
    } else if (remote) {
      // Via .part: en omstart mitt i dekrypteringen får inte lämna en halv databas som byts in vid start
      await offsite.fetchAndDecrypt(String(remote), RESTORE_FILE + '.part');
      fs.renameSync(RESTORE_FILE + '.part', RESTORE_FILE);
    }
    else return fail(c.res, 400, 'Välj en säkerhetskopia');
    audit('restore_prepared', { ...ctx(c), detail: local || remote });
    send(c.res, 200, { ok: true });
  } catch (e) { for (const f of [RESTORE_FILE, RESTORE_FILE + '.part']) fs.rmSync(f, { force: true }); fail(c.res, 400, e.message); }
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
  // Programfilernas integritet (jämförs med integrity.json som skapas vid Docker-bygget)
  const integ = integrity();
  if (integ === null) add('info', 'Ingen integritetsmanifest', 'Servern körs utan integrity.json (t.ex. vid utveckling). Docker-imagen har alltid en.');
  else if (integ.ok) add('ok', 'Programfilerna är oförändrade', `${integ.files} filer stämmer med checksummorna från bygget.`);
  else add('bad', 'Programfiler har ändrats', `Ändrade: ${[...integ.changed, ...integ.added].slice(0, 10).join(', ')}. Om du inte ändrat något själv: hämta om imagen (Check for updates → Apply update).`);
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
  items.push(...diskmon.checkItems());
  if (dlna.enabled()) add('info', 'DLNA är påslaget', 'Alla enheter på hemnätet kan se och spela upp det som DLNA visar, utan inloggning' + (dlna.maxAge() != null ? ` (titlar upp till ${dlna.maxAge()} år).` : '.'));
  send(c.res, 200, items);
});

// ---------- Skådespelare, trailers och årssammanfattning ----------
const TRAILER_SCOPE = 6.5e9;
/** Rollista (avsnitt visar seriens), lokala trailers och YouTube-trailer (inte för barnprofiler – länken leder ut från appen) */
function titleExtras(u, it) {
  const ep = it.kind === 'episode';
  return { cast: people.castOf(ep ? it.parent_id : it.id), trailers: ep ? [] : trailers.trailersOf(it.id),
    youtube: !ep && u.max_age == null && trailers.youtubeOk(it.trailer_yt) ? it.trailer_yt : null };
}
route('GET', '/api/search/people', user, (c) => {
  const q = String(c.q.get('q') || '').trim().slice(0, 100);
  send(c.res, 200, q.length < 2 ? [] : people.searchPeople(q, ageFilter(c.user.id), 20));
});
route('GET', '/api/people/:pid', user, async (c) => {
  const pid = +c.p.pid;
  if (!people.personRow(pid)) return fail(c.res, 404, 'Finns inte');
  // Bara titlar som finns i biblioteket och som profilen får se; utan sådana visas inte personen alls
  const items = listItems(c.user.id, `i.kind IN ('movie','show') AND i.id IN (SELECT item_id FROM item_people WHERE person_id=?)`, [pid],
    'i.year IS NULL, i.year DESC, i.sort_title', 300, 0, { slim: true });
  if (!items.length) return fail(c.res, 404, 'Finns inte');
  const roles = people.rolesOf(pid);
  const info = await people.person(pid, tmdb, hasTmdb());
  send(c.res, 200, { ...info, items: items.map(i => ({ ...i, roles: roles.get(i.id) || [] })) });
});
route('GET', '/api/people/:pid/image', img, async (c) => {
  const f = await people.personImage(+c.p.pid);
  if (!f) return fail(c.res, 404, 'Ingen bild');
  fs.readFile(f, (e, data) => e ? fail(c.res, 404, 'Ingen bild') : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800' }));
});
// Lokala trailers spelas direkt (som filen är). Mediatoken gäller bara den trailern.
const trailerStream = { auth: true, media: true, scope: (p) => TRAILER_SCOPE + (+p.tid) };
const trailerFor = (c) => {
  const t = trailers.trailerRow(+c.p.tid);
  const it = t && get('SELECT * FROM items WHERE id=?', t.item_id);
  if (!it) { fail(c.res, 404, 'Finns inte'); return null; }
  if (!allowedFor(c.user.id, it)) { fail(c.res, 403, 'Inte tillgänglig i den här profilen'); return null; }
  return t;
};
const serveTrailer = (c) => {
  const t = trailerFor(c); if (!t) return;
  if (c.user && screenBlock(c)) return; // webben spelar direkt från strömmen
  fs.stat(t.path, (e, s) => e || !s.isFile() ? fail(c.res, 404, 'Filen finns inte längre')
    : streamFile(c.req, c.res, t.path, s.size, { 'Content-Type': MIME[path.extname(t.path).toLowerCase()] || 'video/mp4', 'Cache-Control': 'private, no-transform' }));
};
route('GET', '/api/trailers/:tid/stream', trailerStream, serveTrailer);
route('HEAD', '/api/trailers/:tid/stream', trailerStream, serveTrailer);
// För appar och Chromecast: färdig URL med kortlivad token (webben använder kakan)
route('GET', '/api/trailers/:tid/play', user, (c) => {
  const t = trailerFor(c); if (!t) return;
  if (screenBlock(c)) return; // skärmtid gäller även trailers
  const token = c.user.via !== 'cookie' ? createSession(c.user.id, 'media', { item: TRAILER_SCOPE + t.id, ip: clientIp(c.req) }) : null;
  send(c.res, 200, { url: `/api/trailers/${t.id}/stream${token ? '?t=' + token : ''}`, mime: MIME[path.extname(t.path).toLowerCase()] || 'video/mp4' });
});
// Årssammanfattning: den egna, eller (administratör på betrott nät) någon annans
route('GET', '/api/wrapped/:year', user, (c) => {
  const year = parseInt(c.p.year);
  if (!(year >= 2000 && year <= 2100)) return fail(c.res, 400, 'Ogiltigt år');
  const adminOk = !!c.user.is_admin && (adminAnywhere() || isTrusted(c.req));
  const uid = c.q.get('user') ? +c.q.get('user') : c.user.id;
  if (uid !== c.user.id && !adminOk) return fail(c.res, 403, 'Du kan bara se din egen sammanfattning');
  const u = get('SELECT id, name FROM users WHERE id=?', uid);
  if (!u) return fail(c.res, 404, 'Användaren finns inte');
  send(c.res, 200, { ...wrapped.wrapped(uid, year), user: u, years: wrapped.years(uid),
    users: adminOk ? all('SELECT id, name FROM users ORDER BY name COLLATE NOCASE') : undefined });
});

// ---------- Skärmtid, följda serier och automatisk offline-synk ----------
/** Neka med skärmtidens förklaring. Returnerar true om förfrågan nekades. audio: ljud (musik/böcker/poddar) */
function screenBlock(c, opts) {
  const s = screen.check(c.user.id, opts);
  if (s) send(c.res, 403, { error: s.message, code: 'screen_time', screenTime: s });
  return !!s;
}
// Stoppa pågående omkodningar när tiden tar slut (övriga förfrågningar nekas av screenBlock)
function stopScreenStreams(uid) { for (const a of act.listActive()) if (a.userId === uid) st.stopUserSessions(a.itemId, uid); }
screen.setOnBlocked((uid) => stopScreenStreams(uid));
// Även utan rapporter (t.ex. när tillåten tid tar slut) – kollas var 30:e sekund för den som tittar
setInterval(() => {
  for (const uid of new Set(act.listActive().map(a => a.userId))) if (screen.check(uid)) stopScreenStreams(uid);
}, 30e3).unref();
/** Målprofil vars skärmtid den inloggade får styra: profiler i det egna hushållet (huvudkontot) eller,
 *  för administratörer på betrott nät, andra konton som inte är administratörer. Aldrig sin egen. */
function screenTarget(c) {
  const t = get('SELECT id, name, parent_id, is_admin FROM users WHERE id=?', +c.p.uid);
  if (!t) { fail(c.res, 404, 'Finns inte'); return null; }
  if (t.id === c.user.id) { fail(c.res, 403, 'Du kan inte ändra skärmtiden för din egen profil'); return null; }
  const me = get('SELECT * FROM users WHERE id=?', c.user.id), root = householdRoot(me);
  if (t.parent_id === root && canManage(c, root)) return t;
  if (c.user.is_admin && !t.is_admin && (adminAnywhere() || isTrusted(c.req))) return t;
  fail(c.res, 403, 'Bara huvudkontot eller en administratör kan ändra skärmtiden'); return null;
}
route('GET', '/api/screentime', user, (c) => send(c.res, 200, screen.status(c.user.id) || { limited: false }));
route('GET', '/api/screentime/:uid', user, (c) => {
  const t = screenTarget(c); if (!t) return;
  send(c.res, 200, { id: t.id, name: t.name, rules: screen.rulesFor(t.id), status: screen.status(t.id) });
});
route('PUT', '/api/screentime/:uid', user, async (c) => {
  const t = screenTarget(c); if (!t) return;
  const rules = screen.setRules(t.id, await readJson(c.req));
  audit('screentime_changed', { ...ctx(c), detail: `${t.name}: ${rules ? JSON.stringify(rules) : 'ingen gräns'}` });
  send(c.res, 200, { rules, status: screen.status(t.id) });
});
route('POST', '/api/screentime/:uid/extra', user, async (c) => {
  const t = screenTarget(c); if (!t) return;
  const { minutes, reset } = await readJson(c.req);
  if (reset) screen.resetToday(t.id);
  const m = Math.max(-240, Math.min(240, parseInt(minutes) || 0));
  if (m) screen.addExtra(t.id, m);
  audit('screentime_extra', { ...ctx(c), detail: `${t.name}: ${reset ? 'nollställd, ' : ''}${m >= 0 ? '+' : ''}${m} min` });
  send(c.res, 200, { status: screen.status(t.id) });
});
// Tittande som inte annars rapporteras (t.ex. inspelningar i webben)
route('POST', '/api/screentime/ping', user, async (c) => {
  const { key, position } = await readJson(c.req);
  const k = /^[a-z]:\d{1,12}$/.test(String(key || '')) ? String(key) : 'x:0';
  const s = screen.heartbeat(c.user.id, k, position == null ? null : +position);
  send(c.res, 200, s ? { stop: !s.allowed, screenTime: s } : { stop: false });
});

// Följda serier och "Nytt för dig"
route('GET', '/api/follows', user, (c) => {
  const items = listItems(c.user.id, 'i.id IN (SELECT show_id FROM follows WHERE user_id=p_uid.uid AND active=1)', [], 'i.sort_title', 500, 0, { slim: true });
  const sync = new Map(all('SELECT show_id, sync FROM follows WHERE user_id=? AND active=1', c.user.id).map(r => [r.show_id, r.sync]));
  send(c.res, 200, items.map(i => ({ ...i, sync: sync.get(i.id) ?? null })));
});
route('POST', '/api/items/:id/follow', user, async (c) => {
  const it = get('SELECT id, kind, parent_id, age FROM items WHERE id=?', +c.p.id);
  if (!it || it.kind === 'movie' || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  const b = await readJson(c.req);
  const sid = follows.follow(c.user.id, it.id, b.follow !== false);
  if (b.sync !== undefined) follows.setShowSync(c.user.id, sid, b.sync);
  send(c.res, 200, follows.followInfo(c.user.id, sid));
});
route('GET', '/api/foryou', user, (c) => send(c.res, 200, listItems(c.user.id, follows.FOR_YOU_WHERE, [], follows.FOR_YOU_ORDER, 100)));
route('POST', '/api/foryou/seen', user, async (c) => { const { ids } = await readJson(c.req); follows.markSeen(c.user.id, Array.isArray(ids) ? ids : null); send(c.res, 200, { ok: true }); });
// Personlig notisadress (ntfy/webhook). Adressen kontrolleras vid varje utskick (inga lokala adresser).
const noKidNotify = (c) => { if (c.user.max_age != null) { fail(c.res, 403, 'Inte tillgängligt i barnprofiler'); return true; } return false; };
route('GET', '/api/me/notify', user, (c) => send(c.res, 200, { ...follows.getPersonal(c.user.id), allowed: c.user.max_age == null }));
route('PUT', '/api/me/notify', user, async (c) => {
  if (noKidNotify(c)) return;
  const b = await readJson(c.req);
  send(c.res, 200, follows.setPersonal(c.user.id, { kind: b.kind, url: b.url, token: b.token }));
});
route('POST', '/api/me/notify/test', user, async (c) => {
  if (noKidNotify(c)) return;
  try { await follows.testPersonal(c.user.id); send(c.res, 200, { ok: true }); }
  catch (e) { fail(c.res, e.status || 502, e.status ? e.message : 'Kunde inte skicka: ' + e.message); }
});
// Automatisk offline-synk i apparna
route('GET', '/api/me/offline-sync', user, (c) => send(c.res, 200, follows.getSync(c.user.id)));
route('PUT', '/api/me/offline-sync', user, async (c) => send(c.res, 200, follows.setSync(c.user.id, await readJson(c.req))));
route('GET', '/api/offline/sync', user, (c) => {
  const have = String(c.q.get('have') || '').split(',').filter(Boolean).slice(0, 500);
  const { ids, ...plan } = follows.syncPlan(c.user.id, have);
  send(c.res, 200, { ...plan, items: itemsByIds(c.user.id, ids) }); // itemsByIds tillämpar profilens åldersgräns
});

// ---------- Drift: diskutrymme, Prometheus, DLNA och import från Plex/Jellyfin ----------
const opsInfo = () => {
  const th = diskmon.thresholds();
  return {
    disk: diskmon.snapshot(), diskMinPct: th.pct, diskMinGb: th.gb,
    metrics: { enabled: metrics.enabled(), fromEnv: metrics.fromEnv() },
    dlna: { enabled: dlna.enabled(), name: dlna.friendlyName(), maxAge: getSetting('dlna_max_age', ''), effectiveMaxAge: dlna.maxAge(),
      running: dlna.state.running, error: dlna.state.error, addresses: dlna.state.addresses },
    users: all('SELECT id, name, parent_id FROM users ORDER BY COALESCE(parent_id, id), id')
  };
};
route('GET', '/api/ops', admin, (c) => send(c.res, 200, opsInfo()));
route('PUT', '/api/ops', admin, async (c) => {
  const b = await readJson(c.req);
  let token = null;
  if ((b.dlnaEnabled != null || b.dlnaMaxAge != null) && !isTrusted(c.req)) return fail(c.res, 403, 'Kan bara ändras från hemnätverket');
  if (b.dlnaMaxAge != null) {
    const v = String(b.dlnaMaxAge).trim();
    if (v !== '' && !/^\d{1,2}$/.test(v)) return fail(c.res, 400, 'Åldersgränsen ska vara ett tal, t.ex. 15 (tomt = som huvudkontot)');
    setSetting('dlna_max_age', v);
  }
  const disk = b.diskMinPct != null || b.diskMinGb != null;
  if (b.diskMinPct != null) setSetting('disk_min_pct', Math.max(0, Math.min(50, parseFloat(b.diskMinPct) || 0)));
  if (b.diskMinGb != null) setSetting('disk_min_gb', Math.max(0, Math.min(100000, parseFloat(b.diskMinGb) || 0)));
  if (b.metricsToken === 'new') token = metrics.newToken();
  else if (b.metricsToken === 'off') metrics.disable();
  if (b.dlnaEnabled != null) setSetting('dlna_enabled', b.dlnaEnabled ? '1' : '0');
  if (typeof b.dlnaName === 'string') setSetting('dlna_name', b.dlnaName.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'BraXhn TV');
  dlna.apply();
  if (disk) await diskmon.check();
  audit('settings_changed', { ...ctx(c), detail: 'drift: ' + Object.keys(b).join(', ') });
  send(c.res, 200, { ...opsInfo(), token });
});
route('POST', '/api/ops/disk/check', admin, async (c) => send(c.res, 200, await diskmon.check()));
route('POST', '/api/import/users', admin, async (c) => {
  const b = await readJson(c.req);
  try { send(c.res, 200, await mediaImport.jellyfinUsers({ url: b.url, apiKey: b.apiKey })); } catch (e) { fail(c.res, e.status || 502, e.message); }
});
route('POST', '/api/import/preview', admin, async (c) => {
  const b = await readJson(c.req);
  try { send(c.res, 200, await mediaImport.preview({ source: b.source, url: b.url, token: b.token, apiKey: b.apiKey, user: b.user, pathMap: b.pathMap })); }
  catch (e) { e.users ? send(c.res, 400, { error: e.message, users: e.users }) : fail(c.res, e.status || 502, e.message); }
});
route('POST', '/api/import/run', admin, async (c) => {
  const b = await readJson(c.req);
  const r = mediaImport.runImport(b.id, b.users, { overwrite: !!b.overwrite });
  for (const uid of b.users || []) invalidateProfile(+uid);
  audit('history_imported', { ...ctx(c), detail: `${r.source}: ${r.watched} sedda, ${r.progress} påbörjade, ${r.users} användare` });
  send(c.res, 200, r);
});
diskmon.start();
setTimeout(() => { try { dlna.apply(); } catch (e) { console.warn('[dlna]', e.message); } }, 1000).unref();

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
      const fresh = ext === '.html' || ext === '.webmanifest' || pathname === '/sw.js'; // nya versioner ska nå appen direkt
      const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': fresh ? 'no-cache' : 'max-age=3600' };
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
  // Prometheus (egen token) och DLNA (bara betrodda nät, utan inloggning) ligger utanför /api/
  if (url.pathname === '/metrics') return metrics.serve(req, res);
  if (url.pathname.startsWith('/dlna/')) return dlna.handle(req, res, url, { trusted: isTrusted(req) });
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
      else if (u.kind === 'media' && u.scope_item && String(u.scope_item) !== (r.scope ? String(r.scope(p)) : r.music ? String(-(+p.tid)) : String(p.id))) c.user = null;
      else if (u.kind === 'img' && !r.img) c.user = null;
    }
    if (r.auth && !c.user) return fail(res, 401, 'Inte inloggad');
    if (c.user) {
      const trusted = isTrusted(req);
      if (!trusted && !c.user.remote_allowed) return fail(res, 403, 'Ditt konto får bara användas på hemnätverket');
      // Profiler ärver huvudkontots tvåstegsverifiering (de nås bara via ett inloggat hushåll)
      // (slås bara upp när det behövs – inte för varje segment och affisch)
      const has2fa = () => { const owner = c.user.parent_id || c.user.id;
        return c.user.totp_enabled || (c.user.parent_id && get('SELECT totp_enabled FROM users WHERE id=?', c.user.parent_id)?.totp_enabled) || pk.hasPasskey(owner); };
      if (!trusted && (c.user.kind === 'web' || c.user.kind === 'app') && require2faRemote() && !has2fa()) return fail(res, 403, 'Tvåstegsverifiering krävs utanför hemmet');
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
