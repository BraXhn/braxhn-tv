// Ljudanalys och låtradio (server/sonic-dsp.js, server/sonic.js): FFT, tempo mot klickspår med känt tempo,
// att lika ljud hamnar nära varandra, låtradions regler, ljudresan, stationerna, smarta spellistor med tempo/energi,
// prestanda för närmaste granne över 100 000 vektorer och API:t mot en riktig server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-sonic-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasFlite = hasFfmpeg && /\bflite\b/.test(spawnSync('ffmpeg', ['-hide_banner', '-filters']).stdout?.toString() || '');
const tf = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

const { run, all, get } = await import('../server/db.js');
const DSP = await import('../server/sonic-dsp.js');
const sonic = await import('../server/sonic.js');
const S = await import('../server/smartlists.js');
const L = await import('../server/listening.js');
let srv;
after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

// ffmpeg-källor (lavfi) → fil
const MEDIA = path.join(ROOT, 'media');
function makeFile(rel, lavfi, secs = 30, meta = {}) {
  const f = path.join(MEDIA, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', lavfi, '-t', String(secs), ...Object.entries(meta).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]),
    '-ar', '22050', '-ac', '1', '-c:a', 'flac', f]);
  return f;
}
const click = (bpm, hz = 1500) => `aevalsrc=if(lt(mod(t\\,${60 / bpm})\\,0.015)\\,sin(2*PI*${hz}*t)\\,0):s=22050`;
const groove = (bpm, root = 220) => `aevalsrc=0.5*exp(-30*mod(t\\,${60 / bpm}))*sin(2*PI*60*t)+0.1*exp(-60*mod(t\\,${30 / bpm}))*(random(0)*2-1)+0.12*(sin(2*PI*${root}*t)+sin(2*PI*${root * 1.26}*t)+sin(2*PI*${root * 1.5}*t)):s=22050`;
const calm = (root = 220) => `aevalsrc=0.1*(sin(2*PI*${root}*t)+sin(2*PI*${root * 1.26}*t)+sin(2*PI*${root * 1.5}*t))*(0.7+0.3*sin(2*PI*0.2*t)):s=22050`;

// ---------------- FFT ----------------
test('FFT: samma resultat som en direkt DFT, ren ton hamnar i rätt bin', () => {
  const n = 64, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + (i % 5) * 0.1; }
  const r0 = Float64Array.from(re);
  DSP.fft(re, im);
  for (let k = 0; k < n; k++) {
    let a = 0, b = 0;
    for (let t = 0; t < n; t++) { a += r0[t] * Math.cos(-2 * Math.PI * k * t / n); b += r0[t] * Math.sin(-2 * Math.PI * k * t / n); }
    assert.ok(Math.abs(a - re[k]) < 1e-9 && Math.abs(b - im[k]) < 1e-9, `bin ${k}`);
  }
  const N = 1024, x = new Float64Array(N), y = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * 37 * i / N);
  DSP.fft(x, y);
  let best = 0; for (let k = 1; k < N / 2; k++) if (Math.hypot(x[k], y[k]) > Math.hypot(x[best], y[best])) best = k;
  assert.equal(best, 37);
  assert.throws(() => DSP.fft(new Float64Array(100), new Float64Array(100)), /tvåpotens/);
});

