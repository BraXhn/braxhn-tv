// IPTV: kanaler per profil (favoriter, grupper, barnprofiler), TV-guidens rutnät, påminnelser, catch-up, filmer och
// serier från Xtream, och administrationen av källor, guider, kanaler och grupper (admin = betrott nät, routern).
// Live-strömmarna och inspelningarna ligger kvar i routes/livetv.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { get, now, IMAGES, getSetting, setSetting } from '../db.js';
import { fail, send, readJson, clientIp } from '../util.js';
import { createSession, audit } from '../auth.js';
import * as pods from '../podcasts.js';
import * as live from '../livetv.js';
import * as CH from '../iptv/channels.js';
import * as VOD from '../iptv/vod.js';
import * as SRC from '../iptv/sources.js';
import * as ADM from '../iptv/admin.js';
import * as PB from '../iptv/playback.js';
import { catchupUrl, catchupWindow } from '../iptv/catchup.js';
import { cleanHeaders } from '../iptv/net.js';
import { screenBlock, ctx, allowUnrated } from '../http/context.js';
import { route, user, img, admin } from '../http/router.js';
import { sendPersonal, PERSONAL_KINDS } from '../notify.js';

const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
// Barnprofiler: bara om någon kanal finns inom åldersgränsen (kanalens/gruppens) – annars som förut
const liveOk = (c) => {
  if (c.user.max_age != null && !allowUnrated() && !CH.kidsHaveChannels(c.user)) { fail(c.res, 403, 'Live-TV är inte tillgängligt i barnprofiler'); return false; }
  return true;
};
const vodOk = (c) => { if (!VOD.vodAllowed(c.user)) { fail(c.res, 403, 'Filmer och serier från IPTV är inte tillgängliga i barnprofiler'); return false; } return true; };
const mediaToken = (c, scope) => c.user.via !== 'cookie' || c.q.get('cast') === '1' ? createSession(c.user.id, 'media', { item: scope, ip: clientIp(c.req) }) : null;

