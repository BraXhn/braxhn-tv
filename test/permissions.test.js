// Rättigheter per användare (server/perms.js) och inbjudningslänkar (server/invites.js) mot en riktig server.
// Testmatrisen: användaren "bo" får bara se biblioteket Filmer. Allt i biblioteket Hemligt (och musik- och
// ljudboksbiblioteken) ska vara osynligt överallt – titlar, bilder, strömmar, sök, startsidan, kalendern, samlingar,
// personer, musik (även Subsonic), ljudböcker, DLNA och statistik – medan administratören ser allt. Dessutom: nedladdning
// nekad, kvalitetstak utanför hemmet, högsta antal samtidiga strömmar, profilens arv och inbjudningar (giltig, använd,
// utgången, gissning). Kräver ffmpeg (riktiga videofiler skannas in) som övriga servertester.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-perm-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 26000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
const REMOTE = { 'x-forwarded-for': '81.2.3.4' };
let srv, admin = '', bo = '', kalle = '';
const S = {};

async function req(p, { method = 'GET', body, tok = admin, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  if (raw) return r;
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (name, password) => (await req('/api/login', { method: 'POST', body: { name, password, app: true }, tok: '' })).data.token;
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const video = (file) => ff('-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '4',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', file);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
async function rest(method, params, { name, pw }) {
  const s = crypto.randomBytes(6).toString('hex');
  const q = new URLSearchParams({ u: name, t: md5(pw + s), s, v: '1.16.1', c: 'test', f: 'json', ...params });
  const r = await fetch(`${B}/rest/${method}?${q}`);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) return { http: r.status, ok: r.ok, binary: true };
  const j = (await r.json())['subsonic-response'];
  return { http: r.status, ok: j.status === 'ok', code: j.error?.code, body: j };
}

before(async () => {
  if (!hasFfmpeg) return;
  for (const d of ['Filmer', 'Hemligt']) fs.mkdirSync(path.join(MEDIA, d), { recursive: true });
  video(path.join(MEDIA, 'Filmer', 'Alfa (2020).mp4'));
  video(path.join(MEDIA, 'Filmer', 'Beta (2021).mp4'));
  video(path.join(MEDIA, 'Hemligt', 'Hemlig (2019).mp4'));
  fs.mkdirSync(path.join(ROOT, 'ljud'), { recursive: true });
  ff('-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:a', 'libmp3lame', path.join(ROOT, 'ljud', 'spår.mp3'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', DLNA_IP: '127.0.0.1' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

t('förberedelse: bibliotek, titlar, musik, böcker och användare med rättigheter', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin', PW); assert.ok(admin);
  S.F = (await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).data.id;
  S.X = (await req('/api/libraries', { method: 'POST', body: { name: 'Hemligt', type: 'movie', path: path.join(MEDIA, 'Hemligt') } })).data.id;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const s = (await req('/api/scan')).data;
    const a = (await req(`/api/libraries/${S.F}/items`)).data.items || [], x = (await req(`/api/libraries/${S.X}/items`)).data.items || [];
    if (!s.running && a.length === 2 && x.length === 1) { S.a = a.find(i => i.title === 'Alfa').id; S.b = a.find(i => i.title === 'Beta').id; S.h = x[0].id; break; }
  }
  assert.ok(S.a && S.b && S.h, 'skanningen blev klar');
  // Stillbilderna tas fram i bakgrunden efter skanningen
  for (let i = 0; i < 120; i++) {
    if ((await req(`/api/image/${S.a}/thumb`)).status === 200 && (await req(`/api/image/${S.h}/thumb`)).status === 200) break;
    await sleep(500);
  }
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const now = Math.floor(Date.now() / 1000);
  // En andra hemlig film (utan fil) så att TMDB-samlingen får två filmer, och en serie i det hemliga biblioteket för kalendern
  S.h2 = Number(db.prepare(`INSERT INTO items(library_id,kind,title,sort_title,year,added,collection_id) VALUES(?,'movie','Hemlig två','hemlig två',2020,?,77)`).run(S.X, now).lastInsertRowid);
  db.prepare('INSERT INTO collections(id,name) VALUES(77,?)').run('Hemliga samlingen');
  db.prepare('UPDATE items SET collection_id=77, genres=? WHERE id=?').run('["Drama"]', S.h);
  S.show = Number(db.prepare(`INSERT INTO items(library_id,kind,title,sort_title,tmdb_id,added) VALUES(?,'show','Hemlig serie','hemlig serie',4242,?)`).run(S.X, now).lastInsertRowid);
  db.prepare('INSERT INTO calendar_shows(show_id,tmdb_id,status,fetched) VALUES(?,4242,?,?)').run(S.show, 'Returning Series', now);
  const soon = new Date(); soon.setDate(soon.getDate() + 2);
  db.prepare('INSERT INTO calendar_episodes(show_id,season,episode,name,air_date) VALUES(?,1,1,?,?)').run(S.show, 'Piloten', ymd(soon));
  // Person som bara finns i den hemliga filmen
  S.person = 999001;
  db.prepare('INSERT INTO people(id,name) VALUES(?,?)').run(S.person, 'Greta Hemligsson');
  db.prepare("INSERT INTO item_people(item_id,person_id,role,ord) VALUES(?,?,'cast',0)").run(S.h, S.person);
  // Musik och ljudböcker (biblioteksmapparna saknas – skannern rör dem inte)
  S.M = Number(db.prepare("INSERT INTO libraries(name,type,path) VALUES('Musik','music',?)").run(path.join(MEDIA, 'saknas-musik')).lastInsertRowid);
  S.ar = Number(db.prepare('INSERT INTO artists(library_id,name,sort_name) VALUES(?,?,?)').run(S.M, 'Hemliga bandet', 'hemliga bandet').lastInsertRowid);
  S.al = Number(db.prepare('INSERT INTO albums(library_id,artist_id,title,sort_title,added,genre) VALUES(?,?,?,?,?,?)').run(S.M, S.ar, 'Hemliga skivan', 'hemliga skivan', now, 'Pop').lastInsertRowid);
  S.tr = Number(db.prepare(`INSERT INTO tracks(library_id,album_id,artist_id,title,track_no,duration,path,size,codec,added) VALUES(?,?,?,?,1,2,?,?,'mp3',?)`)
    .run(S.M, S.al, S.ar, 'Hemliga låten', path.join(ROOT, 'ljud', 'spår.mp3'), fs.statSync(path.join(ROOT, 'ljud', 'spår.mp3')).size, now).lastInsertRowid);
  S.BL = Number(db.prepare("INSERT INTO libraries(name,type,path) VALUES('Böcker','audiobook',?)").run(path.join(MEDIA, 'saknas-böcker')).lastInsertRowid);
  S.book = Number(db.prepare('INSERT INTO books(library_id,key,title,sort_title,author,added) VALUES(?,?,?,?,?,?)').run(S.BL, 'k1', 'Hemliga boken', 'hemliga boken', 'Hemlig Författare', now).lastInsertRowid);
  db.close();

  // bo: bara Filmer, ingen nedladdning, högst 360p utanför hemmet, en ström åt gången
  const r = await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW, libraries: [S.F], canDownload: false, remoteQuality: '360', maxStreams: 1 } });
  assert.equal(r.status, 200); S.boId = r.data.id;
  // kalle: alla bibliotek men ingen nedladdning
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'kalle', password: PW, canDownload: false } })).status, 200);
  bo = await login('bo', PW); kalle = await login('kalle', PW);
  assert.ok(bo && kalle);
  const u = (await req('/api/users')).data.find(x => x.name === 'bo');
  assert.deepEqual(u.libraries, [S.F]); assert.equal(u.canDownload, false); assert.equal(u.remoteQuality, '360'); assert.equal(u.maxStreams, 1);
  // Ogiltiga värden nekas
  assert.equal((await req(`/api/users/${S.boId}`, { method: 'PUT', body: { remoteQuality: '999' } })).status, 400);
  assert.equal((await req(`/api/users/${S.boId}`, { method: 'PUT', body: { libraries: 'alla' } })).status, 400);
  // Tidigare tittande och Min lista i det hemliga biblioteket (innan åtkomsten togs bort)
  const db2 = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db2.exec('PRAGMA busy_timeout=5000');
  db2.prepare('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,100,4,0,?)').run(S.boId, S.h, now);
  db2.prepare('INSERT INTO watchlist(user_id,item_id,added) VALUES(?,?,?)').run(S.boId, S.h2, now);
  db2.prepare('INSERT INTO plays(user_id,item_id,ts,mode,remote,device) VALUES(?,?,?,?,0,?)').run(S.boId, S.h, now, 'direct', 'test');
  db2.prepare('INSERT INTO track_plays(user_id,track_id,ts) VALUES(?,?,?)').run(S.boId, S.tr, now);
  db2.close();
});

