// Diagnostikpaket för supporten (Administration → Hälsokontroll → Skapa diagnostikpaket). Samlar det som behövs för
// att felsöka en installation man inte kan se: version, miljö (utan hemligheter), hårdvaruacceleration, de senaste
// loggraderna, databasens storlek och migreringsversion och bibliotekens storlek (antal – fil- och mappnamn bara om
// användaren väljer det). Allt går genom maskSupport() (server/supportpack.js). Paketet byggs en gång och sparas en
// kort stund i minnet, så att det som laddas ner är exakt det som visades i förhandsvisningen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { db, get, all, CONFIG, getSetting } from './db.js';
import { VERSION } from './updates.js';
import { ffcaps } from './ffcaps.js';
import * as st from './stream.js';
import * as logs from './logs.js';
import * as jobs from './jobs.js';
import * as diskmon from './diskmon.js';
import { librariesWithRoots } from './libpaths.js';
import { maskSupport, safeEnv, tarGz } from './supportpack.js';

const LOG_LINES = 2000, KEEP_MS = 15 * 60e3, MAX_KEPT = 4;
const kept = new Map(); // id → { at, archive, filename }
// Inställningar som hjälper felsökningen (inga nycklar, adresser eller namn)
const SETTINGS = /^(language|scan_interval|remote_quality|transcode_vcodec|max_transcodes(_user)?|live_transcode|live_max_height|health_(enabled|samples|max_mbps)|update_check|subsonic|dlna_enabled|backup_enabled|backup_keep|prestart_(on|max_gb)|trickplay|subindex|watch_enabled|sonic_enabled|sonic_concurrency|music_meta|book_meta|history_days|quick_connect|requests_enabled|trust_vpn_range|admin_anywhere|setup_done|dvr_format|dvr_transcode|dvr_comskip|sso_local_login|shrink)$/;

// Miljövariablerna som spelar roll: de som servern läser (process.env.X i server/) och containerns egna
const SERVER_DIR = path.dirname(new URL(import.meta.url).pathname);
let envNames = null;
function knownEnv() {
  if (envNames) return envNames;
  envNames = new Set(['PUID', 'PGID', 'UMASK', 'TZ', 'HOST_OS', 'NODE_ENV', 'NVIDIA_VISIBLE_DEVICES', 'NVIDIA_DRIVER_CAPABILITIES']);
  try {
    for (const f of fs.readdirSync(SERVER_DIR, { recursive: true }).filter(f => f.endsWith('.js'))) {
      for (const m of fs.readFileSync(path.join(SERVER_DIR, f), 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) envNames.add(m[1]);
    }
  } catch {}
  for (const k of ['PATH', 'NODE_TEST_CONTEXT']) envNames.delete(k);
  return envNames;
}
const run = (cmd, args, timeout = 5000) => new Promise(r => execFile(cmd, args, { timeout }, (e, o, se) => r(e ? null : String(o || se))));
const size = (f) => { try { return fs.statSync(f).size; } catch { return null; } };
const json = (o) => JSON.stringify(o, null, 2) + '\n';
function readText(f, max = 4000) { try { return fs.readFileSync(f, 'utf8').slice(0, max).trim(); } catch { return null; } }
function devList(dir, re) { try { return fs.readdirSync(dir).filter(n => re.test(n)).sort(); } catch { return []; } }
function access(f) {
  try { fs.accessSync(f, fs.constants.R_OK | fs.constants.W_OK); return 'läs och skriv'; }
  catch { try { fs.accessSync(f, fs.constants.R_OK); return 'bara läs'; } catch { return 'ingen åtkomst'; } }
}

async function system() {
  const ff = await run('ffmpeg', ['-hide_banner', '-version']);
  const cg = readText('/proc/1/cgroup', 2000) || '';
  return {
    braxhnTv: VERSION, node: process.version, ffmpeg: ff ? ff.split('\n')[0] : 'saknas',
    os: `${os.type()} ${os.release()} ${os.arch()}`, distribution: (readText('/etc/os-release') || '').match(/^PRETTY_NAME="?([^"\n]*)/m)?.[1] || null,
    container: fs.existsSync('/.dockerenv') || /docker|containerd|kubepods/.test(cg) ? 'docker' : 'ingen/okänd',
    host: process.env.HOST_OS || null, // Unraid lägger HOST_OS=Unraid på containrar som skapas från en mall
    cpus: `${os.cpus().length} × ${os.cpus()[0]?.model || '?'}`,
    memory: { totalGb: +(os.totalmem() / 2 ** 30).toFixed(1), freeGb: +(os.freemem() / 2 ** 30).toFixed(1), serverRssMb: Math.round(process.memoryUsage().rss / 2 ** 20) },
    uptimeMin: { server: Math.round(process.uptime() / 60), system: Math.round(os.uptime() / 60) },
    user: { uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null, groups: process.getgroups?.() ?? [] },
    timezone: { TZ: process.env.TZ || null, resolved: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMin: -new Date().getTimezoneOffset() },
    config: { dir: CONFIG, access: access(CONFIG) }, created: new Date().toISOString()
  };
}

