// Ljudböcker: en bok per mapp (eller per .m4b-fil), kapitel, position per användare och bokmärken.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, get, all, run, tx, now, getSetting, IMAGES, searchKeys } from './db.js';
import { ranked } from './search.js';
import { probe, AUDIO, makeCover } from './music.js';
import { underFailed } from './util.js';
import { rootsOf, listRoots, relOf, under } from './libpaths.js';

const pexec = promisify(execFile);
db.exec(`CREATE TABLE IF NOT EXISTS books(id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  key TEXT NOT NULL, title TEXT NOT NULL, sort_title TEXT, author TEXT, narrator TEXT, series TEXT, year INTEGER, description TEXT,
  cover INTEGER NOT NULL DEFAULT 0, duration REAL, chapters TEXT, added INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS books_key ON books(library_id, key);
CREATE TABLE IF NOT EXISTS book_files(id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  path TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT, duration REAL, offset REAL NOT NULL DEFAULT 0, size INTEGER, mtime INTEGER, codec TEXT, bitrate INTEGER);
CREATE INDEX IF NOT EXISTS book_files_book ON book_files(book_id, idx);
CREATE TABLE IF NOT EXISTS book_progress(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0, speed REAL, updated INTEGER NOT NULL, PRIMARY KEY(user_id, book_id));
CREATE TABLE IF NOT EXISTS bookmarks(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE, position REAL NOT NULL, note TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS book_probe_fail(path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER);`);
searchKeys('books', ['title'], ['author', 'narrator', 'series']);

export const coverFile = (id) => path.join(IMAGES, `b${id}-cover.jpg`);
export const coverPath = (id) => { const f = coverFile(id); return fs.existsSync(f) ? f : null; };
export const sortName = (t) => String(t || '').toLowerCase().replace(/^(the|a|an|en|ett)\s+/, '');
const natural = (a, b) => a.localeCompare(b, 'sv', { numeric: true, sensitivity: 'base' });
const DISC = /^(cd|disc|disk|del|part|skiva)[\s._-]*\d+$/i;

/** Gruppera filer i böcker: mapp = bok, men flera .m4b i samma mapp = en bok var, och CD1/CD2-undermappar hör till föräldern */
export function groupBooks(files) {
  const byDir = new Map();
  for (const f of files) {
    let d = path.dirname(f);
    if (DISC.test(path.basename(d))) d = path.dirname(d);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }
  const books = [];
  for (const [dir, fs_] of byDir) {
    const m4b = fs_.filter(f => /\.m4b$/i.test(f));
    if (m4b.length > 1 && m4b.length === fs_.length) for (const f of m4b) books.push({ key: f, dir, files: [f] });
    else books.push({ key: dir, dir, files: fs_.sort(natural) });
  }
  return books;
}

async function chaptersOf(file) {
  try {
    const { stdout } = await pexec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-print_format', 'json', '-show_chapters', file], { timeout: 30000, maxBuffer: 8 << 20 });
    return (JSON.parse(stdout).chapters || []).map((c, i) => ({ start: +(+c.start_time).toFixed(3), end: +(+c.end_time).toFixed(3), title: c.tags?.title || `Kapitel ${i + 1}` }));
  } catch { return []; }
}

/** Får borttagna böcker tas bort? Nej om biblioteksmappen inte går att läsa (t.ex. en NAS som inte är monterad), om inga filer
 *  hittades fast böcker finns, eller om mer än hälften skulle försvinna – annars raderas position och bokmärken för alla. */
function deletionBlocked(root, knownCount, foundCount, removeCount) {
  try { if (!fs.statSync(root).isDirectory()) return 'biblioteksmappen är inte en mapp'; fs.readdirSync(root); }
  catch (e) { return `biblioteksmappen går inte att läsa (${e.code || e.message})`; }
  if (knownCount > 0 && foundCount === 0) return 'inga ljudböcker hittades';
  if (removeCount > 2 && removeCount > knownCount / 2 && getSetting('scan_allow_mass_delete', '0') !== '1') return `${removeCount} av ${knownCount} böcker skulle tas bort`;
  return null;
}

