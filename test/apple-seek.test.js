// iOS/tvOS-appens spolning i en omkodad ström (apps/apple/Shared/SeekCore.swift + Player.swift seekRestart). Swift
// kompileras inte här (bara i GitHub Actions på macOS), så det här är statiska kontroller: reglerna har samma gränser
// som Expo-appens (apps/expo/src/seekcore.ts, provad i test/expo-seek.test.js) och Android-appens (SeekCore.kt), och
// spelaren skickar det servern behöver. Att servern ger EXT-X-START när appen själv lägger till xs (Apple TV skickar
// inte nhls) provas i test/fast-resume.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const swift = read('apps', 'apple', 'Shared', 'SeekCore.swift');
const player = read('apps', 'apple', 'Shared', 'Player.swift');
const ts = read('apps', 'expo', 'src', 'seekcore.ts');
const kt = read('apps', 'automotive', 'app', 'src', 'main', 'java', 'net', 'braxhn', 'tv', 'SeekCore.kt');

test('samma gränser som Expo- och Android-appen', () => {
  const rules = [
    [/duration <= 2\.01/, 'kort segment (≤ 2,01 s) ger ingen omstart'],
    [/last\.start \+ last\.duration - 4/, 'inte de sista 4 s'],
    [/- 0\.1 && t </, 'buffrat med 0,1 s marginal'],
  ];
  for (const [re, what] of rules) { assert.match(swift, re, `Swift: ${what}`); assert.match(ts + kt, re, `Expo/Android: ${what}`); }
  assert.match(swift, /static let behind = 30/); assert.match(ts, /const BEHIND = 30/);
  assert.match(swift, /\+ ran \+ 2\.5 \|\| now\.pos < prev\.pos - 1\.5/); assert.match(ts, /\+ ran \+ 2\.5 \|\| now\.pos < prev\.pos - 1\.5/);
  assert.match(swift, /n <= r\.upperBound \+ 1/, 'segmentet efter det klara kodas just nu');
  assert.match(swift, /stepSettle: Double = 0\.6/); assert.match(kt, /STEP_SETTLE_MS = 600L/);
  assert.match(swift, /\[\?&\]pid=\[0-9a-f\]\{8\}\(&\|\$\)/, 'pid som i Expo/Android');
});

test('spelaren: /playback med start och prev, ersatt ström stoppas med replaced=1, och den gamla strömmens fel visas inte', () => {
  const fn = player.slice(player.indexOf('func seekRestart('));
  assert.match(fn, /name: "start", value: String\(Int\(t\)\)/);
  assert.match(fn, /name: "prev", value: pid/);
  assert.match(fn, /model\.get\("\/api\/items\/\\\(id\)\/playback", q\)/, 'via model.get (apiBase/hemadressen)');
  assert.match(fn, /SeekCore\.withStart\(p\.url, at: t\)/, 'xs → EXT-X-START även på Apple TV');
  assert.match(player, /stop\?pid=\\\(pid\)&replaced=1/);
  assert.match(player, /error == nil, !seekRestarting else \{ return \}/, 'mainFailed under en omstart');
  // Bara omkodning bevakas (remux och direktuppspelning spolar som förut)
  assert.equal((player.match(/if p\.mode == "transcode" \{ watchStream\(/g) || []).length, 2);
});
