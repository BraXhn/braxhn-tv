// Tittarhistorik direkt ur Plex databasfil (com.plexapp.plugins.library.db): alla konton, offline, mest exakt.
// Filen (och ev. -wal med de senaste ändringarna) kopieras till en tillfällig mapp och öppnas skrivskyddat –
// originalet rörs aldrig. Plex schema skiljer mellan versioner: tabeller och kolumner kontrolleras innan de används.
//
// Tabeller: accounts (id, name), metadata_item_settings (account_id, guid, view_count, view_offset, last_viewed_at –
// ett konto och en titel, nyckeln är guid så att det överlever att titeln läggs till igen), metadata_items (titlar,
// säsonger, avsnitt: metadata_type 1/2/3/4, parent_id, "index"), media_items/media_parts (filerna), tags/taggings
// (tag_type 314 = externa id:n tmdb://, imdb://, tvdb:// för Plex nya agent) och metadata_item_views (uppspelningar,
// finns kvar även för titlar som tagits bort).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const PLEX_DB = 'com.plexapp.plugins.library.db';
const err400 = (msg) => Object.assign(new Error(msg), { status: 400 });
const int = (v) => { const n = parseInt(v); return Number.isFinite(n) ? n : null; };

/** Plex-guid: nya agenter har Guid: [{ id: 'tmdb://123' }], äldre guid: 'com.plexapp.agents.imdb://tt123?lang=en'. plex:// ger inget id. */
export function plexIds(m) {
  const ids = {};
  const add = (g) => {
    const x = /^(?:com\.plexapp\.agents\.)?(tmdb|themoviedb|imdb|tvdb|thetvdb):\/\/([^?/]+)/i.exec(String(g || ''));
    if (!x) return;
    const k = { themoviedb: 'tmdb', thetvdb: 'tvdb' }[x[1].toLowerCase()] || x[1].toLowerCase();
    const v = decodeURIComponent(x[2]).trim();
    if (!v || (k === 'imdb' ? !/^tt\d+$/.test(v) : !/^\d+$/.test(v))) return;
    if (!ids[k]) ids[k] = v;
  };
  for (const g of m?.Guid || []) add(g?.id);
  add(m?.guid);
  return ids;
}

/** Plex tider: unix-sekunder (nyare), millisekunder eller 'ÅÅÅÅ-MM-DD TT:MM:SS' (äldre versioner) */
export function plexTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) { const n = +v; return n > 1e11 ? Math.floor(n / 1000) : n > 0 ? Math.floor(n) : null; }
  const t = Date.parse(String(v).trim().replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z'));
  return Number.isFinite(t) && t > 0 ? Math.floor(t / 1000) : null;
}

/** Sökvägen till databasfilen: själva filen eller en mapp som innehåller den (Plex-mappen eller Databases) */
export function resolveDbPath(p) {
  const s = String(p || '').trim();
  if (!s || !path.isAbsolute(s)) throw err400(`Ange hela sökvägen till Plex databas i containern, t.ex. /plex/Plug-in Support/Databases/${PLEX_DB}`);
  let f = path.normalize(s);
  let st = null; try { st = fs.statSync(f); } catch {}
  if (st?.isDirectory()) {
    const tries = [PLEX_DB, path.join('Plug-in Support', 'Databases', PLEX_DB), path.join('Library', 'Application Support', 'Plex Media Server', 'Plug-in Support', 'Databases', PLEX_DB)];
    const hit = tries.map(x => path.join(f, x)).find(x => { try { return fs.statSync(x).isFile(); } catch { return false; } });
    if (!hit) throw err400(`Hittar inte ${PLEX_DB} i mappen – ange filen direkt`);
    f = hit; st = fs.statSync(f);
  }
  if (!st) throw err400('Hittar inte filen – är Plex-mappen monterad i containern (Docker-mallen)?');
  if (!st.isFile() || !/\.db$/i.test(f)) throw err400(`Välj filen ${PLEX_DB}`);
  // Bara en SQLite-fil läses (aldrig något annat som råkar heta .db)
  const fd = fs.openSync(f, 'r');
  try { const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); if (b.toString('latin1') !== 'SQLite format 3\u0000') throw err400('Filen är ingen SQLite-databas'); }
  finally { fs.closeSync(fd); }
  return f;
}

