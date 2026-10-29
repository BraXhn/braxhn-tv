// Ljudböcker och poddar.
import fs from 'node:fs';
import { pipeline } from 'node:stream';
import { get, run, now } from '../db.js';
import { fail, send, readJson, clientIp, streamFile } from '../util.js';
import { createSession, audit } from '../auth.js';
import * as music from '../music.js';
import * as books from '../audiobooks.js';
import * as bookmeta from '../bookmeta.js';
import * as booktools from '../booktools.js';
import * as feeds from '../bookfeeds.js';
import * as pods from '../podcasts.js';
import * as screen from '../screentime.js';
import { sized } from '../imgsize.js';
import { route, user, img, admin, feed, remoteDenied } from '../http/router.js';
import { screenBlock, ctx, libOk, canDownload } from '../http/context.js';

// ---------- Ljudböcker ----------
// Bibliotek, böcker och filer kontrolleras mot användarens rättigheter (perms.js): otillåtet = finns inte
const bookLib = (c) => { const l = get("SELECT * FROM libraries WHERE id=? AND type='audiobook'", +c.p.lib); if (!l || !libOk(c.user.id, l.id)) { fail(c.res, 404, 'Inget ljudboksbibliotek'); return null; } return l; };
const bookOk = (c, id) => { const b = get('SELECT library_id FROM books WHERE id=?', +id); return !!b && libOk(c.user.id, b.library_id); };
// Före /api/audiobooks/:lib (första matchande route vinner)
// Lyssningsstatistik för profilen; administratören ser dessutom hushållets profiler
route('GET', '/api/audiobooks/stats', user, (c) => send(c.res, 200, { ...books.listeningStats(c.user.id), ...(c.user.is_admin ? { profiles: books.householdStats() } : {}) }));
// Privata RSS-flöden (poddappar): adressen med nyckeln visas bara när flödet skapas
route('GET', '/api/audiobooks/feeds', user, (c) => send(c.res, 200, { allowed: !feeds.feedDenied(c.user.id), reason: feeds.feedDenied(c.user.id),
  feeds: feeds.listFeeds(c.user.id, { book: c.q.get('book'), library: c.q.get('lib'), series: c.q.get('series') }) }));
