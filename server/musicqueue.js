// Musikkön per användare/profil: låtarna (id i köns ordning – blandat är redan blandat), platsen i kön, positionen,
// upprepning och låtradions start. Webben sparar när kön ändras, vid paus och var 15:e sekund medan musiken spelar,
// och läser den när sidan startar: kön och platsen överlever omladdning och följer med till nästa enhet.
// Låtar som tagits bort, eller som profilen inte får se, hoppas över när kön läses.
import { get, all, run, now } from './db.js';
import { TRACK_SQL, shapeTrack } from './music.js';
import { libFilter } from './perms.js';

/** Längsta kö som sparas (låtradion växer hela tiden): ett fönster runt platsen i kön */
export const MAX_TRACKS = 1000;
const BEFORE = 200; // låtar före platsen som behålls när kön kortas
const EMPTY = { tracks: [], idx: -1, pos: 0, repeat: false, radio: null, updated: 0 };
const okId = (x) => Number.isSafeInteger(x) && x > 0;

/** Kön som webben ska visa: { tracks (som i albumlistorna), idx, pos, repeat, radio, updated }. Tom kö: tracks = []. */
export function load(uid) {
  const r = get('SELECT * FROM music_queue WHERE user_id=?', uid);
  if (!r) return EMPTY;
  let ids = [], radio = null;
  try { ids = JSON.parse(r.tracks); } catch {}
  try { radio = r.radio ? JSON.parse(r.radio) : null; } catch {}
  if (!Array.isArray(ids)) ids = [];
  const f = libFilter(uid, 't.library_id'), rows = new Map(), uniq = [...new Set(ids.filter(okId))];
  for (let i = 0; i < uniq.length; i += 500) {
    const part = uniq.slice(i, i + 500);
    for (const t of all(`${TRACK_SQL} WHERE t.id IN (${part.map(() => '?').join(',')})${f.sql}`, ...part, ...f.params)) rows.set(t.id, t);
  }
  const favs = new Set(all('SELECT track_id FROM favorites WHERE user_id=?', uid).map(x => x.track_id));
  // Platsen följer låten: saknas den spelande låten tar nästa som finns kvar vid (från början)
  const tracks = []; let idx = -1, pos = Math.max(0, +r.pos || 0);
  ids.forEach((id, i) => {
    const t = rows.get(id); if (!t) return;
    if (idx < 0 && i >= r.idx) { idx = tracks.length; if (i !== r.idx) pos = 0; }
    tracks.push(shapeTrack(t, favs));
  });
  if (idx < 0) { if (!r.rep || !tracks.length) return EMPTY; idx = 0; pos = 0; } // kön var slut
  if (tracks[idx].duration > 0 && pos > tracks[idx].duration - 1) pos = 0;
  return { tracks, idx, pos, repeat: !!r.rep, radio, updated: r.updated };
}

/**
 * Sparar kön. b = { ids, idx, pos, repeat, radio: { seed: { trackId | albumId | artistId }, name }, uid }.
 * uid (webben skickar det) måste vara den inloggade – en flik från före ett profilbyte får inte skriva över den nya
 * profilens kö. Tom lista tar bort kön. Fel: { status, error }.
 */
export function save(uid, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { status: 400, error: 'Ogiltig kö' };
  if (b.uid != null && Number(b.uid) !== uid) return { status: 409, error: 'Kön hör till en annan profil' };
  if (!Array.isArray(b.ids) || !b.ids.every(okId)) return { status: 400, error: 'Ogiltig kö' };
  let ids = b.ids, idx = b.idx;
  if (!ids.length) { clear(uid); return null; }
  if (!Number.isInteger(idx) || idx < 0 || idx >= ids.length) return { status: 400, error: 'Ogiltig kö' };
  if (ids.length > MAX_TRACKS) {
    const from = Math.max(0, Math.min(idx - BEFORE, ids.length - MAX_TRACKS));
    ids = ids.slice(from, from + MAX_TRACKS); idx -= from;
  }
  const pos = Number.isFinite(+b.pos) ? Math.max(0, Math.min(86400, Math.round(+b.pos * 10) / 10)) : 0;
  let radio = null;
  const s = b.radio?.seed;
  if (s && typeof s === 'object') {
    const seed = {};
    for (const k of ['trackId', 'albumId', 'artistId']) if (okId(s[k])) seed[k] = s[k];
    if (Object.keys(seed).length) radio = { seed, name: String(b.radio.name || '').slice(0, 200) };
  }
  run(`INSERT INTO music_queue(user_id, tracks, idx, pos, rep, radio, updated) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET tracks=excluded.tracks, idx=excluded.idx, pos=excluded.pos, rep=excluded.rep, radio=excluded.radio, updated=excluded.updated`,
    uid, JSON.stringify(ids), idx, pos, b.repeat ? 1 : 0, radio ? JSON.stringify(radio) : null, now());
  return null;
}
export function clear(uid) { run('DELETE FROM music_queue WHERE user_id=?', uid); }
