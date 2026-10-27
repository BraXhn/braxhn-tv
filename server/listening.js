// Lyssning: jämn ljudnivå (ReplayGain-taggar eller mätning med ffmpeg), låttexter (.lrc och inbäddade taggar),
// smarta spellistor och lyssningsinställningar per användare (normalisering, hoppintervall, hoppa över tystnad).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, get, all, run, now } from './db.js';
import { probe, TRACK_SQL, shapeTrack } from './music.js';
import * as custom from './smartlists.js';
import * as sonic from './sonic.js';
import { libOk } from './perms.js';

// Tabellen listen_prefs skapas i db.js (där får den nya kolumner)

// ---------------- jämn ljudnivå ----------------
/** ReplayGain 2 riktar in sig på -18 LUFS; gain i API:t är alltid relativt den referensen (dB). */
export const REFERENCE_LUFS = -18;
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const num = (v) => { const m = String(v ?? '').replace(',', '.').match(/[-+]?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
const okGain = (g) => Number.isFinite(g) && g > -60 && g < 60 ? round(g) : null;
const okPeak = (p) => Number.isFinite(p) && p > 0 && p < 10 ? round(p, 4) : null;
// Opus: R128_*_GAIN är ett Q7.8-heltal mot -23 LUFS – ReplayGain-referensen ligger 5 dB högre
const r128 = (v) => v != null && /^\s*[-+]?\d+\s*$/.test(String(v)) ? parseInt(v) / 256 + 5 : NaN;

/** Läser ReplayGain (eller Opus R128) ur taggar. Saknade/orimliga värden blir null. */
export function parseReplayGain(tags = {}) {
  const t = {};
  for (const [k, v] of Object.entries(tags || {})) t[k.toLowerCase()] = v;
  let track = num(t.replaygain_track_gain), album = num(t.replaygain_album_gain);
  if (!Number.isFinite(track)) track = r128(t.r128_track_gain);
  if (!Number.isFinite(album)) album = r128(t.r128_album_gain);
  return { track: okGain(track), album: okGain(album), peak: okPeak(num(t.replaygain_track_peak)), albumPeak: okPeak(num(t.replaygain_album_peak)) };
}

/**
 * Albumets ljudnivå när taggarna saknar albumvärde: spårens ljudstyrka (−18 − gain) medelvärdesbildas som energi,
 * viktat med längden – samma idé som ReplayGains albumvärde (utan grindning per block). Toppvärdet = högsta spårets.
 * tracks: [{ gain, peak, duration }]. Null om något spår saknar värde.
 */
export function albumLoudness(tracks) {
  if (!tracks.length || tracks.some(t => t.gain == null)) return null;
  let e = 0, w = 0, peak = 0;
  for (const t of tracks) {
    const d = t.duration > 0 ? t.duration : 1;
    e += d * 10 ** ((REFERENCE_LUFS - t.gain) / 10); w += d;
    if (t.peak > peak) peak = t.peak;
  }
  const lufs = 10 * Math.log10(e / w);
  return { gain: okGain(REFERENCE_LUFS - lufs), peak: peak ? okPeak(peak) : null };
}
/** Räknar om albums.rg_gain/rg_peak för albumen (alla när ids saknas). */
export function refreshAlbumGains(ids = null) {
  const list = ids ? [...new Set(ids)].filter(Boolean) : all('SELECT id FROM albums').map(r => r.id);
  for (const id of list) {
    const rows = all('SELECT rg_track AS gain, rg_peak AS peak, duration FROM tracks WHERE album_id=?', id);
    const r = albumLoudness(rows);
    run('UPDATE albums SET rg_gain=?, rg_peak=? WHERE id=?', r?.gain ?? null, r?.peak ?? null, id);
  }
}

/** Tolkar sammanfattningen från ffmpeg-filtret ebur128 (integrerad ljudstyrka och toppvärde). */
export function parseEbur128(text) {
  const s = String(text || '').lastIndexOf('Summary:');
  if (s < 0) return null;
  const tail = String(text).slice(s);
  const i = tail.match(/\bI:\s*(-?[\d.]+)\s*LUFS/);
  const lufs = i ? parseFloat(i[1]) : NaN;
  if (!Number.isFinite(lufs) || lufs < -70) return null; // tyst eller trasigt spår – ingen förstärkning
  const pk = tail.match(/Peak:\s*(-?[\d.]+)\s*dBFS/);
  const peakDb = pk ? parseFloat(pk[1]) : NaN;
  return { lufs, gain: okGain(REFERENCE_LUFS - lufs), peak: Number.isFinite(peakDb) ? okPeak(10 ** (peakDb / 20)) : null };
}

/** Mäter ljudstyrkan med ffmpeg (bara analys, ingen fil skrivs) på lägsta prioritet. */
export function measureLoudness(file, timeoutMs = 10 * 60e3) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', file, '-map', '0:a:0', '-vn',
      '-af', 'ebur128=framelog=quiet:peak=sample', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(p.pid, 19); } catch {}
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 1 << 20) err = err.slice(-65536); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', () => { clearTimeout(timer); const r = parseEbur128(err); r ? resolve(r) : reject(new Error('Kunde inte mäta ljudstyrkan')); });
  });
}

