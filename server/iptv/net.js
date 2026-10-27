// Hämtning från IPTV-källor: M3U-listor, XMLTV-guider, Xtream-API, VOD-filer och kontroll av strömadresser före ffmpeg.
//
// Skyddet mot SSRF (servern luras att anropa något på insidan) bygger på vem som angett adressen:
//  - Adresser som administratören själv skrivit in (listan, guiden, Xtream-servern) räknas som betrodda – även
//    localhost och hemnätet (Threadfin/xTeVe/TVHeadend på samma maskin är vanligt). Bara just den värden är betrodd.
//  - Allt annat – strömadresser och guider i listan, omdirigeringar, logotyper, catch-up-adresser – är innehåll från
//    leverantören och får bara gå till publika adresser, hemnätet (om källan tillåter det, standard) eller en betrodd värd.
//    Loopback, länklokalt (169.254.169.254 = molnens metadatatjänst) och multicast spärras alltid för dem.
// Uppslaget kontrolleras i samma anslutning som görs (skydd mot DNS-rebinding). ffmpeg gör egna uppslag: där
// kontrolleras adressen strax före start (assertStream) – rimligt skydd, men inte mot ett namn som byter adress emellan.
// Alla hämtningar har tidsgränser och storleksgränser (även uppackad gzip).
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
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
