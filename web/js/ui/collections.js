// Egna samlingar: "Lägg till i samling…" (från kortmenyn och titelsidan), formuläret för ny/ändrad samling
// och borttagning. Vyerna (översikt och samlingssida) ligger i views/collections.js.
import { act, api, esc, me, toast, toastErr, t } from '../core.js';
import { confirmDialog, openDialog } from './dialog.js';

export const SORT_LABEL = { manual: t('Egen ordning'), title: t('Titel'), year: t('År'), added: t('Senast tillagda i samlingen') };
let seq = 0;

/**
 * Formulär för en ny eller ändrad samling. Delad (alla profiler) går bara att välja för administratörer på hemnätet.
 * @param {object} [col]   Befintlig samling (ändra) – annars skapas en ny
 * @param {number} [item]  Titel som läggs in direkt i en ny samling
 * @param {{ library: number, query: string }} [smart]  Ny smart samling: bibliotekets filter (innehållet räknas fram vid visning)
 * @returns {Promise<number|null>} Samlingens id, eller null om man avbröt
 */
export async function collectionForm(col = null, item = null, smart = null) {
  const id = 'cf' + (++seq), canShare = !!me?.adminHere;
  const v = col || { name: '', overview: '', sort: 'manual', shared: false, home: false };
  const isSmart = !!(smart || col?.smart);
  const body = `<div class="field"><label for="${id}n">${t('Namn')}</label><input id="${id}n" name="name" required maxlength="100" value="${esc(v.name)}" autocomplete="off"></div>
    <div class="field"><label for="${id}o">${t('Beskrivning (valfritt)')}</label><textarea id="${id}o" name="overview" rows="3" maxlength="2000">${esc(v.overview || '')}</textarea></div>
    ${isSmart ? `<p class="hint small muted">${t('Smart samling: innehållet och ordningen följer filtret och uppdateras av sig själv när biblioteket ändras.')}</p>`
      : `<div class="field"><label for="${id}s">${t('Sortering')}</label><select id="${id}s" name="sort">${Object.entries(SORT_LABEL).map(([k, l]) => `<option value="${k}"${v.sort === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`}
    <label class="ccheck"><input type="checkbox" id="${id}h"${v.home ? ' checked' : ''}> ${t('Visa på startsidan')}</label>
    ${canShare ? `<label class="ccheck"><input type="checkbox" id="${id}d"${v.shared ? ' checked' : ''} aria-describedby="${id}dh"> ${t('Delad med alla profiler')}</label>
      <p class="hint small muted" id="${id}dh">${t('Annars syns samlingen bara för dig. Barnprofiler ser bara titlar inom sin åldersgräns.')}</p>`
      : `<p class="hint small muted">${t('Samlingen syns bara för dig.')}</p>`}`;
  const d = openDialog({
    title: col ? t('Ändra samling') : smart ? t('Ny smart samling') : t('Ny samling'), form: true, body,
    actions: [{ label: t('Avbryt'), value: null }, { label: col ? t('Spara') : t('Skapa'), kind: 'primary', submit: true, onClick: async (h) => {
      const b = { name: h.$(`#${id}n`).value.trim(), overview: h.$(`#${id}o`).value, home: h.$(`#${id}h`).checked };
      if (!isSmart) b.sort = h.$(`#${id}s`).value;
      if (smart) b.smart = smart;
      if (canShare) b.shared = h.$(`#${id}d`).checked;
      if (!b.name) { h.$(`#${id}n`).focus(); return false; }
      if (col) { await api(`/custom-collections/${col.id}`, { method: 'PUT', body: b }); return col.id; }
      if (item) b.item = item;
      return (await api('/custom-collections', { method: 'POST', body: b })).id;
    } }]
  });
  const r = await d.closed;
  return typeof r === 'number' ? r : null;
}

/** Tar bort samlingen efter bekräftelse. true om den togs bort. */
export async function deleteCollection(col) {
  if (!await confirmDialog(t('Titlarna finns kvar i biblioteket.'), { title: t('Ta bort samlingen {name}?', { name: col.name }), okLabel: t('Ta bort'), danger: true })) return false;
  await api(`/custom-collections/${col.id}`, { method: 'DELETE' });
  toast(t('Samlingen {name} är borttagen', { name: col.name }));
  return true;
}

/**
 * "Lägg till i samling…": samlingar man får ändra, var och en en växlingsknapp (✓ = titeln ligger där),
 * och "Ny samling…" som skapar en samling med titeln i.
 * @param {{ id: number, title?: string, kind?: string, showTitle?: string }} it
 */
export async function addToCollection(it) {
  let cols;
  try { cols = await api(`/custom-collections?editable=1&item=${+it.id}`, { bg: true }); } catch (e) { return toastErr(e); }
  const name = it.kind === 'episode' ? it.showTitle || t('Serien') : it.title || t('Titeln');
  const row = (c) => `<li><button type="button" class="ghost ctoggle" data-ccol="${+c.id}" aria-pressed="${c.has ? 'true' : 'false'}">
    <span class="ck" aria-hidden="true">${c.has ? '✓' : '+'}</span><span class="cn">${esc(c.name)}</span><span class="muted small">${c.shared ? t('Delad') : t('Privat')} · ${+c.count}</span></button></li>`;
  const d = openDialog({
    title: t('Lägg till {name} i samling', { name }),
    body: (cols.length ? `<ul class="ccols">${cols.map(row).join('')}</ul>` : t('<p class="muted">Du har inga samlingar ännu.</p>')),
    actions: [{ label: t('Ny samling…'), kind: 'ghost', value: 'new' }, { label: t('Klar'), kind: 'primary', value: 'done' }]
  });
  d.el.querySelectorAll('[data-ccol]').forEach(b => b.addEventListener('click', act(async () => {
    const c = cols.find(x => x.id === +b.dataset.ccol), add = !c.has;
    b.disabled = true;
    try {
      if (add) await api(`/custom-collections/${c.id}/items`, { method: 'POST', body: { id: it.id }, bg: true });
      else await api(`/custom-collections/${c.id}/items/${+it.id}`, { method: 'DELETE', bg: true });
    } finally { b.disabled = false; }
    c.has = add; c.count += add ? 1 : -1;
    b.setAttribute('aria-pressed', String(add));
    b.querySelector('.ck').textContent = add ? '✓' : '+';
    b.querySelector('.small').textContent = `${c.shared ? t('Delad') : t('Privat')} · ${c.count}`;
    toast(add ? t('{name} ligger nu i {name2}', { name, name2: c.name }) : t('{name} är borttagen från {name2}', { name, name2: c.name }));
  })));
  if (await d.closed === 'new') {
    const id = await collectionForm(null, it.id);
    if (id) toast(t('{name} ligger nu i den nya samlingen', { name }), { action: { label: t('Visa'), onClick: () => { location.hash = `#/ucollection/${id}`; } } });
  }
}
