// iOS/tvOS-appens snabbare start (apps/apple/Shared/StartCore.swift + Start.swift, DetailView.swift och Player.swift).
// Swift kompileras inte här (bara i GitHub Actions på macOS), så det här är statiska kontroller: reglerna är samma som
// Android-appens (StartCore.kt, provad på JVM i StartCoreTest.kt) och spelaren skickar /playback samtidigt som
// titelns uppgifter. Att servern tar över en förvärmd ström när frågan är densamma provas i test/api-contract.test.js
// (warm=1 för ios) och i serverns egna test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));
const shared = (f) => exists('apps', 'apple', 'Shared', f) ? read('apps', 'apple', 'Shared', f) : '';
const core = shared('StartCore.swift');
const start = shared('Start.swift');
const detail = shared('DetailView.swift');
const player = shared('Player.swift');
const models = shared('Models.swift');
const appModel = shared('AppModel.swift');
const kt = read('apps', 'automotive', 'app', 'src', 'main', 'java', 'net', 'braxhn', 'tv', 'StartCore.kt');
const contract = JSON.parse(read('test', 'contracts', 'apps.json'));

/** Funktionens kropp i Swift (från namnet till nästa funktion på samma nivå) */
function body(src, name) {
  const i = src.indexOf(name);
  assert.ok(i >= 0, `${name} finns`);
  const j = src.indexOf('\n    static func ', i + name.length);
  return src.slice(i, j < 0 ? undefined : j);
}

