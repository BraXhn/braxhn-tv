// Scrobbling av musik till ListenBrainz och Last.fm – per person (profil), som Navidrome.
// Servern ser bara att ett spår startar (POST /api/music/tracks/:id/played från webben och apparna). Varje start blir
// "spelas nu" hos tjänsterna och en väntande lyssning i kön. Lyssningen räknas när spåret hunnit spelas till hälften
// eller i 4 minuter (Last.fm-regeln) utan att ett annat spår startat; startar nästa spår före det var spåret överhoppat
// och raden tas bort. Spår under 30 sekunder scrobblas inte. Misslyckade sändningar ligger kvar i kön och försöks
// igen med ökande väntetid, så länge tjänsten tar emot så gamla lyssningar.
// ListenBrainz: användarens egen token (listenbrainz.org/settings). Last.fm: webbinloggning (auth.getToken →
// användaren godkänner på last.fm → auth.getSession) med appens API-nyckel och secret (LASTFM_API_KEY/LASTFM_SECRET
// eller Administration). Token och sessionsnycklar sparas i databasen och lämnas aldrig ut i API-svar.
import crypto from 'node:crypto';
import { get, all, run, now, tx, getSetting } from './db.js';

export const SERVICES = ['listenbrainz', 'lastfm'];
const DAY = 86400;
/** Hur gamla lyssningar tjänsterna tar emot: Last.fm högst 14 dagar, ListenBrainz godtar äldre men vi håller 30 dagar */
export const MAX_AGE = { listenbrainz: 30 * DAY, lastfm: 14 * DAY };
const MAX_ATTEMPTS = 20;
const UA = () => `BraXhnTV/${globalThis.__braxhnAppVersion || '0'}`;
// Bas-adresserna kan ändras (tester mot låtsasserver)
const LB = () => (process.env.LISTENBRAINZ_API || 'https://api.listenbrainz.org').replace(/\/+$/, '');
const LF = () => process.env.LASTFM_API || 'https://ws.audioscrobbler.com/2.0/';
const LF_AUTH = () => process.env.LASTFM_AUTH_URL || 'https://www.last.fm/api/auth/';
const lfApp = () => ({ key: getSetting('lastfm_api_key', process.env.LASTFM_API_KEY || ''), secret: getSetting('lastfm_secret', process.env.LASTFM_SECRET || '') });
export const lastfmEnabled = () => { const a = lfApp(); return !!(a.key && a.secret); };

/** När räknas spåret som lyssnat (sekunder efter start)? Hälften av spåret, högst 4 minuter; okänd längd → 4 minuter. */
export const threshold = (dur) => dur > 0 ? Math.min(240, Math.round(dur / 2)) : 240;
/** Spår kortare än 30 sekunder scrobblas inte */
export const scrobblable = (dur) => !(dur > 0 && dur < 30);
/** Väntetid före nästa försök: 1, 2, 4 … minuter, högst 6 timmar */
export const backoff = (attempts) => Math.min(6 * 3600, 60 * 2 ** Math.max(0, attempts - 1));

class ScrobbleError extends Error {
  /** kind: 'auth' (kopplingen gäller inte längre), 'app' (Last.fm-nyckeln fel), 'temp' (försök igen) */
  constructor(kind, message) { super(message); this.kind = kind; }
}
const known = (name) => { const s = String(name || '').trim(); return s && s !== 'Okänd artist' ? s : null; };

