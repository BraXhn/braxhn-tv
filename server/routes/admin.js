// Administration: integritetskontroll, Let's Encrypt, användare, inställningar, uppdateringar, aktivitet,
// säkerhetskopior, återställning, revisionslogg, säkerhetskontroll samt drift (disk, Prometheus, DLNA, import).
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { getSetting, setSetting, all, run, now, get, tx, RESTORE_FILE } from '../db.js';
import { send, readJson, fail, isLocalReq, isHttps, clientIp, peerIp, isPrivate } from '../util.js';
import { audit, weakPassword, hashPw, require2faRemote, quickConnectOn } from '../auth.js';
import { autoSubs, scan } from '../scanner.js';
import * as st from '../stream.js';
import * as act from '../activity.js';
import * as acme from '../acme.js';
import * as updates from '../updates.js';
import { VERSION } from '../updates.js';
import * as offsite from '../offsite.js';
import { checkManifest } from '../verify.js';
import * as ver from '../versions.js';
import * as diskmon from '../diskmon.js';
import * as metrics from '../metrics.js';
import * as dlna from '../dlna.js';
import * as mediaImport from '../mediaimport.js';
import { route, admin, user, adminAnywhere, trustVpn, isTrusted } from '../http/router.js';
import { ctx, MEDIA_ROOT, allowUnrated, invalidateProfile, insideMedia } from '../http/context.js';
import * as cinema from '../cinema.js';
import * as jobs from '../jobs.js';
import * as subsonic from '../subsonic.js';
import * as logs from '../logs.js';
import * as bookmeta from '../bookmeta.js';
import * as invites from '../invites.js';
import * as listen from '../listening.js';
import { normLibs, normQuality, normStreams } from '../perms.js';
import os from 'node:os';
import { execFile } from 'node:child_process';

// Integritetskontroll: vid start och högst var 10:e minut (läser alla programfiler)
let integCache = null, integAt = 0;
const integrity = () => { if (Date.now() - integAt > 600e3) { try { integCache = checkManifest(); } catch { integCache = null; } integAt = Date.now(); } return integCache; };
setTimeout(() => { const r = integrity(); if (r && !r.ok) console.warn('[integritet] ändrade programfiler:', [...r.changed, ...r.added].join(', ')); else if (r) console.log(`[integritet] ${r.files} programfiler stämmer`); }, 2000).unref();

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

// Admin: användare och inställningar
// Rättigheter per användare (perms.js): libraries (null = alla), canDownload, remoteQuality (tak utanför hemmet), maxStreams.
// Profiler (parent) visas också: de ärver kontots bibliotek om de inte har en egen lista.
const parseLibs = (s) => { if (s == null) return null; try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };
route('GET', '/api/users', admin, (c) => send(c.res, 200, all(`SELECT id,name,is_admin,created,totp_enabled,remote_allowed,pw_changed,parent_id,max_age,
  libraries,can_download,remote_quality,max_streams,
  (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id=users.id AND s.kind IN ('web','app')) AS last_seen FROM users ORDER BY name`)
  .map(({ libraries, can_download, remote_quality, max_streams, ...u }) => ({ ...u, libraries: parseLibs(libraries), canDownload: !!can_download,
    remoteQuality: remote_quality || null, maxStreams: max_streams || null }))));
/** Rättigheterna i kroppen (bara de fält som skickas). Kastar Error med status 400 vid ogiltiga värden. */
function permsBody(b) {
  const out = {};
  if (b.libraries !== undefined) out.libraries = normLibs(b.libraries);
  if (b.canDownload !== undefined) out.canDownload = !!b.canDownload;
  if (b.remoteQuality !== undefined) out.remoteQuality = normQuality(b.remoteQuality);
  if (b.maxStreams !== undefined) out.maxStreams = normStreams(b.maxStreams);
  return out;
}
function savePerms(uid, p) {
  if ('libraries' in p) run('UPDATE users SET libraries=? WHERE id=?', p.libraries == null ? null : JSON.stringify(p.libraries), uid);
  if ('canDownload' in p) run('UPDATE users SET can_download=? WHERE id=?', p.canDownload ? 1 : 0, uid);
  if ('remoteQuality' in p) run('UPDATE users SET remote_quality=? WHERE id=?', p.remoteQuality, uid);
  if ('maxStreams' in p) run('UPDATE users SET max_streams=? WHERE id=?', p.maxStreams, uid);
  // Korta cacher per användare (smarta listor) räknas om direkt – titlar och strömmar kontrolleras alltid på nytt
  listen.clearSmartCache();
}
const permsText = (p) => [p.libraries !== undefined && (p.libraries == null ? 'alla bibliotek' : `bibliotek ${p.libraries.join(',') || 'inga'}`),
  p.canDownload !== undefined && (p.canDownload ? 'nedladdning på' : 'nedladdning av'),
  p.remoteQuality !== undefined && `tak utanför hemmet ${p.remoteQuality ? p.remoteQuality + 'p' : 'som servern'}`,
  p.maxStreams !== undefined && `samtidiga strömmar ${p.maxStreams || 'obegränsat'}`].filter(Boolean);
