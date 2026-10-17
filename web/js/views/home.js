// Vyer: startsidan, bibliotek, sökning, Min lista och samlingar
import { $, act, api, esc, later, libs, main, me, store, views } from '../core.js';
import { startPlay } from '../player/video.js';
import { route } from '../router.js';
import { card, colCard, personCard, shelf } from '../ui/cards.js';

views.home = async () => {
  const [d, cols] = await Promise.all([api('/home'), api('/collections').catch(() => [])]);
  let html = '';
  if (!libs.length) {
    html = `<div class="empty"><h2>Inga bibliotek ännu</h2><p>${me.is_admin ? 'Lägg till en mapp med filmer eller serier för att komma igång.' : 'Be administratören att lägga till bibliotek.'}</p>
      ${me.is_admin ? '<a class="btn primary" href="#/admin">Lägg till bibliotek</a>' : ''}</div>`;
  }
  if (d.forYou?.length) html += `<section class="section"><h2>Nytt för dig <span class="fycount">${d.forYou.length}</span> <a href="#" id="fyclear">Markera som sedda</a></h2><div class="shelf wide">${d.forYou.map(i => card(i, true)).join('')}</div></section>`;
  if (d.continue.length) html += `<section class="section"><h2>Fortsätt titta</h2><div class="shelf wide">${d.continue.map(i => card(i, true)).join('')}</div></section>`;
  html += shelf('Min lista', d.watchlist, false, '<a href="#/watchlist">Visa alla</a>');
  html += shelf('Rekommenderat för dig', d.recommended);
  if (cols.length) html += `<section class="section"><h2>Samlingar</h2><div class="shelf">${cols.map(colCard).join('')}</div></section>`;
  for (const r of d.rows) if (r.items.length)
    html += `<section class="section"><h2>${esc(r.title)} <a href="#/lib/${r.library.id}">Visa alla</a></h2><div class="shelf">${r.items.map(i => card(i)).join('')}</div></section>`;
  if (libs.length && !d.rows.some(r => r.items.length)) {
    const s = await api('/scan');
    html += `<div class="empty"><h2>${s.running ? 'Skannar bibliotek…' : 'Inget innehåll hittades'}</h2><p>${s.running ? esc(s.phase) + ' ' + s.done + '/' + s.total : 'Kontrollera sökvägarna under Administration.'}</p></div>`;
    if (s.running) later(route, 3000);
  }
  main.innerHTML = html;
  if ($('#fyclear')) $('#fyclear').onclick = act(async (e) => { e.preventDefault(); await api('/foryou/seen', { method: 'POST', body: {} }); route(); });
};

views.lib = async (id) => {
  const sort = store.get('sort.' + id, 'title'), filter = store.get('filter.' + id, ''), cols = store.get('cols.' + id, '1');
  const d = await api(`/libraries/${id}/items?sort=${sort}&filter=${filter}&collections=${cols}`);
  const movies = d.library.type === 'movie';
  main.innerHTML = `<div class="toolbar"><h1>${esc(d.library.name)}</h1><span class="muted">${d.items.length} titlar</span>
    ${movies ? `<select id="cols" title="Visa filmer i samma samling som ett kort"><option value="1">Samlingar</option><option value="0">Alla filmer</option></select>` : ''}
    <select id="flt"><option value="">Alla</option><option value="unwatched">Osedda</option><option value="watched">Sedda</option></select>
    <select id="srt"><option value="title">Titel</option><option value="added">Senast tillagda</option><option value="year">År</option><option value="rating">Betyg</option></select></div>
    <div class="grid">${d.items.map(i => i.kind === 'collection' ? colCard(i) : card(i)).join('') || '<p class="muted">Inget här.</p>'}</div>`;
  $('#srt').value = sort; $('#flt').value = filter;
  if ($('#cols')) { $('#cols').value = cols; $('#cols').onchange = (e) => { store.set('cols.' + id, e.target.value); route(); }; }
  $('#srt').onchange = (e) => { store.set('sort.' + id, e.target.value); route(); };
  $('#flt').onchange = (e) => { store.set('filter.' + id, e.target.value); route(); };
};

views.search = async (q) => {
  q = decodeURIComponent(q || '');
  if ($('#q').value !== q && document.activeElement !== $('#q')) $('#q').value = q;
  const [r, ppl] = q.length >= 1 ? await Promise.all([api('/search?q=' + encodeURIComponent(q)),
    api('/search/people?q=' + encodeURIComponent(q)).catch(e => { if (e?.aborted) throw e; return []; })]) : [[], []];
  const top = r.filter(i => i.kind !== 'episode'), eps = r.filter(i => i.kind === 'episode');
  main.innerHTML = `<div class="toolbar"><h1>Sök: ”${esc(q)}”</h1></div>
    ${top.length ? `<section class="section"><h2>Filmer och serier</h2><div class="grid">${top.map(i => card(i)).join('')}</div></section>` : ''}
    ${ppl.length ? `<section class="section"><h2>Personer</h2><div class="shelf people">${ppl.map(p => personCard(p, `${p.titles} ${p.titles === 1 ? 'titel' : 'titlar'}`)).join('')}</div></section>` : ''}
    ${eps.length ? `<section class="section"><h2>Avsnitt</h2><div class="grid">${eps.map(i => card(i, true)).join('')}</div></section>` : ''}
    ${!r.length && !ppl.length ? '<div class="empty">Inga träffar.</div>' : ''}`;
};

views.watchlist = async () => {
  const items = await api('/watchlist');
  main.innerHTML = `<div class="toolbar"><h1>Min lista</h1><span class="muted">${items.length} titlar</span></div>
    <div class="grid">${items.map(i => card(i)).join('') || '<p class="muted">Lägg till filmer och serier med ”+ Min lista”.</p>'}</div>`;
};
views.collection = async (id) => {
  const c = await api('/collections/' + id);
  main.innerHTML = `<div class="hero">${c.backdrop ? `<div class="bd" style="background-image:url(/api/collection-image/${c.id}/backdrop)"></div>` : ''}
    <div class="in"><div><h1>${esc(c.name)}</h1><div class="meta"><span>${c.items.length} filmer</span></div>${c.overview ? `<p class="overview">${esc(c.overview)}</p>` : ''}
    ${c.items.find(i => !i.watched) ? `<button class="primary" id="playfirst">▶ Spela ${esc(c.items.find(i => !i.watched).title)}</button>` : ''}</div></div></div>
    <div class="grid" style="margin-top:20px">${c.items.map(i => card(i)).join('')}</div>`;
  const first = c.items.find(i => !i.watched);
  if (first) $('#playfirst').onclick = (e) => startPlay(e.currentTarget, first.id, first.position || 0);
};
