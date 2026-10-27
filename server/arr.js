// Sonarr/Radarr: direkt skanning via webhook och önskemål av filmer/serier som skickas vidare till *arr.
import crypto from 'node:crypto';
import path from 'node:path';
import { db, get, all, run, now, getSetting, setSetting } from './db.js';
import { notify } from './notify.js';
import { librariesWithRoots } from './libpaths.js';

db.exec(`CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, user_name TEXT,
  kind TEXT NOT NULL CHECK(kind IN('movie','show')), tmdb_id INTEGER NOT NULL, title TEXT NOT NULL, year INTEGER, poster TEXT, overview TEXT,
  status TEXT NOT NULL DEFAULT 'pending', note TEXT, created INTEGER NOT NULL, updated INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS requests_tmdb ON requests(kind, tmdb_id);`);

// ---------- webhook ----------
export function webhookKey() {
  let k = getSetting('arr_webhook_key');
  if (!k) { k = crypto.randomBytes(24).toString('base64url'); setSetting('arr_webhook_key', k); }
  return k;
}
export const checkKey = (k) => { const a = Buffer.from(String(k || '')), b = Buffer.from(webhookKey()); return a.length === b.length && crypto.timingSafeEqual(a, b); };

/** Översätt *arr-sökväg till containerns (t.ex. /tv → /media/Serier). Format: "/tv=/media/Serier,/movies=/media/Filmer" */
export function mapPath(p) {
  if (!p) return null;
  for (const pair of getSetting('arr_path_map', process.env.ARR_PATH_MAP || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [from, to] = pair.split('=').map(s => s?.trim().replace(/\/+$/, ''));
    if (from && to && (p === from || p.startsWith(from + '/'))) return to + p.slice(from.length);
  }
  return p;
}

/** Tolka en webhook från Sonarr/Radarr → vilket bibliotek ska skannas. Returnerar { event, libIds, title } */
export function parseWebhook(body) {
  const ev = String(body?.eventType || '');
  const folder = body?.series?.path || body?.movie?.folderPath || body?.movie?.path || null;
  const file = body?.episodeFile?.relativePath || body?.movieFile?.relativePath || null;
  const mapped = mapPath(folder && file ? path.posix.join(folder, file) : folder);
  const libs = librariesWithRoots("type IN ('movie','show')");
  const hit = mapped ? libs.filter(l => l.roots.some(r => mapped === r || mapped.startsWith(r + '/'))) : [];
  const title = body?.series?.title || body?.movie?.title || null;
  // Okänd sökväg: skanna alla video-bibliotek (skanningen är inkrementell och snabb)
  return { event: ev, libIds: (hit.length ? hit : libs).map(l => l.id), title, path: mapped, tmdbId: body?.movie?.tmdbId || body?.series?.tmdbId || null };
}
export const SCAN_EVENTS = /^(Download|Rename|MovieFileDelete|EpisodeFileDelete|MovieDelete|SeriesDelete|MovieAdded|SeriesAdd)$/;

// ---------- Radarr/Sonarr-API ----------
const conf = (kind) => kind === 'movie'
  ? { url: getSetting('radarr_url', process.env.RADARR_URL || ''), key: getSetting('radarr_key', process.env.RADARR_API_KEY || ''), profile: +getSetting('radarr_profile', '0'), root: getSetting('radarr_root', '') }
  : { url: getSetting('sonarr_url', process.env.SONARR_URL || ''), key: getSetting('sonarr_key', process.env.SONARR_API_KEY || ''), profile: +getSetting('sonarr_profile', '0'), root: getSetting('sonarr_root', '') };
export const configured = (kind) => { const c = conf(kind); return !!(c.url && c.key); };

async function arr(kind, p, { method = 'GET', body } = {}) {
  const c = conf(kind);
  if (!c.url || !c.key) throw new Error(`${kind === 'movie' ? 'Radarr' : 'Sonarr'} är inte inställt`);
  const r = await fetch(c.url.replace(/\/+$/, '') + '/api/v3' + p, {
    method, headers: { 'X-Api-Key': c.key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000)
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${kind === 'movie' ? 'Radarr' : 'Sonarr'} ${r.status}: ${Array.isArray(j) ? j.map(e => e.errorMessage).join(', ') : j?.message || String(t).slice(0, 160)}`);
  return j;
}

/** Kvalitetsprofiler och rotmappar för inställningssidan */
export async function options(kind) {
  const [profiles, roots] = await Promise.all([arr(kind, '/qualityprofile'), arr(kind, '/rootfolder')]);
  return { profiles: profiles.map(p => ({ id: p.id, name: p.name })), roots: roots.map(r => ({ path: r.path, free: r.freeSpace })) };
}

/** Skicka en godkänd önskan till Radarr/Sonarr. tvdbOf hämtar TVDB-id från TMDB för serier. */
export async function send(reqRow, tvdbOf) {
  const c = conf(reqRow.kind);
  if (reqRow.kind === 'movie') {
    const m = await arr('movie', `/movie/lookup/tmdb?tmdbId=${+reqRow.tmdb_id}`);
    if (m.id) return { already: true };
    const profile = c.profile || (await arr('movie', '/qualityprofile'))[0]?.id;
    const root = c.root || (await arr('movie', '/rootfolder'))[0]?.path;
    if (!profile || !root) throw new Error('Välj kvalitetsprofil och rotmapp för Radarr');
    await arr('movie', '/movie', { method: 'POST', body: { ...m, qualityProfileId: profile, rootFolderPath: root, monitored: true, minimumAvailability: 'released', addOptions: { searchForMovie: true } } });
    return { added: true };
  }
  const tvdb = await tvdbOf(reqRow.tmdb_id);
  if (!tvdb) throw new Error('Serien saknar TVDB-id (krävs av Sonarr)');
  const found = await arr('show', `/series/lookup?term=${encodeURIComponent('tvdb:' + tvdb)}`);
  const s = found[0];
  if (!s) throw new Error('Sonarr hittade inte serien');
  if (s.id) return { already: true };
  const profile = c.profile || (await arr('show', '/qualityprofile'))[0]?.id;
  const root = c.root || (await arr('show', '/rootfolder'))[0]?.path;
  if (!profile || !root) throw new Error('Välj kvalitetsprofil och rotmapp för Sonarr');
  await arr('show', '/series', { method: 'POST', body: { ...s, qualityProfileId: profile, languageProfileId: 1, rootFolderPath: root, monitored: true, seasonFolder: true,
    seasons: (s.seasons || []).map(x => ({ ...x, monitored: x.seasonNumber > 0 })), addOptions: { monitor: 'all', searchForMissingEpisodes: true } } });
  return { added: true };
}

// ---------- kalender och saknade avsnitt (server/calendar.js) ----------
/** Sonarrs kalender för perioden (YYYY-MM-DD), med serieinformation */
export const sonarrCalendar = (start, end) => arr('show', `/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&includeSeries=true&unmonitored=true`);
/**
 * Be Sonarr söka efter avsnitt som saknas. eps = [{ season, episode }]. Serien slås upp på TMDB-id (Sonarr v4)
 * eller TVDB-id (eller sökvägen). Avsnitt som inte bevakas börjar bevakas, annars hoppar Sonarr över dem.
 */
export async function searchEpisodes({ tmdbId, tvdbId, path: file = null }, eps) {
  const all = await arr('show', '/series');
  // file (valfri): en fil i seriens mapp – serien hittas då även på sökvägen (arr_path_map) när TMDB-id saknas
  const s = (Array.isArray(all) ? all : []).find(x => (tmdbId && x.tmdbId === +tmdbId) || (tvdbId && x.tvdbId === +tvdbId)) || (file ? (Array.isArray(all) ? all : []).find(x => under(x.path, file)) : null);
  if (!s) return { notInSonarr: true, searched: 0 };
  const want = new Set(eps.map(e => `${+e.season}:${+e.episode}`));
  const list = await arr('show', `/episode?seriesId=${+s.id}`);
  const hit = (Array.isArray(list) ? list : []).filter(e => want.has(`${e.seasonNumber}:${e.episodeNumber}`) && !e.hasFile);
  if (!hit.length) return { searched: 0 };
  const ids = hit.map(e => e.id);
  const unmon = hit.filter(e => !e.monitored).map(e => e.id);
  if (unmon.length) await arr('show', '/episode/monitor', { method: 'PUT', body: { episodeIds: unmon, monitored: true } });
  await arr('show', '/command', { method: 'POST', body: { name: 'EpisodeSearch', episodeIds: ids } });
  return { searched: ids.length, series: s.title };
}

// ---------- ny version av en fil (hälsokontrollen, server/health.js) ----------
const under = (p, file) => { const m = mapPath(String(p || '').replace(/\/+$/, '')); return !!(m && file && (file === m || file.startsWith(m + '/'))); };
/** Markera den senaste hämtningen som misslyckad (Radarr/Sonarr spärrar då den releasen). Returnerar 1 om något spärrades. */
async function markFailed(kind, p, pick) {
  const h = await arr(kind, p);
  const rows = (Array.isArray(h) ? h : h?.records || []).filter(r => pick(r) && String(r.eventType).toLowerCase() === 'grabbed');
  rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  if (!rows[0]) return 0;
  await arr(kind, `/history/failed/${+rows[0].id}`, { method: 'POST' });
  return 1;
}
/**
 * Be Radarr/Sonarr söka efter en ny version av en film eller ett avsnitt. Filmen/serien slås upp på TMDB-id (Sonarr v4),
 * TVDB-id eller sökvägen (arr_path_map). blocklist = markera den nuvarande hämtningen som misslyckad först (spärras och
 * hämtas inte igen). Filen tas aldrig bort – Radarr/Sonarr ersätter den bara med en release som profilen godtar.
 */
export async function replaceFile({ kind, tmdbId, tvdbId, path: file, season, episode }, { blocklist = false } = {}) {
  if (kind === 'movie') {
    let list = tmdbId ? await arr('movie', `/movie?tmdbId=${+tmdbId}`) : [];
    let m = (Array.isArray(list) ? list : []).find(x => x.tmdbId === +tmdbId);
    if (!m) { list = await arr('movie', '/movie'); m = (Array.isArray(list) ? list : []).find(x => (tmdbId && x.tmdbId === +tmdbId) || under(x.path || x.folderPath, file)); }
    if (!m) return { notInArr: true };
    const blocked = blocklist ? await markFailed('movie', `/history/movie?movieId=${+m.id}`, () => true) : 0;
    if (!m.monitored) await arr('movie', '/movie/editor', { method: 'PUT', body: { movieIds: [m.id], monitored: true } });
    await arr('movie', '/command', { method: 'POST', body: { name: 'MoviesSearch', movieIds: [m.id] } });
    return { searched: 1, title: m.title, blocked };
  }
  const all = await arr('show', '/series');
  const s = (Array.isArray(all) ? all : []).find(x => (tmdbId && x.tmdbId === +tmdbId) || (tvdbId && x.tvdbId === +tvdbId)) || (Array.isArray(all) ? all : []).find(x => under(x.path, file));
  if (!s) return { notInArr: true };
  const eps = await arr('show', `/episode?seriesId=${+s.id}`);
  const ep = (Array.isArray(eps) ? eps : []).find(e => e.seasonNumber === +season && e.episodeNumber === +episode);
  if (!ep) return { notInArr: true, series: s.title };
  const blocked = blocklist ? await markFailed('show', `/history/series?seriesId=${+s.id}`, (r) => r.episodeId === ep.id) : 0;
  if (!ep.monitored) await arr('show', '/episode/monitor', { method: 'PUT', body: { episodeIds: [ep.id], monitored: true } });
  await arr('show', '/command', { method: 'POST', body: { name: 'EpisodeSearch', episodeIds: [ep.id] } });
  return { searched: 1, series: s.title, blocked };
}

// ---------- önskemål ----------
/** Får användaren göra önskemål? (påslaget, inte barnprofil, och Radarr/Sonarr kopplat eller önskemål utan dem tillåtna) */
export const canRequest = (u) => getSetting('requests_enabled', '1') === '1' && u.max_age == null && (configured('movie') || configured('show') || getSetting('requests_without_arr', '1') === '1');
export function create(user, { kind, tmdbId, title, year, poster, overview }) {
  const ex = get('SELECT * FROM requests WHERE kind=? AND tmdb_id=?', kind, tmdbId);
  if (ex) return { row: ex, existing: true };
  const id = Number(run('INSERT INTO requests(user_id,user_name,kind,tmdb_id,title,year,poster,overview,created) VALUES(?,?,?,?,?,?,?,?,?)',
    user.id, user.name, kind, tmdbId, String(title).slice(0, 200), year || null, poster || null, String(overview || '').slice(0, 500), now()).lastInsertRowid);
  return { row: get('SELECT * FROM requests WHERE id=?', id), existing: false };
}
export const setStatus = (id, status, note = null) => run('UPDATE requests SET status=?, note=?, updated=? WHERE id=?', status, note, now(), id);

/** Efter skanning: markera önskemål som finns i biblioteket */
export function markAvailable() {
  for (const r of all("SELECT * FROM requests WHERE status IN ('pending','approved','sent')")) {
    const hit = get('SELECT id FROM items WHERE tmdb_id=? AND kind=?', r.tmdb_id, r.kind);
    if (hit) {
      setStatus(r.id, 'available');
      notify('request', 'Finns nu att titta på', `${r.title}${r.year ? ` (${r.year})` : ''} som ${r.user_name || 'någon'} önskade finns nu i biblioteket.`);
    }
  }
}
