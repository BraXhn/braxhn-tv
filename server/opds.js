// OPDS-katalogen (OPDS 1.2, Atom) för läsappar som KOReader, Panels, Chunky, Moon+ Reader och Thorium.
//
// Inloggning: HTTP Basic med profilens namn och ett eget lösenord för läsappar (opds_passwords i db.js). Det skapas
// under Mitt konto, visas en gång och sparas bara som SHA-256. Det gäller bara /api/opds/* – routealternativet opds i
// http/router.js sätter aldrig c.user från kaka, Bearer eller ?t=, och /api/opds/* matchar bara opds-routes. Lösenordet
// kan inte bära tvåstegsverifiering, så fjärrreglerna (remoteDenied) gäller som för musikappar: skapas bara hemifrån
// eller utifrån med kod från autentiseringsappen. Misslyckade inloggningar spärras som vanliga (auth.js ipBlocked).
// Innehållet följer profilens behörighet (ebooks.visible) och nedladdning kräver rätten att ladda ner.
import crypto from 'node:crypto';
import { get, run, now } from './db.js';
import { sha, ipBlocked, noteFail, userLocked, clearFails } from './auth.js';

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
// Tecken som inte får finnas i XML 1.0 tas bort (en titel från en fil kan innehålla vad som helst)
export const x = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/[&<>"']/g, c => XML_ESC[c]);

// ---------- lösenord ----------
/** Nytt lösenord (visas en gång): 24 tecken ur ett alfabet utan förväxlingsbara tecken */
export function newSecret() {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(24);
  return [...b].map(v => A[v % A.length]).join('').replace(/(.{6})(?=.)/g, '$1-');
}
export function createPassword(uid, { ip = null, trusted = false } = {}) {
  const secret = newSecret();
  run(`INSERT INTO opds_passwords(user_id,key_hash,created,created_ip,trusted,last_used,last_ip,client) VALUES(?,?,?,?,?,NULL,NULL,NULL)
    ON CONFLICT(user_id) DO UPDATE SET key_hash=excluded.key_hash, created=excluded.created, created_ip=excluded.created_ip, trusted=excluded.trusted,
    last_used=NULL, last_ip=NULL, client=NULL`, uid, sha(secret), now(), ip, trusted ? 1 : 0);
  return secret;
}
export const revokePassword = (uid) => run('DELETE FROM opds_passwords WHERE user_id=?', uid).changes > 0;
export function info(uid) {
  const r = get('SELECT created, created_ip, trusted, last_used, last_ip, client FROM opds_passwords WHERE user_id=?', uid);
  return r ? { created: r.created, createdFrom: r.trusted ? 'hemma' : 'utifrån', lastUsed: r.last_used, lastIp: r.last_ip, client: r.client } : null;
}

const eq = (a, b) => { const p = Buffer.from(String(a)), q = Buffer.from(String(b)); return p.length === q.length && crypto.timingSafeEqual(p, q); };
const USER_COLS = 'u.id, u.name, u.remote_allowed, u.totp_enabled, u.parent_id, u.max_age, u.is_admin, o.key_hash, o.last_used';
export class OpdsAuthError extends Error { constructor(msg, status = 401) { super(msg); this.status = status; } }
/**
 * Basic-inloggningen i Authorization-rubriken → profilen. Kastar OpdsAuthError (401 = fel/saknas, 429 = spärrad).
 * Fjärrreglerna kontrolleras av routen (remoteDenied i http/router.js).
 */
export function authenticate(header, { ip, trusted, client }) {
  const m = /^Basic\s+([A-Za-z0-9+/=]{1,400})$/.exec(String(header || '').trim());
  if (!m) throw new OpdsAuthError('Inloggning krävs');
  if (ipBlocked(ip)) throw new OpdsAuthError('För många misslyckade inloggningar – vänta en stund och försök igen', 429);
  const dec = Buffer.from(m[1], 'base64').toString('utf8');
  const i = dec.indexOf(':');
  const name = i < 0 ? '' : dec.slice(0, i).slice(0, 64), pw = i < 0 ? '' : dec.slice(i + 1);
  if (!name || !pw) throw new OpdsAuthError('Inloggning krävs');
  if (!trusted && userLocked(name)) { noteFail(ip, null); throw new OpdsAuthError('Fel användarnamn eller lösenord'); }
  const u = get(`SELECT ${USER_COLS} FROM opds_passwords o JOIN users u ON u.id=o.user_id WHERE u.name=?`, name);
  // Samma arbete oavsett om kontot finns (ingen tidsskillnad som avslöjar namnen)
  const ok = eq(sha(pw), u ? u.key_hash : sha('\u0000ingen'));
  if (!u || !ok) { noteFail(ip, name); throw new OpdsAuthError('Fel användarnamn eller lösenord'); }
  clearFails(name);
  if (now() - (u.last_used || 0) > 600) run('UPDATE opds_passwords SET last_used=?, last_ip=?, client=? WHERE user_id=?', now(), ip,
    client ? String(client).replace(/[\u0000-\u001f]/g, '').slice(0, 80) : null, u.id);
  const { key_hash, last_used, ...user } = u;
  return { ...user, is_admin: 0, kind: 'opds', via: 'opds' };
}

// ---------- flödena ----------
export const NAV = 'application/atom+xml;profile=opds-catalog;kind=navigation';
export const ACQ = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
export const MIME = { epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip' };
const iso = (t) => new Date((t || now()) * 1000).toISOString();
/** Ett Atom-flöde. links = [{ rel, href, type }], entries = färdiga <entry>-strängar */
export function feed({ id, title, updated, links = [], entries = [], total = null, start = null, perPage = null }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog"
  xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:pse="http://vaemendis.net/opds-pse/ns">
<id>${x(id)}</id><title>${x(title)}</title><updated>${iso(updated)}</updated><author><name>BraXhn TV</name></author>
${total != null ? `<opensearch:totalResults>${+total}</opensearch:totalResults><opensearch:startIndex>${+start}</opensearch:startIndex><opensearch:itemsPerPage>${+perPage}</opensearch:itemsPerPage>\n` : ''}${links.map(l => `<link rel="${x(l.rel)}" href="${x(l.href)}" type="${x(l.type)}"${l.title ? ` title="${x(l.title)}"` : ''}/>`).join('\n')}
${entries.join('\n')}
</feed>`;
}
/** Navigeringspost (en underkatalog) */
export const navEntry = ({ id, title, href, content = '', updated, kind = NAV }) =>
  `<entry><id>${x(id)}</id><title>${x(title)}</title><updated>${iso(updated)}</updated>${content ? `<content type="text">${x(content)}</content>` : ''}<link rel="subsection" href="${x(href)}" type="${x(kind)}"/></entry>`;
/** Bokpost med omslag, nedladdning (om tillåten) och sidströmning (OPDS-PSE) för serietidningar */
export function bookEntry(b, { base, download }) {
  const links = [];
  if (b.cover) {
    links.push(`<link rel="http://opds-spec.org/image" href="${x(`${base}/book/${b.id}/cover`)}" type="image/jpeg"/>`);
    links.push(`<link rel="http://opds-spec.org/image/thumbnail" href="${x(`${base}/book/${b.id}/cover?w=320`)}" type="image/jpeg"/>`);
  }
  if (download) links.push(`<link rel="http://opds-spec.org/acquisition" href="${x(`${base}/book/${b.id}/file`)}" type="${MIME[b.format]}"/>`);
  if (b.format === 'cbz' && b.pages) links.push(`<link rel="http://vaemendis.net/opds-pse/stream" href="${x(`${base}/book/${b.id}/page/`)}{pageNumber}?width={maxWidth}" type="image/jpeg" pse:count="${+b.pages}"${b.percent ? ` pse:lastRead="${Math.floor(b.percent / 100 * (b.pages - 1))}"` : ''}/>`);
  const series = b.series ? `${b.series}${b.seriesNo != null ? ' #' + b.seriesNo : ''}` : '';
  return `<entry><id>urn:braxhn:ebook:${+b.id}</id><title>${x(b.title)}</title><updated>${iso(b.updated || b.added)}</updated>
${b.author ? b.author.split(/\s*,\s*/).slice(0, 5).map(a => `<author><name>${x(a)}</name></author>`).join('') : ''}${b.year ? `<dc:issued>${+b.year}</dc:issued>` : ''}${b.language ? `<dc:language>${x(b.language)}</dc:language>` : ''}
${series || b.description ? `<content type="text">${x([series, b.description].filter(Boolean).join(' – ').slice(0, 2000))}</content>` : ''}${links.join('')}</entry>`;
}
export const OPENSEARCH = (base) => `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>BraXhn TV</ShortName><Description>Sök bland e-böcker och serietidningar</Description>
<InputEncoding>UTF-8</InputEncoding><OutputEncoding>UTF-8</OutputEncoding>
<Url type="${ACQ}" template="${x(base)}/search?q={searchTerms}"/></OpenSearchDescription>`;
