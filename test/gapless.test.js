// Glapplöst, övertoning och jämn ljudnivå (servern + webbens rena beräkningar i web/js/audiomix.js):
// trim-värden ur filhuvuden jämförs med ffmpegs avkodning, tystnad i kanterna mäts på genererade spår,
// albumets ljudnivå räknas ur spårens, inställningarna valideras och övergångsplanen följer reglerna.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-gapless-u-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const noFf = !hasFfmpeg && 'ffmpeg saknas';
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { maxBuffer: 1 << 28 });
/** Antal sampel ffmpeg avkodar (mono s16) */
const decoded = (f) => ff('-i', f, '-ac', '1', '-f', 's16le', '-').length / 2;

const { run, get } = await import('../server/db.js');
const G = await import('../server/gapless.js');
const L = await import('../server/listening.js');
const music = await import('../server/music.js');
const X = await import('../web/js/audiomix.js');
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const tone = (file, secs, sr, args) => ff('-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}:sample_rate=${sr}`, '-ac', '2', ...args, path.join(ROOT, file));

test('trim ur filhuvudet stämmer med ffmpegs avkodning (MP3 LAME, FLAC, Opus, Vorbis)', { skip: noFf }, async () => {
  const cases = [['cbr.mp3', 44100, ['-c:a', 'libmp3lame', '-b:a', '192k']], ['vbr.mp3', 44100, ['-c:a', 'libmp3lame', '-q:a', '4']],
    ['lsf.mp3', 22050, ['-ac', '1', '-c:a', 'libmp3lame', '-b:a', '48k']], ['a.flac', 44100, ['-c:a', 'flac']],
    ['a.opus', 48000, ['-c:a', 'libopus']], ['a.ogg', 44100, ['-c:a', 'libvorbis']]];
  for (const [f, sr, args] of cases) {
    tone(f, 3.3, sr, args);
    const r = await G.readTrim(path.join(ROOT, f));
    assert.equal(r.samples, decoded(path.join(ROOT, f)), f);
    assert.equal(r.samples, Math.round(3.3 * sr), f);
    assert.equal(r.sr, f.endsWith('.opus') ? 48000 : sr, f);
    if (f.endsWith('.mp3')) { assert.ok(r.skip >= 529 + 576 && r.pad >= 0, f + JSON.stringify(r)); }
  }
  // Med två ID3v2-taggar (en stor, som ett inbäddat omslag) före första ramen
  const id3 = (n) => { const h = Buffer.alloc(10 + n); h.write('ID3', 0, 'latin1'); h[3] = 3; [21, 14, 7, 0].forEach((sh, i) => { h[6 + i] = (n >> sh) & 0x7f; }); return h; };
  fs.writeFileSync(path.join(ROOT, 'id3.mp3'), Buffer.concat([id3(70000), id3(300), fs.readFileSync(path.join(ROOT, 'cbr.mp3'))]));
  assert.deepEqual(await G.readTrim(path.join(ROOT, 'id3.mp3')), await G.readTrim(path.join(ROOT, 'cbr.mp3')));
  assert.equal(await G.readTrim(path.join(ROOT, 'finns-inte.mp3')), null);
  fs.writeFileSync(path.join(ROOT, 'skräp.mp3'), Buffer.alloc(5000, 7));
  assert.equal(await G.readTrim(path.join(ROOT, 'skräp.mp3')), null);
});

test('AAC i MP4: redigeringslistan (ffmpeg) ger fördröjning, utfyllnad och exakt längd', { skip: noFf }, async () => {
  tone('a.m4a', 3.3, 44100, ['-c:a', 'aac', '-b:a', '128k']);
  const r = await G.readTrim(path.join(ROOT, 'a.m4a'));
  assert.equal(r.sr, 44100); assert.equal(r.samples, Math.round(3.3 * 44100)); assert.equal(r.skip, 1024);
  assert.equal((r.skip + r.samples + r.pad) % 1024, 0, 'hela ramar'); // det avkodaren lämnar = fördröjning + spåret + utfyllnad
  // ALAC har ingen fördröjning
  tone('alac.m4a', 1, 44100, ['-c:a', 'alac']);
  const al = await G.readTrim(path.join(ROOT, 'alac.m4a'));
  assert.equal(al.skip, 0); assert.equal(al.pad, 0);
});

// Minimal MP4 med iTunes-taggen iTunSMPB (som iTunes/Apple Music skriver) – byggs för hand
const box = (type, ...parts) => { const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
const u32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32BE(x, i * 4)); return b; };
test('AAC i MP4: iTunSMPB går före redigeringslistan', async () => {
  const frames = 200, raw = frames * 1024;
  const mdhd = box('mdhd', u32(0, 0, 0, 44100, raw), Buffer.alloc(4));
  const hdlr = box('hdlr', u32(0, 0), 'soun', Buffer.alloc(12));
  const stsd = box('stsd', u32(0, 1), box('mp4a', Buffer.alloc(28)));
  const stbl = box('stbl', stsd, box('stts', u32(0, 1, frames, 1024)), box('stsz', u32(0, 0, frames)));
  const trak = box('trak', box('mdia', mdhd, hdlr, box('minf', stbl)));
  const smpb = ' 00000000 00000840 000001CA 000000000003167E 00000000 00000000';
  const ilst = box('ilst', box('----', box('mean', u32(0), 'com.apple.iTunes'), box('name', u32(0), 'iTunSMPB'), box('data', u32(1, 0), smpb)));
  const moov = box('moov', box('mvhd', u32(0, 0, 0, 1000, 4600), Buffer.alloc(80)), trak, box('udta', box('meta', u32(0), ilst)));
  const f = path.join(ROOT, 'itunes.m4a');
  fs.writeFileSync(f, Buffer.concat([box('ftyp', 'M4A ', u32(0), 'M4A mp42isom'), box('mdat', Buffer.alloc(64)), moov]));
  assert.deepEqual(await G.readTrim(f), { sr: 44100, samples: 0x3167e, skip: 0x840, pad: raw - 0x840 - 0x3167e });
});

