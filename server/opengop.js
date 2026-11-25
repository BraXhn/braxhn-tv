// Öppen GOP som webbläsaren inte kan börja avkoda mitt i (TS-remux av H.264, se docs/arkitektur.md).
//
// Chromes mjukvaruavkodare avbryter när avkodningen börjar på en nyckelbild som inte är IDR och en bild efter den
// hänvisar till GOP:en före (`mmco: unref short failure`). ra= (tslead.js) tar bort bilderna som visas FÖRE
// nyckelbilden – det räcker för vissa filer (x264 med fast antal B-bilder) men inte för andra (b-adapt), och vilka
// nyckelbilder som faller beror på filen. Spelaren kodar då om (remuxFallback i web/js/player/video.js), men det
// kostar ett fel och 1–2 s varje gång titeln spelas. Här provar servern själv några nyckelbilder, en gång per fil:
//   'closed' – nyckelbilderna är IDR (stängd GOP), inget att göra
//   'ra'     – öppen GOP, men varje prov gick att avkoda strikt med ra
//   'tc'     – öppen GOP som inte går att börja mitt i: webbläsare med hls.js omkodas direkt (stream.js decide)
// Ett prov = samma sak som spelaren får: TS-remux från nyckelbilden med SPS/PPS, bilderna före nyckelbilden
// borttagna (ra=0), avkodat med ffmpeg -err_detect explode -xerror (gör som Chrome, se test/open-gop-seek.test.js).
import { spawn } from 'node:child_process';
import { lowPriority } from './util.js';
import { dropLeading, keyIsIdr } from './tslead.js';

export const GOP_KINDS = ['closed', 'ra', 'tc'];
// Antal nyckelbilder att prova och hur mycket bild per prov (felet kommer i bilderna strax efter nyckelbilden).
// Mätt på fem riktiga avsnitt: i de filer som faller gör 24–60 % av nyckelbilderna det, med 0,5 s lika ofta som med 2,5 s.
export const SAMPLES = 8;
const SPAN = '0.5';
const SAFE_IN = ['-protocol_whitelist', 'file,pipe'];

/** Kör ffmpeg med lägsta prioritet. → { code, out } (out = stdout som Buffer) */
function ff(args, input = null, timeout = 20000) {
  return new Promise((ok) => {
    let p;
    try { p = spawn('ffmpeg', args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'] }); } catch { return ok({ code: -1, out: null }); }
    lowPriority(p, { io: false });
    const out = []; let size = 0;
    const kill = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => { size += d.length; if (size < 64 << 20) out.push(d); });
    p.on('error', () => {});
    p.on('close', (code) => { clearTimeout(kill); ok({ code: code ?? -1, out: Buffer.concat(out) }); });
    if (input) { p.stdin.on('error', () => {}); p.stdin.end(input); }
  });
}

/**
 * Ett prov på nyckelbilden kf (sekunder, filens tid). next = nästa nyckelbild (för sökpunkten: ffmpeg landar på
 * nyckelbilden vars DTS ≤ sökpunkten, som segmenten i stream.js). → { idr, ok } eller null (gick inte att läsa).
 */
export async function sample(file, kf, next = kf + 1) {
  const ss = kf + Math.max(0, Math.min(0.2, (next - kf) / 2));
  const seg = await ff(['-hide_banner', '-v', 'error', '-nostdin', ...SAFE_IN, '-ss', ss.toFixed(3), '-noaccurate_seek', '-i', file, '-map', '0:v:0', '-c', 'copy',
    '-bsf:v', 'h264_mp4toannexb,dump_extra=freq=keyframe', '-t', SPAN, '-f', 'mpegts', 'pipe:1']);
  if (seg.code !== 0 || !seg.out?.length) return null;
  const idr = keyIsIdr(seg.out);
  if (idr == null) return null;
  if (idr) return { idr: true, ok: true };
  const dec = await ff(['-hide_banner', '-v', 'error', '-nostdin', '-threads', '1', '-err_detect', 'explode', '-xerror', '-f', 'mpegts', '-i', 'pipe:0', '-an', '-f', 'null', '-'], dropLeading(seg.out, 0));
  return { idr: false, ok: dec.code === 0 };
}

/** Nyckelbilderna att prova: jämnt fördelade, inte den första (alltid IDR) och inte alldeles i slutet. at = prova just där. */
export function picks(kf, duration, { at = null, n = SAMPLES } = {}) {
  const inner = [];
  for (let i = 0; i < kf.length; i++) if (kf[i] >= 1 && (!duration || kf[i] < duration - 1.5)) inner.push(i);
  if (at != null) {
    // Spelaren rapporterade felet vid at: nyckelbilden före och den efter (avkodningen började på någon av dem)
    let j = -1; for (const i of inner) if (kf[i] <= at + 0.05) j = i;
    return [...new Set([j, inner.find(i => kf[i] > at + 0.05)].filter(i => i != null && i >= 0))].map(i => [kf[i], kf[i + 1] ?? kf[i] + 1]);
  }
  if (inner.length <= n) return inner.map(i => [kf[i], kf[i + 1] ?? kf[i] + 1]);
  const out = [];
  for (let k = 0; k < n; k++) { const i = inner[Math.floor((k + 0.5) * inner.length / n)]; out.push([kf[i], kf[i + 1] ?? kf[i] + 1]); }
  return out;
}

/**
 * Vilken sorts GOP har filen? → 'closed' | 'ra' | 'tc' | null (gick inte att avgöra).
 * Slutar vid första prov som inte går att avkoda. Två IDR-bilder utan någon annan nyckelbild räcker för 'closed'
 * (x264 med öppen GOP kan ändå lägga en IDR vid ett scenbyte – därför inte en).
 * opts.at: prova bara runt den positionen (spelarens rapport) – ger 'tc' eller null, aldrig en friskförklaring.
 */
export async function classify(file, kf, duration, { at = null, sampleFn = sample } = {}) {
  if (!Array.isArray(kf) || kf.length < 2) return null;
  let idr = 0, open = 0;
  for (const [t, next] of picks(kf, duration, { at })) {
    const r = await sampleFn(file, t, next);
    if (!r) continue;
    if (!r.ok) return 'tc';
    if (r.idr) { idr++; if (at == null && idr >= 2 && !open) return 'closed'; } else open++;
  }
  if (at != null) return null;
  return open ? 'ra' : idr ? 'closed' : null;
}
