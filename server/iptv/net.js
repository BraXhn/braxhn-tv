// Hämtning från IPTV-källor: M3U-listor, XMLTV-guider, Xtream-API, VOD-filer och kontroll av strömadresser före ffmpeg.
//
// Skyddet mot SSRF (servern luras att anropa något på insidan) bygger på vem som angett adressen:
//  - Adresser som administratören själv skrivit in (listan, guiden, Xtream-servern) räknas som betrodda – även
//    localhost och hemnätet (Threadfin/xTeVe/TVHeadend på samma maskin är vanligt). Bara just den värden är betrodd.
//  - Allt annat – strömadresser och guider i listan, omdirigeringar, logotyper, catch-up-adresser – är innehåll från
//    leverantören och får bara gå till publika adresser, hemnätet (om källan tillåter det, standard) eller en betrodd värd.
//    Loopback, länklokalt (169.254.169.254 = molnens metadatatjänst) och multicast spärras alltid för dem.
// Uppslaget kontrolleras i samma anslutning som görs (skydd mot DNS-rebinding). ffmpeg gör egna uppslag, följer
// omdirigeringar och hämtar HLS-segment: dess http/https går därför genom vakten nedan (ffGuard), som kontrollerar varje
// anslutning på samma sätt. rtsp går inte genom vakten – där kontrolleras adressen strax före start (assertStream).
// Alla hämtningar har tidsgränser och storleksgränser (även uppackad gzip).
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { CONFIG } from '../db.js';
import { blockedFor } from '../podcasts.js';

export const UA = 'BraXhnTV/1.0 (IPTV)';
const BLOCK_MSG = 'Adressen pekar på ett lokalt nätverk och tillåts inte';
// Tester och särskilda installationer: allt tillåts (samma flagga som poddarna)
const allowAll = () => process.env.PODCAST_ALLOW_PRIVATE === '1' || process.env.IPTV_ALLOW_PRIVATE === '1';
const hostOf = (h) => String(h || '').toLowerCase().replace(/^\[|\]$/g, '');

/** Policy för en källa: betrodda värdar (det administratören skrivit in) och om hemnätet är tillåtet för innehållet */
export function policyOf(urls = [], lan = true) {
  const trusted = new Set();
  for (const u of urls) { try { if (u && /^https?:\/\//i.test(u)) trusted.add(hostOf(new URL(u).hostname)); } catch {} }
  return { trusted, lan: !!lan };
}
export const openPolicy = () => ({ trusted: new Set(), lan: false });
const ipOk = (ip, pol) => allowAll() || !blockedFor(ip, pol.lan);

/** Får värden nås enligt policyn? (slår upp namnet) */
export async function hostOk(host, pol) {
  host = hostOf(host);
  if (!host) return false;
  if (allowAll() || pol.trusted.has(host)) return true;
  if (net.isIP(host)) return ipOk(host, pol);
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { return false; }
  return addrs.length > 0 && addrs.every(a => ipOk(a.address, pol));
}
/** Kontroll av en strömadress innan ffmpeg får den. udp/rtp (multicast från operatören) skickar inget och tillåts. */
export async function assertStream(u, pol) {
  let url;
  try { url = new URL(u); } catch { throw new Error('Ogiltig strömadress'); }
  if (/^(udp|rtp):$/i.test(url.protocol)) return;
  if (!/^(https?|rtsp):$/i.test(url.protocol)) throw new Error('Strömadressen har ett protokoll som inte stöds');
  if (!(await hostOk(url.hostname, pol))) throw Object.assign(new Error(BLOCK_MSG), { status: 403 });
}

const lookupFor = (pol) => (host, opts, cb) => {
  dns.lookup(host, { all: true }).then(addrs => {
    if (!addrs.length) return cb(Object.assign(new Error('Adressen kunde inte slås upp'), { code: 'ENOTFOUND' }));
    if (!allowAll() && !pol.trusted.has(hostOf(host)) && addrs.some(a => !ipOk(a.address, pol))) return cb(Object.assign(new Error(BLOCK_MSG), { code: 'EBLOCKED' }));
    if (opts?.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
  }, cb);
};
function request(url, { pol, headers, timeout, signal, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Tidsgränsen överskreds'));
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Ogiltig adress')); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('Bara http/https stöds'));
    const host = hostOf(u.hostname);
    if (net.isIP(host) && !allowAll() && !pol.trusted.has(host) && !ipOk(host, pol)) return reject(new Error(BLOCK_MSG));
    const auth = u.username || u.password ? { Authorization: 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') } : {};
    u.username = ''; u.password = '';
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip', ...auth, ...headers }, lookup: lookupFor(pol), timeout, signal }, (res) => {
      resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: { get: (k) => { const v = res.headers[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; } }, body: res });
    });
    req.on('timeout', () => req.destroy(new Error('Tidsgränsen överskreds')));
    req.on('error', (e) => reject(e.code === 'EBLOCKED' ? new Error(e.message) : e.name === 'AbortError' ? new Error('Tidsgränsen överskreds') : e));
    req.end();
  });
}
/** GET med kontroll av varje omdirigering. timeout = tystnad på anslutningen, signal avbryter allt. */
export async function iptvFetch(u, { pol = openPolicy(), headers = {}, timeout = 30000, signal, method } = {}) {
  let url = String(u);
  for (let i = 0; i < 6; i++) {
    const r = await request(url, { pol, headers, timeout, signal, method });
    const loc = r.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(r.status) && loc) { r.body.resume(); url = new URL(loc, url).href; continue; }
    return { r, url };
  }
  throw new Error('För många omdirigeringar');
}

