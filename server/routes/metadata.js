// Redigera metadata och bilder (administratör på betrott nät): fält med lås per fält, TMDB:s bilder, egen bild och
// återställning till automatiskt. Logiken ligger i server/itemmeta.js; låsen hålls av utlösaren i db.js.
import { get, run } from '../db.js';
import { send, readJson, fail } from '../util.js';
import { audit } from '../auth.js';
import { refreshItem, extractThumb, hasTmdb, scan } from '../scanner.js';
import * as meta from '../itemmeta.js';
import { route, admin } from '../http/router.js';
import { ctx, oneItem } from '../http/context.js';

/** Titeln som redigeras: en filmversion redigeras som filmen (huvudraden) */
function rowOf(c) {
  let row = get('SELECT * FROM items WHERE id=?', +c.p.id || 0);
  if (row?.version_of) row = get('SELECT * FROM items WHERE id=?', row.version_of) || row;
  if (!row) { fail(c.res, 404, 'Finns inte'); return null; }
  return row;
}
const typeOk = (c, row) => { if (meta.imageTypes(row).includes(c.p.type)) return true; fail(c.res, 404, 'Okänd bildtyp'); return false; };

route('GET', '/api/items/:id/metadata', admin, (c) => {
  const row = rowOf(c); if (!row) return;
  send(c.res, 200, meta.editable(row));
});
route('PUT', '/api/items/:id/metadata', admin, async (c) => {
  const row = rowOf(c); if (!row) return;
  const b = await readJson(c.req);
  const next = meta.save(row, { values: b.values || {}, locked: b.locked ?? null });
  const changed = Object.keys(b.values || {});
  audit('item_edited', { ...ctx(c), detail: `${row.title}${changed.length ? ': ' + changed.join(', ') : ''}` });
  send(c.res, 200, { ...meta.editable(next), item: oneItem(c.user.id, next.id) });
});

// Bilder: TMDB:s alternativ, välj ett, ladda upp egen, återställ
route('GET', '/api/items/:id/images/:type', admin, async (c) => {
  const row = rowOf(c); if (!row || !typeOk(c, row)) return;
  let options = [], error = null;
  try { options = await meta.tmdbImages(row, c.p.type); }
  catch (e) { if (e.status) throw e; error = 'TMDB: ' + e.message; }
  send(c.res, 200, { type: c.p.type, options, error, tmdb: hasTmdb(), current: meta.imagesOf(row)[c.p.type] });
});
route('POST', '/api/items/:id/images/:type', admin, async (c) => {
  const row = rowOf(c); if (!row || !typeOk(c, row)) return;
  const { tmdbPath } = await readJson(c.req);
  const images = await meta.chooseTmdb(row, c.p.type, tmdbPath);
  audit('item_image', { ...ctx(c), detail: `${row.title}: ${c.p.type} från TMDB` });
  send(c.res, 200, { images });
});
route('PUT', '/api/items/:id/images/:type', admin, async (c) => {
  const row = rowOf(c); if (!row || !typeOk(c, row)) return;
  const buf = await meta.readUpload(c.req);
  const images = await meta.storeImage(row, c.p.type, buf, 'upload');
  audit('item_image', { ...ctx(c), detail: `${row.title}: ${c.p.type} uppladdad` });
  send(c.res, 200, { images });
});
route('DELETE', '/api/items/:id/images/:type', admin, async (c) => {
  const row = rowOf(c); if (!row || !typeOk(c, row)) return;
  meta.resetImage(row, c.p.type);
  // Automatiskt igen: TMDB:s bild direkt (serien för ett avsnitt), en lokal fil bredvid videon vid skanningen
  const target = row.kind === 'episode' ? get('SELECT * FROM items WHERE id=?', row.parent_id) : get('SELECT * FROM items WHERE id=?', row.id);
  if (target && hasTmdb() && target.tmdb_id && !/^season/.test(c.p.type)) {
    try { await refreshItem(target, target.tmdb_id); } catch (e) { console.warn('[metadata] återställd bild:', e.message); }
  }
  const now = get('SELECT * FROM items WHERE id=?', row.id);
  if (c.p.type === 'thumb' && !now.thumb && now.path) { run('UPDATE items SET thumb=0 WHERE id=?', now.id); await extractThumb(now).catch(() => {}); }
  scan(row.library_id);
  audit('item_image', { ...ctx(c), detail: `${row.title}: ${c.p.type} automatisk` });
  send(c.res, 200, { images: meta.imagesOf(get('SELECT * FROM items WHERE id=?', row.id)) });
});
