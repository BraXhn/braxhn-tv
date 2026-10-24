// Tittarhistorik och statistik (playstats.js) samt webhooks för händelser (webhooks.js).
//   /api/history*            – Min historik: bara de egna raderna, för alla profiler (även barnprofiler)
//   /api/playstats*          – administratörens statistik över alla profiler (betrott nät)
//   /api/webhooks*           – profilens egna webhooks (inte barnprofiler, aldrig lokala adresser)
//   /api/admin/webhooks*     – serverns webhooks (alla händelser, lokala adresser kan tillåtas uttryckligen)
import { setSetting } from '../db.js';
import { send, fail, readJson } from '../util.js';
import { audit } from '../auth.js';
import * as ps from '../playstats.js';
import * as wh from '../webhooks.js';
import { route, user, admin } from '../http/router.js';
import { ctx } from '../http/context.js';

const sendCsv = (c, name, body) => {
  c.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  c.res.end(body);
};
const stamp = () => new Date().toISOString().slice(0, 10);
const page = (c) => ({ limit: c.q.get('limit'), offset: c.q.get('offset'), sort: c.q.get('sort'), dir: c.q.get('dir') });

// ---------- Min historik ----------
route('GET', '/api/history', user, (c) => send(c.res, 200, { ...ps.history(ps.filters(c.q, c.user), page(c)), canDelete: c.user.max_age == null }));
route('GET', '/api/history.csv', user, (c) => sendCsv(c, `min-historik-${stamp()}.csv`, ps.csv(ps.filters(c.q, c.user))));
route('DELETE', '/api/history/:hid', user, (c) => {
  // Barnprofiler kan inte sudda ut sin historik (föräldern ser den i statistiken)
  if (c.user.max_age != null) return fail(c.res, 403, 'Inte tillgängligt i barnprofiler');
  if (!ps.removeRow(c.p.hid, c.user)) return fail(c.res, 404, 'Finns inte');
  send(c.res, 200, { ok: true });
});

// ---------- Statistik (administratör) ----------
const opts = { everyone: true };
route('GET', '/api/playstats', admin, (c) => {
  const f = ps.filters(c.q, c.user, opts);
  send(c.res, 200, { ...ps.overview(f), concurrency: ps.concurrency(f), historyDays: ps.keepDays() });
});
route('GET', '/api/playstats/history', admin, (c) => send(c.res, 200, ps.history(ps.filters(c.q, c.user, opts), page(c))));
route('GET', '/api/playstats/history.csv', admin, (c) => sendCsv(c, `tittarhistorik-${stamp()}.csv`, ps.csv(ps.filters(c.q, c.user, opts))));
route('DELETE', '/api/playstats/history/:hid', admin, (c) => {
  if (!ps.removeRow(c.p.hid, c.user, true)) return fail(c.res, 404, 'Finns inte');
  send(c.res, 200, { ok: true });
});
route('PUT', '/api/playstats/settings', admin, async (c) => {
  const b = await readJson(c.req);
  const d = parseInt(b.historyDays);
  if (!(d >= 0 && d <= 3650)) return fail(c.res, 400, 'Ange antal dagar (0–3650, 0 = för alltid)');
  setSetting('history_days', String(d));
  audit('settings_changed', { ...ctx(c), detail: 'history_days' });
  send(c.res, 200, { historyDays: ps.keepDays(), removed: ps.prune() });
});

// ---------- Webhooks ----------
const meta = (owner) => ({ events: Object.fromEntries(Object.entries(wh.EVENTS).filter(([k]) => owner == null || wh.USER_EVENTS.includes(k))), formats: wh.FORMATS });
const noKids = (c) => { if (c.user.max_age != null) { fail(c.res, 403, 'Inte tillgängligt i barnprofiler'); return true; } return false; };
function hookRoutes(base, opt, ownerOf, guard = () => false) {
  route('GET', base, opt, (c) => { if (guard(c)) return; const o = ownerOf(c); send(c.res, 200, { hooks: wh.list(o), log: wh.log(o), ...meta(o) }); });
  route('POST', base, opt, async (c) => {
    if (guard(c)) return;
    try { const h = wh.create(ownerOf(c), await readJson(c.req)); audit('webhook_created', { ...ctx(c), detail: h.name }); send(c.res, 200, h); }
    catch (e) { fail(c.res, e.status || 500, e.message); }
  });
  route('PUT', `${base}/:wid`, opt, async (c) => {
    if (guard(c)) return;
    try { const h = wh.update(ownerOf(c), c.p.wid, await readJson(c.req)); if (!h) return fail(c.res, 404, 'Finns inte'); send(c.res, 200, h); }
    catch (e) { fail(c.res, e.status || 500, e.message); }
  });
  route('DELETE', `${base}/:wid`, opt, (c) => { if (guard(c)) return; if (!wh.remove(ownerOf(c), c.p.wid)) return fail(c.res, 404, 'Finns inte'); audit('webhook_removed', { ...ctx(c), detail: c.p.wid }); send(c.res, 200, { ok: true }); });
  route('POST', `${base}/:wid/test`, opt, async (c) => {
    if (guard(c)) return;
    const r = await wh.test(ownerOf(c), c.p.wid);
    if (!r) return fail(c.res, 404, 'Finns inte');
    send(c.res, 200, r);
  });
  route('POST', `${base}/:wid/secret`, opt, (c) => { if (guard(c)) return; const r = wh.rotateSecret(ownerOf(c), c.p.wid); if (!r) return fail(c.res, 404, 'Finns inte'); send(c.res, 200, r); });
  route('GET', `${base}/:wid/log`, opt, (c) => { if (guard(c)) return; if (!wh.find(ownerOf(c), c.p.wid)) return fail(c.res, 404, 'Finns inte'); send(c.res, 200, wh.log(ownerOf(c), c.p.wid, 100)); });
}
hookRoutes('/api/admin/webhooks', admin, () => null);
hookRoutes('/api/webhooks', user, (c) => c.user.id, noKids);