export async function scanBooks(lib, status) {
  status.phase = 'Söker ljudböcker'; status.done = 0;
  // listFiles läser asynkront och rapporterar mappar som inte gick att läsa – böcker där tas aldrig bort
  const roots = rootsOf(lib);
  const list = await listRoots(roots, (n) => AUDIO.has(path.extname(n).toLowerCase()), (n) => n === '@eaDir');
  const { files: found, failed } = list;
  const groups = groupBooks(found);
  status.total = groups.length; status.phase = 'Läser ljudböcker';
  const known = new Map(all('SELECT id, key FROM books WHERE library_id=?', lib.id).map(r => [r.key, r.id]));
  const seen = new Set(), seenFiles = new Set();
  // Filer som ffprobe inte klarade kommer vi ihåg (med storlek/ändringstid) så att boken inte läses om vid varje skanning
  const failGet = db.prepare('SELECT size, mtime FROM book_probe_fail WHERE path=?');
  const failSet = db.prepare('INSERT INTO book_probe_fail(path,size,mtime) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime');
  const failDel = db.prepare('DELETE FROM book_probe_fail WHERE path=?');
  for (const g of groups) {
    status.done++; seen.add(g.key);
    const stats = g.files.map(f => { try { const s = fs.statSync(f); return { f, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) }; } catch { return null; } }).filter(Boolean);
    for (const x of stats) seenFiles.add(x.f);
    const bid = known.get(g.key);
    const prev = bid ? all('SELECT path, size, mtime FROM book_files WHERE book_id=? ORDER BY idx', bid) : [];
    const prevMap = new Map(prev.map(p => [p.path, p]));
    const statPaths = new Set(stats.map(x => x.f));
    const unchanged = stats.every(x => { const p = prevMap.get(x.f) || failGet.get(x.f); return p && p.size === x.size && p.mtime === x.mtime; })
      && prev.every(p => statPaths.has(p.path));
    if (unchanged) continue;
    const infos = [];
    for (const s of stats) {
      try { infos.push({ ...s, info: await probe(s.f) }); failDel.run(s.f); }
      catch (e) { console.warn('[böcker] ffprobe', s.f, e.message); failSet.run(s.f, s.size, s.mtime); }
    }
    if (!infos.length) continue;
    // En tillfälligt misslyckad fil (disken vaknar, tidsgräns) i en befintlig bok: behåll bokens filer som de är,
    // annars förskjuts kapitel och sparade positioner
    if (bid && infos.length < stats.length) continue;
    const t = infos[0].info.tags;
    const rel = relOf(roots, g.key).split(path.sep);
    const folderTitle = path.basename(g.key, path.extname(g.key)).replace(/^\s*\(?\d{4}\)?\s*[-–]\s*/, '');
    const title = String(t.album || (infos.length === 1 ? t.title : '') || folderTitle).slice(0, 300);
    const author = String(t.album_artist || t.albumartist || t.artist || t.author || (rel.length >= 2 ? rel[0] : '') || 'Okänd författare').slice(0, 200);
    const narrator = t.narrator || t.composer || t.performer || null;
    const year = parseInt(t.date || t.year) || null;
    const description = String(t.description || t.comment || t.synopsis || '').slice(0, 4000) || null;
    // Kapitel: inbäddade (m4b) eller en per fil
    let chapters = [], offset = 0;
    const files = infos.map((x, i) => { const o = { ...x, idx: i, offset }; offset += x.info.duration || 0; return o; });
    if (files.length === 1) chapters = await chaptersOf(files[0].f);
    if (chapters.length < 2) chapters = files.map(x => ({ start: x.offset, end: x.offset + (x.info.duration || 0),
      title: (files.length > 1 ? x.info.tags.title : null) || (files.length > 1 ? path.basename(x.f, path.extname(x.f)) : title) }));
    const id = bid || Number(run('INSERT INTO books(library_id,key,title,added) VALUES(?,?,?,?)', lib.id, g.key, title, now()).lastInsertRowid);
    run('UPDATE books SET title=?, sort_title=?, author=?, narrator=?, year=?, description=?, duration=?, chapters=? WHERE id=?',
      title, sortName(title), author, narrator, year, description, offset, JSON.stringify(chapters.slice(0, 500)), id);
    tx(() => {
      run('DELETE FROM book_files WHERE book_id=?', id);
      for (const x of files) run('INSERT INTO book_files(book_id,path,idx,title,duration,offset,size,mtime,codec,bitrate) VALUES(?,?,?,?,?,?,?,?,?,?)',
        id, x.f, x.idx, x.info.tags.title || null, x.info.duration, x.offset, x.size, x.mtime, x.info.codec, x.info.bitrate);
    });
    if (!coverPath(id) && await makeCover(coverFile(id), g.dir, files[0].f, files.some(x => x.info.hasPic))) run('UPDATE books SET cover=1 WHERE id=?', id);
  }
  // Raderingsskyddet gäller varje mapp för sig: en mapp som saknas eller ser tömd ut tar inte bort något, inte heller i de andra
  const gone = [];
  for (const st of list.roots) {
    const mine = [...known].filter(([k]) => under(st.root, k));
    const g = mine.filter(([k]) => !seen.has(k) && !underFailed(k, failed) && !failed.includes(k));
    const nGroups = groups.filter(x => under(st.root, x.key)).length;
    const where = roots.length > 1 ? ` (${st.root})` : '';
    const blocked = !st.ok ? 'biblioteksmappen går inte att läsa'
      : g.length ? deletionBlocked(st.root, mine.length, nGroups, g.length) : (nGroups ? null : 'inga filer hittades');
    if (blocked) {
      if (g.length || !st.ok) {
        console.warn(`[böcker] ${lib.name || lib.path}${where}: inga böcker tas bort – ${blocked}`);
        (status.warnings ||= []).push(`Inga ljudböcker togs bort${where}: ${blocked}`);
      }
      continue;
    }
    gone.push(...g);
  }
  if (!gone.length && !list.rootOk) return;
  tx(() => { for (const [, id] of gone) run('DELETE FROM books WHERE id=?', id); });
  for (const [, id] of gone) fs.rm(coverFile(id), { force: true }, () => {});
  // Glöm misslyckade prober för filer som inte längre finns
  for (const st of list.roots) {
    if (!st.ok) continue;
    const root = path.resolve(st.root) + path.sep;
    for (const r of all('SELECT path FROM book_probe_fail WHERE substr(path, 1, ?) = ?', root.length, root)) if (!seenFiles.has(r.path) && !underFailed(r.path, failed)) failDel.run(r.path);
  }
}

