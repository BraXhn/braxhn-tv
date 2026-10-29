// Musik: album, artister, spår, spellistor, smarta listor, låttexter och lyssningsinställningar.
import fs from 'node:fs';
import path from 'node:path';
import { get, run, now, all, tx } from '../db.js';
import { fail, send, clientIp, readJson, streamFile, MIME } from '../util.js';
import { createSession, audit } from '../auth.js';
import * as music from '../music.js';
import * as listen from '../listening.js';
import * as scrobble from '../scrobble.js';
import * as smartl from '../smartlists.js';
import * as ratings from '../ratings.js';
import * as sonic from '../sonic.js';
import * as mmeta from '../musicmeta.js';
import * as mvideo from '../musicvideos.js';
import { serveRemux } from '../trailers.js';
import { sized } from '../imgsize.js';
import { route, user, img, audio, admin, pub } from '../http/router.js';
import { screenBlock, libOk, ctx, canDownload } from '../http/context.js';

// ---------- Musik ----------
// Bibliotek, album, artister och spår kontrolleras mot användarens rättigheter (perms.js): otillåtet = finns inte
const musicLib = (c) => { const l = get("SELECT * FROM libraries WHERE id=? AND type='music'", +c.p.lib); if (!l || !libOk(c.user.id, l.id)) { fail(c.res, 404, 'Inget musikbibliotek'); return null; } return l; };
/** Spår som användaren får se (för spellistor) */
const trackOk = (uid, id) => { const t = get('SELECT library_id FROM tracks WHERE id=?', +id); return !!t && libOk(uid, t.library_id); };
route('GET', '/api/music/:lib/home', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, { library: l, ...music.musicHome(l.id, c.user.id), playlists: music.playlists(c.user.id), smart: listen.smartLists(l.id, c.user.id), sonic: sonic.libraryStats(l.id) }); });
route('GET', '/api/music/:lib/albums', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, music.albums(l.id, c.q.get('sort') || 'title')); });
route('GET', '/api/music/:lib/artists', user, (c) => {
  const l = musicLib(c); if (!l) return;
  // image = artistbild från nätet/mappen finns (tillägg; cover_album gäller som förut)
  const photos = new Set(all('SELECT m.artist_id FROM artist_meta m JOIN artists a ON a.id=m.artist_id WHERE a.library_id=? AND m.image=1', l.id).map(r => r.artist_id));
  send(c.res, 200, music.artists(l.id).map(a => ({ ...a, image: photos.has(a.id) })));
});
route('GET', '/api/music/:lib/search', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, music.searchMusic(String(c.q.get('q') || '').slice(0, 100), c.user.id, l.id)); });
route('GET', '/api/music/albums/:aid', user, (c) => {
  const a = music.album(+c.p.aid, c.user.id);
  if (!a) return fail(c.res, 404, 'Finns inte');
  // Tillägg: typ (album/single/ep/compilation/live …, gissad utan MusicBrainz) och beskrivning från Wikipedia
  const info = mmeta.albumInfoOf(a.id), k = mmeta.albumKind(a, info ? { kind: info.type } : null);
  // Tillägg: egna betyg (userRating i stjärnor) för albumet och låtarna – bara när de finns
  ratings.annotate(c.user.id, 'track', a.trackList);
  // Tillägg: musikvideor till albumets låtar (videos, tom lista om inga)
  send(c.res, 200, { ...a, userRating: ratings.toStars(ratings.getOne(c.user.id, 'album', a.id)), type: k.kind, typeGuessed: k.guessed, info, videos: mvideo.albumVideos(a.id) });
});
// Offline i webbappen: albumets spår med kortlivade länkar (en mediatoken per spår, scope −spårets id).
// Räknas som nedladdning (perms.js). a = ljudformat webbläsaren spelar – annat kodas om (då utan Range).
route('GET', '/api/music/albums/:aid/offline', user, (c) => {
  if (!canDownload(c.user.id)) return fail(c.res, 403, 'Ditt konto får inte ladda ner');
  const a = music.album(+c.p.aid, c.user.id);
  if (!a) return fail(c.res, 404, 'Finns inte');
  const caps = encodeURIComponent(String(c.q.get('a') || 'mp3,aac,flac').replace(/[^a-z0-9,]/g, '').slice(0, 60));
  const ip = clientIp(c.req);
  send(c.res, 200, { id: a.id, title: a.title, artist: a.artist, artistId: a.artistId, year: a.year, cover: a.cover, duration: a.duration,
    tracks: a.trackList.map(t => ({ id: t.id, title: t.title, track: t.track, disc: t.disc, duration: t.duration, artist: t.artist, codec: t.codec, gain: t.gain, peak: t.peak,
      albumGain: t.albumGain, albumPeak: t.albumPeak, gapless: t.gapless,
      url: `/api/music/tracks/${t.id}/stream?a=${caps}&t=${createSession(c.user.id, 'media', { item: -t.id, ip })}` })) });
});
route('GET', '/api/music/artists/:arid', user, (c) => {
  const a = music.artist(+c.p.arid, c.user.id);
  if (!a) return fail(c.res, 404, 'Finns inte');
  // Tillägg: metadata från nätet (biografi, född/bildad, ursprung, genrer, länkar), artistbild, albumtyper och relaterade artister
  const kinds = new Map(all('SELECT m.album_id, m.kind FROM album_meta m JOIN albums al ON al.id=m.album_id WHERE al.artist_id=?', a.id).map(r => [r.album_id, r.kind]));
  const info = mmeta.artistInfo(a.id);
  ratings.annotate(c.user.id, 'track', a.popular);
  send(c.res, 200, { ...a, albums: a.albums.map(x => { const k = mmeta.albumKind(x, { kind: kinds.get(x.id) || null }); return { ...x, type: k.kind, typeGuessed: k.guessed }; }),
    image: !!info?.image, backdrop: !!info?.backdrop, info, related: mmeta.relatedLocal(a.id), videos: mvideo.artistVideos(a.id) });
});
// ---------- Musikvideor (server/musicvideos.js) ----------
// Samma rättigheter som musiken (bibliotek per användare), skärmtid gäller (det är video). Strömmen har mediatoken
// för just den videon (MV_SCOPE + id) – webben använder kakan, appar och Chromecast /play.
const mvRow = (c) => { const v = mvideo.videoFor(c.user.id, +c.p.vid); if (!v) fail(c.res, 404, 'Videon finns inte'); return v; };
route('GET', '/api/music/videos/:vid', user, (c) => {
  const v = mvRow(c); if (!v) return;
  const track = v.track_id ? get('SELECT id, title, album_id FROM tracks WHERE id=?', v.track_id) : null;
  send(c.res, 200, { ...mvideo.shapeVideo(v), track: track ? { id: track.id, title: track.title, albumId: track.album_id } : null,
    more: v.artist_id ? mvideo.artistVideos(v.artist_id).filter(x => x.id !== v.id).slice(0, 30) : [] });
});
const mvStream = { auth: true, media: true, scope: (p) => mvideo.MV_SCOPE + (+p.vid) };
const serveMv = (c) => {
  const v = mvRow(c); if (!v) return;
  if (screenBlock(c)) return;
  fs.stat(v.path, async (e, s) => {
    if (e || !s.isFile()) return fail(c.res, 404, 'Filen finns inte längre');
    if (c.q.get('mp4') === '1') { if (!await serveRemux(c.req, c.res, v.path)) fail(c.res, 503, 'Servern gör redan om andra filer – försök igen om en stund'); return; }
    streamFile(c.req, c.res, v.path, s.size, { 'Content-Type': MIME[path.extname(v.path).toLowerCase()] || 'video/mp4', 'Cache-Control': 'private, no-transform' });
  });
};
route('GET', '/api/music/videos/:vid/stream', mvStream, serveMv);
route('HEAD', '/api/music/videos/:vid/stream', mvStream, serveMv);
route('GET', '/api/music/videos/:vid/play', user, (c) => {
  const v = mvRow(c); if (!v) return;
  if (screenBlock(c)) return;
  const token = c.user.via !== 'cookie' ? createSession(c.user.id, 'media', { item: mvideo.MV_SCOPE + v.id, ip: clientIp(c.req) }) : null;
  const q = token ? '?t=' + token : '';
  send(c.res, 200, { url: `/api/music/videos/${v.id}/stream${q}`, mp4: `/api/music/videos/${v.id}/stream${q ? q + '&' : '?'}mp4=1`, mime: MIME[path.extname(v.path).toLowerCase()] || 'video/mp4' });
});
route('GET', '/api/music/videos/:vid/thumb', img, async (c) => {
  const v = mvideo.videoFor(c.user.id, +c.p.vid);
  if (!v?.thumb) return fail(c.res, 404, 'Ingen bild');
  const f = mvideo.thumbFile(v.id);
  fs.readFile(await sized(f, c.q.get('w')), (e, data) => e ? fail(c.res, 404, 'Ingen bild') : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }));
});
// Artistbild och bakgrund (från nätet eller artist.jpg i mappen)
const artistImage = (kind) => async (c) => {
  // Bara artister i bibliotek som användaren får se (rättigheter per användare)
  const lib = get('SELECT library_id FROM artists WHERE id=?', +c.p.arid)?.library_id;
  if (lib == null || !libOk(c.user.id, lib)) return fail(c.res, 404, 'Ingen bild');
  const f = mmeta.photoPath(+c.p.arid, kind);
  if (!f) return fail(c.res, 404, 'Ingen bild');
  fs.readFile(await sized(f, c.q.get('w')), (e, data) => e ? fail(c.res, 404, '') : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }));
};
route('GET', '/api/music/artists/:arid/image', img, artistImage('photo'));
route('GET', '/api/music/artists/:arid/backdrop', img, artistImage('bg'));
// Signerad bildadress för musikappar (Subsonic getArtistInfo2/getAlbumInfo2): utan inloggning, men signaturen gäller bara
// just den bilden (HMAC med en nyckel i inställningarna) – samma sätt som Navidrome lämnar ut bildadresser
route('GET', '/api/music/pubimg/:kind/:id/:sig', pub, async (c) => {
  const kind = c.p.kind, id = parseInt(c.p.id);
  if (!['artist', 'album'].includes(kind) || !(id > 0) || !mmeta.checkImageSig(kind, id, c.p.sig)) return fail(c.res, 404, 'Ingen bild');
  const f = kind === 'artist' ? (mmeta.photoPath(id) || music.coverPath(get('SELECT id FROM albums WHERE artist_id=? AND cover=1 ORDER BY year DESC LIMIT 1', id)?.id || 0)) : music.coverPath(id);
  if (!f) return fail(c.res, 404, 'Ingen bild');
  fs.readFile(await sized(f, c.q.get('w')), (e, data) => e ? fail(c.res, 404, '') : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }));
});
// "Fel artist?" (administratör): sök i MusicBrainz och välj rätt artist – matchningen låses
const artistOr404 = (c) => { const a = get('SELECT id, name, library_id FROM artists WHERE id=?', +c.p.arid); if (!a) fail(c.res, 404, 'Finns inte'); return a; };
route('GET', '/api/music/artists/:arid/match', admin, async (c) => {
  const a = artistOr404(c); if (!a) return;
  const m = mmeta.artistInfo(a.id);
  try {
    const res = await mmeta.search(String(c.q.get('q') ?? a.name).slice(0, 200));
    send(c.res, 200, { current: m?.mbid ? { mbid: m.mbid, name: m.name } : null, locked: !!m?.locked, state: m?.state ?? 0,
      results: res.slice(0, 15).map(x => ({ mbid: x.mbid, name: x.name, disambiguation: x.disambiguation, type: x.type, country: x.country, area: x.area, begin: x.begin, score: x.score })) });
  } catch (e) { fail(c.res, 502, 'Sökningen misslyckades: ' + e.message); }
});
route('POST', '/api/music/artists/:arid/match', admin, async (c) => {
  const a = artistOr404(c); if (!a) return;
  const { mbid, unlock, refresh, none } = await readJson(c.req);
  try {
    if (unlock) { mmeta.unlock(a.id); mmeta.queue(a.library_id); return send(c.res, 200, { ok: true }); }
    if (none) { mmeta.clearMatch(a.id); audit('artist_matched', { ...ctx(c), detail: `${a.name} → ingen` }); return send(c.res, 200, { ok: true }); }
    if (refresh) {
      const m = mmeta.artistInfo(a.id);
      const ok = await mmeta.refreshArtist(a.id, { mbid: m?.mbid || null, locked: !!m?.locked });
      return send(c.res, 200, { ok: true, matched: !!ok });
    }
    if (!(await mmeta.matchManual(a.id, String(mbid || '').toLowerCase()))) return fail(c.res, 404, 'Artisten hittades inte i MusicBrainz');
    audit('artist_matched', { ...ctx(c), detail: `${a.name} → ${String(mbid).slice(0, 40)}` });
    send(c.res, 200, { ok: true });
  } catch (e) { fail(c.res, e.status || 502, e.status ? e.message : 'Hämtningen misslyckades: ' + e.message); }
});
// Inställningar och förlopp för metadata och låttexter från nätet (administrationen)
route('GET', '/api/music/meta', admin, (c) => send(c.res, 200, mmeta.adminInfo()));
route('PUT', '/api/music/meta', admin, async (c) => {
  try { send(c.res, 200, mmeta.configure(await readJson(c.req))); } catch (e) { fail(c.res, e.status || 400, e.message); }
});
route('GET', '/api/music/cover/:aid', img, async (c) => {
  const al = get('SELECT library_id FROM albums WHERE id=?', +c.p.aid);
  if (!al || !libOk(c.user.id, al.library_id)) return fail(c.res, 404, 'Inget omslag');
  const f = music.coverPath(+c.p.aid);
  if (!f) return fail(c.res, 404, 'Inget omslag');
  fs.readFile(await sized(f, c.q.get('w')), (e, data) => e ? fail(c.res, 404, '') : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800' }));
});
const trackRow = (c) => { const t = get('SELECT * FROM tracks WHERE id=?', +c.p.tid); if (!t || !libOk(c.user.id, t.library_id)) { fail(c.res, 404, 'Spåret finns inte'); return null; } return t; };
route('GET', '/api/music/tracks/:tid/stream', audio, (c) => { const t = trackRow(c); if (t && !screenBlock(c, { audio: true })) music.streamTrack(c.req, c.res, t, c.q, c.user.id); });
route('HEAD', '/api/music/tracks/:tid/stream', audio, (c) => { const t = trackRow(c); if (t && !screenBlock(c, { audio: true })) music.streamTrack(c.req, c.res, t, c.q, c.user.id); });
// Kortlivad länk till ett spår (för appar, Chromecast och AirPlay)
route('GET', '/api/music/tracks/:tid/play', user, (c) => {
  const t = trackRow(c); if (!t || screenBlock(c, { audio: true })) return;
  const tok = createSession(c.user.id, 'media', { item: -t.id, ip: clientIp(c.req) });
  send(c.res, 200, { url: `/api/music/tracks/${t.id}/stream?t=${tok}` });
});
route('POST', '/api/music/tracks/:tid/played', user, (c) => {
  const t = trackRow(c); if (!t) return;
  run('INSERT INTO track_plays(user_id,track_id,ts) VALUES(?,?,?)', c.user.id, t.id, now());
  // Webben och apparna anropar detta när ett spår startar: "spelas nu" + väntande lyssning för ListenBrainz/Last.fm
  scrobble.played(c.user, t.id).catch(() => {});
  send(c.res, 200, { ok: true });
});
route('POST', '/api/music/tracks/:tid/favorite', user, async (c) => {
  const t = trackRow(c); if (!t) return;
  const { on } = await readJson(c.req);
  if (on === false) run('DELETE FROM favorites WHERE user_id=? AND track_id=?', c.user.id, t.id);
  else run('INSERT OR IGNORE INTO favorites(user_id,track_id) VALUES(?,?)', c.user.id, t.id);
  send(c.res, 200, { ok: true });
});
route('GET', '/api/music/playlists', user, (c) => send(c.res, 200, music.playlists(c.user.id)));
route('POST', '/api/music/playlists', user, async (c) => {
  const { name, trackIds } = await readJson(c.req);
  const nm = String(name || '').trim().slice(0, 100);
  if (!nm) return fail(c.res, 400, 'Namn krävs');
  if (all('SELECT id FROM playlists WHERE user_id=?', c.user.id).length >= 200) return fail(c.res, 400, 'För många spellistor');
  const id = tx(() => {
    const id = Number(run('INSERT INTO playlists(user_id,name,created) VALUES(?,?,?)', c.user.id, nm, now()).lastInsertRowid);
    (Array.isArray(trackIds) ? trackIds.slice(0, 5000) : []).forEach((t, i) => { if (trackOk(c.user.id, t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', id, +t, i); });
    return id;
  });
  send(c.res, 200, { id });
});
route('GET', '/api/music/playlists/:pid', user, (c) => { const p = music.playlist(+c.p.pid, c.user.id); if (p) ratings.annotate(c.user.id, 'track', p.trackList); p ? send(c.res, 200, p) : fail(c.res, 404, 'Finns inte'); });
route('PUT', '/api/music/playlists/:pid', user, async (c) => {
  const p = get('SELECT * FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id);
  if (!p) return fail(c.res, 404, 'Finns inte');
  const { name, trackIds } = await readJson(c.req);
  if (name) run('UPDATE playlists SET name=? WHERE id=?', String(name).trim().slice(0, 100), p.id);
  if (Array.isArray(trackIds)) { // ny ordning / nytt innehåll
    tx(() => {
      run('DELETE FROM playlist_items WHERE playlist_id=?', p.id);
      trackIds.slice(0, 5000).forEach((t, i) => { if (trackOk(c.user.id, t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', p.id, +t, i); });
    });
  }
  send(c.res, 200, { ok: true });
});
route('POST', '/api/music/playlists/:pid/tracks', user, async (c) => {
  const p = get('SELECT * FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id);
  if (!p) return fail(c.res, 404, 'Finns inte');
  const { trackIds } = await readJson(c.req);
  let pos = (get('SELECT MAX(pos) AS m FROM playlist_items WHERE playlist_id=?', p.id).m ?? -1) + 1;
  tx(() => { for (const t of (Array.isArray(trackIds) ? trackIds : []).slice(0, 2000)) if (trackOk(c.user.id, t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', p.id, +t, pos++); });
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/music/playlists/:pid', user, (c) => { run('DELETE FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id); send(c.res, 200, { ok: true }); });

// ---------- Lyssning: smarta spellistor, låttexter och lyssningsinställningar ----------
route('GET', '/api/music/:lib/smart', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, listen.smartLists(l.id, c.user.id)); });
route('GET', '/api/music/:lib/smart/:sid', user, (c) => {
  const l = musicLib(c); if (!l) return;
  const cached = listen.smartTracks(l.id, c.user.id, c.p.sid);
  if (!cached) return fail(c.res, 404, 'Listan finns inte');
  const trackList = ratings.annotate(c.user.id, 'track', cached.map(t => ({ ...t }))); // kopior: listan cachas
  // Egen/delad lista: samma fält som de fasta, plus vem som äger den (tillägg)
  const cl = /^u\d+$/.test(c.p.sid) ? smartl.getFor(+c.p.sid.slice(1), c.user.id) : null;
  send(c.res, 200, { id: c.p.sid, name: listen.smartName(c.p.sid, c.user.id), trackList,
    ...(cl ? { custom: true, listId: cl.id, mine: cl.mine, shared: cl.shared, owner: cl.mine ? null : cl.owner } : {}) });
});
// ---------- Smarta spellistor med egna regler (privata, kan delas med alla på servern) ----------
// Fält och operatorer är vitlistade i server/smartlists.js; ogiltiga regler ger 400 med svensk text.
route('GET', '/api/music/smartlists', user, (c) => send(c.res, 200, { lists: smartl.listFor(c.user.id), ...smartl.catalog() }));
route('POST', '/api/music/smartlists/preview', user, async (c) => {
  const b = await readJson(c.req, 64 * 1024);
  const def = smartl.normalize(b);
  const tracks = smartl.evaluate(def, c.user.id);
  send(c.res, 200, { count: tracks.length, matches: smartl.countMatches(def, c.user.id), duration: tracks.reduce((a, t) => a + (t.duration || 0), 0),
    trackList: c.q.get('tracks') === '1' ? tracks : tracks.slice(0, 10) });
});
route('POST', '/api/music/smartlists', user, async (c) => {
  const id = smartl.create(c.user.id, await readJson(c.req, 64 * 1024));
  listen.clearSmartCache();
  send(c.res, 200, { id });
});
route('GET', '/api/music/smartlists/:id', user, (c) => { const l = smartl.getFor(+c.p.id, c.user.id); l ? send(c.res, 200, l) : fail(c.res, 404, 'Finns inte'); });
route('PUT', '/api/music/smartlists/:id', user, async (c) => {
  const ok = smartl.update(+c.p.id, c.user.id, await readJson(c.req, 64 * 1024));
  listen.clearSmartCache();
  ok ? send(c.res, 200, { ok: true }) : fail(c.res, 404, 'Finns inte');
});
route('DELETE', '/api/music/smartlists/:id', user, (c) => {
  const ok = smartl.remove(+c.p.id, c.user.id);
  listen.clearSmartCache();
  ok ? send(c.res, 200, { ok: true }) : fail(c.res, 404, 'Finns inte');
});
// Låttext: .lrc/taggar först, sedan LRCLIB (source: 'lrclib', cachas i databasen) om det är påslaget
route('GET', '/api/music/tracks/:tid/lyrics', user, async (c) => { const t = trackRow(c); if (t) send(c.res, 200, await mmeta.lyrics(t)); });
route('GET', '/api/me/listening', user, (c) => send(c.res, 200, listen.getPrefs(c.user.id)));
route('PUT', '/api/me/listening', user, async (c) => {
  const b = await readJson(c.req);
  try { send(c.res, 200, listen.setPrefs(c.user.id, b && typeof b === 'object' ? b : {})); } catch (e) { fail(c.res, 400, e.message); }
});

// ---------- Ljudanalys: liknande låtar/artister, låtradio, ljudresa (server/sonic.js) ----------
// Musik har ingen åldersgräns och inga bibliotek per användare – samma regler som resten av musik-API:t.
const ids = (v, max = 1000) => (Array.isArray(v) ? v : []).slice(-max).map(Number).filter(n => Number.isInteger(n) && n > 0);
route('GET', '/api/music/tracks/:tid/similar', user, (c) => {
  const t = trackRow(c); if (!t) return;
  const limit = Math.max(1, Math.min(100, parseInt(c.q.get('limit')) || 30));
  const list = sonic.similarTracks(t.id, c.user.id, { limit });
  send(c.res, 200, { id: t.id, title: t.title, analyzed: !!list, profile: sonic.profile(t.id), trackList: list || [] });
});
route('GET', '/api/music/artists/:arid/similar', user, (c) => {
  const ar = get('SELECT library_id FROM artists WHERE id=?', +c.p.arid);
  if (!ar || !libOk(c.user.id, ar.library_id)) return fail(c.res, 404, 'Finns inte');
  const list = sonic.similarArtists(+c.p.arid, { limit: Math.max(1, Math.min(50, parseInt(c.q.get('limit')) || 12)) });
  list ? send(c.res, 200, { artists: list.map(a => ({ ...a, image: mmeta.hasPhoto(a.id) })) }) : fail(c.res, 404, 'Finns inte');
});
// Nästa låtar i en låtradio: { trackId | albumId | artistId, history: [spelade, senaste sist], exclude: [i kön], count }
route('POST', '/api/music/radio', user, async (c) => {
  const b = await readJson(c.req, 64 * 1024);
  // Radions startpunkt måste ligga i ett bibliotek som användaren får se (låtarna filtreras också i sonic.js)
  for (const [k, t] of [['trackId', 'tracks'], ['albumId', 'albums'], ['artistId', 'artists']]) {
    if (+b[k] && !libOk(c.user.id, get(`SELECT library_id FROM ${t} WHERE id=?`, +b[k])?.library_id ?? -1)) return fail(c.res, 404, 'Finns inte');
  }
  const r = sonic.radio({ trackId: +b.trackId || null, albumId: +b.albumId || null, artistId: +b.artistId || null,
    history: ids(b.history, 200), exclude: ids(b.exclude), count: Math.max(1, Math.min(100, parseInt(b.count) || 25)), uid: c.user.id,
    seed: Number.isInteger(b.seed) ? b.seed : undefined });
  r ? send(c.res, 200, r) : fail(c.res, 400, 'Välj en låt, ett album eller en artist att starta radion från');
});
// Ljudresa: från en låt till en annan genom vektorrymden
route('POST', '/api/music/journey', user, async (c) => {
  const b = await readJson(c.req);
  const ok = (id) => { const t = get('SELECT library_id FROM tracks WHERE id=?', +id); return !!t && libOk(c.user.id, t.library_id); };
  if (!ok(b.from) || !ok(b.to)) return fail(c.res, 404, 'Låten finns inte');
  if (+b.from === +b.to) return fail(c.res, 400, 'Välj två olika låtar');
  const r = sonic.journey(+b.from, +b.to, c.user.id, { count: parseInt(b.count) || 20 });
  r ? send(c.res, 200, r) : fail(c.res, 409, 'Båda låtarna måste vara ljudanalyserade först – analysen pågår i bakgrunden');
});
// Administration: förlopp och inställningar
route('GET', '/api/music/sonic', admin, (c) => send(c.res, 200, sonic.status()));
route('PUT', '/api/music/sonic', admin, async (c) => {
  try { send(c.res, 200, sonic.configure(await readJson(c.req))); } catch (e) { fail(c.res, 400, e.message); }
});
