// iOS/tvOS-appens skärmtid i spelaren (apps/apple/Shared/ScreenLeftCore.swift + Player.swift): "X min kvar idag" och
// varningen de sista fem minuterna, med samma regler och ord som webbspelaren (playerLeft i
// web/js/player/screenleft.js), Android-appen (ScreenLeftCore.kt) och Expo-appen (src/screenleft.ts). Swift kompileras
// inte här (bara i GitHub Actions på macOS), så det här är statiska kontroller. Förut läste appen screenTime bara för
// att stoppa: barnet stoppades utan förvarning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const shared = (f) => fs.existsSync(path.join(ROOT, 'apps', 'apple', 'Shared', f)) ? read('apps', 'apple', 'Shared', f) : '';
const core = shared('ScreenLeftCore.swift');
const player = shared('Player.swift');
const appModel = shared('AppModel.swift');
const offline = shared('OfflineCore.swift');
const kt = read('apps', 'automotive', 'app', 'src', 'main', 'java', 'net', 'braxhn', 'tv', 'ScreenLeftCore.kt');
const strings = read('apps', 'apple', 'Shared', 'Resources', 'en.lproj', 'Localizable.strings');
const contract = JSON.parse(read('test', 'contracts', 'apps.json'));

/** Funktionens kropp (till dess avslutande } på samma indrag, eller nästa deklaration på samma indrag) */
function body(src, name) {
  const i = src.indexOf(name);
  assert.ok(i >= 0, `${name} finns`);
  const indent = src.slice(src.lastIndexOf('\n', i) + 1, i).match(/^\s*/)[0];
  const rest = src.slice(i + name.length);
  const m = new RegExp(`\\n${indent}(?:(?:private |fileprivate |static |@\\w+ )*(?:func|struct|enum|var|let)\\b|\\})`).exec(rest);
  return src.slice(i, m ? i + name.length + m.index : undefined);
}

test('ren typ: ScreenLeftCore.swift använder bara Foundation', () => {
  assert.ok(core, 'apps/apple/Shared/ScreenLeftCore.swift finns');
  assert.deepEqual([...core.matchAll(/^import (\w+)/gm)].map((m) => m[1]), ['Foundation']);
});

test('tiden kvar: samma regel som webben och Android (minst 1 min, varning vid 5 min eller mindre)', async () => {
  assert.match(core, /static let warnLeft: Double = 5 \* 60\b/);
  assert.match(kt, /const val WARN_LEFT = 5 \* 60\.0/);
  const of = body(core, 'static func of(');
  assert.match(of, /guard limited, allowed, let left, left\.isFinite else \{ return nil \}/);
  assert.match(of, /let l = max\(0, left\)/);
  assert.match(of, /Left\(minutes: max\(1, Int\(\(min\(l, 86_400\) \/ 60\)\.rounded\(\.up\)\)\), warn: l <= warnLeft\)/);
  // Det Swift-koden räknar, fall för fall mot webbens playerLeft (upp till ett dygn)
  const web = await import('../web/js/player/screenleft.js');
  const swift = (limited, allowed, left) => {
    if (!limited || !allowed || left == null || !Number.isFinite(left)) return null;
    const l = Math.max(0, left);
    return { min: Math.max(1, Math.ceil(Math.min(l, 86400) / 60)), warn: l <= 300 };
  };
  for (let s = -5; s <= 86400; s += 7) assert.deepEqual(swift(true, true, s), web.playerLeft({ limited: true, allowed: true, left: s }), `${s} s`);
  assert.equal(web.playerLeft({ limited: true, allowed: false, left: 0 }), swift(true, false, 0), 'slut: spelaren stoppas i stället');
  assert.equal(web.playerLeft({ limited: false, allowed: true, left: 60 }), swift(false, true, 60));
});

