// Administration – rättigheter per användare (bibliotek, nedladdning, kvalitetstak utanför hemmet, samtidiga strömmar)
// och inbjudningslänkar. Servern kontrollerar allt (server/perms.js, server/invites.js) – det här är bara gränssnittet.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, toast, toastErr } from '../core.js';
import { confirmDialog, openDialog } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';

const QUALITIES = [['', 'Som servern'], ['2160', '4K (2160p)'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']];
const TYPE = { movie: 'Filmer', show: 'Serier', music: 'Musik', audiobook: 'Ljudböcker' };

/** Kort sammanfattning för användartabellen */
export function permsSummary(u, L) {
  if (u.is_admin) return 'Allt (administratör)';
  const parts = [];
  if (u.libraries == null) parts.push(u.parent_id ? 'Bibliotek som kontot' : 'Alla bibliotek');
  else parts.push(`${u.libraries.filter(id => L.some(l => l.id === id)).length} av ${L.length} bibliotek`);
  if (!u.canDownload) parts.push('ingen nedladdning');
  if (u.remoteQuality) parts.push(`högst ${u.remoteQuality}p ute`);
  if (u.maxStreams) parts.push(`högst ${u.maxStreams} ${u.maxStreams === 1 ? 'ström' : 'strömmar'}`);
  return parts.join(' · ');
}

/**
 * Fälten för rättigheter (används både i användarens dialog och för inbjudningar).
 * p = { libraries, canDownload, remoteQuality, maxStreams }; profile = profil (ärver kontot, inga hushållsfält)
 */
function permsFields(id, p, L, { profile = false, serverQuality = '1080' } = {}) {
  const all = p.libraries == null;
  return `<fieldset class="libpick"><legend>Bibliotek</legend>
      <label class="switch"><input type="radio" name="${id}m" value="all" ${all ? 'checked' : ''}> ${profile ? 'Samma som kontot' : 'Alla bibliotek, även nya'}</label>
      <label class="switch"><input type="radio" name="${id}m" value="some" ${all ? '' : 'checked'}> Bara de valda</label>
      <div class="libpick-list" id="${id}libs" ${all ? 'hidden' : ''}>${L.map(l => `<label class="switch"><input type="checkbox" data-lib="${+l.id}" ${all || p.libraries.includes(l.id) ? 'checked' : ''}> ${esc(l.name)} <span class="muted small">${TYPE[l.type] || ''}</span></label>`).join('')
        || '<p class="muted small">Inga bibliotek ännu.</p>'}</div>
      ${profile ? '<p class="muted small">En profil får aldrig se mer än kontot.</p>' : ''}</fieldset>
    <label class="switch"><input type="checkbox" id="${id}dl" ${p.canDownload !== false ? 'checked' : ''}> Får ladda ner (originalfilen, offline i apparna och nedladdning i musikappar)</label>
    ${profile ? '' : `<div class="row">
      <div style="flex:1;min-width:160px"><label for="${id}rq">Högsta kvalitet utanför hemmet</label><select id="${id}rq">${QUALITIES.map(([v, t]) => `<option value="${v}" ${(p.remoteQuality || '') === v ? 'selected' : ''}>${esc(v ? t : `${t} (${serverQuality === 'orig' ? 'original' : serverQuality + 'p'})`)}</option>`).join('')}</select></div>
      <div style="flex:1;min-width:160px"><label for="${id}ms">Samtidiga strömmar <span class="muted small">(tomt = obegränsat)</span></label><input id="${id}ms" type="number" min="1" max="20" inputmode="numeric" value="${p.maxStreams || ''}"></div></div>
    <p class="muted small">Taket gäller både automatisk och vald kvalitet. Strömmarna räknas för hela hushållet (kontot och dess profiler).</p>`}`;
}
function bindPermsFields(root, id) {
  const list = root.querySelector(`#${id}libs`);
  root.querySelectorAll(`[name="${id}m"]`).forEach(r => r.onchange = () => { list.hidden = root.querySelector(`[name="${id}m"]:checked`).value === 'all'; });
}
function readPerms(root, id, { profile = false } = {}) {
  const some = root.querySelector(`[name="${id}m"]:checked`)?.value === 'some';
  const out = { libraries: some ? [...root.querySelectorAll(`#${id}libs [data-lib]`)].filter(b => b.checked).map(b => +b.dataset.lib) : null,
    canDownload: root.querySelector(`#${id}dl`).checked };
  if (!profile) { out.remoteQuality = root.querySelector(`#${id}rq`).value || null; out.maxStreams = root.querySelector(`#${id}ms`).value || null; }
  return out;
}

/** Dialog: rättigheter för en användare eller profil. Returnerar true om något sparades. */
export async function editPerms(u, U, L, S) {
  const profile = u.parent_id != null;
  const owner = profile ? U.find(x => x.id === u.parent_id) : null;
  const d = openDialog({
    title: `Rättigheter för ${u.name}`, form: true, size: 'wide',
    body: (profile ? `<p class="muted">Profil i hushållet ${esc(owner?.name || '')}. Kvalitetstak och samtidiga strömmar ärvs från kontot.</p>` : '')
      + permsFields('pe', u, L, { profile, serverQuality: S.remoteQuality }),
    actions: [{ label: 'Avbryt', value: false },
      { label: 'Spara', kind: 'primary', submit: true, onClick: async (h) => {
        const body = readPerms(h.el, 'pe', { profile });
        if (body.libraries && !body.libraries.length && !await confirmDialog(`${u.name} kommer inte att se något bibliotek alls. Fortsätta?`, { okLabel: 'Spara ändå' })) return false;
        await api('/users/' + u.id, { method: 'PUT', body });
        toast('Rättigheterna sparades');
        return true;
      } }]
  });
  bindPermsFields(d.el, 'pe');
  return !!(await d.closed);
}

// ---------- Inbjudningar ----------
const inviteStatus = (i) => i.used ? `<span class="ok-badge">Använd</span> <span class="muted small">av ${esc(i.usedName || '?')} ${esc(fmtDate(i.usedAt))}</span>`
  : i.expired ? '<span class="warn-badge">Utgången</span>' : `<span class="muted small">Giltig till ${esc(new Date(i.expires * 1000).toLocaleDateString('sv-SE'))}</span>`;
const invitePerms = (p, L) => p ? permsSummary({ ...p, is_admin: 0 }, L) + (p.remoteAllowed ? '' : ' · bara hemma') + (p.maxAge != null ? ` · max ${p.maxAge} år` : '') : '';

/** Fyller panelen #invp med inbjudningar och formuläret för en ny */
export async function adminInvites(L, S) {
  const el = $('#invp'); if (!el) return;
  const r = await api('/invites');
  if (!$('#invp')) return;
  el.innerHTML = `<p class="muted small">Skicka en länk till någon du vill dela med. Mottagaren väljer själv namn och lösenord och får rättigheterna du väljer här. Länken fungerar en gång och slutar gälla efter angivet antal dagar.</p>
    ${r.invites.length ? `<table><tr><th>Anteckning</th><th>Rättigheter</th><th>Status</th><th></th></tr>${r.invites.map(i => `<tr><td>${esc(i.note || '–')}</td>
      <td class="small">${esc(invitePerms(i.perms, L))}</td><td>${inviteStatus(i)}</td>
      <td class="r"><button class="ghost small" data-invdel="${+i.id}">${i.used || i.expired ? 'Ta bort' : 'Återkalla'}</button></td></tr>`).join('')}</table>`
      : emptyState({ icon: '✉️', title: 'Inga inbjudningar', text: 'Skapa en länk nedan.' })}
    <details style="margin-top:14px"><summary><b>Ny inbjudan</b></summary>
    <form id="invf" style="margin-top:10px">
      <div class="row"><div style="flex:2;min-width:180px"><label for="invnote">Anteckning (bara för dig)</label><input id="invnote" maxlength="100" placeholder="t.ex. Mormor"></div>
        <div style="flex:1;min-width:120px"><label for="invdays">Giltig i dagar</label><input id="invdays" type="number" min="1" max="${+r.maxDays}" value="7"></div>
        <div style="flex:1;min-width:120px"><label for="invage">Åldersgräns <span class="muted small">(tomt = ingen)</span></label><input id="invage" type="number" min="0" max="18" inputmode="numeric"></div></div>
      <label class="switch"><input type="checkbox" id="invremote" checked> Får titta utanför hemmet</label>
      ${permsFields('inv', { libraries: null, canDownload: true }, L, { serverQuality: S.remoteQuality })}
      <div class="row" style="margin-top:12px"><button class="primary">Skapa länk</button></div></form></details>`;
  bindPermsFields(el, 'inv');
  $$('[data-invdel]', el).forEach(b => b.onclick = act(async () => {
    if (!await confirmDialog('Länken slutar fungera direkt. Konton som redan skapats med den påverkas inte.', { title: 'Ta bort inbjudan?', okLabel: 'Ta bort', danger: true })) return;
    await api('/invites/' + b.dataset.invdel, { method: 'DELETE' }); adminInvites(L, S);
  }));
  $('#invf').onsubmit = act(async (e) => {
    e.preventDefault();
    const body = { ...readPerms(el, 'inv'), note: $('#invnote').value, days: $('#invdays').value, maxAge: $('#invage').value, remoteAllowed: $('#invremote').checked };
    let res;
    try { res = await api('/invites', { method: 'POST', body }); } catch (er) { return toastErr(er); }
    const url = (S.publicUrl || location.origin).replace(/\/$/, '') + res.path;
    const copy = () => { navigator.clipboard?.writeText(url).then(() => toast('Kopierat'), () => toastErr(new Error('Kunde inte kopiera – markera länken och kopiera den själv'))); return false; };
    const d = openDialog({ title: 'Inbjudan skapad',
      body: `<p>Skicka länken till mottagaren. Den visas bara nu och fungerar en gång, till ${esc(new Date(res.expires * 1000).toLocaleDateString('sv-SE'))}.</p>
        <input readonly id="invurl" value="${esc(url)}" style="width:100%;font-family:ui-monospace,monospace">`,
      actions: [{ label: 'Kopiera länken', kind: 'primary', onClick: copy }, { label: 'Stäng' }] });
    const i = d.$('#invurl'); i.onfocus = () => i.select();
    await d.closed;
    adminInvites(L, S);
  });
}
