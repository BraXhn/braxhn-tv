// Popupmeny (role=menu) och popover: öppnas från en knapp, med högerklick, långtryck eller Menu-tangenten.
// Piltangenter/D-pad flyttar, Enter väljer, Escape stänger och fokus går tillbaka till knappen.
// Stängs vid klick utanför, skrollning, storleksändring och navigering. På telefon (≤ 600 px) visas den som
// ett ark nerifrån (bottom sheet).
import { esc, leaveFns, onLeave } from '../core.js';

/**
 * @typedef {object} MenuItem
 * @property {string} label
 * @property {string} [icon]          Tecken/emoji framför texten (dekoration)
 * @property {string} [hint]          Liten text till höger, t.ex. "12:30"
 * @property {(item: MenuItem) => any} [onSelect]  Körs efter att menyn stängts (fokus är då tillbaka på knappen)
 * @property {boolean} [danger]
 * @property {boolean} [disabled]
 * @property {boolean} [hidden]       Visas inte alls (praktiskt för villkorade val)
 * @property {MenuItem[]} [submenu]   Öppnar en undermeny i samma ruta (med "Tillbaka")
 * @property {string} [href]          Gör valet till en länk
 * @property {boolean} [download]    Länken laddar ner en fil
 */
/** @typedef {MenuItem | 'separator' | { separator: true }} MenuEntry */

let cur = null; // den öppna menyn
const SHEET = '(max-width: 600px)';
const isSep = (x) => x === 'separator' || x?.separator;

/** Stänger den öppna menyn/popovern (om någon) */
export function closeMenu(restoreFocus = true) { cur?.close(restoreFocus); }
/** Är en meny öppen just nu? */
export const menuOpen = () => !!cur;

/** Gemensamt skal för meny och popover: placering, ark på telefon, stäng-logik */
function popup(anchor, { point, label, title, cls, role, onClose }) {
  // Fokus tillbaka dit det var (t.ex. kortets länk när menyn öppnades med Shift+F10), annars till knappen
  const from = document.activeElement;
  closeMenu(false);
  const sheet = matchMedia(SHEET).matches;
  const back = document.createElement('div'); back.className = 'pop-back' + (sheet ? ' on' : '');
  const el = document.createElement('div');
  el.className = `pop ${cls}${sheet ? ' sheet' : ''}`;
  el.setAttribute('role', role);
  el.id = 'pop' + Date.now();
  if (label) el.setAttribute('aria-label', label);
  el.tabIndex = -1;
  document.body.append(back, el);
  if (anchor?.setAttribute && anchor.hasAttribute('aria-haspopup')) { anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-controls', el.id); }

  const place = () => {
    if (sheet) return;
    const r = point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight, m = 8;
    el.style.maxHeight = (vh - 2 * m) + 'px';
    const w = el.offsetWidth, h = el.offsetHeight;
    // Under knappen, vänsterkant mot knappen; vänds uppåt/åt vänster om den inte får plats
    let x = point ? r.left : r.left, y = r.bottom + 4;
    if (x + w > vw - m) x = Math.max(m, (point ? r.left : r.right) - w);
    if (y + h > vh - m) y = r.top - h - 4 >= m ? r.top - h - 4 : Math.max(m, vh - m - h);
    el.style.left = Math.max(m, x) + 'px'; el.style.top = y + 'px';
  };
  let closed = false;
  const onDown = (e) => { if (!el.contains(e.target) && e.target !== anchor && !anchor?.contains?.(e.target)) close(false); };
  const onScroll = (e) => { if (!el.contains(e.target)) close(false); };
  const onResize = () => close(false);
  const leave = onLeave(() => close(false));
  function close(restoreFocus = true) {
    if (closed) return; closed = true;
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    leaveFns.delete(leave);
    el.remove(); back.remove();
    if (anchor?.setAttribute && anchor.hasAttribute('aria-expanded')) anchor.setAttribute('aria-expanded', 'false');
    if (cur?.el === el) cur = null;
    if (restoreFocus) {
      const to = from?.isConnected && from !== document.body && from.focus && !from.closest('.pop') ? from : anchor;
      if (to?.isConnected && to.focus) to.focus({ preventScroll: true });
    }
    onClose?.();
  }
  // Lyssnarna läggs till efter klicket/trycket som öppnade menyn
  setTimeout(() => { if (closed) return; document.addEventListener('pointerdown', onDown, true); window.addEventListener('scroll', onScroll, true); window.addEventListener('resize', onResize); }, 0);
  back.addEventListener('click', () => close());
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  if (title) el.insertAdjacentHTML('afterbegin', `<div class="pop-title">${esc(title)}</div>`);
  cur = { el, close };
  return { el, close, place };
}

/**
 * Öppnar en meny vid en knapp (eller vid muspekaren vid högerklick).
 * @param {HTMLElement} anchor  Knappen/elementet menyn hör till – får fokus tillbaka när menyn stängs
 * @param {MenuEntry[]} items
 * @param {{ onClose?: () => void, point?: { x: number, y: number }, label?: string, title?: string }} [o]
 *   label = namn för skärmläsare, title = rubrik överst (syns alltid i arket på telefon)
 * @returns {{ el: HTMLElement, close: (restoreFocus?: boolean) => void }}
 */
export function openMenu(anchor, items, { onClose, point, label, title } = {}) {
  const p = popup(anchor, { point, label: label || title, title, cls: 'menu-pop', role: 'menu', onClose });
  const { el, close, place } = p;
  const list = document.createElement('div'); list.className = 'menu-list';
  el.append(list);
  const render = (entries, parent = null) => {
    const vis = entries.filter(x => isSep(x) || !x.hidden);
    // Inga avdelare först, sist eller två i rad
    const clean = vis.filter((x, i) => !isSep(x) || (i > 0 && i < vis.length - 1 && !isSep(vis[i - 1])));
    list.innerHTML = (parent ? `<button type="button" role="menuitem" tabindex="-1" class="mi back" data-back="1"><span class="mi-icon" aria-hidden="true">←</span><span class="mi-label">${esc(parent.label)}</span></button><div role="separator" class="mi-sep"></div>` : '')
      + clean.map((x, i) => isSep(x) ? '<div role="separator" class="mi-sep"></div>'
        : `<${x.href ? `a href="${esc(x.href)}"${x.download ? ' download' : ''}` : 'button type="button"'} role="menuitem" tabindex="-1" class="mi${x.danger ? ' danger' : ''}" data-i="${entries.indexOf(x)}"${x.disabled ? ' aria-disabled="true"' : ''}${x.submenu ? ' aria-haspopup="menu"' : ''}>
          <span class="mi-icon" aria-hidden="true">${esc(x.icon || '')}</span><span class="mi-label">${esc(x.label)}</span>${x.hint ? `<span class="mi-hint">${esc(x.hint)}</span>` : ''}${x.submenu ? '<span class="mi-sub" aria-hidden="true">›</span>' : ''}</${x.href ? 'a' : 'button'}>`).join('');
    list.onclick = (e) => {
      const b = e.target.closest('.mi'); if (!b) return;
      if (b.dataset.back) { e.preventDefault(); return render(items); }
      const x = entries[+b.dataset.i];
      if (!x || x.disabled) { e.preventDefault(); return; }
      if (x.submenu) { e.preventDefault(); return render(x.submenu, x); }
      if (x.href) { close(false); return; }
      close();
      x.onSelect?.(x);
    };
    place();
    focusAt(0);
  };
  const mis = () => [...list.querySelectorAll('.mi')];
  const focusAt = (i) => { const all = mis(); if (all.length) all[(i + all.length) % all.length].focus(); };
  el.addEventListener('keydown', (e) => {
    const all = mis(), i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(all.length - 1); }
    else if (e.key === 'ArrowRight' && document.activeElement?.getAttribute('aria-haspopup')) { e.preventDefault(); document.activeElement.click(); }
    else if (e.key === 'ArrowLeft' && list.querySelector('[data-back]')) { e.preventDefault(); render(items); }
    else if (e.key === 'Tab') { e.preventDefault(); close(); }
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      // Hoppa till första valet som börjar på bokstaven
      const k = e.key.toLowerCase(), n = all.length;
      for (let j = 1; j <= n; j++) { const b = all[(i + j) % n]; if ((b.querySelector('.mi-label')?.textContent || '').trim().toLowerCase().startsWith(k)) { b.focus(); break; } }
    }
  });
  render(items);
  return { el, close };
}

