// Snabbstart (server/prestart.js): startcachen serverar början/slutet medan en långsam (sovande) disk vaknar,
// skarven mot originalfilen är byte för byte rätt, ffmpeg kan läsa den sammansatta strömmen, cachen följer
// storleksgränsen och kastas när filen ändras. Kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-pre-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.PRESTART_DIR = path.join(ROOT, 'ssd');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const MEDIA = path.join(ROOT, 'media');
const { run, get } = await import('../server/db.js');
const pre = await import('../server/prestart.js');

const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const realOpen = pre.io.open;
// "Sovande disk": första öppningen av originalfilen dröjer
const SLOW = 1500;
const slowDisk = () => { pre.io.open = async (p, f) => { await sleep(SLOW); return realOpen(p, f); }; };
const fastDisk = () => { pre.io.open = realOpen; };
pre.io.diskOf = () => null; // testmaskinens diskar ska inte avgöra om "disken är vaken"

let LIB, UID, srv, PORT;
const files = {}, ids = {};
const row = (id) => get('SELECT * FROM items WHERE id=?', id);
function addItem(name, file, extra = {}) {
  const st = fs.statSync(file);
  const dur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim();
  const id = Number(run(`INSERT INTO items(library_id,kind,title,path,size,mtime,duration,added,parent_id,season,episode) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    LIB, extra.kind || 'movie', name, file, st.size, Math.floor(st.mtimeMs / 1000), dur, extra.added ?? Math.floor(Date.now() / 1000), extra.parent ?? null, extra.season ?? null, extra.episode ?? null).lastInsertRowid);
  return id;
}
async function fetchTimed(p, headers = {}) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers });
  const reader = r.body.getReader();
  const chunks = [];
  let first = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (first == null) first = Date.now() - t0;
    chunks.push(Buffer.from(value));
  }
  return { status: r.status, headers: r.headers, body: Buffer.concat(chunks), first, total: Date.now() - t0 };
}

before(() => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(MEDIA, { recursive: true });
  LIB = Number(run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", MEDIA).lastInsertRowid);
  UID = Number(run("INSERT INTO users(name,pass,is_admin,created) VALUES('anna','x',1,0)").lastInsertRowid);
  // ~2,5 Mbit/s i 24 s: en MKV, en MP4 med moov sist (ffmpegs standard) och en MP4 med moov först
  files.mkv = path.join(MEDIA, 'Film A (2020).mkv');
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '24',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2500k', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', files.mkv);
  files.mp4 = path.join(MEDIA, 'Film B (2021).mp4');
  ff('-i', files.mkv, '-c', 'copy', files.mp4);
  files.fast = path.join(MEDIA, 'Film C (2022).mp4');
  ff('-i', files.mkv, '-c', 'copy', '-movflags', '+faststart', files.fast);
  ids.mkv = addItem('Film A', files.mkv);
  ids.mp4 = addItem('Film B', files.mp4);
  ids.fast = addItem('Film C', files.fast);
  pre.__setConfig({ maxBytes: 200 * 1024 * 1024, seconds: 5 });
  srv = http.createServer((req, res) => {
    const it = row(+req.url.slice(1));
    if (!it || !pre.serveDirect(req, res, it, 'video/x-matroska')) { res.writeHead(599); res.end(); }
  }).listen(0);
  PORT = srv.address().port;
});
after(() => { fastDisk(); srv?.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

t('kopiering: början och filens index cachas, MP4 med moov sist får slutet', async () => {
  const r = await pre.tick({ force: true });
  assert.equal(r.filled, 3);
  const I = pre.info();
  assert.equal(I.entries, 3);
  assert.ok(I.used > 0 && I.used <= 200 * 1024 * 1024);
  const meta = (id) => JSON.parse(fs.readFileSync(path.join(process.env.PRESTART_DIR, id + '.json'), 'utf8'));
  const a = meta(ids.mkv), b = meta(ids.mp4), c = meta(ids.fast);
  assert.equal(a.parts[0].from, 0);
  assert.ok(a.parts[0].to + 1 >= 2 * 1024 * 1024, 'minst 2 MB av början');
  assert.equal(a.pipe, true, 'MKV kan matas till ffmpeg som ström');
  assert.equal(b.pipe, false, 'MP4 med moov sist kan inte strömmas till ffmpeg');
  assert.equal(b.parts.at(-1).to, fs.statSync(files.mp4).size - 1, 'slutet (moov) cachas');
  assert.equal(c.pipe, true);
  // Ett andra varv kopierar inget nytt
  assert.equal((await pre.tick({ force: true })).filled, 0);
});

t('sovande disk: första byten kommer direkt och hela filen blir rätt över skarven', async () => {
  slowDisk();
  try {
    const orig = fs.readFileSync(files.mkv);
    const r = await fetchTimed('/' + ids.mkv, { range: 'bytes=0-' });
    assert.equal(r.status, 206);
    assert.ok(r.first < SLOW / 2, `första byten efter ${r.first} ms`);
    assert.ok(r.total >= SLOW - 50, 'resten kom från originalfilen (efter att disken "vaknat")');
    assert.equal(r.body.length, orig.length);
    assert.ok(r.body.equals(orig), 'byte för byte samma som originalet');
    // Intervall över skarven
    const seam = JSON.parse(fs.readFileSync(path.join(process.env.PRESTART_DIR, ids.mkv + '.json'), 'utf8')).parts[0].to + 1;
    const x = await fetchTimed('/' + ids.mkv, { range: `bytes=${seam - 5000}-${seam + 5000}` });
    assert.equal(x.headers.get('content-range'), `bytes ${seam - 5000}-${seam + 5000}/${orig.length}`);
    assert.ok(x.body.equals(orig.subarray(seam - 5000, seam + 5001)));
    // MP4 med moov sist: spelarens förfrågan om slutet besvaras helt ur cachen (ingen väntan på disken)
    const mp4 = fs.readFileSync(files.mp4);
    const y = await fetchTimed('/' + ids.mp4, { range: `bytes=${mp4.length - 3000}-` });
    assert.ok(y.total < SLOW / 2, `slutet tog ${y.total} ms`);
    assert.ok(y.body.equals(mp4.subarray(mp4.length - 3000)));
    // Utan Range: 200 och hela filen
    const z = await fetchTimed('/' + ids.fast);
    assert.equal(z.status, 200);
    assert.ok(z.body.equals(fs.readFileSync(files.fast)));
    // Början mitt i det som inte cachats: vanliga vägen (anroparen serverar filen)
    assert.equal((await fetchTimed('/' + ids.mkv, { range: `bytes=${seam + 100000}-` })).status, 599);
  } finally { fastDisk(); }
});

t('ffmpeg läser den sammansatta strömmen (cache + originalfil) och får samma bild och ljud', async () => {
  slowDisk();
  try {
    const md5 = (args, input) => new Promise((res, rej) => {
      const p = spawn('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', ...args, '-map', '0', '-f', 'md5', '-'], { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
      if (input) { p.stdin.on('error', () => {}); input.pipe(p.stdin); }
      p.on('exit', (code) => code === 0 ? res(out.trim()) : rej(new Error(err)));
    });
    const ref = await md5(['-i', files.mkv]);
    const inp = pre.inputFor(row(ids.mkv));
    assert.ok(inp);
    assert.equal(await md5(['-i', 'pipe:0'], inp), ref);
    // MP4 med moov sist kan inte läsas som ström → null (ffmpeg läser filen som vanligt)
    assert.equal(pre.inputFor(row(ids.mp4)), null);
    assert.ok(pre.inputFor(row(ids.fast)));
  } finally { fastDisk(); }
});

t('ändrad fil: posten kastas (databasen ändrad, eller filen ändrad innan skanningen hunnit se det)', async () => {
  // Skanningen har sett ändringen (ny mtime i databasen): cachen används inte och tas bort
  const it = row(ids.fast);
  run('UPDATE items SET mtime=mtime+5 WHERE id=?', ids.fast);
  assert.equal((await fetchTimed('/' + ids.fast, { range: 'bytes=0-' })).status, 599);
  assert.equal(fs.existsSync(path.join(process.env.PRESTART_DIR, ids.fast + '.json')), false);
  run('UPDATE items SET mtime=? WHERE id=?', it.mtime, ids.fast);
  // Filen skrivs över (samma storlek) men databasen är gammal: skarven upptäcker det och avbryter svaret
  const tmp = path.join(ROOT, 'copy.mkv');
  fs.copyFileSync(files.mkv, tmp);
  const buf = fs.readFileSync(files.mkv); buf[buf.length - 10] ^= 0xff; fs.writeFileSync(files.mkv, buf);
  const later = new Date(Date.now() + 10e3); fs.utimesSync(files.mkv, later, later);
  await assert.rejects(fetchTimed('/' + ids.mkv, { range: 'bytes=0-' }));
  await sleep(50);
  assert.equal(fs.existsSync(path.join(process.env.PRESTART_DIR, ids.mkv + '.json')), false, 'posten är borttagen');
  // Tillbaka till originalet (och databasen uppdaterad som efter en skanning)
  fs.copyFileSync(tmp, files.mkv);
  const st = fs.statSync(files.mkv);
  run('UPDATE items SET size=?, mtime=? WHERE id=?', st.size, Math.floor(st.mtimeMs / 1000), ids.mkv);
});

t('storleksgränsen: cachen ryms alltid, och Fortsätt titta går före nyligen tillagt', async () => {
  pre.__setConfig({ maxBytes: 200 * 1024 * 1024 });
  await pre.tick({ force: true });
  // Fortsätt titta på film B (12 s in): högre prioritet, platsen där man slutade cachas också
  run('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,0,?)', UID, ids.mp4, 12, 24, Math.floor(Date.now() / 1000));
  const one = Math.max(...[ids.mkv, ids.mp4, ids.fast].map(id => { try { return JSON.parse(fs.readFileSync(path.join(process.env.PRESTART_DIR, id + '.json'), 'utf8')).parts.reduce((s, p) => s + p.to - p.from + 1, 0); } catch { return 0; } }));
  const limit = Math.floor(one * 2.2);
  pre.__setConfig({ maxBytes: limit, quietMs: 0 });
  await pre.tick({ force: true });
  let I = pre.info();
  assert.ok(I.used <= limit, `${I.used} > ${limit}`);
  assert.ok(I.items.some(x => x.id === ids.mp4), 'Fortsätt titta behölls');
  const b = JSON.parse(fs.readFileSync(path.join(process.env.PRESTART_DIR, ids.mp4 + '.json'), 'utf8'));
  // Sänkt gräns: bara det viktigaste ryms – resten tas bort
  const bBytes = b.parts.reduce((s, p) => s + p.to - p.from + 1, 0);
  pre.__setConfig({ maxBytes: bBytes + 100000 });
  await pre.tick({ force: true });
  I = pre.info();
  assert.ok(I.used <= bBytes + 100000);
  assert.deepEqual(I.items.map(x => x.id), [ids.mp4], JSON.stringify({ b, bBytes, c: pre.candidates().map(c => [c.it.id, c.score, c.positions, pre.windowsFor(c, pre.config())]) }));
  const off = Math.floor(row(ids.mp4).size * 12 / row(ids.mp4).duration);
  assert.ok(b.parts.some(p => p.from <= off && off <= p.to), 'platsen där man slutade är cachad');
  assert.equal(b.why, 'Fortsätt titta');
  // Ingen fil i mappen utöver posternas
  const own = new Set(I.items.flatMap(x => { const m = JSON.parse(fs.readFileSync(path.join(process.env.PRESTART_DIR, x.id + '.json'), 'utf8')); return [x.id + '.json', ...m.parts.map((_, i) => `${x.id}.p${i}`)]; }));
  assert.deepEqual(fs.readdirSync(process.env.PRESTART_DIR).filter(f => !own.has(f)), []);
  // Träffgraden: uppspelning av film B 12 s in träffar, film C från början gör det inte (inte cachad)
  pre.notePlay(row(ids.mp4), 12, 'direct');
  const before = pre.info();
  assert.ok(before.hits >= 1);
  pre.__setConfig({ maxBytes: 200 * 1024 * 1024 });
});

t('vaken disk: kopierar bara när disken nyss lästs (eller I/O-räknarna ändrats), väcker aldrig själv', async () => {
  pre.clear();
  pre.__setConfig({ awakeMs: 60e3, forget: true });
  // Ingen titel har lästs nyligen → inget kopieras
  assert.equal((await pre.tick()).filled, 0);
  // Skanningen läste film C (ny titel) → dess mapp räknas som vaken
  pre.touch(row(ids.fast));
  assert.equal(pre.awakeFor(row(ids.fast)), true);
  assert.equal((await pre.tick()).filled, 3, 'alla tre ligger i samma mapp');
  // I/O-räknarna: en disk vars räknare ändrats sedan förra provet är vaken
  const sys = path.join(ROOT, 'sys');
  fs.mkdirSync(path.join(sys, 'sdq'), { recursive: true });
  const stat = (r) => fs.writeFileSync(path.join(sys, 'sdq', 'stat'), `${r} 0 0 0 5 0 0 0 0 0 0`);
  stat(10); pre.sampleDisks(sys, 1000);
  assert.equal(pre.sampleDisks(sys, 2000).get('sdq').changed, 0, 'oförändrad = sover');
  stat(11);
  assert.equal(pre.sampleDisks(sys, 3000).get('sdq').changed, 3000);
});

t('nästa avsnitt: serien man tittar på ger nästa och därpå följande avsnitt som kandidater', () => {
  const show = Number(run("INSERT INTO items(library_id,kind,title,added) VALUES(?, 'show', 'Serien', 0)", LIB).lastInsertRowid);
  const eps = [1, 2, 3, 4].map(n => addItem('Avsnitt ' + n, files.fast, { kind: 'episode', parent: show, season: 1, episode: n, added: 0 }));
  run('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,0,24,1,?)', UID, eps[0], Math.floor(Date.now() / 1000));
  const c = pre.candidates();
  const next = c.find(x => x.it.id === eps[1]), after = c.find(x => x.it.id === eps[2]);
  assert.equal(next.why, 'Nästa avsnitt');
  assert.equal(after.why, 'Avsnittet efter nästa');
  assert.ok(next.score > after.score);
  assert.ok(!c.some(x => x.it.id === eps[3]));
});
