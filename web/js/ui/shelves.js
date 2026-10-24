// Hyllor och kortstorlek: ‹ › på varje vågrät rad (bläddrar en sida, inaktiva vid ändarna), piltangenter/D-pad
// mellan korten (i sidled inom en rad, upp/ner till närmaste kort i raden ovanför/under) och reglaget för
// kortstorlek i menyraden (sparas i webbläsaren).
import { $, esc, main, store } from '../core.js';

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const SIZE = { min: 90, max: 220, def: 125 };

/** Rubriken för en hylla (texten i h2 utan länkarna efter) – för knapparnas namn */
function shelfName(h2) {
  const t = h2?.childNodes[0]?.textContent?.trim();
  return t || h2?.textContent?.trim() || 'raden';
}
function update(sh) {
  const nav = sh._nav; if (!nav) return;
  const max = sh.scrollWidth - sh.clientWidth;
  nav.hidden = max <= 2;
  const [prev, next] = nav.children;
  const atStart = sh.scrollLeft <= 2, atEnd = sh.scrollLeft >= max - 2;
  // Fokus på en knapp som blir inaktiv flyttas till den andra (annars hamnar fokus på body)
  if (atStart && document.activeElement === prev && !atEnd) next.focus({ preventScroll: true });
  if (atEnd && document.activeElement === next && !atStart) prev.focus({ preventScroll: true });
  prev.disabled = atStart; next.disabled = atEnd;
}
/** Bläddrar en "sida": så många hela kort som får plats */
function page(sh, dir) {
  const first = sh.querySelector('.card, .mcard, a');
  const step = first ? first.getBoundingClientRect().width + parseFloat(getComputedStyle(sh).columnGap || 0) : 160;
  const n = Math.max(1, Math.floor((sh.clientWidth + 1) / step));
  sh.scrollBy({ left: dir * n * step, behavior: reduce() ? 'auto' : 'smooth' });
}
const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((es) => es.forEach(e => update(e.target))) : null;
/** Lägger till ‹ › på nya hyllor i huvudytan */
function enhance() {
  for (const sh of main.querySelectorAll('.shelf:not([data-nav])')) {
    sh.dataset.nav = '1';
    const h2 = sh.previousElementSibling?.tagName === 'H2' ? sh.previousElementSibling : null;
    if (!h2) continue;
    const name = shelfName(h2);
    const nav = document.createElement('div');
    nav.className = 'shelf-nav';
    nav.innerHTML = `<button type="button" class="snav" aria-label="Bläddra bakåt i ${esc(name)}" title="Föregående"><span aria-hidden="true">‹</span></button>`
      + `<button type="button" class="snav" aria-label="Bläddra framåt i ${esc(name)}" title="Nästa"><span aria-hidden="true">›</span></button>`;
    nav.children[0].onclick = () => page(sh, -1);
    nav.children[1].onclick = () => page(sh, 1);
    h2.after(nav);
    sh.parentElement.classList.add('has-nav');
    sh._nav = nav;
    sh.addEventListener('scroll', () => update(sh), { passive: true });
    ro?.observe(sh);
    update(sh);
  }
}

// ---------- piltangenter mellan korten ----------
const KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
/** Närmaste kort i pilens riktning (geometriskt – fungerar i rutnät, hyllor och avsnittslistor) */
function nearest(from, [dx, dy]) {
  const r = from.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const sameShelf = from.closest('.shelf');
  const cands = [];
  for (const el of main.querySelectorAll('.card > .clink')) {
    if (el === from) continue;
    const q = el.getBoundingClientRect();
    if (!q.width) continue;
    const ox = q.left + q.width / 2 - cx, oy = q.top + q.height / 2 - cy;
    if (dx) {
      // I sidled: bara kort på samma rad (överlappar höjdmässigt), i en hylla bara samma hylla
      if (ox * dx <= r.width / 4 || q.bottom <= r.top + 4 || q.top >= r.bottom - 4) continue;
      if (sameShelf && el.closest('.shelf') !== sameShelf) continue;
      cands.push({ el, d: Math.abs(ox) + Math.abs(oy) * 4 });
    } else {
      if (oy * dy <= r.height / 4) continue;
      cands.push({ el, oy: Math.abs(oy), ox: Math.abs(ox) });
    }
  }
  if (!cands.length) return null;
  if (dx) return cands.reduce((a, b) => b.d < a.d ? b : a).el;
  // Upp/ner: närmaste raden först (även en kort rad med ett enda kort), sedan kortet närmast i sidled
  const row = Math.min(...cands.map(c => c.oy));
  return cands.filter(c => c.oy <= row + r.height / 2).reduce((a, b) => b.ox < a.ox ? b : a).el;
}
function onKey(e) {
  const d = KEYS[e.key];
  if (!d || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const from = e.target;
  if (!from?.matches?.('.card > .clink') || !main.contains(from)) return;
  const to = nearest(from, d);
  if (!to) {
    // ↑ från översta raden: till området ovanför korten som tar emot fokus (data-nav-up, t.ex. Utvalt på startsidan)
    const up = e.key === 'ArrowUp' && main.querySelector('[data-nav-up]');
    const t = up && [...up.querySelectorAll('button, a[href]')].find(x => !x.disabled && !x.closest('[inert]'));
    if (t) { e.preventDefault(); t.focus({ preventScroll: true }); up.scrollIntoView({ block: 'nearest', behavior: reduce() ? 'auto' : 'smooth' }); }
    return;
  }
  e.preventDefault();
  to.focus({ preventScroll: true });
  to.closest('.card').scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce() ? 'auto' : 'smooth' });
}

/** Startar hyllornas pilar och tangentbordsnavigeringen (anropas en gång från app.js) */
export function initShelves() {
  let queued = false;
  new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; enhance(); }); })
    .observe(main, { childList: true, subtree: true });
  document.addEventListener('keydown', onKey);
}

// ---------- kortstorlek ----------
const clampSize = (v) => Math.min(SIZE.max, Math.max(SIZE.min, Math.round(+v || SIZE.def)));
function applySize(v) { document.documentElement.style.setProperty('--card-w', clampSize(v) + 'px'); }
/** Reglaget för kortstorlek (#cardsize) – värdet sparas i webbläsaren */
export function initCardSize() {
  const v = clampSize(store.get('cardw', SIZE.def));
  applySize(v);
  const r = $('#cardsize'); if (!r) return;
  r.min = SIZE.min; r.max = SIZE.max; r.value = v;
  r.setAttribute('aria-valuetext', `${v} pixlar`);
  r.oninput = () => { applySize(r.value); r.setAttribute('aria-valuetext', `${clampSize(r.value)} pixlar`); };
  r.onchange = () => { store.set('cardw', clampSize(r.value)); main.querySelectorAll('.shelf[data-nav]').forEach(update); };
}
