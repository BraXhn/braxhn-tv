// Expo-appens ljudbok och poddavsnitt i kön (apps/expo/src/music.ts), som webben (spokenQueue/restoreSpoken i
// web/js/audio.js): när talet startar sparas det i /api/me/queue med spoken, och efter omstart visas det pausat på
// profilens position utan att någon ljudfil laddas eller något framsteg skickas (skärmtid, lyssnad tid) förrän Spela.
// Telefonens spelare (expo-audio), filsystemet och servern är låtsade (test/helpers/expo-loader.mjs, expo-fakes.mjs).
// Node 22.18+ läser TypeScript utan byggsteg; äldre Node hoppar över testerna.
import test from 'node:test';
import assert from 'node:assert/strict';

const skip = process.features?.typescript ? false : 'Node utan TypeScript-stöd';
let M = null, F = null, off = null, core = null;
if (!skip) {
  const { register } = await import('node:module');
  register('./helpers/expo-loader.mjs', import.meta.url);
  (await import('../apps/expo/src/i18n.ts')).setLangChoice('sv');
  F = await import('./helpers/expo-fakes.mjs');
  off = await import('../apps/expo/src/offline.ts');
  core = await import('../apps/expo/src/offlinecore.ts');
  M = await import('../apps/expo/src/music.ts');
}
const SRV = 'https://tv.example.com';
const tick = () => new Promise((r) => setTimeout(r, 5));

// ---------- låtsasservern ----------
const BOOK = { id: 9, title: 'Boken', author: 'A', narrator: null, cover: true, duration: 7200, position: 1800, speed: 1.25, finished: false,
  chapters: [{ start: 0, title: 'Ett' }, { start: 3600, title: 'Två' }], files: [{ id: 1, offset: 0, duration: 3600, codec: 'mp3' }, { id: 2, offset: 3600, duration: 3600, codec: 'mp3' }] };
const EP = { id: 44, podcast: 5, podcastTitle: 'Podden', title: 'Avsnitt 44', duration: 3000, position: 600, played: false };
const srv = { queue: null, book: { ...BOOK }, ep: { ...EP }, slowPut: 0 };
async function routes(path, o) {
  if (path === '/api/me/queue') {
    if (o.method === 'GET' || !o.method) return srv.queue || { tracks: [], idx: -1, pos: 0, repeat: false, radio: null, spoken: null };
    if (o.method === 'PUT' && o.body?.ids?.length && srv.slowPut) await new Promise((r) => setTimeout(r, srv.slowPut));
    return { ok: true };
  }
  let m;
  if ((m = /^\/api\/audiobooks\/book\/(\d+)\/play/.exec(path))) return { ...srv.book, id: +m[1], token: 'x', files: srv.book.files.map((f) => ({ ...f, url: `/api/audiobooks/files/${f.id}/stream?t=x` })) };
  if ((m = /^\/api\/audiobooks\/book\/(\d+)\/progress$/.exec(path))) return { ok: true };
  if ((m = /^\/api\/audiobooks\/book\/(\d+)$/.exec(path))) return { ...srv.book, id: +m[1] };
  if ((m = /^\/api\/podcasts\/episodes\/(\d+)\/play$/.exec(path))) return { url: `/api/podcasts/episodes/${m[1]}/stream?t=x` };
  if ((m = /^\/api\/podcasts\/episodes\/(\d+)\/progress$/.exec(path))) return { ok: true };
  if ((m = /^\/api\/podcasts\/episodes\/(\d+)$/.exec(path))) return { ...srv.ep, id: +m[1] };
  if (/^\/api\/music\/tracks\/\d+\/play$/.test(path)) return { url: '/api/music/stream?t=x' };
  if (/^\/api\/music\/tracks\/\d+\/played$/.test(path)) return {};
  if (path === '/api/screentime') return { limited: false };
  throw new Error('okänd sökväg ' + path);
}
const calls = (re, method) => F.fsState.apiCalls.filter((c) => re.test(c.path) && (!method || c.method === method));
/** Telefonen har laddat filen: spelaren spolar då till platsen (onStatus i music.ts) */
const loaded = (p) => {
  p.isLoaded = true;
  const st = () => ({ isLoaded: true, playing: p.playing, isBuffering: false, currentTime: p.at, duration: 3600 });
  p.listeners.forEach((fn) => fn(st())); // spolar
  p.listeners.forEach((fn) => fn(st())); // nästa rapport: platsen efter spolningen
  return p;
};
const progressCalls = () => calls(/\/progress$/);
const playCalls = () => calls(/\/play(\?|$)/);
async function fresh(uid = 1) {
  M.reset(false); await tick();
  F.fsState.apiCalls.length = 0; F.audioState.reset();
  F.session.server = SRV; F.session.userId = uid;
  F.fsState.api = routes;
  srv.queue = null; srv.book = { ...BOOK }; srv.ep = { ...EP }; srv.slowPut = 0;
}