test('ren typ: StartCore.swift använder bara Foundation', () => {
  assert.ok(core, 'apps/apple/Shared/StartCore.swift finns');
  const imports = [...core.matchAll(/^import (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['Foundation']);
});

test('samma gränser som Android-appen: 0,7 s fokus, samma fråga högst var 15:e sekund', () => {
  assert.match(kt, /DWELL_MS = 700L/); assert.match(core, /static let dwell: Double = 0\.7\b/);
  assert.match(kt, /REPEAT_MS = 15_000L/); assert.match(core, /static let repeatAfter: Double = 15\b/);
  const log = core.slice(core.indexOf('struct WarmLog'));
  assert.match(log, /if let last = at\[key\], now - last < repeatAfter \{ return false \}/);
  assert.match(log, /if at\.count > 100 \{ at\.removeAll\(\) \}/);
  // Fokusen: förvärm först när fokus stått kvar, och inte om den hunnit flytta (task(id:) avbryts vid ny fokus)
  assert.match(start, /\.task\(id: focused\) \{ await dwell\(\) \}/);
  assert.match(start, /Task\.sleep\(nanoseconds: UInt64\(StartCore\.dwell \* 1_000_000_000\)\)\s*guard focused, !Task\.isCancelled/);
});

test('frågan: cinema=1 vid start från början (servern avgör), start i hela sekunder, warm=1 utan annan skillnad', () => {
  const ex = body(core, 'static func playExtras(');
  assert.match(ex, /if cinema && start < 1 \{ q\.append\(URLQueryItem\(name: "cinema", value: "1"\)\) \}/);
  assert.match(ex, /if start >= 1 \{ q\.append\(URLQueryItem\(name: "start", value: String\(Int\(start\)\)\)\) \}/);
  assert.match(kt, /"cinema" to \(if \(!skipPreroll && start < 1\) "1" else null\)/);
  assert.match(kt, /"start" to \(if \(start >= 1\)/);
  assert.match(body(core, 'static func warmQuery('), /play\.filter \{ \$0\.name != "warm" \} \+ \[URLQueryItem\(name: "warm", value: "1"\)\]/);
  // Nyckeln: titeln och hela frågan sorterad, poster utan värde räknas inte
  assert.match(body(core, 'static func key('), /"\\\(id\)\?" \+ query\.compactMap \{ q in q\.value\.map \{ "\\\(q\.name\)=\\\(\$0\)" \} \}\.sorted\(\)\.joined\(separator: "&"\)/);
  // Förvärmningen och uppspelningen bygger frågan på samma ställe
  const q = start.slice(start.indexOf('static func query('));
  assert.match(q, /model\.capabilities\(audio: audio, subtitle: subtitle\) \+ model\.comfortQuery\(\) \+ StartCore\.playExtras\(start: start, cinema: cinema\)/);
  const warm = start.slice(start.indexOf('static func warm('), start.indexOf('static func drop('));
  assert.match(warm, /StartCore\.warmQuery\(query\(model, audio: audio, subtitle: subtitle, start: start, cinema: true\)\)/);
  assert.match(warm, /log\.take\(StartCore\.key\(id: id, q\)/);
  assert.match(warm, /Downloads\.shared\.localURL\(for: id\) != nil \{ return \}/, 'en nedladdad titel förvärms inte');
  assert.match(warm, /model\.get\("\/api\/items\/\\\(id\)\/playback", q\)/, 'via model.get (apiBase/hemadressen)');
});

test('ljudspåret: profilens förval på titelsidan, och förvalet skickas inte (som Android-appen)', () => {
  const ta = body(core, 'static func titleAudio<');
  assert.match(ta, /if let d = defaultAudio, let a = tracks\.first\(where: \{ index\(\$0\) == d \}\) \{ return index\(a\) \}/);
  assert.match(ta, /return index\(tracks\.first\(where: isDefault\) \?\? first\)/);
  assert.match(body(core, 'static func playAudio('), /guard let c = chosen, c != preset else \{ return nil \}/);
  // Samma regel som Android-appens StartCore.playAudio (grenen team/android-ljud-2026-11-28): chosen?.takeIf { it != preset }
  // Titelsidan: förut filens förvalda spår, som skickades som audio=<index> – profilens språk gällde inte
  assert.ok(!/audio = \(it\.audio\?\.first \{ \$0\.default == true \}/.test(detail), 'filens förvalda spår väljs inte längre');
  assert.match(detail, /presetAudio = StartCore\.titleAudio\(defaultAudio: it\.defaultAudio, tracks: it\.audio/);
  assert.match(detail, /StartCore\.playAudio\(chosen: audio >= 0 \? audio : nil, preset: presetAudio\)/);
  assert.ok(!/audio: audio >= 0 \? audio : nil/.test(detail), 'Spela skickar inte förvalet');
  assert.equal((detail.match(/PlayRequest\(itemId: it\.id, start: [^,]+, audio: playAudio,/g) || []).length, 3, 'Fortsätt, Börja om och Spela');
  assert.match(models, /let defaultAudio: Int\?/);
  assert.equal(contract.typer['MediaItem.ios'].optional.defaultAudio, 'integer');
});

test('förvärmning: Spela, Fortsätt, Börja om, nästa avsnitt och avsnitten (Apple TV), Spela när titelsidan öppnas (iPhone/iPad)', () => {
  assert.equal((detail.match(/\.warmOnFocus\(it\.id, start: (p|0), audio: playAudio, subtitle: selectedSubtitle\(it\)\)/g) || []).length, 3);
  assert.match(detail, /\.warmOnFocus\(n\.id, start: n\.position \?\? 0\)/);
  assert.match(detail, /\.cardButton\(\)\s*\.warmOnFocus\(e\.id, start: \(e\.position \?\? 0\) > 30 \? \(e\.position \?\? 0\) : 0\)/);
  // Samma position som knappen spelar (PlayRequest bredvid)
  assert.match(detail, /PlayRequest\(itemId: e\.id, start: \(e\.position \?\? 0\) > 30 \? \(e\.position \?\? 0\) : 0,/);
  // iPhone/iPad: en gång per titelsida (load körs igen när spelaren stängs)
  assert.match(detail, /#if os\(iOS\)[\s\S]{0,300}if !warmed \{ warmed = true; warmPrimary\(it\) \}[\s\S]{0,20}#endif/);
});

test('spelaren: /playback samtidigt med titeln, utan /api/me/cinema, och en ström som aldrig används stoppas med pid', () => {
  const fn = player.slice(player.indexOf('beginPreparing(gen: gen)\n        retries = 0'), player.indexOf('// xs: spellistan'));
  // Titeln hämtas medan förra strömmens stopp går iväg; /playback skickas först när stoppet nått servern
  assert.match(fn, /let itemTask = Task[^\n]*model\.get\("\/api\/items\/\\\(itemId\)"\)[\s\S]*await stopping\?\.value[\s\S]*StartCore\.together\(/);
  assert.match(fn, /let q = Start\.query\(model, audio: audio, subtitle: subtitle, start: start, cinema: cinema\)/);
  assert.match(fn, /playback: \{ \[model\] \(\) async throws -> Playback in try await model\.get\("\/api\/items\/\\\(itemId\)\/playback", q\) \}/);
  assert.match(fn, /drop: \{ \[model\] \(np: Playback\) in await Start\.drop\(model, id: itemId, np\) \}/);
  assert.match(fn, /guard isLive\(gen\) else \{[^}]*Start\.drop\(model, id: itemId, p\)/, 'ersatt eller stängd: den strömmen stoppas');
  assert.ok(fn.indexOf('StartCore.together(') < fn.indexOf('var sub = subtitle'), 'undertexten väljs efter svaret, den påverkar inte frågan');
  assert.ok(!/cinemaQuery|cinemaEnabled|\/api\/me\/cinema/.test(player + appModel), 'ingen extra rundresa för bio-läget');
  // Stoppet med pid (inte en nyare ström av samma titel)
  assert.match(start, /guard let pid = SeekCore\.pidOf\(p\.url\) else \{ return \}\s*_ = try\? await model\.post\("\/api\/stream\/\\\(id\)\/stop\?pid=\\\(pid\)"\)/);
  // together: /playback i en egen uppgift (avbryts inte med spelaren), och ett svar som aldrig används släpps
  const t = body(core, 'static func together<');
  assert.match(t, /let pb = Task \{ try await playback\(\) \}/);
  assert.match(t, /let it = try await item\(\)\s*return \(it, try await pb\.value\)/);
  assert.match(t, /catch \{[\s\S]*Task \{ if let p = try\? await pb\.value \{ await drop\(p\) \} \}\s*throw error/);
});

test('kontraktet: warm=1 för ios med samma fråga som uppspelningen, stopp med pid', () => {
  const w = contract.endpoints['GET /api/items/:id/playback?warm=1'];
  assert.ok(w.ios, 'GET /api/items/:id/playback?warm=1 har ios');
  for (const q of w.ios.query) {
    assert.equal(q.warm, '1');
    const play = { ...q }; delete play.warm;
    const same = contract.endpoints['GET /api/items/:id/playback'].ios.query.some((p) => ['c', 'v', 'a', 'hdr', 'dv'].every((k) => p[k] === play[k]));
    assert.ok(same, `förmågorna i ${JSON.stringify(q)} finns i uppspelningens frågor`);
  }
  assert.ok(contract.endpoints['POST /api/stream/:id/stop'].ios.query.some((q) => q.pid && !q.replaced));
});
