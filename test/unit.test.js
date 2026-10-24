// Enhetstester – kör: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-unit-'));
process.env.TRANSCODE_DIR = path.join(process.env.CONFIG_DIR, 'tc');
const auth = await import('../server/auth.js');
const util = await import('../server/util.js');
const scanner = await import('../server/scanner.js');

test('TOTP enligt RFC 6238 (SHA1-testvektor, 6 siffror)', () => {
  const secret = auth.base32(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(auth.hotp(secret, 1), '287082');            // T=59 s
  assert.equal(auth.hotp(secret, 37037036), '081804');     // T=1111111109
  assert.equal(auth.hotp(secret, 41152263), '005924');     // T=1234567890
});

test('base32 fram och tillbaka', () => {
  const b = Buffer.from([0, 1, 2, 250, 255, 128, 7]);
  assert.deepEqual(auth.unbase32(auth.base32(b)), b);
});

test('TOTP-koder kan inte återanvändas', () => {
  const s = auth.newTotpSecret();
  const code = auth.hotp(s, Math.floor(Date.now() / 30000));
  const step = auth.verifyTotp(s, code, 0);
  assert.ok(step > 0);
  assert.equal(auth.verifyTotp(s, code, step), -1);
  assert.equal(auth.verifyTotp(s, '12345', 0), -1);
});

test('lösenordskrav', () => {
  assert.ok(auth.weakPassword('kort'));
  assert.ok(auth.weakPassword('password1'));
  assert.ok(auth.weakPassword('Anton-hemligt-1', 'anton'));
  assert.ok(auth.weakPassword('abcdefghij'));                 // bara gemener, <14
  assert.equal(auth.weakPassword('Sommarstuga-2026!'), null);
  assert.equal(auth.weakPassword('en lång lösenfras utan siffror'), null);
});

test('lösenordshash (scrypt) och äldre format', async () => {
  const h = await auth.hashPw('Rätt-Lösen-123');
  assert.match(h, /^s2:/);
  assert.equal(await auth.checkPw('Rätt-Lösen-123', h), true);
  assert.equal(await auth.checkPw('fel', h), false);
});

test('CIDR-matchning', () => {
  assert.equal(util.inCidr('100.70.1.2', '100.64.0.0/10'), true);
  assert.equal(util.inCidr('100.128.0.1', '100.64.0.0/10'), false);
  assert.equal(util.inCidr('192.168.1.9', '192.168.1.0/24'), true);
  assert.equal(util.inCidr('10.1.2.3', '0.0.0.0/0'), true);
  assert.equal(util.inCidr('not-an-ip', '10.0.0.0/8'), false);
});

test('klient-IP: X-Forwarded-For läses från höger och kan inte förfalskas', () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  // Direkt från internet: headern ignoreras
  assert.equal(util.clientIp(req('81.2.3.4', '192.168.1.5')), '81.2.3.4');
  // Via lokal proxy: proxyn lägger till klientens adress sist
  assert.equal(util.clientIp(req('172.17.0.2', '81.2.3.4')), '81.2.3.4');
  // Angriparen skickar egen header som proxyn bygger på – vänsterdelen ignoreras
  assert.equal(util.clientIp(req('172.17.0.2', '192.168.1.20, 81.2.3.4')), '81.2.3.4');
  // Lokal klient via proxy
  assert.equal(util.clientIp(req('172.17.0.2', '192.168.1.50')), '192.168.1.50');
  // Skräp i headern
  assert.equal(util.clientIp(req('172.17.0.2', 'skräp')), '172.17.0.2');
});

test('loggtext rensas från kontrolltecken', () => {
  assert.equal(util.clean('a\nb\rc\u0000d'), 'a b c d');
});

test('tolkning av filmnamn', () => {
  assert.deepEqual(scanner.parseMovie('/m/Inception (2010)/Inception (2010).mkv'), { title: 'Inception', year: 2010 });
  assert.deepEqual(scanner.parseMovie('/m/Arrival.2016.1080p.BluRay.x264.mkv'), { title: 'Arrival', year: 2016 });
  assert.deepEqual(scanner.parseMovie('/m/Blade Runner 2049 (2017)/movie.mkv'), { title: 'Blade Runner 2049', year: 2017 });
  assert.equal(scanner.parseMovie('/m/Utan år 1080p.mkv').title, 'Utan år');
});

