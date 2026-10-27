// Filmer och serier från Xtream-källor (iptv_vod/iptv_episodes) som tittaren ser: hyllor per kategori, sökning,
// detaljer (hämtas från leverantören första gången), avsnitt och var man var. Leverantörerna anger sällan någon
// åldersgräns: barnprofiler ser bara kategorier som administratören gett en åldersgräns inom profilens (eller allt
// oklassat om allow_unrated är på) – vuxenkategorier (namnet) får 18 automatiskt.
import { all, get, run, now, getSetting } from '../db.js';
import { ranked } from '../search.js';
import { parseQuery } from '../searchkey.js';
import { ageOk } from './channels.js';
import { sourceRow, ctxOf } from './sources.js';
import * as xt from './xtream.js';

const allowUnrated = () => getSetting('allow_unrated', '0') === '1';
const JOIN = `FROM iptv_vod v JOIN tuners t ON t.id=v.tuner_id LEFT JOIN iptv_sources s ON s.tuner_id=t.id
  LEFT JOIN iptv_groups g ON g.kind=v.kind AND g.name=v.category`;
const VIS = `t.enabled=1 AND COALESCE(s.vod, 1)=1 AND COALESCE(g.hidden, 0)=0`;
/** Barnprofiler: villkoret i SQL (åldersgränsen på kategorin) */
const ageWhere = (u) => u.max_age == null ? ['1', []] : allowUnrated() ? ['(g.age IS NULL OR g.age <= ?)', [u.max_age]] : ['(g.age IS NOT NULL AND g.age <= ?)', [u.max_age]];
export const vodAllowed = (u) => u.max_age == null || allowUnrated() || !!get("SELECT 1 FROM iptv_groups WHERE kind IN ('movie','series') AND hidden=0 AND age IS NOT NULL AND age <= ? LIMIT 1", u.max_age);

const card = (r) => ({ id: r.id, kind: r.kind, name: r.name, year: r.year, rating: r.rating, category: r.category, cover: !!r.cover,
  progress: r.pos ? { position: r.pos, duration: r.pdur, watched: !!r.pw } : undefined });
const COLS = (u) => [`v.id, v.kind, v.name, v.year, v.rating, v.category, v.cover, p.position AS pos, p.duration AS pdur, p.watched AS pw`,
  `LEFT JOIN iptv_vod_progress p ON p.user_id=${+u.id} AND p.kind='movie' AND p.ref_id=v.id`];

