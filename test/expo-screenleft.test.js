// Expo-appens skärmtid i spelaren (apps/expo/src/screenleft.ts): "X min kvar idag" och varningen de sista fem
// minuterna, med samma regler och ord som webbspelaren (web/js/player/screenleft.js) och Android-appen
// (ScreenLeftCoreTest.kt). Spelaren själv (expo-video) provas inte här. Node 22.18+ läser TypeScript utan byggsteg.
import test from 'node:test';
import assert from 'node:assert/strict';

const skip = process.features?.typescript ? false : 'Node utan TypeScript-stöd';
let i18n = null;
if (!skip) {
  const { register } = await import('node:module');
  register('./helpers/expo-loader.mjs', import.meta.url);
  i18n = await import('../apps/expo/src/i18n.ts');
  i18n.setLangChoice('sv');
}
const c = skip ? null : await import('../apps/expo/src/screenleft.ts');
const oc = skip ? null : await import('../apps/expo/src/offlinecore.ts');
const ON = { limited: true, allowed: true };

test('tiden kvar: samma fall som webben, och samma svar för varje sekund upp till tre timmar', { skip }, async () => {
  assert.equal(c.WARN_LEFT, 300);
  assert.equal(c.playerLeft(null), null, 'utan skärmtid');
  assert.equal(c.playerLeft({ limited: false }), null);
  assert.equal(c.playerLeft({ ...ON, left: null }), null, 'ingen gräns idag');
  assert.equal(c.playerLeft({ limited: true, allowed: false, left: 0 }), null, 'slut: spelaren stoppas i stället');
  assert.deepEqual(c.playerLeft({ ...ON, left: 720 }), { min: 12, warn: false });
  assert.deepEqual(c.playerLeft({ ...ON, left: 301 }), { min: 6, warn: false });
  assert.deepEqual(c.playerLeft({ ...ON, left: 300 }), { min: 5, warn: true });
  assert.deepEqual(c.playerLeft({ ...ON, left: 20 }), { min: 1, warn: true }, 'sista minuten visas som 1 min');
  assert.equal(c.playerLeft({ ...ON, left: 'x' }), null);
  const web = await import('../web/js/player/screenleft.js');
  for (let s = 0; s <= 3 * 3600; s += 7) assert.deepEqual(c.playerLeft({ ...ON, left: s }), web.playerLeft({ ...ON, left: s }), `${s} s`);
});

test('tiden kvar: en äldre server utan left ger remaining, sluttiden vinner när den kommer först', { skip }, () => {
  assert.deepEqual(c.playerLeft({ ...ON, remaining: 1800 }), { min: 30, warn: false }, 'äldre server');
  assert.deepEqual(c.playerLeft({ ...ON, remaining: 1800, left: 170 }), { min: 3, warn: true });
  assert.equal(c.playerLeft({ ...ON, remaining: null, left: null }), null);
});

test('utan nät: appens egen räkning, och en paus räknas inte', { skip }, () => {
  const d = new Date(2026, 10, 28, 10, 0);
  const cache = oc.freshScreen({ limited: true, day: '2026-11-28', daily: 30, used: 1500, remaining: 300 });
  assert.deepEqual(c.gateLeft(oc.screenGate(cache, d)), { min: 5, warn: true });
  let x = cache;
  for (let i = 0; i < 12; i++) x = oc.addOfflineTime(x, d, 10);
  assert.deepEqual(c.gateLeft(oc.screenGate(x, d)), { min: 3, warn: true }, 'två minuter spelade utan nät');
  // Paus: ingen tid läggs till, tio minuter senare är det lika mycket kvar
  assert.deepEqual(c.gateLeft(oc.screenGate(x, new Date(2026, 10, 28, 10, 10))), { min: 3, warn: true });
  // Sluttiden 20:00 och klockan 19:58:30
  const win = oc.freshScreen({ limited: true, day: '2026-11-28', remaining: 3600, until: '20:00' });
  assert.deepEqual(c.gateLeft(oc.screenGate(win, new Date(2026, 10, 28, 19, 58, 30))), { min: 2, warn: true });
  assert.equal(c.gateLeft(oc.screenGate(null, d)), null, 'ingen skärmtid');
  assert.equal(c.gateLeft({ allowed: false, left: 0 }), null, 'slut: spelaren stoppas i stället');
});

test('texterna: som webben på svenska och engelska, och när de syns', { skip }, () => {
  const v = (left, o) => c.leftView(c.playerLeft({ ...ON, left }), { paused: false, chrome: false, compact: false, ...o });
  i18n.setLangChoice('sv');
  assert.equal(v(720), null, 'filmen spelar och appens överkant är dold: inget över bilden');
  assert.deepEqual(v(720, { paused: true }), { pill: '12 min kvar idag', low: false, warn: '' });
  assert.deepEqual(v(720, { chrome: true, compact: true }), { pill: '⏱ 12 min kvar', low: false, warn: '' });
  assert.deepEqual(v(3900, { paused: true }), { pill: '1 h 5 min kvar idag', low: false, warn: '' });
  assert.deepEqual(v(240), { pill: '', low: true, warn: 'Skärmtiden tar slut om 4 min' }, 'varningen syns även när filmen spelar');
  assert.deepEqual(v(240, { paused: true }), { pill: '4 min kvar idag', low: true, warn: 'Skärmtiden tar slut om 4 min' });
  assert.equal(c.leftView(null, { paused: true, chrome: true, compact: false }), null);
  i18n.setLangChoice('en');
  assert.deepEqual(v(240, { paused: true }), { pill: '4 min left today', low: true, warn: 'Screen time runs out in 4 min' });
  assert.equal(v(720, { chrome: true, compact: true }).pill, '⏱ 12 min left');
  i18n.setLangChoice('sv');
});
