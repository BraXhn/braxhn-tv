// Egna samlingar för filmer och serier (som Collections i Plex/Jellyfin), vid sidan av TMDB-samlingarna.
//
// Synlighet: en delad samling (shared=1) syns för alla profiler och ändras bara av administratörer på betrott nät;
// en privat syns och ändras bara av den som skapade den. Barnprofiler ser bara titlar inom sin åldersgräns
// (ageFilter, samma som listItems) och bara samlingar där minst en titel syns – en tom eller "vuxen" samling
// läcker varken namn eller beskrivning. Bara huvudrader (filmer och serier) ligger i en samling: ett avsnitt
// läggs till som sin serie och en filmversion som filmen.
//
// Smarta samlingar (kind='smart'): ett sparat filter för ett bibliotek (def = { library, query }, se libfilter.js).
// Innehållet räknas fram vid varje visning med profilens åldersgräns och biblioteksbehörighet – en profil som inte
// får se biblioteket ser en tom (och därmed dold) samling. Titlar läggs inte till för hand och ordningen följer filtret.
import { get, all, run, tx, now } from './db.js';
import { listItems, ageFilter, MAIN_ONLY, libOk } from './http/context.js';
import * as libfilter from './libfilter.js';

export const SORTS = ['manual', 'title', 'year', 'added'];
const ORDER = { manual: 'ci.pos, ci.added, i.sort_title', title: 'i.sort_title, i.year', year: 'i.year, i.sort_title', added: 'ci.added DESC, ci.pos' };
const MAX_ITEMS = 1000, MAX_COLS = 200;

/** Får användaren se samlingen över huvud taget (innan åldersgränsen räknas)? */
const reachable = (u, col) => !!col && (col.shared === 1 || col.owner_id === u.id);
/** Får användaren ändra samlingen? adminHere = administratör på betrott nät (som admin-routes). */
export const canEdit = (u, col, adminHere) => !!col && (col.shared === 1 ? !!adminHere : col.owner_id === u.id);

/** Den smarta samlingens definition ({ library, query }) eller null */
export function smartDef(col) {
  if (col?.kind !== 'smart') return null;
  try { const d = JSON.parse(col.def || '{}'); return Number.isInteger(d.library) && typeof d.query === 'string' ? d : null; } catch { return null; }
}
/** Kontrollerar en ny definition från klienten: bibliotek som användaren ser (film/serie) och ett normaliserat filter */
export function checkSmart(uid, b) {
  const lib = b && typeof b === 'object' ? get('SELECT id, type FROM libraries WHERE id=?', parseInt(b.library) || 0) : null;
  if (!lib || !['movie', 'show'].includes(lib.type) || !libOk(uid, lib.id)) return null;
  return { library: lib.id, query: libfilter.toQuery(libfilter.parse(String(b.query || '').slice(0, 4000), lib.type)) };
}
/** Smart samling: titlarna som filtret ger just nu (listItems-format, profilens åldersgräns och bibliotek) */
function smartItems(uid, col, limit = MAX_ITEMS) {
  const d = smartDef(col);
  const lib = d && get('SELECT id, type FROM libraries WHERE id=?', d.library);
  if (!lib || !libOk(uid, lib.id)) return [];
  return libfilter.items(uid, lib, libfilter.parse(d.query, lib.type), limit);
}
/** Samlingens titlar i samlingens ordning, bara det profilen får se: [{ id, year }] */
function visibleIds(uid, col) {
  if (col.kind === 'smart') return smartItems(uid, col);
  const age = ageFilter(uid);
  return all(`SELECT i.id, i.year, i.poster FROM custom_collection_items ci JOIN items i ON i.id=ci.item_id LEFT JOIN items s ON s.id=i.parent_id
    WHERE ci.collection_id=? AND i.kind IN ('movie','show')${MAIN_ONLY}${age.sql} ORDER BY ${ORDER[col.sort] || ORDER.manual}`, col.id, ...age.params);
}
function summary(u, col, ids, adminHere) {
  const years = ids.map(r => r.year).filter(Boolean);
  const d = smartDef(col);
  return { id: col.id, kind: 'custom', name: col.name, overview: col.overview || '', shared: col.shared === 1, mine: col.owner_id === u.id,
    editable: canEdit(u, col, adminHere), sort: col.sort, home: col.on_home === 1, count: ids.length,
    // Smart samling (nya fält): biblioteket och filtret som adressdel (#/lib/<library>?<query>)
    ...(col.kind === 'smart' ? { smart: true, library: d?.library ?? null, query: d?.query ?? '' } : {}),
    // Omslag: affischen från första synliga titeln som har en (/api/image/<cover>/poster kontrollerar själv åldersgränsen)
    cover: (ids.find(r => r.poster) || ids[0])?.id ?? null, years: years.length ? [Math.min(...years), Math.max(...years)] : [] };
}

