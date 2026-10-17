// Snabbåtgärder på affischkorten (⋮, högerklick, långtryck, Menu-tangenten): spela, sedd/osedd, Min lista,
// ta bort från Fortsätt titta, följ, titta tillsammans och – för administratörer – metadataverktygen.
// Kortet uppdateras direkt (optimistiskt) och ändringar som går att ångra får "Ångra" i toasten.
import { $$, act, api, fmtTime, me, sxe, toast, toastErr } from '../core.js';
import { play, startPlay } from '../player/video.js';
import { route } from '../router.js';
import { editItem, matchItem, refreshMeta } from '../views/item.js';
import { card, cardItem, seasonCard, seasonItem, setCardItem } from './cards.js';
import { closeMenu, contextMenu, openMenu } from './menu.js';

/** Ritar om alla kort för titeln (samma titel kan finnas i flera rader) och behåller fokus */
function redraw(it) {
  setCardItem(it);
  for (const el of $$(`.card[data-id="${it.id}"]`)) {
    const had = el.contains(document.activeElement) ? (document.activeElement.classList.contains('cmenu') ? '.cmenu' : '.clink') : null;
    const tmp = document.createElement('div');
    tmp.innerHTML = card(it, el.classList.contains('land'), { menu: !!el.querySelector('.cmenu') });
    const n = tmp.firstElementChild;
    el.replaceWith(n);
    if (had) n.querySelector(had)?.focus({ preventScroll: true });
  }
}
/** Tar bort kortet ur sin rad (döljer raden om den blir tom). Returnerar en funktion som sätter tillbaka det. */
function removeCard(el) {
  const parent = el.parentNode, next = el.nextSibling, section = el.closest('.section');
  const focusNext = el.contains(document.activeElement);
  const sib = el.nextElementSibling || el.previousElementSibling;
  el.remove();
  if (section && !parent.querySelector('.card')) section.hidden = true;
  if (focusNext) (sib?.querySelector('.clink') || document.querySelector('#main h1, #main a, #main button'))?.focus({ preventScroll: true });
  return () => { parent.insertBefore(el, next && next.parentNode === parent ? next : null); if (section) section.hidden = false; };
}
const rowOf = (el) => el.closest('[data-row]')?.dataset.row || '';
const undoToast = (msg, undo) => toast(msg, { action: { label: 'Ångra', onClick: act(undo) } });

async function setWatched(it, watched) {
  const prev = { watched: it.watched, position: it.position, watchedEpisodes: it.watchedEpisodes };
  const apply = (v) => redraw(Object.assign(it, v));
  apply(it.kind === 'show' ? { watched, watchedEpisodes: watched ? it.episodes : 0 } : { watched, position: 0 });
  try { await api(`/items/${it.id}/watched`, { method: 'POST', body: { watched }, bg: true }); }
  catch (e) { apply(prev); return toastErr(e); }
  const msg = watched ? 'Markerad som sedd' : 'Markerad som osedd';
  // En serie som var delvis sedd går inte att återställa avsnitt för avsnitt – då ingen Ångra
  const exact = it.kind !== 'show' || !prev.watchedEpisodes || prev.watched;
  if (!exact) return toast(msg);
  undoToast(msg, async () => {
    apply(prev);
    await api(`/items/${it.id}/watched`, { method: 'POST', body: { watched: !!prev.watched }, bg: true });
    if (prev.position > 0) await api(`/items/${it.id}/continue`, { method: 'POST', body: { hide: false, position: prev.position }, bg: true });
  });
}
async function setWatchlist(it, el, add) {
  const restore = !add && rowOf(el) === 'watchlist' ? removeCard(el) : null;
  try { await api(`/items/${it.id}/watchlist`, { method: 'POST', body: { add }, bg: true }); }
  catch (e) { restore?.(); return toastErr(e); }
  const what = it.kind === 'episode' ? 'Serien' : 'Titeln';
  undoToast(add ? `${what} ligger nu i Min lista` : `${what} är borttagen från Min lista`, async () => {
    restore?.();
    await api(`/items/${it.id}/watchlist`, { method: 'POST', body: { add: !add }, bg: true });
  });
}
async function hideContinue(it, el) {
  const restore = removeCard(el);
  let r;
  try { r = await api(`/items/${it.id}/continue`, { method: 'POST', body: { hide: true }, bg: true }); }
  catch (e) { restore(); return toastErr(e); }
  const pos = r.position;
  if (pos !== it.position) redraw(Object.assign(it, { position: 0 }));
  undoToast('Borttagen från Fortsätt titta', async () => {
    restore();
    await api(`/items/${it.id}/continue`, { method: 'POST', body: { hide: false, position: pos }, bg: true });
    if (pos) redraw(Object.assign(it, { position: pos }));
  });
}
async function setFollow(it, follow) {
  const r = await api(`/items/${it.id}/follow`, { method: 'POST', body: { follow }, bg: true });
  const name = it.kind === 'episode' ? it.showTitle || 'serien' : it.title;
  toast(r.following ? `Du följer ${name} – nya avsnitt visas under Nytt för dig` : `Du följer inte längre ${name}`);
}
async function seasonWatched(it) {
  await api(`/items/${it.show}/watched?season=${it.season}`, { method: 'POST', body: { watched: true }, bg: true });
  toast(`Säsong ${it.season} är markerad som sedd`);
  if (location.hash === `#/item/${it.show}`) route();
}

