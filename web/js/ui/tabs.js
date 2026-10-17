// Flikar/segmentväljare (säsonger, musikens flikar). role=tablist med piltangenter (←/→, Home/End),
// aria-selected och "roving tabindex": bara vald flik nås med Tab, pilarna flyttar mellan flikarna.
import { esc } from '../core.js';

/**
 * @param {object} o
 * @param {string} o.label     Namn på fliklistan för skärmläsare, t.ex. "Säsonger"
 * @param {{ key: string, label: string, href?: string }[]} o.items  Med href blir flikarna länkar (byter sida)
 * @param {string} o.current   key för vald flik
 * @param {string} [o.panel]   id på panelen flikarna styr (aria-controls)
 * @param {string} [o.id]
 * @returns {string}
 */
export function tabsHtml({ label, items, current, panel, id }) {
  return `<div class="tabs" role="tablist" aria-label="${esc(label)}"${id ? ` id="${esc(id)}"` : ''}>${items.map(t => {
    const on = String(t.key) === String(current);
    const a = `role="tab" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-tab-key="${esc(t.key)}"${panel ? ` aria-controls="${esc(panel)}"` : ''} class="tabbtn${on ? ' on' : ''}"`;
    return t.href ? `<a ${a} href="${esc(t.href)}">${esc(t.label)}</a>` : `<button type="button" ${a}>${esc(t.label)}</button>`;
  }).join('')}</div>`;
}

// Piltangenterna fungerar i alla fliklistor (även de som ritas om) – en delegerad lyssnare
document.addEventListener('keydown', (e) => {
  const list = e.target.closest?.('[role=tablist]'); if (!list) return;
  const all = [...list.querySelectorAll('[role=tab]')], i = all.indexOf(e.target);
  if (i < 0) return;
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
  if (to == null) return;
  e.preventDefault();
  all[(to + all.length) % all.length].focus();
});

/**
 * Kopplar val av flik (piltangenterna fungerar redan överallt). onSelect anropas med key när en flik väljs (klick, Enter eller mellanslag);
 * för länkflikar sköter webbläsaren navigeringen och onSelect behövs inte.
 * @param {HTMLElement|null} list  Elementet med role=tablist
 * @param {(key: string, tab: HTMLElement) => void} [onSelect]
 */
export function bindTabs(list, onSelect) {
  if (!list) return;
  const tabs = () => [...list.querySelectorAll('[role=tab]')];
  const select = (t) => {
    for (const x of tabs()) { const on = x === t; x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1; x.classList.toggle('on', on); }
    onSelect?.(t.dataset.tabKey, t);
  };
  if (onSelect) list.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t && !t.href) select(t); });
}
