// Automatisk synkning av undertexter (server/subsync.js): repliker mot talaktivitet i ljudet. Testfilerna skapas med
// ffmpeg: toner i ett känt mönster (och, om ffmpeg har flite, syntetiskt tal över bakgrundsmusik) och SRT-filer som är
// förskjutna 2,5 s eller gjorda för en annan bildfrekvens. Förskjutningen ska hittas inom ±0,15 s. Sist API:t mot en
// riktig server: starta synk, förlopp, sparad justering i /api/stream/:id/subs, cache, manuell justering och Ångra.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasFlite = hasFfmpeg && /flite/.test(spawnSync('ffmpeg', ['-hide_banner', '-filters']).stdout?.toString() || '');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-sync-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 24000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
process.env.CONFIG_DIR = path.join(ROOT, 'unitconfig');
process.env.TRANSCODE_DIR = path.join(ROOT, 'unit-tc');
const ss = await import('../server/subsync.js');
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
let srv;
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const NTSC = 24000 / 1001;
const SR = 16000;
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const srtTime = (x) => { const ms = Math.round(Math.max(0, x) * 1000); const h = Math.floor(ms / 3600e3), m = Math.floor(ms / 60e3) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const srt = (cues) => cues.map((c, i) => `${i + 1}\n${srtTime(c.s)} --> ${srtTime(c.e)}\nReplik nummer ${i + 1}\n`).join('\n');
/** PCM (16 kHz mono) med svagt brus → mkv med ffmpeg */
function writeMedia(file, dur, paint) {
  const buf = Buffer.alloc(SR * dur * 2);
  for (let i = 0; i < SR * dur; i++) buf.writeInt16LE(Math.round((rnd() - 0.5) * 300), i * 2);
  paint(buf);
  const pcm = file + '.pcm';
  fs.writeFileSync(pcm, buf);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', String(SR), '-ac', '1', '-i', pcm, '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  fs.rmSync(pcm);
}
const mix = (buf, at, i, v) => { const k = (Math.floor(at * SR) + i) * 2; if (k + 1 < buf.length) buf.writeInt16LE(Math.max(-32768, Math.min(32767, buf.readInt16LE(k) + Math.round(v))), k); };
/** Tonskurar 0,8–3 s med pauser 0,4–2,5 s – "repliker" med kända tider */
function toneFile(file, dur = 240) {
  const bursts = [];
  for (let x = 3; x < dur - 5;) { const d = 0.8 + rnd() * 2.2; bursts.push({ s: x, e: x + d }); x += d + 0.4 + rnd() * 2.1; }
  writeMedia(file, dur, (buf) => bursts.forEach((b, k) => {
    const f = 300 + (k % 7) * 120;
    for (let i = 0; i < (b.e - b.s) * SR; i++) mix(buf, b.s, i, 9000 * Math.sin(2 * Math.PI * f * i / SR));
  }));
  return bursts;
}
const maxErr = (r, cues, truth) => Math.max(...cues.map((c, i) => Math.abs(c.s * r.ratio + r.offset - truth[i].s)));
async function speechOf(file, dur) { return ss.voiced(await ss.decodeEnergy(file, { duration: dur })); }

test('parseCues: tider ur WebVTT/SRT, icke-tal och orimligt långa repliker bort', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHej\n\n00:00:03,000 --> 00:00:04,000 align:start\n<i>Kursiv</i>\n\n'
    + '00:00:05.000 --> 00:00:06.000\n[MUSIK]\n\n00:00:07.000 --> 00:00:08.000\n♪ la la la ♪\n\n01:00:00.000 --> 01:00:30.000\nFör lång\n\n'
    + '00:00:09.000 --> 00:00:08.000\nBaklänges\n\n1:02:03.250 --> 1:02:04.000\n(skratt) Nej då\n';
  assert.deepEqual(ss.parseCues(vtt), [{ s: 1, e: 2.5 }, { s: 3, e: 4 }, { s: 3723.25, e: 3724 }]);
  assert.deepEqual(ss.parseCues(''), []);
});

let tones, toneSpeech;
const TONES = path.join(ROOT, 'toner.mkv');
before(async () => {
  if (!hasFfmpeg) return;
  tones = toneFile(TONES);
  toneSpeech = await speechOf(TONES, 240);
});

t('talaktivitet: tonerna hittas som tal, pauserna som tystnad', () => {
  assert.ok(Math.abs(toneSpeech.length - 24000) < 50, `ramar per 10 ms (${toneSpeech.length})`);
  let hit = 0, tot = 0;
  for (const b of tones) for (let x = Math.ceil((b.s + 0.15) * 100); x < (b.e - 0.15) * 100; x++) { tot++; hit += toneSpeech[x]; }
  assert.ok(hit / tot > 0.97, `tal i skurarna (${(hit / tot).toFixed(3)})`);
  let quiet = 0, qt = 0;
  for (let k = 0; k + 1 < tones.length; k++) for (let x = Math.ceil((tones[k].e + 0.15) * 100); x < (tones[k + 1].s - 0.15) * 100; x++) { qt++; quiet += 1 - toneSpeech[x]; }
  assert.ok(quiet / qt > 0.9, `tystnad i pauserna (${(quiet / qt).toFixed(3)})`);
});

