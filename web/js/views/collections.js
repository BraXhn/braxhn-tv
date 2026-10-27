// Vyer: alla samlingar (egna + TMDB) och en egen samling med ändring, borttagning och manuell ordning
// (dra och släpp eller ↑/↓-knapparna, som fungerar med tangentbord, fjärrkontroll och skärmläsare).
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, heroUrl, main, sxe, toast, toastErr, views } from '../core.js';
import { startPlay } from '../lazy.js';
import { route } from '../router.js';
import { iconButton } from '../ui/buttons.js';
import { card, colCard, shelfHtml } from '../ui/cards.js';
import { SORT_LABEL, collectionForm, deleteCollection } from '../ui/collections.js';
import { emptyState } from '../ui/states.js';

views.collections = async () => {
  const [own, tmdb] = await Promise.all([api('/custom-collections'), api('/collections').catch(e => { if (e?.aborted) throw e; return []; })]);
  main.innerHTML = `<div class="toolbar"><h1>Samlingar</h1><button class="primary" id="newcol">+ Ny samling</button></div>
    ${own.length ? shelfHtml('Egna samlingar', own.map(colCard).join('')) : emptyState({ icon: '🗂', title: 'Inga egna samlingar ännu',
      text: 'Skapa en samling här, eller välj ⋮ → ”Lägg till i samling…” på en film eller serie.', compact: true })}
    ${tmdb.length ? `<section class="section"><h2>Filmserier</h2><div class="grid">${tmdb.map(colCard).join('')}</div></section>` : ''}`;
  $('#newcol').onclick = act(async () => { const id = await collectionForm(); if (id) location.hash = `#/ucollection/${id}`; });
};

views.ucollection = async (id) => {
  const c = await api('/custom-collections/' + encodeURIComponent(id));
  const bd = c.items.find(i => i.backdrop), first = c.items.find(i => i.kind === 'movie' && !i.watched);
  // Smart samling: ett sparat biblioteksfilter – "Ändra filter" öppnar biblioteket med filtret (och sparar tillbaka hit)
  const filterUrl = c.smart && c.library ? `#/lib/${+c.library}?${c.query ? c.query + '&' : ''}scol=${+c.id}` : null;
  const meta = [`${c.count} ${c.count === 1 ? 'titel' : 'titlar'}`, c.shared ? 'Delad med alla profiler' : 'Privat', c.smart ? 'Smart samling' : `Sortering: ${SORT_LABEL[c.sort] || c.sort}`]
    .concat(c.home ? ['Visas på startsidan'] : []);
  main.innerHTML = `<div class="hero">${bd ? `<div class="bd" style="background-image:url(${heroUrl(`/api/image/${+bd.id}/backdrop`)})"></div>` : ''}
    <div class="in"><div><p><a class="muted" href="#/collections">← Samlingar</a></p><h1>${esc(c.name)}</h1>
    <div class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div>${c.overview ? `<p class="overview">${esc(c.overview)}</p>` : ''}
    <div class="row">${first ? `<button class="primary" id="playfirst">▶ Spela ${esc(first.title)}</button>` : ''}
    ${c.items.length ? '<button class="ghost" id="cshuffle" title="Spela en slumpad titel ur samlingen">🔀 Blanda</button>' : ''}
    ${filterUrl ? `<a class="btn ghost" href="${esc(filterUrl)}">${c.editable ? 'Ändra filter' : 'Visa i biblioteket'}</a>` : ''}
    ${c.editable ? `<button class="ghost" id="cedit">Ändra</button>${!c.smart && c.sort === 'manual' && c.items.length > 1 ? '<button class="ghost" id="corder" aria-pressed="false">Ändra ordning</button>' : ''}
      <button class="ghost danger" id="cdel">Ta bort samlingen</button>` : ''}</div></div></div></div>
    <div id="cbody" style="margin-top:20px"></div><p class="sr-only" aria-live="polite" id="clive"></p>`;
  const grid = () => {
    $('#cbody').innerHTML = c.items.length ? `<div class="grid" data-row="ucol" data-ucol="${+c.id}"${c.editable && !c.smart ? ' data-edit="1"' : ''}>${c.items.map(i => card(i)).join('')}</div>`
      : emptyState({ icon: '🗂', title: 'Samlingen är tom', text: c.smart ? 'Inget i biblioteket matchar filtret just nu.' : 'Lägg till filmer och serier med ⋮ → ”Lägg till i samling…” eller från titelsidan.' });
  };
  grid();
  if (first) $('#playfirst').onclick = (e) => startPlay(e.currentTarget, first.id, first.position || 0);
  if ($('#cshuffle')) $('#cshuffle').onclick = act(async (e) => {
    const b = e.currentTarget, r = await api(`/custom-collections/${+c.id}/shuffle`);
    toast(r.play.kind === 'episode' ? `Blandat: ${r.item.title} · ${sxe(r.play)}` : `Blandat: ${r.play.title}`);
    startPlay(b, r.play.id, r.play.watched ? 0 : r.play.position || 0);
  });
  if (!c.editable) return;
  $('#cedit').onclick = act(async () => { if (await collectionForm(c)) route(); });
  $('#cdel').onclick = act(async () => { if (await deleteCollection(c)) location.hash = '#/collections'; });
  const ob = $('#corder');
  if (ob) ob.onclick = () => {
    const on = ob.getAttribute('aria-pressed') !== 'true';
    ob.setAttribute('aria-pressed', String(on));
    ob.textContent = on ? 'Klar' : 'Ändra ordning';
    if (on) orderList(c); else grid();
  };
};

