// Kalender för kommande avsnitt, saknade avsnitt och iCal-prenumerationen – mot en låtsas-TMDB och ett låtsas-Sonarr.
// Körs i samma process (servern startas på en slumpad port); kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// ---------- låtsas-TMDB och låtsas-Sonarr ----------
const ymd = (d) => d.toLocaleDateString('sv-SE');
const rel = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const calls = [];
const sonarrCmds = [];
const TV = {
  100: { name: 'Bamse', status: 'Returning Series', networks: [{ name: 'SVT Barn' }],
    seasons: { 1: [-60, -59, -58, -57, -56, -55].map((d, i) => ({ episode_number: i + 1, name: `Del ${i + 1}`, air_date: rel(d) })),
      2: [{ episode_number: 1, name: 'Hemma, igen; äntligen', air_date: rel(-3) }, { episode_number: 2, name: 'Bamse och tjuvarna', air_date: rel(2) }, { episode_number: 3, name: 'Tre', air_date: rel(9) }] } },
  200: { name: 'Vuxenserie', status: 'Returning Series', networks: [{ name: 'HBO' }],
    seasons: { 1: [{ episode_number: 1, name: 'Pilot', air_date: rel(-1) }, { episode_number: 2, name: 'Andra', air_date: rel(1) }] } },
};
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  calls.push(u.pathname);
  const json = (code, b) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  // Sonarr
  if (u.pathname.startsWith('/sonarr/')) {
    if (req.headers['x-api-key'] !== 'sonarrnyckel') return json(401, { message: 'fel nyckel' });
    const p = u.pathname.slice(7);
    if (p === '/api/v3/calendar') return json(200, [
      { seriesId: 7, seasonNumber: 2, episodeNumber: 2, title: 'Bamse och tjuvarna', airDate: rel(2), airDateUtc: `${rel(2)}T16:00:00Z`, hasFile: false, series: { title: 'Bamse', tmdbId: 100, network: 'SVT', runtime: 25 } },
      { seriesId: 9, seasonNumber: 1, episodeNumber: 1, title: 'Början', airDate: rel(1), airDateUtc: `${rel(1)}T20:00:00Z`, hasFile: false, series: { title: 'Okänd serie', tmdbId: 999, network: 'Netflix', runtime: 50 } },
    ]);
    if (p === '/api/v3/series') return json(200, [{ id: 7, title: 'Bamse', tmdbId: 100, tvdbId: 9100 }]);
    if (p === '/api/v3/episode') return json(200, [
      ...[1, 2, 3, 4, 5, 6].map(n => ({ id: 1000 + n, seasonNumber: 1, episodeNumber: n, hasFile: n <= 3, monitored: n !== 5 })),
      { id: 2001, seasonNumber: 2, episodeNumber: 1, hasFile: false, monitored: true }]);
    if (p === '/api/v3/episode/monitor' || p === '/api/v3/command') {
      let b = ''; req.on('data', d => b += d); req.on('end', () => { sonarrCmds.push({ p, body: JSON.parse(b) }); json(200, {}); }); return;
    }
    return json(404, {});
  }
  // TMDB
  let m = /^\/3\/tv\/(\d+)$/.exec(u.pathname);
  if (m && TV[m[1]]) {
    const t = TV[m[1]], eps = Object.entries(t.seasons).flatMap(([s, l]) => l.map(e => ({ ...e, season_number: +s })));
    const aired = eps.filter(e => e.air_date <= rel(0)), coming = eps.filter(e => e.air_date > rel(0));
    return json(200, { id: +m[1], name: t.name, status: t.status, networks: t.networks,
      last_episode_to_air: aired[aired.length - 1] || null, next_episode_to_air: coming[0] || null,
      seasons: [{ season_number: 0, episode_count: 1 }, ...Object.entries(t.seasons).map(([s, l]) => ({ season_number: +s, episode_count: l.length }))] });
  }
  m = /^\/3\/tv\/(\d+)\/season\/(\d+)$/.exec(u.pathname);
  if (m && TV[m[1]]?.seasons[m[2]]) return json(200, { episodes: TV[m[1]].seasons[m[2]] });
  m = /^\/3\/tv\/(\d+)\/external_ids$/.exec(u.pathname);
  if (m) return json(200, { tvdb_id: 9000 + +m[1] });
  json(404, { status_message: 'saknas' });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-cal-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.TMDB_API_URL = FAKE + '/3';
