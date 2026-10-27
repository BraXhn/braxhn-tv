// Xtream Codes API (player_api.php): live-kanaler med kategorier och arkiv (catch-up), filmer och serier med metadata,
// TV-guide via xmltv.php. Inloggningen (användare/lösenord) ligger i iptv_sources och lämnas aldrig ut i API-svar;
// adresserna som innehåller den (strömmar, guide) visas maskerade (net.js maskUrl/redact).
import { all, get, run, tx } from '../db.js';
import { readText, policyOf } from './net.js';
import { clip, isAdultName } from './m3u.js';

/** Serverns bas-adress som administratören angav: http:// läggs till, avslutande / och player_api.php tas bort */
export function xtBase(server) {
  let s = String(server || '').trim();
  if (!s) throw new Error('Ange serverns adress');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  u.pathname = u.pathname.replace(/\/(player_api|get|xmltv|panel_api)\.php$/i, '').replace(/\/+$/, '');
  u.search = ''; u.hash = '';
  return u.toString().replace(/\/+$/, '');
}
const enc = encodeURIComponent;
const MAX_JSON = 96 << 20;

/** src: { base, user, pass, headers, lan } */
export async function api(src, action = null, params = {}) {
  const q = new URLSearchParams({ username: src.user, password: src.pass, ...(action ? { action } : {}), ...params });
  const text = await readText(`${src.base}/player_api.php?${q}`, { pol: policyOf([src.base], src.lan), headers: src.headers, max: MAX_JSON, timeout: 45000, total: 240000 })
    .catch(e => { throw new Error(String(e.message).replace(src.pass, '•••')); });
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('Xtream-servern svarade inte med JSON – kontrollera adressen'); }
  return d;
}

/** Inloggningen och kontots läge (giltigt till, samtidiga anslutningar, tidszon) */
export async function account(src) {
  const d = await api(src);
  const ui = d?.user_info;
  if (!ui || (ui.auth != null && +ui.auth === 0)) throw new Error('Inloggningen till Xtream-servern misslyckades – kontrollera användarnamn och lösenord');
  const status = String(ui.status || 'Active');
  if (!/^active$/i.test(status)) throw new Error(`Kontot hos leverantören är ${status === 'Expired' ? 'utgånget' : status === 'Banned' ? 'spärrat' : status === 'Disabled' ? 'avstängt' : status}`);
  const formats = Array.isArray(ui.allowed_output_formats) ? ui.allowed_output_formats.map(String) : [];
  return { status, exp: +ui.exp_date || null, maxConnections: +ui.max_connections || null, activeCons: +ui.active_cons || 0, trial: String(ui.is_trial) === '1',
    tz: typeof d.server_info?.timezone === 'string' ? d.server_info.timezone.slice(0, 60) : null, formats: formats.slice(0, 5), message: clip(ui.message || '', 200) || null };
}

const arr = (x) => Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : [];
const catMap = (cats) => new Map(arr(cats).map(c => [String(c.category_id), clip(c.category_name, 120) || 'Övrigt']));
const httpUrl = (u) => /^https?:\/\//i.test(String(u || '')) ? clip(u, 2000) : null;

export const liveUrl = (src, id, fmt = 'ts') => `${src.base}/live/${enc(src.user)}/${enc(src.pass)}/${id}.${fmt}`;
export const movieUrl = (src, id, ext) => `${src.base}/movie/${enc(src.user)}/${enc(src.pass)}/${id}.${/^\w{1,5}$/.test(ext || '') ? ext : 'mp4'}`;
export const episodeUrl = (src, id, ext) => `${src.base}/series/${enc(src.user)}/${enc(src.pass)}/${id}.${/^\w{1,5}$/.test(ext || '') ? ext : 'mp4'}`;
export const xmltvUrl = (src) => `${src.base}/xmltv.php?username=${enc(src.user)}&password=${enc(src.pass)}`;

