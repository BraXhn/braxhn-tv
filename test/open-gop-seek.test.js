// Öppen GOP och spolning (remux): segment som avkodningen börjar i ska gå att avkoda för sig.
// Efter en nyckelbild i en fil med öppen GOP kommer bilder som visas FÖRE nyckelbilden och behöver GOP:en innan.
// Chromes mjukvaruavkodare (ffmpeg med strikt felkontroll) avbryter hela uppspelningen på dem när avkodningen börjar
// där – start mitt i filen, spolning, byte av kvalitet. Här provas samma sak utan webbläsare: ffmpeg med
// -err_detect explode gör som Chrome. Spelaren ber om segmentet med ra=<sekunder in>, och servern tar bort bilderna
// (server/tslead.js). Själva uppspelningen i Chrome provas i test/web-chrome-playback.test.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-opengop-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.HWACCEL = 'none';
fs.mkdirSync(path.join(MEDIA, 'Filmer'), { recursive: true });
const FILM = path.join(MEDIA, 'Filmer', 'Oppen Gop (2020).mkv');
// Öppen GOP med B-pyramid och nyckelbild varannan sekund: tre GOP:ar per vanligt segment (6 s). AC-3 → ljudet konverteras.
if (hasFfmpeg) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '60',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-x264-params', 'keyint=48:min-keyint=4:open-gop=1:b-pyramid=normal:scenecut=0:b-adapt=0', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', FILM]);
// Öppen GOP utan B-pyramid: bilderna EFTER nyckelbilden hänvisar till GOP:en före – ra räcker inte (omkodas i webben).
// Stängd GOP: varje nyckelbild är en IDR-bild.
const FLAT = path.join(MEDIA, 'Filmer', 'Utan Pyramid (2021).mkv'), CLOSED = path.join(MEDIA, 'Filmer', 'Stangd Gop (2022).mkv');
for (const [file, x264] of [[FLAT, 'keyint=48:min-keyint=4:open-gop=1:b-pyramid=none:scenecut=0:b-adapt=0'], [CLOSED, 'keyint=48:min-keyint=4:scenecut=0']])
  if (hasFfmpeg) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '40',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-x264-params', x264, '-pix_fmt', 'yuv420p', '-c:a', 'ac3', file]);

