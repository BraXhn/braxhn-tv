// Ljudböcker och poddar.
import fs from 'node:fs';
import { pipeline } from 'node:stream';
import { get, run, now } from '../db.js';
import { fail, send, readJson, clientIp } from '../util.js';
import { createSession, audit } from '../auth.js';
import * as music from '../music.js';
import * as books from '../audiobooks.js';
import * as pods from '../podcasts.js';
import * as screen from '../screentime.js';
import { sized } from '../imgsize.js';
import { route, user, img } from '../http/router.js';
import { screenBlock, ctx } from '../http/context.js';

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
route('GET', '/api/audiobooks/cover/:bid', img, async (c) => {
  const f = books.coverPath(+c.p.bid);
  if (!f) return fail(c.res, 404, 'Inget omslag');
  const out = await sized(f, c.q.get('w')); // ?w= = nedskalad (imgsize.js)
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); pipeline(fs.createReadStream(out), c.res, () => {});
});
const bookFile = (c) => { const f = books.fileRow(+c.p.fid); if (!f) fail(c.res, 404, 'Finns inte'); return f; };
// Strömmar för ljudböcker/poddar: kortlivad token (24 h) som bara gäller den boken/det avsnittet – för appar och AirPlay
const BOOK_SCOPE = 2e9, POD_SCOPE = 3e9;
const bookStream = { auth: true, media: true, scope: (p) => BOOK_SCOPE + (books.fileRow(+p.fid)?.book_id || 0) };
const podStream = { auth: true, media: true, scope: (p) => POD_SCOPE + (+p.eid) };
route('GET', '/api/audiobooks/files/:fid/stream', bookStream, (c) => { const f = bookFile(c); if (f && !screenBlock(c, { audio: true })) music.streamTrack(c.req, c.res, f, c.q, c.user.id); });
route('HEAD', '/api/audiobooks/files/:fid/stream', bookStream, (c) => { const f = bookFile(c); if (f && !screenBlock(c, { audio: true })) music.streamTrack(c.req, c.res, f, c.q, c.user.id); });
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
// Sök i Apples poddkatalog (före /:pid – första matchande route vinner)
route('GET', '/api/podcasts/search', user, async (c) => {
  if (c.user.max_age != null) return fail(c.res, 403, 'Barnprofiler kan inte lägga till poddar');
  try { send(c.res, 200, await pods.search(c.q.get('q'), /^[a-z]{2}$/.test(c.q.get('country') || '') ? c.q.get('country') : 'se')); }
  catch (e) { fail(c.res, 502, e.message); }
});
route('GET', '/api/podcasts/search/art', user, async (c) => {
  const u = c.q.get('u') || '';
  if (!pods.artOk(u)) return fail(c.res, 400, 'Ogiltig bildadress');
  try {
    const { r } = await pods.safeFetch(u, { timeout: 10000, signal: AbortSignal.timeout(15000) });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(type)) { r.body.resume?.(); return fail(c.res, 404, 'Ingen bild'); }
    send(c.res, 200, await pods.readLimited(r, 2 << 20), { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
  } catch { fail(c.res, 404, 'Ingen bild'); }
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
route('GET', '/api/podcasts/:pid/image', img, async (c) => {
  const f = pods.imagePath(+c.p.pid); if (!f) return fail(c.res, 404, 'Ingen bild');
  const out = await sized(f, c.q.get('w'));
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); pipeline(fs.createReadStream(out), c.res, () => {});
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
