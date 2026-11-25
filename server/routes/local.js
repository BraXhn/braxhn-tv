// Hemma via den publika adressen (server/localaddr.js): serverns adresser på hemnätet, provanropet som bara svarar på
// hemnätet, och webbens byte till hemadressen med en engångskod. Inget här ändrar vad som räknas som hemma – det
// avgörs som förut av isTrusted/isLocalReq för varje förfrågan.
import { get } from '../db.js';
import { send, fail, readJson, clientIp, isHttps, isLocalReq } from '../util.js';
import { audit, cookieHeader, createSession } from '../auth.js';
import { route, pub, user } from '../http/router.js';
import * as local from '../localaddr.js';

const NOSTORE = { 'Cache-Control': 'no-store' };

// Inloggade (webb och app): adresserna att prova och ett nytt prov. here = förfrågan kommer redan från hemnätet.
route('GET', '/api/local', user, (c) => {
  const { n, proof } = local.challenge();
  send(c.res, 200, { id: local.serverId(), here: isLocalReq(c.req), addrs: local.addresses(), n, proof, ttl: local.TTL }, NOSTORE);
});

// Provanropet på hemadressen. Utan inloggning (appen skickar ingen inloggning förrän adressen är bevisad), men svarar
// bara på hemnätet – utifrån och via reläet finns det inte (404), så ingen annan maskin kan låna svaret.
route('GET', '/api/local/ping', pub, (c) => {
  if (!isLocalReq(c.req)) return fail(c.res, 404, 'Okänd endpoint');
  const proof = local.proof(c.q.get('n'));
  if (!proof) return fail(c.res, 400, 'Provet har gått ut – försök igen');
  send(c.res, 200, { id: local.serverId(), proof }, NOSTORE);
});

// Webben: en engångskod för att öppna hemadressen inloggad (bara webbens inloggning – apparna byter adress själva)
route('POST', '/api/local/handoff', user, (c) => {
  if (c.user.kind !== 'web') return fail(c.res, 400, 'Bara för webben');
  const addrs = local.addresses();
  if (!addrs.length) return fail(c.res, 404, 'Servern känner inte till någon adress på hemnätet. Administratören kan ange den under Administration → Hemadressen.');
  send(c.res, 200, { code: local.newCode(c.user.id, !!c.user.remember), addrs, ttl: local.TTL }, NOSTORE);
});

// På hemadressen: koden blir en vanlig webbinloggning för samma profil. Bara från hemnätet, en gång, inom två minuter.
// Samma skydd mot inloggning från annan webbplats som /api/login (router.js).
route('POST', '/api/local/redeem', pub, async (c) => {
  const ip = clientIp(c.req);
  if (!isLocalReq(c.req)) return fail(c.res, 403, 'Det här fungerar bara på hemnätverket');
  const { code } = await readJson(c.req, 4096);
  const v = local.takeCode(code);
  const u = v && get('SELECT id, name FROM users WHERE id=?', v.uid);
  if (!u) return fail(c.res, 400, 'Länken har redan använts eller gått ut – öppna den igen från Mitt konto');
  audit('login_ok', { ip, user: u, detail: 'webb, hemadressen' });
  const token = createSession(u.id, 'web', { ua: c.req.headers['user-agent'], ip, remember: v.remember });
  send(c.res, 200, { ok: true }, { ...NOSTORE, 'Set-Cookie': cookieHeader(token, isHttps(c.req), v.remember) });
});