t('admin ser allt (kontroll av testdatan)', async () => {
  assert.equal((await req(`/api/items/${S.h}`)).status, 200);
  assert.ok((await req('/api/libraries')).data.some(l => l.id === S.X));
  assert.ok((await req('/api/search/all?q=hemlig')).data.movies.length >= 1);
  assert.equal((await req(`/api/music/albums/${S.al}`)).status, 200);
  assert.equal((await req(`/api/audiobooks/book/${S.book}`)).status, 200);
  assert.ok((await req(`/api/collections/77`)).data.items.length === 2);
  const cal = (await req('/api/calendar')).data;
  assert.ok(cal.items.some(e => e.showId === S.show), 'admin ser serien i kalendern');
  assert.equal((await req(`/api/people/${S.person}`)).status, 200);
  // Det som nekas bo nedan finns alltså och fungerar för den som har åtkomst
  assert.equal((await req(`/api/image/${S.h}/thumb`)).status, 200);
  assert.equal((await req(`/api/stream/${S.h}/direct`, { headers: { range: 'bytes=0-9' } })).status, 206);
  assert.equal((await req(`/api/items/${S.h}/playback?info=1`)).status, 200);
  assert.equal((await req(`/api/music/tracks/${S.tr}/stream`, { headers: { range: 'bytes=0-9' } })).status, 206);
  assert.equal((await req(`/api/audiobooks/${S.BL}`)).status, 200);
  // kalle (alla bibliotek) ser också det hemliga
  assert.equal((await req(`/api/items/${S.h}`, { tok: kalle })).status, 200);
});

