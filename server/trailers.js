// Trailers: lokala trailerfiler (t.ex. "Film (2020)-trailer.mkv" bredvid filmen eller filer i undermappen
// trailers/) kopplas till titeln i stället för att bli egna filmer. YouTube-trailers från TMDB sparas som nyckel.
import fs from 'node:fs';
import path from 'node:path';
import { db, get, all, run, tx, now } from './db.js';
import { underFailed } from './util.js';

db.exec(`CREATE TABLE IF NOT EXISTS trailers(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE, path TEXT NOT NULL UNIQUE, size INTEGER, mtime INTEGER, added INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS trailers_item ON trailers(item_id);`);

const TRAILER_DIR = /^trailers?$/i;
// "Film (2020)-trailer", "Film (2020) - trailer", "Film.2020.trailer", "Film_trailer2" (avskiljare krävs)
const SUFFIX = /^(.*?)[\s._]*[-._][\s._]*trailer(?:[\s._-]*\d{1,2})?$/i;
const stem = (f) => path.basename(f, path.extname(f));

/** Är filen en trailer (ska inte bli en egen titel)? */
export const isTrailerFile = (file) => TRAILER_DIR.test(path.basename(path.dirname(file))) || SUFFIX.test(stem(file));
/** Mappen där titeln som trailern hör till ligger */
export const homeDir = (file) => { const d = path.dirname(file); return TRAILER_DIR.test(path.basename(d)) ? path.dirname(d) : d; };

/** Välj vilken film (bland filmerna i samma mapp, [{id, path}]) trailern hör till – null om det är oklart */
export function pickOwner(file, movies) {
  if (!movies.length) return null;
  const norm = (s) => s.toLowerCase().replace(/[\s._-]+/g, ' ').trim();
  const m = stem(file).match(SUFFIX);
  const nb = norm(m ? m[1] : stem(file));
  const names = movies.map(x => ({ id: x.id, n: norm(stem(x.path)) }));
  const exact = names.find(x => x.n === nb);
  if (exact) return exact.id;
  const pref = nb ? names.filter(x => nb.startsWith(x.n) || x.n.startsWith(nb)) : [];
  if (pref.length === 1) return pref[0].id;
  return movies.length === 1 ? movies[0].id : null;
}

/**
 * Spara bibliotekets trailers. files = trailerfiler som hittades, failed = mappar som inte gick att läsa.
 * Filmbibliotek: trailern hör till filmen i samma mapp. Seriebibliotek: showIdFor(seriemapp) ger serien.
 */
export async function syncTrailers(lib, files, failed = [], showIdFor = () => null) {
  const byDir = new Map();
  if (lib.type === 'movie') {
    for (const m of all(`SELECT COALESCE(version_of, id) AS id, path FROM items WHERE library_id=? AND kind='movie' AND path IS NOT NULL`, lib.id)) {
      const d = path.dirname(m.path);
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(m);
    }
  }
  const rows = [];
  for (const f of files) {
    let owner = null;
    if (lib.type === 'movie') owner = pickOwner(f, byDir.get(homeDir(f)) || []);
    else {
      const rel = path.relative(lib.path, f).split(path.sep);
      if (rel.length > 1) owner = showIdFor(rel[0]);
    }
    if (!owner) continue;
    let st; try { st = await fs.promises.stat(f); } catch { continue; }
    rows.push([owner, f, st.size, Math.floor(st.mtimeMs / 1000)]);
  }
  const keep = new Set(rows.map(r => r[1]));
  tx(() => {
    for (const r of all('SELECT id, path FROM trailers WHERE library_id=?', lib.id))
      if (!keep.has(r.path) && !underFailed(r.path, failed)) run('DELETE FROM trailers WHERE id=?', r.id);
    for (const [item, p, size, mtime] of rows)
      run(`INSERT INTO trailers(item_id,library_id,path,size,mtime,added) VALUES(?,?,?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET item_id=excluded.item_id, library_id=excluded.library_id, size=excluded.size, mtime=excluded.mtime`,
        item, lib.id, p, size, mtime, now());
  });
  return rows.length;
}

export const trailersOf = (itemId) => all('SELECT id, path, size FROM trailers WHERE item_id=? ORDER BY path', itemId)
  .map((t, i, a) => ({ id: t.id, name: a.length > 1 ? `Trailer ${i + 1}` : 'Trailer', size: t.size }));
export const trailerRow = (id) => get('SELECT * FROM trailers WHERE id=?', id);

/** Bästa YouTube-trailern ur TMDB:s videos-svar (officiell trailer före teaser) */
const YT = /^[A-Za-z0-9_-]{6,20}$/;
export function pickYoutube(videos) {
  const list = (videos?.results || []).filter(v => v.site === 'YouTube' && YT.test(String(v.key || '')) && ['Trailer', 'Teaser'].includes(v.type));
  const score = (v) => (v.type === 'Trailer' ? 4 : 0) + (v.official ? 2 : 0) + (v.iso_639_1 === 'sv' ? 1 : 0);
  return list.sort((a, b) => score(b) - score(a))[0]?.key || null;
}
export const youtubeOk = (k) => typeof k === 'string' && YT.test(k);