test('tolkning av avsnittsnamn', () => {
  const sep = path.sep;
  let e = scanner.parseEpisode(['Bron (2011)', 'Season 1', 'Bron - S01E02 - Titel.mkv'].join(sep));
  assert.equal(e.show, 'Bron'); assert.equal(e.year, 2011); assert.equal(e.season, 1); assert.equal(e.episode, 2); assert.equal(e.epTitle, 'Titel');
  e = scanner.parseEpisode(['The Office', 'The.Office.S03E10.720p.mkv'].join(sep));
  assert.equal(e.show, 'The Office'); assert.equal(e.season, 3); assert.equal(e.episode, 10);
  e = scanner.parseEpisode(['Serie', 'Säsong 2', 'Avsnitt 5.mkv'].join(sep));
  assert.equal(e.season, 2); assert.equal(e.episode, 5);
  e = scanner.parseEpisode(['Show', '2x07.mkv'].join(sep));
  assert.equal(e.season, 2); assert.equal(e.episode, 7);
});

test('lösa avsnittsnamn: skivor, volymer och onumrerade', () => {
  const sep = path.sep;
  let e = scanner.parseEpisode(['Byggare Bob', 'Byggare Bob 026 - Jul hos Byggare Bob.avi'].join(sep));
  assert.equal(e.show, 'Byggare Bob'); assert.equal(e.episode, 26); assert.equal(e.epTitle, 'Jul hos Byggare Bob');
  e = scanner.parseEpisode(['Julkalendrar', 'jul.i.kapernaum.1995.disc1.mp4'].join(sep));
  assert.equal(e.show, 'jul i kapernaum'); assert.equal(e.year, 1995); assert.equal(e.episode, 1);
  e = scanner.parseEpisode(['Tures', 'Turesdvd2.mp4'].join(sep));
  assert.equal(e.show, 'Tures'); assert.equal(e.episode, 2);
  e = scanner.parseEpisode(['Chuggington - Collection', 'Chuggington - Hjälpsamma Hodge.avi'].join(sep));
  assert.equal(e.show, 'Chuggington'); assert.equal(e.episode, null); assert.equal(e.epTitle, 'Hjälpsamma Hodge');
  assert.equal(scanner.parseEpisode('Liv i Luckan.mp4'), null);
});

test('anime: absolut numrering och mappning till säsonger', () => {
  const sep = path.sep;
  let e = scanner.parseEpisode('[SubsPlease] Jujutsu Kaisen - 25 (1080p) [A1B2C3D4].mkv');
  assert.equal(e.show, 'Jujutsu Kaisen'); assert.equal(e.episode, 25); assert.equal(e.season, 1); assert.equal(e.absolute, true);
  e = scanner.parseEpisode(['One Piece', 'One Piece - 1071v2.mkv'].join(sep));
  assert.equal(e.show, 'One Piece'); assert.equal(e.episode, 1071); assert.equal(e.absolute, true);
  e = scanner.parseEpisode(['Frieren', 'Season 2', 'Frieren - 05.mkv'].join(sep));
  assert.equal(e.season, 2); assert.equal(e.episode, 5); assert.equal(e.absolute, false);
  const seasons = [{ season_number: 0, episode_count: 5 }, { season_number: 1, episode_count: 24 }, { season_number: 2, episode_count: 23 }];
  assert.deepEqual(scanner.mapAbsolute(25, seasons), { season: 2, episode: 1 });
  assert.deepEqual(scanner.mapAbsolute(24, seasons), { season: 1, episode: 24 });
  assert.equal(scanner.mapAbsolute(99, seasons), null);
  assert.ok(scanner.langMatches('swe', 'sv') && scanner.langMatches('en', 'en') && !scanner.langMatches('eng', 'sv'));
});

test('integritet: inbäddade filer stämmer och manifestet är stabilt', async () => {
  const v = await import('../server/verify.js');
  assert.deepEqual(v.checkVendor(), []);
  const a = v.buildManifest(), b = v.buildManifest();
  assert.deepEqual(a, b);
  assert.ok(a['server/app.js'] && a['web/vendor/hls.min.js'] && a['package.json']);
});

