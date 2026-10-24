// Vyer: startsidan, bibliotek, Min lista och samlingar (sökningen: views/search.js)
import { $, act, api, esc, heroUrl, later, libs, main, me, store, views } from '../core.js';
import { startPlay } from '../player/video.js';
import { route } from '../router.js';
import { card, colCard, seasonCard, shelf, shelfHtml } from '../ui/cards.js';
import { emptyState } from '../ui/states.js';
import { upcomingCard } from './calendar.js';

views.home = async () => {
  const [d, cols, own] = await Promise.all([api('/home'), api('/collections').catch(() => []), api('/custom-collections').catch(() => [])]);
  let html = '';
  if (!libs.length) {
    html = emptyState({ icon: '🎬', title: 'Inga bibliotek ännu', text: me.is_admin ? 'Lägg till en mapp med filmer eller serier för att komma igång.' : 'Be administratören att lägga till bibliotek.',
      action: me.is_admin ? { label: 'Lägg till bibliotek', href: '#/admin' } : null });
  }
  // Som Plex: en vågrät rad per hylla med stående affischer. Seriebibliotek visar nya avsnitt per säsong.
  if (d.forYou?.length) html += shelfHtml('Nytt för dig', d.forYou.map(i => card(i)).join(''), { row: 'foryou',
    extra: `<span class="fycount">${d.forYou.length}</span> <a href="#" id="fyclear">Markera som sedda</a>` });
  if (d.continue.length) html += shelfHtml('Fortsätt titta', d.continue.map(i => card(i)).join(''), { row: 'continue' });
  html += shelf('Min lista', d.watchlist, false, '<a href="#/watchlist">Visa alla</a>', 'watchlist');
  // Kommer snart: avsnitt de närmaste sju dagarna (fältet upcoming)
  if (d.upcoming?.length) html += shelfHtml('Kommer snart', d.upcoming.map(upcomingCard).join(''), { more: '<a href="#/calendar">Visa kalendern</a>' });
  html += shelf('Rekommenderat för dig', d.recommended);
  // Egna samlingar med "Visa på startsidan" (ordningen följer samlingens sortering)
  for (const c of d.customCollections || []) html += shelfHtml(c.name, c.items.map(i => card(i)).join(''), { more: `<a href="#/ucollection/${+c.id}">Visa alla</a>` });
  for (const r of d.rows) {
    const more = `<a href="#/lib/${+r.library.id}">Visa alla</a>`;
    if (r.seasons?.length) html += shelfHtml(`Nyligen tillagda i ${r.library.name}`, r.seasons.map(seasonCard).join(''), { more });
    else if (r.items.length) html += shelfHtml(`Nyligen tillagda i ${r.library.name}`, r.items.map(i => card(i)).join(''), { more });
  }
  // Egna samlingar först, sedan TMDB:s filmserier
  if (cols.length || own.length) html += shelfHtml('Samlingar', [...own, ...cols].map(colCard).join(''), { more: '<a href="#/collections">Visa alla</a>' });
  if (libs.length && !d.rows.some(r => r.items.length)) {
    const s = await api('/scan');
    html += emptyState({ icon: s.running ? '⏳' : '🔍', title: s.running ? 'Skannar bibliotek…' : 'Inget innehåll hittades', text: s.running ? `${s.phase} ${s.done}/${s.total}` : 'Kontrollera sökvägarna under Administration.' });
    if (s.running) later(route, 3000);
  }
  main.innerHTML = html;
  if ($('#fyclear')) $('#fyclear').onclick = act(async (e) => { e.preventDefault(); await api('/foryou/seen', { method: 'POST', body: {} }); route(); });
};

