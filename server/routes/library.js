// Bibliotek och titlar: bibliotek, skanning, startsida, bläddring, titelsidor, framsteg, matchning,
// Min lista, samlingar, förhandsbilder, bilder, skådespelare, trailers och årssammanfattning.
import fs from 'node:fs';
import path from 'node:path';
import { all, run, get, now, tx, getSetting, IMAGES } from '../db.js';
import { send, readJson, fail, streamFile, MIME, clientIp } from '../util.js';
import { audit, createSession } from '../auth.js';
import { scan, removeImages, status as scanStatus, refreshItem, extractThumb, tmdbSearch, tmdb, hasTmdb, forgetFolder, parseMovie } from '../scanner.js';
import { rootsOf, setRoots, nested, MAX_ROOTS } from '../libpaths.js';
import { imageFile, seasonPosters } from '../localmeta.js';
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
import * as ccol from '../customcollections.js';
import * as calendar from '../calendar.js';
import * as homes from '../homeshelves.js';
import * as playprefs from '../playprefs.js';
import { sized } from '../imgsize.js';
import { route, user, admin, img, adminAnywhere, isTrusted } from '../http/router.js';
import { insideMedia, MEDIA_ROOT, ctx, listItems, ageFilter, PROG, FROM, MAIN_ONLY, allowedFor, oneItem, similarTo, chaptersOf, groupNewEpisodes, invalidateProfile, screenBlock, libOk, restricted } from '../http/context.js';

// Bibliotek. Fälten i svaret (l.*: id, name, type, path, anime, nfo, home_video, count) läses av apparna – bara tillägg.
// paths = alla bibliotekets mappar (path är den första).
// Bara de bibliotek användaren får se (rättigheter per användare, perms.js).
route('GET', '/api/libraries', user, (c) => send(c.res, 200, all(`SELECT l.*,
  CASE WHEN l.type='music' THEN (SELECT COUNT(*) FROM albums a WHERE a.library_id=l.id)
  WHEN l.type='audiobook' THEN (SELECT COUNT(*) FROM books b WHERE b.library_id=l.id)
  ELSE (SELECT COUNT(*) FROM items i WHERE i.library_id=l.id AND i.kind IN('movie','show') AND i.version_of IS NULL) END AS count FROM libraries l ORDER BY l.type IN ('music','audiobook'), l.type, l.name`)
  .filter(l => libOk(c.user.id, l.id)).map(l => ({ ...l, paths: rootsOf(l) }))));
