// Startsidans tematiska hyllor och användarens egen ordning av hyllorna (users.home_layout).
// Hyllorna räknas i JavaScript på en lätt, cachad lista med alla filmer och serier (per åldersgräns) och
// användarens sedda titlar; bara de titlar som visas hämtas sedan i sin helhet (ett enda itemsByIds).
// Resultatet cachas kort per användare: nyckeln innehåller åldersgränsen, framstegets senaste ändring,
// dagen och layouten, så att en sedd film försvinner ur "osedda" hyllor direkt. Skanningen tömmer allt (clearHome).
import { all, get, run } from './db.js';
import { ageFilter, itemsByIds, listItems, MAIN_ONLY, recommend } from './http/context.js';
import * as books from './audiobooks.js';

// ---------- hyllorna och användarens layout ----------
/** Alla hyllor i standardordning (id:n är stabila – de sparas i users.home_layout) */
export const SHELVES = [
  { id: 'foryou', name: 'Nytt för dig' },
  { id: 'continue', name: 'Fortsätt titta' },
  { id: 'listening', name: 'Fortsätt lyssna' },
  { id: 'reading', name: 'Fortsätt läsa' },
  { id: 'watchlist', name: 'Min lista' },
  { id: 'upcoming', name: 'Kommer snart' },
  { id: 'because', name: 'Eftersom du såg …' },
  { id: 'recommended', name: 'Rekommenderat för dig' },
  { id: 'custom', name: 'Egna samlingar' },
  { id: 'recent', name: 'Nyligen tillagda' },
  { id: 'short', name: 'Kort film ikväll' },
  { id: 'toprated', name: 'Topprankat i biblioteket' },
  { id: 'onthisday', name: 'Den här dagen' },
  { id: 'memories', name: 'Minnen från fotobiblioteket' },
  { id: 'genre', name: 'Dagens genre' },
  { id: 'gems', name: 'Glömda guldkorn' },
  { id: 'collections', name: 'Samlingar' }
];
const IDS = SHELVES.map(s => s.id), KNOWN = new Set(IDS);
const HERO = ['auto', 'on', 'off'];
const parse = (s) => { try { const o = JSON.parse(s || 'null'); return o && typeof o === 'object' ? o : null; } catch { return null; } };
/** Sparad ordning + nya hyllor (som inte fanns när ordningen sparades) på sin plats i standardordningen */
function fullOrder(saved) {
  const order = [...new Set((Array.isArray(saved) ? saved : []).filter(x => KNOWN.has(x)))];
  for (const [i, id] of IDS.entries()) {
    if (order.includes(id)) continue;
    const prev = IDS.slice(0, i).reverse().find(x => order.includes(x));
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id);
  }
  return order;
}
/** Användarens startsida: { order, hidden, hero, custom, shelves } – custom = false när inget är sparat */
export function getLayout(uid) {
  const o = parse(get('SELECT home_layout FROM users WHERE id=?', uid)?.home_layout);
  return {
    order: fullOrder(o?.order), hidden: (Array.isArray(o?.hidden) ? o.hidden : []).filter(x => KNOWN.has(x)),
    hero: HERO.includes(o?.hero) ? o.hero : 'auto', custom: !!o, shelves: SHELVES
  };
}
/** Sparar layouten ({ reset: true } återställer). Kastar Error med svensk text vid ogiltiga värden. */
export function setLayout(uid, b = {}) {
  if (b.reset) { run('UPDATE users SET home_layout=NULL WHERE id=?', uid); forget(uid); return getLayout(uid); }
  const cur = getLayout(uid);
  const list = (v, what) => {
    if (!Array.isArray(v) || v.length > 50 || v.some(x => typeof x !== 'string')) throw new Error(`Ogiltig ${what}`);
    return v.filter(x => KNOWN.has(x));
  };
  const next = {
    order: b.order !== undefined ? fullOrder(list(b.order, 'ordning')) : cur.order,
    hidden: b.hidden !== undefined ? [...new Set(list(b.hidden, 'lista med dolda hyllor'))] : cur.hidden,
    hero: cur.hero
  };
  if (b.hero !== undefined) { if (!HERO.includes(b.hero)) throw new Error('Ogiltigt val för Utvalt'); next.hero = b.hero; }
  run('UPDATE users SET home_layout=? WHERE id=?', JSON.stringify(next), uid);
  forget(uid);
  return getLayout(uid);
}

