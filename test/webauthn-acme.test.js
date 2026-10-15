// Passkeys med en mjukvaru-autentiserare + ACME-delar (CSR, JWS, tumavtryck)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-wa-'));
process.env.TRANSCODE_DIR = path.join(process.env.CONFIG_DIR, 'tc');
const { run } = await import('../server/db.js');
const pk = await import('../server/passkeys.js');
const acme = await import('../server/acme.js');

// ---------- minimal CBOR-kodare för testerna ----------
function cbor(v) {
  const head = (mt, n) => n < 24 ? Buffer.from([(mt << 5) | n]) : n < 256 ? Buffer.from([(mt << 5) | 24, n]) : n < 65536 ? Buffer.from([(mt << 5) | 25, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(5); b[0] = (mt << 5) | 26; b.writeUInt32BE(n, 1); return b; })();
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('typ');
}

class SoftAuthenticator {
  constructor() { this.keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); this.credId = crypto.randomBytes(16); this.count = 0; }
  authData(rpId, withCred) {
    const flags = 0x01 | 0x04 | (withCred ? 0x40 : 0);
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(++this.count);
    const parts = [crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags]), cnt];
    if (withCred) {
      const j = this.keys.publicKey.export({ format: 'jwk' });
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(j.x, 'base64url')], [-3, Buffer.from(j.y, 'base64url')]]);
      const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
      parts.push(Buffer.alloc(16), len, this.credId, cbor(cose));
    }
    return Buffer.concat(parts);
  }
  create(opts, origin) {
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opts.challenge, origin }));
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(opts.rp.id, true)]]));
    return { id: this.credId.toString('base64url'), response: { clientDataJSON: cd.toString('base64url'), attestationObject: att.toString('base64url') } };
  }
  get(opts, origin, key = this.keys.privateKey) {
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin }));
    const ad = this.authData(opts.rpId, false);
    const sig = crypto.sign('sha256', Buffer.concat([ad, crypto.createHash('sha256').update(cd).digest()]), key);
    return { id: this.credId.toString('base64url'), response: { clientDataJSON: cd.toString('base64url'), authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url') } };
  }
}

run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
const user = { id: 1, name: 'anna' };
const rp = pk.rpOf('tv.example.se', null);
const ORIGIN = 'https://tv.example.se';

test('passkey: registrering och inloggning med mjukvaru-autentiserare', () => {
  const a = new SoftAuthenticator();
  const reg = pk.registrationOptions(user, rp);
  assert.equal(reg.rp.id, 'tv.example.se');
  pk.verifyRegistration(user, { ...a.create(reg, ORIGIN), name: 'Test' }, rp);
  assert.equal(pk.list(1).length, 1);
  assert.ok(pk.hasPasskey(1));
  const lo = pk.loginOptions(rp);
  assert.equal(pk.verifyLogin(a.get(lo, ORIGIN), rp), 1);
  // Utmaningen kan inte återanvändas
  assert.throws(() => pk.verifyLogin(a.get(lo, ORIGIN), rp), /Utmaningen/);
});

test('passkey: fel ursprung, fel nyckel och klonad räknare nekas', () => {
  const a = new SoftAuthenticator();
  pk.verifyRegistration(user, a.create(pk.registrationOptions(user, rp), ORIGIN), rp);
  assert.throws(() => pk.verifyLogin(a.get(pk.loginOptions(rp), 'https://evil.example'), rp), /ursprung/);
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  assert.throws(() => pk.verifyLogin(a.get(pk.loginOptions(rp), ORIGIN, other), rp), /signatur/);
  a.count = 0; // räknaren backar → kopierad nyckel
  assert.throws(() => pk.verifyLogin(a.get(pk.loginOptions(rp), ORIGIN), rp), /räknare/);
  // Registrering mot fel domän (rpId)
  const b = new SoftAuthenticator();
  const reg = pk.registrationOptions(user, rp);
  assert.throws(() => pk.verifyRegistration(user, b.create({ ...reg, rp: { id: 'evil.example' } }, ORIGIN), rp), /rpId/);
});

test('ACME: CSR är giltig (verifieras med openssl om det finns)', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = acme.makeCsr(['tv.example.se'], privateKey);
  assert.equal(der[0], 0x30);
  if (spawnSync('openssl', ['version']).status !== 0) return;
  const f = path.join(process.env.CONFIG_DIR, 'csr.der'); fs.writeFileSync(f, der);
  const r = spawnSync('openssl', ['req', '-inform', 'DER', '-in', f, '-noout', '-verify', '-text'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DNS:tv\.example\.se/);
});

test('ACME: JWK-tumavtryck enligt RFC 7638', () => {
  // Testvektor: EC-nyckel → tumavtryck över {"crv","kty","x","y"} i bokstavsordning
  const jwk = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };
  const exp = crypto.createHash('sha256').update('{"crv":"P-256","kty":"EC","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"}').digest('base64url');
  assert.equal(acme.thumbprint(jwk), exp);
});
