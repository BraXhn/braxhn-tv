// Fotobibliotek: bilder (JPEG, PNG, WebP, GIF, HEIC/HEIF) och videoklipp från telefoner (MOV/MP4) i en tidslinje,
// album (= mappar), "Den här dagen" och favoriter. Allt lokalt – inga molntjänster, inga kartor.
//
// Skanningen läser EXIF i ren JS (exif.js): datum/tid, kamera, objektiv, exponering, orientering och GPS. Tiden sparas
// som lokal väggklocka (se photos i db.js). Videoklippen får dessutom en rad i items (kind 'movie') så att den vanliga
// spelaren och strömningen används; de raderna syns aldrig i film-/serielistor (ageFilter i http/context.js).
// Miniatyrer görs i bakgrunden med imgsize.js (fasta bredder, EXIF-orienteringen tillämpas) och får en platshållarfärg
// (imgcolor.js). Raderingsskyddet är detsamma som för filmer: per mapp (removable i libpaths.js).
// HEIC kräver ffmpeg 7.1 eller senare (HEIF-behållaren med rutnät); med en äldre ffmpeg hoppas HEIC-filer över med en
// tydlig varning – de tas inte bort ur biblioteket om de lästes in tidigare.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { get, all, run, tx, now, getSetting, CACHE } from './db.js';
import { rootsOf, listRoots, removable, relOf } from './libpaths.js';
import { readImageInfo, heicFromVersion, iso6709 } from './exif.js';
import { probe, scanWarning, removeImages } from './scanner.js';
import { sized, dropVariants, PHOTO_SIZES } from './imgsize.js';
import { averageColor } from './imgcolor.js';
import { permsOf } from './perms.js';

