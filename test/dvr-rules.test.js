// Inspelning (DVR): regler (tidsfönster, veckodagar, bara nya avsnitt via guidens flaggor och biblioteket), prioritet,
// konflikter i förväg med alternativa sändningar, "behåll senaste N" med "behåll alltid", efterbearbetning till MKV
// med metadata och NFO, och titta medan den spelas in (HLS av den växande filen). Delarna med filer kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-dvr-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.DVR_DIR = path.join(ROOT, 'rec');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
const plan = await import('../server/dvrplan.js');
const { run, get, all, now, setSetting } = await import('../server/db.js');
const live = await import('../server/livetv.js');
const dvr = await import('../server/dvr.js');
const growing = await import('../server/dvrlive.js');
run("INSERT INTO users(id,name,pass,is_admin,created) VALUES(1,'anna','x',1,0)");
setSetting('dvr_pad_before', '0'); setSetting('dvr_pad_after', '0');

let srv, base;
const open = new Set();
before(async () => {
  if (!hasFfmpeg) return;
  // "Kanal" i H.264 som aldrig tar slut: servern skickar filen och håller anslutningen öppen (som en direktsändning)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=500',
    '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', path.join(ROOT, 'ch.ts')]);
  srv = http.createServer((q, r) => {
    if (q.url.startsWith('/ch')) { r.writeHead(200, { 'Content-Type': 'video/mp2t' }); r.write(fs.readFileSync(path.join(ROOT, 'ch.ts'))); open.add(r); return; }
    r.writeHead(404); r.end();
  }).listen(0);
  await new Promise(r => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  await dvr.shutdown(3000);
  growing.shutdown();
  for (const r of open) try { r.destroy(); } catch {}
  srv?.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** Lokal tid om d dagar kl. h:m (sekunder) */
const at = (d, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return Math.floor(x.getTime() / 1000); };
let tunerN = 0;
function source(tuners = 1, chans = 2) {
  // Listan på samma värd som strömmarna: administratörens adress är betrodd (strömvakten, iptv/net.js)
  const tid = Number(run("INSERT INTO tuners(kind,name,url,tuner_count) VALUES('m3u',?,?,?)", 'Källa ' + (++tunerN), `${base || 'http://x'}/list${tunerN}.m3u`, tuners).lastInsertRowid);
  return { tid, ch: Array.from({ length: chans }, (_, i) => Number(run('INSERT INTO channels(tuner_id,name,stream_url) VALUES(?,?,?)', tid, `K${tunerN}-${i}`, `${base || 'http://s'}/ch${tunerN}-${i}`).lastInsertRowid)) };
}
const prog = (ch, start, len, title, extra = {}) => Number(run('INSERT INTO programs(channel_id,start,stop,title,subtitle,season,episode,is_new) VALUES(?,?,?,?,?,?,?,?)',
  ch, start, start + len, title, extra.subtitle ?? null, extra.season ?? null, extra.episode ?? null, extra.isNew ? 1 : 0).lastInsertRowid);
const scheduled = (title) => all("SELECT * FROM recordings WHERE title=? AND status='scheduled' ORDER BY start", title);

test('simulering: tunerkö, sen start, prioritet som avbryter och missade', () => {
  const r = (id, start, stop, priority = 0, extra = {}) => ({ id, tunerId: 1, start, stop, padBefore: 0, padAfter: 0, priority, ...extra });
  // En tuner: B krockar helt med A → missas; C börjar när A är slut → ok
  let s = plan.simulate([r(1, 0, 100), r(2, 10, 90), r(3, 100, 200)], { 1: 1 });
  assert.equal(s.get(1).outcome, 'ok'); assert.equal(s.get(2).outcome, 'missed'); assert.deepEqual(s.get(2).by, [1]); assert.equal(s.get(3).outcome, 'ok');
  // B slutar efter A: får tunern när A är klar → börjar sent
  s = plan.simulate([r(1, 0, 100), r(2, 50, 150)], { 1: 1 });
  assert.equal(s.get(2).outcome, 'late'); assert.equal(s.get(2).from, 100);
  // Högre prioritet avbryter den pågående med lägre
  s = plan.simulate([r(1, 0, 100), r(2, 50, 150, 5)], { 1: 1 });
  assert.equal(s.get(1).outcome, 'cut'); assert.equal(s.get(1).to, 50); assert.equal(s.get(2).outcome, 'ok');
  // Två tuners räcker; olika källor påverkar inte varandra
  s = plan.simulate([r(1, 0, 100), r(2, 0, 100), r(3, 0, 100, 0, { tunerId: 2 })], { 1: 2, 2: 1 });
  assert.ok([...s.values()].every(v => v.outcome === 'ok'));
  // Samtidig start: prioriteten avgör vem som får tunern
  s = plan.simulate([r(1, 0, 100), r(2, 0, 100, 3)], { 1: 1 });
  assert.equal(s.get(2).outcome, 'ok'); assert.equal(s.get(1).outcome, 'missed');
  // En pågående inspelning har tunern nu
  s = plan.simulate([r(1, 0, 100, 0, { recording: true }), r(2, 0, 100)], { 1: 1 }, 20);
  assert.equal(s.get(1).outcome, 'ok'); assert.equal(s.get(2).outcome, 'missed');
});

test('tidsfönster, veckodagar och avsnittsidentitet', () => {
  const t = at(3, 23, 30), day = new Date(t * 1000).getDay();
  assert.ok(plan.inWindow({ time_from: 22 * 60, time_to: 2 * 60 }, t), 'över midnatt');
  assert.ok(!plan.inWindow({ time_from: 18 * 60, time_to: 22 * 60 }, t));
  assert.ok(plan.inWindow({ days: 1 << day }, t));
  assert.ok(!plan.inWindow({ days: 127 & ~(1 << day) }, t));
  assert.ok(plan.inWindow({}, t));
  assert.equal(plan.episodeKey({ season: 2, episode: 3 }), 's2e3');
  assert.equal(plan.episodeKey({ subtitle: ' Del 1 ' }), 't:del 1');
  assert.equal(plan.episodeKey({ title: 'Rapport' }), null);
});

test('regel: tidsfönster och veckodagar, ändring tar bort bokningar som inte längre passar', () => {
  const { ch } = source(2);
  const kvall = prog(ch[0], at(2, 20), 1800, 'Kvällsnytt'), natt = prog(ch[0], at(2, 23, 30), 1800, 'Kvällsnytt');
  const rule = dvr.addRule({ title: 'Kvällsnytt', newOnly: false, timeFrom: '22:00', timeTo: '02:00' }, { id: 1 });
  assert.deepEqual(scheduled('Kvällsnytt').map(r => r.program_id), [natt]);
  // Fönstret tas bort: båda bokas. Sedan bara en veckodag som inte stämmer: inga bokningar
  dvr.updateRule(rule, { timeFrom: '', timeTo: '' });
  assert.deepEqual(scheduled('Kvällsnytt').map(r => r.program_id), [kvall, natt]);
  const day = new Date(at(2, 20) * 1000).getDay();
  dvr.updateRule(rule, { days: [(day + 1) % 7] });
  assert.equal(scheduled('Kvällsnytt').length, 0);
  // Pausad regel bokar inget
  dvr.updateRule(rule, { days: [], enabled: false });
  assert.equal(get('SELECT days, enabled FROM dvr_rules WHERE id=?', rule).enabled, 0);
  assert.equal(scheduled('Kvällsnytt').length, 0);
  dvr.updateRule(rule, { enabled: true, priority: 4, padBefore: 120, padAfter: 600 });
  assert.equal(scheduled('Kvällsnytt').length, 2);
  assert.ok(scheduled('Kvällsnytt').every(r => r.priority === 4 && r.pad_before === 120 && r.pad_after === 600), 'regelns inställningar följer med');
  dvr.removeRule(rule);
});

test('bara nya: guidens flagga, avsnitt som redan finns i biblioteket och förhandsvisning', () => {
  const { ch } = source(2);
  // Utan avsnittsinfo men med "nytt"-flaggor i guiden: omarkerade sändningar är repriser
  const ny = prog(ch[0], at(4, 19), 1800, 'Uppdrag granskning', { isNew: true });
  prog(ch[1], at(5, 13), 1800, 'Uppdrag granskning');
  dvr.addRule({ title: 'Uppdrag granskning', newOnly: true }, { id: 1 });
  assert.deepEqual(scheduled('Uppdrag granskning').map(r => r.program_id), [ny]);
  // Avsnitt 1 finns redan i seriebiblioteket (mappnamnet med år) – bara avsnitt 2 bokas
  run("INSERT INTO libraries(id,name,type,path) VALUES(50,'Serier','show','/media/serier')");
  const show = Number(run("INSERT INTO items(library_id,kind,title,src_name,added) VALUES(50,'show','The Bridge','Bron (2011)',0)").lastInsertRowid);
  run("INSERT INTO items(library_id,kind,parent_id,title,season,episode,path,added) VALUES(50,'episode',?,'Avsnitt 1',1,1,'/media/serier/Bron (2011)/S01E01.mkv',0)", show);
  prog(ch[0], at(4, 21), 3600, 'Bron', { season: 1, episode: 1 });
  const e2 = prog(ch[0], at(5, 21), 3600, 'Bron', { season: 1, episode: 2 });
  const e2b = prog(ch[1], at(6, 21), 3600, 'Bron', { season: 1, episode: 2 });
  const pv = dvr.previewRule({ title: 'Bron', newOnly: true, skipLibrary: true });
  assert.deepEqual(pv.map(a => [a.programId, a.record, a.reason]), [[pv[0].programId, false, 'finns redan i biblioteket'], [e2, true, null], [e2b, false, 'samma avsnitt sänds tidigare']]);
  assert.equal(dvr.previewRule({ title: 'Bron', newOnly: true, skipLibrary: false })[0].record, true);
  const rule = dvr.addRule({ title: 'Bron', newOnly: true, skipLibrary: true }, { id: 1 });
  assert.deepEqual(scheduled('Bron').map(r => r.program_id), [e2]);
  dvr.removeRule(rule);
});

test('konflikter i förväg: prioritet, alternativ sändning och automatisk flytt för serieinspelningar', () => {
  const { ch } = source(1);
  const t = at(8, 20);
  // Viktig film med hög prioritet på K0, serieavsnitt samtidigt på K1 – och samma avsnitt i repris senare
  const film = prog(ch[0], t, 7200, 'Storfilm');
  const ep = prog(ch[1], t + 1800, 1800, 'Morden', { season: 3, episode: 4 });
  const rerun = prog(ch[1], t + 86400, 1800, 'Morden', { season: 3, episode: 4 });
  const fid = dvr.scheduleProgram(film, { id: 1 }, null, { priority: 5 });
  const mid = dvr.scheduleProgram(ep, { id: 1 });
  let c = dvr.conflictList();
  assert.equal(c.length, 1);
  assert.equal(c[0].recording.id, mid); assert.equal(c[0].outcome, 'missed');
  assert.deepEqual(c[0].with.map(w => w.id), [fid]);
  assert.deepEqual(c[0].alternatives.map(a => a.programId), [rerun], 'reprisen föreslås');
  assert.equal(dvr.list().scheduled.find(r => r.id === mid).plan, 'missed');
  assert.equal(dvr.list().conflicts, 1);
  // Högre prioritet på avsnittet: nu avbryts filmen i stället
  dvr.updateRecording(mid, { priority: 9 });
  c = dvr.conflictList();
  assert.equal(c[0].recording.id, fid); assert.equal(c[0].outcome, 'cut');
  // Flytta avsnittet till reprisen: inga konflikter kvar, den gamla tiden är avbokad
  dvr.updateRecording(mid, { priority: 0 });
  const nid = dvr.swapRecording(mid, rerun, { id: 1 });
  assert.equal(get('SELECT status FROM recordings WHERE id=?', mid).status, 'cancelled');
  assert.equal(get('SELECT program_id FROM recordings WHERE id=?', nid).program_id, rerun);
  assert.equal(dvr.conflictList().length, 0);
  dvr.cancel(nid);
  // Serieinspelning väljer själv en sändning som får en tuner
  const ep5 = prog(ch[1], t + 3600, 1800, 'Morden', { season: 3, episode: 5 });
  const ep5b = prog(ch[0], t + 2 * 86400, 1800, 'Morden', { season: 3, episode: 5 });
  const rule = dvr.addRule({ title: 'Morden', newOnly: true }, { id: 1 });
  const booked = scheduled('Morden').map(r => r.program_id);
  assert.ok(booked.includes(ep5b) && !booked.includes(ep5), `ep 5 bokas i repris: ${booked}`);
  assert.equal(dvr.conflictList().length, 0);
  dvr.removeRule(rule); dvr.cancel(fid);
});

test('behåll senaste N rör inte inspelningar markerade "behåll alltid"', () => {
  const { ch } = source(2);
  const rule = Number(run("INSERT INTO dvr_rules(title,keep,created) VALUES('Sporten',1,0)").lastInsertRowid);
  const ids = [3, 2, 1].map(d => Number(run("INSERT INTO recordings(channel_id,rule_id,title,start,stop,status,created) VALUES(?,?,'Sporten',?,?,'done',0)", ch[0], rule, now() - d * 86400, now() - d * 86400 + 600).lastInsertRowid));
  dvr.updateRecording(ids[0], { keepForever: true });
  dvr.enforceKeep(rule);
  assert.deepEqual(all("SELECT id, status FROM recordings WHERE rule_id=? ORDER BY id", rule).map(r => r.status), ['done', 'deleted', 'done'], 'den äldsta behålls, mellersta tas bort, senaste behålls');
});

test('inspelning till MKV med metadata och NFO, namn som skannern känner igen', { skip: !hasFfmpeg, timeout: 120000 }, async () => {
  const { ch } = source(2);
  setSetting('dvr_format', 'mkv');
  const start = now() - 1;
  const pid = Number(run('INSERT INTO programs(channel_id,start,stop,title,subtitle,description,season,episode) VALUES(?,?,?,?,?,?,?,?)', ch[0], start, start + 6, 'Bron', 'Del 2', 'Saga & Martin', 1, 2).lastInsertRowid);
  const id = dvr.scheduleProgram(pid, { id: 1 });
  let r;
  for (let i = 0; i < 90; i++) { await sleep(1000); r = get('SELECT * FROM recordings WHERE id=?', id); if (['done', 'failed'].includes(r.status)) break; }
  assert.equal(r.status, 'done', r.error || '');
  assert.equal(r.file, path.join(process.env.DVR_DIR, 'Bron', 'Season 01', 'Bron - S01E02 - Del 2.mkv'));
  const tags = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name:format_tags', '-of', 'json', r.file]).toString()).format;
  assert.match(tags.format_name, /matroska/);
  const lower = Object.fromEntries(Object.entries(tags.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(lower.show, 'Bron'); assert.equal(lower.title, 'Del 2');
  const nfo = fs.readFileSync(r.file.replace(/\.mkv$/, '.nfo'), 'utf8');
  assert.match(nfo, /<showtitle>Bron<\/showtitle>/); assert.match(nfo, /<season>1<\/season>/); assert.match(nfo, /<episode>2<\/episode>/); assert.match(nfo, /Saga &amp; Martin/);
  const { parseEpisode } = await import('../server/parse.js');
  const p = parseEpisode(path.relative(process.env.DVR_DIR, r.file));
  assert.deepEqual([p.show, p.season, p.episode, p.epTitle], ['Bron', 1, 2, 'Del 2']);
  assert.ok(!fs.readdirSync(path.dirname(r.file)).some(f => f.endsWith('.ts')), 'TS-filen är borttagen');
  // Borttagning tar även NFO och tomma mappar
  dvr.removeRecording(id);
  assert.ok(!fs.existsSync(path.join(process.env.DVR_DIR, 'Bron')), 'tomma mappar tas bort');
  setSetting('dvr_format', 'mp4');
});

test('titta medan den spelas in: HLS av den växande filen, och högre prioritet tar tunern', { skip: !hasFfmpeg, timeout: 120000 }, async () => {
  const { tid, ch } = source(1);
  const low = dvr.scheduleManual({ channelId: ch[0], start: now() - 1, stop: now() + 120, title: 'Lång inspelning' }, { id: 1 });
  let r;
  for (let i = 0; i < 40; i++) { await sleep(500); r = get('SELECT * FROM recordings WHERE id=?', low); if (r.status === 'recording' && fs.existsSync(r.file) && fs.statSync(r.file).size > 600e3) break; }
  assert.equal(r.status, 'recording');
  assert.ok(path.basename(r.file).startsWith('.'), 'TS-filen är dold medan den spelas in');
  assert.ok(dvr.list().scheduled.find(x => x.id === low).watchable);
  const res = () => { const o = { code: 0, body: '', headers: {} }; o.writeHead = (c, h) => { o.code = c; Object.assign(o.headers, h); return o; }; o.setHeader = () => {}; o.end = (b) => { o.body += b ?? ''; }; return o; };
  const a = res();
  await dvr.serveGrowing(a, low, 'TOK');
  assert.equal(a.code, 200, a.body);
  assert.match(a.body, /#EXT-X-PLAYLIST-TYPE:EVENT/);
  assert.match(a.body, /seg-\d{5}\.ts\?t=TOK/);
  assert.deepEqual(growing.active(), [low]);
  // Inspelning med högre prioritet på samma källa (en tuner): den pågående stoppas och sparas
  const high = dvr.scheduleManual({ channelId: ch[1], start: now() - 1, stop: now() + 25, title: 'Viktig', priority: 5 }, { id: 1 });
  assert.equal(get('SELECT priority FROM recordings WHERE id=?', high).priority, 5);
  let h;
  for (let i = 0; i < 60; i++) { await sleep(500); h = get('SELECT * FROM recordings WHERE id=?', high); if (h.status !== 'scheduled') break; }
  assert.ok(['recording', 'processing', 'done'].includes(h.status), h.status + ' ' + (h.error || ''));
  const l = get('SELECT * FROM recordings WHERE id=?', low);
  assert.ok(['processing', 'done'].includes(l.status), l.status);
  assert.match(l.error || '', /högre prioritet/);
  for (let i = 0; i < 60; i++) { await sleep(1000); if (['done', 'failed'].includes(get('SELECT status FROM recordings WHERE id=?', high).status) && get('SELECT status FROM recordings WHERE id=?', low).status === 'done') break; }
  assert.equal(get('SELECT status FROM recordings WHERE id=?', low).status, 'done');
  assert.equal(get('SELECT status FROM recordings WHERE id=?', high).status, 'done');
  // Klar: spellistan av den växande filen finns inte längre att hämta
  const b = res();
  await dvr.serveGrowing(b, low, null);
  assert.equal(b.code, 404);
  void tid; void spawn;
});

test('spelaren: reklamavbrott hoppas över en gång och blir kapitel', async () => {
  const { adPlan, adChapters } = await import('../web/js/player/autoskip.js');
  const ads = [{ start: 600, end: 780 }, { start: 1500, end: 1620 }];
  assert.equal(adPlan(ads, 100), null);
  assert.deepEqual(adPlan(ads, 650, { auto: true }), { i: 0, to: 780, auto: true });
  assert.equal(adPlan(ads, 650, { auto: true, done: new Set([0]) }).auto, false, 'tillbakaspolad: titta');
  assert.equal(adPlan(ads, 779.5), null, 'sista sekunden räknas inte');
  assert.deepEqual(adChapters(ads, 2400).map(c => [c.label, c.start, c.end]), [['Del 1', 0, 600], ['Reklam', 600, 780], ['Del 2', 780, 1500], ['Reklam', 1500, 1620], ['Del 3', 1620, 2400]]);
  assert.deepEqual(adChapters([{ start: 2, end: 90 }], 90).map(c => c.label), ['Reklam'], 'reklam direkt i början, inget kort slut');
});
