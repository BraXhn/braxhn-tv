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

// Serverns svar i stället för gissningen (backloggens punkt "fråga servern vad som är kodat"): samma fråga, samma
// regler för ett färskt svar och samma tolkning av svaret som Expo-appen (seekcore.ts readyUrl/readyFrom/readyFor)
test('vad servern har klart: /hls/ready som Expo-appen, gissningen bara som reserv', () => {
  // Frågan: strömmens adress med /hls/ready (pid och mediatoken följer med)
  assert.match(swift, /replacingOccurrences\(of: "\/hls\/master\.m3u8", with: "\/hls\/ready"\)/);
  assert.match(ts, /master\.replace\('\/hls\/master\.m3u8', '\/hls\/ready'\)/);
  // Var 4:e sekund, ett svar gäller 8 s
  assert.match(swift, /static let readyEvery: Double = 4\b/); assert.match(swift, /static let readyFresh: Double = 8\b/);
  assert.match(ts, /READY_EVERY_MS = 4000, READY_FRESH_MS = 8000/);
  // Ett svar gäller bara om frågan skickades före spolningen och är färsk; annars gissningen
  const rf = swift.slice(swift.indexOf('static func readyFor('));
  assert.match(rf, /k\.at <= \(before \?\? now\), now - k\.at <= readyFresh \{ return k\.range \}/);
  assert.match(rf, /return readyGuess\(frags, runSeg: runSeg, bufferedEnd: bufferedEnd\)/);
  assert.match(ts, /known\.at <= before && now - known\.at <= READY_FRESH_MS\) return known\.range/);
  // Svaret: segs [från, till] inom listan, annars sekunderna (från + 0,05, till − 0,05) som segment
  const fr = swift.slice(swift.indexOf('static func readyFrom('));
  assert.match(fr, /g\.count == 2, g\[0\] >= 0, g\[0\] <= g\[1\], g\[1\] <= last/);
  assert.match(ts, /g\[0\] >= 0 && g\[0\] <= g\[1\] && g\[1\] <= last/);
  assert.match(fr, /b0 > a0/); assert.match(ts, /r\.to > r\.from/);
  assert.match(fr, /fragAt\(frags, a0 \+ 0\.05\), b = fragAt\(frags, b0 - 0\.05\)/);
  assert.match(ts, /fragAt\(frags, r\.from \+ 0\.05\), b = fragAt\(frags, r\.to - 0\.05\)/);
  // Beslutet och körningen efter en spolning använder svaret (inte bara gissningen); before = mätningen före hoppet
  for (const f of ['static func decide(', 'static func runAfterSeek(']) {
    const body = swift.slice(swift.indexOf(f), swift.indexOf('\n    }\n', swift.indexOf(f)));
    assert.match(body, /readyFor\(frags, runSeg: runSeg, bufferedEnd: prev\.buf, known: known, now: now \?\? prev\.at, before: prev\.at\)/, f);
    assert.ok(!/readyGuess\(/.test(body), `${f} gissar inte själv`);
  }
  assert.match(ts, /readyFor\(s\.frags, s\.runSeg, prev\.buf, s\.known, now, prev\.at\)/);
  // Watch: svaret och mätningen går in i beslutet; efter en spolning utan omstart gäller svaret inte längre (seq)
  const w = swift.slice(swift.indexOf('struct Watch'));
  assert.match(w, /SeekCore\.decide\(base, t: now\.pos, frags: frags, runSeg: runSeg, started: started, known: known, now: now\.at\)/);
  assert.match(w, /SeekCore\.runAfterSeek\(base, t: now\.pos, frags: frags, runSeg: runSeg, known: known, now: now\.at\)\s*pending = nil\s*before = nil[\s\S]{0,200}known = nil\s*seq \+= 1/);
  assert.match(read('apps', 'expo', 'src', 'screens', 'Player.tsx'), /s\.known = null; s\.seq\+\+;/);
  assert.match(w, /guard s == seq else \{ return \}\s*known = Known\(range: SeekCore\.readyFrom\(frags, r\), at: sentAt\)/);
  assert.match(w, /var wantsReady: Bool \{ started && !frags\.isEmpty \}/);
});

test('spelaren frågar /hls/ready medan omkodningen spelar, och väntar bara på fjärrkontrollens steg', () => {
  const ask = player.slice(player.indexOf('func askReady('), player.indexOf('func bufferedEnd('));
  assert.match(ask, /w\.wantsReady, !seekRestarting, player\.timeControlStatus == \.playing/, 'bara när bilden rör sig, inte under en omstart');
  assert.match(ask, /SeekCore\.readyURL\(cur\.absoluteString\)/, 'adressen som spelas nu (även efter byte från hemadressen)');
  assert.match(ask, /timeoutInterval: 3\)/);
  assert.match(ask, /let sent = ProcessInfo\.processInfo\.systemUptime/, 'samma klocka som mätningarna');
  assert.match(ask, /seekWatch\?\.setReady\(r, sentAt: sent, seq: seq\)/);
  assert.match(player, /at: ProcessInfo\.processInfo\.systemUptime,\s*playing:/);
  const ws = player.slice(player.indexOf('func watchStream('), player.indexOf('func askReady('));
  assert.match(ws, /Task\.sleep\(nanoseconds: UInt64\(SeekCore\.readyEvery \* 1_000_000_000\)\)/);
  assert.match(ws, /self\.seekGen == sg, self\.seekWatch != nil else \{ return \}\s*await self\.askReady\(sg: sg\)/);
  // Frågorna slutar vid omstart, ny titel och stängning
  assert.match(player.slice(player.indexOf('func seekRestart(')), /seekWatch = nil\s*readyTask\?\.cancel\(\)/);
  assert.equal((player.match(/readyTask\?\.cancel\(\)\s*readyTask = nil/g) || []).length, 3, 'resetState, close och seekRestart');
  // Väntan på fler steg: 0,6 s på Apple TV (fjärrkontrollen), kort på iPhone/iPad (reglaget)
  assert.match(swift, /static func settle\(remote: Bool\) -> Double \{ remote \? stepSettle : scrubSettle \}/);
  assert.match(swift, /static let scrubSettle: Double = 0\.3\b/);
  assert.match(player, /#if os\(tvOS\)\s*return SeekCore\.settle\(remote: true\)\s*#else\s*return SeekCore\.settle\(remote: false\)/);
  assert.match(player, /let wait = PlayerController\.settle[\s\S]{0,120}Task\.sleep\(nanoseconds: UInt64\(wait \* 1_000_000_000\)\)/);
  assert.ok(!/SeekCore\.stepSettle \* 1_000_000_000/.test(player), 'iPhone väntar inte 0,6 s');
});
