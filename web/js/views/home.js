// Vyer: startsidan, bibliotek, Min lista och samlingar (sökningen: views/search.js).
// Startsidans Utvalt-karusell: ui/featured.js, "Anpassa startsidan": views/homecustom.js.
import { $, act, api, cardW, esc, fmtDur, heroUrl, imgSrc, later, libs, main, me, store, views } from '../core.js';
import { playSpoken } from '../audio.js';
import { startPlay } from '../player/video.js';
import { route } from '../router.js';
import { card, colCard, seasonCard, shelf, shelfHtml } from '../ui/cards.js';
import { bindFeatured, featuredHtml } from '../ui/featured.js';
import { emptyState } from '../ui/states.js';
import { bookCard, podCover } from './books.js';
import { upcomingCard } from './calendar.js';
import { openHomeCustomizer } from './homecustom.js';

// Startsidans hyllor i den ordning användaren valt (homeLayout från servern, "Anpassa startsidan"). Hyllor som
// servern inte känner till ritas inte; en äldre server utan homeLayout ger standardordningen nedan.
const DEFAULT_ORDER = ['foryou', 'continue', 'listening', 'watchlist', 'upcoming', 'because', 'recommended', 'custom', 'recent',
  'short', 'toprated', 'onthisday', 'genre', 'gems', 'collections'];
const cards = (list) => list.map(i => card(i)).join('');
/** Kort i "Fortsätt lyssna": ljudböcker öppnar boken, poddavsnitt fortsätter spelas direkt */
const listenCard = (x, i) => x.type === 'podcast'
  ? `<a class="card mcard" href="#/podcast/${+x.podcast}" data-lpod="${i}" aria-label="${esc(`Fortsätt lyssna: ${x.title}, ${x.podcastTitle || ''}`)}">${podCover({ id: x.podcast, image: x.image })}${x.duration && x.position ? `<div class="prog"><i style="width:${Math.min(100, x.position / x.duration * 100)}%"></i></div>` : ''}
    <div class="t">${esc(x.title || '')}</div><div class="s">${esc(x.podcastTitle || '')}${x.duration ? ` · ${esc(fmtDur(Math.max(0, x.duration - x.position)))} kvar` : ''}</div></a>`
  : bookCard(x);