test('serverns status: left, en äldre server ger remaining, och appens egen räkning utan nät', () => {
  assert.match(body(core, 'static func ofServer('), /of\(limited: s\.limited, allowed: s\.allowed == true, left: s\.left \?\? s\.remaining\)/);
  assert.match(kt, /of\(limited, allowed, left \?: remaining\)/);
  assert.match(body(core, 'static func ofGate('), /of\(limited: g\.left != nil, allowed: g\.allowed, left: g\.left\.map\(Double\.init\)\)/);
  // ScreenStatus tar emot allowed och left (heltal eller decimaltal), och räkningen utan nät använder dem inte
  const st = offline.slice(offline.indexOf('struct ScreenStatus'), offline.indexOf('struct ScreenCache'));
  assert.match(st, /var allowed: Bool\?\s*var left: Double\?/);
  assert.match(st, /case limited, day, daily, used, extra, remaining, from, until, audio, allowed, left \}/);
  assert.match(st, /allowed = try\? c\.decodeIfPresent\(Bool\.self, forKey: \.allowed\)\s*left = num\(\.left\)/);
  const gate = offline.slice(offline.indexOf('static func gate('), offline.indexOf('static func toMin('));
  assert.ok(!/\.left\b|\.allowed\b/.test(gate.replace(/ScreenGate\([^)]*\)/g, '')), 'ScreenClock.gate räknar som förut');
  assert.equal(contract.typer['ScreenStatus.ios'].optional.left, 'number');
  assert.equal(contract.typer['ScreenTimeState.android'].optional.left, 'number', 'samma fält som Android');
});

