// Egna samlingar: "Lägg till i samling…" (från kortmenyn och titelsidan), formuläret för ny/ändrad samling
// och borttagning. Vyerna (översikt och samlingssida) ligger i views/collections.js.
import { act, api, esc, me, toast, toastErr } from '../core.js';
import { confirmDialog, openDialog } from './dialog.js';

export const SORT_LABEL = { manual: 'Egen ordning', title: 'Titel', year: 'År', added: 'Senast tillagda i samlingen' };
let seq = 0;

/**
 * Formulär för en ny eller ändrad samling. Delad (alla profiler) går bara att välja för administratörer på hemnätet.
 * @param {object} [col]   Befintlig samling (ändra) – annars skapas en ny
 * @param {number} [item]  Titel som läggs in direkt i en ny samling
 * @returns {Promise<number|null>} Samlingens id, eller null om man avbröt
 */
export async function collectionForm(col = null, item = null) {
  const id = 'cf' + (++seq), canShare = !!me?.adminHere;
  const v = col || { name: '', overview: '', sort: 'manual', shared: false, home: false };
  const body = `<div class="field"><label for="${id}n">Namn</label><input id="${id}n" name="name" required maxlength="100" value="${esc(v.name)}" autocomplete="off"></div>
    <div class="field"><label for="${id}o">Beskrivning (valfritt)</label><textarea id="${id}o" name="overview" rows="3" maxlength="2000">${esc(v.overview || '')}</textarea></div>
    <div class="field"><label for="${id}s">Sortering</label><select id="${id}s" name="sort">${Object.entries(SORT_LABEL).map(([k, l]) => `<option value="${k}"${v.sort === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <label class="ccheck"><input type="checkbox" id="${id}h"${v.home ? ' checked' : ''}> Visa på startsidan</label>
    ${canShare ? `<label class="ccheck"><input type="checkbox" id="${id}d"${v.shared ? ' checked' : ''} aria-describedby="${id}dh"> Delad med alla profiler</label>
      <p class="hint small muted" id="${id}dh">Annars syns samlingen bara för dig. Barnprofiler ser bara titlar inom sin åldersgräns.</p>`
      : `<p class="hint small muted">Samlingen syns bara för dig.</p>`}`;
  const d = openDialog({
    title: col ? 'Ändra samling' : 'Ny samling', form: true, body,
    actions: [{ label: 'Avbryt', value: null }, { label: col ? 'Spara' : 'Skapa', kind: 'primary', submit: true, onClick: async (h) => {
      const b = { name: h.$(`#${id}n`).value.trim(), overview: h.$(`#${id}o`).value, sort: h.$(`#${id}s`).value, home: h.$(`#${id}h`).checked };
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
  if (!await confirmDialog(`Titlarna finns kvar i biblioteket.`, { title: `Ta bort samlingen ${col.name}?`, okLabel: 'Ta bort', danger: true })) return false;
  await api(`/custom-collections/${col.id}`, { method: 'DELETE' });
  toast(`Samlingen ${col.name} är borttagen`);
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
  const name = it.kind === 'episode' ? it.showTitle || 'Serien' : it.title || 'Titeln';
  const row = (c) => `<li><button type="button" class="ghost ctoggle" data-ccol="${+c.id}" aria-pressed="${c.has ? 'true' : 'false'}">
    <span class="ck" aria-hidden="true">${c.has ? '✓' : '+'}</span><span class="cn">${esc(c.name)}</span><span class="muted small">${c.shared ? 'Delad' : 'Privat'} · ${+c.count}</span></button></li>`;
  const d = openDialog({
    title: `Lägg till ${name} i samling`,
    body: (cols.length ? `<ul class="ccols">${cols.map(row).join('')}</ul>` : '<p class="muted">Du har inga samlingar ännu.</p>'),
    actions: [{ label: 'Ny samling…', kind: 'ghost', value: 'new' }, { label: 'Klar', kind: 'primary', value: 'done' }]
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
    b.querySelector('.small').textContent = `${c.shared ? 'Delad' : 'Privat'} · ${c.count}`;
    toast(add ? `${name} ligger nu i ${c.name}` : `${name} är borttagen från ${c.name}`);
  })));
  if (await d.closed === 'new') {
    const id = await collectionForm(null, it.id);
    if (id) toast(`${name} ligger nu i den nya samlingen`, { action: { label: 'Visa', onClick: () => { location.hash = `#/ucollection/${id}`; } } });
  }
}
