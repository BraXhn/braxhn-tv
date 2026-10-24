// Metadata och kapitel för ljudböcker från nätet (som Audiobookshelf). Källor, alla publika och utan nyckel:
//   Google Books  – sökning på titel + författare (svenska titlar först med langRestrict=sv), beskrivning, omslag, år, förlag, ISBN, genrer
//   Open Library  – reserv när Google inte hittar boken
//   Audnexus      – bok och kapitel via ASIN (Audibles id): uppläsare, serie och nummer, kapitel med tider
// Körs i bakgrunden efter skanningen, en bok i taget, med paus mellan anrop till samma värd och svar cachade i minnet.
// Matchade (state=1) och låsta böcker hämtas aldrig om automatiskt; böcker utan träff (state=2) försöker igen efter 30 dagar.
// Bas-adresserna kan bytas med miljövariabler (testerna kör mot en låtsasserver); värdarna är fasta – inga användaradresser.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { get, all, run, now, getSetting, CACHE } from './db.js';
import { bookRow, coverFile, coverPath, chaptersFor, lengthMatches, sortName } from './audiobooks.js';
import { probe } from './music.js';
import { similarity, tokens } from './match.js';
import { dropVariants } from './imgsize.js';

const pexec = promisify(execFile);
const base = (env, def) => String(process.env[env] || def).replace(/\/+$/, '');
const GB = () => base('GOOGLE_BOOKS_URL', 'https://www.googleapis.com/books/v1');
const OL = () => base('OPENLIBRARY_URL', 'https://openlibrary.org');
const OLC = () => base('OPENLIBRARY_COVERS_URL', 'https://covers.openlibrary.org');
const AX = () => base('AUDNEXUS_URL', 'https://api.audnex.us');
const TIMEOUT = 15000, MAX_JSON = 4 << 20, MAX_IMG = 8 << 20;
const PER_RUN = 100;            // högst så många böcker per skanning (Google Books utan nyckel tål ungefär 1 000 anrop per dygn)
const RETRY_DAYS = 30;
export const GOOD = 0.7;        // lägsta poäng för en automatisk träff – hellre ingen metadata än fel bok
const UA = () => `BraXhnTV/${globalThis.__braxhnAppVersion || '0'} (självhostad mediaserver; https://github.com/braxhn/braxhn-tv)`;

export const enabled = () => getSetting('book_meta', process.env.BOOK_METADATA || '1') === '1';
export const status = { running: false, library: null, done: 0, total: 0, matched: 0, last: null, error: null };

