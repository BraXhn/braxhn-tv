// Diagnostikpaketet för supporten (server/supportpack.js + server/diagnostics.js, Administration → Hälsokontroll):
// maskeringen av token, lösenord, nycklar, kakor, e-post, IP-adresser och fil-/mappnamn, tar.gz-arkivet utan beroenden,
// miljövariablerna utan hemligheter och, mot en riktig server, att förhandsvisningen är exakt det som laddas ner och
// att inget hemligt från loggen följer med.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, PW } from './media/server.mjs';
import { freePort } from './helpers/port.js';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-diag-cfg-'));
const { maskSupport, safeEnv, tarGz, untarGz } = await import('../server/supportpack.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-diag-'));
const MEDIA = path.join(ROOT, 'media');
const PORT = await freePort();

// Hemligheter som aldrig får synas i paketet (används både i enhetstestet och mot servern)
const SECRETS = ['anna.svensson@example.com', 'kalle+tv@exempel.se', '203.0.113.77', '192.168.1.20', '10.0.5.9', '100.70.1.2', '2001:db8:85a3::8a2e:370:7334',
  'fe80::1ff:fe23:4567:890a', 'Hemligt123!', 'abc123secretvalue', 'S3cr3tTokenValue', 'deadbeefdeadbeefdeadbeef', 'eyJhbGciOiJIUzI1NiJ9', 'plexTokenXYZ',
  'cookieValue42', 'subsonicSalt9', 'subsonicHash7', 'MinLösenfras'];
const LOG = [
  'inloggning misslyckades för anna.svensson@example.com från 203.0.113.77 (via 192.168.1.20)',
  'notis till kalle+tv@exempel.se, klient 10.0.5.9 och VPN 100.70.1.2',
  'IPv6-klient 2001:db8:85a3::8a2e:370:7334 och fe80::1ff:fe23:4567:890a',
  'hämtar https://api.example.org/x?api_key=abc123secretvalue&t=S3cr3tTokenValue&page=2',
  'mediatoken deadbeefdeadbeefdeadbeef gick ut',
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  'X-Plex-Token: plexTokenXYZ',
  'cookie: kt=cookieValue42; bxlang=en',
  '/rest/ping.view?u=anna&t=subsonicHash7&s=subsonicSalt9&v=1.16.1&c=app',
  'lösenord=Hemligt123! och lösenfras: MinLösenfras',
  '[skanning] /media/Filmer/Hemliga Familjefilmen (2019)/Hemliga Familjefilmen (2019).mkv: kunde inte läsa',
  'klockan 12:34:56 och ffmpeg 7.1.1, lyssnar på 127.0.0.1:8420 och ::1'
].join('\n');

test('maskeringen tar bort token, lösenord, nycklar, kakor, e-post och IP-adresser', () => {
  const s = maskSupport(LOG, { roots: ['/media', '/media/Filmer'] });
  for (const bad of SECRETS) assert.ok(!s.includes(bad), `${bad} syns:\n${s}`);
  // Vilken sorts adress det var finns kvar (hemnät, VPN, publik), liksom det som behövs för felsökningen
  assert.match(s, /<ip>/); assert.match(s, /<lan-ip>/); assert.match(s, /<vpn-ip>/); assert.match(s, /<ipv6>/); assert.match(s, /\*\*\*@\*\*\*/);
  for (const ok of ['api.example.org', 'page=2', '12:34:56', 'ffmpeg 7.1.1', '127.0.0.1:8420', '::1', 'v=1.16.1', 'kunde inte läsa']) assert.ok(s.includes(ok), `${ok} saknas:\n${s}`);
  // Fil- och mappnamn under mediamapparna maskeras om användaren inte valt att ta med dem
  assert.ok(!s.includes('Hemliga Familjefilmen'), s);
  assert.match(s, /\/media\/Filmer\/…: kunde inte läsa/);
  const withNames = maskSupport(LOG, { names: true, roots: ['/media'] });
  assert.ok(withNames.includes('/media/Filmer/Hemliga Familjefilmen (2019)/Hemliga Familjefilmen (2019).mkv'));
  for (const bad of SECRETS) assert.ok(!withNames.includes(bad), `${bad} syns med filnamn:\n${withNames}`);
});

