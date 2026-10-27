import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, get, all, run, tx, now, getSetting, setSetting, IMAGES } from './db.js';
import * as jobs from './jobs.js';
import { deletionBlocked } from './util.js';
import { rootsOf, listRoots, removable, relOf } from './libpaths.js';
import * as localMeta from './localmeta.js';
import { AGE } from './nfo.js';
import * as os from './opensubtitles.js';
import * as people from './people.js';
import { isTrailerFile, syncTrailers, pickYoutube } from './trailers.js';
import { groupVersions, promoteVersions, moveImages, mergeInto, versionKey } from './versions.js';
import { findMatch, similarity, GOOD } from './match.js';
import { parseMovie, parseEpisode, discRoot, idsIn, clean } from './parse.js';
import { dropVariants } from './imgsize.js';
import * as colors from './imgcolor.js';

const pexec = promisify(execFile);
const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm', '.ts', '.m2ts',
  '.wmv', '.mpg', '.mpeg', '.flv', '.ogv']);

export const status = { running: false, library: null, phase: '', done: 0, total: 0, last: null, warnings: [] };
// Aktivitetsindikatorn: skanning och bakgrundsanalys
jobs.addSource(() => {
  const out = [];
  if (status.running) out.push({ id: 'scan', kind: 'scan', title: `Skannar ${status.library || 'bibliotek'}`, detail: status.phase || '', done: status.done, total: status.total || null });
  const a = status.analysis;
  if (a?.running) out.push({ id: 'analysis', kind: 'analysis', title: `Analyserar ${a.library || 'bibliotek'}`, detail: a.phase || '', done: a.done, total: a.total || null });
  if (a?.queued > (a?.running ? 1 : 0)) out.push({ id: 'analysis-queue', kind: 'analysis', title: 'Väntar på analys', detail: `${a.queued - (a.running ? 1 : 0)} bibliotek i kö`, done: 0, total: null });
  return out;
});
/** Varning från skanningen (t.ex. omonterad NAS) – syns i skanningsstatus och loggen */
export function scanWarning(msg) { console.warn('[scan]', msg); status.warnings.push(msg); if (status.warnings.length > 20) status.warnings.shift(); }

// NFC: filnamn från macOS (SMB) har ofta å/ä/ö som två tecken (NFD) – annars går de inte att söka på eller slå ihop
const sortTitle = (t) => t.toLowerCase().replace(/^(the|a|an|en|ett|den|det)\s+/, '');
/** Filens sökväg relativt den av bibliotekets mappar den ligger i (lib.roots sätts i början av skanningen) */
const rel = (lib, f) => relOf(lib.roots || rootsOf(lib), f);

// Tolkning av filnamn (filmer, avsnitt, Blu-ray-mappar): server/parse.js
export { parseMovie, parseEpisode, discRoot } from './parse.js';

/** Behåll bara huvudfilmen (största .m2ts i BDMV/STREAM) per skiva; övriga klipp och BACKUP-kopior hoppas över */
export async function discMainOnly(files) {
  const best = new Map(), out = [];
  for (const f of files) {
    const root = discRoot(f);
    if (!root) { out.push(f); continue; }
    const rel = f.slice(root.length + 1).split(path.sep).map(x => x.toUpperCase());
    if (rel[1] !== 'STREAM' || rel.length !== 3) continue; // BDMV/BACKUP, PLAYLIST m.m.
    let size = 0; try { size = (await fs.promises.stat(f)).size; } catch { continue; }
    const b = best.get(root);
    if (!b || size > b.size) best.set(root, { f, size });
  }
  for (const { f } of best.values()) out.push(f);
  return out;
}

/** Tidpunkt ur en tagg ("2023-06-24T14:03:11.000000Z", "2023-06-24 14:03:11") i sekunder, null om den saknas/är orimlig
 *  (kameror utan klocka skriver 1904/1970) */
export function createdAt(v) {
  if (!v) return null;
  const s = String(v).trim().slice(0, 40).replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3').replace(/^(\d{4}-\d\d-\d\d) /, '$1T');
  const t = Date.parse(s);
  return Number.isFinite(t) && t > Date.UTC(1975, 0, 1) && t < Date.now() + 86400e3 ? Math.floor(t / 1000) : null;
}
/** Hemvideons datum: inbäddad tagg, annars filens skapelsetid (eller ändringstid om den är tidigare – kopierade filer) */
function takenOf(info, st) {
  if (info.created) return info.created;
  const b = st.birthtimeMs > 0 ? st.birthtimeMs : Infinity;
  return Math.floor(Math.min(b, st.mtimeMs) / 1000);
}
/** Hemvideons titel: filnamnet (punkter och understreck blir mellanslag) */
const homeTitle = (f) => { const b = path.basename(f, path.extname(f)); return clean(b) || b; };

async function probe(file) {
  try {
    const { stdout } = await pexec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-print_format', 'json',
      '-show_format', '-show_streams', file], { maxBuffer: 16 << 20, timeout: 60000 });
    const j = JSON.parse(stdout);
    const streams = (j.streams || []).map(s => ({
      index: s.index, type: s.codec_type, codec: s.codec_name,
      lang: s.tags?.language || null, title: s.tags?.title || null,
      channels: s.channels || null, width: s.width || null, height: s.height || null,
      default: !!s.disposition?.default, forced: !!s.disposition?.forced,
      hi: !!s.disposition?.hearing_impaired,
      // Kommentarsspår och ljudbeskrivning (syntolkning) väljs aldrig automatiskt (playprefs.js)
      ...(s.disposition?.comment ? { comment: true } : {}), ...(s.disposition?.visual_impaired ? { vi: true } : {}),
      // Ljudets profil (t.ex. "Dolby TrueHD + Dolby Atmos") – bibliotekets filter för Atmos/DTS:X (libfilter.js)
      ...(s.codec_type === 'audio' && s.profile ? { profile: String(s.profile).slice(0, 80) } : {}),
      pix: s.pix_fmt || null, transfer: s.color_transfer || null, primaries: s.color_primaries || null,
      // Flätad bild (tt/bb/tb/bt) avflätas vid omkodning (stream.js)
      ...(s.codec_type === 'video' && s.field_order && s.field_order !== 'progressive' && s.field_order !== 'unknown' ? { field: s.field_order } : {}),
      dovi: !!(s.side_data_list || []).find(d => /dovi|dolby vision/i.test(d.side_data_type || '')),
      dvProfile: (s.side_data_list || []).find(d => /dovi|dolby vision/i.test(d.side_data_type || ''))?.dv_profile ?? null
    })).filter(s => ['video', 'audio', 'subtitle'].includes(s.type) && !(s.type === 'video' && ['mjpeg', 'png'].includes(s.codec)));
    const v = streams.find(s => s.type === 'video'), a = streams.find(s => s.type === 'audio');
    const hdr = !v ? null : v.transfer === 'smpte2084' ? (v.dovi ? 'dovi' : 'hdr10') : v.transfer === 'arib-std-b67' ? 'hlg' : v.dovi ? 'dovi' : null;
    // Inspelningsdatum (hemvideor): creation_time i behållaren eller en ström, Apples creationdate
    const ft = j.format?.tags || {};
    const created = createdAt(ft['com.apple.quicktime.creationdate'] || ft.creation_time || ft.date
      || (j.streams || []).map(s => s.tags?.creation_time).find(Boolean));
    return { hdr, created,
      duration: parseFloat(j.format?.duration) || null, container: j.format?.format_name || null,
      vcodec: v?.codec || null, acodec: a?.codec || null, width: v?.width || null, height: v?.height || null,
      streams: JSON.stringify(streams)
    };
  } catch (e) {
    console.warn('[scan] ffprobe misslyckades:', file, e.message);
    return { failed: true, hdr: null, duration: null, container: null, vcodec: null, acodec: null, width: null, height: null, streams: '[]' };
  }
}

const SKIP_DIR = /^(sample|extras|featurettes|@eaDir)$/i;
const isVideo = (name) => VIDEO.has(path.extname(name).toLowerCase()) && !/\bsample\b/i.test(name);

