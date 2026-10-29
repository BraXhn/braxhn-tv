// Ljudböckernas verktyg för administratören (som Audiobookshelf):
//   kapitelredigeraren  byta namn, flytta (starttid), lägga till och ta bort kapitel. Sparas i book_meta.chapters_edit och
//                       går före filens och Audnexus kapitel – filen skrivs aldrig om för det.
//   skriv in kapitel    bara på begäran och bara för en bok i en M4B/M4A-fil: ffmpeg -c copy till en dold fil bredvid
//                       originalet, originalet till papperskorgen (hård länk), den nya filen byter namn till originalets plats
//                       (atomärt). Därefter gäller filens kapitel igen.
//   slå ihop till M4B   en bok i flera filer (oftast MP3) blir en M4B med kapitel och omslag. Bara på begäran. AAC-filer
//                       kopieras, annat kodas om till AAC. Resultatet kontrolleras (längd) innan något flyttas; den nya filen
//                       läggs på plats först och originalen flyttas sedan till papperskorgen.
//   papperskorgen       samma som diskrådgivarens (<biblioteksmapp>/.braxhn-papperskorg eller SHRINK_TRASH_DIR, filändelsen
//                       .original så att ingen skanner läser filen), tabellen book_trash. Töms efter BOOK_TRASH_DAYS dagar
//                       (14); "Ångra" lägger tillbaka originalen. Bokens id består (samma nyckel) – position, bokmärken och
//                       statistik följer med.
// En åtgärd åt gången (ffmpeg på hela boken). Efter bytet skannas biblioteket om (kroken rescan sätts i app.js).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { get, all, run, now, CACHE } from './db.js';
import * as books from './audiobooks.js';
import { probe } from './music.js';
import { librariesWithRoots, rootOf } from './libpaths.js';
import { lowPriority } from './util.js';
import * as jobs from './jobs.js';

const TRASH_NAME = '.braxhn-papperskorg';
const trashDays = () => Math.max(1, +(process.env.BOOK_TRASH_DAYS || 14));
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
let rescan = async () => {};
/** app.js kopplar skannerns scan(libId) hit */
export const setRescan = (fn) => { rescan = fn; };

