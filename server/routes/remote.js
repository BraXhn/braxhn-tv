// "Spela på…": fjärrstyrning mellan inloggade webbläsare (se server/remote.js för regler och flöde).
import { readJson, fail, send } from '../util.js';
import * as remote from '../remote.js';
import { route, user } from '../http/router.js';
import { allowedFor } from '../http/context.js';

remote.setAllowed(allowedFor);

// Mediatoken och bildtoken släpps aldrig in här (router.js) – bara riktiga inloggningar
// Anslutningen (SSE): registrerar webbläsaren som enhet och tar emot kommandon och status
route('GET', '/api/remote/events', user, (c) => {
  remote.connect(c.user, { key: c.q.get('key'), name: c.q.get('name'), hidden: c.q.get('hidden') === '1' }, c.req, c.res);
});
route('GET', '/api/remote/devices', user, (c) => send(c.res, 200, { devices: remote.listFor(c.user, c.q.get('me') || '') }));
// Byt namn på eller dölj den egna enheten
route('PUT', '/api/remote/devices/:id', user, async (c) => {
  const b = await readJson(c.req, 4096);
  send(c.res, 200, remote.update(c.user, c.p.id, { name: b.name, hidden: b.hidden }));
});
const target = (c) => {
  const d = remote.deviceFor(c.user, c.p.id);
  if (!d) fail(c.res, 404, 'Enheten finns inte eller är inte ansluten');
  return d;
};
route('POST', '/api/remote/devices/:id/command', user, async (c) => {
  const d = target(c); if (!d) return;
  const b = await readJson(c.req, 8192);
  send(c.res, 200, remote.command(c.user, d, remote.parseCommand(b), b.from));
});
route('POST', '/api/remote/devices/:id/watch', user, async (c) => {
  const d = target(c); if (!d) return;
  send(c.res, 200, remote.watch(c.user, d, (await readJson(c.req, 4096)).from, true));
});
route('DELETE', '/api/remote/devices/:id/watch', user, (c) => {
  const d = target(c); if (!d) return;
  send(c.res, 200, remote.watch(c.user, d, c.q.get('from'), false));
});
// Mottagarens läge (titel, position, paus, spår, volym)
route('POST', '/api/remote/state', user, async (c) => {
  const b = await readJson(c.req, 32768);
  send(c.res, 200, remote.report(c.user, b.device, b.state));
});
