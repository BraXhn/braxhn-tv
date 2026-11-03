// Pågående jobb (skanning, analys, omkodning, inspelning, nedladdning …) för aktivitetsindikatorn i webben.
// Moduler som kör något längre anropar track(); skannerns och strömningens egna tillstånd läses av direkt.
let seq = 0;
const running = new Map();

/** Registrera ett jobb. Returnerar { update(done, total, detail), end() } – end() får anropas flera gånger. */
export function track(kind, title, { total = null, detail = '' } = {}) {
  const id = `${kind}-${++seq}`;
  const j = { id, kind, title, detail, done: 0, total, started: Date.now() };
  running.set(id, j);
  return {
    update(done, tot = j.total, det = j.detail) { j.done = done; j.total = tot; j.detail = det; },
    end() { running.delete(id); }
  };
}
/** Kör fn som ett jobb (avslutas även vid fel) */
export async function tracked(kind, title, fn) {
  const h = track(kind, title);
  try { return await fn(h); } finally { h.end(); }
}

const sources = [];
/** Andra källor (t.ex. skannerns status) som ger en lista med jobb vid varje fråga */
export function addSource(fn) { sources.push(fn); }

export function list() {
  const out = [];
  for (const fn of sources) { try { out.push(...(fn() || [])); } catch {} }
  out.push(...running.values());
  return out.map(j => ({ ...j, progress: j.total ? Math.max(0, Math.min(1, j.done / j.total)) : null }));
}

// ---------- bakgrundsjobb medan någon tittar ----------
// Uppspelningen går före allt annat: medan någon tittar (en HLS-ström hämtas eller en direktuppspelning skickar
// framsteg) väntar de tunga bakgrundsjobben (analys, förhandsbilder, startcache, hälsokontroll …) och skanningen
// går långsamt med paus mellan filerna. Varje process som startas (spawn) blockerar händelseslingan några
// millisekunder (fork av hela processen) – många på en gång gav hack på 0,3–0,8 s i strömmen.
let watchingFn = () => false;
/** Kopplas i app.js: true när någon tittar just nu */
export function setWatching(fn) { watchingFn = fn; }
export function watching() { try { return !!watchingFn(); } catch { return false; } }
const sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
/**
 * Anropas mellan stegen i ett bakgrundsjobb. Släpper alltid händelseslingan en gång (setImmediate); medan någon
 * tittar väntar jobbet (pause = true, högst maxWait ms – sedan fortsätter det långsamt) eller tar en kort paus
 * (gap ms) så att processer och diskläsningar sprids ut i stället för att komma i klump.
 */
export async function yieldToPlayback({ pause = false, gap = 40, maxWait = Infinity } = {}) {
  await new Promise(setImmediate);
  if (!watching()) return false;
  if (pause) {
    const t0 = Date.now();
    while (watching() && Date.now() - t0 < maxWait) await sleep(2000);
    return true;
  }
  await sleep(gap);
  return true;
}
