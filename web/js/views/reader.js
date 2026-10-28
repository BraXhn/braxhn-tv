// Läsaren: EPUB (reader/epub.js – sandlåde-iframe med sidbrytning) och serietidningar (reader/comic.js) i helskärm.
// Verktygsfältet: tillbaka, innehåll, bokmärken och markeringar, bokmärk sidan, zoom (serietidningar), inställningar
// och helskärm. Läspositionen sparas per profil (/api/ebooks/:id/progress) en stund efter varje sidbyte och när man
// lämnar läsaren; den syns som "Fortsätt läsa" på startsidan. Tangentbord, pekskärm och TV-fjärr: ← → byter sida
// (vänds för manga), ↑ når verktygsfältet, Esc går tillbaka till boken.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, main, onLeave, store, t, toast, toastErr, views } from '../core.js';
import { iconButton } from '../ui/buttons.js';
import { openDialog, promptDialog } from '../ui/dialog.js';
import { closeMenu, openMenu } from '../ui/menu.js';
import { emptyState } from '../ui/states.js';
import { openEpub, DEFAULTS, FONTS } from '../reader/epub.js';
import { openComic } from '../reader/comic.js';
import { markWhere } from './ebooks.js';

const COLORS = [['yellow', t('Gul')], ['green', t('Grön')], ['blue', t('Blå')], ['pink', t('Rosa')]];
const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '');
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');