const FIRST = 60, CHUNK = 240;
const libCard = (i) => i.kind === 'collection' ? colCard(i) : card(i);
views.lib = async (id) => {
  const sort = store.get('sort.' + id, 'title'), filter = store.get('filter.' + id, ''), cols = store.get('cols.' + id, '1');
  const [d, own] = await Promise.all([api(`/libraries/${id}/items?sort=${sort}&filter=${filter}&collections=${cols}`),
    api(`/custom-collections?library=${encodeURIComponent(id)}`).catch(e => { if (e?.aborted) throw e; return []; })]);
  const movies = d.library.type === 'movie';
  main.innerHTML = `<div class="toolbar"><h1>${esc(d.library.name)}</h1><span class="muted">${d.items.length} titlar</span>
    ${movies ? `<select id="cols" title="Visa filmer i samma samling som ett kort"><option value="1">Samlingar</option><option value="0">Alla filmer</option></select>` : ''}
    <select id="flt"><option value="">Alla</option><option value="unwatched">Osedda</option><option value="watched">Sedda</option></select>
    <select id="srt"><option value="title">Titel</option><option value="added">Senast tillagda</option><option value="year">År</option><option value="rating">Betyg</option></select></div>
    ${own.length ? shelfHtml('Egna samlingar', own.map(colCard).join(''), { more: '<a href="#/collections">Alla samlingar</a>' }) : ''}
    ${d.items.length ? `<div class="grid" id="libgrid">${d.items.slice(0, FIRST).map(libCard).join('')}</div>`
      : emptyState({ title: filter ? 'Inget som matchar filtret' : 'Inget här ännu', text: filter ? 'Välj Alla för att se hela biblioteket.' : 'Titlarna dyker upp här när biblioteket har skannats.' })}`;
  // Stora bibliotek: de första korten direkt, resten i omgångar efter att sidan visats (tusentals kort på en gång
  // låser webbläsaren en stund, särskilt på TV och telefon)
  const more = (from) => {
    const g = $('#libgrid');
    if (!g || from >= d.items.length) return;
    g.insertAdjacentHTML('beforeend', d.items.slice(from, from + CHUNK).map(libCard).join(''));
    later(() => more(from + CHUNK), 30);
  };
  later(() => more(FIRST), 30);
  $('#srt').value = sort; $('#flt').value = filter;
  if ($('#cols')) { $('#cols').value = cols; $('#cols').onchange = (e) => { store.set('cols.' + id, e.target.value); route(); }; }
  $('#srt').onchange = (e) => { store.set('sort.' + id, e.target.value); route(); };
  $('#flt').onchange = (e) => { store.set('filter.' + id, e.target.value); route(); };
};

views.watchlist = async () => {
  const items = await api('/watchlist');
  main.innerHTML = `<div class="toolbar"><h1>Min lista</h1><span class="muted">${items.length} titlar</span></div>
    ${items.length ? `<div class="grid" data-row="watchlist">${items.map(i => card(i)).join('')}</div>` : emptyState({ icon: '🔖', title: 'Min lista är tom', text: 'Lägg till filmer och serier med ”+ Min lista” eller med ⋮ på ett kort.' })}`;
};
views.collection = async (id) => {
  const c = await api('/collections/' + id);
  main.innerHTML = `<div class="hero">${c.backdrop ? `<div class="bd" style="background-image:url(${heroUrl(`/api/collection-image/${+c.id}/backdrop`)})"></div>` : ''}
    <div class="in"><div><h1>${esc(c.name)}</h1><div class="meta"><span>${c.items.length} filmer</span></div>${c.overview ? `<p class="overview">${esc(c.overview)}</p>` : ''}
    ${c.items.find(i => !i.watched) ? `<button class="primary" id="playfirst">▶ Spela ${esc(c.items.find(i => !i.watched).title)}</button>` : ''}</div></div></div>
    <div class="grid" style="margin-top:20px">${c.items.map(i => card(i)).join('')}</div>`;
  const first = c.items.find(i => !i.watched);
  if (first) $('#playfirst').onclick = (e) => startPlay(e.currentTarget, first.id, first.position || 0);
};
