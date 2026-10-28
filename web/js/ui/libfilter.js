// Bibliotekets filter och sortering (views.lib i views/home.js): filterpanelen (popover från ui/menu.js – ark nerifrån
// på telefon), aktiva filter som chips som går att ta bort, och filtret som adressdel (#/lib/1?genre=Drama&sort=year).
// Servern normaliserar och vitlistar allt (server/libfilter.js) – här byggs bara adressdelen och texterna.
import { api, esc, t, lang } from '../core.js';
import { openPopover } from './menu.js';

export const SORT_LABEL = { title: t('Titel'), year: t('År'), rating: t('Betyg'), myrating: t('Mitt betyg'), added: t('Tillagd'), lastwatched: t('Senast sedd'), duration: t('Längd'), random: t('Blandat') };
// Sorteringens naturliga riktning (samma som servern utan order=)
export const SORT_DIR = { title: 'asc', year: 'desc', rating: 'desc', myrating: 'desc', added: 'desc', lastwatched: 'desc', duration: 'desc' };
const WATCH = { unwatched: t('Osedda'), inprogress: t('Påbörjade'), watched: t('Sedda') };
const RES = { '4k': '4K', '1080': '1080p', '720': '720p', sd: 'SD' };
const HDR = { hdr: t('HDR (alla sorter)'), hdr10: 'HDR10', dovi: 'Dolby Vision', hlg: 'HLG', sdr: 'SDR' };
const AUDIO = { atmos: 'Dolby Atmos / DTS:X', surround: t('Surround (5.1 eller fler)'), stereo: 'Stereo' };
const STATUS = { ongoing: t('Pågående'), ended: t('Avslutade') };
const ADDED = [7, 30, 90, 365];
const RATINGS = [5, 6, 7, 8, 9];
// Mitt betyg (stjärnor, ui/rating.js) och om titeln har ett eget betyg
const MY_RATINGS = [1, 2, 3, 3.5, 4, 4.5, 5];
const RATED = { yes: t('Betygsatta av mig'), no: t('Inte betygsatta av mig') };
const starTxt = (v) => String(v).replace('.', ',');
// Längd: filmens längd, för serier avsnittens (minuter)
const LENGTHS = {
  movie: { short: [t('Kort (under 90 min)'), null, 89], normal: [t('Normal (90–130 min)'), 90, 130], long: [t('Lång (över 130 min)'), 131, null] },
  show: { short: [t('Korta avsnitt (under 30 min)'), null, 29], normal: [t('Normala avsnitt (30–50 min)'), 30, 50], long: [t('Långa avsnitt (över 50 min)'), 51, null] }
};
const LISTS = ['genre', 'res', 'hdr', 'audio', 'alang', 'slang'];
let langNames = null;
/** Språkets namn på svenska (Intl), annars koden */
export function langName(code) {
  try { langNames ||= new Intl.DisplayNames([lang], { type: 'language' }); const n = langNames.of(code); if (n && n !== code) return n[0].toUpperCase() + n.slice(1); } catch {}
  return String(code).toUpperCase();
}
const ageName = (a) => +a === 0 ? t('Barntillåten') : t('{a} år', { a: +a });

/** Filtret i adressen efter ? (null om adressen inte har något ?) */
export function hashQuery() {
  const h = location.hash, i = h.indexOf('?');
  return i < 0 ? null : h.slice(i + 1);
}
const listOf = (p, k) => (p.get(k) || '').split(',').map(s => s.trim()).filter(Boolean);
/** Är något filter (inte bara sortering) aktivt? */
export const hasFilter = (qs) => [...new URLSearchParams(qs || '').keys()].some(k => !['sort', 'order', 'seed', 'scol'].includes(k));
/** Antal aktiva filter (för knappen) */
export function filterCount(qs) {
  const p = new URLSearchParams(qs || '');
  let n = 0;
  for (const k of LISTS) n += listOf(p, k).length;
  for (const k of ['filter', 'ratingMin', 'myRatingMin', 'rated', 'addedDays', 'ageMax', 'coll', 'status']) if (p.get(k)) n++;
  for (const [a, b] of [['yearMin', 'yearMax'], ['durMin', 'durMax'], ['seasonsMin', 'seasonsMax']]) if (p.get(a) || p.get(b)) n++;
  return n;
}
const range = (a, b, unit = '') => a && b ? (a === b ? `${a}${unit}` : `${a}–${b}${unit}`) : a ? t('från {a}{unit}', { a, unit }) : t('till {b}{unit}', { b, unit });

