// Distribution och utgåvor: Unraid-mallarna (Community Applications), Docker-imagen, startskriptets PUID/PGID/UMASK-
// beslut, nedgraderingsskyddet och säkerhetskopian före migrering, uppdateringsnotisen mot en låtsad GitHub och
// avstängning med SIGTERM. Går som vanlig användare (CONFIG_DIR i en tillfällig mapp). Kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { freePort } from './helpers/port.js';

const REPO = path.join(import.meta.dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-dist-'));
fs.chmodSync(ROOT, 0o755); // startskriptet provar skrivrätt som 99:100 när testet körs som root
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- låtsad GitHub (GET /repos/…/releases/latest) ----------
const gh = { hits: [], status: 200, rel: null };
const fake = http.createServer((q, r) => {
  gh.hits.push({ url: q.url, headers: q.headers });
  if (gh.status !== 200) { r.writeHead(gh.status, { 'content-type': 'application/json' }); return r.end('{"message":"Not Found"}'); }
  r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(gh.rel));
}).listen(0, '127.0.0.1');
await new Promise(r => fake.once('listening', r));
const GH_URL = `http://127.0.0.1:${fake.address().port}/repos/BraXhn/braxhn-tv/releases/latest`;
const release = (v, extra = {}) => ({ tag_name: 'v' + v, name: 'BraXhn TV ' + v, draft: false, prerelease: false,
  html_url: `https://github.com/BraXhn/braxhn-tv/releases/tag/v${v}`, body: `## ${v} – 2026-12-01\n- Något nytt i ${v}`, ...extra });
gh.rel = release('99.0.0');

// updates.js i samma process (NODE_ENV=test: inga egna tidsstyrda kontroller)
process.env.CONFIG_DIR = path.join(ROOT, 'unit', 'config');
process.env.NODE_ENV = 'test';
process.env.UPDATE_URL = GH_URL;
delete process.env.UPDATE_CHECK;
const D = await import('../server/db.js');
const U = await import('../server/updates.js');
const SERVER_PORT = await freePort();
after(() => { fake.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

// ---------- en liten, strikt XML-kontroll (välformad: balanserade taggar, citerade attribut, giltiga entiteter) ----------
function parseStrict(s) {
  const root = { name: '#doc', attrs: {}, children: [], text: '' }, stack = [root];
  let i = 0;
  if (s.startsWith('<?xml')) { i = s.indexOf('?>') + 2; assert.ok(i > 1, 'XML-deklarationen avslutas'); }
  const checkText = (t, where) => {
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(t), `ogiltig & i ${where}`);
    assert.ok(!t.includes('<'), `< i ${where}`);
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const text = lt < 0 ? s.slice(i) : s.slice(i, lt);
    if (text.trim()) { assert.ok(stack.length > 1, 'text utanför rotelementet'); checkText(text, stack.at(-1).name); stack.at(-1).text += text; }
    if (lt < 0) break;
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt); assert.ok(e > 0, 'kommentaren avslutas'); i = e + 3; continue; }
    const gt = s.indexOf('>', lt);
    assert.ok(gt > 0, 'taggen avslutas');
    const tag = s.slice(lt + 1, gt);
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim(), top = stack.pop();
      assert.equal(name, top.name, `</${name}> stänger <${top.name}>`);
    } else {
      const self = tag.endsWith('/'), body = self ? tag.slice(0, -1) : tag;
      const m = /^([A-Za-z_][\w.-]*)((?:\s+[\w.-]+="[^"]*")*)\s*$/.exec(body);
      assert.ok(m, `ogiltig tagg <${tag.slice(0, 60)}>`);
      const attrs = {};
      for (const a of m[2].matchAll(/([\w.-]+)="([^"]*)"/g)) {
        assert.ok(!(a[1] in attrs), `dubbelt attribut ${a[1]}`);
        checkText(a[2], `${m[1]}@${a[1]}`);
        attrs[a[1]] = a[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      }
      const el = { name: m[1], attrs, children: [], text: '' };
      if (stack.length === 1) assert.equal(root.children.length, 0, 'bara ett rotelement');
      stack.at(-1).children.push(el);
      if (!self) stack.push(el);
    }
    i = gt + 1;
  }
  assert.equal(stack.length, 1, `ostängt element <${stack.at(-1).name}>`);
  return root.children[0];
}
const child = (el, n) => el.children.find(c => c.name === n);
const textOf = (el, n) => { const c = child(el, n); return c ? c.text.replace(/&amp;/g, '&').trim() : undefined; };
function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} är en PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const TEMPLATES = ['braxhn-tv.xml', 'braxhn-tv-nvidia.xml'];
// Kategorier i Community Applications (ett urval – de som kan vara aktuella här)
const CA_CATEGORIES = new Set(['MediaServer:Video', 'MediaServer:Music', 'MediaServer:Books', 'MediaServer:Photos', 'MediaServer:Other',
  'MediaApp:Video', 'MediaApp:Music', 'MediaApp:Books', 'MediaApp:Photos', 'MediaApp:Other', 'Downloaders:', 'Tools:', 'Other:']);
