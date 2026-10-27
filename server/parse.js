// Tolkning av film- och avsnittsfilnamn (rena funktioner, inga filer läses). Används av skannern och matchningen.
// Mäts mot korpusen i test/fixtures/match/corpus.js (test/match-corpus.test.js) – ändra inte utan att köra den.
//
// Filmer:  "Lejonkungen (1994)", "Frozen.II.2019.SWEDiSH.1080p.BluRay.x264-GRP", "Frost 2 (svenskt tal)",
//          "Herkules [Svenskt tal] (1997)", "Disney Klassiker 32 - Lejonkungen", "The Lion King (1994) {tmdb-8587}",
//          "Lejonkungen (1994)/title_t00.mkv" (MakeMKV), Blu-ray-mappar (BDMV).
// Avsnitt: "S01E05", "S02 E04", "1x05", "[1x01]", "Säsong 2 Avsnitt 5", "Season 2 Episode 9", "S2 A5", "E05", "Avsnitt 3",
//          "Del 4 av 20", "Lucka 05", "06 - Titel" i en säsongsmapp, datum ("2019.03.15"), anime "Show - 12",
//          specialmappar (Specials/Extra/Säsong 0), säsongspaket ("Show.S01.1080p-GRP/…") och kategorimappar ("Barn/Bluey/…").
import path from 'node:path';
import { stripTrailingQuality } from './match.js';

// NFC: filnamn från macOS (SMB) har ofta å/ä/ö som två tecken (NFD) – annars går de inte att söka på eller slå ihop
export const clean = (s) => String(s).normalize('NFC').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').replace(/[\s\-–\[(]+$/, '').trim();
/** clean() + inga skiljetecken kvar i början/slutet */
const tidy = (s) => clean(s).replace(/^[\s\-–—:,.\])]+|[\s\-–—:,.\[(]+$/g, '').trim();
const JUNK = /\b(2160p|1080p|720p|576p|480p|4k|uhd|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdtv|dvdrip|dvd|x264|x265|h\.?264|h\.?265|hevc|aac|ac3|eac3|dts|remux|proper|repack|extended|unrated|hdr|10bit|multi|swesub|nordic)\b.*$/i;

// ---------- id:n i namnet (Plex/Jellyfin/Radarr/Sonarr): {tmdb-123}, [tmdbid-123], {imdb-tt123}, [imdbid-tt123], [tvdbid-123] ----------
const ID_RE = /[[{(]\s*(tmdb|tmdbid|themoviedb|imdb|imdbid|tvdb|tvdbid)\s*[-=: ]\s*(tt\d{5,10}|\d{1,9})\s*[\]})]/gi;
/** { tmdb, imdb, tvdb } ur en sökväg eller ett namn, eller null */
export function idsIn(s) {
  let out = null;
  for (const m of String(s || '').matchAll(ID_RE)) {
    const k = m[1].toLowerCase().replace(/^themoviedb$/, 'tmdb').replace(/id$/, ''), v = m[2];
    out ||= { tmdb: null, imdb: null, tvdb: null };
    if (k === 'imdb' && /^tt\d+$/.test(v)) out.imdb ??= v;
    else if (k !== 'imdb' && /^\d+$/.test(v) && +v > 0) out[k] ??= +v;
  }
  return out && (out.tmdb || out.imdb || out.tvdb) ? out : null;
}
const stripIds = (s) => String(s).replace(ID_RE, ' ');

// ---------- brus: språk, dubbning, kvalitet, källa ----------
// Ord som aldrig avgör titeln när de står ensamma i en parentes ("[1080p]", "(svenskt tal)", "[SWE]", "(Disney)")
const NOISE_TOK = new Set(('svenskt svensk svenska swedish swe sv se nordic nordisk multi multisub multisubs swesub swesubs swedub dubbed dubbad dubbat ' +
  'dub dubb eng english engelskt engelsk text tal ljud subs sub subbed subtitle subtitles multiple tecknad tecknat animerad animerat disney pixar ' +
  'dreamworks dvd dvdr dvd5 dvd9 bd hd sd fhd rip pal ntsc ws fs proper repack extended uncut unrated remastered complete internal limited ' +
  'version edition remux bluray blu ray web webdl webrip hdtv dvdrip bdrip brrip hdrip nf amzn dsnp hmax atvp hulu svtplay viaplay cmore ' +
  'hevc avc xvid divx atmos truehd flac mp3 aac ac3 eac3 dts dd ddp opus hdr hdr10 dv dovi sdr x264 x265 h264 h265 4k uhd').split(' '));
const isNoiseTok = (t) => NOISE_TOK.has(t) || /^(\d{3,4}[pi]|[xh]\.?26[45]|\d+bit|aac\d?(\.\d)?|ddp?\d(\.\d)?|\d\.\d|dts-?hd(-?ma)?|web-?dl|hdr10\+?|blu-?ray)$/i.test(t);
const bracketNoise = (inner) => { const t = inner.toLowerCase().split(/[\s._,+&/-]+/).filter(Boolean); return t.length > 0 && t.every(isNoiseTok); };
// Brus i slutet av titeln ("Frost 2 (svenskt tal)", "Djungelboken - Svenskt tal", "Aladdin - Dubbad", "Matrix SV")
const TAIL_STYLE = 'tecknad|tecknat|tecknade|animerad|animerat';
const TAIL_WORDS = 'svenskt[\\s._-]*tal|svensk[\\s._-]*text|svenska[\\s._-]*tal|sv[\\s._-]*tal|swe[\\s._-]*dub|swedish[\\s._-]*dub(?:bed)?|svensk[\\s._-]*version|' +
  'swedish|swe|svenska|svenskt|nordic|nordisk|multi(?:subs?)?|swesubs?|swedub|dubbed|dubbad|dubbat|dub|dvdrip|dvd|dvdr|eng|english|subbed|subs|' +
  'proper|repack|internal|limited|pal|ntsc|sv|disney|pixar';
const tailRe = (style) => new RegExp(`(?:^|[\\s._\\-–(\\[])(?:${style ? TAIL_WORDS + '|' + TAIL_STYLE : TAIL_WORDS})[\\s._\\-–)\\]]*$`, 'i');
const TAIL_ALL = tailRe(true), TAIL_KEEP = tailRe(false);

/**
 * Ta bort brus ur en titel: id-taggar, en inledande grupp i hakparentes ("[Ghibli]", "[SubsPlease]"), parenteser som bara
 * innehåller brus och språk-/kvalitetsord i slutet. keepStyle: behåll "tecknad"/"animerad" (serier: en tecknad version i en
 * egen mapp är en annan serie). Blir inget kvar returneras indata (städad).
 */
export function stripNoise(s, keepStyle = false) {
  const orig = tidy(String(s || ''));
  let t = stripIds(String(s || '').normalize('NFC'));
  const lead = t.match(/^\s*\[[^\]]*\]\s*/);
  if (lead && /\p{L}/u.test(t.slice(lead[0].length))) t = t.slice(lead[0].length);
  t = t.replace(/[[({]([^\])}]*)[\])}]/g, (m, inner) => bracketNoise(inner) && !(keepStyle && new RegExp(`^(${TAIL_STYLE})$`, 'i').test(inner.trim())) ? ' ' : m);
  const tail = keepStyle ? TAIL_KEEP : TAIL_ALL;
  let prev;
  do { prev = t; t = stripTrailingQuality(t); t = t.replace(tail, '').replace(/[\s\-–—:,.]+$/, ''); } while (t && t !== prev);
  t = tidy(t);
  return t && /[\p{L}\p{N}]/u.test(t) ? t : orig;
}

