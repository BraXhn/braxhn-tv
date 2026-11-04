// Fjärråtkomst via BraXhn Relay (relay/server.js): hemservern ansluter UTGÅENDE till reläet och tar emot
// klienternas förfrågningar genom tunneln – ingen portöppning, VPN eller omvänd proxy hemma.
//
// Tunneln: utmaning (GET /_relay/challenge) → HTTP-uppgradering med HMAC-bevis åt båda hållen → HTTP/2 där reläet är
// klient och hemservern server. Varje förfrågan är en egen HTTP/2-ström som bär vanlig HTTP/1.1; strömmen lämnas till
// en egen http.Server med samma handle() som resten av servern (emit('connection')), så allt fungerar som vanligt.
//
// SÄKERHET: allt som kommer genom tunneln räknas som UTANFÖR hemmet. Strömmen märks med RELAY (util.js) och
// klientens adress från reläet (bx-client-ip i HTTP/2-strömmens rubriker, som bara reläet kan sätta). clientIp()
// ger då den adressen (inloggningsspärrar och loggar), isTrusted()/isLocalReq() ger alltid false och X-Forwarded-*
// från klienten tas bort – även om tunneln kommer från localhost eller klienten uppger en privat adress.
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { Duplex } from 'node:stream';
import { getSetting, setSetting } from './db.js';
import { RELAY, isPrivate } from './util.js';

const K = { url: 'relay_url', id: 'relay_server', secret: 'relay_secret', pub: 'relay_public_url', name: 'relay_name' };
const WIN = 4 << 20, CONN_WIN = 32 << 20;
const HEARTBEAT = +process.env.RELAY_HEARTBEAT_MS || 15000;
const MAX_DELAY = 60e3;

export const state = { connected: false, connecting: false, since: 0, lastError: '', lastErrorAt: 0, nextRetryAt: 0, reconnects: 0, requests: 0, active: 0, bytesIn: 0, bytesOut: 0 };
let handler = null, session = null, sock = null, timer = null, stopped = true, attempt = 0, gen = 0;

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ufail = (status, msg) => Object.assign(new Error(msg), { status });

export const paired = () => !!(getSetting(K.url) && getSetting(K.id) && getSetting(K.secret));

/** Reläets adress: bara http(s), bara origin (ingen sökväg, inga inloggningsuppgifter i adressen) */
export function normUrl(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { throw ufail(400, 'Ange reläets adress, t.ex. https://tv.example.com'); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw ufail(400, 'Reläets adress ska börja med https:// (eller http:// för test)');
  return u.origin;
}
const insecure = (url) => { try { const u = new URL(url); return u.protocol === 'http:' && !isPrivate(u.hostname) && u.hostname !== 'localhost'; } catch { return false; } };

// ---------- HTTP mot reläet (utan tunnel) ----------
function call(url, method, p, body) {
  return new Promise((ok, no) => {
    const u = new URL(p, url), mod = u.protocol === 'https:' ? https : http;
    const b = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = mod.request(u, { method, timeout: 15000, headers: { Accept: 'application/json', ...(b ? { 'Content-Type': 'application/json', 'Content-Length': b.length } : {}) } }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 65536) r.destroy(new Error('för stort svar')); else chunks.push(c); });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (res.statusCode !== 200 || !j) return no(ufail(res.statusCode === 403 || res.statusCode === 401 ? 400 : 502, j?.error ? `Reläet: ${j.error}` : `Reläet svarade ${res.statusCode} – är adressen rätt?`));
        ok(j);
      });
    });
    r.on('timeout', () => r.destroy(new Error('Reläet svarade inte i tid')));
    r.on('error', (e) => no(ufail(502, `Kunde inte nå reläet: ${e.code === 'ENOTFOUND' ? 'adressen finns inte' : e.message}`)));
    r.end(b);
  });
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

// ---------- strömmarna från reläet ----------
let inner = null, h2 = null;
const UNTRUSTED = /^(x-forwarded-|forwarded$|x-real-ip$)/;
function servers() {
  if (h2) return h2;
  // Samma skydd som de vanliga servrarna (server/index.js)
  inner = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    for (const k of Object.keys(req.headers)) if (UNTRUSTED.test(k)) delete req.headers[k];
    state.requests++; state.active++;
    res.once('close', () => { state.active--; });
    Promise.resolve().then(() => handler(req, res)).catch((e) => { console.error(e); try { if (!res.headersSent) res.writeHead(500); res.end(); } catch {} });
  });
  Object.assign(inner, { headersTimeout: 20000, requestTimeout: 60000, keepAliveTimeout: 5000, timeout: 180000, maxHeadersCount: 100 });
  h2 = http2.createServer({ maxSessionMemory: 64, settings: { initialWindowSize: WIN, maxConcurrentStreams: 256, enablePush: false } });
  h2.on('session', (s) => { try { s.setLocalWindowSize(CONN_WIN); } catch {} });
  h2.on('stream', (st, hd) => {
    st.on('error', () => {});
    if (hd[':method'] !== 'POST' || hd[':path'] !== '/_tunnel') return st.close(http2.constants.NGHTTP2_REFUSED_STREAM);
    const ip = String(hd['bx-client-ip'] || '').replace(/^::ffff:/, '');
    st.respond({ ':status': 200 });
    const sockLike = new Tunnelled(st);
    sockLike[RELAY] = { ip: net.isIP(ip) ? ip : '0.0.0.0', https: hd['bx-proto'] === 'https' };
    // Egen adress saknas: aldrig privat, aldrig en betrodd proxy (isPrivate(req.socket.remoteAddress) i routerna)
    sockLike.remoteAddress = '';
    inner.emit('connection', sockLike);
  });
  return h2;
}

