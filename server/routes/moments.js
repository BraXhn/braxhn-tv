// Ögonblick (server/moments.js): klipp som hushållet sparar ur spelaren, flödet med reaktioner och kommentarer och
// externa länkar. Behörighet: både den som skapar och den som ser måste få se titeln (allowedFor – åldersgräns och
// bibliotek), ögonblicken syns bara inom hushållet (huvudkontot och dess profiler), barnprofiler kan inte dela utanför
// hemmet och familjefiltret gäller i klippen (se moments.js). Ett okänt eller otillåtet ögonblick ger 404.
// De delade länkarna (/api/share/*) har routealternativet share: routern sätter aldrig c.user där och länken gäller
// inget annat än klippet, miniatyren och sidan med Open Graph.
import fs from 'node:fs';
import { get } from '../db.js';
import { send, fail, readJson, streamFile } from '../util.js';
import { audit } from '../auth.js';
import * as M from '../moments.js';
import { originOf } from '../bookfeeds.js';
import { route, user, share, pageLang } from '../http/router.js';
import { allowedFor, canDownload, ctx, screenBlock } from '../http/context.js';

M.init();
const allowed = (c) => (it) => allowedFor(c.user.id, it);
const momentFor = (c) => {
  const m = /^\d+$/.test(c.p.mid) ? M.visibleTo(c.user.id, +c.p.mid, allowed(c)) : null;
  if (!m) fail(c.res, 404, 'Finns inte');
  return m;
};
const outFor = (c, m, full = false) => M.out(c.user, m, { canDl: canDownload(c.user.id), full });
const storage = () => ({ used: M.used(), max: M.maxBytes() });

// Nytt ögonblick ur en titel: { start, end, title, sub?, audio?, watermark? } → 202 med raden (state pending)
route('POST', '/api/items/:id/moments', user, async (c) => {
  const b = await readJson(c.req, 16 << 10) || {};
  const it = get(`SELECT * FROM items WHERE id=? AND kind IN ('movie','episode') AND path IS NOT NULL`, +c.p.id);
  if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  if (screenBlock(c)) return;
  const m = M.create(c.user, it, b);
  audit('moment_created', { ...ctx(c), detail: `${m.title} (${m.source})` });
  send(c.res, 202, outFor(c, m));
});

// Hushållets flöde, nyast först (?before=<id> för fler, ?item=<id> för en titel)
route('GET', '/api/moments', user, (c) => {
  const before = /^\d+$/.test(c.q.get('before') || '') ? +c.q.get('before') : null;
  const item = /^\d+$/.test(c.q.get('item') || '') ? +c.q.get('item') : null;
  const rows = M.feed(c.user.id, allowed(c), { before, item, limit: 30 });
  send(c.res, 200, { moments: rows.map(m => outFor(c, m)), more: rows.length === 30, storage: storage(), maxLength: M.MAX_LEN, emoji: M.EMOJI, shareHours: M.SHARE_HOURS,
    canShare: c.user.max_age == null && canDownload(c.user.id) });
});
route('GET', '/api/moments/:mid', user, (c) => { const m = momentFor(c); if (m) send(c.res, 200, outFor(c, m, true)); });
route('DELETE', '/api/moments/:mid', user, (c) => {
  const m = momentFor(c); if (!m) return;
  if (!M.canDeleteMoment(c.user, m)) return fail(c.res, 403, 'Bara den som sparade ögonblicket kan ta bort det');
  M.remove(m.id);
  send(c.res, 200, { ok: true, storage: storage() });
});

