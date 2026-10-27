// Hälsokontroll av biblioteket (administratör på betrott nät): trasiga och avkortade filer, avkodningsfel, ljud ur synk,
// felmärkta språk, låg kvalitet, dubbletter, saknade avsnitt och hög bithastighet (server/health.js). Åtgärder per fynd:
// be Radarr/Sonarr om en ny version (ev. spärra den nuvarande), rätta språkmärkningen (filen ändras inte) och ignorera.
// #/health/<flik>; biblioteksfiltret sparas per webbläsare (store).
// @lazy – laddas vid behov (LAZY i js/router.js)
import { $, act, api, esc, fmtDate, later, main, me, store, toast, views } from '../core.js';
import { openDialog } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';
import { tabsHtml } from '../ui/tabs.js';

const KIND = { broken: 'Trasig fil', truncated: 'Avkortad', length: 'Fel längd', decode: 'Avkodningsfel', sync: 'Ljud ur synk',
  audiolang: 'Ljudspråk', sublang: 'Undertextspråk', bitrate: 'Hög bithastighet', quality: 'Låg kvalitet', duplicate: 'Dubblett', missing: 'Saknade avsnitt' };
const TABS = [['all', 'Alla', null], ['broken', 'Trasiga', ['broken', 'truncated', 'length', 'decode']], ['sync', 'Synk', ['sync']],
  ['lang', 'Språk', ['audiolang', 'sublang']], ['quality', 'Kvalitet', ['quality', 'bitrate']], ['duplicate', 'Dubbletter', ['duplicate']],
  ['missing', 'Saknade avsnitt', ['missing']], ['ignored', 'Ignorerade', null]];
const LANGS = [['swe', 'Svenska'], ['eng', 'Engelska'], ['nor', 'Norska'], ['dan', 'Danska'], ['fin', 'Finska'], ['deu', 'Tyska'], ['fra', 'Franska'],
  ['spa', 'Spanska'], ['ita', 'Italienska'], ['nld', 'Nederländska'], ['pol', 'Polska'], ['jpn', 'Japanska'], ['kor', 'Koreanska'], ['zho', 'Kinesiska'], ['und', 'Okänt språk']];
const SEV = { error: ['warn-badge hb-err', 'Fel'], warn: ['warn-badge', 'Varning'], info: ['ok-badge hb-info', 'Info'] };
const pad = (n) => String(n).padStart(2, '0');
const titleOf = (i) => i.itemKind === 'episode' ? `${i.show || ''} S${pad(i.season)}E${pad(i.episode)}` : `${i.title}${i.year ? ` (${i.year})` : ''}`;
const langName = (c) => (LANGS.find(([k]) => k === c) || [c, c || 'inget'])[1];
const ACTION = { search: 'Ny version begärd', blocklist: 'Spärrad, ny version begärd' };

