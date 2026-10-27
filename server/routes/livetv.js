// Live-TV, programguide, inspelningar (DVR) och reklamavbrott.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { get, now, all, IMAGES, getSetting, run, setSetting } from '../db.js';
import { fail, send, clientIp, readJson } from '../util.js';
import { createSession, audit } from '../auth.js';
import * as pods from '../podcasts.js';
import * as live from '../livetv.js';
import * as dvr from '../dvr.js';
import * as comskip from '../comskip.js';
import * as timeshift from '../timeshift.js';
import * as screen from '../screentime.js';
import { channelAllowed, kidsHaveChannels } from '../iptv/channels.js';
import { allowUnrated, screenBlock, ctx } from '../http/context.js';
import { route, user, img, admin } from '../http/router.js';

// ---------- Live-TV och inspelningar ----------
const LIVE_SCOPE = 4e9, REC_SCOPE = 5e9;
// Barnprofiler: kanaler inom åldersgränsen (kanalens/gruppens, server/iptv/channels.js). lists: kanallistan, guiden och
// sökningen (filtreras per kanal) – inspelningarna som förut bara med allow_unrated.
const liveOk = (c, lists = false) => {
  if (c.user.max_age != null && !(c.p.cid ? channelAllowed(c.user, +c.p.cid) : allowUnrated() || (lists && kidsHaveChannels(c.user)))) { fail(c.res, 403, 'Live-TV är inte tillgängligt i barnprofiler'); return false; }
  return true;
};
const liveStream = { auth: true, media: true, scope: (p) => LIVE_SCOPE + (+p.cid) };
const recStream = { auth: true, media: true, scope: (p) => REC_SCOPE + (+p.rid) };
route('GET', '/api/live/channels', user, (c) => { if (liveOk(c, true)) send(c.res, 200, { channels: live.channelList(false).filter(ch => channelAllowed(c.user, ch.id)), tuners: get('SELECT COUNT(*) AS n FROM tuners WHERE enabled=1').n, active: live.activeLive() }); });
route('GET', '/api/live/guide', user, (c) => {
  if (!liveOk(c, true)) return;
  // Guiden sparar sändningar ett dygn bakåt (livetv.js) – så långt går det att bläddra
  const from = Math.max(now() - 25 * 3600, parseInt(c.q.get('from')) || now() - 1800), hours = Math.max(1, Math.min(24, parseInt(c.q.get('hours')) || 6));
  send(c.res, 200, { from, to: from + hours * 3600, channels: live.guide(from, from + hours * 3600).filter(ch => channelAllowed(c.user, ch.id)), guide: live.guideState });
});
route('GET', '/api/live/programs/:pid', user, (c) => {
  if (!liveOk(c, true)) return;
  const p = live.program(+c.p.pid); if (!p || !channelAllowed(c.user, p.channel_id)) return fail(c.res, 404, 'Finns inte');
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
route('GET', '/api/live/search', user, (c) => { if (liveOk(c, true)) send(c.res, 200, live.searchPrograms(String(c.q.get('q') || '').slice(0, 80)).filter(p => channelAllowed(c.user, p.channel_id))); });
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
const mine = (c, r) => c.user.is_admin || r.created_by === c.user.id;
route('GET', '/api/dvr', user, (c) => { if (liveOk(c)) send(c.res, 200, { ...dvr.list(), dir: c.user.is_admin ? dvr.dvrDir() : null, comskip: { enabled: comskip.enabled(), autoSkip: comskip.autoSkipDefault() } }); });
// Konflikter i förväg: bokningar som börjar sent, avbryts eller missas när tunrarna inte räcker, med alternativa sändningar
route('GET', '/api/dvr/conflicts', user, (c) => { if (liveOk(c)) send(c.res, 200, { conflicts: dvr.conflictList() }); });
route('POST', '/api/dvr/program', user, async (c) => {
  if (!liveOk(c)) return;
  const b = await readJson(c.req);
  const { programId, series, newOnly } = b;
  try {
    const p = live.program(+programId); if (!p) return fail(c.res, 404, 'Finns inte');
    if (series) {
      const id = dvr.addRule({ ...b, title: p.title, channelId: c.q.get('anyChannel') === '1' || b.anyChannel ? null : p.channel_id, newOnly: newOnly !== false }, c.user);
      dvr.scheduleProgram(+programId, c.user, id);
      audit('dvr_rule', { ...ctx(c), detail: p.title });
      return send(c.res, 200, { rule: id });
    }
    // Varna om fler inspelningar än det finns tuners överlappar
    const conflict = dvr.conflicts(p.start, p.stop, { channelId: p.channel_id }).find(x => x.conflict) || null;
    const id = dvr.scheduleProgram(+programId, c.user, null, dvr.bookingOpts(b));
    send(c.res, 200, { id, conflict, plan: dvr.plan().get(id)?.outcome || 'ok' });
  } catch (e) { fail(c.res, 400, e.message); }
});
route('POST', '/api/dvr/manual', user, async (c) => {
  if (!liveOk(c)) return;
  const b = await readJson(c.req);
  try {
    const conflict = dvr.conflicts(+b.start, +b.stop, { channelId: +b.channelId }).find(x => x.conflict) || null;
    const id = dvr.scheduleManual({ ...b, channelId: +b.channelId, start: +b.start, stop: +b.stop }, c.user);
    send(c.res, 200, { id, conflict, plan: dvr.plan().get(id)?.outcome || 'ok' });
  } catch (e) { fail(c.res, 400, e.message); }
});
// Serieinspelningar med regler
route('POST', '/api/dvr/rules', user, async (c) => {
  if (!liveOk(c)) return;
  const b = await readJson(c.req);
  try { const id = dvr.addRule(b, c.user); audit('dvr_rule', { ...ctx(c), detail: String(b.title || '').slice(0, 200) }); send(c.res, 200, { rule: id }); }
  catch (e) { fail(c.res, 400, e.message); }
});
route('POST', '/api/dvr/rules/preview', user, async (c) => {
  if (!liveOk(c)) return;
  try { send(c.res, 200, { airings: dvr.previewRule(await readJson(c.req)) }); } catch (e) { fail(c.res, 400, e.message); }
});
route('PUT', '/api/dvr/rules/:id', user, async (c) => {
  const r = get('SELECT * FROM dvr_rules WHERE id=?', +c.p.id); if (!r) return fail(c.res, 404, 'Finns inte');
  if (!mine(c, r)) return fail(c.res, 403, 'Bara den som skapade serieinspelningen kan ändra den');
  try { dvr.updateRule(r.id, await readJson(c.req)); send(c.res, 200, { ok: true }); } catch (e) { fail(c.res, 400, e.message); }
});
route('DELETE', '/api/dvr/rules/:id', user, (c) => {
  const r = get('SELECT * FROM dvr_rules WHERE id=?', +c.p.id); if (!r) return fail(c.res, 404, 'Finns inte');
  if (!mine(c, r)) return fail(c.res, 403, 'Bara den som skapade serieinspelningen kan ta bort den');
  dvr.removeRule(r.id); send(c.res, 200, { ok: true });
});
route('PUT', '/api/dvr/recordings/:rid', user, async (c) => {
  const r = get('SELECT * FROM recordings WHERE id=?', +c.p.rid); if (!r) return fail(c.res, 404, 'Finns inte');
  if (!mine(c, r)) return fail(c.res, 403, 'Bara den som bokade inspelningen eller en administratör kan ändra den');
  try { dvr.updateRecording(r.id, await readJson(c.req)); send(c.res, 200, { ok: true, plan: dvr.plan().get(r.id)?.outcome || null }); } catch (e) { fail(c.res, 400, e.message); }
});
// Flytta en bokning till en annan sändning av samma program (förslagen i /api/dvr/conflicts)
route('POST', '/api/dvr/recordings/:rid/swap', user, async (c) => {
  if (!liveOk(c)) return;
  const r = get('SELECT * FROM recordings WHERE id=?', +c.p.rid); if (!r) return fail(c.res, 404, 'Finns inte');
  if (!mine(c, r)) return fail(c.res, 403, 'Bara den som bokade inspelningen eller en administratör kan flytta den');
  const { programId } = await readJson(c.req);
  try { const id = dvr.swapRecording(r.id, +programId, c.user); send(c.res, 200, { id, plan: dvr.plan().get(id)?.outcome || 'ok' }); } catch (e) { fail(c.res, 400, e.message); }
});
route('DELETE', '/api/dvr/recordings/:rid', user, (c) => {
  const r = get('SELECT * FROM recordings WHERE id=?', +c.p.rid); if (!r) return fail(c.res, 404, 'Finns inte');
  if (!mine(c, r)) return fail(c.res, 403, 'Bara den som bokade inspelningen eller en administratör kan ta bort den');
  if (r.status === 'scheduled') dvr.cancel(r.id); else dvr.removeRecording(r.id);
  send(c.res, 200, { ok: true });
});
route('POST', '/api/dvr/recordings/:rid/stop', user, (c) => {
  if (!liveOk(c)) return;
  const r = get('SELECT * FROM recordings WHERE id=?', +c.p.rid); if (!r) return fail(c.res, 404, 'Finns inte');
  if (!mine(c, r)) return fail(c.res, 403, 'Bara den som bokade inspelningen eller en administratör kan stoppa den');
  dvr.stopRecording(r.id); send(c.res, 200, { ok: true });
});
// Spela: en klar inspelning som fil (Range), en pågående som HLS av den växande filen (titta medan den spelas in)
route('POST', '/api/dvr/recordings/:rid/play', user, (c) => {
  if (!liveOk(c) || screenBlock(c)) return;
  const r = get('SELECT status FROM recordings WHERE id=?', +c.p.rid); if (!r) return fail(c.res, 404, 'Finns inte');
  const t = c.user.via !== 'cookie' || c.q.get('cast') === '1' ? createSession(c.user.id, 'media', { item: REC_SCOPE + (+c.p.rid), ip: clientIp(c.req) }) : null;
  const q = t ? '?t=' + t : '';
  if (r.status === 'recording') return send(c.res, 200, { url: `/api/dvr/recordings/${+c.p.rid}/live.m3u8${q}`, live: true });
  send(c.res, 200, { url: `/api/dvr/recordings/${+c.p.rid}/stream${q}` });
});
route('GET', '/api/dvr/recordings/:rid/stream', recStream, (c) => { if (liveOk(c) && !screenBlock(c)) dvr.serveRecording(c.req, c.res, +c.p.rid); });
route('HEAD', '/api/dvr/recordings/:rid/stream', recStream, (c) => { if (liveOk(c) && !screenBlock(c)) dvr.serveRecording(c.req, c.res, +c.p.rid); });
route('GET', '/api/dvr/recordings/:rid/live.m3u8', recStream, async (c) => { if (liveOk(c) && !screenBlock(c)) await dvr.serveGrowing(c.res, +c.p.rid, c.q.get('t')); });
route('GET', '/api/dvr/recordings/:rid/seg-:n.ts', recStream, (c) => {
  if (!liveOk(c) || screenBlock(c)) return;
  screen.heartbeat(c.user.id, 'r:' + (+c.p.rid));
  dvr.serveGrowingSegment(c.req, c.res, +c.p.rid, `seg-${c.p.n}.ts`);
});
// Administration av källor
route('GET', '/api/live/tuners', admin, (c) => send(c.res, 200, {
  tuners: all('SELECT id, kind, name, url, epg_url, tuner_count, enabled, last_refresh, error, (SELECT COUNT(*) FROM channels WHERE tuner_id=tuners.id) AS channels FROM tuners'),
  inUse: live.tunersInUse(), guide: live.guideState, channels: live.channelList(true),
  settings: { dvrDir: dvr.dvrDir(), padBefore: +getSetting('dvr_pad_before', '60'), padAfter: +getSetting('dvr_pad_after', '180'), liveTranscode: getSetting('live_transcode', 'auto'), keepTs: getSetting('dvr_keep_ts', '0') === '1',
    timeshiftMinutes: timeshift.timeshiftMinutes(), timeshiftMaxGb: timeshift.timeshiftMaxGb(), comskip: comskip.enabled(), comskipAutoSkip: comskip.autoSkipDefault(),
    format: getSetting('dvr_format', 'mp4'), transcode: getSetting('dvr_transcode', 'auto'), nfo: getSetting('dvr_nfo', '1') !== '0' }
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
  // Efterbearbetning: format (mp4|mkv|ts), omkodning (auto|always|never) och NFO bredvid filen
  if (dvr.FORMATS.includes(b.format)) setSetting('dvr_format', b.format);
  if (dvr.TRANSCODES.includes(b.transcode)) setSetting('dvr_transcode', b.transcode);
  if (b.nfo != null) setSetting('dvr_nfo', b.nfo ? '1' : '0');
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
