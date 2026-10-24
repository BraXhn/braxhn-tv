// Smarta spellistor med egna regler (som Navidromes criteria): grupper med "alla"/"någon", en nivå av nästling,
// vitlistade fält och operatorer, sortering (även slumpad) och gräns i antal låtar eller minuter.
// Reglerna översätts till parametriserad SQL: fält och operatorer slås upp i tabellerna nedan och bara deras
// fasta SQL-uttryck hamnar i frågan – klientens text (fältnamn, operator, värden) blir aldrig en del av SQL-texten.
import { db, get, all, run } from './db.js';
import { shapeTrack } from './music.js';

const DAY = 86400;
export const MAX_RULES = 30, MAX_LISTS = 100, MAX_TRACKS = 5000;

// Fält: typ styr vilka operatorer och vilken inmatning som gäller. expr är fast SQL (alias i SELECT_FROM nedan).
export const FIELDS = {
  title: { label: 'Titel', type: 'text', expr: 't.title' },
  artist: { label: 'Artist', type: 'text', expr: 'ar.name' },
  album: { label: 'Album', type: 'text', expr: 'al.title' },
  albumartist: { label: 'Albumartist', type: 'text', expr: 'aar.name' },
  genre: { label: 'Genre', type: 'text', expr: 'al.genre' },
  year: { label: 'År', type: 'number', expr: 'al.year' },
  duration: { label: 'Längd (sekunder)', type: 'number', expr: 't.duration' },
  plays: { label: 'Antal spelningar', type: 'number', expr: 'COALESCE(pc.n, 0)' },
  lastplayed: { label: 'Senast spelad', type: 'date', expr: 'pc.last' },
  added: { label: 'Tillagd', type: 'date', expr: 't.added' },
  favorite: { label: 'Favorit', type: 'bool', expr: 'f.track_id' },
  library: { label: 'Bibliotek', type: 'library', expr: 't.library_id' },
  format: { label: 'Filformat', type: 'text', expr: 't.codec' },
  bitrate: { label: 'Bithastighet (kbit/s)', type: 'number', expr: '(t.bitrate / 1000.0)' },
  // Från ljudanalysen (server/sonic.js) – NULL för spår som inte analyserats än
  bpm: { label: 'Tempo (BPM)', type: 'number', expr: 'ts.bpm' },
  energy: { label: 'Energi (0–100)', type: 'number', expr: 'ts.energy' }
};
export const OPS = {
  is: 'är', isNot: 'är inte', contains: 'innehåller', notContains: 'innehåller inte', startsWith: 'börjar med',
  gt: 'större än', lt: 'mindre än', after: 'efter', before: 'före', between: 'mellan',
  inLast: 'inom senaste (dagar)', notInLast: 'inte inom senaste (dagar)'
};
export const OPS_BY_TYPE = {
  text: ['is', 'isNot', 'contains', 'notContains', 'startsWith'],
  number: ['is', 'isNot', 'gt', 'lt', 'between'],
  date: ['inLast', 'notInLast', 'after', 'before', 'between'],
  bool: ['is'],
  library: ['is', 'isNot']
};
// Sortering: fast SQL per nyckel; "random" blandas med ett frö (stabilt en timme, så att bilens kö stämmer med listan)
export const SORTS = {
  added: { label: 'Tillagd', expr: 't.added' },
  title: { label: 'Titel', expr: 't.title COLLATE NOCASE' },
  artist: { label: 'Artist', expr: 'ar.sort_name COLLATE NOCASE' },
  album: { label: 'Album', expr: 'al.sort_title COLLATE NOCASE' },
  year: { label: 'År', expr: 'al.year' },
  duration: { label: 'Längd', expr: 't.duration' },
  plays: { label: 'Antal spelningar', expr: 'COALESCE(pc.n, 0)' },
  lastplayed: { label: 'Senast spelad', expr: 'COALESCE(pc.last, 0)' },
  bitrate: { label: 'Bithastighet', expr: 't.bitrate' },
  bpm: { label: 'Tempo', expr: 'ts.bpm' },
  energy: { label: 'Energi', expr: 'ts.energy' },
  random: { label: 'Slumpad', expr: null }
};

const bad = (msg) => { throw Object.assign(new Error(msg), { status: 400 }); };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Datum (ÅÅÅÅ-MM-DD) till början av dagen i serverns tidszon, som unix-sekunder. */
function dayStart(s) {
  const m = DATE_RE.exec(String(s));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return Math.floor(d.getTime() / 1000);
}
const num = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) && Math.abs(n) < 1e12 ? n : null; };

