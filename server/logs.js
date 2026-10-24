// Serverloggen: allt som skrivs med console.* sparas också i minnet (de senaste raderna, för Administration →
// Logg) och i en fil per dag i /config/logs (sju dagar sparas). Importeras först av index.js så att även
// modulernas startmeddelanden kommer med. Hemligheter (nycklar, token, lösenord i adresser) maskeras innan
// något sparas, eftersom loggen kan laddas ner och skickas vidare vid felsökning.
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

const DIR = path.join(process.env.CONFIG_DIR || '/config', 'logs');
const KEEP_DAYS = 7, MAX_LINES = 3000;
const ring = [];
let seq = 0;

/** Tar bort sådant som inte får hamna i en logg som delas: token, nycklar, lösenord och inloggning i adresser */
export function mask(s) {
  return String(s)
    .replace(/\b(bearer|token|api[_-]?key|apikey|key|secret|password|pass|pw|auth|sig|signature|x-plex-token)(["']?\s*[=:]\s*["']?)([^\s"'&,;]+)/gi, '$1$2***')
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***@')
    .replace(/\b(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*)/g, '***')
    .replace(/\b[a-f0-9]{32,}\b/gi, '***')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '***');
}

const day = (d = new Date()) => d.toLocaleDateString('sv-SE');
const stampOf = (d) => `${day(d)} ${d.toLocaleTimeString('sv-SE')}`;
let file = null, fileDay = '';
function out() {
  const d = day();
  if (fileDay === d && file) return file;
  try { file?.end(); } catch {}
  fileDay = d; file = null;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    file = fs.createWriteStream(path.join(DIR, `braxhn-${d}.log`), { flags: 'a' });
    file.on('error', () => { file = null; });
    prune();
  } catch { file = null; }
  return file;
}
function prune() {
  fs.readdir(DIR, (e, list = []) => {
    const old = list.filter(f => /^braxhn-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().slice(0, -KEEP_DAYS);
    for (const f of old) fs.rm(path.join(DIR, f), { force: true }, () => {});
  });
}

/** Lägger en rad i loggen (används av console-krokarna och för felrapporter från webbappen) */
export function record(level, text) {
  const d = new Date();
  const msg = mask(text).slice(0, 4000);
  ring.push({ id: ++seq, t: d.getTime(), level, msg });
  if (ring.length > MAX_LINES) ring.splice(0, ring.length - MAX_LINES);
  if (process.env.NODE_ENV !== 'test') out()?.write(`${stampOf(d)} ${level.toUpperCase().padEnd(5)} ${msg}\n`);
}

/** Loggrader, nyast sist. level: 'error' | 'warn' | 'info' (minst den nivån), q: fritext, after: bara nyare än id */
export function lines({ level = 'info', q = '', after = 0, limit = 500 } = {}) {
  const min = { info: 0, warn: 1, error: 2 }[level] ?? 0;
  const rank = { info: 0, warn: 1, error: 2 };
  const needle = String(q).toLowerCase();
  return ring.filter(l => l.id > after && rank[l.level] >= min && (!needle || l.msg.toLowerCase().includes(needle))).slice(-Math.min(2000, Math.max(1, limit)));
}

// Krokar på console.*: originalet skrivs som förut (med tidsstämpel i produktion – Unraids loggvy visar annars inga tider)
const STAMP = process.env.NODE_ENV === 'production' && process.env.LOG_TIME !== '0';
for (const [k, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    try { record(level, util.format(...a)); } catch {}
    STAMP ? orig(stampOf(new Date()), ...a) : orig(...a);
  };
}