test('CBOR: påhittade längder ger fel i stället för att fylla minnet', async () => {
  const { cborDecode } = await import('../server/passkeys.js');
  assert.deepEqual([...cborDecode(Buffer.from('a2616101616282020a', 'hex')).value], [['a', 1], ['b', [2, 10]]]);
  for (const hex of ['9bffffffffffffffff', '5a7fffffff', 'bbffffffffffffffff', '18', '82', '8'.repeat(200)]) {
    assert.throws(() => cborDecode(Buffer.from(hex, 'hex')), /CBOR/, hex);
  }
});

test('IPv6: gissningsskyddet räknar per /64 även för komprimerade adresser', () => {
  assert.equal(auth.ipKey('2001:db8::1'), auth.ipKey('2001:db8::abcd:2'));
  assert.equal(auth.ipKey('2001:0db8:0001:0002:3:4:5:6'), '2001:db8:1:2');
  assert.notEqual(auth.ipKey('2001:db8:0:1::1'), auth.ipKey('2001:db8:0:2::1'));
  assert.equal(auth.ipKey('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(auth.ipKey('10.0.0.1'), '10.0.0.1');
});

test('JSON-kropp som inte är ett objekt ger 400', async () => {
  const { Readable } = await import('node:stream');
  for (const body of ['null', '5', '"x"']) {
    await assert.rejects(util.readJson(Readable.from([Buffer.from(body)])), (e) => e.status === 400);
  }
  assert.deepEqual(await util.readJson(Readable.from([Buffer.from('{"a":1}')])), { a: 1 });
});

test('poddar: datum med tidszonsförkortning', async () => {
  const { parseDate } = await import('../server/podcasts.js');
  assert.equal(new Date(parseDate('Mon, 06 Oct 2025 10:00:00 CEST')).toISOString(), '2025-10-06T08:00:00.000Z');
  assert.equal(new Date(parseDate('Mon, 06 Oct 2025 10:00:00 GMT')).toISOString(), '2025-10-06T10:00:00.000Z');
  assert.ok(isNaN(parseDate('')));
});

test('webbklienten: service workern cachar alla moduler i web/js/ och alla importer finns', () => {
  const web = path.join(import.meta.dirname, '..', 'web');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(path.join(web, 'js')).filter(f => f.endsWith('.js')).map(f => '/' + path.relative(web, f).split(path.sep).join('/'));
  const sw = fs.readFileSync(path.join(web, 'sw.js'), 'utf8');
  const listed = [...sw.match(/const MODULES = \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map(m => '/js/' + m[1]);
  assert.deepEqual(listed.sort(), files.sort());
  for (const f of ['/app.js', ...files]) {
    const src = fs.readFileSync(path.join(web, f), 'utf8');
    for (const m of src.matchAll(/^import (?:[^'"]* from )?'([^']+)';$/gm)) {
      assert.ok(fs.existsSync(path.join(web, path.dirname(f), m[1])), `${f} importerar ${m[1]}`);
    }
  }
});

test('webbklienten: style.css har lika många { som } (ett ostängt @media-block slukar resten av filen)', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0, line = 1;
  for (const ch of css) {
    if (ch === '\n') line++;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; assert.ok(depth >= 0, `för många } på rad ${line}`); }
  }
  assert.equal(depth, 0, 'ostängt block i style.css');
});

test('startsidan: nya avsnitt grupperas per serie och säsong (nyast först)', async () => {
  const { groupNewEpisodes } = await import('../server/http/context.js');
  const ep = (id, show, season, episode, watched = false) => ({ id, kind: 'episode', show, showTitle: 'Serie ' + show, season, episode, title: `Avsnitt ${episode}`, watched, position: 0, added: 100 - id });
  const g = groupNewEpisodes([ep(1, 10, 3, 8), ep(2, 20, 1, 2), ep(3, 10, 3, 7, true), ep(4, 10, 2, 5), ep(5, 10, 3, 6)]);
  assert.deepEqual(g.map(x => `${x.show}:${x.season}`), ['10:3', '20:1', '10:2']);
  assert.equal(g[0].count, 3);
  assert.equal(g[0].unwatched, 2);
  assert.deepEqual(g[0].latest, { id: 1, title: 'Avsnitt 8', season: 3, episode: 8 });
  assert.equal(g[0].next.id, 5);
  assert.equal(g[0].showTitle, 'Serie 10');
  assert.equal(groupNewEpisodes([ep(1, 10, 3, 8), ep(2, 20, 1, 2)], 1).length, 1);
});
