// Musikappar: Subsonic API 1.16.1 med OpenSubsonic-tillägg under /rest/* (Symfonium, Amperfy, play:Sub med CarPlay,
// Feishin, Supersonic, Music Assistant för Sonos …), plus app-lösenordet under Mitt konto (/api/me/subsonic).
//
// Säkerhet (se även server/subsonic.js och routealternativet subsonic i http/router.js):
//   - /rest/* loggar bara in med musikappens app-lösenord (u+t+s, u+p eller apiKey). Kaka, Bearer och ?t= ignoreras där,
//     och app-lösenordet gäller ingen annanstans. Bara musik nås: inga filmer, serier, böcker, poddar eller admin.
//   - Fjärrregler som för appens Bearer-token (remoteDenied): konto utan fjärråtkomst nekas utifrån, och när
//     tvåstegsverifiering krävs utanför hemmet måste kontot ha det. Lösenordet kan inte bära 2FA själv, så det skapas
//     bara hemifrån, eller utifrån med kod från autentiseringsappen.
//   - Barnprofiler: musik har ingen åldersgräns i BraXhn TV, så de får använda musikappar (de scrobblar aldrig).
//     Profiler med skärmtid för ljud nekas: en musikapp rapporterar inte lyssnandet så att skärmtiden kan räknas.
//   - Id:n har prefix per typ (ar- artist, al- album, tr- spår, pl- spellista, sp- smart lista) så att de inte krockar.
// Svaren är XML som standard och JSON med f=json. Fel ger status="failed" med Subsonics felkoder:
// 0 övrigt, 10 parameter saknas, 40 fel namn/lösenord, 43 motstridiga inloggningssätt, 44 fel API-nyckel,
// 50 inte tillåtet, 70 finns inte.
import fs from 'node:fs';
import path from 'node:path';
import { route, user, subsonic as sub, isTrusted, remoteDenied, has2fa } from '../http/router.js';
import { get, all, run, now, tx } from '../db.js';
import { send, fail, clientIp, readJson, streamFile } from '../util.js';
import { audit, checkPw, ipBlocked, noteFail, verifyTotp } from '../auth.js';
import { ctx, householdRoot } from '../http/context.js';
import * as S from '../subsonic.js';
import * as music from '../music.js';
import * as listen from '../listening.js';
import * as scrobble from '../scrobble.js';
import * as screen from '../screentime.js';
import { sized } from '../imgsize.js';
import { status as scanStatus } from '../scanner.js';

const E = (code, msg, http) => new S.SubsonicError(code, msg, http);
const NOT_FOUND = (what) => E(70, `${what} finns inte`);

// ---------- förfrågan och svar ----------
/** Parametrarna: adressens query och (POST, OpenSubsonic formPost) formulärkroppen */
async function params(c) {
  const P = new URLSearchParams(c.q);
  if (c.req.method === 'POST' && /application\/x-www-form-urlencoded/i.test(c.req.headers['content-type'] || '')) {
    let size = 0; const chunks = [];
    for await (const ch of c.req) { size += ch.length; if (size > 1 << 20) throw E(0, 'För stor förfrågan', 413); chunks.push(ch); }
    for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) P.append(k, v);
  }
  return P;
}
function reply(c, P, payload, err = null) {
  const r = S.render(payload, P?.get('f'), err);
  send(c.res, err?.http || 200, r.body, { 'Content-Type': r.type });
}
/** Registrerar en Subsonic-metod för /rest/<namn> och /rest/<namn>.view (GET och POST; HEAD för strömmar och bilder). */
function api(name, fn, { pub = false, head = false } = {}) {
  const handler = async (c) => {
    let P = c.q;
    try {
      if (!S.enabled()) throw E(0, 'Musikappar (Subsonic) är avstängda på servern', 403);
      P = await params(c);
      if (!pub) c.user = login(c, P);
      const out = await fn(c, P);
      if (out !== undefined && !c.res.headersSent) reply(c, P, out);
    } catch (e) {
      if (!(e instanceof S.SubsonicError)) { console.error('[subsonic]', e); e = E(0, 'Internt fel'); }
      if (!c.res.headersSent) reply(c, P, null, e);
    }
  };
  for (const m of ['GET', 'POST', ...(head ? ['HEAD'] : [])]) route(m, `/rest/${name}(?:\\.view)?`, sub, handler);
}
function login(c, P) {
  const ip = clientIp(c.req), trusted = isTrusted(c.req);
  let u;
  try { u = S.authenticate(P, { ip, trusted, client: P.get('c') }); }
  catch (e) {
    if (e.code === 40 || e.code === 44) audit('subsonic_login_fail', { ip, user: { name: String(P.get('u') || '').slice(0, 64) || null }, detail: `${P.get('c') || 'okänd app'}: kod ${e.code}` });
    throw e;
  }
  const why = remoteDenied(u, c.req, true);
  if (why) { audit('subsonic_denied', { ip, user: u, detail: why }); throw E(50, why + (why.includes('Tvåsteg') ? ' – aktivera den under Mitt konto' : '')); }
  if (screen.rulesFor(u.id)?.audio) throw E(50, 'Profilen har skärmtid för ljud – den kan inte följas i musikappar. Lyssna i BraXhn TV i stället.');
  return u;
}

