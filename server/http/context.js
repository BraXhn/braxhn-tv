// Gemensamma hjälpfunktioner för routefilerna: formning av titlar, åldersgränser, rekommendationer,
// hushållsprofiler, uppslag av titlar för uppspelning och skärmtidsspärren.
import fs from 'node:fs';
import path from 'node:path';
import { getSetting, get, all } from '../db.js';
import { clientIp, fail, send, isLocalReq } from '../util.js';
import * as act from '../activity.js';
import * as ver from '../versions.js';
import * as screen from '../screentime.js';
import * as st from '../stream.js';
import { permsOf, libsOf, libOk, libFilter, canDownload, remoteMax } from '../perms.js';
export { permsOf, libsOf, libOk, libFilter, canDownload, remoteMax };

export const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/media');

// ---------- formning av objekt ----------
// Avsnittsräkning behövs bara för serier (CASE gör att underfrågorna inte körs för filmer/avsnitt).
// ep_watched: CROSS JOIN låser ordningen – seriens avsnitt först (items_parent_se), sedan ett uppslag per avsnitt i
// progress. Utan eller med inaktuell statistik (sqlite_stat1, t.ex. tagen när biblioteket var tomt) valde SQLite annars att gå igenom alla
// användarens progress-rader för varje serie: 400 serier × 10 000 rader = 1,2 s i stället för 12 ms.
export const PROG = `p.position AS p_pos, p.watched AS p_watched, p.updated AS p_updated,
  CASE WHEN i.kind='show' THEN (SELECT COUNT(*) FROM items e WHERE e.parent_id=i.id) END AS ep_total,
  CASE WHEN i.kind='show' THEN (SELECT COUNT(*) FROM items e CROSS JOIN progress q WHERE e.parent_id=i.id AND q.user_id=p_uid.uid AND q.item_id=e.id AND q.watched=1) END AS ep_watched,
  CASE WHEN i.kind='show' THEN (SELECT COUNT(DISTINCT e.season) FROM items e WHERE e.parent_id=i.id) END AS ep_seasons`;
// Kolumner som shape() använder – inte tunga fält som streams/chapters (och overview i listvyer)
const COLS = `i.id, i.kind, i.title, i.year, i.library_id, i.poster, i.backdrop, i.thumb, i.duration, i.rating, i.added, i.hdr,
  i.genres, i.cert, i.age, i.collection_id, i.season, i.episode, i.parent_id, i.height,
  i.intro_start, i.intro_end, i.credits_start, i.recap_start, i.recap_end, i.trickplay, i.poster_color, i.backdrop_color, i.thumb_color, i.taken, i.studio`;
export const FROM = `FROM items i JOIN (SELECT ? AS uid) p_uid LEFT JOIN progress p ON p.item_id=i.id AND p.user_id=p_uid.uid`;
/** Profilens eget betyg för titeln i (halva stjärnor 2–10, NULL = inget) – kräver p_uid från FROM */
export const MY_RATING = '(SELECT ur.value FROM item_ratings ur WHERE ur.user_id=p_uid.uid AND ur.item_id=i.id)';
export const chaptersOf = (it) => { try { return JSON.parse(it.chapters || '[]'); } catch { return []; } };
function shape(r) {
  const o = {
    id: r.id, kind: r.kind, title: r.title, year: r.year, library: r.library_id,
    poster: !!r.poster, backdrop: !!r.backdrop, thumb: !!r.thumb,
    duration: r.duration, rating: r.rating, overview: r.overview ?? undefined, added: r.added, hdr: r.hdr || null,
    genres: (() => { try { return JSON.parse(r.genres || '[]'); } catch { return []; } })(), cert: r.cert || null, age: r.age ?? null,
    collection: r.collection_id || null,
    // Platshållarfärg medan bilden laddas ('#rrggbb', server/imgcolor.js) – bara när den är känd
    ph: r.poster_color || undefined, phBackdrop: r.backdrop_color || undefined, phThumb: r.thumb_color || undefined,
    // Hemvideor: inspelningsdatum (unix-sekunder); studio ur NFO – nya fält, bara när de finns
    taken: r.taken ?? undefined, studio: r.studio || undefined,
    // Eget betyg (1–5 stjärnor i halva steg, server/ratings.js) – bara när profilen betygsatt titeln
    userRating: r.u_rating ? r.u_rating / 2 : undefined
  };
  if (r.kind === 'episode') Object.assign(o, { season: r.season, episode: r.episode, show: r.parent_id, showTitle: r.show_title, showPoster: !!r.show_poster, showThumb: !!r.show_thumb,
    showPh: r.show_poster_color || undefined });
  if (r.kind === 'show') Object.assign(o, { episodes: r.ep_total, watchedEpisodes: r.ep_watched, watched: r.ep_total > 0 && r.ep_total === r.ep_watched, seasons: r.ep_seasons ?? 0 });
  else Object.assign(o, { position: r.p_pos || 0, watched: !!r.p_watched, height: r.height,
    intro: r.intro_end ? { start: r.intro_start || 0, end: r.intro_end } : null, credits: r.credits_start || null,
    recap: r.recap_end ? { start: r.recap_start || 0, end: r.recap_end } : null, trickplay: r.trickplay === 1 });
  return o;
}
// ---------- åldersgräns för profiler ----------
export const allowUnrated = () => getSetting('allow_unrated', '0') === '1';
export const maxAgeOf = (uid) => get('SELECT max_age FROM users WHERE id=?', uid)?.max_age ?? null;
/**
 * Får användaren se titeln? Biblioteksbehörighet (perms.js) och åldersgräns. Avsnitt ärver seriens och filmversioner
 * huvudradens åldersgräns. Okänd ålder döljs för begränsade profiler. Rader utan library_id (delvisa SELECT) slås upp.
 */
