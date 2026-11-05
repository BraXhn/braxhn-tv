// BraXhn Relay – fjärråtkomst till BraXhn TV utan portöppning, VPN eller omvänd proxy hemma.
//
// Reläet körs på en plats som nås från internet (t.ex. en VPS). Hemservern (server/relay.js) ansluter UTGÅENDE hit
// och håller en tunnel öppen; klienter (webben, apparna, Chromecast, musik- och läsappar) ansluter till reläets adress
// och varje förfrågan skickas genom tunneln till rätt hemserver.
//
// Tunneln:
//   1. Hemservern hämtar en engångsutmaning: GET /_relay/challenge → { nonce }.
//   2. GET /_relay/tunnel med Upgrade: braxhn-relay/1 och HMAC-SHA256(hemligheten, "tunnel|id|nonce|cnonce").
//      Reläet svarar 101 med sitt eget bevis HMAC(hemligheten, "relay|id|nonce|cnonce") – båda sidor visar att de
//      känner hemligheten utan att den skickas. Samma uppkoppling fungerar bakom Caddy/Nginx (vanlig HTTP-uppgradering).
//   3. Över socketen kör reläet en HTTP/2-KLIENT och hemservern en HTTP/2-SERVER. Varje klientförfrågan blir en egen
//      HTTP/2-ström (multiplexing och flödeskontroll per ström), och i strömmen går förfrågan som vanlig HTTP/1.1 –
//      hemserverns HTTP-hantering (SSE med Connection-rubriker, Range/206, uppladdningar) fungerar då oförändrad.
//      Klientens IP och protokoll skickas i HTTP/2-strömmens egna rubriker (bx-client-ip, bx-proto), som bara reläet
//      kan sätta – klienten når aldrig dem. Hemservern räknar ALLT som kommer den vägen som utanför hemmet.
//
// Parning: en engångskod (16 tecken, 15 minuter, högst tre försök) som reläet loggar vid start och utfärdar via
// sin admin. Koden skickas aldrig: hemservern och reläet gör ett X25519-nyckelutbyte som autentiseras med HMAC
// nycklad med koden, och den gemensamma hemligheten härleds med HKDF. Hemligheten sparas i reläets datafil (0600).
//
// Reläet är ingen öppen proxy: det skickar bara vidare till parade hemservrar som är anslutna just nu, aldrig till
// en adress som klienten anger. Inga npm-beroenden – bara Nodes inbyggda moduler.
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pipeline, Transform, Duplex } from 'node:stream';

const env = process.env;
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version; } catch { return '1'; } })();
const PORT = +env.RELAY_PORT || 8080;
const DATA_DIR = env.RELAY_DATA_DIR || '/data';
const DATA = path.join(DATA_DIR, 'relay.json');
const ADMIN_TOKEN = String(env.RELAY_ADMIN_TOKEN || '');
const PUBLIC_URL = String(env.RELAY_PUBLIC_URL || '').replace(/\/+$/, '');
const MAX_BODY = (+env.RELAY_MAX_BODY_MB || 512) * 1048576;       // uppladdningar (bilder, undertexter)
const RATE = +env.RELAY_RATE || 3000;                              // förfrågningar per minut och klient-IP
const MAX_PER_IP = +env.RELAY_MAX_PER_IP || 64;                    // samtidiga förfrågningar per klient-IP
const RESPONSE_TIMEOUT = (+env.RELAY_RESPONSE_TIMEOUT || 120) * 1000; // tills hemservern svarat med rubriker
const CODE_TTL = (+env.RELAY_CODE_TTL_MIN || 15) * 60e3;
const PREFIX = '/_relay/';
// Flödeskontroll: 64 kB per ström (standard i HTTP/2) räcker bara till ~1 MB/s över 50 ms fördröjning
const WIN = 4 << 20, CONN_WIN = 32 << 20;
const HEARTBEAT = +env.RELAY_HEARTBEAT_MS || 15000;

const log = (...a) => console.log(new Date().toISOString(), '[relä]', ...a);
const clean = (v, max = 120) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, max);

// ---------- datafilen: parade hemservrar ----------
let data = { servers: [] };
function load() {
  try { const d = JSON.parse(fs.readFileSync(DATA, 'utf8')); if (Array.isArray(d?.servers)) data = d; }
  catch (e) { if (e.code !== 'ENOENT') log(`Kunde inte läsa ${DATA}: ${e.message}`); }
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, DATA);
}
load();
const serverById = (id) => data.servers.find(s => s.id === id);
const secretOf = (s) => Buffer.from(s.secret, 'base64url');

