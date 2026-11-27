// Expo-appens nedladdning för offline: logiken utan telefonens filsystem (apps/expo/src/offlinecore.ts) – kön,
// positioner som väntar på nätet, val av lokal fil, undertexter, skärmtid utan nät och vart appen startar utan nät.
// Det som kräver en telefon (filsystemet, nedladdningen i bakgrunden, flygplansläge) provas inte här.
// Node 22.18+ läser TypeScript utan byggsteg; äldre Node hoppar över testerna.
import test from 'node:test';
import assert from 'node:assert/strict';

// Saknas modulen eller har den ett fel ska testet falla, inte hoppas över: bara Node utan TypeScript hoppar över
const skip = process.features?.typescript ? false : 'Node utan TypeScript-stöd';
// Lastaren först: offlinecore.ts importerar i18n.ts utan filändelse (som Metro). Texterna provas på svenska här
// (Node säger annars sitt eget språk, ofta en-US); engelskan provas i test/expo-i18n.test.js.
if (!skip) {
  const { register } = await import('node:module');
  register('./helpers/expo-loader.mjs', import.meta.url);
  (await import('../apps/expo/src/i18n.ts')).setLangChoice('sv');
}
const c = skip ? null : await import('../apps/expo/src/offlinecore.ts');

const movie = { id: 7, kind: 'movie', title: 'Filmen', year: 2020, duration: 5400, position: 600 };
const ep = (n, s = 1, id = 100 + n) => ({ id, kind: 'episode', title: 'Avsnitt ' + n, show: 50, showTitle: 'Serien', season: s, episode: n, duration: 1500 });

test('poster: nyckel, mapp per server och profil, film och bok', { skip }, () => {
  assert.equal(c.keyOf('movie', 7), 'v7');
  assert.equal(c.keyOf('episode', 7), 'v7');
  assert.equal(c.keyOf('book', 7), 'b7');
  assert.equal(c.scopeOf('abc123', 4), 'abc123-4');
  assert.equal(c.scopeOf('../x', 4), 'x-4', 'inga konstiga tecken i mappnamnet');
  assert.notEqual(c.scopeOf('abc', 4), c.scopeOf('abc', 5), 'två profiler har var sin mapp');
  assert.equal(c.scopeOfServer('abc-4', 'abc'), true);
  assert.equal(c.scopeOfServer('abcd-4', 'abc'), false, 'en annan server med liknande id');
  const e = c.videoEntry(movie, '480', 1000);
  assert.equal(e.key, 'v7'); assert.equal(e.state, 'queued'); assert.equal(e.q, '480');
  assert.equal(e.files[0].name, 'v7.mp4'); assert.equal(e.position, 600); assert.equal(e.sub, '2020');
  const x = c.videoEntry(ep(3), '720');
  assert.equal(x.kind, 'episode'); assert.deepEqual(x.show, { id: 50, title: 'Serien' }); assert.equal(x.sub, 'Serien · S1 · A3');
  assert.equal(c.videoEntry({ ...movie, watched: true }, '720').position, 0, 'sedd film börjar om');
  const b = c.bookEntry({ id: 9, title: 'Boken', author: 'A', duration: 7200, position: 30, speed: 1.2, chapters: [{ start: 0, title: 'Ett' }], files: [{ id: 1, offset: 0, duration: 3600 }, { id: 2, offset: 3600, duration: 3600 }] });
  assert.equal(b.key, 'b9'); assert.equal(b.files.length, 2); assert.equal(b.files[1].offset, 3600); assert.equal(b.speed, 1.2);
});

test('kvalitet: val efter filmens höjd och uppskattad storlek', { skip }, () => {
  assert.deepEqual(c.qualityOptions(1080, 3600).map((o) => o.q), ['480', '720', '1080', 'orig']);
  assert.deepEqual(c.qualityOptions(720, 3600).map((o) => o.q), ['480', '720', 'orig'], 'inget 1080 för en 720p-film');
  assert.deepEqual(c.qualityOptions(360, 3600).map((o) => o.q), ['480', 'orig']);
  assert.deepEqual(c.qualityOptions(null, 3600).map((o) => o.q), ['480', '720', '1080', 'orig'], 'okänd höjd: allt');
  // 480p: (1200 + 160) kbit/s i en timme ≈ 612 MB
  assert.equal(c.estimateBytes('480', 3600), 612000000);
  assert.ok(c.estimateBytes('480', 3600) < c.estimateBytes('720', 3600));
  assert.equal(c.estimateBytes('orig', 3600), 0, 'okänd storlek för full upplösning');
  assert.equal(c.fmtSize(612000000), '612 MB');
  assert.equal(c.fmtSize(1.234e9), '1,2 GB');
  assert.equal(c.fmtSize(12.4e9), '12 GB');
  assert.equal(c.fmtSize(0), '0 MB');
});

