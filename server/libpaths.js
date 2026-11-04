// Flera mappar per bibliotek. Tabellen library_paths (db.js) har alla mappar i ordning; libraries.path är alltid
// den första (apparna, äldre versioner och säkerhetskopior läser bara den). Ett bibliotek utan rader i
// library_paths har bara libraries.path – så fungerar en databas från en äldre version utan migrering.
//
// Raderingsskyddet gäller varje mapp för sig: en mapp som inte går att läsa, som är tom eller där mer än hälften
// av titlarna försvunnit tar aldrig bort något – och det påverkar inte de andra mapparna i biblioteket.
import path from 'node:path';
import { all, run, tx } from './db.js';
import { listFiles, deletionBlocked, underFailed, fsReason } from './util.js';

export const MAX_ROOTS = 20;

/** Bibliotekets mappar i ordning (minst en) */
export function rootsOf(lib) {
  const r = all('SELECT path FROM library_paths WHERE library_id=? ORDER BY pos', lib.id).map(x => x.path);
  return r.length ? r : [lib.path];
}
/** Alla bibliotek med sina mappar: [{ id, name, type, path, roots }] */
export const librariesWithRoots = (where = '', ...params) =>
  all(`SELECT * FROM libraries${where ? ' WHERE ' + where : ''} ORDER BY id`, ...params).map(l => ({ ...l, roots: rootsOf(l) }));

/** Spara bibliotekets mappar (redan kontrollerade med insideMedia). Den första blir libraries.path. */
export function setRoots(libId, paths) {
  if (!paths.length) throw new Error('Minst en mapp krävs');
  tx(() => {
    run('DELETE FROM library_paths WHERE library_id=?', libId);
    paths.forEach((p, i) => run('INSERT INTO library_paths(library_id,path,pos) VALUES(?,?,?)', libId, p, i));
    run('UPDATE libraries SET path=? WHERE id=?', paths[0], libId);
  });
}

/** Ligger p i (eller är) mappen root? */
export const under = (root, p) => p === root || p.startsWith(root + path.sep);
/** Mappar som ligger i varandra (eller är samma) – sådana får inte finnas i samma bibliotek */
export function nested(paths) {
  for (let i = 0; i < paths.length; i++) for (let j = 0; j < paths.length; j++) if (i !== j && under(paths[i], paths[j])) return [paths[i], paths[j]];
  return null;
}
/** Mappen som filen ligger i, eller null */
export const rootOf = (roots, file) => roots.find(r => file.startsWith(r + path.sep)) || null;
/** Filens sökväg relativt sin biblioteksmapp (som path.relative(lib.path, file) när biblioteket har en mapp) */
// Under mappen: resten av sökvägen direkt (samma som path.relative för normaliserade sökvägar, som skanningens) –
// path.relative löser upp båda sökvägarna varje gång, ~9 µs per fil och 0,5 s per skanning med 60 000 filer
export function relOf(roots, file) {
  const r = rootOf(roots, file);
  return r ? file.slice(r.length + 1) : path.relative(roots[0], file);
}

/**
 * listFiles över alla mappar. Mappar som inte går att läsa hamnar i failed (ingenting under dem tas bort).
 * badNames = filer/mappar med ogiltig UTF-8 i namnet, errors = orsaken per mapp som inte gick att läsa (högst 50 per mapp).
 * @returns {Promise<{ files: string[], failed: string[], dirs: Set<string>, roots: { root: string, ok: boolean }[], rootOk: boolean, badNames: string[], errors: { path: string, code: string, message: string }[] }>}
 */
export async function listRoots(roots, accept, skip) {
  const files = [], failed = [], dirs = new Set(), state = [], badNames = [], errors = [];
  for (const root of roots) {
    const r = await listFiles(root, accept, skip, dirs);
    for (const f of r.files) files.push(f);
    for (const d of r.failed) failed.push(d);
    for (const b of r.badNames || []) badNames.push(b);
    for (const e of r.errors || []) errors.push(e);
    if (!r.rootOk) failed.push(root);
    state.push({ root, ok: r.rootOk, error: r.rootError || null });
  }
  return { files, failed, dirs, roots: state, rootOk: state.some(s => s.ok), badNames, errors };
}

/**
 * Varningar från genomgången som en hemanvändare kan förstå och åtgärda: mappar som inte gick att läsa (med orsak –
 * behörighet, trasig länk, nätverksresurs som tappats …) och filnamn med ogiltig UTF-8. Många likadana slås ihop till en
 * rad (ett bibliotek med 3 000 trasiga länkar ska inte ge 3 000 rader i loggen).
 * @returns {string[]}
 */
export function listWarnings(name, list) {
  const out = [];
  for (const st of list.roots) if (!st.ok && st.error && st.error !== 'ENOENT') out.push(`${name}: ${st.root} går inte att läsa – ${fsReason(st.error)}`);
  const sub = (list.errors || []).filter(e => !list.roots.some(r => r.root === e.path));
  const byCode = new Map();
  for (const e of sub) { if (!byCode.has(e.code)) byCode.set(e.code, []); byCode.get(e.code).push(e.path); }
  const extra = list.failed.length - sub.length - list.roots.filter(r => !r.ok).length;
  for (const [code, paths] of byCode) {
    const more = paths.length - 3 + (byCode.size === 1 && extra > 0 ? extra : 0);
    out.push(`${name}: kunde inte läsa ${paths.slice(0, 3).join(', ')}${more > 0 ? ` och ${more} till` : ''} – ${fsReason(code)}; det som fanns där behålls`);
  }
  const bad = list.badNames || [];
  if (bad.length) out.push(`${name}: ${bad.length} ${bad.length === 1 ? 'fil eller mapp har' : 'filer eller mappar har'} ett namn som inte är giltig UTF-8 och hoppas över (t.ex. ${bad[0]}) – byt namn (t.ex. med convmv -f latin1 -t utf8)`);
  return out;
}

/**
 * Vilka försvunna rader får tas bort? Raderingsskyddet (deletionBlocked i util.js) prövas per mapp: mappens kända
 * rader, hittade mediafiler och saknade rader. Rader under en mapp som inte gick att läsa och rader utanför alla
 * mappar (t.ex. medan en mapp tas bort) rörs aldrig.
 * @param {{ name: string, list: Awaited<ReturnType<typeof listRoots>>, rows: object[], seen: Set<string>,
 *   found: string[], allowMass: boolean, warn: (msg: string) => void, keyOf?: (row: object) => string }} o
 * @returns {object[]} raderna som får tas bort
 */
export function removable({ name, list, rows, seen, found, allowMass, warn, keyOf = (r) => r.path }) {
  const out = [], many = list.roots.length > 1;
  for (const st of list.roots) {
    const mine = rows.filter(r => under(st.root, keyOf(r)));
    const missing = mine.filter(r => !seen.has(keyOf(r)) && !underFailed(keyOf(r), list.failed));
    let files = 0;
    for (const f of found) if (under(st.root, f)) files++;
    const blocked = deletionBlocked({ name: many ? `${name} (${st.root})` : name, rootOk: st.ok, files, known: mine.length, missing: missing.length, allowMass });
    if (blocked) { if (missing.length || !st.ok) warn(blocked); continue; }
    for (const r of missing) out.push(r);
  }
  return out;
}