/**
 * Aktiva filter som chips: [{ label, remove }] där remove är adressdelen utan just det filtret.
 * @param {string} qs  adressdelen
 * @param {'movie'|'show'} type
 */
export function chips(qs, type) {
  const p = new URLSearchParams(qs || ''), out = [];
  const without = (fn) => { const c = new URLSearchParams(p); fn(c); c.delete('scol'); return c.toString(); };
  const dropVal = (k, v) => without(c => { const l = listOf(c, k).filter(x => x !== v); if (l.length) c.set(k, l.join(',')); else c.delete(k); if (k === 'genre' && l.length < 2) c.delete('genreAll'); });
  const names = { genre: (v) => v, res: (v) => RES[v], hdr: (v) => HDR[v], audio: (v) => AUDIO[v], alang: (v) => t('Ljud: {v}', { v: langName(v) }), slang: (v) => t('Undertext: {v}', { v: langName(v) }) };
  if (WATCH[p.get('filter')]) out.push({ label: WATCH[p.get('filter')], remove: without(c => c.delete('filter')) });
  for (const k of LISTS) for (const v of listOf(p, k)) if (names[k](v)) out.push({ label: names[k](v), remove: dropVal(k, v) });
  if (p.get('genreAll') === '1' && listOf(p, 'genre').length > 1) out.push({ label: t('Alla valda genrer'), remove: without(c => c.delete('genreAll')) });
  if (p.get('yearMin') || p.get('yearMax')) out.push({ label: t('År {v}', { v: range(p.get('yearMin'), p.get('yearMax')) }), remove: without(c => { c.delete('yearMin'); c.delete('yearMax'); }) });
  if (p.get('ratingMin')) out.push({ label: t('Betyg {v}+', { v: p.get('ratingMin') }), remove: without(c => c.delete('ratingMin')) });
  if (p.get('myRatingMin')) out.push({ label: t('Mitt betyg {v}★ eller mer', { v: starTxt(p.get('myRatingMin')) }), remove: without(c => c.delete('myRatingMin')) });
  if (RATED[p.get('rated')]) out.push({ label: RATED[p.get('rated')], remove: without(c => c.delete('rated')) });
  if (p.get('durMin') || p.get('durMax')) out.push({ label: `${type === 'show' ? t('Avsnitt ') : t('Längd ')}${range(p.get('durMin'), p.get('durMax'), ' min')}`, remove: without(c => { c.delete('durMin'); c.delete('durMax'); }) });
  if (p.get('addedDays')) out.push({ label: t('Tillagd senaste {v} dagarna', { v: p.get('addedDays') }), remove: without(c => c.delete('addedDays')) });
  if (p.get('ageMax')) out.push({ label: t('Åldersgräns högst {v}', { v: ageName(p.get('ageMax')) }), remove: without(c => c.delete('ageMax')) });
  if (p.get('coll') === 'yes' || p.get('coll') === 'no') out.push({ label: p.get('coll') === 'yes' ? t('I en samling') : t('Inte i en samling'), remove: without(c => c.delete('coll')) });
  if (STATUS[p.get('status')]) out.push({ label: STATUS[p.get('status')], remove: without(c => c.delete('status')) });
  if (p.get('seasonsMin') || p.get('seasonsMax')) out.push({ label: t('Säsonger {v}', { v: range(p.get('seasonsMin'), p.get('seasonsMax')) }), remove: without(c => { c.delete('seasonsMin'); c.delete('seasonsMax'); }) });
  return out;
}
/** Chipsraden (knappar – Enter/Delete tar bort filtret) */
export const chipsHtml = (list) => list.length ? `<div class="fchips" role="group" aria-label="${t('Aktiva filter')}">${list.map((c, i) =>
  `<button type="button" class="fchip" data-chip="${i}" aria-label="${esc(t('Ta bort filtret {label}', { label: c.label }))}"><span>${esc(c.label)}</span><span class="x" aria-hidden="true">✕</span></button>`).join('')}
  <button type="button" class="ghost small" data-chip="all">${t('Rensa alla')}</button></div>` : '';

