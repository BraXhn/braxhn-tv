// EPUB i läsaren: kapitlen hämtas som text (/api/ebooks/:id/res – aldrig som en sida), rensas och visas i en
// sandlåde-iframe med sidbrytning i CSS-spalter.
//
// EPUB-innehåll är fientligt. Skydden i lager:
//   1. iframe med sandbox="allow-same-origin" UTAN allow-scripts: inga skript, inga inline-händelser, inga
//      javascript:-adresser, inga formulär, inga popup-fönster och ingen navigering av överordnade sidor.
//      (allow-same-origin behövs för att läsaren ska kunna mäta sidorna och markera text – utan allow-scripts kan
//      innehållet ändå aldrig köra något med den rätten.)
//   2. Egen CSP i iframe-dokumentet: default-src 'none', bilder/typsnitt/media bara från just den här bokens
//      /api/ebooks/<id>/res (och data:), stilar bara inline – inga externa resurser, ingen @import, ingen spårning.
//      Sidans egen CSP gäller dessutom (srcdoc ärver den).
//   3. Rensning med DOMParser (som aldrig kör skript eller hämtar något): skript, iframes, objekt, formulär, meta,
//      base, länkar och SVG-animationer tas bort, alla on*-attribut och javascript:/vbscript:-värden tas bort,
//      resursadresser skrivs om till bokens poster (eller tas bort), och länkar får data-bx-href/-ext i stället för
//      href – klick fångas av läsaren, så inget i boken kan navigera iframe-fönstret.
//   4. Servern lämnar bara ut poster i arkivet, med typ ur en vitlista och CSP sandbox (server/routes/ebooks.js).
import { api, t } from '../core.js';

const DROP = new Set(['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea',
  'option', 'link', 'meta', 'base', 'style', 'template', 'portal', 'dialog', 'track', 'animate', 'set', 'animatemotion', 'animatetransform',
  'foreignobject', 'handler', 'listener', 'discard', 'title', 'audio', 'video', 'source']);
const URL_ATTR = new Set(['src', 'href', 'poster', 'data']);
const BAD_URL = /^[\s\u0000-\u001f]*(javascript|vbscript|livescript|mocha|file|blob):/i;
export const THEMES = {
  light: { bg: '#ffffff', fg: '#1b1b1b', link: '#0b57d0' },
  sepia: { bg: '#f4ecd8', fg: '#3d2f1f', link: '#6b3e00' },
  dark: { bg: '#121212', fg: '#e4e4e4', link: '#8ab4f8' }
};
export const FONTS = { book: null, serif: 'Georgia, "Times New Roman", serif', sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', easy: 'Verdana, Tahoma, sans-serif' };
export const DEFAULTS = { theme: 'light', font: 'book', size: 100, lh: 1.5, margin: 1, cols: 0 };

// ---------- adresser och rensning ----------
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
/** Sökvägen href relativt mappen base i arkivet (utan #/?) – null om den går ovanför roten eller är en annan sorts adress */
export function resolve(base, href) {
  let h = String(href || '').trim().split('#')[0].split('?')[0];
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null;
  try { h = decodeURIComponent(h); } catch {}
  const parts = h.startsWith('/') ? [] : (base ? base.split('/') : []);
  for (const p of h.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(p);
  }
  return parts.length ? parts.join('/') : null;
}
export const resUrl = (id, p) => `/api/ebooks/${+id}/res?p=${encodeURIComponent(p)}`;
/** En resursadress i boken → bokens post, data:-bild/typsnitt, eller null (tas bort) */
function resource(id, base, u) {
  const s = String(u || '').trim();
  if (/^data:(image\/(png|jpe?g|gif|webp|avif|svg\+xml)|font\/|application\/(font|x-font|vnd\.ms-opentype))/i.test(s)) return s;
  if (s.startsWith('#')) return s;
  const p = resolve(base, s);
  return p ? resUrl(id, p) : null;
}
/** Bokens CSS: @import tas bort, url() pekar bara på bokens egna poster (CSP:n stoppar resten ändå) */
export function cleanCss(css, id, base) {
  return String(css || '').slice(0, 1 << 20)
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, u) => { const r = resource(id, base, u); return r ? `url("${r.replace(/["\\]/g, '')}")` : 'none'; })
    .replace(/expression\s*\(|-moz-binding|behavior\s*:/gi, '');
}
/**
 * Rensar ett XHTML-kapitel. Returnerar { body (element i ett inert dokument), css: [text], attrs: { lang, dir, cls } }.
 * fetchCss(path) hämtar en länkad stilmall (text).
 */
