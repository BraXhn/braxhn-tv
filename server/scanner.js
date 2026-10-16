import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, get, all, run, tx, now, getSetting, IMAGES } from './db.js';
import { listFiles, deletionBlocked, underFailed } from './util.js';
import * as os from './opensubtitles.js';

const pexec = promisify(execFile);
const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm', '.ts', '.m2ts',
  '.wmv', '.mpg', '.mpeg', '.flv', '.ogv']);
const JUNK = /\b(2160p|1080p|720p|576p|480p|4k|uhd|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdtv|dvdrip|dvd|x264|x265|h\.?264|h\.?265|hevc|aac|ac3|eac3|dts|remux|proper|repack|extended|unrated|hdr|10bit|multi|swesub|nordic)\b.*$/i;

export const status = { running: false, library: null, phase: '', done: 0, total: 0, last: null, warnings: [] };
/** Varning från skanningen (t.ex. omonterad NAS) – syns i skanningsstatus och loggen */
export function scanWarning(msg) { console.warn('[scan]', msg); status.warnings.push(msg); if (status.warnings.length > 20) status.warnings.shift(); }

const clean = (s) => s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').replace(/[\s\-–\[(]+$/, '').trim();
const sortTitle = (t) => t.toLowerCase().replace(/^(the|a|an|en|ett|den|det)\s+/, '');

export function parseMovie(file) {
  const tryName = (name) => {
    const m = name.match(/^(.*)[\s._(\[-]+((?:19|20)\d\d)(?=[\s._)\]-]|$)/); // sista årtalet (t.ex. Blade Runner 2049 (2017))
    return m && clean(m[1]) ? { title: clean(m[1]), year: +m[2] } : null;
  };
  const base = path.basename(file, path.extname(file));
  const folder = path.basename(path.dirname(file));
  return tryName(base) || tryName(folder) || { title: clean(base.replace(JUNK, '')) || base, year: null };
}