// ---------- krypto ----------
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- klientens adress ----------
// Står reläet bakom Caddy/Nginx på samma maskin eller i samma Docker-nät räknas privata adresser som proxy
// (X-Forwarded-For läses från höger). RELAY_TRUSTED_PROXIES = CIDR-lista, eller "none" när reläet nås direkt.
const norm = (ip) => String(ip || '').trim().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i];
const isPrivate = (ip) => PRIVATE.some(r => r.test(norm(ip)));
function v4(ip) {
  const p = ip.split('.'); if (p.length !== 4) return null;
  let n = 0; for (const x of p) { if (!/^\d{1,3}$/.test(x) || +x > 255) return null; n = n * 256 + +x; }
  return n;
}
function inCidr(ip, cidr) {
  const [base, bits] = String(cidr).split('/');
  if (bits === undefined) return norm(ip) === norm(base);
  const a = v4(norm(ip)), b = v4(base); if (a == null || b == null) return false;
  const m = +bits === 0 ? 0 : (~0 << (32 - +bits)) >>> 0;
  return ((a & m) >>> 0) === ((b & m) >>> 0);
}
const PROXIES = String(env.RELAY_TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean);
const isProxy = (ip) => PROXIES.includes('none') ? false : PROXIES.length ? PROXIES.some(c => inCidr(ip, c)) : isPrivate(ip);
function clientOf(req) {
  const peer = norm(req.socket.remoteAddress);
  let ip = peer;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(norm).filter(Boolean);
  while (isProxy(ip) && hops.length) { const n = hops.pop(); if (!net.isIP(n)) break; ip = n; }
  const viaProxy = isProxy(peer);
  const proto = req.socket.encrypted ? 'https' : viaProxy && String(req.headers['x-forwarded-proto'] || '').split(',').pop().trim() === 'https' ? 'https' : 'http';
  const host = String((viaProxy && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim().toLowerCase();
  return { ip: net.isIP(ip) ? ip : '0.0.0.0', proto, host, hostname: host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') };
}

// ---------- begränsningar ----------
// Hink per nyckel: perMin fylls på jämnt, burst är hinkens storlek
function limiter(perMin, burst) {
  const m = new Map();
  const fill = (key) => {
    const now = Date.now();
    let b = m.get(key);
    if (!b) { if (m.size > 50000) m.clear(); b = { tokens: burst, t: now }; m.set(key, b); }
    b.tokens = Math.min(burst, b.tokens + (now - b.t) * perMin / 60000); b.t = now;
    return b;
  };
  const fn = (key) => { const b = fill(key); if (b.tokens < 1) return false; b.tokens--; return true; };
  fn.blocked = (key) => fill(key).tokens < 1; // utan att förbruka (räkna bara misslyckanden)
  setInterval(() => { const now = Date.now(); for (const [k, b] of m) if (now - b.t > 600e3) m.delete(k); }, 60e3).unref();
  return fn;
}
const allowReq = limiter(RATE, Math.max(50, RATE / 5));
const allowAuth = limiter(120, 40);    // utmaningar och tunnelförsök
const authFail = limiter(10, 10);      // misslyckade tunnel-/frånkopplingsbevis
const allowPair = limiter(5, 5);       // parningsförsök
const allowAdmin = limiter(20, 10);    // felaktiga admintoken
const perIp = new Map();

// ---------- parningskoder ----------
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 tecken utan O/0/I/1
const codes = new Map(); // de fyra första tecknen (skickas i klartext) → { key, exp, host, tries }
function newCode({ host = '' } = {}) {
  for (const [k, c] of codes) if (c.exp < Date.now()) codes.delete(k);
  let s;
  do { s = [...crypto.randomBytes(16)].map(b => ALPH[b & 31]).join(''); } while (codes.has(s.slice(0, 4)));
  const exp = Date.now() + CODE_TTL;
  codes.set(s.slice(0, 4), { key: s, exp, host: clean(host, 253).toLowerCase(), tries: 0 });
  return { code: s.match(/.{4}/g).join('-'), expires: exp };
}
function logCode(why) {
  const c = newCode();
  log(`${why}: parningskod ${c.code} (gäller ${Math.round(CODE_TTL / 60e3)} minuter, en gång). Ange den i BraXhn TV → Administration → Fjärråtkomst via relä.`);
}

// ---------- tunnlarna ----------
const tunnels = new Map(); // server-id → { session, sock, ip, since, requests, active }
const nonces = new Map();  // engångsutmaningar → { server, exp }
const traffic = new Map(); // server-id → { in, out } från stängda tunnlar
function trafficOf(id) {
  const base = traffic.get(id) || { in: 0, out: 0 }, t = tunnels.get(id);
  return { in: base.in + (t ? t.sock.bytesRead : 0), out: base.out + (t ? t.sock.bytesWritten : 0) };
}
function attachTunnel(s, sock, ip) {
  sock.setNoDelay?.(true); sock.setKeepAlive?.(true, 30e3); sock.setTimeout?.(0);
  const session = http2.connect('http://braxhn-home', {
    createConnection: () => sock, maxSessionMemory: 64,
    settings: { initialWindowSize: WIN, enablePush: false }
  });
  const t = { id: s.id, session, sock, ip, since: Date.now(), requests: 0, active: 0 };
  session.on('connect', () => { try { session.setLocalWindowSize(CONN_WIN); } catch {} });
  session.on('error', (e) => log(`Tunneln till ${clean(s.name)} (${s.id}): ${e.code || e.message}`));
  session.on('close', () => {
    clearInterval(t.ping);
    const b = traffic.get(s.id) || { in: 0, out: 0 }; b.in += sock.bytesRead; b.out += sock.bytesWritten; traffic.set(s.id, b);
    if (tunnels.get(s.id) === t) { tunnels.delete(s.id); log(`${clean(s.name)} (${s.id}) frånkopplad`); }
    sock.destroy();
  });
  // Hjärtslag: ett uteblivet svar inom 10 s stänger tunneln (hemservern ansluter igen)
  t.ping = setInterval(() => {
    if (session.destroyed) return;
    const to = setTimeout(() => session.destroy(new Error('hjärtslaget uteblev')), 10e3);
    try { session.ping((err) => { clearTimeout(to); if (err && !session.destroyed) session.destroy(err); }); } catch { clearTimeout(to); session.destroy(); }
  }, HEARTBEAT);
  t.ping.unref();
  const old = tunnels.get(s.id);
  tunnels.set(s.id, t);
  // En ny tunnel från samma server ersätter den gamla (t.ex. efter ett nätverksbyte); pågående förfrågningar får avslutas
  if (old) { old.session.close(); setTimeout(() => old.session.destroy(), 30e3).unref(); }
  s.lastSeen = Date.now();
  log(`${clean(s.name)} (${s.id}) ansluten från ${ip}`);
}
function pickServer(hostname) {
  const byHost = data.servers.find(s => (s.hosts || []).includes(hostname));
  if (byHost) return byHost;
  // En enda parad server nås på alla adresser som pekar på reläet
  return data.servers.length === 1 ? data.servers[0] : null;
}

// ---------- svar ----------
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
function json(res, code, body, extra = {}) {
  if (res.headersSent) return res.destroy();
  const b = JSON.stringify(body);
  res.writeHead(code, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b), ...extra });
  res.end(b);
}
function page(req, res, code, msg) {
  if (res.headersSent) return res.destroy();
  const p = String(req.url || '');
  if (p.startsWith('/api/') || p.startsWith('/rest/') || p.startsWith(PREFIX)) return json(res, code, { error: msg });
  const b = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BraXhn Relay</title>
<body style="font:16px system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px">
<main style="max-width:32rem"><h1 style="font-size:1.25rem">BraXhn TV nås inte just nu</h1><p>${msg.replace(/[<>&]/g, '')}</p></main>`;
  res.writeHead(code, { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}
async function readJson(req, limit = 16384) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('För stor förfrågan'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Ogiltig JSON'), { status: 400 }); }
}

// HTTP/1.1 över en HTTP/2-ström. Strömmen ges inte direkt till http-modulen: den skriver rubrikerna som en sträng i
// writev, och sådana strängar kunde skrivas över innan de skickats på en Http2Stream (rubrikraden kom fram som skräp).
// Här blir allt Buffer (decodeStrings) och mottrycket följer strömmen åt båda hållen (pause/drain).
class Tunnelled extends Duplex {
  constructor(st) {
    super();
    this.st = st;
    st.on('data', (d) => { if (!this.push(d)) st.pause(); });
    st.on('end', () => this.push(null));
    st.on('error', () => {});
    st.on('close', () => { if (!this.destroyed) this.destroy(); });
    st.on('timeout', () => this.emit('timeout'));
    st.pause();
  }
  _read() { this.st.resume(); }
  _write(chunk, enc, cb) {
    const st = this.st;
    if (st.destroyed) return cb(new Error('Strömmen är stängd'));
    if (st.write(chunk)) return cb();
    const go = () => { st.off('drain', go); st.off('close', go); cb(); };
    st.on('drain', go); st.on('close', go);
  }
  _final(cb) { this.st.end(); cb(); }
  _destroy(err, cb) { if (!this.st.destroyed) this.st.destroy(); cb(err); }
  setTimeout(ms, cb) { this.st.setTimeout(ms); if (cb) this.once('timeout', cb); return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
}

// ---------- vidarebefordran till hemservern ----------
// Rubriker som bara gäller en anslutning (RFC 9110 7.6.1) och sådant klienten aldrig får bestämma själv
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'http2-settings', 'expect']);
const UNTRUSTED = /^(x-forwarded-|forwarded$|x-real-ip$|x-braxhn-|bx-)/;
function filterHeaders(h, { request }) {
  const conn = String(h.connection || '').toLowerCase().split(',').map(s => s.trim());
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.startsWith(':') || HOP.has(k) || conn.includes(k) || (request && UNTRUSTED.test(k))) continue;
    out[k] = v;
  }
  return out;
}
function forward(req, res, cl) {
  // Bara vanliga sökvägar: absoluta adresser (proxyform) och * skickas aldrig vidare
  if (!String(req.url).startsWith('/')) return page(req, res, 400, 'Ogiltig adress.');
  const s = pickServer(cl.hostname);
  if (!s) return page(req, res, 404, 'Den här adressen hör inte till någon BraXhn TV-server på reläet.');
  const t = tunnels.get(s.id);
  if (!t || t.session.destroyed || t.session.closed) return page(req, res, 502, 'Hemservern är inte ansluten till reläet just nu. Kontrollera att BraXhn TV är igång och har internet – den ansluter igen av sig själv.');
  if (+req.headers['content-length'] > MAX_BODY) return page(req, res, 413, 'Förfrågan är för stor för reläet.');
  const n = perIp.get(cl.ip) || 0;
  if (n >= MAX_PER_IP || !allowReq(cl.ip)) return page(req, res, 429, 'För många förfrågningar – vänta en stund.');
  perIp.set(cl.ip, n + 1);
  t.requests++; t.active++;
  let done = false;
  const finish = () => {
    if (done) return; done = true; t.active--;
    const m = (perIp.get(cl.ip) || 1) - 1; if (m <= 0) perIp.delete(cl.ip); else perIp.set(cl.ip, m);
  };
  let st;
  try { st = t.session.request({ ':method': 'POST', ':path': '/_tunnel', 'bx-client-ip': cl.ip, 'bx-proto': cl.proto }, { endStream: false }); }
  catch { finish(); return page(req, res, 502, 'Hemservern är inte ansluten till reläet just nu.'); }
  st.on('error', () => {});
  st.on('response', (h) => { if (h[':status'] !== 200) st.destroy(); });
  const headers = filterHeaders(req.headers, { request: true });
  headers.host = cl.host || 'braxhn';
  headers.connection = 'close';
  const up = http.request({ method: req.method, path: req.url, headers, setHost: false, createConnection: () => new Tunnelled(st) });
  const rt = setTimeout(() => { up.destroy(new Error('timeout')); if (!res.headersSent) page(req, res, 504, 'Hemservern svarade inte i tid.'); }, RESPONSE_TIMEOUT);
  up.on('response', (ur) => {
    clearTimeout(rt);
    if (res.destroyed) { ur.destroy(); return; }
    res.writeHead(ur.statusCode, ur.statusMessage, filterHeaders(ur.headers, { request: false }));
    res.flushHeaders?.();
    // pipeline följer mottrycket: läser klienten långsamt stannar strömmen i tunneln (flödeskontroll per ström)
    pipeline(ur, res, () => {});
  });
  // RELAY_DEBUG loggar sökvägen utan frågedelen (?t= kan vara en token)
  up.on('error', (e) => { if (env.RELAY_DEBUG) log('uppströms:', e.message, clean(String(req.url).split('?')[0])); clearTimeout(rt); if (!res.headersSent) page(req, res, 502, 'Anslutningen till hemservern bröts.'); else res.destroy(); });
  res.on('close', () => { clearTimeout(rt); finish(); if (!res.writableFinished) { up.destroy(); st.destroy(); } });
  let size = 0;
  const cap = new Transform({ transform(ch, _, cb) { size += ch.length; if (size > MAX_BODY) return cb(Object.assign(new Error('för stor'), { tooBig: true })); cb(null, ch); } });
  pipeline(req, cap, up, (e) => { if (e?.tooBig) { if (!res.headersSent) page(req, res, 413, 'Förfrågan är för stor för reläet.'); up.destroy(); } });
}

// ---------- reläets egna adresser (/_relay/…) ----------
const ADMIN_HTML = fs.readFileSync(new URL('./admin.html', import.meta.url));
const ADMIN_JS = fs.readFileSync(new URL('./admin.js', import.meta.url));
const adminOk = (req) => ADMIN_TOKEN.length >= 16 && crypto.timingSafeEqual(sha(/^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || ''), sha(ADMIN_TOKEN));
function serverInfo(s) {
  const t = tunnels.get(s.id), b = trafficOf(s.id);
  return { id: s.id, name: s.name, hosts: s.hosts || [], created: s.created, lastSeen: t ? Date.now() : s.lastSeen || null,
    connected: !!t, since: t?.since || null, ip: t?.ip || null, requests: t?.requests || 0, active: t?.active || 0, bytesToHome: b.in, bytesFromHome: b.out };
}
async function internal(req, res, cl, p) {
  if (p === PREFIX + 'health') return json(res, 200, { ok: true, version: VERSION });
  if (p === PREFIX + 'admin' && req.method === 'GET') {
    res.writeHead(200, { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY' });
    return res.end(ADMIN_HTML);
  }
  if (p === PREFIX + 'admin.js' && req.method === 'GET') { res.writeHead(200, { ...SEC, 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(ADMIN_JS); }

  // Engångsutmaning för tunneln och frånkopplingen (60 s)
  if (p === PREFIX + 'challenge' && req.method === 'GET') {
    if (!allowAuth(cl.ip)) return json(res, 429, { error: 'För många försök' });
    if (nonces.size > 2000) for (const [k, v] of nonces) if (v.exp < Date.now()) nonces.delete(k);
    if (nonces.size > 5000) return json(res, 503, { error: 'Försök igen om en stund' });
    const nonce = crypto.randomBytes(24).toString('hex');
    nonces.set(nonce, { server: new URL(req.url, 'http://x').searchParams.get('server') || '', exp: Date.now() + 60e3 });
    return json(res, 200, { nonce, version: VERSION });
  }
  // Parning: X25519 + HMAC med koden (koden själv skickas aldrig)
  if (p === PREFIX + 'pair' && req.method === 'POST') {
    if (!allowPair(cl.ip)) return json(res, 429, { error: 'För många parningsförsök – vänta en stund' });
    const b = await readJson(req);
    const codeId = String(b.codeId || '').toUpperCase(), c = codes.get(codeId);
    const name = clean(b.name || 'BraXhn TV', 60), pub = String(b.pub || '');
    if (!c || c.exp < Date.now()) return json(res, 403, { error: 'Parningskoden är ogiltig eller har gått ut – skapa en ny på reläet' });
    if (!/^[\w-]{43}$/.test(pub) || !same(String(b.mac || ''), hmac(c.key, `pair1|${codeId}|${pub}|${name}`))) {
      if (++c.tries >= 3) codes.delete(codeId);
      log(`Misslyckat parningsförsök från ${cl.ip}`);
      return json(res, 403, { error: 'Parningskoden är ogiltig eller har gått ut – skapa en ny på reläet' });
    }
    codes.delete(codeId);
    const kp = crypto.generateKeyPairSync('x25519');
    const shared = crypto.diffieHellman({ privateKey: kp.privateKey, publicKey: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: pub }, format: 'jwk' }) });
    let id; do { id = crypto.randomBytes(9).toString('base64url'); } while (serverById(id));
    const secret = Buffer.from(crypto.hkdfSync('sha256', shared, c.key, 'braxhn-relay|' + id, 32));
    const rpub = kp.publicKey.export({ format: 'jwk' }).x;
    const url = PUBLIC_URL || (c.host ? `${cl.proto}://${c.host}` : `${cl.proto}://${cl.host}`);
    // Adressen servern nås på: den som angavs när koden skapades, annars adressen parningen kom in på (om den är ledig)
    const host = c.host || (data.servers.some(s => (s.hosts || []).includes(cl.hostname)) ? '' : cl.hostname);
    data.servers.push({ id, name, secret: secret.toString('base64url'), hosts: host ? [host] : [], created: Date.now() });
    try { save(); } catch (e) { data.servers = data.servers.filter(s => s.id !== id); log(`Kunde inte spara ${DATA}: ${e.message}`); return json(res, 500, { error: 'Reläet kunde inte spara parningen (datamappen går inte att skriva i)' }); }
    log(`${name} (${id}) parad från ${cl.ip}`);
    return json(res, 200, { server: id, pub: rpub, url, version: VERSION, mac: hmac(c.key, `pair2|${id}|${rpub}|${pub}|${url}`) });
  }
  // Hemservern kopplar bort sig (Administration → Koppla bort): bevisad med hemligheten och en utmaning
  if (p === PREFIX + 'unpair' && req.method === 'POST') {
    if (!allowAuth(cl.ip)) return json(res, 429, { error: 'För många försök' });
    const b = await readJson(req);
    const s = serverById(String(b.server || '')), n = nonces.get(String(b.nonce || ''));
    if (n) nonces.delete(String(b.nonce));
    if (authFail.blocked(cl.ip)) return json(res, 429, { error: 'För många försök' });
    if (!s || !n || n.exp < Date.now() || n.server !== s.id || !same(String(b.proof || ''), hmac(secretOf(s), `unpair|${s.id}|${b.nonce}|${b.cnonce}`))) { authFail(cl.ip); return json(res, 401, { error: 'Nekad' }); }
    removeServer(s.id);
    return json(res, 200, { ok: true });
  }
  // Admin (RELAY_ADMIN_TOKEN)
  if (p.startsWith(PREFIX + 'api/')) {
    if (ADMIN_TOKEN.length < 16) return json(res, 403, { error: 'Admin är avstängd – sätt RELAY_ADMIN_TOKEN (minst 16 tecken)' });
    if (!adminOk(req)) { if (!allowAdmin(cl.ip)) return json(res, 429, { error: 'För många försök' }); return json(res, 401, { error: 'Fel admintoken' }); }
    let origin = cl.host; try { if (req.headers.origin) origin = new URL(req.headers.origin).host; } catch { origin = ''; }
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && origin !== cl.host) return json(res, 403, { error: 'Annan webbplats' });
    const sub = p.slice(PREFIX.length + 4);
    if (sub === 'status' && req.method === 'GET') return json(res, 200, { version: VERSION, uptime: Math.round(process.uptime()), rss: process.memoryUsage().rss, servers: data.servers.map(serverInfo) });
    if (sub === 'codes' && req.method === 'POST') { const b = await readJson(req); return json(res, 200, newCode({ host: b.host || '' })); }
    const m = /^servers\/([\w-]+)$/.exec(sub);
    if (m && serverById(m[1])) {
      if (req.method === 'DELETE') { removeServer(m[1]); return json(res, 200, { ok: true }); }
      if (req.method === 'PUT') {
        const b = await readJson(req);
        const hosts = (Array.isArray(b.hosts) ? b.hosts : []).map(h => clean(h, 253).trim().toLowerCase()).filter(h => /^[a-z0-9.-]+$/.test(h)).slice(0, 10);
        if (hosts.some(h => data.servers.some(s => s.id !== m[1] && (s.hosts || []).includes(h)))) return json(res, 409, { error: 'Adressen används redan av en annan server' });
        serverById(m[1]).hosts = hosts; save();
        return json(res, 200, serverInfo(serverById(m[1])));
      }
    }
  }
  return json(res, 404, { error: 'Okänd adress' });
}
function removeServer(id) {
  const s = serverById(id);
  data.servers = data.servers.filter(x => x.id !== id); save();
  const t = tunnels.get(id); tunnels.delete(id); t?.session.destroy();
  log(`${clean(s?.name)} (${id}) borttagen från reläet`);
}