/** Kontrollerar och normaliserar ett enskilt villkor. Kastar Error (status 400) med svensk text. */
function normRule(r, where) {
  if (!isObj(r)) bad(`Ogiltig regel (${where})`);
  if (!own(FIELDS, r.field)) bad(`Okänt fält (${where})`);
  const f = FIELDS[r.field];
  if (typeof r.op !== 'string' || !OPS_BY_TYPE[f.type].includes(r.op)) bad(`Operatorn passar inte fältet ${f.label} (${where})`);
  const op = r.op, v = r.value;
  let value;
  if (f.type === 'text') {
    if (typeof v !== 'string' && typeof v !== 'number') bad(`${f.label}: ange en text (${where})`);
    value = String(v).slice(0, 200);
  } else if (f.type === 'bool') {
    if (typeof v !== 'boolean') bad(`${f.label}: ange ja eller nej (${where})`);
    value = v;
  } else if (f.type === 'library') {
    value = num(v);
    if (!Number.isInteger(value) || value <= 0) bad(`${f.label}: välj ett bibliotek (${where})`);
  } else if (op === 'inLast' || op === 'notInLast') {
    value = num(v);
    if (!Number.isInteger(value) || value < 1 || value > 36500) bad(`${f.label}: ange antal dagar (1–36500) (${where})`);
  } else if (op === 'between') {
    if (!Array.isArray(v) || v.length !== 2) bad(`${f.label}: ange två värden (${where})`);
    if (f.type === 'date') {
      if (v.some(x => dayStart(x) == null)) bad(`${f.label}: ange två datum (${where})`);
      value = [String(v[0]), String(v[1])].sort();
    } else {
      const a = num(v[0]), b = num(v[1]);
      if (a == null || b == null) bad(`${f.label}: ange två tal (${where})`);
      value = [Math.min(a, b), Math.max(a, b)];
    }
  } else if (f.type === 'date') {
    if (dayStart(v) == null) bad(`${f.label}: ange ett datum (${where})`);
    value = String(v);
  } else {
    value = num(v);
    if (value == null) bad(`${f.label}: ange ett tal (${where})`);
  }
  return { field: r.field, op, value };
}
const normMatch = (m) => m === 'any' ? 'any' : 'all';

/**
 * Kontrollerar en hel definition och returnerar en normaliserad kopia med bara kända nycklar:
 * { match, rules: [regel | { match, rules: [regel] }], sort, order, limit, limitMinutes }.
 */
export function normalize(d) {
  if (!isObj(d)) bad('Ogiltig definition');
  if (d.rules != null && !Array.isArray(d.rules)) bad('Reglerna måste vara en lista');
  let n = 0;
  const rules = (d.rules || []).map((r, i) => {
    if (isObj(r) && Array.isArray(r.rules)) { // grupp – bara en nivå
      const inner = r.rules.map((x, j) => {
        if (isObj(x) && Array.isArray(x.rules)) bad('Grupper kan bara nästlas en nivå');
        if (++n > MAX_RULES) bad(`Högst ${MAX_RULES} regler`);
        return normRule(x, `regel ${i + 1}.${j + 1}`);
      });
      return { match: normMatch(r.match), rules: inner };
    }
    if (++n > MAX_RULES) bad(`Högst ${MAX_RULES} regler`);
    return normRule(r, `regel ${i + 1}`);
  });
  const sort = d.sort == null ? 'added' : d.sort;
  if (!own(SORTS, sort)) bad('Okänd sortering');
  const order = d.order === 'asc' ? 'asc' : 'desc';
  const lim = (v, max, what) => {
    if (v == null || v === '' || v === 0) return null;
    const x = num(v);
    if (!Number.isInteger(x) || x < 1 || x > max) bad(`${what} måste vara ett heltal 1–${max}`);
    return x;
  };
  const limit = lim(d.limit, MAX_TRACKS, 'Gränsen i antal låtar');
  const limitMinutes = lim(d.limitMinutes, 100000, 'Gränsen i minuter');
  if (limit && limitMinutes) bad('Välj gräns i antal låtar eller i minuter, inte båda');
  return { match: normMatch(d.match), rules, sort, order, limit, limitMinutes };
}