// Miljövariabler som läses av något annat än servern (NVIDIA:s container-runtime, startskriptet)
const RUNTIME_VARS = new Set(['NVIDIA_VISIBLE_DEVICES', 'NVIDIA_DRIVER_CAPABILITIES']);
const serverSource = (() => {
  const out = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8')); } };
  walk(path.join(REPO, 'server'));
  return out.join('\n') + fs.readFileSync(path.join(REPO, 'docker', 'entrypoint.sh'), 'utf8');
})();
const tpl = Object.fromEntries(TEMPLATES.map(f => [f, parseStrict(fs.readFileSync(path.join(REPO, f), 'utf8'))]));
const configs = (el) => el.children.filter(c => c.name === 'Config');

for (const file of TEMPLATES) {
  test(`Unraid-mallen ${file} följer Community Applications schema`, () => {
    const c = tpl[file];
    assert.equal(c.name, 'Container'); assert.equal(c.attrs.version, '2');
    for (const n of ['Name', 'Repository', 'Registry', 'Network', 'Support', 'Project', 'Overview', 'Category', 'WebUI', 'TemplateURL', 'Icon', 'ExtraParams', 'Privileged']) {
      assert.ok(child(c, n), `<${n}> saknas`);
    }
    assert.equal(textOf(c, 'Repository'), 'ghcr.io/braxhn/braxhn-tv:latest');
    assert.match(textOf(c, 'Registry'), /^https:\/\/github\.com\/BraXhn\/braxhn-tv\/pkgs\/container\/braxhn-tv$/);
    for (const n of ['Support', 'Project']) assert.match(textOf(c, n), /^https:\/\//, n);
    assert.equal(textOf(c, 'Privileged'), 'false', 'ingen privilegierad container');
    assert.equal(textOf(c, 'Network'), 'bridge');
    // Overview: engelska (CA är engelskt) med en kort svensk rad, utan HTML (CA visar [br] som radbrytning)
    const ov = textOf(c, 'Overview');
    assert.ok(ov.length > 200 && ov.length < 2000, `Overview är ${ov.length} tecken`);
    assert.match(ov, /self-hosted media server/);
    assert.match(ov, /\[br\]Svenska: /);
    assert.ok(!/[<>]/.test(ov), 'ingen HTML i Overview');
    const cats = textOf(c, 'Category').split(/\s+/);
    for (const k of cats) assert.ok(CA_CATEGORIES.has(k), `okänd kategori ${k}`);
    for (const k of ['MediaServer:Video', 'MediaServer:Music']) assert.ok(cats.includes(k), k);
    assert.equal(textOf(c, 'TemplateURL'), `https://raw.githubusercontent.com/BraXhn/braxhn-tv/main/${file}`);
    // Ikonen ligger i repot (main) som en 512×512 PNG
    const icon = textOf(c, 'Icon'), pre = 'https://raw.githubusercontent.com/BraXhn/braxhn-tv/main/';
    assert.ok(icon.startsWith(pre), icon);
    assert.deepEqual(pngSize(path.join(REPO, icon.slice(pre.length))), [512, 512]);
    // Taggar att välja mellan i CA
    const tags = c.children.filter(x => x.name === 'Branch').map(b => textOf(b, 'Tag'));
    assert.deepEqual(tags, ['latest', 'beta', 'edge']);
    for (const b of c.children.filter(x => x.name === 'Branch')) assert.ok(textOf(b, 'TagDescription'), 'TagDescription');

    const cfg = configs(c), targets = cfg.map(x => x.attrs.Target);
    assert.equal(new Set(targets).size, targets.length, 'varje Target en gång');
    for (const x of cfg) {
      const a = x.attrs, where = `${file}: ${a.Name}`;
      for (const k of ['Name', 'Target', 'Default', 'Mode', 'Description', 'Type', 'Display', 'Required', 'Mask']) assert.ok(k in a, `${where}: ${k} saknas`);
      assert.ok(['Port', 'Path', 'Variable', 'Device', 'Label'].includes(a.Type), `${where}: Type ${a.Type}`);
      assert.ok(['always', 'advanced', 'always-hide', 'advanced-hide'].includes(a.Display), `${where}: Display ${a.Display}`);
      assert.ok(['true', 'false'].includes(a.Required) && ['true', 'false'].includes(a.Mask), where);
      assert.ok(a.Description.length >= 10, `${where}: beskrivning`);
      if (a.Type === 'Port') { assert.match(a.Target, /^\d+$/, where); assert.ok(['tcp', 'udp'].includes(a.Mode), `${where}: Mode`); }
      if (a.Type === 'Path') { assert.match(a.Target, /^\//, where); assert.ok(['rw', 'ro', 'rw,slave', 'ro,slave', 'rw,shared', 'ro,shared'].includes(a.Mode), `${where}: Mode ${a.Mode}`); }
      if (a.Type === 'Variable') {
        assert.match(a.Target, /^[A-Z][A-Z0-9_]*$/, where);
        if (!RUNTIME_VARS.has(a.Target)) assert.ok(new RegExp(`process\\.env\\.${a.Target}\\b|\\$\\{?${a.Target}\\b`).test(serverSource), `${where}: ${a.Target} läses inte av servern`);
      }
      // Ett val ur en lista: värdet finns bland valen
      if (a.Default.includes('|') && x.text.trim()) assert.ok(a.Default.split('|').includes(x.text.trim()), `${where}: ${x.text} finns inte i ${a.Default}`);
      if (a.Required === 'true') assert.ok(x.text.trim() || a.Default, `${where}: obligatorisk utan värde`);
    }
    for (const t of ['8420', '/config', '/media', 'PUID', 'PGID', 'UMASK', 'TZ', 'HWACCEL', 'UPDATE_CHECK']) assert.ok(targets.includes(t), `${file}: ${t} saknas`);
    const by = Object.fromEntries(cfg.map(x => [x.attrs.Target, x]));
    assert.match(textOf(c, 'WebUI'), /^http:\/\/\[IP\]:\[PORT:8420\]\/$/);
    assert.equal(by['/config'].attrs.Default, '/mnt/user/appdata/braxhn-tv');
    // Unraids konvention: nobody:users
    assert.equal(by.PUID.text.trim(), '99'); assert.equal(by.PGID.text.trim(), '100'); assert.equal(by.UMASK.text.trim(), '002');
    for (const t of ['PUID', 'PGID', 'UMASK', 'TZ', 'UPDATE_CHECK', 'TONEMAP', 'MAX_TRANSCODES', 'X264_PRESET']) assert.equal(by[t].attrs.Display, 'advanced', `${t} är avancerad`);
    for (const t of ['8420', '/config', '/media']) assert.equal(by[t].attrs.Display, 'always', `${t} syns alltid`);
    // Hemligheter maskeras
    for (const t of ['TMDB_API_KEY', 'OPENSUBTITLES_API_KEY']) assert.equal(by[t].attrs.Mask, 'true', t);
    // Hårdvaruacceleration är valfri: --runtime=nvidia bara i NVIDIA-mallen (utan pluginen startar containern inte)
    const extra = textOf(c, 'ExtraParams');
    if (file.includes('nvidia')) {
      assert.match(extra, /--runtime=nvidia/);
      assert.equal(by.NVIDIA_VISIBLE_DEVICES.text.trim(), 'all');
      assert.match(textOf(c, 'Requires'), /Nvidia-Driver/);
    } else {
      assert.ok(!/--runtime=nvidia/.test(extra), 'standardmallen kräver inget NVIDIA-kort');
      assert.equal(by['/dev/dri'].attrs.Type, 'Device'); assert.equal(by['/dev/dri'].attrs.Required, 'false');
      assert.equal(by['/dev/dri'].text, '', 'GPU-enheten är tom som standard (alla har inte /dev/dri)');
      assert.equal(by.NVIDIA_VISIBLE_DEVICES.attrs.Required, 'false');
    }
  });
}

test('mallarna har samma inställningar (utom GPU-delen) och samma standardvärden som imagen', () => {
  const [a, b] = TEMPLATES.map(f => new Map(configs(tpl[f]).map(x => [x.attrs.Target, x])));
  const only = (x, y) => [...x.keys()].filter(k => !y.has(k));
  assert.deepEqual(only(a, b), ['/dev/dri']);
  assert.deepEqual(only(b, a), []);
  for (const [k, x] of a) if (b.has(k) && !['HWACCEL', 'NVIDIA_VISIBLE_DEVICES', 'NVIDIA_DRIVER_CAPABILITIES', 'HW_DECODE'].includes(k)) {
    assert.equal(b.get(k).text, x.text, `värdet för ${k}`); assert.equal(b.get(k).attrs.Default, x.attrs.Default, `standard för ${k}`);
  }
  const df = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
  const env = Object.fromEntries([...df.matchAll(/\b([A-Z_]+)=(\S+)/g)].map(m => [m[1], m[2]]));
  for (const k of ['PUID', 'PGID', 'UMASK', 'HWACCEL', 'TZ']) assert.equal(env[k], a.get(k).text.trim(), `Dockerfile ${k}`);
  assert.equal(env.PORT, a.get('PORT').text.trim());
});

test('Docker-imagen: OCI-etiketter, HEALTHCHECK, tini för hela processgruppen, inga onödiga verktyg', () => {
  const df = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
  for (const l of ['title', 'description', 'source', 'version', 'licenses', 'url', 'revision']) assert.match(df, new RegExp(`org\\.opencontainers\\.image\\.${l}=`), l);
  assert.match(df, /org\.opencontainers\.image\.version="\$VERSION"/);
  assert.match(df, /org\.opencontainers\.image\.licenses="MIT"/);
  assert.match(df, /net\.unraid\.docker\.icon="https:\/\/raw\.githubusercontent\.com\/BraXhn\/braxhn-tv\/main\/unraid\/braxhn-tv\.png"/);
  assert.match(df, /^HEALTHCHECK .*--start-period=\d+s/m);
  assert.match(df, /\/api\/health/);
  assert.match(df, /^ENTRYPOINT \["\/usr\/bin\/tini", "-g", "--", "\/entrypoint\.sh"\]/m);
  assert.match(df, /^STOPSIGNAL SIGTERM/m);
  assert.match(df, /rm -rf \/usr\/local\/lib\/node_modules\/npm/, 'npm tas bort ur imagen');
  assert.ok(!/^USER /m.test(df), 'startskriptet byter användare (PUID/PGID) – inte USER');
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'docker-publish.yml'), 'utf8');
  assert.match(wf, /VERSION=\$\{\{ steps\.ch\.outputs\.version \}\}/, 'versionen till bygget');
  assert.match(wf, /type=raw,value=latest,enable=\$\{\{ steps\.ch\.outputs\.channel == 'latest' \}\}/, ':latest bara vid utgåva');
  assert.match(wf, /type=raw,value=edge,enable=\$\{\{ steps\.ch\.outputs\.channel == 'edge' \}\}/, ':edge vid push');
  assert.match(wf, /CHANGELOG\.md saknar avsnittet/, 'utgåvan kräver ett avsnitt i ändringsloggen');
  // Ändringsloggen har "Ej utgiven" överst (döps om till versionen vid utgåvan)
  assert.match(fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8'), /^# Ändringar\n\n## (Ej utgiven|\d+\.\d+\.\d+)/);
});

// ---------- startskriptet: PUID/PGID/UMASK ----------
const ENTRY = path.join(REPO, 'docker', 'entrypoint.sh');
function entry(env, args = ['true']) {
  const r = spawnSync('sh', [ENTRY, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, out: r.stdout + r.stderr };
}
const decide = (env) => {
  const r = entry({ BRAXHN_ENTRYPOINT_DRYRUN: '1', ...env });
  assert.equal(r.status, 0, r.out);
  const m = /beslut: läge=(\w+) puid=(\d+) pgid=(\d+) umask=(\d+)/.exec(r.out);
  assert.ok(m, r.out);
  return { mode: m[1], puid: m[2], pgid: m[3], umask: m[4], log: r.out };
};

test('startskriptet: beslutet om användare och rättigheter (PUID/PGID/UMASK)', () => {
  // Unraids standard: root i containern → servern körs som nobody:users
  assert.deepEqual({ ...decide({ BRAXHN_TEST_UID: '0' }), log: '' }, { mode: 'drop', puid: '99', pgid: '100', umask: '002', log: '' });
  const own = decide({ BRAXHN_TEST_UID: '0', PUID: '1000', PGID: '1000', UMASK: '022' });
  assert.deepEqual([own.mode, own.puid, own.pgid, own.umask], ['drop', '1000', '1000', '022']);
  // PUID=0: root, med en varning
  const root = decide({ BRAXHN_TEST_UID: '0', PUID: '0', PGID: '0' });
  assert.equal(root.mode, 'root'); assert.match(root.log, /VARNING: PUID=0/);
  // Ogiltiga värden ersätts med Unraids standard och loggas
  const bad = decide({ BRAXHN_TEST_UID: '0', PUID: 'nobody', PGID: '-1', UMASK: '0999' });
  assert.deepEqual([bad.mode, bad.puid, bad.pgid, bad.umask], ['drop', '99', '100', '002']);
  assert.match(bad.log, /PUID="nobody" är inte ett tal/); assert.match(bad.log, /PGID="-1"/); assert.match(bad.log, /UMASK="0999" är ogiltig/);
  assert.equal(decide({ BRAXHN_TEST_UID: '0', UMASK: '0027' }).umask, '0027');
  // Startad med --user: PUID kan inte användas – ett råd, ingen ändring
  const user = decide({ BRAXHN_TEST_UID: '1000', PUID: '99' });
  assert.equal(user.mode, 'user'); assert.match(user.log, /startades som användare 1000 \(--user\) – PUID=99 används inte/);
  const same = decide({ BRAXHN_TEST_UID: '1000', PUID: '1000' });
  assert.equal(same.mode, 'user'); assert.ok(!/används inte/.test(same.log));
  // Provläget ändrar ingenting
  const dir = path.join(ROOT, 'dry'); fs.mkdirSync(dir);
  decide({ BRAXHN_TEST_UID: '0', CONFIG_DIR: path.join(dir, 'c'), TRANSCODE_DIR: path.join(dir, 't') });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('startskriptet på riktigt: rätt ägare och umask, tydligt fel när /config inte går att skriva i', () => {
  const asRoot = process.getuid() === 0;
  const base = path.join(ROOT, 'ep'); fs.mkdirSync(base, { mode: 0o755 }); fs.chmodSync(base, 0o755);
  const dirs = (n) => { const d = path.join(base, n); for (const x of ['c', 't', 'm']) fs.mkdirSync(path.join(d, x), { recursive: true }); fs.chmodSync(d, 0o755); return d; };
  const d = dirs('ok');
  fs.writeFileSync(path.join(d, 'c', 'gammal.db'), '');
  const env = { CONFIG_DIR: path.join(d, 'c'), TRANSCODE_DIR: path.join(d, 't'), MEDIA_ROOT: path.join(d, 'm'), UMASK: '022' };
  const r = entry(env, ['sh', '-c', 'id -u; id -g; umask; touch "$CONFIG_DIR/ny"']);
  assert.equal(r.status, 0, r.out);
  const want = asRoot ? [99, 100] : [process.getuid(), process.getgid()];
  assert.match(r.out, new RegExp(`^${want[0]}\\n${want[1]}\\n0?022$`, 'm'), r.out);
  assert.match(r.out, new RegExp(`BraXhn TV startar som ${want[0]}:${want[1]} \\(läge ${asRoot ? 'drop' : 'user'}, umask 022`));
  const st = fs.statSync(path.join(d, 'c', 'ny'));
  assert.deepEqual([st.uid, st.gid], want);
  assert.equal(st.mode & 0o777, 0o644, 'umask 022');
  if (asRoot) {
    // Befintliga filer med fel ägare rättas (bara de)
    const old = fs.statSync(path.join(d, 'c', 'gammal.db')); assert.deepEqual([old.uid, old.gid], [99, 100]);
  }
  // /config utan skrivrätt (även för ägaren): servern startas inte, och loggen säger vad man gör
  const bad = dirs('bad');
  fs.chmodSync(path.join(bad, 'c'), 0o555);
  const r2 = entry({ CONFIG_DIR: path.join(bad, 'c'), TRANSCODE_DIR: path.join(bad, 't'), MEDIA_ROOT: path.join(bad, 'm') }, ['sh', '-c', 'echo SERVERN-STARTADE']);
  assert.equal(r2.status, 1, r2.out);
  assert.ok(!r2.out.includes('SERVERN-STARTADE'));
  assert.match(r2.out, /FEL: servern \(\d+:\d+\) kan inte skriva i /);
  assert.match(r2.out, asRoot ? /chown -R 99:100 \/mnt\/user\/appdata\/braxhn-tv/ : /startades med --user/);
});

// ---------- databasen: nedgraderingsskydd och säkerhetskopior före uppgradering ----------
const DB_URL = pathToFileURL(path.join(REPO, 'server', 'db.js')).href;
function openDb(config, env = {}) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `await import(${JSON.stringify(DB_URL)})`],
    { env: { ...process.env, CONFIG_DIR: config, ...env }, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, out: r.stdout + r.stderr };
}
function newConfig(name) { const c = path.join(ROOT, name, 'config'); fs.mkdirSync(c, { recursive: true }); assert.equal(openDb(c).status, 0); return c; }
const dbf = (c) => path.join(c, 'braxhn-tv.db');
function edit(c, sql) { const db = new DatabaseSync(dbf(c)); try { db.exec(sql); } finally { db.close(); } }
function read(c, fn) { const db = new DatabaseSync(dbf(c), { readOnly: true }); try { return fn(db); } finally { db.close(); } }
const backupsOf = (c) => { try { return fs.readdirSync(path.join(c, 'backups')).filter(f => f.startsWith('före-uppgradering-')).sort(); } catch { return []; } };

test('nedgraderingsskydd: en databas från en nyare version startar inte och ändras inte', () => {
  const c = newConfig('down');
  const SV = D.SCHEMA_VERSION;
  assert.equal(read(c, db => db.prepare('PRAGMA user_version').get().user_version), SV);
  // Som om 9.0.0 migrerat databasen och användaren gått tillbaka till den här imagen
  edit(c, `PRAGMA user_version=${SV + 1}; UPDATE settings SET v='9.0.0' WHERE k='app_version'; CREATE TABLE framtida(x); INSERT INTO framtida VALUES(1);`);
  fs.mkdirSync(path.join(c, 'backups'), { recursive: true });
  fs.copyFileSync(dbf(c), path.join(c, 'backups', `före-uppgradering-${VERSION}-1700000000000.db`));
  const before = fs.readFileSync(dbf(c));
  const r = openDb(c);
  assert.equal(r.status, 78, r.out);
  assert.match(r.out, /Databasen kommer från en nyare version av BraXhn TV \(9\.0\.0\) än den här/);
  assert.match(r.out, new RegExp(`Schemat är ${SV + 1}, den här versionen känner bara till ${SV}`));
  assert.match(r.out, new RegExp(`kopiera backups/före-uppgradering-${VERSION.replace(/\./g, '\\.')}-1700000000000\\.db till .*restore\\.db`));
  assert.match(r.out, /ALLOW_DOWNGRADE=1/);
  assert.ok(before.equals(fs.readFileSync(dbf(c))), 'databasfilen är orörd');
  assert.equal(read(c, db => db.prepare("SELECT v FROM settings WHERE k='app_version'").get().v), '9.0.0');
  assert.deepEqual(backupsOf(c), [`före-uppgradering-${VERSION}-1700000000000.db`], 'ingen ny kopia');
  // Hela servern vägrar också (inte bara db.js)
  const srv = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: REPO, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, NODE_ENV: '', CONFIG_DIR: c, PORT: String(SERVER_PORT), HTTPS_PORT: String(SERVER_PORT + 1), TRANSCODE_DIR: path.join(ROOT, 'down', 'tc') } });
  assert.equal(srv.status, 78, srv.stdout + srv.stderr);
  // Utan kopia: rådet nämner restore.db i allmänhet
  fs.rmSync(path.join(c, 'backups'), { recursive: true });
  assert.match(openDb(c).out, /Återställ en säkerhetskopia från en version .* eller äldre: lägg den som .*restore\.db/);
  // ALLOW_DOWNGRADE=1: startar med en varning, schemat sänks inte
  const f = openDb(c, { ALLOW_DOWNGRADE: '1' });
  assert.equal(f.status, 0, f.out);
  assert.match(f.out, /ALLOW_DOWNGRADE=1: databasen kommer från en nyare version/);
  assert.equal(read(c, db => db.prepare('PRAGMA user_version').get().user_version), SV + 1);
  assert.equal(read(c, db => db.prepare('SELECT x FROM framtida').get().x), 1);
});