views.health = async (tab = 'all') => {
  if (!me.adminHere) { main.innerHTML = emptyState({ icon: '🔒', title: 'Bara för administratörer på hemnätet' }); return; }
  if (!TABS.some(([k]) => k === tab)) tab = 'all';
  const D = await api('/admin/health');
  const lib = store.get('health.lib') || '';
  const libs = [...new Map(D.issues.map(i => [String(i.libraryId), i.library])).entries()];
  const inLib = D.issues.filter(i => !lib || String(i.libraryId) === lib);
  const of = (k) => { const t = TABS.find(x => x[0] === k); return k === 'ignored' ? inLib.filter(i => i.ignored) : inLib.filter(i => !i.ignored && (!t[2] || t[2].includes(i.kind))); };
  const list = of(tab), s = D.status;
  main.innerHTML = `<div id="hroot"><div class="toolbar"><h1>Hälsokontroll</h1>
      <button class="primary small" id="hrun" ${s.enabled ? '' : 'disabled'}>Kontrollera nu</button><button class="ghost small" id="hfull" ${s.enabled ? '' : 'disabled'}>Kontrollera allt igen</button>
      <a class="btn ghost small" href="#/admin">Administration</a></div>
    <div class="panel"><p class="muted small">Servern går igenom biblioteket i bakgrunden med lägsta prioritet och pausar medan något spelas eller kodas om.
      Varje fil kontrolleras en gång – därefter bara när den ändrats. Inget i dina filer ändras: rättad språkmärkning sparas i BraXhn TV och används vid uppspelningen.</p>
      <p>${s.running ? `<b>Kontrollerar…</b> ${s.progress ? `${s.progress.done} av ${s.progress.total} filer` : ''}` : s.enabled ? `${s.files} filer kontrollerade${s.checked ? ` · senast ${esc(fmtDate(s.checked))}` : ''}` : '<span class="warn-badge">Avstängd</span>'}</p>
      <details><summary>Inställningar</summary><form id="hset" class="row" style="align-items:flex-end;margin-top:8px">
        <label class="switch" style="margin:0"><input type="checkbox" id="hen" ${D.settings.enabled ? 'checked' : ''}> Hälsokontroll på</label>
        <div><label for="hsm">Stickprov per fil</label><input id="hsm" type="number" min="0" max="20" value="${D.settings.samples}" style="width:90px"></div>
        <div><label for="hmb">Gräns för bithastighet (Mbit/s, 4K × 2,5)</label><input id="hmb" type="number" min="1" max="1000" value="${D.settings.maxMbps}" style="width:110px"></div>
        <button class="small">Spara</button></form></details></div>
    <div class="toolbar">${tabsHtml({ label: 'Typ av fynd', current: tab, items: TABS.map(([k, l]) => ({ key: k, label: `${l} (${of(k).length})`, href: '#/health/' + k })) })}
      ${libs.length > 1 ? `<select id="hlib" aria-label="Bibliotek"><option value="">Alla bibliotek</option>${libs.map(([id, n]) => `<option value="${esc(id)}" ${id === lib ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}</div>
    <div class="panel">${list.length ? `<ul class="hlist">${list.map(i => `<li>
        <span class="${SEV[i.severity]?.[0] || 'warn-badge'}">${esc(KIND[i.kind] || i.kind)}</span>
        <div class="hmain"><a href="#/item/${+i.link}"><b>${esc(titleOf(i))}</b></a><div>${esc(i.detail.msg || '')}</div>
          <div class="muted small">${esc(i.library || '')}${i.file && i.kind !== 'missing' ? ' · ' + esc(i.file) : ''} · hittad ${esc(fmtDate(i.found))}${i.action ? ` · <b>${esc(ACTION[i.action] || i.action)}</b> ${esc(fmtDate(i.actionAt))}` : ''}</div></div>
        <div class="hact">${i.actions.includes('replace') ? `<button class="ghost small" data-rep="${i.id}">${i.kind === 'missing' ? 'Be Sonarr söka' : 'Ny version…'}</button>` : ''}
          ${i.actions.includes('lang') ? `<button class="ghost small" data-lang="${i.id}">Rätta språk…</button>` : ''}
          <button class="ghost small" data-ign="${i.id}">${i.ignored ? 'Visa igen' : 'Ignorera'}</button></div></li>`).join('')}</ul>`
      : emptyState({ compact: true, icon: tab === 'ignored' ? '🙈' : '✅', title: tab === 'ignored' ? 'Inget ignorerat' : s.files ? 'Inga fynd' : 'Inget kontrollerat än', text: s.files || tab === 'ignored' ? '' : 'Kontrollen startar en stund efter skanningen, eller med Kontrollera nu.' })}</div>
    ${D.overrides.length ? `<div class="panel"><h2>Rättad språkmärkning</h2><div class="tablewrap"><table>${D.overrides.map(o => `<tr>
      <td><a href="#/item/${+o.item_id}">${esc(o.kind === 'episode' ? `${o.show_title || ''} S${pad(o.season)}E${pad(o.episode)}` : o.title)}</a></td>
      <td class="muted small">${esc(o.track)}</td><td>${esc(o.orig ? langName(o.orig) : 'filens')} → <b>${esc(langName(o.lang))}</b></td>
      <td class="r"><button class="ghost small" data-unlang="${+o.item_id}" data-track="${esc(o.track)}">Ta bort</button></td></tr>`).join('')}</table></div></div>` : ''}</div>`;

  const reload = () => views.health(tab);
  if (s.running) later(() => { if ($('#hroot')) return reload(); }, 4000);
  $('#hlib')?.addEventListener('change', (e) => { store.set('health.lib', e.target.value); reload(); });
  $('#hrun').onclick = act(async () => { await api('/admin/health/run', { method: 'POST', body: {} }); toast('Kontrollen startar'); later(reload, 1500); });
  $('#hfull').onclick = act(async () => { await api('/admin/health/run', { method: 'POST', body: { full: true } }); toast('Alla filer kontrolleras igen i bakgrunden'); later(reload, 1500); });
  $('#hset').onsubmit = act(async (e) => {
    e.preventDefault();
    await api('/admin/health/settings', { method: 'PUT', body: { enabled: $('#hen').checked, samples: +$('#hsm').value, maxMbps: +$('#hmb').value } });
    toast('Sparat'); reload();
  });
  $('#hroot').addEventListener('click', act(async (e) => {
    const b = e.target.closest('[data-rep],[data-lang],[data-ign],[data-unlang]'); if (!b) return;
    if (b.dataset.unlang) { await api('/admin/health/lang', { method: 'PUT', body: { item: +b.dataset.unlang, track: b.dataset.track, lang: '' } }); toast('Filens märkning gäller igen'); return reload(); }
    const i = D.issues.find(x => String(x.id) === (b.dataset.rep || b.dataset.lang || b.dataset.ign)); if (!i) return;
    if (b.dataset.ign) { await api(`/admin/health/issues/${i.id}/ignore`, { method: 'POST', body: { ignored: !i.ignored } }); return reload(); }
    if (b.dataset.rep) return replaceDialog(D, i, reload);
    langDialog(i, reload);
  }));
};

function replaceDialog(D, i, reload) {
  const kind = i.itemKind === 'movie' ? 'movie' : 'show', name = kind === 'movie' ? 'Radarr' : 'Sonarr';
  if (!D.arr[kind]) {
    openDialog({ title: `${name} är inte kopplat`, body: `<p>Koppla ${name} under <a href="#/admin">Administration → Sonarr, Radarr och Trakt</a> för att kunna be om en ny version.</p>` });
    return;
  }
  const missing = i.kind === 'missing';
  openDialog({ title: missing ? `Sök efter ${i.detail.label || 'avsnitten'}` : `Ny version av ${titleOf(i)}`,
    body: missing ? `<p>${name} ombeds söka efter avsnitten som saknas. Avsnitt som inte bevakas börjar bevakas.</p>`
      : `<p>${name} ombeds söka efter en ny version. Filen tas inte bort – ${name} ersätter den bara med en release som kvalitetsprofilen godtar.</p>
      <label class="switch"><input type="checkbox" id="hblk" ${['broken', 'truncated', 'decode'].includes(i.kind) ? 'checked' : ''}> Spärra den nuvarande releasen (markeras som misslyckad i ${name} och hämtas inte igen)</label>`,
    actions: [{ label: 'Avbryt' }, { label: missing ? 'Sök' : 'Be om ny version', kind: 'primary', onClick: async (h) => {
      const r = await api(`/admin/health/issues/${i.id}/replace`, { method: 'POST', body: { blocklist: !!h.$('#hblk')?.checked } });
      toast(missing ? `${name} söker efter ${r.searched} avsnitt` : `${name} söker efter en ny version${r.blocked ? ' – den gamla releasen är spärrad' : ''}`);
      reload();
    } }] });
}

function langDialog(i, reload) {
  const cur = i.detail.suggest || i.detail.current || 'swe';
  openDialog({ title: `Rätta språk – ${titleOf(i)}`,
    body: `<p>${esc(i.detail.label || i.detail.track)}: märkt <b>${esc(langName(i.detail.current) || 'inget')}</b>${i.detail.suggest ? `, troligen <b>${esc(langName(i.detail.suggest))}</b>` : ''}.</p>
      <label for="hlsel">Rätt språk</label><select id="hlsel">${LANGS.map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <p class="muted small">Sparas i BraXhn TV och används av uppspelningen, förvalen och bibliotekets filter i alla appar. Filen ändras inte.</p>`,
    actions: [{ label: 'Avbryt' }, { label: 'Spara', kind: 'primary', onClick: async (h) => {
      await api('/admin/health/lang', { method: 'PUT', body: { item: i.item, track: i.detail.track, lang: h.$('#hlsel').value } });
      toast('Språket är rättat'); reload();
    } }] });
}