/**
 * Samlingar som användaren ser. Samlingar utan någon synlig titel visas bara för den som får ändra dem
 * (så att man kan fylla en ny samling), aldrig för andra.
 * @param {{ adminHere?: boolean, item?: number, library?: number, editable?: boolean, home?: boolean }} o
 *   item = markera has för den titeln, library = bara samlingar med titlar i biblioteket (smarta: filtrets bibliotek),
 *   editable = bara de man får ändra och lägga titlar i (inte smarta)
 */
export function listFor(u, { adminHere = false, item = null, library = null, editable = false, home = false } = {}) {
  const cols = all(`SELECT * FROM custom_collections WHERE (shared=1 OR owner_id=?)${home ? ' AND on_home=1' : ''} ORDER BY name COLLATE NOCASE, id`, u.id);
  const has = item ? new Set(all('SELECT collection_id FROM custom_collection_items WHERE item_id=?', item).map(r => r.collection_id)) : null;
  const libIds = library ? new Set(all(`SELECT DISTINCT ci.collection_id FROM custom_collection_items ci JOIN items i ON i.id=ci.item_id WHERE i.library_id=?`, library).map(r => r.collection_id)) : null;
  const out = [];
  for (const col of cols) {
    const smart = col.kind === 'smart';
    if (editable && (smart || !canEdit(u, col, adminHere))) continue;
    if (libIds && !(smart ? smartDef(col)?.library === library : libIds.has(col.id))) continue;
    const ids = visibleIds(u.id, col);
    if (!ids.length && (!canEdit(u, col, adminHere) || home || library)) continue;
    const s = summary(u, col, ids, adminHere);
    if (has) s.has = smart ? ids.some(r => r.id === item) : has.has(col.id);
    out.push(s);
  }
  return out;
}

/** Hela samlingen med titlarna (listItems-format), eller null om profilen inte får se den */
export function detail(u, cid, adminHere, limit = MAX_ITEMS) {
  const col = get('SELECT * FROM custom_collections WHERE id=?', cid);
  if (!reachable(u, col)) return null;
  const ids = visibleIds(u.id, col);
  if (!ids.length && !canEdit(u, col, adminHere)) return null;
  if (col.kind === 'smart') return { ...summary(u, col, ids, adminHere), items: ids.slice(0, limit) };
  const order = new Map(ids.slice(0, limit).map((r, i) => [r.id, i]));
  const items = order.size ? listItems(u.id, `i.id IN (${[...order.keys()].map(() => '?').join(',')})`, [...order.keys()], 'i.id', order.size)
    .sort((a, b) => order.get(a.id) - order.get(b.id)) : [];
  return { ...summary(u, col, ids, adminHere), items };
}

/** Hyllor för startsidan: samlingar med "Visa på startsidan" och minst en synlig titel */
export const homeShelves = (u, adminHere) => listFor(u, { adminHere, home: true })
  .map(s => ({ ...s, items: detail(u, s.id, adminHere, 24)?.items || [] })).filter(s => s.items.length);

// ---------- ändringar (routefilen har redan kontrollerat canEdit) ----------
const clean = (b, old = {}) => ({
  name: b.name === undefined ? old.name : String(b.name || '').trim().slice(0, 100),
  overview: b.overview === undefined ? old.overview || null : String(b.overview || '').trim().slice(0, 2000) || null,
  sort: SORTS.includes(b.sort) ? b.sort : old.sort || 'manual',
  on_home: b.home === undefined ? old.on_home || 0 : b.home ? 1 : 0,
});
export const get1 = (cid) => get('SELECT * FROM custom_collections WHERE id=?', cid);
export const countOwned = (uid) => get('SELECT COUNT(*) AS n FROM custom_collections WHERE owner_id=?', uid).n;
export const MAX_PER_USER = MAX_COLS;

