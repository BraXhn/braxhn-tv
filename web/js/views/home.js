// Vyer: startsidan, bibliotek (filter och sortering: ui/libfilter.js), Min lista och samlingar (sökningen: views/search.js).
// Startsidans Utvalt-karusell: ui/featured.js, "Anpassa startsidan": views/homecustom.js.
import { $, act, api, cardW, esc, fmtDay, fmtDur, heroUrl, imgSrc, later, libs, main, me, onLeave, safeColor, store, sxe, toast, toastErr, views } from '../core.js';
import { playSpoken } from '../audio.js';
import { startPlay } from '../player/video.js';
import { route } from '../router.js';
import { iconButton } from '../ui/buttons.js';
import { card, colCard, seasonCard, shelf, shelfHtml } from '../ui/cards.js';
import { collectionForm } from '../ui/collections.js';
import { bindFeatured, featuredHtml } from '../ui/featured.js';
import { SORT_DIR, SORT_LABEL, chips, chipsHtml, filterCount, hasFilter, hashQuery, openFilterPanel } from '../ui/libfilter.js';
import { emptyState } from '../ui/states.js';
import { bookCard, podCover } from './books.js';
import { upcomingCard } from './calendar.js';
import { openHomeCustomizer } from './homecustom.js';

// Startsidans hyllor i den ordning användaren valt (homeLayout från servern, "Anpassa startsidan"). Hyllor som
// servern inte känner till ritas inte; en äldre server utan homeLayout ger standardordningen nedan.
const DEFAULT_ORDER = ['foryou', 'continue', 'listening', 'watchlist', 'upcoming', 'because', 'recommended', 'custom', 'recent',
  'short', 'toprated', 'onthisday', 'memories', 'genre', 'gems', 'collections'];
const cards = (list) => list.map(i => card(i)).join('');
/** Kort i "Fortsätt lyssna": ljudböcker öppnar boken, poddavsnitt fortsätter spelas direkt */
const listenCard = (x, i) => x.type === 'podcast'
  ? `<a class="card mcard" href="#/podcast/${+x.podcast}" data-lpod="${i}" aria-label="${esc(`Fortsätt lyssna: ${x.title}, ${x.podcastTitle || ''}`)}">${podCover({ id: x.podcast, image: x.image })}${x.duration && x.position ? `<div class="prog"><i style="width:${Math.min(100, x.position / x.duration * 100)}%"></i></div>` : ''}
    <div class="t">${esc(x.title || '')}</div><div class="s">${esc(x.podcastTitle || '')}${x.duration ? ` · ${esc(fmtDur(Math.max(0, x.duration - x.position)))} kvar` : ''}</div></a>`
  : bookCard(x);
/** Minnen ur fotobiblioteken (photoMemories): ett liggande kort per år med en bild från dagens datum */
const memoryCard = (g) => {
  const t = g.yearsAgo === 1 ? 'För ett år sedan' : `För ${+g.yearsAgo} år sedan`, s = `${+g.count} ${g.count === 1 ? 'foto' : 'foton'} · ${fmtDay(g.day)}`;
  return `<div class="card land phmem"><a class="clink" href="#/photos/${+g.library}/memories" aria-label="${esc(`${t}, ${s}`)}"><div class="art" style="background:${safeColor(g.cover?.c) || 'var(--bg3)'}">`
    + (g.cover ? `<img loading="lazy" decoding="async" ${imgSrc(`/api/photos/${+g.cover.id}/img`, cardW() * 1.9)} alt="" width="480" height="270" data-fb="1">` : '')
    + `</div><div class="t">${esc(t)}</div><div class="s">${esc(s)}</div></a></div>`;
};

