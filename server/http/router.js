// Routing och säkerhetsmodellen för alla HTTP-anrop.
//
// Varje route registreras med route(metod, mönster, alternativ, funktion) från filerna i server/routes/.
// Alternativen (pub/user/admin/media/img/audio nedan) bestämmer vem som släpps in; handle() längst ner
// kontrollerar dem för varje förfrågan innan routens funktion körs. Routefilerna gör inga egna
// kontroller av inloggning, tokentyp eller betrott nät utöver det som står här – ändra därför i den här
// filen med stor försiktighet.
//
// Routes matchas i den ordning de registreras (första träff vinner). server/app.js importerar
// routefilerna i en fast ordning; mönster som kan överlappa (t.ex. /api/music/:lib/albums och
// /api/music/albums/:aid) ligger i samma fil och i samma inbördes ordning.
import { getSetting, get } from '../db.js';
import { clientIp, isPrivate, inCidr, fail, isHttps, send } from '../util.js';
import { userFromReq, calendarUser, require2faRemote, audit, cookieHeader } from '../auth.js';
import * as acme from '../acme.js';
import * as pk from '../passkeys.js';
import { mfaTrusted } from '../sso.js';
import * as metrics from '../metrics.js';
import * as dlna from '../dlna.js';
import { serveStatic } from './static.js';

// ---------- webbklientens språk ----------
// index.html finns på svenska (standard) och engelska (med översättningskatalogen web/i18n/en.js). Inloggad: profilens
// val (inget val = svenska). Utloggad (inloggningssidan, installationen): kakan bxlang som webben sätter, annars
// webbläsarens språk (Accept-Language; nordiska språk → svenska, okänt → svenska).
export function acceptLang(h) {
  const list = String(h || '').split(',').map((p, i) => { const [tag, ...o] = p.trim().toLowerCase().split(';'); const q = o.map(x => /^\s*q=([\d.]+)/.exec(x)?.[1]).find(Boolean); return { tag, q: q ? +q : 1, i }; })
    .filter(x => x.tag).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of list) {
    if (/^(sv|nb|nn|no|da)\b/.test(tag)) return 'sv';
    if (/^en\b/.test(tag)) return 'en';
  }
  return 'sv';
}
export function pageLang(req) {
  try {
    const u = userFromReq(req, new URLSearchParams(), false);
    if (u && u.kind === 'web') return u.lang === 'en' ? 'en' : 'sv';
  } catch {}
  const ck = /(?:^|;\s*)bxlang=(sv|en)(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  return ck || acceptLang(req.headers['accept-language']);
}

// ---------- routing ----------
// :namn i mönstret blir en parameter i c.p (matchar aldrig ett snedstreck)
const routes = [];
export const route = (method, pattern, opts, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, fn, ...opts });
};
// Routealternativ:
//   pub   – ingen inloggning krävs (c.user sätts ändå om någon är inloggad)
//   user  – inloggad med vanlig session (kaka för webben, token för appar)
//   admin – inloggad administratör och dessutom på betrott nät (om inte "administration överallt" är påslaget)
//   media – strömmar: tillåter även kortlivad mediatoken (?t=) för just den titeln (p.id)
//   img   – bilder: tillåter även bildtoken (?t=) för appar
//   audio – musikströmmar: mediatoken för just det spåret (scope = -spårets id)
//   calendar – iCal-prenumeration: BARA den personliga kalendertoken (?t=, tabellen calendar_tokens). Kaka,
//              Bearer och andra token gäller inte där, och kalendertoken gäller ingen annanstans (se auth.js).
//   subsonic – musikappar (/rest/*, server/routes/subsonic.js): routern sätter ALDRIG c.user där – kaka, Bearer och
//              ?t= ignoreras. Routen loggar själv in med appens lösenord för musikappar (server/subsonic.js) och
//              kontrollerar fjärrreglerna med remoteDenied() nedan. /rest/* matchar bara subsonic-routes och
//              subsonic-routes bara /rest/*, så musikappens lösenord når aldrig något annat API.
//   opds     – läsappar (/api/opds/*, server/routes/ebooks.js): som subsonic sätter routern ALDRIG c.user där.
//              Routen loggar själv in med Basic och lösenordet för läsappar (server/opds.js) och kontrollerar
//              fjärrreglerna med remoteDenied(). /api/opds/* matchar bara opds-routes och tvärtom.
//   feed     – privata RSS-flöden för ljudböcker (/api/feeds/*, server/routes/books.js): routern sätter ALDRIG c.user där.
//              Routen slår själv upp flödets nyckel i adressen (server/bookfeeds.js, tabellen book_feeds) och kontrollerar
//              fjärrreglerna med remoteDenied(). /api/feeds/* matchar bara feed-routes och tvärtom, så nyckeln gäller inget annat.
// Routefilerna kan lägga till scope(p) (ljudböcker, poddar, live-TV, inspelningar, trailers): den räknar ut
// vilket id en mediatoken måste vara utfärdad för, utifrån routens parametrar.
export const pub = { auth: false }, user = { auth: true }, admin = { auth: true, admin: true };
export const media = { auth: true, media: true }; // strömmar: tillåter kortlivad mediatoken (?t=) för just den titeln
export const img = { auth: true, img: true };     // bilder: tillåter bildtoken (?t=) för appar
export const audio = { auth: true, media: true, music: true }; // musikströmmar: mediatoken för just det spåret
export const calendar = { auth: true, calendar: true };          // iCal: bara kalendertoken (?t=)
export const subsonic = { auth: false, subsonic: true };         // musikappar: egen inloggning i routen (app-lösenord)
export const opds = { auth: false, opds: true };                 // läsappar: egen Basic-inloggning i routen (lösenord för läsappar)
export const feed = { auth: false, feed: true };                 // poddappar: flödets egen nyckel i adressen (ljudböcker som RSS)

