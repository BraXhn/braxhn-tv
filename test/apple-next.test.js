// iOS/tvOS-appens nästa avsnitt när avsnittet är slut (apps/apple/Shared/NextCore.swift + Player.swift): kontots val
// Spela nästa avsnitt automatiskt (autoNext i /playback) med samma regler som webben (nextPlan i
// web/js/player/autoskip.js) och Expo-appen (src/skipcore.ts), kortet "Nästa avsnitt om N s" och förvärmningen av
// nästa avsnitt. Swift kompileras inte här (bara i GitHub Actions på macOS), så det här är statiska kontroller.
// Förut startade ended() alltid nästa avsnitt direkt, även när föräldern stängt av valet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const shared = (f) => fs.existsSync(path.join(ROOT, 'apps', 'apple', 'Shared', f)) ? read('apps', 'apple', 'Shared', f) : '';
const core = shared('NextCore.swift');
const player = shared('Player.swift');
const start = shared('Start.swift');
const models = shared('Models.swift');
const strings = read('apps', 'apple', 'Shared', 'Resources', 'en.lproj', 'Localizable.strings');
const contract = JSON.parse(read('test', 'contracts', 'apps.json'));

/** Funktionens kropp (från namnet till nästa func/struct/enum på samma eller lägre indrag) */
function body(src, name) {
  const i = src.indexOf(name);
  assert.ok(i >= 0, `${name} finns`);
  const indent = src.slice(src.lastIndexOf('\n', i) + 1, i).match(/^\s*/)[0];
  const rest = src.slice(i + name.length);
  const re = new RegExp(`\\n${indent}(?:(?:private |fileprivate |static |mutating |@\\w+ )*(?:func|struct|enum|var|let|init)\\b|\\})`);
  const m = re.exec(rest);
  return src.slice(i, m ? i + name.length + m.index : undefined);
}

test('ren typ: NextCore.swift använder bara Foundation', () => {
  assert.ok(core, 'apps/apple/Shared/NextCore.swift finns');
  assert.deepEqual([...core.matchAll(/^import (\w+)/gm)].map((m) => m[1]), ['Foundation']);
});