t('testmatris: titlar, bilder och strömmar från det otillåtna biblioteket ger 403/404', async () => {
  const h = S.h;
  const denied = [
    `/api/libraries/${S.X}/items`, `/api/items/${h}`, `/api/items/${h}/state`, `/api/items/${h}/trickplay`, `/api/items/${h}/trickplay/0`,
    `/api/items/${h}/playback`, `/api/items/${h}/playback?info=1`, `/api/items/${h}/watch`, `/api/items/${h}/offline`, `/api/items/${h}/subsearch`,
    `/api/image/${h}/thumb`, `/api/image/${h}/poster`, `/api/image/${h}/backdrop`,
    `/api/stream/${h}/direct`, `/api/stream/${h}/download`, `/api/stream/${h}/hls/master.m3u8?mode=transcode&q=360`,
    `/api/stream/${h}/hls/index.m3u8?mode=transcode&q=360`, `/api/stream/${h}/hls/seg-0.ts?mode=transcode&q=360`, `/api/stream/${h}/subs/e0.vtt`,
    `/api/stream/${h}/offline-file`, `/api/stream/${h}/pgs/e0`,
    `/api/items/${S.show}/missing`, `/api/collections/77`, `/api/collection-image/77/poster`, `/api/people/${S.person}`, `/api/people/${S.person}/image`,
    `/api/music/${S.M}/home`, `/api/music/${S.M}/albums`, `/api/music/${S.M}/artists`, `/api/music/${S.M}/search?q=hemlig`, `/api/music/${S.M}/smart`,
    `/api/music/${S.M}/smart/recent`, `/api/music/albums/${S.al}`, `/api/music/artists/${S.ar}`, `/api/music/cover/${S.al}`,
    `/api/music/tracks/${S.tr}/stream`, `/api/music/tracks/${S.tr}/play`, `/api/music/tracks/${S.tr}/lyrics`,
    `/api/music/tracks/${S.tr}/similar`, `/api/music/artists/${S.ar}/similar`,
    `/api/audiobooks/${S.BL}`, `/api/audiobooks/book/${S.book}`, `/api/audiobooks/book/${S.book}/play`, `/api/audiobooks/cover/${S.book}`,
  ];
  for (const p of denied) {
    const r = await req(p, { tok: bo });
    assert.ok([403, 404].includes(r.status), `${p} gav ${r.status}`);
  }
  // Ändrande anrop
  const posts = [
    [`/api/items/${h}/progress`, { position: 1 }], [`/api/items/${h}/watched`, { watched: true }], [`/api/items/${h}/watchlist`, { add: true }],
    [`/api/items/${h}/continue`, { hide: true }], [`/api/items/${S.show}/follow`, { follow: true }], ['/api/party', { itemId: h }],
    [`/api/music/tracks/${S.tr}/played`, {}], [`/api/music/tracks/${S.tr}/favorite`, { on: true }],
    [`/api/audiobooks/book/${S.book}/progress`, { position: 5 }], [`/api/audiobooks/book/${S.book}/bookmarks`, { position: 5 }],
    ['/api/custom-collections', { name: 'Min', item: h }],
    ['/api/music/radio', { trackId: S.tr }], ['/api/music/radio', { artistId: S.ar }], ['/api/music/journey', { from: S.tr, to: S.tr }],
  ];
  for (const [p, body] of posts) {
    const r = await req(p, { method: 'POST', body, tok: bo });
    assert.ok([403, 404].includes(r.status), `POST ${p} gav ${r.status}`);
  }
  // Media-token för titeln kan inte heller användas (den skapas aldrig – och en adminens token gäller bara admin)
  // Det tillåtna biblioteket fungerar som vanligt
  assert.equal((await req(`/api/items/${S.a}`, { tok: bo })).status, 200);
  assert.equal((await req(`/api/image/${S.a}/thumb`, { tok: bo })).status, 200);
});