/** Menyns val för en titel. st = /items/:id/state (Min lista, följer, nästa avsnitt). */
export function cardActions(it, st, el) {
  const show = it.kind === 'show', media = !show, ep = it.kind === 'episode';
  const pos = media && it.position > 30 ? it.position : 0;
  const admin = !!me?.adminHere;
  return [
    { icon: '▶', label: `Fortsätt från ${fmtTime(pos)}`, hidden: !pos, onSelect: () => startPlay(null, it.id, pos) },
    { icon: pos ? '↺' : '▶', label: pos ? 'Spela från början' : 'Spela', hidden: !media, onSelect: () => startPlay(null, it.id, 0) },
    { icon: '▶', label: st.next ? `${st.next.position > 0 ? 'Fortsätt' : 'Spela'} ${sxe(st.next)}` : '', hidden: !show || !st.next,
      onSelect: () => startPlay(null, st.next.id, st.next.position || 0) },
    'separator',
    { icon: '✓', label: it.watched ? 'Markera som osedd' : (show ? 'Markera serien som sedd' : 'Markera som sedd'), onSelect: () => setWatched(it, !it.watched) },
    { icon: '✓', label: `Markera säsong ${it.season} som sedd`, hidden: !ep, onSelect: act(() => seasonWatched(it)) },
    { icon: st.inWatchlist ? '−' : '+', label: st.inWatchlist ? 'Ta bort från Min lista' : (ep ? 'Lägg serien i Min lista' : 'Lägg till i Min lista'),
      onSelect: () => setWatchlist(it, el, !st.inWatchlist) },
    { icon: '✕', label: 'Ta bort från Fortsätt titta', hidden: rowOf(el) !== 'continue' || !media, onSelect: () => hideContinue(it, el) },
    { icon: st.following ? '🔕' : '🔔', label: st.following ? 'Sluta följa serien' : 'Följ serien', hidden: st.following == null,
      onSelect: act(() => setFollow(it, !st.following)) },
    { icon: '👥', label: 'Titta tillsammans…', hidden: !media || !!me?.kid, onSelect: () => play(it.id, pos, { startParty: true }).catch(toastErr) },
    { icon: '⤓', label: 'Ladda ner filen', hidden: !media, href: `/api/stream/${+it.id}/download`, download: true },
    'separator',
    { icon: 'ℹ', label: 'Visa information', href: `#/item/${+it.id}` },
    { icon: '↗', label: 'Gå till serien', hidden: !ep, href: `#/item/${+it.show}` },
    'separator',
    { icon: '⟳', label: 'Uppdatera metadata', hidden: !admin, onSelect: () => refreshMeta(it) },
    { icon: '?', label: 'Fel titel?', hidden: !admin || ep, onSelect: () => matchItem(it) },
    // Listorna saknar beskrivningen – hämta hela titeln så att Redigera inte tömmer den
    { icon: '✎', label: 'Redigera…', hidden: !admin, onSelect: act(async () => editItem(await api('/items/' + it.id, { bg: true }))) },
    { icon: '⟲', label: 'Analysera intro och eftertexter igen', hidden: !admin || !ep,
      onSelect: act(async () => { await api(`/items/${it.id}/markers/redetect`, { method: 'POST', bg: true }); toast('Analyserar i bakgrunden'); }) },
  ];
}

