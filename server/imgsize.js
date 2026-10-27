// Bilder i rätt storlek: affischer, bakgrunder, miniatyrer och omslag skalas ned till den bredd klienten
// behöver (?w=), så att bläddring över mobilnätet inte hämtar bilder i full storlek. Bara ett fåtal fasta
// bredder finns (cachen hålls liten och går inte att fylla med godtyckliga storlekar), varje variant görs
// en gång med ffmpeg och sparas i cachen. Bilder förstoras aldrig.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { CACHE, CONFIG } from './db.js';
import { readImageInfo } from './exif.js';

export const SIZES = [160, 240, 320, 480, 720, 1280];
// Foton (server/photos.js) visas även i helskärm: två större bredder, bara för fotobibliotekens bilder
export const PHOTO_SIZES = [...SIZES, 1920, 2560];
// EXIF-orienteringen (1–8) som ffmpeg-filter. Bilden läses med -noautorotate så att resultatet är detsamma oavsett
// om ffmpeg-versionen själv vrider JPEG efter EXIF (6.x gör det, 5.1 inte).
export const ORIENT_FILTER = { 2: 'hflip', 3: 'hflip,vflip', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' };
// HEIC från telefoner är ett rutnät av HEVC-rutor (iPhone: 512×512). ffmpeg 7.1 läser rutorna som var sin ström i en
// strömgrupp (Tile Grid) men sätter inte ihop dem själv – utan detta blev miniatyren bildens övre vänstra ruta.
// Rutorna läggs på sina platser med xstack och beskärs till bildens storlek; rotationen (irot, kvarts varv moturs)
// tillämpas efteråt med -noautorotate, så att rutorna inte vrids var för sig.
export const IROT_FILTER = { 1: 'transpose=2', 2: 'hflip,vflip', 3: 'transpose=1' };
/** Filterkedja som sätter ihop rutnätet (ffprobes stream_groups-post av typen Tile Grid), eller null */
export function heifGridGraph(group) {
  const c = group?.type === 'Tile Grid' ? group.components?.[0] : null;
  const subs = (c?.subcomponents || []).filter(x => Number.isInteger(x.stream_index));
  if (!subs.length || !(c.width > 0 && c.height > 0)) return null;
  const crop = `crop=${c.width}:${c.height}:${c.horizontal_offset || 0}:${c.vertical_offset || 0}`;
  if (subs.length === 1) return `[0:${subs[0].stream_index}]${crop}`;
  return subs.map(x => `[0:${x.stream_index}]`).join('') +
    `xstack=inputs=${subs.length}:layout=${subs.map(x => `${x.tile_horizontal_offset | 0}_${x.tile_vertical_offset | 0}`).join('|')},${crop}`;
}
/** Rutnätet i en HEIF-fil (ffprobe 7.1+; äldre känner inte till -show_stream_groups → null, som en ensam bild) */
function heifGrid(src) {
  return new Promise(res => execFile('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_stream_groups', '-of', 'json', src],
    { timeout: 15000, maxBuffer: 4 << 20 }, (e, out) => {
      if (e) return res(null);
      try { res(heifGridGraph((JSON.parse(out).stream_groups || []).find(g => g.type === 'Tile Grid'))); } catch { res(null); }
    }));
}
const DIR = path.join(CACHE, 'img');
// Samtidiga skalningar: halva processorn, minst 2 och högst 4 (strömningen får aldrig svältas ut)
const LIMIT = Math.min(4, Math.max(2, os.cpus().length >> 1)), MAX_WAITING = 300;
// Så länge väntar en förfrågan på en ny variant innan originalet skickas i stället. Första besöket på en sida
// med många nya affischer ska inte vänta på ffmpeg – varianten blir klar i bakgrunden och används nästa gång.
const WAIT_MS = 300;
/** Räknare (för tester och felsökning): antal skalningar som gjorts och som misslyckats */
export const stats = { resized: 0, failed: 0 };

/** ?w= till närmaste fasta bredd uppåt; ogiltigt, saknat eller större än största bredden → null (originalet) */
export function snapWidth(v, sizes = SIZES) {
  if (!Array.isArray(sizes)) sizes = SIZES; // t.ex. list.map(snapWidth): andra argumentet är indexet
  if (v == null || !/^\d{1,5}$/.test(String(v))) return null;
  const n = +v;
  if (!n || n > sizes.at(-1)) return null;
  return sizes.find(s => s >= n);
}

