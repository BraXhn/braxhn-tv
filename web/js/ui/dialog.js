// Dialogrutor: openDialog() är grunden, confirmDialog/promptDialog/formDialog/choiceDialog ersätter
// webbläsarens confirm()/prompt()/alert() (som fungerar dåligt på TV, i installerad app och med skärmläsare).
// Alla dialoger är modala <dialog> med rubrik (aria-labelledby), beskrivning (aria-describedby), fokus på
// första vettiga kontroll, Escape stänger och fokus går tillbaka till knappen som öppnade dialogen.
import { esc, leaveFns, onLeave, toastErr, t } from '../core.js';

let seq = 0;
const FIELD = 'input:not([type=hidden]):not([disabled]),select:not([disabled]),textarea:not([disabled])';

/**
 * @typedef {object} DialogAction
 * @property {string} label            Knapptext (escapas)
 * @property {'primary'|'ghost'|'danger'} [kind='ghost']
 * @property {*} [value]               Värdet dialogen stängs med (om onClick saknas eller returnerar undefined)
 * @property {string} [id]             id på knappen
 * @property {boolean} [submit]        Knappen skickar formuläret i body (Enter i ett fält trycker på den)
 * @property {(d: DialogHandle) => any} [onClick]  Kan vara asynkron. Returnerar den false stängs inte dialogen.
 *                                     Fel visas som toast och dialogen står kvar.
 */
/**
 * @typedef {object} DialogHandle
 * @property {HTMLDialogElement} el
 * @property {(value?: any) => void} close
 * @property {(sel: string) => (HTMLElement|null)} $  querySelector inom dialogen
 * @property {Promise<any>} closed     Uppfylls med värdet dialogen stängdes med ('route' vid navigering, undefined vid Escape)
 */
/**
 * Öppnar en modal dialog.
 * @param {object} o
 * @param {string} o.title               Rubrik (escapas)
 * @param {string|Node} [o.body]         Innehåll: HTML-sträng (servertext ska redan ha gått genom esc()) eller ett element
 * @param {DialogAction[]} [o.actions]   Knappar längst ner. Utan actions får dialogen en Stäng-knapp.
 * @param {(value: any) => void} [o.onClose]
 * @param {'normal'|'wide'} [o.size]
 * @param {string} [o.className]         Extra klass (t.ex. 'trailer')
 * @param {boolean} [o.closeOnRoute=true] Stäng när användaren navigerar till en annan sida (även Bakåt på telefonen)
 * @param {boolean} [o.form]             Lägg body och knappar i ett <form> (Enter skickar, inbyggd validering)
 * @returns {DialogHandle}
 */
export function openDialog({ title, body = '', actions, onClose, size = 'normal', className = '', closeOnRoute = true, form = false }) {
  const id = 'dlg' + (++seq);
  const opener = document.activeElement;
  const d = document.createElement('dialog');
  d.className = ['dlg', size === 'wide' ? 'wide' : '', className].filter(Boolean).join(' ');
  d.setAttribute('aria-labelledby', id + 't');
  d.setAttribute('aria-describedby', id + 'b');
  const acts = actions || [{ label: t('Stäng'), kind: 'ghost' }];
  const wrap = form ? 'form' : 'div';
  d.innerHTML = `<${wrap} class="dlg-in"${form ? ' novalidate' : ''}><h2 class="dlg-title" id="${id}t">${esc(title)}</h2><div class="dlg-body" id="${id}b"></div>
    <div class="dlg-actions">${acts.map((a, i) => `<button type="${a.submit ? 'submit' : 'button'}" class="${a.kind || 'ghost'}" data-act="${i}"${a.id ? ` id="${esc(a.id)}"` : ''}>${esc(a.label)}</button>`).join('')}</div></${wrap}>`;
  const bodyEl = d.querySelector('.dlg-body');
  if (body instanceof Node) bodyEl.append(body); else bodyEl.innerHTML = body;
  document.body.append(d);

  let done, value, leave = null;
  const closed = new Promise(r => { done = r; });
  const close = (v) => { value = v; if (d.open) d.close(); else finish(); };
  const finish = () => {
    if (!d.isConnected) return;
    if (leave) leaveFns.delete(leave);
    d.remove();
    // Fokus tillbaka dit användaren var (om det elementet fortfarande finns kvar)
    if (opener && opener.isConnected && typeof opener.focus === 'function' && value !== 'route') opener.focus({ preventScroll: true });
    try { onClose?.(value); } finally { done(value); }
  };
  d.addEventListener('close', finish);
  const h = { el: d, close, $: (s) => d.querySelector(s), closed };

  const run = async (a, b) => {
    if (!a.onClick) return close(a.value);
    b.disabled = true;
    try { const r = await a.onClick(h); if (r !== false) close(r === undefined ? a.value : r); }
    catch (e) { toastErr(e); }
    finally { b.disabled = false; }
  };
  d.querySelectorAll('[data-act]').forEach(b => {
    const a = acts[+b.dataset.act];
    if (!a.submit) b.addEventListener('click', () => run(a, b));
  });
  if (form) {
    const f = d.querySelector('form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!f.reportValidity()) return;
      const i = acts.findIndex(a => a.submit);
      if (i >= 0) run(acts[i], d.querySelector(`[data-act="${i}"]`));
    });
  }
  if (closeOnRoute) leave = onLeave(() => close('route'));
  // Tab och Shift+Tab går runt inom dialogen (annars kan fokus hamna i webbläsarens adressfält, t.ex. på TV)
  d.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),summary,video[controls]')]
      .filter(x => x.offsetParent !== null || x === document.activeElement);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  d.showModal();
  // Första vettiga kontroll: [autofocus], annars första fältet, annars första knapp som inte är farlig
  const first = d.querySelector('[autofocus]') || bodyEl.querySelector(FIELD)
    || d.querySelector('.dlg-actions button:not(.danger):not(.primary)') || d.querySelector('.dlg-actions button');
  first?.focus();
  return h;
}

