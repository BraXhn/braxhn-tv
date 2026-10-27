// Hälsokontroll av biblioteket (server/health.js, routes/health.js). Testfilerna görs med ffmpeg: en hel film, en
// avkortad (halva filen bortklippt), en med skräp mitt i, en där ljudet börjar 2 s efter bilden och en med felmärkta
// språk (ljudspåret "Svenska" märkt eng, ett omärkt ljudspår, en inbäddad svensk undertext märkt eng och en svensk
// .en.srt bredvid). En serie saknar S01E03 och har E02 två gånger. Radarr och Sonarr är en låtsasserver.
// Kontrolleras: fynden, inkrementell kontroll (oförändrade filer läses inte om), rättad språkmärkning som uppspelningen
// använder utan att filen ändras, ignorera, ny version via Radarr/Sonarr (sökning + spärr), behörighet. Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-health-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 28000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
process.env.CONFIG_DIR = path.join(ROOT, 'unitconfig');
process.env.TRANSCODE_DIR = path.join(ROOT, 'unit-tc');
const H = await import('../server/health.js');
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
let srv, fake;
after(() => { srv?.kill(); fake?.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

// ---------------- rena funktioner ----------------
const SV = 'Jag vet inte vad du menar. Det är inte så enkelt, men vi måste försöka. Hur mår du? Jag är trött och vill gå hem. Varför gör du så här mot mig? Det finns inget att göra nu. Tack för att du kom. Hon är här, och han kommer snart.';
const EN = 'I do not know what you mean. It is not that simple, but we have to try. How are you? I am tired and I want to go home. Why do you do this to me? There is nothing to do now. Thank you for coming. She is here and he is coming soon.';

test('språkgissning, titelns språk och ljudspårens märkning', () => {
  assert.equal(H.guessLang(SV + ' ' + SV).lang, 'swe'); assert.ok(H.guessLang(SV + ' ' + SV).sure);
  assert.equal(H.guessLang(EN + ' ' + EN).lang, 'eng'); assert.ok(H.guessLang(EN + ' ' + EN).sure);
  assert.equal(H.guessLang('Hej då').sure, false, 'för lite text');
  assert.equal(H.langFromTitle('Svenska 5.1'), 'swe'); assert.equal(H.langFromTitle('English (Commentary)'), 'eng'); assert.equal(H.langFromTitle('Stereo'), null);
  const a = H.audioLangIssues([{ type: 'video', index: 0 }, { type: 'audio', index: 1, lang: 'eng', title: 'Svenska' }, { type: 'audio', index: 2, lang: 'und' }, { type: 'audio', index: 3, lang: 'en', title: 'English' }]);
  assert.deepEqual(a.map(x => [x.key, x.detail.suggest]), [['a1', 'swe'], ['a2', null]]);
  assert.deepEqual(H.audioLangIssues([{ type: 'audio', index: 1, lang: null }]), [], 'ett enda omärkt spår är normalt');
  assert.equal(H.bitrateIssue({ kbps: 30000, width: 1920, height: 1080 }, 40), null);
  assert.equal(H.bitrateIssue({ kbps: 60000, width: 1920, height: 1080 }, 40).kind, 'bitrate');
  assert.equal(H.bitrateIssue({ kbps: 60000, width: 3840, height: 2160 }, 40), null, '4K får 2,5 gånger mer');
});

test('hela biblioteket: låg kvalitet, dubbletter och saknade avsnitt', () => {
  const m = (id, h, extra = {}) => ({ id, kind: 'movie', library_id: 1, width: Math.round(h * 16 / 9), height: h, size: id, path: `/f/${id}.mkv`, ...extra });
  const rows = [m(1, 1080), m(2, 1080), m(3, 2160), m(4, 1080), m(5, 576), m(6, 480), m(7, 1080, { version_of: 6 }),
    m(8, 1080, { tmdb_id: 99 }), m(9, 1080, { tmdb_id: 99, size: 1 })];
  // 6 har en 1080p-version → inte låg kvalitet; 5 är SD i ett bibliotek där nästan allt är 1080p
  assert.deepEqual(H.qualityIssues(rows).map(x => x.item), [5]);
  assert.deepEqual(H.qualityIssues(rows.slice(4, 7)), [], 'för få filmer för att jämföra');
  // Samma TMDB-id två gånger: den mindre filen markeras
  assert.deepEqual(H.duplicateIssues(rows).map(x => x.item), [9]);
  const ep = (id, s, e, p = `Bron S0${s}E0${e}.mkv`) => ({ id, kind: 'episode', parent_id: 50, season: s, episode: e, path: '/s/' + p, height: 1080, width: 1920 });
  const eps = [ep(10, 1, 1), ep(11, 1, 2), ep(12, 1, 4), ep(13, 1, 5, 'Bron S01E05-E06.mkv'), ep(14, 1, 8), ep(15, 2, 1)];
  const miss = H.missingIssues(eps, () => [{ season: 2, episode: 2 }, { season: 3, episode: 1 }]);
  assert.deepEqual(miss.map(x => [x.key, x.detail.episodes]), [['S01', [3, 7]], ['S02', [2]]], 'E06 finns i multiavsnittet; säsong 3 finns inte alls');
  assert.equal(miss[0].detail.label, 'S01E03, S01E07');
  assert.deepEqual(H.missingIssues([...eps, { ...ep(16, 1, 9), ep_guess: 1 }]), [], 'datumavsnitt hoppas över');
  assert.deepEqual(H.duplicateIssues([ep(20, 1, 1), { ...ep(21, 1, 1), size: 5 }]).map(x => x.item), [20]);
});

// ---------------- låtsas-Radarr och -Sonarr ----------------
const calls = [];
function startFake() {
  return new Promise((ok) => {
    fake = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const json = (code, b) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      let body = ''; req.on('data', d => body += d); req.on('end', () => {
        const app = u.pathname.split('/')[1], p = u.pathname.slice(app.length + 1);
        if (req.headers['x-api-key'] !== app + 'nyckel') return json(401, { message: 'fel nyckel' });
        calls.push({ app, method: req.method, p, q: u.search, body: body ? JSON.parse(body) : null });
        if (app === 'radarr') {
          if (p === '/api/v3/movie') return json(200, u.searchParams.get('tmdbId') ? [] : [{ id: 7, title: 'Korrupt', path: '/movies/Korrupt (2003)', monitored: true, tmdbId: 0 }]);
          if (p === '/api/v3/history/movie') return json(200, [{ id: 56, eventType: 'downloadFolderImported', date: '2026-01-02' }, { id: 55, eventType: 'grabbed', date: '2026-01-01' }]);
        } else {
          if (p === '/api/v3/series') return json(200, [{ id: 3, title: 'Bron', path: '/tv/Bron', tvdbId: 1 }]);
          if (p === '/api/v3/episode') return json(200, [{ id: 31, seasonNumber: 1, episodeNumber: 1, hasFile: true, monitored: true },
            { id: 32, seasonNumber: 1, episodeNumber: 2, hasFile: true, monitored: true }, { id: 33, seasonNumber: 1, episodeNumber: 3, hasFile: false, monitored: false }]);
          if (p === '/api/v3/history/series') return json(200, [{ id: 90, episodeId: 32, eventType: 'grabbed', date: '2026-01-01' }]);
        }
        json(200, {});
      });
    }).listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${fake.address().port}`));
  });
}

// ---------------- mot en riktig server ----------------
let admin = '', FAKE = '';
const S = {};
async function req(p, { method = 'GET', body, tok = admin } = {}) {
  const h = {};
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (name, password) => (await req('/api/login', { method: 'POST', body: { name, password, app: true }, tok: '' })).data.token;
async function until(fn, what, n = 240) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await sleep(500); }
  assert.fail('väntade förgäves: ' + what);
}
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const video = (file, dur = 20, extra = []) => ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', String(dur),
  ...extra, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '20', '-c:a', 'aac', file);
const srtTime = (x) => `00:00:${String(Math.floor(x)).padStart(2, '0')},000`;
const srt = (text) => text.match(/[^.?!]+[.?!]/g).map((l, i) => `${i + 1}\n${srtTime(i)} --> ${srtTime(i + 0.9)}\n${l.trim()}\n`).join('\n');
const film = (name) => path.join(MEDIA, 'Filmer', name, name + '.mkv');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const dbq = (sql, ...p) => { const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'), { readOnly: true }); try { return db.prepare(sql).all(...p); } finally { db.close(); } };
const health = async () => (await req('/api/admin/health')).data;
async function runHealth(full = false) {
  assert.equal((await req('/api/admin/health/run', { method: 'POST', body: { full } })).status, 200);
  await sleep(600);
  return until(async () => { const d = await health(); return !d.status.running && d; }, 'hälsokontrollen blev klar');
}
const issuesOf = (d, id) => d.issues.filter(i => i.item === id).map(i => i.kind + (i.key ? ':' + i.key : '')).sort();

before(async () => {
  if (!hasFfmpeg) return;
  FAKE = await startFake();
  for (const n of ['Hel (2001)', 'Avkortad (2002)', 'Korrupt (2003)', 'Synk (2004)', 'Felmärkt (2005)']) fs.mkdirSync(path.join(MEDIA, 'Filmer', n), { recursive: true });
  video(film('Hel (2001)'));
  video(film('Avkortad (2002)'));
  fs.truncateSync(film('Avkortad (2002)'), Math.floor(fs.statSync(film('Avkortad (2002)')).size / 2));
  const ok = path.join(ROOT, 'ok.mkv'); video(ok);
  const b = fs.readFileSync(ok);
  let x = 12345; // skräp mitt i filen (deterministiskt)
  for (let i = Math.floor(b.length * 0.5); i < Math.floor(b.length * 0.58); i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x & 255; }
  fs.writeFileSync(film('Korrupt (2003)'), b);
  ff('-i', ok, '-itsoffset', '2', '-i', ok, '-map', '0:v', '-map', '1:a', '-c', 'copy', film('Synk (2004)'));
  const svs = path.join(ROOT, 'sv.srt'); fs.writeFileSync(svs, srt(SV + ' ' + SV));
  ff('-i', ok, '-f', 'lavfi', '-t', '20', '-i', 'sine=frequency=500', '-i', svs, '-map', '0:v', '-map', '0:a', '-map', '1:a', '-map', '2', '-c:v', 'copy', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=Svenska', '-metadata:s:a:1', 'language=und', '-metadata:s:s:0', 'language=eng', film('Felmärkt (2005)'));
  fs.writeFileSync(path.join(MEDIA, 'Filmer', 'Felmärkt (2005)', 'Felmärkt (2005).en.srt'), srt(SV + ' ' + SV));
  const season = path.join(MEDIA, 'Serier', 'Bron', 'Season 01');
  fs.mkdirSync(season, { recursive: true });
  for (const e of ['01', '02', '04']) video(path.join(season, `Bron S01E${e}.mkv`), 4);
  video(path.join(season, 'Bron - S01E02 - kopia.mkv'), 3);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1),
      TMDB_API_KEY: '', WATCH_FILES: '0', HEALTH_START_DELAY: '600000', SUBINDEX: '0' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});

t('fynden: avkortad, korrupt, ur synk, felmärkta språk, saknat avsnitt och dubblett', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin', PW);
  S.F = (await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).data.id;
  S.T = (await req('/api/libraries', { method: 'POST', body: { name: 'Serier', type: 'show', path: path.join(MEDIA, 'Serier') } })).data.id;
  const movies = await until(async () => { const l = (await req(`/api/libraries/${S.F}/items`)).data.items; return l?.length === 5 && l; }, 'filmerna skannades');
  for (const m of movies) S[m.title] = m.id;
  S.show = await until(async () => (await req(`/api/libraries/${S.T}/items`)).data.items?.[0]?.id, 'serien skannades');
  await until(async () => dbq("SELECT COUNT(*) AS n FROM items WHERE kind='episode'")[0].n === 4, 'avsnitten skannades');
  const d = await runHealth();
  assert.equal(d.status.files, 9, 'fem filmer och fyra avsnitt kontrollerades');
  assert.deepEqual(issuesOf(d, S.Hel), [], JSON.stringify(d.issues.filter(i => i.item === S.Hel)));
  assert.ok(issuesOf(d, S.Avkortad).includes('truncated'), JSON.stringify(issuesOf(d, S.Avkortad)));
  const tr = d.issues.find(i => i.item === S.Avkortad && i.kind === 'truncated');
  assert.ok(tr.detail.end < 12 && tr.detail.duration > 19, JSON.stringify(tr.detail));
  assert.equal(tr.severity, 'error');
  assert.ok(issuesOf(d, S.Korrupt).includes('decode'), JSON.stringify(issuesOf(d, S.Korrupt)));
  assert.deepEqual(issuesOf(d, S.Synk), ['sync']);
  assert.ok(Math.abs(d.issues.find(i => i.item === S.Synk).detail.diff - 2) < 0.2);
  assert.deepEqual(issuesOf(d, S['Felmärkt']), ['audiolang:a1', 'audiolang:a2', 'sublang:e3', 'sublang:external:Felmärkt (2005).en.srt']);
  const fel = d.issues.filter(i => i.item === S['Felmärkt']);
  assert.equal(fel.find(i => i.key === 'a1').detail.suggest, 'swe');
  assert.equal(fel.find(i => i.key === 'e3').detail.suggest, 'swe');
  assert.equal(fel.find(i => i.key === 'e3').detail.current, 'eng');
  assert.deepEqual(fel.find(i => i.key === 'a1').actions, ['lang', 'ignore']);
  const miss = d.issues.find(i => i.kind === 'missing');
  assert.equal(miss.item, S.show); assert.deepEqual(miss.detail.episodes, [3]); assert.equal(miss.detail.label, 'S01E03');
  const dup = d.issues.filter(i => i.kind === 'duplicate');
  assert.equal(dup.length, 1); assert.equal(dup[0].file, 'Bron - S01E02 - kopia.mkv', 'den mindre filen markeras');
  // Inga andra fynd för avsnitten
  assert.equal(d.issues.filter(i => i.itemKind === 'episode' && i.kind !== 'duplicate').length, 0, JSON.stringify(d.issues.filter(i => i.itemKind === 'episode')));
  assert.ok(!(await req('/api/jobs')).data.jobs.some(j => j.kind === 'health'));
});

t('inkrementellt: oförändrade filer läses inte om, en ändrad undertext kontrolleras för sig', async () => {
  const before = Object.fromEntries(dbq('SELECT item_id, checked, sig FROM health_files').map(r => [r.item_id, r]));
  await sleep(1100); // checked är i sekunder
  let d = await runHealth();
  assert.deepEqual(Object.fromEntries(dbq('SELECT item_id, checked, sig FROM health_files').map(r => [r.item_id, r])), before, 'inget kontrollerades om');
  // Undertextfilen blir engelsk → fyndet försvinner, bara den titeln kontrolleras (undertexterna)
  const ext = path.join(MEDIA, 'Filmer', 'Felmärkt (2005)', 'Felmärkt (2005).en.srt');
  fs.writeFileSync(ext, srt(EN + ' ' + EN)); fs.utimesSync(ext, new Date(), new Date(Date.now() + 5000));
  d = await runHealth();
  assert.ok(!issuesOf(d, S['Felmärkt']).includes('sublang:external:Felmärkt (2005).en.srt'));
  assert.ok(issuesOf(d, S['Felmärkt']).includes('sublang:e3'));
  const after = Object.fromEntries(dbq('SELECT item_id, checked, sig FROM health_files').map(r => [r.item_id, r]));
  for (const [id, r] of Object.entries(after)) if (+id !== S['Felmärkt']) assert.deepEqual(r, before[id]);
  assert.notEqual(after[S['Felmärkt']].checked, before[S['Felmärkt']].checked);
});

t('rätta språkmärkning: uppspelningen använder den, filen ändras inte', async () => {
  const id = S['Felmärkt'], file = film('Felmärkt (2005)'), hash = sha(file), mtime = fs.statSync(file).mtimeMs;
  const pb = async () => (await req(`/api/items/${id}/playback?info=1`)).data;
  let p = await pb();
  assert.equal(p.audio.find(a => a.index === 1).lang, 'eng');
  assert.equal(p.subtitles.find(s => s.id === 'e3').lang, 'eng');
  assert.equal((await req('/api/admin/health/lang', { method: 'PUT', body: { item: id, track: 'a1', lang: 'swe' } })).status, 200);
  assert.equal((await req('/api/admin/health/lang', { method: 'PUT', body: { item: id, track: 'e3', lang: 'swe' } })).status, 200);
  p = await pb();
  assert.equal(p.audio.find(a => a.index === 1).lang, 'swe');
  assert.equal(p.subtitles.find(s => s.id === 'e3').lang, 'swe');
  const d = await health();
  assert.deepEqual(issuesOf(d, id), ['audiolang:a2'], 'de rättade spåren är åtgärdade');
  assert.deepEqual(d.overrides.map(o => [o.track, o.lang, o.orig]).sort(), [['a1', 'swe', 'eng'], ['e3', 'swe', 'eng']]);
  // En ny genomgång tar inte tillbaka fynden
  assert.deepEqual(issuesOf(await runHealth(true), id), ['audiolang:a2']);
  assert.equal(sha(file), hash); assert.equal(fs.statSync(file).mtimeMs, mtime);
  // Felaktiga värden
  for (const body of [{ item: id, track: '../x', lang: 'swe' }, { item: id, track: 'a9', lang: 'swe' }, { item: id, track: 'a1', lang: 'svenska' }, { item: id, track: 'external:finns-inte.srt', lang: 'swe' }])
    assert.equal((await req('/api/admin/health/lang', { method: 'PUT', body })).status, 400, JSON.stringify(body));
  assert.equal((await req('/api/admin/health/lang', { method: 'PUT', body: { item: 999999, track: 'a1', lang: 'swe' } })).status, 404);
  // Ta bort rättelsen → filens märkning gäller igen
  assert.equal((await req('/api/admin/health/lang', { method: 'PUT', body: { item: id, track: 'e3', lang: '' } })).status, 200);
  assert.equal((await pb()).subtitles.find(s => s.id === 'e3').lang, 'eng');
});

t('ignorera: gäller tills fyndet ändras', async () => {
  const sync = (await health()).issues.find(i => i.item === S.Synk);
  assert.equal((await req(`/api/admin/health/issues/${sync.id}/ignore`, { method: 'POST', body: { ignored: true } })).status, 200);
  assert.equal((await runHealth(true)).issues.find(i => i.item === S.Synk).ignored, true, 'kvar efter ny kontroll av samma fil');
  assert.equal((await req(`/api/admin/health/issues/${sync.id}/ignore`, { method: 'POST', body: { ignored: false } })).status, 200);
  assert.equal((await health()).issues.find(i => i.item === S.Synk).ignored, false);
});

t('ny version via Radarr och Sonarr: sökning, spärr av releasen och saknade avsnitt', async () => {
  const d = await health();
  const dec = d.issues.find(i => i.item === S.Korrupt && i.kind === 'decode');
  assert.equal((await req(`/api/admin/health/issues/${dec.id}/replace`, { method: 'POST', body: { blocklist: true } })).status, 409, 'Radarr är inte kopplat');
  assert.equal((await req('/api/integrations', { method: 'PUT', body: { radarrUrl: FAKE + '/radarr', radarrKey: 'radarrnyckel', sonarrUrl: FAKE + '/sonarr', sonarrKey: 'sonarrnyckel',
    pathMap: `/movies=${path.join(MEDIA, 'Filmer')},/tv=${path.join(MEDIA, 'Serier')}` } })).status, 200);
  let r = await req(`/api/admin/health/issues/${dec.id}/replace`, { method: 'POST', body: { blocklist: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data, { searched: 1, blocked: 1 });
  assert.ok(calls.some(c => c.app === 'radarr' && c.method === 'POST' && c.p === '/api/v3/history/failed/55'), 'den hämtade releasen spärrades');
  assert.deepEqual(calls.find(c => c.app === 'radarr' && c.p === '/api/v3/command').body, { name: 'MoviesSearch', movieIds: [7] });
  assert.equal((await health()).issues.find(i => i.id === dec.id).action, 'blocklist');
  assert.equal((await req(`/api/admin/health/issues/${dec.id}/replace`, { method: 'POST', body: {} })).status, 429, 'inte samma sökning igen direkt');
  // Avsnitt (dubbletten): utan spärr
  const dup = d.issues.find(i => i.kind === 'duplicate');
  r = await req(`/api/admin/health/issues/${dup.id}/replace`, { method: 'POST', body: { blocklist: false } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data, { searched: 1, blocked: 0 });
  assert.ok(!calls.some(c => c.app === 'sonarr' && c.p.startsWith('/api/v3/history/failed')));
  assert.deepEqual(calls.filter(c => c.app === 'sonarr' && c.p === '/api/v3/command').pop().body, { name: 'EpisodeSearch', episodeIds: [32] });
  // Saknade avsnitt: Sonarr bevakar och söker E03
  const miss = d.issues.find(i => i.kind === 'missing');
  r = await req(`/api/admin/health/issues/${miss.id}/replace`, { method: 'POST', body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.searched, 1);
  assert.deepEqual(calls.find(c => c.app === 'sonarr' && c.p === '/api/v3/episode/monitor').body, { episodeIds: [33], monitored: true });
  assert.deepEqual(calls.filter(c => c.app === 'sonarr' && c.p === '/api/v3/command').pop().body, { name: 'EpisodeSearch', episodeIds: [33] });
  // Språkfynd går inte att skicka till Radarr
  const lang = d.issues.find(i => i.kind === 'audiolang');
  assert.equal((await req(`/api/admin/health/issues/${lang.id}/replace`, { method: 'POST', body: {} })).status, 400);
  // Nyckeln syns aldrig i svaret
  assert.ok(!JSON.stringify(await health()).includes('nyckel'));
});

t('behörighet: bara administratören', async () => {
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW } })).status, 200);
  const bo = await login('bo', PW);
  assert.equal((await req('/api/admin/health', { tok: bo })).status, 403);
  assert.equal((await req('/api/admin/health/lang', { method: 'PUT', body: { item: S.Hel, track: 'a1', lang: 'swe' }, tok: bo })).status, 403);
  assert.equal((await req('/api/admin/health', { tok: '' })).status, 401);
});
