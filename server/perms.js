// Rättigheter per användare (som delning i Plex): vilka bibliotek kontot/profilen får se, nedladdning,
// kvalitetstak utanför hemmet och högsta antal samtidiga strömmar. Kolumnerna i users (db.js):
//   libraries      JSON-lista med biblioteks-id. NULL = alla bibliotek (standard, bakåtkompatibelt).
//                  Profiler: NULL = samma som kontot; en egen lista begränsas ändå till kontots (snittet).
//   can_download   1/0 – originalfilen (/api/stream/:id/download), offline i apparna och nedladdning i musikappar.
//                  Profiler får aldrig mer än kontot.
//   remote_quality '1080', '720' … – tak utanför hemmet. Den lägsta av serverns inställning, kontots och profilens gäller.
//   max_streams    högsta antal samtidiga videoströmmar för hela hushållet (kontot + profiler). Sätts på kontot.
// Administratörer begränsas aldrig. Okänd användare = inga bibliotek alls (stängt som standard).
// Biblioteksbehörigheten kontrolleras centralt: allowedFor/ageFilter i http/context.js (titlar) och libFilter/libOk här
// (musik, ljudböcker, Subsonic, statistik). Modulen importerar bara db.js så att alla serverns moduler kan använda den.
import { get, getSetting } from './db.js';

export const QUALITY_ORDER = ['360', '480', '720', '1080', '2160', 'orig'];
const parseLibs = (s) => {
  if (s == null) return null;
  try { const a = JSON.parse(s); return Array.isArray(a) ? [...new Set(a.map(Number).filter(n => Number.isInteger(n) && n > 0))] : []; }
  catch { return []; } // trasig lista: inga bibliotek hellre än alla
};
/** Normaliserar en lista från API:t: null/undefined = alla, annars heltal > 0 (högst 500) */
export function normLibs(v) {
  if (v == null) return null;
  if (!Array.isArray(v)) throw Object.assign(new Error('Ogiltig lista med bibliotek'), { status: 400 });
  return [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 500);
}
export function normQuality(v) {
  if (v == null || v === '') return null;
  if (!QUALITY_ORDER.includes(String(v)) || String(v) === 'orig') throw Object.assign(new Error('Ogiltig kvalitet'), { status: 400 });
  return String(v);
}
export const normStreams = (v) => v == null || v === '' || +v === 0 ? null : Math.max(1, Math.min(20, parseInt(v) || 1));
/** Lägsta av två kvaliteter (null = ingen gräns) */
export const minQuality = (a, b) => a == null ? b : b == null ? a : QUALITY_ORDER.indexOf(a) <= QUALITY_ORDER.indexOf(b) ? a : b;

/**
 * Effektiva rättigheter: { libs: number[]|null, download, remoteQuality: string|null (bara användarens tak), maxStreams, root, admin, maxAge }
 * Slås upp i databasen varje gång (en indexerad fråga) – ändringar gäller direkt, även för pågående uppspelningar.
 */
export function permsOf(uid) {
  const r = uid ? get(`SELECT u.id, u.is_admin, u.parent_id, u.max_age, u.libraries, u.can_download, u.remote_quality, u.max_streams,
      p.is_admin AS p_admin, p.libraries AS p_libraries, p.can_download AS p_download, p.remote_quality AS p_quality, p.max_streams AS p_streams
    FROM users u LEFT JOIN users p ON p.id=u.parent_id WHERE u.id=?`, uid) : null;
  if (!r) return { libs: [], download: false, remoteQuality: null, maxStreams: null, root: uid, admin: false, maxAge: 0 };
  if (r.is_admin) return { libs: null, download: true, remoteQuality: null, maxStreams: null, root: r.id, admin: true, maxAge: r.max_age ?? null };
  const own = parseLibs(r.libraries);
  if (r.parent_id == null) return { libs: own, download: !!r.can_download, remoteQuality: r.remote_quality || null, maxStreams: r.max_streams || null, root: r.id, admin: false, maxAge: r.max_age ?? null };
  // Profil: ärver kontot (administratörens profiler ärver ingen begränsning från kontot)
  const pAdmin = !!r.p_admin;
  const parent = pAdmin ? null : parseLibs(r.p_libraries);
  const libs = own == null ? parent : parent == null ? own : own.filter(x => parent.includes(x));
  return { libs, download: !!r.can_download && (pAdmin || r.p_download !== 0), remoteQuality: minQuality(r.remote_quality || null, pAdmin ? null : r.p_quality || null),
    maxStreams: pAdmin ? null : r.p_streams || null, root: r.parent_id, admin: false, maxAge: r.max_age ?? null };
}
/** Tillåtna bibliotek (null = alla) */
export const libsOf = (uid) => permsOf(uid).libs;
/** Får användaren se biblioteket? */
export const libOk = (uid, libId) => { const l = libsOf(uid); return l == null || l.includes(Number(libId)); };
/**
 * SQL-villkor för bibliotek: { sql: ' AND <col> IN (…)', params } eller tomt när alla är tillåtna.
 * col är ett fast kolumnnamn i koden (t.ex. 'i.library_id', 't.library_id') – aldrig något från klienten.
 */
export function libFilter(uid, col) {
  if (!/^[a-z]{1,3}\.library_id$/.test(col)) throw new Error('ogiltig kolumn: ' + col);
  const l = libsOf(uid);
  return l == null ? { sql: '', params: [] } : { sql: ` AND ${col} IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(l)] };
}
export const canDownload = (uid) => permsOf(uid).download;
/** Kvalitetstaket utanför hemmet: serverns inställning sänkt till användarens tak */
export const remoteMax = (uid) => minQuality(getSetting('remote_quality', process.env.REMOTE_QUALITY || '1080'), permsOf(uid).remoteQuality) || '1080';
