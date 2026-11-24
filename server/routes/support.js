// Feedback och felrapporter (server/support.js):
//   POST /api/support/context          – förhandsvisning: den tekniska information som skulle bifogas ({ kind, context })
//   POST /api/support                  – nytt ärende ({ kind, area, text, title?, tech, context }) – alla inloggade
//   GET  /api/support                  – mina ärenden (bara egna, även för barnprofiler och administratörer)
//   GET  /api/support/count            – siffran vid knappen (egna ärenden som väntar på svar; admin: väntar på granskning)
//   GET  /api/support/:id              – ett eget ärende (någon annans: 404)
//   POST /api/support/:id/reply        – svar när teamet bett om mer information ({ text })
//   GET  /api/admin/support            – alla ärenden, det som väntar på granskning först (administratör, hemnätet)
//   PUT  /api/admin/support/:id        – ändra det som ska skickas ({ title?, text?, withContext? }) före godkännandet
//   POST /api/admin/support/:id/approve | reject – godkänn (skickas till teamet) eller avslå ({ note? })
//   POST /api/admin/support/:id/reply  – administratören svarar på teamets fråga ({ text })
//   POST /api/admin/support/:id/reply/approve | reject – granska en användares svar
//   DELETE /api/admin/support/:id      – ta bort ärendet
//   GET  /api/v1/support               – teamet (API-nyckel med behörigheten support): godkända, öppna ärenden utan namn
//   POST /api/v1/support/:id           – teamet sätter status och svar – det enda en API-nyckel får skriva
// Ingenting här lämnar servern av sig självt: teamet hämtar själv, och ser bara det en administratör har godkänt.
import { send, fail, readJson, clientIp } from '../util.js';
import { audit } from '../auth.js';
import * as S from '../support.js';
import * as keys from '../apikeys.js';
import { VERSION } from '../updates.js';
import { route, user, admin, isTrusted } from '../http/router.js';
import { allowedFor, ctx } from '../http/context.js';

const LIMIT = 32 << 10; // hela förfrågan (text + teknisk information)
const allowed = (c) => (it) => allowedFor(c.user.id, it);
const limits = () => ({ title: S.MAX_TITLE, text: S.MAX_TEXT, reply: S.MAX_REPLY, perHour: S.MAX_PER_HOUR });

route('POST', '/api/support/context', user, async (c) => {
  const b = await readJson(c.req, LIMIT);
  send(c.res, 200, { context: S.buildContext(c.user, b.context, S.KINDS.includes(b.kind) ? b.kind : 'bug', allowed(c)) });
});
route('POST', '/api/support', user, async (c) => {
  const r = S.create(c.user, await readJson(c.req, LIMIT), allowed(c));
  // Säkerhetsloggen: att ett ärende skapats – aldrig texten
  audit('support_created', { ...ctx(c), detail: `#${r.id} (${r.status})` });
  const sent = r.status === 'approved';
  send(c.res, 200, { id: r.id, status: r.status, message: sent ? 'Ärendet är skickat till teamet.' : 'Ärendet är mottaget och väntar på granskning.' });
});
route('GET', '/api/support', user, (c) => send(c.res, 200, { tickets: S.mine(c.user.id).map(S.forOwner), areas: S.AREAS, limits: limits() }));
route('GET', '/api/support/count', user, (c) => send(c.res, 200, S.counts(c.user)));
route('GET', '/api/support/:id', user, (c) => {
  const r = S.ownTicket(c.user.id, c.p.id);
  if (!r) return fail(c.res, 404, 'Finns inte');
  send(c.res, 200, S.forOwner(r));
});
route('POST', '/api/support/:id/reply', user, async (c) => {
  const r = S.ownTicket(c.user.id, c.p.id);
  if (!r) return fail(c.res, 404, 'Finns inte');
  send(c.res, 200, S.forOwner(S.reply(r, c.user, await readJson(c.req, LIMIT))));
});

// ---------- administratören granskar ----------
route('GET', '/api/admin/support', admin, (c) => send(c.res, 200, { tickets: S.adminList().map(S.forAdmin), review: S.reviewCount(), areas: S.AREAS, limits: limits() }));
const adminAct = (event, fn) => async (c) => {
  const r = fn(c.p.id, await readJson(c.req, LIMIT), c);
  if (!r) return fail(c.res, 404, 'Finns inte');
  if (event) audit(event, { ...ctx(c), detail: `#${+c.p.id}` });
  send(c.res, 200, r === true ? { ok: true } : S.forAdmin(r));
};
route('PUT', '/api/admin/support/:id', admin, adminAct(null, (id, b) => S.edit(id, b)));
route('POST', '/api/admin/support/:id/approve', admin, adminAct('support_approved', (id, b) => S.approve(id, b)));
route('POST', '/api/admin/support/:id/reject', admin, adminAct('support_rejected', (id, b) => S.reject(id, b)));
route('POST', '/api/admin/support/:id/reply', admin, adminAct('support_reply', (id, b, c) => { const r = S.ticket(id); return r && S.reply(r, c.user, b); }));
route('POST', '/api/admin/support/:id/reply/approve', admin, adminAct('support_reply_approved', (id, b) => S.reviewReply(id, true, b)));
route('POST', '/api/admin/support/:id/reply/reject', admin, adminAct('support_reply_rejected', (id) => S.reviewReply(id, false)));
route('DELETE', '/api/admin/support/:id', admin, (c) => {
  if (!S.remove(c.p.id)) return fail(c.res, 404, 'Finns inte');
  audit('support_removed', { ...ctx(c), detail: `#${+c.p.id}` });
  send(c.res, 200, { ok: true });
});

// ---------- teamet: API-nyckel med behörigheten support ----------
// Routealternativet apikey: routern sätter aldrig c.user här och /api/v1/* matchar bara sådana routes (http/router.js)
const apikey = { auth: false, apikey: true };
function teamKey(c) {
  const r = keys.check(c.req, 'support', { trusted: isTrusted(c.req), ip: clientIp(c.req) });
  if (r.error) { fail(c.res, r.status, r.error); return false; }
  c.res.setHeader('Cache-Control', 'no-store');
  return r.key;
}
route('GET', '/api/v1/support', apikey, (c) => {
  if (!teamKey(c)) return;
  const tickets = S.teamList();
  send(c.res, 200, { server: { name: 'BraXhn TV', version: VERSION }, time: Math.floor(Date.now() / 1000), count: tickets.length, tickets });
});
route('POST', '/api/v1/support/:id', apikey, async (c) => {
  const k = teamKey(c);
  if (!k) return;
  const r = S.teamUpdate(c.p.id, await readJson(c.req, 16 << 10));
  if (!r) return fail(c.res, 404, 'Finns inte');
  audit('support_team_reply', { ip: clientIp(c.req), detail: `#${r.id} → ${r.status} (nyckeln ${k.name})` });
  send(c.res, 200, S.forTeam(r));
});