export function parseEpisode(rel) {
  const parts = rel.split(path.sep);
  // Fansub-grupper och hash-taggar i hakparenteser, t.ex. "[SubsPlease] Show - 12 (1080p) [ABCD1234]"
  const base = path.basename(rel, path.extname(rel)).replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s*\[[0-9A-F]{8}\]\s*$/i, '');
  const sf = parts.slice(0, -1).find(p => /^(season|säsong|s)[\s._-]*\d+$/i.test(p));
  let m = base.match(/[sS](\d{1,2})[ ._-]*[eE](\d{1,4})/) || base.match(/\b(\d{1,2})x(\d{2,3})\b/);
  let season, episode, before = base, absolute = false;
  if (m) { season = +m[1]; episode = +m[2]; before = base.slice(0, m.index); }
  else {
    // Anime: "Show - 1071" eller "Show - 12v2" (absolut numrering om ingen säsongsmapp finns)
    const a = base.match(/^(.*?)[\s._]+-[\s._]+(\d{1,4})(?:v\d)?(?=$|[\s._\[(])/);
    const e = a ? null : base.match(/(?:^|[\s._-])(?:e|ep|episode|avsnitt|del)[\s._-]*(\d{1,4})/i);
    if (!a && !e) return null;
    if (a) { episode = +a[2]; before = a[1]; m = { index: a[1].length, 0: base.slice(a[1].length, a.index + a[0].length) }; }
    else { episode = +e[1]; before = base.slice(0, e.index); }
    season = sf ? +sf.match(/\d+/)[0] : 1;
    absolute = !sf;
  }
  const show = parts.length > 1 ? parts[0] : clean(before);
  if (!show) return null;
  const y = show.match(/^(.*?)[\s._(\[-]+((?:19|20)\d\d)[)\]]?$/);
  const after = m ? clean(base.slice(m.index + m[0].length).replace(JUNK, '')).replace(/^[-–\s]+/, '') : '';
  return { show: y ? clean(y[1]) : clean(show), year: y ? +y[2] : null, season, episode, epTitle: after || null, absolute };
}

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
      pix: s.pix_fmt || null, transfer: s.color_transfer || null, primaries: s.color_primaries || null,
      dovi: !!(s.side_data_list || []).find(d => /dovi|dolby vision/i.test(d.side_data_type || '')),
      dvProfile: (s.side_data_list || []).find(d => /dovi|dolby vision/i.test(d.side_data_type || ''))?.dv_profile ?? null
    })).filter(s => ['video', 'audio', 'subtitle'].includes(s.type) && !(s.type === 'video' && ['mjpeg', 'png'].includes(s.codec)));
    const v = streams.find(s => s.type === 'video'), a = streams.find(s => s.type === 'audio');
    const hdr = !v ? null : v.transfer === 'smpte2084' ? (v.dovi ? 'dovi' : 'hdr10') : v.transfer === 'arib-std-b67' ? 'hlg' : v.dovi ? 'dovi' : null;
    return { hdr,
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
function showFor(lib, name, year) {
  const key = showKey(name, year);
  const r = get(`SELECT id FROM items WHERE library_id=? AND kind='show' AND src_name=? COLLATE NOCASE`, lib.id, key);
  if (r) return r.id;
  // Tidigare versioner sparade namnet utan årtal: ta över en sådan serie om årtalet inte talar emot
  const old = year && get(`SELECT id FROM items WHERE library_id=? AND kind='show' AND src_name=? COLLATE NOCASE AND (year IS NULL OR year=?)`, lib.id, name, year);
  if (old) { run('UPDATE items SET src_name=? WHERE id=?', key, old.id); return old.id; }
  const t = get(`SELECT id FROM items WHERE library_id=? AND kind='show' AND src_name IS NULL AND title=? COLLATE NOCASE`, lib.id, name);
  if (t) { run('UPDATE items SET src_name=? WHERE id=?', key, t.id); return t.id; }
  return Number(run(`INSERT INTO items(library_id,kind,title,sort_title,year,src_name,added) VALUES(?,?,?,?,?,?,?)`,
    lib.id, 'show', name, sortTitle(name), year, key, now()).lastInsertRowid);
}
/** Flytta avsnitt som ligger under fel serie (t.ex. två serier med samma namn men olika år som slogs ihop
 *  av tidigare versioner). Bara strängjämförelser – inga filer läses. */
function regroupShows(lib) {
  const keyOf = new Map(all(`SELECT id, src_name FROM items WHERE library_id=? AND kind='show'`, lib.id).map(r => [r.id, String(r.src_name || '').toLowerCase()]));
  const eps = all(`SELECT id, path, parent_id FROM items WHERE library_id=? AND kind='episode' AND path IS NOT NULL`, lib.id);
  const touched = new Set(), years = new Map();
  tx(() => {
    for (const e of eps) {
      const p = parseEpisode(path.relative(lib.path, e.path));
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
      const p = r.ep && parseEpisode(path.relative(lib.path, r.ep));
      if (p?.show) run('UPDATE items SET src_name=? WHERE id=?', showKey(p.show, p.year), r.id);
    }
  });
}

async function scanLibrary(lib) {
  status.library = lib.name; status.phase = 'Söker filer'; status.done = 0;
  const { files, rootOk, failed } = await listFiles(lib.path, isVideo, (n) => SKIP_DIR.test(n));
  if (!rootOk) {
    // Mappen saknas/går inte att läsa: rör ingenting (annars töms biblioteket när en NAS inte är monterad)
    scanWarning(deletionBlocked({ name: lib.name, rootOk }));
    return;
  }
  for (const d of failed) scanWarning(`${lib.name}: kunde inte läsa ${d} – filer där behålls`);
  status.total = files.length;
  const known = new Map(all(`SELECT id,path,size,mtime FROM items WHERE library_id=? AND path IS NOT NULL`, lib.id).map(r => [r.path, r]));
  if (lib.type === 'show') { backfillSrcNames(lib); regroupShows(lib); }
  const seen = new Set();
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
      if (k && k.size === st.size && k.mtime === mtime) continue;
      const info = await probe(f);
      // Misslyckad probe (t.ex. disken vaknade för långsamt): spara mtime 0 så att filen läses om vid nästa skanning
      const saveMtime = info.failed ? 0 : mtime;
      if (lib.type === 'movie') {
        const p = parseMovie(f);
        pending.push(() => {
          if (k) run(`UPDATE items SET size=?,mtime=?,duration=?,container=?,vcodec=?,acodec=?,width=?,height=?,streams=?,thumb=0,trickplay=0 WHERE id=?`,
            st.size, saveMtime, info.duration, info.container, info.vcodec, info.acodec, info.width, info.height, info.streams, k.id);
          else run(`INSERT INTO items(library_id,kind,title,sort_title,year,path,size,mtime,duration,container,vcodec,acodec,width,height,streams,added)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, lib.id, 'movie', p.title, sortTitle(p.title), p.year, f, st.size, saveMtime,
            info.duration, info.container, info.vcodec, info.acodec, info.width, info.height, info.streams, now());
          run('UPDATE items SET hdr=? WHERE path=?', info.hdr, f);
        });
      } else {
        const p = parseEpisode(path.relative(lib.path, f));
        if (!p) { console.warn('[scan] kunde inte tolka avsnitt:', f); continue; }
        const showId = showFor(lib, p.show, p.year);
        const title = p.epTitle || `Avsnitt ${p.episode}`;
        pending.push(() => {
          if (k) run(`UPDATE items SET parent_id=?,season=?,episode=?,abs_episode=?,size=?,mtime=?,duration=?,container=?,vcodec=?,acodec=?,width=?,height=?,streams=?,thumb=0,trickplay=0 WHERE id=?`,
            showId, p.season, p.episode, p.absolute ? p.episode : null, st.size, saveMtime, info.duration, info.container, info.vcodec, info.acodec, info.width, info.height, info.streams, k.id);
          else run(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,season,episode,abs_episode,path,size,mtime,duration,container,vcodec,acodec,width,height,streams,added)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, lib.id, 'episode', showId, title, sortTitle(title), p.season, p.episode, p.absolute ? p.episode : null, f,
            st.size, saveMtime, info.duration, info.container, info.vcodec, info.acodec, info.width, info.height, info.streams, now());
          // Hämta om seriens metadata så att nya avsnitt får namn (och absolut numrering mappas till säsonger)
          run(`UPDATE items SET added=?, meta_done=CASE WHEN meta_done=1 THEN 0 ELSE meta_done END WHERE id=?`, now(), showId);
          run('UPDATE items SET hdr=?, markers_done=0 WHERE path=?', info.hdr, f);
        });
      }
    }
  } finally { flush(); }
  // Ta bort försvunna filer och tomma serier – men aldrig om det ser ut som att disken saknas
  const missing = [...known.values()].filter(r => !seen.has(r.path) && !underFailed(r.path, failed));
  const blocked = deletionBlocked({ name: lib.name, rootOk, files: files.length, known: known.size, missing: missing.length,
    allowMass: getSetting('scan_allow_mass_delete', '0') === '1' });
  if (blocked) scanWarning(blocked);
  else if (missing.length) {
    tx(() => {
      for (const r of missing) run('DELETE FROM items WHERE id=?', r.id);
      for (const s of all(`SELECT id FROM items WHERE library_id=? AND kind='show' AND NOT EXISTS(SELECT 1 FROM items e WHERE e.parent_id=items.id)`, lib.id)) {
        run('DELETE FROM items WHERE id=?', s.id); missing.push(s);
      }
    });
    for (const r of missing) removeImages(r.id);
  }
  await metadata(lib);
  await thumbnails(lib);
  await chapters(lib);
  await autoSubtitles(lib);
  status.phase = 'Indexerar nyckelbilder (för remux)';
  const kf = all(`SELECT id, path, mtime, vcodec, duration FROM items WHERE library_id=? AND vcodec IN ('h264','hevc') AND path IS NOT NULL`, lib.id);
  status.done = 0; status.total = kf.length;
  for (const it of kf) { status.done++; await hooks.keyframes?.(it); if (status.done % 200 === 0) await new Promise(setImmediate); }
  if (lib.type === 'show' && hooks.markers) { status.phase = 'Letar intro och eftertexter'; await hooks.markers(lib, status); }
  if (hooks.trickplay) await hooks.trickplay(lib, status);
}
// Kopplas in från stream.js / intro.js för att undvika cirkulära importer
export const hooks = {};

export function removeImages(id) {
  for (const t of ['poster', 'backdrop', 'thumb']) fs.rm(path.join(IMAGES, `${id}-${t}.jpg`), { force: true }, () => {});
}

// ---------- Metadata via TMDB (valfritt, egen gratis API-nyckel) ----------
function tmdbKey() { return getSetting('tmdb_key') || process.env.TMDB_API_KEY || ''; }
export async function tmdb(p, params = {}, attempt = 0) {
  const key = tmdbKey();
  const q = new URLSearchParams({ language: getSetting('language', 'sv-SE'), ...params });
  const headers = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = 'Bearer ' + key; else q.set('api_key', key);
  const r = await fetch(`https://api.themoviedb.org/3${p}?${q}`, { headers, signal: AbortSignal.timeout(15000) });
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
  try {
    const r = await fetch(`https://image.tmdb.org/t/p/${size}${tmdbPath}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return 0;
    fs.writeFileSync(path.join(IMAGES, `${id}-${type}.jpg`), Buffer.from(await r.arrayBuffer()));
    return 1;
  } catch { return 0; }
}

// Åldersgräns: svensk klassning i första hand, annars amerikansk
const AGE = { SE: { 'Btl': 0, 'BTL': 0, '7': 7, '11': 11, '15': 15 }, US: { 'G': 0, 'PG': 7, 'PG-13': 13, 'R': 17, 'NC-17': 18,
  'TV-Y': 0, 'TV-Y7': 7, 'TV-G': 0, 'TV-PG': 10, 'TV-14': 14, 'TV-MA': 17 }, DE: { '0': 0, '6': 6, '12': 12, '16': 16, '18': 18 } };
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

/** Sök i TMDB för manuell matchning */
export async function tmdbSearch(kind, query, year) {
  const tv = kind === 'show';
  const s = await tmdb(tv ? '/search/tv' : '/search/movie', { query, ...(year ? (tv ? { first_air_date_year: year } : { year }) : {}) });
  return (s.results || []).slice(0, 12).map(r => ({ id: r.id, title: r.title || r.name, original: r.original_title || r.original_name,
    year: parseInt(r.release_date || r.first_air_date) || null, overview: (r.overview || '').slice(0, 300),
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w154${r.poster_path}` : null }));
}

export async function refreshItem(item, tmdbId = null) {
  if (item.kind === 'movie') {
    let id = tmdbId;
    if (!id) {
      const s = await tmdb('/search/movie', { query: item.title, ...(item.year ? { year: item.year } : {}) });
      id = s.results?.[0]?.id;
    }
    if (!id) return false;
    const d = await tmdb(`/movie/${id}`, { append_to_response: 'release_dates' });
    const poster = await image(d.poster_path, 'w500', item.id, 'poster');
    const backdrop = await image(d.backdrop_path, 'w1280', item.id, 'backdrop');
    const certs = (d.release_dates?.results || []).map(r => ({ iso_3166_1: r.iso_3166_1, cert: (r.release_dates || []).map(x => x.certification).find(Boolean) }));
    const { cert, age } = pickCert(certs);
    const coll = await saveCollection(d.belongs_to_collection).catch(() => null);
    run(`UPDATE items SET title=?,sort_title=?,year=?,overview=?,rating=?,tmdb_id=?,poster=MAX(poster,?),backdrop=MAX(backdrop,?),meta_done=1,
      genres=?, cert=COALESCE(?,cert), age=COALESCE(?,age), collection_id=? WHERE id=?`,
      d.title || item.title, sortTitle(d.title || item.title), parseInt(d.release_date) || item.year,
      d.overview || null, d.vote_average || null, id, poster, backdrop,
      JSON.stringify((d.genres || []).map(g => g.name)), cert, age, coll, item.id);
    return true;
  }
  if (item.kind === 'show') {
    let id = tmdbId;
    if (!id) {
      const s = await tmdb('/search/tv', { query: item.title, ...(item.year ? { first_air_date_year: item.year } : {}) });
      id = s.results?.[0]?.id;
    }
    if (!id) return false;
    const d = await tmdb(`/tv/${id}`, { append_to_response: 'content_ratings' });
    const { cert, age } = pickCert((d.content_ratings?.results || []).map(r => ({ iso_3166_1: r.iso_3166_1, cert: r.rating })));
    run('UPDATE items SET genres=?, cert=COALESCE(?,cert), age=COALESCE(?,age) WHERE id=?', JSON.stringify((d.genres || []).map(g => g.name)), cert, age, item.id);
    const poster = await image(d.poster_path, 'w500', item.id, 'poster');
    const backdrop = await image(d.backdrop_path, 'w1280', item.id, 'backdrop');
    run(`UPDATE items SET title=?,sort_title=?,year=?,overview=?,rating=?,tmdb_id=?,poster=MAX(poster,?),backdrop=MAX(backdrop,?),meta_done=1 WHERE id=?`,
      d.name || item.title, sortTitle(d.name || item.title), parseInt(d.first_air_date) || item.year,
      d.overview || null, d.vote_average || null, id, poster, backdrop, item.id);
    remapAbsolute(item, d.seasons || []);
    const seasons = all(`SELECT DISTINCT season FROM items WHERE parent_id=?`, item.id).map(r => r.season);
    for (const sn of seasons) {
      let sd; try { sd = await tmdb(`/tv/${id}/season/${sn}`); } catch { continue; }
      for (const ep of sd.episodes || []) {
        const e = get(`SELECT id,thumb FROM items WHERE parent_id=? AND season=? AND episode=?`, item.id, sn, ep.episode_number);
        if (!e) continue;
        const still = e.thumb ? 0 : await image(ep.still_path, 'w300', e.id, 'thumb');
        run(`UPDATE items SET title=COALESCE(?,title),sort_title=COALESCE(?,sort_title),overview=?,rating=?,thumb=MAX(thumb,?),meta_done=1 WHERE id=?`,
          ep.name || null, ep.name ? sortTitle(ep.name) : null, ep.overview || null, ep.vote_average || null, still, e.id);
      }
    }
    return true;
  }
  return false;
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
async function chapters(lib) {
  const todo = all(`SELECT id,path FROM items WHERE library_id=? AND kind IN('movie','episode') AND chapters IS NULL AND path IS NOT NULL`, lib.id);
  if (!todo.length) return;
  status.phase = 'Läser kapitel'; status.done = 0; status.total = todo.length;
  for (const it of todo) { status.done++; run('UPDATE items SET chapters=? WHERE id=?', JSON.stringify(await readChapters(it.path)), it.id); }
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
async function autoSubtitles(lib) {
  if (getSetting('sub_auto', '0') !== '1' || !os.enabled() || !hooks.subtitlesOf) return;
  const langs = getSetting('sub_auto_langs', getSetting('sub_langs', 'sv,en')).split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
  const onlyHash = getSetting('sub_auto_hash', '1') === '1';
  const maxRun = Math.max(1, +getSetting('sub_auto_max', '10'));
  // Försök igen efter en vecka för titlar där inget hittades
  const todo = all(`SELECT * FROM items WHERE library_id=? AND kind IN('movie','episode') AND path IS NOT NULL AND sub_auto < ? ORDER BY added DESC LIMIT 200`, lib.id, now() - 7 * 86400);
  if (!todo.length) return;
  status.phase = 'Hämtar undertexter'; status.done = 0; status.total = todo.length;
  let n = 0;
  for (const it of todo) {
    status.done++;
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
  if (!tmdbKey()) return;
  const todo = all(`SELECT * FROM items WHERE library_id=? AND kind IN('movie','show') AND meta_done=0`, lib.id);
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
    if (fs.existsSync(out)) run('UPDATE items SET thumb=1 WHERE id=?', it.id);
  } catch (e) { console.warn('[thumb]', it.path, e.message); }
}

async function thumbnails(lib) {
  const todo = all(`SELECT id,path,duration FROM items WHERE library_id=? AND kind IN('movie','episode') AND thumb=0 AND vcodec IS NOT NULL`, lib.id);
  status.phase = 'Skapar miniatyrer'; status.done = 0; status.total = todo.length;
  for (const it of todo) { status.done++; await extractThumb(it); }
  // Serier utan affisch: använd första avsnittets miniatyr
  for (const sh of all(`SELECT id FROM items WHERE library_id=? AND kind='show' AND poster=0 AND thumb=0`, lib.id)) {
    const ep = get(`SELECT id FROM items WHERE parent_id=? AND thumb=1 ORDER BY season, episode LIMIT 1`, sh.id);
    if (!ep) continue;
    try { fs.copyFileSync(path.join(IMAGES, `${ep.id}-thumb.jpg`), path.join(IMAGES, `${sh.id}-thumb.jpg`)); run('UPDATE items SET thumb=1 WHERE id=?', sh.id); } catch {}
  }
}

let queue = Promise.resolve();
const queued = new Set(); // köade men ej påbörjade skanningar ('all' eller bibliotekets id)
export function scan(libId = null) {
  // Samma skanning köas bara en gång (t.ex. en webhook från Sonarr per avsnitt i ett säsongspaket)
  const key = libId ? String(libId) : 'all';
  if (queued.has(key) || queued.has('all')) return queue;
  queued.add(key);
  queue = queue.then(async () => {
    queued.delete(key);
    const libs = libId ? all('SELECT * FROM libraries WHERE id=?', libId) : all('SELECT * FROM libraries');
    status.running = true; status.started = now(); status.warnings = [];
    try {
      for (const l of libs) {
        // Ett fel i ett bibliotek ska inte hoppa över resten
        try {
          if (l.type === 'music') { status.library = l.name; await hooks.music?.(l, status); }
          else if (l.type === 'audiobook') { status.library = l.name; await hooks.audiobooks?.(l, status); }
          else await scanLibrary(l);
        } catch (e) { console.error(`[scan] fel i ${l.name}:`, e); scanWarning(`${l.name}: skanningen avbröts (${e.message})`); }
      }
    }
    finally { status.running = false; status.phase = ''; status.library = null; status.last = now(); try { hooks.afterScan?.(); } catch {} }
  });
  return queue;
}
