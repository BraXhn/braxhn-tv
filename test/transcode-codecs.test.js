// Omkodningens grund: sondering av ffmpeg (version, kodare, Vulkan), HEVC/AV1 ut i fMP4 när klienten och servern
// klarar det, kommandorader för grafikkortens kedjor (tonmappning med tonemap_cuda/libplacebo/OpenCL), reservväg till
// H.264 när en kodare fallerar och HEIC-rutnät i fotobiblioteket. Allt med ffmpeg-genererade filer; GPU-kedjorna
// kontrolleras som argument (ingen GPU i CI) i egna processer, eftersom HWACCEL läses när stream.js laddas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-codec-'));
process.env.TRANSCODE_DIR = path.join(process.env.CONFIG_DIR, 'tc');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-codecm-'));
const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
const probeJson = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', f]).toString()).streams;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('ffmpeg-sondering: version, kodar-/filterlistor och Vulkan-enhet tolkas', async () => {
  const fc = await import('../server/ffcaps.js');
  assert.deepEqual(fc.parseVersion('ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026'), { text: '7.1.5-0+deb13u1', major: 7, minor: 1 });
  assert.deepEqual(fc.parseVersion('ffmpeg version 5.1.9-0+deb12u1 Copyright'), { text: '5.1.9-0+deb12u1', major: 5, minor: 1 });
  assert.equal(fc.parseVersion('ffmpeg version n7.1 Copyright').major, 7);
  assert.equal(fc.parseVersion('ffmpeg version N-118000-gabc Copyright').major, 99, 'utvecklingsbygge räknas som nyast');
  assert.equal(fc.parseVersion('något annat').major, 0);
  const enc = fc.parseList('Encoders:\n V..... = Video\n ------\n V....D libx265              libx265 H.265 / HEVC (codec hevc)\n V....D av1_nvenc            NVIDIA NVENC av1 encoder (codec av1)\n A....D aac                  AAC');
  assert.deepEqual([...enc], ['libx265', 'av1_nvenc', 'aac']);
  const flt = fc.parseList('Filters:\n  T.. = Timeline support\n ..C libplacebo        N->V       Apply various GPU filters\n TSC zscale            V->V       Apply resizing');
  assert.deepEqual([...flt], ['libplacebo', 'zscale']);
  // ffmpeg 8 skriver bara två flaggtecken (" TS scale  V->V …")
  assert.deepEqual([...fc.parseList('Filters:\n  T. = Timeline support\n  A = Audio input/output\n TS scale             V->V       Scale the input video\n .. anull             A->A       Pass the source')], ['scale', 'anull']);
  assert.deepEqual(fc.parseVulkanDevice('[AVHWDeviceContext @ 0x1] Device 0 selected: llvmpipe (LLVM 19.1.7, 256 bits) (software) (0x0)'), { name: 'llvmpipe (LLVM 19.1.7, 256 bits)', type: 'software' });
  assert.deepEqual(fc.parseVulkanDevice('Device 1 selected: NVIDIA GeForce RTX 4060 (discrete) (0x2882)'), { name: 'NVIDIA GeForce RTX 4060', type: 'discrete' });
  assert.equal(fc.parseVulkanDevice('Failed to create Vulkan device'), null);
  const caps = await fc.ffReady;
  if (hasFfmpeg) { assert.ok(caps.major >= 4, `ffmpeg-versionen lästes: ${caps.version}`); assert.ok(caps.encoders.has('libx264')); assert.ok(caps.filters.has('scale')); }
});

