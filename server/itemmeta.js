// Redigering av metadata och bilder för filmer, serier, säsonger och avsnitt (administratören, "Redigera" på titelsidan).
//  - Fält: titel, sorteringstitel, originaltitel, år, premiärdatum, beskrivning, genrer, studio, åldersgräns, betyg och
//    tagline; avsnitt: titel, beskrivning, betyg, säsong och avsnittsnummer. Varje fält kan låsas (som i Plex): det låsta
//    värdet ligger i items.locked (JSON kolumn → värde) och utlösaren items_locked_upd i db.js skriver tillbaka det efter
//    varje ändring – TMDB (refreshItem), NFO (applyNfo), filnamnet vid omskanning och flytt av versioner kan inte ändra det.
//  - Bilder: TMDB:s affischer/bakgrunder/logotyper/stillbilder (språk: inställningens, engelska och utan text) eller en
//    egen bild (JPEG/PNG/WebP, högst UPLOAD_MAX). Allt avkodas och konverteras med ffmpeg (formatet anges, ingen
//    gissning), så en trasig eller förklädd fil sparas aldrig. Valet låses i items.img_locked (hasLocal i localmeta.js).
//    Klienten anger aldrig sökvägar eller adresser: bara bildtypen och TMDB:s filnamn, som måste finnas i TMDB:s lista.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { get, all, run, getSetting, IMAGES } from './db.js';
import { dropVariants } from './imgsize.js';
import * as colors from './imgcolor.js';
import { imageFile, imgLocksOf } from './localmeta.js';
import { tmdb, hasTmdb, TMDB_IMG } from './scanner.js';

export const UPLOAD_MAX = +(process.env.IMAGE_UPLOAD_MAX_MB || 15) * (1 << 20);
const DOWNLOAD_MAX = 30 << 20;
const MAX_SIDE = 12000, MAX_PIXELS = 50e6; // större bilder avkodas inte (minnet)
const err = (status, message) => Object.assign(new Error(message), { status });
const sortTitle = (t) => t.toLowerCase().replace(/^(the|a|an|en|ett|den|det)\s+/, '');