// ---------- betrodda nätverk ----------
// Hemnät (RFC1918), VPN/CGNAT (100.64.0.0/10, t.ex. NetBird/Tailscale) och egna nät i inställningarna
function trustedNets() {
  return [...String(getSetting('trusted_networks', '')).split(','), ...String(process.env.TRUSTED_NETWORKS || '').split(',')].map(s => s.trim()).filter(Boolean);
}
// 100.64.0.0/10 (CGNAT/VPN) är avstängt som standard: hos vissa operatörer kan andra kunder nå dig från det nätet.
// NetBird/Tailscale-routing via OPNsense maskerar normalt till en LAN-adress och behöver det inte.
export const trustVpn = () => getSetting('trust_vpn_range', process.env.TRUST_VPN_RANGE || '0') === '1';
/** Kommer förfrågan från ett betrott nät? (klientens adress enligt clientIp i util.js) */
export const isTrusted = (req) => { const ip = clientIp(req); return isPrivate(ip) || (trustVpn() && inCidr(ip, '100.64.0.0/10')) || trustedNets().some(n => inCidr(ip, n)); };
/** Får administratörer administrera utanför betrott nät? (avstängt som standard) */
export const adminAnywhere = () => getSetting('admin_anywhere', process.env.ADMIN_ANYWHERE || '0') === '1';

/** Profiler ärver huvudkontots tvåstegsverifiering (de nås bara via ett inloggat hushåll); en passkey räknas också, liksom
 *  en koppling till en leverantör för enkel inloggning som administratören markerat "sköter tvåstegsverifieringen" (sso.js) */
export function has2fa(u) {
  const owner = u.parent_id || u.id;
  return !!(u.totp_enabled || (u.parent_id && get('SELECT totp_enabled FROM users WHERE id=?', u.parent_id)?.totp_enabled) || pk.hasPasskey(owner) || mfaTrusted(owner));
}
/**
 * Varför kontot nekas från förfrågans nät (null = släpps in). Konton utan fjärråtkomst släpps bara in från betrott nät;
 * twoFactor: inloggningen är långlivad (kaka, appens Bearer, musikappens lösenord) och kräver då 2FA utifrån när det är påslaget.
 */
export function remoteDenied(u, req, twoFactor) {
  if (isTrusted(req)) return null;
  if (!u.remote_allowed) return 'Ditt konto får bara användas på hemnätverket';
  if (twoFactor && require2faRemote() && !has2fa(u)) return 'Tvåstegsverifiering krävs utanför hemmet';
  return null;
}

// CSRF: ändrande anrop med cookie-inloggning måste komma från samma origin
function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = (isPrivate(req.socket.remoteAddress) && req.headers['x-forwarded-host']) || req.headers.host;
  if (origin) { try { return new URL(origin).host === host; } catch { return false; } }
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

