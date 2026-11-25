// Femte granskningen av servern (det som blev kvar efter den fjärde), mot servern i testprocessen:
// - GET /api/libraries visar serverns sökvägar bara för administratörer
// - originalfilen (/direct) skickas i några gånger filens bithastighet till profiler med skärmtid, så att skärmtiden
//   inte går att kringgå genom att hämta hela filen snabbt – profiler utan skärmtid och nedladdning påverkas inte
// - POST /api/media-token har ett tak för bildtoken per användare
// - kontospärrens nyckel (användarnamnet) är kortad
// - datum i inspelningars metadata och exporters filnamn är lokal tid (TZ), inte UTC
// Behöver inte ffmpeg (inget skannas).
process.env.TZ = 'Europe/Stockholm'; // som i Dockerfile – före all datumhantering
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-sec5-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.DLNA = '0';
process.env.TMDB_API_KEY = '';
fs.mkdirSync(path.join(MEDIA, 'filer'), { recursive: true });
const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const pace = await import('../server/pace.js').catch(() => null);
const util = await import('../server/util.js');
const dvr = await import('../server/dvr.js');

const home = http.createServer(app.handle);
await new Promise(r => home.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${home.address().port}`;
const PW = 'Testlösen-2026!';
const MB = 1048576;
let admin = '', bo = '', kid = '';
const S = {};

async function req(p, { method = 'GET', body, tok = admin, headers = {} } = {}) {
  const h = { ...headers };
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
const login = async (name) => (await req('/api/login', { method: 'POST', body: { name, password: PW, app: true }, tok: '' })).data.token;

before(async () => {
  const film = path.join(MEDIA, 'filer', 'Barnfilm (2020).mp4'), stor = path.join(MEDIA, 'filer', 'Lång barnfilm (2021).mp4');
  fs.writeFileSync(film, crypto.randomBytes(200000));
  fs.writeFileSync(stor, 'x'); fs.truncateSync(stor, 400 * MB); // gles fil: tar ingen plats på disken
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin');
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 7 } })).status, 200);
  S.kid = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  const T = Math.floor(Date.now() / 1000);
  S.F = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", path.join(MEDIA, 'hemlig-mapp-filmer')).lastInsertRowid);
  const item = (title, file) => Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,year,path,size,duration,container,age,added) VALUES(?,'movie',?,?,2020,?,?,600,'mp4',0,?)`,
    S.F, title, title.toLowerCase(), file, fs.statSync(file).size, T).lastInsertRowid);
  S.film = item('Barnfilm', film); S.stor = item('Lång barnfilm', stor);
  S.storItem = D.get('SELECT * FROM items WHERE id=?', S.stor);
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW, libraries: [S.F] } })).status, 200);
  bo = await login('bo');
  kid = (await req('/api/profiles/switch', { method: 'POST', body: { id: S.kid } })).data.token;
  assert.ok(bo && kid);
  admin = await login('admin'); // profilbytet tog bort administratörens token
  // Barnprofilen har skärmtid (gott om tid kvar), bo har ingen
  assert.equal((await req(`/api/screentime/${S.kid}`, { method: 'PUT', body: { daily: 600 } })).status, 200);
});
after(async () => {
  home.closeAllConnections?.(); home.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------- 1. bibliotekens sökvägar ----------
test('GET /api/libraries: sökvägarna (path, paths) bara för administratörer', async () => {
  const a = (await req('/api/libraries')).data.find(l => l.id === S.F);
  assert.ok(a.path?.includes('hemlig-mapp'), 'administratören ser mappen');
  assert.deepEqual(a.paths, [a.path]);
  for (const tok of [bo, kid]) {
    const r = await req('/api/libraries', { tok });
    assert.equal(r.status, 200);
    const l = r.data.find(x => x.id === S.F);
    assert.ok(l, 'biblioteket listas');
    assert.equal(l.name, 'Filmer'); assert.equal(l.type, 'movie'); assert.equal(typeof l.count, 'number', 'fälten apparna läser finns kvar');
    assert.ok(!JSON.stringify(r.data).includes('hemlig-mapp'), 'ingen sökväg i svaret: ' + JSON.stringify(r.data));
    assert.equal(l.path, undefined); assert.equal(l.paths, undefined);
  }
});

test('GET /api/libraries: andra än administratörer får bara fälten klienterna läser (vitlista)', async () => {
  // anime, nfo och kids är administratörens inställningar; home_video behövs i webbens bibliotekssida (home.js)
  D.run('UPDATE libraries SET anime=1, nfo=0, kids=1 WHERE id=?', S.F);
  try {
    const a = (await req('/api/libraries')).data.find(l => l.id === S.F);
    assert.equal(a.anime, 1); assert.equal(a.nfo, 0); assert.equal(a.kids, 1);
    for (const tok of [bo, kid]) {
      const l = (await req('/api/libraries', { tok })).data.find(x => x.id === S.F);
      assert.deepEqual(Object.keys(l).sort(), ['count', 'home_video', 'id', 'name', 'type']);
    }
  } finally { D.run('UPDATE libraries SET anime=0, nfo=1, kids=0 WHERE id=?', S.F); }
});

// ---------- 2. /direct i takt för profiler med skärmtid ----------
/** Läser /direct så fort det går i ms millisekunder (eller tills svaret är slut). Flera parallella med n > 1. */
function readFast(tok, ms, { range, id = S.stor } = {}) {
  return new Promise((ok, no) => {
    const t0 = Date.now();
    const headers = { authorization: 'Bearer ' + tok, ...(range ? { range } : {}) };
    const r = http.get(`${B}/api/stream/${id}/direct`, { headers }, (res) => {
      let n = 0, finished = false;
      res.on('data', (d) => { n += d.length; });
      res.on('end', () => { finished = true; ok({ status: res.statusCode, n, finished, ms: Date.now() - t0 }); });
      setTimeout(() => { if (!finished) { r.destroy(); ok({ status: res.statusCode, n, finished, ms: Date.now() - t0 }); } }, ms);
    });
    r.on('error', (e) => { if (!/aborted|socket hang up/.test(e.message)) no(e); });
  });
}

test('/direct: en profil med skärmtid kan inte hämta originalfilen snabbt – takten är några gånger bithastigheten', { timeout: 30000 }, async (t) => {
  const T = 2500;
  const got = await readFast(kid, T);
  assert.equal(got.status, 200);
  assert.equal(got.finished, false, `hela filen (400 MB) kom på ${got.ms} ms – ingen takt`);
  assert.ok(got.n < 200 * MB, `fick ${(got.n / MB).toFixed(1)} MB på 2,5 s (filen är 10 min, 400 MB)`);
  assert.ok(pace, 'server/pace.js finns');
  const { rate, burst } = pace.paceFor(S.storItem);
  const bitrate = 400 * MB / 600;
  assert.ok(rate >= 3 * bitrate && rate <= 8 * bitrate, `takten ${rate} B/s är några gånger bithastigheten ${bitrate} B/s`);
  const max = burst + rate * (got.ms / 1000) + 2 * MB;
  t.diagnostic(`barnprofilen: ${(got.n / MB).toFixed(1)} MB på ${got.ms} ms (start ${(burst / MB).toFixed(0)} MB, takt ${(rate / MB).toFixed(2)} MB/s)`);
  assert.ok(got.n <= max, `fick ${(got.n / MB).toFixed(1)} MB, högst ${(max / MB).toFixed(1)} MB`);
  // En spelare som läser i normal takt märker inget: starten kommer direkt och takten därefter är över bithastigheten
  assert.ok(got.n >= burst + 3 * bitrate * (got.ms / 1000 - 1), `fick ${(got.n / MB).toFixed(1)} MB – minst starten och tre gånger bithastigheten`);
});

test('/direct: parallella förfrågningar delar på takten (ingen väg runt med många Range-anrop)', { timeout: 30000 }, async () => {
  await new Promise(r => setTimeout(r, 200));
  const { rate, burst } = pace.paceFor(S.storItem);
  const T = 2000, parts = 4, size = 100 * MB;
  const all = await Promise.all(Array.from({ length: parts }, (_, i) => readFast(kid, T, { range: `bytes=${i * size}-${(i + 1) * size - 1}` })));
  for (const g of all) assert.equal(g.status, 206);
  const total = all.reduce((a, g) => a + g.n, 0);
  // Hinken var delvis tom efter förra testet; högst en full hink plus takten
  const max = burst + rate * (T / 1000) + parts * 2 * MB;
  assert.ok(total <= max, `fick ${(total / MB).toFixed(1)} MB med ${parts} parallella, högst ${(max / MB).toFixed(1)} MB`);
});

test('/direct: profiler utan skärmtid och nedladdning påverkas inte', { timeout: 30000 }, async (t) => {
  const { burst } = pace.paceFor(S.storItem);
  const want = Math.ceil((burst + 60 * MB) / MB) * MB;
  const got = await readFast(bo, 15000, { range: `bytes=0-${want - 1}` });
  assert.equal(got.status, 206);
  t.diagnostic(`utan skärmtid: ${(got.n / MB).toFixed(1)} MB på ${got.ms} ms`);
  assert.equal(got.finished, true, `bo fick ${(got.n / MB).toFixed(1)} MB på ${got.ms} ms`);
  assert.equal(got.n, want);
  // Nedladdning för offline (rättigheten styrs av administratören) går som förut, även för barnprofilen
  const dl = await req(`/api/stream/${S.film}/download`, { tok: kid });
  assert.equal(dl.status, 200); assert.equal(dl.data.length, 200000);
  // HEAD och små Range-anrop (spelarens start) svarar direkt
  const t0 = Date.now();
  const h = await fetch(`${B}/api/stream/${S.stor}/direct`, { method: 'HEAD', headers: { authorization: 'Bearer ' + kid } });
  assert.equal(h.status, 200); assert.equal(h.headers.get('content-length'), String(400 * MB));
  const tail = await req(`/api/stream/${S.film}/direct`, { tok: kid, headers: { range: 'bytes=0-65535' } });
  assert.equal(tail.status, 206); assert.equal(tail.data.length, 65536);
  assert.ok(Date.now() - t0 < 2000);
});

// ---------- 3. bildtoken ----------
test('POST /api/media-token: högst ett tak av bildtoken per användare, den nyaste fungerar', async () => {
  const toks = [];
  for (let i = 0; i < 70; i++) {
    const r = await req('/api/media-token', { method: 'POST', tok: bo });
    assert.equal(r.status, 200); assert.equal(r.data.ttl, 7 * 86400);
    toks.push(r.data.token);
  }
  const uid = D.get("SELECT id FROM users WHERE name='bo'").id;
  const n = D.get("SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND kind='img'", uid).n;
  assert.ok(n <= auth.IMG_MAX, `${n} bildtoken sparade för samma användare (tak ${auth.IMG_MAX})`);
  assert.ok(auth.IMG_MAX >= 30, 'taket räcker för flera enheter som förnyar en gång per dygn (7 dygn var)');
  // Den nyaste fungerar för bilder (ingen affisch finns: 404, inte 401), den äldsta är borttagen
  assert.equal((await req(`/api/image/${S.film}/poster?t=${toks.at(-1)}`, { tok: '' })).status, 404);
  assert.equal((await req(`/api/image/${S.film}/poster?t=${toks[0]}`, { tok: '' })).status, 401);
  // Appens egen token påverkas inte
  assert.equal((await req('/api/libraries', { tok: bo })).status, 200);
});

// ---------- 3b. medietoken ----------
test('medietoken: högst ett tak per användare, flera flikar på samma titel fungerar samtidigt', async () => {
  const uid = D.get("SELECT id FROM users WHERE name='bo'").id;
  const play = async () => {
    const r = await req(`/api/items/${S.film}/playback`, { tok: bo });
    assert.equal(r.status, 200);
    const t = /[?&]t=([0-9a-f]+)/.exec(JSON.stringify(r.data))?.[1];
    assert.ok(t, 'appen får en medietoken i strömlänken');
    return t;
  };
  // Två flikar (eller en app och en Chromecast) på samma film: båda token fungerar
  const a = await play(), b = await play();
  for (const t of [a, b]) assert.equal((await req(`/api/stream/${S.film}/direct?t=${t}`, { tok: '', headers: { range: 'bytes=0-9' } })).status, 206);
  // Många uppspelningsanrop (t.ex. en app som startar om i en slinga): taket håller, den nyaste fungerar
  let last = '';
  auth.createSession(uid, 'img');
  for (let i = 0; i < 400; i++) last = auth.createSession(uid, 'media', { item: S.film });
  const n = D.get("SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND kind='media'", uid).n;
  assert.ok(n <= auth.MEDIA_MAX, `${n} medietoken sparade för samma användare (tak ${auth.MEDIA_MAX})`);
  assert.ok(auth.MEDIA_MAX >= 200 && auth.MEDIA_MAX < 400, 'taket räcker för ett album offline och flera enheter samtidigt');
  assert.equal((await req(`/api/stream/${S.film}/direct?t=${last}`, { tok: '', headers: { range: 'bytes=0-9' } })).status, 206);
  assert.equal((await req(`/api/stream/${S.film}/direct?t=${a}`, { tok: '', headers: { range: 'bytes=0-9' } })).status, 401, 'den äldsta är borttagen');
  // Bildtoken och appens egen token påverkas inte av taket för medietoken
  assert.equal((await req('/api/libraries', { tok: bo })).status, 200);
  assert.ok(D.get("SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND kind='img'", uid).n > 0);
});

// ---------- 5. kontospärrens nyckel ----------
test('kontospärren: användarnamnet i nyckeln är kortat (långa namn ger inte långa nycklar i minnet)', () => {
  const base = 'å'.repeat(64);
  for (let i = 0; i < 5; i++) auth.noteFail('198.51.100.7', base + 'x'.repeat(1000) + i);
  assert.equal(auth.userLocked(base + 'annat-slut'), true, 'samma första 64 tecken = samma nyckel');
  auth.clearFails(base + 'y'.repeat(5000));
  assert.equal(auth.userLocked(base), false);
});

// ---------- 6. lokal tid i datum ----------
// Strax efter midnatt svensk tid är det fortfarande gårdagen i UTC – även kring sommar- och vintertid
const MIDNIGHTS = [
  ['2026-11-24T23:30:00Z', '2026-11-25'], // vintertid, UTC+1
  ['2026-03-28T23:30:00Z', '2026-03-29'], // natten då sommartiden börjar (00:30 är ännu UTC+1)
  ['2026-03-29T22:30:00Z', '2026-03-30'], // första natten med sommartid, UTC+2
  ['2026-10-24T22:30:00Z', '2026-10-25'], // natten då vintertiden börjar (00:30 är ännu UTC+2)
  ['2026-10-25T23:30:00Z', '2026-10-26'], // första natten med vintertid, UTC+1
  ['2026-12-31T23:30:00Z', '2027-01-01'] // årsskifte
];

test('lokalt datum: util.localDate följer TZ kring midnatt, sommartid och vintertid', () => {
  assert.equal(typeof util.localDate, 'function');
  for (const [utc, day] of MIDNIGHTS) assert.equal(util.localDate(new Date(utc)), day, utc);
  assert.equal(util.localDate(new Date('2026-11-25T12:00:00Z')), '2026-11-25');
});

test('inspelningens metadata: datumet är sändningens lokala dag (som i NFO-filen)', () => {
  for (const [utc, day] of MIDNIGHTS) {
    const args = dvr.postArgs('mkv', 'never', true, { title: 'Nyheterna', start: Date.parse(utc) / 1000 })[0];
    const i = args.indexOf('date=' + day);
    assert.ok(i > 0 && args[i - 1] === '-metadata', `${utc}: ${args.filter(a => String(a).startsWith('date=')).join()} – väntade ${day}`);
  }
});

test('exporters filnamn: lokal dag strax efter midnatt (historik, statistik, ordlista, mina uppgifter)', async () => {
  for (const [utc, day] of MIDNIGHTS.slice(0, 4)) {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(utc) });
    try {
      // Låtsad klocka: logga in på nytt (sessioner jämförs med klockan)
      const tok = auth.createSession(D.get("SELECT id FROM users WHERE name='admin'").id, 'app');
      const name = async (p) => /filename="([^"]+)"/.exec((await req(p, { tok })).headers.get('content-disposition') || '')?.[1] || '';
      assert.match(await name('/api/history.csv'), new RegExp(`-${day}\\.csv$`), `${utc}: Min historik`);
      assert.match(await name('/api/playstats/history.csv'), new RegExp(`-${day}\\.csv$`), `${utc}: statistiken`);
      assert.match(await name('/api/vocab/export'), new RegExp(`-${day}\\.txt$`), `${utc}: ordlistan`);
      assert.match(await name('/api/me/export'), new RegExp(`-${day}\\.json$`), `${utc}: mina uppgifter`);
    } finally { mock.timers.reset(); }
  }
});