test('återgång med restore.db: kopian från före uppgraderingen tas i bruk och servern startar', () => {
  const c = newConfig('rollback');
  edit(c, "INSERT INTO settings(k,v) VALUES('markör','gammal')");
  fs.copyFileSync(dbf(c), path.join(ROOT, 'rollback', 'kopia.db'));
  edit(c, `PRAGMA user_version=${D.SCHEMA_VERSION + 3}; UPDATE settings SET v='ny' WHERE k='markör'`);
  assert.equal(openDb(c).status, 78);
  fs.copyFileSync(path.join(ROOT, 'rollback', 'kopia.db'), path.join(c, 'restore.db'));
  const r = openDb(c);
  assert.equal(r.status, 0, r.out);
  assert.equal(read(c, db => db.prepare("SELECT v FROM settings WHERE k='markör'").get().v), 'gammal');
});

test('säkerhetskopia före uppgradering: tas vid ny version, de N senaste behålls (DB_UPGRADE_BACKUPS)', () => {
  const c = newConfig('keep');
  assert.deepEqual(backupsOf(c), [], 'ny databas: ingen kopia');
  edit(c, "INSERT INTO settings(k,v) VALUES('markör','1')");
  for (const [i, v] of ['0.1.0', '0.2.0', '0.3.0', '0.4.0'].entries()) {
    edit(c, `UPDATE settings SET v='${v}' WHERE k='app_version'; UPDATE settings SET v='${i}' WHERE k='markör'`);
    const r = openDb(c, { DB_UPGRADE_BACKUPS: '2' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, new RegExp(`uppgradering ${v.replace(/\./g, '\\.')} → ${VERSION.replace(/\./g, '\\.')}: säkerhetskopia sparad`));
  }
  const b = backupsOf(c);
  assert.equal(b.length, 2, b.join(', '));
  assert.ok(b.some(f => f.startsWith('före-uppgradering-0.4.0-')) && b.some(f => f.startsWith('före-uppgradering-0.3.0-')), b.join(', '));
  // Kopian är en fullständig databas med läget från före uppgraderingen
  const k = new DatabaseSync(path.join(c, 'backups', b.find(f => f.includes('0.4.0'))), { readOnly: true });
  try {
    assert.equal(k.prepare("SELECT v FROM settings WHERE k='app_version'").get().v, '0.4.0');
    assert.equal(k.prepare("SELECT v FROM settings WHERE k='markör'").get().v, '3');
    assert.equal(k.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { k.close(); }
  // Samma version: ingen ny kopia
  openDb(c, { DB_UPGRADE_BACKUPS: '2' });
  assert.deepEqual(backupsOf(c), b);
});

// ---------- uppdateringsnotisen ----------
test('versionsjämförelse: förhandsversioner och v-prefix', () => {
  const c = U.cmpVer;
  assert.equal(c('1.0.0', '0.9.3'), 1); assert.equal(c('0.9.3', '1.0.0'), -1); assert.equal(c('v1.0.0', '1.0.0'), 0);
  assert.equal(c('1.0.0-beta.3', '1.0.0'), -1, 'beta före utgåvan'); assert.equal(c('1.0.0', '1.0.0-beta.3'), 1);
  assert.equal(c('1.0.0-beta.10', '1.0.0-beta.3'), 1); assert.equal(c('1.0.0-beta.3', '1.0.0-beta.3'), 0);
  assert.equal(c('1.10.0', '1.9.9'), 1);
});

test('uppdateringsnotisen: senaste release från GitHub, högst en gång per dygn, avstängbar, inget om servern skickas', async () => {
  gh.hits.length = 0; gh.status = 200; gh.rel = release('99.0.0');
  assert.equal(U.info().enabled, true, 'på som standard');
  let i = await U.check();
  assert.equal(gh.hits.length, 1);
  const h = gh.hits[0];
  assert.equal(h.url, '/repos/BraXhn/braxhn-tv/releases/latest', 'ingen frågesträng');
  assert.equal(h.headers['user-agent'], 'BraXhn-TV', 'ingen version eller id i User-Agent');
  assert.ok(!h.headers.cookie && !h.headers.authorization);
  assert.ok(!JSON.stringify(h.headers).includes(VERSION), 'versionen skickas inte');
  i = U.info();
  assert.equal(i.available, true); assert.equal(i.latest, '99.0.0'); assert.equal(i.current, VERSION);
  assert.match(i.notes, /Något nytt i 99\.0\.0/);
  assert.equal(i.url, 'https://github.com/BraXhn/braxhn-tv/releases/tag/v99.0.0');
  assert.equal(i.error, null);
  // Inom ett dygn: ingen ny fråga
  await U.check(); await U.check();
  assert.equal(gh.hits.length, 1, 'högst en gång per dygn');
  // Efter ett dygn: en ny fråga
  U.state.checked = Date.now() - U.INTERVAL - 1000;
  await U.check();
  assert.equal(gh.hits.length, 2);
  // Administratörens "Kontrollera nu" går före dygnsgränsen, men högst en gång per minut
  await U.check({ force: true }); await U.check({ force: true });
  assert.equal(gh.hits.length, 3);
  // Avstängd: ingen fråga alls, inte ens "Kontrollera nu"
  D.setSetting('update_check', '0');
  U.state.checked = 1;
  await U.check(); await U.check({ force: true });
  assert.equal(gh.hits.length, 3);
  assert.equal(U.info().enabled, false);
  D.setSetting('update_check', '1');
  // Tidpunkten och svaret sparas: en ny process (omstart) frågar inte igen inom dygnet
  U.state.checked = Date.now() - 1000; D.setSetting('update_checked', String(U.state.checked));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    `const U = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'server', 'updates.js')).href)}); await U.check(); console.log(JSON.stringify(U.info()));`],
    { env: { ...process.env }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(j.latest, '99.0.0'); assert.equal(j.available, true); assert.match(j.notes, /Något nytt/);
  assert.equal(gh.hits.length, 3, 'ingen ny fråga efter omstarten');
});

test('uppdateringsnotisen: samma version, ingen utgåva än, fel och märkliga svar', async () => {
  const again = () => { U.state.checked = 0; return U.check(); };
  gh.rel = release(VERSION);
  await again();
  assert.equal(U.info().available, false); assert.equal(U.info().notes, '');
  gh.rel = release('0.0.1');
  await again();
  assert.equal(U.info().available, false, 'en äldre release är ingen uppdatering');
  gh.status = 404;
  await again();
  assert.equal(U.info().error, 'ingen utgåva publicerad än');
  gh.status = 403;
  await again();
  assert.equal(U.info().error, 'GitHub begränsar anropen just nu');
  gh.status = 200; gh.rel = release('99.1.0', { prerelease: true });
  await again();
  assert.equal(U.info().latest, '0.0.1', 'förhandsversioner räknas inte');
  gh.rel = release('99.1.0', { html_url: 'javascript:alert(1)' });
  await again();
  assert.equal(U.info().latest, '99.1.0'); assert.equal(U.info().url, null, 'bara länkar till github.com');
});

// ---------- hela servern: startloggen, uppdateringen via API:t och avstängning med SIGTERM ----------
test('servern: startloggen, "Ny version finns" för administratören och ren avstängning på SIGTERM', async () => {
  gh.hits.length = 0; gh.status = 200; gh.rel = release('99.0.0');
  const root = path.join(ROOT, 'srv'), config = path.join(root, 'config');
  fs.mkdirSync(config, { recursive: true });
  const base = `http://127.0.0.1:${SERVER_PORT}`;
  const env = { ...process.env, NODE_ENV: '', CONFIG_DIR: config, PORT: String(SERVER_PORT), HTTPS_PORT: String(SERVER_PORT + 1), TRANSCODE_DIR: path.join(root, 'tc'),
    MEDIA_ROOT: path.join(root, 'media'), DVR_DIR: path.join(root, 'rec'), PODCAST_DIR: path.join(root, 'pod'), TMDB_API_KEY: '', WATCH_FILES: '0',
    BOOK_METADATA: '0', UPDATE_URL: GH_URL, UPDATE_CHECK_START_MS: '300' };
  delete env.UPDATE_CHECK;
  const start = async () => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
    for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (p.exitCode !== null) break; await sleep(200); }
    assert.equal(p.exitCode, null, log);
    return { p, log: () => log };
  };
  const stop = async (s) => {
    const done = new Promise(r => s.p.once('exit', (code, sig) => r({ code, sig })));
    const t0 = Date.now();
    process.kill(s.p.pid, 'SIGTERM');
    const res = await Promise.race([done, sleep(9000).then(() => null)]);
    if (!res) { process.kill(s.p.pid, 'SIGKILL'); await done; assert.fail('servern avslutades inte inom 9 s på SIGTERM:\n' + s.log()); }
    return { ...res, ms: Date.now() - t0 };
  };
  const s = await start();
  try {
    let cookie = '';
    const req = async (p, o = {}) => {
      const r = await fetch(base + p, { method: o.method || 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc)) cookie = sc.split(';')[0];
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: 'Testlösen-2026!' } })).status, 200);
    for (let i = 0; i < 50 && gh.hits.length === 0; i++) await sleep(100);
    assert.equal(gh.hits.length, 1, 'servern frågade GitHub efter start');
    const st = (await req('/api/status')).data;
    assert.equal(st.user.update, '99.0.0', '"Ny version finns" för administratören');
    const u = (await req('/api/updates')).data;
    assert.equal(u.available, true); assert.equal(u.url, 'https://github.com/BraXhn/braxhn-tv/releases/tag/v99.0.0'); assert.equal(u.interval, 24);
    // "Kontrollera nu" frågar igen; att stänga av sparas
    assert.equal((await req('/api/updates/check', { method: 'POST' })).data.latest, '99.0.0');
    assert.equal(gh.hits.length, 2);
    assert.equal((await req('/api/updates', { method: 'PUT', body: { enabled: false } })).data.enabled, false);
    assert.equal((await req('/api/updates', { method: 'PUT', body: { enabled: true } })).data.enabled, true);
    // Startloggen
    const log = s.log();
    assert.match(log, new RegExp(`BraXhn TV ${VERSION.replace(/\./g, '\\.')} · Node \\d+\\.\\d+\\.\\d+ · linux/\\w+`));
    assert.match(log, /\[start\] körs som \d+:\d+, umask \d+/);
    assert.match(log, /\[start\] (ffmpeg \S+|FEL: ffmpeg hittades inte)/);
    assert.match(log, /\[start\] hårdvaruacceleration: HWACCEL=none/);
    assert.match(log, /\[start\] sökvägar: konfiguration .*config, media .*media \(saknas\), omkodningscache /);
  } finally {
    const r = await stop(s);
    assert.equal(r.code, 0, `avslutningskod (${r.sig || ''}):\n${s.log()}`);
    assert.match(s.log(), /\[stopp\] SIGTERM – stänger av/);
    assert.match(s.log(), /\[stopp\] klart på \d+ ms/);
    assert.ok(r.ms < 8000, `avstängningen tog ${r.ms} ms`);
  }
  // Databasen stängdes rent: ingen WAL kvar, hel
  assert.ok(!fs.existsSync(dbf(config) + '-wal') || fs.statSync(dbf(config) + '-wal').size === 0, 'WAL inskriven i databasen');
  assert.equal(read(config, db => db.prepare('PRAGMA integrity_check').get().integrity_check), 'ok');
  // Omstart inom dygnet: ingen ny fråga till GitHub, men notisen finns kvar
  const s2 = await start();
  try {
    await sleep(1500);
    assert.equal(gh.hits.length, 2, 'högst en gång per dygn även över omstarter');
  } finally { assert.equal((await stop(s2)).code, 0); }
});

