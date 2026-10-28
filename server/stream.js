import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream';
import { send, fail, MIME, streamFile, writeAtomic, lowPriority } from './util.js';
import { CACHE, SUBS_DIR, getSetting } from './db.js';
import { fastKeyframes } from './keyframes.js';
import * as jobs from './jobs.js';
import { SubReader, vttParser } from './subreader.js';
import { ffcaps, ffReady, vulkanDevice } from './ffcaps.js';

const pexec = promisify(execFile);
const SEG = 6; // målängd per HLS-segment i sekunder
// Omkodning börjar med korta segment (0, 2, 4 s) så att bilden kommer igång snabbare, sedan SEG s
const HEAD = [0, 2, 4];
// ffmpeg får bara läsa lokala filer (skydd mot skadliga mediefiler som försöker öppna nätverksadresser)
export const SAFE_IN = ['-protocol_whitelist', 'file,pipe'];
const m3uAttr = (v) => String(v ?? '').replace(/["\r\n,]/g, ' ').slice(0, 80);
export const TRANSCODE = process.env.TRANSCODE_DIR || path.join(os.tmpdir(), 'braxhn-tv-transcode');
// Rensa gamla sessioner från förra körningen – bara innehållet: mappen är ofta en monterad volym
// (/transcode i Docker) som användaren inte får ta bort, och ett fel här får aldrig stoppa starten
fs.mkdirSync(TRANSCODE, { recursive: true });
try {
  for (const f of fs.readdirSync(TRANSCODE)) {
    try { fs.rmSync(path.join(TRANSCODE, f), { recursive: true, force: true }); } catch (e) { console.warn('[hls] kunde inte rensa', f, e.message); }
  }
} catch (e) { console.warn('[hls] kunde inte läsa omkodningsmappen', TRANSCODE, e.message); }
const HW_WANTED = (process.env.HWACCEL || 'none').toLowerCase(); // none | vaapi | nvenc | qsv
// Hårdvaruomkodning som inte fungerar (t.ex. nvenc utan NVIDIA-drivrutin i containern: "Cannot load libcuda.so.1")
// får aldrig stoppa uppspelningen – då används processorn i stället och adminsidan visar varför.
let HW = HW_WANTED;
export const hwStatus = { wanted: HW_WANTED, active: HW_WANTED, error: null };
const HW_FAIL = /libcuda|nvenc|cuda|vaapi|va-api|qsv|libmfx|mfx|hwupload|hwaccel|Failed to (initiali[sz]e|open|create)|No (VA display|device|NVENC)|device (type|creation)|Error while opening encoder/i;
/** Begriplig åtgärd för de vanligaste felen (ffmpegs egna meddelanden är svåra att tolka) */
export function hwHint(err) {
  if (/libcuda|libnvidia-encode|Cannot load|cuInit|CUDA_ERROR_NO_DEVICE|no CUDA-capable/i.test(err))
    return 'containern når inte NVIDIA-drivrutinen. Installera pluginen Nvidia-Driver, lägg till --runtime=nvidia under Extra Parameters och sätt NVIDIA_VISIBLE_DEVICES=all och NVIDIA_DRIVER_CAPABILITIES=all (eller använd mallen braxhn-tv-nvidia.xml).';
  if (/API version|minimum required Nvidia driver|Driver does not support/i.test(err))
    return 'NVIDIA-drivrutinen är för gammal för ffmpeg i containern – uppdatera drivrutinen i pluginen Nvidia-Driver.';
  if (/OpenEncodeSessionEx|out of memory|incompatible client key/i.test(err))
    return 'grafikkortet tillåter inte fler samtidiga kodningar (vanligt på GeForce) eller används av något annat, t.ex. en annan mediaserver.';
  if (/vaapi|VA-API|renderD|\/dev\/dri|No VA display/i.test(err))
    return 'enheten /dev/dri saknas i containern – lägg till den under GPU-enhet (Intel/AMD).';
  return null;
}
export function disableHw(reason) {
  if (HW === 'none') return;
  console.warn(`[hårdvara] ${HW} fungerar inte – använder processorn i stället. ${String(reason || '').split('\n').filter(Boolean).slice(-2).join(' ')}`);
  const tip = hwHint(String(reason || ''));
  if (tip) console.warn(`[hårdvara] Åtgärd: ${tip}`);
  hwStatus.hint = tip;
  hwStatus.error = String(reason || '').trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
  HW = 'none'; hwStatus.active = 'none';
}
/** ffmpeg-argument som kodar en testbild med valt läge (none = processorn, libx264) */
export function hwTestArgs(mode, size = '256x144', dur = 0.2) {
  const src = ['-f', 'lavfi', '-i', `testsrc2=s=${size}:d=${dur}:r=25`];
  return { vaapi: ['-vaapi_device', process.env.VAAPI_DEVICE || '/dev/dri/renderD128', ...src, '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi'],
    nvenc: [...src, '-c:v', 'h264_nvenc'], qsv: [...src, '-vf', 'format=nv12', '-c:v', 'h264_qsv'],
    none: [...src, '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast'] }[mode] || null;
}
/**
 * Kort testkodning (installationsguiden): 720p i några sekunder med valt läge. Ändrar inte vad servern använder.
 * @returns {Promise<{ ok: boolean, mode: string, ms: number, fps: number, error?: string, hint?: string|null }>}
 */
export function testEncode(mode, seconds = 4) {
  const args = hwTestArgs(mode, '1280x720', seconds);
  if (!args) return Promise.resolve({ ok: false, mode, ms: 0, fps: 0, error: 'Okänt läge', hint: null });
  const t0 = Date.now();
  return new Promise(res => execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args, '-f', 'null', '-'], { timeout: 60000 }, (e, _o, stderr) => {
    const ms = Date.now() - t0;
    if (e) { const err = String(stderr || e.message).trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400); return res({ ok: false, mode, ms, fps: 0, error: err, hint: hwHint(err) }); }
    res({ ok: true, mode, ms, fps: Math.round(seconds * 25 / (ms / 1000)) });
  }));
}
// Hela kedjan på grafikkortet (som Plex): avkodning, skalning och färgkonvertering utan att varje bild hämtas till
// processorn och tillbaka. Utan det skalade processorn ner varje 4K-bild – det var den största skillnaden mot Plex.
// Testas vid start med de filter ffmpeg i imagen faktiskt har; misslyckas en riktig körning används processorfiltren
// (avkodning och kodning stannar på grafikkortet) resten av tiden.
export const gpuPipe = { cuda: false, cudaTm: false, vaapi: false };
// HDR-tonmappning på grafikkortet (sonderas vid start, i föredragen ordning per kedja). En körning som misslyckas
// stänger av just den vägen – nästa start tar nästa i ordningen och till sist processorn (zscale).
//  cuda          tonemap_cuda (finns bara i jellyfin-ffmpeg) direkt efter scale_cuda – bilderna lämnar aldrig kortet
//  placeboCuda   libplacebo (Vulkan) på den nedskalade bilden från scale_cuda – klarar Dolby Vision profil 5
//  openclCuda    tonemap_opencl på den nedskalade bilden (NVIDIA:s OpenCL)
//  placeboVaapi  libplacebo via hwmap från VA-API (Intel/AMD med Mesa-Vulkan) – klarar Dolby Vision profil 5
//  placeboSw     libplacebo i kedjor med processorfilter (inbränning, avflätning, QSV) när det finns ett grafikkort med Vulkan
//  openclSw      tonemap_opencl i samma kedjor
// Vulkan-enheten måste vara ett riktigt grafikkort: lavapipe (programvara) klarade 3 bilder/s i 1080p.
export const gpuTm = { cuda: false, placeboCuda: false, openclCuda: false, placeboVaapi: false, placeboSw: false, openclSw: false, vulkan: null };
// Sonderingar avbryts med SIGKILL: ffmpeg som hänger i en kodartråd (sett med SVT-AV1 i Debian 12) struntar i SIGTERM,
// och en kvarhängande process skulle hålla servern (och testerna) kvar
const PROBE = { killSignal: 'SIGKILL' };
const probeOk = (args, timeout = 20000) => new Promise(res => execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
  ...args, '-f', 'null', '-'], { ...PROBE, timeout }, (e) => res(!e)));
const gpuProbe = (name, args) => probeOk([...args, '-frames:v', '2']).then(ok => { if (ok) gpuPipe[name] = true; });
function probeGpuPipe() {
  const src = ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=0.2:r=25'];
  if (HW === 'nvenc') return Promise.all([
    gpuProbe('cuda', ['-init_hw_device', 'cuda=cu', '-filter_hw_device', 'cu', ...src, '-vf', 'format=nv12,hwupload,scale_cuda=320:180:format=nv12', '-c:v', 'h264_nvenc']),
    // HDR: skala på grafikkortet i 10 bitar, tonmappa den mindre bilden med processorn
    gpuProbe('cudaTm', ['-init_hw_device', 'cuda=cu', '-filter_hw_device', 'cu', ...src, '-vf', 'format=p010le,hwupload,scale_cuda=320:180:format=p010le,hwdownload,format=p010le,format=yuv420p', '-c:v', 'h264_nvenc'])]);
  if (HW === 'vaapi') return gpuProbe('vaapi', ['-vaapi_device', VAAPI_DEV_PROBE, ...src, '-vf', 'format=nv12,hwupload,scale_vaapi=w=320:h=180:format=nv12', '-c:v', 'h264_vaapi']);
  return Promise.resolve();
}
const VAAPI_DEV_PROBE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
// Tonmappningsfilter – samma strängar i sonderingen som i omkodningen
const TONEMAP = process.env.TONEMAP || 'hable'; // hable | mobius | reinhard | bt2390
const PL_TM = { hable: 'hable', mobius: 'mobius', reinhard: 'reinhard', bt2390: 'bt.2390' }[process.env.TONEMAP] || 'bt.2390';
const plFilter = (fmt = 'yuv420p') => `libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=${PL_TM}:format=${fmt}`;
const oclFilter = () => `tonemap_opencl=tonemap=${TONEMAP === 'bt2390' ? 'hable' : TONEMAP}:desat=0:t=bt709:m=bt709:p=bt709:r=tv:format=nv12`;
const cudaTmFilter = () => `tonemap_cuda=tonemap=${TONEMAP}:t=bt709:m=bt709:p=bt709:format=nv12`;
const VK_DEV = ['-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk'];
const OCL_DEV = ['-init_hw_device', 'opencl=ocl', '-filter_hw_device', 'ocl'];
const vaPlaceboDev = () => ['-init_hw_device', `vaapi=va:${VAAPI_DEV_PROBE}`, '-init_hw_device', 'vulkan=vk@va', '-filter_hw_device', 'va'];
async function probeTonemap() {
  if (HW === 'none' || process.env.GPU_TONEMAP === '0') return;
  const caps = await ffReady;
  const has = (f) => caps.filters.has(f);
  const hdr = ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=0.2:r=25,format=yuv420p10le,setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc:range=tv'];
  const vk = has('libplacebo') ? await vulkanDevice() : null;
  gpuTm.vulkan = vk;
  const realVk = !!vk && !['software', 'cpu'].includes(vk.type);
  const t = (name, ok, args) => ok ? probeOk([...args, '-frames:v', '2']).then(r => { gpuTm[name] = r; }) : null;
  const enc = HW === 'nvenc' ? ['-c:v', 'h264_nvenc'] : HW === 'qsv' ? ['-c:v', 'h264_qsv'] : ['-c:v', 'h264_vaapi'];
  const post = HW === 'qsv' ? ',format=nv12' : '';
  const cuSrc = 'format=p010le,hwupload_cuda,scale_cuda=320:180:format=p010le';
  await Promise.all([
    t('placeboSw', realVk && HW !== 'vaapi', [...VK_DEV, ...hdr, '-vf', `hwupload,${plFilter()},hwdownload,format=yuv420p${post}`, ...enc]),
    t('openclSw', has('tonemap_opencl') && HW !== 'vaapi', [...OCL_DEV, ...hdr, '-vf', `format=p010le,hwupload,${oclFilter()},hwdownload,format=nv12`, ...enc]),
    t('cuda', HW === 'nvenc' && gpuPipe.cuda && has('tonemap_cuda'), ['-init_hw_device', 'cuda=cu', '-filter_hw_device', 'cu', ...hdr, '-vf', `format=p010le,hwupload,scale_cuda=320:180:format=p010le,${cudaTmFilter()}`, ...enc]),
    t('placeboCuda', HW === 'nvenc' && gpuPipe.cuda && realVk, [...VK_DEV, ...hdr, '-vf', `${cuSrc},hwdownload,format=p010le,hwupload,${plFilter()},hwdownload,format=yuv420p`, ...enc]),
    t('openclCuda', HW === 'nvenc' && gpuPipe.cuda && has('tonemap_opencl'), [...OCL_DEV, ...hdr, '-vf', `${cuSrc},hwdownload,format=p010le,hwupload,${oclFilter()},hwdownload,format=nv12`, ...enc]),
    t('placeboVaapi', HW === 'vaapi' && gpuPipe.vaapi && realVk && has('hwmap'), [...vaPlaceboDev(), ...hdr, '-vf',
      `format=p010,hwupload,scale_vaapi=w=320:h=180:format=p010,hwmap=derive_device=vulkan,${plFilter('nv12')},hwmap=derive_device=vaapi:reverse=1,format=vaapi`, ...enc])
  ]);
}