// ---------- fält ----------
const MS = ['movie', 'show'], ALL = ['movie', 'show', 'episode'];
const text = (max) => (v) => { if (v == null) return null; if (typeof v !== 'string' && typeof v !== 'number') throw err(400, 'Ogiltigt värde'); const s = String(v).trim(); if (s.length > max) throw err(400, `Högst ${max} tecken`); return s || null; };
const int = (min, max) => (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw err(400, `Ange ett heltal ${min}–${max}`);
  return n;
};
/** API-namn → { kinds, cols (kolumner som fältet styr), parse } */
export const FIELDS = {
  title: { kinds: ALL, cols: ['title'], parse: (v) => { const s = text(300)(v); if (!s) throw err(400, 'Titeln får inte vara tom'); return s; } },
  sortTitle: { kinds: ALL, cols: ['sort_title'], parse: (v) => text(300)(v)?.toLowerCase() ?? null },
  originalTitle: { kinds: MS, cols: ['original_title'], parse: text(300) },
  year: { kinds: MS, cols: ['year'], parse: int(1870, 2200) },
  released: { kinds: ALL, cols: ['released', 'premiered'], parse: (v) => {
    if (v == null || v === '') return null;
    const s = String(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + 'T00:00:00Z')) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) throw err(400, 'Ange datumet som ÅÅÅÅ-MM-DD');
    return s;
  } },
  overview: { kinds: ALL, cols: ['overview'], parse: text(10000) },
  genres: { kinds: MS, cols: ['genres'], parse: (v) => {
    if (v == null) return JSON.stringify([]);
    const list = Array.isArray(v) ? v : String(v).split(',');
    if (list.length > 30) throw err(400, 'Högst 30 genrer');
    const out = [];
    for (const g of list) { const s = text(60)(g); if (s && !out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s); }
    return JSON.stringify(out);
  } },
  studio: { kinds: MS, cols: ['studio'], parse: text(200) },
  age: { kinds: MS, cols: ['age', 'cert'], parse: int(0, 18) },
  rating: { kinds: ALL, cols: ['rating'], parse: (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 10) throw err(400, 'Betyget ska vara 0–10');
    return Math.round(n * 10) / 10;
  } },
  tagline: { kinds: MS, cols: ['tagline'], parse: text(300) },
  season: { kinds: ['episode'], cols: ['season'], parse: (v) => { const n = int(0, 1000)(v); if (n == null) throw err(400, 'Ange säsong'); return n; } },
  episode: { kinds: ['episode'], cols: ['episode'], parse: (v) => { const n = int(0, 10000)(v); if (n == null) throw err(400, 'Ange avsnitt'); return n; } },
};
export const fieldsFor = (kind) => Object.keys(FIELDS).filter(k => FIELDS[k].kinds.includes(kind));
const lockedOf = (row) => { try { const v = JSON.parse(row?.locked || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
/** Fältens värden i API-form (genrer som lista, tal som tal) */
function valuesOf(row) {
  let genres = [];
  try { genres = JSON.parse(row.genres || '[]'); } catch {}
  return { title: row.title, sortTitle: row.sort_title || '', originalTitle: row.original_title || '', year: row.year ?? null,
    released: row.released || row.premiered || '', overview: row.overview || '', genres: Array.isArray(genres) ? genres : [], studio: row.studio || '',
    age: row.age ?? null, cert: row.cert || null, rating: row.rating ?? null, tagline: row.tagline || '', season: row.season ?? null, episode: row.episode ?? null };
}
/** Låsta fält i API-form: ett fält är låst när alla dess kolumner är låsta */
const lockedKeys = (row) => { const l = lockedOf(row); return fieldsFor(row.kind).filter(k => FIELDS[k].cols.every(c => c in l)); };

/** Bildtyperna för titeln: affisch, bakgrund, logotyp (och miniatyr för filmer); avsnitt: miniatyr; serier: säsongsaffischer */
export function imageTypes(row) {
  if (row.kind === 'episode') return ['thumb'];
  const t = ['poster', 'backdrop', 'logo'];
  if (row.kind === 'movie') t.push('thumb');
  else for (const s of all('SELECT DISTINCT season FROM items WHERE parent_id=? ORDER BY season', row.id)) if (s.season != null) t.push('season' + s.season);
  return t;
}
const COLS = { poster: 'poster', backdrop: 'backdrop', thumb: 'thumb', logo: 'logo' };
function imagesOf(row) {
  const locks = imgLocksOf(row), out = {};
  for (const t of imageTypes(row)) {
    const l = String(locks[t] || ''), tm = l.startsWith('tmdb:');
    out[t] = { has: COLS[t] ? !!row[COLS[t]] : fs.existsSync(imageFile(row.id, t)), lock: l ? (tm ? 'tmdb' : 'upload') : null, ...(tm ? { path: l.slice(5) } : {}) };
  }
  return out;
}

/** Allt dialogen "Redigera" behöver */
export function editable(row) {
  const genres = new Set();
  for (const r of all("SELECT DISTINCT genres FROM items WHERE kind IN ('movie','show') AND genres IS NOT NULL AND genres != '[]' LIMIT 5000")) {
    try { for (const g of JSON.parse(r.genres)) if (typeof g === 'string') genres.add(g); } catch {}
  }
  const tmdbOk = hasTmdb() && !!(row.kind === 'episode' ? get('SELECT tmdb_id FROM items WHERE id=?', row.parent_id)?.tmdb_id : row.tmdb_id);
  return { id: row.id, kind: row.kind, fields: fieldsFor(row.kind), values: valuesOf(row), locked: lockedKeys(row),
    genreSuggestions: [...genres].sort((a, b) => a.localeCompare(b, 'sv')), images: imagesOf(row), tmdb: tmdbOk, uploadMax: UPLOAD_MAX,
    file: row.path ? path.basename(row.path) : null, tmdbId: row.tmdb_id || null, matchLocked: !!row.match_locked };
}

/**
 * Sparar ändrade fält och låsen. values = API-namn → värde (bara de som ändras), locked = alla fält som ska vara låsta
 * efteråt (null = lås de ändrade fälten, som Plex). Ett låst fält som inte ändras låses med sitt nuvarande värde.
 */
export function save(row, { values = {}, locked = null } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw err(400, 'Ogiltiga fält');
  const allowed = fieldsFor(row.kind);
  for (const k of Object.keys(values)) if (!allowed.includes(k)) throw err(400, `Fältet ${k} kan inte ändras här`);
  if (locked != null && (!Array.isArray(locked) || locked.some(k => !allowed.includes(k)))) throw err(400, 'Ogiltiga lås');
  const set = {};
  for (const [k, v] of Object.entries(values)) {
    const val = FIELDS[k].parse(v);
    if (k === 'age') { set.age = val; set.cert = val === row.age ? row.cert : val == null ? null : 'manuell'; }
    else if (k === 'released') { set.released = val; set.premiered = val; }
    else set[FIELDS[k].cols[0]] = val;
  }
  if ('title' in set && !('sort_title' in set)) set.sort_title = sortTitle(set.title);
  if ('sort_title' in set && !set.sort_title) set.sort_title = sortTitle(set.title ?? row.title);
  const want = new Set(locked ?? [...lockedKeys(row), ...Object.keys(values)]);
  // Låst titel låser sorteringen också – annars sorterar TMDB:s titel om den
  if (want.has('title')) want.add('sortTitle');
  const lock = lockedOf(row);
  for (const k of allowed) for (const c of FIELDS[k].cols) {
    if (want.has(k)) lock[c] = c in set ? set[c] : k === 'released' ? row.released || row.premiered || null : row[c] ?? null;
    else delete lock[c];
  }
  if (row.kind === 'episode' && ('season' in set || 'episode' in set)) { set.ep_guess = 0; set.abs_episode = null; }
  const cols = Object.keys(set);
  run(`UPDATE items SET ${[...cols.map(c => `${c}=?`), 'locked=?'].join(', ')} WHERE id=?`,
    ...cols.map(c => set[c]), Object.keys(lock).length ? JSON.stringify(lock) : null, row.id);
  return get('SELECT * FROM items WHERE id=?', row.id);
}

// ---------- bilder ----------
const TMDB_PATH = /^\/[A-Za-z0-9_-]{1,80}\.(jpg|png)$/;
const imgLangs = () => [...new Set([String(getSetting('language', 'sv-SE') || 'sv').split('-')[0].toLowerCase(), 'en'])].join(',') + ',null';
const tmdbShow = (row) => row.kind === 'episode' ? get('SELECT tmdb_id FROM items WHERE id=?', row.parent_id)?.tmdb_id : row.tmdb_id;
/** TMDB:s bilder av typen för titeln: [{ path, width, height, lang, votes }] (bästa först: titelns språk, engelska, utan text) */
export async function tmdbImages(row, type) {
  if (!imageTypes(row).includes(type)) throw err(404, 'Okänd bildtyp');
  const id = tmdbShow(row);
  if (!hasTmdb() || !id) return [];
  const q = { include_image_language: imgLangs() };
  let list;
  const season = /^season(\d+)$/.exec(type);
  if (row.kind === 'episode') list = (await tmdb(`/tv/${+id}/season/${+row.season}/episode/${+row.episode}/images`, q)).stills;
  else if (season) list = (await tmdb(`/tv/${+id}/season/${+season[1]}/images`, q)).posters;
  else {
    const d = await tmdb(`/${row.kind === 'show' ? 'tv' : 'movie'}/${+id}/images`, q);
    list = type === 'poster' ? d.posters : type === 'logo' ? d.logos : d.backdrops;
  }
  const lang = imgLangs().split(',')[0], rank = (l) => l === lang ? 0 : l === 'en' ? 1 : l == null ? 2 : 3;
  return (Array.isArray(list) ? list : [])
    .filter(x => TMDB_PATH.test(x?.file_path || '') && (type !== 'logo' || x.file_path.endsWith('.png')))
    .map(x => ({ path: x.file_path, width: +x.width || null, height: +x.height || null, lang: x.iso_639_1 || null, votes: +x.vote_average || 0 }))
    .sort((a, b) => rank(a.lang) - rank(b.lang) || b.votes - a.votes)
    .slice(0, 80);
}

/** Formatet ur filens första byte (bara JPEG, PNG och WebP godtas) */
export function sniff(b) {
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const pexec = (cmd, args, o = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 30000, maxBuffer: 1 << 20, ...o }, (e, out) => e ? reject(e) : resolve(out)));
const MAXW = { poster: 1000, backdrop: 1920, thumb: 960, logo: 1000, season: 680 };
/**
 * Avkodar bilden (formatet anges till ffmpeg – ingen gissning) och sparar den som titelns bild av typen:
 * JPEG (logotyper PNG med genomskinlighet), nedskalad till typens bredd. lock = 'tmdb:<sökväg>' | 'upload'.
 */
export async function storeImage(row, type, buf, lock) {
  if (!imageTypes(row).includes(type)) throw err(404, 'Okänd bildtyp');
  const fmt = sniff(buf);
  if (!fmt) throw err(415, 'Bara JPEG, PNG och WebP');
  const out = imageFile(row.id, type);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tag = crypto.randomBytes(6).toString('hex');
  const src = path.join(IMAGES, `.upload-${tag}`), tmp = `${out}.${tag}.tmp`;
  const fin = ['-f', `${fmt}_pipe`, '-i', src];
  try {
    fs.writeFileSync(src, buf);
    let w = 0, h = 0;
    try {
      const j = JSON.parse(await pexec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', ...fin.slice(0, 2), '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'json', src]));
      ({ width: w, height: h } = j.streams?.[0] || {});
    } catch {}
    if (!(w > 0 && h > 0)) throw err(400, 'Bilden gick inte att läsa');
    if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) throw err(400, 'Bilden är för stor (högst 12 000 bildpunkter per sida)');
    const maxW = MAXW[COLS[type] ? type : 'season'];
    const enc = type === 'logo' ? ['-pix_fmt', 'rgba', '-c:v', 'png'] : ['-pix_fmt', 'yuvj420p', '-q:v', '3', '-c:v', 'mjpeg'];
    try {
      await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', ...fin, '-frames:v', '1',
        '-vf', `scale='min(${maxW},iw)':-2:flags=lanczos`, ...enc, '-f', 'image2', '-update', '1', tmp]);
      if (!(fs.statSync(tmp).size > 0)) throw new Error('tom');
    } catch (e) { if (e.status) throw e; throw err(400, 'Bilden gick inte att läsa'); }
    fs.renameSync(tmp, out);
  } finally {
    fs.rm(src, { force: true }, () => {});
    fs.rm(tmp, { force: true }, () => {});
  }
  dropVariants(out);
  const locks = imgLocksOf(get('SELECT img_locked FROM items WHERE id=?', row.id));
  locks[type] = lock;
  if (COLS[type]) run(`UPDATE items SET ${COLS[type]}=1, img_locked=? WHERE id=?`, JSON.stringify(locks), row.id);
  else run('UPDATE items SET img_locked=? WHERE id=?', JSON.stringify(locks), row.id);
  if (colors.TYPES.includes(type)) colors.forget(row.id, [type]);
  return imagesOf(get('SELECT * FROM items WHERE id=?', row.id));
}

