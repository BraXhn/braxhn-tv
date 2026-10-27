// Administration av IPTV (betrott nät): källor (M3U-listor och Xtream Codes-konton), gemensamma TV-guider, kanaler
// (namn, nummer, grupp, logotyp, dölj, åldersgräns, guide-id), grupper och kategorier (dölj, åldersgräns för
// barnprofiler, ordning) och inställningar. #/iptvadmin/<flik>
// @lazy – laddas vid behov (LAZY i js/router.js)
import { $, $$, act, api, esc, fmtDate, main, me, toast, toastErr, views } from '../core.js';
import { route } from '../router.js';
import { openDialog, confirmDialog, fieldHtml } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';
import { tabsHtml } from '../ui/tabs.js';
import { chLogo } from '../ui/cards.js';

const TABS = [['sources', 'Källor'], ['guides', 'TV-guider'], ['channels', 'Kanaler'], ['groups', 'Grupper'], ['settings', 'Inställningar']];
const AGES = [['', 'Ingen (som oklassat)'], ['0', 'Alla åldrar'], ['7', '7 år'], ['11', '11 år'], ['15', '15 år'], ['18', '18 år']];
const ageSelect = (v, data, label) => `<select ${data} aria-label="${esc(label)}">${AGES.map(([k, l]) => `<option value="${k}"${String(v ?? '') === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
const ago = (t) => t ? fmtDate(t) : 'aldrig';

views.iptvadmin = async (tab = 'sources') => {
  if (!me.adminHere) { main.innerHTML = emptyState({ icon: '🔒', title: 'Bara för administratörer på hemnätet' }); return; }
  if (!TABS.some(([k]) => k === tab)) tab = 'sources';
  const D = await api('/iptv/admin');
  main.innerHTML = `<div class="toolbar"><h1>IPTV</h1><a class="btn ghost small" href="#/epg">TV-guide</a><a class="btn ghost small" href="#/admin">Administration</a></div>
    ${tabsHtml({ label: 'IPTV-administration', current: tab, items: TABS.map(([k, l]) => ({ key: k, label: l, href: '#/iptvadmin/' + k })) })}<div id="ipane"></div>`;
  const pane = $('#ipane');
  if (tab === 'sources') sources(pane, D);
  else if (tab === 'guides') guides(pane, D);
  else if (tab === 'channels') channels(pane, D);
  else if (tab === 'groups') groups(pane, D);
  else settings(pane, D);
};

// ---------- källor ----------
function sources(pane, D) {
  const acct = (a) => a ? `Konto: ${esc(a.status)}${a.exp ? ' · gäller till ' + new Date(a.exp * 1000).toLocaleDateString('sv-SE') : ''}${a.maxConnections ? ` · ${a.maxConnections} anslutningar` : ''}${a.trial ? ' · provkonto' : ''}` : '';
  pane.innerHTML = `<div class="panel"><h2>Källor</h2>
    <p class="muted small">En <b>M3U-lista</b> (adress eller fil under <code>/config</code>) eller ett <b>Xtream Codes-konto</b> (server, användare, lösenord – ger även filmer och serier). Flera källor kan användas samtidigt: samma kanal i flera källor blir reservström om den första inte går att starta. Listan uppdateras enligt schemat, guiden var ${D.settings.guideHours}:e timme.</p>
    ${D.sources.length ? `<div class="isrc">${D.sources.map(s => `<div class="isrc-row${s.enabled ? '' : ' off'}">
      <div><b>${esc(s.name)}</b> <span class="muted small">${s.type === 'xtream' ? 'Xtream Codes' : 'M3U'}${s.enabled ? '' : ' · avstängd'}</span>
        <div class="muted small">${esc(s.url)}${s.type === 'xtream' ? ' · ' + esc(s.username || '') : ''}</div>
        <div class="small">${s.channels} kanaler${s.hidden ? ` (${s.hidden} dolda)` : ''}${s.catchup ? ` · ${s.catchup} med catch-up` : ''}${s.type === 'xtream' ? ` · ${s.movies} filmer · ${s.series} serier` : ''} · ${D.inUse[s.id] || 0}/${s.connections} anslutningar används</div>
        <div class="muted small">Uppdaterad ${ago(s.lastRefresh)} (var ${s.refreshHours}:e timme)${s.account ? ' · ' + acct(s.account) : ''}${s.epgUrl || s.epgUrls.length || s.m3uEpg.length || s.type === 'xtream' ? ' · guide: ' + esc([s.epgUrl, ...s.epgUrls, ...(s.type === 'xtream' ? ['Xtream'] : []), ...s.m3uEpg.map(u => u + ' (från listan)')].filter(Boolean).join(', ')) : ''}</div>
        ${s.error ? `<div class="err small">${esc(s.error)}</div>` : ''}${s.vodError ? `<div class="err small">Filmer/serier: ${esc(s.vodError)}</div>` : ''}</div>
      <div class="row"><button class="ghost small" data-srf="${s.id}">Uppdatera</button><button class="ghost small" data-sed="${s.id}">Ändra…</button>
        <button class="ghost small" data-son="${s.id}">${s.enabled ? 'Stäng av' : 'Slå på'}</button><button class="danger small" data-sdel="${s.id}">Ta bort</button></div></div>`).join('')}</div>`
    : emptyState({ icon: '📡', title: 'Ingen IPTV-källa ännu', compact: true })}
    <div class="row" style="margin-top:12px"><button class="primary" id="sadd-m3u">+ M3U-lista</button><button class="primary" id="sadd-xt">+ Xtream Codes-konto</button><button class="ghost" id="sguide">Uppdatera TV-guiden nu</button></div>
    ${D.guide.error ? `<p class="err small">TV-guiden: ${esc(D.guide.error)}</p>` : ''}${D.guide.last ? `<p class="muted small">Guiden uppdaterades senast ${fmtDate(D.guide.last)}.</p>` : ''}</div>`;
  $('#sadd-m3u', pane).onclick = () => sourceDialog({ type: 'm3u' });
  $('#sadd-xt', pane).onclick = () => sourceDialog({ type: 'xtream' });
  $('#sguide', pane).onclick = act(async () => { toast('Uppdaterar TV-guiden…'); await api('/live/guide/refresh', { method: 'POST', bg: true }); toast('TV-guiden är uppdaterad'); route(); });
  for (const b of $$('[data-srf]', pane)) b.onclick = act(async () => {
    b.disabled = true; toast('Uppdaterar källan – det kan ta en stund…');
    try { const r = await api(`/iptv/sources/${b.dataset.srf}/refresh`, { method: 'POST', bg: true }); toast(`${r.channels} kanaler${r.vod?.movies != null ? ` · ${r.vod.movies} filmer · ${r.vod.series} serier` : ''}`); route(); }
    finally { b.disabled = false; }
  });
  for (const b of $$('[data-sed]', pane)) b.onclick = () => sourceDialog(D.sources.find(s => s.id === +b.dataset.sed));
  for (const b of $$('[data-son]', pane)) b.onclick = act(async () => { const s = D.sources.find(x => x.id === +b.dataset.son); await api('/iptv/sources/' + s.id, { method: 'PUT', body: { enabled: !s.enabled } }); route(); });
  for (const b of $$('[data-sdel]', pane)) b.onclick = act(async () => {
    const s = D.sources.find(x => x.id === +b.dataset.sdel);
    if (await confirmDialog(`Ta bort ${s.name} och dess kanaler${s.type === 'xtream' ? ', filmer och serier' : ''}?`, { okLabel: 'Ta bort', danger: true })) { await api('/live/tuners/' + s.id, { method: 'DELETE' }); route(); }
  });
}
function sourceDialog(s) {
  const xt = s.type === 'xtream', isNew = !s.id;
  let n = 0;
  const f = (o) => fieldHtml(o, 'sf' + (++n));
  const body = (xt ? f({ name: 'server', label: 'Server', type: 'url', value: s.id ? '' : '', placeholder: s.id ? s.url : 'http://leverantör.example:8080', required: isNew, hint: s.id ? 'Tomt = behåll.' : 'Adressen du fått av leverantören (utan /player_api.php).' })
      + f({ name: 'username', label: 'Användarnamn', value: s.username || '', required: true, autocomplete: 'off' })
      + f({ name: 'password', label: 'Lösenord', type: 'password', autocomplete: 'new-password', required: isNew, hint: s.id ? 'Tomt = behåll det sparade lösenordet.' : '' })
    : f({ name: 'url', label: 'Adress till M3U-listan', value: '', placeholder: s.id ? s.url : 'https://…/lista.m3u eller /config/lista.m3u', required: isNew, hint: s.id ? 'Tomt = behåll.' : '' }))
    + f({ name: 'name', label: 'Namn', value: s.name || '', placeholder: xt ? 'Leverantörens namn' : 'IPTV' })
    + f({ name: 'epgUrl', label: 'TV-guide (XMLTV, valfri)', value: '', placeholder: s.epgUrl || 'https://…/guide.xml.gz', hint: xt ? 'Xtream-serverns egen guide används också.' : 'Listans url-tvg används också.' })
    + f({ name: 'epgUrls', label: 'Fler guider (en per rad)', type: 'textarea', value: '', placeholder: (s.epgUrls || []).join('\n') })
    + `<div class="row">${f({ name: 'connections', label: 'Samtidiga anslutningar', type: 'number', value: s.connections ?? (xt ? '' : 2), hint: xt ? 'Tomt = kontots gräns.' : '' })}
      ${f({ name: 'refreshHours', label: 'Uppdatera listan var … timme', type: 'number', value: s.refreshHours ?? 24 })}</div>`
    + f({ name: 'userAgent', label: 'User-Agent (valfri)', value: s.userAgent || '', placeholder: 'Om leverantören kräver en viss spelare' })
    + f({ name: 'referer', label: 'Referer (valfri)', value: s.referer || '' })
    + `<label class="switch"><input type="checkbox" name="allowLan" ${s.allowLan !== false ? 'checked' : ''}> Strömmar och guider får ligga på hemnätet</label>
       <p class="hint">Av: adresser i listan får bara gå till internet (skydd om listan kommer från någon annan). Adressen du skriver in här är alltid tillåten.</p>
       ${xt ? `<label class="switch"><input type="checkbox" name="vod" ${s.vod !== false ? 'checked' : ''}> Hämta filmer och serier</label>` : ''}`;
  openDialog({ title: isNew ? (xt ? 'Lägg till Xtream Codes-konto' : 'Lägg till M3U-lista') : `Ändra ${s.name}`, form: true, size: 'wide', body,
    actions: [{ label: 'Avbryt' }, { label: isNew ? 'Lägg till' : 'Spara', kind: 'primary', submit: true, onClick: async (h) => {
      const v = Object.fromEntries([...h.el.querySelectorAll('[name]')].map(i => [i.name, i.type === 'checkbox' ? i.checked : i.value.trim()]));
      const body = { type: s.type, name: v.name, userAgent: v.userAgent, referer: v.referer, allowLan: v.allowLan, vod: v.vod,
        connections: v.connections === '' ? undefined : +v.connections, refreshHours: +v.refreshHours || 24 };
      if (v.epgUrl || isNew) body.epgUrl = v.epgUrl;
      if (v.epgUrls) body.epgUrls = v.epgUrls.split('\n').map(x => x.trim()).filter(Boolean);
      if (xt) { if (v.server) body.server = body.url = v.server; body.username = v.username; if (v.password) body.password = v.password; }
      else if (v.url) body.url = v.url;
      if (isNew) { toast('Hämtar listan…'); const r = await api('/iptv/sources', { method: 'POST', body, bg: true }); void r; toast('Källan är tillagd'); }
      else {
        await api('/iptv/sources/' + s.id, { method: 'PUT', body, bg: true });
        toast('Sparat – uppdaterar…');
        api(`/iptv/sources/${s.id}/refresh?vod=0`, { method: 'POST', bg: true }).then(() => { toast('Källan är uppdaterad'); if (location.hash.startsWith('#/iptvadmin')) route(); }, toastErr);
      }
      route();
      return true;
    } }] });
}

// ---------- gemensamma guider ----------
function guides(pane, D) {
  pane.innerHTML = `<div class="panel"><h2>TV-guider för alla källor</h2>
    <p class="muted small">XMLTV-guider (vanliga eller .gz) som gäller alla IPTV-kanaler, i ordning. En kanal tar sina program från första guide som har dem: källans egen guide först, sedan Xtream-serverns och listans, sist de här. Kanaler kopplas på tvg-id, annars på namnet. Tidsförskjutning i timmar om guiden har fel tidszon.</p>
    ${D.guides.length ? `<table>${D.guides.map(g => `<tr><td><b>${esc(g.name)}</b><div class="muted small">${esc(g.url)}</div>${g.error ? `<div class="err small">${esc(g.error)}</div>` : ''}</td>
      <td class="small">${g.lastRefresh ? `${g.channels ?? 0} kanaler · ${g.programs ?? 0} program · ${fmtDate(g.lastRefresh)}` : 'inte hämtad än'}</td>
      <td><label class="small"><input type="checkbox" data-gon="${g.id}" ${g.enabled ? 'checked' : ''}> på</label></td>
      <td><input type="number" step="0.5" min="-24" max="24" value="${g.shift}" data-gsh="${g.id}" aria-label="Tidsförskjutning för ${esc(g.name)}" style="width:80px"></td>
      <td class="r"><button class="danger small" data-gdel="${g.id}">Ta bort</button></td></tr>`).join('')}</table>` : '<p class="muted">Inga gemensamma guider.</p>'}
    <form id="gadd" class="row" style="align-items:flex-end;margin-top:12px"><div style="flex:2;min-width:220px"><label for="gu">Adress</label><input id="gu" required placeholder="https://…/guide.xml.gz eller /config/guide.xml"></div>
      <div><label for="gn">Namn</label><input id="gn" placeholder="t.ex. xmltv.se"></div><button class="primary">Lägg till</button><button type="button" class="ghost" id="grf">Uppdatera guiden nu</button></form></div>`;
  $('#gadd', pane).onsubmit = act(async (e) => { e.preventDefault(); await api('/iptv/guides', { method: 'POST', body: { url: $('#gu').value.trim(), name: $('#gn').value.trim() } }); toast('Tillagd – hämtas vid nästa uppdatering'); route(); });
  $('#grf', pane).onclick = act(async () => { toast('Uppdaterar TV-guiden…'); await api('/live/guide/refresh', { method: 'POST', bg: true }); toast('TV-guiden är uppdaterad'); route(); });
  for (const b of $$('[data-gon]', pane)) b.onchange = act(() => api('/iptv/guides/' + b.dataset.gon, { method: 'PUT', body: { enabled: b.checked } }));
  for (const b of $$('[data-gsh]', pane)) b.onchange = act(() => api('/iptv/guides/' + b.dataset.gsh, { method: 'PUT', body: { shift: +b.value } }));
  for (const b of $$('[data-gdel]', pane)) b.onclick = act(async () => { if (await confirmDialog('Ta bort guiden?', { okLabel: 'Ta bort', danger: true })) { await api('/iptv/guides/' + b.dataset.gdel, { method: 'DELETE' }); route(); } });
}

// ---------- kanaler ----------
async function channels(pane, D) {
  const st = { q: '', group: null, tuner: '', offset: 0 };
  pane.innerHTML = `<div class="panel"><h2>Kanaler</h2>
    <p class="muted small">Ändringar sparas direkt och finns kvar när listan uppdateras. Kanalnumret styr ordningen. Dölj grupper under Grupper. Åldersgräns: barnprofiler ser bara kanaler inom sin gräns (kanalens, annars gruppens).</p>
    <form id="cf" class="row" role="search"><input id="cq" type="search" placeholder="Sök kanal…" aria-label="Sök kanal" style="max-width:240px">
      <select id="cg" aria-label="Grupp"><option value="">Alla grupper</option>${D.groups.map(g => `<option value="${esc(g.name ?? '')}">${esc(g.name || '(utan grupp)')} (${g.count})</option>`).join('')}</select>
      <select id="ct" aria-label="Källa"><option value="">Alla källor</option>${D.sources.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></form>
    <datalist id="cgl">${D.groups.filter(g => g.name).map(g => `<option value="${esc(g.name)}">`).join('')}</datalist>
    <div id="clist"></div><div class="row" style="justify-content:center"><button class="ghost" id="cmore" hidden>Visa fler</button></div></div>`;
  const list = $('#clist', pane);
  const load = async (append = false) => {
    const p = new URLSearchParams({ q: st.q, offset: String(st.offset), limit: '150' });
    if (st.group != null) p.set('group', st.group);
    if (st.tuner) p.set('tuner', st.tuner);
    const r = await api('/iptv/admin/channels?' + p);
    const rows = r.channels.map(c => `<tr data-cid="${c.id}"><td>${chLogo(c, 'small')}</td>
      <td><input value="${esc(c.number ?? '')}" data-f="number" aria-label="Nummer för ${esc(c.name)}" class="inr" placeholder="${esc(c.original.number ?? '')}"></td>
      <td><input value="${esc(c.name)}" data-f="name" aria-label="Namn" placeholder="${esc(c.original.name)}"${c.changed.name ? ' class="changed" title="Listans namn: ' + esc(c.original.name) + '"' : ''}><div class="muted small">${esc(c.tuner)}${c.epgId ? ' · ' + esc(c.epgId) : ' · <span class="warn-badge">ingen guide</span>'}${c.catchup ? ` · ⟲ ${c.catchup} d` : ''}${c.programs ? ` · ${c.programs} program` : ''}</div></td>
      <td><input value="${esc(c.group ?? '')}" data-f="group" list="cgl" aria-label="Grupp" placeholder="${esc(c.original.group ?? '')}"></td>
      <td>${ageSelect(c.age, 'data-f="age"', 'Åldersgräns')}${c.age == null && c.effectiveAge != null ? `<div class="muted small">gruppen: ${c.effectiveAge}</div>` : ''}</td>
      <td><label class="small"><input type="checkbox" data-f="hidden" ${c.hidden ? 'checked' : ''}${c.groupHidden ? ' disabled title="Gruppen är dold"' : ''}> dold</label></td>
      <td class="r"><button class="ghost small" data-more="${c.id}" aria-label="Mer för ${esc(c.name)}">…</button></td></tr>`).join('');
    if (!append) list.innerHTML = r.channels.length ? `<div class="tscroll"><table class="ichan"><thead><tr><th></th><th>Nr</th><th>Namn</th><th>Grupp</th><th>Ålder</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted small">${r.total} kanaler</p>` : '<p class="muted">Inga kanaler.</p>';
    else $('tbody', list).insertAdjacentHTML('beforeend', rows);
    $('#cmore', pane).hidden = st.offset + r.channels.length >= r.total;
    st.data = append ? [...st.data, ...r.channels] : r.channels;
  };
  list.addEventListener('change', act(async (e) => {
    const i = e.target.closest('[data-f]'), tr = e.target.closest('[data-cid]'); if (!i || !tr) return;
    const f = i.dataset.f, v = i.type === 'checkbox' ? i.checked : f === 'age' ? (i.value === '' ? null : +i.value) : i.value;
    await api('/iptv/admin/channels/' + tr.dataset.cid, { method: 'PUT', body: { [f]: v } });
    i.classList.add('saved'); setTimeout(() => i.classList.remove('saved'), 900);
  }));
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-more]'); if (!b) return;
    const c = st.data.find(x => x.id === +b.dataset.more); if (!c) return;
    openDialog({ title: c.name, form: true, body: fieldHtml({ name: 'logo', label: 'Logotyp (adress)', type: 'url', value: c.logoUrl || '', hint: 'Tomt = listans logotyp.' }, 'cl1')
        + fieldHtml({ name: 'epgId', label: 'Kanalens id i TV-guiden (tvg-id)', value: c.epgId || '', hint: 'Tomt = koppla automatiskt på namnet.' }, 'cl2')
        + `<p class="muted small">Listans värden: ${esc(c.original.number ?? '–')} · ${esc(c.original.name)} · ${esc(c.original.group ?? '–')}</p>`,
      actions: [{ label: 'Avbryt' }, { label: 'Återställ allt', kind: 'ghost', onClick: async () => { await api('/iptv/admin/channels/' + c.id, { method: 'PUT', body: { name: null, number: null, group: null, logo: '', age: null } }); toast('Återställd'); load(); return true; } },
        { label: 'Spara', kind: 'primary', submit: true, onClick: async (h) => { await api('/iptv/admin/channels/' + c.id, { method: 'PUT', body: { logo: h.$('#cl1').value.trim(), epgId: h.$('#cl2').value.trim() } }); toast('Sparat – uppdatera guiden för att koppla om'); load(); return true; } }] });
  });
  let t = 0;
  $('#cq', pane).oninput = () => { clearTimeout(t); t = setTimeout(() => { st.q = $('#cq').value.trim(); st.offset = 0; load().catch(toastErr); }, 250); };
  $('#cf', pane).onsubmit = (e) => e.preventDefault();
  $('#cg', pane).onchange = () => { const o = $('#cg').selectedOptions[0]; st.group = $('#cg').selectedIndex === 0 ? null : o.value; st.offset = 0; load().catch(toastErr); };
  $('#ct', pane).onchange = () => { st.tuner = $('#ct').value; st.offset = 0; load().catch(toastErr); };
  $('#cmore', pane).onclick = act(async () => { st.offset += 150; await load(true); });
  await load();
}