/**
 * Popover med eget innehåll (t.ex. aktivitetspanelen). Samma placering, ark på telefon och stäng-logik som menyn.
 * @param {HTMLElement} anchor
 * @param {{ html?: string, label: string, title?: string, onClose?: () => void, cls?: string }} o
 * @returns {{ el: HTMLElement, body: HTMLElement, close: (restoreFocus?: boolean) => void, place: () => void }}
 */
export function openPopover(anchor, { html = '', label, title, onClose, cls = '' }) {
  const p = popup(anchor, { label, title, cls: 'popover ' + cls, role: 'dialog', onClose });
  const body = document.createElement('div'); body.className = 'pop-body';
  body.innerHTML = html;
  p.el.append(body);
  p.place();
  p.el.focus({ preventScroll: true });
  return { ...p, body };
}

/**
 * Snabbmeny med högerklick, Menu-tangenten/Shift+F10 och långtryck (~500 ms) på pekskärm.
 * Ett vanligt tryck och skrollning fungerar som vanligt; efter ett långtryck följer inget klick.
 * @param {HTMLElement|Document} root   Där lyssnaren sitter (delegering)
 * @param {string} selector             Element som har en snabbmeny, t.ex. '.card[data-id]'
 * @param {(el: HTMLElement, point: {x:number,y:number}|null) => void} open  point = null vid tangentbord
 */
export function contextMenu(root, selector, open) {
  let timer = null, start = null, fired = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  root.addEventListener('contextmenu', (e) => {
    const el = e.target.closest?.(selector); if (!el) return;
    e.preventDefault();
    if (Date.now() - fired < 800) return; // Android skickar contextmenu även efter vårt långtryck
    // Tangentbord (Menu-tangenten, Shift+F10) ger ingen muspekare: öppna vid elementet
    const kb = e.button !== 2 && !e.clientX && !e.clientY;
    open(el, kb ? null : { x: e.clientX, y: e.clientY });
  });
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const el = e.target.closest?.(selector); if (!el) return;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => { timer = null; fired = Date.now(); navigator.vibrate?.(10); open(el, start); }, 500);
  }, { passive: true });
  root.addEventListener('pointermove', (e) => { if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); }, { passive: true });
  for (const ev of ['pointerup', 'pointercancel']) root.addEventListener(ev, cancel, { passive: true });
  window.addEventListener('scroll', cancel, { passive: true, capture: true });
  // Klicket som följer på ett långtryck ska inte öppna länken
  root.addEventListener('click', (e) => { if (Date.now() - fired < 800 && e.target.closest?.(selector)) { e.preventDefault(); e.stopPropagation(); } }, true);
}