export function categories(u, kind) {
  const [aw, ap] = ageWhere(u);
  return all(`SELECT v.category AS name, COUNT(*) AS count, g.sort ${JOIN} WHERE v.kind=? AND ${VIS} AND ${aw} GROUP BY v.category ORDER BY COALESCE(g.sort, 1e9), MIN(v.id)`, kind, ...ap)
    .map(r => ({ name: r.name, count: r.count }));
}
/** Lista: kind, category, q (sökning), sort (added|name|rating|year), offset, limit */
export function list(u, { kind = 'movie', category = null, q = '', sort = 'added', offset = 0, limit = 60 } = {}) {
  const [aw, ap] = ageWhere(u);
  const [cols, pj] = COLS(u);
  limit = Math.max(1, Math.min(200, limit | 0)); offset = Math.max(0, offset | 0);
  if (q) {
    const rows = ranked({ from: `${JOIN} ${pj}`, cols: `${cols}, v.name AS _t`, key: 'v.skey', pop: 'v.added', where: `v.kind=? AND ${VIS} AND ${aw}`, params: [kind, ...ap] }, parseQuery(q), limit);
    return { items: rows.map(card), total: rows.length };
  }
  const where = `v.kind=? AND ${VIS} AND ${aw}${category != null ? ' AND v.category IS ?' : ''}`;
  const params = [kind, ...ap, ...(category != null ? [category || null] : [])];
  const order = { name: 'v.name COLLATE NOCASE', rating: 'v.rating DESC NULLS LAST, v.name', year: 'v.year DESC NULLS LAST, v.name', added: 'v.added DESC NULLS LAST, v.id DESC' }[sort] || 'v.added DESC, v.id DESC';
  return { items: all(`SELECT ${cols} ${JOIN} ${pj} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset).map(card),
    total: get(`SELECT COUNT(*) AS n ${JOIN} WHERE ${where}`, ...params).n };
}
/** Hyllor: Fortsätt titta, Senast tillagda och de största kategorierna */
export function shelves(u, kind) {
  const [aw, ap] = ageWhere(u);
  const [cols, pj] = COLS(u);
  const out = [];
  if (kind === 'movie') {
    const cont = all(`SELECT ${cols} ${JOIN} JOIN iptv_vod_progress p ON p.user_id=? AND p.kind='movie' AND p.ref_id=v.id
      WHERE v.kind='movie' AND ${VIS} AND ${aw} AND p.watched=0 AND p.position > 60 ORDER BY p.updated DESC LIMIT 20`, u.id, ...ap).map(card);
    if (cont.length) out.push({ key: 'continue', title: 'Fortsätt titta', items: cont });
  } else {
    const cont = all(`SELECT v.id, v.kind, v.name, v.year, v.rating, v.category, v.cover FROM iptv_vod v JOIN tuners t ON t.id=v.tuner_id LEFT JOIN iptv_sources s ON s.tuner_id=t.id
      LEFT JOIN iptv_groups g ON g.kind=v.kind AND g.name=v.category
      WHERE v.kind='series' AND ${VIS} AND ${aw} AND v.id IN (SELECT e.vod_id FROM iptv_vod_progress p JOIN iptv_episodes e ON e.id=p.ref_id WHERE p.user_id=? AND p.kind='episode')
      ORDER BY (SELECT MAX(p.updated) FROM iptv_vod_progress p JOIN iptv_episodes e ON e.id=p.ref_id WHERE p.user_id=? AND p.kind='episode' AND e.vod_id=v.id) DESC LIMIT 20`, ...ap, u.id, u.id).map(card);
    if (cont.length) out.push({ key: 'continue', title: 'Fortsätt titta', items: cont });
  }
  out.push({ key: 'added', title: 'Senast tillagt', items: list(u, { kind, sort: 'added', limit: 24 }).items });
  for (const c of categories(u, kind).slice(0, 14)) out.push({ key: 'cat', category: c.name, title: c.name || 'Övrigt', count: c.count, items: list(u, { kind, category: c.name ?? '', sort: 'added', limit: 24 }).items });
  return out.filter(s => s.items.length);
}

/** En film eller serie som profilen får se (med kategorins regler), annars null */
export function visible(u, id) {
  const [aw, ap] = ageWhere(u);
  return get(`SELECT v.* ${JOIN} WHERE v.id=? AND ${VIS} AND ${aw}`, id, ...ap) || null;
}
/** Detaljer: hämtar handling/avsnitt från leverantören första gången (och serier igen efter ett dygn) */
export async function detail(u, id) {
  let v = visible(u, id); if (!v) return null;
  const r = sourceRow(v.tuner_id);
  const stale = v.kind === 'series' && (!v.info || !get('SELECT 1 FROM iptv_episodes WHERE vod_id=? LIMIT 1', v.id));
  if (r && (!v.info || stale)) {
    try { v.kind === 'movie' ? await xt.movieInfo(v, ctxOf(r)) : await xt.seriesInfo(v, ctxOf(r)); }
    catch (e) { console.warn('[iptv] vod-info:', e.message); }
    v = visible(u, id) || v;
  }
  const out = { id: v.id, kind: v.kind, name: v.name, category: v.category, cover: !!v.cover, backdrop: !!v.backdrop, plot: v.plot, year: v.year, rating: v.rating,
    genre: v.genre, cast: v.cast_list, director: v.director, duration: v.duration, tmdb: v.tmdb, source: r?.t.name || null };
  if (v.kind === 'movie') {
    const p = get("SELECT position, duration, watched FROM iptv_vod_progress WHERE user_id=? AND kind='movie' AND ref_id=?", u.id, v.id);
    out.progress = p ? { position: p.position, duration: p.duration, watched: !!p.watched } : null;
  } else {
    const eps = all(`SELECT e.id, e.season, e.episode, e.title, e.plot, e.duration, e.image, p.position, p.duration AS pdur, p.watched FROM iptv_episodes e
      LEFT JOIN iptv_vod_progress p ON p.user_id=? AND p.kind='episode' AND p.ref_id=e.id WHERE e.vod_id=? ORDER BY e.season, e.episode, e.id`, u.id, v.id);
    out.episodes = eps.map(e => ({ id: e.id, season: e.season, episode: e.episode, title: e.title, plot: e.plot, duration: e.duration, image: !!e.image,
      progress: e.position ? { position: e.position, duration: e.pdur, watched: !!e.watched } : null }));
  }
  return out;
}
/** Det som behövs för att spela en film eller ett avsnitt (adressen innehåller inloggningen – lämnas aldrig ut) */
export function playable(u, kind, id) {
  let v, ep = null;
  if (kind === 'episode') {
    ep = get('SELECT * FROM iptv_episodes WHERE id=?', id); if (!ep) return null;
    v = visible(u, ep.vod_id);
  } else v = visible(u, id);
  if (!v || (kind === 'movie' && v.kind !== 'movie')) return null;
  const r = sourceRow(v.tuner_id); if (!r || r.s.type !== 'xtream') return null;
  const c = ctxOf(r);
  const ext = (kind === 'episode' ? ep.ext : v.ext) || 'mp4';
  return { url: kind === 'episode' ? xt.episodeUrl(c, ep.ext_id, ext) : xt.movieUrl(c, v.ext_id, ext), ext, headers: c.headers, pol: c.pol, tunerId: v.tuner_id,
    duration: (kind === 'episode' ? ep.duration : v.duration) || null, title: kind === 'episode' ? `${v.name}${ep.season ? ` S${ep.season}` : ''}${ep.episode ? `E${ep.episode}` : ''}${ep.title && ep.title !== v.name ? ' – ' + ep.title : ''}` : v.name,
    cover: kind === 'episode' && ep.image ? ep.image : v.cover, backdrop: v.backdrop };
}
export function saveProgress(u, kind, id, position, duration) {
  position = Math.max(0, +position || 0); duration = +duration > 0 ? +duration : null;
  const watched = duration && position / duration > 0.92 ? 1 : 0;
  run(`INSERT INTO iptv_vod_progress(user_id, kind, ref_id, position, duration, watched, updated) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(user_id, kind, ref_id) DO UPDATE SET position=excluded.position, duration=COALESCE(excluded.duration, duration), watched=excluded.watched, updated=excluded.updated`,
  u.id, kind, id, watched ? 0 : position, duration, watched, now());
}
/** Bildadress för omslag/bakgrund/avsnittsbild (bara för det profilen får se) */
export function imageUrl(u, kind, id) {
  if (kind === 'episode') { const e = get('SELECT vod_id, image FROM iptv_episodes WHERE id=?', id); return e && visible(u, e.vod_id) ? e.image : null; }
  const v = visible(u, id); return v ? (kind === 'backdrop' ? v.backdrop : v.cover) : null;
}
