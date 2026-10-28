// Hälsokontroll av biblioteket (administratör på betrott nät): trasiga och avkortade filer, avkodningsfel, ljud ur synk,
// felmärkta språk, låg kvalitet, dubbletter, saknade avsnitt och hög bithastighet (server/health.js). Åtgärder per fynd:
// be Radarr/Sonarr om en ny version (ev. spärra den nuvarande), rätta språkmärkningen (filen ändras inte) och ignorera.
// #/health/<flik>; biblioteksfiltret sparas per webbläsare (store).
// @lazy – laddas vid behov (LAZY i js/router.js)
import { $, act, api, esc, fmtDate, later, main, me, store, toast, views, t } from '../core.js';
import { openDialog } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';
import { tabsHtml } from '../ui/tabs.js';

const KIND = { broken: t('Trasig fil'), truncated: t('Avkortad'), length: t('Fel längd'), decode: t('Avkodningsfel'), sync: t('Ljud ur synk'),
  audiolang: t('Ljudspråk'), sublang: t('Undertextspråk'), bitrate: t('Hög bithastighet'), quality: t('Låg kvalitet'), duplicate: t('Dubblett'), missing: t('Saknade avsnitt') };
const TABS = [['all', t('Alla'), null], ['broken', t('Trasiga'), ['broken', 'truncated', 'length', 'decode']], ['sync', t('Synk'), ['sync']],
  ['lang', t('Språk'), ['audiolang', 'sublang']], ['quality', t('Kvalitet'), ['quality', 'bitrate']], ['duplicate', t('Dubbletter'), ['duplicate']],
  ['missing', t('Saknade avsnitt'), ['missing']], ['ignored', t('Ignorerade'), null]];
const LANGS = [['swe', t('Svenska')], ['eng', t('Engelska')], ['nor', t('Norska')], ['dan', t('Danska')], ['fin', t('Finska')], ['deu', t('Tyska')], ['fra', t('Franska')],
  ['spa', t('Spanska')], ['ita', t('Italienska')], ['nld', t('Nederländska')], ['pol', t('Polska')], ['jpn', t('Japanska')], ['kor', t('Koreanska')], ['zho', t('Kinesiska')], ['und', t('Okänt språk')]];
const SEV = { error: ['warn-badge hb-err', t('Fel')], warn: ['warn-badge', t('Varning')], info: ['ok-badge hb-info', 'Info'] };
const pad = (n) => String(n).padStart(2, '0');
const titleOf = (i) => i.itemKind === 'episode' ? `${i.show || ''} S${pad(i.season)}E${pad(i.episode)}` : `${i.title}${i.year ? ` (${i.year})` : ''}`;
const langName = (c) => (LANGS.find(([k]) => k === c) || [c, c || t('inget')])[1];
const ACTION = { search: t('Ny version begärd'), blocklist: t('Spärrad, ny version begärd') };

