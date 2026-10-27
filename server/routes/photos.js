// Fotobibliotek: tidslinje, månader, album (mappar), "Den här dagen", information, bilder, original och favoriter.
// Behörigheten (biblioteksbehörighet + barnprofiler, canSeeLib i photos.js) kontrolleras på varje route; ett foto
// som inte får visas svarar som ett okänt foto (404).
import fs from 'node:fs';
import path from 'node:path';
import { get } from '../db.js';
import { send, fail, readJson, streamFile } from '../util.js';
import * as ph from '../photos.js';
import { snapWidth, PHOTO_SIZES } from '../imgsize.js';
import { route, user, img } from '../http/router.js';
import { canDownload } from '../http/context.js';

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heif', '.hif': 'image/heif', '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.3gp': 'video/3gpp' };
/** Fotobiblioteket i :lib om användaren får se det, annars 404 */
function photoLib(c) {
  const l = get("SELECT * FROM libraries WHERE id=? AND type='photo'", +c.p.lib || 0);
  if (!ph.canSeeLib(c.user.id, l)) { fail(c.res, 404, 'Inget fotobibliotek'); return null; }
  return l;
}
function photoOf(c) {
  const r = ph.photoFor(c.user.id, c.p.id);
  if (!r) fail(c.res, 404, 'Fotot finns inte');
  return r;
}
/** ?folder= relativt biblioteket: '/' mellan mapparna, aldrig '..' eller styrtecken */
function folderParam(v) {
  const f = String(v || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').slice(0, 1000);
  return f.split('/').some(p => p === '..' || p === '.') || /[\u0000-\u001f]/.test(f) ? null : f;
}
const lib = (l) => ({ id: l.id, name: l.name, kids: l.kids === 1 });

route('GET', '/api/photos/libraries', user, (c) => send(c.res, 200, ph.photoLibs(c.user.id).map(l => ({ ...lib(l), count: ph.countOf(l.id) }))));
// Den här dagen: ?date=YYYY-MM-DD (standard i dag, serverns tidszon)
route('GET', '/api/photos/memories', user, (c) => {
  const d = c.q.get('date') || ph.today();
  if (!/^\d{4}-\d\d-\d\d$/.test(d)) return fail(c.res, 400, 'Ogiltigt datum');
  send(c.res, 200, { date: d, groups: ph.memories(c.user.id, d, { withPhotos: true }) });
});
route('GET', '/api/photos/lib/:lib/timeline', user, (c) => {
  const l = photoLib(c); if (!l) return;
  send(c.res, 200, { library: lib(l), ...ph.timeline(l, c.user.id, { fav: c.q.get('fav') === '1' }) });
});
route('GET', '/api/photos/lib/:lib/month/:ym', user, (c) => {
  const l = photoLib(c); if (!l) return;
  if (!/^\d{4}-\d\d$/.test(c.p.ym)) return fail(c.res, 400, 'Ogiltig månad');
  send(c.res, 200, { month: c.p.ym, photos: ph.month(l, c.user.id, c.p.ym, { fav: c.q.get('fav') === '1' }) });
});
route('GET', '/api/photos/lib/:lib/albums', user, (c) => {
  const l = photoLib(c); if (!l) return;
  const f = folderParam(c.q.get('folder'));
  if (f == null) return fail(c.res, 400, 'Ogiltig mapp');
  send(c.res, 200, { library: lib(l), ...ph.album(l, c.user.id, f) });
});
route('GET', '/api/photos/:id', user, (c) => {
  const r = photoOf(c); if (!r) return;
  send(c.res, 200, { ...ph.info(r, c.user.id), canDownload: canDownload(c.user.id) });
});
// Bilden i bredden ?w= (fasta bredder upp till 2560, EXIF-orienteringen tillämpad); utan w originalet när webbläsaren kan visa det
route('GET', '/api/photos/:id/img', img, async (c) => {
  const r = photoOf(c); if (!r) return;
  const w = c.q.has('w') ? snapWidth(c.q.get('w'), PHOTO_SIZES) ?? PHOTO_SIZES.at(-1) : null;
  const f = await ph.imageFile(r, w);
  if (!f) return fail(c.res, 415, 'Bilden kan inte visas (formatet stöds inte av ffmpeg i den här installationen)');
  let st; try { st = await fs.promises.stat(f); } catch { return fail(c.res, 404, 'Fotot finns inte'); }
  streamFile(c.req, c.res, f, st.size, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'image/jpeg', 'Cache-Control': 'private, max-age=604800' });
});
// Originalfilen som nedladdning – kräver rättigheten att ladda ner (perms.js)
route('GET', '/api/photos/:id/original', user, async (c) => {
  const r = photoOf(c); if (!r) return;
  if (!canDownload(c.user.id)) return fail(c.res, 403, 'Ditt konto får inte ladda ner');
  let st; try { st = await fs.promises.stat(r.path); } catch { return fail(c.res, 404, 'Filen finns inte längre'); }
  const ascii = r.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  streamFile(c.req, c.res, r.path, st.size, { 'Content-Type': MIME[path.extname(r.path).toLowerCase()] || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.name)}`, 'Cache-Control': 'private, no-store' });
});
route('POST', '/api/photos/:id/favorite', user, async (c) => {
  const r = photoOf(c); if (!r) return;
  const b = await readJson(c.req);
  send(c.res, 200, { fav: ph.setFavorite(c.user.id, r.id, b.on !== false) });
});