// En körning åt gången; spår utan ReplayGain-taggar mäts i bakgrunden, ett begränsat antal per skanning
let running = null;
const perScan = () => Math.max(0, parseInt(process.env.MUSIC_LOUDNESS_PER_SCAN ?? '200') || 0);
export function scheduleLoudness(limit = perScan()) {
  if (process.env.MUSIC_LOUDNESS === '0' || !limit) return null;
  if (running) return running;
  running = loudnessBatch(limit).catch(e => console.warn('[music] ljudnivå:', e.message)).finally(() => { running = null; });
  return running;
}
async function loudnessBatch(limit) {
  const rows = all('SELECT id, path, album_id FROM tracks WHERE loudness IS NULL ORDER BY added DESC LIMIT ?', limit);
  let measured = 0;
  for (const r of rows) {
    let res = null, src = 'fel';
    // Spår som skannades före funktionen kan ha taggar – läs dem först (billigt)
    try { const rg = parseReplayGain((await probe(r.path)).tags); if (rg.track != null || rg.album != null) { res = rg; src = 'tag'; } } catch {}
    if (!res) {
      try { const m = await measureLoudness(r.path); res = { track: m.gain, album: null, peak: m.peak }; src = 'mätt'; measured++; } catch {}
    }
    run('UPDATE tracks SET rg_track=?, rg_album=?, rg_peak=?, rg_album_peak=?, loudness=? WHERE id=? AND loudness IS NULL',
      res?.track ?? null, res?.album ?? null, res?.peak ?? null, res?.albumPeak ?? null, src, r.id);
  }
  refreshAlbumGains(rows.map(r => r.album_id)); // albumläget för spår utan albumtagg
  if (measured) console.log(`[music] ljudnivå mätt för ${measured} spår`);
}

// ---------------- låttexter ----------------
const TS = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;
/**
 * Tolkar LRC (synkade texter, [mm:ss.xx]) eller vanlig text. Flera tidsstämplar per rad, [offset:±ms]
 * och ord-tidsstämplar (<mm:ss.xx>) hanteras. Returnerar { synced, lines: [{ t, text }] } (t i sekunder eller null).
 */