// ---------- API-hjälp ----------
// Fälten som visas: administratörens ändringar (book_meta.edits, '' = tömt) först, sedan filens taggar eller källan på nätet
// (bookmeta.js). Titel och författare kommer alltid från filen om de inte ändrats för hand; beskrivningen från källan om
// filens egen är kort (ofta "Ripped by …" eller en rad), utgivningsåret från källan före filens år (inspelningen).
const E = (k) => `json_extract(m.edits,'$.${k}')`;
const BOOK = `b.id, b.library_id, b.key, b.cover, b.duration, b.added, b.chapters AS file_chapters, m.chapters AS net_chapters,
  m.state AS meta_state, m.locked AS meta_locked, m.source AS meta_source, m.source_id AS meta_source_id, m.src_title AS meta_title, m.edits AS meta_edits,
  COALESCE(NULLIF(${E('title')}, ''), b.title) AS title, COALESCE(NULLIF(${E('sort')}, ''), b.sort_title) AS sort_title,
  COALESCE(NULLIF(${E('author')}, ''), b.author) AS author,
  NULLIF(COALESCE(${E('narrator')}, b.narrator, m.narrator), '') AS narrator,
  NULLIF(COALESCE(${E('year')}, m.year, b.year), '') AS year,
  NULLIF(COALESCE(${E('description')}, CASE WHEN length(b.description) >= 200 THEN b.description END, m.description, b.description), '') AS description,
  NULLIF(COALESCE(${E('subtitle')}, m.subtitle), '') AS subtitle, NULLIF(COALESCE(${E('series')}, m.series), '') AS series,
  NULLIF(COALESCE(${E('seriesNo')}, m.series_no), '') AS series_no, NULLIF(COALESCE(${E('publisher')}, m.publisher), '') AS publisher,
  NULLIF(COALESCE(${E('isbn')}, m.isbn), '') AS isbn, NULLIF(COALESCE(${E('asin')}, m.asin), '') AS asin,
  NULLIF(COALESCE(${E('genres')}, m.genres), '') AS genres, m.language AS language`;
const FROM = 'books b LEFT JOIN book_meta m ON m.book_id=b.id';
const json = (s, def) => { try { return s ? JSON.parse(s) : def; } catch { return def; } };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
// Nya fält (series, seriesNo …) är tillägg – apparna läser bara de gamla
const shape = (b) => ({ id: b.id, title: b.title, author: b.author, narrator: b.narrator, year: b.year == null ? null : parseInt(b.year) || null, duration: b.duration, cover: !!b.cover,
  position: b.position || 0, finished: !!b.finished, updated: b.updated || null, library: b.library_id,
  series: b.series || null, seriesNo: b.series_no == null ? null : String(b.series_no) });