route('POST', '/api/audiobooks/feeds', user, async (c) => {
  const b = await readJson(c.req);
  const r = feeds.createFeed(c.user.id, b.book != null ? { book: b.book } : { library: b.library, series: b.series });
  audit('book_feed_created', { ...ctx(c), detail: b.book != null ? `bok ${+b.book}` : `serie ${String(b.series || '').slice(0, 100)}` });
  send(c.res, 200, { id: r.id, path: `/api/feeds/${r.token}/feed.xml`, url: `${feeds.originOf(c.req)}/api/feeds/${r.token}/feed.xml` });
});
route('DELETE', '/api/audiobooks/feeds/:fid', user, (c) => {
  if (!feeds.revokeFeed(c.user.id, +c.p.fid)) return fail(c.res, 404, 'Finns inte');
  audit('book_feed_revoked', ctx(c)); send(c.res, 200, { ok: true });
});
route('GET', '/api/audiobooks/:lib', user, (c) => { const l = bookLib(c); if (l) send(c.res, 200, { library: l, continue: books.continueBooks(c.user.id).filter(b => b.library === l.id), books: books.listBooks(l.id, c.user.id, c.q.get('sort') || 'title') }); });
route('GET', '/api/audiobooks/book/:bid', user, (c) => {
  const b = books.book(+c.p.bid, c.user.id); if (!b) return fail(c.res, 404, 'Finns inte');
  b.feedsAllowed = !feeds.feedDenied(c.user.id);
  // Administratörens verktyg: vad som går att göra med filen, pågående åtgärd och papperskorgen (Ångra)
  if (c.user.is_admin) b.tools = { canEmbed: booktools.canEmbed(b), canMerge: booktools.canMerge(b), state: booktools.stateOf(b.id), trash: booktools.trashOf(b.id) };
  send(c.res, 200, b);
});
route('POST', '/api/audiobooks/book/:bid/progress', user, async (c) => {
  const { position, speed, at } = await readJson(c.req);
  const r = books.saveProgress(c.user.id, +c.p.bid, position, speed, at); if (!r) return fail(c.res, 404, 'Finns inte');
  if (r.stale || (at && Number.isFinite(+at))) return send(c.res, 200, r); // offline-synk: ingen skärmtid
  const sc = screen.heartbeat(c.user.id, 'b:' + (+c.p.bid), +position, { audio: true });
  send(c.res, 200, sc ? { ...r, stop: !sc.allowed, screenTime: sc } : r);
});
route('POST', '/api/audiobooks/book/:bid/bookmarks', user, async (c) => {
  const { position, note } = await readJson(c.req);
  if (!bookOk(c, c.p.bid)) return fail(c.res, 404, 'Finns inte');
  if (get('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id=? AND book_id=?', c.user.id, +c.p.bid).n >= 200) return fail(c.res, 400, 'För många bokmärken');
  run('INSERT INTO bookmarks(user_id,book_id,position,note,created) VALUES(?,?,?,?,?)', c.user.id, +c.p.bid, Math.max(0, +position || 0), String(note || '').slice(0, 200) || null, now());
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/audiobooks/bookmarks/:mid', user, (c) => { run('DELETE FROM bookmarks WHERE id=? AND user_id=?', +c.p.mid, c.user.id); send(c.res, 200, { ok: true }); });
route('GET', '/api/audiobooks/cover/:bid', img, async (c) => {
  if (!bookOk(c, c.p.bid)) return fail(c.res, 404, 'Inget omslag');
  const f = books.coverPath(+c.p.bid);
  if (!f) return fail(c.res, 404, 'Inget omslag');
  const out = await sized(f, c.q.get('w')); // ?w= = nedskalad (imgsize.js)
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); pipeline(fs.createReadStream(out), c.res, () => {});
});
// "Fel bok?" och redigering (administratör): sök i Google Books/Open Library/Audnexus och välj rätt bok – matchningen låses
const bookOr404 = (c) => { const b = get('SELECT id, library_id, title, author FROM books WHERE id=?', +c.p.bid); if (!b) fail(c.res, 404, 'Finns inte'); return b; };
route('GET', '/api/audiobooks/book/:bid/match', admin, async (c) => {
  const b = bookOr404(c); if (!b) return;
  const m = get('SELECT source, source_id, locked FROM book_meta WHERE book_id=?', b.id);
  const title = String(c.q.get('title') ?? b.title).slice(0, 200), author = String(c.q.get('author') ?? b.author ?? '').slice(0, 200);
  try {
    const res = await bookmeta.search(title, author);
    send(c.res, 200, { current: m?.source ? { source: m.source, id: m.source_id } : null, locked: !!m?.locked,
      results: res.map(x => ({ source: x.source, id: x.id, title: x.title, subtitle: x.subtitle, authors: x.authors.slice(0, 4), narrators: x.narrators.slice(0, 4),
        year: x.year, publisher: x.publisher, series: x.series, seriesNo: x.seriesNo, description: (x.description || '').slice(0, 300),
        cover: x.cover && bookmeta.coverUrlOk(x.cover) ? `/api/audiobooks/match/art?u=${encodeURIComponent(x.cover)}` : null })) });
  } catch (e) { fail(c.res, 502, 'Sökningen misslyckades: ' + e.message); }
});
route('POST', '/api/audiobooks/book/:bid/match', admin, async (c) => {
  const b = bookOr404(c); if (!b) return;
  const { source, id, unlock } = await readJson(c.req);
  if (unlock) { bookmeta.unlock(b.id); bookmeta.queue(b.library_id); return send(c.res, 200, { ok: true }); }
  if (!['google', 'openlibrary', 'audnexus', 'audible'].includes(source) || !id) return fail(c.res, 400, 'Välj en bok');
  try {
    if (!(await bookmeta.matchManual(b.id, source, String(id).slice(0, 60)))) return fail(c.res, 404, 'Boken hittades inte hos källan');
    audit('book_matched', { ...ctx(c), detail: `${b.title} → ${source} ${String(id).slice(0, 60)}` });
    send(c.res, 200, books.book(b.id, c.user.id));
  } catch (e) { fail(c.res, 502, 'Hämtningen misslyckades: ' + e.message); }
});
route('PUT', '/api/audiobooks/book/:bid', admin, async (c) => {
  const b = bookOr404(c); if (!b) return;
  try { await bookmeta.edit(b.id, await readJson(c.req)); send(c.res, 200, books.book(b.id, c.user.id)); }
  catch (e) { fail(c.res, e.status || 502, e.message); }
});
// Kapitelredigeraren (administratör): sparas utan att filen skrivs om; "Skriv in i filen" och sammanslagning bara på begäran
route('PUT', '/api/audiobooks/book/:bid/chapters', admin, async (c) => {
  const b = bookOr404(c); if (!b) return;
  const body = await readJson(c.req);
  if (body.reset) booktools.resetChapters(b.id); else booktools.saveChapters(b.id, body.chapters);
  audit('book_chapters_edited', { ...ctx(c), detail: b.title });
  send(c.res, 200, books.book(b.id, c.user.id));
});
// Kapitel från Audnexus via bokens ASIN (eller ?asin=) – visas i redigeraren, sparas först när administratören sparar
route('GET', '/api/audiobooks/book/:bid/chapters/audnexus', admin, async (c) => {
  const b = bookOr404(c); if (!b) return;
  const row = books.bookRow(b.id);
  const asin = String(c.q.get('asin') || row.asin || '').trim().toUpperCase();
  if (!bookmeta.asinOk(asin)) return fail(c.res, 400, 'Boken saknar ASIN – ange det under Redigera (från Audible)');
  try {
    const r = await bookmeta.fetchChapters(asin);
    if (!r) return fail(c.res, 404, 'Audnexus har inga kapitel för den här boken');
    send(c.res, 200, { asin, chapters: r.chapters, total: r.total, duration: row.duration, lengthOk: books.lengthMatches(r.total, row.duration) });
  } catch (e) { fail(c.res, 502, 'Hämtningen misslyckades: ' + e.message); }
});
const startTool = (c, fn, what) => {
  const b = bookOr404(c); if (!b) return;
  fn(b.id, c.user.id);
  audit('book_tool', { ...ctx(c), detail: `${what}: ${b.title}` });
  send(c.res, 202, { started: true, state: booktools.stateOf(b.id) });
};
route('POST', '/api/audiobooks/book/:bid/chapters/embed', admin, (c) => startTool(c, booktools.embedChapters, 'kapitel in i filen'));
route('POST', '/api/audiobooks/book/:bid/merge', admin, (c) => startTool(c, booktools.mergeBook, 'slå ihop till M4B'));
route('POST', '/api/audiobooks/book/:bid/restore', admin, (c) => startTool(c, booktools.restore, 'ångra'));
// Omslag i sökträffarna: bara från källornas bildvärdar (webbens CSP tillåter inga externa bilder)
route('GET', '/api/audiobooks/match/art', admin, async (c) => {
  try { const r = await bookmeta.fetchImage(c.q.get('u') || ''); send(c.res, 200, r.body, { 'Content-Type': r.type, 'Cache-Control': 'private, max-age=86400' }); }
  catch { fail(c.res, 404, 'Ingen bild'); }
});
const bookFile = (c) => { const f = books.fileRow(+c.p.fid); if (!f || !libOk(c.user.id, f.library_id)) { fail(c.res, 404, 'Finns inte'); return null; } return f; };
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

// Offline i webbappen: som /play men räknas som nedladdning (perms.js) – samma token (scope boken) för alla filer
route('GET', '/api/audiobooks/book/:bid/offline', user, (c) => {
  if (!canDownload(c.user.id)) return fail(c.res, 403, 'Ditt konto får inte ladda ner');
  const b = books.book(+c.p.bid, c.user.id); if (!b) return fail(c.res, 404, 'Finns inte');
  const t = createSession(c.user.id, 'media', { item: BOOK_SCOPE + b.id, ip: clientIp(c.req) });
  const a = encodeURIComponent(String(c.q.get('a') || 'mp3,aac,flac').replace(/[^a-z0-9,]/g, '').slice(0, 60));
  send(c.res, 200, { id: b.id, title: b.title, author: b.author, narrator: b.narrator, cover: b.cover, duration: b.duration, position: b.position, speed: b.speed, chapters: b.chapters,
    files: b.files.map(f => ({ id: f.id, offset: f.offset, duration: f.duration, url: `/api/audiobooks/files/${f.id}/stream?a=${a}&t=${t}` })) });
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

// ---------- RSS-flöden för poddappar (/api/feeds/<nyckel>/…, routealternativet feed) ----------
// Ingen kaka, Bearer eller ?t= gäller här – bara flödets nyckel. Fjärrreglerna (konton utan fjärråtkomst) gäller som vanligt.
const feedOf = (c) => {
  const r = feeds.resolve(c.p.token);
  if (!r) { fail(c.res, 404, 'Flödet finns inte eller har återkallats'); return null; }
  const why = remoteDenied(r.user, c.req, false);
  if (why) { fail(c.res, 403, why); return null; }
  return r;
};
const feedXml = (c) => {
  const r = feedOf(c); if (!r) return;
  const xml = feeds.feedXml(r.feed, r.user.id, c.p.token, feeds.originOf(c.req));
  if (c.req.method === 'HEAD') { c.res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'private, max-age=300' }); return c.res.end(); }
  send(c.res, 200, xml, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'private, max-age=300' });
};
route('GET', '/api/feeds/:token/feed\\.xml', feed, feedXml);
route('HEAD', '/api/feeds/:token/feed\\.xml', feed, feedXml);
const feedAudio = (c) => {
  const r = feedOf(c); if (!r) return;
  const f = feeds.feedFile(r.feed, r.user.id, parseInt(c.p.file));
  if (!f) return fail(c.res, 404, 'Finns inte');
  let st; try { st = fs.statSync(f.path); } catch { return fail(c.res, 404, 'Filen saknas'); }
  streamFile(c.req, c.res, f.path, st.size, { 'Content-Type': feeds.mimeOf(f.path), 'Cache-Control': 'private, max-age=3600' });
};
route('GET', '/api/feeds/:token/audio/:file', feed, feedAudio);
route('HEAD', '/api/feeds/:token/audio/:file', feed, feedAudio);
route('GET', '/api/feeds/:token/chapters/:file', feed, (c) => {
  const r = feedOf(c); if (!r) return;
  const f = feeds.feedFile(r.feed, r.user.id, parseInt(c.p.file));
  const b = f && books.book(f.book_id, r.user.id);
  if (!b) return fail(c.res, 404, 'Finns inte');
  send(c.res, 200, JSON.stringify(feeds.chaptersJson(b, b.files.find(x => x.id === f.id))), { 'Content-Type': 'application/json+chapters', 'Cache-Control': 'private, max-age=300' });
});
route('GET', '/api/feeds/:token/cover/:file', feed, async (c) => {
  const r = feedOf(c); if (!r) return;
  const bid = parseInt(c.p.file);
  if (!feeds.feedHasBook(r.feed, r.user.id, bid)) return fail(c.res, 404, 'Inget omslag');
  const f = books.coverPath(bid); if (!f) return fail(c.res, 404, 'Inget omslag');
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); pipeline(fs.createReadStream(f), c.res, () => {});
});
