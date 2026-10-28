// Vy: universell sökning (/api/search/all) – grupperna som hyllor och listor i relevansordning, resultat medan man
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
// skriver, piltangenter från sökrutan till träffarna, senaste sökningar (bara i den här webbläsaren) och förslag
// när rutan är tom. Sökrutan i menyraden (#q) kopplas här. Fliken Repliker (#/search/<fråga>?t=lines) söker i
// undertexterna – den delen laddas först när fliken väljs (views/searchlines.js).
import { $, $$, api, dayName, esc, fmtDur, hhmm, libs, main, me, nextRoute, store, views, t, locale } from '../core.js';
import { bookCard, card, ebookCard, chLogo, personArt, personCard, podCover, shelfHtml } from '../ui/cards.js';
import { bindRetry, emptyState, errorState, loadingState } from '../ui/states.js';
import { bindTracks, cover, trackRows } from './music.js';
import { playLive } from '../player/live.js';
import { bindTabs, tabsHtml } from '../ui/tabs.js';
import { need } from '../lazy.js';

const LIMIT = 12, RECENT = 'search.recent', DEBOUNCE = 200;
const box = $('#q');

// ---------- senaste sökningar ----------
export function recentSearches() {
  const r = store.get(RECENT, []);
  return Array.isArray(r) ? r.filter(x => typeof x === 'string' && x.trim()).slice(0, 10) : [];
}
export function rememberSearch(q) {
  q = String(q || '').trim().slice(0, 100);
  if (q.length < 2) return;
  store.set(RECENT, [q, ...recentSearches().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 10));
}

// ---------- grupperna ----------
const LIB_PATH = { music: 'music', audiobook: 'books', ebook: 'ebooks', movie: 'lib', show: 'lib' };
const albumCard = (a) => `<a class="card mcard" href="#/album/${+a.id}">${cover(a.id, a.cover)}<div class="t">${esc(a.title)}</div><div class="s">${esc(a.artist || '')}${a.year ? ' · ' + +a.year : ''}</div></a>`;
const artistCard = (a) => `<a class="card pcard" href="#/artist/${+a.id}">${personArt({ id: a.id, name: a.name, image: false })}<div class="t">${esc(a.name)}</div><div class="s">Artist</div></a>`;
const titles = (n) => `${n} ${n === 1 ? t('titel') : t('titlar')}`;
const list = (rows) => `<div class="slist">${rows.join('')}</div>`;
const GROUPS = {
  movies: { name: t('Filmer'), html: (r) => shelfHtml(t('Filmer'), r.map(i => card(i)).join('')) },
  shows: { name: t('Serier'), html: (r) => shelfHtml(t('Serier'), r.map(i => card(i)).join('')) },
  episodes: { name: t('Avsnitt'), html: (r) => shelfHtml(t('Avsnitt'), r.map(i => card(i, true)).join(''), { land: true }) },
  people: { name: t('Personer'), html: (r) => `<section class="section"><h2>${t('Personer')}</h2><div class="shelf people">${r.map(p => personCard(p, titles(p.titles))).join('')}</div></section>` },
  artists: { name: t('Artister'), html: (r) => `<section class="section"><h2>${t('Artister')}</h2><div class="shelf people">${r.map(artistCard).join('')}</div></section>` },
  albums: { name: 'Album', html: (r) => `<section class="section"><h2>Album</h2><div class="shelf">${r.map(albumCard).join('')}</div></section>` },
  tracks: { name: t('Låtar'), html: (r) => `<section class="section"><h2>${t('Låtar')}</h2><div data-tracks>${trackRows(r, { showCover: true })}</div></section>` },
  books: { name: t('Ljudböcker'), html: (r) => `<section class="section"><h2>${t('Ljudböcker')}</h2><div class="shelf">${r.map(bookCard).join('')}</div></section>` },
  ebooks: { name: t('E-böcker'), html: (r) => `<section class="section"><h2>${t('E-böcker och serietidningar')}</h2><div class="shelf">${r.map(b => ebookCard(b)).join('')}</div></section>` },
  podcasts: { name: t('Poddar'), html: (r) => `<section class="section"><h2>${t('Poddar')}</h2><div class="shelf">${r.map(p => `<a class="card mcard" href="#/podcast/${+p.id}">${podCover(p)}<div class="t">${esc(p.title || '…')}</div><div class="s">${esc(p.author || '')}</div></a>`).join('')}</div></section>` },
  podcastEpisodes: { name: t('Poddavsnitt'), html: (r) => `<section class="section"><h2>${t('Poddavsnitt')}</h2>${list(r.map(e => `<a class="srow" href="#/podcast/${+e.podcast}">
    <b>${esc(e.title || '')}</b><span class="muted small">${esc(e.podcastTitle || '')}${e.published ? ' · ' + new Date(e.published * 1000).toLocaleDateString(locale) : ''}${e.duration ? ' · ' + fmtDur(e.duration) : ''}</span></a>`))}</section>` },
  channels: { name: t('Kanaler'), html: (r) => `<section class="section"><h2>${t('Kanaler')}</h2><div class="row">${r.map((c, i) => `<button type="button" class="srow chrow" data-ch="${i}">${chLogo(c, 'small')}<b>${esc(c.name)}</b></button>`).join('')}</div></section>` },
  programs: { name: t('På TV'), html: (r) => `<section class="section"><h2>${t('På TV')}</h2>${list(r.map(p => `<button type="button" class="srow" data-pid="${+p.id}">
    <b>${esc(p.title)}${p.subtitle ? ' – ' + esc(p.subtitle) : ''}</b><span class="muted small">${esc(dayName(p.start))} ${hhmm(p.start)} · ${esc(p.channel)}</span></button>`))}</section>` }
};