/** Kapitel: filens egna, men Audnexus kapitel om filen saknar kapitel och längden stämmer (±2 %) */
export function chaptersFor(b) {
  const own = json(b.file_chapters, []);
  const net = json(b.net_chapters, null);
  if (own.length <= 1 && Array.isArray(net) && net.length > 1 && lengthMatches(net[net.length - 1].end, b.duration)) return { chapters: net, source: 'audnexus' };
  return { chapters: own, source: 'fil' };
}
export const lengthMatches = (a, b) => a > 0 && b > 0 && Math.abs(a - b) <= b * 0.02;
export function listBooks(libId, uid, sort = 'title') {
  const order = { title: 'sort_title', author: 'author COLLATE NOCASE, sort_title', added: 'added DESC', recent: 'updated DESC NULLS LAST, sort_title', series: 'series IS NULL, series COLLATE NOCASE, CAST(series_no AS REAL), sort_title' }[sort] || 'sort_title';
  // I en underfråga: sorteringen gäller de visade fälten (t.ex. ändrad titel), inte kolumnerna med samma namn
  return all(`SELECT * FROM (SELECT ${BOOK}, p.position, p.finished, p.updated FROM ${FROM} LEFT JOIN book_progress p ON p.book_id=b.id AND p.user_id=? WHERE b.library_id=?) ORDER BY ${order}`, uid, libId).map(shape);
}
/** Böcker som matchar titeln, eller författaren/uppläsaren/serien (rankas lägre). Q = parseQuery(…) */
export function searchBooks(Q, uid, limit = 20) {
  return ranked({ from: 'FROM books b LEFT JOIN book_progress p ON p.book_id=b.id AND p.user_id=?', colParams: [uid],
    cols: 'b.*, p.position, p.finished, p.updated, b.title AS _t', key: 'b.skey', key2: 'b.skey2', year: 'b.year' }, Q, limit).map(shape);
}
export function continueBooks(uid, limit = 12) {
  return all(`SELECT ${BOOK}, p.position, p.finished, p.updated FROM ${FROM} JOIN book_progress p ON p.book_id=b.id AND p.user_id=? WHERE p.finished=0 AND p.position > 30
    ORDER BY p.updated DESC LIMIT ?`, uid, limit).map(shape);
}
/** En bok med de fält som visas (för bookmeta.js och routes) */
export const bookRow = (id) => get(`SELECT ${BOOK} FROM ${FROM} WHERE b.id=?`, id);
export function book(id, uid) {
  const b = get(`SELECT ${BOOK}, p.position, p.finished, p.updated, p.speed FROM ${FROM} LEFT JOIN book_progress p ON p.book_id=b.id AND p.user_id=? WHERE b.id=?`, uid, id);
  if (!b) return null;
  const ch = chaptersFor(b);
  const card = (x) => ({ id: x.id, title: x.title, cover: !!x.cover, year: x.year == null ? null : parseInt(x.year) || null, seriesNo: x.series_no == null ? null : String(x.series_no) });
  const others = (where, ...p) => all(`SELECT * FROM (SELECT ${BOOK} FROM ${FROM} WHERE b.library_id=? AND b.id!=?) WHERE ${where}`, b.library_id, id, ...p);
  return { ...shape(b), description: b.description, speed: b.speed || 1,
    chapters: ch.chapters, chapterSource: ch.source,
    subtitle: b.subtitle || null, publisher: b.publisher || null, isbn: b.isbn || null, asin: b.asin || null, language: b.language || null,
    genres: json(b.genres, []).filter(x => typeof x === 'string').slice(0, 10),
    // Metadata från nätet: källa och om matchningen är låst ("Fel bok?")
    meta: { state: b.meta_state || 0, locked: !!b.meta_locked, source: b.meta_source || null, sourceId: b.meta_source_id || null, matchedTitle: b.meta_title || null,
      edited: Object.keys(json(b.meta_edits, {})).filter(k => k !== 'sort') },
    files: all('SELECT id, idx, title, duration, offset, codec FROM book_files WHERE book_id=? ORDER BY idx', id),
    bookmarks: all('SELECT id, position, note, created FROM bookmarks WHERE user_id=? AND book_id=? ORDER BY position', uid, id),
    sameAuthor: others('author=? AND (? IS NULL OR series IS NULL OR series != ? COLLATE NOCASE) ORDER BY year, sort_title LIMIT 20', b.author, b.series, b.series).map(card),
    sameSeries: b.series ? others('series=? COLLATE NOCASE ORDER BY CAST(series_no AS REAL) NULLS LAST, year, sort_title LIMIT 50', b.series).map(card) : [] };
}
export function saveProgress(uid, id, position, speed) {
  const b = get('SELECT duration FROM books WHERE id=?', id); if (!b) return null;
  const pos = Math.max(0, Math.min(+position || 0, b.duration || 1e9));
  const finished = b.duration && b.duration - pos < Math.min(30, b.duration * 0.02) ? 1 : 0;
  run(`INSERT INTO book_progress(user_id,book_id,position,finished,speed,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,book_id) DO UPDATE SET
    position=excluded.position, finished=excluded.finished, speed=COALESCE(excluded.speed, speed), updated=excluded.updated`, uid, id, finished ? 0 : pos, finished, speed ? Math.max(0.5, Math.min(3, +speed)) : null, now());
  return { finished: !!finished };
}
export const fileRow = (fid) => get('SELECT f.*, b.library_id FROM book_files f JOIN books b ON b.id=f.book_id WHERE f.id=?', fid);
