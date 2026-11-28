// iOS/tvOS-appens nedladdningar per server och profil och positioner som väntar på nätet (apps/apple/Shared/OfflineCore.swift
// + Offline.swift). Swift kompileras inte här (bara i GitHub Actions på macOS), så det här är statiska kontroller: reglerna
// är samma som Android-appens (DownloadCore.kt, OfflineCore.kt ProgressQueue, provade på JVM) och Expo-appens
// (offlinecore.ts, provad i test/expo-offline.test.js), och appen använder dem där det spelar roll: en barnprofil ser
// inte en vuxens nedladdningar, utloggning tar bort serverns nedladdningar och en position utan nät skickas med at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const SH = ['apps', 'apple', 'Shared'];
// Kommentarer bort, så att en regel som bara står i en kommentar inte räknas
const code = (s) => s.split('\n').map((l) => l.replace(/(^|[^:"])\/\/.*$/, '$1')).join('\n');
const core = code(read(...SH, 'OfflineCore.swift'));
const off = code(read(...SH, 'Offline.swift'));
const model = code(read(...SH, 'AppModel.swift'));
const listen = code(read(...SH, 'Listen.swift'));
const views = code(read(...SH, 'Views.swift'));
const app = code(read(...SH, 'BraXhnTVApp.swift'));
const KT = ['apps', 'automotive', 'app', 'src', 'main', 'java', 'net', 'braxhn', 'tv'];
const dlcore = read(...KT, 'DownloadCore.kt');
const ktcore = read(...KT, 'OfflineCore.kt');
const ts = read('apps', 'expo', 'src', 'offlinecore.ts');

/** Kroppen i en Swift-funktion (fram till nästa func på samma nivå eller filens slut) */
function fn(src, name) {
  const i = src.indexOf(`func ${name}(`);
  assert.ok(i >= 0, `func ${name} saknas`);
  const rest = src.slice(i + 5);
  const j = rest.search(/\n {4}(?:(?:private|fileprivate|static|@discardableResult) )*func |\n}\n/);
  return src.slice(i, j < 0 ? undefined : i + 5 + j);
}

test('OfflineCore.swift är en ren typ: bara Foundation', () => {
  const imports = [...read(...SH, 'OfflineCore.swift').matchAll(/^import (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['Foundation']);
  for (const bad of ['UserDefaults', 'FileManager', 'URLSession', 'AppModel', 'Downloads.shared']) assert.ok(!core.includes(bad), `OfflineCore använder ${bad}`);
});

test('mappen per server och profil: samma namn som Android-appen (och Expo-appens scopeOf)', () => {
  // Bara bokstäver och siffror ur adressen, högst 60 tecken, sedan "-" och profilens id
  assert.match(core, /\$0\.isASCII && \(\$0\.isLetter \|\| \$0\.isNumber\)\ }\.prefix\(60\)/);
  assert.match(dlcore, /replace\(Regex\("\[\^A-Za-z0-9\]"\), ""\)\.take\(60\)/);
  assert.match(core, /clean\(server\) \+ "-" \+ String\(uid\)/);
  assert.match(dlcore, /clean\(server\) \+ "-" \+ uid/);
  assert.match(ts, /scopeOf = \(serverId: string, uid: number\) => `\$\{cleanId\(serverId\)\}-/);
  assert.match(core, /!c\.isEmpty && scope\.hasPrefix\(c \+ "-"\)/, 'ofServer: en tom adress äger inget');
  // Märkningen av bakgrundsuppgiften: de gamla ("id") och de nya ("id profil")
  assert.match(core, /scope\.isEmpty \? String\(id\) : "\\\(id\) \\\(scope\)"/);
});

test('flytten från före profilerna: samma beslut som Android-appens DownloadMigration', () => {
  const f = fn(core, 'fate');
  // Profilen från uppdateringen är känd: dit. Samma inloggning men okänd profil: visas som förut. Ny inloggning: huvudkontot.
  assert.match(f, /if !cur\.fp\.isEmpty, let uid = uidOf\(cur\.fp\) \{ return \(cur, \.assign\(uid\)\) \}/);
  assert.match(f, /if !cur\.fp\.isEmpty, fp == cur\.fp, DownloadScope\.sameServer\(server, cur\.server\) \{ return \(cur, \.showHere\) \}/);
  assert.match(f, /if fp != cur\.fp \{ cur\.ownerOnly = true \} else \{ return \(cur, \.hidden\) \}/);
  assert.match(f, /if let o = ownerUid, DownloadScope\.sameServer\(server, cur\.server\) \{ return \(cur, \.assign\(o\)\) \}/);
  assert.match(dlcore, /if \(fp != cur\.fp\) cur = cur\.copy\(ownerOnly = true\)/);
  assert.match(dlcore, /if \(ownerUid != null && DownloadScope\.sameServer\(server, cur\.server\)\) cur to LegacyFate\.Assign\(ownerUid\)/);
  // En titel som profilen redan har behålls; de gamla läggs till efter
  assert.match(fn(core, 'merge'), /for r in legacy where !have\.contains\(r\.id\)/);
  // Offline.swift: gamla filen tas bort när profilen redan har titeln, pågående byter profil, märket tas bort när allt flyttats
  const m = fn(off, 'migrate');
  assert.match(m, /for o in old where !move\.contains\(where: \{ \$0\.id == o\.id \}\) \{ try\? FileManager\.default\.removeItem/);
  assert.match(m, /for \(k, var p\) in pending where p\.owner\.isEmpty \{ p\.scope = target; pending\[k\] = p \}/);
  assert.match(m, /if failed\.isEmpty \{\s*saveList\("", \[\]\)\s*saveAutoIds\("", \[\]\)\s*saveLegacy\(nil\)/);
  // Märket sätts vid första starten med den gamla listan: den sparade adressen och inloggningen som gäller då
  assert.match(off, /saveLegacy\(LegacyDownloads\(server: UserDefaults\.standard\.string\(forKey: "server"\) \?\? "",\s*fp: Keychain\.read\("token"\)\.map\(LoginPrint\.of\) \?\? ""\)\)/);
});

test('appen visar bara den inloggade profilens nedladdningar (felet: en gemensam lista för alla profiler)', () => {
  const o = off.slice(off.indexOf('func open(server: String'), off.indexOf('private func reload'));
  assert.match(o, /let sc = LoginPrint\.scope\(server: server, token: token\)/);
  assert.match(o, /let own = sc\.map \{ loadList\(\$0\) \} \?\? \[\]/, 'utloggad eller okänd profil: inget');
  assert.match(o, /let old = showLegacy \? loadList\(""\)/, 'de gamla bara när flytten säger showHere');
  assert.match(o, /records = own \+ old/);
  // Filen spelas ur profilens mapp (eller den gamla mappen för de gamla som visas)
  const l = fn(off, 'localURL');
  assert.match(l, /if legacyIds\.contains\(id\) \{ folder = dir \} else if let sc = scope \{ folder = downloadFolder\(sc\) \} else \{ return nil \}/);
  // Profilen sparas per inloggning (fingeravtryck), så att rätt lista visas även när servern inte svarar
  assert.match(off, /SHA256\.hash\(data: Data\(token\.utf8\)\)\.prefix\(8\)/);
  assert.match(model, /@Published var user: UserInfo\? \{ didSet \{ OfflineProfile\.changed\(self\) \} \}/);
  assert.match(fn(off, 'changed'), /if let t = model\.token, let u = model\.user \{ LoginPrint\.remember\(token: t, uid: u\.id\) \}/);
  // token sätts före user överallt, så att fingeravtrycket alltid knyts till rätt profil
  for (const [name, src] of [['login', model], ['pollQuickConnect', model], ['switchProfile', model]]) {
    const f = fn(src, name);
    assert.ok(f.indexOf('token = ') >= 0 && f.indexOf('token = ') < f.indexOf('user = '), `${name}: token före user`);
  }
  const lo = fn(model, 'logout');
  assert.ok(lo.indexOf('token = nil') < lo.indexOf('user = nil'), 'logout: token före user');
  assert.match(app, /\.onAppear \{ OfflineProfile\.changed\(model\) \}/);
});

test('nedladdningen hamnar hos profilen som startade den, även om en annan är inloggad när den blir klar', () => {
  const d = fn(off, 'download');
  assert.match(d, /guard let sc = scope else/);
  assert.match(d, /let tag = DownloadTag\.make\(id: item\.id, scope: sc\)/);
  assert.match(d, /task\.taskDescription = tag/);
  assert.match(fn(off, 'retry'), /task\.taskDescription = tag/);
  // Delegaten flyttar filen till märkningens mapp, finished() lägger den i den profilens lista
  assert.match(off, /let dest = downloadFolder\(t\.scope, create: true\)\.appendingPathComponent\("\\\(t\.id\)\.mp4"\)/);
  const f = fn(off, 'finished');
  assert.match(f, /guard let p = pending\[tag\], !\(p\.owner\.isEmpty && legacy\(\) == nil\) else \{\s*try\? FileManager\.default\.removeItem\(at: from\)/, 'ingen väntar: filen tas bort');
  assert.match(f, /saveList\(sc, loadList\(sc\)/);
  // Förlopp och avbrutna visas bara för den profil som äger dem
  assert.match(fn(off, 'publish'), /for \(t, v\) in progressByTag where visible\(t\)/);
  assert.match(fn(off, 'publish'), /for t in resumeData\.keys where visible\(t\)/);
  // Automatisk synk per profil
  assert.match(off, /sc\.isEmpty \? "autoSyncIds" : "autoSyncIds\." \+ sc/);
  assert.match(fn(off, 'autoSync'), /scope == sc else \{ return \}/);
});

test('Logga ut: köade positioner skickas, serverns nedladdningar tas bort (efter fråga), sedan utloggning', () => {
  const s = fn(off, 'signOut');
  const a = s.indexOf('flushNow()'), b = s.indexOf('removeServer(model.server)'), c = s.indexOf('model.logout()');
  assert.ok(a > 0 && a < b && b < c, 'ordningen: skicka kön, ta bort, logga ut');
  assert.match(views, /if OfflineProfile\.hasDownloads\(model\) \{ askLogout = true \} else \{ Task \{ await OfflineProfile\.signOut\(model\) \} \}/);
  assert.match(views, /Button\("Logga ut och ta bort", role: \.destructive\) \{ Task \{ await OfflineProfile\.signOut\(model\) \} \}/);
  assert.ok(!/Button\("Logga ut", role: \.destructive\) \{ model\.logout\(\) \}/.test(views), 'knappen loggar inte ut direkt');
  // Alla serverns profiler och de gamla från samma server; bakgrundsuppgifterna avbryts
  const r = fn(off, 'removeServer');
  assert.match(r, /DownloadScope\.ofServer\(d\.lastPathComponent, server: server\) \{ try\? fm\.removeItem\(at: d\) \}/);
  assert.match(r, /task\.cancel\(\)/);
  assert.match(r, /UserDefaults\.standard\.removeObject\(forKey: ownerKey\(server\)\)/);
  // 401 från servern (AppModel.request → logout()) tar inte bort något: logout() rör inte nedladdningarna
  assert.ok(!/Downloads|removeServer/.test(fn(model, 'logout')));
});

test('positioner utan nät: samma kö som Android-appen och skickas med at', () => {
  assert.match(core, /static let max = 200/); assert.match(ktcore, /const val MAX = 200/);
  assert.match(core, /static let maxAge: Int64 = 60 \* 86400/); assert.match(ktcore, /const val MAX_AGE_S = 60L \* 86400/);
  assert.match(core, /\(200\.\.<300\)\.contains\(status\) \|\| status == 403 \|\| status == 404/);
  assert.match(ktcore, /status in 200\.\.299 \|\| status == 403 \|\| status == 404/);
  assert.match(core, /status != 0 && status != 401 && status != 429 && status < 500/);
  assert.match(ktcore, /status != 0 && status != 401 && status != 429 && status < 500/);
  assert.match(fn(core, 'record'), /old\.at > p\.at \{ return prune/, 'en äldre position ersätter inte en nyare');
  assert.match(fn(core, 'body'), /\["position": p\.position, "at": p\.at\]/);
  assert.match(core, /"\/api\/items\/\\\(id\)\/progress"/);
  assert.match(core, /"\/api\/audiobooks\/book\/\\\(id\)\/progress"/);
  assert.match(core, /"\/api\/podcasts\/episodes\/\\\(id\)\/progress"/);
  // Filmer/avsnitt (spelaren) och ljudböcker/poddar (Listen.swift) går genom kön
  assert.match(fn(model, 'reportProgress'), /PendingPositions\.shared\.post\(self, kind: ProgressQueue\.item/);
  assert.match(fn(listen, 'save'), /PendingPositions\.shared\.post\(model, kind: kind/);
  assert.ok(!/try\? await model\.post\(path, body\)/.test(listen));
  // Kom det inte fram sparas positionen med tiden när anropet startade; kön skickas när nätet kommer tillbaka
  const p = fn(off, 'post');
  assert.match(p, /let started = Date\(\)/);
  assert.match(p, /if !ProgressQueue\.finished\(status\), let sc \{/);
  assert.match(p, /now: started\)\)/);
  assert.match(off, /pathMonitor\.pathUpdateHandler = \{ path in\s*guard path\.status == \.satisfied/);
  const f = fn(off, 'flushNow');
  assert.match(f, /guard scope == sc else \{ return \}/);
  assert.match(f, /ProgressQueue\.body\(p\)/);
  assert.match(f, /if !ProgressQueue\.keepGoing\(status\) \{ return \}/);
  assert.match(app, /PendingPositions\.shared\.flush\(\)/, 'vid förgrunden');
});

test('servern tar emot at för filmer och ljudböcker (poddar: inte än)', () => {
  const lib = read('server', 'routes', 'library.js'), books = read('server', 'routes', 'books.js');
  assert.match(lib, /route\('POST', '\/api\/items\/:id\/progress'[\s\S]{0,200}at: atRaw/);
  assert.match(books, /route\('POST', '\/api\/audiobooks\/book\/:bid\/progress'[\s\S]{0,120}\{ position, speed, at \}/);
});

test('när servern svarar: utan rätten att ladda ner tas allt bort, och titler som profilen inte får se (403/404)', () => {
  assert.match(core, /case 403, 404: return \.remove/); assert.match(dlcore, /403, 404 -> Verdict\.REMOVE/);
  assert.match(core, /case 0, 401, 429: return \.stop/); assert.match(dlcore, /0, 401, 429 -> Verdict\.STOP/);
  assert.match(core, /static let every: TimeInterval = 6 \* 3600/); assert.match(dlcore, /EVERY_MS = 6 \* 3600_000L/);
  assert.match(core, /!canDownload && count > 0/); assert.match(dlcore, /!canDownload && count > 0/);
  const o = fn(off, 'online');
  assert.match(o, /DownloadAccess\.removeAll\(canDownload: user\.canDownload \?\? true, count: records\.count\)/);
  assert.match(o, /try await model\.get\("\/api\/items\/\\\(r\.id\)"\)/);
  assert.match(o, /case \.stop: checked\[sc\] = nil; break check/);
  assert.match(o, /case \.remove: if scope == sc \{ removeFrom\(sc, r\.id\) \}/);
  assert.match(fn(off, 'changed'), /if model\.user != nil \{ Task \{ await Downloads\.shared\.online\(model: model\) \} \}/);
});

// Skärmtid utan nät (felet: iOS-appen räknade ingen skärmtid när den spelade nedladdningar utan nät, så en barnprofil
// kunde titta utan gräns i flygplansläge). Samma regler som Android-appens ScreenClock och Expo-appens screenGate.
test('skärmtiden utan nät: samma regler som Android- och Expo-appen (ScreenClock i OfflineCore.swift)', () => {
  // Högst 45 s per gång (som serverns glapp)
  assert.match(core, /static let cap: Double = 45\b/); assert.match(ktcore, /const val CAP = 45\.0/); assert.match(ts, /OFF_GAP = 45\b/);
  const add = fn(core, 'addOffline');
  assert.match(add, /guard var c, c\.status\.limited, seconds > 0 else \{ return c \}/);
  assert.match(add, /let prev = c\.offDay == day \? c\.offSeconds : 0/, 'en ny dag börjar om');
  assert.match(add, /c\.offSeconds = prev \+ min\(cap, seconds\)/);
  // Android (och Expo) sparar sedan 2026-11-28 en post per uppspelning i stället för en summa per dag – reglerna
  // för posterna provas i OfflineCoreTest.kt och test/expo-offline.test.js
  // Ny status från servern ersätter det som räknats i appen; saknas status = ingen skärmtid
  assert.match(core, /ScreenCache\(status: status \?\? ScreenStatus\(limited: false\)\)/);
  const g = fn(core, 'gate');
  assert.match(g, /if !s\.limited \|\| \(audio && !s\.audio\) \{ return ok \}/);
  // Samma dag: statusens tid kvar; ny dag: den dagliga gränsen utan extra tid
  assert.match(g, /same \? s\.remaining\.map \{ \$0 - off \} : s\.daily\.map \{ Double\(\$0\) \* 60 - off \}/);
  assert.match(ktcore, /if \(same\) s\.remaining\?\.let \{ it - off \} else s\.daily\?\.let \{ it \* 60\.0 - off \}/);
  assert.match(g, /if let u = until, !same \{ until = max\(0, u - s\.extra\) \}/);
  assert.match(ktcore, /if \(until != null && !same\) until = max\(0, until - s\.extra\)/);
  // Klockslagen, även över midnatt (20:00–02:00), och tiden till sluttiden i riktig tid
  assert.match(g, /inWindow = nowMin >= Double\(f\) && nowMin < Double\(e\)/);
  assert.match(g, /inWindow = nowMin >= Double\(f\) \|\| nowMin < Double\(e\)/);
  assert.match(g, /secondsTo\(now, days: nowMin >= Double\(f\) \? 1 : 0, minutes: e, cal\)/);
  assert.match(fn(core, 'secondsTo'), /end\.timeIntervalSince\(now\)/);
  // Beskedet: minuter tittade av dagens minuter, eller klockslagen; söndag = 0 som servern
  assert.match(g, /let used = \(same \? s\.used : 0\) \+ off/);
  assert.match(g, /let total = \(s\.daily \?\? 0\) \+ \(same \? s\.extra : 0\)/);
  assert.match(g, /\(cal\.component\(\.weekday, from: now\) \+ 6\) % 7/);
  assert.match(g, /if let r, let w = windowLeft \{ left = min\(r, w\) \} else \{ left = r \?\? windowLeft \}/);
  // Dagen och klockan i en gregoriansk kalender i enhetens tidszon (serverns localDay är yyyy-MM-dd)
  assert.match(core, /Calendar\(identifier: \.gregorian\)/);
  assert.match(core, /String\(format: "%04d-%02d-%02d"/);
  // Statusen avkodas även när fält saknas ({ limited: false }) eller är decimaltal
  assert.match(core, /limited = \(try\? c\.decodeIfPresent\(Bool\.self, forKey: \.limited\)\) \?\? false/);
});

test('nedladdningsspelaren räknar skärmtiden utan nät och stoppar med serverns besked', () => {
  const player = code(read(...SH, 'Player.swift'));
  // Före start: den sparade statusen och tiden som räknats; säger den nej frågas servern först
  const st = player.slice(player.indexOf('if let local = Downloads.shared.localURL(for: itemId)'));
  const gate = st.indexOf('var gate = OfflineScreen.gateNow(model)'), play = st.indexOf('player.replaceCurrentItem(with: AVPlayerItem(url: local))');
  assert.ok(gate > 0 && gate < play, 'skärmtiden prövas innan filen spelas');
  assert.match(st, /if !gate\.allowed, await OfflineScreen\.refresh\(model\) \{ gate = OfflineScreen\.gateNow\(model\) \}/);
  assert.match(st, /if !gate\.allowed \{ stopNotice = OfflineScreen\.message\(gate\); return \}/);
  // Under uppspelningen: tiden räknas medan bilden rör sig; kommer framsteget inte fram räknas den som skärmtid
  assert.match(fn(player, 'tick'), /if isLocal \{ countLocal\(\) \}/);
  assert.match(fn(player, 'countLocal'), /player\.timeControlStatus == \.playing, let b = localBeat \{ localPlayed \+= min\(1, max\(0, now - b\)\) \}/);
  assert.match(fn(player, 'tick'), /let secs = takeLocalPlayed\(\)[\s\S]*self\?\.playedOffline\(secs, play: play, id: id, gen: gen\)[\s\S]*noAnswer: noAnswer\)/);
  assert.match(fn(player, 'stopReporting'), /OfflineScreen\.played\(model, seconds: secs, play: play\)/, 'den sista biten räknas också');
  const po = fn(player, 'playedOffline');
  assert.match(po, /let g = OfflineScreen\.played\(model, seconds: secs, play: play\)/);
  assert.match(po, /guard !g\.allowed, !closed, gen == generation, currentId == id, isLocal, stopNotice == nil else \{ return \}/);
  assert.match(po, /player\.pause\(\)\s*stopReporting\(\)\s*stopNotice = OfflineScreen\.message\(g\)/);
  // noAnswer = servern svarade inte alls (status 0); ett svar som 403 räknas inte som tid utan nät
  assert.match(fn(off, 'post'), /if status == 0 \{ noAnswer\?\(\) \}/);
  assert.match(fn(model, 'reportProgress'), /duration: duration, noAnswer: noAnswer\)/);
});

test('skärmtidens status sparas per server och profil när servern svarar (som Android och Expo)', () => {
  // Svaret på framstegen (filmer och avsnitt) och GET /api/screentime när profilen blir känd
  assert.match(fn(model, 'reportProgress'), /if let ps = try\? JSONDecoder\(\)\.decode\(ProgressScreen\.self, from: data\) \{ OfflineScreen\.note\(self, ps\.screenTime\) \}/);
  assert.match(fn(off, 'changed'), /if model\.user != nil \{ Task \{ await OfflineScreen\.refresh\(model\) \} \}/);
  const r = fn(off, 'refresh');
  assert.match(r, /try\? await model\.get\("\/api\/screentime"\)/);
  assert.match(r, /guard key\(model\) == k else \{ return false \}/, 'profilbyte under tiden: statusen hör till den förra');
  assert.match(fn(off, 'key'), /LoginPrint\.scope\(server: model\.server, token: model\.token\)\.map \{ "screen\." \+ \$0 \}/);
  assert.match(fn(off, 'note'), /save\(k, ScreenClock\.fresh\(status\)\)/);
  assert.match(fn(off, 'played'), /ScreenClock\.addOffline\(load\(k\), now: now, seconds: seconds\)[\s\S]*ScreenClock\.gate\(c, now: now\)/);
  // Android och Expo gör samma sak: status från svaret och från GET /api/screentime
  assert.match(read(...KT, 'PlayerScreen.kt'), /OfflineSync\.noteScreen\(r\.screenTime\)/);
  assert.match(read('apps', 'expo', 'src', 'offline.ts'), /api<ScreenStatus>\('\/api\/screentime'/);
});

test('beskedet när tiden är slut är serverns (messageOf i server/screentime.js), på svenska och engelska', () => {
  const srvSt = read('server', 'screentime.js');
  const msg = fn(off, 'message');
  const pairs = [
    ['Tiden är slut för idag – du har tittat %d av %d minuter. Fråga en vuxen om du behöver mer tid.', 'Tiden är slut för idag – du har tittat {used} av {total} minuter. Fråga en vuxen om du behöver mer tid.'],
    ['Det går inte att titta just nu. På %@ går det att titta %@.', 'Det går inte att titta just nu. På {days} går det att titta {win}.'],
    ['mellan %@ och %@', 'mellan {from} och {until}'], ['från %@', 'från {from}'], ['fram till %@', 'fram till {until}'],
  ];
  for (const [sw, js] of pairs) { assert.ok(msg.includes(`L("${sw}")`), `Swift: ${sw}`); assert.ok(srvSt.includes(`'${js}'`), `servern: ${js}`); }
  assert.match(srvSt, /DAYS_PL = \['söndagar', 'måndagar', 'tisdagar', 'onsdagar', 'torsdagar', 'fredagar', 'lördagar'\]/);
  assert.match(msg, /\[L\("söndagar"\), L\("måndagar"\), L\("tisdagar"\), L\("onsdagar"\), L\("torsdagar"\), L\("fredagar"\), L\("lördagar"\)\]/);
});

// Skärmtid utan nät lämnas in i efterhand (felet: tiden som räknades i appen försvann när nätet kom tillbaka – serverns
// status ersatte appens räkning, och servern hade aldrig fått tiden). POST /api/screentime/offline, docs/api.md.
const log = core.slice(core.indexOf('enum ScreenLog'));
const pst = off.slice(off.indexOf('final class PendingScreenTime'));
test('tiden utan nät sparas som en post per uppspelning { id, at, seconds, audio } som får växa (ScreenLog)', () => {
  assert.match(core, /struct ScreenEntry: Codable, Equatable \{\s*let id: String\s*let play: String\s*let at: Int64\s*var seconds: Double\s*let audio: Bool/);
  const r = fn(log, 'record');
  // Högst 45 s per gång (som ScreenClock); samma uppspelning fortsätter på sin post om den hänger ihop med nu
  assert.match(r, /let s = min\(ScreenClock\.cap, seconds\)/);
  assert.match(r, /if let i = out\.lastIndex\(where: \{ \$0\.play == play \}\)/);
  assert.match(r, /if end <= t \+ 1, t - end <= maxGap, e\.seconds \+ s <= maxEntry \{\s*out\[i\]\.seconds = e\.seconds \+ s/);
  // Annars en ny post som slutar nu, med ett id som aldrig återanvänds (servern räknar inte samma id med annan tid)
  assert.match(r, /let at = Int64\(\(t - s\)\.rounded\(\.down\)\)/);
  assert.match(core, /static func id\(play: String, at: Int64\) -> String \{ play \+ "-" \+ String\(at\) \}/);
  assert.match(r, /guard !out\.contains\(where: \{ \$0\.id == id\(play: play, at: at\) \}\)/);
  // En ny post minst varje timme (servern tar högst 4 h per post), högst 200 per anrop, inte äldre än 60 dygn
  assert.match(log, /static let maxEntry: Double = 3600\b/);
  assert.match(core, /static let batch = 200\b/);
  const srv = read('server', 'screentime.js');
  assert.match(srv, /export const OFFLINE_ENTRY = 4 \* 3600;/); assert.match(srv, /export const OFFLINE_MAX = 200;/);
  assert.match(srv, /const OFFLINE_DAYS = 60;/); assert.match(core, /static let maxAge: Int64 = 60 \* 86400/);
  // Kroppen: { device, entries: [{ id, at, seconds, audio }] }
  const b = fn(log, 'body');
  assert.match(b, /\["device": device,\s*"entries": sent\.map \{ \["id": \$0\.id, "at": \$0\.at, "seconds": [^,]+, "audio": \$0\.audio\]/);
});

test('svaret: det som done listar tas bort (inte en post som vuxit under tiden), och screenTime gäller sedan', () => {
  const a = fn(log, 'ack');
  assert.match(a, /let gone = sent\.filter \{ ok\.contains\(\$0\.id\) \}/);
  assert.match(a, /return list\.filter \{ !gone\.contains\(\$0\) \}/, 'jämförs med posten som den skickades');
  assert.match(core, /struct ScreenOfflineReply: Decodable \{[\s\S]*let done: \[String\][\s\S]*let screenTime: ScreenStatus\?/);
  const f = fn(pst, 'flushNow');
  assert.match(f, /model\.post\("\/api\/screentime\/offline", ScreenLog\.body\(device: device, sent\)\)/);
  assert.match(f, /guard scope\(model\) == sc else \{ return \}/, 'profilbyte under tiden: svaret hör till den förra');
  assert.match(f, /ScreenLog\.ack\(before, sent: sent, done: reply\.done\)/);
  assert.match(f, /OfflineScreen\.note\(model, reply\.screenTime\)/);
  assert.match(f, /if sent\.count < ScreenLog\.batch \|\| left\.count >= before\.count \{ return \}/, 'ingen oändlig slinga');
  // Inget svar eller serverfel: kön står kvar; 403/404 (servern har inte anropet) släpper posterna
  assert.match(core, /static func dropAll\(_ status: Int\) -> Bool \{ status == 403 \|\| status == 404 \}/);
});

test('kön för skärmtiden gäller server och profil och skickas på samma ställen som positionerna', () => {
  assert.match(fn(pst, 'scope'), /LoginPrint\.scope\(server: model\.server, token: model\.token\)/);
  assert.match(off, /UserDefaults\.standard\.data\(forKey: "screenlog\." \+ sc\)/);
  // Tiden som räknas utan nät (OfflineScreen.played) sparas också i kön, med uppspelningens id
  assert.match(fn(off, 'played'), /PendingScreenTime\.shared\.record\(model, play: play, seconds: seconds, audio: audio, now: now\)/);
  // PendingPositions.flush körs när nätet kommer tillbaka (NWPathMonitor), i förgrunden, när profilen blir känd och
  // efter ett lyckat framsteg – och skickar då skärmtiden också; utloggning skickar den först
  const pp = off.slice(off.indexOf('final class PendingPositions'), off.indexOf('// MARK: - Skärmtid utan nät'));
  assert.match(fn(pp, 'flush'), /if let m = model \{ PendingScreenTime\.shared\.flush\(m\) \}/);
  assert.match(fn(pp, 'attach'), /pathMonitor\.pathUpdateHandler[\s\S]*PendingPositions\.shared\.flush\(\)/);
  assert.match(app, /willEnterForegroundNotification\)\) \{ _ in\s*PendingPositions\.shared\.flush\(\)/);
  assert.match(fn(off, 'signOut'), /await PendingScreenTime\.shared\.flushNow\(model\)\s*#if os\(iOS\)\s*Downloads\.shared\.removeServer/);
  // Spelaren: en ny uppspelning (nedladdad fil) får ett eget id, som följer med tiden till OfflineScreen.played
  const player = code(read(...SH, 'Player.swift'));
  assert.match(player, /isLocal = true\s*localPlay = UUID\(\)\.uuidString/);
  assert.match(fn(player, 'tick'), /let play = localPlay[\s\S]*self\?\.playedOffline\(secs, play: play, id: id, gen: gen\)/);
  assert.match(fn(player, 'stopReporting'), /let play = localPlay[\s\S]*OfflineScreen\.played\(model, seconds: secs, play: play\)/);
  assert.match(fn(player, 'playedOffline'), /OfflineScreen\.played\(model, seconds: secs, play: play\)/);
});