t('testmatris: listor, sök, startsidan, kalendern, samlingar och statistik visar inget från biblioteket', async () => {
  const libs = (await req('/api/libraries', { tok: bo })).data;
  assert.deepEqual(libs.map(l => l.id), [S.F], 'bara Filmer');
  const home = (await req('/api/home', { tok: bo })).data;
  const hs = JSON.stringify(home);
  assert.ok(!/Hemlig/.test(hs), 'startsidan (alla hyllor) nämner inget hemligt');
  assert.ok(home.rows.every(r => r.library.id === S.F));
  assert.equal((await req('/api/watchlist', { tok: bo })).data.length, 0, 'Min lista');
  assert.equal((await req('/api/search?q=hemlig', { tok: bo })).data.length, 0, 'sök');
  const all = (await req('/api/search/all?q=hemlig', { tok: bo })).data;
  for (const g of ['movies', 'shows', 'episodes', 'people', 'artists', 'albums', 'tracks', 'books']) assert.equal(all[g].length, 0, `sök: ${g}`);
  assert.equal((await req('/api/search/people?q=greta', { tok: bo })).data.length, 0);
  assert.ok(!(await req('/api/collections', { tok: bo })).data.some(c => c.id === 77), 'TMDB-samlingar');
  const cal = (await req('/api/calendar', { tok: bo })).data;
  assert.ok(!cal.items.some(e => e.showId === S.show), 'kalendern');
  // Egen delad samling med bara en hemlig titel: osynlig för bo
  const cc = (await req('/api/custom-collections', { method: 'POST', body: { name: 'Hemligt urval', shared: true, item: S.h } })).data.id;
  assert.ok(!(await req('/api/custom-collections', { tok: bo })).data.some(c => c.id === cc));
  assert.equal((await req(`/api/custom-collections/${cc}`, { tok: bo })).status, 404);
  // Ditt år: tittande och lyssning från biblioteken räknas inte
  const w = (await req(`/api/wrapped/${new Date().getFullYear()}`, { tok: bo })).data;
  assert.equal(w.video.plays, 0); assert.equal(w.music.plays, 0);
  // Min historik: inget från det hemliga biblioteket
  assert.ok(!JSON.stringify((await req('/api/history', { tok: bo })).data).includes('Hemlig'), 'Min historik');
  // Smarta listor och spellistor: inga spår från musikbiblioteket
  const pv = (await req('/api/music/smartlists/preview', { method: 'POST', body: { name: 'Allt', rules: [] }, tok: bo })).data;
  assert.equal(pv.count, 0);
  assert.equal((await req('/api/music/smartlists/preview', { method: 'POST', body: { name: 'Allt', rules: [] } })).data.count, 1, 'admin ser spåret');
  const pl = (await req('/api/music/playlists', { method: 'POST', body: { name: 'Lista', trackIds: [S.tr] }, tok: bo })).data.id;
  assert.equal((await req(`/api/music/playlists/${pl}`, { tok: bo })).data.trackList.length, 0);
  // Skanningsstatus avslöjar inte bibliotekens namn
  assert.equal((await req('/api/scan', { tok: bo })).data.library, undefined);
  // Status: nedladdning nekad (webben döljer knappen)
  assert.equal((await req('/api/status', { tok: bo })).data.user.canDownload, false);
});

