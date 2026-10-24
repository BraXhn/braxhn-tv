// Kalender för kommande avsnitt och saknade avsnitt.
//
// Data: för serier i biblioteket hämtas TMDB /tv/{id} (status, nästa/senaste avsnitt, säsonger) och
// säsongslistorna med sändningsdatum. Pågående och följda serier hämtas en gång per dygn, avslutade en gång
// i månaden (de behövs för "Saknas"). Anropen sprids ut (CALENDAR_GAP_MS mellan varje) och går genom
// scanner.js tmdb(), som väntar vid 429. Utan TMDB-nyckel hämtas ingenting.
// Är Sonarr kopplat läggs Sonarrs kalender till (sändningstid och kanal, och serier som inte finns här än).
//
// Tabeller (db.js): calendar_shows (status per serie), calendar_episodes (avsnitt med air_date).
// Datum är lokala (serverns tidszon) och skrivs YYYY-MM-DD.
import { get, all, run, tx, now } from './db.js';
import { tmdb, hasTmdb } from './scanner.js';
import * as arr from './arr.js';
import { followedIds } from './follows.js';

const DAY = 86400;
const ONGOING = new Set(['Returning Series', 'In Production', 'Planned', 'Pilot']);
const GAP = Math.max(0, +(process.env.CALENDAR_GAP_MS ?? 1500));
const sleep = (ms) => ms ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();

export const ymd = (d = new Date()) => d.toLocaleDateString('sv-SE');
export const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
export const validDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T12:00:00'));
const day = (s) => validDay(s) ? s : null;
export const isOngoing = (status) => !status || ONGOING.has(status);

// ---------- hämtning från TMDB ----------
/** Serier som behöver hämtas: aldrig hämtade/ny matchning först, sedan följda, sedan äldst hämtade */
export function dueShows(t = now()) {
  const rows = all(`SELECT s.id, s.tmdb_id, s.title, c.tmdb_id AS c_tmdb, c.status, c.fetched, c.error,
      EXISTS(SELECT 1 FROM follows f WHERE f.show_id=s.id AND f.active=1) AS followed
    FROM items s LEFT JOIN calendar_shows c ON c.show_id=s.id WHERE s.kind='show' AND s.tmdb_id IS NOT NULL`);
  const due = rows.filter(r => {
    if (!r.fetched || r.c_tmdb !== r.tmdb_id) return true;
    const every = r.error ? 6 * 3600 : (r.followed || isOngoing(r.status)) ? DAY - 600 : 30 * DAY;
    return t - r.fetched >= every;
  });
  const rank = (r) => (!r.fetched || r.c_tmdb !== r.tmdb_id) ? 0 : r.followed ? 1 : 2;
  return due.sort((a, b) => rank(a) - rank(b) || (a.fetched || 0) - (b.fetched || 0));
}

/** Hämta en serie från TMDB och spara säsongernas avsnitt */
export async function refreshShow(s) {
  const prev = get('SELECT * FROM calendar_shows WHERE show_id=?', s.id);
  const full = !prev || prev.tmdb_id !== s.tmdb_id || !isOngoing(prev.status) || !prev.fetched;
  const d = await tmdb(`/tv/${+s.tmdb_id}`);
  const known = new Map(all('SELECT season, COUNT(*) AS n FROM calendar_episodes WHERE show_id=? GROUP BY season', s.id).map(r => [r.season, r.n]));
  const seasons = (d.seasons || []).filter(x => x.season_number > 0);
  const lastS = d.last_episode_to_air?.season_number, nextS = d.next_episode_to_air?.season_number;
  const from = Math.min(lastS ?? Infinity, nextS ?? Infinity);
  // Pågående serie: bara säsongerna från den senast sända (och de som saknas eller fått fler avsnitt)
  const want = seasons.filter(x => full || known.get(x.season_number) !== x.episode_count || x.season_number >= from);
  const got = new Map();
  for (const x of want) {
    await sleep(GAP);
    const sd = await tmdb(`/tv/${+s.tmdb_id}/season/${+x.season_number}`);
    got.set(x.season_number, (sd.episodes || []).filter(e => Number.isInteger(e.episode_number)));
  }
  const status = typeof d.status === 'string' ? d.status.slice(0, 40) : null;
  const network = d.networks?.[0]?.name ? String(d.networks[0].name).slice(0, 80) : null;
  tx(() => {
    if (prev && prev.tmdb_id !== s.tmdb_id) run('DELETE FROM calendar_episodes WHERE show_id=?', s.id);
    const up = (season, e) => run(`INSERT INTO calendar_episodes(show_id,season,episode,name,air_date) VALUES(?,?,?,?,?)
      ON CONFLICT(show_id,season,episode) DO UPDATE SET name=excluded.name, air_date=excluded.air_date`,
      s.id, season, e.episode_number, e.name ? String(e.name).slice(0, 200) : null, day(e.air_date));
    for (const [season, eps] of got) {
      // Avsnitt som TMDB har tagit bort försvinner även här
      const keep = eps.map(e => +e.episode_number);
      run(`DELETE FROM calendar_episodes WHERE show_id=? AND season=? AND episode NOT IN (${keep.map(() => '?').join(',') || 'NULL'})`, s.id, season, ...keep);
      for (const e of eps) up(season, e);
    }
    for (const e of [d.last_episode_to_air, d.next_episode_to_air]) if (e?.season_number > 0 && Number.isInteger(e.episode_number)) up(e.season_number, e);
    run(`INSERT INTO calendar_shows(show_id,tmdb_id,status,network,next_air,last_air,fetched,error) VALUES(?,?,?,?,?,?,?,NULL)
      ON CONFLICT(show_id) DO UPDATE SET tmdb_id=excluded.tmdb_id, status=excluded.status, network=excluded.network,
      next_air=excluded.next_air, last_air=excluded.last_air, fetched=excluded.fetched, error=NULL`,
      s.id, s.tmdb_id, status, network, day(d.next_episode_to_air?.air_date), day(d.last_episode_to_air?.air_date), now());
  });
  return { seasons: got.size };
}

