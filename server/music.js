// Musikbibliotek: skanning av ljudfiler, artister, album, spår, omslag och spellistor.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream';
import { get, all, run, tx, now, getSetting, IMAGES } from './db.js';
import { ranked, parseQuery } from './search.js';
import { send, fail, deletionBlocked, streamFile } from './util.js';
import { rootsOf, listRoots, removable, relOf } from './libpaths.js';
import { parseReplayGain, scheduleLoudness } from './listening.js';
import * as sonic from './sonic.js';

const pexec = promisify(execFile);
export const AUDIO = new Set(['.m4b', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.alac', '.wma', '.aiff', '.aif', '.ape', '.wv', '.mka']);
const COVERS = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png', 'album.jpg', 'albumart.jpg'];
const sortName = (t) => String(t || '').toLowerCase().replace(/^(the|a|an|en|ett)\s+/, '');
const coverFile = (albumId) => path.join(IMAGES, `a${albumId}-cover.jpg`);

export async function probe(file) {
  const { stdout } = await pexec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-print_format', 'json', '-show_format', '-show_streams', file],
    { maxBuffer: 8 << 20, timeout: 60000 });
  const j = JSON.parse(stdout);
  const tags = {};
  for (const src of [j.format?.tags || {}, ...(j.streams || []).map(s => s.tags || {})]) for (const [k, v] of Object.entries(src)) { const kk = k.toLowerCase(); if (!(kk in tags)) tags[kk] = v; }
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  const pic = (j.streams || []).find(s => s.codec_type === 'video' && (s.disposition?.attached_pic || ['mjpeg', 'png'].includes(s.codec_name)));
  return {
    tags, duration: parseFloat(j.format?.duration) || null, codec: a?.codec_name || null, bitrate: parseInt(j.format?.bit_rate) || null,
    sampleRate: parseInt(a?.sample_rate) || null, channels: a?.channels || null, hasPic: !!pic
  };
}

// Mappstruktur som reserv: Artist/Album/01 - Titel.flac
function fromPath(lib, file) {
  const rel = relOf(lib.roots || rootsOf(lib), file).split(path.sep);
  const base = path.basename(file, path.extname(file));
  const m = base.match(/^(?:(\d+)[-.]?)?(\d{1,3})?[\s._-]*(.*)$/);
  const tn = base.match(/^(\d{1,3})(?:[\s._-]+|$)/);
  return {
    artist: rel.length >= 3 ? rel[rel.length - 3] : null,
    album: rel.length >= 2 ? rel[rel.length - 2].replace(/^\s*\(?\d{4}\)?\s*[-–]\s*/, '') : null,
    title: (tn ? base.slice(tn[0].length) : base).replace(/^[\s._-]+/, '').trim() || m?.[3] || base,
    track: tn ? +tn[1] : null
  };
}

function artistId(lib, name) {
  name = String(name || 'Okänd artist').trim().slice(0, 200) || 'Okänd artist';
  const r = get('SELECT id FROM artists WHERE library_id=? AND name=? COLLATE NOCASE', lib.id, name);
  if (r) return r.id;
  return Number(run('INSERT INTO artists(library_id,name,sort_name) VALUES(?,?,?)', lib.id, name, sortName(name)).lastInsertRowid);
}
function albumId(lib, artist, title, year, genre, dir) {
  title = String(title || 'Okänt album').trim().slice(0, 300) || 'Okänt album';
  const r = get('SELECT id FROM albums WHERE library_id=? AND title=? COLLATE NOCASE AND COALESCE(artist_id,0)=? ', lib.id, title, artist || 0);
  if (r) return r.id;
  return Number(run('INSERT INTO albums(library_id,artist_id,title,sort_title,year,genre,dir,added) VALUES(?,?,?,?,?,?,?,?)',
    lib.id, artist, title, sortName(title), year, genre, dir, now()).lastInsertRowid);
}

async function ensureCover(albumIdNum, dir, file, hasPic) { return makeCover(coverFile(albumIdNum), dir, file, hasPic); }
/** Omslag från cover.jpg/folder.jpg i mappen, annars inbäddad bild i ljudfilen */
export async function makeCover(out, dir, file, hasPic) {
  if (fs.existsSync(out)) return true;
  for (const c of COVERS) {
    const f = fs.readdirSync(dir).find(x => x.toLowerCase() === c);
    if (f) {
      try {
        await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', path.join(dir, f), '-vf', 'scale=600:600:force_original_aspect_ratio=decrease', '-q:v', '3', out], { timeout: 30000 });
        if (fs.existsSync(out)) return true;
      } catch {}
    }
  }
  if (hasPic) {
    try {
      await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=600:600:force_original_aspect_ratio=decrease', '-q:v', '3', out], { timeout: 30000 });
      if (fs.existsSync(out)) return true;
    } catch {}
  }
  return false;
}

const scanWarn = (status, msg) => { console.warn('[music]', msg); if (Array.isArray(status.warnings)) status.warnings.push(msg); };
export async function scanMusic(lib, status) {
  status.phase = 'Söker musikfiler'; status.done = 0;
  const roots = lib.roots = rootsOf(lib);
  const list = await listRoots(roots, (n) => AUDIO.has(path.extname(n).toLowerCase()), (n) => n === '@eaDir');
  const { files, failed } = list;
  // Ingen mapp går att läsa (t.ex. omonterad NAS): rör ingenting
  if (!list.rootOk) return scanWarn(status, deletionBlocked({ name: lib.name, rootOk: false }));
  for (const d of failed) if (!roots.includes(d)) scanWarn(status, `${lib.name}: kunde inte läsa ${d} – filer där behålls`);
  status.total = files.length; status.phase = 'Läser taggar';
  const known = new Map(all('SELECT id, path, size, mtime FROM tracks WHERE library_id=?', lib.id).map(r => [r.path, r]));
  const seen = new Set();
  for (const f of files) {
    status.done++; seen.add(f);
    let st; try { st = await fs.promises.stat(f); } catch { continue; }
    const k = known.get(f), mtime = Math.floor(st.mtimeMs / 1000);
    if (k && k.size === st.size && k.mtime === mtime) continue;
    let info;
    try { info = await probe(f); } catch (e) { console.warn('[music] ffprobe', f, e.message); continue; }
    const t = info.tags, fp = fromPath(lib, f);
    const albumArtist = t.album_artist || t.albumartist || t['album artist'] || t.artist || fp.artist;
    const aId = artistId(lib, albumArtist);
    const trackArtist = t.artist && t.artist !== albumArtist ? artistId(lib, t.artist) : aId;
    const year = parseInt(t.date || t.year || t.originaldate) || null;
    const alId = albumId(lib, aId, t.album || fp.album, year, t.genre || null, path.dirname(f));
    const trackNo = parseInt(String(t.track || t.tracknumber || '').split('/')[0]) || fp.track;
    const discNo = parseInt(String(t.disc || t.discnumber || '').split('/')[0]) || 1;
    const title = String(t.title || fp.title).slice(0, 300);
    // Jämn ljudnivå: ReplayGain-taggar om de finns, annars mäts spåret senare i bakgrunden (loudness=NULL)
    const rg = parseReplayGain(t), loud = rg.track != null || rg.album != null ? 'tag' : null;
    if (k) run(`UPDATE tracks SET album_id=?,artist_id=?,title=?,track_no=?,disc_no=?,duration=?,size=?,mtime=?,codec=?,bitrate=?,sample_rate=?,channels=?,
      rg_track=?,rg_album=?,rg_peak=?,loudness=? WHERE id=?`,
      alId, trackArtist, title, trackNo, discNo, info.duration, st.size, mtime, info.codec, info.bitrate, info.sampleRate, info.channels, rg.track, rg.album, rg.peak, loud, k.id);
    else run(`INSERT INTO tracks(library_id,album_id,artist_id,title,track_no,disc_no,duration,path,size,mtime,codec,bitrate,sample_rate,channels,added,rg_track,rg_album,rg_peak,loudness)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, lib.id, alId, trackArtist, title, trackNo, discNo, info.duration, f, st.size, mtime, info.codec, info.bitrate, info.sampleRate, info.channels, now(),
      rg.track, rg.album, rg.peak, loud);
    const al = get('SELECT cover FROM albums WHERE id=?', alId);
    if (!al.cover && await ensureCover(alId, path.dirname(f), f, info.hasPic)) run('UPDATE albums SET cover=1 WHERE id=?', alId);
  }
  scheduleLoudness(); // jämn ljudnivå mäts i bakgrunden, skanningen väntar inte
  sonic.kick(); // ljudanalysen (tempo, energi, klang) likaså – nya och ändrade spår
  // Raderingsskyddet per mapp (libpaths.js): en mapp som saknas eller ser tömd ut tar inte bort något
  const missing = removable({ name: lib.name, list, rows: [...known.values()], seen, found: files,
    allowMass: getSetting('scan_allow_mass_delete', '0') === '1', warn: (m) => scanWarn(status, m) });
  const gone = [];
  tx(() => {
    for (const r of missing) {
      // Omdöpt fil (t.ex. omtaggad med Picard/beets): samma album, skiva, spår och titel tar över spellistor, favoriter och historik
      const nu = get(`SELECT n.id FROM tracks o JOIN tracks n ON n.library_id=o.library_id AND n.album_id=o.album_id AND n.disc_no IS o.disc_no
        AND n.track_no IS o.track_no AND n.title=o.title COLLATE NOCASE AND n.id!=o.id WHERE o.id=? ORDER BY n.id DESC LIMIT 1`, r.id);
      if (nu && !known.has(get('SELECT path FROM tracks WHERE id=?', nu.id).path)) {
        run('UPDATE playlist_items SET track_id=? WHERE track_id=?', nu.id, r.id);
        run('INSERT OR IGNORE INTO favorites(user_id,track_id) SELECT user_id, ? FROM favorites WHERE track_id=?', nu.id, r.id);
        run('UPDATE track_plays SET track_id=? WHERE track_id=?', nu.id, r.id);
      }
      run('DELETE FROM tracks WHERE id=?', r.id);
    }
    for (const a of all('SELECT id FROM albums WHERE library_id=? AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.album_id=albums.id)', lib.id)) {
      run('DELETE FROM albums WHERE id=?', a.id); gone.push(a.id);
    }
    run(`DELETE FROM artists WHERE library_id=? AND NOT EXISTS (SELECT 1 FROM albums a WHERE a.artist_id=artists.id)
      AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id=artists.id)`, lib.id);
  });
  for (const id of gone) fs.rmSync(coverFile(id), { force: true });
}

// ---------------- API-hjälpare ----------------
const ALBUM_COLS = `al.id, al.title, al.year, al.genre, al.cover, al.added, al.library_id, ar.id AS artist_id, ar.name AS artist,
  (SELECT COUNT(*) FROM tracks t WHERE t.album_id=al.id) AS tracks, (SELECT SUM(duration) FROM tracks t WHERE t.album_id=al.id) AS duration`;
const ALBUM_FROM = 'FROM albums al LEFT JOIN artists ar ON ar.id=al.artist_id';
const ALBUM_SQL = `SELECT ${ALBUM_COLS} ${ALBUM_FROM}`;
const shapeAlbum = (a) => ({ id: a.id, title: a.title, year: a.year, genre: a.genre, cover: !!a.cover, artist: a.artist, artistId: a.artist_id, tracks: a.tracks, duration: a.duration, added: a.added });
const TRACK_COLS = `t.id, t.title, t.track_no, t.disc_no, t.duration, t.codec, t.album_id, al.title AS album, al.cover, ar.name AS artist, t.artist_id,
  t.rg_track, t.rg_album, t.rg_peak`;
const TRACK_FROM = 'FROM tracks t LEFT JOIN albums al ON al.id=t.album_id LEFT JOIN artists ar ON ar.id=t.artist_id';
export const TRACK_SQL = `SELECT ${TRACK_COLS} ${TRACK_FROM}`;
export const shapeTrack = (t, favs) => ({ id: t.id, title: t.title, track: t.track_no, disc: t.disc_no, duration: t.duration, codec: t.codec,
  albumId: t.album_id, album: t.album, cover: !!t.cover, artist: t.artist, artistId: t.artist_id, favorite: favs ? favs.has(t.id) : undefined,
  // Jämn ljudnivå: dB mot -18 LUFS (spårets värde, annars albumets) och toppvärde (linjärt) – null om okänt
  gain: t.rg_track ?? t.rg_album ?? null, albumGain: t.rg_album ?? null, peak: t.rg_peak ?? null });

export function albums(libId, sort = 'title', limit = 5000) {
  const order = { title: 'al.sort_title', added: 'al.added DESC', year: 'al.year DESC, al.sort_title', artist: 'ar.sort_name, al.year' }[sort] || 'al.sort_title';
  return all(`${ALBUM_SQL} WHERE al.library_id=? ORDER BY ${order} LIMIT ?`, libId, limit).map(shapeAlbum);
}
export function album(id, uid) {
  const a = get(`${ALBUM_SQL} WHERE al.id=?`, id);
  if (!a) return null;
  const favs = new Set(all('SELECT track_id FROM favorites WHERE user_id=?', uid).map(r => r.track_id));
  return { ...shapeAlbum(a), trackList: all(`${TRACK_SQL} WHERE t.album_id=? ORDER BY t.disc_no, t.track_no, t.title`, id).map(t => shapeTrack(t, favs)) };
}
export function artists(libId) {
  return all(`SELECT ar.id, ar.name, (SELECT COUNT(*) FROM albums a WHERE a.artist_id=ar.id) AS albums,
    (SELECT a.id FROM albums a WHERE a.artist_id=ar.id AND a.cover=1 ORDER BY a.year DESC LIMIT 1) AS cover_album
    FROM artists ar WHERE ar.library_id=? AND EXISTS (SELECT 1 FROM albums a WHERE a.artist_id=ar.id) ORDER BY ar.sort_name`, libId);
}
export function artist(id, uid) {
  const a = get('SELECT * FROM artists WHERE id=?', id);
  if (!a) return null;
  const favs = new Set(all('SELECT track_id FROM favorites WHERE user_id=?', uid).map(r => r.track_id));
  const popular = all(`${TRACK_SQL} WHERE t.artist_id=? OR al.artist_id=? ORDER BY (SELECT COUNT(*) FROM track_plays p WHERE p.track_id=t.id) DESC, t.title LIMIT 10`, id, id).map(t => shapeTrack(t, favs));
  return { id: a.id, name: a.name, albums: all(`${ALBUM_SQL} WHERE al.artist_id=? ORDER BY al.year DESC`, id).map(shapeAlbum), popular };
}
/**
 * Sök artister, album och låtar (rankat, se search.js). libId = bara det biblioteket (null = alla musikbibliotek).
 * Album hittas även på artistens namn och låtar på "artist låt" (sekundär nyckel, rankas lägre).
 * limits = högsta antal per grupp. Fälten är desamma som tidigare (apparna läser dem).
 */
export function searchMusic(q, uid, libId = null, limits = { artists: 20, albums: 30, tracks: 50 }) {
  const Q = typeof q === 'string' ? parseQuery(q) : q;
  if (Q.empty) return { artists: [], albums: [], tracks: [] };
  const lib = (a) => libId == null ? { where: '1', params: [] } : { where: `${a}.library_id=?`, params: [libId] };
  const favs = new Set(all('SELECT track_id FROM favorites WHERE user_id=?', uid).map(r => r.track_id));
  const la = lib('ar'), lb = lib('al'), lt = lib('t');
  return {
    artists: ranked({ from: 'FROM artists ar', cols: 'ar.id, ar.name, ar.name AS _t', key: 'ar.skey',
      pop: '(SELECT COUNT(*) FROM albums a WHERE a.artist_id=ar.id)',
      where: `${la.where} AND EXISTS (SELECT 1 FROM albums a WHERE a.artist_id=ar.id)`, params: la.params }, Q, limits.artists)
      .map(r => ({ id: r.id, name: r.name })),
    albums: ranked({ from: ALBUM_FROM, cols: `${ALBUM_COLS}, al.title AS _t`, key: 'al.skey', key2: 'ar.skey', blob: "al.skeyc || ' ' || COALESCE(ar.skeyc, '')", year: 'al.year',
      where: lb.where, params: lb.params }, Q, limits.albums).map(shapeAlbum),
    tracks: ranked({ from: TRACK_FROM, cols: `${TRACK_COLS}, t.title AS _t`, key: 't.skey', key2: "COALESCE(ar.skey, '') || ' ' || t.skey", blob: "t.skeyc || ' ' || COALESCE(ar.skeyc, '')",
      where: lt.where, params: lt.params }, Q, limits.tracks).map(t => shapeTrack(t, favs))
  };
}
export function musicHome(libId, uid) {
  const favs = new Set(all('SELECT track_id FROM favorites WHERE user_id=?', uid).map(r => r.track_id));
  return {
    recentAlbums: all(`${ALBUM_SQL} WHERE al.library_id=? ORDER BY al.added DESC LIMIT 24`, libId).map(shapeAlbum),
    // Senast spelade först; biblioteket filtreras före LIMIT (annars kan andra bibliotek tränga undan albumen)
    recentlyPlayed: all(`${ALBUM_SQL} JOIN (SELECT t.album_id, MAX(p.ts) AS last FROM track_plays p JOIN tracks t ON t.id=p.track_id
      WHERE p.user_id=? AND t.library_id=? GROUP BY t.album_id ORDER BY last DESC LIMIT 24) r ON r.album_id=al.id ORDER BY r.last DESC`, uid, libId).map(shapeAlbum),
    favorites: all(`${TRACK_SQL} WHERE t.library_id=? AND t.id IN (SELECT track_id FROM favorites WHERE user_id=?) ORDER BY al.sort_title, t.disc_no, t.track_no LIMIT 500`, libId, uid).map(t => shapeTrack(t, favs)),
    stats: get('SELECT (SELECT COUNT(*) FROM artists WHERE library_id=?) AS artists, (SELECT COUNT(*) FROM albums WHERE library_id=?) AS albums, (SELECT COUNT(*) FROM tracks WHERE library_id=?) AS tracks', libId, libId, libId)
  };
}
export function playlists(uid) {
  return all(`SELECT p.id, p.name, p.created, COUNT(i.track_id) AS tracks, SUM(t.duration) AS duration FROM playlists p
    LEFT JOIN playlist_items i ON i.playlist_id=p.id LEFT JOIN tracks t ON t.id=i.track_id WHERE p.user_id=? GROUP BY p.id ORDER BY p.name`, uid);
}
export function playlist(id, uid) {
  const p = get('SELECT * FROM playlists WHERE id=? AND user_id=?', id, uid);
  if (!p) return null;
  const favs = new Set(all('SELECT track_id FROM favorites WHERE user_id=?', uid).map(r => r.track_id));
  return { id: p.id, name: p.name, trackList: all(`${TRACK_SQL} JOIN playlist_items i ON i.track_id=t.id WHERE i.playlist_id=? ORDER BY i.pos`, id).map(t => shapeTrack(t, favs)) };
}

// ---------------- strömning av ljud ----------------
const MIME = { mp3: 'audio/mpeg', aac: 'audio/aac', flac: 'audio/flac', vorbis: 'audio/ogg', opus: 'audio/ogg', alac: 'audio/mp4', pcm_s16le: 'audio/wav' };
const EXT_MIME = { '.m4b': 'audio/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav' };
// Omkodningar som pågår: { uid, file, p }. Tak per användare och totalt (varje förfrågan är en egen ffmpeg).
// Spolning ger en ny förfrågan för samma spår – den äldre stoppas då i stället för att räknas mot taket.
const audioJobs = new Set();
export const AUDIO_LIMITS = { user: 3, total: 8 };
export const audioTranscodes = () => audioJobs.size;
/** Direkt om klienten klarar formatet (med Range för spolning), annars omkodning till AAC (eller MP3) i realtid. */
export function streamTrack(req, res, t, query, uid = 0) {
  const caps = new Set(String(query.get('a') || 'mp3,aac,flac,opus,vorbis').split(','));
  const ext = path.extname(t.path).toLowerCase();
  const direct = caps.has(t.codec) && EXT_MIME[ext] && !(t.codec === 'alac');
  const maxKbps = parseInt(query.get('br')) || 0; // t.ex. 192 i bilen på mobilnät
  if (direct && !(maxKbps && t.bitrate && t.bitrate / 1000 > maxKbps * 1.5)) {
    let st; try { st = fs.statSync(t.path); } catch { return fail(res, 404, 'Filen saknas'); }
    return streamFile(req, res, t.path, st.size, { 'Content-Type': EXT_MIME[ext], 'Cache-Control': 'private, max-age=3600' });
  }
  const ss = Math.max(0, parseFloat(query.get('ss')) || 0);
  const kbps = Math.min(320, maxKbps || 256);
  const useMp3 = !caps.has('aac');
  if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': useMp3 ? 'audio/mpeg' : 'audio/aac', 'Cache-Control': 'no-store', 'X-Transcoded': '1' }); return res.end(); }
  for (const x of audioJobs) if (x.uid === uid && x.file === t.path) { audioJobs.delete(x); x.p.kill('SIGKILL'); }
  if ([...audioJobs].filter(x => x.uid === uid).length >= AUDIO_LIMITS.user || audioJobs.size >= AUDIO_LIMITS.total)
    return fail(res, 503, 'För många ljudströmmar omkodas samtidigt just nu – försök igen strax');
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', ...(ss ? ['-ss', String(ss)] : []), '-i', t.path,
    '-map', '0:a:0', '-vn', ...(useMp3 ? ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-f', 'mp3'] : ['-c:a', 'aac', '-b:a', `${kbps}k`, '-f', 'adts']), 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  const job = { uid, file: t.path, p };
  audioJobs.add(job);
  p.on('close', () => audioJobs.delete(job));
  p.on('error', (e) => {
    audioJobs.delete(job);
    console.warn('[music] kunde inte starta ffmpeg:', e.message);
    if (!res.headersSent) fail(res, 500, 'Omkodningen kunde inte startas'); else res.destroy();
  });
  res.writeHead(200, { 'Content-Type': useMp3 ? 'audio/mpeg' : 'audio/aac', 'Cache-Control': 'no-store', 'X-Transcoded': '1' });
  pipeline(p.stdout, res, () => p.kill('SIGKILL'));
  req.on('close', () => p.kill('SIGKILL'));
}
export const coverPath = (albumIdNum) => { const f = coverFile(albumIdNum); return fs.existsSync(f) ? f : null; };
