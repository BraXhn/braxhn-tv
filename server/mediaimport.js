// Import av tittarhistorik (sett/framsteg) från Plex och Jellyfin/Emby.
// Matchning: 1) TMDB/IMDb/TVDB-id, 2) filsökväg (med valfri sökvägsmappning), 3) titel + år / säsong + avsnitt.
// Förhandsvisningen hämtar och matchar; importen skriver sedan in resultatet på valda användare.
import crypto from 'node:crypto';
import path from 'node:path';
import { get, all, run, tx, now } from './db.js';
import { tmdb, hasTmdb } from './scanner.js';

const TIMEOUT = 30000;          // per anrop
const MAX_BYTES = 200 * 1024 * 1024;
const PAGE = 1000;

// ---------- hämtning ----------
async function readCapped(r) {
  const len = +r.headers.get('content-length') || 0;
  if (len > MAX_BYTES) throw new Error('Svaret är för stort');
  const chunks = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > MAX_BYTES) throw new Error('Svaret är för stort'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
async function getJson(name, url, headers) {
  let r;
  try { r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) }); }
  catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`${name} svarade inte i tid`);
    throw new Error(`Kunde inte nå ${name} – kontrollera adress och port (${e.cause?.code || e.message})`);
  }
  if (r.status === 401 || r.status === 403) { r.body?.cancel().catch(() => {}); throw new Error(`${name} nekade åtkomst – kontrollera token/API-nyckel`); }
  if (!r.ok) { r.body?.cancel().catch(() => {}); throw new Error(`${name} svarade ${r.status}`); }
  const text = await readCapped(r);
  try { return JSON.parse(text); } catch { throw new Error(`${name} skickade inget giltigt JSON-svar – är adressen rätt?`); }
}
export function checkUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(s)) throw Object.assign(new Error('Ange adressen som t.ex. http://192.168.1.10:32400'), { status: 400 });
  return s;
}
const int = (v) => { const n = parseInt(v); return Number.isFinite(n) ? n : null; };

// ---------- Plex ----------
/** Plex-guid: nya agenter har Guid: [{ id: 'tmdb://123' }], äldre guid: 'com.plexapp.agents.imdb://tt123?lang=en' */
export function plexIds(m) {
  const ids = {};
  const add = (g) => {
    const x = /^(?:com\.plexapp\.agents\.)?(tmdb|themoviedb|imdb|tvdb|thetvdb):\/\/([^?/]+)/i.exec(String(g || ''));
    if (!x) return;
    const k = { themoviedb: 'tmdb', thetvdb: 'tvdb' }[x[1].toLowerCase()] || x[1].toLowerCase();
    if (!ids[k]) ids[k] = x[2];
  };
  for (const g of m.Guid || []) add(g.id);
  add(m.guid);
  return ids;
}
const plexFile = (m) => m.Media?.[0]?.Part?.[0]?.file || null;

export async function fetchPlex({ url, token }) {
  const base = checkUrl(url);
  if (!token) throw Object.assign(new Error('Ange X-Plex-Token'), { status: 400 });
  const H = { 'X-Plex-Token': String(token).trim(), 'X-Plex-Client-Identifier': 'braxhn-tv-import', 'X-Plex-Product': 'BraXhn TV' };
  const sections = (await getJson('Plex', `${base}/library/sections`, H)).MediaContainer?.Directory || [];
  const list = async (key, type) => {
    const out = [];
    for (let start = 0; start < 1e6; start += PAGE) {
      const mc = (await getJson('Plex', `${base}/library/sections/${encodeURIComponent(key)}/all?type=${type}&includeGuids=1&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}`, H)).MediaContainer || {};
      const md = mc.Metadata || [];
      out.push(...md);
      if (md.length < PAGE || (mc.totalSize != null && out.length >= mc.totalSize)) break;
    }
    return out;
  };
  const records = [];
  const seen = (m) => (+m.viewCount || 0) > 0 || (+m.viewOffset || 0) > 0;
  const common = (m) => ({ watched: (+m.viewCount || 0) > 0, position: (+m.viewOffset || 0) / 1000, duration: (+m.duration || 0) / 1000, updated: int(m.lastViewedAt) || null });
  for (const s of sections) {
    if (s.type === 'movie') {
      for (const m of await list(s.key, 1)) if (seen(m))
        records.push({ kind: 'movie', title: m.title, year: int(m.year), ids: plexIds(m), path: plexFile(m), ...common(m) });
    } else if (s.type === 'show') {
      const shows = new Map((await list(s.key, 2)).map(x => [String(x.ratingKey), { title: x.title, year: int(x.year), ids: plexIds(x), path: x.Location?.[0]?.path || null }]));
      for (const m of await list(s.key, 4)) if (seen(m)) {
        const show = shows.get(String(m.grandparentRatingKey)) || { title: m.grandparentTitle, year: null, ids: {}, path: null };
        records.push({ kind: 'episode', title: m.title, year: int(m.year), ids: {}, path: plexFile(m), show, season: int(m.parentIndex), episode: int(m.index), ...common(m) });
      }
    }
  }
  return records;
}

