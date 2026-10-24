// Bio-läge: trailers (och en egen förfilm, "pre-roll") före en film, som Cinema Trailers i Plex.
// Inställningen är per användare (users.cinema, JSON). Trailers väljs bland lokala trailers (trailers.js) för filmer
// i biblioteket som användaren inte har börjat på eller sett, helst i liknande genre och efter smakprofilen, och
// alltid inom profilens åldersgräns. Förfilmen väljer administratören: en fil eller en mapp att slumpa från under MEDIA_ROOT.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { get, all, run, getSetting } from './db.js';

export const MAX_TRAILERS = 3;
// Mediatoken för förfilmen gäller bara den filen (router.js: scope = PREROLL_SCOPE + filens nummer i listan)
export const PREROLL_SCOPE = 7.5e9;
const VIDEO = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov']);

/** Användarens val: trailers = 0 (av) … 3, preroll = spela administratörens förfilm sist */
export function getPrefs(uid) {
  let p = null;
  try { p = JSON.parse(get('SELECT cinema FROM users WHERE id=?', uid)?.cinema || 'null'); } catch {}
  const n = Math.max(0, Math.min(MAX_TRAILERS, parseInt(p?.trailers) || 0));
  return { trailers: n, preroll: !!p?.preroll };
}
export function setPrefs(uid, b = {}) {
  const cur = getPrefs(uid);
  const next = {
    trailers: b.trailers != null ? Math.max(0, Math.min(MAX_TRAILERS, parseInt(b.trailers) || 0)) : cur.trailers,
    preroll: b.preroll != null ? !!b.preroll : cur.preroll
  };
  run('UPDATE users SET cinema=? WHERE id=?', JSON.stringify(next), uid);
  return getPrefs(uid);
}
/** Är bio-läget påslaget alls (något att spela före filmen)? */
export const enabled = (p) => p.trailers > 0 || (p.preroll && !!prerollSetting());

// ---------- förfilm (administratörens val) ----------
export const prerollSetting = () => getSetting('cinema_preroll', '');
const parseList = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };
let listCache = { key: '', t: 0, files: [] };
/**
 * Filerna som förfilmen slumpas från: den valda filen, eller videofilerna direkt i den valda mappen (sorterade).
 * inside(p) ger den verkliga sökvägen om den ligger under MEDIA_ROOT (annars null) – symlänkar ut ur mappen räknas inte.
 */
export function prerollFiles(inside) {
  const p = prerollSetting();
  if (!p) return [];
  if (listCache.key === p && Date.now() - listCache.t < 60e3) return listCache.files;
  let files = [];
  const real = inside(p);
  try {
    const s = real && fs.statSync(real);
    if (s?.isFile()) files = VIDEO.has(path.extname(real).toLowerCase()) ? [real] : [];
    else if (s?.isDirectory()) files = fs.readdirSync(real).filter(f => !f.startsWith('.') && VIDEO.has(path.extname(f).toLowerCase()))
      .sort().map(f => inside(path.join(real, f))).filter(Boolean);
  } catch { files = []; }
  listCache = { key: p, t: Date.now(), files };
  return files;
}
export const forgetPreroll = () => { listCache = { key: '', t: 0, files: [] }; };
/** Kontroll när administratören sparar: tom sträng (av), en videofil eller en mapp med minst en videofil */
export function checkPreroll(p, inside) {
  if (!p) return null;
  const real = inside(p);
  if (!real) return 'Förfilmen måste finnas och ligga under mediamappen';
  const s = fs.statSync(real);
  if (s.isFile() && !VIDEO.has(path.extname(real).toLowerCase())) return 'Förfilmen måste vara en videofil (mp4, m4v, mkv, webm eller mov)';
  if (s.isDirectory() && !fs.readdirSync(real).some(f => VIDEO.has(path.extname(f).toLowerCase()))) return 'Mappen innehåller inga videofiler';
  return null;
}

