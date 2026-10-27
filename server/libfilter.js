// Filter, sortering och "Blanda" för film- och seriebibliotek (/api/libraries/:id/items, /facets, /shuffle) och
// smarta samlingar (customcollections.js, typ smart). Som smartlists.js: klientens nycklar slås upp i fasta tabeller
// och bara deras fasta SQL hamnar i frågan – värden blir alltid parametrar (eller kontrollerade heltal), aldrig SQL-text.
//
// Filtret beskrivs som en adressdel (?genre=Drama,Komedi&yearMin=1990&sort=year&order=asc) – samma form i webbadressen
// (#/lib/1?…), i webbläsarens minne och i en smart samlings definition. parse() normaliserar (okänt/ogiltigt tas bort)
// och toQuery() skriver tillbaka i fast ordning.
//
// Fil-egenskaper (upplösning, HDR, ljud, ljud- och undertextspråk) gäller filmens fil eller någon av dess versioner,
// och för serier något avsnitt. Ljud-/undertextspråk, kanaler och Atmos räknas fram ur ffprobe-datat (items.streams)
// och undertextfilerna bredvid filen till kolumnerna items.f_* (f_v = NULL: räknas om; utlösaren i db.js nollställer
// när streams/path ändras, efter varje skanning räknas allt om i bakgrunden).
import { get, all, run, tx, now } from './db.js';
import { ageFilter, PROG, FROM, MAIN_ONLY, listItems } from './http/context.js';
import { streamsOf, subtitlesOf } from './stream.js';
import { langKey } from './playprefs.js';

const DAY = 86400;
export const MAX_LIST = 30;

// ---------- fil-egenskaper (f_*) ----------
export const FACET_V = 1;
const ATMOS = /atmos|dts[:\s-]?x\b/i;
const LANG_RE = /^[a-z]{2,3}$/;
const langSet = (list) => { const s = new Set(); for (const x of list) { const k = langKey(x); if (k && LANG_RE.test(k)) s.add(k); } return s.size ? ',' + [...s].sort().join(',') + ',' : null; };
/** Ljud-/undertextspråk (',sv,en,'), flest kanaler och Atmos/DTS:X för en fil (ren funktion utom undertextfilerna) */
export function facetsOf(it) {
  const st = streamsOf(it), a = st.filter(s => s.type === 'audio');
  let subs = [];
  try { subs = it.path ? subtitlesOf(it) : st.filter(s => s.type === 'subtitle'); } catch { subs = st.filter(s => s.type === 'subtitle'); }
  return {
    alang: langSet(a.map(s => s.lang)), slang: langSet(subs.map(s => s.lang)),
    ach: a.reduce((m, s) => Math.max(m, +s.channels || 0), 0) || null,
    atmos: a.some(s => ATMOS.test(String(s.profile || '')) || ATMOS.test(String(s.title || ''))) ? 1 : 0
  };
}
// En äldre beräkning (annan FACET_V) räknas om
run('UPDATE items SET f_v=NULL WHERE f_v IS NOT NULL AND f_v != ?', FACET_V);
const pendingCount = () => get('SELECT COUNT(*) AS n FROM items WHERE f_v IS NULL AND path IS NOT NULL').n;
/** Räknar fram f_* för upp till max filer som väntar. Returnerar antalet. */
export function refreshFacets(max = 500) {
  const rows = all(`SELECT id, path, streams FROM items WHERE f_v IS NULL AND path IS NOT NULL LIMIT ?`, max);
  if (!rows.length) return 0;
  tx(() => {
    for (const r of rows) {
      const f = facetsOf(r);
      run('UPDATE items SET f_alang=?, f_slang=?, f_ach=?, f_atmos=?, f_v=? WHERE id=?', f.alang, f.slang, f.ach, f.atmos, FACET_V, r.id);
    }
  });
  return rows.length;
}
let running = false;
/** Räknar om allt som väntar i bakgrunden, i omgångar (blockerar inte servern) */
export function kickFacets() {
  if (running) return;
  running = true;
  const step = () => {
    let n = 0;
    try { n = refreshFacets(200); } catch (e) { console.warn('[filter] fil-egenskaper:', e.message); }
    if (n) setImmediate(step); else running = false;
  };
  setImmediate(step);
}
/** Före en fråga som använder f_*: små mängder räknas direkt, stora i bakgrunden (svaret använder de gamla värdena) */
function ensureFacets() {
  const n = pendingCount();
  if (!n) return;
  if (n <= 2000) { while (refreshFacets(500)); return; }
  kickFacets();
}
/** Efter skanning: undertextfiler kan ha lagts till/tagits bort bredvid filerna – räkna om allt i bakgrunden */
export function afterScan() {
  run('UPDATE items SET f_v=NULL WHERE f_v IS NOT NULL AND path IS NOT NULL');
  kickFacets();
}
/** En titels undertexter ändrades (nedladdning/borttagning) */
export const forget = (id) => run('UPDATE items SET f_v=NULL WHERE id=?', id);