/** Läs alla kontons historik. Returnerar { profiles: [{ key, id, name, kind, records }] } */
export async function readPlexDb(p) {
  const file = resolveDbPath(p);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bxtv-plexdb-'));
  try {
    const tmp = path.join(dir, 'plex.db');
    await fs.promises.copyFile(file, tmp);
    try { await fs.promises.copyFile(file + '-wal', tmp + '-wal'); } catch {} // de senaste ändringarna (Plex kör WAL)
    let db;
    try { db = new DatabaseSync(tmp, { readOnly: true }); db.prepare('SELECT count(*) FROM sqlite_master').get(); }
    catch { try { db?.close(); } catch {} throw err400('Filen kunde inte öppnas som en databas'); }
    try { return readDb(db); } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Läs en öppen Plex-databas (exporteras för tester) */
export function readDb(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(r => r.name));
  const colsOf = (t) => tables.has(t) ? new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map(r => r.name)) : new Set();
  const C = Object.fromEntries(['metadata_items', 'metadata_item_settings', 'metadata_item_views', 'accounts', 'media_items', 'media_parts', 'tags', 'taggings'].map(t => [t, colsOf(t)]));
  const hasAll = (t, ...c) => c.every(x => C[t].has(x));
  if (!hasAll('metadata_items', 'id', 'metadata_type', 'guid') || !(hasAll('metadata_item_settings', 'account_id', 'guid') || hasAll('metadata_item_views', 'account_id', 'guid')))
    throw err400(`Filen är inte Plex biblioteksdatabas (${PLEX_DB})`);
  // Kolumner som saknas i den här versionen blir NULL
  const sel = (t, list) => list.map(([c, a]) => C[t].has(c) ? `"${c}" AS ${a}` : `NULL AS ${a}`).join(', ');
  const q = (sql) => { try { return db.prepare(sql).all(); } catch (e) { throw new Error(`Plex databas kunde inte läsas (${String(e.message).slice(0, 120)})`); } };

  const items = new Map(), byGuid = new Map();
  for (const r of q(`SELECT ${sel('metadata_items', [['id', 'id'], ['metadata_type', 'type'], ['guid', 'guid'], ['title', 'title'], ['original_title', 'orig'], ['year', 'year'],
    ['index', 'idx'], ['parent_id', 'parent'], ['duration', 'dur'], ['originally_available_at', 'avail']])} FROM metadata_items WHERE metadata_type IN (1,2,3,4)`)) {
    items.set(r.id, r);
    if (r.guid) { const a = byGuid.get(r.guid); a ? a.push(r) : byGuid.set(r.guid, [r]); }
  }
  const files = new Map();
  if (hasAll('media_items', 'id', 'metadata_item_id') && hasAll('media_parts', 'media_item_id', 'file'))
    for (const r of q('SELECT mi.metadata_item_id AS id, mp.file AS file FROM media_parts mp JOIN media_items mi ON mi.id = mp.media_item_id WHERE mp.file IS NOT NULL')) {
      const a = files.get(r.id); a ? a.push(r.file) : files.set(r.id, [r.file]);
    }
  // Externa id:n för Plex nya agent (plex://movie/…): taggar med tag_type 314
  const ext = new Map();
  if (hasAll('tags', 'id', 'tag', 'tag_type') && hasAll('taggings', 'metadata_item_id', 'tag_id'))
    for (const r of q('SELECT tg.metadata_item_id AS id, t.tag AS tag FROM taggings tg JOIN tags t ON t.id = tg.tag_id WHERE t.tag_type = 314')) {
      const a = ext.get(r.id); a ? a.push({ id: r.tag }) : ext.set(r.id, [{ id: r.tag }]);
    }
  const idsOf = (row) => row ? plexIds({ Guid: ext.get(row.id) || [], guid: row.guid }) : {};
  const yearOf = (row) => int(row?.year) || int(String(row?.avail || '').slice(0, 4)) || null;
  const pathsOf = (rows) => [...new Set(rows.flatMap(r => files.get(r.id) || []))];
  const showOf = (ep) => {
    const season = items.get(ep.parent);
    const show = season?.type === 3 ? items.get(season.parent) : season?.type === 2 ? season : null;
    return { season, show };
  };
  // Titeln för en guid (null = finns inte längre i Plex bibliotek)
  const cache = new Map();
  const baseOf = (guid) => {
    if (cache.has(guid)) return cache.get(guid);
    const rows = (byGuid.get(guid) || []).filter(r => r.type === 1 || r.type === 4);
    let b = null;
    if (rows.length) {
      const r = rows[0];
      const dur = (+r.dur || 0) / 1000;
      if (r.type === 1) b = { kind: 'movie', title: r.title || '', alt: r.orig && r.orig !== r.title ? [r.orig] : [], year: yearOf(r), ids: idsOf(r), paths: pathsOf(rows), duration: dur };
      else {
        const { season, show } = showOf(r);
        b = { kind: 'episode', title: r.title || '', year: yearOf(r), ids: {}, paths: pathsOf(rows), duration: dur,
          show: { title: show?.title || '', alt: show?.orig && show.orig !== show.title ? [show.orig] : [], year: yearOf(show), ids: idsOf(show) },
          season: season?.type === 3 ? int(season.idx) : null, episode: int(r.idx) };
      }
      b.path = b.paths[0] || null;
    }
    cache.set(guid, b);
    return b;
  };

  const accounts = new Map();
  if (hasAll('accounts', 'id')) for (const r of q(`SELECT ${sel('accounts', [['id', 'id'], ['name', 'name']])} FROM accounts`)) accounts.set(+r.id, r.name || '');
  const per = new Map(); // konto → guid → post
  const recs = (acc) => { let m = per.get(acc); if (!m) per.set(acc, (m = new Map())); return m; };
  if (hasAll('metadata_item_settings', 'account_id', 'guid')) {
    for (const s of q(`SELECT ${sel('metadata_item_settings', [['account_id', 'acc'], ['guid', 'guid'], ['view_count', 'vc'], ['view_offset', 'vo'], ['last_viewed_at', 'lv']])} FROM metadata_item_settings`)) {
      const vc = +s.vc || 0, vo = +s.vo || 0;
      if ((vc <= 0 && vo <= 0) || !s.guid || !(+s.acc > 0)) continue;
      const b = baseOf(s.guid); if (!b) continue;
      recs(+s.acc).set(s.guid, { ...b, watched: vc > 0, position: vo / 1000, updated: plexTime(s.lv), viewCount: vc });
    }
  }
  // Uppspelningarna: senaste tiden, och titlar som saknar inställningsrad (t.ex. borttagna ur Plex bibliotek)
  if (hasAll('metadata_item_views', 'account_id', 'guid')) {
    for (const v of q(`SELECT ${sel('metadata_item_views', [['account_id', 'acc'], ['guid', 'guid'], ['viewed_at', 'at'], ['metadata_type', 'type'], ['title', 'title'],
      ['grandparent_title', 'gtitle'], ['grandparent_guid', 'gguid'], ['parent_index', 'pidx'], ['index', 'idx'], ['originally_available_at', 'avail']])} FROM metadata_item_views`)) {
      if (!v.guid || !(+v.acc > 0)) continue;
      const m = recs(+v.acc), at = plexTime(v.at), cur = m.get(v.guid);
      // Inställningsraden gäller (även "markera som osedd"); uppspelningen ger bara tiden när raden saknar den
      if (cur) { if (at && at > (cur.updated || 0) && (cur.viewCount == null || !cur.updated)) cur.updated = at; continue; }
      let b = baseOf(v.guid);
      if (!b && +v.type === 1) b = { kind: 'movie', title: v.title || '', alt: [], year: yearOf(v), ids: plexIds({ guid: v.guid }), paths: [], path: null, duration: 0 };
      if (!b && +v.type === 4) b = { kind: 'episode', title: v.title || '', year: null, ids: {}, paths: [], path: null, duration: 0,
        show: { title: v.gtitle || '', alt: [], year: null, ids: plexIds({ guid: v.gguid }) }, season: int(v.pidx), episode: int(v.idx) };
      if (b) m.set(v.guid, { ...b, watched: true, position: 0, updated: at });
    }
  }
  const profiles = [];
  for (const [acc, m] of [...per].sort((a, b) => a[0] - b[0])) {
    if (!m.size) continue;
    profiles.push({ key: `plex:${acc}`, id: acc, name: accounts.get(acc) || `Plex-konto ${acc}`, kind: acc === 1 ? 'owner' : 'user',
      records: [...m.values()].map(({ viewCount, ...r }) => r) });
  }
  return { profiles };
}
