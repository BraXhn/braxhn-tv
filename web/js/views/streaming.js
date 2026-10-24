// Vyer: strömmande tjänster och var en titel finns att se
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, main, me, store, toast, views } from '../core.js';
import { route } from '../router.js';
import { REQ_STATUS } from './requests.js';
import { provBlock } from './item.js';
import { openDialog } from '../ui/dialog.js';
import { emptyState, errorState, loadingState } from '../ui/states.js';

// ---------- streamingtjänster ----------
views.streaming = async () => {
  if (me.kid) { location.hash = '#/'; return; }
  const P_ = await api('/streaming/providers').catch(e => { if (e.aborted) throw e; return { error: e.message }; });
  if (P_.error) { main.innerHTML = errorState({ message: P_.error }); return; }
  const kind = store.get('stkind', 'movie');
  const sel = (store.get('stprov', '') || P_.mine.join(',')).split(',').map(Number).filter(Boolean);
  const shown = P_.all.filter(p => P_.mine.includes(p.id) || sel.includes(p.id));
  main.innerHTML = `<div class="toolbar"><h1>Strömmande</h1><span class="muted">Det som finns på era tjänster just nu</span>
      <select id="stk" style="margin-left:auto"><option value="movie">Filmer</option><option value="show">Serier</option></select>${me.adminHere ? '<button class="ghost" id="stmine">Välj era tjänster</button>' : ''}</div>
    ${P_.mine.length ? `<div class="provrow" id="stchips">${shown.map(p => `<button class="prov chip${sel.includes(p.id) ? ' mine' : ''}" data-pv="${p.id}">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}<span>${esc(p.name)}</span></button>`).join('')}</div>
      <div class="grid" id="stgrid" style="margin-top:16px" aria-busy="true">${loadingState({ kind: 'inline' })}</div><div class="row" style="justify-content:center;margin:16px 0"><button class="ghost" id="stmore" hidden>Visa fler</button></div>`
    : emptyState({ icon: '📡', title: 'Inga tjänster valda', text: me.adminHere ? 'Välj vilka tjänster ni har (t.ex. Prime Video och TV4 Play) så visas deras utbud här.' : 'En administratör behöver välja vilka tjänster ni har.' })}
    <p class="muted small">BraXhn TV kan inte spela upp innehåll från tjänsterna (de är kopieringsskyddade) – ett klick öppnar titeln i tjänstens egen app eller webbplats.</p>`;
  $('#stk').value = kind;
  $('#stk').onchange = (e) => { store.set('stkind', e.target.value); route(); };
  if ($('#stmine')) $('#stmine').onclick = () => {
    openDialog({ title: 'Era streamingtjänster', size: 'wide',
      body: `<div class="provpick">${P_.all.map(p => `<label class="prov"><input type="checkbox" value="${p.id}" ${P_.mine.includes(p.id) ? 'checked' : ''}>${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}<span>${esc(p.name)}</span></label>`).join('')}</div>`,
      actions: [{ label: 'Avbryt' }, { label: 'Spara', kind: 'primary', onClick: async ({ el }) => {
        const ids = $$('input:checked', el).map(i => +i.value); await api('/streaming/mine', { method: 'PUT', body: { ids }, bg: true }); store.set('stprov', ''); route();
      } }] });
  };
  if (!P_.mine.length) return;
  $$('[data-pv]').forEach(b => b.onclick = () => { const id = +b.dataset.pv; const s = new Set(sel); s.has(id) ? s.delete(id) : s.add(id); store.set('stprov', [...s].join(',') || P_.mine.join(',')); route(); });
  let page = 1, results = [];
  const stCard = (x, i) => `<a class="card" href="#" data-st="${i}"><div class="art">${x.poster ? `<img loading="lazy" src="${esc(x.poster)}" alt="">` : `<div class="ph">${esc(x.title)}</div>`}${x.inLibrary ? '<span class="badge">Hemma</span>' : ''}</div><div class="t">${esc(x.title)}</div><div class="s">${x.year || ''}</div></a>`;
  const load = async () => {
    const r = await api(`/streaming/discover?kind=${kind}&providers=${sel.join(',')}&page=${page}`);
    const grid = $('#stgrid'), more = $('#stmore');
    if (!grid || !more) return;
    const from = results.length;
    results = results.concat(r.results);
    const html = r.results.map((x, j) => stCard(x, from + j)).join('');
    if (from === 0) { grid.innerHTML = html || emptyState({ compact: true, title: 'Inget hittades', text: 'Välj fler tjänster ovan.' }); grid.removeAttribute('aria-busy'); }
    else grid.insertAdjacentHTML('beforeend', html);
    more.hidden = page >= r.pages;
    $$('[data-st]', grid).slice(from).forEach(a => a.onclick = (e) => { e.preventDefault(); streamDialog(results[+a.dataset.st]); });
  };
  $('#stmore').onclick = act(async () => {
    const b = $('#stmore'); if (!b || b.disabled) return;
    b.disabled = true; page++;
    try { await load(); } catch (e) { page--; throw e; } finally { b.disabled = false; }
  });
  load().catch(e => { if (!e.aborted && $('#stgrid')) { $('#stgrid').innerHTML = errorState(e, { compact: true }); $('#stgrid').removeAttribute('aria-busy'); } });
};
async function streamDialog(x) {
  const h = openDialog({ title: `${x.title}${x.year ? ` (${x.year})` : ''}`,
    body: `<div class="row" style="align-items:flex-start;gap:16px;flex-wrap:nowrap">${x.poster ? `<img src="${esc(x.poster)}" alt="" width="110" style="width:110px;height:auto;border-radius:8px">` : ''}
    <p class="small" style="margin:0">${esc(x.overview || '')}</p></div>
    <div id="sdp" aria-live="polite">${loadingState({ kind: 'inline' })}</div>
    ${x.inLibrary ? `<p><a class="btn primary" href="#/item/${+x.inLibrary}">▶ Finns hemma – spela</a></p>` : ''}`,
    actions: [...(x.inLibrary ? [] : [{ label: 'Önska till biblioteket', onClick: async () => {
      const r = await api('/requests', { method: 'POST', body: { kind: x.kind, tmdbId: x.id, title: x.title, year: x.year, poster: x.poster, overview: x.overview }, bg: true });
      toast(REQ_STATUS[r.status]?.[0] || 'Önskad');
    } }]), { label: 'Stäng' }] });
  const d = h.el;
  const w = await api(`/streaming/title/${x.kind}/${x.id}?title=${encodeURIComponent(x.title)}`, { bg: true }).catch(() => null);
  if ($('#sdp', d)) $('#sdp', d).innerHTML = provBlock(w) || '<p class="muted small">Inga tjänster hittades.</p>';
}
