// Uppspelning: offline-nedladdning, uppspelningsbeslut, /api/stream/* (direkt, HLS, undertexter, PGS),
// OpenSubtitles och intro/eftertexter.
import path from 'node:path';
import { getSetting, get, run } from '../db.js';
import { clientIp, send, readJson, fail, isLocalReq, MIME } from '../util.js';
import { createSession } from '../auth.js';
import { scan } from '../scanner.js';
import * as st from '../stream.js';
import * as pgs from '../pgs.js';
import * as os from '../opensubtitles.js';
import * as act from '../activity.js';
import * as offline from '../offline.js';
import * as trakt from '../trakt.js';
import * as ver from '../versions.js';
import { route, user, media, admin } from '../http/router.js';
import { mediaItem, screenBlock, chaptersOf } from '../http/context.js';

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
// ---------- Uppspelning ----------
// Klienten skickar sina förmågor; svaret anger läge och färdiga URL:er
route('GET', '/api/items/:id/playback', user, async (c) => {
  const row = mediaItem(c); if (!row) return;
  const main = ver.mainOf(row);
  if (act.isStopped(c.user.id, main.id)) return fail(c.res, 403, 'Uppspelningen stoppades av administratören');
  if (c.q.get('info') !== '1' && screenBlock(c)) return;
  const t0 = Date.now();
  // Ej analyserad film: ta fram nyckelbilderna nu (före bakgrundsanalysen) så att den kan skickas utan
  // omkodning. Filens index räcker oftast (någon sekund); måste hela filen läsas väntar vi högst 10 s –
  // då omkodas den den här gången och nästa gång går den utan omkodning.
  if (c.q.get('info') !== '1' && c.q.get('force') !== 'transcode') {
    // Bara versioner som faktiskt skulle kunna skickas utan omkodning (rätt kvalitet, ingen inbränning/tonmappning)
    // – annars omkodas filmen ändå och väntan på nyckelbilderna vore bortkastad
    const pre = st.parseCaps(c.q); pre.assumeKf = true;
    if ((!c.q.get('q') || c.q.get('q') === 'auto') && !isLocalReq(c.req)) pre.q = getSetting('remote_quality', process.env.REMOTE_QUALITY || '1080');
    const todo = ver.versionsOf(main).filter(v => ['h264', 'hevc'].includes(v.vcodec) && !st.keyframesReady(v) && st.decide(v, pre).mode !== 'transcode').slice(0, 2);
    if (todo.length) await Promise.race([Promise.all(todo.map(v => st.computeKeyframes(v, { priority: true }))), new Promise(r => setTimeout(r, 10000))]);
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
  const hp = d.mode === 'direct' ? null : st.hlsParams(d, o, token);
  const url = d.mode === 'direct' ? `${base}/direct${tq}` : `${base}/hls/master.m3u8?${hp}`;
  // info=1: titelsidan visar bara uppspelningsläget – det är ingen uppspelning
  const info = c.q.get('info') === '1';
  // Starta ffmpeg redan nu (inte vid anpassningsbar kvalitet – där väljer spelaren steg först)
  if (hp && !info && !d.abr) st.prewarm(it, hp, c.user.id, Math.max(0, +c.q.get('start') || 0));
  if (it.duration && !info) trakt.scrobble(c.user.id, main, 'start', (+c.q.get('start') || 0) / it.duration * 100).catch(() => {});
  // Diagnos i loggen: vad som valdes och hur lång tid beslutet tog (långsam start felsöks härifrån)
  if (!info) console.log(`[uppspelning] ${main.title}: ${d.mode}${d.q && d.q !== 'orig' ? ' ' + d.q + 'p' : ''}${remote ? ' (utanför hemmet)' : ''} – ${d.reasons.join(', ') || 'direkt'} – beslut på ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!info) act.startPlay({ user: c.user, item: main, mode: d.mode, quality: d.q, ip: clientIp(c.req), remote, ua: c.req.headers['user-agent'], reasons: d.reasons });
  const subs = st.subtitlesOf(it).filter(s => !s.bitmap).map(s => ({
    id: s.id, label: s.label, lang: s.lang, forced: s.forced, url: `${base}/subs/${s.id}.vtt${tq}`
  }));
  // Bildundertexter (PGS) som webbspelaren ritar själv – appar använder inbränning via sub=
  const imageSubs = st.subtitlesOf(it).filter(s => s.pgs).map(s => ({ id: s.id, label: s.label, lang: s.lang, forced: s.forced, url: `${base}/pgs/${s.id}?v=${it.mtime | 0}${token ? '&t=' + token : ''}` }));
  send(c.res, 200, {
    mode: d.mode, url, reasons: d.reasons, hdr: it.hdr, tonemap: d.tonemap, burn: d.burn || null,
    duration: it.duration, subtitles: subs, imageSubs, token, remote, quality: d.q,
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
const pgsSub = (it, sid) => st.subtitlesOf(it).find(s => s.id === sid && s.pgs);
route('GET', '/api/stream/:id/pgs/:sid', media, (c) => {
  const it = mediaItem(c); if (!it) return;
  const sub = pgsSub(it, c.p.sid); if (!sub) return fail(c.res, 404, 'Undertext saknas');
  pgs.serveIndex(c.res, it, sub);
});
route('GET', '/api/stream/:id/pgs/:sid/:n', media, (c) => {
  const it = mediaItem(c); if (!it) return;
  const sub = pgsSub(it, c.p.sid); if (!sub) return fail(c.res, 404, 'Undertext saknas');
  const n = c.p.n.replace(/\.png$/, '');
  if (!/^\d{1,6}$/.test(n)) return fail(c.res, 400, 'Ogiltig bild');
  pgs.serveImage(c.req, c.res, it, sub, +n);
});
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
