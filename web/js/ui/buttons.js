// Knappar med bara en ikon (♥, ✕, ⏮ …): får alltid ett namn för skärmläsare (aria-label) och ett
// verktygstips (title). Ikonen själv döljs för skärmläsare.
import { esc } from '../core.js';
import { ICON } from './icons.js';

/**
 * @param {object} o
 * @param {string} o.icon     Namn i ICON (t.ex. 'play') eller ett tecken/emoji (t.ex. '✕')
 * @param {string} o.label    Tillgängligt namn, t.ex. "Ta bort ur listan" (escapas)
 * @param {string} [o.id]
 * @param {string} [o.cls='ghost small']  CSS-klasser
 * @param {Record<string,string|number>} [o.data]  data-attribut, t.ex. { fav: 12 } → data-fav="12"
 * @param {boolean} [o.pressed]  Växlingsknapp (aria-pressed), t.ex. favorit eller upprepa
 * @param {string} [o.title]  Verktygstips om det ska skilja sig från label (t.ex. med kortkommando)
 * @param {boolean} [o.disabled]
 * @param {boolean} [o.hidden]
 * @param {string} [o.haspopup]  'menu' eller 'dialog' om knappen öppnar något
 * @returns {string}
 */
export function iconButton({ icon, label, id, cls = 'ghost small', data = {}, pressed, title, disabled, hidden, haspopup }) {
  const glyph = ICON[icon] || `<span aria-hidden="true">${esc(icon)}</span>`;
  const attrs = [`type="button"`, `class="${esc(cls)} iconbtn"`, id ? `id="${esc(id)}"` : '', `aria-label="${esc(label)}"`, `title="${esc(title || label)}"`,
    ...Object.entries(data).map(([k, v]) => `data-${esc(k)}="${esc(v)}"`),
    pressed != null ? `aria-pressed="${pressed ? 'true' : 'false'}"` : '', haspopup ? `aria-haspopup="${esc(haspopup)}"` : '',
    disabled ? 'disabled' : '', hidden ? 'hidden' : ''].filter(Boolean).join(' ');
  return `<button ${attrs}>${glyph}</button>`;
}

/**
 * Byter ikon och namn på en befintlig ikonknapp (t.ex. Spela ↔ Pausa).
 * @param {HTMLElement|null} b
 * @param {string} icon
 * @param {string} label
 */
export function setIconButton(b, icon, label) {
  if (!b) return;
  b.innerHTML = ICON[icon] || `<span aria-hidden="true">${esc(icon)}</span>`;
  b.setAttribute('aria-label', label); b.title = label;
}