// Serien matchas på namnet från mappen/filen (src_name) – TMDB kan ha bytt titeln. Årtalet ingår i nyckeln
// så att "Doctor Who (1963)" och "Doctor Who (2005)" blir två serier.
// Äldre rader utan src_name matchas på titeln och får src_name ifyllt.
export const showKey = (name, year) => year ? `${name} (${year})` : name;
function showFor(lib, name, year, yearHint = null) {
  const key = showKey(name, year);
  const r = get(`SELECT id FROM items WHERE library_id=? AND kind='show' AND src_name=? COLLATE NOCASE`, lib.id, key);
  if (r) return r.id;
  // Tidigare versioner sparade namnet utan årtal: ta över en sådan serie om årtalet inte talar emot
  const old = year && get(`SELECT id FROM items WHERE library_id=? AND kind='show' AND src_name=? COLLATE NOCASE AND (year IS NULL OR year=?)`, lib.id, name, year);
  if (old) { run('UPDATE items SET src_name=? WHERE id=?', key, old.id); return old.id; }
  const t = get(`SELECT id FROM items WHERE library_id=? AND kind='show' AND src_name IS NULL AND title=? COLLATE NOCASE`, lib.id, name);
  if (t) { run('UPDATE items SET src_name=? WHERE id=?', key, t.id); return t.id; }
  // yearHint: årtalet i filnamnet ("Doctor.Who.2005.S01E01") – hjälper matchningen men ingår inte i nyckeln
  return Number(run(`INSERT INTO items(library_id,kind,title,sort_title,year,src_name,added) VALUES(?,?,?,?,?,?,?)`,
    lib.id, 'show', name, sortTitle(name), year ?? yearHint, key, now()).lastInsertRowid);
}
/** Flytta avsnitt som ligger under fel serie (t.ex. två serier med samma namn men olika år som slogs ihop
 *  av tidigare versioner). Bara strängjämförelser – inga filer läses. */
function regroupShows(lib) {
  const keyOf = new Map(all(`SELECT id, src_name FROM items WHERE library_id=? AND kind='show'`, lib.id).map(r => [r.id, String(r.src_name || '').toLowerCase()]));
  const eps = all(`SELECT id, path, parent_id FROM items WHERE library_id=? AND kind='episode' AND path IS NOT NULL`, lib.id);
  const touched = new Set(), years = new Map();
  // Ny tolkning av mappnamnen (t.ex. "Barn/Bluey" → "Bluey", "Paw Patrol (Svenskt tal)" → "Paw Patrol"): flyttar alla en
  // series avsnitt till samma nya nyckel som ingen annan serie har byter serien bara namn – raden behåller metadata,
  // låsning ("Fel titel?") och Min lista
  const moves = new Map();
  for (const e of eps) {
    const p = parseEpisode(rel(lib, e.path));
    const k = p ? showKey(p.show, p.year) : null;
    if (!moves.has(e.parent_id)) moves.set(e.parent_id, new Set());
    moves.get(e.parent_id).add(k && k.toLowerCase() !== keyOf.get(e.parent_id) ? k : '');
  }
  const taken = new Set(keyOf.values());
  tx(() => {
    for (const [sid, ks] of moves) {
      const [k] = ks;
      if (ks.size !== 1 || !k || taken.has(k.toLowerCase())) continue;
      const name = k.replace(/\s\((?:19|20)\d\d\)$/, '');
      run(`UPDATE items SET src_name=?, title=CASE WHEN tmdb_id IS NULL THEN ? ELSE title END, sort_title=CASE WHEN tmdb_id IS NULL THEN ? ELSE sort_title END,
        meta_done=CASE WHEN meta_done=2 AND match_locked=0 THEN 0 ELSE meta_done END WHERE id=?`, k, name, sortTitle(name), sid);
      keyOf.set(sid, k.toLowerCase()); taken.add(k.toLowerCase());
    }
    for (const e of eps) {
      const p = parseEpisode(rel(lib, e.path));
      if (!p) continue;
      const key = showKey(p.show, p.year);
      if (keyOf.get(e.parent_id) === key.toLowerCase()) continue;
      const sid = showFor(lib, p.show, p.year);
      keyOf.set(sid, key.toLowerCase());
      if (sid === e.parent_id) continue;
      run('UPDATE items SET parent_id=? WHERE id=?', sid, e.id);
      touched.add(e.parent_id).add(sid);
      if (p.year) years.set(sid, p.year);
    }
    for (const id of touched) {
      if (!get('SELECT 1 FROM items WHERE parent_id=? LIMIT 1', id)) { run('DELETE FROM items WHERE id=?', id); removeImages(id); continue; }
      // Matcha om mot TMDB med mappens årtal (om matchningen inte är låst för hand)
      run(`UPDATE items SET year=COALESCE(?, year), meta_done=0 WHERE id=? AND match_locked=0`, years.get(id) ?? null, id);
    }
  });
  if (touched.size) console.log(`[scan] ${lib.name}: ${touched.size} serier delades upp eller slogs ihop efter årtal`);
}
/** Fyll i src_name för serier från tidigare versioner (utifrån ett av seriens avsnitt) */
function backfillSrcNames(lib) {
  const rows = all(`SELECT s.id, (SELECT e.path FROM items e WHERE e.parent_id=s.id AND e.path IS NOT NULL LIMIT 1) AS ep
    FROM items s WHERE s.library_id=? AND s.kind='show' AND s.src_name IS NULL`, lib.id);
  if (!rows.length) return;
  tx(() => {
    for (const r of rows) {
      const p = r.ep && parseEpisode(rel(lib, r.ep));
      if (p?.show) run('UPDATE items SET src_name=? WHERE id=?', showKey(p.show, p.year), r.id);
    }
  });
}

/** Anropas i skannerns transaktion innan försvunna rader tas bort. En fil som bytt namn blir en ny rad – utan detta
 *  skulle framsteg, sedd-markering och Min lista försvinna vid varje uppgradering. Filmer: samma titel+år (den nya
 *  raden blir en version, så att promoteVersions flyttar metadata och framsteg). Avsnitt: samma serie, säsong och
 *  riktiga avsnittsnummer i filnamnet (onumrerade avsnitt matchas aldrig – numret är bara namnordningen). */
function adoptRenamed(lib, missing, known) {
  const fresh = all('SELECT id, path, size, version_of FROM items WHERE library_id=? AND path IS NOT NULL', lib.id).filter(r => !known.has(r.path));
  if (!fresh.length) return;
  const keyOf = (row) => {
    const file = row.path;
    // Hemvideor heter ofta likadant (IMG_0001.MOV i flera mappar): flyttad fil känns igen på storleken
    if (lib.type === 'movie' && lib.home_video) return row.size ? `size:${row.size}` : null;
    if (lib.type === 'movie') return versionKey(parseMovie(file));
    const p = parseEpisode(rel(lib, file));
    return p && p.episode != null ? `${showKey(p.show, p.year).toLowerCase()}\u0000${p.season}\u0000${p.episode}` : null;
  };
  const byKey = new Map();
  for (const r of fresh) {
    if (r.version_of != null) continue;
    const k = keyOf(r);
    if (k && !byKey.has(k)) byKey.set(k, r);
  }
  for (const old of missing) {
    if (old.version_of != null) continue; // en version: framsteget sitter redan på huvudraden
    const k = keyOf(old), nu = k && byKey.get(k);
    if (!nu) continue;
    byKey.delete(k);
    if (lib.type === 'movie') run('UPDATE items SET version_of=? WHERE id=?', old.id, nu.id);
    else mergeInto(old.id, nu.id);
  }
}

// En gång per bibliotek: avsnitt utan nummer i filnamnet som skannats innan numret märktes som gissat.
// Deras titel kan ha skrivits över av fel TMDB-avsnitt (matchat på det gissade numret) – återställ den.
function markGuessedEpisodes(lib) {
  if (lib.type === 'movie' || getSetting(`ep_guess_v1_${lib.id}`, '0') === '1') return;
  const fix = [];
  for (const e of all(`SELECT id, path, parent_id FROM items WHERE library_id=? AND kind='episode' AND ep_guess=0 AND path IS NOT NULL`, lib.id)) {
    const p = parseEpisode(rel(lib, e.path));
    if (p && p.episode == null) fix.push([e, p]);
  }
  tx(() => {
    for (const [e, p] of fix) {
      run('UPDATE items SET ep_guess=1, title=?, sort_title=? WHERE id=?', p.epTitle, sortTitle(p.epTitle), e.id);
      run("UPDATE items SET meta_done=0 WHERE id=? AND meta_done IN (1,2)", e.parent_id);
    }
  });
  setSetting(`ep_guess_v1_${lib.id}`, '1');
}