/** Välj en av TMDB:s bilder (sökvägen måste finnas i TMDB:s lista för titeln) */
export async function chooseTmdb(row, type, tmdbPath) {
  if (typeof tmdbPath !== 'string' || !TMDB_PATH.test(tmdbPath)) throw err(400, 'Ogiltig bild');
  const list = await tmdbImages(row, type);
  if (!list.some(x => x.path === tmdbPath)) throw err(404, 'Bilden finns inte hos TMDB för den här titeln');
  const size = type === 'backdrop' ? 'w1280' : type === 'logo' ? 'w500' : 'w780';
  let r;
  try { r = await fetch(`${TMDB_IMG}/${size}${tmdbPath}`, { signal: AbortSignal.timeout(30000), redirect: 'error' }); }
  catch { throw err(502, 'Kunde inte hämta bilden från TMDB'); }
  if (!r.ok) throw err(502, `TMDB svarade med fel ${r.status}`);
  if (+r.headers.get('content-length') > DOWNLOAD_MAX) throw err(502, 'Bilden från TMDB är för stor');
  const chunks = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > DOWNLOAD_MAX) throw err(502, 'Bilden från TMDB är för stor'); chunks.push(c); }
  return storeImage(row, type, Buffer.concat(chunks), 'tmdb:' + tmdbPath);
}