export function parseLrc(text) {
  const src = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let offset = 0;
  const timed = [], plain = [];
  for (const raw of src.split('\n')) {
    let line = raw.trim();
    const off = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
    if (off) { offset = parseInt(off[1]) / 1000; continue; }
    const stamps = [];
    let m;
    while ((m = line.match(TS))) { stamps.push(parseInt(m[1]) * 60 + parseFloat(m[2].replace(':', '.'))); line = line.slice(m[0].length); }
    if (!stamps.length && /^\[[a-z#]+:.*\]$/i.test(line)) continue; // metadata som [ar:Artist]
    line = line.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (stamps.length) for (const t of stamps) timed.push({ t, text: line });
    else plain.push(line);
  }
  if (timed.length) {
    timed.sort((a, b) => a.t - b.t);
    // Positiv offset betyder att texten ska visas tidigare
    return { synced: true, lines: timed.slice(0, 3000).map(l => ({ t: round(Math.max(0, l.t - offset), 3), text: l.text })) };
  }
  while (plain.length && !plain[0]) plain.shift();
  while (plain.length && !plain[plain.length - 1]) plain.pop();
  return { synced: false, lines: plain.slice(0, 3000).map(text => ({ t: null, text })) };
}

const LYRIC_TAG = (k) => k === 'lyrics' || k.startsWith('lyrics-') || k.startsWith('lyrics_') || k === 'unsyncedlyrics' || k === 'unsynced lyrics' || k === 'uslt' || k === '©lyr';
const NONE = { source: null, synced: false, lines: [] };
/** Text till ett spår: .lrc med samma namn bredvid ljudfilen, annars inbäddad tagg. */
export async function lyricsFor(track) {
  const ext = path.extname(track.path);
  const base = track.path.slice(0, track.path.length - ext.length);
  for (const e of ['.lrc', '.LRC', '.Lrc']) {
    try {
      const f = base + e, st = await fs.promises.stat(f);
      if (st.isFile() && st.size <= 512 * 1024) { const r = parseLrc(await fs.promises.readFile(f, 'utf8')); if (r.lines.length) return { source: 'lrc', ...r }; }
    } catch {}
  }
  let tags;
  try { tags = (await probe(track.path)).tags; } catch { return NONE; }
  const key = Object.keys(tags).find(LYRIC_TAG);
  if (!key || !String(tags[key]).trim()) return NONE;
  const r = parseLrc(String(tags[key]).slice(0, 512 * 1024));
  return r.lines.length ? { source: 'tag', ...r } : NONE;
}

// ---------------- smarta spellistor ----------------
export const SMART = [
  { id: 'top30', name: 'Mest spelat senaste 30 dagarna' },
  { id: 'forgotten', name: 'Favoriter du inte hört på länge' },
  { id: 'recent', name: 'Nyligen tillagt' },
  { id: 'never', name: 'Aldrig spelat' }
];
const DAY = 86400;
// Egna listor (server/smartlists.js) har id "u<nummer>" i samma API som de fasta – apparna visar dem utan ändring
const CUSTOM_ID = /^u([1-9]\d{0,9})$/;
/** Spåren i en smart lista för användaren (null om listan inte finns). */
export function smartTracks(libId, uid, id, { limit = 200, at = now() } = {}) {
  const cm = CUSTOM_ID.exec(String(id));
  if (cm) return custom.tracksFor(+cm[1], uid)?.tracks ?? null;
  if (!libOk(uid, libId)) return null; // bibliotek användaren inte får se (rättigheter per användare)
  // Stämningsstationer och låtradio från ljudanalysen (sonic.js) – samma format, så apparna visar dem utan ändring
  if (sonic.isSonicId(id)) return sonic.stationTracks(id, libId, uid, { limit });
  let rows;
  switch (id) {
    case 'top30':
      rows = all(`${TRACK_SQL} JOIN (SELECT track_id, COUNT(*) AS n, MAX(ts) AS last FROM track_plays WHERE user_id=? AND ts>=? GROUP BY track_id) p ON p.track_id=t.id
        WHERE t.library_id=? ORDER BY p.n DESC, p.last DESC LIMIT ?`, uid, at - 30 * DAY, libId, limit);
      break;
    case 'forgotten':
      // Favoriter som inte spelats på 60 dagar (eller aldrig) – längst sedan först
      rows = all(`${TRACK_SQL} JOIN favorites f ON f.track_id=t.id AND f.user_id=?
        LEFT JOIN (SELECT track_id, MAX(ts) AS last FROM track_plays WHERE user_id=? GROUP BY track_id) p ON p.track_id=t.id
        WHERE t.library_id=? AND COALESCE(p.last, 0) < ? ORDER BY COALESCE(p.last, 0), al.sort_title, t.disc_no, t.track_no LIMIT ?`, uid, uid, libId, at - 60 * DAY, limit);
      break;
    case 'recent':
      rows = all(`${TRACK_SQL} WHERE t.library_id=? ORDER BY t.added DESC, al.sort_title, t.disc_no, t.track_no LIMIT ?`, libId, limit);
      break;
    case 'never':
      // Blandas om en gång per dygn (stabil ordning under dagen, så att kön i bilen stämmer med listan)
      rows = all(`${TRACK_SQL} WHERE t.library_id=? AND NOT EXISTS (SELECT 1 FROM track_plays p WHERE p.track_id=t.id AND p.user_id=?)
        ORDER BY (t.id * 2654435761 + ?) % 1000003, t.id LIMIT ?`, libId, uid, Math.floor(at / DAY), limit);
      break;
    default: return null;
  }
  const favs = new Set(all('SELECT track_id FROM favorites WHERE user_id=?', uid).map(r => r.track_id));
  return rows.map(t => shapeTrack(t, favs));
}
/** Översikt för musikhemmet: listor som inte är tomma, med antal och upp till fyra omslag. */
// Att räkna alla listor kostar flera frågor över hela biblioteket – översikten cachas en minut per användare och bibliotek
const smartCache = new Map(); // "uid:libId" -> { v, t }
const SMART_TTL = 60e3;
export function smartLists(libId, uid) {
  const k = `${uid}:${libId}`, c = smartCache.get(k);
  if (c && Date.now() - c.t < SMART_TTL) return c.v;
  const v = countSmartLists(libId, uid);
  smartCache.set(k, { v, t: Date.now() });
  if (smartCache.size > 500) smartCache.delete(smartCache.keys().next().value);
  return v;
}
/** Tömmer översikten (efter att en egen lista skapats, ändrats, delats eller tagits bort). */
export function clearSmartCache() { smartCache.clear(); custom.clearCache(); }
const summary = (tracks) => ({ count: tracks.length, duration: tracks.reduce((a, t) => a + (t.duration || 0), 0),
  covers: [...new Set(tracks.filter(t => t.cover).map(t => t.albumId))].slice(0, 4) });
function countSmartLists(libId, uid) {
  const fixed = SMART.map(s => ({ id: s.id, name: s.name, ...summary(smartTracks(libId, uid, s.id)) }));
  // Egna och delade listor efter de fasta (samma fält; custom/mine/owner/shared är tillägg)
  const own = custom.listFor(uid).map(l => ({ id: 'u' + l.id, name: l.name, ...summary(custom.tracksFor(l.id, uid)?.tracks || []),
    custom: true, mine: l.mine, shared: l.shared, owner: l.mine ? null : l.owner }));
  // Stationer från ljudanalysen sist (station/icon/text är tillägg; webben visar dem på en egen hylla)
  let st = [];
  try { st = sonic.stations(libId, uid).map(s => ({ id: s.id, name: s.name, ...summary(s.tracks), station: true, icon: s.icon, text: s.text })); }
  catch (e) { console.warn('[ljudanalys] stationer:', e.message); }
  return [...fixed, ...own, ...st].filter(s => s.count > 0);
}
export function smartName(id, uid) {
  const cm = CUSTOM_ID.exec(String(id));
  if (cm) return custom.getFor(+cm[1], uid)?.name || null;
  if (sonic.isSonicId(id)) return sonic.stationName(id);
  return SMART.find(s => s.id === id)?.name || null;
}

// ---------------- inställningar per användare ----------------
export const SKIP_BACK = [5, 10, 15, 30, 45, 60], SKIP_FORWARD = [10, 15, 30, 45, 60, 90];
/** Övertoning i sekunder (0 = av) och lägen för jämn ljudnivå (webbens musikspelare; normalize = av/på för apparna). */
export const CROSSFADE = [0, 2, 4, 6, 8, 10, 12], NORM_MODES = ['track', 'album'];
export function getPrefs(uid) {
  const r = get('SELECT * FROM listen_prefs WHERE user_id=?', uid);
  const normalize = r ? !!r.normalize : true;
  return { normalize, skipBack: r?.skip_back ?? 15, skipForward: r?.skip_fwd ?? 30, skipSilence: !!r?.skip_silence,
    normMode: normalize ? (NORM_MODES.includes(r?.norm_mode) ? r.norm_mode : 'track') : 'off', gapless: r ? !!r.gapless : true, crossfade: r?.crossfade ?? 0,
    choices: { skipBack: SKIP_BACK, skipForward: SKIP_FORWARD, crossfade: CROSSFADE, normMode: ['track', 'album', 'off'] }, reference: REFERENCE_LUFS };
}
/** Sparar de fält som skickats med. Kastar Error med svensk text vid ogiltiga värden. */
export function setPrefs(uid, b = {}) {
  const cur = getPrefs(uid);
  const next = { ...cur, normMode: cur.normMode === 'off' ? (get('SELECT norm_mode FROM listen_prefs WHERE user_id=?', uid)?.norm_mode || 'track') : cur.normMode };
  if (b.normalize !== undefined) next.normalize = !!b.normalize;
  if (b.normMode !== undefined) {
    if (b.normMode === 'off') next.normalize = false;
    else if (NORM_MODES.includes(b.normMode)) { next.normalize = true; next.normMode = b.normMode; }
    else throw new Error('Ogiltigt läge för jämn ljudnivå');
  }
  if (b.skipSilence !== undefined) next.skipSilence = !!b.skipSilence;
  if (b.gapless !== undefined) next.gapless = !!b.gapless;
  if (b.crossfade !== undefined) { if (!CROSSFADE.includes(+b.crossfade)) throw new Error('Ogiltig längd på övertoningen'); next.crossfade = +b.crossfade; }
  if (b.skipBack !== undefined) { if (!SKIP_BACK.includes(+b.skipBack)) throw new Error('Ogiltigt hopp bakåt'); next.skipBack = +b.skipBack; }
  if (b.skipForward !== undefined) { if (!SKIP_FORWARD.includes(+b.skipForward)) throw new Error('Ogiltigt hopp framåt'); next.skipForward = +b.skipForward; }
  run(`INSERT INTO listen_prefs(user_id,normalize,skip_back,skip_fwd,skip_silence,norm_mode,gapless,crossfade,updated) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET normalize=excluded.normalize, skip_back=excluded.skip_back, skip_fwd=excluded.skip_fwd,
    skip_silence=excluded.skip_silence, norm_mode=excluded.norm_mode, gapless=excluded.gapless, crossfade=excluded.crossfade, updated=excluded.updated`,
    uid, next.normalize ? 1 : 0, next.skipBack, next.skipForward, next.skipSilence ? 1 : 0, next.normMode, next.gapless ? 1 : 0, next.crossfade, now());
  return getPrefs(uid);
}
