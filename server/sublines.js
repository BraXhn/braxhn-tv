// Repliksökning: sök på en replik ("I'll be back", "jag är din far") och hoppa direkt till scenen.
// Indexet: alla textundertexter (externa .srt/.ass/.vtt bredvid filen, nedladdade och upp till MAX_EMBEDDED inbäddade
// textspår per fil) läses som WebVTT via stream.subtitleVtt (samma kod och cache som uppspelningen – inbäddade spår
// extraheras med lägsta prioritet) och replikerna läggs i sub_lines med FTS5-indexet sub_fts (db.js). Saknas FTS5 sparas
// en normaliserad text (norm) och sökningen görs med LIKE.
// Inkrementellt: varje undertext har en signatur (inbäddade: filens mtime; filer: mtime och storlek) i sub_index – bara nya
// och ändrade indexeras, borttagna undertexter tas bort och allt försvinner med titeln (kaskad). Tiderna sparas som i
// filen; justeringen från undertextsynken (sub_sync, subsync.js) läggs på vid sökningen, så en synk gäller direkt.
// Jobbet körs efter skanningen och vid start, en undertext åt gången, väntar medan video omkodas och syns i aktivitetspanelen.
import fs from 'node:fs';
import { all, get, run, tx, now, getSetting, FTS5 } from './db.js';
import { subtitlesOf, subtitleVtt } from './stream.js';
import { vttParser } from './subreader.js';
import * as trick from './trickplay.js';
import * as jobs from './jobs.js';

export const MAX_EMBEDDED = 3; // inbäddade textspår per fil (filer med 20 språk ger annars ett mycket stort index)
const MAX_FILES = 6;           // externa/nedladdade undertexter per titel
const MAX_LINE = 400;          // tecken per replik
const PREFERRED = ['swe', 'sv', 'eng', 'en', 'nor', 'no', 'nob', 'dan', 'da', 'fin', 'fi'];

export const enabled = () => getSetting('subindex', process.env.SUBINDEX || '1') !== '0';

// ---------------- text ----------------
const ENT = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'", lrm: '', rlm: '' };
/** Repliken som ren text: utan formatering (<i>, {\an8}, ASS-koder) och med en rad */
export function cleanText(t) {
  return String(t || '').replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/g, ' ')
    .replace(/&(amp|lt|gt|nbsp|quot|apos|lrm|rlm);/g, (_, e) => ENT[e]).replace(/\s+/g, ' ').trim().normalize('NFC').slice(0, MAX_LINE);
}
/** Orden i en text (bokstäver och siffror, gemener) – samma uppdelning som FTS5:s unicode61 */
export const wordsOf = (t) => String(t || '').normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const normOf = (t) => ' ' + wordsOf(t).join(' ') + ' ';
/** Repliker ur WebVTT: [{ s, e, text }] sorterade, utan tomma och utan omedelbara upprepningar (karaoke, ASS-lager) */
export function cuesOf(vtt) {
  const out = [];
  const p = vttParser((c) => { const text = cleanText(c.text); if (text && /[\p{L}\p{N}]/u.test(text) && c.e >= c.s) out.push({ s: c.s, e: c.e, text }); });
  p.push(Buffer.from(String(vtt || '').replace(/\r/g, ''), 'utf8')); p.end();
  out.sort((a, b) => a.s - b.s);
  return out.filter((c, i) => !(i && out[i - 1].text === c.text && c.s - out[i - 1].e < 0.5));
}