test('tystnad i kanterna: silencedetect tolkas för båda ffmpeg-varianterna', () => {
  assert.deepEqual(G.parseSilence('[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 1.502 | silence_duration: 1.502\n[silencedetect @ 0x1] silence_start: 27.9\n', 30), { head: 1.5, tail: 2.1 });
  // Nyare ffmpeg rapporterar slutet vid filens slut
  assert.deepEqual(G.parseSilence('silence_start: 27.9\nsilence_end: 30 | silence_duration: 2.1\n', 30), { head: 0, tail: 2.1 });
  assert.deepEqual(G.parseSilence('silence_start: 10\nsilence_end: 11 | silence_duration: 1\n', 30), { head: 0, tail: 0 });
  assert.deepEqual(G.parseSilence('', 30), { head: 0, tail: 0 });
  assert.deepEqual(G.parseSilence('silence_start: 0\n', 30), { head: 30, tail: 30 });
});

test('tystnad i kanterna mäts på korta och långa spår', { skip: noFf }, async () => {
  const mk = (f, head, secs, tail) => ff('-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}:sample_rate=44100`, '-af', `adelay=${head * 1000}:all=1,apad=pad_dur=${tail}`, '-c:a', 'flac', path.join(ROOT, f));
  mk('kort.flac', 1.5, 3, 2);
  const k = await G.measureEdges(path.join(ROOT, 'kort.flac'), 6.5);
  assert.ok(Math.abs(k.head - 1.5) < 0.05 && Math.abs(k.tail - 2) < 0.05, JSON.stringify(k));
  mk('lang.flac', 0, 70, 4);
  const l = await G.measureEdges(path.join(ROOT, 'lang.flac'), 74);
  assert.ok(l.head < 0.05 && Math.abs(l.tail - 4) < 0.1, JSON.stringify(l));
});

test('bakgrundsjobbet sparar trim och tystnad; skanningen nollställer vid ändrad fil; API:t visar dem', { skip: noFf }, async () => {
  const dir = path.join(ROOT, 'musik', 'Artist', 'Album'); fs.mkdirSync(dir, { recursive: true });
  for (const n of [1, 2]) ff('-f', 'lavfi', '-i', `sine=frequency=${300 * n}:duration=2:sample_rate=44100`, '-af', 'apad=pad_dur=1.5', '-c:a', 'libmp3lame', '-b:a', '128k',
    '-metadata', `title=Låt ${n}`, '-metadata', 'artist=Artist', '-metadata', 'album=Album', '-metadata', `track=${n}`,
    '-metadata', `REPLAYGAIN_TRACK_GAIN=${-3 * n} dB`, '-metadata', 'REPLAYGAIN_TRACK_PEAK=0.7', path.join(dir, `0${n}.mp3`));
  run("INSERT INTO libraries(id,name,type,path) VALUES(5,'Musik','music',?)", path.join(ROOT, 'musik'));
  const lib = get('SELECT * FROM libraries WHERE id=5');
  process.env.MUSIC_LOUDNESS = '0';
  await music.scanMusic(lib, {});
  await G.runAll();
  const al = get('SELECT id, rg_gain, rg_peak FROM albums WHERE library_id=5');
  // Albumets nivå ur spårens taggar (−3 och −6 dB, lika långa) och högsta toppen
  assert.ok(Math.abs(al.rg_gain - L.albumLoudness([{ gain: -3, duration: 1 }, { gain: -6, duration: 1 }]).gain) < 0.01, String(al.rg_gain));
  assert.equal(al.rg_peak, 0.7);
  const a = music.album(al.id, 1);
  const t1 = a.trackList[0];
  assert.equal(t1.gain, -3); assert.equal(t1.albumGain, al.rg_gain); assert.equal(t1.albumPeak, 0.7);
  assert.equal(t1.gapless.sampleRate, 44100);
  assert.equal(t1.gapless.samples, Math.round(3.5 * 44100));
  assert.ok(t1.gapless.skip > 529);
  assert.ok(Math.abs(t1.gapless.silenceEnd - 1.5) < 0.1 && t1.gapless.silenceStart < 0.05, JSON.stringify(t1.gapless));
  // Ändrad fil → gl nollställs och räknas om
  ff('-f', 'lavfi', '-i', 'sine=frequency=500:duration=2.5', '-c:a', 'libmp3lame', '-metadata', 'title=Låt 1', '-metadata', 'artist=Artist', '-metadata', 'album=Album',
    '-metadata', 'track=1', path.join(dir, '01.mp3'));
  fs.utimesSync(path.join(dir, '01.mp3'), new Date(), new Date(Date.now() + 5000));
  await music.scanMusic(lib, {});
  assert.equal(get('SELECT gl FROM tracks WHERE id=?', t1.id).gl, null);
  await G.runAll();
  assert.equal(music.album(al.id, 1).trackList[0].gapless.samples, decoded(path.join(dir, '01.mp3')));
});

test('omkodning med gl=1 ger FLAC utan fördröjning (exakt längd)', { skip: noFf }, async () => {
  const wav = path.join(ROOT, 'a.wav');
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2345:sample_rate=44100', '-c:a', 'pcm_s16le', wav);
  const srv = http.createServer((req, res) => music.streamTrack(req, res, { path: wav, codec: 'pcm_s16le' }, new URL(req.url, 'http://x').searchParams, 1));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/?a=mp3,flac&gl=1`);
    assert.equal(r.headers.get('content-type'), 'audio/flac'); assert.equal(r.headers.get('x-transcoded'), '1');
    const f = path.join(ROOT, 'ut.flac'); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    assert.equal(decoded(f), Math.round(1.2345 * 44100));
    const r2 = await fetch(`http://127.0.0.1:${srv.address().port}/?a=mp3,flac`);
    assert.equal(r2.headers.get('content-type'), 'audio/mpeg'); await r2.arrayBuffer();
  } finally { srv.close(); }
});