test('spelaren: först appens senast kända status, sedan serverns svar på varje framsteg, utan nät appens räkning', () => {
  // Framstegssvaret läses en gång och ges till spelaren (även Apple TV, som inte sparar statusen)
  const rp = body(appModel, 'func reportProgress(');
  assert.match(rp, /noAnswer: \(\(\) -> Void\)\? = nil, onScreen: \(\(ScreenStatus\?\) -> Void\)\? = nil\)/);
  assert.match(rp, /let screen = try\? JSONDecoder\(\)\.decode\(ProgressScreen\.self, from: data\)\s*#if os\(iOS\)\s*if let ps = screen \{ OfflineScreen\.note\(self, ps\.screenTime\) \}\s*#endif\s*if let ps = screen \{ onScreen\?\(ps\.screenTime\) \}/);
  const tick = body(player, 'private func tick(');
  assert.match(tick, /onScreen: \{ \[weak self\] st in\s*Task \{ @MainActor \[weak self\] in self\?\.screenFromServer\(st, id: id, gen: gen\) \}/);
  const fromServer = body(player, 'fileprivate func screenFromServer(');
  assert.match(fromServer, /guard !closed, gen == generation, currentId == id else \{ return \}\s*screenLeft = ScreenLeftCore\.ofServer\(st\)/, 'saknas screenTime: ingen skärmtid');
  // Start: senast kända status (iPhone/iPad sparar den), nedladdad titel: grinden som just släppte igenom
  const st = body(player, 'private func start(itemId:');
  assert.match(st, /if let l = ScreenLeftCore\.ofGate\(OfflineScreen\.gateNow\(model\)\) \{ screenLeft = l \}/);
  assert.match(st, /if !gate\.allowed \{ stopNotice = OfflineScreen\.message\(gate\); return \}\s*screenLeft = ScreenLeftCore\.ofGate\(gate\)/);
  assert.match(body(player, 'fileprivate func playedOffline('), /if !closed, gen == generation, currentId == id \{ screenLeft = ScreenLeftCore\.ofGate\(g\) \}/);
});

test('texterna: samma ord som webben på svenska och engelska, och när de syns', () => {
  assert.match(body(core, 'static func amount('), /minutes >= 60 \? String\(format: tr\("%d h %d min"\), minutes \/ 60, minutes % 60\) : String\(format: tr\("%d min"\), minutes\)/);
  const tx = body(core, 'static func texts(');
  assert.match(tx, /tr\(compact \? "⏱ %@ kvar" : "%@ kvar idag"\)/);
  assert.match(tx, /l\.warn \? String\(format: tr\("Skärmtiden tar slut om %d min"\), l\.minutes\) : ""/);
  // Webben: '{left} kvar idag', '⏱ {left} kvar', 'Skärmtiden tar slut om {v} min' (web/i18n/en.js)
  const en = read('web', 'i18n', 'en.js');
  const pairs = [['%@ kvar idag', '%@ left today', '{left} kvar idag', '{left} left today'], ['⏱ %@ kvar', '⏱ %@ left', '⏱ {left} kvar', '⏱ {left} left'],
    ['Skärmtiden tar slut om %d min', 'Screen time runs out in %d min', 'Skärmtiden tar slut om {v} min', 'Screen time runs out in {v} min'],
    ['%d h %d min', '%d h %d min', '{v} h {v2} min', null], ['%d min', '%d min', null, null]];
  for (const [sv, eng, wsv, wen] of pairs) {
    assert.ok(strings.includes(`"${sv}" = "${eng}";`), `${sv} på engelska`);
    if (wen) assert.ok(en.includes(`"${wsv}": "${wen}"`), `webben säger samma: ${wsv}`);
  }
  assert.match(read('web', 'js', 'player', 'screenleft.js'), /t\('\{v\} h \{v2\} min'/);
  // Varje text som ScreenLeftCore översätter finns i en.lproj
  for (const m of core.matchAll(/tr\("((?:[^"\\]|\\.)*)"\)/g)) assert.ok(strings.includes(`"${m[1]}" = `), `${m[1]} saknas i en.lproj`);
  for (const m of core.matchAll(/tr\(compact \? "([^"]+)" : "([^"]+)"\)/g)) for (const k of [m[1], m[2]]) assert.ok(strings.includes(`"${k}" = `), k);
  // iPhone/iPad: i spelarens överkant (kort text på en smal skärm). Apple TV: när filmen är pausad. Varningen syns
  // hela tiden de sista fem minuterna, och inte när spelaren stoppats eller visar ett fel
  assert.match(player, /if let l = ctrl\.screenLeft, ctrl\.stopNotice == nil \{\s*leftPill\(ScreenLeftCore\.texts\(l, compact: sizeClass == \.compact, tr: L\)\.pill, low: l\.warn\)/);
  assert.match(player, /#if os\(tvOS\)[\s\S]{0,120}if let l = ctrl\.screenLeft, ctrl\.paused, ctrl\.error == nil, ctrl\.stopNotice == nil, ctrl\.nextIn == nil \{/);
  assert.match(player, /if let l = ctrl\.screenLeft, l\.warn, ctrl\.error == nil, ctrl\.stopNotice == nil \{\s*VStack \{\s*Text\(ScreenLeftCore\.texts\(l, compact: false, tr: L\)\.warn\)/);
  assert.match(player, /let paused = p\.timeControlStatus == \.paused/);
});

test('VoiceOver läser upp varningen när den syns och när minuten ändras – inte vid varje framsteg', () => {
  const an = body(core, 'static func announce(');
  assert.match(an, /guard let n = new, n\.warn else \{ return false \}/);
  assert.match(an, /guard let o = old, o\.warn else \{ return true \}/);
  assert.match(an, /return o\.minutes != n\.minutes/);
  const prop = player.slice(player.indexOf('@Published private(set) var screenLeft'), player.indexOf('@Published private(set) var paused'));
  assert.match(prop, /didSet \{\s*guard ScreenLeftCore\.announce\(from: oldValue, to: screenLeft\), let l = screenLeft else \{ return \}\s*UIAccessibility\.post\(notification: \.announcement, argument: ScreenLeftCore\.texts\(l, compact: false, tr: L\)\.warn\)/);
  // Samma som Android (liveRegion när varningen syns) och Expo (accessibilityLiveRegion)
  assert.match(read('apps', 'automotive', 'app', 'src', 'main', 'java', 'net', 'braxhn', 'tv', 'PlayerScreen.kt'), /liveRegion = LiveRegionMode\.Polite/);
});
