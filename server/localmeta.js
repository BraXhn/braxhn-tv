// Lokal metadata för film- och seriebibliotek: NFO-filer (Kodi/Jellyfin, server/nfo.js) och bilder bredvid
// filerna (poster.jpg, fanart.jpg, <film>-poster.jpg, season01-poster.jpg, <avsnitt>-thumb.jpg …).
// Körs av skannern efter fillistningen (scanner.js → syncLocal). Lokala värden går före TMDB:
//  - NFO: fälten som finns i filen skrivs efter TMDB-matchningen (reapplyNfo) och vid varje ändring av filen.
//    Ett TMDB-id i filen ger exakt matchning (nfoIds i scanner.js).
//  - Bilder: konverteras till bildmappen (som TMDB-bilderna), TMDB skriver aldrig över dem (hasLocal), och de
//    byts när filen ändras (signatur = sökväg|ändringstid|storlek i items.local_img).
// Bara titlar i mappar som lästes helt i den här skanningen rörs – en mapp som inte gick att läsa tar aldrig bort
// en NFO eller en bild.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { get, all, run, IMAGES } from './db.js';
import { parseNfo, certFromNfo, NFO_MAX } from './nfo.js';
import { dropVariants } from './imgsize.js';
import * as colors from './imgcolor.js';
import * as people from './people.js';
import { relOf, rootOf } from './libpaths.js';

const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.tbn'];
const IMG_MAX = 40 << 20; // större bildfiler hoppas över
/** Filer som skannern samlar in bredvid videofilerna */
export const isSide = (name) => { const e = path.extname(name).toLowerCase(); return e === '.nfo' || IMG_EXT.includes(e); };

/** Sidofilerna per mapp: mapp → Map(namn med gemener → sökväg) */
export function sideIndex(files) {
  const idx = new Map();
  for (const f of files) {
    const d = path.dirname(f);
    if (!idx.has(d)) idx.set(d, new Map());
    idx.get(d).set(path.basename(f).toLowerCase(), f);
  }
  return idx;
}
/** Första träffen bland namnen (bilder: utan filändelse, alla bildtyper prövas i tur och ordning) */
function findNfo(idx, dir, names) {
  const m = idx.get(dir);
  if (!m) return null;
  for (const n of names) { const f = m.get(n.toLowerCase()); if (f) return f; }
  return null;
}
function findImage(idx, dir, names) {
  const m = idx.get(dir);
  if (!m) return null;
  for (const n of names) for (const e of IMG_EXT) { const f = m.get(n.toLowerCase() + e); if (f) return f; }
  return null;
}

// ---------- bilder ----------
const STD = ['poster', 'backdrop', 'thumb'];
const MAXW = { poster: 1000, backdrop: 1920, thumb: 960, season: 680 };
/** Bildfilen i bildmappen: <id>-poster.jpg osv., säsongsaffischer i season/<id>/<säsong>.jpg */
export function imageFile(id, type) {
  const s = /^season(\d{1,4})$/.exec(type);
  return s ? path.join(IMAGES, 'season', String(+id), `${+s[1]}.jpg`) : path.join(IMAGES, `${+id}-${type}.jpg`);
}
const localOf = (row) => { try { return JSON.parse(row?.local_img || '{}') || {}; } catch { return {}; } };
/** Har titeln en lokal bild av typen? (då hämtas ingen från TMDB) */
export function hasLocal(id, type) { return !!localOf(get('SELECT local_img FROM items WHERE id=?', id))[type]; }
/** Säsongerna som har en lokal affisch */
export const seasonPosters = (row) => Object.keys(localOf(row)).map(k => /^season(\d+)$/.exec(k)).filter(Boolean).map(m => +m[1]).sort((a, b) => a - b);

/** Konvertera till JPEG (högst maxW bred) via en temporär fil – en trasig bild lämnar aldrig en halv fil */
function convert(src, out, maxW) {
  return new Promise((resolve) => {
    try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { return resolve(false); }
    const tmp = `${out}.${process.pid}.tmp`;
    execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-i', src, '-frames:v', '1',
      '-vf', `scale='min(${maxW},iw)':-2:flags=lanczos`, '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', '-update', '1', tmp], { timeout: 30000 }, (e) => {
      if (!e) { try { fs.renameSync(tmp, out); return resolve(true); } catch {} }
      fs.rm(tmp, { force: true }, () => {});
      console.warn('[lokal] kunde inte läsa bilden', src, e ? String(e.message).split('\n')[0] : '');
      resolve(false);
    });
  });
}

