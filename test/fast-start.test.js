// Snabbare start: nyckelbilder ur filens index, bildundertexter (PGS) utan inbränning, korta startsegment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-fast-'));
process.env.TRANSCODE_DIR = path.join(process.env.CONFIG_DIR, 'tc');
const kfm = await import('../server/keyframes.js');
const pgs = await import('../server/pgs.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-fastm-'));

const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
const probeKf = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', f])
  .toString().split('\n').map(l => l.split(',')).filter(([, fl]) => fl && fl[0] === 'K').map(([t]) => +t).sort((a, b) => a - b);

test('nyckelbilder ur MKV-index och MP4-tabeller stämmer med ffprobe', async () => {
  const mkv = path.join(dir, 'a.mkv'), mp4 = path.join(dir, 'a.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=24:d=60', '-f', 'lavfi', '-i', 'sine=d=60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '40', '-bf', '2', '-c:a', 'aac', mkv);
  ff('-i', mkv, '-c', 'copy', mp4);
  for (const f of [mkv, mp4]) {
    const r = await kfm.fastKeyframes(f, 60);
    const ref = probeKf(f);
    assert.ok(r, f);
    assert.equal(r.complete, true);
    assert.equal(r.kf.length, ref.length, f);
    ref.forEach((t, i) => assert.ok(Math.abs(t - r.kf[i]) < 0.002, `${f}: ${t} ≠ ${r.kf[i]}`));
  }
  // Annat format eller trasig fil: ingen snabb väg (ffprobe används i stället)
  const bad = path.join(dir, 'bad.mkv');
  fs.writeFileSync(bad, Buffer.concat([fs.readFileSync(mkv).subarray(0, 4000)]));
  assert.equal(await kfm.fastKeyframes(bad, 60), null);
  fs.writeFileSync(bad, 'inte en film');
  assert.equal(await kfm.fastKeyframes(bad, 60), null);
});

test('EBML-huvud: okänd storlek och trasiga data', () => {
  assert.deepEqual(kfm.ebmlHeader(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x81]), 0), { id: 0x1a45dfa3, size: 1, data: 5 });
  assert.equal(kfm.ebmlHeader(Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0).size, -1);
  assert.equal(kfm.ebmlHeader(Buffer.from([0x00, 0x00]), 0), null);
  assert.equal(kfm.ebmlHeader(Buffer.from([0x1a]), 0), null);
});

// Bygger en minimal PGS-ström: en visning (rött block) vid 1 s som tas bort vid 3 s
function seg(type, pts, body) {
  const h = Buffer.alloc(13);
  h.write('PG', 0, 'latin1'); h.writeUInt32BE(Math.round(pts * 90000), 2); h[10] = type; h.writeUInt16BE(body.length, 11);
  return Buffer.concat([h, body]);
}
function sup() {
  const pcs = (pts, objs, state) => {
    const b = Buffer.alloc(11 + objs * 8);
    b.writeUInt16BE(1920, 0); b.writeUInt16BE(1080, 2); b[4] = 0x10; b.writeUInt16BE(1, 5); b[7] = state; b[8] = 0; b[9] = 0; b[10] = objs;
    if (objs) { b.writeUInt16BE(0, 11); b[13] = 0; b[14] = 0; b.writeUInt16BE(100, 15); b.writeUInt16BE(900, 17); }
    return seg(0x16, pts, b);
  };
  const wds = (pts) => { const b = Buffer.alloc(10); b[0] = 1; b[1] = 0; b.writeUInt16BE(100, 2); b.writeUInt16BE(900, 4); b.writeUInt16BE(8, 6); b.writeUInt16BE(2, 8); return seg(0x17, pts, b); };
  // Palett 0: index 1 = rött (BT.709: Y=63 Cr=240 Cb=102), helt synligt
  const pds = seg(0x14, 1, Buffer.from([0, 0, 1, 63, 240, 102, 255]));
  // 8×2 bildpunkter: rad 1 = 8 st färg 1, rad 2 = 4 st färg 1 + 4 genomskinliga
  const rle = Buffer.from([0x00, 0x88, 0x01, 0x00, 0x00, 0x00, 0x84, 0x01, 0x00, 0x04, 0x00, 0x00]);
  const ods = Buffer.alloc(11); ods.writeUInt16BE(0, 0); ods[2] = 0; ods[3] = 0xc0; ods.writeUIntBE(rle.length + 4, 4, 3); ods.writeUInt16BE(8, 7); ods.writeUInt16BE(2, 9);
  return Buffer.concat([pcs(1, 1, 0x80), wds(1), pds, seg(0x15, 1, Buffer.concat([ods, rle])), seg(0x80, 1, Buffer.alloc(0)),
    pcs(3, 0, 0), wds(3), seg(0x80, 3, Buffer.alloc(0))]);
}

