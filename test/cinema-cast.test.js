// Bio-läge (trailers och förfilm före filmen) och Chromecast-köns mediatoken mot en riktig server med riktiga
// testfiler: trailers i mappar enligt trailers.js (Film (år)-trailer.mp4 och undermappen trailers/), en förfilmsmapp
// utanför biblioteken och en serie för kön. Väljs bara osedda filmer inom profilens åldersgräns, i liknande genre först?
// Gäller varje token bara sin trailer/förfilm/titel? Köas nästa avsnitt utan att räknas som "spelas nu"? Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-cinema-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 27000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, admin = '', kid = '';
const S = {};

async function req(p, { method = 'GET', body, tok = admin, headers = {} } = {}) {
  const h = { ...headers };
  if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (name, password) => (await req('/api/login', { method: 'POST', body: { name, password, app: true }, tok: '' })).data.token;
const clip = (file, secs = 2, freq = 440) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', `sine=frequency=${freq}`, '-t', String(secs),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
};
// Hämtar en ström utan inloggning (bara token i adressen, som Chromecast)
const bare = async (url) => (await fetch(B + url, { headers: { range: 'bytes=0-99' } })).status;

before(async () => {
  if (!hasFfmpeg) return;
  const F = path.join(MEDIA, 'Filmer');
  for (const n of ['Huvudfilmen (2022)', 'Andra (2021)', 'Tredje (2019)', 'Vuxen (2018)', 'Sedd (2017)', 'Utan trailer (2016)']) clip(path.join(F, n, n + '.mp4'), 3);
  clip(path.join(F, 'Huvudfilmen (2022)', 'Huvudfilmen (2022)-trailer.mp4'));
  clip(path.join(F, 'Andra (2021)', 'Andra (2021)-trailer.mp4'), 2, 300);
  clip(path.join(F, 'Tredje (2019)', 'trailers', 'Tredje teaser.mp4'), 2, 500);
  clip(path.join(F, 'Vuxen (2018)', 'Vuxen (2018) - trailer.mp4'), 2, 600);
  clip(path.join(F, 'Sedd (2017)', 'Sedd (2017).trailer.mp4'), 2, 700);
  for (const e of [1, 2, 3]) clip(path.join(MEDIA, 'Serier', 'Serien', 'Season 1', `Serien S01E0${e}.mp4`), 3);
  clip(path.join(MEDIA, 'Förfilmer', 'stäng av mobilen.mp4'), 1, 800);
  clip(path.join(MEDIA, 'Förfilmer', 'popcorn.mp4'), 1, 900);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '', WATCH_FILES: '0' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

t('förberedelse: bibliotek, trailers, genrer och åldersgränser', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW }, tok: '' })).status, 200);
  admin = await login('admin', PW);
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).status, 200);
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Serier', type: 'show', path: path.join(MEDIA, 'Serier') } })).status, 200);
  for (let i = 0; i < 120; i++) { await sleep(500); const r = (await req('/api/scan')).data; if (!r.running && !r.analysis?.running && r.last) break; }
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const id = (title) => db.prepare("SELECT id FROM items WHERE title=? AND kind='movie'").get(title)?.id;
  for (const n of ['Huvudfilmen', 'Andra', 'Tredje', 'Vuxen', 'Sedd', 'Utan trailer']) S[n] = id(n);
  assert.ok(Object.values(S).every(Boolean), JSON.stringify(S));
  // Trailerfilerna blev inte egna filmer utan kopplades till sina filmer
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE kind='movie'").get().n, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trailers').get().n, 5);
  const set = db.prepare('UPDATE items SET genres=?, age=? WHERE id=?');
  set.run('["Action","Thriller"]', 7, S.Huvudfilmen);
  set.run('["Action"]', 7, S.Andra);
  set.run('["Drama"]', 7, S.Tredje);
  set.run('["Action","Thriller"]', 15, S.Vuxen);
  set.run('["Action"]', 7, S.Sedd);
  set.run('["Action"]', 7, S['Utan trailer']);
  const ep = (n) => db.prepare("SELECT id FROM items WHERE kind='episode' AND episode=?").get(n).id;
  S.e1 = ep(1); S.e2 = ep(2); S.e3 = ep(3);
  db.prepare("UPDATE items SET age=7 WHERE kind='show'").run();
  db.close();
  // Sedd är redan sedd av administratören
  const d = (await req(`/api/items/${S.Sedd}`)).data.duration || 3;
  assert.equal((await req(`/api/items/${S.Sedd}/progress`, { method: 'POST', body: { position: d, duration: d } })).data.watched, true);
  // Barnprofil (högst 11 år)
  assert.equal((await req('/api/profiles', { method: 'POST', body: { name: 'Lisa', maxAge: 11 } })).status, 200);
  const k = (await req('/api/profiles')).data.profiles.find(p => p.name === 'Lisa').id;
  kid = (await req('/api/profiles/switch', { method: 'POST', body: { id: k } })).data.token;
  assert.ok(kid);
  admin = await login('admin', PW);
});