// ---------- kapitel ----------
const MAX_CHAPTERS = 500;
/** Kontrollera och städa en kapitellista: starttider inom boken, inga dubbletter, sorterade, sluttid = nästa start */
export function cleanChapters(list, duration) {
  if (!Array.isArray(list) || !list.length) throw err('Lägg till minst ett kapitel');
  if (list.length > MAX_CHAPTERS) throw err(`Högst ${MAX_CHAPTERS} kapitel`);
  const d = +duration || 0;
  const out = list.map((c, i) => {
    const start = Math.round((+c?.start || 0) * 1000) / 1000;
    if (!Number.isFinite(start) || start < 0 || (d && start >= d)) throw err(`Kapitel ${i + 1} börjar utanför boken`);
    return { start, title: String(c?.title ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) if (out[i].start - out[i - 1].start < 1) throw err('Två kapitel kan inte börja inom samma sekund');
  return out.map((c, i) => ({ start: c.start, end: i + 1 < out.length ? out[i + 1].start : +d.toFixed(3), title: c.title || `Kapitel ${i + 1}` }));
}
const upsert = (id, col, v) => run(`INSERT INTO book_meta(book_id, ${col}) VALUES(?, ?) ON CONFLICT(book_id) DO UPDATE SET ${col}=excluded.${col}`, id, v);
/** Spara redigerade kapitel (filen rörs inte) */
export function saveChapters(id, list) {
  const b = books.bookRow(id); if (!b) throw err('Finns inte', 404);
  const ch = cleanChapters(list, b.duration);
  upsert(id, 'chapters_edit', JSON.stringify(ch));
  return ch;
}
/** Tillbaka till filens (eller Audnexus) kapitel */
export const resetChapters = (id) => { if (get('SELECT 1 FROM book_meta WHERE book_id=?', id)) run('UPDATE book_meta SET chapters_edit=NULL WHERE book_id=?', id); };

// ---------- pågående åtgärd ----------
let active = null; // { id, kind, started, job }
const last = new Map(); // bok → { kind, ok, error, finished } (senaste avslutade, i minnet)
export const stateOf = (id) => active?.id === id ? { kind: active.kind, running: true, started: active.started } : last.get(id) || null;
function exclusive(id, kind, title, fn) {
  if (active) throw err(active.id === id ? 'Boken bearbetas redan' : 'En annan ljudbok bearbetas – försök igen när den är klar', 409);
  active = { id, kind, started: now(), job: jobs.track('books', title) };
  const p = (async () => {
    try { await fn(); last.set(id, { kind, ok: true, finished: now() }); }
    catch (e) { console.warn(`[böcker] ${kind}:`, e.message); last.set(id, { kind, ok: false, error: e.message, finished: now() }); }
    finally { active.job.end(); active = null; if (last.size > 200) last.delete(last.keys().next().value); }
  })();
  return p;
}

function ffmpeg(args, timeoutMs = 6 * 3600e3) {
  return new Promise((resolve, reject) => {
    const p = lowPriority(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }));
    let e = '';
    p.stderr.on('data', (d) => { if (e.length < 4000) e += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (x) => { clearTimeout(t); reject(x); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg avbröts (${code}): ${e.trim().split('\n').pop() || 'okänt fel'}`)); });
  });
}
// FFMETADATA: = ; # \ och radbrytning skrivs med bakstreck
const meta = (s) => String(s ?? '').replace(/[\\=;#\n]/g, (m) => '\\' + m);
function ffmeta(b, chapters) {
  const lines = [';FFMETADATA1', `title=${meta(b.title)}`, `album=${meta(b.title)}`, `artist=${meta(b.author || '')}`, `album_artist=${meta(b.author || '')}`, 'genre=Audiobook'];
  if (b.narrator) lines.push(`composer=${meta(b.narrator)}`);
  if (b.year) lines.push(`date=${meta(b.year)}`);
  if (b.series) lines.push(`series=${meta(b.series)}`, ...(b.series_no ? [`series-part=${meta(b.series_no)}`] : []));
  for (const c of chapters) lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.start * 1000)}`, `END=${Math.round(c.end * 1000)}`, `title=${meta(c.title)}`);
  return lines.join('\n') + '\n';
}

// ---------- papperskorgen ----------
export function trashDirFor(file) {
  if (process.env.SHRINK_TRASH_DIR) return path.resolve(process.env.SHRINK_TRASH_DIR);
  return path.join(rootOf(librariesWithRoots().flatMap(l => l.roots), file) || path.dirname(file), TRASH_NAME);
}
/** Flytta till papperskorgen. link = hård länk (originalet ligger kvar tills den nya filen tagit dess plats). */
function toTrash(file, dest, { link = false } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (link) { try { fs.linkSync(file, dest); return 'link'; } catch {} }
  try { fs.renameSync(file, dest); return 'rename'; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  fs.copyFileSync(file, dest); if (!link) fs.rmSync(file, { force: true }); return 'copy';
}
const inTrash = (p) => p.endsWith('.original') && (path.basename(path.dirname(p)) === TRASH_NAME || (process.env.SHRINK_TRASH_DIR && path.dirname(p) === path.resolve(process.env.SHRINK_TRASH_DIR)));
/** Vad som ligger i papperskorgen för boken (det som kan ångras) */
export function trashOf(id) {
  const rows = all('SELECT * FROM book_trash WHERE book_id=? ORDER BY id', id).filter(r => fs.existsSync(r.trash_path));
  if (!rows.length) return null;
  let bytes = 0; for (const r of rows) { try { bytes += fs.statSync(r.trash_path).size; } catch {} }
  const why = (() => { try { return JSON.parse(rows[rows.length - 1].reason || '{}'); } catch { return {}; } })();
  return { kind: why.kind || null, files: rows.length, bytes, until: Math.min(...rows.map(r => r.until)) };
}
/** Töm det som passerat sitt datum (eller bokens direkt). Tar bara bort filer som ligger i en papperskorg. */
export function purgeTrash(id = null, at = now()) {
  const rows = id != null ? all('SELECT * FROM book_trash WHERE book_id=?', id) : all('SELECT * FROM book_trash WHERE until <= ?', at);
  let n = 0;
  for (const r of rows) {
    if (!inTrash(r.trash_path)) { console.warn('[böcker] tar inte bort (ligger inte i papperskorgen):', r.trash_path); continue; }
    try { fs.rmSync(r.trash_path, { force: true }); n++; } catch (e) { console.warn('[böcker] papperskorgen:', e.message); continue; }
    run('DELETE FROM book_trash WHERE id=?', r.id);
  }
  return n;
}
setInterval(() => { try { purgeTrash(); } catch {} }, 3600e3).unref();

/** Ångra: originalen tillbaka från papperskorgen, filen som gjordes tas bort */
export function restore(id) {
  const rows = all('SELECT * FROM book_trash WHERE book_id=? ORDER BY id', id);
  if (!rows.length || !rows.every(r => fs.existsSync(r.trash_path))) throw err('Originalen finns inte i papperskorgen', 404);
  const b = get('SELECT library_id, title FROM books WHERE id=?', id);
  return exclusive(id, 'restore', `Ångrar: ${b?.title || id}`, async () => {
    const why = (() => { try { return JSON.parse(rows[rows.length - 1].reason || '{}'); } catch { return {}; } })();
    for (const r of rows) {
      fs.mkdirSync(path.dirname(r.path), { recursive: true });
      const tmp = path.join(path.dirname(r.path), `.braxhn-${id}-${r.id}.restore`);
      try { fs.renameSync(r.trash_path, tmp); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(r.trash_path, tmp); fs.rmSync(r.trash_path, { force: true }); }
      fs.renameSync(tmp, r.path); // ersätter filen med inskrivna kapitel atomärt
      run('DELETE FROM book_trash WHERE id=?', r.id);
    }
    if (why.kind === 'merge' && why.result && !rows.some(r => r.path === why.result)) fs.rmSync(why.result, { force: true });
    if (b) await rescan(b.library_id);
  });
}

// ---------- skriv in kapitlen i filen ----------
const MP4 = /\.(m4b|m4a|mp4)$/i;
export function canEmbed(b) { return b.files.length === 1 && MP4.test(books.fileRow(b.files[0].id)?.path || ''); }
/** Kapitlen som visas (även redigerade) skrivs in i M4B-filen. Startar i bakgrunden; stateOf(id) visar läget. */
export function embedChapters(id, uid) {
  const b = books.book(id, uid); if (!b) throw err('Finns inte', 404);
  if (!canEmbed(b)) throw err('Kapitel kan bara skrivas in i en bok som är en enda M4B- eller M4A-fil');
  if (b.chapters.length < 1) throw err('Boken har inga kapitel');
  const f = books.fileRow(b.files[0].id);
  const row = books.bookRow(id);
  return exclusive(id, 'embed', `Kapitel in i filen: ${b.title}`, async () => {
    const dir = path.dirname(f.path), tmp = path.join(dir, `.braxhn-${id}.kapitel.tmp${path.extname(f.path)}`);
    const mf = path.join(CACHE, `bookmeta-${id}-${process.pid}.txt`);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(mf, ffmeta(row, b.chapters));
    try {
      const pic = (await probe(f.path)).hasPic;
      await ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', f.path, '-f', 'ffmetadata', '-i', mf, '-map', '0:a', ...(pic ? ['-map', '0:v:0', '-disposition:v:0', 'attached_pic'] : []),
        '-map_metadata', '0', '-map_chapters', '1', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp]);
      const info = await probe(tmp);
      if (!(Math.abs((info.duration || 0) - (f.duration || 0)) <= Math.max(1, (f.duration || 0) * 0.005))) throw new Error('den nya filen har fel längd – originalet behålls');
      const trash = path.join(trashDirFor(f.path), `bok${id}-${Date.now()}-${path.basename(f.path)}.original`);
      const how = toTrash(f.path, trash, { link: true });
      try { fs.renameSync(tmp, f.path); }
      catch (e) { if (how === 'rename') { try { fs.renameSync(trash, f.path); } catch {} } else fs.rmSync(trash, { force: true }); throw e; }
      run('INSERT INTO book_trash(book_id,path,trash_path,reason,created,until) VALUES(?,?,?,?,?,?)', id, f.path, trash, JSON.stringify({ kind: 'embed' }), now(), now() + trashDays() * 86400);
      resetChapters(id); // filens kapitel är nu de redigerade
    } finally { fs.rmSync(tmp, { force: true }); fs.rmSync(mf, { force: true }); }
    await rescan(f.library_id);
  });
}

// ---------- slå ihop till en M4B ----------
const safeName = (s) => String(s || 'Ljudbok').replace(/[\u0000-\u001f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 150) || 'Ljudbok';
export function canMerge(b) {
  const key = get('SELECT key FROM books WHERE id=?', b.id)?.key;
  return b.files.length >= 2 && !!key && fs.existsSync(key) && fs.statSync(key).isDirectory();
}
/** Bokens filer blir en M4B i bokens mapp (kapitel, metadata, omslag). Startar i bakgrunden. */
export function mergeBook(id, uid) {
  const b = books.book(id, uid); if (!b) throw err('Finns inte', 404);
  if (!canMerge(b)) throw err('Bara en bok i flera filer (i en egen mapp) kan slås ihop');
  const row = books.bookRow(id), dir = row.key;
  const files = b.files.map(x => books.fileRow(x.id));
  return exclusive(id, 'merge', `Slår ihop till M4B: ${b.title}`, async () => {
    let name = `${safeName(b.title)}.m4b`;
    if (fs.existsSync(path.join(dir, name))) name = `${safeName(b.title)} (sammanslagen).m4b`;
    const final = path.join(dir, name), tmp = path.join(dir, `.braxhn-${id}.sammanslagning.tmp.m4b`);
    fs.mkdirSync(CACHE, { recursive: true });
    const list = path.join(CACHE, `bookconcat-${id}-${process.pid}.txt`), mf = path.join(CACHE, `bookmeta-${id}-${process.pid}.txt`);
    // concat-listan: ' skrivs som '\'' (ffconcat)
    fs.writeFileSync(list, 'ffconcat version 1.0\n' + files.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    fs.writeFileSync(mf, ffmeta(row, b.chapters));
    const cover = books.coverPath(id);
    const copy = files.every(f => f.codec === 'aac');
    const kbps = Math.max(64, Math.min(128, Math.round(Math.max(...files.map(f => (f.bitrate || 0) / 1000)) / 16) * 16 || 96));
    try {
      await ffmpeg(['-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '0', '-i', list, '-f', 'ffmetadata', '-i', mf, ...(cover ? ['-i', cover] : []),
        '-map', '0:a:0', ...(cover ? ['-map', '2:v', '-c:v', 'copy', '-disposition:v:0', 'attached_pic'] : []), '-map_metadata', '1', '-map_chapters', '1',
        ...(copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', `${kbps}k`]), '-movflags', '+faststart', '-f', 'mp4', tmp]);
      const info = await probe(tmp);
      if (!(Math.abs((info.duration || 0) - (b.duration || 0)) <= Math.max(2, (b.duration || 0) * 0.01))) throw new Error('den sammanslagna filen har fel längd – originalen behålls');
      // Den nya filen på plats först, sedan originalen till papperskorgen (en samtidig skanning ser aldrig en tom bok)
      fs.renameSync(tmp, final);
      const stamp = Date.now(), reason = JSON.stringify({ kind: 'merge', result: final });
      for (const [i, f] of files.entries()) {
        const trash = path.join(trashDirFor(f.path), `bok${id}-${stamp}-${String(i + 1).padStart(3, '0')}-${path.basename(f.path)}.original`);
        toTrash(f.path, trash);
        run('INSERT INTO book_trash(book_id,path,trash_path,reason,created,until) VALUES(?,?,?,?,?,?)', id, f.path, trash, reason, now(), now() + trashDays() * 86400);
      }
    } finally { fs.rmSync(tmp, { force: true }); fs.rmSync(list, { force: true }); fs.rmSync(mf, { force: true }); }
    await rescan(row.library_id);
  });
}
