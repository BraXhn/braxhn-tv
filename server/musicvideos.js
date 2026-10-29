// Musikvideor i musikbiblioteket (som Plex/Jellyfin): videofiler bland musiken kopplas till artist och låt.
//
// Igenkänning (i den ordningen):
//   1. Samma namn som en ljudfil i mappen: "01 - Låten.mp4" bredvid "01 - Låten.flac" → den låten.
//   2. Plex-namngivning i artist- eller albummappen: "Låten-video.mp4" (även -live, -lyrics, -concert, -interview,
//      -behindthescenes, -other) → typen, titeln matchas mot artistens låtar.
//   3. Videor i undermappar som "Music Videos", "Musikvideor" eller "Videos" i artistmappen, eller direkt i artistmappen.
//   4. "Artist - Låten (Official Video).mp4" var som helst: artisten ur namnet om den finns i biblioteket.
// Filens egna taggar (artist/title) används när namnet inte räcker. Videor utan artist som finns i biblioteket sparas inte.
// Matchningen görs om vid varje skanning (låtar kan ha bytt namn); ffprobe körs bara för nya/ändrade filer.
// Strömmen: /api/music/videos/:vid/stream (direkt, ?mp4=1 = fragmenterad MP4 för webbläsare som inte klarar filen,
// trailers.serveRemux) med mediatoken för just den videon (MV_SCOPE + id).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { get, all, run, tx, now, getSetting, IMAGES } from './db.js';
import { relOf, rootsOf, removable } from './libpaths.js';
import { libOk } from './perms.js';

const pexec = promisify(execFile);
export const MV_SCOPE = 6e9; // mediatoken för en musikvideo: 6e9 + videons id (BRAIN.md: scope-intervall)
export const VIDEO = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.mpg', '.mpeg', '.ts', '.wmv']);
export const KINDS = ['video', 'live', 'lyrics', 'concert', 'interview', 'behindthescenes', 'other'];
const VIDEO_DIRS = new Set(['music videos', 'musicvideos', 'musikvideor', 'videos', 'video', 'videor']);
const SUFFIX = /[-_.](video|live|lyrics|concert|interview|behindthescenes|other)$/i;
export const thumbFile = (id) => path.join(IMAGES, `mv${id}.jpg`);

/** Jämförbar form av en titel: gemener, utan diakritiska tecken, parenteser, "feat." och skiljetecken */
export function norm(s) {
  return String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(/\s(feat|ft|featuring)\.?\s.*$/, ' ')
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
/**
 * Titel och typ ur filnamnet (utan ändelse): spårnummer i början, Plex-suffix och "(Official Video)" tas bort.
 * @returns {{ title: string, kind: string, artist: string|null }} artist = delen före " - " (kan vara artisten)
 */
export function parseVideoName(base) {
  let s = String(base).trim(), kind = 'video';
  const m = s.match(SUFFIX);
  if (m) { kind = m[1].toLowerCase(); s = s.slice(0, -m[0].length); }
  s = s.replace(/^\d{1,3}(?:[\s._-]+|$)/, '');
  if (/[([](?:official\s+)?lyrics?(?:\s+video)?[)\]]/i.test(s) && kind === 'video') kind = 'lyrics';
  else if (/[([]live\b[^)\]]*[)\]]/i.test(s) && kind === 'video') kind = 'live';
  s = s.replace(/\s*[([](?:official|officiell|music|musik|lyrics?|hd|4k|hq|video|audio|remastered|live)[^)\]]*[)\]]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  let artist = null;
  const d = s.match(/^(.+?)\s+[-–]\s+(.+)$/);
  if (d) { artist = d[1].trim(); }
  return { title: s, kind, artist, rest: d ? d[2].trim() : null };
}

async function probeVideo(file) {
  const { stdout } = await pexec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-print_format', 'json', '-show_format', '-show_streams', file],
    { maxBuffer: 8 << 20, timeout: 60000 });
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const tags = {};
  for (const [k, val] of Object.entries(j.format?.tags || {})) tags[k.toLowerCase()] = val;
  return { video: !!v, duration: parseFloat(j.format?.duration) || null, width: v?.width || null, height: v?.height || null, vcodec: v?.codec_name || null,
    artist: String(tags.artist || tags.album_artist || '').slice(0, 200) || null, title: String(tags.title || '').slice(0, 300) || null };
}
async function makeThumb(id, file, duration) {
  const at = duration > 20 ? Math.min(60, duration * 0.3) : duration > 2 ? duration / 2 : 0;
  try {
    await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-ss', String(at), '-i', file, '-frames:v', '1',
      '-vf', 'scale=640:-2', '-q:v', '4', thumbFile(id)], { timeout: 30000 });
    return fs.existsSync(thumbFile(id));
  } catch { return false; }
}