// ---------- tunneln ----------
function upgrade(url, headers) {
  return new Promise((ok, no) => {
    const u = new URL('/_relay/tunnel', url), mod = u.protocol === 'https:' ? https : http;
    const r = mod.request(u, { headers: { Connection: 'Upgrade', Upgrade: 'braxhn-relay/1', ...headers }, timeout: 15000 });
    r.on('upgrade', (res, socket, head) => { r.setTimeout(0); ok({ res, socket, head }); });
    r.on('response', (res) => { res.resume(); no(ufail(res.statusCode, res.statusCode === 401 ? 'Reläet känner inte igen servern – para om (koden kan ha tagits bort på reläet)' : `Reläet svarade ${res.statusCode}`)); });
    r.on('timeout', () => r.destroy(new Error('Reläet svarade inte i tid')));
    r.on('error', (e) => no(e));
    r.end();
  });
}
function failed(e) {
  state.lastError = e.code === 'ECONNREFUSED' ? 'Reläet tar inte emot anslutningar (är det igång?)' : e.code === 'ENOTFOUND' ? 'Reläets adress hittades inte (DNS)' : String(e.message || e).slice(0, 200);
  state.lastErrorAt = Date.now();
}
function schedule(min = 0) {
  clearTimeout(timer);
  if (stopped) return;
  const d = Math.max(min, Math.min(MAX_DELAY, 1000 * 2 ** attempt)) * (1 + Math.random() * 0.3);
  attempt = Math.min(attempt + 1, 10);
  state.nextRetryAt = Date.now() + d;
  timer = setTimeout(connect, d); timer.unref();
}
async function connect() {
  clearTimeout(timer);
  if (stopped || session || state.connecting) return;
  const g = gen;
  const url = getSetting(K.url), id = getSetting(K.id), secret = Buffer.from(getSetting(K.secret, ''), 'base64url');
  state.connecting = true; state.nextRetryAt = 0;
  let up;
  try {
    const { nonce } = await call(url, 'GET', `/_relay/challenge?server=${encodeURIComponent(id)}`);
    const cn = crypto.randomBytes(16).toString('hex');
    up = await upgrade(url, { 'X-BraXhn-Server': id, 'X-BraXhn-Nonce': String(nonce), 'X-BraXhn-Cnonce': cn, 'X-BraXhn-Proof': hmac(secret, `tunnel|${id}|${nonce}|${cn}`) });
    if (!same(String(up.res.headers['x-braxhn-proof'] || ''), hmac(secret, `relay|${id}|${nonce}|${cn}`))) throw new Error('Reläet kunde inte bevisa att det är det parade reläet');
    if (g !== gen || stopped) throw new Error('avbruten');
  } catch (e) {
    up?.socket.destroy();
    if (g !== gen) return; // bortkopplad eller ny anslutning under tiden
    state.connecting = false;
    failed(e);
    return schedule(e.status === 401 ? 5 * 60e3 : 0);
  }
  state.connecting = false;
  attach(up.socket, up.head, g);
}
function attach(socket, head, g) {
  socket.setNoDelay?.(true); socket.setKeepAlive?.(true, 30e3); socket.setTimeout?.(0);
  socket.on('error', () => {});
  if (head?.length) socket.unshift(head);
  let s = null;
  const srv = servers();
  srv.once('session', (x) => { s = x; });
  srv.emit('connection', socket);
  if (!s) { socket.destroy(); failed(new Error('HTTP/2-sessionen startade inte')); return schedule(); }
  session = s; sock = socket;
  Object.assign(state, { connected: true, since: Date.now(), lastError: '', nextRetryAt: 0 });
  console.log(`[relä] ansluten till ${getSetting(K.url)}`);
  const ping = setInterval(() => {
    if (s.destroyed) return;
    const to = setTimeout(() => s.destroy(new Error('Hjärtslaget från reläet uteblev')), 10e3);
    try { s.ping((err) => { clearTimeout(to); if (err && !s.destroyed) s.destroy(err); }); } catch { clearTimeout(to); s.destroy(); }
  }, HEARTBEAT);
  ping.unref();
  s.on('error', (e) => failed(e));
  s.on('close', () => {
    clearInterval(ping);
    state.bytesIn += socket.bytesRead; state.bytesOut += socket.bytesWritten;
    socket.destroy();
    if (session !== s) return;
    const lasted = Date.now() - state.since;
    session = null; sock = null; state.connected = false;
    if (g !== gen) return;
    state.reconnects++;
    if (!state.lastError) { state.lastError = 'Tunneln stängdes'; state.lastErrorAt = Date.now(); }
    console.warn(`[relä] frånkopplad: ${state.lastError} – ansluter igen`);
    if (lasted > 30e3) attempt = 0; // en tunnel som höll en stund: försök direkt igen
    schedule();
  });
}