/** Manuell ordning: en lista med ↑/↓ per titel (tangentbord) och dra och släpp (mus/pekskärm). Sparas direkt. */
function orderList(c) {
  const body = $('#cbody'), live = $('#clive');
  const li = (i, n) => `<li draggable="true" data-id="${+i.id}"><span class="grip" aria-hidden="true">⠿</span><span class="cn">${n + 1}. ${esc(i.title)}${i.year ? ` <span class="muted">(${+i.year})</span>` : ''}</span>
    ${iconButton({ icon: '↑', label: `Flytta upp ${i.title}`, data: { mv: -1 } })}${iconButton({ icon: '↓', label: `Flytta ned ${i.title}`, data: { mv: 1 } })}</li>`;
  const draw = (focus) => {
    body.innerHTML = `<p class="muted small">Dra titlarna eller använd ↑ och ↓. Ordningen sparas direkt.</p><ol class="corder">${c.items.map(li).join('')}</ol>`;
    $$('.corder li', body).forEach((el, n) => {
      el.querySelector('[data-mv="-1"]').disabled = n === 0;
      el.querySelector('[data-mv="1"]').disabled = n === c.items.length - 1;
    });
    if (focus) {
      const el = body.querySelector(`li[data-id="${focus.id}"]`);
      (el?.querySelector(`[data-mv="${focus.dir}"]:not([disabled])`) || el?.querySelector('button:not([disabled])'))?.focus({ preventScroll: false });
    }
  };
  const save = async (moved) => {
    const pos = c.items.indexOf(moved);
    live.textContent = `${moved.title} är nu på plats ${pos + 1} av ${c.items.length}`;
    try { await api(`/custom-collections/${c.id}/order`, { method: 'PUT', body: { ids: c.items.map(i => i.id) }, bg: true }); }
    catch (e) { toastErr(e); }
  };
  const move = (from, to, dir) => {
    if (to < 0 || to >= c.items.length || from === to) return;
    const [x] = c.items.splice(from, 1);
    c.items.splice(to, 0, x);
    draw(dir ? { id: x.id, dir } : null);
    save(x);
  };
  body.onclick = (e) => {
    const b = e.target.closest('[data-mv]'); if (!b) return;
    const id = +b.closest('li').dataset.id, from = c.items.findIndex(i => i.id === id), dir = +b.dataset.mv;
    move(from, from + dir, dir);
  };
  let dragId = null;
  body.ondragstart = (e) => { const el = e.target.closest?.('li'); if (!el) return; dragId = +el.dataset.id; el.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(dragId)); } catch {} };
  body.ondragend = () => { dragId = null; $$('.corder li', body).forEach(x => x.classList.remove('drag', 'over')); };
  body.ondragover = (e) => { const el = e.target.closest?.('li'); if (!el || dragId == null) return; e.preventDefault(); $$('.corder li.over', body).forEach(x => x !== el && x.classList.remove('over')); el.classList.add('over'); };
  body.ondrop = (e) => {
    const el = e.target.closest?.('li'); if (!el || dragId == null) return;
    e.preventDefault();
    move(c.items.findIndex(i => i.id === dragId), c.items.findIndex(i => i.id === +el.dataset.id), 0);
  };
  draw();
}
