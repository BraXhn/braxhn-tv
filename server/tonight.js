// Kvällsvalet: hushållet röstar fram kvällens film eller serie tillsammans.
//
// En profil startar ett kvällsval (lobbyn) och väljer filter; andra går med med en sexsiffrig kod (eller QR-koden
// med samma kod) eller direkt från sin profil när de hör till samma hushåll. När värden börjar räknas en lista med
// förslag fram – samma ordning för alla – och var och en sveper ja/nej. När tillräckligt många (alla eller en
// majoritet, valbart) gillat samma titel är det en match, som alla ser direkt via SSE (som Titta tillsammans i
// party.js och Spela på… i remote.js). Allt ligger bara i minnet och städas bort efter en stund.
//
// Integritet och barnprofiler:
//   - varje förslag måste vara tillåtet för VARJE deltagare (allowedFor: åldersgräns och biblioteksbehörighet), så
//     åldersgränsen blir i praktiken den lägsta bland deltagarna. Går någon med senare tas det som inte är tillåtet
//     för den profilen bort ur listan för alla.
//   - "osedda" tar bort det som någon deltagare sett eller börjat på – men ingen får veta vem som sett vad, och
//     ordningen (smakprofiler, betyg, historik) skickas aldrig ut, bara själva listan.
//   - under röstningen syns bara hur långt var och en kommit; vem som gillat vad syns aldrig, bara antalet för
//     topplistan när ingen match blev av.
import crypto from 'node:crypto';
import { get, all } from './db.js';

// allowedFor, ageFilter och genreProfile (http/context.js) kopplas in av routes/tonight.js – serverns moduler
// importerar inte från http/. Tills de är inkopplade är inget tillåtet.
let H = { allowedFor: () => false, ageFilter: () => ({ sql: ' AND 0', params: [] }), genreProfile: () => ({}) };
export const setHelpers = (h) => { H = { ...H, ...h }; };

let clock = () => Date.now();
/** För tester: egen klocka (null = riktiga tiden) */
export const _setClock = (fn) => { clock = fn || (() => Date.now()); };
const now = () => clock();

export const LIMITS = {
  MAX_MEMBERS: 12,        // deltagare per kvällsval
  MAX_PER_USER: 2,        // öppna kvällsval som en profil är värd för (det äldsta stängs)
  MAX_TOTAL: 200,         // på hela servern
  TTL: 4 * 3600e3,        // ett kvällsval lever högst så här länge
  IDLE: 30 * 60e3,        // ingen ansluten så här länge → stängs
  DONE: 30 * 60e3,        // efter en match stängs det efter så här lång tid
  CODE_FAILS: 10,         // felaktiga koder per profil och 10 minuter
  MAX_BUFFER: 256 * 1024  // en klient som inte läser kastas ut vid städningen
};
const sessions = new Map(); // id -> kvällsval
const byCode = new Map();   // kod -> id
const fails = new Map();    // uid -> [tidpunkter för felaktiga koder]
const voteRate = new Map(); // uid -> [tidpunkter]