t('HEVC/AV1 ut: kodarna provkörs vid start och väljs bara när klienten (tc=) och admin tillåter', async () => {
  const st = await import('../server/stream.js');
  const db = await import('../server/db.js');
  const fc = await import('../server/ffcaps.js');
  await st.transcodeReady;
  // Provkörningen: x265 klarar tvingade nyckelbilder i alla versioner; SVT-AV1 bara i nyare (5.1/6.1 struntar i dem)
  if (fc.ffcaps.encoders.has('libx265')) assert.equal(st.vEnc.cpu.hevc, 'libx265');
  assert.ok([null, 'libsvtav1'].includes(st.vEnc.cpu.av1));
  const it = { id: 7, path: '/film.avi', duration: 600, size: 6e8, hdr: null,
    streams: JSON.stringify([{ type: 'video', index: 0, codec: 'mpeg4', pix: 'yuv420p', width: 1920, height: 1080 }, { type: 'audio', index: 1, codec: 'aac', channels: 2 }]) };
  const caps = (q) => st.parseCaps(new URLSearchParams(q));
  // Standard (auto): bara grafikkortets kodare – här finns ingen, alltså H.264 i TS som förut
  db.setSetting('transcode_vcodec', 'auto');
  let d = st.decide(it, caps('v=h264,hevc,av1&a=aac&tc=hevc,av1&q=720'));
  assert.deepEqual([d.mode, d.vc, d.fmt, d.tag], ['transcode', 'h264', 'ts', '']);
  assert.equal(st.hlsParams(d, {}, null).get('vc'), null, 'inget vc= för H.264 (äldre adresser fungerar som förut)');
  if (!st.vEnc.cpu.hevc) return;
  // Admin tillåter processorn: HEVC i fMP4 med hvc1, lägre tak för samma kvalitet
  db.setSetting('transcode_vcodec', 'cpu');
  d = st.decide(it, caps('v=h264,hevc&a=aac&tc=hevc&q=720'));
  assert.deepEqual([d.mode, d.vc, d.vcodec, d.fmt, d.tag], ['transcode', 'hevc', 'hevc', 'fmp4', 'hvc1']);
  assert.ok(d.reasons.some(r => /HEVC \(libx265\)/.test(r)), d.reasons.join(', '));
  const hp = st.hlsParams(d, {}, null);
  assert.equal(hp.get('vc'), 'hevc'); assert.equal(hp.get('fmt'), 'fmp4');
  assert.equal(st.videoKbps('720', 'hevc'), 2400); assert.equal(st.videoKbps('720', 'av1'), 2000); assert.equal(st.videoKbps('720'), 4000);
  const va = st._segs.videoArgs(it, d, true);
  assert.ok(va.enc.includes('libx265') && va.enc.includes('hvc1'), va.enc.join(' '));
  assert.equal(va.enc[va.enc.indexOf('-maxrate') + 1], '2400k');
  assert.ok(va.enc.includes('-forced-idr') && va.enc.join(' ').includes('scenecut=0'), 'inga extra nyckelbilder och tvingade blir IDR');
  // Utan tc (appar, Chromecast, äldre webbläsare): H.264 som förut; tc med en codec utan kodare: H.264
  assert.equal(st.decide(it, caps('v=h264,hevc&a=aac&q=720')).vc, 'h264');
  if (!st.vEnc.cpu.av1) assert.equal(st.decide(it, caps('v=h264,av1&a=aac&tc=av1&q=720')).vc, 'h264');
  // Direkt och remux påverkas inte
  const h264 = { ...it, path: '/film.mp4', streams: JSON.stringify([{ type: 'video', index: 0, codec: 'h264', pix: 'yuv420p', width: 1920, height: 1080 }, { type: 'audio', index: 1, codec: 'aac', channels: 2 }]) };
  assert.equal(st.decide(h264, caps('c=mp4&v=h264,hevc&a=aac&tc=hevc')).mode, 'direct');
  // Admin: alltid H.264
  db.setSetting('transcode_vcodec', 'h264');
  assert.equal(st.decide(it, caps('v=h264,hevc&a=aac&tc=hevc&q=720')).vc, 'h264');
  assert.equal(st.transcodeInfo().hevc, null);
  db.setSetting('transcode_vcodec', 'cpu');
  assert.equal(st.transcodeInfo().hevc, 'libx265');
});

