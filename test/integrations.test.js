// Sonarr/Radarr, Trakt och notiser mot simulerade tjänster
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-intg-'));
process.env.TRANSCODE_DIR = path.join(process.env.CONFIG_DIR, 'tc');
process.env.NODE_ENV = 'test';

// En enda låtsasserver för Radarr, Sonarr, Trakt och ntfy
const calls = [];
const srv = http.createServer((q, r) => {
  let b = ''; q.on('data', d => b += d);
  q.on('end', () => {
    calls.push({ m: q.method, u: q.url, b: b ? JSON.parse(b) : null, h: q.headers });
    const J = (o, s = 200) => { r.writeHead(s, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
    if (q.url.startsWith('/api/v3/movie/lookup/tmdb')) return J({ title: 'Arrival', year: 2016, tmdbId: 329865, images: [] });
    if (q.url === '/api/v3/qualityprofile') return J([{ id: 4, name: 'HD-1080p' }]);
    if (q.url === '/api/v3/rootfolder') return J([{ path: '/movies', freeSpace: 1e12 }]);
    if (q.url === '/api/v3/movie' && q.method === 'POST') return J({ id: 1 }, 201);
    if (q.url === '/sync/watched/movies') return J([{ movie: { ids: { tmdb: 111 } } }]);
    if (q.url === '/sync/watched/shows') return J([]);
    if (q.url === '/sync/history') return J({ added: { movies: 1 } }, 201);
    if (q.url === '/' && q.method === 'POST') return J({}); // ntfy (JSON-publicering)
    J({ error: 'okänd' }, 404);
  });
}).listen(0);
await new Promise(r => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
process.env.TRAKT_API = base;
after(() => srv.close());

const { run, setSetting, get } = await import('../server/db.js');
const arr = await import('../server/arr.js');
const trakt = await import('../server/trakt.js');

run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
run("INSERT INTO libraries(id,name,type,path) VALUES(1,'Serier','show','/media/Serier'),(2,'Filmer','movie','/media/Filmer')");

test('webhook: sökvägsmappning väljer rätt bibliotek', () => {
  setSetting('arr_path_map', '/tv=/media/Serier,/movies=/media/Filmer');
  const w = arr.parseWebhook({ eventType: 'Download', series: { title: 'Bron', path: '/tv/Bron' }, episodeFile: { relativePath: 'Season 1/Bron S01E01.mkv' } });
  assert.equal(w.path, '/media/Serier/Bron/Season 1/Bron S01E01.mkv');
  assert.deepEqual(w.libIds, [1]);
  assert.ok(arr.SCAN_EVENTS.test(w.event));
  assert.ok(!arr.SCAN_EVENTS.test('Test'));
  const m = arr.parseWebhook({ eventType: 'Download', movie: { folderPath: '/movies/Arrival (2016)' } });
  assert.deepEqual(m.libIds, [2]);
  // Okänd sökväg → alla videobibliotek
  assert.equal(arr.parseWebhook({ eventType: 'Download', movie: { folderPath: '/annat' } }).libIds.length, 2);
  assert.ok(arr.checkKey(arr.webhookKey()) && !arr.checkKey('fel'));
});

test('önskemål skickas till Radarr med profil och rotmapp', async () => {
  setSetting('radarr_url', base); setSetting('radarr_key', 'nyckel');
  const { row } = arr.create({ id: 1, name: 'anna' }, { kind: 'movie', tmdbId: 329865, title: 'Arrival', year: 2016 });
  const r = await arr.send(row, async () => null);
  assert.ok(r.added);
  const post = calls.find(c => c.u === '/api/v3/movie' && c.m === 'POST');
  assert.equal(post.b.qualityProfileId, 4); assert.equal(post.b.rootFolderPath, '/movies'); assert.equal(post.b.addOptions.searchForMovie, true);
  assert.equal(post.h['x-api-key'], 'nyckel');
  // När filmen dyker upp i biblioteket markeras önskan som tillgänglig
  run("INSERT INTO items(library_id,kind,title,tmdb_id,added) VALUES(2,'movie','Arrival',329865,0)");
  arr.markAvailable();
  assert.equal(get('SELECT status FROM requests WHERE id=?', row.id).status, 'available');
});

test('Trakt: tvåvägssynk av sett-status', async () => {
  setSetting('trakt_client_id', 'id'); setSetting('trakt_client_secret', 'hemlis');
  run("INSERT INTO trakt(user_id,access,refresh,expires) VALUES(1,'tok','ref',?)", Math.floor(Date.now() / 1000) + 30 * 86400);
  const a = Number(run("INSERT INTO items(library_id,kind,title,tmdb_id,added) VALUES(2,'movie','Sedd på Trakt',111,0)").lastInsertRowid);
  const b = Number(run("INSERT INTO items(library_id,kind,title,tmdb_id,added) VALUES(2,'movie','Sedd här',222,0)").lastInsertRowid);
  run('INSERT INTO progress(user_id,item_id,position,watched,updated) VALUES(1,?,0,1,0)', b);
  const r = await trakt.sync(1);
  assert.equal(r.imported, 1); assert.equal(r.exported, 1);
  assert.equal(get('SELECT watched FROM progress WHERE user_id=1 AND item_id=?', a).watched, 1);
  const hist = calls.find(c => c.u === '/sync/history');
  assert.equal(hist.b.movies[0].ids.tmdb, 222);
  assert.equal(hist.h.authorization, 'Bearer tok'); assert.equal(hist.h['trakt-api-key'], 'id');
});

test('notiser: ntfy får titel och meddelande', async () => {
  const n = await import('../server/notify.js');
  setSetting('notify_kind', 'ntfy'); setSetting('notify_url', base + '/ntfy');
  assert.equal(await n.notify('security', 'Test', 'Hej å ä ö'), true);
  const post = calls.filter(x => x.b?.topic === 'ntfy').pop();
  assert.equal(post.b.title, 'BraXhn TV: Test'); assert.equal(post.b.message, 'Hej å ä ö');
  // Händelser som är avstängda skickas inte
  setSetting('notify_events', 'cert');
  assert.equal(await n.notify('security', 'X', 'Y'), false);
});
