// Matchning mot TMDB: filnamn innehåller ofta mer eller annat än titeln hos TMDB – titeln på två språk
// ("Harry Potter och dödsrelikerna - Deathly Hallows"), ett ord för mycket, "01" i stället för "del 1"
// eller ett årtal som skiljer ett år. Vi söker med flera varianter av titeln, poängsätter träffarna
// på ordlikhet, nummer och årtal och väljer den bästa – eller ingen om ingen är tillräckligt lik.

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
// Fyllnadsord som inte avgör vilken film det är (på svenska och engelska)
const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'och', 'en', 'ett', 'det', 'den', 'av', 'del', 'part', 'pt', 'vol', 'volume', 'chapter', 'kapitel', 'episode', 'avsnitt']);
// Upplösning, kodek, källa och utgåva i filnamn ("Film 1080p BluRay x264") – aldrig en del av titeln.
// Hellre för få än för många: vanliga ord som "web", "dvd" eller "extended" kan finnas i riktiga titlar.
const QWORDS = '2160p|1080p|1080i|720p|576p|480p|4k|uhd|blu-?ray|bdrip|brrip|bdremux|remux|webrip|web-?dl|hdtv|dvdrip|hdrip|x26[45]|h\\.?26[45]|hevc|avc|xvid|divx|10bit|8bit|hdr10\\+?|dolby\\.?vision|dts(?:-?hd)?|truehd|atmos|e?ac3|aac(?:2\\.0)?|ddp?5\\.1|5\\.1|7\\.1';
export const QUALITY = new RegExp(`(?:^|[\\s._\\-[(])(?:${QWORDS})(?=$|[\\s._\\-\\])])`, 'gi');
const TRAIL = new RegExp(`(?:^|[\\s._\\-[(]+)(?:${QWORDS})[\\s._\\-\\])]*$`, 'i');
const EDITION = /\b(directors?'?s? ?cut|extended( edition| cut)?|uncut|unrated|remastered|theatrical( cut)?|special edition|collectors edition|anniversary edition|ultimate edition|final cut|imax( edition)?|svensk version|swedish version|svenskt tal|swedish dub)\b/gi;
const stripQuality = (s) => String(s || '').replace(QUALITY, ' ').replace(/\s+/g, ' ').trim();
/** Ta bort kvalitetsord i SLUTET av en titel ("Film 1080p BluRay") – inte i början ("Remux Film" kan vara en titel) */
export function stripTrailingQuality(s) {
  let t = String(s || ''), prev;
  do { prev = t; t = t.replace(TRAIL, ''); } while (t && t !== prev);
  return t.trim() || String(s || '');
}
const NUM_WORDS = new Set(['del', 'part', 'pt', 'vol', 'volume', 'chapter', 'kapitel']);

/** Ord i en titel: gemener, utan accenter och skiljetecken, nummer utan inledande nollor, romerska siffror efter "del/part" som tal */
export function tokens(s) {
  const raw = stripQuality(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/['’`´]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  return raw.map((t, i) => /^\d+$/.test(t) ? String(+t)
    : ROMAN[t] && t !== 'i' ? String(ROMAN[t]) // "II", "III" … är nästan alltid nummer
    : t === 'i' && NUM_WORDS.has(raw[i - 1]) ? '1' : t);
}
const nums = (toks) => new Set(toks.filter(t => /^\d+$/.test(t) && +t < 1900)); // årtal i titeln räknas inte som delnummer
const words = (toks) => toks.filter(t => !STOP.has(t) && !/^\d+$/.test(t));

/** Hur lik en träffs titel är sökt titel (0–1). numsFrom: titeln vars nummer gäller (originalet, även när en variant utan nummer jämförs) */
export function similarity(query, title, numsFrom = query) {
  const q = tokens(query), r = tokens(title);
  const qw = new Set(words(q)), rw = new Set(words(r));
  if (!qw.size || !rw.size) return 0;
  let common = 0; for (const w of rw) if (qw.has(w)) common++;
  const dice = 2 * common / (qw.size + rw.size);
  // Hela träffens titel finns i den sökta (den sökta har extra ord) – men inte för titlar på ett enda ord ("Up")
  const contained = rw.size >= 2 ? common / rw.size * 0.92 : 0;
  let sim = Math.max(dice, contained);
  // Nummer avgör: "Dödsrelikerna 1" får aldrig bli del 2
  const qn = nums(tokens(numsFrom)), rn = nums(r);
  if (qn.size && rn.size && ![...qn].some(n => rn.has(n))) sim *= 0.3;
  // Sökt "2" eller högre men träffen saknar nummer: troligen första filmen, inte uppföljaren ("Rocky II" ≠ "Rocky").
  // En etta saknas däremot ofta i titeln
  else if (qn.size && !rn.size) sim *= [...qn].some(n => +n >= 2) ? 0.55 : 0.85;
  else if (!qn.size && rn.size) sim *= 0.9;
  return sim;
}

/** Sökvarianter av en titel, bästa först (unika, högst 6) */
export function variants(title) {
  const t = stripTrailingQuality(String(title || '').trim());
  const out = [];
  const add = (s) => { s = s.replace(/\s+/g, ' ').replace(/^[\s\-–—:,.]+|[\s\-–—:,.]+$/g, '').trim(); if (s.length >= 2 && !out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s); };
  add(t);
  // Titel på två språk eller med tillägg: "Svensk titel - English Title", "Titel (Originaltitel)", "A / B"
  const parts = t.split(/\s+[-–—|/]\s+|\s*[([][^)\]]*[)\]]\s*/).filter(Boolean);
  const inParens = [...t.matchAll(/[([]([^)\]]+)[)\]]/g)].map(m => m[1]);
  for (const p of [...parts, ...inParens]) if (p !== t) add(p);
  // Utan delnummer ("Dödsrelikerna 01" → "Dödsrelikerna") – numret avgör sedan vid poängsättningen
  for (const p of [...out]) add(p.replace(/[\s._-]+(del|part|pt|vol|volume|chapter|kapitel)?[\s._-]*(\d{1,2}|[ivx]{1,4})$/i, ''));
  // Utgåvetillägg ("Director's Cut", "Extended Edition", "Svensk version")
  for (const p of [...out]) add(p.replace(EDITION, ' '));
  // Ett eller två ord för mycket i slutet, eller ett i början
  const w = t.split(/\s+/);
  if (w.length >= 3) {
    for (const k of [1, 2]) {
      const short = w.slice(0, -k);
      if (short.length && !NUM_WORDS.has(short[short.length - 1].toLowerCase())) add(short.join(' '));
    }
    add(w.slice(1).join(' '));
  }
  return out.slice(0, 6);
}

