// Händelseslingans fördröjning (perf_hooks). Står slingan still kan servern inte skicka segment – spelaren hackar
// fast nätet är snabbt. Mäts hela tiden (billigt: en histogram i libuv och en klocka var 20:e ms); långa stopp
// loggas med de bakgrundsjobb som pågick, och värdena syns i spelarens Statistik och i diagnosen vid hack.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as jobs from './jobs.js';

const WINDOW = 10; // sekunder i det rullande fönstret
const LOG_MS = +(process.env.LOOP_LOG_MS || 250); // stopp längre än så loggas (högst en gång per halvminut)
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
const secs = []; // { p50, p99, max } per sekund
let lastBlock = null, lastLog = 0, last = performance.now();
const tick = setInterval(() => {
  const now = performance.now(), gap = now - last - 20; last = now;
  if (gap < 40) return;
  let what = [];
  try { what = [...new Set(jobs.list().map(j => j.kind))]; } catch {}
  lastBlock = { at: Date.now(), ms: Math.round(gap), jobs: what };
  if (gap >= LOG_MS && Date.now() - lastLog > 30e3) {
    lastLog = Date.now();
    console.warn(`[prestanda] händelseslingan stod still ${Math.round(gap)} ms${what.length ? ` (pågående: ${what.join(', ')})` : ''} – strömmar kan hacka`);
  }
}, 20);
tick.unref();
const roll = setInterval(() => {
  secs.push({ p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 });
  if (secs.length > WINDOW) secs.shift();
  h.reset();
}, 1000);
roll.unref();

/** Senaste ~10 s: p99 (sämsta sekunden), största enskilda fördröjning och senaste stoppet över 40 ms */
export function loopStats() {
  const p99 = secs.length ? Math.max(...secs.map(s => s.p99)) : 0;
  const max = secs.length ? Math.max(...secs.map(s => s.max)) : 0;
  const recent = lastBlock && Date.now() - lastBlock.at < WINDOW * 1000 ? lastBlock : null;
  return { p99: Math.round(p99 * 10) / 10, max: Math.round(max), block: recent };
}