t('Subsonic: musikbiblioteket syns inte och nedladdning kräver rätten', async () => {
  const pwOf = async (tok) => (await req('/api/me/subsonic', { method: 'POST', body: { password: PW }, tok })).data.password;
  const boPw = await pwOf(bo), kPw = await pwOf(kalle);
  assert.ok(boPw && kPw);
  const B1 = { name: 'bo', pw: boPw }, K = { name: 'kalle', pw: kPw };
  assert.equal((await rest('getMusicFolders', {}, B1)).body.musicFolders.musicFolder.length, 0);
  for (const [m, p] of [['getAlbum', { id: 'al-' + S.al }], ['getArtist', { id: 'ar-' + S.ar }], ['getSong', { id: 'tr-' + S.tr }], ['stream', { id: 'tr-' + S.tr }],
    ['download', { id: 'tr-' + S.tr }], ['getCoverArt', { id: 'al-' + S.al }], ['getAlbumList2', { type: 'newest', musicFolderId: S.M }]]) {
    const r = await rest(m, p, B1);
    assert.equal(r.ok, false, `${m} ska nekas`); assert.equal(r.code, 70, `${m}: kod ${r.code}`);
  }
  const s3 = (await rest('search3', { query: '' }, B1)).body.searchResult3;
  assert.equal((s3.song || []).length + (s3.album || []).length + (s3.artist || []).length, 0);
  assert.equal((await rest('getRandomSongs', { size: 10 }, B1)).body.randomSongs.song.length, 0);
  assert.equal((await rest('getUser', {}, B1)).body.user.downloadRole, false);
  // kalle ser musiken men får inte ladda ner – strömning fungerar
  assert.equal((await rest('getMusicFolders', {}, K)).body.musicFolders.musicFolder.length, 1);
  const dl = await rest('download', { id: 'tr-' + S.tr }, K);
  assert.equal(dl.ok, false); assert.equal(dl.code, 50);
  const st = await rest('stream', { id: 'tr-' + S.tr, format: 'raw' }, K);
  assert.equal(st.binary, true); assert.equal(st.http, 200);
});