/** Läser en uppladdad bild ur förfrågan (rå kropp eller multipart/form-data med ett filfält), högst UPLOAD_MAX */
export async function readUpload(req) {
  const ctRaw = String(req.headers['content-type'] || ''), ct = ctRaw.toLowerCase();
  const len = +req.headers['content-length'];
  if (len > UPLOAD_MAX + 64 * 1024) { req.resume(); throw err(413, `Bilden är för stor (högst ${Math.round(UPLOAD_MAX / (1 << 20))} MB)`); }
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > UPLOAD_MAX + 64 * 1024) throw err(413, `Bilden är för stor (högst ${Math.round(UPLOAD_MAX / (1 << 20))} MB)`);
    chunks.push(c);
  }
  let body = Buffer.concat(chunks);
  if (ct.startsWith('multipart/form-data')) {
    const m = /boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(ctRaw); // gränsen är skiftlägeskänslig
    if (!m) throw err(400, 'Ogiltig uppladdning');
    const sep = Buffer.from('--' + (m[1] || m[2]));
    const start = body.indexOf(sep);
    const head = start < 0 ? -1 : body.indexOf('\r\n\r\n', start);
    const end = head < 0 ? -1 : body.indexOf(Buffer.concat([Buffer.from('\r\n'), sep]), head + 4);
    if (end < 0) throw err(400, 'Ogiltig uppladdning');
    body = body.subarray(head + 4, end);
  } else if (!/^image\/(jpeg|png|webp)$/.test(ct.split(';')[0].trim())) throw err(415, 'Bara JPEG, PNG och WebP');
  if (body.length > UPLOAD_MAX) throw err(413, `Bilden är för stor (högst ${Math.round(UPLOAD_MAX / (1 << 20))} MB)`);
  if (!body.length) throw err(400, 'Ingen bild');
  return body;
}

/** Tillbaka till automatiskt: låset och bilden tas bort; lokal fil eller TMDB tar över vid nästa uppdatering */
export function resetImage(row, type) {
  if (!imageTypes(row).includes(type)) throw err(404, 'Okänd bildtyp');
  const locks = imgLocksOf(row);
  delete locks[type];
  let local = {};
  try { local = JSON.parse(row.local_img || '{}') || {}; } catch {}
  delete local[type]; // en lokal fil läses in igen vid skanningen
  const out = imageFile(row.id, type);
  fs.rmSync(out, { force: true });
  dropVariants(out);
  const lk = Object.keys(locks).length ? JSON.stringify(locks) : null, lo = Object.keys(local).length ? JSON.stringify(local) : null;
  if (COLS[type]) run(`UPDATE items SET ${COLS[type]}=0, img_locked=?, local_img=? WHERE id=?`, lk, lo, row.id);
  else run('UPDATE items SET img_locked=?, local_img=? WHERE id=?', lk, lo, row.id);
  if (colors.TYPES.includes(type)) colors.forget(row.id, [type]);
}
export { imagesOf };
