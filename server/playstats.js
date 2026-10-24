// Tittarstatistik som Tautulli: historik över alla uppspelningar (tabellen plays, fylls av activity.js) med filter,
// topplistor, fördelning per dag/veckodag/timme, samtidiga strömmar och bandbredd över tid samt export till CSV.
// Administratören ser alla profiler; övriga (även barnprofiler) bara sin egen historik (viewer i filters()).
// Historiken sparas history_days dagar (standard 365, 0 = för alltid) och gallras en gång per dygn.
import { get, all, run, now, getSetting } from './db.js';
import { searchKey } from './searchkey.js';

export const DEFAULT_DAYS = 365;
export const keepDays = () => { const n = parseInt(getSetting('history_days', process.env.HISTORY_DAYS || String(DEFAULT_DAYS))); return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAYS; };

// Titeln i historiken: biblioteket om titeln finns kvar, annars kopian i raden
const TITLE = `COALESCE(i.title, p.title, '?')`, SHOW = `COALESCE(s.title, p.show_title)`, KIND = `COALESCE(i.kind, p.kind)`;
const FULL = `CASE WHEN ${KIND}='episode' THEN COALESCE(${SHOW}, '?') || ' – S' || printf('%02d', COALESCE(i.season, p.season, 0)) || 'E' || printf('%02d', COALESCE(i.episode, p.episode, 0)) || ' ' || ${TITLE} ELSE ${TITLE} END`;
const FROM = `FROM plays p LEFT JOIN items i ON i.id=p.item_id LEFT JOIN items s ON s.id=COALESCE(i.parent_id, p.show_id)
  LEFT JOIN users u ON u.id=p.user_id LEFT JOIN libraries l ON l.id=COALESCE(i.library_id, p.library_id)`;
const END = `COALESCE(p.ended, p.ts)`;