// ---------------- tempo och egenskaper ----------------
tf('tempo: klickspår 90, 120 och 140 BPM (ffmpeg aevalsrc) inom ±2 BPM, tydlig takt, inget tal', async () => {
  for (const bpm of [90, 120, 140]) {
    const f = makeFile(`klick/${bpm}.flac`, click(bpm), 40);
    const pcm = await sonic.decodePcm(f, { secs: 40 });
    assert.ok(Math.abs(pcm.length - 40 * DSP.SR) < DSP.SR, 'utdraget har rätt längd');
    const a = DSP.analyze(pcm);
    assert.ok(Math.abs(a.bpm - bpm) <= 2, `${bpm} BPM gav ${a.bpm}`);
    assert.ok(a.pulse > 0.7, `takten syns (${a.pulse})`);
    assert.ok(a.speech < 0.1, `inget tal (${a.speech})`);
  }
});
tf('egenskaper: ackord ger tonart, tyst/kort ljud ger null, tal skiljs från musik', async () => {
  const c = DSP.analyze(await sonic.decodePcm(makeFile('ton/a.flac', calm(220), 20)));
  assert.equal(c.key, 'A'); // A-dur-ackord (A, C#, E)
  assert.ok(c.energyDb < -10 && c.energyDb > -40);
  assert.equal(c.bands.length, 12);
  assert.ok(Math.abs(c.bands.reduce((s, x) => s + x, 0) - 1) < 0.01);
  assert.equal(DSP.analyze(new Float32Array(DSP.SR * 10)), null); // tystnad
  assert.equal(DSP.analyze(new Float32Array(100)), null); // för kort
  const g = DSP.analyze(await sonic.decodePcm(makeFile('ton/g.flac', groove(120), 20)));
  assert.ok(g.density > c.density, 'trummor ger fler anslag än ett liggande ackord');
  assert.ok(g.speech < 0.1);
  if (hasFlite) {
    const f = path.join(MEDIA, 'tal.flac');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', "flite=text='Hej och välkommen till podden där vi pratar om allt mellan himmel och jord Idag pratar vi om musik och ljud och hur datorer förstår vad de hör Det blir ett långt avsnitt':voice=slt", '-c:a', 'flac', f]);
    const s = DSP.analyze(await sonic.decodePcm(f));
    assert.ok(s.speech > 0.3 && s.speech > g.speech + 0.25, `tal ${s.speech} mot musik ${g.speech}`);
  }
});
test('vektorn: alla dimensioner 0–1 och i DIMS-ordning', () => {
  const v = DSP.toVector({ bpm: 120, pulse: 0.9, energyDb: -12, dynamics: 8, centroid: 900, zcr: 0.05, speech: 0.1, density: 3, bands: new Array(12).fill(1 / 12) });
  assert.equal(v.length, DSP.DIMS.length);
  for (const x of v) assert.ok(x >= 0 && x <= 1);
  assert.ok(Math.abs(v[DSP.DIM.tempo] - 0.576) < 0.01);
});

