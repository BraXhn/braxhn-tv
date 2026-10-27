// Vyer: film-, avsnitts- och seriesidor med trailers, metadataverktyg, undertextsökning och följ-knapp
import { $, $$, act, api, esc, fmtDur, fmtSize, fmtTime, heroUrl, imgSrc, main, me, resLabel, store, sxe, toast, toastErr, views } from '../core.js';
import { capsQuery } from '../player/caps.js';
import { LP, RP } from '../player/live.js';
import { stopVideo } from '../player/overlay.js';
import { openRemotePicker, remoteButton } from '../player/remote.js';
import { P, startPlay } from '../player/video.js';
import { route } from '../router.js';
import { art, card, castShelf, fmtTaken, shelf } from '../ui/cards.js';
import { addToCollection } from '../ui/collections.js';
import { openDialog } from '../ui/dialog.js';
import { emptyState, errorState, loadingState } from '../ui/states.js';
import { bindTabs, tabsHtml } from '../ui/tabs.js';
import { missingBox } from './calendar.js';

// ---------- "Finns även på" (streamingtjänster för titeln) ----------
// Här och inte i views/streaming.js: den vyn laddas först när den öppnas, men rutan syns på varje titelsida
const provLinks = (list) => list.map(p => `<a class="prov${p.mine ? ' mine' : ''}" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="Öppna i ${esc(p.name)}">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}<span>${esc(p.name)}</span></a>`).join('');
/** Tjänsterna där en titel finns (från /api/items/:id/watch) som HTML, '' om inga */
export const provBlock = (w) => {
  if (!w) return '';
  const sub = [...w.flatrate, ...w.free], pay = [...w.rent, ...w.buy.filter(b => !w.rent.some(r => r.id === b.id))];
  if (!sub.length && !pay.length) return '';
  return `${sub.length ? `<div class="provrow"><span class="muted small">Ingår i</span>${provLinks(sub)}</div>` : ''}${pay.length ? `<div class="provrow"><span class="muted small">Hyr/köp</span>${provLinks(pay.slice(0, 6))}</div>` : ''}
    <div class="muted small" style="margin-top:4px">Uppgifter från JustWatch via TMDB. Öppnas i tjänstens app eller webbplats.</div>`;
};
/** Fyller rutan "Finns även på" på titelsidan (anropas av route() när vyn visats) */
export async function fillWatch() {
  const el = $('[data-wid]'); if (!el) return;
  const w = await api(`/items/${el.dataset.wid}/watch`).catch(() => null);
  const html = provBlock(w);
  if (html && el.isConnected) el.innerHTML = `<h3 style="font-size:15px;margin:14px 0 6px">Finns även på</h3>${html}`;
}

function heroHtml(it, extra = '') {
  // Hemvideor (taken): inspelningsdagen i stället för året
  const meta = [it.taken ? esc(fmtTaken(it.taken)) : it.year, it.kind === 'movie' ? fmtDur(it.duration) : (it.episodes ? `${it.episodes} avsnitt` : ''),
    it.rating ? `<span class="star">★ ${it.rating.toFixed(1)}</span>` : '', it.kind === 'movie' ? resLabel(it.height) : '',
    it.age != null ? `<span class="agebadge" title="${esc(it.cert || '')}">${it.age === 0 ? 'Barntillåten' : it.age + '+'}</span>` : '',
    (it.genres || []).slice(0, 3).map(esc).join(', '), it.studio ? esc(it.studio) : '']
    .filter(Boolean).map(x => `<span>${x}</span>`).join('');
  // Bakgrundens medelfärg (server/imgcolor.js) syns medan bilden laddas
  const bg = /^#[0-9a-f]{6}$/i.test(it.phBackdrop || '') ? `background-color:${it.phBackdrop};` : '';
  return `<div class="hero">${it.backdrop ? `<div class="bd" style="${bg}background-image:url(${heroUrl(`/api/image/${+it.id}/backdrop`)})"></div>` : ''}
    <div class="in"><div class="poster card">${art({ ...it, position: 0 }, false, innerWidth <= 700 ? 130 : 210)}</div>
    <div>${it.logo ? `<h1 class="hlogo"><img src="/api/image/${+it.id}/logo" alt="${esc(it.title)}" decoding="async" data-fb="1"></h1>` : `<h1>${esc(it.title)}</h1>`}<div class="meta">${meta}</div>
    ${it.tagline ? `<p class="tagline">${esc(it.tagline)}</p>` : ''}${it.overview ? `<p class="overview">${esc(it.overview)}</p>` : ''}${extra}${it.kind !== 'episode' && !me.kid ? `<div class="watchprov" data-wid="${it.id}"></div>` : ''}</div></div></div>`;
}

