// Andra säkerhetsgranskningen (IPTV, DVR, startcachen, repliksökningen): fientliga TV-guider tolkas i linjär tid,
// ffmpeg når aldrig spärrade adresser via omdirigeringar eller HLS-segment (strömvakten i iptv/net.js), EPG-titlar blir
// aldrig sökvägar utanför inspelningsmappen, en flyttad bokning tar aldrig med en annan användares inspelning in i en
// regel ("Behåll senaste N"), ffmpegs fel i inspelningar visar aldrig Xtream-inloggningen, en kort sökning i
// repliksökningen rankar inte hela indexet och väckningen av diskar har ett tak per profil. Delarna med ffmpeg hoppas
// över om ffmpeg saknas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-sec2-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.DVR_DIR = path.join(ROOT, 'rec');
delete process.env.IPTV_ALLOW_PRIVATE; delete process.env.PODCAST_ALLOW_PRIVATE;
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const D = await import('../server/db.js');
const live = await import('../server/livetv.js');
const NET = await import('../server/iptv/net.js');
const dvr = await import('../server/dvr.js');
const L = await import('../server/sublines.js');
const P = await import('../server/prestart.js');
D.run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
D.run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(2,'bo','x',0,0)");
D.setSetting('dvr_pad_before', '0'); D.setSetting('dvr_pad_after', '0');

