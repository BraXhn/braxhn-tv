// Synka undertext mot ljudet (servern räknar, se server/subsync.js): "Synka automatiskt" under ⚙ med förlopp, resultat
// och Ångra, samt "Spara för alla" för den manuella finjusteringen (−/+ under Undertextens tid). Servern lägger själv
// på sparad synk när undertexten hämtas, så efter en ändring räcker det att hämta spåret igen (sub.sv i subs.js).
// Laddas vid behov från subs.js när en undertextfil väljs; körs automatiskt för nedladdade undertexter utan synk
// (Mitt konto → Uppspelning, subAutoSync i /playback).
import { $, api, esc, toast, toastErr, t } from '../core.js';
import { P } from './video.js';
import { setSubs } from './subs.js';

const itemOf = (sub) => (/\/api\/stream\/(\d+)\//.exec(sub.url) || [])[1];
const syncUrl = (sub) => `/items/${itemOf(sub)}/subs/${encodeURIComponent(sub.id)}/sync`;
const sec = (x) => (x < 0 ? '−' : '+') + Math.abs(x).toFixed(1).replace('.', ',') + ' s';
const num = (x) => String(+(+x).toFixed(3)).replace('.', ',');
const NTSC = 24000 / 1001;
const PAIRS = [[25, NTSC], [NTSC, 25], [25, 24], [24, 25], [24, NTSC], [NTSC, 24]]; // som FPS_PAIRS i server/subsync.js
/** "flyttad +1,8 s · takt 25 → 23,976 bilder/s" */
export function describe(r) {
  const parts = [t('flyttad {v}', { v: sec(r.offset || 0) })];
  const fps = r.fps || (r.ratio && PAIRS.filter(p => Math.abs(p[0] / p[1] - r.ratio) < 1e-6).map(([from, to]) => ({ from, to }))[0]);
  if (fps) parts.push(t('takt {from} → {to} bilder/s', { from: num(fps.from), to: num(fps.to) }));
  else if (r.ratio && Math.abs(r.ratio - 1) > 1e-6) parts.push(t('takt × {ratio}', { ratio: num(r.ratio) }));
  return parts.join(' · ');
}
const live = (cur, sub) => P === cur && cur.sub === sub.id && cur.sync?.sub === sub.id;

/** Visa raden för vald undertextfil (anropas av setSubs vid varje ändring) */
export function showSync(cur, sub) {
  const box = cur && $('#psync', cur.el);
  if (!box || P !== cur || cur.sub !== sub.id) return;
  if (cur.sync?.sub !== sub.id) {
    if (cur.sync) clearTimeout(cur.sync.timer);
    cur.sync = { sub: sub.id, timer: null, busy: false, text: '', undo: null };
    first(cur, sub);
  }
  box.hidden = false;
  render(cur, sub);
}

// Första gången undertexten visas: pågår redan en synk (startad vid nedladdningen)? Annars automatiskt om valt.
async function first(cur, sub) {
  const g = cur.sync;
  let st = null;
  try { st = await api(syncUrl(sub), { bg: true }); } catch { return; }
  if (!live(cur, sub) || cur.sync !== g) return;
  if (st.job && (st.job.state === 'queued' || st.job.state === 'running')) return follow(cur, sub, st);
  if (sub.source === 'downloaded' && !sub.sync && !st.auto && cur.pb?.subAutoSync && !(cur.syncTried ||= new Set()).has(sub.id)) {
    cur.syncTried.add(sub.id);
    start(cur, sub, false);
  }
}

function render(cur, sub) {
  const box = $('#psync', cur.el), g = cur.sync; if (!box || !g) return;
  const extra = cur.offset || 0;
  const now = sub.sync ? t('Synkad: {sync}', { sync: describe(sub.sync) }) : '';
  box.innerHTML = `<span class="small psyncs" role="status" aria-live="polite">${esc(g.text || now)}</span>
    <span class="row"><button class="ghost small" id="psyncgo" ${g.busy ? 'disabled' : ''}>${t('Synka automatiskt')}</button>
    ${g.undo ? t('<button class="ghost small" id="psyncundo">Ångra</button>') : ''}
    ${extra ? `<button class="ghost small" id="psyncsave" title="${t('Sparar justeringen för den här undertexten – gäller alla som tittar')}">${t('Spara {v}', { v: esc(sec(extra)) })}</button>` : ''}</span>`;
  $('#psyncgo', box).onclick = () => start(cur, sub, !!sub.sync);
  const u = $('#psyncundo', box); if (u) u.onclick = () => undo(cur, sub);
  const s = $('#psyncsave', box); if (s) s.onclick = () => saveManual(cur, sub);
}

async function start(cur, sub, force) {
  const g = cur.sync; if (!g || g.busy) return;
  g.busy = true; g.text = t('Synkar mot ljudet …'); render(cur, sub);
  try { follow(cur, sub, await api(syncUrl(sub), { method: 'POST', body: { audio: cur.audio || null, force }, bg: true })); }
  catch (e) { g.busy = false; g.text = ''; if (live(cur, sub)) render(cur, sub); toastErr(e); }
}

// Följ jobbet tills det är klart (förloppet visas i raden)
function follow(cur, sub, st) {
  const g = cur.sync; if (!g || !live(cur, sub)) return;
  clearTimeout(g.timer);
  const j = st.job;
  if (j && (j.state === 'queued' || j.state === 'running')) {
    g.busy = true;
    g.text = j.state === 'queued' ? t('Väntar på tur …') : t('Synkar mot ljudet … {v} %', { v: Math.round((j.progress || 0) * 100) });
    render(cur, sub);
    g.timer = setTimeout(async () => {
      try { follow(cur, sub, await api(syncUrl(sub), { bg: true })); }
      catch { if (live(cur, sub)) g.timer = setTimeout(() => follow(cur, sub, st), 5000); }
    }, 1000);
    return;
  }
  g.busy = false;
  if (j?.state === 'done' && j.result) {
    g.undo = j.previous || { offset: 0, ratio: 1 };
    g.text = t('Klar – {result}', { result: describe(j.result) });
    apply(cur, sub, st);
    toast(t('Undertexten synkad – {result}', { result: describe(j.result) }));
  } else if (j?.state === 'unsure') {
    g.text = t('Hittade ingen säker förskjutning – justera med − och +');
    render(cur, sub);
  } else if (j?.state === 'error') {
    g.text = j.error || t('Synkningen misslyckades');
    render(cur, sub);
  } else render(cur, sub);
}

// Ny sparad synk: spelarens egen extra förskjutning nollas och spåret hämtas igen
function apply(cur, sub, st) {
  sub.sync = st.offset || st.ratio !== 1 ? { offset: st.offset, ratio: st.ratio } : undefined;
  sub.sv = Date.now();
  cur.offset = 0;
  setSubs(); // ritar även om raden (showSync)
}

async function put(cur, sub, body) {
  const g = cur.sync;
  try {
    const st = await api(syncUrl(sub), { method: 'PUT', body, bg: true });
    if (live(cur, sub)) apply(cur, sub, st);
    return st;
  } catch (e) { toastErr(e); if (g) render(cur, sub); return null; }
}
async function undo(cur, sub) {
  const g = cur.sync; if (!g?.undo) return;
  const prev = g.undo;
  g.undo = null; g.text = '';
  if (await put(cur, sub, prev)) { g.text = t('Återställd'); render(cur, sub); }
}
async function saveManual(cur, sub) {
  const g = cur.sync; if (!g) return;
  const was = sub.sync || { offset: 0, ratio: 1 };
  const body = { offset: Math.round(((was.offset || 0) + (cur.offset || 0)) * 1000) / 1000, ratio: was.ratio || 1 };
  if (await put(cur, sub, body)) { g.undo = was; g.text = t('Sparad – {body}', { body: describe(body) }); render(cur, sub); }
}
