// Vyer: musik – bibliotek, album, artister, spellistor och smarta spellistor
import { $, $$, act, api, esc, fmtDur, fmtTime, hue, keyClick, libs, main, noLib, routeGen, store, toast, views } from '../core.js';
import { M, playQueue } from '../audio.js';
import { route } from '../router.js';

export const cover = (albumId, has, cls = '') => {
  const h = hue(String(albumId));
  return `<div class="cover ${cls}" style="--h1:hsl(${h} 40% 30%);--h2:hsl(${(h + 60) % 360} 45% 16%)">♪${has ? `<img loading="lazy" src="/api/music/cover/${albumId}" alt="" data-fb="1">` : ''}</div>`;
};
const albumCard = (a) => `<a class="card mcard" href="#/album/${a.id}">${cover(a.id, a.cover)}<div class="t">${esc(a.title)}</div><div class="s">${esc(a.artist || '')}${a.year ? ' · ' + a.year : ''}</div></a>`;
export function trackRows(tracks, opts = {}) {
  return `<table class="tracks">${tracks.map((t, i) => `<tr data-ti="${i}" data-tid="${t.id}" class="${M.cur && M.cur.id === t.id ? 'playing' : ''}">
    <td class="muted num">${opts.showCover ? cover(t.albumId, t.cover, 'tiny') : (t.track || i + 1)}</td>
    <td><b>${esc(t.title)}</b>${opts.showArtist || opts.showCover ? `<div class="muted small">${esc(t.artist || '')}${opts.showCover && t.album ? ' · ' + esc(t.album) : ''}</div>` : ''}</td>
    <td class="r muted">${fmtTime(t.duration)}</td>
    <td class="r"><button class="ghost small fav" data-fav="${t.id}" title="Favorit">${t.favorite ? '♥' : '♡'}</button>
    <button class="ghost small" data-addpl="${t.id}" title="Lägg till i spellista">+</button></td></tr>`).join('')}</table>`;
}
function bindTracks(tracks, root = main) {
  $$('[data-ti]', root).forEach(r => keyClick(r).onclick = (e) => { if (e.target.closest('button')) return; playQueue(tracks, +r.dataset.ti); });
  $$('[data-fav]', root).forEach(b => b.onclick = act(async () => {
    const on = b.textContent !== '♥'; b.textContent = on ? '♥' : '♡';
    try { await api(`/music/tracks/${b.dataset.fav}/favorite`, { method: 'POST', body: { on }, bg: true }); }
    catch (e) { b.textContent = on ? '♡' : '♥'; throw e; }
  }));
  $$('[data-addpl]', root).forEach(b => b.onclick = act(() => addToPlaylist([+b.dataset.addpl])));
}
async function addToPlaylist(ids) {
  const pls = await api('/music/playlists', { bg: true });
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>Lägg till i spellista</h2><div class="plpick">${pls.map(p => `<button class="ghost" data-pl="${p.id}">${esc(p.name)} <span class="muted small">${p.tracks} låtar</span></button>`).join('')}</div>
    <div class="row" style="margin-top:12px"><input id="newpl" placeholder="Ny spellista…"><button class="primary" id="mkpl">Skapa</button></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="cl">Stäng</button></div>`;
  document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
  $('#cl', d).onclick = () => { d.close(); d.remove(); };
  $$('[data-pl]', d).forEach(b => b.onclick = act(async () => { await api(`/music/playlists/${b.dataset.pl}/tracks`, { method: 'POST', body: { trackIds: ids }, bg: true }); toast('Tillagd'); d.close(); d.remove(); }));
  $('#mkpl', d).onclick = act(async () => { const n = $('#newpl', d).value.trim(); if (!n) return; await api('/music/playlists', { method: 'POST', body: { name: n, trackIds: ids }, bg: true }); toast('Spellista skapad'); d.close(); d.remove(); });
}

views.music = async (lid, tab) => {
  if (!lid) { const l = libs.find(x => x.type === 'music'); if (!l) return noLib('musik', 'Musik'); location.hash = `#/music/${l.id}`; return; }
  tab = tab || store.get('mtab.' + lid, 'home');
  store.set('mtab.' + lid, tab);
  const tabs = [['home', 'Översikt'], ['albums', 'Album'], ['artists', 'Artister'], ['playlists', 'Spellistor']];
  let body = '';
  if (tab === 'home') {
    const d = await api(`/music/${lid}/home`);
    body = `<p class="muted">${d.stats.artists} artister · ${d.stats.albums} album · ${d.stats.tracks} låtar</p>
      ${d.recentlyPlayed.length ? `<section class="section"><h2>Spelat nyligen</h2><div class="shelf">${d.recentlyPlayed.map(albumCard).join('')}</div></section>` : ''}
      ${d.smart?.length ? `<section class="section"><h2>Smarta listor</h2><div class="shelf">${d.smart.map(x => smartCard(lid, x)).join('')}</div></section>` : ''}
      <section class="section"><h2>Nytt i biblioteket</h2><div class="shelf">${d.recentAlbums.map(albumCard).join('') || '<p class="muted">Inga album ännu.</p>'}</div></section>
      ${d.favorites.length ? `<section class="section"><h2>Favoriter <button class="ghost small" id="playfav">▶ Spela</button> <button class="ghost small" id="shufav">⤨ Blanda</button></h2>${trackRows(d.favorites, { showCover: true })}</section>` : ''}`;
    main.innerHTML = musicHeader(lid, tabs, tab) + body;
    if (d.favorites.length) { bindTracks(d.favorites); $('#playfav').onclick = () => playQueue(d.favorites, 0); $('#shufav').onclick = () => playQueue(shuffle(d.favorites), 0); }
    return;
  }
  if (tab === 'albums') {
    const sort = store.get('msort', 'artist');
    const a = await api(`/music/${lid}/albums?sort=${sort}`);
    body = `<div class="toolbar"><select id="msort"><option value="artist">Artist</option><option value="title">Titel</option><option value="added">Senast tillagda</option><option value="year">År</option></select></div>
      <div class="grid">${a.map(albumCard).join('')}</div>`;
    main.innerHTML = musicHeader(lid, tabs, tab) + body;
    $('#msort').value = sort; $('#msort').onchange = (e) => { store.set('msort', e.target.value); route(); };
    return;
  }
  if (tab === 'artists') {
    const a = await api(`/music/${lid}/artists`);
    body = `<div class="grid">${a.map(x => `<a class="card mcard" href="#/artist/${x.id}">${cover(x.cover_album || x.id, !!x.cover_album, 'round')}<div class="t">${esc(x.name)}</div><div class="s">${x.albums} album</div></a>`).join('')}</div>`;
  }
  if (tab === 'playlists') {
    const p = await api('/music/playlists');
    body = `<div class="row" style="margin-bottom:14px"><input id="npl" placeholder="Ny spellista" style="max-width:260px"><button class="primary" id="mknpl">Skapa</button></div>
      <table>${p.map(x => `<tr><td><a href="#/playlist/${x.id}"><b>${esc(x.name)}</b></a></td><td class="muted">${x.tracks} låtar · ${fmtDur(x.duration || 0)}</td></tr>`).join('') || '<tr><td class="muted">Inga spellistor ännu.</td></tr>'}</table>`;
  }
  main.innerHTML = musicHeader(lid, tabs, tab) + body;
  if ($('#mknpl')) $('#mknpl').onclick = act(async () => { const n = $('#npl').value.trim(); if (!n) return; await api('/music/playlists', { method: 'POST', body: { name: n } }); route(); });
};
function musicHeader(lid, tabs, tab) {
  const lib = libs.find(l => l.id === +lid);
  return `<div class="toolbar"><h1>${esc(lib?.name || 'Musik')}</h1><input id="msearch" placeholder="Sök artist, album, låt (Enter)" style="max-width:280px"></div>
    <div class="tabs">${tabs.map(([k, n]) => `<a class="tabbtn ${k === tab ? 'on' : ''}" href="#/music/${lid}/${k}">${n}</a>`).join('')}</div>`;
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
  box.innerHTML = `<section class="section"><h2>Sökresultat för ”${esc(q)}”</h2>
    ${r.artists.length ? `<div class="row" style="margin-bottom:10px">${r.artists.map(a => `<a class="btn small" href="#/artist/${a.id}">${esc(a.name)}</a>`).join('')}</div>` : ''}
    ${r.albums.length ? `<div class="shelf" style="margin-bottom:14px">${r.albums.map(albumCard).join('')}</div>` : ''}
    ${r.tracks.length ? trackRows(r.tracks, { showCover: true }) : ''}${!r.artists.length && !r.albums.length && !r.tracks.length ? '<p class="muted">Inga träffar.</p>' : ''}</section>`;
  $$('.msearchres').forEach(x => x.remove()); box.className = 'msearchres';
  tabs.after(box); bindTracks(r.tracks, box);
}));