/** Menyns val för ett säsongskort (nya avsnitt i en säsong) */
export function seasonActions(g, el) {
  const admin = !!me?.adminHere, sn = g.season === 0 ? 'specialavsnitten' : `säsong ${g.season}`;
  return [
    { icon: '▶', label: g.next ? `${g.next.position > 0 ? 'Fortsätt' : 'Spela'} S${g.season} · A${g.next.episode}` : '', hidden: !g.next,
      onSelect: () => startPlay(null, g.next.id, g.next.position || 0) },
    'separator',
    { icon: '✓', label: `Markera ${sn} som sedd`, hidden: !g.unwatched, onSelect: act(async () => {
      await api(`/items/${g.show}/watched?season=${g.season}`, { method: 'POST', body: { watched: true }, bg: true });
      Object.assign(g, { unwatched: 0, next: null });
      const tmp = document.createElement('div'); tmp.innerHTML = seasonCard(g);
      const had = el.contains(document.activeElement); const n = tmp.firstElementChild; el.replaceWith(n);
      if (had) n.querySelector('.clink')?.focus({ preventScroll: true });
      toast(`${g.showTitle}: ${sn} är markerad som sedd`);
    }) },
    { icon: '☰', label: `Visa ${sn}`, href: `#/item/${+g.show}/${+g.season}` },
    { icon: 'ℹ', label: 'Gå till serien', href: `#/item/${+g.show}` },
    'separator',
    { icon: '✎', label: 'Redigera serien…', hidden: !admin, onSelect: act(async () => editItem(await api('/items/' + g.show, { bg: true }))) },
  ];
}

let opening = 0;
/** Öppnar menyn för ett kort. point = muspekarens läge (högerklick/långtryck), annars vid ⋮-knappen. */
export async function openCardMenu(el, point = null) {
  const btn = el.querySelector('.cmenu');
  if (!btn) return;
  if (el.dataset.season != null) {
    const g = seasonItem(el.dataset.show, el.dataset.season);
    if (!g) return;
    const name = `${g.showTitle} – ${g.season === 0 ? 'Specialavsnitt' : 'Säsong ' + g.season}`;
    return openMenu(btn, seasonActions(g, el), { point, title: name, label: `Åtgärder för ${name}` });
  }
  const it = cardItem(el.dataset.id);
  if (!it) return;
  const seq = ++opening;
  let st;
  try { st = await api(`/items/${it.id}/state`, { bg: true }); }
  catch (e) { return toastErr(e); }
  if (seq !== opening || !btn.isConnected) return;
  const name = it.kind === 'episode' ? `${it.showTitle ? it.showTitle + ' ' : ''}${sxe(it)}` : it.title;
  openMenu(btn, cardActions(it, st, el), { point, title: name, label: `Åtgärder för ${name}` });
}

/** ▶ på kortet: spelar direkt – filmer och avsnitt där man slutade, serier nästa avsnitt */
async function playCard(b) {
  const it = cardItem(b.dataset.cplay);
  if (b.dataset.pos != null || !it) return startPlay(b, +b.dataset.cplay, +b.dataset.pos || 0);
  if (it.kind !== 'show') return startPlay(b, it.id, it.position > 30 ? it.position : 0);
  b.disabled = true;
  try {
    const st = await api(`/items/${it.id}/state`, { bg: true });
    if (!st.next) return toast('Inga avsnitt att spela');
    await play(st.next.id, st.next.position || 0);
  } catch (e) { toastErr(e); } finally { b.disabled = false; }
}

/** Kopplar knapparna på korten (▶ ✎ ⋮) och snabbmenyn för alla kort (delegerat – fungerar även för kort som ritas senare) */
export function initCardMenus() {
  document.addEventListener('click', (e) => {
    const p = e.target.closest?.('.cplay');
    if (p) { e.preventDefault(); e.stopPropagation(); return playCard(p); }
    const ed = e.target.closest?.('.cedit');
    if (ed) { e.preventDefault(); e.stopPropagation(); return act(async () => editItem(await api('/items/' + ed.dataset.cedit, { bg: true })))(); }
    const b = e.target.closest?.('.cmenu'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (b.getAttribute('aria-expanded') === 'true') return closeMenu();
    openCardMenu(b.closest('.card'));
  });
  contextMenu(document, '.card[data-id], .card[data-season]', (el, point) => { if (el.querySelector('.cmenu')) openCardMenu(el, point); });
}
