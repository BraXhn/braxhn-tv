// Trailers, extramaterial och temamusik för filmer och serier.
//
// Extramaterial (som Plex/Jellyfin): filer i undermapparna Trailers/, Featurettes/, Behind The Scenes/, Deleted Scenes/,
// Interviews/, Scenes/, Shorts/, Extras/ och Other/ i filmens eller seriens mapp, och filer med Plex-suffix
// ("Film (2020)-trailer.mkv", "-behindthescenes", "-deleted", "-featurette", "-interview", "-scene", "-short", "-other")
// kopplas till titeln i stället för att bli egna titlar. Allt ligger i tabellen trailers (kind = typen); apparna läser
// bara trailers (trailersOf), webbens hylla "Extramaterial" allt (extrasOf). Strömmen är /api/trailers/:tid/stream med
// mediatoken för just den filen (TRAILER_SCOPE) och huvudtitelns åldersgräns (routes/library.js).
// Temamusik: theme.mp3/theme.m4a i filmens eller seriens mapp (items.theme), spelas svagt på titelsidan i webben.
// YouTube-trailers från TMDB sparas som nyckel (items.trailer_yt).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { get, all, run, tx, now } from './db.js';
import { underFailed } from './util.js';
import { relOf, rootsOf, removable } from './libpaths.js';

// Mediatoken för en trailer/ett extramaterial gäller bara den filen (router.js: scope = TRAILER_SCOPE + radens id)
export const TRAILER_SCOPE = 6.5e9;

// Typerna i den ordning hyllan visar dem: [rubrik, namn på en enskild fil]
export const EXTRA_TYPES = {
  trailer: ['Trailers', 'Trailer'], featurette: ['Featurettes', 'Featurette'], behindthescenes: ['Bakom kulisserna', 'Bakom kulisserna'],
  deleted: ['Borttagna scener', 'Borttagen scen'], interview: ['Intervjuer', 'Intervju'], scene: ['Scener', 'Scen'],
  short: ['Kortfilmer', 'Kortfilm'], other: ['Övrigt', 'Extramaterial']
};
// Mappnamn (gemener, avskiljare som mellanslag) → typ
const DIR_TYPE = {
  trailer: 'trailer', trailers: 'trailer', featurette: 'featurette', featurettes: 'featurette', 'behind the scenes': 'behindthescenes',
  behindthescenes: 'behindthescenes', 'deleted scenes': 'deleted', deleted: 'deleted', interview: 'interview', interviews: 'interview',
  scene: 'scene', scenes: 'scene', short: 'short', shorts: 'short', extra: 'other', extras: 'other', other: 'other', others: 'other'
};
const normDir = (d) => d.toLowerCase().replace(/[\s._-]+/g, ' ').trim();
const dirType = (d) => Object.prototype.hasOwnProperty.call(DIR_TYPE, normDir(d)) ? DIR_TYPE[normDir(d)] : null;
// Mappar som förr alltid hoppades över (aldrig titlar, inte ens direkt i biblioteksmappen)
const OLD_SKIP = new Set(['extras', 'featurettes']);
const TRAILER_DIR = /^trailers?$/i;
// "Film (2020)-trailer", "Film (2020) - trailer", "Film.2020.trailer", "Film_trailer2" (avskiljare krävs)
const SUFFIX = /^(.*?)[\s._]*[-._][\s._]*trailer(?:[\s._-]*\d{1,2})?$/i;
// Övriga Plex-suffix kräver bindestreck direkt före ("Film (2020)-deleted.mkv") – "The Other.mkv" är en film
const XSUFFIX = /^(.*\S)-(behindthescenes|deleted|featurette|interview|scene|short|other)(?:[\s._-]*\d{1,2})?$/i;
const stem = (f) => path.basename(f, path.extname(f));

/** Är filen en trailer (ska inte bli en egen titel)? */
export const isTrailerFile = (file) => TRAILER_DIR.test(path.basename(path.dirname(file))) || SUFFIX.test(stem(file));
/** Mappen där titeln som trailern hör till ligger */
export const homeDir = (file) => { const d = path.dirname(file); return TRAILER_DIR.test(path.basename(d)) ? path.dirname(d) : d; };