/** Kontrollera bibliotekets mappar: finns, ligger under MEDIA_ROOT (realpath), inga dubbletter och ingen i en annan */
function checkPaths(list) {
  const out = [];
  if (!Array.isArray(list)) return { error: 'Ange bibliotekets mappar' };
  for (const p of list.slice(0, MAX_ROOTS + 1)) {
    const real = insideMedia(String(p || ''));
    if (!real) return { error: `Mappen ${String(p || '').slice(0, 200)} måste finnas och ligga under ${MEDIA_ROOT}` };
    try { if (!fs.statSync(real).isDirectory()) return { error: `${real} är ingen mapp` }; } catch { return { error: `Mappen ${real} går inte att läsa` }; }
    if (!out.includes(real)) out.push(real);
  }
  if (!out.length) return { error: 'Biblioteket behöver minst en mapp' };
  if (out.length > MAX_ROOTS) return { error: `Högst ${MAX_ROOTS} mappar per bibliotek` };
  const n = nested(out);
  if (n) return { error: `${n[0]} ligger i ${n[1]} – välj bara en av dem` };
  return { paths: out };
}
route('POST', '/api/libraries', admin, async (c) => {
  const { name, type, path: p, paths, anime, nfo, homeVideo } = await readJson(c.req);
  if (!name?.trim() || !['movie', 'show', 'music', 'audiobook'].includes(type)) return fail(c.res, 400, 'Namn och typ krävs');
  const chk = checkPaths(Array.isArray(paths) ? paths : [p]);
  if (chk.error) return fail(c.res, 400, chk.error);
  const real = chk.paths[0];
  const id = Number(run('INSERT INTO libraries(name,type,path,anime,nfo,home_video) VALUES(?,?,?,?,?,?)', name.trim().slice(0, 60), type, real,
    anime && type === 'show' ? 1 : 0, nfo === false ? 0 : 1, homeVideo && type === 'movie' ? 1 : 0).lastInsertRowid);
  if (chk.paths.length > 1) setRoots(id, chk.paths);
  audit('library_added', { ...ctx(c), detail: `${name.trim()} (${chk.paths.join(', ')})` });
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
// Status för skanningen; användare som bara får se vissa bibliotek får inte veta namnen på de andra
route('GET', '/api/scan', user, (c) => {
  if (!restricted(c.user.id)) return send(c.res, 200, scanStatus);
  const { library, analysis, warnings, ...rest } = scanStatus;
  send(c.res, 200, { ...rest, analysis: analysis ? { running: !!analysis.running } : analysis });
});
route('GET', '/api/fs', admin, (c) => {
  const p = insideMedia(c.q.get('path') || MEDIA_ROOT);
  if (!p) return fail(c.res, 400, 'Ogiltig sökväg');
  let dirs = [];
  try { dirs = fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort(); } catch {}
  send(c.res, 200, { path: p, parent: p === MEDIA_ROOT ? null : path.dirname(p), dirs });
});

// Bläddra
const CONTINUE_MAX = 20;
route('GET', '/api/home', user, (c) => {
  const uid = c.user.id;
  // Även sedda titlar som man börjat se om (position > 0) räknas
  const cont = listItems(uid, `i.kind IN('movie','episode') AND p.position > 0`, [], 'p.updated DESC', CONTINUE_MAX);
  // Senaste aktivitet per titel: halvsedda efter sitt framsteg, "nästa avsnitt" efter seriens senaste tittande
  const at = new Map(cont.length ? all(`SELECT item_id, updated FROM progress WHERE user_id=? AND item_id IN (${cont.map(() => '?').join(',')})`,
    uid, ...cont.map(x => x.id)).map(r => [r.item_id, r.updated]) : []);
  // "Nästa avsnitt" för serier man håller på med. Bara sedda/påbörjade avsnitt räknas – att markera som osedd
  // skriver också framsteg (position 0) men betyder inte att man håller på med serien.
  const shows = all(`SELECT e.parent_id AS sid, MAX(p.updated) AS t FROM progress p JOIN items e ON e.id=p.item_id
    WHERE p.user_id=? AND e.kind='episode' AND (p.watched=1 OR p.position > 0) GROUP BY e.parent_id
    HAVING MAX(p.updated) > COALESCE((SELECT h.at FROM continue_hidden h WHERE h.user_id=p.user_id AND h.item_id=e.parent_id), -1)
    ORDER BY t DESC LIMIT 20`, uid);
  const have = new Set(cont.map(x => x.show).filter(Boolean));
  for (const s of shows) {
    if (have.has(s.sid)) continue;
    // Senast sedda avsnittet hämtas separat (som underfråga kördes den en gång per avsnitt – långsamt för långa serier)
    // CROSS JOIN: seriens avsnitt först, inte alla användarens progress-rader (se PROG i http/context.js)
    const last = get(`SELECT MAX(e.season*10000+e.episode) AS m FROM items e CROSS JOIN progress q
      WHERE e.parent_id=? AND q.user_id=? AND q.item_id=e.id AND q.watched=1`, s.sid, uid)?.m ?? -1;
    // Specialavsnitt (säsong 0) föreslås bara när serien inte har några vanliga säsonger
    const next = listItems(uid, `i.parent_id=? AND COALESCE(p.watched,0)=0 AND (i.season*10000+i.episode) > ?
      AND (i.season > 0 OR NOT EXISTS (SELECT 1 FROM items x WHERE x.parent_id=i.parent_id AND x.season > 0))`,
      [s.sid, last], 'i.season, i.episode', 1)[0];
    if (next) { cont.push(next); at.set(next.id, s.t); }
  }
  // Allt sorteras ihop på senaste aktivitet (ett nyss sett avsnitts serie före en halvsedd film från förra veckan)
  cont.sort((a, b) => (at.get(b.id) || 0) - (at.get(a.id) || 0));
  cont.length = Math.min(cont.length, CONTINUE_MAX);
  // Musik och ljudböcker har egna startsidor (och inga titlar i items)
  const rows = all("SELECT * FROM libraries WHERE type NOT IN ('music','audiobook') ORDER BY name").filter(l => libOk(uid, l.id)).map(l => {
    const row = { library: l, title: `Nytt i ${l.name}`, items: listItems(uid, `i.library_id=? AND i.kind=?`, [l.id, l.type], 'i.added DESC', 24) };
    // Serier: nya avsnitt grupperade per säsong (nytt fält – items är oförändrat för apparna)
    if (l.type === 'show') row.seasons = groupNewEpisodes(listItems(uid, `i.library_id=? AND i.kind='episode'`, [l.id],
      'i.added DESC, i.season DESC, i.episode DESC', 400, 0, { slim: true }), 24);
    return row;
  });
  const watchlist = listItems(uid, 'i.id IN (SELECT item_id FROM watchlist WHERE user_id=p_uid.uid)', [], '(SELECT added FROM watchlist w WHERE w.user_id=p_uid.uid AND w.item_id=i.id) DESC', 30);
  const forYou = listItems(uid, follows.FOR_YOU_WHERE, [], follows.FOR_YOU_ORDER, 30);
  // Egna samlingar med "Visa på startsidan" (nytt fält – apparna läser det inte)
  const customCollections = ccol.homeShelves(c.user, !!c.user.is_admin && (adminAnywhere() || isTrusted(c.req)));
  // Kommer snart: avsnitt de närmaste 7 dagarna (nytt fält)
  const today = calendar.ymd();
  // Begränsade konton (åldersgräns eller bibliotek) ser bara serier i biblioteket, inte Sonarrs övriga
  const upcoming = calendar.entries(uid, today, calendar.addDays(today, 6), { allowed: (x) => allowedFor(uid, x), kid: restricted(uid),
    sonarrList: calendar.sonarrCached(), limit: 30 });
  // Tematiska hyllor, Utvalt och användarens ordning (nya fält – apparna läser dem inte). Dolda hyllor räknas inte.
  // Rekommenderat för dig räknas och cachas tillsammans med dem (themed).
  const homeLayout = homes.getLayout(uid);
  const off = new Set(homeLayout.hidden);
  const th = homes.themed(uid, { hidden: homeLayout.hero === 'off' ? [...homeLayout.hidden, 'hero'] : homeLayout.hidden });
  const recommended = th.recommended;
  const featured = homeLayout.hero === 'off' ? [] : homes.featured(uid, recommended, th.heroIds);
  const listening = off.has('listening') ? [] : homes.listening(uid);
  send(c.res, 200, { continue: cont, rows, watchlist, recommended, forYou, customCollections, upcoming,
    featured, because: th.because, topRated: th.topRated, hiddenGems: th.hiddenGems, shortTonight: th.shortTonight, onThisDay: th.onThisDay,
    genreOfDay: th.genreOfDay, listening, homeLayout });
});
// Startsidans ordning, dolda hyllor och Utvalt per användare (följer med mellan enheter)
route('GET', '/api/me/home-layout', user, (c) => send(c.res, 200, homes.getLayout(c.user.id)));
route('PUT', '/api/me/home-layout', user, async (c) => {
  try { send(c.res, 200, homes.setLayout(c.user.id, await readJson(c.req))); } catch (e) { fail(c.res, 400, e.message); }
});
const SORTS = { title: 'i.sort_title', added: 'i.added DESC', year: 'i.year DESC, i.sort_title', rating: 'i.rating DESC NULLS LAST, i.sort_title',
  date: 'i.taken DESC NULLS LAST, i.added DESC, i.sort_title' };
/** ?folder= för hemvideor: relativ mapp utan inledande/avslutande snedstreck; '..' och styrtecken godtas inte */
function folderParam(v) {
  const f = String(v || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').slice(0, 1000);
  return f.split('/').some(p => p === '..' || p === '.') || /[\u0000-\u001f]/.test(f) ? null : f.split('/').join(path.sep);
}
/** Undermapparna i en hemvideomapp: namn, antal klipp (hela undermappen), första/senaste datum och ett omslag */
function subfolders(uid, libId, f, sort) {
  const age = ageFilter(uid), pre = f ? f + path.sep : '';
  const rows = all(`SELECT i.folder AS folder, COUNT(*) AS n, MIN(i.taken) AS first, MAX(i.taken) AS latest,
    MAX(CASE WHEN i.thumb=1 THEN i.id END) AS cover
    FROM items i LEFT JOIN items s ON s.id=i.parent_id WHERE i.library_id=? AND i.kind='movie' AND i.version_of IS NULL
    AND i.folder IS NOT NULL AND length(i.folder) > ? AND substr(i.folder, 1, ?)=?${age.sql} GROUP BY i.folder`, libId, pre.length, pre.length, pre, ...age.params);
  const by = new Map();
  for (const r of rows) {
    const name = r.folder.slice(pre.length).split(path.sep)[0];
    if (!name) continue;
    const g = by.get(name) || { name, path: (pre + name).split(path.sep).join('/'), count: 0, first: null, latest: null, cover: null };
    g.count += r.n;
    if (r.first != null && (g.first == null || r.first < g.first)) g.first = r.first;
    if (r.latest != null && (g.latest == null || r.latest >= g.latest)) { g.latest = r.latest; if (r.cover) g.cover = r.cover; }
    if (!g.cover && r.cover) g.cover = r.cover;
    by.set(name, g);
  }
  const out = [...by.values()];
  return sort === 'date' || sort === 'added' ? out.sort((a, b) => (b.latest || 0) - (a.latest || 0)) : out.sort((a, b) => a.name.localeCompare(b.name, 'sv', { numeric: true }));
}
route('GET', '/api/libraries/:id/items', user, (c) => {
  const lib = get('SELECT * FROM libraries WHERE id=?', c.p.id);
  if (!lib || !libOk(c.user.id, lib.id)) return fail(c.res, 404, 'Biblioteket finns inte');
  const where = [`i.library_id=?`, `i.kind=?`], params = [lib.id, lib.type];
  const filter = c.q.get('filter');
  if (filter === 'unwatched') where.push(lib.type === 'show' ? 'ep_watched < ep_total' : 'COALESCE(p.watched,0)=0');
  if (filter === 'watched') where.push(lib.type === 'show' ? 'ep_watched = ep_total' : 'p.watched=1');
  // Valfri sidindelning (?limit=&offset=); utan den skickas hela biblioteket (upp till 5000) som tidigare
  const limit = Math.min(10000, Math.max(1, parseInt(c.q.get('limit')) || 5000)), offset = Math.max(0, parseInt(c.q.get('offset')) || 0);
  // Hemvideor: ?folder= visar en mapp i taget (klippen direkt i mappen + undermapparna som "samlingar") – nya fält folder/folders
  let folder = null;
  if (lib.type === 'movie' && lib.home_video && c.q.has('folder')) {
    folder = folderParam(c.q.get('folder'));
    if (folder == null) return fail(c.res, 400, 'Ogiltig mapp');
    where.push(`COALESCE(i.folder, '')=?`); params.push(folder);
  }
  const out = { library: { ...lib, paths: rootsOf(lib) }, items: listItems(c.user.id, where.join(' AND '), params, SORTS[c.q.get('sort')] || SORTS.title, limit, offset, { slim: true }) };
  if (folder != null) { out.folder = folder.split(path.sep).join('/'); out.folders = subfolders(c.user.id, lib.id, folder, c.q.get('sort')); }
  // ?collections=1: filmer i samma samling (minst två synliga i listan) visas som ett samlingskort på den första filmens plats
  if (lib.type === 'movie' && c.q.get('collections') === '1') out.items = collapseCollections(out.items);
  if (c.q.has('limit') || c.q.has('offset')) {
    const age = ageFilter(c.user.id);
    out.total = get(`SELECT COUNT(*) AS n FROM (SELECT ${PROG} ${FROM} LEFT JOIN items s ON s.id=i.parent_id WHERE (${where.join(' AND ')})${MAIN_ONLY}${age.sql})`, c.user.id, ...params, ...age.params).n;
    out.offset = offset; out.limit = limit;
  }
  send(c.res, 200, out);
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
    // Säsonger med lokal affisch (nytt fält): /api/image/:id/season<N>
    const sp = seasonPosters(it);
    if (sp.length) out.seasonPosters = sp;
    out.next = out.children.find(e => !e.watched && e.position > 0) || out.children.find(e => !e.watched) || out.children[0] || null;
  } else {
    Object.assign(out, {
      file: path.basename(file.path), size: file.size, container: file.container, vcodec: file.vcodec, acodec: file.acodec,
      width: file.width, height: file.height, hdr: file.hdr || null, chapters: chaptersOf(file),
      audio: st.streamsOf(file).filter(s => s.type === 'audio'), subtitles: st.subtitlesOf(file).map(({ file, ...s }) => s)
    });
    // Förvalda spår enligt kontots uppspelningsval (webbspelaren; PGS ritas av webbspelaren utan inbränning)
    const prefs = playprefs.getPrefs(uid), a = playprefs.pickAudio(out.audio, prefs);
    out.defaultAudio = a ? a.index : null;
    out.defaultSub = playprefs.pickSub(out.subtitles, a, prefs, { pgs: true })?.id ?? null;
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
  const row = get('SELECT id,kind,parent_id,version_of,age FROM items WHERE id=?', c.p.id);
  if (!row || !allowedFor(c.user.id, row)) return fail(c.res, 404, 'Finns inte');
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
// Ändra ett bibliotek: { name, anime, paths (alla mappar) eller addPath (en till), nfo, homeVideo }. En borttagen mapp tar bort
// titlarna i den ur biblioteket (filerna på disken rörs inte).
route('PUT', '/api/libraries/:id', admin, async (c) => {
  const b = await readJson(c.req);
  const l = get('SELECT * FROM libraries WHERE id=?', c.p.id); if (!l) return fail(c.res, 404, 'Finns inte');
  const old = rootsOf(l);
  let next = null;
  if (Array.isArray(b.paths) || typeof b.addPath === 'string') {
    const chk = checkPaths(Array.isArray(b.paths) ? b.paths : [...old, b.addPath]);
    if (chk.error) return fail(c.res, 400, chk.error);
    next = chk.paths;
  }
  let rescan = false;
  const changes = [];
  if (typeof b.name === 'string' && b.name.trim() && b.name.trim() !== l.name) { run('UPDATE libraries SET name=? WHERE id=?', b.name.trim().slice(0, 60), l.id); changes.push(`namn ${b.name.trim().slice(0, 60)}`); }
  if (b.anime != null && l.type === 'show' && !!b.anime !== !!l.anime) { run('UPDATE libraries SET anime=? WHERE id=?', b.anime ? 1 : 0, l.id); run("UPDATE items SET meta_done=0 WHERE library_id=? AND kind='show' AND meta_done=1", l.id); rescan = true; }
  if (b.nfo != null && (l.type === 'movie' || l.type === 'show') && !!b.nfo !== (l.nfo !== 0)) {
    run('UPDATE libraries SET nfo=? WHERE id=?', b.nfo ? 1 : 0, l.id);
    // Av: NFO-värdena glöms och titlarna hämtas från TMDB igen (skanningen tar bort resten); på: läses vid skanningen
    if (!b.nfo) run(`UPDATE items SET meta_done=CASE WHEN kind IN ('movie','show') AND meta_done IN (1,2) AND match_locked=0 THEN 0 ELSE meta_done END WHERE library_id=? AND nfo_sig IS NOT NULL`, l.id);
    changes.push(b.nfo ? 'NFO på' : 'NFO av'); rescan = true;
  }
  if (b.homeVideo != null && l.type === 'movie' && !!b.homeVideo !== !!l.home_video) {
    tx(() => {
      run('UPDATE libraries SET home_video=? WHERE id=?', b.homeVideo ? 1 : 0, l.id);
      // Alla filer läses om (titel/datum från filen, eller TMDB-matchning igen)
      if (b.homeVideo) run(`UPDATE items SET mtime=0, tmdb_id=NULL, overview=NULL, rating=NULL, genres=NULL, collection_id=NULL, cert=NULL, age=NULL,
        original_title=NULL, trailer_yt=NULL, match_locked=0, poster=CASE WHEN local_img LIKE '%"poster"%' THEN poster ELSE 0 END,
        backdrop=CASE WHEN local_img LIKE '%"backdrop"%' THEN backdrop ELSE 0 END WHERE library_id=?`, l.id);
      else for (const r of all('SELECT id, path FROM items WHERE library_id=? AND path IS NOT NULL', l.id)) {
        const p = parseMovie(r.path);
        run('UPDATE items SET mtime=0, meta_done=0, taken=NULL, folder=NULL, title=?, sort_title=?, year=? WHERE id=? AND match_locked=0', p.title, p.title.toLowerCase(), p.year, r.id);
      }
    });
    changes.push(b.homeVideo ? 'hemvideor' : 'inte hemvideor'); rescan = true;
  }
  if (next && next.join('\n') !== old.join('\n')) {
    setRoots(l.id, next);
    for (const r of old.filter(r => !next.includes(r))) { const n = forgetFolder(l, r, next); changes.push(`mappen ${r} borttagen (${n} titlar)`); }
    for (const r of next.filter(r => !old.includes(r))) changes.push(`mappen ${r} tillagd`);
    act.watchLibraries(scan);
    rescan = true;
  }
  if (changes.length) audit('library_changed', { ...ctx(c), detail: `${l.name}: ${changes.join(', ')}` });
  if (rescan) scan(l.id);
  send(c.res, 200, { ok: true, paths: rootsOf(get('SELECT * FROM libraries WHERE id=?', l.id)) });
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

// Snabbåtgärder från kortens meny: det kortet inte vet (Min lista, följer, nästa avsnitt) utan att hämta hela titelsidan
route('GET', '/api/items/:id/state', user, (c) => {
  const uid = c.user.id, row = get('SELECT id, kind, parent_id, version_of, age FROM items WHERE id=?', c.p.id);
  if (!row || !allowedFor(uid, row)) return fail(c.res, 404, 'Finns inte');
  const id = row.kind === 'episode' ? row.parent_id : ver.mainIdOf(row);
  const out = { inWatchlist: !!get('SELECT 1 FROM watchlist WHERE user_id=? AND item_id=?', uid, id) };
  if (row.kind !== 'movie') Object.assign(out, follows.followInfo(uid, id));
  if (row.kind === 'show') {
    const eps = listItems(uid, 'i.parent_id=?', [row.id], 'i.season, i.episode', 5000, 0, { slim: true });
    const n = eps.find(e => !e.watched && e.position > 0) || eps.find(e => !e.watched) || null;
    out.next = n && { id: n.id, position: n.position, season: n.season, episode: n.episode };
  }
  send(c.res, 200, out);
});
// "Ta bort från Fortsätt titta": positionen nollställs utan att titeln markeras som sedd, och serien
// döljs tills man tittar igen. { hide: false, position } ångrar (återställer positionen om den fortfarande är 0).
route('POST', '/api/items/:id/continue', user, async (c) => {
  const uid = c.user.id, b = await readJson(c.req);
  let it = get("SELECT id, kind, parent_id, version_of, age FROM items WHERE id=? AND kind IN ('movie','episode')", c.p.id);
  if (it?.version_of) it = get('SELECT id, kind, parent_id, version_of, age FROM items WHERE id=?', it.version_of) || it;
  if (!it || !allowedFor(uid, it)) return fail(c.res, 404, 'Finns inte');
  const prev = get('SELECT position FROM progress WHERE user_id=? AND item_id=?', uid, it.id);
  if (b.hide === false) {
    const pos = Math.max(0, +b.position || 0);
    if (pos > 0 && prev && !prev.position) run('UPDATE progress SET position=? WHERE user_id=? AND item_id=?', pos, uid, it.id);
    if (it.parent_id) run('DELETE FROM continue_hidden WHERE user_id=? AND item_id=?', uid, it.parent_id);
    return send(c.res, 200, { ok: true });
  }
  tx(() => {
    if (prev?.position) run('UPDATE progress SET position=0 WHERE user_id=? AND item_id=?', uid, it.id);
    if (it.parent_id) run(`INSERT INTO continue_hidden(user_id,item_id,at) VALUES(?,?,?)
      ON CONFLICT(user_id,item_id) DO UPDATE SET at=excluded.at`, uid, it.parent_id, now());
  });
  send(c.res, 200, { ok: true, position: prev?.position || 0 });
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
  // En samling är minst två filmer; antal och år räknas bara på det profilen får se (v = synlig för profilen)
  const age = ageFilter(c.user.id);
  const cols = all(`SELECT c.*, COUNT(*) AS total, SUM(m.v) AS n, MIN(CASE WHEN m.v THEN m.y END) AS y0, MAX(CASE WHEN m.v THEN m.y END) AS y1
    FROM collections c JOIN (SELECT i.collection_id AS cid, i.year AS y, (1${age.sql}) AS v FROM items i LEFT JOIN items s ON s.id=i.parent_id
      WHERE i.collection_id IS NOT NULL AND i.kind='movie'${MAIN_ONLY}) m ON m.cid=c.id
    GROUP BY c.id HAVING total >= 2 AND n > 0 ORDER BY c.name`, ...age.params);
  send(c.res, 200, cols.map(col => ({ id: col.id, name: col.name, overview: col.overview, poster: !!col.poster, backdrop: !!col.backdrop,
    count: col.n, years: [col.y0, col.y1], visible: true })));
});
/** Får profilen se någon film i samlingen? (annars ska varken namn, beskrivning eller bilder synas) */
const collectionVisible = (uid, cid) => {
  const age = ageFilter(uid);
  return !!get(`SELECT 1 FROM items i LEFT JOIN items s ON s.id=i.parent_id WHERE i.collection_id=? AND i.kind='movie'${MAIN_ONLY}${age.sql} LIMIT 1`, cid, ...age.params);
};
route('GET', '/api/collections/:cid', user, (c) => {
  const col = get('SELECT * FROM collections WHERE id=?', +c.p.cid);
  if (!col) return fail(c.res, 404, 'Finns inte');
  const items = listItems(c.user.id, 'i.collection_id=? AND i.kind=\'movie\'', [col.id], 'i.year', 100);
  if (!items.length) return fail(c.res, 404, 'Finns inte');
  send(c.res, 200, { id: col.id, name: col.name, overview: col.overview, poster: !!col.poster, backdrop: !!col.backdrop, items });
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
// ?w= ger bilden nedskalad till en av de fasta bredderna (imgsize.js) – behörighetskontrollerna görs först
route('GET', '/api/collection-image/:cid/:type', img, async (c) => {
  if (!['poster', 'backdrop'].includes(c.p.type)) return fail(c.res, 404, '');
  if (restricted(c.user.id) && !collectionVisible(c.user.id, +c.p.cid)) return fail(c.res, 404, 'Ingen bild');
  fs.readFile(await sized(path.join(IMAGES, `c${+c.p.cid}-${c.p.type}.jpg`), c.q.get('w')), (e, data) => e ? fail(c.res, 404, 'Ingen bild')
    : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }));
});
route('GET', '/api/image/:id/:type', img, async (c) => {
  // season<N> = lokal säsongsaffisch (season01-poster.jpg bredvid serien, localmeta.js)
  if (!['poster', 'backdrop', 'thumb'].includes(c.p.type) && !/^season\d{1,4}$/.test(c.p.type)) return fail(c.res, 404, '');
  // Begränsade profiler (barn, eller utan åtkomst till biblioteket) ska inte kunna hämta bilder (t.ex. stillbilder ur filmen)
  if (restricted(c.user.id) && !allowedFor(c.user.id, get('SELECT * FROM items WHERE id=?', +c.p.id))) return fail(c.res, 404, 'Ingen bild');
  const f = imageFile(+c.p.id, c.p.type);
  const ok = (data) => send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', ETag: 'auto' });
  const w = c.q.get('w');
  fs.readFile(await sized(f, w), async (e, data) => {
    if (!e) return ok(data);
    // Filmversioner har ingen egen affisch – använd filmens (t.ex. när Chromecast fått en token för versionen)
    const main = c.p.type !== 'thumb' && get('SELECT version_of FROM items WHERE id=?', +c.p.id)?.version_of;
    if (!main) return fail(c.res, 404, 'Ingen bild');
    fs.readFile(await sized(path.join(IMAGES, `${main}-${c.p.type}.jpg`), w), (e2, d2) => e2 ? fail(c.res, 404, 'Ingen bild') : ok(d2));
  });
});

// ---------- Skådespelare, trailers och årssammanfattning ----------
const { TRAILER_SCOPE } = trailers;
/** Rollista (avsnitt visar seriens), lokala trailers och YouTube-trailer (inte för barnprofiler – länken leder ut från appen) */
function titleExtras(u, it) {
  const ep = it.kind === 'episode';
  return { cast: people.castOf(ep ? it.parent_id : it.id), trailers: ep ? [] : trailers.trailersOf(it.id),
    youtube: !ep && u.max_age == null && trailers.youtubeOk(it.trailer_yt) ? it.trailer_yt : null };
}
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
  // Begränsade: bara personer som finns i en titel profilen får se (som personsidan)
  if (restricted(c.user.id) && !listItems(c.user.id, `i.kind IN ('movie','show') AND i.id IN (SELECT item_id FROM item_people WHERE person_id=?)`, [+c.p.pid], 'i.id', 1, 0, { slim: true }).length) return fail(c.res, 404, 'Ingen bild');
  const f = await people.personImage(+c.p.pid);
  if (!f) return fail(c.res, 404, 'Ingen bild');
  fs.readFile(await sized(f, c.q.get('w')), (e, data) => e ? fail(c.res, 404, 'Ingen bild') : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800' }));
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
