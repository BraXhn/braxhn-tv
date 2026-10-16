// Årssammanfattning per användare: mest sedda titlar, timmar, favoritgenre, mest spelad musik och ljudböcker.
// Bygger på befintlig statistik: plays (uppspelningar av filmer/avsnitt), progress (position/sedd),
// track_plays (musik) och book_progress (ljudböcker). Tabellerna skapas av activity.js och audiobooks.js.
import { all, get } from './db.js';

const has = (t) => !!get(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, t);
const parseGenres = (g) => { try { const a = JSON.parse(g || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

/** Årets gränser i lokal tid (sekunder) */
export function yearRange(year) {
  return [Math.floor(new Date(year, 0, 1).getTime() / 1000), Math.floor(new Date(year + 1, 0, 1).getTime() / 1000)];
}

/** År som användaren har statistik för (nyast först) */
export function years(uid) {
  const out = new Set();
  const add = (sql) => { for (const r of all(sql, uid)) if (r.y) out.add(+r.y); };
  if (has('plays')) add(`SELECT DISTINCT strftime('%Y', ts, 'unixepoch', 'localtime') AS y FROM plays WHERE user_id=?`);
  add(`SELECT DISTINCT strftime('%Y', ts, 'unixepoch', 'localtime') AS y FROM track_plays WHERE user_id=?`);
  if (has('book_progress')) add(`SELECT DISTINCT strftime('%Y', updated, 'unixepoch', 'localtime') AS y FROM book_progress WHERE user_id=?`);
  return [...out].sort((a, b) => b - a);
}

export function wrapped(uid, year) {
  const [from, to] = yearRange(year);
  const out = { year, hours: 0, video: { hours: 0, plays: 0, movies: 0, episodes: 0, titles: [], genres: [], months: Array(12).fill(0) },
    music: { hours: 0, plays: 0, artists: [], tracks: [] }, books: { hours: 0, list: [] }, topGenre: null };

  // ---- film och serier ----
  if (has('plays')) {
    const plays = all(`SELECT p.item_id, p.ts, i.kind, i.duration, i.genres, i.parent_id, COALESCE(s.id, i.id) AS tid, COALESCE(s.title, i.title) AS title,
        COALESCE(s.year, i.year) AS year, COALESCE(s.kind, i.kind) AS tkind, s.genres AS sgenres
      FROM plays p JOIN items i ON i.id=p.item_id LEFT JOIN items s ON s.id=i.parent_id WHERE p.user_id=? AND p.ts>=? AND p.ts<?`, uid, from, to);
    out.video.plays = plays.length;
    const titles = new Map(), genres = new Map(), items = new Set();
    for (const p of plays) {
      items.add(p.item_id);
      out.video.months[new Date(p.ts * 1000).getMonth()]++;
      const t = titles.get(p.tid) || { id: p.tid, title: p.title, year: p.year, kind: p.tkind, plays: 0 };
      t.plays++; titles.set(p.tid, t);
      for (const g of parseGenres(p.kind === 'episode' ? p.sgenres : p.genres)) genres.set(g, (genres.get(g) || 0) + 1);
    }
    // Speltid: sedda titlar räknas med hela längden, påbörjade med positionen (en gång per titel och år)
    let secs = 0;
    for (const id of items) {
      const r = get(`SELECT i.kind, i.duration, g.position, g.watched FROM items i LEFT JOIN progress g ON g.item_id=i.id AND g.user_id=? WHERE i.id=?`, uid, id);
      if (!r) continue;
      if (r.kind === 'movie') out.video.movies++; else out.video.episodes++;
      secs += r.watched ? (r.duration || 0) : Math.min(r.position || 0, r.duration || Infinity);
    }
    out.video.hours = Math.round(secs / 360) / 10;
    out.video.titles = [...titles.values()].sort((a, b) => b.plays - a.plays || a.title.localeCompare(b.title, 'sv')).slice(0, 10);
    out.video.genres = [...genres].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, plays: n }));
    out.topGenre = out.video.genres[0]?.name || null;
  }

  // ---- musik ----
  const tp = all(`SELECT t.id, t.title, t.duration, t.album_id, a.name AS artist, a.id AS artist_id FROM track_plays p JOIN tracks t ON t.id=p.track_id
    LEFT JOIN artists a ON a.id=t.artist_id WHERE p.user_id=? AND p.ts>=? AND p.ts<?`, uid, from, to);
  out.music.plays = tp.length;
  const tracks = new Map(), artists = new Map();
  let msecs = 0;
  for (const t of tp) {
    msecs += t.duration || 0;
    const x = tracks.get(t.id) || { id: t.id, title: t.title, artist: t.artist || null, album: t.album_id, plays: 0 };
    x.plays++; tracks.set(t.id, x);
    if (t.artist_id) { const a = artists.get(t.artist_id) || { id: t.artist_id, name: t.artist, plays: 0 }; a.plays++; artists.set(t.artist_id, a); }
  }
  out.music.hours = Math.round(msecs / 360) / 10;
  out.music.tracks = [...tracks.values()].sort((a, b) => b.plays - a.plays || a.title.localeCompare(b.title, 'sv')).slice(0, 10);
  out.music.artists = [...artists.values()].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name, 'sv')).slice(0, 5);

  // ---- ljudböcker (senast lyssnad under året; positionen är en uppskattning av lyssnad tid) ----
  if (has('book_progress')) {
    const bl = all(`SELECT b.id, b.title, b.author, b.duration, p.position, p.finished, p.updated FROM book_progress p JOIN books b ON b.id=p.book_id
      WHERE p.user_id=? AND p.updated>=? AND p.updated<? ORDER BY p.finished DESC, p.updated DESC`, uid, from, to);
    let bsecs = 0;
    out.books.list = bl.slice(0, 10).map(b => ({ id: b.id, title: b.title, author: b.author || null, finished: !!b.finished }));
    for (const b of bl) bsecs += b.finished ? (b.duration || b.position || 0) : (b.position || 0);
    out.books.hours = Math.round(bsecs / 360) / 10;
    out.books.finished = bl.filter(b => b.finished).length;
  }
  out.hours = Math.round((out.video.hours + out.music.hours + out.books.hours) * 10) / 10;
  return out;
}
