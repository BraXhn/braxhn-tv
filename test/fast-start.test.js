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
  let j = pgs.job(it, sub);
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