/**
 * Lokala bilder för en titel. want = typ → källfil (null = finns inte längre, undefined = rör inte). Typer som
 * titeln hade som lokala men som inte finns i want räknas som borttagna. Returnerar true om en affisch/bakgrund togs bort (TMDB:s
 * bild kan hämtas igen).
 */
async function syncImages(row, want) {
  const local = localOf(row);
  for (const k of Object.keys(local)) if (!(k in want)) want[k] = null;
  let changed = false, removed = false;
  const forget = [];
  for (const [type, src] of Object.entries(want)) {
    if (src === undefined) continue;
    const out = imageFile(row.id, type), std = STD.includes(type);
    if (src) {
      let st; try { st = await fs.promises.stat(src); } catch { continue; }
      if (!st.isFile() || st.size > IMG_MAX || st.size === 0) continue;
      const sig = `${src}|${Math.floor(st.mtimeMs)}|${st.size}`;
      if (local[type] === sig && (std ? row[type] : fs.existsSync(out))) continue;
      if (!(await convert(src, out, MAXW[std ? type : 'season']))) continue;
      local[type] = sig; changed = true;
      dropVariants(out);
      if (std) { run(`UPDATE items SET ${type}=1 WHERE id=?`, row.id); forget.push(type); }
    } else if (local[type]) {
      delete local[type]; changed = true;
      fs.rm(out, { force: true }, () => {});
      dropVariants(out);
      if (std) { run(`UPDATE items SET ${type}=0 WHERE id=?`, row.id); forget.push(type); if (type !== 'thumb') removed = true; }
    }
  }
  if (changed) run('UPDATE items SET local_img=? WHERE id=?', Object.keys(local).length ? JSON.stringify(local) : null, row.id);
  if (forget.length) colors.forget(row.id, forget);
  return removed;
}

// ---------- NFO ----------
const sortTitle = (t) => t.toLowerCase().replace(/^(the|a|an|en|ett|den|det)\s+/, '');
const nfoOf = (row) => { try { return JSON.parse(row?.nfo || 'null'); } catch { return null; } };
/** Id:n ur titelns sparade NFO ({ tmdb, imdb, tvdb } eller null) */
export const nfoIds = (row) => nfoOf(row)?.ids || null;

/** Skriv NFO-fälten på titeln (bara de fält som finns i filen) */
export function applyNfo(id) {
  const row = get('SELECT id, kind, title, nfo, tmdb_id, credits_done FROM items WHERE id=?', id);
  const n = nfoOf(row);
  if (!n) return;
  const set = {};
  const title = n.title || null;
  if (title) { set.title = title; set.sort_title = n.sortTitle ? n.sortTitle.toLowerCase() : sortTitle(title); }
  else if (n.sortTitle) set.sort_title = n.sortTitle.toLowerCase();
  if (n.plot) set.overview = n.plot;
  if (n.rating != null) set.rating = n.rating;
  if (n.premiered) set.premiered = n.premiered;
  if (row.kind === 'episode') {
    if (n.season != null && n.episode != null) { set.season = n.season; set.episode = n.episode; set.ep_guess = 0; set.abs_episode = null; }
  } else {
    if (n.year) set.year = n.year;
    if (n.originalTitle) { const t = title || row.title; set.original_title = n.originalTitle.trim() !== String(t).trim() ? n.originalTitle : null; }
    if (n.genres?.length) set.genres = JSON.stringify(n.genres);
    if (n.studio) set.studio = n.studio;
    if (n.ids?.imdb) set.imdb_id = n.ids.imdb;
    const c = n.mpaa ? certFromNfo(n.mpaa) : null;
    if (c) { set.cert = c.cert; set.age = c.age; }
  }
  const cols = Object.keys(set);
  if (cols.length) run(`UPDATE items SET ${cols.map(c => `${c}=?`).join(', ')} WHERE id=?`, ...cols.map(c => set[c]), id);
  // Rollista ur NFO:n bara när titeln inte har någon från TMDB och skådespelarna har TMDB-id (people.id är TMDB:s)
  if (row.kind !== 'episode' && !row.tmdb_id && !row.credits_done) {
    const cast = (n.actors || []).filter(a => a.tmdb).slice(0, people.MAX_CAST)
      .map((a, i) => ({ id: a.tmdb, name: a.name, profile_path: null, role: 'cast', character: a.role, ord: i }));
    if (cast.length) { try { people.saveCredits(id, cast); } catch (e) { console.warn('[nfo] rollista:', e.message); } }
  }
}
/** Efter TMDB: NFO-värdena gäller fortfarande (anropas av scanner.js efter varje matchning) */
export function reapplyNfo(id) { if (get('SELECT nfo IS NOT NULL AS n FROM items WHERE id=?', id)?.n) applyNfo(id); }