let prov, inside, P1 = 0, P2 = 0;
const hits = [];
before(async () => {
  // "Insidan": en tjänst på loopback som leverantörens innehåll aldrig får nå
  inside = http.createServer((q, r) => { hits.push(q.url); r.writeHead(200, { 'Content-Type': 'video/mp2t' }); r.end(Buffer.alloc(188 * 50, 0x47)); }).listen(0, '127.0.0.1');
  await new Promise(r => inside.once('listening', r));
  P2 = inside.address().port;
  let ts = Buffer.alloc(0);
  if (hasFfmpeg) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-f', 'mpegts', path.join(ROOT, 'ok.ts')]);
    ts = fs.readFileSync(path.join(ROOT, 'ok.ts'));
  }
  // Leverantören (betrodd: administratören skrev in den): omdirigerar och listar segment på insidan
  prov = http.createServer((q, r) => {
    if (q.url === '/ok.ts') { r.writeHead(200, { 'Content-Type': 'video/mp2t' }); return r.end(ts); }
    if (q.url === '/redirect.ts') { r.writeHead(302, { Location: `http://localhost:${P2}/hemligt-redirect` }); return r.end(); }
    if (q.url === '/list.m3u8') {
      r.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return r.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://localhost:${P2}/hemligt-segment.ts\n#EXT-X-ENDLIST\n`);
    }
    if (q.url.startsWith('/live/')) { r.writeHead(404); return r.end(); }
    r.writeHead(404); r.end();
  }).listen(0, '127.0.0.1');
  await new Promise(r => prov.once('listening', r));
  P1 = prov.address().port;
  await NET.startGuard();
});
after(async () => {
  await dvr.shutdown(2000);
  prov?.close(); inside?.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------- TV-guiden ----------------
test('XMLTV: fientliga element tolkas i linjär tid och ett för stort element stoppar läsningen tidigt', () => {
  // 40 000 ofullständiga <title i ett program (240 kB) tog 9 s, <episode-num 12 s – servern stod still under tiden
  for (const body of ['<title'.repeat(40000), '<episode-num'.repeat(20000), '<icon src="'.repeat(20000), '<display-name'.repeat(40000)]) {
    const t = Date.now();
    const r = live.parseXMLTV(`<tv><channel id="a">${body}</channel><programme start="20260101000000 +0000" channel="a">${body}</programme></tv>`);
    assert.ok(Date.now() - t < 1000, `${body.slice(0, 14)}: ${Date.now() - t} ms`);
    assert.equal(r.programs.length, 1);
  }
  // Ett element som aldrig tar slut, i bitar om 16 kB: tidigare 64 MB (kvadratiskt, minuter) innan felet kom
  const p = new live.XmltvParser({ onChannel() {}, onProgram() {} });
  const big = '<tv><programme start="20260101000000" channel="a">' + 'x'.repeat(4 << 20);
  const t = Date.now();
  assert.throws(() => { for (let i = 0; i < big.length; i += 16384) p.feed(big.slice(i, i + 16384)); }, /för stort element/);
  assert.ok(Date.now() - t < 1500, `${Date.now() - t} ms`);
  // Vanliga guider tolkas som förut
  const ok = live.parseXMLTV(`<tv><channel id="sv1"><display-name lang="sv">SVT1</display-name><display-name>SVT 1 HD</display-name><icon src="http://x/l.png"/></channel>
    <programme start="20261010180000 +0200" stop="20261010190000 +0200" channel="sv1"><title lang="sv">Nyheter &amp; väder</title><sub-title>Del 2</sub-title>
    <desc>Text</desc><category>Nyheter</category><episode-num system="xmltv_ns">1.4.</episode-num><icon src="http://x/p.jpg" /><new /></programme></tv>`);
  assert.deepEqual(ok.channels, [{ id: 'sv1', names: ['SVT1', 'SVT 1 HD'], icon: 'http://x/l.png' }]);
  const pr = ok.programs[0];
  assert.deepEqual([pr.title, pr.subtitle, pr.description, pr.category, pr.season, pr.episode, pr.icon, pr.isNew, pr.stop - pr.start],
    ['Nyheter & väder', 'Del 2', 'Text', 'Nyheter', 2, 5, 'http://x/p.jpg', true, 3600]);
  assert.equal(live.parseXMLTV('<tv><programme start="20261010180000" channel="a"><title>A</title><episode-num system="onscreen">S03E07</episode-num></programme></tv>').programs[0].season, 3);
  assert.equal(live.parseXMLTV('<tv><programme start="20261010180000" channel="a"><titles>B</titles><title>A</title></programme></tv>').programs[0].title, 'A');
});

// ---------------- strömvakten ----------------
const probe = (url, extra = [], env = process.env) => new Promise((resolve) => {
  const p = spawn('ffprobe', ['-v', 'error', ...live.SAFE_LIVE, ...extra, '-rw_timeout', '5000000', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', url], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  const t = setTimeout(() => p.kill('SIGKILL'), 15000);
  p.on('close', () => { clearTimeout(t); resolve({ out: out.trim(), err }); });
});
test('strömvakten: ffmpeg följer inte omdirigeringar eller HLS-segment till spärrade adresser', { skip: !hasFfmpeg && 'ffmpeg saknas' }, async () => {
  const pol = NET.policyOf([`http://127.0.0.1:${P1}/lista.m3u`], true);
  const noProxy = { ...process.env }; for (const k of Object.keys(noProxy)) if (/_proxy$/i.test(k)) delete noProxy[k];
  // Utan vakten (som förut): ffmpeg går själv till insidan
  hits.length = 0;
  await probe(`http://127.0.0.1:${P1}/redirect.ts`, [], noProxy);
  assert.ok(hits.includes('/hemligt-redirect'), 'kontrollen: ffmpeg följer omdirigeringen utan vakten ' + JSON.stringify(hits));
  hits.length = 0;
  for (const u of [`http://127.0.0.1:${P1}/redirect.ts`, `http://127.0.0.1:${P1}/list.m3u8`]) {
    const g = NET.ffGuard(u, pol);
    const r = await probe(u, g.args, g.env);
    g.release();
    assert.equal(r.out, '', u + ': ' + r.err);
  }
  assert.deepEqual(hits, [], 'insidan nåddes inte');
  // Det som är tillåtet fungerar genom vakten
  const g = NET.ffGuard(`http://127.0.0.1:${P1}/ok.ts`, pol);
  assert.match((await probe(`http://127.0.0.1:${P1}/ok.ts`, g.args, g.env)).out, /^h264/);
  g.release();
  assert.equal(NET.guardActive(), 0, 'nycklarna tas bort');
  // Adresser som är spärrade IP-adresser (även rtsp, som inte går genom vakten) nekas direkt
  assert.throws(() => NET.ffGuard('rtsp://169.254.169.254/x', pol), /lokalt nätverk/);
  assert.throws(() => NET.ffGuard(`http://127.0.0.2:${P1}/x`, pol), /lokalt nätverk/);
});
test('strömvakten: CONNECT (https) kontrolleras och kräver ffmpeg-processens nyckel', async () => {
  const pol = NET.policyOf([`http://127.0.0.1:${P1}/lista.m3u`], true);
  const g = NET.ffGuard(`http://127.0.0.1:${P1}/ok.ts`, pol);
  const m = /^http:\/\/bx:([0-9a-f]+)@127\.0\.0\.1:(\d+)$/.exec(g.args[1]);
  assert.ok(m, g.args[1]);
  const ask = (target, auth) => new Promise((resolve) => {
    const s = net.connect(+m[2], '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Basic ${Buffer.from('bx:' + auth).toString('base64')}\r\n` : ''}\r\n`));
    let d = ''; s.on('data', x => { d += x; if (d.includes('\r\n')) { resolve(d.split('\r\n')[0]); s.destroy(); } });
    s.on('error', () => resolve('fel'));
  });
  assert.match(await ask(`localhost:${P2}`, null), /407/);
  assert.match(await ask(`localhost:${P2}`, 'fel-nyckel'), /407/);
  assert.match(await ask(`localhost:${P2}`, m[1]), /403/);
  assert.match(await ask(`169.254.169.254:443`, m[1]), /403/);
  assert.match(await ask(`127.0.0.1:${P1}`, m[1]), /200/, 'betrodd värd');
  g.release();
  assert.match(await ask(`127.0.0.1:${P1}`, m[1]), /407/, 'nyckeln gäller bara medan processen körs');
});

// ---------------- inspelning ----------------
test('inspelning: titlar ur guiden blir aldrig mappar utanför inspelningsmappen', () => {
  const root = path.resolve(dvr.dvrDir());
  for (const title of ['. ..', '..', ' .. ', '.\t..', '../../etc', '..\\..', '. . .', '\u0000..']) {
    assert.ok(!/^[.\s]*$/.test(dvr.safeName(title)) && !dvr.safeName(title).includes('/'), `${JSON.stringify(title)} → ${JSON.stringify(dvr.safeName(title))}`);
    for (const rec of [{ title, start: 1e9 }, { title, start: 1e9, season: 1, episode: 2, subtitle: '. ..' }]) {
      const nm = dvr.recordingName(rec);
      const full = path.resolve(root, nm.dir, nm.base + '.ts');
      assert.ok(full.startsWith(root + path.sep), `${JSON.stringify(title)} → ${full}`);
      assert.ok(path.resolve(root, nm.dir).startsWith(root + path.sep));
    }
  }
  assert.equal(dvr.safeName('Rapport.'), 'Rapport');
  assert.equal(dvr.safeName('Mr. Robot'), 'Mr. Robot');
});
test('inspelning: en flyttad bokning tar aldrig in en annan användares inspelning i regeln (Behåll senaste N)', () => {
  const tid = Number(D.run("INSERT INTO tuners(kind,name,url,tuner_count) VALUES('m3u','K',?,4)", `http://127.0.0.1:${P1}/lista.m3u`).lastInsertRowid);
  const ch = Number(D.run('INSERT INTO channels(tuner_id,name,stream_url) VALUES(?,?,?)', tid, 'K1', `http://127.0.0.1:${P1}/ch1`).lastInsertRowid);
  const ch2 = Number(D.run('INSERT INTO channels(tuner_id,name,stream_url) VALUES(?,?,?)', tid, 'K2', `http://127.0.0.1:${P1}/ch2`).lastInsertRowid);
  const T = D.now() + 86400;
  const prog = (c, start) => Number(D.run('INSERT INTO programs(channel_id,start,stop,title) VALUES(?,?,?,?)', c, start, start + 1800, 'Gemensam').lastInsertRowid);
  const p1 = prog(ch, T), p2 = prog(ch2, T + 7200);
  // Bo har bokat sändningen på K2 själv
  const bos = dvr.scheduleProgram(p2, { id: 2 });
  // Anna har en regel med Behåll senaste 1 och en bokning från den på K1
  const rule = dvr.addRule({ title: 'Gemensam', channelId: ch, keep: 1, newOnly: false }, { id: 1 });
  const annas = D.get('SELECT id FROM recordings WHERE rule_id=? AND channel_id=?', rule, ch).id;
  // Anna flyttar sin bokning till Bos sändning
  const nid = dvr.swapRecording(annas, p2, { id: 1 });
  assert.equal(nid, bos);
  assert.equal(D.get('SELECT rule_id FROM recordings WHERE id=?', bos).rule_id, null, 'Bos inspelning hör inte till Annas regel');
  // Till en sändning som ingen bokat följer regeln med som förut
  const p3 = prog(ch, T + 14400);
  const free = dvr.scheduleProgram(p1, { id: 1 }) && D.get("SELECT id FROM recordings WHERE program_id=?", p1);
  if (free) D.run('UPDATE recordings SET rule_id=? WHERE id=?', rule, free.id);
  const moved = dvr.swapRecording(free.id, p3, { id: 1 });
  assert.equal(D.get('SELECT rule_id FROM recordings WHERE id=?', moved).rule_id, rule);
});
test('inspelning: ffmpegs fel visar aldrig Xtream-inloggningen (lista, notis, API)', { skip: !hasFfmpeg && 'ffmpeg saknas', timeout: 60000 }, async () => {
  const tid = Number(D.run("INSERT INTO tuners(kind,name,url,tuner_count) VALUES('m3u','Xt',?,2)", `http://127.0.0.1:${P1}`).lastInsertRowid);
  const ch = Number(D.run('INSERT INTO channels(tuner_id,name,stream_url) VALUES(?,?,?)', tid, 'X1', `http://127.0.0.1:${P1}/live/anv/Hemligt-L0senord/12.ts`).lastInsertRowid);
  const id = dvr.scheduleManual({ channelId: ch, start: D.now() - 5, stop: D.now() + 60, title: 'Fel' }, { id: 1 });
  let r;
  for (let i = 0; i < 100; i++) { r = D.get('SELECT status, error FROM recordings WHERE id=?', id); if (r.status === 'failed') break; await sleep(200); }
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.ok(r.error, JSON.stringify(r));
  assert.doesNotMatch(r.error, /Hemligt-L0senord|anv\//, r.error);
  assert.doesNotMatch(JSON.stringify(dvr.list()), /Hemligt-L0senord/);
  // ffmpeg 5.1 (och äldre) skriver adressen sist: "<adress>: Server returned 404 Not Found"
  const line = dvr.lastLine(`[http @ 0x1] HTTP error 404 Not Found\nhttp://h.example:8080/live/anv/Hemligt-L0senord/12.ts: Server returned 404 Not Found\n`, 'x');
  assert.doesNotMatch(line, /Hemligt-L0senord|anv\//, line);
  assert.match(line, /h\.example:8080.*Server returned 404/);
});

// ---------------- repliksökningen ----------------
test('repliksökningen: FTS5-frågan är bara ord, och ett kort sista ord rankar inte hela indexet', () => {
  assert.equal(D.FTS5, true);
  assert.equal(L.ftsQuery(['din', 'far']), '"din far"*');
  assert.equal(L.ftsQuery(['th']), '"th"', 'kort sista ord: helt ord');
  assert.deepEqual(L.wordsOf('"a" OR b* NEAR(c) ^d -e'), ['a', 'or', 'b', 'near', 'c', 'd', 'e'], 'ingen FTS5-syntax når frågan');
  const lib = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('F','movie','/x')").lastInsertRowid);
  const W = ['the', 'that', 'there', 'then', 'they', 'this', 'thing', 'think', 'and', 'you', 'what', 'is', 'to', 'of', 'it', 'in', 'me', 'we', 'go', 'thanks'];
  for (let f = 0; f < 20; f++) {
    const id = Number(D.run("INSERT INTO items(library_id,kind,title,sort_title,path,mtime,added) VALUES(?,'movie',?,?,?,1,1)", lib, 'Film ' + f, 'film ' + f, `/x/${f}.mkv`).lastInsertRowid);
    const cues = [];
    for (let i = 0; i < 15000; i++) { let s = ''; for (let k = 0; k < 7; k++) s += W[(i * 7 + k * 13 + f + (i >> k)) % W.length] + ' '; cues.push({ s: i, e: i + 0.5, text: s.trim() }); }
    L.store({ id }, { key: 'x' + f, sub: { lang: 'eng', label: 'English' }, sig: 's' + f, fmtime: null }, cues);
  }
  const all = { age: { sql: '', params: [] }, allowed: () => true };
  for (const q of ['th', 'the', 'thi', 'is th', 'it']) {
    const t = Date.now();
    L.search(q, { ...all, limit: 60 });
    assert.ok(Date.now() - t < 400, `"${q}": ${Date.now() - t} ms`);
  }
  assert.ok(L.search('thank', all).length > 0, 'prefix från tre tecken fungerar');
  assert.ok(L.search('it', all).length > 0, 'korta ord hittas som hela ord');
});

// ---------------- startcachen ----------------
test('startcachen: en profil kan väcka högst WAKE_MAX titlar per minut', () => {
  P.__setConfig({ dir: path.join(ROOT, 'prestart'), forget: true });
  const lib = D.get('SELECT id FROM libraries LIMIT 1')?.id || Number(D.run("INSERT INTO libraries(name,type,path) VALUES('G','movie','/y')").lastInsertRowid);
  const ids = Array.from({ length: P.WAKE_MAX + 10 }, (_, i) => ({ id: 900000 + i, path: `/finns-inte/${i}.mkv`, size: 1, library_id: lib }));
  const woke = ids.map(it => P.wake(it, 2));
  assert.equal(woke.filter(Boolean).length, P.WAKE_MAX);
  assert.equal(P.wake({ id: 990000, path: '/finns-inte/x.mkv', size: 1 }, 1), true, 'en annan profil påverkas inte');
  assert.equal(P.wake({ id: 990001, path: '/finns-inte/y.mkv', size: 1 }), true, 'servern själv (uppspelning) har inget tak');
});
