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