test('albumets ljudnivå: energimedel viktat med längden', () => {
  assert.equal(L.albumLoudness([]), null);
  assert.equal(L.albumLoudness([{ gain: -3, duration: 10 }, { gain: null, duration: 10 }]), null);
  assert.deepEqual(L.albumLoudness([{ gain: -6, peak: 0.9, duration: 100 }, { gain: -6, peak: 0.5, duration: 50 }]), { gain: -6, peak: 0.9 });
  // −12 och −6 LUFS lika långa → 10·log10((10^−1,2 + 10^−0,6)/2) ≈ −8,04 LUFS → gain −9,96
  assert.equal(L.albumLoudness([{ gain: -6, duration: 100 }, { gain: -12, duration: 100 }]).gain, -9.96);
  assert.deepEqual(L.parseReplayGain({ REPLAYGAIN_ALBUM_PEAK: '0.99' }).albumPeak, 0.99);
});

test('lyssningsinställningar: läge för jämn ljudnivå, glapplöst och övertoning', () => {
  const p = L.getPrefs(1);
  assert.equal(p.normMode, 'track'); assert.equal(p.gapless, true); assert.equal(p.crossfade, 0); assert.equal(p.normalize, true);
  assert.deepEqual(p.choices.crossfade, [0, 2, 4, 6, 8, 10, 12]);
  let q = L.setPrefs(1, { normMode: 'album', crossfade: 6, gapless: false });
  assert.equal(q.normMode, 'album'); assert.equal(q.crossfade, 6); assert.equal(q.gapless, false);
  q = L.setPrefs(1, { normMode: 'off' });
  assert.equal(q.normalize, false); assert.equal(q.normMode, 'off');
  q = L.setPrefs(1, { normalize: true }); // apparna slår på igen – albumläget är kvar
  assert.equal(q.normMode, 'album');
  assert.throws(() => L.setPrefs(1, { crossfade: 5 }), /övertoningen/);
  assert.throws(() => L.setPrefs(1, { normMode: 'konstigt' }), /ljudnivå/);
  assert.equal(L.setPrefs(1, { skipBack: 30 }).crossfade, 6); // andra fält rörs inte
});

