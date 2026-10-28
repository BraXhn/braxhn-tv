// Enkel inloggning (SSO): leverantörer (OIDC och LDAP), kopplingar mellan leverantörens användare och konton här,
// grupper → roll och bibliotek, automatiska konton och bekräftad koppling till befintliga konton.
//
// Tabellerna (db.js): sso_providers (kind oidc|ldap, config = JSON utan hemligheter, secret = klienthemligheten eller
// tjänstekontots lösenord krypterat med AES-256-GCM och nyckeln /config/sso.key), sso_links (leverantör + subject → konto,
// managed = kontot skapades av leverantören och följer dess grupper vid varje inloggning).
//
// Regler som skyddar mot att ett konto tas över:
//   - En användare hos leverantören kopplas bara till ett konto via sso_links. Finns det ett konto med samma namn eller
//     e-post men ingen koppling skapas ingenting automatiskt: en engångsbiljett (10 min) kräver det befintliga kontots
//     lösenord (och tvåstegskod) – eller att användaren redan är inloggad på kontot och kopplar under Mitt konto.
//   - Automatiska konton (autoCreate) kräver grupper eller en lista med tillåtna e-postadresser/domäner, så att t.ex.
//     "Logga in med Google" inte släpper in alla med ett Google-konto.
//   - Grupperna kontrolleras vid varje inloggning. Kopplade befintliga konton behåller sin roll; bara konton som
//     leverantören skapat (managed) får roll och bibliotek från grupperna – och den sista administratören degraderas aldrig.
//   - Lokala konton fungerar som förut. Med "bara administratörer får logga in med lösenord" (sso_local_login = admin)
//     nekas andras lokala lösenord, men administratörernas reservinloggning finns alltid kvar.
// Hemligheter lämnas aldrig ut (publicOut) och skrivs aldrig i loggar eller revisionsloggen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { get, all, run, now, tx, getSetting, setSetting, CONFIG } from './db.js';
import { clean } from './util.js';
import * as ldap from './ldap.js';

// ---------- hemligheter ----------
const KEY_FILE = path.join(CONFIG, 'sso.key');
let key = null;
function serverKey() {
  if (key) return key;
  try { const k = fs.readFileSync(KEY_FILE); if (k.length === 32) return (key = k); } catch {}
  const k = crypto.randomBytes(32);
  try { fs.writeFileSync(KEY_FILE, k, { mode: 0o600, flag: 'wx' }); key = k; }
  catch { const r = fs.readFileSync(KEY_FILE); if (r.length !== 32) throw new Error('sso.key är trasig'); key = r; }
  return key;
}
// Raden är knuten till leverantören (AAD)
function seal(id, text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', serverKey(), iv);
  c.setAAD(Buffer.from(`sso:${id}`));
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function unseal(id, enc) {
  if (!enc) return '';
  try {
    const b = Buffer.from(String(enc).slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', serverKey(), b.subarray(0, 12));
    d.setAAD(Buffer.from(`sso:${id}`));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}

// ---------- inställningar ----------
/** 'all' = alla lokala konton loggar in med lösenord (standard), 'admin' = bara administratörer (reservinloggning) */
export const localLogin = () => getSetting('sso_local_login', 'all') === 'admin' ? 'admin' : 'all';
export const setLocalLogin = (v) => setSetting('sso_local_login', v === 'admin' ? 'admin' : 'all');

// ---------- leverantörer ----------
const KINDS = ['oidc', 'ldap'];
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const str = (v, max = 500) => clean(v ?? '', max).trim();
const list = (v, max = 50) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]+/)).map(x => str(x, 200)).filter(Boolean).slice(0, max);
const COMMON = ['autoCreate', 'groups', 'kidAge', 'libraries', 'libDefault', 'remoteAllowed', 'trustMfa', 'allowEmails'];
const OIDC_F = ['issuer', 'clientId', 'scopes', 'groupsClaim', 'usernameClaim', 'redirectBase', 'prompt'];
const LDAP_F = ['url', 'startTls', 'tlsVerify', 'ca', 'bindDn', 'baseDn', 'userFilter', 'usernameAttr', 'emailAttr', 'nameAttr', 'memberOfAttr', 'groupBaseDn', 'groupFilter', 'groupAttr', 'timeout'];
const parse = (s) => { try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };

