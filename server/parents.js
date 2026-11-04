// Föräldraöversikt: vad barnprofilerna i hushållet har tittat och lyssnat på, hur länge per dag, vad som spelas
// just nu och dagens skärmtid. Bygger på samma data som Min historik (plays), ljudböckernas lyssning (book_listen)
// och skärmtiden (screentime.js) – inga nya tabeller. Bara huvudkontot ser översikten, och bara för barnprofiler
// (profiler med åldersgräns) i det egna hushållet: vuxna profiler i hushållet syns aldrig här.
import { get, all, now } from './db.js';
import * as screen from './screentime.js';
import * as act from './activity.js';

/** Kvällstittande räknas från det här klockslaget (lokal tid) till 05:59 */
export const LATE_HOUR = 21;
export const PERIODS = [7, 30];
const MAX_ROWS = 5000; // tak för en period (ett barn hinner inte fler uppspelningar på 30 dagar)

/** Barnprofilerna som användaren får se: profiler med åldersgräns under huvudkontot. Tom lista för alla andra. */
export function kidsOf(viewer) {
  if (!viewer || viewer.parent_id != null || viewer.max_age != null) return [];
  return all('SELECT id, name, max_age, color FROM users WHERE parent_id=? AND max_age IS NOT NULL ORDER BY name', viewer.id);
}
/** En barnprofil som användaren får se, annars null */
export const kidOf = (viewer, id) => kidsOf(viewer).find(k => k.id === +id) || null;

const isLate = (ts) => { const h = new Date(ts * 1000).getHours(); return h >= LATE_HOUR || h < 6; };
const titleOf = (r) => r.kind === 'episode' && r.show_title
  ? `${r.show_title} – S${String(r.season ?? 0).padStart(2, '0')}E${String(r.episode ?? 0).padStart(2, '0')}${r.title ? ' ' + r.title : ''}` : (r.title || '?');

/** Uppspelningar (film, serie) från tidpunkten from (sekunder), nyaste först. Titeln tas från plays om titeln tagits bort. */
function playsSince(uid, from, to) {
  return all(`SELECT p.id, p.ts, p.ended, p.item_id, p.played, p.device, p.remote, p.duration, p.pos_end,
      COALESCE(i.kind, p.kind) AS kind, COALESCE(i.title, p.title) AS title, COALESCE(i.season, p.season) AS season,
      COALESCE(i.episode, p.episode) AS episode, COALESCE(s.title, p.show_title) AS show_title,
      COALESCE(i.parent_id, p.show_id) AS show_id, i.id IS NOT NULL AS exists_
    FROM plays p LEFT JOIN items i ON i.id=p.item_id LEFT JOIN items s ON s.id=COALESCE(i.parent_id, p.show_id)
    WHERE p.user_id=? AND p.ts>=? AND p.ts<? ORDER BY p.ts DESC LIMIT ${MAX_ROWS}`, uid, from, to);
}
/** Lyssning på ljudböcker per dag och bok (book_listen har bara dagar, inga klockslag) */
const listensSince = (uid, fromDay) => all(`SELECT l.day, l.book_id, l.seconds, b.title FROM book_listen l JOIN books b ON b.id=l.book_id
  WHERE l.user_id=? AND l.day>=?`, uid, fromDay);

/** Pågående uppspelningar för profilen (Spelas nu) */
export function nowPlaying(uid) {
  return act.listActive().filter(s => s.userId === uid).map(s => ({
    key: s.key, itemId: s.itemId, title: s.title, device: s.device || null, remote: !!s.remote, paused: !!s.paused,
    position: Math.round(s.position || 0), duration: s.duration ? Math.round(s.duration) : null, started: s.started }));
}