// ---------- längd (ffprobe, cachas per fil och ändringstid) ----------
const durCache = new Map(); // sökväg -> { mtime, d }
export async function durationOf(file) {
  let st; try { st = await fs.promises.stat(file); } catch { return null; }
  const c = durCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.d;
  const d = await new Promise(ok => execFile('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { timeout: 5000 }, (e, out) => ok(e ? null : Math.round((parseFloat(out) || 0) * 10) / 10 || null)));
  durCache.set(file, { mtime: st.mtimeMs, d });
  if (durCache.size > 2000) durCache.delete(durCache.keys().next().value);
  return d;
}

// ---------- val av trailers ----------
const parseGenres = (g) => { try { const a = JSON.parse(g || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
/**
 * Poängsätt kandidaterna (rena data – testas för sig): genrelikhet med filmen väger tyngst, sedan smakprofilen
 * (genre -> vikt) och betyget, plus lite slump så att det inte blir samma trailers varje gång.
 * cands = [{ itemId, genres: [], rating }], returnerar itemId:n i vald ordning (högst n, en per film).
 */
export function rankTrailers(movieGenres, cands, taste = {}, n = 1, rand = Math.random) {
  const total = Object.values(taste).reduce((a, b) => a + b, 0) || 1;
  const g = new Set(movieGenres || []);
  const seen = new Set();
  return cands.filter(c => !seen.has(c.itemId) && seen.add(c.itemId)).map(c => {
    const shared = c.genres.filter(x => g.has(x)).length;
    const like = g.size || c.genres.length ? shared / Math.max(g.size, c.genres.length, 1) : 0;
    const t = c.genres.reduce((a, x) => a + (taste[x] || 0) / total, 0) / Math.sqrt(c.genres.length || 1);
    return { id: c.itemId, s: like * 2 + t + (c.rating || 6) / 40 + rand() * 0.6 };
  }).sort((a, b) => b.s - a.s).slice(0, n).map(x => x.id);
}
/**
 * Trailers att visa före filmen movie (huvudraden) för användaren uid: [{ tid, itemId, title, path }].
 * age = ageFilter(uid) från http/context.js (alias i = titeln, s = ev. serie), taste = smakprofilen.
 * Bara filmer som användaren inte börjat på eller sett och som inte är samma film (eller en version av den).
 */
export function pickTrailers(uid, movie, n, { age = { sql: '', params: [] }, taste = {}, rand = Math.random } = {}) {
  if (!(n > 0)) return [];
  const rows = all(`SELECT t.id AS tid, t.path, i.id AS item_id, i.title, i.genres, i.rating FROM trailers t JOIN items i ON i.id=t.item_id
    LEFT JOIN items s ON s.id=i.parent_id
    WHERE i.kind='movie' AND i.version_of IS NULL AND i.id != ?${age.sql}
      AND NOT EXISTS (SELECT 1 FROM progress p WHERE p.user_id=? AND p.item_id=i.id AND (p.watched=1 OR p.position > 0))
    ORDER BY t.id LIMIT 3000`, movie.id, ...age.params, uid);
  const byItem = new Map();
  for (const r of rows) { if (!byItem.has(r.item_id)) byItem.set(r.item_id, []); byItem.get(r.item_id).push(r); }
  const cands = [...byItem.values()].map(l => ({ itemId: l[0].item_id, genres: parseGenres(l[0].genres), rating: l[0].rating }));
  return rankTrailers(parseGenres(movie.genres), cands, taste, n, rand).map(id => {
    const l = byItem.get(id), t = l[Math.floor(rand() * l.length) % l.length];
    return { tid: t.tid, itemId: id, title: t.title, path: t.path };
  });
}
/** Förfilmen att spela (slumpad ur listan): { n, path } eller null */
export function pickPreroll(inside, rand = Math.random) {
  const files = prerollFiles(inside);
  if (!files.length) return null;
  const n = Math.floor(rand() * files.length) % files.length;
  return { n, path: files[n] };
}