// ---------- anrop ----------
export function lastfmSig(params, secret) {
  const s = Object.keys(params).filter(k => k !== 'format' && k !== 'callback').sort().map(k => k + params[k]).join('') + secret;
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}
const LF_AUTH_ERR = new Set([9]), LF_APP_ERR = new Set([10, 13, 26]);
async function lastfm(method, params = {}, { post = false, sk } = {}) {
  const a = lfApp();
  if (!a.key || !a.secret) throw new ScrobbleError('app', 'Last.fm kräver en API-nyckel (se README)');
  const p = { method, api_key: a.key, ...(sk ? { sk } : {}) };
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') p[k] = String(v);
  p.api_sig = lastfmSig(p, a.secret);
  p.format = 'json';
  const q = new URLSearchParams(p);
  let r, j = null;
  try {
    r = await fetch(post ? LF() : `${LF()}?${q}`, { method: post ? 'POST' : 'GET', body: post ? q : undefined,
      headers: { 'User-Agent': UA(), ...(post ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, signal: AbortSignal.timeout(15000) });
    try { j = JSON.parse(await r.text()); } catch {}
  } catch { throw new ScrobbleError('temp', 'Last.fm gick inte att nå'); }
  if (j && j.error) {
    const e = new ScrobbleError(LF_AUTH_ERR.has(+j.error) ? 'auth' : LF_APP_ERR.has(+j.error) ? 'app' : 'temp',
      LF_AUTH_ERR.has(+j.error) ? 'Kopplingen till Last.fm gäller inte längre – koppla igen' : LF_APP_ERR.has(+j.error) ? 'API-nyckeln för Last.fm fungerar inte (Administration)' : `Last.fm: ${String(j.message || 'fel ' + j.error).slice(0, 200)}`);
    e.code = +j.error;
    throw e;
  }
  if (!r.ok) throw new ScrobbleError('temp', `Last.fm svarade ${r.status}`);
  return j || {};
}
async function listenbrainz(path, token, body) {
  let r, j = null;
  try {
    r = await fetch(LB() + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Token ${token}`, 'User-Agent': UA(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(15000) });
    try { j = JSON.parse(await r.text()); } catch {}
  } catch { throw new ScrobbleError('temp', 'ListenBrainz gick inte att nå'); }
  if (r.status === 401) throw new ScrobbleError('auth', 'ListenBrainz godtar inte längre din token – koppla igen');
  if (!r.ok) throw new ScrobbleError('temp', `ListenBrainz svarade ${r.status}${j?.error ? ': ' + String(j.error).slice(0, 200) : ''}`);
  return j || {};
}

// ---------- koppling ----------
const save = (uid, service, secret, username) => run(`INSERT INTO scrobble_accounts(user_id,service,secret,username,connected) VALUES(?,?,?,?,?)
  ON CONFLICT(user_id,service) DO UPDATE SET secret=excluded.secret, username=excluded.username, connected=excluded.connected, error=NULL`, uid, service, secret, username, now());

export async function connectListenBrainz(uid, token) {
  token = String(token || '').trim();
  if (!/^[\w-]{8,200}$/.test(token)) throw new ScrobbleError('bad', 'Klistra in din användartoken från listenbrainz.org/settings');
  let j;
  try { j = await listenbrainz('/1/validate-token', token); }
  catch (e) { throw new ScrobbleError(e.kind, e.kind === 'auth' ? 'ListenBrainz godtar inte token' : e.message); }
  if (!j.valid) throw new ScrobbleError('auth', 'ListenBrainz godtar inte token');
  save(uid, 'listenbrainz', token, String(j.user_name || '').slice(0, 100) || null);
  return { username: j.user_name || null };
}

const pending = new Map(); // userId → { token, expires } under Last.fm-inloggningen
export async function startLastfm(uid) {
  const j = await lastfm('auth.getToken');
  if (!j.token) throw new ScrobbleError('temp', 'Last.fm gav ingen inloggningskod');
  pending.set(uid, { token: j.token, expires: Date.now() + 55 * 60e3 }); // Last.fm-koden gäller 60 minuter
  if (pending.size > 200) pending.delete(pending.keys().next().value);
  return { url: `${LF_AUTH()}?${new URLSearchParams({ api_key: lfApp().key, token: j.token })}` };
}
/** Kollas av webbsidan var 3:e sekund: 'pending' | 'connected' | 'expired' | 'none' */
export async function pollLastfm(uid) {
  const p = pending.get(uid);
  if (!p) return { status: 'none' };
  if (Date.now() > p.expires) { pending.delete(uid); return { status: 'expired' }; }
  try {
    const j = await lastfm('auth.getSession', { token: p.token });
    if (!j.session?.key) return { status: 'pending' };
    pending.delete(uid);
    save(uid, 'lastfm', j.session.key, String(j.session.name || '').slice(0, 100) || null);
    return { status: 'connected', username: j.session.name || null };
  } catch (e) {
    if (e.code === 14) return { status: 'pending' }; // inte godkänd än
    if (e.code === 15 || e.code === 4) { pending.delete(uid); return { status: 'expired' }; }
    if (e.kind === 'temp') return { status: 'pending' };
    throw e;
  }
}
export function disconnect(uid, service) {
  pending.delete(uid);
  tx(() => { run('DELETE FROM scrobble_accounts WHERE user_id=? AND service=?', uid, service); run('DELETE FROM scrobble_queue WHERE user_id=? AND service=?', uid, service); });
}
/** Administratören bytte Last.fm-nyckel: försök igen med kopplingarna som stoppats av fel */
export const lastfmAppChanged = () => run("UPDATE scrobble_accounts SET error=NULL WHERE service='lastfm'");

/** Status för Mitt konto – aldrig token eller sessionsnyckel */
export function info(u, at = now()) {
  const acc = Object.fromEntries(all('SELECT service, username, error, last_ok, connected FROM scrobble_accounts WHERE user_id=?', u.id).map(a => [a.service, a]));
  const q = Object.fromEntries(all('SELECT service, COUNT(*) AS n FROM scrobble_queue WHERE user_id=? AND due<=? GROUP BY service', u.id, at).map(r => [r.service, r.n]));
  const one = (s) => ({ connected: !!acc[s], username: acc[s]?.username || null, error: acc[s]?.error || null, lastSent: acc[s]?.last_ok || null, queued: q[s] || 0 });
  return { allowed: u.max_age == null, listenbrainz: one('listenbrainz'), lastfm: { available: lastfmEnabled(), ...one('lastfm') } };
}

// ---------- lyssningar ----------
const trackMeta = (id) => get(`SELECT t.id, t.title, t.duration, t.track_no, ar.name AS artist, al.title AS album, aa.name AS album_artist FROM tracks t
  LEFT JOIN artists ar ON ar.id=t.artist_id LEFT JOIN albums al ON al.id=t.album_id LEFT JOIN artists aa ON aa.id=al.artist_id WHERE t.id=?`, id);

const lbMeta = (r) => ({ artist_name: r.artist, track_name: r.title, ...(r.album ? { release_name: r.album } : {}),
  additional_info: { ...(r.duration ? { duration_ms: r.duration * 1000 } : {}), ...(r.track_no ? { tracknumber: r.track_no } : {}),
    media_player: 'BraXhn TV', submission_client: 'BraXhn TV', submission_client_version: globalThis.__braxhnAppVersion || '0' } });
const lfParams = (r, i) => {
  const s = i == null ? (k) => k : (k) => `${k}[${i}]`;
  return { [s('artist')]: r.artist, [s('track')]: r.title, [s('album')]: r.album, [s('albumArtist')]: r.album_artist && r.album_artist !== r.artist ? r.album_artist : null,
    [s('duration')]: r.duration || null, [s('trackNumber')]: r.track_no || null, ...(i == null ? {} : { [s('timestamp')]: r.listened_at }) };
};

async function nowPlaying(acct, r) {
  try {
    if (acct.service === 'listenbrainz') await listenbrainz('/1/submit-listens', acct.secret, { listen_type: 'playing_now', payload: [{ track_metadata: lbMeta(r) }] });
    else if (lastfmEnabled()) await lastfm('track.updateNowPlaying', lfParams(r), { post: true, sk: acct.secret });
  } catch (e) {
    if (e.kind === 'auth' || e.kind === 'app') run('UPDATE scrobble_accounts SET error=? WHERE user_id=? AND service=?', e.message, acct.user_id, acct.service);
  }
}

/**
 * Ett spår har startat för användaren (webben, iOS/tvOS eller Android). Skickar "spelas nu" och lägger en väntande
 * lyssning i kön; föregående spår som inte hann räknas tas bort. Returnerar ett löfte för "spelas nu" (testerna väntar på det).
 */
export function played(u, trackId, at = now()) {
  if (!u || u.max_age != null) return Promise.resolve(); // barnprofiler: ingen koppling, ärvs inte heller
  const accts = all('SELECT user_id, service, secret, error FROM scrobble_accounts WHERE user_id=?', u.id);
  if (!accts.length) return Promise.resolve();
  // Samma spår anmält igen inom en halv minut (omladdning, appens listbyte): räkna det en gång
  const same = get('SELECT listened_at FROM scrobble_queue WHERE user_id=? AND track_id=? AND due>? ORDER BY listened_at DESC LIMIT 1', u.id, trackId, at);
  if (same && at - same.listened_at < 30) return Promise.resolve();
  const t = trackMeta(trackId);
  const artist = known(t?.artist) || known(t?.album_artist);
  const row = t && artist ? { artist, title: String(t.title).slice(0, 500), album: t.album || null, album_artist: known(t.album_artist),
    duration: t.duration > 0 ? Math.round(t.duration) : null, track_no: t.track_no || null, listened_at: at } : null;
  tx(() => {
    // Ett nytt spår startade innan det förra hann räknas: det förra hoppades över
    run('DELETE FROM scrobble_queue WHERE user_id=? AND due>?', u.id, at);
    if (row && scrobblable(row.duration)) for (const a of accts) {
      run(`INSERT OR IGNORE INTO scrobble_queue(user_id,service,track_id,artist,title,album,album_artist,duration,track_no,listened_at,due)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, u.id, a.service, t.id, row.artist, row.title, row.album, row.album_artist, row.duration, row.track_no, at, at + threshold(row.duration));
    }
  });
  if (!row) return Promise.resolve();
  return Promise.all(accts.filter(a => !a.error).map(a => nowPlaying(a, row)));
}

