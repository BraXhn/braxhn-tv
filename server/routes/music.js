// Musik: album, artister, spår, spellistor, smarta listor, låttexter och lyssningsinställningar.
import fs from 'node:fs';
import { get, run, now, all, tx } from '../db.js';
import { fail, send, clientIp, readJson } from '../util.js';
import { createSession } from '../auth.js';
import * as music from '../music.js';
import * as listen from '../listening.js';
import * as scrobble from '../scrobble.js';
import * as smartl from '../smartlists.js';
import { sized } from '../imgsize.js';
import { route, user, img, audio } from '../http/router.js';
import { screenBlock } from '../http/context.js';

// ---------- Musik ----------
const musicLib = (c) => { const l = get("SELECT * FROM libraries WHERE id=? AND type='music'", +c.p.lib); if (!l) fail(c.res, 404, 'Inget musikbibliotek'); return l; };
route('GET', '/api/music/:lib/home', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, { library: l, ...music.musicHome(l.id, c.user.id), playlists: music.playlists(c.user.id), smart: listen.smartLists(l.id, c.user.id) }); });
route('GET', '/api/music/:lib/albums', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, music.albums(l.id, c.q.get('sort') || 'title')); });
route('GET', '/api/music/:lib/artists', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, music.artists(l.id)); });
route('GET', '/api/music/:lib/search', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, music.searchMusic(String(c.q.get('q') || '').slice(0, 100), c.user.id)); });
route('GET', '/api/music/albums/:aid', user, (c) => { const a = music.album(+c.p.aid, c.user.id); a ? send(c.res, 200, a) : fail(c.res, 404, 'Finns inte'); });
route('GET', '/api/music/artists/:arid', user, (c) => { const a = music.artist(+c.p.arid, c.user.id); a ? send(c.res, 200, a) : fail(c.res, 404, 'Finns inte'); });
route('GET', '/api/music/cover/:aid', img, async (c) => {
  const f = music.coverPath(+c.p.aid);
  if (!f) return fail(c.res, 404, 'Inget omslag');
  fs.readFile(await sized(f, c.q.get('w')), (e, data) => e ? fail(c.res, 404, '') : send(c.res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800' }));
});
const trackRow = (c) => { const t = get('SELECT * FROM tracks WHERE id=?', +c.p.tid); if (!t) fail(c.res, 404, 'Spåret finns inte'); return t; };
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
    (Array.isArray(trackIds) ? trackIds.slice(0, 5000) : []).forEach((t, i) => { if (get('SELECT 1 FROM tracks WHERE id=?', +t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', id, +t, i); });
    return id;
  });
  send(c.res, 200, { id });
});
route('GET', '/api/music/playlists/:pid', user, (c) => { const p = music.playlist(+c.p.pid, c.user.id); p ? send(c.res, 200, p) : fail(c.res, 404, 'Finns inte'); });
route('PUT', '/api/music/playlists/:pid', user, async (c) => {
  const p = get('SELECT * FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id);
  if (!p) return fail(c.res, 404, 'Finns inte');
  const { name, trackIds } = await readJson(c.req);
  if (name) run('UPDATE playlists SET name=? WHERE id=?', String(name).trim().slice(0, 100), p.id);
  if (Array.isArray(trackIds)) { // ny ordning / nytt innehåll
    tx(() => {
      run('DELETE FROM playlist_items WHERE playlist_id=?', p.id);
      trackIds.slice(0, 5000).forEach((t, i) => { if (get('SELECT 1 FROM tracks WHERE id=?', +t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', p.id, +t, i); });
    });
  }
  send(c.res, 200, { ok: true });
});
route('POST', '/api/music/playlists/:pid/tracks', user, async (c) => {
  const p = get('SELECT * FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id);
  if (!p) return fail(c.res, 404, 'Finns inte');
  const { trackIds } = await readJson(c.req);
  let pos = (get('SELECT MAX(pos) AS m FROM playlist_items WHERE playlist_id=?', p.id).m ?? -1) + 1;
  tx(() => { for (const t of (Array.isArray(trackIds) ? trackIds : []).slice(0, 2000)) if (get('SELECT 1 FROM tracks WHERE id=?', +t)) run('INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)', p.id, +t, pos++); });
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/music/playlists/:pid', user, (c) => { run('DELETE FROM playlists WHERE id=? AND user_id=?', +c.p.pid, c.user.id); send(c.res, 200, { ok: true }); });

// ---------- Lyssning: smarta spellistor, låttexter och lyssningsinställningar ----------
route('GET', '/api/music/:lib/smart', user, (c) => { const l = musicLib(c); if (l) send(c.res, 200, listen.smartLists(l.id, c.user.id)); });
route('GET', '/api/music/:lib/smart/:sid', user, (c) => {
  const l = musicLib(c); if (!l) return;
  const trackList = listen.smartTracks(l.id, c.user.id, c.p.sid);
  if (!trackList) return fail(c.res, 404, 'Listan finns inte');
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
route('GET', '/api/music/tracks/:tid/lyrics', user, async (c) => { const t = trackRow(c); if (t) send(c.res, 200, await listen.lyricsFor(t)); });
route('GET', '/api/me/listening', user, (c) => send(c.res, 200, listen.getPrefs(c.user.id)));
route('PUT', '/api/me/listening', user, async (c) => {
  const b = await readJson(c.req);
  try { send(c.res, 200, listen.setPrefs(c.user.id, b && typeof b === 'object' ? b : {})); } catch (e) { fail(c.res, 400, e.message); }
});
