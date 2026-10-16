// Drift: diskövervakning, Prometheus-mätvärden, import från Plex/Jellyfin (mot låtsasservrar) och DLNA (SOAP/DIDL utan multicast).
// Modulerna testas i samma process; HTTP-skyddet (token, betrott nät) testas mot en riktig server. Kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-ops-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.DVR_DIR = path.join(ROOT, 'rec');
process.env.PODCAST_DIR = path.join(ROOT, 'pod');
delete process.env.METRICS_TOKEN; delete process.env.DLNA; delete process.env.TMDB_API_KEY;

// ---------- låtsasservrar: Plex, Jellyfin och en webhook för notiser ----------
const hooks = [];
const plexMovies = [
  { ratingKey: '1', title: 'Arrival', year: 2016, viewCount: 1, lastViewedAt: 1700000000, duration: 6960000, Guid: [{ id: 'imdb://tt2543164' }, { id: 'tmdb://329865' }] },
  { ratingKey: '2', title: 'Lokal på Plex', year: 2019, viewOffset: 600000, lastViewedAt: 1700000100, Media: [{ Part: [{ file: '/data/movies/Lokal (2019)/Lokal (2019).mkv' }] }] },
  { ratingKey: '3', title: 'Titelfilm', year: 2001, viewCount: 2, guid: 'com.plexapp.agents.imdb://tt0000999?lang=en' },
  { ratingKey: '4', title: 'Finns <inte> här', year: 1999, viewCount: 1 },
  { ratingKey: '5', title: 'Osedd', year: 2020, viewCount: 0 }
];
const plexEpisodes = [
  { grandparentRatingKey: '100', grandparentTitle: 'Bron', parentIndex: 1, index: 2, title: 'Två', viewCount: 1 },
  { grandparentRatingKey: '100', grandparentTitle: 'Bron', parentIndex: 1, index: 3, title: 'Tre', viewOffset: 120000 }
];
const fake = http.createServer((q, r) => {
  let b = ''; q.on('data', d => b += d);
  q.on('end', () => {
    const J = (o, s = 200) => { r.writeHead(s, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/hook') { hooks.push(JSON.parse(b)); return J({}); }
    if (u.pathname.startsWith('/plex/')) {
      if (q.headers['x-plex-token'] !== 'plextok') return J({}, 401);
      const p = u.pathname.slice(5);
      if (p === '/library/sections') return J({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Filmer' }, { key: '2', type: 'show', title: 'Serier' }, { key: '3', type: 'artist' }] } });
      const start = +u.searchParams.get('X-Plex-Container-Start') || 0, size = +u.searchParams.get('X-Plex-Container-Size') || 50;
      const page = (list) => J({ MediaContainer: { totalSize: list.length, Metadata: list.slice(start, start + size) } });
      if (p === '/library/sections/1/all') return page(plexMovies);
      if (p === '/library/sections/2/all' && u.searchParams.get('type') === '2') return page([{ ratingKey: '100', title: 'Bron', year: 2011, Guid: [{ id: 'tmdb://555' }] }]);
      if (p === '/library/sections/2/all' && u.searchParams.get('type') === '4') return page(plexEpisodes);
      return J({}, 404);
    }
    if (u.pathname.startsWith('/jf/')) {
      if (q.headers['x-emby-token'] !== 'jfkey') return J({}, 401);
      const p = u.pathname.slice(3);
      if (p === '/Users') return J([{ Id: 'u1', Name: 'Anna' }, { Id: 'u2', Name: '<script>' }]);
      if (p === '/Users/u1/Items') {
        const f = u.searchParams.get('Filters'), types = u.searchParams.get('IncludeItemTypes');
        if (types === 'Series') return J({ TotalRecordCount: 1, Items: [{ Id: 's1', Name: 'Bron', ProductionYear: 2011, ProviderIds: { Tvdb: '252019' } }] });
        if (f === 'IsPlayed') return J({ TotalRecordCount: 2, Items: [
          { Id: 'm1', Type: 'Movie', Name: 'Arrival', ProductionYear: 2016, ProviderIds: { Tmdb: '329865', Imdb: 'tt2543164' }, UserData: { Played: true, LastPlayedDate: '2024-01-02T10:00:00Z' } },
          { Id: 'e1', Type: 'Episode', Name: 'Ett', SeriesId: 's1', SeriesName: 'Bron', ParentIndexNumber: 1, IndexNumber: 1, UserData: { Played: true } }] });
        if (f === 'IsResumable') return J({ TotalRecordCount: 1, Items: [
          { Id: 'm2', Type: 'Movie', Name: 'Lokal', Path: '/data/movies/Lokal (2019)/Lokal (2019).mkv', RunTimeTicks: 72000e7, UserData: { Played: false, PlaybackPositionTicks: 3000e7 } }] });
      }
      return J({}, 404);
    }
    J({}, 404);
  });
}).listen(0);
await new Promise(r => fake.once('listening', r));
const FB = `http://127.0.0.1:${fake.address().port}`;
after(() => { fake.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const D = await import('../server/db.js');
const diskmon = await import('../server/diskmon.js');
const metrics = await import('../server/metrics.js');
const imp = await import('../server/mediaimport.js');
const dlna = await import('../server/dlna.js');
const notify = await import('../server/notify.js');
const { run, get, setSetting } = D;

// Bibliotek och titlar
const touch = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'.repeat(1000)); };
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
run("INSERT INTO users(id,name,pass,is_admin,created,parent_id,max_age) VALUES(2,'barn','x',0,0,1,7)");
const FILM = path.join(MEDIA, 'Filmer'), TV = path.join(MEDIA, 'Serier');
run('INSERT INTO libraries(id,name,type,path) VALUES(1,?,?,?),(2,?,?,?)', 'Filmer', 'movie', FILM, 'Serier', 'show', TV);
const item = (o) => Number(run(`INSERT INTO items(library_id,kind,title,sort_title,year,tmdb_id,path,size,duration,parent_id,season,episode,age,width,height,added)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, o.lib, o.kind, o.title, o.title.toLowerCase(), o.year ?? null, o.tmdb ?? null, o.path ?? null, o.path ? 1000 : null,
  o.duration ?? null, o.parent ?? null, o.season ?? null, o.episode ?? null, o.age ?? null, o.w ?? null, o.h ?? null, 1).lastInsertRowid);
const lokalPath = path.join(FILM, 'Lokal (2019)', 'Lokal (2019).mkv');
const arrival = item({ lib: 1, kind: 'movie', title: 'Arrival', year: 2016, tmdb: 329865, path: path.join(FILM, 'Arrival (2016).mkv'), duration: 6960, age: 11, w: 1920, h: 1080 });
const lokal = item({ lib: 1, kind: 'movie', title: 'Lokal', year: 2019, path: lokalPath, duration: 7200 });
const titelfilm = item({ lib: 1, kind: 'movie', title: 'Titelfilm', year: 2001, path: path.join(FILM, 'Titelfilm.mp4') });
const vuxen = item({ lib: 1, kind: 'movie', title: 'Tom & "Jerry" <vuxen>', year: 2000, path: path.join(FILM, 'Vuxen.mkv'), age: 18 });
const bron = item({ lib: 2, kind: 'show', title: 'Bron', year: 2011, tmdb: 555, age: 15 });
const ep = [1, 2, 3].map(n => item({ lib: 2, kind: 'episode', title: `Avsnitt ${n}`, parent: bron, season: 1, episode: n, path: path.join(TV, 'Bron', `Bron S01E0${n}.mkv`), duration: 3600 }));
for (const f of [lokalPath, path.join(FILM, 'Arrival (2016).mkv')]) touch(f);

// ---------- diskövervakning ----------
test('disk: nivåer efter procent- och GB-gräns', () => {
  const th = { pct: 10, gb: 10 };
  assert.equal(diskmon.levelOf(500e9, 1000e9, th), 'ok');
  assert.equal(diskmon.levelOf(80e9, 1000e9, th), 'low', 'under 10 %');
  assert.equal(diskmon.levelOf(8e9, 40e9, th), 'low', 'under 10 GB');
  assert.equal(diskmon.levelOf(2e9, 1000e9, th), 'critical');
  assert.equal(diskmon.levelOf(80e9, 1000e9, { pct: 0, gb: 10 }), 'ok', '0 stänger av gränsen');
  assert.equal(diskmon.levelOf(0, 0, th), 'unknown');
});

test('disk: notis vid övergång, ingen spam, påminnelse efter ett dygn, hysteres och återställning', () => {
  const th = { pct: 10, gb: 10 };
  const g = (free, total = 1000e9) => [{ key: 'config', labels: ['Konfiguration', 'Omkodning'], free, total, level: diskmon.levelOf(free, total, th) }];
  let t = 1e12, st = {};
  let r = diskmon.evaluate(g(500e9), st, th, t); st = r.state;
  assert.equal(r.notices.length, 0);
  r = diskmon.evaluate(g(50e9), st, th, t += 60e3); st = r.state;
  assert.equal(r.notices.length, 1); assert.match(r.notices[0].title, /Lite ledigt/); assert.match(r.notices[0].message, /Konfiguration, Omkodning/);
  for (let i = 0; i < 20; i++) { r = diskmon.evaluate(g(49e9), st, th, t += 300e3); st = r.state; assert.equal(r.notices.length, 0, 'ingen notis vid varje kontroll'); }
  r = diskmon.evaluate(g(20e9), st, th, t += 300e3); st = r.state;
  assert.equal(r.notices.length, 1, 'värre nivå ger ny notis'); assert.match(r.notices[0].title, /nästan slut/);
  r = diskmon.evaluate(g(26e9), st, th, t += 60e3); st = r.state;
  assert.equal(r.notices.length, 0); assert.equal(st.config.level, 'critical', 'strax över kritisk gräns räcker inte (hysteres)');
  r = diskmon.evaluate(g(20e9), st, th, t += 60e3); st = r.state;
  assert.equal(r.notices.length, 0, 'pendling kring gränsen ger ingen notis');
  r = diskmon.evaluate(g(20e9), st, th, t += 86400e3); st = r.state;
  assert.equal(r.notices.length, 1); assert.match(r.notices[0].title, /Fortfarande/);
  r = diskmon.evaluate(g(105e9), st, th, t += 60e3); st = r.state;
  assert.equal(r.notices.length, 0, 'strax över gränsen räknas inte som återställt');
  r = diskmon.evaluate(g(300e9), st, th, t += 60e3); st = r.state;
  assert.equal(r.notices.length, 1); assert.match(r.notices[0].title, /räcker igen/);
  r = diskmon.evaluate(g(300e9), st, th, t += 86400e3 * 3);
  assert.equal(r.notices.length, 0);
});

test('disk: kontroll av riktiga mappar, notis via webhook och säkerhetskontroll', async () => {
  setSetting('notify_kind', 'webhook'); setSetting('notify_url', FB + '/hook'); setSetting('notify_events', 'disk');
  setSetting('disk_alert_state', '{}');
  setSetting('disk_min_pct', '0'); setSetting('disk_min_gb', '0'); // testmaskinens disk kan vara nästan full
  let s = await diskmon.check();
  const keys = s.entries.map(e => e.key);
  for (const k of ['config', 'transcode', 'dvr']) assert.ok(keys.includes(k), k);
  assert.ok(s.entries.find(e => e.key === 'config').total > 0);
  assert.ok(s.entries.find(e => e.key === 'lib2').error, 'saknad biblioteksmapp visas som fel');
  assert.ok(diskmon.checkItems().every(i => i.level === 'ok'));
  // Orimligt hög gräns → allt är "fullt": en notis per filsystem, inte per mapp, och ingen upprepning
  setSetting('disk_min_gb', '99999');
  const before = hooks.length;
  s = await diskmon.check();
  const crit = s.groups.filter(g => g.level === 'critical');
  assert.ok(crit.length >= 1);
  assert.equal(hooks.length - before, crit.length);
  assert.match(hooks.at(-1).title, /Diskutrymmet är nästan slut/);
  assert.ok(diskmon.checkItems().some(i => i.level === 'bad'));
  await diskmon.check();
  assert.equal(hooks.length - before, crit.length, 'ingen ny notis vid nästa kontroll');
  setSetting('disk_min_gb', '0');
  setSetting('notify_kind', 'none');
  assert.ok(notify.EVENTS.disk && notify.DEFAULT_EVENTS.includes('disk'));
});

// ---------- Prometheus ----------
test('metrics: token, format och innehåll', () => {
  assert.equal(metrics.enabled(), false);
  assert.equal(metrics.checkToken('Bearer vadsomhelst'), false);
  const tok = metrics.newToken();
  assert.ok(metrics.enabled());
  assert.ok(!get("SELECT v FROM settings WHERE k='metrics_token_hash'").v.includes(tok), 'token sparas bara som hash');
  assert.ok(metrics.checkToken('Bearer ' + tok));
  assert.ok(!metrics.checkToken('Bearer ' + tok + 'x'));
  assert.ok(!metrics.checkToken(tok), 'kräver Bearer');
  const txt = metrics.render();
  for (const f of ['braxhn_streams_active{mode="transcode"} 0', 'braxhn_transcode_sessions 0', 'braxhn_scan_running 0', 'braxhn_live_tuners_in_use 0',
    'braxhn_library_items{library="Filmer",type="movie",kind="movie"} 4', 'braxhn_library_items{library="Serier",type="show",kind="episode"} 3',
    '# TYPE braxhn_auth_events_total counter', 'braxhn_disk_free_bytes{target="config"', 'process_resident_memory_bytes', 'braxhn_uptime_seconds'])
    assert.ok(txt.includes(f), f);
  // Varje rad: kommentar eller namn{etiketter} värde
  for (const l of txt.trim().split('\n')) assert.match(l, /^(# (HELP|TYPE) \w+ .+|[a-z_][a-z0-9_]*(\{[^}]*\})? (-?[\d.e+]+|NaN))$/, l);
  run("INSERT INTO libraries(name,type,path) VALUES(?, 'movie', '/x')", 'Konstig "namn"\\\n');
  assert.ok(metrics.render().includes('library="Konstig \\"namn\\"\\\\\\n"'), 'etiketter escapas');
  run("DELETE FROM libraries WHERE path='/x'");
  metrics.disable();
  assert.equal(metrics.enabled(), false);
});

// ---------- import från Plex och Jellyfin ----------
test('import: sökvägsmappning och titelnormalisering', () => {
  const m = imp.parsePathMap('/data=/media\n/data/movies=/media/Filmer, C:\\Film=/media/F');
  assert.equal(imp.mapPath('/data/movies/a.mkv', m), '/media/Filmer/a.mkv', 'längsta prefixet vinner');
  assert.equal(imp.mapPath('/data/tv/b.mkv', m), '/media/tv/b.mkv');
  assert.equal(imp.mapPath('C:\\Film\\x.mkv', m), '/media/F/x.mkv');
  assert.equal(imp.mapPath('/dataX/y', m), '/dataX/y');
  assert.equal(imp.normTitle('Amélie: Le Fabuleux & co!'), 'amelielefabuleuxandco');
  assert.deepEqual(imp.plexIds({ Guid: [{ id: 'tmdb://1' }], guid: 'com.plexapp.agents.thetvdb://9/1/2?lang=en' }), { tmdb: '1', tvdb: '9' });
  assert.throws(() => imp.checkUrl('ftp://x'), /Ange adressen/);
});

test('import: Plex – förhandsvisning matchar på id, sökväg och titel; import skriver historik', async () => {
  await assert.rejects(imp.preview({ source: 'plex', url: FB + '/plex', token: 'fel' }), /nekade åtkomst/);
  const P = await imp.preview({ source: 'plex', url: FB + '/plex/', token: 'plextok', pathMap: `/data/movies=${FILM}` });
  assert.equal(P.total, 6, 'osedda tas inte med');
  assert.equal(P.matched, 5); assert.equal(P.unmatched, 1);
  assert.deepEqual(P.byMethod, { id: 3, path: 1, title: 1 });
  assert.equal(P.unmatchedSample[0].title, 'Finns <inte> här (1999)');
  assert.equal(P.watched, 3); assert.equal(P.inProgress, 2);
  // Användaren har redan sett avsnitt 3 här – det ska inte bli "påbörjat" igen
  run('INSERT INTO progress(user_id,item_id,position,watched,updated) VALUES(1,?,0,1,1)', ep[2]);
  const r = imp.runImport(P.id, [1, 999]);
  assert.equal(r.users, 1); assert.equal(r.watched, 3); assert.equal(r.progress, 1); assert.equal(r.skipped, 1);
  assert.equal(get('SELECT watched FROM progress WHERE user_id=1 AND item_id=?', arrival).watched, 1);
  assert.equal(get('SELECT updated FROM progress WHERE user_id=1 AND item_id=?', arrival).updated, 1700000000, 'tiden från Plex behålls');
  const lp = get('SELECT position, watched, duration FROM progress WHERE user_id=1 AND item_id=?', lokal);
  assert.equal(lp.position, 600); assert.equal(lp.watched, 0); assert.equal(lp.duration, 7200);
  assert.equal(get('SELECT watched FROM progress WHERE user_id=1 AND item_id=?', titelfilm).watched, 1);
  assert.equal(get('SELECT watched FROM progress WHERE user_id=1 AND item_id=?', ep[1]).watched, 1);
  assert.equal(get('SELECT watched FROM progress WHERE user_id=1 AND item_id=?', ep[2]).watched, 1);
  assert.throws(() => imp.runImport(P.id, [1]), /gått ut/, 'en förhandsvisning används bara en gång');
});

test('import: Jellyfin – användare, ProviderIds, sökväg och serietitel', async () => {
  const users = await imp.jellyfinUsers({ url: FB + '/jf', apiKey: 'jfkey' });
  assert.deepEqual(users.map(u => u.name), ['Anna', '<script>']);
  await assert.rejects(imp.preview({ source: 'jellyfin', url: FB + '/jf', apiKey: 'jfkey', user: '' }), (e) => e.users?.length === 2);
  await assert.rejects(imp.preview({ source: 'jellyfin', url: FB + '/jf', apiKey: 'jfkey', user: 'Bertil' }), /finns inte/);
  const P = await imp.preview({ source: 'jellyfin', url: FB + '/jf', apiKey: 'jfkey', user: 'anna', pathMap: `/data/movies=${FILM}` });
  assert.equal(P.total, 3); assert.equal(P.matched, 3);
  assert.deepEqual(P.byMethod, { id: 1, path: 1, title: 1 }, 'serien har bara TVDB-id (ingen TMDB-nyckel) → titel');
  const r = imp.runImport(P.id, [2]);
  assert.equal(r.watched, 2); assert.equal(r.progress, 1);
  assert.equal(get('SELECT position FROM progress WHERE user_id=2 AND item_id=?', lokal).position, 3000);
  assert.equal(get('SELECT watched FROM progress WHERE user_id=2 AND item_id=?', ep[0]).watched, 1);
  // Nyare position här skrivs inte över utan "overwrite"
  run('UPDATE progress SET position=4000, updated=? WHERE user_id=2 AND item_id=?', Math.floor(Date.now() / 1000) + 10, lokal);
  const P2 = await imp.preview({ source: 'jellyfin', url: FB + '/jf', apiKey: 'jfkey', user: 'Anna', pathMap: `/data/movies=${FILM}` });
  imp.runImport(P2.id, [2]);
  assert.equal(get('SELECT position FROM progress WHERE user_id=2 AND item_id=?', lokal).position, 4000);
  const P3 = await imp.preview({ source: 'jellyfin', url: FB + '/jf', apiKey: 'jfkey', user: 'Anna', pathMap: `/data/movies=${FILM}` });
  imp.runImport(P3.id, [2], { overwrite: true });
  assert.equal(get('SELECT position FROM progress WHERE user_id=2 AND item_id=?', lokal).position, 3000);
});

test('import: oåtkomlig server ger tydligt fel inom tidsgränsen', async () => {
  await assert.rejects(imp.preview({ source: 'plex', url: 'http://127.0.0.1:1', token: 'x' }), /Kunde inte nå Plex/);
  await assert.rejects(imp.preview({ source: 'annat' }), /Välj Plex/);
});

// ---------- DLNA ----------
const browse = (id, flag = 'BrowseDirectChildren', extra = '') => dlna.soap('ContentDirectory', 'Browse',
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ObjectID>${id}</ObjectID><BrowseFlag>${flag}</BrowseFlag><Filter>*</Filter>${extra}<SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`, 'http://192.168.1.5:8420');
const result = (r) => dlna.unxml(/<Result>([\s\S]*)<\/Result>/.exec(r.body)[1]);
const num = (r, tag) => +new RegExp(`<${tag}>(\\d+)</${tag}>`).exec(r.body)[1];

test('dlna: SOAP-tolkning och XML-escaping', () => {
  assert.equal(dlna.soapArg('<a><u:ObjectID>S&amp;1</u:ObjectID></a>', 'ObjectID'), 'S&1');
  assert.equal(dlna.soapArg('<ObjectID/>', 'ObjectID'), '');
  assert.equal(dlna.soapArg('<x/>', 'ObjectID'), null);
  assert.equal(dlna.xml(`<a href="x">&'\u0001`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
  assert.equal(dlna.unxml(dlna.xml('Tom & "Jerry" <vuxen>')), 'Tom & "Jerry" <vuxen>');
});

test('dlna: Browse av bibliotek, serier → säsonger → avsnitt, metadata och åldersgräns', () => {
  let r = browse('0');
  assert.equal(r.status, 200);
  assert.equal(num(r, 'NumberReturned'), 2); assert.equal(num(r, 'TotalMatches'), 2);
  let d = result(r);
  assert.match(d, /^<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0\/DIDL-Lite\/"/);
  assert.match(d, /<container id="L1" parentID="0"[^>]*childCount="4"><dc:title>Filmer<\/dc:title>/);
  // Filmer: titlar escapas, länkar pekar på /dlna/media med filändelse, längd och upplösning
  d = result(browse('L1'));
  assert.ok(d.includes('<dc:title>Tom &amp; &quot;Jerry&quot; &lt;vuxen&gt;</dc:title>'));
  assert.ok(d.includes(`http://192.168.1.5:8420/dlna/media/${arrival}.mkv</res>`));
  assert.match(d, /protocolInfo="http-get:\*:video\/x-matroska:DLNA\.ORG_OP=01[^"]*" size="1000" duration="1:56:00\.000" resolution="1920x1080"/);
  // Sidindelning
  r = browse('L1', 'BrowseDirectChildren', '<StartingIndex>1</StartingIndex><RequestedCount>2</RequestedCount>');
  assert.equal(num(r, 'NumberReturned'), 2); assert.equal(num(r, 'TotalMatches'), 4);
  // Serie → säsong → avsnitt
  d = result(browse('L2'));
  assert.match(d, new RegExp(`<container id="S${bron}" parentID="L2"[^>]*childCount="1">`));
  d = result(browse(`S${bron}`));
  assert.match(d, new RegExp(`<container id="E${bron}_1" parentID="S${bron}"[^>]*childCount="3"><dc:title>Säsong 1</dc:title>`));
  d = result(browse(`E${bron}_1`));
  assert.equal((d.match(/<item /g) || []).length, 3);
  assert.match(d, /<dc:title>1\. Avsnitt 1<\/dc:title><upnp:class>object\.item\.videoItem<\/upnp:class>/);
  // Metadata för ett avsnitt pekar på rätt förälder
  d = result(browse(`I${ep[1]}`, 'BrowseMetadata'));
  assert.match(d, new RegExp(`<item id="I${ep[1]}" parentID="E${bron}_1"`));
  // Okänt objekt / ogiltig flagga / okänd åtgärd → UPnP-fel
  r = browse('I999999', 'BrowseMetadata'); assert.equal(r.status, 500); assert.match(r.body, /<errorCode>701<\/errorCode>/);
  assert.match(browse('0', 'Fel').body, /<errorCode>402<\/errorCode>/);
  assert.match(dlna.soap('ContentDirectory', 'X_GetFeatureList', '', '').body, /<errorCode>401<\/errorCode>/);
  assert.match(dlna.soap('ContentDirectory', 'GetSystemUpdateID', '', '').body, /<Id>\d+<\/Id>/);
  assert.match(dlna.soap('ConnectionManager', 'GetProtocolInfo', '', '').body, /http-get:\*:video\/mp4:\*/);
  // Åldersgräns: 15 → vuxenfilmen och titlar utan åldersgräns försvinner, serien (15) syns; 11 → även serien och dess avsnitt försvinner
  setSetting('dlna_max_age', '15');
  d = result(browse('L1'));
  assert.ok(!d.includes('vuxen')); assert.equal(num(browse('L1'), 'TotalMatches'), 1);
  setSetting('allow_unrated', '1');
  assert.equal(num(browse('L1'), 'TotalMatches'), 3, 'okänd ålder visas när det är tillåtet');
  assert.equal(num(browse('L2'), 'TotalMatches'), 1);
  assert.equal(browse(`I${vuxen}`, 'BrowseMetadata').status, 500);
  setSetting('dlna_max_age', '11');
  assert.equal(num(browse('L2'), 'TotalMatches'), 0);
  assert.equal(browse(`E${bron}_1`).status, 500);
  assert.equal(browse(`I${ep[0]}`, 'BrowseMetadata').status, 500);
  setSetting('dlna_max_age', '');
  assert.equal(dlna.maxAge(), null, 'standard: som huvudkontot (ingen gräns)');
});

test('dlna: enhetsbeskrivning, tjänstebeskrivningar och SSDP-meddelanden', () => {
  setSetting('dlna_name', 'Vardagsrum <TV> & co');
  const desc = dlna.description();
  assert.match(desc, /<friendlyName>Vardagsrum &lt;TV&gt; &amp; co<\/friendlyName>/);
  assert.match(desc, /<UDN>uuid:[0-9a-f-]{36}<\/UDN>/);
  assert.match(desc, /<controlURL>\/dlna\/control\/ContentDirectory<\/controlURL>/);
  assert.match(dlna.SCPD.ContentDirectory(), /<name>Browse<\/name>/);
  assert.match(dlna.SCPD.ConnectionManager(), /<name>GetProtocolInfo<\/name>/);
  const m = dlna.parseSsdp('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaServer:1\r\n\r\n');
  assert.equal(m.headers.st, 'urn:schemas-upnp-org:device:MediaServer:1');
  assert.deepEqual(dlna.matchSearch(m.headers.st), ['urn:schemas-upnp-org:device:MediaServer:1']);
  assert.equal(dlna.matchSearch('ssdp:all').length, 5);
  assert.deepEqual(dlna.matchSearch('urn:schemas-upnp-org:device:MediaRenderer:1'), []);
  const resp = dlna.searchResponse('upnp:rootdevice', '192.168.1.5');
  assert.match(resp, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(resp, /LOCATION: http:\/\/192\.168\.1\.5:\d+\/dlna\/description\.xml\r\n/);
  assert.match(resp, /USN: uuid:[0-9a-f-]{36}::upnp:rootdevice\r\n/);
  assert.ok(resp.endsWith('\r\n\r\n'));
});

// ---------- HTTP: skydd mot obehöriga ----------
const PORT = 19000 + Math.floor(Math.random() * 900);
const B = `http://127.0.0.1:${PORT}`;
test('http: /metrics kräver token, DLNA och driftsidan bara från hemnätet', async () => {
  const cfg = path.join(ROOT, 'srv');
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(PORT + 1), CONFIG_DIR: cfg, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(cfg, 'tc'),
      DVR_DIR: path.join(cfg, 'rec'), PODCAST_DIR: path.join(cfg, 'pod'), DLNA_SSDP: '0', METRICS_TOKEN: '' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
    let cookie = '';
    const req = async (p, { method = 'GET', body, headers = {} } = {}) => {
      const h = { ...headers, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
      const r = await fetch(B + p, { method, headers: h, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc)) cookie = sc.split(';')[0];
      const t = await r.text();
      return { status: r.status, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })(), headers: r.headers };
    };
    assert.equal((await req('/metrics')).status, 404, 'avstängt utan token');
    assert.equal((await req('/dlna/description.xml')).status, 404, 'DLNA avstängt som standard');
    assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: 'Testlösen-2026!' } })).status, 200);
    // Driftsidan och importen är admin-routes: nekas utifrån
    const ext = { 'x-forwarded-for': '81.2.3.4' };
    assert.equal((await req('/api/ops', { headers: ext })).status, 403);
    assert.equal((await req('/api/import/preview', { method: 'POST', body: { source: 'plex' }, headers: ext })).status, 403);
    const O = await req('/api/ops');
    assert.equal(O.status, 200); assert.equal(O.json.metrics.enabled, false); assert.equal(O.json.dlna.enabled, false);
    // Prometheus
    const tok = (await req('/api/ops', { method: 'PUT', body: { metricsToken: 'new' } })).json.token;
    assert.ok(tok && tok.length > 20);
    let m = await req('/metrics');
    assert.equal(m.status, 401); assert.match(m.headers.get('www-authenticate'), /Bearer/);
    assert.equal((await req('/metrics', { headers: { authorization: 'Bearer fel-token-123' } })).status, 401);
    m = await req('/metrics', { headers: { authorization: 'Bearer ' + tok } });
    assert.equal(m.status, 200); assert.match(m.headers.get('content-type'), /text\/plain; version=0\.0\.4/);
    assert.match(m.text, /braxhn_users 1/);
    // DLNA: på från hemnätet, nekas utifrån och via omvänd proxy
    assert.equal((await req('/api/ops', { method: 'PUT', body: { dlnaEnabled: true, dlnaMaxAge: 'abc' } })).status, 400);
    assert.equal((await req('/api/ops', { method: 'PUT', body: { dlnaEnabled: true } })).status, 200);
    const d = await req('/dlna/description.xml');
    assert.equal(d.status, 200); assert.match(d.text, /MediaServer:1/);
    assert.equal((await req('/dlna/description.xml', { headers: ext })).status, 403);
    assert.equal((await req('/dlna/description.xml', { headers: { 'x-forwarded-for': '192.168.1.20' } })).status, 403, 'aldrig via proxy');
    const soapBody = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ObjectID>0</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag></u:Browse></s:Body></s:Envelope>';
    const sa = { soapaction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"', 'content-type': 'text/xml' };
    const b = await req('/dlna/control/ContentDirectory', { method: 'POST', body: soapBody, headers: sa });
    assert.equal(b.status, 200); assert.match(b.text, /<NumberReturned>0<\/NumberReturned>/);
    assert.equal((await req('/dlna/control/ContentDirectory', { method: 'POST', body: soapBody, headers: { ...sa, ...ext } })).status, 403);
    assert.equal((await req('/dlna/media/1.mkv', { headers: ext })).status, 403);
    assert.equal((await req('/dlna/media/1.mkv')).status, 404);
    const sub = await fetch(B + '/dlna/event/ContentDirectory', { method: 'SUBSCRIBE', headers: { callback: '<http://192.168.1.9/>', nt: 'upnp:event' } });
    assert.equal(sub.status, 200); assert.match(sub.headers.get('sid'), /^uuid:/);
    // Säkerhetskontrollen nämner DLNA och diskutrymmet finns i statistiken
    const sc = await req('/api/security-check');
    assert.ok(sc.json.some(i => /DLNA/.test(i.title)));
    assert.ok('disk' in (await req('/api/stats')).json);
  } finally { srv.kill(); await new Promise(r => srv.once('exit', r)); }
});