views.item = async (id, season) => {
  // Flera versioner (t.ex. 4K och 1080p): valet sparas per film i webbläsaren, annars väljer servern
  const chosen = store.get('version.' + id, '');
  const it = await api('/items/' + id + (chosen ? '?version=' + encodeURIComponent(chosen) : ''));
  if (it.kind === 'show') return showView(it, season);
  const verSel = it.versions ? (it.versions.some(v => String(v.id) === String(chosen)) ? String(chosen) : '') : '';
  const resume = it.position > 30;
  const actions = `<div class="row">
    ${resume ? `<button class="primary" data-play="${it.position}">▶ Fortsätt från ${fmtTime(it.position)}</button><button class="ghost" data-play="0">Börja om</button>`
      : `<button class="primary" data-play="0">▶ Spela</button>`}
    ${remoteButton('playon')}
    <button class="ghost" id="seen">${it.watched ? 'Markera som osedd' : 'Markera som sedd'}</button>
    <button class="ghost" id="wl">${it.inWatchlist ? '✓ I Min lista' : '+ Min lista'}</button>${it.kind === 'movie' ? '<button class="ghost" id="addcol" aria-haspopup="dialog">+ Samling</button>' : ''}${trailerBtns(it)}
    ${me.canDownload === false ? '' : `<a class="btn" href="/api/stream/${it.version || it.id}/download" download>Ladda ner</a>`}
    ${me.is_admin ? `<button class="ghost" id="refresh">Uppdatera metadata</button>${it.taken ? '' : '<button class="ghost" id="match">Fel titel?</button>'}<button class="ghost" id="edit">Redigera</button>` : ''}</div>`;
  const back = it.kind === 'episode' ? `<p><a class="muted" href="#/item/${it.show}">← ${esc(it.showTitle)}</a> · ${sxe(it)}</p>` : '';
  const versions = it.versions ? `<div class="row" style="margin-top:10px"><label class="muted small" for="ver">Version</label>
    <select id="ver"><option value="">Automatiskt</option>${it.versions.map(v => `<option value="${v.id}">${esc(v.label)}${v.size ? ' · ' + fmtSize(v.size) : ''}</option>`).join('')}</select></div>` : '';
  main.innerHTML = heroHtml(it, back + actions + versions) + `<div class="tech">
    <span>Fil</span><b>${esc(it.file)}</b><span>Storlek</span><b>${fmtSize(it.size)}</b>
    <span>Video</span><b>${esc(it.vcodec || '–')} ${it.width ? it.width + '×' + it.height : ''}</b>
    <span>Ljud</span><b>${it.audio.map(a => esc([a.lang, a.codec, a.channels ? a.channels + 'ch' : ''].filter(Boolean).join(' '))).join(', ') || '–'}</b>
    <span>Undertexter</span><b>${it.subtitles.map(s => esc(s.label)).join(', ') || '–'}</b>
    ${it.hdr ? `<span>HDR</span><b>${esc(it.hdr.toUpperCase())} – tonmappas automatiskt på skärmar utan HDR</b>` : ''}
    ${it.recap ? `<span>Sammanfattning</span><b>${fmtTime(it.recap.start)}–${fmtTime(it.recap.end)}</b>` : ''}
    ${it.intro ? `<span>Intro</span><b>${fmtTime(it.intro.start)}–${fmtTime(it.intro.end)}</b>` : ''}
    ${it.credits ? `<span>Eftertexter</span><b>från ${fmtTime(it.credits)}</b>` : ''}
    <span>Uppspelning</span><b id="pbinfo">…</b></div>
    <div class="row" style="margin-top:16px"><button class="ghost small" id="subsearch">Sök undertexter online</button>
    ${me.is_admin && it.kind === 'episode' ? '<button class="ghost small" id="markers">Justera intro/eftertexter</button>' : ''}</div>`;
  if ($('#ver')) {
    $('#ver').value = verSel;
    $('#ver').onchange = (e) => { store.set('version.' + it.id, e.target.value); route(); };
  }
  api(`/items/${it.id}/playback?${capsQuery(verSel ? { version: verSel } : {})}&info=1`).then(p => {
    const m = { direct: 'Direktuppspelning', remux: 'Remux', transcode: 'Omkodning' }[p.mode];
    if ($('#pbinfo')) $('#pbinfo').textContent = m + (p.reasons.length ? ' (' + p.reasons.join(', ') + ')' : '');
    // Visa vilken version servern valde automatiskt
    const auto = !verSel && p.versions && p.versions.find(v => v.id === p.version);
    if (auto && $('#ver')) $('#ver').options[0].textContent = 'Automatiskt (' + auto.label + ')';
  }).catch(() => {});
  $('#subsearch').onclick = () => subSearch(it);
  bindWatchlist(it);
  bindCollections(it);
  bindTrailers(it);
  main.insertAdjacentHTML('beforeend', castShelf(it));
  if (it.collectionInfo && it.collectionInfo.items.length > 1) main.insertAdjacentHTML('beforeend', shelf(`Del av ${it.collectionInfo.name}`, it.collectionInfo.items, false, `<a href="#/collection/${it.collectionInfo.id}">Visa samlingen</a>`));
  main.insertAdjacentHTML('beforeend', shelf('Liknande', it.similar));
  if ($('#markers')) $('#markers').onclick = () => editMarkers(it);
  $$('[data-play]').forEach(b => b.onclick = () => startPlay(b, it.id, +b.dataset.play, verSel ? { version: verSel } : {}));
  $('#playon').onclick = (e) => openRemotePicker(e.currentTarget, { item: it.id, position: resume ? it.position : 0 });
  $('#seen').onclick = act(async () => { await api(`/items/${it.id}/watched`, { method: 'POST', body: { watched: !it.watched } }); route(); });
  if (me.is_admin) {
    $('#refresh').onclick = () => refreshMeta(it);
    if ($('#match')) $('#match').onclick = () => matchItem(it);
    $('#edit').onclick = () => editItem(it);
  }
};