route('POST', '/api/users', admin, async (c) => {
  const b = await readJson(c.req);
  const { name, password, isAdmin, remoteAllowed } = b;
  if (!name?.trim() || name.trim().length > 64) return fail(c.res, 400, 'Namn krävs');
  const weak = weakPassword(password, name); if (weak) return fail(c.res, 400, weak);
  let perms; try { perms = permsBody(b); } catch (e) { return fail(c.res, 400, e.message); }
  let uid;
  try { uid = Number(run('INSERT INTO users(name,pass,is_admin,created,remote_allowed,pw_changed) VALUES(?,?,?,?,?,?)', name.trim(), await hashPw(password), isAdmin ? 1 : 0, now(), remoteAllowed === false ? 0 : 1, now()).lastInsertRowid); }
  catch { return fail(c.res, 409, 'Namnet är upptaget'); }
  savePerms(uid, perms);
  audit('user_created', { ...ctx(c), detail: `${name.trim()}${isAdmin ? ' (admin)' : ''}` });
  send(c.res, 200, { ok: true, id: uid });
});
route('PUT', '/api/users/:id', admin, async (c) => {
  const b = await readJson(c.req);
  const { password, isAdmin, remoteAllowed, reset2fa, logoutAll } = b;
  const target = get('SELECT id,name,parent_id FROM users WHERE id=?', +c.p.id);
  if (!target) return fail(c.res, 404, 'Finns inte');
  let perms; try { perms = permsBody(b); } catch (e) { return fail(c.res, 400, e.message); }
  // Samtidiga strömmar och kvalitetstak gäller hushållet och sätts på kontot (profilerna ärver)
  if (target.parent_id != null && (perms.maxStreams !== undefined || perms.remoteQuality !== undefined)) return fail(c.res, 400, 'Ändra kvalitetstak och samtidiga strömmar på kontot – profilerna ärver dem');
  const changes = [];
  if (Object.keys(perms).length) { savePerms(target.id, perms); changes.push(...permsText(perms)); }
  if (password) {
    const weak = weakPassword(password, target.name); if (weak) return fail(c.res, 400, weak);
    run('UPDATE users SET pass=?, pw_changed=? WHERE id=?', await hashPw(password), now(), target.id);
    run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=?1 OR parent_id=?1)', target.id); subsonic.revokeHousehold(target.id); changes.push('nytt lösenord');
  }
  if (isAdmin != null && target.id !== c.user.id) { run('UPDATE users SET is_admin=? WHERE id=?', isAdmin ? 1 : 0, target.id); changes.push(isAdmin ? 'admin' : 'ej admin'); }
  if (remoteAllowed != null) {
    // Profilerna ärver kontots fjärråtkomst
    run('UPDATE users SET remote_allowed=?1 WHERE id=?2 OR parent_id=?2', remoteAllowed ? 1 : 0, target.id); changes.push(remoteAllowed ? 'fjärråtkomst på' : 'fjärråtkomst av');
    if (!remoteAllowed) run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=?1 OR parent_id=?1) AND kind IN ('media','img')", target.id);
  }
  if (reset2fa) { run('UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_pending=NULL, recovery=NULL WHERE id=?', target.id); changes.push('2FA återställd'); }
  if (logoutAll) { run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=?1 OR parent_id=?1) AND token != ?2', target.id, c.user.tokenHash); subsonic.revokeHousehold(target.id); changes.push('utloggad överallt'); }
  audit('user_updated', { ...ctx(c), detail: `${target.name}: ${changes.join(', ')}` });
  send(c.res, 200, { ok: true });
});
// ---------- Inbjudningslänkar (server/invites.js) ----------
// Token visas bara i svaret när inbjudan skapas; webben bygger länken <adress>/#/invite/<token>
route('GET', '/api/invites', admin, (c) => send(c.res, 200, { invites: invites.list(), maxDays: invites.MAX_DAYS }));
route('POST', '/api/invites', admin, async (c) => {
  const b = await readJson(c.req);
  try {
    const r = invites.create(c.user.id, b);
    audit('invite_created', { ...ctx(c), detail: `${r.invite.note || 'inbjudan'} – giltig till ${new Date(r.invite.expires * 1000).toISOString().slice(0, 10)}` });
    send(c.res, 200, { ...r.invite, token: r.token, path: `/#/invite/${r.token}` });
  } catch (e) { fail(c.res, e.status || 400, e.message); }
});
route('DELETE', '/api/invites/:iid', admin, (c) => {
  if (!invites.remove(+c.p.iid)) return fail(c.res, 404, 'Finns inte');
  audit('invite_removed', ctx(c));
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
    adminAnywhere: adminAnywhere(), require2faRemote: require2faRemote(), quickConnect: quickConnectOn(), subsonic: subsonic.enabled(), trustedNetworks: getSetting('trusted_networks', ''), trustVpnRange: trustVpn(),
    clientIp: clientIp(c.req), peerIp: peerIp(c.req),
    maxTranscodes: st.limits().global, maxTranscodesUser: st.limits().user,
    watchEnabled: getSetting('watch_enabled', process.env.WATCH_FILES || '1') === '1', watching: act.watchingCount(), allowUnrated: allowUnrated(),
    trickplay: getSetting('trickplay', process.env.TRICKPLAY || '1') === '1', detectRecap: getSetting('detect_recap', '1') === '1',
    bookMeta: bookmeta.enabled(), bookMetaStatus: bookmeta.status,
    cinemaPreroll: cinema.prerollSetting(), cinemaPrerollFiles: cinema.prerollFiles(insideMedia).length
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
  if (b.remoteQuality && st.isQuality(b.remoteQuality)) setSetting('remote_quality', b.remoteQuality);
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
  if (b.quickConnect != null) setSetting('quick_connect', b.quickConnect ? '1' : '0');
  if (b.subsonic != null) setSetting('subsonic', b.subsonic ? '1' : '0');
  if (typeof b.trustedNetworks === 'string') {
    const nets = b.trustedNetworks.split(',').map(s => s.trim()).filter(Boolean);
    if (nets.some(n => !/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-f:]+$/i.test(n))) return fail(c.res, 400, 'Ange nät som t.ex. 10.8.0.0/24, kommaseparerade');
    if (nets.some(n => n.includes('/') && parseInt(n.split('/')[1]) < 16)) return fail(c.res, 400, 'För stora nät (minst /16) – annars kan hela internet räknas som hemma');
    if (!isTrusted(c.req)) return fail(c.res, 403, 'Kan bara ändras från hemnätverket');
    setSetting('trusted_networks', nets.join(','));
  }
  if (typeof b.cinemaPreroll === 'string') {
    // Bio-lägets förfilm: en videofil eller en mapp att slumpa från, under mediamappen (eller tomt = ingen)
    const p = b.cinemaPreroll.trim();
    const err = cinema.checkPreroll(p, insideMedia);
    if (err) return fail(c.res, 400, err);
    setSetting('cinema_preroll', p ? insideMedia(p) : '');
    cinema.forgetPreroll();
  }
  if (b.trickplay != null) setSetting('trickplay', b.trickplay ? '1' : '0');
  if (b.detectRecap != null) setSetting('detect_recap', b.detectRecap ? '1' : '0');
  if (b.bookMeta != null) setSetting('book_meta', b.bookMeta ? '1' : '0');
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
  if (st.hwStatus.error) add('warn', `Hårdvaruomkodning (${st.hwStatus.wanted}) fungerar inte – processorn används`,
    `Fel: ${st.hwStatus.error}. ${st.hwStatus.hint ? 'Åtgärd: ' + st.hwStatus.hint : 'För NVIDIA krävs pluginen Nvidia-Driver och --runtime=nvidia i Extra Parameters; för Intel/AMD enheten /dev/dri.'} Annars: sätt HWACCEL=none.`);
  if (old.length) add('warn', 'Konton med äldre lösenordsformat', old.join(', ') + ' – uppgraderas automatiskt vid nästa lösenordsbyte.');
  items.push(...diskmon.checkItems());
  if (dlna.enabled()) add('info', 'DLNA är påslaget', 'Alla enheter på hemnätet kan se och spela upp det som DLNA visar, utan inloggning' + (dlna.maxAge() != null ? ` (titlar upp till ${dlna.maxAge()} år).` : '.'));
  send(c.res, 200, items);
});