t('förskjuten 2,5 s: hittas inom ±0,15 s, ingen kvot', () => {
  const cues = tones.map(b => ({ s: b.s + 2.5, e: b.e + 2.5 }));
  const r = ss.align(toneSpeech, cues);
  assert.equal(r.confident, true); assert.equal(r.ratio, 1); assert.equal(r.fps, null);
  assert.ok(Math.abs(r.offset + 2.5) <= 0.15, `förskjutning ${r.offset}`);
  assert.ok(maxErr(r, cues, tones) <= 0.15);
  // Åt andra hållet och längre
  const r2 = ss.align(toneSpeech, tones.map(b => ({ s: b.s - 40, e: b.e - 40 })));
  assert.ok(r2.confident && Math.abs(r2.offset - 40) <= 0.15, `förskjutning ${r2.offset}`);
});

t('25 ↔ 23,976 bilder/s: kvoten och förskjutningen hittas, alla repliker inom ±0,15 s', () => {
  // Undertext gjord för en 25-bilders utgåva (4 % kortare tider) och dessutom 1 s fel
  const R = 25 / NTSC;
  const pal = tones.map(b => ({ s: b.s / R + 1, e: b.e / R + 1 }));
  const r = ss.align(toneSpeech, pal);
  assert.equal(r.confident, true);
  assert.deepEqual(r.fps, { from: 25, to: 23.976 });
  assert.ok(Math.abs(r.ratio - R) < 1e-9);
  assert.ok(maxErr(r, pal, tones) <= 0.15, `största fel ${maxErr(r, pal, tones)}`);
  // Omvänt: gjord för 23,976, filmen är en 25-bilders utgåva
  const ntsc = tones.map(b => ({ s: b.s * R - 0.7, e: b.e * R - 0.7 }));
  const r2 = ss.align(toneSpeech, ntsc);
  assert.deepEqual(r2.fps, { from: 23.976, to: 25 });
  assert.ok(maxErr(r2, ntsc, tones) <= 0.15, `största fel ${maxErr(r2, ntsc, tones)}`);
});

t('undertext till något annat: osäker, ingen justering', () => {
  seed = 99;
  const other = [];
  for (let x = 2; x < 230;) { const d = 1 + rnd() * 3; other.push({ s: x, e: x + d }); x += d + 0.3 + rnd() * 3; }
  assert.equal(ss.align(toneSpeech, other).confident, false);
});

test('syntetiskt tal över bakgrundsmusik (flite): förskjutningen hittas', { skip: (!hasFlite && 'ffmpeg saknar flite') }, async () => {
  seed = 11;
  const WORDS = 'the quick brown fox jumps over a lazy dog while seven small boats drift slowly toward the harbor and nobody knows why the light is still on'.split(' ');
  const clips = [];
  for (let k = 0; k < 40; k++) {
    const txt = Array.from({ length: 3 + Math.floor(rnd() * 8) }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
    clips.push(execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `flite=text='${txt}'`, '-ar', String(SR), '-ac', '1', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 26 }));
  }
  const lines = []; let x = 2;
  for (const c of clips) { const d = c.length / 2 / SR; lines.push({ s: x, e: x + d, c }); x += d + 0.3 + rnd() * 3; }
  const dur = Math.ceil(x + 3), file = path.join(ROOT, 'tal.mkv');
  writeMedia(file, dur, (buf) => {
    for (let i = 0; i < dur * SR; i++) mix(buf, 0, i, 2500 * Math.sin(2 * Math.PI * 220 * i / SR) * (0.5 + 0.5 * Math.sin(i / SR)) + 1500 * Math.sin(2 * Math.PI * 330 * i / SR));
    for (const l of lines) for (let i = 0; i < l.c.length / 2; i++) mix(buf, l.s, i, l.c.readInt16LE(i * 2));
  });
  const sp = await speechOf(file, dur);
  const cues = lines.map(l => ({ s: l.s + 2.5, e: l.e + 2.5 }));
  const r = ss.align(sp, cues);
  assert.equal(r.confident, true);
  assert.ok(Math.abs(r.offset + 2.5) <= 0.15, `förskjutning ${r.offset}`);
  const R = 25 / NTSC, pal = lines.map(l => ({ s: l.s / R, e: l.e / R }));
  const r2 = ss.align(sp, pal);
  assert.deepEqual(r2.fps, { from: 25, to: 23.976 });
  assert.ok(maxErr(r2, pal, lines) <= 0.15, `största fel ${maxErr(r2, pal, lines)}`);
});

