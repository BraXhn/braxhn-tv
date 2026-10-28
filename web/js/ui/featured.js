// Utvalt överst på startsidan: en stor bakgrundsbild med titel, beskrivning, Spela och Mer info för upp till fem
// osedda titlar (fältet featured i /api/home). Bläddrar långsamt av sig själv, men aldrig med prefers-reduced-motion,
// och står still medan muspekaren är över eller fokus är inuti, eller när användaren pausat (WCAG 2.2.2).
// Tangentbord/TV-fjärr: ← → mellan knapparna, ↓ till första hyllan (↑ från första hyllan hit, data-nav-up).
import { api, esc, fmtDur, heroUrl, later, toast, t } from '../core.js';
import { startPlay } from '../lazy.js';

const INTERVAL = 9000;
const HEX = /^#[0-9a-f]{6}$/i;
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');

function meta(it) {
  const p = [];
  if (it.year) p.push(esc(String(it.year)));
  if (it.kind === 'show') { if (it.seasons) p.push(it.seasons === 1 ? t('1 säsong') : t('{seasons} säsonger', { seasons: +it.seasons })); }
  else if (it.duration) p.push(esc(fmtDur(it.duration)));
  if (it.cert) p.push(esc(it.cert));
  if (it.rating) p.push(`<span class="star" aria-hidden="true">★</span> ${(+it.rating).toFixed(1)}<span class="sr-only"> ${t('i betyg')}</span>`);
  return p.map(x => `<span>${x}</span>`).join('');
}

/** HTML för karusellen. items = titlar från /api/home (med overview och backdrop). */
export function featuredHtml(items) {
  const n = items.length;
  const slides = items.map((it, i) => {
    const ph = HEX.test(it.phBackdrop || '') ? ` style="background:${it.phBackdrop}"` : '';
    const genres = (it.genres || []).slice(0, 3).join(' · ');
    return `<div class="feat-slide${i ? '' : ' on'}" role="group" aria-roledescription="${t('bild')}" aria-label="${t('{v} av {n}: {title}', { v: i + 1, n, title: esc(it.title) })}"${i ? ' inert aria-hidden="true"' : ''} data-i="${i}">
      <div class="feat-bd"${ph}><img ${i ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async" src="${heroUrl(`/api/image/${+it.id}/backdrop`)}" alt="" data-fb="1"></div>
      <div class="feat-in"><div class="feat-kicker">${t('Utvalt för dig{v}', { v: genres ? ` · ${esc(genres)}` : '' })}</div>
        <h2 class="feat-title">${esc(it.title)}</h2><div class="meta">${meta(it)}</div>
        ${it.overview ? `<p class="feat-ov">${esc(it.overview)}</p>` : ''}
        <div class="feat-acts"><button type="button" class="primary" data-fplay="${i}"><span aria-hidden="true">▶</span> ${t('Spela')}</button>
          ${t('<a class="btn" href="#/item/{id}">Mer info</a>', { id: +it.id })}</div></div></div>`;
  }).join('');
  const dots = n > 1 ? `<div class="feat-nav"><button type="button" class="feat-pause ghost small" aria-pressed="false"></button>
    <div class="feat-dots">${items.map((it, i) => `<button type="button" class="feat-dot" data-dot="${i}" aria-label="${t('Visa {title}', { title: esc(it.title) })}"${i ? '' : ' aria-current="true"'}></button>`).join('')}</div></div>` : '';
  return `<section class="feat" aria-roledescription="karusell" aria-label="${t('Utvalt')}" data-nav-up="1"><div class="feat-slides" aria-live="off">${slides}</div>${dots}</section>`;
}

/** Spela: filmer där man slutade (eller från början), serier nästa avsnitt */
async function playTitle(b, it) {
  if (it.kind !== 'show') return startPlay(b, it.id, it.position > 30 ? it.position : 0);
  b.disabled = true;
  try {
    const st = await api(`/items/${it.id}/state`, { bg: true });
    if (!st.next) return toast(t('Inga avsnitt att spela'));
    b.disabled = false;
    await startPlay(b, st.next.id, st.next.position || 0);
  } finally { b.disabled = false; }
}