// ---------- vakt för ffmpeg (proxy på 127.0.0.1) ----------
// ffmpeg gör egna DNS-uppslag, följer omdirigeringar och hämtar segmenten i en HLS-spellista från vilka värdar som helst.
// Därför går ffmpegs http/https genom en liten proxy i servern (-http_proxy): varje anslutning – även omdirigeringar,
// segment och nycklar – slås upp och kontrolleras mot källans policy i samma anslutning som görs (skydd mot DNS-rebinding).
// Varje ffmpeg får en egen engångsnyckel (proxyns inloggning) som pekar ut policyn och tas bort när processen avslutas.
const guardPols = new Map(); // nyckel → policy
let guardSrv = null, guardPort = 0;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function guardPolicy(h) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(h || '').trim());
  if (!m) return null;
  const s = Buffer.from(m[1], 'base64').toString('latin1');
  return guardPols.get(s.slice(s.indexOf(':') + 1)) || null;
}
const ipAllowed = (host, addrs, pol) => allowAll() || pol.trusted.has(host) || (addrs.length > 0 && addrs.every(a => ipOk(a.address, pol)));
function guardHttp(req, res) {
  const pol = guardPolicy(req.headers['proxy-authorization']);
  if (!pol) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="braxhn"', 'Content-Length': '0' }); return res.end(); }
  let u;
  try { u = new URL(req.url); } catch { res.writeHead(400, { 'Content-Length': '0' }); return res.end(); }
  if (u.protocol !== 'http:' || u.username || u.password) { res.writeHead(400, { 'Content-Length': '0' }); return res.end(); }
  const host = hostOf(u.hostname);
  if (net.isIP(host) && !ipAllowed(host, [{ address: host }], pol)) { res.writeHead(403, { 'Content-Length': '0' }); return res.end(); }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  const up = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers, lookup: lookupFor(pol), timeout: 60000 }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
    res.writeHead(r.statusCode, out);
    r.pipe(res);
    r.on('error', () => res.destroy());
  });
  up.on('timeout', () => up.destroy(new Error('Tidsgränsen överskreds')));
  up.on('error', (e) => { if (!res.headersSent) { res.writeHead(e.code === 'EBLOCKED' ? 403 : 502, { 'Content-Length': '0' }); res.end(); } else res.destroy(); });
  res.on('close', () => up.destroy());
  req.pipe(up);
}
async function guardConnect(req, sock, head) {
  sock.on('error', () => {});
  const pol = guardPolicy(req.headers['proxy-authorization']);
  if (!pol) return sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="braxhn"\r\nContent-Length: 0\r\n\r\n');
  const m = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(String(req.url || ''));
  if (!m || !(+m[2] > 0 && +m[2] < 65536)) return sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
  const host = hostOf(m[1]);
  let addrs;
  try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); } catch { addrs = []; }
  if (!addrs.length) return sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  if (!ipAllowed(host, addrs, pol)) return sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  // Anslutningen görs till den adress som just kontrollerades – inget nytt uppslag
  const up = net.connect({ host: addrs[0].address, port: +m[2] });
  up.setTimeout(60000, () => up.destroy());
  up.on('error', () => { if (!sock.destroyed) sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
  up.on('connect', () => {
    up.setTimeout(0);
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
    sock.on('close', () => up.destroy()); up.on('close', () => sock.destroy());
  });
}
/** Startar vakten (anropas när modulen laddas; idempotent). Ger porten när den lyssnar. */
export function startGuard() {
  if (guardSrv) return guardSrv.ready;
  guardSrv = http.createServer(guardHttp);
  guardSrv.on('connect', (req, sock, head) => { guardConnect(req, sock, head).catch(() => sock.destroy()); });
  guardSrv.on('clientError', (_e, sock) => sock.destroy());
  guardSrv.ready = new Promise((resolve) => {
    guardSrv.once('error', (e) => { console.warn('[iptv] strömvakten kunde inte startas:', e.message); resolve(0); });
    guardSrv.listen(0, '127.0.0.1', () => { guardPort = guardSrv.address().port; resolve(guardPort); });
  });
  guardSrv.unref();
  return guardSrv.ready;
}
startGuard();
/**
 * ffmpeg-argument som tvingar strömmens http/https genom vakten. Ger { args, env, release } – release() när processen
 * avslutats. env tar bort no_proxy (som annars kunde låta ffmpeg gå förbi vakten). Kastar om vakten inte lyssnar eller
 * om adressen är en spärrad IP-adress (rtsp och andra protokoll som inte går genom vakten).
 */
export function ffGuard(u, pol) {
  let url = null;
  try { url = new URL(u); } catch {}
  if (url && !/^(udp|rtp):$/i.test(url.protocol)) {
    const host = hostOf(url.hostname);
    if (net.isIP(host) && !ipAllowed(host, [{ address: host }], pol)) throw Object.assign(new Error(BLOCK_MSG), { status: 403 });
  }
  if (!guardPort) throw Object.assign(new Error('Strömvakten har inte startat än – försök igen om en stund'), { status: 503 });
  const key = crypto.randomBytes(18).toString('hex');
  guardPols.set(key, pol);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(no_proxy|http_proxy|https_proxy|all_proxy)$/i.test(k)) delete env[k];
  let done = false;
  return { args: ['-http_proxy', `http://bx:${key}@127.0.0.1:${guardPort}`], env, release: () => { if (!done) { done = true; guardPols.delete(key); } } };
}
export const guardActive = () => guardPols.size;