process.env.CALENDAR_GAP_MS = '0';
process.env.CALENDAR_REFRESH = '0';
fs.mkdirSync(MEDIA, { recursive: true });
const D = await import('../server/db.js');
const sc = await import('../server/scanner.js');
const auth = await import('../server/auth.js');
const follows = await import('../server/follows.js');
const cal = await import('../server/calendar.js');
const app = await import('../server/app.js');

const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fake.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const touch = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };
const ADULT_U = Number(D.run("INSERT INTO users(name,pass,is_admin,created) VALUES('pappa','x',0,0)").lastInsertRowid);
const KID = Number(D.run("INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES('lisa','x',0,0,?,7)", ADULT_U).lastInsertRowid);
const tok = { [ADULT_U]: auth.createSession(ADULT_U, 'app'), [KID]: auth.createSession(KID, 'app') };
async function req(uid, p, { method = 'GET', body } = {}) {
  const h = uid ? { Authorization: `Bearer ${tok[uid]}` } : {};
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, ct, data: ct.includes('json') ? await r.json() : await r.text() };
}

const SHOWDIR = path.join(MEDIA, 'Serier');
for (const n of [1, 2, 3]) touch(path.join(SHOWDIR, 'Bamse', 'Season 1', `Bamse S01E0${n}.mkv`));
touch(path.join(SHOWDIR, 'Vuxenserie', 'Season 1', 'Vuxenserie S01E01.mkv'));
const LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('TV','show',?)", SHOWDIR).lastInsertRowid);
await sc.scan(LIB);
const SHOW = D.get("SELECT id FROM items WHERE kind='show' AND title='Bamse'").id;
const ADULT = D.get("SELECT id FROM items WHERE kind='show' AND title='Vuxenserie'").id;
D.run('UPDATE items SET age=0, tmdb_id=100 WHERE id=?', SHOW);
D.run('UPDATE items SET age=15, tmdb_id=200 WHERE id=?', ADULT);

test('utan TMDB-nyckel: inget hämtas och vyn får veta varför', async () => {
  assert.equal(await cal.refreshDue(), 0);
  const r = await req(ADULT_U, '/api/calendar');
  assert.equal(r.status, 200);
  assert.equal(r.data.tmdb, false);
  assert.deepEqual(r.data.items, []);
  const m = await req(ADULT_U, `/api/items/${SHOW}/missing`);
  assert.equal(m.data.known, false);
});

test('hämtning: serier och säsonger från TMDB sparas, och nästa dygn bara det som behövs', async () => {
  D.setSetting('tmdb_key', 'testnyckel');
  calls.length = 0;
  assert.equal(await cal.refreshDue(), 2);
  assert.ok(calls.includes('/3/tv/100') && calls.includes('/3/tv/100/season/1') && calls.includes('/3/tv/100/season/2'));
  assert.ok(!calls.includes('/3/tv/100/season/0'), 'specialavsnitt hämtas inte');
  const row = D.get('SELECT * FROM calendar_shows WHERE show_id=?', SHOW);
  assert.equal(row.status, 'Returning Series');
  assert.equal(row.network, 'SVT Barn');
  assert.equal(row.next_air, rel(2));
  assert.equal(D.get('SELECT COUNT(*) AS n FROM calendar_episodes WHERE show_id=?', SHOW).n, 9);
  // Direkt efteråt står ingen serie på tur
  assert.equal(cal.dueShows().length, 0);
  // Ett dygn senare: bara pågående säsong (2) hämtas om, inte den gamla
  D.run('UPDATE calendar_shows SET fetched=fetched-86400');
  calls.length = 0;
  await cal.refreshDue();
  assert.ok(calls.includes('/3/tv/100/season/2'));
  assert.ok(!calls.includes('/3/tv/100/season/1'), 'avslutad säsong hämtas inte varje dygn');
  // Avslutad serie som ingen följer: en gång i månaden
  D.run("UPDATE calendar_shows SET status='Ended', fetched=fetched-2*86400 WHERE show_id=?", ADULT);
  assert.ok(!cal.dueShows().some(s => s.id === ADULT));
  follows.follow(ADULT_U, ADULT);
  assert.ok(cal.dueShows().some(s => s.id === ADULT), 'följd serie hämtas varje dygn');
  follows.follow(ADULT_U, ADULT, false);
  D.run("UPDATE calendar_shows SET status='Returning Series' WHERE show_id=?", ADULT);
});

