import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, all, run, now, getSetting, setSetting, IMAGES } from './db.js';
import { send, fail, readJson, MIME, clientIp, peerIp, isLocalReq, isHttps, isPrivate, inCidr } from './util.js';
import { hashPw, checkPw, dummyCheck, weakPassword, createSession, cookieHeader, userFromReq, listSessions, ipBlocked, userLocked, noteFail,
  clearFails, newTotpSecret, totpUri, verifyTotp, newRecoveryCodes, useRecoveryCode, audit, require2faRemote, clearCookies } from './auth.js';
import { scan, status as scanStatus, refreshItem, extractThumb, removeImages, hooks } from './scanner.js';
import * as st from './stream.js';
import * as os from './opensubtitles.js';
import { detectMarkers } from './intro.js';
import * as act from './activity.js';

hooks.keyframes = (it) => st.computeKeyframes(it);
hooks.markers = (lib, status) => detectMarkers(lib, status);

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/media');
const VERSION = '0.3.0';

// ---------- formning av objekt ----------
const PROG = `p.position AS p_pos, p.watched AS p_watched, p.updated AS p_updated,
  (SELECT COUNT(*) FROM items e WHERE e.parent_id=i.id) AS ep_total,
  (SELECT COUNT(*) FROM items e JOIN progress q ON q.item_id=e.id AND q.user_id=p_uid.uid AND q.watched=1 WHERE e.parent_id=i.id) AS ep_watched`;
const FROM = `FROM items i JOIN (SELECT ? AS uid) p_uid LEFT JOIN progress p ON p.item_id=i.id AND p.user_id=p_uid.uid`;