export function allowedFor(uid, it) {
  if (!it) return true;
  const pm = permsOf(uid);
  if (pm.libs != null) {
    let lib = it.library_id;
    if (lib == null && it.id != null) lib = get('SELECT library_id FROM items WHERE id=?', it.id)?.library_id;
    if (lib == null || !pm.libs.includes(lib)) return false;
  }
  const max = pm.maxAge;
  if (max == null) return true;
  // Fotobibliotekens videoklipp har ingen åldersgräns: barnprofiler bara när administratören tillåtit biblioteket
  const kids = photoLibKids(), libId = it.library_id ?? (it.id != null && kids.size ? get('SELECT library_id FROM items WHERE id=?', it.id)?.library_id : null);
  if (kids.has(libId)) return kids.get(libId) === 1;
  let age = it.age;
  // Avsnitt ärver seriens och filmversioner huvudradens åldersgräns
  const from = it.parent_id || it.version_of;
  if (age == null && from) age = get('SELECT age FROM items WHERE id=?', from)?.age;
  return age == null ? allowUnrated() : age <= max;
}
/** Begränsad på något sätt (åldersgräns eller bibliotek)? Då kontrolleras även bilder och liknande billiga routes. */
export const restricted = (uid) => { const pm = permsOf(uid); return pm.maxAge != null || pm.libs != null; };
// Fotobibliotekens id → kids (libraries.kids), en kort stund i minnet (allowedFor anropas per titel i listor)
let kidsCache = { t: 0, m: new Map() };
export const forgetPhotoLibs = () => { kidsCache.t = 0; };
export function photoLibKids() {
  if (Date.now() - kidsCache.t > 5000) kidsCache = { t: Date.now(), m: new Map(all("SELECT id, kids FROM libraries WHERE type='photo'").map(r => [r.id, r.kids])) };
  return kidsCache.m;
}
// Fotobibliotekens videoklipp (rader i items för spelaren, server/photos.js) hör inte hemma i film- och serielistor
const NO_PHOTOS = " AND i.library_id NOT IN (SELECT id FROM libraries WHERE type='photo')";
/**
 * Ålders- och biblioteksfilter för SQL (alias i = titeln, s = ev. serie). Alla listfrågor över titlar går genom det.
 * photos: true tar med fotobibliotekens videoklipp (bara uppslag på id – allowedFor gäller ändå).
 */
