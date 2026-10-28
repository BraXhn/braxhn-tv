// Kvällsvalet: hushållet röstar fram kvällens film eller serie (se server/tonight.js för regler och flöde).
import { all } from '../db.js';
import { readJson, fail, send } from '../util.js';
import * as tonight from '../tonight.js';
import * as party from '../party.js';
import { route, user } from '../http/router.js';
import { allowedFor, ageFilter, genreProfile, itemsByIds, permsOf } from '../http/context.js';

tonight.setHelpers({ allowedFor, ageFilter, genreProfile });

// Mediatoken och bildtoken släpps aldrig in här (router.js) – bara riktiga inloggningar
// Startsidan: öppna kvällsval i hushållet och vad filtren kan väljas bland (bibliotek och genrer profilen ser)
route('GET', '/api/tonight', user, (c) => {
  const pm = permsOf(c.user.id);
  const libraries = all("SELECT id, name, type FROM libraries WHERE type IN ('movie','show') ORDER BY name").filter(l => pm.libs == null || pm.libs.includes(l.id));
  const age = ageFilter(c.user.id);
  const genres = all(`SELECT DISTINCT g.value AS g FROM items i LEFT JOIN items s ON s.id=i.parent_id, json_each(CASE WHEN json_valid(i.genres) THEN i.genres ELSE '[]' END) g
    WHERE i.kind IN ('movie','show') AND i.version_of IS NULL${age.sql} ORDER BY g.value LIMIT 200`, ...age.params).map(r => String(r.g));
  send(c.res, 200, { sessions: tonight.listFor(c.user), libraries, genres });
});
route('POST', '/api/tonight', user, async (c) => {
  const s = tonight.create(c.user, (await readJson(c.req, 8192)).filters);
  send(c.res, 200, { id: s.id, code: s.code });
});
// Gå med med koden (inskriven eller från QR-koden)
route('POST', '/api/tonight/join', user, async (c) => {
  const s = tonight.joinByCode(c.user, (await readJson(c.req, 1024)).code);
  send(c.res, 200, { id: s.id });
});
const mine = (c) => {
  const s = tonight.sessionFor(c.user, c.p.id);
  if (!s) fail(c.res, 404, 'Kvällsvalet finns inte längre');
  return s;
};
// Direkt från profilen (samma hushåll, utan kod)
route('POST', '/api/tonight/:id/join', user, (c) => send(c.res, 200, { id: tonight.joinHousehold(c.user, c.p.id).id }));
// Läget och förslagen (titlarna slås upp med deltagarens egen åldersgräns och behörighet)
route('GET', '/api/tonight/:id', user, (c) => {
  const s = mine(c); if (!s) return;
  send(c.res, 200, { ...tonight.view(s, c.user.id), deck: itemsByIds(c.user.id, s.deck) });
});
route('GET', '/api/tonight/:id/events', user, (c) => { const s = mine(c); if (s) tonight.subscribe(s, c.user, c.req, c.res); });
route('PUT', '/api/tonight/:id/filters', user, async (c) => {
  const s = mine(c); if (!s) return;
  send(c.res, 200, { filters: tonight.setFilters(s, c.user.id, await readJson(c.req, 8192)) });
});
route('POST', '/api/tonight/:id/start', user, (c) => { const s = mine(c); if (!s) return; tonight.start(s, c.user.id); send(c.res, 200, { ok: true }); });
route('POST', '/api/tonight/:id/more', user, (c) => { const s = mine(c); if (!s) return; tonight.more(s, c.user.id); send(c.res, 200, { ok: true }); });
route('POST', '/api/tonight/:id/vote', user, async (c) => {
  const s = mine(c); if (!s) return;
  const b = await readJson(c.req, 1024);
  tonight.vote(s, c.user.id, b.item, b.like == null ? null : !!b.like);
  send(c.res, 200, { ok: true, phase: s.phase });
});
route('POST', '/api/tonight/:id/pick', user, async (c) => {
  const s = mine(c); if (!s) return;
  tonight.pick(s, c.user.id, (await readJson(c.req, 1024)).item);
  send(c.res, 200, { ok: true });
});
// Titta tillsammans för alla: rummet skapas med det avsnitt/den film som den som skapar det skulle spela
route('POST', '/api/tonight/:id/party', user, (c) => {
  const s = mine(c); if (!s) return;
  if (s.phase !== 'matched') return fail(c.res, 409, 'Ingen titel är vald än');
  if (s.party && party.getRoom(s.party)) return send(c.res, 200, { id: s.party });
  const play = tonight.view(s, c.user.id).match?.play;
  if (!play) return fail(c.res, 404, 'Finns inte');
  const it = all(`SELECT * FROM items WHERE id=? AND kind != 'show'`, play.id)[0];
  if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  const rid = party.createRoom(c.user, it.id);
  tonight.setParty(s, rid);
  send(c.res, 200, { id: rid });
});
route('DELETE', '/api/tonight/:id/me', user, (c) => { const s = mine(c); if (!s) return; tonight.leave(s, c.user.id); send(c.res, 200, { ok: true }); });
route('DELETE', '/api/tonight/:id', user, (c) => {
  const s = mine(c); if (!s) return;
  if (s.host !== c.user.id) return fail(c.res, 403, 'Bara den som startade kvällsvalet kan avsluta det');
  tonight.close(s);
  send(c.res, 200, { ok: true });
});
