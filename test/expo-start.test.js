// Expo-appens start (apps/expo/src/startcore.ts): /playback skickas samtidigt som titelns uppgifter, som webbens
// earlyPlayback (test/web-chrome-playback.test.js visar det för webben). Svaret används när servern valde titelns
// förvalda ljudspår, annars frågar appen igen med ljudspåret och prev; en ström som aldrig används stoppas.
// Mot en riktig server: den tidiga frågan ger samma ljudspår som titelns defaultAudio och tar över förvärmningen.
// Telefonens spelare (expo-video) provas inte här. Node 22.18+ läser TypeScript utan byggsteg.
import test from 'node:test';
import assert from 'node:assert/strict';

const skip = process.features?.typescript ? false : 'Node utan TypeScript-stöd';
const c = skip ? null : await import('../apps/expo/src/startcore.ts');

/** Ett löfte som testet själv löser */
function later() { let ok, no; const p = new Promise((a, b) => { ok = a; no = b; }); return { p, ok, no }; }
const tick = () => new Promise((r) => setImmediate(r));

test('earlyFits: titelns förvalda ljudspår, eller inget förval', { skip }, () => {
  assert.equal(c.earlyFits({ audioSelected: '2' }, 2), true);
  assert.equal(c.earlyFits({ audioSelected: '1' }, 2), false);
  assert.equal(c.earlyFits({ audioSelected: null }, 2), false);
  assert.equal(c.earlyFits({ audioSelected: '1' }, null), true); // appen skulle ändå fråga utan ljudspår
  assert.equal(c.earlyFits(null, 2), false);
});

test('/playback skickas innan titelns svar har kommit, och svaret används när ljudet stämmer', { skip }, async () => {
  const log = [], item = later(), pb = later();
  const run = c.startPlayback({
    early: () => { log.push('playback'); return pb.p; },
    item: () => { log.push('titel'); return item.p; },
    again: () => { log.push('igen'); return Promise.resolve({ url: 'x' }); },
    drop: () => log.push('stopp'),
  });
  await tick();
  assert.deepEqual(log, ['playback', 'titel'], 'båda frågorna är skickade innan något svar kommit');
  pb.ok({ url: '/api/stream/5/hls/master.m3u8?pid=aaaa1111', audioSelected: '3' }); // /playback svarar först
  await tick();
  item.ok({ id: 5, defaultAudio: 3 });
  const r = await run;
  assert.equal(r.pb.audioSelected, '3');
  assert.equal(r.audio, 3);
  assert.deepEqual(log, ['playback', 'titel'], 'ingen fråga till, inget stopp');
});

test('annat ljudspår: frågar igen med titelns ljud och den tidiga strömmen som prev', { skip }, async () => {
  const asked = [], dropped = [];
  const first = { url: '/api/stream/5/hls/master.m3u8?pid=aaaa1111', audioSelected: '1' };
  const r = await c.startPlayback({
    early: async () => first,
    item: async () => ({ id: 5, defaultAudio: 2 }),
    again: async (audio, e) => { asked.push([audio, e]); return { url: '/b?pid=bbbb2222', audioSelected: '2' }; },
    drop: (p) => dropped.push(p),
  });
  assert.deepEqual(asked, [[2, first]]);
  assert.equal(r.pb.audioSelected, '2');
  assert.deepEqual(dropped, [], 'servern stoppar den tidiga själv (prev)');
});

test('den tidiga frågan misslyckas: frågar igen som förut (utan prev), felet där visas', { skip }, async () => {
  const asked = [];
  const r = await c.startPlayback({
    early: async () => { throw new Error('nät'); },
    item: async () => ({ id: 5, defaultAudio: 2 }),
    again: async (audio, e) => { asked.push([audio, e]); return { url: '/b', audioSelected: '2' }; },
    drop: () => assert.fail('inget att stoppa'),
  });
  assert.deepEqual(asked, [[2, null]]);
  assert.equal(r.pb.url, '/b');
  await assert.rejects(c.startPlayback({ early: async () => { throw new Error('nät'); }, item: async () => ({ defaultAudio: 1 }),
    again: async () => { throw new Error('Ditt konto får bara spela en sak i taget'); }, drop: () => {} }), /en sak i taget/);
});

test('titeln går inte att hämta, eller spelaren stängs: strömmen som startades stoppas', { skip }, async () => {
  const pb = { url: '/a?pid=aaaa1111', audioSelected: '1' };
  let dropped = [];
  await assert.rejects(c.startPlayback({ early: async () => pb, item: async () => { throw new Error('404'); }, again: async () => pb, drop: (p) => dropped.push(p) }), /404/);
  await tick();
  assert.deepEqual(dropped, [pb]);
  // Stängd medan titeln hämtades
  dropped = []; let live = true;
  const item = later();
  const run = c.startPlayback({ early: async () => pb, item: () => item.p, again: async () => pb, drop: (p) => dropped.push(p), live: () => live });
  live = false; item.ok({ defaultAudio: 1 });
  assert.equal(await run, null);
  await tick();
  assert.deepEqual(dropped, [pb]);
  // Stängd medan den andra frågan pågick
  dropped = []; live = true;
  const second = { url: '/b?pid=bbbb2222', audioSelected: '2' };
  const run2 = c.startPlayback({ early: async () => pb, item: async () => ({ defaultAudio: 2 }), again: async () => { live = false; return second; }, drop: (p) => dropped.push(p), live: () => live });
  assert.equal(await run2, null);
  assert.deepEqual(dropped, [second]);
});
