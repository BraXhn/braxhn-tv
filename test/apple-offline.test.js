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
