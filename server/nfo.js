// NFO-filer från Kodi, Jellyfin, Emby, tinyMediaManager m.fl. (movie.nfo, <film>.nfo, tvshow.nfo, <avsnitt>.nfo).
// Tolkas med indexOf och begränsade mönster – som RSS-tolkningen i podcasts.js – utan någon XML-motor: inga
// egna entiteter (DOCTYPE expanderas aldrig), ingen regex som kan backa katastrofalt, storleksgräns på filen och
// gränser för antal element. Allt som inte går att läsa blir null, aldrig ett undantag.

export const NFO_MAX = 512 * 1024; // större NFO-filer läses inte (riktiga är några kB)
const MAX_TAG = 4000;              // längsta öppningstagg (attribut)
const MAX_LIST = 60;               // genrer, studior och id per fil
const MAX_ACTORS = 50;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEnt = (s) => s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
  try { return e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m; }
  catch { return m; }
});
/** CDATA, entiteter och ev. HTML i värdet → ren text */
function text(raw) {
  let s = String(raw), out = '';
  // CDATA med indexOf (inte ett lat regex över hela texten)
  for (let i = 0; ;) {
    const a = s.indexOf('<![CDATA[', i);
    if (a < 0) { out += decodeEnt(s.slice(i).replace(/<[^<>]{0,2000}>/g, '')); break; }
    out += decodeEnt(s.slice(i, a).replace(/<[^<>]{0,2000}>/g, ''));
    const b = s.indexOf(']]>', a + 9);
    if (b < 0) { out += s.slice(a + 9); break; }
    out += s.slice(a + 9, b).replace(/<[^<>]{0,2000}>/g, ''); i = b + 3;
  }
  return out.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Gemener bara för A–Z: samma längd som originalet (toLowerCase kan ändra längden för vissa tecken och då
// skulle indexen peka fel)
const lowerAscii = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** Ett dokument (eller en del av det) med förberäknade gemener */
function doc(x) { return { x, lx: lowerAscii(x) }; }
/** Öppningstaggen <name …> (inte <namex>) från position from: { start, end (efter >), attrs, selfClosing } */
function openTag(d, name, from = 0) {
  const ln = '<' + name;
  // Nästa '>' sparas: många öppningar utan '>' (skadlig fil) ska inte söka till slutet av filen varje gång
  let gt = -1;
  for (let i = from; ;) {
    i = d.lx.indexOf(ln, i);
    if (i < 0) return null;
    const ch = d.lx[i + ln.length];
    if (ch === '>' || ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '/') {
      if (gt < i) gt = d.x.indexOf('>', i);
      const e = gt;
      if (e < 0) return null;
      if (e - i > MAX_TAG) { i += ln.length; continue; }
      return { start: i, end: e + 1, attrs: d.x.slice(i + ln.length, e), selfClosing: d.x[e - 1] === '/' };
    }
    i += ln.length;
  }
}
/** Elementet name: { o (öppningstaggen), inner (rå text), next (position efter sluttaggen) } eller null */
function element(d, name, from = 0) {
  for (let o = openTag(d, name, from); o; o = openTag(d, name, o.end)) {
    if (o.selfClosing) return { o, inner: '', next: o.end };
    const c = d.lx.indexOf(`</${name}>`, o.end);
    if (c < 0) return null;
    return { o, inner: d.x.slice(o.end, c), next: c + name.length + 3 };
  }
  return null;
}
/** Alla element name (högst max) */
function elements(d, name, max) {
  const out = [];
  for (let e = element(d, name); e && out.length < max; e = element(d, name, e.next)) out.push(e);
  return out;
}
const value = (d, name) => { const e = element(d, name); if (!e) return null; const t = text(e.inner); return t || null; };
function attr(attrs, a) {
  const m = new RegExp(`(?:^|\\s)${a}\\s*=\\s*(?:"([^"]{0,500})"|'([^']{0,500})')`, 'i').exec(attrs);
  return m ? decodeEnt(m[1] ?? m[2]).trim() : null;
}
/** Ta bort delar som har egna <name>/<rating>/<id> (skådespelare, betyg, filinfo, samling) ur dokumentet */
function without(d, names) {
  let x = d.x;
  for (const n of names) {
    let lx = lowerAscii(x), out = '', i = 0, guard = 0;
    for (;;) {
      const o = openTag({ x, lx }, n, i);
      if (!o || ++guard > 2000) { out += x.slice(i); break; }
      out += x.slice(i, o.start);
      if (o.selfClosing) { i = o.end; continue; }
      const c = lx.indexOf(`</${n}>`, o.end);
      // Utan sluttagg finns ingen längre fram heller: resten behålls som det är
      if (c < 0) { out += x.slice(o.start); break; }
      i = c + n.length + 3;
    }
    x = out;
  }
  return doc(x);
}

const clip = (s, n) => (s == null ? null : String(s).slice(0, n) || null);
const num = (s, min, max) => { const v = parseFloat(String(s ?? '').replace(',', '.')); return Number.isFinite(v) && v >= min && v <= max ? v : null; };
const int = (s, min, max) => { const t = String(s ?? '').trim(); return /^\d{1,9}$/.test(t) && +t >= min && +t <= max ? +t : null; };
/** YYYY-MM-DD ur premiered/aired/releasedate (även "2010-07-16 00:00:00" och "16.07.2010"), annars null */
export function isoDate(s) {
  const t = String(s ?? '').trim().slice(0, 40);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (!m) { const e = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(t); if (e) m = [null, e[3], e[2], e[1]]; }
  if (!m) return null;
  const y = +m[1], mo = +m[2], da = +m[3];
  if (y < 1870 || y > 2200 || mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}
/** Lista ur upprepade element ("<genre>Drama</genre><genre>Komedi</genre>") och "Drama / Komedi" */
function list(d, name) {
  const out = [];
  for (const e of elements(d, name, MAX_LIST)) {
    for (const part of text(e.inner).split(/\s*[/|]\s*/)) {
      const v = part.trim().slice(0, 80);
      if (v && !out.some(x => x.toLowerCase() === v.toLowerCase())) out.push(v);
      if (out.length >= MAX_LIST) return out;
    }
  }
  return out;
}

/** Id:n: <uniqueid type="tmdb">, äldre <tmdbid>/<imdbid>/<tvdbid> och <id> (tt… = IMDb) */
function ids(d, root) {
  const r = { tmdb: null, imdb: null, tvdb: null };
  const put = (type, v) => {
    v = String(v || '').trim();
    if (type === 'tmdb' && r.tmdb == null && /^\d{1,9}$/.test(v) && +v > 0) r.tmdb = +v;
    else if (type === 'imdb' && r.imdb == null && /^tt\d{5,10}$/.test(v)) r.imdb = v;
    else if (type === 'tvdb' && r.tvdb == null && /^\d{1,9}$/.test(v) && +v > 0) r.tvdb = +v;
  };
  // Standard-id (default="true") först
  const u = elements(d, 'uniqueid', MAX_LIST).map(e => ({ type: (attr(e.o.attrs, 'type') || '').toLowerCase(), def: /^true$/i.test(attr(e.o.attrs, 'default') || ''), v: text(e.inner) }));
  for (const x of [...u.filter(x => x.def), ...u.filter(x => !x.def)]) put(x.type === 'themoviedb' ? 'tmdb' : x.type, x.v);
  put('tmdb', value(d, 'tmdbid')); put('imdb', value(d, 'imdbid')); put('imdb', value(d, 'imdb_id')); put('tvdb', value(d, 'tvdbid'));
  const id = value(d, 'id');
  if (id) { if (/^tt\d/.test(id)) put('imdb', id); else if (root === 'tvshow') put('tvdb', id); }
  return r;
}
/** Betyg: <ratings><rating name=… default="true"><value>7.9</value></rating></ratings> eller <rating>7.9</rating> */
function rating(d) {
  const block = element(d, 'ratings');
  if (block) {
    const b = doc(block.inner);
    const rs = elements(b, 'rating', 20).map(e => ({ def: /^true$/i.test(attr(e.o.attrs, 'default') || ''), max: num(attr(e.o.attrs, 'max'), 1, 100) || 10, v: num(value(doc(e.inner), 'value'), 0, 100) }))
      .filter(r => r.v != null);
    const pick = rs.find(r => r.def) || rs[0];
    if (pick) return Math.round(pick.v / pick.max * 100) / 10;
  }
  const plain = without(d, ['ratings']);
  return num(value(plain, 'rating'), 0, 10);
}
/** Skådespelare (namn, roll, ordning och ev. TMDB-id) */
function actors(d) {
  return elements(d, 'actor', MAX_ACTORS).map((e, i) => {
    const a = doc(e.inner);
    return { name: clip(value(a, 'name'), 200), role: clip(value(a, 'role'), 200), order: int(value(a, 'order'), 0, 10000) ?? i,
      tmdb: int(value(a, 'tmdbid'), 1, 1e9) };
  }).filter(a => a.name);
}

/** "Länk-NFO": en fil med bara en adress till TMDB eller IMDb (Kodi läser sådana) */
function linkOnly(x) {
  const r = {};
  const t = x.indexOf('themoviedb.org/');
  if (t >= 0) { const m = /^themoviedb\.org\/(movie|tv)\/(\d{1,9})/.exec(x.slice(t, t + 60)); if (m) r.tmdb = +m[2]; }
  const i = x.indexOf('imdb.com/title/');
  if (i >= 0) { const m = /^imdb\.com\/title\/(tt\d{5,10})/.exec(x.slice(i, i + 40)); if (m) r.imdb = m[1]; }
  return r.tmdb || r.imdb ? { ids: { tmdb: r.tmdb || null, imdb: r.imdb || null, tvdb: null }, linkOnly: true } : null;
}

/**
 * Tolka en NFO-fil. kind = 'movie' (film), 'tvshow' (serie) eller 'episodedetails' (avsnitt; filer med flera
 * avsnitt ger det första). Fält som saknas i filen finns inte i svaret (null betyder "inte angivet").
 * @param {string|Buffer} input
 * @param {'movie'|'tvshow'|'episodedetails'} kind
 * @returns {null | { title?: string, originalTitle?: string, sortTitle?: string, year?: number, plot?: string,
 *   rating?: number, mpaa?: string, genres?: string[], studio?: string, premiered?: string, season?: number,
 *   episode?: number, ids: { tmdb: number|null, imdb: string|null, tvdb: number|null }, actors?: object[], linkOnly?: boolean }}
 */
export function parseNfo(input, kind) {
  if (input == null) return null;
  let x = Buffer.isBuffer(input) ? (input.length > NFO_MAX ? null : input.toString('utf8')) : String(input);
  if (x == null || x.length > NFO_MAX) return null;
  if (x.charCodeAt(0) === 0xFEFF) x = x.slice(1);
  const all = doc(x);
  const root = element(all, kind);
  if (!root) {
    // Ingen avslutande tagg (avklippt fil): resten av filen räknas som innehållet
    const o = openTag(all, kind);
    if (!o) return linkOnly(x);
    return parseBody(doc(x.slice(o.end)), kind, x);
  }
  return parseBody(doc(root.inner), kind, x);
}
function parseBody(full, kind, raw) {
  // Delar med egna namn/betyg/id tas bort innan fälten läses (annars blir en skådespelares <name> titeln)
  const d = without(full, ['actor', 'fileinfo', 'set', 'episodedetails', 'namedseason', 'ratings', 'thumb', 'fanart']);
  const out = { ids: ids(d, kind) };
  const set = (k, v) => { if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) out[k] = v; };
  set('title', clip(value(d, 'title'), 300));
  set('originalTitle', clip(value(d, 'originaltitle'), 300));
  set('sortTitle', clip(value(d, 'sorttitle'), 300));
  set('plot', clip(value(d, 'plot') || value(d, 'outline'), 8000));
  set('rating', rating(full));
  set('mpaa', clip(value(d, 'mpaa') || value(d, 'certification'), 120));
  set('genres', list(d, 'genre').slice(0, 20));
  set('studio', clip(list(d, 'studio').slice(0, 3).join(', '), 200));
  set('premiered', isoDate(value(d, 'premiered') || value(d, 'aired') || value(d, 'releasedate') || value(d, 'firstaired')));
  set('year', int(value(d, 'year'), 1870, 2200) ?? (out.premiered ? +out.premiered.slice(0, 4) : null));
  if (kind === 'episodedetails') {
    set('season', int(value(d, 'season'), 0, 9999));
    set('episode', int(value(d, 'episode'), 0, 99999));
  }
  set('actors', actors(full));
  // Inget läsbart fält alls: kanske en länk-NFO med XML-skal
  if (Object.keys(out).length === 1 && !out.ids.tmdb && !out.ids.imdb && !out.ids.tvdb) return linkOnly(raw);
  return out;
}

// ---------- åldersgräns ur mpaa/certification ----------
// Samma tabell som TMDB-matchningen (scanner.js): svensk klassning före amerikansk före tysk
export const AGE = { SE: { 'Btl': 0, 'BTL': 0, '7': 7, '11': 11, '15': 15 }, US: { 'G': 0, 'PG': 7, 'PG-13': 13, 'R': 17, 'NC-17': 18,
  'TV-Y': 0, 'TV-Y7': 7, 'TV-G': 0, 'TV-PG': 10, 'TV-14': 14, 'TV-MA': 17 }, DE: { '0': 0, '6': 6, '12': 12, '16': 16, '18': 18 } };
const COUNTRY = { se: 'SE', swe: 'SE', sweden: 'SE', sverige: 'SE', us: 'US', usa: 'US', 'united states': 'US', de: 'DE', ger: 'DE', germany: 'DE', deutschland: 'DE', fsk: 'DE' };
const lookup = (c, v) => {
  const t = AGE[c]; if (!t) return null;
  const k = Object.keys(t).find(k => k.toUpperCase() === v.toUpperCase());
  return k ? { cert: `${c}:${k}`, age: t[k] } : null;
};
/**
 * Åldersgräns ur NFO:ns mpaa/certification: "Rated PG-13", "US:PG-13", "Sweden:15", "SE:15 / US:R", "FSK 12", "TV-MA".
 * @returns {{ cert: string, age: number } | null}
 */
export function certFromNfo(s) {
  const found = [];
  for (const part0 of String(s || '').slice(0, 200).split(/\s*[/,;|]\s*/)) {
    const part = part0.trim().replace(/^rated\s+/i, '');
    if (!part) continue;
    const m = /^([a-zåäö][a-zåäö .]{0,18}?)\s*[:\s-]\s*([a-z0-9+-]{1,8})$/i.exec(part);
    const c = m && COUNTRY[m[1].trim().toLowerCase()];
    if (c) { const r = lookup(c, m[2].replace(/^rated\s+/i, '')); if (r) found.push(r); continue; }
    // Utan land: amerikanska beteckningar, sedan svenska och tyska siffror
    const r = lookup('US', part) || lookup('SE', part) || lookup('DE', part);
    if (r) found.push(r);
  }
  for (const c of ['SE', 'US', 'DE']) { const r = found.find(x => x.cert.startsWith(c + ':')); if (r) return r; }
  return null;
}
