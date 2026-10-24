// Sökning: rankad matchning på söknycklarna (skey/skey2, se searchkey.js och searchKeys i db.js).
// Förurvalet görs i SQLite (instr på nyckeln – ingen LIKE, så % och _ är vanliga tecken), rankningen i JS på högst
// CAP kandidater. Stavfel prövas bara när en grupp saknar exakta träffar: kandidaterna väljs med bigram i SQL och
// kontrolleras med redigeringsavstånd. FTS5 (trigram) finns i node:sqlite men kräver en skuggtabell med egna
// utlösare per tabell och ger ändå inget redigeringsavstånd – för ett hembibliotek räcker en genomsökning av en kort
// kolumn (10 000 titlar på några millisekunder).
import { all, refreshKeys } from './db.js';
import { parseQuery, rowScore, typosFor, bigrams } from './searchkey.js';

export { parseQuery };
const CAP = 2000, FUZZY_CAP = 400;

/** Räkna om nycklar för rader som lagts till eller ändrats sedan sist (billigt när inget har ändrats) */
export const freshKeys = () => refreshKeys();

/**
 * Rankade rader. spec:
 *   from   "FROM tabell x JOIN …"            where/params  extra villkor (åldersgräns, bibliotek …)
 *   cols   kolumner som behövs (gärna _t = rå titel, för å/ä/ö-bonusen)
 *   key    uttryck för nyckeln (t.ex. 'x.skey'), key2 = ev. sekundär nyckel (originaltitel, författare …)
 *   blob   kompakt form av båda för förurvalet (standard: key + 'c', alltså x.skeyc)
 *   year   uttryck för år (då gäller årsfiltret: "matrix 1999"), pop = uttryck för popularitet (vid lika poäng)
 *   colParams  parametrar i cols, pop och from (i den ordningen, före params)
 * Returnerar raderna sorterade med poängen i _s.
 */
export function ranked(spec, Q, limit) {
  if (!Q || Q.empty || limit <= 0) return [];
  refreshKeys(); // nya eller ändrade rader sedan sist (några indexuppslag när inget har ändrats)
  const hasYear = !!(spec.year && Q.year);
  const q = hasYear ? Q.text : Q.all;
  const K = spec.key, K2 = spec.key2 || null;
  // Förurvalet på den kompakta kolumnen (skeyc): ett ord som finns i nyckeln finns också i den kompakta formen
  const KC = spec.blob || `${K}c`;
  const conds = [], cp = [];
  for (const c of new Set([q.compact, Q.all.compact].filter(Boolean))) { conds.push(`instr(${KC}, ?) > 0`); cp.push(c); }
  if (q.words.length > 1) { conds.push('(' + q.words.map(() => `instr(${KC}, ?) > 0`).join(' AND ') + ')'); cp.push(...q.words); }
  const sel = (extra = '') => `SELECT ${extra}${spec.cols}, ${K} AS _k${K2 ? `, ${K2} AS _k2` : ''}${spec.year ? `, ${spec.year} AS _y` : ''}${spec.pop ? `, ${spec.pop} AS _n` : ''}
    ${spec.from} WHERE (${spec.where || '1'}) AND ${K} IS NOT NULL`;
  const P = [...(spec.colParams || []), ...(spec.params || [])];
  // Årsfiltret redan i SQL: rätt år, eller året står i titeln ("2001 – ett rymdäventyr")
  const yc = hasYear ? ` AND (${spec.year} = ? OR instr(${K}, ?) > 0)` : '', yp = hasYear ? [Q.year, String(Q.year)] : [];
  const score = (rows, fuzzy) => rows.map(r => { r._s = rowScore(Q, r, fuzzy, hasYear); return r; }).filter(r => r._s > 0);
  // Stora träffmängder ("a"): de med träffen tidigast i nyckeln och kortast nyckel tas med först
  let out = score(all(`${sel()}${yc} AND (${conds.join(' OR ')})
    ORDER BY CASE WHEN instr(${KC}, ?) = 0 THEN 9999 ELSE instr(${KC}, ?) END, length(${K}) LIMIT ${CAP}`, ...P, ...yp, ...cp, q.compact, q.compact), false);
  if (!out.length && q.words.some(w => typosFor(w) > 0)) {
    // Stavfel: minst så många av ordets bigram måste finnas kvar (ett fel förstör högst tre). De kandidater som
    // delar flest bigram med frågan kontrolleras med redigeringsavstånd.
    const fc = [], fp = [];
    let need = 0;
    for (const w of q.words) {
      const t = typosFor(w);
      if (!t) { fc.push(`(instr(${KC}, ?) > 0)`); fp.push(w); need++; continue; }
      const bg = bigrams(w);
      need += Math.max(1, bg.length - 3 * t);
      for (const b of bg) { fc.push(`(instr(${KC}, ?) > 0)`); fp.push(b); }
    }
    out = score(all(`SELECT * FROM (${sel(`${fc.join(' + ')} AS _g, `)}${yc}) WHERE _g >= ? ORDER BY _g DESC LIMIT ${FUZZY_CAP}`,
      ...fp, ...P, ...yp, need), true);
  }
  out.sort((a, b) => (b._s - a._s) || ((b._n ?? 0) - (a._n ?? 0)) || (a._k.length - b._k.length) || (a._k < b._k ? -1 : a._k > b._k ? 1 : 0));
  return out.slice(0, limit);
}

/** Titlar (filmer, serier, avsnitt) som matchar. age = ageFilter(uid) (alias i = titeln, s = ev. serie). Ger [{id, kind, _s}] */
export function searchItemIds(Q, kinds, age, limit) {
  return ranked({
    from: 'FROM items i LEFT JOIN items s ON s.id=i.parent_id',
    cols: 'i.id, i.kind, i.title AS _t',
    where: `i.kind IN (${kinds.map(() => '?').join(',')}) AND i.version_of IS NULL${age.sql}`, params: [...kinds, ...age.params],
    key: 'i.skey', key2: 'i.skey2', year: 'COALESCE(i.year, s.year)'
  }, Q, limit);
}