test('PGS: tolkning, RLE och PNG', () => {
  const cues = [], clears = [];
  const p = new pgs.PgsParser({ onCue: (c) => cues.push(c), onClear: (t) => clears.push(t) });
  const data = sup();
  // i små bitar – segment delas mellan anrop
  for (let i = 0; i < data.length; i += 7) p.push(data.subarray(i, i + 7));
  assert.equal(cues.length, 1);
  assert.equal(cues[0].s, 1);
  assert.deepEqual(clears, [1, 3]);
  const it = cues[0].items[0];
  assert.deepEqual([it.x, it.y, it.w, it.h], [100, 900, 8, 2]);
  assert.deepEqual([...it.png.subarray(1, 4)].map(c => String.fromCharCode(c)).join(''), 'PNG');
  assert.deepEqual([...pgs.rle(Buffer.from([0x00, 0x88, 0x01, 0x00, 0x00]), 8, 1)], [1, 1, 1, 1, 1, 1, 1, 1]);
  // Trasiga data kastar inte
  assert.doesNotThrow(() => pgs.rle(Buffer.from([0x00, 0xc0]), 4, 4));
  assert.doesNotThrow(() => new pgs.PgsParser({ onCue() {}, onClear() {} }).push(Buffer.from('PGxxxxxxxxx\x16\x00\x05abc')));
});

test('PGS: spår i MKV läses i bakgrunden och visas som bilder', async () => {
  const supF = path.join(dir, 'a.sup'), mkv = path.join(dir, 'pgs.mkv');
  fs.writeFileSync(supF, sup());
  ff('-copyts', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=24:d=5', '-i', supF, '-map', '0', '-map', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:s', 'copy', mkv);
  const it = { id: 991, mtime: 1, path: mkv };
  const sub = { id: 'e1' };
  let j = pgs.job(it, sub); j.reader.want(0);
  for (let k = 0; k < 100 && !j.done; k++) await new Promise(r => setTimeout(r, 50));
  assert.equal(j.done, true); assert.equal(j.error, null);
  assert.equal(j.cues.length, 1);
  assert.ok(Math.abs(j.cues[0].s - 1) < 0.01 && Math.abs(j.cues[0].e - 3) < 0.01, JSON.stringify(j.cues));
  // Bilden går att hämta och är en PNG
  const res = { head: null, body: null, writeHead(c, h) { this.head = [c, h]; }, end(b) { this.body = b; }, setHeader() {} };
  pgs.serveImage({ method: 'GET' }, res, it, sub, j.cues[0].i[0][4]);
  assert.equal(res.head[0], 200);
  assert.equal(res.body.subarray(1, 4).toString('latin1'), 'PNG');
  // Från cachen nästa gång
  const c = pgs.job({ ...it }, sub);
  assert.equal(c.done, true); assert.equal(c.cues.length, 1);
});

test('fientliga filer: MP4 som utlovar miljontals bilder låser inte servern', async () => {
  const box = (t, ...b) => { const body = Buffer.concat(b); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(t, 4, 'latin1'); return Buffer.concat([h, body]); };
  const u32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4)); return b; };
  const moov = box('moov', box('trak', box('mdia', box('hdlr', u32(0, 0), Buffer.from('vide'), Buffer.alloc(12)), box('mdhd', u32(0, 0, 0, 1000, 0)),
    box('minf', box('stbl', box('stts', u32(0, 1, 4_999_999, 1)))))));
  const f = path.join(dir, 'bomb.mp4');
  fs.writeFileSync(f, Buffer.concat([box('ftyp', Buffer.from('isom'), u32(0)), moov]));
  const t0 = Date.now();
  assert.equal(await kfm.fastKeyframes(f, 100), null);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