/** Tar emot alla HTTP-förfrågningar (både http och https, se server/index.js). */
export async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return fail(res, 400, 'Ogiltig adress'); }
  // Säkerhetsrubriker på alla svar
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (!url.pathname.startsWith('/api/stream/')) res.setHeader('X-Frame-Options', 'DENY');
  if (isHttps(req) && process.env.HSTS !== '0') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  // Let's Encrypt (HTTP-01): svaret på utmaningen, utan inloggning
  if (url.pathname.startsWith('/.well-known/acme-challenge/')) {
    const ka = acme.challenges.get(url.pathname.slice(28));
    return ka ? send(res, 200, ka, { 'Content-Type': 'text/plain' }) : fail(res, 404, 'Finns inte');
  }
  // Prometheus (egen token) och DLNA (bara betrodda nät, utan inloggning) ligger utanför /api/
  if (url.pathname === '/metrics') return metrics.serve(req, res);
  if (url.pathname.startsWith('/dlna/')) return dlna.handle(req, res, url, { trusted: isTrusted(req) });
  // Musikappar (Subsonic/OpenSubsonic) under /rest/: inloggning via parametrar, aldrig kaka – därför CORS för webbklienter (Feishin)
  const rest = url.pathname.startsWith('/rest/');
  if (rest) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Max-Age': '86400' }); return res.end(); }
  }
  // Allt annat utanför /api/ är webbappens statiska filer (se static.js)
  if (!rest && !url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname, url.search, () => pageLang(req));
  // Chromecast-mottagare och andra enheter hämtar media från annan origin
  if (url.pathname.startsWith('/api/stream/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' }); return res.end(); }
  }
  const opdsPath = url.pathname === '/api/opds' || url.pathname.startsWith('/api/opds/');
  const feedPath = url.pathname.startsWith('/api/feeds/');
  for (const r of routes) {
    if (r.method !== req.method) continue;
    if (rest !== !!r.subsonic) continue; // /rest/* når bara musikappens routes och tvärtom
    if (opdsPath !== !!r.opds) continue; // /api/opds/* når bara läsappens routes och tvärtom
    if (feedPath !== !!r.feed) continue; // /api/feeds/* når bara RSS-flödenas routes och tvärtom
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    let p;
    try { p = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); } catch { return fail(res, 400, 'Ogiltig adress'); }
    // Token i adressen (?t=) tas bara emot på routes som tillåter media- eller bildtoken
    // Kalenderroutes slår bara upp kalendertoken – ingen annan inloggning används där
    // Musikappens routes får ingen inloggning härifrån (de loggar in själva med app-lösenordet)
    const c = { req, res, q: url.searchParams, p, user: r.subsonic || r.opds || r.feed ? null : r.calendar ? calendarUser(url.searchParams) : userFromReq(req, url.searchParams, !!(r.media || r.img)) };
    // Glidande 30 dagar för "Håll mig inloggad": kakan förnyas (högst var 10:e minut, se userFromReq)
    if (c.user?.renewCookie && !res.headersSent) res.setHeader('Set-Cookie', cookieHeader(c.user.token, isHttps(req), true));
    const u = c.user;
    if (u) {
      // Kortlivade token gäller bara där de är avsedda:
      // mediatoken bara på media-/bildroutes och, när den är knuten till en titel, bara för den titeln
      // (routens scope(p), spåret för audio eller annars p.id); bildtoken bara på bildroutes
      if ((u.kind === 'calendar') !== !!r.calendar) c.user = null; // kalendertoken bara på kalenderroutes (och tvärtom)
      else if (u.kind === 'media' && !(r.media || r.img)) c.user = null;
      else if (u.kind === 'media' && u.scope_item && String(u.scope_item) !== (r.scope ? String(r.scope(p)) : r.music ? String(-(+p.tid)) : String(p.id))) c.user = null;
      else if (u.kind === 'img' && !r.img) c.user = null;
    }
    if (r.auth && !c.user) return fail(res, 401, 'Inte inloggad');
    if (c.user) {
      // Konton utan fjärråtkomst släpps bara in från betrott nät; web/app kräver 2FA utifrån när det är påslaget
      // (2FA slås bara upp när det behövs – inte för varje segment och affisch)
      const why = remoteDenied(c.user, req, c.user.kind === 'web' || c.user.kind === 'app');
      if (why) return fail(res, 403, why);
    }
    // Administration: administratör, och betrott nät om inte "administration överallt" är påslaget
    if (r.admin) {
      if (!c.user.is_admin) return fail(res, 403, 'Kräver administratör');
      if (!adminAnywhere() && !isTrusted(req)) { audit('admin_denied', { user: c.user, ip: clientIp(req), detail: url.pathname }); return fail(res, 403, 'Administration är bara tillåten från hemnätverket eller VPN'); }
    }
    // CSRF: ändrande anrop med kaka måste komma från samma origin. Inloggning och första kontot
    // utan kaka nekas också från annan origin (skyddar mot inloggnings-CSRF).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && c.user?.via === 'cookie' && !sameOrigin(req)) return fail(res, 403, 'Förfrågan från annan webbplats nekades');
    if (!c.user && !['GET', 'HEAD'].includes(req.method) && !sameOrigin(req) && r.method === 'POST' && /\/api\/(login|setup|passkey\/login|invite\/[^/]+|sso\/link\/[^/]+)$/.test(url.pathname) && req.headers.origin) return fail(res, 403, 'Förfrågan från annan webbplats nekades');
    // Fel med e.status är avsedda för användaren; övriga loggas och ger "Internt fel"
    try { return await r.fn(c); }
    catch (e) { if (!e.status) console.error(e); return fail(res, e.status || 500, e.status ? e.message : 'Internt fel'); }
  }
  fail(res, 404, 'Okänd endpoint');
}