// ---------------- vilka undertexter ----------------
const mtimeOf = (f) => { try { const st = fs.statSync(f); return { m: Math.floor(st.mtimeMs), size: st.size }; } catch { return null; } };
/** Undertexterna som ska finnas i indexet för en fil: [{ key, sub, sig, fmtime }] */
export function wantedFor(it) {
  const subs = subtitlesOf(it).filter(s => !s.bitmap);
  const out = [];
  const rank = (s) => { const i = PREFERRED.indexOf(String(s.lang || '').toLowerCase()); return i < 0 ? PREFERRED.length : i; };
  // Tvingade spår (bara skyltar och främmande språk) hoppas över; svenska och engelska först
  const emb = subs.filter(s => s.source === 'embedded' && !s.forced).map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).slice(0, MAX_EMBEDDED);
  for (const { s } of emb) out.push({ key: s.id, sub: s, sig: `e:${it.mtime | 0}`, fmtime: null });
  for (const s of subs.filter(x => x.file).slice(0, MAX_FILES)) {
    const st = mtimeOf(s.file); if (!st) continue;
    // Samma nyckel som sub_sync (subsync.js keyOf) – synkens justering hittas med en JOIN
    out.push({ key: `${s.source}:${s.file.split(/[\\/]/).pop()}`, sub: s, sig: `f:${st.m}:${st.size}`, fmtime: st.m });
  }
  return out;
}

// ---------------- indexering ----------------
const ITEMS = `SELECT i.id, i.path, i.mtime, i.streams, i.duration, i.title, i.library_id FROM items i JOIN libraries l ON l.id=i.library_id
  WHERE i.kind IN ('movie','episode') AND i.path IS NOT NULL AND l.type IN ('movie','show')`;
/** Spara replikerna för en undertext (ersätter en tidigare version) */
export function store(it, w, cues, error = null) {
  tx(() => {
    run('DELETE FROM sub_index WHERE item_id=? AND sub=?', it.id, w.key); // kaskad: sub_lines → sub_fts
    run('INSERT INTO sub_index(item_id, sub, sig, fmtime, lang, label, lines, state, error, updated) VALUES(?,?,?,?,?,?,?,?,?,?)',
      it.id, w.key, w.sig, w.fmtime, w.sub.lang || null, w.sub.label || null, cues.length, error ? 2 : 1, error, now());
    for (const c of cues) run('INSERT INTO sub_lines(item_id, sub, s, e, text, norm) VALUES(?,?,?,?,?,?)', it.id, w.key, c.s, c.e, c.text, FTS5 ? null : normOf(c.text));
  });
}
let busy = () => false;
/** Pausa medan något viktigare pågår (app.js: omkodning) */
export function setBusyCheck(fn) { busy = fn; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.());
const S = { running: false, again: false, timer: null, done: 0, total: 0 };
export const progress = () => S.running && S.total ? { done: S.done, total: S.total } : null;

/** Gå igenom alla titlar: ta bort undertexter som inte finns längre, indexera nya och ändrade */
export async function pass() {
  if (S.running) { S.again = true; return; }
  if (!enabled()) return;
  S.running = true;
  let jb = null;
  try {
    do {
      S.again = false;
      const have = new Map(); // titel → Map(undertext → signatur)
      for (const r of all('SELECT item_id, sub, sig FROM sub_index')) {
        if (!have.has(r.item_id)) have.set(r.item_id, new Map());
        have.get(r.item_id).set(r.sub, r.sig);
      }
      const items = all(ITEMS), todo = [];
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        let want; try { want = wantedFor(it); } catch { continue; }
        const mine = have.get(it.id) || new Map(), keys = new Set(want.map(w => w.key));
        // Undertexter som inte finns längre (borttagen fil, färre spår) tas bort
        for (const sub of mine.keys()) if (!keys.has(sub)) run('DELETE FROM sub_index WHERE item_id=? AND sub=?', it.id, sub);
        for (const w of want) if (mine.get(w.key) !== w.sig) todo.push([it, w]);
        if (k % 200 === 199) await new Promise(r => setImmediate(r)); // låt förfrågningar komma emellan
      }
      if (!todo.length) continue;
      S.done = 0; S.total = todo.length;
      jb = jobs.track('subindex', 'Indexerar repliker', { total: todo.length });
      let ok = 0, failed = 0;
      for (const [it, w] of todo) {
        while (busy()) await sleep(10e3);
        if (!enabled()) break;
        jb.update(S.done, todo.length, it.title || '');
        try {
          // Titeln kan ha tagits bort medan jobbet väntade
          if (get('SELECT 1 FROM items WHERE id=?', it.id)) { store(it, w, cuesOf(await subtitleVtt(it, w.sub, { low: true }))); ok++; }
        } catch (e) {
          failed++;
          try { if (get('SELECT 1 FROM items WHERE id=?', it.id)) store(it, w, [], String(e.message || e).slice(0, 300)); } catch {}
          console.warn('[repliker]', it.path, w.key, e.message);
        }
        S.done++;
      }
      jb.end(); jb = null;
      console.log(`[repliker] ${ok} undertexter indexerade${failed ? `, ${failed} gick inte att läsa` : ''}`);
    } while (S.again);
  } finally { jb?.end(); S.running = false; S.total = 0; }
}
/** Starta en genomgång om ms (flera anrop i rad blir en, den tidigaste gäller) */
export function kick(ms = 5000) {
  const at = Date.now() + ms;
  if (S.timer && S.at <= at) return;
  clearTimeout(S.timer); // en tidigare start ersätter en senare (skanningen strax efter serverstarten)
  S.at = at;
  S.timer = setTimeout(() => { S.timer = null; pass().catch(e => console.warn('[repliker]', e.message)); }, ms);
  S.timer.unref?.();
}
/** För tester: kör tills inget återstår */
export async function drain() { await pass(); while (S.running) await sleep(20); }