t('nedladdning nekad: originalfil, offline och offline-synk', async () => {
  assert.equal((await req(`/api/stream/${S.a}/download`, { tok: bo })).status, 403);
  assert.equal((await req(`/api/items/${S.a}/offline`, { tok: bo })).status, 403);
  assert.equal((await req(`/api/items/${S.a}/offline`, { method: 'POST', body: { q: '360' }, tok: bo })).status, 403);
  assert.equal((await req(`/api/stream/${S.a}/download`, { tok: kalle })).status, 403);
  const r = await req(`/api/stream/${S.a}/download`, { raw: true });
  assert.equal(r.status, 200, 'admin får ladda ner'); await r.body?.cancel();
  const sync = (await req(`/api/offline/sync?have=${S.a},${S.h}`, { tok: bo })).data;
  assert.deepEqual(sync.items, []); assert.deepEqual(sync.remove.sort(), [S.a, S.h].sort());
  // Rättigheten tillbaka: hämtning fungerar, och en titel som inte får ses tas bort från enheten
  assert.equal((await req(`/api/users/${S.boId}`, { method: 'PUT', body: { canDownload: true } })).status, 200);
  const r2 = await req(`/api/stream/${S.a}/download`, { tok: bo, raw: true });
  assert.equal(r2.status, 200); await r2.body?.cancel();
  assert.ok((await req(`/api/offline/sync?have=${S.h}`, { tok: bo })).data.remove.includes(S.h));
  assert.equal((await req(`/api/users/${S.boId}`, { method: 'PUT', body: { canDownload: false } })).status, 200);
});

t('kvalitetstak utanför hemmet: decide sänks och strömmar över taket nekas', async () => {
  // Hemma gäller inget tak
  const home = (await req(`/api/items/${S.a}/playback?info=1&q=1080`, { tok: bo })).data;
  assert.equal(home.quality, '1080');
  // Utanför hemmet: både automatisk och vald kvalitet sänks till 360p (källan är 480p → omkodas)
  const auto = (await req(`/api/items/${S.a}/playback?info=1`, { tok: bo, headers: REMOTE })).data;
  assert.equal(auto.quality, '360'); assert.equal(auto.mode, 'transcode');
  const chosen = (await req(`/api/items/${S.a}/playback?info=1&q=1080`, { tok: bo, headers: REMOTE })).data;
  assert.equal(chosen.quality, '360');
  // Utan tak (kalle): serverns inställning (1080) – källan ryms, ingen sänkning
  assert.equal((await req(`/api/items/${S.a}/playback?info=1`, { tok: kalle, headers: REMOTE })).data.quality, '1080');
  // Strömmarna: direkt (480p-källan) och omkodning över taket nekas utifrån, under taket går bra
  assert.equal((await req(`/api/stream/${S.a}/direct`, { tok: bo, headers: { ...REMOTE, range: 'bytes=0-99' } })).status, 403);
  assert.equal((await req(`/api/stream/${S.a}/hls/master.m3u8?mode=transcode&q=1080`, { tok: bo, headers: REMOTE })).status, 403);
  assert.equal((await req(`/api/stream/${S.a}/hls/master.m3u8?mode=remux&q=orig`, { tok: bo, headers: REMOTE })).status, 403);
  assert.equal((await req(`/api/stream/${S.a}/hls/master.m3u8?mode=transcode&q=360`, { tok: bo, headers: REMOTE })).status, 200);
  const local = await req(`/api/stream/${S.a}/direct`, { tok: bo, headers: { range: 'bytes=0-99' } });
  assert.equal(local.status, 206, 'hemma spelas filen direkt');
});