// ---------- lokala filer (/config) ----------
/** Den verkliga sökvägen (symlänkar följda) måste ligga i /config – inte bara börja likadant (/config2/…) */
export function localPath(url) {
  const p = String(url).replace(/^file:\/\//, '');
  let rel;
  try { rel = path.relative(fs.realpathSync(CONFIG), fs.realpathSync(p)); } catch { rel = '..'; }
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Lokala filer måste ligga i /config');
  return p;
}
export const isLocal = (u) => /^file:/.test(String(u)) || String(u).startsWith('/');
const hostLabel = (u) => { try { return new URL(u).host; } catch { return 'källan'; } };

/** Hela svaret som text (M3U, JSON). gzip packas upp (med gräns). */
export async function readText(u, { pol, headers, timeout = 60000, total = 180000, max = 100 << 20, maxOut = 400 << 20 } = {}) {
  let b;
  if (isLocal(u)) b = await fs.promises.readFile(localPath(u));
  else {
    const signal = AbortSignal.timeout(total);
    const { r } = await iptvFetch(u, { pol, headers, timeout, signal });
    if (!r.ok) { r.body.resume(); throw new Error(`${hostLabel(u)} svarade ${r.status}`); }
    const len = +r.headers.get('content-length');
    if (len > max) { r.body.destroy(); throw new Error('Filen är för stor'); }
    const chunks = []; let n = 0;
    try { for await (const c of r.body) { n += c.length; if (n > max) { r.body.destroy(); throw new Error('Filen är för stor'); } chunks.push(c); } }
    catch (e) { throw e.name === 'AbortError' ? new Error('Tidsgränsen överskreds') : e; }
    b = Buffer.concat(chunks);
  }
  if (b[0] === 0x1f && b[1] === 0x8b) {
    try { b = zlib.gunzipSync(b, { maxOutputLength: maxOut }); } catch (e) { throw new Error(/maxOutputLength|buffer/i.test(e.message) ? 'Filen är för stor' : 'Trasig gzip-fil'); }
  }
  return b.toString('utf8');
}

/** Strömmande text (stora TV-guider): hela filen hålls aldrig i minnet. Packar upp gzip automatiskt. */
export async function* textStream(u, { pol, headers, timeout = 60000, total = 300000, max = 300 << 20, maxOut = 1024 << 20 } = {}) {
  let src;
  if (isLocal(u)) src = fs.createReadStream(localPath(u), { highWaterMark: 256 << 10 });
  else {
    const { r } = await iptvFetch(u, { pol, headers, timeout, signal: AbortSignal.timeout(total) });
    if (!r.ok) { r.body.resume(); throw new Error(`${hostLabel(u)} svarade ${r.status}`); }
    src = r.body;
  }
  const it = src[Symbol.asyncIterator]();
  try {
    const first = await it.next();
    if (first.done) return;
    const dec = new TextDecoder('utf-8');
    let n = 0, out = 0;
    const raw = async function* () { let c = first; while (!c.done) { n += c.value.length; if (n > max) throw new Error('Filen är för stor'); yield c.value; c = await it.next(); } };
    if (first.value[0] === 0x1f && first.value[1] === 0x8b) {
      const gz = zlib.createGunzip();
      const feeder = Readable.from(raw());
      feeder.on('error', (e) => gz.destroy(e));
      feeder.pipe(gz);
      try {
        for await (const c of gz) { out += c.length; if (out > maxOut) throw new Error('Filen är för stor'); yield dec.decode(c, { stream: true }); }
      } catch (e) { throw /incorrect header|invalid|unexpected end/i.test(e.message) ? new Error('Trasig gzip-fil') : e; }
      finally { feeder.destroy(); gz.destroy(); }
    } else for await (const c of raw()) yield dec.decode(c, { stream: true });
    const tail = dec.decode();
    if (tail) yield tail;
  } catch (e) { throw e.name === 'AbortError' ? new Error('Tidsgränsen överskreds') : e; }
  finally { src.destroy?.(); it.return?.().catch?.(() => {}); }
}

// ---------- rubriker ----------
const HDR_NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const ALLOWED = new Set(['user-agent', 'referer', 'origin', 'cookie', 'x-forwarded-for', 'authorization', 'accept', 'accept-language']);
/** Rensar rubriker från listan/administratören: bara kända namn, inga radbrytningar, begränsad längd */
export function cleanHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object') return out;
  for (const [k0, v0] of Object.entries(h)) {
    let k = String(k0).trim(); const v = String(v0 ?? '').trim();
    if (/^referrer$/i.test(k)) k = 'Referer';
    if (!HDR_NAME.test(k) || !ALLOWED.has(k.toLowerCase()) || !v || v.length > 1000 || /[\r\n\0]/.test(v)) continue;
    const name = k.toLowerCase() === 'user-agent' ? 'User-Agent' : k.toLowerCase() === 'referer' ? 'Referer' : k[0].toUpperCase() + k.slice(1);
    out[name] = v;
    if (Object.keys(out).length >= 6) break;
  }
  return out;
}
/** ffmpeg-argument för rubrikerna (före -i) */
export function ffHeaders(h) {
  h = cleanHeaders(h);
  const a = [];
  if (h['User-Agent']) a.push('-user_agent', h['User-Agent']);
  if (h.Referer) a.push('-referer', h.Referer);
  const rest = Object.entries(h).filter(([k]) => k !== 'User-Agent' && k !== 'Referer');
  if (rest.length) a.push('-headers', rest.map(([k, v]) => `${k}: ${v}\r\n`).join(''));
  return a;
}

