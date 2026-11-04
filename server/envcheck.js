// Miljön servern körs i: minnesgräns (cgroup), antal kärnor och läget när något i miljön inte fungerar (full disk för
// databasen, tjänster som inte går att nå). Tusentals Unraid-servrar ser olika ut – från en Raspberry Pi med 2 GB till
// en server med 128 GB och fyra grafikkort – så gränserna räknas fram här i stället för att antas.
//  - memLimit(): containerns minnesgräns (cgroup v2 memory.max, v1 memory.limit_in_bytes) eller null (ingen gräns)
//  - autoMaxTranscodes(): standardtaket för samtidiga omkodningar när admin inte valt något (MAX_TRANSCODES)
//  - onMemoryPressure(fn): cacher som töms när processen närmar sig gränsen (kontrolleras var 30:e sekund)
//  - checkItems(lang): rader till säkerhetskontrollen i Administration
// Importerar bara Nodes moduler och db.js (läget för databasen) – inga routes.
import fs from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';
import { dbHealth, DB_TEXT } from './db.js';
import { netInfo } from './backoff.js';

const NO_LIMIT = 2 ** 60;
/** Minnesgränsen i byte för cgroupen vi kör i, eller null. root = filsystemets rot (tester). */
export function memLimit(root = '') {
  const read = (f) => { try { return fs.readFileSync(root + f, 'utf8').trim(); } catch { return null; } };
  // cgroup v2: /sys/fs/cgroup/memory.max ("max" = ingen gräns). v1: memory.limit_in_bytes (ett jättetal = ingen gräns).
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    const v = read(f);
    if (v == null || v === 'max') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n < NO_LIMIT) return Math.min(n, os.totalmem());
  }
  return null;
}
/** Kärnor som processen får använda (cgroup-kvot räknas av Node i availableParallelism) – minst 1 */
export const cores = () => Math.max(1, (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) || 1);

/**
 * Standardtak för samtidiga omkodningar. Med grafikkort: 4 (som förut). Med processorn: efter kärnor och minne – en
 * 1080p-omkodning med libx264 tar ungefär en kärna och 300–500 MB; fyra samtidiga på en Raspberry Pi med 2 GB låste den.
 */
export function autoMaxTranscodes({ hw = 'none', ncores = cores(), mem = memLimit() ?? os.totalmem() } = {}) {
  if (hw !== 'none') return 4;
  let n = ncores >= 4 ? 4 : ncores >= 2 ? 2 : 1;
  if (mem < 1.5 * 2 ** 30) n = 1; else if (mem < 3 * 2 ** 30) n = Math.min(n, 2);
  return n;
}

// ---- minnestryck ----
const clearers = [];
/** fn() töms när processen använder mer än 85 % av minnesgränsen (cacher som byggs upp igen vid behov) */
export function onMemoryPressure(fn) { clearers.push(fn); }
export const memState = { limit: null, rss: 0, heapLimit: 0, pressure: 0, lastPressure: 0 };
let warned = 0;
export function checkMemory(rss = process.memoryUsage.rss(), limit = memState.limit) {
  memState.rss = rss;
  if (!limit || rss < limit * 0.85) return false;
  memState.pressure++; memState.lastPressure = Date.now();
  for (const fn of clearers) { try { fn(); } catch {} }
  if (Date.now() - warned > 30 * 60e3) {
    warned = Date.now();
    console.warn(`[minne] servern använder ${Math.round(rss / 2 ** 20)} MB av containerns gräns ${Math.round(limit / 2 ** 20)} MB – cacher töms. Höj gränsen (--memory i Extra Parameters) eller sänk antalet samtidiga omkodningar.`);
  }
  return true;
}
export function startMemoryWatch() {
  memState.limit = memLimit();
  memState.heapLimit = v8.getHeapStatistics().heap_size_limit;
  const mb = (b) => Math.round(b / 2 ** 20);
  if (memState.limit) {
    console.log(`[minne] containerns minnesgräns ${mb(memState.limit)} MB, ${cores()} kärnor`);
    // V8:s gräns för JavaScript-minnet över containerns: processen dödas av OOM-killern i stället för att städa själv
    if (memState.heapLimit > memState.limit * 0.9) console.warn(`[minne] Nodes heapgräns (${mb(memState.heapLimit)} MB) är större än containerns minnesgräns – sätt NODE_OPTIONS=--max-old-space-size=${Math.max(256, Math.round(mb(memState.limit) * 0.6))}`);
  }
  if (memState.limit) setInterval(() => checkMemory(), 30e3).unref();
}

// ---- rader till säkerhetskontrollen (Administration) ----
export function checkItems(lang = 'sv') {
  const en = lang === 'en', L = (sv, e) => en ? e : sv, out = [];
  memState.rss = process.memoryUsage.rss();
  if (dbHealth.problem) out.push({ level: 'bad', title: L('Databasen kan inte skriva', 'The database cannot write'),
    detail: `${en ? { full: 'The disk that holds /config is full – changes are not saved until there is free space again', readonly: 'The database in /config is read-only – check that the folder is writable for the container user (PUID/PGID)', ioerr: 'Read or write error on the disk that holds /config', busy: 'The database is locked by another program', corrupt: 'The database is damaged – restore from a backup (see README, Troubleshooting)', cantopen: 'The database file cannot be opened' }[dbHealth.problem] : DB_TEXT[dbHealth.problem]} (${dbHealth.error})` });
  for (const s of netInfo()) out.push({ level: 'warn', title: L(`${s.svc.toUpperCase()} går inte att nå`, `${s.svc.toUpperCase()} cannot be reached`),
    detail: L(`${s.error}. Metadata hämtas när tjänsten svarar igen – uppspelning och skanning påverkas inte. Kontrollera DNS och brandvägg för containern.`,
      `${s.error}. Metadata is fetched when the service answers again – playback and scanning are not affected. Check DNS and the firewall for the container.`) });
  if (memState.limit) {
    const pct = Math.round(memState.rss / memState.limit * 100);
    out.push({ level: memState.pressure && Date.now() - memState.lastPressure < 3600e3 ? 'warn' : 'ok',
      title: L(`Minne: ${Math.round(memState.rss / 2 ** 20)} MB av ${Math.round(memState.limit / 2 ** 20)} MB (${pct} %)`, `Memory: ${Math.round(memState.rss / 2 ** 20)} MB of ${Math.round(memState.limit / 2 ** 20)} MB (${pct} %)`),
      detail: memState.pressure ? L(`Nära gränsen ${memState.pressure} gånger – cacher har tömts. Höj containerns minnesgräns eller sänk antalet samtidiga omkodningar.`, `Close to the limit ${memState.pressure} times – caches were cleared. Raise the container memory limit or lower the number of simultaneous transcodes.`) : '' });
  }
  return out;
}
