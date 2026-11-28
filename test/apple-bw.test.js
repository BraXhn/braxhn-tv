// iOS/tvOS-appens mätning av uppkopplingen utanför hemmet (apps/apple/Shared/BwCore.swift + Bandwidth.swift, Start.swift
// och Player.swift). Swift kompileras inte här (bara i GitHub Actions på macOS), så det här är statiska kontroller:
// reglerna är samma som webbens (web/js/player/caps.js: sample, lastBandwidth, noteBandwidth) och att servern väljer
// startsteget efter bw provas i serverns egna test (stream-smooth.test.js) och i test/api-contract.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rateOf } from '../web/js/player/hlsconfig.js';

const ROOT = path.join(import.meta.dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));
const shared = (f) => exists('apps', 'apple', 'Shared', f) ? read('apps', 'apple', 'Shared', f) : '';
const core = shared('BwCore.swift');
const bw = shared('Bandwidth.swift');
const start = shared('Start.swift');
const player = shared('Player.swift');
const hemma = shared('Hemma.swift');
const appModel = shared('AppModel.swift');
const caps = read('web', 'js', 'player', 'caps.js');
const contract = JSON.parse(read('test', 'contracts', 'apps.json'));

/** Funktionens kropp i Swift (från namnet till nästa static func/struct på samma nivå) */
function body(src, name) {
  const i = src.indexOf(name);
  assert.ok(i >= 0, `${name} finns`);
  const rest = src.slice(i + name.length);
  const j = rest.search(/\n    (static func |struct |\/\/\/ )/);
  return src.slice(i, j < 0 ? undefined : i + name.length + j);
}

