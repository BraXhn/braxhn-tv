// Rumslig navigering (fjärrkontroll/D-pad): piltangenterna väljer närmaste fokuserbara element i pilens riktning
// utifrån getBoundingClientRect. Laddas vid behov (router.js: i förväg i TV-läge, annars vid första piltrycket) och
// anropas därifrån och från spelaren (player/controls.js). Importerar bara core.js.
//
// Regler (docs/ui-komponenter.md, "Rumslig navigering"):
// - Kandidater är synliga, fokuserbara element i området (öppen dialog > helskärmsspelaren > hela sidan) som inte
//   ligger i något inert. I ett kort är bara kortets länk ett mål (▶ ✎ ⋮ nås med Menu-tangenten och titelsidan);
//   [data-nav-skip] tar bort ett element (och allt i det) ur navigeringen.
// - Mål: bara element som ligger bortom kanten i pilens riktning. Poäng: avståndet i pilens riktning + 2 × glappet i
//   sidled mot "föredragen" rad/kolumn (0 när målet ligger i den) + lite för avståndet till dess mitt. Den föredragna
//   raden/kolumnen följer med när man trycker flera gånger längs samma axel (så länge målen ligger i den), så att
//   ner-ner-upp genom olika breda rader kommer tillbaka till samma kort.
// - I en hylla (vågrät rullning) stannar ←/→ i hyllan; → vid slutet gör ingenting, ← vid början går vidare (sidomenyn).
// - Prestanda: bara elementen nära det fokuserade i dokumentordning (±WINDOW) plus de fasta delarna (menyraden,
//   sidomenyn, flikmenyn, ljudspelaren, mini-spelaren) mäts – aldrig tusentals kort per tryck. Hittas inget där
//   provas hela området en gång.
// - Fokus syns alltid: den närmaste rullande behållaren (hyllan, dialogen) och sidan rullar så att målet ligger
//   innanför menyraden och de fasta raderna i nederkant (sidan centreras på målet i TV-läge).

const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable=true]';
const CHROME = '#top, #rail, #tabbar, #mbar, #rbar, #lyrics, #player.mini';
const WINDOW = 120;
const DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');

/** Kan elementet få fokus med navigeringen? (bara egenskaper som inte kräver layout) */
function eligible(el) {
  if (el.disabled || el.getAttribute('tabindex') === '-1' || el.getAttribute('aria-disabled') === 'true' && el.tagName !== 'A') return false;
  if (el.matches('#skiplink, .pageh, video, audio, dialog, .pop')) return false;
  if (el.closest('[inert], [data-nav-skip]')) return false;
  const c = el.closest('.card');
  if (c && el !== c && !el.matches('.clink')) return false;
  return true;
}
/** Synlig ruta (null om elementet inte syns) */
function box(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}
const shown = (el) => { const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0; };

/** Området navigeringen håller sig inom: översta öppna dialogen, helskärmsspelaren eller hela sidan */
export function scopeOf(from) {
  const dlg = [...document.querySelectorAll('dialog[open]')].pop();
  if (dlg) return dlg;
  const p = document.getElementById('player');
  if (p && !p.hidden && !p.classList.contains('mini')) {
    // En öppen panel i spelaren (inställningar, kapitel) håller navigeringen tills den stängs
    const panel = from?.closest?.('#setp:not([hidden]), #chlist:not([hidden])');
    return panel || p;
  }
  return document.body;
}