// ---------- filtret ----------
// Fasta värden per nyckel. Alla SQL-bitar nedan är konstanter; x är ett alias som bara kod väljer (i, v, e).
const RES = ['sd', '720', '1080', '4k'];
const HDR = ['hdr', 'hdr10', 'dovi', 'hlg', 'sdr'];
const AUDIO = ['stereo', 'surround', 'atmos'];
const WATCH = ['unwatched', 'watched', 'inprogress'];
const STATUS = ['ongoing', 'ended'];
const COLL = ['yes', 'no'];
export const SORT_KEYS = ['title', 'year', 'rating', 'added', 'lastwatched', 'duration', 'random', 'date'];
const W = (x) => `COALESCE(${x}.width,0)`, H = (x) => `COALESCE(${x}.height,0)`;
const is4k = (x) => `(${W(x)} >= 3200 OR ${H(x)} >= 1600)`, is1080 = (x) => `(${W(x)} >= 1800 OR ${H(x)} >= 900)`, is720 = (x) => `(${W(x)} >= 1200 OR ${H(x)} >= 650)`;
const RES_SQL = {
  '4k': is4k, '1080': (x) => `(${is1080(x)} AND NOT ${is4k(x)})`, '720': (x) => `(${is720(x)} AND NOT ${is1080(x)})`,
  sd: (x) => `(${H(x)} > 0 AND NOT ${is720(x)})`
};
const HDR_SQL = {
  hdr: (x) => `${x}.hdr IS NOT NULL`, hdr10: (x) => `${x}.hdr='hdr10'`, dovi: (x) => `${x}.hdr='dovi'`, hlg: (x) => `${x}.hdr='hlg'`,
  sdr: (x) => `(${x}.hdr IS NULL AND ${H(x)} > 0)`
};
const AUDIO_SQL = { stereo: (x) => `${x}.f_ach BETWEEN 1 AND 2`, surround: (x) => `${x}.f_ach >= 6`, atmos: (x) => `${x}.f_atmos=1` };

const str = (v) => v == null ? null : String(v);
const int = (v, lo, hi) => { const s = str(v); if (s == null || !/^-?\d{1,6}$/.test(s.trim())) return null; const n = +s; return n >= lo && n <= hi ? n : null; };
const dec = (v, lo, hi) => { const s = str(v); if (s == null || !/^\d{1,3}(\.\d{1,2})?$/.test(s.trim())) return null; const n = +s; return n >= lo && n <= hi ? n : null; };
/** Läser en lista (kommaseparerad och/eller upprepad nyckel), bara tillåtna värden, utan dubbletter */
function list(getAll, k, ok) {
  const out = [];
  for (const v of getAll(k)) for (const x of String(v).split(',')) {
    const t = x.trim().slice(0, 100);
    if (t && ok(t) && !out.includes(t)) out.push(t);
    if (out.length >= MAX_LIST) return out;
  }
  return out;
}
/**
 * Normaliserar filtret ur URLSearchParams eller en adressdel (sträng). type = bibliotekets typ (movie/show).
 * Okända nycklar och ogiltiga värden tas bort (en delad länk från en annan version ska fungera så gott det går).
 */