/** Låtar i biblioteket för matchningen: per mapp och per artist (normerad titel) */
function trackIndex(libId) {
  const rows = all(`SELECT t.id, t.title, t.path, t.artist_id, al.artist_id AS album_artist FROM tracks t LEFT JOIN albums al ON al.id=t.album_id WHERE t.library_id=?`, libId);
  const byStem = new Map(), byDir = new Map(), byArtist = new Map();
  for (const r of rows) {
    const ext = path.extname(r.path);
    byStem.set(r.path.slice(0, r.path.length - ext.length).toLowerCase(), r);
    const d = path.dirname(r.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(r);
    for (const a of new Set([r.artist_id, r.album_artist].filter(Boolean))) {
      if (!byArtist.has(a)) byArtist.set(a, new Map());
      const m = byArtist.get(a), k = norm(r.title);
      if (k && !m.has(k)) m.set(k, r);
    }
  }
  const artists = new Map(all('SELECT id, name FROM artists WHERE library_id=?', libId).map(a => [norm(a.name), a.id]));
  return { byStem, byDir, byArtist, artists };
}

/**
 * Var hör videon hemma? Ren funktion (testas direkt).
 * @param {string} file  videofilen
 * @param {string[]} roots  bibliotekets mappar
 * @param {ReturnType<typeof trackIndex>} ix
 * @param {{ artist?: string|null, title?: string|null }} tags  filens taggar
 * @returns {{ artistId: number, trackId: number|null, title: string, kind: string } | null}
 */
export function classify(file, roots, ix, tags = {}) {
  const ext = path.extname(file), base = path.basename(file, ext), dir = path.dirname(file);
  const p = parseVideoName(base);
  const artistByName = (n) => n ? ix.artists.get(norm(n)) || null : null;
  const matchTitle = (aid, title, local = []) => {
    const k = norm(title); if (!k) return null;
    const near = local.find(r => norm(r.title) === k);
    if (near) return near.id;
    return ix.byArtist.get(aid)?.get(k)?.id || null;
  };
  // 1. samma namn som ljudfilen (utan Plex-suffix)
  const stem = path.join(dir, base.replace(SUFFIX, '')).toLowerCase();
  const twin = ix.byStem.get(stem);
  if (twin) return { artistId: twin.album_artist || twin.artist_id, trackId: twin.id, title: twin.title, kind: p.kind };
  // 2–3. albummapp (har låtar) eller artistmapp (ev. via en videomapp)
  const rel = relOf(roots, file).split(path.sep);
  const local = ix.byDir.get(dir) || [];
  let artistId = null;
  if (local.length) artistId = local[0].album_artist || local[0].artist_id;
  else if (rel.length >= 2) {
    const folder = VIDEO_DIRS.has(path.basename(dir).toLowerCase()) && rel.length >= 3 ? path.basename(path.dirname(dir)) : path.basename(dir);
    artistId = artistByName(folder);
  }
  // 4. "Artist - Låt" i namnet, eller filens taggar
  let title = p.title;
  const named = artistByName(p.artist);
  if (named && (!artistId || named === artistId)) { artistId = named; title = p.rest; }
  else if (p.rest && artistId && norm(p.artist) && matchTitle(artistId, p.rest, local)) title = p.rest;
  if (!artistId) artistId = artistByName(tags.artist);
  if (!artistId) return null;
  let trackId = matchTitle(artistId, title, local);
  if (!trackId && tags.title) {
    const tp = parseVideoName(tags.title);
    trackId = matchTitle(artistId, tp.rest && artistByName(tp.artist) === artistId ? tp.rest : tp.title, local);
    if (trackId && !title) title = tp.title;
  }
  return { artistId, trackId, title: String(title || base).slice(0, 300), kind: p.kind };
}

/**
 * Skanningens del för musikvideor (anropas av music.js efter ljudfilerna).
 * files = videofilerna, list = listRoots-resultatet (raderingsskyddet), allFiles = alla mediafiler (ljud och video).
 */
export async function syncVideos(lib, files, { list, allFiles, status = {} }) {
  const roots = lib.roots || rootsOf(lib);
  const known = new Map(all('SELECT * FROM music_videos WHERE library_id=?', lib.id).map(r => [r.path, r]));
  const ix = trackIndex(lib.id);
  const seen = new Set();
  let added = 0;
  for (const f of files) {
    seen.add(f);
    let st; try { st = await fs.promises.stat(f); } catch { continue; }
    const mtime = Math.floor(st.mtimeMs / 1000);
    let row = known.get(f);
    let info = null;
    if (!row || row.size !== st.size || row.mtime !== mtime) {
      try { info = await probeVideo(f); } catch (e) { console.warn('[musikvideor] ffprobe', f, e.message); continue; }
      if (!info.video) continue; // t.ex. en .mp4 med bara ljud
    }
    const tags = info ? { artist: info.artist, title: info.title } : { artist: row.tag_artist, title: row.tag_title };
    const c = classify(f, roots, ix, tags);
    if (!c) { if (row) run('DELETE FROM music_videos WHERE id=?', row.id); continue; }
    if (row && !info) { run('UPDATE music_videos SET artist_id=?, track_id=?, title=?, kind=? WHERE id=?', c.artistId, c.trackId, c.title, c.kind, row.id); continue; }
    if (row) {
      run(`UPDATE music_videos SET artist_id=?, track_id=?, title=?, kind=?, size=?, mtime=?, duration=?, width=?, height=?, vcodec=?, tag_artist=?, tag_title=?, thumb=0 WHERE id=?`,
        c.artistId, c.trackId, c.title, c.kind, st.size, mtime, info.duration, info.width, info.height, info.vcodec, info.artist, info.title, row.id);
      fs.rmSync(thumbFile(row.id), { force: true });
    } else {
      row = { id: Number(run(`INSERT INTO music_videos(library_id,artist_id,track_id,title,kind,path,size,mtime,duration,width,height,vcodec,tag_artist,tag_title,added)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, lib.id, c.artistId, c.trackId, c.title, c.kind, f, st.size, mtime, info.duration, info.width, info.height, info.vcodec, info.artist, info.title, now()).lastInsertRowid) };
      added++;
    }
    if (await makeThumb(row.id, f, info.duration || 0)) run('UPDATE music_videos SET thumb=1 WHERE id=?', row.id);
  }
  // Försvunna videor: samma raderingsskydd som ljudfilerna (mapp som saknas/inte går att läsa rör ingenting)
  const missing = removable({ name: lib.name, list, rows: [...known.values()], seen, found: allFiles,
    allowMass: getSetting('scan_allow_mass_delete', '0') === '1', warn: (m) => console.warn('[musikvideor]', m) });
  tx(() => { for (const r of missing) run('DELETE FROM music_videos WHERE id=?', r.id); });
  for (const r of missing) fs.rmSync(thumbFile(r.id), { force: true });
  if (added) console.log(`[musikvideor] ${lib.name}: ${added} nya`);
  if (status) status.videos = (status.videos || 0) + added;
}

// ---------- API ----------
export const shapeVideo = (v) => ({ id: v.id, title: v.title, kind: v.kind, duration: v.duration, width: v.width, height: v.height,
  thumb: !!v.thumb, artistId: v.artist_id, trackId: v.track_id, artist: v.artist ?? undefined });
const COLS = 'v.*, ar.name AS artist';
const FROM = 'FROM music_videos v LEFT JOIN artists ar ON ar.id=v.artist_id';
const ORDER = "ORDER BY CASE v.kind WHEN 'video' THEN 0 WHEN 'lyrics' THEN 1 WHEN 'live' THEN 2 ELSE 3 END, v.title COLLATE NOCASE";
/** Artistens videor (även de som hör till låtar på andra artisters album, om artisten står på låten) */
export const artistVideos = (aid) => all(`SELECT ${COLS} ${FROM} WHERE v.artist_id=? OR v.track_id IN (SELECT id FROM tracks WHERE artist_id=?) ${ORDER}`, aid, aid).map(shapeVideo);
/** Videor till albumets låtar */
export const albumVideos = (alid) => all(`SELECT ${COLS} ${FROM} JOIN tracks t ON t.id=v.track_id WHERE t.album_id=? ORDER BY t.disc_no, t.track_no, v.kind != 'video', v.id`, alid).map(shapeVideo);
/** Videon om användaren får se biblioteket, annars null */
export function videoFor(uid, id) {
  const v = get(`SELECT ${COLS} ${FROM} WHERE v.id=?`, +id);
  return v && libOk(uid, v.library_id) ? v : null;
}
