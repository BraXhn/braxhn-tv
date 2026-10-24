// Vy: önskningar (filmer och serier som användarna vill ha)
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, main, me, store, toast, views, toastErr } from '../core.js';
import { route } from '../router.js';
import { promptDialog } from '../ui/dialog.js';
import { emptyState, errorState, loadingState } from '../ui/states.js';

export const REQ_STATUS = { pending: ['Väntar på godkännande', 'warn-badge'], approved: ['Godkänd', 'ok-badge'], sent: ['Laddas ner', 'ok-badge'],
  available: ['Finns att titta på', 'ok-badge'], declined: ['Nekad', 'warn-badge'], failed: ['Misslyckades', 'warn-badge'] };
views.requests = async () => {
  const R = await api('/requests');
  const kind = store.get('reqkind', 'movie');
  main.innerHTML = `<div class="toolbar"><h1>Önskningar</h1><span class="muted">Önska filmer och serier som saknas${R.radarr || R.sonarr ? ' – de laddas ner automatiskt när de godkänts' : ''}</span></div>
    ${R.canRequest ? `<form id="rqf" class="row panel" style="align-items:flex-end"><div><label>Typ</label><select id="rqk"><option value="movie">Film</option><option value="show">Serie</option></select></div>
      <div style="flex:1;min-width:200px"><label>Sök</label><input id="rqq" placeholder="Titel…" autocomplete="off"></div><button class="primary">Sök</button></form>
      <div id="rqres" class="matchgrid" style="max-height:none"></div>` : '<p class="muted">Önskemål är avstängda.</p>'}
    <div class="panel"><h2>Alla önskemål</h2><table>${R.items.map(r => `<tr><td style="width:48px">${r.poster ? `<img src="${esc(r.poster)}" alt="" style="width:40px;border-radius:4px">` : ''}</td>
      <td><b>${esc(r.title)}</b> ${r.year ? `<span class="muted">(${r.year})</span>` : ''}<div class="muted small">${r.kind === 'movie' ? 'Film' : 'Serie'} · ${esc(r.user || '')} · ${fmtDate(r.created)}${r.note ? ' · ' + esc(r.note) : ''}</div></td>
      <td><span class="${REQ_STATUS[r.status]?.[1] || ''}">${REQ_STATUS[r.status]?.[0] || esc(r.status)}</span></td>
      <td class="r">${me.adminHere && ['pending', 'failed', 'approved'].includes(r.status) ? `<button class="primary small" data-rqok="${r.id}">${r.status === 'failed' ? 'Försök igen' : r.status === 'approved' ? 'Skicka' : 'Godkänn'}</button>` : ''}
        ${me.adminHere && r.status === 'pending' ? `<button class="ghost small" data-rqno="${r.id}">Neka</button>` : ''}
        ${me.adminHere || (r.userId === me.id && r.status === 'pending') ? `<button class="ghost small" data-rqdel="${r.id}">Ta bort</button>` : ''}</td></tr>`).join('') || '<tr><td class="muted">Inga önskemål ännu.</td></tr>'}</table></div>`;
  $$('[data-rqok]').forEach(b => b.onclick = async () => { try { await api(`/requests/${b.dataset.rqok}/approve`, { method: 'POST' }); toast('Skickad'); } catch (e) { toastErr(e); } route(); });
  $$('[data-rqno]').forEach(b => b.onclick = act(async () => { const note = await promptDialog('Anledning (valfritt)', { title: 'Neka önskemålet', type: 'textarea', maxlength: 300, okLabel: 'Neka' }); if (note === null) return; await api(`/requests/${b.dataset.rqno}/decline`, { method: 'POST', body: { note } }); route(); }));
  $$('[data-rqdel]').forEach(b => b.onclick = act(async () => { await api(`/requests/${b.dataset.rqdel}`, { method: 'DELETE' }); route(); }));
  if (!$('#rqf')) return;
  $('#rqk').value = kind;
  $('#rqk').onchange = () => store.set('reqkind', $('#rqk').value);
  $('#rqq').focus();
  $('#rqf').onsubmit = async (e) => {
    e.preventDefault();
    const k = $('#rqk').value, q = $('#rqq').value.trim(); if (!q) return;
    $('#rqres').innerHTML = loadingState({ kind: 'inline', label: 'Söker…' });
    try {
      const res = await api(`/requests/search?kind=${k}&q=${encodeURIComponent(q)}`);
      $('#rqres').innerHTML = res.map((x, i) => `<div class="mcard">${x.poster ? `<img src="${esc(x.poster)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div style="flex:1"><b>${esc(x.title)}</b> ${x.year ? `<span class="muted">(${x.year})</span>` : ''}${x.streaming?.length ? `<div class="small" style="color:var(--ok)">Finns redan på ${esc(x.streaming.join(', '))}</div>` : ''}<div class="small muted">${esc(x.overview)}</div></div>
        <div>${x.inLibrary ? `<a class="btn small" href="#/item/${x.inLibrary}">Finns – titta</a>` : x.request ? `<span class="${REQ_STATUS[x.request]?.[1]}">${REQ_STATUS[x.request]?.[0]}</span>` : `<button class="primary small" data-rqadd="${i}">Önska</button>`}</div></div>`).join('') || emptyState({ compact: true, title: 'Inga träffar', text: 'Prova en annan stavning eller originaltiteln.' });
      $$('[data-rqadd]').forEach(b => b.onclick = async () => {
        const x = res[+b.dataset.rqadd]; b.disabled = true;
        try { const r = await api('/requests', { method: 'POST', body: { kind: k, tmdbId: x.id, title: x.title, year: x.year, poster: x.poster, overview: x.overview } });
          b.outerHTML = `<span class="${REQ_STATUS[r.status]?.[1]}">${REQ_STATUS[r.status]?.[0]}</span>`; }
        catch (er) { toastErr(er); b.disabled = false; }
      });
    } catch (er) { if (!er.aborted && $('#rqres')) $('#rqres').innerHTML = errorState(er, { compact: true }); }
  };
};