export function parse(q, type = 'movie') {
  const p = q instanceof URLSearchParams ? q : new URLSearchParams(typeof q === 'string' ? q : '');
  const g = (k) => p.get(k), getAll = (k) => p.getAll(k);
  const f = {};
  const genre = list(getAll, 'genre', t => !/[\u0000-\u001f]/.test(t));
  if (genre.length) { f.genre = genre; if (g('genreAll') === '1' && genre.length > 1) f.genreAll = true; }
  const y0 = int(g('yearMin'), 1800, 2200), y1 = int(g('yearMax'), 1800, 2200);
  if (y0 != null) f.yearMin = y0;
  if (y1 != null) f.yearMax = y1;
  if (f.yearMin != null && f.yearMax != null && f.yearMin > f.yearMax) [f.yearMin, f.yearMax] = [f.yearMax, f.yearMin];
  const r = dec(g('ratingMin'), 0, 10); if (r) f.ratingMin = r;
  const d0 = int(g('durMin'), 1, 1000), d1 = int(g('durMax'), 1, 1000);
  if (d0 != null) f.durMin = d0;
  if (d1 != null) f.durMax = d1;
  if (f.durMin != null && f.durMax != null && f.durMin > f.durMax) [f.durMin, f.durMax] = [f.durMax, f.durMin];
  for (const [k, allowed] of [['res', RES], ['hdr', HDR], ['audio', AUDIO]]) { const l = list(getAll, k, t => allowed.includes(t)); if (l.length) f[k] = l; }
  for (const k of ['alang', 'slang']) { const l = list(getAll, k, t => LANG_RE.test(t)).map(langKey).filter((x, i, a) => x && a.indexOf(x) === i); if (l.length) f[k] = l; }
  if (WATCH.includes(g('filter'))) f.filter = g('filter');
  const ad = int(g('addedDays'), 1, 36500); if (ad) f.addedDays = ad;
  const am = int(g('ageMax'), 0, 21); if (am != null) f.ageMax = am;
  if (type === 'movie' && COLL.includes(g('coll'))) f.coll = g('coll');
  if (type === 'show') {
    if (STATUS.includes(g('status'))) f.status = g('status');
    const s0 = int(g('seasonsMin'), 1, 200), s1 = int(g('seasonsMax'), 1, 200);
    if (s0 != null) f.seasonsMin = s0;
    if (s1 != null) f.seasonsMax = s1;
    if (f.seasonsMin != null && f.seasonsMax != null && f.seasonsMin > f.seasonsMax) [f.seasonsMin, f.seasonsMax] = [f.seasonsMax, f.seasonsMin];
  }
  const sort = g('sort');
  if (SORT_KEYS.includes(sort)) f.sort = sort;
  if (g('order') === 'asc' || g('order') === 'desc') f.order = g('order');
  const seed = int(g('seed'), 0, 999999); if (seed != null && f.sort === 'random') f.seed = seed;
  return f;
}
// Fast ordning i adressen (samma filter ger samma adress)
const KEYS = ['genre', 'genreAll', 'yearMin', 'yearMax', 'ratingMin', 'durMin', 'durMax', 'res', 'hdr', 'audio', 'alang', 'slang', 'filter',
  'addedDays', 'ageMax', 'coll', 'status', 'seasonsMin', 'seasonsMax', 'sort', 'order', 'seed'];