// ---------- hämtning: fasta värdar, tidsgräns, storleksgräns, paus per värd och cache ----------
const COVER_HOSTS = new Set(['books.google.com', 'books.googleusercontent.com', 'covers.openlibrary.org', 'm.media-amazon.com', 'images-na.ssl-images-amazon.com']);
const baseHosts = () => new Set([GB(), OL(), OLC(), AX()].map(u => { try { return new URL(u).host; } catch { return ''; } }));
/** Bildadress från en källa: bara kända bildvärdar (https), eller de konfigurerade bas-adressernas värdar */
export function coverUrlOk(u) {
  let x; try { x = new URL(String(u)); } catch { return null; }
  if (baseHosts().has(x.host) && /^https?:$/.test(x.protocol)) return x.href;
  if (!COVER_HOSTS.has(x.hostname) || x.port) return null;
  x.protocol = 'https:'; // Google ger http://books.google.com/…
  return x.href;
}
const gap = () => Math.max(0, +(process.env.BOOK_META_GAP_MS ?? 1100));
const nextAt = new Map(); // värd → tidigaste tid för nästa anrop
async function slot(host) {
  const t = Math.max(Date.now(), nextAt.get(host) || 0);
  nextAt.set(host, t + gap());
  if (t > Date.now()) await new Promise(r => setTimeout(r, t - Date.now()));
}
const cache = new Map(); // adress → { at, v } (även "finns inte"), 24 h, högst 400
const TTL = 24 * 3600e3;
const remember = (k, v) => { cache.set(k, { at: Date.now(), v }); if (cache.size > 400) cache.delete(cache.keys().next().value); return v; };
export const clearCache = () => { cache.clear(); nextAt.clear(); };
async function readCapped(r, max) {
  if (+r.headers.get('content-length') > max) { r.body?.cancel().catch(() => {}); throw new Error('svaret är för stort'); }
  const chunks = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > max) throw new Error('svaret är för stort'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function fetchOk(url, accept) {
  const host = new URL(url).host;
  await slot(host);
  let r;
  try { r = await fetch(url, { headers: { Accept: accept, 'User-Agent': UA() }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) }); }
  catch (e) { throw new Error(e.name === 'TimeoutError' ? `${host} svarade inte i tid` : `kunde inte nå ${host} (${e.cause?.code || e.message})`); }
  // Omdirigering får inte leda bort från värden (Open Library flyttar sammanslagna verk inom samma värd)
  if (new URL(r.url || url).host !== host) { r.body?.cancel().catch(() => {}); throw new Error(`${host} skickade vidare till en annan värd`); }
  if (r.status === 404) { r.body?.cancel().catch(() => {}); return null; }
  if (r.status === 429 || r.status === 403) { r.body?.cancel().catch(() => {}); throw Object.assign(new Error(`${host}: för många anrop just nu (${r.status})`), { rateLimited: true }); }
  if (!r.ok) { r.body?.cancel().catch(() => {}); throw new Error(`${host} svarade ${r.status}`); }
  return r;
}
async function getJson(url) {
  const c = cache.get(url);
  if (c && Date.now() - c.at < TTL) return c.v;
  const r = await fetchOk(url, 'application/json');
  if (!r) return remember(url, null);
  const buf = await readCapped(r, MAX_JSON);
  try { return remember(url, JSON.parse(buf.toString('utf8'))); } catch { throw new Error(`${new URL(url).host} skickade inget giltigt JSON-svar`); }
}
/** Hämta en omslagsbild (proxy för sökträffarna i "Fel bok?" – webbens CSP tillåter inga externa bilder) */
export async function fetchImage(u) {
  const url = coverUrlOk(u); if (!url) throw new Error('Ogiltig bildadress');
  const r = await fetchOk(url, 'image/*');
  const type = r?.headers.get('content-type') || '';
  if (!r || !/^image\/(jpeg|png|webp|gif)$/.test(type)) { r?.body?.cancel().catch(() => {}); throw new Error('Ingen bild'); }
  return { type, body: await readCapped(r, MAX_IMG) };
}

