// E-böcker och serietidningar (bibliotekstypen 'ebook'): EPUB, PDF och CBZ (CBR bara när filen egentligen är ett
// ZIP-arkiv – RAR kräver en uppackare som inte finns i Node och hoppas över med en varning).
//
// Skanningen läser metadata ur filerna (ebooks/formats.js) med den egna ZIP-läsaren (ebooks/zip.js, skydd mot
// zip-bomber och sökvägar ut ur arkivet) och gör ett omslag (e<id>-cover.jpg i /config/images) med ffmpeg. Bara nya och
// ändrade filer läses; försvunna tas bort med samma raderingsskydd som filmer (per mapp, removable i libpaths.js).
//
// Behörighet (canSee/visible): biblioteksbehörigheten (perms.js), och barnprofiler (åldersgräns) bara i bibliotek där
// administratören valt "barnprofiler får se" (libraries.kids = 1) – där döljs böcker med en högre åldersgräns ur
// ComicInfo. Okänd ålder visas (administratören har valt biblioteket för barnen). Allt som inte får visas svarar som
// en okänd bok.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, get, all, run, tx, now, getSetting, IMAGES, CACHE } from './db.js';
import { rootsOf, listRoots, removable, relOf } from './libpaths.js';
import { scanWarning } from './scanner.js';
import { permsOf } from './perms.js';
import { ranked } from './search.js';
import { withZip, ZipError } from './ebooks/zip.js';
import { readEpub, readComic, readPdf, seriesFromName, imageType } from './ebooks/formats.js';

const pexec = promisify(execFile);
export const EXT = new Set(['.epub', '.pdf', '.cbz', '.cbr']);
const SKIP_DIR = /^(@eaDir|#recycle|#snapshot|lost\+found|\$RECYCLE\.BIN|System Volume Information|__MACOSX)$/i;
const ext = (f) => path.extname(f).toLowerCase();
export const isEbookFile = (name) => EXT.has(ext(name));
export const coverFile = (id) => path.join(IMAGES, `e${+id}-cover.jpg`);
export const coverPath = (id) => { const f = coverFile(id); return fs.existsSync(f) ? f : null; };
const sortName = (t) => String(t || '').toLowerCase().replace(/^(the|a|an|en|ett|der|die|das|le|la|les)\s+/, '');
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const COVER_MAX = 32 << 20;

// ---------- skanning ----------
/** Läser en fil: { format, meta, spine, toc, manifest, pages, cover: Buffer|null, rtl } – kastar Error om den inte går att läsa */
export async function readBook(file) {
  const e = ext(file);
  if (e === '.pdf') {
    const r = await readPdf(file);
    return { format: 'pdf', meta: r.meta, pages: r.pages, cover: r.cover, rtl: false };
  }
  if (e === '.cbr') {
    // CBR är oftast RAR (stöds inte) men ibland ett ZIP-arkiv med fel ändelse
    const fh = await fs.promises.open(file, 'r');
    const b = Buffer.alloc(4);
    try { await fh.read(b, 0, 4, 0); } finally { await fh.close(); }
    if (b.toString('latin1', 0, 2) !== 'PK') { const err = new Error('CBR-filen är ett RAR-arkiv – packa om den till CBZ (ZIP)'); err.rar = true; throw err; }
  }
  return withZip(file, async (zip) => {
    if (e === '.epub') {
      const r = await readEpub(zip);
      let cover = null;
      if (r.cover) { try { cover = await zip.read(r.cover, COVER_MAX); } catch {} }
      return { format: 'epub', meta: r.meta, spine: r.spine, toc: r.toc, manifest: r.manifest, cover, rtl: r.rtl, rejected: zip.rejected };
    }
    const r = await readComic(zip);
    if (!r.pages.length) throw new Error('arkivet innehåller inga bilder');
    let cover = null;
    if (r.cover) { try { cover = await zip.read(r.cover, COVER_MAX); } catch {} }
    return { format: 'cbz', meta: r.meta, pages: r.pages.length, pageNames: r.pages, cover, rtl: r.rtl, rejected: zip.rejected };
  });
}

/** Omslaget som JPEG (högst 600 px brett) – ffmpeg läser bilden från en temporär fil; false om det inte gick */
async function makeCover(id, buf) {
  if (!buf || !imageType(buf)) return false;
  const tmp = path.join(CACHE, `ebook-cover-${+id}-${process.pid}.img`), out = coverFile(id);
  try {
    fs.writeFileSync(tmp, buf);
    await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-i', tmp, '-frames:v', '1',
      '-vf', "scale='min(600,iw)':-2", '-q:v', '3', '-f', 'image2', '-update', '1', out + '.tmp.jpg'], { timeout: 30000 });
    fs.renameSync(out + '.tmp.jpg', out);
    return true;
  } catch { fs.rmSync(out + '.tmp.jpg', { force: true }); return false; }
  finally { fs.rmSync(tmp, { force: true }); }
}