test('hårdvarufel ger en begriplig åtgärd', async () => {
  const st = await import('../server/stream.js');
  assert.match(st.hwHint('[h264_nvenc @ 0x1] Cannot load libcuda.so.1'), /--runtime=nvidia/);
  assert.match(st.hwHint('Driver does not support the required nvenc API version. Required: 12.1 Found: 11.0'), /för gammal/);
  assert.match(st.hwHint('OpenEncodeSessionEx failed: out of memory (10)'), /samtidiga/);
  assert.equal(st.hwHint('något helt annat'), null);
});

test('segment långt bakom uppspelningen tas bort utan att servern tappar bort var den är', async () => {
  const st = await import('../server/stream.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-trim-'));
  const s = { dir: d, d: { fmt: 'ts' }, start: 0, hi: null };
  const f = (k) => path.join(d, `seg_${String(k).padStart(5, '0')}.ts`);
  for (let k = 0; k <= 60; k++) fs.writeFileSync(f(k), 'x');
  st._segs.trimBehind(s, 50);
  assert.ok(!fs.existsSync(f(0)) && !fs.existsSync(f(20)) && fs.existsSync(f(21)));
  assert.equal(st._segs.highestFile(s), 60);
  // Nästa segment ännu inte klart efter rensning av allt bakåt
  for (let k = 21; k <= 60; k++) fs.rmSync(f(k));
  s.hi = null; s.trimmed = 60;
  assert.equal(st._segs.highestFile(s), 60);
});