/** Kandidaterna nära from (dokumentordning) och de fasta delarna – utan att mäta hela sidan */
function candidates(scope, from, all = false) {
  const list = scope.querySelectorAll(SEL);
  const out = new Set();
  if (all || list.length <= WINDOW * 2) { for (const el of list) out.add(el); return out; }
  let i = -1;
  if (from && scope.contains(from)) for (let k = 0; k < list.length; k++) if (list[k] === from) { i = k; break; }
  if (i < 0) i = firstVisible(list);
  for (let k = Math.max(0, i - WINDOW); k < Math.min(list.length, i + WINDOW); k++) out.add(list[k]);
  if (scope === document.body) for (const root of document.querySelectorAll(CHROME)) for (const el of root.querySelectorAll(SEL)) out.add(el);
  return out;
}
/** Första elementet som syns i fönstret (binärsökning – dokumentordningen följer i stort sett höjden på sidan) */
function firstVisible(list) {
  let lo = 0, hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1, r = list[mid].getBoundingClientRect();
    if (r.height && r.bottom < 0) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Föredragen rad/kolumn: sparas när man flyttar flera gånger längs samma axel
let sticky = null; // { el, axis, band: [från, till] i sidled, prev: elementet man kom från, dir }
const OPP = { left: 'right', right: 'left', up: 'down', down: 'up' };
// Grupper som pilarna helst stannar i när det finns ett mål i samma rad/kolumn där (menyraden, sidomenyn …)
const GROUP = '#top, #rail, #tabbar, #mbar, #rbar, .pbar, .crow, .tabs, .row';
/** Raden/kolumnen man rör sig i: den sparade (flera tryck längs samma axel) eller from:s egen */
const bandOf = (from, r, axis) => sticky && sticky.el === from && sticky.axis === axis ? sticky.band : axis === 'x' ? [r.top, r.bottom] : [r.left, r.right];

function pick(from, r, dir, cands) {
  const [dx, dy] = DIRS[dir];
  const axis = dx ? 'x' : 'y';
  const [lo, hi] = bandOf(from, r, axis), ref = (lo + hi) / 2;
  const scroller = dx ? hScroller(from) : null;
  const group = from.closest(GROUP);
  const scored = [];
  for (const el of cands) {
    if (el === from || el.contains(from) || from.contains(el) || !eligible(el)) continue;
    const q = box(el); if (!q) continue;
    // Målet ska ligga bortom kanten i pilens riktning (högst lite överlapp: förstorat fokus, avrundning) – ett
    // element bredvid som sticker upp en bit (sidomenyn) räknas inte som "ovanför"
    let main, gap, off;
    if (dx > 0) main = q.left - r.right;
    else if (dx < 0) main = r.left - q.right;
    else if (dy > 0) main = q.top - r.bottom;
    else main = r.top - q.bottom;
    if (main < -Math.min(10, 0.3 * (dx ? Math.min(q.width, r.width) : Math.min(q.height, r.height)))) continue;
    if (dx) { gap = Math.max(0, Math.max(lo, q.top) - Math.min(hi, q.bottom)); off = Math.abs(q.top + q.height / 2 - ref); }
    else { gap = Math.max(0, Math.max(lo, q.left) - Math.min(hi, q.right)); off = Math.abs(q.left + q.width / 2 - ref); }
    scored.push({ el, s: Math.max(0, main) + gap * 2 + off * 0.15, same: scroller ? scroller.contains(el) : false, beam: gap === 0 && group?.contains(el) });
  }
  if (scroller) {
    // I en hylla: stanna i hyllan. → vid slutet gör ingenting, ← vid början får lämna den (t.ex. till sidomenyn)
    const inside = scored.filter(c => c.same);
    if (inside.length) return best(inside);
    if (dx > 0) return null;
  }
  // I menyraden, sidomenyn, en knapprad: längs gruppen så länge det finns något i samma rad/kolumn där
  const inGroup = group ? scored.filter(c => c.beam) : [];
  return best(inGroup.length ? inGroup : scored);
}
function best(list) {
  list.sort((a, b) => a.s - b.s);
  // Det bästa som verkligen syns (visibility/opacity kontrolleras bara för de få närmaste)
  for (const c of list.slice(0, 8)) if (shown(c.el)) return c.el;
  return null;
}
/** Närmaste förälder som rullar i sidled (hyllor, rader med kort) */
function hScroller(el) {
  for (let p = el.parentElement, n = 0; p && p !== document.body && n < 8; p = p.parentElement, n++) {
    if (p.classList.contains('shelf')) return p;
    if (p.scrollWidth > p.clientWidth + 2) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return p; }
  }
  return null;
}

/**
 * Flyttar fokus en gång i riktningen. Utan fokus (eller fokus utanför området): fokus på första vettiga elementet.
 * @param {'left'|'right'|'up'|'down'} dir
 * @param {{ from?: Element, scope?: Element, scroll?: boolean }} [o]  scroll: rulla sidan när inget mål finns upp/ner
 * @returns {Element|null} elementet som fick fokus
 */
export function move(dir, { from = document.activeElement, scope, scroll = true } = {}) {
  scope ||= scopeOf(from);
  // Utgångspunkt: det fokuserade elementet – även om det självt inte är ett mål (⋮ i ett kort). Sidans rubrik (fokus
  // efter sidbyte) och huvudytan räknas som inget fokus.
  const r = from && from !== document.body && scope.contains(from) && !from.matches('main, .pageh, h1[tabindex="-1"]') ? box(from) : null;
  if (!r) return focusFirst(scope);
  // Tillbaka åt motsatt håll: till elementet man just kom ifrån (ner och upp igen = samma kort)
  const back = sticky && sticky.el === from && sticky.dir === OPP[dir] && sticky.prev?.isConnected && scope.contains(sticky.prev) && eligible(sticky.prev) ? sticky.prev : null;
  let to = back && box(back) && pick(from, r, dir, [back]);
  if (!to) to = pick(from, r, dir, candidates(scope, from));
  if (!to && scope.querySelectorAll(SEL).length > WINDOW * 2) to = pick(from, r, dir, candidates(scope, from, true));
  if (!to) {
    // Inget mål: rulla sidan en bit (text längre ner ska gå att läsa) – fokus står kvar
    if (scroll && DIRS[dir][1] && scope === document.body) window.scrollBy({ top: DIRS[dir][1] * innerHeight * 0.4, behavior: reduce() ? 'auto' : 'smooth' });
    return null;
  }
  const axis = DIRS[dir][0] ? 'x' : 'y';
  // Föredragen rad/kolumn: följer med så länge målet ligger i den, annars blir målets egen den nya
  let band = bandOf(from, r, axis);
  const q = to.getBoundingClientRect(), own = axis === 'x' ? [q.top, q.bottom] : [q.left, q.right];
  if (own[1] <= band[0] || own[0] >= band[1]) band = own;
  focusEl(to);
  sticky = { el: to, axis, band, prev: from, dir };
  return to;
}