// ---------- källor → gemensamt format ----------
const text = (s) => String(s || '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
const cut = (s, n) => { s = String(s ?? '').trim(); return s ? s.slice(0, n) : null; };
const uniq = (a) => [...new Set(a.map(x => String(x || '').trim()).filter(Boolean))];
const yearOf = (s) => { const y = parseInt(String(s || '').match(/\d{4}/)?.[0]); return y > 1000 && y < 2200 ? y : null; };
const ISO3 = { swe: 'sv', eng: 'en', nor: 'no', nob: 'no', dan: 'da', fin: 'fi', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it' };
function fromGoogle(v) {
  const i = v.volumeInfo || {}, ids = i.industryIdentifiers || [], img = i.imageLinks || {};
  return { source: 'google', id: String(v.id || ''), title: i.title || '', subtitle: i.subtitle || null, authors: i.authors || [], narrators: [],
    description: text(i.description) || null, publisher: i.publisher || null, year: yearOf(i.publishedDate),
    isbn: (ids.find(x => x.type === 'ISBN_13') || ids.find(x => x.type === 'ISBN_10'))?.identifier || null,
    genres: uniq((i.categories || []).flatMap(c => String(c).split(/\s*\/\s*/))).filter(g => !/^general$/i.test(g)),
    series: null, seriesNo: null, asin: null, language: i.language || null,
    cover: img.extraLarge || img.large || img.medium || img.small || img.thumbnail || img.smallThumbnail || null };
}
function fromOpenLibrary(d) {
  return { source: 'openlibrary', id: String(d.key || '').replace(/^\/works\//, ''), title: d.title || '', subtitle: d.subtitle || null, authors: d.author_name || [], narrators: [],
    description: null, publisher: (d.publisher || [])[0] || null, year: d.first_publish_year || null,
    isbn: (d.isbn || []).find(x => x.length === 13) || (d.isbn || [])[0] || null, genres: uniq((d.subject || []).slice(0, 6)),
    series: null, seriesNo: null, asin: null, language: ISO3[(d.language || [])[0]] || (d.language || [])[0] || null,
    cover: d.cover_i ? `${OLC()}/b/id/${+d.cover_i}-L.jpg` : null };
}
function fromAudnexus(b) {
  const sp = b.seriesPrimary || b.seriesSecondary;
  return { source: 'audnexus', id: String(b.asin || ''), title: b.title || '', subtitle: b.subtitle || null, authors: (b.authors || []).map(a => a.name), narrators: (b.narrators || []).map(a => a.name),
    description: text(b.summary || b.description) || null, publisher: b.publisherName || null, year: yearOf(b.releaseDate),
    isbn: b.isbn || null, genres: uniq((b.genres || []).filter(g => g.type !== 'tag').map(g => g.name)), series: sp?.name || null,
    seriesNo: sp?.position ? String(sp.position).replace(/^(book|bok|del|vol\.?)\s*/i, '').trim() || null : null,
    asin: b.asin || null, language: b.language === 'swedish' ? 'sv' : b.language === 'english' ? 'en' : b.language || null, cover: b.image || null };
}

// ---------- sökning och matchning ----------
const SV_WORDS = new Set(['och', 'en', 'ett', 'att', 'det', 'den', 'som', 'på', 'för', 'med', 'av', 'till', 'om', 'jag', 'du', 'vi', 'min', 'mitt', 'när', 'där', 'inte', 'från', 'hos']);
export const looksSwedish = (s) => /[åäöÅÄÖ]/.test(s) || String(s).toLowerCase().split(/[^\p{L}]+/u).some(w => SV_WORDS.has(w));
/** Titel för sökning: utan uppläsare, "oförkortad", hakparenteser och serienummer först ("01 - Titel") */
export function cleanTitle(t) {
  return String(t || '').replace(/[([](?:uppläst|läst|read|narrated|unabridged|oförkortad|ljudbok|audiobook)[^)\]]*[)\]]/gi, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(unabridged|oförkortad|ljudbok|audiobook)\b/gi, ' ').replace(/^\s*\d{1,3}\s*[-–.]\s+/, '').replace(/\s+/g, ' ').replace(/[\s\-–:,]+$/, '').trim();
}
const authorOf = (a) => (!a || /^okänd författare$/i.test(a)) ? null : String(a);
const quote = (s) => `"${String(s).replace(/"/g, '')}"`;
/** Poäng 0–1: titelns likhet, gånger en faktor för författaren (efternamnet måste finnas hos träffen när vi vet författaren) */
export function score(c, title, author) {
  let t = similarity(title, c.title);
  if (c.subtitle) t = Math.max(t, similarity(title, `${c.title} ${c.subtitle}`));
  if (!author) return t * 0.9;
  const theirs = new Set(c.authors.flatMap(a => tokens(a)));
  const ours = String(author).split(/\s*(?:[,&;]|\boch\b|\band\b)\s*/i).map(a => tokens(a).filter(x => x.length > 1)).filter(x => x.length);
  const hit = ours.some(w => theirs.has(w[w.length - 1]));
  return hit ? t : t * 0.5;
}
async function google(title, author, lang, raw) {
  const q = raw || `intitle:${quote(title)}${author ? ` inauthor:${quote(author)}` : ''}`;
  const j = await getJson(`${GB()}/volumes?q=${encodeURIComponent(q)}&maxResults=10&printType=books${lang ? `&langRestrict=${lang}` : ''}`);
  return (j?.items || []).map(fromGoogle).filter(c => c.id && c.title);
}
async function openLibrary(title, author) {
  const p = new URLSearchParams({ title, limit: '10', fields: 'key,title,subtitle,author_name,first_publish_year,publisher,isbn,subject,cover_i,language' });
  if (author) p.set('author', author);
  const j = await getJson(`${OL()}/search.json?${p}`);
  return (j?.docs || []).map(fromOpenLibrary).filter(c => c.id && c.title);
}
export const asinOk = (a) => /^[A-Z0-9]{10}$/.test(String(a || '').trim().toUpperCase());
async function audnexus(asin) {
  if (!asinOk(asin)) return null;
  const j = await getJson(`${AX()}/books/${String(asin).trim().toUpperCase()}`);
  return j && j.asin ? fromAudnexus(j) : null;
}
/** Kapitel från Audnexus – bara om bokens totala längd stämmer (±2 %), annars hamnar kapitlen fel */
export async function audnexusChapters(asin, duration) {
  if (!asinOk(asin)) return null;
  const j = await getJson(`${AX()}/books/${String(asin).trim().toUpperCase()}/chapters`);
  const list = j?.chapters || [];
  if (list.length < 2) return null;
  const total = (+j.runtimeLengthMs || list.reduce((s, c) => s + (+c.lengthMs || 0), 0)) / 1000;
  if (!lengthMatches(total, duration)) return null;
  return list.slice(0, 500).map((c, i) => {
    const start = (+c.startOffsetMs || 0) / 1000;
    return { start: +start.toFixed(3), end: +(start + (+c.lengthMs || 0) / 1000).toFixed(3), title: String(c.title || `Kapitel ${i + 1}`).slice(0, 200) };
  });
}
/** Hela posten för en vald träff: Google-volymen (större omslag, hel beskrivning), Open Library-verket (beskrivning) */
export async function details(source, id) {
  id = String(id || '').trim();
  if (source === 'google' && /^[\w-]{4,40}$/.test(id)) { const v = await getJson(`${GB()}/volumes/${id}`); return v ? fromGoogle(v) : null; }
  if (source === 'audnexus') return audnexus(id);
  if (source === 'openlibrary' && /^OL\d+W$/.test(id)) {
    const w = await getJson(`${OL()}/works/${id}.json`);
    if (!w) return null;
    const s = (await getJson(`${OL()}/search.json?${new URLSearchParams({ q: `key:/works/${id}`, limit: '1', fields: 'key,title,subtitle,author_name,first_publish_year,publisher,isbn,subject,cover_i,language' })}`).catch(() => null))?.docs?.[0];
    const c = s ? fromOpenLibrary(s) : { source: 'openlibrary', id, title: w.title || '', subtitle: w.subtitle || null, authors: [], narrators: [], publisher: null, year: yearOf(w.first_publish_date),
      isbn: null, genres: uniq((w.subjects || []).slice(0, 6)), series: null, seriesNo: null, asin: null, language: null, cover: w.covers?.[0] > 0 ? `${OLC()}/b/id/${w.covers[0]}-L.jpg` : null };
    c.description = text(typeof w.description === 'string' ? w.description : w.description?.value) || null;
    return c;
  }
  return null;
}
/** Bästa träffen för en bok, eller null. Svenska titlar söks först med langRestrict=sv, sedan utan, sist i Open Library. */
export async function findMatch(title, author) {
  title = cleanTitle(title); author = authorOf(author);
  if (!title) return null;
  const steps = [];
  if (looksSwedish(title)) steps.push(() => google(title, author, 'sv'));
  steps.push(() => google(title, author));
  if (author) steps.push(() => google(title, null)); // författaren kan vara stavad annorlunda (eller vara uppläsaren)
  steps.push(() => openLibrary(title, author));
  for (const step of steps) {
    let best = null;
    for (const c of await step()) { const s = score(c, title, author); if (!best || s > best.s) best = { c, s }; }
    if (best && best.s >= GOOD) return best.c;
  }
  return null;
}
/** Manuell sökning ("Fel bok?"): träffar från alla källor, bästa först. Ett ASIN söks direkt i Audnexus. */
export async function search(title, author) {
  title = cleanTitle(title); author = authorOf(author);
  const out = [], seen = new Set();
  const add = (list) => { for (const c of list) { const k = c.source + c.id; if (!seen.has(k)) { seen.add(k); out.push({ ...c, score: score(c, title || c.title, author) }); } } };
  if (asinOk(title) && /\d/.test(title)) { const a = await audnexus(title); if (a) out.push({ ...a, score: 1 }); }
  if (!title) return out;
  const errors = [];
  const tryAdd = async (fn) => { try { add(await fn()); } catch (e) { errors.push(e); } };
  if (looksSwedish(title)) await tryAdd(() => google(title, author, 'sv'));
  await tryAdd(() => google(title, author));
  if (out.length < 5) await tryAdd(() => google(null, null, null, `${title}${author ? ' ' + author : ''}`));
  await tryAdd(() => openLibrary(title, author));
  if (!out.length && errors.length) throw errors[0];
  return out.sort((a, b) => b.score - a.score).slice(0, 20);
}

// ---------- spara ----------
/** Taggar som inte lagras i books: ASIN och serie (Audiobookshelf-stil: series/series-part, iTunes "movement") */
async function tagsOf(bookId) {
  const f = get('SELECT path FROM book_files WHERE book_id=? ORDER BY idx LIMIT 1', bookId);
  if (!f) return {};
  try {
    const t = (await probe(f.path)).tags;
    return { asin: [t.asin, t.audible_asin, t['audible asin']].find(asinOk) || null, series: cut(t.series || t.mvnm || t.movementname || t['series name'], 200),
      seriesNo: cut(t['series-part'] || t.series_part || t.mvin || t.movement, 20) };
  } catch { return {}; }
}
async function saveCover(bookId, url) {
  url = coverUrlOk(url); if (!url) return false;
  const tmp = path.join(CACHE, `bookcover-${bookId}-${process.pid}.img`);
  try {
    const { body } = await fetchImage(url);
    if (body.length < 1000) return false; // Open Library ger en tom 1×1-bild när omslag saknas
    fs.writeFileSync(tmp, body);
    const out = coverFile(bookId);
    await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', tmp, '-frames:v', '1',
      '-vf', 'scale=600:600:force_original_aspect_ratio=decrease', '-q:v', '3', out + '.tmp.jpg'], { timeout: 30000 });
    fs.renameSync(out + '.tmp.jpg', out);
    dropVariants(out);
    run('UPDATE books SET cover=1 WHERE id=?', bookId);
    return true;
  } catch (e) { console.warn('[bokmetadata] omslag', bookId, e.message); return false; }
  finally { fs.rm(tmp, { force: true }, () => {}); fs.rm(coverFile(bookId) + '.tmp.jpg', { force: true }, () => {}); }
}
function upsert(bookId, f) {
  const keys = Object.keys(f);
  run(`INSERT INTO book_meta(book_id, ${keys.join(',')}) VALUES(?, ${keys.map(() => '?').join(',')})
    ON CONFLICT(book_id) DO UPDATE SET ${keys.map(k => `${k}=excluded.${k}`).join(',')}`, bookId, ...keys.map(k => f[k]));
}
/** Skriv in en träff (c) för boken. Omslag bara om boken saknar eget (eller har ett tidigare hämtat). Kapitel via ASIN. */
async function apply(b, c, { locked, tags = {} }) {
  const prev = get('SELECT * FROM book_meta WHERE book_id=?', b.id) || {};
  const edits = (() => { try { return JSON.parse(prev.edits || '{}'); } catch { return {}; } })();
  const asin = (asinOk(edits.asin) && edits.asin) || tags.asin || c?.asin || (prev.source === 'audnexus' ? null : prev.asin) || null;
  // ASIN men ingen Audnexus-källa: hämta uppläsare och serie därifrån som komplement
  const ax = asin && c?.source !== 'audnexus' ? await audnexus(asin).catch(() => null) : null;
  const pick = (k) => c?.[k] ?? ax?.[k] ?? null;
  const fields = {
    state: c ? 1 : 2, locked: locked ? 1 : 0, tried: now(), source: c?.source || null, source_id: c?.id || null, src_title: cut(c?.title, 300),
    subtitle: cut(pick('subtitle'), 300), narrator: cut(uniq([...(c?.narrators || []), ...(ax?.narrators || [])]).join(', '), 200),
    description: cut(pick('description'), 8000), publisher: cut(pick('publisher'), 200), year: pick('year'), isbn: cut(pick('isbn'), 20), asin,
    language: cut(pick('language'), 10), genres: JSON.stringify(uniq([...(c?.genres || []), ...(ax?.genres || [])]).slice(0, 10)),
    series: tags.series || pick('series') || ax?.series || null, series_no: tags.seriesNo || pick('seriesNo') || ax?.seriesNo || null,
  };
  // Kapitel: bara när filen saknar egna (ett enda kapitel = en fil utan kapitelmarkeringar)
  const row = bookRow(b.id);
  if (asin && JSON.parse(row?.file_chapters || '[]').length <= 1) {
    const ch = await audnexusChapters(asin, row.duration).catch(e => { console.warn('[bokmetadata] kapitel', b.title, e.message); return undefined; });
    if (ch !== undefined) fields.chapters = ch ? JSON.stringify(ch) : null;
  }
  const cover = c?.cover || ax?.cover;
  upsert(b.id, fields);
  if (cover && (!coverPath(b.id) || prev.cover_net)) { if (await saveCover(b.id, cover)) run('UPDATE book_meta SET cover_net=1 WHERE book_id=?', b.id); }
  return fields.state === 1;
}
/** Automatisk matchning av en bok (ingen träff → state 2, försöker igen om 30 dagar) */
export async function autoMatch(b) {
  const tags = await tagsOf(b.id);
  const edits = (() => { try { return JSON.parse(get('SELECT edits FROM book_meta WHERE book_id=?', b.id)?.edits || '{}'); } catch { return {}; } })();
  const asin = (asinOk(edits.asin) && edits.asin) || tags.asin;
  let c = asin ? await audnexus(asin) : null;
  if (!c) { const m = await findMatch(edits.title || b.title, edits.author || b.author); c = m ? (await details(m.source, m.id).catch(() => null)) || m : null; }
  return apply(b, c, { locked: false, tags });
}
/** "Fel bok?": välj en träff för hand – matchningen låses */
export async function matchManual(bookId, source, id) {
  const b = get('SELECT * FROM books WHERE id=?', bookId); if (!b) return null;
  const c = await details(source, id);
  if (!c) return false;
  await apply(b, c, { locked: true, tags: await tagsOf(b.id) });
  return true;
}
export function unlock(bookId) { upsert(bookId, { locked: 0, state: 0, tried: null }); }