test('inbjudan och diagnostik: lokal dag strax efter midnatt (audit-texten och filnamnen)', { timeout: 30000 }, async () => {
  for (const [utc, day] of MIDNIGHTS.slice(0, 4)) {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(utc) });
    try {
      const tok = auth.createSession(D.get("SELECT id FROM users WHERE name='admin'").id, 'app');
      // Inbjudan som gäller 1 dygn: giltig till morgondagens lokala datum
      const inv = await req('/api/invites', { method: 'POST', tok, body: { days: 1, note: 'test ' + utc } });
      assert.equal(inv.status, 200);
      const until = util.localDate(new Date(Date.parse(utc) + 86400000));
      const row = D.get("SELECT detail FROM audit WHERE event='invite_created' ORDER BY rowid DESC LIMIT 1");
      assert.equal(row.detail, `test ${utc} – giltig till ${until}`, `${utc}: audit-texten`);
      D.run('DELETE FROM invites WHERE id=?', inv.data.id);
      // Diagnostiken i loggvyn och paketet i Hälsokontrollen
      const cd = (await req('/api/logs/diagnostics', { tok })).headers.get('content-disposition') || '';
      assert.match(cd, new RegExp(`braxhn-diagnostik-${day}\\.txt`), `${utc}: loggvyns diagnostik`);
      const pkg = await req('/api/admin/health/diagnostics', { method: 'POST', tok, body: {} });
      assert.equal(pkg.status, 200);
      assert.equal(pkg.data.filename, `braxhn-diagnostik-${day}.tar.gz`, `${utc}: diagnostikpaketet`);
    } finally { mock.timers.reset(); }
  }
});