test('miljövariablerna: hemligheter och personliga adresser visas bara som "(satt)"', () => {
  const env = safeEnv({ HWACCEL: 'vaapi', TZ: 'Europe/Stockholm', TMDB_API_KEY: 'k123', BACKUP_PASSPHRASE: 'MinLösenfras', S3_SECRET_KEY: 'x', NOTIFY_TOKEN: 'y',
    PUBLIC_URL: 'https://tv.example.com', ACME_EMAIL: 'a@b.se', ACME_DOMAIN: 'tv.example.com', RADARR_URL: 'http://192.168.1.20:7878', METRICS_TOKEN: '',
    TRUSTED_NETWORKS: '10.8.0.0/24', PATH: '/usr/bin', HOME: '/root', lowercase: 'x' });
  assert.equal(env.HWACCEL, 'vaapi'); assert.equal(env.TZ, 'Europe/Stockholm');
  for (const k of ['TMDB_API_KEY', 'BACKUP_PASSPHRASE', 'S3_SECRET_KEY', 'NOTIFY_TOKEN', 'PUBLIC_URL', 'ACME_EMAIL', 'ACME_DOMAIN']) assert.equal(env[k], '(satt)', k);
  assert.equal(env.METRICS_TOKEN, '(tom)');
  assert.equal(env.RADARR_URL, 'http://<lan-ip>:7878');
  assert.equal(env.TRUSTED_NETWORKS, '<lan-ip>/24');
  assert.ok(!('PATH' in env) && !('HOME' in env) && !('lowercase' in env));
  assert.ok(!JSON.stringify(env).includes('tv.example.com'));
});