/** Kort sammanfattning per barn för översiktens första vy */
export function summary(kid, at = now()) {
  const day = screen.localDay(new Date(at * 1000));
  const start = Math.floor(new Date(`${day}T00:00:00`).getTime() / 1000);
  const plays = playsSince(kid.id, start, start + 86400 + 3600);
  const last = plays[0] || get(`SELECT p.ts, COALESCE(i.kind, p.kind) AS kind, COALESCE(i.title, p.title) AS title, COALESCE(i.season, p.season) AS season,
      COALESCE(i.episode, p.episode) AS episode, COALESCE(s.title, p.show_title) AS show_title
    FROM plays p LEFT JOIN items i ON i.id=p.item_id LEFT JOIN items s ON s.id=COALESCE(i.parent_id, p.show_id) WHERE p.user_id=? ORDER BY p.ts DESC LIMIT 1`, kid.id);
  return {
    id: kid.id, name: kid.name, maxAge: kid.max_age, color: kid.color || null,
    today: {
      video: Math.round(plays.reduce((n, p) => n + (p.played || 0), 0)),
      audio: Math.round(listensSince(kid.id, day).reduce((n, l) => n + l.seconds, 0)),
      titles: new Set(plays.map(p => p.show_id || p.item_id)).size
    },
    screen: screen.status(kid.id, new Date(at * 1000)),
    now: nowPlaying(kid.id),
    last: last ? { title: titleOf(last), ts: last.ts } : null
  };
}

/** Allt om ett barn för en period (7 eller 30 dagar, i dag inräknad) */
export function detail(kid, days = 7, at = now()) {
  days = PERIODS.includes(+days) ? +days : 7;
  const today = new Date(at * 1000);
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(screen.localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 12)));
  const from = Math.floor(new Date(`${dayList[0]}T00:00:00`).getTime() / 1000);
  const plays = playsSince(kid.id, from, at + 1), listens = listensSince(kid.id, dayList[0]);
  const usage = new Map(all('SELECT day, seconds FROM screen_usage WHERE user_id=? AND day>=?', kid.id, dayList[0]).map(r => [r.day, r.seconds]));
  const perDay = new Map(dayList.map(d => [d, { day: d, video: 0, audio: 0, screen: Math.round(usage.get(d) || 0) }]));
  for (const p of plays) { const d = perDay.get(screen.localDay(new Date(p.ts * 1000))); if (d) d.video += p.played || 0; }
  for (const l of listens) { const d = perDay.get(l.day); if (d) d.audio += l.seconds; }
  for (const d of perDay.values()) { d.video = Math.round(d.video); d.audio = Math.round(d.audio); }

  // Mest sett: serier räknas som en titel (alla avsnitt), filmer var för sig
  const top = new Map();
  for (const p of plays) {
    const id = p.kind === 'episode' && p.show_id ? p.show_id : p.item_id;
    const t = top.get(id) || { id, title: p.kind === 'episode' ? (p.show_title || p.title || '?') : (p.title || '?'), kind: p.kind === 'episode' ? 'show' : p.kind, seconds: 0, plays: 0, episodes: new Set(), last: 0 };
    t.seconds += p.played || 0; t.plays++; t.last = Math.max(t.last, p.ts);
    if (p.kind === 'episode') t.episodes.add(p.item_id);
    top.set(id, t);
  }
  const books = new Map();
  for (const l of listens) { const b = books.get(l.book_id) || { id: l.book_id, title: l.title, seconds: 0 }; b.seconds += l.seconds; books.set(l.book_id, b); }

  const video = plays.reduce((n, p) => n + (p.played || 0), 0), audio = listens.reduce((n, l) => n + l.seconds, 0);
  return {
    id: kid.id, name: kid.name, maxAge: kid.max_age, days, lateHour: LATE_HOUR,
    perDay: [...perDay.values()],
    totals: {
      video: Math.round(video), audio: Math.round(audio), plays: plays.length,
      titles: top.size, late: plays.filter(p => isLate(p.ts)).length, remote: plays.filter(p => p.remote).length,
      avgPerDay: Math.round((video + audio) / days)
    },
    top: [...top.values()].sort((a, b) => b.seconds - a.seconds || b.last - a.last).slice(0, 12)
      .map(({ episodes, ...t }) => ({ ...t, seconds: Math.round(t.seconds), episodes: episodes.size })),
    books: [...books.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 8).map(b => ({ ...b, seconds: Math.round(b.seconds) })),
    recent: plays.slice(0, 40).map(p => ({
      id: p.id, ts: p.ts, ended: p.ended || p.ts, itemId: p.exists_ ? p.item_id : null, showId: p.show_id || null, title: titleOf(p), kind: p.kind,
      played: Math.round(p.played || 0), percent: p.duration && p.pos_end != null ? Math.min(100, Math.round(p.pos_end / p.duration * 100)) : null,
      device: p.device || null, remote: !!p.remote, late: isLate(p.ts) })),
    screen: { rules: screen.rulesFor(kid.id), status: screen.status(kid.id, today) },
    now: nowPlaying(kid.id)
  };
}