// ---------- hemligheter i adresser ----------
const SECRET_KEYS = /^(password|pass|pwd|passwd|token|key|apikey|api_key|auth|sig|signature|username|user|login|uid|mac)$/i;
/** Adress att visa för administratören: lösenord/token i frågan och Xtream-inloggning i sökvägen döljs */
export function maskUrl(u) {
  if (!u || isLocal(u)) return u || '';
  try {
    const url = new URL(u);
    if (url.username || url.password) { url.username = '•••'; url.password = ''; }
    for (const k of [...url.searchParams.keys()]) if (SECRET_KEYS.test(k)) url.searchParams.set(k, '•••');
    url.pathname = url.pathname.replace(/^\/(live|movie|series|timeshift)\/[^/]+\/[^/]+\//, '/$1/•••/•••/');
    return url.toString().replace(/%E2%80%A2/g, '•');
  } catch { return '•••'; }
}
/** Felmeddelanden från ffmpeg och leverantörer kan innehålla adresser med inloggning: bara värden visas */
export const redact = (s) => String(s ?? '').replace(/\b(https?|rtsp|rtmp|udp|rtp):\/\/[^\s"'<>]*[^\s"'<>.,:;)]/gi, (m) => { try { return `${new URL(m).host}/…`; } catch { return '…'; } });
