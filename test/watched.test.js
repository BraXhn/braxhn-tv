// När en film eller ett avsnitt räknas som sett (server/resume.js isWatched) – för korta och långa titlar. Förr
// räckte det med att under 2 minuter var kvar, så ett avsnitt på 5 minuter blev sett efter 3:01 och försvann ur
// Fortsätt titta. Nu: sett när eftertexterna börjat (markeringen credits_start), annars när högst 8 % är kvar.
// Samma regel i Expo-appen (apps/expo/src/offlinecore.ts) och Android-appen (OfflineCore.kt, Watched).
// Sista delen kör en riktig server (som övriga servertester, kräver ffmpeg) och skickar framsteg till titlarna.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './helpers/port.js';
import { isWatched, WATCHED_LEFT, CREDITS_FROM } from '../server/resume.js';

// Servern för sista testet (porten hämtas före första test())
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-sett-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = await freePort();

// [position, längd, eftertexter (eller null), sett?, varför]
const CASES = [
  // 3 minuter
  [61, 180, null, false, '3 min: en minut in är inte sett (förr: sett)'],
  [150, 180, null, false, '3 min: en halv minut kvar är inte sett (förr: sett)'],
  [166, 180, null, true, '3 min: 14 s kvar (under 8 %)'],
  [150, 180, 150, true, '3 min: eftertexterna har börjat'],
  [140, 180, 150, false, '3 min: före eftertexterna'],
  // 5 minuter
  [181, 300, null, false, '5 min: 3:01 är inte sett (förr: sett)'],
  [240, 300, null, false, '5 min: en minut kvar är inte sett (förr: sett)'],
  [276, 300, null, true, '5 min: 24 s kvar'],
  [272, 300, 270, true, '5 min: eftertexterna har börjat'],
  // 22 minuter
  [1201, 1320, null, false, '22 min: 1:59 kvar är inte sett ännu (förr: sett)'],
  [1215, 1320, null, true, '22 min: 1:45 kvar (8 %)'],
  [1250, 1320, 1240, true, '22 min: eftertexterna har börjat'],
  [500, 1320, 400, false, '22 min: en markering före halva titeln räknas inte'],
  // 120 minuter
  [6510, 7200, 6500, true, '2 tim: långa eftertexter (11,5 min) har börjat (förr: inte sett)'],
  [6700, 7200, null, true, '2 tim: utan markering, 8:20 kvar'],
  [6500, 7200, null, false, '2 tim: utan markering, 11:40 kvar'],
  [7100, 7200, null, true, '2 tim: nästan slut'],
  [3600, 7200, 6900, false, '2 tim: halvvägs'],
  // okänt
  [100, 0, null, false, 'okänd längd'],
  [0, 300, null, false, 'ingen position'],
  [300, 300, 9999, true, 'markering efter slutet: längden räcker'],
];

test('isWatched: korta och långa titlar, med och utan eftertexter', () => {
  assert.equal(WATCHED_LEFT, 0.08); assert.equal(CREDITS_FROM, 0.5);
  for (const [pos, dur, credits, want, why] of CASES) assert.equal(isWatched(pos, dur, credits), want, why);
});