const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
/** Ett villkor till SQL-fragment + parametrar. Bara fasta uttryck ur FIELDS hamnar i texten. */
function ruleSql(r, at, P) {
  const f = FIELDS[r.field], e = f.expr, v = r.value;
  if (f.type === 'text') {
    const c = `COALESCE(${e}, '')`;
    switch (r.op) {
      case 'is': P.push(v); return `${c} = ? COLLATE NOCASE`;
      case 'isNot': P.push(v); return `${c} <> ? COLLATE NOCASE`;
      case 'contains': P.push(`%${likeEsc(v)}%`); return `${c} LIKE ? ESCAPE '\\'`;
      case 'notContains': P.push(`%${likeEsc(v)}%`); return `${c} NOT LIKE ? ESCAPE '\\'`;
      case 'startsWith': P.push(`${likeEsc(v)}%`); return `${c} LIKE ? ESCAPE '\\'`;
    }
  }
  if (f.type === 'bool') return v ? `${e} IS NOT NULL` : `${e} IS NULL`;
  if (f.type === 'library') { P.push(v); return r.op === 'is' ? `${e} = ?` : `${e} <> ?`; }
  if (f.type === 'date') {
    switch (r.op) {
      case 'inLast': P.push(at - v * DAY); return `${e} >= ?`;
      case 'notInLast': P.push(at - v * DAY); return `(${e} IS NULL OR ${e} < ?)`;
      case 'after': P.push(dayStart(v) + DAY); return `${e} >= ?`;
      case 'before': P.push(dayStart(v)); return `${e} < ?`;
      case 'between': P.push(dayStart(v[0]), dayStart(v[1]) + DAY); return `(${e} >= ? AND ${e} < ?)`;
    }
  }
  switch (r.op) { // tal
    case 'is': P.push(v); return `${e} = ?`;
    case 'isNot': P.push(v); return `(${e} IS NULL OR ${e} <> ?)`;
    case 'gt': P.push(v); return `${e} > ?`;
    case 'lt': P.push(v); return `${e} < ?`;
    case 'between': P.push(v[0], v[1]); return `${e} BETWEEN ? AND ?`;
  }
  bad('Ogiltig regel');
}
function groupSql(match, rules, at, P) {
  const parts = rules.map(r => r.rules ? (r.rules.length ? `(${groupSql(r.match, r.rules, at, P)})` : null) : `(${ruleSql(r, at, P)})`).filter(Boolean);
  if (!parts.length) return '1';
  return parts.join(match === 'any' ? ' OR ' : ' AND ');
}

const SELECT_FROM = `SELECT t.id, t.title, t.track_no, t.disc_no, t.duration, t.codec, t.album_id, al.title AS album, al.cover, ar.name AS artist, t.artist_id,
  t.rg_track, t.rg_album, t.rg_peak, f.track_id AS fav FROM tracks t
  JOIN libraries lb ON lb.id=t.library_id AND lb.type='music'
  LEFT JOIN albums al ON al.id=t.album_id LEFT JOIN artists ar ON ar.id=t.artist_id LEFT JOIN artists aar ON aar.id=al.artist_id
  LEFT JOIN (SELECT track_id, COUNT(*) AS n, MAX(ts) AS last FROM track_plays WHERE user_id=? GROUP BY track_id) pc ON pc.track_id=t.id
  LEFT JOIN favorites f ON f.track_id=t.id AND f.user_id=?
  LEFT JOIN track_sonic ts ON ts.track_id=t.id AND ts.ok=1`;

/**
 * Bygger frågan för en (redan normaliserad) definition. Exporteras för tester.
 * uid = den som lyssnar (spelningar och favoriter räknas för den användaren, även i en delad lista).
 */
export function compile(def, uid, { at = Math.floor(Date.now() / 1000), seed = 0 } = {}) {
  const P = [uid, uid];
  const where = groupSql(def.match, def.rules, at, P);
  const dir = def.order === 'asc' ? 'ASC' : 'DESC';
  let order;
  if (def.sort === 'random') { order = '(t.id * 2654435761 + ?) % 1000003, t.id'; P.push(seed); }
  else order = `${SORTS[def.sort].expr} ${dir}, al.sort_title, t.disc_no, t.track_no, t.id`;
  const limit = def.limit || MAX_TRACKS;
  return { sql: `${SELECT_FROM} WHERE ${where} ORDER BY ${order} LIMIT ?`, params: [...P, limit], countSql: `SELECT COUNT(*) AS n FROM (${SELECT_FROM} WHERE ${where})`, countParams: P.slice(0, def.sort === 'random' ? -1 : undefined) };
}

/** Kör en definition: spårlista (formad som i resten av musik-API:t). */
export function evaluate(def, uid, opts = {}) {
  const at = opts.at ?? Math.floor(Date.now() / 1000);
  const q = compile(def, uid, { at, seed: opts.seed ?? Math.floor(at / 3600) });
  // Frågorna förbereds direkt (inte via statement-cachen): varje regeluppsättning ger egen SQL-text
  const rows = db.prepare(q.sql).all(...q.params);
  let tracks = rows.map(r => shapeTrack(r, { has: () => r.fav != null }));
  if (def.limitMinutes) {
    const max = def.limitMinutes * 60, out = [];
    let sum = 0;
    for (const t of tracks) { if (sum + (t.duration || 0) > max && out.length) break; sum += t.duration || 0; out.push(t); if (sum >= max) break; }
    tracks = out;
  }
  return tracks;
}
/** Antal spår som matchar reglerna (utan gräns). */
export function countMatches(def, uid, at = Math.floor(Date.now() / 1000)) {
  const q = compile(def, uid, { at });
  return db.prepare(q.countSql).get(...q.countParams).n;
}