/** Metadata från filen, med filnamnet och mapparna som reserv */
function record(file, roots, r) {
  const m = r.meta || {};
  const stem = path.basename(file, path.extname(file));
  const rel = relOf(roots, file).split(path.sep);
  const fromName = r.format === 'cbz' ? seriesFromName(stem) : null;
  // Serietidningar i en egen mapp: mappen är serien (Komga/Kavita gör likadant)
  const folder = rel.length >= 2 ? rel[rel.length - 2] : null;
  const series = m.series || (r.format === 'cbz' ? (folder || fromName?.series || null) : null);
  let seriesNo = m.seriesNo ?? null;
  if (seriesNo == null && r.format === 'cbz') seriesNo = seriesFromName(stem)?.no ?? null;
  const title = String(m.title || (r.format === 'cbz' && series && seriesNo != null ? `${series} #${seriesNo}` : stem)).slice(0, 300);
  // Böcker i Författare/Titel.epub: mappen är författaren när filen inte säger något
  const author = m.author || (r.format !== 'cbz' && rel.length >= 2 ? rel[0] : null);
  const chars = r.spine ? r.spine.reduce((n, s) => n + s.chars, 0) : null;
  return { format: r.format, title, sort_title: sortName(title), author: author ? String(author).slice(0, 300) : null, series: series ? String(series).slice(0, 200) : null,
    series_no: Number.isFinite(seriesNo) ? seriesNo : null, volume: m.volume ?? null, year: m.year ?? null, publisher: m.publisher ?? null, language: m.language ?? null,
    description: m.description ?? null, isbn: m.isbn ?? null, genres: m.genres?.length ? JSON.stringify(m.genres) : null, age: m.age ?? null,
    rtl: r.rtl ? 1 : 0, manga: m.manga ? 1 : 0, pages: r.pages ?? null, spine: r.spine ? JSON.stringify(r.spine) : null, toc: r.toc ? JSON.stringify(r.toc) : null,
    manifest: r.manifest ? JSON.stringify(r.manifest) : null, page_names: r.pageNames ? JSON.stringify(r.pageNames) : null, chars };
}
const COLS = ['format', 'title', 'sort_title', 'author', 'series', 'series_no', 'volume', 'year', 'publisher', 'language', 'description', 'isbn', 'genres', 'age',
  'rtl', 'manga', 'pages', 'spine', 'toc', 'manifest', 'page_names', 'chars'];

/**
 * Skannar ett e-boksbibliotek. Bara nya och ändrade filer läses. Försvunna filer tas bort med raderingsskyddet:
 * en mapp som inte går att läsa, som är tom eller där mer än hälften försvunnit rör inget.
 * @returns {Promise<{ found: number, changed: number, removed: number, failed: number, rar: number }>}
 */