t('högsta antal samtidiga strömmar för hushållet', async () => {
  const first = await req(`/api/items/${S.a}/playback`, { tok: bo });
  assert.equal(first.status, 200);
  // Samma titel igen (spolning, ny enhet) räknas inte
  assert.equal((await req(`/api/items/${S.a}/playback`, { tok: bo })).status, 200);
  const second = await req(`/api/items/${S.b}/playback`, { tok: bo });
  assert.equal(second.status, 403); assert.match(second.data.error, /en sak i taget/);
  // Spelaren stängs: nästa titel går bra
  assert.equal((await req(`/api/stream/${S.a}/stop`, { method: 'POST', tok: bo })).status, 200);
  assert.equal((await req(`/api/items/${S.b}/playback`, { tok: bo })).status, 200);
  await req(`/api/stream/${S.b}/stop`, { method: 'POST', tok: bo });
  // Profiler kan inte sätta egna tak (de ärver kontot)
  assert.equal((await req(`/api/users/${S.boId}`, { method: 'PUT', body: { maxStreams: 3 } })).status, 200);
  assert.equal((await req(`/api/users/${S.boId}`, { method: 'PUT', body: { maxStreams: null } })).status, 200);
});

t('profiler ärver kontots bibliotek och kan begränsas ytterligare', async () => {
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lill' }, tok: bo })).status, 200);
  const pid = (await req('/api/profiles', { tok: bo })).data.profiles.find(p => p.name === 'Lill').id;
  const lill = (await req('/api/profiles/switch', { method: 'POST', body: { id: pid }, tok: bo })).data.token;
  bo = await login('bo', PW);
  assert.deepEqual((await req('/api/libraries', { tok: lill })).data.map(l => l.id), [S.F]);
  assert.equal((await req(`/api/items/${S.h}`, { tok: lill })).status, 403);
  assert.equal((await req(`/api/stream/${S.a}/download`, { tok: lill })).status, 403, 'ärver: ingen nedladdning');
  // En profil kan inte få mer än kontot, och kan stängas av helt
  assert.equal((await req(`/api/users/${pid}`, { method: 'PUT', body: { libraries: [S.F, S.X] } })).status, 200);
  assert.equal((await req(`/api/items/${S.h}`, { tok: lill })).status, 403, 'snittet med kontots lista');
  assert.equal((await req(`/api/users/${pid}`, { method: 'PUT', body: { libraries: [] } })).status, 200);
  assert.equal((await req('/api/libraries', { tok: lill })).data.length, 0);
  assert.equal((await req(`/api/items/${S.a}`, { tok: lill })).status, 403);
  assert.equal((await req(`/api/users/${pid}`, { method: 'PUT', body: { maxStreams: 2 } })).status, 400, 'strömmar sätts på kontot');
});

t('DLNA visar bara valda bibliotek', async () => {
  const ops = await req('/api/ops', { method: 'PUT', body: { dlnaEnabled: true, dlnaLibraries: [S.F] } });
  assert.equal(ops.status, 200); assert.deepEqual(ops.data.dlna.libraries, [S.F]);
  const hidden = await fetch(`${B}/dlna/media/${S.h}.mp4`, { headers: { range: 'bytes=0-9' } });
  assert.equal(hidden.status, 404); await hidden.body?.cancel();
  const shown = await fetch(`${B}/dlna/media/${S.a}.mp4`, { headers: { range: 'bytes=0-9' } });
  assert.equal(shown.status, 206); await shown.body?.cancel();
  const tr = await fetch(`${B}/dlna/track/${S.tr}.mp3`);
  assert.equal(tr.status, 404); await tr.body?.cancel();
  assert.equal((await req('/api/ops', { method: 'PUT', body: { dlnaEnabled: false, dlnaLibraries: null } })).data.dlna.libraries, null);
});

