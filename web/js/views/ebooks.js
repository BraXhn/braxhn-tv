// Vyer: e-böcker och serietidningar – biblioteket (alla böcker eller per serie) och bokens sida. Läsaren: views/reader.js.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, libs, main, store, t, tn, toast, views } from '../core.js';
import { route } from '../router.js';
import { ebookCard, ebookCover, ebookFormat, shelfHtml } from '../ui/cards.js';
import { iconButton } from '../ui/buttons.js';
import { confirmDialog } from '../ui/dialog.js';
import { emptyState, noLib } from '../ui/states.js';

const SORTS = [['title', t('Titel')], ['author', t('Författare')], ['series', t('Bokserie')], ['added', t('Senast tillagda')], ['recent', t('Senast lästa')]];
const no = (n) => n == null ? '' : `#${+n}`;
// Serien i adressen: #/ebooks/<bibliotek>/serie:<namn> (kodat med encodeURIComponent)
const seriesHash = (lid, name) => `#/ebooks/${+lid}/${encodeURIComponent('serie:' + name)}`;
const count = (n) => tn(n, '{n} bok', '{n} böcker');

const seriesCard = (lid, s) => `<a class="card mcard ecard" href="${seriesHash(lid, s.name)}" aria-label="${esc(`${s.name}, ${count(s.count)}`)}">
  ${ebookCover({ id: s.cover || 's' + s.name, cover: !!s.cover, title: s.name })}<div class="t">${esc(s.name)}</div>
  <div class="s">${esc(count(s.count))}${s.read ? ` · ${esc(t('{n} lästa', { n: s.read }))}` : ''}</div></a>`;

views.ebooks = async (lid, filter) => {
  // Utan bibliotek-id: första e-boksbiblioteket, annars en hänvisning
  if (!lid) { const l = libs.find(x => x.type === 'ebook'); if (!l) return noLib(t('e-böcker'), t('E-böcker och serietidningar')); location.hash = `#/ebooks/${l.id}`; return; }
  let series = null;
  try { const x = /^serie:(.+)$/s.exec(decodeURIComponent(filter || '')); if (x) series = x[1]; } catch {}
  const sort = store.get('ebsort', 'title'), group = series == null ? store.get('ebgroup', 'books') : 'books';
  const D = await api(`/ebooks/lib/${+lid}?sort=${encodeURIComponent(sort)}${series != null ? '&series=' + encodeURIComponent(series) : ''}`);
  if (series != null) {
    main.innerHTML = `<div class="toolbar"><a class="ghost" href="#/ebooks/${+lid}">← ${esc(D.library.name)}</a><h1>${esc(series)}</h1>
      <span class="muted">${t('Bokserie')} · ${esc(count(D.books.length))}</span></div>
      ${D.books.length ? `<div class="grid">${D.books.map(b => ebookCard(b, [no(b.seriesNo), b.finished ? '✓' : b.percent ? Math.round(b.percent) + ' %' : ''].filter(Boolean).join(' · '))).join('')}</div>`
        : emptyState({ icon: '📚', title: t('Inga böcker i serien') })}`;
    return;
  }
  const body = !D.books.length ? emptyState({ icon: '📚', title: t('Inga e-böcker ännu'),
    html: t('Lägg EPUB-, PDF- och CBZ-filer i bibliotekets mapp, t.ex. <code>Författare/Titel.epub</code> eller <code>Serie/Serie 001.cbz</code>.') })
    : group === 'series' ? `<div class="grid">${D.series.map(s => seriesCard(lid, s)).join('')}${D.books.filter(b => !b.series).map(b => ebookCard(b)).join('')}</div>`
    : `<div class="grid">${D.books.map(b => ebookCard(b)).join('')}</div>`;
  main.innerHTML = `<div class="toolbar"><h1>${esc(D.library.name)}</h1><span class="muted">${esc(count(D.books.length))}</span>
    <div class="row" style="margin-left:auto"><label class="sr-only" for="ebgroup">${t('Visa')}</label><select id="ebgroup">
      <option value="books" ${group === 'books' ? 'selected' : ''}>${t('Alla böcker')}</option><option value="series" ${group === 'series' ? 'selected' : ''}>${t('Per serie')}</option></select>
    <label class="sr-only" for="ebsort">${t('Sortera')}</label><select id="ebsort">${SORTS.map(([v, n]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div>
    ${D.continue.length ? shelfHtml(t('Fortsätt läsa'), D.continue.map(b => ebookCard(b)).join(''), { row: 'reading' }) : ''}
    ${body}`;
  $('#ebsort').onchange = (e) => { store.set('ebsort', e.target.value); route(); };
  $('#ebgroup').onchange = (e) => { store.set('ebgroup', e.target.value); route(); };
};

/** Positionens text för ett bokmärke/en markering ("Kapitel 3", "Sida 12") */
export function markWhere(b, m) {
  const l = m.locator || {};
  if (b.format === 'cbz') return t('Sida {n}', { n: (+l.page || 0) + 1 });
  const href = b.spine[+l.ch]?.href;
  const tc = b.toc.find(x => x.href === href);
  return tc ? tc.title : t('Kapitel {n}', { n: (+l.ch || 0) + 1 });
}