// ---------- panelen ----------
let seq = 0;
const cbx = (name, value, label, on, count) => `<label class="fopt"><input type="checkbox" name="${esc(name)}" value="${esc(value)}"${on ? ' checked' : ''}>
  <span>${esc(label)}</span>${count != null ? `<span class="muted small">${+count}</span>` : ''}</label>`;
const opt = (v, l, cur) => `<option value="${esc(v)}"${String(cur ?? '') === String(v) ? ' selected' : ''}>${esc(l)}</option>`;
const sect = (title, body, cls = '') => body ? `<fieldset class="fsect ${cls}"><legend>${esc(title)}</legend>${body}</fieldset>` : '';

/**
 * Öppnar filterpanelen vid knappen.
 * @param {HTMLElement} anchor
 * @param {{ lib: { id: number, type: string }, qs: string, onApply: (qs: string) => void }} o
 */
export async function openFilterPanel(anchor, { lib, qs, onApply }) {
  const facets = await api(`/libraries/${+lib.id}/facets`, { bg: true });
  const type = lib.type === 'show' ? 'show' : 'movie', p = new URLSearchParams(qs || ''), id = 'lf' + (++seq);
  const has = (k, v) => listOf(p, k).includes(v);
  const counts = (list, k, names) => list.map(x => cbx(k, x.value, names ? names[x.value] || x.value : langName(x.value), has(k, x.value), x.count)).join('');
  const len = LENGTHS[type], dMin = p.get('durMin') || '', dMax = p.get('durMax') || '';
  const lenCur = Object.entries(len).find(([, [, a, b]]) => String(a ?? '') === dMin && String(b ?? '') === dMax)?.[0] || (dMin || dMax ? 'custom' : '');
  const y = facets.years, decades = [];
  if (y) for (let d = Math.floor(y.min / 10) * 10; d <= y.max; d += 10) decades.push(d);
  const yMin = p.get('yearMin') || '', yMax = p.get('yearMax') || '';
  const decCur = decades.find(d => String(d) === yMin && String(d + 9) === yMax) ?? '';
  const body = `<form class="fpanel" id="${id}" novalidate>
    ${sect(t('Visa'), `<div class="fopts">${[['', t('Alla')], ...Object.entries(WATCH)].map(([v, l]) => `<label class="fopt"><input type="radio" name="filter" value="${v}"${(p.get('filter') || '') === v ? ' checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>`)}
    ${facets.genres.length ? sect('Genre', `<div class="fopts">${facets.genres.map(g => cbx('genre', g.name, g.name, has('genre', g.name), g.count)).join('')}</div>
      <label class="ccheck small"><input type="checkbox" name="genreAll" value="1"${p.get('genreAll') === '1' ? ' checked' : ''}> ${t('Titeln ska ha alla valda genrer')}</label>`) : ''}
    ${y ? sect(t('År'), `<div class="frow"><label class="fsel"><span>${t('Decennium')}</span><select name="decade">${opt('', t('Alla'), decCur)}${decades.map(d => opt(d, t('{d}-talet', { d }), decCur)).join('')}</select></label>
      <label class="fnum"><span>${t('Från')}</span><input type="number" inputmode="numeric" name="yearMin" min="1800" max="2200" value="${esc(yMin)}" placeholder="${+y.min}"></label>
      <label class="fnum"><span>${t('Till')}</span><input type="number" inputmode="numeric" name="yearMax" min="1800" max="2200" value="${esc(yMax)}" placeholder="${+y.max}"></label></div>`) : ''}
    ${sect(t('Betyg och längd'), `<div class="frow"><label class="fsel"><span>${t('Betyg')}</span><select name="ratingMin">${opt('', t('Alla'), p.get('ratingMin'))}${RATINGS.map(r => opt(r, t('{r} eller högre', { r }), p.get('ratingMin'))).join('')}</select></label>
      <label class="fsel"><span>${t('Mitt betyg')}</span><select name="myRatingMin">${opt('', t('Alla'), p.get('myRatingMin'))}${MY_RATINGS.map(r => opt(r, t('{r} ★ eller mer', { r: starTxt(r) }), p.get('myRatingMin'))).join('')}</select></label>
      <label class="fsel"><span>${t('Betygsatt av mig')}</span><select name="rated">${opt('', t('Alla'), p.get('rated'))}${Object.entries(RATED).map(([k, l]) => opt(k, l, p.get('rated'))).join('')}</select></label>
      <label class="fsel"><span>${type === 'show' ? t('Avsnittens längd') : t('Längd')}</span><select name="len">${opt('', t('Alla'), lenCur)}${Object.entries(len).map(([k, [l]]) => opt(k, l, lenCur)).join('')}${opt('custom', t('Eget intervall'), lenCur)}</select></label>
      <label class="fnum"><span>${t('Minst (min)')}</span><input type="number" inputmode="numeric" name="durMin" min="1" max="1000" value="${esc(dMin)}"></label>
      <label class="fnum"><span>${t('Högst (min)')}</span><input type="number" inputmode="numeric" name="durMax" min="1" max="1000" value="${esc(dMax)}"></label></div>`)}
    ${facets.res.length ? sect(t('Upplösning'), `<div class="fopts">${counts(facets.res, 'res', RES)}</div>`) : ''}
    ${facets.hdr.length ? sect('HDR', `<div class="fopts">${counts(facets.hdr, 'hdr', HDR)}</div>`) : ''}
    ${facets.audio.length ? sect(t('Ljud'), `<div class="fopts">${counts(facets.audio, 'audio', AUDIO)}</div>`) : ''}
    ${facets.alang.length ? sect(t('Ljudspråk'), `<div class="fopts">${counts(facets.alang, 'alang')}</div>`) : ''}
    ${facets.slang.length ? sect(t('Undertextspråk'), `<div class="fopts">${counts(facets.slang, 'slang')}</div>`) : ''}
    ${sect(t('Mer'), `<div class="frow"><label class="fsel"><span>${t('Tillagd')}</span><select name="addedDays">${opt('', t('När som helst'), p.get('addedDays'))}${ADDED.map(d => opt(d, t('Senaste {d} dagarna', { d }), p.get('addedDays'))).join('')}</select></label>
      ${facets.ages.length ? `<label class="fsel"><span>${t('Åldersgräns')}</span><select name="ageMax">${opt('', t('Alla'), p.get('ageMax'))}${facets.ages.map(a => opt(a.age, t('Högst {age}', { age: ageName(a.age) }), p.get('ageMax'))).join('')}</select></label>` : ''}
      ${type === 'movie' && facets.collections ? `<label class="fsel"><span>${t('Samling')}</span><select name="coll">${opt('', t('Alla'), p.get('coll'))}${opt('yes', t('I en samling'), p.get('coll'))}${opt('no', t('Inte i en samling'), p.get('coll'))}</select></label>` : ''}
      ${type === 'show' && (facets.status?.ongoing || facets.status?.ended) ? `<label class="fsel"><span>Status</span><select name="status">${opt('', t('Alla'), p.get('status'))}${Object.entries(STATUS).map(([k, l]) => opt(k, l, p.get('status'))).join('')}</select></label>` : ''}
      ${type === 'show' && facets.seasonsMax > 1 ? `<label class="fnum"><span>${t('Minst säsonger')}</span><input type="number" inputmode="numeric" name="seasonsMin" min="1" max="200" value="${esc(p.get('seasonsMin') || '')}"></label>
        <label class="fnum"><span>${t('Högst säsonger')}</span><input type="number" inputmode="numeric" name="seasonsMax" min="1" max="200" value="${esc(p.get('seasonsMax') || '')}"></label>` : ''}</div>`)}
    <div class="factions"><button type="button" class="ghost" data-clear="1">${t('Rensa')}</button><button type="submit" class="primary" data-apply="1">${t('Visa titlarna')}</button></div>
  </form>`;
  const pop = openPopover(anchor, { html: body, label: 'Filter', title: 'Filter', cls: 'filterpop' });
  const form = pop.body.querySelector('form'), applyBtn = form.querySelector('[data-apply]');
  // Adressdelen ur formuläret (sorteringen följer med oförändrad)
  const read = () => {
    const o = new URLSearchParams(), fd = new FormData(form);
    const f = fd.get('filter'); if (f) o.set('filter', f);
    for (const k of LISTS) { const l = fd.getAll(k); if (l.length) o.set(k, l.join(',')); }
    if (fd.get('genreAll') && fd.getAll('genre').length > 1) o.set('genreAll', '1');
    for (const k of ['yearMin', 'yearMax', 'ratingMin', 'myRatingMin', 'rated', 'durMin', 'durMax', 'addedDays', 'ageMax', 'coll', 'status', 'seasonsMin', 'seasonsMax']) {
      const v = String(fd.get(k) ?? '').trim(); if (v) o.set(k, v);
    }
    for (const k of ['sort', 'order', 'seed']) if (p.get(k)) o.set(k, p.get(k));
    return o.toString();
  };
  // Snabbval fyller i intervallen (och tvärtom: egna värden visar "Eget intervall")
  const set = (n, v) => { form.elements[n].value = v ?? ''; };
  form.elements.decade?.addEventListener('change', (e) => { const d = e.target.value; set('yearMin', d); set('yearMax', d ? +d + 9 : ''); preview(); });
  form.elements.len.addEventListener('change', (e) => { const l = len[e.target.value]; if (l) { set('durMin', l[1]); set('durMax', l[2]); } else if (!e.target.value) { set('durMin', ''); set('durMax', ''); } preview(); });
  for (const n of ['durMin', 'durMax']) form.elements[n].addEventListener('input', () => { form.elements.len.value = form.elements.durMin.value || form.elements.durMax.value ? 'custom' : ''; });
  for (const n of ['yearMin', 'yearMax']) form.elements[n]?.addEventListener('input', () => { if (form.elements.decade) form.elements.decade.value = ''; });
  // Antal träffar medan man väljer (en lätt fråga, limit=1)
  let timer = null, n = 0;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const my = ++n;
      try {
        const d = await api(`/libraries/${+lib.id}/items?${read()}&limit=1`, { bg: true });
        if (my === n && applyBtn.isConnected) applyBtn.textContent = d.total === 1 ? t('Visa 1 titel') : t('Visa {total} titlar', { total: d.total });
      } catch {}
    }, 250);
  };
  form.addEventListener('change', preview);
  form.addEventListener('input', (e) => { if (e.target.type === 'number') preview(); });
  form.querySelector('[data-clear]').onclick = () => { form.reset(); for (const el of form.querySelectorAll('input[type=checkbox],input[type=radio]')) el.checked = el.type === 'radio' && el.value === ''; for (const el of form.querySelectorAll('input[type=number]')) el.value = ''; for (const el of form.querySelectorAll('select')) el.value = ''; preview(); };
  form.addEventListener('submit', (e) => { e.preventDefault(); const q = read(); pop.close(); onApply(q); });
  preview();
  form.querySelector('input,select')?.focus({ preventScroll: true });
  return pop;
}
