// Matchning mot TMDB: filnamn innehåller ofta mer eller annat än titeln hos TMDB – titeln på två språk
// ("Harry Potter och dödsrelikerna - Deathly Hallows"), ett ord för mycket, "01" i stället för "del 1"
// eller ett årtal som skiljer ett år. Vi söker med flera varianter av titeln, poängsätter träffarna
// på ordlikhet, nummer och årtal och väljer den bästa – eller ingen om ingen är tillräckligt lik.

import { editDistance } from './searchkey.js';
import { stripNoise } from './parse.js';

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
  // Ett stavfel i ett långt ord räknas nästan som lika ("Madagascar" ≈ "Madagaskar")
  let common = 0; for (const w of rw) common += qw.has(w) ? 1 : w.length >= 6 && [...qw].some(x => x.length >= 6 && editDistance(w, x, 1) <= 1) ? 0.85 : 0;
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

// ---------- Matchning med flera sökningar, alternativa titlar och ledtrådar (scanner.js → refreshItem) ----------
// Mäts mot korpusen i test/fixtures/match/ (test/match-corpus.test.js) med en låtsas-TMDB som svarar som TMDB.
const ANIM = 16, FAMILY = 10751, KIDS = 10762;
const ARAB = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const SUB = /\s*[:–—]\s+|\s+-\s+/;          // undertitel: "Ice Age: The Meltdown", "Shrek – Nu och för alltid"
const STYLE = /[\s._-]*[([-]?\s*(?:tecknad|tecknat|tecknade|animerad|animerat)\s*\)?$/i;
const COUNTRY = /[\s._-]*[([]?\b(US|USA|UK|GB|SE|AU|NZ|CA|DK|NO)\b[)\]]?$/;
const CC = { USA: 'US', UK: 'GB' };

/** Ledtrådar i en titel: land ("The Office (US)") och tecknad version ("Pippi Långstrump - tecknad"), plus titeln utan dem */
export function titleHints(t) {
  let title = String(t || '').trim(), country = null, anim = false;
  const c = title.match(COUNTRY);
  if (c && c.index > 0) { country = CC[c[1]] || c[1]; title = title.slice(0, c.index); }
  if (STYLE.test(title) && title.replace(STYLE, '').trim()) { anim = true; title = title.replace(STYLE, ''); }
  return { title: stripNoise(title), country, anim };
}

/** Sökfrågor för TMDB, bästa först: varianterna av varje titel och deras omskrivningar
 *  (utan "och/and/&", romerska ↔ arabiska siffror, utan inledande artikel, utan undertitel) */
export function queries(titles) {
  const out = [];
  const add = (q, from) => { q = String(q || '').replace(/\s+/g, ' ').replace(/^[\s\-–—:,.]+|[\s\-–—:,.]+$/g, '').trim();
    if (q.length >= 2 && /[\p{L}\p{N}]/u.test(q) && !out.some(x => x.q.toLowerCase() === q.toLowerCase())) out.push({ q, from }); };
  for (const t of titles) for (const v of variants(t)) add(v, t);
  for (const { q, from } of [...out]) {
    add(q.replace(/\s+(?:&|och|and)\s+/gi, ' '), from);
    add(q.replace(/(\s)(II|III|IV|V|VI|VII|VIII|IX|X)$/, (m, sp, r) => sp + ROMAN[r.toLowerCase()]), from);
    add(q.replace(/(\s)([2-9]|10)$/, (m, sp, n) => sp + ARAB[+n]), from);
    add(q.replace(/^(?:the|a|an|den|det|en|ett)\s+/i, ''), from);
    add(q.split(SUB)[0], from);
    // Delnummer mitt i titeln: "Ice Age 3 Dawn of the Dinosaurs" (TMDB: "Ice Age: Dawn of the Dinosaurs") – numret avgör sedan poängen
    add(q.replace(/\s(?:\d{1,2}|II|III|IV)\s(?=\p{L})/u, ' '), from);
  }
  return out.slice(0, 12);
}

/**
 * Bästa TMDB-träffen för en film eller serie.
 * api: { search(kind, query, year|null, lang 'sv'|'en') → resultat, alternatives(kind, id) → [titlar], details(kind, id) → TMDB-objekt }
 * q:   { kind: 'movie'|'show', titles: [tolkad titel, …], year, duration (s), kids, anim, country, seasons: { max, eps: { [säsong]: högsta avsnitt } } }
 * Söker på svenska med och utan år, sedan på engelska och med alternativa titlar om ingen träff är säker; likvärdiga
 * kandidater skiljs åt med längden (film) eller säsongs-/avsnittsantal (serie). Ingen träff hellre än fel träff.
 */
export async function findMatch(api, q) {
  const tv = q.kind === 'show';
  const hints = (q.titles || []).filter(Boolean).map(titleHints);
  const titles = [...new Set(hints.map(h => h.title).filter(Boolean))];
  if (!titles.length) return null;
  const anim = !!q.anim || hints.some(h => h.anim), country = q.country || hints.find(h => h.country)?.country || null;
  const qs = queries(titles), year = q.year || null;
  const pool = new Map();
  const add = (results, lang) => {
    for (const r of results || []) {
      if (!r?.id) continue;
      let c = pool.get(r.id);
      if (!c) pool.set(r.id, c = { id: r.id, result: r, names: [], year: parseInt(tv ? r.first_air_date : r.release_date) || null,
        pop: r.popularity || 0, genres: r.genre_ids || [], country: r.origin_country || null, adj: 0, alt: false, det: false });
      const put = (n, orig = false) => { if (n && !c.names.some(x => x.n === n)) c.names.push({ n, orig }); };
      put(tv ? r.name : r.title); put(tv ? r.original_name : r.original_title, true);
      if (lang === 'en' && !c.result._en) c.result._en = tv ? r.name : r.title;
    }
  };
  const score = (c) => {
    let sim = 0, origExact = false;
    for (const { n, orig } of c.names) {
      const main = n.split(SUB)[0];
      for (let i = 0; i < qs.length; i++) {
        const { q: v, from } = qs[i], w = i === 0 ? 1 : 0.97;
        const s = similarity(v, n, from) * w;
        if (s > sim) sim = s;
        if (main !== n) sim = Math.max(sim, similarity(v, main, from) * w * 0.95);
        if (orig && i === 0 && s >= 0.99) origExact = true;
      }
    }
    let s = sim;
    if (year && c.year) { const d = Math.abs(c.year - year); s += d === 0 ? 0.12 : d === 1 ? 0.04 : tv ? -0.12 : -0.25; }
    s += Math.min(0.03, Math.log10(c.pop + 1) / 100);
    const g = new Set(c.genres);
    if (anim) s += g.has(ANIM) ? 0.06 : -0.03;
    else if (q.kids) s += tv ? (g.has(ANIM) || g.has(FAMILY) || g.has(KIDS) ? 0.04 : 0) : g.has(ANIM) ? 0.06 : g.has(FAMILY) ? 0.02 : 0;
    if (origExact) s += 0.02;
    if (country && Array.isArray(c.country) && c.country.length) s += c.country.includes(country) ? 0.05 : -0.05;
    return s + c.adj;
  };
  const ranked = () => [...pool.values()].map(c => ({ c, s: score(c) })).sort((a, b) => b.s - a.s);
  const top = () => ranked()[0]?.s ?? -1;
  const safe = async (fn) => { try { return await fn(); } catch (e) { if (/429/.test(e.message)) throw e; return null; } };
  // 1. Svenska: varje variant med år, sedan de bästa utan år (årtalet kan skilja eller saknas hos TMDB)
  const steps = year ? [...qs.slice(0, 6).map(x => [x.q, year]), ...qs.slice(0, 4).map(x => [x.q, null])] : qs.slice(0, 6).map(x => [x.q, null]);
  for (const [s, y] of steps) {
    add(await safe(() => api.search(q.kind, s, y, 'sv')), 'sv');
    if (top() >= SURE) break;
  }
  // 2. Engelska titlar (filen heter "Howls Moving Castle", TMDB:s svenska titel är "Det levande slottet")
  if (top() < SURE) for (const { q: s } of qs.slice(0, 2)) {
    add(await safe(() => api.search(q.kind, s, null, 'en')), 'en');
    if (top() >= SURE) break;
  }
  // 3. Alternativa titlar ("Shrek 3", "Kimi no Na wa", "Monsterbolaget") för de första och bästa kandidaterna
  if (top() < SURE && pool.size) {
    const first = [...pool.values()].slice(0, 3), best = ranked().slice(0, 3).map(x => x.c);
    for (const c of [...new Set([...first, ...best])].slice(0, 4)) {
      if (c.alt) continue;
      c.alt = true;
      for (const n of (await safe(() => api.alternatives(q.kind, c.id))) || []) if (n && !c.names.some(x => x.n === n)) c.names.push({ n, orig: false });
    }
  }
  // 4. Likvärdiga kandidater (nyinspelning, samma titel): längden respektive säsonger/avsnitt avgör
  let list = ranked();
  const close = list.filter(x => x.s >= list[0]?.s - 0.12 && x.s >= GOOD - 0.15).slice(0, 3);
  if (close.length > 1 && (tv ? q.seasons?.max != null : q.duration > 0)) {
    for (const { c } of close) {
      const d = await safe(() => api.details(q.kind, c.id));
      if (!d) continue;
      if (tv) {
        const seasons = (d.seasons || []).filter(x => x.season_number > 0);
        const n = seasons.length || d.number_of_seasons || 0;
        if (q.seasons.max > n) c.adj -= 0.2;
        else if (Object.entries(q.seasons.eps || {}).some(([sn, ep]) => { const x = seasons.find(y => y.season_number === +sn); return x && ep > x.episode_count; })) c.adj -= 0.08;
        else c.adj += 0.03;
      } else if (d.runtime > 0) {
        const diff = Math.abs(q.duration / 60 - d.runtime) / d.runtime;
        c.adj += diff <= 0.1 ? 0.08 : diff > 0.25 ? -0.1 : 0;
      }
    }
    list = ranked();
  }
  const b = list[0];
  return b && b.s >= GOOD ? { id: b.c.id, score: b.s, result: b.c.result } : null;
}