// Startsidan visas direkt från förra besöket (sparad per profil i webbläsaren) och byts tyst när servern svarat –
// ingen väntan på servern vid återbesök. Nyckeln är profilens id, så en annan profil aldrig ser någon annans hyllor.
const homeKey = () => 'bxhome1:' + (me?.id || 0);
function cachedHome() { try { return JSON.parse(localStorage.getItem(homeKey()) || 'null'); } catch { return null; } }
function saveHome(o) { try { localStorage.setItem(homeKey(), JSON.stringify(o)); } catch { try { localStorage.removeItem(homeKey()); } catch {} } }
views.home = async () => {
  const fresh = Promise.all([api('/home'), api('/collections').catch(e => { if (e?.aborted) throw e; return []; }), api('/custom-collections').catch(e => { if (e?.aborted) throw e; return []; })]);
  const old = cachedHome();
  if (old?.d) await renderHome(old.d, old.cols || [], old.own || [], true);
  const [d, cols, own] = await fresh;
  const next = { d, cols, own };
  if (old && JSON.stringify(old) === JSON.stringify(next)) return; // oförändrat – sidan står kvar som den är
  saveHome(next);
  await renderHome(d, cols, own, false);
};
async function renderHome(d, cols, own, fromCache) {
  const keep = !fromCache && main.querySelector('.shelf') ? window.scrollY : null; // uppdatering: behåll skrollläget
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
    memories: () => d.photoMemories?.length ? shelfHtml('Den här dagen i dina foton', d.photoMemories.map(memoryCard).join(''), { land: true }) : '',
    genre: () => d.genreOfDay?.items?.length ? shelfHtml(`Dagens genre: ${d.genreOfDay.genre}`, cards(d.genreOfDay.items)) : '',
    gems: () => d.hiddenGems?.length >= 4 ? shelfHtml('Glömda guldkorn', cards(d.hiddenGems), { extra: '<span class="muted small">högt betyg, aldrig sedda</span>' }) : '',
    // Egna samlingar först, sedan TMDB:s filmserier
    collections: () => cols.length || own.length ? shelfHtml('Samlingar', [...own, ...cols].map(colCard).join(''), { more: '<a href="#/collections">Visa alla</a>' }) : ''
  };
  for (const id of L.order || DEFAULT_ORDER) if (!off.has(id) && part[id]) html += part[id]();
  if (libs.some(l => l.type === 'movie' || l.type === 'show') && !d.rows.some(r => r.items.length) && !fromCache) {
    const s = await api('/scan');
    html += emptyState({ icon: s.running ? '⏳' : '🔍', title: s.running ? 'Skannar bibliotek…' : 'Inget innehåll hittades', text: s.running ? `${s.phase} ${s.done}/${s.total}` : 'Kontrollera sökvägarna under Administration.' });
    if (s.running) later(route, 3000);
  }
  if (libs.length) html += `<div class="homefoot"><button type="button" class="ghost" id="homecustom">Anpassa startsidan</button></div>`;
  main.innerHTML = html;
  if (keep != null) window.scrollTo(0, keep);
  if (fromCache) main.removeAttribute('aria-busy');
  if (hero) bindFeatured(main.querySelector('.feat'), d.featured);
  if ($('#fyclear')) $('#fyclear').onclick = act(async (e) => { e.preventDefault(); await api('/foryou/seen', { method: 'POST', body: {} }); route(); });
  if ($('#homecustom')) $('#homecustom').onclick = () => openHomeCustomizer({ onChange: route });
  main.querySelectorAll('[data-lpod]').forEach(a => a.onclick = (e) => {
    const x = d.listening[+a.dataset.lpod];
    e.preventDefault();
    playSpoken({ kind: 'podcast', id: x.id, title: x.title, sub: x.podcastTitle, link: `#/podcast/${x.podcast}`, cover: `/api/podcasts/${x.podcast}/image`,
      duration: x.duration || 0, position: x.position || 0, files: [{ id: x.id, offset: 0, duration: x.duration, url: `/api/podcasts/episodes/${x.id}/stream` }] });
  });
}