t('reservväg: en HEVC-kodare som fallerar ger H.264 i samma fMP4-session och väljs inte igen', async () => {
  const st = await import('../server/stream.js');
  const db = await import('../server/db.js');
  await st.transcodeReady;
  if (!st.vEnc.cpu.hevc) return;
  db.setSetting('transcode_vcodec', 'cpu');
  const src = path.join(dir, 'kalla.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=8', '-f', 'lavfi', '-i', 'sine=d=8', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', src);
  const it = { id: 99, path: src, duration: 8, size: fs.statSync(src).size, mtime: 1, title: 'Reservtest',
    streams: JSON.stringify([{ type: 'video', index: 0, codec: 'mpeg4', pix: 'yuv420p', width: 320, height: 180 }, { type: 'audio', index: 1, codec: 'aac', channels: 2 }]) };
  const o = st.parseCaps(new URLSearchParams('v=h264,hevc&a=aac&tc=hevc'));
  const d = st.decide(it, o);
  assert.equal(d.vc, 'hevc');
  const q = st.hlsParams(d, o, null);
  // Ogiltigt x265-läge: kodaren går inte att öppna ("[libx265 @ …] Error setting preset")
  process.env.X265_PRESET = 'ogiltig';
  try {
    st.prewarm(it, q, 1, 0);
    for (let i = 0; i < 100 && !st.vEnc.failed.has('libx265'); i++) await sleep(100);
  } finally { delete process.env.X265_PRESET; }
  assert.ok(st.vEnc.failed.has('libx265'), 'kodaren markerad som trasig');
  const s = [...st._slots.sessions.values()].find(x => x.item === 99);
  assert.equal(s.d.vc, 'h264', 'sessionen bytte till H.264');
  assert.equal(s.d.fmt, 'fmp4', 'samma spellista (fMP4) som spelaren redan har');
  // Nästa start: H.264 i fMP4 – initsegmentet ur första segmentet, segmentet utan ftyp/moov
  for (let i = 0; i < 50 && !s.proc; i++) { st.prewarm(it, q, 1, 0); await sleep(100); }
  let init = null;
  for (let i = 0; i < 150 && !(init = st._segs.transcodeInit(s)); i++) await sleep(100);
  assert.ok(init, 'initsegment');
  for (let i = 0; i < 150 && !fs.existsSync(path.join(s.dir, 'seg_00001.m4s')); i++) await sleep(100);
  const seg0 = fs.readFileSync(path.join(s.dir, 'seg_00000.m4s'));
  const at = st.fragStart(path.join(s.dir, 'seg_00000.m4s'));
  assert.equal(seg0.toString('latin1', at + 4, at + 8), 'moof');
  const f = path.join(dir, 'reserv.mp4');
  fs.writeFileSync(f, Buffer.concat([init, seg0.subarray(at)]));
  const v = probeJson(f).find(x => x.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  // Beslutet väljer inte HEVC igen (kodaren är avstängd tills omstart)
  assert.equal(st.decide(it, o).vc, 'h264');
  assert.deepEqual(st.transcodeInfo().failed, ['libx265']);
  st.stopUserSessions(99, 1);
  st.vEnc.failed.clear();
});

t('fMP4-omkodning: samma moov i alla körningar och tfdt i absolut tid (även efter spolning)', async () => {
  const st = await import('../server/stream.js');
  const db = await import('../server/db.js');
  await st.transcodeReady;
  if (!st.vEnc.cpu.hevc) return;
  db.setSetting('transcode_vcodec', 'cpu');
  const src = path.join(dir, 'spol.mkv');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=20', '-f', 'lavfi', '-i', 'sine=d=20,aformat=channel_layouts=5.1', '-c:v', 'mpeg4', '-c:a', 'ac3', '-shortest', src);
  const it = { id: 98, path: src, duration: 20, size: fs.statSync(src).size, mtime: 1, title: 'Spoltest',
    streams: JSON.stringify([{ type: 'video', index: 0, codec: 'mpeg4', pix: 'yuv420p', width: 320, height: 180 }, { type: 'audio', index: 1, codec: 'ac3', channels: 6 }]) };
  // HEVC med kopierat AC-3: moov måste vänta på ljudpaketen (delay_moov), annars "Cannot write moov atom before … packets"
  const o = st.parseCaps(new URLSearchParams('v=h264,hevc&a=aac,ac3&tc=hevc'));
  const d = st.decide(it, o);
  assert.deepEqual([d.vc, d.audioMode], ['hevc', 'copy']);
  const q = st.hlsParams(d, o, null);
  const wait = async (f) => { for (let i = 0; i < 300 && !fs.existsSync(f); i++) await sleep(100); assert.ok(fs.existsSync(f), f); };
  st.prewarm(it, q, 2, 0);
  const s = [...st._slots.sessions.values()].find(x => x.item === 98);
  await wait(path.join(s.dir, 'seg_00004.m4s'));
  const initA = st._segs.transcodeInit(s);
  const a3 = fs.readFileSync(path.join(s.dir, 'seg_00003.m4s'));
  st.stopUserSessions(98, 2);
  for (const f of fs.readdirSync(s.dir)) fs.rmSync(path.join(s.dir, f), { force: true });
  s.init = null;
  // Ny körning från 12 s (segment 4 i rutnätet 0, 2, 4, 6, 12, 18), som efter en spolning
  st.prewarm(it, q, 2, 12);
  await wait(path.join(s.dir, 'seg_00005.m4s'));
  const initB = st._segs.transcodeInit(s);
  assert.ok(initA && initB);
  assert.ok(initA.equals(initB), 'moov ändras inte mellan körningar');
  const tfdt = (b) => { const i = b.indexOf('tfdt'); return b[i + 4] === 1 ? Number(b.readBigUInt64BE(i + 8)) : b.readUInt32BE(i + 8); };
  const m = initA.indexOf('mdhd'), ts = initA[m + 4] === 1 ? initA.readUInt32BE(m + 24) : initA.readUInt32BE(m + 16);
  const b4 = fs.readFileSync(path.join(s.dir, 'seg_00004.m4s'));
  assert.ok(Math.abs(tfdt(b4.subarray(st.fragStart(path.join(s.dir, 'seg_00004.m4s')))) / ts - 12) < 0.05, 'segment 4 börjar på 12 s');
  assert.ok(Math.abs(tfdt(a3.subarray(a3.indexOf('moof') - 4)) / ts - 6) < 0.05, 'segment 3 börjar på 6 s');
  const v = probeJson(path.join(s.dir, 'seg_00004.m4s'));
  assert.deepEqual(v.map(x => x.codec_name).sort(), ['ac3', 'hevc']);
  st.stopUserSessions(98, 2);
});

/** Kör kod i en egen process med HWACCEL satt (läses när stream.js laddas) och returnerar JSON-utdatan */
function withHw(hw, body) {
  const code = `const st = await import(${JSON.stringify(new URL('../server/stream.js', import.meta.url).href)});
    const db = await import(${JSON.stringify(new URL('../server/db.js', import.meta.url).href)});
    const hdr = (v) => ({ id: 1, hdr: 'hdr10', streams: JSON.stringify([{ type: 'video', index: 0, codec: 'hevc', pix: 'yuv420p10le', width: 3840, height: 2160, ...v }]) });
    const out = {}; ${body}
    console.log(JSON.stringify(out)); process.exit(0);`;
  const env = { ...process.env, HWACCEL: hw, TRANSCODE_PROBE: '0', CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-hw-')), TRANSCODE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-hw-tc-')) };
  return JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { env }).toString().trim().split('\n').pop());
}