// ---------- Jellyfin / Emby ----------
const jfHeaders = (key) => ({ 'X-Emby-Token': key, Authorization: `MediaBrowser Client="BraXhn TV", Device="import", DeviceId="braxhn-tv-import", Version="1", Token="${key}"` });
export async function jellyfinUsers({ url, apiKey }) {
  const base = checkUrl(url);
  if (!apiKey) throw Object.assign(new Error('Ange API-nyckel'), { status: 400 });
  const users = await getJson('Jellyfin', `${base}/Users`, jfHeaders(String(apiKey).trim()));
  return (Array.isArray(users) ? users : []).map(u => ({ id: String(u.Id), name: String(u.Name || '') }));
}
const jfIds = (p = {}) => {
  const ids = {};
  for (const [k, v] of Object.entries(p || {})) { const kk = k.toLowerCase(); if (['tmdb', 'imdb', 'tvdb'].includes(kk) && v) ids[kk] = String(v); }
  return ids;
};
export async function fetchJellyfin({ url, apiKey, user }) {
  const base = checkUrl(url);
  const users = await jellyfinUsers({ url: base, apiKey });
  const want = String(user || '').trim().toLowerCase();
  if (!want) throw Object.assign(new Error('Välj vilken Jellyfin-användares historik som ska importeras'), { status: 400, users });
  const u = users.find(x => x.name.toLowerCase() === want || x.id.toLowerCase() === want);
  if (!u) throw Object.assign(new Error('Användaren finns inte i Jellyfin'), { status: 400, users });
  const H = jfHeaders(String(apiKey).trim());
  const items = async (q) => {
    const out = [];
    for (let start = 0; start < 1e6; start += PAGE) {
      const r = await getJson('Jellyfin', `${base}/Users/${encodeURIComponent(u.id)}/Items?Recursive=true&${q}&EnableUserData=true&StartIndex=${start}&Limit=${PAGE}`, H);
      const list = r.Items || [];
      out.push(...list);
      if (list.length < PAGE || (r.TotalRecordCount != null && out.length >= r.TotalRecordCount)) break;
    }
    return out;
  };
  const F = 'Fields=ProviderIds,Path,ProductionYear';
  const played = await items(`IncludeItemTypes=Movie,Episode&Filters=IsPlayed&${F}`);
  const resumable = await items(`IncludeItemTypes=Movie,Episode&Filters=IsResumable&${F}`);
  const byId = new Map([...played, ...resumable].map(x => [String(x.Id), x]));
  const needShows = [...new Set([...byId.values()].filter(x => x.Type === 'Episode' && x.SeriesId).map(x => String(x.SeriesId)))];
  const shows = new Map();
  for (let i = 0; i < needShows.length; i += 100) {
    for (const s of await items(`IncludeItemTypes=Series&Ids=${needShows.slice(i, i + 100).map(encodeURIComponent).join(',')}&${F}`))
      shows.set(String(s.Id), { title: s.Name, year: int(s.ProductionYear), ids: jfIds(s.ProviderIds), path: s.Path || null });
  }
  const records = [];
  for (const x of byId.values()) {
    const ud = x.UserData || {};
    const c = { watched: !!ud.Played, position: (+ud.PlaybackPositionTicks || 0) / 1e7, duration: (+x.RunTimeTicks || 0) / 1e7,
      updated: ud.LastPlayedDate ? Math.floor(Date.parse(ud.LastPlayedDate) / 1000) || null : null };
    if (x.Type === 'Movie') records.push({ kind: 'movie', title: x.Name, year: int(x.ProductionYear), ids: jfIds(x.ProviderIds), path: x.Path || null, ...c });
    else if (x.Type === 'Episode') {
      const show = shows.get(String(x.SeriesId)) || { title: x.SeriesName, year: null, ids: {}, path: null };
      records.push({ kind: 'episode', title: x.Name, year: int(x.ProductionYear), ids: jfIds(x.ProviderIds), path: x.Path || null, show,
        season: int(x.ParentIndexNumber), episode: int(x.IndexNumber), ...c });
    }
  }
  return records;
}