export async function scanEbooks(lib, status = {}) {
  status.phase = 'Söker e-böcker'; status.done = 0; status.total = 0;
  const roots = rootsOf(lib);
  const list = await listRoots(roots, isEbookFile, (n) => SKIP_DIR.test(n));
  const res = { found: list.files.length, changed: 0, removed: 0, failed: 0, rar: 0 };
  if (!list.rootOk) { scanWarning(`${lib.name}: biblioteksmappen går inte att läsa – inga e-böcker tas bort (är disken/NAS:en monterad?)`); return res; }
  for (const d of list.failed) if (!roots.includes(d)) scanWarning(`${lib.name}: kunde inte läsa ${d} – e-böckerna där behålls`);
  const known = new Map(all('SELECT id, path, size, mtime FROM ebooks WHERE library_id=?', lib.id).map(r => [r.path, r]));
  const failGet = db.prepare('SELECT size, mtime FROM ebook_fail WHERE path=?');
  const seen = new Set();
  status.total = list.files.length; status.phase = 'Läser e-böcker';
  let rejected = 0;
  for (const f of list.files) {
    status.done++; seen.add(f);
    let st; try { st = await fs.promises.stat(f); } catch { continue; }
    const mtime = Math.floor(st.mtimeMs / 1000);
    const k = known.get(f);
    if (k && k.size === st.size && k.mtime === mtime) continue;
    const fl = failGet.get(f);
    if (fl && fl.size === st.size && fl.mtime === mtime) { if (/RAR/.test(get('SELECT error FROM ebook_fail WHERE path=?', f)?.error || '')) res.rar++; continue; }
    let r;
    try { r = await readBook(f); }
    catch (e) {
      if (e.rar) res.rar++; else { res.failed++; console.warn('[e-böcker] kunde inte läsa', f, e.message); }
      run('INSERT INTO ebook_fail(path,size,mtime,error) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, error=excluded.error',
        f, st.size, mtime, String(e.rar ? 'RAR' : (e instanceof ZipError ? 'ZIP: ' : '') + e.message).slice(0, 300));
      continue;
    }
    rejected += r.rejected || 0;
    run('DELETE FROM ebook_fail WHERE path=?', f);
    const rec = record(f, roots, r);
    const v = COLS.map(c => rec[c] ?? null);
    let id = k?.id;
    if (id) run(`UPDATE ebooks SET ${COLS.map(c => c + '=?').join(', ')}, size=?, mtime=? WHERE id=?`, ...v, st.size, mtime, id);
    else id = Number(run(`INSERT INTO ebooks(${COLS.join(', ')}, size, mtime, library_id, path, added) VALUES(${COLS.map(() => '?').join(',')},?,?,?,?,?)`,
      ...v, st.size, mtime, lib.id, f, now()).lastInsertRowid);
    fs.rmSync(coverFile(id), { force: true });
    run('UPDATE ebooks SET cover=? WHERE id=?', await makeCover(id, r.cover) ? 1 : 0, id);
    res.changed++;
  }
  if (res.rar) scanWarning(`${lib.name}: ${res.rar} CBR-filer är RAR-arkiv och hoppades över – packa om dem till CBZ (ZIP), t.ex. med Calibre eller 7-Zip`);
  if (rejected) scanWarning(`${lib.name}: ${rejected} poster i arkiven hade otillåtna sökvägar (t.ex. "../") och lästes inte`);
  const missing = removable({ name: lib.name, list, rows: [...known.values()], seen, found: list.files,
    allowMass: getSetting('scan_allow_mass_delete', '0') === '1', warn: scanWarning });
  if (missing.length) {
    tx(() => { for (const r of missing) run('DELETE FROM ebooks WHERE id=?', r.id); });
    for (const r of missing) fs.rm(coverFile(r.id), { force: true }, () => {});
    res.removed = missing.length;
  }
  // Glöm misslyckade filer som inte längre finns i bibliotekets mappar som gick att läsa
  for (const st of list.roots) {
    if (!st.ok) continue;
    const pre = path.resolve(st.root) + path.sep;
    for (const r of all('SELECT path FROM ebook_fail WHERE substr(path, 1, ?) = ?', pre.length, pre)) if (!seen.has(r.path)) run('DELETE FROM ebook_fail WHERE path=?', r.path);
  }
  return res;
}

