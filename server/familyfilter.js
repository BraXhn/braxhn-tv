// Familjefilter (som VidAngel/ClearPlay, men helt lokalt): ljudet tystas där undertexten innehåller en svordom,
// undertexten visar *** i stället för ordet och – valfritt – hoppar spelaren över scener som hushållet markerat.
//
// Profilens läge (users.family_filter): 'off' | 'mute' (tysta svordomar) | 'skip' (tysta + hoppa över markerade scener).
// NULL = standard: vuxna av, barnprofiler (max_age) enligt administratörens val (inställningen family_kids).
//
// Tysta intervall: replikerna kommer ur repliksökningens index (sub_lines, sublines.js) med undertextsynkens justering
// (sub_sync: t' = t · ratio + shift) – samma tider som spelaren visar. En replik med en träff tystas hela, med en kort
// marginal före och efter; intervall som nästan möts slås ihop. Undertexterna i ljudspårets språk används när de finns
// (det är de som motsvarar talet), annars alla.
//
// Var tystnaden görs (se /playback i routes/playback.js och stream.js):
//   - Webbspelaren tystar själv (ffc=1): video.muted på exakt tid – direktuppspelningen behålls. Gäller bara profiler
//     som valt filtret själva; för barnprofiler (påtvingat, enforced) tystar servern alltid, och direktfilen,
//     nedladdning och offline nekas för titlar med svordomar.
//   - Alla andra (apparna, Chromecast, AirPlay): servern lägger ett volymfilter (volume=0 med enable='between(t,a,b)')
//     i ljudet. Det kräver att ljudet kodas om (AAC), bilden kopieras när det går. Det fungerar utan klientstöd.
// Undertexterna maskeras alltid av servern (/api/stream/:id/subs/:sid) när profilen har filtret på.
import { all, get, run, getSetting, setSetting, now } from './db.js';
import { WORDS, SUFFIX } from './familywords.js';
import { cleanText } from './sublines.js';

export const MODES = ['off', 'mute', 'skip'];
export const PRE = 0.25, POST = 0.3; // marginal (s) före och efter repliken
const JOIN = 0.6;                     // intervall med kortare glapp slås ihop
const MAX_WORD = 60, MAX_EXTRA = 300;

// ---------------- profilens läge ----------------
export const kidsDefault = () => { const v = getSetting('family_kids', 'off'); return MODES.includes(v) ? v : 'off'; };
export function setKidsDefault(v) { if (!MODES.includes(v)) throw new Error('Ogiltigt läge'); setSetting('family_kids', v); }
/** Profilens val: '' = standard, annars ett läge */
export const settingOf = (u) => MODES.includes(u?.family_filter) ? u.family_filter : '';
/** Läget som gäller för profilen */
export function modeFor(uid) {
  const u = typeof uid === 'object' ? uid : get('SELECT id, max_age, family_filter FROM users WHERE id=?', uid);
  if (!u) return 'off';
  return settingOf(u) || (u.max_age != null ? kidsDefault() : 'off');
}
/**
 * Påtvingat filter: en barnprofil vars läge bestäms av huvudkontot eller administratörens standard (profilen kan inte
 * stänga av det själv). Då tystar servern ljudet oavsett vad klienten skickar (ffc=1, ff=1 i adressen, direktfilen).
 */
export function enforced(uid) {
  const u = typeof uid === 'object' ? uid : get('SELECT id, max_age, family_filter FROM users WHERE id=?', uid);
  return !!u && u.max_age != null && modeFor(u) !== 'off';
}
export function setMode(uid, v) {
  if (v !== '' && v != null && !MODES.includes(v)) throw new Error('Ogiltigt läge');
  run('UPDATE users SET family_filter=? WHERE id=?', v || null, uid);
}

