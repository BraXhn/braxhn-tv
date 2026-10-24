// Vyer: Min historik (#/history, alla profiler – bara de egna raderna) och Tittarstatistik (#/playstats, administratören):
// historik med filter, topplistor, fördelning per dag/veckodag/timme, samtidiga strömmar och bandbredd (SVG utan
// beroenden) och export till CSV.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, fmtDur, main, me, toast, views, libs } from '../core.js';
import { confirmDialog } from '../ui/dialog.js';
import { emptyState, errorState, bindRetry, loadingState } from '../ui/states.js';
import { tabsHtml, bindTabs } from '../ui/tabs.js';
import { iconButton } from '../ui/buttons.js';

const MODE = { direct: 'Direkt', remux: 'Remux', transcode: 'Omkodning' };
const PERIODS = [['7', '7 dagar'], ['30', '30 dagar'], ['90', '3 månader'], ['365', '1 år'], ['0', 'Allt']];
const WEEKDAYS = ['mån', 'tis', 'ons', 'tor', 'fre', 'lör', 'sön'];
const hours = (s) => (s / 3600).toLocaleString('sv-SE', { maximumFractionDigits: s < 36000 ? 1 : 0 });
const mbit = (k) => k >= 1000 ? (k / 1000).toLocaleString('sv-SE', { maximumFractionDigits: 1 }) + ' Mbit/s' : Math.round(k) + ' kbit/s';
const qs = (f) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== '' && v != null) p.set(k, v); return p.toString(); };
const quality = (r) => r.quality && r.quality !== 'orig' ? r.quality + 'p' : r.quality === 'orig' ? 'original' : '';

// ---------- SVG-diagram ----------
/**
 * Stapeldiagram i SVG (en serie, accentfärgen). Varje stapel har ett verktygstips (title) och ett träffområde i full
 * höjd; etiketter under var n:e stapel. Skalas med bredden (viewBox), aria-label beskriver diagrammet.
 */
