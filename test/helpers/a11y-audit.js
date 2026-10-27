// Tillgänglighetsgranskning i webbläsaren (WCAG 2.2 AA) utan npm-beroenden – ett litet axe-liknande skript.
// auditPage körs i sidan (page.evaluate(auditPage, opts)) och returnerar fynd { rule, sel, msg }.
// Tangentbordsdelarna (fokusordning, synlig fokus, dialogernas fokusfälla) körs av testet med riktiga
// tangenttryckningar och använder focusInfo/tabbables här (test/web-a11y.test.js).
//
// Reglerna (namn → WCAG):
//   namn        4.1.2  knappar, länkar, fält, reglage, flikar, menyval, dialoger och iframes har ett namn
//   alt         1.1.1  bilder har alt (tomt för dekor), role=img har ett namn
//   rubriker    1.3.1  en h1 per sida, inga överhoppade nivåer, inga tomma rubriker
//   landmärken  1.3.1  en main, navigeringar med olika namn, allt synligt innehåll i ett landmärke
//   hoppa       2.4.1  en länk "Hoppa till innehållet" först i tabbordningen
//   aria-ref    1.3.1  aria-labelledby/-describedby/-controls … och label[for] pekar på id som finns
//   dubbla-id   4.1.1  inga dubbla id som något pekar på
//   roll        4.1.2  giltiga roller och aria-attribut, obligatoriska attribut och föräldrar
//   tabindex    2.4.3  inget tabindex > 0
//   dold-fokus  4.1.2  inget fokuserbart inuti aria-hidden
//   nästlad     4.1.2  ingen knapp/länk inuti en annan knapp/länk
//   kontrast    1.4.3  text mot beräknad bakgrund (4,5:1, stor text 3:1); bakgrund med bild räknas inte
//   mål         2.5.8  klickytor minst 24 × 24 px (eller tillräckligt avstånd), utom länkar i löptext
//   omflytning  1.4.10 ingen vågrät skrollning av sidan
//   klippt      1.4.4  (opts.clip) text som klipps av en låda med overflow hidden
//   dokument    3.1.1/2.4.2/1.4.4 lang, titel och zoom som inte är spärrad

