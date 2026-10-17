// Aktivitetsindikator i menyraden (bara administratörer på hemnätet): visar pågående jobb på servern –
// skanning, analys, omkodning, inspelning m.m. – med en ring runt ikonen medan något pågår.
// Klick öppnar en panel med jobben. Hämtar /api/jobs var 3:e sekund när något pågår eller panelen är öppen,
// annars var 20:e; pausar när fliken är dold och har aldrig mer än ett anrop i luften.
import { $, esc } from '../core.js';
import { openPopover } from './menu.js';
import { emptyState } from './states.js';

const KIND = { scan: 'Skanning', analysis: 'Analys', transcode: 'Omkodning', remux: 'Remux', keyframes: 'Nyckelbilder',
  subtitle: 'Undertexter', record: 'Inspelning', download: 'Nedladdning' };
const S = { on: false, jobs: [], timer: null, busy: false, pop: null };
const R = 11, C = 2 * Math.PI * R;

/** Startar indikatorn (anropas efter inloggning när användaren får administrera härifrån) */
export function startActivity() {
  if (S.on) return;
  S.on = true;
  ensureButton();
  document.addEventListener('visibilitychange', onVis);
  poll();
}
/** Stoppar och tar bort indikatorn (utloggning, profilbyte till en vanlig profil) */
export function stopActivity() {
  S.on = false; S.jobs = [];
  clearTimeout(S.timer); S.timer = null;
  document.removeEventListener('visibilitychange', onVis);
  S.pop?.close(false);
  $('#actbtn')?.remove();
}
function onVis() { if (!document.hidden && S.on) { clearTimeout(S.timer); poll(); } }

function ensureButton() {
  if ($('#actbtn')) return;
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'actbtn'; b.className = 'actbtn';
  b.setAttribute('aria-label', 'Aktivitet'); b.title = 'Aktivitet';
  b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-expanded', 'false');
  b.innerHTML = `<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
    <circle class="act-track" cx="14" cy="14" r="${R}"/><circle class="act-arc" cx="14" cy="14" r="${R}" stroke-dasharray="0 ${C}"/>
    <path class="act-pulse" d="M6.5 14.5h3.2l2-5 3.4 9.5 2.2-6.5 1.2 2h3"/></svg><span class="act-count" hidden></span>`;
  b.onclick = (e) => { e.stopPropagation(); if (S.pop) S.pop.close(); else openPanel(b); };
  const anchor = $('#stbadge') || $('.usermenu');
  anchor?.before(b);
}

async function poll() {
  if (!S.on || S.busy) return;
  if (document.hidden) return; // fortsätter när fliken syns igen (onVis)
  S.busy = true;
  try {
    const r = await fetch('/api/jobs', { headers: { accept: 'application/json' } });
    // 403 = inte administratör härifrån, 404 = äldre server utan jobblistan: tyst, ingen indikator
    if (r.status === 403 || r.status === 404 || r.status === 401) { stopActivity(); return; }
    if (r.ok) { const d = await r.json(); S.jobs = Array.isArray(d?.jobs) ? d.jobs : []; }
  } catch { /* ingen kontakt – försök igen vid nästa varv */ }
  finally { S.busy = false; }
  if (!S.on) return;
  render();
  clearTimeout(S.timer);
  S.timer = setTimeout(poll, S.pop || S.jobs.length ? 3000 : 20000);
}

function render() {
  const b = $('#actbtn'); if (!b) return;
  const n = S.jobs.length, arc = b.querySelector('.act-arc'), cnt = b.querySelector('.act-count');
  b.classList.toggle('busy', n > 0);
  // Ett jobb med känt förlopp: ringen fylls; annars en roterande båge
  const one = n === 1 && typeof S.jobs[0].progress === 'number' ? Math.max(0, Math.min(1, S.jobs[0].progress)) : null;
  b.classList.toggle('indet', n > 0 && one == null);
  arc.setAttribute('stroke-dasharray', n === 0 ? `0 ${C}` : one != null ? `${(one * C).toFixed(1)} ${C}` : `${(C * 0.28).toFixed(1)} ${C}`);
  cnt.hidden = n === 0; cnt.textContent = n > 9 ? '9+' : String(n);
  const label = n ? `Aktivitet: ${n} ${'pågår'}` : 'Aktivitet';
  b.setAttribute('aria-label', label); b.title = label;
  if (S.pop) fillPanel(S.pop.body);
}

const elapsed = (started) => {
  if (!started) return '';
  const ms = started < 1e12 ? started * 1000 : started; // sekunder eller millisekunder
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`;
};
function fillPanel(body) {
  if (!S.jobs.length) { body.innerHTML = emptyState({ icon: '✓', title: 'Inget pågår just nu', text: 'Skanning, omkodning och inspelningar visas här medan de pågår.', compact: true }); return; }
  const groups = new Map();
  for (const j of S.jobs) { const k = j.kind || 'other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(j); }
  const top = body.scrollTop;
  body.innerHTML = [...groups].map(([k, list]) => `<section class="jobgroup"><h3>${esc(KIND[k] || k)} <span class="job-n">${list.length}</span></h3>
    <ul class="jobs">${list.map(j => {
      const p = typeof j.progress === 'number' ? Math.max(0, Math.min(1, j.progress)) : null;
      const count = j.total ? `${+j.done || 0}/${+j.total}` : '';
      return `<li class="job"><div class="job-head"><b>${esc(j.title || KIND[k] || '')}</b><span class="job-meta">${esc([count, elapsed(j.started)].filter(Boolean).join(' · '))}</span></div>
        ${j.detail ? `<div class="job-detail">${esc(j.detail)}</div>` : ''}
        <div class="prog${p == null ? ' indet' : ''}" role="progressbar" aria-label="${esc(j.title || KIND[k] || 'Jobb')}" aria-valuemin="0" aria-valuemax="100"${p == null ? '' : ` aria-valuenow="${Math.round(p * 100)}"`}><i style="width:${p == null ? 30 : p * 100}%"></i></div></li>`;
    }).join('')}</ul></section>`).join('');
  body.scrollTop = top;
}
function openPanel(b) {
  S.pop = openPopover(b, { label: 'Aktivitet', title: 'Aktivitet', cls: 'actpanel', onClose: () => { S.pop = null; } });
  fillPanel(S.pop.body);
  S.pop.place();
  // Snabbare uppdatering medan panelen är öppen
  clearTimeout(S.timer); poll();
}