t('inbjudan: giltig, använd, utgången och gissning', async () => {
  const r = await req('/api/invites', { method: 'POST', body: { note: 'Mormor', days: 2, libraries: [S.F], canDownload: false, remoteQuality: '720', maxAge: 11 } });
  assert.equal(r.status, 200); assert.match(r.data.token, /^[a-f0-9]{64}$/); assert.equal(r.data.path, `/#/invite/${r.data.token}`);
  const tok = r.data.token;
  // Listan visar aldrig token (den lagras bara hashad)
  const list = (await req('/api/invites')).data.invites;
  assert.ok(list.some(i => i.id === r.data.id && i.note === 'Mormor' && !i.used));
  assert.ok(!JSON.stringify(list).includes(tok));
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'), { readOnly: true });
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM invites').all()).includes(tok), 'token lagras inte i klartext');
  db.close();
  assert.equal((await req('/api/invites', { tok: bo })).status, 403, 'bara administratörer');
  // Giltig: informationen och kontot skapas med förvalda rättigheter
  assert.equal((await req(`/api/invite/${tok}`, { tok: '' })).data.valid, true);
  assert.equal((await req(`/api/invite/${tok}`, { method: 'POST', body: { name: 'mormor', password: 'kort' }, tok: '' })).status, 400, 'svagt lösenord');
  assert.equal((await req(`/api/invite/${tok}`, { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 409, 'namnet upptaget');
  const ok = await req(`/api/invite/${tok}`, { method: 'POST', body: { name: 'mormor', password: PW, app: true }, tok: '' });
  assert.equal(ok.status, 200); const mor = ok.data.token; assert.ok(mor); assert.equal(ok.data.user.is_admin, 0);
  assert.deepEqual((await req('/api/libraries', { tok: mor })).data.map(l => l.id), [S.F]);
  const st = (await req('/api/status', { tok: mor })).data.user;
  assert.equal(st.canDownload, false); assert.equal(st.maxAge, 11);
  const u = (await req('/api/users')).data.find(x => x.name === 'mormor');
  assert.equal(u.remoteQuality, '720'); assert.equal(u.is_admin, 0);
  // Använd: engångs
  assert.equal((await req(`/api/invite/${tok}`, { tok: '' })).status, 404);
  assert.equal((await req(`/api/invite/${tok}`, { method: 'POST', body: { name: 'mormor2', password: PW }, tok: '' })).status, 404);
  assert.ok((await req('/api/invites')).data.invites.find(i => i.id === r.data.id).used);
  // Utgången
  const r2 = (await req('/api/invites', { method: 'POST', body: { days: 1 } })).data;
  const db2 = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db2.exec('PRAGMA busy_timeout=5000');
  db2.prepare('UPDATE invites SET expires=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 10, r2.id);
  db2.close();
  assert.equal((await req(`/api/invite/${r2.token}`, { tok: '' })).status, 404);
  assert.equal((await req(`/api/invite/${r2.token}`, { method: 'POST', body: { name: 'sen', password: PW }, tok: '' })).status, 404);
  // Återkallad
  const r3 = (await req('/api/invites', { method: 'POST', body: {} })).data;
  assert.equal((await req(`/api/invites/${r3.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await req(`/api/invite/${r3.token}`, { tok: '' })).status, 404);
  // Gissning: spärras efter tio felaktiga försök från samma adress (även en riktig token nekas då)
  const r4 = (await req('/api/invites', { method: 'POST', body: {} })).data;
  const guess = { 'x-forwarded-for': '81.7.7.7' };
  for (let i = 0; i < 10; i++) assert.equal((await req(`/api/invite/${crypto.randomBytes(32).toString('hex')}`, { tok: '', headers: guess })).status, 404);
  assert.equal((await req(`/api/invite/${crypto.randomBytes(32).toString('hex')}`, { tok: '', headers: guess })).status, 429);
  assert.equal((await req(`/api/invite/${r4.token}`, { tok: '', headers: guess })).status, 429);
  assert.equal((await req(`/api/invite/${r4.token}`, { tok: '' })).status, 200, 'andra adresser påverkas inte');
  // Inloggnings-CSRF: annan origin nekas
  const csrf = await req(`/api/invite/${r4.token}`, { method: 'POST', body: { name: 'x', password: PW }, tok: '', headers: { origin: 'https://ond.example' } });
  assert.equal(csrf.status, 403);
});
