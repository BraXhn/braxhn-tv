// Kontraktstester mot apparna: varje /api-anrop som iOS/tvOS- och Android-appen gör körs mot en riktig server
// med filmer, serier, musik, ljudböcker, poddar och live-TV, och svaret kontrolleras mot test/contracts/apps.json
// (det apparna faktiskt avkodar). Installerade appar uppdateras inte med servern – ett fält som saknas eller har
// fel typ gör att appens avkodning misslyckas och vyn blir tom. Kräver ffmpeg. Se test/contracts/README.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startServer, PW } from './media/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = JSON.parse(fs.readFileSync(path.join(HERE, 'contracts', 'apps.json'), 'utf8'));
const APPS = { ios: 'iOS/tvOS-appen', android: 'Android-appen (bil och Google TV)' };
const UA = { ios: 'BraXhnTV/1.0 CFNetwork Darwin', android: 'BraXhnTV-Android' };

// ---------------- validering (inga beroenden) ----------------
const typeOf = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
function describe(v) {
  if (v === undefined) return 'saknas';
  const t = typeOf(v);
  if (t === 'string') return `string (${JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v)})`;
  if (t === 'number' || t === 'boolean') return `${t} (${v})`;
  if (t === 'array') return `array (${v.length} element)`;
  return t;
}
function wanted(s) {
  if (Array.isArray(s)) return 'array';
  if (typeof s === 'object') return 'object';
  if (s.startsWith('@')) return `object (${s.slice(1)})`;
  return { integer: 'integer (heltal)', 'string:path': 'string (relativ /api/-adress)', 'string:path?': 'string (relativ /api/-adress med ?-del)' }[s] || s;
}
/** Typdefinitioner som prövats mot verkliga svar, och vilka valfria fält som faktiskt förekommit */
const seen = new Set(), observed = new Map();

/**
 * Kontrollerar v mot schemat s. Fel läggs i out som { sökväg, förväntat, faktiskt }.
 * required = måste finnas och inte vara null (appen kraschar annars); optional = får saknas eller vara null,
 * men har fältet ett värde måste typen stämma. Okända fält ignoreras (gör apparna också).
 */