test('kön: ordning, paus, fortsätt och omstart av appen', { skip }, () => {
  const a = { ...c.videoEntry(movie, '480', 3), state: 'downloading' };
  const b = c.videoEntry(ep(1), '480', 1);
  const d = { ...c.videoEntry(ep(2), '480', 2), state: 'done' };
  const p = { ...c.videoEntry(ep(3), '480', 0), state: 'paused' };
  assert.deepEqual(c.todo([a, b, d, p]).map((e) => e.key), ['v101', 'v7'], 'äldst först, klara och pausade väntar inte');
  assert.equal(c.pauseEntry(a).state, 'paused');
  assert.equal(c.pauseEntry(d).state, 'done', 'en klar nedladdning pausas inte');
  assert.equal(c.resumeEntry(p).state, 'queued');
  const err = c.resumeEntry({ ...b, state: 'error', error: 'fel' });
  assert.equal(err.state, 'queued'); assert.equal(err.error, null);
  assert.equal(c.afterRestart(a).state, 'queued', 'pågick när appen stängdes: köas igen');
  assert.equal(c.afterRestart({ ...a, state: 'preparing' }).state, 'queued');
  assert.equal(c.afterRestart(p).state, 'paused');
  assert.match(c.progressOf({ ...a, got: 300e6, size: 1.2e9 }).text, /300 MB av 1,2 GB/);
  assert.equal(c.progressOf({ ...a, got: 300e6, size: 1.2e9 }).part, 0.25);
  assert.match(c.progressOf({ ...a, state: 'preparing', prep: 40 }).text, /förbereder filen 40 %/);
  assert.match(c.progressOf({ ...p, got: 5e6, size: 1e7 }).text, /^Pausad/);
  assert.equal(c.usedBytes([{ ...d, size: 5e8 }, { ...a, got: 1e8 }]), 6e8);
});

test('avbruten nedladdning: fortsätt på Android, sparat läge på iPhone, börja om när filen är ny', { skip }, () => {
  assert.deepEqual(c.resumePlan({ os: 'android', partial: 1000, expect: 5000, size: 5000 }), { how: 'offset', offset: 1000 });
  assert.deepEqual(c.resumePlan({ os: 'android', partial: 0, size: 5000 }), { how: 'fresh' });
  assert.deepEqual(c.resumePlan({ os: 'android', partial: 1000, expect: 5000, size: 6000 }), { how: 'fresh' }, 'servern har gjort om filen');
  assert.deepEqual(c.resumePlan({ os: 'android', partial: 5000, size: 5000 }), { how: 'fresh' }, 'en fil som redan är hel men inte markerad');
  assert.deepEqual(c.resumePlan({ os: 'ios', partial: 1000, saved: { url: 'u', fileUri: 'f', isDirectory: false, resumeData: 'abc' } }), { how: 'saved' });
  assert.deepEqual(c.resumePlan({ os: 'ios', partial: 1000 }), { how: 'fresh' }, 'iPhone utan sparat läge');
  assert.equal(c.httpStatusOf('HTTP 403'), 403);
  assert.equal(c.httpStatusOf('UnableToDownloadException: server returned HTTP 401'), 401);
  assert.equal(c.httpStatusOf('response has status 404'), 404);
  assert.equal(c.httpStatusOf('Unable to resolve host "tv.example.com"'), 0, 'inget nät');
  assert.equal(c.httpStatusOf('The Internet connection appears to be offline.'), 0);
});

