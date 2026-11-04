// Kollar om en ny utgåva av BraXhn TV finns: ett anrop till GitHubs API (senaste release – inte main, där
// versionsnumret kan höjas innan utgåvan finns som :latest) högst en gång per dygn, även över omstarter (tiden
// sparas i databasen). Inget om servern skickas: ingen version, inget id – bara en allmän User-Agent som GitHub kräver.
// Avstängt med UPDATE_CHECK=0 eller under Administration. Inget telemetri.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting } from './db.js';
import { notify } from './notify.js';
import * as webhooks from './webhooks.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPO = process.env.UPDATE_REPO || 'BraXhn/braxhn-tv';
// UPDATE_URL: annan adress till "senaste release" i GitHubs format (testerna använder en låtsad server)
const URL_LATEST = process.env.UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
export const INTERVAL = 24 * 3600e3;
const MANUAL_MIN = 60e3; // "Kontrollera nu" högst en gång per minut

const num = (k) => { const v = +getSetting(k, ''); return Number.isFinite(v) && v > 0 ? v : null; };
// Senaste kända svar finns kvar efter en omstart, så att servern inte behöver fråga igen
export const state = {
  latest: getSetting('update_latest', '') || null, checked: num('update_checked'), notes: getSetting('update_notes', ''),
  url: getSetting('update_url', '') || null, error: null,
};

/** Jämför versioner "1.2.3" / "1.2.3-beta.4" → -1/0/1. En förhandsversion är lägre än samma version utan tillägg. */
export function cmpVer(a, b) {
  const [ma, pa = ''] = String(a).replace(/^v/, '').split(/-(.*)/s), [mb, pb = ''] = String(b).replace(/^v/, '').split(/-(.*)/s);
  const x = ma.split('.').map(n => parseInt(n) || 0), y = mb.split('.').map(n => parseInt(n) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  if (!pa !== !pb) return pa ? -1 : 1;
  if (pa === pb) return 0;
  // beta.3 < beta.10: jämför tal som tal
  const sa = pa.split('.'), sb = pb.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] === undefined) return -1; if (sb[i] === undefined) return 1;
    const na = /^\d+$/.test(sa[i]), nb = /^\d+$/.test(sb[i]);
    if (na && nb && +sa[i] !== +sb[i]) return +sa[i] > +sb[i] ? 1 : -1;
    if (sa[i] !== sb[i]) return sa[i] > sb[i] ? 1 : -1;
  }
  return 0;
}

/** Plocka ut ändringarna mellan nuvarande och senaste version ur CHANGELOG.md ("## 0.5.0" …) */
export function notesBetween(md, from, to) {
  const out = [];
  for (const sec of String(md).split(/^## /m).slice(1)) {
    const v = sec.split(/\s/)[0];
    if (cmpVer(v, from) > 0 && cmpVer(v, to) <= 0) out.push('## ' + sec.trim());
  }
  return out.join('\n\n').slice(0, 4000);
}

export const enabled = () => getSetting('update_check', process.env.UPDATE_CHECK || '1') === '1';
let running = null, lastManual = 0;

/** Fråga GitHub – bara om det gått ett dygn sedan förra gången (force: administratörens "Kontrollera nu") */
export function check({ force = false } = {}) {
  if (!enabled()) return Promise.resolve(state);
  const now = Date.now();
  if (!force && state.checked && now - state.checked < INTERVAL) return Promise.resolve(state);
  if (force && now - lastManual < MANUAL_MIN && state.checked) return Promise.resolve(state);
  if (force) lastManual = now;
  return (running ||= fetchLatest().finally(() => { running = null; }));
}

async function fetchLatest() {
  try {
    const r = await fetch(URL_LATEST, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'BraXhn-TV' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
    state.checked = Date.now(); setSetting('update_checked', String(state.checked));
    if (r.status === 404) { state.error = 'ingen utgåva publicerad än'; return state; }
    // Fasta texter (webben översätter dem, se web/i18n/en.js)
    if (!r.ok) { state.error = r.status === 403 || r.status === 429 ? 'GitHub begränsar anropen just nu' : 'GitHub svarade med ett fel'; console.warn(`[uppdatering] GitHub svarade ${r.status}`); return state; }
    const rel = await r.json();
    const v = String(rel?.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+/.test(v) || rel.draft || rel.prerelease) { state.error = 'oväntat svar från GitHub'; return state; }
    state.error = null;
    state.latest = v;
    state.url = /^https:\/\/github\.com\//.test(rel.html_url || '') ? rel.html_url : null;
    state.notes = cmpVer(v, VERSION) > 0 ? String(rel.body || '').slice(0, 4000) : '';
    setSetting('update_latest', v); setSetting('update_notes', state.notes); setSetting('update_url', state.url || '');
    if (cmpVer(v, VERSION) > 0) {
      notify('update', `Version ${v} finns`, `Du kör ${VERSION}. Uppdatera containern i Unraid (Check for updates → Apply update).`, { key: 'upd:' + v, minInterval: 7 * 86400 });
      webhooks.updateAvailable({ current: VERSION, latest: v, notes: state.notes });
    }
  } catch (e) { state.error = e.name === 'TimeoutError' ? 'GitHub svarade inte' : e.message; }
  return state;
}

export const info = () => ({ current: VERSION, latest: state.latest, available: !!state.latest && cmpVer(state.latest, VERSION) > 0, notes: state.notes,
  url: state.url, checked: state.checked, error: state.error, enabled: enabled(), repo: REPO, interval: INTERVAL / 3600e3 });

// Första kontrollen en stund efter start (bara om det gått ett dygn), sedan varje timme om dygnet har gått.
// UPDATE_CHECK_START_MS: kortare väntan i testerna. Testservrar (NODE_TEST_CONTEXT ärvs från node --test) frågar
// aldrig den riktiga GitHub – bara en låtsad server via UPDATE_URL.
if (process.env.NODE_ENV !== 'test' && (!process.env.NODE_TEST_CONTEXT || process.env.UPDATE_URL)) {
  setTimeout(check, +process.env.UPDATE_CHECK_START_MS || 30e3).unref();
  setInterval(check, 3600e3).unref();
}
