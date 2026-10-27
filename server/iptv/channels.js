// Kanaler och guide som tittaren ser: per profil (favoriter, påminnelser) och med barnprofilernas åldersgränser.
// Kanalens åldersgräns: administratörens på kanalen, annars på gruppen, annars 18 om listan/leverantören märkt den som
// vuxeninnehåll (censored/parent-code/is_adult/gruppnamn), annars gruppens automatiska. Okänd ålder = som oklassade
// titlar (inställningen allow_unrated). Vuxenprofiler ser allt som inte är dolt.
import { all, get, run, now, getSetting } from '../db.js';
import { catchupWindow, DEFAULT_DAYS } from './catchup.js';

const allowUnrated = () => getSetting('allow_unrated', '0') === '1';
export const AGE_SQL = `COALESCE(e.age, CASE WHEN g.auto=0 THEN g.age END, CASE WHEN e.adult=1 THEN 18 END, g.age)`;
const JOIN = `FROM channels c JOIN tuners t ON t.id=c.tuner_id LEFT JOIN channel_ext e ON e.channel_id=c.id
  LEFT JOIN iptv_groups g ON g.kind='live' AND g.name=c.group_name`;
/** Får profilen se något med den här åldersgränsen? */
export const ageOk = (u, age) => u.max_age == null || (age == null ? allowUnrated() : age <= u.max_age);
/** Får profilen titta på kanalen? (används även av live-strömmarna i routes/livetv.js) */
export function channelAllowed(u, cid) {
  if (u.max_age == null) return true;
  const r = get(`SELECT ${AGE_SQL} AS age ${JOIN} WHERE c.id=?`, cid);
  return !!r && ageOk(u, r.age);
}
/** Har barnprofilen någon kanal? (menyn visar då Live-TV) */
export const kidsHaveChannels = (u) => u.max_age == null || !!get(`SELECT 1 ${JOIN} WHERE t.enabled=1 AND c.hidden=0 AND COALESCE(g.hidden, 0)=0
  AND (${AGE_SQL} <= ? OR (${AGE_SQL} IS NULL AND ?)) LIMIT 1`, u.max_age, allowUnrated() ? 1 : 0);

// Längsta programmet (nedre gräns för start, så att indexet programs_start används utan att tappa långa program)
let longest = 0, longestAt = 0;
const longestProgram = () => { if (Date.now() - longestAt > 600e3) { longest = Math.min(3 * 86400, get('SELECT COALESCE(MAX(stop - start), 0) AS m FROM programs').m); longestAt = Date.now(); } return longest; };
export const forgetLongest = () => { longestAt = 0; };

/** Synliga kanaler för profilen, med nu/nästa, favoriter och catch-up */
export function channelsFor(u) {
  const T = now();
  const rows = all(`SELECT c.id, c.number, c.name, c.logo, c.group_name, c.hd, c.favorite, c.epg_id, c.tuner_id, t.name AS tuner, e.catchup, e.catchup_days, e.radio,
      ${AGE_SQL} AS age, g.sort AS gsort, (SELECT 1 FROM channel_favorites f WHERE f.user_id=? AND f.channel_id=c.id) AS fav
    ${JOIN} WHERE t.enabled=1 AND c.hidden=0 AND COALESCE(g.hidden, 0)=0 ORDER BY c.favorite DESC, c.sort, c.name`, u.id).filter(r => ageOk(u, r.age));
  const ids = new Set(rows.map(r => r.id));
  const by = new Map();
  for (const p of all('SELECT id, channel_id, start, stop, title, subtitle, category FROM programs WHERE start > ? AND stop > ? AND start < ? ORDER BY start', T - longestProgram() - 1, T, T + 8 * 3600)) {
    if (!ids.has(p.channel_id)) continue;
    const l = by.get(p.channel_id) || by.set(p.channel_id, []).get(p.channel_id);
    if (l.length < 2) l.push(p);
  }
  return rows.map(c => {
    const l = by.get(c.id) || [];
    const cur = l[0] && l[0].start <= T ? l[0] : null, nxt = cur ? l[1] || null : l[0] || null;
    const strip = (p) => p && { id: p.id, start: p.start, stop: p.stop, title: p.title, subtitle: p.subtitle, category: p.category };
    return { id: c.id, number: c.number, name: c.name, logo: !!c.logo, group: c.group_name, hd: !!c.hd, tuner: c.tuner, favorite: !!c.fav, pinned: !!c.favorite,
      epgId: c.epg_id, catchup: c.catchup ? (c.catchup_days || DEFAULT_DAYS) : 0, radio: !!c.radio, now: strip(cur), next: strip(nxt) };
  });
}
/** Grupperna i den ordning de ska visas (administratörens ordning, annars listans) med antal kanaler */
export function groupsOf(list) {
  const order = new Map(all("SELECT name, sort FROM iptv_groups WHERE kind='live' AND sort IS NOT NULL").map(g => [g.name.toLowerCase(), g.sort]));
  const m = new Map();
  list.forEach((c, i) => { const k = c.group || ''; const g = m.get(k) || m.set(k, { name: c.group || null, count: 0, first: i }).get(k); g.count++; });
  return [...m.values()].sort((a, b) => (order.get(String(a.name).toLowerCase()) ?? 1e9) - (order.get(String(b.name).toLowerCase()) ?? 1e9) || a.first - b.first)
    .map(({ name, count }) => ({ name, count }));
}

