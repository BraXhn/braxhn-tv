// Vy: önskningar (filmer och serier som användarna vill ha)
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, main, me, store, toast, views, toastErr, t } from '../core.js';
import { route } from '../router.js';
import { promptDialog } from '../ui/dialog.js';
import { emptyState, errorState, loadingState } from '../ui/states.js';

export const REQ_STATUS = { pending: [t('Väntar på godkännande'), 'warn-badge'], approved: [t('Godkänd'), 'ok-badge'], sent: [t('Laddas ner'), 'ok-badge'],
  available: [t('Finns att titta på'), 'ok-badge'], declined: [t('Nekad'), 'warn-badge'], failed: [t('Misslyckades'), 'warn-badge'] };
views.requests = async () => {
  const R = await api('/requests');
  const kind = store.get('reqkind', 'movie');
  main.innerHTML = `<div class="toolbar"><h1>${t('Önskningar')}</h1><span class="muted">${t('Önska filmer och serier som saknas{v}', { v: R.radarr || R.sonarr ? t(' – de laddas ner automatiskt när de godkänts') : '' })}</span></div>
    ${R.canRequest ? `<form id="rqf" class="row panel" style="align-items:flex-end"><div><label for="rqk">${t('Typ')}</label><select id="rqk"><option value="movie">Film</option><option value="show">${t('Serie')}</option></select></div>
      <div style="flex:1;min-width:200px"><label for="rqq">${t('Sök')}</label><input id="rqq" placeholder="${t('Titel…')}" autocomplete="off"></div><button class="primary">${t('Sök')}</button></form>
      <div id="rqres" class="matchgrid" style="max-height:none"></div>` : t('<p class="muted">Önskemål är avstängda.</p>')}
    <div class="panel"><h2>${t('Alla önskemål')}</h2><table>${R.items.map(r => `<tr><td style="width:48px">${r.poster ? `<img src="${esc(r.poster)}" alt="" style="width:40px;border-radius:4px">` : ''}</td>
      <td><b>${esc(r.title)}</b> ${r.year ? `<span class="muted">(${r.year})</span>` : ''}<div class="muted small">${r.kind === 'movie' ? 'Film' : t('Serie')} · ${esc(r.user || '')} · ${fmtDate(r.created)}${r.note ? ' · ' + esc(r.note) : ''}</div></td>
      <td><span class="${REQ_STATUS[r.status]?.[1] || ''}">${REQ_STATUS[r.status]?.[0] || esc(r.status)}</span></td>
      <td class="r">${me.adminHere && ['pending', 'failed', 'approved'].includes(r.status) ? `<button class="primary small" data-rqok="${r.id}">${r.status === 'failed' ? t('Försök igen') : r.status === 'approved' ? t('Skicka') : t('Godkänn')}</button>` : ''}
        ${me.adminHere && r.status === 'pending' ? `<button class="ghost small" data-rqno="${r.id}">${t('Neka')}</button>` : ''}
        ${me.adminHere || (r.userId === me.id && r.status === 'pending') ? `<button class="ghost small" data-rqdel="${r.id}">${t('Ta bort')}</button>` : ''}</td></tr>`).join('') || t('<tr><td class="muted">Inga önskemål ännu.</td></tr>')}</table></div>`;
  $$('[data-rqok]').forEach(b => b.onclick = async () => { try { await api(`/requests/${b.dataset.rqok}/approve`, { method: 'POST' }); toast(t('Skickad')); } catch (e) { toastErr(e); } route(); });
  $$('[data-rqno]').forEach(b => b.onclick = act(async () => { const note = await promptDialog(t('Anledning (valfritt)'), { title: t('Neka önskemålet'), type: 'textarea', maxlength: 300, okLabel: t('Neka') }); if (note === null) return; await api(`/requests/${b.dataset.rqno}/decline`, { method: 'POST', body: { note } }); route(); }));
  $$('[data-rqdel]').forEach(b => b.onclick = act(async () => { await api(`/requests/${b.dataset.rqdel}`, { method: 'DELETE' }); route(); }));
  if (!$('#rqf')) return;
  $('#rqk').value = kind;
  $('#rqk').onchange = () => store.set('reqkind', $('#rqk').value);
  $('#rqq').focus();
  $('#rqf').onsubmit = async (e) => {
    e.preventDefault();
    const k = $('#rqk').value, q = $('#rqq').value.trim(); if (!q) return;
    $('#rqres').innerHTML = loadingState({ kind: 'inline', label: t('Söker…') });
    try {
      const res = await api(`/requests/search?kind=${k}&q=${encodeURIComponent(q)}`);
      $('#rqres').innerHTML = res.map((x, i) => `<div class="mcard">${x.poster ? `<img src="${esc(x.poster)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div style="flex:1"><b>${esc(x.title)}</b> ${x.year ? `<span class="muted">(${x.year})</span>` : ''}${x.streaming?.length ? `<div class="small" style="color:var(--ok)">${t('Finns redan på {v}', { v: esc(x.streaming.join(', ')) })}</div>` : ''}<div class="small muted">${esc(x.overview)}</div></div>
        <div>${x.inLibrary ? `${t('<a class="btn small" href="#/item/{inLibrary}">Finns – titta</a>', { inLibrary: x.inLibrary })}` : x.request ? `<span class="${REQ_STATUS[x.request]?.[1]}">${REQ_STATUS[x.request]?.[0]}</span>` : `<button class="primary small" data-rqadd="${i}">${t('Önska')}</button>`}</div></div>`).join('') || emptyState({ compact: true, title: t('Inga träffar'), text: t('Prova en annan stavning eller originaltiteln.') });
      $$('[data-rqadd]').forEach(b => b.onclick = async () => {
        const x = res[+b.dataset.rqadd]; b.disabled = true;
        try { const r = await api('/requests', { method: 'POST', body: { kind: k, tmdbId: x.id, title: x.title, year: x.year, poster: x.poster, overview: x.overview } });
          b.outerHTML = `<span class="${REQ_STATUS[r.status]?.[1]}">${REQ_STATUS[r.status]?.[0]}</span>`; }
        catch (er) { toastErr(er); b.disabled = false; }
      });
    } catch (er) { if (!er.aborted && $('#rqres')) $('#rqres').innerHTML = errorState(er, { compact: true }); }
  };
};