/** Lokal midnatt för 'YYYY-MM-DD' (serverns tidszon) i sekunder, eller null */
function day(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
/**
 * Filter ur frågesträngen: user, library, kind (movie|episode), mode (direct|remux|transcode), remote (0|1), item (titel eller
 * serie), q (sökning i titel/serie/profil/enhet), days (senaste N dagar) eller from/to (YYYY-MM-DD, to tas med).
 * viewer = den som frågar. Bara everyone (administratörens routes) ger alla profilers rader – annars bara de egna.
 */
export function filters(q, viewer, { everyone = false, at = now() } = {}) {
  const g = (k) => (typeof q.get === 'function' ? q.get(k) : q[k]) ?? '';
  const w = [], p = [];
  const admin = everyone && !!viewer?.is_admin && viewer.max_age == null;
  const uid = admin ? parseInt(g('user')) || null : viewer.id;
  if (uid) { w.push('p.user_id=?'); p.push(uid); }
  const lib = parseInt(g('library')); if (lib) { w.push('COALESCE(i.library_id, p.library_id)=?'); p.push(lib); }
  const kind = g('kind'); if (['movie', 'episode'].includes(kind)) { w.push(`${KIND}=?`); p.push(kind); }
  const mode = g('mode'); if (['direct', 'remux', 'transcode'].includes(mode)) { w.push('p.mode=?'); p.push(mode); }
  const remote = g('remote'); if (remote === '0' || remote === '1') { w.push('COALESCE(p.remote,0)=?'); p.push(+remote); }
  const item = parseInt(g('item')); if (item) { w.push('(p.item_id=? OR p.show_id=? OR i.parent_id=?)'); p.push(item, item, item); }
  let from = day(g('from')), to = day(g('to'));
  const days = parseInt(g('days'));
  if (from == null && to == null && days > 0) from = at - days * 86400;
  if (from != null) { w.push('p.ts>=?'); p.push(from); }
  if (to != null) { w.push('p.ts<?'); p.push(to + 86400); }
  const text = String(g('q')).trim().slice(0, 100);
  if (text) {
    // Söker i titel, serie, profil och enhet (skiftlägesokänsligt, även å/ä/ö via söknyckeln)
    const k = '%' + searchKey(text).replace(/[\\%_]/g, '\\$&') + '%', raw = '%' + text.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%';
    w.push(`(COALESCE(i.skey,'') LIKE ? ESCAPE '\\' OR COALESCE(s.skey,'') LIKE ? ESCAPE '\\' OR lower(${TITLE}) LIKE ? ESCAPE '\\' OR lower(COALESCE(${SHOW},'')) LIKE ? ESCAPE '\\'`
      + (admin ? ` OR lower(COALESCE(u.name,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(p.device,'')) LIKE ? ESCAPE '\\')` : ')'));
    p.push(k, k, raw, raw, ...(admin ? [raw, raw] : []));
  }
  return { sql: w.length ? ' WHERE ' + w.join(' AND ') : '', params: p, admin, from, to: to != null ? to + 86400 : null };
}

const SORTS = { ts: 'p.ts', title: 'full', user: 'u.name', played: 'p.played', device: 'p.device' };
function rowOut(r, admin) {
  const out = {
    id: r.id, ts: r.ts, ended: r.ended || r.ts, itemId: r.item_id, showId: r.show_id || null, title: r.full, kind: r.kind, year: r.year || null,
    library: r.library || null, device: r.device || null, remote: !!r.remote, mode: r.mode || null, quality: r.quality || null, kbps: r.kbps || null,
    played: Math.round(r.played || 0), duration: r.duration ? Math.round(r.duration) : null, position: r.pos_end != null ? Math.round(r.pos_end) : null,
    percent: r.duration && r.pos_end != null ? Math.min(100, Math.round(r.pos_end / r.duration * 100)) : null, exists: !!r.exists_
  };
  if (admin) Object.assign(out, { userId: r.user_id, user: r.user || '?', ip: r.ip || null });
  return out;
}
const SELECT = `SELECT p.id, p.ts, p.ended, p.item_id, COALESCE(i.parent_id, p.show_id) AS show_id, ${FULL} AS full, ${KIND} AS kind, COALESCE(i.year, s.year, p.year) AS year,
  l.name AS library, p.device, p.remote, p.mode, p.quality, p.kbps, p.played, COALESCE(p.duration, i.duration) AS duration, p.pos_end, p.user_id, u.name AS user, p.ip,
  i.id IS NOT NULL AS exists_`;
/** Historiken (sida för sida). sort: ts|title|user|played|device, dir: asc|desc */
export function history(f, { limit = 50, offset = 0, sort = 'ts', dir = 'desc' } = {}) {
  const ord = SORTS[sort] || 'p.ts';
  const rows = all(`${SELECT} ${FROM}${f.sql} ORDER BY ${ord} ${dir === 'asc' ? 'ASC' : 'DESC'}, p.id DESC LIMIT ? OFFSET ?`,
    ...f.params, Math.max(1, Math.min(500, +limit || 50)), Math.max(0, +offset || 0));
  const total = get(`SELECT COUNT(*) AS n, COALESCE(SUM(p.played),0) AS played ${FROM}${f.sql}`, ...f.params);
  return { rows: rows.map(r => rowOut(r, f.admin)), total: total.n, played: Math.round(total.played) };
}

/** Sammanfattning, topplistor och fördelningar för samma filter */
export function overview(f) {
  const W = f.sql, P = f.params;
  const totals = get(`SELECT COUNT(*) AS plays, COALESCE(SUM(p.played),0) AS played, COUNT(DISTINCT p.user_id) AS users,
    COUNT(DISTINCT COALESCE(i.parent_id, p.show_id, p.item_id)) AS titles, COALESCE(SUM(p.remote),0) AS remote,
    COALESCE(SUM(p.mode='transcode'),0) AS transcodes ${FROM}${W}`, ...P);
  const top = all(`SELECT COALESCE(i.parent_id, p.show_id, p.item_id) AS id, CASE WHEN ${KIND}='episode' THEN COALESCE(${SHOW}, '?') ELSE ${TITLE} END AS title,
    MAX(${KIND}='episode') AS series, COUNT(*) AS plays, COUNT(DISTINCT p.user_id) AS viewers, COALESCE(SUM(p.played),0) AS played
    ${FROM}${W} GROUP BY COALESCE(i.parent_id, p.show_id, p.item_id) ORDER BY plays DESC, played DESC LIMIT 10`, ...P)
    .map(r => ({ ...r, series: !!r.series, played: Math.round(r.played) }));
  const users = f.admin ? all(`SELECT p.user_id AS id, COALESCE(u.name, '?') AS name, COUNT(*) AS plays, COALESCE(SUM(p.played),0) AS played, MAX(p.ts) AS last
    ${FROM}${W} GROUP BY p.user_id ORDER BY played DESC, plays DESC LIMIT 20`, ...P).map(r => ({ ...r, played: Math.round(r.played) })) : [];
  const group = (col) => all(`SELECT ${col} AS k, COUNT(*) AS n, COALESCE(SUM(p.played),0) AS played ${FROM}${W} GROUP BY k ORDER BY n DESC LIMIT 20`, ...P)
    .map(r => ({ key: r.k ?? '', n: r.n, played: Math.round(r.played) }));
  const platforms = group(`COALESCE(p.device, '?')`), modes = group(`COALESCE(p.mode, '?')`), libraries = group(`COALESCE(l.name, '?')`);
  const location = group(`CASE WHEN p.remote=1 THEN 'remote' ELSE 'local' END`);
  const byDay = all(`SELECT date(p.ts, 'unixepoch', 'localtime') AS d, COUNT(*) AS n, COALESCE(SUM(p.played),0) AS played ${FROM}${W} GROUP BY d ORDER BY d`, ...P)
    .map(r => ({ day: r.d, n: r.n, played: Math.round(r.played) }));
  const weekday = Array.from({ length: 7 }, (_, i) => ({ key: i, n: 0, played: 0 })), hour = Array.from({ length: 24 }, (_, i) => ({ key: i, n: 0, played: 0 }));
  for (const r of all(`SELECT CAST(strftime('%w', p.ts, 'unixepoch', 'localtime') AS INTEGER) AS k, COUNT(*) AS n, COALESCE(SUM(p.played),0) AS played ${FROM}${W} GROUP BY k`, ...P))
    Object.assign(weekday[r.k], { n: r.n, played: Math.round(r.played) });
  for (const r of all(`SELECT CAST(strftime('%H', p.ts, 'unixepoch', 'localtime') AS INTEGER) AS k, COUNT(*) AS n, COALESCE(SUM(p.played),0) AS played ${FROM}${W} GROUP BY k`, ...P))
    Object.assign(hour[r.k], { n: r.n, played: Math.round(r.played) });
  // Måndag först (svensk vecka)
  const week = [...weekday.slice(1), weekday[0]];
  return { totals: { ...totals, played: Math.round(totals.played) }, top, users, platforms, modes, libraries, location, byDay, weekday: week, hour };
}

/**
 * Samtidiga strömmar och bandbredd över tid: perioden delas i fack (timme upp till 3 dygn, annars dygn). peak = flest
 * strömmar samtidigt i facket, kbps = genomsnittlig bandbredd (uppskattad bithastighet × tid), peakKbps = högsta samtidiga.
 */
export function concurrency(f, at = now()) {
  const rows = all(`SELECT p.ts, ${END} AS ended, COALESCE(p.kbps, 0) AS kbps ${FROM}${f.sql} ORDER BY p.ts LIMIT 100000`, ...f.params);
  const start0 = f.from ?? (rows[0]?.ts ?? at - 7 * 86400), end0 = Math.min(f.to ?? at, at);
  const span = Math.max(3600, end0 - start0);
  const step = span <= 3 * 86400 ? 3600 : 86400;
  const align = (t) => step === 3600 ? Math.floor(t / 3600) * 3600 : (() => { const d = new Date(t * 1000); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); })();
  const first = align(start0), buckets = [];
  for (let t = first; t < end0 && buckets.length < 400; t = step === 3600 ? t + 3600 : align(t + 86400 + 7200)) buckets.push({ t, peak: 0, kbps: 0, peakKbps: 0, n: 0 });
  if (!buckets.length) return { step, buckets: [] };
  // Händelser (start +1, slut −1) i tidsordning → flest samtidiga per fack
  const ev = [];
  for (const r of rows) { const e = Math.max(r.ended, r.ts + 60); ev.push([r.ts, 1, r.kbps], [e, -1, r.kbps]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const bucketOf = (t) => { let lo = 0, hi = buckets.length - 1; if (t < buckets[0].t) return -1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (buckets[m].t <= t) lo = m; else hi = m - 1; } return lo; };
  let cur = 0, curK = 0, i = 0;
  for (let b = 0; b < buckets.length; b++) {
    const B = buckets[b], bEnd = buckets[b + 1]?.t ?? end0;
    // Det som pågår när facket börjar
    while (i < ev.length && ev[i][0] <= B.t) { cur += ev[i][1]; curK += ev[i][1] * ev[i][2]; i++; }
    B.peak = cur; B.peakKbps = curK;
    while (i < ev.length && ev[i][0] < bEnd) { cur += ev[i][1]; curK += ev[i][1] * ev[i][2]; i++; B.peak = Math.max(B.peak, cur); B.peakKbps = Math.max(B.peakKbps, curK); }
  }
  // Genomsnittlig bandbredd: varje uppspelnings bithastighet × tiden den överlappar facket
  for (const r of rows) {
    const e = Math.max(r.ended, r.ts + 60);
    for (let b = Math.max(0, bucketOf(r.ts)); b < buckets.length && buckets[b].t < e; b++) {
      const bEnd = buckets[b + 1]?.t ?? end0;
      const ov = Math.min(e, bEnd) - Math.max(r.ts, buckets[b].t);
      if (ov > 0) { buckets[b].kbps += r.kbps * ov / Math.max(1, bEnd - buckets[b].t); if (r.ts >= buckets[b].t) buckets[b].n++; }
    }
  }
  for (const B of buckets) B.kbps = Math.round(B.kbps);
  return { step, buckets };
}

// ---------- CSV ----------
// Semikolon och BOM: öppnas rätt i svenska Excel/Numbers/LibreOffice. Celler som börjar med = + - @ får en apostrof
// (annars kan en titel som "=HYPERLINK(...)" köras som formel i kalkylbladet).
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const iso = (t) => { if (!t) return ''; const d = new Date(t * 1000), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const MODE = { direct: 'Direkt', remux: 'Remux', transcode: 'Omkodning' };
export function csv(f) {
  const rows = all(`${SELECT} ${FROM}${f.sql} ORDER BY p.ts DESC LIMIT 200000`, ...f.params).map(r => rowOut(r, f.admin));
  const head = ['Start', 'Slut', ...(f.admin ? ['Profil'] : []), 'Titel', 'Typ', 'År', 'Bibliotek', 'Sett (min)', 'Position (min)', 'Längd (min)', 'Procent',
    'Enhet', ...(f.admin ? ['IP'] : []), 'Plats', 'Uppspelning', 'Kvalitet', 'Bithastighet (kbit/s)'];
  const min = (s) => s == null ? '' : (s / 60).toFixed(1).replace('.', ',');
  const lines = rows.map(r => [iso(r.ts), iso(r.ended), ...(f.admin ? [r.user] : []), r.title, r.kind === 'episode' ? 'Avsnitt' : r.kind === 'movie' ? 'Film' : r.kind || '',
    r.year || '', r.library || '', min(r.played), min(r.position), min(r.duration), r.percent ?? '', r.device || '', ...(f.admin ? [r.ip || ''] : []),
    r.remote ? 'Utifrån' : 'Hemma', MODE[r.mode] || r.mode || '', r.quality && r.quality !== 'orig' ? r.quality + 'p' : r.quality === 'orig' ? 'Original' : '', r.kbps || ''].map(cell).join(';'));
  return '﻿' + [head.map(cell).join(';'), ...lines].join('\r\n') + '\r\n';
}

/** Ta bort en rad: egna rader, eller alla rader (everyone, administratörens route). Returnerar true om något togs bort. */
export function removeRow(id, viewer, everyone = false) {
  const admin = everyone && !!viewer?.is_admin;
  return Number((admin ? run('DELETE FROM plays WHERE id=?', +id) : run('DELETE FROM plays WHERE id=? AND user_id=?', +id, viewer.id)).changes) > 0;
}

/** Gallra historik äldre än inställningen (0 = spara för alltid) */
export function prune(at = now()) {
  const days = keepDays();
  if (!days) return 0;
  return Number(run('DELETE FROM plays WHERE ts < ?', at - days * 86400).changes);
}
setTimeout(() => { try { prune(); } catch {} }, 60e3).unref();
setInterval(() => { try { const n = prune(); if (n) console.log(`[historik] gallrade ${n} rader äldre än ${keepDays()} dagar`); } catch (e) { console.warn('[historik]', e.message); } }, 86400e3).unref();
