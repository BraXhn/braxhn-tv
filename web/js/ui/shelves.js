// Hyllor och kortstorlek: ‹ › på varje vågrät rad (bläddrar en sida, inaktiva vid ändarna) och reglaget för
// kortstorlek i menyraden (sparas i webbläsaren). Piltangenter/D-pad mellan korten: ui/spatial.js.
import { $, esc, main, store, t } from '../core.js';

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');
const SIZE = { min: 90, max: 220, def: 125 };

/** Rubriken för en hylla (texten i h2 utan länkarna efter) – för knapparnas namn */
function shelfName(h2) {
  const tt = h2?.childNodes[0]?.textContent?.trim();
  return tt || h2?.textContent?.trim() || t('raden');
}
/** Läser hyllans skrolläge (bara läsningar, så att flera hyllor kan mätas utan en layout per hylla) */
const measure = (sh) => ({ sh, max: sh.scrollWidth - sh.clientWidth, x: sh.scrollLeft });
function apply({ sh, max, x }) {
  const nav = sh._nav; if (!nav) return;
  nav.hidden = max <= 2;
  const [prev, next] = nav.children;
  const atStart = x <= 2, atEnd = x >= max - 2;
  // Fokus på en knapp som blir inaktiv flyttas till den andra (annars hamnar fokus på body)
  if (atStart && document.activeElement === prev && !atEnd) next.focus({ preventScroll: true });
  if (atEnd && document.activeElement === next && !atStart) prev.focus({ preventScroll: true });
  prev.disabled = atStart; next.disabled = atEnd;
}
function update(sh) { if (sh._nav) apply(measure(sh)); }
/** Bläddrar en "sida": så många hela kort som får plats */
function page(sh, dir) {
  const first = sh.querySelector('.card, .mcard, a');
  const step = first ? first.getBoundingClientRect().width + parseFloat(getComputedStyle(sh).columnGap || 0) : 160;
  const n = Math.max(1, Math.floor((sh.clientWidth + 1) / step));
  sh.scrollBy({ left: dir * n * step, behavior: reduce() ? 'auto' : 'smooth' });
}
const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((es) => es.map(e => measure(e.target)).forEach(apply)) : null;
/** Lägger till ‹ › på nya hyllor i huvudytan */
function enhance() {
  for (const sh of main.querySelectorAll('.shelf:not([data-nav])')) {
    sh.dataset.nav = '1';
    const h2 = sh.previousElementSibling?.tagName === 'H2' ? sh.previousElementSibling : null;
    if (!h2) continue;
    const name = shelfName(h2);
    const nav = document.createElement('div');
    nav.className = 'shelf-nav';
    nav.innerHTML = `<button type="button" class="snav" aria-label="${t('Bläddra bakåt i {name}', { name: esc(name) })}" title="${t('Föregående')}"><span aria-hidden="true">‹</span></button>`
      + `<button type="button" class="snav" aria-label="${t('Bläddra framåt i {name}', { name: esc(name) })}" title="${t('Nästa')}"><span aria-hidden="true">›</span></button>`;
    nav.children[0].onclick = () => page(sh, -1);
    nav.children[1].onclick = () => page(sh, 1);
    h2.after(nav);
    sh.parentElement.classList.add('has-nav');
    sh._nav = nav;
    sh.addEventListener('scroll', () => update(sh), { passive: true });
    // ResizeObserver anropar update() första gången efter layouten – ett direkt anrop här tvingade fram en ny layout av
    // hela sidan för varje hylla (läser scrollWidth, skriver hidden/disabled)
    if (ro) ro.observe(sh); else update(sh);
  }
}

/** Startar hyllornas pilar (anropas en gång från app.js). Piltangenterna mellan korten sköts av ui/spatial.js (router.js). */
export function initShelves() {
  let queued = false;
  new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; enhance(); }); })
    .observe(main, { childList: true, subtree: true });
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
  r.setAttribute('aria-valuetext', t('{v} pixlar', { v }));
  r.oninput = () => { applySize(r.value); r.setAttribute('aria-valuetext', t('{value} pixlar', { value: clampSize(r.value) })); };
  r.onchange = () => { store.set('cardw', clampSize(r.value)); main.querySelectorAll('.shelf[data-nav]').forEach(update); };
}
