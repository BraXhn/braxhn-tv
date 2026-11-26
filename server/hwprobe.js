// Provet av hårdvaruomkodningen (Administration → Hårdvaruomkodning → Prova omkodningen, routes/setup.js).
// Kodar en genererad testbild (lavfi, aldrig användarens filer) i några sekunder per kodare: H.264, HEVC och 10-bitars
// HEVC, i 1080p och 4K, med vald hårdvara (HWACCEL) och med processorn som jämförelse. Kodarens argument är desamma
// som vid riktig omkodning (encArgs i stream.js), så att provet visar det uppspelningen faktiskt får.
//
// Hastigheten mäts ur ffmpegs -progress (bildrutor mellan första kodade bild och slutet av mätfönstret), så att
// uppstarten av grafikkortet (ofta en halv sekund) inte räknas. Testbilden är några rutor som spelas i slinga
// (loop-filtret) – att rita testsrc2 i 4K klarar bara ~100 bilder/s och skulle annars bromsa grafikkortet.
//
// När en kodare inte fungerar tolkas ffmpegs felutskrift till en åtgärd (explain(), rena funktioner som testas med
// verkliga felrader från NVENC, VAAPI och QSV). Texten finns i webben (web/js/views/admin-hwprobe.js) per kod.
// Senaste resultatet sparas i inställningen hw_probe_last och följer med i diagnostikpaketet (diagnostics.js).
// ffmpeg körs med lägsta prioritet (util.lowPriority), och provet avbryts om många strömmar börjar omkodas.
import fs from 'node:fs';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { getSetting, setSetting } from './db.js';
import { lowPriority } from './util.js';
import { encArgs, hwStatus } from './stream.js';

export const MODES = ['none', 'nvenc', 'vaapi', 'qsv', 'videotoolbox'];
export const CODECS = ['h264', 'hevc', 'hevc10'];
export const SIZES = { '1080p': '1920x1080', '2160p': '3840x2160' };
// Provet vägras när så här många strömmar omkodas (filmer, serier och live-TV tillsammans); ett objekt så att
// testerna kan ändra gränsen
export const limits = { busy: 2 };
const RATE = 25; // testbildens bildfrekvens: "gånger realtid" = bildrutor/s ÷ 25
const WINDOW_MS = 2000; // mätfönster efter första kodade bild
const START_MS = 15000; // längsta väntan på första bilden (drivrutin som hänger)
// 4K provas bara när 1080p klarar minst så här många bildrutor/s (annars blir 4K under realtid ändå)
const MIN_FPS_FOR_4K = 50;
const vaapiDevice = () => process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

/** Kodarens namn i ffmpeg för läge och codec */
export function encoderName(mode, codec) {
  const vc = codec === 'hevc10' ? 'hevc' : codec;
  if (mode === 'none') return vc === 'h264' ? 'libx264' : 'libx265';
  return `${vc}_${mode}`;
}

/**
 * ffmpeg-argumenten för ett prov (utan -progress). Testbilden får redan rätt pixelformat, och grafikkortets
 * kodare får samma argument som vid omkodning (encArgs).
 * @returns {string[]|null} null = okänt läge eller codec
 */
export function probeArgs(mode, codec, size = '1080p') {
  if (!MODES.includes(mode) || !CODECS.includes(codec) || !SIZES[size]) return null;
  const ten = codec === 'hevc10', vc = ten ? 'hevc' : codec;
  const fmt = mode === 'none' ? (ten ? 'yuv420p10le' : 'yuv420p') : (ten ? 'p010le' : mode === 'nvenc' ? 'yuv420p' : 'nv12');
  const src = ['-f', 'lavfi', '-i', `testsrc2=s=${SIZES[size]}:r=${RATE}:d=${6 / RATE},format=${fmt},loop=loop=-1:size=6`];
  const big = size === '2160p';
  let enc, pre = [], vf = [];
  if (mode === 'videotoolbox') enc = ['-c:v', `${vc}_videotoolbox`, '-realtime', '1'];
  else enc = encArgs(mode, vc, null, big);
  if (mode === 'vaapi') { pre = ['-vaapi_device', vaapiDevice()]; vf = ['-vf', 'hwupload']; }
  if (ten) {
    const i = enc.indexOf('-profile:v');
    if (i >= 0) enc = [...enc.slice(0, i + 1), 'main10', ...enc.slice(i + 2)];
    else enc = [...enc, '-profile:v', 'main10'];
  }
  return [...pre, ...src, ...vf, ...enc, '-an', '-f', 'null', '-'];
}