function shape(r) {
  const o = {
    id: r.id, kind: r.kind, title: r.title, year: r.year, library: r.library_id,
    poster: !!r.poster, backdrop: !!r.backdrop, thumb: !!r.thumb,
    duration: r.duration, rating: r.rating, overview: r.overview, added: r.added, hdr: r.hdr || null
  };
  if (r.kind === 'episode') Object.assign(o, { season: r.season, episode: r.episode, show: r.parent_id, showTitle: r.show_title });
  if (r.kind === 'show') Object.assign(o, { episodes: r.ep_total, watchedEpisodes: r.ep_watched, watched: r.ep_total > 0 && r.ep_total === r.ep_watched });
  else Object.assign(o, { position: r.p_pos || 0, watched: !!r.p_watched, height: r.height,
    intro: r.intro_end ? { start: r.intro_start || 0, end: r.intro_end } : null, credits: r.credits_start || null });
  return o;
}
const listItems = (uid, where, params = [], order = 'i.sort_title', limit = 500, offset = 0) =>
  all(`SELECT i.*, s.title AS show_title, ${PROG} ${FROM} LEFT JOIN items s ON s.id=i.parent_id WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    uid, ...params, limit, offset).map(shape);
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
    adminHere: !!c.user.is_admin && (adminAnywhere() || isTrusted(c.req)) } : null
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
  const u = get('SELECT * FROM users WHERE name=?', uname);
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

// Bibliotek
route('GET', '/api/libraries', user, (c) => send(c.res, 200, all(`SELECT l.*,
  (SELECT COUNT(*) FROM items i WHERE i.library_id=l.id AND i.kind IN('movie','show')) AS count FROM libraries l ORDER BY l.name`)));
route('POST', '/api/libraries', admin, async (c) => {
  const { name, type, path: p } = await readJson(c.req);
  const real = insideMedia(String(p || ''));
  if (!name?.trim() || !['movie', 'show'].includes(type)) return fail(c.res, 400, 'Namn och typ krävs');
  if (!real) return fail(c.res, 400, `Sökvägen måste finnas och ligga under ${MEDIA_ROOT}`);
  const id = Number(run('INSERT INTO libraries(name,type,path) VALUES(?,?,?)', name.trim(), type, real).lastInsertRowid);
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
  const rows = all('SELECT * FROM libraries ORDER BY name').map(l => ({
    library: l, title: `Nytt i ${l.name}`,
    items: listItems(uid, `i.library_id=? AND i.kind=?`, [l.id, l.type], 'i.added DESC', 24)
  }));
  send(c.res, 200, { continue: cont, rows });
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
  const out = oneItem(uid, it.id);
  if (it.kind === 'show') {
    out.children = listItems(uid, 'i.parent_id=?', [it.id], 'i.season, i.episode', 5000);
    out.next = out.children.find(e => !e.watched && e.position > 0) || out.children.find(e => !e.watched) || out.children[0] || null;
  } else {
    Object.assign(out, {
      file: path.basename(it.path), size: it.size, container: it.container, vcodec: it.vcodec, acodec: it.acodec,
      width: it.width, height: it.height,
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
  const it = get('SELECT id,duration FROM items WHERE id=? AND kind!=\'show\'', c.p.id);
  if (!it) return fail(c.res, 404, 'Finns inte');
  const dur = it.duration || +duration || 0, pos = Math.max(0, +position || 0);
  const watched = dur && (pos / dur > 0.92 || dur - pos < 120 && pos > 60) ? 1 : 0;
  run(`INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,item_id) DO UPDATE SET position=excluded.position, duration=excluded.duration,
    watched=MAX(watched,excluded.watched), updated=excluded.updated`, c.user.id, it.id, watched ? 0 : pos, dur, watched, now());
  if (watched) run('UPDATE progress SET position=0 WHERE user_id=? AND item_id=?', c.user.id, it.id);
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
route('PUT', '/api/items/:id', admin, async (c) => {
  const { title, year, overview } = await readJson(c.req);
  run(`UPDATE items SET title=COALESCE(?,title), sort_title=COALESCE(lower(?),sort_title), year=?, overview=? WHERE id=?`,
    title || null, title || null, year ? +year : null, overview ?? null, c.p.id);
  send(c.res, 200, { ok: true });
});

// Bilder
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
  act.startPlay({ user: c.user, item: it, mode: d.mode, quality: d.q, ip: clientIp(c.req), remote, ua: c.req.headers['user-agent'], reasons: d.reasons });
  const subs = st.subtitlesOf(it).filter(s => !s.bitmap).map(s => ({
    id: s.id, label: s.label, lang: s.lang, forced: s.forced, url: `${base}/subs/${s.id}.vtt${tq}`
  }));
  send(c.res, 200, {
    mode: d.mode, url, reasons: d.reasons, hdr: it.hdr, tonemap: d.tonemap, burn: d.burn || null,
    duration: it.duration, subtitles: subs, token, remote, quality: d.q,
    intro: it.intro_end ? { start: it.intro_start || 0, end: it.intro_end } : null, credits: it.credits_start || null,
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
    remoteQuality: getSetting('remote_quality', process.env.REMOTE_QUALITY || '1080'), publicUrl: getSetting('public_url', process.env.PUBLIC_URL || ''),
    youAreLocal: isLocalReq(c.req), https: isHttps(c.req), tlsBuiltin: !!globalThis.__braxhnTls,
    adminAnywhere: adminAnywhere(), require2faRemote: require2faRemote(), trustedNetworks: getSetting('trusted_networks', ''), trustVpnRange: trustVpn(),
    clientIp: clientIp(c.req), peerIp: peerIp(c.req),
    maxTranscodes: st.limits().global, maxTranscodesUser: st.limits().user,
    watchEnabled: getSetting('watch_enabled', process.env.WATCH_FILES || '1') === '1', watching: act.watchingCount()
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
  if (b.backupEnabled != null) setSetting('backup_enabled', b.backupEnabled ? '1' : '0');
  if (b.backupKeep != null) setSetting('backup_keep', Math.max(1, Math.min(365, parseInt(b.backupKeep) || 14)));
  if (b.watchEnabled != null) { setSetting('watch_enabled', b.watchEnabled ? '1' : '0'); act.watchLibraries(scan); }
  if (b.maxTranscodes != null) setSetting('max_transcodes', Math.max(1, Math.min(32, parseInt(b.maxTranscodes) || 4)));
  if (b.maxTranscodesUser != null) setSetting('max_transcodes_user', Math.max(1, Math.min(16, parseInt(b.maxTranscodesUser) || 2)));
  audit('settings_changed', { ...ctx(c), detail: changed.join(', ') });
  send(c.res, 200, { ok: true });
});

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
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'",
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
      else if (u.kind === 'media' && u.scope_item && String(u.scope_item) !== String(p.id)) c.user = null;
      else if (u.kind === 'img' && !r.img) c.user = null;
    }
    if (r.auth && !c.user) return fail(res, 401, 'Inte inloggad');
    if (c.user) {
      const trusted = isTrusted(req);
      if (!trusted && !c.user.remote_allowed) return fail(res, 403, 'Ditt konto får bara användas på hemnätverket');
      if (!trusted && (c.user.kind === 'web' || c.user.kind === 'app') && require2faRemote() && !c.user.totp_enabled) return fail(res, 403, 'Tvåstegsverifiering krävs utanför hemmet');
    }
    if (r.admin) {
      if (!c.user.is_admin) return fail(res, 403, 'Kräver administratör');
      if (!adminAnywhere() && !isTrusted(req)) { audit('admin_denied', { user: c.user, ip: clientIp(req), detail: url.pathname }); return fail(res, 403, 'Administration är bara tillåten från hemnätverket eller VPN'); }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && c.user?.via === 'cookie' && !sameOrigin(req)) return fail(res, 403, 'Förfrågan från annan webbplats nekades');
    if (!c.user && !['GET', 'HEAD'].includes(req.method) && !sameOrigin(req) && r.method === 'POST' && /\/api\/(login|setup)$/.test(url.pathname) && req.headers.origin) return fail(res, 403, 'Förfrågan från annan webbplats nekades');
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
