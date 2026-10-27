// Egna betyg (server/ratings.js): titlar (film, serie, avsnitt), album och låtar. Varje profil har sina egna betyg –
// även barnprofiler, men bara för det de får se (allowedFor/libOk, otillåtet = finns inte). Body { rating: 1–5 i halva
// steg, 0/null = ta bort }. Titelbetyg skickas till Trakt om kontot är kopplat (trakt.pushRatings, i bakgrunden).
import { get, now } from '../db.js';
import { send, fail, readJson } from '../util.js';
import * as ratings from '../ratings.js';
import * as trakt from '../trakt.js';
import * as listen from '../listening.js';
import { route, user } from '../http/router.js';
import { allowedFor, libOk } from '../http/context.js';

async function readStars(c) {
  const b = await readJson(c.req);
  const h = ratings.parseStars(b?.rating);
  if (h == null) { fail(c.res, 400, 'Betyget ska vara 1–5 stjärnor i halva steg (0 tar bort)'); return null; }
  return h;
}
const out = (h) => ({ rating: h ? h / 2 : null });

route('PUT', '/api/items/:id/rating', user, async (c) => {
  const row = get('SELECT * FROM items WHERE id=?', +c.p.id);
  // Filmversioner betygsätts på huvudraden
  const it = row?.version_of ? get('SELECT * FROM items WHERE id=?', row.version_of) : row;
  if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  if (!['movie', 'show', 'episode'].includes(it.kind)) return fail(c.res, 400, 'Den här titeln kan inte betygsättas');
  const h = await readStars(c); if (h == null) return;
  ratings.set(c.user.id, 'item', it.id, h);
  trakt.pushRatings(c.user.id, [{ ...it, value: h, updated: now() }]).catch(e => console.warn('[trakt] betyg:', e.message));
  send(c.res, 200, out(h));
});

const musicRow = (c, table, id) => { const r = get(`SELECT id, library_id FROM ${table} WHERE id=?`, id); if (!r || !libOk(c.user.id, r.library_id)) { fail(c.res, 404, 'Finns inte'); return null; } return r; };
for (const [kind, table, base] of [['album', 'albums', '/api/music/albums/:id/rating'], ['track', 'tracks', '/api/music/tracks/:id/rating']]) {
  route('GET', base, user, (c) => { const r = musicRow(c, table, +c.p.id); if (r) send(c.res, 200, out(ratings.getOne(c.user.id, kind, r.id))); });
  route('PUT', base, user, async (c) => {
    const r = musicRow(c, table, +c.p.id); if (!r) return;
    const h = await readStars(c); if (h == null) return;
    ratings.set(c.user.id, kind, r.id, h);
    listen.clearSmartCache(); // smarta listor med "Mitt betyg"
    send(c.res, 200, out(h));
  });
}