const err = (status, message) => Object.assign(new Error(message), { status });
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const userRow = (uid) => get('SELECT id, name, parent_id, max_age FROM users WHERE id=?', uid);
const rootOf = (uid) => { const u = userRow(uid); return u ? (u.parent_id || u.id) : null; };
const parseGenres = (g) => { try { const a = JSON.parse(g || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };

// ---------- filter ----------
const KINDS = ['movie', 'show'];
const SIZES = [10, 20, 30];
/** Tvättar klientens filter till ett fast objekt (okända fält och värden ignoreras) */
export function parseFilters(b = {}) {
  b = b && typeof b === 'object' ? b : {};
  const ints = (a, max) => Array.isArray(a) ? [...new Set(a.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, max) : [];
  const kinds = Array.isArray(b.kinds) ? KINDS.filter(k => b.kinds.includes(k)) : [];
  const mm = Number(b.maxMinutes), mr = Number(b.minRating);
  return {
    kinds: kinds.length ? kinds : [...KINDS],
    libs: ints(b.libs, 50),
    genres: Array.isArray(b.genres) ? [...new Set(b.genres.map(g => clean(g, 60)).filter(Boolean))].slice(0, 20) : [],
    maxMinutes: Number.isFinite(mm) && mm > 0 ? Math.max(30, Math.min(600, Math.round(mm))) : null,
    minRating: Number.isFinite(mr) && mr > 0 ? Math.min(10, Math.round(mr * 10) / 10) : null,
    unseen: b.unseen !== false,
    rule: b.rule === 'majority' ? 'majority' : 'all',
    size: SIZES.includes(Number(b.size)) ? Number(b.size) : 20
  };
}

// ---------- kandidater ----------
/** Titlar (huvudrader: film eller serie) som profilen sett eller börjat på */
function seenBy(uid) {
  return new Set(all(`SELECT DISTINCT COALESCE(e.version_of, e.parent_id, e.id) AS id FROM progress q JOIN items e ON e.id=q.item_id
    WHERE q.user_id=? AND (q.watched=1 OR q.position > 60)`, uid).map(r => r.id));
}
/** Alla titlar som passar filtren och är tillåtna för alla deltagare (lätta kolumner) */
function pool(s) {
  const f = s.filters, members = [...s.members.keys()];
  const age = H.ageFilter(s.host);
  const w = [`i.kind IN (${f.kinds.map(() => '?').join(',')})`, "i.library_id IN (SELECT id FROM libraries WHERE type IN ('movie','show'))", 'i.version_of IS NULL',
    "(i.kind='movie' OR EXISTS (SELECT 1 FROM items e WHERE e.parent_id=i.id))"];
  const p = [...f.kinds];
  if (f.libs.length) { w.push(`i.library_id IN (${f.libs.map(() => '?').join(',')})`); p.push(...f.libs); }
  if (f.genres.length) { w.push(`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(i.genres) THEN i.genres ELSE '[]' END) g WHERE g.value IN (${f.genres.map(() => '?').join(',')}))`); p.push(...f.genres); }
  if (f.minRating != null) { w.push('i.rating >= ?'); p.push(f.minRating); }
  // Serier: ett avsnitts genomsnittliga längd
  if (f.maxMinutes) { w.push("COALESCE(CASE WHEN i.kind='show' THEN (SELECT AVG(e.duration) FROM items e WHERE e.parent_id=i.id) ELSE i.duration END, 0) <= ?"); p.push(f.maxMinutes * 60); }
  const rows = all(`SELECT i.id, i.kind, i.library_id, i.age, i.parent_id, i.version_of, i.genres, i.rating, i.collection_id
    FROM items i LEFT JOIN items s ON s.id=i.parent_id WHERE ${w.join(' AND ')}${age.sql} ORDER BY i.id LIMIT 5000`, ...p, ...age.params);
  const seen = f.unseen ? members.map(seenBy) : [];
  return rows.filter(r => members.every(u => H.allowedFor(u, r)) && !seen.some(x => x.has(r.id)));
}
/** Får profilen uid ha titeln id i listan (samma regler som pool, för den som går med senare)? */
function fitsFor(s, uid, ids) {
  if (!ids.length) return new Set();
  const rows = all(`SELECT id, kind, library_id, age, parent_id, version_of FROM items WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const seen = s.filters.unseen ? seenBy(uid) : new Set();
  return new Set(rows.filter(r => H.allowedFor(uid, r) && !seen.has(r.id)).map(r => r.id));
}

// ---------- smak och ordning ----------
/** Profilens smak: genrevikter (det den sett och Min lista, egna betyg), egna betyg per titel och samlingar den gillat */
function tasteOf(uid) {
  const raw = H.genreProfile(uid) || {};
  const tot = Object.values(raw).reduce((a, b) => a + b, 0);
  const g = {};
  for (const [k, v] of Object.entries(raw)) g[k] = tot ? v / tot : 0;
  const own = new Map(), cols = new Map();
  // Egna betyg (halva stjärnor 2–10): 4–5 stjärnor drar upp genren och samlingen, 1–2 drar ner
  for (const r of all(`SELECT r.value, COALESCE(i.parent_id, i.version_of, i.id) AS main, COALESCE(s.genres, i.genres) AS g, COALESCE(s.collection_id, i.collection_id) AS col
    FROM item_ratings r JOIN items i ON i.id=r.item_id LEFT JOIN items s ON s.id=i.parent_id WHERE r.user_id=?`, uid)) {
    const d = (r.value - 6) / 4;
    for (const x of parseGenres(r.g)) g[x] = (g[x] || 0) + d * 0.15;
    own.set(r.main, d);
    if (r.col) cols.set(r.col, Math.max(cols.get(r.col) ?? -1, d));
  }
  // Samlingar (filmserier) där profilen sett en film: nästa del är ett bra förslag
  for (const r of all(`SELECT DISTINCT i.collection_id AS col FROM progress q JOIN items i ON i.id=q.item_id
    WHERE q.user_id=? AND q.watched=1 AND i.collection_id IS NOT NULL`, uid)) if (!cols.has(r.col)) cols.set(r.col, 0.5);
  return { g, own, cols };
}
/** Hushållets gemensamma smak (alla profiler under huvudkontot) – bara genrevikter */
function householdTaste(root) {
  const g = {};
  for (const u of all('SELECT id FROM users WHERE id=? OR parent_id=?', root, root)) for (const [k, v] of Object.entries(H.genreProfile(u.id) || {})) g[k] = (g[k] || 0) + v;
  const tot = Object.values(g).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(g)) g[k] = tot ? g[k] / tot : 0;
  return { g, own: new Map(), cols: new Map() };
}
// Liten deterministisk slump (samma frö → samma ordning, för tester och för att alla ska få samma lista)
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const affinity = (t, gs) => gs.length ? gs.reduce((a, x) => a + (t.g[x] || 0), 0) / Math.sqrt(gs.length) : 0;
/**
 * Ordningen på förslagen (ren funktion). cands: { id, g: genrer, rating, col }; tastes: en smak per deltagare.
 * Poäng = 0,6 × medel + 0,4 × lägsta bland deltagarna (ingen ska behöva svepa förbi sådant hen ogillar) + hushållets
 * smak + TMDB-betyg + slump. Sedan variation: genrer som just förekommit dras ned, och var femte plats är ett
 * jokerkort längre ner i listan.
 */
export function rank(cands, { tastes = [], house = null, seed = 1, max = 60 } = {}) {
  const rnd = prng(seed);
  const scored = cands.map(c => {
    const per = tastes.map(t => affinity(t, c.g) + (t.own.has(c.id) ? t.own.get(c.id) * 0.5 : 0) + (c.col != null && t.cols.has(c.col) ? 0.25 + 0.25 * t.cols.get(c.col) : 0));
    const mean = per.length ? per.reduce((a, b) => a + b, 0) / per.length : 0, min = per.length ? Math.min(...per) : 0;
    return { id: c.id, g: c.g, s: 0.6 * mean + 0.4 * min + (house ? 0.3 * affinity(house, c.g) : 0) + (c.rating ?? 6) / 25 + rnd() * 0.35 };
  }).sort((a, b) => b.s - a.s || a.id - b.id);
  const out = [], recent = [];
  while (out.length < max && scored.length) {
    let pick;
    if (out.length % 5 === 4 && scored.length > 12) pick = 10 + Math.floor(rnd() * Math.min(scored.length - 10, max * 2));
    else {
      pick = 0; let best = -Infinity;
      for (let i = 0; i < Math.min(12, scored.length); i++) {
        const x = scored[i], overlap = x.g.filter(y => recent.includes(y)).length;
        const v = x.s - 0.12 * overlap;
        if (v > best) { best = v; pick = i; }
      }
    }
    const [x] = scored.splice(pick, 1);
    out.push(x.id);
    recent.push(...x.g); while (recent.length > 6) recent.shift();
  }
  return out;
}

// ---------- kvällsval ----------
const needOf = (s) => s.filters.rule === 'majority' ? Math.floor(s.members.size / 2) + 1 : s.members.size;
function memberOf(user) {
  const u = userRow(user.id);
  return { id: user.id, name: clean(user.name || u?.name, 40) || '?', kid: u?.max_age != null, maxAge: u?.max_age ?? null, joined: now() };
}
/** Startar ett kvällsval med user som värd */
export function create(user, filters) {
  const mine = [...sessions.values()].filter(s => s.host === user.id).sort((a, b) => a.created - b.created);
  while (mine.length >= LIMITS.MAX_PER_USER) close(mine.shift());
  if (sessions.size >= LIMITS.MAX_TOTAL) throw err(503, 'För många kvällsval pågår – försök igen senare');
  const id = crypto.randomBytes(9).toString('base64url');
  let code;
  do code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); while (byCode.has(code));
  const s = { id, code, host: user.id, hostName: memberOf(user).name, household: rootOf(user.id), created: now(), phase: 'lobby', filters: parseFilters(filters),
    seed: crypto.randomInt(1, 2 ** 31), members: new Map(), deck: [], rest: [], votes: new Map(), match: null, matchedAt: 0, party: null,
    clients: new Set(), empty: now(), fits: null };
  s.members.set(user.id, memberOf(user));
  sessions.set(id, s); byCode.set(code, id);
  return s;
}
export const getSession = (id) => sessions.get(String(id)) || null;
/** Kvällsvalet om profilen är med (annars null) */
export function sessionFor(user, id) {
  const s = getSession(id);
  return s && s.members.has(user.id) ? s : null;
}
/** Öppna kvällsval i profilens hushåll (för "Gå med" utan kod) */
export function listFor(user) {
  const root = rootOf(user.id);
  return [...sessions.values()].filter(s => s.household === root && s.phase !== 'matched')
    .sort((a, b) => b.created - a.created)
    .map(s => ({ id: s.id, host: s.hostName, phase: s.phase, members: s.members.size, joined: s.members.has(user.id) }));
}
/** Går med med koden (från QR-koden eller inskriven). Felaktiga koder begränsas per profil. */
export function joinByCode(user, code) {
  const t = now(), f = (fails.get(user.id) || []).filter(x => t - x < 600e3);
  if (f.length >= LIMITS.CODE_FAILS) { fails.set(user.id, f); throw err(429, 'För många felaktiga koder – vänta en stund'); }
  const c = String(code ?? '').replace(/\D/g, '');
  const s = c.length === 6 ? getSession(byCode.get(c)) : null;
  if (!s) { f.push(t); fails.set(user.id, f); throw err(404, 'Det finns inget kvällsval med den koden'); }
  join(s, user);
  return s;
}
/** Direkt från profilen: bara inom samma hushåll */
export function joinHousehold(user, id) {
  const s = getSession(id);
  if (!s || s.household !== rootOf(user.id)) throw err(404, 'Kvällsvalet finns inte längre');
  join(s, user);
  return s;
}
function join(s, user) {
  if (s.members.has(user.id)) return;
  if (s.members.size >= LIMITS.MAX_MEMBERS) throw err(409, 'Kvällsvalet är fullt');
  if (s.phase === 'matched') throw err(409, 'Kvällsvalet är redan avgjort');
  s.members.set(user.id, memberOf(user));
  s.fits = null;
  if (s.phase === 'voting') {
    // Det som inte är tillåtet (eller som den nya deltagaren sett) försvinner ur listan för alla
    const ok = fitsFor(s, user.id, [...s.deck, ...s.rest]);
    const gone = s.deck.filter(id => !ok.has(id));
    s.deck = s.deck.filter(id => ok.has(id)); s.rest = s.rest.filter(id => ok.has(id));
    for (const id of gone) s.votes.delete(id);
    if (gone.length) deckChanged(s);
  }
  broadcast(s);
}
/** Lämnar kvällsvalet. Värden lämnar över till den som varit med längst; tomt → stängs. */
export function leave(s, uid) {
  if (!s.members.delete(uid)) return;
  for (const v of s.votes.values()) v.delete(uid);
  for (const c of [...s.clients]) if (c.uid === uid) { s.clients.delete(c); try { c.res.write('event: left\ndata: {}\n\n'); c.res.end(); } catch {} }
  if (!s.members.size) return close(s);
  if (s.host === uid) { const next = [...s.members.values()].sort((a, b) => a.joined - b.joined)[0]; s.host = next.id; s.hostName = next.name; }
  s.fits = null;
  checkMatch(s);
  broadcast(s);
}
export function setFilters(s, uid, b) {
  if (s.host !== uid) throw err(403, 'Bara den som startade kvällsvalet kan ändra filtren');
  if (s.phase !== 'lobby') throw err(409, 'Röstningen har redan börjat');
  s.filters = parseFilters(b); s.fits = null;
  broadcast(s);
  return s.filters;
}
/** Räknar fram förslagen för deltagarna som är med nu och börjar röstningen */
export function start(s, uid) {
  if (s.host !== uid) throw err(403, 'Bara den som startade kvällsvalet kan börja');
  if (s.phase !== 'lobby') throw err(409, 'Röstningen har redan börjat');
  const cands = pool(s).map(r => ({ id: r.id, g: parseGenres(r.genres), rating: r.rating, col: r.collection_id }));
  if (!cands.length) throw err(409, 'Inga titlar passar filtren för alla som är med – ändra filtren');
  const ranked = rank(cands, { tastes: [...s.members.keys()].map(tasteOf), house: s.household ? householdTaste(s.household) : null, seed: s.seed, max: s.filters.size + 40 });
  s.deck = ranked.slice(0, s.filters.size); s.rest = ranked.slice(s.filters.size);
  s.phase = 'voting';
  deckChanged(s); broadcast(s);
}
/** Fler förslag (värden), t.ex. när ingen match blev av */
export function more(s, uid) {
  if (s.host !== uid) throw err(403, 'Bara den som startade kvällsvalet kan hämta fler förslag');
  if (s.phase !== 'voting') throw err(409, 'Röstningen pågår inte');
  if (!s.rest.length) throw err(409, 'Det finns inga fler förslag – ändra filtren i ett nytt kvällsval');
  s.deck.push(...s.rest.splice(0, 10));
  deckChanged(s); broadcast(s);
}
/** En röst: like true/false, null = ångra */
export function vote(s, uid, item, like) {
  if (s.phase !== 'voting') throw err(409, 'Röstningen pågår inte');
  const id = Number(item);
  if (!s.deck.includes(id)) throw err(404, 'Titeln finns inte bland förslagen');
  const t = now(), r = (voteRate.get(uid) || []).filter(x => t - x < 10e3);
  if (r.length >= 60) throw err(429, 'För många röster – vänta en stund');
  r.push(t); voteRate.set(uid, r);
  let v = s.votes.get(id);
  if (!v) { v = new Map(); s.votes.set(id, v); }
  if (like == null) v.delete(uid); else v.set(uid, !!like);
  checkMatch(s);
  broadcast(s);
}
/** Värden väljer en titel ur förslagen (t.ex. ur topplistan när ingen match blev av) */
export function pick(s, uid, item) {
  if (s.host !== uid) throw err(403, 'Bara den som startade kvällsvalet kan välja');
  if (s.phase !== 'voting') throw err(409, 'Röstningen pågår inte');
  const id = Number(item);
  if (!s.deck.includes(id)) throw err(404, 'Titeln finns inte bland förslagen');
  setMatch(s, id, true);
  broadcast(s);
}
const likesOf = (s, id) => { let n = 0; for (const [u, l] of s.votes.get(id) || []) if (l && s.members.has(u)) n++; return n; };
function setMatch(s, id, picked = false) {
  s.match = { id, likes: likesOf(s, id), of: s.members.size, picked, by: picked ? s.hostName : null };
  s.phase = 'matched'; s.matchedAt = now();
}
/** Match: den titel bland förslagen som flest gillat, om den når gränsen (alla eller majoritet) */
export function checkMatch(s) {
  if (s.phase !== 'voting' || !s.members.size) return null;
  const need = needOf(s);
  let best = null, bl = 0;
  for (const id of s.deck) { const n = likesOf(s, id); if (n >= need && n > bl) { best = id; bl = n; } }
  if (best != null) setMatch(s, best);
  return best;
}
export function setParty(s, rid) { s.party = rid; broadcast(s); }
export function close(s) {
  if (!s || !sessions.has(s.id)) return;
  sessions.delete(s.id); byCode.delete(s.code);
  for (const c of s.clients) { try { c.res.write('event: closed\ndata: {}\n\n'); c.res.end(); } catch {} }
  s.clients.clear();
}

// ---------- läget som skickas ----------
const votedBy = (s, uid) => { let n = 0; for (const id of s.deck) if (s.votes.get(id)?.has(uid)) n++; return n; };
const allDone = (s) => s.deck.length > 0 && [...s.members.keys()].every(u => votedBy(s, u) === s.deck.length);
/** Vad ska profilen spela om matchen är en serie? Påbörjat avsnitt, annars första osedda, annars första. */
function playFor(uid, id) {
  const it = get('SELECT id, kind FROM items WHERE id=?', id);
  if (!it) return null;
  if (it.kind !== 'show') return { id: it.id, position: get('SELECT position FROM progress WHERE user_id=? AND item_id=? AND watched=0', uid, it.id)?.position || 0 };
  const e = get(`SELECT e.id, COALESCE(p.position, 0) AS pos FROM items e LEFT JOIN progress p ON p.item_id=e.id AND p.user_id=?
    WHERE e.parent_id=? AND COALESCE(p.watched, 0)=0 ORDER BY (COALESCE(p.position, 0) > 0) DESC, e.season, e.episode LIMIT 1`, uid, id)
    || get('SELECT id, 0 AS pos FROM items WHERE parent_id=? ORDER BY season, episode LIMIT 1', id);
  return e ? { id: e.id, position: e.pos || 0 } : null;
}
/** Läget för en deltagare. Visar aldrig vem som röstat vad – bara hur långt var och en kommit. */
export function view(s, uid) {
  const members = [...s.members.values()].sort((a, b) => a.joined - b.joined).map(m => ({ name: m.name, kid: m.kid, self: m.id === uid, host: m.id === s.host,
    voted: votedBy(s, m.id), online: [...s.clients].some(c => c.uid === m.id) }));
  const ages = [...s.members.values()].map(m => m.maxAge).filter(a => a != null);
  const mine = {};
  for (const id of s.deck) { const v = s.votes.get(id)?.get(uid); if (v != null) mine[id] = v; }
  const out = { id: s.id, code: s.code, phase: s.phase, isHost: s.host === uid, host: s.hostName, filters: s.filters, need: needOf(s),
    maxAge: ages.length ? Math.min(...ages) : null, members, total: s.deck.length, done: allDone(s), more: s.rest.length > 0, votes: mine,
    match: null, top: null, party: s.party, expires: Math.floor((s.created + LIMITS.TTL) / 1000) };
  if (s.phase === 'lobby') {
    const key = [...s.members.keys()].join(',') + JSON.stringify(s.filters);
    if (s.fits?.key !== key) s.fits = { key, n: pool(s).length };
    out.fits = s.fits.n;
  }
  if (s.match) out.match = { ...s.match, play: playFor(uid, s.match.id) };
  else if (out.done) out.top = s.deck.map(id => ({ id, likes: likesOf(s, id) })).filter(x => x.likes > 0).sort((a, b) => b.likes - a.likes).slice(0, 5);
  return out;
}

// ---------- realtid (SSE) ----------
function write(c, event, data) { try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }
function broadcast(s) { for (const c of s.clients) write(c, 'state', view(s, c.uid)); }
function deckChanged(s) { for (const c of s.clients) write(c, 'deck', { total: s.deck.length }); }
export function subscribe(s, user, req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const c = { res, uid: user.id, hb: setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000) };
  s.clients.add(c);
  write(c, 'state', view(s, user.id));
  broadcast(s); // de andra ser att deltagaren är ansluten
  req.on('close', () => {
    clearInterval(c.hb);
    if (!s.clients.delete(c)) return;
    if (!s.clients.size) s.empty = now();
    broadcast(s);
  });
}

/** Städning: gamla, övergivna och avgjorda kvällsval stängs; döda anslutningar kastas ut */
export function sweep() {
  const t = now();
  for (const s of [...sessions.values()]) {
    for (const c of [...s.clients]) if (c.res.destroyed || c.res.writableEnded || c.res.writableLength > LIMITS.MAX_BUFFER) {
      clearInterval(c.hb); s.clients.delete(c); try { c.res.destroy(); } catch {}
      if (!s.clients.size) s.empty = t;
    }
    if (t - s.created > LIMITS.TTL || (!s.clients.size && t - s.empty > LIMITS.IDLE) || (s.phase === 'matched' && t - s.matchedAt > LIMITS.DONE)) close(s);
  }
  for (const m of [fails, voteRate]) for (const [k, a] of m) if (!a.length || t - a[a.length - 1] > 600e3) m.delete(k);
}
setInterval(sweep, 60e3).unref();

// För tester
export const _sessions = sessions;