// ---------- HTTP(S)-servern ----------
async function onRequest(req, res) {
  let cl, p;
  try { cl = clientOf(req); p = new URL(req.url, 'http://x').pathname; } catch { return json(res, 400, { error: 'Ogiltig adress' }); }
  if (p.startsWith(PREFIX)) {
    try { return await internal(req, res, cl, p); }
    catch (e) { if (!e.status) log('Fel:', e.message); return json(res, e.status || 500, { error: e.status ? e.message : 'Internt fel' }); }
  }
  forward(req, res, cl);
}
function onUpgrade(req, sock, head) {
  sock.on('error', () => {});
  const reject = (code, text) => { sock.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  let cl, p;
  try { cl = clientOf(req); p = new URL(req.url, 'http://x').pathname; } catch { return reject(400, 'Bad Request'); }
  // Bara tunneln uppgraderas (hemservern använder inga WebSockets)
  if (p !== PREFIX + 'tunnel' || String(req.headers.upgrade || '').toLowerCase() !== 'braxhn-relay/1') return reject(501, 'Not Implemented');
  if (!allowAuth(cl.ip) || authFail.blocked(cl.ip)) return reject(429, 'Too Many Requests');
  const id = String(req.headers['x-braxhn-server'] || ''), nonce = String(req.headers['x-braxhn-nonce'] || ''), cn = String(req.headers['x-braxhn-cnonce'] || '');
  const s = serverById(id), n = nonces.get(nonce);
  if (n) nonces.delete(nonce);
  if (!s || !n || n.exp < Date.now() || n.server !== id || !/^[0-9a-f]{32}$/.test(cn) || !same(String(req.headers['x-braxhn-proof'] || ''), hmac(secretOf(s), `tunnel|${id}|${nonce}|${cn}`))) {
    authFail(cl.ip);
    log(`Nekad tunnel från ${cl.ip}${s ? ` för ${clean(s.name)}` : ''}`);
    return reject(401, 'Unauthorized');
  }
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: braxhn-relay/1\r\nX-BraXhn-Proof: ${hmac(secretOf(s), `relay|${id}|${nonce}|${cn}`)}\r\n\r\n`);
  if (head?.length) sock.unshift(head);
  attachTunnel(s, sock, cl.ip);
}
function harden(srv) {
  srv.headersTimeout = 20000;
  srv.requestTimeout = 30 * 60e3; // hela förfrågan inklusive uppladdning – svar (strömmar) begränsas inte
  srv.keepAliveTimeout = 15000;
  srv.maxHeadersCount = 100;
  srv.on('request', (req, res) => onRequest(req, res).catch(() => { try { res.destroy(); } catch {} }));
  srv.on('upgrade', onUpgrade);
  srv.on('clientError', (e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {} });
  return srv;
}
let server;
if (env.RELAY_TLS_CERT && env.RELAY_TLS_KEY) {
  const tls = () => ({ cert: fs.readFileSync(env.RELAY_TLS_CERT), key: fs.readFileSync(env.RELAY_TLS_KEY) });
  server = harden(https.createServer({ ...tls(), minVersion: 'TLSv1.2', maxHeaderSize: 16384 }));
  // Förnyade certifikat (t.ex. från certbot) läses in var 6:e timme och vid SIGHUP
  const reload = () => { try { server.setSecureContext(tls()); } catch (e) { log('Kunde inte läsa certifikatet:', e.message); } };
  setInterval(reload, 6 * 3600e3).unref();
  process.on('SIGHUP', reload);
} else server = harden(http.createServer({ maxHeaderSize: 16384 }));

server.listen(PORT, env.RELAY_BIND || undefined, () => {
  log(`BraXhn Relay ${VERSION} lyssnar på port ${PORT} (${env.RELAY_TLS_CERT ? 'https' : 'http'}), ${data.servers.length} parade servrar`);
  if (ADMIN_TOKEN && ADMIN_TOKEN.length < 16) log('RELAY_ADMIN_TOKEN är för kort (minst 16 tecken) – admin är avstängd');
  if (!ADMIN_TOKEN || !data.servers.length) logCode('Start');
});
// Ny parningskod utan omstart: docker kill -s HUP braxhn-relay
process.on('SIGHUP', () => logCode('SIGHUP'));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  for (const t of tunnels.values()) t.session.destroy();
  server.close(); process.exit(0);
});