const pb = (id, q = '', tok = admin) => req(`/api/items/${id}/playback?c=mp4&v=h264&a=aac&${q}`, { tok });

t('bio-läget är avstängt som standard; inställningen sparas per användare', async () => {
  assert.deepEqual((await req('/api/me/cinema')).data, { trailers: 0, preroll: false, max: 3, prerollAvailable: false });
  const r = await pb(S.Huvudfilmen, 'cinema=1');
  assert.equal(r.status, 200);
  assert.equal(r.data.preroll, undefined);
  assert.equal((await req('/api/me/cinema', { method: 'PUT', body: { trailers: 9 } })).data.trailers, 3); // högst 3
  assert.equal((await req('/api/me/cinema', { method: 'PUT', body: { trailers: 2 } })).data.trailers, 2);
  assert.equal((await req('/api/me/cinema', { tok: kid })).data.trailers, 0); // profilen har sin egen
});

t('trailers: osedda filmer, liknande genre först, en egen token per trailer', async () => {
  await req('/api/me/cinema', { method: 'PUT', body: { trailers: 3 } });
  for (let round = 0; round < 5; round++) {
    const r = await pb(S.Huvudfilmen, 'cinema=1');
    const pre = r.data.preroll;
    assert.equal(pre.length, 3, JSON.stringify(pre));
    assert.ok(pre.every(x => x.kind === 'trailer' && typeof x.title === 'string' && /^\/api\/trailers\/\d+\/stream\?t=[0-9a-f]{64}$/.test(x.url)));
    // aldrig filmen själv (den har också en trailer) eller en film som redan är sedd
    const items = pre.map(x => x.itemId);
    assert.ok(!items.includes(S.Huvudfilmen) && !items.includes(S.Sedd), JSON.stringify(pre));
    // Action/Thriller före Drama
    assert.deepEqual(new Set(items.slice(0, 2)), new Set([S.Andra, S.Vuxen]));
    assert.equal(items[2], S.Tredje);
    assert.ok(pre.every(x => x.duration > 1.5 && x.duration < 2.5), JSON.stringify(pre.map(x => x.duration)));
  }
  const pre = (await pb(S.Huvudfilmen, 'cinema=1')).data.preroll;
  // Token gäller sin trailer – inte en annan trailer och inte filmen
  assert.equal(await bare(pre[0].url), 206);
  const tok0 = new URL(B + pre[0].url).searchParams.get('t');
  assert.equal(await bare(`/api/trailers/${pre[1].trailerId}/stream?t=${tok0}`), 401);
  assert.equal(await bare(`/api/stream/${S.Huvudfilmen}/direct?t=${tok0}`), 401);
  // Filmens egen strömlänk fungerar som förut
  const main = (await pb(S.Huvudfilmen, 'cinema=1')).data;
  assert.equal(main.mode, 'direct');
  assert.equal(await bare(main.url), 206);
});

t('trailers bara när filmen startas från början – inte avsnitt, fortsättning eller utan cinema=1', async () => {
  assert.equal((await pb(S.Huvudfilmen, 'cinema=1&start=95')).data.preroll, undefined);
  assert.equal((await pb(S.Huvudfilmen, '')).data.preroll, undefined);
  assert.equal((await pb(S.Huvudfilmen, 'cinema=1&info=1')).data.preroll, undefined);
  assert.equal((await pb(S.e1, 'cinema=1')).data.preroll, undefined);
});

t('barnprofil: bara trailers inom åldersgränsen', async () => {
  await req('/api/me/cinema', { method: 'PUT', body: { trailers: 3 }, tok: kid });
  const pre = (await pb(S.Huvudfilmen, 'cinema=1', kid)).data.preroll;
  const items = pre.map(x => x.itemId);
  assert.ok(!items.includes(S.Vuxen), JSON.stringify(pre));
  // Barnet har inte sett Sedd – den får komma med
  assert.deepEqual(new Set(items), new Set([S.Andra, S.Tredje, S.Sedd]));
  // Trailern till en film över gränsen nekas även direkt
  const vuxen = (await pb(S.Huvudfilmen, 'cinema=1')).data.preroll.find(x => x.itemId === S.Vuxen);
  assert.equal((await req(`/api/trailers/${vuxen.trailerId}/stream`, { tok: kid })).status, 403);
});