/** Live-kanalerna i samma form som M3U-tolken (m3u.js) ger */
export async function liveEntries(src, acct = null) {
  const [cats, streams] = await Promise.all([api(src, 'get_live_categories'), api(src, 'get_live_streams')]);
  const cm = catMap(cats);
  const fmt = acct?.formats?.length && !acct.formats.includes('ts') && acct.formats.includes('m3u8') ? 'm3u8' : 'ts';
  const out = [];
  for (const s of arr(streams).slice(0, 50000)) {
    const id = parseInt(s.stream_id, 10);
    if (!Number.isFinite(id) || id < 0) continue;
    const group = cm.get(String(s.category_id)) || null;
    const name = clip(s.name, 120) || 'Kanal';
    out.push({ name, url: liveUrl(src, id, fmt), epg: clip(s.epg_channel_id || '', 200) || null, logo: httpUrl(s.stream_icon), group,
      number: s.num != null && s.num !== '' ? clip(String(s.num), 12) : null, headers: {},
      catchup: +s.tv_archive === 1 ? 'xc' : null, catchupDays: +s.tv_archive === 1 ? Math.min(30, Math.max(1, +s.tv_archive_duration || 1)) : null, catchupSource: null,
      shift: null, radio: s.stream_type === 'radio_streams' ? 1 : 0, adult: String(s.is_adult) === '1' || isAdultName(group) ? 1 : 0, xcId: id,
      hd: /\b(hd|fhd|uhd|4k)\b/i.test(name) ? 1 : 0 });
  }
  return out;
}

// ---------- filmer och serier ----------
const year = (s) => { const m = /\b(19|20)\d{2}\b/.exec(String(s || '')); return m ? +m[0] : null; };
const rating = (r) => { const x = parseFloat(r); return Number.isFinite(x) && x > 0 ? Math.min(10, Math.round(x * 10) / 10) : null; };

/** Hämtar listorna med filmer och serier och sparar dem i iptv_vod. Rader som inte längre finns tas bort – men inte om
 *  mer än hälften skulle försvinna på en gång (som skannrarnas skydd: en tillfälligt halv lista raderar inget). */
export async function syncVod(tunerId, src) {
  const [vc, vs, sc, ss] = await Promise.all([api(src, 'get_vod_categories'), api(src, 'get_vod_streams'), api(src, 'get_series_categories'), api(src, 'get_series')]);
  const vcm = catMap(vc), scm = catMap(sc);
  const mark = Date.now();
  const rows = [];
  for (const m of arr(vs).slice(0, 200000)) {
    const id = parseInt(m.stream_id, 10); if (!Number.isFinite(id)) continue;
    rows.push(['movie', String(id), clip(m.name, 200) || 'Film', vcm.get(String(m.category_id)) || null, httpUrl(m.stream_icon), null, null, year(m.name) || year(m.releasedate),
      rating(m.rating), null, null, null, null, /^\w{1,5}$/.test(m.container_extension || '') ? m.container_extension : null, +m.added || null, parseInt(m.tmdb, 10) || null]);
  }
  for (const s of arr(ss).slice(0, 100000)) {
    const id = parseInt(s.series_id, 10); if (!Number.isFinite(id)) continue;
    rows.push(['series', String(id), clip(s.name, 200) || 'Serie', scm.get(String(s.category_id)) || null, httpUrl(s.cover), httpUrl(arr(s.backdrop_path)[0]), clip(s.plot, 3000) || null,
      year(s.releaseDate || s.release_date) || year(s.name), rating(s.rating), clip(s.genre, 200) || null, clip(s.cast, 500) || null, clip(s.director, 200) || null,
      null, null, +s.last_modified || null, parseInt(s.tmdb, 10) || null]);
  }
  const before = get('SELECT COUNT(*) AS n FROM iptv_vod WHERE tuner_id=?', tunerId).n;
  const ins = `INSERT INTO iptv_vod(tuner_id,kind,ext_id,name,category,cover,backdrop,plot,year,rating,genre,cast_list,director,duration,ext,added,tmdb,seen)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tuner_id,kind,ext_id) DO UPDATE SET name=excluded.name, category=excluded.category,
    cover=COALESCE(excluded.cover, cover), backdrop=COALESCE(excluded.backdrop, backdrop), plot=COALESCE(excluded.plot, plot), year=COALESCE(excluded.year, year),
    rating=COALESCE(excluded.rating, rating), genre=COALESCE(excluded.genre, genre), cast_list=COALESCE(excluded.cast_list, cast_list), director=COALESCE(excluded.director, director),
    ext=COALESCE(excluded.ext, ext), added=COALESCE(excluded.added, added), tmdb=COALESCE(excluded.tmdb, tmdb), seen=excluded.seen,
    info=CASE WHEN excluded.added IS NOT iptv_vod.added AND iptv_vod.kind='series' THEN 0 ELSE iptv_vod.info END`;
  for (let i = 0; i < rows.length; i += 2000) {
    tx(() => { for (const r of rows.slice(i, i + 2000)) run(ins, tunerId, ...r, mark); });
    await new Promise(setImmediate);
  }
  let removed = 0;
  const gone = get('SELECT COUNT(*) AS n FROM iptv_vod WHERE tuner_id=? AND (seen IS NULL OR seen != ?)', tunerId, mark).n;
  if (gone && (rows.length === 0 || gone > before / 2) && before > 20) console.warn(`[iptv] ${gone} av ${before} filmer/serier saknas i listan – tas inte bort (för många på en gång)`);
  else if (gone) removed = Number(run('DELETE FROM iptv_vod WHERE tuner_id=? AND (seen IS NULL OR seen != ?)', tunerId, mark).changes);
  return { movies: rows.filter(r => r[0] === 'movie').length, series: rows.filter(r => r[0] === 'series').length, removed };
}