export function toQuery(f) {
  const p = new URLSearchParams();
  for (const k of KEYS) {
    const v = f[k];
    if (v == null || v === false || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : v === true ? '1' : String(v));
  }
  return p.toString();
}
/** Är något filter (inte bara sortering) aktivt? */
export const hasFilter = (f) => Object.keys(f).some(k => !['sort', 'order', 'seed'].includes(k));
/** Använder filtret fil-egenskaperna som räknas fram (f_*)? */
const usesFacets = (f) => !!(f.audio || f.alang || f.slang);

// Uttryck per bibliotekstyp (fast SQL)
const DUR = { movie: 'i.duration', show: '(SELECT AVG(e.duration) FROM items e WHERE e.parent_id=i.id)' };
const ADDED = { movie: 'i.added', show: 'MAX(i.added, COALESCE((SELECT MAX(e.added) FROM items e WHERE e.parent_id=i.id), 0))' };
const SEASONS = '(SELECT COUNT(DISTINCT e.season) FROM items e WHERE e.parent_id=i.id AND e.season > 0)';
const LAST_WATCHED = { movie: 'p.updated', show: '(SELECT MAX(q.updated) FROM items e CROSS JOIN progress q WHERE e.parent_id=i.id AND q.user_id=p_uid.uid AND q.item_id=e.id)' };
const ENDED = "('Ended','Canceled')", ENDED_SET = new Set(['Ended', 'Canceled']); // TMDB:s status för avslutade serier

/**
 * SQL för filtret (alias som i listItems: i = titeln, p = framsteg, ep_* från PROG).
 * @returns {{ where: string[], params: any[] }} villkor som ska AND:as, parametrarna i samma ordning
 */
export function build(f, type = 'movie') {
  const where = [], params = [];
  const t = type === 'show' ? 'show' : 'movie';
  if (f.genre) {
    const sub = `SELECT 1 FROM json_each(i.genres) g WHERE g.value IN (SELECT value FROM json_each(?))`;
    // Alla valda genrer (genreAll) eller någon av dem
    where.push(f.genreAll
      ? `(json_valid(i.genres) AND (SELECT COUNT(DISTINCT g.value) FROM json_each(i.genres) g WHERE g.value IN (SELECT value FROM json_each(?))) = ?)`
      : `(json_valid(i.genres) AND EXISTS (${sub}))`);
    params.push(JSON.stringify(f.genre));
    if (f.genreAll) params.push(f.genre.length);
  }
  if (f.yearMin != null) { where.push('i.year >= ?'); params.push(f.yearMin); }
  if (f.yearMax != null) { where.push('i.year <= ?'); params.push(f.yearMax); }
  if (f.ratingMin) { where.push('i.rating >= ?'); params.push(f.ratingMin); }
  if (f.durMin != null) { where.push(`${DUR[t]} >= ?`); params.push(f.durMin * 60); }
  if (f.durMax != null) { where.push(`${DUR[t]} <= ?`); params.push(f.durMax * 60); }
  if (f.addedDays) { where.push(`${ADDED[t]} >= ?`); params.push(now() - f.addedDays * DAY); }
  if (f.ageMax != null) { where.push('i.age <= ?'); params.push(f.ageMax); }
  if (f.filter === 'unwatched') where.push(t === 'show' ? 'ep_watched < ep_total' : 'COALESCE(p.watched,0)=0');
  if (f.filter === 'watched') where.push(t === 'show' ? 'ep_watched = ep_total' : 'p.watched=1');
  if (f.filter === 'inprogress') where.push(t === 'show'
    ? `((ep_watched > 0 AND ep_watched < ep_total) OR EXISTS (SELECT 1 FROM items e CROSS JOIN progress q WHERE e.parent_id=i.id AND q.user_id=p_uid.uid AND q.item_id=e.id AND q.watched=0 AND q.position > 0))`
    : '(COALESCE(p.watched,0)=0 AND p.position > 0)');
  if (t === 'movie' && f.coll) where.push(f.coll === 'yes' ? 'i.collection_id IS NOT NULL' : 'i.collection_id IS NULL');
  if (t === 'show' && f.status) where.push(`EXISTS (SELECT 1 FROM calendar_shows cs WHERE cs.show_id=i.id AND cs.status IS NOT NULL AND cs.status ${f.status === 'ended' ? '' : 'NOT '}IN ${ENDED})`);
  if (t === 'show' && f.seasonsMin != null) { where.push(`${SEASONS} >= ?`); params.push(f.seasonsMin); }
  if (t === 'show' && f.seasonsMax != null) { where.push(`${SEASONS} <= ?`); params.push(f.seasonsMax); }
  // Fil-egenskaper: alla valda villkor ska gälla samma fil (t.ex. 4K och Atmos i samma version)
  const fc = (x) => {
    const parts = [], ps = [];
    const any = (vals, map) => '(' + vals.map(v => map[v](x)).join(' OR ') + ')';
    if (f.res) parts.push(any(f.res, RES_SQL));
    if (f.hdr) parts.push(any(f.hdr, HDR_SQL));
    if (f.audio) parts.push(any(f.audio, AUDIO_SQL));
    for (const k of ['alang', 'slang']) if (f[k]) {
      parts.push('(' + f[k].map(() => `instr(COALESCE(${x}.f_${k}, ''), ?) > 0`).join(' OR ') + ')');
      ps.push(...f[k].map(l => ',' + l + ','));
    }
    return { sql: parts.join(' AND '), params: ps };
  };
  const fi = fc('i');
  if (fi.sql) {
    if (t === 'movie') {
      const fv = fc('v');
      where.push(`(${fi.sql} OR EXISTS (SELECT 1 FROM items v WHERE v.version_of=i.id AND ${fv.sql}))`);
      params.push(...fi.params, ...fv.params);
    } else {
      const fe = fc('e');
      where.push(`EXISTS (SELECT 1 FROM items e WHERE e.parent_id=i.id AND ${fe.sql})`);
      params.push(...fe.params);
    }
  }
  return { where, params };
}

