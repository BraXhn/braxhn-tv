// Vyer: musik – bibliotek, album, artister, spellistor och smarta spellistor
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, cardW, coverImg, esc, fmtDur, fmtTime, hue, imgSrc, keyClick, later, libs, main, me, routeGen, store, toast, views, t } from '../core.js';
import { M, playQueue, startRadio } from '../audio.js';
import { route } from '../router.js';
import { emptyState, noLib } from '../ui/states.js';
import { iconButton } from '../ui/buttons.js';
import { confirmDialog, openDialog, promptDialog } from '../ui/dialog.js';
import { tabsHtml } from '../ui/tabs.js';
import { bindStars, fmtStars, saveRating, starsHtml } from '../ui/rating.js';
import { similarArtists, stationsHtml, trackMenu } from '../sonic.js';
import { downloadAlbum, stateOf, supported as offlineOk } from '../offline.js';
import { KIND_LABEL, albumGroups, artistArt, artistCard, bindBio, bioHtml, facts, heroBg, isAdmin, linksHtml, matchArtist, relatedHtml } from '../musicinfo.js';

export const cover = (albumId, has, cls = '') => {
  const h = hue(String(albumId));
  return `<div class="cover ${cls}" style="--h1:hsl(${h} 40% 30%);--h2:hsl(${(h + 60) % 360} 45% 16%)">♪${has ? coverImg(`/api/music/cover/${+albumId}`, cls) : ''}</div>`;
};
const albumCard = (a) => `<a class="card mcard" href="#/album/${a.id}">${cover(a.id, a.cover)}<div class="t">${esc(a.title)}</div><div class="s">${esc(a.artist || '')}${a.year ? ' · ' + a.year : ''}</div></a>`;
export function trackRows(tracks, opts = {}) {
  return `<table class="tracks">${tracks.map((tt, i) => `<tr data-ti="${i}" data-tid="${tt.id}" class="${M.cur && M.cur.id === tt.id ? 'playing' : ''}">
    <td class="muted num">${opts.showCover ? cover(tt.albumId, tt.cover, 'tiny') : (tt.track || i + 1)}</td>
    <td><b>${esc(tt.title)}</b>${tt.userRating ? ` <span class="muted small trate" title="${t('Mitt betyg')}" aria-label="${t('Mitt betyg {userRating} av 5', { userRating: fmtStars(tt.userRating) })}">★${fmtStars(tt.userRating)}</span>` : ''}${opts.showArtist || opts.showCover ? `<div class="muted small">${esc(tt.artist || '')}${opts.showCover && tt.album ? ' · ' + esc(tt.album) : ''}</div>` : ''}</td>
    <td class="r muted">${fmtTime(tt.duration)}</td>
    <td class="r">${iconButton({ icon: tt.favorite ? '♥' : '♡', label: t('Favorit: {title}', { title: tt.title }), cls: 'ghost small fav', data: { fav: tt.id }, pressed: !!tt.favorite })}
    ${iconButton({ icon: '+', label: t('Lägg till {title} i en spellista', { title: tt.title }), data: { addpl: tt.id }, haspopup: 'dialog' })}
    ${iconButton({ icon: '⋮', label: t('Mer för {title}', { title: tt.title }), data: { tmenu: i }, haspopup: 'menu' })}</td></tr>`).join('')}</table>`;
}
export function bindTracks(tracks, root = main) {
  $$('[data-ti]', root).forEach(r => keyClick(r).onclick = (e) => { if (e.target.closest('button')) return; playQueue(tracks, +r.dataset.ti); });
  $$('[data-fav]', root).forEach(b => b.onclick = act(async () => {
    const set = (v) => { b.setAttribute('aria-pressed', String(v)); b.firstElementChild.textContent = v ? '♥' : '♡'; };
    const on = b.getAttribute('aria-pressed') !== 'true'; set(on);
    try { await api(`/music/tracks/${b.dataset.fav}/favorite`, { method: 'POST', body: { on }, bg: true }); }
    catch (e) { set(!on); throw e; }
  }));
  $$('[data-addpl]', root).forEach(b => b.onclick = act(() => addToPlaylist([+b.dataset.addpl])));
  // ⋮: låtradio, liknande låtar, ljudresa (ljudanalysen, sonic.js)
  $$('[data-tmenu]', root).forEach(b => b.onclick = () => { const t = tracks[+b.dataset.tmenu]; if (t) trackMenu(b, t); });
}
export async function addToPlaylist(ids) {
  const pls = await api('/music/playlists', { bg: true });
  const h = openDialog({ title: t('Lägg till i spellista'), closeOnRoute: false,
    body: `<div class="plpick">${pls.map(p => `<button class="ghost" data-pl="${p.id}">${esc(p.name)} <span class="muted small">${t('{tracks} låtar', { tracks: p.tracks })}</span></button>`).join('')}</div>
    <div class="row" style="margin-top:12px"><input id="newpl" placeholder="${t('Ny spellista…')}" aria-label="${t('Namn på ny spellista')}"><button class="primary" id="mkpl">${t('Skapa')}</button></div>` });
  const d = h.el;
  // Fokus på första spellistan (inte på fältet för en ny)
  $('[data-pl]', d)?.focus();
  $$('[data-pl]', d).forEach(b => b.onclick = act(async () => { await api(`/music/playlists/${b.dataset.pl}/tracks`, { method: 'POST', body: { trackIds: ids }, bg: true }); toast(t('Tillagd')); h.close(); }));
  $('#mkpl', d).onclick = act(async () => { const n = $('#newpl', d).value.trim(); if (!n) return $('#newpl', d).focus(); await api('/music/playlists', { method: 'POST', body: { name: n, trackIds: ids }, bg: true }); toast(t('Spellista skapad')); h.close(); });
  $('#newpl', d).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#mkpl', d).click(); } };
}

