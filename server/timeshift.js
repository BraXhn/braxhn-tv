// Timeshift för live-TV: segmenten från ffmpeg sparas bakåt i tiden (standard 2 timmar) så att man kan pausa
// och spola tillbaka. Spellistan serveras som en lång glidande live-lista (utan ENDLIST och utan PLAYLIST-TYPE):
// hls.js, Safari/AVPlayer och ExoPlayer visar då ett spolbart fönster och hoppar till direktsändningen vid start.
// En EVENT-lista får aldrig krympa, vilket inte går ihop med tidsgränsen och disktaket.
import fs from 'node:fs';
import path from 'node:path';
import { getSetting } from './db.js';

export const SEG_SECONDS = 4;              // -hls_time för live
export const SEG_RE = /^seg-\d{5,9}\.ts$/; // seg-%05d.ts (blir sexsiffrigt efter 99999 segment)
export const segNum = (name) => parseInt(String(name).slice(4), 10);
export const MIN_FREE = 2e9;               // lämna alltid minst så här mycket ledigt på disken
const KEEP = 6;                            // de nyaste segmenten tas aldrig bort av disktaket

const num = (k, env, def, lo, hi) => {
  const v = parseFloat(getSetting(k, process.env[env] ?? String(def)));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
};
/** Hur många minuter bakåt som sparas (0 = av: bara en kort lista som tidigare) */
export const timeshiftMinutes = () => Math.round(num('live_timeshift_minutes', 'LIVE_TIMESHIFT_MINUTES', 120, 0, 720));
/** Disktak för alla pågående live-strömmar tillsammans, i GB */
export const timeshiftMaxGb = () => num('live_timeshift_max_gb', 'LIVE_TIMESHIFT_MAX_GB', 20, 0.5, 2000);
/** Antal segment i ffmpegs spellista (-hls_list_size) */
export const listSize = (minutes = timeshiftMinutes()) => minutes > 0 ? Math.max(8, Math.ceil(minutes * 60 / SEG_SECONDS)) : 8;

// Taggar som hör till nästa segment (allt annat före första segmentet är spellistans huvud)
const SEG_TAG = /^#(EXTINF|EXT-X-DISCONTINUITY$|EXT-X-PROGRAM-DATE-TIME|EXT-X-BYTERANGE|EXT-X-GAP|EXT-X-BITRATE)/;

/** Skriver om ffmpegs spellista: segment med nummer under minSeg (borttagna av disktaket) tas bort, MEDIA-SEQUENCE
 *  och DISCONTINUITY-SEQUENCE räknas upp så att spelarna inte tappar bort sig, och token läggs på segmentadresserna.
 *  Det senaste segmentet behålls alltid, så att listan aldrig blir tom. */
export function rewritePlaylist(text, { minSeg = 0, token = null } = {}) {
  const head = [], tail = [], entries = [];
  let tags = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      if (SEG_TAG.test(l)) tags.push(l);
      else (entries.length || tags.length ? tail : head).push(l);
    } else { entries.push({ tags, uri: l }); tags = []; }
  }
  let drop = 0, disc = 0;
  while (drop < entries.length - 1 && SEG_RE.test(entries[drop].uri) && segNum(entries[drop].uri) < minSeg) {
    if (entries[drop].tags.includes('#EXT-X-DISCONTINUITY')) disc++;
    drop++;
  }
  const kept = entries.slice(drop);
  let hasDisc = false;
  const out = head.map(l => {
    let m = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(l);
    if (m) return `#EXT-X-MEDIA-SEQUENCE:${+m[1] + drop}`;
    m = /^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(l);
    if (m) { hasDisc = true; return `#EXT-X-DISCONTINUITY-SEQUENCE:${+m[1] + disc}`; }
    return l;
  });
  if (drop && !out.some(l => l.startsWith('#EXT-X-MEDIA-SEQUENCE'))) out.push(`#EXT-X-MEDIA-SEQUENCE:${drop}`);
  if (disc && !hasDisc) out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${disc}`);
  const q = token ? `?t=${encodeURIComponent(token)}` : '';
  for (const e of kept) out.push(...e.tags, SEG_RE.test(e.uri) ? e.uri + q : e.uri);
  out.push(...tags, ...tail); // ffmpeg skriver normalt inget efter sista segmentet (omit_endlist)
  return out.join('\n') + '\n';
}

export function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}
function segmentsOf(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => SEG_RE.test(n)); } catch { return []; }
  const out = [];
  for (const name of names) {
    try { out.push({ name, num: segNum(name), size: fs.statSync(path.join(dir, name)).size }); } catch {} // hann tas bort
  }
  return out.sort((a, b) => a.num - b.num);
}

/** Disktak: så länge alla live-strömmar tillsammans tar mer än maxBytes, eller disken har mindre än minFree ledigt,
 *  tas det äldsta segmentet bort från den ström som tar mest plats. Sessionens minSeg flyttas fram så att
 *  spellistan slutar visa borttagna segment. sessions: [{ dir, minSeg }]. Returnerar antal borttagna segment. */
export function enforceCap(sessions, { maxBytes = timeshiftMaxGb() * 1e9, minFree = MIN_FREE, keep = KEEP, free = freeBytes } = {}) {
  const list = sessions.map(s => ({ s, segs: segmentsOf(s.dir) }));
  for (const x of list) x.bytes = x.segs.reduce((a, b) => a + b.size, 0);
  let total = list.reduce((a, b) => a + b.bytes, 0);
  let avail = list.length ? free(list[0].s.dir) : Infinity;
  let removed = 0;
  while (total > maxBytes || avail < minFree) {
    const x = list.filter(y => y.segs.length > keep).sort((a, b) => b.bytes - a.bytes)[0];
    if (!x) break;
    const seg = x.segs.shift();
    try { fs.rmSync(path.join(x.s.dir, seg.name), { force: true }); } catch {}
    x.s.minSeg = Math.max(x.s.minSeg || 0, seg.num + 1);
    x.bytes -= seg.size; total -= seg.size; avail += seg.size; removed++;
  }
  return removed;
}
