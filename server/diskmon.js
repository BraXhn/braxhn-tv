// Diskövervakning: ledigt utrymme för /config, omkodningsmappen, inspelningar, poddar och biblioteken.
// Larmar via notiser när ett filsystem går under gränsen (vid övergången, sedan högst en påminnelse per dygn)
// och rensar inaktiva HLS-sessioner tidigare när omkodningsmappen nästan är full.
import fs from 'node:fs';
import { all, getSetting, setSetting, CONFIG } from './db.js';
import { notify } from './notify.js';
import { librariesWithRoots } from './libpaths.js';
import { TRANSCODE, purgeIdle } from './stream.js';
import { dvrDir } from './dvr.js';
import { DIR as PODCAST_DIR } from './podcasts.js';

const GB = 1e9;
const RANK = { unknown: -1, ok: 0, low: 1, critical: 2 };
const REMIND_MS = 86400e3;

/** Gränser: procent ledigt och GB ledigt (0 = av). Inställning eller miljövariabel DISK_MIN_PCT/DISK_MIN_GB. */
export function thresholds() {
  const num = (k, env, def, max) => { const v = parseFloat(getSetting(k, process.env[env] || def)); return Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : +def; };
  return { pct: num('disk_min_pct', 'DISK_MIN_PCT', '10', 50), gb: num('disk_min_gb', 'DISK_MIN_GB', '10', 100000) };
}

/** ok, low (under någon av gränserna) eller critical (under en fjärdedel av en gräns) */
export function levelOf(free, total, { pct, gb }) {
  if (!(total > 0)) return 'unknown';
  const p = free / total * 100;
  if ((pct && p < pct / 4) || (gb && free < gb * GB / 4)) return 'critical';
  if ((pct && p < pct) || (gb && free < gb * GB)) return 'low';
  return 'ok';
}

/** Mappar som övervakas (biblioteken läses från databasen) */
export function targets() {
  let dvr = null;
  try { dvr = dvrDir(); } catch {}
  const list = [
    { key: 'config', label: 'Konfiguration', path: CONFIG },
    { key: 'transcode', label: 'Omkodning', path: TRANSCODE },
    { key: 'dvr', label: 'Inspelningar', path: dvr },
    { key: 'podcasts', label: 'Poddar', path: PODCAST_DIR }
  ];
  for (const l of librariesWithRoots()) l.roots.forEach((p, i) => list.push({ key: 'lib' + l.id + (i ? '-' + i : ''), label: 'Bibliotek: ' + l.name + (l.roots.length > 1 ? ` (${p})` : ''), path: p }));
  return list.filter(t => t.path);
}

const fmtGb = (b) => (b / GB).toLocaleString('sv-SE', { maximumFractionDigits: b < 10 * GB ? 1 : 0 }) + ' GB';
export const describe = (g) => `${fmtGb(g.free)} ledigt av ${fmtGb(g.total)} (${Math.round(g.free / g.total * 100)} %)`;

let last = { at: 0, entries: [], groups: [], thresholds: thresholds() };
export const snapshot = () => last;

function loadState() { try { return JSON.parse(getSetting('disk_alert_state', '{}')) || {}; } catch { return {}; } }

/**
 * Jämför med föregående tillstånd och skickar notiser. Ren funktion (för test): returnerar nytt tillstånd och notiser.
 * groups = [{ key, labels, free, total, level }]. Hysteres: en lägre nivå gäller först med 10 % marginal till gränsen.
 */