views.home = async () => {
  const [d, cols, own] = await Promise.all([api('/home'), api('/collections').catch(() => []), api('/custom-collections').catch(() => [])]);
  const L = d.homeLayout || { order: DEFAULT_ORDER, hidden: [], hero: 'auto' };
  const off = new Set(L.hidden || []);
  // Installationsguiden är inte klar (bara administratörer på hemnätet, fältet setupPending i /api/status)
  let html = me.setupPending ? `<div class="setup-banner" role="region" aria-label="Installation"><div><b>Slutför installationen</b>
    <p class="muted small">Några steg kvar: metadata, bibliotek, omkodning, åtkomst utanför hemmet och hushållet.</p></div>
    <a class="btn primary" href="#/setup">Fortsätt guiden</a></div>` : '';
  if (!libs.length) {
    html += emptyState({ icon: '🎬', title: 'Inga bibliotek ännu', text: me.is_admin ? 'Lägg till en mapp med filmer eller serier för att komma igång.' : 'Be administratören att lägga till bibliotek.',
      action: me.is_admin ? { label: 'Lägg till bibliotek', href: me.setupPending ? '#/setup/libraries' : '#/admin' } : null });
  }
  // Utvalt överst: standard på bred skärm, valbart under "Anpassa startsidan"
  const hero = d.featured?.length && (L.hero === 'on' || (L.hero !== 'off' && matchMedia('(min-width: 900px)').matches));
  if (hero) html += featuredHtml(d.featured);
  // Som Plex: en vågrät rad per hylla med stående affischer. Seriebibliotek visar nya avsnitt per säsong.
  const part = {
    foryou: () => d.forYou?.length ? shelfHtml('Nytt för dig', cards(d.forYou), { row: 'foryou',
      extra: `<span class="fycount">${d.forYou.length}</span> <a href="#" id="fyclear">Markera som sedda</a>` }) : '',
    continue: () => d.continue.length ? shelfHtml('Fortsätt titta', cards(d.continue), { row: 'continue' }) : '',
    listening: () => d.listening?.length ? shelfHtml('Fortsätt lyssna', d.listening.map(listenCard).join(''), { row: 'listening' }) : '',
    watchlist: () => shelf('Min lista', d.watchlist, false, '<a href="#/watchlist">Visa alla</a>', 'watchlist'),
    // Kommer snart: avsnitt de närmaste sju dagarna (fältet upcoming)
    upcoming: () => d.upcoming?.length ? shelfHtml('Kommer snart', d.upcoming.map(upcomingCard).join(''), { more: '<a href="#/calendar">Visa kalendern</a>' }) : '',
    because: () => (d.because || []).map(b => b.items.length ? shelfHtml(`Eftersom du såg ${b.seed.title}`, cards(b.items)) : '').join(''),
    recommended: () => shelf('Rekommenderat för dig', d.recommended),
    // Egna samlingar med "Visa på startsidan" (ordningen följer samlingens sortering)
    custom: () => (d.customCollections || []).map(c => shelfHtml(c.name, cards(c.items), { more: `<a href="#/ucollection/${+c.id}">Visa alla</a>` })).join(''),
    recent: () => d.rows.map(r => {
      const more = `<a href="#/lib/${+r.library.id}">Visa alla</a>`;
      if (r.seasons?.length) return shelfHtml(`Nyligen tillagda i ${r.library.name}`, r.seasons.map(seasonCard).join(''), { more });
      return r.items.length ? shelfHtml(`Nyligen tillagda i ${r.library.name}`, cards(r.items), { more }) : '';
    }).join(''),
    short: () => d.shortTonight?.length >= 4 ? shelfHtml('Kort film ikväll', cards(d.shortTonight), { extra: '<span class="muted small">under 95 minuter</span>' }) : '',
    toprated: () => d.topRated?.length >= 4 ? shelfHtml('Topprankat i biblioteket', cards(d.topRated)) : '',
    // Den här dagen: anteckningen (premiär/sedd för N år sedan) ersätter årtalet under titeln
    onthisday: () => d.onThisDay?.length ? shelfHtml('Den här dagen', d.onThisDay.map(i => card({ ...i, note: i.onThisDay?.note })).join('')) : '',
    genre: () => d.genreOfDay?.items?.length ? shelfHtml(`Dagens genre: ${d.genreOfDay.genre}`, cards(d.genreOfDay.items)) : '',
    gems: () => d.hiddenGems?.length >= 4 ? shelfHtml('Glömda guldkorn', cards(d.hiddenGems), { extra: '<span class="muted small">högt betyg, aldrig sedda</span>' }) : '',
    // Egna samlingar först, sedan TMDB:s filmserier
    collections: () => cols.length || own.length ? shelfHtml('Samlingar', [...own, ...cols].map(colCard).join(''), { more: '<a href="#/collections">Visa alla</a>' }) : ''
  };
  for (const id of L.order || DEFAULT_ORDER) if (!off.has(id) && part[id]) html += part[id]();
  if (libs.length && !d.rows.some(r => r.items.length)) {
    const s = await api('/scan');
    html += emptyState({ icon: s.running ? '⏳' : '🔍', title: s.running ? 'Skannar bibliotek…' : 'Inget innehåll hittades', text: s.running ? `${s.phase} ${s.done}/${s.total}` : 'Kontrollera sökvägarna under Administration.' });
    if (s.running) later(route, 3000);
  }
  if (libs.length) html += `<div class="homefoot"><button type="button" class="ghost" id="homecustom">Anpassa startsidan</button></div>`;
  main.innerHTML = html;
  if (hero) bindFeatured(main.querySelector('.feat'), d.featured);
  if ($('#fyclear')) $('#fyclear').onclick = act(async (e) => { e.preventDefault(); await api('/foryou/seen', { method: 'POST', body: {} }); route(); });
  if ($('#homecustom')) $('#homecustom').onclick = () => openHomeCustomizer({ onChange: route });
  main.querySelectorAll('[data-lpod]').forEach(a => a.onclick = (e) => {
    const x = d.listening[+a.dataset.lpod];
    e.preventDefault();
    playSpoken({ kind: 'podcast', id: x.id, title: x.title, sub: x.podcastTitle, link: `#/podcast/${x.podcast}`, cover: `/api/podcasts/${x.podcast}/image`,
      duration: x.duration || 0, position: x.position || 0, files: [{ id: x.id, offset: 0, duration: x.duration, url: `/api/podcasts/episodes/${x.id}/stream` }] });
  });
};