// ---------------- analys i bakgrunden mot databasen ----------------
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
tf('bakgrundsanalys: spår analyseras, lika ljud hamnar nära och olika långt ifrån, ändrad fil analyseras om', async () => {
  const dir = path.join(MEDIA, 'Musik');
  const files = [['A/Ett/01 Klick 120.flac', click(120), 'A'], ['B/Två/01 Klick 122.flac', click(122, 1600), 'B'], ['C/Tre/01 Lugn.flac', calm(220), 'C'],
    ['D/Fyra/01 Lugn 2.flac', calm(196), 'D'], ['E/Fem/01 Groove.flac', groove(124), 'E']];
  for (const [rel, src, artist] of files) makeFile(path.join('Musik', rel), src, 20, { artist, title: path.basename(rel, '.flac').slice(3) });
  run("INSERT INTO libraries(id,name,type,path) VALUES(40,'Musik','music',?)", dir);
  process.env.MUSIC_LOUDNESS = '0';
  const music = await import('../server/music.js');
  await music.scanMusic(get('SELECT * FROM libraries WHERE id=40'), {});
  delete process.env.MUSIC_LOUDNESS;
  assert.equal(sonic.status().pending, 5);
  const t0 = Date.now();
  await sonic.runAll();
  const st = sonic.status();
  assert.equal(st.analyzed, 5); assert.equal(st.pending, 0); assert.equal(st.running, false);
  assert.ok(st.avgMs > 0 && st.session.avgDecodeMs >= 0 && st.session.avgAnalyzeMs > 0);
  console.log(`  ljudanalys: ${Date.now() - t0} ms för 5 spår à 20 s (snitt ${st.avgMs} ms, varav analys ${st.session.avgAnalyzeMs} ms)`);
  const id = (t) => get('SELECT id FROM tracks WHERE title=?', t).id;
  const row = get('SELECT * FROM track_sonic WHERE track_id=?', id('Klick 120'));
  assert.equal(row.ver, DSP.VERSION); assert.ok(Math.abs(row.bpm - 120) <= 2); assert.equal(row.vec.byteLength, DSP.DIMS.length * 4);
  sonic.invalidate();
  const I = sonic.index();
  assert.equal(I.n, 5);
  const z = (t) => I.z.subarray(I.pos.get(id(t)) * 20, I.pos.get(id(t)) * 20 + 20);
  assert.ok(sonic.dist(z('Klick 120'), z('Klick 122')) < sonic.dist(z('Klick 120'), z('Lugn')), 'klick nära klick');
  assert.ok(sonic.dist(z('Lugn'), z('Lugn 2')) < sonic.dist(z('Lugn'), z('Groove')), 'lugnt nära lugnt');
  const sim = sonic.similarTracks(id('Klick 120'), 1);
  assert.equal(sim[0].title, 'Klick 122');
  assert.ok(!sim.some(t => t.title === 'Klick 120'));
  assert.equal(typeof sim[0].bpm, 'number'); assert.equal(typeof sim[0].energy, 'number');
  // Smarta spellistor: tempo och energi som vitlistade fält
  const fast = S.evaluate(S.normalize({ rules: [{ field: 'bpm', op: 'between', value: [110, 130] }], sort: 'bpm', order: 'asc' }), 1).map(t => t.title);
  assert.ok(fast.includes('Klick 120') && fast.includes('Klick 122') && !fast.includes('Lugn'));
  assert.ok(S.catalog().fields.some(f => f.id === 'energy'));
  assert.equal(S.evaluate(S.normalize({ rules: [{ field: 'energy', op: 'gt', value: 101 }] }), 1).length, 0);
  // Ändrad fil (ny mtime) → analyseras igen
  run('UPDATE tracks SET mtime=mtime+1 WHERE id=?', id('Lugn'));
  assert.equal(sonic.status().pending, 1);
  await sonic.runAll();
  assert.equal(sonic.status().pending, 0);
  // Avstängd: inget körs
  sonic.configure({ enabled: false });
  run('UPDATE tracks SET mtime=mtime+1 WHERE id=?', id('Lugn'));
  await sonic.runAll();
  assert.equal(sonic.status().pending, 1);
  sonic.configure({ enabled: true });
  await sonic.runAll();
  assert.throws(() => sonic.configure({ concurrency: 9 }), /1–4/);
  // Borttaget spår försvinner ur tabellen (kaskad)
  run('DELETE FROM tracks WHERE id=?', id('Groove'));
  assert.equal(get('SELECT COUNT(*) AS n FROM track_sonic').n, 4);
});

