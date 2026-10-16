// Timeshift i live-TV (spellista, disktak, idle-städning) och reklamdetektering i inspelningar. Kräver ffmpeg för delarna med filer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-ts-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.DVR_DIR = path.join(ROOT, 'rec');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const ts = await import('../server/timeshift.js');
const cs = await import('../server/comskip.js');
const { setSetting } = await import('../server/db.js');
let srv, base;
const open = new Set();

/** Testfil av bitar: [typ, sekunder] där typ är 'show' (färg + ton), 'black' (svart + tyst), 'quiet' (färg + tyst) eller 'dark' (svart + ton) */
function makeClip(file, pieces) {
  const parts = [], labels = [];
  pieces.forEach(([kind, d], i) => {
    const col = kind === 'black' || kind === 'dark' ? 'black' : ['red', 'green', 'blue', 'yellow', 'white'][i % 5];
    parts.push(`color=c=${col}:s=160x90:r=5:d=${d}[v${i}]`);
    parts.push(`sine=f=${300 + i * 40}:d=${d}:sample_rate=22050${kind === 'black' || kind === 'quiet' ? ',volume=0' : ''}[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-filter_complex', parts.join(';') + ';' + labels.join('') + `concat=n=${pieces.length}:v=1:a=1[v][a]`,
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', file]);
}

before(async () => {
  if (!hasFfmpeg) return;
  // 60 s H.264 som "IPTV-kanal". Servern skickar filen men stänger aldrig anslutningen – som en direktsändning,
  // så att ffmpeg fortsätter vänta på mer i stället för att avsluta.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=500',
    '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', path.join(ROOT, 'ch.ts')]);
  srv = http.createServer((q, r) => {
    if (q.url === '/list.m3u') return r.end(`#EXTM3U\n#EXTINF:-1,Kanal Ett\n${base}/ch.ts\n`);
    if (q.url === '/ch.ts') { r.writeHead(200, { 'Content-Type': 'video/mp2t' }); r.write(fs.readFileSync(path.join(ROOT, 'ch.ts'))); open.add(r); return; }
    r.writeHead(404); r.end();
  }).listen(0);
  await new Promise(r => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => {
  for (const r of open) try { r.destroy(); } catch {}
  srv?.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('spellistan skrivs om: borttagna segment, MEDIA-SEQUENCE och token', () => {
  const src = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-INDEPENDENT-SEGMENTS\n'
    + '#EXTINF:4.000000,\nseg-00010.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4.000000,\nseg-00011.ts\n#EXTINF:4.000000,\nseg-00012.ts\n#EXTINF:3.960000,\nseg-00013.ts\n';
  // Inget borttaget: oförändrad (utom token)
  const a = ts.rewritePlaylist(src, { token: 'a b' });
  assert.match(a, /#EXT-X-MEDIA-SEQUENCE:10\n/);
  assert.equal(a.match(/^seg-\d+\.ts\?t=a%20b$/gm).length, 4);
  assert.doesNotMatch(a, /ENDLIST|PLAYLIST-TYPE/, 'en glidande live-lista, ingen EVENT/VOD');
  // Disktaket tog bort 10 och 11: sekvensnumren räknas upp, även diskontinuiteten
  const b = ts.rewritePlaylist(src, { minSeg: 12 });
  assert.match(b, /#EXT-X-MEDIA-SEQUENCE:12\n/);
  assert.match(b, /#EXT-X-DISCONTINUITY-SEQUENCE:1\n/);
  assert.deepEqual(b.match(/^seg-\d+\.ts$/gm), ['seg-00012.ts', 'seg-00013.ts']);
  assert.ok(b.indexOf('#EXT-X-TARGETDURATION') < b.indexOf('seg-00012.ts'));
  // Allt borttaget: det senaste segmentet behålls så att listan aldrig blir tom
  assert.deepEqual(ts.rewritePlaylist(src, { minSeg: 99 }).match(/^seg-\d+\.ts$/gm), ['seg-00013.ts']);
  // Fler än fem siffror efter länge
  assert.ok(ts.SEG_RE.test('seg-100000.ts') && !ts.SEG_RE.test('seg-1.ts') && !ts.SEG_RE.test('../seg-00001.ts'));
});

test('inställningar för timeshift: standard 2 timmar, 0 = av', () => {
  assert.equal(ts.timeshiftMinutes(), 120);
  assert.equal(ts.listSize(120), 1800);
  assert.equal(ts.listSize(0), 8);
  setSetting('live_timeshift_minutes', '9999');
  assert.equal(ts.timeshiftMinutes(), 720);
  setSetting('live_timeshift_minutes', '120');
});

test('disktaket tar bort de äldsta segmenten från den största strömmen', () => {
  const mk = (name, n, size) => {
    const dir = path.join(ROOT, 'cap', name); fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `seg-${String(i).padStart(5, '0')}.ts`), Buffer.alloc(size));
    return { dir, minSeg: 0 };
  };
  const big = mk('a', 20, 1000), small = mk('b', 8, 1000);
  // Tak 20 kB: 8 segment bort från den stora (de sex nyaste rörs aldrig)
  assert.equal(ts.enforceCap([big, small], { maxBytes: 20000, free: () => Infinity }), 8);
  assert.equal(big.minSeg, 8); assert.equal(small.minSeg, 0);
  assert.ok(!fs.existsSync(path.join(big.dir, 'seg-00007.ts')) && fs.existsSync(path.join(big.dir, 'seg-00008.ts')));
  // Lite ledigt utrymme på disken: ner till de sex nyaste i båda
  ts.enforceCap([big, small], { maxBytes: 1e12, free: () => 0 });
  assert.equal(fs.readdirSync(big.dir).length, 6); assert.equal(fs.readdirSync(small.dir).length, 6);
  assert.equal(small.minSeg, 2);
});

test('live med timeshift: hela fönstret i spellistan, disktak, borttagna segment och idle-städning', { skip: !hasFfmpeg, timeout: 90000 }, async () => {
  const live = await import('../server/livetv.js');
  const { get } = await import('../server/db.js');
  await live.addTuner({ kind: 'm3u', url: base + '/list.m3u', tuners: 1 });
  const ch = live.channelList()[0];
  const tunerId = get('SELECT tuner_id FROM channels WHERE id=?', ch.id).tuner_id;
  const res = () => { const r = { code: 0, body: '', headers: {} }; r.writeHead = (c, h) => { r.code = c; Object.assign(r.headers, h); return r; }; r.end = (b) => { r.body += b ?? ''; }; r.setHeader = () => {}; r.headersSent = false; return r; };
  const segs = (body) => body.match(/^seg-\d+\.ts/gm) || [];
  let a = res();
  await live.servePlaylist(a, ch.id, 'TOK');
  assert.equal(a.code, 200, a.body);
  // ffmpeg läser filen snabbare än realtid: vänta tills hela minuten (~14 segment) har blivit segment
  for (let i = 0; i < 100 && segs(a.body).length < 13; i++) { await new Promise(r => setTimeout(r, 200)); a = res(); await live.servePlaylist(a, ch.id, 'TOK'); }
  const all1 = segs(a.body);
  assert.ok(all1.length >= 13, `alla segment ska finnas kvar (inte bara de 8 senaste): ${all1.length}`);
  assert.equal(all1[0], 'seg-00000.ts');
  assert.match(a.body, /#EXT-X-MEDIA-SEQUENCE:0\n/);
  assert.match(a.body, /seg-00000\.ts\?t=TOK/);
  assert.equal(live.tunersInUse()[tunerId], 1);

  // Disktak (litet tak): de äldsta segmenten tas bort och försvinner ur listan
  assert.ok(live.enforceTimeshiftCap({ maxBytes: 1, free: () => Infinity }) > 0);
  const b = res();
  await live.servePlaylist(b, ch.id);
  const all2 = segs(b.body);
  assert.ok(all2.length <= 7 && all2.length >= 6, b.body);
  const first = parseInt(all2[0].slice(4));
  assert.match(b.body, new RegExp(`#EXT-X-MEDIA-SEQUENCE:${first}\\n`));
  // Ett borttaget segment ger 404 (inte en krasch), ett kvarvarande serveras
  const req = { headers: {}, method: 'GET' };
  const gone = res();
  live.serveSegment(req, gone, ch.id, 'seg-00000.ts');
  assert.equal(gone.code, 404);
  const okRes = await new Promise((resolve) => {
    const out = new Writable({ write(c, e, cb) { cb(); } });
    out.writeHead = (c) => { out.code = c; return out; }; out.setHeader = () => {};
    out.on('finish', () => resolve(out));
    live.serveSegment(req, out, ch.id, all2[0]);
  });
  assert.equal(okRes.code, 200);

  // Ingen hämtar något: sessionen stängs och tunern släpps
  live.sweepIdle(-1);
  assert.equal(live.activeLive().length, 0);
  assert.equal(live.tunersInUse()[tunerId], 0);
});

test('reklamdetektering: brytpunkter (svart + tyst) bildar avbrott', () => {
  const pt = (t) => ({ start: t, end: t + 0.6 });
  const sil = (t) => ({ start: t - 0.1, end: t + 0.8 });
  // Fyra brytpunkter med 30 s emellan = ett avbrott på ~91 s; en ensam scenövergång vid 60 s räknas inte
  const blacks = [pt(60), pt(300), pt(330.6), pt(361.2), pt(391.8), pt(1200)];
  const sils = [sil(60), sil(300), sil(330.6), sil(361.2), sil(391.8)];
  assert.deepEqual(cs.findCommercials(blacks, sils), [{ start: 300, end: 392.4 }]);
  // Svart utan tystnad är ingen brytpunkt
  assert.deepEqual(cs.findCommercials(blacks, sils.slice(0, 3)), []);
  // För kort (en enda film) och för långt
  assert.deepEqual(cs.findCommercials([pt(100), pt(130)], [sil(100), sil(130)]), []);
  const many = Array.from({ length: 25 }, (_, i) => 100 + i * 30);
  assert.deepEqual(cs.findCommercials(many.map(pt), many.map(sil)), [], 'tolv minuter är inte ett reklamavbrott');
  // Loggen från ffmpeg
  const p = cs.parseDetect('  Duration: 00:06:35.20, start: 0.000\n[blackdetect @ 0x1] black_start:150 black_end:151.2 black_duration:1.2\n'
    + '[silencedetect @ 0x2] silence_start: 149.98\n[silencedetect @ 0x2] silence_end: 151.21 | silence_duration: 1.23\n');
  assert.equal(p.duration, 395.2);
  assert.deepEqual(p.blacks, [{ start: 150, end: 151.2 }]);
  assert.deepEqual(p.silences, [{ start: 149.98, end: 151.21 }]);
});

test('reklamdetektering på en riktig fil (lavfi: färg/svart + ton/tystnad)', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const f = path.join(ROOT, 'prog.mp4');
  // Program 150 s, avbrott med tre filmer à 30 s, program med en tyst scen och en svart övergång med ljud, program
  makeClip(f, [['show', 150], ['black', 1], ['show', 30], ['black', 1], ['show', 30], ['black', 1], ['show', 30], ['black', 1],
    ['show', 60], ['quiet', 2], ['show', 60], ['dark', 1], ['show', 100]]);
  const r = await cs.analyzeFile(f, { timeoutMs: 50000 });
  assert.equal(r.segments.length, 1, JSON.stringify(r));
  const [s] = r.segments;
  assert.ok(Math.abs(s.start - 150) < 0.6 && Math.abs(s.end - 244) < 0.6, JSON.stringify(s));
  // Tidsgränsen avbryter
  await assert.rejects(cs.analyzeFile(f, { timeoutMs: 1 }), /för lång tid/);
});