test('slutet av avsnittet läser kontots val (felet: nästa avsnitt startade alltid direkt)', () => {
  const ended = body(player, 'private func ended()');
  assert.ok(!/if let next = item\?\.nextId \{ load\(itemId: next/.test(ended), 'ended() startar inte längre nästa avsnitt utan att fråga');
  assert.match(ended, /switch NextCore\.end\(pb\?\.autoNext, hasNext: item\?\.nextId != nil\)/);
  assert.match(ended, /case \.close: onFinished\?\(\)/, 'valet av: spelaren stängs');
  assert.match(ended, /case \.next: playNext\(\)/, '0 s: direkt');
  assert.match(ended, /case \.card\(let seconds\): showNext\(seconds\)/);
  assert.match(ended, /guard !closed, nextIn == nil else \{ return \}/, 'kortet visas en gång');
  assert.match(models, /struct Playback: Decodable \{[\s\S]*?let autoNext: AutoNext\?\n\}/);
});

test('samma regler som webbens nextPlan: av, 0 s, 0–60 s och 8 s utan autoNext', async () => {
  const plan = body(core, 'static func plan(');
  assert.match(plan, /guard hasNext else \{ return nil \}/);
  assert.match(plan, /guard let n else \{ return Plan\(auto: true, seconds: fallback\) \}/);
  assert.match(plan, /if let c = n\.countdown, c\.isFinite \{ s = Int\(min\(Double\(longest\), max\(0, c\)\)\) \}/, 'kapas före Int (inget fel för stora tal)');
  assert.match(plan, /return Plan\(auto: n\.enabled == true, seconds: s\)/);
  assert.match(core, /static let fallback = 8\b/);
  assert.match(core, /static let longest = 60\b/);
  const end = body(core, 'static func end(');
  assert.match(end, /guard let p = plan\(n, hasNext: hasNext\), p\.auto else \{ return \.close \}/);
  assert.match(end, /return p\.seconds == 0 \? \.next : \.card\(seconds: p\.seconds\)/);
  // Webben ger samma svar i fallen som Swift-koden ovan bygger på (countdown kapas till 0–60, decimaler bort)
  const web = await import('../web/js/player/autoskip.js');
  const swift = (n, hasNext) => {
    if (!hasNext) return null;
    if (!n) return { auto: true, seconds: 8 };
    const c = typeof n.countdown === 'string' ? parseInt(n.countdown) : n.countdown;
    const s = Number.isFinite(c) ? Math.trunc(Math.min(60, Math.max(0, c))) : 8;
    return { auto: n.enabled === true, seconds: s };
  };
  const cases = [null, {}, { enabled: false, countdown: 10 }, { enabled: true, countdown: 0 }, { enabled: true, countdown: 10 },
    { enabled: true, countdown: 600 }, { enabled: true, countdown: -4 }, { enabled: true, countdown: 7.9 },
    { enabled: true, countdown: '12' }, { enabled: true, countdown: ' 5 s' }, { enabled: true, countdown: 'x' }, { enabled: true }];
  for (const n of cases) for (const hasNext of [false, true]) {
    const pb = n === null ? null : { autoNext: Object.keys(n).length ? n : undefined };
    assert.deepEqual(swift(pb?.autoNext, hasNext), web.nextPlan(pb, hasNext), JSON.stringify({ n, hasNext }));
  }
});

test('autoNext tas emot som heltal, decimaltal eller text, och fel typ stoppar inte uppspelningen', () => {
  const dec = body(core, 'init(from decoder: Decoder) throws');
  assert.match(dec, /guard let c = try\? decoder\.container\(keyedBy: CodingKeys\.self\) else \{ return \}/);
  assert.match(dec, /enabled = try\? c\.decodeIfPresent\(Bool\.self, forKey: \.enabled\)/);
  assert.match(dec, /decodeIfPresent\(Int\.self, forKey: \.countdown\)[\s\S]*decodeIfPresent\(Double\.self, forKey: \.countdown\)[\s\S]*decodeIfPresent\(String\.self, forKey: \.countdown\) \{ countdown = NextCore\.leadingInt\(s\)/);
  assert.ok(!/try c\./.test(dec), 'inget fält kastar');
  const li = body(core, 'static func leadingInt(');
  assert.match(li, /drop\(while: \{ \$0 == " " \|\| \$0 == "\\t" \|\| \$0 == "\\n" \}\)/);
  assert.match(li, /prefix\(while: \{ \$0\.isASCII && \$0\.isNumber \}\)/);
  assert.match(li, /return sign \* \(Int\(digits\) \?\? Int\.max\)/, 'för stort tal: kapas ändå till 60');
  assert.equal(contract.typer['Playback.ios'].optional.autoNext.optional.countdown, 'number');
  assert.equal(contract.typer['Playback.ios'].optional.autoNext.optional.enabled, 'boolean');
  // Servern skickar valet i /playback
  assert.match(read('server', 'routes', 'playback.js'), /autoNext: \{ enabled: prefs\.autoNext, countdown: prefs\.nextCountdown \}/);
});

test('kortet: nedräkning varje sekund, Spela nu och Avbryt, Apple TV med fokus på Spela nu och Menu = Avbryt', () => {
  const cd = body(core, 'struct Countdown');
  assert.match(cd, /init\(seconds: Int\) \{ left = max\(0, seconds\) \}/);
  assert.match(cd, /if left > 0 \{ left -= 1 \}\s*return left <= 0/);
  const show = body(player, 'fileprivate func showNext(');
  assert.match(show, /warmNext\(\)\s*nextIn = NextCore\.Countdown\(seconds: seconds\)\.left/, 'förvärmningen börjar när kortet visas');
  assert.match(show, /var cd = NextCore\.Countdown\(seconds: seconds\)/);
  assert.match(show, /Task\.sleep\(nanoseconds: 1_000_000_000\)/);
  assert.match(show, /self\.generation == gen, self\.nextIn != nil/, 'Avbryt eller ny titel stoppar nedräkningen');
  assert.match(show, /if go \{ self\.playNext\(\); return \}\s*self\.warmNext\(\)/, 'förvärmningen hålls vid liv');
  const next = body(player, 'func playNext()');
  assert.match(next, /load\(itemId: next, at: 0, audio: nil, subtitle: nil\)/);
  assert.match(body(player, 'func cancelNext()'), /nextTask\?\.cancel\(\)\s*nextTask = nil\s*nextIn = nil/);
  // Stängs spelaren eller startar en ny titel försvinner kortet
  assert.match(body(player, 'private func resetState()'), /nextTask\?\.cancel\(\)\s*nextTask = nil\s*nextIn = nil/);
  assert.match(body(player, 'func close()'), /nextTask\?\.cancel\(\)/);
  // Vyn
  const card = body(player, 'struct NextCard: View');
  assert.match(card, /Text\(String\(format: L\("Nästa avsnitt om %d s"\), max\(0, seconds\)\)\)/);
  assert.match(card, /Button\(action: play\) \{ Label\("Spela nu", systemImage: "play\.fill"\) \}[\s\S]*?\.focused\(\$focusPlay\)/);
  assert.match(card, /Button\("Avbryt", action: cancel\)/);
  assert.match(card, /#if os\(tvOS\)\s*\.onExitCommand\(perform: cancel\)\s*#endif/);
  assert.match(card, /\.onAppear \{ DispatchQueue\.main\.async \{ focusPlay = true \} \}/);
  assert.match(player, /if let n = ctrl\.nextIn, ctrl\.error == nil, ctrl\.stopNotice == nil \{\s*NextCard\(seconds: n, play: \{ ctrl\.playNext\(\) \}, cancel: \{ ctrl\.cancelNext\(\) \}\)/);
  // Apple TV: spelarvyn tas bort medan kortet syns (annars behåller AVPlayerViewController fokus)
  assert.match(player, /if ctrl\.error == nil && ctrl\.stopNotice == nil && !cardTakesFocus \{\s*PlayerVC\(/);
  assert.match(body(player, 'private var cardTakesFocus: Bool'), /#if os\(tvOS\)\s*return ctrl\.nextIn != nil\s*#else\s*return false/);
  // iPhone/iPad: hoppknappen syns inte ovanpå kortet
  assert.match(player, /if let s = ctrl\.skipTitle, ctrl\.nextIn == nil \{/);
  for (const k of ['Nästa avsnitt om %d s', 'Spela nu', 'Avbryt']) assert.ok(strings.includes(`"${k}" = `), `${k} på engelska`);
  assert.match(strings, /"Nästa avsnitt om %d s" = "Next episode in %d s";/);
  assert.match(strings, /"Spela nu" = "Play now";/);
});

test('förvärmning av nästa avsnitt: när eftertexterna börjar och under nedräkningen, med samma fråga som uppspelningen', () => {
  const tick = body(player, 'private func tick(');
  assert.match(tick, /if NextCore\.warmsNext\(skip: skip, nextKind: SkipKind\.next\) \{ warmNext\(\) \}/);
  assert.match(tick, /else if let c = credits, item\?\.nextId != nil, t >= c, t < c \+ 60 \{ skip = SkipKind\.next \}/, 'eftertexterna: den första minuten');
  assert.match(body(core, 'static func warmsNext('), /skip == nextKind/);
  const warm = body(player, 'fileprivate func warmNext()');
  assert.match(warm, /guard !closed, let next = item\?\.nextId else \{ return \}/);
  assert.match(warm, /Start\.warm\(model, id: next, start: 0, audio: nil, subtitle: nil\)/);
  // Samma fråga: Start.warm bygger den med Start.query(..., cinema: true), och nästa avsnitt spelas från början med
  // load(..., cinema: true) som standard – samma Start.query i start()
  assert.match(start, /StartCore\.warmQuery\(query\(model, audio: audio, subtitle: subtitle, start: start, cinema: true\)\)/);
  assert.match(player, /func load\(itemId: Int, at start: Double, audio: Int\?, subtitle: SubtitleTrack\?, cinema: Bool = true\)/);
  assert.match(player, /let q = Start\.query\(model, audio: audio, subtitle: subtitle, start: start, cinema: cinema\)/);
  // Knappen Nästa avsnitt under eftertexterna spelar på samma sätt
  assert.match(body(player, 'func skip()'), /else if let next = item\?\.nextId \{\s*load\(itemId: next, at: 0, audio: nil, subtitle: nil\)/);
  assert.ok(contract.endpoints['GET /api/items/:id/playback?warm=1'].ios, 'warm=1 för ios i kontraktet');
});