// season = säsong från länken (#/item/:id/:säsong, t.ex. från "Nyligen tillagda"), annars den man sist valde
function showView(it, season) {
  const seasons = [...new Set(it.children.map(e => e.season))].sort((a, b) => a - b);
  let cur = season != null && season !== '' && seasons.includes(+season) ? +season : store.get('season.' + it.id, it.next?.season ?? seasons[0]);
  if (!seasons.includes(cur)) cur = seasons[0];
  const nx = it.next;
  const actions = `<div class="row">${nx ? `<button class="primary" id="playnext">▶ ${nx.position > 0 ? 'Fortsätt' : 'Spela'} ${sxe(nx)}</button>` : ''}
    <button class="ghost" id="seen">${it.watched ? 'Markera serien som osedd' : 'Markera serien som sedd'}</button>
    <button class="ghost" id="wl">${it.inWatchlist ? '✓ I Min lista' : '+ Min lista'}</button><button class="ghost" id="addcol" aria-haspopup="dialog">+ Samling</button>${trailerBtns(it)}
    <button class="ghost" id="follow" title="Få besked när nya avsnitt kommer">${it.following ? '🔔 Följer' : '🔕 Följ'}</button>
    <select id="fsync" title="Håll nästa osedda avsnitt nedladdade i appen" ${it.following ? '' : 'hidden'}>${[['', 'Appen: standard'], ['0', 'Appen: ladda inte ner'], ...[1, 2, 3, 5].map(n => [String(n), `Appen: håll ${n} nedladdade`])].map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
    ${me.is_admin ? `<button class="ghost" id="refresh">Uppdatera metadata</button>${it.kind !== 'episode' ? '<button class="ghost" id="match">Fel titel?</button>' : ''}<button class="ghost" id="edit">Redigera</button>` : ''}</div>`;
  main.innerHTML = heroHtml(it, actions + '<div id="missing" hidden></div>') + tabsHtml({ id: 'tabs', label: 'Säsonger', panel: 'eps', current: cur,
    items: seasons.map(s => ({ key: s, label: s === 0 ? 'Specialavsnitt' : 'Säsong ' + s })) }) + '<div id="eps" role="tabpanel"></div>';
  const renderEps = () => {
    const eps = it.children.filter(e => e.season === cur);
    const allSeen = eps.every(e => e.watched);
    // Lokal säsongsaffisch (season01-poster.jpg bredvid serien)
    const sp = (it.seasonPosters || []).includes(cur) ? `<img class="season-poster" ${imgSrc(`/api/image/${+it.id}/season${+cur}`, 90)} alt="" width="90" height="135" data-fb="1">` : '';
    $('#eps').innerHTML = `<div class="row" style="margin-bottom:10px">${sp}<button class="ghost small" id="seasonSeen">${allSeen ? 'Markera säsongen som osedd' : 'Markera säsongen som sedd'}</button></div>
      <div class="eps">${eps.map(e => `<div class="ep">${card(e, true).replace(`href="#/item/${e.id}"`, `href="#/item/${e.id}"`)}
      <div class="info"><h3>${e.episode}. ${esc(e.title)}</h3><div class="muted">${fmtDur(e.duration)}${e.watched ? ' · Sedd' : e.position ? ` · ${fmtTime(e.position)} kvar: ${fmtTime(e.duration - e.position)}` : ''}</div>
      ${e.overview ? `<p>${esc(e.overview)}</p>` : ''}
      <div class="acts" style="margin-top:8px"><button class="primary small" data-play="${e.id}" data-pos="${e.position}">▶ Spela</button>
      <button class="ghost small" data-seen="${e.id}" data-w="${e.watched ? 1 : 0}">${e.watched ? 'Osedd' : 'Sedd'}</button></div></div></div>`).join('')}</div>`;
    $$('[data-play]', $('#eps')).forEach(b => b.onclick = () => startPlay(b, +b.dataset.play, +b.dataset.pos));
    $$('[data-seen]').forEach(b => b.onclick = act(async () => { await api(`/items/${b.dataset.seen}/watched`, { method: 'POST', body: { watched: b.dataset.w !== '1' } }); route(); }));
    $('#seasonSeen').onclick = act(async () => { await api(`/items/${it.id}/watched?season=${cur}`, { method: 'POST', body: { watched: !allSeen } }); route(); });
  };
  renderEps();
  missingBox($('#missing'), it.id).catch(() => {});
  bindWatchlist(it);
  bindCollections(it);
  bindTrailers(it);
  main.insertAdjacentHTML('beforeend', castShelf(it));
  bindFollow(it);
  main.insertAdjacentHTML('beforeend', shelf('Liknande serier', it.similar));
  bindTabs($('#tabs'), (key, tab) => { cur = +key; store.set('season.' + it.id, cur); $('#eps').setAttribute('aria-label', tab.textContent); renderEps(); });
  if (nx) $('#playnext').onclick = (e) => startPlay(e.currentTarget, nx.id, nx.position);
  $('#seen').onclick = act(async () => { await api(`/items/${it.id}/watched`, { method: 'POST', body: { watched: !it.watched } }); route(); });
  if (me.is_admin) { $('#refresh').onclick = () => refreshMeta(it); $('#edit').onclick = () => editItem(it); if ($('#match')) $('#match').onclick = () => matchItem(it); }
}