// ---------------- HEVC/AV1 vid omkodning ----------------
// Omkodning ger H.264 i MPEG-TS om inte klienten anger att den kan avkoda HEVC/AV1 i fMP4 (tc=hevc,av1) och en
// kodare finns: grafikkortets (hevc_nvenc/av1_nvenc/hevc_vaapi/av1_vaapi/hevc_qsv/av1_qsv) eller – bara om admin
// valt det (inställningen transcode_vcodec = cpu) – processorns libx265/libsvtav1. Samma bildkvalitet med lägre
// bithastighet (VC_FACTOR), vilket märks mest utanför hemmet. Varje kodare provkörs vid start med tvingade
// nyckelbilder och samma fMP4-delning som i omkodningen (SVT-AV1 i ffmpeg 5.1 struntar t.ex. i tvingade nyckelbilder).
export const VC_FACTOR = { h264: 1, hevc: 0.6, av1: 0.5 };
const VC_LABEL = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' };
const CPU_ENC = { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1' };
const ENC_PRE = { vaapi: () => ['-vaapi_device', VAAPI_DEV_PROBE], nvenc: () => [], qsv: () => [], none: () => [] };
const ENC_VF = { vaapi: ['-vf', 'format=nv12,hwupload'], nvenc: ['-vf', 'format=yuv420p'], qsv: ['-vf', 'format=nv12'], none: ['-vf', 'format=yuv420p'] };
/** Fungerande kodare per codec: hw = grafikkortets (HW-läget vid start), cpu = processorns. failed = misslyckades i en riktig körning. */
export const vEnc = { hw: { hevc: null, av1: null }, cpu: { hevc: null, av1: null }, failed: new Set() };
// fMP4 med segment-muxern: varje fil får ftyp+moov (identisk mellan körningar) och tfdt i absolut tid
// (frag_discont + avoid_negative_ts=disabled i den inre muxern – annars börjar varje fil om på 0). delay_moov: moov
// skrivs först när första paketen finns (kopierat E-AC-3 kräver det), use_editlist=0 håller moov lika i alla körningar. Servern skickar
// moov en gång som initsegment och resten (moof+mdat) som segment. Delningen styrs av -segment_times precis som i TS,
// så extra nyckelbilder från en kodare (scenbyten) aldrig ger extra segment.
const FMP4_SEG = ['-f', 'segment', '-segment_format', 'mp4', '-segment_format_options',
  'movflags=+frag_keyframe+empty_moov+delay_moov+default_base_moof+frag_discont+skip_trailer:use_editlist=0:avoid_negative_ts=disabled'];
/** Kodarens argument. kind = nvenc/vaapi/qsv/none (processorn), br = bithastighetstak (kbit/s) eller null = kvalitetsstyrd. */
export function encArgs(kind, vc, br, big) {
  const cap = br ? ['-maxrate', br + 'k', '-bufsize', br * 2 + 'k'] : [];
  const cbr = br ? ['-b:v', br + 'k', ...cap] : null;
  const nv = (cq) => br ? ['-rc', 'vbr', '-cq', String(cq + 3), '-b:v', Math.round(br * 0.6) + 'k', ...cap] : ['-cq', String(cq)];
  // HEVC/AV1: inga nyckelbilder utöver de tvingade (scenbyten) – och de tvingade blir IDR
  const keys = ['-g', '1000'];
  const tag = vc === 'hevc' ? ['-tag:v', 'hvc1'] : [];
  if (kind === 'nvenc') {
    if (vc === 'h264') return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-forced-idr', '1', ...nv(22)];
    return ['-c:v', `${vc}_nvenc`, '-preset', 'p4', '-forced-idr', '1', '-no-scenecut', '1', ...keys, ...nv(vc === 'av1' ? 30 : 24), ...tag];
  }
  if (kind === 'vaapi') {
    if (vc === 'h264') return ['-c:v', 'h264_vaapi', ...(cbr || ['-qp', '22'])];
    // av1_vaapi: qp är AV1:s qindex (0–255)
    return ['-c:v', `${vc}_vaapi`, ...keys, ...(cbr || ['-qp', vc === 'av1' ? '120' : '24']), ...tag];
  }
  if (kind === 'qsv') {
    if (vc === 'h264') return ['-c:v', 'h264_qsv', '-forced_idr', '1', ...(cbr || ['-global_quality', '22'])];
    return ['-c:v', `${vc}_qsv`, ...(vc === 'hevc' ? ['-forced_idr', '1'] : []), ...keys, ...(cbr || ['-global_quality', vc === 'av1' ? '28' : '24']), ...tag];
  }
  // x265/SVT-AV1: bufferten lika stor som taket – med dubbel buffert låg första segmentet över BANDWIDTH
  const tight = br ? ['-maxrate', br + 'k', '-bufsize', br + 'k'] : [];
  if (vc === 'hevc') return ['-c:v', 'libx265', '-preset', process.env.X265_PRESET || (big ? 'superfast' : 'veryfast'), ...(br ? ['-crf', '26', ...tight] : ['-crf', '24']),
    '-profile:v', 'main', '-forced-idr', '1', '-x265-params', 'log-level=error:scenecut=0:open-gop=0:keyint=1000', ...tag];
  if (vc === 'av1') return ['-c:v', 'libsvtav1', '-preset', process.env.SVTAV1_PRESET || (big ? '12' : '10'), ...(br ? ['-crf', '35', ...tight] : ['-crf', '32']),
    ...keys, '-svtav1-params', 'scd=0'];
  return ['-c:v', 'libx264', '-preset', process.env.X264_PRESET || (big ? 'superfast' : 'veryfast'), ...(br ? ['-crf', '23', ...cap] : ['-crf', '21']), '-profile:v', 'high', '-sc_threshold', '0'];
}
/** Provkör en kodare: fMP4 med tvingade nyckelbilder vid 1 och 2 s ska bli exakt tre segment */
function probeEncoder(kind, vc) {
  const name = kind === 'none' ? CPU_ENC[vc] : `${vc}_${kind}`;
  if (!ffcaps.encoders.has(name)) return Promise.resolve(null);
  let dir;
  try { dir = fs.mkdtempSync(path.join(TRANSCODE, `encprobe-${name}-`)); } catch { return Promise.resolve(null); }
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...ENC_PRE[kind](), '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=3:r=10',
    '-map', '0:v', ...ENC_VF[kind], ...encArgs(kind, vc, null, false), '-force_key_frames', '1,2', '-bf', '0', ...FMP4_SEG, '-segment_times', '1,2',
    '-segment_list', 'pipe:1', '-segment_list_type', 'csv', path.join(dir, 'p_%02d.m4s')];
  return new Promise(res => execFile('ffmpeg', args, { ...PROBE, timeout: 20000, env: { ...process.env, SVT_LOG: '1' } }, (e, out) => {
    fs.rmSync(dir, { recursive: true, force: true });
    res(!e && String(out).trim().split('\n').filter(Boolean).length === 3 ? name : null);
  }));
}
async function probeEncoders() {
  await ffReady;
  if (process.env.TRANSCODE_PROBE === '0') return; // tester som inte behöver HEVC/AV1 (sparar processortid)
  const all = [];
  for (const vc of ['hevc', 'av1']) {
    all.push(probeEncoder('none', vc).then(n => { vEnc.cpu[vc] = n; }));
    if (HW !== 'none') all.push(probeEncoder(HW, vc).then(n => { vEnc.hw[vc] = n; }));
  }
  await Promise.all(all);
}
/** Admins val: auto = HEVC/AV1 med grafikkortet, cpu = även med processorn (x265/SVT-AV1), h264 = alltid H.264 */
export const vcodecSetting = () => { const v = getSetting('transcode_vcodec', process.env.TRANSCODE_VCODEC || 'auto'); return ['auto', 'cpu', 'h264'].includes(v) ? v : 'auto'; };
/** Kodaren som används för codec vc just nu: { kind, name } eller null (finns inte, har misslyckats eller är inte tillåten) */
export function encoderFor(vc) {
  if (vc === 'h264') return { kind: HW, name: HW === 'none' ? 'libx264' : `h264_${HW}` };
  const set = vcodecSetting();
  if (set === 'h264') return null;
  const hw = HW !== 'none' && vEnc.hw[vc] && !vEnc.failed.has(vEnc.hw[vc]) ? vEnc.hw[vc] : null;
  if (hw) return { kind: HW, name: hw };
  const cpu = set === 'cpu' && vEnc.cpu[vc] && !vEnc.failed.has(vEnc.cpu[vc]) ? vEnc.cpu[vc] : null;
  return cpu ? { kind: 'none', name: cpu } : null;
}
/** Bästa codec som både klienten (tc) och servern klarar: AV1 före HEVC, grafikkortet före processorn */
export function pickVcodec(tc) {
  if (!tc?.size) return 'h264';
  const ok = ['av1', 'hevc'].filter(c => tc.has(c) && encoderFor(c));
  return ok.find(c => encoderFor(c).kind !== 'none') || ok[0] || 'h264';
}
/** Kan Dolby Vision profil 5 få rätt färger? (libplacebo på ett riktigt grafikkort) */
const dv5Ok = () => gpuTm.placeboCuda || gpuTm.placeboVaapi || gpuTm.placeboSw;
/** Sammanfattning för adminsidan och loggen */
export function transcodeInfo() {
  const tm = HW === 'nvenc' ? (gpuTm.cuda ? 'tonemap_cuda' : gpuTm.placeboCuda ? 'libplacebo' : gpuTm.openclCuda ? 'tonemap_opencl' : null)
    : HW === 'vaapi' ? (gpuTm.placeboVaapi ? 'libplacebo' : 'tonemap_vaapi') : (gpuTm.placeboSw ? 'libplacebo' : gpuTm.openclSw ? 'tonemap_opencl' : null);
  return { ffmpeg: ffcaps.version || null, setting: vcodecSetting(), hevc: encoderFor('hevc')?.name || null, av1: encoderFor('av1')?.name || null,
    hw: { ...vEnc.hw }, cpu: { ...vEnc.cpu }, failed: [...vEnc.failed], tonemap: tm || 'processor', dv5: !!dv5Ok(),
    vulkan: gpuTm.vulkan ? `${gpuTm.vulkan.name} (${gpuTm.vulkan.type})` : null };
}
// Snabbtest vid start: koda några bildrutor med den valda hårdvaran, sedan GPU-kedjan, tonmappningen och HEVC/AV1
const hwReady = new Promise(done => {
  if (HW === 'none') return done();
  const enc = hwTestArgs(HW);
  if (!enc) { disableHw(`okänt värde HWACCEL=${HW}`); return done(); }
  execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...enc, '-frames:v', '2', '-f', 'null', '-'], { ...PROBE, timeout: 20000 }, (e, _o, stderr) => {
    if (e) { disableHw(stderr || e.message); return done(); }
    if (process.env.GPU_FILTERS === '0') { console.log(`[hårdvara] ${HW} fungerar (filter på processorn: GPU_FILTERS=0)`); return done(); }
    probeGpuPipe().then(probeTonemap).catch(() => {}).then(() => {
      const tm = transcodeInfo().tonemap;
      console.log(`[hårdvara] ${HW} fungerar – skalning på ${gpuPipe.cuda || gpuPipe.vaapi ? 'grafikkortet' : 'processorn'}, HDR-tonmappning `
        + (tm !== 'processor' ? `på grafikkortet (${tm})` : HW === 'nvenc' && gpuPipe.cudaTm ? 'efter nedskalning på grafikkortet' : 'på processorn'));
      done();
    });
  });
});
/** Klar när alla sonderingar vid start är gjorda (tester väntar på den) */
export const transcodeReady = hwReady.then(probeEncoders).catch(() => {}).then(() => {
  if (process.env.TRANSCODE_PROBE === '0') return;
  const i = transcodeInfo();
  const list = (o) => Object.values(o).filter(Boolean).join(', ') || 'inga';
  console.log(`[omkodning] ffmpeg ${i.ffmpeg || '?'} – HEVC/AV1: grafikkortet ${HW === 'none' ? '–' : list(vEnc.hw)}, processorn ${list(vEnc.cpu)}${i.setting === 'cpu' ? ' (tillåten)' : ' (bara om admin väljer det)'}`);
});
// Segment-muxerns -segment_times jämförs med olika tider beroende på ffmpeg-version: 5.1 (Debian/Docker-imagen)
// mot utdatans tid inklusive -output_ts_offset, 6.x mot tiden från körningens start. Fel tolkning efter spolning
// ger ett segment per nyckelbild i stället för rutnätet. Testas en gång vid start: offset 10, delning vid 2.
// Okänt läge (testet ännu inte klart eller misslyckat) behandlas som 6.x.
const segTimesAbs = { v: false };
execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=d=4:s=64x64:r=25',
  '-c:v', 'mpeg2video', '-g', '25', '-output_ts_offset', '10', '-f', 'segment', '-segment_format', 'mpegts', '-segment_times', '2',
  '-reset_timestamps', '0', '-segment_list', 'pipe:1', '-segment_list_type', 'csv', path.join(TRANSCODE, 'segprobe_%02d.ts')],
{ timeout: 20000 }, (e, out) => {
  for (const f of ['segprobe_00.ts', 'segprobe_01.ts', 'segprobe_02.ts', 'segprobe_03.ts']) fs.rmSync(path.join(TRANSCODE, f), { force: true });
  const end = Number(String(out || '').split('\n')[0]?.split(',')[2]);
  if (e || !Number.isFinite(end)) return console.warn('[hls] kunde inte testa segment-muxern:', e?.message || out);
  segTimesAbs.v = end < 11.5;
  if (segTimesAbs.v) console.log('[hls] ffmpeg tolkar segment_times som absolut tid');
});
// Delningstider för en körning som startar på (utdata)tiden base: relativa eller absoluta efter ffmpegs tolkning
const segTimes = (segs, n, base) => segs.slice(n + 1).map(x => Math.max(0.001, x.start - base - 0.005) + (segTimesAbs.v ? base : 0)).map(v => v.toFixed(3));
const VAAPI_DEV = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
// Avkodning på grafikkortet när omkodningen ändå görs där (4K-HEVC är tungt att avkoda med processorn).
// Utan -hwaccel_output_format hämtas bilderna tillbaka automatiskt, så alla mjukvarufilter fungerar som förut,
// och format som kortet inte klarar avkodas med processorn. HW_DECODE=0 stänger av.
const hwDecode = () => process.env.HW_DECODE === '0' ? []
  : HW === 'nvenc' ? ['-hwaccel', 'cuda'] : HW === 'vaapi' ? ['-hwaccel', 'vaapi', '-hwaccel_device', VAAPI_DEV] : [];

const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const BITMAP_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
const CONTAINER = { '.mp4': 'mp4', '.m4v': 'mp4', '.mov': 'mp4', '.webm': 'webm', '.mkv': 'mkv' };

export const QUALITIES = {
  orig: { h: null, br: null }, '2160': { h: 2160, br: 25000 }, '1080': { h: 1080, br: 8000 },
  '720': { h: 720, br: 4000 }, '480': { h: 480, br: 1500 }, '360': { h: 360, br: 800 }
};
/** Är q en kvalitet i QUALITIES? Bara egna nycklar – ?q=constructor eller __proto__ ska inte räknas som en kvalitet */
export const isQuality = (q) => typeof q === 'string' && Object.hasOwn(QUALITIES, q);