// ---------- matchning ----------
/** "från=till" per rad eller kommaseparerat, t.ex. /data/movies=/media/Filmer. Längsta prefixet vinner. */
export function parsePathMap(s) {
  return String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf('=');
    return i > 0 ? { from: x.slice(0, i).trim().replace(/\\/g, '/').replace(/\/+$/, ''), to: x.slice(i + 1).trim().replace(/\/+$/, '') } : null;
  }).filter(m => m && m.from).sort((a, b) => b.from.length - a.from.length);
}
export function mapPath(p, map) {
  if (!p) return null;
  const s = String(p).replace(/\\/g, '/');
  for (const m of map) if (s === m.from || s.startsWith(m.from + '/')) return m.to + s.slice(m.from.length);
  return s;
}
export const normTitle = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

/** IMDb/TVDB → TMDB via TMDB:s /find (bara med TMDB-nyckel, begränsat antal uppslag) */
async function resolveExternal(records, limit = 400) {
  if (!hasTmdb()) return;
  const cache = new Map();
  const want = [];
  for (const r of records) {
    const o = r.kind === 'movie' ? r.ids : r.show?.ids;
    if (!o || o.tmdb) continue;
    const src = o.imdb ? ['imdb_id', o.imdb] : o.tvdb ? ['tvdb_id', o.tvdb] : null;
    if (src) want.push([o, src, r.kind === 'movie' ? 'movie_results' : 'tv_results']);
  }
  let n = 0;
  for (const [o, [src, id], field] of want) {
    const k = `${src}:${id}:${field}`;
    if (!cache.has(k)) {
      if (n++ >= limit) break;
      try { cache.set(k, (await tmdb(`/find/${encodeURIComponent(id)}`, { external_source: src }))[field]?.[0]?.id || null); } catch { cache.set(k, null); }
    }
    if (cache.get(k)) o.tmdb = String(cache.get(k));
  }
}

function indexes() {
  const rows = all("SELECT id, kind, title, year, tmdb_id, path, parent_id, season, episode, src_name FROM items WHERE kind IN ('movie','show','episode')");
  const ix = { movieTmdb: new Map(), showTmdb: new Map(), path: new Map(), base: new Map(), movieTitle: new Map(), showTitle: new Map(), ep: new Map() };
  const push = (m, k, v) => { const a = m.get(k); a ? a.push(v) : m.set(k, [v]); };
  for (const r of rows) {
    if (r.kind === 'movie') {
      if (r.tmdb_id) ix.movieTmdb.set(String(r.tmdb_id), r.id);
      push(ix.movieTitle, normTitle(r.title), r);
    } else if (r.kind === 'show') {
      if (r.tmdb_id) ix.showTmdb.set(String(r.tmdb_id), r.id);
      push(ix.showTitle, normTitle(r.title), r);
      if (r.src_name && normTitle(r.src_name) !== normTitle(r.title)) push(ix.showTitle, normTitle(r.src_name.replace(/\s*\(\d{4}\)$/, '')), r);
    } else {
      ix.ep.set(`${r.parent_id}:${r.season}:${r.episode}`, r.id);
    }
    if (r.path && r.kind !== 'show') { ix.path.set(r.path, r.id); push(ix.base, path.basename(r.path).toLowerCase(), r.id); }
  }
  return ix;
}
const byYear = (cands, year) => {
  if (!cands?.length) return null;
  if (year) {
    const exact = cands.filter(c => c.year === year);
    if (exact.length === 1) return exact[0];
    const near = cands.filter(c => c.year && Math.abs(c.year - year) <= 1);
    if (near.length === 1) return near[0];
    return cands.length === 1 && !cands[0].year ? cands[0] : null;
  }
  return cands.length === 1 ? cands[0] : null;
};

/** Matchar poster mot biblioteket. Returnerar posterna med itemId och method ('id' | 'path' | 'title' | null). */
export async function matchRecords(records, { pathMap = '' } = {}) {
  await resolveExternal(records);
  const map = parsePathMap(pathMap);
  const ix = indexes();
  const byPath = (p) => {
    const mp = mapPath(p, map);
    if (!mp) return null;
    if (ix.path.has(mp)) return ix.path.get(mp);
    const b = ix.base.get(path.basename(mp).toLowerCase());
    return b?.length === 1 ? b[0] : null; // samma filnamn på ett enda ställe
  };
  for (const r of records) {
    let id = null, method = null;
    if (r.kind === 'movie') {
      if (r.ids?.tmdb && ix.movieTmdb.has(String(r.ids.tmdb))) { id = ix.movieTmdb.get(String(r.ids.tmdb)); method = 'id'; }
      else if ((id = byPath(r.path))) method = 'path';
      else if ((id = byYear(ix.movieTitle.get(normTitle(r.title)), r.year)?.id || null)) method = 'title';
    } else if (r.season != null && r.episode != null) {
      const ep = (showId) => showId ? ix.ep.get(`${showId}:${r.season}:${r.episode}`) || null : null;
      const sid = r.show?.ids?.tmdb ? ix.showTmdb.get(String(r.show.ids.tmdb)) : null;
      if ((id = ep(sid))) method = 'id';
      else if ((id = byPath(r.path))) method = 'path';
      else if ((id = ep(byYear(ix.showTitle.get(normTitle(r.show?.title)), r.show?.year)?.id))) method = 'title';
    } else if ((id = byPath(r.path))) method = 'path';
    r.itemId = id || null; r.method = id ? method : null;
  }
  return records;
}