// Sortering. Utan order= ger de gamla nycklarna exakt samma ordning som tidigare (apparna).
const LEGACY = { title: 'i.sort_title', added: 'i.added DESC', year: 'i.year DESC, i.sort_title', rating: 'i.rating DESC NULLS LAST, i.sort_title',
  date: 'i.taken DESC NULLS LAST, i.added DESC, i.sort_title' };
const SORT_SQL = {
  title: { expr: () => 'i.sort_title', dir: 'asc' },
  year: { expr: () => 'i.year', dir: 'desc' },
  rating: { expr: () => 'i.rating', dir: 'desc' },
  added: { expr: (t) => ADDED[t], dir: 'desc' },
  lastwatched: { expr: (t) => LAST_WATCHED[t], dir: 'desc' },
  duration: { expr: (t) => DUR[t], dir: 'desc' },
  date: { expr: () => 'i.taken', dir: 'desc' }
};
/** ORDER BY för filtrets sortering (fast SQL; slumpens frö är ett kontrollerat heltal) */
export function orderBy(f, type = 'movie') {
  const t = type === 'show' ? 'show' : 'movie', key = f.sort || 'title';
  if (key === 'random') {
    // Stabil blandning (samma frö = samma ordning, så att sidindelning fungerar)
    const seed = Number.isInteger(f.seed) ? f.seed : 0;
    // Spridning av id (multiplikation modulo ett primtal), XOR med en mask ur fröet ((x|m)-(x&m)) och en andra
    // spridning: olika frön ger verkligt olika ordning, inte bara en förskjutning. Allt ryms i 64 bitar.
    const m = (seed * 2246822519 + 3266489917) % 4294967291, x = '((i.id * 2654435761) % 4294967291)';
    return `(((${x} | ${m}) - (${x} & ${m})) * 1103515245 % 2147483647), i.id`;
  }
  if (!f.order && LEGACY[key]) return LEGACY[key];
  const s = SORT_SQL[key] || SORT_SQL.title, dir = (f.order || s.dir) === 'asc' ? 'ASC' : 'DESC';
  return key === 'title' ? `i.sort_title ${dir}, i.id` : `${s.expr(t)} ${dir} NULLS LAST, i.sort_title, i.id`;
}