test('tar.gz utan beroenden: läses tillbaka och av systemets tar', () => {
  const files = [{ name: 'p/README.txt', text: 'hej\n' }, { name: 'p/log.txt', text: 'å'.repeat(700) }, { name: 'p/tom.json', text: '' }];
  const buf = tarGz(files, 1700000000);
  assert.deepEqual(untarGz(buf), files);
  assert.throws(() => tarGz([{ name: '../x', text: '' }]));
  const tar = spawnSync('tar', ['--version']);
  if (tar.status !== 0) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-diag-tar-'));
  fs.writeFileSync(path.join(dir, 'p.tar.gz'), buf);
  const r = spawnSync('tar', ['-xzf', 'p.tar.gz'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'p', 'log.txt'), 'utf8'), 'å'.repeat(700));
  assert.equal(fs.readFileSync(path.join(dir, 'p', 'README.txt'), 'utf8'), 'hej\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- mot en riktig server ----------
let srv;
before(async () => {
  fs.mkdirSync(path.join(MEDIA, 'Hemliga filmer'), { recursive: true });
  srv = await startServer({ root: ROOT, media: MEDIA, port: PORT, env: { TMDB_API_KEY: 'k-abc123secretvalue', WATCH_FILES: '0', BACKUP_PASSPHRASE: 'MinLösenfras', HWACCEL: 'none' } });
});
after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('servern: förhandsvisningen är exakt arkivet, och inget hemligt ur loggen följer med', { timeout: 120000 }, async () => {
  let r = await srv.req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await srv.req('/api/libraries', { method: 'POST', body: { name: 'Hemliga filmer', type: 'movie', path: path.join(MEDIA, 'Hemliga filmer') } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Loggrader med hemligheter, som om de kommit från webbappen eller servern själv
  for (const line of LOG.replaceAll('/media/', MEDIA + '/').split('\n')) assert.equal((await srv.req('/api/clientlog', { method: 'POST', body: { msg: line, where: 'test' } })).status, 200);
  const cookie = /kt=([^;]+)/.exec((await srv.req('/api/login', { method: 'POST', body: { name: 'admin', password: PW } })).headers.get('set-cookie'))[1];

  r = await srv.req('/api/admin/health/diagnostics', { method: 'POST', body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = r.data;
  assert.match(p.id, /^[0-9a-f]{24}$/);
  assert.match(p.filename, /^braxhn-diagnostik-\d{4}-\d{2}-\d{2}\.tar\.gz$/);
  const names = p.files.map(f => f.name);
  for (const f of ['README.txt', 'system.json', 'environment.json', 'hardware.json', 'database.json', 'libraries.json', 'settings.json', 'jobs.json', 'log.txt']) assert.ok(names.includes(f), f);
  const by = Object.fromEntries(p.files.map(f => [f.name, f.text]));
  const all = p.files.map(f => f.text).join('\n');
  for (const bad of [...SECRETS, PW, cookie, 'k-abc123secretvalue', 'Hemliga filmer', 'Hemliga Familjefilmen']) assert.ok(!all.includes(bad), `${bad} syns i paketet`);
  // Innehållet: version, databasens migreringsversion och storlek, bibliotekens antal utan namn, miljön utan hemligheter
  const sys = JSON.parse(by['system.json']), dbi = JSON.parse(by['database.json']), libs = JSON.parse(by['libraries.json']), env = JSON.parse(by['environment.json']);
  assert.equal(sys.braxhnTv, JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version);
  assert.ok(dbi.schemaVersion >= 8 && dbi.fileBytes.db > 0 && dbi.rows.users >= 1, by['database.json']);
  assert.equal(libs.length, 1); assert.equal(libs[0].type, 'movie'); assert.equal(libs[0].folderCount, 1); assert.equal(libs[0].foldersReadable, 1);
  assert.ok(!('name' in libs[0]) && !('folders' in libs[0]));
  assert.equal(env.TMDB_API_KEY, '(satt)'); assert.equal(env.BACKUP_PASSPHRASE, '(satt)'); assert.equal(env.HWACCEL, 'none');
  assert.equal(JSON.parse(by['hardware.json']).wanted, 'none');
  assert.match(by['log.txt'], /<lan-ip>/);
  assert.match(by['log.txt'], /\*\*\*@\*\*\*/);

  // Nedladdningen är exakt det som visades
  const dl = await srv.req(`/api/admin/health/diagnostics/${p.id}`, { raw: true });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/gzip');
  assert.match(dl.headers.get('content-disposition'), new RegExp(`attachment; filename="${p.filename.replace(/\./g, '\\.')}"`));
  const dir = p.filename.replace(/\.tar\.gz$/, '');
  assert.deepEqual(untarGz(dl.data), p.files.map(f => ({ name: `${dir}/${f.name}`, text: f.text })));
  assert.equal(dl.data.length, p.bytes);
  assert.equal((await srv.req('/api/admin/health/diagnostics/' + '0'.repeat(24))).status, 404);
  assert.equal((await srv.req('/api/admin/health/diagnostics/../../x')).status, 404);

  // Med fil- och mappnamn (valt av användaren): biblioteket och sökvägen syns, hemligheterna fortfarande inte
  r = await srv.req('/api/admin/health/diagnostics', { method: 'POST', body: { names: true } });
  const allN = r.data.files.map(f => f.text).join('\n');
  assert.ok(allN.includes('Hemliga filmer') && allN.includes('Hemliga Familjefilmen'), 'namnen saknas trots valet');
  for (const bad of [...SECRETS, PW, cookie]) assert.ok(!allN.includes(bad), `${bad} syns i paketet med namn`);

  // Bara administratör: utan inloggning nekas både förhandsvisning och nedladdning
  assert.equal((await srv.req('/api/admin/health/diagnostics', { method: 'POST', body: {}, auth: false })).status, 401);
  assert.equal((await srv.req(`/api/admin/health/diagnostics/${p.id}`, { auth: false })).status, 401);
});