// ---------- behörighet ----------
/** Får profilen se e-boksbiblioteket? Biblioteksbehörighet, och för barnprofiler bara när libraries.kids = 1 */
export function canSeeLib(uid, lib) {
  if (!lib || lib.type !== 'ebook') return false;
  const pm = permsOf(uid);
  if (pm.libs != null && !pm.libs.includes(lib.id)) return false;
  return pm.maxAge == null || lib.kids === 1;
}
export const ebookLibs = (uid) => all("SELECT * FROM libraries WHERE type='ebook' ORDER BY name").filter(l => canSeeLib(uid, l));
/** SQL-villkor (alias e) för de böcker profilen får se: { sql, params } */
export function visible(uid, a = 'e') {
  if (!/^[a-z]$/.test(a)) throw new Error('ogiltigt alias');
  const ids = ebookLibs(uid).map(l => l.id), max = permsOf(uid).maxAge;
  return { sql: ` AND ${a}.library_id IN (SELECT value FROM json_each(?))${max == null ? '' : ` AND (${a}.age IS NULL OR ${a}.age <= ?)`}`, params: max == null ? [JSON.stringify(ids)] : [JSON.stringify(ids), max] };
}
/** Hela raden om profilen får se boken, annars null */
export function ebookFor(uid, id) {
  const r = get('SELECT e.*, l.type AS lib_type, l.kids AS lib_kids FROM ebooks e JOIN libraries l ON l.id=e.library_id WHERE e.id=?', +id || 0);
  if (!r || !canSeeLib(uid, { id: r.library_id, type: r.lib_type, kids: r.lib_kids })) return null;
  const max = permsOf(uid).maxAge;
  return max != null && r.age != null && r.age > max ? null : r;
}

// ---------- listor ----------
const CARD = `e.id, e.library_id, e.format, e.title, e.sort_title, e.author, e.series, e.series_no, e.year, e.cover, e.pages, e.rtl, e.added,
  p.percent, p.finished, p.updated`;
const FROM = 'ebooks e LEFT JOIN ebook_progress p ON p.ebook_id=e.id AND p.user_id=?';
/** Kortets fält (webben, OPDS) */
export const shape = (r) => ({ id: r.id, library: r.library_id, format: r.format, title: r.title, author: r.author || null, series: r.series || null,
  seriesNo: r.series_no == null ? null : r.series_no, year: r.year || null, cover: !!r.cover, pages: r.pages || null, rtl: !!r.rtl, added: r.added,
  percent: r.percent == null ? 0 : Math.round(r.percent * 10) / 10, finished: !!r.finished, updated: r.updated || null });
const ORDER = { title: 'e.sort_title', author: 'e.author IS NULL, e.author COLLATE NOCASE, e.sort_title', added: 'e.added DESC, e.id DESC',
  recent: 'p.updated IS NULL, p.updated DESC, e.sort_title', series: 'e.series IS NULL, e.series COLLATE NOCASE, e.series_no, e.sort_title' };