const pexec = promisify(execFile);
export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.jpe', '.png', '.webp', '.gif', '.heic', '.heif', '.hif']);
export const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.3gp']);
const HEIC_EXT = new Set(['.heic', '.heif', '.hif']);
const SKIP_DIR = /^(@eaDir|#recycle|#snapshot|lost\+found|\$RECYCLE\.BIN|System Volume Information)$/i;
const FRAMES = path.join(CACHE, 'photo-frames');
fs.mkdirSync(FRAMES, { recursive: true });
/** Miniatyrens bredd i tidslinjen (görs i förväg) */
export const THUMB_W = 320;
const ext = (f) => path.extname(f).toLowerCase();
const isHeic = (f) => HEIC_EXT.has(ext(f));
export const isPhotoFile = (name) => IMAGE_EXT.has(ext(name)) || VIDEO_EXT.has(ext(name));

// ---------- tid ----------
/** Unix-sekunder → serverns lokala väggklocka räknad som UTC-sekunder (så sparas taken) */
export const wallClock = (unix) => unix - new Date(unix * 1000).getTimezoneOffset() * 60;
const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
/** Dagens datum ('YYYY-MM-DD') i serverns tidszon */
export const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Apples "2021-06-15T14:05:30+0200" → väggklockan (tidszonen i strängen är redan den lokala) */
function localIso(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/.exec(String(s || ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  return Number.isFinite(t) && +m[1] >= 1900 ? t : null;
}
/** Filens tid när EXIF saknas: skapelsetiden om den är tidigare än ändringstiden (kopierade filer), som väggklocka */
const fileTime = (st) => wallClock(Math.floor(Math.min(st.birthtimeMs > 0 ? st.birthtimeMs : Infinity, st.mtimeMs) / 1000));

// ---------- HEIC ----------
let heicP = null;
/** PHOTO_HEIC=1/0 tvingar på/av (tester); annars avgör ffmpeg-versionen och att HEVC-avkodaren finns */
export function heicSupported() {
  if (process.env.PHOTO_HEIC === '1') return Promise.resolve(true);
  if (process.env.PHOTO_HEIC === '0') return Promise.resolve(false);
  return heicP ||= Promise.all([pexec('ffmpeg', ['-hide_banner', '-version'], { timeout: 10000 }), pexec('ffmpeg', ['-hide_banner', '-decoders'], { timeout: 10000, maxBuffer: 4 << 20 })])
    .then(([v, d]) => heicFromVersion(v.stdout) && /^\s*V\S*\s+hevc\s/m.test(d.stdout), () => false);
}
const ffmpegVersion = async () => { try { return /ffmpeg version (\S+)/.exec((await pexec('ffmpeg', ['-hide_banner', '-version'], { timeout: 10000 })).stdout)?.[1] || '?'; } catch { return '?'; } };

// ---------- skanning ----------
async function imageRecord(f, st) {
  let info = { format: null, width: null, height: null, orientation: 1, exif: {} };
  try { info = await readImageInfo(f); } catch (e) { console.warn('[foton] kunde inte läsa', f, e.message); }
  const x = info.exif;
  return { kind: 'image', format: info.format || ext(f).slice(1), taken: x.date ?? fileTime(st), width: info.width, height: info.height,
    orientation: info.orientation || 1, duration: null, make: x.make ?? null, model: x.model ?? null, lens: x.lens ?? null,
    fnumber: x.fnumber ?? null, exposure: x.exposure ?? null, iso: x.iso ?? null, focal: x.focal ?? null, focal35: x.focal35 ?? null,
    lat: x.lat ?? null, lon: x.lon ?? null, alt: x.alt ?? null };
}
async function videoRecord(f, st) {
  const info = await probe(f);
  const loc = iso6709(info.location);
  const taken = localIso(info.createdLocal) ?? (info.created ? wallClock(info.created) : fileTime(st));
  // Visningens storlek: en telefon som filmar stående sparar liggande bild med rotation i behållaren
  let w = info.width, h = info.height;
  try {
    const v = JSON.parse(info.streams || '[]').find(s => s.type === 'video');
    if (v && Math.abs(+v.rotation || 0) % 180 === 90) [w, h] = [h, w];
  } catch {}
  return { kind: 'video', format: ext(f).slice(1), taken, width: w, height: h, orientation: 1, duration: info.duration, probe: info,
    make: null, model: null, lens: null, fnumber: null, exposure: null, iso: null, focal: null, focal35: null,
    lat: loc?.lat ?? null, lon: loc?.lon ?? null, alt: loc?.alt ?? null, failed: !!info.failed };
}
const PHOTO_COLS = ['kind', 'format', 'taken', 'width', 'height', 'orientation', 'duration', 'make', 'model', 'lens', 'fnumber', 'exposure', 'iso', 'focal', 'focal35', 'lat', 'lon', 'alt'];
function save(lib, f, st, rec, k, roots) {
  const folder = path.dirname(relOf(roots, f)).split(path.sep).join('/').replace(/^\.$/, '');
  const name = path.basename(f);
  const mtime = rec.failed ? 0 : Math.floor(st.mtimeMs / 1000); // misslyckad läsning: försök igen nästa skanning
  const day = dayOf(rec.taken);
  let itemId = k?.item_id ?? null;
  if (rec.kind === 'video') {
    const i = rec.probe, title = path.basename(f, path.extname(f));
    const vals = [title, title.toLowerCase(), new Date(rec.taken * 1000).getUTCFullYear(), st.size, mtime, i.duration, i.container, i.vcodec, i.acodec, i.width, i.height, i.streams, rec.taken, folder, i.hdr];
    if (itemId && get('SELECT 1 FROM items WHERE id=? AND library_id=?', itemId, lib.id)) {
      run(`UPDATE items SET title=?, sort_title=?, year=?, size=?, mtime=?, duration=?, container=?, vcodec=?, acodec=?, width=?, height=?, streams=?, taken=?, folder=?, hdr=?, thumb=0 WHERE id=?`, ...vals, itemId);
    } else {
      itemId = Number(run(`INSERT INTO items(title, sort_title, year, size, mtime, duration, container, vcodec, acodec, width, height, streams, taken, folder, hdr, library_id, kind, path, added)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'movie',?,?)`, ...vals, lib.id, f, now()).lastInsertRowid);
    }
  } else if (itemId) { run('DELETE FROM items WHERE id=?', itemId); removeImages(itemId); itemId = null; }
  const v = PHOTO_COLS.map(c => rec[c] ?? null);
  if (k) run(`UPDATE photos SET ${PHOTO_COLS.map(c => c + '=?').join(', ')}, folder=?, name=?, size=?, mtime=?, day=?, md=?, item_id=?, thumb=0 WHERE id=?`,
    ...v, folder, name, st.size, mtime, day, day.slice(5), itemId, k.id);
  else run(`INSERT INTO photos(${PHOTO_COLS.join(', ')}, folder, name, size, mtime, day, md, item_id, library_id, path, added) VALUES(${PHOTO_COLS.map(() => '?').join(',')},?,?,?,?,?,?,?,?,?,?)`,
    ...v, folder, name, st.size, mtime, day, day.slice(5), itemId, lib.id, f, now());
}

/**
 * Skannar ett fotobibliotek (alla mappar). Bara nya och ändrade filer läses. Försvunna filer tas bort med samma
 * raderingsskydd som filmer: en mapp som inte går att läsa, som är tom eller där mer än hälften försvunnit rör inget.
 * @returns {Promise<{ found: number, changed: number, removed: number, skippedHeic: number }>}
 */
export async function scanPhotos(lib, status = {}) {
  status.phase = 'Söker foton'; status.done = 0; status.total = 0;
  const roots = rootsOf(lib);
  const list = await listRoots(roots, isPhotoFile, (n) => SKIP_DIR.test(n));
  const res = { found: 0, changed: 0, removed: 0, skippedHeic: 0 };
  if (!list.rootOk) { scanWarning(`${lib.name}: biblioteksmappen går inte att läsa – inga foton tas bort (är disken/NAS:en monterad?)`); return res; }
  for (const d of list.failed) if (!roots.includes(d)) scanWarning(`${lib.name}: kunde inte läsa ${d} – foton där behålls`);
  const known = new Map(all('SELECT id, path, size, mtime, kind, item_id FROM photos WHERE library_id=?', lib.id).map(r => [r.path, r]));
  const seen = new Set();
  let files = list.files;
  if (!(await heicSupported())) {
    const heic = files.filter(isHeic);
    if (heic.length) {
      files = files.filter(f => !isHeic(f));
      for (const f of heic) seen.add(f); // redan inlästa HEIC-bilder behålls
      res.skippedHeic = heic.length;
      const msg = `${lib.name}: ${heic.length} HEIC/HEIF-bilder hoppades över – ffmpeg ${await ffmpegVersion()} i imagen kan inte avkoda HEIC (kräver ffmpeg 7.1 eller senare). Exportera som JPEG eller välj "Mest kompatibel" i iPhonens kamerainställningar.`;
      scanWarning(msg);
    }
  }
  res.found = files.length;
  status.total = files.length; status.phase = 'Läser foton';
  const pending = []; let flushed = Date.now();
  const flush = () => {
    if (!pending.length) return;
    const ops = pending.splice(0);
    tx(() => { for (const op of ops) { try { op(); } catch (e) { console.warn('[foton] kunde inte spara:', e.message); } } });
    flushed = Date.now();
  };
  try {
    for (const f of files) {
      status.done++; seen.add(f);
      if (pending.length >= 200 || Date.now() - flushed > 2000) flush();
      let st; try { st = await fs.promises.stat(f); } catch { continue; }
      const k = known.get(f);
      if (k && k.size === st.size && k.mtime === Math.floor(st.mtimeMs / 1000)) continue;
      const rec = VIDEO_EXT.has(ext(f)) ? await videoRecord(f, st) : await imageRecord(f, st);
      res.changed++;
      pending.push(() => save(lib, f, st, rec, k, roots));
      if (k) dropVariants(f);
    }
  } finally { flush(); }
  const missing = removable({ name: lib.name, list, rows: [...known.values()], seen, found: files,
    allowMass: getSetting('scan_allow_mass_delete', '0') === '1', warn: scanWarning });
  if (missing.length) {
    tx(() => { for (const r of missing) { run('DELETE FROM photos WHERE id=?', r.id); if (r.item_id) run('DELETE FROM items WHERE id=?', r.item_id); } });
    for (const r of missing) { dropVariants(r.path); if (r.item_id) removeImages(r.item_id); }
    res.removed = missing.length;
  }
  kickThumbs(500);
  return res;
}

// ---------- miniatyrer och platshållarfärg (bakgrunden) ----------
// Stillbilderna görs av /api/photos/:id/img (vilken inloggad tittare som helst) och miniatyrjobbet: högst två ffmpeg
// samtidigt, samma stillbild bara en gång även om många frågar, och ett klipp som inte gick att läsa försöks inte
// igen förrän om en timme (förut startade varje förfrågan en egen ffmpeg, utan tak).
const FRAME_LIMIT = 2;
let frameActive = 0;
const frameWait = [], frameJobs = new Map(), frameFailed = new Map();
/** Räknare (tester): antal ffmpeg-körningar och högsta antal samtidigt */
export const frameStats = { runs: 0, max: 0 };
async function frameSlot(fn) {
  // Platsen lämnas över direkt till nästa väntande (som subSlot i stream.js)
  if (frameActive >= FRAME_LIMIT) await new Promise(r => frameWait.push(r)); else frameActive++;
  try { return await fn(); } finally { const next = frameWait.shift(); if (next) next(); else frameActive--; }
}
async function extractFrame(r, out) {
  for (const at of ['1', '0']) {
    try {
      frameStats.runs++; frameStats.max = Math.max(frameStats.max, frameActive);
      await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-ss', at, '-i', r.path,
        '-frames:v', '1', '-vf', "scale='min(2560,iw)':-2", '-q:v', '3', '-f', 'image2', '-update', '1', out + '.tmp'], { timeout: 60000 });
      fs.renameSync(out + '.tmp', out);
      return out;
    } catch {}
  }
  fs.rmSync(out + '.tmp', { force: true });
  frameFailed.set(out, Date.now());
  if (frameFailed.size > 5000) frameFailed.clear();
  return null;
}
/** Videoklippets stillbild (en sekund in) – i cachen, med sökväg, storlek och ändringstid i namnet */
function frameOf(r) {
  const out = path.join(FRAMES, crypto.createHash('sha1').update(`${r.path}|${r.size}|${r.mtime}`).digest('hex').slice(0, 24) + '.jpg');
  if (fs.existsSync(out)) return Promise.resolve(out);
  if ((frameFailed.get(out) || 0) > Date.now() - 3600e3) return Promise.resolve(null);
  if (frameJobs.has(out)) return frameJobs.get(out);
  const p = frameSlot(() => fs.existsSync(out) ? out : extractFrame(r, out)).finally(() => frameJobs.delete(out));
  frameJobs.set(out, p);
  return p;
}
/** Källan för bilder av fotot: filen (eller videons stillbild) och hur imgsize ska skala den */
async function sourceOf(r) {
  if (r.kind === 'video') { const f = await frameOf(r); return f ? { file: f, opts: { sizes: PHOTO_SIZES } } : null; }
  const heic = r.format === 'heic' || isHeic(r.path);
  return { file: r.path, opts: { sizes: PHOTO_SIZES, orient: heic ? 0 : r.orientation || 1, force: heic, heif: heic } };
}
/** Webbläsaren kan visa originalet (JPEG, PNG, WebP, GIF) – HEIC och video får en JPEG */
const browserNative = (r) => r.kind === 'image' && ['jpeg', 'png', 'webp', 'gif'].includes(r.format);
/**
 * Filen att skicka för fotot i bredden ?w= (PHOTO_SIZES, uppåt). Utan w: originalet om webbläsaren kan visa det,
 * annars den största JPEG-varianten. null = gick inte (t.ex. HEIC utan stöd i ffmpeg).
 */
export async function imageFile(r, wq) {
  const src = await sourceOf(r);
  if (!src) return null;
  const w = wq ?? (browserNative(r) ? null : PHOTO_SIZES.at(-1));
  if (w == null) return r.path;
  const out = await sized(src.file, w, Infinity, src.opts);
  if (src.opts.force && out === src.file) return null;
  return out;
}

let busy = () => false;
/** Miniatyrerna väntar medan video omkodas (app.js) */
export function setBusyCheck(fn) { busy = fn; }
let thumbRunning = false, thumbAgain = false, thumbTimer = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.());
async function thumbWork() {
  if (thumbRunning) { thumbAgain = true; return; }
  thumbRunning = true;
  try {
    for (;;) {
      thumbAgain = false;
      const rows = all('SELECT id, path, kind, format, orientation, size, mtime FROM photos WHERE thumb=0 ORDER BY taken DESC LIMIT 50');
      if (!rows.length) { if (thumbAgain) continue; break; }
      for (const r of rows) {
        while (busy()) await sleep(5000);
        let color = null;
        try {
          const src = await sourceOf(r);
          const out = src ? await sized(src.file, THUMB_W, Infinity, src.opts) : null;
          if (out && !(src.opts.force && out === src.file)) color = await averageColor(out);
        } catch (e) { console.warn('[foton] miniatyr', r.path, e.message); }
        // 2 = gick inte (trasig fil, okänt format) – försöks igen när filen ändras
        run('UPDATE photos SET thumb=?, color=? WHERE id=? AND thumb=0', color ? 1 : 2, color, r.id);
      }
    }
  } catch (e) { console.warn('[foton] miniatyrer:', e.message); }
  finally { thumbRunning = false; }
}
/** Startar miniatyrjobbet om en stund */
export function kickThumbs(ms = 2000) {
  if (thumbTimer) return;
  thumbTimer = setTimeout(() => { thumbTimer = null; thumbWork(); }, ms);
  thumbTimer.unref?.();
}
/** För tester: kör miniatyrjobbet tills inget återstår */
export async function fillThumbs() { await thumbWork(); while (thumbRunning) await sleep(20); }