views.read = async (id) => {
  const b = await api(`/ebooks/${+id}`);
  if (b.format === 'pdf') {
    main.innerHTML = `<div class="toolbar"><a class="ghost" href="#/ebook/${+b.id}">← ${esc(b.title)}</a><h1>${t('PDF')}</h1></div>
      ${emptyState({ icon: '📄', title: t('PDF:er läses i webbläsarens egen läsare'), html: `<a class="btn primary" href="/api/ebooks/${+b.id}/pdf" target="_blank" rel="noopener">${t('Öppna PDF:en')}</a>` })}`;
    return;
  }
  const comic = b.format === 'cbz';
  const q = hashParams();
  const R = { b, ctl: null, st: null, marks: b.marks, saveT: 0, dirty: false, sel: null, ui: true, gone: false };
  // Läsarens skal: allt bakom (menyrad, sidomeny, flikar) blir inert medan den är öppen
  const back = [$('#top'), $('#rail'), $('#tabbar')].filter(Boolean);
  for (const el of back) el.inert = true;
  document.body.classList.add('rd-open');
  const es = { ...DEFAULTS, ...store.get('reader.epub', {}) };
  const cs = { mode: 'single', fit: 'page', ...store.get('reader.comic', {}), ...(store.get('reader.comic.' + b.id, null) || {}) };
  if (cs.rtl == null) cs.rtl = b.rtl;
  main.innerHTML = `<div class="rd ${comic ? 'rd-comic' : 'rd-epub'}" id="rd" data-theme="${comic ? 'dark' : esc(es.theme)}">
    <h1 class="sr-only">${esc(t('Läser: {title}', { title: b.title }))}</h1>
    <div class="rd-bar">
      ${iconButton({ icon: '←', label: t('Tillbaka till boken (Esc)'), id: 'rdback', cls: 'rdb' })}
      <div class="rd-title"><b>${esc(b.title)}</b><span id="rdch"></span></div>
      ${comic ? '' : iconButton({ icon: '☰', label: t('Innehåll (t)'), id: 'rdtoc', cls: 'rdb', haspopup: 'dialog' })}
      ${iconButton({ icon: '🔖', label: t('Bokmärk sidan (b)'), id: 'rdbm', cls: 'rdb', pressed: false })}
      ${iconButton({ icon: '☷', label: t('Bokmärken och markeringar'), id: 'rdmarks', cls: 'rdb', haspopup: 'dialog' })}
      ${comic ? iconButton({ icon: '−', label: t('Zooma ut (−)'), id: 'rdzout', cls: 'rdb' }) + iconButton({ icon: '+', label: t('Zooma in (+)'), id: 'rdzin', cls: 'rdb' }) : ''}
      ${iconButton({ icon: 'Aa', label: t('Läsinställningar'), id: 'rdset', cls: 'rdb', haspopup: 'dialog' })}
      ${document.fullscreenEnabled ? iconButton({ icon: '⛶', label: t('Helskärm (f)'), id: 'rdfs', cls: 'rdb', pressed: false }) : ''}
    </div>
    <div class="rd-stage" id="rdstage" tabindex="0" role="region" aria-label="${esc(comic ? t('Sidorna') : t('Bokens text'))}" aria-describedby="rdhelp"></div>
    <p class="sr-only" id="rdhelp">${t('Byt sida med vänster- och högerpil. Pil upp når verktygsfältet.')}</p>
    ${iconButton({ icon: '‹', label: t('Föregående sida'), id: 'rdprev', cls: 'rd-nav prev' })}${iconButton({ icon: '›', label: t('Nästa sida'), id: 'rdnext', cls: 'rd-nav next' })}
    <div class="rd-foot"><label class="sr-only" for="rdpos">${t('Position i boken')}</label><input type="range" id="rdpos" min="0" max="${comic ? Math.max(0, b.pages - 1) : 1000}" value="0">
      <span id="rdinfo" class="rd-info" role="status"></span></div>
    <div class="rd-sel" id="rdsel" hidden><button type="button" class="primary small" id="rdhl">${t('Markera')}</button></div>
  </div>`;
  const rd = $('#rd'), stage = $('#rdstage');
  const hasBookmark = () => { const s = R.st; if (!s) return null; return R.marks.find(m => m.kind === 'bookmark' && (comic ? +m.locator.page === s.page : +m.locator.ch === s.ch && Math.floor((+m.locator.p || 0) * s.pages + 1e-6) === s.page)) || null; };
  function onMove(s) {
    R.st = s;
    const pos = $('#rdpos');
    if (comic) {
      pos.value = s.page;
      const txt = s.last !== s.page ? t('Sida {a}–{b} av {n}', { a: s.page + 1, b: s.last + 1, n: s.pages }) : t('Sida {a} av {n}', { a: s.page + 1, n: s.pages });
      pos.setAttribute('aria-valuetext', txt); $('#rdinfo').textContent = txt;
    } else {
      pos.value = Math.round(s.percent * 10);
      const txt = t('{pc} % · sida {a} av {n} i kapitlet', { pc: Math.round(s.percent), a: s.page + 1, n: s.pages });
      pos.setAttribute('aria-valuetext', t('{pc} %', { pc: Math.round(s.percent) })); $('#rdinfo').textContent = txt;
      $('#rdch').textContent = s.title || '';
    }
    const bm = $('#rdbm'); bm.setAttribute('aria-pressed', hasBookmark() ? 'true' : 'false');
    R.dirty = true; clearTimeout(R.saveT); R.saveT = setTimeout(save, 1500);
  }
  function save(keepalive = false) {
    if (!R.dirty || !R.st) return;
    R.dirty = false;
    const body = JSON.stringify({ locator: R.st.locator, percent: R.st.percent });
    if (keepalive) { fetch(`/api/ebooks/${+b.id}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {}); return; }
    api(`/ebooks/${+b.id}/progress`, { method: 'POST', body, bg: true }).catch(() => { R.dirty = true; });
  }
  const toggleUi = (on = !R.ui) => { R.ui = on; rd.classList.toggle('noui', !on); };
  const onTap = (z) => {
    if (z === 'ui') return toggleUi();
    if (comic) return z === 'left' ? R.ctl.left() : R.ctl.right();
    return z === 'prev' ? R.ctl.prev() : R.ctl.next();
  };
  // ---------- markeringar ----------
  async function reloadMarks() {
    R.marks = (await api(`/ebooks/${+b.id}`, { bg: true })).marks;
    if (!comic) await R.ctl.setMarks(R.marks);
    onMove(R.ctl.state()); R.dirty = false;
  }
  function onSelection(sel) {
    R.sel = sel;
    const box = $('#rdsel');
    if (!sel) { box.hidden = true; return; }
    box.hidden = false;
    const w = box.offsetWidth || 90;
    box.style.left = Math.max(8, Math.min(innerWidth - w - 8, sel.rect.x + sel.rect.w / 2 - w / 2)) + 'px';
    box.style.top = Math.max(56, sel.rect.y - 46) + 'px';
  }
  $('#rdhl').onclick = act(async () => {
    const s = R.sel; if (!s) return;
    await api(`/ebooks/${+b.id}/marks`, { method: 'POST', body: { kind: 'highlight', locator: s.locator, text: s.text, color: store.get('reader.hl', 'yellow') }, bg: true });
    R.ctl.clearSelection(); onSelection(null);
    await reloadMarks();
    toast(t('Markerat'));
  });
  function markMenu(mid, pt) {
    const m = R.marks.find(x => x.id === mid); if (!m) return;
    openMenu(stage, [...COLORS.map(([c, name]) => ({ label: t('Färg: {c}', { c: name }), icon: m.color === c ? '✓' : '', onSelect: act(async () => { await api(`/ebooks/marks/${m.id}`, { method: 'PUT', body: { color: c }, bg: true }); store.set('reader.hl', c); await reloadMarks(); }) })),
      'separator', { label: m.note ? t('Ändra anteckningen') : t('Lägg till en anteckning'), icon: '✎', onSelect: () => editNote(m) },
      { label: t('Ta bort markeringen'), icon: '✕', danger: true, onSelect: act(async () => { await api(`/ebooks/marks/${m.id}`, { method: 'DELETE', bg: true }); await reloadMarks(); toast(t('Markeringen togs bort')); }) }],
    { point: pt, title: (m.text || '').slice(0, 60) });
  }
  async function editNote(m) {
    const note = await promptDialog(t('Anteckning'), { title: t('Anteckning till markeringen'), type: 'textarea', value: m.note || '', maxlength: 2000, okLabel: t('Spara') });
    if (note == null) return;
    try { await api(`/ebooks/marks/${m.id}`, { method: 'PUT', body: { note }, bg: true }); await reloadMarks(); } catch (e) { toastErr(e); }
  }
  async function toggleBookmark() {
    const m = hasBookmark();
    if (m) { await api(`/ebooks/marks/${m.id}`, { method: 'DELETE', bg: true }); toast(t('Bokmärket togs bort')); }
    else {
      const s = R.st;
      const text = comic ? t('Sida {n}', { n: s.page + 1 }) : (R.ctl.excerpt() || s.title || '');
      await api(`/ebooks/${+b.id}/marks`, { method: 'POST', body: { kind: 'bookmark', locator: s.locator, text }, bg: true });
      toast(t('Sidan är bokmärkt'));
    }
    await reloadMarks();
  }
  function marksDialog() {
    const list = R.marks;
    const d = openDialog({ title: t('Bokmärken och markeringar'), size: 'wide', body: list.length ? `<ul class="ebmarks">${list.map(m => `<li>
      <button type="button" class="linkish" data-go="${+m.id}">${m.kind === 'highlight' ? `<mark class="ebhl" data-c="${esc(m.color || 'yellow')}">${esc(m.text || '')}</mark>` : `🔖 ${esc(m.text || markWhere(b, m))}`}</button>
      <span class="muted small">${esc(markWhere(b, m))}</span>${m.note ? `<div class="small">${esc(m.note)}</div>` : ''}
      ${iconButton({ icon: '✕', label: m.kind === 'highlight' ? t('Ta bort markeringen') : t('Ta bort bokmärket'), data: { del: m.id } })}</li>`).join('')}</ul>`
      : emptyState({ compact: true, icon: '🔖', title: t('Inga bokmärken än'), text: comic ? t('Bokmärk en sida med knappen 🔖 eller tangenten b.') : t('Bokmärk en sida med 🔖 eller b, och markera text genom att välja den.') }),
    actions: [{ label: t('Stäng') }] });
    $$('[data-go]', d.el).forEach(x => x.onclick = () => { const m = list.find(y => y.id === +x.dataset.go); d.close(); goMark(m); });
    $$('[data-del]', d.el).forEach(x => x.onclick = act(async () => { await api(`/ebooks/marks/${+x.dataset.del}`, { method: 'DELETE', bg: true }); x.closest('li').remove(); await reloadMarks(); }));
  }
  const goMark = (m) => m && (comic ? R.ctl.goTo({ page: +m.locator.page || 0 }) : R.ctl.goTo({ mark: m.id }));
  function tocDialog() {
    const cur = R.st?.ch ?? -1;
    const d = openDialog({ title: t('Innehåll'), body: b.toc.length ? `<ol class="ebtoc">${b.toc.map((c, i) => {
      const ch = b.spine.findIndex(s => s.href === c.href);
      return `<li style="--lvl:${Math.min(4, +c.level || 0)}">${ch >= 0 ? `<button type="button" class="linkish" data-toc="${i}"${ch === cur ? ' aria-current="true"' : ''}>${esc(c.title)}</button>` : esc(c.title)}</li>`;
    }).join('')}</ol>` : emptyState({ compact: true, title: t('Boken har ingen innehållsförteckning') }), actions: [{ label: t('Stäng') }] });
    $$('[data-toc]', d.el).forEach(x => x.onclick = () => { const c = b.toc[+x.dataset.toc]; d.close(); R.ctl.goTo({ ch: b.spine.findIndex(s => s.href === c.href), frag: c.frag }); });
    d.el.querySelector('[aria-current]')?.focus();
  }
  function settingsDialog() {
    if (comic) {
      const d = openDialog({ title: t('Läsinställningar'), body: `
        <fieldset class="rd-opts"><legend>${t('Visning')}</legend>${[['single', t('En sida')], ['double', t('Dubbelsida')], ['webtoon', t('Webtoon (rulla nedåt)')]].map(([v, n]) =>
          `<label><input type="radio" name="cmode" value="${v}" ${cs.mode === v ? 'checked' : ''}> ${n}</label>`).join('')}</fieldset>
        <fieldset class="rd-opts"><legend>${t('Läsriktning')}</legend><label><input type="radio" name="cdir" value="ltr" ${!cs.rtl ? 'checked' : ''}> ${t('Vänster till höger')}</label>
          <label><input type="radio" name="cdir" value="rtl" ${cs.rtl ? 'checked' : ''}> ${t('Höger till vänster (manga)')}</label></fieldset>
        <fieldset class="rd-opts"><legend>${t('Anpassa sidan')}</legend><label><input type="radio" name="cfit" value="page" ${cs.fit === 'page' ? 'checked' : ''}> ${t('Hela sidan')}</label>
          <label><input type="radio" name="cfit" value="width" ${cs.fit === 'width' ? 'checked' : ''}> ${t('Bredden (rulla nedåt)')}</label></fieldset>`, actions: [{ label: t('Stäng'), kind: 'primary' }] });
      d.el.addEventListener('change', () => {
        cs.mode = d.$('[name=cmode]:checked').value; cs.rtl = d.$('[name=cdir]:checked').value === 'rtl'; cs.fit = d.$('[name=cfit]:checked').value;
        store.set('reader.comic', { mode: cs.mode, fit: cs.fit });
        store.set('reader.comic.' + b.id, { rtl: cs.rtl });
        rd.classList.toggle('rtl', cs.rtl);
        R.ctl.setOptions({ mode: cs.mode, rtl: cs.rtl, fit: cs.fit });
      });
      return;
    }
    const d = openDialog({ title: t('Läsinställningar'), body: `
      <fieldset class="rd-opts"><legend>${t('Tema')}</legend>${[['light', t('Ljust')], ['sepia', t('Sepia')], ['dark', t('Mörkt')]].map(([v, n]) =>
        `<label><input type="radio" name="etheme" value="${v}" ${es.theme === v ? 'checked' : ''}> ${n}</label>`).join('')}</fieldset>
      <label for="efont">${t('Typsnitt')}</label><select id="efont">${[['book', t('Bokens eget')], ['serif', t('Serif (Georgia)')], ['sans', t('Sans-serif')], ['easy', t('Lättläst (Verdana)')]]
        .filter(([v]) => v in FONTS).map(([v, n]) => `<option value="${v}" ${es.font === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label for="esize">${t('Textstorlek')} <span id="esizev">${+es.size} %</span></label><input type="range" id="esize" min="70" max="220" step="10" value="${+es.size}" aria-valuetext="${+es.size} %">
      <label for="elh">${t('Radavstånd')}</label><select id="elh">${[[1.25, t('Tätt')], [1.5, t('Normalt')], [1.8, t('Luftigt')]].map(([v, n]) => `<option value="${v}" ${+es.lh === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label for="emargin">${t('Marginaler')}</label><select id="emargin">${[[0.6, t('Smala')], [1, t('Normala')], [1.6, t('Breda')]].map(([v, n]) => `<option value="${v}" ${+es.margin === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label for="ecols">${t('Spalter')}</label><select id="ecols">${[[0, t('Automatiskt (två på bred skärm)')], [1, t('En')], [2, t('Två')]].map(([v, n]) => `<option value="${v}" ${+es.cols === v ? 'selected' : ''}>${n}</option>`).join('')}</select>`,
    actions: [{ label: t('Återställ'), onClick: () => { Object.assign(es, DEFAULTS); apply(); return false; } }, { label: t('Stäng'), kind: 'primary' }] });
    const apply = () => {
      store.set('reader.epub', es);
      rd.dataset.theme = es.theme;
      R.ctl.setSettings(es);
    };
    d.el.addEventListener('input', () => {
      es.theme = d.$('[name=etheme]:checked').value; es.font = d.$('#efont').value; es.size = +d.$('#esize').value;
      es.lh = +d.$('#elh').value; es.margin = +d.$('#emargin').value; es.cols = +d.$('#ecols').value;
      d.$('#esizev').textContent = `${es.size} %`; d.$('#esize').setAttribute('aria-valuetext', `${es.size} %`);
      apply();
    });
  }
  // ---------- tangentbord och fjärrkontroll ----------
  function onKey(e) {
    if (R.gone || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || document.querySelector('dialog[open], .pop')) return;
    const inBar = e.target?.closest?.('.rd-bar, .rd-foot, .rd-sel');
    if (e.target?.closest?.('input, select, textarea') && e.key !== 'Escape') return;
    const k = e.key;
    let done = true;
    if (k === 'Escape') { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else location.hash = `#/ebook/${+b.id}`; }
    else if (inBar && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      const bs = $$('.rd-bar button:not([hidden])'), i = bs.indexOf(document.activeElement);
      if (i >= 0) bs[(i + (k === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length].focus(); else done = false;
    }
    else if (inBar && k === 'ArrowDown') stage.focus();
    else if (inBar && (k === 'Enter' || k === ' ')) done = false;
    else if (k === 'ArrowUp' && !(comic && R.ctl.pan(0, -1))) { toggleUi(true); $('#rdback').focus(); }
    else if (k === 'ArrowDown' && comic) { if (!R.ctl.pan(0, 1)) done = false; }
    else if (k === 'ArrowRight') comic ? (R.ctl.pan(1, 0) || R.ctl.right()) : R.ctl.next();
    else if (k === 'ArrowLeft') comic ? (R.ctl.pan(-1, 0) || R.ctl.left()) : R.ctl.prev();
    else if (k === 'PageDown' || (k === ' ' && !e.shiftKey)) R.ctl.next();
    else if (k === 'PageUp' || (k === ' ' && e.shiftKey)) R.ctl.prev();
    else if (k === 'Home') R.ctl.first();
    else if (k === 'End') R.ctl.last();
    else if (k === 't' && !comic) tocDialog();
    else if (k === 'b') act(toggleBookmark)();
    else if (k === 'f') fullscreen();
    else if ((k === '+' || k === '=') && comic) R.ctl.zoomIn();
    else if ((k === '-' || k === '−') && comic) R.ctl.zoomOut();
    else done = false;
    if (done) e.preventDefault();
  }
  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rd.requestFullscreen?.().catch(() => {});
  }
  const onFs = () => $('#rdfs')?.setAttribute('aria-pressed', document.fullscreenElement ? 'true' : 'false');
  const onVis = () => { if (document.visibilityState === 'hidden') save(true); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('fullscreenchange', onFs);
  document.addEventListener('visibilitychange', onVis);
  $('#rdback').onclick = () => { location.hash = `#/ebook/${+b.id}`; };
  $('#rdprev').onclick = () => comic ? R.ctl.left() : R.ctl.prev();
  $('#rdnext').onclick = () => comic ? R.ctl.right() : R.ctl.next();
  $('#rdbm').onclick = act(toggleBookmark);
  $('#rdmarks').onclick = marksDialog;
  $('#rdset').onclick = settingsDialog;
  if ($('#rdtoc')) $('#rdtoc').onclick = tocDialog;
  if ($('#rdfs')) $('#rdfs').onclick = fullscreen;
  if (comic) { $('#rdzin').onclick = () => R.ctl.zoomIn(); $('#rdzout').onclick = () => R.ctl.zoomOut(); }
  $('#rdpos').addEventListener('change', (e) => { const v = +e.target.value; comic ? R.ctl.goTo({ page: v }) : R.ctl.seek(v / 10); });
  onLeave(() => {
    R.gone = true;
    clearTimeout(R.saveT); save(true);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFs);
    document.removeEventListener('visibilitychange', onVis);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    R.ctl?.destroy();
    for (const el of back) el.inert = false;
    document.body.classList.remove('rd-open');
    closeMenu(false);
  });
  // ---------- öppna boken ----------
  if (comic) {
    rd.classList.toggle('rtl', !!cs.rtl);
    R.ctl = openComic(stage, b, { ...cs, onMove, onTap });
    const p = q.get('mark') ? R.marks.find(m => m.id === +q.get('mark'))?.locator?.page : b.locator?.page;
    R.ctl.goTo({ page: +p || 0 });
  } else {
    R.ctl = openEpub(stage, b, { settings: es, marks: R.marks, onMove, onTap, onSelection, onKey, onMarkClick: markMenu, onPointer: () => closeMenu(false) });
    const loc = q.get('mark') ? { mark: +q.get('mark') } : q.has('ch') ? { ch: +q.get('ch'), frag: q.get('frag') } : (b.locator && Number.isFinite(+b.locator.ch) ? b.locator : { ch: 0, p: 0 });
    await R.ctl.goTo(loc);
  }
  if (!reduced()) rd.classList.add('anim');
  stage.focus({ preventScroll: true });
};
