// API-nycklar (server/apikeys.js):
//   GET/POST /api/apikeys, DELETE /api/apikeys/:id – administratören delar ut och tar bort nycklar (hemnätet)
//   GET /api/v1/status                           – serverns namn och version (vilken giltig nyckel som helst)
//   GET /api/v1/now-playing                      – vad som spelas just nu (behörigheten nowplaying)
//   GET /api/v1/library                          – antal och nyligen tillagt (behörigheten library)
//   GET /api/v1/image/:ref?w=                    – affisch (v<titel>), albumomslag (a<album>), ljudboksomslag (b<bok>)
// /api/v1/* får aldrig någon inloggning från routern (routealternativet apikey) – bara nyckeln gäller där.
import fs from 'node:fs';
import { send, fail, readJson, clientIp } from '../util.js';
import { audit } from '../auth.js';
import * as keys from '../apikeys.js';
import { imageFile } from '../localmeta.js';
import { sized } from '../imgsize.js';
import * as music from '../music.js';
import * as books from '../audiobooks.js';
import { VERSION } from '../updates.js';
import { route, admin, isTrusted } from '../http/router.js';
import { ctx } from '../http/context.js';

// ---------- administration ----------
route('GET', '/api/apikeys', admin, (c) => send(c.res, 200, { keys: keys.list(), scopes: keys.SCOPES }));
route('POST', '/api/apikeys', admin, async (c) => {
  try {
    const k = keys.create(await readJson(c.req), c.user.id);
    audit('apikey_created', { ...ctx(c), detail: `${k.name} (${k.scopes.join(', ')})` });
    send(c.res, 200, k);
  } catch (e) { fail(c.res, e.status || 500, e.status ? e.message : 'Kunde inte skapa nyckeln'); }
});
route('DELETE', '/api/apikeys/:id', admin, (c) => {
  if (!keys.remove(c.p.id)) return fail(c.res, 404, 'Finns inte');
  audit('apikey_removed', { ...ctx(c), detail: `#${+c.p.id}` });
  send(c.res, 200, { ok: true });
});

// ---------- API:t för andra system ----------
const apikey = { auth: false, apikey: true };
/** Kontrollerar nyckeln (scope: en behörighet, en lista eller null = vilken som helst); svarar själv med felet och ger false */
function allowed(c, scope) {
  const r = keys.check(c.req, scope, { trusted: isTrusted(c.req), ip: clientIp(c.req) });
  if (r.error) { fail(c.res, r.status, r.error); return false; }
  c.res.setHeader('Cache-Control', 'no-store');
  return true;
}
const server = () => ({ name: 'BraXhn TV', version: VERSION });

route('GET', '/api/v1/status', apikey, (c) => {
  if (!allowed(c, null)) return;
  send(c.res, 200, { server: server(), time: Math.floor(Date.now() / 1000) });
});
route('GET', '/api/v1/now-playing', apikey, (c) => {
  if (!allowed(c, 'nowplaying')) return;
  const sessions = keys.nowPlaying();
  send(c.res, 200, { server: server(), time: Math.floor(Date.now() / 1000), count: sessions.length, sessions });
});
route('GET', '/api/v1/library', apikey, (c) => {
  if (!allowed(c, 'library')) return;
  send(c.res, 200, { server: server(), ...keys.library(Math.max(1, Math.min(50, parseInt(c.q.get('limit')) || 12))) });
});
route('GET', '/api/v1/image/:ref', apikey, async (c) => {
  // Bilderna hör till det nyckeln får läsa: affischer och omslag i Nu spelas och Nyligen tillagt
  if (!allowed(c, ['nowplaying', 'library'])) return;
  c.res.removeHeader('Cache-Control');
  const m = /^([vab])(\d{1,10})$/.exec(c.p.ref);
  if (!m) return fail(c.res, 404, 'Ingen bild');
  const id = +m[2];
  const f = m[1] === 'v' ? imageFile(id, 'poster') : m[1] === 'a' ? music.coverPath(id) : books.coverPath(id);
  if (!f) return fail(c.res, 404, 'Ingen bild');
  const w = Math.max(60, Math.min(600, parseInt(c.q.get('w')) || 300));
  fs.readFile(await sized(f, String(w)), (e, data) => e ? fail(c.res, 404, 'Ingen bild')
    : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }));
});