test('ren typ: BwCore.swift använder bara Foundation', () => {
  assert.ok(core, 'apps/apple/Shared/BwCore.swift finns');
  const imports = [...core.matchAll(/^import (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['Foundation']);
});

test('samma gränser som webben: mätningen gäller 10 minuter, provet är 4 MB och högst 1 s', () => {
  assert.match(caps, /Date\.now\(\) - net\.at < 10 \* 60e3/);
  assert.match(core, /static let maxAge: Double = 600\b/);
  assert.match(caps, /SAMPLE_KB = 4096, SAMPLE_MS = 1000/);
  assert.match(core, /static let sampleKB = 4096\b/);
  assert.match(core, /static let sampleSeconds: Double = 1\b/);
  // Servern håller en förvärmd ström i 20 s: så länge skickar uppspelningen förvärmningens bw
  assert.match(core, /static let warmHold: Double = 20\b/);
});

test('takten: efter första tredjedelen, som webbens rateOf (svarstid och TCP:s början räknas inte)', () => {
  const r = body(core, 'static func rate(');
  assert.match(r, /marks\.first\(where: \{ Double\(\$0\.bytes\) >= Double\(total\) \/ 3 \}\) \?\? marks\[0\]/);
  assert.match(r, /last\.t - from\.t >= 0\.02 && last\.bytes > from\.bytes \? from : marks\[0\]/, '20 ms som webben');
  assert.match(r, /Double\(bytes\) \* 8 \/ \(secs \* 1000\)/, 'byte/s × 8 / 1000 = kbit/s');
  // Webbens regel: 4 MB som kommer på 700 ms efter 300 ms svarstid är ~48 Mbit/s, inte 4 MB/1 s ≈ 34 Mbit/s
  const marks = [[0, 0]]; for (let i = 1; i <= 64; i++) marks.push([300 + i * (700 / 64), i * 65536]);
  const k = rateOf(marks);
  assert.ok(k > 45000 && k < 50000, `rateOf ${k}`);
  // observedBitrate är bit/s; 0, negativt och NaN räknas inte som en mätning
  const kb = body(core, 'static func kbps(observedBitrate');
  assert.match(kb, /guard b\.isFinite, b > 0 else \{ return nil \}/);
  assert.match(kb, /Int\(\(b \/ 1000\)\.rounded\(\)\)/);
});

test('utanför hemmet = servern säger remote och appen går inte via hemadressen; hemma mäts och skickas inget', () => {
  assert.match(body(core, 'static func outside('), /remote && !viaHome/);
  assert.match(bw, /BwCore\.outside\(remote: model\.remote, viaHome: model\.home\.via != nil\)/);
  assert.match(body(bw, 'static func fresh('), /guard outside\(model\), bookServer == model\.server else \{ return nil \}/);
  assert.match(body(bw, 'static func note(_ model: AppModel, kbps'), /guard outside\(model\), kbps > 0 else \{ return \}/);
  const kick = body(bw, 'static func kick(');
  assert.match(kick, /guard model\.isLoggedIn, running == nil, model\.home\.checking == 0, outside\(model\), fresh\(model\) == nil/);
  // Provet av hemadressen kan visa att appen är hemma: ingen mätning under tiden, sedan ett nytt försök
  assert.match(hemma, /home\.checking \+= 1\s*await checkHomeNow\(\)\s*home\.checking -= 1[\s\S]{0,140}Bandwidth\.kick\(self\)/);
});

test('mätningen sparas per nät och server, och en ny takt (provet eller AVPlayer) ersätter den', () => {
  const fresh = body(core, 'func fresh(now:');
  assert.match(fresh, /guard kbps > 0, net == self\.net, now - at < maxAge, now >= at else \{ return nil \}/);
  assert.match(body(core, 'mutating func note('), /guard kbps > 0 else \{ return \}/);
  assert.match(bw, /book\.fresh\(now: now, net: model\.home\.net\.generation\)/);
  assert.match(bw, /guard net == model\.home\.net\.generation, server == model\.server else \{ return \}/, 'nätet byttes under provet');
  // AVPlayer: var 10:e sekund under uppspelningen, inte för en nedladdad film
  assert.match(player, /if !isLocal \{ Bandwidth\.note\(model, observedBitrate: player\.currentItem\?\.accessLog\(\)\?\.events\.last\?\.observedBitrate\) \}/);
});

test('mätningen i bakgrunden: när appen öppnas, kommer tillbaka och när nätet byts – starten väntar aldrig på den', () => {
  assert.match(appModel, /func restore\(\)[\s\S]*?Bandwidth\.kick\(self\)[\s\S]*?func refreshUser/);
  assert.match(appModel, /func refreshUser\(\)[\s\S]*?remote = s\.remote \?\? false[\s\S]*?Bandwidth\.kick\(self\)/);
  // forPlay startar en mätning till nästa gång men väntar inte
  const fp = body(bw, 'static func forPlay(');
  assert.match(fp, /if f == nil \{ kick\(model\) \}/);
  assert.ok(!/await/.test(fp), 'forPlay väntar inte');
  assert.ok(!/SpeedProbe/.test(start + player), 'spelaren och förvärmningen väntar aldrig på provet');
  // Provet: 200, tiden med systemUptime, avbryts efter sampleSeconds från första byte
  assert.match(bw, /statusCode == 200 else \{ completionHandler\(\.cancel\); finish\(0\); return \}/);
  assert.match(bw, /now - \(marks\.first\?\.t \?\? now\) > BwCore\.sampleSeconds \? marks : nil/);
  assert.match(bw, /model\.url\("\/api\/speedtest", \[URLQueryItem\(name: "kb", value: String\(BwCore\.sampleKB\)\)/);
  assert.match(bw, /setValue\("Bearer \\\(tok\)", forHTTPHeaderField: "Authorization"\)/, 'inloggningen i headern, inte i adressen');
});

test('förvärmningen och uppspelningen skickar samma bw', () => {
  assert.match(body(core, 'static func query('), /guard let k = kbps, k > 0 else \{ return \[\] \}\s*return \[URLQueryItem\(name: "bw", value: String\(k\)\)\]/);
  // Samma titel förvärmd nyss: förvärmningens bw, även om en ny mätning kommit emellan
  // – också inget bw, om förvärmningen skickades innan mätningen var klar (förvärmningen väntar aldrig på provet)
  assert.match(body(core, 'static func playBw('), /if let w = warmed, w\.id == id, now >= w\.at, now - w\.at < warmHold \{ return w\.bw \}\s*return fresh/);
  assert.match(core, /let bw: Int\?\n/, 'Warmed.bw kan vara inget');
  assert.match(body(bw, 'static func didWarm('), /warmed = BwCore\.Warmed\(id: id, bw: bw, at: now\)/);
  assert.match(body(bw, 'static func forPlay('), /guard outside\(model\) else \{ return nil \}/, 'hemma inget bw');
  const warm = start.slice(start.indexOf('static func warm('), start.indexOf('static func drop('));
  assert.match(warm, /let bw = Bandwidth\.forPlay\(model, id: id\)\s*let q = StartCore\.warmQuery/);
  assert.match(warm, /guard log\.take\([^\n]*\n\s*Bandwidth\.didWarm\(id: id, bw: bw\)/, 'bara en förvärmning som skickades räknas');
  assert.match(player, /let q = Start\.query\(model, audio: audio, subtitle: subtitle, start: start, cinema: cinema, bw: Bandwidth\.forPlay\(model, id: itemId\)\)/);
  // Spolning i en omkodning (ny ström vid målet): den senaste takten, ofta AVPlayers egen
  assert.match(player, /model\.comfortQuery\(\) \+ BwCore\.query\(Bandwidth\.fresh\(model\)\)\s*q\.append\(URLQueryItem\(name: "start"/);
});

test('kontraktet: bw i /playback och förvärmningen för ios, och provet /api/speedtest', () => {
  const play = contract.endpoints['GET /api/items/:id/playback'].ios.query;
  const warm = contract.endpoints['GET /api/items/:id/playback?warm=1'].ios.query;
  const pq = play.find((q) => q.bw);
  assert.ok(pq && /^\d+$/.test(pq.bw), 'en uppspelning med bw');
  const wq = warm.find((q) => q.bw);
  assert.ok(wq, 'en förvärmning med bw');
  const same = { ...wq }; delete same.warm;
  assert.ok(play.some((q) => JSON.stringify(Object.entries(q).sort()) === JSON.stringify(Object.entries(same).sort())), 'förvärmningens fråga med bw finns som uppspelning');
  const st = contract.endpoints['GET /api/speedtest'];
  assert.ok(st?.ios, 'GET /api/speedtest har ios');
  assert.deepEqual(Object.keys(st.ios.query).sort(), ['kb', 'n']);
  assert.equal(st.ios.query.kb, '4096');
});