function hardware() {
  const dri = devList('/dev/dri', /^(renderD|card)\d+$/);
  return {
    wanted: process.env.HWACCEL || 'none', status: st.hwStatus, transcode: st.transcodeInfo(), limits: st.limits(),
    activeTranscodes: st.activeTranscodes().length,
    ffmpeg: { version: ffcaps.version || null, hwEncoders: [...ffcaps.encoders].filter(e => /^(h264|hevc|av1)_(nvenc|vaapi|qsv|amf|videotoolbox|v4l2m2m|vulkan)$/.test(e)).sort(),
      hwFilters: [...ffcaps.filters].filter(f => /^(libplacebo|tonemap_\w+|scale_(cuda|npp|vaapi|qsv|vulkan)|hwupload\w*|overlay_(cuda|vaapi|qsv))$/.test(f)).sort() },
    devices: { dri: dri.map(d => ({ name: d, access: access('/dev/dri/' + d) })), nvidia: devList('/dev', /^nvidia/),
      NVIDIA_VISIBLE_DEVICES: process.env.NVIDIA_VISIBLE_DEVICES || null, NVIDIA_DRIVER_CAPABILITIES: process.env.NVIDIA_DRIVER_CAPABILITIES || null }
  };
}

function database() {
  const f = path.join(CONFIG, 'braxhn-tv.db');
  const p = (k) => { try { return db.prepare(`PRAGMA ${k}`).get()?.[k]; } catch { return null; } };
  const tables = {};
  for (const { name } of all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name")) {
    if (/_fts|_data$|_idx$|_docsize$|_config$|_content$/.test(name)) continue;
    try { const n = get(`SELECT COUNT(*) AS n FROM "${name}"`).n; if (n) tables[name] = n; } catch {} // tomma tabeller utelämnas
  }
  return {
    schemaVersion: p('user_version'), journalMode: p('journal_mode'), pageSize: p('page_size'), pages: p('page_count'), freePages: p('freelist_count'),
    fileBytes: { db: size(f), wal: size(f + '-wal'), shm: size(f + '-shm') }, appVersionInDb: getSetting('app_version', '') || null,
    backups: devList(path.join(CONFIG, 'backups'), /./).length, rows: tables
  };
}

function libraries(names) {
  // Tabeller med library_id (items, tracks, böcker, foton …): antal rader och storlek per bibliotek
  const counted = [];
  for (const { name } of all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'")) {
    try { const cols = all(`PRAGMA table_info("${name}")`).map(c => c.name); if (cols.includes('library_id')) counted.push({ name, size: cols.includes('size'), kind: cols.includes('kind') }); } catch {}
  }
  return librariesWithRoots().map(l => {
    const out = { id: l.id, type: l.type, ...(names ? { name: l.name, folders: l.roots } : {}), folderCount: l.roots.length,
      foldersReadable: l.roots.filter(r => { try { fs.accessSync(r, fs.constants.R_OK); return true; } catch { return false; } }).length, counts: {}, bytes: 0 };
    for (const t of counted) {
      try {
        if (t.kind) for (const r of all(`SELECT kind, COUNT(*) AS n FROM "${t.name}" WHERE library_id=? GROUP BY kind`, l.id)) out.counts[`${t.name}.${r.kind}`] = r.n;
        else { const n = get(`SELECT COUNT(*) AS n FROM "${t.name}" WHERE library_id=?`, l.id).n; if (n) out.counts[t.name] = n; }
        if (t.size) out.bytes += get(`SELECT COALESCE(SUM(size),0) AS b FROM "${t.name}" WHERE library_id=?`, l.id).b;
      } catch {}
    }
    return out;
  });
}