// ---------- tom vy: senaste sökningar och förslag ----------
function emptyView() {
  const recent = recentSearches();
  const places = [...libs.map(l => ({ href: `#/${LIB_PATH[l.type] || 'lib'}/${+l.id}`, label: l.name })),
    ...(me?.liveTv ? [{ href: '#/guide', label: t('TV-guiden') }] : []), ...(!me?.kid ? [{ href: '#/podcasts', label: t('Poddar') }] : [])];
  return `<div class="toolbar"><h1>${t('Sök')}</h1></div>
    ${recent.length ? `<section class="section"><h2>${t('Senaste sökningar')} <button type="button" class="ghost small" data-srclear aria-label="${t('Rensa senaste sökningar')}">${t('Rensa')}</button></h2>
      <div class="row">${recent.map(r => `<a class="btn small" data-snav href="#/search/${encodeURIComponent(r)}">${esc(r)}</a>`).join('')}</div></section>` : ''}
    ${emptyState({ icon: '🔍', title: t('Sök i hela biblioteket'), text: me?.kid ? t('Filmer, serier, personer, musik och ljudböcker. Stavfel gör inget.')
      : t('Filmer, serier, avsnitt, personer, musik, ljudböcker, poddar och TV. Stavfel gör inget – och du kan lägga till året, t.ex. ”matrix 1999”.') })}
    ${places.length ? `<section class="section"><h2>${t('Bläddra i stället')}</h2><div class="row">${places.map(p => `<a class="btn ghost small" data-snav href="${p.href}">${esc(p.label)}</a>`).join('')}</div></section>` : ''}`;
}

// ---------- flikarna: Allt | Repliker ----------
let tab = 'all';
const tabOf = () => /[?&]t=lines(&|$)/.test(location.hash) ? 'lines' : 'all';
const hrefOf = (q) => (q ? '#/search/' + encodeURIComponent(q) : '#/search') + (tab === 'lines' ? '?t=lines' : '');
const tabsBar = () => tabsHtml({ id: 'stabs', label: t('Sök i'), panel: 'sres', current: tab,
  items: [{ key: 'all', label: t('Allt') }, { key: 'lines', label: t('Repliker') }] });
function bindSearchTabs() {
  bindTabs($('#stabs'), (key) => {
    if (key === tab) return;
    tab = key;
    liveSearch(cur, true).then(() => $('#stabs [aria-selected="true"]')?.focus()); // fokus stannar på fliken
  });
}
/** Repliker: träffarna står kvar medan nästa sökning görs; modulen laddas vid första användningen */
async function renderLines(q) {
  if (!$('#sres[data-tab="lines"]')) {
    main.innerHTML = `<div class="toolbar"><h1>${t('Sök: ”{q}”', { q: esc(q) })}</h1><span class="muted" id="sstatus"></span></div>${tabsBar()}
      <div id="sres" role="tabpanel" data-tab="lines">${loadingState({ label: t('Söker i repliker…') })}</div>`;
    bindSearchTabs();
  } else {
    $('.toolbar h1', main).textContent = t('Sök: ”{q}”', { q });
    $('#sstatus').innerHTML = loadingState({ kind: 'inline', label: t('Söker…') });
  }
  main.removeAttribute('aria-busy');
  const m = await need('views/searchlines.js');
  if (cur !== q) return;
  const n = await m.renderLines($('#sres'), q); // kastar (aborted) om en nyare sökning startat
  $('#sstatus').textContent = n ? `${n} ${n === 1 ? t('replik') : t('repliker')}` : '';
}