export function ageFilter(uid, { photos = false } = {}) {
  const pm = permsOf(uid), max = pm.maxAge;
  const lib = pm.libs == null ? { sql: '', params: [] } : { sql: ' AND i.library_id IN (SELECT value FROM json_each(?))', params: [JSON.stringify(pm.libs)] };
  const np = photos ? '' : NO_PHOTOS;
  // Barnprofiler: klippen i ett fotobibliotek som de får se (kids) har ingen åldersgräns
  const kidsOk = photos && max != null ? [...photoLibKids()].filter(([, k]) => k === 1).map(([id]) => id) : [];
  const age = kidsOk.length ? `(COALESCE(i.age, s.age, ?) <= ? OR i.library_id IN (${kidsOk.map(Number).join(',')}))` : 'COALESCE(i.age, s.age, ?) <= ?';
  return max == null ? { sql: lib.sql + np, params: lib.params } : { sql: ` AND ${age}${lib.sql}${np}`, params: [allowUnrated() ? max : 999, max, ...lib.params] };
}
// Filmversioner (version_of) listas aldrig – bara huvudraden syns i listor, sök och rekommendationer
export const MAIN_ONLY = ' AND i.version_of IS NULL';
/** slim: utan beskrivning (för stora listor där den inte visas); versions: även filmversioner (bara för uppslag på id) */
export const listItems = (uid, where, params = [], order = 'i.sort_title', limit = 500, offset = 0, { slim = false, versions = false } = {}) => {
  const age = ageFilter(uid, { photos: versions });
  return all(`SELECT ${COLS}${slim ? '' : ', i.overview'}, s.title AS show_title, s.poster AS show_poster, s.thumb AS show_thumb, s.poster_color AS show_poster_color, ${MY_RATING} AS u_rating, ${PROG} ${FROM} LEFT JOIN items s ON s.id=i.parent_id WHERE (${where})${versions ? '' : MAIN_ONLY}${age.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    uid, ...params, ...age.params, limit, offset).map(shape);
};
/**
 * Nya avsnitt grupperade per serie och säsong (som "Nyligen tillagda" i Plex): ett kort per säsong i stället för
 * ett per avsnitt. eps = avsnitt från listItems med det senast tillagda först. Ordningen följer det nyaste avsnittet
 * i varje grupp. latest = nyaste avsnittet (högst nummer bland de nyaste), next = första osedda i säsongsordning.
 */
export function groupNewEpisodes(eps, limit = 24) {
  const groups = new Map();
  for (const e of eps) {
    if (e.kind !== 'episode' || e.show == null) continue;
    const k = e.show + ':' + e.season;
    let g = groups.get(k);
    if (!g) {
      if (groups.size >= limit) continue;
      g = { show: e.show, showTitle: e.showTitle || '', showPoster: !!e.showPoster, showThumb: !!e.showThumb, showPh: e.showPh, season: e.season, added: e.added, count: 0, unwatched: 0, latest: null, next: null };
      groups.set(k, g);
    }
    g.count++;
    if (!e.watched) {
      g.unwatched++;
      if (!g.next || e.episode < g.next.episode) g.next = { id: e.id, episode: e.episode, position: e.position || 0 };
    }
    if (!g.latest || e.episode > g.latest.episode) g.latest = { id: e.id, title: e.title, season: e.season, episode: e.episode };
  }
  return [...groups.values()];
}
export const oneItem = (uid, id) => listItems(uid, 'i.id=?', [id], 'i.id', 1, 0, { versions: true })[0];

export function insideMedia(p) {
  try { const r = fs.realpathSync(p); return r === MEDIA_ROOT || r.startsWith(MEDIA_ROOT + path.sep) ? r : null; }
  catch { return null; }
}
export const ctx = (c) => ({ user: c.user, ip: clientIp(c.req) });

// Installationsguiden (server/routes/setup.js): inte klar sedan första kontot skapades (setup_done=0).
// Äldre installationer har ingen inställning – där räknas guiden som klar om det redan finns bibliotek.
export const setupPending = () => { const v = getSetting('setup_done', ''); return v === '0' || (v === '' && !get('SELECT 1 FROM libraries LIMIT 1')); };

// ---------- Profiler (hushåll) ----------
// Huvudkontot i hushållet, och om den inloggade får hantera hushållets profiler
export const householdRoot = (u) => u.parent_id || u.id;
export const canManage = (c, root) => c.user.is_admin || (c.user.id === root);

// ---------- Rekommendationer (lokalt, utan molntjänst) ----------
// Smakprofilen (genrevikter) cachas en stund per användare och räknas om när något relevant ändras
const profiles = new Map(); // uid -> { w, t }
const PROFILE_TTL = 5 * 60e3;
export function invalidateProfile(uid) { profiles.delete(uid); }
const parseGenres = (g) => { try { const a = JSON.parse(g || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
/** Smakprofilen: genre -> vikt ur det användaren sett (och Min lista). Används av rekommendationer och bio-läget. */
export function genreProfile(uid) {
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
export function itemsByIds(uid, ids) {
  if (!ids.length) return [];
  const rows = listItems(uid, `i.id IN (${ids.map(() => '?').join(',')})`, ids, 'i.id', ids.length);
  const byId = new Map(rows.map(r => [r.id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}
// Kandidaterna (alla filmer/serier med genrer, tolkade) cachas en stund per åldersgräns – startsidan frågar ofta.
// Skanningen tömmer cachen (clearRecommendations via skannerns afterScan-krok).
const candCache = new Map(); // åldersfiltrets parametrar -> { rows, t }
const CAND_TTL = 5 * 60e3;
export function clearRecommendations() { candCache.clear(); }
function candidates(age) {
  const k = age.params.join(','), c = candCache.get(k);
  if (c && Date.now() - c.t < CAND_TTL) return c.rows;
  const rows = all(`SELECT i.id, i.genres, i.rating FROM items i LEFT JOIN items s ON s.id=i.parent_id
    WHERE i.kind IN ('movie','show') AND i.genres IS NOT NULL AND i.genres != '[]'${MAIN_ONLY}${age.sql} ORDER BY i.added DESC`, ...age.params)
    .map(r => ({ id: r.id, rating: r.rating, g: parseGenres(r.genres) }));
  candCache.set(k, { rows, t: Date.now() });
  if (candCache.size > 50) candCache.delete(candCache.keys().next().value);
  return rows;
}
// Poängsättning sker på lätta kolumner; bara de bästa hämtas sedan i sin helhet
/** seenIds: redan uträknade sedda/påbörjade titlar (Set, ändras) – annars frågas databasen */
export function recommend(uid, limit, seenIds = null) {
  const w = genreProfile(uid);
  if (!Object.keys(w).length) return [];
  const age = ageFilter(uid);
  // Titlar man redan börjat på/sett (serier räknas via sina avsnitt) och titlar i Min lista hoppas över
  const seen = seenIds || new Set(all(`SELECT DISTINCT COALESCE(e.parent_id, e.id) AS id FROM progress q JOIN items e ON e.id=q.item_id
    WHERE q.user_id=? AND (q.watched=1 OR q.position > 0)`, uid).map(r => r.id));
  for (const r of all('SELECT item_id FROM watchlist WHERE user_id=?', uid)) seen.add(r.item_id);
  const cands = candidates(age).filter(r => !seen.has(r.id)).slice(0, 3000);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const top = cands.map(r => ({ id: r.id, score: r.g.reduce((a, x) => a + (w[x] || 0) / total, 0) / Math.sqrt(r.g.length || 1) + (r.rating || 6) / 50 }))
    .filter(x => x.score > 0.2).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.id);
  return itemsByIds(uid, top);
}
export function similarTo(uid, it, limit) {
  const g = parseGenres(it.genres);
  if (!g.length) return [];
  const age = ageFilter(uid);
  const cands = all(`SELECT i.id, i.genres, i.collection_id FROM items i LEFT JOIN items s ON s.id=i.parent_id
    WHERE i.kind=? AND i.id != ? AND i.genres IS NOT NULL${MAIN_ONLY}${age.sql} ORDER BY i.rating DESC LIMIT 2000`, it.kind, it.id, ...age.params);
  const top = cands.map(x => { const xg = parseGenres(x.genres); return { id: x.id, s: xg.filter(y => g.includes(y)).length / Math.max(g.length, xg.length) + (x.collection_id && x.collection_id === it.collection_id ? 1 : 0) }; })
    .filter(o => o.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, limit).map(o => o.id);
  return itemsByIds(uid, top);
}

// ---------- Uppspelning ----------
/** Titeln som ska spelas (c.p.id): åldersgräns, admins stopp och skärmtid kontrolleras. Svarar själv med fel och ger null. */
export const mediaItem = (c) => {
  const it = get(`SELECT * FROM items WHERE id=? AND kind!='show'`, c.p.id);
  if (!it) { fail(c.res, 404, 'Finns inte'); return null; }
  if (!allowedFor(c.user.id, it)) { fail(c.res, 403, 'Inte tillgänglig i den här profilen'); return null; }
  if (c.req.url.includes('/api/stream/')) {
    const p = c.req.url.split('?')[0];
    // Nedladdning (originalfilen och offline-filen) kräver rättigheten (perms.js)
    if (/\/(offline-file|download)$/.test(p) && !canDownload(c.user.id)) { fail(c.res, 403, 'Ditt konto får inte ladda ner'); return null; }
    // Kvalitetstak utanför hemmet per användare: strömmar över taket nekas även om klienten ber om dem direkt
    const cap = !isLocalReq(c.req) && permsOf(c.user.id).remoteQuality;
    if (cap && /\/(direct|hls\/[^/]+)$/.test(p) && st.exceedsQuality(it, c.q, cap, /\/direct$/.test(p))) { fail(c.res, 403, `Ditt konto får titta i högst ${cap}p utanför hemmet`); return null; }
    // "Spelas nu" och admins stopp gäller filmen (huvudraden), även när en annan version strömmas
    if (act.isStopped(c.user.id, ver.mainIdOf(it))) { fail(c.res, 403, 'Uppspelningen stoppades av administratören'); return null; }
    // Skärmtid: strömmar nekas när tiden är slut (nedladdningar för offline räknas inte som tittande)
    if (!/\/(offline-file|download)$/.test(p) && screenBlock(c)) return null;
    act.touch(c.user.id, ver.mainIdOf(it));
  }
  return it;
};

// ---------- Skärmtid ----------
/** Neka med skärmtidens förklaring. Returnerar true om förfrågan nekades. audio: ljud (musik/böcker/poddar) */
export function screenBlock(c, opts) {
  const s = screen.check(c.user.id, opts);
  if (s) send(c.res, 403, { error: s.message, code: 'screen_time', screenTime: s });
  return !!s;
}