const ROOT_TAG = { movie: 'movie', show: 'tvshow', episode: 'episodedetails' };
/** Utan NFO: titeln från filnamnet och värdena hämtas från TMDB igen (serien för ett avsnitt) */
function clearNfo(row, fileTitle) {
  const t = row.nfo && fileTitle ? fileTitle(row) : null;
  if (t?.title) run('UPDATE items SET title=?, sort_title=?, year=COALESCE(?, year) WHERE id=? AND match_locked=0', t.title, sortTitle(t.title), t.year ?? null, row.id);
  run(`UPDATE items SET nfo=NULL, nfo_sig=NULL, meta_done=CASE WHEN kind IN ('movie','show') AND meta_done IN (1,2) AND match_locked=0 THEN 0 ELSE meta_done END WHERE id=?`, row.id);
  if (row.parent_id) run('UPDATE items SET meta_done=0 WHERE id=? AND meta_done IN (1,2) AND match_locked=0', row.parent_id);
}
async function syncNfo(row, file, kind, { enabled, touched, home, fileTitle }) {
  if (!enabled || !file) { if (row.nfo_sig) clearNfo(row, fileTitle); return; }
  let st; try { st = await fs.promises.stat(file); } catch { return; }
  const sig = `${file}|${Math.floor(st.mtimeMs)}|${st.size}`;
  if (sig === row.nfo_sig) { if (touched && row.nfo) applyNfo(row.id); return; }
  if (st.size > NFO_MAX) {
    console.warn(`[nfo] ${file} är för stor (${Math.round(st.size / 1024)} kB) – läses inte`);
    run('UPDATE items SET nfo=NULL, nfo_sig=? WHERE id=?', sig, row.id);
    return;
  }
  let n = null;
  try { n = parseNfo(await fs.promises.readFile(file), ROOT_TAG[kind]); } catch (e) { console.warn('[nfo]', file, e.message); return; }
  if (!n) {
    // Ingen läsbar NFO (fel rotelement, skadad fil): som om filen saknas, men signaturen sparas så att den inte läses om varje gång
    if (row.nfo) clearNfo(row, fileTitle);
    run('UPDATE items SET nfo=NULL, nfo_sig=? WHERE id=?', sig, row.id);
    return;
  }
  run('UPDATE items SET nfo=?, nfo_sig=? WHERE id=?', JSON.stringify(n), sig, row.id);
  applyNfo(row.id);
  // Nytt TMDB-id i filen: matcha om (exakt på id:t, se nfoIds)
  if (kind !== 'episode' && !home && n.ids?.tmdb && n.ids.tmdb !== row.tmdb_id) run('UPDATE items SET meta_done=0 WHERE id=? AND match_locked=0', row.id);
}

const SEASON_DIR = /^(?:season|säsong|staffel|saison|s)[\s._-]*(\d{1,3})$|^(specials|specialavsnitt)$/i;
const base = (f) => path.basename(f, path.extname(f));

/**
 * Lokal metadata för ett bibliotek efter fillistningen.
 * @param {object} lib  biblioteket (lib.nfo, lib.type)
 * @param {{ roots: string[], side: Map, dirs: Set<string>, touched: Set<string>, home: boolean, movieDir: (f: string) => string,
 *   fileTitle: (row: object) => ({ title: string, year: number|null } | null) }} o
 *   side = sideIndex(...), dirs = mappar som lästes helt, touched = filer som lästes om i den här skanningen,
 *   fileTitle = titeln enligt filen/mappen (när en NFO tas bort)
 */