// ---------- id:n och hjälpare ----------
const idOf = (v, kind) => { const m = /^(ar|al|tr|pl)-([1-9]\d{0,14})$/.exec(String(v ?? '')); return m && (!kind || m[1] === kind) ? { kind: m[1], id: +m[2] } : null; };
const SMART_ID = /^sp-(\d{1,9})-(top30|forgotten|recent|never|u[1-9]\d{0,9})$/;
const need = (P, k) => { const v = P.get(k); if (v == null || v === '') throw E(10, `Parametern ${k} saknas`); return v; };
const int = (v, def, min, max) => { const n = parseInt(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; };
const iso = (s) => s ? new Date(s * 1000).toISOString() : undefined;
const likeEsc = (s) => String(s).replace(/[\\%_]/g, (x) => '\\' + x);
/** musicFolderId → biblioteks-id (null = alla musikbibliotek) */
function folder(P) {
  const v = P.get('musicFolderId');
  if (v == null || v === '') return null;
  const l = get("SELECT id FROM libraries WHERE id=? AND type='music'", parseInt(v) || 0);
  if (!l) throw NOT_FOUND('Musikmappen');
  return l.id;
}
const ME = 'WITH me(uid) AS (SELECT ?) ';
const firstLetter = (s) => { const ch = String(s || '').trim().charAt(0).toUpperCase(); return /\p{L}/u.test(ch) ? ch : '#'; };
const IGNORED = 'The A An En Ett';
const safeName = (s) => String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || '_';

// ---------- formning ----------
const MIME = { mp3: 'audio/mpeg', aac: 'audio/aac', m4a: 'audio/mp4', m4b: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', wma: 'audio/x-ms-wma', aiff: 'audio/aiff', aif: 'audio/aiff', ape: 'audio/ape', wv: 'audio/wavpack', mka: 'audio/x-matroska', alac: 'audio/mp4' };
// Samma regel som music.streamTrack: de här spelas direkt, annat kodas om
const DIRECT_EXT = new Set(['m4b', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav']);
const DIRECT_CODEC = new Set(['mp3', 'aac', 'flac', 'opus', 'vorbis', 'pcm_s16le']);
const SONG_COLS = `t.id, t.title, t.track_no, t.disc_no, t.duration, t.codec, t.bitrate, t.size, t.path, t.added, t.sample_rate, t.channels,
  t.rg_track, t.rg_album, t.rg_peak, t.album_id, t.artist_id, t.library_id, al.title AS album, al.year, al.genre, al.cover, ar.name AS artist,
  aa.name AS album_artist, al.artist_id AS album_artist_id,
  (SELECT COUNT(*) FROM track_plays p WHERE p.track_id=t.id AND p.user_id=me.uid) AS plays,
  (SELECT MAX(ts) FROM track_plays p WHERE p.track_id=t.id AND p.user_id=me.uid) AS played,
  f.track_id AS fav, COALESCE(f.created, t.added) AS fav_at`;
const SONG_FROM = `FROM me, tracks t LEFT JOIN albums al ON al.id=t.album_id LEFT JOIN artists ar ON ar.id=t.artist_id
  LEFT JOIN artists aa ON aa.id=al.artist_id LEFT JOIN favorites f ON f.track_id=t.id AND f.user_id=me.uid`;
const songs = (uid, where, params = [], order = 't.id', limit = 500, offset = 0) =>
  all(`${ME}SELECT ${SONG_COLS} ${SONG_FROM} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, uid, ...params, limit, offset).map(song);
/** Spår i given ordning (spellistor, smarta listor) */
function songsByIds(uid, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const byId = new Map(songs(uid, `t.id IN (${part.map(() => '?').join(',')})`, part, 't.id', part.length).map(s => [s.id, s]));
    for (const id of part) if (byId.has('tr-' + id)) out.push(byId.get('tr-' + id));
  }
  return out;
}
function song(t) {
  const ext = path.extname(t.path).slice(1).toLowerCase();
  const direct = DIRECT_EXT.has(ext) && DIRECT_CODEC.has(t.codec);
  return {
    id: 'tr-' + t.id, parent: t.album_id ? 'al-' + t.album_id : undefined, isDir: false, title: t.title, album: t.album ?? undefined, artist: t.artist ?? undefined,
    track: t.track_no ?? undefined, year: t.year ?? undefined, genre: t.genre || undefined, coverArt: t.cover ? 'al-' + t.album_id : undefined,
    size: t.size ?? undefined, contentType: MIME[ext] || 'application/octet-stream', suffix: ext || undefined,
    ...(direct ? {} : { transcodedContentType: 'audio/mpeg', transcodedSuffix: 'mp3' }),
    duration: Math.round(t.duration || 0), bitRate: t.bitrate ? Math.round(t.bitrate / 1000) : undefined,
    // Sökvägen är påhittad (relativ): serverns riktiga mappar lämnas inte ut
    path: `${safeName(t.album_artist || t.artist)}/${safeName(t.album)}/${t.track_no ? String(t.track_no).padStart(2, '0') + ' - ' : ''}${safeName(t.title)}${ext ? '.' + ext : ''}`,
    playCount: t.plays || 0, played: iso(t.played), discNumber: t.disc_no ?? undefined, created: iso(t.added), starred: t.fav ? iso(t.fav_at) : undefined,
    albumId: t.album_id ? 'al-' + t.album_id : undefined, artistId: t.artist_id ? 'ar-' + t.artist_id : undefined, type: 'music', isVideo: false,
    // OpenSubsonic
    mediaType: 'song', samplingRate: t.sample_rate ?? undefined, channelCount: t.channels ?? undefined,
    displayArtist: t.artist ?? undefined, displayAlbumArtist: t.album_artist ?? undefined,
    genres: t.genre ? [{ name: t.genre }] : [],
    artists: t.artist_id ? [{ id: 'ar-' + t.artist_id, name: t.artist }] : [],
    albumArtists: t.album_artist_id ? [{ id: 'ar-' + t.album_artist_id, name: t.album_artist }] : [],
    replayGain: t.rg_track != null || t.rg_album != null || t.rg_peak != null
      ? { trackGain: t.rg_track ?? undefined, albumGain: t.rg_album ?? undefined, trackPeak: t.rg_peak ?? undefined } : undefined,
  };
}
const ALBUM_COLS = `al.id, al.title, al.sort_title, al.year, al.genre, al.cover, al.added, al.library_id, al.artist_id, ar.name AS artist, ar.sort_name AS artist_sort,
  (SELECT COUNT(*) FROM tracks t WHERE t.album_id=al.id) AS songs, (SELECT SUM(duration) FROM tracks t WHERE t.album_id=al.id) AS duration,
  (SELECT COUNT(*) FROM track_plays p JOIN tracks t ON t.id=p.track_id WHERE t.album_id=al.id AND p.user_id=me.uid) AS plays,
  (SELECT MAX(p.ts) FROM track_plays p JOIN tracks t ON t.id=p.track_id WHERE t.album_id=al.id AND p.user_id=me.uid) AS played,
  s.created AS starred`;
const ALBUM_FROM = `FROM me, albums al LEFT JOIN artists ar ON ar.id=al.artist_id LEFT JOIN album_stars s ON s.album_id=al.id AND s.user_id=me.uid`;
/** Album: where/order gäller den inre frågan (alias al, ar, s) eller, med outer, de beräknade kolumnerna (plays, played, starred …) */
const albumRows = (uid, { where = '1', params = [], outer = '1', order = 'sort_title', limit = 500, offset = 0 } = {}) =>
  all(`${ME}SELECT * FROM (SELECT ${ALBUM_COLS} ${ALBUM_FROM} WHERE ${where}) x WHERE ${outer} ORDER BY ${order} LIMIT ? OFFSET ?`, uid, ...params, limit, offset);
function album(a) {
  return {
    id: 'al-' + a.id, name: a.title, title: a.title, album: a.title, artist: a.artist ?? undefined, artistId: a.artist_id ? 'ar-' + a.artist_id : undefined,
    coverArt: a.cover ? 'al-' + a.id : undefined, songCount: a.songs || 0, duration: Math.round(a.duration || 0), playCount: a.plays || 0, played: iso(a.played),
    created: iso(a.added), starred: iso(a.starred), year: a.year ?? undefined, genre: a.genre || undefined,
    // getAlbumList (utan ID3) och getMusicDirectory visar album som mappar
    parent: a.artist_id ? 'ar-' + a.artist_id : undefined, isDir: true,
    // OpenSubsonic
    sortName: a.sort_title ?? undefined, displayArtist: a.artist ?? undefined, mediaType: 'album',
    genres: a.genre ? [{ name: a.genre }] : [], artists: a.artist_id ? [{ id: 'ar-' + a.artist_id, name: a.artist }] : [],
  };
}
const ARTIST_SQL = `SELECT ar.id, ar.name, ar.sort_name, ar.library_id, (SELECT COUNT(*) FROM albums a WHERE a.artist_id=ar.id) AS albums,
  (SELECT a.id FROM albums a WHERE a.artist_id=ar.id AND a.cover=1 ORDER BY a.year DESC LIMIT 1) AS cover_album, s.created AS starred
  FROM me, artists ar LEFT JOIN artist_stars s ON s.artist_id=ar.id AND s.user_id=me.uid`;
const artist = (a) => ({ id: 'ar-' + a.id, name: a.name, coverArt: a.cover_album ? 'ar-' + a.id : undefined, albumCount: a.albums || 0,
  starred: iso(a.starred), sortName: a.sort_name ?? undefined, mediaType: 'artist' });
/** Artister som har album (albumartister), grupperade på första bokstaven */
function artistIndex(uid, lib) {
  const rows = all(`${ME}${ARTIST_SQL} WHERE EXISTS (SELECT 1 FROM albums a WHERE a.artist_id=ar.id)${lib ? ' AND ar.library_id=?' : ''} ORDER BY ar.sort_name COLLATE NOCASE`, uid, ...(lib ? [lib] : []));
  const groups = new Map();
  for (const r of rows) { const k = firstLetter(r.sort_name || r.name); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(artist(r)); }
  return [...groups].map(([name, list]) => ({ name, artist: list }));
}
const getSongRow = (uid, id) => songs(uid, 't.id=?', [id], 't.id', 1)[0] || null;
const trackFile = (P, key = 'id') => {
  const r = idOf(need(P, key), 'tr');
  const t = r && get('SELECT * FROM tracks WHERE id=?', r.id);
  if (!t) throw NOT_FOUND('Låten');
  return t;
};
const ownPlaylist = (uid, v) => {
  const r = idOf(v, 'pl');
  const p = r && get('SELECT * FROM playlists WHERE id=? AND user_id=?', r.id, uid);
  if (!p) {
    if (SMART_ID.test(String(v))) throw E(50, 'Smarta spellistor kan bara ändras i BraXhn TV');
    throw NOT_FOUND('Spellistan');
  }
  return p;
};
function playlistInfo(c, p) {
  const st = get(`SELECT COUNT(*) AS n, SUM(t.duration) AS d FROM playlist_items i JOIN tracks t ON t.id=i.track_id WHERE i.playlist_id=?`, p.id);
  const cov = get(`SELECT al.id FROM playlist_items i JOIN tracks t ON t.id=i.track_id JOIN albums al ON al.id=t.album_id AND al.cover=1 WHERE i.playlist_id=? ORDER BY i.pos LIMIT 1`, p.id);
  return { id: 'pl-' + p.id, name: p.name, comment: p.comment || undefined, owner: c.user.name, public: false, songCount: st.n || 0, duration: Math.round(st.d || 0),
    created: iso(p.created), changed: iso(p.changed || p.created), coverArt: cov ? 'al-' + cov.id : undefined, readonly: false };
}
function smartInfo(c, lib, l, multi) {
  return { id: `sp-${lib}-${l.id}`, name: multi && lib ? `${l.name} (${multi.get(lib)})` : l.name, comment: 'Smart spellista i BraXhn TV', owner: l.custom && !l.mine ? (l.owner || '') : c.user.name,
    public: !!l.shared, songCount: l.count || 0, duration: Math.round(l.duration || 0), created: iso(now()), changed: iso(now()),
    coverArt: l.covers?.length ? 'al-' + l.covers[0] : undefined, readonly: true };
}
const musicLibs = () => all("SELECT id, name FROM libraries WHERE type='music' ORDER BY name");
function smartLists(c) {
  const libs = musicLibs(), names = libs.length > 1 ? new Map(libs.map(l => [l.id, l.name])) : null;
  const out = [];
  for (const l of libs) for (const s of listen.smartLists(l.id, c.user.id)) if (!s.custom) out.push(smartInfo(c, l.id, s, names));
  // Egna/delade listor gäller alla bibliotek: en gång, med bibliotek 0
  const anyLib = libs[0]?.id;
  if (anyLib) for (const s of listen.smartLists(anyLib, c.user.id)) if (s.custom) out.push(smartInfo(c, 0, s, null));
  return out;
}
/** Sätter spellistans spår (i ordning, bara spår som finns) */
function setItems(pid, ids) {
  run('DELETE FROM playlist_items WHERE playlist_id=?', pid);
  let pos = 0;
  for (const id of ids.slice(0, 5000)) if (get('SELECT 1 FROM tracks WHERE id=?', id)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', pid, id, pos++);
}
const songIds = (P, key) => P.getAll(key).map(v => { const r = idOf(v, 'tr'); if (!r) throw NOT_FOUND('Låten ' + String(v).slice(0, 30)); return r.id; });
const nowSec = () => now();

// ---------- system ----------
api('ping', () => ({}));
api('getLicense', () => ({ license: { valid: true, email: '', licenseExpires: '2099-12-31T00:00:00.000Z' } }));
api('getOpenSubsonicExtensions', () => ({ openSubsonicExtensions: [
  { name: 'apiKeyAuthentication', versions: [1] }, { name: 'formPost', versions: [1] }, { name: 'songLyrics', versions: [1] }, { name: 'transcodeOffset', versions: [1] },
] }), { pub: true });
api('getUser', (c, P) => {
  const name = P.get('username');
  if (name && name.toLowerCase() !== c.user.name.toLowerCase()) throw E(50, 'Du kan bara se ditt eget konto');
  const libs = musicLibs().map(l => l.id);
  return { user: { username: c.user.name, email: '', scrobblingEnabled: c.user.max_age == null, adminRole: false, settingsRole: false, downloadRole: true, uploadRole: false,
    playlistRole: true, coverArtRole: false, commentRole: false, podcastRole: false, streamRole: true, jukeboxRole: false, shareRole: false, videoConversionRole: false, folder: libs } };
});
api('getScanStatus', () => ({ scanStatus: { scanning: !!scanStatus.running, count: get('SELECT COUNT(*) AS n FROM tracks').n } }));
api('getNowPlaying', () => ({ nowPlaying: { entry: [] } }));

// ---------- bläddra ----------
api('getMusicFolders', () => ({ musicFolders: { musicFolder: musicLibs().map(l => ({ id: l.id, name: l.name })) } }));
api('getIndexes', (c, P) => {
  const last = get('SELECT MAX(added) AS m FROM tracks').m || 0;
  const since = parseInt(P.get('ifModifiedSince')) || 0;
  if (since && since >= last * 1000) return { indexes: { lastModified: last * 1000, ignoredArticles: IGNORED } };
  return { indexes: { lastModified: last * 1000, ignoredArticles: IGNORED, index: artistIndex(c.user.id, folder(P)) } };
});
api('getArtists', (c, P) => ({ artists: { ignoredArticles: IGNORED, index: artistIndex(c.user.id, folder(P)) } }));
api('getArtist', (c, P) => {
  const r = idOf(need(P, 'id'), 'ar');
  const a = r && get(`${ME}${ARTIST_SQL} WHERE ar.id=?`, c.user.id, r.id);
  if (!a) throw NOT_FOUND('Artisten');
  return { artist: { ...artist(a), album: albumRows(c.user.id, { where: 'al.artist_id=?', params: [a.id], order: 'year DESC, sort_title', limit: 2000 }).map(album) } };
});
api('getArtistInfo2', (c, P) => {
  const r = idOf(need(P, 'id'), 'ar');
  if (!r || !get('SELECT 1 FROM artists WHERE id=?', r.id)) throw NOT_FOUND('Artisten');
  return { artistInfo2: {} };
});
api('getArtistInfo', (c, P) => { const r = idOf(need(P, 'id'), 'ar'); if (!r || !get('SELECT 1 FROM artists WHERE id=?', r.id)) throw NOT_FOUND('Artisten'); return { artistInfo: {} }; });
api('getAlbumInfo2', (c, P) => { const r = idOf(need(P, 'id'), 'al'); if (!r || !get('SELECT 1 FROM albums WHERE id=?', r.id)) throw NOT_FOUND('Albumet'); return { albumInfo: {} }; });
api('getAlbum', (c, P) => {
  const r = idOf(need(P, 'id'), 'al');
  const a = r && albumRows(c.user.id, { where: 'al.id=?', params: [r.id], limit: 1 })[0];
  if (!a) throw NOT_FOUND('Albumet');
  return { album: { ...album(a), song: songs(c.user.id, 't.album_id=?', [a.id], 't.disc_no, t.track_no, t.title', 5000) } };
});
api('getSong', (c, P) => {
  const r = idOf(need(P, 'id'), 'tr');
  const s = r && getSongRow(c.user.id, r.id);
  if (!s) throw NOT_FOUND('Låten');
  return { song: s };
});
// Mappvy för klienter som bläddrar i mappar: artist → album → låtar
api('getMusicDirectory', (c, P) => {
  const v = need(P, 'id'), r = idOf(v);
  if (r?.kind === 'ar') {
    const a = get('SELECT id, name FROM artists WHERE id=?', r.id);
    if (!a) throw NOT_FOUND('Artisten');
    return { directory: { id: v, name: a.name, child: albumRows(c.user.id, { where: 'al.artist_id=?', params: [a.id], order: 'year DESC, sort_title', limit: 2000 }).map(album) } };
  }
  if (r?.kind === 'al') {
    const a = albumRows(c.user.id, { where: 'al.id=?', params: [r.id], limit: 1 })[0];
    if (!a) throw NOT_FOUND('Albumet');
    return { directory: { id: v, parent: a.artist_id ? 'ar-' + a.artist_id : undefined, name: a.title, starred: iso(a.starred), playCount: a.plays || 0,
      child: songs(c.user.id, 't.album_id=?', [a.id], 't.disc_no, t.track_no, t.title', 5000) } };
  }
  throw NOT_FOUND('Mappen');
});
api('getGenres', () => ({ genres: { genre: all(`SELECT al.genre AS g, COUNT(DISTINCT al.id) AS albums, COUNT(t.id) AS songs FROM albums al JOIN tracks t ON t.album_id=al.id
  WHERE al.genre IS NOT NULL AND al.genre != '' GROUP BY al.genre COLLATE NOCASE ORDER BY al.genre COLLATE NOCASE`).map(g => ({ value: g.g, songCount: g.songs, albumCount: g.albums })) } }));

// ---------- listor ----------
function albumList(c, P) {
  const type = need(P, 'type'), size = int(P.get('size'), 10, 0, 500), offset = int(P.get('offset'), 0, 0, 1e9), lib = folder(P);
  const where = lib ? 'al.library_id=?' : '1', params = lib ? [lib] : [];
  const q = (outer, order, extra = []) => albumRows(c.user.id, { where, params: [...params, ...extra], outer, order, limit: size, offset });
  switch (type) {
    case 'random': return q('1', 'RANDOM()');
    case 'newest': return q('1', 'added DESC, id DESC');
    case 'frequent': case 'highest': return q('plays > 0', 'plays DESC, played DESC');
    case 'recent': return q('played IS NOT NULL', 'played DESC');
    case 'starred': return q('starred IS NOT NULL', 'starred DESC');
    case 'alphabeticalByName': return q('1', 'sort_title COLLATE NOCASE, id');
    case 'alphabeticalByArtist': return q('1', 'artist_sort COLLATE NOCASE, year, sort_title COLLATE NOCASE, id');
    case 'byYear': {
      const from = parseInt(need(P, 'fromYear')), to = parseInt(need(P, 'toYear'));
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw E(10, 'fromYear och toYear ska vara årtal');
      return albumRows(c.user.id, { where: `${where} AND al.year BETWEEN ? AND ?`, params: [...params, Math.min(from, to), Math.max(from, to)],
        order: from <= to ? 'year, sort_title' : 'year DESC, sort_title', limit: size, offset });
    }
    case 'byGenre': return albumRows(c.user.id, { where: `${where} AND al.genre=? COLLATE NOCASE`, params: [...params, need(P, 'genre')], order: 'sort_title COLLATE NOCASE', limit: size, offset });
    default: throw E(0, `Okänd listtyp: ${String(type).slice(0, 40)}`);
  }
}
api('getAlbumList2', (c, P) => ({ albumList2: { album: albumList(c, P).map(album) } }));
api('getAlbumList', (c, P) => ({ albumList: { album: albumList(c, P).map(album) } }));
function songFilter(P) {
  const w = [], p = [];
  const lib = folder(P); if (lib) { w.push('t.library_id=?'); p.push(lib); }
  const genre = P.get('genre'); if (genre) { w.push('al.genre=? COLLATE NOCASE'); p.push(genre); }
  const from = parseInt(P.get('fromYear')), to = parseInt(P.get('toYear'));
  if (Number.isFinite(from)) { w.push('al.year>=?'); p.push(from); }
  if (Number.isFinite(to)) { w.push('al.year<=?'); p.push(to); }
  return { where: w.length ? w.join(' AND ') : '1', params: p };
}
api('getRandomSongs', (c, P) => {
  const f = songFilter(P);
  return { randomSongs: { song: songs(c.user.id, f.where, f.params, 'RANDOM()', int(P.get('size'), 10, 0, 500)) } };
});
api('getSongsByGenre', (c, P) => {
  need(P, 'genre');
  const f = songFilter(P);
  return { songsByGenre: { song: songs(c.user.id, f.where, f.params, 'al.sort_title, t.disc_no, t.track_no', int(P.get('count'), 10, 0, 500), int(P.get('offset'), 0, 0, 1e9)) } };
});
api('getTopSongs', (c, P) => {
  const name = need(P, 'artist');
  return { topSongs: { song: songs(c.user.id, `(ar.name=? COLLATE NOCASE OR aa.name=? COLLATE NOCASE) AND plays > 0`, [name, name], 'plays DESC, t.title', int(P.get('count'), 50, 0, 500)) } };
});
// Sök: varje ord måste finnas. Tom fråga ("" eller utan query) ger allt – Symfonium och andra synkar biblioteket så, sida för sida.
api('search3', (c, P) => {
  const raw = String(P.get('query') ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/\*$/, '').trim();
  const words = raw.split(/\s+/).filter(Boolean).slice(0, 8);
  const lib = folder(P);
  const match = (cols) => {
    const w = words.map(() => `(${cols.map(col => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    return { sql: w.length ? w.join(' AND ') : '1', params: words.flatMap(x => cols.map(() => `%${likeEsc(x)}%`)) };
  };
  const cnt = (k) => int(P.get(k + 'Count'), 20, 0, 1000), off = (k) => int(P.get(k + 'Offset'), 0, 0, 1e9);
  const ma = match(['ar.name']), mal = match(['al.title', 'ar.name']), ms = match(['t.title', 'ar.name', 'al.title']);
  const libA = lib ? ' AND ar.library_id=?' : '', libAl = lib ? ' AND al.library_id=?' : '', libT = lib ? ' AND t.library_id=?' : '', L = lib ? [lib] : [];
  return { searchResult3: {
    artist: cnt('artist') ? all(`${ME}${ARTIST_SQL} WHERE EXISTS (SELECT 1 FROM albums a WHERE a.artist_id=ar.id) AND ${ma.sql}${libA} ORDER BY ar.sort_name COLLATE NOCASE, ar.id LIMIT ? OFFSET ?`,
      c.user.id, ...ma.params, ...L, cnt('artist'), off('artist')).map(artist) : [],
    album: cnt('album') ? albumRows(c.user.id, { where: `${mal.sql}${libAl}`, params: [...mal.params, ...L], order: 'sort_title COLLATE NOCASE, id', limit: cnt('album'), offset: off('album') }).map(album) : [],
    song: cnt('song') ? songs(c.user.id, `${ms.sql}${libT}`, [...ms.params, ...L], words.length ? 't.title COLLATE NOCASE, t.id' : 't.id', cnt('song'), off('song')) : [],
  } };
});

// ---------- spellistor ----------
api('getPlaylists', (c, P) => {
  const name = P.get('username');
  if (name && name.toLowerCase() !== c.user.name.toLowerCase()) throw E(50, 'Du kan bara se dina egna spellistor');
  const own = all('SELECT * FROM playlists WHERE user_id=? ORDER BY name COLLATE NOCASE', c.user.id).map(p => playlistInfo(c, p));
  return { playlists: { playlist: [...own, ...smartLists(c)] } };
});
function playlistPayload(c, v) {
  const m = SMART_ID.exec(String(v));
  if (m) {
    const lib = +m[1], sid = m[2];
    const custom = sid.startsWith('u');
    if (!custom && !get("SELECT 1 FROM libraries WHERE id=? AND type='music'", lib)) throw NOT_FOUND('Spellistan');
    const tracks = listen.smartTracks(custom ? (musicLibs()[0]?.id || 0) : lib, c.user.id, sid);
    if (!tracks) throw NOT_FOUND('Spellistan');
    const entry = songsByIds(c.user.id, tracks.map(t => t.id));
    const cl = custom ? listen.smartLists(musicLibs()[0]?.id || 0, c.user.id).find(s => s.id === sid) : null;
    return { playlist: { ...smartInfo(c, lib, { id: sid, name: listen.smartName(sid, c.user.id) || sid, count: entry.length,
      duration: entry.reduce((a, s) => a + s.duration, 0), covers: entry.filter(s => s.coverArt).map(s => s.coverArt.slice(3)), custom, mine: cl?.mine ?? true, owner: cl?.owner, shared: cl?.shared }, null), entry } };
  }
  const p = ownPlaylist(c.user.id, v);
  const ids = all('SELECT track_id FROM playlist_items WHERE playlist_id=? ORDER BY pos', p.id).map(r => r.track_id);
  return { playlist: { ...playlistInfo(c, p), entry: songsByIds(c.user.id, ids) } };
}
api('getPlaylist', (c, P) => playlistPayload(c, need(P, 'id')));
api('createPlaylist', (c, P) => {
  const ids = songIds(P, 'songId');
  const existing = P.get('playlistId');
  if (existing) {
    const p = ownPlaylist(c.user.id, existing);
    tx(() => { setItems(p.id, ids); if (P.get('name')) run('UPDATE playlists SET name=? WHERE id=?', String(P.get('name')).trim().slice(0, 100) || p.name, p.id); run('UPDATE playlists SET changed=? WHERE id=?', nowSec(), p.id); });
    return playlistPayload(c, 'pl-' + p.id);
  }
  const name = String(need(P, 'name')).trim().slice(0, 100);
  if (!name) throw E(10, 'Parametern name saknas');
  if (get('SELECT COUNT(*) AS n FROM playlists WHERE user_id=?', c.user.id).n >= 200) throw E(0, 'För många spellistor');
  const id = tx(() => { const id = Number(run('INSERT INTO playlists(user_id,name,created,changed) VALUES(?,?,?,?)', c.user.id, name, nowSec(), nowSec()).lastInsertRowid); setItems(id, ids); return id; });
  return playlistPayload(c, 'pl-' + id);
});
api('updatePlaylist', (c, P) => {
  const p = ownPlaylist(c.user.id, need(P, 'playlistId'));
  const add = songIds(P, 'songIdToAdd');
  const remove = new Set(P.getAll('songIndexToRemove').map(v => parseInt(v)).filter(Number.isFinite));
  tx(() => {
    if (P.get('name') != null && String(P.get('name')).trim()) run('UPDATE playlists SET name=? WHERE id=?', String(P.get('name')).trim().slice(0, 100), p.id);
    if (P.get('comment') != null) run('UPDATE playlists SET comment=? WHERE id=?', String(P.get('comment')).slice(0, 500) || null, p.id);
    if (add.length || remove.size) {
      const cur = all('SELECT track_id FROM playlist_items WHERE playlist_id=? ORDER BY pos', p.id).map(r => r.track_id);
      setItems(p.id, [...cur.filter((_, i) => !remove.has(i)), ...add]);
    }
    run('UPDATE playlists SET changed=? WHERE id=?', nowSec(), p.id);
  });
  return {};
});
api('deletePlaylist', (c, P) => { const p = ownPlaylist(c.user.id, need(P, 'id')); run('DELETE FROM playlists WHERE id=?', p.id); return {}; });

// ---------- stjärnor (favoriter) ----------
function starTargets(P) {
  const t = { tr: [], al: [], ar: [] };
  for (const v of P.getAll('id')) { const r = idOf(v); if (!r || r.kind === 'pl') throw NOT_FOUND(String(v).slice(0, 30)); t[r.kind].push(r.id); }
  for (const v of P.getAll('albumId')) { const r = idOf(v, 'al'); if (!r) throw NOT_FOUND(String(v).slice(0, 30)); t.al.push(r.id); }
  for (const v of P.getAll('artistId')) { const r = idOf(v, 'ar'); if (!r) throw NOT_FOUND(String(v).slice(0, 30)); t.ar.push(r.id); }
  if (!t.tr.length && !t.al.length && !t.ar.length) throw E(10, 'Ange id, albumId eller artistId');
  return t;
}
api('star', (c, P) => {
  const t = starTargets(P), uid = c.user.id, at = nowSec();
  tx(() => {
    for (const id of t.tr) if (get('SELECT 1 FROM tracks WHERE id=?', id)) run('INSERT OR IGNORE INTO favorites(user_id,track_id,created) VALUES(?,?,?)', uid, id, at);
    for (const id of t.al) if (get('SELECT 1 FROM albums WHERE id=?', id)) run('INSERT OR IGNORE INTO album_stars(user_id,album_id,created) VALUES(?,?,?)', uid, id, at);
    for (const id of t.ar) if (get('SELECT 1 FROM artists WHERE id=?', id)) run('INSERT OR IGNORE INTO artist_stars(user_id,artist_id,created) VALUES(?,?,?)', uid, id, at);
  });
  return {};
});
api('unstar', (c, P) => {
  const t = starTargets(P), uid = c.user.id;
  tx(() => {
    for (const id of t.tr) run('DELETE FROM favorites WHERE user_id=? AND track_id=?', uid, id);
    for (const id of t.al) run('DELETE FROM album_stars WHERE user_id=? AND album_id=?', uid, id);
    for (const id of t.ar) run('DELETE FROM artist_stars WHERE user_id=? AND artist_id=?', uid, id);
  });
  return {};
});
function starred(c, P) {
  const lib = folder(P), uid = c.user.id;
  return {
    artist: all(`${ME}${ARTIST_SQL} WHERE s.created IS NOT NULL${lib ? ' AND ar.library_id=?' : ''} ORDER BY s.created DESC`, uid, ...(lib ? [lib] : [])).map(artist),
    album: albumRows(uid, { where: lib ? 'al.library_id=?' : '1', params: lib ? [lib] : [], outer: 'starred IS NOT NULL', order: 'starred DESC', limit: 5000 }).map(album),
    song: songs(uid, `f.track_id IS NOT NULL${lib ? ' AND t.library_id=?' : ''}`, lib ? [lib] : [], 'fav_at DESC, t.id', 5000),
  };
}
api('getStarred2', (c, P) => ({ starred2: starred(c, P) }));
api('getStarred', (c, P) => ({ starred: starred(c, P) }));

// ---------- lyssning ----------
// submission=true (standard): appen har räknat låten som lyssnad → lyssning (spelräknare, smarta listor) och scrobbling.
// submission=false: "spelas nu" hos ListenBrainz/Last.fm. time = när låten spelades (ms).
api('scrobble', (c, P) => {
  const ids = P.getAll('id');
  if (!ids.length) throw E(10, 'Parametern id saknas');
  const times = P.getAll('time'), submission = String(P.get('submission') ?? 'true').toLowerCase() !== 'false';
  const at = nowSec();
  ids.forEach((v, i) => {
    const r = idOf(v, 'tr');
    if (!r || !get('SELECT 1 FROM tracks WHERE id=?', r.id)) throw NOT_FOUND('Låten');
    if (!submission) { scrobble.nowPlayingOnly(c.user, r.id).catch(() => {}); return; }
    const ms = parseInt(times[i]);
    const ts = Number.isFinite(ms) && ms > 0 ? Math.min(at, Math.floor(ms / 1000)) : at;
    // En app som skickar om sin kö (offline) räknas inte två gånger
    if (!get('SELECT 1 FROM track_plays WHERE user_id=? AND track_id=? AND ts=?', c.user.id, r.id, ts)) run('INSERT INTO track_plays(user_id,track_id,ts) VALUES(?,?,?)', c.user.id, r.id, ts);
    scrobble.listened(c.user, r.id, ts, at);
  });
  return {};
});

// ---------- strömmar, nedladdning, omslag och låttexter ----------
function raw(c, t, attachment) {
  let st; try { st = fs.statSync(t.path); } catch { throw NOT_FOUND('Filen'); }
  const ext = path.extname(t.path).slice(1).toLowerCase();
  const fname = path.basename(t.path).replace(/[\u0000-\u001f"\\]/g, '_');
  streamFile(c.req, c.res, t.path, st.size, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600',
    ...(attachment ? { 'Content-Disposition': `attachment; filename="${fname.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fname)}` } : {}) });
}
function screenCheck(c) {
  const s = screen.check(c.user.id, { audio: true });
  if (s) throw E(50, s.message || 'Skärmtiden är slut');
}
// format: mp3/aac (omkodning vid behov), raw = filen som den är. maxBitRate i kbit/s. timeOffset (sekunder) vid omkodning.
api('stream', (c, P) => {
  const t = trackFile(P);
  screenCheck(c);
  const fmt = String(P.get('format') || '').toLowerCase();
  if (fmt === 'raw') return raw(c, t, false);
  const q = new URLSearchParams();
  // Utan format: filen direkt om den går att spela, annars MP3 (säkrast för alla spelare)
  q.set('a', fmt === 'mp3' ? 'mp3' : ['aac', 'm4a', 'mp4', 'adts'].includes(fmt) ? 'aac' : fmt ? 'mp3' : `${t.codec || 'x'},mp3`);
  const br = int(P.get('maxBitRate'), 0, 0, 320);
  if (br) q.set('br', String(Math.max(32, br)));
  const off = parseFloat(P.get('timeOffset'));
  if (off > 0) q.set('ss', String(off));
  music.streamTrack(c.req, c.res, t, q, c.user.id);
}, { head: true });
api('download', (c, P) => { raw(c, trackFile(P), true); }, { head: true });
api('getCoverArt', async (c, P) => {
  const v = need(P, 'id'), r = idOf(v);
  let alb = null;
  if (r?.kind === 'al') alb = r.id;
  else if (r?.kind === 'tr') alb = get('SELECT album_id FROM tracks WHERE id=?', r.id)?.album_id;
  else if (r?.kind === 'ar') alb = get('SELECT id FROM albums WHERE artist_id=? AND cover=1 ORDER BY year DESC LIMIT 1', r.id)?.id;
  else if (r?.kind === 'pl') alb = get(`SELECT al.id FROM playlists p JOIN playlist_items i ON i.playlist_id=p.id JOIN tracks t ON t.id=i.track_id JOIN albums al ON al.id=t.album_id AND al.cover=1
    WHERE p.id=? AND p.user_id=? ORDER BY i.pos LIMIT 1`, r.id, c.user.id)?.id;
  const f = alb ? music.coverPath(alb) : null;
  if (!f) throw E(70, 'Omslaget finns inte', 404);
  const size = int(P.get('size'), 0, 0, 4000);
  const data = await fs.promises.readFile(await sized(f, size ? String(size) : null)).catch(() => null);
  if (!data) throw E(70, 'Omslaget finns inte', 404);
  send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800' });
}, { head: true });
api('getLyrics', async (c, P) => {
  const a = String(P.get('artist') || '').trim(), ti = String(P.get('title') || '').trim();
  if (!ti) return { lyrics: {} };
  const t = get(`SELECT t.* FROM tracks t LEFT JOIN artists ar ON ar.id=t.artist_id LEFT JOIN albums al ON al.id=t.album_id LEFT JOIN artists aa ON aa.id=al.artist_id
    WHERE t.title=? COLLATE NOCASE AND (?='' OR ar.name=? COLLATE NOCASE OR aa.name=? COLLATE NOCASE) LIMIT 1`, ti, a, a, a);
  if (!t) return { lyrics: {} };
  const l = await listen.lyricsFor(t);
  if (!l.lines.length) return { lyrics: {} };
  const who = get('SELECT name FROM artists WHERE id=?', t.artist_id)?.name;
  return { lyrics: { artist: who || a || undefined, title: t.title, value: l.lines.map(x => x.text).join('\n') } };
});
api('getLyricsBySongId', async (c, P) => {
  const t = trackFile(P);
  const l = await listen.lyricsFor(t);
  if (!l.lines.length) return { lyricsList: { structuredLyrics: [] } };
  const who = get('SELECT name FROM artists WHERE id=?', t.artist_id)?.name;
  return { lyricsList: { structuredLyrics: [{ displayArtist: who || undefined, displayTitle: t.title, lang: 'und', synced: l.synced, offset: 0,
    line: l.lines.map(x => (l.synced ? { start: Math.round(x.t * 1000), value: x.text } : { value: x.text })) }] } };
});
// Allt annat under /rest/: inte inbyggt (podcaster, radio, delning, jukebox …)
route('GET', '/rest/.*', sub, (c) => reply(c, c.q, null, E(0, 'Funktionen stöds inte av BraXhn TV', 404)));
route('POST', '/rest/.*', sub, (c) => reply(c, c.q, null, E(0, 'Funktionen stöds inte av BraXhn TV', 404)));

// ---------- Mitt konto: app-lösenord för musikappar ----------
const accountInfo = (c) => ({ enabled: S.enabled(), username: c.user.name, atHome: isTrusted(c.req), ...S.info(c.user.id),
  profile: c.user.parent_id != null, screenTimeAudio: !!screen.rulesFor(c.user.id)?.audio });
route('GET', '/api/me/subsonic', user, (c) => send(c.res, 200, accountInfo(c)));
// Skapa (eller byt) app-lösenordet. Kräver kontots lösenord (huvudkontots för profiler). Utanför hemmet dessutom en kod
// från autentiseringsappen – lösenordet ger långvarig åtkomst till musiken utan 2FA, så det får inte kunna skapas med
// bara en stulen session eller ett läckt kontolösenord.
route('POST', '/api/me/subsonic', user, async (c) => {
  if (!S.enabled()) return fail(c.res, 403, 'Musikappar är avstängda av administratören');
  const ip = clientIp(c.req);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund');
  const { password, code } = await readJson(c.req);
  const root = get('SELECT id, name, pass, totp_enabled, totp_secret, totp_last FROM users WHERE id=?', householdRoot(c.user));
  if (!root || !await checkPw(String(password || ''), root.pass)) { noteFail(ip, root?.name); return fail(c.res, 400, 'Fel lösenord'); }
  const trusted = isTrusted(c.req);
  if (!trusted) {
    if (!root.totp_enabled) return fail(c.res, 403, 'Utanför hemmet kan lösenord för musikappar bara skapas om kontot har tvåstegsverifiering med autentiseringsapp. Skapa det hemifrån.');
    const fresh = get('SELECT totp_secret, totp_last FROM users WHERE id=?', root.id);
    const step = verifyTotp(fresh.totp_secret, code, fresh.totp_last);
    if (step < 0) { noteFail(ip, root.name); return send(c.res, 401, { error: code ? 'Fel kod' : 'Ange koden från din autentiseringsapp', need2fa: true }); }
    run('UPDATE users SET totp_last=? WHERE id=?', step, root.id);
  }
  const secret = S.createPassword(c.user.id, { ip, trusted });
  audit('subsonic_password_created', { ...ctx(c), detail: trusted ? 'hemifrån' : 'utifrån med tvåstegskod' });
  // Lösenordet visas bara i det här svaret
  send(c.res, 200, { ...accountInfo(c), password: secret, path: '/rest', has2fa: has2fa(c.user) });
});
route('DELETE', '/api/me/subsonic', user, (c) => {
  if (S.revokePassword(c.user.id)) audit('subsonic_password_revoked', ctx(c));
  send(c.res, 200, accountInfo(c));
});