// ---------- livscykel ----------
/** Startas från app.js med handle(); ansluter om servern är parad */
export function start(h) { handler = h; if (paired()) { stopped = false; connect(); } }
function disconnect() {
  gen++; stopped = true; clearTimeout(timer); attempt = 0;
  const s = session; session = null; sock = null;
  Object.assign(state, { connected: false, connecting: false, nextRetryAt: 0 });
  s?.destroy();
}
/** Anslut direkt igen (Administration → Anslut nu) */
export function reconnect() {
  if (!paired()) return;
  disconnect(); stopped = false; connect();
}

/**
 * Parning med en engångskod från reläet. X25519-nycklar byts och autentiseras med HMAC nycklad med koden; den gemensamma
 * hemligheten härleds med HKDF på båda sidor – varken koden eller hemligheten skickas över nätet.
 */
export async function pair(rawUrl, rawCode, name = os.hostname()) {
  const url = normUrl(rawUrl);
  const key = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-HJ-NP-Z2-9]{16}$/.test(key)) throw ufail(400, 'Parningskoden ska vara 16 tecken, t.ex. ABCD-EFGH-JKLM-NPQR');
  name = String(name || 'BraXhn TV').replace(/[\u0000-\u001f]/g, '').slice(0, 60) || 'BraXhn TV';
  const codeId = key.slice(0, 4);
  const kp = crypto.generateKeyPairSync('x25519');
  const pub = kp.publicKey.export({ format: 'jwk' }).x;
  const r = await call(url, 'POST', '/_relay/pair', { codeId, pub, name, mac: hmac(key, `pair1|${codeId}|${pub}|${name}`) });
  if (!/^[\w-]{6,40}$/.test(String(r.server)) || !/^[\w-]{43}$/.test(String(r.pub)) || !same(String(r.mac || ''), hmac(key, `pair2|${r.server}|${r.pub}|${pub}|${r.url}`)))
    throw ufail(502, 'Reläets svar kunde inte verifieras – är det rätt relä?');
  const shared = crypto.diffieHellman({ privateKey: kp.privateKey, publicKey: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: r.pub }, format: 'jwk' }) });
  const secret = Buffer.from(crypto.hkdfSync('sha256', shared, key, 'braxhn-relay|' + r.server, 32));
  const old = paired() ? { url: getSetting(K.url), id: getSetting(K.id), secret: getSetting(K.secret) } : null;
  disconnect();
  // Parad om: den gamla parningen glöms på (det gamla) reläet, annars ligger den kvar där och tar adressen
  if (old) await forget(old);
  let pubUrl = ''; try { pubUrl = normUrl(r.url); } catch {}
  setSetting(K.url, url); setSetting(K.id, String(r.server)); setSetting(K.secret, secret.toString('base64url'));
  setSetting(K.pub, pubUrl); setSetting(K.name, name);
  Object.assign(state, { lastError: '', lastErrorAt: 0, reconnects: 0, requests: 0, bytesIn: 0, bytesOut: 0 });
  stopped = false; connect();
  return status();
}

/** Be reläet glömma servern (bevisat med hemligheten och en utmaning); false om reläet inte nås */
async function forget({ url, id, secret }) {
  try {
    const { nonce } = await call(url, 'GET', `/_relay/challenge?server=${encodeURIComponent(id)}`);
    const cn = crypto.randomBytes(16).toString('hex');
    await call(url, 'POST', '/_relay/unpair', { server: id, nonce, cnonce: cn, proof: hmac(Buffer.from(secret, 'base64url'), `unpair|${id}|${nonce}|${cn}`) });
    return true;
  } catch { return false; }
}

/** Koppla bort: tunneln stängs, reläet glömmer servern (om det nås) och hemligheten raderas här */
export async function unpair() {
  const url = getSetting(K.url), id = getSetting(K.id), secret = getSetting(K.secret);
  disconnect();
  const forgotten = url && id && secret ? await forget({ url, id, secret }) : false;
  for (const k of Object.values(K)) setSetting(k, '');
  Object.assign(state, { lastError: '', lastErrorAt: 0, reconnects: 0 });
  return { ...status(), relayForgot: forgotten };
}

/** Status för Administration (hemligheten lämnas aldrig ut) */
export function status() {
  const url = getSetting(K.url, '');
  return {
    paired: paired(), url, publicUrl: getSetting(K.pub, '') || url, serverId: getSetting(K.id, ''), name: getSetting(K.name, ''),
    insecure: insecure(url), connected: state.connected, connecting: state.connecting, since: state.since || null,
    lastError: state.lastError, lastErrorAt: state.lastErrorAt || null, nextRetryAt: state.nextRetryAt || null, reconnects: state.reconnects,
    requests: state.requests, active: state.active,
    bytesIn: state.bytesIn + (sock?.bytesRead || 0), bytesOut: state.bytesOut + (sock?.bytesWritten || 0)
  };
}