/**
 * Är filen extramaterial? rel = sökvägen relativt biblioteksmappen (delar). Svar:
 *   null – en vanlig titel; 'skip' – varken titel eller extramaterial (Extras/ eller Featurettes/ direkt i biblioteksmappen,
 *   som förr hoppades över); { type, home, named } – extramaterial, home = mappen (relativ, delar) där titeln ligger,
 *   named = filnamnet är ett eget namn (inte bara "Film-trailer").
 * Mappar med extramaterialnamn räknas bara inne i en titels mapp: en mapp "Shorts" direkt i biblioteket är kortfilmer.
 * Trailers/ och trailersuffix gäller som förut även direkt i biblioteksmappen.
 */
export function extraOf(rel, { legacy = false } = {}) {
  const dirs = rel.slice(0, -1), file = rel[rel.length - 1], s = stem(file);
  // Hemvideor: mappar som "Scener" eller "Övrigt" är vanliga där – bara det gamla beteendet (trailers, Extras/Featurettes hoppas över)
  if (legacy) {
    if (dirs.some(d => OLD_SKIP.has(normDir(d)))) return 'skip';
    return TRAILER_DIR.test(dirs[dirs.length - 1] || '') || SUFFIX.test(s) ? { type: 'trailer', home: TRAILER_DIR.test(dirs[dirs.length - 1] || '') ? dirs.slice(0, -1) : dirs, named: !SUFFIX.test(s) } : null;
  }
  // Yttersta extramaterialmappen bestämmer titelns mapp, den innersta typen (Extras/Deleted Scenes/x.mkv = borttagen scen)
  let outer = -1, type = null;
  for (let k = 0; k < dirs.length; k++) {
    const t = dirType(dirs[k]);
    if (!t) continue;
    if (k === 0 && t !== 'trailer') { if (OLD_SKIP.has(normDir(dirs[k]))) return 'skip'; continue; }
    if (outer < 0) outer = k;
    type = t;
  }
  if (outer >= 0) return { type, home: dirs.slice(0, outer), named: !SUFFIX.test(s) && !XSUFFIX.test(s) };
  if (SUFFIX.test(s)) return { type: 'trailer', home: dirs, named: false };
  const m = XSUFFIX.exec(s);
  if (m) return { type: m[2].toLowerCase(), home: dirs, named: false };
  return null;
}
/** Hemvideobibliotek klassas som förr (extraOf legacy) */
export const isLegacy = (lib) => lib.type === 'movie' && !!lib.home_video;
/** Visningsnamn ur filnamnet: "deleted_scene_01" → "Deleted scene 01" */
export function cleanTitle(file) {
  const t = stem(file).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : null;
}

/** Välj vilken film (bland filmerna i samma mapp, [{id, path}]) trailern hör till – null om det är oklart */
export function pickOwner(file, movies) {
  if (!movies.length) return null;
  const norm = (s) => s.toLowerCase().replace(/[\s._-]+/g, ' ').trim();
  const m = stem(file).match(SUFFIX) || stem(file).match(XSUFFIX);
  const nb = norm(m ? m[1] : stem(file));
  const names = movies.map(x => ({ id: x.id, n: norm(stem(x.path)) }));
  const exact = names.find(x => x.n === nb);
  if (exact) return exact.id;
  // Flera filer kan höra till samma film (versioner har samma id) – entydigt om alla pekar på samma film
  const one = (list) => { const ids = new Set(list.map(x => x.id)); return ids.size === 1 ? list[0].id : null; };
  const pref = nb ? names.filter(x => nb.startsWith(x.n) || x.n.startsWith(nb)) : [];
  return one(pref) ?? one(movies);
}

