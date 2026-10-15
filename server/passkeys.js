// Inloggning med passkeys (WebAuthn): Face ID, Touch ID, Windows Hello eller säkerhetsnyckel.
// Kräver HTTPS (eller localhost). Ingen attestering krävs ("none") – vi litar på den publika nyckeln vid registrering.
import crypto from 'node:crypto';
import { db, get, all, run, now } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, name TEXT, created INTEGER NOT NULL, last_used INTEGER);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);`);

const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const challenges = new Map(); // challenge → { userId|null, type, exp }
const MAX_CHALLENGES = 20000;
function addChallenge(ch, v) {
  // Begränsa minnet: äldsta utmaningarna tas bort först (Map behåller insättningsordning)
  while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
  challenges.set(ch, v);
}
setInterval(() => { for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k); }, 60e3).unref();

// ---------- minimal CBOR-avkodare (RFC 8949) ----------
export function cborDecode(buf) {
  let i = 0;
  const readLen = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) { if (i >= buf.length) throw new Error('CBOR: avkortad'); return buf[i++]; }
    if (ai === 25) { const v = buf.readUInt16BE(i); i += 2; return v; }
    if (ai === 26) { const v = buf.readUInt32BE(i); i += 4; return v; }
    if (ai === 27) { const v = Number(buf.readBigUInt64BE(i)); i += 8; return v; }
    throw new Error('CBOR: obestämd längd stöds inte');
  };
  // Längder kontrolleras mot bufferten: en påhittad längd (t.ex. 2^64 element) får inte läsa
  // förbi slutet och fylla minnet tills processen dör
  const len = (ai) => { const n = readLen(ai); if (n > buf.length - i) throw new Error('CBOR: avkortad'); return n; };
  let depth = 0;
  const item = () => {
    if (i >= buf.length) throw new Error('CBOR: avkortad');
    if (++depth > 32) throw new Error('CBOR: för djup nästling');
    try { return one(); } finally { depth--; }
  };
  const one = () => {
    const b = buf[i++], mt = b >> 5, ai = b & 31;
    switch (mt) {
      case 0: return readLen(ai);
      case 1: return -1 - readLen(ai);
      case 2: { const n = len(ai); const v = buf.subarray(i, i + n); i += n; return v; }
      case 3: { const n = len(ai); const v = buf.subarray(i, i + n).toString('utf8'); i += n; return v; }
      case 4: { const n = len(ai); const a = []; for (let k = 0; k < n; k++) a.push(item()); return a; }
      case 5: { const n = len(ai); const m = new Map(); for (let k = 0; k < n; k++) { const key = item(); m.set(key, item()); } return m; }
      case 6: readLen(ai); return item(); // tagg ignoreras
      case 7: if (ai === 20) return false; if (ai === 21) return true; if (ai === 22 || ai === 23) return null;
        if (ai === 25) { i += 2; return 0; } if (ai === 26) { const v = buf.readFloatBE(i); i += 4; return v; } if (ai === 27) { const v = buf.readDoubleBE(i); i += 8; return v; }
        throw new Error('CBOR: okänt enkelt värde');
      default: throw new Error('CBOR: okänd typ');
    }
  };
  const v = item();
  return { value: v, length: i };
}

// COSE-nyckel → Node KeyObject
function coseToKey(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && cose.get(-1) === 1) { // EC2 P-256
    return { alg, key: crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) }, format: 'jwk' }) };
  }
  if (kty === 3) { // RSA
    return { alg, key: crypto.createPublicKey({ key: { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) }, format: 'jwk' }) };
  }
  if (kty === 1 && cose.get(-1) === 6) { // OKP Ed25519
    return { alg, key: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(cose.get(-2)) }, format: 'jwk' }) };
  }
  throw new Error('Nyckeltypen stöds inte');
}

function parseAuthData(ad) {
  const rpIdHash = ad.subarray(0, 32), flags = ad[32], signCount = ad.readUInt32BE(33);
  const out = { rpIdHash, flags, signCount, up: !!(flags & 1), uv: !!(flags & 4) };
  if (flags & 64) { // attesterad nyckeldata finns
    const credLen = ad.readUInt16BE(53);
    out.credId = ad.subarray(55, 55 + credLen);
    out.cose = cborDecode(ad.subarray(55 + credLen)).value;
  }
  return out;
}

function checkClientData(raw, type, expectedOrigins) {
  const cd = JSON.parse(Buffer.from(raw).toString('utf8'));
  if (cd.type !== type) throw new Error('Fel typ av förfrågan');
  const ch = challenges.get(cd.challenge);
  if (!ch || ch.exp < Date.now() || ch.type !== type) throw new Error('Utmaningen är ogiltig eller har gått ut – försök igen');
  if (!expectedOrigins.includes(cd.origin)) throw new Error(`Fel ursprung (${cd.origin})`);
  challenges.delete(cd.challenge);
  return ch;
}

/** rpId = värdnamnet webbläsaren använder; tillåtna ursprung = samma värd via http/https (+ publik adress). */
export function rpOf(hostHeader, publicUrl) {
  const hostport = String(hostHeader || '').toLowerCase();
  const host = hostport.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const pub = publicUrl ? new URL(publicUrl) : null;
  const rpId = host || pub?.hostname || 'localhost';
  const origins = new Set([`https://${hostport}`, `http://${hostport}`]);
  if (pub) origins.add(pub.origin);
  return { rpId, origins: [...origins] };
}
export const hasPasskey = (userId) => !!get('SELECT 1 FROM passkeys WHERE user_id=? LIMIT 1', userId);

