// OpenID Connect (Authorization Code + PKCE) mot Authentik, Authelia, Keycloak, Google m.fl. – utan beroenden:
// discovery (/.well-known/openid-configuration), JWKS och verifiering av ID-token med node:crypto (RS256/ES256).
//   discover(issuer)            leverantörens adresser (cache 1 h); issuer i dokumentet måste vara exakt den angivna
//   authUrl(...)                adressen som webbläsaren skickas till (state, nonce, code_challenge S256)
//   exchange(...)               koden → token (token-endpoint), ID-token verifieras, ev. userinfo för grupper
//   verifyIdToken(...)          signatur (nyckeln ur JWKS efter kid, nyckeltypen måste passa algoritmen), iss, aud/azp,
//                               exp/nbf/iat med klockavvikelse (SKEW) och nonce
// Nätverket: värden i issuer är betrodd (administratören har skrivit in den, ofta på hemnätet eller samma maskin).
// Andra adresser i discovery-dokumentet (Google har t.ex. token-endpoint på en annan värd) får bara vara publika eller
// på hemnätet – aldrig loopback eller länklokalt – och kontrolleras i samma uppslag som anslutningen (DNS-rebinding).
// Token, koder och hemligheter loggas aldrig och lämnas aldrig ut.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { blockedFor } from './podcasts.js';

/** Tillåten klockavvikelse mot leverantören (sekunder) – OIDC_CLOCK_SKEW */
export const SKEW = () => Math.max(0, Math.min(600, +(process.env.OIDC_CLOCK_SKEW ?? 120)));
const ALGS = { RS256: { kty: 'RSA', hash: 'sha256' }, ES256: { kty: 'EC', crv: 'P-256', hash: 'sha256', p1363: true } };
const fail = (msg, code = 'token') => Object.assign(new Error(msg), { oidc: code });
const hostOf = (h) => String(h || '').toLowerCase().replace(/^\[|\]$/g, '');

// ---------- HTTP mot leverantören ----------
const MAX_BODY = 1024 * 1024;
function lookupFor(trusted) {
  return (host, opts, cb) => {
    dns.lookup(host, { all: true }).then(addrs => {
      if (!addrs.length) return cb(Object.assign(new Error('Adressen kunde inte slås upp'), { code: 'ENOTFOUND' }));
      if (!trusted.has(hostOf(host)) && process.env.OIDC_ALLOW_PRIVATE !== '1' && addrs.some(a => blockedFor(a.address, true))) return cb(Object.assign(new Error('Adressen pekar på ett lokalt nätverk och tillåts inte'), { code: 'EBLOCKED' }));
      if (opts?.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
    }, cb);
  };
}
/** Hämtar JSON (följer inga omdirigeringar). trusted = värdar som får vara lokala. */
export function fetchJson(url, { trusted = new Set(), method = 'GET', headers = {}, body = null, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(fail('Ogiltig adress hos leverantören', 'config')); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return reject(fail('Ogiltig adress hos leverantören', 'config'));
    const host = hostOf(u.hostname);
    if (net.isIP(host) && !trusted.has(host) && process.env.OIDC_ALLOW_PRIVATE !== '1' && blockedFor(host, true)) return reject(fail('Adressen pekar på ett lokalt nätverk och tillåts inte', 'config'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers: { 'User-Agent': 'BraXhnTV/1.0 (OIDC)', Accept: 'application/json', ...headers }, lookup: lookupFor(trusted), timeout }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (d) => { size += d.length; if (size > MAX_BODY) req.destroy(fail('För stort svar från leverantören', 'net')); else chunks.push(d); });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, data });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(fail('Leverantören svarade inte i tid', 'net')));
    req.on('error', (e) => reject(e.oidc ? e : fail(e.code === 'EBLOCKED' ? e.message : e.code === 'ECONNREFUSED' ? 'Leverantören svarar inte' : e.code === 'ENOTFOUND' ? 'Leverantören hittades inte' : 'Kunde inte nå leverantören: ' + (e.code || e.message), 'net')));
    req.end(body ?? undefined);
  });
}

