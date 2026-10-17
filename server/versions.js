// Flera versioner av samma film (t.ex. 4K och 1080p).
// Varje fil är en egen rad i items; versionerna pekar på huvudraden med version_of. Listor, sök,
// rekommendationer och statistik visar bara huvudraden (version_of IS NULL). Framsteg, Min lista
// och metadata hör till huvudraden – uppspelningen väljer den version som passar klienten bäst.
import fs from 'node:fs';
import path from 'node:path';
import { get, all, run, tx, IMAGES } from './db.js';

// Kolumner som beskriver filmen (inte filen) – flyttas till en ny huvudrad när huvudfilen försvinner
const META_COLS = 'title, sort_title, year, overview, rating, tmdb_id, meta_done, poster, backdrop, genres, cert, age, collection_id, match_locked, added, credits_done, trailer_yt';

/** Grupperingsnyckel: samma titel och år i samma bibliotek. Filer utan årtal grupperas aldrig (för osäkert). */
export function versionKey(parsed) {
  if (parsed?.part) return null; // del 1/2 av samma film är inte versioner
  return parsed?.year && parsed.title ? `${parsed.title.normalize('NFC').toLowerCase()}\u0000${parsed.year}` : null;
}

/** Flyttar framsteg och Min lista från en rad till en annan (sedd vinner, senaste positionen gäller) */
export function mergeInto(fromId, toId) {
  run(`INSERT INTO progress(user_id,item_id,position,duration,watched,updated)
    SELECT user_id, ?, position, duration, watched, updated FROM progress WHERE item_id=?
    ON CONFLICT(user_id,item_id) DO UPDATE SET watched=MAX(watched,excluded.watched),
      position=CASE WHEN excluded.updated > updated THEN excluded.position ELSE position END,
      duration=COALESCE(duration, excluded.duration), updated=MAX(updated, excluded.updated)`, toId, fromId);
  run('DELETE FROM progress WHERE item_id=?', fromId);
  run('INSERT OR IGNORE INTO watchlist(user_id,item_id,added) SELECT user_id, ?, added FROM watchlist WHERE item_id=?', toId, fromId);
  run('DELETE FROM watchlist WHERE item_id=?', fromId);
  // Uppspelningshistoriken (activity.js) räknas på filmen
  try { run('UPDATE plays SET item_id=? WHERE item_id=?', toId, fromId); } catch {}
  // Rollista och trailers följer med filmen (people.js/trailers.js)
  try { run('UPDATE OR IGNORE item_people SET item_id=? WHERE item_id=?', toId, fromId); run('DELETE FROM item_people WHERE item_id=?', fromId); } catch {}
  try { run('UPDATE trailers SET item_id=? WHERE item_id=?', toId, fromId); } catch {}
}

/**
 * Grupperar filmfiler i ett bibliotek som tolkas till samma titel+år. Bara strängjämförelser – inga filer läses.
 * En befintlig huvudrad behålls (framsteg och metadata sitter där); annars blir den äldsta raden huvudrad.
 * parse = scannerns parseMovie (skickas in för att undvika cirkulära importer).
 */