// ---------------- radio, resa och stationer på syntetiska vektorer ----------------
// 12 artister × 2 album × 5 låtar i tre "stilar" (kluster i vektorrymden)
const LIB = 50;
function seedSynthetic() {
  run("INSERT INTO libraries(id,name,type,path) VALUES(?,'Syntet','music','/finns/inte')", LIB);
  let tid = 5000;
  const rnd = sonic.rng(42);
  for (let a = 0; a < 12; a++) {
    run('INSERT INTO artists(id,library_id,name,sort_name) VALUES(?,?,?,?)', 500 + a, LIB, `Artist ${a}`, `artist ${a}`);
    const style = a % 3; // 0 = lugnt, 1 = energi, 2 = mitt emellan
    for (let al = 0; al < 2; al++) {
      const alId = 500 + a * 2 + al;
      run("INSERT INTO albums(id,library_id,artist_id,title,sort_title,year,genre,added) VALUES(?,?,?,?,?,?,?,0)", alId, LIB, 500 + a, `Album ${a}-${al}`, `album ${a}-${al}`, 1990 + a, ['Ambient', 'Rock', 'Pop'][style]);
      for (let n = 0; n < 5; n++) {
        const id = tid++;
        run('INSERT INTO tracks(id,library_id,album_id,artist_id,title,track_no,disc_no,duration,path,mtime,added) VALUES(?,?,?,?,?,?,1,200,?,1,0)', id, LIB, alId, 500 + a, `Låt ${id}`, n + 1, `/x/${id}.flac`);
        const base = [[0.3, 0.3, 0.25, 0.4, 0.3, 0.2, 0.02, 0.1], [0.75, 0.9, 0.92, 0.2, 0.75, 0.5, 0.02, 0.75], [0.55, 0.7, 0.6, 0.3, 0.5, 0.3, 0.05, 0.4]][style];
        const v = new Float32Array(20);
        for (let k = 0; k < 20; k++) v[k] = Math.max(0, Math.min(1, (k < 8 ? base[k] : 0.28) + (rnd() - 0.5) * 0.08));
        run('INSERT INTO track_sonic(track_id,ver,mtime,analyzed,ok,ms,bpm,energy,speech,vec) VALUES(?,?,1,0,1,1,?,?,?,?)', id, DSP.VERSION,
          Math.round(60 * (200 / 60) ** v[0]), Math.round(v[2] * 100), v[6], new Uint8Array(v.buffer));
      }
    }
  }
  sonic.invalidate();
}
const artistOf = (tid) => get('SELECT artist_id FROM tracks WHERE id=?', tid).artist_id;
const albumOf = (tid) => get('SELECT album_id FROM tracks WHERE id=?', tid).album_id;
const styleOf = (tid) => (artistOf(tid) - 500) % 3;

test('låtradio: startlåten först, inga dubbletter, artister blandas, oändlig kö utan upprepning', () => {
  seedSynthetic();
  const r = sonic.radio({ trackId: 5000, count: 30, uid: 1, seed: 7 });
  assert.equal(r.sonic, true);
  const ids = r.trackList.map(t => t.id);
  assert.equal(ids[0], 5000);
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, ids.length, 'inga dubbletter');
  for (let i = 1; i < ids.length; i++) for (let j = Math.max(0, i - 3); j < i; j++) assert.notEqual(artistOf(ids[i]), artistOf(ids[j]), `samma artist inom fyra låtar (${i})`);
  for (let i = 1; i < ids.length; i++) for (let j = Math.max(0, i - 7); j < i; j++) assert.notEqual(albumOf(ids[i]), albumOf(ids[j]), 'samma album inom åtta låtar');
  // Låter som starten: de första tio är nästan bara samma stil
  assert.ok(ids.slice(0, 10).filter(t => styleOf(t) === styleOf(5000)).length >= 7);
  // Nästa omgång: historik + kö → bara nya låtar
  const next = sonic.radio({ trackId: 5000, history: ids, exclude: ids, count: 25, uid: 1, seed: 8 }).trackList.map(t => t.id);
  assert.equal(next.length, 25);
  assert.ok(!next.some(t => ids.includes(t)), 'ingen upprepning mellan omgångarna');
  assert.equal(new Set(next).size, next.length);
  // Album och artist som start
  const al = sonic.radio({ albumId: 501, count: 10, uid: 1 }).trackList;
  assert.equal(al[0].albumId, 501);
  const ar = sonic.radio({ artistId: 504, count: 10, uid: 1 }).trackList;
  assert.equal(ar[0].artistId, 504);
  assert.equal(sonic.radio({ trackId: 999999, uid: 1 }), null);
  // Litet urval: hellre samma artist igen än en tom kö
  const all120 = all('SELECT id FROM tracks WHERE library_id=?', LIB).map(r => r.id);
  const rest = sonic.radio({ trackId: 5000, exclude: all120.slice(0, all120.length - 3), count: 10, uid: 1 }).trackList;
  assert.equal(rest.length, 3);
});