/* global document, window, getComputedStyle, Node, NodeFilter, CSS */
export function auditPage(opts = {}) {
  const out = [];
  const FOCUSABLE = 'a[href], button:not(:disabled), input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"]), video[controls], audio[controls], iframe';
  const seen = new Set();
  const root = opts.scope ? document.querySelector(opts.scope) : document.body;
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return '?';
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let s = e.localName;
      const cls = [...e.classList].filter(c => !/^(on|sel|open)$/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
      const p = e.parentElement;
      if (p) { const same = [...p.children].filter(c => c.localName === e.localName); if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`; }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const add = (rule, el, msg) => {
    const s = sel(el), k = rule + '|' + s + '|' + msg;
    if (seen.has(k)) return; seen.add(k);
    out.push({ rule, sel: s, msg });
  };
  const cs = (el) => getComputedStyle(el);
  const visible = (el) => {
    if (!el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const inert = (el) => !!el.closest('[inert]');
  const ariaHidden = (el) => !!el.closest('[aria-hidden="true"]');
  const shown = (el) => visible(el) && !inert(el) && !ariaHidden(el) && !el.closest('dialog:not([open])');
  const all = (q) => [...root.querySelectorAll(q)];
  const text = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // ---------- namn (förenklad accname 1.2) ----------
  const NAME_FROM_CONTENT = /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|option|checkbox|radio|switch|heading|cell|gridcell|columnheader|rowheader|treeitem|tooltip|row|sectionhead)$/;
  function textOf(node, top) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    const el = node;
    if (!top) {
      if (el.getAttribute('aria-hidden') === 'true') return '';
      const st = cs(el);
      if (st.display === 'none' || st.visibility === 'hidden') return '';
      const lab = el.getAttribute('aria-label');
      if (lab && lab.trim()) return ' ' + lab + ' ';
    }
    if (el.localName === 'img' || el.localName === 'area') return ' ' + (el.getAttribute('alt') || '') + ' ';
    if (el.localName === 'svg') { const t = el.querySelector(':scope > title'); return t ? ' ' + t.textContent + ' ' : ''; }
    if (!top && (el.localName === 'input' || el.localName === 'select' || el.localName === 'textarea')) return ' ' + (el.value || '') + ' ';
    const before = pseudo(el, '::before'), after = pseudo(el, '::after');
    let s = before;
    for (const c of el.childNodes) s += textOf(c, false);
    if (el.localName === 'slot') return s;
    const block = !top && /^(block|flex|grid|list-item|table)/.test(cs(el).display);
    return (block ? ' ' : '') + s + after + (block ? ' ' : '');
  }
  function pseudo(el, p) {
    const c = getComputedStyle(el, p).content;
    if (!c || c === 'none' || c === 'normal') return '';
    const m = /^"(.*)"$/.exec(c);
    return m ? m[1].replace(/\\"/g, '"') : '';
  }
  function nameOf(el) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = text(lb.split(/\s+/).map(id => { const r = document.getElementById(id); return r ? textOf(r, true) : ''; }).join(' '));
      if (t) return t;
    }
    const al = text(el.getAttribute('aria-label'));
    if (al) return al;
    const tag = el.localName, type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) return text(el.value) || (type === 'submit' ? 'Skicka' : type === 'reset' ? 'Återställ' : '');
    if (tag === 'input' && type === 'image') return text(el.alt);
    if (['input', 'select', 'textarea', 'meter', 'progress', 'output'].includes(tag)) {
      const t = text([...(el.labels || [])].map(l => textOf(l, true)).join(' '));
      if (t) return t;
      if (el.title) return text(el.title);
      return text(el.getAttribute('placeholder'));
    }
    if (tag === 'img') return text(el.getAttribute('alt')) || text(el.title);
    if (tag === 'fieldset') { const lg = el.querySelector(':scope > legend'); if (lg) return text(textOf(lg, true)); }
    if (tag === 'table') { const cp = el.querySelector(':scope > caption'); if (cp) return text(textOf(cp, true)); }
    if (tag === 'dialog' || tag === 'iframe') return text(el.title);
    const role = roleOf(el);
    if (NAME_FROM_CONTENT.test(role) || tag === 'summary') { const t = text(textOf(el, true)); if (t) return t; }
    return text(el.title);
  }
  const IMPLICIT = { button: 'button', a: (e) => e.hasAttribute('href') ? 'link' : '', select: (e) => e.multiple || e.size > 1 ? 'listbox' : 'combobox',
    textarea: 'textbox', dialog: 'dialog', nav: 'navigation', main: 'main', aside: 'complementary', h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading', ul: 'list', ol: 'list', li: 'listitem', img: (e) => e.getAttribute('alt') === '' ? 'presentation' : 'img',
    table: 'table', tr: 'row', td: 'cell', th: 'columnheader', progress: 'progressbar', summary: 'button', form: 'form', fieldset: 'group',
    header: (e) => e.closest('main,article,aside,nav,section') ? '' : 'banner', footer: (e) => e.closest('main,article,aside,nav,section') ? '' : 'contentinfo',
    section: (e) => e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby') ? 'region' : '',
    input: (e) => ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button', image: 'button', search: 'searchbox', number: 'spinbutton', hidden: '' })[(e.getAttribute('type') || 'text').toLowerCase()] ?? 'textbox' };
  function roleOf(el) {
    const r = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (r) return r;
    const i = IMPLICIT[el.localName];
    return typeof i === 'function' ? i(el) : i || '';
  }

  // ---------- dokument ----------
  if (!opts.scope) {
    if (!/^[a-z]{2}/i.test(document.documentElement.lang || '')) add('dokument', document.documentElement, 'html saknar lang');
    if (!text(document.title)) add('dokument', document.documentElement, 'sidan saknar titel');
    const vp = document.querySelector('meta[name=viewport]')?.content || '';
    if (/user-scalable\s*=\s*(no|0)/i.test(vp) || /maximum-scale\s*=\s*(0|1(\.0*)?)(\D|$)/i.test(vp)) add('dokument', document.documentElement, 'zoom är spärrad i viewport');
  }

  // ---------- namn på interaktiva element ----------
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=switch], [role=slider], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=combobox], [role=spinbutton], [role=radio], [role=searchbox], [role=textbox], [role=scrollbar], [role=treeitem]';
  for (const el of all(INTERACTIVE)) {
    if (!shown(el)) continue;
    if (!nameOf(el)) add('namn', el, `${roleOf(el) || el.localName} saknar namn`);
  }
  for (const el of all('dialog[open], [role=dialog], [role=alertdialog], iframe, [role=img], nav, [role=navigation], [role=region], [role=tablist], [role=menu], [role=listbox], [role=radiogroup]')) {
    if (!shown(el)) continue;
    const r = roleOf(el);
    if (['tablist', 'menu', 'listbox', 'radiogroup'].includes(r) && el.closest('dialog')) { if (!nameOf(el) && r !== 'menu') add('namn', el, `${r} saknar namn`); continue; }
    if (r === 'navigation' && document.querySelectorAll('nav, [role=navigation]').length < 2) continue;
    if (!nameOf(el)) add('namn', el, `${r || el.localName} saknar namn`);
  }

  // ---------- bilder ----------
  for (const el of all('img')) {
    if (!shown(el)) continue;
    if (!el.hasAttribute('alt') && el.getAttribute('role') !== 'presentation' && el.getAttribute('role') !== 'none') add('alt', el, 'bild utan alt');
  }
  for (const el of all('svg:not([aria-hidden=true])')) {
    if (!shown(el)) continue;
    if (el.getAttribute('role') === 'img' && !nameOf(el)) add('alt', el, 'svg med role=img utan namn');
    // En svg utan aria-hidden och utan namn i en knapp eller länk är okej (namnet kommer från knappen), annars brus
  }

  // ---------- rubriker ----------
  const heads = all('h1,h2,h3,h4,h5,h6,[role=heading]').filter(shown).filter(h => !h.closest('dialog') || opts.scope);
  let prev = 0;
  if (!opts.scope && !heads.some(h => (h.getAttribute('aria-level') || h.localName.slice(1)) === '1')) add('rubriker', document.querySelector('main') || document.body, 'sidan saknar h1');
  if (!opts.scope && heads.filter(h => h.localName === 'h1' && h.closest('main')).length > 1) add('rubriker', document.querySelector('main'), 'fler än en h1 i main');
  for (const h of heads) {
    const lvl = +(h.getAttribute('aria-level') || h.localName.slice(1)) || 2;
    if (!text(textOf(h, true))) add('rubriker', h, 'tom rubrik');
    if (prev && lvl > prev + 1) add('rubriker', h, `rubriknivå hoppar från h${prev} till h${lvl}`);
    prev = lvl;
  }

  // ---------- landmärken ----------
  if (!opts.scope) {
    const mains = [...document.querySelectorAll('main, [role=main]')].filter(visible);
    if (mains.length !== 1) add('landmärken', document.body, `${mains.length} main`);
    const navs = [...document.querySelectorAll('nav, [role=navigation]')].filter(shown);
    const names = navs.map(nameOf);
    navs.forEach((n, i) => { if (names.indexOf(names[i]) !== i) add('landmärken', n, `två navigeringar heter "${names[i]}"`); });
    const LM = 'header, nav, main, aside, footer, [role=banner], [role=navigation], [role=main], [role=complementary], [role=contentinfo], [role=region], [role=search], [role=dialog], [role=alertdialog], dialog, [role=status], [role=alert], [role=log], [role=form], section[aria-label], section[aria-labelledby], form[aria-label]';
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (!text(n.nodeValue)) continue;
      const p = n.parentElement;
      if (!p || p.closest(LM) || p.closest('script,style,template,noscript,.skiplink') || !shown(p)) continue;
      let top = p; while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
      add('landmärken', top, 'innehåll utanför landmärken');
    }
    // Hoppa till innehållet: första fokuserbara elementet ska vara en länk till main
    const first = tabbables()[0];
    const href = first?.getAttribute('href') || '';
    if (!first || !/^#./.test(href) || !document.getElementById(href.slice(1))?.closest('main')) add('hoppa', first || document.body, 'första tabbstoppet är inte "Hoppa till innehållet"');
  }

  // ---------- aria-referenser och id ----------
  const REFS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-errormessage', 'aria-details', 'aria-flowto'];
  const referenced = new Set();
  for (const el of all(REFS.map(a => `[${a}]`).join(','))) {
    for (const a of REFS) {
      const v = el.getAttribute(a); if (v == null) continue;
      for (const id of v.split(/\s+/).filter(Boolean)) {
        referenced.add(id);
        if (!document.getElementById(id)) add('aria-ref', el, `${a}="${id}" pekar på ett id som inte finns`);
      }
    }
  }
  for (const el of all('label[for]')) {
    const id = el.getAttribute('for'); referenced.add(id);
    const t = document.getElementById(id);
    if (!t) add('aria-ref', el, `label for="${id}" pekar på ett id som inte finns`);
    else if (!/^(input|select|textarea|meter|progress|output|button)$/.test(t.localName)) add('aria-ref', el, `label for="${id}" pekar på ${t.localName}`);
  }
  const ids = new Map();
  for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  for (const [id, n] of ids) if (n > 1 && (referenced.has(id) || document.querySelector(`[href="#${CSS.escape(id)}"]`))) add('dubbla-id', document.getElementById(id), `id "${id}" finns ${n} gånger`);

  // ---------- roller och aria-attribut ----------
  const ROLES = new Set(('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img image insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem').split(' '));
  const ATTRS = new Set(('activedescendant atomic autocomplete braillelabel brailleroledescription busy checked colcount colindex colindextext colspan controls current describedby description details disabled dropeffect errormessage expanded flowto grabbed haspopup hidden invalid keyshortcuts label labelledby level live modal multiline multiselectable orientation owns placeholder posinset pressed readonly relevant required roledescription rowcount rowindex rowindextext rowspan selected setsize sort valuemax valuemin valuenow valuetext').split(' '));
  const BOOL = new Set(['atomic', 'busy', 'disabled', 'modal', 'multiline', 'multiselectable', 'readonly', 'required']);
  const TRISTATE = new Set(['checked', 'pressed']);
  const CONTEXT = { tab: ['tablist'], menuitem: ['menu', 'menubar', 'group'], menuitemcheckbox: ['menu', 'menubar', 'group'], menuitemradio: ['menu', 'menubar', 'group'],
    option: ['listbox', 'group', 'combobox'], treeitem: ['tree', 'group'], gridcell: ['row'], row: ['table', 'grid', 'treegrid', 'rowgroup'], listitem: ['list', 'group'] };
  for (const el of all('*')) {
    const ra = el.getAttribute('role');
    if (ra != null) {
      const r = ra.trim().split(/\s+/)[0];
      if (!ROLES.has(r)) add('roll', el, `ogiltig roll "${ra}"`);
      if (shown(el)) {
        const native = el.localName === 'input';
        if (/^(checkbox|switch|menuitemcheckbox|menuitemradio|radio)$/.test(r) && !native && !el.hasAttribute('aria-checked')) add('roll', el, `${r} saknar aria-checked`);
        if (/^(slider|scrollbar)$/.test(r) && !native && !el.hasAttribute('aria-valuenow')) add('roll', el, `${r} saknar aria-valuenow`);
        if (r === 'heading' && !el.hasAttribute('aria-level')) add('roll', el, 'heading saknar aria-level');
        if (r === 'combobox' && el.localName !== 'select' && !el.hasAttribute('aria-expanded')) add('roll', el, 'combobox saknar aria-expanded');
        const ctx = CONTEXT[r];
        if (ctx && !(el.localName === 'li' && r === 'listitem')) {
          let p = el.parentElement;
          while (p && /^(none|presentation|generic|)$/.test(roleOf(p)) && !ctx.includes(roleOf(p)) && p !== document.body) p = p.parentElement;
          const owned = el.id && document.querySelector(`[aria-owns~="${CSS.escape(el.id)}"]`);
          if (!owned && (!p || !ctx.includes(roleOf(p)))) add('roll', el, `${r} ligger inte i ${ctx.join('/')}`);
        }
      }
    }
    for (const a of el.getAttributeNames()) {
      if (!a.startsWith('aria-')) continue;
      const n = a.slice(5), v = el.getAttribute(a);
      if (!ATTRS.has(n)) { add('roll', el, `okänt attribut ${a}`); continue; }
      if (BOOL.has(n) && !/^(true|false)$/.test(v)) add('roll', el, `${a}="${v}" ska vara true/false`);
      if (TRISTATE.has(n) && !/^(true|false|mixed)$/.test(v)) add('roll', el, `${a}="${v}" ska vara true/false/mixed`);
      if (n === 'hidden' && !/^(true|false|undefined)$/.test(v)) add('roll', el, `aria-hidden="${v}"`);
      if (n === 'expanded' && !/^(true|false|undefined)$/.test(v)) add('roll', el, `aria-expanded="${v}"`);
      if (n === 'live' && !/^(off|polite|assertive)$/.test(v)) add('roll', el, `aria-live="${v}"`);
      if (n === 'current' && !/^(page|step|location|date|time|true|false)$/.test(v)) add('roll', el, `aria-current="${v}"`);
      if (n === 'haspopup' && !/^(true|false|menu|listbox|tree|grid|dialog)$/.test(v)) add('roll', el, `aria-haspopup="${v}"`);
      if (/^value(now|min|max)$/.test(n) && !Number.isFinite(parseFloat(v))) add('roll', el, `${a}="${v}" är inget tal`);
    }
  }
  if (document.body.getAttribute('aria-hidden') === 'true') add('roll', document.body, 'body har aria-hidden');

  // ---------- tabindex, dold fokus, nästlade kontroller ----------
  for (const el of all('[tabindex]')) if (+el.getAttribute('tabindex') > 0) add('tabindex', el, `tabindex=${el.getAttribute('tabindex')}`);
  for (const el of all(FOCUSABLE)) {
    if (!visible(el) || inert(el) || el.closest('dialog:not([open])')) continue;
    if (ariaHidden(el)) add('dold-fokus', el, 'fokuserbart inuti aria-hidden');
  }
  for (const el of all('a[href] a[href], a[href] button, button a[href], button button, a[href] input, button input, button select, a[href] select')) {
    if (shown(el)) add('nästlad', el, `${el.localName} inuti ${el.parentElement.closest('a[href],button').localName}`);
  }

  // ---------- kontrast ----------
  if (opts.contrast !== false) {
    const parse = (c) => {
      const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(c || '');
      if (!m) {
        const s = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c || '');
        return s ? [+s[1] * 255, +s[2] * 255, +s[3] * 255, s[4] == null ? 1 : +s[4]] : null;
      }
      let a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
      return [+m[1], +m[2], +m[3], a];
    };
    const over = (top, bot) => { const a = top[3] + bot[3] * (1 - top[3]); if (!a) return [0, 0, 0, 0]; return [0, 1, 2].map(i => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat(a); };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= +cs(e).opacity; return o; };
    const done = new Set();
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const p = n.parentElement;
      if (!p || done.has(p) || !text(n.nodeValue) || !/[\p{L}\p{N}]/u.test(n.nodeValue)) continue;
      if (p.closest('script,style,template,noscript,video,#player .cues,.subs,[data-noaudit]') || !shown(p)) continue;
      if (p.closest(':disabled, [aria-disabled=true]')) continue; // inaktiva kontroller är undantagna (1.4.3)
      done.add(p);
      const range = document.createRange(); range.selectNodeContents(n);
      const r = [...range.getClientRects()].find(x => x.width > 1 && x.height > 1);
      if (!r || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const st = cs(p);
      if (st.visibility !== 'visible' || parseFloat(st.fontSize) < 6) continue;
      if (st.webkitTextFillColor && st.webkitTextFillColor !== st.color && /rgba?\([^)]*,\s*0\)/.test(st.webkitTextFillColor)) continue; // gradienttext
      let fg = parse(st.color); if (!fg) continue;
      fg = [fg[0], fg[1], fg[2], fg[3] * opacityOf(p)];
      const x = Math.min(innerWidth - 1, Math.max(0, r.left + Math.min(r.width / 2, 6))), y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
      const stack = document.elementsFromPoint(x, y);
      let i = stack.indexOf(p);
      if (i < 0) { i = stack.findIndex(e => e.contains(p)); if (i < 0) continue; } // täckt av något annat
      let bg = [0, 0, 0, 0], unknown = false;
      // Lagren under texten, uppifrån: elementet självt och det som ligger under det på samma punkt
      for (const e of stack.slice(i)) {
        const es = cs(e);
        if (/^(img|video|canvas|picture|iframe)$/.test(e.localName)) { unknown = true; break; }
        if (es.backgroundImage && es.backgroundImage !== 'none') { unknown = true; break; }
        const c = parse(es.backgroundColor);
        if (c && c[3] > 0) {
          bg = over(bg, [c[0], c[1], c[2], c[3] * opacityOf(e)]);
          if (bg[3] >= 0.99) break;
        }
      }
      if (unknown) continue;
      bg = over(bg, [255, 255, 255, 1]); // webbläsarens vita botten under allt
      if (bg[3] < 0.99) continue;
      const f = over(fg, bg);
      const size = parseFloat(st.fontSize), bold = +st.fontWeight >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const k = ratio(f, bg);
      if (k + 0.005 < need) add('kontrast', p, `kontrast ${k.toFixed(2)}:1 (kräver ${need}:1) för "${text(n.nodeValue).slice(0, 30)}" – text ${st.color} mot ${`rgb(${bg.slice(0, 3).map(Math.round).join(',')})`}`);
    }
  }

  // ---------- klickytor (2.5.8) ----------
  if (opts.target !== false) {
    const T = all('button, a[href], input:not([type=hidden]), select, summary, [role=button], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [role=option], [role=radio], [role=slider]').filter(shown);
    const rects = T.map(e => e.getBoundingClientRect());
    T.forEach((el, i) => {
      const r = rects[i];
      if (r.width >= 23.5 && r.height >= 23.5) return;
      if (el.localName === 'a' && /^(inline)$/.test(cs(el).display) && text(el.parentElement?.textContent || '').length > text(el.textContent).length + 10) return; // länk i löptext
      if (el.localName === 'input' && /^(checkbox|radio)$/.test(el.type) && el.labels?.length) return; // etiketten är en del av klickytan
      if (el.closest('[data-noaudit]')) return;
      // Avståndsundantaget: en cirkel med 24 px diameter runt mitten får inte nå en annan klickyta
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = rects.some((o, j) => {
        if (j === i || T[j].contains(el) || el.contains(T[j])) return false;
        const dx = Math.max(o.left - cx, 0, cx - o.right), dy = Math.max(o.top - cy, 0, cy - o.bottom);
        const small = o.width < 23.5 || o.height < 23.5;
        if (small) { const ox = o.left + o.width / 2, oy = o.top + o.height / 2; return Math.hypot(ox - cx, oy - cy) < 24; }
        return Math.hypot(dx, dy) < 12;
      });
      if (hit) add('mål', el, `klickytan är ${Math.round(r.width)}×${Math.round(r.height)} px och ligger för nära en annan`);
    });
  }

  // ---------- omflytning och klippt text ----------
  if (!opts.scope) {
    const sw = document.scrollingElement.scrollWidth;
    if (sw > innerWidth + 1) {
      const wide = all('body *').filter(visible).filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.shelf, [data-noaudit], .tabs, .chips, .rowscroll') && cs(e).position !== 'fixed');
      add('omflytning', wide.at(-1) || document.body, `sidan är ${sw} px bred vid ${innerWidth} px`);
    }
  }
  if (opts.clip) {
    for (const el of all('body *')) {
      if (!shown(el) || el.closest('[data-noaudit]') || el.clientWidth <= 1 || el.clientHeight <= 1) continue; // .sr-only klipps med flit
      const st = cs(el);
      if (!/(hidden|clip)/.test(st.overflowY + st.overflowX)) continue;
      if (st.textOverflow === 'ellipsis' || st.webkitLineClamp !== 'none' && st.webkitLineClamp) continue;
      const own = [...el.childNodes].some(c => c.nodeType === 3 && /[\p{L}\p{N}]/u.test(c.nodeValue)); // symboler (♫ i omslagsplattor) räknas inte
      if (!own) continue;
      if (el.scrollHeight > el.clientHeight + 2 && /hidden|clip/.test(st.overflowY)) add('klippt', el, `texten klipps (${el.scrollHeight} > ${el.clientHeight} px)`);
    }
  }
  return out;

  function tabbables() {
    return [...document.querySelectorAll(FOCUSABLE)].filter(e => visible(e) && !inert(e) && !e.closest('dialog:not([open])') && e.tabIndex >= 0 && !e.closest('[hidden]'));
  }
}

/** Det fokuserade elementet: väljare, om det syns och om fokusmarkeringen syns (ram, skugga eller tydlig färgändring) */
export function focusInfo() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { sel: 'body', body: true };
  const sel = (e) => {
    const parts = [];
    for (; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
      parts.unshift(e.localName + (e.classList.length ? '.' + [...e.classList].slice(0, 2).map(c => CSS.escape(c)).join('.') : ''));
    }
    return parts.join(' > ');
  };
  const st = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const ow = parseFloat(st.outlineWidth) || 0;
  const outline = st.outlineStyle !== 'none' && ow >= 1 && !/rgba\([^)]*,\s*0\)|transparent/.test(st.outlineColor);
  const shadow = st.boxShadow && st.boxShadow !== 'none';
  // Kort och rader markerar ibland fokus på ett barn/förälder (t.ex. bilden får ramen)
  const fw = el.matches(':focus-visible');
  let child = false;
  for (const c of el.querySelectorAll('*')) { const s = getComputedStyle(c); if ((s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1) || (s.boxShadow !== 'none' && /focus|kbd/.test(c.className))) { child = true; break; } }
  const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const hidden = !!el.closest('[inert], [aria-hidden="true"], [hidden]');
  return { sel: sel(el), tag: el.localName, onScreen, hidden, ring: outline || shadow || child, fw, inDialog: !!el.closest('dialog[open], [role=dialog]'), x: Math.round(r.left), y: Math.round(r.top) };
}