// ---------- filmer ----------
// ---- Blu-ray-mappar (BDMV/STREAM/00000.m2ts …) ----
// En kopierad skiva innehåller varningstexter, loggor, menyer och trailers som egna klipp. Bara huvudfilmen
// (största filen) ska bli en titel, och den får namnet från mappen ovanför BDMV.
const DISC_DIR = /^(disc|disk|dvd|bd|cd|del|skiva)[\s._-]*\d+$/i;
/** Mappen som innehåller BDMV (skivans rot), eller null om filen inte ligger på en kopierad Blu-ray */
export function discRoot(file) {
  const parts = file.split(path.sep);
  const i = parts.findLastIndex(x => x.toUpperCase() === 'BDMV');
  return i > 0 ? parts.slice(0, i).join(path.sep) || path.sep : null;
}
/** Namnet på en skiva: mappen ovanför BDMV, utan "Disc 1"/"_D1" (en mapp som bara heter "Disc 1" ger föräldern) */
function discName(root) {
  let name = path.basename(root);
  if (DISC_DIR.test(name)) name = path.basename(path.dirname(root));
  return name.replace(/[\s._-]+(disc|disk|d|cd)[\s._-]*\d+$/i, '');
}
// Filnamn som inte säger något om filmen (MakeMKV, DVD, "movie.mkv") – då gäller mappens namn
const GENERIC = /^(movie|film|video|main|feature|huvudfilm|title[\s._-]?t?\d+|t\d\d|c\d+_t\d+|vts_\d+_\d+|index)$/i;
// "Disney Klassiker 32 - Lejonkungen", "Disney - Djungelboken", "32. Lejonkungen"
const LEAD = /^(?:(?:walt[\s._-]+)?disneys?(?:[\s._-]+(?:klassiker|classics?|klassiska))?(?:[\s._-]*(?:nr|#)?[\s._-]*\d{1,3})?[\s._]*[-–:][\s._]*|\d{1,3}\.\s+(?=\p{L}))/iu;
const preMovie = (name) => stripIds(name.normalize('NFC')).replace(/_t\d{2}$/i, '').replace(LEAD, '');

export function parseMovie(file) {
  const tryName = (name) => {
    name = preMovie(name);
    const m = name.match(/^(.*)[\s._(\[-]+((?:19|20)\d\d)(?=[\s._)\]-]|$)/); // sista årtalet (t.ex. Blade Runner 2049 (2017))
    if (!m) return null;
    // Upplösning/kodek före årtalet ("Film.1080p.2010") hör inte till titeln, inte heller "(svenskt tal)" eller "[1080p]"
    const t = stripNoise(m[1]) || clean(m[1]);
    return t ? { title: t, year: +m[2] } : null;
  };
  const withIds = (p) => { const ids = idsIn(file); return ids ? { ...p, ids } : p; };
  const root = discRoot(file);
  if (root) { const n = discName(root); return withIds(tryName(n) || { title: clean(preMovie(n).replace(JUNK, '')) || n, year: null }); }
  let base = path.basename(file, path.extname(file));
  const folder = path.basename(path.dirname(file));
  if (GENERIC.test(base) && folder && folder !== '.' && folder !== path.sep) base = folder;
  // Film delad på flera filer ("Film (2020) cd1.avi", "cd2.avi"): delarna är inte versioner av varandra
  const part = base.match(/[\s._-](?:cd|part|pt)[\s._-]*(\d)$/i);
  if (part) {
    const p = parseMovie(path.join(path.dirname(file), base.slice(0, part.index) + path.extname(file)));
    return { ...p, title: +part[1] > 1 ? `${p.title} (del ${part[1]})` : p.title, part: +part[1] };
  }
  // Utan årtal: ta bort brus, och utgåvetillägg ("Extended", "Proper") bara om något av titeln blir kvar
  const b = preMovie(base);
  const t1 = stripNoise(b);
  return withIds(tryName(base) || tryName(folder) || { title: clean(t1.replace(JUNK, '')) || t1 || base, year: null });
}

// ---------- avsnitt ----------
// Mappar som grupperar serier ("Barn/Bluey/…", "TV-serier/Bron/…") – aldrig en serie i sig
const CATEGORY = /^(barn|barnens|kids|children|tecknat|tecknade|tecknade serier|animerat|animerade|anime|cartoons?|serier|tv[\s._-]*serier|tv[\s._-]*series|tv|tv[\s._-]*shows?|shows|series|barnserier|barnprogram|svenska serier|utl[äa]ndska serier|julkalendrar|julkalender|dokument[äa]rer|documentaries|media|video|videos|downloads?|nedladdat|complete|bibliotek|library)$/i;
/** Säsongsmapp: { season, name } ("Season 1", "Säsong 2", "S01", "Specials", "Babblarna säsong 2", "Show.S01.1080p-GRP"), annars null */
export function seasonDir(d) {
  const n = String(d).normalize('NFC').trim();
  if (/^(specials?|extra|bonus|säsong[\s._-]*0+|season[\s._-]*0+|s0+)$/i.test(n)) return { season: 0, name: '' };
  let m = n.match(/^(.*?)[\s._-]*\b(?:season|säsong|sasong|series|staffel|saison|sesong|book|bok)[\s._-]*0*(\d{1,4})(?=$|[\s._)\]-])/i);
  if (m && !/[sS]\d{1,2}[\s._-]*[eE]\d/.test(n)) return { season: +m[2], name: tidy(m[1]) };
  m = n.match(/^(.*?)(?:^|[\s._-])s0*(\d{1,2})(?=$|[\s._-])/i);
  if (m && !/[sS]\d{1,2}[\s._-]*[eE]\d/.test(n)) return { season: +m[2], name: tidy(m[1]) };
  return null;
}
const nameKey = (s) => String(s || '').normalize('NFKD').toLowerCase().replace(/\p{M}+/gu, '').replace(/\b(?:19|20)\d\d\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const sameName = (a, b) => { const x = nameKey(a), y = nameKey(b); if (!x || !y) return false; const [s, l] = x.length <= y.length ? [x, y] : [y, x]; return s.length >= 3 && l.startsWith(s); };
const COLLECTION = /[\s._-]+(?:-[\s._]+)?(?:the\s+)?(?:complete\s+)?(?:collection|samling|samlingen|box)$/i;
/** Seriens namn ur en mapp eller ett filnamnsprefix: { show, year } */
function showName(raw) {
  const t = stripNoise(String(raw || '').replace(COLLECTION, ''), true) || tidy(raw);
  const y = t.match(/^(.*?)[\s._(\[-]+((?:19|20)\d\d)[)\]]?$/);
  return y && tidy(y[1]) ? { show: tidy(y[1]), year: +y[2] } : { show: tidy(t), year: null };
}

/** Avsnitt utan SxxEyy: "Byggare Bob 026 - Jul hos Byggare Bob", "Lille Luj Disc3", "Kaspar2", "Trolltider.2",
 *  "Sunes.Jul.Volym.2-8", "jul.i.kapernaum.1995.disc1". Numret i slutet blir avsnittet. Ligger filen i en mapp med
 *  ett annat namn (t.ex. "julkalender/Kaspar2.mp4") blir filnamnet serien. */
function looseEpisode(folder, base, season) {
  const t = base.match(/^(.*?[^\d\s._-])[\s._-]*(?:disc|disk|dvd|del|part|volym|vol|d)?[\s._-]*0*(\d{1,3})(?:-\d{1,3})?(?:[\s._]+-[\s._]+(.+))?$/i);
  if (!t) return null;
  // "jul.i.kapernaum.1995.disc1": skivordet och året hör inte till namnet
  const name = clean(t[1].replace(/[\s._-]*(?:disc|disk|dvd|volym|vol)$/i, ''));
  if (!name) return null;
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9åäö]+/g, '');
  const sameShow = folder && (norm(name).startsWith(norm(folder).slice(0, 6)) || norm(folder).startsWith(norm(name)));
  const { show, year } = showName(sameShow ? folder : name);
  return { show, year, season: season ?? 1, episode: +t[2], epTitle: t[3] ? clean(t[3]) : null, absolute: season == null };
}
// Avsnitt helt utan nummer ("Chuggington/Hjälpsamma Hodge.avi"): serien är mappen, numret sätts vid skanningen
function unnumbered(folder, base, season) {
  if (!folder) return null;
  const { show, year } = showName(folder);
  const n = show.toLowerCase(), t = clean(base);
  const title = t.toLowerCase().startsWith(n) ? clean(t.slice(n.length).replace(/^[\s._-]+/, '')) || t : t;
  return { show, year, season: season ?? 1, episode: null, epTitle: title, absolute: false };
}

