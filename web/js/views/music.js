// Vyer: musik – bibliotek, album, artister, spellistor och smarta spellistor
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, cardW, coverImg, esc, fmtDur, fmtTime, hue, imgSrc, keyClick, later, libs, main, routeGen, store, toast, views } from '../core.js';
import { M, playQueue, startRadio } from '../audio.js';
import { route } from '../router.js';
import { emptyState, noLib } from '../ui/states.js';
import { iconButton } from '../ui/buttons.js';
import { confirmDialog, openDialog, promptDialog } from '../ui/dialog.js';
import { tabsHtml } from '../ui/tabs.js';
import { similarArtists, stationsHtml, trackMenu } from '../sonic.js';
import { KIND_LABEL, albumGroups, artistArt, artistCard, bindBio, bioHtml, facts, heroBg, isAdmin, linksHtml, matchArtist, relatedHtml } from '../musicinfo.js';

export const cover = (albumId, has, cls = '') => {
  const h = hue(String(albumId));
  return `<div class="cover ${cls}" style="--h1:hsl(${h} 40% 30%);--h2:hsl(${(h + 60) % 360} 45% 16%)">♪${has ? coverImg(`/api/music/cover/${+albumId}`, cls) : ''}</div>`;
};
const albumCard = (a) => `<a class="card mcard" href="#/album/${a.id}">${cover(a.id, a.cover)}<div class="t">${esc(a.title)}</div><div class="s">${esc(a.artist || '')}${a.year ? ' · ' + a.year : ''}</div></a>`;
export function trackRows(tracks, opts = {}) {
  return `<table class="tracks">${tracks.map((t, i) => `<tr data-ti="${i}" data-tid="${t.id}" class="${M.cur && M.cur.id === t.id ? 'playing' : ''}">
    <td class="muted num">${opts.showCover ? cover(t.albumId, t.cover, 'tiny') : (t.track || i + 1)}</td>
    <td><b>${esc(t.title)}</b>${opts.showArtist || opts.showCover ? `<div class="muted small">${esc(t.artist || '')}${opts.showCover && t.album ? ' · ' + esc(t.album) : ''}</div>` : ''}</td>
    <td class="r muted">${fmtTime(t.duration)}</td>
    <td class="r">${iconButton({ icon: t.favorite ? '♥' : '♡', label: `Favorit: ${t.title}`, cls: 'ghost small fav', data: { fav: t.id }, pressed: !!t.favorite })}
    ${iconButton({ icon: '+', label: `Lägg till ${t.title} i en spellista`, data: { addpl: t.id }, haspopup: 'dialog' })}
    ${iconButton({ icon: '⋮', label: `Mer för ${t.title}`, data: { tmenu: i }, haspopup: 'menu' })}</td></tr>`).join('')}</table>`;
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
  const h = openDialog({ title: 'Lägg till i spellista', closeOnRoute: false,
    body: `<div class="plpick">${pls.map(p => `<button class="ghost" data-pl="${p.id}">${esc(p.name)} <span class="muted small">${p.tracks} låtar</span></button>`).join('')}</div>
    <div class="row" style="margin-top:12px"><input id="newpl" placeholder="Ny spellista…" aria-label="Namn på ny spellista"><button class="primary" id="mkpl">Skapa</button></div>` });
  const d = h.el;
  // Fokus på första spellistan (inte på fältet för en ny)
  $('[data-pl]', d)?.focus();
  $$('[data-pl]', d).forEach(b => b.onclick = act(async () => { await api(`/music/playlists/${b.dataset.pl}/tracks`, { method: 'POST', body: { trackIds: ids }, bg: true }); toast('Tillagd'); h.close(); }));
  $('#mkpl', d).onclick = act(async () => { const n = $('#newpl', d).value.trim(); if (!n) return $('#newpl', d).focus(); await api('/music/playlists', { method: 'POST', body: { name: n, trackIds: ids }, bg: true }); toast('Spellista skapad'); h.close(); });
  $('#newpl', d).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#mkpl', d).click(); } };
}