test('hemadressen: används först för nedladdningen när den är bekräftad, annars den sparade', { skip }, () => {
  assert.deepEqual(c.downloadBases('https://tv.example.com', 'http://192.168.1.10:8420'), ['http://192.168.1.10:8420', 'https://tv.example.com']);
  assert.deepEqual(c.downloadBases('https://tv.example.com', 'https://tv.example.com'), ['https://tv.example.com'], 'inte hemma: bara den sparade');
  assert.equal(c.joinUrl('http://192.168.1.10:8420/', '/api/stream/7/offline-file?q=480&t=x'), 'http://192.168.1.10:8420/api/stream/7/offline-file?q=480&t=x');
  assert.equal(c.joinUrl('http://a', 'https://b/c'), 'https://b/c');
});

test('positioner utan nät: sparas lokalt, skickas med at och tas bort när servern svarat', { skip }, () => {
  const e = c.videoEntry(movie, '480');
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);
  const off = c.recordPosition(e, 1234.4, { now });
  assert.equal(off.position, 1234);
  assert.deepEqual(off.pending, { pos: 1234, at: now / 1000, dur: 5400 });
  assert.deepEqual(c.progressRequest(off), { path: '/api/items/7/progress', body: { position: 1234, at: now / 1000, duration: 5400 } });
  assert.equal(c.pendingCount([off, e]), 1);
  // Nätet tillbaka: 200 tar bort den; inget svar (0) eller 500 behåller den
  assert.equal(c.ackSent(off, off.pending, 200).pending, null);
  assert.equal(c.ackSent(off, off.pending, 0).pending, off.pending);
  assert.equal(c.ackSent(off, off.pending, 500).pending, off.pending);
  assert.equal(c.ackSent(off, off.pending, 404).pending, null, 'titeln finns inte längre: släpp den');
  // En ny position sparades medan den gamla skickades: den nya ligger kvar
  const newer = c.recordPosition(off, 1300, { now: now + 10000 });
  assert.equal(c.ackSent(newer, off.pending, 200).pending.pos, 1300);
  // Servern fick positionen direkt (nätet fanns): inget väntar
  assert.equal(c.recordPosition(off, 1400, { now, sent: true }).pending, null);
  // Slutet: positionen 0 lokalt, hela längden till servern (sedd)
  const done = c.recordPosition(e, 5399, { now, done: true });
  assert.equal(done.position, 0); assert.equal(done.pending.pos, 5400); assert.equal(done.finished, now);
  // Boken: hastigheten följer med
  const b = c.bookEntry({ id: 9, title: 'B', duration: 100, speed: 1.5, files: [{ id: 1, offset: 0, duration: 100 }] });
  assert.deepEqual(c.progressRequest(c.recordPosition(b, 50, { now })), { path: '/api/audiobooks/book/9/progress', body: { position: 50, speed: 1.5, at: now / 1000 } });
  assert.equal(c.progressRequest(e), null);
});

test('lokal fil: bara klara poster, bokens fil efter position, nästa nedladdade avsnitt', { skip }, () => {
  const done = { ...c.videoEntry(movie, '480'), state: 'done', files: [{ name: 'v7.mp4', size: 10, done: true }] };
  assert.equal(c.localEntry([done], 'movie', 7), done);
  assert.equal(c.localEntry([{ ...done, state: 'paused' }], 'movie', 7), null, 'en påbörjad fil spelas inte');
  assert.equal(c.localEntry([{ ...done, files: [{ name: 'x', size: 0, done: false }] }], 'movie', 7), null);
  assert.equal(c.localEntry([done], 'book', 7), null, 'bok och film med samma id blandas inte ihop');
  const files = [{ offset: 0 }, { offset: 3600 }, { offset: 7200 }];
  assert.deepEqual(c.bookFileAt(files, 0), { index: 0, at: 0 });
  assert.deepEqual(c.bookFileAt(files, 3700), { index: 1, at: 100 });
  assert.deepEqual(c.bookFileAt(files, 9000), { index: 2, at: 1800 });
  const e = (n, s, state = 'done') => ({ ...c.videoEntry(ep(n, s), '480'), state });
  const list = [e(3, 1), e(1, 2), e(2, 1), e(4, 1, 'paused'), { ...e(5, 1), show: { id: 99, title: 'Annan' } }];
  assert.equal(c.nextLocalEpisode(list, list[2]).key, list[0].key, 'S1A2 → S1A3');
  assert.equal(c.nextLocalEpisode(list, list[0]).key, list[1].key, 'S1A3 → S2A1 (A4 är inte klar, A5 är en annan serie)');
  assert.equal(c.nextLocalEpisode(list, list[1]), null);
  assert.equal(c.startAt({ ...done, position: 60, duration: 5400 }), 0, 'under två minuter: från början');
  assert.equal(c.startAt({ ...done, position: 600, duration: 5400 }), 600);
});