views.album = async (id) => {
  const a = await api('/music/albums/' + id);
  main.innerHTML = `<div class="mhero">${cover(a.id, a.cover, 'big')}<div><div class="muted small">ALBUM</div><h1>${esc(a.title)}</h1>
    <div class="meta"><a href="#/artist/${a.artistId}">${esc(a.artist || '')}</a>${a.year ? `<span>${a.year}</span>` : ''}<span>${a.tracks} låtar · ${fmtDur(a.duration)}</span>${a.genre ? `<span>${esc(a.genre)}</span>` : ''}</div>
    <div class="row"><button class="primary" id="pa">▶ Spela</button><button class="ghost" id="sa">⤨ Blanda</button><button class="ghost" id="aa">+ Spellista</button></div></div></div>
    ${trackRows(a.trackList, { showArtist: a.trackList.some(t => t.artist !== a.artist) })}`;
  bindTracks(a.trackList);
  $('#pa').onclick = () => playQueue(a.trackList, 0);
  $('#sa').onclick = () => playQueue(shuffle(a.trackList), 0);
  $('#aa').onclick = act(() => addToPlaylist(a.trackList.map(t => t.id)));
};
views.artist = async (id) => {
  const a = await api('/music/artists/' + id);
  main.innerHTML = `<div class="mhero">${cover(a.albums[0]?.id || a.id, a.albums[0]?.cover, 'big round')}<div><div class="muted small">ARTIST</div><h1>${esc(a.name)}</h1>
    <div class="row"><button class="primary" id="pp">▶ Spela populära</button></div></div></div>
    ${a.popular.length ? `<section class="section"><h2>Populärt</h2>${trackRows(a.popular, { showCover: true })}</section>` : ''}
    <section class="section"><h2>Album</h2><div class="grid">${a.albums.map(albumCard).join('')}</div></section>`;
  bindTracks(a.popular);
  $('#pp').onclick = () => playQueue(a.popular, 0);
};
views.playlist = async (id) => {
  const p = await api('/music/playlists/' + id);
  main.innerHTML = `<div class="mhero"><div class="cover big plcover">♫</div><div><div class="muted small">SPELLISTA</div><h1>${esc(p.name)}</h1>
    <div class="meta"><span>${p.trackList.length} låtar · ${fmtDur(p.trackList.reduce((s, t) => s + (t.duration || 0), 0))}</span></div>
    <div class="row"><button class="primary" id="pp">▶ Spela</button><button class="ghost" id="sp">⤨ Blanda</button><button class="ghost" id="rn">Byt namn</button><button class="danger" id="dl">Ta bort</button></div></div></div>
    <div id="pltracks">${trackRows(p.trackList, { showCover: true })}</div>`;
  bindTracks(p.trackList);
  // Ta bort enskilda låtar
  $$('#pltracks tr').forEach((r, i) => { const b = document.createElement('button'); b.className = 'ghost small'; b.textContent = '✕'; b.title = 'Ta bort ur listan';
    b.onclick = act(async () => { const ids = p.trackList.map(t => t.id); ids.splice(i, 1); await api('/music/playlists/' + id, { method: 'PUT', body: { trackIds: ids } }); route(); });
    r.lastElementChild.append(b); });
  $('#pp').onclick = () => playQueue(p.trackList, 0);
  $('#sp').onclick = () => playQueue(shuffle(p.trackList), 0);
  $('#rn').onclick = act(async () => { const n = prompt('Nytt namn:', p.name); if (n) { await api('/music/playlists/' + id, { method: 'PUT', body: { name: n } }); route(); } });
  $('#dl').onclick = act(async () => { if (confirm('Ta bort spellistan?')) { await api('/music/playlists/' + id, { method: 'DELETE' }); history.back(); } });
};
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- smarta spellistor ----------
function smartCard(lid, x) {
  const c = x.covers || [];
  const art = c.length >= 4 ? `<div class="cover smartmosaic">${c.slice(0, 4).map(id => `<img loading="lazy" src="/api/music/cover/${+id}" alt="" data-fb="1">`).join('')}</div>`
    : cover(c[0] || x.id, !!c.length);
  return `<a class="card mcard" href="#/smart/${+lid}/${encodeURIComponent(x.id)}">${art}<div class="t">${esc(x.name)}</div><div class="s">${x.count} låtar</div></a>`;
}
views.smart = async (lid, sid) => {
  const p = await api(`/music/${encodeURIComponent(lid)}/smart/${encodeURIComponent(sid)}`);
  main.innerHTML = `<div class="mhero"><div class="cover big plcover">✦</div><div><div class="muted small">SMART LISTA</div><h1>${esc(p.name)}</h1>
    <div class="meta"><span>${p.trackList.length} låtar · ${fmtDur(p.trackList.reduce((s, t) => s + (t.duration || 0), 0))}</span><span>Uppdateras automatiskt</span></div>
    <div class="row"><button class="primary" id="pp">▶ Spela</button><button class="ghost" id="sp">⤨ Blanda</button><button class="ghost" id="ap">+ Spellista</button></div></div></div>
    ${p.trackList.length ? trackRows(p.trackList, { showCover: true }) : '<p class="muted">Listan är tom just nu.</p>'}`;
  bindTracks(p.trackList);
  $('#pp').onclick = () => playQueue(p.trackList, 0);
  $('#sp').onclick = () => playQueue(shuffle(p.trackList), 0);
  $('#ap').onclick = act(() => addToPlaylist(p.trackList.map(t => t.id)));
};