test('en bok som startar i appen sparas i kön (PUT med spoken), musikkön tas inte bort', { skip }, async () => {
  await fresh();
  await M.playTracks([{ id: 1, title: 'Låt', duration: 200, codec: 'mp3' }], 0);
  await M.playBook(9);
  await tick();
  const puts = calls(/^\/api\/me\/queue$/, 'PUT');
  assert.deepEqual(puts.at(-1).body, { uid: 1, ids: [], spoken: { kind: 'book', id: 9 } });
  assert.equal(calls(/^\/api\/me\/queue$/, 'DELETE').length, 0, 'boken ersätter kön i stället för att ta bort den');
  const s = M.nowPlaying.get();
  assert.equal(s.mode, 'book'); assert.equal(s.pos, 1800); assert.equal(s.playing, false);
  assert.equal(F.audioState.players.at(-1).playing, true, 'boken spelar');
});

test('ett poddavsnitt som startar sparas i kön på samma sätt', { skip }, async () => {
  await fresh(3);
  await M.playEpisode(44);
  await tick();
  assert.deepEqual(calls(/^\/api\/me\/queue$/, 'PUT').at(-1).body, { uid: 3, ids: [], spoken: { kind: 'podcast', id: 44 } });
});

test('musikkön som är på väg skriver inte över boken (boken skickas efter)', { skip }, async () => {
  await fresh();
  await M.playTracks([{ id: 1, title: 'Låt', duration: 200, codec: 'mp3' }], 0);
  srv.slowPut = 40;
  const order = [];
  const real = F.fsState.api;
  F.fsState.api = async (p, o) => { const r = await real(p, o); if (p === '/api/me/queue' && o.method === 'PUT') order.push(o.body.spoken ? 'bok' : 'musik'); return r; };
  M.pause(); // sparar musikkön (långsamt svar)
  await M.playBook(9);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(order, ['musik', 'bok']);
});

test('efter omstart: boken visas pausad på positionen – ingen fil laddas och inget framsteg skickas förrän Spela', { skip }, async () => {
  await fresh();
  srv.queue = { tracks: [], idx: -1, pos: 0, repeat: false, radio: null, spoken: { kind: 'book', id: 9, position: 1800 } };
  await M.restoreQueue();
  let s = M.nowPlaying.get();
  assert.equal(s.mode, 'book'); assert.equal(s.book.title, 'Boken'); assert.equal(s.book.chapters.length, 2);
  assert.equal(s.pos, 1800); assert.equal(s.dur, 7200); assert.equal(s.rate, 1.25); assert.equal(s.playing, false);
  assert.equal(F.audioState.players.length, 0, 'ingen ljudfil');
  assert.equal(playCalls().length, 0, 'ingen /play (den kontrollerar skärmtiden och ger en mediatoken)');
  // Hopp flyttar bara platsen; paus, hastighet och att appen sparar före profilbyte skickar inget
  M.skip(-15); M.seek(3700); M.setRate(1.5); M.pause(); await M.saveNow(); await tick();
  s = M.nowPlaying.get();
  assert.equal(s.pos, 3700); assert.equal(s.playing, false);
  assert.equal(progressCalls().length, 0, 'inget framsteg: skärmtid och lyssnad tid räknas inte');
  assert.equal(F.audioState.players.length, 0);
  // Spela: boken startar där platsen står nu, och först då räknas den
  await M.toggle();
  s = M.nowPlaying.get();
  assert.equal(playCalls().length, 1);
  const p = loaded(F.audioState.players.at(-1));
  assert.match(p.source.uri, /files\/2\/stream/, 'andra filen (3700 s är i den)');
  assert.equal(p.at, 100); assert.equal(p.playing, true);
  assert.equal(s.pos, 3700);
  M.pause(); await tick();
  assert.equal(progressCalls().length, 1, 'efter Spela sparas positionen som vanligt');
  assert.equal(progressCalls()[0].body.position, 3700);
});

