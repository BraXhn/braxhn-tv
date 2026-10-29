// Vyer: ljudböcker och poddar
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, coverImg, esc, fmtDate, fmtDur, fmtTime, hue, keyClick, later, libs, main, me, store, toast, views, toastErr, t } from '../core.js';
import { M, playSpoken, spokenPos, spokenSeek } from '../audio.js';
import { audioCaps } from '../player/caps.js';
import { downloadBook, stateOf, supported as offlineOk } from '../offline.js';
import { loadLibs, route } from '../router.js';
import { emptyState, errorState, loadingState, noLib } from '../ui/states.js';
import { iconButton } from '../ui/buttons.js';
import { bookCard, bookCover, podCover, shelfHtml } from '../ui/cards.js';
import { confirmDialog, openDialog, promptDialog } from '../ui/dialog.js';
import { chapterEditor, feedDialog, mergeBook, restoreBook, statsDialog, toolsStatus } from './booktools.js';

// ---------- ljudböcker ----------
const seriesLabel = (b) => b.series ? `${b.series}${b.seriesNo ? ` #${b.seriesNo}` : ''}` : '';
const withNo = (b) => b.seriesNo ? { ...b, author: `#${b.seriesNo} · ${b.author || ''}` } : b;
// Filter i adressen: #/books/<bibliotek>/serie:<namn> eller /forfattare:<namn> (kodat med encodeURIComponent)
const filterHash = (lid, kind, name) => `#/books/${+lid}/${encodeURIComponent(`${kind}:${name}`)}`;
const GROUPS = [['', t('Ingen gruppering')], ['series', t('Per serie')], ['author', t('Per författare')]];
const coll = (a, b) => String(a).localeCompare(String(b), 'sv', { sensitivity: 'base', numeric: true });
const bySeriesNo = (x, y) => (parseFloat(x.seriesNo) || 1e9) - (parseFloat(y.seriesNo) || 1e9) || coll(x.title, y.title);
/** Gruppera per serie eller författare: grupper i bokstavsordning, böcker utan serie sist, inom en serie i nummerordning */
function grouped(list, by) {
  const m = new Map();
  for (const b of list) { const k = (by === 'series' ? b.series : b.author) || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(b); }
  return [...m].sort(([a], [b]) => (!a) - (!b) || coll(a, b)).map(([k, bs]) => [k, by === 'series' && k ? [...bs].sort(bySeriesNo) : bs]);
}
views.books = async (lid, filter) => {
  // Utan bibliotek-id (t.ex. #/books): första ljudboksbiblioteket, annars en hänvisning
  if (!lid) { const l = libs.find(x => x.type === 'audiobook'); if (!l) return noLib(t('ljudböcker'), t('Ljudböcker')); location.hash = `#/books/${l.id}`; return; }
  let f = null;
  try { const x = /^(serie|forfattare):(.+)$/s.exec(decodeURIComponent(filter || '')); if (x) f = { kind: x[1], name: x[2] }; } catch {}
  const sort = store.get('booksort', 'title'), group = f ? '' : store.get('bookgroup', '');
  const B = await api(`/audiobooks/${lid}?sort=${f ? 'title' : sort}`);
  const key = (b) => String((f?.kind === 'serie' ? b.series : b.author) || '').toLowerCase();
  const list = f ? B.books.filter(b => key(b) === f.name.toLowerCase()) : B.books;
  if (f?.kind === 'serie') list.sort(bySeriesNo);
  const count = (n) => `${n} ${n === 1 ? 'bok' : t('böcker')}`;
  const body = !list.length ? emptyState({ icon: '📚', title: f ? t('Inga böcker') : t('Inga ljudböcker ännu'), html: f ? '' : t('Lägg dem i mappar som <code>Författare/Boktitel/</code> – en .m4b-fil eller flera mp3-filer per bok.') })
    : group ? grouped(list, group).map(([k, bs]) => shelfHtml(k || (group === 'series' ? t('Utan serie') : t('Okänd författare')), bs.map(b => bookCard(group === 'series' && k ? withNo(b) : b)).join(''),
      { more: k ? `${t('<a href="{v}">{bsN} – visa alla</a>', { v: filterHash(lid, group === 'series' ? 'serie' : 'forfattare', k), bsN: count(bs.length) })}` : `<span class="muted small">${count(bs.length)}</span>` })).join('')
    : `<div class="grid">${list.map(b => bookCard(f?.kind === 'serie' ? withNo(b) : b)).join('')}</div>`;
  main.innerHTML = `<div class="toolbar">${f ? `<a class="ghost" href="#/books/${+lid}">← ${esc(B.library.name)}</a><h1>${esc(f.name)}</h1><span class="muted">${f.kind === 'serie' ? t('Serie') : t('Författare')} · ${count(list.length)}</span>
    ${f.kind === 'serie' && list.length ? `<button class="ghost" id="bsfeed" style="margin-left:auto" aria-haspopup="dialog">${t('Lyssna i poddapp')}</button>` : ''}`
    : `<h1>${esc(B.library.name)}</h1><span class="muted">${count(B.books.length)}</span>
    <div class="row" style="margin-left:auto"><button class="ghost" id="bstats" aria-haspopup="dialog">${t('Statistik')}</button><label class="sr-only" for="bgroup">${t('Gruppera')}</label><select id="bgroup">${GROUPS.map(([v, n]) => `<option value="${v}" ${v === group ? 'selected' : ''}>${n}</option>`).join('')}</select>
    <label class="sr-only" for="bsort">${t('Sortera')}</label><select id="bsort">${[['title', t('Titel')], ['author', t('Författare')], ['series', t('Serie')], ['added', t('Senast tillagda')], ['recent', t('Senast lyssnade')]].map(([v, n]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`}</div>
    ${!f && B.continue.length ? `<section class="section"><h2>${t('Fortsätt lyssna')}</h2><div class="shelf">${B.continue.map(bookCard).join('')}</div></section>` : ''}
    ${body}`;
  if ($('#bstats')) $('#bstats').onclick = () => statsDialog();
  if ($('#bsfeed')) $('#bsfeed').onclick = () => feedDialog({ library: +lid, series: list[0].series || f.name });
  if ($('#bsort')) $('#bsort').onchange = (e) => { store.set('booksort', e.target.value); route(); };
  if ($('#bgroup')) $('#bgroup').onchange = (e) => { store.set('bookgroup', e.target.value); route(); };
};
function bookSpoken(b) {
  return { kind: 'book', id: b.id, title: b.title, sub: b.author, link: `#/book/${b.id}`, cover: b.cover ? `/api/audiobooks/cover/${b.id}` : null,
    duration: b.duration, position: b.position, speed: b.speed, chapters: b.chapters,
    files: b.files.map(f => ({ id: f.id, offset: f.offset, duration: f.duration, url: `/api/audiobooks/files/${f.id}/stream?a=${audioCaps()}` })) };
}
views.book = async (id) => {
  const b = await api('/audiobooks/book/' + id);
  const left = b.duration ? b.duration - b.position : 0;
  const lid = b.library;
  const facts = [(b.genres || []).join(', '), b.publisher, b.isbn ? `ISBN ${b.isbn}` : ''].filter(Boolean).join(' · ');
  main.innerHTML = `<div class="mhero">${bookCover(b, 'big')}<div><div class="muted small">${t('LJUDBOK')}</div><h1>${esc(b.title)}</h1>
    ${b.subtitle ? `<div class="muted">${esc(b.subtitle)}</div>` : ''}
    <div class="meta">${b.author ? `<a href="${filterHash(lid, 'forfattare', b.author)}">${esc(b.author)}</a>` : ''}${b.narrator ? `<span>${t('Uppläsare: {narrator}', { narrator: esc(b.narrator) })}</span>` : ''}${b.year ? `<span>${+b.year}</span>` : ''}<span>${fmtDur(b.duration)}</span>
      ${b.position > 30 ? `<span>${t('{left} kvar', { left: fmtDur(left) })}</span>` : ''}${b.finished ? t('<span>✓ Utläst</span>') : ''}${b.listened >= 60 ? `<span>${t('Du har lyssnat {v}', { v: fmtDur(b.listened) })}</span>` : ''}</div>
    ${b.series ? `<div class="meta"><span>${t('Serie: <a href="{v}">{v2}</a>', { v: filterHash(lid, 'serie', b.series), v2: esc(seriesLabel(b)) })}</span></div>` : ''}
    <div class="row"><button class="primary" id="bp">${b.position > 30 ? t('▶ Fortsätt') : t('▶ Lyssna')}</button>${b.position > 30 || b.finished ? t('<button class="ghost" id="bstart">Börja om</button>') : ''}
      <button class="ghost" id="bmark">${t('🔖 Bokmärke')}</button>${b.finished ? t('<button class="ghost" id="bundone">Markera som oläst</button>') : t('<button class="ghost" id="bdone">Markera som utläst</button>')}${b.feedsAllowed ? `<button class="ghost" id="bfeed" aria-haspopup="dialog">${t('Lyssna i poddapp')}</button>` : ''}${me?.canDownload === false || !offlineOk() ? '' : `<button class="ghost" id="boff" title="${t('Spara i webbläsaren och lyssna utan nät')}">${stateOf('book', b.id) === 'done' ? t('✓ Sparad offline') : t('⤓ Spara offline')}</button>`}
      ${me?.is_admin ? t('<button class="ghost" id="bmatch">Fel bok?</button><button class="ghost" id="bedit">Redigera</button>') : ''}${me?.is_admin && b.tools ? `<button class="ghost" id="bchap" aria-haspopup="dialog">${t('Redigera kapitel')}</button>${b.tools.canMerge && !b.tools.state?.running ? `<button class="ghost" id="bmerge">${t('Slå ihop till M4B')}</button>` : ''}` : ''}</div>
    ${me?.is_admin ? toolsStatus(b) : ''}
    ${b.description ? `<p class="overview">${esc(b.description)}</p>` : ''}
    ${facts ? `<p class="muted small">${esc(facts)}</p>` : ''}</div></div>
    ${b.bookmarks.length ? `<section class="section"><h2>${t('Bokmärken')}</h2><table>${b.bookmarks.map(m => `<tr><td><button class="ghost small" data-bm="${m.position}">${fmtTime(m.position)}</button></td><td>${esc(m.note || '')}</td><td class="muted small">${fmtDate(m.created)}</td><td class="r">${iconButton({ icon: '✕', label: t('Ta bort bokmärket vid {position}', { position: fmtTime(m.position) }), data: { bmdel: m.id } })}</td></tr>`).join('')}</table></section>` : ''}
    <section class="section"><h2>${t('Kapitel{v}', { v: b.chapterSource === 'audnexus' ? t(' <span class="muted small">från Audnexus</span>') : b.chapterSource === 'redigerad' ? t(' <span class="muted small">redigerade</span>') : '' })}</h2><table class="tracks">${b.chapters.map((c, i) => `<tr data-chs="${c.start}" class="${c.start <= b.position && b.position < c.end ? 'playing' : ''}"><td class="muted" style="width:40px">${i + 1}</td><td>${esc(c.title)}</td><td class="r muted">${fmtTime(c.end - c.start)}</td></tr>`).join('')}</table></section>
    ${b.sameSeries?.length ? shelfHtml(t('Fler i serien {series}', { series: b.series }), b.sameSeries.map(x => bookCard({ ...x, author: x.seriesNo ? `#${x.seriesNo}` : '' })).join(''), { more: `${t('<a href="{v}">Visa serien</a>', { v: filterHash(lid, 'serie', b.series) })}` }) : ''}
    ${b.sameAuthor.length ? `<section class="section"><h2>${t('Mer av {author}', { author: esc(b.author) })}</h2><div class="shelf">${b.sameAuthor.map(x => bookCard({ ...x, author: b.author })).join('')}</div></section>` : ''}`;
  const sp = bookSpoken(b);
  $('#bp').onclick = () => playSpoken(sp);
  if ($('#bstart')) $('#bstart').onclick = () => playSpoken({ ...sp, position: 0 });
  $$('[data-chs]').forEach(r => keyClick(r).onclick = () => { if (M.spoken?.kind === 'book' && M.spoken.id === b.id) spokenSeek(+r.dataset.chs + 0.01); else playSpoken({ ...sp, position: +r.dataset.chs + 0.01 }); });
  $$('[data-bm]').forEach(x => x.onclick = () => { if (M.spoken?.kind === 'book' && M.spoken.id === b.id) spokenSeek(+x.dataset.bm); else playSpoken({ ...sp, position: +x.dataset.bm }); });
  $$('[data-bmdel]').forEach(x => x.onclick = act(async () => { await api('/audiobooks/bookmarks/' + x.dataset.bmdel, { method: 'DELETE' }); route(); }));
  $('#bmark').onclick = act(async () => {
    const pos = M.spoken?.kind === 'book' && M.spoken.id === b.id ? spokenPos() : b.position;
    const note = await promptDialog(t('Anteckning (valfri)'), { title: t('Bokmärke vid {pos}', { pos: fmtTime(pos) }), maxlength: 200, okLabel: t('Spara bokmärke') }); if (note === null) return;
    await api(`/audiobooks/book/${b.id}/bookmarks`, { method: 'POST', body: { position: pos, note } }); route();
  });
  if ($('#bdone')) $('#bdone').onclick = act(async () => { await api(`/audiobooks/book/${b.id}/progress`, { method: 'POST', body: { position: b.duration } }); route(); });
  if ($('#bundone')) $('#bundone').onclick = act(async () => { await api(`/audiobooks/book/${b.id}/progress`, { method: 'POST', body: { position: 0 } }); toast(t('Markerad som oläst')); route(); });
  if ($('#bfeed')) $('#bfeed').onclick = () => feedDialog({ book: b.id, title: b.title });
  const playing = () => M.spoken?.kind === 'book' && M.spoken.id === b.id ? spokenPos() : null;
  if ($('#bchap')) $('#bchap').onclick = () => chapterEditor(b, { pos: playing, onSaved: () => route() });
  if ($('#bmerge')) $('#bmerge').onclick = act(async () => { if (await mergeBook(b)) route(); });
  if ($('#brestore')) $('#brestore').onclick = act(async () => { if (await restoreBook(b)) route(); });
  // Pågående filåtgärd: fråga servern tills den är klar, rita sedan om vyn
  const poll = () => later(async () => { const x = await api('/audiobooks/book/' + b.id, { bg: true }); if (x.tools?.state?.running) poll(); else route(); }, 3000);
  if (b.tools?.state?.running) poll();
  if ($('#bmatch')) $('#bmatch').onclick = () => matchBook(b);
  if ($('#boff')) $('#boff').onclick = () => downloadBook(b.id);
  if ($('#bedit')) $('#bedit').onclick = () => editBook(b);
};

const SOURCES = { google: 'Google Books', openlibrary: 'Open Library', audnexus: 'Audnexus', audible: 'Audible' };
/** "Fel bok?": sök på titel och författare (eller ett ASIN) och välj rätt träff – matchningen låses */
function matchBook(b) {
  const h = openDialog({ title: t('Välj rätt bok'), size: 'wide',
    body: `<form id="mf" class="row" style="align-items:flex-end"><div style="flex:2;min-width:180px"><label for="mq">${t('Titel eller ASIN')}</label><input id="mq" value="${esc(b.title)}"></div>
    <div style="flex:1;min-width:140px"><label for="ma">${t('Författare')}</label><input id="ma" value="${esc(b.author || '')}"></div><button class="primary">${t('Sök')}</button></form>
    <div id="mres" class="matchgrid" aria-live="polite">${loadingState({ kind: 'inline', label: t('Söker…') })}</div>
    <p class="muted small" id="mlock">${b.meta?.source ? t('Matchad mot {v}{v2}{v3}.', { v: esc(SOURCES[b.meta.source] || b.meta.source), v2: b.meta.matchedTitle ? `: ${esc(b.meta.matchedTitle)}` : '', v3: b.meta.locked ? t(' (låst – ändras inte automatiskt)') : '' }) : ''}</p>`,
    actions: [{ label: t('Lås upp (automatisk matchning)'), id: 'munlock', onClick: async () => {
      await api(`/audiobooks/book/${b.id}/match`, { method: 'POST', body: { unlock: true }, bg: true }); toast(t('Upplåst – matchas automatiskt i bakgrunden')); route();
    } }, { label: t('Stäng') }] });
  const d = h.el;
  $('#munlock', d).hidden = !b.meta?.locked;
  const search = async () => {
    $('#mres', d).innerHTML = loadingState({ kind: 'inline', label: t('Söker…') });
    try {
      const r = await api(`/audiobooks/book/${b.id}/match?title=${encodeURIComponent($('#mq', d).value)}&author=${encodeURIComponent($('#ma', d).value)}`, { bg: true });
      if (!d.isConnected) return;
      $('#munlock', d).hidden = !r.locked;
      const on = (x) => r.current && r.current.source === x.source && r.current.id === x.id;
      $('#mres', d).innerHTML = r.results.map((x, i) => `<button class="mcard${on(x) ? ' on' : ''}" data-mi="${i}">
        ${x.cover ? `<img src="${esc(x.cover)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div><b>${esc(x.title)}</b> ${x.year ? `<span class="muted">(${+x.year})</span>` : ''}${x.subtitle ? `<div class="muted small">${esc(x.subtitle)}</div>` : ''}
        <div class="small">${esc(x.authors.join(', '))}${x.narrators.length ? ` ${t('· uppläst av {v}', { v: esc(x.narrators.join(', ')) })}` : ''}</div>
        <div class="small muted">${esc([SOURCES[x.source], x.publisher, x.series ? `${x.series}${x.seriesNo ? ' #' + x.seriesNo : ''}` : ''].filter(Boolean).join(' · '))}</div>
        <div class="small muted">${esc(x.description)}</div></div></button>`).join('') || emptyState({ compact: true, title: t('Inga träffar'), text: t('Prova en annan stavning, originaltiteln eller bokens ASIN från Audible.') });
      $$('[data-mi]', d).forEach(el => el.onclick = async () => {
        const x = r.results[+el.dataset.mi]; el.disabled = true;
        try { await api(`/audiobooks/book/${b.id}/match`, { method: 'POST', body: { source: x.source, id: x.id }, bg: true }); toast(t('Matchat')); h.close(); route(); }
        catch (e) { toastErr(e); el.disabled = false; }
      });
    } catch (e) { if (d.isConnected) $('#mres', d).innerHTML = errorState(e, { compact: true }); }
  };
  $('#mf', d).onsubmit = (e) => { e.preventDefault(); search(); };
  search();
}
/** Redigera bokens fält för hand – går före filens taggar och metadata från nätet, även efter omskanning */
function editBook(b) {
  const F = [['title', t('Titel')], ['author', t('Författare')], ['narrator', t('Uppläsare')], ['series', t('Serie')], ['seriesNo', t('Nummer i serien')], ['year', t('År')],
    ['publisher', t('Förlag')], ['isbn', 'ISBN'], ['asin', t('ASIN (från Audible – ger kapitel från Audnexus)')], ['genres', t('Genrer (kommaseparerade)')]];
  const val = (k) => String(k === 'genres' ? (b.genres || []).join(', ') : b[k] ?? '');
  openDialog({ title: t('Redigera ljudbok'), form: true,
    body: F.map(([k, l]) => `<label for="be-${k}">${esc(l)}</label><input id="be-${k}" value="${esc(val(k))}"${k === 'year' ? ' inputmode="numeric" maxlength="4"' : ''}${k === 'title' || k === 'author' ? ' required' : ''}>`).join('')
      + `<label for="be-description">${t('Beskrivning')}</label><textarea id="be-description" rows="5">${esc(b.description || '')}</textarea>
      <p class="muted small">${t('Ändrade fält gäller före filens taggar och metadata från nätet, även efter omskanning. Ett tomt fält döljer uppgiften.')}</p>`,
    actions: [{ label: t('Avbryt') }, { label: t('Spara'), kind: 'primary', submit: true, onClick: async ({ $: q }) => {
      const body = {};
      for (const k of [...F.map(x => x[0]), 'description']) { const v = q('#be-' + k).value.trim(); if (v !== val(k).trim()) body[k] = v; }
      if (Object.keys(body).length) await api(`/audiobooks/book/${b.id}`, { method: 'PUT', body, bg: true });
      toast(t('Sparat')); route();
    } }] });
}

// ---------- poddar ----------
const epRows = (eps, showPod) => `<table class="tracks">${eps.map((e, i) => `<tr data-ep="${i}"><td style="width:100%"><b>${esc(e.title)}</b>${e.played ? ' <span class="muted">✓</span>' : ''}
  <div class="muted small">${showPod ? esc(e.podcastTitle || '') + ' · ' : ''}${fmtDate(e.published)}${e.duration ? ' · ' + fmtDur(e.duration) : ''}${e.position > 0 && !e.played ? ` ${t('· {v} kvar', { v: fmtDur((e.duration || 0) - e.position) })}` : ''}${e.downloaded ? t(' · nedladdat') : e.downloading ? t(' · laddas ner…') : ''}</div></td>
  <td class="r" style="white-space:nowrap">${iconButton({ icon: '▶', label: t('Spela {title}', { title: e.title }), data: { epplay: i } })} ${iconButton({ icon: e.played ? '↺' : '✓', label: `${e.played ? t('Markera som ej lyssnad') : t('Markera som lyssnad')}: ${e.title}`, data: { epdone: i } })}</td></tr>`).join('')}</table>`;
function bindEps(eps) {
  const sp = (e) => ({ kind: 'podcast', id: e.id, title: e.title, sub: e.podcastTitle, link: `#/podcast/${e.podcast}`, cover: `/api/podcasts/${e.podcast}/image`,
    duration: e.duration || 0, position: e.played ? 0 : e.position, files: [{ id: e.id, offset: 0, duration: e.duration, url: `/api/podcasts/episodes/${e.id}/stream` }] });
  $$('[data-epplay]').forEach(b => b.onclick = () => playSpoken(sp(eps[+b.dataset.epplay])));
  $$('[data-epdone]').forEach(b => b.onclick = act(async () => { const e = eps[+b.dataset.epdone]; await api(`/podcasts/episodes/${e.id}/progress`, { method: 'POST', body: { position: 0, played: !e.played } }); route(); }));
}
views.podcasts = async () => {
  store.set('pods', '1');
  const D = await api('/podcasts');
  main.innerHTML = `<div class="toolbar"><h1>${t('Poddar')}</h1></div>
    ${D.canAdd ? `<form id="padd" class="row panel" style="align-items:flex-end" role="search"><div style="flex:1;min-width:220px"><label for="purl">${t('Hitta en podd – sök på namnet eller klistra in RSS-adressen')}</label><input id="purl" type="search" style="width:100%" placeholder="${t('t.ex. Sommar i P1 eller https://…/feed.xml')}" autocomplete="off"></div><button class="primary">${t('Sök')}</button></form>
      <div id="pres" aria-live="polite"></div>
      <p class="muted small">${t('De senaste avsnitten laddas ner automatiskt när du prenumererar.')}</p>` : ''}
    ${D.podcasts.length ? `<div class="grid">${D.podcasts.map(p => `<a class="card mcard" href="#/podcast/${p.id}">${podCover(p)}<div class="t">${esc(p.title || '…')}</div><div class="s">${p.unplayed ? `${p.unplayed} nya` : esc(p.author || '')}${p.error ? ' · ⚠' : ''}</div></a>`).join('')}</div>` : emptyState({ icon: '🎙', title: t('Inga poddar ännu'), text: D.canAdd ? t('Sök efter en podd ovan och tryck Prenumerera.') : '' })}
    ${D.latest.length ? `<section class="section"><h2>${t('Senaste avsnitten')}</h2>${epRows(D.latest, true)}</section>` : ''}`;
  bindEps(D.latest);
  const subscribe = async (url, b) => {
    const txt = b.textContent; b.disabled = true; b.textContent = t('Hämtar…');
    try { const r = await api('/podcasts', { method: 'POST', body: { url } }); location.hash = '#/podcast/' + r.id; }
    catch (er) { toastErr(er); b.disabled = false; b.textContent = txt; }
  };
  if ($('#padd')) $('#padd').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#purl').value.trim(), b = $('#padd button');
    if (!q) return;
    // En adress prenumereras direkt, annars söks namnet i Apples poddkatalog (som Audiobookshelf)
    if (/^https?:\/\//i.test(q)) return subscribe(q, b);
    b.disabled = true; $('#pres').innerHTML = loadingState({ kind: 'list' });
    try {
      const res = await api('/podcasts/search?q=' + encodeURIComponent(q));
      const have = new Set(D.podcasts.map(p => p.url));
      $('#pres').innerHTML = res.length ? `<section class="section"><h2>${t('Sökträffar')}</h2><div class="list">${res.map((p, i) => `<div class="row podhit">
        ${p.art ? `<img class="cover small" loading="lazy" src="/api/podcasts/search/art?u=${encodeURIComponent(p.art)}" alt="" width="52" height="52">` : '<div class="cover small" aria-hidden="true">🎙</div>'}
        <div style="flex:1;min-width:0"><div class="t">${esc(p.title)}</div><div class="s muted small">${esc([p.author, p.genre, p.episodes ? t('{episodes} avsnitt', { episodes: p.episodes }) : ''].filter(Boolean).join(' · '))}</div></div>
        ${have.has(p.feed) ? t('<span class="muted small">Prenumererar</span>') : `<button class="ghost" data-psub="${i}">${t('Prenumerera')}</button>`}</div>`).join('')}</div></section>`
        : emptyState({ icon: '🔍', title: t('Inga poddar hittades'), text: t('Prova ett annat namn, eller klistra in RSS-adressen från poddens webbplats.') });
      $$('[data-psub]').forEach(x => x.onclick = () => subscribe(res[+x.dataset.psub].feed, x));
    } catch (er) { if (!er?.aborted) $('#pres').innerHTML = errorState(er); }
    finally { b.disabled = false; }
  };
  loadLibs().catch(() => {});
};
views.podcast = async (id) => {
  const p = await api('/podcasts/' + id);
  const eps = p.episodes.map(e => ({ ...e, podcastTitle: p.title }));
  main.innerHTML = `<div class="mhero">${podCover(p, 'big')}<div><div class="muted small">${t('PODD')}</div><h1>${esc(p.title || '')}</h1>
    <div class="meta"><span>${esc(p.author || '')}</span><span>${t('{episodesN} avsnitt', { episodesN: p.episodes.length })}</span>${/^https?:\/\//i.test(p.link || '') ? `${t('<a href="{link}" target="_blank" rel="noopener noreferrer">Webbplats</a>', { link: esc(p.link) })}` : ''}</div>
    ${p.error ? `<p class="err small">${t('Senaste uppdateringen misslyckades: {error}', { error: esc(p.error) })}</p>` : ''}
    ${p.canEdit ? `<div class="row"><button class="ghost" id="prf">${t('Uppdatera')}</button><label class="small muted">${t('Ladda ner de senaste')} <input id="pkeep" type="number" min="0" max="50" value="${p.keep}" style="width:64px"> ${t('avsnitten')}</label><button class="danger" id="pdel">${t('Avsluta prenumeration')}</button></div>` : ''}
    ${p.description ? `<p class="overview">${esc(p.description)}</p>` : ''}</div></div>
    <section class="section">${epRows(eps, false)}</section>`;
  bindEps(eps);
  if (!p.canEdit) return;
  $('#prf').onclick = async () => { try { await api(`/podcasts/${id}/refresh`, { method: 'POST' }); toast(t('Uppdaterad')); route(); } catch (e) { toastErr(e); } };
  $('#pkeep').onchange = act(async (e) => { await api('/podcasts/' + id, { method: 'PUT', body: { keep: e.target.value } }); toast(t('Sparat')); });
  $('#pdel').onclick = async () => { if (await confirmDialog(t('Avsluta prenumerationen och ta bort nedladdade avsnitt?'), { okLabel: t('Avsluta'), danger: true })) { try { await api('/podcasts/' + id, { method: 'DELETE' }); location.hash = '#/podcasts'; } catch (e) { toastErr(e); } } };
};