// Egna samlingar: "+ Samling" och raden "Ingår i …" under knapparna (bara samlingar profilen ser)
function bindCollections(it) {
  const b = $('#addcol'); if (!b) return;
  const fill = () => api(`/custom-collections?item=${+it.id}`, { bg: true }).then(cols => {
    const inCols = cols.filter(c => c.has);
    $('#incol')?.remove();
    if (inCols.length && b.isConnected) b.closest('.row').insertAdjacentHTML('afterend', `<p class="muted small" id="incol">Ingår i ${inCols.map(c => `<a href="#/ucollection/${+c.id}">${esc(c.name)}</a>`).join(', ')}</p>`);
  }).catch(() => {});
  b.onclick = async () => { await addToCollection(it); fill(); };
  fill();
}
function bindWatchlist(it) {
  const b = $('#wl'); if (!b) return;
  b.onclick = act(async () => {
    const add = !it.inWatchlist;
    await api(`/items/${it.id}/watchlist`, { method: 'POST', body: { add } });
    it.inWatchlist = add;
    b.textContent = it.inWatchlist ? '✓ I Min lista' : '+ Min lista';
    toast(it.inWatchlist ? 'Tillagd i Min lista' : 'Borttagen från Min lista');
  });
}

// ---------- Trailers ----------
function trailerBtns(it) {
  const local = (it.trailers || []).map(t => `<button class="ghost" data-trailer="${+t.id}">▶ ${esc(t.name)}</button>`).join('');
  // YouTube öppnas i ny flik (CSP tillåter inte inbäddning)
  const yt = it.youtube ? `<a class="btn" href="https://www.youtube.com/watch?v=${encodeURIComponent(it.youtube)}" target="_blank" rel="noopener noreferrer">Trailer (YouTube)</a>` : '';
  return local + yt;
}
function bindTrailers(it) {
  $$('[data-trailer]').forEach(b => b.onclick = () => playTrailer(+b.dataset.trailer, it.title));
}
function playTrailer(id, title) {
  let v;
  const d = openDialog({ title: `${title} – trailer`, size: 'wide', className: 'trailer',
    body: `<video controls autoplay playsinline src="/api/trailers/${+id}/stream"></video>`,
    onClose: () => { v.onerror = null; stopVideo(v); } });
  v = d.$('video');
  v.onerror = () => toast('Trailern kan inte spelas i webbläsaren (filformatet stöds inte)', { error: true });
}