let running = null;
export const refreshing = () => !!running;
/** Hämta de serier som står på tur (högst max per omgång, utspritt). Körs högst en gång åt gången. */
export function refreshDue({ max = 300 } = {}) {
  if (running) return running;
  if (!hasTmdb()) return Promise.resolve(0);
  running = (async () => {
    let n = 0;
    for (const s of dueShows().slice(0, max)) {
      try { await refreshShow(s); n++; }
      catch (e) {
        console.warn(`[kalender] ${s.title}: ${e.message}`);
        run(`INSERT INTO calendar_shows(show_id,tmdb_id,fetched,error) VALUES(?,?,?,?)
          ON CONFLICT(show_id) DO UPDATE SET fetched=excluded.fetched, error=excluded.error`, s.id, s.tmdb_id, now(), String(e.message).slice(0, 200));
      }
      await sleep(GAP);
    }
    return n;
  })().finally(() => { running = null; });
  return running;
}
/** Bakgrundsjobb: första omgången två minuter efter start, sedan varje timme (det som står på tur) */
export function start() {
  if (process.env.CALENDAR_REFRESH === '0') return;
  const tick = () => { refreshDue().catch(e => console.warn('[kalender]', e.message)); };
  setTimeout(tick, 120e3).unref();
  setInterval(tick, 3600e3).unref();
}

// ---------- Sonarr ----------
let sonarr = { at: 0, list: [], key: '' };
let sonarrPending = null;
const SONARR_TTL = 30 * 60e3;
/** Sonarrs kalender (cachas 30 min). Fel ger en tom lista och nytt försök efter 5 min. */
export function loadSonarr() {
  if (!arr.configured('show')) return Promise.resolve([]);
  const t = ymd(), key = t;
  if (sonarr.key === key && Date.now() - sonarr.at < SONARR_TTL) return Promise.resolve(sonarr.list);
  if (!sonarrPending) {
    sonarrPending = arr.sonarrCalendar(addDays(t, -30), addDays(t, 120))
      .then(list => { sonarr = { at: Date.now(), list: (Array.isArray(list) ? list : []).map(sonarrEntry).filter(Boolean), key }; return sonarr.list; })
      .catch(e => { console.warn('[kalender] Sonarr:', e.message); sonarr = { at: Date.now() - SONARR_TTL + 5 * 60e3, list: sonarr.list, key }; return sonarr.list; })
      .finally(() => { sonarrPending = null; });
  }
  return sonarrPending;
}
/** Det som redan finns i cachen (startsidan väntar inte på Sonarr) – hämtar i bakgrunden om det är gammalt */
export function sonarrCached() {
  if (!arr.configured('show')) return [];
  loadSonarr().catch(() => {});
  return sonarr.list;
}
export const clearSonarr = () => { sonarr = { at: 0, list: [], key: '' }; };
function sonarrEntry(e) {
  if (!Number.isInteger(e?.seasonNumber) || !Number.isInteger(e?.episodeNumber) || e.seasonNumber < 1) return null;
  const utc = e.airDateUtc ? new Date(e.airDateUtc) : null;
  const date = utc && !isNaN(utc) ? ymd(utc) : day(e.airDate);
  if (!date) return null;
  return { seriesId: +e.seriesId || 0, tmdbId: +e.series?.tmdbId || null, title: String(e.series?.title || '').slice(0, 200),
    season: e.seasonNumber, episode: e.episodeNumber, name: e.title ? String(e.title).slice(0, 200) : null, date,
    time: utc && !isNaN(utc) ? utc.toISOString() : null, network: e.series?.network ? String(e.series.network).slice(0, 80) : null,
    runtime: +e.series?.runtime || null };
}

