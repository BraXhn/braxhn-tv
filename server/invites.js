// Inbjudningslänkar: administratören skapar en länk (engångs, med utgångstid) som låter mottagaren skapa ett eget
// konto med förvalda rättigheter (bibliotek, nedladdning, fjärråtkomst, åldersgräns, kvalitetstak, samtidiga strömmar).
//
// Säkerhet:
//   - Token är 32 slumpade byte (hex) och lagras bara som SHA-256 i invites.token_hash – den visas en gång när den skapas.
//   - Länken är engångs: kontot skapas och inbjudan markeras använd i samma transaktion (UPDATE … WHERE used_at IS NULL).
//   - Gissning begränsas av routern i routes/auth.js (ipBlocked/noteFail som vid inloggning); en ogiltig, använd och
//     utgången länk ger samma svar så att ingen kan se skillnad.
//   - Lösenordet prövas med weakPassword precis som när administratören skapar ett konto. Konton från inbjudningar blir
//     aldrig administratörer.
import { randomBytes } from 'node:crypto';
import { get, all, run, now, tx } from './db.js';
import { sha } from './auth.js';
import { normLibs, normQuality, normStreams } from './perms.js';

export const MAX_DAYS = 30, MAX_OPEN = 50;
/** Rättigheterna i en inbjudan (samma fält som användarens rättigheter i administrationen) */
export function normPerms(b = {}) {
  return {
    libraries: normLibs(b.libraries ?? null), canDownload: b.canDownload !== false, remoteAllowed: b.remoteAllowed !== false,
    maxAge: b.maxAge === '' || b.maxAge == null ? null : Math.max(0, Math.min(18, parseInt(b.maxAge) || 0)),
    remoteQuality: normQuality(b.remoteQuality), maxStreams: normStreams(b.maxStreams)
  };
}
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const shape = (r) => ({ id: r.id, created: r.created, expires: r.expires, note: r.note || null, perms: parse(r.perms),
  used: !!r.used_at, usedAt: r.used_at || null, usedName: r.used_name || null, expired: !r.used_at && r.expires <= now(), createdBy: r.created_by_name || null });

/** Skapar en inbjudan. Returnerar { invite, token } – token finns bara i det här svaret. */
export function create(adminId, b = {}) {
  const days = Math.max(1, Math.min(MAX_DAYS, parseInt(b.days) || 7));
  const perms = normPerms(b);
  if (get('SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND expires > ?', now()).n >= MAX_OPEN)
    throw Object.assign(new Error(`Högst ${MAX_OPEN} öppna inbjudningar – ta bort några först`), { status: 400 });
  const token = randomBytes(32).toString('hex');
  const id = Number(run('INSERT INTO invites(token_hash,created_by,created,expires,perms,note) VALUES(?,?,?,?,?,?)',
    sha(token), adminId, now(), now() + days * 86400, JSON.stringify(perms), String(b.note || '').trim().slice(0, 100) || null).lastInsertRowid);
  return { invite: shape(get('SELECT * FROM invites WHERE id=?', id)), token };
}
export const list = () => all(`SELECT i.*, u.name AS created_by_name FROM invites i LEFT JOIN users u ON u.id=i.created_by ORDER BY i.created DESC LIMIT 200`).map(shape);
export const remove = (id) => run('DELETE FROM invites WHERE id=?', id).changes > 0;
/** Giltig inbjudan för token (inte använd, inte utgången), annars null */
export function find(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const r = get('SELECT * FROM invites WHERE token_hash=?', sha(token));
  return r && !r.used_at && r.expires > now() ? r : null;
}
/**
 * Skapar kontot och förbrukar inbjudan (atomiskt). hash = lösenordets hash (auth.hashPw). Returnerar användarens id,
 * eller kastar Error med status (409 namnet upptaget, 410 inbjudan inte längre giltig).
 */
export function accept(token, name, hash) {
  return tx(() => {
    const r = find(token);
    if (!r) throw Object.assign(new Error('Inbjudan är ogiltig eller har gått ut'), { status: 410 });
    const p = normPerms(parse(r.perms) || {});
    if (get('SELECT 1 FROM users WHERE name=? COLLATE NOCASE', name)) throw Object.assign(new Error('Namnet är upptaget'), { status: 409 });
    const uid = Number(run(`INSERT INTO users(name,pass,is_admin,created,pw_changed,remote_allowed,max_age,libraries,can_download,remote_quality,max_streams)
      VALUES(?,?,0,?,?,?,?,?,?,?,?)`, name, hash, now(), now(), p.remoteAllowed ? 1 : 0, p.maxAge, p.libraries == null ? null : JSON.stringify(p.libraries),
      p.canDownload ? 1 : 0, p.remoteQuality, p.maxStreams).lastInsertRowid);
    // Engångs: bara den som hinner först förbrukar den (två samtidiga försök – det andra rullas tillbaka)
    if (run('UPDATE invites SET used_at=?, used_by=?, used_name=? WHERE id=? AND used_at IS NULL', now(), uid, name, r.id).changes !== 1)
      throw Object.assign(new Error('Inbjudan är ogiltig eller har gått ut'), { status: 410 });
    return uid;
  });
}