const EDITABLE = { title: 300, author: 200, narrator: 200, description: 8000, subtitle: 300, series: 200, seriesNo: 20, publisher: 200, isbn: 20, asin: 10, year: 4, genres: 400 };
/** Administratörens ändringar: '' tömmer fältet, null tar bort ändringen (källan/filen gäller igen). Titel och författare kan inte tömmas. */
export async function edit(bookId, body) {
  const b = get('SELECT * FROM books WHERE id=?', bookId); if (!b) return null;
  const prev = get('SELECT edits, asin FROM book_meta WHERE book_id=?', bookId);
  const edits = (() => { try { return JSON.parse(prev?.edits || '{}'); } catch { return {}; } })();
  const oldAsin = edits.asin ?? prev?.asin ?? null;
  for (const [k, max] of Object.entries(EDITABLE)) {
    if (!(k in body)) continue;
    let v = body[k];
    if (v === null) { delete edits[k]; continue; }
    if (k === 'genres') { const g = (Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 10); edits.genres = g.length ? JSON.stringify(g) : ''; continue; }
    v = String(v ?? '').trim().slice(0, max);
    if (k === 'year') { if (v && !/^\d{3,4}$/.test(v)) throw Object.assign(new Error('Året ska vara t.ex. 1945'), { status: 400 }); edits.year = v ? +v : ''; continue; }
    if (k === 'asin') { v = v.toUpperCase(); if (v && !asinOk(v)) throw Object.assign(new Error('Ett ASIN är tio tecken, t.ex. B0036UF9BS'), { status: 400 }); }
    if ((k === 'title' || k === 'author') && !v) { delete edits[k]; continue; }
    edits[k] = v;
  }
  if (edits.title) edits.sort = sortName(edits.title); else delete edits.sort;
  upsert(bookId, { edits: Object.keys(edits).length ? JSON.stringify(edits) : null });
  // ASIN borttaget: kapitlen från det gamla gäller inte längre. Nytt ASIN: hämta uppläsare, serie och kapitel från Audnexus direkt
  if (edits.asin === '' && oldAsin) upsert(bookId, { chapters: null });
  if (edits.asin && edits.asin !== oldAsin) {
    const c = await audnexus(edits.asin).catch(() => null);
    const cur = get('SELECT * FROM book_meta WHERE book_id=?', bookId);
    if (c && !cur.source) await apply(b, c, { locked: !!cur.locked, tags: await tagsOf(bookId) });
    else {
      const row = bookRow(bookId);
      const ch = JSON.parse(row.file_chapters || '[]').length <= 1 ? await audnexusChapters(edits.asin, row.duration).catch(() => null) : null;
      upsert(bookId, { chapters: ch ? JSON.stringify(ch) : null, ...(c ? { narrator: cur.narrator || cut(c.narrators.join(', '), 200), series: cur.series || c.series, series_no: cur.series_no || c.seriesNo } : {}) });
    }
  }
  return true;
}

