// Egna betyg per profil (som Plex): 1–5 stjärnor i halva steg för filmer, serier, avsnitt, album och låtar.
// Lagras som antal halva stjärnor (2–10) i item_ratings/album_ratings/track_ratings (db.js) – samma skala som Trakt (1–10).
// API:t talar stjärnor (1, 1.5 … 5; 0 eller null = ta bort). Filmversioner betygsätts på huvudraden.
// Betygen syns i listorna (userRating i http/context.js), bibliotekets filter/sortering (libfilter.js), smarta
// spellistor (smartlists.js), musikapparna (Subsonic userRating/setRating) och skickas till Trakt om kontot är kopplat.
import { get, all, run, now } from './db.js';

const TABLES = { item: ['item_ratings', 'item_id'], album: ['album_ratings', 'album_id'], track: ['track_ratings', 'track_id'] };
const tbl = (kind) => { const t = TABLES[kind]; if (!t) throw new Error('okänd betygstyp'); return t; };

/** Stjärnor från klienten → halva stjärnor (2–10), 0 = ta bort, null = ogiltigt */
export function parseStars(v) {
  if (v == null || v === '' || v === 0 || v === '0') return 0;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d(\.\d{1,2})?$/.test(v.trim()) ? +v : NaN;
  if (!Number.isFinite(n)) return null;
  const h = n * 2;
  return Number.isInteger(h) && h >= 2 && h <= 10 ? h : null;
}
/** Halva stjärnor → stjärnor (undefined när inget betyg finns, så att fältet inte skickas) */
export const toStars = (h) => h ? h / 2 : undefined;
/** Subsonic (heltal 1–5) */
export const toSubsonic = (h) => h ? Math.max(1, Math.min(5, Math.round(h / 2))) : undefined;

/** Sätter (half 2–10) eller tar bort (0) betyget. Returnerar det nya värdet i halva stjärnor (0 = inget). */
export function set(uid, kind, id, half) {
  const [t, c] = tbl(kind);
  if (!half) { run(`DELETE FROM ${t} WHERE user_id=? AND ${c}=?`, uid, id); return 0; }
  run(`INSERT INTO ${t}(user_id,${c},value,updated) VALUES(?,?,?,?) ON CONFLICT(user_id,${c}) DO UPDATE SET value=excluded.value, updated=excluded.updated`, uid, id, half, now());
  return half;
}
/** Betyget i halva stjärnor (0 = inget) */
export function getOne(uid, kind, id) {
  const [t, c] = tbl(kind);
  return get(`SELECT value FROM ${t} WHERE user_id=? AND ${c}=?`, uid, id)?.value || 0;
}
/** Betygen för id:n (Map id → halva stjärnor) */
export function mapFor(uid, kind, ids) {
  const [t, c] = tbl(kind), out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    if (!part.length) continue;
    for (const r of all(`SELECT ${c} AS id, value FROM ${t} WHERE user_id=? AND ${c} IN (${part.map(() => '?').join(',')})`, uid, ...part)) out.set(r.id, r.value);
  }
  return out;
}
/** Lägger userRating (stjärnor) på objekt med id (låtar/album i musik-API:t) */
export function annotate(uid, kind, list) {
  const m = mapFor(uid, kind, list.map(x => x.id));
  for (const x of list) { const v = m.get(x.id); if (v) x.userRating = v / 2; }
  return list;
}
/** Alla profilens titelbetyg med det Trakt behöver (för synken) */
export const itemRatingsFor = (uid) => all(`SELECT r.value, r.updated, i.id, i.kind, i.tmdb_id, i.title, i.year, i.season, i.episode, i.parent_id,
  s.tmdb_id AS show_tmdb, s.title AS show_title, s.year AS show_year FROM item_ratings r JOIN items i ON i.id=r.item_id LEFT JOIN items s ON s.id=i.parent_id
  WHERE r.user_id=?`, uid);
