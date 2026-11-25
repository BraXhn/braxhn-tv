// Windows-appens inbyggda spelare (mpv, apps/windows): när webben lämnar över till den och vad den får veta
// (web/js/player/nativeplan.js), och att serverns beslut (stream.js decide) med spelarens förmågor ger
// direktuppspelning av originalfilen – men inte när servern måste ändra något.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-native-'));
process.env.TRANSCODE_DIR = path.join(process.env.CONFIG_DIR, 'tc');
const st = await import('../server/stream.js');
const { NATIVE_CAPS, inWindowsApp, nativePlan, nativeQuery, progressBody } = await import('../web/js/player/nativeplan.js');

const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0 BraXhnTV-Windows/1.4.0';
const webview = { chrome: { webview: { postMessage() {} } } };

test('bara i Windows-appen: user agent och WebView2:s meddelandekanal', () => {
  assert.equal(inWindowsApp(WIN_UA, webview), true);
  assert.equal(inWindowsApp(WIN_UA.replace(' BraXhnTV-Windows/1.4.0', ''), webview), false, 'Edge utan appen');
  assert.equal(inWindowsApp(WIN_UA, {}), false, 'appens user agent utan meddelandekanal');
  assert.equal(inWindowsApp('BraXhnTV-Android', webview), false);
});

test('frågan till /playback: allt spelas direkt, spelaren väljer ljudspår, token i länken, bandbredd utanför hemmet', () => {
  const q = new URLSearchParams(nativeQuery({ start: 754.8, audio: 2, version: 41, q: 'auto', bw: 9000, save: false, cinema: false }));
  assert.equal(q.get('atrack'), '1');
  assert.equal(q.get('cast'), '1');
  assert.equal(q.get('start'), '754');
  assert.equal(q.get('audio'), '2');
  assert.equal(q.get('version'), '41');
  assert.equal(q.get('bw'), '9000');
  assert.equal(q.get('q'), null, 'Auto = kontots val');
  assert.equal(q.get('ffc'), null, 'mpv tystar inte själv – servern ska veta det');
  for (const c of ['dts', 'truehd', 'eac3', 'flac']) assert.ok(q.get('a').split(',').includes(c), c);
  assert.equal(new URLSearchParams(nativeQuery({ q: '720', cinema: true })).get('q'), '720');
});

// En typisk film från en Blu-ray: HEVC 10 bitar HDR10 i MKV med DTS-HD och TrueHD, PGS-undertext
const item = {
  id: 9001, path: '/media/film/Film (2024).mkv', size: 30e9, duration: 7200, hdr: 'hdr10', mtime: 1,
  streams: JSON.stringify([
    { type: 'video', index: 0, codec: 'hevc', width: 3840, height: 2160, pix: 'yuv420p10le' },
    { type: 'audio', index: 1, codec: 'truehd', channels: 8, lang: 'eng', default: true },
    { type: 'audio', index: 2, codec: 'dts', channels: 6, lang: 'swe' },
    { type: 'subtitle', index: 3, codec: 'hdmv_pgs_subtitle', lang: 'swe' }
  ])
};

test('serverns beslut: originalfilen direkt till mpv, hemma även 4K HDR med TrueHD och ett annat ljudspår', () => {
  const o = { ...st.parseCaps(new URLSearchParams(nativeQuery({ audio: 2 }))), assumeKf: true };
  const d = st.decide(item, o);
  assert.equal(d.mode, 'direct', d.reasons.join(', '));
  assert.equal(d.audio, '2');
  // Samma fil i webbläsaren (Chrome/Edge: mp4/webm, AAC) går inte att skicka direkt
  const web = st.decide(item, { ...st.parseCaps(new URLSearchParams({ c: 'mp4,webm', v: 'h264,hevc,vp9', a: 'aac,mp3,opus,flac', hdr: '1' })), assumeKf: true, mse: true });
  assert.notEqual(web.mode, 'direct');
});