/**
 * Musikappar (Subsonic: scrobble med submission=false): bara "spelas nu" hos tjänsterna. Kön rörs inte – appen meddelar
 * själv när spåret räknas (listened nedan), så ett nytt spår betyder inte att ett annat hoppades över.
 */
export function nowPlayingOnly(u, trackId) {
  if (!u || u.max_age != null) return Promise.resolve();
  const accts = all('SELECT user_id, service, secret, error FROM scrobble_accounts WHERE user_id=? AND error IS NULL', u.id);
  const t = accts.length ? trackMeta(trackId) : null;
  const artist = known(t?.artist) || known(t?.album_artist);
  if (!t || !artist) return Promise.resolve();
  const row = { artist, title: String(t.title).slice(0, 500), album: t.album || null, album_artist: known(t.album_artist),
    duration: t.duration > 0 ? Math.round(t.duration) : null, track_no: t.track_no || null };
  return Promise.all(accts.map(a => nowPlaying(a, row)));
}
/**
 * Musikappar (Subsonic: scrobble med submission=true): appen har redan avgjort att spåret räknas. Lyssningen läggs i kön
 * som klar att skicka direkt (listened_at = när spåret spelades, enligt appen). Samma spår och starttid räknas en gång.
 */
export function listened(u, trackId, listenedAt = now(), at = now()) {
  if (!u || u.max_age != null) return 0;
  const accts = all('SELECT service FROM scrobble_accounts WHERE user_id=?', u.id);
  if (!accts.length) return 0;
  const t = trackMeta(trackId);
  const artist = known(t?.artist) || known(t?.album_artist);
  if (!t || !artist) return 0;
  const dur = t.duration > 0 ? Math.round(t.duration) : null;
  if (!scrobblable(dur)) return 0;
  const when = Math.min(at, Math.max(at - MAX_AGE.listenbrainz, Math.floor(listenedAt) || at));
  let n = 0;
  tx(() => {
    for (const a of accts) n += Number(run(`INSERT OR IGNORE INTO scrobble_queue(user_id,service,track_id,artist,title,album,album_artist,duration,track_no,listened_at,due)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, u.id, a.service, t.id, artist, String(t.title).slice(0, 500), t.album || null, known(t.album_artist), dur, t.track_no || null, when, at).changes);
  });
  return n;
}

async function submit(acct, rows) {
  if (acct.service === 'listenbrainz') {
    await listenbrainz('/1/submit-listens', acct.secret, { listen_type: rows.length === 1 ? 'single' : 'import',
      payload: rows.map(r => ({ listened_at: r.listened_at, track_metadata: lbMeta(r) })) });
  } else {
    await lastfm('track.scrobble', Object.assign({}, ...rows.map((r, i) => lfParams(r, i))), { post: true, sk: acct.secret });
  }
}

let busy = null;
/** Skickar lyssningar som räknats (due passerat) och vars nästa försök är inne. Körs var 30:e sekund. */
export function processQueue(at = now()) {
  if (!busy) busy = drain(at).finally(() => { busy = null; });
  return busy;
}
async function drain(at) {
  // För gamla för tjänsten: tas inte emot längre
  for (const s of SERVICES) {
    const n = Number(run('DELETE FROM scrobble_queue WHERE service=? AND due<=? AND listened_at<?', s, at, at - MAX_AGE[s]).changes);
    if (n) console.warn(`[scrobble] ${n} lyssningar var för gamla för ${s === 'lastfm' ? 'Last.fm' : 'ListenBrainz'} och skickas inte`);
  }
  const groups = all(`SELECT DISTINCT q.user_id, q.service FROM scrobble_queue q JOIN scrobble_accounts a ON a.user_id=q.user_id AND a.service=q.service
    WHERE a.error IS NULL AND q.due<=? AND q.next_try<=?`, at, at);
  let sent = 0, failed = 0;
  for (const g of groups) {
    if (g.service === 'lastfm' && !lastfmEnabled()) continue;
    const acct = get('SELECT user_id, service, secret FROM scrobble_accounts WHERE user_id=? AND service=?', g.user_id, g.service);
    if (!acct) continue;
    // Last.fm tar högst 50 per anrop; samma storlek för båda. Högst 1000 per konto och körning.
    for (let round = 0; round < 20; round++) {
      const rows = all('SELECT * FROM scrobble_queue WHERE user_id=? AND service=? AND due<=? AND next_try<=? ORDER BY listened_at LIMIT 50', g.user_id, g.service, at, at);
      if (!rows.length) break;
      try {
        await submit(acct, rows);
        tx(() => { for (const r of rows) run('DELETE FROM scrobble_queue WHERE id=?', r.id); run('UPDATE scrobble_accounts SET last_ok=? WHERE user_id=? AND service=?', now(), g.user_id, g.service); });
        sent += rows.length;
      } catch (e) {
        if (e.kind === 'auth' || e.kind === 'app') {
          // Lyssningarna ligger kvar (inom tidsgränsen) tills personen kopplar igen
          run('UPDATE scrobble_accounts SET error=? WHERE user_id=? AND service=?', e.message, g.user_id, g.service);
        } else {
          tx(() => {
            for (const r of rows) {
              if (r.attempts + 1 >= MAX_ATTEMPTS) run('DELETE FROM scrobble_queue WHERE id=?', r.id);
              else run('UPDATE scrobble_queue SET attempts=?, next_try=?, error=? WHERE id=?', r.attempts + 1, at + backoff(r.attempts + 1), e.message, r.id);
            }
          });
          failed += rows.length;
        }
        break;
      }
    }
  }
  return { sent, failed };
}

if (process.env.SCROBBLE_INTERVAL !== '0') {
  setInterval(() => processQueue().catch(e => console.warn('[scrobble]', e.message)), 30e3).unref();
}
