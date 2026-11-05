// Personuppgifter (GDPR) för den inloggade:
//   GET    /api/privacy          – sidan Integritet: vad som sparas, hur länge, externa tjänster som är på, kontakt
//   GET    /api/me/export        – ladda ner allt servern sparat om kontot och dess profiler (JSON, utan hemligheter)
//   DELETE /api/me               – radera det egna kontot (inte administratörer och profiler; kräver lösenordet)
//   GET    /api/tmdbimg/:size/:f – TMDB-bilder via servern, så att webbläsaren aldrig kontaktar TMDB (CSP spärrar det)
import { get, run, tx } from '../db.js';
import { send, fail, readJson, clientIp } from '../util.js';
import { audit, checkPw, ipBlocked, noteFail, clearCookies } from '../auth.js';
import * as privacy from '../privacy.js';
import { route, user } from '../http/router.js';
import { ctx } from '../http/context.js';
import { TMDB_IMG } from '../scanner.js';

route('GET', '/api/privacy', user, (c) => {
  const u = get('SELECT pass, is_admin, parent_id FROM users WHERE id=?', c.user.id);
  // canDeleteSelf: vanliga huvudkonton (profiler tas bort av huvudkontot, administratörer av en annan administratör)
  send(c.res, 200, { ...privacy.summary(c.user), canDeleteSelf: !!u && !u.parent_id && !u.is_admin, hasPassword: !!u?.pass });
});

route('GET', '/api/me/export', user, (c) => {
  const data = privacy.exportUser(c.user.id);
  if (!data) return fail(c.res, 404, 'Finns inte');
  audit('data_exported', ctx(c));
  c.res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="braxhn-tv-mina-uppgifter-${new Date().toISOString().slice(0, 10)}.json"`
  });
  c.res.end(JSON.stringify(data, null, 1));
});

route('DELETE', '/api/me', user, async (c) => {
  const u = get('SELECT id, name, pass, is_admin, parent_id FROM users WHERE id=?', c.user.id);
  if (!u) return fail(c.res, 404, 'Finns inte');
  if (u.parent_id) return fail(c.res, 400, 'En profil tas bort av huvudkontot under Profiler i hushållet');
  if (u.is_admin) return fail(c.res, 400, 'Ett administratörskonto kan inte radera sig självt – en annan administratör tar bort det under Administration');
  const b = await readJson(c.req);
  const ip = clientIp(c.req);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund');
  // Konton med lösenord bekräftar med lösenordet, konton utan (enkel inloggning) med sitt namn
  const ok = u.pass ? await checkPw(String(b.password || ''), u.pass) : String(b.confirm || '').trim() === u.name;
  if (!ok) { noteFail(ip, u.name); return fail(c.res, 400, u.pass ? 'Lösenordet stämmer inte' : 'Skriv kontots namn för att bekräfta'); }
  const ids = privacy.householdIds(u.id);
  tx(() => {
    privacy.eraseTraces(ids);
    run('DELETE FROM users WHERE parent_id=?', u.id);
    run('DELETE FROM users WHERE id=?', u.id);
  });
  // Händelsen loggas utan namn och IP-adress – kontot ska inte finnas kvar någonstans
  audit('account_self_deleted', {});
  send(c.res, 200, { ok: true }, { 'Set-Cookie': clearCookies() });
});

// ---------- TMDB-bilder via servern ----------
// Affischer i sökningar (Önskningar, Streaming, Fel titel?), tjänsternas logotyper och bildvalet i Redigera kommer
// som TMDB-adresser i API:et (apparna använder dem som de är). Webben skriver om dem till den här vägen (tmdbImg()
// i core.js), så att hushållets webbläsare inte avslöjar sin IP-adress för TMDB. Bara TMDB:s egna storlekar och
// filnamn, ett litet minne för de senaste bilderna och en vecka i webbläsarens cache.
const SIZES = new Set(['w45', 'w92', 'w154', 'w185', 'w300', 'w342', 'w500', 'w780', 'h632', 'original']);
const FILE = /^[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|svg|webp)$/;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp' };
const cache = new Map(); let cached = 0;
const CACHE_MAX = 32 * 1048576;
route('GET', '/api/tmdbimg/:size/:file', user, async (c) => {
  const { size, file } = c.p;
  if (!SIZES.has(size) || !FILE.test(file)) return fail(c.res, 404, 'Finns inte');
  const key = size + '/' + file;
  let hit = cache.get(key);
  if (!hit) {
    let r;
    try { r = await fetch(`${TMDB_IMG}/${size}/${file}`, { signal: AbortSignal.timeout(15000) }); } catch { return fail(c.res, 502, 'TMDB svarar inte'); }
    if (!r.ok) return fail(c.res, r.status === 404 ? 404 : 502, r.status === 404 ? 'Finns inte' : 'TMDB svarar inte');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8 * 1048576) return fail(c.res, 502, 'Bilden är för stor');
    hit = { buf, type: TYPES[file.split('.').pop().toLowerCase()] };
    cache.set(key, hit); cached += buf.length;
    for (const [k, v] of cache) { if (cached <= CACHE_MAX) break; cache.delete(k); cached -= v.buf.length; }
  } else { cache.delete(key); cache.set(key, hit); }
  // SVG från TMDB visas bara som bild (img), men spärras ändå mot skript om någon öppnar adressen direkt
  c.res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.buf.length, 'Cache-Control': 'private, max-age=604800, immutable',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
  c.res.end(hit.buf);
});
