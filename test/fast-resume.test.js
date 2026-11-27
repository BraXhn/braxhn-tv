// Snabb start mitt i filen: korta segment där uppspelningen börjar (hs i strömmens adress, från start= i /playback).
// Omkodning: gränserna … G, B, B+2, B+4, B+6 … och tvingade nyckelbilder exakt där – oavsett var ffmpeg startar
// (på B, mitt i de korta segmenten eller före dem och spelar igenom). Remux: korta segment från nyckelbilden före hs.
// Segmenten kontrolleras med ffprobe: börjar på en nyckelbild vid sin gräns och är så långa som spellistan säger.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-resume-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.HWACCEL = 'none';
fs.mkdirSync(path.join(MEDIA, 'Filmer'), { recursive: true });
const FILM = path.join(MEDIA, 'Filmer', 'Resume Film (2020).mkv');
// Nyckelbild varje sekund (som många riktiga filer), AC-3 så att remuxen konverterar ljudet
if (hasFfmpeg) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '80',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-x264-params', 'keyint=24:min-keyint=24:scenecut=0', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', FILM]);

// Tyngre fil för tidsmåttet (720p, 10 bitar – omkodas alltid, som en riktig film där kodningen tar tid)
const HEAVY = path.join(MEDIA, 'Filmer', 'Tung Film (2021).mkv');
if (hasFfmpeg) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24,noise=alls=8:allf=t', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '20',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', HEAVY]);