// Rättad språkmärkning (server/health.js, kopplas i app.js): fn(it) → { 'a1': 'swe', 'e3': 'eng', 'external:x.srt': 'swe' } | null.
// Läggs på spåren här, så att uppspelningen, förvalen och filtren ser den – filen ändras aldrig.
let langFix = () => null;
export function setLangFix(fn) { langFix = fn; }
const fixOf = (it) => { try { return it?.id != null ? langFix(it) : null; } catch { return null; } };
export const streamsOf = (it) => {
  let s; try { s = JSON.parse(it.streams || '[]'); } catch { return []; }
  const f = Array.isArray(s) && fixOf(it);
  if (f) for (const x of s) { const k = x.type === 'audio' ? 'a' + x.index : x.type === 'subtitle' ? 'e' + x.index : null; if (k && f[k]) x.lang = f[k]; }
  return s;
};
const videoOf = (it) => streamsOf(it).find(s => s.type === 'video');
const is10bit = (v) => /10|12/.test(v?.pix || '');

// ---------------- undertexter ----------------
// Mapplistningar cachas per mapp och läses om bara när mappens ändringstid ändras (ny/borttagen fil).
// Ändringstiden kontrolleras högst var 30:e sekund: en uppspelningsförfrågan frågar efter undertexterna
// många gånger, och varje diskåtkomst kan hänga i flera sekunder när en arraydisk vaknar. Saknad mapp
// (vanligast: inga nedladdade undertexter) cachas också. Ny extern .srt syns därför inom 30 s.
const dirCache = new Map();
const DIR_TTL = 30e3;
function listDir(dir) {
  const now = Date.now();
  const c = dirCache.get(dir);
  if (c && now - c.at < DIR_TTL) return c.files;
  let mtime;
  try { mtime = fs.statSync(dir).mtimeMs; } catch { mtime = null; } // mappen saknas
  if (c && c.mtime === mtime) { c.at = now; return c.files; }
  const files = mtime == null ? [] : fs.readdirSync(dir);
  dirCache.delete(dir);
  dirCache.set(dir, { mtime, files, at: now });
  if (dirCache.size > 2000) dirCache.delete(dirCache.keys().next().value);
  return files;
}
/** Glöm cachade mapplistningar för en titel (efter nedladdning eller borttagning av en undertext) */
export function forgetSubtitles(it) {
  dirCache.delete(path.dirname(it.path));
  dirCache.delete(path.join(SUBS_DIR, String(it.id)));
}
export function subtitlesOf(it) {
  const out = [];
  for (const s of streamsOf(it)) {
    if (s.type !== 'subtitle') continue;
    const bitmap = BITMAP_SUBS.has(s.codec);
    if (!bitmap && !TEXT_SUBS.has(s.codec)) continue;
    out.push({
      // PGS (Blu-ray) visas som bilder i webbspelaren; övriga bildformat bränns in
      id: 'e' + s.index, lang: s.lang, forced: s.forced, hi: !!s.hi, ...(s.comment ? { comment: true } : {}), bitmap, pgs: s.codec === 'hdmv_pgs_subtitle', source: 'embedded',
      label: [s.title, s.lang].filter(Boolean).join(' · ') + (bitmap ? ' (bild)' : '') || `Spår ${s.index}`
    });
  }
  const dir = path.dirname(it.path), base = path.basename(it.path, path.extname(it.path));
  const fix = fixOf(it) || {};
  try {
    listDir(dir).filter(f => f.startsWith(base) && /\.(srt|vtt|ass|ssa)$/i.test(f)).sort().forEach((f, i) => {
      const tag = f.slice(base.length).replace(/\.(srt|vtt|ass|ssa)$/i, '').replace(/^[._-]+/, '');
      out.push({ id: 'x' + i, file: path.join(dir, f), lang: fix['external:' + f] || tag.split(/[._-]/)[0] || null, label: (tag || 'Extern') + ' (fil)', forced: /forced/i.test(tag), bitmap: false, source: 'external' });
    });
  } catch {}
  try {
    const d = path.join(SUBS_DIR, String(it.id));
    listDir(d).filter(f => /\.(srt|vtt|ass)$/i.test(f)).sort().forEach((f, i) => {
      const lang = fix['downloaded:' + f] || f.split('.')[0];
      out.push({ id: 'd' + i, file: path.join(d, f), lang, label: `${f.split('.')[0]} (nedladdad)`, forced: false, bitmap: false, source: 'downloaded' });
    });
  } catch {}
  return out;
}

// Undertexter extraheras en gång per fil och cachas (inbäddade spår kräver att hela filen läses)
let subActive = 0; const subWait = [];
async function subSlot(fn) {
  // Platsen lämnas över direkt till nästa väntande (räknaren minskar inte emellan) – annars kan en ny
  // anropare ta den innan den väckta hinner köra, och då körs tre samtidigt
  if (subActive >= 2) await new Promise(r => subWait.push(r)); else subActive++;
  try { return await fn(); } finally { const next = subWait.shift(); if (next) next(); else subActive--; }
}
const subRunning = new Map();
const subKey = (it, sub) => `${it.id}-${it.mtime}-${sub.id}${sub.file ? '-' + (fs.statSync(sub.file).mtimeMs | 0) : ''}`;
const subCacheFile = (it, sub) => path.join(CACHE, 'subs', subKey(it, sub) + '.vtt');
// low: bakgrundsjobb (repliksökningen, sublines.js) – lägsta prioritet, tar ingen av de två platserna som
// uppspelningen använder, längre tidsgräns och fel i stället för en avkortad undertext
function extractVtt(it, sub, { low = false } = {}) {
  const key = subKey(it, sub);
  const file = subCacheFile(it, sub);
  if (fs.existsSync(file)) return fs.promises.readFile(file, 'utf8');
  if (subRunning.has(key)) return subRunning.get(key);
  const work = () => new Promise((ok, no) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_IN];
    if (sub.file) {
      const fmt = { '.srt': 'srt', '.ass': 'ass', '.ssa': 'ass', '.vtt': 'webvtt' }[path.extname(sub.file).toLowerCase()];
      args.push('-sub_charenc', guessCharenc(sub.file), ...(fmt ? ['-f', fmt] : []), '-i', sub.file, '-map', '0:s:0');
    } else args.push('-i', it.path, '-map', '0:' + sub.id.slice(1));
    args.push('-f', 'webvtt', 'pipe:1');
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    if (low) lowPriority(p);
    const chunks = []; let size = 0;
    p.stdout.on('data', c => { size += c.length; if (size > 20 << 20) p.kill('SIGKILL'); else chunks.push(c); });
    const timer = setTimeout(() => p.kill('SIGKILL'), (low ? 60 : 10) * 60e3);
    p.on('error', (e) => { clearTimeout(timer); no(new Error('Kunde inte starta ffmpeg: ' + e.message)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && (low || !chunks.length)) return no(new Error('Kunde inte läsa undertexten'));
      const vtt = Buffer.concat(chunks).toString('utf8');
      // Avbruten eller misslyckad körning: skicka det som finns men cacha inte en avkortad fil
      if (code === 0) try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeAtomic(file, vtt); } catch {}
      ok(vtt);
    });
  });
  const pr = (low ? work() : subSlot(work)).finally(() => subRunning.delete(key));
  subRunning.set(key, pr);
  return pr;
}
// Inbäddad textundertext som läses där tittaren är (webbspelaren frågar igen tills allt är läst – se subreader.js)
const liveSubs = new Map();
const vttTime = (t) => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`; };
const cuesToVtt = (cues) => 'WEBVTT\n\n' + cues.map(c => `${vttTime(c.s)} --> ${vttTime(c.e)}${c.settings ? ' ' + c.settings : ''}\n${c.text}`).join('\n\n') + '\n';
function liveVtt(it, sub, t) {
  const key = subKey(it, sub);
  let j = liveSubs.get(key);
  if (!j) {
    j = { cues: [], done: false, error: null, last: Date.now() };
    const forget = (ms) => setTimeout(() => { if (liveSubs.get(key) === j) liveSubs.delete(key); }, ms).unref();
    j.reader = new SubReader({
      file: it.path, stream: +sub.id.slice(1), format: 'webvtt', duration: it.duration || 0, title: it.title,
      parser: () => vttParser((c) => {
        // Sorterat på starttid; två läsningar som överlappar ger samma cue två gånger
        let lo = 0, hi = j.cues.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (j.cues[m].s < c.s) lo = m + 1; else hi = m; }
        for (let k = lo; k < j.cues.length && j.cues[k].s === c.s; k++) if (j.cues[k].text === c.text) return;
        j.cues.splice(lo, 0, c);
      }),
      onComplete: () => {
        j.done = true;
        try { fs.mkdirSync(path.join(CACHE, 'subs'), { recursive: true }); writeAtomic(subCacheFile(it, sub), cuesToVtt(j.cues)); } catch {}
        forget(120e3);
      },
      onError: (msg) => { j.done = true; j.error = msg || 'Kunde inte läsa undertexten'; console.warn('[undertext]', it.path, j.error); forget(30 * 60e3); }
    });
    liveSubs.set(key, j);
  }
  j.last = Date.now();
  j.reader.want(t);
  return j;
}
// Läsningar som ingen frågat efter på 30 min och som inte blivit klara tas bort (läsaren stoppar ffmpeg
// efter två minuter utan frågor, men cues och läsarens timer låg annars kvar i minnet för alltid)
export function sweepLiveSubs(now = Date.now()) {
  for (const [k, j] of liveSubs) if (!j.done && now - j.last > 30 * 60e3) { j.reader.close(); j.done = true; liveSubs.delete(k); }
}
setInterval(sweepLiveSubs, 60e3).unref();
/** Undertexten som WebVTT (extraheras och cachas en gång per fil) – används av den automatiska synken (subsync.js) och
 *  repliksökningen (sublines.js, { low: true }) */
export const subtitleVtt = (it, sub, opts) => extractVtt(it, sub, opts);
// t' = t · ratio + offset (ratio ≠ 1 när undertexten är gjord för en annan bildfrekvens, se subsync.js)
function shiftVtt(vtt, offset, ratio = 1) {
  if (!offset && ratio === 1) return vtt;
  const fmt = (t) => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`; };
  const parse = (x) => x.split(':').reduce((a, v) => a * 60 + parseFloat(v), 0);
  return vtt.replace(/((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})/g, (_, a, b) => `${fmt(parse(a) * ratio + offset)} --> ${fmt(parse(b) * ratio + offset)}`);
}

