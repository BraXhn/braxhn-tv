// Trakt.tv: koppla konto (enhetskod), synka sett-status åt båda hållen och visa "tittar nu".
// Kräver en egen (gratis) Trakt-app: trakt.tv/oauth/applications → Client ID + Client Secret.
import { db, get, all, run, now, getSetting } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS trakt(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, access TEXT NOT NULL, refresh TEXT,
  expires INTEGER, username TEXT, last_sync INTEGER, sync_error TEXT)`);

const API = process.env.TRAKT_API || 'https://api.trakt.tv';
const app = () => ({ id: getSetting('trakt_client_id', process.env.TRAKT_CLIENT_ID || ''), secret: getSetting('trakt_client_secret', process.env.TRAKT_CLIENT_SECRET || '') });
export const enabled = () => { const a = app(); return !!(a.id && a.secret); };
const pending = new Map(); // userId → { device_code, interval, expires }

async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(API + p, {
    method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': app().id, 'User-Agent': 'BraXhnTV', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, ok: r.ok, body: j };
}

// ---------- koppling ----------
export async function startDevice(userId) {
  if (!enabled()) throw new Error('Trakt är inte inställt – ange Client ID och Secret under Administration');
  const r = await call('/oauth/device/code', { method: 'POST', body: { client_id: app().id } });
  if (!r.ok) throw new Error(`Trakt svarade ${r.status}`);
  pending.set(userId, { code: r.body.device_code, interval: r.body.interval || 5, expires: Date.now() + (r.body.expires_in || 600) * 1000 });
  return { userCode: r.body.user_code, url: r.body.verification_url, interval: r.body.interval || 5 };
}
/** Kollas av webbsidan var 5:e sekund. Returnerar 'pending' | 'connected' | 'expired' | 'denied' */
export async function pollDevice(userId) {
  const p = pending.get(userId);
  if (!p) return { status: 'none' };
  if (Date.now() > p.expires) { pending.delete(userId); return { status: 'expired' }; }
  const a = app();
  const r = await call('/oauth/device/token', { method: 'POST', body: { code: p.code, client_id: a.id, client_secret: a.secret } });
  if (r.status === 200) {
    pending.delete(userId);
    const me = await call('/users/settings', { token: r.body.access_token });
    run(`INSERT INTO trakt(user_id,access,refresh,expires,username) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET access=excluded.access, refresh=excluded.refresh,
      expires=excluded.expires, username=excluded.username, sync_error=NULL`, userId, r.body.access_token, r.body.refresh_token, now() + (r.body.expires_in || 7776000), me.body?.user?.username || null);
    sync(userId).catch(() => {});
    return { status: 'connected', username: me.body?.user?.username || null };
  }
  if (r.status === 400) return { status: 'pending' };
  if (r.status === 418) { pending.delete(userId); return { status: 'denied' }; }
  if (r.status === 410 || r.status === 404) { pending.delete(userId); return { status: 'expired' }; }
  return { status: 'pending' }; // 429 m.fl.: försök igen
}
export const disconnect = (userId) => run('DELETE FROM trakt WHERE user_id=?', userId);
export const info = (userId) => { const t = get('SELECT username, last_sync, sync_error FROM trakt WHERE user_id=?', userId); return { enabled: enabled(), connected: !!t, ...(t || {}) }; };

async function tokenFor(userId) {
  const t = get('SELECT * FROM trakt WHERE user_id=?', userId);
  if (!t) return null;
  if (t.expires && t.expires - now() < 7 * 86400 && t.refresh) {
    const a = app();
    const r = await call('/oauth/token', { method: 'POST', body: { refresh_token: t.refresh, client_id: a.id, client_secret: a.secret, grant_type: 'refresh_token', redirect_uri: 'urn:ietf:wg:oauth:2.0:oob' } });
    if (r.ok) { run('UPDATE trakt SET access=?, refresh=?, expires=? WHERE user_id=?', r.body.access_token, r.body.refresh_token, now() + (r.body.expires_in || 7776000), userId); return r.body.access_token; }
    if (r.status === 401) { run("UPDATE trakt SET sync_error='Kopplingen har gått ut – koppla Trakt igen' WHERE user_id=?", userId); return null; }
  }
  return t.access;
}

// ---------- objekt → Trakt-format ----------
function traktObj(it) {
  if (it.kind === 'movie') return it.tmdb_id ? { movies: [{ ids: { tmdb: it.tmdb_id }, title: it.title, year: it.year }] } : null;
  if (it.kind === 'episode') {
    const show = get('SELECT tmdb_id, title, year FROM items WHERE id=?', it.parent_id);
    if (!show?.tmdb_id) return null;
    return { shows: [{ ids: { tmdb: show.tmdb_id }, title: show.title, year: show.year, seasons: [{ number: it.season, episodes: [{ number: it.episode }] }] }] };
  }
  return null;
}
function scrobbleObj(it) {
  if (it.kind === 'movie' && it.tmdb_id) return { movie: { ids: { tmdb: it.tmdb_id } } };
  if (it.kind === 'episode') {
    const show = get('SELECT tmdb_id FROM items WHERE id=?', it.parent_id);
    if (show?.tmdb_id) return { show: { ids: { tmdb: show.tmdb_id } }, episode: { season: it.season, number: it.episode } };
  }
  return null;
}

/** Sett lokalt → lägg till i Trakts historik */
export async function markWatched(userId, items) {
  const tok = await tokenFor(userId); if (!tok) return;
  const body = { movies: [], shows: [] };
  for (const it of items) {
    const o = traktObj(it); if (!o) continue;
    if (o.movies) body.movies.push(...o.movies.map(m => ({ ...m, watched_at: new Date().toISOString() })));
    else body.shows.push(...o.shows);
  }
  if (!body.movies.length && !body.shows.length) return;
  await call('/sync/history', { method: 'POST', body, token: tok });
}
/** "Tittar nu" på Trakt (start/pause/stop med procent) */
export async function scrobble(userId, it, action, progress) {
  const tok = get('SELECT 1 FROM trakt WHERE user_id=?', userId) ? await tokenFor(userId) : null; if (!tok) return;
  const o = scrobbleObj(it); if (!o) return;
  await call(`/scrobble/${action}`, { method: 'POST', body: { ...o, progress: Math.max(0, Math.min(100, +progress || 0)) }, token: tok });
}

/** Tvåvägssynk: hämta sett från Trakt och markera lokalt, skicka lokalt sett som saknas på Trakt */
export async function sync(userId) {
  const tok = await tokenFor(userId); if (!tok) return { imported: 0, exported: 0 };
  try {
    const [m, s] = await Promise.all([call('/sync/watched/movies', { token: tok }), call('/sync/watched/shows', { token: tok })]);
    if (!m.ok || !s.ok) throw new Error(`Trakt svarade ${m.status}/${s.status}`);
    const remoteMovies = new Set((m.body || []).map(x => x.movie?.ids?.tmdb).filter(Boolean));
    const remoteEps = new Set();
    for (const x of s.body || []) for (const se of x.seasons || []) for (const ep of se.episodes || []) remoteEps.add(`${x.show?.ids?.tmdb}:${se.number}:${ep.number}`);
    let imported = 0;
    const mark = run.bind(null, `INSERT INTO progress(user_id,item_id,position,watched,updated) VALUES(?,?,0,1,?)
      ON CONFLICT(user_id,item_id) DO UPDATE SET watched=1, position=0, updated=excluded.updated WHERE watched=0`);
    const local = all(`SELECT i.*, s.tmdb_id AS show_tmdb, COALESCE(p.watched,0) AS w FROM items i LEFT JOIN items s ON s.id=i.parent_id
      LEFT JOIN progress p ON p.item_id=i.id AND p.user_id=? WHERE i.kind IN ('movie','episode')`, userId);
    const toExport = [];
    for (const it of local) {
      const key = it.kind === 'movie' ? it.tmdb_id : it.show_tmdb ? `${it.show_tmdb}:${it.season}:${it.episode}` : null;
      if (!key) continue;
      const remote = it.kind === 'movie' ? remoteMovies.has(key) : remoteEps.has(key);
      if (remote && !it.w) { if (mark(userId, it.id, now()).changes) imported++; }
      else if (!remote && it.w) toExport.push(it);
    }
    for (let i = 0; i < toExport.length; i += 200) await markWatched(userId, toExport.slice(i, i + 200));
    run('UPDATE trakt SET last_sync=?, sync_error=NULL WHERE user_id=?', now(), userId);
    return { imported, exported: toExport.length };
  } catch (e) {
    run('UPDATE trakt SET sync_error=? WHERE user_id=?', e.message, userId);
    throw e;
  }
}

// Synka alla kopplade konton var 6:e timme
setInterval(() => { for (const t of all('SELECT user_id FROM trakt')) sync(t.user_id).catch(() => {}); }, 6 * 3600e3).unref();