const FIRST = 60, CHUNK = 240, PAGE = 300;
const libCard = (i) => i.kind === 'collection' ? colCard(i) : card(i);
/** Byter filtret: sparas per bibliotek i webbläsaren och står i adressen (#/lib/1?…) så att länken går att dela */
function applyFilter(id, qs) {
  store.set('lf.' + id, new URLSearchParams(qs).toString());
  history.replaceState(null, '', `#/lib/${+id}${qs ? '?' + qs : ''}`);
  route();
}
views.lib = async (id, folder) => {
  // Hemvideor: mappar som navigering, liggande kort och datum (fälten home_video/folders från servern)
  if (libs.find(l => l.id === +id)?.home_video) return homeVideos(id, folder);
  let qs = hashQuery();
  if (qs == null) {
    // Ingen adressdel: senaste filtret för biblioteket (eller de äldre valen sort/filter)
    qs = store.get('lf.' + id, null);
    if (qs == null) {
      const o = new URLSearchParams(), f = store.get('filter.' + id, ''), s = store.get('sort.' + id, '');
      if (f) o.set('filter', f);
      if (s && s !== 'title') o.set('sort', s);
      qs = o.toString();
    }
    if (qs) history.replaceState(null, '', `#/lib/${+id}?${qs}`);
  }
  const P = new URLSearchParams(qs), scol = +P.get('scol') || null;
  P.delete('scol');
  // Blandat: fröet står i adressen så att ordningen ligger still medan man bläddrar (och i en delad länk)
  if (P.get('sort') === 'random' && !P.get('seed')) {
    P.set('seed', String(Math.floor(Math.random() * 999999)));
    history.replaceState(null, '', `#/lib/${+id}?${P}${scol ? '&scol=' + scol : ''}`);
  }
  qs = P.toString();
  store.set('lf.' + id, qs);
  const cols = store.get('cols.' + id, '1');
  const url = (off) => `/libraries/${id}/items?${qs ? qs + '&' : ''}collections=${cols}&limit=${PAGE}&offset=${off}`;
  const [d, own] = await Promise.all([api(url(0)),
    api(`/custom-collections?library=${encodeURIComponent(id)}`).catch(e => { if (e?.aborted) throw e; return []; })]);
  const lib = d.library, type = lib.type === 'show' ? 'show' : 'movie', movies = type === 'movie';
  qs = d.query ?? qs; // serverns normaliserade filter
  const sort = P.get('sort') || 'title', dir = P.get('order') || SORT_DIR[sort] || 'asc';
  const filtered = hasFilter(qs), nf = filterCount(qs), ch = chips(qs, type), total = d.total ?? d.items.length;
  const editing = scol ? own.find(c => c.id === scol && c.smart && c.editable) : null;
  const unit = movies ? (total === 1 ? 'titel' : 'titlar') : (total === 1 ? 'serie' : 'serier');
  main.innerHTML = `<div class="toolbar libbar"><h1>${esc(lib.name)}</h1><span class="muted" id="libcount" aria-live="polite">${total} ${unit}</span>
    <div class="libctl">
    ${movies ? `<select id="cols" aria-label="Visning" title="Visa filmer i samma samling som ett kort"><option value="1">Samlingar</option><option value="0">Alla filmer</option></select>` : ''}
    <button type="button" class="ghost" id="fbtn" aria-haspopup="dialog" aria-expanded="false">Filter${nf ? ` <span class="fcount" aria-label="${nf} aktiva">${nf}</span>` : ''}</button>
    <select id="srt" aria-label="Sortering">${Object.entries(SORT_LABEL).map(([k, l]) => `<option value="${k}"${k === sort ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    ${sort === 'random' ? iconButton({ icon: '↻', label: 'Blanda om', id: 'reshuffle' })
      : iconButton({ icon: dir === 'asc' ? '↑' : '↓', label: dir === 'asc' ? 'Stigande ordning – byt till fallande' : 'Fallande ordning – byt till stigande', id: 'sdir' })}
    <button type="button" class="ghost" id="shuffle"${total ? '' : ' disabled'} title="Spela en slumpad titel ur det som visas">🔀 Blanda</button>
    ${editing ? `<button type="button" class="primary" id="smartupd">Spara filtret i ${esc(editing.name)}</button>`
      : filtered ? '<button type="button" class="ghost" id="smartsave">Spara som smart samling</button>' : ''}
    </div></div>
    ${chipsHtml(ch)}
    ${own.length ? shelfHtml('Egna samlingar', own.map(colCard).join(''), { more: '<a href="#/collections">Alla samlingar</a>' }) : ''}
    ${d.items.length ? `<div class="grid" id="libgrid">${d.items.slice(0, FIRST).map(libCard).join('')}</div><div id="libmore" aria-hidden="true"></div>`
      : emptyState({ title: filtered ? 'Inget som matchar filtret' : 'Inget här ännu', text: filtered ? 'Ta bort ett filter eller välj Rensa alla.' : 'Titlarna dyker upp här när biblioteket har skannats.' })}`;
  // Stora bibliotek: de första korten direkt, resten av sidan i omgångar och nästa sida när man närmar sig slutet
  // (tusentals kort på en gång låser webbläsaren en stund, särskilt på TV och telefon)
  const items = d.items;
  let loaded = d.items.length, loading = false, shown = Math.min(FIRST, items.length), pumping = true;
  const pump = () => {
    const g = $('#libgrid');
    if (!g || shown >= items.length) { pumping = false; return; }
    const next = items.slice(shown, shown + CHUNK);
    shown += next.length;
    g.insertAdjacentHTML('beforeend', next.map(libCard).join(''));
    later(pump, 30);
  };
  later(pump, 30);
  const sentinel = $('#libmore');
  if (sentinel && loaded < total && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(async (es) => {
      if (!es.some(e => e.isIntersecting) || loading || loaded >= total) return;
      loading = true;
      try {
        const n = await api(url(loaded));
        items.push(...n.items); loaded += n.items.length;
        if (!n.items.length) loaded = total;
        if (!pumping) { pumping = true; pump(); }
      } catch (e) { if (!e?.aborted) toastErr(e); } finally { loading = false; }
      if (loaded >= total) io.disconnect();
    }, { rootMargin: '1200px 0px' });
    io.observe(sentinel);
    onLeave(() => io.disconnect());
  }
  const set = (fn) => { const o = new URLSearchParams(qs); fn(o); if (scol) o.set('scol', scol); applyFilter(id, o.toString()); };
  if ($('#cols')) { $('#cols').value = cols; $('#cols').onchange = (e) => { store.set('cols.' + id, e.target.value); route(); }; }
  $('#srt').onchange = (e) => set(o => { const v = e.target.value; o.delete('order'); o.delete('seed'); if (v === 'title') o.delete('sort'); else o.set('sort', v); });
  if ($('#sdir')) $('#sdir').onclick = () => set(o => o.set('order', dir === 'asc' ? 'desc' : 'asc'));
  if ($('#reshuffle')) $('#reshuffle').onclick = () => set(o => o.delete('seed'));
  $('#fbtn').onclick = act(async (e) => {
    const b = e.currentTarget;
    await openFilterPanel(b, { lib, qs, onApply: (q) => set(o => { for (const k of [...o.keys()]) if (!['sort', 'order', 'seed'].includes(k)) o.delete(k); for (const [k, v] of new URLSearchParams(q)) o.set(k, v); }) });
  });
  main.querySelector('.fchips')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]'); if (!b) return;
    const q = b.dataset.chip === 'all' ? new URLSearchParams([...new URLSearchParams(qs)].filter(([k]) => ['sort', 'order', 'seed'].includes(k))).toString() : ch[+b.dataset.chip].remove;
    applyFilter(id, q + (scol ? (q ? '&' : '') + 'scol=' + scol : ''));
    setTimeout(() => ($('.fchip') || $('#fbtn'))?.focus(), 50);
  });
  $('#shuffle').onclick = act(async (e) => {
    const b = e.currentTarget, r = await api(`/libraries/${id}/shuffle${qs ? '?' + qs : ''}`);
    toast(r.play.kind === 'episode' ? `Blandat: ${r.item.title} · ${sxe(r.play)}` : `Blandat: ${r.play.title}`);
    startPlay(b, r.play.id, r.play.watched ? 0 : r.play.position || 0);
  });
  if ($('#smartsave')) $('#smartsave').onclick = act(async () => {
    const cid = await collectionForm(null, null, { library: lib.id, query: qs });
    if (cid) toast('Den smarta samlingen är sparad', { action: { label: 'Visa', onClick: () => { location.hash = `#/ucollection/${cid}`; } } });
  });
  if ($('#smartupd')) $('#smartupd').onclick = act(async () => {
    await api(`/custom-collections/${editing.id}`, { method: 'PUT', body: { smart: { library: lib.id, query: qs } } });
    toast(`Filtret är sparat i ${editing.name}`);
    location.hash = `#/ucollection/${editing.id}`;
  });
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
