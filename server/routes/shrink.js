// Diskrådgivaren (server/shrink.js) – bara administratör på betrott nät.
//   GET    /api/admin/shrink                    – analysen (?lib=&sort=size|gain|rate|seen&limit=&codec=&notSeenDays=), kön, inställningar, kodare
//   PUT    /api/admin/shrink/settings           – { codec, allowCpu, window, onlyIdle, paused, quality, minVmaf, minSsim, minPsnr, samples, trashDays, notSeenDays }
//   POST   /api/admin/shrink/queue              – { items: [id] } eller { rule: { library, codecs, minMbPerMin, notSeenDays, minGainPct }, preview }
//   POST   /api/admin/shrink/calibrate          – { item, codec } provkodning som kalibrerar uppskattningen
//   POST   /api/admin/shrink/run                – kör kön (och rensningen av papperskorgen) nu
//   POST   /api/admin/shrink/jobs/:id/cancel    – avbryt ett köat eller pågående jobb
//   POST   /api/admin/shrink/jobs/:id/restore   – ta tillbaka originalet ur papperskorgen
//   DELETE /api/admin/shrink/jobs/:id/trash     – töm papperskorgen för jobbet nu (originalet tas bort)
import { route, admin } from '../http/router.js';
import { ctx } from '../http/context.js';
import { send, fail, readJson } from '../util.js';
import { audit } from '../auth.js';
import * as arr from '../arr.js';
import * as shrink from '../shrink.js';

const state = () => {
  const s = shrink.settings();
  return { settings: s, encoders: shrink.encoderInfo(s), metric: shrink.metricName(), jobs: shrink.jobList(), trash: shrink.trashInfo(),
    state: shrink.state(), waitReason: shrink.waitReason(s), arr: { movie: arr.configured('movie'), show: arr.configured('show') } };
};

route('GET', '/api/admin/shrink', admin, (c) => {
  const q = (k) => c.q.get(k) || undefined;
  send(c.res, 200, { report: shrink.report({ lib: q('lib'), sort: q('sort'), limit: q('limit'), codec: q('codec'), notSeenDays: q('notSeenDays') }), ...state() });
});

route('PUT', '/api/admin/shrink/settings', admin, async (c) => {
  const b = await readJson(c.req);
  try { shrink.saveSettings(b || {}); } catch (e) { return fail(c.res, 400, e.message); }
  audit('shrink_settings', { ...ctx(c), detail: Object.keys(b || {}).join(', ') });
  send(c.res, 200, state());
});

route('POST', '/api/admin/shrink/queue', admin, async (c) => {
  const b = await readJson(c.req);
  const codec = shrink.CODECS.includes(b?.codec) ? b.codec : shrink.settings().codec;
  let ids;
  if (Array.isArray(b?.items)) ids = b.items.map(Number).filter(n => Number.isInteger(n) && n > 0);
  else if (b?.rule && typeof b.rule === 'object') {
    const r = b.rule, rule = { library: +r.library || null, codecs: Array.isArray(r.codecs) ? r.codecs.map(String).slice(0, 20) : [],
      minMbPerMin: Math.max(0, +r.minMbPerMin || 0), notSeenDays: Math.max(0, Math.round(+r.notSeenDays || 0)), minGainPct: Math.max(0, Math.min(95, +r.minGainPct || 0)) };
    const m = shrink.matchRule(rule);
    if (b.preview) return send(c.res, 200, { matches: m.length, saving: m.reduce((a, t) => a + (t.estimate.saving || 0), 0), titles: m.slice(0, 50).map(t => ({ id: t.id, kind: t.kind, title: t.title, year: t.year, show: t.show, season: t.season, episode: t.episode, size: t.size, saving: t.estimate.saving })) });
    ids = m.map(t => t.id);
  } else return fail(c.res, 400, 'Ange items eller rule');
  if (!ids.length) return send(c.res, 200, { queued: [], skipped: [] });
  try {
    const r = shrink.enqueue(ids, { codec, user: c.user.id, force: !!b.force });
    audit('shrink_queue', { ...ctx(c), detail: `${r.queued.length} titlar till ${codec}` });
    send(c.res, 200, r);
  } catch (e) { fail(c.res, e.code || 500, e.message); }
});

route('POST', '/api/admin/shrink/calibrate', admin, async (c) => {
  const b = await readJson(c.req);
  try { send(c.res, 200, await shrink.calibrate(+b?.item, shrink.CODECS.includes(b?.codec) ? b.codec : undefined)); }
  catch (e) { fail(c.res, /Ingen .*kodare/.test(e.message) ? 409 : /finns inte/.test(e.message) ? 404 : 500, e.message); }
});

route('POST', '/api/admin/shrink/run', admin, (c) => { shrink.kick(0); send(c.res, 200, { ok: true }); });

route('POST', '/api/admin/shrink/jobs/:id/cancel', admin, (c) => {
  const r = shrink.cancel(c.p.id);
  if (r === null) return fail(c.res, 404, 'Finns inte');
  if (r === false) return fail(c.res, 409, 'Jobbet är redan klart');
  send(c.res, 200, { ok: true, status: r });
});

route('POST', '/api/admin/shrink/jobs/:id/restore', admin, async (c) => {
  try { await shrink.restore(c.p.id); } catch (e) { return fail(c.res, e.code || 500, e.message); }
  audit('shrink_restore', { ...ctx(c), detail: String(c.p.id) });
  send(c.res, 200, { ok: true });
});

route('DELETE', '/api/admin/shrink/jobs/:id/trash', admin, (c) => {
  const n = shrink.purgeTrash(c.p.id);
  if (!n) return fail(c.res, 404, 'Inget i papperskorgen för jobbet');
  audit('shrink_trash', { ...ctx(c), detail: String(c.p.id) });
  send(c.res, 200, { ok: true });
});