/**
 * Bekräftelse (ersätter confirm()). Vid farliga åtgärder får Avbryt fokus, så att Enter inte tar bort något av misstag.
 * @param {string} text  Frågan (escapas)
 * @param {{ title?: string, okLabel?: string, cancelLabel?: string, danger?: boolean }} [o]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(text, { title, okLabel = 'OK', cancelLabel = t('Avbryt'), danger = false } = {}) {
  const d = openDialog({
    title: title || text, body: title ? `<p>${esc(text)}</p>` : '',
    actions: [{ label: cancelLabel, value: false }, { label: okLabel, kind: danger ? 'danger' : 'primary', value: true }]
  });
  if (!danger) d.$('.dlg-actions .primary')?.focus();
  return d.closed.then(v => v === true);
}

/**
 * @typedef {object} Field
 * @property {string} name
 * @property {string} label
 * @property {'text'|'password'|'pin'|'number'|'url'|'textarea'} [type='text']  'pin' = sifferfält som döljs
 * @property {string} [value]
 * @property {string} [placeholder]
 * @property {string} [hint]          Hjälptext under fältet
 * @property {string} [inputmode]
 * @property {string} [autocomplete]  T.ex. 'current-password', 'new-password', 'one-time-code'
 * @property {boolean} [required]
 * @property {number} [minlength]
 * @property {number} [maxlength]
 * @property {string} [pattern]
 */
/** HTML för ett fält i formDialog (exporteras för testerna) */
export const fieldHtml = (f, id) => {
  const type = f.type === 'pin' ? 'password' : f.type || 'text';
  const auto = f.autocomplete ?? (f.type === 'password' ? 'current-password' : f.type === 'pin' ? 'off' : '');
  const im = f.inputmode || (f.type === 'pin' ? 'numeric' : '');
  const attrs = [`id="${id}"`, `name="${esc(f.name)}"`, auto ? `autocomplete="${esc(auto)}"` : '', im ? `inputmode="${esc(im)}"` : '',
    f.placeholder ? `placeholder="${esc(f.placeholder)}"` : '', f.required ? 'required' : '', f.minlength ? `minlength="${+f.minlength}"` : '',
    f.maxlength ? `maxlength="${+f.maxlength}"` : '', f.pattern ? `pattern="${esc(f.pattern)}"` : '', f.hint ? `aria-describedby="${id}h"` : ''].filter(Boolean).join(' ');
  const input = type === 'textarea' ? `<textarea ${attrs} rows="3">${esc(f.value ?? '')}</textarea>`
    : `<input type="${type}" ${attrs} value="${esc(f.value ?? '')}">`;
  return `<div class="field"><label for="${id}">${esc(f.label)}</label>${input}${f.hint ? `<p class="hint" id="${id}h">${esc(f.hint)}</p>` : ''}</div>`;
};

/**
 * Formulär i en dialog. Enter skickar, tomma obligatoriska fält stoppas av webbläsarens validering.
 * @param {{ title: string, text?: string, fields: Field[], okLabel?: string, cancelLabel?: string, danger?: boolean }} o
 * @returns {Promise<Record<string,string>|null>} Fältens värden, eller null om man avbröt
 */
export function formDialog({ title, text = '', fields, okLabel = 'OK', cancelLabel = t('Avbryt'), danger = false }) {
  const base = 'f' + (++seq);
  const d = openDialog({
    title, form: true,
    body: (text ? `<p class="muted">${esc(text)}</p>` : '') + fields.map((f, i) => fieldHtml(f, `${base}_${i}`)).join(''),
    actions: [{ label: cancelLabel, value: null },
      { label: okLabel, kind: danger ? 'danger' : 'primary', submit: true, onClick: (h) => Object.fromEntries(fields.map((f, i) => [f.name, h.$(`#${base}_${i}`).value])) }]
  });
  return d.closed.then(v => v && typeof v === 'object' ? v : null);
}

/**
 * Ett textfält (ersätter prompt()).
 * @param {string} label  Fältets etikett, även rubrik om title saknas
 * @param {Omit<Field,'name'|'label'> & { title?: string, text?: string, okLabel?: string }} [o]
 * @returns {Promise<string|null>} Texten (kan vara tom), eller null om man avbröt
 */
export async function promptDialog(label, { title, text, okLabel = 'OK', ...field } = {}) {
  const r = await formDialog({ title: title || label, text, okLabel, fields: [{ name: 'v', label, ...field }] });
  return r ? r.v : null;
}

/**
 * Välj ett av flera alternativ (t.ex. "Spela in serien": bara den här kanalen / alla kanaler).
 * @param {string} title
 * @param {{ label: string, value: any, kind?: 'primary'|'ghost'|'danger' }[]} choices
 * @param {{ text?: string, cancelLabel?: string }} [o]
 * @returns {Promise<any|null>} Det valda värdet, eller null om man avbröt
 */
export function choiceDialog(title, choices, { text = '', cancelLabel = t('Avbryt') } = {}) {
  const d = openDialog({
    title, body: text ? `<p class="muted">${esc(text)}</p>` : '',
    actions: [{ label: cancelLabel, value: null }, ...choices.map(c => ({ label: c.label, kind: c.kind || 'ghost', value: { v: c.value } }))]
  });
  d.$('.dlg-actions button:nth-child(2)')?.focus();
  return d.closed.then(r => r && typeof r === 'object' && 'v' in r ? r.v : null);
}