// Rader i ffmpegs utskrift som inte säger något om orsaken (följdfel)
const NOISE = /^(Nothing was written into output file|Error while filtering|Error parsing global options|Conversion failed|Error opening output files?|Error while opening encoder|Exiting normally|Error initializing output stream|Error marking filters as finished|Terminating thread with return code|Could not open encoder before EOF|Task finished with error code|Error sending frames to consumers|Error while processing the decoded data)/i;
const strip = (l) => String(l).replace(/^(\[[^\]]+\]\s*)+/, '').trim();

/** Den rad i ffmpegs felutskrift som bäst förklarar felet (första raden som inte är ett följdfel) */
export function keyLine(stderr) {
  const lines = String(stderr || '').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.find(l => !NOISE.test(strip(l))) || lines[lines.length - 1] || '';
}

/**
 * Tolkar ffmpegs felutskrift till en åtgärd. ctx beskriver containern: { dri: 'missing'|'denied'|'ok',
 * nvidia: true|false (en NVIDIA-enhet syns), visible: NVIDIA_VISIBLE_DEVICES, caps: NVIDIA_DRIVER_CAPABILITIES }.
 * @returns {{ code: string, encoder?: string }} code förklaras i webben (admin-hwprobe.js)
 */
export function explain(mode, codec, stderr, ctx = {}) {
  const e = String(stderr || '');
  const encoder = encoderName(mode, codec);
  if (/spawn ffmpeg ENOENT/.test(e)) return { code: 'no-ffmpeg' };
  if (e.trim() === 'timeout') return { code: 'timeout' };
  if (new RegExp(`Unknown encoder '?${encoder}|Encoder not found|Requested encoder .*not (found|available)|Unrecognized option 'vaapi_device'`, 'i').test(e))
    return { code: mode === 'videotoolbox' ? 'vt-only-mac' : 'no-encoder', encoder };
  if (mode === 'videotoolbox') return { code: 'vt-only-mac' };
  // Formatet (profilen) går inte på den här hårdvaran – vanligast 10-bitars HEVC på äldre kort/processorer
  const format = /10 ?bit encode not supported|Unsupported profile|profile.*(not supported|unsupported)|No usable encoding (entrypoint|profile)|VAProfile\w+ .*not supported|requested VAProfile is not supported|Current profile is unsupported|invalid video parameters \(-15\)|Video parameter .*unsupported|Main ?10 .*not supported|does not support (10-bit|main10|HEVC)|Hardware does not support encoding at size|width or height .*not supported|frame size .*unsupported/i;
  if (mode === 'nvenc') {
    if (/libnvidia-encode/i.test(e)) return { code: 'nv-caps' };
    if (/libcuda|Cannot load (libcuda|nvcuda)|Could not dynamically load CUDA/i.test(e)) return { code: ctx.nvidia ? 'nv-runtime' : 'nv-not-visible' };
    if (/CUDA_ERROR_NO_DEVICE|no CUDA-capable device/i.test(e)) return { code: 'nv-no-device' };
    if (/minimum required Nvidia driver|Driver does not support the required nvenc API|nvenc API version|update your driver/i.test(e)) return { code: 'nv-driver-old' };
    if (/CUDA_ERROR_UNKNOWN|CUDA_ERROR_SYSTEM_DRIVER_MISMATCH|driver\/library version mismatch|CUDA_ERROR_NOT_INITIALIZED/i.test(e)) return { code: 'nv-mismatch' };
    if (/incompatible client key|OpenEncodeSessionEx failed: out of memory|OpenEncodeSessionEx failed/i.test(e)) return { code: 'nv-busy' };
    if (format.test(e)) return { code: 'format' };
    if (/No (NVENC )?capable devices found|not supported by the device|No capable devices/i.test(e)) return { code: 'nv-unsupported' };
  }
  if (mode === 'vaapi' || mode === 'qsv') {
    if (ctx.dri === 'missing') return { code: 'dri-missing' };
    if (ctx.dri === 'denied' || /Permission denied|EACCES|Operation not permitted.*\/dev\/dri/i.test(e)) return { code: 'dri-denied' };
    if (format.test(e)) return { code: 'format' };
  }
  if (mode === 'vaapi') {
    if (/va_openDriver\(\) returns|vaInitialize failed|Failed to initiali[sz]e VAAPI connection|libva error|unknown libva error|vaGetDriverName/i.test(e)) return { code: 'va-driver' };
    if (/No VA display found/i.test(e)) return { code: 'va-driver' };
  }
  if (mode === 'qsv') {
    if (/MFX session|MFX_ERR|Device creation failed: -542398533|Error initializing an internal MFX session|unsupported \(-3\)|libvpl|Generic error in an external library|qsv/i.test(e)) return { code: 'qsv-none' };
  }
  return { code: 'unknown' };
}

