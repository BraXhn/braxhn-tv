// Provet av hårdvaruomkodningen (server/hwprobe.js, Administration → Hårdvaruomkodning): tolkningen av ffmpegs
// felutskrift till åtgärder (verkliga felrader från NVENC, VAAPI och QSV – de utan hårdvara är fångade på en maskin
// utan grafikkort, övriga är de rader ffmpeg och drivrutinerna skriver enligt ffmpegs källkod och felrapporter),
// argumenten, rutten (bara administratör på hemnätet, svarets form, vägran när många strömmar omkodas), ett riktigt
// prov med processorn (libx264/libx265, ingen hårdvara behövs) och att resultatet hamnar i diagnostikpaketet.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-hwprobe-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = path.join(ROOT, 'media');
process.env.WATCH_FILES = '0';
process.env.TRANSCODE_PROBE = '0';
fs.mkdirSync(process.env.MEDIA_ROOT, { recursive: true });

const hw = await import('../server/hwprobe.js');
const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const diag = await import('../server/diagnostics.js');
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const LAN = { 'x-forwarded-for': '192.168.1.20' }, NET = { 'x-forwarded-for': '8.8.8.8' };
async function req(p, { method = 'GET', body, token, headers = LAN } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Felraderna ----------
const ADDR = '@ 0x55f128971480]';
const NV = {
  // Fångade här (ffmpeg 6.1, inget grafikkort): containern startad utan --runtime=nvidia
  noLib: `[h264_nvenc ${ADDR} Cannot load libcuda.so.1\n[vost#0:0/h264_nvenc ${ADDR} Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.\nError while filtering: Operation not permitted\n[out#0/null ${ADDR} Nothing was written into output file, because at least one of its streams received no packets.`,
  // NVIDIA_DRIVER_CAPABILITIES utan "video": ffmpeg skriver båda raderna (nvenc_load_libraries)
  caps: `[h264_nvenc ${ADDR} Cannot load libnvidia-encode.so.1\n[h264_nvenc ${ADDR} The minimum required Nvidia driver for nvenc is 520.56.06 or newer\n[vost#0:0/h264_nvenc ${ADDR} Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.`,
  old: `[hevc_nvenc ${ADDR} Driver does not support the required nvenc API version. Required: 12.1 Found: 11.1\n[hevc_nvenc ${ADDR} The minimum required Nvidia driver for nvenc is 530.41.03 or newer`,
  noDevice: `[AVHWDeviceContext ${ADDR} cu->cuInit(0) failed -> CUDA_ERROR_NO_DEVICE: no CUDA-capable device is detected\n[h264_nvenc ${ADDR} dl_fn->cuda_dl->cuInit(0) failed -> CUDA_ERROR_NO_DEVICE: no CUDA-capable device is detected`,
  mismatch: `[h264_nvenc ${ADDR} dl_fn->cuda_dl->cuInit(0) failed -> CUDA_ERROR_UNKNOWN: unknown error`,
  busy: `[h264_nvenc ${ADDR} OpenEncodeSessionEx failed: incompatible client key (21): (no details)\n[h264_nvenc ${ADDR} No capable devices found`,
  oom: `[h264_nvenc ${ADDR} OpenEncodeSessionEx failed: out of memory (10): (no details)`,
  tenBit: `[hevc_nvenc ${ADDR} 10 bit encode not supported\n[vost#0:0/hevc_nvenc ${ADDR} Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.`,
  noCap: `[h264_nvenc ${ADDR} No capable devices found`
};
const VA = {
  // Fångade här: ingen /dev/dri
  noDisplay: `[AVHWDeviceContext ${ADDR} No VA display found for device /dev/dri/renderD128.\nDevice creation failed: -22.\nFailed to set value '/dev/dri/renderD128' for option 'vaapi_device': Invalid argument\nError parsing global options: Invalid argument`,
  driver: `libva info: VA-API version 1.20.0\nlibva info: Trying to open /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so\nlibva info: va_openDriver() returns -1\n[AVHWDeviceContext ${ADDR} Failed to initialise VAAPI connection: -1 (unknown libva error).\nDevice creation failed: -5.`,
  main10: `[hevc_vaapi ${ADDR} No usable encoding entrypoint found for profile VAProfileHEVCMain10 (18).\n[vost#0:0/hevc_vaapi ${ADDR} Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.`
};
const QSV = {
  // Fångade här: ingen Intel-grafik
  session: `[h264_qsv ${ADDR} Error creating a MFX session: -9.\n[vost#0:0/h264_qsv ${ADDR} Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.\nError while filtering: Unknown error occurred`,
  device: `Device creation failed: -542398533.\nFailed to set value 'qsv=hw' for option 'init_hw_device': Generic error in an external library\nError parsing global options: Generic error in an external library`,
  profile: `[hevc_qsv ${ADDR} Current profile is unsupported\n[hevc_qsv ${ADDR} Error initializing the encoder: invalid video parameters (-15)`
};
const OK = { dri: 'ok', nvidia: true };

test('NVENC: varje vanligt fel får rätt åtgärd', () => {
  const e = (s, ctx = OK, codec = 'h264') => hw.explain('nvenc', codec, s, ctx).code;
  assert.equal(e(NV.noLib, { dri: 'missing', nvidia: false }), 'nv-not-visible', 'inget kort i containern');
  assert.equal(e(NV.noLib), 'nv-runtime', 'enheten finns men inte drivrutinen (--device utan --runtime=nvidia)');
  assert.equal(e(NV.caps), 'nv-caps', 'libnvidia-encode saknas går före "minimum required driver"');
  assert.equal(e(NV.old, OK, 'hevc'), 'nv-driver-old');
  assert.equal(e(NV.noDevice), 'nv-no-device');
  assert.equal(e(NV.mismatch), 'nv-mismatch');
  assert.equal(e(NV.busy), 'nv-busy');
  assert.equal(e(NV.oom), 'nv-busy');
  assert.equal(e(NV.tenBit, OK, 'hevc10'), 'format');
  assert.equal(e(NV.noCap), 'nv-unsupported');
});

test('VAAPI och QSV: /dev/dri saknas, behörighet, drivrutin, otillåten profil', () => {
  assert.equal(hw.explain('vaapi', 'h264', VA.noDisplay, { dri: 'missing' }).code, 'dri-missing');
  assert.equal(hw.explain('vaapi', 'h264', VA.noDisplay, { dri: 'denied' }).code, 'dri-denied', 'enheten finns men gruppen saknas');
  assert.equal(hw.explain('vaapi', 'h264', VA.noDisplay, { dri: 'ok' }).code, 'va-driver');
  assert.equal(hw.explain('vaapi', 'h264', VA.driver, { dri: 'ok' }).code, 'va-driver');
  assert.equal(hw.explain('vaapi', 'hevc10', VA.main10, { dri: 'ok' }).code, 'format');
  assert.equal(hw.explain('qsv', 'h264', QSV.session, { dri: 'ok' }).code, 'qsv-none');
  assert.equal(hw.explain('qsv', 'h264', QSV.device, { dri: 'ok' }).code, 'qsv-none');
  assert.equal(hw.explain('qsv', 'h264', QSV.session, { dri: 'missing' }).code, 'dri-missing');
  assert.equal(hw.explain('qsv', 'hevc10', QSV.profile, { dri: 'ok' }).code, 'format');
});

test('kodare som saknas, VideoToolbox, ffmpeg saknas, tidsgräns och okänt fel', () => {
  assert.deepEqual(hw.explain('nvenc', 'hevc', "[vost#0:0 @ 0x1] Unknown encoder 'hevc_nvenc'", OK), { code: 'no-encoder', encoder: 'hevc_nvenc' });
  assert.equal(hw.explain('videotoolbox', 'h264', 'Error opening output file -.\nError opening output files: Encoder not found').code, 'vt-only-mac');
  assert.equal(hw.explain('none', 'h264', 'spawn ffmpeg ENOENT').code, 'no-ffmpeg');
  assert.equal(hw.explain('vaapi', 'h264', 'timeout', { dri: 'ok' }).code, 'timeout');
  assert.equal(hw.explain('nvenc', 'h264', 'något helt annat', OK).code, 'unknown');
});

test('felraden: den som förklarar, inte följdfelen efter', () => {
  assert.equal(hw.keyLine(NV.noLib), `[h264_nvenc ${ADDR} Cannot load libcuda.so.1`);
  assert.equal(hw.keyLine(VA.noDisplay), `[AVHWDeviceContext ${ADDR} No VA display found for device /dev/dri/renderD128.`);
  assert.equal(hw.keyLine(QSV.session), `[h264_qsv ${ADDR} Error creating a MFX session: -9.`);
  assert.equal(hw.keyLine('Error opening output file -.\nError opening output files: Encoder not found'), 'Error opening output files: Encoder not found');
  assert.equal(hw.keyLine(''), '');
});

test('argumenten: genererad testbild, samma kodare som vid omkodning, 10 bitar med main10', () => {
  for (const m of hw.MODES) for (const c of hw.CODECS) {
    const a = hw.probeArgs(m, c, '1080p');
    assert.ok(a, `${m}/${c}`);
    assert.equal(a[a.indexOf('-f')], '-f');
    assert.match(a[a.indexOf('-i') + 1], /^testsrc2=s=1920x1080:/, 'bara lavfi, aldrig en fil');
    assert.equal(a[a.indexOf('-c:v') + 1], hw.encoderName(m, c));
    assert.deepEqual(a.slice(-3), ['-f', 'null', '-']);
    if (c === 'hevc10') assert.equal(a[a.indexOf('-profile:v') + 1], 'main10');
  }
  assert.match(hw.probeArgs('none', 'hevc10')[3], /yuv420p10le/);
  assert.match(hw.probeArgs('vaapi', 'h264').join(' '), /-vaapi_device \S+ .*-vf hwupload/);
  assert.match(hw.probeArgs('nvenc', 'h264', '2160p').join(' '), /3840x2160.*-preset p4/);
  assert.equal(hw.probeArgs('nvenc; rm -rf /', 'h264'), null);
  assert.equal(hw.probeArgs('none', 'av1'), null);
});

test('provet avbryts när strömmar börjar omkodas, och felande hårdvara ger förklaring med ffmpegs rad', { skip: !hasFfmpeg && 'ffmpeg saknas' }, async () => {
  // Processorns prov låtsas (snabbt); QSV körs på riktigt och misslyckas här utan Intel-grafik
  const run = (args) => args.includes('libx264') || args.includes('libx265') ? Promise.resolve({ ok: true, fps: 30 }) : hw.measure(args);
  let n = 0;
  const r = await hw.runProbe({ mode: 'qsv', run, busy: () => (n++ >= 4 ? 2 : 0) });
  assert.equal(r.mode, 'qsv');
  assert.deepEqual(r.aborted, { reason: 'busy', streams: 2 });
  assert.equal(r.results.length, 4, 'tre QSV-prov och ett med processorn innan det avbröts');
  for (const x of r.results.slice(0, 3)) {
    assert.equal(x.status, 'fail');
    assert.ok(x.line && x.log, 'ffmpegs rad följer med');
    assert.ok(['qsv-none', 'dri-missing', 'dri-denied', 'no-encoder'].includes(x.explanation.code), x.explanation.code);
  }
  assert.equal(r.results[3].status, 'cpu');
  assert.equal(r.results[3].skipped4k, 'slow', '30 bildrutor/s räcker inte för att prova 4K');
  assert.equal(r.gpuWorks, false);
  assert.deepEqual(hw.last(), r, 'sparat');
});

let tok;
test('rutten: bara administratör på hemnätet', async () => {
  D.run("INSERT INTO users(name,pass,is_admin,created,remote_allowed) VALUES('anna','x',1,0,1)");
  const uid = Number(D.run("INSERT INTO users(name,pass,is_admin,created,remote_allowed) VALUES('bertil','x',0,0,1)").lastInsertRowid);
  tok = auth.createSession(D.get("SELECT id FROM users WHERE name='anna'").id, 'app');
  const ut = auth.createSession(uid, 'app');
  for (const [method, body] of [['GET'], ['POST', { mode: 'none' }]]) {
    assert.equal((await req('/api/admin/hwprobe', { method, body })).status, 401, `${method} utan inloggning`);
    assert.equal((await req('/api/admin/hwprobe', { method, body, token: ut })).status, 403, `${method} som vanlig användare`);
    assert.equal((await req('/api/admin/hwprobe', { method, body, token: tok, headers: NET })).status, 403, `${method} utifrån`);
  }
  assert.equal(hw.state.running, false, 'inget prov startades');
  assert.equal((await req('/api/admin/hwprobe', { method: 'POST', token: tok, body: { mode: 'rm -rf' } })).status, 400);
});

test('rutten: vägrar och säger varför när många strömmar omkodas', async () => {
  hw.limits.busy = 0;
  try {
    const r = await req('/api/admin/hwprobe', { method: 'POST', token: tok, body: { mode: 'none' } });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /0 strömmar omkodas just nu – prova igen när färre tittar/);
    assert.equal((await req('/api/admin/hwprobe', { token: tok })).data.busyLimit, 0);
  } finally { hw.limits.busy = 2; }
  assert.equal(hw.state.running, false);
});