test('NVIDIA: HEVC/AV1 med NVENC och tonmappning på grafikkortet (tonemap_cuda › libplacebo › OpenCL › processorn)', () => {
  const r = withHw('nvenc', `
    st.vEnc.hw.hevc = 'hevc_nvenc'; st.vEnc.hw.av1 = 'av1_nvenc';
    st.gpuPipe.cuda = st.gpuPipe.cudaTm = true;
    const d = { q: '1080', tonemap: true, mode: 'transcode', vc: 'hevc' };
    out.pick = st.pickVcodec(new Set(['hevc', 'av1']));
    out.sdr = st._segs.videoArgs({ ...hdr(), hdr: null }, { ...d, tonemap: false }, true);
    out.cpu = st._segs.videoArgs(hdr(), d, true);
    st.gpuTm.openclCuda = true; out.ocl = st._segs.videoArgs(hdr(), d, true);
    out.dv5Ocl = st._segs.videoArgs(hdr({ dovi: true, dvProfile: 5 }), d, true);
    st.gpuTm.placeboCuda = true; out.pl = st._segs.videoArgs(hdr(), d, true);
    out.dv5 = st._segs.videoArgs(hdr({ dovi: true, dvProfile: 5 }), d, true);
    st.gpuTm.cuda = true; out.cuda = st._segs.videoArgs(hdr(), d, true);
    out.av1 = st._segs.videoArgs(hdr(), { ...d, vc: 'av1', q: '720' }, true);
    out.info = st.transcodeInfo();
    // Grafikkortet saknar HEVC-kodare men admin tillåter processorn: x265, inga GPU-filter
    st.vEnc.hw.hevc = st.vEnc.hw.av1 = null; st.vEnc.cpu.hevc = 'libx265'; db.setSetting('transcode_vcodec', 'cpu');
    out.x265 = st._segs.videoArgs({ ...hdr(), hdr: null }, { ...d, tonemap: false }, true);
    out.pickCpu = st.pickVcodec(new Set(['hevc', 'av1']));`);
  assert.equal(r.pick, 'av1', 'AV1 före HEVC när båda finns på grafikkortet');
  assert.ok(r.sdr.enc.includes('hevc_nvenc') && r.sdr.enc.includes('-no-scenecut') && r.sdr.enc.includes('hvc1'), r.sdr.enc.join(' '));
  assert.equal(r.sdr.filter[1], 'scale_cuda=1920:1080:format=nv12');
  assert.equal(r.sdr.enc[r.sdr.enc.indexOf('-maxrate') + 1], '4800k', '1080p: 8000 × 0,6');
  // Bara processorn kvar: nedskalning på kortet, tonmappning med zscale
  assert.match(r.cpu.filter[1], /^scale_cuda=1920:1080:format=p010le,hwdownload,format=p010le,setparams=.*zscale/);
  assert.equal(r.cpu.tm, null);
  // OpenCL: på den nedskalade bilden, egen filterenhet
  assert.match(r.ocl.filter[1], /^setparams=.*scale_cuda=1920:1080:format=p010le,hwdownload,format=p010le,hwupload,tonemap_opencl=.*format=nv12,hwdownload,format=nv12$/);
  assert.deepEqual(r.ocl.pre, ['-init_hw_device', 'opencl=ocl', '-filter_hw_device', 'ocl']);
  assert.equal(r.ocl.tm, 'openclCuda');
  // Dolby Vision 5 utan libplacebo: OpenCL kan inte RPU-omformningen – processorn (som förut)
  assert.ok(!r.dv5Ocl.filter[1].includes('tonemap_opencl') && r.dv5Ocl.filter[1].includes('zscale'));
  // libplacebo (Vulkan) före OpenCL – och för Dolby Vision 5 (färgrymden från RPU:n, inte setparams)
  assert.match(r.pl.filter[1], /hwupload,libplacebo=.*tonemapping=.*format=yuv420p,hwdownload,format=yuv420p$/);
  assert.deepEqual(r.pl.pre, ['-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk']);
  assert.match(r.dv5.filter[1], /libplacebo/);
  assert.ok(!r.dv5.filter[1].includes('colorspace=bt2020nc'), r.dv5.filter[1]);
  assert.ok(r.pl.enc.includes('bt709'), 'tonmappad bild märks BT.709');
  // tonemap_cuda (jellyfin-ffmpeg) först: bilderna lämnar aldrig kortet
  assert.match(r.cuda.filter[1], /scale_cuda=1920:1080:format=p010le,tonemap_cuda=/);
  assert.ok(!r.cuda.filter[1].includes('hwdownload'));
  assert.ok(r.av1.enc.includes('av1_nvenc') && !r.av1.enc.includes('hvc1'));
  assert.equal(r.av1.enc[r.av1.enc.indexOf('-maxrate') + 1], '2000k', '720p AV1: 4000 × 0,5');
  assert.equal(r.info.tonemap, 'tonemap_cuda'); assert.equal(r.info.dv5, true);
  assert.ok(r.x265.enc.includes('libx265') && !r.x265.dec && !r.x265.filter[1].includes('scale_cuda'), JSON.stringify(r.x265));
  assert.equal(r.pickCpu, 'hevc');
});