// ---------- grupper ----------
function groups(pane, D) {
  const kinds = [['live', 'Kanalgrupper', D.groups], ['movie', 'Filmkategorier', D.movieGroups], ['series', 'Seriekategorier', D.seriesGroups]].filter(([k, , l]) => k === 'live' || l.length);
  pane.innerHTML = kinds.map(([k, title, l]) => `<div class="panel"><h2>${title}</h2>
    <p class="muted small">${k === 'live' ? 'Dolda grupper syns inte för någon (inte heller i apparna). ' : ''}Åldersgräns: barnprofiler ser bara ${k === 'live' ? 'kanaler' : 'titlar'} i grupper med en gräns inom profilens${k === 'live' ? ' (eller kanalens egen)' : ''}. Grupper med vuxeninnehåll i namnet får 18 automatiskt. Pilarna ändrar ordningen.</p>
    ${l.length ? `<table data-kind="${k}">${l.map((g, i) => `<tr data-g="${esc(g.name ?? '')}"><td><b>${esc(g.name || '(utan grupp)')}</b> <span class="muted small">${g.count}</span>${g.auto ? ' <span class="warn-badge">18 automatiskt</span>' : ''}</td>
      <td>${g.name ? `<label class="small"><input type="checkbox" data-gh ${g.hidden ? 'checked' : ''}> dold</label>` : ''}</td>
      <td>${g.name ? ageSelect(g.age, 'data-ga', 'Åldersgräns för ' + (g.name || '')) : ''}</td>
      <td class="r">${g.name ? `<button class="ghost small" data-up ${i ? '' : 'disabled'} aria-label="Flytta upp">↑</button><button class="ghost small" data-down ${i < l.length - 1 ? '' : 'disabled'} aria-label="Flytta ner">↓</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted">Inga grupper.</p>'}</div>`).join('');
  pane.addEventListener('change', act(async (e) => {
    const tr = e.target.closest('[data-g]'), kind = e.target.closest('[data-kind]')?.dataset.kind; if (!tr || !kind) return;
    const body = { kind, name: tr.dataset.g };
    if (e.target.matches('[data-gh]')) body.hidden = e.target.checked;
    else if (e.target.matches('[data-ga]')) body.age = e.target.value === '' ? null : +e.target.value;
    else return;
    await api('/iptv/admin/groups', { method: 'PUT', body });
    toast('Sparat');
  }));
  pane.addEventListener('click', act(async (e) => {
    const b = e.target.closest('[data-up],[data-down]'); if (!b) return;
    const table = b.closest('[data-kind]'), tr = b.closest('[data-g]');
    const rows = [...table.querySelectorAll('[data-g]')];
    const i = rows.indexOf(tr), j = b.matches('[data-up]') ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) return;
    if (j < i) rows[j].before(tr); else rows[j].after(tr);
    const order = [...table.querySelectorAll('[data-g]')].map(r => r.dataset.g).filter(Boolean);
    await api('/iptv/admin/groups', { method: 'PUT', body: { kind: table.dataset.kind, order } });
    for (const [k, r] of [...table.querySelectorAll('[data-g]')].entries()) { const u = r.querySelector('[data-up]'), d = r.querySelector('[data-down]'); if (u) u.disabled = k === 0; if (d) d.disabled = k === rows.length - 1; }
    b.focus();
  }));
}

// ---------- inställningar ----------
function settings(pane, D) {
  pane.innerHTML = `<div class="panel"><h2>Inställningar</h2>
    <form id="isf"><div class="row" style="align-items:flex-end"><div><label for="igh">Uppdatera TV-guiden var … timme</label><input id="igh" type="number" min="1" max="168" value="${D.settings.guideHours}" style="width:100px"></div></div>
    <label class="switch"><input type="checkbox" id="ips" ${D.settings.prestart ? 'checked' : ''}> Snabbt kanalbyte: starta nästa kanal i förväg när källan har en ledig anslutning</label>
    <button class="primary" style="margin-top:12px">Spara</button></form>
    <p class="muted small">Barnprofiler ser kanaler och filmer med en åldersgräns inom profilens. Kanaler utan gräns visas för barn bara om <i>oklassat innehåll</i> är tillåtet (Administration → Användare) – just nu: <b>${D.settings.allowUnrated ? 'tillåtet' : 'inte tillåtet'}</b>.</p>
    <p class="muted small">Omkodning, timeshift och inspelningar ställs in under Administration → Live-TV och inspelning. Live-TV kopieras utan omkodning när kanalen redan sänder H.264 (det klarar alla webbläsare och appar), annars kodas den om – med GPU när <code>HWACCEL</code> är satt.</p></div>`;
  $('#isf', pane).onsubmit = act(async (e) => { e.preventDefault(); await api('/iptv/settings', { method: 'PUT', body: { guideHours: +$('#igh').value, prestart: $('#ips').checked } }); toast('Sparat'); });
}