// ---------- förhandsvisning och import ----------
const previews = new Map(); // id → { at, source, records }
const TTL = 30 * 60e3;
function prune() {
  for (const [k, v] of previews) if (Date.now() - v.at > TTL) previews.delete(k);
  while (previews.size > 3) previews.delete(previews.keys().next().value);
}
export function summarize(records) {
  const by = { id: 0, path: 0, title: 0 };
  for (const r of records) if (r.method) by[r.method]++;
  const label = (r) => r.kind === 'episode' ? `${r.show?.title || '?'} S${String(r.season ?? '?').padStart(2, '0')}E${String(r.episode ?? '?').padStart(2, '0')}` : `${r.title}${r.year ? ` (${r.year})` : ''}`;
  const matched = records.filter(r => r.itemId);
  return {
    total: records.length, matched: matched.length, unmatched: records.length - matched.length, byMethod: by,
    watched: matched.filter(r => r.watched).length, inProgress: matched.filter(r => !r.watched && r.position > 0).length,
    unmatchedSample: records.filter(r => !r.itemId).slice(0, 50).map(r => ({ kind: r.kind, title: String(label(r)).slice(0, 200), path: r.path ? String(r.path).slice(0, 300) : null }))
  };
}
export async function preview({ source, url, token, apiKey, user, pathMap }) {
  let records;
  if (source === 'plex') records = await fetchPlex({ url, token });
  else if (source === 'jellyfin') records = await fetchJellyfin({ url, apiKey, user });
  else throw Object.assign(new Error('Välj Plex eller Jellyfin/Emby'), { status: 400 });
  await matchRecords(records, { pathMap });
  prune();
  const id = crypto.randomBytes(12).toString('hex');
  previews.set(id, { at: Date.now(), source, records });
  return { id, source, ...summarize(records) };
}

/**
 * Skriv in matchad historik på användarna. Sedda titlar markeras som sedda (en sedd titel avmarkeras aldrig);
 * påbörjade får sin position om de inte redan är sedda här och importens tid är nyare (eller overwrite).
 */
export function applyRecords(records, userIds, { overwrite = false } = {}) {
  const res = { watched: 0, progress: 0, skipped: 0, users: 0 };
  const t = now();
  tx(() => {
    for (const uid of userIds) {
      if (!get('SELECT 1 FROM users WHERE id=?', uid)) continue;
      res.users++;
      for (const r of records) {
        if (!r.itemId) continue;
        const it = get('SELECT id, duration FROM items WHERE id=?', r.itemId);
        if (!it) { res.skipped++; continue; }
        const dur = it.duration || r.duration || null;
        const when = Math.min(t, r.updated || t);
        const prev = get('SELECT watched, position, updated FROM progress WHERE user_id=? AND item_id=?', uid, it.id);
        if (r.watched) {
          if (prev?.watched) { res.skipped++; continue; }
          run(`INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,0,?,1,?)
            ON CONFLICT(user_id,item_id) DO UPDATE SET position=0, watched=1, duration=COALESCE(excluded.duration, duration), updated=excluded.updated`, uid, it.id, dur, when);
          res.watched++;
        } else if (r.position >= 30) {
          if (prev?.watched || (prev && prev.position > 0 && !overwrite && (prev.updated || 0) >= when)) { res.skipped++; continue; }
          run(`INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,0,?)
            ON CONFLICT(user_id,item_id) DO UPDATE SET position=excluded.position, duration=COALESCE(excluded.duration, duration), updated=excluded.updated`, uid, it.id, r.position, dur, when);
          res.progress++;
        } else res.skipped++;
      }
    }
  });
  return res;
}
export function runImport(id, userIds, opts = {}) {
  const p = previews.get(String(id || ''));
  if (!p || Date.now() - p.at > TTL) throw Object.assign(new Error('Förhandsvisningen har gått ut – gör om den'), { status: 410 });
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw Object.assign(new Error('Välj minst en användare'), { status: 400 });
  const r = applyRecords(p.records, ids, opts);
  previews.delete(String(id));
  return { ...r, source: p.source };
}