/** Fokus på el utan webbläsarens egen rullning, och rulla så att det syns */
export function focusEl(el) {
  if (!el) return null;
  el.focus({ preventScroll: true });
  reveal(el);
  return el;
}

/**
 * Första vettiga elementet i området: [data-tvfocus] (t.ex. Spela på titelsidan), annars första hyllans första kort,
 * första kortet, eller det första fokuserbara som syns på skärmen.
 */
export function firstIn(root = document.getElementById('main')) {
  if (!root) return null;
  for (const s of ['[data-tvfocus]', '.shelf .card > .clink', '.card > .clink', 'a.card']) {
    for (const el of root.querySelectorAll(s)) if (eligible(el) && box(el) && shown(el)) return el;
  }
  const list = root.querySelectorAll(SEL);
  const i = list.length > WINDOW * 2 ? firstVisible(list) : 0;
  for (let k = i; k < list.length && k < i + WINDOW * 2; k++) { const el = list[k]; if (eligible(el) && box(el) && shown(el)) return el; }
  return null;
}
/** Fokus på första vettiga elementet: i dialogen/spelaren, annars i huvudytan, annars i menyraden */
export function focusFirst(scope = scopeOf(null)) {
  const main = document.getElementById('main');
  const el = scope === document.body ? firstIn(main) || firstIn(document.getElementById('top')) : firstIn(scope);
  return focusEl(el);
}

// ---------- rullning ----------
/** Höjden som menyraden (överst) och fasta rader i nederkant (flikmenyn, ljudspelaren, mini-spelaren) täcker */
function safeArea() {
  let top = 0, bottom = innerHeight;
  const t = document.getElementById('top');
  if (t && !t.hidden) { const r = t.getBoundingClientRect(); if (r.bottom > 0 && r.top <= 0) top = r.bottom; }
  for (const s of ['#tabbar', '#mbar', '#rbar', '#player.mini']) {
    const el = document.querySelector(s); if (!el || el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (r.height && r.top > innerHeight / 2 && r.top < bottom) bottom = r.top;
  }
  return { top, bottom };
}
/** Rullar behållarna runt el (hyllan i sidled, dialogens innehåll) och sidan så att el syns helt */
export function reveal(el) {
  const behavior = reduce() ? 'auto' : 'smooth';
  // Behållare som rullar (inom sidan): hyllor, dialoger, paneler. Lite marginal så att nästa kort skymtar.
  for (let p = el.parentElement, n = 0; p && p !== document.body && p !== document.documentElement && n < 12; p = p.parentElement, n++) {
    const xs = p.scrollWidth > p.clientWidth + 2, ys = p.scrollHeight > p.clientHeight + 2;
    if (!xs && !ys) continue;
    const st = getComputedStyle(p);
    const sx = xs && /auto|scroll/.test(st.overflowX), sy = ys && /auto|scroll/.test(st.overflowY);
    if (!sx && !sy) continue;
    const pr = p.getBoundingClientRect(), r = el.getBoundingClientRect();
    const to = {};
    if (sx) {
      const pad = Math.min(64, pr.width / 8);
      if (r.left < pr.left + pad) to.left = p.scrollLeft - (pr.left + pad - r.left);
      else if (r.right > pr.right - pad) to.left = p.scrollLeft + (r.right - pr.right + pad);
    }
    if (sy) {
      const pad = Math.min(24, pr.height / 8);
      if (r.top < pr.top + pad) to.top = p.scrollTop - (pr.top + pad - r.top);
      else if (r.bottom > pr.bottom - pad) to.top = p.scrollTop + (r.bottom - pr.bottom + pad);
    }
    if ('left' in to || 'top' in to) p.scrollTo({ ...to, behavior });
  }
  // Sidan: målet innanför menyraden och raderna i nederkant (fasta element rullar inte)
  if (getComputedStyle(el).position === 'fixed' || el.closest(CHROME + ', dialog, .pop, #player')) return;
  const r = el.getBoundingClientRect(), { top, bottom } = safeArea();
  const margin = Math.min(48, (bottom - top) / 10);
  if (r.top >= top + margin && r.bottom <= bottom - margin) return;
  const tv = document.documentElement.classList.contains('tv');
  let dy;
  if (tv || r.height > bottom - top - 2 * margin) dy = r.top + r.height / 2 - (top + bottom) / 2; // TV: målet mitt på skärmen
  else dy = r.top < top + margin ? r.top - top - margin : r.bottom - bottom + margin;
  if (r.height > bottom - top - 2 * margin && dy > 0) dy = r.top - top - margin; // högre än skärmen: överkanten syns
  window.scrollTo({ top: Math.max(0, scrollY + dy), behavior });
}