test('ljudresa: börjar på startlåten, slutar på målet och glider däremellan', () => {
  const from = 5000, to = 5010; // stil 0 (lugnt) → stil 1 (energi)
  assert.equal(styleOf(from), 0); assert.equal(styleOf(to), 1);
  const j = sonic.journey(from, to, 1, { count: 12 }).trackList.map(t => t.id);
  assert.equal(j.length, 12);
  assert.equal(j[0], from); assert.equal(j[j.length - 1], to);
  assert.equal(new Set(j).size, j.length);
  const I = sonic.index(), e = (t) => I.raw[I.pos.get(t) * 20 + DSP.DIM.energy];
  // Energin stiger i stort sett: första halvan lägre än andra halvan
  const avg = (a) => a.reduce((s, t) => s + e(t), 0) / a.length;
  assert.ok(avg(j.slice(0, 6)) < avg(j.slice(6)));
  assert.equal(sonic.journey(from, 999999, 1), null);
});

test('stationer: Lugnt har lägre energi än Energi/Fest, syns bland de smarta listorna', () => {
  const energy = (list) => list.reduce((s, t) => s + t.energy, 0) / list.length;
  const calmL = sonic.stationTracks('sonic-calm', LIB, 1), en = sonic.stationTracks('sonic-energy', LIB, 1), party = sonic.stationTracks('sonic-party', LIB, 1);
  assert.ok(calmL.length >= 20 && en.length >= 20);
  assert.ok(energy(calmL.slice(0, 20)) < energy(en.slice(0, 20)) - 20);
  assert.ok(energy(calmL.slice(0, 20)) < energy(party.slice(0, 20)));
  assert.equal(new Set(calmL.map(t => t.id)).size, calmL.length);
  // Stabil ordning inom timmen (bilens kö stämmer med listan)
  assert.deepEqual(sonic.stationTracks('sonic-calm', LIB, 1).map(t => t.id), calmL.map(t => t.id));
  const smart = L.smartLists(LIB, 1);
  for (const id of ['sonic-calm', 'sonic-energy', 'sonic-focus', 'sonic-party']) {
    const s = smart.find(x => x.id === id);
    assert.ok(s && s.count > 0 && typeof s.name === 'string' && s.station === true, id);
  }
  assert.ok(!smart.some(x => x.id === 'sonic-radio'), 'ingen radio utan lyssningshistorik');
  assert.equal(L.smartTracks(LIB, 1, 'sonic-focus').length > 0, true);
  assert.equal(L.smartName('sonic-party', 1), 'Fest');
  run('INSERT INTO track_plays(user_id,track_id,ts) VALUES(1,5005,100)');
  const radio = L.smartTracks(LIB, 1, 'sonic-radio');
  assert.ok(radio.length > 10 && radio[0].id === 5005);
  // Liknande artister: samma stil först
  const sim = sonic.similarArtists(500);
  assert.ok(sim.length > 0 && !sim.some(a => a.id === 500));
  assert.equal((sim[0].id - 500) % 3, 0);
  assert.equal(sonic.similarArtists(123456), null);
});

test('närmaste granne: 100 000 syntetiska vektorer på några millisekunder, samma svar som full sortering', () => {
  const n = 100_000, D = 20, rnd = sonic.rng(1);
  const I = { n, z: new Float32Array(n * D), lib: new Int32Array(n).fill(1) };
  for (let i = 0; i < n * D; i++) I.z[i] = (rnd() - 0.5) * 3;
  const q = new Float32Array(D).map(() => (rnd() - 0.5) * 3);
  const t0 = performance.now();
  let res;
  for (let r = 0; r < 20; r++) res = sonic.nearest(q, { k: 25, I });
  const ms = (performance.now() - t0) / 20;
  console.log(`  närmaste granne: ${ms.toFixed(1)} ms per sökning över ${n} spår`);
  assert.ok(ms < 60, `för långsamt: ${ms} ms`);
  const brute = Array.from({ length: n }, (_, i) => ({ i, d: sonic.dist(I.z.subarray(i * D, i * D + D), q) })).sort((a, b) => a.d - b.d).slice(0, 25);
  assert.deepEqual(res.map(x => x.i), brute.map(x => x.i));
});