function settings() {
  return Object.fromEntries(all('SELECT k, v FROM settings ORDER BY k').filter(r => SETTINGS.test(r.k)).map(r => [r.k, String(r.v ?? '').slice(0, 200)]));
}

const README = (names, lines) => `BraXhn TV – diagnostikpaket / diagnostics bundle

Skapat ${new Date().toISOString()} av Administration → Hälsokontroll. Bifoga filen i en buggrapport på GitHub
(https://github.com/BraXhn/braxhn-tv/issues) eller skicka den till den som hjälper dig.
Created from Administration → Health check. Attach it to a bug report on GitHub or send it to whoever helps you.

Innehåll / contents:
  system.json     version, Node, ffmpeg, operativsystem, container, minne, användare (uid/gid), tidszon
  environment.json miljövariabler – nycklar, lösenord, token och adresser visas bara som "(satt)"
  hardware.json   hårdvaruacceleration: HWACCEL, vad som fungerar, kodare, /dev/dri och NVIDIA
  database.json   databasens storlek, migreringsversion (schema) och antal rader per tabell
  libraries.json  bibliotekens typ, antal titlar/filer och storlek${names ? ' – med namn och mappar (valt)' : ' – utan namn och mappar'}
  settings.json   inställningar som påverkar felsökningen (inga nycklar eller adresser)
  jobs.json       pågående bakgrundsjobb och diskutrymme
  log.txt         de senaste ${lines} loggraderna

Maskerat / masked: token, API-nycklar, lösenord, kakor, e-postadresser och IP-adresser (<lan-ip>, <vpn-ip>, <ip>,
<ipv6>)${names ? '' : ', samt fil- och mappnamn under mediamapparna (…)'}. Läs gärna igenom filerna innan du delar dem.
Please read the files before you share them.
`;

/** Bygger paketet: { id, filename, files: [{ name, text, bytes }], bytes } – arkivet sparas för nedladdning */
export async function build({ names = false } = {}) {
  const libs = librariesWithRoots();
  const roots = [process.env.MEDIA_ROOT || '/media', ...libs.flatMap(l => l.roots), process.env.DVR_DIR || '/recordings'];
  const words = libs.map(l => [l.name, `<bibliotek ${l.id}>`]);
  const m = (s) => maskSupport(s, { names, roots, words });
  const logLines = logs.lines({ limit: LOG_LINES });
  const files = [
    { name: 'README.txt', text: README(names, logLines.length) },
    { name: 'system.json', text: m(json(await system())) },
    { name: 'environment.json', text: m(json(safeEnv(process.env, knownEnv()))) },
    { name: 'hardware.json', text: m(json(hardware())) },
    { name: 'database.json', text: m(json(database())) },
    { name: 'libraries.json', text: m(json(libraries(names))) },
    { name: 'settings.json', text: m(json(settings())) },
    { name: 'jobs.json', text: m(json({ jobs: jobs.list(), disk: diskmon.snapshot() })) },
    { name: 'log.txt', text: m(logLines.map(l => `${new Date(l.t).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${l.msg}`).join('\n') + '\n') }
  ];
  const day = new Date().toISOString().slice(0, 10);
  const dir = `braxhn-diagnostik-${day}`;
  const archive = tarGz(files.map(f => ({ name: `${dir}/${f.name}`, text: f.text })));
  const id = crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  for (const [k, v] of kept) if (now - v.at > KEEP_MS) kept.delete(k);
  while (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value);
  kept.set(id, { at: now, archive, filename: `${dir}.tar.gz` });
  return { id, filename: `${dir}.tar.gz`, names, bytes: archive.length, files: files.map(f => ({ name: f.name, text: f.text, bytes: Buffer.byteLength(f.text) })) };
}

/** Arkivet som build() skapade (null om det är för gammalt eller okänt) */
export function archive(id) {
  const k = kept.get(String(id));
  if (!k || Date.now() - k.at > KEEP_MS) return null;
  return k;
}
