// Inbyggd Let's Encrypt-klient (ACME, RFC 8555) med HTTP-01-validering.
// Kräver att port 80 på domänen når BraXhn TV (vidarebefordra WAN 80 → Unraid:8420 i routern).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG, getSetting, setSetting } from './db.js';

const TLS = path.join(CONFIG, 'tls');
const DIRS = { prod: 'https://acme-v02.api.letsencrypt.org/directory', staging: 'https://acme-staging-v02.api.letsencrypt.org/directory' };
export const challenges = new Map(); // token → keyAuthorization
export const state = { running: false, log: [], last: null, error: null };
const log = (m) => { state.log.push(`${new Date().toLocaleTimeString('sv-SE')} ${m}`); if (state.log.length > 50) state.log.shift(); console.log('[acme]', m); };

export const b64u = (b) => Buffer.from(b).toString('base64url');

// ---------- nycklar ----------
function accountKey() {
  const f = path.join(TLS, 'acme-account.pem');
  fs.mkdirSync(TLS, { recursive: true });
  if (!fs.existsSync(f)) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    fs.writeFileSync(f, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  return crypto.createPrivateKey(fs.readFileSync(f));
}
export function jwkOf(key) {
  const j = crypto.createPublicKey(key).export({ format: 'jwk' });
  return { crv: j.crv, kty: j.kty, x: j.x, y: j.y };
}
// RFC 7638: tumavtryck över kanoniskt sorterad JWK
export const thumbprint = (jwk) => b64u(crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());

// ---------- ASN.1 DER (för CSR) ----------
const len = (n) => n < 128 ? Buffer.from([n]) : (() => { const b = []; while (n > 0) { b.unshift(n & 255); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); })();
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const oid = (s) => {
  const a = s.split('.').map(Number), out = [40 * a[0] + a[1]];
  for (const n of a.slice(2)) { const b = [n & 127]; let x = n >> 7; while (x > 0) { b.unshift((x & 127) | 128); x >>= 7; } out.push(...b); }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const octet = (b) => tlv(0x04, b);
const bitstr = (b) => tlv(0x03, Buffer.from([0]), b);

/** PKCS#10 CSR med CN och subjectAltName (DER). */
export function makeCsr(domains, key) {
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const subject = seq(set(seq(oid('2.5.4.3'), utf8(domains[0]))));
  const san = seq(...domains.map(d => tlv(0x82, Buffer.from(d, 'ascii'))));
  const exts = seq(seq(oid('2.5.29.17'), octet(san)));
  const attrs = tlv(0xa0, seq(oid('1.2.840.113549.1.9.14'), set(exts)));
  const info = seq(tlv(0x02, Buffer.from([0])), subject, spki, attrs);
  const sig = crypto.sign('sha256', info, key); // ECDSA → DER-signatur
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), bitstr(sig));
}

// ---------- ACME-protokoll ----------
class Client {
  constructor(dirUrl) { this.dirUrl = dirUrl; this.key = accountKey(); this.jwk = jwkOf(this.key); this.kid = null; this.nonce = null; }
  async init() { this.dir = await (await fetch(this.dirUrl, { signal: AbortSignal.timeout(20000) })).json(); }
  async newNonce() { const r = await fetch(this.dir.newNonce, { method: 'HEAD', signal: AbortSignal.timeout(20000) }); return r.headers.get('replay-nonce'); }
  async post(url, payload, retry = true) {
    const nonce = this.nonce || await this.newNonce();
    const prot = { alg: 'ES256', nonce, url, ...(this.kid ? { kid: this.kid } : { jwk: this.jwk }) };
    const p64 = b64u(JSON.stringify(prot)), b64 = payload === null ? '' : b64u(JSON.stringify(payload));
    const sig = crypto.sign('sha256', Buffer.from(`${p64}.${b64}`), { key: this.key, dsaEncoding: 'ieee-p1363' });
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/jose+json' }, body: JSON.stringify({ protected: p64, payload: b64, signature: b64u(sig) }), signal: AbortSignal.timeout(30000) });
    this.nonce = r.headers.get('replay-nonce');
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('json') ? await r.json() : await r.text();
    if (r.status >= 400) {
      if (retry && body?.type === 'urn:ietf:params:acme:error:badNonce') return this.post(url, payload, false);
      throw new Error(body?.detail || `ACME ${r.status}`);
    }
    return { status: r.status, headers: r.headers, body };
  }
  async poll(url, ok, fail, timeoutMs = 120000) {
    const t0 = Date.now();
    for (;;) {
      const r = await this.post(url, null);
      if (ok.includes(r.body.status)) return r.body;
      if (fail.includes(r.body.status)) throw new Error(r.body.error?.detail || JSON.stringify(r.body.challenges?.find(c => c.error)?.error || r.body.status));
      if (Date.now() - t0 > timeoutMs) throw new Error('Tidsgränsen överskreds');
      await new Promise(s => setTimeout(s, 2000));
    }
  }
}