views.music = async (lid, tab) => {
  if (!lid) { const l = libs.find(x => x.type === 'music'); if (!l) return noLib(t('musik'), t('Musik')); location.hash = `#/music/${l.id}`; return; }
  tab = tab || store.get('mtab.' + lid, 'home');
  store.set('mtab.' + lid, tab);
  const tabs = [['home', t('Översikt')], ['albums', 'Album'], ['artists', t('Artister')], ['playlists', t('Spellistor')]];
  let body = '';
  if (tab === 'home') {
    const d = await api(`/music/${lid}/home`);
    const smartOnly = (d.smart || []).filter(x => !x.station); // stationerna har en egen hylla
    body = `<p class="muted">${t('{artists} artister · {albums} album · {tracks} låtar', { artists: d.stats.artists, albums: d.stats.albums, tracks: d.stats.tracks })}</p>
      ${d.recentlyPlayed.length ? `<section class="section"><h2>${t('Spelat nyligen')}</h2><div class="shelf">${d.recentlyPlayed.map(albumCard).join('')}</div></section>` : ''}
      ${stationsHtml(lid, d.smart || [], d.sonic)}
      <section class="section"><h2>${t('Smarta listor <a class="btn ghost small" href="#/smartedit/{lid}/new">+ Ny smart spellista</a>', { lid: +lid })}</h2>${smartOnly.length ? `<div class="shelf">${smartOnly.map(x => smartCard(lid, x)).join('')}</div>` : t('<p class="muted">Inga smarta listor med låtar ännu.</p>')}</section>
      <section class="section"><h2>${t('Nytt i biblioteket')}</h2><div class="shelf">${d.recentAlbums.map(albumCard).join('') || t('<p class="muted">Inga album ännu.</p>')}</div></section>
      ${d.favorites.length ? `<section class="section"><h2>${t('Favoriter')} <button class="ghost small" id="playfav">${t('▶ Spela')}</button> <button class="ghost small" id="shufav">${t('⤨ Blanda')}</button></h2>${trackRows(d.favorites, { showCover: true })}</section>` : ''}`;
    main.innerHTML = musicHeader(lid, tabs, tab) + body;
    if (d.favorites.length) { bindTracks(d.favorites); $('#playfav').onclick = () => playQueue(d.favorites, 0); $('#shufav').onclick = () => playQueue(shuffle(d.favorites), 0); }
    return;
  }
  if (tab === 'albums') {
    const sort = store.get('msort', 'artist');
    const a = await api(`/music/${lid}/albums?sort=${sort}`);
    body = `<div class="toolbar"><select id="msort"><option value="artist">Artist</option><option value="title">${t('Titel')}</option><option value="added">${t('Senast tillagda')}</option><option value="year">${t('År')}</option></select></div>
      <div class="grid">${a.map(albumCard).join('')}</div>`;
    main.innerHTML = musicHeader(lid, tabs, tab) + body;
    $('#msort').value = sort; $('#msort').onchange = (e) => { store.set('msort', e.target.value); route(); };
    return;
  }
  if (tab === 'artists') {
    const a = await api(`/music/${lid}/artists`);
    body = `<div class="grid">${a.map(x => artistCard(x)).join('')}</div>`;
  }
  if (tab === 'playlists') {
    const [p, sm] = await Promise.all([api('/music/playlists'), api('/music/smartlists')]);
    body = `<div class="row" style="margin-bottom:14px"><input id="npl" placeholder="${t('Ny spellista')}" aria-label="${t('Namn på ny spellista')}" style="max-width:260px"><button class="primary" id="mknpl">${t('Skapa')}</button></div>
      <table>${p.map(x => `<tr><td><a href="#/playlist/${x.id}"><b>${esc(x.name)}</b></a></td><td class="muted">${t('{tracks} låtar · {v}', { tracks: x.tracks, v: fmtDur(x.duration || 0) })}</td></tr>`).join('') || t('<tr><td class="muted">Inga spellistor ännu.</td></tr>')}</table>
      <section class="section"><h2>${t('Smarta spellistor <a class="btn primary small" href="#/smartedit/{lid}/new">+ Ny smart spellista</a>', { lid: +lid })}</h2>
      <p class="muted small">${t('Fylls på automatiskt efter dina regler, t.ex. genre, år eller hur ofta du spelat låtarna.')}</p>
      <table>${sm.lists.map(x => `<tr><td><a href="#/smart/${+lid}/u${+x.id}"><b>${esc(x.name)}</b></a></td>
        <td class="muted">${x.mine ? (x.shared ? t('Delad med alla') : t('Privat')) : t('Delad av {v}', { v: esc(x.owner || t('någon')) })}</td>
        <td class="r">${x.mine ? `<a class="btn ghost small" href="#/smartedit/${+lid}/${+x.id}" aria-label="${t('Redigera {name}', { name: esc(x.name) })}">${t('Redigera</a>')}` : ''}</td></tr>`).join('') || t('<tr><td class="muted">Inga egna smarta spellistor ännu.</td></tr>')}</table></section>`;
  }
  main.innerHTML = musicHeader(lid, tabs, tab) + body;
  if ($('#mknpl')) $('#mknpl').onclick = act(async () => { const n = $('#npl').value.trim(); if (!n) return; await api('/music/playlists', { method: 'POST', body: { name: n } }); route(); });
};
function musicHeader(lid, tabs, tab) {
  const lib = libs.find(l => l.id === +lid);
  return `<div class="toolbar"><h1>${esc(lib?.name || t('Musik'))}</h1><input id="msearch" aria-label="${t('Sök i musiken')}" placeholder="${t('Sök artist, album, låt (Enter)')}" style="max-width:280px"></div>
    ${tabsHtml({ label: t('Musik'), current: tab, items: tabs.map(([k, n]) => ({ key: k, label: n, href: `#/music/${lid}/${k}` })) })}`;
}
let msearchSeq = 0;
document.addEventListener('keydown', act(async (e) => {
  if (e.target.id !== 'msearch' || e.key !== 'Enter') return;
  const lid = location.hash.split('/')[2], q = e.target.value.trim(); if (!q) return;
  const gen = routeGen, seq = ++msearchSeq;
  const r = await api(`/music/${lid}/search?q=${encodeURIComponent(q)}`);
  // Användaren kan ha bytt sida (eller sökt igen) medan vi väntade
  const tabs = $('.tabs');
  if (gen !== routeGen || seq !== msearchSeq || !tabs || !$('#msearch')) return;
  const box = document.createElement('div');
  box.innerHTML = `<section class="section"><h2>${t('Sökresultat för ”{q}”', { q: esc(q) })}</h2>
    ${r.artists.length ? `<div class="row" style="margin-bottom:10px">${r.artists.map(a => `<a class="btn small" href="#/artist/${a.id}">${esc(a.name)}</a>`).join('')}</div>` : ''}
    ${r.albums.length ? `<div class="shelf" style="margin-bottom:14px">${r.albums.map(albumCard).join('')}</div>` : ''}
    ${r.tracks.length ? trackRows(r.tracks, { showCover: true }) : ''}${!r.artists.length && !r.albums.length && !r.tracks.length ? t('<p class="muted">Inga träffar.</p>') : ''}</section>`;
  $$('.msearchres').forEach(x => x.remove()); box.className = 'msearchres';
  tabs.after(box); bindTracks(r.tracks, box);
}));

