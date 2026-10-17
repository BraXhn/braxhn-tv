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
