// Lyssningsfunktioner: ReplayGain/ljudstyrka, låttexter (LRC och taggar), smarta spellistor och inställningar per användare
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-listen-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);

const { run, get } = await import('../server/db.js');
const L = await import('../server/listening.js');
const music = await import('../server/music.js');
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(2,'bo','x',0,0)");
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('ReplayGain: taggar, R128 och orimliga värden', () => {
  assert.deepEqual(L.parseReplayGain({ REPLAYGAIN_TRACK_GAIN: '-7.89 dB', REPLAYGAIN_ALBUM_GAIN: '-8,5 dB', REPLAYGAIN_TRACK_PEAK: '0.988' }),
    { track: -7.89, album: -8.5, peak: 0.988 });
  assert.deepEqual(L.parseReplayGain({ replaygain_track_gain: '+2.10 dB' }), { track: 2.1, album: null, peak: null });
  // Opus: Q7.8 mot -23 LUFS → +5 dB till ReplayGain-referensen
  assert.deepEqual(L.parseReplayGain({ R128_TRACK_GAIN: '-512', R128_ALBUM_GAIN: '256' }), { track: 3, album: 6, peak: null });
  assert.deepEqual(L.parseReplayGain({ replaygain_track_gain: 'skräp', replaygain_track_peak: '-1' }), { track: null, album: null, peak: null });
  assert.deepEqual(L.parseReplayGain({ replaygain_track_gain: '-99 dB' }), { track: null, album: null, peak: null });
  assert.deepEqual(L.parseReplayGain(undefined), { track: null, album: null, peak: null });
});

test('ebur128-sammanfattning tolkas till gain mot -18 LUFS', () => {
  const out = `[Parsed_ebur128_0 @ 0x1] t: 1 M: -20 S: -20 I: -30.0 LUFS\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -9.5 LUFS\n    Threshold: -19.6 LUFS\n\n  Sample peak:\n    Peak:      -0.5 dBFS\n`;
  const r = L.parseEbur128(out);
  assert.equal(r.lufs, -9.5);
  assert.equal(r.gain, -8.5);
  assert.ok(Math.abs(r.peak - 0.9441) < 0.001);
  assert.equal(L.parseEbur128('ingen sammanfattning'), null);
  assert.equal(L.parseEbur128('Summary:\n I: -inf LUFS'), null);
  assert.equal(L.parseEbur128('Summary:\n I: -120.7 LUFS'), null); // tystnad förstärks inte
});

test('LRC: tidsstämplar, flera per rad, offset, metadata och ordtider', () => {
  const r = L.parseLrc('﻿[ar:Artist]\r\n[ti:Titel]\n[offset:+500]\n[00:12.00][01:02.50]Refräng\n[00:05.5]Första <00:05.80>raden\n[00:20:30]Kolon-variant\nlös rad\n');
  assert.equal(r.synced, true);
  assert.deepEqual(r.lines, [{ t: 5, text: 'Första raden' }, { t: 11.5, text: 'Refräng' }, { t: 19.8, text: 'Kolon-variant' }, { t: 62, text: 'Refräng' }]);
  const neg = L.parseLrc('[offset:-1000]\n[00:01.00]a');
  assert.deepEqual(neg.lines, [{ t: 2, text: 'a' }]);
  const tom = L.parseLrc('[00:00.00]\n[00:03.00]Text');
  assert.deepEqual(tom.lines.map(l => l.text), ['', 'Text']);
});

test('LRC: vanlig text blir osynkad, tomrader i kanterna tas bort', () => {
  const r = L.parseLrc('\n\nRad ett\n\nRad två\n\n');
  assert.equal(r.synced, false);
  assert.deepEqual(r.lines, [{ t: null, text: 'Rad ett' }, { t: null, text: '' }, { t: null, text: 'Rad två' }]);
  assert.deepEqual(L.parseLrc('').lines, []);
  assert.deepEqual(L.parseLrc(null).lines, []);
});

test('smarta spellistor per användare', () => {
  const t0 = 1_800_000_000, DAY = 86400;
  run("INSERT INTO libraries(id,name,type,path) VALUES(20,'Smart','music','/finns/inte')");
  run("INSERT INTO artists(id,library_id,name,sort_name) VALUES(20,20,'A','a')");
  run("INSERT INTO albums(id,library_id,artist_id,title,sort_title,added) VALUES(20,20,20,'Album','album',0)");
  for (let i = 1; i <= 6; i++) run('INSERT INTO tracks(id,library_id,album_id,artist_id,title,track_no,disc_no,path,added) VALUES(?,20,20,20,?,?,1,?,?)', 100 + i, `Låt ${i}`, i, `/x/${i}.mp3`, t0 - (7 - i) * DAY);
  const play = (uid, tid, ago) => run('INSERT INTO track_plays(user_id,track_id,ts) VALUES(?,?,?)', uid, tid, t0 - ago * DAY);
  play(1, 101, 1); play(1, 101, 2); play(1, 101, 3); play(1, 102, 5); play(1, 103, 90); play(2, 104, 1);
  run('INSERT INTO favorites(user_id,track_id) VALUES(1,103),(1,104),(1,101)');
  const ids = (id, uid = 1) => L.smartTracks(20, uid, id, { at: t0 }).map(t => t.id);
  assert.deepEqual(ids('top30'), [101, 102]); // 103 spelades för 90 dagar sedan, 104 av en annan användare
  assert.deepEqual(ids('top30', 2), [104]);
  assert.deepEqual(ids('forgotten'), [104, 103]); // aldrig spelad först, sedan längst sedan; 101 spelades nyss
  assert.deepEqual(ids('recent').slice(0, 3), [106, 105, 104]);
  assert.deepEqual(ids('never').sort(), [104, 105, 106]);
  assert.deepEqual(ids('never', 2).sort(), [101, 102, 103, 105, 106]);
  assert.equal(L.smartTracks(20, 1, 'okänd'), null);
  const fav = L.smartTracks(20, 1, 'forgotten', { at: t0 });
  assert.equal(fav[0].favorite, true);
  const lists = L.smartLists(20, 2);
  assert.ok(lists.every(l => l.count > 0 && l.name));
  assert.ok(!lists.some(l => l.id === 'forgotten')); // bo har inga favoriter
});