/** Program i ett tidsfönster för de kanaler profilen får se (TV-guidens rutnät hämtar några kanaler i taget) */
export function epgFor(u, ids, from, to) {
  const ok = new Set(all(`SELECT c.id, ${AGE_SQL} AS age ${JOIN} WHERE c.id IN (${ids.map(() => '?').join(',')}) AND t.enabled=1 AND c.hidden=0`, ...ids)
    .filter(r => ageOk(u, r.age)).map(r => r.id));
  const out = {};
  for (const id of ok) out[id] = [];
  if (!ok.size) return out;
  const list = [...ok];
  const T = now();
  const ch = new Map(all(`SELECT c.id, e.catchup, e.catchup_days, e.catchup_source FROM channels c LEFT JOIN channel_ext e ON e.channel_id=c.id WHERE c.id IN (${list.map(() => '?').join(',')})`, ...list).map(r => [r.id, r]));
  const rem = new Set(all('SELECT channel_id, start FROM iptv_reminders WHERE user_id=? AND start >= ?', u.id, from - 86400).map(r => r.channel_id + ':' + r.start));
  const rows = all(`SELECT id, channel_id, start, stop, title, subtitle, category, season, episode, is_new FROM programs
    WHERE channel_id IN (${list.map(() => '?').join(',')}) AND start > ? AND stop > ? AND start < ? ORDER BY start`, ...list, from - longestProgram() - 1, from, to);
  for (const p of rows) {
    const c = ch.get(p.channel_id);
    out[p.channel_id].push({ id: p.id, start: p.start, stop: p.stop, title: p.title, subtitle: p.subtitle, category: p.category, season: p.season, episode: p.episode,
      isNew: !!p.is_new, catchup: c?.catchup && p.start < T ? catchupWindow(c, p, T) : undefined, reminder: rem.has(p.channel_id + ':' + p.start) || undefined });
  }
  return out;
}

/** Ett program med allt som programrutan behöver; null om profilen inte får se kanalen */
export function programFor(u, pid) {
  const p = get(`SELECT p.*, c.name AS channel_name, c.number AS channel_number, c.logo AS channel_logo, c.hidden, e.catchup, e.catchup_days, e.catchup_source
    FROM programs p JOIN channels c ON c.id=p.channel_id LEFT JOIN channel_ext e ON e.channel_id=c.id WHERE p.id=?`, pid);
  if (!p || !channelAllowed(u, p.channel_id)) return null;
  const T = now();
  let rec = null, rule = null;
  try {
    rec = get("SELECT id, status FROM recordings WHERE channel_id=? AND start=? AND status IN ('scheduled','recording','processing','done')", p.channel_id, p.start) || null;
    rule = get('SELECT id FROM dvr_rules WHERE title=? COLLATE NOCASE', p.title)?.id || null;
  } catch {} // DVR-tabellerna finns inte (tester utan dvr.js)
  return { id: p.id, channelId: p.channel_id, channel: { id: p.channel_id, name: p.channel_name, number: p.channel_number, logo: !!p.channel_logo },
    start: p.start, stop: p.stop, title: p.title, subtitle: p.subtitle, description: p.description, category: p.category, season: p.season, episode: p.episode,
    isNew: !!p.is_new, live: p.start <= T && p.stop > T, catchup: !!p.catchup && catchupWindow(p, p, T),
    reminder: !!get('SELECT 1 FROM iptv_reminders WHERE user_id=? AND channel_id=? AND start=?', u.id, p.channel_id, p.start),
    recording: rec, rule,
    airings: all(`SELECT p.id, p.channel_id, p.start, p.stop, c.name AS channel FROM programs p JOIN channels c ON c.id=p.channel_id
      WHERE p.title=? COLLATE NOCASE AND p.start > ? AND p.id != ? AND c.hidden=0 ORDER BY p.start LIMIT 10`, p.title, T, p.id)
      .filter(a => channelAllowed(u, a.channel_id)).map(({ channel_id, ...a }) => a) };
}

