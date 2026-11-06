// Snabbstart vid fortsättning mitt i filen: platsen där man slutade titta ligger i startcachen, och remuxen som
// börjar där läser den via den sökbara adressen på loopback (prestart.seekableInput) – inte originalfilen. Disken
// "sover" i testet: originalfilen går inte att öppna medan första segmentet tas fram. Kräver ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-presres-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.PRESTART_DIR = path.join(ROOT, 'ssd');
process.env.PRESTART_SECONDS = '10';
fs.mkdirSync(path.join(MEDIA, 'Filmer'), { recursive: true });
fs.mkdirSync(process.env.PRESTART_DIR, { recursive: true });
const FILM = path.join(MEDIA, 'Filmer', 'Fortsatt Film (2020).mkv');
if (hasFfmpeg) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '120',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2000k', '-x264-params', 'keyint=48:min-keyint=12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', FILM]);

const D = await import('../server/db.js');
const sc = await import('../server/scanner.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const pre = await import('../server/prestart.js');
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

t('demuxern väljs efter containern, och bara säkra demuxrar', () => {
  assert.equal(pre.demuxerFor('matroska,webm'), 'matroska');
  assert.equal(pre.demuxerFor('mov,mp4,m4a,3gp,3g2,mj2'), 'mov');
  assert.equal(pre.demuxerFor('mpegts'), 'mpegts');
  for (const x of ['hls', 'concat', 'avi', 'mpeg', '', null]) assert.equal(pre.demuxerFor(x), null, String(x));
});

t('fortsättning mitt i filen: remuxen läser platsen ur startcachen medan disken sover', async () => {
  const U = Number(D.run('INSERT INTO users(name,pass,is_admin,created) VALUES(?,?,1,0)', 'anna', await auth.hashPw('Fortsätt-test-2026!')).lastInsertRowid);
  const tok = auth.createSession(U, 'app');
  const LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", path.join(MEDIA, 'Filmer')).lastInsertRowid);
  await sc.scan(LIB);
  const it = D.get('SELECT * FROM items WHERE path=?', FILM);
  assert.ok(it?.duration > 110, 'filmen skannad');
  // Fortsätt titta vid 70 s: startcachen får början, platsen (20 s före, 10 s efter) och slutet (Cues)
  D.run('INSERT INTO progress(user_id,item_id,position,watched,updated) VALUES(?,?,70,0,?)', U, it.id, Math.floor(Date.now() / 1000));
  await pre.tick({ force: true });
  const info = pre.info();
  assert.equal(info.entries, 1, JSON.stringify(info));
  assert.ok(info.used < it.size * 0.6, 'inte hela filen – annars prövar testet inget');
  pre.start(); // den interna adressen
  for (let i = 0; i < 50 && !pre.seekableInput(it, 70); i++) await sleep(20);
  const si = pre.seekableInput(it, 70);
  assert.ok(si, 'sökbar indata för platsen i cachen');
  assert.match(si.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{36}$/); assert.equal(si.format, 'matroska');
  assert.equal(pre.seekableInput(it, 30), null, 'platsen utanför cachen: originalfilen som förut');
  // Den interna adressen: Range och fel nyckel
  const r = await fetch(si.url, { headers: { range: 'bytes=0-15' } });
  assert.equal(r.status, 206); assert.equal(Buffer.from(await r.arrayBuffer()).length, 16);
  assert.equal((await fetch(si.url.replace(/[0-9a-f]{36}$/, 'f'.repeat(36)))).status, 404);

  // Disken sover: originalfilen går inte att öppna (snabbstartens egna läsningar) – och ffmpeg får inte läsa den
  const realOpen = pre.io.open;
  let origOpens = 0;
  pre.io.open = async () => { origOpens++; throw Object.assign(new Error('disken sover'), { code: 'EIO' }); };
  const moved = FILM + '.sover';
  fs.renameSync(FILM, moved);
  try {
    const A = { authorization: 'Bearer ' + tok };
    const pb = await (await fetch(`${B}/api/items/${it.id}/playback?start=70&force=hls`, { headers: A })).json();
    assert.equal(pb.mode, 'remux', (pb.reasons || []).join(', '));
    const idx = new URL(pb.url.replace('master.m3u8', 'index.m3u8'), B);
    const pl = await (await fetch(idx, { headers: A })).text();
    // Segmentet där 70 s ligger
    let acc = 0, n = -1, k = 0;
    for (const m of pl.matchAll(/#EXTINF:([\d.]+)/g)) { if (acc <= 70) n = k; acc += +m[1]; k++; }
    assert.ok(n > 3, 'mitt i filen');
    const t0 = Date.now();
    const seg = await fetch(new URL(idx.pathname.replace('index.m3u8', `seg-${n}.ts`) + idx.search, B), { headers: A });
    assert.equal(seg.status, 200, `segmentet ur cachen (${Date.now() - t0} ms)`);
    const buf = Buffer.from(await seg.arrayBuffer());
    assert.ok(buf.length > 10000);
    // Bilderna går att avkoda och börjar där segmentet ska börja
    const f = path.join(ROOT, 'seg.ts'); fs.writeFileSync(f, buf);
    const pts = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', f]).toString().trim().split(/\s+/)[0]);
    assert.ok(pts > 60 && pts <= 71, `första bilden vid ${pts} s`);
  } finally {
    fs.renameSync(moved, FILM);
    pre.io.open = realOpen;
  }
});
