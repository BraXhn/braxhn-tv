// Expo-appens knappar för sammanfattning, intro och eftertexter och kortet när avsnittet är slut
// (apps/expo/src/skipcore.ts): samma regler som webbspelaren (web/js/player/autoskip.js, test/playprefs.test.js) –
// här jämförs de två fall för fall. Telefonens spelare (expo-video) provas inte här. Node 22.18+ läser TypeScript.
// Android-appens kärna (apps/automotive, SkipCore.kt) har samma fall i SkipCoreTest.kt (JVM).
import test from 'node:test';
import assert from 'node:assert/strict';

const skip = process.features?.typescript ? false : 'Node utan TypeScript-stöd';
const c = skip ? null : await import('../apps/expo/src/skipcore.ts');
// Webbens modul (importerar core.js för t, som skipPlan och nextPlan inte använder)
const web = skip ? null : await import('../web/js/player/autoskip.js');

const pb = {
  recap: { start: 0, end: 40 }, intro: { start: 30, end: 90 }, credits: 1300,
  autoSkip: { recap: true, intro: true, credits: false }, autoNext: { enabled: true, countdown: 10 },
};

test('skipPlan: rätt del vid rätt tid, sammanfattningen före introt, eftertexterna bara med nästa avsnitt', { skip }, () => {
  assert.deepEqual(c.skipPlan(pb, 5), { kind: 'recap', to: 40, auto: true });
  assert.deepEqual(c.skipPlan(pb, 35), { kind: 'recap', to: 40, auto: true }, 'överlapp: sammanfattningen först');
  assert.deepEqual(c.skipPlan(pb, 39.5), { kind: 'intro', to: 90, auto: true }, 'sista sekunden av sammanfattningen');
  assert.equal(c.skipPlan(pb, 89.2), null, 'sista sekunden av introt: ingen knapp');
  assert.equal(c.skipPlan(pb, 500), null);
  assert.equal(c.skipPlan(pb, 1310), null, 'eftertexter utan nästa avsnitt');
  assert.deepEqual(c.skipPlan(pb, 1310, { hasNext: true }), { kind: 'credits', to: 'next', auto: false });
  assert.equal(c.skipPlan(pb, 1360, { hasNext: true }), null, 'efter en minut försvinner knappen');
  assert.equal(c.skipPlan(null, 5), null);
  assert.equal(c.skipPlan(pb, NaN), null);
  assert.equal(c.skipPlan({ ...pb, autoSkip: null }, 5).auto, false, 'äldre server: bara knappen');
  assert.equal(c.skipPlan({ credits: 0 }, 0, { hasNext: true }), null, 'eftertexter vid 0 = okänt');
});

test('skipPlan: avbruten eller redan överhoppad del hoppas inte över igen', { skip }, () => {
  const done = new Set(['recap']);
  assert.deepEqual(c.skipPlan(pb, 5, { done }), { kind: 'recap', to: 40, auto: false }, 'knappen finns kvar');
  assert.equal(c.skipPlan(pb, 50, { done }).auto, true, 'introt gäller fortfarande');
});

test('nextPlan: kontots val, gränser och äldre server', { skip }, () => {
  assert.equal(c.nextPlan(pb, false), null);
  assert.deepEqual(c.nextPlan(pb, true), { auto: true, seconds: 10 });
  assert.deepEqual(c.nextPlan({ autoNext: { enabled: false, countdown: 10 } }, true), { auto: false, seconds: 10 });
  assert.deepEqual(c.nextPlan({ autoNext: { enabled: true, countdown: 0 } }, true), { auto: true, seconds: 0 });
  assert.deepEqual(c.nextPlan({ autoNext: { enabled: true, countdown: 600 } }, true), { auto: true, seconds: 60 });
  assert.deepEqual(c.nextPlan({ autoNext: { enabled: true, countdown: 'x' } }, true), { auto: true, seconds: 8 });
  assert.deepEqual(c.nextPlan({}, true), { auto: true, seconds: 8 }, 'utan autoNext: 8 s som förut');
  assert.deepEqual(c.nextPlan(null, true), { auto: true, seconds: 8 });
  assert.equal(c.SKIP_DELAY, 3);
});

test('samma svar som webbspelaren', { skip }, () => {
  const cases = [null, pb, { ...pb, autoSkip: { intro: false } }, { intro: { start: 10, end: 20 } }, { credits: 100, autoSkip: { credits: true } }];
  for (const p of cases) for (const tt of [0, 5, 15, 19.5, 35, 39, 60, 99, 100, 130, 159, 160, 1300, 1330, 1361]) {
    for (const hasNext of [false, true]) for (const done of [null, new Set(['intro', 'credits'])]) {
      assert.deepEqual(c.skipPlan(p, tt, { hasNext, done }), web.skipPlan(p, tt, { hasNext, done }), JSON.stringify({ p, tt, hasNext }));
    }
  }
  for (const p of [null, {}, pb, { autoNext: { enabled: false, countdown: 3 } }, { autoNext: { enabled: true, countdown: -4 } }, { autoNext: { enabled: true, countdown: '12' } }])
    for (const hasNext of [false, true]) assert.deepEqual(c.nextPlan(p, hasNext), web.nextPlan(p, hasNext));
  assert.equal(c.SKIP_DELAY, web.SKIP_DELAY);
});