test('startloggens råd om hårdvaruacceleration och mappar', async () => {
  const S = await import('../server/startinfo.js');
  assert.match(S.hwAdvice('vaapi', []), /\/dev\/dri saknas/);
  assert.match(S.hwAdvice('qsv', []), /\/dev\/dri saknas/);
  assert.match(S.hwAdvice('nvenc', ['/dev/dri/renderD128']), /Nvidia-Driver.*--runtime=nvidia/);
  assert.match(S.hwAdvice('none', ['/dev/dri/renderD128']), /vaapi eller qsv/);
  assert.match(S.hwAdvice('none', ['/dev/nvidia0']), /välj nvenc/);
  assert.equal(S.hwAdvice('vaapi', ['/dev/dri/renderD128']), null);
  assert.equal(S.hwAdvice('nvenc', ['/dev/nvidia0']), null);
  assert.equal(S.hwAdvice('none', []), null);
  const d = path.join(ROOT, 'dirs'); fs.mkdirSync(d);
  assert.deepEqual(S.checkDir(d, { write: true }), { path: d, exists: true, ok: true, problem: null });
  assert.equal(S.checkDir(path.join(d, 'saknas'), { write: true }).problem, 'finns inte');
  assert.equal(S.checkDir(path.join(d, 'saknas')).ok, true, 'en saknad mediamapp är inget fel');
  if (process.getuid() !== 0) { fs.chmodSync(d, 0o555); assert.equal(S.checkDir(d, { write: true }).problem, 'kan inte skriva'); fs.chmodSync(d, 0o755); }
});
