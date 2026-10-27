// IPTV mot simulerade källor: en lokal HTTP-server med M3U-lista (rubriker, catch-up, url-tvg), gzip-komprimerad XMLTV,
// ett Xtream Codes-API (konto, live, filmer, serier, xmltv.php) och ffmpeg-genererade MPEG-TS/MP4/MKV-filer.
// Testar tolkarna (även fientliga listor), catch-up-adresserna, SSRF-skyddet och hela kedjan mot en riktig server:
// flera källor, reservström, rubriker till ffmpeg, catch-up, guide från flera källor utan dubbletter, favoriter per
// profil, barnprofiler (åldersgräns per grupp), administratörens ändringar som överlever uppdateringen, VOD och att
// Xtream-lösenordet aldrig syns i API-svaren. Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-iptv-'));
process.env.CONFIG_DIR = path.join(ROOT, 'unit-config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'unit-tc');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const PASS = 'Hemlig9pass';
const T0 = Math.floor(Date.now() / 1000);
const xt = (t) => { const d = new Date(t * 1000); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let F = null, FB = '', srv = null;
const seen = []; // förfrågningar till den simulerade källan: { url, ua }

before(async () => {
  if (!hasFfmpeg) return;
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '16', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', path.join(ROOT, 'ch.ts'));
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=700', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path.join(ROOT, 'movie.mp4'));
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(ROOT, 'ep.mkv'));
  const guide = `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="k1"><display-name>Kanal Ett</display-name></channel><channel id="k2"><display-name>Barnkanalen</display-name></channel>
    <programme start="${xt(T0 - 7200)}" stop="${xt(T0 - 3600)}" channel="k1"><title>Morgonnytt</title><desc>Nyheter från i morse</desc></programme>
    <programme start="${xt(T0 - 600)}" stop="${xt(T0 + 1800)}" channel="k1"><title>Nyheterna</title></programme>
    <programme start="${xt(T0 + 1800)}" stop="${xt(T0 + 5400)}" channel="k1"><title>Kvällsfilm</title></programme>
    <programme start="${xt(T0 - 600)}" stop="${xt(T0 + 1800)}" channel="k2"><title>Barnprogram</title></programme></tv>`;
  // Gemensam guide: ett eget program för k1 samtidigt (ska inte bli dubblett – listans guide går före) och Intern (bara här)
  const guide2 = `<tv><channel id="g-k1"><display-name>Kanal Ett</display-name></channel><channel id="g-int"><display-name>Intern</display-name></channel>
    <programme start="${xt(T0 - 600)}" stop="${xt(T0 + 1800)}" channel="g-k1"><title>Annat program</title></programme>
    <programme start="${xt(T0 - 600)}" stop="${xt(T0 + 1800)}" channel="g-int"><title>Internprogram</title></programme></tv>`;
  const xguide = `<tv><channel id="k4"><display-name>Sport</display-name></channel><programme start="${xt(T0 - 600)}" stop="${xt(T0 + 3600)}" channel="k4"><title>Fotboll</title></programme></tv>`;
  const sendFile = (q, r, f, type) => {
    const size = fs.statSync(f).size, m = /bytes=(\d*)-(\d*)/.exec(q.headers.range || '');
    if (m) {
      const a = +m[1] || 0, b = m[2] ? Math.min(+m[2], size - 1) : size - 1;
      r.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(f, { start: a, end: b }).pipe(r);
    }
    r.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(f).pipe(r);
  };
  const J = (r, o) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
  F = http.createServer((q, r) => {
    seen.push({ url: q.url, ua: q.headers['user-agent'] || '' });
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/list.m3u') {
      r.end(`#EXTM3U url-tvg="${FB}/guide.xml.gz" catchup="default" catchup-days="3" catchup-source="${FB}/catchup/ch1.ts?utc={utc}&dur={duration}"
#EXTINF:-1 tvg-id="k1" tvg-chno="1" group-title="Nyheter",Kanal Ett
#EXTVLCOPT:http-user-agent=TestUA/1.0
${FB}/ch1.ts
#EXTINF:-1 tvg-id="k2" tvg-chno="2" group-title="Barn",Barnkanalen
${FB}/ch2.ts
#EXTINF:-1 tvg-chno="3" group-title="Adult XXX",Vuxenkanalen
${FB}/ch3.ts
#EXTINF:-1 tvg-id="k4" tvg-chno="4" group-title="Sport",Sport HD
${FB}/missing.ts
#EXTINF:-1 tvg-chno="5" group-title="Övrigt",Intern
http://127.0.0.2:${F.address().port}/ch2.ts
#EXTINF:-1 group-title="Övrigt",DRM-kanal
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
${FB}/drm.mpd
`);
    } else if (u.pathname === '/guide.xml.gz') { r.writeHead(200, { 'Content-Type': 'application/gzip' }); r.end(zlib.gzipSync(guide)); }
    else if (u.pathname === '/guide2.xml') r.end(guide2);
    else if (/^\/(ch\d|catchup\/ch1)\.ts$/.test(u.pathname) || u.pathname === `/live/u/${PASS}/41.ts`) sendFile(q, r, path.join(ROOT, 'ch.ts'), 'video/mp2t');
    else if (u.pathname === `/movie/u/${PASS}/501.mp4`) sendFile(q, r, path.join(ROOT, 'movie.mp4'), 'video/mp4');
    else if (u.pathname === `/series/u/${PASS}/7001.mkv`) sendFile(q, r, path.join(ROOT, 'ep.mkv'), 'video/x-matroska');
    else if (u.pathname === '/xmltv.php') { if (u.searchParams.get('password') !== PASS) { r.writeHead(401); return r.end(); } r.end(xguide); }
    else if (u.pathname === '/player_api.php') {
      if (u.searchParams.get('username') !== 'u' || u.searchParams.get('password') !== PASS) return J(r, { user_info: { auth: 0 } });
      const a = u.searchParams.get('action');
      if (!a) return J(r, { user_info: { username: 'u', auth: 1, status: 'Active', exp_date: String(T0 + 86400 * 30), max_connections: '2', active_cons: '0', is_trial: '0', allowed_output_formats: ['m3u8', 'ts'] },
        server_info: { url: '127.0.0.1', port: '80', timezone: 'Europe/Stockholm' } });
      if (a === 'get_live_categories') return J(r, [{ category_id: '10', category_name: 'Sport' }]);
      if (a === 'get_live_streams') return J(r, [{ num: 41, name: 'Sport', stream_type: 'live', stream_id: 41, stream_icon: '', epg_channel_id: 'k4', category_id: '10', tv_archive: 1, tv_archive_duration: 2 }]);
      if (a === 'get_vod_categories') return J(r, [{ category_id: '20', category_name: 'Action' }, { category_id: '21', category_name: 'XXX Adult' }]);
      if (a === 'get_vod_streams') return J(r, [{ num: 1, name: 'Testfilm (2024)', stream_type: 'movie', stream_id: 501, stream_icon: '', rating: '7.4', added: String(T0), category_id: '20', container_extension: 'mp4' },
        { num: 2, name: 'Vuxenfilm', stream_type: 'movie', stream_id: 502, rating: '', added: String(T0), category_id: '21', container_extension: 'mp4' }]);
      if (a === 'get_series_categories') return J(r, [{ category_id: '30', category_name: 'Drama' }]);
      if (a === 'get_series') return J(r, [{ num: 1, name: 'Testserie', series_id: 601, cover: '', plot: 'En serie', category_id: '30', last_modified: String(T0) }]);
      if (a === 'get_vod_info') return J(r, { info: { plot: 'En film om tester', cast: 'Anna, Bo', director: 'Cecilia', duration_secs: 8, genre: 'Action' }, movie_data: { stream_id: 501, container_extension: 'mp4' } });
      if (a === 'get_series_info') return J(r, { info: { plot: 'En serie om tester' }, episodes: { 1: [{ id: '7001', episode_num: 1, title: 'Pilot', container_extension: 'mkv', season: 1, info: { duration_secs: 8 } }] } });
      return J(r, []);
    } else { r.writeHead(404); r.end(); }
  });
  await new Promise(r => F.listen(0, '0.0.0.0', r));
  FB = `http://127.0.0.1:${F.address().port}`;
});
after(async () => { await srv?.stop(); F?.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

// ---------- rena delar ----------
test('M3U: attribut, rubriker, catch-up, grupper och listans guide', async () => {
  const { parseM3U } = await import('../server/iptv/m3u.js');
  const r = parseM3U(`﻿#EXTM3U x-tvg-url="https://g.example/a.xml.gz,https://g.example/b.xml" catchup="shift" catchup-days="5"
#EXTINF:-1 tvg-id="svt1.se" tvg-name="SVT1" tvg-logo="https://l.example/svt.png" group-title="Sverige, HD" tvg-chno=101 catchup="flussonic" catchup-days="7",SVT1 HD, med komma
#EXTVLCOPT:http-user-agent=Mozilla/5.0 (X11)
#EXTVLCOPT:http-referrer=https://ref.example/
https://s.example/svt1/index.m3u8
#EXTINF:0 tvg-id='tv4' group-title=Nöje,TV4
#EXTGRP:Ignoreras när group-title finns
https://s.example/tv4.ts|User-Agent=Kodi%2F20&Referer=https://k.example/
#EXTINF:-1,Utan grupp
#EXTGRP:Från EXTGRP
#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=Box&Origin=https://o.example
rtp://239.1.1.1:5000
#EXTINF:-1 tvg-id="drm",DRM
#KODIPROP:inputstream.adaptive.license_key=https://lic.example
https://s.example/drm.mpd
#EXTINF:-1 group-title="For adults",Natt
ftp://x.example/a
https://utan-extinf.example/a.ts
`);
  assert.deepEqual(r.header.epg, ['https://g.example/a.xml.gz', 'https://g.example/b.xml']);
  assert.equal(r.entries.length, 3, JSON.stringify(r.entries.map(e => e.name)));
  const [a, b, c] = r.entries;
  assert.equal(a.name, 'SVT1 HD, med komma'); assert.equal(a.group, 'Sverige, HD'); assert.equal(a.number, '101'); assert.equal(a.epg, 'svt1.se');
  assert.equal(a.logo, 'https://l.example/svt.png'); assert.equal(a.catchup, 'flussonic'); assert.equal(a.catchupDays, 7); assert.equal(a.hd, 1);
  assert.deepEqual(a.headers, { 'User-Agent': 'Mozilla/5.0 (X11)', Referer: 'https://ref.example/' });
  assert.equal(b.url, 'https://s.example/tv4.ts'); assert.equal(b.epg, 'tv4'); assert.equal(b.group, 'Nöje');
  assert.deepEqual(b.headers, { 'User-Agent': 'Kodi/20', Referer: 'https://k.example/' });
  assert.equal(b.catchup, 'shift'); assert.equal(b.catchupDays, 5); // listans (#EXTM3U)
  assert.equal(c.group, 'Från EXTGRP'); assert.equal(c.url, 'rtp://239.1.1.1:5000'); assert.deepEqual(c.headers, { 'User-Agent': 'Box', Origin: 'https://o.example' });
  assert.equal(r.skipped, 2); // DRM och ftp
  const adult = parseM3U('#EXTINF:-1 group-title="XXX 18+",X\nhttp://a/1\n#EXTINF:-1 censored="1",Y\nhttp://a/2\n#EXTINF:-1 group-title="Sexton",Z\nhttp://a/3\n').entries;
  assert.deepEqual(adult.map(e => e.adult), [1, 1, 0]);
});

test('M3U: fientliga listor ger begränsat resultat i linjär tid', async () => {
  const { parseM3U, scanAttrs } = await import('../server/iptv/m3u.js');
  let t = Date.now();
  const many = '#EXTM3U\n' + Array.from({ length: 120000 }, (_, i) => `#EXTINF:-1 tvg-id="c${i}" group-title="G${i % 50}",Kanal ${i}\nhttp://s.example/${i}.ts`).join('\n');
  const r = parseM3U(many);
  assert.equal(r.entries.length, 50000); // taket
  assert.ok(Date.now() - t < 4000, `för långsamt: ${Date.now() - t} ms`);
  t = Date.now();
  const evil = `#EXTINF:-1 ${'a="'.repeat(20000)}\nhttp://x/1\n#EXTINF:-1 ${'x='.repeat(100000)},Namn\nhttp://x/2\n#EXTINF:-1 tvg-name="${'"'.repeat(5000)}\nhttp://x/3\n${'#'.repeat(2e6)}\n#EXTINF:-1,${'n'.repeat(500)}\nhttp://x/4\n`;
  const e = parseM3U(evil);
  assert.ok(Date.now() - t < 2000, `för långsamt: ${Date.now() - t} ms`);
  assert.ok(e.entries.length >= 1 && e.entries.length <= 4);
  assert.ok(e.entries.every(x => x.name.length <= 120));
  assert.equal(parseM3U('').entries.length, 0); assert.equal(parseM3U(null).entries.length, 0);
  assert.deepEqual(scanAttrs('-1 a="1" b=\'2\' c=3,Namn, med komma'), { attrs: { a: '1', b: '2', c: '3' }, rest: 'Namn, med komma' });
  // Rubriker med radbrytning eller okänt namn tas inte med (de hamnar i ffmpegs argument)
  const h = parseM3U('#EXTINF:-1,A\nhttp://x/a|User-Agent=ok%0d%0aX-Evil: 1&X-Custom=nej&Referer=https://r.example\n').entries[0].headers;
  assert.deepEqual(h, { Referer: 'https://r.example' });
});

test('catch-up: adresser för default, append, shift, flussonic och xc', async () => {
  const { catchupUrl, catchupWindow, fill } = await import('../server/iptv/catchup.js');
  const start = Date.UTC(2026, 9, 27, 18, 30, 0) / 1000, stop = start + 3600, now = start + 7200;
  const p = { start, stop };
  assert.equal(catchupUrl({ stream_url: 'http://s/live/1.ts', catchup: 'default', catchup_source: 'http://s/arc/1.ts?start={utc}&end={utcend}&d={duration:60}&o={offset:60}' }, p, { now }),
    `http://s/arc/1.ts?start=${start}&end=${stop}&d=60&o=120`);
  assert.equal(catchupUrl({ stream_url: 'http://s/1.m3u8', catchup: 'append', catchup_source: '?t=${start}-{Y}{m}{d}{H}{M}' }, p, { now }), `http://s/1.m3u8?t=${start}-202610271830`);
  assert.equal(catchupUrl({ stream_url: 'http://s/1.m3u8?token=a', catchup: 'shift' }, p, { now }), `http://s/1.m3u8?token=a&utc=${start}&lutc=${now}`);
  assert.equal(catchupUrl({ stream_url: 'http://f/ch/index.m3u8?token=x', catchup: 'flussonic' }, p, { now }), `http://f/ch/index-${start}-3600.m3u8?token=x`);
  assert.equal(catchupUrl({ stream_url: 'http://f/ch/mpegts', catchup: 'fs' }, p, { now }), `http://f/ch/timeshift_abs-${start}.ts`);
  // Xtream: serverns tidszon (18:30 UTC = 19:30 i Stockholm i slutet av oktober, vintertid)
  assert.equal(catchupUrl({ stream_url: 'http://x:8080/live/u/p/41.ts', catchup: 'xc', tz: 'Europe/Stockholm' }, p, { now }), 'http://x:8080/timeshift/u/p/60/2026-10-27:19-30/41.ts');
  assert.equal(catchupUrl({ stream_url: 'http://x/u/p/41', catchup: 'xc' }, p, { now }), 'http://x/timeshift/u/p/60/2026-10-27:18-30/41.ts');
  assert.equal(fill('${(b)yyyy-MM-dd HH:mm}|${(e)HHmmss}|{utc:Y-m-d}', { start, end: stop, now }), '2026-10-27 18:30|193000|2026-10-27');
  // Pågående program: fram till nu
  assert.equal(catchupUrl({ stream_url: 'http://s/1', catchup: 'default', catchup_source: 'http://s/a?d={duration}' }, { start: now - 600, stop: now + 600 }, { now }), 'http://s/a?d=600');
  assert.equal(catchupUrl({ stream_url: 'http://s/1', catchup: 'default' }, p, { now }), null); // ingen källa
  assert.equal(catchupWindow({ catchup: 'shift', catchup_days: 1 }, { start: now - 90000 }, now), false);
  assert.equal(catchupWindow({ catchup: 'shift', catchup_days: 2 }, { start: now - 90000 }, now), true);
  assert.equal(catchupWindow({ catchup: 'shift' }, { start: now + 60 }, now), false); // framtida
});

test('SSRF-skydd: betrodda värdar, hemnätet och alltid spärrade adresser', async () => {
  const net = await import('../server/iptv/net.js');
  const pol = net.policyOf(['http://127.0.0.1:9/list.m3u'], true), noLan = net.policyOf([], false);
  assert.equal(await net.hostOk('127.0.0.1', pol), true);   // det administratören skrev in
  assert.equal(await net.hostOk('127.0.0.2', pol), false);  // annan loopback
  assert.equal(await net.hostOk('169.254.169.254', pol), false);
  assert.equal(await net.hostOk('192.168.1.20', pol), true);
  assert.equal(await net.hostOk('192.168.1.20', noLan), false);
  assert.equal(await net.hostOk('[::1]', pol), false);
  assert.equal(await net.hostOk('8.8.8.8', noLan), true);
  await assert.rejects(net.assertStream('http://10.0.0.1/a.ts', noLan), /lokalt nätverk/);
  await assert.rejects(net.assertStream('file:///etc/passwd', pol), /protokoll/);
  await net.assertStream('udp://239.0.0.1:1234', noLan);
  await assert.rejects(net.iptvFetch('http://127.0.0.3:1/x', { pol }), /lokalt nätverk/);
  assert.equal(net.maskUrl('http://p.example:8080/get.php?username=u&password=hemligt&type=m3u'), 'http://p.example:8080/get.php?username=•••&password=•••&type=m3u');
  assert.equal(net.maskUrl('http://p.example/live/u/hemligt/1.ts'), 'http://p.example/live/•••/•••/1.ts');
  assert.equal(net.redact('Fel från http://p.example/live/u/hemligt/1.ts: 404'), 'Fel från p.example/…: 404');
  assert.deepEqual(net.ffHeaders({ 'User-Agent': 'A', Referer: 'https://r', Origin: 'https://o' }), ['-user_agent', 'A', '-referer', 'https://r', '-headers', 'Origin: https://o\r\n']);
});

// ---------- mot en riktig server ----------
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas', timeout: 180000 }, fn);
const S = {};
let adminTok = '', kidTok = '';
const api = (p, o = {}) => srv.req(p, { ...o, headers: { ...(o.headers || {}), ...(o.tok !== '' ? { authorization: 'Bearer ' + (o.tok || adminTok) } : {}) }, auth: false });
const byName = async (name, tok) => (await api('/api/iptv/channels', { tok })).data.channels.find(c => c.name === name);

t('källor: M3U och Xtream läggs till, guiden kommer från listans gzip-guide', async () => {
  for (const d of ['srv', 'media']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  srv = await startServer({ root: path.join(ROOT, 'srv'), media: path.join(ROOT, 'media'), env: { TMDB_API_KEY: '', WATCH_FILES: '0', DVR_DIR: path.join(ROOT, 'rec') } });
  assert.equal((await srv.req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } })).status, 200);
  adminTok = await srv.appToken();
  let r = await api('/api/iptv/sources', { method: 'POST', body: { type: 'm3u', url: FB + '/list.m3u', name: 'Lista', connections: 4 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  S.m3u = r.data.id;
  r = await api('/api/iptv/sources', { method: 'POST', body: { type: 'xtream', server: FB + '/player_api.php', username: 'u', password: 'fel' } });
  assert.equal(r.status, 400); assert.match(r.data.error, /Inloggningen/);
  r = await api('/api/iptv/sources', { method: 'POST', body: { type: 'xtream', server: FB, username: 'u', password: PASS, name: 'Xtream' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  S.xt = r.data.id;
  const A = (await api('/api/iptv/admin')).data;
  const m = A.sources.find(s => s.id === S.m3u), x = A.sources.find(s => s.id === S.xt);
  assert.equal(m.channels, 5); // DRM-kanalen tas inte med
  assert.equal(m.catchup, 5);
  assert.deepEqual(m.m3uEpg, [FB + '/guide.xml.gz']);
  assert.equal(x.type, 'xtream'); assert.equal(x.connections, 2); assert.equal(x.account.status, 'Active'); assert.equal(x.channels, 1);
  // Vuxengruppen får 18 år automatiskt
  assert.equal(A.groups.find(g => g.name === 'Adult XXX').age, 18);
  const ch = (await api('/api/iptv/channels')).data;
  const k1 = ch.channels.find(c => c.name === 'Kanal Ett');
  assert.equal(k1.now?.title, 'Nyheterna'); assert.equal(k1.next?.title, 'Kvällsfilm'); assert.equal(k1.catchup, 3);
  assert.equal(ch.channels.find(c => c.name === 'Sport').now?.title, 'Fotboll'); // Xtream-serverns xmltv.php
  S.k1 = k1.id; S.barn = ch.channels.find(c => c.name === 'Barnkanalen').id; S.vuxen = ch.channels.find(c => c.name === 'Vuxenkanalen').id;
  S.sport = ch.channels.find(c => c.name === 'Sport HD').id; S.intern = ch.channels.find(c => c.name === 'Intern').id;
  assert.ok(ch.groups.some(g => g.name === 'Nyheter'));
});

t('Xtream-lösenordet syns aldrig i API-svaren', async () => {
  for (const p of ['/api/iptv/admin', '/api/iptv/channels', '/api/live/channels', '/api/live/tuners', `/api/iptv/epg?ids=${S.sport}`, '/api/iptv/admin/channels']) {
    const r = await api(p);
    assert.equal(r.status, 200, p);
    assert.ok(!JSON.stringify(r.data).includes(PASS), `lösenordet i ${p}`);
  }
});

t('guider från flera källor: listans guide går före den gemensamma, inga dubbletter', async () => {
  assert.equal((await api('/api/iptv/guides', { method: 'POST', body: { url: FB + '/guide2.xml', name: 'Gemensam' } })).status, 200);
  assert.equal((await api('/api/live/guide/refresh', { method: 'POST' })).status, 200);
  const from = T0 - 4 * 3600, to = T0 + 4 * 3600;
  const r = (await api(`/api/iptv/epg?ids=${S.k1},${S.intern}&from=${from}&to=${to}`)).data;
  assert.deepEqual(r.programs[S.k1].map(p => p.title), ['Morgonnytt', 'Nyheterna', 'Kvällsfilm']);
  assert.equal(r.programs[S.k1][0].catchup, true);
  assert.deepEqual(r.programs[S.intern].map(p => p.title), ['Internprogram']);
  const g = (await api('/api/iptv/admin')).data.guides[0];
  assert.equal(g.channels, 1); assert.equal(g.error, null);
  // En andra uppdatering behåller programmens id (inspelningar och påminnelser pekar på dem)
  const before = r.programs[S.k1].map(p => p.id);
  await api('/api/live/guide/refresh', { method: 'POST' });
  const again = (await api(`/api/iptv/epg?ids=${S.k1}&from=${from}&to=${to}`)).data.programs[S.k1].map(p => p.id);
  assert.deepEqual(again, before);
});

t('live: rubriker från listan till ffmpeg, reservström från annan källa och spärrad intern adress', async () => {
  let r = await api(`/api/live/${S.k1}/live.m3u8`);
  assert.equal(r.status, 200, String(r.data));
  assert.match(String(r.data), /seg-\d+\.ts/);
  assert.ok(seen.some(s => s.url === '/ch1.ts' && s.ua === 'TestUA/1.0'), 'User-Agent från #EXTVLCOPT');
  // Sport HD i listan ger 404 – samma kanal (tvg-id) hos Xtream-källan tar över
  r = await api(`/api/live/${S.sport}/live.m3u8`);
  assert.equal(r.status, 200, String(r.data));
  assert.ok(seen.some(s => s.url === `/live/u/${PASS}/41.ts`));
  // Intern pekar på en annan loopback-adress än den administratören skrev in
  const n = seen.length;
  r = await api(`/api/live/${S.intern}/live.m3u8`);
  assert.equal(r.status, 403); assert.match(r.data.error, /lokalt nätverk/);
  assert.equal(seen.length, n);
});

t('catch-up: redan sänt program spelas från arkivet med rätt tider och rubriker', async () => {
  const from = T0 - 4 * 3600;
  const p = (await api(`/api/iptv/epg?ids=${S.k1}&from=${from}&to=${T0}`)).data.programs[S.k1].find(x => x.title === 'Morgonnytt');
  const d = (await api('/api/iptv/programs/' + p.id)).data;
  assert.equal(d.catchup, true); assert.equal(d.live, false); assert.equal(d.description, 'Nyheter från i morse');
  let r = await api(`/api/iptv/programs/${p.id}/catchup`, { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.duration, 3600);
  assert.match(r.data.url, /^\/api\/iptv\/play\/\d+\/index\.m3u8\?t=/);
  const pl = await api(r.data.url, { tok: '' }); // mediatoken i adressen
  assert.equal(pl.status, 200, String(pl.data));
  assert.match(String(pl.data), /EXT-X-PLAYLIST-TYPE:EVENT/);
  const seg = String(pl.data).split('\n').find(l => l.startsWith('seg-'));
  assert.equal((await api(r.data.url.replace(/index\.m3u8\?/, seg.split('?')[0] + '?'), { tok: '' })).status, 200);
  const hit = seen.find(s => s.url.startsWith('/catchup/ch1.ts'));
  assert.ok(hit, 'catch-up-adressen hämtades');
  assert.equal(new URL(hit.url, 'http://x').searchParams.get('utc'), String(T0 - 7200));
  assert.equal(new URL(hit.url, 'http://x').searchParams.get('dur'), '3600');
  assert.equal(hit.ua, 'TestUA/1.0');
  // Mediatoken gäller bara sin session
  const other = await api(r.data.url.replace(/play\/(\d+)\//, (m, n) => `play/${+n + 99}/`), { tok: '' });
  assert.equal(other.status, 401);
  // Längre in i programmet: ny session med ny start
  r = await api(`/api/iptv/programs/${p.id}/catchup?offset=600`, { method: 'POST' });
  assert.equal(r.data.offset, 600);
  for (let i = 0; i < 30 && !seen.some(s => s.url.includes(`utc=${T0 - 6600}`)); i++) await sleep(200);
  assert.ok(seen.some(s => s.url.includes(`utc=${T0 - 6600}&dur=3000`)));
  await api(`/api/iptv/play/${r.data.sid}/stop`, { method: 'POST' });
  // Framtida program finns inte i arkivet
  const fut = (await api(`/api/iptv/epg?ids=${S.k1}&from=${T0}&to=${T0 + 7200}`)).data.programs[S.k1].find(x => x.title === 'Kvällsfilm');
  assert.equal((await api(`/api/iptv/programs/${fut.id}/catchup`, { method: 'POST' })).status, 400);
  S.future = fut.id; S.past = p.id;
});

t('påminnelser och favoriter per profil', async () => {
  assert.equal((await api(`/api/iptv/programs/${S.future}/reminder`, { method: 'POST' })).status, 200);
  assert.equal((await api(`/api/iptv/programs/${S.past}/reminder`, { method: 'POST' })).status, 400);
  let rem = (await api('/api/iptv/reminders')).data.reminders;
  assert.deepEqual(rem.map(x => x.title), ['Kvällsfilm']);
  const epg = (await api(`/api/iptv/epg?ids=${S.k1}&from=${T0}&to=${T0 + 7200}`)).data.programs[S.k1];
  assert.equal(epg.find(x => x.id === S.future).reminder, true);
  assert.equal((await api(`/api/iptv/programs/${S.future}/reminder`, { method: 'DELETE' })).status, 200);
  rem = (await api('/api/iptv/reminders')).data.reminders;
  assert.equal(rem.length, 0);
  assert.equal((await api(`/api/iptv/favorites/${S.k1}`, { method: 'PUT', body: { on: true } })).status, 200);
  assert.equal((await byName('Kanal Ett')).favorite, true);
  // Barnprofil
  assert.equal((await api('/api/profiles', { method: 'POST', body: { name: 'Lill', maxAge: 7 } })).status, 200);
  const pid = (await api('/api/profiles')).data.profiles.find(p => p.name === 'Lill').id;
  kidTok = (await api('/api/profiles/switch', { method: 'POST', body: { id: pid } })).data.token;
  assert.ok(kidTok);
  adminTok = await srv.appToken(); // profilbytet ersatte apptoken
});

t('barnprofiler: bara kanaler och filmer inom åldersgränsen', async () => {
  // Utan åldersgräns på någon grupp: ingen live-TV för barnet
  assert.equal((await api('/api/iptv/channels', { tok: kidTok })).status, 403);
  assert.equal((await api('/api/status', { tok: kidTok })).data.user.liveTv, false);
  assert.equal((await api('/api/iptv/admin/groups', { method: 'PUT', body: { kind: 'live', name: 'Barn', age: 0 } })).status, 200);
  const list = (await api('/api/iptv/channels', { tok: kidTok })).data.channels;
  assert.deepEqual(list.map(c => c.name), ['Barnkanalen']);
  assert.equal(list[0].favorite, false); // favoriterna är per profil
  assert.equal((await api('/api/status', { tok: kidTok })).data.user.liveTv, true);
  assert.deepEqual((await api('/api/live/channels', { tok: kidTok })).data.channels.map(c => c.name), ['Barnkanalen']);
  assert.equal((await api(`/api/live/${S.vuxen}/live.m3u8`, { tok: kidTok })).status, 403);
  assert.equal((await api(`/api/live/${S.vuxen}/play`, { method: 'POST', tok: kidTok })).status, 403);
  assert.equal((await api(`/api/iptv/favorites/${S.vuxen}`, { method: 'PUT', body: { on: true }, tok: kidTok })).status, 404);
  assert.equal((await api(`/api/iptv/programs/${S.past}`, { tok: kidTok })).status, 404);
  assert.equal((await api(`/api/live/${S.barn}/play`, { method: 'POST', tok: kidTok })).status, 200);
  // Vuxenkanalen har 18 år via gruppen – även en kanal utan grupp med egen gräns följer gränsen
  assert.equal((await api(`/api/iptv/admin/channels/${S.k1}`, { method: 'PUT', body: { age: 11 } })).status, 200);
  assert.ok(!(await api('/api/iptv/channels', { tok: kidTok })).data.channels.some(c => c.id === S.k1));
  // Filmer: inga för barnet förrän en kategori fått en gräns, och vuxenkategorin aldrig
  assert.equal((await api('/api/iptv/vod?kind=movie', { tok: kidTok })).status, 403);
  await api('/api/iptv/admin/groups', { method: 'PUT', body: { kind: 'movie', name: 'Action', age: 7 } });
  const v = (await api('/api/iptv/vod?kind=movie', { tok: kidTok })).data.items;
  assert.deepEqual(v.map(x => x.name), ['Testfilm (2024)']);
});

t('administratörens ändringar och dolda grupper finns kvar efter uppdatering av listan', async () => {
  assert.equal((await api(`/api/iptv/admin/channels/${S.k1}`, { method: 'PUT', body: { name: 'Ettan', number: '101' } })).status, 200);
  assert.equal((await api(`/api/iptv/sources/${S.m3u}/refresh`, { method: 'POST' })).status, 200);
  const k = (await api('/api/iptv/channels')).data.channels.find(c => c.id === S.k1);
  assert.equal(k.name, 'Ettan'); assert.equal(k.number, '101'); assert.equal(k.favorite, true);
  const adm = (await api('/api/iptv/admin/channels?q=Ettan')).data.channels[0];
  assert.equal(adm.original.name, 'Kanal Ett'); assert.equal(adm.changed.name, true);
  await api('/api/iptv/admin/groups', { method: 'PUT', body: { kind: 'live', name: 'Nyheter', hidden: true } });
  assert.ok(!(await api('/api/iptv/channels')).data.channels.some(c => c.id === S.k1));
  assert.ok(!(await api('/api/live/channels')).data.channels.some(c => c.id === S.k1));
  await api(`/api/iptv/sources/${S.m3u}/refresh`, { method: 'POST' });
  assert.ok(!(await api('/api/iptv/channels')).data.channels.some(c => c.id === S.k1), 'dold även efter uppdatering');
  await api('/api/iptv/admin/groups', { method: 'PUT', body: { kind: 'live', name: 'Nyheter', hidden: false } });
  assert.ok((await api('/api/iptv/channels')).data.channels.some(c => c.id === S.k1));
  // Tillbaka till listans namn
  await api(`/api/iptv/admin/channels/${S.k1}`, { method: 'PUT', body: { name: '', number: null } });
  assert.equal((await byName('Kanal Ett'))?.number, '1');
  // Bara administratörer (barnprofilen nekas)
  assert.equal((await api('/api/iptv/admin', { tok: kidTok })).status, 403);
  assert.equal((await api(`/api/iptv/admin/channels/${S.k1}`, { method: 'PUT', body: { name: 'X' }, tok: kidTok })).status, 403);
});

t('filmer och serier från Xtream: lista, detaljer, direktuppspelning med Range och avsnitt via HLS', async () => {
  const sh = (await api('/api/iptv/vod?kind=movie&shelves=1')).data;
  assert.ok(sh.shelves.some(s => s.key === 'added'));
  const film = (await api('/api/iptv/vod?kind=movie&q=testfilm')).data.items[0];
  assert.equal(film.name, 'Testfilm (2024)'); assert.equal(film.year, 2024);
  const d = (await api('/api/iptv/vod/' + film.id)).data;
  assert.equal(d.plot, 'En film om tester'); assert.equal(d.director, 'Cecilia'); assert.equal(d.duration, 8);
  let r = await api(`/api/iptv/vod/${film.id}/play`, { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.direct, true);
  assert.ok(!JSON.stringify(r.data).includes(PASS));
  const f = await api(r.data.url, { tok: '', headers: { range: 'bytes=0-99' } });
  assert.equal(f.status, 206); assert.equal(f.data.length, 100); assert.match(f.headers.get('content-range'), /^bytes 0-99\//);
  assert.equal((await api('/api/iptv/progress', { method: 'POST', body: { kind: 'movie', id: film.id, position: 3, duration: 8 } })).status, 200);
  assert.equal((await api('/api/iptv/vod/' + film.id)).data.progress.position, 3);
  // Serie: avsnitten hämtas när serien öppnas; MKV spelas via ffmpeg (HLS)
  const serie = (await api('/api/iptv/vod?kind=series')).data.items[0];
  const s = (await api('/api/iptv/vod/' + serie.id)).data;
  assert.equal(s.episodes.length, 1); assert.equal(s.episodes[0].title, 'Pilot');
  r = await api(`/api/iptv/episodes/${s.episodes[0].id}/play`, { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.direct, false);
  const pl = await api(r.data.url, { tok: '' });
  assert.equal(pl.status, 200, String(pl.data));
  assert.match(String(pl.data), /seg-\d+\.ts/);
  await api(`/api/iptv/play/${r.data.sid}/stop`, { method: 'POST' });
  // Vuxenkategorin: 18 år automatiskt
  const g = (await api('/api/iptv/admin')).data.movieGroups.find(x => x.name === 'XXX Adult');
  assert.equal(g.age, 18); assert.equal(g.auto, true);
});