export async function syncLocal(lib, { roots, side, dirs, touched, home, movieDir, fileTitle }) {
  const enabled = lib.nfo !== 0;
  const redo = new Set(); // titlar vars TMDB-bild togs bort lokalt: hämta från TMDB igen
  if (lib.type === 'movie') {
    const rows = all(`SELECT id, kind, path, version_of, nfo, nfo_sig, local_img, poster, backdrop, thumb, tmdb_id FROM items
      WHERE library_id=? AND kind='movie' AND path IS NOT NULL`, lib.id);
    const paths = new Map(), titlesIn = new Map();
    for (const r of rows) {
      const main = r.version_of ?? r.id;
      if (!paths.has(main)) paths.set(main, []);
      paths.get(main).push(r.path);
      const d = movieDir(r.path);
      if (!titlesIn.has(d)) titlesIn.set(d, new Set());
      titlesIn.get(d).add(main);
    }
    for (const r of rows) {
      if (r.version_of != null) continue;
      const dir = movieDir(r.path);
      if (!dirs.has(dir)) continue;
      // Allmänna namn (movie.nfo, poster.jpg, fanart.jpg) bara när filmen har en egen mapp
      const own = !roots.includes(dir) && titlesIn.get(dir)?.size === 1;
      const bases = (paths.get(r.id) || []).filter(p => path.dirname(p) === dir).map(base);
      const nfo = findNfo(side, dir, [...bases.map(b => b + '.nfo'), ...(own ? ['movie.nfo'] : [])]);
      await syncNfo(r, nfo, 'movie', { enabled, touched: (paths.get(r.id) || []).some(p => touched.has(p)), home, fileTitle });
      const want = {
        poster: findImage(side, dir, [...bases.map(b => b + '-poster'), ...(own ? ['poster', 'folder', 'cover', 'movie'] : [])]),
        backdrop: findImage(side, dir, [...bases.flatMap(b => [b + '-fanart', b + '-backdrop']), ...(own ? ['fanart', 'backdrop', 'background'] : [])]),
        thumb: findImage(side, dir, [...bases.flatMap(b => [b + '-thumb', b + '-landscape']), ...(own ? ['landscape'] : [])])
      };
      if (await syncImages(r, want)) redo.add(r.id);
    }
  } else if (lib.type === 'show') {
    const eps = all(`SELECT id, path, parent_id, season, nfo, nfo_sig, local_img, thumb FROM items WHERE library_id=? AND kind='episode' AND path IS NOT NULL`, lib.id);
    const showDir = new Map(), seasonDirs = new Map(), seasons = new Map();
    for (const e of eps) {
      const root = rootOf(roots, e.path), parts = relOf(roots, e.path).split(path.sep);
      if (!seasons.has(e.parent_id)) seasons.set(e.parent_id, new Set());
      seasons.get(e.parent_id).add(e.season);
      if (root && parts.length > 1 && !showDir.has(e.parent_id)) showDir.set(e.parent_id, path.join(root, parts[0]));
      if (root && parts.length > 2 && SEASON_DIR.test(parts[1])) {
        const k = `${e.parent_id}:${e.season}`;
        if (!seasonDirs.has(k)) seasonDirs.set(k, path.join(root, parts[0], parts[1]));
      }
      const dir = path.dirname(e.path);
      if (!dirs.has(dir)) continue;
      const b = base(e.path);
      await syncNfo(e, findNfo(side, dir, [b + '.nfo']), 'episode', { enabled, touched: touched.has(e.path), home });
      await syncImages(e, { thumb: findImage(side, dir, [b + '-thumb', b]) });
    }
    for (const s of all(`SELECT id, kind, src_name, nfo, nfo_sig, local_img, poster, backdrop, thumb, tmdb_id FROM items WHERE library_id=? AND kind='show'`, lib.id)) {
      const dir = showDir.get(s.id);
      if (!dir || !dirs.has(dir)) continue;
      await syncNfo(s, findNfo(side, dir, ['tvshow.nfo']), 'show', { enabled, touched: false, home, fileTitle });
      const want = {
        poster: findImage(side, dir, ['poster', 'folder', 'cover', 'show']),
        backdrop: findImage(side, dir, ['fanart', 'backdrop', 'background'])
      };
      for (const n of seasons.get(s.id) || []) {
        const p2 = String(n).padStart(2, '0');
        const sd = seasonDirs.get(`${s.id}:${n}`);
        // En säsongsmapp som inte gick att läsa: behåll affischen som den är
        if (sd && !dirs.has(sd)) { want[`season${n}`] = undefined; continue; }
        want[`season${n}`] = findImage(side, dir, [`season${p2}-poster`, `season${n}-poster`, ...(n === 0 ? ['season-specials-poster'] : [])])
          || (sd ? findImage(side, sd, ['poster', 'folder', 'cover']) : null);
      }
      if (await syncImages(s, want)) redo.add(s.id);
    }
  }
  if (redo.size && !home) for (const id of redo) run('UPDATE items SET meta_done=0 WHERE id=? AND meta_done IN (1,2)', id);
}