const FIRST = 60, CHUNK = 240;
const libCard = (i) => i.kind === 'collection' ? colCard(i) : card(i);
views.lib = async (id, folder) => {
  // Hemvideor: mappar som navigering, liggande kort och datum (fälten home_video/folders från servern)
  if (libs.find(l => l.id === +id)?.home_video) return homeVideos(id, folder);
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

// ---------- Hemvideor ----------
const yearSpan = (f) => {
  const a = f.first ? new Date(f.first * 1000).getFullYear() : null, b = f.latest ? new Date(f.latest * 1000).getFullYear() : null;
  return a && b && a !== b ? `${a}–${b}` : String(a || b || '');
};
/** En undermapp som kort: en av klippens miniatyrer, antal klipp och år */
function folderCard(libId, f) {
  const sub = [`${f.count} klipp`, yearSpan(f)].filter(Boolean).join(' · ');
  return `<a class="card land fcard" href="#/lib/${+libId}/${encodeURIComponent(f.path)}" aria-label="${esc(`Mappen ${f.name}, ${sub}`)}"><div class="art">
    <div class="ph fph" aria-hidden="true"><span class="ficon">📁</span></div>
    ${f.cover ? `<img loading="lazy" decoding="async" ${imgSrc(`/api/image/${+f.cover}/thumb`, cardW() * 1.9)} alt="" width="480" height="270" data-fb="1">` : ''}
    <span class="badge">${+f.count}</span></div><div class="t">📁 ${esc(f.name)}</div><div class="s">${esc(sub)}</div></a>`;
}
async function homeVideos(id, folderArg) {
  let folder = '';
  try { folder = decodeURIComponent(folderArg || ''); } catch {}
  const sort = store.get('hvsort.' + id, 'date'), filter = store.get('filter.' + id, ''), flat = store.get('hvflat.' + id, '0') === '1';
  const q = `sort=${encodeURIComponent(sort)}&filter=${encodeURIComponent(filter)}` + (flat ? '' : `&folder=${encodeURIComponent(folder)}`);
  const d = await api(`/libraries/${id}/items?${q}`);
  const folders = flat ? [] : d.folders || [];
  // Brödsmulor: biblioteket, sedan mapparna ner till den här
  const parts = flat || !folder ? [] : folder.split('/');
  const crumbs = `<nav class="crumbs" aria-label="Mappar"><a href="#/lib/${+id}">${esc(d.library.name)}</a>${parts.map((p, i) =>
    ` <span aria-hidden="true">›</span> <a href="#/lib/${+id}/${encodeURIComponent(parts.slice(0, i + 1).join('/'))}"${i === parts.length - 1 ? ' aria-current="page"' : ''}>${esc(p)}</a>`).join('')}</nav>`;
  const count = d.items.length + folders.reduce((n, f) => n + f.count, 0);
  main.innerHTML = `<div class="toolbar"><h1>${esc(parts.at(-1) || d.library.name)}</h1><span class="muted">${count} klipp</span>
    <select id="hvflat" title="Visa mapparna eller alla klipp på en gång" aria-label="Visning"><option value="0">Mappar</option><option value="1">Alla klipp</option></select>
    <select id="flt" aria-label="Filter"><option value="">Alla</option><option value="unwatched">Osedda</option><option value="watched">Sedda</option></select>
    <select id="srt" aria-label="Sortering"><option value="date">Datum (nyast först)</option><option value="title">Namn</option><option value="added">Senast tillagda</option></select></div>
    ${parts.length ? crumbs : ''}
    ${folders.length ? `<h2 class="sr-only">Mappar</h2><div class="grid wide" id="hvfolders">${folders.map(f => folderCard(id, f)).join('')}</div>` : ''}
    ${d.items.length ? `${folders.length ? '<h2 class="hvh">Klipp</h2>' : ''}<div class="grid wide" id="libgrid">${d.items.slice(0, FIRST).map(i => card(i, true)).join('')}</div>`
      : folders.length ? '' : emptyState({ icon: '🎞️', title: filter ? 'Inget som matchar filtret' : 'Inga klipp här', text: filter ? 'Välj Alla för att se alla klipp.' : 'Klippen dyker upp här när biblioteket har skannats.' })}`;
  const more = (from) => {
    const g = $('#libgrid');
    if (!g || from >= d.items.length) return;
    g.insertAdjacentHTML('beforeend', d.items.slice(from, from + CHUNK).map(i => card(i, true)).join(''));
    later(() => more(from + CHUNK), 30);
  };
  later(() => more(FIRST), 30);
  $('#srt').value = sort; $('#flt').value = filter; $('#hvflat').value = flat ? '1' : '0';
  $('#srt').onchange = (e) => { store.set('hvsort.' + id, e.target.value); route(); };
  $('#flt').onchange = (e) => { store.set('filter.' + id, e.target.value); route(); };
  $('#hvflat').onchange = (e) => { store.set('hvflat.' + id, e.target.value); if (e.target.value === '1' && folder) location.hash = `#/lib/${+id}`; else route(); };
}

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