views.album = async (id) => {
  const a = await api('/music/albums/' + id);
  const kind = a.type && a.type !== 'album' ? KIND_LABEL[a.type] : null;
  const released = a.info?.released && /^\d{4}-\d{2}-\d{2}$/.test(a.info.released) ? a.info.released : null;
  main.innerHTML = `<div class="mhero">${cover(a.id, a.cover, 'big')}<div><div class="muted small">${esc((kind || 'Album').toUpperCase())}</div><h1>${esc(a.title)}</h1>
    <div class="meta"><a href="#/artist/${a.artistId}">${esc(a.artist || '')}</a>${a.year ? `<span>${a.year}</span>` : ''}<span>${t('{tracks} låtar · {duration}', { tracks: a.tracks, duration: fmtDur(a.duration) })}</span>${a.genre ? `<span>${esc(a.genre)}</span>` : ''}</div>
    <div class="row"><button class="primary" id="pa">${t('▶ Spela')}</button><button class="ghost" id="sa">${t('⤨ Blanda')}</button><button class="ghost" id="aa">${t('+ Spellista')}</button><button class="ghost" id="ar">${t('📻 Låtradio')}</button>${me?.canDownload === false || !offlineOk() ? '' : `<button class="ghost" id="aoff" title="${t('Spara i webbläsaren och lyssna utan nät')}">${stateOf('album', a.id) === 'done' ? t('✓ Sparat offline') : t('⤓ Spara offline')}</button>`}</div>
    <div class="myrating"><span class="muted small">${t('Mitt betyg')}</span>${starsHtml(a.userRating, { id: 'albrate', label: t('Mitt betyg för albumet') })}</div></div></div>
    ${a.info?.description ? bioHtml(a.info.description, a.info.descLang, a.info.descUrl, 'albio') : ''}
    ${trackRows(a.trackList, { showArtist: a.trackList.some(t => t.artist !== a.artist) })}
    ${released || a.info?.mbid ? `<p class="muted small" style="margin-top:14px">${released ? t('Utgivet {released}', { released: esc(released) }) : ''}${a.info?.mbid ? `${released ? ' · ' : ''}<a href="https://musicbrainz.org/release-group/${esc(a.info.mbid)}" target="_blank" rel="noopener noreferrer">MusicBrainz ↗</a>` : ''}</p>` : ''}`;
  bindTracks(a.trackList);
  bindBio('albio');
  $('#pa').onclick = () => playQueue(a.trackList, 0);
  $('#sa').onclick = () => playQueue(shuffle(a.trackList), 0);
  $('#aa').onclick = act(() => addToPlaylist(a.trackList.map(t => t.id)));
  $('#ar').onclick = act(() => startRadio({ albumId: a.id }, a.title));
  if ($('#aoff')) $('#aoff').onclick = () => downloadAlbum(a.id);
  bindStars($('#albrate'), async (v) => { a.userRating = await saveRating('album', a.id, v) ?? undefined; });
};
// Artistsidan som i Plexamp/Apple Music: stor bild, fakta, biografi som fälls ut, Populärt, album per typ,
// liknande (ljudanalysen) och relaterade (MusicBrainz/Last.fm) artister, länkar
views.artist = async (id) => {
  const a = await api('/music/artists/' + id);
  const i = a.info, f = facts(i);
  const POP = 5;
  const allTracks = () => a.popular;
  main.innerHTML = `<div class="arhero${a.backdrop ? ' hasbg' : ''}">${heroBg(a)}<div class="mhero">${artistArt({ ...a, cover_album: a.albums.find(x => x.cover)?.id }, 'big round')}<div><div class="muted small">ARTIST</div><h1>${esc(a.name)}</h1>
    ${f.length || i?.genres?.length ? `<div class="meta">${f.map(x => `<span>${esc(x)}</span>`).join('')}${(i?.genres || []).slice(0, 4).map(g => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : ''}
    <div class="row"><button class="primary" id="pp">${t('▶ Spela populära')}</button><button class="ghost" id="arr">${t('📻 Låtradio')}</button>${a.albums.length > 1 ? t('<button class="ghost" id="ash">⤨ Blanda allt</button>') : ''}${isAdmin() ? t('<button class="ghost" id="amatch">Fel artist?</button>') : ''}</div></div></div></div>
    ${i?.bio ? bioHtml(i.bio, i.bioLang, i.bioUrl) : ''}
    ${a.popular.length ? `<section class="section"><h2>${t('Populärt')}</h2><div id="poprows">${trackRows(a.popular.slice(0, POP), { showCover: true })}</div>${a.popular.length > POP ? t('<button class="ghost small" id="popmore" aria-expanded="false">Visa fler</button>') : ''}</section>` : ''}
    ${albumGroups(a.albums, albumCard)}
    <div id="simart"></div>${relatedHtml(a.related)}${linksHtml(i?.links)}`;
  bindTracks(a.popular.slice(0, POP), $('#poprows') || main);
  bindBio();
  if ($('#popmore')) $('#popmore').onclick = (e) => {
    const open = e.currentTarget.getAttribute('aria-expanded') !== 'true';
    const list = open ? a.popular : a.popular.slice(0, POP);
    $('#poprows').innerHTML = trackRows(list, { showCover: true }); bindTracks(list, $('#poprows'));
    e.currentTarget.textContent = open ? t('Visa färre') : t('Visa fler'); e.currentTarget.setAttribute('aria-expanded', String(open));
  };
  $('#pp').onclick = () => playQueue(allTracks(), 0);
  $('#arr').onclick = act(() => startRadio({ artistId: a.id }, a.name));
  if ($('#ash')) $('#ash').onclick = act(async () => {
    const lists = await Promise.all(a.albums.slice(0, 25).map(x => api('/music/albums/' + x.id, { bg: true })));
    playQueue(shuffle(lists.flatMap(x => x.trackList)), 0);
  });
  if ($('#amatch')) $('#amatch').onclick = () => matchArtist(a, () => route());
  similarArtists($('#simart'), a.id);
};
views.playlist = async (id) => {
  const p = await api('/music/playlists/' + id);
  main.innerHTML = `<div class="mhero"><div class="cover big plcover">♫</div><div><div class="muted small">${t('SPELLISTA')}</div><h1>${esc(p.name)}</h1>
    <div class="meta"><span>${t('{trackListN} låtar · {v}', { trackListN: p.trackList.length, v: fmtDur(p.trackList.reduce((s, t) => s + (t.duration || 0), 0)) })}</span></div>
    <div class="row"><button class="primary" id="pp">${t('▶ Spela')}</button><button class="ghost" id="sp">${t('⤨ Blanda')}</button><button class="ghost" id="rn">${t('Byt namn')}</button><button class="danger" id="dl">${t('Ta bort')}</button></div></div></div>
    <div id="pltracks">${trackRows(p.trackList, { showCover: true })}</div>`;
  bindTracks(p.trackList);
  // Ta bort enskilda låtar
  $$('#pltracks tr').forEach((r, i) => { const tt = document.createElement('template'); tt.innerHTML = iconButton({ icon: '✕', label: t('Ta bort {v} ur listan', { v: p.trackList[i]?.title || t('låten') }) }); const b = tt.content.firstElementChild;
    b.onclick = act(async () => { const ids = p.trackList.map(t => t.id); ids.splice(i, 1); await api('/music/playlists/' + id, { method: 'PUT', body: { trackIds: ids } }); route(); });
    r.lastElementChild.append(b); });
  $('#pp').onclick = () => playQueue(p.trackList, 0);
  $('#sp').onclick = () => playQueue(shuffle(p.trackList), 0);
  $('#rn').onclick = act(async () => { const n = (await promptDialog(t('Nytt namn'), { title: t('Byt namn på spellistan'), value: p.name, required: true, maxlength: 100, okLabel: t('Spara') }))?.trim(); if (n) { await api('/music/playlists/' + id, { method: 'PUT', body: { name: n } }); route(); } });
  $('#dl').onclick = act(async () => { if (await confirmDialog(t('Ta bort spellistan {name}?', { name: p.name }), { okLabel: t('Ta bort'), danger: true })) { await api('/music/playlists/' + id, { method: 'DELETE' }); history.back(); } });
};
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- smarta spellistor ----------
// De fasta smarta listorna (server/listening.js SMART) har svenska namn från servern; egna (id u…) visas som de heter
const smartName = (x) => /^u\d/.test(String(x.id)) ? x.name : t(x.name);
function smartCard(lid, x) {
  const c = x.covers || [];
  const art = c.length >= 4 ? `<div class="cover smartmosaic">${c.slice(0, 4).map(id => `<img loading="lazy" decoding="async" ${imgSrc(`/api/music/cover/${+id}`, cardW() * 0.6)} alt="" width="300" height="300" data-fb="1">`).join('')}</div>`
    : cover(c[0] || x.id, !!c.length);
  return `<a class="card mcard" href="#/smart/${+lid}/${encodeURIComponent(x.id)}">${art}<div class="t">${esc(smartName(x))}</div><div class="s">${t('{count} låtar', { count: x.count })}</div></a>`;
}
views.smart = async (lid, sid) => {
  const p = await api(`/music/${encodeURIComponent(lid)}/smart/${encodeURIComponent(sid)}`);
  const station = /^sonic-/.test(String(sid)); // stämningsstation eller låtradio från ljudanalysen
  main.innerHTML = `<div class="mhero"><div class="cover big plcover">${station ? '📻' : '✦'}</div><div><div class="muted small">${station ? 'STATION' : t('SMART LISTA')}</div><h1>${esc(smartName({ id: sid, name: p.name }))}</h1>
    <div class="meta"><span>${t('{trackListN} låtar · {v}', { trackListN: p.trackList.length, v: fmtDur(p.trackList.reduce((s, t) => s + (t.duration || 0), 0)) })}</span><span>${t('Uppdateras automatiskt')}</span>${p.custom && !p.mine ? `<span>${t('Delad av {v}', { v: esc(p.owner || t('någon')) })}</span>` : p.shared ? t('<span>Delad</span>') : ''}</div>
    <div class="row"><button class="primary" id="pp">${t('▶ Spela')}</button><button class="ghost" id="sp">${t('⤨ Blanda')}</button><button class="ghost" id="ap">${t('+ Spellista')}</button>${p.custom && p.mine ? `${t('<a class="btn ghost" href="#/smartedit/{lid}/{listId}">Redigera regler</a>', { lid: +lid, listId: +p.listId })}` : ''}</div></div></div>
    ${p.trackList.length ? trackRows(p.trackList, { showCover: true }) : emptyState({ compact: true, title: t('Listan är tom just nu'), text: p.custom ? t('Inga låtar matchar reglerna just nu.') : station ? t('Stationen fylls på när ljudanalysen hunnit längre.') : t('Den fylls på automatiskt när du lyssnar.') })}`;
  bindTracks(p.trackList);
  $('#pp').onclick = () => playQueue(p.trackList, 0);
  $('#sp').onclick = () => playQueue(shuffle(p.trackList), 0);
  $('#ap').onclick = act(() => addToPlaylist(p.trackList.map(t => t.id)));
};

// ---------- smarta spellistor med egna regler (redigerare) ----------
// Reglerna kontrolleras av servern (vitlistade fält och operatorer, server/smartlists.js); här byggs bara formuläret.
let smartCat = null; // fält, operatorer och sorteringar från servern
const isoDay = (offset) => { const d = new Date(Date.now() + offset * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const defaultValue = (f, op) => f.type === 'bool' ? true : f.type === 'library' ? (libs.find(l => l.type === 'music')?.id || 0)
  : op === 'inLast' || op === 'notInLast' ? 30 : op === 'between' ? (f.type === 'date' ? [isoDay(-365), isoDay(0)] : [0, 0])
  : f.type === 'date' ? isoDay(0) : f.type === 'number' ? 0 : '';
const newRule = (fid = 'artist') => { const f = smartCat.fields.find(x => x.id === fid) || smartCat.fields[0]; return { field: f.id, op: f.ops[0], value: defaultValue(f, f.ops[0]) }; };
const opt = (v, label, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`;
const countRules = (st) => st.rules.reduce((a, r) => a + (r.rules ? r.rules.length : 1), 0);
const valueShape = (op) => op === 'between' ? 'b' : op === 'inLast' || op === 'notInLast' ? 'd' : 'v';

function ruleValueHtml(r, f, k, n) {
  const lab = (x) => t('aria-label="{x} för regel {n}"', { x: esc(x), n });
  if (f.type === 'bool') return `<select data-k="${k}.value" data-t="bool" ${lab(t('Värde'))}>${opt('true', t('Ja'), String(r.value))}${opt('false', 'Nej', String(r.value))}</select>`;
  if (f.type === 'library') return `<select data-k="${k}.value" data-t="int" ${lab(t('Bibliotek'))}>${libs.filter(l => l.type === 'music').map(l => opt(l.id, l.name, r.value)).join('')}</select>`;
  if (valueShape(r.op) === 'd') return `<input type="number" min="1" max="36500" step="1" inputmode="numeric" data-k="${k}.value" data-t="int" value="${esc(r.value)}" ${lab(t('Antal dagar'))}><span class="muted small">${t('dagar')}</span>`;
  const one = (v, key, what) => f.type === 'date' ? `<input type="date" data-k="${key}" value="${esc(v)}" ${lab(what)}>`
    : f.type === 'number' ? `<input type="number" step="any" data-k="${key}" data-t="num" value="${esc(v)}" ${lab(what)}>`
    : `<input type="text" maxlength="200" data-k="${key}" value="${esc(v)}" ${lab(what)}>`;
  if (r.op === 'between') return `${one(r.value[0], `${k}.value.0`, t('Från'))}<span class="muted small">${t('och')}</span>${one(r.value[1], `${k}.value.1`, t('Till'))}`;
  return one(r.value, `${k}.value`, t('Värde'));
}
function ruleHtml(r, k, n) {
  const f = smartCat.fields.find(x => x.id === r.field) || smartCat.fields[0];
  return `<div class="smartrule" role="group" aria-label="${t('Regel {n}', { n })}">
    <select data-k="${k}.field" data-act="field" aria-label="${t('Fält för regel {n}', { n })}">${smartCat.fields.map(x => opt(x.id, x.label, r.field)).join('')}</select>
    <select data-k="${k}.op" data-act="op" aria-label="${t('Villkor för regel {n}', { n })}">${f.ops.map(o => opt(o, smartCat.ops[o], r.op)).join('')}</select>
    <span class="smartval">${ruleValueHtml(r, f, k, n)}</span>
    ${iconButton({ icon: '✕', label: t('Ta bort regel {n}', { n }), data: { del: k } })}</div>`;
}
const matchSel = (m, k, label) => `<select data-k="${k}" class="smartmatch" aria-label="${esc(label)}">${opt('all', t('alla'), m)}${opt('any', t('någon'), m)}</select>`;
function rulesHtml(st) {
  let n = 0;
  return st.rules.map((r, i) => {
    if (!r.rules) return ruleHtml(r, `r.${i}`, ++n);
    return `<fieldset class="smartgroup"><legend>${t('Grupp {v}: matcha {v2} av reglerna', { v: i + 1, v2: matchSel(r.match, `r.${i}.match`, t('Matcha alla eller någon regel i grupp {v}', { v: i + 1 })) })}</legend>
      ${r.rules.map((x, j) => ruleHtml(x, `r.${i}.rules.${j}`, ++n)).join('') || t('<p class="muted small">Tom grupp – lägg till en regel.</p>')}
      <div class="row"><button type="button" class="ghost small" data-addin="${i}">${t('+ Regel i gruppen')}</button>${iconButton({ icon: '✕', label: t('Ta bort grupp {v}', { v: i + 1 }), data: { del: `r.${i}` } })}</div></fieldset>`;
  }).join('') || t('<p class="muted small">Inga regler – listan innehåller alla låtar.</p>');
}
// Nyckel som "r.2.rules.0.value.1" → [objektet som äger värdet, nyckeln]
function locate(st, k) {
  const parts = k.split('.');
  let o = st;
  if (parts[0] === 'r') { o = st.rules; parts.shift(); }
  for (const p of parts.slice(0, -1)) o = o[p];
  return [o, parts[parts.length - 1]];
}

views.smartedit = async (lid, id) => {
  const [cat, existing] = await Promise.all([api('/music/smartlists'), id && id !== 'new' ? api('/music/smartlists/' + encodeURIComponent(id)) : null]);
  smartCat = cat;
  if (existing && !existing.mine) { location.hash = `#/smart/${+lid}/u${+existing.id}`; return; }
  const st = existing ? { match: existing.match, rules: existing.rules, sort: existing.sort, order: existing.order, limit: existing.limit, limitMinutes: existing.limitMinutes }
    : { match: 'all', rules: [newRule()], sort: 'added', order: 'desc', limit: 50, limitMinutes: null };
  const limKind = () => st.limit ? 'count' : st.limitMinutes ? 'minutes' : 'none';
  const back = existing ? `#/smart/${+lid}/u${+existing.id}` : `#/music/${+lid}/playlists`;
  main.innerHTML = `<form id="smartform" class="panel smartedit" novalidate>
    <h1>${existing ? t('Redigera smart spellista') : t('Ny smart spellista')}</h1>
    <label for="smname">${t('Namn')}</label><input id="smname" maxlength="100" required value="${esc(existing?.name || '')}" placeholder="${t('T.ex. Svensk pop från 80-talet')}">
    <div class="row smarthead"><span>${t('Matcha')}</span>${matchSel(st.match, 'match', t('Matcha alla eller någon av reglerna'))}<span>${t('av följande regler')}</span></div>
    <div id="smrules"></div>
    <div class="row"><button type="button" class="ghost" id="smaddrule">${t('+ Regel')}</button><button type="button" class="ghost" id="smaddgrp">${t('+ Grupp')}</button></div>
    <div class="row smartopts">
      <div><label for="smsort">${t('Sortera efter')}</label><select id="smsort">${cat.sorts.map(s => opt(s.id, s.label, st.sort)).join('')}</select></div>
      <div><label for="smorder">${t('Ordning')}</label><select id="smorder">${opt('desc', t('Fallande'), st.order)}${opt('asc', t('Stigande'), st.order)}</select></div>
      <div><label for="smlimk">${t('Gräns')}</label><select id="smlimk">${opt('none', t('Ingen gräns'), limKind())}${opt('count', t('Antal låtar'), limKind())}${opt('minutes', t('Minuter'), limKind())}</select></div>
      <div><label for="smlimv">${t('Högst')}</label><input id="smlimv" type="number" min="1" step="1" inputmode="numeric" value="${esc(st.limit || st.limitMinutes || '')}"></div>
    </div>
    <label class="smartshare"><input type="checkbox" id="smshared"${existing?.shared ? ' checked' : ''}> ${t('Dela med andra på servern – de ser listan med sina egna spelningar och favoriter')}</label>
    <p id="smprev" class="smartprev" role="status" aria-live="polite">${t('Räknar…')}</p>
    <div class="row"><button type="submit" class="primary">${t('Spara')}</button><button type="button" class="ghost" id="smplay">${t('▶ Spela')}</button><button type="button" class="ghost" id="smshuf">${t('⤨ Blanda')}</button>
      ${t('<a class="btn ghost" href="{back}">Avbryt</a>{v}', { back, v: existing ? t('<button type="button" class="danger" id="smdel">Ta bort</button>') : '' })}</div>
    <div id="smsample"></div></form>`;
  const form = $('#smartform');
  const body = () => ({ name: $('#smname').value, shared: $('#smshared').checked, ...st });
  let seq = 0, pending = null;
  // Förhandsvisning medan man redigerar: antal träffar (fördröjd, bara sista ändringen räknas)
  const preview = () => {
    pending?.();
    pending = later(async () => {
      const my = ++seq;
      try {
        const r = await api('/music/smartlists/preview', { method: 'POST', body: body() });
        if (my !== seq) return;
        $('#smprev').classList.remove('err');
        $('#smprev').textContent = t('{count} låtar{v}{v2}', { count: r.count, v: r.duration ? ' · ' + fmtDur(r.duration) : '', v2: r.matches > r.count ? ` ${t('(av {matches} som matchar)', { matches: r.matches })}` : '' });
        $('#smsample').innerHTML = r.trackList.length ? `<h2 class="small muted">${t('Först i listan')}</h2>${trackRows(r.trackList, { showCover: true })}` : '';
        bindTracks(r.trackList, $('#smsample'));
      } catch (e) {
        if (my !== seq || e?.aborted) return;
        $('#smprev').classList.add('err'); $('#smprev').textContent = e.message; $('#smsample').innerHTML = '';
      }
    }, 350);
  };
  const render = (focusKey) => {
    $('#smrules').innerHTML = rulesHtml(st);
    $('#smaddrule').disabled = $('#smaddgrp').disabled = countRules(st) >= cat.maxRules;
    $('#smorder').disabled = st.sort === 'random';
    $('#smlimv').disabled = limKind() === 'none';
    if (focusKey) ($(`[data-k="${focusKey}"]`, form) || $('#smaddrule')).focus();
    preview();
  };
  // Värden ändras utan omritning (fokus och markör står kvar); fält och villkor ritar om regeln
  form.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (!k || e.target.dataset.act) return;
    const [o, key] = locate(st, k), t = e.target.dataset.t, v = e.target.value;
    o[key] = t === 'bool' ? v === 'true' : t === 'int' ? parseInt(v) : t === 'num' ? (v === '' ? '' : Number(v)) : v;
    preview();
  });
  form.addEventListener('change', (e) => {
    const k = e.target.dataset.k, a = e.target.dataset.act;
    if (!k || !a) return;
    const [rule] = locate(st, k);
    if (a === 'field') Object.assign(rule, newRule(e.target.value));
    else {
      const was = rule.op; rule.op = e.target.value;
      if (valueShape(was) !== valueShape(rule.op)) rule.value = defaultValue(cat.fields.find(x => x.id === rule.field), rule.op);
    }
    render(k);
  });
  form.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]'), addin = e.target.closest('[data-addin]');
    if (del) {
      const p = del.dataset.del.split('.');
      if (p.length === 2) st.rules.splice(+p[1], 1); else st.rules[+p[1]].rules.splice(+p[3], 1);
      render('');
      $('#smaddrule').focus();
    }
    if (addin && countRules(st) < cat.maxRules) {
      const i = +addin.dataset.addin, g = st.rules[i];
      g.rules.push(newRule());
      render(`r.${i}.rules.${g.rules.length - 1}.field`);
    }
  });
  $('#smaddrule').onclick = () => { st.rules.push(newRule()); render(`r.${st.rules.length - 1}.field`); };
  $('#smaddgrp').onclick = () => { st.rules.push({ match: 'any', rules: [newRule()] }); render(`r.${st.rules.length - 1}.rules.0.field`); };
  $('#smsort').onchange = (e) => { st.sort = e.target.value; render(); };
  $('#smorder').onchange = (e) => { st.order = e.target.value; preview(); };
  const setLim = (e) => {
    const k = $('#smlimk').value, v = parseInt($('#smlimv').value) || null;
    st.limit = k === 'count' ? (v || 50) : null;
    st.limitMinutes = k === 'minutes' ? (v || 60) : null;
    if (e.target.id === 'smlimk') { $('#smlimv').value = st.limit || st.limitMinutes || ''; $('#smlimv').disabled = k === 'none'; }
    preview();
  };
  $('#smlimk').onchange = setLim; $('#smlimv').oninput = setLim;
  const playAll = (mix) => act(async () => {
    const r = await api('/music/smartlists/preview?tracks=1', { method: 'POST', body: body() });
    if (!r.trackList.length) return toast(t('Inga låtar matchar reglerna'));
    playQueue(mix ? shuffle(r.trackList) : r.trackList, 0);
  });
  $('#smplay').onclick = playAll(false);
  $('#smshuf').onclick = playAll(true);
  form.onsubmit = act(async (e) => {
    e.preventDefault();
    if (!$('#smname').value.trim()) { toast(t('Ge listan ett namn'), { error: true }); $('#smname').focus(); return; }
    let nid = existing?.id;
    if (existing) await api('/music/smartlists/' + existing.id, { method: 'PUT', body: body() });
    else nid = (await api('/music/smartlists', { method: 'POST', body: body() })).id;
    toast(t('Smart spellista sparad'));
    location.hash = `#/smart/${+lid}/u${+nid}`;
  });
  if ($('#smdel')) $('#smdel').onclick = act(async () => {
    if (!await confirmDialog(t('Ta bort den smarta spellistan {name}?', { name: existing.name }), { okLabel: t('Ta bort'), danger: true })) return;
    await api('/music/smartlists/' + existing.id, { method: 'DELETE' });
    toast(t('Den smarta spellistan togs bort'));
    location.hash = `#/music/${+lid}/playlists`;
  });
  render();
  if (!existing) $('#smname').focus();
};