/** Kopplar karusellen (efter featuredHtml i huvudytan) */
export function bindFeatured(el, items) {
  if (!el) return;
  const slides = [...el.querySelectorAll('.feat-slide')], dots = [...el.querySelectorAll('.feat-dot')];
  const live = el.querySelector('.feat-slides'), pauseBtn = el.querySelector('.feat-pause');
  let cur = 0, hover = false, focus = false, user = reduce(), cancel = null;
  const paused = () => user || hover || focus || document.hidden;
  const label = () => {
    if (!pauseBtn) return;
    // Pausad av användaren (eller rörelse avstängd i systemet): knappen startar visningen
    pauseBtn.setAttribute('aria-pressed', String(user));
    pauseBtn.setAttribute('aria-label', user ? t('Starta bildspelet') : t('Pausa bildspelet'));
    pauseBtn.title = pauseBtn.getAttribute('aria-label');
    pauseBtn.innerHTML = `<span aria-hidden="true">${user ? '▶' : '❚❚'}</span>`;
    // Skärmläsare får höra bytet bara när bildspelet står still (annars avbryts de var nionde sekund)
    live.setAttribute('aria-live', user ? 'polite' : 'off');
  };
  const show = (i, byUser = false) => {
    i = (i + slides.length) % slides.length;
    if (i === cur) return;
    const had = el.contains(document.activeElement) ? document.activeElement : null;
    slides[cur].classList.remove('on'); slides[cur].inert = true; slides[cur].setAttribute('aria-hidden', 'true');
    slides[i].classList.add('on'); slides[i].inert = false; slides[i].removeAttribute('aria-hidden');
    dots.forEach((d, n) => n === i ? d.setAttribute('aria-current', 'true') : d.removeAttribute('aria-current'));
    // Nästa bild laddas i förväg
    slides[(i + 1) % slides.length].querySelector('img')?.setAttribute('loading', 'eager');
    cur = i;
    // Fokus på en knapp i bilden som döljs flyttas till motsvarande knapp i den nya bilden
    if (had && slides.some(s => s.contains(had))) slides[i].querySelector(had.matches('a') ? 'a' : 'button')?.focus({ preventScroll: true });
    if (byUser) schedule();
  };
  const tick = () => { cancel = null; if (!el.isConnected) return; if (!paused()) show(cur + 1); schedule(); };
  const schedule = () => { cancel?.(); cancel = slides.length > 1 ? later(tick, INTERVAL) : null; };
  el.addEventListener('mouseenter', () => { hover = true; });
  el.addEventListener('mouseleave', () => { hover = false; });
  el.addEventListener('focusin', () => { focus = true; });
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) focus = false; });
  el.addEventListener('click', (e) => {
    const p = e.target.closest('[data-fplay]');
    if (p) return playTitle(p, items[+p.dataset.fplay]);
    const d = e.target.closest('[data-dot]');
    if (d) return show(+d.dataset.dot, true);
    if (e.target.closest('.feat-pause')) { user = !user; label(); schedule(); }
  });
  // ← → mellan karusellens knappar (TV-fjärr), ↓ till första kortet nedanför
  el.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const f = [...el.querySelectorAll('.feat-slide.on button, .feat-slide.on a, .feat-nav button')];
    const i = f.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const to = f[i + (e.key === 'ArrowRight' ? 1 : -1)];
      if (to) { e.preventDefault(); to.focus(); }
    } else if (e.key === 'ArrowDown') {
      const c = el.parentElement.querySelector('.card > .clink, .card.mcard, .shelf a');
      if (c) { e.preventDefault(); c.focus(); c.scrollIntoView({ block: 'nearest', behavior: reduce() ? 'auto' : 'smooth' }); }
    }
  });
  label();
  schedule();
}