// ---------- kandidaterna (alla filmer och serier, lätta kolumner) ----------
const parseGenres = (g) => { try { const a = JSON.parse(g || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } };
// Listan räknas om efter skanning (clearHome) och annars var 15:e minut; åldersgränsen kontrolleras ändå på nytt när
// titlarna hämtas (listItems), så en ändrad åldersgräns kan aldrig visa något otillåtet – bara fördröja en ny titel.
const CAND_TTL = 15 * 60e3;
const cands = new Map(); // åldersfiltrets parametrar -> { rows, byId, genres, t }
function candidates(age) {
  const k = age.params.join(','), c = cands.get(k);
  if (c && Date.now() - c.t < CAND_TTL) return c;
  const rows = all(`SELECT i.id, i.kind, i.title, i.genres, i.rating, i.added, i.duration, i.released, i.collection_id, i.backdrop,
      (i.overview IS NOT NULL AND i.overview != '') AS ov FROM items i LEFT JOIN items s ON s.id=i.parent_id
    WHERE i.kind IN ('movie','show')${MAIN_ONLY}${age.sql}`, ...age.params)
    .map(r => ({ id: r.id, kind: r.kind, title: r.title, g: parseGenres(r.genres), gi: null, rating: r.rating > 0 && r.rating <= 10 ? r.rating : null, added: r.added || 0,
      duration: r.duration || 0, rel: /^\d{4}-\d{2}-\d{2}$/.test(r.released || '') ? r.released : null, col: r.collection_id || null, hero: !!r.backdrop && !!r.ov }));
  // Genrerna som nummer (gi) – jämförelsen i similar() blir uppslag i en tabell i stället för strängjämförelser
  const genres = new Map(), gno = new Map();
  for (const r of rows) {
    for (const x of r.g) { genres.set(x, (genres.get(x) || 0) + 1); if (!gno.has(x)) gno.set(x, gno.size); }
    r.gi = r.g.map(x => gno.get(x));
  }
  // sorted: högst betyg först (titlar utan betyg sist) – hyllorna filtrerar den i stället för att sortera varje gång
  const sorted = rows.slice().sort(byRating);
  // byDay: premiärdag 'MM-DD' -> titlar (hyllan Den här dagen)
  const byDay = new Map();
  for (const r of rows) if (r.rel) { const k = r.rel.slice(5); byDay.has(k) ? byDay.get(k).push(r) : byDay.set(k, [r]); }
  const v = { rows, sorted, byId: new Map(rows.map(r => [r.id, r])), genres, byDay, ng: gno.size, t: Date.now() };
  cands.set(k, v);
  if (cands.size > 50) cands.delete(cands.keys().next().value);
  return v;
}

// ---------- cache per användare ----------
const TTL = 5 * 60e3;
const cache = new Map(); // uid -> { key, val, t }
const forget = (uid) => cache.delete(uid);
/** Töms efter skanning (nya/borttagna titlar, ändrade betyg) */
export function clearHome() { cache.clear(); cands.clear(); parents = null; }

// ---------- hjälpare ----------
/** Lokalt datum (serverns TZ) som 'YYYY-MM-DD' och dagnummer (byter hyllornas urval en gång per dygn) */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayNo = (d = new Date()) => Math.floor((d.getTime() - d.getTimezoneOffset() * 60e3) / 86400e3);
/** Deterministisk blandning per dag (samma ordning hela dagen, ny i morgon) */
function hashMix(id, day) { let h = (id * 2654435761 + day * 40503) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h ^= h >>> 13; return h; }
const daily = (list, day) => list.map(r => [hashMix(r.id, day), r]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
const byRating = (a, b) => (b.rating || 0) - (a.rating || 0) || b.added - a.added;
/** Dagens urval: de bästa (pool st) blandas per dag och de första n visas */
/** De första (högst betyg) pool titlarna i sorted som uppfyller ok – utan att gå igenom resten */
function firstWhere(sorted, ok, pool) {
  const out = [];
  for (const r of sorted) { if (ok(r)) { out.push(r); if (out.length >= pool) break; } }
  return out;
}
/** Dagens urval: de bästa (pool st, sorted = högst betyg först) blandas per dag och de första n visas */
const pickDaily = (sorted, ok, day, n, pool = 60) => daily(firstWhere(sorted, ok, pool), day).slice(0, n);

// Avsnitt -> serie (för att räkna sedda avsnitt som sedd serie utan JOIN mot items på varje förfrågan)
let parents = null, parentsT = 0;
function parentOf() {
  if (parents && Date.now() - parentsT < CAND_TTL) return parents;
  parents = new Map(all('SELECT id, parent_id FROM items WHERE parent_id IS NOT NULL').map(r => [r.id, r.parent_id]));
  parentsT = Date.now();
  return parents;
}
/** Profilens framsteg på titelnivå (serier via sina avsnitt): seen = id -> senaste ändring (sedd eller påbörjad),
 *  hits = [id, år] för titlar som sågs klart inom något av tidsfönstren wins ([år, från, till], "sedd för N år sedan") */
function progressOf(uid, wins) {
  const par = parentOf(), seen = new Map(), hits = [];
  for (const r of all('SELECT item_id, updated, watched FROM progress WHERE user_id=? AND (watched=1 OR position > 0)', uid)) {
    const id = par.get(r.item_id) ?? r.item_id, u = r.updated;
    if (!(seen.get(id) >= u)) seen.set(id, u);
    if (r.watched) for (const w of wins) if (u >= w[1] && u <= w[2]) hits.push([id, w[0]]);
  }
  return { seen, hits };
}
/** Titlar som liknar seed (samma typ): delade genrer, samma filmsamling räknas extra – som similarTo i http/context.js */
function similar(C, seed, seen, n) {
  if (!seed.gi.length) return [];
  const has = new Uint8Array(C.ng);
  for (const x of seed.gi) has[x] = 1;
  const out = [], sn = seed.gi.length;
  for (const r of C.rows) {
    const rn = r.gi.length;
    if (r.kind !== seed.kind || r.id === seed.id || !rn) continue;
    let k = 0;
    for (const x of r.gi) k += has[x];
    const s = k / (sn > rn ? sn : rn) + (r.col && r.col === seed.col ? 1 : 0) + (r.rating || 6) / 100;
    if (s < 0.4 || seen.has(r.id)) continue;
    out.push([s, r]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, n).map(o => o[1]);
}
/** De n senast ändrade i en Map id -> tid (utan att sortera hela) */
function latest(m, n) {
  const top = [];
  for (const e of m) {
    if (top.length >= n && e[1] <= top[top.length - 1][1]) continue;
    let i = top.length;
    while (i > 0 && top[i - 1][1] < e[1]) i--;
    top.splice(i, 0, e);
    if (top.length > n) top.pop();
  }
  return top;
}
/** Lokala dygnets gränser (sekunder) för dagens datum för years år sedan */
function dayBounds(d, years) {
  const from = new Date(d.getFullYear() - years, d.getMonth(), d.getDate());
  // 29 februari ett år som inte är skottår: hoppa över
  if (from.getMonth() !== d.getMonth()) return null;
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  return [Math.floor(from.getTime() / 1000), Math.floor(to.getTime() / 1000) - 1];
}

/**
 * De tematiska hyllorna för /api/home (nya fält). hidden = hyllor som användaren dolt (räknas inte).
 * Returnerar { recommended, because, topRated, hiddenGems, shortTonight, onThisDay, genreOfDay, heroIds } där heroIds är
 * reservtitlar för Utvalt (osedda, högt betyg, med bakgrundsbild och beskrivning).
 */
export function themed(uid, { hidden = [], now = new Date() } = {}) {
  const age = ageFilter(uid);
  // Det som påverkar resultatet: framsteg och Min lista (rekommendationerna), åldersgräns, dag och dolda hyllor
  const pv = get(`SELECT (SELECT MAX(updated) FROM progress WHERE user_id=?1) AS u, (SELECT COUNT(*) FROM progress WHERE user_id=?1) AS n,
    (SELECT MAX(added) FROM watchlist WHERE user_id=?1) AS wa, (SELECT COUNT(*) FROM watchlist WHERE user_id=?1) AS wn`, uid);
  const day = dayNo(now);
  const key = [age.params.join(','), pv.u, pv.n, pv.wa, pv.wn, day, hidden.join(',')].join('|');
  const c = cache.get(uid);
  if (c && c.key === key && Date.now() - c.t < TTL) return c.val;

  const off = new Set(hidden);
  const wins = off.has('onthisday') ? [] : [1, 5, 10].map(n => [n, ...(dayBounds(now, n) || [])]).filter(w => w.length === 3);
  const C = candidates(age), { seen, hits } = progressOf(uid, wins);
  const ids = { because: [], topRated: [], hiddenGems: [], shortTonight: [], onThisDay: [], genre: [], hero: [] };
  const seeds = [], notes = new Map();
  let genre = null;

  if (!off.has('because')) {
    // De två senast sedda titlarna (med genrer) som fortfarande finns och får visas i profilen
    for (const [id] of latest(seen, 8)) {
      const s = C.byId.get(id);
      if (!s || !s.g.length) continue;
      const list = similar(C, s, seen, 20);
      if (list.length >= 4) { seeds.push({ id: s.id, title: s.title, kind: s.kind }); ids.because.push(list.map(r => r.id)); }
      if (seeds.length >= 2) break;
    }
  }
  if (!off.has('toprated')) {
    // Osedda först, sedan betyg (minst 7)
    const top = firstWhere(C.sorted, r => !seen.has(r.id), 24);
    if (top.length < 24) top.push(...firstWhere(C.sorted, r => seen.has(r.id), 24 - top.length));
    ids.topRated = top.filter(r => r.rating >= 7).map(r => r.id);
  }
  if (!off.has('gems')) {
    // Högt betyg, tillagd för mer än ett halvår sedan och aldrig sedd av profilen
    const old = Math.floor(now.getTime() / 1000) - 180 * 86400;
    ids.hiddenGems = pickDaily(C.sorted, r => r.rating >= 7.5 && r.added && r.added < old && !seen.has(r.id), day + 1, 20).map(r => r.id);
  }
  if (!off.has('short')) {
    // Osedda filmer under 95 minuter (kortfilmer under 20 minuter räknas inte)
    ids.shortTonight = pickDaily(C.sorted, r => r.kind === 'movie' && r.duration >= 20 * 60 && r.duration < 95 * 60 && !seen.has(r.id), day + 2, 20).map(r => r.id);
  }
  if (!off.has('onthisday')) {
    // Premiär det här datumet ett tidigare år, eller sedd för exakt 1, 5 eller 10 år sedan
    const year = now.getFullYear();
    for (const r of C.byDay.get(ymd(now).slice(5)) || []) {
      const y = year - +r.rel.slice(0, 4);
      if (y > 0) notes.set(r.id, { kind: 'premiere', years: y, note: `Premiär för ${y} år sedan` });
    }
    for (const [id, n] of hits) {
      if (!C.byId.has(id) || notes.get(id)?.kind === 'watched') continue;
      notes.set(id, { kind: 'watched', years: n, note: n === 1 ? 'Du såg den för ett år sedan' : `Du såg den för ${n} år sedan` });
    }
    // Sedda minnen först, sedan premiärer (jubileer – jämna år – före övriga)
    ids.onThisDay = [...notes.entries()].sort((a, b) => (a[1].kind === 'watched' ? 0 : 1) - (b[1].kind === 'watched' ? 0 : 1)
      || (a[1].years % 5 ? 1 : 0) - (b[1].years % 5 ? 1 : 0) || (C.byId.get(b[0]).rating || 0) - (C.byId.get(a[0]).rating || 0)).slice(0, 20).map(x => x[0]);
  }
  if (!off.has('genre')) {
    // En genre per dag bland genrerna med minst 8 titlar, i bokstavsordning så att alla kommer i tur
    const list = [...C.genres.entries()].filter(x => x[1] >= 8).map(x => x[0]).sort((a, b) => a.localeCompare(b, 'sv'));
    if (list.length) {
      genre = list[((day % list.length) + list.length) % list.length];
      const fresh = pickDaily(C.sorted, r => r.g.includes(genre) && !seen.has(r.id), day + 3, 20, 80);
      ids.genre = (fresh.length >= 8 ? fresh : [...fresh, ...pickDaily(C.sorted, r => r.g.includes(genre) && seen.has(r.id), day + 3, 20 - fresh.length)]).map(r => r.id);
    }
  }
  if (!off.has('hero')) ids.hero = pickDaily(C.sorted, r => r.hero && r.rating >= 6.5 && !seen.has(r.id), day + 4, 10, 40).map(r => r.id);

  // Alla titlar på en gång (samma titel på flera hyllor hämtas en gång)
  const all_ = [...new Set([...ids.because.flat(), ...ids.topRated, ...ids.hiddenGems, ...ids.shortTonight, ...ids.onThisDay, ...ids.genre])];
  // Utan beskrivning (slim): korten visar den inte och svaret blir hälften så stort
  const full = new Map(all_.length ? listItems(uid, `i.id IN (${all_.map(() => '?').join(',')})`, all_, 'i.id', all_.length, 0, { slim: true }).map(i => [i.id, i]) : []);
  const pick = (list) => list.map(id => full.get(id)).filter(Boolean);
  const val = {
    // "Rekommenderat för dig" (befintligt fält) räknas här så att den cachas med resten och slipper fråga efter sedda titlar igen
    recommended: recommend(uid, 20, new Set(seen.keys())),
    because: seeds.map((s, n) => ({ seed: s, items: pick(ids.because[n]) })),
    topRated: pick(ids.topRated), hiddenGems: pick(ids.hiddenGems), shortTonight: pick(ids.shortTonight),
    // Kopior: samma titel kan finnas på andra hyllor utan anteckningen
    onThisDay: pick(ids.onThisDay).map(i => ({ ...i, onThisDay: notes.get(i.id) })),
    genreOfDay: genre && ids.genre.length >= 4 ? { genre, items: pick(ids.genre) } : null,
    heroIds: ids.hero
  };
  cache.set(uid, { key, val, t: Date.now() });
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return val;
}

/**
 * Utvalt överst: upp till 5 osedda titlar med bakgrundsbild och beskrivning – i första hand rekommendationerna
 * (smakprofilen), annars dagens urval bland högt betygsatta osedda titlar.
 */
export function featured(uid, recommended, heroIds, n = 5) {
  const out = recommended.filter(i => i.backdrop && i.overview && !i.watched && !(i.position > 0)).slice(0, n);
  const have = new Set(out.map(i => i.id));
  const more = heroIds.filter(id => !have.has(id)).slice(0, n - out.length);
  if (more.length) out.push(...itemsByIds(uid, more));
  return out.slice(0, n);
}

/** Fortsätt lyssna: påbörjade ljudböcker och poddavsnitt, senast lyssnade först */
export function listening(uid, n = 12) {
  const b = books.continueBooks(uid, n).map(x => ({ type: 'book', ...x }));
  const p = all(`SELECT e.id, e.podcast_id, e.title, e.duration, q.position, q.updated, p.title AS ptitle, p.image FROM podcast_progress q
    JOIN podcast_episodes e ON e.id=q.episode_id JOIN podcasts p ON p.id=e.podcast_id
    WHERE q.user_id=? AND q.played=0 AND q.position > 30 ORDER BY q.updated DESC LIMIT ?`, uid, n)
    .map(e => ({ type: 'podcast', id: e.id, podcast: e.podcast_id, podcastTitle: e.ptitle, title: e.title, image: !!e.image, duration: e.duration, position: e.position || 0, updated: e.updated }));
  return [...b, ...p].sort((x, y) => (y.updated || 0) - (x.updated || 0)).slice(0, n);
}
