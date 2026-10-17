// Tomma vyer, fel och laddning. Rena strängbyggare (ingen DOM) – används med main.innerHTML eller
// insertAdjacentHTML. Skelett har samma mått som det riktiga innehållet så att sidan inte hoppar när den laddats.
import { esc, main } from '../core.js';

/**
 * Tomt läge: "inget här ännu" med förklaring och ev. en knapp vidare.
 * @param {object} o
 * @param {string} [o.icon]    Tecken/emoji som dekoration (läses inte upp)
 * @param {string} [o.title]   Rubrik (escapas)
 * @param {string} [o.text]    Förklaring (escapas)
 * @param {string} [o.html]    Förklaring som färdig HTML (bara egen, betrodd text – t.ex. med <code>)
 * @param {{ label: string, href?: string, id?: string, kind?: 'primary'|'ghost' }} [o.action]
 * @param {boolean} [o.compact] Mindre luft (inuti en panel eller dialog)
 * @returns {string}
 */
export function emptyState({ icon = '', title = '', text = '', html = '', action = null, compact = false } = {}) {
  const btn = !action ? '' : action.href
    ? `<a class="btn ${action.kind || 'primary'}" href="${esc(action.href)}">${esc(action.label)}</a>`
    : `<button type="button" class="${action.kind || 'primary'}"${action.id ? ` id="${esc(action.id)}"` : ''}>${esc(action.label)}</button>`;
  return `<div class="state empty${compact ? ' compact' : ''}">${icon ? `<div class="state-icon" aria-hidden="true">${esc(icon)}</div>` : ''}
    ${title ? `<h2>${esc(title)}</h2>` : ''}${text ? `<p>${esc(text)}</p>` : ''}${html ? `<p>${html}</p>` : ''}${btn ? `<div class="state-act">${btn}</div>` : ''}</div>`;
}

/**
 * Felläge. Skiljer på ingen kontakt med servern (err.offline) och andra fel.
 * Med retry visas knappen "Försök igen" (id="retry" eller retryId) – koppla den med bindRetry().
 * @param {Error & { offline?: boolean }} err
 * @param {{ retry?: boolean, retryId?: string, compact?: boolean }} [o]
 * @returns {string}
 */
export function errorState(err, { retry = false, retryId = 'retry', compact = false } = {}) {
  const off = !!err?.offline || (typeof navigator !== 'undefined' && navigator.onLine === false);
  const title = off ? 'Ingen kontakt med servern' : 'Något gick fel';
  const text = off ? 'Kontrollera att BraXhn TV körs och att du är ansluten till nätet. Det du har sparat finns kvar.'
    : (err?.message || 'Okänt fel');
  return `<div class="state error${compact ? ' compact' : ''}" role="alert"><div class="state-icon" aria-hidden="true">${off ? '📡' : '⚠'}</div>
    <h2>${title}</h2><p>${esc(text)}</p>${retry ? `<div class="state-act"><button type="button" class="primary" id="${esc(retryId)}">Försök igen</button></div>` : ''}</div>`;
}
/** Kopplar "Försök igen"-knappen från errorState() */
export function bindRetry(root, fn, retryId = 'retry') {
  const b = root.querySelector('#' + retryId);
  if (b) { b.onclick = fn; b.focus({ preventScroll: true }); }
}

const SK_TEXT = '<div class="sk sk-line"></div><div class="sk sk-line short"></div>';
/**
 * Laddningsläge med skelett i samma form som innehållet.
 * @param {{ kind?: 'grid'|'shelves'|'list'|'detail'|'panels'|'inline', count?: number, label?: string }} [o]
 *   grid = affischrutnät, shelves = startsidans rader, list = tabell/lista, detail = titelsida,
 *   panels = admin/konto, inline = liten indikator i en panel eller dialog
 * @returns {string}
 */
export function loadingState({ kind = 'list', count, label = 'Laddar…' } = {}) {
  const sr = `<span class="sr-only">${esc(label)}</span>`;
  const cards = (n, land) => Array.from({ length: n }, () => `<div class="sk-card${land ? ' land' : ''}"><div class="sk sk-art"></div>${SK_TEXT}</div>`).join('');
  let inner;
  if (kind === 'inline') return `<div class="state loading inline" role="status" aria-live="polite"><span class="sk-dots" aria-hidden="true"><i></i><i></i><i></i></span>${sr}</div>`;
  if (kind === 'grid') inner = `<div class="sk sk-h1"></div><div class="grid">${cards(count || 12)}</div>`;
  // Startsidan: tre hyllor med stående affischer på en rad (lika många som får plats – resten klipps)
  else if (kind === 'shelves') inner = [0, 1, 2].map(() => `<div class="section"><div class="sk sk-h2"></div><div class="shelf sk-shelf">${cards(14)}</div></div>`).join('');
  else if (kind === 'detail') inner = `<div class="sk-hero"><div class="sk sk-poster"></div><div class="sk-hero-text"><div class="sk sk-h1"></div>${SK_TEXT}<div class="sk sk-btns"></div></div></div>`;
  else if (kind === 'panels') inner = Array.from({ length: count || 3 }, () => `<div class="panel"><div class="sk sk-h2"></div>${SK_TEXT}${SK_TEXT}</div>`).join('');
  else inner = `<div class="sk sk-h1"></div>${Array.from({ length: count || 6 }, () => `<div class="sk-row"><div class="sk sk-thumb"></div><div style="flex:1">${SK_TEXT}</div></div>`).join('')}`;
  return `<div class="state loading" role="status" aria-busy="true" aria-live="polite">${sr}<div aria-hidden="true">${inner}</div></div>`;
}

/** Tom vy när en sorts bibliotek saknas */
export function noLib(what, type) {
  main.innerHTML = emptyState({ icon: '📁', title: `Inget bibliotek för ${what}`, text: `Lägg till ett bibliotek av typen ${type} under Administration.` });
}