// ---------------- sökning ----------------
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Var i texten träffen finns: [[start, slut]] (teckenindex) – orden i följd, sista ordet som prefix (markeras helt) */
export function marksOf(text, words) {
  if (!words.length) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(esc).join('[^\\p{L}\\p{N}]+')}[\\p{L}\\p{N}]*`, 'giu');
  const out = [];
  for (const m of String(text).matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}
/** FTS5-frågan för orden: en fras där sista ordet får vara början av ett ord ("i ll be ba"*). Orden är bara bokstäver
 *  och siffror (wordsOf) – ingen FTS5-syntax når frågan. Ett sista ord kortare än tre tecken söks som helt ord: "th"*
 *  slår ihop doclistorna för alla ord som börjar så (1,8 s per fråga med en miljon repliker, servern stilla). */
const TOP = 3000; // FTS-träffar som behörighetsfiltret får välja bland
const CAND = 20000; // högst så många träffar rankas – ett vanligt ord ("the") ska inte sortera hela indexet
export const ftsQuery = (words) => `"${words.join(' ')}"${words[words.length - 1].length >= 3 ? '*' : ''}`;
// Titeln, avsnittet och åldersgränsen: s = serien (avsnitt) eller huvudraden (filmversioner) – samma arv som allowedFor
const SELECT = `SELECT l.id AS lid, l.item_id, l.sub, l.s, l.e, l.text, si.lang, si.label, ss.shift, ss.ratio,
  i.kind, i.title, i.season, i.episode, i.year, i.parent_id, i.version_of, i.library_id, i.age, i.mtime, s.title AS s_title, s.year AS s_year
  FROM sub_lines l JOIN sub_index si ON si.item_id=l.item_id AND si.sub=l.sub JOIN items i ON i.id=l.item_id
  LEFT JOIN items s ON s.id=COALESCE(i.parent_id, i.version_of)
  LEFT JOIN sub_sync ss ON ss.item_id=l.item_id AND ss.sub=l.sub AND ss.sub_mtime=si.fmtime`;
const neighbour = (it, sub, s, dir) => get(`SELECT text FROM sub_lines WHERE item_id=? AND sub=? AND s ${dir < 0 ? '<' : '>'} ? ORDER BY s ${dir < 0 ? 'DESC' : 'ASC'} LIMIT 1`, it, sub, s)?.text ?? null;
/** Förhandsbilden vid tiden t (trickplay.js): ark-adress och ruta i arket, null om bilderna saknas */
export function thumbAt(row, t, cache = new Map()) {
  let info = cache.get(row.item_id);
  if (info === undefined) { info = row.mtime != null ? trick.info({ id: row.item_id, mtime: row.mtime }) : null; cache.set(row.item_id, info); }
  if (!info?.count || !info.interval) return null;
  const per = info.cols * info.rows, idx = Math.max(0, Math.min(info.count - 1, Math.floor(t / info.interval)));
  const cell = idx % per;
  return { url: `/api/items/${row.item_id}/trickplay/${(info.first ?? 1) + Math.floor(idx / per)}`, col: cell % info.cols, row: Math.floor(cell / info.cols), cols: info.cols, rows: info.rows, w: info.w, h: info.h };
}

/**
 * Sök repliker. age = ageFilter(uid) (alias i/s), allowed(row) = allowedFor-kontroll per träff.
 * Ger högst limit repliker, högst perTitle per titel, i relevansordning.
 */
export function search(q, { age, allowed, limit = 30, perTitle = 5 }) {
  const words = wordsOf(q).slice(0, 12);
  if (!words.length || words.join('').length < 2) return [];
  const pool = Math.min(1000, limit * 10);
  const rows = FTS5
    // De första CAND träffarna rankas och de bästa TOP väljs – ett vanligt ord ger annars hela indexet att ranka och sortera
    ? all(`WITH c AS (SELECT rowid AS rid, rank FROM sub_fts WHERE sub_fts MATCH ? LIMIT ${CAND}), m AS (SELECT rid, rank FROM c ORDER BY rank LIMIT ${TOP})
      ${SELECT.replace('FROM sub_lines l', 'FROM m JOIN sub_lines l ON l.id=m.rid')} WHERE 1${age.sql} ORDER BY m.rank LIMIT ?`, ftsQuery(words), ...age.params, pool)
    : all(`${SELECT} WHERE l.norm LIKE ? ESCAPE '\\'${age.sql} ORDER BY length(l.text) LIMIT ?`, `% ${words.join(' ').replace(/[%_\\]/g, '\\$&')}%`, ...age.params, pool);
  const out = [], seen = new Set(), per = new Map(), thumbs = new Map();
  for (const r of rows) {
    if (out.length >= limit) break;
    if (!allowed(r)) continue;
    const main = r.version_of || r.item_id; // filmversioner spelas som filmen med vald version
    const ratio = r.ratio || 1, shift = r.shift || 0;
    const t = Math.max(0, r.s * ratio + shift), end = Math.max(t, r.e * ratio + shift);
    // Samma replik i flera undertexter (svensk + engelsk SDH, flera versioner) visas en gång
    const dk = `${main}|${Math.round(t / 3)}|${wordsOf(r.text).join(' ')}`;
    if (seen.has(dk)) continue;
    if ((per.get(main) || 0) >= perTitle) continue;
    seen.add(dk); per.set(main, (per.get(main) || 0) + 1);
    const marks = marksOf(r.text, words);
    out.push({
      id: main, ...(r.version_of ? { version: r.item_id } : {}), kind: r.kind,
      title: r.kind === 'episode' ? r.s_title || r.title : r.version_of ? r.s_title || r.title : r.title,
      ...(r.kind === 'episode' ? { episodeTitle: r.title, season: r.season, episode: r.episode, show: r.parent_id } : {}),
      year: r.kind === 'episode' ? r.s_year ?? null : r.year ?? r.s_year ?? null,
      t: Math.round(t * 1000) / 1000, end: Math.round(end * 1000) / 1000,
      line: r.text, marks, before: neighbour(r.item_id, r.sub, r.s, -1), after: neighbour(r.item_id, r.sub, r.s, 1),
      lang: r.lang || null, label: r.label || null, thumb: thumbAt(r, t, thumbs)
    });
  }
  return out;
}

/** Läget för indexet (sökvyns tomma läge och aktivitetspanelen) */
export function status() {
  const r = get('SELECT COUNT(DISTINCT item_id) AS titles, COALESCE(SUM(lines),0) AS lines FROM sub_index WHERE state=1');
  return { enabled: enabled(), fts: FTS5, titles: r.titles, lines: r.lines, indexing: progress() };
}