// syncFor(sub) = sparad justering för undertextfilen ({ offset, ratio } eller null, subsync.adjustment) – klientens offset= läggs till efteråt.
// mask(vtt, sub) = familjefiltret (svordomar → ***, familyfilter.maskVtt) eller null
export async function serveSubtitle(req, res, it, sid, query, syncFor = null, mask = null) {
  const sub = subtitlesOf(it).find(s => s.id === sid);
  if (!sub || sub.bitmap) return fail(res, 404, 'Undertext saknas');
  const sync = syncFor ? syncFor(sub) : null, ratio = sync?.ratio || 1;
  const offset = Math.max(-600, Math.min(600, parseFloat(query.get('offset') || '0') || 0)) + (sync?.offset || 0);
  let vtt;
  // Webbspelaren (live=1): ett inbäddat spår som inte lästs än läses där tittaren är (pos) och skickas i
  // omgångar – annars syns inget förrän hela filen lästs, vilket tar minuter för en stor film
  if (query.get('live') === '1' && !sub.file && !fs.existsSync(subCacheFile(it, sub))) {
    const pos = Math.max(0, +query.get('pos') || 0);
    const j = liveVtt(it, sub, pos);
    // Vänta en kort stund tills läsningen nått tittaren (oftast under en sekund) så att första svaret har text
    for (let k = 0; k < 25 && !j.done && !j.reader.covers(pos + 15) && !req.destroyed; k++) await new Promise(r => setTimeout(r, 100));
    if (j.error && !j.cues.length) return fail(res, 500, 'Kunde inte läsa undertexten');
    const out = shiftVtt(cuesToVtt(j.cues), offset, ratio);
    return send(res, 200, mask ? mask(out, sub) : out, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store', 'X-Undertext-Klar': j.done ? '1' : '0' });
  }
  try { vtt = shiftVtt(await extractVtt(it, sub), offset, ratio); } catch (e) { return fail(res, 500, e.message); }
  if (mask) vtt = mask(vtt, sub);
  // Apple kräver tidsmappning mot MPEG-TS för undertexter i HLS
  if (query.get('hls') === '1') vtt = vtt.replace(/^WEBVTT[^\n]*\n/, 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n');
  send(res, 200, vtt, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=600', 'X-Undertext-Klar': '1' });
}
// Äldre svenska .srt-filer är ofta Windows-1252 – kolla om innehållet är giltig UTF-8
function guessCharenc(file) {
  try {
    // Läs bara början av filen (räcker för att avgöra teckenkodningen)
    const b = Buffer.alloc(65536), fd = fs.openSync(file, 'r');
    let n; try { n = fs.readSync(fd, b, 0, b.length, 0); } finally { fs.closeSync(fd); }
    let sub = b.subarray(0, n);
    // Klipp inte mitt i ett flerbytestecken
    if (n === b.length) { let k = n; while (k > n - 4 && (sub[k - 1] & 0xc0) === 0x80) k--; if (k > 0 && sub[k - 1] >= 0xc0) k--; sub = sub.subarray(0, k); }
    new TextDecoder('utf-8', { fatal: true }).decode(sub);
    return 'UTF-8';
  } catch { return 'CP1252'; }
}

// ---------------- direktuppspelning ----------------
// Snabbstart (server/prestart.js, kopplas in av app.js): direct serverar början/slutet ur startcachen medan
// disken vaknar, input ger ffmpeg en sammansatt indata (cachen + originalfilen) vid start från början
export const fastStart = { direct: null, input: null };
export function serveDirect(req, res, it) {
  const type = MIME[path.extname(it.path).toLowerCase()] || 'application/octet-stream';
  if (fastStart.direct?.(req, res, it, type)) return;
  let st; try { st = fs.statSync(it.path); } catch { return fail(res, 404, 'Filen hittades inte'); }
  streamFile(req, res, it.path, st.size, { 'Content-Type': type, 'Cache-Control': 'no-store' });
}

export function serveDownload(req, res, it) {
  let st; try { st = fs.statSync(it.path); } catch { return fail(res, 404, 'Filen hittades inte'); }
  streamFile(req, res, it.path, st.size, { 'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(it.path))}` }, { ranges: false });
}

// ---------------- nyckelbilder (för remux) ----------------
// Liten LRU-cache i minnet (nyckelbildslistor kan vara stora); resten läses från disk vid behov
const kfMem = new Map();
const KF_MAX = 64;
function kfRemember(id, mtime, kf) {
  kfMem.delete(id);
  kfMem.set(id, { mtime, kf });
  if (kfMem.size > KF_MAX) kfMem.delete(kfMem.keys().next().value);
}
const kfFile = (it) => path.join(CACHE, 'keyframes', `${it.id}-${it.mtime}.json`);
export function keyframesReady(it) {
  const m = kfMem.get(it.id);
  if (m && m.mtime === it.mtime) { kfMem.delete(it.id); kfMem.set(it.id, m); return m.kf; }
  try {
    const kf = JSON.parse(fs.readFileSync(kfFile(it), 'utf8'));
    kfRemember(it.id, it.mtime, kf);
    return kf;
  } catch { return null; }
}
/** Finns nyckelbilderna redan indexerade? (utan att läsa in dem) */
export const keyframesCached = (it) => kfMem.get(it.id)?.mtime === it.mtime || fs.existsSync(kfFile(it));
export const kfCacheSize = () => kfMem.size;
const kfRunning = new Map();
const kfQueued = new Map(); // id → väntande plats i kön (bakgrundsanalys)
// Platser för indexering: bakgrundsanalysen högst två, den som tryckt på Spela upp till tre.
// kfWait: [{ go, priority }] – prioriterade först. En plats som frigörs lämnas direkt över till första
// väntande som ryms i sin egen gräns (en bakgrundsväntare får aldrig en prioriterad plats).
let kfActive = 0; const kfWait = [];
const kfFits = (priority) => kfActive < (priority ? 3 : 2);
function kfAcquire(id, priority) {
  if (kfFits(priority)) { kfActive++; return null; }
  return new Promise(go => {
    const w = { go, priority };
    if (priority) kfWait.unshift(w); else { kfWait.push(w); kfQueued.set(id, w); }
  });
}
function kfWake() {
  for (let i = 0; i < kfWait.length; i++) {
    const w = kfWait[i];
    if (!kfFits(w.priority)) continue;
    kfWait.splice(i, 1);
    kfActive++; // räknas redan här så att ingen ny anropare hinner ta platsen innan den väckta kör
    w.go();
    return;
  }
}
function kfRelease() { kfActive--; kfWake(); }
export function computeKeyframes(it, { priority = false } = {}) {
  if (!['h264', 'hevc'].includes(it.vcodec)) return Promise.resolve(null); // remux: H.264 (TS) och HEVC (fMP4)
  if (keyframesReady(it)) return Promise.resolve(keyframesReady(it));
  if (kfRunning.has(it.id)) {
    // Bakgrundsanalysen har redan köat filen – den som tryckt på Spela ska inte vänta på kön
    const w = kfQueued.get(it.id);
    if (priority && w) {
      kfQueued.delete(it.id);
      const i = kfWait.indexOf(w);
      if (i >= 0) { kfWait.splice(i, 1); w.priority = true; kfWait.unshift(w); kfWake(); }
    }
    return kfRunning.get(it.id);
  }
  const p = (async () => {
    // Bakgrundsanalysen använder högst två samtidigt; den som just tryckt på Spela får en egen plats direkt
    await kfAcquire(it.id, priority);
    kfQueued.delete(it.id);
    try {
      // Snabba vägen: filens eget index (MKV Cues / MP4 moov) – sekunder i stället för att läsa hela filen.
      // fMP4-remux (HEVC) delar på varje nyckelbild och kräver en komplett lista; TS (H.264) klarar ett urval.
      const fast = await fastKeyframes(it.path, it.duration);
      let kf = fast && (fast.complete || it.vcodec === 'h264') ? fast.kf : null;
      if (!kf) {
        const t0 = Date.now();
        const jb = jobs.track('keyframes', `Indexerar nyckelbilder: ${it.title || path.basename(it.path)}`, { detail: 'läser hela filen' });
        let stdout;
        try {
          ({ stdout } = await pexec('ffprobe', ['-v', 'error', ...SAFE_IN, '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags',
            '-of', 'csv=p=0', it.path], { maxBuffer: 256 << 20, timeout: 30 * 60000 }));
        } finally { jb.end(); }
        kf = [];
        for (const line of stdout.split('\n')) {
          const [t, flags] = line.split(',');
          if (flags && flags[0] === 'K') { const x = parseFloat(t); if (!isNaN(x)) kf.push(x); }
        }
        kf.sort((a, b) => a - b);
        // Diagnos: när någon väntar (Spela) syns det varför starten tog tid
        if (priority) console.log(`[nyckelbilder] ${path.basename(it.path)}: ${fast ? 'filens index var ofullständigt' : 'filens index gick inte att använda'} – hela filen lästes på ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
      for (const f of fs.readdirSync(path.join(CACHE, 'keyframes'))) if (f.startsWith(it.id + '-')) fs.rmSync(path.join(CACHE, 'keyframes', f), { force: true });
      writeAtomic(kfFile(it), JSON.stringify(kf)); // en halv fil skulle räknas som indexerad men aldrig gå att läsa
      kfRemember(it.id, it.mtime, kf);
      return kf;
    } catch (e) { console.warn('[keyframes]', it.path, e.message); return null; }
    finally { kfRunning.delete(it.id); kfRelease(); }
  })();
  kfRunning.set(it.id, p);
  return p;
}
// Segmentgränser: första nyckelbild ≥ föregående gräns + SEG
// ts (H.264): egna gränser ≈ SEG s via segment-muxern. fmp4 (HEVC): ett segment per GOP – ffmpegs
// HLS-muxer med mycket kort hls_time delar på varje nyckelbild, vilket blir deterministiskt vid omstart.
function remuxBounds(it, fmt = 'ts') {
  const kf = keyframesReady(it);
  if (!kf || kf.length < 2) return null;
  if (fmt === 'fmp4') return [0, ...kf.filter(t => t > 0.05 && t < it.duration - 0.5)];
  const b = [0];
  let last = 0;
  for (const t of kf) if (t >= last + SEG - 0.001 && t < it.duration - 0.5) { b.push(t); last = t; }
  return b;
}

// ---------------- uppspelningsbeslut ----------------
// Klienten anger vad den klarar; servern väljer direkt / remux / omkodning.
export function parseCaps(q, ua = '') {
  const list = (k, def) => new Set((q.get(k) || def).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  return {
    containers: list('c', 'mp4,webm'), vcodecs: list('v', 'h264,vp8,vp9'), acodecs: list('a', 'aac,mp3,opus,vorbis,flac'),
    hdr: q.get('hdr') === '1', dv: q.get('dv') === '1', q: isQuality(q.get('q')) ? q.get('q') : 'orig',
    audio: /^\d{1,3}$/.test(q.get('audio') || '') ? String(parseInt(q.get('audio'))) : '', sub: String(q.get('sub') || '').slice(0, 10),
    hlsSubs: q.get('hlssubs') === '1', force: q.get('force') || '',
    // Spelaren använder webbläsarens egen HLS (Safari på iPhone/iPad/Mac) i stället för hls.js
    nativeHls: q.get('nhls') === '1',
    // Tittarkomfort: nattläge (jämnare ljudnivå) och tydligare dialog – ljudet omkodas med filter
    night: q.get('night') === '1', dialog: q.get('dialog') === '1',
    // Klienten väljer ljudspår själv i direktuppspelad fil (Google TV-appen) – ett annat spår än standardspåret
    // kräver då ingen remux, och ljudet (DTS, TrueHD, Atmos) går orört till förstärkaren
    localAudio: q.get('atrack') === '1',
    // HDR-typer som skärmen visar (hdr10,hlg,dovi,hdr10plus). Saknas = alla (hdr=1 räcker som förut)
    hdrTypes: q.get('hdrt') ? list('hdrt', '') : null,
    // Codecs som klienten kan avkoda i HLS med fMP4 vid omkodning (tillägg; utan = H.264 som förut)
    tc: new Set([...list('tc', '')].filter(c => c === 'hevc' || c === 'av1'))
  };
}
// Kan skärmen visa källans HDR? Dolby Vision med HDR10-baslager räcker med HDR10 (profil 5 kräver dv=1, se decide)
function hdrShown(hdr, o) {
  if (!o.hdr) return false;
  if (!o.hdrTypes) return true;
  if (hdr === 'dovi') return o.hdrTypes.has('dovi') || o.hdrTypes.has('hdr10');
  return o.hdrTypes.has(hdr);
}

export function decide(it, o) {
  const s = streamsOf(it), v = s.find(x => x.type === 'video');
  const audios = s.filter(x => x.type === 'audio');
  const defAudio = audios.find(a => a.default) || audios[0];
  const aSel = o.audio ? audios.find(a => String(a.index) === o.audio) || defAudio : defAudio;
  const sub = o.sub ? subtitlesOf(it).find(x => x.id === o.sub) : null;
  const burn = sub?.bitmap ? sub.id : '';
  const Q = QUALITIES[o.q];
  const srcKbps = it.size && it.duration ? it.size * 8 / it.duration / 1000 : 0;
  // Sänk även om bithastigheten är för hög för vald kvalitet (t.ex. 4K-remux utanför hemmet)
  const scale = !!(Q.h && ((v?.height && v.height > Q.h) || (Q.br && srcKbps > Q.br * 1.3)));
  let tonemap = !!(it.hdr && !hdrShown(it.hdr, o));
  const ext = CONTAINER[path.extname(it.path).toLowerCase()];
  const reasons = [];
  if (burn) reasons.push('bildundertext bränns in');
  if (scale) reasons.push(`sänkt kvalitet till ${o.q}p`);
  if (tonemap) reasons.push(`${it.hdr.toUpperCase()} tonmappas till SDR`);
  // Dolby Vision profil 5 saknar HDR10-baslager – kräver en enhet med Dolby Vision
  const dv5 = v?.dovi && v?.dvProfile === 5;
  const vOk = v && o.vcodecs.has(v.codec) && !(v.codec === 'h264' && is10bit(v)) && !(dv5 && !o.dv);
  const aOk = !aSel || o.acodecs.has(aSel.codec);
  const audioDefault = !aSel || aSel === defAudio || o.localAudio;
  let mode, fmt = 'ts', tag = '';
  let am = audioPlan(aSel, o);
  // Nattläge/tydligare dialog: ljudet filtreras och blir AAC stereo, så filen kan inte skickas direkt –
  // bilden kopieras ändå när det går (remux)
  const comfort = !!(aSel && (o.night || o.dialog));
  // Familjefilter (o.mute = tysta intervall ur familyfilter.js): servern tystar ljudet med ett volymfilter – också omkodat ljud
  const fam = !!(aSel && o.mute?.length);
  if (comfort || fam) am = 'aac';
  if (!comfort && !fam && !burn && !scale && !tonemap && vOk && aOk && audioDefault && ext && o.containers.has(ext) && o.force !== 'hls' && o.force !== 'transcode') mode = 'direct';
  else if (!burn && !scale && !tonemap && o.force !== 'transcode' && v?.codec === 'h264' && !is10bit(v) && (o.assumeKf || remuxBounds(it, 'ts'))) mode = 'remux';
  else if (!burn && !scale && !tonemap && o.force !== 'transcode' && v?.codec === 'hevc' && vOk && (o.assumeKf || remuxBounds(it, 'fmp4'))) {
    mode = 'remux'; fmt = 'fmp4'; tag = dv5 ? 'dvh1' : 'hvc1';
  } else mode = 'transcode';
  // Omkodning blir alltid 8 bitar (H.264, HEVC Main eller AV1), som inte ska bära HDR: HDR-källor tonmappas då även
  // för en HDR-skärm. (Annars märks bilden som PQ/BT.2020 i 8 bitar – iPhone vägrar avkoda den och andra visar bleka färger.)
  if (mode === 'transcode' && it.hdr && !tonemap) { tonemap = true; reasons.push(`${it.hdr.toUpperCase()} tonmappas till SDR`); }
  if (mode === 'transcode' && tonemap && dv5 && !dv5Ok()) reasons.push('Dolby Vision profil 5 utan grafikkort med Vulkan – färgerna kan avvika');
  // HEVC/AV1 när klienten klarar det och en kodare finns (fMP4); annars H.264 i MPEG-TS
  const vc = mode === 'transcode' ? pickVcodec(o.tc) : 'h264';
  if (vc !== 'h264') { fmt = 'fmp4'; tag = vc === 'hevc' ? 'hvc1' : ''; reasons.push(`bilden kodas som ${VC_LABEL[vc]} (${encoderFor(vc).name})`); }
  // Safaris egen HLS-spelare (iPhone) klarar inte Dolby Digital i MPEG-TS-segment – filmen startar aldrig.
  // I fMP4 (HEVC-remux) fungerar det; i TS blir ljudet AAC.
  // Detsamma gäller surround som konverteras till E-AC-3 (DTS, TrueHD, FLAC 5.1) – i TS blir det AAC.
  if (o.nativeHls && mode !== 'direct' && fmt === 'ts' && (am === 'eac3' || (am === 'copy' && aSel && ['ac3', 'eac3'].includes(aSel.codec)))) am = 'aac';
  if (mode === 'remux') reasons.push((fmt === 'fmp4' ? `${it.hdr ? it.hdr.toUpperCase() + '-' : ''}HEVC kopieras utan omkodning` : 'bilden kopieras utan omkodning') +
    (am === 'aac' ? ', ljudet konverteras till AAC' : am === 'eac3' ? ', surroundljud konverteras till Dolby Digital Plus 5.1' : ''));
  if (mode !== 'direct' && am === 'copy' && aSel && ['ac3', 'eac3'].includes(aSel.codec)) reasons.push(`${aSel.codec === 'eac3' ? 'Dolby Digital Plus/Atmos' : 'Dolby Digital'} skickas orört`);
  if (mode === 'transcode' && !reasons.length) {
    if (!vOk) reasons.push(v?.codec === 'h264' && is10bit(v) ? 'H.264 i 10 bitar stöds inte av enheten' : `videoformatet ${v?.codec || '?'} stöds inte av enheten`);
    else if (['h264', 'hevc'].includes(v?.codec) && !keyframesReady(it)) reasons.push('nyckelbilder ej indexerade än');
    else reasons.push('formatet stöds inte direkt');
  }
  if ((mode === 'remux' || mode === 'transcode') && !o.assumeKf) computeKeyframes(it).catch(() => {});
  if (comfort) reasons.push(o.night && o.dialog ? 'nattläge och tydligare dialog' : o.night ? 'nattläge' : 'tydligare dialog');
  if (fam) reasons.push('familjefiltret tystar svordomar');
  // Utanför hemmet vid omkodning: ljudet blir AAC stereo 128 kbit/s (surround och Dolby tar 0,4–0,6 Mbit/s
  // som behövs bättre till bilden på en mobil uppkoppling)
  let ab = null;
  if (o.remote && mode === 'transcode') { if (am !== 'aac') reasons.push('ljudet blir stereo för mobil uppkoppling'); am = 'aac'; ab = 128; }
  return { mode, reasons, audio: aSel ? String(aSel.index) : '', audioMode: am, ab, burn, tonemap, q: o.q, fmt, tag, hdr: mode === 'remux' ? it.hdr : null,
    night: comfort && !!o.night, dialog: comfort && !!o.dialog, vc, vcodec: mode === 'transcode' ? vc : v?.codec || null, ff: fam };
}
function copyAudio(a, o) { return ['aac', 'mp3', 'ac3', 'eac3'].includes(a.codec) && o.acodecs.has(a.codec) && (a.codec !== 'aac' || (a.channels || 2) <= 6); }
// Ljud: skicka orört om enheten klarar det; annars surround → Dolby Digital Plus 5.1 (om enheten klarar E-AC-3), annars AAC stereo
function audioPlan(a, o) {
  if (!a) return 'aac';
  if (copyAudio(a, o)) return 'copy';
  if ((a.channels || 2) > 2 && o.acodecs.has('eac3')) return 'eac3';
  return 'aac';
}

// Parametrar som identifierar en HLS-session (och följer med i alla segment-URL:er)
export function hlsParams(d, o, token) {
  // pid: en egen omkodningssession per uppspelning – två enheter på samma konto som tittar på samma titel
  // ska inte stoppa varandras ffmpeg
  const p = new URLSearchParams({ mode: d.mode, q: d.q, audio: d.audio, am: d.audioMode, burn: d.burn, tm: d.tonemap ? '1' : '0', fmt: d.fmt, tag: d.tag || '',
    pid: crypto.randomBytes(4).toString('hex') });
  if (d.hdr) p.set('vr', d.hdr === 'hlg' ? 'HLG' : 'PQ');
  // Anpassningsbar kvalitet: mastern listar även lägre steg (bara vid omkodning med automatisk kvalitet)
  if (d.abr && d.mode === 'transcode') p.set('abr', '1');
  if (d.ab) p.set('ab', String(d.ab));
  if (d.mode === 'transcode' && d.vc && d.vc !== 'h264') p.set('vc', d.vc);
  if (d.night) p.set('night', '1');
  if (d.dialog) p.set('dialog', '1');
  if (d.ff) p.set('ff', '1');
  // Uppmätt bandbredd (kbit/s): mastern listar steget som passar först (Apple-enheter börjar på första varianten)
  if (d.startBw) p.set('sbw', String(d.startBw));
  if (o.hlsSubs) p.set('hlssubs', '1');
  if (token) p.set('t', token);
  return p;
}
function readParams(q) {
  return {
    mode: q.get('mode') === 'remux' ? 'remux' : 'transcode', q: isQuality(q.get('q')) ? q.get('q') : 'orig',
    audio: /^\d{1,3}$/.test(q.get('audio') || '') ? String(parseInt(q.get('audio'))) : '',
    audioMode: ['copy', 'eac3', 'aac'].includes(q.get('am')) ? q.get('am') : 'aac',
    fmt: q.get('fmt') === 'fmp4' ? 'fmp4' : 'ts', tag: ['hvc1', 'dvh1'].includes(q.get('tag')) ? q.get('tag') : '',
    burn: /^e\d+$/.test(q.get('burn') || '') ? q.get('burn') : '', tonemap: q.get('tm') === '1', hlsSubs: q.get('hlssubs') === '1',
    vr: ['PQ', 'HLG'].includes(q.get('vr')) ? q.get('vr') : '',
    pid: /^[0-9a-f]{8}$/.test(q.get('pid') || '') ? q.get('pid') : '', abr: q.get('abr') === '1',
    ab: [96, 128, 160, 192].includes(+q.get('ab')) ? +q.get('ab') : null,
    startBw: Math.max(0, Math.min(1e6, parseInt(q.get('sbw')) || 0)) || null,
    night: q.get('night') === '1', dialog: q.get('dialog') === '1', ff: q.get('ff') === '1',
    vc: ['hevc', 'av1'].includes(q.get('vc')) ? q.get('vc') : 'h264'
  };
}
/**
 * Över kvalitetstaket cap ('720' …, kvalitetstak per användare utanför hemmet)? direct = filen skickas som den är;
 * annars avgör adressens HLS-parametrar: remux skickar källans bild, omkodning höjden för q (orig = källans).
 */
export function exceedsQuality(it, query, cap, direct = false) {
  const C = isQuality(cap) ? QUALITIES[cap] : null;
  if (!C?.h) return false;
  const v = videoOf(it), srcKbps = it.size && it.duration ? it.size * 8 / it.duration / 1000 : 0;
  const srcOver = !!((v?.height && v.height > C.h) || (C.br && srcKbps > C.br * 1.3));
  if (direct) return srcOver;
  const d = readParams(query);
  if (d.mode === 'remux') return srcOver;
  const Q = QUALITIES[d.q];
  return Q.h ? Q.h > C.h : !!(v?.height ? v.height > C.h : true);
}
// Omkodning: H.264 i MPEG-TS, HEVC/AV1 i fMP4 (fmt och tag följer av vc). Remux behåller vc = h264 (används inte).
const normParams = (d) => {
  if (d.mode !== 'remux') { d.fmt = d.vc !== 'h264' ? 'fmp4' : 'ts'; d.tag = d.vc === 'hevc' ? 'hvc1' : ''; } else d.vc = 'h264';
  return d;
};
/** Videons bithastighetstak (kbit/s) för kvalitetssteget och codec – HEVC/AV1 behöver mindre för samma kvalitet */
export const videoKbps = (q, vc = 'h264') => QUALITIES[q]?.br ? Math.round(QUALITIES[q].br * (VC_FACTOR[vc] || 1)) : null;
const withT = (p, q) => { const t = q.get('t'); if (t) p.set('t', t); return p; };

// ---------------- anpassningsbar kvalitet (ABR) ----------------
// Lägre steg som spelaren får växla ner till. Varje steg är en egen omkodningssession (q ingår i nyckeln)
// och omkodas först när spelaren faktiskt hämtar dess segment. Segmentgränserna (fasta SEG s) och
// tidsstämplarna (output_ts_offset) är identiska mellan stegen, så bytena blir sömlösa.
const ABR_STEPS = ['1080', '720', '480', '360'];
const audioKbps = (d) => d.audioMode === 'eac3' ? 640 : d.audioMode === 'copy' ? 640 : (d.ab || 192);
/** Varianter för mastern: [{ q, h, w, bw }] – vald kvalitet först, sedan lägre steg (≤ källans höjd och ≤ vald kvalitet) */
export function abrVariants(it, d) {
  const v = videoOf(it);
  const srcH = v?.height || 0;
  const size = (q) => {
    const Q = QUALITIES[q];
    const h = Q.h && (!srcH || srcH > Q.h) ? Q.h : srcH || Q.h || 720;
    const w = v?.width && v?.height ? Math.round(v.width * h / v.height / 2) * 2 : Math.round(h * 16 / 9 / 2) * 2;
    // Taket är lägre för HEVC/AV1 (samma kvalitet); utan tak är det en uppskattning som inte sänks
    const vk = Q.br ? videoKbps(q, d.mode === 'transcode' ? d.vc : 'h264') : h >= 2000 ? 40000 : h >= 1000 ? 12000 : 6000;
    // BANDWIDTH är toppvärdet: maxrate + marginal för buffert och muxning + ljud
    return { q, h, w, bw: Math.round((vk * 1.1 + audioKbps(d)) * 1000) };
  };
  const top = size(d.q);
  const out = [top];
  if (!(d.abr && d.mode === 'transcode')) return out;
  for (const q of ABR_STEPS) if (QUALITIES[q].h < top.h && (!srcH || QUALITIES[q].h <= srcH)) out.push(size(q));
  return out;
}

export function serveMaster(res, it, query) {
  const d = normParams(readParams(query));
  if (d.abr && d.mode === 'transcode') return serveAbrMaster(res, it, query, d);
  const v = videoOf(it);
  const Q = QUALITIES[d.q];
  const h = Q.h && v?.height > Q.h ? Q.h : v?.height || 720;
  const w = v?.width && v?.height ? Math.round(v.width * h / v.height / 2) * 2 : Math.round(h * 16 / 9);
  // Med kvalitetsgräns: samma toppvärde som i ABR-mastern (taket + marginal + ljud). Tidigare angavs bara
  // bildens tak, och segmenten (med ljud och TS-omkostnad) låg upp till 20 % över BANDWIDTH.
  const bw = Q.br ? abrVariants(it, d)[0].bw : (d.mode === 'remux' ? Math.max(4000, Math.round((it.size * 8 / (it.duration || 1)) / 1000)) : h >= 2000 ? 40000 : h >= 1000 ? 12000 : 6000) * 1000;
  const params = new URLSearchParams(query); params.delete('hlssubs');
  const subs = subsMedia(it, query, d);
  let m = '#EXTM3U\n#EXT-X-VERSION:4\n' + subs.m;
  // VIDEO-RANGE talar om för Apple-enheter att strömmen är HDR (krävs för att HDR-läget ska slås på)
  const vr = d.mode === 'remux' && d.vr ? `,VIDEO-RANGE=${d.vr}` : '';
  m += `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h}${vr}${subs.attr}\nindex.m3u8?${params}\n`;
  send(res, 200, m, { 'Content-Type': 'application/vnd.apple.mpegurl' });
}

function subsMedia(it, query, d) {
  let m = '', attr = '';
  if (!d.hlsSubs) return { m, attr };
  const subs = subtitlesOf(it).filter(s => !s.bitmap);
  for (const s of subs) {
    const sp = withT(new URLSearchParams(), query);
    m += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${m3uAttr(s.label || s.id)}",LANGUAGE="${m3uAttr(s.lang || 'und')}",AUTOSELECT=${s.forced ? 'YES' : 'NO'},DEFAULT=NO,FORCED=${s.forced ? 'YES' : 'NO'},URI="subs-${s.id}.m3u8?${sp}"\n`;
  }
  if (subs.length) attr = ',SUBTITLES="subs"';
  return { m, attr };
}
// Flera varianter: vald kvalitet först (Apple-enheter startar på första varianten), sedan fallande
function serveAbrMaster(res, it, query, d) {
  const subs = subsMedia(it, query, d);
  let m = '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-INDEPENDENT-SEGMENTS\n' + subs.m;
  // Steget som ryms i den uppmätta bandbredden först – iPhone/Safari börjar på första varianten och byter
  // annars ner först efter att ha fastnat på ett för tungt steg
  let vs = abrVariants(it, d);
  if (d.startBw) {
    const fit = vs.find(x => x.bw <= d.startBw * 1000 * 0.8) || vs[vs.length - 1];
    vs = [fit, ...vs.filter(x => x !== fit)];
  }
  for (const x of vs) {
    const params = new URLSearchParams(query); params.delete('hlssubs'); params.set('q', x.q);
    m += `#EXT-X-STREAM-INF:BANDWIDTH=${x.bw},RESOLUTION=${x.w}x${x.h}${subs.attr}\nindex.m3u8?${params}\n`;
  }
  send(res, 200, m, { 'Content-Type': 'application/vnd.apple.mpegurl' });
}

export function serveSubPlaylist(res, it, sid, query) {
  const sp = withT(new URLSearchParams({ hls: '1' }), query);
  const d = Math.ceil(it.duration || 1);
  send(res, 200, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${d}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${(it.duration || 1).toFixed(3)},\n../subs/${sid}.vtt?${sp}\n#EXT-X-ENDLIST\n`,
    { 'Content-Type': 'application/vnd.apple.mpegurl' });
}

function segmentsOf(it, d) {
  if (d.mode === 'remux') {
    const b = remuxBounds(it, d.fmt);
    if (b) return b.map((t, i) => ({ start: t, dur: (b[i + 1] ?? it.duration) - t }));
  }
  const starts = HEAD.filter(t => t === 0 || t < it.duration - 0.5);
  for (let t = SEG; t < it.duration - 0.5; t += SEG) starts.push(t);
  return starts.map((t, i) => ({ start: t, dur: (starts[i + 1] ?? it.duration) - t }));
}

export function servePlaylist(res, it, query) {
  if (!it.duration) return fail(res, 422, 'Okänd längd – kan inte strömma');
  const d = normParams(readParams(query));
  if (d.mode === 'remux' && !remuxBounds(it, d.fmt)) { d.mode = 'transcode'; normParams(d); }
  const segs = segmentsOf(it, d);
  const qs = new URLSearchParams(query); qs.set('mode', d.mode); qs.set('fmt', d.fmt); qs.delete('hlssubs');
  const target = Math.ceil(Math.max(...segs.map(s => s.dur)));
  const fm = d.fmt === 'fmp4';
  let m = `#EXTM3U\n#EXT-X-VERSION:${fm ? 7 : 3}\n#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n`;
  if (fm) m += `#EXT-X-MAP:URI="init.mp4?${qs}"\n`;
  segs.forEach((s, i) => { m += `#EXTINF:${s.dur.toFixed(6)},\nseg-${i}.${fm ? 'm4s' : 'ts'}?${qs}\n`; });
  m += '#EXT-X-ENDLIST\n';
  send(res, 200, m, { 'Content-Type': 'application/vnd.apple.mpegurl' });
}

// ---------------- ffmpeg-argument ----------------
// Källans färgegenskaper sätts uttryckligen först: efter avkodning på grafikkortet (NVDEC) saknas de ofta i
// bilderna, och då stannar zscale med "no path between colorspaces" – omkodningen kommer aldrig igång.
const TM_CPU = (hdr) => `setparams=color_trc=${hdr === 'hlg' ? 'arib-std-b67' : 'smpte2084'}:color_primaries=bt2020:colorspace=bt2020nc:range=tv,` +
  `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=${TONEMAP}:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;

// Tvingade nyckelbilder exakt på segmentgränserna (relativt ffmpegs start). Från början: 0, 2, 4, 6, 12 …
// – annars var SEG s. Mitt i de korta startsegmenten startar ffmpeg alltid om från början (se startFfmpeg).
const forcedKeys = (fromStart) => fromStart
  ? `expr:if(lt(n_forced,${HEAD.length}),gte(t,${HEAD[1] - HEAD[0]}*n_forced),gte(t,${SEG}*(n_forced-${HEAD.length - 1})))`
  : `expr:gte(t,n_forced*${SEG})`;

// Källans färgegenskaper (före tonmappning med grafikkortet; Dolby Vision 5 får sina från RPU-metadatan i libplacebo)
const hdrParams = (hdr, dv5) => `setparams=color_trc=${hdr === 'hlg' ? 'arib-std-b67' : 'smpte2084'}:color_primaries=bt2020${dv5 ? '' : ':colorspace=bt2020nc'}:range=tv`;

function videoArgs(it, d, fromStart) {
  const Q = QUALITIES[d.q] || QUALITIES.orig;
  const v = videoOf(it);
  const h = Q.h && v?.height && v.height > Q.h ? Q.h : null;
  const vc = d.vc || 'h264';
  // Vilken kodare: H.264 med HW-läget; HEVC/AV1 med grafikkortet eller processorn (encoderFor), K = dess slag
  const K = vc === 'h264' ? HW : encoderFor(vc)?.kind || HW;
  const br = Q.br ? Math.round(Q.br * (VC_FACTOR[vc] || 1)) : null;
  const dv5 = !!(v?.dovi && v?.dvProfile === 5);
  // Inga B-bilder: med B-bilder börjar varje segments DTS före föregående segments sista DTS (ffmpegs TS-muxer
  // skjuter bara fram det första segmentet), och Chrome avbryter då uppspelningen ("formatet stöds inte").
  // Utan B-bilder är DTS = PTS och segmenten passar exakt ihop, oavsett kodare.
  const gop = ['-force_key_frames', forcedKeys(fromStart), '-bf', '0'];
  // Tonmappad bild märks uttryckligen som SDR/BT.709 (annars kan källans HDR-märkning följa med)
  const sdr = d.tonemap ? ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'] : [];
  // Filterkedja i mjukvara (inbränning, skalning, tonmappning) innan ev. hårdvaruuppladdning
  const sw = [];
  // Flätad källa (DVB/DVD/Blu-ray 1080i, MPEG-2 i TS): avfläta först – annars kodas kammen in i H.264-bilden,
  // som märks progressiv. deint=interlaced rör bara bilder som är märkta som flätade.
  if (/^(tt|bb|tb|bt)$/.test(v?.field || '')) sw.push('yadif=mode=0:deint=interlaced');
  // 4K med processorn: snabbare skalning (skillnaden syns inte vid nedskalning) och snabbare kodarläge
  const big = K === 'none' && (v?.height || 0) > 1100;
  if (h) sw.push(big ? `scale=-2:${h}:flags=bilinear` : `scale=-2:${h}`);
  const enc = [...encArgs(K, vc, br, big), ...sdr, ...gop];
  // Hela kedjan på grafikkortet: inte vid inbränning eller avflätning (görs med processorn), bara för format som
  // grafikkortet avkodar (H.264/HEVC i 4:2:0, 8 eller 10 bitar). Bredden räknas ut här (jämn, samma bildformat).
  const gpuOk = K === HW && !d.burn && !sw.some(f => f.startsWith('yadif')) && ['h264', 'hevc'].includes(v?.codec)
    && /^(yuvj?420p|yuv420p10le)$/.test(v?.pix || '') && v?.width > 0 && v?.height > 0;
  const oh = h || v?.height, ow = Math.max(2, Math.round(v?.width * oh / v?.height / 2) * 2);
  const sp = d.tonemap ? hdrParams(it.hdr, dv5) + ',' : '';
  if (gpuOk && HW === 'nvenc' && gpuPipe.cuda) {
    // Tonmappning: tonemap_cuda › libplacebo › tonemap_opencl › processorn efter nedskalning. Dolby Vision 5 bara libplacebo.
    const tm = !d.tonemap ? null : dv5 ? (gpuTm.placeboCuda ? 'placeboCuda' : 'cpu')
      : gpuTm.cuda ? 'cuda' : gpuTm.placeboCuda ? 'placeboCuda' : gpuTm.openclCuda ? 'openclCuda' : 'cpu';
    if (tm !== 'cpu' || gpuPipe.cudaTm) {
      const sc = `scale_cuda=${ow}:${oh}:format=${d.tonemap ? 'p010le' : 'nv12'}`;
      const vf = !tm ? sc
        : tm === 'cuda' ? `${sp}${sc},${cudaTmFilter()}`
        : tm === 'placeboCuda' ? `${sp}${sc},hwdownload,format=p010le,hwupload,${plFilter()},hwdownload,format=yuv420p`
        : tm === 'openclCuda' ? `${sp}${sc},hwdownload,format=p010le,hwupload,${oclFilter()},hwdownload,format=nv12`
        : `${sc},hwdownload,format=p010le,${TM_CPU(it.hdr)}`;
      const pre = tm === 'placeboCuda' ? VK_DEV : tm === 'openclCuda' ? OCL_DEV : [];
      return { pre, dec: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'], gpu: 'cuda', tm: tm === 'cpu' ? null : tm,
        filter: ['-vf', vf], map: ['-map', '0:v:0'], enc };
    }
  }
  if (gpuOk && HW === 'vaapi' && gpuPipe.vaapi) {
    const pl = d.tonemap && gpuTm.placeboVaapi;
    const vf = pl ? `${sp}scale_vaapi=w=${ow}:h=${oh}:format=p010,hwmap=derive_device=vulkan,${plFilter('nv12')},hwmap=derive_device=vaapi:reverse=1,format=vaapi`
      : (d.tonemap ? 'tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709,' : '') + `scale_vaapi=w=${ow}:h=${oh}:format=nv12`;
    return { pre: pl ? vaPlaceboDev() : ['-vaapi_device', VAAPI_DEV], dec: ['-hwaccel', 'vaapi', '-hwaccel_device', pl ? 'va' : VAAPI_DEV, '-hwaccel_output_format', 'vaapi'],
      gpu: 'vaapi', tm: pl ? 'placeboVaapi' : null, filter: ['-vf', vf], map: ['-map', '0:v:0'], enc };
  }
  // Processorfilter. Tonmappningen kan ändå göras på grafikkortet (libplacebo/OpenCL, programvarubilder in och ut)
  // när det finns ett – utom med VA-API, där hwupload redan använder filterenheten (tonemap_vaapi som förut).
  const useVaapiTm = d.tonemap && K === 'vaapi';
  let tm = null, tmPre = [];
  if (d.tonemap && !useVaapiTm) {
    tm = dv5 ? (gpuTm.placeboSw ? 'placeboSw' : null) : gpuTm.placeboSw ? 'placeboSw' : gpuTm.openclSw ? 'openclSw' : null;
    if (tm === 'placeboSw') { sw.push(`${sp}hwupload,${plFilter()},hwdownload,format=yuv420p`); tmPre = VK_DEV; }
    else if (tm === 'openclSw') { sw.push(`${sp}format=p010le,hwupload,${oclFilter()},hwdownload,format=nv12`); tmPre = OCL_DEV; }
    else sw.push(TM_CPU(it.hdr));
  }
  const post = K === 'vaapi' ? (useVaapiTm ? ['format=p010', 'hwupload', 'tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709'] : ['format=nv12', 'hwupload'])
    : K === 'qsv' ? ['format=nv12'] : ['format=yuv420p'];
  const vf = [...sw, ...post].join(',') || 'null';
  const pre = [...(K === 'vaapi' ? ['-vaapi_device', VAAPI_DEV] : []), ...tmPre];
  if (d.burn) {
    // Bildundertext läggs över videon innan övriga filter
    return { pre, tm, filter: ['-filter_complex', `[0:v:0][0:${d.burn.slice(1)}]overlay=eof_action=pass:repeatlast=0,${vf}[vout]`], map: ['-map', '[vout]'], enc };
  }
  return { pre, tm, filter: ['-vf', vf], map: ['-map', '0:v:0'], enc };
}

// Omkodning: ljudet får aldrig börja före bilden (tidsstämplarna sätts inte om, se avoid_negative_ts nedan).
// - Kopierat ljud: ffmpeg tar annars med ljudpaketen från nyckelbilden före -ss (efter spolning upp till en hel
//   GOP, flera sekunder, som överlappade föregående segment) och AAC-ljudets inledande ram från MP4-filer.
// - Omkodat ljud: AAC-kodarens inledande ram (1024 prov) får negativ tid. Det fick TS-muxern för första segmentet
//   att skjuta fram hela segmentet ~0,02 s, så att det överlappade nästa (vid 50 bilder/s en hel bild).
//   Ljudet läggs i stället 1024 prov senare (ca 0,02 s, omärkbart) i alla körningar.
const transcodeAudio = (d, it, pre = []) => d.audio === '' ? [] : d.audioMode === 'copy' ? ['-copypriorss:a', '0'] : ['-af', [...pre, ...comfortFilters(d, it), 'asetpts=PTS+1024/SR/TB'].join(',')];

// Nattläge och tydligare dialog. Filtren ändrar inte tidsstämplarna (limiterns 5 ms fördröjning gör ljudet
// senare, aldrig tidigare än bilden). Surround (5.1/7.1 i standardordning FL FR FC LFE …) mixas ner med
// centerkanalen – där dialogen ligger – förstärkt; kanalerna anges med nummer eftersom 5.1 och 5.1(side)
// har olika namn på bakkanalerna (BL/SL) men samma ordning.
export function comfortFilters(d, it) {
  if (!d.night && !d.dialog) return [];
  const a = it ? streamsOf(it).find(x => x.type === 'audio' && String(x.index) === String(d.audio)) : null;
  const ch = a?.channels || 2;
  const f = [];
  if (d.dialog && ch === 6) f.push('pan=stereo|c0=c2+0.30*c0+0.30*c4|c1=c2+0.30*c1+0.30*c5');
  else if (d.dialog && ch === 8) f.push('pan=stereo|c0=c2+0.30*c0+0.20*c4+0.20*c6|c1=c2+0.30*c1+0.20*c5+0.20*c7');
  // Talets frekvenser (1–4 kHz) lyfts
  if (d.dialog) f.push('equalizer=f=2000:t=o:w=2:g=5');
  // Nattläge: kraftig kompression av höga ljud (explosioner) och lyft av svaga (viskningar)
  if (d.night) f.push('acompressor=threshold=-30dB:ratio=6:attack=5:release=300:makeup=4');
  else f.push('acompressor=threshold=-24dB:ratio=3:attack=10:release=250:makeup=2');
  f.push('alimiter=limit=0.95');
  return f;
}
const comfortArgs = (d, it, pre = []) => { const f = d.audio !== '' && d.audioMode !== 'copy' ? [...pre, ...comfortFilters(d, it)] : []; return f.length ? ['-af', f.join(',')] : []; };
// Familjefiltret (ff=1): volymfilter för körningen som börjar på off s (kopplas av app.js – familyfilter.js muteFilters).
// Filtrets t räknas från körningens start (-ss), därför flyttas intervallen med off.
let muteHook = null, familyForce = null;
export function setMuteHook(fn) { muteHook = fn; }
// Påtvingat familjefilter (barnprofil, kopplas av app.js): sessionen tystas även när ff=1 saknas i adressen
export function setFamilyForce(fn) { familyForce = fn; }
const familyAf = (s, it, off) => { if (!s.d.ff || !muteHook) return []; try { return muteHook(it, s.user, s.d.audio, off) || []; } catch (e) { console.warn('[familjefilter]', e.message); return []; } };

function audioArgs(d) {
  const map = d.audio !== '' ? ['-map', `0:${parseInt(d.audio)}`] : ['-map', '0:a:0?'];
  if (d.audioMode === 'copy') return [...map, '-c:a', 'copy'];
  if (d.audioMode === 'eac3') return [...map, '-c:a', 'eac3', '-b:a', '640k', '-ac', '6'];
  return [...map, '-c:a', 'aac', '-b:a', (d.ab || 192) + 'k', '-ac', '2'];
}

// ---------------- HLS-sessioner ----------------
const sessions = new Map();
const segExt = (s) => s.d.fmt === 'fmp4' ? 'm4s' : 'ts';
const segFile = (s, n) => path.join(s.dir, `seg_${String(n).padStart(5, '0')}.${segExt(s)}`);
const initFile = (s) => { try { const f = fs.readdirSync(s.dir).find(x => /^init_\d+\.mp4$/.test(x)); return f ? path.join(s.dir, f) : null; } catch { return null; } };
// Segment-muxern skriver direkt till slutligt filnamn (TS, och fMP4 vid omkodning); HLS-muxern (fMP4-remux) via temporärt namn
const directSegs = (d) => d.fmt === 'ts' || d.mode === 'transcode';
/** Omkodad fMP4: var moof börjar i segmentfilen (efter ftyp+moov), eller -1 om huvudet inte är färdigskrivet än */
export function fragStart(file) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return -1; }
  try {
    const size = fs.fstatSync(fd).size, h = Buffer.alloc(8);
    for (let o = 0; o + 8 <= size;) {
      fs.readSync(fd, h, 0, 8, o);
      const len = h.readUInt32BE(0), type = h.toString('latin1', 4, 8);
      if (type !== 'ftyp' && type !== 'moov' && type !== 'free') return type === 'moof' || type === 'styp' || type === 'sidx' ? o : -1;
      if (len < 8 || o + len > size) return -1;
      o += len;
    }
    return -1;
  } finally { fs.closeSync(fd); }
}

// Remux efter spolning: bilden kopieras från nyckelbilden före -ss, men konverterat ljud (AC-3/DTS → AAC) klipptes
// exakt vid -ss – de första ~0,25 s av segmentet blev tysta och ljudet glappade mot föregående segment.
// Utan exakt sökning avkodas ljudet från samma ställe som bilden.
const REMUX_SEEK = ['-noaccurate_seek'];

function startFfmpeg(s, it, n) {
  stopProc(s);
  const d = s.d;
  const segs = segmentsOf(it, d);
  // Nyckelbildsmönstret för de korta startsegmenten gäller bara när omkodningen börjar från början
  if (d.mode === 'transcode' && n > 0 && n < HEAD.length) n = 0;
  const t = segs[n].start;
  // HEVC/AV1-kodaren har slutat fungera (eller admin har valt bort den): H.264 i samma fMP4-session
  if (d.mode === 'transcode' && d.vc !== 'h264' && !encoderFor(d.vc)) fallbackH264(s, `${VC_LABEL[d.vc]} går inte att koda just nu`);
  // Från början utan inbränning: början av filen kan komma ur startcachen (ffmpeg läser då från stdin)
  const pipeIn = n === 0 && !d.burn && fastStart.input ? fastStart.input(it) : null;
  const src = pipeIn ? 'pipe:0' : it.path;
  let args, gpuRun = null, tmRun = null, encName = null;
  if (d.mode === 'remux' && d.fmt === 'fmp4') {
    // HEVC/HDR/Dolby Vision i fMP4: HLS-muxern med mycket kort hls_time delar på varje nyckelbild
    const next = segs[n + 1]?.start ?? it.duration;
    const ss = n > 0 ? t + Math.min(0.25, (next - t) / 2) : 0;
    args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_IN, ...(n > 0 ? ['-ss', ss.toFixed(6), ...REMUX_SEEK] : []), '-i', src,
      '-map', '0:v:0', ...audioArgs(d), ...comfortArgs(d, it, familyAf(s, it, ss)), '-c:v', 'copy', '-tag:v', d.tag || 'hvc1', '-sn', '-dn', '-strict', 'unofficial',
      '-output_ts_offset', ss.toFixed(6),
      '-f', 'hls', '-hls_time', '0.1', '-hls_list_size', '0', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', `init_${n}.mp4`,
      '-start_number', String(n), '-hls_flags', 'temp_file+independent_segments',
      // frag_discont: tfdt blir absolut tid även när ffmpeg startas mitt i filen (spolning)
      '-hls_segment_options', 'movflags=+frag_discont',
      '-hls_segment_filename', path.join(s.dir, 'seg_%05d.m4s'), path.join(s.dir, `ff_${n}.m3u8`)];
  } else if (d.mode === 'remux') {
    // Kopiera videoströmmen; dela exakt på förindexerade nyckelbilder
    // Sökning med kopierad video landar på nyckelbilden vars DTS ≤ ss. DTS ligger före PTS (B-bilder),
    // så sök en bit in i segmentet – men före nästa nyckelbild – för att landa exakt på rätt nyckelbild.
    const next = segs[n + 1]?.start ?? it.duration;
    const ss = n > 0 ? t + Math.min(0.25, (next - t) / 2) : 0;
    const times = segTimes(segs, n, ss);
    args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_IN, ...(n > 0 ? ['-ss', ss.toFixed(6), ...REMUX_SEEK] : []), '-i', src,
      '-map', '0:v:0', ...audioArgs(d), ...comfortArgs(d, it, familyAf(s, it, ss)), '-c:v', 'copy', '-sn', '-dn',
      '-output_ts_offset', ss.toFixed(6), '-muxdelay', '0', '-muxpreload', '0',
      '-f', 'segment', '-segment_format', 'mpegts', ...(times.length ? ['-segment_times', times.join(',')] : ['-segment_time', '999999']),
      '-segment_start_number', String(n), '-reset_timestamps', '0', path.join(s.dir, 'seg_%05d.ts')];
  } else {
    // Omkodning: segment-muxern delar exakt på de tvingade nyckelbilderna (extra nyckelbilder från kodaren,
    // t.ex. vid scenbyten i hårdvarukodare, ger inga extra segment – listan förblir deterministisk)
    const va = videoArgs(it, d, n === 0);
    gpuRun = va.gpu || null; tmRun = va.tm || null;
    encName = d.vc !== 'h264' ? encoderFor(d.vc)?.name || null : null;
    const times = segTimes(segs, n, t);
    const fm = d.fmt === 'fmp4';
    args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...va.pre, ...(va.dec || hwDecode()), ...SAFE_IN, ...(n > 0 ? ['-ss', String(t)] : []), '-i', src,
      ...va.filter, ...va.map, ...audioArgs(d), ...transcodeAudio(d, it, familyAf(s, it, n > 0 ? t : 0)), ...va.enc, '-sn', '-dn',
      // avoid_negative_ts: utan detta förskjuts hela körningen om något paket har negativ tid, och segmenten
      // från en omstart (spolning) skulle inte passa ihop med de första. Bilden har inga B-bilder och ljudet
      // börjar aldrig före 0 (transcodeAudio), så inget behöver förskjutas.
      '-output_ts_offset', String(t), '-muxdelay', '0', '-muxpreload', '0', '-avoid_negative_ts', 'disabled',
      ...(fm ? FMP4_SEG : ['-f', 'segment', '-segment_format', 'mpegts']), ...(times.length ? ['-segment_times', times.join(',')] : ['-segment_time', '999999']),
      '-segment_start_number', String(n), '-reset_timestamps', '0', path.join(s.dir, `seg_%05d.${fm ? 'm4s' : 'ts'}`)];
  }
  if (directSegs(d)) {
    // gamla filer framåt kan komma från en annan körning – skapa om dem för entydig klarsignal
    for (const f of fs.readdirSync(s.dir)) { const m = /^seg_(\d+)\.(ts|m4s)$/.exec(f); if (m && +m[1] >= n) fs.rmSync(path.join(s.dir, f), { force: true }); }
  }
  const p = spawn('ffmpeg', args, { stdio: [pipeIn ? 'pipe' : 'ignore', 'ignore', 'pipe'], env: { ...process.env, SVT_LOG: '1' } });
  if (pipeIn) {
    // Originalfilen ändrades eller gick inte att läsa: avbryt (nästa segment startar om från filen)
    pipeIn.on('error', (e) => { console.warn('[hls] startcachen:', e.message); p.kill('SIGKILL'); });
    p.stdin.on('error', () => {});
    pipeIn.pipe(p.stdin);
    p.on('exit', () => pipeIn.destroy()); p.on('error', () => pipeIn.destroy());
  }
  let err = '';
  p.on('error', (e) => {
    // ffmpeg saknas eller kunde inte startas – väntande förfrågningar ser !s.proc och svarar med fel
    console.warn(`[hls:${d.mode}] kunde inte starta ffmpeg:`, e.message);
    if (s.proc === p) { s.proc = null; s.done = false; }
  });
  p.stderr?.on('data', c => { err = (err + c).slice(-3000); });
  p.on('exit', (code, sig) => {
    if (s.proc === p) {
      if (code !== 0 && directSegs(d)) { const hi = highestFile(s); if (hi >= 0) fs.rmSync(segFile(s, hi), { force: true }); }
      s.proc = null; s.done = code === 0;
    }
    if (code && !sig) console.warn(`[hls:${d.mode}] ffmpeg avslutades`, code, err.trim());
    // Felen klassas efter orsak: kodarens egna meddelanden ("[hevc_nvenc @ …]") eller att den inte gick att öppna
    // stänger av HEVC/AV1-kodaren (H.264 i samma session) – inte hårdvaran eller GPU-kedjan
    if (code && !sig && encName && (err.includes(`[${encName} @`) || /Error while opening encoder|Error initializing output stream/.test(err))) {
      vEnc.failed.add(encName);
      console.warn(`[omkodning] ${encName} misslyckades – använder H.264 i stället. ${err.trim().split('\n').slice(-2).join(' ')}`);
      if (!s.proc) fallbackH264(s, `${encName} misslyckades`);
      return;
    }
    // Tonmappningen på grafikkortet fungerade inte: nästa start tar nästa väg (till sist processorn)
    if (code && !sig && tmRun) {
      gpuTm[tmRun] = false;
      console.warn(`[hårdvara] tonmappning på grafikkortet (${tmRun}) misslyckades – provar nästa väg. ${err.trim().split('\n').slice(-2).join(' ')}`);
      return;
    }
    // GPU-kedjan (skalning på grafikkortet) fungerade inte för den här filen/drivrutinen: nästa start använder
    // processorfiltren men behåller hårdvarukodningen – stäng inte av hårdvaran för det
    if (code && !sig && gpuRun) {
      if (gpuRun === 'cuda') gpuPipe.cuda = gpuPipe.cudaTm = false; else gpuPipe.vaapi = false;
      console.warn(`[hårdvara] skalning på grafikkortet (${gpuRun}) misslyckades – använder processorfilter. ${err.trim().split('\n').slice(-2).join(' ')}`);
      return;
    }
    // Hårdvaran fungerar inte: nästa start (spelaren väntar och servern försöker igen) använder processorn
    if (code && !sig && d.mode === 'transcode' && HW !== 'none' && HW_FAIL.test(err)) disableHw(err);
  });
  s.proc = p; s.paused = false; s.start = n; s.done = false; s.total = segs.length;
  if ((s.trimmed ?? -1) >= n) s.trimmed = n - 1; // spolat bakåt: segmenten därifrån skapas på nytt
}

// ffmpeg som ligger långt före uppspelningen pausas (SIGSTOP), annars kopieras en hel 4K-remux
// till disk på några minuter. Den återupptas när spelaren närmar sig eller ber om något som saknas.
// Omkodning ligger högst ~70 s före (som Plex standardbuffert på 60 s): processorn/grafikkortet arbetar inte i
// onödan med minuter som kanske aldrig ses (spolning, avbrott) och lämnar utrymme åt andra strömmar.
const AHEAD = 40, AHEAD_TRANSCODE = 12;
function resume(s) { if (s.paused && s.proc) s.proc.kill('SIGCONT'); s.paused = false; }
// Segment långt bakom uppspelningen tas bort – annars hamnar en hel film i omkodningsmappen
// (ofta /tmp = RAM i Unraid). Spolar man tillbaka skapas de igen.
const BEHIND = 30;
function trimBehind(s, n) {
  const upto = n - BEHIND;
  if (upto <= (s.trimmed ?? -1)) return;
  for (let k = Math.max(0, (s.trimmed ?? -1) + 1); k <= upto; k++) fs.rmSync(segFile(s, k), { force: true });
  s.trimmed = upto;
}
function throttle(s, n) {
  trimBehind(s, n);
  if (!s.proc) return;
  const ahead = highestFile(s) - n, max = s.d.mode === 'transcode' ? AHEAD_TRANSCODE : AHEAD;
  if (!s.paused && ahead > max) { s.proc.kill('SIGSTOP'); s.paused = true; }
  else if (s.paused && ahead < max / 2) resume(s);
}
function stopProc(s) {
  s.paused = false;
  if (!s.proc) return;
  s.proc.kill('SIGKILL'); s.proc = null;
  // segment-muxern skriver direkt till slutligt filnamn – radera det senaste (ev. halvfärdiga) segmentet
  if (directSegs(s.d)) { const hi = highestFile(s); if (hi >= 0) fs.rmSync(segFile(s, hi), { force: true }); }
}
/**
 * HEVC/AV1 fungerade inte: sessionen fortsätter med H.264 (fortfarande fMP4, samma spellista). Har spelaren redan
 * hämtat HEVC/AV1-initsegmentet passar de nya segmenten inte – webbspelaren laddar då om med H.264 (se video.js).
 */
function fallbackH264(s, why) {
  if (s.d.vc === 'h264') return;
  console.warn(`[omkodning] ${s.title || ''}: ${why} – byter till H.264${s.initServed ? ' (spelaren har redan initsegmentet och måste ladda om)' : ''}`);
  s.d.vc = 'h264'; s.d.tag = ''; s.init = null;
  try { for (const f of fs.readdirSync(s.dir)) if (/^seg_\d+\.m4s$/.test(f)) fs.rmSync(path.join(s.dir, f), { force: true }); } catch {}
}
// Högsta sammanhängande segmentet från s.start. Senaste kända värdet sparas så att varje anrop
// bara behöver kontrollera några få filer i stället för alla segment sedan start.
function highestFile(s) {
  // Segment bakom uppspelningen kan redan vara borttagna (trimBehind) – räkna från det första som finns kvar
  const from = Math.max(s.start, (s.trimmed ?? -1) + 1);
  let k = from;
  if (s.hi != null && s.hi >= from && fs.existsSync(segFile(s, s.hi))) k = s.hi;
  while (k >= 0 && fs.existsSync(segFile(s, k))) k++;
  s.hi = k - 1 >= from ? k - 1 : null;
  return k > from ? k - 1 : Math.max(from - 1, s.start - 1);
}
// Ett segment är klart när filen finns och (remux) ffmpeg gått vidare till nästa fil eller slutat.
// Halvfärdiga filer raderas alltid när en remux-process stoppas eller kraschar.
function complete(s, n) {
  if (!fs.existsSync(segFile(s, n))) return false;
  // HLS-muxern (fMP4) skriver till temporärt namn och byter namn när segmentet är klart; segment-muxern (TS) skriver direkt
  return !directSegs(s.d) || !s.proc || n < s.start || fs.existsSync(segFile(s, n + 1));
}

// Gränser för samtidiga omkodningar (skydd mot överbelastning)
export function limits() {
  return { global: +getSetting('max_transcodes', process.env.MAX_TRANSCODES || 4), user: +getSetting('max_transcodes_user', process.env.MAX_TRANSCODES_USER || 2) };
}
function ensureCapacity(s, userId) {
  if (s.d.mode !== 'transcode') {
    // Remux kostar lite CPU men läser disk – begränsa ändå (4 per användare, 16 totalt)
    const rem = [...sessions.values()].filter(x => x !== s && x.proc && x.d.mode === 'remux');
    const mineR = rem.filter(x => x.key.startsWith(userId + '-')).sort((a, b) => a.last - b.last);
    while (mineR.length >= 4) stopProc(mineR.shift());
    return [...sessions.values()].filter(x => x !== s && x.proc && x.d.mode === 'remux').length < 16;
  }
  const lim = limits();
  // ABR: spelaren har bytt kvalitetssteg i samma uppspelning (samma pid) – det gamla steget behövs inte längre.
  // Steg som någon fortfarande väntar på lämnas kvar (annars kan två steg turas om att stoppa varandra).
  for (const x of sessions.values()) {
    if (x !== s && x.proc && x.d.mode === 'transcode' && s.d.pid && x.d.pid === s.d.pid && x.user === s.user && x.item === s.item && !x.waiting) stopProc(x);
  }
  const active = [...sessions.values()].filter(x => x !== s && x.proc && x.d.mode === 'transcode');
  // Användarens äldsta omkodningar stoppas först (t.ex. vid byte av kvalitet eller enhet)
  const mine = active.filter(x => x.key.startsWith(userId + '-')).sort((a, b) => a.last - b.last);
  while (mine.length >= lim.user) stopProc(mine.shift());
  return [...sessions.values()].filter(x => x !== s && x.proc && x.d.mode === 'transcode').length < lim.global;
}

function sessionFor(it, query, userId) {
  const d = normParams(readParams(query));
  if (d.mode === 'remux' && !remuxBounds(it, d.fmt)) { d.mode = 'transcode'; normParams(d); }
  // Påtvingat familjefilter: klienten kan inte välja bort tystnaden genom att ta bort ff=1, välja am=copy eller audio=''
  // (volymfiltret kräver omkodat ljud och ett valt spår)
  if (!d.ff && familyForce?.(userId, it, d.audio)) {
    d.ff = true;
    if (d.audioMode === 'copy') d.audioMode = 'aac';
    if (d.audio === '') { const a = streamsOf(it).filter(x => x.type === 'audio'); const def = a.find(x => x.default) || a[0]; if (def) d.audio = String(def.index); }
  } else if (d.ff && d.audioMode === 'copy') d.audioMode = 'aac';
  const key = `${userId}-${it.id}-${d.mode}-${d.fmt}-${d.tag}-${d.vc}-${d.q}-${d.audio}-${d.audioMode}-${d.burn}-${d.tonemap ? 1 : 0}${d.night ? '-n' : ''}${d.dialog ? '-dl' : ''}${d.ff ? '-ff' : ''}${d.pid ? '-' + d.pid : ''}`;
  let s = sessions.get(key);
  if (!s) {
    s = { key, d, dir: path.join(TRANSCODE, key), proc: null, start: -1, done: false, total: 0, last: Date.now(), user: userId, item: it.id, waiting: 0,
      created: Date.now(), title: it.title, slowLogged: false, firstLogged: false };
    fs.mkdirSync(s.dir, { recursive: true });
    sessions.set(key, s);
  }
  s.last = Date.now();
  return s;
}

/** Startar ffmpeg direkt när uppspelningen begärs, så att första segmentet är på väg medan spelaren
 *  hämtar spellistorna (sparar några rundresor innan bilden kommer). */
export function prewarm(it, query, userId, start = 0) {
  try {
    const s = sessionFor(it, query, userId);
    if (s.proc || !it.duration) return;
    const segs = segmentsOf(it, s.d);
    let n = 0;
    while (n + 1 < segs.length && segs[n + 1].start <= start) n++;
    if (ensureCapacity(s, userId)) startFfmpeg(s, it, n);
  } catch (e) { console.warn('[hls] förstart:', e.message); }
}

// fMP4-initsegment (moov). Identiskt för alla körningar i samma session.
export async function serveInit(req, res, it, query, userId) {
  const s = sessionFor(it, query, userId);
  if (s.d.fmt !== 'fmp4') return fail(res, 404, 'Inget initsegment');
  const t0 = Date.now();
  // Remux (HLS-muxern): initfilen är färdigskriven när första mediasegmentet finns.
  // Omkodning (segment-muxern): ftyp+moov i början av vilket segment som helst – samma i alla körningar.
  const tc = s.d.mode === 'transcode';
  const ready = tc ? () => !!(s.init ||= transcodeInit(s))
    : () => { const f = initFile(s); return f && fs.statSync(f).size > 0 && fs.readdirSync(s.dir).some(x => /^seg_\d+\.m4s$/.test(x)); };
  let starts = 0;
  resume(s);
  while (!ready()) {
    if (!s.proc) {
      // ffmpeg som dör direkt (trasig fil) ska inte startas om var 100:e ms
      if (++starts > 3) return fail(res, 500, 'ffmpeg misslyckades – se serverloggen');
      if (!ensureCapacity(s, userId)) return fail(res, 503, 'För många samtidiga strömmar');
      startFfmpeg(s, it, 0);
    }
    if (Date.now() - t0 > (tc ? 90000 : 30000) || req.destroyed) return fail(res, 504, 'Initsegmentet blev inte klart');
    s.last = Date.now();
    await new Promise(r => setTimeout(r, 100));
  }
  let buf;
  if (tc) { buf = Buffer.from(s.init); s.initServed = true; }
  else try { buf = fs.readFileSync(initFile(s)); } catch { return fail(res, 404, 'Segmentet försvann – försök igen'); }
  if (!tc || s.d.tag) buf = hevcTag(buf, s.d.tag || 'hvc1');
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/** Initsegmentet (ftyp+moov) ur första färdiga segmentfilen i en omkodningssession, eller null */
function transcodeInit(s) {
  let files; try { files = fs.readdirSync(s.dir).filter(x => /^seg_\d+\.m4s$/.test(x)).sort(); } catch { return null; }
  for (const f of files) {
    const file = path.join(s.dir, f), end = fragStart(file);
    if (end <= 0) continue;
    try {
      const fd = fs.openSync(file, 'r'), b = Buffer.alloc(end);
      try { fs.readSync(fd, b, 0, end, 0); } finally { fs.closeSync(fd); }
      return b;
    } catch {}
  }
  return null;
}

// ffmpeg 5.1:s mov-muxer känner inte till dvh1 och skriver då hev1, som Apple inte spelar. Sätt provpostens
// typ till önskad tagg och markera parameteruppsättningarna i hvcC som kompletta (krävs för hvc1/dvh1 –
// ffmpeg lägger alltid VPS/SPS/PPS där vid kopiering). Rör bara HEVC-poster; övrigt lämnas orört.
export function hevcTag(buf, tag) {
  const HEVC = ['hev1', 'hvc1', 'dvh1', 'dvhe'];
  for (let o = buf.indexOf('stsd'); o >= 4; o = buf.indexOf('stsd', o + 4)) {
    const e = o + 12; // 4 typ + 4 version/flaggor + 4 antal → första postens storlek
    if (e + 8 > buf.length) break;
    const type = buf.toString('latin1', e + 4, e + 8);
    if (!HEVC.includes(type) || type === tag) continue;
    const end = Math.min(buf.length, e + buf.readUInt32BE(e));
    buf.write(tag, e + 4, 'latin1');
    // hvcC ligger efter VisualSampleEntry (78 byte) – leta efter den inom posten
    const h = buf.indexOf('hvcC', e + 8);
    if (h < 0 || h + 27 > end) continue;
    const c = h + 4; // början på HEVCDecoderConfigurationRecord
    let q = c + 23;
    for (let i = 0, n = buf[c + 22]; i < n && q + 3 <= end; i++) {
      buf[q] |= 0x80;
      const cnt = buf.readUInt16BE(q + 1); q += 3;
      for (let j = 0; j < cnt && q + 2 <= end; j++) q += 2 + buf.readUInt16BE(q);
    }
  }
  return buf;
}

export async function serveSegment(req, res, it, n, query, userId) {
  const s = sessionFor(it, query, userId);
  const d = s.d;
  const total = segmentsOf(it, d).length;
  s.total = total;
  if (!(Number.isInteger(n) && n >= 0 && n < total)) return fail(res, 404, 'Segment finns inte');
  if (!complete(s, n)) {
    s.waiting++;
    const w0 = Date.now();
    try { const r = await awaitSegment(req, res, it, s, n, userId); if (r !== true) return; }
    finally { s.waiting--; }
    // Diagnos: spelaren fick vänta på ett segment mitt i uppspelningen = servern hinner inte med
    const waited = (Date.now() - w0) / 1000;
    if (s.firstLogged && waited > 4 && !s.slowLogged) {
      s.slowLogged = true;
      console.warn(`[hls] ${s.title}: väntade ${waited.toFixed(1)} s på segment ${n} (${d.mode}) – ${d.mode === 'transcode' ? `omkodningen (${HW === 'none' ? 'processor' : HW}) är långsammare än uppspelningen` : 'disken eller nätverket hinner inte med'}`);
    }
  }
  if (!s.firstLogged) {
    s.firstLogged = true;
    console.log(`[hls] ${s.title}: första segmentet klart ${((Date.now() - s.created) / 1000).toFixed(1)} s efter start (${d.mode}${d.mode === 'transcode' ? ', ' + (HW === 'none' ? 'processor' : HW) : ''})`);
  }
  throttle(s, n);
  const file = segFile(s, n);
  if (d.mode === 'transcode' && d.fmt === 'fmp4') {
    // Bara moof+mdat – ftyp+moov skickas en gång som initsegment
    s.init ||= transcodeInit(s);
    const at = fragStart(file);
    if (at < 0) return fail(res, 404, 'Segmentet försvann – försök igen');
    return sendSegment(req, res, file, 'video/iso.segment', at);
  }
  sendSegment(req, res, file, d.fmt === 'fmp4' ? 'video/iso.segment' : 'video/mp2t');
}
/** Väntar tills segment n är klart (startar ffmpeg vid behov). Allt annat än true = ett felsvar har skickats. */
async function awaitSegment(req, res, it, s, n, userId) {
  {
    resume(s);
    const hi = s.proc ? highestFile(s) : -1;
    const covered = s.proc && n >= s.start && n <= Math.max(hi, s.start) + 4;
    let starts = 0;
    if (!covered) {
      if (!ensureCapacity(s, userId)) return fail(res, 503, 'Servern har för många samtidiga omkodningar just nu – försök igen strax eller välj Original');
      startFfmpeg(s, it, n); starts++;
    }
    const t0 = Date.now();
    while (!complete(s, n)) {
      if (Date.now() - t0 > 90000 || req.destroyed) return fail(res, 504, 'Omkodningen hann inte med');
      // Långsam omkodning (4K-tonmappning): städningen får inte döda ffmpeg medan någon väntar
      s.last = Date.now();
      if (!s.proc && !complete(s, n)) {
        if (++starts > 3) return fail(res, 500, 'ffmpeg misslyckades – se serverloggen');
        if (!ensureCapacity(s, userId)) return fail(res, 503, 'Servern har för många samtidiga omkodningar just nu');
        startFfmpeg(s, it, n);
      }
      await new Promise(r => setTimeout(r, 120));
    }
  }
  return true;
}
function sendSegment(req, res, file, type, from = 0) {
  let st; try { st = fs.statSync(file); } catch { return fail(res, 404, 'Segmentet försvann – försök igen'); }
  const size = Math.max(0, st.size - from);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD' || !size) return res.end();
  pipeline(fs.createReadStream(file, { start: from }), res, () => {});
}

// Städa: döda inaktiva ffmpeg efter 60 s, radera cache efter 15 min
setInterval(() => {
  for (const [k, s] of sessions) {
    const idle = Date.now() - s.last;
    if (idle > 60000 && s.proc) stopProc(s);
    if (idle > 900000) { fs.rmSync(s.dir, { recursive: true, force: true }); sessions.delete(k); }
  }
}, 15000).unref();

/** Stoppar användarens sessioner av titeln. Med pid bara den uppspelningen (t.ex. webbspelaren som stängs
 *  medan Chromecast fortsätter med en egen session); utan pid alla (appar och adminens stopp). */
export function stopUserSessions(itemId, userId, pid = '') {
  for (const [, s] of sessions) if (s.key.startsWith(`${userId}-${itemId}-`) && (!pid || s.d.pid === pid)) stopProc(s);
}
export const activeTranscodes = () => [...sessions.values()].filter(s => s.proc).map(s => s.d.mode);
jobs.addSource(() => [...sessions.values()].filter(s => s.proc && !s.paused).map(s => ({
  id: 'hls-' + s.key, kind: s.d.mode === 'transcode' ? 'transcode' : 'remux',
  title: `${s.d.mode === 'transcode' ? 'Omkodar' : 'Remuxar'} ${s.title || ''}`.trim(),
  detail: s.d.mode === 'transcode' ? `${s.d.q && s.d.q !== 'orig' ? s.d.q + 'p · ' : ''}${s.d.vc !== 'h264' ? VC_LABEL[s.d.vc] + ' · ' + (encoderFor(s.d.vc)?.name || '') : HW === 'none' ? 'processor' : HW}${s.d.tonemap ? ' · HDR→SDR' : ''}` : 'utan omkodning',
  done: Math.max(0, highestFile(s) + 1), total: s.total || null })));
// Diskövervakning: antal HLS-sessioner och rensning av inaktiva när omkodningsdisken är nästan full
export const sessionCount = () => sessions.size;
export function purgeIdle(idleMs) {
  let n = 0;
  for (const [k, s] of sessions) {
    if (Date.now() - s.last <= idleMs) continue;
    stopProc(s); fs.rmSync(s.dir, { recursive: true, force: true }); sessions.delete(k); n++;
  }
  return n;
}
export const hwMode = HW;

/** Kodare för live-TV och efterbearbetning av inspelningar (avflätning + valfri skalning, hårdvara om möjligt) */
export function liveEncoder({ deinterlace = true, maxHeight = null, bitrate = null } = {}) {
  const sw = [];
  if (deinterlace) sw.push('yadif=mode=0:deint=interlaced');
  if (maxHeight) sw.push(`scale=-2:'min(${maxHeight},ih)'`);
  const rate = (fallback) => bitrate ? ['-b:v', bitrate + 'k', '-maxrate', bitrate + 'k', '-bufsize', bitrate * 2 + 'k'] : fallback;
  let post, enc;
  if (HW === 'vaapi') { post = ['format=nv12', 'hwupload']; enc = ['-c:v', 'h264_vaapi', ...rate(['-qp', '23'])]; }
  else if (HW === 'nvenc') { post = ['format=yuv420p']; enc = ['-c:v', 'h264_nvenc', '-preset', 'p4', ...rate(['-cq', '23'])]; }
  else if (HW === 'qsv') { post = ['format=nv12']; enc = ['-c:v', 'h264_qsv', ...rate(['-global_quality', '23'])]; }
  else { post = ['format=yuv420p']; enc = ['-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast', ...rate(['-crf', '22']), '-profile:v', 'high']; }
  return { pre: HW === 'vaapi' ? ['-vaapi_device', VAAPI_DEV] : [], vf: ['-vf', [...sw, ...post].join(',')], enc };
}

// För tester
export const _segs = { trimBehind, highestFile, videoArgs, transcodeInit, fallbackH264 };
export const _slots = { subSlot, kfAcquire, kfRelease, kf: () => ({ active: kfActive, waiting: kfWait.length }), listDir, liveSubs, sessions };