async function scanLibrary(lib) {
  status.library = lib.name; status.phase = 'Söker filer'; status.done = 0;
  const roots = lib.roots = rootsOf(lib);
  const home = lib.type === 'movie' && !!lib.home_video;
  markGuessedEpisodes(lib);
  // Alla bibliotekets mappar; NFO-filer och bilder bredvid videofilerna samlas in samtidigt (lokal metadata)
  const list = await listRoots(roots, (n) => isVideo(n) || localMeta.isSide(n), (n) => SKIP_DIR.test(n));
  const { failed } = list;
  const found = [], sideFiles = [];
  for (const f of list.files) (isVideo(path.basename(f)) ? found : sideFiles).push(f);
  // Trailers ("Film (2020)-trailer.mkv", mappen trailers/) blir inte egna titlar – de kopplas till titeln efteråt
  const trailerFiles = found.filter(isTrailerFile);
  // Kopierade Blu-ray-skivor: bara huvudfilmen blir en titel (inte varningar, loggor och menyer)
  const files = await discMainOnly(found.filter(f => !isTrailerFile(f)));
  // Onumrerade avsnitt numreras i namnordning per mapp, efter mappens högsta riktiga avsnittsnummer.
  // Filer som redan finns behåller sitt nummer – annars får två avsnitt samma nummer (eller byter nummer)
  // när en ny fil läggs till mitt i namnordningen.
  const dirEps = new Map();
  const unnumberedIndex = (f) => {
    const dir = path.dirname(f);
    if (!dirEps.has(dir)) {
      const eps = files.filter(x => path.dirname(x) === dir).map(x => [x, parseEpisode(rel(lib, x))]).filter(([, p]) => p);
      const loose = eps.filter(([, p]) => p.episode == null).map(([x]) => x).sort((a, b) => a.localeCompare(b, 'sv'));
      const nums = new Map(loose.filter(x => known.get(x)?.episode != null).map(x => [x, known.get(x).episode]));
      let next = Math.max(0, ...eps.filter(([, p]) => p.episode != null).map(([, p]) => p.episode), ...nums.values());
      for (const x of loose) if (!nums.has(x)) nums.set(x, ++next);
      dirEps.set(dir, nums);
    }
    return dirEps.get(dir).get(f);
  };
  if (!list.rootOk) {
    // Ingen mapp går att läsa: rör ingenting (annars töms biblioteket när en NAS inte är monterad)
    scanWarning(deletionBlocked({ name: lib.name, rootOk: false }));
    return;
  }
  // En mapp av flera som inte går att läsa varnas för i raderingsskyddet nedan (titlarna där behålls)
  for (const d of failed) if (!roots.includes(d)) scanWarning(`${lib.name}: kunde inte läsa ${d} – filer där behålls`);
  status.total = files.length;
  const known = new Map(all(`SELECT id,path,size,mtime,episode,ep_guess,version_of FROM items WHERE library_id=? AND path IS NOT NULL`, lib.id).map(r => [r.path, r]));
  if (lib.type === 'show') { backfillSrcNames(lib); regroupShows(lib); }
  const seen = new Set(), touched = new Set();
  const newEpisodes = []; // nyskapade avsnitt (för notiser till dem som följer serien)
  const newMovies = []; // nyskapade filmer (webhooken library.new)
  // Skrivningar samlas och skrivs i en transaktion (var 200:e fil eller varannan sekund). Transaktionen hålls
  // aldrig öppen över en await – annars skulle andra delar av servern hamna i den.
  const pending = []; let flushed = Date.now();
  const flush = () => {
    if (!pending.length) return;
    const ops = pending.splice(0);
    tx(() => { for (const op of ops) { try { op(); } catch (e) { console.warn('[scan] kunde inte spara:', e.message); } } });
    flushed = Date.now();
  };
  status.phase = 'Analyserar filer';
  try {
    for (const f of files) {
      status.done++;
      seen.add(f);
      if (pending.length >= 200 || Date.now() - flushed > 2000) flush();
      let st; try { st = await fs.promises.stat(f); } catch { continue; }
      const k = known.get(f), mtime = Math.floor(st.mtimeMs / 1000);
      // Huvudfilm på en Blu-ray som tidigare fick filnamnet ("00800") som titel: byt till skivans namn
      if (k && lib.type === 'movie' && discRoot(f)) {
        const p = parseMovie(f), raw = path.basename(f, path.extname(f));
        pending.push(() => run(`UPDATE items SET title=?, sort_title=?, year=?, meta_done=0 WHERE id=? AND title=? AND match_locked=0`,
          p.title, sortTitle(p.title), p.year, k.id, raw));
      }
      if (k && k.size === st.size && k.mtime === mtime) continue;
      const info = await probe(f);
      touched.add(f);
      // Misslyckad probe (t.ex. disken vaknade för långsamt): spara mtime 0 så att filen läses om vid nästa skanning
      const saveMtime = info.failed ? 0 : mtime;
      if (lib.type === 'movie') {
        // Hemvideor: titel från filnamnet, datum från filen och mappen (navigering i biblioteket)
        const p = home ? { title: homeTitle(f), year: null } : parseMovie(f);
        const taken = home ? takenOf(info, st) : null, folder = home ? path.dirname(rel(lib, f)).replace(/^\.$/, '') : null;
        if (home) p.year = new Date(taken * 1000).getFullYear();
        pending.push(() => {
          if (k) run(`UPDATE items SET size=?,mtime=?,duration=?,container=?,vcodec=?,acodec=?,width=?,height=?,streams=?,thumb=0,trickplay=0 WHERE id=?`,
            st.size, saveMtime, info.duration, info.container, info.vcodec, info.acodec, info.width, info.height, info.streams, k.id);
          else newMovies.push(Number(run(`INSERT INTO items(library_id,kind,title,sort_title,year,path,size,mtime,duration,container,vcodec,acodec,width,height,streams,added)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, lib.id, 'movie', p.title, sortTitle(p.title), p.year, f, st.size, saveMtime,
            info.duration, info.container, info.vcodec, info.acodec, info.width, info.height, info.streams, now()).lastInsertRowid));
          run('UPDATE items SET hdr=? WHERE path=?', info.hdr, f);
          if (home) run('UPDATE items SET title=?, sort_title=?, year=?, taken=?, folder=? WHERE path=? AND match_locked=0', p.title, sortTitle(p.title), p.year, taken, folder, f);
        });
      } else {
        const p = parseEpisode(rel(lib, f));
        if (!p) { console.warn('[scan] kunde inte tolka avsnitt:', f); continue; }
        const guess = p.episode == null ? 1 : 0;
        if (guess) p.episode = unnumberedIndex(f);
        const showId = showFor(lib, p.show, p.year, p.yearHint);
        const title = p.epTitle || `Avsnitt ${p.episode}`;
        pending.push(() => {
          // Ett gissat nummer som redan matchats mot TMDB på titel (annan säsong) behålls
          if (k && guess && k.ep_guess === 2) run(`UPDATE items SET parent_id=?,size=?,mtime=?,duration=?,container=?,vcodec=?,acodec=?,width=?,height=?,streams=?,thumb=0,trickplay=0 WHERE id=?`,
            showId, st.size, saveMtime, info.duration, info.container, info.vcodec, info.acodec, info.width, info.height, info.streams, k.id);
          else if (k) run(`UPDATE items SET parent_id=?,season=?,episode=?,abs_episode=?,ep_guess=?,size=?,mtime=?,duration=?,container=?,vcodec=?,acodec=?,width=?,height=?,streams=?,thumb=0,trickplay=0 WHERE id=?`,
            showId, p.season, p.episode, p.absolute ? p.episode : null, guess, st.size, saveMtime, info.duration, info.container, info.vcodec, info.acodec, info.width, info.height, info.streams, k.id);
          else newEpisodes.push(Number(run(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,season,episode,abs_episode,ep_guess,path,size,mtime,duration,container,vcodec,acodec,width,height,streams,added)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, lib.id, 'episode', showId, title, sortTitle(title), p.season, p.episode, p.absolute ? p.episode : null, guess, f,
            st.size, saveMtime, info.duration, info.container, info.vcodec, info.acodec, info.width, info.height, info.streams, now()).lastInsertRowid));
          // Hämta om seriens metadata så att nya avsnitt får namn (och absolut numrering mappas till säsonger).
          // Även serier som inte hittades förut får ett nytt försök när avsnitt tillkommer.
          run(`UPDATE items SET added=?, meta_done=CASE WHEN meta_done=1 OR (meta_done=2 AND match_locked=0) THEN 0 ELSE meta_done END WHERE id=?`, now(), showId);
          run('UPDATE items SET hdr=?, markers_done=0 WHERE path=?', info.hdr, f);
          // Datumavsnitt (nyheter, talkshower): sändningsdatumet matchas mot TMDB:s avsnitt (matchEpisodes)
          if (p.date) run('UPDATE items SET released=? WHERE path=?', p.date, f);
        });
      }
    }
  } finally { flush(); }
  // Ta bort försvunna filer och tomma serier – men aldrig om det ser ut som att disken saknas. Skyddet gäller
  // varje mapp för sig: en saknad disk tar aldrig bort något, inte heller från bibliotekets andra mappar.
  const missing = removable({ name: lib.name, list, rows: [...known.values()], seen, found: files,
    allowMass: getSetting('scan_allow_mass_delete', '0') === '1', warn: scanWarning });
  if (missing.length) {
    let moves = [];
    tx(() => {
      // Omdöpt eller utbytt fil (t.ex. Sonarr/Radarr som byter 720p mot 1080p): den nya filen tar över framsteg och Min lista
      adoptRenamed(lib, missing, known);
      // Huvudfilen till en film med flera versioner försvann: en kvarvarande version tar över (med framsteg)
      if (lib.type === 'movie') moves = promoteVersions(missing.map(r => r.id));
      for (const r of missing) run('DELETE FROM items WHERE id=?', r.id);
      for (const s of all(`SELECT id FROM items WHERE library_id=? AND kind='show' AND NOT EXISTS(SELECT 1 FROM items e WHERE e.parent_id=items.id)`, lib.id)) {
        run('DELETE FROM items WHERE id=?', s.id); missing.push(s);
      }
    });
    moveImages(moves);
    for (const r of missing) removeImages(r.id);
  }
  // Filmfiler med samma titel och år blir versioner av samma film (inte hemvideor: "IMG_0001" i två mappar är olika klipp)
  if (!home) groupVersions(lib, parseMovie);
  // NFO-filer och lokala bilder (före TMDB, som inte skriver över dem)
  status.phase = 'Läser lokal metadata';
  const fileTitle = (row) => row.kind === 'show' ? (row.src_name ? { title: row.src_name.replace(/\s\((?:19|20)\d\d\)$/, ''), year: null } : null)
    : row.kind === 'movie' && row.path ? (home ? { title: homeTitle(row.path), year: null } : parseMovie(row.path)) : null;
  await localMeta.syncLocal(lib, { roots, side: localMeta.sideIndex(sideFiles), dirs: list.dirs, touched, home, fileTitle, movieDir: (f) => discRoot(f) || path.dirname(f) })
    .catch(e => console.warn('[scan] lokal metadata:', e.message));
  // Efter grupperingen: en trailer i en mapp med flera versioner hör till filmen
  await syncTrailers(lib, trailerFiles, failed, (folder) => showIdOfFolder(lib, folder)).catch(e => console.warn('[scan] trailers:', e.message));
  await metadata(lib);
  // Nyss matchade filer kan vara samma TMDB-film som en annan fil (t.ex. svensk och engelsk titel) – slå ihop dem
  if (!home) groupVersions(lib, parseMovie);
  if (tmdbKey()) await people.backfill(lib, tmdb, { max: Math.max(0, +(process.env.CREDITS_PER_SCAN || 40)), status, apply: saveTrailerKey });
  // Efter metadata så att notisen får avsnittens riktiga namn
  if (newEpisodes.length) { try { hooks.newEpisodes?.(newEpisodes.filter(id => get('SELECT 1 FROM items WHERE id=?', id))); } catch (e) { console.warn('[scan] notiser om nya avsnitt:', e.message); } }
  // Webhooks (library.new): nya filmer (inte nya versioner av en film som redan fanns) och avsnitt
  if (newMovies.length || newEpisodes.length) {
    const ids = [...newMovies, ...newEpisodes].filter(id => get('SELECT 1 FROM items WHERE id=? AND version_of IS NULL', id));
    try { if (ids.length) hooks.newItems?.(ids); } catch (e) { console.warn('[scan] webhooks för nya titlar:', e.message); }
  }
}

/** Tunga analyser (minuter–timmar för stora bibliotek). Körs i en egen bakgrundskö så att skanning
 *  och metadata aldrig behöver vänta på dem. Allt styrs av flaggor i databasen och kan avbrytas och tas upp igen. */
async function analyzeLibrary(lib, st) {
  // Nyckelbilderna först: utan dem kan filmer inte skickas utan omkodning (remux), vilket är det som gör
  // att stora filmer startar. Miniatyrer, kapitel m.m. kommer efteråt.
  st.phase = 'Indexerar nyckelbilder (för remux)';
  const kf = all(`SELECT id, path, mtime, vcodec, duration FROM items WHERE library_id=? AND vcodec IN ('h264','hevc') AND path IS NOT NULL ORDER BY added DESC`, lib.id);
  st.done = 0; st.total = kf.length;
  for (const it of kf) { st.done++; await hooks.keyframes?.(it); if (st.done % 200 === 0) await new Promise(setImmediate); }
  await thumbnails(lib, st);
  await chapters(lib, st);
  await autoSubtitles(lib, st);
  if (lib.type === 'show' && hooks.markers) { st.phase = 'Letar intro och eftertexter'; await hooks.markers(lib, st); }
  if (hooks.trickplay) await hooks.trickplay(lib, st);
}
/** Serien som en mapp i seriebiblioteket hör till (för trailers i seriens mapp) */
function showIdOfFolder(lib, folder) {
  const y = folder.match(/^(.*?)[\s._(\[-]+((?:19|20)\d\d)[)\]]?$/);
  const key = y ? showKey(clean(y[1]), +y[2]) : showKey(clean(folder), null);
  return get(`SELECT id FROM items WHERE library_id=? AND kind='show' AND src_name=? COLLATE NOCASE`, lib.id, key)?.id || null;
}
// Kopplas in från stream.js / intro.js för att undvika cirkulära importer
export const hooks = {};

export function removeImages(id) {
  for (const t of ['poster', 'backdrop', 'thumb']) { const f = path.join(IMAGES, `${id}-${t}.jpg`); fs.rm(f, { force: true }, () => {}); dropVariants(f); }
  // Lokala säsongsaffischer (localmeta.js)
  fs.rm(path.join(IMAGES, 'season', String(+id)), { recursive: true, force: true }, () => {});
}

/**
 * En mapp togs bort från biblioteket: titlarna i den försvinner (filerna på disken rörs inte). Versioner i
 * bibliotekets andra mappar tar över som huvudrad (med framsteg). Musik och ljudböcker städas av sina skannrar.
 */
export function forgetFolder(lib, root, keep = []) {
  const pre = root + path.sep;
  // Titlar som också ligger under en kvarvarande mapp (t.ex. /media → /media/Filmer) behålls
  const kept = (p) => keep.some(k => p === k || p.startsWith(k + path.sep));
  if (lib.type === 'movie' || lib.type === 'show') {
    const rows = all(`SELECT id, path FROM items WHERE library_id=? AND path IS NOT NULL AND substr(path, 1, ?)=?`, lib.id, pre.length, pre);
    const gone = rows.filter(r => !kept(r.path)).map(r => r.id);
    let moves = [];
    tx(() => {
      if (lib.type === 'movie') moves = promoteVersions(gone);
      for (const id of gone) run('DELETE FROM items WHERE id=?', id);
      for (const s of all(`SELECT id FROM items WHERE library_id=? AND kind='show' AND NOT EXISTS(SELECT 1 FROM items e WHERE e.parent_id=items.id)`, lib.id)) {
        run('DELETE FROM items WHERE id=?', s.id); gone.push(s.id);
      }
      for (const t of all('SELECT id, path FROM trailers WHERE library_id=? AND substr(path, 1, ?)=?', lib.id, pre.length, pre)) if (!kept(t.path)) run('DELETE FROM trailers WHERE id=?', t.id);
    });
    moveImages(moves);
    for (const id of gone) removeImages(id);
    return gone.length;
  }
  const [table, col] = lib.type === 'music' ? ['tracks', 'path'] : lib.type === 'audiobook' ? ['books', 'key'] : [null, null];
  if (!table) return 0;
  let n = 0;
  tx(() => {
    for (const r of all(`SELECT id, ${col} AS p FROM ${table} WHERE library_id=? AND (${col}=? OR substr(${col}, 1, ?)=?)`, lib.id, root, pre.length, pre))
      if (!kept(r.p)) {
        run(`DELETE FROM ${table} WHERE id=?`, r.id); n++;
        // Bokens omslag (audiobooks.js coverFile) – annars kunde en ny bok med samma id få det
        if (table === 'books') fs.rm(path.join(IMAGES, `b${r.id}-cover.jpg`), { force: true }, () => {});
      }
  });
  return n;
}

// ---------- Metadata via TMDB (valfritt, egen gratis API-nyckel) ----------
// TMDB_API_URL: annan adress till TMDB:s API (t.ex. en låtsasserver i testerna)
const TMDB_API = (process.env.TMDB_API_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
function tmdbKey() { return getSetting('tmdb_key') || process.env.TMDB_API_KEY || ''; }
export async function tmdb(p, params = {}, attempt = 0) {
  const key = tmdbKey();
  const q = new URLSearchParams({ language: getSetting('language', 'sv-SE'), ...params });
  const headers = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = 'Bearer ' + key; else q.set('api_key', key);
  const r = await fetch(`${TMDB_API}${p}?${q}`, { headers, signal: AbortSignal.timeout(15000) });
  // Begränsat antal omförsök: en spärrad nyckel får inte låsa skanningskön för alltid
  if (r.status === 429 && attempt < 4) {
    const wait = Math.min(30, +r.headers.get('retry-after') || 2) * 1000;
    await new Promise(s => setTimeout(s, wait)); return tmdb(p, params, attempt + 1);
  }
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}
async function image(tmdbPath, size, id, type) {
  if (!tmdbPath) return 0;
  // En lokal bild (poster.jpg, fanart.jpg … bredvid filen) går före TMDB:s
  if (/^\d+$/.test(String(id)) && localMeta.hasLocal(+id, type)) return 1;
  try {
    const r = await fetch(`https://image.tmdb.org/t/p/${size}${tmdbPath}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return 0;
    fs.writeFileSync(path.join(IMAGES, `${id}-${type}.jpg`), Buffer.from(await r.arrayBuffer()));
    if (/^\d+$/.test(String(id))) colors.forget(+id, [type]); // samlingar ('c12') har ingen färg
    return 1;
  } catch { return 0; }
}

// Åldersgräns: svensk klassning i första hand, annars amerikansk (tabellen AGE delas med NFO-tolkningen, nfo.js)
function pickCert(list) {
  for (const c of ['SE', 'US', 'DE']) {
    const e = list.find(x => x.iso_3166_1 === c && x.cert);
    if (e && AGE[c][e.cert] != null) return { cert: `${c}:${e.cert}`, age: AGE[c][e.cert] };
  }
  return { cert: null, age: null };
}
async function saveCollection(c) {
  if (!c?.id) return null;
  const ex = get('SELECT id FROM collections WHERE id=?', c.id);
  if (!ex) {
    let overview = null;
    try { overview = (await tmdb(`/collection/${c.id}`)).overview || null; } catch {}
    const poster = await image(c.poster_path, 'w500', 'c' + c.id, 'poster');
    const backdrop = await image(c.backdrop_path, 'w1280', 'c' + c.id, 'backdrop');
    run('INSERT OR REPLACE INTO collections(id,name,overview,poster,backdrop) VALUES(?,?,?,?,?)', c.id, c.name, overview, poster, backdrop);
  }
  return c.id;
}

/** TVDB-id för en TMDB-serie (krävs av Sonarr) */
export async function tvdbOf(tmdbId) { try { return (await tmdb(`/tv/${+tmdbId}/external_ids`)).tvdb_id || null; } catch { return null; } }
export const hasTmdb = () => !!tmdbKey();
/**
 * Kontrollerar en TMDB-nyckel (v3-nyckel eller v4-token) utan att spara den – installationsguidens "Testa".
 * Utan nyckel testas den sparade. Nyckeln skrivs aldrig ut i fel eller loggar.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function tmdbCheck(key) {
  key = String(key || '').trim() || tmdbKey();
  if (!key) return { ok: false, error: 'Ingen nyckel angiven' };
  if (key.length > 400 || /\s/.test(key)) return { ok: false, error: 'Nyckeln ser inte rätt ut – kopiera den igen från themoviedb.org' };
  const q = new URLSearchParams();
  const headers = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = 'Bearer ' + key; else q.set('api_key', key);
  let r;
  try { r = await fetch(`${TMDB_API}/configuration?${q}`, { headers, signal: AbortSignal.timeout(10000) }); }
  catch { return { ok: false, error: 'Kunde inte nå TMDB – kontrollera att servern har internet' }; }
  if (r.status === 401) return { ok: false, error: 'TMDB godkände inte nyckeln. Använd "API-nyckel" (v3) eller "API-läsåtkomsttoken" från themoviedb.org → Inställningar → API.' };
  if (!r.ok) return { ok: false, error: `TMDB svarade med fel ${r.status} – försök igen om en stund` };
  return { ok: true };
}

/** Sök i TMDB för manuell matchning */
export async function tmdbSearch(kind, query, year) {
  const tv = kind === 'show';
  const s = await tmdb(tv ? '/search/tv' : '/search/movie', { query, ...(year ? (tv ? { first_air_date_year: year } : { year }) : {}) });
  return (s.results || []).slice(0, 12).map(r => ({ id: r.id, title: r.title || r.name, original: r.original_title || r.original_name,
    year: parseInt(r.release_date || r.first_air_date) || null, overview: (r.overview || '').slice(0, 300),
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w154${r.poster_path}` : null }));
}

// Originaltiteln sparas bara när den skiljer sig från titeln (sökbar via items.skey2)
const originalOf = (orig, title) => orig && String(orig).trim() && String(orig).trim() !== String(title).trim() ? String(orig).trim().slice(0, 300) : null;
// Premiärdatum ('YYYY-MM-DD') – bara ett giltigt datum sparas
const dateOf = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null;
/** TMDB-id ur titelns NFO eller filnamnet ({tmdb-123}, [imdbid-tt…], [tvdbid-…]): tmdb direkt, annars IMDb-/TVDB-id via TMDB:s /find */
async function knownTmdb(item, fileIds) {
  const nfo = localMeta.nfoIds(item) || {};
  const ids = { tmdb: nfo.tmdb || fileIds?.tmdb || null, imdb: nfo.imdb || fileIds?.imdb || null, tvdb: nfo.tvdb || fileIds?.tvdb || null };
  if (ids.tmdb) return ids.tmdb;
  const tv = item.kind === 'show';
  for (const [v, src] of [[ids.imdb, 'imdb_id'], [ids.tvdb, 'tvdb_id']]) {
    if (!v) continue;
    try {
      const r = await tmdb(`/find/${encodeURIComponent(v)}`, { external_source: src });
      const hit = (tv ? r.tv_results : r.movie_results)?.[0]?.id;
      if (hit) return hit;
    } catch (e) { if (/429/.test(e.message)) throw e; }
  }
  return null;
}

// ---- Automatisk matchning (match.js findMatch) ----
// Svar från TMDB under en metadatakörning: samma sökning görs ofta för flera filer (versioner, säsonger). Töms vid varje körning.
const tmdbCache = new Map();
export function clearMatchCache() { tmdbCache.clear(); }
async function cachedTmdb(p, params) {
  const k = p + '?' + new URLSearchParams(params);
  if (tmdbCache.has(k)) return tmdbCache.get(k);
  const v = await tmdb(p, params);
  if (tmdbCache.size > 2000) tmdbCache.clear();
  tmdbCache.set(k, v);
  return v;
}
const matchApi = {
  search: (kind, query, year, lang) => cachedTmdb(kind === 'show' ? '/search/tv' : '/search/movie',
    { query, ...(year ? (kind === 'show' ? { first_air_date_year: year } : { year }) : {}), ...(lang === 'en' ? { language: 'en-US' } : {}) }).then(s => s.results || []),
  alternatives: (kind, id) => cachedTmdb(`/${kind === 'show' ? 'tv' : 'movie'}/${+id}/alternative_titles`, {}).then(r => (r.titles || r.results || []).map(x => x.title)),
  details: (kind, id) => cachedTmdb(`/${kind === 'show' ? 'tv' : 'movie'}/${+id}`, {}),
};
/** Bästa TMDB-träffen (match.js findMatch) via TMDB:s API med cache */
export const matchTmdb = (q) => findMatch(matchApi, q);
// Barnbibliotek och tecknat (bibliotekets namn eller mapparna): animerat/familj går före spelfilm med samma titel
const KIDS_RE = /(?:^|[^\p{L}])(barn\p{L}*|kids?|children|familj\p{L}*|family|disney|pixar|dreamworks|ghibli)(?![\p{L}])/iu;
const ANIM_RE = /(?:^|[^\p{L}])(anime|tecknat|tecknade?|animerat|animerade?|animation|animated|cartoons?)(?![\p{L}])/iu;
/** Vad filen/mappen säger om en film eller serie: tolkade titlar, år, längd, id:n, barn/tecknat och säsonger */
export function matchQuery(item) {
  const lib = get('SELECT * FROM libraries WHERE id=?', item.library_id) || { name: '' };
  const roots = rootsOf(lib);
  let file = item.path, parsed = null;
  if (item.kind === 'movie') parsed = file ? parseMovie(file) : null;
  else {
    file = get('SELECT path FROM items WHERE parent_id=? AND path IS NOT NULL ORDER BY season, episode LIMIT 1', item.id)?.path || null;
    parsed = file ? parseEpisode(relOf(roots, file)) : null;
  }
  const relPath = file ? relOf(roots, file) : '';
  const where = `${lib.name || ''}/${relPath}`;
  const q = { kind: item.kind, kids: KIDS_RE.test(where), anim: !!lib.anime || ANIM_RE.test(where), ids: parsed?.ids || null };
  if (item.kind === 'movie') {
    q.titles = [parsed?.title, item.title];
    q.year = item.year || parsed?.year || null;
    q.duration = item.duration || null;
  } else {
    q.titles = [parsed?.show, item.title, item.src_name ? item.src_name.replace(/\s\((?:19|20)\d\d\)$/, '') : null];
    q.year = item.year || parsed?.year || parsed?.yearHint || null;
    // Säsonger och avsnitt i filerna (inte absolut numrerade, specialavsnitt eller datumavsnitt)
    const eps = all('SELECT season, MAX(episode) AS ep FROM items WHERE parent_id=? AND ep_guess=0 AND abs_episode IS NULL AND season BETWEEN 1 AND 1000 GROUP BY season', item.id);
    q.seasons = eps.length ? { max: Math.max(...eps.map(e => e.season)), eps: lib.anime ? {} : Object.fromEntries(eps.map(e => [e.season, e.ep])) } : null;
  }
  return q;
}
export async function refreshItem(item, tmdbId = null) {
  // Låst matchning ("Fel titel?"): alltid den valda titeln, aldrig en ny sökning
  if (!tmdbId && item.match_locked && item.tmdb_id) tmdbId = item.tmdb_id;
  const mq = !tmdbId && (item.kind === 'movie' || item.kind === 'show') ? matchQuery(item) : null;
  if (!tmdbId && !item.match_locked) tmdbId = await knownTmdb(item, mq?.ids);
  if (item.kind === 'movie') {
    let id = tmdbId;
    if (!id) id = (await matchTmdb(mq))?.id;
    if (!id) return false;
    const d = await tmdb(`/movie/${id}`, { append_to_response: 'release_dates,credits,videos', ...people.videoLangs() });
    const poster = await image(d.poster_path, 'w500', item.id, 'poster');
    const backdrop = await image(d.backdrop_path, 'w1280', item.id, 'backdrop');
    const certs = (d.release_dates?.results || []).map(r => ({ iso_3166_1: r.iso_3166_1, cert: (r.release_dates || []).map(x => x.certification).find(Boolean) }));
    const { cert, age } = pickCert(certs);
    const coll = await saveCollection(d.belongs_to_collection).catch(() => null);
    run(`UPDATE items SET title=?,sort_title=?,year=?,overview=?,rating=?,tmdb_id=?,poster=MAX(poster,?),backdrop=MAX(backdrop,?),meta_done=1,
      genres=?, cert=COALESCE(?,cert), age=COALESCE(?,age), collection_id=?, original_title=?, released=COALESCE(?,released) WHERE id=?`,
      d.title || item.title, sortTitle(d.title || item.title), parseInt(d.release_date) || item.year,
      d.overview || null, d.vote_average || null, id, poster, backdrop,
      JSON.stringify((d.genres || []).map(g => g.name)), cert, age, coll, originalOf(d.original_title, d.title || item.title), dateOf(d.release_date), item.id);
    saveExtras(item, d);
    localMeta.reapplyNfo(item.id); // NFO:ns fält går före TMDB:s
    return true;
  }
  if (item.kind === 'show') {
    let id = tmdbId;
    if (!id) id = (await matchTmdb(mq))?.id;
    if (!id) return false;
    const d = await tmdb(`/tv/${id}`, { append_to_response: 'content_ratings,aggregate_credits,videos', ...people.videoLangs() });
    const { cert, age } = pickCert((d.content_ratings?.results || []).map(r => ({ iso_3166_1: r.iso_3166_1, cert: r.rating })));
    run('UPDATE items SET genres=?, cert=COALESCE(?,cert), age=COALESCE(?,age) WHERE id=?', JSON.stringify((d.genres || []).map(g => g.name)), cert, age, item.id);
    const poster = await image(d.poster_path, 'w500', item.id, 'poster');
    const backdrop = await image(d.backdrop_path, 'w1280', item.id, 'backdrop');
    run(`UPDATE items SET title=?,sort_title=?,year=?,overview=?,rating=?,tmdb_id=?,poster=MAX(poster,?),backdrop=MAX(backdrop,?),meta_done=1,original_title=?,released=COALESCE(?,released) WHERE id=?`,
      d.name || item.title, sortTitle(d.name || item.title), parseInt(d.first_air_date) || item.year,
      d.overview || null, d.vote_average || null, id, poster, backdrop, originalOf(d.original_name, d.name || item.title), dateOf(d.first_air_date), item.id);
    saveExtras(item, d);
    localMeta.reapplyNfo(item.id);
    remapAbsolute(item, d.seasons || []);
    await matchEpisodes(item, id, d.seasons || []);
    return true;
  }
  return false;
}

// TMDB "Avsnitt 12" / "Episode 12" = ingen riktig titel (översättning saknas)
const placeholder = (name) => !name || /^(avsnitt|episode|afsnit|episodi|folge|épisode)\s*\d+$/i.test(name.trim());
/** Avsnitt → TMDB: först på säsong/avsnittsnummer, sedan på titel för avsnitt utan nummer i filnamnet
 *  (eller med ett nummer som TMDB inte har). Titeln jämförs mot alla säsonger, även specialavsnitt. */
async function matchEpisodes(item, id, tmdbSeasons) {
  const local = all('SELECT id, season, episode, title, thumb, ep_guess, released FROM items WHERE parent_id=?', item.id);
  const cache = new Map();
  const season = async (sn) => {
    if (!cache.has(sn)) { let sd = null; try { sd = await tmdb(`/tv/${id}/season/${sn}`); } catch {} cache.set(sn, sd?.episodes || []); }
    return cache.get(sn);
  };
  const apply = async (e, ep) => {
    const still = e.thumb ? 0 : await image(ep.still_path, 'w300', e.id, 'thumb');
    const name = placeholder(ep.name) ? null : ep.name;
    run(`UPDATE items SET title=COALESCE(?,title),sort_title=COALESCE(?,sort_title),overview=?,rating=?,thumb=MAX(thumb,?),meta_done=1 WHERE id=?`,
      name, name ? sortTitle(name) : null, ep.overview || null, ep.vote_average || null, still, e.id);
    localMeta.reapplyNfo(e.id);
  };
  const done = new Set();
  for (const sn of new Set(local.filter(e => !e.ep_guess).map(e => e.season))) {
    for (const ep of await season(sn)) {
      const e = local.find(x => !x.ep_guess && x.season === sn && x.episode === ep.episode_number);
      if (e) { await apply(e, ep); done.add(e.id); }
    }
  }
  // Datumavsnitt utan nummer: TMDB-avsnittet med samma sändningsdatum (säsongerna som sändes det året)
  const dated = local.filter(e => !done.has(e.id) && e.ep_guess && e.released);
  if (dated.length) {
    const byDate = new Map(), taken0 = new Set(local.filter(e => !e.ep_guess).map(e => e.season + ':' + e.episode));
    const years = new Set(dated.map(e => e.released.slice(0, 4)));
    for (const s of tmdbSeasons) {
      const y = String(s.air_date || '').slice(0, 4);
      if (s.season_number > 0 && (!y || [...years].some(x => Math.abs(+x - +y) <= 1))) for (const ep of await season(s.season_number)) if (ep.air_date) byDate.set(ep.air_date, { ...ep, season: s.season_number });
    }
    for (const e of dated) {
      const ep = byDate.get(e.released), k = ep && ep.season + ':' + ep.episode_number;
      if (!ep || taken0.has(k)) continue;
      taken0.add(k); done.add(e.id);
      run('UPDATE items SET season=?, episode=?, abs_episode=NULL, ep_guess=2 WHERE id=?', ep.season, ep.episode_number, e.id);
      await apply(e, ep);
    }
  }
  const rest = local.filter(e => !done.has(e.id) && e.title && !/^Avsnitt \d+$/.test(e.title));
  if (!rest.length) return;
  const cand = [];
  for (const s of tmdbSeasons) for (const ep of await season(s.season_number)) if (!placeholder(ep.name)) cand.push({ ...ep, season: s.season_number });
  // Platser som redan har en fil (utom de som matchas nu) får inte ges bort
  const taken = new Set(local.filter(e => !rest.includes(e)).map(e => e.season + ':' + e.episode));
  const picks = [];
  for (const e of rest) {
    let best = null, bs = 0;
    for (const ep of cand) { const sc = similarity(e.title, ep.name); if (sc > bs) { bs = sc; best = ep; } }
    if (best && bs >= GOOD) picks.push({ e, ep: best, score: bs });
  }
  // Säkraste träffarna först; två filer kan inte bli samma avsnitt
  picks.sort((a, b) => b.score - a.score);
  for (const { e, ep } of picks) {
    const k = ep.season + ':' + ep.episode_number;
    if (taken.has(k)) continue;
    taken.add(k);
    run('UPDATE items SET season=?, episode=?, abs_episode=NULL, ep_guess=CASE WHEN ep_guess=0 THEN 0 ELSE 2 END WHERE id=?', ep.season, ep.episode_number, e.id);
    await apply(e, ep);
  }
}

// Rollista och YouTube-trailer ur samma TMDB-svar (fel här ska inte stoppa resten av metadatan)
function saveTrailerKey(item, d) { run('UPDATE items SET trailer_yt=? WHERE id=?', pickYoutube(d.videos), item.id); }
function saveExtras(item, d) {
  try { people.saveCredits(item.id, people.extractCredits(d, item.kind)); saveTrailerKey(item, d); }
  catch (e) { console.warn('[meta] rollista/trailer:', item.title, e.message); }
}

/** Anime: absolut avsnittsnummer → säsong/avsnitt enligt TMDB:s säsongsindelning */
export function mapAbsolute(n, seasons) {
  let cum = 0;
  for (const s of seasons.filter(s => s.season_number > 0).sort((a, b) => a.season_number - b.season_number)) {
    if (n <= cum + s.episode_count) return { season: s.season_number, episode: n - cum };
    cum += s.episode_count;
  }
  return null;
}
function remapAbsolute(show, seasons) {
  const lib = get('SELECT anime FROM libraries WHERE id=?', show.library_id);
  const s1 = seasons.find(s => s.season_number === 1)?.episode_count || 0;
  const eps = all('SELECT id, season, episode, abs_episode FROM items WHERE parent_id=?', show.id);
  tx(() => { for (const e of eps) {
    // Absolut numrerade filer, eller i anime-bibliotek "S01E30" när säsong 1 bara har 12 avsnitt
    const abs = e.abs_episode ?? (lib?.anime && e.season === 1 && e.episode > s1 ? e.episode : null);
    if (abs == null) continue;
    const m = mapAbsolute(abs, seasons);
    if (m && (m.season !== e.season || m.episode !== e.episode)) run('UPDATE items SET season=?, episode=?, abs_episode=? WHERE id=?', m.season, m.episode, abs, e.id);
  } });
}

// ---------- kapitel ----------
async function chapters(lib, st = status) {
  const todo = all(`SELECT id,path FROM items WHERE library_id=? AND kind IN('movie','episode') AND chapters IS NULL AND path IS NOT NULL`, lib.id);
  if (!todo.length) return;
  st.phase = 'Läser kapitel'; st.done = 0; st.total = todo.length;
  for (const it of todo) { st.done++; run('UPDATE items SET chapters=? WHERE id=?', JSON.stringify(await readChapters(it.path)), it.id); }
}
export async function readChapters(file) {
  try {
    const { stdout } = await pexec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-print_format', 'json', '-show_chapters', file], { timeout: 30000, maxBuffer: 4 << 20 });
    const ch = (JSON.parse(stdout).chapters || []).map((c, i) => ({ start: +(+c.start_time).toFixed(3), end: +(+c.end_time).toFixed(3), title: c.tags?.title || `Kapitel ${i + 1}` }));
    // Ignorera "kapitel" som bara är ett enda block över hela filen
    return ch.length > 1 ? ch.slice(0, 200) : [];
  } catch { return []; }
}

// ---------- automatiska undertexter (OpenSubtitles) ----------
const L3 = { sv: ['swe', 'sv'], en: ['eng', 'en'], no: ['nor', 'nob', 'no', 'nb'], da: ['dan', 'da'], fi: ['fin', 'fi'], de: ['ger', 'deu', 'de'], fr: ['fre', 'fra', 'fr'],
  es: ['spa', 'es'], it: ['ita', 'it'], nl: ['dut', 'nld', 'nl'], pl: ['pol', 'pl'], pt: ['por', 'pt'], ja: ['jpn', 'ja'], ko: ['kor', 'ko'], zh: ['chi', 'zho', 'zh'], ar: ['ara', 'ar'] };
export const langMatches = (code, want) => !!code && (L3[want] || [want]).includes(String(code).toLowerCase().split(/[-_]/)[0]);
export const autoSubs = { downloaded: 0, last: null, error: null };
async function autoSubtitles(lib, st = status) {
  if (getSetting('sub_auto', '0') !== '1' || !os.enabled() || !hooks.subtitlesOf) return;
  const langs = getSetting('sub_auto_langs', getSetting('sub_langs', 'sv,en')).split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
  const onlyHash = getSetting('sub_auto_hash', '1') === '1';
  const maxRun = Math.max(1, +getSetting('sub_auto_max', '10'));
  // Försök igen efter en vecka för titlar där inget hittades
  const todo = all(`SELECT * FROM items WHERE library_id=? AND kind IN('movie','episode') AND path IS NOT NULL AND sub_auto < ? ORDER BY added DESC LIMIT 200`, lib.id, now() - 7 * 86400);
  if (!todo.length) return;
  st.phase = 'Hämtar undertexter'; st.done = 0; st.total = todo.length;
  let n = 0;
  for (const it of todo) {
    st.done++;
    if (n >= maxRun) break;
    const have = hooks.subtitlesOf(it).filter(s => !s.forced && !s.bitmap);
    const missing = langs.filter(l => !have.some(s => langMatches(s.lang, l)));
    if (missing.length) {
      try {
        const res = await os.search(it, missing);
        for (const l of missing) {
          const best = res.find(r => langMatches(r.lang, l) && (r.hashMatch || !onlyHash) && !r.hi) || res.find(r => langMatches(r.lang, l) && (r.hashMatch || !onlyHash));
          if (best && n < maxRun) { await os.download(it, best.fileId, l); n++; autoSubs.downloaded++; console.log(`[subs] ${it.title}: ${l}${best.hashMatch ? ' (exakt)' : ''}`); }
        }
      } catch (e) {
        autoSubs.error = e.message;
        console.warn('[subs]', e.message);
        if (/quota|limit|406|429|allowed/i.test(e.message)) break; // dygnskvoten slut – fortsätt nästa skanning
        continue;
      }
    }
    run('UPDATE items SET sub_auto=? WHERE id=?', now(), it.id);
  }
  autoSubs.last = now();
}

async function metadata(lib) {
  // Hemvideor söks aldrig i TMDB
  if (!tmdbKey() || (lib.type === 'movie' && lib.home_video)) return;
  // Bättre matchning (match.js): titlar som tidigare inte hittades får ett nytt försök en gång
  // Matchning v3 (parse.js, findMatch: svenska/engelska/alternativa titlar, barn/tecknat, längd, säsonger): samma sak en gång till
  for (const v of ['match_v2', 'match_v3']) if (getSetting(v, '0') !== '1') {
    run('UPDATE items SET meta_done=0 WHERE meta_done=2 AND match_locked=0');
    setSetting(v, '1');
  }
  clearMatchCache();
  // Titlar som inte hittades försöker igen en gång i veckan (TMDB fylls på, och tolkningen av filnamn förbättras)
  if (Date.now() - +getSetting('meta_retry_at', '0') > 7 * 86400e3) {
    run('UPDATE items SET meta_done=0 WHERE meta_done=2 AND match_locked=0');
    setSetting('meta_retry_at', String(Date.now()));
  }
  // Versioner av en film delar huvudradens metadata och hämtas inte var för sig
  const todo = all(`SELECT * FROM items WHERE library_id=? AND kind IN('movie','show') AND meta_done=0 AND version_of IS NULL`, lib.id);
  status.phase = 'Hämtar metadata'; status.done = 0; status.total = todo.length;
  for (const it of todo) {
    status.done++;
    try { if (!(await refreshItem(it, it.match_locked ? it.tmdb_id : null))) run('UPDATE items SET meta_done=2 WHERE id=?', it.id); }
    catch (e) { console.warn('[meta]', it.title, e.message); }
  }
}

export async function extractThumb(it) {
  const at = Math.min(Math.max((it.duration || 60) * 0.15, 1), 600);
  const out = path.join(IMAGES, `${it.id}-thumb.jpg`);
  try {
    await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-ss', String(at), '-i', it.path,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out], { timeout: 60000 });
    if (fs.existsSync(out)) { run('UPDATE items SET thumb=1 WHERE id=?', it.id); colors.forget(it.id, ['thumb']); }
  } catch (e) { console.warn('[thumb]', it.path, e.message); }
}

async function thumbnails(lib, st = status) {
  const todo = all(`SELECT id,path,duration FROM items WHERE library_id=? AND kind IN('movie','episode') AND thumb=0 AND vcodec IS NOT NULL`, lib.id);
  st.phase = 'Skapar miniatyrer'; st.done = 0; st.total = todo.length;
  for (const it of todo) { st.done++; await extractThumb(it); }
  // Serier utan affisch: använd första avsnittets miniatyr
  for (const sh of all(`SELECT id FROM items WHERE library_id=? AND kind='show' AND poster=0 AND thumb=0`, lib.id)) {
    const ep = get(`SELECT id FROM items WHERE parent_id=? AND thumb=1 ORDER BY season, episode LIMIT 1`, sh.id);
    if (!ep) continue;
    try { fs.copyFileSync(path.join(IMAGES, `${ep.id}-thumb.jpg`), path.join(IMAGES, `${sh.id}-thumb.jpg`)); run('UPDATE items SET thumb=1 WHERE id=?', sh.id); colors.forget(sh.id, ['thumb']); } catch {}
  }
}

// ---- bakgrundsanalys (miniatyrer, kapitel, undertexter, nyckelbilder, intro, förhandsbilder) ----
export const analysis = { running: false, library: null, phase: '', done: 0, total: 0, queued: 0 };
status.analysis = analysis; // syns i /api/scan
const pendingAnalysis = new Map(); // bibliotekets id → väntande löften
let analysisRunning = false;
/** Köa analys av ett bibliotek. Löftet blir klart när biblioteket analyserats. */
export function requestAnalysis(libId) {
  return new Promise((res) => {
    const w = pendingAnalysis.get(libId) || [];
    w.push(res); pendingAnalysis.set(libId, w);
    analysis.queued = pendingAnalysis.size;
    runAnalysis();
  });
}
async function runAnalysis() {
  if (analysisRunning) return;
  analysisRunning = true; analysis.running = true;
  try {
    while (pendingAnalysis.size) {
      const [id, waiters] = pendingAnalysis.entries().next().value;
      pendingAnalysis.delete(id); analysis.queued = pendingAnalysis.size;
      const lib = get('SELECT * FROM libraries WHERE id=?', id);
      if (lib && (lib.type === 'movie' || lib.type === 'show')) {
        analysis.library = lib.name;
        try { await analyzeLibrary(lib, analysis); }
        catch (e) { console.error(`[analys] fel i ${lib.name}:`, e); scanWarning(`${lib.name}: analysen avbröts (${e.message})`); }
      }
      for (const r of waiters) r();
    }
  } finally {
    analysisRunning = false;
    Object.assign(analysis, { running: false, library: null, phase: '', done: 0, total: 0, queued: 0 });
  }
}

// ---- skanning (filer och metadata – snabbt, väntar aldrig på analysen) ----
let queue = Promise.resolve();
const queued = new Set(); // köade men ej påbörjade skanningar ('all' eller bibliotekets id)
export function scan(libId = null) {
  // Samma skanning köas bara en gång (t.ex. en webhook från Sonarr per avsnitt i ett säsongspaket)
  const key = libId ? String(libId) : 'all';
  if (queued.has(key) || queued.has('all')) return queue;
  queued.add(key); status.queued = queued.size;
  const analyses = [];
  queue = queue.then(async () => {
    queued.delete(key); status.queued = queued.size;
    const libs = libId ? all('SELECT * FROM libraries WHERE id=?', libId) : all('SELECT * FROM libraries');
    status.running = true; status.started = now(); status.warnings = []; status.scanned = libs.map(l => l.name);
    try {
      for (const l of libs) {
        // Ett fel i ett bibliotek ska inte hoppa över resten
        try {
          if (l.type === 'music') { status.library = l.name; await hooks.music?.(l, status); }
          else if (l.type === 'audiobook') { status.library = l.name; await hooks.audiobooks?.(l, status); }
          else { await scanLibrary(l); analyses.push(requestAnalysis(l.id)); }
        } catch (e) { console.error(`[scan] fel i ${l.name}:`, e); scanWarning(`${l.name}: skanningen avbröts (${e.message})`); }
      }
    }
    finally { status.running = false; status.phase = ''; status.library = null; status.last = now(); try { hooks.afterScan?.(); } catch {} }
  });
  // Nästa skanning köas bara efter själva skanningen; den som väntar på anropet får vänta tills även
  // analysen av de skannade biblioteken är klar (t.ex. testerna)
  return queue.then(() => Promise.all(analyses));
}
