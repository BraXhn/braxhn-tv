// Familjefilter: profilens läge, scener att hoppa över per titel och administratörens ordlistor (server/familyfilter.js).
// Planen till spelaren (tysta intervall, scener) levereras i /api/items/:id/playback (routes/playback.js).
import { get } from '../db.js';
import { send, fail, readJson } from '../util.js';
import { route, user, admin } from '../http/router.js';
import { allowedFor } from '../http/context.js';
import * as family from '../familyfilter.js';
import { WORDS } from '../familywords.js';

const LABEL = { off: 'Av', mute: 'Tysta svordomar', skip: 'Tysta svordomar och hoppa över markerade scener' };
const meOut = (uid) => {
  const u = get('SELECT id, max_age, family_filter FROM users WHERE id=?', uid);
  return { mode: family.modeFor(u), setting: family.settingOf(u), kid: u.max_age != null, canChange: u.max_age == null,
    kidsDefault: family.kidsDefault(), labels: LABEL };
};
route('GET', '/api/me/family-filter', user, (c) => send(c.res, 200, meOut(c.user.id)));
route('PUT', '/api/me/family-filter', user, async (c) => {
  // Barnprofilens läge bestäms av huvudkontot (Profiler i hushållet) eller administratörens standard
  if (c.user.max_age != null) return fail(c.res, 403, 'Familjefiltret för barnprofiler ändras av huvudkontot');
  const { mode } = await readJson(c.req);
  try { family.setMode(c.user.id, mode ?? ''); } catch (e) { return fail(c.res, 400, e.message); }
  send(c.res, 200, meOut(c.user.id));
});

// ---------- scener att hoppa över ----------
const fileOf = (c) => {
  const it = get(`SELECT * FROM items WHERE id=? AND kind IN ('movie','episode') AND path IS NOT NULL`, +c.p.id);
  if (!it || !allowedFor(c.user.id, it)) { fail(c.res, 404, 'Finns inte'); return null; }
  return it;
};
route('GET', '/api/items/:id/skips', user, (c) => {
  const it = fileOf(c); if (!it) return;
  send(c.res, 200, { skips: family.skipsFor(it.id, c.user.id), canAdd: c.user.max_age == null, canShareAll: !!c.user.is_admin, mode: family.modeFor(c.user.id) });
});
route('POST', '/api/items/:id/skips', user, async (c) => {
  const it = fileOf(c); if (!it) return;
  const b = await readJson(c.req);
  if (it.duration && +b?.start >= it.duration) return fail(c.res, 400, 'Scenen börjar efter filmens slut');
  try { const id = family.addSkip(it.id, c.user.id, { ...b, end: it.duration ? Math.min(+b?.end, it.duration) : b?.end }); send(c.res, 200, { ok: true, id, skips: family.skipsFor(it.id, c.user.id) }); }
  catch (e) { fail(c.res, e.status || 400, e.message); }
});
route('DELETE', '/api/skips/:sid', user, (c) => {
  const r = family.removeSkip(+c.p.sid, c.user.id);
  if (r === null) return fail(c.res, 404, 'Finns inte');
  if (r === false) return fail(c.res, 403, 'Du kan inte ta bort den här markeringen');
  send(c.res, 200, { ok: true });
});

// ---------- administratören: ordlistor och standard för barnprofiler ----------
const adminOut = () => ({ builtin: WORDS, custom: family.customWords(), kidsDefault: family.kidsDefault(), labels: LABEL });
route('GET', '/api/admin/family-filter', admin, (c) => send(c.res, 200, adminOut()));
route('PUT', '/api/admin/family-filter', admin, async (c) => {
  const b = await readJson(c.req);
  if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(c.res, 400, 'Ogiltiga val');
  try {
    if (b.kidsDefault !== undefined) family.setKidsDefault(b.kidsDefault);
    if (b.sv !== undefined || b.en !== undefined || b.off !== undefined) family.setCustomWords({ sv: b.sv, en: b.en, off: b.off });
  } catch (e) { return fail(c.res, 400, e.message); }
  send(c.res, 200, adminOut());
});
// Prova en text mot listorna (administrationens provruta)
route('POST', '/api/admin/family-filter/test', admin, async (c) => {
  const { text, lang } = await readJson(c.req);
  const t = String(text || '').slice(0, 2000);
  send(c.res, 200, { masked: family.maskText(t, lang || null), hit: family.hasProfanity(t, lang || null) });
});