/** smart = kontrollerad definition (checkSmart) för en smart samling */
export function create(u, b, shared, smart = null) {
  const v = clean(b);
  const t = now();
  return Number(run('INSERT INTO custom_collections(owner_id,name,overview,shared,sort,on_home,created,updated,kind,def) VALUES(?,?,?,?,?,?,?,?,?,?)',
    u.id, v.name, v.overview, shared ? 1 : 0, smart ? 'manual' : v.sort, v.on_home, t, t, smart ? 'smart' : 'manual', smart ? JSON.stringify(smart) : null).lastInsertRowid);
}
/** smart = ny definition för en smart samling (annars oförändrad) */
export function update(col, b, shared, smart = null) {
  const v = clean(b, col);
  run('UPDATE custom_collections SET name=?, overview=?, sort=?, on_home=?, shared=?, updated=?, def=? WHERE id=?',
    v.name, v.overview, col.kind === 'smart' ? 'manual' : v.sort, v.on_home, shared ? 1 : 0, now(), col.kind === 'smart' && smart ? JSON.stringify(smart) : col.def ?? null, col.id);
}
/** "Blanda" i en samling: en slumpad titel (serie → slumpat avsnitt) bland det profilen ser */
export function shuffle(u, cid, adminHere) {
  const col = get('SELECT * FROM custom_collections WHERE id=?', cid);
  if (!reachable(u, col)) return null;
  return libfilter.shuffleIds(u.id, visibleIds(u.id, col).map(r => r.id));
}
export const remove = (col) => run('DELETE FROM custom_collections WHERE id=?', col.id);

/** Titeln som hamnar i en samling: avsnitt → serien, filmversion → filmen. null om det inte är en film/serie. */
export function targetOf(itemId) {
  let it = get('SELECT id, kind, parent_id, version_of, age FROM items WHERE id=?', itemId);
  if (it?.kind === 'episode') it = get('SELECT id, kind, parent_id, version_of, age FROM items WHERE id=?', it.parent_id);
  if (it?.version_of) it = get('SELECT id, kind, parent_id, version_of, age FROM items WHERE id=?', it.version_of) || it;
  return it && (it.kind === 'movie' || it.kind === 'show') ? it : null;
}
/** Lägger till titeln sist (manuell ordning). false om samlingen är full. */
export function addItem(col, itemId) {
  const n = get('SELECT COUNT(*) AS n, MAX(pos) AS m FROM custom_collection_items WHERE collection_id=?', col.id);
  if (n.n >= MAX_ITEMS) return false;
  run('INSERT OR IGNORE INTO custom_collection_items(collection_id,item_id,pos,added) VALUES(?,?,?,?)', col.id, itemId, (n.m ?? -1) + 1, now());
  run('UPDATE custom_collections SET updated=? WHERE id=?', now(), col.id);
  return true;
}
export function removeItem(col, itemId) {
  run('DELETE FROM custom_collection_items WHERE collection_id=? AND item_id=?', col.id, itemId);
  run('UPDATE custom_collections SET updated=? WHERE id=?', now(), col.id);
}
/**
 * Manuell ordning: ids i önskad ordning först, sedan övriga titlar i samlingen i sin tidigare ordning
 * (t.ex. titlar som profilen inte ser – de behåller sin inbördes ordning sist).
 */
export function reorder(col, ids) {
  const cur = all('SELECT item_id FROM custom_collection_items WHERE collection_id=? ORDER BY pos, added', col.id).map(r => r.item_id);
  const inCol = new Set(cur), seen = new Set();
  const first = (Array.isArray(ids) ? ids : []).map(Number).filter(id => inCol.has(id) && !seen.has(id) && seen.add(id));
  const order = [...first, ...cur.filter(id => !seen.has(id))];
  tx(() => { order.forEach((id, i) => run('UPDATE custom_collection_items SET pos=? WHERE collection_id=? AND item_id=?', i, col.id, id)); });
  run('UPDATE custom_collections SET updated=? WHERE id=?', now(), col.id);
}