views.ebook = async (id) => {
  const b = await api(`/ebooks/${+id}`);
  const lid = b.library;
  const pc = Math.round(b.percent || 0);
  const isPdf = b.format === 'pdf';
  const read = isPdf ? `<a class="btn primary" id="ebread" href="/api/ebooks/${+b.id}/pdf" target="_blank" rel="noopener">${t('Öppna PDF:en')}</a>`
    : `<a class="btn primary" id="ebread" href="#/read/${+b.id}">${pc > 0 && !b.finished ? t('▶ Fortsätt läsa ({pc} %)', { pc }) : t('▶ Läs')}</a>`;
  const facts = [ebookFormat(b), b.pages ? tn(b.pages, '{n} sida', '{n} sidor') : '', b.publisher, b.language, b.isbn ? `ISBN ${b.isbn}` : '', b.manga ? (b.rtl ? t('Manga (höger till vänster)') : 'Manga') : ''].filter(Boolean);
  const toc = b.format === 'epub' && b.toc.length ? `<section class="section"><h2>${t('Innehåll')}</h2><ol class="ebtoc">${b.toc.slice(0, 300).map((c, i) => {
    const ch = b.spine.findIndex(s => s.href === c.href);
    return `<li style="--lvl:${Math.min(4, +c.level || 0)}">${ch >= 0 ? `<a href="#/read/${+b.id}?ch=${ch}${c.frag ? '&frag=' + encodeURIComponent(c.frag) : ''}">${esc(c.title)}</a>` : esc(c.title)}</li>`;
  }).join('')}</ol></section>` : '';
  const marks = b.marks.length ? `<section class="section"><h2>${t('Bokmärken och markeringar')}</h2><ul class="ebmarks">${b.marks.map(m => `<li>
    <a href="#/read/${+b.id}?mark=${+m.id}">${m.kind === 'highlight' ? `<mark class="ebhl" data-c="${esc(m.color || 'yellow')}">${esc(m.text || '')}</mark>` : `🔖 ${esc(m.text || markWhere(b, m))}`}</a>
    <span class="muted small">${esc(markWhere(b, m))} · ${esc(fmtDate(m.created))}</span>${m.note ? `<div class="small">${esc(m.note)}</div>` : ''}
    ${iconButton({ icon: '✕', label: m.kind === 'highlight' ? t('Ta bort markeringen') : t('Ta bort bokmärket'), data: { mdel: m.id } })}</li>`).join('')}</ul></section>` : '';
  main.innerHTML = `<div class="mhero">${ebookCover(b, 'big')}<div><div class="muted small">${b.format === 'cbz' ? t('SERIETIDNING') : t('E-BOK')}</div><h1>${esc(b.title)}</h1>
    <div class="meta">${b.author ? `<span>${esc(b.author)}</span>` : ''}${b.year ? `<span>${+b.year}</span>` : ''}${pc > 0 && !b.finished ? `<span>${t('{pc} % läst', { pc })}</span>` : ''}${b.finished ? `<span>${t('✓ Utläst')}</span>` : ''}</div>
    ${b.series ? `<div class="meta"><span>${t('Serie: <a href="{v}">{v2}</a>', { v: seriesHash(lid, b.series), v2: esc(`${b.series} ${no(b.seriesNo)}`.trim()) })}</span></div>` : ''}
    <div class="row">${read}${pc > 0 || b.finished ? `<button type="button" class="ghost" id="ebstart">${t('Börja om')}</button>` : ''}
      <button type="button" class="ghost" id="ebdone">${b.finished ? t('Markera som oläst') : t('Markera som utläst')}</button>
      ${b.canDownload ? `<a class="btn ghost" href="/api/ebooks/${+b.id}/file" download>${t('⤓ Ladda ner')}</a>` : ''}</div>
    ${isPdf ? `<p class="muted small">${t('PDF:er visas i webbläsarens egen läsare i en ny flik. Läspositionen sparas inte för PDF.')}</p>` : ''}
    ${b.description ? `<p class="overview">${esc(b.description)}</p>` : ''}
    ${facts.length ? `<p class="muted small">${esc(facts.join(' · '))}</p>` : ''}
    ${b.genres.length ? `<p class="muted small">${esc(b.genres.join(', '))}</p>` : ''}</div></div>
    ${marks}${toc}
    ${b.sameSeries.length ? shelfHtml(t('Fler i serien {series}', { series: b.series }), b.sameSeries.map(x => ebookCard(x, [no(x.seriesNo), x.finished ? '✓' : ''].filter(Boolean).join(' · '))).join(''),
      { more: t('<a href="{v}">Visa serien</a>', { v: seriesHash(lid, b.series) }) }) : ''}`;
  if ($('#ebstart')) $('#ebstart').onclick = act(async () => {
    await api(`/ebooks/${+b.id}/progress`, { method: 'DELETE' });
    location.hash = isPdf ? `#/ebook/${+b.id}` : `#/read/${+b.id}`;
    if (isPdf) route();
  });
  $('#ebdone').onclick = act(async () => {
    if (b.finished) await api(`/ebooks/${+b.id}/progress`, { method: 'DELETE' });
    else await api(`/ebooks/${+b.id}/progress`, { method: 'POST', body: { percent: 100, finished: true } });
    toast(b.finished ? t('Markerad som oläst') : t('Markerad som utläst'));
    route();
  });
  $$('[data-mdel]').forEach(x => x.onclick = act(async () => {
    if (!await confirmDialog(t('Ta bort?'), { okLabel: t('Ta bort'), danger: true })) return;
    await api(`/ebooks/marks/${+x.dataset.mdel}`, { method: 'DELETE' }); route();
  }));
  // PDF: att öppna den räknas som påbörjad (sidan i webbläsarens läsare kan inte följas)
  if (isPdf && !pc && !b.finished) $('#ebread').addEventListener('click', () => { api(`/ebooks/${+b.id}/progress`, { method: 'POST', body: { percent: 1 }, bg: true }).catch(() => {}); });
};