/** Leverantören med inställningar och hemlighet (bara för servern) */
export function provider(id) {
  const r = get('SELECT * FROM sso_providers WHERE id=?', +id);
  if (!r) return null;
  const cfg = parse(r.config);
  const secret = unseal(r.id, r.secret);
  return { id: r.id, kind: r.kind, name: r.name, enabled: !!r.enabled, sort: r.sort, ...cfg, ...(r.kind === 'oidc' ? { clientSecret: secret } : { bindPassword: secret }), hasSecret: !!r.secret };
}
export const providers = ({ enabled = false } = {}) => all(`SELECT id FROM sso_providers ${enabled ? 'WHERE enabled=1' : ''} ORDER BY sort, id`).map(r => provider(r.id));
/** Utan hemligheter – för administratörens API och loggar */
export function publicOut(p) {
  if (!p) return null;
  const { clientSecret, bindPassword, ...rest } = p;
  return { ...rest, redirectUri: p.kind === 'oidc' ? redirectUri(p) : undefined,
    links: get('SELECT COUNT(*) AS n FROM sso_links WHERE provider_id=?', p.id).n };
}
/** Den enda redirect-URI som används (vitlistad): basen administratören angett + den fasta sökvägen */
export const redirectUri = (p) => p.redirectBase ? `${p.redirectBase}/api/sso/oidc/${p.id}/callback` : null;
export function normBase(s) {
  let u;
  try { u = new URL(String(s || '').trim()); } catch { throw bad('Ogiltig adress för återkomsten – ange t.ex. https://tv.example.com'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw bad('Ange bara serverns adress (t.ex. https://tv.example.com), utan sökväg');
  return u.origin;
}
const groupsIn = (g) => ({ admin: list(g?.admin), user: list(g?.user), kid: list(g?.kid) });
function normCommon(b, cur) {
  const o = {};
  o.autoCreate = b.autoCreate !== undefined ? !!b.autoCreate : !!cur.autoCreate;
  o.groups = b.groups !== undefined ? groupsIn(b.groups) : groupsIn(cur.groups);
  o.kidAge = b.kidAge !== undefined ? Math.max(0, Math.min(18, parseInt(b.kidAge) || 0)) : cur.kidAge ?? 11;
  const libs = b.libraries !== undefined ? b.libraries : cur.libraries;
  o.libraries = (Array.isArray(libs) ? libs : []).slice(0, 50).map(r => ({ group: str(r?.group, 200), ids: [...new Set((Array.isArray(r?.ids) ? r.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 500) }))
    .filter(r => r.group);
  o.libDefault = (b.libDefault ?? cur.libDefault) === 'none' ? 'none' : 'all';
  o.remoteAllowed = b.remoteAllowed !== undefined ? !!b.remoteAllowed : cur.remoteAllowed !== false;
  o.trustMfa = b.kind === 'oidc' && (b.trustMfa !== undefined ? !!b.trustMfa : !!cur.trustMfa); // LDAP har ingen egen tvåstegsverifiering
  o.allowEmails = b.allowEmails !== undefined ? list(b.allowEmails, 200).map(s => s.toLowerCase()) : cur.allowEmails || [];
  if (o.autoCreate && !hasGroupRules(o) && !o.allowEmails.length && b.kind !== 'ldap' && cur.kind !== 'ldap')
    throw bad('Automatiska konton kräver grupper eller tillåtna e-postadresser/domäner – annars kan vem som helst med ett konto hos leverantören logga in');
  return o;
}
function normOidc(b, cur, base) {
  const o = {};
  for (const k of OIDC_F) o[k] = b[k] !== undefined ? str(b[k], 1000) : cur[k] ?? '';
  if (!o.issuer) throw bad('Ange utfärdaren (issuer)');
  try { new URL(o.issuer); } catch { throw bad('Ogiltig utfärdare (issuer)'); }
  if (!/^https?:\/\//.test(o.issuer)) throw bad('Utfärdaren ska börja med https://');
  if (!o.clientId) throw bad('Ange klient-id (client ID)');
  o.redirectBase = normBase(o.redirectBase || base || '');
  o.scopes = o.scopes || 'openid profile email';
  if (!/^[\w:./ -]+$/.test(o.scopes)) throw bad('Ogiltiga scopes');
  o.groupsClaim = o.groupsClaim || 'groups';
  o.usernameClaim = o.usernameClaim || 'preferred_username';
  if (![o.groupsClaim, o.usernameClaim].every(c => /^[\w.:-]{1,100}$/.test(c))) throw bad('Ogiltigt claim-namn');
  o.prompt = ['', 'login', 'consent', 'select_account'].includes(o.prompt) ? o.prompt : '';
  return o;
}
function normLdap(b, cur) {
  const o = {};
  for (const k of LDAP_F) o[k] = b[k] !== undefined ? b[k] : cur[k];
  const moUnset = o.memberOfAttr == null; // aldrig angett: memberOf som standard (tomt = bara gruppfiltret)
  for (const k of ['url', 'bindDn', 'baseDn', 'userFilter', 'usernameAttr', 'emailAttr', 'nameAttr', 'memberOfAttr', 'groupBaseDn', 'groupFilter', 'groupAttr']) o[k] = str(o[k], 1000);
  o.ca = String(o.ca ?? '').slice(0, 20000).trim();
  o.startTls = !!o.startTls; o.tlsVerify = o.tlsVerify !== false; o.timeout = Math.max(1, Math.min(60, parseInt(o.timeout) || 8));
  ldap.parseUrl(o.url);
  if (!o.baseDn) throw bad('Ange sökbasen (base DN)');
  o.userFilter = o.userFilter || '(&(objectClass=person)(uid={user}))';
  if (!o.userFilter.includes('{user}')) throw bad('Användarfiltret måste innehålla {user}');
  // Mallarna måste gå att tolka (med exempelvärden) – fel visas när inställningen sparas, inte vid inloggningen
  try { ldap.parseFilter(ldap.fillFilter(o.userFilter, { user: 'x' })); if (o.groupFilter) ldap.parseFilter(ldap.fillFilter(o.groupFilter, { user: 'x', dn: 'uid=x,dc=y' })); }
  catch (e) { throw bad(e.message); }
  o.usernameAttr = o.usernameAttr || 'uid'; o.emailAttr = o.emailAttr || 'mail'; o.nameAttr = o.nameAttr || 'displayName';
  if (moUnset) o.memberOfAttr = 'memberOf';
  for (const a of [o.usernameAttr, o.emailAttr, o.nameAttr, o.memberOfAttr, o.groupAttr].filter(Boolean)) if (!/^[A-Za-z][\w-]{0,60}$/.test(a)) throw bad('Ogiltigt attributnamn: ' + a.slice(0, 60));
  if (o.url.startsWith('ldap:') && !o.startTls && o.bindDn) o.insecure = true; // lösenord i klartext på nätet (varning i gränssnittet)
  else delete o.insecure;
  return o;
}
/** Skapar eller uppdaterar en leverantör från administratörens formulär. Returnerar id. */
export function save(id, b, { base } = {}) {
  const cur = id ? provider(id) : null;
  if (id && !cur) throw Object.assign(new Error('Finns inte'), { status: 404 });
  const kind = cur ? cur.kind : String(b.kind || '');
  if (!KINDS.includes(kind)) throw bad('Okänd typ av inloggning');
  const name = b.name !== undefined ? str(b.name, 40) : cur?.name;
  if (!name) throw bad('Ange ett namn (visas på knappen "Logga in med …")');
  const cfg = { ...normCommon({ ...b, kind }, cur || {}), ...(kind === 'oidc' ? normOidc(b, cur || {}, base) : normLdap(b, cur || {})) };
  const enabled = b.enabled !== undefined ? !!b.enabled : cur ? cur.enabled : true;
  const sec = kind === 'oidc' ? b.clientSecret : b.bindPassword;
  return tx(() => {
    let pid = id;
    if (!pid) pid = Number(run('INSERT INTO sso_providers(kind,name,enabled,config,trust_mfa,sort,created) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM sso_providers),?)',
      kind, name, enabled ? 1 : 0, '{}', cfg.trustMfa ? 1 : 0, now()).lastInsertRowid);
    run('UPDATE sso_providers SET name=?, enabled=?, config=?, trust_mfa=? WHERE id=?', name, enabled ? 1 : 0, JSON.stringify(cfg), cfg.trustMfa ? 1 : 0, pid);
    // Hemligheten: tomt fält = behåll, clearSecret = ta bort
    if (b.clearSecret) run('UPDATE sso_providers SET secret=NULL WHERE id=?', pid);
    else if (typeof sec === 'string' && sec) run('UPDATE sso_providers SET secret=? WHERE id=?', seal(pid, sec.slice(0, 2000)), pid);
    return pid;
  });
}
export const remove = (id) => run('DELETE FROM sso_providers WHERE id=?', +id).changes > 0;

// ---------- grupper → roll och bibliotek ----------
const normG = (g) => String(g).trim().replace(/^\/+/, '').toLowerCase();
const hasGroupRules = (p) => !!(p.groups && (p.groups.admin?.length || p.groups.user?.length || p.groups.kid?.length));
/** 'admin' | 'kid' | 'user' eller null (inte med i någon grupp som får logga in). Ordning: admin, barn, vanlig. */
export function roleFor(p, groups) {
  const g = new Set((groups || []).map(normG));
  const has = (l) => (l || []).some(x => g.has(normG(x)));
  if (has(p.groups?.admin)) return 'admin';
  if (has(p.groups?.kid)) return 'kid';
  if (has(p.groups?.user)) return 'user';
  return hasGroupRules(p) ? null : 'user';
}
/** Biblioteken för grupperna: sammanslaget för de regler som matchar, annars libDefault (null = alla, [] = inga) */
export function libsFor(p, groups) {
  if (!p.libraries?.length) return null;
  const g = new Set((groups || []).map(normG));
  const hit = p.libraries.filter(r => g.has(normG(r.group)));
  if (!hit.length) return p.libDefault === 'none' ? [] : null;
  return [...new Set(hit.flatMap(r => r.ids))];
}
/** Tillåts e-postadressen? (tom lista = alla; "@example.com" = domänen) */
export function emailAllowed(p, email, verified) {
  if (!p.allowEmails?.length) return true;
  if (!email || verified === false) return false;
  const e = String(email).toLowerCase();
  return p.allowEmails.some(a => a.startsWith('@') ? e.endsWith(a) : e === a);
}

// ---------- konton ----------
const NAME = (s) => clean(s, 64).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);
/** Namnet för ett nytt konto ur leverantörens uppgifter */
const nameOf = (id) => NAME(id.username || (id.email ? String(id.email).split('@')[0] : '') || id.displayName || '') || 'sso-' + crypto.randomBytes(3).toString('hex');
function freeName(base) {
  if (!get('SELECT 1 FROM users WHERE name=?', base)) return base;
  for (let i = 2; i < 100; i++) { const n = `${base.slice(0, 58)}-${i}`; if (!get('SELECT 1 FROM users WHERE name=?', n)) return n; }
  return `${base.slice(0, 50)}-${crypto.randomBytes(3).toString('hex')}`;
}
/** Sätter roll och bibliotek på ett konto som leverantören äger. Den sista administratören degraderas aldrig. */
function applyRole(uid, role, libs, p) {
  const u = get('SELECT id, is_admin, max_age FROM users WHERE id=?', uid);
  const admin = role === 'admin' ? 1 : 0;
  if (u.is_admin && !admin && get('SELECT COUNT(*) AS n FROM users WHERE is_admin=1').n <= 1) return;
  run('UPDATE users SET is_admin=?, max_age=?, libraries=? WHERE id=?', admin, role === 'kid' ? p.kidAge ?? 11 : null, libs == null ? null : JSON.stringify(libs), uid);
}
function createUser(p, id, role, libs, hashPw) {
  const name = freeName(nameOf(id));
  const uid = Number(run('INSERT INTO users(name,pass,is_admin,created,remote_allowed,max_age,libraries,email) VALUES(?,?,?,?,?,?,?,?)', name, hashPw, role === 'admin' ? 1 : 0, now(),
    p.remoteAllowed === false ? 0 : 1, role === 'kid' ? p.kidAge ?? 11 : null, libs == null ? null : JSON.stringify(libs), id.email && id.emailVerified !== false ? String(id.email).slice(0, 200) : null).lastInsertRowid);
  link(p.id, id, uid, true);
  return uid;
}
function link(pid, id, uid, managed) {
  run(`INSERT INTO sso_links(provider_id,subject,user_id,managed,email,username,created,last_login) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(provider_id,subject) DO UPDATE SET user_id=excluded.user_id, managed=excluded.managed, email=excluded.email, username=excluded.username, last_login=excluded.last_login`,
    pid, id.subject, uid, managed ? 1 : 0, id.email ? String(id.email).slice(0, 200) : null, id.username ? NAME(id.username) : null, now(), now());
  // Kontot får leverantörens e-post om det saknar en (används för att hitta kontot vid nästa leverantör – alltid med bekräftelse)
  if (id.email && id.emailVerified !== false) run('UPDATE users SET email=COALESCE(email,?) WHERE id=?', String(id.email).slice(0, 200), uid);
}
/** Kopplingen för en användare hos leverantören (null om ingen) */
export const linkOf = (pid, subject) => get('SELECT * FROM sso_links WHERE provider_id=? AND subject=?', pid, subject) || null;
export const linksOfUser = (uid) => all('SELECT l.provider_id, l.managed, l.email, l.username, l.created, l.last_login, p.name, p.kind FROM sso_links l JOIN sso_providers p ON p.id=l.provider_id WHERE l.user_id=? ORDER BY p.sort', uid);
export const linksOfProvider = (pid) => all('SELECT l.user_id, u.name AS user, l.managed, l.email, l.username, l.created, l.last_login FROM sso_links l JOIN users u ON u.id=l.user_id WHERE l.provider_id=? ORDER BY u.name', pid);
export const unlink = (pid, uid) => run('DELETE FROM sso_links WHERE provider_id=? AND user_id=?', +pid, +uid).changes > 0;
/** Leverantören sköter tvåstegsverifieringen för kontot (trustMfa) – räknas som 2FA utanför hemmet */
export const mfaTrusted = (uid) => !!get('SELECT 1 FROM sso_links l JOIN sso_providers p ON p.id=l.provider_id WHERE l.user_id=? AND p.enabled=1 AND p.trust_mfa=1 LIMIT 1', uid);
/** Kontot har en koppling men inget eget lösenord (skapat av leverantören) */
export const managedOnly = (uid) => !!get('SELECT 1 FROM sso_links WHERE user_id=? AND managed=1 LIMIT 1', uid);

// ---------- väntande koppling (biljett) ----------
const tickets = new Map(); // sha(biljett) → { pid, id, uid, expires, tries, remember, app }
const TICKET_TTL = 600;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sweep = (m) => { for (const [k, v] of m) if (v.expires <= now()) m.delete(k); };
function newTicket(data) {
  sweep(tickets);
  if (tickets.size >= 1000) tickets.delete(tickets.keys().next().value);
  const t = crypto.randomBytes(32).toString('hex');
  tickets.set(sha(t), { ...data, expires: now() + TICKET_TTL, tries: 0 });
  return t;
}
export function ticket(t) {
  if (!/^[a-f0-9]{64}$/.test(String(t))) return null;
  const r = tickets.get(sha(t));
  if (!r || r.expires <= now()) { tickets.delete(sha(t)); return null; }
  return r;
}
export const dropTicket = (t) => tickets.delete(sha(t));
/** Fel lösenord på biljetten: efter 5 försök gäller den inte längre */
export function ticketFail(t) { const r = ticket(t); if (r && ++r.tries >= 5) dropTicket(t); }
/** Kopplar biljettens användare till det befintliga kontot (efter att lösenordet kontrollerats). Returnerar konto-id. */
export function confirmTicket(t) {
  const r = ticket(t);
  if (!r) return null;
  dropTicket(t);
  link(r.pid, r.id, r.uid, false);
  return r.uid;
}
/** "Det är inte mitt konto": skapa ett nytt konto med ett ledigt namn (bara om leverantören får skapa konton) */
export async function createFromTicket(t, hashPw) {
  const r = ticket(t);
  if (!r) return null;
  const p = provider(r.pid);
  if (!p?.enabled || !p.autoCreate) return { deny: 'Kontot kan inte skapas automatiskt – be administratören', code: 'noaccount' };
  dropTicket(t);
  const groups = r.id.groups || [];
  const hash = await hashPw();
  const l = linkOf(p.id, r.id.subject); // en annan inloggning hann före
  return { uid: l ? l.user_id : createUser(p, r.id, roleFor(p, groups), libsFor(p, groups), hash) };
}

/**
 * Inloggning med en identitet från leverantören: { subject, username, email, emailVerified, displayName, groups }.
 * hashPw() = lösenordshash för nya konton (ett slumpat lösenord: kontot loggar bara in via leverantören).
 * Returnerar { uid } | { ticket, account } (befintligt konto med samma namn/e-post – bekräftelse krävs) | { deny, code }.
 */
export async function resolve(p, id, { hashPw, linkUid = null, remember = true, app = false } = {}) {
  const groups = id.groups || [];
  const role = roleFor(p, groups);
  if (!role) return { deny: 'Ditt konto är inte med i någon grupp som får använda BraXhn TV', code: 'groups' };
  if (!emailAllowed(p, id.email, id.emailVerified)) return { deny: 'Din e-postadress är inte tillåten på den här servern', code: 'email' };
  const l = linkOf(p.id, id.subject);
  let uid = l && get('SELECT id FROM users WHERE id=? AND parent_id IS NULL', l.user_id)?.id;
  if (l && !uid) run('DELETE FROM sso_links WHERE provider_id=? AND subject=?', p.id, id.subject); // kontot är borttaget
  // Inloggad användare kopplar sitt eget konto (Mitt konto) – kopplingen flyttas aldrig från ett annat konto
  if (linkUid) {
    if (uid && uid !== linkUid) return { deny: 'Användaren hos leverantören är redan kopplad till ett annat konto', code: 'linked' };
    if (!uid) { link(p.id, id, linkUid, false); return { uid: linkUid, linked: true }; }
  }
  if (uid) {
    if (l.managed) applyRole(uid, role, libsFor(p, groups), p);
    run('UPDATE sso_links SET last_login=?, email=?, username=? WHERE provider_id=? AND subject=?', now(), id.email ? String(id.email).slice(0, 200) : null, id.username ? NAME(id.username) : null, p.id, id.subject);
    return { uid };
  }
  // Befintligt konto med samma namn eller (verifierad) e-post: aldrig automatiskt – bekräfta med kontots lösenord
  const nm = nameOf(id);
  const cand = get('SELECT id, name FROM users WHERE parent_id IS NULL AND name=?', nm)
    || (id.email && id.emailVerified !== false ? get('SELECT id, name FROM users WHERE parent_id IS NULL AND (lower(email)=lower(?) OR lower(name)=lower(?)) ORDER BY id LIMIT 1', String(id.email), String(id.email)) : null);
  if (cand) return { ticket: newTicket({ pid: p.id, id, uid: cand.id, remember, app }), account: cand.name, canCreate: !!p.autoCreate };
  if (!p.autoCreate) return { deny: 'Det finns inget konto kopplat till din inloggning – be administratören att skapa ett eller koppla ditt konto', code: 'noaccount' };
  const hash = await hashPw();
  const again = linkOf(p.id, id.subject); // en samtidig inloggning hann skapa kontot
  if (again) return { uid: again.user_id };
  return { uid: createUser(p, id, role, libsFor(p, groups), hash), created: true };
}

// ---------- OIDC: väntande inloggningar (state) ----------
// state → { pid, nonce, verifier, bind (sha av kakan bxsso), next, linkUid, remember, expires }. Engångs, 10 minuter.
const states = new Map();
export function newState(data) {
  sweep(states);
  if (states.size >= 2000) states.delete(states.keys().next().value);
  const state = crypto.randomBytes(24).toString('base64url');
  states.set(state, { ...data, expires: now() + 600 });
  return state;
}
export function takeState(state) {
  const r = states.get(String(state || ''));
  if (!r) return null;
  states.delete(String(state));
  return r.expires > now() ? r : null;
}
setInterval(() => { sweep(states); sweep(tickets); }, 60e3).unref();
export const bindHash = sha;

// ---------- LDAP ----------
export const ldapProviders = () => providers({ enabled: true }).filter(p => p.kind === 'ldap');
/**
 * Lösenordsinloggning mot LDAP-leverantörerna (i ordning). Returnerar null (fel namn/lösenord hos alla),
 * { p, id } vid lyckad inloggning, eller { error } om en server inte gick att nå (och ingen annan godtog).
 */
export async function ldapLogin(username, password) {
  let error = null;
  for (const p of ldapProviders()) {
    try {
      const id = await ldap.authenticate(p, username, password);
      if (id) return { p, id };
    } catch (e) { error = e; console.warn(`[sso] LDAP "${clean(p.name, 40)}": ${clean(e.message, 160)}`); }
  }
  return error ? { error } : null;
}
/** Administratörens test: anslutning, tjänstekonto, ev. användaren och dess grupper (utan lösenord om inget anges) */
export async function ldapTest(p, username, password) {
  const id = username ? await ldap.authenticate(p, username, password, { withPassword: !!password }) : null;
  if (!username) { const c = await ldap.connect(p); try { if (p.bindDn) { const r = await c.bind(p.bindDn, p.bindPassword || ''); if (r.code !== 0) throw new Error('Tjänstekontot kunde inte logga in mot LDAP-servern'); } } finally { c.close(); } }
  return { ok: true, user: id ? { dn: id.dn, username: id.username, email: id.email, displayName: id.displayName, groups: id.groups.slice(0, 50), role: roleFor(p, id.groups), libraries: libsFor(p, id.groups) } : null, found: !!id };
}
