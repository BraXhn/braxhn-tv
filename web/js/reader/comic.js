// Serietidningar i läsaren: sida för sida, dubbelsida (omslaget ensamt, sedan par), manga höger→vänster och
// webtoon-läge (alla sidor under varandra med vertikal rullning). Nästa sidor hämtas i förväg, zoom med knappar,
// tangenter, dubbelklick och pekskärmens egen zoom/panorering i webtoon-läget. Sidorna är bilder från
// /api/ebooks/:id/page/:n (servern kontrollerar att det är en bild).
import { t } from '../core.js';

export const MODES = ['single', 'double', 'webtoon'];
export const ZOOMS = [1, 1.5, 2, 3];

/**
 * opts: { mode, rtl, fit ('page' | 'width'), onMove(state), onTap(zone) }. Returnerar en styrning.
 */
export function openComic(stage, book, opts) {
  const n = Math.max(1, book.pages || 1), id = +book.id;
  const url = (i) => `/api/ebooks/${id}/page/${i}`;
  const S = { i: 0, z: 1, mode: MODES.includes(opts.mode) ? opts.mode : 'single', rtl: !!opts.rtl, fit: opts.fit === 'width' ? 'width' : 'page', destroyed: false };
  const view = document.createElement('div');
  view.className = 'cx';
  stage.append(view);
  const pre = new Map();
  const preload = (i) => { if (i < 0 || i >= n || pre.has(i)) return; const im = new Image(); im.decoding = 'async'; im.src = url(i); pre.set(i, im); if (pre.size > 12) pre.delete(pre.keys().next().value); };
  const alt = (i) => t('Sida {n} av {total}', { n: i + 1, total: n });
  const narrow = () => stage.clientWidth < stage.clientHeight * 1.1;
  const dbl = () => S.mode === 'double' && !narrow();
  /** Sidorna som syns tillsammans med sidan i: omslaget ensamt, sedan par (1–2, 3–4 …) */
  const spread = (i) => {
    if (!dbl() || i === 0) return [i];
    const a = i % 2 ? i : i - 1;
    return a + 1 < n ? [a, a + 1] : [a];
  };
  function state() {
    const vis = S.mode === 'webtoon' ? [S.i] : spread(S.i);
    const last = vis.at(-1);
    return { page: vis[0], last, pages: n, percent: n > 1 ? Math.round(last / (n - 1) * 1000) / 10 : 100, locator: { page: vis[0] }, zoom: S.z, mode: S.mode, rtl: S.rtl };
  }
  // ---------- sida/dubbelsida ----------
  function sizeImgs() {
    const W = stage.clientWidth, H = stage.clientHeight;
    const imgs = [...view.querySelectorAll('img.cx-p')];
    const per = W / Math.max(1, imgs.length);
    for (const im of imgs) {
      if (!im.naturalWidth) continue;
      const s = S.fit === 'width' ? per / im.naturalWidth : Math.min(per / im.naturalWidth, H / im.naturalHeight);
      im.style.width = Math.floor(im.naturalWidth * s * S.z) + 'px';
      im.style.height = 'auto';
    }
    view.classList.toggle('zoomed', S.z > 1 || S.fit === 'width');
  }
  function renderPaged(focusEdge = null) {
    const vis = spread(S.i);
    const order = S.rtl ? [...vis].reverse() : vis;
    view.className = `cx paged${S.fit === 'width' ? ' fitw' : ''}`;
    view.innerHTML = `<div class="cx-row">${order.map(i => `<img class="cx-p" src="${url(i)}" alt="${alt(i)}" draggable="false" decoding="async">`).join('')}</div>`;
    for (const im of view.querySelectorAll('img')) { im.addEventListener('load', sizeImgs, { once: true }); if (im.complete) sizeImgs(); }
    view.scrollTop = 0;
    view.scrollLeft = focusEdge === 'end' ? view.scrollWidth : 0;
    const last = vis.at(-1);
    for (let k = 1; k <= 4; k++) preload(last + k);
    preload(vis[0] - 1);
    opts.onMove?.(state());
  }
  // ---------- webtoon ----------
  let io = null, moveTimer = 0;
  function renderStrip() {
    view.className = 'cx strip';
    view.innerHTML = Array.from({ length: n }, (_, i) => `<img class="cx-s" data-i="${i}" ${Math.abs(i - S.i) <= 2 ? `src="${url(i)}"` : `data-src="${url(i)}"`} alt="${alt(i)}" draggable="false" decoding="async">`).join('');
    io?.disconnect();
    // Sidor nära skärmen hämtas (två skärmar i förväg); den översta synliga sidan är läspositionen
    io = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting && e.target.dataset.src) { e.target.src = e.target.dataset.src; delete e.target.dataset.src; }
    }, { root: view, rootMargin: '200% 0px' });
    view.querySelectorAll('img').forEach(im => { io.observe(im); im.addEventListener('load', () => im.classList.add('ok'), { once: true }); });
    requestAnimationFrame(() => view.querySelector(`[data-i="${S.i}"]`)?.scrollIntoView({ block: 'start' }));
    opts.onMove?.(state());
  }
  view.addEventListener('scroll', () => {
    if (S.mode !== 'webtoon') return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const top = view.getBoundingClientRect().top + 8;
      let cur = S.i;
      for (const im of view.querySelectorAll('img')) { const r = im.getBoundingClientRect(); if (r.top <= top && r.bottom > top) { cur = +im.dataset.i; break; } }
      if (cur !== S.i) { S.i = cur; opts.onMove?.(state()); }
    }, 120);
  }, { passive: true });
  const render = (edge) => S.mode === 'webtoon' ? renderStrip() : renderPaged(edge);

  // ---------- navigering ----------
  function goTo(loc = {}) {
    S.i = Math.max(0, Math.min(n - 1, Math.floor(+loc.page || 0)));
    if (S.mode !== 'webtoon') S.i = spread(S.i)[0];
    S.z = 1;
    render();
  }
  function step(d) {
    if (S.mode === 'webtoon') { view.scrollBy({ top: d * view.clientHeight * 0.85, behavior: 'smooth' }); return; }
    const vis = spread(S.i);
    const to = d > 0 ? vis.at(-1) + 1 : vis[0] - 1;
    if (to < 0 || to >= n) return;
    S.i = spread(to)[0]; S.z = 1;
    renderPaged();
  }
  // Pekskärm: svep byter sida (inte när bilden är inzoomad), tryck i kanterna byter sida, mitten visar menyerna
  let touch = null, swiped = 0, drag = null, lastTap = 0;
  view.addEventListener('touchstart', (e) => { const p = e.touches[0]; touch = e.touches.length === 1 && p ? { x: p.clientX, y: p.clientY, t: Date.now() } : null; }, { passive: true });
  view.addEventListener('touchend', (e) => {
    const p = e.changedTouches[0];
    if (!touch || !p || S.mode === 'webtoon' || S.z > 1 || S.fit === 'width') { touch = null; return; }
    const dx = p.clientX - touch.x, dy = p.clientY - touch.y;
    if (Math.abs(dx) > 50 && Math.abs(dy) < 80 && Date.now() - touch.t < 800) { swiped = Date.now(); (dx < 0) !== S.rtl ? step(1) : step(-1); }
    touch = null;
  }, { passive: true });
  view.addEventListener('click', (e) => {
    if (Date.now() - swiped < 400 || drag?.moved) return;
    const r = view.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    // Dubbelklick/dubbeltryck: zooma in eller tillbaka
    if (S.mode !== 'webtoon' && Date.now() - lastTap < 300) { lastTap = 0; zoomTo(S.z > 1 ? 1 : 2, e); return; }
    lastTap = Date.now();
    if (S.mode === 'webtoon' || S.z > 1) { if (x > 0.3 && x < 0.7) opts.onTap?.('ui'); return; }
    setTimeout(() => { if (lastTap && Date.now() - lastTap >= 280) { lastTap = 0; opts.onTap?.(x < 0.3 ? 'left' : x > 0.7 ? 'right' : 'ui'); } }, 300);
  });
  // Mus: dra för att panorera när bilden är större än skärmen
  view.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && view.classList.contains('zoomed')) drag = { x: e.clientX, y: e.clientY, l: view.scrollLeft, t: view.scrollTop, moved: false }; });
  addEventListener('pointermove', onDrag);
  addEventListener('pointerup', onUp);
  function onDrag(e) { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true; view.scrollLeft = drag.l - dx; view.scrollTop = drag.t - dy; }
  function onUp() { if (drag) setTimeout(() => { drag = null; }, 0); }
  function zoomTo(z, at = null) {
    if (S.mode === 'webtoon') return;
    const old = S.z;
    S.z = Math.max(ZOOMS[0], Math.min(ZOOMS.at(-1), z));
    const r = view.getBoundingClientRect();
    const fx = at ? (at.clientX - r.left + view.scrollLeft) / Math.max(1, view.scrollWidth) : 0.5, fy = at ? (at.clientY - r.top + view.scrollTop) / Math.max(1, view.scrollHeight) : 0.5;
    sizeImgs();
    if (old !== S.z) { view.scrollLeft = fx * view.scrollWidth - r.width / 2; view.scrollTop = fy * view.scrollHeight - r.height / 2; }
    opts.onMove?.(state());
  }
  const ro = new ResizeObserver(() => { if (S.mode !== 'webtoon') { const was = S.i; if (spread(was)[0] !== was) S.i = spread(was)[0]; sizeImgs(); } });
  ro.observe(stage);
  return {
    goTo, state,
    next: () => step(1), prev: () => step(-1),
    /** Pilarna på skärmen/tangentbordet: höger→vänster-läsning vänder dem */
    left: () => step(S.rtl ? 1 : -1), right: () => step(S.rtl ? -1 : 1),
    first: () => goTo({ page: 0 }), last: () => goTo({ page: n - 1 }),
    seek: (pc) => goTo({ page: Math.round(pc / 100 * (n - 1)) }),
    zoomIn: () => zoomTo(ZOOMS.find(z => z > S.z) ?? S.z), zoomOut: () => zoomTo([...ZOOMS].reverse().find(z => z < S.z) ?? 1),
    /** Pilar upp/ner i inzoomat läge flyttar bilden i stället för sidan */
    pan(dx, dy) { if (!view.classList.contains('zoomed') && S.mode !== 'webtoon') return false; view.scrollBy({ left: dx * view.clientWidth * 0.4, top: dy * view.clientHeight * 0.4 }); return true; },
    setOptions(o) {
      if (o.mode && MODES.includes(o.mode)) S.mode = o.mode;
      if (o.rtl != null) S.rtl = !!o.rtl;
      if (o.fit) S.fit = o.fit === 'width' ? 'width' : 'page';
      S.z = 1;
      if (S.mode !== 'webtoon') { io?.disconnect(); S.i = spread(S.i)[0]; }
      render();
    },
    focusTarget: () => view,
    destroy() { S.destroyed = true; io?.disconnect(); ro.disconnect(); removeEventListener('pointermove', onDrag); removeEventListener('pointerup', onUp); view.remove(); }
  };
}
