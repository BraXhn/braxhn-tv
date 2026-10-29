// Musikvideor och synkade låttexter: SYLT/USLT ur ID3 (egen läsare, server/lyricstags.js), LYRICS-taggar i FLAC med
// ordtider, .lrc, valet mellan egen osynkad text och LRCLIB:s synkade (låtsasserver), och musikvideor i musikbiblioteket
// (server/musicvideos.js): samma namn som ljudfilen, Plex-suffix, videomapp i artistmappen, "Artist - Låt (Official Video)",
// ljud-mp4 som inte är video, video utan känd artist, API:t (album, artist, låtarnas video-fält), ström med Range,
// mediatoken som bara gäller en video, stillbild, bibliotek per användare och borttagning vid skanning.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-mvly-'));
const MEDIA = path.join(ROOT, 'media');
Object.assign(process.env, { CONFIG_DIR: path.join(ROOT, 'config'), TRANSCODE_DIR: path.join(ROOT, 'tc'), MEDIA_ROOT: MEDIA, WATCH_FILES: '0',
  MUSIC_LOUDNESS: '0', MUSIC_SONIC: '0', SCROBBLE_INTERVAL: '0', CALENDAR_REFRESH: '0', DVR_DIR: path.join(ROOT, 'rec'), PODCAST_DIR: path.join(ROOT, 'pod'),
  MUSIC_META: '0', MUSIC_META_GAP_MS: '0', MUSICBRAINZ_GAP_MS: '0' });
fs.mkdirSync(MEDIA, { recursive: true });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

// ---------- låtsas-LRCLIB ----------
const lrcLog = [];
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x'), P = u.searchParams;
  lrcLog.push(u.pathname + '?' + P.get('track_name'));
  const json = (v, code = 200) => { r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(v)); };
  if (u.pathname === '/lrc/get' && P.get('track_name') === 'Tredje')
    return json({ id: 5, trackName: 'Tredje', artistName: 'Artisten', duration: 3, plainLyrics: 'Nätrad', syncedLyrics: '[00:00.40]Nätrad ett\n[00:01.20]Nätrad två' });
  if (u.pathname === '/lrc/get' && P.get('track_name') === 'Fjärde')
    return json({ id: 6, trackName: 'Fjärde', artistName: 'Artisten', duration: 3, plainLyrics: 'Bara vanlig text från nätet', syncedLyrics: null });
  if (u.pathname === '/lrc/search') return json([]);
  json({ code: 404 }, 404);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
process.env.LRCLIB_URL = `http://127.0.0.1:${srv.address().port}/lrc`;