/** Mer om en film (handling, skådespelare, längd …) – hämtas första gången filmen öppnas */
export async function movieInfo(row, src) {
  const d = await api(src, 'get_vod_info', { vod_id: row.ext_id });
  const i = d?.info && typeof d.info === 'object' ? d.info : {};
  const dur = parseInt(i.duration_secs, 10) || (/^(\d+):(\d+):(\d+)$/.test(i.duration || '') ? i.duration.split(':').reduce((a, b) => a * 60 + +b, 0) : null);
  run(`UPDATE iptv_vod SET plot=COALESCE(?, plot), genre=COALESCE(?, genre), cast_list=COALESCE(?, cast_list), director=COALESCE(?, director), duration=COALESCE(?, duration),
    year=COALESCE(?, year), backdrop=COALESCE(?, backdrop), cover=COALESCE(cover, ?), rating=COALESCE(rating, ?), tmdb=COALESCE(tmdb, ?), ext=COALESCE(?, ext), info=1 WHERE id=?`,
  clip(i.plot || i.description, 3000) || null, clip(i.genre, 200) || null, clip(i.cast || i.actors, 500) || null, clip(i.director, 200) || null, dur || null,
  year(i.releasedate || i.release_date), httpUrl(arr(i.backdrop_path)[0]), httpUrl(i.movie_image || i.cover_big), rating(i.rating), parseInt(i.tmdb_id, 10) || null,
  /^\w{1,5}$/.test(d?.movie_data?.container_extension || '') ? d.movie_data.container_extension : null, row.id);
}

/** Avsnitten i en serie (sparas i iptv_episodes) */
export async function seriesInfo(row, src) {
  const d = await api(src, 'get_series_info', { series_id: row.ext_id });
  const i = d?.info && typeof d.info === 'object' ? d.info : {};
  const eps = [];
  for (const [season, list] of Object.entries(d?.episodes && typeof d.episodes === 'object' ? d.episodes : {})) {
    for (const e of arr(list).slice(0, 2000)) {
      if (e?.id == null) continue;
      const info = e.info && typeof e.info === 'object' ? e.info : {};
      eps.push([String(e.id).slice(0, 40), parseInt(e.season ?? season, 10) || null, parseInt(e.episode_num, 10) || null, clip(e.title, 300) || null, clip(info.plot, 2000) || null,
        parseInt(info.duration_secs, 10) || null, /^\w{1,5}$/.test(e.container_extension || '') ? e.container_extension : null, httpUrl(info.movie_image)]);
    }
    if (eps.length > 20000) break;
  }
  tx(() => {
    run(`UPDATE iptv_vod SET plot=COALESCE(?, plot), genre=COALESCE(?, genre), cast_list=COALESCE(?, cast_list), director=COALESCE(?, director),
      backdrop=COALESCE(?, backdrop), cover=COALESCE(cover, ?), info=1 WHERE id=?`, clip(i.plot, 3000) || null, clip(i.genre, 200) || null, clip(i.cast, 500) || null,
    clip(i.director, 200) || null, httpUrl(arr(i.backdrop_path)[0]), httpUrl(i.cover), row.id);
    const keep = new Set(eps.map(e => e[0]));
    for (const e of all('SELECT id, ext_id FROM iptv_episodes WHERE vod_id=?', row.id)) if (!keep.has(e.ext_id)) run('DELETE FROM iptv_episodes WHERE id=?', e.id);
    for (const e of eps) run(`INSERT INTO iptv_episodes(vod_id,ext_id,season,episode,title,plot,duration,ext,image) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(vod_id,ext_id) DO UPDATE SET season=excluded.season, episode=excluded.episode, title=excluded.title, plot=excluded.plot, duration=excluded.duration, ext=excluded.ext, image=excluded.image`, row.id, ...e);
  });
  return eps.length;
}
