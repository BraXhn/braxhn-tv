// Kanalhantering för administratören: byta namn, nummer, grupp och logotyp, dölja, åldersgräns, guide-id och ordning,
// samt grupper (dölj, åldersgräns, ordning) och gemensamma TV-guider. Ändringarna sparas i channel_ext (*_o) och skrivs
// på channels direkt – och efter varje uppdatering av listan igen (sources.js afterSync).
import { all, get, run, tx } from '../db.js';
import { AGE_SQL } from './channels.js';
import { applyOverrides, applyGroupHidden, altKey } from './sources.js';
import { maskUrl } from './net.js';

const age = (v) => v === null || v === '' ? null : Math.max(0, Math.min(18, parseInt(v, 10) || 0));

export function channels({ q = '', group = null, tuner = null, offset = 0, limit = 200 } = {}) {
  const where = ["t.kind='m3u'"], p = [];
  if (q) { where.push('(c.name LIKE ? ESCAPE \'\\\' OR c.number = ? OR e.orig_name LIKE ? ESCAPE \'\\\')'); const l = '%' + String(q).replace(/[\\%_]/g, '\\$&') + '%'; p.push(l, String(q), l); }
  if (group != null) { where.push('c.group_name IS ?'); p.push(group || null); }
  if (tuner) { where.push('c.tuner_id=?'); p.push(+tuner); }
  const W = where.join(' AND ');
  const FROM = `FROM channels c JOIN tuners t ON t.id=c.tuner_id LEFT JOIN channel_ext e ON e.channel_id=c.id LEFT JOIN iptv_groups g ON g.kind='live' AND g.name=c.group_name`;
  const rows = all(`SELECT c.id, c.tuner_id, t.name AS tuner, c.number, c.name, c.logo, c.group_name, c.hidden, c.epg_id, c.sort, e.ghidden, e.age, e.catchup, e.catchup_days,
      e.orig_name, e.orig_number, e.orig_group, e.name_o, e.number_o, e.group_o, e.logo_o, e.sort_o, ${AGE_SQL} AS eff_age,
      (SELECT COUNT(*) FROM programs pr WHERE pr.channel_id=c.id) AS programs
    ${FROM} WHERE ${W} ORDER BY c.favorite DESC, c.sort, c.name LIMIT ? OFFSET ?`, ...p, Math.min(500, limit | 0 || 200), Math.max(0, offset | 0));
  return { total: get(`SELECT COUNT(*) AS n ${FROM} WHERE ${W}`, ...p).n, channels: rows.map(r => ({ id: r.id, tuner: r.tuner, tunerId: r.tuner_id, number: r.number, name: r.name,
    logo: !!r.logo, logoUrl: r.logo_o ? maskUrl(r.logo_o) : null, group: r.group_name, hidden: !!r.hidden && !r.ghidden, groupHidden: !!r.ghidden, epgId: r.epg_id, age: r.age, effectiveAge: r.eff_age,
    catchup: r.catchup ? r.catchup_days || null : 0, programs: r.programs,
    original: { name: r.orig_name ?? r.name, number: r.orig_number ?? r.number, group: r.orig_group ?? r.group_name },
    changed: { name: r.name_o != null, number: r.number_o != null, group: r.group_o != null, logo: r.logo_o != null, sort: r.sort_o != null } })) };
}

const ensureExt = (c) => run(`INSERT INTO channel_ext(channel_id, orig_name, orig_number, orig_group, orig_logo, alt_key) VALUES(?,?,?,?,?,?)
  ON CONFLICT(channel_id) DO UPDATE SET orig_name=COALESCE(orig_name, excluded.orig_name), orig_number=CASE WHEN number_o IS NULL THEN excluded.orig_number ELSE orig_number END,
  orig_group=CASE WHEN group_o IS NULL THEN excluded.orig_group ELSE orig_group END, orig_logo=CASE WHEN logo_o IS NULL THEN excluded.orig_logo ELSE orig_logo END`,
c.id, c.name, c.number, c.group_name, c.logo, altKey(c.epg_id, c.name));