// ---------------- ordlistorna ----------------
const LANGS = { sv: 'sv', swe: 'sv', sve: 'sv', en: 'en', eng: 'en' };
export const langOf = (l) => LANGS[String(l || '').toLowerCase().split(/[-_]/)[0]] || null;
const cleanWord = (w) => String(w ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, MAX_WORD);
const validWord = (w) => /[\p{L}\p{N}]/u.test(w) && /^\*?[^*!]+\*?!?$/u.test(w) && !(w.endsWith('*!'));
function parseList(v) {
  try { const x = JSON.parse(v || 'null'); return x && typeof x === 'object' ? x : null; } catch { return null; }
}
/** Administratörens tillägg ({ sv: [...], en: [...] }) och avstängda inbyggda ord ([...]) */
export function customWords() {
  const x = parseList(getSetting('family_words', '')) || {};
  const off = parseList(getSetting('family_words_off', ''));
  return { sv: Array.isArray(x.sv) ? x.sv : [], en: Array.isArray(x.en) ? x.en : [], off: Array.isArray(off) ? off : [] };
}
/** Spara administratörens ord. Ogiltiga poster (tomma, bara tecken, * mitt i) tas bort; ger det sparade. */
export function setCustomWords({ sv, en, off } = {}) {
  const norm = (a) => [...new Set((Array.isArray(a) ? a : []).map(cleanWord).filter(validWord))].slice(0, MAX_EXTRA);
  const cur = customWords();
  const next = { sv: sv !== undefined ? norm(sv) : cur.sv, en: en !== undefined ? norm(en) : cur.en };
  const offList = off !== undefined ? norm(off).filter(w => WORDS.sv.includes(w) || WORDS.en.includes(w)) : cur.off;
  setSetting('family_words', JSON.stringify(next));
  setSetting('family_words_off', JSON.stringify(offList));
  return customWords();
}
/** Orden som gäller per språk (inbyggda utom avstängda + administratörens) */
export function wordsFor(lang) {
  const c = customWords(), off = new Set(c.off);
  return [...new Set([...WORDS[lang].filter(w => !off.has(w)), ...c[lang]])];
}
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const L = '[\\p{L}\\p{N}]';
/** Regex-delen för en post: frasens ord i följd, * = fler bokstäver före/efter, annars ordet och vanliga böjningar */
export function entrySource(w, lang) {
  const exact = w.endsWith('!'); if (exact) w = w.slice(0, -1);
  const pre = w.startsWith('*'), suf = w.endsWith('*');
  const words = w.replace(/^\*|\*$/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  const sx = suf ? `${L}*` : exact ? '' : `(?:${SUFFIX[lang].map(escRe).join('|')})?`;
  return (pre ? `${L}*` : '') + words.map(escRe).join(`[^\\p{L}\\p{N}]+`) + sx;
}
const reCache = new Map();
/** Matcharen för undertextens språk (null = båda listorna) – på ordgräns, utan hänsyn till versaler */
export function matcher(lang) {
  const key = (langOf(lang) || '*') + '|' + getSetting('family_words', '') + '|' + getSetting('family_words_off', '');
  let re = reCache.get(key);
  if (!re) {
    const langs = langOf(lang) ? [langOf(lang)] : ['sv', 'en'];
    // Längsta först: "son of a bitch" före "bitch" så att hela frasen maskeras
    const src = langs.flatMap(l => wordsFor(l).map(w => [w.replace(/[*!]/g, '').length, entrySource(w, l)])).filter(x => x[1])
      .sort((a, b) => b[0] - a[0]).map(x => x[1]);
    re = src.length ? new RegExp(`(?<!${L})(?:${[...new Set(src)].join('|')})(?!${L})`, 'giu') : /(?!)/gu;
    if (reCache.size > 20) reCache.clear();
    reCache.set(key, re);
  }
  re.lastIndex = 0;
  return re;
}
/** Innehåller texten en svordom? */
export const hasProfanity = (text, lang = null) => { const re = matcher(lang); const r = re.test(String(text || '').normalize('NFC')); re.lastIndex = 0; return r; };
/** Texten med svordomarna ersatta av *** (formatering <i>…</i> och {\an8} lämnas orörd) */
export function maskText(text, lang = null) {
  const re = matcher(lang);
  return String(text ?? '').normalize('NFC').replace(/(<[^>]*>|\{[^}]*\})|([^<{]+)/g, (m, tag, txt) => tag ? tag : txt.replace(re, '***'));
}
/** WebVTT med maskerade repliker – tidsrader, rubriker och NOTE/STYLE-block rörs inte */
export function maskVtt(vtt, lang = null) {
  const blocks = String(vtt ?? '').split(/(\r?\n\r?\n)/);
  return blocks.map((b) => {
    if (!b.includes('-->')) return b; // rubrik, NOTE, STYLE eller avgränsare
    const lines = b.split(/(\r?\n)/);
    let seen = false;
    return lines.map((ln) => { if (/-->/.test(ln)) { seen = true; return ln; } return seen && !/^\r?\n$/.test(ln) ? maskText(ln, lang) : ln; }).join('');
  }).join('');
}

// ---------------- tysta intervall ----------------
/** Slå ihop överlappande/nära intervall: [[a,b]] sorterade */
export function mergeIntervals(list, gap = JOIN) {
  const out = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a - last[1] <= gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
}
/** Intervallen ur repliker [{ s, e, text }] (redan förskjutna) */
export function intervalsOf(cues, lang = null) {
  const re = matcher(lang), hit = [];
  for (const c of cues) {
    re.lastIndex = 0;
    if (re.test(cleanText(c.text))) hit.push([Math.max(0, c.s - PRE), c.e + POST]);
  }
  re.lastIndex = 0;
  return mergeIntervals(hit);
}
// Ljudspårets språk ('swe', 'eng' …) → indexerade undertexter i samma språk, annars alla
function linesFor(itemId, audioLang) {
  const subs = all(`SELECT si.sub, si.lang, si.fmtime, ss.shift, ss.ratio FROM sub_index si
    LEFT JOIN sub_sync ss ON ss.item_id=si.item_id AND ss.sub=si.sub AND ss.sub_mtime=si.fmtime WHERE si.item_id=? AND si.state=1 AND si.lines > 0`, itemId);
  const want = langOf(audioLang);
  const same = want ? subs.filter(s => langOf(s.lang) === want) : [];
  return (same.length ? same : subs).map(s => ({ s, cues: all('SELECT s, e, text FROM sub_lines WHERE item_id=? AND sub=? ORDER BY s', itemId, s.sub) }));
}
const cache = new Map(); // titel → { key, list }
/** Tysta intervall för en fil: [[start, slut]] i spelarens tid. audioLang = valt ljudspårs språk. */
export function muteIntervals(it, audioLang = null) {
  if (!it?.id) return [];
  // Nyckel: indexets version och synkens värden (updated är i sekunder – två ändringar samma sekund syns ändå)
  const sig = get(`SELECT COUNT(*) AS n, MAX(si.updated) AS u, (SELECT group_concat(sub || ':' || shift || ':' || ratio || ':' || COALESCE(sub_mtime, ''))
    FROM sub_sync WHERE item_id=?) AS y FROM sub_index si WHERE si.item_id=?`, it.id, it.id);
  const key = `${sig.n}|${sig.u}|${sig.y}|${audioLang || ''}|${getSetting('family_words', '')}|${getSetting('family_words_off', '')}`;
  const c = cache.get(it.id);
  if (c && c.key === key) return c.list;
  const all2 = [];
  for (const { s, cues } of linesFor(it.id, audioLang)) {
    const ratio = s.ratio || 1, shift = s.shift || 0;
    all2.push(...intervalsOf(cues.map(x => ({ s: x.s * ratio + shift, e: x.e * ratio + shift, text: x.text })), s.lang));
  }
  const list = mergeIntervals(all2);
  cache.set(it.id, { key, list });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return list;
}
/** Finns indexerade repliker för filen (annars vet filtret inget än) */
export const indexed = (it) => !!get('SELECT 1 FROM sub_index WHERE item_id=? AND state=1 LIMIT 1', it.id);

// ---------------- hoppa över scener ----------------
// Markeringar per fil (items.id för den version som spelas). scope: 'me' = bara profilen, 'household' = hushållets
// profiler, 'all' = alla (bara administratören). Barnprofiler kan inte markera eller ta bort.
export const SCOPES = ['me', 'household', 'all'];
const rootOf = (u) => u.parent_id || u.id;
const userRow = (uid) => get('SELECT id, parent_id, is_admin, max_age FROM users WHERE id=?', uid);
/** Markeringarna som profilen ser för filen */
export function skipsFor(itemId, uid) {
  const u = userRow(uid); if (!u) return [];
  return all(`SELECT k.id, k.s, k.e, k.label, k.scope, k.user_id, k.household, u.name AS by_name FROM skip_scenes k LEFT JOIN users u ON u.id=k.user_id
    WHERE k.item_id=? AND (k.scope='all' OR (k.scope='household' AND k.household=?) OR k.user_id=?) ORDER BY k.s`, itemId, rootOf(u), u.id)
    .map(k => ({ id: k.id, start: k.s, end: k.e, label: k.label || '', scope: k.scope, by: k.by_name || null, mine: k.user_id === u.id,
      canDelete: canDelete(u, k) }));
}
function canDelete(u, k) {
  if (u.max_age != null) return false;
  if (u.is_admin || k.user_id === u.id) return true;
  return k.scope === 'household' && k.household === rootOf(u) && u.id === rootOf(u); // huvudkontot städar hushållets
}
/** Ny markering (kastar Error med ett meddelande för användaren) */
export function addSkip(itemId, uid, { start, end, label, scope = 'me' } = {}) {
  const u = userRow(uid);
  if (!u || u.max_age != null) throw Object.assign(new Error('Barnprofiler kan inte markera scener'), { status: 403 });
  const s = +start, e = +end;
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e - s < 0.5) throw Object.assign(new Error('Scenen måste vara minst en halv sekund'), { status: 400 });
  if (e - s > 30 * 60) throw Object.assign(new Error('En scen kan vara högst 30 minuter'), { status: 400 });
  if (!SCOPES.includes(scope)) scope = 'me';
  if (scope === 'all' && !u.is_admin) throw Object.assign(new Error('Bara administratören kan dela med alla'), { status: 403 });
  if (get('SELECT COUNT(*) AS n FROM skip_scenes WHERE item_id=?', itemId).n >= 200) throw Object.assign(new Error('För många markeringar för titeln'), { status: 400 });
  const r = run('INSERT INTO skip_scenes(item_id, user_id, household, scope, s, e, label, created) VALUES(?,?,?,?,?,?,?,?)',
    itemId, u.id, rootOf(u), scope, Math.round(s * 1000) / 1000, Math.round(e * 1000) / 1000, String(label || '').trim().slice(0, 80) || null, now());
  return Number(r.lastInsertRowid);
}
/** Ta bort en markering – null om den inte finns för profilen, false om den inte får tas bort */
export function removeSkip(id, uid) {
  const u = userRow(uid); if (!u) return null;
  const k = get('SELECT * FROM skip_scenes WHERE id=?', id);
  if (!k || !(k.scope === 'all' || (k.scope === 'household' && k.household === rootOf(u)) || k.user_id === u.id)) return null;
  if (!canDelete(u, k)) return false;
  run('DELETE FROM skip_scenes WHERE id=?', id);
  return true;
}