test('serverns beslut: inte direkt när servern måste ändra något – då spelar webbspelaren', () => {
  const caps = () => ({ ...st.parseCaps(new URLSearchParams(nativeQuery({}))), assumeKf: true });
  assert.notEqual(st.decide(item, { ...caps(), q: '1080' }).mode, 'direct', 'lägre kvalitet');
  assert.notEqual(st.decide(item, { ...caps(), mute: [[10, 12]] }).mode, 'direct', 'familjefiltret tystar');
  assert.notEqual(st.decide(item, { ...caps(), force: 'transcode' }).mode, 'direct', 'för låg bandbredd utanför hemmet');
  assert.notEqual(st.decide({ ...item, path: '/media/film/Gammal.avi' }, caps()).mode, 'direct', 'filformat som inte skickas direkt');
});

const it = {
  id: 9001, kind: 'episode', showTitle: 'Bamse', season: 1, episode: 2, title: 'Skattkistan', duration: 1500, nextId: 9002, version: 9001,
  subtitles: [{ id: 'e3', label: 'swe (bild)', lang: 'swe' }, { id: 'x0', label: 'sv (fil)', lang: 'sv' }, { id: 'd0', label: 'en (nedladdad)', lang: 'en' }]
};
const pb = {
  mode: 'direct', url: '/api/stream/9001/direct?t=abc', token: 'abc', duration: 1500, audioSelected: 2, autoNext: { enabled: true, countdown: 10 },
  subtitles: [{ id: 'x0', url: '/api/stream/9001/subs/x0.vtt?t=abc' }], chapters: [{ start: 0, title: 'Början' }]
};

test('överlämningen: länk med token, ljudspår, undertexter (inbäddade läser mpv själv) och nästa avsnitt', () => {
  const p = nativePlan(it, pb, { start: 30, origin: 'https://tv.braxhn.net', sub: 'x0' });
  assert.equal(p.use, true);
  const m = p.msg;
  assert.equal(m.t, 'native-play');
  assert.equal(m.url, 'https://tv.braxhn.net/api/stream/9001/direct?t=abc');
  assert.equal(m.title, 'Bamse · S01E02 · Skattkistan');
  assert.equal(m.start, 30);
  assert.equal(m.audio, 2);
  assert.equal(m.sub, 'x0');
  assert.deepEqual(m.subs.map(s => [s.id, s.index ?? null, s.url ?? null]),
    [['e3', 3, null], ['x0', null, 'https://tv.braxhn.net/api/stream/9001/subs/x0.vtt?t=abc']], 'utan länk och inte inbäddad: tas inte med');
  assert.equal(m.nextId, 9002);
  assert.equal(m.autoNext, true);
  assert.equal(nativePlan(it, pb, { origin: 'https://tv.braxhn.net', sub: 'zz' }).msg.sub, '', 'okänd undertext = ingen');
});

test('överlämningen: webbspelaren spelar vid omkodning, familjefilter, trailers och utan token', () => {
  const o = { origin: 'https://tv.braxhn.net' };
  assert.equal(nativePlan(it, { ...pb, mode: 'transcode' }, o).use, false);
  assert.equal(nativePlan(it, { ...pb, mode: 'remux' }, o).use, false);
  assert.equal(nativePlan(it, { ...pb, filter: { mute: [[1, 2]], skip: [] } }, o).use, false);
  assert.equal(nativePlan(it, { ...pb, preroll: [{ url: '/x' }] }, o).use, false);
  assert.equal(nativePlan(it, { ...pb, token: null }, o).use, false);
  assert.equal(nativePlan(it, null, o).use, false);
});

test('framsteget: samma kropp som webbspelaren skickar', () => {
  assert.deepEqual(JSON.parse(progressBody(61.5, 1500)), { position: 61.5, duration: 1500 });
  assert.deepEqual(JSON.parse(progressBody(-3, null)), { position: 0, duration: 0 });
  assert.ok(Object.keys(NATIVE_CAPS).includes('cast'));
});

test('webbspelaren frågar bara den inbyggda spelaren i Windows-appen och inte i Titta tillsammans', () => {
  const src = fs.readFileSync(new URL('../web/js/player/video.js', import.meta.url), 'utf8');
  const hook = src.slice(src.indexOf('const partyId = opts.party'), src.indexOf('const keepParty'));
  assert.match(hook, /if \(!partyId && !opts\.noNative && inWindowsApp\(\)\)/);
  assert.match(hook, /playNative\(/);
  const sw = fs.readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
  assert.ok(sw.includes("'player/native.js'") && sw.includes("'player/nativeplan.js'"), 'modulerna finns i MODULES');
});