/** Ändra en kanal. Tomt namn/samma som listan = ta bort ändringen. number/group '' = inget nummer/ingen grupp. */
export function updateChannel(cid, b) {
  const c = get('SELECT * FROM channels WHERE id=?', cid);
  if (!c) throw Object.assign(new Error('Kanalen finns inte'), { status: 404 });
  tx(() => {
    ensureExt(c);
    const e = get('SELECT * FROM channel_ext WHERE channel_id=?', cid);
    const set = (col, orig, chCol, v, norm = (x) => x) => {
      if (v === undefined) return;
      const val = v === null ? null : norm(String(v).trim());
      const same = val === null || (val === (orig ?? '') && col !== 'logo_o');
      run(`UPDATE channel_ext SET ${col}=? WHERE channel_id=?`, same ? null : val, cid);
      if (same) run(`UPDATE channels SET ${chCol}=? WHERE id=?`, orig ?? null, cid);
    };
    if (typeof b.name === 'string') { const v = b.name.trim().slice(0, 120); set('name_o', e.orig_name ?? c.name, 'name', v || null); }
    if (b.number !== undefined) {
      set('number_o', e.orig_number ?? c.number, 'number', b.number === null ? null : String(b.number).slice(0, 12));
      // Kanalnumret styr ordningen (om ingen egen ordning angetts samtidigt)
      if (b.sort === undefined) { const n = parseFloat(b.number); run('UPDATE channel_ext SET sort_o=? WHERE channel_id=?', b.number !== null && String(b.number).trim() && Number.isFinite(n) ? n : null, cid); if (!(Number.isFinite(n))) run('UPDATE channels SET sort=COALESCE(?, sort) WHERE id=?', parseFloat(e.orig_number) || null, cid); }
    }
    if (b.group !== undefined) set('group_o', e.orig_group ?? c.group_name, 'group_name', b.group === null ? null : String(b.group).slice(0, 120));
    if (b.logo !== undefined) {
      const v = b.logo ? String(b.logo).trim() : '';
      if (v && !/^https?:\/\/\S{3,1990}$/.test(v)) throw new Error('Logotypen ska vara en http(s)-adress');
      run('UPDATE channel_ext SET logo_o=? WHERE channel_id=?', v || null, cid);
      if (!v) run('UPDATE channels SET logo=? WHERE id=?', e.orig_logo ?? c.logo, cid);
    }
    if (b.sort !== undefined) run('UPDATE channel_ext SET sort_o=? WHERE channel_id=?', b.sort === null ? null : +b.sort || null, cid);
    if (b.age !== undefined) run('UPDATE channel_ext SET age=? WHERE channel_id=?', age(b.age), cid);
    if (b.hidden != null) { run('UPDATE channels SET hidden=? WHERE id=?', b.hidden ? 1 : 0, cid); run('UPDATE channel_ext SET ghidden=0 WHERE channel_id=?', cid); }
    if (typeof b.epgId === 'string') {
      const v = b.epgId.trim().slice(0, 200) || null;
      run('UPDATE channels SET epg_id=? WHERE id=?', v, cid);
      run('UPDATE channel_ext SET alt_key=? WHERE channel_id=?', altKey(v, e.orig_name ?? c.name), cid);
    }
    applyOverrides(c.tuner_id);
  });
  if (b.group !== undefined) applyGroupHidden();
}
/** Egen ordning: ids i den ordning de ska visas (övriga behåller listans) */
export function reorder(ids) {
  tx(() => ids.slice(0, 20000).forEach((id, i) => {
    const c = get('SELECT * FROM channels WHERE id=?', +id); if (!c) return;
    ensureExt(c);
    run('UPDATE channel_ext SET sort_o=? WHERE channel_id=?', i + 1, c.id);
    run('UPDATE channels SET sort=? WHERE id=?', i + 1, c.id);
  }));
}
export function resetOrder(tunerId = null) {
  tx(() => {
    run(`UPDATE channel_ext SET sort_o=NULL WHERE channel_id IN (SELECT id FROM channels WHERE ${tunerId ? 'tuner_id=?' : '1'})`, ...(tunerId ? [tunerId] : []));
  });
}