// ---------- rendering ----------
let cur = '';
async function render(q) {
  cur = q;
  if (q && tab === 'lines') return renderLines(q);
  if (!q) {
    main.innerHTML = emptyView();
    main.removeAttribute('aria-busy');
    const c = $('[data-srclear]', main);
    if (c) c.onclick = () => { store.set(RECENT, []); render(''); box.focus(); };
    return;
  }
  // Vid sökning medan man skriver står de förra träffarna kvar tills de nya kommer (ingen blinkande sida)
  const status = $('#sstatus');
  if (status) status.innerHTML = loadingState({ kind: 'inline', label: t('Söker…') });
  const d = await api(`/search/all?q=${encodeURIComponent(q)}&limit=${LIMIT}`); // avbryts (kastar) om en nyare sökning startat
  const n = d.order.reduce((a, g) => a + d[g].length, 0);
  main.innerHTML = `<div class="toolbar"><h1>${t('Sök: ”{q}”', { q: esc(q) })}</h1><span class="muted" id="sstatus">${n ? `${n} ${n === 1 ? t('träff') : t('träffar')}` : ''}</span></div>
    ${tabsBar()}<div id="sres" role="tabpanel" data-tab="all">${n ? d.order.map(g => GROUPS[g]?.html(d[g]) || '').join('')
      : emptyState({ icon: '🔍', title: t('Inga träffar'), text: t('Prova en annan stavning, en del av titeln, originaltiteln eller ett namn – eller sök efter en replik under Repliker.') })}</div>`;
  main.removeAttribute('aria-busy');
  bindSearchTabs();
  const res = $('#sres');
  if (d.tracks.length) bindTracks(d.tracks, $('[data-tracks]', res));
  $$('[data-ch]', res).forEach(b => b.onclick = () => playLive(d.channels[+b.dataset.ch]));
  $$('[data-pid]', res).forEach(b => b.onclick = async () => (await import('./live.js')).programDialog(+b.dataset.pid)); // live.js laddas vid behov (@lazy)
}
const showError = (e, q) => {
  if (e?.aborted) return;
  main.removeAttribute('aria-busy');
  main.innerHTML = errorState(e, { retry: true });
  bindRetry(main, () => liveSearch(q));
};

views.search = async (q) => {
  tab = tabOf();
  try { q = decodeURIComponent(q || ''); } catch { q = q || ''; }
  if (box.value.trim() !== q && document.activeElement !== box) box.value = q;
  await render(q.trim());
};
/**
 * Ny fråga på söksidan utan ny sidvisning: adressen byts med replaceState (ingen ny post i historiken – Bakåt går till
 * sidan före sökningen) och en ny navigeringsgeneration gör att svaret på den förra frågan kastas (api() avbryter).
 */
export function liveSearch(q, redraw = false) {
  history.replaceState(history.state, '', hrefOf(q));
  nextRoute();
  if (redraw) main.innerHTML = loadingState({ label: t('Söker…') }); // fliken byttes: inga kvarstående träffar från den andra fliken
  return render(q).catch(e => showError(e, q));
}

// ---------- sökrutan ----------
const onSearchPage = () => /^#\/search(\/|$)/.test(location.hash);
let timer = 0, pending = null;
function go() {
  clearTimeout(timer); timer = 0;
  const q = box.value.trim();
  if (onSearchPage()) { if (q !== cur) pending = liveSearch(q); return pending; }
  if (q) location.hash = hrefOf(q);
  return null;
}
box.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(go, DEBOUNCE); });
// Fokusbara träffar i dokumentordning (kort, rader, knappar)
const NAV = '.clink, a.card, .srow, tr[data-ti], [data-snav]';
const navItems = () => $$(NAV, main).filter(el => el.offsetParent !== null);
box.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') { e.preventDefault(); rememberSearch(box.value); go(); }
  else if (e.key === 'ArrowDown' && onSearchPage()) {
    e.preventDefault();
    if (timer) await go(); // svaret på det man just skrev först
    const first = navItems()[0];
    if (first) { first.focus(); first.scrollIntoView({ block: 'nearest' }); }
  }
});
// Senaste sökningar: det man öppnar från träfflistan sparas
main.addEventListener('click', (e) => { if (cur && e.target.closest?.('#sres') && e.target.closest(NAV + ', button')) rememberSearch(cur); });

// Piltangenter mellan träffarna (alla sorters träffar, geometriskt). Upp från översta raden går tillbaka till rutan.
main.addEventListener('keydown', (e) => {
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!d || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !onSearchPage()) return;
  const from = e.target.closest?.(NAV);
  if (!from || !main.contains(from) || from.matches('input, select, textarea')) return;
  const r = from.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bd = Infinity;
  for (const el of navItems()) {
    if (el === from || el.contains(from) || from.contains(el)) continue;
    const q = el.getBoundingClientRect(), ox = q.left + q.width / 2 - cx, oy = q.top + q.height / 2 - cy;
    if (d[0] && (ox * d[0] <= r.width / 4 || q.bottom <= r.top + 4 || q.top >= r.bottom - 4)) continue;
    if (d[1] && oy * d[1] <= r.height / 4) continue;
    const dist = d[0] ? Math.abs(ox) + Math.abs(oy) * 4 : Math.abs(oy) * 4 + Math.abs(ox);
    if (dist < bd) { bd = dist; best = el; }
  }
  if (!best && e.key === 'ArrowUp') best = box;
  if (!best) return;
  e.preventDefault(); e.stopPropagation(); // (ui/shelves.js lyssnar på dokumentet)
  best.focus({ preventScroll: true });
  if (best !== box) (best.closest('.card') || best).scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
// Escape i rutan: töm och visa förslagen
box.addEventListener('search', () => { if (!box.value && onSearchPage()) go(); });
// Modulen laddas när rutan får fokus (router.js): det som hann skrivas innan dess söks nu
if (box.value.trim() && !onSearchPage()) timer = setTimeout(go, DEBOUNCE);
