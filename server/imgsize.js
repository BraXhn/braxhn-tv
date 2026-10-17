// Bilder i rätt storlek: affischer, bakgrunder, miniatyrer och omslag skalas ned till den bredd klienten
// behöver (?w=), så att bläddring över mobilnätet inte hämtar bilder i full storlek. Bara ett fåtal fasta
// bredder finns (cachen hålls liten och går inte att fylla med godtyckliga storlekar), varje variant görs
// en gång med ffmpeg och sparas i cachen. Bilder förstoras aldrig.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { CACHE, CONFIG } from './db.js';

export const SIZES = [160, 240, 320, 480, 720, 1280];
const DIR = path.join(CACHE, 'img');
const LIMIT = 2, MAX_WAITING = 300;
/** Räknare (för tester och felsökning): antal skalningar som gjorts och som misslyckats */
export const stats = { resized: 0, failed: 0 };

/** ?w= till närmaste fasta bredd uppåt; ogiltigt, saknat eller större än största bredden → null (originalet) */
export function snapWidth(v) {
  if (v == null || !/^\d{1,5}$/.test(String(v))) return null;
  const n = +v;
  if (!n || n > SIZES.at(-1)) return null;
  return SIZES.find(s => s >= n);
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

// Högst två ffmpeg åt gången; samma variant görs bara en gång även om många frågar samtidigt
let active = 0;
const waiting = [], inflight = new Map(), failedAt = new Map();
const release = () => { const next = waiting.shift(); next ? next() : active--; };
function resize(src, out, w, stamp) {
  return new Promise((resolve) => {
    const run = () => {
      const tmp = out + '.tmp';
      execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-i', src,
        '-frames:v', '1', '-vf', `scale='min(${w},iw)':-2:flags=lanczos`, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', '-update', '1', tmp],
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

/**
 * Sökvägen till bilden i bredden ?w= (från cachen, skalas vid första förfrågan), eller originalet när ingen
 * giltig bredd angavs, källan redan är lika smal eller skalningen misslyckas.
 * @param {string} src  källbilden
 * @param {string|null} wq  värdet på ?w=
 * @returns {Promise<string>}
 */
export async function sized(src, wq) {
  const w = snapWidth(wq);
  if (!w || !src) return src;
  let st; try { st = await fs.promises.stat(src); } catch { return src; }
  const sw = widthOf(src, st);
  if (sw != null && sw <= w) return src;
  // Ändras källbilden får varianten ett nytt namn (ändringstid och storlek i namnet)
  const stamp = `-${Math.floor(st.mtimeMs)}-${st.size}.jpg`;
  const out = path.join(DIR, keyOf(src), w + stamp);
  if (fs.existsSync(out)) return out;
  if ((failedAt.get(out) || 0) > Date.now() - 3600e3) return src;
  if (inflight.has(out)) return inflight.get(out);
  if (waiting.length >= MAX_WAITING) return src;
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { return src; }
  const p = resize(src, out, w, stamp).finally(() => inflight.delete(out));
  inflight.set(out, p);
  return p;
}
