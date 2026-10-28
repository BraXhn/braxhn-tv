// Passkeys (WebAuthn): inloggning och registrering
import { api, t } from './core.js';

// ---------- passkeys (WebAuthn) ----------
const b64uEnc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDec = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export const passkeyOk = () => !!window.PublicKeyCredential && window.isSecureContext;
export async function passkeyLogin(remember = true) {
  const o = await (await fetch('/api/passkey/options', { method: 'POST' })).json();
  if (o.error) throw new Error(o.error);
  const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: b64uDec(o.challenge) } });
  const r = await fetch('/api/passkey/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    id: cred.id, response: { clientDataJSON: b64uEnc(cred.response.clientDataJSON), authenticatorData: b64uEnc(cred.response.authenticatorData),
      signature: b64uEnc(cred.response.signature) }, remember }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ? t(d.error) : t('Fel {status}', { status: r.status }));
}
export async function passkeyRegister(password, name, code) {
  const o = await api('/me/passkeys/options', { method: 'POST', body: { password, code } });
  const cred = await navigator.credentials.create({ publicKey: { ...o, challenge: b64uDec(o.challenge), user: { ...o.user, id: b64uDec(o.user.id) },
    excludeCredentials: o.excludeCredentials.map(c => ({ ...c, id: b64uDec(c.id) })) } });
  await api('/me/passkeys', { method: 'POST', body: { name, id: cred.id, response: { clientDataJSON: b64uEnc(cred.response.clientDataJSON), attestationObject: b64uEnc(cred.response.attestationObject) } } });
}