// ---------------- lagring ----------------
const parseDef = (s) => { try { return normalize(JSON.parse(s)); } catch { return normalize({}); } };
const shape = (r, uid) => ({ id: r.id, name: r.name, shared: !!r.shared, mine: r.user_id === uid, owner: r.owner ?? null, updated: r.updated, ...parseDef(r.def) });
const LIST_SQL = 'SELECT s.*, u.name AS owner FROM smart_playlists s LEFT JOIN users u ON u.id=s.user_id';
/** Egna listor och listor som andra delat. */
export function listFor(uid) {
  return all(`${LIST_SQL} WHERE s.user_id=? OR s.shared=1 ORDER BY s.user_id<>? , s.name COLLATE NOCASE`, uid, uid).map(r => shape(r, uid));
}
/** En lista om användaren får se den (egen eller delad), annars null. */
export function getFor(id, uid) {
  const r = get(`${LIST_SQL} WHERE s.id=? AND (s.user_id=? OR s.shared=1)`, id, uid);
  return r ? shape(r, uid) : null;
}
function cleanName(name) {
  const nm = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!nm) bad('Namn krävs');
  return nm;
}
export function create(uid, b) {
  if (!isObj(b)) bad('Ogiltig definition');
  const name = cleanName(b.name), def = normalize(b);
  if (get('SELECT COUNT(*) AS n FROM smart_playlists WHERE user_id=?', uid).n >= MAX_LISTS) bad('För många smarta spellistor');
  const t = Date.now();
  const id = Number(run('INSERT INTO smart_playlists(user_id,name,def,shared,created,updated) VALUES(?,?,?,?,?,?)', uid, name, JSON.stringify(def), b.shared ? 1 : 0, t, t).lastInsertRowid);
  clearCache();
  return id;
}
/** Bara ägaren får ändra. Returnerar false om listan inte finns (eller tillhör någon annan). */
export function update(id, uid, b) {
  const cur = get('SELECT * FROM smart_playlists WHERE id=? AND user_id=?', id, uid);
  if (!cur) return false;
  if (!isObj(b)) bad('Ogiltig definition');
  const name = b.name !== undefined ? cleanName(b.name) : cur.name;
  const def = b.rules !== undefined || b.sort !== undefined || b.match !== undefined || b.limit !== undefined || b.limitMinutes !== undefined || b.order !== undefined
    ? normalize({ ...JSON.parse(cur.def), ...b }) : JSON.parse(cur.def);
  const shared = b.shared !== undefined ? (b.shared ? 1 : 0) : cur.shared;
  run('UPDATE smart_playlists SET name=?, def=?, shared=?, updated=? WHERE id=?', name, JSON.stringify(def), shared, Math.max(Date.now(), cur.updated + 1), id);
  clearCache();
  return true;
}
export function remove(id, uid) {
  const n = Number(run('DELETE FROM smart_playlists WHERE id=? AND user_id=?', id, uid).changes);
  clearCache();
  return n > 0;
}

// ---------------- uppdateras när listan öppnas, med kort cache ----------------
// Resultatet räknas om när listan öppnas; samma användare och version av listan återanvänds i 30 s
// (musikhemmet, bilens bläddring och kön hämtar ofta samma lista flera gånger i rad).
const cache = new Map(); // "uid:id:updated" -> { v, t }
const TTL = 30e3;
export function clearCache() { cache.clear(); }
/** Spåren i lista id för användaren, eller null om listan inte finns/inte är synlig. */
export function tracksFor(id, uid) {
  const l = getFor(id, uid);
  if (!l) return null;
  const k = `${uid}:${id}:${l.updated}`, c = cache.get(k);
  if (c && Date.now() - c.t < TTL) return { list: l, tracks: c.v };
  const v = evaluate(l, uid, { seed: id * 7919 + Math.floor(Date.now() / 3600e3) });
  cache.set(k, { v, t: Date.now() });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return { list: l, tracks: v };
}
/** Fält, operatorer och sorteringar för redigeraren i webben. */
export function catalog() {
  return {
    fields: Object.entries(FIELDS).map(([id, f]) => ({ id, label: f.label, type: f.type, ops: OPS_BY_TYPE[f.type] })),
    ops: OPS, sorts: Object.entries(SORTS).map(([id, s]) => ({ id, label: s.label })), maxRules: MAX_RULES, maxTracks: MAX_TRACKS
  };
}