// Numrering i filnamnet, i tur och ordning. Varje regel ger { season?, episode?, date?, index, length, abs }
const RULES = [
  // S01E05, S02 E04, s02e05, dubbelavsnitt S01E01E02 / S01E01-E02 / S01E05-06 (andra numret hör inte till titeln)
  (b) => { const m = b.match(/[sS](\d{1,2})[ ._-]*[eE](\d{1,4})(?:[-_ ]?[eE]\d{1,4}|-\d{1,3}(?![\dpP]))*/); return m && { season: +m[1], episode: +m[2], m }; },
  // 1x05, [1x01]
  (b) => { const m = b.match(/\b(\d{1,2})x(\d{2,3})\b/); return m && { season: +m[1], episode: +m[2], m }; },
  // Säsong 2 Avsnitt 5, Season 2 Episode 9, Säsong 2 - Avsnitt 14, S2 A5
  (b) => { const m = b.match(/(?:säsong|sasong|season|series|serie)[\s._-]*(\d{1,2})[\s._,-]*(?:avsnitt|afsnit|episode|episod|ep|del|e)[\s._-]*(\d{1,4})/i)
    || b.match(/(?:^|[\s._-])[sS](\d{1,2})[\s._-]*[aA](\d{1,3})(?=$|[\s._-])/); return m && { season: +m[1], episode: +m[2], m }; },
  // Datumavsnitt (nyheter, talkshower): 2019.03.15, 2024-03-10
  (b) => { const m = b.match(/(?:^|[\s._(\[-])((?:19|20)\d\d)[.\-_ ](0[1-9]|1[0-2])[.\-_ ](0[1-9]|[12]\d|3[01])(?=$|[\s._)\]-])/);
    return m && { date: `${m[1]}-${m[2]}-${m[3]}`, year: +m[1], m }; },
  // Anime: "Show - 1071", "Show - 12v2" (absolut numrering om ingen säsongsmapp finns)
  (b) => { const m = b.match(/^(.*?)[\s._]+-[\s._]+(\d{1,4})(?:v\d)?(?=$|[\s._\[(])/); return m && { episode: +m[2], abs: true, anime: m[2], idx: m[1].length, m }; },
  // E05, Ep05, Episode 5, Avsnitt 3, Del 4 (av 20), Lucka 05, Part 5
  (b) => { const m = b.match(/(?:^|[\s._-])(?:e|ep|episode|episod|avsnitt|afsnit|del|lucka|part|pt)[\s._-]*(\d{1,4})(?:[\s._-]+(?:av|of)[\s._-]+\d{1,4})?(?=$|[\s._\])-])/i);
    return m && { episode: +m[1], abs: true, m }; },
];

