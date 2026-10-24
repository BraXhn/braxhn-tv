// Egna samlingar (filmer och serier): skapa, ändra, ta bort, lägga till/ta bort titlar och manuell ordning.
// Logiken och synlighetsreglerna finns i server/customcollections.js. TMDB-samlingarna (/api/collections) är oförändrade.
//
// Behörighet: alla inloggade får skapa privata samlingar (syns bara för dem själva). Delade samlingar skapas och
// ändras bara av administratörer på betrott nät (samma krav som admin-routes, se http/router.js).
import { send, readJson, fail } from '../util.js';
import { audit } from '../auth.js';
import { route, user, adminAnywhere, isTrusted } from '../http/router.js';
import { allowedFor, ctx } from '../http/context.js';
import * as cc from '../customcollections.js';

const adminHere = (c) => !!c.user.is_admin && (adminAnywhere() || isTrusted(c.req));
/** Samlingen om användaren får ändra den, annars svarar routen 404/403 och returnerar null */
function editable(c) {
  const col = cc.get1(+c.p.cid);
  if (!col || (col.shared !== 1 && col.owner_id !== c.user.id)) { fail(c.res, 404, 'Samlingen finns inte'); return null; }
  if (!cc.canEdit(c.user, col, adminHere(c))) { fail(c.res, 403, 'Bara administratörer kan ändra delade samlingar (från hemnätverket)'); return null; }
  return col;
}
const intOrNull = (v) => { const n = parseInt(v); return n > 0 ? n : null; };

// ?item= markerar om titeln ligger i varje samling (has), ?editable=1 bara de man får ändra, ?library= bara med titlar därifrån
route('GET', '/api/custom-collections', user, (c) => {
  const item = intOrNull(c.q.get('item'));
  const t = item ? cc.targetOf(item) : null;
  send(c.res, 200, cc.listFor(c.user, { adminHere: adminHere(c), item: t?.id ?? null, library: intOrNull(c.q.get('library')), editable: c.q.get('editable') === '1' }));
});
route('POST', '/api/custom-collections', user, async (c) => {
  const b = await readJson(c.req);
  if (!String(b.name || '').trim()) return fail(c.res, 400, 'Samlingen behöver ett namn');
  const shared = !!b.shared;
  if (shared && !adminHere(c)) return fail(c.res, 403, 'Bara administratörer kan skapa delade samlingar (från hemnätverket)');
  if (cc.countOwned(c.user.id) >= cc.MAX_PER_USER) return fail(c.res, 400, `Högst ${cc.MAX_PER_USER} samlingar per profil`);
  // Valfri första titel (t.ex. "Ny samling…" från en titels meny)
  const t = b.item != null ? cc.targetOf(+b.item) : null;
  if (b.item != null && (!t || !allowedFor(c.user.id, t))) return fail(c.res, 404, 'Titeln finns inte');
  const id = cc.create(c.user, b, shared);
  if (t) cc.addItem(cc.get1(id), t.id);
  if (shared) audit('collection_created', { ...ctx(c), detail: String(b.name).trim().slice(0, 100) });
  send(c.res, 200, { ok: true, id });
});
route('GET', '/api/custom-collections/:cid', user, (c) => {
  const d = cc.detail(c.user, +c.p.cid, adminHere(c));
  d ? send(c.res, 200, d) : fail(c.res, 404, 'Samlingen finns inte');
});
route('PUT', '/api/custom-collections/:cid', user, async (c) => {
  const col = editable(c); if (!col) return;
  const b = await readJson(c.req);
  if (b.name !== undefined && !String(b.name || '').trim()) return fail(c.res, 400, 'Samlingen behöver ett namn');
  // Delad ↔ privat: bara administratörer (på betrott nät) får göra en samling delad
  const shared = b.shared === undefined ? col.shared === 1 : !!b.shared;
  if (shared && !adminHere(c)) return fail(c.res, 403, 'Bara administratörer kan dela samlingar');
  if (!shared && col.shared === 1 && col.owner_id !== c.user.id) return fail(c.res, 400, 'Bara den som skapade samlingen kan göra den privat');
  cc.update(col, b, shared);
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/custom-collections/:cid', user, (c) => {
  const col = editable(c); if (!col) return;
  cc.remove(col);
  if (col.shared === 1) audit('collection_removed', { ...ctx(c), detail: col.name });
  send(c.res, 200, { ok: true });
});
route('POST', '/api/custom-collections/:cid/items', user, async (c) => {
  const col = editable(c); if (!col) return;
  const { id } = await readJson(c.req);
  const t = cc.targetOf(+id);
  if (!t || !allowedFor(c.user.id, t)) return fail(c.res, 404, 'Titeln finns inte');
  if (!cc.addItem(col, t.id)) return fail(c.res, 400, 'Samlingen är full');
  send(c.res, 200, { ok: true, id: t.id });
});
route('DELETE', '/api/custom-collections/:cid/items/:id', user, (c) => {
  const col = editable(c); if (!col) return;
  const t = cc.targetOf(+c.p.id);
  cc.removeItem(col, t ? t.id : +c.p.id);
  send(c.res, 200, { ok: true });
});
// Manuell ordning: { ids: [titel-id i önskad ordning] } (titlar som inte skickas behåller sin ordning sist)
route('PUT', '/api/custom-collections/:cid/order', user, async (c) => {
  const col = editable(c); if (!col) return;
  const { ids } = await readJson(c.req);
  if (!Array.isArray(ids) || ids.length > 1000) return fail(c.res, 400, 'Ogiltig ordning');
  cc.reorder(col, ids);
  send(c.res, 200, { ok: true });
});
