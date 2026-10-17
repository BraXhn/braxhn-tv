// Bibliotek och titlar: bibliotek, skanning, startsida, bläddring, sök, titelsidor, framsteg, matchning,
// Min lista, samlingar, förhandsbilder, bilder, skådespelare, trailers och årssammanfattning.
import fs from 'node:fs';
import path from 'node:path';
import { all, run, get, now, tx, getSetting, IMAGES } from '../db.js';
import { send, readJson, fail, streamFile, MIME, clientIp } from '../util.js';
import { audit, createSession } from '../auth.js';
import { scan, removeImages, status as scanStatus, refreshItem, extractThumb, tmdbSearch, tmdb, hasTmdb } from '../scanner.js';
import * as st from '../stream.js';
import * as act from '../activity.js';
import * as trick from '../trickplay.js';
import * as trakt from '../trakt.js';
import * as people from '../people.js';
import * as trailers from '../trailers.js';
import * as wrapped from '../wrapped.js';
import * as ver from '../versions.js';
import * as screen from '../screentime.js';
import * as follows from '../follows.js';
import { route, user, admin, img, adminAnywhere, isTrusted } from '../http/router.js';
import { insideMedia, MEDIA_ROOT, ctx, listItems, recommend, ageFilter, PROG, FROM, MAIN_ONLY, allowedFor, oneItem, similarTo, chaptersOf, invalidateProfile, maxAgeOf, screenBlock } from '../http/context.js';

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
    // Senast sedda avsnittet hämtas separat (som underfråga kördes den en gång per avsnitt – långsamt för långa serier)
    const last = get(`SELECT MAX(e.season*10000+e.episode) AS m FROM items e JOIN progress q ON q.item_id=e.id AND q.user_id=? AND q.watched=1
      WHERE e.parent_id=?`, uid, s.sid)?.m ?? -1;
    const next = listItems(uid, `i.parent_id=? AND COALESCE(p.watched,0)=0 AND (i.season*10000+i.episode) > ?`,
      [s.sid, last], 'i.season, i.episode', 1)[0];
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
  const q = `%${(c.q.get('q') || '').normalize('NFC').trim()}%`;
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
  // Begränsade profiler (barn) ska inte kunna hämta bilder (t.ex. stillbilder ur filmen) från titlar över gränsen
  if (maxAgeOf(c.user.id) != null && !allowedFor(c.user.id, get('SELECT * FROM items WHERE id=?', +c.p.id))) return fail(c.res, 404, 'Ingen bild');
  const f = path.join(IMAGES, `${+c.p.id}-${c.p.type}.jpg`);
  const ok = (data) => send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', ETag: 'auto' });
  fs.readFile(f, (e, data) => {
    if (!e) return ok(data);
    // Filmversioner har ingen egen affisch – använd filmens (t.ex. när Chromecast fått en token för versionen)
    const main = c.p.type !== 'thumb' && get('SELECT version_of FROM items WHERE id=?', +c.p.id)?.version_of;
    if (!main) return fail(c.res, 404, 'Ingen bild');
    fs.readFile(path.join(IMAGES, `${main}-${c.p.type}.jpg`), (e2, d2) => e2 ? fail(c.res, 404, 'Ingen bild') : ok(d2));
  });
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