// ---------- behörighet ----------
/**
 * Får användaren se fotobiblioteket? Biblioteksbehörigheten (perms.js) som för allt annat. Foton har ingen åldersgräns:
 * profiler med åldersgräns (barnprofiler) bara när administratören slagit på det för biblioteket (libraries.kids).
 */
export function canSeeLib(uid, lib) {
  if (!lib || lib.type !== 'photo') return false;
  const pm = permsOf(uid);
  if (pm.libs != null && !pm.libs.includes(lib.id)) return false;
  return pm.maxAge == null || lib.kids === 1;
}
export const photoLibs = (uid) => all("SELECT * FROM libraries WHERE type='photo' ORDER BY name").filter(l => canSeeLib(uid, l));
/** Fotot (hela raden) om användaren får se det, annars null */
export function photoFor(uid, id) {
  const r = get('SELECT p.*, l.type AS lib_type, l.kids AS lib_kids FROM photos p JOIN libraries l ON l.id=p.library_id WHERE p.id=?', +id || 0);
  return r && canSeeLib(uid, { id: r.library_id, type: r.lib_type, kids: r.lib_kids }) ? r : null;
}

// ---------- listor ----------
const SEL = `SELECT p.id, p.library_id, p.taken, p.day, p.width, p.height, p.color, p.kind, p.duration, p.item_id, f.photo_id IS NOT NULL AS fav
  FROM photos p LEFT JOIN photo_favorites f ON f.photo_id=p.id AND f.user_id=?`;
