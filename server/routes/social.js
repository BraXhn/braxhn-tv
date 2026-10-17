// Titta tillsammans, skärmtid, följda serier, "Nytt för dig", personliga notiser och offline-synk.
import { get, all } from '../db.js';
import { readJson, fail, send } from '../util.js';
import { audit } from '../auth.js';
import * as st from '../stream.js';
import * as act from '../activity.js';
import * as party from '../party.js';
import * as screen from '../screentime.js';
import * as follows from '../follows.js';
import { route, user, adminAnywhere, isTrusted } from '../http/router.js';
import { allowedFor, ctx, householdRoot, canManage, listItems, itemsByIds } from '../http/context.js';

// ---------- Titta tillsammans ----------
route('POST', '/api/party', user, async (c) => {
  const { itemId } = await readJson(c.req);
  const it = get(`SELECT * FROM items WHERE id=? AND kind != 'show'`, +itemId);
  if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  const id = party.createRoom(c.user, it.id);
  audit('party_created', { ...ctx(c), detail: it.title });
  send(c.res, 200, { id });
});
const roomFor = (c) => {
  const r = party.getRoom(c.p.rid);
  if (!r) { fail(c.res, 404, 'Rummet finns inte längre'); return null; }
  const it = get('SELECT * FROM items WHERE id=?', r.itemId);
  if (!allowedFor(c.user.id, it)) { fail(c.res, 403, 'Inte tillgänglig i den här profilen'); return null; }
  return r;
};
route('GET', '/api/party/:rid', user, (c) => { const r = roomFor(c); if (r) send(c.res, 200, party.roomInfo(r)); });
route('GET', '/api/party/:rid/events', user, (c) => { const r = roomFor(c); if (r) party.subscribe(r, c.user, c.req, c.res); });
route('POST', '/api/party/:rid/state', user, async (c) => {
  const r = roomFor(c); if (!r) return;
  const b = await readJson(c.req);
  if (b.itemId) { const it = get(`SELECT * FROM items WHERE id=? AND kind != 'show'`, +b.itemId); if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte'); }
  party.setState(r, c.user, b);
  send(c.res, 200, { ok: true });
});
route('POST', '/api/party/:rid/chat', user, async (c) => { const r = roomFor(c); if (!r) return; party.chat(r, c.user, (await readJson(c.req)).text); send(c.res, 200, { ok: true }); });
route('DELETE', '/api/party/:rid', user, (c) => {
  const r = party.getRoom(c.p.rid);
  if (r && (r.host === c.user.id || c.user.is_admin)) party.closeRoom(r.id);
  send(c.res, 200, { ok: true });
});
// ---------- Skärmtid, följda serier och automatisk offline-synk ----------
// Stoppa pågående omkodningar när tiden tar slut (övriga förfrågningar nekas av screenBlock)
function stopScreenStreams(uid) { for (const a of act.listActive()) if (a.userId === uid) st.stopUserSessions(a.itemId, uid); }
screen.setOnBlocked((uid) => stopScreenStreams(uid));
// Även utan rapporter (t.ex. när tillåten tid tar slut) – kollas var 30:e sekund för den som tittar
setInterval(() => {
  for (const uid of new Set(act.listActive().map(a => a.userId))) if (screen.check(uid)) stopScreenStreams(uid);
}, 30e3).unref();
/** Målprofil vars skärmtid den inloggade får styra: profiler i det egna hushållet (huvudkontot) eller,
 *  för administratörer på betrott nät, andra konton som inte är administratörer. Aldrig sin egen. */
function screenTarget(c) {
  const t = get('SELECT id, name, parent_id, is_admin FROM users WHERE id=?', +c.p.uid);
  if (!t) { fail(c.res, 404, 'Finns inte'); return null; }
  if (t.id === c.user.id) { fail(c.res, 403, 'Du kan inte ändra skärmtiden för din egen profil'); return null; }
  const me = get('SELECT * FROM users WHERE id=?', c.user.id), root = householdRoot(me);
  if (t.parent_id === root && canManage(c, root)) return t;
  if (c.user.is_admin && !t.is_admin && (adminAnywhere() || isTrusted(c.req))) return t;
  fail(c.res, 403, 'Bara huvudkontot eller en administratör kan ändra skärmtiden'); return null;
}
route('GET', '/api/screentime', user, (c) => send(c.res, 200, screen.status(c.user.id) || { limited: false }));
route('GET', '/api/screentime/:uid', user, (c) => {
  const t = screenTarget(c); if (!t) return;
  send(c.res, 200, { id: t.id, name: t.name, rules: screen.rulesFor(t.id), status: screen.status(t.id) });
});
route('PUT', '/api/screentime/:uid', user, async (c) => {
  const t = screenTarget(c); if (!t) return;
  const rules = screen.setRules(t.id, await readJson(c.req));
  audit('screentime_changed', { ...ctx(c), detail: `${t.name}: ${rules ? JSON.stringify(rules) : 'ingen gräns'}` });
  send(c.res, 200, { rules, status: screen.status(t.id) });
});
route('POST', '/api/screentime/:uid/extra', user, async (c) => {
  const t = screenTarget(c); if (!t) return;
  const { minutes, reset } = await readJson(c.req);
  if (reset) screen.resetToday(t.id);
  const m = Math.max(-240, Math.min(240, parseInt(minutes) || 0));
  if (m) screen.addExtra(t.id, m);
  audit('screentime_extra', { ...ctx(c), detail: `${t.name}: ${reset ? 'nollställd, ' : ''}${m >= 0 ? '+' : ''}${m} min` });
  send(c.res, 200, { status: screen.status(t.id) });
});
// Tittande som inte annars rapporteras (t.ex. inspelningar i webben)
route('POST', '/api/screentime/ping', user, async (c) => {
  const { key, position } = await readJson(c.req);
  const k = /^[a-z]:\d{1,12}$/.test(String(key || '')) ? String(key) : 'x:0';
  const s = screen.heartbeat(c.user.id, k, position == null ? null : +position);
  send(c.res, 200, s ? { stop: !s.allowed, screenTime: s } : { stop: false });
});

// Följda serier och "Nytt för dig"
route('GET', '/api/follows', user, (c) => {
  const items = listItems(c.user.id, 'i.id IN (SELECT show_id FROM follows WHERE user_id=p_uid.uid AND active=1)', [], 'i.sort_title', 500, 0, { slim: true });
  const sync = new Map(all('SELECT show_id, sync FROM follows WHERE user_id=? AND active=1', c.user.id).map(r => [r.show_id, r.sync]));
  send(c.res, 200, items.map(i => ({ ...i, sync: sync.get(i.id) ?? null })));
});
route('POST', '/api/items/:id/follow', user, async (c) => {
  const it = get('SELECT id, kind, parent_id, age FROM items WHERE id=?', +c.p.id);
  if (!it || it.kind === 'movie' || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  const b = await readJson(c.req);
  const sid = follows.follow(c.user.id, it.id, b.follow !== false);
  if (b.sync !== undefined) follows.setShowSync(c.user.id, sid, b.sync);
  send(c.res, 200, follows.followInfo(c.user.id, sid));
});
route('GET', '/api/foryou', user, (c) => send(c.res, 200, listItems(c.user.id, follows.FOR_YOU_WHERE, [], follows.FOR_YOU_ORDER, 100)));
route('POST', '/api/foryou/seen', user, async (c) => { const { ids } = await readJson(c.req); follows.markSeen(c.user.id, Array.isArray(ids) ? ids : null); send(c.res, 200, { ok: true }); });
// Personlig notisadress (ntfy/webhook). Adressen kontrolleras vid varje utskick (inga lokala adresser).
const noKidNotify = (c) => { if (c.user.max_age != null) { fail(c.res, 403, 'Inte tillgängligt i barnprofiler'); return true; } return false; };
route('GET', '/api/me/notify', user, (c) => send(c.res, 200, { ...follows.getPersonal(c.user.id), allowed: c.user.max_age == null }));
route('PUT', '/api/me/notify', user, async (c) => {
  if (noKidNotify(c)) return;
  const b = await readJson(c.req);
  send(c.res, 200, follows.setPersonal(c.user.id, { kind: b.kind, url: b.url, token: b.token }));
});
route('POST', '/api/me/notify/test', user, async (c) => {
  if (noKidNotify(c)) return;
  try { await follows.testPersonal(c.user.id); send(c.res, 200, { ok: true }); }
  catch (e) { fail(c.res, e.status || 502, e.status ? e.message : 'Kunde inte skicka: ' + e.message); }
});
// Automatisk offline-synk i apparna
route('GET', '/api/me/offline-sync', user, (c) => send(c.res, 200, follows.getSync(c.user.id)));
route('PUT', '/api/me/offline-sync', user, async (c) => send(c.res, 200, follows.setSync(c.user.id, await readJson(c.req))));
route('GET', '/api/offline/sync', user, (c) => {
  const have = String(c.q.get('have') || '').split(',').filter(Boolean).slice(0, 500);
  const { ids, ...plan } = follows.syncPlan(c.user.id, have);
  send(c.res, 200, { ...plan, items: itemsByIds(c.user.id, ids) }); // itemsByIds tillämpar profilens åldersgräns
});