export function evaluate(groups, state, th, nowMs = Date.now()) {
  const next = {}, out = [];
  for (const g of groups) {
    const prev = state[g.key] || { level: 'ok', notified: 0 };
    let level = g.level;
    if (level === 'unknown') { next[g.key] = prev; continue; }
    if (RANK[level] < RANK[prev.level]) {
      // På väg ner en nivå: kräv marginal så att ett värde som pendlar kring gränsen inte ger en notis varje gång
      const m = levelOf(g.free, g.total, { pct: th.pct * 1.1, gb: th.gb * 1.1 });
      if (RANK[m] > RANK[level]) level = m;
    }
    let notified = prev.notified || 0;
    const where = g.labels.join(', ');
    if (RANK[level] > RANK[prev.level]) {
      out.push({ title: level === 'critical' ? 'Diskutrymmet är nästan slut' : 'Lite ledigt diskutrymme', message: `${where}: ${describe(g)}.`, priority: level === 'critical' ? 5 : 4 });
      notified = nowMs;
    } else if (RANK[level] > 0 && nowMs - notified >= REMIND_MS) {
      out.push({ title: 'Fortfarande lite diskutrymme', message: `${where}: ${describe(g)}.`, priority: 3 });
      notified = nowMs;
    } else if (level === 'ok' && prev.level !== 'ok') {
      out.push({ title: 'Diskutrymmet räcker igen', message: `${where}: ${describe(g)}.`, priority: 2 });
      notified = 0;
    }
    next[g.key] = { level, notified };
  }
  return { state: next, notices: out };
}

/** Läs ledigt utrymme för alla mappar, larma och rensa omkodningsmappen vid behov */
export async function check() {
  const th = thresholds();
  const entries = [];
  for (const t of targets()) {
    try {
      const [s, st] = await Promise.all([fs.promises.statfs(t.path), fs.promises.stat(t.path)]);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      entries.push({ ...t, dev: st.dev, total, free, level: levelOf(free, total, th) });
    } catch (e) { entries.push({ ...t, error: e.code === 'ENOENT' ? 'Mappen finns inte' : e.message, level: 'unknown' }); }
  }
  // Mappar på samma filsystem larmar tillsammans (annars blir det en notis per mapp)
  const byDev = new Map();
  for (const e of entries) {
    if (e.dev == null) continue;
    const g = byDev.get(e.dev);
    if (g) { g.labels.push(e.label); g.keys.push(e.key); } else byDev.set(e.dev, { key: e.key, keys: [e.key], labels: [e.label], free: e.free, total: e.total, level: e.level });
  }
  const groups = [...byDev.values()];
  const { state, notices } = evaluate(groups, loadState(), th);
  setSetting('disk_alert_state', JSON.stringify(state));
  for (const n of notices) await notify('disk', n.title, n.message, { priority: n.priority }).catch(() => {});
  // Omkodningsmappen: inaktiva sessioner rensas efter 2 min (kritiskt) eller 5 min (lågt) i stället för 15 min
  const tc = entries.find(e => e.key === 'transcode');
  let purged = 0;
  if (tc?.level === 'critical') purged = purgeIdle(120e3);
  else if (tc?.level === 'low') purged = purgeIdle(300e3);
  if (purged) console.warn(`[disk] omkodningsmappen har lite plats – ${purged} inaktiva HLS-sessioner rensades`);
  last = { at: Date.now(), entries: entries.map(({ dev, ...e }) => e), groups, thresholds: th };
  return last;
}

/** Rader till säkerhetskontrollen */
export function checkItems() {
  const s = last;
  if (!s.at) return [];
  const bad = s.groups.filter(g => g.level === 'low' || g.level === 'critical');
  if (!bad.length) return [{ level: 'ok', title: 'Gott om diskutrymme', detail: s.groups.map(g => `${g.labels.join(', ')}: ${describe(g)}`).join(' · ') }];
  return bad.map(g => ({ level: g.level === 'critical' ? 'bad' : 'warn', title: `${g.level === 'critical' ? 'Nästan fullt' : 'Lite ledigt utrymme'}: ${g.labels.join(', ')}`, detail: describe(g) + '.' }));
}

// Kontroll var 5:e minut (varje minut när omkodningsmappen har lite plats)
let timer = null, running = false;
export function start() {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    const tcLow = last.entries.some(e => e.key === 'transcode' && RANK[e.level] > 0);
    if (last.at && Date.now() - last.at < (tcLow ? 55e3 : 295e3)) return;
    running = true;
    try { await check(); } catch (e) { console.warn('[disk] kontrollen misslyckades:', e.message); } finally { running = false; }
  };
  setTimeout(tick, 20e3).unref();
  timer = setInterval(tick, 60e3); timer.unref();
}