// ---------- kalendern ----------
/**
 * Avsnitt som sänds från–till (YYYY-MM-DD, båda inräknade) för användaren.
 * allowed(show) = får profilen se serien (åldersgräns); kid = barnprofil (då visas inte serier utanför biblioteket);
 * mine = bara serier man följer; sonarrList = Sonarrs avsnitt (loadSonarr/sonarrCached).
 */
export function entries(uid, from, to, { allowed = () => true, kid = false, mine = false, sonarrList = [], limit = 1500 } = {}) {
  const today = ymd();
  const followed = new Set(followedIds(uid));
  const shows = new Map(), byKey = new Map();
  const showOf = (id) => {
    if (!shows.has(id)) {
      const s = get("SELECT id, title, age, cert, poster, tmdb_id FROM items WHERE id=? AND kind='show'", id);
      shows.set(id, s && allowed(s) && (!mine || followed.has(s.id)) ? s : null);
    }
    return shows.get(id);
  };
  for (const r of all(`SELECT e.show_id, e.season, e.episode, e.name, e.air_date, c.network FROM calendar_episodes e
      JOIN calendar_shows c ON c.show_id=e.show_id JOIN items s ON s.id=e.show_id AND s.tmdb_id=c.tmdb_id
      WHERE e.air_date BETWEEN ? AND ? AND e.season > 0 ORDER BY e.air_date LIMIT ?`, from, to, limit * 2)) {
    if (!showOf(r.show_id)) continue;
    byKey.set(`${r.show_id}:${r.season}:${r.episode}`, { showId: r.show_id, season: r.season, episode: r.episode, name: r.name,
      date: r.air_date, time: null, network: r.network || null, runtime: null, source: 'tmdb' });
  }
  if (sonarrList.length) {
    const byTmdb = new Map(all("SELECT id, tmdb_id FROM items WHERE kind='show' AND tmdb_id IS NOT NULL").map(r => [r.tmdb_id, r.id]));
    const byTitle = new Map(all("SELECT id, title FROM items WHERE kind='show'").map(r => [r.title.toLowerCase(), r.id]));
    for (const e of sonarrList) {
      const sid = (e.tmdbId && byTmdb.get(e.tmdbId)) || byTitle.get(e.title.toLowerCase()) || null;
      const k = sid ? `${sid}:${e.season}:${e.episode}` : `s${e.seriesId}:${e.season}:${e.episode}`;
      const have = byKey.get(k);
      // Sonarr vet sändningstiden; datumet räknas om till serverns tidszon
      if (have) { Object.assign(have, { date: e.date, time: e.time, network: e.network || have.network, runtime: e.runtime, name: have.name || e.name, source: 'sonarr' }); continue; }
      if (e.date < from || e.date > to) continue;
      if (sid ? !showOf(sid) : (kid || mine || !e.title)) continue;
      byKey.set(k, { showId: sid, sonarrId: sid ? null : e.seriesId, title: sid ? null : e.title, season: e.season, episode: e.episode,
        name: e.name, date: e.date, time: e.time, network: e.network, runtime: e.runtime, source: 'sonarr' });
    }
  }
  const list = [...byKey.values()].filter(e => e.date >= from && e.date <= to);
  // Finns avsnittet i biblioteket?
  const ids = [...new Set(list.map(e => e.showId).filter(Boolean))];
  const have = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of all(`SELECT id, parent_id, season, episode FROM items WHERE kind='episode' AND version_of IS NULL AND parent_id IN (${part.map(() => '?').join(',')})`, ...part))
      have.set(`${r.parent_id}:${r.season}:${r.episode}`, r.id);
  }
  return list.map(e => {
    const s = e.showId ? showOf(e.showId) : null;
    const itemId = e.showId ? have.get(`${e.showId}:${e.season}:${e.episode}`) || null : null;
    return { date: e.date, time: e.time, showId: e.showId, show: s ? s.title : e.title, season: e.season, episode: e.episode,
      name: e.name || null, network: e.network || null, runtime: e.runtime || null, poster: !!s?.poster,
      itemId, inLibrary: !!itemId, missing: !itemId && e.date <= today, following: !!(e.showId && followed.has(e.showId)),
      ...(e.sonarrId ? { sonarrId: e.sonarrId } : {}) };
  }).sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || ''))
    || String(a.show).localeCompare(String(b.show), 'sv') || a.season - b.season || a.episode - b.episode).slice(0, limit);
}