export async function sanitizeChapter(text, href, id, fetchCss) {
  let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (doc.querySelector('parsererror') || !doc.documentElement || doc.documentElement.localName === 'parsererror') doc = new DOMParser().parseFromString(text, 'text/html');
  const base = dirOf(href);
  const css = [];
  // Stilmallar: länkade hämtas (bara bokens egna), inline-stilar tas med – båda rensas
  for (const el of doc.querySelectorAll('link, style')) {
    if (el.localName === 'style') css.push(cleanCss(el.textContent, id, base));
    else if (/\bstylesheet\b/i.test(el.getAttribute('rel') || '')) {
      const p = resolve(base, el.getAttribute('href'));
      if (p) { try { css.push(cleanCss(await fetchCss(p), id, dirOf(p))); } catch {} }
    }
  }
  const body = doc.body || doc.querySelector('body') || doc.documentElement;
  const root = doc.documentElement;
  const attrs = { lang: body.getAttribute('lang') || root?.getAttribute('lang') || root?.getAttribute('xml:lang') || '',
    dir: body.getAttribute('dir') || root?.getAttribute('dir') || '', cls: (body.getAttribute('class') || '').slice(0, 300) };
  for (const el of [...body.querySelectorAll('*')]) {
    if (!el.isConnected) continue;
    const name = el.localName.toLowerCase();
    if (DROP.has(name)) { el.remove(); continue; }
    for (const a of [...el.attributes]) {
      const an = a.localName.toLowerCase(), v = a.value;
      if (an.startsWith('on') || an === 'srcdoc' || an === 'srcset' || an === 'formaction' || an === 'action' || an === 'ping' || an === 'target'
        || an === 'background' || an === 'lowsrc' || an === 'dynsrc' || an === 'contenteditable' || an === 'autofocus' || an === 'tabindex' || an === 'accesskey'
        || (an !== 'href' && BAD_URL.test(v))) { el.removeAttributeNode(a); continue; }
      if (an === 'style') { el.setAttribute('style', cleanCss(v, id, base)); continue; }
      if (!URL_ATTR.has(an)) continue;
      if (an === 'href' && (name === 'a' || name === 'area')) {
        el.removeAttributeNode(a);
        const s = v.trim();
        if (/^https?:\/\//i.test(s)) el.setAttribute('data-bx-ext', s.slice(0, 2000));
        else if (s.startsWith('#')) el.setAttribute('data-bx-href', `${href}${s}`);
        else if (!BAD_URL.test(s)) { const p = resolve(base, s); if (p) el.setAttribute('data-bx-href', p + (s.includes('#') ? s.slice(s.indexOf('#')) : '')); }
        continue;
      }
      const r = BAD_URL.test(v) ? null : resource(id, base, v);
      el.removeAttributeNode(a);
      if (r) el.setAttribute(a.localName === 'href' && a.namespaceURI ? 'href' : an, r);
    }
  }
  return { body, css, attrs };
}

// ---------- läsaren ----------
const SHELL = (csp) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style id="bxbook"></style><style id="bxr"></style></head><body></body></html>`;
function readerCss(s, L) {
  const th = THEMES[s.theme] || THEMES.light, font = FONTS[s.font] || null, force = s.theme !== 'light';
  return `html{height:100% !important;overflow:hidden !important;margin:0 !important;padding:0 !important;background:${th.bg} !important}
body{box-sizing:border-box !important;margin:0 !important;height:100vh !important;width:auto !important;max-width:none !important;min-height:0 !important;
  padding:${L.vp}px ${L.m}px !important;column-width:${L.cw}px !important;column-gap:${2 * L.m}px !important;column-fill:auto !important;
  background:${th.bg} !important;color:${th.fg} !important;font-size:${+s.size || 100}% !important;line-height:${+s.lh || 1.5} !important;
  ${font ? `font-family:${font} !important;` : ''}overflow-wrap:break-word;-webkit-text-size-adjust:none;text-size-adjust:none;position:static !important;transform:none !important}
${font ? 'body *{font-family:inherit !important}' : ''}
${force ? `body *:not(mark){color:inherit !important;background-color:transparent !important}` : ''}
body *{max-width:100%;box-sizing:border-box}
p,li,blockquote,dd{line-height:inherit !important;orphans:2;widows:2}
img,svg,video,image{max-width:100% !important;max-height:${Math.max(80, L.H - 2 * L.vp - 4)}px !important;height:auto;object-fit:contain;break-inside:avoid}
svg{height:auto}
[data-bx-href],[data-bx-ext]{color:${th.link} !important;text-decoration:underline;cursor:pointer}
mark.bxhl{color:inherit !important;border-radius:2px;cursor:pointer;padding:0}
mark.bxhl[data-c=yellow]{background:rgba(255,205,0,.45) !important}mark.bxhl[data-c=green]{background:rgba(60,200,90,.4) !important}
mark.bxhl[data-c=blue]{background:rgba(70,150,255,.4) !important}mark.bxhl[data-c=pink]{background:rgba(255,90,170,.4) !important}
mark.bxhl.flash{outline:3px solid ${th.link}}
::selection{background:rgba(255,140,0,.4)}`;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Öppnar EPUB:en book (från /api/ebooks/:id) i stage. opts: { settings, marks, onMove(state), onSelection(sel|null),
 * onMarkClick(id, rect), onTap(zone: 'prev'|'next'|'ui'), onKey(e) }. Returnerar en styrning.
 */
export function openEpub(stage, book, opts) {
  const id = book.id, spine = book.spine;
  const chars = spine.map(s => Math.max(1, s.chars || 0));
  const cum = chars.reduce((a, c) => (a.push(a.at(-1) + c), a), [0]);
  const total = cum.at(-1);
  let settings = { ...DEFAULTS, ...opts.settings };
  let marks = opts.marks || [];
  const texts = new Map();
  const text = (p) => { if (!texts.has(p)) texts.set(p, api(`/ebooks/${id}/res?p=${encodeURIComponent(p)}`, { bg: true }).then(String).catch(e => { texts.delete(p); throw e; })); return texts.get(p); };
  const fr = document.createElement('iframe');
  fr.className = 'rd-frame';
  fr.title = t('Bokens text');
  fr.tabIndex = -1;
  fr.setAttribute('sandbox', 'allow-same-origin');
  fr.setAttribute('referrerpolicy', 'no-referrer');
  const src = `${location.origin}/api/ebooks/${+id}/res`;
  fr.srcdoc = SHELL(`default-src 'none'; img-src data: ${src}; font-src data: ${src}; media-src ${src}; style-src 'unsafe-inline'`);
  stage.append(fr);
  const S = { ch: -1, page: 0, pages: 1, L: null, loading: null, destroyed: false };
  const frameReady = new Promise(r => fr.addEventListener('load', r, { once: true }));
  const doc = () => fr.contentDocument;
  const win = () => fr.contentWindow;

  function layoutVals() {
    const W = Math.max(200, fr.clientWidth), H = Math.max(200, fr.clientHeight);
    const two = settings.cols === 2 || (settings.cols === 0 && W >= 900 && W > H * 1.15);
    const m = Math.round(Math.max(14, Math.min(72, W * (two ? 0.035 : 0.055))) * (+settings.margin || 1));
    const vp = Math.round(Math.max(14, Math.min(48, H * 0.05)));
    const cw = Math.floor(two ? (W - 4 * m) / 2 : W - 2 * m);
    return { W, H, m, vp, cw, two };
  }
  function measure() {
    const d = doc(); if (!d?.body) return;
    S.L = layoutVals();
    d.getElementById('bxr').textContent = readerCss(settings, S.L);
    const sw = d.documentElement.scrollWidth;
    S.pages = Math.max(1, Math.ceil((sw - 4) / S.L.W));
  }
  function show(page, flash = null) {
    S.page = Math.max(0, Math.min(S.pages - 1, page));
    win()?.scrollTo(S.page * S.L.W, 0);
    if (flash) { flash.classList.add('flash'); setTimeout(() => flash.classList.remove('flash'), 1500); }
    opts.onMove?.(state());
  }
  const pageOf = (el) => { const r = el.getBoundingClientRect(); return Math.floor((r.left + win().scrollX + 1) / S.L.W); };
  /** Textposition (antal tecken från kapitlets början) för en punkt i dokumentet */
  function offsetAt(node, off) {
    const r = doc().createRange();
    r.setStart(doc().body, 0);
    try { r.setEnd(node, off); } catch { return 0; }
    return r.toString().length;
  }
  function wrapMarks() {
    const d = doc();
    for (const m of marks) {
      if (m.kind !== 'highlight' || +m.locator?.ch !== S.ch) continue;
      const s = +m.locator.start, e = +m.locator.end;
      if (!(e > s)) continue;
      const w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
      let pos = 0;
      const hits = [];
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const len = n.data.length, a = pos, b = pos + len;
        pos = b;
        if (b <= s) continue;
        if (a >= e) break;
        hits.push([n, Math.max(0, s - a), Math.min(len, e - a)]);
      }
      for (const [n, a, b] of hits) {
        if (b <= a) continue;
        let x = n;
        if (a > 0) x = x.splitText(a);
        if (b - a < x.data.length) x.splitText(b - a);
        const mk = d.createElement('mark');
        mk.className = 'bxhl'; mk.dataset.hl = m.id; mk.dataset.c = m.color || 'yellow';
        x.parentNode.insertBefore(mk, x); mk.append(x);
      }
    }
  }
  async function imagesReady() {
    const imgs = [...doc().images].filter(i => !i.complete);
    if (imgs.length) await Promise.race([Promise.all(imgs.map(i => new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))), sleep(2000)]);
    try { await Promise.race([doc().fonts?.ready, sleep(1500)]); } catch {}
  }
  /** Laddar kapitel ch (om det inte redan visas) */
  async function load(ch) {
    ch = Math.max(0, Math.min(spine.length - 1, ch));
    if (ch === S.ch) return;
    const href = spine[ch].href;
    const [raw] = await Promise.all([text(href), frameReady]);
    if (S.destroyed) return;
    const clean = await sanitizeChapter(raw, href, id, (p) => text(p));
    if (S.destroyed) return;
    const d = doc();
    d.getElementById('bxbook').textContent = clean.css.join('\n');
    d.documentElement.lang = clean.attrs.lang;
    if (clean.attrs.dir === 'rtl' || clean.attrs.dir === 'ltr') d.documentElement.dir = clean.attrs.dir; else d.documentElement.removeAttribute('dir');
    d.body.className = clean.attrs.cls;
    d.body.replaceChildren(...[...clean.body.childNodes].map(n => d.importNode(n, true)));
    S.ch = ch;
    wrapMarks();
    measure();
    await imagesReady();
    if (S.destroyed) return;
    measure();
    // Nästa kapitel hämtas i förväg
    if (spine[ch + 1]) text(spine[ch + 1].href).catch(() => {});
  }
  /** Gå till en position: { ch, p } (andel av kapitlet), { ch, frag }, { ch, start } (textposition) eller { mark } */
  async function goTo(loc = {}) {
    const job = (async () => {
      if (loc.mark) {
        const m = marks.find(x => x.id === +loc.mark);
        if (!m) return goTo({ ch: 0, p: 0 });
        await load(+m.locator.ch || 0);
        const el = m.kind === 'highlight' && doc().querySelector(`mark.bxhl[data-hl="${+m.id}"]`);
        return el ? show(pageOf(el), el) : show(Math.floor((+m.locator.p || 0) * S.pages + 1e-6));
      }
      await load(+loc.ch || 0);
      if (loc.frag) {
        let el = null;
        try { el = doc().getElementById(String(loc.frag)); } catch {}
        return show(el ? pageOf(el) : 0);
      }
      if (loc.last) return show(S.pages - 1);
      show(Math.floor(Math.max(0, Math.min(1, +loc.p || 0)) * S.pages + 1e-6));
    })();
    S.loading = job;
    try { await job; } finally { if (S.loading === job) S.loading = null; }
  }
  function state() {
    const ch = Math.max(0, S.ch);
    const pc = total ? Math.min(100, (cum[ch] + chars[ch] * ((S.page + 1) / S.pages)) / total * 100) : 0;
    const href = spine[ch]?.href;
    let title = '';
    for (const x of book.toc) if (x.href === href) { title = x.title; break; }
    return { ch, page: S.page, pages: S.pages, percent: Math.round(pc * 10) / 10, title, locator: { ch, p: Math.round(S.page / S.pages * 10000) / 10000 } };
  }
  async function next() {
    if (S.loading) return;
    if (S.page < S.pages - 1) return show(S.page + 1);
    if (S.ch < spine.length - 1) return goTo({ ch: S.ch + 1, p: 0 });
  }
  async function prev() {
    if (S.loading) return;
    if (S.page > 0) return show(S.page - 1);
    if (S.ch > 0) return goTo({ ch: S.ch - 1, last: true });
  }
  /** Andel av hela boken (0–100) → kapitel och sida */
  function seek(pc) {
    const x = Math.max(0, Math.min(100, pc)) / 100 * total;
    let ch = 0;
    while (ch < spine.length - 1 && cum[ch + 1] <= x) ch++;
    return goTo({ ch, p: Math.max(0, Math.min(0.9999, (x - cum[ch]) / chars[ch])) });
  }
  /** Början av sidans text (för bokmärkets namn) */
  function excerpt() {
    const d = doc(); if (!d?.body) return '';
    const x = S.L.m + 4, y = S.L.vp + 6;
    let r = null;
    try { r = d.caretRangeFromPoint?.(x, y) || null; } catch {}
    let out = '';
    if (r?.startContainer?.nodeType === 3) {
      const w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
      w.currentNode = r.startContainer;
      out = r.startContainer.data.slice(r.startOffset);
      for (let n = w.nextNode(); n && out.length < 120; n = w.nextNode()) out += n.data;
    }
    return out.replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  // ---------- händelser i boken ----------
  let selTimer = 0, touch = null, lastWheel = 0, swiped = 0;
  function currentSelection() {
    const sel = win()?.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const txt = r.toString().replace(/\s+/g, ' ').trim();
    if (!txt || txt.length > 1000 || !doc().body.contains(r.commonAncestorContainer)) return null;
    const start = offsetAt(r.startContainer, r.startOffset), end = offsetAt(r.endContainer, r.endOffset);
    const fb = fr.getBoundingClientRect(), b = r.getBoundingClientRect();
    return { text: txt, locator: { ch: S.ch, start, end }, rect: { x: fb.left + b.left, y: fb.top + b.top, w: b.width, h: b.height } };
  }
  frameReady.then(() => {
    const d = doc();
    d.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(() => opts.onSelection?.(currentSelection()), 250); });
    d.addEventListener('click', (e) => {
      e.preventDefault();
      if (Date.now() - swiped < 400) return;
      if (!win().getSelection().isCollapsed) return;
      const el = e.target?.closest ? e.target : e.target?.parentElement;
      const mk = el?.closest?.('mark.bxhl');
      if (mk) { const fb = fr.getBoundingClientRect(), b = mk.getBoundingClientRect(); return opts.onMarkClick?.(+mk.dataset.hl, { x: fb.left + b.left, y: fb.top + b.bottom }); }
      const a = el?.closest?.('[data-bx-href],[data-bx-ext]');
      if (a?.dataset.bxExt) { if (/^https?:\/\//i.test(a.dataset.bxExt)) window.open(a.dataset.bxExt, '_blank', 'noopener,noreferrer'); return; }
      if (a?.dataset.bxHref) {
        const [p, frag] = a.dataset.bxHref.split('#');
        const ch = spine.findIndex(s => s.href === p);
        if (ch >= 0) goTo({ ch, frag: frag ? decodeURIComponent(frag) : null });
        return;
      }
      const x = e.clientX / S.L.W;
      opts.onTap?.(x < 0.28 ? 'prev' : x > 0.72 ? 'next' : 'ui');
    }, true);
    d.addEventListener('keydown', (e) => opts.onKey?.(e));
    d.addEventListener('pointerdown', () => opts.onPointer?.());
    d.addEventListener('touchstart', (e) => { const p = e.touches[0]; touch = p ? { x: p.clientX, y: p.clientY, t: Date.now() } : null; }, { passive: true });
    d.addEventListener('touchend', (e) => {
      const p = e.changedTouches[0]; if (!touch || !p) return;
      const dx = p.clientX - touch.x, dy = p.clientY - touch.y;
      if (Math.abs(dx) > 50 && Math.abs(dy) < 60 && Date.now() - touch.t < 800 && win().getSelection().isCollapsed) { swiped = Date.now(); dx < 0 ? next() : prev(); }
      touch = null;
    }, { passive: true });
    d.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (Date.now() - lastWheel < 350) return;
      const v = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (Math.abs(v) < 4) return;
      lastWheel = Date.now();
      v > 0 ? next() : prev();
    }, { passive: false });
  });
  let rz = 0;
  const ro = new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(relayout, 150); });
  ro.observe(stage);
  function relayout() {
    if (S.ch < 0 || S.destroyed) return;
    const frac = S.page / S.pages;
    measure();
    show(Math.floor(frac * S.pages + 1e-6));
  }
  return {
    goTo, next, prev, seek, state, excerpt,
    first: () => goTo({ ch: S.ch, p: 0 }), last: () => goTo({ ch: S.ch, last: true }),
    setSettings(s) { settings = { ...settings, ...s }; relayout(); },
    /** Ny lista med markeringar: kapitlet ritas om på samma sida */
    async setMarks(list) {
      marks = list;
      if (S.ch < 0) return;
      const keep = { ch: S.ch, p: S.page / S.pages };
      S.ch = -1;
      await goTo(keep);
    },
    clearSelection() { try { win()?.getSelection()?.removeAllRanges(); } catch {} },
    destroy() { S.destroyed = true; ro.disconnect(); clearTimeout(selTimer); fr.remove(); }
  };
}
