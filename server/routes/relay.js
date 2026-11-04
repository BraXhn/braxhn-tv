// Administration → Fjärråtkomst via BraXhn Relay: parning med reläets engångskod, status och bortkoppling.
// Alla routes kräver administratör på betrott nät (admin i http/router.js) – och förfrågningar genom reläet räknas
// aldrig som betrott nät, så reläet kan inte användas för att ändra sin egen koppling.
import { send, readJson, clientIp } from '../util.js';
import { audit } from '../auth.js';
import { route, admin } from '../http/router.js';
import * as relay from '../relay.js';

route('GET', '/api/relay', admin, (c) => send(c.res, 200, relay.status()));
route('POST', '/api/relay/pair', admin, async (c) => {
  const b = await readJson(c.req, 8192);
  const r = await relay.pair(b.url, b.code, b.name);
  audit('relay_paired', { user: c.user, ip: clientIp(c.req), detail: r.url });
  send(c.res, 200, r);
});
route('POST', '/api/relay/reconnect', admin, (c) => { relay.reconnect(); send(c.res, 200, relay.status()); });
route('DELETE', '/api/relay', admin, async (c) => {
  const url = relay.status().url;
  const r = await relay.unpair();
  audit('relay_unpaired', { user: c.user, ip: clientIp(c.req), detail: url });
  send(c.res, 200, r);
});
