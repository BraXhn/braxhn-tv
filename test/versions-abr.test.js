// Flera versioner av samma film och anpassningsbar kvalitet (ABR). Kräver ffmpeg för serverdelen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-ver-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 21000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, cookie = '';

// Enhetsdelarna importerar modulerna i en egen konfigurationsmapp
process.env.CONFIG_DIR = path.join(ROOT, 'unitconfig');
process.env.TRANSCODE_DIR = path.join(ROOT, 'unit-tc');
const st = await import('../server/stream.js');
const ver = await import('../server/versions.js');

const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
async function req(p, { method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc) && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitScan() {
  for (let i = 0; i < 120; i++) { await sleep(1000); const r = await req('/api/scan'); if (!r.data.running && !r.data.analysis?.running && r.data.last) return; }
  throw new Error('skanning tog för lång tid');
}
const FILMER = path.join(MEDIA, 'Filmer');
const video = (size, t, file, extra = []) => ff('-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24`, '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', String(t),
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48', ...extra, '-c:a', 'aac', file);

before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(path.join(FILMER, 'Mapp (2018)'), { recursive: true });
  video('1280x720', 14, path.join(FILMER, 'Film (2020) - 720p.mkv'));
  video('640x360', 14, path.join(FILMER, "Film (2020) - Director's Cut.mp4"));
  video('320x240', 6, path.join(FILMER, 'Ensam (2019).mp4'));
  video('320x240', 6, path.join(FILMER, 'Mapp (2018)', 'a.mp4'));
  video('640x360', 6, path.join(FILMER, 'Mapp (2018)', 'b.mkv'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1) },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

// ---------------- enhetstester ----------------
const fake = (w, h, extra = {}) => ({ id: 1, path: '/x/Film (2020).mkv', size: 1e9, duration: 600, streams: JSON.stringify([{ index: 0, type: 'video', codec: 'h264', width: w, height: h }]), ...extra });

test('ABR: varianter bara vid omkodning med automatisk kvalitet, ≤ källan och ≤ vald kvalitet', () => {
  const qs = (it, d) => st.abrVariants(it, { audioMode: 'aac', ...d }).map(x => `${x.q}:${x.h}`);
  assert.deepEqual(qs(fake(1920, 1080), { q: '1080', mode: 'transcode', abr: true }), ['1080:1080', '720:720', '480:480']);
  assert.deepEqual(qs(fake(3840, 2160), { q: '1080', mode: 'transcode', abr: true }), ['1080:1080', '720:720', '480:480']);
  assert.deepEqual(qs(fake(3840, 2160), { q: '2160', mode: 'transcode', abr: true }), ['2160:2160', '1080:1080', '720:720', '480:480']);
  // Källan är lägre än vald kvalitet: toppen blir källans höjd, inga steg över den
  assert.deepEqual(qs(fake(1280, 720), { q: '1080', mode: 'transcode', abr: true }), ['1080:720', '480:480']);
  assert.deepEqual(qs(fake(1920, 1080), { q: 'orig', mode: 'transcode', abr: true }), ['orig:1080', '720:720', '480:480']);
  // Manuell kvalitet, remux: en variant
  assert.deepEqual(qs(fake(1920, 1080), { q: '1080', mode: 'transcode', abr: false }), ['1080:1080']);
  assert.deepEqual(qs(fake(1920, 1080), { q: '1080', mode: 'remux', abr: true }), ['1080:1080']);
  // Bredd följer bildformatet, bandbredden sjunker stegvis
  const v = st.abrVariants(fake(1920, 800), { q: '1080', mode: 'transcode', abr: true, audioMode: 'aac' });
  assert.equal(v[0].h, 800); assert.equal(v[0].w, 1920);
  assert.ok(v.every((x, i) => i === 0 || x.bw < v[i - 1].bw));
  assert.equal(v[1].w % 2, 0);
});

test('ABR: hlsParams sätter abr bara vid omkodning', () => {
  const o = { hlsSubs: false };
  const base = { mode: 'transcode', q: '1080', audio: '', audioMode: 'aac', burn: '', tonemap: false, fmt: 'ts', tag: '' };
  assert.equal(st.hlsParams({ ...base, abr: true }, o).get('abr'), '1');
  assert.equal(st.hlsParams({ ...base, abr: false }, o).get('abr'), null);
  assert.equal(st.hlsParams({ ...base, mode: 'remux', abr: true }, o).get('abr'), null);
});

test('versioner: etiketter från filnamn eller upplösning', () => {
  assert.equal(ver.versionLabel({ path: '/m/Film (2020) - 2160p.mkv', width: 3840, height: 2160, hdr: 'hdr10' }), '4K HDR10');
  assert.equal(ver.versionLabel({ path: "/m/Film (2020) - Director's Cut.mkv", width: 1920, height: 1080 }), "Director's Cut");
  assert.equal(ver.versionLabel({ path: '/m/Film.2020.1080p.BluRay.x264.mkv', width: 1920, height: 800 }), '1080p');
  assert.equal(ver.versionLabel({ path: '/m/Film (2020)/a.mkv', width: 1280, height: 720 }), '720p');
  const l = ver.versionList([{ id: 1, path: '/m/A (2020).mkv', width: 1920, height: 1080 }, { id: 2, path: '/m/A (2020)/x.mkv', width: 1920, height: 1080 }]);
  assert.deepEqual(l.map(x => x.label), ['1080p (1)', '1080p (2)']);
  assert.equal(ver.versionKey({ title: 'Film', year: 2020 }), ver.versionKey({ title: 'film', year: 2020 }));
  assert.equal(ver.versionKey({ title: 'Film', year: null }), null);
});

test('versioner: val av version för klienten', () => {
  const v4k = { id: 1, version_of: null, width: 3840, height: 2160 }, v1080 = { id: 2, version_of: 1, width: 1920, height: 1080 }, v720 = { id: 3, version_of: 1, width: 1280, height: 720 };
  const rows = [v4k, v1080, v720];
  // Allt kan spelas utan omkodning: högst upplösning vinner
  assert.equal(ver.chooseVersion(rows, {}, () => ({ mode: 'direct' })), v4k);
  // 4K kräver omkodning (t.ex. HEVC som klienten inte klarar), 1080p kan remuxas: undvik omkodning
  assert.equal(ver.chooseVersion(rows, {}, (r) => ({ mode: r === v4k ? 'transcode' : r === v1080 ? 'remux' : 'direct' })), v1080);
  // Allt måste omkodas: högsta upplösning ≤ önskad kvalitet
  assert.equal(ver.chooseVersion(rows, {}, () => ({ mode: 'transcode' }), 1080), v1080);
  assert.equal(ver.chooseVersion(rows, {}, () => ({ mode: 'transcode' }), 480), v720);
  assert.equal(ver.chooseVersion(rows, {}, () => ({ mode: 'transcode' }), null), v4k);
  // Ljud-/undertextval påverkar inte rankningen
  let seen = null;
  ver.chooseVersion(rows, { audio: '3', sub: 'e4' }, (r, o) => { seen = o; return { mode: 'direct' }; });
  assert.equal(seen.audio, ''); assert.equal(seen.sub, '');
});

test('versioner: spårval översätts mellan versioner via språk', () => {
  const S = (arr) => ({ streams: JSON.stringify(arr) });
  const from = { id: 1, ...S([{ index: 0, type: 'video' }, { index: 1, type: 'audio', lang: 'eng', codec: 'ac3' }, { index: 2, type: 'audio', lang: 'swe', codec: 'aac' }]) };
  const to = { id: 2, ...S([{ index: 0, type: 'video' }, { index: 3, type: 'audio', lang: 'swe', codec: 'aac' }, { index: 4, type: 'audio', lang: 'eng', codec: 'eac3' }]) };
  const subs = () => [];
  assert.equal(ver.mapTracks({ audio: '2', sub: '' }, from, to, st.streamsOf, subs).audio, '3');
  assert.equal(ver.mapTracks({ audio: '1', sub: '' }, from, to, st.streamsOf, subs).audio, '4');
  // Index som finns i den valda versionen behålls (kommer från dess egen spårlista)
  assert.equal(ver.mapTracks({ audio: '4', sub: '' }, from, to, st.streamsOf, subs).audio, '4');
});

// ---------------- mot en riktig server ----------------
let lib, film, other;
t('skanning grupperar versioner – listor och sök visar bara huvudraden', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } })).status, 200);
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: FILMER } })).status, 200);
  await waitScan();
  lib = (await req('/api/libraries')).data.find(l => l.type === 'movie');
  assert.equal(lib.count, 3, 'Film, Mapp och Ensam');
  const items = (await req(`/api/libraries/${lib.id}/items`)).data.items;
  assert.deepEqual(items.map(i => i.title).sort(), ['Ensam', 'Film', 'Mapp']);
  const paged = (await req(`/api/libraries/${lib.id}/items?limit=10`)).data;
  assert.equal(paged.total, 3);
  assert.equal((await req('/api/search?q=Film')).data.filter(i => i.kind === 'movie').length, 1);
  const home = (await req('/api/home')).data;
  assert.equal(home.rows[0].items.length, 3);
  film = (await req(`/api/items/${items.find(i => i.title === 'Film').id}`)).data;
  assert.equal(film.versions.length, 2);
  assert.deepEqual(film.versions.map(v => v.label).sort(), ["720p", "Director's Cut"].sort());
  const mapp = (await req(`/api/items/${items.find(i => i.title === 'Mapp').id}`)).data;
  assert.equal(mapp.versions.length, 2, 'två filer i mappen "Mapp (2018)"');
  assert.equal((await req(`/api/items/${items.find(i => i.title === 'Ensam').id}`)).data.versions, undefined);
  other = film.versions.find(v => v.id !== film.id);
  // En versions id visar filmen (huvudraden) med versionens filinformation
  const viaVersion = (await req(`/api/items/${other.id}`)).data;
  assert.equal(viaVersion.id, film.id); assert.equal(viaVersion.version, other.id);
  const stats = (await req('/api/stats')).data;
  assert.equal(stats.library.movies, 3);
});