test('efter omstart: nästan slut börjar om, lyssnat avsnitt börjar från början', { skip }, async () => {
  await fresh();
  srv.book.position = 7190;
  srv.queue = { tracks: [], spoken: { kind: 'book', id: 9, position: 7190 } };
  await M.restoreQueue();
  assert.equal(M.nowPlaying.get().pos, 0, 'under 30 s kvar: från början, som webben');
  await fresh();
  srv.ep.played = true;
  srv.queue = { tracks: [], spoken: { kind: 'podcast', id: 44, position: 0 } };
  await M.restoreQueue();
  const s = M.nowPlaying.get();
  assert.equal(s.mode, 'podcast'); assert.equal(s.episode.title, 'Avsnitt 44'); assert.equal(s.pos, 0); assert.equal(s.playing, false);
  assert.equal(F.audioState.players.length, 0);
  await M.toggle();
  assert.match(F.audioState.players.at(-1).source.uri, /episodes\/44\/stream/);
});

test('efter omstart: per profil – en annan profil som hunnit logga in får inte boken', { skip }, async () => {
  await fresh(1);
  srv.queue = { tracks: [], spoken: { kind: 'book', id: 9, position: 1800 } };
  const real = F.fsState.api;
  F.fsState.api = async (p, o) => { if (/^\/api\/audiobooks\/book\/9$/.test(p)) F.session.userId = 2; return real(p, o); };
  await M.restoreQueue();
  assert.equal(M.nowPlaying.get().mode, null);
  F.fsState.api = real;
});

test('efter omstart: krysset tar bort boken ur kön utan att räkna något', { skip }, async () => {
  await fresh();
  srv.queue = { tracks: [], spoken: { kind: 'book', id: 9, position: 1800 } };
  await M.restoreQueue();
  await M.close(); await tick();
  assert.equal(M.nowPlaying.get().mode, null);
  assert.equal(calls(/^\/api\/me\/queue$/, 'DELETE').length, 1);
  assert.equal(progressCalls().length, 0);
});

test('efter omstart: en nedladdad bok spelas från telefonen när man trycker Spela', { skip }, async () => {
  await fresh();
  globalThis.__os = 'android';
  // Boken är nedladdad i profilens mapp (som efter downloadBook)
  const e = { ...core.bookEntry({ ...BOOK, files: BOOK.files }), state: 'done' };
  e.files = e.files.map((f) => ({ ...f, done: true, size: 10 }));
  const dir = new F.Directory('mem:/doc/offline/' + core.scopeOf('srv1', 1));
  dir.create();
  for (const f of e.files) new F.File(dir, f.name).writeSync('ljud');
  new F.File(dir, 'list.json').writeSync(JSON.stringify({ list: [e] }));
  off.openScope('srv1', { id: 1, name: 'Anna' });
  assert.ok(off.localBook(9), 'boken finns i telefonen');
  srv.queue = { tracks: [], spoken: { kind: 'book', id: 9, position: 1800 } };
  await M.restoreQueue();
  assert.equal(F.audioState.players.length, 0);
  await M.toggle();
  const p = loaded(F.audioState.players.at(-1));
  assert.match(p.source.uri, /^mem:\/doc\/offline\/.*b9\.0\.audio$/, 'filen i telefonen');
  assert.equal(p.at, 1800); assert.equal(p.playing, true);
  assert.equal(playCalls().length, 0, 'ingen ström från servern');
  assert.deepEqual(calls(/^\/api\/me\/queue$/, 'PUT').at(-1).body, { uid: 1, ids: [], spoken: { kind: 'book', id: 9 } });
});

test('musikkön efter omstart fungerar som förut', { skip }, async () => {
  await fresh();
  srv.queue = { tracks: [{ id: 1, title: 'Låt', duration: 200, codec: 'mp3' }, { id: 2, title: 'Två', duration: 100, codec: 'mp3' }], idx: 1, pos: 30, repeat: false, radio: null, spoken: null };
  await M.restoreQueue();
  const s = M.nowPlaying.get();
  assert.equal(s.mode, 'music'); assert.equal(s.idx, 1); assert.equal(s.pos, 30); assert.equal(F.audioState.players.length, 0);
});