// Klippet och miniatyren (kakan räcker för <video>/<img>; Range för spolning)
route('GET', '/api/moments/:mid/video', user, (c) => {
  const m = momentFor(c); if (!m) return;
  if (m.state !== 1) return fail(c.res, 409, 'Ögonblicket är inte klart än');
  const f = M.videoFileFor(c.user.id, m);
  let st; try { st = fs.statSync(f); } catch { return fail(c.res, 404, 'Finns inte'); }
  streamFile(c.req, c.res, f, st.size, { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': `inline; filename="ogonblick-${m.id}.mp4"` });
});
route('GET', '/api/moments/:mid/thumb', user, (c) => {
  const m = momentFor(c); if (!m) return;
  let st; try { st = fs.statSync(M.fileOf(m.id, 'jpg')); } catch { return fail(c.res, 404, 'Ingen miniatyr'); }
  streamFile(c.req, c.res, M.fileOf(m.id, 'jpg'), st.size, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }, { ranges: false });
});

// Reaktioner (av/på) och kommentarer
route('POST', '/api/moments/:mid/reactions', user, async (c) => {
  const m = momentFor(c); if (!m) return;
  const b = await readJson(c.req, 4 << 10) || {};
  M.react(c.user.id, m.id, String(b.emoji || ''));
  send(c.res, 200, outFor(c, m));
});
route('POST', '/api/moments/:mid/comments', user, async (c) => {
  const m = momentFor(c); if (!m) return;
  const b = await readJson(c.req, 8 << 10) || {};
  M.comment(c.user.id, m.id, b.text);
  send(c.res, 200, outFor(c, m, true));
});
route('DELETE', '/api/moments/:mid/comments/:cid', user, (c) => {
  const m = momentFor(c); if (!m) return;
  const k = get('SELECT * FROM moment_comments WHERE id=? AND moment_id=?', +c.p.cid, m.id);
  if (!k) return fail(c.res, 404, 'Finns inte');
  if (k.user_id !== c.user.id && !M.canDeleteMoment(c.user, m)) return fail(c.res, 403, 'Du kan bara ta bort dina egna kommentarer');
  M.deleteComment(k.id);
  send(c.res, 200, outFor(c, m, true));
});

// Externa länkar: { hours } → { id, url, expires } (adressen visas bara nu); återkalla med DELETE
route('POST', '/api/moments/:mid/shares', user, async (c) => {
  const m = momentFor(c); if (!m) return;
  if (c.user.max_age != null) return fail(c.res, 403, 'Barnprofiler kan inte dela utanför hemmet');
  if (!canDownload(c.user.id)) return fail(c.res, 403, 'Ditt konto får inte dela klipp utanför hemmet');
  if (!M.canShare(c.user, m, true)) return fail(c.res, 403, 'Bara den som sparade ögonblicket kan dela det utanför hemmet');
  if (m.state !== 1) return fail(c.res, 409, 'Ögonblicket är inte klart än');
  const b = await readJson(c.req, 4 << 10) || {};
  const s = M.share(c.user.id, m, +b.hours);
  audit('moment_shared', { ...ctx(c), detail: `${m.title} (${b.hours} h)` });
  send(c.res, 200, { id: s.id, expires: s.expires, url: `${originOf(c.req)}/api/share/${s.token}`, path: `/api/share/${s.token}` });
});
route('DELETE', '/api/moments/:mid/shares/:sid', user, (c) => {
  const m = momentFor(c); if (!m) return;
  if (!M.canShare(c.user, m, true) && !c.user.is_admin) return fail(c.res, 403, 'Bara den som delade kan återkalla länken');
  if (!M.revoke(m.id, +c.p.sid)) return fail(c.res, 404, 'Finns inte');
  audit('moment_unshared', { ...ctx(c), detail: m.title });
  send(c.res, 200, outFor(c, m, true));
});

// ---------- /api/share/* (routealternativet share – ingen inloggning, bara länken) ----------
const SHARE_HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function shareOf(c, html = false) {
  const r = M.resolveShare(c.p.token);
  if (r?.m) return r;
  if (html) send(c.res, r ? 410 : 404, M.goneHtml(pageLang(c.req)), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, ...SHARE_HEADERS });
  else fail(c.res, r ? 410 : 404, r ? 'Länken gäller inte längre' : 'Finns inte');
  return null;
}
route('GET', '/api/share/:token', share, (c) => {
  const r = shareOf(c, true); if (!r) return;
  M.countView(r.s.id);
  send(c.res, 200, M.sharePage(r.m, c.p.token, originOf(c.req), pageLang(c.req)), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, ...SHARE_HEADERS });
});
route('GET', '/api/share/:token/clip\\.mp4', share, (c) => {
  const r = shareOf(c); if (!r) return;
  const f = M.fileOf(r.m.id);
  let st; try { st = fs.statSync(f); } catch { return fail(c.res, 404, 'Finns inte'); }
  streamFile(c.req, c.res, f, st.size, { 'Content-Type': 'video/mp4', ...SHARE_HEADERS });
});
route('GET', '/api/share/:token/thumb\\.jpg', share, (c) => {
  const r = shareOf(c); if (!r) return;
  const f = M.fileOf(r.m.id, 'jpg');
  let st; try { st = fs.statSync(f); } catch { return fail(c.res, 404, 'Finns inte'); }
  streamFile(c.req, c.res, f, st.size, { 'Content-Type': 'image/jpeg', ...SHARE_HEADERS }, { ranges: false });
});