const D = await import('../server/db.js');
const sc = await import('../server/scanner.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const st = await import('../server/stream.js');
const { dropLeading, SLACK, keyIsIdr } = await import('../server/tslead.js');
const og = await import('../server/opengop.js');
const H = await import('../web/js/player/hlsconfig.js');
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { st.purgeIdle(-1); srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

test('spelaren: vilka segment avkodningen börjar i (ra)', () => {
  // Inget buffrat: start från början och fortsättning mitt i
  assert.equal(H.randomAccess([], 0, 0), 0);
  assert.ok(Math.abs(H.randomAccess([], 72.07, 75) - 2.93) < 1e-9);
  // Nästa segment i tur medan filmen spelar: fortsätter på det buffrade
  assert.equal(H.randomAccess([[0.02, 12.0]], 12.0, 3), null);
  assert.equal(H.randomAccess([[74.25, 76.28]], 76.1, 75), null, 'tidslinjen kan ligga någon tiondel fel');
  // Spolning utanför bufferten, framåt och bakåt
  assert.equal(H.randomAccess([[0.02, 12.0]], 60, 61.5), 1.5);
  assert.equal(H.randomAccess([[74.25, 90]], 68.1, 70), 70 - 68.1);
  // Segmentet alldeles före det buffrade (inget före det)
  assert.equal(H.randomAccess([[74.25, 90]], 72.07, 72.07), 0);
  // Spelaren står redan i segmentet (spolning precis till buffertens slut): avkodningen börjar där
  assert.equal(H.randomAccess([[0.02, 63.94]], 63.94, 64), 64 - 63.94);
  // Ett glapp större än spelaren går över räknas inte som buffrat före
  assert.equal(H.randomAccess([[0, 10]], 11, 5), 0);
  assert.equal(H.segNo('/api/stream/4/hls/seg-14.ts?mode=remux&q=orig'), 14);
  assert.equal(H.segNo('/api/stream/4/hls/seg-14.m4s?mode=remux'), null, 'bara TS');
  assert.equal(H.segNo('/api/stream/4/hls/index.m3u8?x=1'), null);
  assert.equal(H.randomAccessUrl('/a/seg-1.ts?mode=remux', 2.934), '/a/seg-1.ts?mode=remux&ra=2.93');
  assert.equal(H.randomAccessUrl('/a/seg-1.ts'), '/a/seg-1.ts?ra=0');
});

test('spelaren: återhämtning efter avkodningsfel – ett nytt försök per ställe, sedan ge upp', () => {
  const a = H.recoverPlan(null, 64, 1000);
  assert.deepEqual(a, { at: 1000, pos: 64, n: 1 });
  const b = H.recoverPlan(a, 64.1, 1400);
  assert.equal(b.n, 2, 'samma ställe strax efter räknas som samma fel');
  assert.equal(H.recoverPlan(b, 64, 1800), null, 'tredje gången på samma ställe: ge upp');
  assert.equal(H.recoverPlan(a, 64, 1400, 1), null, 'remux: ett försök, sedan omkodning');
  assert.equal(H.recoverPlan(b, 300, 1800).n, 1, 'ett annat ställe börjar om räkningen');
  assert.equal(H.recoverPlan(b, 64, 60000).n, 1, 'långt senare börjar räkningen om');
});

test('dropLeading rör inte det som inte är ett TS-segment med bild', () => {
  for (const b of [Buffer.alloc(0), Buffer.from('hej'), Buffer.alloc(188 * 4, 1), Buffer.alloc(188 * 4 + 7, 0x47)]) assert.equal(dropLeading(b), b);
  // Rätt takt (0x47) men ingen PAT/PMT: oförändrat
  const junk = Buffer.alloc(188 * 5); for (let i = 0; i < 5; i++) { junk[i * 188] = 0x47; junk[i * 188 + 1] = 0x1f; junk[i * 188 + 2] = 0xff; junk[i * 188 + 3] = 0x10; }
  assert.equal(dropLeading(junk), junk);
  assert.equal(dropLeading(null), null);
});

let it, tok;
const A = () => ({ authorization: 'Bearer ' + tok });
async function playlist(q) {
  const pb = await (await fetch(`${B}/api/items/${it.id}/playback?${q}`, { headers: A() })).json();
  const idx = new URL(pb.url.replace('master.m3u8', 'index.m3u8'), B);
  const pl = await (await fetch(idx, { headers: A() })).text();
  const segs = []; let at = 0;
  for (const m of pl.matchAll(/#EXTINF:([\d.]+),\n(\S+)/g)) { segs.push({ start: at, dur: +m[1], url: new URL(m[2], idx) }); at += +m[1]; }
  return { pb, segs };
}
let nFile = 0;
async function fetchSeg(seg, ra) {
  const u = new URL(seg.url); if (ra != null) u.searchParams.set('ra', String(ra));
  const r = await fetch(u, { headers: A() });
  assert.equal(r.status, 200);
  assert.equal(+r.headers.get('content-length'), (await r.clone().arrayBuffer()).byteLength, 'Content-Length stämmer');
  const f = path.join(ROOT, `s${nFile++}.ts`); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  return f;
}
const packets = (f, s) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', s, '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', f]).toString().trim().split('\n').map(l => ({ pts: +l.split(',')[0], key: l.split(',')[1].startsWith('K') }));
// Som Chromes mjukvaruavkodare: första felet avbryter
const strict = (f) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-err_detect', 'explode', '-xerror', '-i', f, '-an', '-f', 'null', '-']); return { ok: r.status === 0, err: r.stderr.toString().trim().split('\n')[0] }; };
/** Bilder som visas före sin GOP:s nyckelbild */
function leading(pk) { let k = null, n = 0; for (const p of pk) { if (p.key) k = p.pts; else if (k != null && p.pts < k) n++; } return n; }

t('remux av öppen GOP: segmentet som avkodningen börjar i går att avkoda för sig med ra', async () => {
  const U = Number(D.run('INSERT INTO users(name,pass,is_admin,created) VALUES(?,?,1,0)', 'anna', await auth.hashPw('Oppen-gop-2026!')).lastInsertRowid);
  tok = auth.createSession(U, 'app');
  const LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", path.join(MEDIA, 'Filmer')).lastInsertRowid);
  await sc.scan(LIB);
  it = D.get('SELECT * FROM items WHERE path=?', FILM);
  assert.ok(it?.duration > 50);
  await st.computeKeyframes(it);
  const P = await playlist('force=hls');
  assert.equal(P.pb.mode, 'remux', (P.pb.reasons || []).join(', '));
  // Ett vanligt segment mitt i filen: 6 s = tre GOP:ar
  const seg = P.segs.find(s => s.start >= 20 && s.dur >= 5.9);
  assert.ok(seg, 'ett 6-sekunderssegment');
  const raw = await fetchSeg(seg), pr = packets(raw, 'v:0'), ar = packets(raw, 'a:0');
  assert.equal(pr.filter(p => p.key).length, 3, 'tre GOP:ar i segmentet');
  // Förutsättningen: filen har bilder före nyckelbilden, och strikt avkodning från segmentets början faller på dem
  assert.ok(leading(pr) >= 3, `bilder före sin nyckelbild i det råa segmentet: ${leading(pr)}`);
  assert.equal(strict(raw).ok, false, 'det råa segmentet går inte att avkoda strikt för sig (som i Chrome)');

  // ra=0: uppspelningen börjar i segmentets första GOP – bara dess bilder tas bort
  const f0 = await fetchSeg(seg, 0), p0 = packets(f0, 'v:0');
  assert.ok(p0[0].key, 'börjar på nyckelbilden');
  assert.equal(p0[0].pts, pr[0].pts, 'samma nyckelbild på samma tid');
  assert.ok(p0.slice(0, 8).every(p => p.pts >= p0[0].pts), 'inga bilder före nyckelbilden i första GOP:en');
  const lead1 = pr.length - p0.length;
  assert.ok(lead1 >= 1 && lead1 <= 3, `${lead1} bilder borttagna`);
  assert.equal(leading(p0), leading(pr) - lead1, 'senare GOP:ar är orörda');
  assert.deepEqual(packets(f0, 'a:0'), ar, 'ljudet är orört');
  assert.deepEqual(strict(f0), { ok: true, err: '' }, 'går att avkoda strikt från början');
  // Inga hål i paketräkningen (continuity counter) efter borttagningen
  const cc = spawnSync('ffmpeg', ['-v', 'warning', '-i', f0, '-c', 'copy', '-f', 'null', '-']).stderr.toString();
  assert.doesNotMatch(cc, /continuity|corrupt/i);

  // ra=4,5: uppspelningen börjar i tredje GOP:en (4 s in) – alla GOP:ar fram till dit rensas, och avkodningen går
  // att börja på var och en av dem
  const f4 = await fetchSeg(seg, 4.5), p4 = packets(f4, 'v:0');
  assert.equal(leading(p4), 0, 'inga bilder före sin nyckelbild kvar');
  assert.equal(p4.filter(p => p.key).length, 3);
  assert.deepEqual(strict(f4), { ok: true, err: '' });
  // ra=1: bara GOP:ar som börjar inom 1 s (+ marginal) – den tredje (4 s in) är orörd
  const p1 = packets(await fetchSeg(seg, 1), 'v:0');
  assert.equal(p1.length, p0.length, `GOP:en 2 s in ligger utanför 1 s + ${SLACK} s`);
  const p2 = packets(await fetchSeg(seg, 1.6), 'v:0');
  assert.equal(p2.length, p0.length - lead1, 'GOP:en 2 s in ligger inom 1,6 s + marginal');

  // Utan ra (andra spelare, och segment som fortsätter på det buffrade): oförändrat, bild för bild
  assert.deepEqual(packets(await fetchSeg(seg), 'v:0'), pr);
});

t('ra gäller bara TS-remux: omkodade segment är oförändrade', async () => {
  const P = await playlist('force=transcode&q=360');
  assert.equal(P.pb.mode, 'transcode');
  const seg = P.segs[1];
  const a = fs.readFileSync(await fetchSeg(seg)), b = fs.readFileSync(await fetchSeg(seg, 0));
  assert.ok(a.equals(b), 'samma byte med och utan ra');
  assert.equal(strict(await fetchSeg(seg)).ok, true, 'omkodningen har stängd GOP');
});

t('fortsätt mitt i (start=): segmentet där uppspelningen börjar går att avkoda med spelarens ra', async () => {
  const P = await playlist('force=hls&start=31');
  const i = P.segs.findIndex(s => s.start <= 31 && s.start + s.dur > 31);
  const at = H.randomAccess([], P.segs[i].start, 31);
  const u = new URL(H.randomAccessUrl(String(P.segs[i].url), at));
  assert.match(u.search, /[?&]ra=\d/);
  const f = await fetchSeg({ url: u });
  assert.deepEqual(strict(f), { ok: true, err: '' });
  assert.equal(leading(packets(f, 'v:0')), 0);
});

// ---------- servern känner igen öppen GOP (server/opengop.js) ----------
const rowOf = (file) => D.get('SELECT * FROM items WHERE path=?', file);
const info = async (row, q) => (await fetch(`${B}/api/items/${row.id}/playback?info=1&${q}`, { headers: A() })).json();

t('keyIsIdr: segmentet börjar på en IDR-bild (stängd GOP) eller på en vanlig I-bild (öppen GOP)', async () => {
  const at = (file, ss) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(ss), '-noaccurate_seek', '-i', file, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'h264_mp4toannexb,dump_extra=freq=keyframe', '-t', '0.5', '-f', 'mpegts', 'pipe:1']);
  assert.equal(keyIsIdr(at(CLOSED, 10.2)), true);
  assert.equal(keyIsIdr(at(FLAT, 10.2)), false);
  assert.equal(keyIsIdr(at(FLAT, 0)), true, 'första bilden i filen är alltid IDR');
  assert.equal(keyIsIdr(Buffer.alloc(188 * 3)), null);
  assert.equal(keyIsIdr(Buffer.from('hej')), null);
});

t('öppen GOP-provet: stängd GOP, öppen GOP där ra räcker, och öppen GOP som måste omkodas', async () => {
  for (const f of [FLAT, CLOSED]) assert.ok(rowOf(f), path.basename(f));
  const got = {};
  for (const [name, file] of [['closed', CLOSED], ['ra', FILM], ['tc', FLAT]]) {
    const row = rowOf(file);
    await st.computeKeyframes(row);
    got[name] = await st.probeGop(row); // samma prov som indexeringen startade (köas en gång)
    assert.equal(st.gopOf(row), got[name], 'svaret sparas');
    assert.equal(fs.readFileSync(path.join(D.CACHE, 'keyframes', `${row.id}-${row.mtime}.gop`), 'utf8'), got[name], 'sparas bredvid nyckelbilderna');
  }
  assert.deepEqual(got, { closed: 'closed', ra: 'ra', tc: 'tc' });
  // Ett prov per nyckelbild, i den ordning de görs: stängd GOP avgörs på två prov, 'tc' slutar vid första fel
  const kf = st.keyframesReady(rowOf(CLOSED)), calls = [];
  assert.equal(await og.classify(CLOSED, kf, 40, { sampleFn: async (f, t, n) => { calls.push(t); return og.sample(f, t, n); } }), 'closed');
  assert.equal(calls.length, 2);
  // Urvalet: jämnt fördelat, aldrig nyckelbilden vid 0, och runt en rapporterad position bara grannarna
  const list = Array.from({ length: 100 }, (_, i) => i * 2);
  const p = og.picks(list, 200);
  assert.equal(p.length, og.SAMPLES);
  assert.ok(p.every(([t, n]) => t >= 1 && t < 198.5 && n === t + 2));
  assert.deepEqual(og.picks(list, 200, { at: 31 }), [[30, 32], [32, 34]]);
  // Rapport vid en position: bara 'tc' kan komma ut, aldrig en friskförklaring
  assert.equal(await og.classify(FLAT, st.keyframesReady(rowOf(FLAT)), 40, { at: 21 }), 'tc');
  assert.equal(await og.classify(FILM, st.keyframesReady(rowOf(FILM)), 60, { at: 21 }), null);
});

t('webbspelaren (mse=1): öppen GOP som inte går att börja mitt i remuxas från början och omkodas vid Fortsätt titta – inte apparna eller Safari', async () => {
  const flat = rowOf(FLAT), open = rowOf(FILM), closed = rowOf(CLOSED);
  assert.equal(await st.probeGop(flat), 'tc');
  const k1 = st.keyframesReady(flat)[1];
  assert.ok(k1 > 1 && k1 < 3, `andra nyckelbilden ${k1}`);
  // Fall 1: från början (och före andra nyckelbilden) – remux, snabbast att starta; svaret säger att filen är tc
  for (const q of ['mse=1', `mse=1&start=${Math.floor(k1 - 1)}`]) {
    const a = await info(flat, q);
    assert.equal(a.mode, 'remux', q);
    assert.equal(a.gop, 'tc', `${q}: spelaren får veta att spolning kräver omkodning`);
  }
  // Fall 2: mitt i filen (Fortsätt titta) – omkodning direkt, utan fel först
  const web = await info(flat, 'mse=1&start=21');
  assert.equal(web.mode, 'transcode', 'webbspelaren: omkodning från början, utan fel först');
  assert.match(web.reasons.join(', '), /öppen GOP/);
  assert.equal(web.gop, undefined);
  assert.equal((await info(flat, `mse=1&start=${Math.ceil(k1)}`)).mode, 'transcode', 'från andra nyckelbilden');
  assert.equal(st.decide(flat, { ...st.parseCaps(new URLSearchParams('mse=1&start=21')) }).mode, 'transcode');
  assert.equal(st.decide(flat, { ...st.parseCaps(new URLSearchParams('mse=1')) }).gop, 'tc');
  // Apparna (ingen mse), Safari (nhls=1) och Chromecast: remux som förut – deras avkodare har inte felet
  assert.equal((await info(flat, 'start=21')).mode, 'remux');
  assert.equal((await info(flat, 'start=0')).gop, undefined, 'apparna får inget gop-fält');
  assert.equal((await info(flat, 'mse=1&nhls=1')).mode, 'remux');
  // Öppen GOP där ra räcker och stängd GOP: remux även i webben
  assert.equal((await info(open, 'mse=1&start=21')).mode, 'remux');
  assert.equal((await info(closed, 'mse=1')).mode, 'remux');
  // Rapport från webbspelaren om en fil som går att avkoda: servern provar själv och ändrar inget
  const r = await fetch(`${B}/api/stream/${open.id}/opengop`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ position: 21 }) });
  assert.equal(r.status, 202);
  assert.equal(await st.probeGop(open, { at: 21 }), null);
  assert.equal(st.gopOf(open), 'ra');
  assert.equal((await info(open, 'mse=1')).mode, 'remux');
});