t('uppspelning väljer bästa versionen; klienten kan välja själv', async () => {
  const hi = film.versions.find(v => v.height === 720), lo = film.versions.find(v => v.height === 360);
  // Webbläsare: mkv kan remuxas, mp4 spelas direkt – ingen omkodning, så högsta upplösningen vinner
  const a = (await req(`/api/items/${film.id}/playback`)).data;
  assert.equal(a.version, hi.id); assert.equal(a.mode, 'remux');
  assert.ok(a.url.startsWith(`/api/stream/${hi.id}/`));
  // 480p: 720p-filen måste omkodas, 360p-filen kan spelas direkt
  const b = (await req(`/api/items/${film.id}/playback?q=480`)).data;
  assert.equal(b.version, lo.id); assert.equal(b.mode, 'direct');
  // Eget val
  const c = (await req(`/api/items/${film.id}/playback?version=${lo.id}`)).data;
  assert.equal(c.version, lo.id);
  // Okänt id (inte en version av filmen) ignoreras
  const ensam = (await req(`/api/libraries/${lib.id}/items`)).data.items.find(i => i.title === 'Ensam');
  assert.equal((await req(`/api/items/${film.id}/playback?version=${ensam.id}`)).data.version, hi.id);
  // Strömmen för versionen fungerar
  assert.equal((await req(c.url)).status, 200);
});