/** Bas-villkoren för ett bibliotek + filtret: { where, params, order } (för listItems) */
export function query(lib, f) {
  if (usesFacets(f)) ensureFacets();
  const b = build(f, lib.type);
  return { where: [`i.library_id=?`, `i.kind=?`, ...b.where], params: [lib.id, lib.type, ...b.params], order: orderBy(f, lib.type) };
}
/** Antal titlar som matchar (samma villkor som listItems, med ålders- och biblioteksfilter) */
export function count(uid, where, params) {
  const age = ageFilter(uid);
  return get(`SELECT COUNT(*) AS n FROM (SELECT ${PROG} ${FROM} LEFT JOIN items s ON s.id=i.parent_id WHERE (${where.join(' AND ')})${MAIN_ONLY}${age.sql})`, uid, ...params, ...age.params).n;
}
/** Titlarna i ett filtrerat bibliotek (listItems-format) */
export function items(uid, lib, f, limit = 1000, offset = 0) {
  const q = query(lib, f);
  return listItems(uid, q.where.join(' AND '), q.params, q.order, limit, offset, { slim: true });
}

/**
 * "Blanda": en slumpad titel ur filtreringen. Serier: ett slumpat avsnitt (osedda först om filtret gäller osedda).
 * @returns {{ item: object, play: object } | null} item = filmen/serien, play = det som ska spelas
 */
export function shuffle(uid, lib, f) {
  const q = query(lib, f);
  const it = listItems(uid, q.where.join(' AND '), q.params, 'random()', 1, 0, { slim: true })[0];
  if (!it) return null;
  if (it.kind !== 'show') return { item: it, play: it };
  const unw = f.filter === 'unwatched' || f.filter === 'inprogress';
  const pick = (extra) => listItems(uid, `i.parent_id=?${extra}`, [it.id], 'random()', 1, 0, { slim: true })[0];
  const ep = (unw && pick(' AND COALESCE(p.watched,0)=0')) || pick(' AND i.season > 0') || pick('');
  return ep ? { item: it, play: ep } : null;
}
/** En slumpad spelbar titel bland id:n (filmer/serier, t.ex. en samling) – serie → slumpat avsnitt */
export function shuffleIds(uid, ids) {
  if (!ids.length) return null;
  const id = ids[Math.floor(Math.random() * ids.length)];
  const it = listItems(uid, 'i.id=?', [id], 'i.id', 1, 0, { slim: true })[0];
  if (!it) return null;
  if (it.kind !== 'show') return { item: it, play: it };
  const ep = listItems(uid, 'i.parent_id=? AND i.season > 0', [it.id], 'random()', 1, 0, { slim: true })[0]
    || listItems(uid, 'i.parent_id=?', [it.id], 'random()', 1, 0, { slim: true })[0];
  return ep ? { item: it, play: ep } : null;
}