function check(v, s, p, out, defs = C.typer, name = null) {
  if (typeof s === 'string' && s.startsWith('@')) {
    const n = s.slice(1), d = defs[n];
    if (!d) throw new Error(`Kontraktet hänvisar till okänd typ ${n}`);
    return check(v, d, p, out, defs, n);
  }
  if (typeof s === 'string') {
    const [t, fmt] = s.split(':');
    const ok = t === 'any' || (t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeOf(v) === t);
    if (!ok) return out.push({ path: p, want: wanted(s), got: describe(v) });
    if (fmt && !/^\/api\//.test(v)) out.push({ path: p, want: wanted(s), got: describe(v) });
    else if (fmt === 'path?' && !v.includes('?')) out.push({ path: p, want: wanted(s), got: describe(v) });
    return;
  }
  if (Array.isArray(s)) {
    if (!Array.isArray(v)) return out.push({ path: p, want: 'array', got: describe(v) });
    v.forEach((x, i) => check(x, s[0], `${p}[${i}]`, out, defs));
    return;
  }
  if (typeOf(v) !== 'object') return out.push({ path: p, want: name ? `object (${name})` : 'object', got: describe(v) });
  if (name) { seen.add(name); if (!observed.has(name)) observed.set(name, new Set()); }
  for (const [k, fs_] of Object.entries(s.required || {})) {
    if (v[k] == null) out.push({ path: `${p}.${k}`, want: wanted(fs_) + ' (obligatoriskt)', got: describe(v[k]) });
    else check(v[k], fs_, `${p}.${k}`, out, defs);
  }
  for (const [k, fs_] of Object.entries(s.optional || {})) {
    if (v[k] == null) continue;
    if (name) observed.get(name).add(k);
    check(v[k], fs_, `${p}.${k}`, out, defs);
  }
}
const MAX_LINES = 12; // samma fel i varje element av en lång lista ska inte dränka resten
const report = (head, errs) => `${head}\n` + errs.slice(0, MAX_LINES).map(e => `  • ${e.path}: förväntat ${e.want}, fick ${e.got}`).join('\n')
  + (errs.length > MAX_LINES ? `\n  • … och ${errs.length - MAX_LINES} fel till` : '');

test('validatorn: fångar de fel som får apparnas avkodning att misslyckas', () => {
  const defs = { M: { required: { id: 'integer', ok: 'boolean', url: 'string:path?' }, optional: { lista: [{ required: { t: 'string' } }], n: 'number' } } };
  const run = (v) => { const out = []; check(v, '@M', 'svar', out, defs); return out; };
  assert.deepEqual(run({ id: 1, ok: true, url: '/api/x?t=1' }), []);
  assert.deepEqual(run({ id: 1, ok: true, url: '/api/x?t=1', lista: null, n: null, extra: 'okänt fält' }), []);
  assert.deepEqual(run({ id: 1, ok: 1, url: '/api/x?t=1' }).map(e => e.path), ['svar.ok'], 'boolean som 0/1 ska ge fel');
  assert.deepEqual(run({ id: 1.5, ok: true, url: '/api/x?t=1' }).map(e => e.path), ['svar.id'], 'decimaltal där appen väntar heltal');
  assert.deepEqual(run({ ok: true, id: null, url: '/api/x?t=1' }).map(e => e.got), ['null']);
  assert.deepEqual(run({ id: 1, ok: true }).map(e => e.got), ['saknas']);
  assert.deepEqual(run({ id: 1, ok: true, url: 'http://x/api/a?b' }).map(e => e.path), ['svar.url'], 'absolut adress där appen lägger till serverns');
  assert.deepEqual(run({ id: 1, ok: true, url: '/api/a' }).map(e => e.path), ['svar.url'], 'ingen ?-del att lägga till &a= på');
  assert.deepEqual(run({ id: 1, ok: true, url: '/api/a?b', lista: [{ t: 'a' }, { t: 2 }] }).map(e => e.path), ['svar.lista[1].t']);
  assert.deepEqual(run({ id: 1, ok: true, url: '/api/a?b', n: '3' }).map(e => e.path), ['svar.n'], 'valfritt fält med fel typ');
  assert.match(report('X', run({ id: '1', ok: true, url: '/api/a?b' })), /svar\.id: förväntat integer \(heltal\), fick string \("1"\)/);
  assert.match(report('X', run({ ok: true, url: '/api/a?b' })), /svar\.id: förväntat integer \(heltal\) \(obligatoriskt\), fick saknas/);
});

test('kontraktet: varje typhänvisning finns och varje post anger sin källa i appen', () => {
  const refs = new Set();
  const walk = (s) => { if (typeof s === 'string') { if (s.startsWith('@')) refs.add(s.slice(1)); } else if (Array.isArray(s)) s.forEach(walk); else if (s && typeof s === 'object') { if (s.media) return; Object.values(s.required || {}).forEach(walk); Object.values(s.optional || {}).forEach(walk); } };
  for (const [n, d] of Object.entries(C.typer)) { assert.ok(d.källa, `typen ${n} saknar källa`); walk(d); assert.match(n, /\.(ios|android)$/, `typen ${n} ska sluta på .ios eller .android`); }
  for (const [k, e] of Object.entries(C.endpoints)) {
    assert.match(k, /^(GET|POST|PUT|DELETE) \/api\//, k);
    for (const app of Object.keys(e)) { assert.ok(APPS[app], `${k}: okänd app ${app}`); assert.ok(e[app].källa, `${k} (${app}) saknar källa`); walk(e[app].svar); }
  }
  for (const r of refs) assert.ok(C.typer[r], `okänd typ @${r}`);
  for (const n of Object.keys(C.typer)) assert.ok(refs.has(n), `typen ${n} används inte av någon endpoint`);
});

// ---------------- server med realistiskt bibliotek ----------------
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-kontrakt-'));
const MEDIA = path.join(ROOT, 'media');
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let srv, feed, feedBase;
const S = {}; // id:n i testbiblioteket
const TOK = {}; // apptoken (Bearer) och bildtoken per app

async function call(app, method, p, { body, auth = true, headers = {}, token } = {}) {
  const h = { 'user-agent': UA[app], ...headers };
  if (auth) h.authorization = 'Bearer ' + (token || TOK[app]);
  return srv.req(p, { method, body, headers: h, auth: false });
}
const ok = (r, what) => { assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };

before(async () => {
  if (!hasFfmpeg) return;
  const dir = (...p) => { const d = path.join(MEDIA, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  // Filmer: MP4 med kapitel (direkt), MKV med AC-3, två ljudspår och undertexter (remux)
  const film = dir('Filmer');
  fs.writeFileSync(path.join(ROOT, 'kap.txt'), ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=6000\ntitle=Början\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=6000\nEND=12000\ntitle=Slutet\n');
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=500', '-i', path.join(ROOT, 'kap.txt'), '-map', '0:v', '-map', '1:a', '-map_chapters', '2',
    '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(film, 'Direkt Film (2021).mp4'));
  fs.writeFileSync(path.join(ROOT, 'inb.srt'), '1\n00:00:01,000 --> 00:00:03,000\nInbäddad\n');
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-f', 'lavfi', '-i', 'sine=frequency=700', '-i', path.join(ROOT, 'inb.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-x264-params', 'keyint=48',
    '-c:a:0', 'ac3', '-c:a:1', 'aac', '-c:s', 'srt', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=swe', '-metadata:s:a:1', 'title=Kommentar',
    '-metadata:s:s:0', 'language=swe', '-disposition:a:0', 'default', path.join(film, 'Remux Film (2020).mkv'));
  fs.writeFileSync(path.join(film, 'Remux Film (2020).sv.srt'), '1\n00:00:01,000 --> 00:00:04,000\nHej\n');
  // Serie med tre avsnitt
  const ser = dir('Serier', 'Serien', 'Season 1');
  for (const n of [1, 2, 3]) ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', `sine=frequency=${200 * n}`, '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(ser, `Serien S01E0${n}.mkv`));
  // Seriens temamusik och extramaterial (Android läser theme och extras på titelsidan)
  ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', path.join(MEDIA, 'Serier', 'Serien', 'theme.mp3'));
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    path.join(dir('Serier', 'Serien', 'Featurettes'), 'Bakom kulisserna.mp4'));
  // Musik: ett album med omslag
  const alb = dir('Musik', 'Artisten', 'Albumet');
  for (const n of [1, 2]) ff('-f', 'lavfi', '-i', `sine=frequency=${300 * n}:duration=5`, '-metadata', `title=Låt ${n}`, '-metadata', 'artist=Artisten', '-metadata', 'album=Albumet',
    '-metadata', `track=${n}`, '-metadata', 'date=2019', path.join(alb, `0${n} Låt ${n}.mp3`));
  ff('-f', 'lavfi', '-i', 'color=c=red:s=300x300', '-frames:v', '1', path.join(alb, 'cover.jpg'));
  // Ljudbok i två delar med omslag
  const bok = dir('Ljudböcker', 'Författaren', 'Boken');
  for (const n of [1, 2]) ff('-f', 'lavfi', '-i', `sine=frequency=${250 * n}:duration=30`, '-metadata', `title=Del ${n}`, '-metadata', 'album=Boken', '-metadata', 'artist=Författaren', path.join(bok, `0${n}.mp3`));
  ff('-f', 'lavfi', '-i', 'color=c=blue:s=300x300', '-frames:v', '1', path.join(bok, 'cover.jpg'));
  // Poddflöde, IPTV-lista och TV-guide från en lokal server
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', path.join(ROOT, 'avsnitt.mp3'));
  ff('-f', 'lavfi', '-i', 'color=c=green:s=200x200', '-frames:v', '1', path.join(ROOT, 'bild.jpg'));
  ff('-f', 'lavfi', '-i', 'color=c=white:s=64x64', '-frames:v', '1', path.join(ROOT, 'logo.png'));
  const T0 = Math.floor(Date.now() / 1000);
  const xt = (t) => new Date(t * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  feed = http.createServer((q, r) => {
    const file = (f, type) => { r.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(f).size }); fs.createReadStream(f).pipe(r); };
    if (q.url === '/flode.xml') {
      r.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      r.end(`<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Testpodden</title><itunes:author>Anna</itunes:author>
        <description>En podd</description><itunes:image href="${feedBase}/bild.jpg"/>
        <item><title>Avsnitt 2</title><guid>a2</guid><pubDate>${new Date(Date.now() - 86400e3).toUTCString()}</pubDate><itunes:duration>10</itunes:duration><enclosure url="${feedBase}/avsnitt.mp3" length="1000" type="audio/mpeg"/><description>Andra</description></item>
        <item><title>Avsnitt 1</title><guid>a1</guid><pubDate>${new Date(Date.now() - 2 * 86400e3).toUTCString()}</pubDate><itunes:duration>0:10</itunes:duration><enclosure url="${feedBase}/avsnitt.mp3" type="audio/mpeg"/></item>
        </channel></rss>`);
    } else if (q.url === '/avsnitt.mp3') file(path.join(ROOT, 'avsnitt.mp3'), 'audio/mpeg');
    else if (q.url === '/bild.jpg') file(path.join(ROOT, 'bild.jpg'), 'image/jpeg');
    else if (q.url === '/logo.png') file(path.join(ROOT, 'logo.png'), 'image/png');
    else if (q.url === '/lista.m3u') {
      r.end(`#EXTM3U\n#EXTINF:-1 tvg-id="k1" tvg-chno="1" tvg-logo="${feedBase}/logo.png",Kanal Ett\n${feedBase}/k1.ts\n#EXTINF:-1 tvg-id="k2" tvg-chno="2",Kanal Två\n${feedBase}/k2.ts\n`);
    } else if (q.url === '/guide.xml') {
      r.end(`<?xml version="1.0"?><tv><channel id="k1"><display-name>Kanal Ett</display-name></channel><channel id="k2"><display-name>Kanal Två</display-name></channel>
        <programme start="${xt(T0 - 600)}" stop="${xt(T0 + 1800)}" channel="k1"><title>Nyheterna</title><sub-title>Kväll</sub-title></programme>
        <programme start="${xt(T0 + 1800)}" stop="${xt(T0 + 3600)}" channel="k1"><title>Filmen</title></programme>
        <programme start="${xt(T0 + 600)}" stop="${xt(T0 + 2400)}" channel="k2"><title>Sporten</title></programme></tv>`);
    } else { r.writeHead(404); r.end(); }
  }).listen(0, '127.0.0.1');
  await new Promise(r => feed.once('listening', r));
  feedBase = `http://127.0.0.1:${feed.address().port}`;

  srv = await startServer({ root: ROOT, media: MEDIA, env: { PODCAST_ALLOW_PRIVATE: '1', DVR_DIR: path.join(ROOT, 'dvr'), TMDB_API_KEY: '' } });
  // Administratör (webbkaka, hemnätet) skapar bibliotek, källor och väntar in skanningen
  ok(await srv.req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } }), 'setup');
  for (const [name, type, p] of [['Filmer', 'movie', 'Filmer'], ['Serier', 'show', 'Serier'], ['Musik', 'music', 'Musik'], ['Ljudböcker', 'audiobook', 'Ljudböcker']]) {
    ok(await srv.req('/api/libraries', { method: 'POST', body: { name, type, path: path.join(MEDIA, p) } }), 'bibliotek ' + name);
  }
  let libs = [];
  for (let i = 0; i < 300; i++) {
    await sleep(500);
    const s = (await srv.req('/api/scan')).data;
    libs = (await srv.req('/api/libraries')).data;
    if (!s.running && !s.analysis?.running && s.last && libs.every(l => l.count > 0)) break;
  }
  assert.ok(libs.every(l => l.count > 0), 'skanningen blev inte klar: ' + JSON.stringify(libs));
  const lib = (t) => libs.find(l => l.type === t).id;
  S.movieLib = lib('movie'); S.showLib = lib('show'); S.musicLib = lib('music'); S.bookLib = lib('audiobook');
  const movies = (await srv.req(`/api/libraries/${S.movieLib}/items`)).data.items;
  S.film = movies.find(i => i.title === 'Direkt Film').id; S.remux = movies.find(i => i.title === 'Remux Film').id;
  S.show = (await srv.req(`/api/libraries/${S.showLib}/items`)).data.items[0].id;
  const eps = (await srv.req(`/api/items/${S.show}`)).data.children;
  [S.ep1, S.ep2, S.ep3] = eps.map(e => e.id);

  // Rollista och intro/recap/eftertexter som TMDB och analysen annars ger (TMDB används inte i testet)
  const db = new DatabaseSync(path.join(ROOT, 'config', 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`INSERT INTO people(id,name) VALUES(501,'Anna Aktris'),(502,'Rolf Regissör')`);
  const ins = db.prepare('INSERT INTO item_people(item_id,person_id,role,character,ord) VALUES(?,?,?,?,?)');
  for (const id of [S.remux, S.show]) { ins.run(id, 501, 'cast', 'Huvudrollen', 0); ins.run(id, 502, id === S.show ? 'creator' : 'director', null, 0); }
  db.prepare('UPDATE items SET intro_start=1, intro_end=3, recap_start=0, recap_end=1, credits_start=6, rating=7.5 WHERE id IN (?,?)').run(S.ep2, S.remux);
  // Startsidans tematiska hyllor (Android läser dem): titlar utan filer i ett eget bibliotek vars mapp saknas (skanningen
  // tar inte bort något då), ett sett frö (Eftersom du såg …), tio komedier (Dagens genre), en premiär i dag för 30 år sedan
  // (Den här dagen) och ett kommande avsnitt av serien (Kommer snart)
  const now = Math.floor(Date.now() / 1000), d = new Date();
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const tema = Number(db.prepare('INSERT INTO libraries(name,type,path) VALUES(?,?,?)').run('Tema', 'movie', path.join(MEDIA, 'saknas')).lastInsertRowid);
  const insItem = db.prepare(`INSERT INTO items(library_id,kind,title,sort_title,year,duration,rating,genres,overview,backdrop,added,released)
    VALUES(?,'movie',?,?,?,?,?,?,?,0,?,?)`);
  const movie = (title, rating, released = '2001-02-03') => Number(insItem.run(tema, title, title.toLowerCase(), +released.slice(0, 4), 85 * 60, rating,
    JSON.stringify(['Komedi']), `Om ${title}`, now - 400 * 86400, released).lastInsertRowid);
  const seed = movie('Fröfilm', 6);
  for (let i = 0; i < 10; i++) movie(`Komedi ${i}`, 7.5 + i / 10);
  movie('Jubilaren', 7.6, `${d.getFullYear() - 30}-${md}`);
  const uid = db.prepare("SELECT id FROM users WHERE name='admin'").get().id;
  db.prepare('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,0,5100,1,?)').run(uid, seed, now - 60);
  const tomorrow = new Date(Date.now() + 86400e3);
  const ymd = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  db.prepare('UPDATE items SET tmdb_id=COALESCE(tmdb_id, 990001) WHERE id=?').run(S.show);
  db.prepare("INSERT INTO calendar_shows(show_id,tmdb_id,status,fetched) SELECT id, tmdb_id, 'Returning Series', ? FROM items WHERE id=?").run(now, S.show);
  db.prepare("INSERT INTO calendar_episodes(show_id,season,episode,name,air_date) VALUES(?,1,4,'Fjärde',?)").run(S.show, ymd);
  db.close();
  // Bio-läge med administratörens förfilm (Playback.preroll) och en egen samling på startsidan
  const pre = dir('Förfilmer');
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(pre, 'intro.mp4'));
  ok(await srv.req('/api/settings', { method: 'PUT', body: { cinemaPreroll: pre } }), 'förfilm');

  // Appinloggningar (Bearer) och bildtoken, som apparna
  for (const app of Object.keys(APPS)) {
    const r = await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, auth: false, headers: { 'user-agent': UA[app] } });
    TOK[app] = ok(r, 'inloggning').token;
    S.admin = r.data.user.id;
    TOK[app + 'Img'] = ok(await call(app, 'POST', '/api/media-token'), 'bildtoken').token;
  }
  ok(await call('android', 'PUT', '/api/me/cinema', { body: { preroll: true } }), 'bio-läge');
  // Det en användare gjort: tittat en bit, sett ett avsnitt, följer serien med offline-synk, musik, ljudbok, podd
  ok(await call('ios', 'POST', `/api/items/${S.remux}/progress`, { body: { position: 8, duration: 20 } }), 'framsteg');
  ok(await call('ios', 'POST', `/api/items/${S.ep1}/watched`, { body: { watched: true } }), 'sett');
  ok(await call('ios', 'POST', `/api/items/${S.show}/follow`, { body: { follow: true } }), 'följ');
  ok(await call('ios', 'PUT', '/api/me/offline-sync', { body: { count: 2 } }), 'offline-synk');
  const album = (await call('ios', 'GET', `/api/music/${S.musicLib}/albums`)).data[0];
  S.album = album.id; S.artist = album.artistId;
  const tracks = (await call('ios', 'GET', `/api/music/albums/${S.album}`)).data.trackList;
  S.track = tracks[0].id;
  ok(await call('ios', 'POST', `/api/music/tracks/${S.track}/favorite`, { body: { on: true } }), 'favorit');
  ok(await call('ios', 'POST', `/api/music/tracks/${S.track}/played`), 'spelad');
  S.playlist = ok(await call('android', 'POST', '/api/music/playlists', { body: { name: 'Bilen', trackIds: tracks.map(t => t.id) } }), 'spellista').id;
  // Egen smart spellista: syns i hemmets "smart" (id "u…") och kontrolleras mot samma kontrakt som de fasta
  ok(await call('ios', 'POST', '/api/music/smartlists', { body: { name: 'Allt', rules: [], sort: 'title', order: 'asc' } }), 'smart spellista');
  S.book = (await call('ios', 'GET', `/api/audiobooks/${S.bookLib}`)).data.books[0].id;
  S.bookFile = (await call('ios', 'GET', `/api/audiobooks/book/${S.book}`)).data.files[0].id;
  ok(await call('ios', 'POST', `/api/audiobooks/book/${S.book}/progress`, { body: { position: 40 } }), 'bokframsteg');
  S.podcast = ok(await call('ios', 'POST', '/api/podcasts', { body: { url: feedBase + '/flode.xml' } }), 'podd').id;
  S.episode = (await call('ios', 'GET', `/api/podcasts/${S.podcast}`)).data.episodes[0].id;
  ok(await call('ios', 'POST', `/api/podcasts/episodes/${S.episode}/progress`, { body: { position: 3 } }), 'poddframsteg');
  ok(await srv.req('/api/live/tuners', { method: 'POST', body: { kind: 'm3u', url: feedBase + '/lista.m3u', epgUrl: feedBase + '/guide.xml', tuners: 2 } }), 'IPTV-källa');
  const chans = (await call('android', 'GET', '/api/live/channels')).data.channels;
  S.channel = chans.find(c => c.logo).id;
  const T = Math.floor(Date.now() / 1000);
  S.rec = ok(await call('android', 'POST', '/api/dvr/manual', { body: { channelId: S.channel, start: T + 7200, stop: T + 7800, title: 'Bokad' } }), 'inspelning').id;
  // Bokning med decimalsekunder (Date.now()/1000) – får inte ge decimaltal i listan som Android läser som Long
  S.rec2 = ok(await call('android', 'POST', '/api/dvr/manual', { body: { channelId: S.channel, start: Date.now() / 1000 + 9000.25, stop: Date.now() / 1000 + 9600.75, title: 'Bokad igen' } }), 'inspelning').id;
  S.rec3 = ok(await call('ios', 'POST', '/api/dvr/manual', { body: { channelId: S.channel, start: T + 10800, stop: T + 11400, title: 'Bokad i iOS' } }), 'inspelning').id;
  // Programmet som iOS bokar från guiden: nästa program på kanalen som sänder nu (börjar om 30 minuter)
  S.program = chans.find(c => c.now && c.next).next.id;
  // IPTV-filmer och en serie som en Xtream-källa skulle ge (Android: hyllor och detaljer; bilderna från den lokala servern)
  const vdb = new DatabaseSync(path.join(ROOT, 'config', 'braxhn-tv.db'));
  vdb.exec('PRAGMA busy_timeout=5000');
  const tunerId = vdb.prepare('SELECT id FROM tuners ORDER BY id LIMIT 1').get().id;
  const insV = vdb.prepare('INSERT INTO iptv_vod(tuner_id,kind,ext_id,name,category,cover,plot,year,rating,duration,added,info) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)');
  S.vodMovie = Number(insV.run(tunerId, 'movie', 'm1', 'IPTV-filmen', 'Action', feedBase + '/bild.jpg', 'Handling', 2020, 7.1, 5400, T).lastInsertRowid);
  S.vodSeries = Number(insV.run(tunerId, 'series', 's1', 'IPTV-serien', 'Drama', feedBase + '/bild.jpg', 'Om serien', 2019, 6.5, null, T).lastInsertRowid);
  S.vodEp = Number(vdb.prepare('INSERT INTO iptv_episodes(vod_id,ext_id,season,episode,title,plot,duration,ext,image) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(S.vodSeries, 'e1', 1, 1, 'Första', 'Avsnittet', 2700, 'mp4', feedBase + '/bild.jpg').lastInsertRowid);
  const insP = vdb.prepare('INSERT INTO iptv_vod_progress(user_id,kind,ref_id,position,duration,watched,updated) VALUES(?,?,?,?,?,0,?)');
  insP.run(S.admin, 'movie', S.vodMovie, 120, 5400, T);
  insP.run(S.admin, 'episode', S.vodEp, 300, 2700, T);
  vdb.close();
  // Min lista och en egen samling på startsidan (iOS visar dem som hyllor)
  ok(await call('ios', 'POST', `/api/items/${S.remux}/watchlist`, { body: { add: true } }), 'Min lista');
  ok(await call('ios', 'POST', '/api/custom-collections', { body: { name: 'Favoriter', home: true, item: S.film } }), 'egen samling');
  // Offline-fil för den korta filmen (480p) – klar på några sekunder
  ok(await call('ios', 'POST', `/api/items/${S.film}/offline`, { body: { q: '480' } }), 'offline');
  for (let i = 0; i < 120; i++) { if ((await call('ios', 'GET', `/api/items/${S.film}/offline?q=480`)).data.status === 'ready') break; await sleep(500); }
  // Eget betyg, familjefiltret i läget "hoppa över scener" med en markerad scen (Playback.filter) och repliksökningens index
  ok(await call('android', 'PUT', `/api/items/${S.remux}/rating`, { body: { rating: 3.5 } }), 'betyg');
  ok(await call('android', 'PUT', '/api/me/family-filter', { body: { mode: 'skip' } }), 'familjefilter');
  ok(await call('android', 'POST', `/api/items/${S.film}/skips`, { body: { start: 2, end: 3, label: 'Testscen', scope: 'me' } }), 'markerad scen');
  for (let i = 0; i < 120; i++) { if ((await call('android', 'GET', '/api/search/lines?q=Hej')).data.lines?.length) break; await sleep(500); }
});
after(async () => { await srv?.stop(); feed?.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

// ---------------- vilka konkreta anrop varje endpoint provas med ----------------
// p = sökvägsparametrar, url = färdig adress (från ett tidigare svar, som apparna gör), auth: false = ingen
// Bearer-header (AVPlayer/bildladdning använder token i adressen), token = annan apptoken
const VARS = { $namn: 'admin', $lösenord: PW, $sök: 'Film', $musiksök: 'Låt', $replik: 'Hej', get $kanaler() { return String(S.channel); },
  get $från() { return String(Math.floor(Date.now() / 1000) - 3600); }, get $till() { return String(Math.floor(Date.now() / 1000) + 3 * 3600); }, get $har() { return `${S.ep3},99999999`; },
  get $program() { return S.program; }, get $profil() { return S.admin; }, get $artist() { return S.artist; } };
const sub = (v) => typeof v === 'string' && v.startsWith('$') ? VARS[v] : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v;
const playbackQ = (app, i = 0) => new URLSearchParams([C.endpoints['GET /api/items/:id/playback'][app].query].flat()[i]).toString();
const json = async (app, p) => ok(await call(app, 'GET', p), p);
async function streamCases(app, want) {
  const out = [];
  for (const q of [C.endpoints['GET /api/items/:id/playback'][app].query].flat().filter(q => q.info !== '1')) {
    for (const id of [S.film, S.remux, S.ep2]) {
      const pb = await json(app, `/api/items/${id}/playback?${new URLSearchParams(q)}`);
      if (want(pb) && !out.some(c => c.mode === pb.mode && c.id === id)) out.push({ url: pb.url, auth: false, mode: pb.mode, id });
    }
  }
  return out;
}
const imageCases = async (app) => {
  const out = [];
  for (const id of [S.film, S.remux, S.show, S.ep1]) {
    const it = await json(app, `/api/items/${id}`);
    for (const t of ['poster', 'backdrop', 'thumb']) if (it[t]) out.push({ url: `/api/image/${id}/${t}?t=${TOK[app + 'Img']}`, auth: false });
  }
  return out;
};
// Undertextfilen som kan synkas mot ljudet (Remux Film har en extern .srt)
async function syncCases(app) {
  const pb = await json(app, `/api/items/${S.remux}/playback?${playbackQ(app)}`);
  const s = pb.subtitles.find(x => x.syncable);
  assert.ok(s, 'ingen undertext som kan synkas: ' + JSON.stringify(pb.subtitles));
  return [{ p: { id: S.remux, sid: s.id } }];
}
const CASES = {
  'GET /api/status': () => [{}, { auth: false }],
  'POST /api/login': () => [{ auth: false }],
  'POST /api/media-token': () => [{}],
  'POST /api/quickconnect': () => [{ auth: false }],
  // Inloggning med kod: en väntande och en godkänd begäran (godkänd av admin, token lämnas ut en gång)
  'GET /api/quickconnect/:secret': async () => {
    const start = async () => ok(await srv.req('/api/quickconnect', { method: 'POST', body: { app: true, name: 'Kontrakt' }, auth: false }), 'kod');
    const pending = await start(), approved = await start();
    ok(await srv.req('/api/quickconnect/approve', { method: 'POST', body: { code: approved.code, confirm: true } }), 'godkänn kod');
    return [{ p: { secret: pending.secret }, auth: false }, { p: { secret: approved.secret }, auth: false }];
  },
  'GET /api/home': () => [{}],
  'GET /api/libraries': () => [{}],
  'GET /api/libraries/:id/items': () => [{ p: { id: S.movieLib } }, { p: { id: S.showLib } }],
  'GET /api/search': () => [{}],
  'GET /api/items/:id': () => [S.film, S.remux, S.show, S.ep1, S.ep2].map(id => ({ p: { id } })),
  'GET /api/items/:id/playback': () => [S.film, S.remux, S.ep2].map(id => ({ p: { id } })),
  // Strömadresserna tas ur playback-svaret med appens förmågor (utom info=1, som bara visar läget)
  'GET /api/stream/:id/direct': (app) => streamCases(app, (pb) => pb.mode === 'direct'),
  'GET /api/stream/:id/hls/master.m3u8': (app) => streamCases(app, (pb) => pb.mode !== 'direct'),
  'GET /api/stream/:id/subs/:sid': async (app) => {
    const pb = await json(app, `/api/items/${S.remux}/playback?${playbackQ(app)}`);
    const out = pb.subtitles.map(s => ({ url: s.url, auth: false }));
    if (app === 'ios') out.push({ url: `/api/stream/${S.remux}/subs/${pb.subtitles[0].id}.vtt` });
    return out;
  },
  'GET /api/image/:id/:type': imageCases,
  'POST /api/items/:id/progress': () => [{ p: { id: S.film } }, { p: { id: S.ep3 } }],
  'POST /api/items/:id/watched': () => [{ p: { id: S.film } }],
  'POST /api/items/:id/offline': () => [{ p: { id: S.film } }],
  'GET /api/items/:id/offline': () => [{ p: { id: S.film } }, { p: { id: S.remux } }],
  'GET /api/stream/:id/offline-file': async (app) => {
    const st = await json(app, `/api/items/${S.film}/offline?q=480`);
    assert.equal(st.status, 'ready', 'offline-filen blev inte klar: ' + JSON.stringify(st));
    return [{ url: st.url, auth: false }];
  },
  'GET /api/offline/sync': () => [{}],
  'GET /api/me/listening': () => [{}],
  'PUT /api/me/listening': () => [{}],
  'GET /api/music/:lib/home': () => [{ p: { lib: S.musicLib } }],
  'GET /api/music/:lib/albums': () => [{ p: { lib: S.musicLib } }],
  'GET /api/music/:lib/artists': () => [{ p: { lib: S.musicLib } }],
  'GET /api/music/:lib/search': () => [{ p: { lib: S.musicLib } }],
  'GET /api/music/:lib/smart/:sid': async (app) => (await json(app, `/api/music/${S.musicLib}/home`)).smart.map(s => ({ p: { lib: S.musicLib, sid: s.id } })),
  'POST /api/music/radio': () => [{}],
  'GET /api/music/albums/:aid': () => [{ p: { aid: S.album } }],
  'GET /api/music/artists/:arid': () => [{ p: { arid: S.artist } }],
  'GET /api/music/playlists': () => [{}],
  'GET /api/music/playlists/:pid': () => [{ p: { pid: S.playlist } }],
  'GET /api/music/tracks/:tid/play': () => [{ p: { tid: S.track } }],
  'GET /api/music/tracks/:tid/stream': async (app) => app === 'ios'
    ? [{ url: (await json(app, `/api/music/tracks/${S.track}/play`)).url + '&a=mp3,aac,flac,alac', auth: false }]
    : [{ p: { tid: S.track } }],
  'POST /api/music/tracks/:tid/played': () => [{ p: { tid: S.track } }],
  'GET /api/music/cover/:aid': (app) => [{ url: `/api/music/cover/${S.album}?t=${TOK[app + 'Img']}`, auth: false }],
  'GET /api/audiobooks/:lib': () => [{ p: { lib: S.bookLib } }],
  'GET /api/audiobooks/book/:bid': () => [{ p: { bid: S.book } }],
  'GET /api/audiobooks/book/:bid/play': () => [{ p: { bid: S.book } }],
  'POST /api/audiobooks/book/:bid/progress': () => [{ p: { bid: S.book } }],
  'GET /api/audiobooks/files/:fid/stream': async (app) => app === 'ios'
    ? (await json(app, `/api/audiobooks/book/${S.book}/play?a=mp3,aac,flac,alac`)).files.map(f => ({ url: f.url, auth: false }))
    : [{ p: { fid: S.bookFile } }],
  'GET /api/audiobooks/cover/:bid': (app) => [{ url: `/api/audiobooks/cover/${S.book}?t=${TOK[app + 'Img']}`, auth: false }],
  'GET /api/podcasts': () => [{}],
  'GET /api/podcasts/:pid': () => [{ p: { pid: S.podcast } }],
  'GET /api/podcasts/:pid/image': (app) => [{ url: `/api/podcasts/${S.podcast}/image?t=${TOK[app + 'Img']}`, auth: false }],
  'GET /api/podcasts/episodes/:eid': () => [{ p: { eid: S.episode } }],
  'GET /api/podcasts/episodes/:eid/play': () => [{ p: { eid: S.episode } }],
  'GET /api/podcasts/episodes/:eid/stream': async (app) => app === 'ios'
    ? [{ url: (await json(app, `/api/podcasts/episodes/${S.episode}/play`)).url, auth: false }]
    : [{ p: { eid: S.episode } }],
  'POST /api/podcasts/episodes/:eid/progress': () => [{ p: { eid: S.episode } }],
  'GET /api/live/channels': () => [{}],
  'GET /api/live/logo/:cid': (app) => [{ url: `/api/live/logo/${S.channel}?t=${TOK[app + 'Img']}`, auth: false }],
  'POST /api/live/:cid/play': () => [{ p: { cid: S.channel } }],
  'GET /api/dvr': () => [{}],
  'POST /api/dvr/recordings/:rid/play': () => [{ p: { rid: S.rec } }],
  'DELETE /api/dvr/recordings/:rid': (app) => [{ p: { rid: app === 'ios' ? S.rec3 : S.rec2 } }],
  'GET /api/live/guide': () => [{}],
  'POST /api/dvr/program': () => [{}],
  'GET /api/watchlist': () => [{}],
  'POST /api/items/:id/watchlist': () => [{ p: { id: S.remux } }, { p: { id: S.ep1 } }],
  'GET /api/profiles': () => [{}],
  // Profilbyte stänger inloggningen det görs med – en egen inloggning, som vid utloggning
  'POST /api/profiles/switch': async () => [{ token: ok(await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, auth: false }), 'inloggning').token }],
  'POST /api/stream/:id/stop': () => [{ p: { id: S.remux } }, { p: { id: S.ep2 } }],
  'GET /api/me/cinema': () => [{}],
  // Android: betyg, temamusik, extramaterial, repliksökning och undertextsynk
  'PUT /api/items/:id/rating': () => [{ p: { id: S.film } }],
  'GET /api/items/:id/theme': () => [{ p: { id: S.show } }],
  'GET /api/trailers/:tid/play': async (app) => [{ p: { tid: (await json(app, `/api/items/${S.show}`)).extras[0].id } }],
  'GET /api/trailers/:tid/stream': async (app) => {
    const x = (await json(app, `/api/items/${S.show}`)).extras[0];
    return [{ url: (await json(app, `/api/trailers/${x.id}/play`)).url, auth: false }];
  },
  'GET /api/search/lines': () => [{}],
  'POST /api/items/:id/subs/:sid/sync': (app) => syncCases(app),
  'GET /api/items/:id/subs/:sid/sync': (app) => syncCases(app),
  // Android: IPTV-guiden, favoriter, snabbt kanalbyte, filmer och serier
  'GET /api/iptv/channels': () => [{}],
  'GET /api/iptv/epg': () => [{}],
  'PUT /api/iptv/favorites/:cid': () => [{ p: { cid: S.channel } }],
  'POST /api/iptv/channels/:cid/prestart': () => [{ p: { cid: S.channel } }],
  'GET /api/iptv/vod': () => [{}],
  'GET /api/iptv/vod/:id': () => [{ p: { id: S.vodMovie } }, { p: { id: S.vodSeries } }],
  'GET /api/iptv/vod/:id/:kind.jpg': (app) => [{ url: `/api/iptv/vod/${S.vodMovie}/cover.jpg?t=${TOK[app + 'Img']}`, auth: false }],
  'GET /api/iptv/episodes/:eid/image.jpg': (app) => [{ url: `/api/iptv/episodes/${S.vodEp}/image.jpg?t=${TOK[app + 'Img']}`, auth: false }],
  // Utloggning med en egen inloggning, så att apparnas token gäller för resten av testet
  'POST /api/logout': async (app) => [{ token: ok(await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, auth: false }), 'inloggning').token }]
};