views.health = async (tab = 'all') => {
  if (!me.adminHere) { main.innerHTML = emptyState({ icon: '🔒', title: t('Bara för administratörer på hemnätet') }); return; }
  if (!TABS.some(([k]) => k === tab)) tab = 'all';
  const D = await api('/admin/health');
  const lib = store.get('health.lib') || '';
  const libs = [...new Map(D.issues.map(i => [String(i.libraryId), i.library])).entries()];
  const inLib = D.issues.filter(i => !lib || String(i.libraryId) === lib);
  const of = (k) => { const t = TABS.find(x => x[0] === k); return k === 'ignored' ? inLib.filter(i => i.ignored) : inLib.filter(i => !i.ignored && (!t[2] || t[2].includes(i.kind))); };
  const list = of(tab), s = D.status;
  main.innerHTML = `<div id="hroot"><div class="toolbar"><h1>${t('Hälsokontroll')}</h1>
      <button class="primary small" id="hrun" ${s.enabled ? '' : 'disabled'}>${t('Kontrollera nu')}</button><button class="ghost small" id="hfull" ${s.enabled ? '' : 'disabled'}>${t('Kontrollera allt igen')}</button>
      <a class="btn ghost small" href="#/admin">Administration</a></div>
    <div class="panel"><p class="muted small">${t('Servern går igenom biblioteket i bakgrunden med lägsta prioritet och pausar medan något spelas eller kodas om.\n      Varje fil kontrolleras en gång – därefter bara när den ändrats. Inget i dina filer ändras: rättad språkmärkning sparas i BraXhn TV och används vid uppspelningen.')}</p>
      <p>${s.running ? `<b>${t('Kontrollerar…')}</b> ${s.progress ? t('{done} av {total} filer', { done: s.progress.done, total: s.progress.total }) : ''}` : s.enabled ? t('{files} filer kontrollerade{v}', { files: s.files, v: s.checked ? ` ${t('· senast {v}', { v: esc(fmtDate(s.checked)) })}` : '' }) : t('<span class="warn-badge">Avstängd</span>')}</p>
      <details><summary>${t('Inställningar')}</summary><form id="hset" class="row" style="align-items:flex-end;margin-top:8px">
        <label class="switch" style="margin:0"><input type="checkbox" id="hen" ${D.settings.enabled ? 'checked' : ''}> ${t('Hälsokontroll på')}</label>
        <div><label for="hsm">${t('Stickprov per fil')}</label><input id="hsm" type="number" min="0" max="20" value="${D.settings.samples}" style="width:90px"></div>
        <div><label for="hmb">${t('Gräns för bithastighet (Mbit/s, 4K × 2,5)')}</label><input id="hmb" type="number" min="1" max="1000" value="${D.settings.maxMbps}" style="width:110px"></div>
        <button class="small">${t('Spara')}</button></form></details></div>
    <div class="toolbar">${tabsHtml({ label: t('Typ av fynd'), current: tab, items: TABS.map(([k, l]) => ({ key: k, label: `${l} (${of(k).length})`, href: '#/health/' + k })) })}
      ${libs.length > 1 ? `<select id="hlib" aria-label="${t('Bibliotek')}"><option value="">${t('Alla bibliotek')}</option>${libs.map(([id, n]) => `<option value="${esc(id)}" ${id === lib ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}</div>
    <div class="panel">${list.length ? `<ul class="hlist">${list.map(i => `<li>
        <span class="${SEV[i.severity]?.[0] || 'warn-badge'}">${esc(KIND[i.kind] || i.kind)}</span>
        <div class="hmain"><a href="#/item/${+i.link}"><b>${esc(titleOf(i))}</b></a><div>${esc(i.detail.msg || '')}</div>
          <div class="muted small">${esc(i.library || '')}${i.file && i.kind !== 'missing' ? ' · ' + esc(i.file) : ''} · hittad ${esc(fmtDate(i.found))}${i.action ? ` · <b>${esc(ACTION[i.action] || i.action)}</b> ${esc(fmtDate(i.actionAt))}` : ''}</div></div>
        <div class="hact">${i.actions.includes('replace') ? `<button class="ghost small" data-rep="${i.id}">${i.kind === 'missing' ? t('Be Sonarr söka') : t('Ny version…')}</button>` : ''}
          ${i.actions.includes('lang') ? `<button class="ghost small" data-lang="${i.id}">${t('Rätta språk…')}</button>` : ''}
          <button class="ghost small" data-ign="${i.id}">${i.ignored ? t('Visa igen') : t('Ignorera')}</button></div></li>`).join('')}</ul>`
      : emptyState({ compact: true, icon: tab === 'ignored' ? '🙈' : '✅', title: tab === 'ignored' ? t('Inget ignorerat') : s.files ? t('Inga fynd') : t('Inget kontrollerat än'), text: s.files || tab === 'ignored' ? '' : t('Kontrollen startar en stund efter skanningen, eller med Kontrollera nu.') })}</div>
    ${D.overrides.length ? `<div class="panel"><h2>${t('Rättad språkmärkning')}</h2><div class="tablewrap"><table>${D.overrides.map(o => `<tr>
      <td><a href="#/item/${+o.item_id}">${esc(o.kind === 'episode' ? `${o.show_title || ''} S${pad(o.season)}E${pad(o.episode)}` : o.title)}</a></td>
      <td class="muted small">${esc(o.track)}</td><td>${esc(o.orig ? langName(o.orig) : t('filens'))} → <b>${esc(langName(o.lang))}</b></td>
      <td class="r"><button class="ghost small" data-unlang="${+o.item_id}" data-track="${esc(o.track)}">${t('Ta bort')}</button></td></tr>`).join('')}</table></div></div>` : ''}</div>`;

  const reload = () => views.health(tab);
  if (s.running) later(() => { if ($('#hroot')) return reload(); }, 4000);
  $('#hlib')?.addEventListener('change', (e) => { store.set('health.lib', e.target.value); reload(); });
  $('#hrun').onclick = act(async () => { await api('/admin/health/run', { method: 'POST', body: {} }); toast(t('Kontrollen startar')); later(reload, 1500); });
  $('#hfull').onclick = act(async () => { await api('/admin/health/run', { method: 'POST', body: { full: true } }); toast(t('Alla filer kontrolleras igen i bakgrunden')); later(reload, 1500); });
  $('#hset').onsubmit = act(async (e) => {
    e.preventDefault();
    await api('/admin/health/settings', { method: 'PUT', body: { enabled: $('#hen').checked, samples: +$('#hsm').value, maxMbps: +$('#hmb').value } });
    toast(t('Sparat')); reload();
  });
  $('#hroot').addEventListener('click', act(async (e) => {
    const b = e.target.closest('[data-rep],[data-lang],[data-ign],[data-unlang]'); if (!b) return;
    if (b.dataset.unlang) { await api('/admin/health/lang', { method: 'PUT', body: { item: +b.dataset.unlang, track: b.dataset.track, lang: '' } }); toast(t('Filens märkning gäller igen')); return reload(); }
    const i = D.issues.find(x => String(x.id) === (b.dataset.rep || b.dataset.lang || b.dataset.ign)); if (!i) return;
    if (b.dataset.ign) { await api(`/admin/health/issues/${i.id}/ignore`, { method: 'POST', body: { ignored: !i.ignored } }); return reload(); }
    if (b.dataset.rep) return replaceDialog(D, i, reload);
    langDialog(i, reload);
  }));
};

function replaceDialog(D, i, reload) {
  const kind = i.itemKind === 'movie' ? 'movie' : 'show', name = kind === 'movie' ? 'Radarr' : 'Sonarr';
  if (!D.arr[kind]) {
    openDialog({ title: t('{name} är inte kopplat', { name }), body: `<p>${t('Koppla {name} under <a href="#/admin">Administration → Sonarr, Radarr och Trakt</a> för att kunna be om en ny version.', { name })}</p>` });
    return;
  }
  const missing = i.kind === 'missing';
  openDialog({ title: missing ? t('Sök efter {v}', { v: i.detail.label || t('avsnitten') }) : t('Ny version av {i}', { i: titleOf(i) }),
    body: missing ? `<p>${t('{name} ombeds söka efter avsnitten som saknas. Avsnitt som inte bevakas börjar bevakas.', { name })}</p>`
      : `<p>${t('{name} ombeds söka efter en ny version. Filen tas inte bort – {name} ersätter den bara med en release som kvalitetsprofilen godtar.', { name })}</p>
      <label class="switch"><input type="checkbox" id="hblk" ${['broken', 'truncated', 'decode'].includes(i.kind) ? 'checked' : ''}> ${t('Spärra den nuvarande releasen (markeras som misslyckad i {name} och hämtas inte igen)', { name })}</label>`,
    actions: [{ label: t('Avbryt') }, { label: missing ? t('Sök') : t('Be om ny version'), kind: 'primary', onClick: async (h) => {
      const r = await api(`/admin/health/issues/${i.id}/replace`, { method: 'POST', body: { blocklist: !!h.$('#hblk')?.checked } });
      toast(missing ? t('{name} söker efter {searched} avsnitt', { name, searched: r.searched }) : t('{name} söker efter en ny version{v}', { name, v: r.blocked ? t(' – den gamla releasen är spärrad') : '' }));
      reload();
    } }] });
}

function langDialog(i, reload) {
  const cur = i.detail.suggest || i.detail.current || 'swe';
  openDialog({ title: t('Rätta språk – {i}', { i: titleOf(i) }),
    body: `<p>${t('{v}: märkt <b>{v2}</b>{v3}.', { v: esc(i.detail.label || i.detail.track), v2: esc(langName(i.detail.current) || t('inget')), v3: i.detail.suggest ? `${t(', troligen <b>{v}</b>', { v: esc(langName(i.detail.suggest)) })}` : '' })}</p>
      <label for="hlsel">${t('Rätt språk')}</label><select id="hlsel">${LANGS.map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <p class="muted small">${t('Sparas i BraXhn TV och används av uppspelningen, förvalen och bibliotekets filter i alla appar. Filen ändras inte.')}</p>`,
    actions: [{ label: t('Avbryt') }, { label: t('Spara'), kind: 'primary', onClick: async (h) => {
      await api('/admin/health/lang', { method: 'PUT', body: { item: i.item, track: i.detail.track, lang: h.$('#hlsel').value } });
      toast(t('Språket är rättat')); reload();
    } }] });
}