export async function refreshMeta(it) {
  toast('Uppdaterar…');
  try { await api(`/items/${it.id}/refresh`, { method: 'POST', body: {}, bg: true }); toast('Klart'); route(); }
  catch (e) { toastErr(e); }
}
export function matchItem(it) {
  const h = openDialog({ title: `Välj rätt ${it.kind === 'show' ? 'serie' : 'film'}`, size: 'wide',
    body: `<form id="mf" class="row" style="align-items:flex-end"><div style="flex:1;min-width:180px"><label for="mq">Sök</label><input id="mq" value="${esc(it.title)}"></div>
    <div><label for="my">År</label><input id="my" type="number" value="${it.year || ''}" style="width:100px"></div><button class="primary">Sök</button></form>
    <div id="mres" class="matchgrid" aria-live="polite">${loadingState({ kind: 'inline', label: 'Söker…' })}</div>
    <p class="muted small" id="mlock"></p>`,
    actions: [{ label: 'Lås upp (automatisk matchning)', id: 'munlock', onClick: async () => {
      await api(`/items/${it.id}/match`, { method: 'POST', body: { unlock: true }, bg: true }); toast('Upplåst – matchas automatiskt vid nästa skanning');
    } }, { label: 'Stäng' }] });
  const d = h.el, close = () => h.close();
  $('#munlock', d).hidden = true;
  const search = async () => {
    $('#mres', d).innerHTML = loadingState({ kind: 'inline', label: 'Söker…' });
    try {
      const r = await api(`/items/${it.id}/match?q=${encodeURIComponent($('#mq', d).value)}&year=${encodeURIComponent($('#my', d).value)}`, { bg: true });
      $('#mlock', d).textContent = r.locked ? 'Matchningen är låst och ändras inte vid omskanning.' : '';
      $('#munlock', d).hidden = !r.locked;
      $('#mres', d).innerHTML = r.results.map(x => `<button class="mcard${x.id === r.current ? ' on' : ''}" data-tid="${x.id}">
        ${x.poster ? `<img src="${esc(x.poster)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div><b>${esc(x.title)}</b> ${x.year ? `<span class="muted">(${x.year})</span>` : ''}${x.original && x.original !== x.title ? `<div class="muted small">${esc(x.original)}</div>` : ''}
        <div class="small muted">${esc(x.overview)}</div></div></button>`).join('') || emptyState({ compact: true, title: 'Inga träffar', text: 'Prova en annan stavning eller originaltiteln.' });
      $$('[data-tid]', d).forEach(b => b.onclick = async () => {
        b.disabled = true;
        try { await api(`/items/${it.id}/match`, { method: 'POST', body: { tmdbId: +b.dataset.tid }, bg: true }); toast('Matchat'); close(); route(); }
        catch (e) { toastErr(e); b.disabled = false; }
      });
    } catch (e) { if (d.isConnected) $('#mres', d).innerHTML = errorState(e, { compact: true }); }
  };
  $('#mf', d).onsubmit = (e) => { e.preventDefault(); search(); };
  search();
}
/** Dialogen "Redigera" (fält med lås, bilder, avancerat) – views/itemedit.js laddas först när den behövs (@lazy) */
export async function editItem(it, tab = 'general') {
  try { return await (await import('./itemedit.js')).openEditor(it, tab); } catch (e) { toastErr(e); }
}

// ---------- undertexter online ----------
async function subSearch(it) {
  let got = false;
  // Stängs dialogen: ladda bara om sidan om något faktiskt hämtades
  const h = openDialog({ title: 'Sök undertexter', body: `<p class="muted" id="ssm" aria-live="polite">Söker på OpenSubtitles…</p><div id="ssr" class="scrollbox"></div>`,
    onClose: (v) => { if (got && v !== 'route' && !P && !LP && !RP) route(); } });
  const d = h.el;
  try {
    const r = await api(`/items/${it.id}/subsearch`, { bg: true });
    if (!d.isConnected) return;
    $('#ssm', d).textContent = r.length ? `${r.length} träffar – ✓ = exakt matchning mot din fil` : 'Inga träffar.';
    $('#ssr', d).innerHTML = `<table>${r.slice(0, 40).map((x, i) => `<tr><td>${x.hashMatch ? '✓ ' : ''}<b>${esc(x.lang)}</b></td><td style="word-break:break-all">${esc(x.name)}${x.hi ? ' <span class="muted">(HI)</span>' : ''}</td>
      <td class="muted">${esc(x.downloads)}</td><td class="r"><button class="primary small" data-i="${i}">Hämta</button></td></tr>`).join('')}</table>`;
    $$('[data-i]', d).forEach(b => b.onclick = async () => {
      const x = r[+b.dataset.i]; b.disabled = true; b.textContent = '…';
      try { const res = await api(`/items/${it.id}/subdownload`, { method: 'POST', body: { fileId: x.fileId, lang: x.lang }, bg: true }); b.textContent = '✓ Hämtad'; got = true; toast(`Undertext sparad${res.remaining != null ? ` – ${res.remaining} nedladdningar kvar idag` : ''}`); }
      catch (e) { b.textContent = 'Fel'; toastErr(e); }
    });
  } catch (e) { if ($('#ssm', d)) $('#ssm', d).textContent = e.message; }
}

function editMarkers(it) {
  const t = (x) => x == null ? '' : fmtTime(x);
  const sec = (v) => { v = v.trim(); if (!v) return null; return v.split(':').reduce((a, x) => a * 60 + (+x || 0), 0); };
  openDialog({ title: 'Intro och eftertexter', form: true,
    body: `<p class="muted">Ange tider som mm:ss eller h:mm:ss. Lämna tomt för att ta bort.</p>
    <div class="row"><div style="flex:1"><label for="is">Intro start</label><input id="is" inputmode="numeric" value="${t(it.intro?.start)}"></div><div style="flex:1"><label for="ie">Intro slut</label><input id="ie" inputmode="numeric" value="${t(it.intro?.end)}"></div></div>
    <label for="cs">Eftertexter börjar</label><input id="cs" inputmode="numeric" value="${t(it.credits)}">`,
    actions: [{ label: 'Analysera säsongen igen', onClick: async () => { await api(`/items/${it.id}/markers/redetect`, { method: 'POST', bg: true }); toast('Analyserar i bakgrunden'); } },
      { label: 'Avbryt' },
      { label: 'Spara', kind: 'primary', submit: true, onClick: async ({ $: q }) => {
        await api(`/items/${it.id}/markers`, { method: 'PUT', body: { introStart: sec(q('#is').value), introEnd: sec(q('#ie').value), creditsStart: sec(q('#cs').value) }, bg: true });
        toast('Sparat'); route();
      } }] });
}
function bindFollow(it) {
  const b = $('#follow'), sel = $('#fsync'); if (!b) return;
  if (sel) sel.value = it.sync == null ? '' : String(it.sync);
  b.onclick = act(async () => {
    const r = await api(`/items/${it.id}/follow`, { method: 'POST', body: { follow: !it.following } });
    it.following = r.following; it.sync = r.sync;
    b.textContent = it.following ? '🔔 Följer' : '🔕 Följ';
    if (sel) sel.hidden = !it.following;
    toast(it.following ? `Du följer ${it.title} – nya avsnitt visas under Nytt för dig` : `Du följer inte längre ${it.title}`);
  });
  if (sel) sel.onchange = act(async () => { const r = await api(`/items/${it.id}/follow`, { method: 'POST', body: { follow: true, sync: sel.value } }); it.sync = r.sync; toast('Sparat'); });
}