/** Kompakt form för rutnät och visning: id, t (taken), w/h (visningens storlek), c (färg), v (video), d (längd), item (spelaren), fav */
export const compact = (r) => {
  const o = { id: r.id, t: r.taken, w: r.width || 0, h: r.height || 0 };
  if (r.color) o.c = r.color;
  if (r.kind === 'video') { o.v = 1; o.d = r.duration ? Math.round(r.duration) : 0; if (r.item_id) o.item = r.item_id; }
  if (r.fav) o.fav = 1;
  return o;
};
/** Tidslinjens index: antal per dag (nyast först) – räcker för att räkna ut hela rutnätets höjd i webbläsaren */
export function timeline(lib, uid, { fav = false } = {}) {
  const days = fav
    ? all('SELECT p.day AS d, COUNT(*) AS n FROM photo_favorites f JOIN photos p ON p.id=f.photo_id WHERE f.user_id=? AND p.library_id=? GROUP BY p.day ORDER BY p.day DESC', uid, lib.id)
    : all('SELECT day AS d, COUNT(*) AS n FROM photos WHERE library_id=? GROUP BY day ORDER BY day DESC', lib.id);
  const favorites = get('SELECT COUNT(*) AS n FROM photo_favorites f JOIN photos p ON p.id=f.photo_id WHERE f.user_id=? AND p.library_id=?', uid, lib.id).n;
  return { days: days.map(r => [r.d, r.n]), total: days.reduce((a, r) => a + r.n, 0), favorites };
}
/** Alla foton en månad ('YYYY-MM'), i tidslinjens ordning */
export function month(lib, uid, ym, { fav = false } = {}) {
  return all(`${SEL} WHERE p.library_id=? AND p.day >= ? AND p.day <= ?${fav ? ' AND f.photo_id IS NOT NULL' : ''} ORDER BY p.day DESC, p.taken DESC, p.id DESC`,
    uid, lib.id, ym + '-01', ym + '-31').map(compact);
}
/** Mappen som album: undermapparna (antal, datum, omslag) och fotona direkt i mappen */
export function album(lib, uid, folder) {
  const pre = folder ? folder + '/' : '';
  const rows = all(`SELECT folder, COUNT(*) AS n, MIN(taken) AS first, MAX(taken) AS latest FROM photos
    WHERE library_id=? AND length(folder) > ? AND substr(folder, 1, ?)=? GROUP BY folder`, lib.id, pre.length, pre.length, pre);
  const by = new Map();
  for (const r of rows) {
    const name = r.folder.slice(pre.length).split('/')[0];
    if (!name) continue;
    const g = by.get(name) || { name, path: pre + name, count: 0, first: null, latest: null, src: null };
    g.count += r.n;
    if (g.first == null || r.first < g.first) g.first = r.first;
    if (g.latest == null || r.latest > g.latest) { g.latest = r.latest; g.src = r.folder; }
    by.set(name, g);
  }
  const folders = [...by.values()].sort((a, b) => (b.latest || 0) - (a.latest || 0) || a.name.localeCompare(b.name, 'sv', { numeric: true }));
  for (const g of folders) {
    // Omslaget: den senaste bilden med miniatyr i den undermapp som har den senaste bilden
    const c = get(`SELECT id, color FROM photos WHERE library_id=? AND folder=? ORDER BY thumb=1 DESC, taken DESC LIMIT 1`, lib.id, g.src);
    g.cover = c ? { id: c.id, c: c.color || undefined } : null;
    delete g.src;
  }
  const photos = all(`${SEL} WHERE p.library_id=? AND p.folder=? ORDER BY p.taken DESC, p.id DESC LIMIT 20000`, uid, lib.id, folder).map(compact);
  return { folder, name: folder ? folder.split('/').at(-1) : lib.name, parent: folder ? folder.split('/').slice(0, -1).join('/') : null, folders, photos };
}
/** "Den här dagen": foton från dagens datum tidigare år, per år (nyast först). withPhotos = alla foton (vyn), annars bara omslag och antal (startsidan). */
export function memories(uid, date = today(), { withPhotos = false, perYear = 300 } = {}) {
  const libs = photoLibs(uid);
  if (!libs.length) return [];
  const rows = all(`${SEL} WHERE p.md=? AND p.day < ? AND p.library_id IN (SELECT value FROM json_each(?)) ORDER BY p.day DESC, p.taken DESC LIMIT 5000`,
    uid, date.slice(5), date.slice(0, 4) + '-01-01', JSON.stringify(libs.map(l => l.id)));
  const year = +date.slice(0, 4), groups = new Map();
  for (const r of rows) {
    const y = +r.day.slice(0, 4);
    let g = groups.get(y);
    if (!g) groups.set(y, g = { year: y, yearsAgo: year - y, day: r.day, library: r.library_id, count: 0, cover: null, photos: [] });
    g.count++;
    // Omslaget: en favorit om det finns, annars den första bilden (inte ett videoklipp)
    if (!g.cover || (r.fav && !g.cover.fav) || (g.cover.v && r.kind !== 'video')) g.cover = compact(r);
    if (withPhotos && g.photos.length < perYear) g.photos.push(compact(r));
  }
  const out = [...groups.values()];
  if (!withPhotos) for (const g of out) delete g.photos;
  return out;
}
/** Hela informationen om ett foto (visningens informationspanel) */
export function info(r, uid) {
  const fav = !!get('SELECT 1 FROM photo_favorites WHERE user_id=? AND photo_id=?', uid, r.id);
  return { ...compact({ ...r, fav }), library: r.library_id, name: r.name, folder: r.folder, kind: r.kind, format: r.format, size: r.size,
    orientation: r.orientation, day: r.day, camera: [r.make, r.model].filter(Boolean).length ? { make: r.make, model: r.model } : null,
    lens: r.lens, fnumber: r.fnumber, exposure: r.exposure, iso: r.iso, focal: r.focal, focal35: r.focal35,
    gps: r.lat != null && r.lon != null ? { lat: r.lat, lon: r.lon, alt: r.alt } : null, duration: r.duration };
}
export function setFavorite(uid, id, on) {
  if (on) run('INSERT INTO photo_favorites(user_id, photo_id, created) VALUES(?,?,?) ON CONFLICT DO NOTHING', uid, id, now());
  else run('DELETE FROM photo_favorites WHERE user_id=? AND photo_id=?', uid, id);
  return on;
}
/** Antal foton i biblioteket (bibliotekslistan) */
export const countOf = (libId) => get('SELECT COUNT(*) AS n FROM photos WHERE library_id=?', libId).n;