const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas', timeout: 120000 }, fn);

t('varje endpoint i kontraktet provas i testet (och inget anrop saknas i kontraktet)', () => {
  assert.deepEqual(Object.keys(CASES).sort(), Object.keys(C.endpoints).sort());
});

for (const [key, e] of Object.entries(C.endpoints)) {
  const [method, pattern] = key.split(' ');
  for (const app of Object.keys(e)) {
    const spec = e[app];
    t(`${key} – ${APPS[app]}`, async () => {
      const cases = await CASES[key](app);
      assert.ok(cases.length, `${key}: testdatan gav inget att prova`);
      const queries = spec.query ? [spec.query].flat() : [{}];
      const problems = [];
      for (const cs of cases) for (const q of cs.url ? [{}] : queries) {
        let p = cs.url || pattern.replace(/:(\w+)/g, (_, k) => { assert.ok(cs.p?.[k] != null, `${key}: parametern ${k} saknas`); return encodeURIComponent(cs.p[k]); });
        const qs = new URLSearchParams(sub(q)).toString();
        if (qs) p += (p.includes('?') ? '&' : '?') + qs;
        const r = await call(app, method, p, { body: spec.body ? sub(spec.body) : undefined, auth: cs.auth !== false, token: cs.token });
        const head = `${method} ${p.replace(/([?&]t=)[0-9a-f]{16,}/g, '$1…')} – ${APPS[app]} går sönder (${spec.källa})`;
        if (spec.svar === null) {
          if (r.status < 200 || r.status >= 300) problems.push(`${head}\n  • svarade ${r.status}: ${JSON.stringify(r.data).slice(0, 200)} – appen väntar sig 2xx`);
        } else if (spec.svar.media) {
          const ct = r.headers.get('content-type') || '';
          if (![200, 206].includes(r.status) || !new RegExp(spec.svar.media).test(ct)) problems.push(`${head}\n  • svarade ${r.status} med Content-Type "${ct}" – förväntat ${spec.svar.media}`);
          else if (!r.data.length) problems.push(`${head}\n  • tomt svar`);
        } else {
          if (r.status !== 200) { problems.push(`${head}\n  • svarade ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`); continue; }
          if (!/json/.test(r.headers.get('content-type') || '')) { problems.push(`${head}\n  • svaret är inte JSON`); continue; }
          const errs = [];
          check(r.data, spec.svar, 'svar', errs);
          if (errs.length) problems.push(report(head, errs));
        }
      }
      if (problems.length) assert.fail('\n' + problems.join('\n'));
    });
  }
}

t('API-versionen anges i /api/status och matchar kontraktet', async () => {
  const s = (await call('ios', 'GET', '/api/status', { auth: false })).data;
  assert.ok(Number.isInteger(s.api), 'fältet api ska vara ett heltal');
  assert.equal(s.api, C.api, 'API-versionen har ändrats – se docs/api.md (bara tillägg inom samma version)');
});

t('testdatan prövar varje typ i kontraktet mot ett verkligt svar', (tc) => {
  const unused = Object.keys(C.typer).filter(n => !seen.has(n));
  assert.deepEqual(unused, [], 'typer som aldrig förekom i något svar (lägg till testdata): ' + unused.join(', '));
  // Valfria fält som aldrig hade ett värde – inte fel, men de är bara typkontrollerade i teorin
  for (const [n, d] of Object.entries(C.typer)) {
    const miss = Object.keys(d.optional || {}).filter(k => !observed.get(n)?.has(k));
    if (miss.length) tc.diagnostic(`${n}: valfria fält utan värde i testdatan: ${miss.join(', ')}`);
  }
});