// ---------- val i filterpanelen ----------
// Vilka värden finns i biblioteket (inom profilens åldersgräns och bibliotek)? Cachas en minut per bibliotek och åldersfilter.
const facetCache = new Map();
const FACET_TTL = 60e3;
export function clearFacets() { facetCache.clear(); }
export function facets(uid, lib) {
  const age = ageFilter(uid), key = lib.id + '|' + age.params.join(',');
  const c = facetCache.get(key);
  if (c && Date.now() - c.t < FACET_TTL) return c.v;
  ensureFacets();
  const t = lib.type === 'show' ? 'show' : 'movie';
  const rows = all(`SELECT i.id, i.genres, i.year, i.rating, i.age, i.cert, i.collection_id, ${t === 'show' ? `${SEASONS} AS seasons, (SELECT cs.status FROM calendar_shows cs WHERE cs.show_id=i.id) AS status` : 'NULL AS seasons, NULL AS status'}
    FROM items i LEFT JOIN items s ON s.id=i.parent_id WHERE i.library_id=? AND i.kind=?${MAIN_ONLY}${age.sql}`, lib.id, t, ...age.params);
  const genres = new Map(), ages = new Map(), status = { ongoing: 0, ended: 0 };
  let yMin = null, yMax = null, sMax = 0, inColl = 0;
  for (const r of rows) {
    let g = []; try { g = JSON.parse(r.genres || '[]'); } catch {}
    if (Array.isArray(g)) for (const x of g) if (typeof x === 'string') genres.set(x, (genres.get(x) || 0) + 1);
    if (r.year) { yMin = yMin == null ? r.year : Math.min(yMin, r.year); yMax = yMax == null ? r.year : Math.max(yMax, r.year); }
    if (r.age != null) { const a = ages.get(r.age) || { age: r.age, cert: r.cert || null, count: 0 }; a.count++; ages.set(r.age, a); }
    if (r.collection_id) inColl++;
    if (r.seasons) sMax = Math.max(sMax, r.seasons);
    if (r.status) status[ENDED_SET.has(r.status) ? 'ended' : 'ongoing']++;
  }
  // Fil-egenskaper per titel (en titel räknas en gång även om flera versioner/avsnitt har egenskapen)
  const files = all(`SELECT COALESCE(i.version_of, i.parent_id, i.id) AS t, i.width, i.height, i.hdr, i.f_alang, i.f_slang, i.f_ach, i.f_atmos
    FROM items i LEFT JOIN items s ON s.id=COALESCE(i.parent_id, i.version_of) WHERE i.library_id=? AND i.kind=?${age.sql}`, lib.id, t === 'show' ? 'episode' : 'movie', ...age.params);
  const sets = {}, add = (k, id) => { (sets[k] ||= new Set()).add(id); };
  for (const r of files) {
    const w = r.width || 0, h = r.height || 0;
    if (h > 0 || w > 0) add('res:' + (w >= 3200 || h >= 1600 ? '4k' : w >= 1800 || h >= 900 ? '1080' : w >= 1200 || h >= 650 ? '720' : 'sd'), r.t);
    if (r.hdr) { add('hdr:hdr', r.t); add('hdr:' + r.hdr, r.t); } else if (h > 0) add('hdr:sdr', r.t);
    if (r.f_ach >= 6) add('audio:surround', r.t); else if (r.f_ach >= 1) add('audio:stereo', r.t);
    if (r.f_atmos) add('audio:atmos', r.t);
    for (const k of ['alang', 'slang']) for (const l of String(r['f_' + k] || '').split(',')) if (l) add(k + ':' + l, r.t);
  }
  const counted = (prefix, keys) => keys.map(k => ({ value: k, count: sets[prefix + ':' + k]?.size || 0 })).filter(x => x.count);
  const langs = (k) => Object.keys(sets).filter(x => x.startsWith(k + ':')).map(x => ({ value: x.slice(k.length + 1), count: sets[x].size })).sort((a, b) => b.count - a.count);
  const v = {
    total: rows.length,
    genres: [...genres].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'sv')),
    years: yMin == null ? null : { min: yMin, max: yMax },
    ages: [...ages.values()].sort((a, b) => a.age - b.age),
    res: counted('res', RES), hdr: counted('hdr', HDR), audio: counted('audio', AUDIO),
    alang: langs('alang'), slang: langs('slang'),
    ...(t === 'movie' ? { collections: inColl } : { status, seasonsMax: sMax })
  };
  facetCache.set(key, { v, t: Date.now() });
  if (facetCache.size > 100) facetCache.delete(facetCache.keys().next().value);
  return v;
}