// ---------- discovery och nycklar ----------
const discCache = new Map(); // issuer → { at, doc }
const jwksCache = new Map(); // jwks_uri → { at, keys, refetched }
const TTL = 3600e3;
/** Normaliserar en issuer som administratören skrivit (http/https, ingen fråga eller fragment) */
export function normIssuer(s) {
  let u;
  try { u = new URL(String(s || '').trim()); } catch { throw fail('Ogiltig utfärdare (issuer) – ange en adress som https://auth.example.com/application/o/braxhn/', 'config'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw fail('Ogiltig utfärdare (issuer)', 'config');
  return String(s).trim();
}
const trustedOf = (issuer) => new Set([hostOf(new URL(issuer).hostname)]);
const sameIssuer = (a, b) => String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');
/** Leverantörens discovery-dokument */
export async function discover(issuer, { fresh = false } = {}) {
  issuer = normIssuer(issuer);
  const hit = discCache.get(issuer);
  if (hit && !fresh && Date.now() - hit.at < TTL) return hit.doc;
  const r = await fetchJson(issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration', { trusted: trustedOf(issuer) });
  const d = r.data;
  if (r.status !== 200 || !d || typeof d !== 'object') throw fail(`Hittar inget OpenID-dokument hos utfärdaren (HTTP ${r.status})`, 'config');
  if (!sameIssuer(d.issuer, issuer)) throw fail('Utfärdaren i leverantörens dokument stämmer inte med den angivna', 'config');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    let u; try { u = new URL(d[k]); } catch { throw fail(`Leverantörens dokument saknar ${k}`, 'config'); }
    // Över internet krävs https; http bara när utfärdaren själv är http (t.ex. på hemnätet)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && issuer.startsWith('http:'))) throw fail(`${k} måste använda https`, 'config');
  }
  const doc = { issuer: d.issuer, authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri,
    userinfo_endpoint: typeof d.userinfo_endpoint === 'string' ? d.userinfo_endpoint : null, end_session_endpoint: typeof d.end_session_endpoint === 'string' ? d.end_session_endpoint : null,
    auth_methods: Array.isArray(d.token_endpoint_auth_methods_supported) ? d.token_endpoint_auth_methods_supported : ['client_secret_basic'],
    pkce: Array.isArray(d.code_challenge_methods_supported) ? d.code_challenge_methods_supported.includes('S256') : null,
    algs: Array.isArray(d.id_token_signing_alg_values_supported) ? d.id_token_signing_alg_values_supported : ['RS256'] };
  discCache.set(issuer, { at: Date.now(), doc });
  return doc;
}
async function jwks(doc, issuer, { refresh = false } = {}) {
  const hit = jwksCache.get(doc.jwks_uri);
  // Okänd nyckel (leverantören har bytt nyckel): hämta om, men högst en gång per minut
  if (hit && Date.now() - hit.at < TTL && (!refresh || Date.now() - hit.at < 60e3)) return hit.keys;
  const r = await fetchJson(doc.jwks_uri, { trusted: trustedOf(issuer) });
  if (r.status !== 200 || !Array.isArray(r.data?.keys)) throw fail('Kunde inte hämta leverantörens nycklar (JWKS)', 'net');
  const keys = r.data.keys.filter(k => k && typeof k === 'object' && (k.kty === 'RSA' || k.kty === 'EC') && (!k.use || k.use === 'sig')).slice(0, 50);
  jwksCache.set(doc.jwks_uri, { at: Date.now(), keys });
  return keys;
}
export function clearCaches() { discCache.clear(); jwksCache.clear(); }

// ---------- PKCE, state, nonce ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
export const randomToken = (n = 32) => b64u(crypto.randomBytes(n));
export const challengeOf = (verifier) => b64u(crypto.createHash('sha256').update(verifier).digest());
/** Adressen till leverantörens inloggning */
export function authUrl(doc, { clientId, redirectUri, scopes, state, nonce, verifier, prompt }) {
  const u = new URL(doc.authorization_endpoint);
  const sc = String(scopes || 'openid profile email').split(/[\s,]+/).filter(Boolean);
  if (!sc.includes('openid')) sc.unshift('openid');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', sc.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', challengeOf(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  if (prompt) u.searchParams.set('prompt', prompt);
  return u.href;
}

// ---------- ID-token ----------
function jwkFor(keys, header) {
  const a = ALGS[header.alg];
  const ok = keys.filter(k => k.kty === a.kty && (!a.crv || k.crv === a.crv) && (!k.alg || k.alg === header.alg));
  if (header.kid != null) return ok.find(k => k.kid === header.kid) || null;
  return ok.length === 1 ? ok[0] : null;
}
/**
 * Verifierar ett ID-token. Returnerar claims eller kastar Error (e.oidc = 'token'). keys = JWKS-nycklarna,
 * refresh() = hämta nycklarna på nytt (anropas en gång när kid är okänd).
 */
export async function verifyIdToken(token, { keys, refresh, issuer, clientId, nonce, now = Math.floor(Date.now() / 1000), skew = SKEW() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]*$/.test(p))) throw fail('ID-token har fel format');
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { throw fail('ID-token går inte att läsa'); }
  if (!header || !claims || typeof claims !== 'object') throw fail('ID-token går inte att läsa');
  // Bara asymmetriska algoritmer: "none" och HS256 (med klienthemligheten) godtas aldrig
  if (!ALGS[header.alg]) throw fail(`Algoritmen ${String(header.alg).slice(0, 10)} godtas inte (RS256 eller ES256)`);
  if (header.crit) throw fail('ID-token har okända kritiska fält');
  let jwk = jwkFor(keys, header);
  if (!jwk && refresh) jwk = jwkFor(await refresh(), header);
  if (!jwk) throw fail('Okänd signeringsnyckel i ID-token');
  let key;
  try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { throw fail('Leverantörens nyckel går inte att läsa'); }
  const a = ALGS[header.alg];
  const sig = Buffer.from(parts[2], 'base64url');
  const ok = crypto.verify(a.hash, Buffer.from(parts[0] + '.' + parts[1]), a.p1363 ? { key, dsaEncoding: 'ieee-p1363' } : key, sig);
  if (!ok) throw fail('Signaturen i ID-token stämmer inte');
  if (claims.iss !== issuer) throw fail('ID-token kommer från fel utfärdare');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw fail('ID-token är inte utfärdat för BraXhn TV (aud)');
  if ((aud.length > 1 || claims.azp != null) && claims.azp !== clientId) throw fail('ID-token är utfärdat för en annan klient (azp)');
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw fail('ID-token har gått ut');
  if (claims.nbf != null && (typeof claims.nbf !== 'number' || claims.nbf - skew > now)) throw fail('ID-token gäller inte än');
  if (typeof claims.iat !== 'number' || claims.iat - skew > now) throw fail('ID-token är utfärdat i framtiden – kontrollera klockan');
  if (claims.iat < now - 24 * 3600) throw fail('ID-token är för gammalt');
  if (nonce == null || typeof claims.nonce !== 'string' || !crypto.timingSafeEqual(crypto.createHash('sha256').update(claims.nonce).digest(), crypto.createHash('sha256').update(String(nonce)).digest())) throw fail('Fel nonce i ID-token');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw fail('ID-token saknar användare (sub)');
  return claims;
}

/**
 * Byter koden mot token och verifierar ID-token. Returnerar claims (med grupper från userinfo om ID-token saknar dem).
 * p = { issuer, clientId, clientSecret, redirectUri, groupsClaim }
 */
export async function exchange(p, { code, verifier, nonce }) {
  const doc = await discover(p.issuer);
  const trusted = trustedOf(p.issuer);
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: p.redirectUri, code_verifier: verifier });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (p.clientSecret && doc.auth_methods.includes('client_secret_basic')) {
    headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`).toString('base64');
  } else {
    form.set('client_id', p.clientId);
    if (p.clientSecret) form.set('client_secret', p.clientSecret);
  }
  const body = form.toString();
  headers['Content-Length'] = String(Buffer.byteLength(body));
  const r = await fetchJson(doc.token_endpoint, { trusted, method: 'POST', headers, body });
  if (r.status !== 200 || typeof r.data?.id_token !== 'string') {
    // Felkoden från leverantören (invalid_grant …) får visas, men aldrig något ur förfrågan
    const why = typeof r.data?.error === 'string' ? r.data.error.replace(/[^\w.-]/g, '').slice(0, 40) : `HTTP ${r.status}`;
    throw fail(`Leverantören godtog inte inloggningen (${why})`);
  }
  const claims = await verifyIdToken(r.data.id_token, { keys: await jwks(doc, p.issuer), refresh: () => jwks(doc, p.issuer, { refresh: true }), issuer: doc.issuer, clientId: p.clientId, nonce });
  const gc = p.groupsClaim || 'groups';
  if (claimAt(claims, gc) == null && doc.userinfo_endpoint && typeof r.data.access_token === 'string') {
    try {
      const ui = await fetchJson(doc.userinfo_endpoint, { trusted, headers: { Authorization: 'Bearer ' + r.data.access_token } });
      // userinfo måste gälla samma användare som ID-token (OIDC Core 5.3.2)
      if (ui.status === 200 && ui.data && ui.data.sub === claims.sub) {
        for (const k of [gc.split('.')[0], 'email', 'email_verified', 'preferred_username', 'name']) if (claims[k] == null && ui.data[k] != null) claims[k] = ui.data[k];
      }
    } catch {}
  }
  return claims;
}
/** Värdet för ett claim, även med punkt (realm_access.roles i Keycloak) */
export function claimAt(claims, path) {
  let v = claims;
  for (const k of String(path || '').split('.')) { if (v == null || typeof v !== 'object') return null; v = v[k]; }
  return v ?? null;
}
/** Grupperna i ett claim: lista eller kommaseparerad text */
export function groupsOf(claims, path) {
  const v = claimAt(claims, path || 'groups');
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  return list.filter(x => typeof x === 'string' && x).map(x => x.slice(0, 200)).slice(0, 500);
}