/** Poäng för en träff: ordlikhet mot den bästa varianten, plus årtal och en liten knuff för kända titlar */
export function score(result, title, year, tv = false) {
  const names = [tv ? result.name : result.title, tv ? result.original_name : result.original_title].filter(Boolean);
  const vs = variants(title);
  let sim = 0;
  for (const n of names) for (const v of vs) sim = Math.max(sim, similarity(v, n, vs[0]) * (v === vs[0] ? 1 : 0.97));
  const ry = parseInt(tv ? result.first_air_date : result.release_date) || null;
  let s = sim;
  if (year && ry) s += ry === year ? 0.12 : Math.abs(ry - year) === 1 ? 0.04 : -0.25;
  s += Math.min(0.03, Math.log10((result.popularity || 0) + 1) / 100);
  return s;
}

export const GOOD = 0.62;   // lägsta poäng för att räknas som en träff
const SURE = 0.95;          // så säker att vi slutar söka

/**
 * Hitta bästa TMDB-träffen. search(query, year|null) ska returnera TMDB:s resultatlista.
 * Söker först med årtal för varje variant, sedan utan årtal (årtalet kan skilja ett år eller saknas hos TMDB).
 */
export async function findBest(search, title, year, tv = false) {
  const seen = new Map();
  let best = null;
  const consider = (results) => {
    for (const r of results || []) {
      if (seen.has(r.id)) continue;
      const s = score(r, title, year, tv);
      seen.set(r.id, s);
      if (!best || s > best.score) best = { id: r.id, score: s, result: r };
    }
  };
  const vs = variants(title);
  const steps = year ? [...vs.map(v => [v, year]), ...vs.slice(0, 3).map(v => [v, null])] : vs.map(v => [v, null]);
  for (const [q, y] of steps) {
    consider(await search(q, y));
    if (best && best.score >= SURE) break;
  }
  return best && best.score >= GOOD ? best : null;
}