export function groupVersions(lib, parse) {
  if (lib.type !== 'movie') return 0;
  const rows = all(`SELECT id, path, year, version_of, tmdb_id, meta_done, match_locked FROM items WHERE library_id=? AND kind='movie' AND path IS NOT NULL ORDER BY id`, lib.id);
  // Två filer är samma film om de har samma titel+år i filnamnet ELLER matchats till samma TMDB-film
  // (t.ex. svensk och engelsk titel, eller en fil utan årtal). Unionfind över båda nycklarna.
  const parent = new Map(rows.map(r => [r.id, r.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const owner = new Map();
  const link = (key, id) => { if (!key) return; const o = owner.get(key); if (o == null) owner.set(key, id); else parent.set(find(id), find(o)); };
  for (const r of rows) {
    const p = parse(r.path);
    link(versionKey(p), r.id);
    // Samma TMDB-film – men bara om filnamnets årtal (om det finns) stämmer med filmens: skydd mot äldre felmatchningar
    if (r.tmdb_id && r.meta_done === 1 && (!p?.year || !r.year || Math.abs(p.year - r.year) <= 1)) link(`tmdb:${r.tmdb_id}`, r.id);
  }
  const groups = new Map();
  for (const r of rows) {
    const k = find(r.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let changed = 0;
  tx(() => {
    for (const g of groups.values()) {
      if (g.length === 1) {
        // Ensam kvar (t.ex. omdöpt): blir en egen film och får egen metadata
        if (g[0].version_of != null) { run('UPDATE items SET version_of=NULL, meta_done=0 WHERE id=?', g[0].id); changed++; }
        continue;
      }
      const mains = g.filter(r => r.version_of == null);
      // Huvudrad: den som redan har versioner, annars en med metadata (helst handmatchad), annars den äldsta
      const main = mains.find(m => g.some(r => r.version_of === m.id)) || mains.find(m => m.match_locked && m.meta_done === 1)
        || mains.find(m => m.meta_done === 1 && m.tmdb_id) || mains[0] || g[0];
      if (main.version_of != null) { run('UPDATE items SET version_of=NULL, meta_done=0 WHERE id=?', main.id); changed++; }
      for (const r of g) {
        if (r === main || r.version_of === main.id) continue;
        run('UPDATE items SET version_of=? WHERE id=?', main.id, r.id);
        mergeInto(r.id, main.id);
        changed++;
      }
    }
  });
  if (changed) console.log(`[scan] ${lib.name}: ${changed} filmversioner grupperades om`);
  return changed;
}

/**
 * Anropas (i skannerns transaktion) innan försvunna rader tas bort: en huvudrad som försvinner men har
 * versioner kvar ersätts av den bästa kvarvarande versionen, som tar över metadata, framsteg och Min lista.
 * Returnerar bildflyttar [{ from, to }] som görs efter transaktionen.
 */
export function promoteVersions(missingIds) {
  const gone = new Set(missingIds);
  const moves = [];
  for (const id of missingIds) {
    const left = all('SELECT id, width, height FROM items WHERE version_of=? ORDER BY id', id).filter(r => !gone.has(r.id));
    if (!left.length) continue;
    const best = left.slice().sort((a, b) => (b.width || 0) - (a.width || 0) || (b.height || 0) - (a.height || 0) || a.id - b.id)[0];
    run(`UPDATE items SET (${META_COLS}) = (SELECT ${META_COLS} FROM items WHERE id=?), version_of=NULL WHERE id=?`, id, best.id);
    run('UPDATE items SET version_of=? WHERE version_of=? AND id != ?', best.id, id, best.id);
    mergeInto(id, best.id);
    moves.push({ from: id, to: best.id });
  }
  return moves;
}
/** Affisch och bakgrund följer med till den nya huvudraden (filnamnen bygger på id) */
export function moveImages(moves) {
  for (const { from, to } of moves) {
    for (const t of ['poster', 'backdrop']) {
      try { fs.renameSync(path.join(IMAGES, `${from}-${t}.jpg`), path.join(IMAGES, `${to}-${t}.jpg`)); } catch {}
    }
  }
}

/** Huvudraden och dess versioner (huvudraden först) */
export function versionsOf(main) {
  if (!main || main.kind !== 'movie') return main ? [main] : [];
  return [main, ...all('SELECT * FROM items WHERE version_of=? ORDER BY id', main.id)];
}

const HDR_NAME = { hdr10: 'HDR10', dovi: 'Dolby Vision', hlg: 'HLG' };
export function resolutionLabel(r) {
  const w = r.width || 0, h = r.height || 0;
  const res = w >= 3200 || h >= 1800 ? '4K' : w >= 1700 || h >= 1000 ? '1080p' : w >= 1100 || h >= 700 ? '720p' : h ? `${h}p` : 'Okänd upplösning';
  return res + (r.hdr ? ' ' + (HDR_NAME[r.hdr] || String(r.hdr).toUpperCase()) : '');
}
/** Versionsetikett: filnamnets suffix efter "Titel (År)", t.ex. "Director's Cut"; annars upplösningen */
export function versionLabel(r) {
  const base = path.basename(r.path || '', path.extname(r.path || ''));
  const m = base.match(/^(.*)[\s._(\[-]((?:19|20)\d\d)[)\]]?(.*)$/);
  const suf = (m ? m[3] : '').replace(/[._]+/g, ' ').replace(/^[\s\-–)\]]+/, '').replace(/[\s\-–\[(]+$/, '').replace(/\s+/g, ' ').trim();
  if (!suf || /^(2160p|1080p|720p|576p|480p|4k|uhd)\b/i.test(suf)) return resolutionLabel(r);
  return suf.slice(0, 40);
}
/** Lista för klienter: [{ id, label, width, height, hdr, size, vcodec }] med unika etiketter */
export function versionList(rows) {
  const out = rows.map(r => ({ id: r.id, label: versionLabel(r), width: r.width, height: r.height, hdr: r.hdr || null, size: r.size, vcodec: r.vcodec }));
  const seen = new Map();
  for (const v of out) seen.set(v.label, (seen.get(v.label) || 0) + 1);
  const n = new Map();
  for (const v of out) if (seen.get(v.label) > 1) { const k = (n.get(v.label) || 0) + 1; n.set(v.label, k); v.label = `${v.label} (${k})`; }
  return out;
}

/**
 * Väljer bästa versionen för klienten: helst en som kan spelas direkt eller remuxas (ingen omkodning),
 * då den med högst upplösning; annars den högsta upplösningen ≤ önskad kvalitet (maxH).
 * Rankningen görs utan ljud-/undertextval så att valet inte ändras när man byter spår.
 */
export function chooseVersion(rows, o, decide, maxH = null) {
  if (rows.length < 2) return rows[0];
  const base = { ...o, audio: '', sub: '' };
  const rank = { direct: 0, remux: 1, transcode: 2 };
  const scored = rows.map(r => ({ r, mode: decide(r, base).mode, h: r.height || 0, w: r.width || 0 }));
  const noTx = scored.filter(x => x.mode !== 'transcode');
  const pool = noTx.length ? noTx : scored;
  pool.sort((a, b) => {
    if (!noTx.length && maxH) {
      const af = a.h <= maxH, bf = b.h <= maxH;
      if (af !== bf) return af ? -1 : 1;
      if (!af) return a.h - b.h; // alla över gränsen: minst arbete att skala ner
    }
    return (b.w - a.w) || (b.h - a.h) || (rank[a.mode] - rank[b.mode]) || ((a.r.version_of == null ? 0 : 1) - (b.r.version_of == null ? 0 : 1)) || (a.r.id - b.r.id);
  });
  return pool[0].r;
}

/** Ljud-/undertextval från en annan version (t.ex. appar som läst huvudfilens spår): översätt via språk och kodek */
export function mapTracks(o, from, to, streamsOf, subtitlesOf) {
  if (!from || from.id === to.id) return o;
  const out = { ...o };
  const toAudio = streamsOf(to).filter(s => s.type === 'audio');
  if (o.audio && !toAudio.some(a => String(a.index) === o.audio)) {
    const src = streamsOf(from).find(s => s.type === 'audio' && String(s.index) === o.audio);
    const hit = src && (toAudio.find(a => a.lang === src.lang && a.codec === src.codec) || toAudio.find(a => a.lang === src.lang));
    out.audio = hit ? String(hit.index) : '';
  }
  if (o.sub) {
    const toSubs = subtitlesOf(to);
    if (!toSubs.some(s => s.id === o.sub)) {
      const src = subtitlesOf(from).find(s => s.id === o.sub);
      const hit = src && (toSubs.find(s => s.lang === src.lang && s.bitmap === src.bitmap && s.forced === src.forced) || toSubs.find(s => s.lang === src.lang && s.bitmap === src.bitmap));
      out.sub = hit ? hit.id : '';
    }
  }
  return out;
}

/** Huvudradens id för en rad (versioner pekar på huvudraden) */
export const mainIdOf = (it) => it?.version_of || it?.id;
export const mainOf = (it) => it?.version_of ? get('SELECT * FROM items WHERE id=?', it.version_of) || it : it;