// ---------- favoriter ----------
export function setFavorite(u, cid, on) {
  if (on) run('INSERT OR IGNORE INTO channel_favorites(user_id, channel_id, added) VALUES(?,?,?)', u.id, cid, now());
  else run('DELETE FROM channel_favorites WHERE user_id=? AND channel_id=?', u.id, cid);
}

// ---------- påminnelser ----------
export function addReminder(u, pid) {
  const p = get('SELECT channel_id, start, stop, title FROM programs WHERE id=?', pid);
  if (!p || !channelAllowed(u, p.channel_id)) return null;
  if (p.start <= now()) throw new Error('Programmet har redan börjat');
  if (get('SELECT COUNT(*) AS n FROM iptv_reminders WHERE user_id=? AND start > ?', u.id, now()).n >= 200) throw new Error('Du har för många påminnelser');
  run(`INSERT INTO iptv_reminders(user_id, channel_id, start, stop, title) VALUES(?,?,?,?,?) ON CONFLICT(user_id, channel_id, start) DO UPDATE SET title=excluded.title, stop=excluded.stop, notified=0`,
    u.id, p.channel_id, p.start, p.stop, String(p.title).slice(0, 300));
  return true;
}
export function removeReminder(u, pid) {
  const p = get('SELECT channel_id, start FROM programs WHERE id=?', pid);
  if (p) run('DELETE FROM iptv_reminders WHERE user_id=? AND channel_id=? AND start=?', u.id, p.channel_id, p.start);
}
/** Kommande påminnelser (due: de som börjar inom två minuter eller nyss börjat och inte visats i webben) */
export function reminders(u, { due = false } = {}) {
  const T = now();
  const rows = all(`SELECT r.channel_id, r.start, r.stop, r.title, c.name AS channel, c.number,
      (SELECT p.id FROM programs p WHERE p.channel_id=r.channel_id AND p.start=r.start) AS pid
    FROM iptv_reminders r JOIN channels c ON c.id=r.channel_id WHERE r.user_id=? AND ${due ? 'r.start <= ? AND r.start > ?' : 'COALESCE(r.stop, r.start) > ?'} ORDER BY r.start LIMIT 200`,
  ...(due ? [u.id, T + 120, T - 600] : [u.id, T]));
  return rows.filter(r => channelAllowed(u, r.channel_id)).map(r => ({ channelId: r.channel_id, programId: r.pid, start: r.start, stop: r.stop, title: r.title, channel: r.channel, number: r.number }));
}
/** Påminnelser som ska skickas som personlig notis (en gång). send(uid, title, message) */
export async function sendDue(send) {
  const T = now();
  const due = all('SELECT r.user_id, r.channel_id, r.start, r.title, c.name AS channel FROM iptv_reminders r JOIN channels c ON c.id=r.channel_id WHERE r.notified=0 AND r.start <= ? AND r.start > ?', T + 120, T - 600);
  for (const r of due) {
    run('UPDATE iptv_reminders SET notified=1 WHERE user_id=? AND channel_id=? AND start=?', r.user_id, r.channel_id, r.start);
    const mins = Math.max(0, Math.round((r.start - T) / 60));
    try { await send(r.user_id, `${r.title} börjar ${mins ? `om ${mins} min` : 'nu'}`, `${r.channel} · ${new Date(r.start * 1000).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`); } catch {}
  }
  run('DELETE FROM iptv_reminders WHERE COALESCE(stop, start) < ?', T - 86400);
  return due.length;
}
