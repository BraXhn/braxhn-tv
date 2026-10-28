// Sökning: titlar (/api/search – apparna läser den), personer och den universella sökningen (/api/search/all)
// över filmer, serier, avsnitt, personer, musik, ljudböcker, poddar och live-TV. Matchningen finns i search.js.
import { all } from '../db.js';
import { send } from '../util.js';
import * as people from '../people.js';
import * as music from '../music.js';
import * as books from '../audiobooks.js';
import * as ebooks from '../ebooks.js';
import * as pods from '../podcasts.js';
import * as live from '../livetv.js';
import { parseQuery, searchItemIds } from '../search.js';
import * as sublines from '../sublines.js';
import * as family from '../familyfilter.js';
import { searchKey, rowScore } from '../searchkey.js';
import { route, user } from '../http/router.js';
import { ageFilter, itemsByIds, allowUnrated, allowedFor } from '../http/context.js';

const MAX = 60;
const queryOf = (c) => String(c.q.get('q') || '').slice(0, 100);

// Filmer och serier först, sedan avsnitt – var för sig rankade (exakt > början > ord > innehåller > stavfel)
route('GET', '/api/search', user, (c) => {
  const raw = queryOf(c), Q = parseQuery(raw);
  if (Q.empty) return send(c.res, 200, []);
  const uid = c.user.id, age = ageFilter(uid);
  const ids = searchItemIds(Q, ['movie', 'show'], age, MAX).map(r => r.id);
  // Som tidigare: serier vars beskrivning innehåller frågan, efter titelträffarna (LIKE med escapade % och _)
  const q = raw.normalize('NFC').trim();
  if (ids.length < MAX && q.length >= 3) {
    for (const r of all(`SELECT i.id FROM items i LEFT JOIN items s ON s.id=i.parent_id WHERE i.kind='show' AND i.overview LIKE ? ESCAPE '\\'
      AND i.version_of IS NULL${age.sql} ORDER BY i.sort_title LIMIT ?`, `%${q.replace(/[%_\\]/g, '\\$&')}%`, ...age.params, MAX)) {
      if (ids.length < MAX && !ids.includes(r.id)) ids.push(r.id);
    }
  }
  if (ids.length < MAX) ids.push(...searchItemIds(Q, ['episode'], age, MAX - ids.length).map(r => r.id));
  send(c.res, 200, itemsByIds(uid, ids));
});

route('GET', '/api/search/people', user, (c) => {
  const q = queryOf(c).trim();
  if (q.length < 2) return send(c.res, 200, []);
  send(c.res, 200, people.searchPeople(q, ageFilter(c.user.id), 20));
});

/**
 * Repliksökning (server/sublines.js): ?q= och ?limit= (1–60, standard 30). Bara titlar som profilen får se (bibliotek och
 * åldersgräns i SQL och allowedFor per träff). Tiden t är justerad med undertextsynken. status = indexets läge
 * (antal titlar och repliker bara för administratören).
 */
route('GET', '/api/search/lines', user, (c) => {
  const q = queryOf(c).trim(), uid = c.user.id;
  const lim = Math.min(60, Math.max(1, parseInt(c.q.get('limit')) || 30));
  let lines = q ? sublines.search(q, { age: ageFilter(uid), allowed: (r) => allowedFor(uid, r), limit: lim }) : [];
  // Familjefiltret: svordomar visas som *** även här (markeringen räknas om på den maskerade texten)
  if (lines.length && family.modeFor(uid) !== 'off') {
    const words = sublines.wordsOf(q);
    lines = lines.map(l => { const line = family.maskText(l.line, l.lang); return { ...l, line, marks: line === l.line ? l.marks : sublines.marksOf(line, words),
      before: l.before && family.maskText(l.before, l.lang), after: l.after && family.maskText(l.after, l.lang) }; });
  }
  // Antalet indexerade titlar gäller hela servern – bara administratören får siffrorna
  const st = sublines.status();
  send(c.res, 200, { q, lines, status: c.user.is_admin ? st : { enabled: st.enabled, indexing: !!st.indexing } });
});

// Grupperna i svaret, i standardordning (order i svaret sorterar dem efter bästa träff)
const GROUPS = ['movies', 'shows', 'people', 'episodes', 'artists', 'albums', 'tracks', 'books', 'ebooks', 'podcasts', 'podcastEpisodes', 'channels', 'programs'];
const nameOf = { people: 'name', artists: 'name', channels: 'name' };
/**
 * Universell sökning. ?q= och ?limit= (per grupp, 1–50, standard 12). Barnprofiler: titlar och personer inom
 * åldersgränsen, inga poddar (som i menyn) och live-TV bara om administratören tillåter okända åldersgränser.
 */
route('GET', '/api/search/all', user, (c) => {
  const raw = queryOf(c), Q = parseQuery(raw);
  const lim = Math.min(50, Math.max(1, parseInt(c.q.get('limit')) || 12));
  const out = Object.fromEntries(GROUPS.map(g => [g, []]));
  out.q = raw.trim(); out.order = [];
  if (Q.empty) return send(c.res, 200, out);
  const uid = c.user.id, age = ageFilter(uid), kid = c.user.max_age != null;
  for (const [g, kind] of [['movies', 'movie'], ['shows', 'show'], ['episodes', 'episode']]) out[g] = itemsByIds(uid, searchItemIds(Q, [kind], age, lim).map(r => r.id));
  out.people = people.searchPeople(Q, age, lim);
  Object.assign(out, music.searchMusic(Q, uid, null, { artists: lim, albums: lim, tracks: lim }));
  out.books = books.searchBooks(Q, uid, lim);
  // E-böcker och serietidningar: bara bibliotek och åldersgränser profilen får se (ebooks.visible), bara webben
  if (c.user.kind !== 'app') out.ebooks = ebooks.searchEbooks(Q, uid, lim);
  if (!kid) { out.podcasts = pods.searchPodcasts(Q, lim); out.podcastEpisodes = pods.searchEpisodes(Q, uid, lim); }
  if (!kid || allowUnrated()) {
    out.channels = live.searchChannels(Q, lim);
    // Ett program per titel (nästa sändning), rankat som de andra grupperna
    const seen = new Set();
    out.programs = live.searchPrograms(Q, { limit: lim * 4, byTime: false }).filter(p => !seen.has(p.title) && seen.add(p.title)).slice(0, lim);
  }
  // Ordningen: grupper vars bästa träff är på en bättre nivå först (exakt > början av titel/ord > innehåller >
  // stavfel), annars standardordningen – "keanu" visar Personer först, "bamse" Filmer före Avsnitt
  const best = (g) => { const x = out[g][0]; const t = x[nameOf[g] || 'title'] || ''; const s = rowScore(Q, { _k: searchKey(t), _t: t }); return s >= 95 ? 3 : s >= 60 ? 2 : s >= 40 ? 1 : 0; };
  out.order = GROUPS.filter(g => out[g].length).map((g, i) => ({ g, s: best(g), i })).sort((a, b) => (b.s - a.s) || (a.i - b.i)).map(x => x.g);
  send(c.res, 200, out);
});