// ---------------- planen till spelaren ----------------
/**
 * Filterplanen för /playback (null när filtret är av). serverMute = strömmen från servern tystar själv.
 * mute: [[start, slut]], skip: [{ id, start, end, label }] (bara läget 'skip').
 */
export function planFor(it, uid, { audioLang = null, mute = null, serverMute = false } = {}) {
  const mode = modeFor(uid);
  if (mode === 'off') return null;
  return {
    mode, item: it.id, ready: indexed(it), server: !!serverMute, mute: mute ?? muteIntervals(it, audioLang),
    skip: mode === 'skip' ? skipsFor(it.id, uid).map(({ id, start, end, label }) => ({ id, start, end, label })) : []
  };
}

/** ffmpeg: volymfilter som tystar intervallen. off = körningens starttid i filen (filtrets t = filmens tid − off). */
export function muteFilters(list, off = 0) {
  const parts = (list || []).filter(([, b]) => b > off - 1).map(([a, b]) => `between(t,${Math.max(-1, a - off).toFixed(3)},${(b - off).toFixed(3)})`);
  const out = [];
  // Högst 100 intervall per filter (uttrycket utvärderas för varje ljudram)
  for (let i = 0; i < parts.length; i += 100) out.push(`volume=volume=0:enable='${parts.slice(i, i + 100).join('+')}'`);
  return out;
}
