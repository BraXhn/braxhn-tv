// Söknyckel och rankning – rena funktioner utan importer (används av db.js när nycklarna fylls i och av search.js).
//
// Nyckeln: NFKD, diakritiska tecken bort, gemener, bara bokstäver och siffror med ett mellanslag mellan orden.
// å, ä och ö viks till a, a och o – både i nyckeln och i frågan. Då hittar "ö" både "ö" och "o" (och "o" hittar
// "ö": "angelagard" hittar Änglagård, viktigt på TV-tangentbord och för den som söker på engelska titlar).
// Priset är att "for" även hittar "för"; därför får en träff som stämmer med diakritiska tecken (rå titel
// innehåller rå fråga) en liten bonus i rankningen. Att lagra båda varianterna hade dubblat nycklarna utan att ge
// fler träffar än vikningen. Den kompakta varianten (utan mellanslag: "spiderman") räknas fram ur nyckeln.

const FOLD = { æ: 'ae', ø: 'o', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', þ: 'th', ł: 'l', ı: 'i' };
/** Normaliserad söknyckel med ord: "Spider-Man: Över Gränsen" → "spider man over gransen" */
export function searchKey(s) {
  return String(s ?? '').normalize('NFKD').toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[æøœßđðþłı]/g, (c) => FOLD[c])
    .replace(/['’‘`´ʼ]/g, '') // "Schindler's" → "schindlers"
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
/** Kompakt variant (inga mellanslag): "spider man" → "spiderman" */
export const compactKey = (k) => String(k ?? '').replaceAll(' ', '');

const YEAR = /^(18|19|20)\d\d$/;
const mkQ = (words) => ({ words, key: words.join(' '), compact: words.join('') });
/**
 * Tolka en sökfråga. Ett år bland flera ord ("matrix 1999") blir ett årsfilter för titlar med år; titlar med
 * talet i namnet ("2001 – ett rymdäventyr") hittas ändå via hela frågan (all).
 */
export function parseQuery(q) {
  const raw = String(q ?? '').normalize('NFC').trim().slice(0, 100);
  const all = searchKey(raw).split(' ').filter(Boolean);
  let year = null, text = all;
  if (all.length > 1) {
    const i = all.findLastIndex((w) => YEAR.test(w));
    if (i >= 0) { year = +all[i]; text = all.filter((_, j) => j !== i); }
  }
  return { raw: raw.toLowerCase(), year, all: mkQ(all), text: mkQ(text), empty: !all.length };
}

/** Optimal string alignment (Damerau–Levenshtein med intilliggande byten); avbryter när max överskrids */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let pp = null, p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (pp && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, pp[j - 2] + 1);
      c.push(v);
      if (v < low) low = v;
    }
    if (low > max) return max + 1;
    pp = p; p = c;
  }
  return p[b.length];
}
/** Antal tillåtna stavfel för ett ord: inga under 4 tecken, ett för 4–7, två från 8 */
export const typosFor = (w) => w.length < 4 ? 0 : w.length < 8 ? 1 : 2;

// Inledande artiklar räknas inte när man jämför titelns början ("The Matrix" börjar med "matrix")
const ARTICLES = new Set(['the', 'a', 'an', 'en', 'ett', 'den', 'det', 'de', 'le', 'la', 'les', 'el', 'il', 'der', 'die', 'das']);
const wordStarts = (words) => { const s = []; let n = 0; for (const w of words) { s.push(n); n += w.length; } return s; };

/** Stavfel för ett ord mot nyckelns ord (hela ord, ordbörjan eller en bit av den kompakta nyckeln från en ordgräns) */
function wordTypos(w, kw, kc, starts) {
  const max = typosFor(w);
  if (!max) return kw.some((x) => x.startsWith(w)) ? 0 : Infinity;
  let best = max + 1;
  for (const x of kw) {
    if (x.startsWith(w)) return 0;
    best = Math.min(best, editDistance(w, x, max));
    if (x.length > w.length) best = Math.min(best, editDistance(w, x.slice(0, w.length), max));
  }
  // "spidermn" ≈ "spiderman" (ihopskrivet mot två ord i titeln)
  if (best > max) {
    for (const s of starts) for (let L = Math.max(1, w.length - max); L <= w.length + max && s + L <= kc.length; L++) best = Math.min(best, editDistance(w, kc.slice(s, s + L), max));
  }
  return best <= max ? best : Infinity;
}

/**
 * Poäng för en nyckel mot frågan (0 = ingen träff). Exakt 100 (97 efter en artikel) > början av titeln 88/85 > början av ord 70/65 >
 * innehåller 50/45 > stavfel 30 − 6 per fel. fuzzy: false = bara exakta nivåer.
 */
export function keyScore(Q, k, fuzzy = false) {
  if (!k || !Q.compact) return 0;
  const kc = compactKey(k);
  if (kc === Q.compact) return 100;
  const kw = k.split(' ');
  const bare = kw.length > 1 && ARTICLES.has(kw[0]) ? kc.slice(kw[0].length) : null;
  if (bare === Q.compact) return 97;
  if (kc.startsWith(Q.compact)) return k.startsWith(Q.key + ' ') ? 88 : 85; // hela första ordet före en ordbörjan
  if (bare?.startsWith(Q.compact)) return 82;
  if (Q.words.every((w) => kw.some((x) => x.startsWith(w)))) return 70;
  const starts = wordStarts(kw);
  if (starts.some((s) => kc.startsWith(Q.compact, s))) return 65;
  if (kc.includes(Q.compact)) return 50;
  // Alla ord någonstans (korta ord bara som ordbörjan – annars hittar "a b" allt med a och b)
  if (Q.words.every((w) => w.length >= 3 ? k.includes(w) : kw.some((x) => x.startsWith(w)))) return 45;
  if (!fuzzy || !Q.words.some((w) => w.length >= 4)) return 0;
  let typos = 0;
  for (const w of Q.words) { const t = wordTypos(w, kw, kc, starts); if (t === Infinity) return 0; typos += t; }
  return typos ? 30 - 6 * typos : 0;
}

/**
 * Poäng för en rad: bästa av primär nyckel (_k) och sekundär (_k2, t.ex. originaltitel, −8), årsfiltret (_y när
 * frågan har ett år) och en liten bonus när den råa titeln (_t) innehåller den råa frågan (rätt å/ä/ö).
 */
export function rowScore(Q, r, fuzzy = false, hasYear = false) {
  const one = (q) => Math.max(keyScore(q, r._k, fuzzy), r._k2 ? keyScore(q, r._k2, fuzzy) - 8 : 0);
  let s = one(Q.all);
  if (Q.year && hasYear && r._y === Q.year && Q.text.compact) { const t = one(Q.text); if (t > 0) s = Math.max(s, t + 5); }
  if (s > 0 && /[^\x00-\x7f]/.test(Q.raw) && r._t && String(r._t).normalize('NFC').toLowerCase().includes(Q.raw)) s += 3;
  return s;
}

/** Bigram (två tecken) i ett ord – för förurvalet av kandidater till stavfelssökningen */
export function bigrams(w) { const s = new Set(); for (let i = 0; i < w.length - 1; i++) s.add(w.slice(i, i + 2)); return [...s]; }