/** Läget för kalendern: finns det något hämtat, och när hämtades det senast */
export function info() {
  const r = get('SELECT COUNT(*) AS n, MAX(fetched) AS last FROM calendar_shows WHERE error IS NULL');
  return { shows: r.n, lastFetch: r.last || null, refreshing: refreshing() };
}

// ---------- saknade avsnitt ----------
const pad = (n) => String(n).padStart(2, '0');
/** Avsnitt i följd (inom en säsong) grupperas: S02E04–E06 */
export function ranges(eps) {
  const out = [];
  for (const e of [...eps].sort((a, b) => a.season - b.season || a.episode - b.episode)) {
    const last = out[out.length - 1];
    if (last && last.season === e.season && e.episode === last.to + 1) last.to = e.episode;
    else out.push({ season: e.season, from: e.episode, to: e.episode });
  }
  for (const r of out) r.label = `S${pad(r.season)}E${pad(r.from)}${r.to > r.from ? `–E${pad(r.to)}` : ''}`;
  return out;
}
/** Sända avsnitt (air_date ≤ idag, inte specialavsnitt) som inte finns i biblioteket */
export function missing(showId, today = ymd()) {
  const c = get('SELECT c.*, s.tmdb_id AS s_tmdb FROM calendar_shows c JOIN items s ON s.id=c.show_id WHERE c.show_id=?', showId);
  if (!c || c.tmdb_id !== c.s_tmdb || !c.status) return { known: false, count: 0, ranges: [], episodes: [], label: '' };
  const have = new Set(all("SELECT season, episode FROM items WHERE parent_id=? AND kind='episode'", showId).map(r => `${r.season}:${r.episode}`));
  const eps = all('SELECT season, episode, name, air_date FROM calendar_episodes WHERE show_id=? AND season > 0 AND air_date IS NOT NULL AND air_date <= ? ORDER BY season, episode', showId, today)
    .filter(e => !have.has(`${e.season}:${e.episode}`));
  const rs = ranges(eps);
  return { known: true, count: eps.length, ranges: rs, label: rs.map(r => r.label).join(', '), status: c.status, fetched: c.fetched,
    next: c.next_air, episodes: eps.slice(0, 500).map(e => ({ season: e.season, episode: e.episode, name: e.name, date: e.air_date })) };
}

// ---------- iCal (RFC 5545) ----------
/** Text i ett värde: \ ; , och radbrytningar skrivs med omvänt snedstreck */
export const icsEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
/** Rader längre än 75 oktetter viks (CRLF + mellanslag) utan att dela ett UTF-8-tecken */
export function icsFold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts = []; let cur = '', len = 0, max = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (len + n > max) { parts.push(cur); cur = ''; len = 0; max = 74; } // fortsättningsraden börjar med ett mellanslag
    cur += ch; len += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}
const icsUtc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsDate = (s) => s.replace(/-/g, '');
const sxe = (e) => `S${pad(e.season)}E${pad(e.episode)}`;
/** Kalenderfil för en lista från entries() */
export function ical(list, { name = 'BraXhn TV – kommande avsnitt', stamp = new Date(), host = 'braxhn-tv' } = {}) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BraXhn TV//Kalender//SV', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`, 'X-PUBLISHED-TTL:PT6H', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H'];
  const dt = icsUtc(stamp);
  const hostPart = String(host).replace(/[^\w.-]/g, '') || 'braxhn-tv';
  for (const e of list) {
    const who = e.showId ? `${e.showId}` : `sonarr-${e.sonarrId || 0}`;
    const state = e.inLibrary ? 'Finns i biblioteket' : e.missing ? 'Saknas i biblioteket' : 'Kommer';
    L.push('BEGIN:VEVENT', `UID:braxhn-${who}-s${e.season}e${e.episode}@${hostPart}`, `DTSTAMP:${dt}`);
    if (e.time) {
      const t = new Date(e.time);
      L.push(`DTSTART:${icsUtc(t)}`, `DTEND:${icsUtc(new Date(t.getTime() + (e.runtime || 30) * 60e3))}`);
    } else L.push(`DTSTART;VALUE=DATE:${icsDate(e.date)}`, `DTEND;VALUE=DATE:${icsDate(addDays(e.date, 1))}`);
    L.push(`SUMMARY:${icsEscape(`${e.show} ${sxe(e)}${e.name ? ' – ' + e.name : ''}`)}`,
      `DESCRIPTION:${icsEscape([e.name ? `${sxe(e)} ${e.name}` : sxe(e), e.network ? `Kanal: ${e.network}` : '', state].filter(Boolean).join('\n'))}`);
    if (e.network) L.push(`LOCATION:${icsEscape(e.network)}`);
    L.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}