/** Läget för /dev/dri: missing (enheten finns inte), denied (finns men får inte användas) eller ok */
export function driState(dev = vaapiDevice()) {
  if (!fs.existsSync(dev)) return 'missing';
  try { fs.accessSync(dev, fs.constants.R_OK | fs.constants.W_OK); return 'ok'; } catch { return 'denied'; }
}
/** Vad containern ser (till explain) */
export function context() {
  return { dri: driState(), nvidia: fs.existsSync('/dev/nvidiactl') || fs.existsSync('/dev/nvidia0'),
    visible: process.env.NVIDIA_VISIBLE_DEVICES || null, caps: process.env.NVIDIA_DRIVER_CAPABILITIES || null };
}
/** Läget som enheterna i containern pekar på (samma val som installationsguiden föreslår) */
export function detected() {
  const c = context();
  if (c.nvidia) return 'nvenc';
  if (c.dri !== 'missing') return /intel/i.test(os.cpus()[0]?.model || '') ? 'qsv' : 'vaapi';
  return 'none';
}

let encoderList = null;
/** Kodarna som ffmpeg i containern har (en gång per körning) */
function encoders() {
  if (!encoderList) encoderList = new Promise(r => execFile('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 8000 }, (e, o) => r(e ? null : new Set(String(o).match(/\b\w+_(nvenc|vaapi|qsv|videotoolbox)\b|\blibx26[45]\b/g) || []))));
  return encoderList;
}

/**
 * Kör ett prov och mäter hastigheten.
 * @returns {Promise<{ ok: boolean, fps: number, error?: string, log?: string }>}
 */
export function measure(args, { windowMs = WINDOW_MS, startMs = START_MS } = {}) {
  return new Promise(res => {
    let p;
    try { p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-stats_period', '0.25', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return res({ ok: false, fps: 0, error: String(e.message), log: String(e.message) }); }
    lowPriority(p);
    let err = '', first = null, last = null, done = false, buf = '';
    const finish = (r) => { if (done) return; done = true; clearTimeout(tStart); clearTimeout(tEnd); try { p.kill('SIGKILL'); } catch {} res(r); };
    const rate = () => first && last && last.t > first.t && last.f > first.f ? Math.round((last.f - first.f) / ((last.t - first.t) / 1000)) : 0;
    const tStart = setTimeout(() => finish(first ? { ok: true, fps: rate() } : { ok: false, fps: 0, error: 'timeout', log: err.slice(-4000) }), startMs);
    let tEnd = null;
    p.stdout.on('data', (d) => {
      buf += d;
      let m; const re = /frame=(\d+)/g;
      while ((m = re.exec(buf))) {
        const f = +m[1], t = Date.now();
        if (f > 0 && !first) { first = { f, t }; tEnd = setTimeout(() => finish({ ok: true, fps: rate() }), windowMs); }
        else if (first) last = { f, t };
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    p.on('error', (e) => finish({ ok: false, fps: 0, error: `spawn ffmpeg ${e.code || e.message}`, log: String(e.message) }));
    // Slutade innan mätfönstret var slut: fel, eller (sällan) att alla rutor redan var kodade
    p.on('close', (code) => finish(code === 0 || (first && last) ? { ok: true, fps: rate() } : { ok: false, fps: 0, error: err.trim() || `ffmpeg avslutades med kod ${code}`, log: err.slice(-4000) }));
  });
}

const x = (fps) => +(fps / RATE).toFixed(1);
const lastLines = (s, n = 8) => String(s || '').split('\n').map(l => l.trim()).filter(Boolean).slice(-n).join('\n').slice(0, 2000);

/** Ett prov för en kodare: 1080p och, om det går fort nog, 4K */
async function probeOne(mode, codec, have, ctx, run) {
  const encoder = encoderName(mode, codec);
  const row = { mode, codec, encoder, status: 'fail', fps: {}, realtime: {}, skipped4k: null, explanation: null, line: null, log: null };
  if (have && !have.has(encoder)) {
    Object.assign(row, { explanation: mode === 'videotoolbox' ? { code: 'vt-only-mac' } : { code: 'no-encoder', encoder }, line: `Unknown encoder '${encoder}'` });
    return row;
  }
  const r = await run(probeArgs(mode, codec, '1080p'));
  if (!r.ok) {
    row.explanation = explain(mode, codec, r.error, ctx);
    row.line = r.error === 'timeout' ? 'timeout' : keyLine(r.error).slice(0, 400);
    row.log = lastLines(r.log || r.error);
    return row;
  }
  row.status = mode === 'none' ? 'cpu' : 'gpu';
  row.fps['1080p'] = r.fps; row.realtime['1080p'] = x(r.fps);
  if (r.fps < MIN_FPS_FOR_4K) { row.skipped4k = 'slow'; return row; }
  const r4 = await run(probeArgs(mode, codec, '2160p'));
  if (r4.ok) { row.fps['2160p'] = r4.fps; row.realtime['2160p'] = x(r4.fps); }
  else { row.skipped4k = 'failed'; row.line4k = keyLine(r4.error).slice(0, 400); }
  return row;
}

export const state = { running: false, done: 0, total: 0, step: null };
const KEY = 'hw_probe_last';
/** Senaste sparade resultatet (null om provet aldrig körts) */
export function last() {
  try { return JSON.parse(getSetting(KEY, '') || 'null'); } catch { return null; }
}

/**
 * Kör hela provet: vald hårdvara (om någon) och processorn. busy() = antal strömmar som omkodas just nu; blir de
 * limits.busy eller fler avbryts provet (resultatet säger det). Sparar och returnerar resultatet.
 * @param {{ mode?: string, busy?: () => number, run?: Function }} o run kan bytas i tester
 */
export async function runProbe({ mode, busy = () => 0, run = measure } = {}) {
  if (state.running) throw Object.assign(new Error('Ett prov pågår redan'), { status: 409 });
  const wanted = hwStatus.wanted;
  const hw = mode && MODES.includes(mode) ? mode : MODES.includes(wanted) && wanted !== 'none' ? wanted : detected();
  const modes = hw === 'none' ? ['none'] : [hw, 'none'];
  const list = modes.flatMap(m => CODECS.map(c => [m, c]));
  Object.assign(state, { running: true, done: 0, total: list.length, step: null });
  const started = Date.now();
  const ctx = context();
  const rows = [];
  let aborted = null;
  try {
    const have = await encoders();
    for (const [m, c] of list) {
      const n = busy();
      if (n >= limits.busy) { aborted = { reason: 'busy', streams: n }; break; }
      state.step = { mode: m, codec: c };
      rows.push(await probeOne(m, c, have, ctx, run));
      state.done++;
    }
  } finally { Object.assign(state, { running: false, step: null }); }
  const gpuRows = rows.filter(r => r.mode !== 'none');
  const result = {
    at: new Date(started).toISOString(), ms: Date.now() - started, mode: hw, wanted, active: hwStatus.active,
    // Grafikkortet används när servern kör med det och provet lyckades för H.264 (det som alltid behövs)
    gpuWorks: gpuRows.some(r => r.codec === 'h264' && r.status === 'gpu'),
    serverUsesGpu: hwStatus.active !== 'none',
    // Vad servern stängde av vid start (stream.js disableHw) – en del av förklaringen när provet lyckas men servern ändå kör processorn
    serverError: hwStatus.error || null,
    context: { dri: ctx.dri, nvidia: ctx.nvidia, visible: ctx.visible, caps: ctx.caps, cpu: `${os.cpus().length} × ${os.cpus()[0]?.model || '?'}` },
    aborted, results: rows
  };
  setSetting(KEY, JSON.stringify(result));
  return result;
}