test('undertexter: WebVTT läses och rätt rad visas', { skip }, () => {
  const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500 align:center\n<i>Hej</i> &amp; välkommen\n\n00:01:02,000 --> 00:01:04.000\nRad ett\nRad två\n\nNOTE kommentar\n\n01:00:00.000 --> 01:00:01.000\nSist\n';
  const cues = c.parseVtt(vtt);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], { start: 1, end: 3.5, text: 'Hej & välkommen' });
  assert.equal(cues[1].start, 62);
  assert.equal(cues[2].start, 3600);
  assert.equal(c.cueAt(cues, 0.5), '');
  assert.equal(c.cueAt(cues, 2), 'Hej & välkommen');
  assert.equal(c.cueAt(cues, 3.5), '', 'slutet räknas inte');
  assert.equal(c.cueAt(cues, 63), 'Rad ett\nRad två');
  assert.equal(c.cueAt(cues, 3600.5), 'Sist');
  assert.deepEqual(c.parseVtt(''), []);
  assert.deepEqual(c.parseVtt('nonsens\n\n12 --> 13\n'), []);
});

test('skärmtid utan nät: tid kvar, klockslag, ny dag och ljud', { skip }, () => {
  const at = (h, m = 0, day = 26) => new Date(2026, 10, day, h, m, 0);
  const st = { limited: true, day: '2026-11-26', daily: 60, used: 1800, extra: 0, remaining: 1800, from: '07:00', until: '19:00', audio: false, allowed: true };
  assert.deepEqual(c.screenGate(null, at(12)), { allowed: true, left: null, message: '' }, 'ingen status: ingen gräns');
  assert.equal(c.screenGate(c.freshScreen({ limited: false }), at(12)).allowed, true);
  let cache = c.freshScreen(st, at(12).getTime());
  assert.deepEqual(c.screenGate(cache, at(12)), { allowed: true, left: 1800, message: '' });
  // 20 minuter offline (räknas i högst 45 s per gång)
  for (let i = 0; i < 40; i++) cache = c.addOfflineTime(cache, at(12), 30);
  assert.equal(cache.off.seconds, 1200);
  assert.equal(c.addOfflineTime(cache, at(12), 600).off.seconds, 1245, 'ett långt glapp räknas som högst 45 s');
  assert.equal(c.screenGate(cache, at(12)).left, 600);
  for (let i = 0; i < 20; i++) cache = c.addOfflineTime(cache, at(12), 30);
  const out = c.screenGate(cache, at(12));
  assert.equal(out.allowed, false); assert.match(out.message, /Tiden är slut för i dag/);
  // Klockslag: före 07 och efter 19 nej; nära 19 begränsar klockan tiden kvar
  const fresh = c.freshScreen(st);
  assert.equal(c.screenGate(fresh, at(6, 30)).allowed, false);
  assert.match(c.screenGate(fresh, at(19, 5)).message, /mellan 07:00 och 19:00/);
  assert.equal(c.screenGate(fresh, at(18, 50)).left, 600);
  // Ny dag utan kontakt: samma dagliga gräns, tiden från början, extra tid gäller inte
  const ex = c.freshScreen({ ...st, remaining: 0, extra: 30, until: '19:30', allowed: false, reason: 'limit' });
  assert.equal(c.screenGate(ex, at(12)).allowed, false, 'samma dag: slut');
  assert.deepEqual(c.screenGate(ex, at(12, 0, 27)), { allowed: true, left: 3600, message: '' }, 'nästa dag: en ny timme');
  assert.match(c.screenGate(ex, at(19, 10, 27)).message, /mellan 07:00 och 19:00/, 'nästa dag: ingen extra tid på kvällen');
  // Tid som räknats offline i går påverkar inte i dag
  const y = c.addOfflineTime(c.freshScreen(st), at(12), 40);
  assert.equal(c.screenGate(y, at(12, 0, 27)).left, 3600);
  // Ljudböcker räknas bara när regeln gäller ljud
  const zero = c.freshScreen({ ...st, remaining: 0 });
  assert.equal(c.screenGate(zero, at(12), true).allowed, true);
  assert.equal(c.screenGate(c.freshScreen({ ...st, remaining: 0, audio: true }), at(12), true).allowed, false);
  // Fönster över midnatt (20:00–02:00)
  const night = c.freshScreen({ ...st, from: '20:00', until: '02:00', remaining: null, daily: null });
  assert.equal(c.screenGate(night, at(23)).allowed, true);
  assert.equal(c.screenGate(night, at(1)).allowed, true);
  assert.equal(c.screenGate(night, at(12)).allowed, false);
  assert.equal(c.screenGate(night, at(1, 30)).left, 1800);
});