// ---------- bakgrundskö ----------
const pending = new Set();
let loop = null;
/** Köa ett bibliotek efter skanningen. Löftet blir klart när kön är tom (testerna väntar på det). */
export function queue(libId) {
  if (!enabled()) return Promise.resolve();
  pending.add(libId);
  if (!loop) loop = (async () => {
    status.running = true; status.error = null;
    try { while (pending.size) { const id = pending.values().next().value; pending.delete(id); await runLibrary(id); } }
    finally { loop = null; Object.assign(status, { running: false, library: null, done: 0, total: 0, last: now() }); }
  })().catch(e => { console.warn('[bokmetadata]', e.message); });
  return loop;
}
async function runLibrary(libId) {
  const lib = get("SELECT * FROM libraries WHERE id=? AND type='audiobook'", libId); if (!lib) return;
  const todo = all(`SELECT b.* FROM books b LEFT JOIN book_meta m ON m.book_id=b.id WHERE b.library_id=?
    AND (m.book_id IS NULL OR (m.locked=0 AND (m.state=0 OR (m.state=2 AND COALESCE(m.tried, 0) < ?)))) ORDER BY b.added DESC LIMIT ?`, libId, now() - RETRY_DAYS * 86400, PER_RUN);
  if (!todo.length) return;
  Object.assign(status, { library: lib.name, done: 0, total: todo.length });
  let errors = 0;
  for (const b of todo) {
    if (!enabled()) break;
    status.done++;
    try { if (await autoMatch(b)) status.matched++; errors = 0; }
    catch (e) {
      status.error = e.message;
      console.warn('[bokmetadata]', b.title, '–', e.message);
      // Ingen kontakt eller dygnskvoten slut: försök igen vid nästa skanning (boken markeras inte som "ingen träff")
      if (e.rateLimited || ++errors >= 3) break;
    }
  }
}