export async function obtain(onDone) {
  if (state.running) throw new Error('Pågår redan');
  const domain = getSetting('acme_domain', process.env.ACME_DOMAIN || '').trim().toLowerCase();
  const email = getSetting('acme_email', process.env.ACME_EMAIL || '').trim();
  if (!/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) throw new Error('Ange en giltig domän, t.ex. tv.dindomän.se');
  state.running = true; state.error = null; state.log = [];
  try {
    const c = new Client(DIRS[getSetting('acme_staging', '0') === '1' ? 'staging' : 'prod']);
    await c.init();
    log(`Konto hos Let's Encrypt${getSetting('acme_staging', '0') === '1' ? ' (testmiljö)' : ''}`);
    const acc = await c.post(c.dir.newAccount, { termsOfServiceAgreed: true, ...(email ? { contact: [`mailto:${email}`] } : {}) });
    c.kid = acc.headers.get('location');
    log(`Beställer certifikat för ${domain}`);
    const order = await c.post(c.dir.newOrder, { identifiers: [{ type: 'dns', value: domain }] });
    const orderUrl = order.headers.get('location');
    for (const authUrl of order.body.authorizations) {
      const auth = (await c.post(authUrl, null)).body;
      if (auth.status === 'valid') continue;
      const ch = auth.challenges.find(x => x.type === 'http-01');
      if (!ch) throw new Error('HTTP-01 erbjuds inte');
      challenges.set(ch.token, `${ch.token}.${thumbprint(c.jwk)}`);
      log(`Validerar via http://${domain}/.well-known/acme-challenge/…`);
      await c.post(ch.url, {});
      await c.poll(authUrl, ['valid'], ['invalid', 'deactivated', 'expired', 'revoked']);
      challenges.delete(ch.token);
      log('Domänen validerad');
    }
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const csr = makeCsr([domain], privateKey);
    await c.post(order.body.finalize, { csr: b64u(csr) });
    const done = await c.poll(orderUrl, ['valid'], ['invalid']);
    const cert = (await c.post(done.certificate, null)).body;
    if (!String(cert).includes('BEGIN CERTIFICATE')) throw new Error('Inget certifikat i svaret');
    fs.writeFileSync(path.join(TLS, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(path.join(TLS, 'cert.pem'), cert);
    state.last = Date.now();
    setSetting('acme_last', String(Math.floor(Date.now() / 1000)));
    log(`Klart! Certifikatet gäller till ${new crypto.X509Certificate(cert.split(/(?=-----BEGIN CERTIFICATE-----)/)[0]).validTo}`);
    onDone?.();
  } catch (e) {
    state.error = e.message; log('Fel: ' + e.message);
    throw e;
  } finally { state.running = false; challenges.clear(); }
}

export function certInfo() {
  try {
    const pem = fs.readFileSync(path.join(TLS, 'cert.pem'), 'utf8').split(/(?=-----BEGIN CERTIFICATE-----)/)[0];
    const x = new crypto.X509Certificate(pem);
    return { subject: x.subject.replace(/\n/g, ', '), issuer: x.issuer.split('\n').find(l => l.startsWith('O=') || l.startsWith('CN='))?.replace(/^(O|CN)=/, ''),
      validTo: x.validTo, daysLeft: Math.floor((new Date(x.validTo) - Date.now()) / 86400e3), san: x.subjectAltName };
  } catch { return null; }
}

/** Förnya automatiskt när det är mindre än 30 dagar kvar (kollas två gånger per dygn). */
export function scheduleRenewal(onDone) {
  const check = () => {
    if (!getSetting('acme_domain', process.env.ACME_DOMAIN || '') || getSetting('acme_auto', '1') !== '1' || state.running) return;
    const ci = certInfo();
    if (!ci || ci.daysLeft < 30) obtain(onDone).catch(() => {});
  };
  setTimeout(check, 60e3).unref?.();
  setInterval(check, 12 * 3600e3).unref();
}