/** Bildens bredd ur JPEG- eller PNG-huvudet, null om den inte går att läsa */
export function imageWidth(b) {
  if (b.length > 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return b.readUInt32BE(16);
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { i += 2; continue; }
    // SOF0–SOF15 (utom DHT, JPG och DAC) bär bildens storlek
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return b.readUInt16BE(i + 7) || null;
    if (m === 0xDA) return null;
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
// Källbildernas bredd per fil och ändringstid (läses ur de första 256 kB)
const widths = new Map();
function widthOf(src, st) {
  const k = `${src}|${st.mtimeMs}|${st.size}`;
  if (widths.has(k)) return widths.get(k);
  let w = null;
  try {
    const fd = fs.openSync(src, 'r');
    try { const b = Buffer.alloc(Math.min(st.size, 256 << 10)); w = imageWidth(b.subarray(0, fs.readSync(fd, b, 0, b.length, 0))); }
    finally { fs.closeSync(fd); }
  } catch {}
  if (widths.size > 20000) widths.clear();
  widths.set(k, w);
  return w;
}

// Varje källbild får en egen mapp i cachen (namnet från sökvägen under konfigurationsmappen)
function keyOf(src) {
  const rel = path.relative(CONFIG, src);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/[^\w.-]+/g, '_').slice(0, 150);
  return 'x_' + crypto.createHash('sha1').update(src).digest('hex').slice(0, 20);
}
/** Tar bort de skalade varianterna av en bild (när bilden tas bort) */
export function dropVariants(src) { fs.rm(path.join(DIR, keyOf(src)), { recursive: true, force: true }, () => {}); }

// Högst LIMIT ffmpeg åt gången; samma variant görs bara en gång även om många frågar samtidigt
let active = 0;
const waiting = [], inflight = new Map(), failedAt = new Map();
const release = () => { const next = waiting.shift(); next ? next() : active--; };
function resize(src, out, w, stamp, orient = 0, heif = false) {
  return new Promise((resolve) => {
    const run = async () => {
      const tmp = out + '.tmp';
      // HEIF-rutnät: sätts ihop först, rotationen ur behållaren (se heifGridGraph)
      const grid = heif ? await heifGrid(src) : null;
      let irot = 0;
      if (grid) try { irot = (await readImageInfo(src)).rotation || 0; } catch {}
      // orient: EXIF-orienteringen tillämpas efter skalningen; 0 = ffmpeg bestämmer själv (som tidigare)
      // Kvarts varv (5–8, irot 1/3): bredden w gäller bilden som den visas, alltså filens höjd
      const rf = grid ? IROT_FILTER[irot] : ORIENT_FILTER[orient];
      const rot = rf ? ',' + rf : '';
      const scale = (grid ? irot === 1 || irot === 3 : orient >= 5) ? `scale=-2:'min(${w},ih)':flags=lanczos` : `scale='min(${w},iw)':-2:flags=lanczos`;
      const vf = grid ? ['-filter_complex', `${grid},${scale}${rot}[o]`, '-map', '[o]'] : ['-vf', `${scale}${rot}`];
      execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', ...(orient || grid ? ['-noautorotate'] : []), '-i', src,
        '-frames:v', '1', ...vf, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', '-update', '1', tmp],
      { timeout: 30000 }, (e) => {
        let ok = !e;
        if (ok) { try { fs.renameSync(tmp, out); stats.resized++; } catch { ok = false; } }
        if (!ok) { fs.rm(tmp, { force: true }, () => {}); stats.failed++; failedAt.set(out, Date.now()); if (failedAt.size > 5000) failedAt.clear(); }
        else {
          // Varianter av en äldre version av bilden behövs inte längre
          const dir = path.dirname(out);
          fs.readdir(dir, (_, fl = []) => { for (const f of fl) if (!f.includes(stamp)) fs.rm(path.join(dir, f), { force: true }, () => {}); });
        }
        release();
        resolve(ok ? out : src);
      });
    };
    if (active < LIMIT) { active++; run(); } else waiting.push(run);
  });
}

const waitFor = (p, src, ms) => ms === Infinity ? p : Promise.race([p, new Promise(r => setTimeout(r, ms, src).unref())]);
/**
 * Sökvägen till bilden i bredden ?w= (från cachen, skalas vid första förfrågan), eller originalet när ingen
 * giltig bredd angavs, källan redan är lika smal eller skalningen misslyckas.
 * @param {string} src  källbilden
 * @param {string|null} wq  värdet på ?w=
 * @param {number} [wait]  längsta väntan på en ny variant (ms) innan originalet används; Infinity = vänta tills den är klar
 * @param {{ sizes?: number[], orient?: number, force?: boolean, heif?: boolean }} [opts]  foton: bredderna (PHOTO_SIZES), EXIF-orienteringen
 *   (1–8, tillämpas på varianten), force = gör alltid en JPEG-variant (format som webbläsaren inte kan visa, t.ex. HEIC)
 *   och heif = HEIF-fil (rutnätet sätts ihop)
 * @returns {Promise<string>}
 */
export async function sized(src, wq, wait = WAIT_MS, { sizes = SIZES, orient = 0, force = false, heif = false } = {}) {
  const w = snapWidth(wq, sizes);
  if (!w || !src) return src;
  let st; try { st = await fs.promises.stat(src); } catch { return src; }
  const sw = force ? null : widthOf(src, st);
  if (sw != null && sw <= w) return src;
  // Ändras källbilden får varianten ett nytt namn (ändringstid och storlek i namnet)
  const stamp = `-${Math.floor(st.mtimeMs)}-${st.size}${orient > 1 ? '-o' + orient : ''}.jpg`;
  const out = path.join(DIR, keyOf(src), w + stamp);
  if (fs.existsSync(out)) return out;
  if ((failedAt.get(out) || 0) > Date.now() - 3600e3) return src;
  if (inflight.has(out)) return waitFor(inflight.get(out), src, wait);
  if (waiting.length >= MAX_WAITING) return src;
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { return src; }
  const p = resize(src, out, w, stamp, orient, heif).finally(() => inflight.delete(out));
  inflight.set(out, p);
  return waitFor(p, src, wait);
}