export const SORTS = Object.keys(ORDER);
/** Böckerna i biblioteket (ev. bara en serie), sorterade. limit/offset för OPDS. */
export function listBooks(lib, uid, { sort = 'title', series = null, limit = 5000, offset = 0 } = {}) {
  const v = visible(uid);
  const order = Object.hasOwn(ORDER, sort) ? ORDER[sort] : ORDER.title;
  const ser = series != null ? ' AND e.series = ? COLLATE NOCASE' : '';
  return all(`SELECT ${CARD} FROM ${FROM} WHERE e.library_id=?${ser}${v.sql} ORDER BY ${series != null ? 'e.series_no, e.sort_title' : order} LIMIT ? OFFSET ?`,
    uid, lib.id, ...(series != null ? [series] : []), ...v.params, limit, offset).map(shape);
}
export function countBooks(lib, uid, series = null) {
  const v = visible(uid);
  return get(`SELECT COUNT(*) AS n FROM ebooks e WHERE e.library_id=?${series != null ? ' AND e.series = ? COLLATE NOCASE' : ''}${v.sql}`, lib.id, ...(series != null ? [series] : []), ...v.params).n;
}
/** Serierna i biblioteket: { name, count, cover (bokens id med omslag), read } */
export function seriesOf(lib, uid) {
  const v = visible(uid), vx = visible(uid, 'x');
  return all(`SELECT e.series AS name, COUNT(*) AS count, SUM(CASE WHEN p.finished=1 THEN 1 ELSE 0 END) AS read,
    (SELECT x.id FROM ebooks x WHERE x.library_id=e.library_id AND x.series = e.series COLLATE NOCASE AND x.cover=1${vx.sql} ORDER BY x.series_no, x.id LIMIT 1) AS cover
    FROM ${FROM} WHERE e.library_id=? AND e.series IS NOT NULL${v.sql} GROUP BY e.series COLLATE NOCASE ORDER BY e.series COLLATE NOCASE LIMIT 2000`,
  ...vx.params, uid, lib.id, ...v.params).map(r => ({ name: r.name, count: r.count, read: r.read || 0, cover: r.cover ?? null }));
}
/** Fortsätt läsa: påbörjade, inte utlästa böcker, senast lästa först */
export function continueReading(uid, n = 12, libId = null) {
  const v = visible(uid);
  return all(`SELECT ${CARD} FROM ebooks e JOIN ebook_progress p ON p.ebook_id=e.id AND p.user_id=? WHERE p.finished=0 AND p.percent > 0${libId ? ' AND e.library_id=?' : ''}${v.sql}
    ORDER BY p.updated DESC LIMIT ?`, uid, ...(libId ? [libId] : []), ...v.params, n).map(shape);
}
export function recentBooks(uid, n = 50) {
  const v = visible(uid);
  return all(`SELECT ${CARD} FROM ${FROM} WHERE 1${v.sql} ORDER BY e.added DESC, e.id DESC LIMIT ?`, uid, ...v.params, n).map(shape);
}
/** Sökning på titel, författare och serie. Q = parseQuery(…) */
export function searchEbooks(Q, uid, limit = 20) {
  const v = visible(uid);
  return ranked({ from: `FROM ${FROM}`, colParams: [uid], where: '1' + v.sql, params: v.params,
    cols: `${CARD}, e.title AS _t`, key: 'e.skey', key2: 'e.skey2', year: 'e.year' }, Q, limit).map(shape);
}
/** En bok med allt som läsaren och boksidan behöver */
export function details(r, uid) {
  const p = get('SELECT locator, percent, finished, updated FROM ebook_progress WHERE user_id=? AND ebook_id=?', uid, r.id);
  const v = visible(uid);
  const others = r.series ? all(`SELECT ${CARD} FROM ${FROM} WHERE e.library_id=? AND e.series = ? COLLATE NOCASE AND e.id != ?${v.sql} ORDER BY e.series_no, e.sort_title LIMIT 200`,
    uid, r.library_id, r.series, r.id, ...v.params).map(shape) : [];
  const spine = json(r.spine, []);
  return { ...shape({ ...r, ...(p || {}) }), description: r.description || null, publisher: r.publisher || null, language: r.language || null, isbn: r.isbn || null,
    volume: r.volume || null, genres: json(r.genres, []), manga: !!r.manga, size: r.size || null, age: r.age ?? null,
    locator: p?.locator ? json(p.locator, null) : null,
    spine: spine.map(s => ({ href: s.href, chars: s.chars, linear: s.linear !== false })), toc: json(r.toc, []),
    marks: all('SELECT id, kind, locator, text, note, color, created FROM ebook_marks WHERE user_id=? AND ebook_id=? ORDER BY created, id', uid, r.id)
      .map(m => ({ ...m, locator: json(m.locator, null) })),
    sameSeries: others };
}

