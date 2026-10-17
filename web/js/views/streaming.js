// Vyer: strömmande tjänster och var en titel finns att se
import { $, $$, act, api, esc, main, me, store, toast, views } from '../core.js';
import { route } from '../router.js';
import { REQ_STATUS } from './requests.js';

// ---------- streamingtjänster ----------
const provLinks = (list) => list.map(p => `<a class="prov${p.mine ? ' mine' : ''}" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="Öppna i ${esc(p.name)}">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}<span>${esc(p.name)}</span></a>`).join('');
const provBlock = (w) => {
  if (!w) return '';
  const sub = [...w.flatrate, ...w.free], pay = [...w.rent, ...w.buy.filter(b => !w.rent.some(r => r.id === b.id))];
  if (!sub.length && !pay.length) return '';
  return `${sub.length ? `<div class="provrow"><span class="muted small">Ingår i</span>${provLinks(sub)}</div>` : ''}${pay.length ? `<div class="provrow"><span class="muted small">Hyr/köp</span>${provLinks(pay.slice(0, 6))}</div>` : ''}
    <div class="muted small" style="margin-top:4px">Uppgifter från JustWatch via TMDB. Öppnas i tjänstens app eller webbplats.</div>`;
};
export async function fillWatch() {
  const el = $('[data-wid]'); if (!el) return;
  const w = await api(`/items/${el.dataset.wid}/watch`).catch(() => null);
  const html = provBlock(w);
  if (html && el.isConnected) el.innerHTML = `<h3 style="font-size:15px;margin:14px 0 6px">Finns även på</h3>${html}`;
}
views.streaming = async () => {
  if (me.kid) { location.hash = '#/'; return; }
  const P_ = await api('/streaming/providers').catch(e => { if (e.aborted) throw e; return { error: e.message }; });
  if (P_.error) { main.innerHTML = `<div class="empty"><p>${esc(P_.error)}</p></div>`; return; }
  const kind = store.get('stkind', 'movie');
  const sel = (store.get('stprov', '') || P_.mine.join(',')).split(',').map(Number).filter(Boolean);
  const shown = P_.all.filter(p => P_.mine.includes(p.id) || sel.includes(p.id));
  main.innerHTML = `<div class="toolbar"><h1>Strömmande</h1><span class="muted">Det som finns på era tjänster just nu</span>
      <select id="stk" style="margin-left:auto"><option value="movie">Filmer</option><option value="show">Serier</option></select>${me.adminHere ? '<button class="ghost" id="stmine">Välj era tjänster</button>' : ''}</div>
    ${P_.mine.length ? `<div class="provrow" id="stchips">${shown.map(p => `<button class="prov chip${sel.includes(p.id) ? ' mine' : ''}" data-pv="${p.id}">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}<span>${esc(p.name)}</span></button>`).join('')}</div>
      <div class="grid" id="stgrid" style="margin-top:16px"><div class="spin"></div></div><div class="row" style="justify-content:center;margin:16px 0"><button class="ghost" id="stmore" hidden>Visa fler</button></div>`
    : `<div class="empty"><p>${me.adminHere ? 'Välj vilka tjänster ni har (t.ex. Prime Video och TV4 Play) så visas deras utbud här.' : 'En administratör behöver välja vilka tjänster ni har.'}</p></div>`}
    <p class="muted small">BraXhn TV kan inte spela upp innehåll från tjänsterna (de är kopieringsskyddade) – ett klick öppnar titeln i tjänstens egen app eller webbplats.</p>`;
  $('#stk').value = kind;
  $('#stk').onchange = (e) => { store.set('stkind', e.target.value); route(); };
  if ($('#stmine')) $('#stmine').onclick = () => {
    const d = document.createElement('dialog'); d.className = 'wide';
    d.innerHTML = `<h2>Era streamingtjänster</h2><div class="provpick">${P_.all.map(p => `<label class="prov"><input type="checkbox" value="${p.id}" ${P_.mine.includes(p.id) ? 'checked' : ''}>${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}<span>${esc(p.name)}</span></label>`).join('')}</div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="ghost" id="pc">Avbryt</button><button class="primary" id="ps">Spara</button></div>`;
    document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
    $('#pc', d).onclick = () => { d.close(); d.remove(); };
    $('#ps', d).onclick = act(async () => { const ids = $$('input:checked', d).map(i => +i.value); await api('/streaming/mine', { method: 'PUT', body: { ids } }); store.set('stprov', ''); d.close(); d.remove(); route(); });
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
    if (from === 0) grid.innerHTML = html || '<p class="muted">Inget hittades.</p>';
    else grid.insertAdjacentHTML('beforeend', html);
    more.hidden = page >= r.pages;
    $$('[data-st]', grid).slice(from).forEach(a => a.onclick = (e) => { e.preventDefault(); streamDialog(results[+a.dataset.st]); });
  };
  $('#stmore').onclick = act(async () => {
    const b = $('#stmore'); if (!b || b.disabled) return;
    b.disabled = true; page++;
    try { await load(); } catch (e) { page--; throw e; } finally { b.disabled = false; }
  });
  load().catch(e => { if (!e.aborted && $('#stgrid')) $('#stgrid').innerHTML = `<p class="err">${esc(e.message)}</p>`; });
};
async function streamDialog(x) {
  const d = document.createElement('dialog');
  d.innerHTML = `<div class="row" style="align-items:flex-start;gap:16px;flex-wrap:nowrap">${x.poster ? `<img src="${esc(x.poster)}" alt="" style="width:110px;border-radius:8px">` : ''}
    <div><h2 style="margin-top:0">${esc(x.title)} ${x.year ? `<span class="muted">(${x.year})</span>` : ''}</h2><p class="small">${esc(x.overview || '')}</p></div></div>
    <div id="sdp"><div class="spin"></div></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px">${x.inLibrary ? `<a class="btn primary" href="#/item/${x.inLibrary}">▶ Finns hemma – spela</a>` : '<button class="ghost" id="sdr">Önska till biblioteket</button>'}<button class="ghost" id="sdx">Stäng</button></div>`;
  document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
  const close = () => { d.close(); d.remove(); };
  $('#sdx', d).onclick = close;
  $$('a[href^="#/"]', d).forEach(a => a.addEventListener('click', close));
  if ($('#sdr', d)) $('#sdr', d).onclick = async () => { try { const r = await api('/requests', { method: 'POST', body: { kind: x.kind, tmdbId: x.id, title: x.title, year: x.year, poster: x.poster, overview: x.overview } }); toast(REQ_STATUS[r.status]?.[0] || 'Önskad'); close(); } catch (e) { toast(e.message); } };
  const w = await api(`/streaming/title/${x.kind}/${x.id}?title=${encodeURIComponent(x.title)}`).catch(() => null);
  if ($('#sdp', d)) $('#sdp', d).innerHTML = provBlock(w) || '<p class="muted small">Inga tjänster hittades.</p>';
}