test('webbens beräkningar: förstärkning, trim, samma album och övergångsplan', () => {
  const t = { gain: -6, albumGain: -9, peak: 0.5 };
  assert.ok(Math.abs(X.gainFor(t, 'track') - 10 ** (-6 / 20)) < 1e-9);
  assert.ok(Math.abs(X.gainFor(t, 'album') - 10 ** (-9 / 20)) < 1e-9);
  assert.equal(X.gainFor(t, 'off'), 1);
  assert.equal(X.gainFor({ gain: 12, peak: 0.5 }, 'track'), 2); // toppvärdet: aldrig över 0 dBFS
  assert.equal(X.gainFor({ gain: 20 }, 'track'), 4); // högst +12 dB
  assert.equal(X.gainFor({ albumGain: -6 }, 'track'), 10 ** (-6 / 20)); // spårvärde saknas → albumets
  assert.equal(X.gainFor({ gain: 6, albumPeak: 0.8 }, 'album'), 1 / 0.8);
  assert.equal(X.gainFor({}, 'track'), 1);
  // Trim: webbläsaren har redan trimmat / inte trimmat / bara början / okänt; omräknat till buffertens takt
  const gl = { sampleRate: 44100, samples: 145530, skip: 1105, pad: 821 };
  assert.deepEqual(X.trimFor(145530, 44100, gl), { front: 0, back: 0 });
  assert.deepEqual(X.trimFor(145530 + 1105 + 821, 44100, gl), { front: 1105, back: 821 });
  assert.deepEqual(X.trimFor(145530 + 821, 44100, gl), { front: 0, back: 821 });
  assert.deepEqual(X.trimFor(145530 + 1105, 44100, gl), { front: 1105, back: 0 });
  const r = 48000 / 44100;
  const len48 = Math.round((145530 + 1105 + 821) * r), t48 = X.trimFor(len48, 48000, gl);
  assert.equal(t48.front, Math.round(1105 * r));
  assert.ok(Math.abs(len48 - t48.front - t48.back - 145530 * r) <= 1, JSON.stringify(t48));
  assert.deepEqual(X.trimFor(145530 + 372, 44100, { sampleRate: 44100, samples: 145530, skip: 0, pad: 0 }), { front: 0, back: 372 }); // Vorbis
  assert.deepEqual(X.trimFor(1000, 44100, null), { front: 0, back: 0 });
  // Samma album i ordning (även skivbyte)
  assert.equal(X.continues({ albumId: 1, disc: 1, track: 3 }, { albumId: 1, disc: 1, track: 4 }), true);
  assert.equal(X.continues({ albumId: 1, disc: 1, track: 9 }, { albumId: 1, disc: 2, track: 1 }), true);
  assert.equal(X.continues({ albumId: 1, disc: 1, track: 3 }, { albumId: 1, disc: 1, track: 5 }), false);
  assert.equal(X.continues({ albumId: 1, track: 3 }, { albumId: 2, track: 4 }), false);
  // Övergången
  const A = { albumId: 1, track: 1 }, A2 = { albumId: 1, track: 2 }, B = { albumId: 2, track: 1 };
  assert.deepEqual(X.planTransition(A, A2, 200, 200, { crossfade: 6 }), { overlap: 0, curEnd: 200, nextStart: 0, kind: 'gapless' });
  assert.deepEqual(X.planTransition(A, B, 200, 200, { crossfade: 0 }), { overlap: 0, curEnd: 200, nextStart: 0, kind: 'gapless' });
  assert.deepEqual(X.planTransition(A, B, 200, 200, { crossfade: 6 }), { overlap: 6, curEnd: 200, nextStart: 0, kind: 'crossfade' });
  // Kort tystnad i slutet → halva längden, från ljudets slut; tystnad i början av nästa hoppas över
  const As = { ...A, gapless: { silenceEnd: 0.5 } }, Bs = { ...B, gapless: { silenceStart: 0.8 } };
  assert.deepEqual(X.planTransition(As, Bs, 200, 200, { crossfade: 6 }), { overlap: 3, curEnd: 199.5, nextStart: 0.8, kind: 'crossfade' });
  // Spåret slutar redan i tystnad → ingen övertoning, bara kortare paus (högst 0,5 s + 0,1 s)
  const Al = { ...A, gapless: { silenceEnd: 4 } };
  assert.deepEqual(X.planTransition(Al, Bs, 200, 200, { crossfade: 6 }), { overlap: 0, curEnd: 196.5, nextStart: 0.8 - 0.1, kind: 'trim' });
  // Korta spår: högst en tredjedel
  assert.equal(X.planTransition(A, B, 9, 200, { crossfade: 6 }).overlap, 3);
  const c = X.fadeCurve(true, 5), d = X.fadeCurve(false, 5);
  assert.equal(c[0], 1); assert.ok(Math.abs(d[4] - 1) < 1e-6);
  for (let i = 0; i < 5; i++) assert.ok(Math.abs(c[i] ** 2 + d[i] ** 2 - 1) < 1e-6, 'lika effekt');
});