// ---------------- API ----------------
tf('API: liknande, radio, resa, musikhemmet och administrationens förlopp', async () => {
  const media = path.join(ROOT, 'm2');
  for (const [n, src] of [[1, click(120)], [2, click(124, 1700)], [3, calm(220)]]) {
    const f = path.join(media, 'Musik', `Artist ${n}`, 'Skiva', `0${n} Låt ${n}.flac`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-t', '12', '-metadata', `title=Låt ${n}`, '-metadata', `artist=Artist ${n}`, '-c:a', 'flac', f]);
  }
  fs.mkdirSync(path.join(ROOT, 'srv'), { recursive: true });
  srv = await startServer({ root: path.join(ROOT, 'srv'), media, env: { TMDB_API_KEY: '', MUSIC_LOUDNESS: '0' } });
  let tok;
  const req = (p, o = {}, t = tok) => srv.req(p, { ...o, headers: t ? { authorization: 'Bearer ' + t } : {}, auth: false });
  assert.equal((await srv.req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } })).status, 200);
  tok = (await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, auth: false })).data.token;
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Musik', type: 'music', path: path.join(media, 'Musik') } })).status, 200);
  let st;
  for (let i = 0; i < 200; i++) { await new Promise(r => setTimeout(r, 300)); st = (await req('/api/music/sonic')).data; if (st.total === 3 && st.analyzed === 3) break; }
  assert.equal(st.analyzed, 3, JSON.stringify(st)); assert.equal(st.concurrency, 1); assert.equal(st.enabled, true);
  const lib = (await req('/api/libraries')).data.find(l => l.type === 'music').id;
  const tracks = (await req(`/api/music/${lib}/search?q=Låt`)).data.tracks;
  const t1 = tracks.find(t => t.title === 'Låt 1').id, t3 = tracks.find(t => t.title === 'Låt 3').id;
  const sim = (await req(`/api/music/tracks/${t1}/similar`)).data;
  assert.equal(sim.analyzed, true); assert.equal(sim.trackList[0].title, 'Låt 2');
  assert.ok(Math.abs(sim.profile.bpm - 120) <= 2);
  const r = (await req('/api/music/radio', { method: 'POST', body: { trackId: t1, count: 5 } })).data;
  assert.equal(r.trackList[0].id, t1); assert.equal(r.trackList.length, 3);
  assert.equal((await req('/api/music/radio', { method: 'POST', body: {} })).status, 400);
  const j = (await req('/api/music/journey', { method: 'POST', body: { from: t1, to: t3, count: 3 } })).data.trackList;
  assert.equal(j[0].id, t1); assert.equal(j[j.length - 1].id, t3);
  assert.equal((await req('/api/music/journey', { method: 'POST', body: { from: t1, to: t1 } })).status, 400);
  const home = (await req(`/api/music/${lib}/home`)).data;
  assert.deepEqual(home.sonic, { total: 3, analyzed: 3, ready: false });
  // Inställningar: bara administratör
  assert.equal((await req('/api/music/sonic', { method: 'PUT', body: { concurrency: 2 } })).data.concurrency, 2);
  assert.equal((await req('/api/music/sonic', { method: 'PUT', body: { concurrency: 0 } })).status, 400);
  assert.equal((await req('/api/users', { method: 'POST', body: { name: 'bo', password: PW } })).status, 200);
  const bo = (await srv.req('/api/login', { method: 'POST', body: { name: 'bo', password: PW, app: true }, auth: false })).data.token;
  assert.equal((await req('/api/music/sonic', {}, bo)).status, 403);
  assert.equal((await req(`/api/music/tracks/${t1}/similar`, {}, bo)).status, 200);
  assert.equal((await req(`/api/music/tracks/${t1}/similar`, {}, '')).status, 401);
});
