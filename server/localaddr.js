// Hemma via den publika adressen: servern talar om sina adresser på hemnätet för inloggade klienter, och ett provanrop
// som BARA svarar på hemnätet bevisar för klienten att adressen är just den här servern. Apparna går då direkt dit
// (förfrågningarna kommer från en adress i hemnätet och räknas som hemma av isTrusted, som vanligt). Webben kan inte
// prova en http-adress från en https-sida, så den byter hela sidan till hemadressen med en engångskod (handoff/redeem).
//
// SÄKERHET – ingenting här gör någon till "hemma". Hemma avgörs fortfarande bara av isTrusted/isLocalReq (router.js,
// util.js) för varje förfrågan. Det här modulen gör är:
//   - addresses(): adresserna (bara origin: schema, IP/namn och port) – visas bara för inloggade (routes/local.js).
//   - challenge()/proof(): n = "<utgång>.<slump>", proof = HMAC(serverns nyckel, n). Klienten får (n, proof) över den
//     inloggade, publika förbindelsen och frågar sedan hemadressen /api/local/ping?n=… . Pingen svarar med proof bara
//     när förfrågan själv kommer från hemnätet (isLocalReq: aldrig via reläet, aldrig med en publik adress i
//     X-Forwarded-For). En annan maskin med samma IP på ett annat nät (t.ex. ett kafé) kan alltså inte svara rätt – inte
//     ens genom att skicka pingen vidare till den publika adressen – och appen skickar aldrig sin inloggning dit.
//   - Engångskoder för webben: skapas av en inloggad webbsession (var som helst), löses in bara från hemnätet, en gång,
//     inom två minuter. Koden står i adressens fragment (#), som aldrig skickas till någon server eller hamnar i loggar.
//
// Adresserna, i ordning: LOCAL_URL / inställningen local_url (administratören), adressen en administratör senast
// öppnade servern på direkt i hemnätet (Host är en privat IPv4-adress, utan proxy och utan relä), och – utanför Docker –
// nätverkskortens privata IPv4-adresser med PORT. I Docker (bridge) ser containern bara sin interna adress, som ingen
// klient når; därför används inte nätverkskorten där.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { getSetting, setSetting } from './db.js';
import { isPrivate, viaRelay, peerIp } from './util.js';

export const TTL = 120;      // sekunder som ett prov (n) och en engångskod gäller
export const MAX_ADDRS = 4;  // klienten provar alla samtidigt

const rand = (n) => crypto.randomBytes(n).toString('hex');
function persistent(k, bytes) {
  let v = getSetting(k, '');
  if (!/^[a-f0-9]+$/.test(v) || v.length !== bytes * 2) { v = rand(bytes); setSetting(k, v); }
  return v;
}
/** Serverns id (slumpat en gång): visas av provanropet så att klienten kan se att det är samma server */
export const serverId = () => persistent('server_uid', 16);
const key = () => persistent('local_key', 32);

/** En adress → origin (http/https, värd och port), annars null. Ingen sökväg, inga inloggningsuppgifter. */
export function normOrigin(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname) return null;
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
  return u.origin;
}
/** Administratörens egna adresser (LOCAL_URL eller inställningen local_url, kommaseparerade) */
export function configured() {
  return String(getSetting('local_url', process.env.LOCAL_URL || '')).split(',').map(normOrigin).filter(Boolean);
}

// ---------- adressen som en administratör använder hemma ----------
let seen = null; // { origin } i minnet; sparas bara när den ändras
const seenOrigin = () => { if (seen === null) seen = normOrigin(getSetting('local_seen', '')) || ''; return seen; };
/**
 * Kom förfrågan DIREKT från hemnätet till en privat IPv4-adress? Motparten (TCP) ska själv vara privat, utan
 * X-Forwarded-*, och inte via reläet. Host är det klienten skrev – därför används den bara för inloggade
 * administratörer (se learn) och bara när den är en privat IPv4-adress.
 */
export function directHost(req) {
  if (viaRelay(req) || !isPrivate(peerIp(req))) return null;
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto'] || req.headers.forwarded) return null;
  const host = String(req.headers.host || '').toLowerCase();
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(host);
  if (!m || net.isIP(m[1]) !== 4 || !isPrivate(m[1]) || /^127\./.test(m[1])) return null;
  if (m[2] && !(+m[2] > 0 && +m[2] < 65536)) return null;
  return normOrigin(`${req.socket?.encrypted ? 'https' : 'http'}://${host}`);
}
/** Kom ihåg adressen en inloggad administratör öppnade servern på hemma (anropas från /api/status) */
export function learn(req, user) {
  if (!user?.is_admin || (user.kind !== 'web' && user.kind !== 'app')) return;
  const o = directHost(req);
  if (!o || o === seenOrigin()) return;
  seen = o;
  try { setSetting('local_seen', o); } catch {}
}

function inDocker() { try { return fs.existsSync('/.dockerenv'); } catch { return false; } }
/** Nätverkskortens privata IPv4-adresser (inte i Docker, se överst) */
export function interfaceOrigins() {
  if (process.env.LOCAL_DETECT === '0' || inDocker()) return [];
  const port = +process.env.PORT || 8420, out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) out.push(`http://${a.address}:${port}`);
  }
  return out;
}
/** Adresserna som klienterna provar (högst MAX_ADDRS, utan dubbletter) */
export function addresses() {
  const all = [...configured(), seenOrigin(), ...interfaceOrigins()].filter(Boolean);
  return [...new Set(all)].slice(0, MAX_ADDRS);
}

// ---------- provet ----------
const now = () => Math.floor(Date.now() / 1000);
const hmac = (n) => crypto.createHmac('sha256', key()).update('bx-local|' + n).digest('hex');
/** Ett nytt prov: n (utgång + slump) och svaret som bara servern kan räkna ut */
export function challenge() {
  const n = `${now() + TTL}.${rand(16)}`;
  return { n, proof: hmac(n) };
}
/** Svaret på ett prov, eller null när n är ogiltigt eller för gammalt */
export function proof(n) {
  const m = /^(\d{10})\.([a-f0-9]{32})$/.exec(String(n || ''));
  if (!m || +m[1] < now() || +m[1] > now() + TTL + 5) return null;
  return hmac(n);
}

// ---------- engångskoder för webben ----------
const codes = new Map(); // sha256(kod) → { uid, remember, exp }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function sweep() { const t = now(); for (const [k, v] of codes) if (v.exp < t) codes.delete(k); }
/** Ny engångskod för användaren (högst fem samtidigt per användare, de äldsta tas bort) */
export function newCode(uid, remember) {
  sweep();
  const mine = [...codes].filter(([, v]) => v.uid === uid);
  for (const [k] of mine.slice(0, Math.max(0, mine.length - 4))) codes.delete(k);
  if (codes.size >= 1000) codes.delete(codes.keys().next().value);
  const code = rand(32);
  codes.set(sha(code), { uid, remember: !!remember, exp: now() + TTL });
  return code;
}
/** Löser in en kod (en gång): { uid, remember } eller null */
export function takeCode(code) {
  if (!/^[a-f0-9]{64}$/.test(String(code || ''))) return null;
  const k = sha(code), v = codes.get(k);
  if (!v) return null;
  codes.delete(k);
  return v.exp >= now() ? v : null;
}
/** Bara för testerna */
export function _reset() { codes.clear(); seen = null; }