// ---------- kanaler och guide ----------
route('GET', '/api/iptv/channels', user, (c) => {
  if (!liveOk(c)) return;
  const list = CH.channelsFor(c.user);
  send(c.res, 200, { channels: list, groups: CH.groupsOf(list), favorites: list.filter(x => x.favorite).map(x => x.id), now: now(),
    prestart: getSetting('iptv_prestart', '1') === '1', vod: VOD.vodAllowed(c.user) && !!get('SELECT 1 FROM iptv_vod LIMIT 1') });
});
// Program för några kanaler i ett tidsfönster (rutnätet hämtar det som syns). Bakåt så långt som catch-up räcker.
route('GET', '/api/iptv/epg', user, (c) => {
  if (!liveOk(c)) return;
  const ids = [...new Set(String(c.q.get('ids') || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 300);
  const T = now();
  const from = Math.max(T - 31 * 86400, parseInt(c.q.get('from'), 10) || T - 1800);
  const to = Math.min(from + 26 * 3600, parseInt(c.q.get('to'), 10) || from + 6 * 3600);
  send(c.res, 200, { from, to, programs: ids.length ? CH.epgFor(c.user, ids, from, to) : {}, guide: live.guideState });
});
route('GET', '/api/iptv/programs/:pid', user, (c) => {
  if (!liveOk(c)) return;
  const p = CH.programFor(c.user, +c.p.pid);
  p ? send(c.res, 200, p) : fail(c.res, 404, 'Finns inte');
});
route('GET', '/api/iptv/search', user, (c) => {
  if (!liveOk(c)) return;
  send(c.res, 200, live.searchPrograms(String(c.q.get('q') || '').slice(0, 80), { limit: 150 }).filter(p => CH.channelAllowed(c.user, p.channel_id)).slice(0, 100));
});
route('PUT', '/api/iptv/favorites/:cid', user, async (c) => {
  const b = await readJson(c.req);
  if (!get('SELECT 1 FROM channels WHERE id=?', +c.p.cid) || !CH.channelAllowed(c.user, +c.p.cid)) return fail(c.res, 404, 'Kanalen finns inte');
  CH.setFavorite(c.user, +c.p.cid, b.on !== false);
  send(c.res, 200, { ok: true });
});
// Snabbt kanalbyte: nästa kanal startas i förväg när källan har en anslutning över (stängs efter 45 s om ingen tittar)
route('POST', '/api/iptv/channels/:cid/prestart', user, async (c) => {
  if (getSetting('iptv_prestart', '1') !== '1') return send(c.res, 200, { started: false });
  const ch = get('SELECT * FROM channels WHERE id=?', +c.p.cid);
  if (!ch || !CH.channelAllowed(c.user, ch.id) || screenBlock(c)) return send(c.res, 200, { started: false });
  const t = get('SELECT tuner_count FROM tuners WHERE id=? AND enabled=1', ch.tuner_id);
  const used = live.tunersInUse()[ch.tuner_id] || 0;
  if (!t || used >= t.tuner_count || live.activeLive().some(a => a.channelId === ch.id)) return send(c.res, 200, { started: false });
  live.ensureLive(ch).catch(() => {});
  send(c.res, 200, { started: true });
});

// ---------- påminnelser ----------
route('GET', '/api/iptv/reminders', user, (c) => send(c.res, 200, { reminders: CH.reminders(c.user, { due: c.q.get('due') === '1' }) }));
route('POST', '/api/iptv/programs/:pid/reminder', user, (c) => {
  if (!liveOk(c)) return;
  try { if (!CH.addReminder(c.user, +c.p.pid)) return fail(c.res, 404, 'Finns inte'); } catch (e) { return fail(c.res, 400, e.message); }
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/iptv/programs/:pid/reminder', user, (c) => { CH.removeReminder(c.user, +c.p.pid); send(c.res, 200, { ok: true }); });
// Personlig notis (ntfy/webhook under Konto) två minuter före start
const personalOf = (uid) => { const x = json(get('SELECT notify_personal FROM users WHERE id=?', uid)?.notify_personal, null); return x && PERSONAL_KINDS.includes(x.kind) && x.url ? x : null; };
const poster = async (url, body, headers) => { const r = await pods.safePost(url, body, { headers }); if (!r.ok) throw new Error(`${r.status}`); };
setInterval(() => {
  CH.sendDue(async (uid, title, msg) => { const p = personalOf(uid); if (p) await sendPersonal(p, title, msg, poster); }).catch(() => {});
}, 30000).unref();

// ---------- catch-up ----------
const sessionUrl = (s, t) => `/api/iptv/play/${s.sid}/index.m3u8${t ? '?t=' + t : ''}`;
route('POST', '/api/iptv/programs/:pid/catchup', user, async (c) => {
  if (!liveOk(c) || screenBlock(c)) return;
  const p = get('SELECT * FROM programs WHERE id=?', +c.p.pid);
  const ch = p && get('SELECT c.*, e.catchup, e.catchup_days, e.catchup_source, e.headers AS ch_headers FROM channels c LEFT JOIN channel_ext e ON e.channel_id=c.id WHERE c.id=?', p.channel_id);
  if (!p || !ch || !CH.channelAllowed(c.user, ch.id)) return fail(c.res, 404, 'Finns inte');
  if (!catchupWindow(ch, p)) return fail(c.res, 400, 'Programmet finns inte i kanalens arkiv');
  const ctxS = SRC.sourceCtx(ch.tuner_id); if (!ctxS) return fail(c.res, 400, 'Catch-up finns bara för IPTV-kanaler');
  const len = p.stop - p.start;
  const offset = Math.max(0, Math.min(len - 30, parseInt(c.q.get('offset'), 10) || 0));
  const url = catchupUrl({ ...ch, tz: ctxS.tz }, { start: p.start + offset, stop: p.stop });
  if (!url) return fail(c.res, 400, 'Kanalens catch-up-adress kan inte byggas');
  try {
    const s = await PB.start({ user: c.user, kind: 'catchup', ref: p.id, url, headers: cleanHeaders({ ...ctxS.headers, ...json(ch.ch_headers, {}) }), pol: ctxS.pol,
      tunerId: ch.tuner_id, title: p.title, duration: len - offset, offset });
    const t = mediaToken(c, PB.PLAY_SCOPE + s.sid);
    send(c.res, 200, { sid: s.sid, url: sessionUrl(s, t), token: t, offset, duration: len, start: p.start, stop: p.stop, title: p.title, channel: ch.name, channelId: ch.id });
  } catch (e) { fail(c.res, e.status || 502, e.message); }
});
const playStream = { auth: true, media: true, scope: (p) => PB.PLAY_SCOPE + (+p.sid) };
route('GET', '/api/iptv/play/:sid/index.m3u8', playStream, async (c) => {
  const s = PB.session(+c.p.sid, c.user.id); if (!s) return fail(c.res, 404, 'Uppspelningen har avslutats');
  if (screenBlock(c)) return;
  await PB.servePlaylist(c.res, s, c.q.get('t'));
});
route('GET', '/api/iptv/play/:sid/seg-:n.ts', playStream, (c) => {
  const s = PB.session(+c.p.sid, c.user.id); if (!s) return fail(c.res, 404, 'Finns inte');
  if (screenBlock(c)) return;
  PB.serveSegment(c.req, c.res, s, `seg-${c.p.n}.ts`);
});
route('GET', '/api/iptv/play/:sid/status', user, (c) => {
  const s = PB.session(+c.p.sid, c.user.id); if (!s) return fail(c.res, 404, 'Finns inte');
  send(c.res, 200, { offset: s.offset, produced: PB.produced(s), done: s.done, error: s.error, duration: s.duration });
});
route('POST', '/api/iptv/play/:sid/stop', user, (c) => { if (PB.session(+c.p.sid, c.user.id)) PB.stop(+c.p.sid); send(c.res, 200, { ok: true }); });

// ---------- filmer och serier (Xtream) ----------
const VOD_SCOPE = 8e9, EP_SCOPE = 8.5e9;
route('GET', '/api/iptv/vod', user, (c) => {
  if (!vodOk(c)) return;
  const kind = c.q.get('kind') === 'series' ? 'series' : 'movie';
  if (c.q.get('shelves') === '1') return send(c.res, 200, { kind, shelves: VOD.shelves(c.user, kind), categories: VOD.categories(c.user, kind) });
  send(c.res, 200, { kind, ...VOD.list(c.user, { kind, category: c.q.has('category') ? c.q.get('category') : null, q: String(c.q.get('q') || '').slice(0, 80),
    sort: c.q.get('sort') || 'added', offset: +c.q.get('offset') || 0, limit: +c.q.get('limit') || 60 }), categories: c.q.get('cats') === '1' ? VOD.categories(c.user, kind) : undefined });
});
route('GET', '/api/iptv/vod/:id', user, async (c) => {
  if (!vodOk(c)) return;
  const d = await VOD.detail(c.user, +c.p.id);
  d ? send(c.res, 200, d) : fail(c.res, 404, 'Finns inte');
});
// Bilder från leverantören hämtas av servern och cachas (sidans säkerhetspolicy tillåter inte externa bilder)
const IMG_DIR = path.join(IMAGES, 'iptv');
fs.mkdirSync(IMG_DIR, { recursive: true });
async function cachedImage(c, url, name) {
  if (!url || !/^https?:\/\//.test(url)) return fail(c.res, 404, 'Ingen bild');
  const f = path.join(IMG_DIR, `${name}-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}.img`);
  if (!fs.existsSync(f)) {
    try {
      const { r } = await pods.safeFetch(url, { timeout: 10000, signal: AbortSignal.timeout(20000) });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !/^image\/(png|jpeg|gif|webp)/.test(ct)) { r.body.destroy(); return fail(c.res, 404, 'Ingen bild'); }
      const b = await pods.readLimited(r, 3 << 20);
      fs.writeFileSync(f, Buffer.concat([Buffer.from(ct.split(';')[0].padEnd(32)), b]));
    } catch { return fail(c.res, 404, 'Ingen bild'); }
  }
  const all_ = fs.readFileSync(f);
  c.res.writeHead(200, { 'Content-Type': all_.subarray(0, 32).toString().trim(), 'Cache-Control': 'private, max-age=604800', 'Content-Security-Policy': "default-src 'none'" });
  c.res.end(all_.subarray(32));
}
route('GET', '/api/iptv/vod/:id/:kind.jpg', img, async (c) => {
  if (!['cover', 'backdrop'].includes(c.p.kind) || !VOD.vodAllowed(c.user)) return fail(c.res, 404, 'Ingen bild');
  await cachedImage(c, VOD.imageUrl(c.user, c.p.kind, +c.p.id), `v${+c.p.id}-${c.p.kind}`);
});
route('GET', '/api/iptv/episodes/:eid/image.jpg', img, async (c) => {
  if (!VOD.vodAllowed(c.user)) return fail(c.res, 404, 'Ingen bild');
  await cachedImage(c, VOD.imageUrl(c.user, 'episode', +c.p.eid), `e${+c.p.eid}`);
});
// Spela: MP4 skickas direkt (spolning med Range), annat via ffmpeg som HLS. ?ss= börjar längre in (ny session).
async function playVod(c, kind, id) {
  if (!vodOk(c) || screenBlock(c)) return;
  const v = VOD.playable(c.user, kind, id); if (!v) return fail(c.res, 404, 'Finns inte');
  const ss = Math.max(0, parseInt(c.q.get('ss'), 10) || 0);
  const scope = (kind === 'episode' ? EP_SCOPE : VOD_SCOPE) + id;
  const base = kind === 'episode' ? `/api/iptv/episodes/${id}` : `/api/iptv/vod/${id}`;
  const prog = get('SELECT position, watched FROM iptv_vod_progress WHERE user_id=? AND kind=? AND ref_id=?', c.user.id, kind, id);
  if (/^(mp4|m4v|mov)$/i.test(v.ext) && c.q.get('hls') !== '1') {
    const t = mediaToken(c, scope);
    return send(c.res, 200, { direct: true, url: `${base}/file${t ? '?t=' + t : ''}`, hls: `${base}/play?hls=1`, token: t, duration: v.duration, title: v.title, position: prog?.position || 0 });
  }
  try {
    const s = await PB.start({ user: c.user, kind, ref: id, url: v.url, headers: v.headers, pol: v.pol, tunerId: v.tunerId, title: v.title, duration: v.duration ? v.duration - ss : null, offset: ss, seek: ss });
    const t = mediaToken(c, PB.PLAY_SCOPE + s.sid);
    send(c.res, 200, { direct: false, sid: s.sid, url: sessionUrl(s, t), token: t, offset: ss, duration: v.duration || (s.duration ? s.duration + ss : null), title: v.title, position: prog?.position || 0 });
  } catch (e) { fail(c.res, e.status || 502, e.message); }
}
route('POST', '/api/iptv/vod/:id/play', user, (c) => playVod(c, 'movie', +c.p.id));
route('POST', '/api/iptv/episodes/:eid/play', user, (c) => playVod(c, 'episode', +c.p.eid));
const vodFile = { auth: true, media: true, scope: (p) => VOD_SCOPE + (+p.id) }, epFile = { auth: true, media: true, scope: (p) => EP_SCOPE + (+p.eid) };
async function serveFile(c, kind, id) {
  if (!VOD.vodAllowed(c.user) || screenBlock(c)) return c.res.headersSent || fail(c.res, 403, 'Inte tillgängligt');
  const v = VOD.playable(c.user, kind, id); if (!v) return fail(c.res, 404, 'Finns inte');
  await PB.proxyFile(c.req, c.res, { url: v.url, headers: v.headers, pol: v.pol, tunerId: v.tunerId, key: `vod-${c.user.id}-${kind}-${id}` });
}
route('GET', '/api/iptv/vod/:id/file', vodFile, (c) => serveFile(c, 'movie', +c.p.id));
route('HEAD', '/api/iptv/vod/:id/file', vodFile, (c) => serveFile(c, 'movie', +c.p.id));
route('GET', '/api/iptv/episodes/:eid/file', epFile, (c) => serveFile(c, 'episode', +c.p.eid));
route('HEAD', '/api/iptv/episodes/:eid/file', epFile, (c) => serveFile(c, 'episode', +c.p.eid));
route('POST', '/api/iptv/progress', user, async (c) => {
  const b = await readJson(c.req);
  const kind = b.kind === 'episode' ? 'episode' : 'movie', id = +b.id;
  if (!VOD.playable(c.user, kind, id)) return fail(c.res, 404, 'Finns inte');
  VOD.saveProgress(c.user, kind, id, b.position, b.duration);
  send(c.res, 200, { ok: true });
});

// ---------- administration (betrott nät) ----------
route('GET', '/api/iptv/admin', admin, (c) => send(c.res, 200, {
  sources: SRC.adminSources(), guides: ADM.guides(), groups: ADM.groups('live'), movieGroups: ADM.groups('movie'), seriesGroups: ADM.groups('series'),
  guide: live.guideState, inUse: live.tunersInUse(), playing: PB.active().length,
  settings: { guideHours: +getSetting('iptv_guide_hours', '12') || 12, prestart: getSetting('iptv_prestart', '1') === '1', allowUnrated: allowUnrated() } }));
route('POST', '/api/iptv/sources', admin, async (c) => {
  const b = await readJson(c.req);
  try {
    const id = await SRC.addSource(b);
    (await import('../dvr.js')).applyRules?.();
    audit('settings_changed', { ...ctx(c), detail: 'IPTV-källa' });
    send(c.res, 200, { id });
  } catch (e) { fail(c.res, 400, e.message); }
});
route('PUT', '/api/iptv/sources/:id', admin, async (c) => {
  const b = await readJson(c.req);
  try { SRC.updateSource(+c.p.id, b); send(c.res, 200, { ok: true }); } catch (e) { fail(c.res, e.status || 400, e.message); }
});
route('POST', '/api/iptv/sources/:id/refresh', admin, async (c) => {
  try {
    const r = await live.refreshTuner(+c.p.id);
    (await import('../dvr.js')).applyRules?.();
    const s = SRC.sourceRow(+c.p.id);
    let vod = null;
    if (s?.s.type === 'xtream' && s.s.vod && c.q.get('vod') !== '0') vod = await SRC.vodSync(+c.p.id).catch(e => ({ error: e.message }));
    send(c.res, 200, { ...r, vod });
  } catch (e) { fail(c.res, 502, e.message); }
});
route('GET', '/api/iptv/admin/channels', admin, (c) => send(c.res, 200, ADM.channels({ q: String(c.q.get('q') || '').slice(0, 80), group: c.q.has('group') ? c.q.get('group') : null,
  tuner: c.q.get('tuner'), offset: +c.q.get('offset') || 0, limit: +c.q.get('limit') || 200 })));
route('PUT', '/api/iptv/admin/channels/order', admin, async (c) => {
  const b = await readJson(c.req, 1 << 20);
  if (b.reset) ADM.resetOrder(b.tuner ? +b.tuner : null); else if (Array.isArray(b.ids)) ADM.reorder(b.ids.map(Number));
  send(c.res, 200, { ok: true });
});
route('PUT', '/api/iptv/admin/channels/:cid', admin, async (c) => {
  const b = await readJson(c.req);
  try { ADM.updateChannel(+c.p.cid, b); send(c.res, 200, { ok: true }); } catch (e) { fail(c.res, e.status || 400, e.message); }
});
route('PUT', '/api/iptv/admin/groups', admin, async (c) => {
  const b = await readJson(c.req);
  try {
    if (Array.isArray(b.order)) ADM.orderGroups(b.kind || 'live', b.order); else ADM.setGroup(b.kind || 'live', b.name, b);
    send(c.res, 200, { ok: true });
  } catch (e) { fail(c.res, 400, e.message); }
});
route('POST', '/api/iptv/guides', admin, async (c) => {
  try { send(c.res, 200, { id: ADM.addGuide(await readJson(c.req)) }); } catch (e) { fail(c.res, 400, e.message); }
});
route('PUT', '/api/iptv/guides/:id', admin, async (c) => {
  try { ADM.updateGuide(+c.p.id, await readJson(c.req)); send(c.res, 200, { ok: true }); } catch (e) { fail(c.res, e.status || 400, e.message); }
});
route('DELETE', '/api/iptv/guides/:id', admin, (c) => { ADM.removeGuide(+c.p.id); send(c.res, 200, { ok: true }); });
route('PUT', '/api/iptv/settings', admin, async (c) => {
  const b = await readJson(c.req);
  if (b.guideHours != null) setSetting('iptv_guide_hours', Math.max(1, Math.min(168, parseInt(b.guideHours, 10) || 12)));
  if (b.prestart != null) setSetting('iptv_prestart', b.prestart ? '1' : '0');
  send(c.res, 200, { ok: true });
});
