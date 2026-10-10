// Live-TV och inspelning mot en simulerad IPTV-källa (M3U + XMLTV + MPEG-TS över HTTP). Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-live-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.DVR_DIR = path.join(ROOT, 'rec');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
let srv, base;
const T0 = Math.floor(Date.now() / 1000);
const xt = (t) => { const d = new Date(t * 1000); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`; };

before(async () => {
  if (!hasFfmpeg) return;
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
  // Kanal 1: MPEG-2 flätad (som antenn-TV), kanal 2: H.264 (som IPTV)
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30', '-c:v', 'mpeg2video', '-b:v', '2M', '-flags', '+ilme+ildct', '-c:a', 'mp2', '-f', 'mpegts', path.join(ROOT, 'ch1.ts'));
  ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=600', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mpegts', path.join(ROOT, 'ch2.ts'));
  srv = http.createServer((q, r) => {
    if (q.url === '/list.m3u') {
      r.end(`#EXTM3U\n#EXTINF:-1 tvg-id="svt1.se" tvg-logo="http://x/l.png" group-title="Public",SVT1 HD\n${base}/ch1.ts\n#EXTINF:-1 tvg-chno="2",Kanal Två\n${base}/ch2.ts\n`);
    } else if (q.url === '/guide.xml') {
      r.end(`<?xml version="1.0"?><tv><channel id="svt1.se"><display-name>SVT1</display-name></channel><channel id="k2"><display-name>Kanal Två</display-name></channel>
        <programme start="${xt(T0 - 600)}" stop="${xt(T0 + 1200)}" channel="svt1.se"><title>Rapport</title><desc>Nyheter &amp; väder</desc><episode-num system="xmltv_ns">2.4.</episode-num></programme>
        <programme start="${xt(T0 + 1200)}" stop="${xt(T0 + 3000)}" channel="svt1.se"><title>Bron</title><sub-title>Del 1</sub-title><new/></programme>
        <programme start="${xt(T0 + 86400)}" stop="${xt(T0 + 88200)}" channel="svt1.se"><title>Bron</title><sub-title>Del 2</sub-title></programme>
        <programme start="${xt(T0 + 90000)}" stop="${xt(T0 + 91800)}" channel="k2"><title>Bron</title><sub-title>Del 1</sub-title></programme>
        <programme start="${xt(T0 - 60)}" stop="${xt(T0 + 600)}" channel="k2"><title>Sport</title></programme></tv>`);
    } else if (/^\/ch\d\.ts$/.test(q.url)) {
      const f = path.join(ROOT, q.url.slice(1));
      r.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(r);
    } else { r.writeHead(404); r.end(); }
  }).listen(0);
  await new Promise(r => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('M3U och XMLTV tolkas', () => {
  return import('../server/livetv.js').then(live => {
    const m = live.parseM3U('#EXTM3U\n#EXTINF:-1 tvg-id="a" group-title="G",Namn, med komma\nhttp://x/1\n#EXTINF:-1,B\n# kommentar\nrtp://239.0.0.1:1234\n');
    assert.equal(m.length, 2); assert.equal(m[0].name, ' med komma'.trim()); assert.equal(m[0].epg, 'a'); assert.equal(m[1].url, 'rtp://239.0.0.1:1234');
    assert.equal(live.xmltvTime('20261010180000 +0200'), Date.UTC(2026, 9, 10, 16, 0, 0) / 1000);
    const g = live.parseXMLTV('<tv><programme start="20261010180000 +0000" stop="20261010190000 +0000" channel="c"><title>T &amp; U</title><episode-num system="onscreen">S03E07</episode-num></programme></tv>');
    assert.equal(g.programs[0].title, 'T & U'); assert.equal(g.programs[0].season, 3); assert.equal(g.programs[0].episode, 7);
  });
});

test('IPTV-källa, guide, live-HLS och inspelning', { skip: !hasFfmpeg, timeout: 120000 }, async () => {
  const live = await import('../server/livetv.js');
  const dvr = await import('../server/dvr.js');
  const { get, all, setSetting } = await import('../server/db.js');
  setSetting('dvr_pad_before', '0'); setSetting('dvr_pad_after', '0');
  const tid = await live.addTuner({ kind: 'm3u', url: base + '/list.m3u', epgUrl: base + '/guide.xml', tuners: 1 });
  const chans = live.channelList();
  assert.equal(chans.length, 2);
  const svt = chans.find(c => c.name === 'SVT1 HD'), k2 = chans.find(c => c.name === 'Kanal Två');
  assert.equal(svt.now?.title, 'Rapport'); assert.equal(svt.next?.title, 'Bron');
  assert.equal(k2.epgId, 'k2'); // kopplad via namn
  const p = get('SELECT * FROM programs WHERE title=? AND channel_id=?', 'Rapport', svt.id);
  assert.equal(p.season, 3); assert.equal(p.episode, 5); assert.equal(p.description, 'Nyheter & väder');

  // Live: spellista med segment, och tunerspärren (1 tuner) hindrar en andra kanal
  const res = (() => { const r = { code: 0, body: '', headers: {} }; r.writeHead = (c, h) => { r.code = c; Object.assign(r.headers, h); return r; }; r.end = (b) => { r.body += b ?? ''; }; r.setHeader = () => {}; r.headersSent = false; return r; });
  const a = res();
  await live.servePlaylist(a, svt.id, 'TOKEN');
  assert.equal(a.code, 200, a.body);
  assert.match(a.body, /seg-\d{5}\.ts\?t=TOKEN/);
  const b = res();
  await live.servePlaylist(b, k2.id);
  assert.equal(b.code, 409);
  live.stopChannel(svt.id);

  // Serieinspelning: Bron, bara nya avsnitt (Del 1 på Kanal Två är en repris)
  dvr.addRule({ title: 'bron', newOnly: true }, { id: 1 });
  const sched = all("SELECT * FROM recordings WHERE status='scheduled' ORDER BY start");
  assert.deepEqual(sched.map(r => r.subtitle), ['Del 1', 'Del 2']);

  // Manuell inspelning av 8 sekunder H.264 → MP4 utan omkodning
  const id = dvr.scheduleManual({ channelId: k2.id, start: Math.floor(Date.now() / 1000) - 1, stop: Math.floor(Date.now() / 1000) + 8, title: 'Test' }, { id: 1 });
  let r;
  for (let i = 0; i < 90; i++) { await new Promise(s => setTimeout(s, 1000)); r = get('SELECT * FROM recordings WHERE id=?', id); if (['done', 'failed'].includes(r.status)) break; }
  assert.equal(r.status, 'done', r.error || '');
  assert.ok(r.file.endsWith('.mp4') && fs.existsSync(r.file));
  const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', r.file]).toString();
  assert.match(info, /h264/); assert.match(info, /aac/);
  dvr.removeRecording(id);
  assert.ok(!fs.existsSync(r.file));
  void tid;
});