test('undertext läses där tittaren är först, sedan resten', async () => {
  const { SubReader, vttParser } = await import('../server/subreader.js');
  const srt = path.join(dir, 'lang.srt'), mkv = path.join(dir, 'lang.mkv');
  const t = (s) => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
  fs.writeFileSync(srt, [5, 100, 200, 290].map((s, i) => `${i + 1}\n${t(s)} --> ${t(s + 2)}\nRad ${s}\n`).join('\n'));
  ff('-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=300', '-i', srt, '-map', '0', '-map', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-c:s', 'srt', mkv);
  const cues = [], order = [];
  let complete = false;
  const r = new SubReader({ file: mkv, stream: 1, format: 'webvtt', duration: 300,
    parser: () => vttParser((c) => { if (!cues.some(x => x.s === c.s)) { cues.push(c); order.push(c.s); } }),
    onComplete: () => { complete = true; }, onError: (m) => { throw new Error(m); } });
  r.want(195);
  for (let k = 0; k < 200 && !complete; k++) await new Promise(res => setTimeout(res, 50));
  assert.equal(complete, true);
  assert.deepEqual(cues.map(c => c.s).sort((a, b) => a - b), [5, 100, 200, 290]);
  assert.equal(order[0], 200, `ordning ${order}`); // tittarens position först
  assert.equal(cues.find(c => c.s === 200).text, 'Rad 200');
  r.close();
});

test('pågående jobb listas med förlopp och försvinner när de är klara', async () => {
  const jobs = await import('../server/jobs.js');
  const h = jobs.track('download', 'Laddar ner: test', { total: 4 });
  h.update(1);
  const j = jobs.list().find(x => x.title === 'Laddar ner: test');
  assert.equal(j.progress, 0.25);
  h.end(); h.end();
  assert.ok(!jobs.list().some(x => x.title === 'Laddar ner: test'));
  await assert.rejects(jobs.tracked('x', 'Fel', async () => { throw new Error('nej'); }));
  assert.ok(!jobs.list().some(x => x.title === 'Fel'));
});

test('inloggning: "Håll mig inloggad" ger 30 dagar, annars en sessionskaka', async () => {
  const auth = await import('../server/auth.js');
  assert.match(auth.cookieHeader('a'.repeat(64), false, true), /Max-Age=2592000/);
  assert.doesNotMatch(auth.cookieHeader('a'.repeat(64), false, false), /Max-Age/);
  const { run, get } = await import('../server/db.js');
  const uid = Number(run(`INSERT INTO users(name,pass,created) VALUES('rem${Date.now()}','x',1)`).lastInsertRowid);
  const keep = auth.createSession(uid, 'web', { remember: true }), short = auth.createSession(uid, 'web', { remember: false });
  const exp = (t) => get('SELECT expires - created AS d, remember FROM sessions WHERE token=?', auth.sha(t));
  assert.deepEqual({ ...exp(keep) }, { d: 30 * 86400, remember: 1 });
  assert.deepEqual({ ...exp(short) }, { d: 12 * 3600, remember: 0 });
});

test('förhandsbilder: hopp till en nyckelbild per intervall (även apostrof i filnamnet)', async () => {
  const st = await import('../server/stream.js');
  const trick = await import('../server/trickplay.js');
  const f = path.join(dir, "Tom's film.mkv");
  ff('-f', 'lavfi', '-i', 'testsrc=s=320x180:r=24:d=125', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', f);
  const it = { id: 4242, mtime: 1, path: f, duration: 125, vcodec: 'h264', streams: JSON.stringify([{ type: 'video', width: 320, height: 180 }]) };
  assert.ok((await st.computeKeyframes(it))?.length > 10);
  await trick.generate(it);
  const inf = trick.info(it);
  assert.equal(inf.count, 13); // 0, 10 … 120 s
  assert.equal(inf.sheets, 1);
  assert.ok(trick.sprite(it, 1));
  // Ett blad med 10×10 rutor (240×136 var)
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', trick.sprite(it, 1)]).toString().trim().split(',').map(Number);
  assert.equal(w, 2400); assert.equal(h, 1360);
});

test('kvalitet utanför hemmet efter uppmätt bandbredd och "Spara data"', async () => {
  const { remoteQuality } = await import('../server/routes/playback.js');
  assert.equal(remoteQuality('1080', 0, false), '1080');
  assert.equal(remoteQuality('1080', 50000, false), '1080');
  assert.equal(remoteQuality('1080', 7000, false), '720');   // 4 Mbit/s ryms i 5,25
  assert.equal(remoteQuality('1080', 2500, false), '480');
  assert.equal(remoteQuality('1080', 800, false), '360');
  assert.equal(remoteQuality('720', 50000, false), '720');   // aldrig över inställningen
  assert.equal(remoteQuality('1080', 50000, true), '480');   // spara data
  assert.equal(remoteQuality('orig', 40000, false), 'orig');
  assert.equal(remoteQuality('orig', 9000, false), '720');
});

test('HDR-källa som omkodas tonmappas även för en HDR-skärm (H.264 i 8 bitar kan inte bära HDR)', async () => {
  const st = await import('../server/stream.js');
  const it = { id: 77, path: '/x/Film.mkv', size: 60e9, duration: 7200, hdr: 'hdr10', vcodec: 'hevc',
    streams: JSON.stringify([{ index: 0, type: 'video', codec: 'hevc', width: 3840, height: 2160, pix: 'yuv420p10le' }, { index: 1, type: 'audio', codec: 'eac3', channels: 6, default: true }]) };
  const caps = st.parseCaps(new URLSearchParams({ c: 'mp4', v: 'h264,hevc', a: 'aac,ac3,eac3', hdr: '1', q: '360', nhls: '1' }));
  const d = st.decide(it, { ...caps, assumeKf: true, remote: true });
  assert.equal(d.mode, 'transcode');
  assert.equal(d.tonemap, true);
  assert.equal(d.audioMode, 'aac'); assert.equal(d.ab, 128);
  // Remux (ingen omkodning) behåller HDR för en HDR-skärm
  const r = st.decide(it, { ...st.parseCaps(new URLSearchParams({ c: 'mp4', v: 'h264,hevc', a: 'aac,eac3', hdr: '1' })), assumeKf: true });
  assert.equal(r.mode, 'remux'); assert.equal(r.tonemap, false);
});

test('tonmappning fungerar även när bilderna saknar färginformation (som efter GPU-avkodning)', async () => {
  const st = await import('../server/stream.js');
  const src = path.join(dir, 'hdr.mkv');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=2', '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', src);
  const it = { path: src, hdr: 'hdr10', streams: JSON.stringify([{ type: 'video', width: 640, height: 360, pix: 'yuv420p10le' }]) };
  const va = st._segs.videoArgs(it, { q: '360', tonemap: true, burn: '' }, true);
  const vf = va.filter[1];
  const out = path.join(dir, 'tm.mp4');
  // Färginformationen tas bort före kedjan, som när NVDEC avkodar
  ff('-i', src, '-vf', 'setparams=color_trc=unknown:color_primaries=unknown:colorspace=unknown,' + vf, '-c:v', 'libx264', '-preset', 'ultrafast', out);
  const p = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=color_transfer,pix_fmt', '-of', 'csv=p=0', out]).toString().trim();
  assert.equal(p, 'yuv420p,bt709');
});

test('HEVC i fMP4: initsegmentet får Apples tagg även när ffmpeg skrev hev1', async (t) => {
  const st = await import('../server/stream.js');
  const src = path.join(dir, 'hev1.mp4');
  try { ff('-f', 'lavfi', '-i', 'testsrc2=s=128x72:r=24:d=1', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hev1', '-movflags', '+frag_keyframe+empty_moov', '-frames:v', '1', src); }
  catch { return t.skip('libx265 saknas'); }
  const moov = fs.readFileSync(src);
  const tag = (b) => { const f = path.join(dir, 'tagged.mp4'); fs.writeFileSync(f, b);
    return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_tag_string,codec_name', '-of', 'csv=p=0', f]).toString().trim(); };
  assert.equal(tag(moov), 'hevc,hev1');
  assert.equal(tag(st.hevcTag(Buffer.from(moov), 'dvh1')), 'hevc,dvh1');
  assert.equal(tag(st.hevcTag(Buffer.from(moov), 'hvc1')), 'hevc,hvc1');
  // hvcC: alla parameteruppsättningar markerade som kompletta
  const b = st.hevcTag(Buffer.from(moov), 'hvc1'), c = b.indexOf('hvcC') + 4;
  let q = c + 23;
  for (let i = 0; i < b[c + 22]; i++) { assert.ok(b[q] & 0x80, `array ${i} komplett`); const n = b.readUInt16BE(q + 1); q += 3; for (let j = 0; j < n; j++) q += 2 + b.readUInt16BE(q); }
  // ljud och annat lämnas orört
  const aac = path.join(dir, 'aac.mp4');
  ff('-f', 'lavfi', '-i', 'sine=d=0.2', '-c:a', 'aac', aac);
  assert.deepEqual(st.hevcTag(fs.readFileSync(aac), 'dvh1'), fs.readFileSync(aac));
});

test('omkodning: hela kedjan på grafikkortet när testet vid start lyckats, annars processorfilter', () => {
  // Egen process: HWACCEL läses när stream.js laddas. Testet vid start (ingen GPU här) hinner inte stänga av hårdvaran.
  const code = `const st = await import(${JSON.stringify(new URL('../server/stream.js', import.meta.url).href)});
    const it = { id: 1, hdr: null, streams: JSON.stringify([{ type: 'video', index: 0, codec: 'hevc', pix: 'yuv420p10le', width: 3840, height: 2160 }]) };
    const d = { q: '1080', tonemap: false, mode: 'transcode' };
    const out = {};
    out.cpu = st._segs.videoArgs(it, d, true);
    st.gpuPipe.cuda = st.gpuPipe.cudaTm = true;
    out.gpu = st._segs.videoArgs(it, d, true);
    out.gpuHdr = st._segs.videoArgs({ ...it, hdr: 'hdr10' }, { ...d, tonemap: true }, true);
    out.burn = st._segs.videoArgs(it, { ...d, burn: 's3' }, true);
    console.log(JSON.stringify(out)); process.exit(0);`;
  const env = { ...process.env, HWACCEL: 'nvenc', CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-gpu-')), TRANSCODE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-gpu-tc-')) };
  const r = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { env }).toString().trim().split('\n').pop());
  // Utan GPU-kedja: avkodning på kortet men skalning med processorn
  assert.ok(!r.cpu.dec && r.cpu.filter[1].includes('scale=-2:1080') && !r.cpu.filter[1].includes('scale_cuda'));
  // Med: bilderna stannar på kortet, skalas dit i 8 bitar och bredden räknas ut (16:9)
  assert.deepEqual(r.gpu.dec, ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']);
  assert.equal(r.gpu.filter[1], 'scale_cuda=1920:1080:format=nv12');
  assert.ok(r.gpu.enc.includes('h264_nvenc'));
  // HDR: skalas ner på kortet i 10 bitar, tonmappas sedan (på den mindre bilden) och märks BT.709
  assert.match(r.gpuHdr.filter[1], /^scale_cuda=1920:1080:format=p010le,hwdownload,format=p010le,setparams=.*tonemap=/);
  assert.ok(r.gpuHdr.enc.includes('bt709'));
  // Inbränd bildundertext: processorfilter som förut
  assert.ok(!r.burn.dec && r.burn.filter[0] === '-filter_complex');
});