test('start utan nät och kontrollen mot servern', { skip }, () => {
  assert.equal(c.startView({ reachable: false, downloads: 2 }), 'Downloads');
  assert.equal(c.startView({ reachable: false, downloads: 0 }), 'Main', 'inget nedladdat: startsidan med felet och Försök igen');
  assert.equal(c.startView({ reachable: true, downloads: 2 }), 'Main');
  assert.equal(c.accessVerdict(403), 'remove', 'profilen får inte se titeln längre');
  assert.equal(c.accessVerdict(404), 'remove');
  assert.equal(c.accessVerdict(0), 'keep', 'inget nät: behåll');
  assert.equal(c.accessVerdict(500), 'keep');
  assert.equal(c.accessVerdict(200), 'keep');
});

// ---------- offline.ts med låtsat filsystem och server (test/helpers/expo-loader.mjs, expo-fakes.mjs) ----------
// Kön mot serverns /api/items/:id/offline, nedladdningen (hemadressen först, fortsätt efter paus och avbrott),
// undertexter, positioner som väntar, kontrollen när servern svarar, utloggning. Telefonens riktiga filsystem och
// DownloadTask provas inte här.
let off = null, F = null;
if (!skip) {
  F = await import('./helpers/expo-fakes.mjs');
  off = await import('../apps/expo/src/offline.ts');
  off.timing.wait = 5; off.timing.retry = 40; off.timing.save = 1;
}
const until = async (fn, what = 'villkoret', ms = 3000) => {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('väntade förgäves på ' + what); await new Promise((r) => setTimeout(r, 3)); }
};
const HOME = 'http://192.168.1.10:8420', SAVED = 'https://tv.example.com';
const lastTask = (name) => [...F.fsState.tasks].reverse().find((t) => t.file.name === name && t.state === 'active');
const entry = (key) => off.getList().find((e) => e.key === key);
/** Låtsasservern: serverns svar per titel (status för /offline) och övriga sökvägar */
const server = { st: {}, items: {}, books: {} };
function routes(path, o) {
  let m;
  if ((m = /^\/api\/items\/(\d+)\/offline/.exec(path))) {
    const id = +m[1];
    if (o.method === 'DELETE') return { ok: true };
    const s = server.st[id];
    if (s instanceof Error) throw s;
    return typeof s === 'function' ? s(o) : s || { status: 'none' };
  }
  if ((m = /^\/api\/audiobooks\/book\/(\d+)\/offline/.exec(path))) return server.books[+m[1]];
  if ((m = /^\/api\/(items|audiobooks\/book)\/(\d+)$/.exec(path))) { const r = server.items[path]; if (r instanceof Error) throw r; return r || {}; }
  if (path === '/api/screentime') return { limited: false };
  if (/\/progress$/.test(path)) { if (server.progress instanceof Error) throw server.progress; return { watched: false }; }
  throw new Error('okänd sökväg ' + path);
}
const ready = (id, extra = {}) => ({ status: 'ready', size: 1000, url: `/api/stream/${id}/offline-file?q=480&t=tok${id}`, ...extra });