views.music = async (lid, tab) => {
  if (!lid) { const l = libs.find(x => x.type === 'music'); if (!l) return noLib('musik', 'Musik'); location.hash = `#/music/${l.id}`; return; }
  tab = tab || store.get('mtab.' + lid, 'home');
  store.set('mtab.' + lid, tab);
  const tabs = [['home', 'Översikt'], ['albums', 'Album'], ['artists', 'Artister'], ['playlists', 'Spellistor']];
  let body = '';
  if (tab === 'home') {
    const d = await api(`/music/${lid}/home`);
    const smartOnly = (d.smart || []).filter(x => !x.station); // stationerna har en egen hylla
    body = `<p class="muted">${d.stats.artists} artister · ${d.stats.albums} album · ${d.stats.tracks} låtar</p>
      ${d.recentlyPlayed.length ? `<section class="section"><h2>Spelat nyligen</h2><div class="shelf">${d.recentlyPlayed.map(albumCard).join('')}</div></section>` : ''}
      ${stationsHtml(lid, d.smart || [], d.sonic)}
      <section class="section"><h2>Smarta listor <a class="btn ghost small" href="#/smartedit/${+lid}/new">+ Ny smart spellista</a></h2>${smartOnly.length ? `<div class="shelf">${smartOnly.map(x => smartCard(lid, x)).join('')}</div>` : '<p class="muted">Inga smarta listor med låtar ännu.</p>'}</section>
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
    body = `<div class="grid">${a.map(x => artistCard(x)).join('')}</div>`;
  }
  if (tab === 'playlists') {
    const [p, sm] = await Promise.all([api('/music/playlists'), api('/music/smartlists')]);
    body = `<div class="row" style="margin-bottom:14px"><input id="npl" placeholder="Ny spellista" aria-label="Namn på ny spellista" style="max-width:260px"><button class="primary" id="mknpl">Skapa</button></div>
      <table>${p.map(x => `<tr><td><a href="#/playlist/${x.id}"><b>${esc(x.name)}</b></a></td><td class="muted">${x.tracks} låtar · ${fmtDur(x.duration || 0)}</td></tr>`).join('') || '<tr><td class="muted">Inga spellistor ännu.</td></tr>'}</table>
      <section class="section"><h2>Smarta spellistor <a class="btn primary small" href="#/smartedit/${+lid}/new">+ Ny smart spellista</a></h2>
      <p class="muted small">Fylls på automatiskt efter dina regler, t.ex. genre, år eller hur ofta du spelat låtarna.</p>
      <table>${sm.lists.map(x => `<tr><td><a href="#/smart/${+lid}/u${+x.id}"><b>${esc(x.name)}</b></a></td>
        <td class="muted">${x.mine ? (x.shared ? 'Delad med alla' : 'Privat') : `Delad av ${esc(x.owner || 'någon')}`}</td>
        <td class="r">${x.mine ? `<a class="btn ghost small" href="#/smartedit/${+lid}/${+x.id}" aria-label="Redigera ${esc(x.name)}">Redigera</a>` : ''}</td></tr>`).join('') || '<tr><td class="muted">Inga egna smarta spellistor ännu.</td></tr>'}</table></section>`;
  }
  main.innerHTML = musicHeader(lid, tabs, tab) + body;
  if ($('#mknpl')) $('#mknpl').onclick = act(async () => { const n = $('#npl').value.trim(); if (!n) return; await api('/music/playlists', { method: 'POST', body: { name: n } }); route(); });
};
function musicHeader(lid, tabs, tab) {
  const lib = libs.find(l => l.id === +lid);
  return `<div class="toolbar"><h1>${esc(lib?.name || 'Musik')}</h1><input id="msearch" aria-label="Sök i musiken" placeholder="Sök artist, album, låt (Enter)" style="max-width:280px"></div>
    ${tabsHtml({ label: 'Musik', current: tab, items: tabs.map(([k, n]) => ({ key: k, label: n, href: `#/music/${lid}/${k}` })) })}`;
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
  const kind = a.type && a.type !== 'album' ? KIND_LABEL[a.type] : null;
  const released = a.info?.released && /^\d{4}-\d{2}-\d{2}$/.test(a.info.released) ? a.info.released : null;
  main.innerHTML = `<div class="mhero">${cover(a.id, a.cover, 'big')}<div><div class="muted small">${esc((kind || 'Album').toUpperCase())}</div><h1>${esc(a.title)}</h1>
    <div class="meta"><a href="#/artist/${a.artistId}">${esc(a.artist || '')}</a>${a.year ? `<span>${a.year}</span>` : ''}<span>${a.tracks} låtar · ${fmtDur(a.duration)}</span>${a.genre ? `<span>${esc(a.genre)}</span>` : ''}</div>
    <div class="row"><button class="primary" id="pa">▶ Spela</button><button class="ghost" id="sa">⤨ Blanda</button><button class="ghost" id="aa">+ Spellista</button><button class="ghost" id="ar">📻 Låtradio</button></div></div></div>
    ${a.info?.description ? bioHtml(a.info.description, a.info.descLang, a.info.descUrl, 'albio') : ''}
    ${trackRows(a.trackList, { showArtist: a.trackList.some(t => t.artist !== a.artist) })}
    ${released || a.info?.mbid ? `<p class="muted small" style="margin-top:14px">${released ? `Utgivet ${esc(released)}` : ''}${a.info?.mbid ? `${released ? ' · ' : ''}<a href="https://musicbrainz.org/release-group/${esc(a.info.mbid)}" target="_blank" rel="noopener noreferrer">MusicBrainz ↗</a>` : ''}</p>` : ''}`;
  bindTracks(a.trackList);
  bindBio('albio');
  $('#pa').onclick = () => playQueue(a.trackList, 0);
  $('#sa').onclick = () => playQueue(shuffle(a.trackList), 0);
  $('#aa').onclick = act(() => addToPlaylist(a.trackList.map(t => t.id)));
  $('#ar').onclick = act(() => startRadio({ albumId: a.id }, a.title));
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
    <div class="row"><button class="primary" id="pp">▶ Spela populära</button><button class="ghost" id="arr">📻 Låtradio</button>${a.albums.length > 1 ? '<button class="ghost" id="ash">⤨ Blanda allt</button>' : ''}${isAdmin() ? '<button class="ghost" id="amatch">Fel artist?</button>' : ''}</div></div></div></div>
    ${i?.bio ? bioHtml(i.bio, i.bioLang, i.bioUrl) : ''}
    ${a.popular.length ? `<section class="section"><h2>Populärt</h2><div id="poprows">${trackRows(a.popular.slice(0, POP), { showCover: true })}</div>${a.popular.length > POP ? '<button class="ghost small" id="popmore" aria-expanded="false">Visa fler</button>' : ''}</section>` : ''}
    ${albumGroups(a.albums, albumCard)}
    <div id="simart"></div>${relatedHtml(a.related)}${linksHtml(i?.links)}`;
  bindTracks(a.popular.slice(0, POP), $('#poprows') || main);
  bindBio();
  if ($('#popmore')) $('#popmore').onclick = (e) => {
    const open = e.currentTarget.getAttribute('aria-expanded') !== 'true';
    const list = open ? a.popular : a.popular.slice(0, POP);
    $('#poprows').innerHTML = trackRows(list, { showCover: true }); bindTracks(list, $('#poprows'));
    e.currentTarget.textContent = open ? 'Visa färre' : 'Visa fler'; e.currentTarget.setAttribute('aria-expanded', String(open));
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
  main.innerHTML = `<div class="mhero"><div class="cover big plcover">♫</div><div><div class="muted small">SPELLISTA</div><h1>${esc(p.name)}</h1>
    <div class="meta"><span>${p.trackList.length} låtar · ${fmtDur(p.trackList.reduce((s, t) => s + (t.duration || 0), 0))}</span></div>
    <div class="row"><button class="primary" id="pp">▶ Spela</button><button class="ghost" id="sp">⤨ Blanda</button><button class="ghost" id="rn">Byt namn</button><button class="danger" id="dl">Ta bort</button></div></div></div>
    <div id="pltracks">${trackRows(p.trackList, { showCover: true })}</div>`;
  bindTracks(p.trackList);
  // Ta bort enskilda låtar
  $$('#pltracks tr').forEach((r, i) => { const t = document.createElement('template'); t.innerHTML = iconButton({ icon: '✕', label: `Ta bort ${p.trackList[i]?.title || 'låten'} ur listan` }); const b = t.content.firstElementChild;
    b.onclick = act(async () => { const ids = p.trackList.map(t => t.id); ids.splice(i, 1); await api('/music/playlists/' + id, { method: 'PUT', body: { trackIds: ids } }); route(); });
    r.lastElementChild.append(b); });
  $('#pp').onclick = () => playQueue(p.trackList, 0);
  $('#sp').onclick = () => playQueue(shuffle(p.trackList), 0);
  $('#rn').onclick = act(async () => { const n = (await promptDialog('Nytt namn', { title: 'Byt namn på spellistan', value: p.name, required: true, maxlength: 100, okLabel: 'Spara' }))?.trim(); if (n) { await api('/music/playlists/' + id, { method: 'PUT', body: { name: n } }); route(); } });
  $('#dl').onclick = act(async () => { if (await confirmDialog(`Ta bort spellistan ${p.name}?`, { okLabel: 'Ta bort', danger: true })) { await api('/music/playlists/' + id, { method: 'DELETE' }); history.back(); } });
};
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- smarta spellistor ----------
function smartCard(lid, x) {
  const c = x.covers || [];
  const art = c.length >= 4 ? `<div class="cover smartmosaic">${c.slice(0, 4).map(id => `<img loading="lazy" decoding="async" ${imgSrc(`/api/music/cover/${+id}`, cardW() * 0.6)} alt="" width="300" height="300" data-fb="1">`).join('')}</div>`
    : cover(c[0] || x.id, !!c.length);
  return `<a class="card mcard" href="#/smart/${+lid}/${encodeURIComponent(x.id)}">${art}<div class="t">${esc(x.name)}</div><div class="s">${x.count} låtar</div></a>`;
}
views.smart = async (lid, sid) => {
  const p = await api(`/music/${encodeURIComponent(lid)}/smart/${encodeURIComponent(sid)}`);
  const station = /^sonic-/.test(String(sid)); // stämningsstation eller låtradio från ljudanalysen
  main.innerHTML = `<div class="mhero"><div class="cover big plcover">${station ? '📻' : '✦'}</div><div><div class="muted small">${station ? 'STATION' : 'SMART LISTA'}</div><h1>${esc(p.name)}</h1>
    <div class="meta"><span>${p.trackList.length} låtar · ${fmtDur(p.trackList.reduce((s, t) => s + (t.duration || 0), 0))}</span><span>Uppdateras automatiskt</span>${p.custom && !p.mine ? `<span>Delad av ${esc(p.owner || 'någon')}</span>` : p.shared ? '<span>Delad</span>' : ''}</div>
    <div class="row"><button class="primary" id="pp">▶ Spela</button><button class="ghost" id="sp">⤨ Blanda</button><button class="ghost" id="ap">+ Spellista</button>${p.custom && p.mine ? `<a class="btn ghost" href="#/smartedit/${+lid}/${+p.listId}">Redigera regler</a>` : ''}</div></div></div>
    ${p.trackList.length ? trackRows(p.trackList, { showCover: true }) : emptyState({ compact: true, title: 'Listan är tom just nu', text: p.custom ? 'Inga låtar matchar reglerna just nu.' : station ? 'Stationen fylls på när ljudanalysen hunnit längre.' : 'Den fylls på automatiskt när du lyssnar.' })}`;
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
  const lab = (x) => `aria-label="${esc(x)} för regel ${n}"`;
  if (f.type === 'bool') return `<select data-k="${k}.value" data-t="bool" ${lab('Värde')}>${opt('true', 'Ja', String(r.value))}${opt('false', 'Nej', String(r.value))}</select>`;
  if (f.type === 'library') return `<select data-k="${k}.value" data-t="int" ${lab('Bibliotek')}>${libs.filter(l => l.type === 'music').map(l => opt(l.id, l.name, r.value)).join('')}</select>`;
  if (valueShape(r.op) === 'd') return `<input type="number" min="1" max="36500" step="1" inputmode="numeric" data-k="${k}.value" data-t="int" value="${esc(r.value)}" ${lab('Antal dagar')}><span class="muted small">dagar</span>`;
  const one = (v, key, what) => f.type === 'date' ? `<input type="date" data-k="${key}" value="${esc(v)}" ${lab(what)}>`
    : f.type === 'number' ? `<input type="number" step="any" data-k="${key}" data-t="num" value="${esc(v)}" ${lab(what)}>`
    : `<input type="text" maxlength="200" data-k="${key}" value="${esc(v)}" ${lab(what)}>`;
  if (r.op === 'between') return `${one(r.value[0], `${k}.value.0`, 'Från')}<span class="muted small">och</span>${one(r.value[1], `${k}.value.1`, 'Till')}`;
  return one(r.value, `${k}.value`, 'Värde');
}
function ruleHtml(r, k, n) {
  const f = smartCat.fields.find(x => x.id === r.field) || smartCat.fields[0];
  return `<div class="smartrule" role="group" aria-label="Regel ${n}">
    <select data-k="${k}.field" data-act="field" aria-label="Fält för regel ${n}">${smartCat.fields.map(x => opt(x.id, x.label, r.field)).join('')}</select>
    <select data-k="${k}.op" data-act="op" aria-label="Villkor för regel ${n}">${f.ops.map(o => opt(o, smartCat.ops[o], r.op)).join('')}</select>
    <span class="smartval">${ruleValueHtml(r, f, k, n)}</span>
    ${iconButton({ icon: '✕', label: `Ta bort regel ${n}`, data: { del: k } })}</div>`;
}
const matchSel = (m, k, label) => `<select data-k="${k}" class="smartmatch" aria-label="${esc(label)}">${opt('all', 'alla', m)}${opt('any', 'någon', m)}</select>`;
function rulesHtml(st) {
  let n = 0;
  return st.rules.map((r, i) => {
    if (!r.rules) return ruleHtml(r, `r.${i}`, ++n);
    return `<fieldset class="smartgroup"><legend>Grupp ${i + 1}: matcha ${matchSel(r.match, `r.${i}.match`, `Matcha alla eller någon regel i grupp ${i + 1}`)} av reglerna</legend>
      ${r.rules.map((x, j) => ruleHtml(x, `r.${i}.rules.${j}`, ++n)).join('') || '<p class="muted small">Tom grupp – lägg till en regel.</p>'}
      <div class="row"><button type="button" class="ghost small" data-addin="${i}">+ Regel i gruppen</button>${iconButton({ icon: '✕', label: `Ta bort grupp ${i + 1}`, data: { del: `r.${i}` } })}</div></fieldset>`;
  }).join('') || '<p class="muted small">Inga regler – listan innehåller alla låtar.</p>';
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
    <h1>${existing ? 'Redigera smart spellista' : 'Ny smart spellista'}</h1>
    <label for="smname">Namn</label><input id="smname" maxlength="100" required value="${esc(existing?.name || '')}" placeholder="T.ex. Svensk pop från 80-talet">
    <div class="row smarthead"><span>Matcha</span>${matchSel(st.match, 'match', 'Matcha alla eller någon av reglerna')}<span>av följande regler</span></div>
    <div id="smrules"></div>
    <div class="row"><button type="button" class="ghost" id="smaddrule">+ Regel</button><button type="button" class="ghost" id="smaddgrp">+ Grupp</button></div>
    <div class="row smartopts">
      <div><label for="smsort">Sortera efter</label><select id="smsort">${cat.sorts.map(s => opt(s.id, s.label, st.sort)).join('')}</select></div>
      <div><label for="smorder">Ordning</label><select id="smorder">${opt('desc', 'Fallande', st.order)}${opt('asc', 'Stigande', st.order)}</select></div>
      <div><label for="smlimk">Gräns</label><select id="smlimk">${opt('none', 'Ingen gräns', limKind())}${opt('count', 'Antal låtar', limKind())}${opt('minutes', 'Minuter', limKind())}</select></div>
      <div><label for="smlimv">Högst</label><input id="smlimv" type="number" min="1" step="1" inputmode="numeric" value="${esc(st.limit || st.limitMinutes || '')}"></div>
    </div>
    <label class="smartshare"><input type="checkbox" id="smshared"${existing?.shared ? ' checked' : ''}> Dela med andra på servern – de ser listan med sina egna spelningar och favoriter</label>
    <p id="smprev" class="smartprev" role="status" aria-live="polite">Räknar…</p>
    <div class="row"><button type="submit" class="primary">Spara</button><button type="button" class="ghost" id="smplay">▶ Spela</button><button type="button" class="ghost" id="smshuf">⤨ Blanda</button>
      <a class="btn ghost" href="${back}">Avbryt</a>${existing ? '<button type="button" class="danger" id="smdel">Ta bort</button>' : ''}</div>
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
        $('#smprev').textContent = `${r.count} låtar${r.duration ? ' · ' + fmtDur(r.duration) : ''}${r.matches > r.count ? ` (av ${r.matches} som matchar)` : ''}`;
        $('#smsample').innerHTML = r.trackList.length ? `<h2 class="small muted">Först i listan</h2>${trackRows(r.trackList, { showCover: true })}` : '';
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
    if (!r.trackList.length) return toast('Inga låtar matchar reglerna');
    playQueue(mix ? shuffle(r.trackList) : r.trackList, 0);
  });
  $('#smplay').onclick = playAll(false);
  $('#smshuf').onclick = playAll(true);
  form.onsubmit = act(async (e) => {
    e.preventDefault();
    if (!$('#smname').value.trim()) { toast('Ge listan ett namn', { error: true }); $('#smname').focus(); return; }
    let nid = existing?.id;
    if (existing) await api('/music/smartlists/' + existing.id, { method: 'PUT', body: body() });
    else nid = (await api('/music/smartlists', { method: 'POST', body: body() })).id;
    toast('Smart spellista sparad');
    location.hash = `#/smart/${+lid}/u${+nid}`;
  });
  if ($('#smdel')) $('#smdel').onclick = act(async () => {
    if (!await confirmDialog(`Ta bort den smarta spellistan ${existing.name}?`, { okLabel: 'Ta bort', danger: true })) return;
    await api('/music/smartlists/' + existing.id, { method: 'DELETE' });
    toast('Den smarta spellistan togs bort');
    location.hash = `#/music/${+lid}/playlists`;
  });
  render();
  if (!existing) $('#smname').focus();
};