const D = await import('../server/db.js');
const sc = await import('../server/scanner.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const st = await import('../server/stream.js');
const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

test('omkodningens gränser: som förut utan hs, korta segment vid hs', () => {
  assert.deepEqual(st.transcodeStarts(40), [0, 2, 4, 6, 12, 18, 24, 30, 36]);
  assert.deepEqual(st.transcodeStarts(40, 5), st.transcodeStarts(40), 'de första sekunderna har redan korta segment');
  assert.deepEqual(st.transcodeStarts(60, 18), [0, 2, 4, 6, 12, 18, 20, 22, 24, 30, 36, 42, 48, 54]);
  assert.deepEqual(st.transcodeStarts(60, 23.9), [0, 2, 4, 6, 12, 18, 22, 24, 26, 28, 34, 40, 46, 52, 58], 'B = jämn sekund före hs, rutnätet fortsätter från B');
  assert.deepEqual(st.transcodeStarts(60, 6), [0, 2, 4, 6, 8, 10, 12, 18, 24, 30, 36, 42, 48, 54]);
  assert.deepEqual(st.transcodeStarts(40, 39), st.transcodeStarts(40), 'för nära slutet');
  // h1 (processorn): första segmentet där uppspelningen börjar är 1 s, sedan som förut
  assert.deepEqual(st.transcodeStarts(40, 0, true), [0, 1, 2, 4, 6, 12, 18, 24, 30, 36]);
  assert.deepEqual(st.transcodeStarts(60, 18, true), [0, 1, 2, 4, 6, 12, 18, 19, 20, 22, 24, 30, 36, 42, 48, 54]);
  assert.deepEqual(st.transcodeStarts(60, 23.9, true), [0, 1, 2, 4, 6, 12, 18, 22, 23, 24, 26, 28, 34, 40, 46, 52, 58], 'hs udda: segmentet där uppspelningen börjar (23–24) är 1 s');
  assert.deepEqual(st.transcodeStarts(1.2, 0, true), [0], 'kort fil: ett segment');
  for (const hs of [7, 13, 100, 3599, 7000]) {
    const s = st.transcodeStarts(7200, hs), b = Math.floor(hs / 2) * 2;
    assert.ok(s.includes(b) && s.includes(b + 2) && s.includes(b + 4) && s.includes(b + 6), `hs ${hs}`);
    for (let i = 1; i < s.length; i++) assert.ok(s[i] - s[i - 1] >= 2 && s[i] - s[i - 1] <= 6, `hs ${hs}: ${s[i - 1]}→${s[i]}`);
  }
});

test('tvingade nyckelbilder hamnar exakt på gränserna, var ffmpeg än startar', () => {
  // Uttrycket räknas som ffmpeg gör: för varje bild, i ordning, med n_forced = antal tvingade hittills
  const keysOf = (expr, fps, secs) => {
    const f = new Function('t', 'n_forced', 'const gte=(a,b)=>a>=b?1:0, lt=(a,b)=>a<b?1:0, If=(c,a,b)=>c?a:b; return ' + expr.replace(/^expr:/, '').replace(/if\(/g, 'If('));
    const out = []; let n = 0;
    for (let i = 0; i < secs * fps; i++) { const tt = i / fps; if (f(tt, n)) { out.push(Math.round(tt * 1000) / 1000); n++; } }
    return out;
  };
  for (const [dur, hs, h1] of [[120, 0], [120, 44], [120, 47.5], [120, 6], [50, 31], [120, 0, true], [120, 44, true], [120, 47.5, true], [120, 6, true], [50, 31, true]]) {
    const starts = st.transcodeStarts(dur, hs, h1);
    for (let n = 0; n < starts.length; n++) {
      const rel = starts.slice(n).map(x => x - starts[n]);
      const got = keysOf(st.forcedKeys(rel), 25, dur - starts[n] - 0.5);
      assert.deepEqual(got.slice(0, rel.length), rel, `längd ${dur}, hs ${hs}${h1 ? ', h1' : ''}, start vid ${starts[n]}`);
    }
  }
  // Från början utan hs: samma mönster som alltid (0, 2, 4, 6, 12 …)
  assert.deepEqual(keysOf(st.forcedKeys(st.transcodeStarts(7200)), 24, 40), [0, 2, 4, 6, 12, 18, 24, 30, 36]);
});

let it, tok;
const A = () => ({ authorization: 'Bearer ' + tok });
async function playlist(q) {
  const pb = await (await fetch(`${B}/api/items/${it.id}/playback?${q}`, { headers: A() })).json();
  const idx = new URL(pb.url.replace('master.m3u8', 'index.m3u8'), B);
  const pl = await (await fetch(idx, { headers: A() })).text();
  const segs = []; let at = 0;
  for (const m of pl.matchAll(/#EXTINF:([\d.]+),\n(\S+)/g)) { segs.push({ start: at, dur: +m[1], url: new URL(m[2], idx) }); at += +m[1]; }
  return { pb, idx, segs };
}
/** Hämtar segmentet och läser bildernas tider och nyckelbilder med ffprobe */
async function probe(seg, name) {
  const r = await fetch(seg.url, { headers: A() });
  assert.equal(r.status, 200, name);
  const f = path.join(ROOT, 'probe.ts'); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  const rows = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', f]).toString().trim().split('\n').map(l => l.split(','));
  const pts = rows.map(r => +r[0]).sort((a, b) => a - b);
  return { first: pts[0], last: pts.at(-1), n: rows.length, key: rows[0][1].startsWith('K'), keys: rows.filter(r => r[1].startsWith('K')).length };
}
async function check(seg, name, { tol = 0.05 } = {}) {
  const p = await probe(seg, name);
  assert.ok(p.key, `${name}: börjar på en nyckelbild`);
  assert.ok(Math.abs(p.first - seg.start) <= tol, `${name}: första bilden vid ${p.first}, väntat ${seg.start}`);
  assert.ok(Math.abs(p.n / 24 - seg.dur) <= 0.1, `${name}: ${p.n} bilder för ${seg.dur} s`);
  return p;
}

t('omkodning: /playback med start= ger korta segment där, och segmenten stämmer – start på B, mitt i och före', async () => {
  const U = Number(D.run('INSERT INTO users(name,pass,is_admin,created) VALUES(?,?,1,0)', 'anna', await auth.hashPw('Snabb-start-2026!')).lastInsertRowid);
  tok = auth.createSession(U, 'app');
  const LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", path.join(MEDIA, 'Filmer')).lastInsertRowid);
  await sc.scan(LIB);
  it = D.get('SELECT * FROM items WHERE path=?', FILM);
  assert.ok(it?.duration > 70);
  await st.computeKeyframes(it);
  // Utan start: korta segment från början – det första 1 s med processorn (h1=1 i adressen, HWACCEL=none här)
  const P0 = await playlist('force=transcode&q=480');
  assert.ok(!P0.pb.url.includes('hs='));
  assert.match(P0.pb.url, /[?&]h1=1(&|$)/);
  assert.deepEqual(P0.segs.slice(0, 6).map(s => s.start), [0, 1, 2, 4, 6, 12]);
  await check(P0.segs[0], 'segment 0 (1 s)'); await check(P0.segs[1], 'segment 1 (1 s)'); await check(P0.segs[2], 'segment 2 (2 s)'); await check(P0.segs[4], 'segment 6 (6 s)');
  // Fortsätt vid 43,7 s: B = 42, segmentet där 43,7 ligger (43–44) är 1 s
  const P = await playlist('force=transcode&q=480&start=43.7');
  assert.match(P.pb.url, /[?&]hs=43(&|$)/);
  assert.deepEqual(P.segs.map(s => s.start).filter(x => x >= 30 && x <= 60), [30, 36, 42, 43, 44, 46, 48, 54, 60]);
  const at = (x) => P.segs.find(s => s.start === x);
  // Spelaren hämtar segmentet där 43,7 ligger (43–44) – ffmpeg är redan förstartad där
  const t0 = Date.now();
  await check(at(43), 'segment 43');
  const ms = Date.now() - t0;
  await check(at(44), 'segment 44'); await check(at(46), 'segment 46'); await check(at(48), 'segment 48 (6 s)'); await check(at(54), 'segment 54');
  assert.ok(ms < 5000, `första segmentet på ${ms} ms`);
  // Bakåt till före de korta segmenten och spela igenom: 30, 36 (6 s), sedan 42, 43 (1 s), 44, 46 (2 s) i samma körning
  for (const x of [30, 36, 42, 43, 44, 46, 48]) await check(at(x), `genomspelning ${x}`);
  // Hopp rakt in i de korta segmenten (44) efter att ha varit någon annanstans
  await check(at(0), 'segment 0'); await check(at(44), 'hopp till 44'); await check(at(46), 'sedan 46'); await check(at(48), 'sedan 48');
});

t('remux: korta segment från början och från nyckelbilden före start=, och de stämmer', async () => {
  const P0 = await playlist('force=hls');
  assert.equal(P0.pb.mode, 'remux', (P0.pb.reasons || []).join(', '));
  assert.ok(P0.segs[0].dur <= 2.01 && P0.segs[1].dur <= 2.01, `korta första segment: ${P0.segs.slice(0, 4).map(s => s.dur)}`);
  assert.ok(P0.segs.find(s => s.start >= 12).dur >= 5.9, 'sedan vanliga segment');
  const P = await playlist('force=hls&start=40.4');
  const i = P.segs.findIndex(s => s.start <= 40.4 && s.start + s.dur > 40.4);
  assert.ok(P.segs[i].start >= 39.9 && P.segs[i].dur <= 2.01, `segmentet vid 40,4 s: ${P.segs[i].start} + ${P.segs[i].dur}`);
  assert.ok(P.segs[i - 1].dur >= 2 && P.segs[i - 1].start < 40, 'segmentet före slutar vid nyckelbilden före start');
  assert.ok(Math.abs(P.segs.reduce((n, s) => n + s.dur, 0) - it.duration) < 0.01, 'hela filmen täcks');
  // Remux kopierar bilden: B-bildernas fördröjning ger upp till ~0,2 s senare första PTS (känd, se arkitektur.md)
  for (const k of [i, i + 1, i + 2]) await check(P.segs[k], `remux segment ${k}`, { tol: 0.25 });
  await check(P.segs[i - 1], 'remux segmentet före', { tol: 0.25 });
  await check(P0.segs[0], 'remux segment 0', { tol: 0.25 });
});

// ---------- förvärmning innan klicket (/playback?warm=1) ----------
const sessions = () => [...st._slots.sessions.values()];
const pidOf = (url) => new URL(url, B).searchParams.get('pid');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJson = async (q) => (await fetch(`${B}/api/items/${it.id}/playback?${q}`, { headers: A() })).json();

t('förvärmning: strömmen startas vid warm=1, pausas efter några segment och tas över av uppspelningen', async () => {
  const act = await import('../server/activity.js');
  // Spelaren från förra testet stängs (som /stop) – en pågående omkodning hindrar annars förvärmningen
  const stopAll = () => { for (const x of sessions()) st.stopUserSessions(it.id, x.user); for (const x of sessions()) x.reqAt = 0; };
  stopAll();
  const plays0 = D.get('SELECT COUNT(*) AS n FROM plays').n, active0 = act.listActive().length;
  // Webbspelaren skickar inget ljudspår vid förvärmningen – servern väljer samma förval som spelaren sedan skickar
  const w = await getJson('force=transcode&q=480&start=43.7&warm=1');
  assert.deepEqual(w, { warm: true, mode: 'transcode' });
  assert.equal(D.get('SELECT COUNT(*) AS n FROM plays').n, plays0, 'förvärmningen är ingen uppspelning (historik)');
  assert.equal(act.listActive().length, active0, 'och syns inte som "spelas nu"');
  const s = sessions().find(x => x.warm);
  assert.ok(s?.proc, 'ffmpeg är igång');
  for (let i = 0; i < 80 && !s.paused; i++) await sleep(100);
  assert.ok(s.paused, 'pausad efter de första segmenten');
  const files = fs.readdirSync(s.dir).filter(f => /^seg_/.test(f)).length;
  assert.ok(files >= 2 && files <= st.WARM_AHEAD + 2, `${files} segment förberedda`);
  // Uppspelningen med samma val (spelaren skickar nu det förvalda ljudspåret) tar över strömmen
  const audio = JSON.parse(it.streams).find(x => x.type === 'audio').index;
  const P = await playlist(`force=transcode&q=480&start=43.7&audio=${audio}`);
  assert.equal(pidOf(P.pb.url), s.d.pid, 'samma ström som förvärmdes');
  assert.ok(!s.warm && s.warmed && !s.paused);
  const t0 = Date.now();
  await check(P.segs.find(x => x.start === 43), 'förvärmt segment 43 (där 43,7 ligger)');
  assert.ok(Date.now() - t0 < 400, `segmentet var redan klart (${Date.now() - t0} ms)`);
  await check(P.segs.find(x => x.start === 44), 'segment 44'); await check(P.segs.find(x => x.start === 48), 'segment 48');
  assert.ok(act.listActive().some(x => x.itemId === it.id));
});

t('förvärmning: andra val vid uppspelningen ger en egen ström, och en ny förvärmning ersätter den förra', async () => {
  for (const x of sessions()) { st.stopUserSessions(it.id, x.user); x.reqAt = 0; }
  assert.equal((await getJson('force=transcode&q=480&start=20&warm=1')).warm, true);
  const w1 = sessions().find(x => x.warm);
  // Samma profil pekar på en annan knapp: bara en förvärmning i taget
  assert.equal((await getJson('force=hls&start=30&warm=1')).warm, true);
  assert.ok(!sessions().includes(w1) && !w1.proc, 'den förra är stoppad och borttagen');
  const w2 = sessions().find(x => x.warm);
  assert.equal(w2.d.mode, 'remux');
  // Uppspelningen väljer en annan kvalitet: egen ström, förvärmningen tas bort
  const P = await playlist('force=transcode&q=720&start=30');
  assert.notEqual(pidOf(P.pb.url), w2.d.pid);
  await check(P.segs.find(x => x.start === 30), 'egen ström');
  assert.ok(!sessions().some(x => x.warm), 'ingen förvärmning kvar');
  // Direktuppspelning behöver ingen ström
  const d = await getJson('warm=1&c=mkv&v=h264&a=ac3,aac');
  if (d.mode === 'direct') assert.equal(d.warm, false);
  // info=1 och vanliga anrop påverkas inte av en förvärmning som aldrig tas över
  assert.equal((await getJson('force=hls&start=50&warm=1')).warm, true);
  const info = await getJson('force=hls&info=1');
  assert.equal(info.mode, 'remux');
  assert.ok(sessions().some(x => x.warm), 'info=1 tar inte över förvärmningen');
});

t('Safaris egen HLS (iPhone): startpositionen står i spellistorna, och strömmen förbereds där', async () => {
  for (const x of sessions()) { st.stopUserSessions(it.id, x.user); x.reqAt = 0; }
  const text = async (u) => (await fetch(new URL(u, B), { headers: A() })).text();
  // nhls=1 med start: EXT-X-START i både huvudlistan och medialistan, och korta segment vid positionen
  const pb = await getJson('force=hls&nhls=1&start=40.4');
  assert.match(pb.url, /[?&]xs=40(&|$)/); assert.match(pb.url, /[?&]hs=40(&|$)/);
  const master = await text(pb.url);
  assert.match(master, /#EXT-X-START:TIME-OFFSET=40,PRECISE=YES/);
  const media = await text(pb.url.replace('master.m3u8', 'index.m3u8'));
  assert.match(media, /#EXT-X-START:TIME-OFFSET=40,PRECISE=YES/);
  // ffmpeg är förstartad på segmentet där 40 s ligger – inte på segment 0
  const s = sessions().find(x => x.d.pid === pidOf(pb.url));
  assert.ok(s?.proc && s.segs[s.start].start >= 39 && s.segs[s.start].start <= 40.4, `förstartad vid ${s?.segs?.[s.start]?.start}`);
  // Andra spelare (hls.js, apparna) sätter positionen själva: ingen tagg
  const other = await getJson('force=hls&start=40.4');
  assert.ok(!other.url.includes('xs='));
  assert.ok(!(await text(other.url)).includes('EXT-X-START'));
  // Från början: ingen tagg
  const zero = await getJson('force=hls&nhls=1');
  assert.ok(!(await text(zero.url)).includes('EXT-X-START'));
});

t('Apple TV (utan nhls): appen lägger själv till xs, och spellistorna får EXT-X-START utan att sessionen byts', async () => {
  for (const x of sessions()) { st.stopUserSessions(it.id, x.user); x.reqAt = 0; }
  const text = async (u) => (await fetch(new URL(u, B), { headers: A() })).text();
  // Som en omstart vid spolning i tvOS-appen: start och prev, inget nhls (då skulle Dolby Digital i TS bli AAC)
  const pb = await getJson('force=transcode&start=40.4&prev=0123abcd');
  assert.ok(!pb.url.includes('xs='), 'servern lägger inte till xs utan nhls');
  // SeekCore.withStart i apps/apple/Shared/SeekCore.swift: xs=<hela sekunder> sist i adressen
  const url = pb.url + '&xs=40';
  const master = await text(url);
  assert.match(master, /#EXT-X-START:TIME-OFFSET=40,PRECISE=YES/);
  const media = await text(url.replace('master.m3u8', 'index.m3u8'));
  assert.match(media, /#EXT-X-START:TIME-OFFSET=40,PRECISE=YES/);
  // Segmenten bär med sig xs men hör till samma session (xs ingår inte i nyckeln): ffmpeg förstartad vid 40 s, korta segment där
  const seg = media.split('\n').find(l => l.startsWith('seg-'));
  assert.match(seg, /[?&]xs=40(&|$)/);
  const own = sessions().filter(x => x.d.pid === pidOf(pb.url));
  assert.equal(own.length, 1, 'en session för strömmen');
  assert.ok(own[0].proc && own[0].segs[own[0].start].start >= 39 && own[0].segs[own[0].start].start <= 40.4, `förstartad vid ${own[0].segs?.[own[0].start]?.start}`);
  assert.ok(own[0].segs.some(s => s.start === 40 && s.dur <= 1.01), 'kort segment vid målet');
});

t('stopp medan spelaren väntar på ett segment: ffmpeg startas inte om efteråt', async () => {
  for (const x of sessions()) { st.stopUserSessions(it.id, x.user); x.reqAt = 0; }
  const P = await playlist('force=transcode&q=480');
  const s = sessions().find(x => x.d.pid === pidOf(P.pb.url));
  for (let i = 0; i < 50 && !s.proc; i++) await sleep(20);
  st.stopUserSessions(it.id, s.user);
  // Segmentet längst bort: förstarten (från 0) täcker det inte – begäran startar en egen körning och väntar på den
  const far = P.segs.at(-2);
  const pending = fetch(far.url, { headers: A() });
  for (let i = 0; i < 100 && !s.proc; i++) await sleep(5);
  assert.ok(s.proc, 'begäran startade ffmpeg');
  // Långsam omkodning (som 4K): segmentet blir inte klart innan stoppet
  s.proc.kill('SIGSTOP');
  // Spelaren stängs (som /stop) medan begäran fortfarande väntar – avbrottet av begäran kan komma fram senare
  st.stopUserSessions(it.id, s.user, s.d.pid);
  const r = await pending;
  // Förut startade den väntande begäran om ffmpeg (som sedan kodade vidare i upp till en minut och tog processorn från
  // nästa uppspelning) och fick segmentet
  assert.notEqual(r.status, 200, 'den väntande begäran avbryts i stället för att starta om ffmpeg');
  await sleep(200);
  assert.ok(!s.proc, 'ingen ffmpeg kvar efter stoppet');
  // En ny begäran efter stoppet fungerar som vanligt
  await check(P.segs[1], 'nytt segment efter stoppet');
  st.stopUserSessions(it.id, s.user);
});

// Spolning utanför bufferten i en omkodning: webbspelaren startar om strömmen vid målet (/playback med start= och
// prev=<pid för strömmen som spelades>, video.js seekRestarts) i stället för att vänta på hela 6 s-segmentet
t('spolning i en omkodning: ny ström med korta segment vid målet, segmenten stämmer, och den gamla stoppas', async () => {
  for (const x of sessions()) { st.stopUserSessions(it.id, x.user); x.reqAt = 0; }
  const P0 = await playlist('force=transcode&q=480');
  const pid0 = pidOf(P0.pb.url);
  const r0 = await fetch(P0.segs[1].url, { headers: A() }); await r0.arrayBuffer();
  // Servern säger vilka segment som är klara i körningen – spelaren spolar dit som vanligt
  assert.match(r0.headers.get('x-seg-ready') || '', /^0-\d+$/, 'X-Seg-Ready: ' + r0.headers.get('x-seg-ready'));
  const old = sessions().find(x => x.d.pid === pid0);
  assert.ok(old?.proc, 'den första strömmen kodar');
  // Spolning till 57,4 s: i den gamla spellistan ligger målet mitt i 6 s-segmentet 54–60
  assert.equal(P0.segs.find(x => x.start <= 57.4 && x.start + x.dur > 57.4).dur, 6);
  const P = await playlist(`force=transcode&q=480&start=57.4&prev=${pid0}`);
  assert.match(P.pb.url, /[?&]hs=57(&|$)/); assert.match(P.pb.url, /[?&]h1=1(&|$)/);
  assert.notEqual(pidOf(P.pb.url), pid0, 'en ny ström med egen spellista – den gamla ändras inte');
  // Den gamla strömmen är stoppad och borta, och en sen begäran till den startar ingen ny ffmpeg
  assert.ok(!old.proc && !sessions().includes(old), 'den gamla strömmen är stoppad');
  const late = await fetch(P0.segs.at(-2).url, { headers: A() }); await late.arrayBuffer();
  assert.equal(late.status, 409, 'begäran till den gamla strömmen');
  assert.ok(!sessions().some(x => x.d.pid === pid0), 'ingen ny session för den gamla strömmen');
  // Korta segment från målet: … 48, 54, 56, 57 (1 s, där 57,4 ligger), 58, 60 (2 s), 62 (6 s) …
  assert.deepEqual(P.segs.map(x => x.start).filter(x => x >= 48 && x <= 68), [48, 54, 56, 57, 58, 60, 62, 68]);
  const at = (x) => P.segs.find(y => y.start === x);
  assert.equal(at(57).dur, 1);
  // ffmpeg är förstartad där – och segmenten är så långa som spellistan säger, med nyckelbild på gränsen
  const s = sessions().find(x => x.d.pid === pidOf(P.pb.url));
  assert.equal(s.segs[s.start].start, 57, 'förstartad på segmentet med målet');
  const t0 = Date.now();
  await check(at(57), 'segment 57 (1 s)');
  const ms = Date.now() - t0;
  await check(at(58), 'segment 58'); await check(at(60), 'segment 60'); await check(at(62), 'segment 62 (6 s)');
  // Bakåt i den nya strömmen: före de korta segmenten (vanliga 6 s) och genomspelning in i dem
  for (const x of [48, 54, 56, 57]) await check(at(x), `bakåt ${x}`);
  assert.ok(ms < 5000, `första segmentet efter spolningen på ${ms} ms`);
  // prev gäller bara den egna uppspelningen: en annan pid (annan enhet) stoppas inte
  const Q = await playlist('force=transcode&q=480&start=30');
  const other = sessions().find(x => x.d.pid === pidOf(Q.pb.url));
  await playlist(`force=transcode&q=480&start=40&prev=${pidOf(P.pb.url)}`);
  assert.ok(sessions().includes(other), 'den andra uppspelningen finns kvar');
  for (const x of sessions()) st.stopUserSessions(it.id, x.user);
});

// Expo ser inte X-Seg-Ready: /hls/ready svarar samma sak utan att röra strömmen (ingen session, ingen ffmpeg)
t('/hls/ready: samma segment som X-Seg-Ready, i sekunder, utan sidoeffekter och med strömmens behörighet', async () => {
  for (const x of sessions()) { st.stopUserSessions(it.id, x.user); x.reqAt = 0; }
  const P = await playlist('force=transcode&q=480');
  const pid = pidOf(P.pb.url);
  // Strömmens adress utan dess egen mediatoken (t), så att behörigheten prövas med det som skickas här
  const readyUrl = (u, t = '') => { const x = new URL(u.replace('/hls/master.m3u8', '/hls/ready'), B); x.searchParams.delete('t'); if (t) x.searchParams.set('t', t); return x; };
  const ready = async (headers = A(), url = readyUrl(P.pb.url)) => { const r = await fetch(url, { headers }); return { status: r.status, body: r.status === 200 ? await r.json() : null }; };
  const r1 = await fetch(P.segs[2].url, { headers: A() }); await r1.arrayBuffer();
  const s = sessions().find(x => x.d.pid === pid);
  assert.ok(s?.proc, 'strömmen kodar');
  const live = await ready();
  assert.equal(live.status, 200);
  assert.equal(live.body.mode, 'transcode'); assert.equal(live.body.encoding, true);
  assert.equal(live.body.segs[0], 0); assert.ok(live.body.segs[1] >= 2, JSON.stringify(live.body));
  // Stoppad: tillståndet står still, så rubriken och svaret kan jämföras exakt
  st.stopUserSessions(it.id, s.user, pid);
  const r2 = await fetch(P.segs[0].url, { headers: A() }); await r2.arrayBuffer();
  const hdr = r2.headers.get('x-seg-ready');
  assert.match(hdr || '', /^0-\d+$/);
  const nSess = sessions().length, last = s.last, reqAt = s.reqAt, dirs = fs.readdirSync(process.env.TRANSCODE_DIR).length;
  const r = await ready();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.segs, hdr.split('-').map(Number), 'samma segment som X-Seg-Ready');
  const [lo, hi] = r.body.segs;
  assert.equal(r.body.from, P.segs[lo].start);
  assert.ok(Math.abs(r.body.to - (P.segs[hi].start + P.segs[hi].dur)) < 0.01, `till ${r.body.to}`);
  assert.equal(r.body.encoding, false);
  // Andra pid (ingen session, en annan uppspelning) och en spelare som frågar ofta: ingenting startas eller skapas
  for (let i = 0; i < 5; i++) await ready(A(), readyUrl(P.pb.url.replace(`pid=${pid}`, 'pid=0badc0de')));
  const none = await ready(A(), readyUrl(P.pb.url.replace(`pid=${pid}`, 'pid=0badc0de')));
  assert.deepEqual(none.body, { mode: null, from: null, to: null, encoding: false, segs: null });
  await sleep(300);
  assert.ok(!s.proc, 'ingen ffmpeg startades');
  assert.ok(!sessions().some(x => x.proc), 'ingen annan ffmpeg heller');
  assert.equal(sessions().length, nSess, 'ingen ny session');
  assert.equal(fs.readdirSync(process.env.TRANSCODE_DIR).length, dirs, 'ingen ny mapp');
  assert.equal(s.last, last, 'sessionens liv förlängs inte'); assert.equal(s.reqAt, reqAt);
  // Behörighet: utan inloggning 401, mediatoken för titeln går (som strömmens t=), för en annan titel 401
  assert.equal((await ready({})).status, 401, 'utan inloggning');
  const heavy = D.get('SELECT * FROM items WHERE path=?', HEAVY);
  const mine = auth.createSession(s.user, 'media', { item: it.id }), other = auth.createSession(s.user, 'media', { item: heavy.id });
  const viaTok = await ready({}, readyUrl(P.pb.url, mine));
  assert.equal(viaTok.status, 200); assert.deepEqual(viaTok.body.segs, r.body.segs);
  assert.equal((await ready({}, readyUrl(P.pb.url, other))).status, 401, 'token för en annan titel');
  // En annan användare med samma pid ser inte strömmen
  const U2 = Number(D.run('INSERT INTO users(name,pass,is_admin,created) VALUES(?,?,1,0)', 'bertil', await auth.hashPw('Annan-anvandare-2026!')).lastInsertRowid);
  const tok2 = auth.createSession(U2, 'app');
  const foreign = await ready({ authorization: 'Bearer ' + tok2 });
  assert.equal(foreign.status, 200); assert.equal(foreign.body.segs, null, 'en annan användares ström');
  // Spolning med omstart (prev): den gamla strömmen finns inte längre
  await playlist(`force=transcode&q=480&start=40&prev=${pid}`);
  assert.equal((await ready()).body.segs, null, 'ersatt ström');
  for (const x of sessions()) st.stopUserSessions(it.id, x.user);
});

t('första segmentet vid omkodning är 1 s och kommer fortare än med 2 s (tidsmått, omväxlande körningar)', async () => {
  const heavy = D.get('SELECT * FROM items WHERE path=?', HEAVY);
  assert.ok(heavy?.duration > 15, 'den tunga filen är inläst');
  const stopAll = () => { for (const x of sessions()) { st.stopUserSessions(heavy.id, x.user); st.stopUserSessions(it.id, x.user); x.reqAt = 0; } };
  // Tid från begäran av första segmentet (ffmpeg startas då) tills det är hämtat; old = samma ström utan h1 (2 s).
  // Förstarten från /playback stoppas i båda fallen, så att de mäts likadant
  const first = async (old) => {
    stopAll();
    const pb = await (await fetch(`${B}/api/items/${heavy.id}/playback?force=transcode&q=orig`, { headers: A() })).json();
    stopAll(); await sleep(150);
    const u = new URL(pb.url.replace('master.m3u8', 'seg-0.ts'), B);
    assert.equal(u.searchParams.get('h1'), '1');
    if (old) u.searchParams.delete('h1');
    const t0 = performance.now();
    const r = await fetch(u, { headers: A() });
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 200);
    return { ms: performance.now() - t0, buf };
  };
  const a = [], b = [];
  for (let i = 0; i < 3; i++) { a.push(await first(false)); b.push(await first(true)); }
  stopAll();
  const med = (x) => x.map(y => y.ms).sort((p, q) => p - q)[1];
  // Första segmentet innehåller 1 s bild (24 bilder) i stället för 2 s
  const f = path.join(ROOT, 'forsta.ts'); fs.writeFileSync(f, a[0].buf);
  const n = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f]).toString().trim().split(/\s+/)[0];
  assert.equal(+n, 24, `${n} bilder i första segmentet`);
  const ny = med(a), gammal = med(b);
  console.log(`första segmentet (720p, 10 bitar → H.264): 1 s ${Math.round(ny)} ms, 2 s ${Math.round(gammal)} ms`);
  assert.ok(ny < gammal, `1 s första segment (${Math.round(ny)} ms) ska komma före 2 s (${Math.round(gammal)} ms)`);
  assert.ok(ny < 4000, `första segmentet på ${Math.round(ny)} ms`);
});

test('väntan på ett segment vaknar när ffmpeg skapar nästa fil, inte först efter tidsgränsen', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'vakna-'));
  const s = { dir };
  // Ny fil efter 30 ms: väckt långt före tidsgränsen (2 s)
  let t0 = performance.now();
  setTimeout(() => fs.writeFileSync(path.join(dir, 'seg_00001.ts'), 'x'), 30);
  await st._segs.dirChange(s, 2000, true);
  const woke = performance.now() - t0;
  assert.ok(woke < 1000, `vaknade efter ${Math.round(woke)} ms`);
  // En fil som bara växer väcker inte väntan på nästa segment (newFile), men tidsgränsen gäller
  t0 = performance.now();
  const iv = setInterval(() => fs.appendFileSync(path.join(dir, 'seg_00001.ts'), 'y'), 10);
  await st._segs.dirChange(s, 150, true);
  clearInterval(iv);
  assert.ok(performance.now() - t0 >= 140, 'växande fil väcker inte');
  // Mappen saknas (borttagen session): tidsgränsen gäller som förut
  t0 = performance.now();
  await st._segs.dirChange({ dir: path.join(dir, 'finns-inte') }, 60, true);
  assert.ok(performance.now() - t0 >= 50);
});