t('förfilm: administratören väljer en mapp under mediamappen, den spelas sist', async () => {
  assert.equal((await req('/api/settings', { method: 'PUT', body: { cinemaPreroll: '/etc' } })).status, 400);
  assert.equal((await req('/api/settings', { method: 'PUT', body: { cinemaPreroll: path.join(MEDIA, 'Serier', 'Serien', 'saknas') } })).status, 400);
  assert.equal((await req('/api/settings', { method: 'PUT', body: { cinemaPreroll: path.join(MEDIA, 'Förfilmer') } })).status, 200);
  assert.equal((await req('/api/settings')).data.cinemaPrerollFiles, 2);
  assert.equal((await req('/api/me/cinema')).data.prerollAvailable, true);
  // Utan användarens val spelas den inte
  assert.ok((await pb(S.Huvudfilmen, 'cinema=1')).data.preroll.every(x => x.kind === 'trailer'));
  await req('/api/me/cinema', { method: 'PUT', body: { trailers: 1, preroll: true } });
  const pre = (await pb(S.Huvudfilmen, 'cinema=1')).data.preroll;
  assert.equal(pre.length, 2);
  assert.equal(pre[0].kind, 'trailer');
  const last = pre[1];
  assert.equal(last.kind, 'preroll'); assert.equal(last.itemId, null);
  assert.match(last.url, /^\/api\/cinema\/preroll\/[01]\/stream\?t=[0-9a-f]{64}$/);
  assert.ok(last.duration > 0.5 && last.duration < 1.5);
  assert.equal(await bare(last.url), 206);
  const tok = new URL(B + last.url).searchParams.get('t');
  assert.equal(await bare(`/api/trailers/${pre[0].trailerId}/stream?t=${tok}`), 401);
  // Bara förfilm (inga trailers) fungerar också; webben (kaka) får adresser utan token – här via Bearer: token finns
  await req('/api/me/cinema', { method: 'PUT', body: { trailers: 0, preroll: true } });
  assert.deepEqual((await pb(S.Huvudfilmen, 'cinema=1')).data.preroll.map(x => x.kind), ['preroll']);
  assert.equal((await req('/api/cinema/preroll/7/stream')).status, 404);
  assert.equal((await req('/api/cinema/preroll/0/stream', { tok: '' })).status, 401);
  // Tom inställning: ingen förfilm
  assert.equal((await req('/api/settings', { method: 'PUT', body: { cinemaPreroll: '' } })).status, 200);
  assert.equal((await pb(S.Huvudfilmen, 'cinema=1')).data.preroll, undefined);
  await req('/api/me/cinema', { method: 'PUT', body: { trailers: 0, preroll: false } });
});

t('Chromecast-kön: nästa avsnitt får en egen token och räknas inte som "spelas nu"', async () => {
  const cur = (await pb(S.e1, 'cast=1')).data;
  assert.match(cur.token, /^[0-9a-f]{64}$/);
  const next = (await pb(S.e2, 'cast=1&queue=1')).data;
  assert.match(next.token, /^[0-9a-f]{64}$/);
  assert.notEqual(next.token, cur.token);
  assert.equal(next.preroll, undefined);
  // Varje token gäller bara sin titel
  assert.equal(await bare(next.url), 206);
  assert.equal(await bare(`/api/stream/${S.e1}/direct?t=${next.token}`), 401);
  assert.equal(await bare(`/api/stream/${S.e3}/direct?t=${cur.token}`), 401);
  assert.equal(await bare(`/api/items/${S.e2}?t=${next.token}`), 401); // och bara strömmar
  // Den köade titeln syns inte under Aktivitet (förrän mottagaren börjar spela den)
  const active = (await req('/api/activity')).data;
  assert.ok(active.some(a => a.itemId === S.e1), JSON.stringify(active));
  assert.ok(!active.some(a => a.itemId === S.e2), JSON.stringify(active));
  // Framsteget sparas med samma API som webbspelaren (castpanelen anropar det)
  const r = await req(`/api/items/${S.e2}/progress`, { method: 'POST', body: { position: 2.9, duration: 3 } });
  assert.equal(r.data.watched, true);
});
