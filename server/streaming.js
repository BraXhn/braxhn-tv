// Streamingtjänster: "Var kan jag se den?" via TMDB:s data om tjänster (JustWatch) för Sverige.
// BraXhn TV spelar inte innehållet från tjänsterna (DRM) – den visar var det finns och öppnar tjänstens app/sida.
import { db, get, run, now, getSetting } from './db.js';
import { tmdb } from './scanner.js';

db.exec(`CREATE TABLE IF NOT EXISTS watch_cache(kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, data TEXT, fetched INTEGER NOT NULL, PRIMARY KEY(kind, tmdb_id))`);
export const region = () => getSetting('watch_region', process.env.WATCH_REGION || 'SE');
export const myProviders = () => getSetting('my_providers', '').split(',').map(Number).filter(Boolean);

// Sökadresser per tjänst (tjänsterna har inga öppna djuplänkar per titel). Matchas på namn.
const SEARCH = [
  [/prime video|amazon/i, (q) => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${q}`],
  [/tv4/i, (q) => `https://www.tv4play.se/sok?q=${q}`],
  [/netflix/i, (q) => `https://www.netflix.com/search?q=${q}`],
  [/svt/i, (q) => `https://www.svtplay.se/sok?q=${q}`],
  [/viaplay/i, (q) => `https://viaplay.se/search?query=${q}`],
  [/^max$|hbo/i, (q) => `https://play.max.com/search?q=${q}`],
  [/disney/i, (q) => `https://www.disneyplus.com/search?q=${q}`],
  [/apple tv/i, (q) => `https://tv.apple.com/se/search?term=${q}`],
  [/skyshowtime/i, (q) => `https://www.skyshowtime.com/se/search?q=${q}`],
  [/urplay|ur play/i, (q) => `https://urplay.se/sok?q=${q}`],
  [/youtube/i, (q) => `https://www.youtube.com/results?search_query=${q}`],
  [/google play/i, (q) => `https://play.google.com/store/search?q=${q}&c=movies`],
  [/sf anytime/i, (q) => `https://www.sfanytime.com/sv/search?q=${q}`]
];
const linkFor = (name, title, fallback) => { const m = SEARCH.find(([re]) => re.test(name)); return m ? m[1](encodeURIComponent(title)) : fallback; };
const logo = (p) => p ? `https://image.tmdb.org/t/p/w92${p}` : null;

/** Tjänster för en titel: { link, flatrate:[], free:[], rent:[], buy:[] } med logotyper och adresser */
export async function providersFor(kind, tmdbId, title) {
  const k = kind === 'show' ? 'tv' : 'movie';
  let row = get('SELECT * FROM watch_cache WHERE kind=? AND tmdb_id=?', k, tmdbId);
  if (!row || now() - row.fetched > 86400) {
    let data = null;
    try { data = (await tmdb(`/${k}/${tmdbId}/watch/providers`)).results || {}; } catch (e) { if (row) data = JSON.parse(row.data || '{}'); else throw e; }
    run('INSERT OR REPLACE INTO watch_cache(kind,tmdb_id,data,fetched) VALUES(?,?,?,?)', k, tmdbId, JSON.stringify(data), now());
    row = { data: JSON.stringify(data) };
  }
  const r = (JSON.parse(row.data || '{}'))[region()] || {};
  const mine = new Set(myProviders());
  const map = (list) => (list || []).map(p => ({ id: p.provider_id, name: p.provider_name, logo: logo(p.logo_path), url: linkFor(p.provider_name, title, r.link), mine: mine.has(p.provider_id) }))
    .sort((a, b) => b.mine - a.mine);
  const out = { link: r.link || null, flatrate: map(r.flatrate), free: map([...(r.free || []), ...(r.ads || [])]), rent: map(r.rent), buy: map(r.buy) };
  out.onMine = [...out.flatrate, ...out.free].filter(p => p.mine).map(p => p.name);
  return out;
}

/** Alla tjänster i regionen (för inställningen "Mina tjänster") */
export async function allProviders() {
  const [m, t] = await Promise.all([tmdb('/watch/providers/movie', { watch_region: region() }), tmdb('/watch/providers/tv', { watch_region: region() })]);
  const by = new Map();
  for (const p of [...(m.results || []), ...(t.results || [])]) if (!by.has(p.provider_id)) by.set(p.provider_id, { id: p.provider_id, name: p.provider_name, logo: logo(p.logo_path), prio: p.display_priorities?.[region()] ?? p.display_priority ?? 999 });
  return [...by.values()].sort((a, b) => a.prio - b.prio).slice(0, 80);
}

/** Bläddra i det som finns på valda tjänster (abonnemang), populärast först */
export async function discover(kind, providerIds, page = 1, genre = null) {
  const k = kind === 'show' ? 'tv' : 'movie';
  const ids = (providerIds?.length ? providerIds : myProviders()).slice(0, 10);
  if (!ids.length) return { results: [], page: 1, pages: 0 };
  const d = await tmdb(`/discover/${k}`, { watch_region: region(), with_watch_providers: ids.join('|'), with_watch_monetization_types: 'flatrate|free|ads',
    sort_by: 'popularity.desc', page: Math.max(1, Math.min(50, page)), ...(genre ? { with_genres: genre } : {}) });
  return { page: d.page, pages: Math.min(d.total_pages || 0, 50), results: (d.results || []).map(r => ({
    id: r.id, kind: kind === 'show' ? 'show' : 'movie', title: r.title || r.name, year: parseInt(r.release_date || r.first_air_date) || null,
    overview: (r.overview || '').slice(0, 400), poster: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : null, rating: r.vote_average || null,
    inLibrary: get('SELECT id FROM items WHERE tmdb_id=? AND kind=? AND version_of IS NULL', r.id, kind === 'show' ? 'show' : 'movie')?.id || null })) };
}
