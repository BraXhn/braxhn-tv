// Vy: fotobibliotek – tidslinje per år/månad/dag, album (mapparna), favoriter och "Den här dagen" (minnen).
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
// Rutnätet är virtuellt: servern ger antalet foton per dag (/timeline), så hela höjden räknas ut direkt och bara de
// rader som syns ritas; fotona hämtas per månad när de kommer i bild. Helskärmsvisningen har svep/piltangenter, zoom
// (hjul, nyp, dubbelklick), information (EXIF, koordinater som text – inga kartor) och bildspel med övertoning och
// valfri musik ur musikbiblioteket. Videoklipp spelas i den vanliga spelaren.
import { $, act, api, esc, libs, main, me, onLeave, routeGen, safeColor, store, toast, toastErr, views, t, locale } from '../core.js';
import { tabsHtml } from '../ui/tabs.js';
import { emptyState, errorState, bindRetry } from '../ui/states.js';
import { iconButton, setIconButton } from '../ui/buttons.js';
import { openDialog } from '../ui/dialog.js';
import { M, playQueue } from '../audio.js';
import { P, play as playVideo } from '../player/video.js';

const GAP = 3, DAY_GAP = 14, H_MONTH = 56, H_DAY = 30, H_HEAD = 60;
const MONTHS = [t('januari'), t('februari'), t('mars'), t('april'), t('maj'), t('juni'), t('juli'), t('augusti'), t('september'), t('oktober'), t('november'), t('december')];
// Tiden är bildens lokala väggklocka räknad som UTC (server/photos.js) – visas därför alltid med timeZone UTC
const UTC = { timeZone: 'UTC' };
const fmtMonth = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const fmtDayHead = (d, withYear = false) => new Date(d + 'T12:00:00Z').toLocaleDateString(locale, { ...UTC, weekday: 'long', day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}) });
const fmtDayShort = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString(locale, { ...UTC, weekday: 'short', day: 'numeric', month: 'short' });
const fmtWhen = (t) => new Date(t * 1000).toLocaleString(locale, { ...UTC, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtShort = (t) => new Date(t * 1000).toLocaleString(locale, { ...UTC, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString(locale, { ...UTC, day: 'numeric', month: 'long', year: 'numeric' });
const dur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const nFoton = (n) => `${n.toLocaleString(locale)} ${n === 1 ? t('foto') : t('foton')}`;
const imgUrl = (id, w) => `/api/photos/${+id}/img?w=${w}`;
const PHOTO_W = [160, 240, 320, 480, 720, 1280, 1920, 2560];
const snapW = (px) => PHOTO_W.find(w => w >= px) || PHOTO_W.at(-1);
const enc = (f) => encodeURIComponent(f);

// ---------- sidan ----------
views.photos = async (libArg, tabArg = '') => {
  const lid = +libArg;
  const lib = libs.find(l => l.id === lid && l.type === 'photo');
  if (!lib) { main.innerHTML = emptyState({ icon: '🖼', title: t('Fotobiblioteket finns inte'), text: t('Det kan ha tagits bort, eller så får din profil inte se det.'), action: { label: t('Till startsidan'), href: '#/' } }); return; }
  const [tab, arg] = String(tabArg).split(':');
  const cur = ['albums', 'album', 'favorites', 'memories'].includes(tab) ? tab : 'timeline';
  const head = (extra = '') => `<div class="toolbar ph-head"><h1>${esc(lib.name)}</h1><span class="ph-note" id="phcount"></span>${extra}
    <button type="button" class="ghost small" id="phshow" hidden><span aria-hidden="true">▶</span> ${t('Bildspel')}</button></div>
    ${tabsHtml({ label: t('Foton'), current: cur === 'album' ? 'albums' : cur, items: [
      { key: 'timeline', label: t('Tidslinje'), href: `#/photos/${lid}` }, { key: 'albums', label: 'Album', href: `#/photos/${lid}/albums` },
      { key: 'favorites', label: t('Favoriter'), href: `#/photos/${lid}/favorites` }, { key: 'memories', label: t('Den här dagen'), href: `#/photos/${lid}/memories` }] })}`;
  if (cur === 'albums' || cur === 'album') return albumPage(lid, lib, arg ? decodeURIComponent(arg) : '', head);
  if (cur === 'memories') return memoriesPage(head);
  return timelinePage(lid, head, cur === 'favorites');
};

async function timelinePage(lid, head, fav) {
  const tm = await api(`/photos/lib/${lid}/timeline${fav ? '?fav=1' : ''}`);
  main.innerHTML = head() + '<div id="phgrid" class="ph-grid"></div>';
  $('#phcount').textContent = tm.total ? nFoton(tm.total) : '';
  if (!tm.total) {
    $('#phgrid').outerHTML = fav ? emptyState({ icon: '♡', title: t('Inga favoriter än'), text: t('Öppna ett foto och tryck på hjärtat för att spara det här.') })
      : emptyState({ icon: '🖼', title: t('Inga foton ännu'), text: me?.is_admin ? t('Skanningen hittar JPEG, PNG, WebP, GIF, HEIC och videoklipp (MOV/MP4) i bibliotekets mappar. Det kan ta en stund första gången.') : t('Inga foton har lagts in i biblioteket än.') });
    return;
  }
  // Månader med dagar: [{ ym, n, days: [{ d, n, off }] }]
  const months = [];
  for (const [d, n] of tm.days) {
    const ym = d.slice(0, 7);
    let m = months.at(-1);
    if (!m || m.ym !== ym) months.push(m = { ym, n: 0, days: [] });
    m.days.push({ d, n, off: m.n }); m.n += n;
  }
  const sources = months.map(m => ({ n: m.n, items: null, load: () => api(`/photos/lib/${lid}/month/${m.ym}${fav ? '?fav=1' : ''}`).then(r => r.photos) }));
  const blocks = [];
  const thisYear = new Date().getFullYear();
  months.forEach((m, si) => {
    blocks.push({ kind: 'h1', text: fmtMonth(m.ym), year: m.ym.slice(0, 4) });
    for (const d of m.days) blocks.push({ kind: 'day', text: fmtDayHead(d.d, +d.d.slice(0, 4) !== thisYear), short: fmtDayShort(d.d), sub: d.n > 1 ? nFoton(d.n) : '', src: si, off: d.off, n: d.n });
  });
  const grid = virtualGrid($('#phgrid'), { sources, blocks, years: true });
  bindShow(grid);
}

async function albumPage(lid, lib, folder, head) {
  const r = await api(`/photos/lib/${lid}/albums?folder=${enc(folder)}`);
  const parts = folder ? folder.split('/') : [];
  const crumbs = `<nav class="ph-crumbs" aria-label="${t('Mappar')}"><a href="#/photos/${lid}/albums">Album</a>${parts.map((p, i) => i === parts.length - 1
    ? ` <span aria-hidden="true">›</span> <span aria-current="page">${esc(p)}</span>`
    : ` <span aria-hidden="true">›</span> <a href="#/photos/${lid}/album:${enc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`).join('')}</nav>`;
  const range = (f) => {
    if (!f.first || !f.latest) return '';
    const a = new Date(f.first * 1000), b = new Date(f.latest * 1000), dm = { ...UTC, day: 'numeric', month: 'short' };
    if (fmtDate(f.first) === fmtDate(f.latest)) return fmtDate(f.first);
    return a.getUTCFullYear() === b.getUTCFullYear() ? `${a.toLocaleDateString(locale, dm)} – ${b.toLocaleDateString(locale, dm)} ${b.getUTCFullYear()}` : `${a.getUTCFullYear()}–${b.getUTCFullYear()}`;
  };
  const albums = r.folders.length ? `<div class="ph-albums">${r.folders.map(f => `<a class="ph-alb" href="#/photos/${lid}/album:${enc(f.path)}" aria-label="${esc(`${f.name}, ${nFoton(f.count)}`)}">
    <span class="ph-alb-c" style="background:${safeColor(f.cover?.c) || 'var(--bg3)'}">${f.cover ? `<img loading="lazy" decoding="async" src="${imgUrl(f.cover.id, 480)}" alt="" data-fb="1">` : ''}</span>
    <b>${esc(f.name)}</b><span class="ph-note">${esc(nFoton(f.count))}${range(f) ? ' · ' + esc(range(f)) : ''}</span></a>`).join('')}</div>` : '';
  main.innerHTML = head() + crumbs + albums + (r.photos.length ? `${r.folders.length ? t('<h2 class="ph-sub">Foton i mappen</h2>') : ''}<div id="phgrid" class="ph-grid"></div>` : '');
  $('#phcount').textContent = r.photos.length ? nFoton(r.photos.length) + (r.folders.length ? t(' i mappen') : '') : '';
  if (!r.folders.length && !r.photos.length) {
    main.insertAdjacentHTML('beforeend', emptyState({ icon: '📁', title: folder ? t('Mappen är tom') : t('Inga album ännu'), text: t('Album är mapparna i fotobiblioteket – lägg foton i undermappar så visas de här.') }));
    return;
  }
  if (!r.photos.length) return;
  const grid = virtualGrid($('#phgrid'), { sources: [{ n: r.photos.length, items: r.photos }], blocks: [{ kind: 'tiles', src: 0, off: 0, n: r.photos.length }] });
  bindShow(grid);
}

async function memoriesPage(head) {
  const r = await api('/photos/memories');
  main.innerHTML = head() + '<div id="phgrid" class="ph-grid"></div>';
  if (!r.groups.length) {
    $('#phgrid').outerHTML = emptyState({ icon: '📅', title: t('Inga minnen i dag'), text: t('Inga foton är tagna {v} tidigare år. Titta in en annan dag!', { v: fmtDayHead(r.date).replace(/^\S+\s/, '') }) });
    return;
  }
  const total = r.groups.reduce((a, g) => a + g.photos.length, 0);
  $('#phcount').textContent = nFoton(total);
  const sources = r.groups.map(g => ({ n: g.photos.length, items: g.photos }));
  const blocks = r.groups.flatMap((g, si) => [{ kind: 'h1', text: g.yearsAgo === 1 ? t('För ett år sedan') : t('För {yearsAgo} år sedan', { yearsAgo: g.yearsAgo }), sub: `${fmtDayHead(g.day, true)} · ${nFoton(g.count)}` },
    { kind: 'tiles', src: si, off: 0, n: g.photos.length }]);
  const grid = virtualGrid($('#phgrid'), { sources, blocks });
  bindShow(grid);
}

function bindShow(grid) {
  const b = $('#phshow'); if (!b) return;
  b.hidden = false;
  b.onclick = () => slideshowDialog(grid.seq, 0);
}

// ---------- virtuellt rutnät ----------
/**
 * Rutnät där bara synliga rader finns i DOM:en. sources = fotolistor ({ n, items | null, load }) i visningsordning,
 * blocks = rubriker (h1 månad/år), dagar ({ kind: 'day', text, short, src, off, n }) och rutor ({ kind: 'tiles', src, off, n }).
 * Dagar med få foton delar rad (som i Google Foto) – en dag som inte får plats börjar på en ny rad med egen rubrik.
 * Varje foto har ett globalt index (källornas ordning) som även helskärmsvisningen och bildspelet använder.
 */
function virtualGrid(host, { sources, blocks, years = false }) {
  const base = []; let total = 0;
  for (const s of sources) { base.push(total); total += s.n; }
  let rows = [], cols = 4, size = 100, width = 0, height = 0;
  const shown = new Map(); // radindex → element
  const gen = routeGen;
  host.setAttribute('role', 'grid');
  host.setAttribute('aria-label', t('Foton'));
  host.setAttribute('aria-rowcount', '-1');
  function layout() {
    width = host.clientWidth || main.clientWidth || 360;
    const target = width < 500 ? 78 : width < 900 ? 115 : 150;
    cols = Math.max(3, Math.floor((width + GAP) / (target + GAP)));
    size = Math.floor((width - GAP * (cols - 1)) / cols);
    rows = []; let y = 0, line = null;
    const flush = () => { if (line) { y += line.h + GAP; line = null; } };
    const tiles = (src, off, n) => { for (let k = 0; k < n; k += cols) { rows.push({ kind: 't', y, h: size, src, off: off + k, n: Math.min(cols, n - k) }); y += size + GAP; } };
    for (const b of blocks) {
      if (b.kind === 'h1') { flush(); rows.push({ kind: 'h1', y, h: b.sub ? H_HEAD : H_MONTH, b }); y += b.sub ? H_HEAD : H_MONTH; }
      else if (b.kind === 'day' && b.n <= cols) {
        // Delad rad: dagen får plats bredvid de föregående (mellanrum DAY_GAP)
        const w = b.n * size + (b.n - 1) * GAP;
        if (line && line.src === b.src && line.x + DAY_GAP + w <= width) { line.parts.push({ b, x: line.x + DAY_GAP, w }); line.x += DAY_GAP + w; }
        else { flush(); line = { kind: 'line', y, h: H_DAY + size, src: b.src, off: b.off, parts: [{ b, x: 0, w }], x: w }; rows.push(line); }
      } else if (b.kind === 'day') { flush(); rows.push({ kind: 'h2', y, h: H_DAY, b }); y += H_DAY; tiles(b.src, b.off, b.n); }
      else { flush(); tiles(b.src, b.off, b.n); }
    }
    flush();
    for (const r of rows) if (r.kind === 'line') r.n = r.parts.reduce((a, p) => a + p.b.n, 0);
    height = y;
    host.style.height = height + 'px';
    for (const el of shown.values()) el.remove();
    shown.clear();
  }
  const hostTop = () => host.getBoundingClientRect().top + window.scrollY;
  /** Första raden som slutar under y (binärsökning) */
  function rowAt(y) {
    let lo = 0, hi = rows.length - 1, ans = rows.length;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].y + rows[mid].h >= y) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    return ans;
  }
  const loading = new Set();
  let active = 0;
  const queue = [];
  function need(si) {
    const s = sources[si];
    if (s.items || loading.has(si)) return;
    loading.add(si); queue.push(si); pump();
  }
  function pump() {
    while (active < 3 && queue.length) {
      // Bara källor som fortfarande syns (snabb rullning hoppar över månader på vägen)
      const si = queue.shift();
      if (!visibleSources().has(si) && !sources[si].wanted) { loading.delete(si); continue; }
      active++;
      sources[si].load().then(items => { sources[si].items = items; sources[si].waiters?.forEach(f => f()); sources[si].waiters = null; if (gen === routeGen) refreshSource(si); })
        .catch(e => { if (!e?.aborted) toastErr(e); })
        .finally(() => { active--; loading.delete(si); pump(); });
    }
  }
  let vis = { a: 0, b: -1 };
  const visibleSources = () => { const s = new Set(); for (let i = vis.a; i <= vis.b; i++) if (rows[i]?.src != null) s.add(rows[i].src); return s; };
  function tileHtml(it, gi) {
    if (!it) return `<span class="ph-t ph-ph" style="width:${size}px;height:${size}px" aria-hidden="true"></span>`;
    const w = snapW(size * Math.min(devicePixelRatio || 1, 2));
    const label = `${it.v ? 'Video' : t('Foto')}, ${fmtShort(it.t)}${it.fav ? t(', favorit') : ''}`;
    return `<button type="button" class="ph-t" role="gridcell" data-i="${gi}" tabindex="-1" style="width:${size}px;height:${size}px;background:${safeColor(it.c) || 'var(--bg3)'}" aria-label="${esc(label)}">`
      + `<img src="${imgUrl(it.id, Math.min(w, 480))}" alt="" decoding="async" draggable="false" data-fb="1">`
      + (it.v ? `<span class="ph-badge" aria-hidden="true">▶ ${dur(it.d || 0)}</span>` : '') + (it.fav ? '<span class="ph-fav" aria-hidden="true">♥</span>' : '') + '</button>';
  }
  function rowEl(r, i) {
    const el = document.createElement('div');
    el.className = 'ph-row ph-row-' + r.kind;
    el.style.top = r.y + 'px'; el.style.height = r.h + 'px';
    el.dataset.r = i;
    if (r.kind === 'h1') { el.innerHTML = `<h2>${esc(r.b.text)}${r.b.sub ? ` <span class="ph-note">${esc(r.b.sub)}</span>` : ''}</h2>`; el.setAttribute('role', 'row'); }
    else if (r.kind === 'h2') { el.innerHTML = `<h3>${esc(r.b.text)}${r.b.sub ? ` <span class="ph-note">· ${esc(r.b.sub)}</span>` : ''}</h3>`; el.setAttribute('role', 'row'); }
    else if (r.kind === 'line') {
      el.setAttribute('role', 'row');
      const s = sources[r.src];
      if (!s.items) need(r.src);
      el.innerHTML = r.parts.map(p => {
        let h = '';
        for (let k = 0; k < p.b.n; k++) h += tileHtml(s.items?.[p.b.off + k], base[r.src] + p.b.off + k);
        return `<div class="ph-day" style="left:${p.x}px;width:${p.w}px"><h3 title="${esc(p.b.text)}">${esc(p.w > 150 ? p.b.text : p.b.short)}</h3><div class="ph-tiles" style="gap:${GAP}px">${h}</div></div>`;
      }).join('');
    } else {
      el.setAttribute('role', 'row');
      el.style.gap = GAP + 'px';
      const s = sources[r.src];
      if (!s.items) need(r.src);
      let h = '';
      for (let k = 0; k < r.n; k++) h += tileHtml(s.items?.[r.off + k], base[r.src] + r.off + k);
      el.innerHTML = h;
    }
    return el;
  }
  function refreshSource(si) {
    for (const [i, el] of shown) if (rows[i]?.src === si) { const n = rowEl(rows[i], i); el.replaceWith(n); shown.set(i, n); }
    restoreFocus();
  }
  let focusI = -1;
  const restoreFocus = () => { if (focusI < 0) return; const b = host.querySelector(`[data-i="${focusI}"]`); if (b && document.activeElement !== b && host.contains(document.activeElement) === false && pendingFocus) { b.focus({ preventScroll: true }); pendingFocus = false; } };
  let pendingFocus = false;
  function render() {
    if (!host.isConnected) return;
    const top = window.scrollY - hostTop(), over = innerHeight;
    const a = rowAt(Math.max(0, top - over)), bEnd = top + innerHeight + over;
    let b = a;
    while (b < rows.length && rows[b].y <= bEnd) b++;
    b--;
    vis = { a, b };
    for (const [i, el] of shown) if (i < a || i > b) { el.remove(); shown.delete(i); }
    const frag = document.createDocumentFragment();
    for (let i = a; i <= b; i++) if (!shown.has(i)) { const el = rowEl(rows[i], i); shown.set(i, el); frag.append(el); }
    host.append(frag);
    // Tab når rutnätet via en ruta (den senast valda eller den första som syns)
    const tab = host.querySelector(`[data-i="${focusI}"]`) || host.querySelector('.ph-t[data-i]');
    host.querySelectorAll('.ph-t[tabindex="0"]').forEach(x => { if (x !== tab) x.tabIndex = -1; });
    if (tab) tab.tabIndex = 0;
    if (years) updateBubble(top);
  }
  // Månadsetiketten vid snabb rullning och årslisten till höger
  let bubble = null, bubbleT = 0, railT = 0, lastTop = 0, curYear = null;
  function updateBubble(top) {
    if (!bubble) return;
    const i = rowAt(Math.max(0, top + 70));
    let k = i; while (k >= 0 && rows[k]?.kind !== 'h1') k--;
    if (k >= 0) bubble.textContent = rows[k].b.text;
    if (Math.abs(top - lastTop) > innerHeight * 1.5) { bubble.classList.add('on'); clearTimeout(bubbleT); bubbleT = setTimeout(() => bubble?.classList.remove('on'), 900); }
    // Telefon: årslisten syns bara medan man rullar (eller när den har fokus)
    if (Math.abs(top - lastTop) > 2) { yearRail?.classList.add('active'); clearTimeout(railT); railT = setTimeout(() => yearRail?.classList.remove('active'), 1800); }
    lastTop = top;
    const y = rows[k]?.b.year;
    if (yearRail && y !== curYear) {
      curYear = y;
      yearRail.querySelectorAll('[data-y]').forEach(x => x.classList.toggle('on', x.dataset.y === y));
      const on = yearRail.querySelector('.on');
      if (on) yearRail.scrollTop = Math.max(0, on.offsetTop - yearRail.clientHeight / 2); // årslisten följer med (många år)
    }
  }
  let yearRail = null;
  function drawYears() {
    if (!years) return;
    const list = [...new Set(blocks.filter(b => b.kind === 'h1').map(b => b.year))];
    if (list.length < 2) return;
    yearRail = document.createElement('nav');
    yearRail.className = 'ph-years'; yearRail.setAttribute('aria-label', t('Hoppa till år'));
    yearRail.innerHTML = list.map(y => `<button type="button" data-y="${esc(y)}">${esc(y)}</button>`).join('');
    yearRail.onclick = (e) => {
      const y = e.target.closest('[data-y]')?.dataset.y; if (!y) return;
      const r = rows.find(x => x.kind === 'h1' && x.b.year === y);
      if (r) window.scrollTo({ top: hostTop() + r.y - topOffset(), behavior: 'auto' });
    };
    bubble = document.createElement('div');
    bubble.className = 'ph-bubble'; bubble.setAttribute('aria-hidden', 'true');
    document.body.append(yearRail, bubble);
  }
  const topOffset = () => ($('#top')?.offsetHeight || 0) + 4;
  let raf = 0;
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  let lastW = 0;
  const ro = new ResizeObserver(() => {
    const w = host.clientWidth;
    if (!w || w === lastW) return;
    // Behåll det översta fotot som syns när kolumnerna ändras
    const anchor = firstVisibleIndex();
    lastW = w; layout();
    if (anchor > 0) scrollToIndex(anchor, false);
    render();
  });
  function firstVisibleIndex() {
    if (!rows.length) return 0;
    const i = rowAt(Math.max(0, window.scrollY - hostTop() + topOffset()));
    for (let k = i; k < rows.length; k++) if (rows[k].src != null) return base[rows[k].src] + rows[k].off;
    return 0;
  }
  /** Raden där fotot med globalt index gi ligger */
  function rowOf(gi) {
    let si = locate(gi).src;
    const off = gi - base[si];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.src !== si) continue;
      if (r.kind === 't' && off >= r.off && off < r.off + r.n) return i;
      if (r.kind === 'line' && r.parts.some(p => off >= p.b.off && off < p.b.off + p.b.n)) return i;
    }
    return -1;
  }
  function scrollToIndex(gi, onlyIfHidden = true) {
    const i = rowOf(gi); if (i < 0) return;
    const r = rows[i], y = hostTop() + r.y, vt = window.scrollY + topOffset(), vb = window.scrollY + innerHeight - 70;
    if (onlyIfHidden && y >= vt && y + r.h <= vb) return;
    window.scrollTo({ top: Math.max(0, y - (onlyIfHidden && y + r.h > vb ? innerHeight - r.h - 90 : topOffset() + 8)) });
  }
  function locate(gi) {
    let lo = 0, hi = base.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (base[mid] <= gi) lo = mid; else hi = mid - 1; }
    return { src: lo, idx: gi - base[lo] };
  }
  /** Fotot med globalt index (hämtar månaden om den inte är laddad) */
  async function at(gi) {
    if (gi < 0 || gi >= total) return null;
    const { src, idx } = locate(gi), s = sources[src];
    if (!s.items) {
      s.wanted = true;
      await new Promise(res => { (s.waiters ||= []).push(res); if (!loading.has(src)) { loading.add(src); queue.unshift(src); pump(); } });
    }
    return s.items?.[idx] || null;
  }
  const seq = { get total() { return total; }, at, peek: (gi) => { const { src, idx } = locate(gi); return sources[src].items?.[idx] || null; },
    reveal: (gi) => { if (!host.isConnected) return; focusI = gi; scrollToIndex(gi); render(); const b = host.querySelector(`[data-i="${gi}"]`); if (b) b.focus({ preventScroll: true }); else pendingFocus = true; },
    update: (gi, patch) => { const { src, idx } = locate(gi); const it = sources[src].items?.[idx]; if (it) { Object.assign(it, patch); refreshSource(src); } } };
  // Klick öppnar helskärmsvisningen; piltangenterna flyttar mellan rutorna (TV-fjärrkontroll)
  host.addEventListener('click', (e) => {
    const b = e.target.closest('.ph-t[data-i]'); if (!b) return;
    focusI = +b.dataset.i;
    openViewer(seq, focusI);
  });
  host.addEventListener('keydown', (e) => {
    const b = e.target.closest('.ph-t[data-i]'); if (!b) return;
    const i = +b.dataset.i;
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, PageDown: cols * 4, PageUp: -cols * 4 }[e.key];
    let to = d != null ? i + d : e.key === 'Home' && e.ctrlKey ? 0 : e.key === 'End' && e.ctrlKey ? total - 1 : null;
    if (to == null) return;
    e.preventDefault();
    to = Math.max(0, Math.min(total - 1, to));
    focusI = to; scrollToIndex(to); render();
    const n = host.querySelector(`[data-i="${to}"]`);
    if (n) n.focus({ preventScroll: true }); else pendingFocus = true;
  });
  host.addEventListener('focusin', (e) => { const b = e.target.closest('.ph-t[data-i]'); if (b) focusI = +b.dataset.i; });
  layout(); lastW = host.clientWidth; drawYears(); render();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  ro.observe(host);
  onLeave(() => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); ro.disconnect(); yearRail?.remove(); bubble?.remove(); closeViewer(false, false); });
  return { seq };
}

// ---------- helskärmsvisning ----------
let V = null; // den öppna visningen
const infoCache = new Map();
async function infoOf(id) {
  if (!infoCache.has(id)) infoCache.set(id, api(`/photos/${+id}`, { bg: true }).catch(e => { infoCache.delete(id); throw e; }));
  return infoCache.get(id);
}
function openViewer(seq, i) {
  closeViewer(false);
  const el = document.createElement('div');
  el.className = 'pv';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', t('Foto'));
  el.tabIndex = -1;
  el.innerHTML = `<div class="pv-stage"><img class="pv-img" alt="" draggable="false"><img class="pv-img" alt="" draggable="false">
      <button type="button" class="pv-play" hidden aria-label="${t('Spela videoklippet')}"><span aria-hidden="true">▶</span></button></div>
    <div class="pv-bar">${iconButton({ icon: '←', label: t('Stäng (Esc)'), id: 'pvclose', cls: 'pvb' })}
      <div class="pv-title"><b id="pvwhen"></b><span class="ph-note" id="pvpos"></span></div>
      ${iconButton({ icon: '♡', label: t('Favorit (f)'), id: 'pvfav', cls: 'pvb', pressed: false })}
      ${iconButton({ icon: 'ⓘ', label: 'Information (i)', id: 'pvinfo', cls: 'pvb', pressed: false })}
      ${iconButton({ icon: '⤓', label: t('Ladda ner originalet'), id: 'pvdl', cls: 'pvb', hidden: true })}
      ${iconButton({ icon: '▶', label: t('Bildspel'), id: 'pvshow', cls: 'pvb', haspopup: 'dialog' })}</div>
    ${iconButton({ icon: '‹', label: t('Föregående (←)'), id: 'pvprev', cls: 'pv-nav prev' })}${iconButton({ icon: '›', label: t('Nästa (→)'), id: 'pvnext', cls: 'pv-nav next' })}
    <aside class="pv-info" id="pvpanel" hidden aria-label="${t('Information om fotot')}"></aside>
    <div class="pv-ssbar" hidden>${iconButton({ icon: '⏸', label: t('Pausa bildspelet (mellanslag)'), id: 'pvsspause', cls: 'ghost' })}${iconButton({ icon: '✕', label: t('Avsluta bildspelet (Esc)'), id: 'pvssstop', cls: 'ghost' })}</div>`;
  document.body.append(el);
  const imgs = [...el.querySelectorAll('.pv-img')];
  const v = V = { el, seq, i, it: null, imgs, front: 0, z: { s: 1, x: 0, y: 0 }, hi: false, show: null, returnTo: document.activeElement, tok: 0, history: false };
  try { history.pushState({ pv: 1 }, ''); v.history = true; } catch {}
  document.body.classList.add('pv-open');
  bindViewer(v);
  el.focus();
  showAt(v, i);
}
/** Stänger visningen. back: gå tillbaka i historiken (steget som öppnandet lade till); reveal: visa och fokusera fotot i rutnätet */
function closeViewer(back = true, reveal = true) {
  const v = V; if (!v) return;
  V = null;
  stopSlideshow(v);
  window.removeEventListener('resize', v.onResize);
  document.removeEventListener('keydown', v.onKey, true);
  v.el.remove();
  document.body.classList.remove('pv-open');
  if (back && v.history && history.state?.pv) history.back();
  if (reveal) v.seq.reveal?.(v.i);
}
window.addEventListener('popstate', () => { if (V) closeViewer(false); });

function setFront(v, img) {
  v.imgs.forEach(x => x.classList.toggle('on', x === img));
  v.front = v.imgs.indexOf(img);
}
const frontImg = (v) => v.imgs[v.front];
/** Bredden att hämta: skärmens bredd/höjd × pixeltätheten (högst 2560) */
const viewW = (it) => {
  const dpr = Math.min(devicePixelRatio || 1, 2), sw = innerWidth * dpr, sh = innerHeight * dpr;
  const ar = it.w && it.h ? it.w / it.h : 1.5;
  return snapW(Math.min(it.w || 99999, Math.max(Math.min(sw, sh * ar), 160)));
};
async function showAt(v, i, { fade = false } = {}) {
  const tok = ++v.tok;
  i = Math.max(0, Math.min(v.seq.total - 1, i));
  const it = await v.seq.at(i);
  if (V !== v || tok !== v.tok || !it) return;
  v.i = i; v.it = it; v.hi = false;
  resetZoom(v);
  const back = v.imgs[1 - v.front];
  back.classList.toggle('slow', fade);
  frontImg(v).classList.toggle('slow', fade);
  const src = imgUrl(it.id, viewW(it));
  await new Promise(res => { back.onload = back.onerror = res; back.src = src; if (back.complete && back.src.endsWith(src)) res(); });
  if (back.decode) await back.decode().catch(() => {});
  if (V !== v || tok !== v.tok) return;
  setFront(v, back);
  // Rubriken: datum och tid, plats i listan
  $('#pvwhen', v.el).textContent = innerWidth < 600 ? fmtShort(it.t) : fmtWhen(it.t);
  $('#pvpos', v.el).textContent = `${(i + 1).toLocaleString(locale)} av ${v.seq.total.toLocaleString(locale)}${it.v ? ' · video ' + dur(it.d || 0) : ''}`;
  const fb = $('#pvfav', v.el);
  setIconButton(fb, it.fav ? '♥' : '♡', it.fav ? t('Ta bort från favoriter (f)') : t('Lägg till i favoriter (f)')); fb.setAttribute('aria-pressed', String(!!it.fav));
  $('.pv-play', v.el).hidden = !it.v || !it.item;
  $('#pvprev', v.el).disabled = i <= 0; $('#pvnext', v.el).disabled = i >= v.seq.total - 1;
  if (!$('#pvpanel', v.el).hidden) fillInfo(v);
  infoOf(it.id).then(x => { if (V === v && v.it === it) $('#pvdl', v.el).hidden = !x.canDownload; }).catch(() => {});
  // Nästa och föregående hämtas i förväg (svep utan väntan)
  for (const k of [i + 1, i - 1]) { const n = v.seq.peek(k); if (n) { const im = new Image(); im.src = imgUrl(n.id, viewW(n)); } else if (k >= 0 && k < v.seq.total) v.seq.at(k); }
}
const go = (v, d) => { if (v.show) restartTimer(v); showAt(v, v.i + d); };

// Zoom: s = skala, x/y = förskjutning i px. Bilden hålls inom skärmen.
function resetZoom(v) { v.z = { s: 1, x: 0, y: 0 }; applyZoom(v); }
function applyZoom(v) {
  const img = frontImg(v);
  if (!img) return;
  const { s } = v.z;
  const r = img.getBoundingClientRect(), w = r.width / (v.z.applied || 1), h = r.height / (v.z.applied || 1);
  const mx = Math.max(0, (w * s - innerWidth) / 2), my = Math.max(0, (h * s - innerHeight) / 2);
  v.z.x = Math.max(-mx, Math.min(mx, v.z.x)); v.z.y = Math.max(-my, Math.min(my, v.z.y));
  for (const x of v.imgs) x.style.transform = x === img && s !== 1 ? `translate(${v.z.x}px, ${v.z.y}px) scale(${s})` : '';
  v.z.applied = s;
  v.el.classList.toggle('zoomed', s > 1);
  // Inzoomat: den största varianten (originalet för den som får ladda ner och när webbläsaren kan visa det)
  if (s > 1.4 && !v.hi && v.it && !v.it.v) {
    v.hi = true;
    const it = v.it;
    infoOf(it.id).then(x => {
      if (V !== v || v.it !== it) return;
      const big = x.canDownload && ['jpeg', 'png', 'webp', 'gif'].includes(x.format) ? `/api/photos/${+it.id}/img` : imgUrl(it.id, 2560);
      const pre = new Image(); pre.onload = () => { if (V === v && v.it === it) frontImg(v).src = big; }; pre.src = big;
    }).catch(() => {});
  }
}
function zoomAt(v, factor, cx = innerWidth / 2, cy = innerHeight / 2) {
  const s0 = v.z.s, s = Math.max(1, Math.min(8, s0 * factor));
  if (s === s0) return;
  // Punkten under pekaren står still
  const ox = cx - innerWidth / 2, oy = cy - innerHeight / 2;
  v.z.x = ox - (ox - v.z.x) * (s / s0); v.z.y = oy - (oy - v.z.y) * (s / s0);
  v.z.s = s;
  if (s === 1) { v.z.x = 0; v.z.y = 0; }
  applyZoom(v);
}

function bindViewer(v) {
  const el = v.el;
  $('#pvclose', el).onclick = () => closeViewer();
  $('#pvprev', el).onclick = () => go(v, -1);
  $('#pvnext', el).onclick = () => go(v, 1);
  $('#pvfav', el).onclick = act(() => toggleFav(v));
  $('#pvinfo', el).onclick = () => toggleInfo(v);
  $('#pvdl', el).onclick = () => { if (v.it) location.href = `/api/photos/${+v.it.id}/original`; };
  $('#pvshow', el).onclick = () => slideshowDialog(v.seq, v.i);
  $('#pvsspause', el).onclick = () => pauseSlideshow(v);
  $('#pvssstop', el).onclick = () => stopSlideshow(v);
  $('.pv-play', el).onclick = () => { if (v.it?.item) playVideo(v.it.item).catch(toastErr); };
  // Tangenterna lyssnas på i hela dokumentet medan visningen är öppen (fokus kan ligga utanför efter en dialog)
  document.addEventListener('keydown', v.onKey = (e) => {
    if (P || document.querySelector('dialog[open]') || e.defaultPrevented) return; // spelaren eller en dialog är öppen ovanpå
    const k = e.key;
    if (k === 'Tab') { trapTab(el, e); return; }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest('input,select,textarea')) return;
    if (k === 'Escape') { e.preventDefault(); if (v.show) stopSlideshow(v); else if (v.z.s > 1) resetZoom(v); else closeViewer(); }
    else if (v.z.s > 1 && /^Arrow/.test(k)) { e.preventDefault(); const d = 60; v.z.x += k === 'ArrowLeft' ? d : k === 'ArrowRight' ? -d : 0; v.z.y += k === 'ArrowUp' ? d : k === 'ArrowDown' ? -d : 0; applyZoom(v); }
    else if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); go(v, 1); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); go(v, -1); }
    else if (k === 'Home') { e.preventDefault(); showAt(v, 0); }
    else if (k === 'End') { e.preventDefault(); showAt(v, v.seq.total - 1); }
    else if (k === '+' || k === '=') zoomAt(v, 1.5);
    else if (k === '-') zoomAt(v, 1 / 1.5);
    else if (k === '0') resetZoom(v);
    else if (k === 'i') toggleInfo(v);
    else if (k === 'f') act(() => toggleFav(v))();
    else if (k === ' ' && v.show) { e.preventDefault(); pauseSlideshow(v); }
    else if (k === 'Enter' && (e.target === el || !el.contains(e.target)) && v.it?.v && v.it.item) { e.preventDefault(); playVideo(v.it.item).catch(toastErr); }
    else return;
    e.stopPropagation();
  }, true);
  const stage = $('.pv-stage', el);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(v, e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener('dblclick', (e) => { if (v.z.s > 1) resetZoom(v); else zoomAt(v, 2.5, e.clientX, e.clientY); });
  // Pekare: svep (byt foto / nedåt stänger), dra (inzoomat), nyp (två fingrar), dubbeltryck
  const pts = new Map();
  let start = null, pinch = null, lastTap = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    stage.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) start = { x: e.clientX, y: e.clientY, zx: v.z.x, zy: v.z.y, t: Date.now() };
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: v.z.s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; start = null; }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const f = (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d) * pinch.s / v.z.s;
      zoomAt(v, f, pinch.cx, pinch.cy);
    } else if (start && v.z.s > 1) { v.z.x = start.zx + e.clientX - start.x; v.z.y = start.zy + e.clientY - start.y; applyZoom(v); }
    else if (start) { const dx = e.clientX - start.x; frontImg(v).style.transform = Math.abs(dx) > 8 ? `translateX(${dx}px)` : ''; }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pinch) { if (pts.size < 2) pinch = null; start = null; return; }
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y, fast = Date.now() - start.t < 600;
    const s0 = start; start = null;
    if (v.z.s > 1) return;
    frontImg(v).style.transform = '';
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.3) go(v, dx < 0 ? 1 : -1);
    else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5 && fast) closeViewer();
    else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && e.pointerType !== 'mouse') {
      // Dubbeltryck zoomar; ett tryck visar/döljer knapparna
      if (Date.now() - lastTap < 300) { lastTap = 0; if (v.z.s > 1) resetZoom(v); else zoomAt(v, 2.5, s0.x, s0.y); }
      else { lastTap = Date.now(); setTimeout(() => { if (lastTap && Date.now() - lastTap >= 290) { el.classList.toggle('bare'); lastTap = 0; } }, 300); }
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  // Bildspel: knapparna syns en stund när musen rör sig
  let hideT = 0;
  el.addEventListener('pointermove', () => { if (!v.show) return; el.classList.add('ssui'); clearTimeout(hideT); hideT = setTimeout(() => el.classList.remove('ssui'), 2500); });
  window.addEventListener('resize', v.onResize = () => applyZoom(v));
}
function trapTab(el, e) {
  if (!el.contains(document.activeElement)) { e.preventDefault(); el.focus(); return; }
  const f = [...el.querySelectorAll('button:not([disabled]):not([hidden]), a[href], input, select, [tabindex="0"]')].filter(x => x.offsetParent !== null);
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  const n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
  e.preventDefault(); f[n].focus();
}
async function toggleFav(v) {
  const it = v.it; if (!it) return;
  const on = !it.fav;
  const r = await api(`/photos/${+it.id}/favorite`, { method: 'POST', body: { on }, bg: true });
  it.fav = r.fav ? 1 : 0;
  infoCache.delete(it.id);
  v.seq.update?.(v.i, { fav: it.fav });
  if (V === v && v.it === it) {
    const fb = $('#pvfav', v.el);
    setIconButton(fb, it.fav ? '♥' : '♡', it.fav ? t('Ta bort från favoriter (f)') : t('Lägg till i favoriter (f)')); fb.setAttribute('aria-pressed', String(!!it.fav));
  }
  toast(it.fav ? t('Sparad bland favoriterna') : t('Borttagen från favoriterna'));
}
function toggleInfo(v) {
  const p = $('#pvpanel', v.el), b = $('#pvinfo', v.el);
  p.hidden = !p.hidden;
  b.setAttribute('aria-pressed', String(!p.hidden));
  v.el.classList.toggle('withinfo', !p.hidden);
  store.set('photoinfo', !p.hidden);
  if (!p.hidden) fillInfo(v);
}
const num = (x, d = 1) => Number(x).toLocaleString(locale, { maximumFractionDigits: d });
const coordTxt = (lat, lon) => `${num(Math.abs(lat), 6)}° ${lat < 0 ? 'S' : 'N'}, ${num(Math.abs(lon), 6)}° ${lon < 0 ? 'V' : 'Ö'}`;
const exposureTxt = (s) => s >= 1 ? `${num(s, 1)} s` : `1/${Math.round(1 / s)} s`;
const sizeTxt = (b) => b >= 1e6 ? `${num(b / 1e6, 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`;
async function fillInfo(v) {
  const p = $('#pvpanel', v.el), it = v.it;
  if (!it) return;
  p.innerHTML = t('<p class="muted small">Laddar…</p>');
  let x;
  try { x = await infoOf(it.id); } catch (e) { if (V === v) p.innerHTML = errorState(e, { compact: true }); return; }
  if (V !== v || v.it !== it) return;
  const cam = x.camera ? (x.camera.model && x.camera.make && x.camera.model.toLowerCase().startsWith(x.camera.make.toLowerCase().split(' ')[0]) ? x.camera.model : [x.camera.make, x.camera.model].filter(Boolean).join(' ')) : '';
  const expo = [x.fnumber ? `f/${num(x.fnumber)}` : '', x.exposure ? exposureTxt(x.exposure) : '', x.iso ? `ISO ${x.iso}` : '', x.focal ? `${num(x.focal)} mm${x.focal35 ? ` ${t('({focal35} mm motsv.)', { focal35: x.focal35 })}` : ''}` : ''].filter(Boolean).join(' · ');
  const mp = x.w && x.h ? `${x.w} × ${x.h} (${num(x.w * x.h / 1e6, 1)} MP)` : '';
  const rows = [
    [t('När'), fmtWhen(x.t)],
    [t('Fil'), x.name + (x.size ? ` · ${sizeTxt(x.size)}` : '') + (x.format ? ` · ${x.format.toUpperCase()}` : '')],
    [t('Storlek'), mp + (x.kind === 'video' && x.duration ? ` · ${dur(x.duration)}` : '')],
    [t('Kamera'), cam], [t('Objektiv'), x.lens || ''], ['Exponering', expo],
    ['Position', x.gps ? coordTxt(x.gps.lat, x.gps.lon) + (x.gps.alt != null ? ` · ${num(x.gps.alt, 0)} m ö.h.` : '') : ''],
  ].filter(([, t]) => t);
  const lib = x.library;
  p.innerHTML = `<h2>Information</h2><dl>${rows.map(([k, t]) => `<dt>${esc(k)}</dt><dd>${esc(t)}</dd>`).join('')}
    <dt>Album</dt><dd><a href="#/photos/${+lib}/album:${enc(x.folder || '')}" id="pvalb">${esc(x.folder || t('Biblioteksmappen'))}</a></dd></dl>
    ${x.gps ? `<button type="button" class="ghost small" id="pvcopy">${t('Kopiera koordinaterna')}</button>` : ''}`;
  const a = $('#pvalb', p); if (a) a.onclick = () => closeViewer(false);
  const c = $('#pvcopy', p);
  if (c) c.onclick = act(async () => { await navigator.clipboard.writeText(`${x.gps.lat}, ${x.gps.lon}`); toast(t('Koordinaterna kopierade')); });
}

// ---------- bildspel ----------
async function slideshowDialog(seq, from) {
  const musicLibs = libs.filter(l => l.type === 'music');
  const saved = store.get('slideshow', {}) || {};
  const d = openDialog({ title: t('Bildspel'), form: true, body: `<div class="field"><label for="ssint">${t('Byt bild efter')}</label>
      <select id="ssint">${[3, 5, 8, 12, 20].map(s => `<option value="${s}" ${+saved.interval === s || (!saved.interval && s === 5) ? 'selected' : ''}>${t('{s} sekunder', { s })}</option>`).join('')}</select></div>
    <div class="field"><label for="ssmusic">${t('Musik')}</label><select id="ssmusic"><option value="">${t('Ingen musik')}</option></select>
      <p class="muted small" id="ssmhint">${musicLibs.length ? t('Laddar spellistor…') : t('Det finns inget musikbibliotek.')}</p></div>
    <label class="switch"><input type="checkbox" id="ssshuf" ${saved.shuffle ? 'checked' : ''}> ${t('Blanda ordningen')}</label>
    <p class="muted small">${t('Videoklipp hoppas över. Mellanslag pausar, Esc avslutar.')}</p>`,
  actions: [{ label: t('Avbryt') }, { label: t('Starta bildspelet'), kind: 'primary', submit: true, onClick: async (h) => {
    const o = { interval: +h.$('#ssint').value || 5, music: h.$('#ssmusic').value, shuffle: h.$('#ssshuf').checked };
    store.set('slideshow', o);
    let tracks = [];
    if (o.music) {
      const [kind, a, b] = o.music.split(':');
      const r = kind === 'pl' ? await api(`/music/playlists/${+a}`) : await api(`/music/${+a}/smart/${enc(b)}`);
      tracks = r.trackList || [];
      if (!tracks.length) toast(t('Spellistan är tom – bildspelet visas utan musik'));
    }
    if (!V || V.seq !== seq) openViewer(seq, from);
    startSlideshow(V, o, tracks);
  } }] });
  if (!musicLibs.length) return;
  try {
    const [pls, ...smart] = await Promise.all([api('/music/playlists', { bg: true }).catch(() => []), ...musicLibs.map(l => api(`/music/${l.id}/smart`, { bg: true }).catch(() => []))]);
    if (!d.el.isConnected) return;
    const lists = (x) => Array.isArray(x) ? x : x?.lists || [];
    let opts = '';
    smart.forEach((s, k) => {
      const l = musicLibs[k], items = lists(s).filter(x => x.count !== 0);
      if (items.length) opts += `<optgroup label="${esc(l.name)}">${items.map(x => `<option value="smart:${l.id}:${esc(x.id)}">${esc(x.name)}</option>`).join('')}</optgroup>`;
    });
    if (lists(pls).length) opts += `<optgroup label="${t('Dina spellistor')}">${lists(pls).map(p => `<option value="pl:${+p.id}">${esc(p.name)}</option>`).join('')}</optgroup>`;
    d.$('#ssmusic').insertAdjacentHTML('beforeend', opts);
    if (saved.music && d.$(`#ssmusic option[value="${CSS.escape(saved.music)}"]`)) d.$('#ssmusic').value = saved.music;
    d.$('#ssmhint').textContent = opts ? t('Musiken spelas i ljudspelaren och stannar när bildspelet avslutas.') : t('Inga spellistor hittades.');
  } catch (e) { if (d.el.isConnected) d.$('#ssmhint').textContent = e.message; }
}
function startSlideshow(v, o, tracks) {
  stopSlideshow(v);
  if (v.z.s > 1) resetZoom(v);
  const order = o.shuffle ? new Set() : null;
  v.show = { o, paused: false, timer: 0, order, music: tracks.length > 0, wake: null };
  v.el.classList.add('slideshow');
  $('.pv-ssbar', v.el).hidden = false;
  if (!$('#pvpanel', v.el).hidden) toggleInfo(v);
  if (tracks.length) playQueue(tracks, 0);
  navigator.wakeLock?.request?.('screen').then(w => { if (v.show) v.show.wake = w; else w.release(); }).catch(() => {});
  v.el.requestFullscreen?.().catch(() => {});
  restartTimer(v);
  // Dialogen lämnar fokus på knappen som öppnade den – flytta in i visningen
  setTimeout(() => { if (V === v) v.el.focus(); }, 0);
  toast(t('Bildspelet har startat – Esc avslutar'));
}
function restartTimer(v) {
  const s = v.show; if (!s) return;
  clearTimeout(s.timer);
  if (s.paused) return;
  s.timer = setTimeout(() => nextSlide(v), s.o.interval * 1000);
}
async function nextSlide(v) {
  const s = v.show; if (!s || V !== v) return;
  const n = v.seq.total;
  let i = v.i;
  // Nästa bild som inte är ett videoklipp (högst 50 försök); blandat = slumpvis utan upprepning tills alla visats
  for (let k = 0; k < 50; k++) {
    if (s.order) { if (s.order.size >= n) s.order.clear(); do i = Math.floor(Math.random() * n); while (s.order.has(i) && s.order.size < n); s.order.add(i); }
    else i = (i + 1) % n;
    const it = await v.seq.at(i);
    if (it && !it.v) break;
  }
  if (!v.show) return;
  await showAt(v, i, { fade: true });
  restartTimer(v);
}
function pauseSlideshow(v) {
  const s = v.show; if (!s) return;
  s.paused = !s.paused;
  setIconButton($('#pvsspause', v.el), s.paused ? '▶' : '⏸', s.paused ? t('Fortsätt bildspelet (mellanslag)') : t('Pausa bildspelet (mellanslag)'));
  if (s.music && M.audio) { if (s.paused) M.audio.pause(); else M.audio.play().catch(() => {}); }
  restartTimer(v);
}
function stopSlideshow(v) {
  const s = v?.show; if (!s) return;
  clearTimeout(s.timer);
  v.show = null;
  v.el.classList.remove('slideshow', 'ssui');
  $('.pv-ssbar', v.el).hidden = true;
  if (s.music && M.audio && !M.audio.paused) M.audio.pause();
  s.wake?.release?.().catch?.(() => {});
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  frontImg(v)?.classList.remove('slow');
}