export function parseEpisode(rel) {
  const parts = rel.split(path.sep);
  const dirs = parts.slice(0, -1);
  const ids = idsIn(rel);
  // Fansub-grupper och hash-taggar i hakparenteser, t.ex. "[SubsPlease] Show - 12 (1080p) [ABCD1234]"
  const base = stripIds(path.basename(rel, path.extname(rel)).normalize('NFC')).replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s*\[[0-9A-F]{8}\]\s*$/i, '').trim();
  const sdirs = dirs.map(seasonDir);
  const sdi = sdirs.findLastIndex(Boolean);
  const sd = sdi >= 0 ? sdirs[sdi] : null;
  // Mappar som kan vara serien (inte säsongs-, skiv- eller kategorimappar), uppifrån och ned
  const cands = dirs.filter((d, i) => !sdirs[i] && !DISC_DIR.test(d));
  const named = cands.filter(d => !CATEGORY.test(tidy(stripIds(d))));
  const pick = (pref) => {
    // Kategorimappar hoppas över; stämmer filnamnets serienamn med en djupare mapp än den översta används den
    const top = named[0];
    if (pref) { const deeper = named.find(d => sameName(d, pref)); if (deeper && (!top || !sameName(top, pref))) return deeper; }
    return top ?? null;
  };
  const withIds = (p) => p && (ids ? { ...p, ids } : p);
  let hit = null;
  for (const r of RULES) { hit = r(base); if (hit) break; }
  // "06 - Titel" / "02 Titel" / "05" i en serie- eller säsongsmapp
  if (!hit && dirs.length) {
    const m = base.match(/^0*(\d{1,3})(?:(?:[\s._]*[-–.][\s._]*|[\s._]+)(\D.*))?$/);
    if (m) hit = { episode: +m[1], abs: true, lead: true, m: { index: 0, 0: base.slice(0, base.length - (m[2] || '').length) } };
  }
  if (!hit) {
    const folder = pick(null) ?? (sd?.name || null);
    return withIds(looseEpisode(folder, base, sd ? sd.season : null) || unnumbered(folder, base, sd ? sd.season : null));
  }
  const idx = hit.idx ?? hit.m.index, len = hit.m[0].length;
  const before = base.slice(0, idx);
  let season = hit.season ?? (sd ? sd.season : hit.date ? hit.year : 1);
  let episode = hit.episode ?? null;
  const absolute = !!hit.abs && !sd;
  // "The 100 - 101 - Pilot" i mappen "Season 1": 101 = säsong 1, avsnitt 01 (även "413 - Face Off" i "Season 4")
  const num = hit.anime || (hit.lead ? String(hit.episode) : null);
  if (num && sd) { const sn = String(season); if (num.length >= 3 && num.startsWith(sn) && num.length - sn.length === 2) episode = +num.slice(sn.length); }
  const pref = tidy(before) ? showName(before) : null;
  const dir = pick(pref?.show);
  let name = dir ? showName(dir) : sd?.name ? showName(sd.name) : pref;
  if (!name?.show) return null;
  // Årtalet i filnamnet ("Doctor.Who.2005.S01E01" i mappen "Doctor Who") är en ledtråd till matchningen – inte en del av seriens nyckel
  const yearHint = !name.year && pref?.year && sameName(name.show, pref.show) ? pref.year : null;
  const after = tidy(stripNoise(base.slice(idx + len).replace(JUNK, ''))) || '';
  const out = { show: name.show, year: name.year, season, episode, epTitle: after && !/^\d+$/.test(after) ? after : null, absolute };
  if (yearHint) out.yearHint = yearHint;
  if (hit.date) out.date = hit.date;
  return withIds(out);
}