/** Filmerna i biblioteket per mapp (huvudraden: versioner har samma id) */
function moviesByDir(lib) {
  const byDir = new Map();
  for (const m of all(`SELECT COALESCE(version_of, id) AS id, path FROM items WHERE library_id=? AND kind='movie' AND path IS NOT NULL`, lib.id)) {
    const d = path.dirname(m.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(m);
  }
  return byDir;
}

/**
 * Spara bibliotekets extramaterial (inklusive trailers). files = extramaterialfiler som hittades (extraOf), o.list =
 * listRoots-resultatet (mappar som inte gick att läsa, rötternas läge), o.found = alla videofiler som hittades.
 * Filmbibliotek: filen hör till filmen i titelns mapp. Seriebibliotek: o.showIdFor(seriemapp) ger serien.
 * Raderingsskyddet gäller som för titlarna (removable i libpaths.js): en mapp som saknas eller ser tömd ut rör ingenting.
 */
export async function syncExtras(lib, files, o = {}) {
  const list = o.list || { failed: [], roots: [] }, showIdFor = o.showIdFor || (() => null);
  const roots = lib.roots || rootsOf(lib);
  const byDir = lib.type === 'movie' ? moviesByDir(lib) : null;
  const rows = [];
  for (const f of files) {
    const rel = relOf(roots, f).split(path.sep), x = extraOf(rel, { legacy: isLegacy(lib) });
    if (!x || x === 'skip') continue;
    let owner = null;
    if (lib.type === 'movie') {
      const root = roots.find(r => f.startsWith(r + path.sep));
      if (root) owner = pickOwner(f, byDir.get(path.join(root, ...x.home)) || []);
    } else if (x.home.length) owner = showIdFor(x.home[0]);
    if (!owner) continue;
    let st; try { st = await fs.promises.stat(f); } catch { continue; }
    rows.push([owner, f, st.size, Math.floor(st.mtimeMs / 1000), x.type, x.named ? cleanTitle(f) : null]);
  }
  const keep = new Set(rows.map(r => r[1]));
  const known = all('SELECT id, path FROM trailers WHERE library_id=?', lib.id);
  // Utan rötternas läge (äldre anrop): bara det som inte ligger under en oläsbar mapp
  const gone = list.roots?.length
    ? removable({ name: `${lib.name} (extramaterial)`, list, rows: known, seen: keep, found: o.found || files, allowMass: !!o.allowMass, warn: o.warn || (() => {}) })
    : known.filter(r => !keep.has(r.path) && !underFailed(r.path, list.failed || []));
  tx(() => {
    for (const r of gone) run('DELETE FROM trailers WHERE id=?', r.id);
    for (const [item, p, size, mtime, kind, title] of rows)
      run(`INSERT INTO trailers(item_id,library_id,path,size,mtime,added,kind,title) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET item_id=excluded.item_id, library_id=excluded.library_id, size=excluded.size, mtime=excluded.mtime,
        kind=excluded.kind, title=excluded.title`, item, lib.id, p, size, mtime, now(), kind, title);
  });
  return rows.length;
}
/** Äldre namn (bara trailers som filer – samma väg) */
export const syncTrailers = (lib, files, failed = [], showIdFor = () => null) => syncExtras(lib, files, { list: { failed, roots: [] }, showIdFor });

/** Lokala trailers (fälten läses av apparna – bara tillägg) */
export const trailersOf = (itemId) => all("SELECT id, path, size FROM trailers WHERE item_id=? AND kind='trailer' ORDER BY path", itemId)
  .map((t, i, a) => ({ id: t.id, name: a.length > 1 ? `Trailer ${i + 1}` : 'Trailer', size: t.size }));
/** Allt extramaterial för titeln i hyllans ordning: [{ id, type, group, name, size }] */
export function extrasOf(itemId) {
  const rows = all('SELECT id, path, size, kind, title FROM trailers WHERE item_id=? ORDER BY path', itemId);
  const order = Object.keys(EXTRA_TYPES), out = [];
  for (const type of order) {
    const list = rows.filter(r => (EXTRA_TYPES[r.kind] ? r.kind : 'other') === type);
    const unnamed = list.filter(r => !r.title).length;
    let n = 0;
    for (const r of list) out.push({ id: r.id, type, group: EXTRA_TYPES[type][0], name: r.title || (unnamed > 1 ? `${EXTRA_TYPES[type][1]} ${++n}` : EXTRA_TYPES[type][1]), size: r.size });
  }
  return out;
}
export const trailerRow = (id) => get('SELECT * FROM trailers WHERE id=?', id);

// ---------- uppspelning i webbläsare som inte klarar filen ----------
// Extramaterial analyseras inte vid skanningen (som huvudtitlarna). Webben spelar filen direkt och, om webbläsaren
// inte klarar formatet, ?mp4=1: ffmpeg gör om den till fragmenterad MP4 (H.264 kopieras, annat kodas om) i en ström.
const SAFE_IN = ['-protocol_whitelist', 'file,pipe'];
const remuxJobs = new Set();
export const MAX_REMUX = 2;
const vcodecOf = (file) => new Promise(ok => execFile('ffprobe', ['-v', 'error', ...SAFE_IN, '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt',
  '-of', 'csv=p=0', file], { timeout: 8000 }, (e, out) => { const [c, pf] = String(out || '').trim().split(','); ok(e ? null : { codec: c || null, pix: pf || null }); }));
/** Antal pågående omgörningar (tester) */
export const remuxCount = () => remuxJobs.size;
/** Skickar filen som fragmenterad MP4 (utan spolning). false = för många samtidigt. */
export async function serveRemux(req, res, file) {
  if (remuxJobs.size >= MAX_REMUX) return false;
  // HEAD: bara rubrikerna – ingen ffmpeg
  if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-transform' }); res.end(); return true; }
  // Platsen tas innan ffprobe körs: förut kontrollerades taket före väntan, och samtidiga förfrågningar kom alla förbi
  const slot = {};
  remuxJobs.add(slot);
  let v;
  try { v = await vcodecOf(file); } finally { remuxJobs.delete(slot); }
  if (req.destroyed || res.destroyed) return true; // klienten gick under tiden
  const copy = v?.codec === 'h264' && (!v.pix || v.pix === 'yuv420p');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_IN, '-i', file, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
    ...(copy ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2"]),
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  remuxJobs.add(p);
  const done = () => { remuxJobs.delete(p); if (p.exitCode === null) p.kill('SIGKILL'); };
  p.on('exit', () => remuxJobs.delete(p));
  p.on('error', done);
  res.on('close', done);
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-transform' });
  p.stdout.pipe(res);
  return true;
}

// ---------- temamusik ----------
export const THEME = /^theme\.(mp3|m4a)$/i;
/**
 * Sparar temamusiken (items.theme). Film: theme-filen i filmens mapp (inte direkt i biblioteksmappen och bara när mappen
 * har en enda film). Serie: theme-filen direkt i seriens mapp. Rader under en mapp som inte gick att läsa behåller sin.
 */
export function syncThemes(lib, files, { failed = [], showIdFor = () => null } = {}) {
  const roots = lib.roots || rootsOf(lib), found = new Map();
  const byDir = lib.type === 'movie' ? moviesByDir(lib) : null;
  // theme.m4a före theme.mp3 om båda finns (sorterat), en per titel
  for (const f of [...files].sort()) {
    const rel = relOf(roots, f).split(path.sep);
    let id = null;
    if (lib.type === 'movie') {
      if (rel.length < 2) continue;
      const ids = new Set((byDir.get(path.dirname(f)) || []).map(m => m.id));
      if (ids.size === 1) id = [...ids][0];
    } else if (lib.type === 'show' && rel.length === 2) id = showIdFor(rel[0]);
    if (id && !found.has(id)) found.set(id, f);
  }
  tx(() => {
    for (const r of all('SELECT id, theme FROM items WHERE library_id=? AND theme IS NOT NULL', lib.id))
      if (!found.has(r.id) && !underFailed(r.theme, failed)) run('UPDATE items SET theme=NULL WHERE id=?', r.id);
    for (const [id, f] of found) run('UPDATE items SET theme=? WHERE id=? AND (theme IS NULL OR theme<>?)', f, id, f);
  });
  return found.size;
}
// Val per profil: shows (standard på) och movies (standard av). Spelas aldrig om något annat spelar (webben).
export function themePrefs(uid) {
  let p = null;
  try { p = JSON.parse(get('SELECT theme_music FROM users WHERE id=?', uid)?.theme_music || 'null'); } catch {}
  return { shows: p?.shows !== false, movies: p?.movies === true };
}
export function setThemePrefs(uid, b = {}) {
  const cur = themePrefs(uid);
  const next = { shows: typeof b.shows === 'boolean' ? b.shows : cur.shows, movies: typeof b.movies === 'boolean' ? b.movies : cur.movies };
  run('UPDATE users SET theme_music=? WHERE id=?', JSON.stringify(next), uid);
  return next;
}

/** Bästa YouTube-trailern ur TMDB:s videos-svar (officiell trailer före teaser) */
const YT = /^[A-Za-z0-9_-]{6,20}$/;
export function pickYoutube(videos) {
  const list = (videos?.results || []).filter(v => v.site === 'YouTube' && YT.test(String(v.key || '')) && ['Trailer', 'Teaser'].includes(v.type));
  const score = (v) => (v.type === 'Trailer' ? 4 : 0) + (v.official ? 2 : 0) + (v.iso_639_1 === 'sv' ? 1 : 0);
  return list.sort((a, b) => score(b) - score(a))[0]?.key || null;
}
export const youtubeOk = (k) => typeof k === 'string' && YT.test(k);