// ---------- grupper ----------
export function groups(kind = 'live') {
  if (kind === 'live') {
    return all(`SELECT c.group_name AS name, COUNT(*) AS count, SUM(c.hidden) AS hidden, g.hidden AS ghidden, g.age, g.auto, g.sort FROM channels c JOIN tuners t ON t.id=c.tuner_id
      LEFT JOIN iptv_groups g ON g.kind='live' AND g.name=c.group_name WHERE t.kind='m3u' GROUP BY c.group_name COLLATE NOCASE ORDER BY COALESCE(g.sort, 1e9), MIN(c.sort), c.group_name`)
      .map(r => ({ name: r.name, count: r.count, hidden: !!r.ghidden, age: r.age ?? null, auto: !!r.auto, sort: r.sort }));
  }
  return all(`SELECT v.category AS name, COUNT(*) AS count, g.hidden AS ghidden, g.age, g.auto, g.sort FROM iptv_vod v LEFT JOIN iptv_groups g ON g.kind=v.kind AND g.name=v.category
    WHERE v.kind=? GROUP BY v.category COLLATE NOCASE ORDER BY COALESCE(g.sort, 1e9), v.category`, kind)
    .map(r => ({ name: r.name, count: r.count, hidden: !!r.ghidden, age: r.age ?? null, auto: !!r.auto, sort: r.sort }));
}
export function setGroup(kind, name, b) {
  if (!['live', 'movie', 'series'].includes(kind)) throw new Error('Okänd sorts grupp');
  name = String(name ?? '').slice(0, 120);
  if (!name) throw new Error('Grupper utan namn kan inte ändras – ge kanalerna en grupp först');
  run("INSERT OR IGNORE INTO iptv_groups(kind, name) VALUES(?, ?)", kind, name);
  if (b.hidden != null) run('UPDATE iptv_groups SET hidden=? WHERE kind=? AND name=?', b.hidden ? 1 : 0, kind, name);
  if (b.age !== undefined) run('UPDATE iptv_groups SET age=?, auto=0 WHERE kind=? AND name=?', age(b.age), kind, name);
  if (b.sort !== undefined) run('UPDATE iptv_groups SET sort=? WHERE kind=? AND name=?', b.sort === null ? null : +b.sort, kind, name);
  if (kind === 'live') applyGroupHidden();
}
export function orderGroups(kind, names) {
  tx(() => names.slice(0, 2000).forEach((n, i) => { if (!n) return; run("INSERT OR IGNORE INTO iptv_groups(kind, name) VALUES(?, ?)", kind, String(n).slice(0, 120)); run('UPDATE iptv_groups SET sort=? WHERE kind=? AND name=?', i + 1, kind, String(n).slice(0, 120)); }));
}

// ---------- gemensamma guider ----------
const guideUrl = (u) => { u = String(u || '').trim(); if (!/^(https?:\/\/|\/config\/)/.test(u)) throw new Error('TV-guiden ska vara en http(s)-adress eller en fil under /config'); return u; };
export const guides = () => all('SELECT * FROM iptv_guides ORDER BY COALESCE(sort, id), id').map(g => ({ id: g.id, name: g.name, url: maskUrl(g.url), enabled: !!g.enabled,
  shift: g.shift, lastRefresh: g.last_refresh, error: g.error, channels: g.channels, programs: g.programs }));
export function addGuide(b) {
  if (get('SELECT COUNT(*) AS n FROM iptv_guides').n >= 20) throw new Error('Högst 20 guider');
  const url = guideUrl(b.url);
  return Number(run('INSERT INTO iptv_guides(name, url, shift, sort) VALUES(?,?,?,?)', String(b.name || '').trim().slice(0, 60) || new URL(url, 'file:///').hostname || 'Guide', url,
    Math.max(-24, Math.min(24, parseFloat(b.shift) || 0)), (get('SELECT MAX(COALESCE(sort, id)) AS m FROM iptv_guides').m || 0) + 1).lastInsertRowid);
}
export function updateGuide(id, b) {
  if (!get('SELECT 1 FROM iptv_guides WHERE id=?', id)) throw Object.assign(new Error('Finns inte'), { status: 404 });
  if (typeof b.name === 'string' && b.name.trim()) run('UPDATE iptv_guides SET name=? WHERE id=?', b.name.trim().slice(0, 60), id);
  if (typeof b.url === 'string' && b.url.trim()) run('UPDATE iptv_guides SET url=? WHERE id=?', guideUrl(b.url), id);
  if (b.enabled != null) run('UPDATE iptv_guides SET enabled=? WHERE id=?', b.enabled ? 1 : 0, id);
  if (b.shift != null) run('UPDATE iptv_guides SET shift=? WHERE id=?', Math.max(-24, Math.min(24, parseFloat(b.shift) || 0)), id);
  if (b.sort != null) run('UPDATE iptv_guides SET sort=? WHERE id=?', +b.sort || null, id);
}
export const removeGuide = (id) => run('DELETE FROM iptv_guides WHERE id=?', id);