test('saknade avsnitt grupperas i intervall', async () => {
  assert.deepEqual(cal.ranges([{ season: 2, episode: 4 }, { season: 2, episode: 6 }, { season: 2, episode: 5 }, { season: 1, episode: 9 }, { season: 2, episode: 8 }]).map(r => r.label),
    ['S01E09', 'S02E04–E06', 'S02E08']);
  const m = await req(ADULT_U, `/api/items/${SHOW}/missing`);
  assert.equal(m.status, 200);
  assert.equal(m.data.known, true);
  assert.equal(m.data.label, 'S01E04–E06, S02E01', 'framtida avsnitt räknas inte som saknade');
  assert.equal(m.data.count, 4);
  // Ett avsnitt läggs till → intervallet delas
  touch(path.join(SHOWDIR, 'Bamse', 'Season 1', 'Bamse S01E05.mkv'));
  await sc.scan(LIB);
  assert.equal(cal.missing(SHOW).label, 'S01E04, S01E06, S02E01');
  // Barnprofilen når inte vuxenseriens sida
  assert.equal((await req(KID, `/api/items/${ADULT}/missing`)).status, 403);
  assert.equal((await req(KID, `/api/items/${SHOW}/missing`)).status, 200);
});

test('kalendern: per dag med status, filter för följda serier och Sonarrs tider', async () => {
  D.setSetting('sonarr_url', FAKE + '/sonarr');
  D.setSetting('sonarr_key', 'sonarrnyckel');
  cal.clearSonarr();
  follows.follow(ADULT_U, SHOW);
  const r = await req(ADULT_U, `/api/calendar?from=${rel(-5)}&to=${rel(14)}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.tmdb, true);
  assert.equal(r.data.sonarr, true);
  const find = (l, show, s, e) => l.find(x => x.show === show && x.season === s && x.episode === e);
  const s2e1 = find(r.data.items, 'Bamse', 2, 1), s2e2 = find(r.data.items, 'Bamse', 2, 2);
  assert.equal(s2e1.missing, true); assert.equal(s2e1.inLibrary, false); assert.equal(s2e1.following, true);
  assert.equal(s2e1.network, 'SVT Barn');
  assert.equal(s2e2.time, `${rel(2)}T16:00:00.000Z`, 'tiden kommer från Sonarr');
  assert.equal(s2e2.network, 'SVT');
  assert.equal(s2e2.missing, false);
  const v = find(r.data.items, 'Vuxenserie', 1, 1);
  assert.equal(v.inLibrary, true); assert.equal(typeof v.itemId, 'number');
  assert.ok(find(r.data.items, 'Okänd serie', 1, 1), 'serie som bara finns i Sonarr visas');
  // Sorterat på datum
  assert.deepEqual(r.data.items.map(x => x.date), [...r.data.items.map(x => x.date)].sort());
  // Bara följda
  const mine = await req(ADULT_U, `/api/calendar?from=${rel(-5)}&to=${rel(14)}&mine=1`);
  assert.ok(mine.data.items.length && mine.data.items.every(x => x.show === 'Bamse'));
  // Startsidan: Kommer snart (7 dagar)
  const h = await req(ADULT_U, '/api/home');
  assert.ok(Array.isArray(h.data.upcoming));
  assert.ok(h.data.upcoming.every(x => x.date >= rel(0) && x.date <= rel(6)));
  assert.ok(find(h.data.upcoming, 'Bamse', 2, 2));
  assert.ok(!find(h.data.upcoming, 'Bamse', 2, 3), 'om nio dagar är inte inom en vecka');
});

test('barnprofil: bara serier inom åldersgränsen', async () => {
  const r = await req(KID, `/api/calendar?from=${rel(-5)}&to=${rel(14)}`);
  assert.ok(r.data.items.length);
  assert.ok(r.data.items.every(x => x.show === 'Bamse'), 'varken vuxenserien eller serier utanför biblioteket');
  const h = await req(KID, '/api/home');
  assert.ok(h.data.upcoming.every(x => x.show === 'Bamse'));
});

test('Sök i Sonarr: söker efter de saknade avsnitten (och bevakar dem)', async () => {
  assert.equal((await req(KID, `/api/items/${SHOW}/missing`)).data.canSearch, false);
  assert.equal((await req(KID, `/api/items/${SHOW}/missing/search`, { method: 'POST' })).status, 403);
  assert.equal((await req(ADULT_U, `/api/items/${SHOW}/missing`)).data.canSearch, true);
  const r = await req(ADULT_U, `/api/items/${SHOW}/missing/search`, { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.searched, 3);
  const cmd = sonarrCmds.find(c => c.p === '/api/v3/command');
  assert.equal(cmd.body.name, 'EpisodeSearch');
  assert.deepEqual(cmd.body.episodeIds.sort(), [1004, 1006, 2001]);
  assert.deepEqual(sonarrCmds.find(c => c.p === '/api/v3/episode/monitor')?.body, undefined, 'E05 finns nu i biblioteket – inget att bevaka');
  assert.equal((await req(ADULT_U, `/api/items/${SHOW}/missing/search`, { method: 'POST' })).status, 429, 'en sökning per serie och tio minuter');
});

test('iCal: format enligt RFC 5545', async () => {
  const stamp = new Date('2026-10-24T08:09:10Z');
  const list = [
    { showId: 5, show: 'Serie, med; tecken\\', season: 1, episode: 2, name: 'Rad ett\nrad två', date: '2026-10-25', time: null, network: null, inLibrary: false, missing: false },
    { showId: 5, show: 'Åäö '.repeat(30), season: 1, episode: 3, name: null, date: '2026-12-31', time: '2026-12-31T20:00:00.000Z', runtime: 45, network: 'SVT', inLibrary: true },
  ];
  const ics = cal.ical(list, { stamp, host: 'tv.example' });
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'bara CRLF');
  const lines = ics.split('\r\n').slice(0, -1);
  for (const l of lines) assert.ok(Buffer.byteLength(l) <= 75, `rad över 75 oktetter: ${l}`);
  assert.ok(lines.some(l => l.startsWith(' ')), 'långa rader viks');
  // Utvikt (CRLF + mellanslag tas bort) blir originalet, och inga UTF-8-tecken delas
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(!unfolded.includes('�'));
  assert.ok(unfolded.includes('SUMMARY:Serie\\, med\\; tecken\\\\ S01E02 – Rad ett\\nrad två\r\n'));
  assert.ok(unfolded.includes('UID:braxhn-5-s1e2@tv.example\r\n'));
  assert.ok(unfolded.includes('DTSTAMP:20261024T080910Z\r\n'));
  assert.ok(unfolded.includes('DTSTART;VALUE=DATE:20261025\r\nDTEND;VALUE=DATE:20261026\r\n'), 'heldag när tid saknas');
  assert.ok(unfolded.includes('DTSTART:20261231T200000Z\r\nDTEND:20261231T204500Z\r\n'));
  assert.ok(unfolded.includes(`SUMMARY:${'Åäö '.repeat(30)} S01E03\r\n`));
  assert.equal(lines[0], 'BEGIN:VCALENDAR'); assert.equal(lines.at(-1), 'END:VCALENDAR');
  assert.equal(lines.filter(l => l === 'BEGIN:VEVENT').length, 2);
  assert.ok(lines.includes('VERSION:2.0') && lines.some(l => l.startsWith('PRODID:')));
});

test('iCal: personlig token med eget scope – fel, återkallad eller på fel ställe nekas', async () => {
  assert.equal((await req(ADULT_U, '/api/calendar/feed')).data.active, false);
  const c1 = await req(ADULT_U, '/api/calendar/feed', { method: 'POST' });
  assert.equal(c1.status, 200);
  assert.equal(c1.data.active, true);
  const t1 = new URL(c1.data.path, B).searchParams.get('t');
  assert.match(t1, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify((await req(ADULT_U, '/api/calendar/feed')).data).includes(t1), 'token visas bara när den skapas');
  assert.ok(!D.get('SELECT token FROM calendar_tokens WHERE user_id=?', ADULT_U).token.includes(t1), 'lagras hashad');
  const ok = await fetch(`${B}/api/calendar.ics?t=${t1}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /^text\/calendar/);
  const body = await ok.text();
  assert.ok(body.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(body.includes('Vuxenserie'));
  assert.ok(body.replace(/\r\n /g, '').includes(`DTSTART:${rel(2).replace(/-/g, '')}T160000Z`), 'tid från Sonarr');
  // Fel token, ingen token, sessionstoken i adressen eller som Bearer: nej
  assert.equal((await fetch(`${B}/api/calendar.ics?t=${'0'.repeat(64)}`)).status, 401);
  assert.equal((await fetch(`${B}/api/calendar.ics`)).status, 401);
  assert.equal((await fetch(`${B}/api/calendar.ics?t=${tok[ADULT_U]}`)).status, 401);
  assert.equal((await fetch(`${B}/api/calendar.ics`, { headers: { Authorization: `Bearer ${tok[ADULT_U]}` } })).status, 401);
  // Kalendertoken når inga andra API:er – varken i adressen, som Bearer eller som kaka
  for (const p of ['/api/home', '/api/calendar', '/api/calendar/feed', `/api/items/${SHOW}`, `/api/image/${SHOW}/poster`, `/api/stream/${SHOW}/download`, '/api/me/sessions']) {
    assert.equal((await fetch(`${B}${p}?t=${t1}`)).status, 401, `?t= på ${p}`);
    assert.equal((await fetch(`${B}${p}`, { headers: { Authorization: `Bearer ${t1}` } })).status, 401, `Bearer på ${p}`);
    assert.equal((await fetch(`${B}${p}`, { headers: { Cookie: `kt=${t1}` } })).status, 401, `kaka på ${p}`);
  }
  assert.equal((await fetch(`${B}/api/calendar/feed?t=${t1}`, { method: 'DELETE' })).status, 401, 'kan inte återkalla sig själv');
  // Ny token ersätter den gamla
  const c2 = await req(ADULT_U, '/api/calendar/feed', { method: 'POST' });
  const t2 = new URL(c2.data.path, B).searchParams.get('t');
  assert.equal((await fetch(`${B}/api/calendar.ics?t=${t1}`)).status, 401, 'gamla länken slutar fungera');
  assert.equal((await fetch(`${B}/api/calendar.ics?t=${t2}`)).status, 200);
  // Återkallad
  assert.equal((await req(ADULT_U, '/api/calendar/feed', { method: 'DELETE' })).data.active, false);
  assert.equal((await fetch(`${B}/api/calendar.ics?t=${t2}`)).status, 401);
  // Barnprofilens kalender: bara serier inom åldersgränsen
  const kt = new URL((await req(KID, '/api/calendar/feed', { method: 'POST' })).data.path, B).searchParams.get('t');
  const kb = await (await fetch(`${B}/api/calendar.ics?t=${kt}`)).text();
  assert.ok(kb.includes('Bamse') && !kb.includes('Vuxenserie') && !kb.includes('Okänd serie'));
});