test('Intel/AMD (VA-API) och QSV: HEVC/AV1-kodarna och libplacebo i rätt kedja', () => {
  const v = withHw('vaapi', `
    st.vEnc.hw.hevc = 'hevc_vaapi'; st.vEnc.hw.av1 = 'av1_vaapi'; st.gpuPipe.vaapi = true;
    const d = { q: '1080', tonemap: true, mode: 'transcode', vc: 'hevc' };
    out.vpp = st._segs.videoArgs(hdr(), d, true);
    st.gpuTm.placeboVaapi = true; out.pl = st._segs.videoArgs(hdr(), d, true);
    out.av1 = st._segs.videoArgs({ ...hdr(), hdr: null }, { ...d, tonemap: false, vc: 'av1', q: 'orig' }, true);
    out.burn = st._segs.videoArgs(hdr(), { ...d, burn: 'e3' }, true);`);
  assert.match(v.vpp.filter[1], /^tonemap_vaapi=.*scale_vaapi=w=1920:h=1080:format=nv12$/, 'utan libplacebo: tonemap_vaapi som förut');
  assert.ok(v.vpp.enc.includes('hevc_vaapi') && v.vpp.enc.includes('hvc1'));
  assert.match(v.pl.filter[1], /scale_vaapi=w=1920:h=1080:format=p010,hwmap=derive_device=vulkan,libplacebo=.*format=nv12,hwmap=derive_device=vaapi:reverse=1,format=vaapi$/);
  assert.ok(v.pl.pre.includes('vulkan=vk@va') && v.pl.dec.includes('va'));
  assert.deepEqual(v.av1.enc.slice(0, 2), ['-c:v', 'av1_vaapi']);
  assert.ok(v.av1.enc.includes('-qp'), 'kvalitetsstyrd utan tak');
  // Inbränning: processorfilter, tonemap_vaapi efter uppladdningen som förut
  assert.ok(v.burn.filter[0] === '-filter_complex' && v.burn.filter[1].includes('tonemap_vaapi'));
  const q = withHw('qsv', `
    st.vEnc.hw.hevc = 'hevc_qsv'; st.gpuTm.placeboSw = true;
    out.pl = st._segs.videoArgs(hdr(), { q: '720', tonemap: true, mode: 'transcode', vc: 'hevc' }, true);
    out.dv5 = st._segs.videoArgs(hdr({ dovi: true, dvProfile: 5 }), { q: '720', tonemap: true, mode: 'transcode', vc: 'hevc' }, true);`);
  assert.match(q.pl.filter[1], /^scale=-2:720,setparams=.*hwupload,libplacebo=.*hwdownload,format=yuv420p,format=nv12$/);
  assert.deepEqual(q.pl.pre, ['-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk']);
  assert.ok(q.pl.enc.includes('hevc_qsv') && q.pl.enc.includes('-forced_idr'));
  assert.equal(q.dv5.tm, 'placeboSw');
});

