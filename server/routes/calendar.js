// Kalender för kommande avsnitt ("Kommande"), saknade avsnitt per serie och iCal-prenumeration.
//   GET    /api/calendar              – avsnitt per dag (?from=&to= YYYY-MM-DD, ?mine=1 bara följda serier)
//   GET    /api/calendar.ics?t=       – iCal för telefonens kalender; bara den personliga kalendertoken (router: calendar)
//   GET/POST/DELETE /api/calendar/feed – kalendertoken under Mitt konto (visas bara när den skapas)
//   GET    /api/items/:id/missing     – sända avsnitt som saknas i biblioteket ("Saknas: S02E04–E06")
//   POST   /api/items/:id/missing/search – be Sonarr söka efter dem (den som får göra önskemål)
import { route, user, calendar as cal } from '../http/router.js';
import { send, fail } from '../util.js';
import { get } from '../db.js';
import { allowedFor, restricted, ctx } from '../http/context.js';
import { createCalendarToken, revokeCalendarToken, calendarTokenInfo, audit } from '../auth.js';
import { hasTmdb, tvdbOf } from '../scanner.js';
import * as arr from '../arr.js';
import * as calendar from '../calendar.js';

const MAX_SPAN = 92;
function opts(uid, q, sonarrList) {
  // Begränsade konton (åldersgräns eller bara vissa bibliotek) ser inte Sonarrs serier utanför biblioteket
  return { allowed: (s) => allowedFor(uid, s), kid: restricted(uid), mine: q.get('mine') === '1', sonarrList };
}

route('GET', '/api/calendar', user, async (c) => {
  const today = calendar.ymd();
  let from = calendar.validDay(c.q.get('from')) ? c.q.get('from') : today;
  let to = calendar.validDay(c.q.get('to')) ? c.q.get('to') : calendar.addDays(from, 27);
  if (to < from) to = from;
  if (calendar.addDays(from, MAX_SPAN) < to) to = calendar.addDays(from, MAX_SPAN);
  // Sonarr väntar vi på en kort stund (cachas 30 min); svarar det inte visas TMDB:s data
  const sonarrList = arr.configured('show')
    ? await Promise.race([calendar.loadSonarr(), new Promise(r => setTimeout(() => r(calendar.sonarrCached()), 4000).unref())]) : [];
  const inf = calendar.info();
  // Inget hämtat ännu (ny installation eller nyss inlagd nyckel): börja hämta i bakgrunden
  if (hasTmdb() && !inf.shows && !inf.refreshing) calendar.refreshDue().catch(() => {});
  send(c.res, 200, { today, from, to, tmdb: hasTmdb(), sonarr: arr.configured('show'), ...inf,
    items: calendar.entries(c.user.id, from, to, opts(c.user.id, c.q, sonarrList)) });
});

route('GET', '/api/calendar\\.ics', cal, (c) => {
  const today = calendar.ymd();
  const list = calendar.entries(c.user.id, calendar.addDays(today, -14), calendar.addDays(today, 90), opts(c.user.id, c.q, calendar.sonarrCached()));
  const host = String(c.req.headers.host || '').split(':')[0];
  const name = c.q.get('mine') === '1' ? 'BraXhn TV – serier jag följer' : 'BraXhn TV – kommande avsnitt';
  send(c.res, 200, calendar.ical(list, { name, host }), { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=900',
    'Content-Disposition': 'inline; filename="braxhn-tv.ics"' });
});

// ---------- kalendertoken (Mitt konto) ----------
const feedInfo = (uid) => { const t = calendarTokenInfo(uid); return { active: !!t, created: t?.created || null, lastUsed: t?.last_used || null }; };
route('GET', '/api/calendar/feed', user, (c) => send(c.res, 200, feedInfo(c.user.id)));
// En ny token ersätter den gamla (gamla prenumerationer slutar fungera). Token visas bara i det här svaret.
route('POST', '/api/calendar/feed', user, (c) => {
  const token = createCalendarToken(c.user.id);
  audit('calendar_token_created', ctx(c));
  send(c.res, 200, { ...feedInfo(c.user.id), path: `/api/calendar.ics?t=${token}` });
});
route('DELETE', '/api/calendar/feed', user, (c) => {
  if (revokeCalendarToken(c.user.id)) audit('calendar_token_revoked', ctx(c));
  send(c.res, 200, feedInfo(c.user.id));
});

// ---------- saknade avsnitt ----------
function showFor(c) {
  const it = get("SELECT * FROM items WHERE id=? AND kind='show'", +c.p.id);
  if (!it) { fail(c.res, 404, 'Finns inte'); return null; }
  if (!allowedFor(c.user.id, it)) { fail(c.res, 403, 'Inte tillgänglig i den här profilen'); return null; }
  return it;
}
const canSearch = (u) => arr.canRequest(u) && arr.configured('show');
route('GET', '/api/items/:id/missing', user, (c) => {
  const it = showFor(c); if (!it) return;
  send(c.res, 200, { ...calendar.missing(it.id), tmdb: hasTmdb(), canSearch: canSearch(c.user) });
});
const searched = new Map(); // serie -> tid (en sökning per serie och tio minuter)
route('POST', '/api/items/:id/missing/search', user, async (c) => {
  const it = showFor(c); if (!it) return;
  if (!canSearch(c.user)) return fail(c.res, 403, 'Sonarr är inte kopplat, eller så får du inte göra önskemål');
  const m = calendar.missing(it.id);
  if (!m.count) return send(c.res, 200, { searched: 0 });
  if (Date.now() - (searched.get(it.id) || 0) < 10 * 60e3) return fail(c.res, 429, 'Sonarr söker redan efter avsnitten – vänta några minuter');
  searched.set(it.id, Date.now());
  try {
    const r = await arr.searchEpisodes({ tmdbId: it.tmdb_id, tvdbId: it.tmdb_id ? await tvdbOf(it.tmdb_id) : null }, m.episodes);
    if (r.notInSonarr) { searched.delete(it.id); return fail(c.res, 404, 'Serien finns inte i Sonarr – önska den under Önskningar'); }
    audit('sonarr_search', { ...ctx(c), detail: `${it.title}: ${r.searched} avsnitt` });
    send(c.res, 200, { searched: r.searched });
  } catch (e) { searched.delete(it.id); fail(c.res, 502, e.message); }
});