test('offline.ts: film med servern som förbereder filen, hemadressen först, undertext och omslag', { skip }, async () => {
  F.fsState.reset(); globalThis.__os = 'android';
  F.fsState.api = async (p, o) => routes(p, o);
  F.fsState.net = async (url) => (url.includes('/subs/') ? 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHej\n' : 'jpg');
  F.session.saved = SAVED; F.session.server = HOME;
  off.openScope('srv1', { id: 4, name: 'Kid', kid: true });
  assert.equal(off.mayDownload(), true);
  server.st[7] = { status: 'queued', progress: 0 };
  assert.equal(await off.downloadVideo(movie, '480'), true);
  assert.equal(entry('v7').state, 'preparing');
  assert.deepEqual(F.fsState.apiCalls[0], { path: '/api/items/7/offline', method: 'POST', body: { q: '480' } });
  assert.equal(await off.downloadVideo(movie, '480'), false, 'finns redan');
  server.st[7] = { status: 'running', progress: 40 };
  await until(() => entry('v7').prep === 40, 'förberedelsen 40 %');
  server.st[7] = ready(7, { subs: [{ id: 's1', lang: 'sv', label: 'Svenska', forced: false, url: '/api/stream/7/subs/s1?t=tok7' }] });
  const task = await until(() => lastTask('v7.mp4'), 'nedladdningen');
  assert.equal(task.url, HOME + '/api/stream/7/offline-file?q=480&t=tok7', 'hemadressen när den är bekräftad');
  assert.equal(task.kind, 'fresh');
  task.progress(500, 1000);
  await until(() => entry('v7').got === 500, 'förloppet');
  assert.equal(c.progressOf(entry('v7')).part, 0.5);
  task.finish(1000);
  await until(() => entry('v7').state === 'done', 'klar');
  const e = entry('v7');
  assert.equal(e.size, 1000); assert.equal(e.subs.length, 1); assert.equal(e.subs[0].label, 'Svenska'); assert.equal(e.art, true);
  const local = off.localVideo(7);
  assert.ok(local.uri.endsWith('/srv1-4/v7.mp4'), local.uri);
  assert.match(await off.readText(local.subs[0].name), /Hej/);
  assert.equal(off.localVideo(8), null);
  await new Promise((r) => setTimeout(r, 10));
  const saved = JSON.parse(new F.File('mem:/doc/offline/srv1-4/list.json').textSync());
  assert.equal(saved.list[0].state, 'done', 'listan sparas i profilens mapp');
});

test('offline.ts: hemadressen slutar svara mitt i – fortsätter från den sparade adressen där den var', { skip }, async () => {
  F.session.saved = SAVED; F.session.server = HOME;
  server.st[8] = ready(8);
  await off.downloadVideo({ ...movie, id: 8 }, '480');
  const t1 = await until(() => lastTask('v8.mp4'), 'första försöket');
  assert.ok(t1.url.startsWith(HOME));
  t1.partial(300);
  t1.fail('Unable to resolve host "192.168.1.10"');
  const t2 = await until(() => lastTask('v8.mp4') !== t1 && lastTask('v8.mp4'), 'andra försöket');
  assert.equal(F.session.server, SAVED, 'appen går tillbaka till den sparade adressen');
  assert.equal(t2.kind, 'resume'); assert.equal(t2.saved.resumeData, '300', 'vidare från 300 byte');
  assert.ok(t2.url.startsWith(SAVED + '/api/stream/8/offline-file'));
  t2.finish(1000);
  await until(() => entry('v8').state === 'done', 'klar');
});

test('offline.ts: paus och fortsätt (Android: från filens längd med ny länk; iPhone: sparat läge, ny länk när den gamla gått ut)', { skip }, async () => {
  F.session.server = SAVED;
  server.st[9] = ready(9);
  await off.downloadVideo({ ...movie, id: 9 }, '480');
  const t1 = await until(() => lastTask('v9.mp4'));
  t1.partial(200);
  off.pause('v9');
  await until(() => entry('v9').state === 'paused' && !lastTask('v9.mp4'), 'pausad');
  server.st[9] = ready(9, { url: '/api/stream/9/offline-file?q=480&t=ny' });
  off.resume('v9');
  const t2 = await until(() => lastTask('v9.mp4'), 'fortsätter');
  assert.equal(t2.kind, 'resume'); assert.equal(t2.saved.resumeData, '200'); assert.ok(t2.url.endsWith('t=ny'), 'ny token');
  t2.finish(1000);
  await until(() => entry('v9').state === 'done');

  globalThis.__os = 'ios';
  server.st[10] = ready(10);
  await off.downloadVideo({ ...movie, id: 10 }, '480');
  const i1 = await until(() => lastTask('v10.mp4'));
  off.pause('v10');
  await until(() => entry('v10').state === 'paused' && entry('v10').resume, 'sparat läge');
  assert.equal(entry('v10').resume.resumeData, 'ios-data');
  off.resume('v10');
  const i2 = await until(() => lastTask('v10.mp4') !== i1 && lastTask('v10.mp4'));
  assert.equal(i2.kind, 'resume'); assert.equal(i2.saved.resumeData, 'ios-data');
  i2.fail('UnableToDownloadException: server returned HTTP 401'); // tokenen i den sparade länken har gått ut
  const i3 = await until(() => lastTask('v10.mp4') !== i2 && lastTask('v10.mp4'), 'börjar om');
  assert.equal(i3.kind, 'fresh');
  i3.finish(1000);
  await until(() => entry('v10').state === 'done');
  assert.equal(entry('v10').resume, null);
  globalThis.__os = 'android';
});

test('offline.ts: avbryt tar bort filen, nej från servern syns direkt, fel och inget nät', { skip }, async () => {
  server.st[11] = ready(11);
  await off.downloadVideo({ ...movie, id: 11 }, '480');
  const t = await until(() => lastTask('v11.mp4'));
  t.partial(100);
  await off.remove('v11');
  assert.equal(t.state, 'cancelled'); assert.equal(entry('v11'), undefined);
  assert.equal(new F.File('mem:/doc/offline/srv1-4/v11.mp4').exists, false);
  // Familjefiltret eller barnprofilens gränser: servern svarar 403 redan när man trycker
  server.st[12] = new F.ApiError('Familjefiltret är på för profilen – titeln spelas med tystade svordomar via vanlig uppspelning', 403);
  await assert.rejects(off.downloadVideo({ ...movie, id: 12 }, '480'), /Familjefiltret/);
  assert.equal(entry('v12'), undefined);
  // Servern svarar 404 på filen: fel med förklaring, Försök igen köar igen
  server.st[13] = ready(13);
  await off.downloadVideo({ ...movie, id: 13 }, '480');
  (await until(() => lastTask('v13.mp4'))).fail('HTTP 404');
  await until(() => entry('v13').state === 'error');
  assert.equal(entry('v13').error, 'Filen finns inte längre på servern.');
  // Inget nät: väntar och försöker igen av sig själv
  server.st[13] = new F.ApiError('Kunde inte ansluta', 0);
  off.resume('v13');
  await until(() => /Väntar på kontakt/.test(entry('v13').error || ''), 'väntar på nätet');
  assert.equal(entry('v13').state, 'queued');
  server.st[13] = ready(13);
  (await until(() => lastTask('v13.mp4'), 'nytt försök efter en stund')).finish(1000);
  await until(() => entry('v13').state === 'done');
  // För lite plats på telefonen
  globalThis.__free = 500;
  server.st[14] = ready(14, { size: 5e9 });
  await off.downloadVideo({ ...movie, id: 14 }, '480');
  await until(() => entry('v14').state === 'error');
  assert.match(entry('v14').error, /inte plats/);
  globalThis.__free = undefined;
  await off.remove('v14');
});

test('offline.ts: ljudbok med flera filer', { skip }, async () => {
  server.books[9] = { id: 9, title: 'Boken', author: 'A', duration: 7200, position: 0, chapters: [], files: [{ id: 1, offset: 0, duration: 3600, url: '/f1?t=b' }, { id: 2, offset: 3600, duration: 3600, url: '/f2?t=b' }] };
  assert.equal(await off.downloadBook(9), true);
  (await until(() => lastTask('b9.0.audio'), 'första filen')).finish(400);
  (await until(() => lastTask('b9.1.audio'), 'andra filen')).finish(600);
  await until(() => entry('b9').state === 'done');
  assert.equal(entry('b9').size, 1000);
  const b = off.localBook(9);
  assert.equal(b.files.length, 2); assert.equal(b.files[1].offset, 3600); assert.ok(b.files[1].uri.endsWith('b9.1.audio'));
  assert.ok(off.localArt('book', 9));
});

test('offline.ts: positioner utan nät skickas med at när servern svarar', { skip }, async () => {
  F.fsState.apiCalls.length = 0;
  server.progress = new F.ApiError('Kunde inte ansluta', 0);
  off.savePosition('movie', 7, 1234);
  assert.equal(entry('v7').pending.pos, 1234);
  await off.syncPending();
  assert.equal(entry('v7').pending.pos, 1234, 'inget nät: ligger kvar');
  server.progress = null;
  await off.syncPending();
  assert.equal(entry('v7').pending, null);
  const call = F.fsState.apiCalls.filter((x) => x.path === '/api/items/7/progress').pop();
  assert.equal(call.body.position, 1234); assert.ok(call.body.at > 1.7e9, 'at i Unix-sekunder');
  assert.equal(off.pendingCount(), 0);
});

test('offline.ts: skärmtid utan nät följer senaste status och tiden som räknats här', { skip }, async () => {
  const d = new Date();
  off.noteScreen({ limited: true, day: c.localDay(d), daily: 60, extra: 0, used: 3540, remaining: 60, from: null, until: null, audio: false });
  assert.equal(off.screenGate().allowed, true);
  off.countOffline(45); off.countOffline(45);
  assert.equal(off.screenGate().allowed, false);
  assert.equal(off.screenGate(true).allowed, true, 'ljud räknas inte med den regeln');
  off.noteScreen({ limited: false });
  assert.equal(off.screenGate().allowed, true);
});

test('offline.ts: start utan nät, kontrollen när servern svarar, utloggning', { skip }, async () => {
  // Profilbyte och sedan "appen startar utan nät": den senaste profilens lista visas, pågående köas igen
  server.st[15] = ready(15);
  await off.downloadVideo({ ...movie, id: 15 }, '480');
  await until(() => lastTask('v15.mp4'));
  off.closeScope();
  assert.equal(off.count(), 0);
  const last = off.openLast('srv1');
  assert.deepEqual(last, { uid: 4, name: 'Kid', kid: true });
  assert.ok(off.count() >= 6);
  assert.equal(c.startView({ reachable: false, downloads: off.count() }), 'Downloads');
  assert.ok(['queued', 'paused'].includes(entry('v15').state));
  assert.equal(off.openLast('annan'), null, 'en server utan nedladdningar');
  // En annan profil på samma server har en egen, tom lista
  off.openScope('srv1', { id: 5, name: 'Vuxen' });
  assert.equal(off.count(), 0);
  off.openScope('srv1', { id: 4, name: 'Kid', kid: true });
  await off.remove('v15');
  // Servern svarar: en titel som profilen inte får se längre tas bort
  server.items['/api/items/8'] = new F.ApiError('Inte tillgänglig i den här profilen', 403);
  await off.online(true);
  assert.equal(entry('v8'), undefined);
  assert.match(off.getNotice(), /Filmen togs bort/);
  assert.ok(entry('v7'), 'tillåtna ligger kvar');
  // Kontot får inte ladda ner längre: allt tas bort
  await off.online(false);
  assert.equal(off.count(), 0); assert.equal(off.mayDownload(), false);
  assert.match(off.getNotice(), /får inte ladda ner/);
  await off.online(true);
  // Utloggning/borttagen server: alla profilers mappar för servern tas bort, andra servrar ligger kvar
  off.openScope('srv2', { id: 1, name: 'X' });
  server.st[16] = ready(16);
  await off.downloadVideo({ ...movie, id: 16 }, '480');
  (await until(() => lastTask('v16.mp4'))).finish(10);
  await until(() => entry('v16').state === 'done');
  off.openScope('srv1', { id: 5, name: 'Vuxen' });
  server.st[17] = ready(17);
  await off.downloadVideo({ ...movie, id: 17 }, '480');
  (await until(() => lastTask('v17.mp4'))).finish(10);
  await until(() => entry('v17').state === 'done');
  assert.equal(off.hasServerDownloads('srv1'), true);
  off.removeServer('srv1');
  assert.equal(off.hasServerDownloads('srv1'), false);
  assert.equal(new F.Directory('mem:/doc/offline/srv1-4').exists, false);
  assert.equal(new F.Directory('mem:/doc/offline/srv1-5').exists, false);
  assert.equal(off.openLast('srv1'), null);
  assert.equal(new F.Directory('mem:/doc/offline/srv2-1').exists, true, 'den andra servern ligger kvar');
});