test('riktigt prov med processorn: hastighet per kodare, sparat med datum och i diagnostikpaketet', { skip: !hasFfmpeg && 'ffmpeg saknas', timeout: 120000 }, async () => {
  const start = await req('/api/admin/hwprobe', { method: 'POST', token: tok, body: { mode: 'none' } });
  assert.equal(start.status, 202);
  assert.equal(start.data.running, true);
  assert.equal(start.data.total, 3);
  assert.equal((await req('/api/admin/hwprobe', { method: 'POST', token: tok, body: { mode: 'none' } })).status, 409, 'ett prov i taget');
  let g;
  for (let i = 0; i < 120; i++) { await sleep(500); g = (await req('/api/admin/hwprobe', { token: tok })).data; if (!g.running) break; }
  assert.equal(g.running, false);
  const L = g.last;
  assert.equal(L.mode, 'none');
  assert.ok(Date.now() - Date.parse(L.at) < 120000, 'datum för provet');
  assert.deepEqual(L.results.map(x => [x.codec, x.encoder, x.status]), [['h264', 'libx264', 'cpu'], ['hevc', 'libx265', 'cpu'], ['hevc10', 'libx265', 'cpu']]);
  for (const x of L.results) {
    assert.ok(x.fps['1080p'] > 0, `${x.encoder}: ${JSON.stringify(x)}`);
    assert.equal(x.realtime['1080p'], +(x.fps['1080p'] / 25).toFixed(1));
    if (x.fps['1080p'] < 50) assert.equal(x.skipped4k, 'slow');
    else assert.ok(x.fps['2160p'] > 0 || x.skipped4k === 'failed');
  }
  console.log('# processorn:', L.results.map(x => `${x.codec} ${x.fps['1080p']} bilder/s i 1080p${x.fps['2160p'] ? `, ${x.fps['2160p']} i 4K` : ''}`).join(' · '));
  assert.equal(L.gpuWorks, false);
  // Diagnostikpaketet: hardware.json har senaste provet, och inget sparat är hemligt
  const pack = await diag.build();
  const hwj = JSON.parse(pack.files.find(f => f.name === 'hardware.json').text);
  assert.equal(hwj.probe.at, L.at);
  assert.deepEqual(hwj.probe.results.map(x => x.encoder), ['libx264', 'libx265', 'libx265']);
  assert.match(pack.files.find(f => f.name === 'README.txt').text, /senaste provet/);
});