// ---------- läsposition och markeringar ----------
/** Klientens position (ett litet JSON-objekt) – null om den är ogiltig */
export function cleanLocator(l) {
  if (l == null || typeof l !== 'object' || Array.isArray(l)) return null;
  const s = JSON.stringify(l);
  return s.length <= 2000 ? s : null;
}
/** at (valfri): när positionen sparades (Unix-sekunder) – ett senare sparat läge vinner */
export function saveProgress(uid, id, { locator, percent, finished, at } = {}) {
  at = Number.isFinite(+at) && +at > 0 ? Math.min(Math.floor(+at), now()) : null;
  if (at) { const p = get('SELECT updated, finished FROM ebook_progress WHERE user_id=? AND ebook_id=?', uid, id); if (p && p.updated >= at) return { stale: true, finished: !!p.finished }; }
  let pc = Math.max(0, Math.min(100, +percent || 0));
  const done = finished === true || (finished !== false && pc >= 99.5) ? 1 : 0;
  if (done) pc = 100;
  run(`INSERT INTO ebook_progress(user_id,ebook_id,locator,percent,finished,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,ebook_id) DO UPDATE SET
    locator=COALESCE(excluded.locator, locator), percent=excluded.percent, finished=excluded.finished, updated=excluded.updated`, uid, id, cleanLocator(locator), pc, done, at || now());
  return { finished: !!done, percent: pc };
}
export const resetProgress = (uid, id) => run('DELETE FROM ebook_progress WHERE user_id=? AND ebook_id=?', uid, id);
export const MARK_COLORS = ['yellow', 'green', 'blue', 'pink'];
export const MARKS_MAX = 1000;
export function addMark(uid, id, b) {
  const kind = b.kind === 'highlight' ? 'highlight' : b.kind === 'bookmark' ? 'bookmark' : null;
  const loc = cleanLocator(b.locator);
  if (!kind || !loc) { const e = new Error('Ogiltigt bokmärke'); e.status = 400; throw e; }
  if (get('SELECT COUNT(*) AS n FROM ebook_marks WHERE user_id=? AND ebook_id=?', uid, id).n >= MARKS_MAX) { const e = new Error('För många bokmärken och markeringar i boken'); e.status = 400; throw e; }
  const color = MARK_COLORS.includes(b.color) ? b.color : kind === 'highlight' ? 'yellow' : null;
  const mid = Number(run('INSERT INTO ebook_marks(user_id,ebook_id,kind,locator,text,note,color,created) VALUES(?,?,?,?,?,?,?,?)', uid, id, kind, loc,
    String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000) || null, String(b.note || '').trim().slice(0, 2000) || null, color, now()).lastInsertRowid);
  return get('SELECT id, kind, locator, text, note, color, created FROM ebook_marks WHERE id=?', mid);
}
export function updateMark(uid, mid, b) {
  const m = get('SELECT * FROM ebook_marks WHERE id=? AND user_id=?', +mid || 0, uid);
  if (!m) return null;
  run('UPDATE ebook_marks SET note=?, color=? WHERE id=?', b.note === undefined ? m.note : String(b.note || '').trim().slice(0, 2000) || null,
    MARK_COLORS.includes(b.color) ? b.color : m.color, m.id);
  return get('SELECT id, kind, locator, text, note, color, created FROM ebook_marks WHERE id=?', m.id);
}
export const deleteMark = (uid, mid) => run('DELETE FROM ebook_marks WHERE id=? AND user_id=?', +mid || 0, uid).changes > 0;