t('HEIC-rutnät (som från iPhone) sätts ihop till hela bilden med ffmpeg 7.1', async () => {
  const img = await import('../server/imgsize.js');
  const { heicFromVersion } = await import('../server/exif.js');
  const g = img.heifGridGraph({ type: 'Tile Grid', components: [{ width: 1000, height: 700, horizontal_offset: 0, vertical_offset: 0,
    subcomponents: [0, 1, 2, 3].map(i => ({ stream_index: i, tile_horizontal_offset: (i % 2) * 512, tile_vertical_offset: (i >> 1) * 512 })) }] });
  assert.equal(g, '[0:0][0:1][0:2][0:3]xstack=inputs=4:layout=0_0|512_0|0_512|512_512,crop=1000:700:0:0');
  assert.equal(img.heifGridGraph({ type: 'Tile Grid', components: [{ width: 512, height: 300, subcomponents: [{ stream_index: 0, tile_horizontal_offset: 0, tile_vertical_offset: 0 }] }] }), '[0:0]crop=512:300:0:0');
  assert.equal(img.heifGridGraph({ type: 'IAMF Audio Element' }), null);
  assert.deepEqual(img.IROT_FILTER, { 1: 'transpose=2', 2: 'hflip,vflip', 3: 'transpose=1' });
  if (!heicFromVersion(execFileSync('ffmpeg', ['-hide_banner', '-version']).toString())) return; // ffmpeg < 7.1 läser inte HEIF
  // 1000×700 i fyra rutor om 512×512 (libheif), rött hörn uppe till vänster och blått nere till höger
  const src = path.join(dir, 'rutnat.heic');
  fs.copyFileSync(new URL('./fixtures/rutnat.heic', import.meta.url), src);
  const out = await img.sized(src, '320', Infinity, { sizes: img.PHOTO_SIZES, force: true, heif: true });
  assert.notEqual(out, src, 'en JPEG-variant gjordes');
  const v = probeJson(out)[0];
  assert.deepEqual([v.width, v.height], [320, 224], 'hela bilden, inte första rutan (512×512)');
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', 'scale=10:7:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const at = (x, y) => [...px.subarray((y * 10 + x) * 3, (y * 10 + x) * 3 + 3)];
  const [r1, g1, b1] = at(0, 0), [r2, g2, b2] = at(9, 6);
  assert.ok(r1 > 150 && g1 < 90 && b1 < 90, `uppe till vänster rött: ${at(0, 0)}`);
  assert.ok(b2 > 150 && r2 < 90 && g2 < 90, `nere till höger blått: ${at(9, 6)}`);
});
