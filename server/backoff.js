// Backoff per extern tjänst (OpenSubtitles, Google Books, Audible …) när den svarar 429/"för många anrop".
// Förut försökte varje timskanning igen, fick samma 429 och loggade en rad per försök. Nu: en paus som fördubblas
// för varje 429 i rad (15 min → 30 min → … högst 24 h), minst så länge som Retry-After säger, och en loggrad när en
// paus börjar och en när tjänsten fungerar igen (med antalet överhoppade försök). Läget sparas i settings
// (backoff.<tjänst>) så att en omstart inte börjar om med nya anrop direkt.
import { getSetting, setSetting } from './db.js';

export const BASE_MS = 15 * 60e3;
export const MAX_MS = 24 * 3600e3;
const mem = new Map();

function state(svc) {
  if (!mem.has(svc)) {
    let s = null; try { s = JSON.parse(getSetting(`backoff.${svc}`, '') || 'null'); } catch {}
    mem.set(svc, s && typeof s === 'object' ? { until: +s.until || 0, level: +s.level || 0, skipped: +s.skipped || 0 } : { until: 0, level: 0, skipped: 0 });
  }
  return mem.get(svc);
}
const save = (svc, s) => { try { setSetting(`backoff.${svc}`, JSON.stringify(s)); } catch {} };

/** Retry-After (sekunder eller HTTP-datum) → millisekunder, null om rubriken saknas/är ogiltig */
export function retryAfterMs(h, nowMs = Date.now()) {
  if (h == null || h === '') return null;
  const s = String(h).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(+s * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

/** Hur länge till tjänsten får anropas igen (ms), 0 = nu. Ett överhoppat försök räknas (sammanfattningen). */
export function waitMs(svc, { count = true } = {}) {
  const s = state(svc), w = Math.max(0, s.until - Date.now());
  if (w && count) s.skipped++;
  return w;
}

/** Tjänsten svarade 429: pausa (exponentiellt, minst Retry-After). Returnerar pausens längd i ms. */
export function limited(svc, { retryAfter = null, label = svc, tag = svc, why = 'för många anrop' } = {}) {
  const s = state(svc);
  const exp = Math.min(MAX_MS, BASE_MS * 2 ** s.level);
  const ms = Math.min(MAX_MS, Math.max(exp, retryAfter || 0));
  s.level++; s.until = Date.now() + ms;
  save(svc, s);
  const min = Math.round(ms / 60e3);
  console.warn(`[${tag}] ${label}: ${why} – pausar i ${min >= 120 ? `${Math.round(min / 60)} h` : `${min} min`}${s.level > 1 ? ` (${s.level}:e gången i rad)` : ''}`);
  return ms;
}

/** Ett lyckat anrop: pausen nollställs (loggas om det fanns en) */
export function ok(svc, { label = svc, tag = svc } = {}) {
  const s = state(svc);
  if (!s.level && !s.until) return;
  if (s.level) console.log(`[${tag}] ${label} svarar igen efter ${s.level} paus${s.level > 1 ? 'er' : ''}${s.skipped ? ` (${s.skipped} försök hoppades över)` : ''}`);
  Object.assign(s, { until: 0, level: 0, skipped: 0 });
  save(svc, s);
}

/** Läget för adminsidan/tester */
export const info = (svc) => ({ ...state(svc), wait: Math.max(0, state(svc).until - Date.now()) });
/** Glöm läget (tester, eller ny API-nyckel) */
export function reset(svc) { mem.set(svc, { until: 0, level: 0, skipped: 0 }); save(svc, mem.get(svc)); }

/** Nästa försök för en enskild titel efter n misslyckanden i rad (429 eller ingen träff): 1 h, 4 h, 16 h … högst 30 dygn */
export const nextTrySec = (n) => Math.min(30 * 86400, 3600 * 4 ** Math.max(0, n - 1));