test('Expo-appens kopia (offlinecore.ts) ger samma svar', { skip: process.features?.typescript ? false : 'Node utan TypeScript-stöd' }, async () => {
  const { register } = await import('node:module');
  register('./helpers/expo-loader.mjs', import.meta.url);
  const c = await import('../apps/expo/src/offlinecore.ts');
  for (const [pos, dur, credits, want, why] of CASES) assert.equal(c.isWatched(pos, dur, credits), want, why);
  // Spelaren använder regeln, inte en egen formel
  const player = fs.readFileSync(new URL('../apps/expo/src/screens/Player.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(player, /0\.92|< ?120 && secs/);
  assert.match(player, /isWatched\(/);
});

test('Android-appens kopia (OfflineCore.kt) har samma gränser och ingen gammal formel', () => {
  const kt = fs.readFileSync(new URL('../apps/automotive/app/src/main/java/net/braxhn/tv/OfflineCore.kt', import.meta.url), 'utf8');
  const w = kt.match(/object Watched \{[\s\S]*?\n\}/)?.[0];
  assert.ok(w, 'object Watched saknas');
  assert.match(w, /LEFT = 0\.08\b/); assert.match(w, /CREDITS_FROM = 0\.5\b/);
  assert.doesNotMatch(kt, /0\.92/);
  assert.match(kt.match(/object ResumePoint \{[\s\S]*?\n\}/)?.[0] || '', /Watched\.isWatched\(/);
});

test('servern använder regeln i framstegen (även IPTV-filmer)', () => {
  const lib = fs.readFileSync(new URL('../server/routes/library.js', import.meta.url), 'utf8');
  const vod = fs.readFileSync(new URL('../server/iptv/vod.js', import.meta.url), 'utf8');
  for (const src of [lib, vod]) { assert.doesNotMatch(src, /0\.92/); assert.match(src, /isWatched\(/); }
});

// ---------- mot en riktig server ----------
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, token = '';
const S = {};
async function req(p, { method = 'GET', body } = {}) {
  const h = {};
  if (token) h.authorization = 'Bearer ' + token;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(MEDIA, { recursive: true });
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1), TMDB_API_KEY: '', WATCH_FILES: '0', BOOK_METADATA: '0' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

t('framsteg till servern: 3-, 5-, 22- och 120-minuterstitlar', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } })).status, 200);
  token = (await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true } })).data.token;
  assert.ok(token);
  for (let i = 0; i < 60; i++) { if ((await req('/api/scan')).data.last) break; await sleep(250); }
  const db = new DatabaseSync(path.join(CONFIG, 'braxhn-tv.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const lib = Number(db.prepare('INSERT INTO libraries(name,type,path) VALUES(?,?,?)').run('Filmer', 'movie', path.join(MEDIA, 'saknas')).lastInsertRowid);
  const ins = db.prepare(`INSERT INTO items(library_id,kind,title,sort_title,year,duration,credits_start,age,added) VALUES(?,?,?,?,2020,?,?,7,1000)`);
  const item = (title, dur, credits = null) => Number(ins.run(lib, 'movie', title, title.toLowerCase(), dur, credits).lastInsertRowid);
  S.k3 = item('Tre minuter', 180); S.k5 = item('Fem minuter', 300, 270); S.k22 = item('Tjugotvå minuter', 1320);
  S.f120 = item('Två timmar', 7200, 6500);
  db.close();
  const prog = async (id, position) => (await req(`/api/items/${id}/progress`, { method: 'POST', body: { position } })).data.watched;
  const cont = async () => (await req('/api/home')).data.continue.map(i => i.id);
  // Före eftertexterna och med mer än 8 % kvar: påbörjad, syns i Fortsätt titta
  assert.equal(await prog(S.k3, 150), false, '3 min vid 2:30');
  assert.equal(await prog(S.k5, 181), false, '5 min vid 3:01');
  assert.equal(await prog(S.k22, 1201), false, '22 min vid 20:01');
  assert.equal(await prog(S.f120, 6400), false, '2 tim före eftertexterna');
  const c = await cont();
  for (const id of [S.k3, S.k5, S.k22, S.f120]) assert.ok(c.includes(id), `${id} i Fortsätt titta`);
  // Slutet: 8 % kvar eller eftertexterna har börjat
  assert.equal(await prog(S.k3, 168), true, '3 min, 12 s kvar');
  assert.equal(await prog(S.k5, 272), true, '5 min, eftertexterna');
  assert.equal(await prog(S.k22, 1220), true, '22 min, 1:40 kvar');
  assert.equal(await prog(S.f120, 6520), true, '2 tim, eftertexterna går');
  const c2 = await cont();
  for (const id of [S.k3, S.k5, S.k22, S.f120]) assert.ok(!c2.includes(id), `${id} inte längre i Fortsätt titta`);
});