export function registrationOptions(user, rp) {
  const challenge = b64u(crypto.randomBytes(32));
  addChallenge(challenge, { userId: user.id, type: 'webauthn.create', exp: Date.now() + 300e3 });
  return {
    challenge, rp: { id: rp.rpId, name: 'BraXhn TV' },
    user: { id: b64u(Buffer.from(String(user.id))), name: user.name, displayName: user.name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
    timeout: 300000, attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: all('SELECT id FROM passkeys WHERE user_id=?', user.id).map(p => ({ type: 'public-key', id: p.id }))
  };
}

export function verifyRegistration(user, body, rp) {
  const ch = checkClientData(fromB64u(body.response?.clientDataJSON), 'webauthn.create', rp.origins);
  if (ch.userId !== user.id) throw new Error('Fel användare');
  const att = cborDecode(fromB64u(body.response?.attestationObject)).value;
  const ad = parseAuthData(att.get('authData'));
  if (!ad.rpIdHash.equals(crypto.createHash('sha256').update(rp.rpId).digest())) throw new Error('Fel domän (rpId)');
  if (!ad.up) throw new Error('Användaren bekräftade inte');
  // Passkeyn räknas som tvåstegsverifiering – kräver biometri/PIN på enheten (user verification)
  if (!ad.uv) throw new Error('Enheten verifierade inte användaren (Face ID, fingeravtryck eller PIN krävs)');
  if (!ad.credId || !ad.cose) throw new Error('Ingen nyckel i svaret');
  const { alg, key } = coseToKey(ad.cose);
  const id = b64u(ad.credId);
  if (get('SELECT 1 FROM passkeys WHERE id=?', id)) throw new Error('Nyckeln finns redan');
  if (all('SELECT id FROM passkeys WHERE user_id=?', user.id).length >= 20) throw new Error('Max 20 passkeys per konto');
  run('INSERT INTO passkeys(id,user_id,public_key,alg,sign_count,name,created) VALUES(?,?,?,?,?,?,?)',
    id, user.id, key.export({ type: 'spki', format: 'pem' }), alg, ad.signCount, String(body.name || 'Passkey').slice(0, 60), now());
  return id;
}

export function loginOptions(rp) {
  const challenge = b64u(crypto.randomBytes(32));
  addChallenge(challenge, { userId: null, type: 'webauthn.get', exp: Date.now() + 300e3 });
  return { challenge, rpId: rp.rpId, timeout: 300000, userVerification: 'required', allowCredentials: [] };
}

/** Returnerar användar-id om inloggningen är giltig, annars kastas fel. */
export function verifyLogin(body, rp) {
  const pk = get('SELECT * FROM passkeys WHERE id=?', String(body.id || ''));
  if (!pk) throw new Error('Okänd passkey');
  const raw = fromB64u(body.response?.clientDataJSON);
  checkClientData(raw, 'webauthn.get', rp.origins);
  const authData = fromB64u(body.response?.authenticatorData);
  const ad = parseAuthData(authData);
  if (!ad.rpIdHash.equals(crypto.createHash('sha256').update(rp.rpId).digest())) throw new Error('Fel domän (rpId)');
  if (!ad.up) throw new Error('Användaren bekräftade inte');
  if (!ad.uv) throw new Error('Enheten verifierade inte användaren (Face ID, fingeravtryck eller PIN krävs)');
  const data = Buffer.concat([authData, crypto.createHash('sha256').update(raw).digest()]);
  const key = crypto.createPublicKey(pk.public_key);
  const sig = fromB64u(body.response?.signature);
  const ok = pk.alg === -8 ? crypto.verify(null, data, key, sig) : crypto.verify('sha256', data, key, sig);
  if (!ok) throw new Error('Ogiltig signatur');
  // Klonade nycklar: räknaren måste öka (om autentiseraren använder räknare)
  if (ad.signCount !== 0 || pk.sign_count !== 0) {
    if (ad.signCount <= pk.sign_count) throw new Error('Passkeyns räknare stämmer inte – nyckeln kan vara kopierad');
  }
  run('UPDATE passkeys SET sign_count=?, last_used=? WHERE id=?', ad.signCount, now(), pk.id);
  return pk.user_id;
}

export const list = (userId) => all('SELECT id, name, created, last_used FROM passkeys WHERE user_id=? ORDER BY created', userId);
export const remove = (userId, id) => run('DELETE FROM passkeys WHERE user_id=? AND id=?', userId, id);