t('framsteg och sedd gäller filmen oavsett version', async () => {
  const r = await req(`/api/items/${other.id}/progress`, { method: 'POST', body: { position: 5, duration: 14 } });
  assert.equal(r.status, 200);
  assert.equal((await req(`/api/items/${film.id}`)).data.position, 5);
  const cont = (await req('/api/home')).data.continue;
  assert.deepEqual(cont.map(i => i.id), [film.id]);
  assert.equal((await req(`/api/items/${other.id}/watchlist`, { method: 'POST', body: { add: true } })).status, 200);
  assert.deepEqual((await req('/api/watchlist')).data.map(i => i.id), [film.id]);
});

t('ABR: automatisk kvalitet vid omkodning ger flera varianter med samma segmentgränser', async () => {
  const hi = film.versions.find(v => v.height === 720);
  // Flera steg bara utanför hemmet (hemma: ett steg, se nedan)
  const pb = (await req(`/api/items/${film.id}/playback?version=${hi.id}&force=transcode`, { headers: { 'x-forwarded-for': '81.2.3.4' } })).data;
  assert.equal(pb.mode, 'transcode');
  const home = (await req(`/api/items/${film.id}/playback?version=${hi.id}&force=transcode`)).data;
  assert.equal((await req(home.url)).data.toString().match(/#EXT-X-STREAM-INF/g).length, 1, 'hemma: ett steg');
  const master = (await req(pb.url)).data.toString();
  const inf = [...master.matchAll(/#EXT-X-STREAM-INF:BANDWIDTH=(\d+),RESOLUTION=(\d+)x(\d+)\n(\S+)/g)];
  assert.deepEqual(inf.map(m => +m[3]), [720, 480], master);
  assert.ok(+inf[0][1] > +inf[1][1]);
  const pids = inf.map(m => new URLSearchParams(m[4].split('?')[1]).get('pid'));
  assert.equal(pids[0], pids[1], 'samma uppspelning');
  // Manuell kvalitet: en variant
  const man = (await req(`/api/items/${film.id}/playback?version=${hi.id}&force=transcode&q=720`)).data;
  assert.equal((await req(man.url)).data.toString().match(/#EXT-X-STREAM-INF/g).length, 1);
  // Remux påverkas inte
  const rem = (await req(`/api/items/${film.id}/playback?version=${hi.id}`)).data;
  assert.equal(rem.mode, 'remux');
  assert.equal((await req(rem.url)).data.toString().match(/#EXT-X-STREAM-INF/g).length, 1);
  // Mediaspellistorna har samma segment, och segment 1 börjar på samma tid i båda varianterna
  const base = B + pb.url.split('master.m3u8')[0];
  const lists = [];
  for (const m of inf) lists.push((await req(new URL(m[4], base).pathname + '?' + m[4].split('?')[1])).data.toString());
  const durs = lists.map(l => [...l.matchAll(/#EXTINF:([\d.]+)/g)].map(x => x[1]).join(','));
  assert.equal(durs[0], durs[1]);
  const starts = [];
  for (const [i, m] of inf.entries()) {
    const q = m[4].split('?')[1];
    const r = await req(new URL('seg-1.ts', base).pathname + '?' + q);
    assert.equal(r.status, 200);
    const f = path.join(ROOT, `abr${i}.ts`); fs.writeFileSync(f, r.data);
    // Videons starttid (ljud som kopieras orört kan börja en bit före, lika i alla varianter)
    starts.push(parseFloat(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', f]).toString()));
    const h = parseInt(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', f]).toString());
    assert.equal(h, +m[3]);
  }
  assert.ok(Math.abs(starts[0] - starts[1]) < 0.05, `starttider ${starts}`);
  // Segmenten passar ihop: segment 1:s första DTS ligger inte före segment 0:s sista (Chrome avbryter annars)
  {
    const q = inf[0][4].split('?')[1];
    const r0 = await req(new URL('seg-0.ts', base).pathname + '?' + q);
    const f0 = path.join(ROOT, 'abr-s0.ts'); fs.writeFileSync(f0, r0.data);
    const dts = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=dts_time', '-of', 'csv=p=0', f]).toString().trim().split('\n').map(x => parseFloat(x)).filter(x => !isNaN(x));
    const last0 = Math.max(...dts(f0)), first1 = dts(path.join(ROOT, 'abr0.ts'))[0];
    assert.ok(first1 > last0, `DTS ${last0} → ${first1}`);
  }
  // Omkodning börjar med korta segment: 0, 2, 4, 6, 12 …
  assert.ok(Math.abs(starts[0] - 2) < 0.05, `segment 1 börjar vid 2 s (${starts[0]})`);
});

t('huvudfilen försvinner: en kvarvarande version tar över med framsteg kvar', async () => {
  const mainFile = film.versions.find(v => v.id === film.id);
  const p = mainFile.height === 720 ? 'Film (2020) - 720p.mkv' : "Film (2020) - Director's Cut.mp4";
  fs.rmSync(path.join(FILMER, p));
  assert.equal((await req(`/api/libraries/${lib.id}/scan`, { method: 'POST' })).status, 200);
  await sleep(300);
  await waitScan();
  const items = (await req(`/api/libraries/${lib.id}/items`)).data.items;
  const f = items.find(i => i.title === 'Film');
  assert.ok(f, 'filmen finns kvar');
  assert.equal(f.id, other.id, 'den kvarvarande versionen är ny huvudrad');
  assert.equal(f.position, 5, 'framsteget följde med');
  assert.deepEqual((await req('/api/watchlist')).data.map(i => i.id), [other.id]);
  const one = (await req(`/api/items/${f.id}`)).data;
  assert.equal(one.versions, undefined, 'bara en version kvar');
  assert.equal((await req(`/api/items/${film.id}`)).status, 404);
  assert.equal((await req('/api/libraries')).data.find(l => l.id === lib.id).count, 3);
});

t('en ny fil med samma titel och år blir en version av befintlig film', async () => {
  video('320x240', 6, path.join(FILMER, 'Ensam (2019) - Extra.mkv'));
  const ensam = (await req(`/api/libraries/${lib.id}/items`)).data.items.find(i => i.title === 'Ensam');
  await req(`/api/items/${ensam.id}/progress`, { method: 'POST', body: { position: 3, duration: 6 } });
  assert.equal((await req(`/api/libraries/${lib.id}/scan`, { method: 'POST' })).status, 200);
  await sleep(300);
  await waitScan();
  const items = (await req(`/api/libraries/${lib.id}/items`)).data.items;
  assert.equal(items.filter(i => i.title === 'Ensam').length, 1);
  const e = (await req(`/api/items/${ensam.id}`)).data;
  assert.equal(e.versions.length, 2);
  assert.equal(e.position, 3, 'befintlig huvudrad (med framsteg) behålls');
  assert.ok(e.versions.some(v => v.label === 'Extra'));
});
