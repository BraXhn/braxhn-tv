// M4A/M4B med moov först (server/moovfirst.js): filer som ffmpeg och många rippare skriver med indexet sist skickas med
// indexet först, utan omslag i taggarna och med samma ljud bit för bit. Det som inte ska röras skickas som förut (null).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { analyze, servePlan, planFor, _cacheInfo } from '../server/moovfirst.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-moov-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const f = (n) => path.join(ROOT, n);
const top = (b) => { const o = []; for (let p = 0; p + 8 <= b.length;) { let n = b.readUInt32BE(p); if (n === 1) n = Number(b.readBigUInt64BE(p + 8)); o.push(b.toString('latin1', p + 4, p + 8)); if (n < 8) break; p += n; } return o; };
/** Hela den omskrivna filen enligt planen */
async function render(file, plan) {
  const srv = http.createServer((q, r) => servePlan(q, r, file, plan, { 'Content-Type': 'audio/mp4' })).listen(0);
  await new Promise(r => srv.on('listening', r));
  try { return Buffer.from(await (await fetch(`http://127.0.0.1:${srv.address().port}/`)).arrayBuffer()); } finally { srv.close(); }
}
const pcm = (file) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-map', '0:a', '-f', 's16le', '-'], { maxBuffer: 64 << 20 });
const opt = { skip: !hasFfmpeg && 'ffmpeg saknas' };

test('moov sist: moov först, samma ljud, omslaget borta, övriga taggar kvar', opt, async () => {
  ff('-f', 'lavfi', '-i', 'nullsrc=s=300x300,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '2', f('pic.jpg'));
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=5', '-i', f('pic.jpg'), '-map', '0', '-map', '1', '-c:a', 'aac', '-b:a', '128k', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-metadata', 'title=Låten', '-metadata', 'artist=Någon', f('sist.m4a'));
  const orig = fs.readFileSync(f('sist.m4a'));
  assert.deepEqual(top(orig).filter(x => x === 'moov' || x === 'mdat'), ['mdat', 'moov']);
  const plan = await analyze(f('sist.m4a'), orig.length);
  assert.ok(plan, 'planen');
  const out = await render(f('sist.m4a'), plan);
  assert.equal(out.length, plan.size);
  assert.deepEqual(top(out).filter(x => x === 'moov' || x === 'mdat'), ['moov', 'mdat']);
  assert.ok(out.length < orig.length - 30e3, 'omslaget borta');
  fs.writeFileSync(f('ut.m4a'), out);
  assert.ok(pcm(f('ut.m4a')).equals(pcm(f('sist.m4a'))), 'samma ljud');
  const tags = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream=codec_type', '-of', 'json', f('ut.m4a')]));
  assert.equal(tags.format.tags.title, 'Låten'); assert.equal(tags.format.tags.artist, 'Någon');
  assert.deepEqual(tags.streams.map(s => s.codec_type), ['audio'], 'bara ljudet (omslaget var en bildström)');
});

test('ljudbok (M4B) med kapitel: alla spårens adresser flyttas', opt, async () => {
  fs.writeFileSync(f('kap.txt'), ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=3000\ntitle=Ett\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=3000\nEND=6000\ntitle=Två\n');
  ff('-f', 'lavfi', '-i', 'sine=f=300:d=6', '-i', f('kap.txt'), '-map_metadata', '1', '-map_chapters', '1', '-c:a', 'aac', '-b:a', '64k', '-f', 'mp4', f('bok.m4b'));
  const st = fs.statSync(f('bok.m4b'));
  const plan = await analyze(f('bok.m4b'), st.size);
  assert.ok(plan, 'planen');
  const out = await render(f('bok.m4b'), plan);
  fs.writeFileSync(f('bok2.m4b'), out);
  assert.equal(top(out).indexOf('moov') < top(out).indexOf('mdat'), true);
  const ch = (x) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', x])).chapters.map(c => [c.start_time, c.tags?.title]);
  assert.deepEqual(ch(f('bok2.m4b')), ch(f('bok.m4b')));
  assert.deepEqual(ch(f('bok2.m4b')).map(c => c[1]), ['Ett', 'Två']);
  assert.ok(pcm(f('bok2.m4b')).equals(pcm(f('bok.m4b'))));
});

test('skickas som förut: moov först utan omslag, fragmenterad MP4, inte MP4', opt, async () => {
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:a', 'aac', '-movflags', '+faststart', f('forst.m4a'));
  assert.equal(await analyze(f('forst.m4a'), fs.statSync(f('forst.m4a')).size), null);
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', f('frag.m4a'));
  assert.equal(await analyze(f('frag.m4a'), fs.statSync(f('frag.m4a')).size), null);
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=2', f('x.mp3'));
  assert.equal(await analyze(f('x.mp3'), fs.statSync(f('x.mp3')).size), null);
  fs.writeFileSync(f('trasig.m4a'), fs.readFileSync(f('sist.m4a')).subarray(0, 5000)); // avklippt: moov saknas
  assert.equal(await analyze(f('trasig.m4a'), 5000), null);
});

test('moov först med omslag: omslaget tas bort, moov stannar först', opt, async () => {
  ff('-i', f('sist.m4a'), '-map', '0', '-c', 'copy', '-movflags', '+faststart', f('forst-bild.m4a'));
  const st = fs.statSync(f('forst-bild.m4a'));
  const plan = await analyze(f('forst-bild.m4a'), st.size);
  assert.ok(plan && plan.size < st.size - 30e3);
  const out = await render(f('forst-bild.m4a'), plan);
  fs.writeFileSync(f('ut2.m4a'), out);
  assert.ok(pcm(f('ut2.m4a')).equals(pcm(f('sist.m4a'))));
});

test('planen cachas i minnet efter fil, storlek och ändringstid', opt, async () => {
  const st = fs.statSync(f('sist.m4a'));
  const a = planFor(f('sist.m4a'), st), b = planFor(f('sist.m4a'), st);
  assert.equal(a, b);
  await a;
  assert.ok(_cacheInfo().bytes > 0);
  assert.notEqual(planFor(f('sist.m4a'), { ...st, mtimeMs: st.mtimeMs + 1 }), a, 'ändrad fil analyseras igen');
});