// ---------------- API mot en riktig server ----------------
let cookie = '';
async function req(p, { method = 'GET', body } = {}) {
  const h = {};
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc) && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const vttStarts = (vtt) => [...vtt.matchAll(/^((?:\d+:)?\d{2}:\d{2}\.\d{3}) -->/gm)].map(m => m[1].split(':').reduce((a, v) => a * 60 + +v, 0));

t('API: synka en extern undertext, sparad justering i strömmen, cache, finjustering och Ångra', async () => {
  const dir = path.join(MEDIA, 'Filmer', 'Toner (2020)');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(TONES, path.join(dir, 'Toner (2020).mkv'));
  fs.writeFileSync(path.join(dir, 'Toner (2020).sv.srt'), srt(tones.map(b => ({ s: b.s + 2.5, e: b.e + 2.5 }))));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } })).status, 200);
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(MEDIA, 'Filmer') } })).status, 200);
  const lib = (await req('/api/libraries')).data.find(l => l.type === 'movie');
  let id;
  for (let i = 0; i < 60 && !id; i++) { await sleep(500); id = (await req(`/api/libraries/${lib.id}/items`)).data.items?.[0]?.id; }
  assert.ok(id, 'filmen skannades');
  assert.equal((await req('/api/me/playback-prefs')).data.autoSync, true, 'automatisk synk är på från början');

  let pb = (await req(`/api/items/${id}/playback?info=1`)).data;
  const sub = pb.subtitles.find(s => s.source === 'external');
  assert.ok(sub, 'den externa undertexten finns'); assert.equal(sub.syncable, true); assert.equal(sub.sync, undefined);
  assert.equal(pb.subAutoSync, true);
  const url = `/api/items/${id}/subs/${sub.id}/sync`;
  assert.equal((await req(`/api/items/${id}/subs/e9/sync`)).status, 400);
  const before = vttStarts((await req(`/api/stream/${id}/subs/${sub.id}.vtt`)).data);
  assert.ok(Math.abs(before[0] - tones[0].s - 2.5) < 0.01);

  let st = (await req(url, { method: 'POST', body: { audio: null } })).data;
  assert.ok(['queued', 'running', 'done'].includes(st.job.state));
  for (let i = 0; i < 120 && ['queued', 'running'].includes(st.job.state); i++) { await sleep(250); st = (await req(url)).data; }
  assert.equal(st.job.state, 'done', JSON.stringify(st.job));
  assert.ok(Math.abs(st.job.result.offset + 2.5) <= 0.15, `förskjutning ${st.job.result.offset}`);
  assert.deepEqual(st.job.previous, { offset: 0, ratio: 1 });
  assert.equal(st.offset, st.job.result.offset); assert.equal(st.ratio, 1);
  // Servern lägger på synken: replikerna hamnar på tonerna (för alla klienter, även apparna)
  let after = vttStarts((await req(`/api/stream/${id}/subs/${sub.id}.vtt?sv=1`)).data);
  assert.ok(after.every((x, i) => Math.abs(x - tones[i].s) <= 0.15), 'alla repliker inom ±0,15 s');
  pb = (await req(`/api/items/${id}/playback?info=1`)).data;
  assert.equal(pb.subtitles.find(s => s.id === sub.id).sync.offset, st.offset);
  // Klientens egen offset= läggs till ovanpå
  const extra = vttStarts((await req(`/api/stream/${id}/subs/${sub.id}.vtt?offset=1&sv=2`)).data);
  assert.ok(Math.abs(extra[0] - after[0] - 1) < 0.01);

  // Manuell finjustering sparas, Ångra = tillbaka till föregående värde
  st = (await req(url, { method: 'PUT', body: { offset: st.offset + 0.2, ratio: 1 } })).data;
  assert.ok(Math.abs(st.offset - st.auto.offset - 0.2) < 0.001);
  assert.equal((await req(url, { method: 'PUT', body: { offset: 'x' } })).status, 400);
  // Igen: det sparade automatiska resultatet används direkt (ingen ny avkodning)
  st = (await req(url, { method: 'POST', body: {} })).data;
  assert.equal(st.job.state, 'done'); assert.equal(st.job.result.cached, true);
  assert.ok(Math.abs(st.job.previous.offset - st.offset - 0.2) < 0.001, 'Ångra går tillbaka till den manuella justeringen');
  st = (await req(url, { method: 'PUT', body: { offset: 0, ratio: 1 } })).data;
  assert.equal(st.offset, 0);
  after = vttStarts((await req(`/api/stream/${id}/subs/${sub.id}.vtt?sv=3`)).data);
  assert.deepEqual(after, before, 'utan justering: filens egna tider');
  assert.equal((await req(`/api/items/${id}/playback?info=1`)).data.subtitles.find(s => s.id === sub.id).sync, undefined);
  // Taltidslinjen är cachad per fil och ljudspår
  assert.ok(fs.readdirSync(path.join(CONFIG, 'cache', 'subsync')).some(f => f.startsWith(id + '-')));
});