test('lyssningsinställningar: standard, sparas och valideras', () => {
  assert.deepEqual({ ...L.getPrefs(1), choices: undefined, reference: undefined },
    { normalize: true, skipBack: 15, skipForward: 30, skipSilence: false, choices: undefined, reference: undefined });
  const p = L.setPrefs(1, { skipBack: 10, skipForward: '45', skipSilence: true, normalize: false });
  assert.equal(p.skipBack, 10); assert.equal(p.skipForward, 45); assert.equal(p.skipSilence, true); assert.equal(p.normalize, false);
  assert.equal(L.setPrefs(1, { skipBack: 30 }).skipForward, 45); // andra fält behålls
  assert.throws(() => L.setPrefs(1, { skipBack: 7 }), /bakåt/);
  assert.throws(() => L.setPrefs(1, { skipForward: 1e9 }), /framåt/);
  assert.equal(L.getPrefs(2).skipBack, 15); // per användare
});

test('låttexter: .lrc bredvid filen går före inbäddad text', { skip: !hasFfmpeg }, async () => {
  const dir = path.join(ROOT, 'lyr'); fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, 'a.mp3'), b = path.join(dir, 'b.flac'), c = path.join(dir, 'c.mp3');
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-metadata', 'lyrics=Inbäddad', a);
  fs.writeFileSync(path.join(dir, 'a.lrc'), '[00:00.50]Från LRC\n');
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-metadata', 'LYRICS=Rad 1\nRad 2', b);
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', c);
  assert.deepEqual(await L.lyricsFor({ path: a }), { source: 'lrc', synced: true, lines: [{ t: 0.5, text: 'Från LRC' }] });
  const eb = await L.lyricsFor({ path: b });
  assert.equal(eb.source, 'tag'); assert.equal(eb.synced, false); assert.deepEqual(eb.lines.map(l => l.text), ['Rad 1', 'Rad 2']);
  assert.deepEqual(await L.lyricsFor({ path: c }), { source: null, synced: false, lines: [] });
  assert.deepEqual(await L.lyricsFor({ path: path.join(dir, 'saknas.mp3') }), { source: null, synced: false, lines: [] });
});

test('skanning: ReplayGain-taggar sparas, otaggade spår mäts i bakgrunden', { skip: !hasFfmpeg }, async () => {
  const lib = path.join(ROOT, 'music'), d = path.join(lib, 'Artist', 'Album'); fs.mkdirSync(d, { recursive: true });
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-metadata', 'title=Taggad', '-metadata', 'REPLAYGAIN_TRACK_GAIN=-6.50 dB', '-metadata', 'REPLAYGAIN_TRACK_PEAK=0.5', path.join(d, '01 - Taggad.flac'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-metadata', 'title=Otaggad', path.join(d, '02 - Otaggad.flac'));
  run("INSERT INTO libraries(id,name,type,path) VALUES(21,'Musik','music',?)", lib);
  const prev = process.env.MUSIC_LOUDNESS; process.env.MUSIC_LOUDNESS = '0'; // mät inte under själva skanningen
  try { await music.scanMusic(get('SELECT * FROM libraries WHERE id=21'), {}); } finally { if (prev === undefined) delete process.env.MUSIC_LOUDNESS; else process.env.MUSIC_LOUDNESS = prev; }
  const alb = music.album(get("SELECT id FROM albums WHERE library_id=21").id, 1);
  const tagged = alb.trackList.find(t => t.title === 'Taggad'), plain = alb.trackList.find(t => t.title === 'Otaggad');
  assert.equal(tagged.gain, -6.5); assert.equal(tagged.peak, 0.5);
  assert.equal(plain.gain, null);
  assert.equal(get('SELECT loudness FROM tracks WHERE id=?', tagged.id).loudness, 'tag');
  await L.scheduleLoudness(10);
  const row = get('SELECT rg_track, rg_peak, loudness FROM tracks WHERE id=?', plain.id);
  assert.equal(row.loudness, 'mätt');
  // Sinus med amplitud 1/8 ≈ -21 LUFS → ungefär +3 dB mot -18 LUFS
  assert.ok(row.rg_track > 1 && row.rg_track < 6, String(row.rg_track));
  assert.ok(row.rg_peak > 0.1 && row.rg_peak < 0.15, String(row.rg_peak));
  // Spår från tidigare versioner (aldrig kontrollerade) med taggar läses från taggarna
  run('UPDATE tracks SET rg_track=NULL, loudness=NULL WHERE id=?', tagged.id);
  await L.scheduleLoudness(10);
  assert.equal(get('SELECT rg_track, loudness FROM tracks WHERE id=?', tagged.id).loudness, 'tag');
  assert.equal(get('SELECT rg_track FROM tracks WHERE id=?', tagged.id).rg_track, -6.5);
});
