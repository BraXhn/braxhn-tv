// Egna betyg (server/ratings.js): stjärnor 1–5 i halva steg för titlar, album och låtar.
// starsHtml() ritar en reglage-kontroll (role="slider"), bindStars() gör den klickbar och styrbar med tangentbordet
// (←/→ halva steg, 1–5 hela stjärnor, 0/Delete tar bort), rateDialog() är dialogen som kortmenyn och låtarnas ⋮ öppnar.
// Klicka på vänstra halvan av en stjärna = halv stjärna. Samma stjärna igen tar bort betyget.
import { act, api, esc, toast, t } from '../core.js';
import { openDialog } from './dialog.js';

/** "4,5" – stjärnor med svenskt decimaltecken */
export const fmtStars = (v) => String(v).replace('.', ',');
const valueText = (v) => v ? t('{v} av 5 stjärnor', { v: fmtStars(v) }) : t('Inget betyg');
const fills = (v) => [1, 2, 3, 4, 5].map(n => v >= n ? 100 : v >= n - 0.5 ? 50 : 0);

/**
 * Stjärnorna som HTML.
 * @param {number|null|undefined} value  stjärnor (1–5 i halva steg) eller inget
 * @param {{ label?: string, id?: string, cls?: string, readonly?: boolean }} [o]
 */
export function starsHtml(value, { label = t('Mitt betyg'), id = '', cls = '', readonly = false } = {}) {
  const v = +value || 0;
  const stars = fills(v).map(f => `<span class="st" style="--f:${f}%" aria-hidden="true">★</span>`).join('');
  if (readonly) return `<span class="stars ro ${esc(cls)}" role="img" aria-label="${esc(`${label}: ${valueText(v)}`)}">${stars}</span>`;
  return `<span class="stars ${esc(cls)}"${id ? ` id="${esc(id)}"` : ''} role="slider" tabindex="0" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="5"
    aria-valuenow="${v}" aria-valuetext="${esc(valueText(v))}" data-v="${v}" title="${esc(`${label}: ${valueText(v)}`)}">${stars}</span>`;
}
/** Ritar om stjärnorna med ett nytt värde (utan att byta elementet – fokus behålls) */
export function setStars(el, v) {
  v = +v || 0;
  el.dataset.v = String(v);
  el.setAttribute('aria-valuenow', String(v));
  el.setAttribute('aria-valuetext', valueText(v));
  el.title = `${el.getAttribute('aria-label')}: ${valueText(v)}`;
  fills(v).forEach((f, i) => el.children[i]?.style.setProperty('--f', f + '%'));
}
/** Nytt värde ur en tangent (null = tangenten gäller inte betyget) */
export function keyValue(key, cur) {
  if (/^[1-5]$/.test(key)) return +key;
  if (key === '0' || key === 'Delete' || key === 'Backspace') return 0;
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(5, Math.max(1, cur + 0.5));
  if (key === 'ArrowLeft' || key === 'ArrowDown') return cur <= 1 ? 0 : cur - 0.5;
  if (key === 'Home') return 1;
  if (key === 'End') return 5;
  return null;
}
/**
 * Gör stjärnorna styrbara. onChange(värde) anropas med stjärnor (0 = ta bort) och kan vara asynkron –
 * misslyckas den visas det förra värdet igen.
 */
export function bindStars(el, onChange) {
  if (!el) return;
  const commit = act(async (v) => {
    const prev = +el.dataset.v || 0;
    if (v === prev) return;
    setStars(el, v);
    try { await onChange(v); } catch (e) { setStars(el, prev); throw e; }
  });
  const at = (e) => {
    const st = e.target.closest('.st'); if (!st) return null;
    const i = [...el.children].indexOf(st), r = st.getBoundingClientRect();
    return i + (e.clientX - r.left < r.width / 2 ? 0.5 : 1);
  };
  el.addEventListener('click', (e) => {
    let v = at(e); if (v == null) return;
    if (v < 1) v = 1;
    commit(v === (+el.dataset.v || 0) ? 0 : v); // samma värde igen tar bort betyget
  });
  // Förhandsvisning när musen rör sig över stjärnorna
  el.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse') return; const v = at(e); if (v != null) fills(Math.max(1, v)).forEach((f, i) => el.children[i].style.setProperty('--f', f + '%')); });
  el.addEventListener('pointerleave', () => setStars(el, el.dataset.v));
  el.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const v = keyValue(e.key, +el.dataset.v || 0);
    if (v == null) return;
    e.preventDefault(); e.stopPropagation();
    commit(v);
  });
  return { set: (v) => setStars(el, v), commit };
}
/** Sparar ett betyg. kind: 'item' | 'album' | 'track'. Returnerar det sparade värdet (stjärnor eller null). */
export async function saveRating(kind, id, v) {
  const url = kind === 'item' ? `/items/${+id}/rating` : kind === 'album' ? `/music/albums/${+id}/rating` : `/music/tracks/${+id}/rating`;
  const r = await api(url, { method: 'PUT', body: { rating: v || 0 }, bg: true });
  toast(r.rating ? t('Ditt betyg: {rating} ★', { rating: fmtStars(r.rating) }) : t('Betyget är borttaget'));
  return r.rating;
}
/**
 * Dialog för att betygsätta (kortmenyn, låtarnas ⋮). onSaved(värde) efter sparat.
 * @param {{ kind: 'item'|'album'|'track', id: number, title: string, value?: number|null, onSaved?: (v: number|null) => void }} o
 */
export function rateDialog({ kind, id, title, value = null, onSaved }) {
  const h = openDialog({ title: t('Betygsätt {title}', { title }), className: 'ratedlg',
    body: `<p class="muted small">${t('Klicka på en stjärna (vänstra halvan ger en halv) eller använd piltangenterna och 1–5.')}</p>
      <div class="ratebig">${starsHtml(value, { label: t('Mitt betyg för {title}', { title }), cls: 'big' })}</div>`,
    actions: [{ label: t('Ta bort betyg'), id: 'rclear', onClick: async () => { if (+el.dataset.v) { await save(0); setStars(el, 0); } } },
      { label: t('Klar'), kind: 'primary' }] });
  const el = h.$('.stars');
  const save = async (v) => { const r = await saveRating(kind, id, v); onSaved?.(r); };
  bindStars(el, save);
  setTimeout(() => el.focus({ preventScroll: true }), 0);
  return h;
}
