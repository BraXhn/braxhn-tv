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
  for (const [dur, hs] of [[120, 0], [120, 44], [120, 47.5], [120, 6], [50, 31]]) {
    const starts = st.transcodeStarts(dur, hs);
    for (let n = 0; n < starts.length; n++) {
      const rel = starts.slice(n).map(x => x - starts[n]);
      const got = keysOf(st.forcedKeys(rel), 25, dur - starts[n] - 0.5);
      assert.deepEqual(got.slice(0, rel.length), rel, `längd ${dur}, hs ${hs}, start vid ${starts[n]}`);
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
  // Utan start: som förut
  const P0 = await playlist('force=transcode&q=480');
  assert.ok(!P0.pb.url.includes('hs='));
  assert.deepEqual(P0.segs.slice(0, 5).map(s => s.start), [0, 2, 4, 6, 12]);
  // Fortsätt vid 43,7 s: B = 42
  const P = await playlist('force=transcode&q=480&start=43.7');
  assert.match(P.pb.url, /[?&]hs=43(&|$)/);
  assert.deepEqual(P.segs.map(s => s.start).filter(x => x >= 30 && x <= 60), [30, 36, 42, 44, 46, 48, 54, 60]);
  const at = (x) => P.segs.find(s => s.start === x);
  // Spelaren hämtar segmentet där 43,7 ligger (42–44) – ffmpeg är redan förstartad där
  const t0 = Date.now();
  await check(at(42), 'segment 42');
  const ms = Date.now() - t0;
  await check(at(44), 'segment 44'); await check(at(46), 'segment 46'); await check(at(48), 'segment 48 (6 s)'); await check(at(54), 'segment 54');
  assert.ok(ms < 5000, `första segmentet på ${ms} ms`);
  // Bakåt till före de korta segmenten och spela igenom: 30, 36 (6 s), sedan 42, 44, 46 (2 s) i samma körning
  for (const x of [30, 36, 42, 44, 46, 48]) await check(at(x), `genomspelning ${x}`);
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
  await check(P.segs.find(x => x.start === 42), 'förvärmt segment 42');
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
