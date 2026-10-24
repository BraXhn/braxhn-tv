// Kollar om en ny version av BraXhn TV finns (package.json + CHANGELOG.md på GitHub). Inget skickas om servern.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting } from './db.js';
import { notify } from './notify.js';
import * as webhooks from './webhooks.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPO = process.env.UPDATE_REPO || 'BraXhn/braxhn-tv';
export const state = { latest: null, checked: null, notes: '', error: null };

/** Jämför semver "1.2.3" → -1/0/1 */
export function cmpVer(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n) || 0), pb = String(b).split(/[.-]/).map(n => parseInt(n) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
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

export async function check() {
  if (getSetting('update_check', process.env.UPDATE_CHECK || '1') !== '1') return state;
  try {
    const raw = `https://raw.githubusercontent.com/${REPO}/main`;
    const pkg = await (await fetch(`${raw}/package.json`, { signal: AbortSignal.timeout(15000) })).json();
    state.latest = pkg.version; state.checked = Date.now(); state.error = null;
    if (cmpVer(pkg.version, VERSION) > 0) {
      const md = await (await fetch(`${raw}/CHANGELOG.md`, { signal: AbortSignal.timeout(15000) })).text().catch(() => '');
      state.notes = notesBetween(md, VERSION, pkg.version);
      notify('update', `Version ${pkg.version} finns`, `Du kör ${VERSION}. Uppdatera containern i Unraid (Check for updates → Apply update).`, { key: 'upd:' + pkg.version, minInterval: 7 * 86400 });
      webhooks.updateAvailable({ current: VERSION, latest: pkg.version, notes: state.notes });
    } else state.notes = '';
  } catch (e) { state.error = e.message; }
  return state;
}
export const info = () => ({ current: VERSION, latest: state.latest, available: !!state.latest && cmpVer(state.latest, VERSION) > 0, notes: state.notes, checked: state.checked, error: state.error,
  enabled: getSetting('update_check', process.env.UPDATE_CHECK || '1') === '1', repo: REPO });

if (process.env.NODE_ENV !== 'test') {
  setTimeout(check, 30e3).unref();
  setInterval(check, 12 * 3600e3).unref();
}