const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const music = await import('../server/music.js');
const L = await import('../server/listening.js');
const LT = await import('../server/lyricstags.js');
const MV = await import('../server/musicvideos.js');
const app = await import('../server/app.js');
const web = http.createServer(app.handle);
await new Promise(r => web.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${web.address().port}`;
after(() => { srv.close(); web.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const ANNA = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('anna','x',1,0)").lastInsertRowid);
const BO = Number(D.run("INSERT INTO users(name,pass,is_admin,created,libraries) VALUES('bo','x',0,0,'[]')").lastInsertRowid);
const tok = { [ANNA]: auth.createSession(ANNA, 'app'), [BO]: auth.createSession(BO, 'app') };
async function api(uid, p, { headers = {} } = {}) {
  const r = await fetch(B + p, { headers: { ...(uid ? { Authorization: `Bearer ${tok[uid]}` } : {}), ...headers } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

// ---------- bibliotek ----------
let LIB = 0;
const ID = {};
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const tone = (out, enc, tags = {}) => { fs.mkdirSync(path.dirname(out), { recursive: true });
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ac', '1', ...enc, ...Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]), out); };
const MP3_NOTAG = ['-c:a', 'libmp3lame', '-b:a', '32k', '-id3v2_version', '0', '-write_id3v1', '0'];
const video = (out, secs = 2, extra = []) => { fs.mkdirSync(path.dirname(out), { recursive: true });
  ff('-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=600:duration=${secs}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...extra, out); };
/** MP3 med egen ID3v2.3-tagg (SYLT/USLT) först – ffmpeg skriver inte SYLT */
function mp3WithId3(out, id3, tags) {
  const raw = out + '.raw.mp3';
  tone(raw, MP3_NOTAG);
  // Titel/artist/album via ID3 skrivs av buildId3 bara för titeln – resten tas från mappstrukturen
  fs.writeFileSync(out, Buffer.concat([LT.buildId3({ ...id3, title: tags.title }), fs.readFileSync(raw)]));
  fs.rmSync(raw);
}
if (hasFfmpeg) {
  const M = path.join(MEDIA, 'Musik'), A = path.join(M, 'Artisten'), AL = path.join(A, 'Albumet');
  mp3WithId3(path.join(AL, '01 - Första.mp3'), { sylt: [[300, 'SYLT ett'], [1500, 'SYLT två']], uslt: 'USLT-text' }, { title: 'Första' });
  tone(path.join(AL, '02 - Andra.flac'), ['-c:a', 'flac'], { title: 'Andra', artist: 'Artisten', album: 'Albumet', track: 2,
    LYRICS: '[00:00.50]<00:00.50>Flac <00:01.00>med <00:01.50>ord\n[00:02.00]Sista' });
  mp3WithId3(path.join(AL, '03 - Tredje.mp3'), { uslt: 'Egen osynkad text' }, { title: 'Tredje' });
  mp3WithId3(path.join(AL, '04 - Fjärde.mp3'), {}, { title: 'Fjärde' });
  fs.writeFileSync(path.join(AL, '04 - Fjärde.lrc'), 'Vanlig rad från lrc\n');
  mp3WithId3(path.join(AL, '05 - Femte.mp3'), { uslt: 'Text i taggen' }, { title: 'Femte' });
  fs.writeFileSync(path.join(AL, '05 - Femte.lrc'), '[00:00.10]Synkad lrc\n');
  // Musikvideor
  video(path.join(AL, '01 - Första.mp4'));                                      // samma namn som ljudfilen
  video(path.join(A, 'Andra-video.mkv'));                                       // Plex-suffix i artistmappen
  video(path.join(A, 'Music Videos', 'Artisten - Tredje (Official Video).mp4')); // videomapp + "Artist - Låt"
  video(path.join(A, 'Okänd låt-live.mp4'));                                    // live, ingen låt med den titeln
  video(path.join(M, 'Någon annan', 'Ingen artist.mp4'));                        // artisten finns inte i biblioteket
  tone(path.join(AL, 'Bonus.mp4'), ['-c:a', 'aac']);                            // ljud-mp4: ingen video
  LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Musik','music',?)", M).lastInsertRowid);
  await music.scanMusic(D.get('SELECT * FROM libraries WHERE id=?', LIB), {});
  const tr = (title) => D.get('SELECT id FROM tracks WHERE title=?', title)?.id;
  Object.assign(ID, { artist: D.get("SELECT id FROM artists WHERE name='Artisten'").id, album: D.get("SELECT id FROM albums WHERE title='Albumet'").id,
    t1: tr('Första'), t2: tr('Andra'), t3: tr('Tredje'), t4: tr('Fjärde'), t5: tr('Femte') });
}

// ---------- ID3: SYLT och USLT ----------
test('ID3: SYLT per rad och per ord (radbrytning börjar ny rad), USLT, trasig tagg', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'id3-'));
  const f1 = path.join(dir, 'rad.mp3');
  fs.writeFileSync(f1, Buffer.concat([LT.buildId3({ sylt: [[500, 'Första raden'], [2250, 'Andra raden']], uslt: 'Vanlig text\nRad två' }), Buffer.alloc(200)]));
  const r1 = await LT.id3Lyrics(f1);
  assert.deepEqual(r1.sylt, [{ t: 0.5, text: 'Första raden' }, { t: 2.25, text: 'Andra raden' }]);
  assert.equal(r1.uslt, 'Vanlig text\nRad två');
  // Per stavelse/ord: ny rad där texten börjar med radbrytning
  const f2 = path.join(dir, 'ord.mp3');
  fs.writeFileSync(f2, LT.buildId3({ sylt: [[1000, 'Hej '], [1400, 'på '], [1800, 'dig'], [3000, '\nNästa '], [3500, 'rad']] }));
  assert.deepEqual((await LT.id3Lyrics(f2)).sylt, [
    { t: 1, text: 'Hej på dig', words: [{ t: 1, text: 'Hej ' }, { t: 1.4, text: 'på ' }, { t: 1.8, text: 'dig' }] },
    { t: 3, text: 'Nästa rad', words: [{ t: 3, text: 'Nästa ' }, { t: 3.5, text: 'rad' }] }]);
  const bad = path.join(dir, 'trasig.mp3');
  fs.writeFileSync(bad, Buffer.from('ID3\x03\x00\x00\x7f\x7f\x7f\x7fSYLT', 'latin1'));
  assert.deepEqual(await LT.id3Lyrics(bad), { sylt: null, uslt: '' });
  assert.deepEqual(await LT.id3Lyrics(path.join(dir, 'saknas.mp3')), { sylt: null, uslt: '' });
});

test('LRC med ordtider (utökad LRC) och offset', () => {
  const r = L.parseLrc('[offset:+100]\n[00:01.00]<00:01.00>Hej <00:01.50>på <00:02.00>dig\n[00:03.00]Utan ord');
  assert.deepEqual(r.lines, [{ t: 0.9, text: 'Hej på dig', words: [{ t: 0.9, text: 'Hej ' }, { t: 1.4, text: 'på ' }, { t: 1.9, text: 'dig' }] }, { t: 2.9, text: 'Utan ord' }]);
});

test('musikvideor: namn, typer och "Artist - Låt"', () => {
  assert.deepEqual(MV.parseVideoName('Låten-video'), { title: 'Låten', kind: 'video', artist: null, rest: null });
  assert.equal(MV.parseVideoName('Låten-live').kind, 'live');
  assert.equal(MV.parseVideoName('Låten-behindthescenes').kind, 'behindthescenes');
  assert.deepEqual(MV.parseVideoName('Artisten - Tredje (Official Video)'), { title: 'Artisten - Tredje', kind: 'video', artist: 'Artisten', rest: 'Tredje' });
  assert.equal(MV.parseVideoName('Låten [Official Lyric Video]').kind, 'lyrics');
  assert.equal(MV.parseVideoName('03 - Låten (Live at Gröna Lund)').kind, 'live');
  assert.equal(MV.norm('Café (Remastered) feat. Någon'), 'cafe');
  assert.equal(MV.norm('Rock & Roll!'), 'rock and roll');
});

t('låttexter: SYLT, FLAC-tagg med ordtider, synkad .lrc före tagg, LRCLIB:s synkade före egen osynkad', async () => {
  const ly = async (id) => (await api(ANNA, `/api/music/tracks/${id}/lyrics`)).data;
  const a = await ly(ID.t1);
  assert.equal(a.source, 'sylt'); assert.equal(a.synced, true); assert.deepEqual(a.lines, [{ t: 0.3, text: 'SYLT ett' }, { t: 1.5, text: 'SYLT två' }]);
  const b = await ly(ID.t2);
  assert.equal(b.source, 'tag'); assert.equal(b.synced, true);
  assert.deepEqual(b.lines[0], { t: 0.5, text: 'Flac med ord', words: [{ t: 0.5, text: 'Flac ' }, { t: 1, text: 'med ' }, { t: 1.5, text: 'ord' }] });
  const e = await ly(ID.t5);
  assert.equal(e.source, 'lrc'); assert.deepEqual(e.lines, [{ t: 0.1, text: 'Synkad lrc' }]);
  // Egen osynkad (USLT) + synkad på LRCLIB → LRCLIB
  const c = await ly(ID.t3);
  assert.equal(c.source, 'lrclib'); assert.equal(c.synced, true); assert.equal(c.lines[1].text, 'Nätrad två');
  // Egen osynkad .lrc + bara osynkad på LRCLIB → filens egen
  const d = await ly(ID.t4);
  assert.equal(d.source, 'lrc'); assert.equal(d.synced, false); assert.equal(d.lines[0].text, 'Vanlig rad från lrc');
  // Utan LRCLIB: USLT som vanlig text
  D.setSetting('music_lyrics_online', '0');
  try { const c2 = await ly(ID.t3); assert.equal(c2.source, 'tag'); assert.equal(c2.synced, false); assert.equal(c2.lines[0].text, 'Egen osynkad text'); }
  finally { D.setSetting('music_lyrics_online', '1'); }
  // Synkad egen text frågar aldrig nätet
  assert.ok(!lrcLog.some(l => /Första|Andra|Femte/.test(l)), lrcLog.join(', '));
});

t('musikvideor: koppling till låt och artist, typer, ljud-mp4 och okänd artist hoppas över', () => {
  const rows = D.all('SELECT title, kind, track_id, artist_id, path, thumb, width FROM music_videos ORDER BY path');
  const by = (s) => rows.find(r => r.path.includes(s));
  assert.equal(rows.length, 4, JSON.stringify(rows));
  assert.equal(by('01 - Första.mp4').track_id, ID.t1);
  assert.equal(by('Andra-video').track_id, ID.t2);
  assert.equal(by('Official Video').track_id, ID.t3); assert.equal(by('Official Video').title, 'Tredje');
  const live = by('Okänd låt-live');
  assert.equal(live.kind, 'live'); assert.equal(live.track_id, null); assert.equal(live.artist_id, ID.artist);
  assert.ok(rows.every(r => r.artist_id === ID.artist && r.thumb === 1 && r.width === 160));
  assert.ok(!by('Bonus') && !by('Ingen artist'));
});

t('API: album- och artistsidan, video-fältet på låtar, videons info och kö', async () => {
  const al = (await api(ANNA, `/api/music/albums/${ID.album}`)).data;
  assert.deepEqual(al.videos.map(v => v.trackId), [ID.t1, ID.t2, ID.t3]);
  const tracks = Object.fromEntries(al.trackList.map(x => [x.title, x.video]));
  assert.ok(tracks.Första && tracks.Andra && tracks.Tredje); assert.equal(tracks.Fjärde, undefined);
  assert.ok(!('video' in al.trackList.find(x => x.title === 'Fjärde')), 'fältet saknas när låten inte har video');
  const ar = (await api(ANNA, `/api/music/artists/${ID.artist}`)).data;
  assert.equal(ar.videos.length, 4);
  assert.equal(ar.videos[ar.videos.length - 1].kind, 'live', 'vanliga videor först');
  const v = (await api(ANNA, `/api/music/videos/${tracks.Första}`)).data;
  assert.equal(v.title, 'Första'); assert.equal(v.track.albumId, ID.album); assert.equal(v.more.length, 3);
  assert.equal((await api(ANNA, '/api/music/videos/99999')).status, 404);
});

t('ström: Range, mediatoken bara för den videon, stillbild, bibliotek per användare', async () => {
  const [a, b] = D.all('SELECT id FROM music_videos ORDER BY id').map(r => r.id);
  const r = await api(ANNA, `/api/music/videos/${a}/stream`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 206); assert.equal(r.data.length, 100); assert.match(r.headers.get('content-type'), /video\//);
  const p = (await api(ANNA, `/api/music/videos/${a}/play`)).data;
  assert.match(p.url, /^\/api\/music\/videos\/\d+\/stream\?t=/); assert.match(p.mp4, /&mp4=1$/);
  assert.equal((await fetch(B + p.url, { headers: { Range: 'bytes=0-9' } })).status, 206, 'token utan inloggning');
  const other = p.url.replace(`/videos/${a}/`, `/videos/${b}/`);
  assert.equal((await fetch(B + other)).status, 401, 'token gäller bara sin video');
  const remux = await fetch(B + p.mp4);
  assert.equal(remux.status, 200); assert.equal(remux.headers.get('content-type'), 'video/mp4');
  const head = Buffer.from(await remux.arrayBuffer());
  assert.equal(head.toString('latin1', 4, 8), 'ftyp');
  const th = await api(ANNA, `/api/music/videos/${a}/thumb?w=200`);
  assert.equal(th.status, 200); assert.equal(th.data[0], 0xff);
  // Bo får inte se musikbiblioteket
  assert.equal((await api(BO, `/api/music/videos/${a}`)).status, 404);
  assert.equal((await api(BO, `/api/music/videos/${a}/stream`)).status, 404);
  assert.equal((await api(BO, `/api/music/videos/${a}/thumb`)).status, 404);
});

t('skanning: borttagen video försvinner, mappen som saknas rör ingenting', async () => {
  const lib = D.get('SELECT * FROM libraries WHERE id=?', LIB);
  const live = path.join(MEDIA, 'Musik', 'Artisten', 'Okänd låt-live.mp4');
  fs.rmSync(live);
  await music.scanMusic(lib, {});
  assert.equal(D.get('SELECT COUNT(*) AS n FROM music_videos').n, 3);
  // Biblioteksmappen borta: inget tas bort
  const tmp = path.join(ROOT, 'flyttad');
  fs.renameSync(path.join(MEDIA, 'Musik'), tmp);
  try { await music.scanMusic(lib, {}); assert.equal(D.get('SELECT COUNT(*) AS n FROM music_videos').n, 3); }
  finally { fs.renameSync(tmp, path.join(MEDIA, 'Musik')); }
});