// ---------- Drift: diskutrymme, Prometheus, DLNA och import från Plex/Jellyfin ----------
const opsInfo = () => {
  const th = diskmon.thresholds();
  return {
    disk: diskmon.snapshot(), diskMinPct: th.pct, diskMinGb: th.gb,
    metrics: { enabled: metrics.enabled(), fromEnv: metrics.fromEnv() },
    dlna: { enabled: dlna.enabled(), name: dlna.friendlyName(), maxAge: getSetting('dlna_max_age', ''), effectiveMaxAge: dlna.maxAge(), libraries: dlna.libraries(),
      running: dlna.state.running, error: dlna.state.error, addresses: dlna.state.addresses },
    users: all('SELECT id, name, parent_id FROM users ORDER BY COALESCE(parent_id, id), id')
  };
};
route('GET', '/api/ops', admin, (c) => send(c.res, 200, opsInfo()));
route('PUT', '/api/ops', admin, async (c) => {
  const b = await readJson(c.req);
  let token = null;
  if ((b.dlnaEnabled != null || b.dlnaMaxAge != null || b.dlnaLibraries !== undefined) && !isTrusted(c.req)) return fail(c.res, 403, 'Kan bara ändras från hemnätverket');
  // Bibliotek som DLNA visar: null = alla, annars en lista med id (rättigheter per användare, fast för hela hemnätet)
  if (b.dlnaLibraries !== undefined) {
    try { const l = normLibs(b.dlnaLibraries); setSetting('dlna_libraries', l == null ? '' : JSON.stringify(l)); } catch (e) { return fail(c.res, 400, e.message); }
  }
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

// Pågående jobb för aktivitetsindikatorn i menyraden (skanning, analys, omkodning, inspelning …)
route('GET', '/api/jobs', admin, (c) => send(c.res, 200, { jobs: jobs.list() }));

// ---------- Logg och diagnostik (som Jellyfins loggvy) ----------
route('GET', '/api/logs', admin, (c) => send(c.res, 200, { lines: logs.lines({ level: c.q.get('level') || 'info', q: c.q.get('q') || '', after: +c.q.get('after') || 0, limit: +c.q.get('limit') || 500 }) }));
// Diagnostikpaket att bifoga vid felsökning: versioner, maskin, hårdvarukodning, inställningar utan hemligheter och loggen
route('GET', '/api/logs/diagnostics', admin, async (c) => {
  const ff = await new Promise(r => execFile('ffmpeg', ['-hide_banner', '-version'], { timeout: 5000 }, (e, o) => r(e ? `saknas (${e.message})` : String(o).split('\n')[0])));
  const ver = (k) => { try { return get('SELECT COUNT(*) AS n FROM ' + k).n; } catch { return '?'; } };
  const info = {
    BraXhnTV: VERSION, node: process.version, ffmpeg: ff, os: `${os.type()} ${os.release()} ${os.arch()}`, cpus: `${os.cpus().length} × ${os.cpus()[0]?.model || '?'}`,
    minne: `${Math.round(os.totalmem() / 2 ** 30)} GB totalt, ${Math.round(os.freemem() / 2 ** 30)} GB ledigt`, upptid: `${Math.round(process.uptime() / 60)} min`,
    hårdvarukodning: st.hwStatus, omkodningar: st.activeTranscodes().length, gränser: st.limits(),
    bibliotek: all('SELECT id,name,type FROM libraries'), titlar: ver('items'), användare: ver('users'),
    miljö: Object.fromEntries(['HWACCEL', 'HW_DECODE', 'VAAPI_DEVICE', 'TONEMAP', 'X264_PRESET', 'REMOTE_QUALITY', 'TRANSCODE_DIR', 'MEDIA_ROOT', 'TZ', 'PUID', 'PGID', 'NVIDIA_VISIBLE_DEVICES']
      .filter(k => process.env[k] != null).map(k => [k, process.env[k]])),
    disk: diskmon.snapshot(), jobb: jobs.list()
  };
  const body = `BraXhn TV – diagnostik ${new Date().toISOString()}\n\n${logs.mask(JSON.stringify(info, null, 2))}\n\n--- Logg (senaste ${logs.lines({ limit: 2000 }).length} raderna) ---\n`
    + logs.lines({ limit: 2000 }).map(l => `${new Date(l.t).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${l.msg}`).join('\n') + '\n';
  send(c.res, 200, Buffer.from(body), { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="braxhn-diagnostik-${new Date().toISOString().slice(0, 10)}.txt"` });
});
// Fel i webbappen hos användarna hamnar i serverloggen (Safari/iPhone, TV-webbläsare … som CI inte kör).
// Högst 20 rapporter per användare och 10 minuter; korta, maskerade och utan HTML.
const clientErr = new Map();
route('POST', '/api/clientlog', user, async (c) => {
  const k = c.user.id, n = clientErr.get(k);
  const fresh = !n || n.at < Date.now() - 10 * 60e3;
  if (!fresh && n.count >= 20) return send(c.res, 200, { ok: true });
  clientErr.set(k, fresh ? { at: Date.now(), count: 1 } : { ...n, count: n.count + 1 });
  if (clientErr.size > 1000) clientErr.clear();
  const b = await readJson(c.req, 16 << 10).catch(() => ({}));
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').slice(0, max);
  console.warn(`[webb] ${clean(b.msg, 300)} | ${clean(b.where, 200)} | ${clean(b.ua, 160)} | användare ${k}${b.stack ? '\n  ' + clean(b.stack, 1500).replace(/ {2,}at /g, '\n  at ') : ''}`);
  send(c.res, 200, { ok: true });
});