export function barChart(list, { val, label, tip, every = 1, name, h = 150, w = 720 }) {
  if (!list.length) return '<p class="muted small">Inga uppspelningar under perioden.</p>';
  const n = list.length, W = w, top = 16, base = h - 22, bw = W / n;
  const max = Math.max(1, ...list.map(val));
  const bars = list.map((d, i) => {
    const v = val(d), x = i * bw + 1, w = Math.max(1, bw - 2), bh = v ? Math.max(2, v / max * (base - top)) : 0, y = base - bh;
    const r = Math.min(4, w / 2, bh);
    const shape = bh ? `<path class="ch-bar" d="M${x},${base}V${y + r}q0,-${r} ${r},-${r}h${w - 2 * r}q${r},0 ${r},${r}V${base}Z"/>` : '';
    const lab = i % every === 0 ? `<text class="ch-lab" x="${x + w / 2}" y="${h - 6}" text-anchor="middle">${esc(label(d, i))}</text>` : '';
    return `<g class="ch-g"><rect class="ch-hit" x="${i * bw}" y="0" width="${bw}" height="${base}"><title>${esc(tip(d))}</title></rect>${shape}${lab}</g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(name)}" preserveAspectRatio="xMidYMid meet">
    <line class="ch-base" x1="0" x2="${W}" y1="${base + 0.5}" y2="${base + 0.5}"/><text class="ch-lab" x="2" y="11">${esc(tip.max ? tip.max(max) : String(max))}</text>${bars}</svg>`;
}
const dayLabel = (d) => d.slice(8, 10) === '01' || d.length < 10 ? d.slice(5) : d.slice(8);

// ---------- historiktabell ----------
function rowsHtml(rows, { admin, canDelete }) {
  return rows.map(r => `<tr data-hid="${r.id}">
    <td class="muted small nowrap">${fmtDate(r.ts)}</td>
    ${admin ? `<td><button class="linkbtn" data-fuser="${r.userId}" data-name="${esc(r.user)}">${esc(r.user)}</button></td>` : ''}
    <td>${r.exists ? `<a href="#/item/${r.showId || r.itemId}">${esc(r.title)}</a>` : `${esc(r.title)} <span class="muted small">(borttagen)</span>`}
      <div class="prog" style="max-width:220px" title="${r.percent ?? 0} %"><i style="width:${r.percent ?? 0}%"></i></div></td>
    <td class="muted small">${r.played ? fmtDur(r.played) : '–'}${r.percent != null ? ` · ${r.percent} %` : ''}</td>
    <td class="muted small">${esc(r.device || '')}${r.remote ? ' · utifrån' : ''}${admin && r.ip ? `<div>${esc(r.ip)}</div>` : ''}</td>
    <td class="muted small">${esc(MODE[r.mode] || r.mode || '')}${quality(r) ? ' · ' + esc(quality(r)) : ''}${r.kbps ? `<div>${esc(mbit(r.kbps))}</div>` : ''}</td>
    ${canDelete ? `<td class="r">${iconButton({ icon: '✕', label: `Ta bort ${r.title} ${fmtDate(r.ts)} ur historiken`, data: { del: r.id } })}</td>` : ''}</tr>`).join('');
}
const tableHead = ({ admin, canDelete }) => `<thead><tr><th>Datum</th>${admin ? '<th>Profil</th>' : ''}<th>Titel</th><th>Sett</th><th>Enhet</th><th>Uppspelning</th>${canDelete ? '<th class="r"><span class="sr-only">Ta bort</span></th>' : ''}</tr></thead>`;

/** Historiklista med "Visa fler" och ta bort. base = API-sökvägen, f = filter, onChange = efter borttagning */
function historyList(box, base, f, { admin, canDelete: allowDel = true } = {}) {
  let offset = 0, canDelete = allowDel;
  const load = async (more) => {
    if (!more) { offset = 0; box.innerHTML = loadingState({ kind: 'inline' }); }
    try {
      const H = await api(`${base}?${qs({ ...f, limit: 50, offset })}`);
      if (H.canDelete === false) canDelete = false;
      if (!more) {
        if (!H.rows.length) { box.innerHTML = emptyState({ compact: true, icon: '🕘', title: 'Ingen historik', text: f.q ? 'Inget matchar sökningen.' : 'Det du tittar på visas här.' }); return; }
        box.innerHTML = `<p class="muted small" id="hsum"></p><div class="tablewrap"><table class="hist">${tableHead({ admin, canDelete })}<tbody></tbody></table></div><div class="row"><button class="ghost small" id="hmore" hidden>Visa fler</button></div>`;
      }
      $('#hsum', box).textContent = `${H.total.toLocaleString('sv-SE')} uppspelningar · ${hours(H.played)} timmar sett`;
      $('tbody', box).insertAdjacentHTML('beforeend', rowsHtml(H.rows, { admin, canDelete }));
      offset += H.rows.length;
      $('#hmore', box).hidden = offset >= H.total;
    } catch (e) { if (e.aborted) return; box.innerHTML = errorState(e, { retry: true, compact: true }); bindRetry(box, () => load(false)); }
  };
  box.onclick = act(async (e) => {
    if (e.target.closest('#hmore')) return load(true);
    const del = e.target.closest('[data-del]');
    if (!del) return;
    if (!await confirmDialog('Raden tas bort ur historiken och statistiken. Det går inte att ångra.', { title: 'Ta bort ur historiken?', okLabel: 'Ta bort', danger: true })) return;
    await api(`${base.replace(/\.csv$/, '')}/${del.dataset.del}`, { method: 'DELETE' });
    const tr = del.closest('tr'), next = tr.nextElementSibling?.querySelector('button, a') || tr.previousElementSibling?.querySelector('button, a');
    tr.remove(); next?.focus(); toast('Borttagen ur historiken');
  });
  load(false);
}

function filterBar(F, { admin, users = [] }) {
  const sel = (id, label, opts, v) => `<div><label for="${id}">${label}</label><select id="${id}">${opts.map(([k, t]) => `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
  const videoLibs = libs.filter(l => l.type === 'movie' || l.type === 'show');
  return `<div class="row filters" role="search">
    <div style="flex:1;min-width:180px"><label for="fq">Sök</label><input id="fq" type="search" value="${esc(F.q || '')}" placeholder="${admin ? 'Titel, serie, profil eller enhet' : 'Titel eller serie'}" maxlength="100"></div>
    ${sel('fdays', 'Period', [...PERIODS, ['custom', 'Egna datum']], F.from || F.to ? 'custom' : F.days)}
    <div class="fdates" ${F.from || F.to ? '' : 'hidden'}><label for="ffrom">Från</label><input id="ffrom" type="date" value="${esc(F.from || '')}"></div>
    <div class="fdates" ${F.from || F.to ? '' : 'hidden'}><label for="fto">Till</label><input id="fto" type="date" value="${esc(F.to || '')}"></div>
    ${sel('fkind', 'Typ', [['', 'Filmer och serier'], ['movie', 'Filmer'], ['episode', 'Avsnitt']], F.kind)}
    ${admin ? sel('fuser', 'Profil', [['', 'Alla'], ...users.map(u => [u.id, u.name])], F.user) : ''}
    ${admin && videoLibs.length > 1 ? sel('flib', 'Bibliotek', [['', 'Alla'], ...videoLibs.map(l => [l.id, l.name])], F.library) : ''}
    ${admin ? sel('fmode', 'Uppspelning', [['', 'Alla'], ['direct', 'Direkt'], ['remux', 'Remux'], ['transcode', 'Omkodning']], F.mode) : ''}
    ${admin ? sel('fremote', 'Plats', [['', 'Alla'], ['0', 'Hemma'], ['1', 'Utifrån']], F.remote) : ''}
  </div>`;
}
function bindFilters(F, onChange) {
  let t = null;
  const read = () => {
    const d = $('#fdays').value;
    $$('.fdates').forEach(x => { x.hidden = d !== 'custom'; });
    Object.assign(F, { q: $('#fq').value.trim(), kind: $('#fkind').value, days: d === 'custom' ? '' : d, from: d === 'custom' ? $('#ffrom').value : '', to: d === 'custom' ? $('#fto').value : '' });
    for (const [id, k] of [['#fuser', 'user'], ['#flib', 'library'], ['#fmode', 'mode'], ['#fremote', 'remote']]) if ($(id)) F[k] = $(id).value;
    onChange();
  };
  $('#fq').oninput = () => { clearTimeout(t); t = setTimeout(read, 300); };
  for (const el of $$('.filters select, .filters input[type=date]')) el.onchange = read;
}

// ---------- Min historik ----------
views.history = async () => {
  const F = { days: '0', q: '', kind: '' };
  main.innerHTML = `<div class="toolbar"><h1>Min historik</h1><a class="btn small" id="hcsv" href="#">Ladda ner (CSV)</a></div>
    <div class="panel"><p class="muted small">Det du har tittat på, med datum. ${me.kid ? '' : 'Du kan ta bort enskilda rader – de försvinner då även ur statistiken.'}</p>
    ${filterBar(F, { admin: false })}<div id="hlist"></div></div>`;
  const reload = () => { $('#hcsv').href = '/api/history.csv?' + qs(F); historyList($('#hlist'), '/history', F, { admin: false }); };
  bindFilters(F, reload);
  reload();
};

// ---------- Tittarstatistik (administratör) ----------
views.playstats = async () => {
  if (!me.adminHere) { location.hash = '#/history'; return; }
  const users = await api('/users').catch(() => []);
  const F = { days: '30', q: '', kind: '', user: '', library: '', mode: '', remote: '', item: '' };
  let tab = 'overview', itemName = '';
  main.innerHTML = `<div id="psroot"><div class="toolbar"><h1>Tittarstatistik</h1><a class="btn small" href="#/stats">Spelas nu och säkerhetskopior</a><a class="btn small" href="#/webhooks/server">Webhooks</a></div>
    <div class="panel">${filterBar(F, { admin: true, users })}<div id="fitem" class="row" hidden></div></div>
    <div id="tiles" class="tiles"></div>
    ${tabsHtml({ id: 'pstabs', label: 'Statistik', panel: 'pspanel', current: tab, items: [{ key: 'overview', label: 'Topplistor' }, { key: 'graphs', label: 'Grafer' }, { key: 'history', label: 'Historik' }] })}
    <div id="pspanel" role="tabpanel"></div>
    <div class="panel"><h2>Hur länge historiken sparas</h2><div class="row" style="align-items:flex-end">
      <div><label for="hdays">Spara</label><select id="hdays">${[[90, '3 månader'], [180, '6 månader'], [365, '1 år'], [730, '2 år'], [1825, '5 år'], [0, 'För alltid']].map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></div>
      <button class="ghost small" id="hsave">Spara</button></div><p class="muted small">Äldre uppspelningar tas bort en gång per dygn. Årssammanfattningen bygger på samma historik.</p></div></div>`;
  let O = null, seq = 0;
  const tiles = (T) => `<div class="tile"><b>${T.plays.toLocaleString('sv-SE')}</b><span>uppspelningar</span></div><div class="tile"><b>${hours(T.played)} h</b><span>sett</span></div>
    <div class="tile"><b>${T.users}</b><span>profiler</span></div><div class="tile"><b>${T.titles}</b><span>titlar</span></div>
    <div class="tile"><b>${T.plays ? Math.round(T.transcodes / T.plays * 100) : 0} %</b><span>omkodade</span></div><div class="tile"><b>${T.plays ? Math.round(T.remote / T.plays * 100) : 0} %</b><span>utifrån</span></div>`;
  const list = (rows, fmt, empty = '–') => rows.length ? `<table>${rows.map(fmt).join('')}</table>` : `<p class="muted">${empty}</p>`;
  const render = () => {
    const P = $('#pspanel'); if (!P || !O) return;
    if (tab === 'history') {
      P.innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between"><h2>Historik</h2><a class="btn small" href="/api/playstats/history.csv?${esc(qs(F))}">Ladda ner (CSV)</a></div><div id="hlist"></div></div>`;
      historyList($('#hlist', P), '/playstats/history', F, { admin: true });
      return;
    }
    if (tab === 'graphs') {
      const C = O.concurrency, step = C.step;
      const ct = (b) => step === 3600 ? new Date(b.t * 1000).toLocaleString('sv-SE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : new Date(b.t * 1000).toLocaleDateString('sv-SE');
      const cl = (b, i) => step === 3600 ? String(new Date(b.t * 1000).getHours()).padStart(2, '0') : new Date(b.t * 1000).toLocaleDateString('sv-SE').slice(5);
      const every = (n, want) => Math.max(1, Math.ceil(n / want));
      P.innerHTML = `<div class="panel"><h2>Uppspelningar per dag</h2>${barChart(O.byDay, { name: 'Uppspelningar per dag', val: d => d.n, label: d => dayLabel(d.day), every: every(O.byDay.length, 15), tip: d => `${d.day}: ${d.n} uppspelningar, ${hours(d.played)} h` })}</div>
        <div class="grid2"><div class="panel"><h2>Per veckodag</h2>${barChart(O.weekday.map((d, i) => ({ ...d, name: WEEKDAYS[i] })), { name: 'Uppspelningar per veckodag', w: 360, val: d => d.n, label: d => d.name, tip: d => `${d.name}: ${d.n} uppspelningar, ${hours(d.played)} h` })}</div>
        <div class="panel"><h2>Per timme (start)</h2>${barChart(O.hour, { name: 'Uppspelningar per timme', w: 360, val: d => d.n, label: d => String(d.key).padStart(2, '0'), every: 3, tip: d => `kl. ${String(d.key).padStart(2, '0')}: ${d.n} uppspelningar` })}</div></div>
        <div class="panel"><h2>Samtidiga strömmar</h2><p class="muted small">Flest samtidiga uppspelningar ${step === 3600 ? 'per timme' : 'per dygn'}.</p>
          ${barChart(C.buckets, { name: 'Samtidiga strömmar över tid', val: b => b.peak, label: cl, every: every(C.buckets.length, 12), tip: b => `${ct(b)}: högst ${b.peak} samtidigt` })}</div>
        <div class="panel"><h2>Bandbredd</h2><p class="muted small">Uppskattad ur bithastigheten (omkodningens steg eller filens genomsnitt), genomsnitt ${step === 3600 ? 'per timme' : 'per dygn'}. Högst ${esc(mbit(Math.max(0, ...C.buckets.map(b => b.peakKbps))))} samtidigt.</p>
          ${barChart(C.buckets, { name: 'Bandbredd över tid', val: b => b.kbps, label: cl, every: every(C.buckets.length, 12), tip: Object.assign((b) => `${ct(b)}: i snitt ${mbit(b.kbps)}, högst ${mbit(b.peakKbps)}`, { max: (m) => mbit(m) }) })}</div>`;
      return;
    }
    const pct = (n) => O.totals.plays ? Math.round(n / O.totals.plays * 100) + ' %' : '';
    P.innerHTML = `<div class="grid2">
      <div class="panel"><h2>Mest sett</h2>${list(O.top, (t, i) => `<tr><td class="muted">${i + 1}</td><td><button class="linkbtn" data-fitem="${t.id}" data-name="${esc(t.title)}">${esc(t.title)}</button></td><td class="r muted small">${t.plays} ggr · ${t.viewers} pers · ${hours(t.played)} h</td></tr>`)}</div>
      <div class="panel"><h2>Mest aktiva profiler</h2>${list(O.users, u => `<tr><td><button class="linkbtn" data-fuser="${u.id}">${esc(u.name)}</button></td><td class="r muted small">${u.plays} uppspelningar · ${hours(u.played)} h · senast ${fmtDate(u.last)}</td></tr>`)}</div>
      <div class="panel"><h2>Plattformar</h2>${list(O.platforms, d => `<tr><td>${esc(d.key)}</td><td class="r muted small">${d.n} · ${pct(d.n)}</td></tr>`)}</div>
      <div class="panel"><h2>Uppspelningsläge</h2>${list(O.modes, d => `<tr><td>${esc(MODE[d.key] || d.key)}</td><td class="r muted small">${d.n} · ${pct(d.n)}</td></tr>`)}<p class="muted small">Remux och direktuppspelning belastar servern minst.</p></div>
      <div class="panel"><h2>Bibliotek</h2>${list(O.libraries, d => `<tr><td>${esc(d.key)}</td><td class="r muted small">${d.n} · ${hours(d.played)} h</td></tr>`)}</div>
      <div class="panel"><h2>Hemma och utifrån</h2>${list(O.location, d => `<tr><td>${d.key === 'remote' ? 'Utifrån' : 'Hemma'}</td><td class="r muted small">${d.n} · ${pct(d.n)}</td></tr>`)}</div></div>`;
  };
  const load = async () => {
    const my = ++seq;
    $('#tiles').innerHTML = loadingState({ kind: 'inline' });
    const fi = $('#fitem');
    fi.hidden = !F.item;
    if (F.item) { fi.innerHTML = `<span class="muted small">Bara titeln <b>${esc(itemName)}</b></span>${iconButton({ icon: '✕', label: 'Visa alla titlar', id: 'fitemx' })}`; $('#fitemx').onclick = () => { F.item = ''; load(); }; }
    try {
      const R = await api('/playstats?' + qs(F));
      if (my !== seq) return;
      O = R;
      $('#tiles').innerHTML = tiles(O.totals);
      $('#hdays').value = String(O.historyDays);
      render();
    } catch (e) { if (e.aborted) return; $('#tiles').innerHTML = errorState(e, { retry: true, compact: true }); bindRetry($('#tiles'), load); }
  };
  bindFilters(F, load);
  bindTabs($('#pstabs'), (k) => { tab = k; render(); });
  $('#psroot').addEventListener('click', (e) => {
    const u = e.target.closest('[data-fuser]'), it = e.target.closest('[data-fitem]');
    if (u) { F.user = u.dataset.fuser; if ($('#fuser')) $('#fuser').value = F.user; load(); }
    else if (it) { F.item = it.dataset.fitem; itemName = it.dataset.name; load(); }
  });
  $('#hsave').onclick = act(async () => { const r = await api('/playstats/settings', { method: 'PUT', body: { historyDays: +$('#hdays').value } }); toast(r.removed ? `Sparat – ${r.removed} äldre rader togs bort` : 'Sparat'); });
  load();
};
